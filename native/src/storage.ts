import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import {Platform} from 'react-native';
import {writeIosConnectionsBundle} from './ios-secure-connections';

import type {
  Auth,
  Connection,
  ConversationRecord,
  Credential,
  Kind,
  Mode,
  Settings,
  TranscriptFragment,
} from './types';
import {normalizeHistoryTitle} from './history-title';

const SETTINGS_KEY = '@live-voice-app/settings/v1';
const HISTORY_KEY = '@live-voice-app/history/v1';
const HISTORY_TITLES_KEY = '@live-voice-app/history-titles/v1';
const KEYCHAIN_SERVICE_PREFIX = 'com.livevoiceapp.credential.';
const CONNECTIONS_SERVICE = 'com.livevoiceapp.connections.v2';
const KEYCHAIN_USERNAME = 'credential';

const MAX_HISTORY_RECORDS = 50;
const MAX_HISTORY_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_FRAGMENTS_PER_RECORD = 500;
const MAX_TEXT_LENGTH = 16_000;
const MAX_INSTRUCTIONS_LENGTH = 8_000;
const MAX_MODEL_LENGTH = 256;
const MAX_KEY_LENGTH = 4_096;

type StoredConnections = {
  version: 2;
  connections: Record<Kind, Credential | null>;
};

let credentialWriteQueue: Promise<void> = Promise.resolve();
let historyWriteQueue: Promise<void> = Promise.resolve();
// A delete can race a delayed title-generation response. The catalog is
// local-only and IDs are never reused during one process, so an in-memory
// tombstone is enough to prevent that response from resurrecting a record.
const historyTombstones = new Set<string>();

const DEFAULT_SETTINGS: Settings = {
  locale: 'zh',
  theme: 'system',
  mode: 'general',
  recordingEnabled: true,
  voice: {
    voice: 'marin',
    tone: 'natural',
    intonation: 'natural',
    pace: 'normal',
    minutes: 10,
    instructions: '',
  },
  backend: {
    enabled: false,
    effort: 'low',
    maxOutputTokens: 32768,
    webSearch: true,
    timeoutSeconds: 60,
    instructions: '',
  },
};

function storageError(): Error {
  return new Error('storage_failed');
}

function invalidEndpointError(): Error {
  return new Error('invalid_endpoint');
}

function keyRequiredError(): Error {
  return new Error('key_required');
}

function operationCancelledError(): Error {
  return new Error('operation_cancelled');
}

function invalidModelError(): Error {
  return new Error('invalid_model');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function pickString(value: unknown, fallback: string, maxLength: number): string {
  return isString(value) && value.length <= maxLength ? value : fallback;
}

function pickInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!isFiniteNumber(value) || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeEndpoint(value: unknown): string {
  if (!isString(value) || value.trim().length === 0) {
    throw invalidEndpointError();
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw invalidEndpointError();
  }

  // Credentials are sent to this address. Require TLS and reject URL parts
  // that could hide a different destination or alter request construction.
  if (
    parsed.protocol !== 'https:' ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.hostname.length === 0
  ) {
    throw invalidEndpointError();
  }

  // Treat a trailing slash on the root or API path as formatting, not a new
  // credential scope. Keep the path itself because providers may use it.
  let normalized = parsed.toString().replace(/\/+$/, '');
  normalized = normalized.replace(/^https:\/\/([^/]+):443(?=\/|$)/i, 'https://$1');
  return normalized;
}

function normalizeModel(value: unknown): string {
  if (!isString(value)) {
    throw invalidModelError();
  }
  const model = value.trim();
  if (
    model.length === 0 ||
    model.length > MAX_MODEL_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(model)
  ) {
    throw invalidModelError();
  }
  return model;
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
      } else {
        return true;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateImportedModel(value: unknown): string {
  if (
    !isString(value) ||
    hasControlCharacters(value) ||
    hasUnpairedSurrogate(value) ||
    characterLength(value) === 0 ||
    value.trim().length === 0 ||
    characterLength(value) > MAX_MODEL_LENGTH
  ) {
    throw invalidModelError();
  }
  return value;
}

function normalizeAuth(value: unknown): Auth {
  if (value === 'bearer' || value === 'api-key') {
    return value;
  }
  throw invalidModelError();
}

function normalizeKind(kind: Kind): Kind {
  if (kind === 'voice' || kind === 'backend') {
    return kind;
  }
  throw storageError();
}

function keychainService(kind: Kind): string {
  return `${KEYCHAIN_SERVICE_PREFIX}${kind}`;
}

function maskKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return '••••••••';
  }
  return `${apiKey.slice(0, 4)}••••••${apiKey.slice(-4)}`;
}

