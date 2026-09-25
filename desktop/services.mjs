import {encryptConfig} from '../pc-config/crypto.mjs';
import appPackage from './package.json' with {type: 'json'};
import {probeConnection as defaultProbeConnection} from '../pc-config/probes.mjs';
import {extractOutputText} from '../native/src/backend.ts';
import {buildTitleRequest, parseGeneratedTitle} from '../native/src/history-title.ts';
import {confirmSessionClose} from './finalize-session.mjs';
import {
  ErrorCode,
  ProtocolError,
  authHeaders,
  buildBackendInstructions,
  buildVoiceInstructions,
  httpErrorCode,
  httpStatusCode,
  liveHttpUrl,
  responsesHttpUrl,
  withTimeoutSignal,
} from '../native/src/protocol.ts';
import {
  createStore,
  normalizeApiKey,
  normalizePublicCredential,
} from './store.mjs';

const VERSION = appPackage.version;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_SDP_LENGTH = 64 * 1024;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_HISTORY_INPUT_BYTES = 256 * 1024;
const MAX_HISTORY_ITEMS = 500;
const MAX_TIMEOUT_SECONDS = 300;
const HISTORY_TITLE_TIMEOUT_MS = 20_000;

class ServiceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ServiceError';
    this.code = code;
  }
}

function fail(code) {
  throw new ServiceError(code);
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isString(value) {
  return typeof value === 'string';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function errorCode(error, fallback) {
  if (error instanceof ServiceError || error instanceof StoreErrorLike || error instanceof ProtocolError) {
    return typeof error.code === 'string' ? error.code : fallback;
  }
  if (error && typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,80}$/u.test(error.code)) {
    return error.code;
  }
  return fallback;
}

// Avoid importing the StoreError class into the public error surface while
// still recognising errors originating in the isolated store module.
class StoreErrorLike {}

function normalizeId(value, code = ErrorCode.CONFIG_INVALID) {
  if (!isString(value) || value.length === 0 || value.length > MAX_REQUEST_ID_LENGTH) fail(code);
  return value;
}

function validateMode(value) {
  // Keep accepting the old renderer's value while the mode field remains in
  // the IPC contract for compatibility. There is one conversation experience
  // now, so every new session snapshot is general.
  if (value === 'general' || value === 'practice') return 'general';
  fail(ErrorCode.CONFIG_INVALID);
}

function abortCode(signal, timeoutSignal, kind) {
  if (signal?.aborted) return kind === 'backend' ? ErrorCode.BACKEND_ABORTED : ErrorCode.SESSION_CANCELLED;
  if (timeoutSignal?.aborted) return kind === 'backend' ? ErrorCode.BACKEND_TIMEOUT : ErrorCode.VOICE_TIMEOUT;
  return kind === 'backend' ? ErrorCode.BACKEND_NETWORK : ErrorCode.VOICE_NETWORK;
}

function responseStatus(response) {
  const status = Number(response?.status);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}

function responseFailure(kind, response) {
  const status = responseStatus(response);
  if (status >= 200 && status < 300) return null;
  return new ProtocolError(httpErrorCode(kind, status), httpStatusCode(status));
}

function waitForAbort(promise, signal, abortFailure) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(abortFailure());
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, {once: true});
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Response cleanup is best effort and never exposes transport details.
  }
}

