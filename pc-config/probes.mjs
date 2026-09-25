import WebSocket from 'ws';

import { validateConfig } from './crypto.mjs';

// A probe is deliberately small and bounded. It proves that a configured
// endpoint can authenticate, accept the selected model, and complete the
// protocol handshake without sending microphone audio or storing a response.
export const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 8_000;

const PROBE_CODES = new Set([
  'auth_failed',
  'access_denied',
  'model_unavailable',
  'endpoint_not_found',
  'request_rejected',
  'rate_limited',
  'service_unavailable',
  'network_error',
  'timeout',
  'cancelled',
  'invalid_response',
  'response_incomplete',
  'close_unconfirmed',
  'redirect_refused',
]);

// These are exact provider error codes. In particular, messages are never
// searched for words such as "model" because that would turn arbitrary
// provider prose into a classification decision.
const MODEL_ERROR_CODES = new Set([
  'model_not_found',
  'model_unavailable',
  'model_not_available',
  'deployment_not_found',
  'deployment_unavailable',
  'deployment_not_available',
]);

const AUTH_ERROR_CODES = new Set(['invalid_api_key', 'invalid_api_key_format', 'authentication_error']);
const ACCESS_ERROR_CODES = new Set(['permission_denied', 'insufficient_permissions', 'access_denied']);
const RATE_ERROR_CODES = new Set(['rate_limit_exceeded', 'rate_limited']);
const SERVICE_ERROR_CODES = new Set(['server_error', 'service_unavailable', 'overloaded']);

export class ProbeError extends Error {
  constructor(code) {
    const stableCode = PROBE_CODES.has(code) ? code : 'network_error';
    super(stableCode);
    this.name = 'ProbeError';
    this.code = stableCode;
  }
}

function fail(code) {
  throw new ProbeError(code);
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeCredential(kind, credential) {
  // Reuse the QR schema validator so manual PC tests and imported mobile
  // configurations apply exactly the same endpoint, auth, and key rules.
  const normalized = validateConfig({version: 1, connections: {[kind]: credential}});
  return normalized.connections[kind];
}

function normalizeTimeout(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) fail('timeout');
  return Math.max(1, Math.floor(value));
}

function nowMs() {
  if (typeof performance?.now === 'function') return performance.now();
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function eventId(prefix) {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return `${prefix}_${globalThis.crypto.randomUUID()}`;
    }
  } catch {
    // Fall through to a non-secret best-effort event id.
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function authHeaders(credential) {
  const headers = {'Content-Type': 'application/json'};
  if (credential.auth === 'api-key') headers['api-key'] = credential.apiKey;
  else headers.Authorization = `Bearer ${credential.apiKey}`;
  return headers;
}

function endpointPath(endpoint, suffix) {
  const url = new URL(endpoint);
  let path = url.pathname.replace(/\/+$/u, '');
  // Azure portal endpoints are resource roots, not the OpenAI API base path.
  // Only fill known provider prefixes; preserve custom gateways and paths.
  if (url.hostname.endsWith('.openai.azure.com') && (path === '' || path === '/openai')) path = '/openai/v1';
  else if (url.hostname === 'api.openai.com' && path === '') path = '/v1';
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  if (path.endsWith(normalizedSuffix)) return url;
  url.pathname = `${path}${normalizedSuffix}`;
  return url;
}

function responsesUrl(endpoint) {
  return endpointPath(endpoint, '/responses').toString();
}

function voiceUrl(endpoint) {
  const url = endpointPath(endpoint, '/live/sessions');
  url.protocol = 'wss:';
  return url.toString();
}

function operationDeadline(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    controller.abort();
  };

  if (parentSignal) {
    if (parentSignal.aborted) onAbort();
    else parentSignal.addEventListener('abort', onAbort, {once: true});
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    get cancelled() {
      return cancelled || Boolean(parentSignal?.aborted);
    },
    abortError() {
      if (cancelled || parentSignal?.aborted) return new ProbeError('cancelled');
      if (timedOut) return new ProbeError('timeout');
      return new ProbeError('network_error');
    },
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
    },
  };
}

function withAbort(promise, signal, abortError) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    if (signal?.aborted) {
      onAbort();
      // Promise.resolve below still receives handlers, so a body/fetch
      // promise that was created just before this race cannot become an
      // unhandled rejection.
    }
    signal.addEventListener('abort', onAbort, {once: true});
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function byteLength(value) {
  if (typeof Buffer === 'function') return Buffer.byteLength(value, 'utf8');
  return new TextEncoder().encode(value).byteLength;
}

