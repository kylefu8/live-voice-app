package com.livevoiceapp

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.livevoiceapp.recording.RecordingEngine
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import kotlin.math.cos
import kotlin.math.PI
import kotlin.math.sin
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Device-side codec/storage smoke test. It uses synthetic PCM only; no
 * microphone, provider, account, endpoint, or user recording is involved.
 */
@RunWith(AndroidJUnit4::class)
class RecordingInstrumentationTest {
  @Test
  fun callbackJitterAndBurstsPreserveDecodedAudioAtDifferentInputRates() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    RecordingEngine.initialize(context)
    val id = "test_jitter_${UUID.randomUUID().toString().replace("-", "")}"
    try {
      RecordingEngine.startSession(id, "general", System.currentTimeMillis())
      RecordingEngine.markSessionConnected(id)
      repeat(80) { packet ->
        // Delivery time is deliberately different from the PCM sample clock.
        val deliveryMs = if (packet == 0) 0L else (packet / 4 * 40 + 30 + packet % 3).toLong()
        val timestamp = 1_000_000_000L + deliveryMs * 1_000_000L
        val mono = ByteBuffer.wrap(pcm(480, 48_000, 440.0, packet)).order(ByteOrder.LITTLE_ENDIAN)
        val stereo = ByteBuffer.allocate(480 * 4).order(ByteOrder.LITTLE_ENDIAN)
        repeat(480) { val sample = mono.short; stereo.putShort(sample); stereo.putShort(sample) }
        assertTrue(RecordingEngine.offer(0, stereo.array(), 48_000, 2, 2, timestamp))
        assertTrue(RecordingEngine.offer(1, pcm(240, 24_000, 660.0, packet), 24_000, 1, 2, timestamp))
        Thread.sleep(5)
      }
      val info = RecordingEngine.finishSession(id, true)
      assertNotNull(info)
      assertTrue("Unexpected PCM duration: ${info!!.durationMs}", info.durationMs in 780L..840L)
      val extractor = MediaExtractor()
      try {
        extractor.setDataSource(java.io.File(context.filesDir, "recordings/$id.m4a").absolutePath)
        extractor.selectTrack(0)
        val decoded = decode(extractor, extractor.getTrackFormat(0))
        // Skip AAC priming and fit the middle 500ms to the two source tones.
        // Jitter-induced missing/repeated PCM produces a large residual even
        // when a simple "both frequencies exist" test would still pass.
        val middle = decoded.copyOfRange(4_800, 16_800)
        val residual = twoToneResidual(middle, 24_000, 440.0, 660.0)
        println("SYNTHETIC_JITTER relativeResidual=$residual durationMs=${info.durationMs}")
        assertTrue("Callback jitter distorted recorded audio: relative residual=$residual", residual < 0.10)
        assertEquals(800L, info.durationMs)
      } finally { extractor.release() }
    } finally {
      RecordingEngine.discardSession(id)
      RecordingEngine.delete(id)
    }
  }

  @Test
  fun createsSyntheticPlaybackFixtureOnlyWhenRequested() {
    org.junit.Assume.assumeTrue(
        InstrumentationRegistry.getArguments().getString("keepRecordingFixture") == "true",
    )
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    RecordingEngine.initialize(context)
    val id = "ui_test_${UUID.randomUUID().toString().replace("-", "")}"
    var completed = false
    try {
      RecordingEngine.startSession(id, "general", System.currentTimeMillis())
      RecordingEngine.markSessionConnected(id)
      repeat(400) { packet ->
        val timestamp = 1_000_000_000L + packet * 20_000_000L
        assertTrue(RecordingEngine.offer(0, pcm(480, 24_000, 440.0, packet), 24_000, 1, 2, timestamp))
        assertTrue(RecordingEngine.offer(1, pcm(480, 24_000, 660.0, packet), 24_000, 1, 2, timestamp))
        Thread.sleep(5)
      }
      val info = RecordingEngine.finishSession(id, true)
      assertNotNull(info)
      assertTrue(info!!.durationMs in 7_980L..8_080L)
      println("UI_FIXTURE_ID=$id")
      completed = true
    } finally {
      if (!completed) {
        RecordingEngine.discardSession(id)
        RecordingEngine.delete(id)
      }
    }
  }

  @Test
  fun mixesTwoSyntheticSourcesAndPersistsLocalCatalog() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    RecordingEngine.initialize(context)
    val id = "test_${UUID.randomUUID().toString().replace("-", "")}".take(64)
    val startedAt = System.currentTimeMillis()
    val directory = java.io.File(context.filesDir, "recordings")
    try {
      RecordingEngine.startSession(id, "practice", startedAt)
      RecordingEngine.markSessionConnected(id)
      assertTrue(RecordingEngine.isCapturing())
      val sampleRate = 24_000
      val packetFrames = 480
      repeat(24) { packet ->
        val timestamp = 1_000_000_000L + packet * packetFrames.toLong() * 1_000_000_000L / sampleRate
        assertTrue(RecordingEngine.offer(0, pcm(packetFrames, sampleRate, 440.0, packet), sampleRate, 1, 2, timestamp))
        assertTrue(RecordingEngine.offer(1, pcm(packetFrames, sampleRate, 660.0, packet), sampleRate, 1, 2, timestamp))
      }
      // Invalid stream data is rejected without throwing into the caller.
      assertFalse(RecordingEngine.offer(0, ByteArray(4), sampleRate, 1, 3, 1_000_000_000L))
      RecordingEngine.setSessionMuted(id, true)
      assertTrue(RecordingEngine.offer(0, pcm(packetFrames, sampleRate, 880.0, 30), sampleRate, 1, 2, 2_000_000_000L))
      RecordingEngine.setSessionMuted(id, false)

      val info = RecordingEngine.finishSession(id, true)
      assertNotNull(info)
      assertEquals(id, info!!.id)
      assertEquals("practice", info.mode)
      // 24 packets (480ms) followed by a muted mic packet at 2.000s: the
      // retained timeline should be about 1.020s, including the silent range.
      assertTrue(info.durationMs in 980L..1_080L)
      assertTrue(info.sizeBytes > 0)
      assertTrue(info.confirmedClose)

      val file = java.io.File(directory, "$id.m4a")
      assertTrue(file.isFile)
      val extractor = MediaExtractor()
      try {
        extractor.setDataSource(file.absolutePath)
        assertTrue(extractor.trackCount > 0)
        var audioTrack = -1
        for (index in 0 until extractor.trackCount) {
          val format = extractor.getTrackFormat(index)
          if (format.getString(MediaFormat.KEY_MIME)?.startsWith("audio/mp4a-latm") == true) {
            audioTrack = index
            assertEquals(sampleRate, format.getInteger(MediaFormat.KEY_SAMPLE_RATE))
            break
          }
        }
        assertTrue(audioTrack >= 0)
        extractor.selectTrack(audioTrack)
        val durationUs = extractor.getTrackFormat(audioTrack).getLong(MediaFormat.KEY_DURATION)
        // AAC encoders can add priming/tail frames (this device adds 128ms).
        // The PCM timeline must remain 1.020s; allow up to four AAC frames in the container.
        val paddingAllowanceUs = 4L * 1024L * 1_000_000L / sampleRate
        assertTrue("AAC durationUs=$durationUs expected timeline=1020000", durationUs in 1_000_000L..(1_020_000L + paddingAllowanceUs))
        val decoded = decode(extractor, extractor.getTrackFormat(audioTrack))
        println("SYNTHETIC_AAC durationUs=$durationUs decodedSamples=${decoded.size} pcmTimelineMs=${info.durationMs}")
        assertTrue(decoded.size > sampleRate / 2)
        val firstHalf = decoded.copyOfRange(0, minOf(decoded.size, sampleRate / 2))
        val energy440 = energyAt(firstHalf, sampleRate, 440.0)
        val energy660 = energyAt(firstHalf, sampleRate, 660.0)
        val energy880 = energyAt(firstHalf, sampleRate, 880.0)
        assertTrue("440Hz source missing", energy440 > energy880 * 3.0)
        assertTrue("660Hz source missing", energy660 > energy880 * 3.0)
        assertTrue("muted 880Hz mic leaked", energy880 < minOf(energy440, energy660) / 3.0)
        val quietTail = decoded.copyOfRange(minOf(decoded.size, sampleRate * 8 / 10), decoded.size)
        val tailRms = kotlin.math.sqrt(quietTail.map { val v = it.toDouble() / 32768.0; v * v }.average())
        assertTrue("Muted interval must remain silent after AAC decoding: rms=$tailRms", tailRms < 0.003)
      } finally {
        extractor.release()
      }

      val listed = RecordingEngine.list(0, 10)
      assertTrue(listed.items.any { it.id == id })
      assertNotNull(RecordingEngine.get(id))
      RecordingEngine.delete(id)
      assertTrue(RecordingEngine.get(id) == null)
      assertFalse(file.exists())
    } finally {
      // The test id is unique and cleanup is restricted to that id.
      try {
        RecordingEngine.discardSession(id)
      } catch (_: Throwable) {
      }
      java.io.File(directory, "$id.m4a").delete()
      java.io.File(directory, "$id.json").delete()
      java.io.File(directory, "$id.m4a.part").delete()
      java.io.File(directory, "$id.json.part").delete()
    }
  }

  @Test
  fun unconnectedSessionWithAudioIsDiscardedWithoutCatalogEntry() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    RecordingEngine.initialize(context)
    val id = "test_${UUID.randomUUID().toString().replace("-", "")}".take(64)
    val directory = java.io.File(context.filesDir, "recordings")
    try {
      RecordingEngine.startSession(id, "general", System.currentTimeMillis())
      assertTrue(RecordingEngine.offer(0, pcm(480, 24_000, 440.0, 0), 24_000, 1, 2, 1_000_000_000L))
      assertTrue(RecordingEngine.isCapturing())
      assertTrue(RecordingEngine.finishSession(id, false) == null)
      assertTrue(RecordingEngine.get(id) == null)
      assertFalse(java.io.File(directory, "$id.m4a").exists())
      assertFalse(java.io.File(directory, "$id.json").exists())
    } finally {
      try {
        RecordingEngine.discardSession(id)
      } catch (_: Throwable) {
      }
      java.io.File(directory, "$id.m4a").delete()
      java.io.File(directory, "$id.json").delete()
      java.io.File(directory, "$id.m4a.part").delete()
      java.io.File(directory, "$id.json.part").delete()
    }
  }

  private fun pcm(frames: Int, rate: Int, frequency: Double, packet: Int): ByteArray {
    val result = ByteArray(frames * 2)
    val buffer = ByteBuffer.wrap(result).order(ByteOrder.LITTLE_ENDIAN)
    for (index in 0 until frames) {
      val sampleIndex = packet * frames + index
      val value = (sin(2.0 * PI * frequency * sampleIndex / rate) * 0.24 * 32767.0)
          .toInt()
          .coerceIn(-32768, 32767)
      buffer.putShort(value.toShort())
    }
    return result
  }

  private fun decode(extractor: MediaExtractor, format: MediaFormat): ShortArray {
    val mime = format.getString(MediaFormat.KEY_MIME) ?: error("missing mime")
    val decoder = MediaCodec.createDecoderByType(mime)
    val info = MediaCodec.BufferInfo()
    val output = ByteArrayOutputStream()
    var inputDone = false
    var outputDone = false
    try {
      decoder.configure(format, null, null, 0)
      decoder.start()
      val deadline = System.currentTimeMillis() + 5_000L
      while (!outputDone && System.currentTimeMillis() < deadline) {
        if (!inputDone) {
          val inputIndex = decoder.dequeueInputBuffer(10_000L)
          if (inputIndex >= 0) {
            val input = decoder.getInputBuffer(inputIndex) ?: error("missing decoder input")
            input.clear()
            val size = extractor.readSampleData(input, 0)
            if (size < 0) {
              decoder.queueInputBuffer(inputIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              decoder.queueInputBuffer(inputIndex, 0, size, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }
        when (val outputIndex = decoder.dequeueOutputBuffer(info, 10_000L)) {
          MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
          MediaCodec.INFO_OUTPUT_FORMAT_CHANGED,
          MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED -> Unit
          else -> if (outputIndex >= 0) {
            val buffer = decoder.getOutputBuffer(outputIndex)
            if (buffer != null && info.size > 0) {
              buffer.position(info.offset)
              buffer.limit(info.offset + info.size)
              val bytes = ByteArray(info.size)
              buffer.get(bytes)
              output.write(bytes)
            }
            outputDone = (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
            decoder.releaseOutputBuffer(outputIndex, false)
          }
        }
      }
      assertTrue("AAC decoder timed out", outputDone)
      val bytes = output.toByteArray()
      val shorts = ShortArray(bytes.size / 2)
      val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
      for (index in shorts.indices) shorts[index] = buffer.short
      return shorts
    } finally {
      try {
        decoder.stop()
      } catch (_: Throwable) {
      }
      decoder.release()
    }
  }

  private fun energyAt(samples: ShortArray, rate: Int, frequency: Double): Double {
    var real = 0.0
    var imaginary = 0.0
    for (index in samples.indices) {
      val window = 0.5 - 0.5 * cos(2.0 * PI * index / samples.size)
      val phase = 2.0 * PI * frequency * index / rate
      val value = samples[index].toDouble() / 32768.0 * window
      real += value * cos(phase)
      imaginary -= value * sin(phase)
    }
    return (real * real + imaginary * imaginary) / (samples.size * samples.size)
  }

  private fun twoToneResidual(samples: ShortArray, rate: Int, first: Double, second: Double): Double {
    val coefficients = DoubleArray(4)
    samples.forEachIndexed { index, sample ->
      val value = sample.toDouble() / 32768.0
      val a = 2.0 * PI * first * index / rate
      val b = 2.0 * PI * second * index / rate
      coefficients[0] += value * sin(a)
      coefficients[1] += value * cos(a)
      coefficients[2] += value * sin(b)
      coefficients[3] += value * cos(b)
    }
    for (index in coefficients.indices) coefficients[index] *= 2.0 / samples.size
    var error = 0.0
    var power = 0.0
    samples.forEachIndexed { index, sample ->
      val value = sample.toDouble() / 32768.0
      val a = 2.0 * PI * first * index / rate
      val b = 2.0 * PI * second * index / rate
      val expected = coefficients[0] * sin(a) + coefficients[1] * cos(a) + coefficients[2] * sin(b) + coefficients[3] * cos(b)
      error += (value - expected) * (value - expected)
      power += value * value
    }
    return if (power > 0.0001) kotlin.math.sqrt(error / power) else Double.POSITIVE_INFINITY
  }
}
