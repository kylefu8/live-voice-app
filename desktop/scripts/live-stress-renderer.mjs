import {createDesktopLive} from '../renderer/live.ts';
import {completedRoundPath} from './stress-round.mjs';

const bridge = window.stressLive;
const remoteAudio = document.querySelector('#stress-remote-audio');
const promptAudio = document.querySelector('#stress-prompt-audio');
const ROUND_TIMEOUT_MS = 120_000;
const QUIET_MS = 3_000;
const PROMPT_TIMEOUT_MS = 60_000;

let audioContext = null;
let mediaSource = null;
let mediaDestination = null;
let silenceSource = null;
let controller = null;
let manifest = null;
let sessionConnected = false;
let sessionEverConnected = false;
let stopRequested = false;
let closing = false;
let closePromise = null;
let closedResult = null;
let currentRound = null;
let firstError = '';
const runErrorCodes = new Set();
let heartbeatTimer = null;
const closeDiagnostics = [];
let closeStartedAt = 0;

// Observe only timing metadata. Never persist transcript text or session IDs.
class ObservedPeer extends RTCPeerConnection {
  createDataChannel(...args) {
    const channel = super.createDataChannel(...args);
    const send = channel.send.bind(channel);
    channel.send = value => {
      if (closing && manifest?.suppressPrimaryClose && JSON.parse(value).type === 'session.close') {
        closeDiagnostics.push({type: 'client.suppressed_close', elapsedMs: performance.now() - closeStartedAt});
        return;
      }
      const result = send(value);
      if (closing) closeDiagnostics.push({type: 'client.send', elapsedMs: performance.now() - closeStartedAt, bufferedAmount: channel.bufferedAmount});
      return result;
    };
    channel.addEventListener('message', event => {
      if (closing && closeDiagnostics.length < 40 && typeof event.data === 'string') {
        try { closeDiagnostics.push({type: JSON.parse(event.data).type, elapsedMs: performance.now()-closeStartedAt, bytes: event.data.length}); } catch {}
      }
      if (!currentRound || currentRound.timeline.length >= 300 || typeof event.data !== 'string') return;
      try {
        const value = JSON.parse(event.data);
        const kind = value.type === 'session.input_transcript.delta' ? 'user'
          : value.type === 'session.output_transcript.delta' ? 'assistant'
          : value.type === 'session.delegation.created' ? 'delegation' : null;
        if (!kind) return;
        const item = {kind, receivedMs: Math.round(performance.now() - currentRound.startedAt)};
        for (const key of ['start_ms', 'end_ms', 'offset_ms']) {
          if (typeof value[key] === 'number' && Number.isFinite(value[key])) item[key] = value[key];
        }
        currentRound.timeline.push(item);
      } catch { /* Invalid provider data is handled by the production controller. */ }
    });
    return channel;
  }
}

class StressError extends Error {
  constructor(code) {
    super(code);
    this.name = 'StressError';
    this.code = code;
  }
}

function fixedCode(error, fallback = 'stress_failed') {
  const value = error && typeof error.code === 'string'
    ? error.code
    : error && typeof error.message === 'string'
      ? error.message
      : '';
  return /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : fallback;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function bridgeCall(name, args) {
  if (!bridge || typeof bridge[name] !== 'function') throw new StressError('stress_ipc_denied');
  const result = await bridge[name](args);
  if (!result || result.ok !== true) throw new StressError(fixedCode(result, 'stress_ipc_denied'));
  return result.value;
}

function addError(code) {
  const safe = fixedCode({code});
  runErrorCodes.add(safe);
  if (currentRound && !currentRound.errorCodes.includes(safe)) currentRound.errorCodes.push(safe);
  if (currentRound) currentRound.lastErrorAt = performance.now();
  if (!firstError) firstError = safe;
}

function updateLifecycle(value) {
  void bridgeCall('recordLifecycle', value).catch(error => {
    addError(fixedCode(error, 'stress_report_failed'));
  });
}

function onStatus(status) {
  if (status === 'connected') {
    sessionConnected = true;
    sessionEverConnected = true;
    updateLifecycle({sessionStarted: true});
  } else if (status === 'closed') {
    sessionConnected = false;
  }
}

function onTranscript(fragment) {
  if (!currentRound || !fragment || fragment.role !== 'assistant') return;
  currentRound.assistantFragments += 1;
  if (currentRound.backendResults > 0) currentRound.assistantAfterResultFragments += 1;
  currentRound.lastAssistantAt = performance.now();
  if (typeof fragment.text === 'string') {
    currentRound.expectedTextTail = `${currentRound.expectedTextTail}${fragment.text}`.slice(-2_000);
  }
  const expected = currentRound.expectedPhrase;
  if (expected && currentRound.expectedTextTail) {
    const normalized = normalizePhrase(currentRound.expectedTextTail);
    const wanted = normalizePhrase(expected);
    if (wanted && normalized.includes(wanted)) currentRound.expectedPhraseMatched = true;
  }
}

function normalizePhrase(value) {
  const numberWords = {
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  };
  return String(value || '')
    .toLocaleLowerCase()
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/gu, word => numberWords[word])
    .replace(/[^a-z0-9]+/gu, '')
    .trim();
}

