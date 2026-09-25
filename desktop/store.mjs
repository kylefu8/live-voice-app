import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {normalizeHistoryTitle} from '../native/src/history-title.ts';

const MAX_HISTORY_RECORDS = 50;
const MAX_HISTORY_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_FRAGMENTS_PER_RECORD = 500;
const MAX_TEXT_LENGTH = 16_000;
const MAX_INSTRUCTIONS_LENGTH = 8_000;
const MAX_MODEL_LENGTH = 256;
const MAX_KEY_LENGTH = 4_096;

const DEFAULT_SETTINGS = Object.freeze({
  locale: 'zh',
  theme: 'system',
  // The desktop client now has one conversation mode. Keep the field in the
  // persisted shape for compatibility with older clients and records.
  mode: 'general',
  audio: Object.freeze({inputDeviceId: '', outputDeviceId: ''}),
  voice: Object.freeze({
    voice: 'marin',
    tone: 'natural',
    intonation: 'natural',
    pace: 'normal',
    minutes: 10,
    instructions: '',
  }),
  backend: Object.freeze({
    enabled: false,
    effort: 'low',
    maxOutputTokens: 32768,
    webSearch: true,
    timeoutSeconds: 60,
    instructions: '',
  }),
});

export class StoreError extends Error {
  constructor(code) {
    super(code);
    this.name = 'StoreError';
    this.code = code;
  }
}

