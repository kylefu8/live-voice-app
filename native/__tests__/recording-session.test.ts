import { createRecordingSession } from '../src/recording-session';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
const meta = { id: 'synthetic', mode: 'general' as const, startedAt: 1000 };
const deps = () => ({
  markConnected: jest.fn(async (): Promise<void> => undefined),
  start: jest.fn(async (): Promise<void> => undefined),
  finish: jest.fn(async () => null),
  discard: jest.fn(async (): Promise<void> => undefined),
});

test('cancellation during native startup waits and discards without preserving failed conversations', async () => {
  const pending = deferred();
  const native = deps();
  native.start.mockReturnValue(pending.promise);
  const state = jest.fn();
  const session = createRecordingSession(meta, native, state);
  void session.start();
  const result = session.finish(false);
  expect(native.discard).not.toHaveBeenCalled();
  pending.resolve();
  await result;
  expect(native.discard).toHaveBeenCalledWith('synthetic');
  expect(native.finish).not.toHaveBeenCalled();
  expect(state).toHaveBeenLastCalledWith({
    id: 'synthetic',
    state: 'idle',
    code: undefined,
  });
});

test('close and background cleanup share a single finalization', async () => {
  const native = deps();
  const session = createRecordingSession(meta, native, jest.fn());
  await session.start();
  session.connected();
  await Promise.all([session.finish(true), session.finish(false)]);
  expect(native.finish).toHaveBeenCalledTimes(1);
  expect(native.finish).toHaveBeenCalledWith('synthetic', true);
  expect(native.markConnected).toHaveBeenCalledWith('synthetic');
});

test('a cancelled setup cannot start recording later', async () => {
  const native = deps();
  const session = createRecordingSession(meta, native, jest.fn());
  await session.finish(false);
  await session.start();
  session.connected();
  expect(native.start).not.toHaveBeenCalled();
  expect(native.markConnected).not.toHaveBeenCalled();
});

test('a connected session with no saved audio reports failure instead of a false success', async () => {
  const native = deps();
  const state = jest.fn();
  const session = createRecordingSession(meta, native, state);
  await session.start();
  session.connected();
  await session.finish(true);
  expect(state).toHaveBeenLastCalledWith({
    id: 'synthetic',
    state: 'error',
    code: 'recording_failed',
  });
});

test.each([
  ['recording_storage_full', 'recording_storage_full'],
  ['recording_destroyed', 'recording_failed'],
])(
  'native %s is surfaced without rejecting the voice startup',
  async (code, expected) => {
    const native = deps();
    native.start.mockRejectedValue(
      Object.assign(new Error('Native failure'), { code }),
    );
    const state = jest.fn();
    const session = createRecordingSession(meta, native, state);
    await expect(session.start()).resolves.toBeUndefined();
    session.connected();
    await session.finish(true);
    expect(state).toHaveBeenCalledWith({
      id: 'synthetic',
      state: 'error',
      code: expected,
    });
    expect(native.finish).not.toHaveBeenCalled();
  },
);
