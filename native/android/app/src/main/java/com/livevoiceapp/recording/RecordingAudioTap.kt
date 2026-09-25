package com.livevoiceapp.recording

import android.media.AudioFormat
import android.media.AudioTrack
import android.os.SystemClock
import java.nio.ByteBuffer
import org.webrtc.audio.JavaAudioDeviceModule

/** Audio-thread boundary: preserve playback exactly; recording is a best-effort bounded copy. */
object RecordingAudioTap {
  @JvmStatic
  fun write(track: AudioTrack, buffer: ByteBuffer, size: Int, mode: Int): Int {
    val position = buffer.position()
    val timestamp = SystemClock.elapsedRealtimeNanos()
    // Keep the original return value, exceptions and buffer-position semantics.
    val written = track.write(buffer, size, mode)
    try {
      if (written > 0 && RecordingEngine.isCapturing() && track.audioFormat == AudioFormat.ENCODING_PCM_16BIT) {
        val copy = buffer.duplicate()
        copy.position(position)
        copy.limit(position + written)
        val bytes = ByteArray(written)
        copy.get(bytes)
        RecordingEngine.offer(1, bytes, track.sampleRate, track.channelCount,
            AudioFormat.ENCODING_PCM_16BIT, timestamp)
      }
    } catch (_: Throwable) {
      // Recording must never terminate WebRTC's real-time playback thread.
    }
    return written
  }

  fun microphone(samples: JavaAudioDeviceModule.AudioSamples) {
    try {
      if (!RecordingEngine.isCapturing() || samples.audioFormat != AudioFormat.ENCODING_PCM_16BIT) return
      val durationNs = samples.data.size.toLong() * 1_000_000_000L /
          (samples.channelCount.toLong() * 2L * samples.sampleRate.toLong())
      RecordingEngine.offer(0, samples.data, samples.sampleRate, samples.channelCount,
          samples.audioFormat, SystemClock.elapsedRealtimeNanos() - durationNs)
    } catch (_: Throwable) {
      // Recording is independent from microphone delivery to the active call.
    }
  }
}
