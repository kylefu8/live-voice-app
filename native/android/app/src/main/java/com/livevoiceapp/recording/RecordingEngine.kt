package com.livevoiceapp.recording

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.SystemClock
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * Best-effort, app-local recording service.
 *
 * The audio tap only calls [offer].  It copies a bounded packet into a
 * non-blocking queue and never waits for the encoder or filesystem.  A single
 * worker performs timestamp alignment, down-mixing/resampling and AAC
 * encoding.  Recording errors are kept in the recording status and do not
 * escape into the WebRTC audio path.
 */
object RecordingEngine {
  const val OUTPUT_SAMPLE_RATE = 24_000
  private const val OUTPUT_CHANNELS = 1
  private const val AAC_BIT_RATE = 64_000
  private const val PCM_FORMAT = 2 // AudioFormat.ENCODING_PCM_16BIT
  private const val MIN_FREE_BYTES = 64L * 1024L * 1024L
  private const val QUEUE_CAPACITY = 128
  private const val MAX_PACKET_BYTES = 256 * 1024
  private const val MAX_SOURCE_BUFFER_FRAMES = OUTPUT_SAMPLE_RATE * 10
  private const val FRAME_SAMPLES = 480 // 20ms at 24kHz
  private const val FRAME_NS = 20_000_000L
  private const val ALIGN_HOLD_FRAMES = 1_920L // 80ms of PCM at 24kHz.
  private const val IDLE_FINISH_WAIT_MS = 15_000L
  private const val ID_PATTERN = "[a-zA-Z0-9_-]{1,128}"

  private val idRegex = Regex(ID_PATTERN)
  private val engineLock = Any()

  @Volatile
  private var applicationContext: Context? = null

  @Volatile
  private var activeSession: Session? = null

  @Volatile
  private var lastErrorCode: String? = null

  @JvmStatic
  fun initialize(context: Context) {
    val app = context.applicationContext ?: context
    applicationContext = app
    recordingsDirectory(app).mkdirs()
    // A process death can leave a partial file.  It is deliberately safe to
    // remove only files carrying the temporary suffix; completed files are
    // never touched automatically.
    synchronized(engineLock) {
      if (activeSession != null) return
      recordingsDirectory(app).listFiles()?.forEach { file ->
        if (file.name.endsWith(".part")) {
          try {
            file.delete()
          } catch (_: Throwable) {
            // Best effort cleanup only.
          }
        }
      }
    }
  }

  @JvmStatic
  fun isCapturing(): Boolean = activeSession?.isCapturing() == true

  @JvmStatic
  fun startSession(id: String, mode: String, startedAt: Long): Unit {
    val context = applicationContext ?: throw RecordingFailure("recording_not_initialized")
    validateId(id)
    val safeMode = when (mode) {
      "general", "practice" -> mode
      else -> throw RecordingFailure("recording_invalid_mode")
    }
    if (startedAt < 0L) throw RecordingFailure("recording_invalid_started_at")
    synchronized(engineLock) {
      val current = activeSession
      if (current != null) {
        throw RecordingFailure("recording_active")
      }
      lastErrorCode = null
      val directory = recordingsDirectory(context)
      directory.mkdirs()
      val m4a = File(directory, "$id.m4a")
      val metadata = File(directory, "$id.json")
      val partial = File(directory, "$id.m4a.part")
      if (m4a.exists() || metadata.exists()) {
        throw RecordingFailure("recording_id_exists")
      }
      try {
        partial.delete()
      } catch (_: Throwable) {
        throw RecordingFailure("recording_storage_failed")
      }
      activeSession = Session(id, safeMode, startedAt, m4a, metadata, partial)
    }
  }

  @JvmStatic
  fun finishSession(id: String, confirmedClose: Boolean): RecordingInfo? {
    validateId(id)
    var unconnected = false
    val session = synchronized(engineLock) {
      val current = activeSession
      if (current == null || current.id != id) return@synchronized null
      if (!current.connected) {
        activeSession = null
        unconnected = true
      }
      current
    } ?: return readInfo(id)

    if (unconnected) {
      session.discard()
      return null
    }

    val info = session.finish(confirmedClose)
    if (info == null || session.errorCode != null) {
      lastErrorCode = session.errorCode ?: "recording_no_audio"
    }
    synchronized(engineLock) {
      if (activeSession === session) activeSession = null
    }
    return info
  }

