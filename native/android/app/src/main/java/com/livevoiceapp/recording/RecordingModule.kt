package com.livevoiceapp.recording

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** React Native bridge for local session recordings and playback. */
class RecordingModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), LifecycleEventListener {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val work: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "live-voice-recording-bridge").apply { isDaemon = true }
  }
  private val destroyed = AtomicBoolean(false)
  private val audioManager = reactContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
  private var player: MediaPlayer? = null
  private var playbackId: String? = null
  private var playbackPrepared = false
  private var focusRequest: AudioFocusRequest? = null
  private var legacyFocusHeld = false

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    if (change == AudioManager.AUDIOFOCUS_LOSS ||
        change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
      mainHandler.post { stopPlaybackInternal() }
    }
  }

  init {
    RecordingEngine.initialize(reactContext)
    reactContext.addLifecycleEventListener(this)
  }

  override fun getName(): String = "VoiceRecording"

  @ReactMethod
  fun start(id: String, mode: String, startedAt: Double, promise: Promise) {
    executeRecording(promise, "recording_start_failed") {
      stopPlaybackAndWait()
      RecordingEngine.startSession(id, mode, startedAt.toLong())
      null
    }
  }

  @ReactMethod
  fun finish(id: String, confirmedClose: Boolean, promise: Promise) {
    executeRecording(promise, "recording_finish_failed") {
      RecordingEngine.finishSession(id, confirmedClose)?.let(::infoMap)
    }
  }

  @ReactMethod
  fun discard(id: String, promise: Promise) {
    executeRecording(promise, "recording_discard_failed") {
      RecordingEngine.discardSession(id)
      null
    }
  }

  @ReactMethod
  fun setMuted(id: String, muted: Boolean, promise: Promise) {
    executeRecording(promise, "recording_mute_failed") {
      RecordingEngine.setSessionMuted(id, muted)
      null
    }
  }

  @ReactMethod
  fun markConnected(id: String, promise: Promise) {
    executeRecording(promise, "recording_mark_connected_failed") {
      RecordingEngine.markSessionConnected(id)
      null
    }
  }

  @ReactMethod
  fun status(promise: Promise) {
    try {
      promise.resolve(statusMap(RecordingEngine.statusSnapshot()))
    } catch (failure: RecordingEngine.RecordingFailure) {
      reject(promise, failure.code)
    } catch (_: Throwable) {
      reject(promise, "recording_status_failed")
    }
  }

  @ReactMethod
  fun list(offset: Int, limit: Int, promise: Promise) {
    executeRecording(promise, "recording_list_failed") {
      val result = RecordingEngine.list(offset, limit)
      Arguments.createMap().apply {
        putArray("items", infoArray(result.items))
        putBoolean("hasMore", result.hasMore)
      }
    }
  }

  @ReactMethod
  fun get(id: String, promise: Promise) {
    executeRecording(promise, "recording_get_failed") {
      RecordingEngine.get(id)?.let(::infoMap)
    }
  }

  @ReactMethod
  fun delete(id: String, promise: Promise) {
    executeRecording(promise, "recording_delete_failed") {
      // Remove the player first so a deleted file cannot keep producing audio.
      stopPlaybackAndWait()
      RecordingEngine.delete(id)
      null
    }
  }

  @ReactMethod
  fun preparePlayback(id: String, promise: Promise) {
    runOnMain(promise, "recording_prepare_failed") {
      preparePlaybackInternal(id)
      null
    }
  }

  @ReactMethod
  fun play(id: String, promise: Promise) {
    runOnMain(promise, "recording_play_failed") {
      if (playbackId != id || player == null || !playbackPrepared) {
        preparePlaybackInternal(id)
      }
      val current = player ?: throw RecordingEngine.RecordingFailure("recording_playback_failed")
      requestMediaFocus()
      val duration = try { current.duration } catch (_: Throwable) { 0 }
      val position = try { current.currentPosition } catch (_: Throwable) { 0 }
      if (duration > 0 && position >= duration - 100) current.seekTo(0)
      current.start()
      null
    }
  }

  @ReactMethod
  fun pause(promise: Promise) {
    runOnMain(promise, "recording_pause_failed") {
      player?.let { current ->
        if (current.isPlaying) current.pause()
      }
      abandonMediaFocus()
      null
    }
  }

  @ReactMethod
  fun seek(positionMs: Int, promise: Promise) {
    runOnMain(promise, "recording_seek_failed") {
      val current = player ?: throw RecordingEngine.RecordingFailure("recording_playback_not_ready")
      val duration = try { current.duration } catch (_: Throwable) { 0 }
      current.seekTo(positionMs.coerceIn(0, maxOf(0, duration)))
      null
    }
  }

  @ReactMethod
  fun stopPlayback(promise: Promise) {
    runOnMain(promise, "recording_stop_playback_failed") {
      stopPlaybackInternal()
      null
    }
  }

  @ReactMethod
  fun playbackStatus(promise: Promise) {
    runOnMain(promise, "recording_playback_status_failed") {
      playbackStatusMap()
    }
  }

  override fun onHostResume() = Unit

  override fun onHostPause() {
    // A prepared/player instance must not keep an audio focus or media route
    // while the app is in the background. Save the active recording as well;
    // the live transport owns its own teardown and is unaffected by errors.
    mainHandler.post { stopPlaybackInternal() }
    val closingId = RecordingEngine.statusSnapshot().id
    if (!destroyed.get() && closingId != null) {
      try {
        work.execute {
          try {
            RecordingEngine.finishSession(closingId, false)
          } catch (_: Throwable) {
            // Best effort lifecycle persistence only.
          }
        }
      } catch (_: RejectedExecutionException) {
        // invalidate() may race this host callback; its cleanup owns shutdown.
      }
    }
  }

  override fun onHostDestroy() {
    // The Activity can be recreated while its React context/modules survive.
    // Only invalidate() means this module can never be used again.
    onHostPause()
  }

  override fun invalidate() {
    shutdown()
    reactContext.removeLifecycleEventListener(this)
    super.invalidate()
  }

  private fun shutdown() {
    if (!destroyed.compareAndSet(false, true)) return
    mainHandler.post { stopPlaybackInternal() }
    val closingId = RecordingEngine.statusSnapshot().id
    if (closingId != null) {
      work.execute {
        try {
          // A replacement React context may start another session before this
          // queued task runs. Cleanup must never finish that newer recording.
          RecordingEngine.finishSession(closingId, false)
        } catch (_: Throwable) {
        }
      }
    }
    work.shutdown()
  }

  private fun executeRecording(promise: Promise, fallback: String, operation: () -> Any?) {
    if (destroyed.get()) {
      reject(promise, "recording_destroyed")
      return
    }
    try {
      work.execute {
        if (destroyed.get()) {
          reject(promise, "recording_destroyed")
          return@execute
        }
        try {
          promise.resolve(operation())
        } catch (failure: RecordingEngine.RecordingFailure) {
          reject(promise, failure.code)
        } catch (_: Throwable) {
          reject(promise, fallback)
        }
      }
    } catch (_: RejectedExecutionException) {
      reject(promise, "recording_destroyed")
    }
  }

  private fun runOnMain(promise: Promise, fallback: String, operation: () -> Any?) {
    if (destroyed.get()) {
      reject(promise, "recording_destroyed")
      return
    }
    mainHandler.post {
      if (destroyed.get()) {
        reject(promise, "recording_destroyed")
        return@post
      }
      try {
        promise.resolve(operation())
      } catch (failure: RecordingEngine.RecordingFailure) {
        reject(promise, failure.code)
      } catch (_: Throwable) {
        reject(promise, fallback)
      }
    }
  }

  private fun reject(promise: Promise, code: String) {
    // Only fixed app error codes, never exception messages or private paths.
    android.util.Log.w("VoiceRecording", "Action rejected: $code")
    promise.reject(code, null as Throwable?)
  }

  private fun stopPlaybackAndWait() {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      stopPlaybackInternal()
      return
    }
    val latch = java.util.concurrent.CountDownLatch(1)
    mainHandler.post {
      try {
        stopPlaybackInternal()
      } finally {
        latch.countDown()
      }
    }
    try {
      latch.await(2, TimeUnit.SECONDS)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
  }

  private fun preparePlaybackInternal(id: String) {
    val file = RecordingEngine.playbackFile(id)
        ?: throw RecordingEngine.RecordingFailure("recording_not_found")
    stopPlaybackInternal()
    val created = MediaPlayer()
    try {
      created.apply {
        setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        setDataSource(reactContext, Uri.fromFile(file))
        prepare()
      }
    } catch (_: Throwable) {
      try {
        created.release()
      } catch (_: Throwable) {
      }
      throw RecordingEngine.RecordingFailure("recording_playback_failed")
    }
    created.setOnCompletionListener {
      // Keep the prepared player for seek and for a subsequent play-from-start.
      abandonMediaFocus()
    }
    created.setOnErrorListener { _, _, _ ->
      stopPlaybackInternal()
      true
    }
    player = created
    playbackId = id
    playbackPrepared = true
  }

  private fun stopPlaybackInternal() {
    val current = player
    player = null
    playbackId = null
    playbackPrepared = false
    abandonMediaFocus()
    if (current != null) {
      try {
        current.stop()
      } catch (_: Throwable) {
      }
      try {
        current.release()
      } catch (_: Throwable) {
      }
    }
  }

  private fun requestMediaFocus() {
    val manager = audioManager ?: return
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
          .setAudioAttributes(
              AudioAttributes.Builder()
                  .setUsage(AudioAttributes.USAGE_MEDIA)
                  .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                  .build(),
          )
          .setOnAudioFocusChangeListener(focusListener)
          .build()
      focusRequest = request
      if (manager.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
        focusRequest = null
        throw RecordingEngine.RecordingFailure("recording_audio_focus_denied")
      }
    } else {
      @Suppress("DEPRECATION")
      val result = manager.requestAudioFocus(
          focusListener,
          AudioManager.STREAM_MUSIC,
          AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK,
      )
      if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
        throw RecordingEngine.RecordingFailure("recording_audio_focus_denied")
      }
      legacyFocusHeld = true
    }
  }

  private fun abandonMediaFocus() {
    val manager = audioManager ?: return
    try {
      if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
        focusRequest?.let { manager.abandonAudioFocusRequest(it) }
      } else if (legacyFocusHeld) {
        @Suppress("DEPRECATION")
        manager.abandonAudioFocus(focusListener)
      }
    } catch (_: Throwable) {
    } finally {
      focusRequest = null
      legacyFocusHeld = false
    }
  }

  private fun infoMap(info: RecordingEngine.RecordingInfo): WritableMap = Arguments.createMap().apply {
    putString("id", info.id)
    putString("mode", info.mode)
    putDouble("startedAt", info.startedAt.toDouble())
    putDouble("durationMs", info.durationMs.toDouble())
    putDouble("sizeBytes", info.sizeBytes.toDouble())
    putBoolean("confirmedClose", info.confirmedClose)
    info.errorCode?.let { putString("errorCode", it) }
  }

  private fun infoArray(items: List<RecordingEngine.RecordingInfo>): WritableArray = Arguments.createArray().apply {
    items.forEach { pushMap(infoMap(it)) }
  }

  private fun statusMap(status: RecordingEngine.RecordingStatus): WritableMap = Arguments.createMap().apply {
    status.id?.let { putString("id", it) }
    putString("state", status.state)
    status.code?.let { putString("code", it) }
  }

  private fun playbackStatusMap(): WritableMap = Arguments.createMap().apply {
    playbackId?.let { putString("id", it) }
    val current = player
    if (current == null || !playbackPrepared) {
      putBoolean("playing", false)
      putDouble("positionMs", 0.0)
      putDouble("durationMs", 0.0)
    } else {
      val position = try { current.currentPosition } catch (_: Throwable) { 0 }
      val duration = try { current.duration } catch (_: Throwable) { 0 }
      putBoolean("playing", try { current.isPlaying } catch (_: Throwable) { false })
      putDouble("positionMs", position.toDouble())
      putDouble("durationMs", duration.toDouble())
    }
  }
}