function publicConnection(credential: Credential): Connection {
  return {
    endpoint: credential.endpoint,
    model: credential.model,
    auth: credential.auth,
    keyMask: maskKey(credential.apiKey),
  };
}

function validateApiKey(value: unknown): string {
  if (!isString(value)) {
    throw keyRequiredError();
  }
  const apiKey = value.trim();
  if (apiKey.length === 0 || apiKey.length > MAX_KEY_LENGTH) {
    throw keyRequiredError();
  }
  return apiKey;
}

function validateImportedApiKey(value: unknown): string {
  if (
    !isString(value) ||
    hasControlCharacters(value) ||
    hasUnpairedSurrogate(value) ||
    characterLength(value) === 0 ||
    value.trim().length === 0 ||
    characterLength(value) > MAX_KEY_LENGTH ||
    isClearlyMaskedKey(value)
  ) {
    throw keyRequiredError();
  }
  return value;
}

function isClearlyMaskedKey(value: string): boolean {
  if (/[\u2026•·█＊*]/u.test(value) || /\.{3,}/u.test(value)) {
    return true;
  }
  if (/^(?:masked|redacted|hidden|removed|secret)$/iu.test(value)) {
    return true;
  }
  return value.length >= 4 && /^[xX*._\-•·…#]+$/u.test(value);
}

function validateStoredText(value: unknown, maximum: number, error: Error): string {
  if (!isString(value) || characterLength(value) === 0 || characterLength(value) > maximum) {
    throw error;
  }
  return value;
}

function validateInputConnection(
  value: Omit<Connection, 'keyMask'>,
): Omit<Connection, 'keyMask'> {
  if (!isRecord(value)) {
    throw storageError();
  }
  return {
    endpoint: normalizeEndpoint(value.endpoint),
    model: normalizeModel(value.model),
    auth: normalizeAuth(value.auth),
  };
}

function parseStoredCredential(value: unknown, preserveRawModelAndKey = false): Credential {
  try {
    if (!isRecord(value)) {
      throw storageError();
    }
    const endpoint = normalizeEndpoint(value.endpoint);
    const model = preserveRawModelAndKey
      // v2 may contain values written by the older manual editor. Keep those
      // exact strings readable; strict QRv1 checks happen before import save.
      ? validateStoredText(value.model, MAX_MODEL_LENGTH, invalidModelError())
      : normalizeModel(value.model);
    const auth = normalizeAuth(value.auth);
    const apiKey = preserveRawModelAndKey
      ? validateStoredText(value.apiKey, MAX_KEY_LENGTH, keyRequiredError())
      : validateApiKey(value.apiKey);
    return {endpoint, model, auth, apiKey};
  } catch {
    // A corrupt or incompatible Keychain value is a storage failure. It must
    // never be treated as an absent credential or surfaced with provider text.
    throw storageError();
  }
}

function parseImportedCredential(value: unknown): Credential {
  try {
    if (!isRecord(value)) {
      throw storageError();
    }
    return {
      endpoint: normalizeEndpoint(value.endpoint),
      // QRv1 values are already validated by the producer. Preserve their
      // exact model/key strings rather than trimming them during import.
      model: validateImportedModel(value.model),
      auth: normalizeAuth(value.auth),
      apiKey: validateImportedApiKey(value.apiKey),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'invalid_endpoint' ||
        error.message === 'invalid_model' ||
        error.message === 'key_required')
    ) {
      throw error;
    }
    throw storageError();
  }
}

function isAbortSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (isAbortSignalAborted(signal)) {
    throw operationCancelledError();
  }
}

