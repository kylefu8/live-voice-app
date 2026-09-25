import test from 'node:test';
import assert from 'node:assert/strict';

import {createDesktopLive} from '../renderer/live.ts';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('test_condition_timeout');
    await flush();
  }
}

class FakeTrack {
  constructor() {
    this.enabled = true;
    this.stopped = false;
    this.listeners = new Map();
  }

  stop() {
    this.stopped = true;
  }

  addEventListener(type, listener) {
    const values = this.listeners.get(type) ?? new Set();
    values.add(listener);
    this.listeners.set(type, values);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

class FakeStream {
  constructor(track = new FakeTrack()) {
    this.track = track;
  }

  getAudioTracks() {
    return [this.track];
  }

  getTracks() {
    return [this.track];
  }
}

class FakeChannel {
  constructor() {
    this.readyState = 'open';
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.readyState = 'closed';
  }

  emit(value) {
    this.onmessage?.({data: JSON.stringify(value)});
  }
}

class FakePeer {
  static instances = [];

  constructor() {
    this.iceGatheringState = 'complete';
    this.iceConnectionState = 'connected';
    this.connectionState = 'connected';
    this.localDescription = null;
    this.remoteDescription = null;
    this.channel = null;
    this.tracks = [];
    this.closed = false;
    FakePeer.instances.push(this);
  }

  addTrack(track, stream) {
    this.tracks.push({track, stream});
  }

  createDataChannel(label) {
    assert.equal(label, 'oai-events');
    this.channel = new FakeChannel();
    return this.channel;
  }

  async createOffer() {
    return {type: 'offer', sdp: 'v=0\r\no=live-voice test'};
  }

  async setLocalDescription(value) {
    this.localDescription = value;
  }

  async setRemoteDescription(value) {
    this.remoteDescription = value;
  }

  close() {
    this.closed = true;
  }
}

function harness(overrides = {}) {
  const events = {
    statuses: [],
    errors: [],
    transcripts: [],
    backend: [],
    sources: [],
    closed: [],
  };
  const audio = {
    srcObject: null,
    played: 0,
    paused: 0,
    sinkIds: [],
    play() {
      this.played += 1;
      return Promise.resolve();
    },
    pause() {
      this.paused += 1;
    },
    ...overrides.audio,
  };
  const track = new FakeTrack();
  const stream = new FakeStream(track);
  const calls = {create: [], cancelSession: [], backend: [], cancelBackend: [], media: []};
  const api = {
    async createSession(args) {
      calls.create.push(args);
      return {
        ok: true,
        value: {
          sessionId: 'session-1',
          sdp: 'v=0\r\no=live-voice answer',
          settings: {locale: 'en', voice: {minutes: 0}, backend: {enabled: true}},
        },
      };
    },
    async cancelSession(args) {
      calls.cancelSession.push(args);
      return {ok: true, value: null};
    },
    async runBackend(args) {
      calls.backend.push(args);
      return {
        ok: true,
        value: {text: 'The source says hello.', sources: [{title: 'Example', url: 'https://example.test/'}]},
      };
    },
    async cancelBackend(args) {
      calls.cancelBackend.push(args);
      return {ok: true, value: null};
    },
    ...overrides.api,
  };
  const controller = createDesktopLive({
    api,
    audio,
    callbacks: {
      onStatus: (value) => events.statuses.push(value),
      onError: (value) => events.errors.push(value),
      onTranscript: (value) => events.transcripts.push(value),
      onBackendStatus: (value) => events.backend.push(value),
      onSources: (value) => events.sources.push(value),
      onClosed: (value) => events.closed.push(value),
      ...overrides.callbacks,
    },
    audioDevices: overrides.audioDevices,
    environment: {
      navigator: {
        mediaDevices: {
          getUserMedia: async (constraints) => {
            calls.media.push(constraints);
            return stream;
          },
        },
      },
      RTCPeerConnection: FakePeer,
      MediaStream: FakeStream,
      ...overrides.environment,
    },
  });
  return {controller, audio, calls, events, stream, track};
}

async function connectedHarness(overrides = {}) {
  const value = harness(overrides);
  const starting = value.controller.start('practice');
  await waitFor(() => FakePeer.instances.length > 0 && FakePeer.instances.at(-1).channel);
  const peer = FakePeer.instances.at(-1);
  peer.channel.emit({type: 'session.started', session: {id: 'session-1'}});
  await starting;
  return {...value, peer, channel: peer.channel};
}

test('starts WebRTC with data channel before offer and closes on server acknowledgement', async () => {
  FakePeer.instances = [];
  const value = await connectedHarness();
  assert.equal(value.calls.create.length, 1);
  // Keep accepting the legacy argument while creating a general session.
  assert.equal(value.calls.create[0].mode, 'general');
  assert.equal(value.peer.channel.sent.length, 0);
  assert.equal(value.events.statuses.at(-1), 'connected');

  const remote = new FakeStream();
  value.peer.ontrack({streams: [remote]});
  await flush();
  assert.equal(value.audio.srcObject, remote);
  assert.equal(value.audio.played, 1);

  const closePromise = value.controller.close();
  assert.equal(value.channel.sent.at(-1).type, 'session.close');
  value.channel.emit({type: 'session.closed'});
  assert.equal(await closePromise, true);
  assert.equal(value.track.stopped, true);
  assert.equal(value.peer.closed, true);
  assert.equal(value.calls.cancelSession.length, 1);
  assert.deepEqual(value.events.closed.at(-1), {confirmed: true, record: null});
});

test('concurrent close callers share one deadline and keep media alive for a delayed final event', async () => {
  FakePeer.instances = [];
  const deadlines = [];
  const value = await connectedHarness({environment: {
    setTimeout(callback, ms) {
      if (ms === 15000) { const token = {callback, ms}; deadlines.push(token); return token; }
      return setTimeout(callback, ms);
    },
    clearTimeout(timer) { if (!deadlines.includes(timer)) clearTimeout(timer); },
  }});
  const first = value.controller.close();
  const second = value.controller.close();
  value.peer.connectionState = 'disconnected';
  value.peer.onconnectionstatechange();
  assert.equal(deadlines.length, 1);
  assert.equal(value.channel.sent.filter(item => item.type === 'session.close').length, 1);
  assert.equal(value.track.stopped, false);
  assert.equal(value.peer.closed, false);
  value.channel.emit({type: 'session.closed'});
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(value.events.closed.length, 1);
  assert.equal(value.events.closed[0].confirmed, true);
});

test('fallback closure confirms only on explicit main-process finalization', async () => {
  FakePeer.instances = [];
  const timers = new Map();
  let fallbackCalls = 0;
  const value = await connectedHarness({
    api: {async finalizeSession() { fallbackCalls += 1; return {ok: true, value: {confirmed: true}}; }},
    environment: {
      setTimeout(callback, ms) { if (ms === 8000 || ms === 15000) { const token = {ms}; timers.set(token, callback); return token; } return setTimeout(callback, ms); },
      clearTimeout(timer) { if (timers.has(timer)) timers.delete(timer); else clearTimeout(timer); },
    },
  });
  const closing = value.controller.close();
  const repeated = value.controller.close();
  const fallback = [...timers].find(([timer]) => timer.ms === 8000);
  fallback[1]();
  assert.equal(await closing, true);
  assert.equal(await repeated, true);
  assert.equal(fallbackCalls, 1);
  assert.equal(value.events.closed.length, 1);
  assert.equal(value.track.stopped, true);
  assert.equal(timers.size, 0);
});

test('an unsuccessful fallback keeps waiting for the primary final event', async () => {
  FakePeer.instances = [];
  const timers = new Map();
  const value = await connectedHarness({
    api: {async finalizeSession() { return {ok: true, value: {confirmed: false}}; }},
    environment: {
      setTimeout(callback, ms) { if (ms === 8000 || ms === 15000) { const token = {ms}; timers.set(token, callback); return token; } return setTimeout(callback, ms); },
      clearTimeout(timer) { if (timers.has(timer)) timers.delete(timer); else clearTimeout(timer); },
    },
  });
  const closing = value.controller.close();
  [...timers].find(([timer]) => timer.ms === 8000)[1]();
  await flush();
  assert.equal(value.events.closed.length, 0);
  value.channel.emit({type: 'session.closed'});
  assert.equal(await closing, true);
  assert.equal(timers.size, 0);
});

test('a lost primary channel can still receive authoritative closure through the fallback', async () => {
  FakePeer.instances = [];
  let calls = 0;
  const value = await connectedHarness({api: {
    async finalizeSession() { calls += 1; return {ok: true, value: {confirmed: true}}; },
  }});
  value.channel.readyState = 'closed';
  value.channel.onclose();
  assert.equal(await value.controller.close(), true);
  assert.equal(calls, 1);
  assert.equal(value.events.closed[0].confirmed, true);
});

test('missing final event times out once without reporting successful closure', async () => {
  FakePeer.instances = [];
  let expire;
  const value = await connectedHarness({environment: {
    setTimeout(callback, ms) { if (ms === 15000) { expire = callback; return 'close-timer'; } return setTimeout(callback, ms); },
    clearTimeout(timer) { if (timer !== 'close-timer') clearTimeout(timer); },
  }});
  const first = value.controller.close();
  const second = value.controller.close();
  expire();
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(value.events.closed.length, 1);
  assert.equal(value.events.closed[0].confirmed, false);
  assert.equal(value.track.stopped, true);
  assert.equal(value.events.errors.filter(code => code === 'voice_close_timeout').length, 1);
});

test('long live history retains its opening anchor and newest question before backend delegation', async () => {
  FakePeer.instances = [];
  const value = await connectedHarness();
  for (let index = 0; index < 600; index += 1) {
    value.channel.emit({type: index % 2 === 0 ? 'session.input_transcript.delta' : 'session.output_transcript.delta',
      delta: `message-${index}`, start_ms: index * 3000, end_ms: index * 3000 + 100});
  }
  value.channel.emit({type: 'session.delegation.created', delegation: {target: 'client', id: 'retained-history'}});
  await waitFor(() => value.calls.backend.length === 1);
  const history = value.calls.backend[0].history;
  assert.equal(history.length, 500);
  assert.equal(history[0].text, 'message-0');
  assert.equal(history[1].text, 'message-1');
  assert.equal(history.at(-2).text, 'message-598');
  assert.equal(history.at(-1).text, 'message-599');
  const closing = value.controller.close();
  value.channel.emit({type: 'session.closed'});
  await closing;
});

test('handles transcript bounds, mute, style acknowledgement and client backend delegation', async () => {
  FakePeer.instances = [];
  const value = await connectedHarness();
  value.controller.setMuted(true);
  const mute = value.channel.sent.at(-1);
  assert.equal(mute.type, 'session.input_audio.mute');
  value.channel.emit({type: 'session.input_audio.muted', client_event_id: mute.event_id});

  const stylePromise = value.controller.appendStyle({
    voice: 'marin',
    tone: 'warm',
    intonation: 'natural',
    pace: 'normal',
    minutes: 0,
    instructions: 'Keep it friendly.',
  });
  await flush();
  const style = value.channel.sent.at(-1);
  assert.equal(style.type, 'session.instructions.append');
  assert.match(style.content, /Follow the language/);
  value.channel.emit({type: 'session.instructions.appended', client_event_id: style.event_id});
  await stylePromise;

  value.channel.emit({type: 'session.input_transcript.delta', delta: 'Hi', start_ms: 0, end_ms: 50});
  value.channel.emit({type: 'session.output_transcript.delta', delta: 'Hello', start_ms: 60, end_ms: 100});
  assert.deepEqual(value.events.transcripts.map((item) => item.text), ['Hi', 'Hello']);

  value.channel.emit({
    type: 'session.delegation.created',
    delegation: {target: 'client', id: 'delegate-1'},
  });
  await waitFor(() => value.calls.backend.length === 1);
  assert.equal(value.calls.backend[0].history.length, 2);
  await waitFor(() => value.channel.sent.some((item) => item.type === 'session.commentary.append'));
  const commentary = value.channel.sent.find((item) => item.type === 'session.commentary.append');
  value.channel.emit({type: 'session.commentary.appended', client_event_id: commentary.event_id});
  await waitFor(() => value.events.backend.at(-1) === 'done');
  assert.equal(value.events.sources.at(-1)[0].title, 'Example');

  const closePromise = value.controller.close();
  value.channel.emit({type: 'session.closed'});
  await closePromise;
  assert.equal(value.events.closed.at(-1).record.fragments.length, 2);
});

test('keeps an overlapping transcript for a delegation offset during the settle window', async () => {
  FakePeer.instances = [];
  const value = await connectedHarness();
  value.channel.emit({type: 'session.input_transcript.delta', delta: 'first part', start_ms: 81400, end_ms: 81400});
  value.channel.emit({
    type: 'session.delegation.created',
    offset_ms: 81200,
    delegation: {target: 'client', id: 'delegate-offset-settle'},
  });
  await flush();
  const cancelCount = value.calls.cancelBackend.length;
  value.channel.emit({type: 'session.input_transcript.delta', delta: 'late context', start_ms: 82200, end_ms: 82400});
  await waitFor(() => value.calls.backend.length === 1);
  assert.equal(value.calls.cancelBackend.length, cancelCount);
  await waitFor(() => value.channel.sent.some((item) => item.type === 'session.commentary.append'));
  const commentary = value.channel.sent.find((item) => item.type === 'session.commentary.append');
  value.channel.emit({type: 'session.commentary.appended', client_event_id: commentary.event_id});
  await waitFor(() => value.events.backend.at(-1) === 'done');

  const closePromise = value.controller.close();
  value.channel.emit({type: 'session.closed'});
  await closePromise;
});

test('replaces a read-only backend request once when continuous speech extends its input', async () => {
  FakePeer.instances = [];
  const resolvers = [];
  const value = await connectedHarness({
    api: {
      runBackend() {
        return new Promise(resolve => resolvers.push(resolve));
      },
    },
  });
  value.channel.emit({type: 'session.input_transcript.delta', delta: 'first part', start_ms: 81400, end_ms: 81400});
  value.channel.emit({
    type: 'session.delegation.created',
    offset_ms: 81200,
    delegation: {target: 'client', id: 'delegate-offset-running'},
  });
  await waitFor(() => resolvers.length === 1);
  const cancelCount = value.calls.cancelBackend.length;
  value.channel.emit({type: 'session.input_transcript.delta', delta: 'same request tail', start_ms: 82200, end_ms: 82400});
  await waitFor(() => resolvers.length === 2);
  assert.ok(value.calls.cancelBackend.length > cancelCount);
  assert.equal(value.events.backend.at(-1), 'working');
  resolvers[0]({ok: true, value: {text: 'Stale result.', sources: []}});
  resolvers[1]({ok: true, value: {text: 'A verified backend result.', sources: []}});
  await waitFor(() => value.channel.sent.some((item) => item.type === 'session.commentary.append'));
  const commentary = value.channel.sent.find((item) => item.type === 'session.commentary.append');
  value.channel.emit({type: 'session.commentary.appended', client_event_id: commentary.event_id});
  await waitFor(() => value.events.backend.at(-1) === 'done');

  const closePromise = value.controller.close();
  value.channel.emit({type: 'session.closed'});
  await closePromise;
});

test('continuous input replacement is bounded and never sends stale results after exhaustion', async () => {
  FakePeer.instances = [];
  const resolvers = [];
  const value = await connectedHarness({api: {
    runBackend() { return new Promise(resolve => resolvers.push(resolve)); },
  }});
  value.channel.emit({type: 'session.input_transcript.delta', delta: 'first', start_ms: 1000, end_ms: 1200});
  value.channel.emit({type: 'session.delegation.created', offset_ms: 1200,
    delegation: {target: 'client', id: 'bounded-replacement'}});
  await waitFor(() => resolvers.length === 1);
  value.channel.emit({type: 'session.input_transcript.delta', delta: ' continuation', start_ms: 1400, end_ms: 1600});
  await waitFor(() => resolvers.length === 2);
  value.channel.emit({type: 'session.input_transcript.delta', delta: ' correction', start_ms: 1800, end_ms: 2000});
  await flush();
  assert.equal(value.events.backend.at(-1), 'error');
  assert.equal(value.events.errors.at(-1), 'backend_aborted');
  for (const resolve of resolvers) resolve({ok: true, value: {text: 'Stale result.', sources: []}});
  await flush();
  assert.equal(value.channel.sent.some(item => item.type === 'session.commentary.append'), false);
  assert.equal(resolvers.length, 2);
  const closing = value.controller.close();
  value.channel.emit({type: 'session.closed'});
  await closing;
});

test('newer speech cancels active backend, resets status, and suppresses late result', async () => {
  FakePeer.instances = [];
  let resolveBackend;
  const value = await connectedHarness({
    api: {
      runBackend() {
        return new Promise(resolve => {
          resolveBackend = resolve;
        });
      },
    },
  });
  value.channel.emit({
    type: 'session.delegation.created',
    offset_ms: 1000,
    delegation: {target: 'client', id: 'delegate-new-speech'},
  });
  await waitFor(() => typeof resolveBackend === 'function');
  const cancelCount = value.calls.cancelBackend.length;
  value.channel.emit({type: 'session.input_transcript.delta', delta: 'new request', start_ms: 1100, end_ms: 1300});
  await flush();
  assert.ok(value.calls.cancelBackend.length > cancelCount);
  assert.equal(value.events.backend.at(-1), 'idle');
  resolveBackend({text: 'Late result must be ignored.', sources: []});
  await flush();
  await flush();
  assert.equal(value.channel.sent.some((item) => item.type === 'session.commentary.append'), false);

  const closePromise = value.controller.close();
  value.channel.emit({type: 'session.closed'});
  await closePromise;
});

test('a newer delegation supersedes an older one by revision', async () => {
  FakePeer.instances = [];
  const resolvers = [];
  const value = await connectedHarness({
    api: {
      runBackend() {
        return new Promise(resolve => resolvers.push(resolve));
      },
    },
  });
  value.channel.emit({
    type: 'session.delegation.created',
    offset_ms: 1000,
    delegation: {target: 'client', id: 'delegate-old'},
  });
  await waitFor(() => resolvers.length === 1);
  value.channel.emit({
    type: 'session.delegation.created',
    offset_ms: 2000,
    delegation: {target: 'client', id: 'delegate-new'},
  });
  await waitFor(() => resolvers.length === 2);
  resolvers[0]({ok: true, value: {text: 'Old result must be ignored.', sources: []}});
  resolvers[1]({ok: true, value: {text: 'New result.', sources: []}});
  await waitFor(() => value.channel.sent.some((item) => item.type === 'session.commentary.append'));
  const commentary = value.channel.sent.find((item) => item.type === 'session.commentary.append');
  assert.equal(commentary.delegation_id, 'delegate-new');
  value.channel.emit({type: 'session.commentary.appended', client_event_id: commentary.event_id});
  await waitFor(() => value.events.backend.at(-1) === 'done');

  const closePromise = value.controller.close();
  value.channel.emit({type: 'session.closed'});
  await closePromise;
});

test('returns one safe failure commentary for the matching delegation and preserves the backend code', async () => {
  FakePeer.instances = [];
  let backendCalls = 0;
  const value = await connectedHarness({
    api: {
      async runBackend() {
        backendCalls += 1;
        const error = new Error('provider details must stay private');
        error.code = 'backend_incomplete';
        throw error;
      },
    },
  });
  value.channel.emit({
    type: 'session.delegation.created',
    delegation: {target: 'client', id: 'delegate-failure-1'},
  });
  await waitFor(() => backendCalls === 1);
  await waitFor(() => value.channel.sent.some((item) => item.type === 'session.commentary.append'));
  const notices = value.channel.sent.filter((item) => item.type === 'session.commentary.append');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].delegation_id, 'delegate-failure-1');
  assert.match(notices[0].content, /could not finish/i);
  assert.equal(notices[0].content.includes('provider details'), false);
  assert.equal(value.events.errors.at(-1), 'backend_incomplete');

  value.channel.emit({type: 'error', client_event_id: notices[0].event_id});
  await flush();
  assert.equal(value.channel.sent.filter((item) => item.type === 'session.commentary.append').length, 1);

  const closePromise = value.controller.close();
  value.channel.emit({type: 'session.closed'});
  await closePromise;
});

