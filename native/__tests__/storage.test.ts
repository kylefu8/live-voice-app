const mockAsyncStorageValues = new Map<string, string>();
const mockKeychainValues = new Map<string, string>();
const mockIosBundleWrite = jest.fn(async (_json: string) => undefined);
jest.mock('../src/ios-secure-connections', () => ({writeIosConnectionsBundle: mockIosBundleWrite}));

const mockAsyncStorageGetItem = jest.fn(async (key: string): Promise<string | null> => {
  return mockAsyncStorageValues.get(key) ?? null;
});
const mockAsyncStorageSetItem = jest.fn(async (key: string, value: string): Promise<void> => {
  mockAsyncStorageValues.set(key, value);
});

const mockGetGenericPassword = jest.fn(
  async (options: {service: string}): Promise<false | {username: string; password: string; service: string}> => {
    const password = mockKeychainValues.get(options.service);
    return password === undefined
      ? false
      : {username: 'credential', password, service: options.service};
  },
);
const mockSetGenericPassword = jest.fn(
  async (
    username: string,
    password: string,
    options: {service: string; storage?: string},
  ): Promise<{username: string; password: string; service: string}> => {
    mockKeychainValues.set(options.service, password);
    return {username, password, service: options.service};
  },
);

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: mockAsyncStorageGetItem,
    setItem: mockAsyncStorageSetItem,
  },
}));

