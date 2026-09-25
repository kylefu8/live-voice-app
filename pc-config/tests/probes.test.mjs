import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';

import {MAX_RESPONSE_BYTES, ProbeError, probeConnection} from '../probes.mjs';

const voiceCredential = {
  endpoint: 'https://voice.example.test/v1/',
  model: 'gpt-live-1',
  auth: 'bearer',
  apiKey: 'synthetic-voice-secret-1234',
};

const backendCredential = {
  endpoint: 'https://backend.example.test/openai/',
  model: 'reasoning-mini',
  auth: 'api-key',
  apiKey: 'synthetic-backend-secret-5678',
};

function assertProbeCode(operation, code) {
  return assert.rejects(operation, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

class ProtocolSocket extends EventEmitter {
  static instances = [];

  constructor(url, protocols, options) {
    super();
    this.url = url;
    this.protocols = protocols;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    ProtocolSocket.instances.push(this);
    setImmediate(() => {
      if (!this.closed) {
        this.readyState = 1;
        this.emit('open');
      }
    });
  }

  send(raw) {
    const value = JSON.parse(raw);
    this.sent.push(value);
    if (value.type === 'session.start') {
      setImmediate(() => this.emit('message', JSON.stringify({type: 'session.started', session: {id: 'session-test-1'}})));
    } else if (value.type === 'session.close' && !this.noCloseConfirmation) {
      setImmediate(() => this.emit('message', JSON.stringify({type: 'session.closed'})));
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    setImmediate(() => this.emit('close'));
  }
}

function completedResponse(text = 'OK') {
  return {
    status: 200,
    text: async () => JSON.stringify({
      status: 'completed',
      output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text}]}],
    }),
  };
}

function response(status, body) {
  return {status, text: async () => body};
}

test('Azure resource roots use the API prefix and explicit/custom paths are preserved', async () => {
  for (const [endpoint, expected] of [
    ['https://speech.example.openai.azure.com/', 'wss://speech.example.openai.azure.com/openai/v1/live/sessions'],
    ['https://speech.example.openai.azure.com/openai', 'wss://speech.example.openai.azure.com/openai/v1/live/sessions'],
    ['https://speech.example.openai.azure.com/openai/v1', 'wss://speech.example.openai.azure.com/openai/v1/live/sessions'],
    ['https://api.openai.com', 'wss://api.openai.com/v1/live/sessions'],
    ['https://gateway.example/custom', 'wss://gateway.example/custom/live/sessions'],
    ['https://gateway.example', 'wss://gateway.example/live/sessions'],
  ]) {
    await probeConnection('voice', {...voiceCredential, endpoint}, {WebSocketImpl: ProtocolSocket});
    assert.equal(ProtocolSocket.instances.at(-1).url, expected);
  }
  let target;
  await probeConnection('backend', {...backendCredential, endpoint:'https://speech.example.openai.azure.com'}, {fetchImpl:async url=>{target=url; return completedResponse();}});
  assert.equal(target,'https://speech.example.openai.azure.com/openai/v1/responses');
});

test('voice probe uses the configured host, both auth styles, exact start/close sequence, and no audio', async () => {
  ProtocolSocket.instances = [];
  const result = await probeConnection('voice', voiceCredential, {WebSocketImpl: ProtocolSocket});
  assert.equal(result.ok, true);
  assert.equal(result.code, 'voice_ok');
  assert.equal(typeof result.durationMs, 'number');
  const socket = ProtocolSocket.instances[0];
  assert.equal(socket.url, 'wss://voice.example.test/v1/live/sessions');
  assert.deepEqual(socket.protocols, []);
  assert.equal(socket.options.followRedirects, false);
  assert.equal(socket.options.maxPayload, MAX_RESPONSE_BYTES);
  assert.equal(socket.options.perMessageDeflate, false);
  assert.equal(socket.options.headers.Authorization, `Bearer ${voiceCredential.apiKey}`);
  assert.equal(socket.options.headers['api-key'], undefined);
  assert.deepEqual(socket.sent.map((item) => item.type), ['session.start', 'session.close']);
  assert.deepEqual(socket.sent[0].session, {
    model: voiceCredential.model,
    audio: {format: {type: 'audio/pcm', rate: 24000}, output: {voice: 'marin'}},
    delegation: {type: 'client'},
    store: false,
  });
  assert.equal(socket.sent.some((item) => item.type === 'input_audio_buffer.append'), false);

  class ApiKeySocket extends ProtocolSocket {}
  const apiKeyResult = await probeConnection('voice', {...voiceCredential, auth: 'api-key'}, {WebSocketImpl: ApiKeySocket});
  const apiKeySocket = ProtocolSocket.instances.at(-1);
  assert.equal(apiKeyResult.code, 'voice_ok');
  assert.equal(apiKeySocket.options.headers['api-key'], voiceCredential.apiKey);
  assert.equal(apiKeySocket.options.headers.Authorization, undefined);
});

test('backend probe sends the bounded Responses request and validates structured output', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = {url, init, signal: init.signal};
    return completedResponse('OK');
  };
  const result = await probeConnection('backend', backendCredential, {fetchImpl});
  assert.equal(result.ok, true);
  assert.equal(result.code, 'backend_ok');
  assert.equal(captured.url, 'https://backend.example.test/openai/responses');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.redirect, 'manual');
  assert.equal(captured.init.headers['api-key'], backendCredential.apiKey);
  assert.equal(captured.init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(captured.init.body), {
    model: backendCredential.model,
    input: 'Reply with OK.',
    max_output_tokens: 64,
    store: false,
  });
  assert.equal(captured.signal.aborted, false);
});

