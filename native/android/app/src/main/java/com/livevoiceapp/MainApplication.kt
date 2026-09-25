package com.livevoiceapp

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.modules.network.OkHttpClientProvider
import com.oney.WebRTCModule.WebRTCModuleOptions
import org.webrtc.audio.JavaAudioDeviceModule
import com.livevoiceapp.recording.RecordingAudioTap
import com.livevoiceapp.recording.RecordingEngine
import com.livevoiceapp.recording.RecordingPackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(VoiceAudioPackage())
          add(QrConfigPackage())
          add(RecordingPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    RecordingEngine.initialize(this)
    WebRTCModuleOptions.getInstance().audioDeviceModule = JavaAudioDeviceModule.builder(this)
        .setEnableVolumeLogger(false)
        .setSamplesReadyCallback { samples -> RecordingAudioTap.microphone(samples) }
        .createAudioDeviceModule()
    // Direct user-configured endpoints must not forward credentials to redirects.
    // React Native's fetch does not implement the browser redirect option.
    OkHttpClientProvider.setOkHttpClientFactory {
      OkHttpClientProvider.createClientBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .build()
    }
    loadReactNative(this)
  }
}