  @JvmStatic
  fun finishCurrentBestEffort(confirmedClose: Boolean = false): RecordingInfo? {
    val session = activeSession ?: return null
    return try {
      finishSession(session.id, confirmedClose)
    } catch (_: Throwable) {
      null
    }
  }

  @JvmStatic
  fun markSessionConnected(id: String) {
    validateId(id)
    val session = activeSession ?: return
    if (session.id == id) session.connected = true
  }

  @JvmStatic
  fun discardSession(id: String) {
    validateId(id)
    val session = synchronized(engineLock) {
      val current = activeSession
      if (current == null || current.id != id) return@synchronized null
      activeSession = null
      current
    }
    session?.discard()
  }

  @JvmStatic
  fun setSessionMuted(id: String, muted: Boolean) {
    validateId(id)
    val session = activeSession ?: return
    if (session.id == id) session.mutedMic = muted
  }

  @JvmStatic
  fun offer(
      source: Int,
      data: ByteArray,
      rate: Int,
      channels: Int,
      format: Int,
      timestampNs: Long,
  ): Boolean {
    val session = activeSession ?: return false
    if (!session.isCapturing()) return false
    if (source != 0 && source != 1) return false
    if (format != PCM_FORMAT || rate !in 8_000..96_000 || channels !in 1..8) {
      session.noteError("recording_invalid_audio")
      return false
    }
    if (data.isEmpty() || data.size > MAX_PACKET_BYTES) {
      session.noteError("recording_invalid_audio")
      return false
    }
    val bytesPerFrame = channels * 2
    val frames = data.size / bytesPerFrame
    if (frames <= 0) return false
    if (session.queue.remainingCapacity() <= 0) {
      session.noteError("recording_queue_full")
      return false
    }
    val safeTimestamp = if (timestampNs > 0L) timestampNs else SystemClock.elapsedRealtimeNanos()
    // A muted local microphone still contributes its timing range, but its
    // samples are never copied or encoded.
    val silentMic = source == 0 && session.mutedMic
    val packet = try {
      AudioPacket(
          source = source,
          data = if (silentMic) null else data.copyOf(),
          rate = rate,
          channels = channels,
          frames = frames,
          timestampNs = safeTimestamp,
          silent = silentMic,
      )
    } catch (_: Throwable) {
      session.noteError("recording_memory_limit")
      return false
    }
    if (!session.queue.offer(Event.Packet(packet))) {
      session.noteError("recording_queue_full")
      return false
    }
    return true
  }

  @JvmStatic
  fun statusSnapshot(): RecordingStatus {
    val session = activeSession ?: return lastErrorCode?.let { code ->
      RecordingStatus(null, "error", code)
    } ?: RecordingStatus(null, "idle", null)
    return RecordingStatus(session.id, session.publicState(), session.errorCode)
  }

  @JvmStatic
  fun list(offset: Int, limit: Int): RecordingList {
    val context = applicationContext ?: throw RecordingFailure("recording_not_initialized")
    val safeOffset = max(0, offset)
    val safeLimit = limit.coerceIn(1, 100)
    val all = readAllInfo(context)
    val start = safeOffset.coerceAtMost(all.size)
    val end = min(all.size, start + safeLimit)
    val items = if (start >= all.size) emptyList() else all.subList(start, end)
    return RecordingList(items.toList(), end < all.size)
  }

  @JvmStatic
  fun get(id: String): RecordingInfo? {
    validateId(id)
    return readInfo(id)
  }

