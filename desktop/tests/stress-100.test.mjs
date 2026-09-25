import assert from 'node:assert/strict';
import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import {access, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';

import {createServices} from '../services.mjs';
import {createDesktopLive} from '../renderer/live.ts';

const cryptoKey = createHash('sha256').update('local-stress-secure-storage').digest();

function secureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', cryptoKey, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const iv = value.subarray(0, 12);
      const tag = value.subarray(-16);
      const decipher = createDecipheriv('aes-256-gcm', cryptoKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, timeoutMs = 2_500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('stress_wait_timeout');
    await flush();
  }
}

function response(status, value) {
  return {
    status,
    text: async () => typeof value === 'string' ? value : JSON.stringify(value),
  };
}

function completedResponse(text) {
  return response(200, {
    status: 'completed',
    output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text}]}],
  });
}

function emptyResponse() {
  return response(200, {status: 'completed', output: [{type: 'message', role: 'assistant', content: []}]});
}

function incompleteResponse() {
  return response(200, {status: 'incomplete', incomplete_details: {reason: 'max_output_tokens'}, output: []});
}

class StressTrack {
  constructor() {
    this.enabled = true;
    this.stopCount = 0;
    this.listeners = new Map();
  }

  stop() {
    this.stopCount += 1;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }
}

class StressStream {
  constructor(track) {
    this.track = track;
  }

  getAudioTracks() {
    return [this.track];
  }

  getTracks() {
    return [this.track];
  }
}

class StressChannel {
  constructor(rounds) {
    this.rounds = rounds;
    this.readyState = 'open';
    this.sent = [];
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  send(raw) {
    const value = JSON.parse(raw);
    this.sent.push(value);
    if (value.type === 'session.close') {
      queueMicrotask(() => this.emit({type: 'session.closed'}));
      return;
    }
    if (value.type !== 'session.commentary.append' || typeof value.delegation_id !== 'string') return;
    const round = this.rounds.get(value.delegation_id);
    if (!round) throw new Error('stress_unknown_delegation');
    round.commentaryCount += 1;
    const firstCommentary = round.commentaryCount === 1;
    round.commentaryTexts.push(value.content);
    queueMicrotask(() => {
      if (round.type === 'ackfail' && firstCommentary) {
        this.emit({type: 'error', client_event_id: value.event_id});
      } else {
        round.commentaryAcks += 1;
        this.emit({type: 'session.commentary.appended', client_event_id: value.event_id});
      }
    });
  }

  emit(value) {
    this.onmessage?.({data: JSON.stringify(value)});
  }

  close() {
    this.readyState = 'closed';
    this.onclose?.();
  }
}

class StressPeer {
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
    StressPeer.instances.push(this);
  }

  addTrack(track, stream) {
    this.tracks.push({track, stream});
  }

  createDataChannel(label) {
    if (label !== 'oai-events') throw new Error('stress_channel_label');
    this.channel = new StressChannel(stressRoundMap);
    return this.channel;
  }

