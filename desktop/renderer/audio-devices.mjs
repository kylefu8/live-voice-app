const MIC_AUTO_STOP_MS = 15_000;
const OUTPUT_AUTO_STOP_MS = 2_000;
const LEVEL_INTERVAL_MS = 80;

const ERROR_CODES = new Set([
  'audio_permission_denied',
  'audio_input_unavailable',
  'audio_output_unavailable',
  'audio_output_unsupported',
  'audio_test_failed',
]);

function fixedError(code) {
  const error = new Error(ERROR_CODES.has(code) ? code : 'audio_test_failed');
  error.code = ERROR_CODES.has(code) ? code : 'audio_test_failed';
  return error;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object');
}

function defaultEnvironment(environment) {
  const root = typeof globalThis === 'object' ? globalThis : {};
  return {
    mediaDevices: environment.mediaDevices ?? root.navigator?.mediaDevices,
    AudioContext: environment.AudioContext ?? root.AudioContext ?? root.webkitAudioContext,
    createAudio: environment.createAudio ?? (() => {
      if (typeof root.Audio !== 'function') throw fixedError('audio_test_failed');
      return new root.Audio();
    }),
    setTimeout: environment.setTimeout ?? root.setTimeout.bind(root),
    clearTimeout: environment.clearTimeout ?? root.clearTimeout.bind(root),
    setInterval: environment.setInterval ?? root.setInterval.bind(root),
    clearInterval: environment.clearInterval ?? root.clearInterval.bind(root),
    URL: environment.URL ?? root.URL,
    Blob: environment.Blob ?? root.Blob,
  };
}

function stopTracks(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return;
  let tracks;
  try {
    tracks = stream.getTracks();
  } catch {
    return;
  }
  if (!Array.isArray(tracks)) return;
  for (const track of tracks) {
    try {
      track?.stop?.();
    } catch {
      // Continue releasing the remaining tracks.
    }
  }
}

function closeAudioContext(context) {
  try {
    const result = context?.close?.();
    if (result && typeof result.catch === 'function') result.catch(() => undefined);
  } catch {
    // Context cleanup is best effort.
  }
}

function classifyMicrophoneError(error) {
  const name = String(error?.name ?? '');
  if (name === 'NotAllowedError' || name === 'SecurityError' || error?.code === 'audio_permission_denied') {
    return 'audio_permission_denied';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return 'audio_input_unavailable';
  }
  if (ERROR_CODES.has(error?.code)) return error.code;
  return 'audio_input_unavailable';
}

function classifyOutputError(error) {
  const name = String(error?.name ?? '');
  if (name === 'NotSupportedError' || error?.code === 'audio_output_unsupported') return 'audio_output_unsupported';
  if (ERROR_CODES.has(error?.code)) return error.code;
  return 'audio_output_unavailable';
}

function validDeviceId(value) {
  return typeof value === 'string' && value.length > 0 && value !== 'default' && value !== 'communications';
}

function enumerateDevices(mediaDevices) {
  if (!mediaDevices || typeof mediaDevices.enumerateDevices !== 'function') {
    throw fixedError('audio_input_unavailable');
  }
  return mediaDevices.enumerateDevices();
}

function audioDevices(value) {
  const inputs = [];
  const outputs = [];
  const seenInputs = new Set();
  const seenOutputs = new Set();
  if (!Array.isArray(value)) return {inputs, outputs};
  for (const device of value) {
    if (!isRecord(device) || !validDeviceId(device.deviceId)) continue;
    const id = device.deviceId;
    const label = typeof device.label === 'string' ? device.label : '';
    if (device.kind === 'audioinput' && !seenInputs.has(id)) {
      seenInputs.add(id);
      inputs.push({id, label});
    } else if (device.kind === 'audiooutput' && !seenOutputs.has(id)) {
      seenOutputs.add(id);
      outputs.push({id, label});
    }
  }
  return {inputs, outputs};
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
}

function toneWav(BlobCtor) {
  const sampleRate = 22_050;
  const durationSeconds = 0.8;
  const sampleCount = Math.floor(sampleRate * durationSeconds);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, sampleCount * 2, true);
  for (let index = 0; index < sampleCount; index += 1) {
    const frequency = index < sampleCount / 2 ? 440 : 660;
    const envelope = Math.min(1, index / (sampleRate * 0.02), (sampleCount - index) / (sampleRate * 0.02));
    const sample = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.08 * Math.max(0, envelope);
    view.setInt16(44 + index * 2, Math.round(sample * 32_767), true);
  }
  if (typeof BlobCtor !== 'function') throw fixedError('audio_test_failed');
  return new BlobCtor([buffer], {type: 'audio/wav'});
}