async function readBodyText(response, invalidCode, signal, abortFailure) {
  if (!response || typeof response !== 'object') throw new ProtocolError(invalidCode);
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let total = 0;
    let text = '';
    try {
      while (true) {
        const chunk = await waitForAbort(reader.read(), signal, abortFailure);
        if (!chunk || typeof chunk !== 'object') throw new ProtocolError(invalidCode);
        if (chunk.done) break;
        const bytes = chunk.value instanceof Uint8Array
          ? chunk.value
          : ArrayBuffer.isView(chunk.value)
            ? new Uint8Array(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength)
            : chunk.value instanceof ArrayBuffer
              ? new Uint8Array(chunk.value)
              : null;
        if (!bytes) throw new ProtocolError(invalidCode);
        total += bytes.byteLength;
        if (total > MAX_RESPONSE_BYTES) throw new ProtocolError(invalidCode);
        text += decoder.decode(bytes, {stream: true});
      }
      text += decoder.decode();
      return text;
    } catch (error) {
      try {
        await reader.cancel?.();
      } catch {
        // Ignore cleanup failures after an invalid or aborted response.
      }
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(invalidCode);
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        // Cleanup is best effort; provider details never cross this boundary.
      }
    }
  }
  if (typeof response.text === 'function') {
    let text;
    try {
      text = await waitForAbort(response.text(), signal, abortFailure);
    } catch {
      throw new ProtocolError(invalidCode);
    }
    if (!isString(text) || byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new ProtocolError(invalidCode);
    }
    return text;
  }
  if (typeof response.json === 'function') {
    try {
      const value = await waitForAbort(response.json(), signal, abortFailure);
      const text = JSON.stringify(value);
      if (byteLength(text) > MAX_RESPONSE_BYTES) throw new ProtocolError(invalidCode);
      return text;
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(invalidCode);
    }
  }
  throw new ProtocolError(invalidCode);
}

async function fetchJson(fetchImpl, url, init, kind, timeoutMs, parentSignal) {
  const deadline = withTimeoutSignal(parentSignal, timeoutMs);
  let response;
  try {
    try {
      response = await waitForAbort(
        Promise.resolve().then(() => fetchImpl(url, {
          ...init,
          redirect: 'manual',
          signal: deadline.signal,
        })),
        deadline.signal,
        () => new ProtocolError(abortCode(parentSignal, deadline.signal, kind)),
      );
    } catch {
      throw new ProtocolError(abortCode(parentSignal, deadline.signal, kind));
    }
    const failure = responseFailure(kind, response);
    if (failure) {
      await cancelResponseBody(response);
      throw failure;
    }
    const invalidCode = kind === 'voice' ? ErrorCode.VOICE_INVALID_RESPONSE : ErrorCode.BACKEND_INVALID_RESPONSE;
    const raw = await readBodyText(
      response,
      invalidCode,
      deadline.signal,
      () => new ProtocolError(abortCode(parentSignal, deadline.signal, kind)),
    );
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ProtocolError(kind === 'voice' ? ErrorCode.VOICE_INVALID_RESPONSE : ErrorCode.BACKEND_INVALID_RESPONSE);
    }
    if (!isRecord(value)) {
      throw new ProtocolError(kind === 'voice' ? ErrorCode.VOICE_INVALID_RESPONSE : ErrorCode.BACKEND_INVALID_RESPONSE);
    }
    return value;
  } finally {
    deadline.cleanup();
  }
}

function validateSdp(value) {
  if (!isString(value) || value.length === 0 || value.length > MAX_SDP_LENGTH) fail(ErrorCode.CONFIG_INVALID);
  return value;
}

function sessionResult(value) {
  const session = isRecord(value.session) ? value.session : null;
  const transport = isRecord(value.transport) ? value.transport : null;
  if (
    !session ||
    !transport ||
    !isString(session.id) ||
    session.id.length === 0 ||
    transport.type !== 'webrtc' ||
    !isString(transport.sdp) ||
    transport.sdp.length === 0 ||
    transport.sdp.length > MAX_SDP_LENGTH
  ) {
    throw new ProtocolError(ErrorCode.VOICE_INVALID_RESPONSE);
  }
  return {sessionId: session.id, sdp: transport.sdp};
}