function enqueueCredentialWrite<T>(
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  // This check happens before work is added to the queue, so an already
  // cancelled import cannot delay or observe credential state.
  ensureNotAborted(signal);
  const run = credentialWriteQueue.then(async () => {
    // This check happens again after earlier writers settle and immediately
    // before this writer reads the current bundle.
    ensureNotAborted(signal);
    return work();
  });
  credentialWriteQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readKeychainCredential(service: string): Promise<Credential | null> {
  let result: false | Keychain.UserCredentials;
  try {
    result = await Keychain.getGenericPassword({
      service,
    });
  } catch {
    // Inaccessible Keychain/Keystore is intentionally distinct from a missing
    // item. Do not silently turn it into an unconfigured state.
    throw storageError();
  }

  if (result === false) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.password);
  } catch {
    throw storageError();
  }
  return parseStoredCredential(parsed);
}

async function readLegacyCredential(kind: Kind): Promise<Credential | null> {
  return readKeychainCredential(keychainService(normalizeKind(kind)));
}

function parseStoredConnections(value: unknown): StoredConnections {
  try {
    if (!isRecord(value) || value.version !== 2 || !isRecord(value.connections)) {
      throw storageError();
    }
    const connections: Record<Kind, Credential | null> = {
      voice: value.connections.voice === null
        ? null
        : parseStoredCredential(value.connections.voice, true),
      backend: value.connections.backend === null
        ? null
        : parseStoredCredential(value.connections.backend, true),
    };
    return {version: 2, connections};
  } catch {
    // A present v2 item is authoritative. Corruption must not fall back to
    // potentially stale legacy values.
    throw storageError();
  }
}

async function readConnectionsSnapshot(): Promise<StoredConnections> {
  let result: false | Keychain.UserCredentials;
  try {
    result = await Keychain.getGenericPassword({service: CONNECTIONS_SERVICE});
  } catch {
    // An inaccessible preferred bundle is not the same as an absent bundle;
    // never mask it by reading legacy entries.
    throw storageError();
  }

  if (result !== false) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.password);
    } catch {
      throw storageError();
    }
    return parseStoredConnections(parsed);
  }

  // Only the absence of v2 permits the one-time compatibility read of the
  // independent legacy services.
  const [voice, backend] = await Promise.all([
    readLegacyCredential('voice'),
    readLegacyCredential('backend'),
  ]);
  return {version: 2, connections: {voice, backend}};
}

async function writeConnectionsSnapshot(snapshot: StoredConnections): Promise<void> {
  if (Platform.OS === 'ios') {
    await writeIosConnectionsBundle(JSON.stringify(snapshot));
    return;
  }
  let result: false | Keychain.Result;
  try {
    result = await Keychain.setGenericPassword(
      KEYCHAIN_USERNAME,
      JSON.stringify(snapshot),
      {
        service: CONNECTIONS_SERVICE,
        storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
      },
    );
  } catch {
    // One Keychain write replaces the complete bundle. There is no fallback
    // store and no second write that could leave the sides out of sync.
    throw storageError();
  }
  if (result === false) {
    throw storageError();
  }
}

