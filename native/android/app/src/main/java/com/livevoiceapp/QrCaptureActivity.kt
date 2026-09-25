package com.livevoiceapp

import android.app.Activity
import android.os.Bundle
import com.journeyapps.barcodescanner.CaptureActivity

/**
 * The scanner is deliberately a separate, non-exported activity.  If the
 * application is sent to the background while the camera is open, return a
 * normal cancellation to React Native instead of leaving the camera session
 * alive.
 */
class QrCaptureActivity : CaptureActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
  }

  override fun onStop() {
    super.onStop()
    if (!isChangingConfigurations && !isFinishing) {
      setResult(Activity.RESULT_CANCELED)
      finish()
    }
  }
}