jest.mock('react-native-keychain', () => ({
  STORAGE_TYPE: {AES_GCM_NO_AUTH: 'AES_GCM_NO_AUTH'},
  ACCESSIBLE: {WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly'},
  getGenericPassword: mockGetGenericPassword,
  setGenericPassword: mockSetGenericPassword,
}));

import type {
  Auth,
  ConversationRecord,
  Credential,
  Settings,
} from '../src/types';
import {Platform} from 'react-native';

const {
  getCredential,
  applyGeneratedRecordTitle,
  applyHistoryTitles,
  deleteRecord,
  loadConnections,
  loadHistory,
  loadSettings,
  renameRecord,
  saveImportedConnections,
  saveConnection,
  saveRecord,
  saveSettings,
} = require('../src/storage') as typeof import('../src/storage');

const SETTINGS_KEY = '@live-voice-app/settings/v1';
const HISTORY_KEY = '@live-voice-app/history/v1';
const HISTORY_TITLES_KEY = '@live-voice-app/history-titles/v1';
const VOICE_SERVICE = 'com.livevoiceapp.credential.voice';
const BACKEND_SERVICE = 'com.livevoiceapp.credential.backend';
const CONNECTIONS_SERVICE = 'com.livevoiceapp.connections.v2';

function connection(
  endpoint: string,
  model: string,
  auth: Auth = 'bearer',
): Omit<import('../src/types').Connection, 'keyMask'> {
  return {endpoint, model, auth};
}

function record(id: string, fragments: ConversationRecord['fragments'] = []): ConversationRecord {
  return {
    id,
    mode: 'practice',
    startedAt: 1_700_000_000_000,
    durationSeconds: 12,
    confirmedClose: true,
    fragments,
  };
}

beforeEach(() => {
  Object.defineProperty(Platform, 'OS', {value: 'android', configurable: true});
  mockIosBundleWrite.mockClear();
  mockAsyncStorageValues.clear();
  mockKeychainValues.clear();
  mockAsyncStorageGetItem.mockClear();
  mockAsyncStorageSetItem.mockClear();
  mockGetGenericPassword.mockClear();
  mockSetGenericPassword.mockClear();
  mockGetGenericPassword.mockImplementation(
    async (options: {service: string}): Promise<false | {username: string; password: string; service: string}> => {
      const password = mockKeychainValues.get(options.service);
      return password === undefined
        ? false
        : {username: 'credential', password, service: options.service};
    },
  );
  mockSetGenericPassword.mockImplementation(
    async (
      username: string,
      password: string,
      options: {service: string; storage?: string},
    ): Promise<{username: string; password: string; service: string}> => {
      mockKeychainValues.set(options.service, password);
      return {username, password, service: options.service};
    },
  );
});

test.each(['ios', 'android'] as const)('%s uses its own secure credential options', async platform => {
  const previous = Platform.OS;
  Object.defineProperty(Platform, 'OS', {value: platform, configurable: true});
  try {
    await saveConnection('voice', {endpoint: 'https://voice.example.test/v1', model: 'gpt-live-1', auth: 'bearer'}, 'synthetic-key');
    if (platform === 'ios') {
      expect(mockIosBundleWrite).toHaveBeenCalledTimes(1);
      expect(JSON.parse(mockIosBundleWrite.mock.calls[0][0])).toMatchObject({version: 2, connections: {voice: {model: 'gpt-live-1'}}});
      expect(mockSetGenericPassword).not.toHaveBeenCalled();
    } else {
      expect(mockSetGenericPassword.mock.calls.at(-1)?.[2]).toEqual({service: CONNECTIONS_SERVICE, storage: 'AES_GCM_NO_AUTH'});
      expect(mockIosBundleWrite).not.toHaveBeenCalled();
    }
  } finally {
    Object.defineProperty(Platform, 'OS', {value: previous, configurable: true});
  }
});

describe('secure connection storage', () => {
  test('keeps voice and backend credentials isolated and masks public keys', async () => {
    const voiceKey = 'voice-key-12345';
    const backendKey = 'backend-key-67890';

    const voice = await saveConnection(
      'voice',
      connection('https://voice.example/v1', 'gpt-live-1'),
      voiceKey,
    );
    const backend = await saveConnection(
      'backend',
      connection('https://backend.example/v1', 'synthetic-backend'),
      backendKey,
    );

    expect(voice).toEqual({
      endpoint: 'https://voice.example/v1',
      model: 'gpt-live-1',
      auth: 'bearer',
      keyMask: 'voic••••••2345',
    });
    expect(backend).toEqual({
      endpoint: 'https://backend.example/v1',
      model: 'synthetic-backend',
      auth: 'bearer',
      keyMask: 'back••••••7890',
    });

    expect(await getCredential('voice')).toEqual({
      endpoint: 'https://voice.example/v1',
      model: 'gpt-live-1',
      auth: 'bearer',
      apiKey: voiceKey,
    });
    expect(await getCredential('backend')).toEqual({
      endpoint: 'https://backend.example/v1',
      model: 'synthetic-backend',
      auth: 'bearer',
      apiKey: backendKey,
    });
    expect(mockKeychainValues.has(CONNECTIONS_SERVICE)).toBe(true);
    expect(mockKeychainValues.has(VOICE_SERVICE)).toBe(false);
    expect(mockKeychainValues.has(BACKEND_SERVICE)).toBe(false);
    expect(mockAsyncStorageValues.size).toBe(0);

    expect(JSON.parse(mockKeychainValues.get(CONNECTIONS_SERVICE)!)).toEqual({
      version: 2,
      connections: {
        voice: {
          endpoint: 'https://voice.example/v1',
          model: 'gpt-live-1',
          auth: 'bearer',
          apiKey: voiceKey,
        },
        backend: {
          endpoint: 'https://backend.example/v1',
          model: 'synthetic-backend',
          auth: 'bearer',
          apiKey: backendKey,
        },
      },
    });

    const publicConnections = await loadConnections();
    expect(JSON.stringify(publicConnections)).not.toContain(voiceKey);
    expect(JSON.stringify(publicConnections)).not.toContain(backendKey);
  });

  test('fully masks a short key instead of exposing any characters', async () => {
    const saved = await saveConnection(
      'voice',
      connection('https://voice.example/v1', 'gpt-live-1'),
      'shortkey',
    );

    expect(saved.keyMask).toBe('••••••••');
    expect(JSON.stringify(saved)).not.toContain('shortkey');
  });

  test('reads manual credentials back even when their key resembles a mask', async () => {
    const saved = await saveConnection(
      'voice',
      connection('https://voice.example/v1', 'gpt-live-1'),
      'secret*key',
    );

    expect(saved.keyMask).toBe('secr••••••*key');
    expect(await getCredential('voice')).toEqual({
      endpoint: 'https://voice.example/v1',
      model: 'gpt-live-1',
      auth: 'bearer',
      apiKey: 'secret*key',
    });
    expect(await loadConnections()).toEqual({voice: saved, backend: null});
  });

  test('rejects endpoint or auth changes without a new key and preserves the credential', async () => {
    const original = connection('https://voice.example/v1', 'gpt-live-1', 'bearer');
    const originalCredential: Credential = {...original, apiKey: 'original-key-123'};
    await saveConnection('voice', original, originalCredential.apiKey);
    const writesBeforeChanges = mockSetGenericPassword.mock.calls.length;

    await expect(
      saveConnection('voice', connection('https://other.example/v1', 'gpt-live-1', 'bearer')),
    ).rejects.toThrow('key_required');
    await expect(
      saveConnection('voice', connection('https://voice.example/v1', 'gpt-live-1', 'api-key')),
    ).rejects.toThrow('key_required');

    expect(await getCredential('voice')).toEqual(originalCredential);
    expect(mockSetGenericPassword).toHaveBeenCalledTimes(writesBeforeChanges);
  });

  test('reports Keychain read failures as storage_failed instead of an unconfigured credential', async () => {
    mockGetGenericPassword.mockRejectedValueOnce(new Error('synthetic keystore failure'));

    await expect(getCredential('voice')).rejects.toThrow('storage_failed');
    expect(await Promise.resolve(mockKeychainValues.get(VOICE_SERVICE))).toBeUndefined();
  });

  test('reports Keychain write failures as storage_failed without falling back to AsyncStorage', async () => {
    mockSetGenericPassword.mockRejectedValueOnce(new Error('synthetic keystore failure'));

    await expect(
      saveConnection(
        'backend',
        connection('https://backend.example/v1', 'synthetic-backend'),
        'backend-key-12345',
      ),
    ).rejects.toThrow('storage_failed');
    expect(mockKeychainValues.has(BACKEND_SERVICE)).toBe(false);
    expect(mockAsyncStorageValues.size).toBe(0);
  });

  test('reads legacy entries when v2 is absent and migrates both sides on the next save', async () => {
    const voice: Credential = {
      endpoint: 'https://voice.example/v1',
      model: 'gpt-live-1',
      auth: 'bearer',
      apiKey: 'legacy-voice-key',
    };
    const backend: Credential = {
      endpoint: 'https://backend.example/v1',
      model: 'legacy-backend',
      auth: 'api-key',
      apiKey: 'legacy-backend-key',
    };
    mockKeychainValues.set(VOICE_SERVICE, JSON.stringify(voice));
    mockKeychainValues.set(BACKEND_SERVICE, JSON.stringify(backend));

    expect(await getCredential('voice')).toEqual(voice);
    expect(await loadConnections()).toEqual({
      voice: {
        endpoint: voice.endpoint,
        model: voice.model,
        auth: voice.auth,
        keyMask: 'lega••••••-key',
      },
      backend: {
        endpoint: backend.endpoint,
        model: backend.model,
        auth: backend.auth,
        keyMask: 'lega••••••-key',
      },
    });

    await saveConnection(
      'voice',
      connection(voice.endpoint, 'gpt-live-1'),
    );

    expect(JSON.parse(mockKeychainValues.get(CONNECTIONS_SERVICE)!)).toEqual({
      version: 2,
      connections: {voice, backend},
    });
  });

  test('imports one or both sides atomically, preserving QR model and key strings', async () => {
    const existingBackend: Credential = {
      endpoint: 'https://backend.example/v1',
      model: 'existing-backend',
      auth: 'bearer',
      apiKey: 'existing-backend-key',
    };
    await saveImportedConnections({backend: existingBackend});
    mockSetGenericPassword.mockClear();

    const importedVoice: Credential = {
      endpoint: 'https://voice.example/v1/',
      model: ' gpt-live-1 ',
      auth: 'api-key',
      apiKey: ' voice-key-with-spaces ',
    };
    const oneSide = await saveImportedConnections({voice: importedVoice});
    expect(oneSide).toEqual({
      voice: {
        endpoint: 'https://voice.example/v1',
        model: ' gpt-live-1 ',
        auth: 'api-key',
        keyMask: ' voi••••••ces ',
      },
      backend: {
        endpoint: existingBackend.endpoint,
        model: existingBackend.model,
        auth: existingBackend.auth,
        keyMask: 'exis••••••-key',
      },
    });
    expect(mockSetGenericPassword).toHaveBeenCalledTimes(1);
    expect(await getCredential('voice')).toEqual({
      ...importedVoice,
      endpoint: 'https://voice.example/v1',
    });

    const importedBackend: Credential = {
      endpoint: 'https://other-backend.example/v1',
      model: 'backend-model',
      auth: 'bearer',
      apiKey: 'backend-key',
    };
    const both = await saveImportedConnections({
      voice: importedVoice,
      backend: importedBackend,
    });
    expect(both.voice?.model).toBe(' gpt-live-1 ');
    expect(both.backend?.endpoint).toBe(importedBackend.endpoint);
    expect(mockSetGenericPassword).toHaveBeenCalledTimes(2);
  });

  test('counts imported Unicode code points and preserves valid non-BMP strings', async () => {
    const model = '😀'.repeat(256);
    const apiKey = '🔑'.repeat(4_096);

    await saveImportedConnections({
      voice: {
        endpoint: 'https://voice.example/v1',
        model,
        auth: 'bearer',
        apiKey,
      },
    });

    expect(await getCredential('voice')).toEqual({
      endpoint: 'https://voice.example/v1',
      model,
      auth: 'bearer',
      apiKey,
    });
    await expect(
      saveImportedConnections({
        voice: {
          endpoint: 'https://voice.example/v1',
          model: `${model}😀`,
          auth: 'bearer',
          apiKey,
        },
      }),
    ).rejects.toThrow('invalid_model');
  });

  test('rejects imported C1 controls, unpaired surrogates, and masked keys', async () => {
    const base: Credential = {
      endpoint: 'https://voice.example/v1',
      model: 'gpt-live-1',
      auth: 'bearer',
      apiKey: 'synthetic-key-1234',
    };

    await expect(
      saveImportedConnections({voice: {...base, model: 'gpt\u0085live'}}),
    ).rejects.toThrow('invalid_model');
    await expect(
      saveImportedConnections({voice: {...base, model: `gpt${String.fromCharCode(0xd800)}live`}}),
    ).rejects.toThrow('invalid_model');
    await expect(
      saveImportedConnections({voice: {...base, apiKey: 'secret\u009fkey'}}),
    ).rejects.toThrow('key_required');
    await expect(
      saveImportedConnections({voice: {...base, apiKey: `secret${String.fromCharCode(0xdc00)}key`}}),
    ).rejects.toThrow('key_required');
    await expect(
      saveImportedConnections({voice: {...base, apiKey: 'sk-...1234'}}),
    ).rejects.toThrow('key_required');
  });

  test('fails closed on a corrupt v2 bundle without falling back to legacy values', async () => {
    mockKeychainValues.set(CONNECTIONS_SERVICE, '{"version":2,"connections":null}');
    mockKeychainValues.set(
      VOICE_SERVICE,
      JSON.stringify({
        endpoint: 'https://legacy.example/v1',
        model: 'legacy',
        auth: 'bearer',
        apiKey: 'legacy-key',
      }),
    );

    await expect(loadConnections()).rejects.toThrow('storage_failed');
    await expect(getCredential('voice')).rejects.toThrow('storage_failed');
  });

  test('failed atomic write retains both previously committed credentials', async () => {
    const previous: Record<'voice' | 'backend', Credential> = {
      voice: {
        endpoint: 'https://voice.example/v1',
        model: 'voice-old',
        auth: 'bearer',
        apiKey: 'voice-old-key',
      },
      backend: {
        endpoint: 'https://backend.example/v1',
        model: 'backend-old',
        auth: 'bearer',
        apiKey: 'backend-old-key',
      },
    };
    await saveImportedConnections(previous);
    const before = mockKeychainValues.get(CONNECTIONS_SERVICE);
    mockSetGenericPassword.mockRejectedValueOnce(new Error('synthetic failure'));

    await expect(
      saveImportedConnections({
        voice: {...previous.voice, model: 'voice-new'},
      }),
    ).rejects.toThrow('storage_failed');
    expect(mockKeychainValues.get(CONNECTIONS_SERVICE)).toBe(before);
    expect(await getCredential('voice')).toEqual(previous.voice);
    expect(await getCredential('backend')).toEqual(previous.backend);
  });

  test('serializes concurrent manual and import writes against the latest bundle', async () => {
    const initial: Record<'voice' | 'backend', Credential> = {
      voice: {
        endpoint: 'https://voice.example/v1',
        model: 'voice-old',
        auth: 'bearer',
        apiKey: 'voice-old-key',
      },
      backend: {
        endpoint: 'https://backend.example/v1',
        model: 'backend-old',
        auth: 'bearer',
        apiKey: 'backend-old-key',
      },
    };
    await saveImportedConnections(initial);
    mockSetGenericPassword.mockClear();

    await Promise.all([
      saveConnection(
        'voice',
        connection('https://voice.example/v1', 'voice-manual'),
        'voice-manual-key',
      ),
      saveImportedConnections({
        backend: {...initial.backend, model: 'backend-imported'},
      }),
    ]);

    expect(await getCredential('voice')).toEqual({
      ...initial.voice,
      model: 'voice-manual',
      apiKey: 'voice-manual-key',
    });
    expect(await getCredential('backend')).toEqual({
      ...initial.backend,
      model: 'backend-imported',
    });
    expect(mockSetGenericPassword).toHaveBeenCalledTimes(2);
  });

  test('aborted import before queued work makes no read or write and preserves the bundle', async () => {
    const initial: Record<'voice' | 'backend', Credential> = {
      voice: {
        endpoint: 'https://voice.example/v1',
        model: 'voice',
        auth: 'bearer',
        apiKey: 'voice-key',
      },
      backend: {
        endpoint: 'https://backend.example/v1',
        model: 'backend',
        auth: 'bearer',
        apiKey: 'backend-key',
      },
    };
    await saveImportedConnections(initial);
    const before = mockKeychainValues.get(CONNECTIONS_SERVICE);
    mockGetGenericPassword.mockClear();
    mockSetGenericPassword.mockClear();
    const controller = new AbortController();
    controller.abort();

    await expect(
      saveImportedConnections({voice: initial.voice}, controller.signal),
    ).rejects.toThrow('operation_cancelled');
    expect(mockGetGenericPassword).not.toHaveBeenCalled();
    expect(mockSetGenericPassword).not.toHaveBeenCalled();
    expect(mockKeychainValues.get(CONNECTIONS_SERVICE)).toBe(before);
  });
});

describe('ordinary settings storage', () => {
  test('new installs use the requested backend defaults and recording remains opt-out', async () => {
    const initial = await loadSettings();
    expect(initial.backend).toMatchObject({maxOutputTokens: 32768, webSearch: true});
    expect(initial.recordingEnabled).toBe(true);
    const previous = {...initial, backend: {...initial.backend, maxOutputTokens: 1024, webSearch: false}};
    const {recordingEnabled: _removed, ...legacy} = previous;
    mockAsyncStorageValues.set(SETTINGS_KEY, JSON.stringify(legacy));
    expect(await loadSettings()).toEqual(previous);
    await saveSettings({...previous, recordingEnabled: false});
    expect(await loadSettings()).toEqual({...previous, recordingEnabled: false});
    await saveSettings({...previous, recordingEnabled: true});
    expect((await loadSettings()).recordingEnabled).toBe(true);
  });
  test('normalizes legacy practice settings without changing preferences or history', async () => {
    const initial = await loadSettings();
    const legacy = {...initial, mode: 'practice', locale: 'en', theme: 'dark',
      backend: {...initial.backend, maxOutputTokens: 32768, effort: 'max'},
      voice: {...initial.voice, instructions: 'Keep my style.'}};
    const oldRecord = record('legacy-practice', [{role: 'user', text: 'Synthetic history.', startMs: 0, endMs: 100}]);
    await saveRecord(oldRecord);
    const historyBefore = mockAsyncStorageValues.get(HISTORY_KEY);
    mockAsyncStorageValues.set(SETTINGS_KEY, JSON.stringify(legacy));
    expect(await loadSettings()).toEqual({...legacy, mode: 'general'});
    await saveSettings(legacy as Settings);
    expect(JSON.parse(mockAsyncStorageValues.get(SETTINGS_KEY)!)).toEqual({...legacy, mode: 'general'});
    expect(await loadHistory()).toEqual([oldRecord]);
    expect(mockAsyncStorageValues.get(HISTORY_KEY)).toBe(historyBefore);
  });
  test('drops unknown fields so credentials cannot enter AsyncStorage', async () => {
    const unsafeSettings = {
      locale: 'en',
      theme: 'dark',
      mode: 'general',
      apiKey: 'top-level-secret',
      credential: {apiKey: 'nested-secret'},
      voice: {
        voice: 'marin',
        tone: 'warm',
        intonation: 'expressive',
        pace: 'brisk',
        minutes: 5,
        instructions: 'Be conversational.',
        apiKey: 'voice-secret',
      },
      backend: {
        enabled: true,
        effort: 'max',
        maxOutputTokens: 128,
        webSearch: false,
        timeoutSeconds: 10,
        instructions: 'Answer briefly.',
        key: 'backend-secret',
      },
    } as unknown as Settings;

    await saveSettings(unsafeSettings);

    const raw = mockAsyncStorageValues.get(SETTINGS_KEY);
    expect(raw).toBeDefined();
    expect(raw).not.toContain('top-level-secret');
    expect(raw).not.toContain('nested-secret');
    expect(raw).not.toContain('voice-secret');
    expect(raw).not.toContain('backend-secret');
    expect(await loadSettings()).toEqual({
      locale: 'en',
      theme: 'dark',
      mode: 'general',
      recordingEnabled: true,
      voice: {
        voice: 'marin',
        tone: 'warm',
        intonation: 'expressive',
        pace: 'brisk',
        minutes: 5,
        instructions: 'Be conversational.',
      },
      backend: {
        enabled: true,
        effort: 'max',
        maxOutputTokens: 128,
        webSearch: false,
        timeoutSeconds: 10,
        instructions: 'Answer briefly.',
      },
    });
  });
});

describe('history storage', () => {
  test('does not overwrite existing history when a new record is invalid or oversized', async () => {
    const existing = record('existing', [
      {role: 'user', text: 'Keep this record.', startMs: 0, endMs: 400},
    ]);
    await saveRecord(existing);
    const rawBefore = mockAsyncStorageValues.get(HISTORY_KEY);

    const invalid = {
      ...record('invalid'),
      fragments: [{role: 'system', text: 'invalid', startMs: 0, endMs: 100}],
    } as unknown as ConversationRecord;
    await expect(saveRecord(invalid)).rejects.toThrow('storage_failed');
    expect(await loadHistory()).toEqual([existing]);
    expect(mockAsyncStorageValues.get(HISTORY_KEY)).toBe(rawBefore);

    const oversized = record(
      'oversized',
      Array.from({length: 20}, (_, index) => ({
        role: 'assistant' as const,
        text: 'x'.repeat(16_000),
        startMs: index * 100,
        endMs: index * 100 + 50,
      })),
    );
    await expect(saveRecord(oversized)).rejects.toThrow('storage_failed');
    expect(await loadHistory()).toEqual([existing]);
    expect(mockAsyncStorageValues.get(HISTORY_KEY)).toBe(rawBefore);
  });

  test('keeps a manual title when a later save updates the same record', async () => {
    const initial = record('manual-title', [
      {role: 'user', text: 'Synthetic topic.', startMs: 0, endMs: 100},
    ]);
    await saveRecord(initial);
    expect(await renameRecord(initial.id, '我的会话')).toBe(true);

    await saveRecord({...initial, durationSeconds: 30, fragments: [
      {role: 'user', text: 'Updated transcript.', startMs: 0, endMs: 200},
    ]});

    expect(await loadHistory()).toEqual([{
      ...initial,
      durationSeconds: 30,
      fragments: [{role: 'user', text: 'Updated transcript.', startMs: 0, endMs: 200}],
      title: '我的会话',
      titleSource: 'manual',
    }]);
    expect(JSON.parse(mockAsyncStorageValues.get(HISTORY_TITLES_KEY)!)).toEqual({
      version: 1,
      entries: {'manual-title': {title: '我的会话', source: 'manual'}},
    });
  });

  test('applies generated titles with compare-and-set and manual rename wins', async () => {
    const item = record('title-cas', [
      {role: 'user', text: 'Synthetic topic.', startMs: 0, endMs: 100},
    ]);
    await saveRecord(item);

    const generated = await Promise.all([
      applyGeneratedRecordTitle(item.id, 'First generated title'),
      applyGeneratedRecordTitle(item.id, 'Second generated title'),
    ]);
    expect(generated.filter(Boolean)).toHaveLength(1);
    expect(await renameRecord(item.id, '手动标题')).toBe(true);
    expect(await applyGeneratedRecordTitle(item.id, 'Late generated title')).toBe(false);
    expect((await loadHistory())[0]).toMatchObject({
      title: '手动标题',
      titleSource: 'manual',
    });
  });

  test('keeps an audio-only title after text history rolls past fifty records', async () => {
    const audioText = record('audio-title', [
      {role: 'user', text: 'Keep this title.', startMs: 0, endMs: 100},
    ]);
    await saveRecord(audioText);
    expect(await applyGeneratedRecordTitle(audioText.id, '保留的自动标题')).toBe(true);

    for (let index = 0; index < 50; index += 1) {
      await saveRecord(record(`new-${index}`, [
        {role: 'user', text: `New ${index}`, startMs: 0, endMs: 100},
      ]));
    }

    expect((await loadHistory()).some(item => item.id === audioText.id)).toBe(false);
    const audioOnly = {...audioText, fragments: []};
    expect(await applyHistoryTitles([audioOnly])).toEqual([{
      ...audioOnly,
      title: '保留的自动标题',
      titleSource: 'auto',
    }]);
  });

  test('requires an existing audio item before naming a textless record', async () => {
    const audioOnly = record('audio-only-title');
    expect(await applyGeneratedRecordTitle(audioOnly.id, 'No audio')).toBe(false);
    expect(await applyGeneratedRecordTitle(audioOnly.id, 'Audio title', async () => true)).toBe(true);
    expect(await applyHistoryTitles([audioOnly])).toEqual([{
      ...audioOnly,
      title: 'Audio title',
      titleSource: 'auto',
    }]);
    expect(await renameRecord('missing-audio', 'No audio', async () => false)).toBe(false);
  });

  test('deletes text and metadata and blocks late saves or title responses', async () => {
    const item = record('delete-race', [
      {role: 'user', text: 'Delete me.', startMs: 0, endMs: 100},
    ]);
    await saveRecord(item);
    expect(await applyGeneratedRecordTitle(item.id, 'To be deleted')).toBe(true);
    await deleteRecord(item.id);

    expect(await loadHistory()).toEqual([]);
    expect(JSON.parse(mockAsyncStorageValues.get(HISTORY_TITLES_KEY)!)).toEqual({
      version: 1,
      entries: {},
    });
    expect(await applyGeneratedRecordTitle(item.id, 'Late title')).toBe(false);
    expect(await renameRecord(item.id, 'Late manual title')).toBe(false);
    await saveRecord(item);
    expect(await loadHistory()).toEqual([]);
  });

  test('does not clear corrupt history while renaming or deleting', async () => {
    const corrupt = '{not-json';
    mockAsyncStorageValues.set(HISTORY_KEY, corrupt);

    await expect(renameRecord('corrupt-history', 'Title')).rejects.toThrow('storage_failed');
    await expect(deleteRecord('corrupt-history')).rejects.toThrow('storage_failed');
    expect(mockAsyncStorageValues.get(HISTORY_KEY)).toBe(corrupt);
  });

  test('keeps committed history when a title read or write fails', async () => {
    const item = record('title-failure', [
      {role: 'user', text: 'Keep me.', startMs: 0, endMs: 100},
    ]);
    await saveRecord(item);
    const historyBefore = mockAsyncStorageValues.get(HISTORY_KEY);

    mockAsyncStorageGetItem.mockRejectedValueOnce(new Error('synthetic title read failure'));
    await expect(renameRecord(item.id, 'New title')).rejects.toThrow('storage_failed');
    expect(mockAsyncStorageValues.get(HISTORY_KEY)).toBe(historyBefore);

    mockAsyncStorageSetItem.mockRejectedValueOnce(new Error('synthetic title write failure'));
    await expect(renameRecord(item.id, 'New title')).rejects.toThrow('storage_failed');
    expect(mockAsyncStorageValues.get(HISTORY_KEY)).toBe(historyBefore);
    expect(await loadHistory()).toEqual([item]);
  });

  test('keeps the record visible when delete text storage fails and allows retry', async () => {
    const item = record('delete-write-failure', [
      {role: 'user', text: 'Retry delete.', startMs: 0, endMs: 100},
    ]);
    await saveRecord(item);
    expect(await renameRecord(item.id, 'Retry title')).toBe(true);
    const historyBefore = mockAsyncStorageValues.get(HISTORY_KEY);
    const titlesBefore = mockAsyncStorageValues.get(HISTORY_TITLES_KEY);

    mockAsyncStorageSetItem.mockRejectedValueOnce(new Error('synthetic delete failure'));
    await expect(deleteRecord(item.id)).rejects.toThrow('storage_failed');
    expect(mockAsyncStorageValues.get(HISTORY_KEY)).toBe(historyBefore);
    expect(mockAsyncStorageValues.get(HISTORY_TITLES_KEY)).toBe(titlesBefore);
    expect(await loadHistory()).toEqual([{...item, title: 'Retry title', titleSource: 'manual'}]);

    await deleteRecord(item.id);
    expect(await loadHistory()).toEqual([]);
  });

  test('restores text when title cleanup fails and permits a later delete retry', async () => {
    const item = record('delete-title-failure', [
      {role: 'user', text: 'Restore me.', startMs: 0, endMs: 100},
    ]);
    await saveRecord(item);
    expect(await renameRecord(item.id, 'Restore title')).toBe(true);
    const historyBefore = mockAsyncStorageValues.get(HISTORY_KEY);
    const titlesBefore = mockAsyncStorageValues.get(HISTORY_TITLES_KEY);

    mockAsyncStorageSetItem
      .mockImplementationOnce(async (key: string, value: string) => {
        mockAsyncStorageValues.set(key, value);
      })
      .mockRejectedValueOnce(new Error('synthetic title cleanup failure'));
    await expect(deleteRecord(item.id)).rejects.toThrow('storage_failed');
    expect(mockAsyncStorageValues.get(HISTORY_KEY)).toBe(historyBefore);
    expect(mockAsyncStorageValues.get(HISTORY_TITLES_KEY)).toBe(titlesBefore);
    expect(await loadHistory()).toEqual([{...item, title: 'Restore title', titleSource: 'manual'}]);

    await deleteRecord(item.id);
    expect(await loadHistory()).toEqual([]);
  });

  test('tombstones the id when title cleanup and text restoration both fail', async () => {
    const item = record('delete-restore-failure', [
      {role: 'user', text: 'Cannot restore.', startMs: 0, endMs: 100},
    ]);
    await saveRecord(item);
    expect(await renameRecord(item.id, 'Blocked title')).toBe(true);

    mockAsyncStorageSetItem
      .mockImplementationOnce(async (key: string, value: string) => {
        mockAsyncStorageValues.set(key, value);
      })
      .mockRejectedValueOnce(new Error('synthetic title cleanup failure'))
      .mockRejectedValueOnce(new Error('synthetic text restoration failure'));
    await expect(deleteRecord(item.id)).rejects.toThrow('storage_failed');

    await saveRecord(item);
    expect(await loadHistory()).toEqual([]);
    expect(await applyGeneratedRecordTitle(item.id, 'Late generated title')).toBe(false);
  });

  test('treats special record IDs as data keys rather than object prototypes', async () => {
    const item = record('__proto__', [
      {role: 'user', text: 'Prototype-safe.', startMs: 0, endMs: 100},
    ]);
    await saveRecord(item);
    expect(await renameRecord(item.id, 'Prototype title')).toBe(true);
    expect((await loadHistory())[0]).toMatchObject({
      id: '__proto__',
      title: 'Prototype title',
      titleSource: 'manual',
    });
    await deleteRecord(item.id);
    expect(await loadHistory()).toEqual([]);
  });

  test('serializes save, rename, and delete without resurrecting a deleted record', async () => {
    const item = record('write-race', [
      {role: 'user', text: 'Race me.', startMs: 0, endMs: 100},
    ]);
    await saveRecord(item);
    await Promise.all([
      saveRecord({...item, durationSeconds: 20}),
      renameRecord(item.id, 'Race title'),
      deleteRecord(item.id),
    ]);
    expect(await loadHistory()).toEqual([]);
    expect(await applyHistoryTitles([item])).toEqual([]);
  });
});
