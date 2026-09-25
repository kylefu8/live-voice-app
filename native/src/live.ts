import {
  MediaStream,
  RTCPeerConnection,
  RTCSessionDescription,
  mediaDevices,
} from 'react-native-webrtc';
import type {
  Credential,
  BackendPreferences,
  LiveCallbacks,
  LiveController,
  LivePreferencesUpdate,
  Locale,
  Mode,
  SessionConfig,
  SessionStatus,
  TranscriptFragment,
  VoicePreferences,
} from './types';
import {runBackendDelegation} from './backend';
import {startIosSessionDiagnostics} from './ios-session-diagnostics';
import {
  ErrorCode,
  ProtocolError,
  abortError,
  authHeaders,
  buildVoiceInstructions,
  buildVoiceUpdateInstructions,
  delayWithAbort,
  httpErrorCode,
  liveHttpUrl,
  liveWebSocketUrl,
  newEventId,
  validateBackendPreferences,
  validateCredential,
  validateVoicePreferences,
  withTimeoutSignal,
} from './protocol';

const START_TIMEOUT_MS = 30_000;
const ICE_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 8_000;
const CLOSE_TIMEOUT_MS = 15_000;
const DELEGATION_SETTLE_MS = 250;

type JsonRecord = Record<string, unknown>;

interface PendingCommand {
  eventId: string;
  ackType: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: ProtocolError) => void;
}

interface Attempt {
  diagnostics: ReturnType<typeof startIosSessionDiagnostics>;
  generation: number;
  config: SessionConfig;
  locale: Locale;
  mode: Mode;
  abort: AbortController;
  backendAbort: AbortController;
  peer: RTCPeerConnection | null;
  channel: any;
  localStream: any;
  remoteStream: MediaStream | null;
  sessionId: string | null;
  started: boolean;
  closing: boolean;
  cancelled: boolean;
  cleaned: boolean;
  confirmedClose: boolean;
  closeSent: boolean;
  closedResolve: ((confirmed: boolean) => void) | null;
  closedPromise: Promise<boolean>;
  closedSettled: boolean;
  closedCallback: boolean;
  pendingCommands: Map<string, PendingCommand>;
  seenDelegations: Set<string>;
  history: TranscriptFragment[];
  taskRevision: number;
  activeDelegation: {id: string; revision: number} | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  iceTimer: ReturnType<typeof setTimeout> | null;
  sessionStartTimer: ReturnType<typeof setTimeout> | null;
  sessionStartedAt: number | null;
  desiredMuted: boolean;
  finalizationUnknown: boolean;
  sessionCreatePending: boolean;
  sessionCreationAttempted: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getLocale(config: SessionConfig): Locale {
  const value = (config as SessionConfig & {locale?: Locale}).locale;
  return value === 'en' ? 'en' : 'zh';
}

function getMode(_config: SessionConfig): Mode {
  return 'general';
}

function report(callbacks: LiveCallbacks, code: string): void {
  try {
    callbacks.onError(code);
  } catch {
    // UI callbacks must not break transport cleanup.
  }
}

function status(callbacks: LiveCallbacks, value: SessionStatus): void {
  try {
    callbacks.onStatus(value);
  } catch {
    // UI callbacks must not break transport cleanup.
  }
}

function backendStatus(callbacks: LiveCallbacks, value: 'idle' | 'working' | 'done' | 'error'): void {
  try {
    callbacks.onBackendStatus(value);
  } catch {
    // UI callbacks must not break transport cleanup.
  }
}

function protocolCode(error: unknown, fallback: string): string {
  return error instanceof ProtocolError ? error.code : fallback;
}

function validateSessionConfig(config: SessionConfig): void {
  if (!config || !config.voice || !config.voiceCredential) {
    throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  }
  validateCredential(config.voiceCredential);
  validateVoicePreferences(config.voice);
  if (config.backend.enabled) {
    validateBackendPreferences(config.backend);
    if (!config.backendCredential) throw new ProtocolError(ErrorCode.BACKEND_NOT_CONFIGURED);
    validateCredential(config.backendCredential);
  }
}

function cloneCredential(credential: Credential | null): Credential | null {
  return credential ? {...credential} : null;
}

function cloneVoicePreferences(preferences: VoicePreferences): VoicePreferences {
  return {...preferences};
}

function cloneBackendPreferences(preferences: BackendPreferences): BackendPreferences {
  return {...preferences};
}

function isCurrentAttempt(
  current: Attempt | null,
  attempt: Attempt,
): boolean {
  return current === attempt && !attempt.cleaned && !attempt.cancelled;
}

function stopStream(stream: any): void {
  if (!stream) return;
  try {
    const tracks = typeof stream.getTracks === 'function' ? stream.getTracks() : [];
    for (const track of tracks) {
      try {
        track.stop?.();
      } catch {
        // Continue releasing remaining tracks.
      }
    }
    stream.release?.(false);
  } catch {
    // Resource release is best effort and must remain synchronous.
  }
}

function setLocalMuted(stream: any, muted: boolean): void {
  if (!stream || typeof stream.getAudioTracks !== 'function') return;
  for (const track of stream.getAudioTracks()) {
    try {
      track.enabled = !muted;
    } catch {
      // Continue applying mute to remaining tracks.
    }
  }
}

function messageData(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return null;
}

function sessionIdFromResponse(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.session) || typeof value.session.id !== 'string') return null;
  return value.session.id;
}