  @JvmStatic
  fun delete(id: String) {
    validateId(id)
    synchronized(engineLock) {
      if (activeSession?.id == id) throw RecordingFailure("recording_active")
    }
    val context = applicationContext ?: throw RecordingFailure("recording_not_initialized")
    val directory = recordingsDirectory(context)
    val m4a = File(directory, "$id.m4a")
    val metadata = File(directory, "$id.json")
    if (!m4a.exists() && !metadata.exists()) return
    try {
      if (m4a.exists() && !m4a.delete()) throw RecordingFailure("recording_delete_failed")
      if (metadata.exists() && !metadata.delete()) throw RecordingFailure("recording_delete_failed")
    } catch (failure: RecordingFailure) {
      throw failure
    } catch (_: Throwable) {
      throw RecordingFailure("recording_delete_failed")
    }
  }

  /** Internal-only file lookup used by the native player.  It never crosses RN. */
  internal fun playbackFile(id: String): File? {
    validateId(id)
    val context = applicationContext ?: throw RecordingFailure("recording_not_initialized")
    val file = File(recordingsDirectory(context), "$id.m4a")
    return if (file.isFile && readInfo(id) != null) file else null
  }

  private fun recordingsDirectory(context: Context): File = File(context.filesDir, "recordings")

  private fun validateId(id: String) {
    if (!idRegex.matches(id)) throw RecordingFailure("recording_invalid_id")
  }

  private fun readAllInfo(context: Context): List<RecordingInfo> {
    val directory = recordingsDirectory(context)
    if (!directory.isDirectory) return emptyList()
    val items = ArrayList<RecordingInfo>()
    directory.listFiles()?.forEach { file ->
      if (!file.name.endsWith(".json") || file.name.length <= 5) return@forEach
      val id = file.name.removeSuffix(".json")
      if (!idRegex.matches(id)) return@forEach
      parseInfo(file)?.let { info ->
        val audio = File(directory, "$id.m4a")
        if (info.id == id && audio.isFile && audio.length() > 0L) items.add(info)
      }
    }
    items.sortWith(compareByDescending<RecordingInfo> { it.startedAt }.thenByDescending { it.id })
    return items
  }

  private fun readInfo(id: String): RecordingInfo? {
    val context = applicationContext ?: throw RecordingFailure("recording_not_initialized")
    val directory = recordingsDirectory(context)
    val audio = File(directory, "$id.m4a")
    if (!audio.isFile || audio.length() <= 0L) return null
    return parseInfo(File(directory, "$id.json"))
  }

  private fun parseInfo(file: File): RecordingInfo? {
    if (!file.isFile || file.length() > 16 * 1024) return null
    return try {
      val text = FileInputStream(file).use { input -> input.readBytes().toString(Charsets.UTF_8) }
      val json = org.json.JSONObject(text)
      val id = json.optString("id", "")
      if (!idRegex.matches(id)) return null
      val mode = json.optString("mode", "")
      if (mode != "general" && mode != "practice") return null
      val startedAt = json.optLong("startedAt", -1L)
      val durationMs = json.optLong("durationMs", -1L)
      val sizeBytes = json.optLong("sizeBytes", -1L)
      if (startedAt < 0L || durationMs < 0L || sizeBytes < 0L) return null
      val confirmed = json.optBoolean("confirmedClose", false)
      val error = if (json.has("errorCode")) json.optString("errorCode", "").takeIf { it.isNotEmpty() } else null
      RecordingInfo(id, mode, startedAt, durationMs, sizeBytes, confirmed, error)
    } catch (_: Throwable) {
      null
    }
  }

  data class RecordingInfo(
      val id: String,
      val mode: String,
      val startedAt: Long,
      val durationMs: Long,
      val sizeBytes: Long,
      val confirmedClose: Boolean,
      val errorCode: String? = null,
  )

  data class RecordingList(val items: List<RecordingInfo>, val hasMore: Boolean)

  data class RecordingStatus(val id: String?, val state: String, val code: String?)

  class RecordingFailure(val code: String) : RuntimeException()

  private data class AudioPacket(
      val source: Int,
      val data: ByteArray?,
      val rate: Int,
      val channels: Int,
      val frames: Int,
      val timestampNs: Long,
      val silent: Boolean,
  )

  private sealed class Event {
    data class Packet(val value: AudioPacket) : Event()
    data class Finish(val confirmedClose: Boolean) : Event()
  }