test('does not send failure commentary after a delegated task is superseded', async () => {
  FakePeer.instances = [];
  let rejectBackend;
  const value = await connectedHarness({
    api: {
      runBackend() {
        return new Promise((resolve, reject) => {
          rejectBackend = reject;
        });
      },
    },
  });
  value.channel.emit({
    type: 'session.delegation.created',
    delegation: {target: 'client', id: 'delegate-stale-1'},
  });
  await waitFor(() => typeof rejectBackend === 'function');
  value.channel.emit({type: 'session.input_transcript.delta', delta: 'Use the new request', start_ms: 0, end_ms: 100});
  const error = new Error('late backend failure');
  error.code = 'backend_incomplete';
  rejectBackend(error);
  await flush();
  await flush();
  assert.equal(value.channel.sent.some((item) => item.type === 'session.commentary.append'), false);
  assert.equal(value.events.errors.length, 0);

  const closePromise = value.controller.close();
  value.channel.emit({type: 'session.closed'});
  await closePromise;
});

test('cancels a pending microphone permission and stops a stream that resolves late', async () => {
  FakePeer.instances = [];
  let resolveMicrophone;
  const value = harness({
    environment: {
      navigator: {
        mediaDevices: {
          getUserMedia: () => new Promise((resolve) => {
            resolveMicrophone = resolve;
          }),
        },
      },
    },
  });
  const starting = value.controller.start('general');
  await flush();
  const closing = value.controller.close();
  resolveMicrophone(value.stream);
  await starting;
  assert.equal(await closing, false);
  assert.equal(value.track.stopped, true);
  assert.equal(value.calls.cancelSession.length, 1);
  assert.deepEqual(value.events.closed.at(-1), {confirmed: false, record: null});
});

