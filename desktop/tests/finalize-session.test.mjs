import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';

import {confirmSessionClose} from '../finalize-session.mjs';

class FakeSocket extends EventEmitter {
  static instances = [];

  constructor(url, protocols, options) {
    super();
    this.url = url;
    this.protocols = protocols;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    this.terminated = false;
    FakeSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }

  terminate() {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close');
  }

  message(value) {
    this.emit('message', value);
  }
}

function nextSocket() {
  return new Promise((resolve) => {
    const check = () => {
      if (FakeSocket.instances.length > 0) resolve(FakeSocket.instances.at(-1));
      else setImmediate(check);
    };
    check();
  });
}

function resetSockets() {
  FakeSocket.instances = [];
}

test('attaches to the encoded session URL and confirms only a matching session.closed', async () => {
  resetSockets();
  const sessionId = 'session /?&';
  const pending = confirmSessionClose({
    endpoint: 'https://voice.example.test/openai/v1',
    sessionId,
    auth: 'bearer',
    apiKey: 'secret-key',
    WebSocketImpl: FakeSocket,
  });
  const socket = await nextSocket();
  assert.equal(socket.url, `wss://voice.example.test/openai/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`);
  assert.equal(socket.options.followRedirects, false);
  assert.equal(socket.options.maxPayload, 256 * 1024);
  assert.equal(socket.options.headers.Authorization, 'Bearer secret-key');
  socket.open();
  assert.deepEqual(socket.sent.map((value) => value.type), ['session.close']);
  socket.message(JSON.stringify({type: 'session.closed', session: {id: 'other-session'}}));
  assert.equal(socket.sent.length, 1);
  socket.message(JSON.stringify({type: 'session.closed', session: {id: sessionId}}));
  assert.deepEqual(await pending, {confirmed: true});
  assert.equal(socket.terminated, true);
  assert.equal(socket.sent.some((value) => value.type === 'session.start'), false);
  assert.equal(socket.sent.some((value) => JSON.stringify(value).includes('secret-key')), false);
});

test('does not treat an early close event, socket open, or an HTTP response as confirmation', async () => {
  resetSockets();
  const pending = confirmSessionClose({
    endpoint: 'https://voice.example.test/v1',
    sessionId: 'early-close',
    auth: 'api-key',
    apiKey: 'secret-key',
    WebSocketImpl: FakeSocket,
  });
  const socket = await nextSocket();
  socket.message(JSON.stringify({type: 'session.closed', session: {id: 'early-close'}}));
  socket.emit('unexpected-response', {}, {statusCode: 200});
  assert.deepEqual(await pending, {confirmed: false});
});

test('wrong session id followed by socket close is unconfirmed and sends one close command', async () => {
  resetSockets();
  const pending = confirmSessionClose({
    endpoint: 'https://voice.example.test/v1',
    sessionId: 'retained-session',
    auth: 'bearer',
    apiKey: 'secret-key',
    WebSocketImpl: FakeSocket,
  });
  const socket = await nextSocket();
  socket.open();
  socket.message(JSON.stringify({type: 'session.closed', session: {id: 'wrong-session'}}));
  assert.equal(socket.sent.length, 1);
  socket.emit('close');
  assert.deepEqual(await pending, {confirmed: false});
});

test('caller abort terminates a pending attach without sending session.close', async () => {
  resetSockets();
  const controller = new AbortController();
  const pending = confirmSessionClose({
    endpoint: 'https://voice.example.test/v1',
    sessionId: 'abort-session',
    auth: 'bearer',
    apiKey: 'secret-key',
    signal: controller.signal,
    WebSocketImpl: FakeSocket,
  });
  const socket = await nextSocket();
  controller.abort();
  assert.deepEqual(await pending, {confirmed: false});
  assert.equal(socket.sent.length, 0);
  assert.equal(socket.terminated, true);
});

test('handshake timeout is bounded and returns only a safe result', async () => {
  resetSockets();
  const started = Date.now();
  const result = await confirmSessionClose({
    endpoint: 'https://voice.example.test/v1',
    sessionId: 'timeout-session',
    auth: 'bearer',
    apiKey: 'secret-key',
    WebSocketImpl: FakeSocket,
  });
  assert.deepEqual(result, {confirmed: false});
  assert.ok(Date.now() - started >= 3_500);
  assert.ok(Date.now() - started < 5_500);
  assert.equal(Object.keys(result).join(','), 'confirmed');
});
