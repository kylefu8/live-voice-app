package com.livevoiceapp

import android.content.Context
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioDeviceCallback
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Window
import android.view.WindowManager
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.common.LifecycleState
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Small, app-owned audio route controller for Live voice sessions.
 *
 * WebRTC remains responsible for media transport. This module only owns the
 * Android communication route and focus lifecycle around a session.
 */
class VoiceAudioModule(
    private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context), LifecycleEventListener {

  private val mainHandler = Handler(Looper.getMainLooper())
  private val audioManager: AudioManager? =
      context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  private var started = false
  private var previousMode: Int? = null
  private var previousSpeakerphoneOn: Boolean? = null
  private var previousCommunicationDevice: AudioDeviceInfo? = null
  private var focusRequest: AudioFocusRequest? = null
  private var legacyFocusHeld = false
  // Lifecycle callbacks below keep this state accurate across backgrounding
  // and Activity recreation. Reading the initial state also covers modules
  // created after the host has already resumed.
  private var hostResumed = context.lifecycleState == LifecycleState.RESUMED
  private var screenOnWindow: Window? = null
  private var previousKeepScreenOn: Boolean? = null
  private var screenOnSuppressed = false
  private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
  private var proximityNear = false
  private var sensorRegistered = false
  private var devicesRegistered = false
  private var legacyScoOwned = false
  private var legacyScoReceiver: BroadcastReceiver? = null
  private var routeTask: Runnable? = null
  private var routeName = "system"
  private var communicationListener: AudioManager.OnCommunicationDeviceChangedListener? = null
  private val deviceCallback = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(devices: Array<out AudioDeviceInfo>) { scheduleRoute() }
    override fun onAudioDevicesRemoved(devices: Array<out AudioDeviceInfo>) { scheduleRoute() }
  }
  private val proximityListener = object : SensorEventListener {
    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    override fun onSensorChanged(event: SensorEvent) {
      val near = event.values.isNotEmpty() && event.values[0] < minOf(5f, event.sensor.maximumRange)
      if (near != proximityNear) { proximityNear = near; scheduleRoute() }
    }
  }

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    if (change == AudioManager.AUDIOFOCUS_LOSS ||
        change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
      runOnMain {
        if (!started) {
          return@runOnMain
        }
        // The JS focus-loss handler stops the session. Release the window flag
        // immediately as well, so a delayed JS cleanup cannot leave the screen
        // awake. Do not reacquire it until a new session starts.
        screenOnSuppressed = true
        restoreKeepScreenOn()
        emitFocusLost()
      }
    }
  }

  init {
    context.addLifecycleEventListener(this)
  }

  override fun getName(): String = "VoiceAudio"

  @ReactMethod
  fun start(promise: Promise) {
    runOnMain(
        promise = promise,
        failureCode = "audio_start_failed",
    ) {
      if (started) {
        return@runOnMain
      }
      startInternal()
    }
  }

  @ReactMethod
  fun setSpeaker(enabled: Boolean, promise: Promise) {
    runOnMain(
        promise = promise,
        failureCode = "audio_route_failed",
    ) {
      if (!started) {
        throw AudioFailure("audio_not_started")
      }
      setSpeakerInternal(enabled)
    }
  }

  @ReactMethod
  fun conversationConnected(promise: Promise) {
    runOnMain(promise, "audio_route_failed") {
      if (!started) throw AudioFailure("audio_not_started")
      if (!sensorRegistered) {
        val sensor = sensorManager?.getDefaultSensor(Sensor.TYPE_PROXIMITY)
        if (sensor != null) sensorRegistered = sensorManager?.registerListener(proximityListener, sensor, SensorManager.SENSOR_DELAY_NORMAL, mainHandler) == true
      }
      applyAutomaticRoute()
    }
  }

  @ReactMethod
  fun getRoute(promise: Promise) {
    mainHandler.post {
      val value = Arguments.createMap()
      value.putString("output", if (started) routeName else "system")
      value.putBoolean("automatic", true)
      promise.resolve(value)
    }
  }

  private fun scheduleRoute() {
    mainHandler.post {
      if (!started || screenOnSuppressed) return@post
      routeTask?.let { mainHandler.removeCallbacks(it) }
      val task = Runnable {
        routeTask = null
        if (started) try { applyAutomaticRoute() } catch (_: Throwable) { emitRouteFailure() }
      }
      routeTask = task
      mainHandler.postDelayed(task, 120)
    }
  }

  private fun externalDevice(type: Int): Boolean = when(type) {
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET,
    AudioDeviceInfo.TYPE_BLE_SPEAKER, AudioDeviceInfo.TYPE_WIRED_HEADSET,
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET,
    AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_HEARING_AID -> true
    else -> false
  }

  private fun publishRoute(type: Int?) {
    routeName = when(type) {
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "receiver"
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLE_SPEAKER, AudioDeviceInfo.TYPE_HEARING_AID -> "bluetooth"
      null -> "system"
      else -> "headphones"
    }
    if (context.hasActiveReactInstance()) {
      val value = Arguments.createMap(); value.putString("output", routeName); value.putBoolean("automatic", true)
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("VoiceAudioRouteChanged", value)
    }
  }

  private fun emitRouteFailure() {
    if (context.hasActiveReactInstance()) context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("VoiceAudioRouteFailed", null)
  }

  @Suppress("DEPRECATION")
  private fun applyAutomaticRoute() {
    val manager = audioManager ?: return
    if (!started || screenOnSuppressed) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val devices = manager.availableCommunicationDevices
      val current = manager.communicationDevice
      val selectedId = chooseAudioRoute(devices.map { RouteCandidate(it.id, externalDevice(it.type), it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) }, current?.id, proximityNear)
      val target = devices.firstOrNull { it.id == selectedId }
      if (target != null && current?.id != target.id && !manager.setCommunicationDevice(target)) {
        emitRouteFailure()
      }
      // Query the applied route instead of claiming that a request succeeded.
      publishRoute(manager.communicationDevice?.type)
    } else {
      val outputs = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
      val headset = outputs.firstOrNull { externalDevice(it.type) }
      if (headset?.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) {
        if (!legacyScoOwned && !manager.isBluetoothScoOn) { manager.startBluetoothSco(); legacyScoOwned = true }
        manager.isSpeakerphoneOn = false
      } else {
        if (legacyScoOwned) { manager.stopBluetoothSco(); legacyScoOwned = false }
        manager.isSpeakerphoneOn = headset == null && !proximityNear
      }
      publishRoute(if (manager.isBluetoothScoOn) AudioDeviceInfo.TYPE_BLUETOOTH_SCO else if (headset?.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) null else headset?.type ?: if (manager.isSpeakerphoneOn) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    runOnMain(
        promise = promise,
        failureCode = "audio_stop_failed",
    ) {
      stopInternal()
    }
  }

  override fun onHostResume() {
    runOnMain {
      hostResumed = true
      if (started && !screenOnSuppressed) {
        applyKeepScreenOn()
      }
    }
  }

  override fun onHostPause() {
    runOnMain {
      hostResumed = false
      restoreKeepScreenOn()
    }
  }

  override fun onHostDestroy() {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      hostResumed = false
      releaseOnDestroy()
    } else {
      mainHandler.post {
        hostResumed = false
        releaseOnDestroy()
      }
    }
  }

  override fun invalidate() {
    context.removeLifecycleEventListener(this)
    if (Looper.myLooper() == Looper.getMainLooper()) {
      hostResumed = false
      releaseOnDestroy()
    } else {
      mainHandler.post {
        hostResumed = false
        releaseOnDestroy()
      }
    }
    super.invalidate()
  }

  private fun releaseOnDestroy() {
    try {
      stopInternal()
    } catch (_: Throwable) {
      // Teardown must not crash the host even if Android has already removed
      // the communication route or focus owner.
    }
  }

  private fun runOnMain(
      promise: Promise,
      failureCode: String,
      operation: () -> Unit,
  ) {
    mainHandler.post {
      try {
        operation()
        promise.resolve(null)
      } catch (failure: AudioFailure) {
        promise.reject(failure.code, null as Throwable?)
      } catch (_: Throwable) {
        promise.reject(failureCode, null as Throwable?)
      }
    }
  }

  private fun startInternal() {
    val manager = audioManager ?: throw AudioFailure("audio_unavailable")
    previousMode = manager.mode
    previousSpeakerphoneOn = manager.isSpeakerphoneOn
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      previousCommunicationDevice = manager.communicationDevice
    }

    try {
      screenOnSuppressed = false
      requestFocus(manager)
      manager.mode = AudioManager.MODE_IN_COMMUNICATION
      started = true
      proximityNear = false
      manager.registerAudioDeviceCallback(deviceCallback, mainHandler)
      devicesRegistered = true
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val listener = AudioManager.OnCommunicationDeviceChangedListener { device ->
          if (started && !screenOnSuppressed) { publishRoute(device?.type); scheduleRoute() }
        }
        communicationListener = listener
        manager.addOnCommunicationDeviceChangedListener(context.mainExecutor, listener)
      } else {
        val receiver = object : BroadcastReceiver() {
          override fun onReceive(context: Context?, intent: Intent?) { scheduleRoute() }
        }
        context.registerReceiver(receiver, IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED))
        legacyScoReceiver = receiver
      }
      applyAutomaticRoute()
      applyKeepScreenOn()
    } catch (_: Throwable) {
      try { stopInternal() } catch (_: Throwable) {}
      throw AudioFailure("audio_start_failed")
    }
  }

  private fun setSpeakerInternal(enabled: Boolean) {
    val manager = audioManager ?: throw AudioFailure("audio_unavailable")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      if (enabled) {
        val speaker = manager.availableCommunicationDevices.firstOrNull { device ->
          device.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
        } ?: throw AudioFailure("audio_route_failed")
        if (!manager.setCommunicationDevice(speaker)) {
          throw AudioFailure("audio_route_failed")
        }
      } else {
        // Clearing lets Android select Bluetooth/earpiece according to the
        // active communication route instead of exposing device details.
        manager.clearCommunicationDevice()
      }
    } else {
      @Suppress("DEPRECATION")
      manager.isSpeakerphoneOn = enabled
    }
  }

  private fun stopInternal() {
    legacyScoReceiver?.let { try { context.unregisterReceiver(it) } catch (_: Throwable) {} }
    legacyScoReceiver = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      communicationListener?.let { audioManager?.removeOnCommunicationDeviceChangedListener(it) }
      communicationListener = null
    }
    routeTask?.let { mainHandler.removeCallbacks(it) }; routeTask = null
    if (sensorRegistered) sensorManager?.unregisterListener(proximityListener)
    sensorRegistered = false; proximityNear = false
    if (devicesRegistered) audioManager?.unregisterAudioDeviceCallback(deviceCallback)
    devicesRegistered = false
    if (legacyScoOwned) {
      @Suppress("DEPRECATION")
      audioManager?.stopBluetoothSco()
      legacyScoOwned = false
    }
    restoreKeepScreenOn()
    screenOnSuppressed = false
    if (!started && previousMode == null && previousSpeakerphoneOn == null) {
      return
    }

    val manager = audioManager
    var failure: AudioFailure? = null
    if (manager != null) {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          val previous = previousCommunicationDevice
          if (previous != null) {
            if (!manager.setCommunicationDevice(previous)) {
              manager.clearCommunicationDevice()
            }
          } else {
            manager.clearCommunicationDevice()
          }
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
          previousSpeakerphoneOn?.let { previous ->
            @Suppress("DEPRECATION")
            manager.isSpeakerphoneOn = previous
          }
        }
        previousMode?.let { previous -> manager.mode = previous }
      } catch (_: Throwable) {
        failure = AudioFailure("audio_stop_failed")
      } finally {
        abandonFocus(manager)
      }
    } else {
      failure = AudioFailure("audio_unavailable")
    }

    started = false
    routeName = "system"
    clearSavedRouteState()
    if (failure != null) {
      throw failure as AudioFailure
    }
  }

  private fun requestFocus(manager: AudioManager) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val attributes = AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
          .setAudioAttributes(attributes)
          .setOnAudioFocusChangeListener(focusListener)
          .build()
      focusRequest = request
      if (manager.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
        focusRequest = null
        throw AudioFailure("audio_focus_denied")
      }
    } else {
      @Suppress("DEPRECATION")
      val result = manager.requestAudioFocus(
          focusListener,
          AudioManager.STREAM_VOICE_CALL,
          AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
      )
      if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
        throw AudioFailure("audio_focus_denied")
      }
      legacyFocusHeld = true
    }
  }

  private fun abandonFocus(manager: AudioManager) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        focusRequest?.let { request -> manager.abandonAudioFocusRequest(request) }
      } else if (legacyFocusHeld) {
        @Suppress("DEPRECATION")
        manager.abandonAudioFocus(focusListener)
      }
    } catch (_: Throwable) {
      // Focus may already have been reclaimed by the system during teardown.
    } finally {
      focusRequest = null
      legacyFocusHeld = false
    }
  }

  private fun clearSavedRouteState() {
    previousMode = null
    previousSpeakerphoneOn = null
    previousCommunicationDevice = null
    focusRequest = null
    legacyFocusHeld = false
    screenOnSuppressed = false
  }

  /**
   * Keep the foreground Activity awake only while this module owns an active
   * voice session. This is deliberately best-effort: losing an Activity must
   * not make an otherwise valid audio session fail to start.
   */
  private fun applyKeepScreenOn() {
    if (!started || !hostResumed || screenOnSuppressed) {
      return
    }
    val window = context.currentActivity?.window ?: return

    if (screenOnWindow === window) {
      return
    }

    // A resumed Activity can be a new instance after configuration change.
    // Restore the old instance before taking ownership of the new one.
    restoreKeepScreenOn()
    val wasSet = try {
      (window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0
    } catch (_: Throwable) {
      false
    }
    try {
      window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      screenOnWindow = window
      previousKeepScreenOn = wasSet
    } catch (_: Throwable) {
      // Keep the audio route usable even if the Activity window disappeared.
    }
  }

  /** Restore the flag state that existed before this session took ownership. */
  private fun restoreKeepScreenOn() {
    val window = screenOnWindow
    val wasSet = previousKeepScreenOn
    if (window != null && wasSet != null) {
      try {
        if (wasSet) {
          window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
          window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
      } catch (_: Throwable) {
        // The window may already be detached during Activity teardown.
      }
    }
    screenOnWindow = null
    previousKeepScreenOn = null
  }

  /** Run lifecycle/window work on the UI thread without coupling it to a JS Promise. */
  private fun runOnMain(operation: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      operation()
    } else {
      mainHandler.post(operation)
    }
  }

  private fun emitFocusLost() {
    if (!context.hasActiveReactInstance()) {
      return
    }
    try {
      context
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit("VoiceAudioFocusLost", null)
    } catch (_: Throwable) {
      // React may already be tearing down; there is no user-visible detail to
      // report and stop() will still release the native route on destruction.
    }
  }

  private class AudioFailure(
      val code: String,
  ) : RuntimeException()
}
