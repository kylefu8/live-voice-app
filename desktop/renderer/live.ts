import {
  ErrorCode,
  ProtocolError,
  buildVoiceInstructions,
  buildVoiceUpdateInstructions,
  validateVoicePreferences,
  newEventId,
} from '../../native/src/protocol';
import type {
  ConversationRecord,
  Locale,
  Mode,
  TranscriptFragment,
  VoicePreferences,
} from '../../native/src/types';

/**
 * The renderer never receives a credential.  The main process owns the
 * saved-credential snapshot and turns these calls into fixed-code envelopes.
 */
export interface DesktopLiveApi {
  createSession(args: {
    attemptId: string;
    sdp: string;
    mode: Mode;
  }): Promise<BridgeEnvelope<{
    sessionId: string;
    sdp: string;
    settings?: DesktopSessionSettings;
  }>>;
  cancelSession(args: {attemptId: string}): Promise<BridgeEnvelope<null>>;
  finalizeSession?(args: {attemptId: string}): Promise<BridgeEnvelope<{confirmed: boolean}>>;
  runBackend(args: {
    attemptId: string;
    delegationId: string;
    history: TranscriptFragment[];
  }): Promise<BridgeEnvelope<{text: string; sources?: Source[] }>>;
  cancelBackend(args: {attemptId: string}): Promise<BridgeEnvelope<null>>;
}

export type BridgeEnvelope<T> =
  | {ok: true; value: T}
  | {ok: false; code: string};

export interface Source {
  title: string;
  url: string;
}

export interface DesktopSessionSettings {
  locale?: Locale;
  mode?: Mode;
  voice?: Partial<VoicePreferences>;
  backend?: {enabled?: boolean};
}

export interface DesktopLiveCallbacks {
  onStatus(status: 'idle' | 'connecting' | 'connected' | 'closing' | 'closed'): void;
  onTranscript(fragment: TranscriptFragment): void;
  onError(code: string): void;
  onBackendStatus(status: 'idle' | 'working' | 'done' | 'error'): void;
  onSources(sources: Source[]): void;
  onClosed(result: {confirmed: boolean; record: ConversationRecord | null}): void;
}

export interface DesktopLiveEnvironment {
  navigator?: {
    mediaDevices?: {
      getUserMedia(constraints: {audio: boolean | Record<string, unknown>; video: boolean}): Promise<any>;
    };
  };
  RTCPeerConnection?: new (...args: any[]) => any;
  MediaStream?: new (tracks?: any[]) => any;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  now?: () => number;
}

export interface DesktopLiveController {
  start(mode: Mode): Promise<void>;
  close(): Promise<boolean>;
  dispose(): void;
  setMuted(muted: boolean): void;
  appendStyle(preferences: VoicePreferences): Promise<void>;
  updatePreferences(update: {voice?: VoicePreferences; backend?: {enabled: boolean}}): Promise<void>;
}

export interface AudioDeviceSelection {
  inputDeviceId: string;
  outputDeviceId: string;
}

type Timer = ReturnType<typeof setTimeout>;
type AudioElement = HTMLAudioElement & {
  srcObject?: any;
  setSinkId?: (sinkId: string) => Promise<void>;
  play?: () => Promise<void> | void;
  pause?: () => void;
};

interface PendingCommand {
  eventId: string;
  ackType: string;
  timer: Timer;
  resolve: () => void;
  reject: (error: ProtocolError) => void;
}

interface Attempt {
  generation: number;
  attemptId: string;
  mode: Mode;
  abort: AbortController;
  backendAbort: AbortController;
  peer: any;
  channel: any;
  localStream: any;
  remoteStream: any;
  sessionId: string | null;
  settings: DesktopSessionSettings;
  started: boolean;
  startedAt: number | null;
  closing: boolean;
  cancelled: boolean;
  cleaned: boolean;
  confirmedClose: boolean;
  closeSent: boolean;
  closeSettled: boolean;
  closeResolve: ((confirmed: boolean) => void) | null;
  closePromise: Promise<boolean>;
  closedCallback: boolean;
  startResolve: (() => void) | null;
  startReject: ((error: ProtocolError) => void) | null;
  pendingCommands: Map<string, PendingCommand>;
  seenDelegations: Set<string>;
  history: TranscriptFragment[];
  historyBytes: number;
  taskRevision: number;
  activeDelegation: {
    id: string;
    revision: number;
    offsetMs: number | null;
    lastUserEndMs: number | null;
    transcriptVersion: number;
    replacementUsed: boolean;
    dispatched: boolean;
    runner: boolean;
  } | null;
  failureNotices: Set<string>;
  expiryTimer: Timer | null;
  sessionStartTimer: Timer | null;
  desiredMuted: boolean;
  sessionCreationAttempted: boolean;
  sessionCreatePending: boolean;
  sessionCancelSent: boolean;
  inputTrackCleanups: Array<() => void>;
  finalizationUnknown: boolean;
}

const START_TIMEOUT_MS = 30_000;
const ICE_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 8_000;
const CLOSE_TIMEOUT_MS = 15_000;
const DELEGATION_SETTLE_MS = 250;
const CONTINUOUS_UTTERANCE_GAP_MS = 1_500;
const CONTINUOUS_UTTERANCE_QUIET_MS = 1_500;
const MAX_FRAGMENT_CHARS = 16_000;
const MAX_HISTORY_FRAGMENTS = 500;
const MAX_HISTORY_BYTES = 256 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const PLAYBACK_ERROR = 'voice_playback';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clearTimer(timer: Timer | null, clear: (timer: Timer) => void): void {
  if (timer !== null) clear(timer);
}

function safeCode(value: unknown, fallback: string): string {
  if (typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(value)) return value;
  return fallback;
}

function protocolError(error: unknown, fallback: string): ProtocolError {
  if (error instanceof ProtocolError) return error;
  if (isRecord(error) && typeof error.code === 'string') {
    return new ProtocolError(safeCode(error.code, fallback) as never);
  }
  return new ProtocolError(fallback as never);
}

function report(callbacks: DesktopLiveCallbacks, code: string): void {
  try {
    callbacks.onError(code);
  } catch {
    // Keep transport cleanup independent from the UI.
  }
}

function setStatus(callbacks: DesktopLiveCallbacks, value: 'idle' | 'connecting' | 'connected' | 'closing' | 'closed'): void {
  try {
    callbacks.onStatus(value);
  } catch {
    // Keep transport cleanup independent from the UI.
  }
}

function setBackendStatus(callbacks: DesktopLiveCallbacks, value: 'idle' | 'working' | 'done' | 'error'): void {
  try {
    callbacks.onBackendStatus(value);
  } catch {
    // Keep transport cleanup independent from the UI.
  }
}

