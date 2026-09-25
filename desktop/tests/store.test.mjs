import assert from 'node:assert/strict';
import {createHash, createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {createStore} from '../store.mjs';

const key = createHash('sha256').update('desktop-store-test-key').digest();

function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
    },
    decryptString(value) {
      const iv = value.subarray(0, 12);
      const tag = value.subarray(value.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
}

function record(id, text = `message-${id}`) {
  return {
    id,
    mode: 'practice',
    startedAt: 1_700_000_000_000,
    durationSeconds: 4,
    confirmedClose: true,
    fragments: [{role: 'user', text, startMs: 0, endMs: 400}],
  };
}

async function withStore(callback) {
  const dataDir = await mkdtemp(join(tmpdir(), 'live-voice-store-'));
  try {
    return await callback(dataDir, safeStorage());
  } finally {
    await rm(dataDir, {recursive: true, force: true});
  }
}

test('credentials stay encrypted and voice/backend records remain isolated', async () => {
  await withStore(async (dataDir, secure) => {
    const store = await createStore({dataDir, safeStorage: secure});
    const voiceKey = 'voice-secret-12345';
    const backendKey = 'backend-secret-67890';
    assert.deepEqual(
      await store.saveConnection('voice', {
        endpoint: 'https://voice.example.test/v1/',
        model: 'gpt-live-1',
        auth: 'bearer',
        apiKey: voiceKey,
      }),
      {endpoint: 'https://voice.example.test/v1', model: 'gpt-live-1', auth: 'bearer', keyMask: 'voic••••••2345'},
    );
    await store.saveConnection('backend', {
      endpoint: 'https://backend.example.test/v1',
      model: 'reasoning-mini',
      auth: 'api-key',
      apiKey: backendKey,
    });
    const voiceFile = await readFile(join(dataDir, 'credentials.voice.bin'));
    const backendFile = await readFile(join(dataDir, 'credentials.backend.bin'));
    assert.equal(voiceFile.includes(voiceKey), false);
    assert.equal(backendFile.includes(backendKey), false);
    assert.equal(JSON.stringify(await store.loadConnections()).includes(voiceKey), false);
    assert.equal(JSON.stringify(await store.loadConnections()).includes(backendKey), false);
    assert.deepEqual((await store.getCredential('voice')).apiKey, voiceKey);
    assert.deepEqual((await store.getCredential('backend')).apiKey, backendKey);
    await store.dispose();
  });
});

test('audio device preferences migrate defaults, persist selected IDs and reject invalid fields', async () => {
  await withStore(async (dataDir, secure) => {
    const store=await createStore({dataDir,safeStorage:secure});
    const defaults=await store.loadSettings();
    assert.deepEqual(defaults.audio,{inputDeviceId:'',outputDeviceId:''});
    await store.saveSettings({...defaults,audio:{inputDeviceId:'synthetic-microphone',outputDeviceId:'synthetic-speaker',unknown:'drop'}});
    const restarted=await createStore({dataDir,safeStorage:secure});
    assert.deepEqual((await restarted.loadSettings()).audio,{inputDeviceId:'synthetic-microphone',outputDeviceId:'synthetic-speaker'});
    await store.saveSettings({...defaults,audio:{inputDeviceId:'a'.repeat(513),outputDeviceId:'bad\nvalue'}});
    assert.deepEqual((await store.loadSettings()).audio,{inputDeviceId:'',outputDeviceId:''});
  });
});

test('backend defaults enable search with 32768 tokens without changing saved choices', async () => {
  await withStore(async (dataDir, secure) => {
    const store = await createStore({dataDir, safeStorage: secure});
    const initial = await store.loadSettings();
    assert.equal(initial.backend.maxOutputTokens, 32768);
    assert.equal(initial.backend.webSearch, true);
    await store.saveSettings({...initial, backend: {...initial.backend, maxOutputTokens: 1024, webSearch: false}});
    const restarted = await createStore({dataDir, safeStorage: secure});
    const saved = await restarted.loadSettings();
    assert.equal(saved.backend.maxOutputTokens, 1024);
    assert.equal(saved.backend.webSearch, false);
    await restarted.dispose();
    await store.dispose();
  });
});

test('practice settings migrate to one general mode while old history remains readable', async () => {
  await withStore(async (dataDir, secure) => {
    const legacySettings = {
      locale: 'zh',
      theme: 'system',
      mode: 'practice',
      voice: {voice: 'marin', tone: 'natural', intonation: 'natural', pace: 'normal', minutes: 10, instructions: ''},
      backend: {enabled: false, effort: 'low', maxOutputTokens: 1024, webSearch: false, timeoutSeconds: 60, instructions: ''},
    };
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify(legacySettings), 'utf8');
    const store = await createStore({dataDir, safeStorage: secure});

    const settings = await store.loadSettings();
    assert.equal(settings.mode, 'general');
    const persisted = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'));
    assert.equal(persisted.mode, 'general');

    await store.saveHistory({record: record('legacy-practice')});
    const history = await store.loadHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].id, 'legacy-practice');
    assert.equal(history[0].mode, 'practice');
    await store.dispose();
  });
});