function inputHistory(history) {
  if (!Array.isArray(history) || history.length > MAX_HISTORY_ITEMS) fail(ErrorCode.BACKEND_NO_INPUT);
  const input = [];
  const itemBytes = [];
  for (const item of history) {
    if (!isRecord(item) || (item.role !== 'user' && item.role !== 'assistant')) continue;
    if (!isString(item.text) || item.text.trim().length === 0 || item.text.length > 16_000) continue;
    const clean = {role: item.role, content: item.text};
    input.push(clean);
    // Count the serialized item separately so a large but bounded input does
    // not need to be stringified as one multi-megabyte JSON document first.
    itemBytes.push(byteLength(JSON.stringify(clean)));
  }
  if (!input.some((item) => item.role === 'user')) fail(ErrorCode.BACKEND_NO_INPUT);

  const serializedSize = (indices) => {
    if (indices.length === 0) return 2;
    return 2 + indices.reduce((total, index) => total + itemBytes[index], 0) + indices.length - 1;
  };
  const firstUser = input.findIndex((item) => item.role === 'user');
  const lastUser = input.findLastIndex((item) => item.role === 'user');
  const required = new Set([firstUser, lastUser]);
  const keepAdjacentAssistant = (userIndex) => {
    if (input[userIndex + 1]?.role === 'assistant') required.add(userIndex + 1);
    else if (input[userIndex - 1]?.role === 'assistant') required.add(userIndex - 1);
  };
  keepAdjacentAssistant(firstUser);
  keepAdjacentAssistant(lastUser);

  const selected = input.map((_, index) => index);
  let size = serializedSize(selected);
  if (size <= MAX_HISTORY_INPUT_BYTES) return input;

  const requiredIndices = [...required].sort((left, right) => left - right);
  if (serializedSize(requiredIndices) > MAX_HISTORY_INPUT_BYTES) fail(ErrorCode.BACKEND_NO_INPUT);

  // Remove the oldest non-required items first. This keeps the first user
  // anchor and the newest user turn while retaining as much middle context as
  // the UTF-8 request budget permits.
  for (let index = 0; index < selected.length && size > MAX_HISTORY_INPUT_BYTES; index += 1) {
    if (required.has(index)) continue;
    selected[index] = -1;
    size = serializedSize(selected.filter((value) => value >= 0));
  }
  if (size > MAX_HISTORY_INPUT_BYTES) fail(ErrorCode.BACKEND_NO_INPUT);
  const kept = new Set(selected.filter((value) => value >= 0));
  return input.filter((_, index) => kept.has(index));
}

function safeUrl(value) {
  if (!isString(value) || value.length === 0 || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function sourcesFromResponse(result) {
  const rows = [];
  let searchFailed = false;
  const output = Array.isArray(result.output) ? result.output : [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type === 'web_search_call' && item.status !== 'completed') searchFailed = true;
    const action = isRecord(item.action) ? item.action : null;
    const actionSources = action && Array.isArray(action.sources) ? action.sources : [];
    for (const source of actionSources) {
      if (!isRecord(source)) continue;
      const url = safeUrl(source.url);
      if (!url) continue;
      rows.push({title: isString(source.title) && source.title.trim() ? source.title : url, url});
    }
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!isRecord(part) || !Array.isArray(part.annotations)) continue;
      for (const annotation of part.annotations) {
        if (!isRecord(annotation) || annotation.type !== 'url_citation') continue;
        const url = safeUrl(annotation.url);
        if (!url) continue;
        rows.push({title: isString(annotation.title) && annotation.title.trim() ? annotation.title : url, url});
      }
    }
  }
  return {
    rows: [...new Map(rows.map((row) => [row.url, row])).values()].slice(0, 20),
    searchFailed,
  };
}

function assertCurrent(active, attemptId) {
  if (!active || active.attemptId !== attemptId || active.cancelled) {
    throw new ProtocolError(ErrorCode.SESSION_CANCELLED);
  }
}