function resolveSessionResponse(value: unknown): {id: string; sdp: string} {
  if (!isRecord(value) || !isRecord(value.session) || !isRecord(value.transport)) {
    throw new ProtocolError(ErrorCode.VOICE_INVALID_RESPONSE);
  }
  const id = value.session.id;
  const sdp = value.transport.sdp;
  const transportType = value.transport.type;
  if (typeof id !== 'string' || !id || typeof sdp !== 'string' || !sdp || transportType !== 'webrtc') {
    throw new ProtocolError(ErrorCode.VOICE_INVALID_RESPONSE);
  }
  return {id, sdp};
}

function appendHistory(attempt: Attempt, fragment: TranscriptFragment): void {
  if (!fragment.text) return;
  const last = attempt.history[attempt.history.length - 1];
  if (
    last &&
    last.role === fragment.role &&
    fragment.startMs - last.endMs < 2500
  ) {
    last.text += fragment.text;
    last.endMs = Math.max(last.endMs, fragment.endMs);
  } else {
    attempt.history.push({...fragment});
  }
  if (attempt.history.length > 160) attempt.history.splice(0, attempt.history.length - 160);
}

function transcriptFragment(event: JsonRecord): TranscriptFragment | null {
  if (typeof event.delta !== 'string' || !event.delta) return null;
  if (!Number.isFinite(Number(event.start_ms)) || !Number.isFinite(Number(event.end_ms))) return null;
  return {
    role: event.type === 'session.output_transcript.delta' ? 'assistant' : 'user',
    text: event.delta,
    startMs: Number(event.start_ms),
    endMs: Number(event.end_ms),
  };
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer) clearTimeout(timer);
}

function isOpen(channel: any): boolean {
  return Boolean(channel && channel.readyState === 'open');
}

async function waitForIce(attempt: Attempt): Promise<void> {
  const peer = attempt.peer;
  if (!peer) throw new ProtocolError(ErrorCode.VOICE_DATA_CHANNEL);
  if (peer.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: ProtocolError) => {
      if (settled) return;
      settled = true;
      clearTimer(attempt.iceTimer);
      attempt.iceTimer = null;
      peer.onicegatheringstatechange = null;
      attempt.abort.signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(abortError(attempt.abort.signal, ErrorCode.VOICE_ICE_TIMEOUT));
    attempt.iceTimer = setTimeout(() => finish(new ProtocolError(ErrorCode.VOICE_ICE_TIMEOUT)), ICE_TIMEOUT_MS);
    attempt.abort.signal.addEventListener('abort', onAbort, {once: true});
    peer.onicegatheringstatechange = () => {
      if (peer.iceGatheringState === 'complete') finish();
    };
    if (peer.iceGatheringState === 'complete') finish();
  });
}

function makeAttempt(config: SessionConfig, generation: number): Attempt {
  const locale = getLocale(config);
  const mode = getMode(config);
  const abort = new AbortController();
  const backendAbort = new AbortController();
  let closedResolve: ((confirmed: boolean) => void) | null = null;
  const closedPromise = new Promise<boolean>((resolve) => {
    closedResolve = resolve;
  });
  const attempt: Attempt = {
    diagnostics: startIosSessionDiagnostics(),
    generation,
    config: {
      ...config,
      voiceCredential: {...config.voiceCredential},
      backendCredential: cloneCredential(config.backendCredential),
      voice: cloneVoicePreferences(config.voice),
      backend: cloneBackendPreferences(config.backend),
    },
    locale,
    mode,
    abort,
    backendAbort,
    peer: null,
    channel: null,
    localStream: null,
    remoteStream: null,
    sessionId: null,
    started: false,
    closing: false,
    cancelled: false,
    cleaned: false,
    confirmedClose: false,
    closeSent: false,
    closedResolve,
    closedPromise,
    closedSettled: false,
    closedCallback: false,
    pendingCommands: new Map(),
    seenDelegations: new Set(),
    history: [],
    taskRevision: 0,
    activeDelegation: null,
    expiryTimer: null,
    iceTimer: null,
    sessionStartTimer: null,
    sessionStartedAt: null,
    desiredMuted: false,
    finalizationUnknown: false,
    sessionCreatePending: false,
    sessionCreationAttempted: false,
  };
  return attempt;
}

