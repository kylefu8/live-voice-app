package com.livevoiceapp.recording

import java.util.ArrayDeque
import kotlin.math.max

/**
 * PCM is clocked by sample counts, not callback delivery times. AudioRecord and
 * AudioTrack can deliver several buffers together after a scheduling delay.
 * Only a long forward discontinuity re-anchors a stream (for example a route restart).
 */
internal class RecordingTimeline(
    private val maxSamples: Int,
    private val discontinuityFrames: Long,
) {
  private data class Chunk(val startFrame: Long, val samples: FloatArray) {
    val endFrame: Long get() = startFrame + samples.size
  }
  private val chunks = ArrayDeque<Chunk>()
  private var bufferedSamples = 0
  private var nextFrame: Long? = null

  fun append(observedStartFrame: Long, samples: FloatArray): Long {
    val expected = nextFrame
    val start = when {
      expected == null -> max(0L, observedStartFrame)
      observedStartFrame - expected > discontinuityFrames -> observedStartFrame
      else -> expected
    }
    val end = start + samples.size
    nextFrame = end
    if (samples.isNotEmpty()) {
      chunks.addLast(Chunk(start, samples))
      bufferedSamples += samples.size
    }
    while (bufferedSamples > maxSamples && chunks.isNotEmpty()) {
      bufferedSamples -= chunks.removeFirst().samples.size
    }
    return end
  }

  fun sampleAt(frame: Long): Float {
    for (chunk in chunks) {
      if (frame < chunk.startFrame) return 0f
      val offset = frame - chunk.startFrame
      if (offset >= 0 && offset < chunk.samples.size) return chunk.samples[offset.toInt()]
    }
    return 0f
  }

  fun trimBefore(frame: Long) {
    while (chunks.isNotEmpty()) {
      val first = chunks.peekFirst() ?: break
      if (first.endFrame > frame) break
      bufferedSamples -= chunks.removeFirst().samples.size
    }
  }
}
