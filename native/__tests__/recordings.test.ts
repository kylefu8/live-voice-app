jest.mock('react-native', () => ({
  NativeModules: {},
  Platform: { OS: 'android' },
}));
import { mergeRecordingHistory, recordingAvailable } from '../src/recordings';
import type { ConversationRecord, RecordingInfo } from '../src/types';
import {NativeModules, Platform} from 'react-native';

test.each(['ios', 'android'] as const)('%s exposes recordings only when the native bridge exists', platform => {
  const old = Platform.OS;
  Object.defineProperty(Platform, 'OS', {value: platform, configurable: true});
  NativeModules.VoiceRecording = {};
  expect(recordingAvailable()).toBe(true);
  delete NativeModules.VoiceRecording;
  expect(recordingAvailable()).toBe(false);
  Object.defineProperty(Platform, 'OS', {value: old, configurable: true});
});

test('recordings survive text-history eviction and join existing text without duplication', () => {
  const text: ConversationRecord = {
    id: 'new',
    mode: 'general',
    startedAt: 2000,
    durationSeconds: 4,
    confirmedClose: true,
    fragments: [
      { role: 'user', text: 'Synthetic text', startMs: 0, endMs: 400 },
    ],
  };
  const base: RecordingInfo = {
    id: 'old',
    mode: 'practice',
    startedAt: 1000,
    durationMs: 3100,
    sizeBytes: 2048,
    confirmedClose: true,
  };
  const records = mergeRecordingHistory(
    [text],
    [base, { ...base, id: 'new', startedAt: 2000 }],
  );
  expect(records.map(record => record.id)).toEqual(['new', 'old']);
  expect(records[0].fragments).toEqual(text.fragments);
  expect(records[1].fragments).toEqual([]);
  expect(records[1].recording).toEqual(base);
  expect(text.recording).toBeUndefined();
});

test('old text records remain readable when there is no recording module or file', () => {
  expect(recordingAvailable()).toBe(false);
  expect(mergeRecordingHistory([], [])).toEqual([]);
});