function startSessionDurationTimer(attempt: Attempt, callbacks: LiveCallbacks): void {
  if (attempt.cleaned || attempt.cancelled) return;
  if (attempt.sessionStartedAt === null) attempt.sessionStartedAt = Date.now();
  clearTimer(attempt.expiryTimer);
  attempt.expiryTimer = null;
  const minutes = Number(attempt.config.voice.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  const elapsedMs = Math.max(0, Date.now() - attempt.sessionStartedAt);
  const remainingMs = Math.max(0, Math.round(minutes * 60_000 - elapsedMs));
  attempt.expiryTimer = setTimeout(() => {
    attempt.expiryTimer = null;
    void closeAttempt(attempt, callbacks);
  }, remainingMs);
}

function resolvePending(attempt: Attempt, event: JsonRecord): boolean {
  const clientId =
    typeof event.client_event_id === 'string'
      ? event.client_event_id
      : isRecord(event.error) && typeof event.error.client_event_id === 'string'
        ? event.error.client_event_id
        : null;
  if (!clientId) return false;
  const pending = attempt.pendingCommands.get(clientId);
  if (!pending) return false;
  if (event.type === 'error') {
    attempt.pendingCommands.delete(clientId);
    clearTimeout(pending.timer);
    pending.reject(new ProtocolError(ErrorCode.COMMAND_REJECTED));
  } else if (event.type === pending.ackType) {
    attempt.pendingCommands.delete(clientId);
    clearTimeout(pending.timer);
    pending.resolve();
  } else {
    return false;
  }
  return true;
}

function rejectPending(attempt: Attempt, error: ProtocolError): void {
  for (const pending of attempt.pendingCommands.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  attempt.pendingCommands.clear();
}

function command(
  attempt: Attempt,
  callbacks: LiveCallbacks,
  payload: JsonRecord,
  ackType: string,
): Promise<void> {
  if (!attempt.started || !isOpen(attempt.channel) || attempt.closing || attempt.cleaned) {
    return Promise.reject(new ProtocolError(ErrorCode.SESSION_NOT_READY));
  }
  const eventId = typeof payload.event_id === 'string' ? payload.event_id : newEventId('event');
  payload.event_id = eventId;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      attempt.pendingCommands.delete(eventId);
      const error = new ProtocolError(ErrorCode.COMMAND_TIMEOUT);
      report(callbacks, error.code);
      reject(error);
    }, COMMAND_TIMEOUT_MS);
    attempt.pendingCommands.set(eventId, {eventId, ackType, timer, resolve, reject});
    try {
      attempt.channel.send(JSON.stringify(payload));
    } catch {
      clearTimeout(timer);
      attempt.pendingCommands.delete(eventId);
      const error = new ProtocolError(ErrorCode.VOICE_DATA_CHANNEL);
      report(callbacks, error.code);
      reject(error);
    }
  });
}

function sendWithoutWait(attempt: Attempt, callbacks: LiveCallbacks, payload: JsonRecord, ackType: string): void {
  void command(attempt, callbacks, payload, ackType).catch((error: unknown) => {
    if (!attempt.cancelled && !attempt.cleaned) report(callbacks, protocolCode(error, ErrorCode.COMMAND_REJECTED));
  });
}

function sourceLocale(config: SessionConfig): Locale {
  return getLocale(config);
}

function markClosed(attempt: Attempt, confirmed: boolean): void {
  if (attempt.closedSettled) return;
  attempt.closedSettled = true;
  attempt.confirmedClose = confirmed;
  attempt.closedResolve?.(confirmed);
  attempt.closedResolve = null;
}

function safeOnClosed(callbacks: LiveCallbacks, attempt: Attempt, confirmed: boolean): void {
  markClosed(attempt, confirmed);
  if (attempt.closedCallback) return;
  attempt.closedCallback = true;
  try {
    callbacks.onClosed(confirmed);
  } catch {
    // Cleanup must remain complete even if UI callback throws.
  }
}

function cleanupAttempt(attempt: Attempt, callbacks: LiveCallbacks, confirmed: boolean): void {
  attempt.diagnostics?.finish();
  if (attempt.cleaned) {
    safeOnClosed(callbacks, attempt, confirmed);
    return;
  }
  attempt.cleaned = true;
  attempt.cancelled = true;
  if (!confirmed && (attempt.sessionCreationAttempted || attempt.sessionId)) attempt.finalizationUnknown = true;
  clearTimer(attempt.expiryTimer);
  clearTimer(attempt.iceTimer);
  clearTimer(attempt.sessionStartTimer);
  attempt.expiryTimer = null;
  attempt.iceTimer = null;
  attempt.sessionStartTimer = null;
  attempt.abort.abort();
  attempt.backendAbort.abort();
  rejectPending(attempt, new ProtocolError(ErrorCode.SESSION_CANCELLED));
  const channel = attempt.channel;
  attempt.channel = null;
  if (channel) {
    channel.onopen = null;
    channel.onmessage = null;
    channel.onerror = null;
    channel.onclose = null;
    try {
      channel.close();
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
      peer.close();
    } catch {
      // Continue releasing media resources.
    }
  }
  stopStream(attempt.localStream);
  attempt.localStream = null;
  attempt.remoteStream?.release?.(false);
  attempt.remoteStream = null;
  markClosed(attempt, confirmed);
  status(callbacks, 'closed');
  safeOnClosed(callbacks, attempt, confirmed);
}

