package com.livevoiceapp.recording

import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.sin

class RecordingTimelineTest {
  private val rate = 24_000
  private val packet = 240 // Real WebRTC callbacks contain 10ms of PCM.
  private fun timeline() = RecordingTimeline(rate * 10, rate / 4L)

  @Test
  fun jitterAndBatchedDeliveryPreserveEverySampleWithoutGapsOrRepeats() {
    val output = timeline()
    val expected = FloatArray(packet * 100) { index ->
      (0.22 * sin(index * 0.11) + 0.1 * sin(index * 0.027)).toFloat()
    }
    // Four callbacks arrive in a burst every 40ms, with realistic extra jitter.
    repeat(100) { part ->
      val observed = if (part == 0) 0L else ((part / 4) * 4 * packet + 3 * packet + (part % 3) * 37).toLong()
      output.append(observed, expected.copyOfRange(part * packet, (part + 1) * packet))
    }
    expected.forEachIndexed { index, sample ->
      assertEquals("sample $index", sample, output.sampleAt(index.toLong()), 0f)
    }
    assertEquals(0f, output.sampleAt(expected.size.toLong()), 0f)
  }

  @Test
  fun independentSourceOffsetsAndRealPausesRemainOnTheSameTimeline() {
    val microphone = timeline()
    val assistant = timeline()
    microphone.append(0, FloatArray(packet) { 0.1f })
    assistant.append(2L * packet, FloatArray(packet) { 0.2f })
    assertEquals(0f, assistant.sampleAt(0), 0f)
    assertEquals(0.2f, assistant.sampleAt(2L * packet), 0f)
    microphone.append(rate.toLong(), FloatArray(packet) { 0.3f })
    assertEquals(0f, microphone.sampleAt(rate / 2L), 0f)
    assertEquals(0.3f, microphone.sampleAt(rate.toLong()), 0f)
  }

  @Test
  fun silenceAdvancesTheClockAndTrimmingDoesNotShiftRemainingSamples() {
    val output = timeline()
    output.append(0, FloatArray(packet) { 0.1f })
    output.append(packet.toLong() + 19, FloatArray(packet))
    output.append(packet.toLong() * 2 - 31, FloatArray(packet) { 0.3f })
    output.trimBefore(packet.toLong())
    assertEquals(0f, output.sampleAt(0), 0f)
    assertEquals(0f, output.sampleAt(packet.toLong()), 0f)
    assertEquals(0.3f, output.sampleAt(packet.toLong() * 2), 0f)
  }
}
