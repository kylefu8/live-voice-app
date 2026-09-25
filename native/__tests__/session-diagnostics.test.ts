import {
  createSessionDiagnostics,
  type SessionDiagnosticSnapshot,
} from '../src/session-diagnostics';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return {promise, resolve};
}

function latest(writes: SessionDiagnosticSnapshot[]) {
  return writes[writes.length - 1];
}

test('keeps only enumerated numeric fields and no private values', async () => {
  const writes: SessionDiagnosticSnapshot[] = [];
  let clock = 100;
  const trace = createSessionDiagnostics(
    async snapshot => {
      writes.push(snapshot);
    },
    () => clock,
  );

  await trace.mark('connect_requested', {
    durationMs: 4.5,
    count: 2,
    apiKey: 'secret-value',
    endpoint: 'https://private.example',
  });
  clock = 125;
  await trace.sample({
    micFrames: 320,
    micPeak: 0.75,
    bytesSent: Infinity,
    packetsReceived: NaN,
    transcript: 'private text',
    apiKey: 'secret-value',
  });

  const snapshot = latest(writes);
  expect(snapshot.entries).toEqual([
    {type: 'mark', event: 'connect_requested', elapsedMs: 0, durationMs: 4.5, count: 2},
    {type: 'sample', elapsedMs: 25, micFrames: 320, micPeak: 0.75},
  ]);
  expect(JSON.stringify(snapshot)).not.toContain('secret-value');
  expect(JSON.stringify(snapshot)).not.toContain('private.example');
  expect(JSON.stringify(snapshot)).not.toContain('private text');
});

test('deduplicates first lifecycle marks and keeps bounded recent diagnostics', async () => {
  const writes: SessionDiagnosticSnapshot[] = [];
  let clock = 0;
  const trace = createSessionDiagnostics(
    async snapshot => {
      writes.push(snapshot);
    },
    () => clock,
  );

  await trace.mark('connect_requested');
  clock = 50;
  await trace.mark('connect_requested');
  expect(latest(writes).entries[0]).toEqual({
    type: 'mark',
    event: 'connect_requested',
    elapsedMs: 0,
  });

  for (let index = 0; index < 140; index += 1) {
    clock += 1;
    await trace.mark('backend_requested', {count: index});
  }
  for (let index = 0; index < 45; index += 1) {
    clock += 1;
    await trace.sample({micFrames: index + 1});
  }
  await trace.finish();

  const snapshot = latest(writes);
  const sampleEntries = snapshot.entries.filter(entry => entry.type === 'sample');
  const markEntries = snapshot.entries.filter(entry => entry.type === 'mark');
  expect(snapshot.entries.length).toBeLessThanOrEqual(120);
  expect(sampleEntries.length).toBeLessThanOrEqual(30);
  expect(markEntries.filter(entry => entry.event === 'backend_requested').length).toBeGreaterThan(0);
  expect(markEntries[0]).toEqual({
    type: 'mark',
    event: 'connect_requested',
    elapsedMs: 0,
  });
  expect(markEntries[markEntries.length - 1]).toEqual({
    type: 'mark',
    event: 'closed',
    elapsedMs: expect.any(Number),
  });
});

test('serializes writes, coalesces pending snapshots, and swallows writer failures', async () => {
  const writes: SessionDiagnosticSnapshot[] = [];
  const firstWrite = deferred<void>();
  const write = jest.fn(async (snapshot: SessionDiagnosticSnapshot) => {
    writes.push(snapshot);
    if (writes.length === 1) await firstWrite.promise;
    else if (writes.length === 2) throw new Error('diagnostic storage unavailable');
  });
  const trace = createSessionDiagnostics(write, () => 0);

  const first = trace.mark('connect_requested');
  const second = trace.mark('media_ready');
  const third = trace.mark('offer_ready');
  expect(write).toHaveBeenCalledTimes(1);
  firstWrite.resolve();
  await Promise.all([first, second, third]);

  expect(write).toHaveBeenCalledTimes(2);
  expect(writes[1].entries.map(entry => entry.type === 'mark' && entry.event)).toEqual([
    'connect_requested',
    'media_ready',
    'offer_ready',
  ]);

  // The rejected second write must not poison later calls.
  await trace.mark('answer_received');
  expect(write).toHaveBeenCalledTimes(3);
  expect(writes[2].entries.at(-1)).toEqual({
    type: 'mark',
    event: 'answer_received',
    elapsedMs: 0,
  });
});

test('uses elapsed local timestamps and stops after an idempotent finish', async () => {
  const writes: SessionDiagnosticSnapshot[] = [];
  let clock = 1000;
  const trace = createSessionDiagnostics(
    async snapshot => {
      writes.push(snapshot);
    },
    () => clock,
  );

  await trace.mark('connect_requested');
  clock = 1017;
  await trace.sample({firstCaptureMs: 12});
  clock = 1030;
  const finished = trace.finish();
  expect(trace.finish()).toBe(finished);
  await finished;
  const writeCount = writes.length;

  clock = 5000;
  await trace.mark('closed');
  await trace.sample({micFrames: 999});
  expect(writes).toHaveLength(writeCount);
  expect(latest(writes).entries).toEqual([
    {type: 'mark', event: 'connect_requested', elapsedMs: 0},
    {type: 'sample', elapsedMs: 17, firstCaptureMs: 12},
    {type: 'mark', event: 'closed', elapsedMs: 30},
  ]);
});