async function postSession(attempt: Attempt): Promise<{id: string; sdp: string}> {
  const credential = attempt.config.voiceCredential;
  const timeout = withTimeoutSignal(attempt.abort.signal, START_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(liveHttpUrl(credential.endpoint), {
        method: 'POST',
        headers: authHeaders(credential.auth, credential.apiKey),
        signal: timeout.signal,
        body: JSON.stringify({
          session: {
            model: credential.model,
            instructions: buildVoiceInstructions(attempt.mode, attempt.locale, attempt.config.voice),
            audio: {output: {voice: attempt.config.voice.voice}},
            delegation: {type: 'client'},
            store: false,
          },
          transport: {type: 'webrtc', sdp: attempt.peer?.localDescription?.sdp},
        }),
        // React Native's RequestInit has no redirect option. The native
        // network client rejects redirects; response.ok below also rejects
        // any 3xx response that reaches this layer.
      });
    } catch {
      if (attempt.abort.signal.aborted) throw new ProtocolError(ErrorCode.SESSION_CANCELLED);
      if (timeout.signal.aborted) throw new ProtocolError(ErrorCode.VOICE_TIMEOUT);
      throw new ProtocolError(ErrorCode.VOICE_NETWORK);
    }
    if (!response.ok) throw new ProtocolError(httpErrorCode('voice', response.status));
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ProtocolError(ErrorCode.VOICE_INVALID_RESPONSE);
    }
    const id = sessionIdFromResponse(value);
    if (id) attempt.sessionId = id;
    if (attempt.cancelled) {
      attempt.finalizationUnknown = true;
      throw new ProtocolError(ErrorCode.SESSION_CANCELLED);
    }
    return resolveSessionResponse(value);
  } finally {
    timeout.cleanup();
  }
}

async function sendClose(attempt: Attempt, callbacks: LiveCallbacks): Promise<void> {
  if (attempt.closeSent || !attempt.started || !isOpen(attempt.channel)) return;
  attempt.closeSent = true;
  try {
    attempt.channel.send(JSON.stringify({type: 'session.close', event_id: newEventId('close')}));
  } catch {
    report(callbacks, ErrorCode.VOICE_DATA_CHANNEL);
  }
}

function handleDelegation(
  attempt: Attempt,
  callbacks: LiveCallbacks,
  delegationId: string,
): void {
  if (attempt.closing || attempt.cleaned || attempt.seenDelegations.has(delegationId)) return;
  attempt.seenDelegations.add(delegationId);
  attempt.diagnostics?.mark('delegation_started');
  attempt.taskRevision += 1;
  const revision = attempt.taskRevision;
  attempt.activeDelegation = {id: delegationId, revision};
  attempt.backendAbort.abort();
  attempt.backendAbort = new AbortController();
  if (!attempt.config.backend.enabled || !attempt.config.backendCredential) {
    backendStatus(callbacks, 'error');
    report(callbacks, ErrorCode.BACKEND_NOT_CONFIGURED);
    return;
  }
  // A hot update may replace attempt.config while this request is waiting on
  // the settle delay or provider. Capture an immutable request snapshot so an
  // in-flight delegation keeps the settings and credential that created it.
  const delegationCredential = cloneCredential(attempt.config.backendCredential);
  const delegationPreferences = cloneBackendPreferences(attempt.config.backend);
  const delegationMode = attempt.mode;
  const delegationLocale = sourceLocale(attempt.config);
  backendStatus(callbacks, 'working');
  void (async () => {
    try {
      await delayWithAbort(DELEGATION_SETTLE_MS, attempt.backendAbort.signal);
      if (attempt.closing || attempt.cleaned || revision !== attempt.taskRevision) return;
      // Keep the settle window's late transcript fragments, then freeze the
      // history for the actual request so later turns cannot mutate it.
      const delegationHistory = attempt.history.map((fragment) => ({...fragment}));
      attempt.diagnostics?.mark('backend_requested');
      const result = await runBackendDelegation({
        credential: delegationCredential!,
        preferences: delegationPreferences,
        history: delegationHistory,
        mode: delegationMode,
        locale: delegationLocale,
        signal: attempt.backendAbort.signal,
        onSources: (sources) => {
          try {
            callbacks.onSources(sources);
          } catch {
            // UI callback must not affect the active voice session.
          }
        },
      });
      if (attempt.closing || attempt.cleaned || revision !== attempt.taskRevision) return;
      attempt.diagnostics?.mark('backend_returned');
      attempt.diagnostics?.mark('commentary_sent');
      await command(
        attempt,
        callbacks,
        {
          type: 'session.commentary.append',
          event_id: newEventId('commentary'),
          delegation_id: delegationId,
          content: result.text,
        },
        'session.commentary.appended',
      );
      attempt.diagnostics?.mark('commentary_ack');
      if (!attempt.closing && !attempt.cleaned && revision === attempt.taskRevision) backendStatus(callbacks, 'done');
    } catch (error) {
      if (attempt.closing || attempt.cleaned || revision !== attempt.taskRevision) return;
      backendStatus(callbacks, 'error');
      report(callbacks, protocolCode(error, ErrorCode.BACKEND_NETWORK));
    } finally {
      if (attempt.activeDelegation?.revision === revision) attempt.activeDelegation = null;
    }
  })();
}

