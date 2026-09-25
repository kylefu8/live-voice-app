import { NativeModules, Platform } from 'react-native';
import type { ConversationRecord, Mode, RecordingInfo } from './types';

export type RecordingStatus = {
  id?: string;
  state: 'idle' | 'recording' | 'saving' | 'error';
  code?: string;
};
export type PlaybackStatus = {
  id?: string;
  playing: boolean;
  positionMs: number;
  durationMs: number;
};
type RecordingPage = { items: RecordingInfo[]; hasMore: boolean };
type RecordingBridge = {
  start(id: string, mode: Mode, startedAt: number): Promise<void>;
  markConnected(id: string): Promise<void>;
  finish(id: string, confirmedClose: boolean): Promise<RecordingInfo | null>;
  discard(id: string): Promise<void>;
  setMuted(id: string, value: boolean): Promise<void>;
  status(): Promise<RecordingStatus>;
  list(offset: number, limit: number): Promise<RecordingPage>;
  get(id: string): Promise<RecordingInfo | null>;
  delete(id: string): Promise<void>;
  preparePlayback(id: string): Promise<void>;
  play(id: string): Promise<void>;
  pause(): Promise<void>;
  seek(ms: number): Promise<void>;
  stopPlayback(): Promise<void>;
  playbackStatus(): Promise<PlaybackStatus>;
};

export function recordingAvailable(): boolean {
  return (Platform.OS === 'android' || Platform.OS === 'ios') && Boolean(NativeModules.VoiceRecording);
}
function bridge(): RecordingBridge {
  if (!recordingAvailable()) throw new Error('recording_unavailable');
  return NativeModules.VoiceRecording as RecordingBridge;
}
export const recordings = {
  markConnected: (id: string) => bridge().markConnected(id),
  start: (id: string, mode: Mode, startedAt: number) =>
    bridge().start(id, mode, startedAt),
  finish: (id: string, confirmed: boolean) => bridge().finish(id, confirmed),
  discard: (id: string) => bridge().discard(id),
  setMuted: (id: string, muted: boolean) => bridge().setMuted(id, muted),
  status: () => bridge().status(),
  list: (offset = 0) => bridge().list(offset, 50),
  get: (id: string) => bridge().get(id),
  delete: (id: string) => bridge().delete(id),
  preparePlayback: (id: string) => bridge().preparePlayback(id),
  play: (id: string) => bridge().play(id),
  pause: () => bridge().pause(),
  seek: (ms: number) => bridge().seek(ms),
  stopPlayback: async () => {
    if (recordingAvailable()) await bridge().stopPlayback();
  },
  playbackStatus: () => bridge().playbackStatus(),
};

/** Keep recordings visible even after their optional text falls out of the text-history limit. */
export function mergeRecordingHistory(
  texts: ConversationRecord[],
  audio: RecordingInfo[],
): ConversationRecord[] {
  const result = new Map(texts.map(record => [record.id, { ...record }]));
  for (const recording of audio) {
    if (recording.sizeBytes <= 0 || recording.durationMs <= 0) continue;
    const existing = result.get(recording.id);
    result.set(recording.id, {
      ...(existing ?? {
        id: recording.id,
        mode: recording.mode,
        startedAt: recording.startedAt,
        durationSeconds: Math.ceil(recording.durationMs / 1000),
        confirmedClose: recording.confirmedClose,
        fragments: [],
      }),
      recording,
    });
  }
  return Array.from(result.values()).sort((a, b) => b.startedAt - a.startedAt);
}