function sanitizeSettings(value: unknown): Settings {
  if (!isRecord(value)) {
    return {...DEFAULT_SETTINGS, voice: {...DEFAULT_SETTINGS.voice}, backend: {...DEFAULT_SETTINGS.backend}};
  }

  const voice = isRecord(value.voice) ? value.voice : {};
  const backend = isRecord(value.backend) ? value.backend : {};

  return {
    locale: value.locale === 'en' ? 'en' : DEFAULT_SETTINGS.locale,
    theme:
      value.theme === 'light' || value.theme === 'dark'
        ? value.theme
        : DEFAULT_SETTINGS.theme,
    // Keep the legacy field while retiring the saved practice preference.
    mode: 'general',
    recordingEnabled: isBoolean(value.recordingEnabled)
      ? value.recordingEnabled
      : DEFAULT_SETTINGS.recordingEnabled,
    voice: {
      voice: pickString(voice.voice, DEFAULT_SETTINGS.voice.voice, 64),
      tone:
        voice.tone === 'warm' ||
        voice.tone === 'relaxed' ||
        voice.tone === 'professional'
          ? voice.tone
          : DEFAULT_SETTINGS.voice.tone,
      intonation:
        voice.intonation === 'steady' || voice.intonation === 'expressive'
          ? voice.intonation
          : DEFAULT_SETTINGS.voice.intonation,
      pace:
        voice.pace === 'slow' || voice.pace === 'brisk'
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
      enabled: isBoolean(backend.enabled)
        ? backend.enabled
        : DEFAULT_SETTINGS.backend.enabled,
      effort:
        backend.effort === 'default' ||
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
      webSearch: isBoolean(backend.webSearch)
        ? backend.webSearch
        : DEFAULT_SETTINGS.backend.webSearch,
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

function safeJsonStringify(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string' || encoded.length > MAX_HISTORY_BYTES) {
      throw storageError();
    }
    return encoded;
  } catch {
    throw storageError();
  }
}

function sanitizeFragment(value: unknown): TranscriptFragment | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.role !== 'user' && value.role !== 'assistant') {
    return null;
  }
  if (!isString(value.text) || value.text.length > MAX_TEXT_LENGTH) {
    return null;
  }
  if (!isFiniteNumber(value.startMs) || !isFiniteNumber(value.endMs)) {
    return null;
  }
  if (value.startMs < 0 || value.endMs < value.startMs) {
    return null;
  }
  return {
    role: value.role,
    text: value.text,
    startMs: value.startMs,
    endMs: value.endMs,
  };
}

type HistoryTitleEntry = {
  title: string;
  source: 'manual' | 'auto';
};

type StoredHistoryTitles = {
  version: 1;
  entries: Record<string, HistoryTitleEntry>;
};

function isValidRecordId(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.length <= 128;
}

function titleEntryFromValue(value: unknown): HistoryTitleEntry | null {
  if (!isRecord(value)) return null;
  const title = normalizeHistoryTitle(value.title);
  if (title === null) return null;
  const source = value.source === 'auto' ? 'auto' : value.source === 'manual' ? 'manual' : null;
  if (source === null) return null;
  return {title, source};
}

function titleEntryFromRecord(record: ConversationRecord): HistoryTitleEntry | null {
  const title = normalizeHistoryTitle(record.title);
  if (title === null) return null;
  return {
    title,
    source: record.titleSource === 'auto' ? 'auto' : 'manual',
  };
}

function parseStoredHistoryTitles(value: unknown): StoredHistoryTitles {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) {
    throw storageError();
  }

  const entries = Object.create(null) as Record<string, HistoryTitleEntry>;
  for (const [id, rawEntry] of Object.entries(value.entries)) {
    if (!isValidRecordId(id)) throw storageError();
    const entry = titleEntryFromValue(rawEntry);
    if (entry === null) throw storageError();
    entries[id] = entry;
  }
  return {version: 1, entries};
}

function storedTitleEntry(
  entries: Record<string, HistoryTitleEntry>,
  id: string,
): HistoryTitleEntry | undefined {
  return Object.prototype.hasOwnProperty.call(entries, id) ? entries[id] : undefined;
}

async function readHistoryTitles(): Promise<StoredHistoryTitles> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(HISTORY_TITLES_KEY);
  } catch {
    throw storageError();
  }
  if (raw === null) return {version: 1, entries: {}};
  if (raw.length > MAX_HISTORY_BYTES) throw storageError();
  try {
    return parseStoredHistoryTitles(JSON.parse(raw));
  } catch {
    throw storageError();
  }
}

async function writeHistoryTitles(value: StoredHistoryTitles): Promise<void> {
  try {
    await AsyncStorage.setItem(HISTORY_TITLES_KEY, safeJsonStringify(value));
  } catch {
    throw storageError();
  }
}

function enqueueHistoryWrite<T>(work: () => Promise<T>): Promise<T> {
  const run = historyWriteQueue.then(work);
  historyWriteQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readHistoryRaw(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(HISTORY_KEY);
  } catch {
    throw storageError();
  }
}

function parseHistoryRaw(raw: string | null, strict: boolean): ConversationRecord[] {
  if (raw === null) return [];
  if (raw.length > MAX_HISTORY_BYTES) {
    if (strict) throw storageError();
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (strict) throw storageError();
    return [];
  }

  if (!Array.isArray(parsed)) {
    if (strict) throw storageError();
    return [];
  }
  if (strict && parsed.length > MAX_HISTORY_RECORDS) throw storageError();

  if (!strict) return sanitizeHistory(parsed);

  const records: ConversationRecord[] = [];
  for (const item of parsed) {
    const record = sanitizeRecord(item);
    if (record === null) throw storageError();
    records.push(record);
  }
  return records;
}