function onServerEvent(attempt: Attempt, callbacks: LiveCallbacks, raw: unknown): void {
  const text = messageData(raw);
  if (!text) return;
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    report(callbacks, ErrorCode.VOICE_DATA_CHANNEL);
    return;
  }
  if (!isRecord(event) || typeof event.type !== 'string') return;
  if (resolvePending(attempt, event)) return;
  if (event.type === 'session.started') {
    if (attempt.cancelled || attempt.closing || attempt.cleaned) return;
    const session = isRecord(event.session) ? event.session : null;
    if (attempt.sessionId && typeof session?.id === 'string' && session.id !== attempt.sessionId) {
      report(callbacks, ErrorCode.VOICE_INVALID_RESPONSE);
      void closeAttempt(attempt, callbacks);
      return;
    }
    attempt.started = true;
    attempt.diagnostics?.mark('session_started');
    startSessionDurationTimer(attempt, callbacks);
    clearTimer(attempt.sessionStartTimer);
    attempt.sessionStartTimer = null;
    status(callbacks, 'connected');
    if (attempt.desiredMuted) {
      sendWithoutWait(
        attempt,
        callbacks,
        {type: 'session.input_audio.mute', event_id: newEventId('mute')},
        'session.input_audio.muted',
      );
    }
    return;
  }
  if (event.type === 'session.closed') {
    attempt.closing = true;
    const usage = isRecord(event.usage) ? event.usage.seconds : undefined;
    void usage;
    cleanupAttempt(attempt, callbacks, true);
    return;
  }
  if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
    const fragment = transcriptFragment(event);
    if (!fragment) return;
    attempt.diagnostics?.mark(fragment.role === 'user' ? 'first_input_transcript' : 'first_output_transcript');
    appendHistory(attempt, fragment);
    try {
      callbacks.onTranscript(fragment);
    } catch {
      // UI callback must not affect protocol handling.
    }
    if (fragment.role === 'user') {
      attempt.taskRevision += 1;
      if (attempt.activeDelegation) {
        attempt.backendAbort.abort();
        attempt.backendAbort = new AbortController();
      }
    }
    return;
  }
  if (event.type === 'session.delegation.created') {
    const delegation = isRecord(event.delegation) ? event.delegation : null;
    if (delegation?.target === 'client' && typeof delegation.id === 'string') {
      handleDelegation(attempt, callbacks, delegation.id);
    }
    return;
  }
  if (event.type === 'error') {
    const hadCommand = resolvePending(attempt, event);
    if (!hadCommand) {
      report(callbacks, ErrorCode.COMMAND_REJECTED);
      if (!attempt.closing) void closeAttempt(attempt, callbacks);
    }
  }
}