export async function createServices({dataDir, safeStorage, fetchImpl = globalThis.fetch, probeImpl = defaultProbeConnection, confirmCloseImpl = confirmSessionClose} = {}) {
  const store = await createStore({dataDir, safeStorage});
  const initialHistory = await store.loadHistory();
  const knownHistoryIds = new Set(initialHistory.map((item) => item.id));
  const tests = new Map();
  const historyTitleTasks = new Map();
  let activeSession = null;
  let disposed = false;

  function ensureLive() {
    if (disposed) fail(ErrorCode.SESSION_DISPOSED);
  }

  function normalizeTestCredential(kind, credential, current) {
    const publicPart = normalizePublicCredential(credential);
    const provided = isString(credential?.apiKey) ? credential.apiKey.trim() : '';
    const apiKey = provided.length > 0
      ? normalizeApiKey(provided)
      : current && current.endpoint === publicPart.endpoint && current.auth === publicPart.auth
        ? current.apiKey
        : (fail('key_required'), '');
    return {...publicPart, apiKey};
  }

  async function bootstrap() {
    ensureLive();
    const [settings, connections, history] = await Promise.all([
      store.loadSettings(),
      store.loadConnections(),
      store.loadHistory(),
    ]);
    return {version: VERSION, settings, connections, history};
  }

  function cancelHistoryTitle(id) {
    const task = historyTitleTasks.get(id);
    if (!task) return;
    task.controller.abort();
    if (historyTitleTasks.get(id) === task) historyTitleTasks.delete(id);
  }

  function scheduleHistoryTitle(record) {
    if (!record || typeof record.id !== 'string' || record.title) return;
    cancelHistoryTitle(record.id);
    const task = {controller: new AbortController()};
    historyTitleTasks.set(record.id, task);
    void (async () => {
      try {
        if (disposed || task.controller.signal.aborted) return;
        const [settings, credential] = await Promise.all([
          store.loadSettings(),
          store.getCredential('backend'),
        ]);
        if (disposed || task.controller.signal.aborted || !settings.backend.enabled || !credential) return;
        const body = buildTitleRequest(credential.model, record.fragments, settings.locale);
        if (!body) return;
        const result = await fetchJson(
          fetchImpl,
          responsesHttpUrl(credential.endpoint),
          {
            method: 'POST',
            headers: authHeaders(credential.auth, credential.apiKey),
            body: JSON.stringify(body),
          },
          'backend',
          HISTORY_TITLE_TIMEOUT_MS,
          task.controller.signal,
        );
        if (disposed || task.controller.signal.aborted) return;
        const title = parseGeneratedTitle(result);
        if (!title) return;
        // Store performs the final compare-and-set. A manual rename or delete
        // that wins while this request was in flight is never overwritten.
        await store.applyAutoHistoryTitle({id: record.id, title});
      } catch {
        // Automatic naming is best effort. The local date fallback remains and
        // provider details never cross the IPC boundary or enter the UI.
      } finally {
        if (historyTitleTasks.get(record.id) === task) historyTitleTasks.delete(record.id);
      }
    })();
  }

  async function saveSettings({settings, applyBackendToSession = false} = {}) {
    ensureLive();
    if (typeof applyBackendToSession !== 'boolean') fail('invalid_request');
    const session = applyBackendToSession ? activeSession : null;
    if (session?.settings && settings?.backend?.enabled && !session.backendCredential) fail(ErrorCode.BACKEND_NOT_CONFIGURED);
    const saved = await store.saveSettings(settings);
    if (session?.settings && activeSession === session && !session.cancelled) {
      // Replace rather than mutate: an in-flight runBackend retains its snapshot.
      session.settings = {...session.settings, backend: clone(saved.backend)};
    }
    return saved;
  }

  async function saveConnection({kind, credential} = {}) {
    ensureLive();
    return store.saveConnection(kind, credential);
  }

  async function testConnection({requestId, kind, credential} = {}) {
    ensureLive();
    normalizeId(requestId);
    if (kind !== 'voice' && kind !== 'backend') fail(ErrorCode.CONFIG_INVALID);
    if (tests.has(requestId)) fail('test_in_progress');
    if (tests.size >= 2) fail('test_busy');
    const controller = new AbortController();
    tests.set(requestId, controller);
    try {
      const current = await store.getCredential(kind);
      if (controller.signal.aborted) fail('test_cancelled');
      const effective = normalizeTestCredential(kind, credential, current);
      const result = await waitForAbort(
        Promise.resolve().then(() => probeImpl(kind, effective, {signal: controller.signal})),
        controller.signal,
        () => new ServiceError('test_cancelled'),
      );
      if (!result || result.ok !== true || (result.code !== 'voice_ok' && result.code !== 'backend_ok')) {
        fail(kind === 'voice' ? ErrorCode.VOICE_INVALID_RESPONSE : ErrorCode.BACKEND_INVALID_RESPONSE);
      }
      return {ok: true, code: result.code, durationMs: Number.isFinite(result.durationMs) ? Math.max(0, Math.round(result.durationMs)) : 0};
    } catch (error) {
      if (controller.signal.aborted) fail('test_cancelled');
      if (error instanceof ServiceError) throw error;
      const code = errorCode(error, kind === 'voice' ? ErrorCode.VOICE_NETWORK : ErrorCode.BACKEND_NETWORK);
      throw new ServiceError(code);
    } finally {
      if (tests.get(requestId) === controller) tests.delete(requestId);
    }
  }

  async function cancelTest({requestId} = {}) {
    ensureLive();
    normalizeId(requestId);
    tests.get(requestId)?.abort();
    return null;
  }

  async function createSession({attemptId, sdp, mode} = {}) {
    ensureLive();
    normalizeId(attemptId);
    validateSdp(sdp);
    const selectedMode = validateMode(mode);
    if (activeSession && !activeSession.cancelled) fail(ErrorCode.SESSION_ALREADY_ACTIVE);
    const controller = new AbortController();
    const session = {
      attemptId,
      cancelled: false,
      controller,
      voiceCredential: null,
      backendCredential: null,
      settings: null,
      backendController: null,
      backendDelegationId: null,
      sessionId: null,
      closeRequest: null,
    };
    // Reserve the slot before the request starts so a second renderer request
    // cannot race the first one. A failed creation releases it in catch.
    activeSession = session;
    try {
      const [settings, voiceCredential, backendCredential] = await Promise.all([
        store.loadSettings(),
        store.getCredential('voice'),
        store.getCredential('backend'),
      ]);
      assertCurrent(session, attemptId);
      if (!voiceCredential) fail(ErrorCode.CONFIG_INVALID);
      if (settings.backend.enabled && !backendCredential) fail(ErrorCode.BACKEND_NOT_CONFIGURED);
      const snapshot = {...settings, mode: selectedMode};
      session.voiceCredential = voiceCredential;
      session.backendCredential = backendCredential;
      session.settings = snapshot;
      const instructions = buildVoiceInstructions(selectedMode, snapshot.locale, snapshot.voice);
      const value = await fetchJson(
        fetchImpl,
        liveHttpUrl(voiceCredential.endpoint),
        {
          method: 'POST',
          headers: authHeaders(voiceCredential.auth, voiceCredential.apiKey),
          body: JSON.stringify({
            session: {
              model: voiceCredential.model,
              instructions,
              audio: {output: {voice: snapshot.voice.voice}},
              delegation: {type: 'client'},
              store: false,
            },
            transport: {type: 'webrtc', sdp},
          }),
        },
        'voice',
        30_000,
        controller.signal,
      );
      assertCurrent(session, attemptId);
      const result = sessionResult(value);
      assertCurrent(session, attemptId);
      session.sessionId = result.sessionId;
      return {sessionId: result.sessionId, sdp: result.sdp, settings: clone(snapshot)};
    } catch (error) {
      if (session.cancelled || controller.signal.aborted || activeSession !== session) {
        throw new ServiceError(ErrorCode.SESSION_CANCELLED);
      }
      if (activeSession === session) activeSession = null;
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(errorCode(error, ErrorCode.VOICE_NETWORK));
    }
  }

  async function finalizeSession({attemptId} = {}) {
    ensureLive();
    normalizeId(attemptId);
    const session = activeSession;
    assertCurrent(session, attemptId);
    if (!session.sessionId || !session.voiceCredential) fail(ErrorCode.SESSION_CANCELLED);
    if (!session.closeRequest) {
      const credential = session.voiceCredential;
      session.closeRequest = Promise.resolve().then(() => confirmCloseImpl({
        endpoint: credential.endpoint, auth: credential.auth, apiKey: credential.apiKey,
        sessionId: session.sessionId, signal: session.controller.signal,
      })).then(result => ({confirmed: result?.confirmed === true && activeSession === session && !session.cancelled}))
        .catch(() => ({confirmed: false}));
    }
    return session.closeRequest;
  }

  async function cancelSession({attemptId} = {}) {
    ensureLive();
    normalizeId(attemptId);
    if (!activeSession || activeSession.attemptId !== attemptId) return null;
    activeSession.cancelled = true;
    activeSession.controller.abort();
    activeSession.backendController?.abort();
    activeSession = null;
    return null;
  }

  async function runBackend({attemptId, delegationId, history} = {}) {
    ensureLive();
    normalizeId(attemptId);
    normalizeId(delegationId);
    const session = activeSession;
    assertCurrent(session, attemptId);
    if (!session.settings.backend.enabled || !session.backendCredential) {
      fail(ErrorCode.BACKEND_NOT_CONFIGURED);
    }
    if (session.backendController) fail('backend_in_progress');
    const input = inputHistory(history);
    const preferences = session.settings.backend;
    const timeoutSeconds = Number(preferences.timeoutSeconds);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      fail(ErrorCode.CONFIG_INVALID);
    }
    if (!Number.isInteger(preferences.maxOutputTokens) || preferences.maxOutputTokens < 16 || preferences.maxOutputTokens > 32_768) {
      fail(ErrorCode.CONFIG_INVALID);
    }
    const controller = new AbortController();
    session.backendController = controller;
    session.backendDelegationId = delegationId;
    try {
      const body = {
        model: session.backendCredential.model,
        instructions: buildBackendInstructions(session.settings.locale, session.settings.mode, preferences),
        input,
        max_output_tokens: preferences.maxOutputTokens,
        store: false,
      };
      if (preferences.effort !== 'default') body.reasoning = {effort: preferences.effort};
      if (preferences.webSearch) {
        body.tools = [{type: 'web_search'}];
        body.include = ['web_search_call.action.sources'];
      }
      const result = await fetchJson(
        fetchImpl,
        responsesHttpUrl(session.backendCredential.endpoint),
        {
          method: 'POST',
          headers: authHeaders(session.backendCredential.auth, session.backendCredential.apiKey),
          body: JSON.stringify(body),
        },
        'backend',
        Math.min(timeoutSeconds, MAX_TIMEOUT_SECONDS) * 1000,
        controller.signal,
      );
      assertCurrent(session, attemptId);
      if (result.status !== 'completed') {
        if (result.status === 'incomplete') {
          const reason = isRecord(result.incomplete_details) ? result.incomplete_details.reason : undefined;
          if (reason === 'max_output_tokens') throw new ServiceError('backend_token_limit');
          if (reason === 'content_filter') throw new ServiceError('backend_content_filter');
          throw new ProtocolError(ErrorCode.BACKEND_INCOMPLETE);
        }
        throw new ProtocolError(ErrorCode.BACKEND_INVALID_RESPONSE);
      }
      const {rows, searchFailed} = sourcesFromResponse(result);
      if (searchFailed) throw new ProtocolError(ErrorCode.BACKEND_WEB_SEARCH_FAILED);
      if (Array.isArray(result.output) && result.output.some((item) => isRecord(item) && item.type === 'function_call')) {
        throw new ProtocolError(ErrorCode.BACKEND_UNSUPPORTED_OUTPUT);
      }
      const text = extractOutputText(result);
      if (!text) {
        throw new ProtocolError(ErrorCode.BACKEND_EMPTY_OUTPUT);
      }
      return {text, sources: rows};
    } catch (error) {
      if (controller.signal.aborted || session.cancelled || activeSession !== session) {
        throw new ServiceError(ErrorCode.BACKEND_ABORTED);
      }
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(errorCode(error, ErrorCode.BACKEND_NETWORK));
    } finally {
      if (activeSession === session && session.backendController === controller) {
        session.backendController = null;
        session.backendDelegationId = null;
      }
    }
  }

  async function cancelBackend({attemptId} = {}) {
    ensureLive();
    normalizeId(attemptId);
    if (activeSession?.attemptId === attemptId) activeSession.backendController?.abort();
    return null;
  }

  async function saveHistory({record} = {}) {
    ensureLive();
    const recordId = typeof record?.id === 'string' ? record.id : '';
    const alreadyKnown = recordId ? knownHistoryIds.has(recordId) : true;
    if (recordId && !alreadyKnown) knownHistoryIds.add(recordId);
    let history;
    try {
      history = await store.saveHistory({record});
    } catch (error) {
      if (recordId && !alreadyKnown) knownHistoryIds.delete(recordId);
      throw error;
    }
    // The record is durable before any network request starts. Do not await
    // the best-effort title request: closing audio, a new session, and app
    // shutdown must remain independent of it.
    const saved = history.find((item) => item.id === recordId);
    if (!alreadyKnown) scheduleHistoryTitle(saved);
    return history;
  }

  async function loadHistory() {
    ensureLive();
    return store.loadHistory();
  }

  async function renameHistory({id, title} = {}) {
    ensureLive();
    cancelHistoryTitle(id);
    return store.renameHistory({id, title});
  }

  async function deleteHistory({id} = {}) {
    ensureLive();
    cancelHistoryTitle(id);
    const result = await store.deleteHistory({id});
    if (typeof id === 'string') knownHistoryIds.add(id);
    return result;
  }

  async function exportQr({kinds, passphrase} = {}) {
    ensureLive();
    if (!Array.isArray(kinds) || kinds.length === 0 || kinds.length > 2 || kinds.some((kind) => kind !== 'voice' && kind !== 'backend')) {
      fail(ErrorCode.CONFIG_INVALID);
    }
    const selected = [...new Set(kinds)];
    const connections = {};
    for (const kind of selected) {
      const credential = await store.getCredential(kind);
      if (!credential) fail('credential_missing');
      connections[kind] = credential;
    }
    try {
      const payload = await encryptConfig({version: 1, connections}, passphrase);
      return {payload, kinds: selected};
    } catch (error) {
      throw new ServiceError(errorCode(error, 'qr_failed'));
    }
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    for (const controller of tests.values()) controller.abort();
    tests.clear();
    for (const task of historyTitleTasks.values()) task.controller.abort();
    historyTitleTasks.clear();
    if (activeSession) {
      activeSession.cancelled = true;
      activeSession.controller.abort();
      activeSession.backendController?.abort();
      activeSession = null;
    }
    await store.dispose();
  }

  return {
    bootstrap,
    saveSettings,
    saveConnection,
    testConnection,
    cancelTest,
    createSession,
    cancelSession,
    finalizeSession,
    runBackend,
    cancelBackend,
    saveHistory,
    loadHistory,
    renameHistory,
    deleteHistory,
    exportQr,
    dispose,
  };
}