function isOpen(channel: any): boolean {
  if (!channel) return false;
  if (channel.readyState === undefined || channel.readyState === null) return true;
  return channel.readyState === 'open' || channel.readyState === 1;
}

function stopStream(stream: any): void {
  if (!stream) return;
  try {
    const tracks = typeof stream.getTracks === 'function' ? stream.getTracks() : [];
    for (const track of tracks) {
      try {
        track.stop?.();
      } catch {
        // Continue releasing the remaining tracks.
      }
    }
  } catch {
    // Resource release is best effort.
  }
}

function detachInputTrackListeners(attempt: Attempt): void {
  for (const cleanup of attempt.inputTrackCleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      // Listener cleanup is best effort and must happen before track.stop().
    }
  }
}

function inputErrorCode(error: unknown): string {
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return 'audio_permission_denied';
  }
  return 'audio_input_unavailable';
}

function normalizedDeviceId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function audioInputConstraints(inputDeviceId: string): Record<string, unknown> {
  return {
    ...(inputDeviceId ? {deviceId: {exact: inputDeviceId}} : {}),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

function setLocalMuted(stream: any, muted: boolean): void {
  if (!stream || typeof stream.getAudioTracks !== 'function') return;
  try {
    for (const track of stream.getAudioTracks()) {
      try {
        track.enabled = !muted;
      } catch {
        // Continue applying mute to remaining tracks.
      }
    }
  } catch {
    // Resource state is best effort.
  }
}

function eventData(raw: unknown): unknown {
  if (isRecord(raw) && 'data' in raw) return raw.data;
  return raw;
}

function stringData(raw: unknown): string | null {
  const value = eventData(raw);
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).byteLength > MAX_EVENT_BYTES) return null;
    return value;
  }
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
    if (value.byteLength > MAX_EVENT_BYTES) return null;
    try {
      return new TextDecoder('utf-8', {fatal: true}).decode(new Uint8Array(value));
    } catch {
      return null;
    }
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
    if (value.byteLength > MAX_EVENT_BYTES) return null;
    try {
      return new TextDecoder('utf-8', {fatal: true}).decode(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      );
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeTranscript(event: Record<string, unknown>): TranscriptFragment | null {
  if (typeof event.delta !== 'string' || event.delta.length === 0) return null;
  const startMs = Number(event.start_ms);
  const endMs = Number(event.end_ms);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const role = event.type === 'session.output_transcript.delta' ? 'assistant' : 'user';
  return {
    role,
    text: event.delta.slice(0, MAX_FRAGMENT_CHARS),
    startMs: Math.max(0, startMs),
    endMs: Math.max(startMs, endMs),
  };
}

function appendHistory(attempt: Attempt, fragment: TranscriptFragment): void {
  if (!fragment.text) return;
  const previous = attempt.history[attempt.history.length - 1];
  if (
    previous &&
    previous.role === fragment.role &&
    fragment.startMs - previous.endMs < 2500 &&
    previous.text.length + fragment.text.length <= MAX_FRAGMENT_CHARS
  ) {
    attempt.historyBytes -= previous.text.length;
    previous.text += fragment.text;
    previous.endMs = Math.max(previous.endMs, fragment.endMs);
    attempt.historyBytes += previous.text.length;
  } else {
    attempt.history.push({...fragment});
    attempt.historyBytes += fragment.text.length;
  }
  while (
    attempt.history.length > MAX_HISTORY_FRAGMENTS ||
    attempt.historyBytes > MAX_HISTORY_BYTES
  ) {
    const firstUser = attempt.history.findIndex(item => item.role === 'user');
    const lastUser = attempt.history.map(item => item.role).lastIndexOf('user');
    const protectedItems = new Set([firstUser, lastUser, attempt.history.length - 1]);
    for (const index of [firstUser, lastUser]) {
      if (index < 0) continue;
      if (attempt.history[index + 1]?.role === 'assistant') protectedItems.add(index + 1);
      else if (attempt.history[index - 1]?.role === 'assistant') protectedItems.add(index - 1);
    }
    const removeIndex = attempt.history.findIndex((_item, index) => !protectedItems.has(index));
    if (removeIndex < 0) break;
    const [removed] = attempt.history.splice(removeIndex, 1);
    if (removed) attempt.historyBytes -= removed.text.length;
    else break;
  }
}

function clearAudio(audio: AudioElement, attempt: Attempt): void {
  try {
    audio.pause?.();
  } catch {
    // Ignore playback cleanup failures.
  }
  try {
    if (audio.srcObject === attempt.remoteStream || attempt.remoteStream === null) {
      audio.srcObject = null;
    }
  } catch {
    // Ignore playback cleanup failures.
  }
}

function nowFrom(environment: DesktopLiveEnvironment): number {
  return environment.now?.() ?? Date.now();
}

function makeAttempt(
  attemptId: string,
  mode: Mode,
  generation: number,
): Attempt {
  let closeResolve: ((confirmed: boolean) => void) | null = null;
  const closePromise = new Promise<boolean>((resolve) => {
    closeResolve = resolve;
  });
  return {
    generation,
    attemptId,
    mode,
    abort: new AbortController(),
    backendAbort: new AbortController(),
    peer: null,
    channel: null,
    localStream: null,
    remoteStream: null,
    sessionId: null,
    settings: {},
    started: false,
    startedAt: null,
    closing: false,
    cancelled: false,
    cleaned: false,
    confirmedClose: false,
    closeSent: false,
    closeSettled: false,
    closeResolve,
    closePromise,
    closedCallback: false,
    startResolve: null,
    startReject: null,
    pendingCommands: new Map(),
    seenDelegations: new Set(),
    history: [],
    historyBytes: 0,
    taskRevision: 0,
    activeDelegation: null,
    failureNotices: new Set(),
    expiryTimer: null,
    sessionStartTimer: null,
    desiredMuted: false,
    sessionCreationAttempted: false,
    sessionCreatePending: false,
    sessionCancelSent: false,
    inputTrackCleanups: [],
    finalizationUnknown: false,
  };
}

function markClosed(attempt: Attempt, confirmed: boolean): void {
  if (attempt.closeSettled) return;
  attempt.closeSettled = true;
  attempt.confirmedClose = confirmed;
  attempt.closeResolve?.(confirmed);
  attempt.closeResolve = null;
}

function makeRecord(
  attempt: Attempt,
  confirmed: boolean,
  now: () => number,
): ConversationRecord | null {
  if (!attempt.started || attempt.startedAt === null || attempt.history.length === 0) return null;
  return {
    id: `local-${attempt.attemptId}`,
    mode: attempt.mode,
    startedAt: attempt.startedAt,
    durationSeconds: Math.max(1, Math.floor((now() - attempt.startedAt) / 1000)),
    confirmedClose: confirmed,
    fragments: attempt.history.map((fragment) => ({...fragment})),
  };
}

function safeOnClosed(
  attempt: Attempt,
  callbacks: DesktopLiveCallbacks,
  confirmed: boolean,
  now: () => number,
): void {
  markClosed(attempt, confirmed);
  if (attempt.closedCallback) return;
  attempt.closedCallback = true;
  try {
    callbacks.onClosed({
      confirmed,
      record: makeRecord(attempt, confirmed, now),
    });
  } catch {
    // Cleanup must remain complete even if the UI callback throws.
  }
}

function rejectPending(attempt: Attempt, clear: (timer: Timer) => void): void {
  for (const pending of attempt.pendingCommands.values()) {
    clearTimer(pending.timer, clear);
    pending.reject(new ProtocolError(ErrorCode.SESSION_CANCELLED));
  }
  attempt.pendingCommands.clear();
}

function cleanupAttempt(
  attempt: Attempt,
  callbacks: DesktopLiveCallbacks,
  audio: AudioElement,
  environment: DesktopLiveEnvironment,
  confirmed: boolean,
): void {
  if (attempt.cleaned) {
    safeOnClosed(attempt, callbacks, confirmed, () => nowFrom(environment));
    return;
  }
  attempt.cleaned = true;
  attempt.cancelled = true;
  if (!confirmed && (attempt.sessionCreationAttempted || attempt.sessionId)) {
    attempt.finalizationUnknown = true;
  }
  clearTimer(attempt.expiryTimer, environment.clearTimeout ?? clearTimeout);
  clearTimer(attempt.sessionStartTimer, environment.clearTimeout ?? clearTimeout);
  attempt.expiryTimer = null;
  attempt.sessionStartTimer = null;
  attempt.abort.abort();
  attempt.backendAbort.abort();
  attempt.startReject?.(new ProtocolError(ErrorCode.SESSION_CANCELLED));
  attempt.startReject = null;
  rejectPending(attempt, environment.clearTimeout ?? clearTimeout);
  const channel = attempt.channel;
  attempt.channel = null;
  if (channel) {
    channel.onopen = null;
    channel.onmessage = null;
    channel.onerror = null;
    channel.onclose = null;
    try {
      channel.close?.();
    } catch {
      // Continue releasing the peer connection.
    }
  }
  const peer = attempt.peer;
  attempt.peer = null;
  if (peer) {
    peer.ontrack = null;
    peer.onconnectionstatechange = null;
    peer.oniceconnectionstatechange = null;
    peer.onicegatheringstatechange = null;
    try {
      peer.close?.();
    } catch {
      // Continue releasing media resources.
    }
  }
  detachInputTrackListeners(attempt);
  stopStream(attempt.localStream);
  attempt.localStream = null;
  clearAudio(audio, attempt);
  attempt.remoteStream = null;
  markClosed(attempt, confirmed);
  setStatus(callbacks, 'closed');
  safeOnClosed(attempt, callbacks, confirmed, () => nowFrom(environment));
}

function apiCall<T>(
  call: () => Promise<BridgeEnvelope<T>>,
  fallback: string,
): Promise<T> {
  let result: Promise<BridgeEnvelope<T>>;
  try {
    // Invoke the bridge immediately.  This lets cancelSession observe the
    // main-process reservation even when the user cancels in the same turn.
    result = call();
  } catch (error) {
    return Promise.reject(protocolError(error, fallback));
  }
  return Promise.resolve(result)
    .then((result) => {
      if (!result || result.ok !== true) {
        const code = result && result.ok === false ? result.code : undefined;
        throw new ProtocolError(safeCode(code, fallback) as never);
      }
      return result.value;
    })
    .catch((error) => {
      throw protocolError(error, fallback);
    });
}

function cancellable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  fallback: string,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new ProtocolError(ErrorCode.SESSION_CANCELLED));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new ProtocolError(ErrorCode.SESSION_CANCELLED));
    };
    signal.addEventListener('abort', onAbort, {once: true});
    promise.then(
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
        reject(protocolError(error, fallback));
      },
    );
  });
}