function decodeBytes(chunks, total) {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    fail('invalid_response');
  }
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

async function readResponseBody(response) {
  if (!response || typeof response !== 'object') fail('invalid_response');

  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (!next || typeof next !== 'object') fail('invalid_response');
        if (next.done) break;
        const chunk = asUint8Array(next.value);
        if (!chunk) fail('invalid_response');
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // The response is already being rejected; cleanup is best effort.
          }
          fail('invalid_response');
        }
        chunks.push(new Uint8Array(chunk));
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Some test doubles do not implement releaseLock.
      }
    }
    return decodeBytes(chunks, total);
  }

  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const value of body) {
      const chunk = asUint8Array(value) ?? (typeof value === 'string' ? new TextEncoder().encode(value) : null);
      if (!chunk) fail('invalid_response');
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) fail('invalid_response');
      chunks.push(new Uint8Array(chunk));
    }
    return decodeBytes(chunks, total);
  }

  if (typeof response.text !== 'function') fail('invalid_response');
  let text;
  try {
    text = await response.text();
  } catch {
    fail('invalid_response');
  }
  if (typeof text !== 'string' || byteLength(text) > MAX_RESPONSE_BYTES) fail('invalid_response');
  return text;
}

function parseJsonObject(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('invalid_response');
  }
  if (!isRecord(value)) fail('invalid_response');
  return value;
}

function exactProviderCode(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const error = isRecord(value) && isRecord(value.error) ? value.error : null;
  const candidates = [error?.code, isRecord(value) ? value.code : undefined];
  return candidates.find((code) => typeof code === 'string' && code.length <= 128) ?? null;
}

function mapProviderCode(code) {
  if (MODEL_ERROR_CODES.has(code)) return 'model_unavailable';
  if (AUTH_ERROR_CODES.has(code)) return 'auth_failed';
  if (ACCESS_ERROR_CODES.has(code)) return 'access_denied';
  if (RATE_ERROR_CODES.has(code)) return 'rate_limited';
  if (SERVICE_ERROR_CODES.has(code)) return 'service_unavailable';
  return null;
}

function mapHttpStatus(status, bodyText = '') {
  const providerCode = mapProviderCode(exactProviderCode(bodyText));
  if (providerCode) return providerCode;
  if (status >= 300 && status < 400) return 'redirect_refused';
  if (status === 401) return 'auth_failed';
  if (status === 403) return 'access_denied';
  if (status === 404) return 'endpoint_not_found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status <= 599) return 'service_unavailable';
  if (status >= 400 && status <= 499) return 'request_rejected';
  return 'network_error';
}

function transportError(error, deadline) {
  if (error instanceof ProbeError) return error;
  if (deadline.cancelled) return new ProbeError('cancelled');
  if (deadline.timedOut) return new ProbeError('timeout');
  return new ProbeError('network_error');
}

function outputText(value) {
  if (!isRecord(value) || !Array.isArray(value.output)) return '';
  const parts = [];
  for (const item of value.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== 'output_text' || typeof part.text !== 'string') continue;
      if (part.text.trim()) parts.push(part.text.trim());
    }
  }
  return parts.join('\n').trim();
}

async function probeBackend(credential, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') fail('network_error');
  const deadline = operationDeadline(options.signal, options.timeoutMs);
  const body = JSON.stringify({
    model: credential.model,
    input: 'Reply with OK.',
    max_output_tokens: 64,
    store: false,
  });

  try {
    if (deadline.signal.aborted) throw deadline.abortError();
    let response;
    try {
      response = await withAbort(
        fetchImpl(responsesUrl(credential.endpoint), {
          method: 'POST',
          headers: authHeaders(credential),
          body,
          redirect: 'manual',
          signal: deadline.signal,
        }),
        deadline.signal,
        () => deadline.abortError(),
      );
    } catch (error) {
      throw transportError(error, deadline);
    }

    const status = Number(response?.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) fail('invalid_response');

    let text = '';
    try {
      text = await withAbort(readResponseBody(response), deadline.signal, () => deadline.abortError());
    } catch (error) {
      if (error instanceof ProbeError && error.code !== 'invalid_response') throw error;
      if (status >= 400 || status >= 300 && status < 400) {
        text = '';
      } else {
        throw error instanceof ProbeError ? error : new ProbeError('invalid_response');
      }
    }

    if (status >= 300 && status < 400) fail('redirect_refused');
    if (status < 200 || status >= 300) fail(mapHttpStatus(status, text));

    const result = parseJsonObject(text);
    if (result.status === 'incomplete') fail('response_incomplete');
    if (result.status !== 'completed') fail('invalid_response');
    if (!outputText(result)) fail('invalid_response');
  } finally {
    deadline.cleanup();
  }
}