async function establish(attempt: Attempt, callbacks: LiveCallbacks): Promise<void> {
  const stream = await mediaDevices.getUserMedia({audio: true, video: false});
  if (attempt.cancelled || attempt.cleaned) {
    stopStream(stream);
    return;
  }
  attempt.localStream = stream;
  attempt.diagnostics?.mark('media_ready');
  setLocalMuted(stream, attempt.desiredMuted);
  const peer = new RTCPeerConnection();
  attempt.peer = peer;
  attempt.diagnostics?.attachPeer(peer);
  peer.ontrack = (event: any) => {
    if (attempt.cleaned || attempt.cancelled) return;
    const streams = Array.isArray(event?.streams) ? event.streams : [];
    attempt.remoteStream = streams[0] ?? (event?.track ? new MediaStream([event.track]) : null);
  };
  peer.onconnectionstatechange = () => {
    if (attempt.cleaned || attempt.cancelled) return;
    if (peer.connectionState === 'connected') attempt.diagnostics?.mark('transport_connected');
    if (peer.connectionState === 'failed') {
      report(callbacks, ErrorCode.VOICE_NETWORK);
      void closeAttempt(attempt, callbacks);
    }
  };
  peer.oniceconnectionstatechange = () => {
    if (attempt.cleaned || attempt.cancelled) return;
    if (peer.iceConnectionState === 'failed') {
      report(callbacks, ErrorCode.VOICE_NETWORK);
      void closeAttempt(attempt, callbacks);
    }
  };
  for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);

  const channel = peer.createDataChannel('oai-events');
  attempt.channel = channel;
  channel.onmessage = (event: any) => onServerEvent(attempt, callbacks, event?.data);
  channel.onerror = () => {
    if (!attempt.cleaned && !attempt.closing) {
      report(callbacks, ErrorCode.VOICE_DATA_CHANNEL);
      void closeAttempt(attempt, callbacks);
    }
  };
  channel.onclose = () => {
    if (!attempt.cleaned && !attempt.confirmedClose) {
      attempt.finalizationUnknown = attempt.started;
      void closeAttempt(attempt, callbacks);
    }
  };

  const offer = await peer.createOffer();
  if (attempt.cancelled) throw new ProtocolError(ErrorCode.SESSION_CANCELLED);
  await peer.setLocalDescription(offer);
  await waitForIce(attempt);
  if (!peer.localDescription?.sdp) throw new ProtocolError(ErrorCode.VOICE_INVALID_RESPONSE);
  attempt.diagnostics?.mark('offer_ready');
  status(callbacks, 'connecting');
  attempt.sessionCreationAttempted = true;
  attempt.sessionCreatePending = true;
  let answer: {id: string; sdp: string};
  try {
    answer = await postSession(attempt);
  } finally {
    attempt.sessionCreatePending = false;
  }
  if (attempt.cancelled || attempt.cleaned) throw new ProtocolError(ErrorCode.SESSION_CANCELLED);
  attempt.diagnostics?.mark('answer_received');
  await peer.setRemoteDescription(new RTCSessionDescription({type: 'answer', sdp: answer.sdp}));
  status(callbacks, 'connecting');
  attempt.sessionStartTimer = setTimeout(() => {
    if (!attempt.started && !attempt.cleaned) {
      report(callbacks, ErrorCode.VOICE_NOT_STARTED);
      void closeAttempt(attempt, callbacks);
    }
  }, START_TIMEOUT_MS);
  await new Promise<void>((resolve, reject) => {
    if (attempt.started) {
      resolve();
      return;
    }
    const check = setInterval(() => {
      if (attempt.started) {
        clearInterval(check);
        resolve();
      } else if (attempt.cleaned || attempt.cancelled) {
        clearInterval(check);
        reject(new ProtocolError(ErrorCode.SESSION_CANCELLED));
      }
    }, 20);
    attempt.abort.signal.addEventListener(
      'abort',
      () => {
        clearInterval(check);
        reject(new ProtocolError(ErrorCode.SESSION_CANCELLED));
      },
      {once: true},
    );
  });
}

