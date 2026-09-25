package com.livevoiceapp

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.PromiseImpl
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.ReadableMap
import com.livevoiceapp.recording.RecordingModule
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** No microphone, model calls, credentials or existing recording content is used. */
@RunWith(AndroidJUnit4::class)
class RecordingLifecycleInstrumentationTest {
  @Test
  fun activityRecreationKeepsRecordingModuleUsableUntilBridgeInvalidation() {
    val context = BridgeReactContext(InstrumentationRegistry.getInstrumentation().targetContext)
    val module = RecordingModule(context)
    try {
      assertEquals("resolved", outcome { module.stopPlayback(it) })
      repeat(3) {
        module.onHostPause()
        module.onHostDestroy()
        module.onHostResume()
        assertEquals("Activity restart must not destroy the React module", "resolved", outcome { module.stopPlayback(it) })
        val absentId = "test_absent_${UUID.randomUUID().toString().replace("-", "")}"
        assertEquals("Recording executor must survive Activity recreation", "resolved", outcome { module.get(absentId, it) })
        val id = "test_lifecycle_${UUID.randomUUID().toString().replace("-", "")}"
        assertEquals("New recording setup must work after reopening", "resolved", outcome { module.start(id, "general", System.currentTimeMillis().toDouble(), it) })
        assertEquals("resolved", outcome { module.discard(id, it) })
      }
      module.invalidate()
      assertEquals("recording_destroyed", outcome { module.stopPlayback(it) })
    } finally {
      module.invalidate()
    }
  }

  private fun outcome(action: (Promise) -> Unit): String {
    val latch = CountDownLatch(1)
    val result = AtomicReference("pending")
    val promise = PromiseImpl(
        Callback { result.set("resolved"); latch.countDown() },
        Callback { arguments ->
          result.set((arguments.firstOrNull() as? ReadableMap)?.getString("code") ?: "rejected")
          latch.countDown()
        },
    )
    action(promise)
    assertTrue("Native promise must settle", latch.await(5, TimeUnit.SECONDS))
    return result.get()
  }
}