function socketReadyState(socket) {
  return typeof socket?.readyState === 'number' ? socket.readyState : null;
}

function addSocketListener(socket, event, handler) {
  if (typeof socket?.on === 'function') {
    socket.on(event, handler);
    return () => {
      try {
        if (typeof socket.off === 'function') socket.off(event, handler);
        else if (typeof socket.removeListener === 'function') socket.removeListener(event, handler);
      } catch {
        // Cleanup is best effort.
      }
    };
  }
  if (typeof socket?.addEventListener === 'function') {
    socket.addEventListener(event, handler);
    return () => {
      try {
        socket.removeEventListener?.(event, handler);
      } catch {
        // Cleanup is best effort.
      }
    };
  }
  const property = `on${event}`;
  socket[property] = handler;
  return () => {
    try {
      if (socket[property] === handler) socket[property] = null;
    } catch {
      // Cleanup is best effort.
    }
  };
}

function socketMessageData(data) {
  if (data && typeof data === 'object' && 'data' in data) data = data.data;
  if (typeof data === 'string') {
    if (byteLength(data) > MAX_RESPONSE_BYTES) fail('invalid_response');
    return data;
  }
  const bytes = asUint8Array(data);
  if (!bytes || bytes.byteLength > MAX_RESPONSE_BYTES) fail('invalid_response');
  return decodeBytes([new Uint8Array(bytes)], bytes.byteLength);
}

function mapSocketErrorCode(value) {
  if (!isRecord(value)) return null;
  const error = isRecord(value.error) ? value.error : null;
  const code = typeof error?.code === 'string' ? error.code : typeof value.code === 'string' ? value.code : null;
  return mapProviderCode(code);
}

