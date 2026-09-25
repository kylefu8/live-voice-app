package com.livevoiceapp

import android.app.Activity
import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.ScanOptions
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Narrow Android bridge for the encrypted configuration QR flow.
 *
 * The scanner is an app-local CaptureActivity supplied by ZXing Embedded. The
 * module never logs or persists the QR payload, passphrase, decrypted object,
 * or API keys. The decrypted map only lives long enough for the JS layer to
 * test and commit it through its secure storage boundary.
 */
class QrConfigModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), ActivityEventListener, LifecycleEventListener {

  private val mainHandler = Handler(Looper.getMainLooper())
  private val cryptoExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private val stateLock = Any()
  private var activeScan: ActiveScan? = null
  private var activeDecrypt: ActiveDecrypt? = null

  init {
    reactContext.addActivityEventListener(this)
    reactContext.addLifecycleEventListener(this)
  }

  override fun getName(): String = "QrConfig"

  @ReactMethod
  fun scan(locale: String, promise: Promise) {
    mainHandler.post {
      val activity = reactContext.currentActivity
      if (activity == null || activity.isFinishing || activity.isDestroyed) {
        promise.reject(ERROR_CAMERA_UNAVAILABLE, null as Throwable?)
        return@post
      }

      val scan = synchronized(stateLock) {
        if (activeScan != null || activeDecrypt != null) {
          null
        } else {
          ActiveScan(promise, activity).also { activeScan = it }
        }
      }
      if (scan == null) {
        promise.reject(ERROR_BUSY, null as Throwable?)
        return@post
      }

      val prompt = if (locale == "en") {
        "Scan the encrypted configuration QR code"
      } else {
        "扫描加密配置二维码"
      }
      try {
        val intent = ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setCaptureActivity(QrCaptureActivity::class.java)
            .setPrompt(prompt)
            .setBeepEnabled(false)
            .setBarcodeImageEnabled(false)
            .setOrientationLocked(true)
            .createScanIntent(activity)
        activity.startActivityForResult(intent, SCAN_REQUEST_CODE)
      } catch (_: Throwable) {
        finishScanWithError(ERROR_CAMERA_UNAVAILABLE)
      }
    }
  }

  @ReactMethod
  fun decrypt(payload: String, passphrase: String, promise: Promise) {
    val operation = synchronized(stateLock) {
      if (activeScan != null || activeDecrypt != null) {
        null
      } else {
        ActiveDecrypt(promise).also { activeDecrypt = it }
      }
    }
    if (operation == null) {
      promise.reject(ERROR_BUSY, null as Throwable?)
      return
    }

    try {
      operation.future = cryptoExecutor.submit {
        try {
          val decoded = QrConfigCrypto.decrypt(payload, passphrase) {
            operation.cancelled.get() || Thread.currentThread().isInterrupted
          }
          if (operation.cancelled.get()) {
            throw QrCryptoException(ERROR_CANCELLED)
          }
          if (operation.done.compareAndSet(false, true)) {
            promise.resolve(decoded.toWritableMap())
          }
        } catch (error: QrCryptoException) {
          if (operation.done.compareAndSet(false, true)) {
            promise.reject(error.code, null as Throwable?)
          }
        } catch (_: Throwable) {
          if (operation.done.compareAndSet(false, true)) {
            promise.reject(ERROR_DECRYPT_FAILED, null as Throwable?)
          }
        } finally {
          synchronized(stateLock) {
            if (activeDecrypt === operation) activeDecrypt = null
          }
        }
      }
    } catch (_: Throwable) {
      synchronized(stateLock) {
        if (activeDecrypt === operation) activeDecrypt = null
      }
      if (operation.done.compareAndSet(false, true)) {
        promise.reject(ERROR_DECRYPT_FAILED, null as Throwable?)
      }
    }
  }

  @ReactMethod
  fun cancel(promise: Promise) {
    mainHandler.post {
      val scan: ActiveScan?
      val decrypt: ActiveDecrypt?
      synchronized(stateLock) {
        scan = activeScan
        decrypt = activeDecrypt
        activeScan = null
        activeDecrypt = null
        decrypt?.cancelled?.set(true)
      }

      scan?.let {
        try {
          it.activity.finishActivity(SCAN_REQUEST_CODE)
        } catch (_: Throwable) {
          // The activity may already be returning its result.
        }
        if (it.done.compareAndSet(false, true)) {
          it.promise.reject(ERROR_CANCELLED, null as Throwable?)
        }
      }
      decrypt?.let {
        it.future?.cancel(true)
        if (it.done.compareAndSet(false, true)) {
          it.promise.reject(ERROR_CANCELLED, null as Throwable?)
        }
      }
      promise.resolve(null)
    }
  }

