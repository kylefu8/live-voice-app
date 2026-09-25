import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { recordings, type PlaybackStatus } from './recordings';
import type { Locale, RecordingInfo } from './types';

type Props = {
  recording: RecordingInfo;
  locale: Locale;
  disabled: boolean;
  palette: {
    surface: string;
    text: string;
    muted: string;
    border: string;
    accent: string;
    button: string;
  };
  onDeleted(): void;
};
const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(
    2,
    '0',
  )}`;

export function RecordingPlayer({
  recording,
  locale,
  disabled,
  palette: p,
  onDeleted,
}: Props) {
  const [status, setStatus] = useState<PlaybackStatus>({
    playing: false,
    positionMs: 0,
    durationMs: recording.durationMs,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const width = useRef(1);
  const alive = useRef(true);
  const tr = (zh: string, en: string) => (locale === 'zh' ? zh : en);
  useEffect(() => {
    alive.current = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const current = await recordings.playbackStatus();
        if (alive.current)
          setStatus(
            current.id === recording.id
              ? current
              : {
                  playing: false,
                  positionMs: 0,
                  durationMs: recording.durationMs,
                },
          );
      } catch {
        if (alive.current) setError(true);
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => {
      void poll();
    }, 400);
    if (!disabled)
      void recordings
        .preparePlayback(recording.id)
        .then(poll)
        .catch(() => {
          if (alive.current) setError(true);
        });
    return () => {
      alive.current = false;
      clearInterval(timer);
      void recordings.stopPlayback().catch(() => undefined);
    };
  }, [recording.id, recording.durationMs, disabled]);

  async function run(operation: () => Promise<unknown>) {
    if (busy || disabled) return;
    setBusy(true);
    setError(false);
    try {
      await operation();
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const duration = status.durationMs || recording.durationMs;
  const position = scrub ?? status.positionMs;
  const fromX = (x: number) =>
    Math.round(Math.max(0, Math.min(1, x / width.current)) * duration);
  const seek = (positionMs: number) =>
    run(async () => {
      // Preparing a stopped recording for seeking must not start playback.
      if (status.id !== recording.id) return;
      await recordings.seek(Math.max(0, Math.min(duration, positionMs)));
      const next = await recordings.playbackStatus();
      if (alive.current) setStatus(next);
    });
  function remove() {
    Alert.alert(
      tr('删除这段录音？', 'Delete this recording?'),
      tr(
        '文字记录会保留，录音删除后无法恢复。',
        'Text stays. The audio cannot be recovered after deletion.',
      ),
      [
        { text: tr('取消', 'Cancel'), style: 'cancel' },
        {
          text: tr('删除录音', 'Delete recording'),
          style: 'destructive',
          onPress: () => {
            void run(async () => {
              await recordings.delete(recording.id);
              onDeleted();
            });
          },
        },
      ],
    );
  }
  const button = (
    label: string,
    action: () => void,
    primary = false,
    needsReady = false,
  ) => (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy || (needsReady && status.id !== recording.id)}
      onPress={action}
      style={[
        styles.button,
        {
          backgroundColor: primary ? p.accent : p.surface,
          borderColor: p.border,
          opacity:
            disabled || busy || (needsReady && status.id !== recording.id)
              ? 0.45
              : 1,
        },
      ]}
    >
      <Text style={{ color: primary ? p.button : p.text }}>{label}</Text>
    </Pressable>
  );
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: p.surface, borderColor: p.border },
      ]}
    >
      <View style={styles.row}>
        <Text style={[styles.title, { color: p.text }]}>
          {tr('会话录音', 'Conversation recording')}
        </Text>
        <Text style={{ color: p.muted }}>
          {(recording.sizeBytes / 1024 / 1024).toFixed(1)} MB
        </Text>
      </View>
      <Text style={[styles.hint, { color: p.muted }]}>
        {tr('双方声音 · 仅保存在本机', 'Both voices · Saved on this device')}
      </Text>
      <View
        accessibilityRole="adjustable"
        accessibilityLabel={tr('录音进度', 'Recording position')}
        accessibilityValue={{
          min: 0,
          max: duration,
          now: position,
          text: `${time(position)} / ${time(duration)}`,
        }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={event => {
          void seek(
            position +
              (event.nativeEvent.actionName === 'increment' ? 15000 : -15000),
          );
        }}
        onLayout={event => {
          width.current = Math.max(1, event.nativeEvent.layout.width);
        }}
        onStartShouldSetResponder={() =>
          !disabled && !busy && status.id === recording.id
        }
        onResponderGrant={event => setScrub(fromX(event.nativeEvent.locationX))}
        onResponderMove={event => setScrub(fromX(event.nativeEvent.locationX))}
        onResponderRelease={event => {
          const target = fromX(event.nativeEvent.locationX);
          setScrub(null);
          void seek(target);
        }}
        onResponderTerminate={() => setScrub(null)}
        style={styles.seekArea}
      >
        <View style={[styles.track, { backgroundColor: p.border }]}>
          <View
            style={[
              styles.fill,
              {
                backgroundColor: p.accent,
                width: `${Math.min(
                  100,
                  duration ? (position / duration) * 100 : 0,
                )}%`,
              },
            ]}
          />
        </View>
      </View>
      <View style={styles.row}>
        <Text style={{ color: p.muted }}>{time(position)}</Text>
        <Text style={{ color: p.muted }}>{time(duration)}</Text>
      </View>
      <View style={styles.controls}>
        {button(
          '−15s',
          () => {
            void seek(status.positionMs - 15000);
          },
          false,
          true,
        )}
        {button(
          status.playing ? tr('暂停', 'Pause') : tr('播放', 'Play'),
          () => {
            void run(async () => {
              if (status.playing) await recordings.pause();
              else await recordings.play(recording.id);
              const next = await recordings.playbackStatus();
              if (alive.current) setStatus(next);
            });
          },
          true,
        )}
        {button(
          '+15s',
          () => {
            void seek(status.positionMs + 15000);
          },
          false,
          true,
        )}
      </View>
      {disabled && (
        <Text style={[styles.hint, { color: p.muted }]}>
          {tr(
            '结束当前对话后可播放录音。',
            'End the active conversation before playing recordings.',
          )}
        </Text>
      )}
      {recording.errorCode && (
        <Text style={[styles.hint, { color: p.accent }]}>
          {tr(
            '这段录音可能不完整，已保留可用部分。',
            'This recording may be incomplete. Available audio was kept.',
          )}
        </Text>
      )}
      {error && (
        <Text accessibilityLiveRegion="polite" style={{ color: p.accent }}>
          {tr(
            '录音操作未完成，请重试。',
            'The recording action failed. Please retry.',
          )}
        </Text>
      )}
      {button(tr('删除录音', 'Delete recording'), remove)}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 18, borderWidth: 1, borderRadius: 20, gap: 8 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: { fontSize: 18, fontWeight: '600' },
  hint: { fontSize: 13, lineHeight: 20 },
  button: {
    minHeight: 48,
    minWidth: 64,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controls: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  seekArea: { height: 44, justifyContent: 'center' },
  track: { height: 5, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 5, borderRadius: 3 },
});