function waitForIce(
  attempt: Attempt,
  environment: DesktopLiveEnvironment,
): Promise<void> {
  const peer = attempt.peer;
  if (!peer) return Promise.reject(new ProtocolError(ErrorCode.VOICE_DATA_CHANNEL));
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  const set = environment.setTimeout ?? setTimeout;
  const clear = environment.clearTimeout ?? clearTimeout;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: Timer | null = null;
    const finish = (error?: ProtocolError) => {
      if (settled) return;
      settled = true;
      clearTimer(timer, clear);
      if (peer.onicegatheringstatechange === onIce) peer.onicegatheringstatechange = null;
      attempt.abort.signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new ProtocolError(ErrorCode.SESSION_CANCELLED));
    const onIce = () => {
      if (peer.iceGatheringState === 'complete') finish();
    };
    timer = set(() => finish(new ProtocolError(ErrorCode.VOICE_ICE_TIMEOUT)), ICE_TIMEOUT_MS);
    attempt.abort.signal.addEventListener('abort', onAbort, {once: true});
    peer.onicegatheringstatechange = onIce;
    if (peer.iceGatheringState === 'complete') finish();
  });
}

function command(
  attempt: Attempt,
  callbacks: DesktopLiveCallbacks,
  environment: DesktopLiveEnvironment,
  payload: Record<string, unknown>,
  ackType: string,
  reportErrors = true,
): Promise<void> {
  if (!attempt.started || !isOpen(attempt.channel) || attempt.closing || attempt.cleaned) {
    return Promise.reject(new ProtocolError(ErrorCode.SESSION_NOT_READY));
  }
  const eventId = typeof payload.event_id === 'string' ? payload.event_id : newEventId('event');
  payload.event_id = eventId;
  const set = environment.setTimeout ?? setTimeout;
  const clear = environment.clearTimeout ?? clearTimeout;
  return new Promise<void>((resolve, reject) => {
    const timer = set(() => {
      attempt.pendingCommands.delete(eventId);
      const error = new ProtocolError(ErrorCode.COMMAND_TIMEOUT);
      if (reportErrors) report(callbacks, error.code);
      reject(error);
    }, COMMAND_TIMEOUT_MS);
    attempt.pendingCommands.set(eventId, {eventId, ackType, timer, resolve, reject});
    try {
      attempt.channel.send(JSON.stringify(payload));
    } catch {
      clearTimer(timer, clear);
      attempt.pendingCommands.delete(eventId);
      const error = new ProtocolError(ErrorCode.VOICE_DATA_CHANNEL);
      if (reportErrors) report(callbacks, error.code);
      reject(error);
    }
  });
}