  override fun onActivityResult(
      activity: Activity,
      requestCode: Int,
      resultCode: Int,
      data: Intent?,
  ) {
    if (requestCode != SCAN_REQUEST_CODE) return

    val scan = synchronized(stateLock) {
      activeScan.also { activeScan = null }
    } ?: return
    if (!scan.done.compareAndSet(false, true)) return

    if (resultCode == Activity.RESULT_OK) {
      val payload = data?.getStringExtra(Intents.Scan.RESULT)
      if (!payload.isNullOrEmpty()) {
        try {
          QrConfigCrypto.validatePayload(payload)
          scan.promise.resolve(payload)
        } catch (error: QrCryptoException) {
          scan.promise.reject(error.code, null as Throwable?)
        } catch (_: Throwable) {
          scan.promise.reject(QrConfigCrypto.ERROR_INVALID_PAYLOAD, null as Throwable?)
        }
      } else {
        scan.promise.reject(ERROR_CANCELLED, null as Throwable?)
      }
      return
    }

    val missingPermission = data?.getBooleanExtra(
        Intents.Scan.MISSING_CAMERA_PERMISSION,
        false,
    ) == true
    scan.promise.reject(
        if (missingPermission) ERROR_CAMERA_PERMISSION else ERROR_CANCELLED,
        null as Throwable?,
    )
  }

  override fun onNewIntent(intent: Intent) = Unit

  // The scanner activity pauses the React host while it is visible. Do not
  // interpret onHostPause as a cancellation; real backgrounding is handled by
  // QrCaptureActivity.onStop().
  override fun onHostResume() = Unit

  override fun onHostPause() = Unit

  override fun onHostDestroy() {
    cancelActive()
  }

  override fun invalidate() {
    reactContext.removeActivityEventListener(this)
    reactContext.removeLifecycleEventListener(this)
    cancelActive()
    cryptoExecutor.shutdownNow()
    super.invalidate()
  }

  private fun cancelActive() {
    val scan: ActiveScan?
    val decrypt: ActiveDecrypt?
    synchronized(stateLock) {
      scan = activeScan
      decrypt = activeDecrypt
      activeScan = null
      activeDecrypt = null
      decrypt?.cancelled?.set(true)
    }
    scan?.let {
      finishScanActivity(it)
      if (it.done.compareAndSet(false, true)) {
        it.promise.reject(ERROR_CANCELLED, null as Throwable?)
      }
    }
    decrypt?.let {
      it.future?.cancel(true)
      if (it.done.compareAndSet(false, true)) {
        it.promise.reject(ERROR_CANCELLED, null as Throwable?)
      }
    }
  }

  private fun finishScanWithError(code: String) {
    val scan = synchronized(stateLock) {
      activeScan.also { activeScan = null }
    } ?: return
    if (scan.done.compareAndSet(false, true)) {
      scan.promise.reject(code, null as Throwable?)
    }
  }

  private fun finishScanActivity(scan: ActiveScan) {
    val finish = {
      try {
        scan.activity.finishActivity(SCAN_REQUEST_CODE)
      } catch (_: Throwable) {
        // The activity may already be returning its result.
      }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) finish() else mainHandler.post(finish)
  }

  private data class ActiveScan(
      val promise: Promise,
      val activity: Activity,
      val done: AtomicBoolean = AtomicBoolean(false),
  )

  private data class ActiveDecrypt(
      val promise: Promise,
      val cancelled: AtomicBoolean = AtomicBoolean(false),
      val done: AtomicBoolean = AtomicBoolean(false),
      var future: Future<*>? = null,
  )

  companion object {
    private const val SCAN_REQUEST_CODE = 0x4C56
    private const val ERROR_CANCELLED = "qr_cancelled"
    private const val ERROR_BUSY = "qr_busy"
    private const val ERROR_CAMERA_PERMISSION = "camera_permission"
    private const val ERROR_CAMERA_UNAVAILABLE = "camera_unavailable"
    private const val ERROR_DECRYPT_FAILED = "decrypt_failed"
  }
}

private fun QrConfig.toWritableMap(): WritableMap {
  val result = Arguments.createMap()
  result.putInt("version", version)
  val connectionMap = Arguments.createMap()
  voice?.let { connectionMap.putMap("voice", it.toWritableMap()) }
  backend?.let { connectionMap.putMap("backend", it.toWritableMap()) }
  result.putMap("connections", connectionMap)
  return result
}

private fun QrConnection.toWritableMap(): WritableMap {
  val result = Arguments.createMap()
  result.putString("endpoint", endpoint)
  result.putString("model", model)
  result.putString("auth", auth)
  result.putString("apiKey", apiKey)
  return result
}