  private class Session(
      val id: String,
      val mode: String,
      val startedAt: Long,
      private val m4aFile: File,
      private val metadataFile: File,
      private val partialFile: File,
  ) {
    val queue = ArrayBlockingQueue<Event>(QUEUE_CAPACITY)
    @Volatile var mutedMic: Boolean = false
    @Volatile var connected: Boolean = false
    @Volatile private var accepting = true
    @Volatile private var state = "recording"
    @Volatile var errorCode: String? = null
      private set
    private val finishRequested = AtomicBoolean(false)
    private val discarded = AtomicBoolean(false)
    private val completed = CountDownLatch(1)
    private val worker = Thread(::run, "live-voice-recording-$id")
    @Volatile private var result: RecordingInfo? = null

    init {
      worker.isDaemon = true
      worker.start()
    }

    fun isCapturing(): Boolean = accepting && !discarded.get()

    fun publicState(): String = when {
      state == "error" -> "error"
      state == "saving" -> "saving"
      isCapturing() -> "recording"
      else -> "idle"
    }

    fun noteError(code: String) {
      if (errorCode == null) errorCode = code
      state = "error"
      if (code == "recording_storage_full" || code == "recording_write_failed" || code == "recording_encoder_failed") {
        accepting = false
      }
    }

    fun finish(confirmedClose: Boolean): RecordingInfo? {
      if (discarded.get()) return null
      if (finishRequested.compareAndSet(false, true)) {
        accepting = false
        state = if (errorCode == null) "saving" else "error"
        // This is off the audio callback path; waiting for the worker to
        // drain a bounded queue is safe and makes finish idempotent.
        val queued = try {
          queue.offer(Event.Finish(confirmedClose), 5L, TimeUnit.SECONDS)
        } catch (_: InterruptedException) {
          Thread.currentThread().interrupt()
          false
        }
        if (!queued) {
          noteError("recording_finish_timeout")
          worker.interrupt()
        }
      }
      if (!completed.await(IDLE_FINISH_WAIT_MS, TimeUnit.MILLISECONDS)) {
        noteError("recording_finish_timeout")
        worker.interrupt()
        completed.await(2L, TimeUnit.SECONDS)
      }
      return result
    }

    fun discard() {
      if (!discarded.compareAndSet(false, true)) return
      accepting = false
      state = "idle"
      queue.clear()
      worker.interrupt()
      try {
        worker.join(2_000L)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
      try {
        partialFile.delete()
        File(partialFile.parentFile, "$id.json.part").delete()
      } catch (_: Throwable) {
        // Discard is best effort; a .part file is safe for initialize cleanup.
      }
    }

    private fun run() {
      var encoder: AacEncoder? = null
      val timelines = arrayOf(
          RecordingTimeline(MAX_SOURCE_BUFFER_FRAMES, OUTPUT_SAMPLE_RATE / 4L),
          RecordingTimeline(MAX_SOURCE_BUFFER_FRAMES, OUTPUT_SAMPLE_RATE / 4L),
      )
      var firstTimestampNs = Long.MAX_VALUE
      var latestEndFrame = 0L
      var nextFrame = 0L
      var renderedFrames = 0L
      try {
        while (true) {
          val event = queue.take()
          if (event is Event.Packet) {
            val packet = event.value
            if (firstTimestampNs == Long.MAX_VALUE) {
              firstTimestampNs = packet.timestampNs
            }
            val samples = if (packet.silent || packet.data == null) {
              FloatArray(max(1, ceil(packet.frames.toDouble() * OUTPUT_SAMPLE_RATE / packet.rate).toInt()))
            } else resample(packet.data, packet.rate, packet.channels)
            val observedStart = relativeFrames(packet.timestampNs, firstTimestampNs)
            val packetEnd = timelines[packet.source].append(observedStart, samples)
            latestEndFrame = max(latestEndFrame, packetEnd)
            if (encoder == null) {
              try {
                ensureStorage()
                encoder = AacEncoder(partialFile)
                encoder.start()
              } catch (failure: RecordingFailure) {
                noteError(failure.code)
                continue
              } catch (_: Throwable) {
                noteError("recording_encoder_failed")
                continue
              }
            }
            // Output can pre-buffer ahead of the microphone. Do not encode
            // future microphone silence just because playback arrived in a burst.
            val wallFrame = relativeFrames(SystemClock.elapsedRealtimeNanos(), firstTimestampNs)
            val holdEnd = min(latestEndFrame, wallFrame) - ALIGN_HOLD_FRAMES
            if (holdEnd > nextFrame) {
              val rendered = renderUntil(
                  encoder,
                  timelines,
                  nextFrame,
                  holdEnd,
                  force = false,
              )
              renderedFrames += rendered
              nextFrame += rendered * FRAME_SAMPLES
              timelines.forEach { it.trimBefore(nextFrame) }
            }
          } else if (event is Event.Finish) {
            if (encoder == null && firstTimestampNs != Long.MAX_VALUE) {
              try {
                ensureStorage()
                encoder = AacEncoder(partialFile)
                encoder.start()
              } catch (failure: RecordingFailure) {
                noteError(failure.code)
              } catch (_: Throwable) {
                noteError("recording_encoder_failed")
              }
            }
            if (encoder != null && latestEndFrame > nextFrame) {
              val rendered = renderUntil(
                  encoder,
                  timelines,
                  nextFrame,
                  latestEndFrame,
                  force = true,
              )
              renderedFrames += rendered
              nextFrame += rendered * FRAME_SAMPLES
            }
            val encodedDurationMs = renderedFrames * FRAME_NS / 1_000_000L
            try {
              encoder?.finish()
            } catch (_: Throwable) {
              noteError("recording_encoder_failed")
            } finally {
              encoder?.release()
              encoder = null
            }
            val finalFile = finalizePart()
            if (finalFile == null) {
              noteError("recording_no_audio")
              result = null
              completed.countDown()
              return
            }
            val info = RecordingInfo(
                id = id,
                mode = mode,
                startedAt = startedAt,
                durationMs = encodedDurationMs,
                sizeBytes = finalFile?.length() ?: 0L,
                confirmedClose = event.confirmedClose,
                errorCode = errorCode,
            )
            if (!writeMetadata(info)) {
              result = null
              completed.countDown()
              return
            }
            result = info
            completed.countDown()
            return
          }
        }
      } catch (_: InterruptedException) {
        if (!discarded.get()) {
          noteError("recording_interrupted")
          try {
            encoder?.finish()
          } catch (_: Throwable) {
            noteError("recording_encoder_failed")
          } finally {
            encoder?.release()
          }
        }
      } catch (_: Throwable) {
        noteError("recording_write_failed")
      } finally {
        try {
          encoder?.release()
        } catch (_: Throwable) {
          // Release is best effort and must not prevent the latch from opening.
        }
        completed.countDown()
      }
    }

    private fun ensureStorage() {
      if (partialFile.parentFile?.usableSpace ?: 0L < MIN_FREE_BYTES) {
        noteError("recording_storage_full")
        throw RecordingFailure("recording_storage_full")
      }
      partialFile.parentFile?.mkdirs()
    }

    private fun renderUntil(
        encoder: AacEncoder,
        timelines: Array<RecordingTimeline>,
        fromFrame: Long,
        untilFrame: Long,
        force: Boolean,
    ): Long {
      var frameStart = fromFrame
      var frames = 0L
      while (frameStart < untilFrame) {
        if (!force && frameStart + FRAME_SAMPLES > untilFrame) break
        if (partialFile.parentFile?.usableSpace ?: 0L < MIN_FREE_BYTES) {
          noteError("recording_storage_full")
          break
        }
        val block = ShortArray(FRAME_SAMPLES)
        for (index in block.indices) {
          val sampleFrame = frameStart + index
          val mic = timelines[0].sampleAt(sampleFrame)
          val assistant = timelines[1].sampleAt(sampleFrame)
          // Both sides can talk at once. Reserve headroom instead of clipping
          // the summed signals during interruptions or residual speaker echo.
          val mixed = (mic + assistant) * 0.5f
          block[index] = (mixed * 32767f).toInt().coerceIn(-32768, 32767).toShort()
        }
        // Every block is encoded, including silence. This preserves the
        // conversation timeline and makes muted microphone ranges seekable.
        try {
          encoder.encode(block)
        } catch (_: Throwable) {
          noteError("recording_encoder_failed")
          accepting = false
          break
        }
        frames += 1L
        frameStart += FRAME_SAMPLES
      }
      return frames
    }

    private fun finalizePart(): File? {
      if (!partialFile.exists()) return null
      if (!isValidAac(partialFile)) {
        noteError("recording_encoder_failed")
        return null
      }
      val finalFile = m4aFile
      if (finalFile.exists()) {
        noteError("recording_id_exists")
        return null
      }
      if (!partialFile.renameTo(finalFile)) {
        noteError("recording_write_failed")
        return null
      }
      if (!finalFile.isFile || finalFile.length() <= 0L) {
        try {
          finalFile.delete()
        } catch (_: Throwable) {
        }
        noteError("recording_no_audio")
        return null
      }
      return finalFile
    }

    private fun isValidAac(file: File): Boolean {
      val extractor = MediaExtractor()
      return try {
        extractor.setDataSource(file.absolutePath)
        (0 until extractor.trackCount).any { index ->
          val format = extractor.getTrackFormat(index)
          format.getString(MediaFormat.KEY_MIME) == "audio/mp4a-latm" &&
              (!format.containsKey(MediaFormat.KEY_DURATION) ||
                  format.getLong(MediaFormat.KEY_DURATION) > 0L)
        }
      } catch (_: Throwable) {
        false
      } finally {
        try {
          extractor.release()
        } catch (_: Throwable) {
        }
      }
    }

    private fun writeMetadata(info: RecordingInfo): Boolean {
      val temporary = File(metadataFile.parentFile, "$id.json.part")
      try {
        val json = org.json.JSONObject()
            .put("id", info.id)
            .put("mode", info.mode)
            .put("startedAt", info.startedAt)
            .put("durationMs", info.durationMs)
            .put("sizeBytes", info.sizeBytes)
            .put("confirmedClose", info.confirmedClose)
        info.errorCode?.let { json.put("errorCode", it) }
        FileOutputStream(temporary).use { output ->
          output.write(json.toString().toByteArray(Charsets.UTF_8))
          output.flush()
          output.fd.sync()
        }
        if (metadataFile.exists()) metadataFile.delete()
        if (!temporary.renameTo(metadataFile)) throw IllegalStateException("metadata_rename")
        return true
      } catch (_: Throwable) {
        noteError("recording_storage_failed")
        try {
          temporary.delete()
        } catch (_: Throwable) {
          // The .part file remains safe for the next initialize cleanup.
        }
        return false
      }
    }
  }

  private fun relativeFrames(timestampNs: Long, originNs: Long): Long =
      Math.round((timestampNs - originNs).toDouble() * OUTPUT_SAMPLE_RATE / 1_000_000_000.0)

  private fun resample(data: ByteArray, rate: Int, channels: Int): FloatArray {
    val inputFrames = data.size / (channels * 2)
    if (inputFrames <= 0) return FloatArray(0)
    val outputFrames = max(1, ceil(inputFrames.toDouble() * OUTPUT_SAMPLE_RATE / rate.toDouble()).toInt())
    val mono = FloatArray(inputFrames)
    val bytes = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
    for (frame in 0 until inputFrames) {
      var sum = 0f
      for (channel in 0 until channels) sum += bytes.getShort().toInt() / 32768f
      mono[frame] = (sum / channels).coerceIn(-1f, 1f)
    }
    if (rate == OUTPUT_SAMPLE_RATE) return mono
    val result = FloatArray(outputFrames)
    for (index in result.indices) {
      val source = index.toDouble() * rate.toDouble() / OUTPUT_SAMPLE_RATE.toDouble()
      val before = source.toInt().coerceIn(0, inputFrames - 1)
      val after = min(before + 1, inputFrames - 1)
      val fraction = (source - before).toFloat().coerceIn(0f, 1f)
      result[index] = mono[before] + (mono[after] - mono[before]) * fraction
    }
    return result
  }

  private class AacEncoder(private val output: File) {
    private var codec: MediaCodec? = null
    private var muxer: MediaMuxer? = null
    private var track = -1
    private var muxerStarted = false
    private var presentationUs = 0L
    private var started = false
    private val info = MediaCodec.BufferInfo()

    fun start() {
      val format = MediaFormat.createAudioFormat("audio/mp4a-latm", OUTPUT_SAMPLE_RATE, OUTPUT_CHANNELS)
      format.setInteger(MediaFormat.KEY_AAC_PROFILE, 2) // AACObjectLC
      format.setInteger(MediaFormat.KEY_BIT_RATE, AAC_BIT_RATE)
      format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, FRAME_SAMPLES * 2)
      codec = MediaCodec.createEncoderByType("audio/mp4a-latm")
      codec!!.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      codec!!.start()
      muxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      started = true
    }

    fun encode(samples: ShortArray) {
      if (!started) return
      val bytes = ByteArray(samples.size * 2)
      val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
      samples.forEach { buffer.putShort(it) }
      var offset = 0
      val deadline = SystemClock.elapsedRealtime() + 2_000L
      while (offset < bytes.size) {
        if (SystemClock.elapsedRealtime() >= deadline) throw IllegalStateException("aac_input_timeout")
        val inputIndex = codec?.dequeueInputBuffer(10_000L) ?: -1
        if (inputIndex < 0) {
          drain(false)
          continue
        }
        val input = codec?.getInputBuffer(inputIndex) ?: throw IllegalStateException("aac_input")
        input.clear()
        val count = min(input.remaining(), bytes.size - offset)
        input.put(bytes, offset, count)
        codec?.queueInputBuffer(inputIndex, 0, count, presentationUs, 0)
        presentationUs += count.toLong() * 1_000_000L / (OUTPUT_SAMPLE_RATE * 2L)
        offset += count
        drain(false)
      }
    }

    fun finish() {
      if (!started) return
      val deadline = SystemClock.elapsedRealtime() + 3_000L
      var eosQueued = false
      var done = false
      while (!done && SystemClock.elapsedRealtime() < deadline) {
        if (!eosQueued) {
          val remainingMs = (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1L)
          val index = codec?.dequeueInputBuffer(min(10_000L, remainingMs) * 1_000L) ?: -1
          if (index >= 0) {
            codec?.queueInputBuffer(index, 0, 0, presentationUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            eosQueued = true
          }
        }
        done = drain(eosQueued)
      }
      if (!done) throw IllegalStateException("aac_eos_timeout")
    }

    private fun drain(endOfStream: Boolean): Boolean {
      var ended = false
      while (true) {
        val outputIndex = codec?.dequeueOutputBuffer(info, if (endOfStream) 10_000L else 0L) ?: -1
        when {
          outputIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> return ended
          outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            if (muxerStarted) throw IllegalStateException("aac_format_changed")
            track = muxer!!.addTrack(codec!!.outputFormat)
            muxer!!.start()
            muxerStarted = true
          }
          outputIndex == MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED -> {
            // The byte-buffer API remains valid on API 24+; this notification
            // is retained for older codec implementations.
          }
          outputIndex >= 0 -> {
            val output = codec!!.getOutputBuffer(outputIndex)
            if (output != null && info.size > 0 && muxerStarted && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
              output.position(info.offset)
              output.limit(info.offset + info.size)
              muxer!!.writeSampleData(track, output, info)
            }
            if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) ended = true
            codec!!.releaseOutputBuffer(outputIndex, false)
            if (ended) return true
          }
          else -> return ended
        }
      }
    }

    fun release() {
      try {
        if (muxerStarted) muxer?.stop()
      } catch (_: Throwable) {
        // Partial output is still handled by the caller as a recording error.
      }
      try {
        muxer?.release()
      } catch (_: Throwable) {
      }
      try {
        codec?.stop()
      } catch (_: Throwable) {
      }
      try {
        codec?.release()
      } catch (_: Throwable) {
      }
      muxer = null
      codec = null
      started = false
    }
  }
}