async function readHistoryForMutation(): Promise<ConversationRecord[]> {
  return parseHistoryRaw(await readHistoryRaw(), true);
}

async function hasAudioRecord(
  audioExists: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  if (audioExists === undefined) return false;
  try {
    return (await audioExists()) === true;
  } catch {
    // An unavailable or concurrently deleted recording must never create a
    // title-only history item.
    return false;
  }
}

function applyTitleEntry(
  record: ConversationRecord,
  entry: HistoryTitleEntry | null,
): ConversationRecord {
  const next: ConversationRecord = {...record};
  delete next.title;
  delete next.titleSource;
  const effective = entry ?? titleEntryFromRecord(record);
  if (effective !== null) {
    next.title = effective.title;
    next.titleSource = effective.source;
  }
  return next;
}

function sanitizeRecord(value: unknown): ConversationRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isString(value.id) ||
    value.id.length === 0 ||
    value.id.length > 128 ||
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

  const fragments: TranscriptFragment[] = [];
  for (const fragment of value.fragments) {
    const clean = sanitizeFragment(fragment);
    if (clean === null) {
      return null;
    }
    fragments.push(clean);
  }

  const record: ConversationRecord = {
    id: value.id,
    mode: value.mode as Mode,
    startedAt: value.startedAt,
    durationSeconds: value.durationSeconds,
    confirmedClose: value.confirmedClose,
    fragments,
  };

  const title = normalizeHistoryTitle(value.title);
  if (title !== null) {
    record.title = title;
    record.titleSource = value.titleSource === 'auto' ? 'auto' : 'manual';
  }

  if (JSON.stringify(record).length > MAX_RECORD_BYTES) {
    return null;
  }
  return record;
}

function sanitizeHistory(value: unknown): ConversationRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const records: ConversationRecord[] = [];
  for (const item of value) {
    const record = sanitizeRecord(item);
    if (record !== null) {
      records.push(record);
    }
    if (records.length >= MAX_HISTORY_RECORDS) {
      break;
    }
  }
  return records;
}

export async function loadSettings(): Promise<Settings> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(SETTINGS_KEY);
  } catch {
    throw storageError();
  }
  if (raw === null) {
    return sanitizeSettings(undefined);
  }

  try {
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    // A stale or malformed preferences blob is migrated to safe defaults.
    return sanitizeSettings(undefined);
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  const safeSettings = sanitizeSettings(settings);
  try {
    await AsyncStorage.setItem(SETTINGS_KEY, safeJsonStringify(safeSettings));
  } catch {
    throw storageError();
  }
}

export async function loadConnections(): Promise<
  Record<Kind, Connection | null>
> {
  const snapshot = await readConnectionsSnapshot();
  return {
    voice:
      snapshot.connections.voice === null
        ? null
        : publicConnection(snapshot.connections.voice),
    backend:
      snapshot.connections.backend === null
        ? null
        : publicConnection(snapshot.connections.backend),
  };
}

export async function saveConnection(
  kind: Kind,
  connection: Omit<Connection, 'keyMask'>,
  newKey?: string,
): Promise<Connection> {
  const normalizedKind = normalizeKind(kind);
  const safeConnection = validateInputConnection(connection);
  const suppliedKey = newKey === undefined ? undefined : validateApiKey(newKey);

  return enqueueCredentialWrite(undefined, async () => {
    const snapshot = await readConnectionsSnapshot();
    const current = snapshot.connections[normalizedKind];
    const endpointOrAuthChanged =
      current === null ||
      current.endpoint !== safeConnection.endpoint ||
      current.auth !== safeConnection.auth;

    let apiKey: string;
    if (suppliedKey !== undefined) {
      apiKey = suppliedKey;
    } else if (!endpointOrAuthChanged && current !== null) {
      apiKey = current.apiKey;
    } else {
      throw keyRequiredError();
    }

    const credential: Credential = {
      endpoint: safeConnection.endpoint,
      model: safeConnection.model,
      auth: safeConnection.auth,
      apiKey,
    };
    const next: StoredConnections = {
      version: 2,
      connections: {
        ...snapshot.connections,
        [normalizedKind]: credential,
      },
    };

    await writeConnectionsSnapshot(next);
    return publicConnection(credential);
  });
}