test('routes selected input/output devices before session creation and ends on input removal', async () => {
  FakePeer.instances = [];
  const value = await connectedHarness({
    audioDevices: {inputDeviceId: 'mic-1', outputDeviceId: 'speaker-1'},
    audio: {
      setSinkId(sinkId) {
        this.sinkIds.push(sinkId);
        return Promise.resolve();
      },
    },
  });
  assert.deepEqual(value.audio.sinkIds, ['speaker-1']);
  assert.deepEqual(value.calls.media, [{
    audio: {
      deviceId: {exact: 'mic-1'},
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  }]);
  assert.equal(value.calls.create.length, 1);

  value.track.emit('ended');
  await waitFor(() => value.events.errors.includes('audio_input_unavailable'));
  await waitFor(() => value.channel.sent.some((item) => item.type === 'session.close'));
  value.channel.emit({type: 'session.closed'});
  await waitFor(() => value.events.closed.length === 1);
  assert.equal(value.track.stopped, true);
  const errorCount = value.events.errors.length;
  value.track.emit('ended');
  assert.equal(value.events.errors.length, errorCount);
});

test('fails selected output routing before requesting input when sink selection is unsupported', async () => {
  FakePeer.instances = [];
  const value = harness({audioDevices: {inputDeviceId: 'mic-1', outputDeviceId: 'speaker-1'}});
  await value.controller.start('general');
  assert.equal(value.events.errors.at(-1), 'audio_output_unsupported');
  assert.equal(value.calls.media.length, 0);
  assert.equal(value.calls.create.length, 0);
});

test('maps a missing selected input device before session creation', async () => {
  FakePeer.instances = [];
  const value = harness({
    audioDevices: {inputDeviceId: 'missing-mic', outputDeviceId: ''},
    environment: {
      navigator: {
        mediaDevices: {
          getUserMedia: async () => {
            throw {name: 'NotFoundError'};
          },
        },
      },
    },
  });
  await value.controller.start('general');
  assert.equal(value.events.errors.at(-1), 'audio_input_unavailable');
  assert.equal(value.calls.create.length, 0);
});

test('cancels a pending setSinkId without starting microphone or network work', async () => {
  FakePeer.instances = [];
  let resolveSink;
  const value = harness({
    audioDevices: {inputDeviceId: '', outputDeviceId: 'speaker-1'},
    audio: {
      setSinkId() {
        return new Promise((resolve) => {
          resolveSink = resolve;
        });
      },
    },
  });
  const starting = value.controller.start('general');
  await flush();
  assert.equal(typeof resolveSink, 'function');
  const closing = value.controller.close();
  resolveSink();
  await starting;
  assert.equal(await closing, false);
  assert.equal(value.calls.media.length, 0);
  assert.equal(value.calls.create.length, 0);
  assert.deepEqual(value.events.closed.at(-1), {confirmed: false, record: null});
});

test('hot voice settings wait for matching ACK and retain original session deadline', async () => {
  FakePeer.instances = [];
  let now = 1000;
  const timers = [];
  const value = await connectedHarness({environment:{now:()=>now,setTimeout:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},clearTimeout:t=>{t.cleared=true;}}});
  const voice={voice:'marin',tone:'warm',intonation:'natural',pace:'normal',minutes:5,instructions:'Be concise'};
  now += 60000;
  let applied=false;
  const update=value.controller.updatePreferences({voice}).then(()=>{applied=true;});
  await flush();
  const command=value.channel.sent.at(-1);
  assert.equal(command.type,'session.instructions.append');
  value.channel.emit({type:'session.instructions.appended',client_event_id:'wrong'});
  await flush();assert.equal(applied,false);
  value.channel.emit({type:'session.instructions.appended',client_event_id:command.event_id});
  await update;
  assert.equal(timers.at(-1).ms,240000);
  const count=value.channel.sent.length;
  now += 1000;
  await value.controller.updatePreferences({voice:{...voice,voice:'cedar',minutes:10}});
  assert.equal(value.channel.sent.length,count);
  assert.equal(timers.at(-1).ms,539000);
  now += 600000;
  await assert.rejects(value.controller.updatePreferences({voice:{...voice,minutes:5}}),e=>e.code==='session_limit_elapsed');
  assert.equal(value.track.stopped,false);
  value.controller.dispose();
});

test('rejected hot style ACK does not reset expiry and can be retried', async () => {
  FakePeer.instances = [];
  const value=await connectedHarness();
  const voice={voice:'marin',tone:'warm',intonation:'natural',pace:'normal',minutes:0,instructions:''};
  const update=value.controller.updatePreferences({voice});
  const rejected=assert.rejects(update,e=>e.code==='command_rejected');
  await flush();
  value.channel.emit({type:'error',error:{client_event_id:value.channel.sent.at(-1).event_id}});
  await rejected;
  assert.equal(value.track.stopped,false);
  const retry=value.controller.updatePreferences({voice});await flush();
  value.channel.emit({type:'session.instructions.appended',client_event_id:value.channel.sent.at(-1).event_id});
  await retry; value.controller.dispose();
});