function rmsLevel(attempt) {
  const analyser = attempt.analyser;
  if (!analyser) return 0;
  const size = Math.max(32, Number(analyser.fftSize) || Number(analyser.frequencyBinCount) * 2 || 1024);
  if (typeof analyser.getFloatTimeDomainData === 'function') {
    const values = new Float32Array(size);
    analyser.getFloatTimeDomainData(values);
    let sum = 0;
    for (const value of values) sum += value * value;
    return Math.max(0, Math.min(1, Math.sqrt(sum / values.length) * 4));
  }
  if (typeof analyser.getByteTimeDomainData === 'function') {
    const values = new Uint8Array(size);
    analyser.getByteTimeDomainData(values);
    let sum = 0;
    for (const value of values) {
      const sample = (value - 128) / 128;
      sum += sample * sample;
    }
    return Math.max(0, Math.min(1, Math.sqrt(sum / values.length) * 4));
  }
  return 0;
}

export function createAudioDeviceManager({onChange = () => {}, environment = {}} = {}) {
  const env = defaultEnvironment(environment);
  const state = {
    inputs: [],
    outputs: [],
    microphoneStatus: 'idle',
    outputStatus: 'idle',
    level: 0,
    error: '',
    notice: '',
  };
  let disposed = false;
  let permissionSerial = 0;
  let enumerationSerial = 0;
  let microphoneSerial = 0;
  let outputSerial = 0;
  let permissionPending = false;
  let microphoneAttempt = null;
  let outputAttempt = null;

  function getState() {
    return {
      inputs: state.inputs.map((device) => ({...device})),
      outputs: state.outputs.map((device) => ({...device})),
      microphoneStatus: state.microphoneStatus,
      outputStatus: state.outputStatus,
      level: state.level,
      error: state.error,
      notice: state.notice,
    };
  }

  function emit() {
    if (disposed) return;
    try {
      onChange(getState());
    } catch {
      // A UI subscriber must not interrupt media cleanup.
    }
  }

  function update(patch) {
    if (disposed) return;
    Object.assign(state, patch);
    if (state.level < 0 || !Number.isFinite(state.level)) state.level = 0;
    if (state.level > 1) state.level = 1;
    emit();
  }

  function currentMicrophone(attempt) {
    return Boolean(attempt) && !disposed && microphoneAttempt === attempt && attempt.serial === microphoneSerial;
  }

  function currentOutput(attempt) {
    return Boolean(attempt) && !disposed && outputAttempt === attempt && attempt.serial === outputSerial;
  }

  function cleanupMicrophone(attempt) {
    if (!attempt) return;
    if (attempt.interval !== null) env.clearInterval(attempt.interval);
    if (attempt.timeout !== null) env.clearTimeout(attempt.timeout);
    attempt.interval = null;
    attempt.timeout = null;
    for (const {track, handler} of attempt.trackHandlers ?? []) {
      try { track.removeEventListener?.('ended', handler); } catch { /* best effort */ }
      try {
        if (track.onended === handler) track.onended = null;
      } catch { /* best effort */ }
    }
    attempt.trackHandlers = [];
    stopTracks(attempt.stream);
    closeAudioContext(attempt.context);
    attempt.stream = null;
    attempt.context = null;
    attempt.source = null;
    attempt.analyser = null;
    if (microphoneAttempt === attempt) microphoneAttempt = null;
  }

  function finishMicrophone(attempt, notice = '') {
    if (!currentMicrophone(attempt)) return getState();
    cleanupMicrophone(attempt);
    update({microphoneStatus: 'idle', level: 0, error: '', notice});
    return getState();
  }

  function cleanupOutput(attempt) {
    if (!attempt) return;
    if (attempt.timeout !== null) env.clearTimeout(attempt.timeout);
    attempt.timeout = null;
    const audio = attempt.audio;
    if (audio) {
      try { audio.removeEventListener?.('ended', attempt.onEnded); } catch { /* best effort */ }
      try {
        if (audio.onended === attempt.onEnded) audio.onended = null;
      } catch { /* best effort */ }
      try { audio.pause?.(); } catch { /* best effort */ }
      try { audio.currentTime = 0; } catch { /* best effort */ }
      try { audio.removeAttribute?.('src'); } catch { /* best effort */ }
      try { audio.src = ''; } catch { /* best effort */ }
      try { audio.load?.(); } catch { /* best effort */ }
    }
    if (attempt.url && typeof env.URL?.revokeObjectURL === 'function') {
      try { env.URL.revokeObjectURL(attempt.url); } catch { /* best effort */ }
    }
    if (outputAttempt === attempt) outputAttempt = null;
  }

  function finishOutput(attempt, notice = '') {
    if (!currentOutput(attempt)) return getState();
    cleanupOutput(attempt);
    update({outputStatus: 'idle', error: '', notice});
    return getState();
  }

  function failMicrophone(attempt, code) {
    if (!currentMicrophone(attempt)) {
      cleanupMicrophone(attempt);
      return getState();
    }
    cleanupMicrophone(attempt);
    update({microphoneStatus: 'idle', level: 0, error: code, notice: ''});
    return getState();
  }

  function failOutput(attempt, code) {
    if (!currentOutput(attempt)) {
      cleanupOutput(attempt);
      return getState();
    }
    cleanupOutput(attempt);
    update({outputStatus: 'idle', error: code, notice: ''});
    return getState();
  }

  async function refresh({requestPermission = false} = {}) {
    if (disposed) return getState();
    if (requestPermission) {
      // Permission refresh is an explicit capture operation. Stop any active
      // meter/tone first so a late permission result cannot overlap a test.
      stopMicrophoneTest();
      stopOutputTest();
    }
    const enumSerial = ++enumerationSerial;
    const permissionToken = requestPermission ? ++permissionSerial : null;
    let permissionStream = null;
    if (requestPermission) {
      permissionPending = true;
      update({microphoneStatus: 'starting', error: '', notice: ''});
      try {
        if (!env.mediaDevices || typeof env.mediaDevices.getUserMedia !== 'function') {
          throw fixedError('audio_input_unavailable');
        }
        permissionStream = await env.mediaDevices.getUserMedia({audio: true, video: false});
      } catch (error) {
        if (permissionToken !== permissionSerial || disposed) return getState();
        update({microphoneStatus: 'idle', error: classifyMicrophoneError(error), notice: ''});
        return getState();
      } finally {
        stopTracks(permissionStream);
        permissionStream = null;
        if (permissionToken === permissionSerial) permissionPending = false;
      }
      if (permissionToken !== permissionSerial || disposed) return getState();
    }
    try {
      const devices = await enumerateDevices(env.mediaDevices);
      if (disposed || (requestPermission ? permissionToken !== permissionSerial : enumSerial !== enumerationSerial)) return getState();
      const listed = audioDevices(devices);
      update({inputs: listed.inputs, outputs: listed.outputs, microphoneStatus: requestPermission ? 'idle' : state.microphoneStatus, error: '', notice: requestPermission ? '' : state.notice});
    } catch (error) {
      if (disposed || (requestPermission ? permissionToken !== permissionSerial : enumSerial !== enumerationSerial)) return getState();
      update({
        microphoneStatus: requestPermission ? 'idle' : state.microphoneStatus,
        error: error?.code === 'audio_output_unavailable' ? error.code : 'audio_input_unavailable',
      });
    }
    return getState();
  }

  async function startMicrophoneTest(inputDeviceId = '') {
    if (disposed) return getState();
    permissionSerial += 1;
    permissionPending = false;
    finishMicrophone(microphoneAttempt, '');
    finishOutput(outputAttempt, '');
    const attempt = {
      serial: ++microphoneSerial,
      stream: null,
      context: null,
      source: null,
      analyser: null,
      interval: null,
      timeout: null,
      trackHandlers: [],
    };
    microphoneAttempt = attempt;
    update({microphoneStatus: 'starting', outputStatus: 'idle', level: 0, error: '', notice: ''});
    try {
      if (!env.mediaDevices || typeof env.mediaDevices.getUserMedia !== 'function') {
        throw fixedError('audio_input_unavailable');
      }
      const audioConstraint = inputDeviceId
        ? {deviceId: {exact: inputDeviceId}}
        : true;
      const stream = await env.mediaDevices.getUserMedia({audio: audioConstraint, video: false});
      if (!currentMicrophone(attempt)) {
        stopTracks(stream);
        return getState();
      }
      attempt.stream = stream;
      try {
        const tracks = typeof stream?.getTracks === 'function' ? stream.getTracks() : [];
        for (const track of Array.isArray(tracks) ? tracks : []) {
          const handler = () => failMicrophone(attempt, 'audio_input_unavailable');
          attempt.trackHandlers.push({track, handler});
          if (typeof track?.addEventListener === 'function') track.addEventListener('ended', handler, {once: true});
          else if (track && 'onended' in track) track.onended = handler;
        }
      } catch {
        // Track-end notification is optional; interval and explicit stop still clean up.
      }
      const Context = env.AudioContext;
      if (typeof Context !== 'function') throw fixedError('audio_test_failed');
      try {
        attempt.context = new Context();
      } catch {
        attempt.context = Context();
      }
      if (!attempt.context || typeof attempt.context.createAnalyser !== 'function' || typeof attempt.context.createMediaStreamSource !== 'function') {
        throw fixedError('audio_test_failed');
      }
      attempt.analyser = attempt.context.createAnalyser();
      attempt.analyser.fftSize = Number(attempt.analyser.fftSize) || 1024;
      attempt.source = attempt.context.createMediaStreamSource(stream);
      attempt.source.connect(attempt.analyser);
      if (typeof attempt.context.resume === 'function') await attempt.context.resume();
      if (!currentMicrophone(attempt)) {
        cleanupMicrophone(attempt);
        return getState();
      }
      update({microphoneStatus: 'testing', level: 0, error: '', notice: ''});
      attempt.interval = env.setInterval(() => {
        if (currentMicrophone(attempt)) update({level: rmsLevel(attempt)});
      }, LEVEL_INTERVAL_MS);
      attempt.timeout = env.setTimeout(() => {
        finishMicrophone(attempt, 'microphone_done');
      }, MIC_AUTO_STOP_MS);
    } catch (error) {
      if (!currentMicrophone(attempt)) {
        stopTracks(attempt.stream);
        closeAudioContext(attempt.context);
        return getState();
      }
      return failMicrophone(attempt, error?.code === 'audio_test_failed' ? 'audio_test_failed' : classifyMicrophoneError(error));
    }
    return getState();
  }

  function stopMicrophoneTest() {
    if (disposed) return getState();
    microphoneSerial += 1;
    const attempt = microphoneAttempt;
    microphoneAttempt = null;
    cleanupMicrophone(attempt);
    update({microphoneStatus: 'idle', level: 0, error: '', notice: attempt ? 'microphone_done' : ''});
    return getState();
  }

  async function testOutput(outputDeviceId = '') {
    if (disposed) return getState();
    permissionSerial += 1;
    permissionPending = false;
    finishMicrophone(microphoneAttempt, '');
    finishOutput(outputAttempt, '');
    const attempt = {
      serial: ++outputSerial,
      audio: null,
      url: '',
      timeout: null,
      onEnded: null,
    };
    outputAttempt = attempt;
    update({outputStatus: 'testing', error: '', notice: ''});
    try {
      const audio = env.createAudio();
      if (!audio || typeof audio !== 'object') throw fixedError('audio_test_failed');
      attempt.audio = audio;
      const URLApi = env.URL;
      if (!URLApi || typeof URLApi.createObjectURL !== 'function') throw fixedError('audio_test_failed');
      const blob = toneWav(env.Blob);
      attempt.url = URLApi.createObjectURL(blob);
      audio.preload = 'auto';
      audio.src = attempt.url;
      attempt.onEnded = () => finishOutput(attempt, 'output_done');
      if (typeof audio.addEventListener === 'function') audio.addEventListener('ended', attempt.onEnded, {once: true});
      else audio.onended = attempt.onEnded;
      attempt.timeout = env.setTimeout(() => finishOutput(attempt, 'output_done'), OUTPUT_AUTO_STOP_MS);
      if (outputDeviceId) {
        if (typeof audio.setSinkId !== 'function') throw fixedError('audio_output_unsupported');
        try {
          await audio.setSinkId(outputDeviceId);
        } catch (error) {
          throw fixedError(classifyOutputError(error));
        }
      }
      if (!currentOutput(attempt)) return getState();
      if (typeof audio.play !== 'function') throw fixedError('audio_test_failed');
      try {
        await audio.play();
      } catch {
        throw fixedError('audio_test_failed');
      }
      if (!currentOutput(attempt)) return getState();
    } catch (error) {
      if (!currentOutput(attempt)) {
        cleanupOutput(attempt);
        return getState();
      }
      return failOutput(attempt, ERROR_CODES.has(error?.code) ? error.code : 'audio_test_failed');
    }
    return getState();
  }

  function stopOutputTest() {
    if (disposed) return getState();
    outputSerial += 1;
    const attempt = outputAttempt;
    outputAttempt = null;
    cleanupOutput(attempt);
    update({outputStatus: 'idle', error: '', notice: attempt ? 'output_done' : ''});
    return getState();
  }

  function stopTests() {
    if (disposed) return getState();
    permissionSerial += 1;
    permissionPending = false;
    stopMicrophoneTest();
    stopOutputTest();
    return getState();
  }

  const onDeviceChange = () => {
    if (!disposed) void refresh({requestPermission: false});
  };
  try {
    env.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
  } catch {
    // Device-change events are optional; manual refresh remains available.
  }

  function dispose() {
    if (disposed) return;
    stopTests();
    disposed = true;
    try {
      env.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
    } catch {
      // Listener cleanup is best effort.
    }
  }

  return {
    refresh,
    startMicrophoneTest,
    stopMicrophoneTest,
    testOutput,
    stopOutputTest,
    stopTests,
    dispose,
    getState,
  };
}

export {MIC_AUTO_STOP_MS, OUTPUT_AUTO_STOP_MS, LEVEL_INTERVAL_MS};