function onBackendStatus(status) {
  if (!currentRound) return;
  currentRound.backendStatus = status;
  if (status === 'working') currentRound.backendCalls += 1;
}

function onClosed(result) {
  closedResult = result && typeof result === 'object' ? result : {confirmed: false};
  sessionConnected = false;
  updateLifecycle({
    closedCallback: true,
    localCleanup: true,
    confirmedClose: closedResult.confirmed === true,
  });
}

function callbacks() {
  return {
    onStatus,
    onTranscript,
    onError: addError,
    onBackendStatus,
    onSources: () => {},
    onClosed,
  };
}

async function setupSyntheticAudio() {
  if (typeof window.AudioContext !== 'function' && typeof window.webkitAudioContext !== 'function') {
    throw new StressError('stress_audio_setup');
  }
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  audioContext = new AudioContextCtor();
  mediaSource = audioContext.createMediaElementSource(promptAudio);
  mediaDestination = audioContext.createMediaStreamDestination();
  mediaSource.connect(mediaDestination);
  // Keep input audio advancing while waiting for backend work and close ACKs.
  silenceSource = audioContext.createConstantSource();
  silenceSource.offset.value = 0;
  silenceSource.connect(mediaDestination);
  silenceSource.connect(audioContext.destination);
  silenceSource.start();
  await audioContext.resume();
  remoteAudio.muted = true;
  remoteAudio.autoplay = true;
}

async function preflightAudio(rounds) {
  if (!Array.isArray(rounds) || rounds.length === 0) throw new StressError('stress_audio_setup');
  await bridgeCall('recordProgress', {phase: 'audio-preflight', round: 0});
  for (const item of rounds) {
    const url = new URL(`audio/${encodeURIComponent(item.file)}`, location.href).toString();
    const response = await fetch(url, {cache: 'no-store'});
    if (!response.ok) throw new StressError('stress_prompt_audio_missing');
    const bytes = await response.arrayBuffer();
    if (typeof audioContext.decodeAudioData === 'function') {
      await audioContext.decodeAudioData(bytes.slice(0));
    }
  }
  // Exercise the same media-element playback path used for every round before
  // creating a Live session. A local failure therefore cannot consume service
  // quota or create a false batch of round failures.
  await playPrompt(rounds[0].file, false);
  promptAudio.pause();
  promptAudio.currentTime = 0;
}

async function playPrompt(file, requireSession = true) {
  const url = new URL(`audio/${encodeURIComponent(file)}`, location.href).toString();
  promptAudio.pause();
  promptAudio.currentTime = 0;
  promptAudio.src = url;
  promptAudio.load();
  await new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    let poll = null;
    const cleanup = () => {
      promptAudio.removeEventListener('ended', onEnded);
      promptAudio.removeEventListener('error', onError);
      if (timeout) clearTimeout(timeout);
      if (poll) clearInterval(poll);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onEnded = () => finish();
    const onError = () => finish(new StressError('stress_prompt_playback'));
    promptAudio.addEventListener('ended', onEnded, {once: true});
    promptAudio.addEventListener('error', onError, {once: true});
    timeout = setTimeout(() => finish(new StressError('stress_prompt_timeout')), PROMPT_TIMEOUT_MS);
    poll = setInterval(() => {
      if (stopRequested || (requireSession && !sessionConnected)) finish(new StressError('stress_voice_disconnected'));
    }, 100);
    Promise.resolve(promptAudio.play()).catch(onError);
  });
}

async function waitForRound() {
  const deadline = performance.now() + ROUND_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (stopRequested) throw new StressError('stress_timeout');
    if (!sessionConnected) throw new StressError('stress_voice_disconnected');
    const last = currentRound?.lastAssistantAt ?? 0;
    const completionPath = completedRoundPath(currentRound, performance.now(), QUIET_MS);
    if (completionPath) { currentRound.completionPath = completionPath; return; }
    if (currentRound?.errorCodes.length && currentRound.backendStatus !== 'working' &&
        performance.now() - Math.max(last, currentRound.lastErrorAt || 0) >= 5_000) return;
    await delay(100);
  }
  throw new StressError('stress_round_timeout');
}