export async function saveImportedConnections(
  connections: Partial<Record<Kind, Credential>>,
  signal?: AbortSignal,
): Promise<Record<Kind, Connection | null>> {
  if (!isRecord(connections)) {
    throw storageError();
  }

  const providedKinds = Object.keys(connections);
  if (providedKinds.length === 0) {
    throw storageError();
  }

  const imported: Partial<Record<Kind, Credential>> = {};
  for (const rawKind of providedKinds) {
    if (rawKind !== 'voice' && rawKind !== 'backend') {
      throw storageError();
    }
    // An explicit undefined is not an omitted side: QRv1 imports must contain
    // a complete credential whenever a side is present.
    imported[rawKind] = parseImportedCredential(
      (connections as Record<string, unknown>)[rawKind],
    );
  }

  return enqueueCredentialWrite(signal, async () => {
    const snapshot = await readConnectionsSnapshot();
    const next: StoredConnections = {
      version: 2,
      connections: {
        voice: imported.voice ?? snapshot.connections.voice,
        backend: imported.backend ?? snapshot.connections.backend,
      },
    };

    // Once this check passes, writeConnectionsSnapshot is allowed to settle;
    // an abort racing an in-flight native write must not report a false
    // cancellation after the bundle has been committed.
    ensureNotAborted(signal);
    await writeConnectionsSnapshot(next);
    return {
      voice:
        next.connections.voice === null
          ? null
          : publicConnection(next.connections.voice),
      backend:
        next.connections.backend === null
          ? null
          : publicConnection(next.connections.backend),
    };
  });
}

export async function getCredential(kind: Kind): Promise<Credential | null> {
  // This is intentionally the only public API that returns the complete key;
  // callers should use it only immediately before a network request.
  const snapshot = await readConnectionsSnapshot();
  return snapshot.connections[normalizeKind(kind)];
}

export async function applyHistoryTitles(
  records: ConversationRecord[],
): Promise<ConversationRecord[]> {
  return enqueueHistoryWrite(async () => {
    const titles = await readHistoryTitles();
    return records
      .filter(record => !historyTombstones.has(record.id))
      .map(record => applyTitleEntry(record, storedTitleEntry(titles.entries, record.id) ?? null));
  });
}

export async function loadHistory(): Promise<ConversationRecord[]> {
  return enqueueHistoryWrite(async () => {
    const records = parseHistoryRaw(await readHistoryRaw(), false);
    const titles = await readHistoryTitles();
    return records
      .filter(record => !historyTombstones.has(record.id))
      .map(record => applyTitleEntry(record, storedTitleEntry(titles.entries, record.id) ?? null));
  });
}

export async function saveRecord(record: ConversationRecord): Promise<void> {
  const safeRecord = sanitizeRecord(record);
  if (safeRecord === null) {
    throw storageError();
  }

  await enqueueHistoryWrite(async () => {
    // A delayed finalizer may arrive after the user deleted this session. Do
    // not let it bring the text record back into history.
    if (historyTombstones.has(safeRecord.id)) return;

    const existing = await readHistoryForMutation();
    const titles = await readHistoryTitles();
    const previous = existing.find(item => item.id === safeRecord.id);
    const storedTitle =
      storedTitleEntry(titles.entries, safeRecord.id) ??
      (previous === undefined ? null : titleEntryFromRecord(previous));
    const incomingTitle = titleEntryFromRecord(safeRecord);
    const effectiveTitle = storedTitle ?? incomingTitle;
    if (effectiveTitle !== null) {
      safeRecord.title = effectiveTitle.title;
      safeRecord.titleSource = effectiveTitle.source;
    } else {
      delete safeRecord.title;
      delete safeRecord.titleSource;
    }

    const next = [
      safeRecord,
      ...existing.filter(item => item.id !== safeRecord.id),
    ].slice(0, MAX_HISTORY_RECORDS);

    try {
      await AsyncStorage.setItem(HISTORY_KEY, safeJsonStringify(next));
    } catch {
      throw storageError();
    }

    // Keep titles in their independent store too. This is needed when a text
    // record later falls out of the 50-item text window but its audio remains.
    if (effectiveTitle !== null && !Object.prototype.hasOwnProperty.call(titles.entries, safeRecord.id)) {
      await writeHistoryTitles({
        version: 1,
        entries: {...titles.entries, [safeRecord.id]: effectiveTitle},
      });
    }
  });
}