test('backend maps statuses and exact provider codes without using response prose', async () => {
  for (const [status, code] of [[401, 'auth_failed'], [403, 'access_denied'], [404, 'endpoint_not_found'], [408, 'timeout'], [429, 'rate_limited'], [500, 'service_unavailable'], [400, 'request_rejected'], [302, 'redirect_refused']]) {
    await assertProbeCode(
      probeConnection('backend', backendCredential, {fetchImpl: async () => response(status, '{}')}),
      code,
    );
  }
  await assertProbeCode(
    probeConnection('backend', backendCredential, {
      fetchImpl: async () => response(404, JSON.stringify({error: {code: 'model_not_found', message: 'arbitrary text'}})),
    }),
    'model_unavailable',
  );
  await assertProbeCode(
    probeConnection('backend', backendCredential, {
      fetchImpl: async () => response(404, JSON.stringify({error: {code: 'other_code', message: 'model not found'}})),
    }),
    'endpoint_not_found',
  );
});

test('backend rejects malformed, empty, incomplete, and oversized responses', async () => {
  for (const body of ['not json', JSON.stringify({status: 'completed', output: []}), JSON.stringify({status: 'completed', output: [{type: 'message', content: []}]}), JSON.stringify({status: 'failed', output: []})]) {
    await assertProbeCode(
      probeConnection('backend', backendCredential, {fetchImpl: async () => response(200, body)}),
      'invalid_response',
    );
  }
  await assertProbeCode(
    probeConnection('backend', backendCredential, {fetchImpl: async () => response(200, JSON.stringify({status: 'incomplete', output: [{type: 'message', content: [{type: 'output_text', text: 'partial'}]}]}))}),
    'response_incomplete',
  );
  await assertProbeCode(
    probeConnection('backend', backendCredential, {fetchImpl: async () => response(200, 'x'.repeat(MAX_RESPONSE_BYTES + 1))}),
    'invalid_response',
  );
});

test('voice handles malformed events, early transport close, upgrade rejection, cancellation, and close timeout', async () => {
  class MalformedSocket extends ProtocolSocket {
    send(raw) {
      const value = JSON.parse(raw);
      this.sent.push(value);
      if (value.type === 'session.start') setImmediate(() => this.emit('message', '{bad json'));
    }
  }
  await assertProbeCode(probeConnection('voice', voiceCredential, {WebSocketImpl: MalformedSocket}), 'invalid_response');

  class EarlyCloseSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 0;
      setImmediate(() => this.emit('close'));
    }
    close() {}
  }
  await assertProbeCode(probeConnection('voice', voiceCredential, {WebSocketImpl: EarlyCloseSocket}), 'network_error');

  class UpgradeSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 0;
      setImmediate(() => this.emit('unexpected-response', null, {statusCode: 302}));
    }
    close() {}
  }
  await assertProbeCode(probeConnection('voice', voiceCredential, {WebSocketImpl: UpgradeSocket}), 'redirect_refused');

  class HangingSocket extends ProtocolSocket {
    send() {}
  }
  const cancelController = new AbortController();
  const cancelled = probeConnection('voice', voiceCredential, {WebSocketImpl: HangingSocket, signal: cancelController.signal, timeoutMs: 1000});
  setTimeout(() => cancelController.abort(), 5);
  await assertProbeCode(cancelled, 'cancelled');

  class UnconfirmedSocket extends ProtocolSocket {
    constructor(url, protocols, options) {
      super(url, protocols, options);
      this.noCloseConfirmation = true;
    }
  }
  await assertProbeCode(probeConnection('voice', voiceCredential, {WebSocketImpl: UnconfirmedSocket, timeoutMs: 1000, closeTimeoutMs: 10}), 'close_unconfirmed');
});

test('backend cancellation and body timeout are fixed-code errors and never expose secrets', async () => {
  const controller = new AbortController();
  const pending = probeConnection('backend', backendCredential, {
    signal: controller.signal,
    fetchImpl: async () => new Promise(() => {}),
    timeoutMs: 1000,
  });
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'cancelled');
    assert.equal(error.message, 'cancelled');
    assert.equal(error.message.includes(backendCredential.apiKey), false);
    assert.equal(error.message.includes(backendCredential.endpoint), false);
    return true;
  });

  await assertProbeCode(
    probeConnection('backend', backendCredential, {
      timeoutMs: 10,
      fetchImpl: async () => ({status: 200, text: () => new Promise(() => {})}),
    }),
    'timeout',
  );
});

test('validation is shared with QR config and rejects masked keys before any transport', async () => {
  let called = false;
  await assertProbeCode(
    probeConnection('backend', {...backendCredential, apiKey: 'sk-...5678'}, {fetchImpl: async () => { called = true; return completedResponse(); }}),
    'invalid_key',
  );
  assert.equal(called, false);
  await assert.rejects(
    probeConnection('other', backendCredential, {fetchImpl: async () => completedResponse()}),
    (error) => error.code === 'invalid_config' && error.message === 'invalid_config',
  );
});

test('provider errors do not leak raw transport details', async () => {
  const secretUrl = backendCredential.endpoint;
  const secretKey = backendCredential.apiKey;
  await assert.rejects(
    probeConnection('backend', backendCredential, {
      fetchImpl: async () => { throw new Error(`failed ${secretUrl} ${secretKey}`); },
    }),
    (error) => {
      assert.equal(error.code, 'network_error');
      assert.equal(error.message, 'network_error');
      assert.equal(error.message.includes(secretUrl), false);
      assert.equal(error.message.includes(secretKey), false);
      return true;
    },
  );
  assert.equal(new ProbeError('not-a-public-code').message, 'network_error');
});