function fail(code) {
  throw new StoreError(code);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isString(value) {
  return typeof value === 'string';
}

function isBoolean(value) {
  return typeof value === 'boolean';
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function byteSize(value) {
  return Buffer.byteLength(value, 'utf8');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function json(value, code = 'storage_failed') {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') fail(code);
    return encoded;
  } catch (error) {
    if (error instanceof StoreError) throw error;
    fail(code);
  }
}

function normalizeKind(kind) {
  if (kind === 'voice' || kind === 'backend') return kind;
  fail('config_invalid');
}

function normalizeEndpoint(value) {
  if (!isString(value) || value.length === 0 || value.length > 512 || value !== value.trim()) {
    fail('invalid_endpoint');
  }
  if (hasControlCharacters(value) || value.includes('?') || value.includes('#')) {
    fail('invalid_endpoint');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('invalid_endpoint');
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    fail('invalid_endpoint');
  }
  const normalized = parsed.toString().replace(/\/+$/u, '');
  if (!normalized || normalized.length > 512) fail('invalid_endpoint');
  return normalized;
}

function normalizeModel(value) {
  if (!isString(value)) fail('invalid_model');
  const model = value.trim();
  if (
    model.length === 0 ||
    model.length > MAX_MODEL_LENGTH ||
    hasControlCharacters(model)
  ) {
    fail('invalid_model');
  }
  return model;
}

function normalizeAuth(value) {
  if (value === 'bearer' || value === 'api-key') return value;
  fail('config_invalid');
}

function isClearlyMaskedKey(value) {
  return (
    /[\u2026•·█＊*]/u.test(value) ||
    /\.{3,}/u.test(value) ||
    /^(?:masked|redacted|hidden|removed|secret)$/iu.test(value) ||
    (value.length >= 4 && /^[xX*._\-•·…#]+$/u.test(value))
  );
}

function normalizeApiKey(value) {
  if (!isString(value)) fail('key_required');
  const apiKey = value.trim();
  if (
    apiKey.length === 0 ||
    apiKey.length > MAX_KEY_LENGTH ||
    hasControlCharacters(apiKey) ||
    isClearlyMaskedKey(apiKey)
  ) {
    fail('key_required');
  }
  return apiKey;
}

function normalizePublicCredential(value) {
  if (!isRecord(value)) fail('config_invalid');
  return {
    endpoint: normalizeEndpoint(value.endpoint),
    model: normalizeModel(value.model),
    auth: normalizeAuth(value.auth),
  };
}

function maskKey(apiKey) {
  if (apiKey.length <= 8) return '••••••••';
  return `${apiKey.slice(0, 4)}••••••${apiKey.slice(-4)}`;
}

function publicConnection(credential) {
  return {
    endpoint: credential.endpoint,
    model: credential.model,
    auth: credential.auth,
    keyMask: maskKey(credential.apiKey),
  };
}

function pickString(value, fallback, maximum) {
  if (!isString(value) || value.length > maximum || hasControlCharacters(value)) return fallback;
  return value;
}

function pickInteger(value, fallback, minimum, maximum) {
  if (!isFiniteNumber(value) || !Number.isInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function sanitizeSettings(value) {
  const root = isRecord(value) ? value : {};
  const voice = isRecord(root.voice) ? root.voice : {};
  const backend = isRecord(root.backend) ? root.backend : {};
  const audio = isRecord(value?.audio) ? value.audio : {};
  const deviceId = input => typeof input === 'string' && input.length <= 512 && !hasControlCharacters(input) ? input : '';
  return {
    locale: root.locale === 'en' ? 'en' : root.locale === 'zh' ? 'zh' : DEFAULT_SETTINGS.locale,
    theme:
      root.theme === 'light' || root.theme === 'dark' || root.theme === 'system'
        ? root.theme
        : DEFAULT_SETTINGS.theme,
    // Practice was a UI shortcut rather than a separate capability. Existing
    // settings are migrated in loadSettings; every new snapshot is general.
    mode: 'general',
    audio: {inputDeviceId: deviceId(audio.inputDeviceId), outputDeviceId: deviceId(audio.outputDeviceId)},
    voice: {
      voice: pickString(voice.voice, DEFAULT_SETTINGS.voice.voice, 64),
      tone:
        voice.tone === 'warm' || voice.tone === 'relaxed' || voice.tone === 'professional' || voice.tone === 'natural'
          ? voice.tone
          : DEFAULT_SETTINGS.voice.tone,
      intonation:
        voice.intonation === 'steady' || voice.intonation === 'expressive' || voice.intonation === 'natural'
          ? voice.intonation
          : DEFAULT_SETTINGS.voice.intonation,
      pace:
        voice.pace === 'slow' || voice.pace === 'brisk' || voice.pace === 'normal'
          ? voice.pace
          : DEFAULT_SETTINGS.voice.pace,
      minutes: pickInteger(voice.minutes, DEFAULT_SETTINGS.voice.minutes, 0, 24 * 60),
      instructions: pickString(
        voice.instructions,
        DEFAULT_SETTINGS.voice.instructions,
        MAX_INSTRUCTIONS_LENGTH,
      ),
    },
    backend: {
      enabled: isBoolean(backend.enabled) ? backend.enabled : DEFAULT_SETTINGS.backend.enabled,
      effort:
        backend.effort === 'default' ||
        backend.effort === 'low' ||
        backend.effort === 'medium' ||
        backend.effort === 'high' ||
        backend.effort === 'xhigh' ||
        backend.effort === 'max'
          ? backend.effort
          : DEFAULT_SETTINGS.backend.effort,
      maxOutputTokens: pickInteger(
        backend.maxOutputTokens,
        DEFAULT_SETTINGS.backend.maxOutputTokens,
        1,
        128_000,
      ),
      webSearch: isBoolean(backend.webSearch) ? backend.webSearch : DEFAULT_SETTINGS.backend.webSearch,
      timeoutSeconds: pickInteger(
        backend.timeoutSeconds,
        DEFAULT_SETTINGS.backend.timeoutSeconds,
        1,
        3_600,
      ),
      instructions: pickString(
        backend.instructions,
        DEFAULT_SETTINGS.backend.instructions,
        MAX_INSTRUCTIONS_LENGTH,
      ),
    },
  };
}

function sanitizeFragment(value) {
  if (!isRecord(value)) return null;
  if (value.role !== 'user' && value.role !== 'assistant') return null;
  if (!isString(value.text) || value.text.length > MAX_TEXT_LENGTH || hasControlCharacters(value.text)) return null;
  if (!isFiniteNumber(value.startMs) || !isFiniteNumber(value.endMs)) return null;
  if (value.startMs < 0 || value.endMs < value.startMs) return null;
  return {
    role: value.role,
    text: value.text,
    startMs: value.startMs,
    endMs: value.endMs,
  };
}

function sanitizeRecord(value) {
  if (!isRecord(value)) return null;
  if (
    !isString(value.id) ||
    value.id.length === 0 ||
    value.id.length > 128 ||
    hasControlCharacters(value.id) ||
    (value.mode !== 'general' && value.mode !== 'practice') ||
    !isFiniteNumber(value.startedAt) ||
    !isFiniteNumber(value.durationSeconds) ||
    value.startedAt < 0 ||
    value.durationSeconds < 0 ||
    value.durationSeconds > 24 * 60 * 60 ||
    !isBoolean(value.confirmedClose) ||
    !Array.isArray(value.fragments) ||
    value.fragments.length > MAX_FRAGMENTS_PER_RECORD
  ) {
    return null;
  }
  const fragments = [];
  for (const fragment of value.fragments) {
    const clean = sanitizeFragment(fragment);
    if (clean === null) return null;
    fragments.push(clean);
  }
  if (!fragments.some((fragment) => fragment.text.trim().length > 0)) return null;
  const hasTitle = Object.prototype.hasOwnProperty.call(value, 'title');
  const title = hasTitle ? normalizeHistoryTitle(value.title) : null;
  // A title is optional for legacy records, but a supplied non-empty title
  // must satisfy the same bound as generated and manually edited titles.
  if (hasTitle && value.title !== undefined && value.title !== null && value.title !== '' && title === null) return null;
  const titleSource = value.titleSource === 'manual' || value.titleSource === 'auto' ? value.titleSource : undefined;
  if (titleSource && !title) return null;
  const record = {
    id: value.id,
    mode: value.mode,
    startedAt: value.startedAt,
    durationSeconds: value.durationSeconds,
    confirmedClose: value.confirmedClose,
    fragments,
  };
  if (title) {
    record.title = title;
    if (titleSource) record.titleSource = titleSource;
  }
  if (byteSize(JSON.stringify(record)) > MAX_RECORD_BYTES) return null;
  return record;
}

function sanitizeHistory(value) {
  if (!Array.isArray(value)) return [];
  const records = [];
  for (const item of value) {
    const record = sanitizeRecord(item);
    if (record !== null) records.push(record);
    if (records.length >= MAX_HISTORY_RECORDS) break;
  }
  while (byteSize(JSON.stringify(records)) > MAX_HISTORY_BYTES) records.pop();
  return records;
}

function credentialFromStored(value) {
  if (!isRecord(value)) fail('storage_failed');
  let publicPart;
  try {
    publicPart = normalizePublicCredential(value);
  } catch {
    fail('storage_failed');
  }
  let apiKey;
  try {
    apiKey = normalizeApiKey(value.apiKey);
  } catch {
    fail('storage_failed');
  }
  return {...publicPart, apiKey};
}

function encryptionAvailable(safeStorage) {
  try {
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') return false;
    return Boolean(safeStorage.isEncryptionAvailable());
  } catch {
    return false;
  }
}

function secureStoreRequired(safeStorage) {
  if (!encryptionAvailable(safeStorage)) fail('encryption_unavailable');
}

function fileNameFor(kind) {
  return `credentials.${kind}.bin`;
}

export async function createStore({dataDir, safeStorage} = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) fail('storage_failed');
  await mkdir(dataDir, {recursive: true}).catch(() => fail('storage_failed'));

  const settingsPath = join(dataDir, 'settings.json');
  const historyPath = join(dataDir, 'history.json');
  const credentialPath = (kind) => join(dataDir, fileNameFor(kind));
  let writeTail = Promise.resolve();
  const deletedHistoryIds = new Set();

  function enqueue(task) {
    const result = writeTail.then(task, task);
    writeTail = result.catch(() => undefined);
    return result;
  }

  async function readOptional(path) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      fail('storage_failed');
    }
  }

  async function readJson(path) {
    const raw = await readOptional(path);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      fail('storage_failed');
    }
  }

  async function writeAtomic(path, content) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, {encoding: 'utf8', flag: 'wx', mode: 0o600});
      await rename(temporary, path);
    } catch {
      try {
        await rm(temporary, {force: true});
      } catch {
        // The original failure remains the only public result.
      }
      fail('storage_failed');
    }
  }

  async function readCredential(kind) {
    normalizeKind(kind);
    secureStoreRequired(safeStorage);
    let encrypted;
    try {
      encrypted = await readFile(credentialPath(kind));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      fail('storage_failed');
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) fail('storage_failed');
    let decoded;
    try {
      if (typeof safeStorage.decryptString !== 'function') fail('storage_failed');
      decoded = safeStorage.decryptString(encrypted);
    } catch {
      fail('storage_failed');
    }
    if (typeof decoded !== 'string' || decoded.length === 0) fail('storage_failed');
    try {
      return credentialFromStored(JSON.parse(decoded));
    } catch (error) {
      if (error instanceof StoreError) throw error;
      fail('storage_failed');
    }
  }

  async function loadSettings() {
    return enqueue(async () => {
      const raw = await readOptional(settingsPath);
      let value;
      if (raw !== null) {
        try {
          value = JSON.parse(raw);
        } catch {
          value = undefined;
        }
      }
      const normalized = sanitizeSettings(value);
      // Persist the one-time practice -> general migration so a restart does
      // not keep carrying the removed mode selector forward. History is kept
      // separate and is intentionally not rewritten here.
      if (isRecord(value) && value.mode === 'practice') {
        await writeAtomic(settingsPath, json(normalized));
      }
      return normalized;
    });
  }

  async function saveSettings(settings) {
    const normalized = sanitizeSettings(settings);
    return enqueue(async () => {
      await writeAtomic(settingsPath, json(normalized));
      return clone(normalized);
    });
  }

  async function getCredential(kind) {
    normalizeKind(kind);
    return enqueue(async () => {
      const value = await readCredential(kind);
      return value === null ? null : clone(value);
    });
  }

  async function loadConnections() {
    return enqueue(async () => {
      const [voice, backend] = await Promise.all([readCredential('voice'), readCredential('backend')]);
      return {
        voice: voice === null ? null : publicConnection(voice),
        backend: backend === null ? null : publicConnection(backend),
      };
    });
  }

  async function saveConnection(kind, input) {
    normalizeKind(kind);
    const publicPart = normalizePublicCredential(input);
    let requestedKey = null;
    if (input && input.apiKey !== undefined && input.apiKey !== '') {
      requestedKey = normalizeApiKey(input.apiKey);
    }
    return enqueue(async () => {
      secureStoreRequired(safeStorage);
      const current = await readCredential(kind);
      let apiKey;
      if (requestedKey !== null) {
        apiKey = requestedKey;
      } else if (
        current !== null &&
        current.endpoint === publicPart.endpoint &&
        current.auth === publicPart.auth
      ) {
        apiKey = current.apiKey;
      } else {
        fail('key_required');
      }
      const credential = {...publicPart, apiKey};
      let encrypted;
      try {
        if (typeof safeStorage.encryptString !== 'function') fail('encryption_unavailable');
        encrypted = safeStorage.encryptString(json(credential));
      } catch (error) {
        if (error instanceof StoreError) throw error;
        fail('storage_failed');
      }
      if (!Buffer.isBuffer(encrypted) && !(encrypted instanceof Uint8Array)) fail('storage_failed');
      await writeAtomic(credentialPath(kind), Buffer.from(encrypted));
      return publicConnection(credential);
    });
  }

  async function loadHistory() {
    return enqueue(async () => {
      return clone(await readHistorySnapshot());
    });
  }

  async function readHistorySnapshot(strict = false) {
    const raw = await readOptional(historyPath);
    let value;
    if (raw !== null) {
      try {
        value = JSON.parse(raw);
      } catch {
        if (strict) fail('storage_failed');
        value = undefined;
      }
    }
    if (!strict) return sanitizeHistory(value);
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_HISTORY_RECORDS) fail('storage_failed');
    const records = value.map((item) => sanitizeRecord(item));
    if (records.some((item) => item === null)) fail('storage_failed');
    if (byteSize(JSON.stringify(records)) > MAX_HISTORY_BYTES) fail('storage_failed');
    return records;
  }

  async function writeHistorySnapshot(records) {
    const next = sanitizeHistory(records);
    while (next.length > 1 && byteSize(JSON.stringify(next)) > MAX_HISTORY_BYTES) next.pop();
    if (byteSize(JSON.stringify(next)) > MAX_HISTORY_BYTES) fail('storage_failed');
    await writeAtomic(historyPath, json(next));
    return clone(next);
  }

  async function saveHistory({record} = {}) {
    const safeRecord = sanitizeRecord(record);
    if (safeRecord === null) fail('storage_failed');
    const recordSize = byteSize(JSON.stringify(safeRecord));
    if (recordSize > MAX_HISTORY_BYTES) fail('storage_failed');
    return enqueue(async () => {
      const existing = await readHistorySnapshot(true);
      if (deletedHistoryIds.has(safeRecord.id)) return clone(existing);
      const prior = existing.find((item) => item.id === safeRecord.id);
      // A repeated save of the same record cannot erase a title that was
      // already set by the user or by a completed auto-title request.
      let recordToSave = safeRecord;
      if (prior?.title) {
        recordToSave = {...safeRecord, title: prior.title};
        if (prior.titleSource) recordToSave.titleSource = prior.titleSource;
        else delete recordToSave.titleSource;
      }
      const priorIndex = existing.findIndex((item) => item.id === safeRecord.id);
      const next = priorIndex >= 0
        ? existing.map((item, index) => index === priorIndex ? recordToSave : item)
        : [recordToSave, ...existing].slice(0, MAX_HISTORY_RECORDS);
      return writeHistorySnapshot(next);
    });
  }

  function normalizeHistoryId(value) {
    if (!isString(value) || value.length === 0 || value.length > 128 || hasControlCharacters(value)) {
      fail('invalid_record');
    }
    return value;
  }

  async function renameHistory({id, title} = {}) {
    const recordId = normalizeHistoryId(id);
    const normalizedTitle = normalizeHistoryTitle(title);
    if (!normalizedTitle) fail('invalid_title');
    return enqueue(async () => {
      const existing = await readHistorySnapshot(true);
      const index = existing.findIndex((item) => item.id === recordId);
      if (index < 0) fail('history_not_found');
      const next = existing.slice();
      next[index] = {...next[index], title: normalizedTitle, titleSource: 'manual'};
      return writeHistorySnapshot(next);
    });
  }

  async function applyAutoHistoryTitle({id, title} = {}) {
    const recordId = normalizeHistoryId(id);
    const normalizedTitle = normalizeHistoryTitle(title);
    if (!normalizedTitle) fail('invalid_title');
    return enqueue(async () => {
      const existing = await readHistorySnapshot(true);
      const index = existing.findIndex((item) => item.id === recordId);
      // The request may finish after a manual rename or deletion. This is a
      // compare-and-set: never overwrite a manual title or recreate a record.
      if (index < 0 || existing[index].title) return clone(existing);
      const next = existing.slice();
      next[index] = {...next[index], title: normalizedTitle, titleSource: 'auto'};
      return writeHistorySnapshot(next);
    });
  }

  async function deleteHistory({id} = {}) {
    const recordId = normalizeHistoryId(id);
    return enqueue(async () => {
      const existing = await readHistorySnapshot(true);
      const next = existing.filter((item) => item.id !== recordId);
      // Deletion is idempotent so a late UI retry cannot resurrect or reorder
      // another record, and a completed delete remains the final state.
      if (next.length === existing.length) return clone(existing);
      const saved = await writeHistorySnapshot(next);
      // Only a successful persistent delete creates the in-process tombstone;
      // a write failure leaves the ID eligible for a later retry.
      deletedHistoryIds.add(recordId);
      return saved;
    });
  }

  async function dispose() {
    await writeTail.catch(() => undefined);
  }

  return {
    loadSettings,
    saveSettings,
    getCredential,
    loadConnections,
    saveConnection,
    loadHistory,
    saveHistory,
    renameHistory,
    applyAutoHistoryTitle,
    deleteHistory,
    dispose,
  };
}

export {
  DEFAULT_SETTINGS,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_RECORDS,
  MAX_RECORD_BYTES,
  normalizeApiKey,
  normalizePublicCredential,
  sanitizeRecord,
  sanitizeSettings,
};