async function closeAttempt(attempt: Attempt, callbacks: LiveCallbacks): Promise<boolean> {
  if (attempt.cleaned) return attempt.confirmedClose;
  if (!attempt.closing) {
    attempt.closing = true;
    status(callbacks, 'closing');
    attempt.backendAbort.abort();
    attempt.taskRevision += 1;
  }
  if (attempt.started && isOpen(attempt.channel)) {
    await sendClose(attempt, callbacks);
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<boolean>((resolve) => {
      closeTimer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
    });
    const result = await Promise.race([
      attempt.closedPromise,
      timeoutPromise,
    ]);
    clearTimer(closeTimer);
    if (result) return true;
    attempt.finalizationUnknown = true;
    report(callbacks, ErrorCode.VOICE_CLOSE_TIMEOUT);
    cleanupAttempt(attempt, callbacks, false);
    return false;
  }
  attempt.cancelled = true;
  cleanupAttempt(attempt, callbacks, false);
  return false;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function voiceStyleChanged(current: VoicePreferences, next: VoicePreferences): boolean {
  return (
    current.tone !== next.tone ||
    current.intonation !== next.intonation ||
    current.pace !== next.pace ||
    current.instructions.trim() !== next.instructions.trim()
  );
}

function staleUpdateError(attempt: Attempt): ProtocolError {
  return new ProtocolError(attempt.cancelled || attempt.cleaned ? ErrorCode.SESSION_CANCELLED : ErrorCode.SESSION_NOT_READY);
}

function makeVoiceSessionController(callbacks: LiveCallbacks): LiveController {
  let disposed = false;
  let generation = 0;
  let current: Attempt | null = null;
  let preferenceQueue = Promise.resolve();

  const connect = async (config: SessionConfig): Promise<void> => {
    if (disposed) throw new ProtocolError(ErrorCode.SESSION_DISPOSED);
    if (current && !current.cleaned) throw new ProtocolError(ErrorCode.SESSION_ALREADY_ACTIVE);
    try {
      validateSessionConfig(config);
    } catch (error) {
      const code = protocolCode(error, ErrorCode.CONFIG_INVALID);
      report(callbacks, code);
      throw error;
    }
    const attempt = makeAttempt(config, ++generation);
    current = attempt;
    status(callbacks, 'connecting');
    try {
      await establish(attempt, callbacks);
    } catch (error) {
      if (!attempt.cleaned) {
        const code = protocolCode(error, attempt.cancelled ? ErrorCode.SESSION_CANCELLED : ErrorCode.VOICE_NETWORK);
        if (!attempt.cancelled && !disposed) report(callbacks, code);
        cleanupAttempt(attempt, callbacks, false);
      }
      if (attempt.cancelled || disposed) return;
      throw error;
    }
  };

  const close = async (): Promise<boolean> => {
    if (!current) return true;
    const attempt = current;
    return closeAttempt(attempt, callbacks);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    const attempt = current;
    if (attempt && !attempt.cleaned) {
      attempt.cancelled = true;
      attempt.closing = true;
      cleanupAttempt(attempt, callbacks, false);
    }
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
      {type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute', event_id: newEventId(muted ? 'mute' : 'unmute')},
      muted ? 'session.input_audio.muted' : 'session.input_audio.unmuted',
    );
  };

  const enqueuePreferenceOperation = (operation: () => Promise<void>): Promise<void> => {
    const result = preferenceQueue.then(operation);
    preferenceQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const appendStyle = (preferences: VoicePreferences): Promise<void> => {
    const requestedAttempt = current;
    const requestedGeneration = generation;
    return enqueuePreferenceOperation(async () => {
      const attempt = requestedAttempt;
      if (
        !attempt ||
        current !== attempt ||
        generation !== requestedGeneration ||
        attempt.cleaned
      ) throw new ProtocolError(ErrorCode.SESSION_NOT_READY);
      const content = buildVoiceInstructions(attempt.mode, attempt.locale, preferences);
      await command(
        attempt,
        callbacks,
        {type: 'session.instructions.append', event_id: newEventId('style'), delegation_id: null, content},
        'session.instructions.appended',
      );
    });
  };

  const updatePreferences = (update: LivePreferencesUpdate): Promise<void> => {
    const requestedAttempt = current;
    const requestedGeneration = generation;
    return enqueuePreferenceOperation(async () => {
      if (disposed) throw new ProtocolError(ErrorCode.SESSION_DISPOSED);
      if (!update || typeof update !== 'object' || Array.isArray(update)) {
        throw new ProtocolError(ErrorCode.CONFIG_INVALID);
      }
      const attempt = requestedAttempt;
      if (
        !attempt ||
        current !== attempt ||
        generation !== requestedGeneration ||
        !attempt.started ||
        !isOpen(attempt.channel) ||
        attempt.cleaned ||
        attempt.closing
      ) {
        throw new ProtocolError(ErrorCode.SESSION_NOT_READY);
      }

      const hasVoice = hasOwn(update, 'voice');
      const hasBackend = hasOwn(update, 'backend');
      const hasCredential = hasOwn(update, 'backendCredential');
      if (!hasVoice && !hasBackend && !hasCredential) return;

      if (hasVoice) validateVoicePreferences(update.voice as VoicePreferences);
      if (hasCredential && update.backendCredential !== null) {
        validateCredential(update.backendCredential as Credential);
      }

      const currentVoice = attempt.config.voice;
      const nextVoice = hasVoice
        ? {
            ...(update.voice as VoicePreferences),
            // The output voice is negotiated at session creation and cannot
            // be changed by an instructions append.
            voice: currentVoice.voice,
            minutes: Number((update.voice as VoicePreferences).minutes),
          }
        : cloneVoicePreferences(currentVoice);
      const currentBackend = attempt.config.backend;
      const nextBackend = hasBackend
        ? cloneBackendPreferences(update.backend as BackendPreferences)
        : cloneBackendPreferences(currentBackend);
      const nextCredential = hasCredential
        ? cloneCredential(update.backendCredential as Credential | null)
        : cloneCredential(attempt.config.backendCredential);

      if (nextBackend.enabled && !nextCredential) {
        throw new ProtocolError(ErrorCode.BACKEND_NOT_CONFIGURED);
      }
      if (nextBackend.enabled) validateBackendPreferences(nextBackend);
      if (nextCredential) validateCredential(nextCredential);

      if (
        hasVoice &&
        nextVoice.minutes !== currentVoice.minutes &&
        nextVoice.minutes > 0 &&
        attempt.sessionStartedAt !== null
      ) {
        const elapsedMs = Math.max(0, Date.now() - attempt.sessionStartedAt);
        if (elapsedMs >= nextVoice.minutes * 60_000) {
          // Never turn a live update into an immediate, surprising close.
          // The caller can choose a larger limit or zero (no limit).
          throw new ProtocolError(ErrorCode.SESSION_LIMIT_ELAPSED);
        }
      }

      const shouldAppendStyle = hasVoice && voiceStyleChanged(currentVoice, nextVoice);
      if (shouldAppendStyle) {
        const content = buildVoiceUpdateInstructions(attempt.mode, attempt.locale, nextVoice);
        await command(
          attempt,
          callbacks,
          {
            type: 'session.instructions.append',
            event_id: newEventId('style-update'),
            delegation_id: null,
            content,
          },
          'session.instructions.appended',
        );
      }

      if (!isCurrentAttempt(current, attempt) || !attempt.started || !isOpen(attempt.channel) || attempt.closing) {
        throw staleUpdateError(attempt);
      }

      // Commit only after every validation and, when needed, the exact server
      // acknowledgement. This keeps a rejected command from changing the
      // local snapshot used by later delegations.
      attempt.config = {
        ...attempt.config,
        voice: nextVoice,
        backend: nextBackend,
        backendCredential: nextCredential,
      };
      if (hasVoice && nextVoice.minutes !== currentVoice.minutes) {
        startSessionDurationTimer(attempt, callbacks);
      }
    });
  };

  return {connect, close, dispose, setMuted, appendStyle, updatePreferences};
}

export function createLiveController(callbacks: LiveCallbacks): LiveController {
  return makeVoiceSessionController(callbacks);
}

interface ProbeSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: {data: unknown}) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

function websocketConstructor(): new (url: string, protocols?: string | string[], options?: unknown) => ProbeSocket {
  const constructor = (globalThis as unknown as {WebSocket?: unknown}).WebSocket;
  if (typeof constructor !== 'function') throw new ProtocolError(ErrorCode.VOICE_NETWORK);
  return constructor as new (url: string, protocols?: string | string[], options?: unknown) => ProbeSocket;
}

export function probeVoice(credential: Credential, signal?: AbortSignal): Promise<void> {
  validateCredential(credential);
  if (signal?.aborted) return Promise.reject(new ProtocolError(ErrorCode.SESSION_CANCELLED));
  const Socket = websocketConstructor();
  const url = liveWebSocketUrl(credential.endpoint);
  const socket = new Socket(url, [], {headers: authHeaders(credential.auth, credential.apiKey)});
  let phase: 'starting' | 'closing' | 'done' = 'starting';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let resolveProbe: (() => void) | null = null;
  let rejectProbe: ((error: ProtocolError) => void) | null = null;
  const promise = new Promise<void>((resolve, reject) => {
    resolveProbe = resolve;
    rejectProbe = reject;
  });
  const finish = (error?: ProtocolError) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    signal?.removeEventListener('abort', onAbort);
    try {
      if (socket.readyState === 0 || socket.readyState === 1) socket.close();
    } catch {
      // Ignore socket cleanup errors.
    }
    if (error) rejectProbe?.(error);
    else resolveProbe?.();
  };
  const onAbort = () => finish(new ProtocolError(ErrorCode.SESSION_CANCELLED));
  signal?.addEventListener('abort', onAbort, {once: true});
  const arm = (milliseconds: number, code: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => finish(new ProtocolError(code as any)), milliseconds);
  };
  socket.onopen = () => {
    try {
      socket.send(
        JSON.stringify({
          type: 'session.start',
          event_id: newEventId('probe'),
          session: {
            model: credential.model,
            audio: {format: {type: 'audio/pcm', rate: 24_000}, output: {voice: 'marin'}},
            delegation: {type: 'client'},
            store: false,
          },
        }),
      );
      arm(START_TIMEOUT_MS, ErrorCode.VOICE_PROBE_TIMEOUT);
    } catch {
      finish(new ProtocolError(ErrorCode.VOICE_NETWORK));
    }
  };
  socket.onmessage = ({data}) => {
    const text = messageData(data);
    if (!text) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(value) || typeof value.type !== 'string') return;
    if (value.type === 'session.started' && phase === 'starting') {
      phase = 'closing';
      try {
        socket.send(JSON.stringify({type: 'session.close', event_id: newEventId('probe-close')}));
        arm(CLOSE_TIMEOUT_MS, ErrorCode.VOICE_PROBE_UNCONFIRMED);
      } catch {
        finish(new ProtocolError(ErrorCode.VOICE_NETWORK));
      }
    } else if (value.type === 'session.closed' && phase === 'closing') {
      phase = 'done';
      finish();
    }
  };
  socket.onerror = () => finish(new ProtocolError(ErrorCode.VOICE_NETWORK));
  socket.onclose = () => {
    if (!settled) finish(new ProtocolError(phase === 'closing' ? ErrorCode.VOICE_PROBE_UNCONFIRMED : ErrorCode.VOICE_NETWORK));
  };
  arm(START_TIMEOUT_MS, ErrorCode.VOICE_PROBE_TIMEOUT);
  return promise;
}
