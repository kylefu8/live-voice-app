import {
  createQrImporter,
  type QrImportDependencies,
  type QrImportState,
} from '../src/qr-import';
import type { Credential } from '../src/types';

const voice: Credential = {
  endpoint: 'https://voice.example.test/v1',
  model: 'gpt-live-1',
  auth: 'bearer',
  apiKey: 'synthetic-voice-secret-1234',
};
const backend: Credential = {
  endpoint: 'https://backend.example.test/v1',
  model: 'reasoning-model',
  auth: 'api-key',
  apiKey: 'synthetic-backend-secret-5678',
};
function harness(overrides: Partial<QrImportDependencies> = {}) {
  const states: QrImportState[] = [];
  const saved = {
    voice: {
      endpoint: voice.endpoint,
      model: voice.model,
      auth: voice.auth,
      keyMask: 'synt••••1234',
    },
    backend: {
      endpoint: backend.endpoint,
      model: backend.model,
      auth: backend.auth,
      keyMask: 'synt••••5678',
    },
  };
  const deps: QrImportDependencies = {
    scan: jest.fn(async () => 'synthetic-encrypted-payload'),
    decrypt: jest.fn(async () => ({
      version: 1 as const,
      connections: { voice, backend },
    })),
    cancelNative: jest.fn(async () => null),
    test: jest.fn(async () => undefined),
    save: jest.fn(async () => saved),
    onSaved: jest.fn(),
    ...overrides,
  };
  return {
    deps,
    states,
    importer: createQrImporter(deps, state => states.push(state)),
  };
}

test('requires review and successful tests of all selected connections before one save', async () => {
  const value = harness();
  await value.importer.scan('zh');
  expect(value.importer.phase).toBe('passphrase');
  await value.importer.decrypt('correct passphrase');
  expect(value.importer.phase).toBe('preview');
  expect(value.deps.test).not.toHaveBeenCalled();
  expect(value.deps.save).not.toHaveBeenCalled();
  expect(JSON.stringify(value.states)).not.toContain(voice.apiKey);
  expect(JSON.stringify(value.states)).not.toContain(backend.apiKey);
  await value.importer.testAndSave(['voice', 'backend']);
  expect(value.deps.test).toHaveBeenCalledTimes(2);
  expect(value.deps.save).toHaveBeenCalledTimes(1);
  expect(value.deps.onSaved).toHaveBeenCalledTimes(1);
  expect(value.states.at(-1)?.preview).toEqual({});
});

test('a failed second probe leaves all existing connections untouched', async () => {
  const value = harness({
    test: jest.fn(async kind => {
      if (kind === 'backend') throw new Error('backend_http_401');
    }),
  });
  await value.importer.scan('en');
  await value.importer.decrypt('pass');
  await value.importer.testAndSave(['voice', 'backend']);
  expect(value.deps.save).not.toHaveBeenCalled();
  expect(value.importer.phase).toBe('preview');
  expect(value.states.at(-1)?.errorCode).toBe('backend_http_401');
});

test('wrong passphrase can be retried and never leaks a native error', async () => {
  const decrypt = jest
    .fn()
    .mockRejectedValueOnce({
      code: 'decrypt_failed',
      message: 'private provider detail',
    })
    .mockResolvedValueOnce({ version: 1, connections: { voice } });
  const value = harness({ decrypt });
  await value.importer.scan('zh');
  await value.importer.decrypt('wrong');
  expect(value.importer.phase).toBe('passphrase');
  expect(JSON.stringify(value.states)).not.toContain('private provider detail');
  await value.importer.decrypt('correct');
  expect(value.importer.phase).toBe('preview');
});

test('cancelling a pending decrypt discards its late result', async () => {
  let resolve!: (value: any) => void;
  const value = harness({
    decrypt: jest.fn(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    ),
  });
  await value.importer.scan('zh');
  const pending = value.importer.decrypt('pass');
  value.importer.cancel();
  resolve({ version: 1, connections: { voice } });
  await pending;
  expect(value.importer.phase).toBe('idle');
  expect(value.states.at(-1)?.preview).toEqual({});
  expect(value.deps.save).not.toHaveBeenCalled();
});

test('cancelling a probe aborts network work and prevents saving its late success', async () => {
  let resolve!: () => void;
  let signal!: AbortSignal;
  const value = harness({
    test: jest.fn(async (_kind, _credential, currentSignal) => {
      signal = currentSignal;
      await new Promise<void>(done => {
        resolve = done;
      });
    }),
  });
  await value.importer.scan('zh');
  await value.importer.decrypt('pass');
  const pending = value.importer.testAndSave(['voice']);
  value.importer.cancel();
  expect(signal.aborted).toBe(true);
  resolve();
  await pending;
  expect(value.deps.save).not.toHaveBeenCalled();
});

test('selection limits both probes and the atomic import payload', async () => {
  const value = harness();
  await value.importer.scan('zh');
  await value.importer.decrypt('pass');
  await value.importer.testAndSave(['voice']);
  expect(value.deps.test).toHaveBeenCalledTimes(1);
  expect((value.deps.save as jest.Mock).mock.calls[0][0]).toEqual({ voice });
});

test('completion of an already committed atomic save remains authoritative after backgrounding', async () => {
  let finish!: (result: any) => void;
  const value = harness({
    save: jest.fn(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    ),
  });
  await value.importer.scan('zh');
  await value.importer.decrypt('pass');
  const pending = value.importer.testAndSave(['voice']);
  await Promise.resolve();
  expect(value.importer.phase).toBe('saving');
  value.importer.cancel();
  finish({ voice: null, backend: null });
  await pending;
  expect(value.deps.onSaved).toHaveBeenCalledTimes(1);
  expect(value.importer.phase).toBe('saved');
});