  async createOffer() {
    return {type: 'offer', sdp: 'v=0\r\no=local-stress'};
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

let stressRoundMap = new Map();

function makePlan() {
  const buckets = [
    ['normal', 50],
    ['token', 10],
    ['timeout', 10],
    ['server', 10],
    ['interrupt', 10],
    ['malformed', 5],
    ['ackfail', 5],
  ].map(([type, count]) => ({type, remaining: count}));
  const plan = [];
  while (buckets.some((bucket) => bucket.remaining > 0)) {
    for (const bucket of buckets) {
      if (bucket.remaining > 0) {
        plan.push(bucket.type);
        bucket.remaining -= 1;
      }
    }
  }
  assert.equal(plan.length, 100);
  return plan;
}

function fixedTimerHarness() {
  const activeTimers = new Set();
  const setTimeoutFast = (callback, _milliseconds) => {
    const timer = setTimeout(() => {
      activeTimers.delete(timer);
      callback();
    }, 5);
    activeTimers.add(timer);
    return timer;
  };
  const clearTimeoutFast = (timer) => {
    activeTimers.delete(timer);
    clearTimeout(timer);
  };
  return {activeTimers, setTimeoutFast, clearTimeoutFast};
}

test('100 sequential local voice/backend turns recover and release all resources', async () => {
  const plan = makePlan();
  const rounds = new Map(plan.map((type, index) => [index, {
    index,
    type,
    id: `delegation-${index}`,
    backendStarted: false,
    backendFinished: false,
    lateDelivered: false,
    commentaryCount: 0,
    commentaryAcks: 0,
    commentaryTexts: [],
  }]));
  stressRoundMap = new Map([...rounds.values()].map((round) => [round.id, round]));

  const dataDir = await mkdtemp(join(tmpdir(), 'live-voice-stress-100-'));
  const timerHarness = fixedTimerHarness();
  const localTrack = new StressTrack();
  const localStream = new StressStream(localTrack);
  const events = {
    errors: [],
    statuses: [],
    backend: [],
    transcripts: [],
    closed: [],
  };
  const requests = {session: 0, backend: 0};
  let activeFetches = 0;
  let currentRound = null;
  let services;
  let controller;
  let audio;
  let peer;

  const fetchImpl = async (url, init = {}) => {
    const body = JSON.parse(init.body ?? '{}');
    if (url.endsWith('/live/sessions')) {
      requests.session += 1;
      if (body.session?.model !== 'synthetic-live') throw new Error('stress_voice_model');
      if (body.session?.store !== false || body.session?.delegation?.type !== 'client') throw new Error('stress_voice_session_options');
      return response(200, {
        session: {id: 'stress-session'},
        transport: {type: 'webrtc', sdp: 'v=0\r\no=remote-stress'},
      });
    }
    if (!url.endsWith('/responses')) throw new Error('stress_endpoint');
    requests.backend += 1;
    if (body.model !== 'synthetic-backend' || body.max_output_tokens !== 32_768 || body.reasoning?.effort !== 'max' || body.store !== false) {
      throw new Error('stress_backend_request_options');
    }
    const round = currentRound;
    if (!round) throw new Error('stress_missing_round');
    round.backendStarted = true;
    activeFetches += 1;
    const finish = (callback) => {
      activeFetches -= 1;
      round.backendFinished = true;
      callback();
    };
    if (round.type === 'normal' || round.type === 'ackfail') {
      finish(() => {});
      return completedResponse(`synthetic answer ${round.index}`);
    }
    if (round.type === 'token') {
      finish(() => {});
      return incompleteResponse();
    }
    if (round.type === 'malformed') {
      finish(() => {});
      return emptyResponse();
    }
    if (round.type === 'server') {
      finish(() => {});
      return response(500, '{"error":{"message":"synthetic provider failure"}}');
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        init.signal?.removeEventListener('abort', onAbort);
        if (round.type === 'interrupt') {
          setTimeout(() => {
            finish(() => { round.lateDelivered = true; resolve(completedResponse(`late answer ${round.index}`)); });
          }, 8);
        } else {
          finish(() => reject(Object.assign(new Error('synthetic timeout abort'), {name: 'AbortError'})));
        }
      };
      if (init.signal?.aborted) onAbort();
      else init.signal?.addEventListener('abort', onAbort, {once: true});
    });
  };

  try {
    services = await createServices({dataDir, safeStorage: secureStorage(), fetchImpl});
    await services.saveSettings({settings: {
      locale: 'en',
      theme: 'system',
      mode: 'practice',
      audio: {inputDeviceId: '', outputDeviceId: ''},
      voice: {voice: 'marin', tone: 'natural', intonation: 'natural', pace: 'normal', minutes: 0, instructions: ''},
      backend: {enabled: true, effort: 'max', maxOutputTokens: 32_768, webSearch: false, timeoutSeconds: 1, instructions: ''},
    }});
    await services.saveConnection({kind: 'voice', credential: {
      endpoint: 'https://synthetic.voice.test/v1', model: 'synthetic-live', auth: 'bearer', apiKey: 'synthetic-voice-key',
    }});
    await services.saveConnection({kind: 'backend', credential: {
      endpoint: 'https://synthetic.backend.test/v1', model: 'synthetic-backend', auth: 'api-key', apiKey: 'synthetic-backend-key',
    }});

    const api = {
      async createSession(args) {
        try { return {ok: true, value: await services.createSession(args)}; }
        catch (error) { return {ok: false, code: error?.code ?? 'operation_failed'}; }
      },
      async cancelSession(args) {
        try { return {ok: true, value: await services.cancelSession(args)}; }
        catch (error) { return {ok: false, code: error?.code ?? 'operation_failed'}; }
      },
      async runBackend(args) {
        try { return {ok: true, value: await services.runBackend(args)}; }
        catch (error) { return {ok: false, code: error?.code ?? 'operation_failed'}; }
      },
      async cancelBackend(args) {
        try { return {ok: true, value: await services.cancelBackend(args)}; }
        catch (error) { return {ok: false, code: error?.code ?? 'operation_failed'}; }
      },
    };
    audio = {
      srcObject: null,
      play: () => Promise.resolve(),
      pause: () => {},
    };
    const callbacks = {
      onStatus: (value) => events.statuses.push(value),
      onError: (value) => events.errors.push(value),
      onBackendStatus: (value) => events.backend.push(value),
      onTranscript: (value) => events.transcripts.push(value),
      onSources: () => {},
      onClosed: (value) => events.closed.push(value),
    };
    controller = createDesktopLive({
      api,
      audio,
      callbacks,
      audioDevices: {inputDeviceId: '', outputDeviceId: ''},
      environment: {
        navigator: {mediaDevices: {getUserMedia: async () => localStream}},
        RTCPeerConnection: StressPeer,
        MediaStream: StressStream,
        setTimeout: timerHarness.setTimeoutFast,
        clearTimeout: timerHarness.clearTimeoutFast,
        now: () => Date.now(),
      },
    });

    const startPromise = controller.start('practice');
    await waitFor(() => StressPeer.instances.length > 0 && StressPeer.instances.at(-1).channel);
    peer = StressPeer.instances.at(-1);
    await waitFor(() => requests.session === 1 && peer.remoteDescription);
    peer.channel.emit({type: 'session.started', session: {id: 'stress-session'}});
    await startPromise;
    assert.equal(events.statuses.at(-1), 'connected');
    assert.equal(requests.session, 1);

    for (const round of rounds.values()) {
      currentRound = round;
      const errorsBefore = events.errors.length;
      peer.channel.emit({
        type: 'session.input_transcript.delta',
        delta: `synthetic prompt ${round.index}`,
        start_ms: round.index * 10,
        end_ms: round.index * 10 + 5,
      });
      peer.channel.emit({
        type: 'session.delegation.created',
        delegation: {target: 'client', id: round.id},
      });
      await waitFor(() => round.backendStarted, round.type === 'timeout' ? 1_500 : 1_000);

      if (round.type === 'interrupt') {
        peer.channel.emit({
          type: 'session.input_transcript.delta',
          delta: `superseding prompt ${round.index}`,
          start_ms: round.index * 10 + 6,
          end_ms: round.index * 10 + 12,
        });
        await waitFor(() => round.lateDelivered, 1_000);
        await flush();
        assert.equal(round.commentaryCount, 0);
        assert.equal(events.errors.length, errorsBefore);
      } else {
        const expectedError = round.type === 'token'
          ? 'backend_token_limit'
          : round.type === 'timeout'
            ? 'backend_timeout'
            : round.type === 'server'
              ? 'backend_http_500'
              : round.type === 'malformed'
                ? 'backend_empty_output'
                : round.type === 'ackfail'
                  ? 'command_rejected'
                  : '';
        const expectedCommentaries = round.type === 'ackfail' ? 2 : 1;
        const expectedAcks = round.type === 'ackfail' ? 1 : 1;
        try {
          await waitFor(() => round.commentaryCount >= expectedCommentaries && round.commentaryAcks >= expectedAcks, round.type === 'timeout' ? 3_000 : 1_000);
        } catch {
          throw new Error(`stress_commentary_timeout_${round.index}_${round.type}_${round.commentaryCount}_${round.commentaryAcks}`);
        }
        assert.equal(round.commentaryCount, expectedCommentaries);
        if (expectedError) {
          assert.ok(
            events.errors.slice(errorsBefore).includes(expectedError),
            `stress_error_mismatch_${round.index}_${round.type}_${expectedError}_${events.errors.slice(errorsBefore).join(',')}`,
          );
        } else {
          assert.equal(events.errors.length, errorsBefore);
        }
      }
      peer.channel.emit({
        type: 'session.output_transcript.delta',
        delta: `synthetic assistant ${round.index}`,
        start_ms: round.index * 10 + 20,
        end_ms: round.index * 10 + 30,
      });
    }

    assert.equal(events.transcripts.length, 210);
    assert.equal(requests.backend, 100);
    assert.equal(activeFetches, 0);
    assert.equal(timerHarness.activeTimers.size, 0);

    const closePromise = controller.close();
    await waitFor(() => peer.channel.sent.some((item) => item.type === 'session.close'));
    assert.equal(await closePromise, true);
    const closed = events.closed.at(-1);
    assert.equal(closed?.confirmed, true);
    assert.ok(closed?.record);
    assert.ok(closed.record.fragments.length <= 500);
    assert.ok(JSON.stringify(closed.record).length <= 256 * 1024);
    await services.saveHistory({record: closed.record});
    const history = await services.bootstrap();
    assert.equal(history.history.length, 1);
    assert.ok(history.history[0].fragments.length <= 500);
    assert.equal(localTrack.stopCount, 1);
    assert.equal(peer.closed, true);
    assert.equal(activeFetches, 0);
    assert.equal(timerHarness.activeTimers.size, 0);
    assert.equal(events.statuses.at(-1), 'closed');

    console.log(JSON.stringify({
      simulation: 'local-only',
      timing: 'live timers accelerated; backend timeout fixture 1s',
      rounds: 100,
      outcomes: {normal: 50, token: 10, timeout: 10, server: 10, interrupt: 10, malformed: 5, ackfail: 5},
      backendRequests: requests.backend,
      closeConfirmed: closed.confirmed,
      historyRecords: history.history.length,
      resources: {activeFetches, activeLiveTimers: timerHarness.activeTimers.size, stoppedTracks: localTrack.stopCount},
    }));
  } finally {
    controller?.dispose();
    await services?.dispose();
    await rm(dataDir, {recursive: true, force: true});
    await assert.rejects(access(dataDir), (error) => error?.code === 'ENOENT');
    stressRoundMap = new Map();
  }
});
