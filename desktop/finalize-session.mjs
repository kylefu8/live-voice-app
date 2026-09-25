import WebSocket from 'ws';

import {authHeaders, liveHttpUrl, newEventId} from '../native/src/protocol.ts';

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_SESSION_ID_LENGTH = 256;
const HANDSHAKE_TIMEOUT_MS = 4_000;
const OVERALL_TIMEOUT_MS = 7_000;

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function addSocketListener(socket, event, handler) {
  if (typeof socket?.on === 'function') {
    socket.on(event, handler);
    return () => {
      try {
        if (typeof socket.off === 'function') socket.off(event, handler);
        else socket.removeListener?.(event, handler);
      } catch {
        // Socket cleanup is best effort.
      }
    };
  }
  if (typeof socket?.addEventListener === 'function') {
    socket.addEventListener(event, handler);
    return () => {
      try {
        socket.removeEventListener?.(event, handler);
      } catch {
        // Socket cleanup is best effort.
      }
    };
  }
  const property = `on${event}`;
  try {
    socket[property] = handler;
  } catch {
    return () => {};
  }
  return () => {
    try {
      if (socket[property] === handler) socket[property] = null;
    } catch {
      // Socket cleanup is best effort.
    }
  };
}

function socketReadyState(socket) {
  const state = Number(socket?.readyState);
  return Number.isInteger(state) ? state : null;
}

function messageText(raw) {
  const value = raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw;
  if (typeof value === 'string') return value.length <= MAX_PAYLOAD_BYTES ? value : null;
  if (Buffer.isBuffer(value)) return value.byteLength <= MAX_PAYLOAD_BYTES ? value.toString('utf8') : null;
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > MAX_PAYLOAD_BYTES) return null;
    return Buffer.from(value).toString('utf8');
  }
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength > MAX_PAYLOAD_BYTES) return null;
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  }
  return null;
}

function closeSocket(socket, force = false) {
  try {
    const state = socketReadyState(socket);
    if (force && typeof socket?.terminate === 'function') {
      if (state === null || state === 0 || state === 1 || state === 2) socket.terminate();
      return;
    }
    if (state === null || state === 0 || state === 1 || state === 2) socket?.close?.();
  } catch {
    try {
      socket?.terminate?.();
    } catch {
      // Socket cleanup is best effort.
    }
  }
}

function attachUrl(endpoint, sessionId) {
  const httpUrl = liveHttpUrl(endpoint);
  return `${httpUrl.replace(/\/+$/u, '')}/${encodeURIComponent(sessionId)}/attach`.replace(/^https:/u, 'wss:');
}

/**
 * Attach to an existing Live WebRTC session and confirm its server-side close.
 * This deliberately sends no session.start and treats every failure as an
 * unconfirmed close so callers can keep their normal cleanup path.
 */
export async function confirmSessionClose({
  endpoint,
  sessionId,
  auth,
  apiKey,
  signal,
  WebSocketImpl = WebSocket,
} = {}) {
  if (signal?.aborted) return {confirmed: false};

  let socket;
  try {
    if (
      typeof endpoint !== 'string' ||
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      sessionId.length > MAX_SESSION_ID_LENGTH
    ) {
      return {confirmed: false};
    }
    if (typeof WebSocketImpl !== 'function') return {confirmed: false};
    const url = attachUrl(endpoint, sessionId);
    const headers = authHeaders(auth, apiKey);
    socket = new WebSocketImpl(url, [], {
      headers,
      followRedirects: false,
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
  } catch {
    return {confirmed: false};
  }

  try {
    return await new Promise((resolve) => {
    let settled = false;
    let closeSent = false;
    let handshakeTimer = null;
    let overallTimer = null;
    const removers = [];

    const keepErrorSink = () => {
      if (typeof socket?.on === 'function') {
        try {
          socket.on('error', () => {});
        } catch {
          // Keep cleanup best effort.
        }
      }
    };

    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      if (overallTimer) clearTimeout(overallTimer);
      handshakeTimer = null;
      overallTimer = null;
      try {
        signal?.removeEventListener?.('abort', onAbort);
      } catch {
        // Abort listener cleanup is best effort.
      }
      for (const remove of removers.splice(0)) remove();
      // Keep an error sink while the transport finishes its final teardown;
      // the confirmation event itself is the only success signal.
      keepErrorSink();
      closeSocket(socket, true);
      resolve({confirmed});
    };

    const onAbort = () => finish(false);
    const onOpen = () => {
      if (settled || closeSent) return;
      if (signal?.aborted) {
        finish(false);
        return;
      }
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
      closeSent = true;
      try {
        socket.send(JSON.stringify({type: 'session.close', event_id: newEventId('session-close')}));
      } catch {
        finish(false);
      }
    };
    const onMessage = (raw) => {
      if (settled || !closeSent) return;
      let text;
      try {
        text = messageText(raw);
      } catch {
        return;
      }
      if (text === null) return;
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return;
      }
      if (!isRecord(value) || value.type !== 'session.closed') return;
      const session = isRecord(value.session) ? value.session : null;
      if (session && Object.prototype.hasOwnProperty.call(session, 'id') && session.id !== sessionId) return;
      finish(true);
    };
    const onError = () => finish(false);
    const onClose = () => finish(false);
    const onUnexpectedResponse = () => finish(false);

    try {
      removers.push(addSocketListener(socket, 'open', onOpen));
      removers.push(addSocketListener(socket, 'message', onMessage));
      removers.push(addSocketListener(socket, 'error', onError));
      removers.push(addSocketListener(socket, 'close', onClose));
      removers.push(addSocketListener(socket, 'unexpected-response', onUnexpectedResponse));

      if (signal?.aborted) {
        finish(false);
        return;
      }
      signal?.addEventListener?.('abort', onAbort, {once: true});
      handshakeTimer = setTimeout(() => finish(false), HANDSHAKE_TIMEOUT_MS);
      overallTimer = setTimeout(() => finish(false), OVERALL_TIMEOUT_MS);
    } catch {
      finish(false);
    }
    });
  } catch {
    closeSocket(socket, true);
    return {confirmed: false};
  }
}