test('empty key reuses only the same endpoint and auth, with no partial overwrite', async () => {
  await withStore(async (dataDir, secure) => {
    const store = await createStore({dataDir, safeStorage: secure});
    await store.saveConnection('voice', {
      endpoint: 'https://voice.example.test/v1',
      model: 'gpt-live-1',
      auth: 'bearer',
      apiKey: 'original-secret',
    });
    const updated = await store.saveConnection('voice', {
      endpoint: 'https://voice.example.test/v1/',
      model: 'gpt-live-1-mini',
      auth: 'bearer',
      apiKey: '',
    });
    assert.equal(updated.model, 'gpt-live-1-mini');
    assert.equal((await store.getCredential('voice')).apiKey, 'original-secret');
    await assert.rejects(
      store.saveConnection('voice', {
        endpoint: 'https://other.example.test/v1',
        model: 'gpt-live-1',
        auth: 'bearer',
        apiKey: '',
      }),
      (error) => error.code === 'key_required',
    );
    assert.equal((await store.getCredential('voice')).endpoint, 'https://voice.example.test/v1');
  });
});

test('ordinary settings drop unknown credential-shaped fields and history writes are queued atomically', async () => {
  await withStore(async (dataDir, secure) => {
    const store = await createStore({dataDir, safeStorage: secure});
    await store.saveSettings({
      locale: 'en',
      theme: 'dark',
      mode: 'general',
      apiKey: 'must-not-persist',
      voice: {voice: 'marin', tone: 'warm', intonation: 'natural', pace: 'normal', minutes: 5, instructions: ''},
      backend: {enabled: false, effort: 'max', maxOutputTokens: 128, webSearch: false, timeoutSeconds: 10, instructions: '', apiKey: 'nested-secret'},
    });
    const settingsRaw = await readFile(join(dataDir, 'settings.json'), 'utf8');
    assert.equal(settingsRaw.includes('must-not-persist'), false);
    assert.equal(settingsRaw.includes('nested-secret'), false);
    assert.equal((await store.loadSettings()).backend.effort, 'max');

    await Promise.all(Array.from({length: 10}, (_, index) => store.saveHistory({record: record(`r-${index}`)})));
    const history = await store.loadHistory();
    assert.equal(history.length, 10);
    assert.equal(new Set(history.map((item) => item.id)).size, 10);
    const before = await readFile(join(dataDir, 'history.json'), 'utf8');
    await assert.rejects(
      store.saveHistory({record: {...record('bad'), fragments: [{role: 'system', text: 'x', startMs: 0, endMs: 1}]}}),
      (error) => error.code === 'storage_failed',
    );
    assert.equal(await readFile(join(dataDir, 'history.json'), 'utf8'), before);
  });
});

test('encryption unavailable fails closed without writing credentials', async () => {
  await withStore(async (dataDir) => {
    const secure = {isEncryptionAvailable: () => false};
    const store = await createStore({dataDir, safeStorage: secure});
    await assert.rejects(
      store.saveConnection('voice', {endpoint: 'https://voice.example.test', model: 'gpt-live-1', auth: 'bearer', apiKey: 'secret-key'}),
      (error) => error.code === 'encryption_unavailable',
    );
    await assert.rejects(store.getCredential('voice'), (error) => error.code === 'encryption_unavailable');
  });
});

test('history titles preserve legacy records, list order, and compare-and-set races', async () => {
  await withStore(async (dataDir, secure) => {
    const store = await createStore({dataDir, safeStorage: secure});
    await store.saveHistory({record: record('first', 'first turn')});
    await store.saveHistory({record: record('second', 'second turn')});
    assert.deepEqual((await store.loadHistory()).map(item => item.id), ['second', 'first']);

    await store.applyAutoHistoryTitle({id: 'first', title: '自动标题'});
    assert.deepEqual((await store.loadHistory()).map(item => item.id), ['second', 'first']);
    assert.equal((await store.loadHistory()).find(item => item.id === 'first').titleSource, 'auto');

    await store.renameHistory({id: 'first', title: '手动标题'});
    await store.applyAutoHistoryTitle({id: 'first', title: '迟到自动标题'});
    await store.saveHistory({record: record('first', 'duplicate save')});
    const renamed = await store.loadHistory();
    assert.deepEqual(renamed.map(item => item.id), ['second', 'first']);
    assert.equal(renamed.find(item => item.id === 'first').title, '手动标题');
    assert.equal(renamed.find(item => item.id === 'first').titleSource, 'manual');

    await store.deleteHistory({id: 'second'});
    await store.saveHistory({record: record('second', 'late duplicate')});
    const afterDelete = await store.loadHistory();
    assert.deepEqual(afterDelete.map(item => item.id), ['first']);
    await store.dispose();
  });
});

test('history mutations fail closed on damaged storage instead of overwriting it', async () => {
  await withStore(async (dataDir, secure) => {
    const store = await createStore({dataDir, safeStorage: secure});
    const path = join(dataDir, 'history.json');
    const damaged = '{not-json';
    await writeFile(path, damaged, 'utf8');
    await assert.rejects(
      store.saveHistory({record: record('should-not-overwrite')}),
      error => error.code === 'storage_failed',
    );
    assert.equal(await readFile(path, 'utf8'), damaged);
    await assert.rejects(store.deleteHistory({id: 'missing'}), error => error.code === 'storage_failed');
    assert.equal(await readFile(path, 'utf8'), damaged);
    await store.dispose();
  });
});
