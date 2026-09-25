import assert from 'node:assert/strict';
import test from 'node:test';

import {createAudioDeviceManager} from '../renderer/audio-devices.mjs';

class Track {
  constructor() {
    this.stopped = 0;
    this.listeners = new Map();
    this.onended = null;
  }

  stop() {
    this.stopped += 1;
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  removeEventListener(name, listener) {
    if (this.listeners.get(name) === listener) this.listeners.delete(name);
  }

  end() {
    this.listeners.get('ended')?.();
    this.onended?.();
  }
}

class AudioContextFake {
  static instances = [];

  constructor() {
    this.closed = false;
    this.analyser = {
      fftSize: 32,
      getByteTimeDomainData(values) {
        values.fill(180);
      },
    };
    AudioContextFake.instances.push(this);
  }

  createAnalyser() {
    return this.analyser;
  }

  createMediaStreamSource(stream) {
    this.stream = stream;
    return {
      connect: (target) => { this.connectedTo = target; },
    };
  }

  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

function mediaFixture() {
  const listeners = new Map();
  const calls = [];
  const mediaDevices = {
    devices: [
      {kind: 'audioinput', deviceId: 'default', label: 'Default'},
      {kind: 'audioinput', deviceId: 'communications', label: 'Communications'},
      {kind: 'audioinput', deviceId: 'mic-1', label: 'Mic one'},
      {kind: 'audioinput', deviceId: 'mic-1', label: 'Duplicate'},
      {kind: 'audiooutput', deviceId: 'speaker-1', label: 'Speaker one'},
      {kind: 'audiooutput', deviceId: 'communications', label: 'Communications'},
    ],
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    enumerateDevices: async () => mediaDevices.devices,
    getUserMedia: async (constraints) => {
      calls.push(constraints);
      const track = new Track();
      return {track, getTracks: () => [track]};
    },
    dispatch(name) { listeners.get(name)?.(); },
    calls,
  };
  return mediaDevices;
}

function waitForTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('refresh filters browser pseudo-devices and permission capture is audio-only', async () => {
  const mediaDevices = mediaFixture();
  const changes = [];
  const manager = createAudioDeviceManager({environment: {mediaDevices}, onChange: (value) => changes.push(value)});
  const first = await manager.refresh();
  assert.deepEqual(first.inputs, [{id: 'mic-1', label: 'Mic one'}]);
  assert.deepEqual(first.outputs, [{id: 'speaker-1', label: 'Speaker one'}]);
  const permission = await manager.refresh({requestPermission: true});
  assert.equal(permission.inputs[0].id, 'mic-1');
  assert.deepEqual(mediaDevices.calls.at(-1), {audio: true, video: false});
  assert.equal(changes.length > 0, true);
  manager.dispose();
});

test('microphone test uses exact selected input, drives RMS meter, never plays audio, and cleans on track end', async () => {
  const mediaDevices = mediaFixture();
  const createdAudio = [];
  const manager = createAudioDeviceManager({
    environment: {
      mediaDevices,
      AudioContext: AudioContextFake,
      createAudio: () => { createdAudio.push(true); return {}; },
    },
  });
  const pending = manager.startMicrophoneTest('mic-1');
  const state = await pending;
  assert.deepEqual(mediaDevices.calls.at(-1), {audio: {deviceId: {exact: 'mic-1'}}, video: false});
  assert.equal(state.microphoneStatus, 'testing');
  assert.equal(createdAudio.length, 0);
  assert.equal(AudioContextFake.instances.at(-1).connectedTo, AudioContextFake.instances.at(-1).analyser);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(manager.getState().level > 0, true);
  // The stream is retained by the context fake for a deterministic end event.
  const context = AudioContextFake.instances.at(-1);
  context.stream.track.end();
  assert.equal(manager.getState().microphoneStatus, 'idle');
  assert.equal(manager.getState().error, 'audio_input_unavailable');
  assert.equal(context.closed, true);
  assert.equal(context.stream.track.stopped, 1);
  manager.dispose();
});

test('stopping during deferred permission releases the late track and suppresses stale setup', async () => {
  let resolvePermission;
  const lateTrack = new Track();
  const mediaDevices = {
    enumerateDevices: async () => [],
    getUserMedia: () => new Promise((resolve) => { resolvePermission = resolve; }),
    addEventListener() {},
    removeEventListener() {},
  };
  let contexts = 0;
  const manager = createAudioDeviceManager({environment: {mediaDevices, AudioContext: class { constructor() { contexts += 1; } }}});
  const pending = manager.startMicrophoneTest('mic-late');
  manager.stopMicrophoneTest();
  resolvePermission({getTracks: () => [lateTrack]});
  await pending;
  assert.equal(lateTrack.stopped, 1);
  assert.equal(contexts, 0);
  assert.equal(manager.getState().microphoneStatus, 'idle');
  manager.dispose();
});

test('permission refresh cancels active tests and releases its own late stream', async () => {
  let resolvePermission;
  const lateTrack = new Track();
  const mediaDevices = {
    enumerateDevices: async () => [],
    getUserMedia: () => new Promise((resolve) => { resolvePermission = resolve; }),
    addEventListener() {},
    removeEventListener() {},
  };
  const manager = createAudioDeviceManager({environment: {mediaDevices}});
  const pending = manager.refresh({requestPermission: true});
  manager.stopTests();
  resolvePermission({getTracks: () => [lateTrack]});
  await pending;
  assert.equal(lateTrack.stopped, 1);
  assert.equal(manager.getState().microphoneStatus, 'idle');
  manager.dispose();
});

test('output test selects sink before playback, revokes its URL, and rejects unsupported selected sinks', async () => {
  const events = [];
  const urls = [];
  const revoked = [];
  const audio = {
    addEventListener(name, listener) { this.ended = listener; },
    removeEventListener() {},
    setSinkId: async (id) => { events.push(`sink:${id}`); },
    play: async () => { events.push('play'); },
    pause: () => { events.push('pause'); },
    load: () => {},
    set src(value) { this.source = value; },
    get src() { return this.source; },
  };
  const manager = createAudioDeviceManager({
    environment: {
      URL: {
        createObjectURL: () => { const url = `blob:${urls.length}`; urls.push(url); return url; },
        revokeObjectURL: (url) => revoked.push(url),
      },
      createAudio: () => audio,
      Blob,
    },
  });
  const started = await manager.testOutput('speaker-1');
  assert.equal(started.outputStatus, 'testing');
  assert.deepEqual(events, ['sink:speaker-1', 'play']);
  audio.ended();
  assert.equal(manager.getState().outputStatus, 'idle');
  assert.equal(manager.getState().notice, 'output_done');
  assert.deepEqual(revoked, ['blob:0']);
  manager.dispose();

  const unsupported = createAudioDeviceManager({
    environment: {
      URL: {createObjectURL: () => 'blob:unsupported', revokeObjectURL: () => {}},
      createAudio: () => ({play: async () => {}}),
      Blob,
    },
  });
  const result = await unsupported.testOutput('speaker-2');
  assert.equal(result.error, 'audio_output_unsupported');
  unsupported.dispose();
});

test('devicechange refreshes devices and dispose removes the listener', async () => {
  const mediaDevices = mediaFixture();
  const manager = createAudioDeviceManager({environment: {mediaDevices}});
  await manager.refresh();
  mediaDevices.devices = [{kind: 'audioinput', deviceId: 'mic-2', label: 'Mic two'}];
  mediaDevices.dispatch('devicechange');
  await waitForTick();
  await waitForTick();
  assert.deepEqual(manager.getState().inputs, [{id: 'mic-2', label: 'Mic two'}]);
  manager.dispose();
  mediaDevices.devices = [{kind: 'audioinput', deviceId: 'mic-3', label: 'Mic three'}];
  mediaDevices.dispatch('devicechange');
  await waitForTick();
  assert.deepEqual(manager.getState().inputs, [{id: 'mic-2', label: 'Mic two'}]);
});