export async function renameRecord(
  id: string,
  title: string,
  audioExists?: () => Promise<boolean>,
): Promise<boolean> {
  if (!isValidRecordId(id)) return false;
  const normalized = normalizeHistoryTitle(title);
  if (normalized === null) return false;

  return enqueueHistoryWrite(async () => {
    if (historyTombstones.has(id)) return false;
    const records = await readHistoryForMutation();
    const hasText = records.some(record => record.id === id);
    if (!hasText && !(await hasAudioRecord(audioExists))) return false;

    const titles = await readHistoryTitles();
    const current = storedTitleEntry(titles.entries, id);
    if (current?.source === 'manual' && current.title === normalized) return true;
    await writeHistoryTitles({
      version: 1,
      entries: {
        ...titles.entries,
        [id]: {title: normalized, source: 'manual'},
      },
    });
    return true;
  });
}

export async function applyGeneratedRecordTitle(
  id: string,
  title: string,
  audioExists?: () => Promise<boolean>,
): Promise<boolean> {
  if (!isValidRecordId(id)) return false;
  const normalized = normalizeHistoryTitle(title);
  if (normalized === null) return false;

  return enqueueHistoryWrite(async () => {
    if (historyTombstones.has(id)) return false;
    const records = await readHistoryForMutation();
    const record = records.find(item => item.id === id);
    if (record === undefined && !(await hasAudioRecord(audioExists))) return false;

    const titles = await readHistoryTitles();
    // This is the compare-and-set: either a manual rename or an earlier
    // generated title wins, regardless of which network response arrives last.
    if (storedTitleEntry(titles.entries, id) !== undefined || (record !== undefined && titleEntryFromRecord(record) !== null)) {
      return false;
    }

    await writeHistoryTitles({
      version: 1,
      entries: {
        ...titles.entries,
        [id]: {title: normalized, source: 'auto'},
      },
    });
    return true;
  });
}

export async function deleteRecord(id: string): Promise<void> {
  if (!isValidRecordId(id)) throw storageError();

  await enqueueHistoryWrite(async () => {
    const originalHistoryRaw = await readHistoryRaw();
    const records = parseHistoryRaw(originalHistoryRaw, true);
    const titles = await readHistoryTitles();
    const nextRecords = records.filter(record => record.id !== id);
    const hadText = nextRecords.length !== records.length;
    const hadTitle = storedTitleEntry(titles.entries, id) !== undefined;

    // Remove text first. If this write fails, the title remains available and
    // the visible record can be retried; in particular, do not tombstone it.
    if (hadText) {
      try {
        await AsyncStorage.setItem(HISTORY_KEY, safeJsonStringify(nextRecords));
      } catch {
        throw storageError();
      }
    }

    if (hadTitle) {
      const nextEntries = {...titles.entries};
      delete nextEntries[id];
      try {
        await writeHistoryTitles({version: 1, entries: nextEntries});
      } catch (error) {
        // Text deletion may already have committed. Restore the exact raw
        // history blob so a failed title cleanup remains visible and can be
        // retried. If restoration also fails, the in-memory tombstone is the
        // last line of defense against a late finalizer resurrecting it.
        if (hadText && originalHistoryRaw !== null) {
          try {
            await AsyncStorage.setItem(HISTORY_KEY, originalHistoryRaw);
          } catch {
            historyTombstones.add(id);
          }
        } else {
          historyTombstones.add(id);
        }
        throw error;
      }
    }

    // Only establish the tombstone after all required persistent cleanup has
    // succeeded. A transient write error must leave retry possible.
    historyTombstones.add(id);
  });
}
