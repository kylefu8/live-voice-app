package com.livevoiceapp

import org.junit.Assert.*
import org.junit.Test

class AudioRoutePolicyTest {
  private val speaker = RouteCandidate(1, false, speaker = true)
  private val receiver = RouteCandidate(2, false, receiver = true)
  private val bluetooth = RouteCandidate(3, true)
  private val wired = RouteCandidate(4, true)

  @Test fun builtInChangesWithProximityAndFallsBackWithoutReceiver() {
    assertEquals(1, chooseAudioRoute(listOf(speaker,receiver), 2, false))
    assertEquals(2, chooseAudioRoute(listOf(speaker,receiver), 1, true))
    assertEquals(1, chooseAudioRoute(listOf(speaker), 1, true))
    assertNull(chooseAudioRoute(emptyList(), null, true))
  }
  @Test fun headsetWinsEvenWhenProximityCovered() {
    for (near in listOf(false,true)) {
      assertEquals(3, chooseAudioRoute(listOf(speaker,receiver,bluetooth), 1, near))
      assertEquals(4, chooseAudioRoute(listOf(speaker,bluetooth,wired), 4, near))
    }
  }
  @Test fun unplugAndReconnectDoNotKeepStaleDeviceSelection() {
    assertEquals(2, chooseAudioRoute(listOf(speaker,receiver), 3, true))
    assertEquals(1, chooseAudioRoute(listOf(speaker,receiver), 3, false))
    assertEquals(3, chooseAudioRoute(listOf(speaker,receiver,bluetooth), 2, true))
  }
}