async function probeVoice(credential, options) {
  const Socket = options.WebSocketImpl ?? WebSocket;
  if (typeof Socket !== 'function') fail('network_error');
  // Start and close confirmation are separate protocol phases. The phase
  // timers below decide their public error code; this controller remains
  // alive through both phases so a slow start cannot steal close_unconfirmed.
  const deadline = operationDeadline(options.signal, options.timeoutMs + options.closeTimeoutMs);
  if (deadline.signal.aborted) {
    const error = deadline.abortError();
    deadline.cleanup();
    throw error;
  }
  const headers = authHeaders(credential);
  const socketOptions = {
    headers,
    followRedirects: false,
    maxPayload: MAX_RESPONSE_BYTES,
    perMessageDeflate: false,
  };
  let socket;
  try {
    socket = new Socket(voiceUrl(credential.endpoint), [], socketOptions);
  } catch (error) {
    deadline.cleanup();
    throw transportError(error, deadline);
  }

  let phase = 'starting';
  let settled = false;
  let timer = null;
  const removers = [];
  let resolveProbe;
  let rejectProbe;
  const promise = new Promise((resolve, reject) => {
    resolveProbe = resolve;
    rejectProbe = reject;
  });

  const noOpErrorHandler = () => {};
  const keepErrorSink = () => {
    // Node's EventEmitter treats an error without a listener as an uncaught
    // exception. Keep a sink while close/terminate is in flight.
    if (typeof socket?.on === 'function') {
      try {
        socket.on('error', noOpErrorHandler);
      } catch {
        // Ignore test doubles without a normal event emitter.
      }
    } else if (socket) {
      try {
        socket.onerror = noOpErrorHandler;
      } catch {
        // Ignore test doubles with read-only properties.
      }
    }
  };

  const closeSocket = (force = false) => {
    keepErrorSink();
    try {
      const state = socketReadyState(socket);
      if (force && typeof socket.terminate === 'function') {
        if (state === null || state === 0 || state === 1 || state === 2) socket.terminate();
        return;
      }
      if (state === null || state === 0 || state === 1 || state === 2) socket.close?.();
    } catch {
      try {
        socket.terminate?.();
      } catch {
        // Ignore cleanup errors.
      }
    }
  };

  const finish = (error) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    deadline.cleanup();
    for (const remove of removers.splice(0)) remove();
    if (error) {
      keepErrorSink();
      closeSocket(true);
      rejectProbe(error);
    } else {
      closeSocket();
      resolveProbe();
    }
  };

  const arm = (milliseconds, code) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => finish(new ProbeError(code)), milliseconds);
  };

  const abortHandler = () => finish(deadline.abortError());
  if (deadline.signal.aborted) abortHandler();
  else deadline.signal.addEventListener('abort', abortHandler, {once: true});
  if (settled) return promise;

  const sendStart = () => {
    try {
      socket.send(JSON.stringify({
        type: 'session.start',
        event_id: eventId('probe'),
        session: {
          model: credential.model,
          audio: {format: {type: 'audio/pcm', rate: 24_000}, output: {voice: 'marin'}},
          delegation: {type: 'client'},
          store: false,
        },
      }));
    } catch {
      finish(new ProbeError('network_error'));
    }
  };

  const onOpen = () => {
    if (settled) return;
    sendStart();
  };

  const onMessage = (raw) => {
    if (settled) return;
    let text;
    try {
      text = socketMessageData(raw);
    } catch (error) {
      finish(error instanceof ProbeError ? error : new ProbeError('invalid_response'));
      return;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      finish(new ProbeError('invalid_response'));
      return;
    }
    if (!isRecord(value) || typeof value.type !== 'string') {
      finish(new ProbeError('invalid_response'));
      return;
    }
    if (value.type === 'error' || value.type === 'session.error') {
      finish(new ProbeError(mapSocketErrorCode(value) ?? 'request_rejected'));
      return;
    }
    if (value.type === 'session.started' && phase === 'starting') {
      const session = isRecord(value.session) ? value.session : null;
      if (!session || typeof session.id !== 'string' || session.id.trim() === '') {
        finish(new ProbeError('invalid_response'));
        return;
      }
      phase = 'closing';
      arm(options.closeTimeoutMs, 'close_unconfirmed');
      try {
        socket.send(JSON.stringify({type: 'session.close', event_id: eventId('probe-close')}));
      } catch {
        finish(new ProbeError('network_error'));
      }
      return;
    }
    if (value.type === 'session.closed' && phase === 'closing') {
      phase = 'done';
      finish();
    }
  };

  const onError = () => {
    if (!settled) finish(new ProbeError('network_error'));
  };

  const onUnexpectedResponse = (_request, response) => {
    if (settled) return;
    try {
      response?.destroy?.();
      response?.resume?.();
    } catch {
      // Upgrade rejection cleanup is best effort and must not leak details.
    }
    const status = Number(response?.statusCode);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      finish(new ProbeError('network_error'));
      return;
    }
    if (status >= 300 && status < 400) finish(new ProbeError('redirect_refused'));
    else finish(new ProbeError(mapHttpStatus(status)));
  };

  const onClose = () => {
    if (settled) return;
    if (deadline.cancelled) finish(new ProbeError('cancelled'));
    else if (phase === 'closing') finish(new ProbeError('close_unconfirmed'));
    else finish(new ProbeError('network_error'));
  };

  removers.push(addSocketListener(socket, 'open', onOpen));
  removers.push(addSocketListener(socket, 'message', onMessage));
  removers.push(addSocketListener(socket, 'error', onError));
  removers.push(addSocketListener(socket, 'unexpected-response', onUnexpectedResponse));
  removers.push(addSocketListener(socket, 'close', onClose));
  arm(options.timeoutMs, 'timeout');
  return promise;
}

/**
 * Test one complete voice or backend connection without persisting data.
 * The returned duration is measured only for the network/protocol probe.
 */
export async function probeConnection(
  kind,
  credential,
  {
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = WebSocket,
  } = {},
) {
  const normalized = normalizeCredential(kind, credential);
  const operation = {
    signal,
    timeoutMs: normalizeTimeout(timeoutMs, DEFAULT_TIMEOUT_MS),
    closeTimeoutMs: normalizeTimeout(closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
    fetchImpl,
    WebSocketImpl,
  };
  const started = nowMs();
  if (kind === 'voice') {
    await probeVoice(normalized, operation);
    return {ok: true, code: 'voice_ok', durationMs: Math.max(0, Math.round(nowMs() - started))};
  }
  if (kind === 'backend') {
    await probeBackend(normalized, operation);
    return {ok: true, code: 'backend_ok', durationMs: Math.max(0, Math.round(nowMs() - started))};
  }
  // normalizeCredential normally rejects this first; retain a fixed error if
  // a custom validator ever changes that behavior.
  fail('invalid_response');
}