function resolvePending(
  attempt: Attempt,
  event: Record<string, unknown>,
  clear: (timer: Timer) => void,
): boolean {
  const clientId =
    typeof event.client_event_id === 'string'
      ? event.client_event_id
      : isRecord(event.error) && typeof event.error.client_event_id === 'string'
        ? event.error.client_event_id
        : null;
  if (!clientId) return false;
  const pending = attempt.pendingCommands.get(clientId);
  if (!pending) return false;
  if (event.type === 'error' || event.type === 'session.error') {
    attempt.pendingCommands.delete(clientId);
    clearTimer(pending.timer, clear);
    pending.reject(new ProtocolError(ErrorCode.COMMAND_REJECTED));
  } else if (event.type === pending.ackType) {
    attempt.pendingCommands.delete(clientId);
    clearTimer(pending.timer, clear);
    pending.resolve();
  } else {
    return false;
  }
  return true;
}

function sendWithoutWait(
  attempt: Attempt,
  callbacks: DesktopLiveCallbacks,
  environment: DesktopLiveEnvironment,
  payload: Record<string, unknown>,
  ackType: string,
): void {
  void command(attempt, callbacks, environment, payload, ackType).catch((error) => {
    if (!attempt.cancelled && !attempt.cleaned) {
      report(callbacks, protocolError(error, ErrorCode.COMMAND_REJECTED).code);
    }
  });
}

function startExpiryTimer(
  attempt: Attempt,
  callbacks: DesktopLiveCallbacks,
  environment: DesktopLiveEnvironment,
  closeAttempt: () => Promise<boolean>,
): void {
  const minutes = Number(attempt.settings.voice?.minutes);
  clearTimer(attempt.expiryTimer, environment.clearTimeout ?? clearTimeout);
  attempt.expiryTimer = null;
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  const remaining = minutes * 60_000 - Math.max(0, nowFrom(environment) - (attempt.startedAt ?? nowFrom(environment)));
  const set = environment.setTimeout ?? setTimeout;
  attempt.expiryTimer = set(() => {
    attempt.expiryTimer = null;
    void closeAttempt();
  }, Math.max(1, Math.round(remaining)));
  void callbacks;
}

function safeSources(value: unknown): Source[] {
  if (!Array.isArray(value)) return [];
  const result: Source[] = [];
  for (const item of value.slice(0, 20)) {
    if (!isRecord(item) || typeof item.title !== 'string' || typeof item.url !== 'string') continue;
    if (item.title.length > 512 || item.url.length > 2048) continue;
    result.push({title: item.title, url: item.url});
  }
  return result;
}

function delegationFailureContent(attempt: Attempt, code: string): string {
  const english = attempt.settings.locale === 'en';
  if (english) {
    if (code === 'backend_token_limit') {
      return 'I could not finish that answer within the current response limit. We can keep talking, or you can ask a shorter question.';
    }
    if (code === 'backend_incomplete') {
      return 'I could not finish checking that request. We can keep talking, or you can ask me again.';
    }
    if (code === 'backend_content_filter') {
      return 'I could not complete that request. We can continue with another question.';
    }
    if (code === 'backend_not_configured') {
      return 'The reasoning service is not configured for that request. We can continue with the voice conversation.';
    }
    return 'I could not finish that request just now. We can keep talking, or you can ask me again.';
  }
  if (code === 'backend_token_limit') {
    return '这个回答超出了当前的输出限制，暂时没能完成。我们可以继续聊，也可以把问题说得短一些。';
  }
  if (code === 'backend_incomplete') {
    return '这个问题我暂时没能处理完。我们可以继续聊，也可以稍后再问一次。';
  }
  if (code === 'backend_content_filter') {
    return '这个问题暂时没能完成。我们可以换个问题继续聊。';
  }
  if (code === 'backend_not_configured') {
    return '推理服务还没有配置好，这次问题暂时无法处理。我们可以继续进行语音对话。';
  }
  return '这个问题我暂时没能处理完。我们可以继续聊，也可以稍后再问一次。';
}