async function runRound(item) {
  currentRound = {
    round: item.round,
    kind: item.kind,
    startedAt: performance.now(),
    assistantFragments: 0,
    backendCalls: 0,
    backendResults: 0,
    assistantAfterResultFragments: 0,
    backendStatus: 'idle',
    phase: 'prompt',
    lastAssistantAt: 0,
    expectedPhrase: typeof item.expectedPhrase === 'string' ? item.expectedPhrase : '',
    expectedTextTail: '',
    expectedPhraseMatched: false,
    errorCodes: [],
    timeline: [],
  };
  await bridgeCall('recordProgress', {phase: 'prompt', round: item.round});
  let status = 'passed';
  try {
    await playPrompt(item.file);
    currentRound.promptEndedAt = performance.now();
    currentRound.phase = 'waiting';
    await bridgeCall('recordProgress', {phase: 'waiting', round: item.round});
    await waitForRound();
  } catch (error) {
    status = error && error.code === 'stress_round_timeout' ? 'timeout' : 'failed';
    addError(fixedCode(error));
  }
  if (currentRound.errorCodes.length > 0 && status === 'passed') status = 'failed';
  const elapsedMs = Math.max(0, performance.now() - currentRound.startedAt);
  const summary = {
    round: item.round,
    kind: item.kind,
    status,
    elapsedMs,
    assistantFragments: currentRound.assistantFragments,
    backendCalls: currentRound.backendCalls,
    backendResults: currentRound.backendResults,
    assistantAfterResultFragments: currentRound.assistantAfterResultFragments,
    expectedPhraseMatched: currentRound.expectedPhraseMatched,
    completionPath: currentRound.completionPath || 'none',
    errorCodes: currentRound.errorCodes.slice(0, 32),
    timeline: currentRound.timeline,
  };
  await bridgeCall('recordRound', summary);
  currentRound = null;
  if (summary.errorCodes.some(code => code.startsWith('stress_prompt_'))) {
    throw new StressError(summary.errorCodes.find(code => code.startsWith('stress_prompt_')));
  }
  if (!sessionConnected) throw new StressError('stress_voice_disconnected');
  return summary;
}

async function closeSession() {
  if (!controller) return;
  if (closePromise) return closePromise;
  closing = true;
  closeStartedAt = performance.now();
  updateLifecycle({closeRequested: true});
  closePromise = (async () => {
    try {
      await controller.close();
    } catch (error) {
      addError(fixedCode(error));
    }
    controller.dispose();
  })();
  return closePromise;
}

async function closeAudio() {
  try {
    promptAudio.pause();
    promptAudio.removeAttribute('src');
    promptAudio.load();
  } catch {
    addError('stress_audio_setup');
  }
  try {
    mediaSource?.disconnect();
    silenceSource?.stop();
    silenceSource?.disconnect();
  } catch {
    // Best-effort synthetic audio cleanup.
  }
  try {
    if (audioContext && audioContext.state !== 'closed') await audioContext.close();
  } catch {
    addError('stress_audio_setup');
  }
  updateLifecycle({audioContextClosed: true});
}

async function run() {
  manifest = await bridgeCall('getManifest');
  await setupSyntheticAudio();
  await preflightAudio(manifest.rounds);
  updateLifecycle({rendererStarted: true});
  controller = createDesktopLive({
    api: {
      ...bridge,
      async runBackend(args) {
        const round = currentRound;
        const result = await bridge.runBackend(args);
        if (round && currentRound === round && result?.ok) round.backendResults += 1;
        return result;
      },
    },
    audio: remoteAudio,
    callbacks: callbacks(),
    environment: {
      RTCPeerConnection: ObservedPeer,
      navigator: {
        mediaDevices: {
          getUserMedia: async () => mediaDestination.stream,
        },
      },
    },
  });
  await bridgeCall('recordProgress', {phase: 'starting', round: 0});
  await controller.start(manifest.mode);
  if (!sessionConnected) throw new StressError(firstError || 'stress_voice_start_failed');
  heartbeatTimer = setInterval(() => {
    if (!currentRound) return;
    void bridgeCall('recordProgress', {
      phase: currentRound.phase, round: currentRound.round,
      backendStatus: currentRound.backendStatus,
      elapsedMs: performance.now() - currentRound.startedAt,
    }).catch(error => {
      addError(fixedCode(error, 'stress_report_failed'));
    });
  }, 5_000);
  for (const item of manifest.rounds) {
    if (stopRequested) throw new StressError('stress_timeout');
    await runRound(item);
  }
  const idleUntil = performance.now() + (manifest.idleBeforeCloseMs || 0);
  while (performance.now() < idleUntil && !stopRequested && sessionConnected) {
    await bridgeCall('recordProgress', {phase: 'idle-before-close', round: manifest.rounds.length});
    await delay(Math.min(5000, idleUntil - performance.now()));
  }
}

async function main() {
  if (!bridge) throw new StressError('stress_ipc_denied');
  const stopUnsubscribe = typeof bridge.onStop === 'function'
    ? bridge.onStop(value => {
      stopRequested = true;
      addError(fixedCode(value, 'stress_timeout'));
      void closeSession();
    })
    : () => {};
  let status = 'completed';
  try {
    await run();
  } catch (error) {
    status = 'failed';
    addError(fixedCode(error));
  }
  await closeSession();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await closeAudio();
  stopUnsubscribe();
  const confirmedClose = closedResult?.confirmed === true;
  await bridgeCall('finish', {
    status,
    firstError,
    closeDiagnostics,
    errorCodes: [...runErrorCodes],
    confirmedClose,
    lifecycle: {
      rendererStarted: true,
      sessionStarted: sessionEverConnected,
      closeRequested: closing,
      closedCallback: closedResult !== null,
      localCleanup: closedResult !== null,
      confirmedClose,
      audioContextClosed: true,
    },
  }).catch(() => undefined);
}

void main().catch(error => {
  addError(fixedCode(error));
  void bridgeCall('finish', {status: 'failed', confirmedClose: false}).catch(() => undefined);
});
