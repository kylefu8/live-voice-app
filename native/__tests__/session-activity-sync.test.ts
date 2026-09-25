import {createSessionActivitySync} from '../src/session-activity-sync';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}
function bridge() {
  return {
    start: jest.fn(async () => true),
    update: jest.fn(async () => undefined),
    end: jest.fn(async () => undefined),
  };
}

test('connection callback publishes clock in the initial activity without a React render or later update', async () => {
  const native = bridge();
  const sync = createSessionActivitySync('session', 'zh', native);
  await sync.update({recording: true});
  expect(native.start).not.toHaveBeenCalled();
  await sync.update({status: 'connected', startedAt: 12345});
  expect(native.start).toHaveBeenCalledWith('session', 'zh', {
    status: 'connected', startedAt: 12345, muted: false, recording: true, backendWorking: false,
  });
  expect(native.update).not.toHaveBeenCalled();
  expect(sync.visible).toBe(true);
  await sync.end();
});

test('changes during activity creation publish only the latest complete snapshot', async () => {
  const native = bridge();
  const ready = deferred<boolean>();
  native.start.mockReturnValue(ready.promise);
  const sync = createSessionActivitySync('session', 'en', native);
  const start = sync.update({status: 'connected', startedAt: 12345});
  void sync.update({muted: true});
  void sync.update({backendWorking: true});
  ready.resolve(true);
  await start;
  expect(native.start).toHaveBeenCalledTimes(1);
  expect(native.update).toHaveBeenCalledTimes(1);
  expect(native.update).toHaveBeenCalledWith('session', expect.objectContaining({
    startedAt: 12345, status: 'connected', muted: true, backendWorking: true,
  }));
  await sync.update({status: 'connecting', startedAt: null});
  expect(native.update).toHaveBeenCalledTimes(1);
  await sync.end();
});

test('ending during creation removes the late activity and prevents later updates', async () => {
  const native = bridge();
  const ready = deferred<boolean>();
  native.start.mockReturnValue(ready.promise);
  const sync = createSessionActivitySync('session', 'en', native);
  const start = sync.update({status: 'connected', startedAt: 12345});
  const end = sync.end();
  ready.resolve(true);
  await Promise.all([start, end, sync.end()]);
  await sync.update({muted: true});
  expect(native.end).toHaveBeenCalledTimes(1);
  expect(native.update).not.toHaveBeenCalled();
  expect(sync.visible).toBe(false);
});

test('an unavailable activity can retry on foreground without disrupting the session', async () => {
  const native = bridge();
  native.start.mockResolvedValueOnce(false);
  const sync = createSessionActivitySync('session', 'en', native);
  await sync.update({status: 'connected', startedAt: 12345});
  expect(sync.visible).toBe(false);
  await sync.update({recording: false});
  await sync.update({recording: false});
  expect(native.start).toHaveBeenCalledTimes(1);
  await sync.resume();
  expect(sync.visible).toBe(true);
  expect(native.start).toHaveBeenLastCalledWith('session', 'en', expect.objectContaining({startedAt: 12345}));
  await sync.end();
});

test('closing a session that never connected does not create an activity', async () => {
  const native = bridge();
  const sync = createSessionActivitySync('session', 'en', native);
  await sync.update({status: 'closing'});
  await sync.end();
  expect(native.start).not.toHaveBeenCalled();
});