export function createDesktopLive(options: {
  api: DesktopLiveApi;
  audio: AudioElement;
  callbacks: DesktopLiveCallbacks;
  audioDevices?: AudioDeviceSelection;
  environment?: DesktopLiveEnvironment;
}): DesktopLiveController {
  const {api, audio, callbacks} = options;
  const inputDeviceId = normalizedDeviceId(options.audioDevices?.inputDeviceId);
  const outputDeviceId = normalizedDeviceId(options.audioDevices?.outputDeviceId);
  const environment = options.environment ?? {};
  const clear = environment.clearTimeout ?? clearTimeout;
  const set = environment.setTimeout ?? setTimeout;
  const navigatorValue = environment.navigator ?? (globalThis as any).navigator;
  const Peer = environment.RTCPeerConnection ?? (globalThis as any).RTCPeerConnection;
  const MediaStreamCtor = environment.MediaStream ?? (globalThis as any).MediaStream;

  let disposed = false;
  let generation = 0;
  let current: Attempt | null = null;
  let preferenceQueue: Promise<void> = Promise.resolve();

  const currentAttempt = (attempt: Attempt) =>
    current === attempt && !attempt.cleaned && !attempt.cancelled;

  const prepareOutput = async (attempt: Attempt): Promise<void> => {
    const setSinkId = audio.setSinkId;
    if (typeof setSinkId !== 'function') {
      if (outputDeviceId) throw new ProtocolError('audio_output_unsupported' as never);
      return;
    }
    let sinkRequest: Promise<void>;
    try {
      sinkRequest = Promise.resolve(setSinkId.call(audio, outputDeviceId));
    } catch {
      throw new ProtocolError('audio_output_unavailable' as never);
    }
    try {
      await cancellable(sinkRequest, attempt.abort.signal, 'audio_output_unavailable');
    } catch (error) {
      if (attempt.cancelled || attempt.cleaned) throw new ProtocolError(ErrorCode.SESSION_CANCELLED);
      throw protocolError(error, 'audio_output_unavailable');
    }
  };

  const attachInputTrackListeners = (attempt: Attempt, tracks: any[]): void => {
    for (const track of tracks) {
      if (!track) continue;
      const onEnded = () => {
        if (!currentAttempt(attempt) || attempt.closing) return;
        report(callbacks, 'audio_input_unavailable');
        void closeAttempt(attempt);
      };
      try {
        if (typeof track.addEventListener === 'function' && typeof track.removeEventListener === 'function') {
          track.addEventListener('ended', onEnded);
          attempt.inputTrackCleanups.push(() => track.removeEventListener('ended', onEnded));
          continue;
        }
        const previous = track.onended;
        track.onended = onEnded;
        attempt.inputTrackCleanups.push(() => {
          if (track.onended === onEnded) track.onended = previous ?? null;
        });
      } catch {
        // A track without listener support is still usable; OS-level stop
        // events are also reflected through the peer connection state.
      }
    }
  };

  const cancelSession = (attempt: Attempt, force = false): void => {
    if (attempt.sessionCancelSent && !force) return;
    if (!force) attempt.sessionCancelSent = true;
    attempt.sessionCancelSent = true;
    void Promise.resolve()
      .then(() => api.cancelSession({attemptId: attempt.attemptId}))
      .catch(() => undefined);
  };

  const cancelBackend = (attempt: Attempt): void => {
    void Promise.resolve()
      .then(() => api.cancelBackend({attemptId: attempt.attemptId}))
      .catch(() => undefined);
  };

  const cleanup = (attempt: Attempt, confirmed: boolean) => {
    // The renderer owns the WebRTC close handshake, while the main process
    // still needs this scoped cancellation to release its credential/settings
    // snapshot after the handshake (or after an abandoned start).
    cancelBackend(attempt);
    cancelSession(attempt);
    cleanupAttempt(attempt, callbacks, audio, environment, confirmed);
  };

  const closeAttempt = async (attempt: Attempt): Promise<boolean> => {
    if (attempt.cleaned) return attempt.confirmedClose;
    // UI, window exit and transport callbacks share the first close deadline.
    // A second caller must not race a new timer or tear down the event channel.
    if (attempt.closeSent) return attempt.closePromise;
    if (!attempt.closing) {
      attempt.closing = true;
      setStatus(callbacks, 'closing');
      attempt.taskRevision += 1;
      attempt.backendAbort.abort();
      cancelBackend(attempt);
    }
    if (attempt.started && (isOpen(attempt.channel) || typeof api.finalizeSession === 'function')) {
      const primaryOpen = isOpen(attempt.channel);
      if (!attempt.closeSent) {
        attempt.closeSent = true;
        try {
          if (primaryOpen) attempt.channel.send(JSON.stringify({type: 'session.close', event_id: newEventId('close')}));
        } catch {
          report(callbacks, ErrorCode.VOICE_DATA_CHANNEL);
        }
      }
      let timeoutTimer: Timer | null = null;
      const fallbackTimer = typeof api.finalizeSession === 'function' ? set(() => {
        if (!currentAttempt(attempt) || attempt.cleaned) return;
        void apiCall(() => api.finalizeSession!({attemptId: attempt.attemptId}), ErrorCode.VOICE_CLOSE_TIMEOUT)
          .then(result => {
            if (result?.confirmed === true && currentAttempt(attempt) && attempt.closing) cleanup(attempt, true);
          }).catch(() => undefined);
      }, primaryOpen ? 8_000 : 0) : null;
      const timeout = new Promise<boolean>((resolve) => {
        timeoutTimer = set(() => resolve(false), CLOSE_TIMEOUT_MS);
      });
      const confirmed = await Promise.race([attempt.closePromise, timeout]);
      clearTimer(timeoutTimer, clear);
      clearTimer(fallbackTimer, clear);
      if (confirmed) return true;
      attempt.finalizationUnknown = true;
      report(callbacks, ErrorCode.VOICE_CLOSE_TIMEOUT);
      cleanup(attempt, false);
      return false;
    }
    attempt.cancelled = true;
    cancelSession(attempt);
    cleanup(attempt, false);
    return false;
  };

  const sendDelegationFailure = async (
    attempt: Attempt,
    delegationId: string,
    revision: number,
    code: string,
    signal: AbortSignal,
  ): Promise<void> => {
    if (
      !currentAttempt(attempt) ||
      attempt.closing ||
      signal.aborted ||
      revision !== attempt.taskRevision ||
      attempt.activeDelegation?.id !== delegationId ||
      attempt.activeDelegation?.revision !== revision ||
      attempt.failureNotices.has(delegationId)
    ) {
      return;
    }
    if (attempt.failureNotices.size >= 256) {
      const oldest = attempt.failureNotices.values().next().value;
      if (typeof oldest === 'string') attempt.failureNotices.delete(oldest);
    }
    // Mark before sending. A failed ACK must never re-enter this path.
    attempt.failureNotices.add(delegationId);
    try {
      await cancellable(
        command(
          attempt,
          callbacks,
          environment,
          {
            type: 'session.commentary.append',
            event_id: newEventId('delegation-failure'),
            delegation_id: delegationId,
            content: delegationFailureContent(attempt, code),
          },
          'session.commentary.appended',
          false,
        ),
        signal,
        ErrorCode.SESSION_CANCELLED,
      );
    } catch {
      // The original fixed backend error remains the UI signal. A failed
      // failure-notice ACK must not create a second notice or a retry loop.
    }
  };

  const delayWithAbort = (milliseconds: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimer(timer, clear);
        signal.removeEventListener('abort', onAbort);
        reject(new ProtocolError(ErrorCode.SESSION_CANCELLED));
      };
      const timer = set(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, {once: true});
    });

  const waitForDelegationQuiet = async (
    attempt: Attempt,
    delegationId: string,
    revision: number,
    signal: AbortSignal,
  ): Promise<void> => {
    const active = attempt.activeDelegation;
    if (!active || active.id !== delegationId || active.revision !== revision) {
      throw new ProtocolError(ErrorCode.SESSION_CANCELLED);
    }
    const quietMs = active.offsetMs === null ? DELEGATION_SETTLE_MS : CONTINUOUS_UTTERANCE_QUIET_MS;
    while (true) {
      const version = active.transcriptVersion;
      await delayWithAbort(quietMs, signal);
      if (!currentAttempt(attempt) || signal.aborted || attempt.taskRevision !== revision) {
        throw new ProtocolError(ErrorCode.SESSION_CANCELLED);
      }
      if (active.transcriptVersion === version) return;
    }
  };

  const runDelegation = (attempt: Attempt, delegationId: string): void => {
    const active = attempt.activeDelegation;
    if (!active || active.id !== delegationId || active.runner) return;
    active.runner = true;
    setBackendStatus(callbacks, 'working');
    const revision = active.revision;
    const backendSignal = attempt.backendAbort.signal;
    void (async () => {
      try {
        await waitForDelegationQuiet(attempt, delegationId, revision, backendSignal);
        if (!currentAttempt(attempt) || revision !== attempt.taskRevision || backendSignal.aborted) return;
        active.dispatched = true;
        const value = await cancellable(
          apiCall(
            () => api.runBackend({
              attemptId: attempt.attemptId,
              delegationId,
              history: attempt.history.map((fragment) => ({...fragment})),
            }),
            ErrorCode.BACKEND_NETWORK,
          ),
          backendSignal,
          ErrorCode.BACKEND_NETWORK,
        );
        if (!isRecord(value) || typeof value.text !== 'string' || !value.text.trim()) {
          throw new ProtocolError(ErrorCode.BACKEND_EMPTY_OUTPUT);
        }
        if (!currentAttempt(attempt) || revision !== attempt.taskRevision || backendSignal.aborted) return;
        const sources = safeSources(value.sources);
        try {
          callbacks.onSources(sources);
        } catch {
          // UI callback must not affect the active voice session.
        }
        await command(
          attempt,
          callbacks,
          environment,
          {
            type: 'session.commentary.append',
            event_id: newEventId('commentary'),
            delegation_id: delegationId,
            content: value.text.slice(0, 16_000),
          },
          'session.commentary.appended',
        );
        if (currentAttempt(attempt) && revision === attempt.taskRevision) {
          setBackendStatus(callbacks, 'done');
        }
      } catch (error) {
        if (!currentAttempt(attempt) || revision !== attempt.taskRevision || backendSignal.aborted) return;
        setBackendStatus(callbacks, 'error');
        const failureCode = protocolError(error, ErrorCode.BACKEND_NETWORK).code;
        report(callbacks, failureCode);
        if (
          failureCode === ErrorCode.BACKEND_ABORTED ||
          failureCode === ErrorCode.SESSION_CANCELLED ||
          (failureCode as string) === 'cancelled'
        ) {
          return;
        }
        await sendDelegationFailure(attempt, delegationId, revision, failureCode, backendSignal);
      } finally {
        if (attempt.activeDelegation?.revision === revision) {
          attempt.activeDelegation.runner = false;
          attempt.activeDelegation = null;
        }
      }
    })();
  };

  const handleDelegation = (attempt: Attempt, delegationId: string, offsetMs: number | null): void => {
    if (!currentAttempt(attempt) || attempt.closing || attempt.seenDelegations.has(delegationId)) return;
    attempt.seenDelegations.add(delegationId);
    attempt.taskRevision += 1;
    const revision = attempt.taskRevision;
    attempt.backendAbort.abort();
    attempt.backendAbort = new AbortController();
    const backendSignal = attempt.backendAbort.signal;
    cancelBackend(attempt);
    const previousUser = [...attempt.history].reverse().find(fragment => fragment.role === 'user');
    attempt.activeDelegation = {
      id: delegationId,
      revision,
      offsetMs,
      lastUserEndMs: previousUser?.endMs ?? null,
      transcriptVersion: 0,
      replacementUsed: false,
      dispatched: false,
      runner: false,
    };
    if (attempt.settings.backend?.enabled === false) {
      setBackendStatus(callbacks, 'error');
      report(callbacks, ErrorCode.BACKEND_NOT_CONFIGURED);
      void sendDelegationFailure(
        attempt,
        delegationId,
        revision,
        ErrorCode.BACKEND_NOT_CONFIGURED,
        backendSignal,
      ).finally(() => {
        if (attempt.activeDelegation?.revision === revision) attempt.activeDelegation = null;
      });
      return;
    }
    runDelegation(attempt, delegationId);
  };

  const onServerEvent = (attempt: Attempt, raw: unknown): void => {
    if (!currentAttempt(attempt)) return;
    const text = stringData(raw);
    if (!text) {
      report(callbacks, ErrorCode.VOICE_DATA_CHANNEL);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      report(callbacks, ErrorCode.VOICE_DATA_CHANNEL);
      return;
    }
    if (!isRecord(value) || typeof value.type !== 'string') return;
    if (resolvePending(attempt, value, clear)) return;
    if (value.type === 'session.started') {
      const session = isRecord(value.session) ? value.session : null;
      if (attempt.sessionId && session?.id !== attempt.sessionId) {
        report(callbacks, ErrorCode.VOICE_INVALID_RESPONSE);
        const rejectStart = attempt.startReject;
        attempt.startReject = null;
        rejectStart?.(new ProtocolError(ErrorCode.VOICE_INVALID_RESPONSE));
        void closeAttempt(attempt);
        return;
      }
      attempt.started = true;
      attempt.startedAt = nowFrom(environment);
      clearTimer(attempt.sessionStartTimer, clear);
      attempt.sessionStartTimer = null;
      startExpiryTimer(attempt, callbacks, environment, () => closeAttempt(attempt));
      setStatus(callbacks, 'connected');
      attempt.startResolve?.();
      attempt.startResolve = null;
      attempt.startReject = null;
      if (attempt.desiredMuted) {
        sendWithoutWait(
          attempt,
          callbacks,
          environment,
          {type: 'session.input_audio.mute', event_id: newEventId('mute')},
          'session.input_audio.muted',
        );
      }
      return;
    }
    if (value.type === 'session.closed') {
      attempt.closing = true;
      cleanup(attempt, true);
      return;
    }
    if (value.type === 'session.input_transcript.delta' || value.type === 'session.output_transcript.delta') {
      const fragment = normalizeTranscript(value);
      if (!fragment) return;
      appendHistory(attempt, fragment);
      try {
        callbacks.onTranscript(fragment);
      } catch {
        // UI callback must not affect protocol handling.
      }
      if (fragment.role === 'user') {
        const activeDelegation = attempt.activeDelegation;
        const isContinuousDelegationContext = Boolean(
          activeDelegation &&
          activeDelegation.offsetMs !== null &&
          Number.isFinite(fragment.startMs) &&
          (
            fragment.startMs <= activeDelegation.offsetMs ||
            (
              activeDelegation.lastUserEndMs !== null &&
              fragment.startMs <= activeDelegation.lastUserEndMs + CONTINUOUS_UTTERANCE_GAP_MS
            )
          ),
        );
        if (isContinuousDelegationContext && activeDelegation) {
          activeDelegation.lastUserEndMs = Math.max(
            activeDelegation.lastUserEndMs ?? fragment.endMs,
            fragment.endMs,
          );
          activeDelegation.transcriptVersion += 1;
          if (activeDelegation.dispatched && activeDelegation.replacementUsed) {
            attempt.taskRevision += 1;
            attempt.activeDelegation = null;
            attempt.backendAbort.abort();
            attempt.backendAbort = new AbortController();
            cancelBackend(attempt);
            setBackendStatus(callbacks, 'error');
            report(callbacks, ErrorCode.BACKEND_ABORTED);
            return;
          }
          if (activeDelegation.dispatched && !activeDelegation.replacementUsed) {
            activeDelegation.replacementUsed = true;
            activeDelegation.dispatched = false;
            attempt.taskRevision += 1;
            activeDelegation.revision = attempt.taskRevision;
            activeDelegation.runner = false;
            attempt.backendAbort.abort();
            attempt.backendAbort = new AbortController();
            cancelBackend(attempt);
            setBackendStatus(callbacks, 'idle');
            runDelegation(attempt, activeDelegation.id);
          }
          return;
        }
        attempt.taskRevision += 1;
        if (attempt.activeDelegation) {
          attempt.activeDelegation = null;
          attempt.backendAbort.abort();
          attempt.backendAbort = new AbortController();
          cancelBackend(attempt);
          setBackendStatus(callbacks, 'idle');
        }
      }
      return;
    }
    if (value.type === 'session.delegation.created') {
      const delegation = isRecord(value.delegation) ? value.delegation : null;
      if (delegation?.target === 'client' && typeof delegation.id === 'string' && delegation.id.length <= 256) {
        const offsetMs = typeof value.offset_ms === 'number' && Number.isFinite(value.offset_ms) && value.offset_ms >= 0
          ? value.offset_ms
          : null;
        handleDelegation(attempt, delegation.id, offsetMs);
      }
      return;
    }
    if (value.type === 'error' || value.type === 'session.error') {
      report(callbacks, ErrorCode.COMMAND_REJECTED);
      if (!attempt.closing) void closeAttempt(attempt);
    }
  };

  const establish = async (attempt: Attempt): Promise<void> => {
    await prepareOutput(attempt);
    const mediaDevices = navigatorValue?.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      throw new ProtocolError('audio_input_unavailable' as never);
    }
    if (typeof Peer !== 'function') throw new ProtocolError(ErrorCode.VOICE_NETWORK);
    let stream: any;
    try {
      stream = await mediaDevices.getUserMedia({
        audio: audioInputConstraints(inputDeviceId),
        video: false,
      });
    } catch (error) {
      throw new ProtocolError(inputErrorCode(error) as never);
    }
    if (attempt.cancelled || attempt.cleaned) {
      stopStream(stream);
      throw new ProtocolError(ErrorCode.SESSION_CANCELLED);
    }
    attempt.localStream = stream;
    const inputTracks = stream.getAudioTracks?.() ?? [];
    if (!Array.isArray(inputTracks) || inputTracks.length === 0) {
      throw new ProtocolError('audio_input_unavailable' as never);
    }
    attachInputTrackListeners(attempt, inputTracks);
    if (attempt.cancelled || attempt.cleaned) {
      stopStream(stream);
      throw new ProtocolError(ErrorCode.SESSION_CANCELLED);
    }
    setLocalMuted(stream, attempt.desiredMuted);
    const peer = new Peer();
    attempt.peer = peer;
    peer.ontrack = (event: any) => {
      if (!currentAttempt(attempt)) return;
      const streams = Array.isArray(event?.streams) ? event.streams : [];
      attempt.remoteStream = streams[0] ?? (event?.track && typeof MediaStreamCtor === 'function' ? new MediaStreamCtor([event.track]) : null);
      if (!attempt.remoteStream) return;
      try {
        audio.srcObject = attempt.remoteStream;
        const playback = audio.play?.();
        if (playback && typeof playback.catch === 'function') {
          playback.catch(() => {
            if (currentAttempt(attempt)) report(callbacks, PLAYBACK_ERROR);
          });
        }
      } catch {
        if (currentAttempt(attempt)) report(callbacks, PLAYBACK_ERROR);
      }
    };
    peer.onconnectionstatechange = () => {
      if (!currentAttempt(attempt)) return;
      if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
        report(callbacks, ErrorCode.VOICE_NETWORK);
        void closeAttempt(attempt);
      }
    };
    peer.oniceconnectionstatechange = () => {
      if (!currentAttempt(attempt)) return;
      if (peer.iceConnectionState === 'failed' || peer.iceConnectionState === 'disconnected') {
        report(callbacks, ErrorCode.VOICE_NETWORK);
        void closeAttempt(attempt);
      }
    };
    try {
      for (const track of inputTracks) peer.addTrack(track, stream);
      const channel = peer.createDataChannel('oai-events');
      attempt.channel = channel;
      channel.onmessage = (event: unknown) => onServerEvent(attempt, event);
      channel.onerror = () => {
        if (currentAttempt(attempt) && !attempt.closing) {
          report(callbacks, ErrorCode.VOICE_DATA_CHANNEL);
          void closeAttempt(attempt);
        }
      };
      channel.onclose = () => {
        if (!currentAttempt(attempt)) return;
        if (!attempt.confirmedClose) void closeAttempt(attempt);
      };
      const offer = await peer.createOffer();
      if (attempt.cancelled) throw new ProtocolError(ErrorCode.SESSION_CANCELLED);
      await peer.setLocalDescription(offer);
      await waitForIce(attempt, environment);
      const localSdp = peer.localDescription?.sdp;
      if (typeof localSdp !== 'string' || localSdp.length === 0 || localSdp.length > 64 * 1024) {
        throw new ProtocolError(ErrorCode.VOICE_INVALID_RESPONSE);
      }
      attempt.sessionCreationAttempted = true;
      attempt.sessionCreatePending = true;
      const creationRequest = apiCall(
        () => api.createSession({attemptId: attempt.attemptId, sdp: localSdp, mode: attempt.mode}),
        ErrorCode.VOICE_NETWORK,
      );
      // A bridge request can finish after the renderer has already released
      // the attempt.  Re-send the scoped cancellation at that boundary so a
      // main-process reservation created during a slow store read cannot leak.
      void creationRequest
        .finally(() => {
          if (attempt.cancelled || attempt.cleaned) cancelSession(attempt, true);
        })
        .catch(() => undefined);
      const response = await cancellable(
        creationRequest,
        attempt.abort.signal,
        ErrorCode.VOICE_NETWORK,
      ).finally(() => {
        attempt.sessionCreatePending = false;
      });
      if (attempt.cancelled || attempt.cleaned) {
        cancelSession(attempt, true);
        throw new ProtocolError(ErrorCode.SESSION_CANCELLED);
      }
      if (
        !isRecord(response) ||
        typeof response.sessionId !== 'string' ||
        response.sessionId.length === 0 ||
        response.sessionId.length > 256 ||
        typeof response.sdp !== 'string' ||
        response.sdp.length === 0 ||
        response.sdp.length > 64 * 1024
      ) {
        throw new ProtocolError(ErrorCode.VOICE_INVALID_RESPONSE);
      }
      attempt.sessionId = response.sessionId;
      attempt.settings = isRecord(response.settings) ? (response.settings as DesktopSessionSettings) : {};
      await peer.setRemoteDescription({type: 'answer', sdp: response.sdp});
      setStatus(callbacks, 'connecting');
      attempt.sessionStartTimer = set(() => {
        if (currentAttempt(attempt) && !attempt.started) {
          attempt.cancelled = true;
          report(callbacks, ErrorCode.VOICE_NOT_STARTED);
          const rejectStart = attempt.startReject;
          attempt.startReject = null;
          rejectStart?.(new ProtocolError(ErrorCode.VOICE_NOT_STARTED));
        }
      }, START_TIMEOUT_MS);
      await new Promise<void>((resolve, reject) => {
        if (attempt.started) {
          resolve();
          return;
        }
        attempt.startResolve = resolve;
        attempt.startReject = reject;
        if (attempt.cancelled) reject(new ProtocolError(ErrorCode.SESSION_CANCELLED));
      });
    } catch (error) {
      if (attempt.cancelled || attempt.cleaned) throw new ProtocolError(ErrorCode.SESSION_CANCELLED);
      throw protocolError(error, ErrorCode.VOICE_NETWORK);
    }
  };

  const start = async (mode: Mode): Promise<void> => {
    if (disposed) throw new ProtocolError(ErrorCode.SESSION_DISPOSED);
    if (mode !== 'general' && mode !== 'practice') throw new ProtocolError(ErrorCode.CONFIG_INVALID);
    if (current && !current.cleaned) throw new ProtocolError(ErrorCode.SESSION_ALREADY_ACTIVE);
    // The mode argument remains for IPC compatibility with older renderers,
    // but the desktop UI now exposes one conversation experience.
    const attempt = makeAttempt(newEventId('attempt'), 'general', ++generation);
    current = attempt;
    setStatus(callbacks, 'connecting');
    try {
      await establish(attempt);
    } catch (error) {
      if (!attempt.cleaned) {
        const code = attempt.cancelled
          ? ErrorCode.SESSION_CANCELLED
          : protocolError(error, ErrorCode.VOICE_NETWORK).code;
        if (!attempt.cancelled && !disposed) report(callbacks, code);
        if (attempt.sessionCreatePending || attempt.sessionCreationAttempted) cancelSession(attempt);
        cleanup(attempt, false);
      }
      if (attempt.cancelled || disposed) return;
      throw protocolError(error, ErrorCode.VOICE_NETWORK);
    }
  };

  const close = async (): Promise<boolean> => {
    if (!current) return true;
    return closeAttempt(current);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    const attempt = current;
    if (!attempt || attempt.cleaned) return;
    attempt.cancelled = true;
    attempt.closing = true;
    cancelBackend(attempt);
    cancelSession(attempt);
    cleanup(attempt, false);
  };

  const setMuted = (muted: boolean): void => {
    const attempt = current;
    if (!attempt || attempt.cleaned) return;
    attempt.desiredMuted = muted;
    setLocalMuted(attempt.localStream, muted);
    if (!attempt.started || !isOpen(attempt.channel) || attempt.closing) return;
    sendWithoutWait(
      attempt,
      callbacks,
      environment,
      {type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute', event_id: newEventId(muted ? 'mute' : 'unmute')},
      muted ? 'session.input_audio.muted' : 'session.input_audio.unmuted',
    );
  };

  const appendStyle = async (preferences: VoicePreferences): Promise<void> => {
    const attempt = current;
    if (!attempt || attempt.cleaned) throw new ProtocolError(ErrorCode.SESSION_NOT_READY);
    const locale = attempt.settings.locale === 'en' ? 'en' : 'zh';
    let content: string;
    try {
      content = buildVoiceInstructions(attempt.mode, locale, preferences);
    } catch (error) {
      throw protocolError(error, ErrorCode.CONFIG_INVALID);
    }
    await command(
      attempt,
      callbacks,
      environment,
      {type: 'session.instructions.append', event_id: newEventId('style'), delegation_id: null, content},
      'session.instructions.appended',
    );
  };

  const updatePreferences = (update: {voice?: VoicePreferences; backend?: {enabled: boolean}}): Promise<void> => {
    const attempt = current;
    const voice = update.voice ? {...update.voice} : null;
    const backend = update.backend ? {...update.backend} : null;
    const operation = preferenceQueue.then(async () => {
      if (!attempt || !currentAttempt(attempt) || !attempt.started || attempt.closing) throw new ProtocolError(ErrorCode.SESSION_NOT_READY);
      if (voice) {
        validateVoicePreferences(voice);
        const elapsed = Math.max(0, nowFrom(environment) - (attempt.startedAt ?? nowFrom(environment)));
        if (voice.minutes > 0 && voice.minutes * 60_000 <= elapsed) throw new ProtocolError(ErrorCode.SESSION_LIMIT_ELAPSED);
        const previous = attempt.settings.voice;
        const changed = !previous || ['tone','intonation','pace','instructions'].some(key => previous[key as keyof VoicePreferences] !== voice[key as keyof VoicePreferences]);
        if (changed) await command(attempt, callbacks, environment,
          {type: 'session.instructions.append', event_id: newEventId('style'), delegation_id: null,
            content: buildVoiceUpdateInstructions(attempt.mode, attempt.settings.locale === 'en' ? 'en' : 'zh', voice)},
          'session.instructions.appended');
        if (!currentAttempt(attempt) || attempt.closing) throw new ProtocolError(ErrorCode.SESSION_NOT_READY);
        // Reject a limit that elapsed while the style acknowledgment was pending.
        if (voice.minutes > 0 && voice.minutes * 60_000 <= nowFrom(environment) - (attempt.startedAt ?? nowFrom(environment))) throw new ProtocolError(ErrorCode.SESSION_LIMIT_ELAPSED);
        attempt.settings = {...attempt.settings, voice: {...voice, voice: previous?.voice ?? voice.voice}};
        startExpiryTimer(attempt, callbacks, environment, close);
      }
      if (backend) attempt.settings = {...attempt.settings, backend};
    });
    preferenceQueue = operation.catch(() => undefined);
    return operation;
  };

  return {start, close, dispose, setMuted, appendStyle, updatePreferences};
}
