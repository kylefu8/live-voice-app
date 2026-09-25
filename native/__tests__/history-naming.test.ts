import {createHistoryNaming} from '../src/history-naming';
import type {ConversationRecord, Credential} from '../src/types';

const record: ConversationRecord = {id: 'synthetic-title', mode: 'general', startedAt: 1, durationSeconds: 1, confirmedClose: true,
  fragments: [{role: 'user', text: 'Weekend plans', startMs: 0, endMs: 1}]};
const credential: Credential = {endpoint: 'https://example.test/v1', auth: 'bearer', apiKey: 'synthetic', model: 'synthetic'};

test.each(['cancel', 'cancelAll'] as const)('%s ignores a late provider response', async action => {
  let resolve!: (title: string) => void;
  const apply = jest.fn(async () => true);
  const job = createHistoryNaming({generate: () => new Promise(r => {resolve = r;}), apply, onUpdated: jest.fn()});
  const pending = job.start(record, credential, 'en');
  if (action === 'cancel') job.cancel(record.id); else job.cancelAll();
  resolve('Weekend plans');
  await pending;
  expect(apply).not.toHaveBeenCalled();
});

test('storage compare-and-set refusal does not publish stale UI or fail session finalization', async () => {
  const onUpdated = jest.fn();
  const apply = jest.fn(async () => false);
  const job = createHistoryNaming({generate: async () => 'Weekend plans', apply, onUpdated});
  await job.start(record, credential, 'en');
  expect(apply).toHaveBeenCalledWith(record.id, 'Weekend plans');
  expect(onUpdated).not.toHaveBeenCalled();
  const failing = createHistoryNaming({generate: async () => {throw Error('failed');}, apply, onUpdated});
  await expect(failing.start(record, credential, 'en')).resolves.toBeUndefined();
});
