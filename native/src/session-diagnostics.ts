/**
 * Small, local-only diagnostics for finding delays in a live session.
 *
 * The collector deliberately accepts only enumerated event names and numeric
 * counters. It never receives transcript text, credentials, endpoints, or
 * identifiers. Elapsed times are measured locally from collector creation;
 * they describe local event receipt, not provider or speech-recognition time.
 * `micPeak` and `totalAudioEnergy` are audio-level summaries and are not
 * speech-recognition results.
 */

export const SESSION_DIAGNOSTIC_EVENTS = [
  'connect_requested',
  'media_ready',
  'offer_ready',
  'answer_received',
  'transport_connected',
  'session_started',
  'first_input_transcript',
  'first_output_transcript',
  'delegation_started',
  'backend_requested',
  'backend_returned',
  'commentary_sent',
  'commentary_ack',
  'closed',
] as const;

export type SessionDiagnosticEvent = (typeof SESSION_DIAGNOSTIC_EVENTS)[number];

export const SESSION_DIAGNOSTIC_SAMPLE_KEYS = [
  'micFrames',
  'micPeak',
  'playoutFrames',
  'playoutPeak',
  'packetsSent',
  'bytesSent',
  'packetsReceived',
  'bytesReceived',
  'totalAudioEnergy',
  'roundTripTime',
  'firstCaptureMs',
  'firstPlayoutMs',
] as const;

export type SessionDiagnosticSampleKey =
  (typeof SESSION_DIAGNOSTIC_SAMPLE_KEYS)[number];

/** Safe numeric metadata allowed on a lifecycle mark. */
export const SESSION_DIAGNOSTIC_MARK_KEYS = [
  'durationMs',
  'count',
  'statusCode',
] as const;

export type SessionDiagnosticMarkKey =
  (typeof SESSION_DIAGNOSTIC_MARK_KEYS)[number];

export type SessionDiagnosticSampleInput = Partial<
  Record<SessionDiagnosticSampleKey, number>
> &
  Record<string, unknown>;

export type SessionDiagnosticMarkFields = Partial<
  Record<SessionDiagnosticMarkKey, number>
> &
  Record<string, unknown>;

export type SessionDiagnosticMark = {
  type: 'mark';
  event: SessionDiagnosticEvent;
  elapsedMs: number;
} & Partial<Record<SessionDiagnosticMarkKey, number>>;

export type SessionDiagnosticSample = {
  type: 'sample';
  elapsedMs: number;
} & Partial<Record<SessionDiagnosticSampleKey, number>>;

export type SessionDiagnosticEntry =
  | SessionDiagnosticMark
  | SessionDiagnosticSample;

export interface SessionDiagnosticSnapshot {
  version: 1;
  entries: SessionDiagnosticEntry[];
}

export interface SessionDiagnostics {
  /** Resolves after the current queued snapshot has been attempted. */
  mark(
    event: SessionDiagnosticEvent,
    fields?: SessionDiagnosticMarkFields,
  ): Promise<void>;
  /** Resolves after the current queued snapshot has been attempted. */
  sample(stats: SessionDiagnosticSampleInput): Promise<void>;
  /** Adds the terminal mark and resolves after it has been attempted. */
  finish(): Promise<void>;
}

type Clock = () => number;

const MAX_ENTRIES = 120;
const MAX_SAMPLES = 30;

const REPEATING_EVENTS = new Set<SessionDiagnosticEvent>([
  'delegation_started',
  'backend_requested',
  'backend_returned',
  'commentary_sent',
  'commentary_ack',
]);

const EVENT_SET = new Set<string>(SESSION_DIAGNOSTIC_EVENTS);
const SAMPLE_KEY_SET = new Set<string>(SESSION_DIAGNOSTIC_SAMPLE_KEYS);
const MARK_KEY_SET = new Set<string>(SESSION_DIAGNOSTIC_MARK_KEYS);

function defaultClock(): number {
  const runtime = globalThis as unknown as {
    performance?: {now?: () => number};
  };
  const perf = typeof globalThis !== 'undefined' ? runtime.performance : undefined;
  if (perf && typeof perf.now === 'function') return perf.now();
  return Date.now();
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function elapsedSince(startedAt: number, now: Clock): number {
  const current = finiteNumber(now());
  if (current === undefined) return 0;
  return Math.max(0, current - startedAt);
}

function sanitizeFields(
  source: Record<string, unknown> | undefined,
  allowed: Set<string>,
): Record<string, number> {
  const result: Record<string, number> = {};
  if (!source) return result;
  for (const key of allowed) {
    const value = finiteNumber(source[key]);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function isKnownEvent(value: string): value is SessionDiagnosticEvent {
  return EVENT_SET.has(value);
}

function isSample(entry: SessionDiagnosticEntry): entry is SessionDiagnosticSample {
  return entry.type === 'sample';
}

function isRepeatingMark(entry: SessionDiagnosticEntry): boolean {
  return entry.type === 'mark' && REPEATING_EVENTS.has(entry.event);
}

/**
 * Creates a bounded, best-effort local session trace.
 *
 * Writes are serialized. If a write is in flight, newer state replaces the
 * pending snapshot; the writer therefore receives the newest complete trace
 * after the current write finishes. Writer failures are intentionally ignored
 * so diagnostics cannot affect a conversation.
 */
export function createSessionDiagnostics(
  write: (snapshot: SessionDiagnosticSnapshot) => Promise<void>,
  now: Clock = defaultClock,
): SessionDiagnostics {
  const createdAtValue = finiteNumber(now());
  const createdAt = createdAtValue === undefined ? 0 : createdAtValue;
  const entries: SessionDiagnosticEntry[] = [];
  let finished = false;
  let finishPromise: Promise<void> | null = null;
  let pendingSnapshot: SessionDiagnosticSnapshot | null = null;
  let draining = false;
  let idlePromise: Promise<void> = Promise.resolve();
  let resolveIdle: (() => void) | null = null;

  function snapshot(): SessionDiagnosticSnapshot {
    return {
      version: 1,
      entries: entries.map(entry => ({...entry})),
    };
  }

  function startDrain(): void {
    if (draining) return;
    draining = true;
    idlePromise = new Promise<void>(resolve => {
      resolveIdle = resolve;
    });
    drain().catch(() => undefined);
  }

  async function drain(): Promise<void> {
    while (pendingSnapshot) {
      const next = pendingSnapshot;
      pendingSnapshot = null;
      try {
        await write(next);
      } catch {
        // Diagnostics are best effort and must never affect the live session.
      }
    }
    draining = false;
    const resolve = resolveIdle;
    resolveIdle = null;
    resolve?.();
    // No user callback runs between the loop condition and this point, but
    // retain the guard for a caller that queues work from a promise callback.
    if (pendingSnapshot) startDrain();
  }

  function enqueue(): Promise<void> {
    pendingSnapshot = snapshot();
    startDrain();
    return idlePromise;
  }

  function dropOldestSample(): boolean {
    const index = entries.findIndex(isSample);
    if (index < 0) return false;
    entries.splice(index, 1);
    return true;
  }

  function dropOldestRepeatingMark(): boolean {
    const index = entries.findIndex(isRepeatingMark);
    if (index < 0) return false;
    entries.splice(index, 1);
    return true;
  }

  function appendMark(entry: SessionDiagnosticMark): void {
    if (entries.length < MAX_ENTRIES) {
      entries.push(entry);
      return;
    }
    // Keep the first occurrence of every lifecycle mark and make room for a
    // late terminal/lifecycle mark by evicting repeated work markers first.
    // Startup audio samples are useful evidence, so keep them when a repeated
    // backend/commentary mark is available to evict.
    if (dropOldestRepeatingMark() || dropOldestSample()) entries.push(entry);
  }

  function appendSample(entry: SessionDiagnosticSample): void {
    // Samples describe a moving audio state; keep the newest bounded window.
    while (entries.filter(isSample).length >= MAX_SAMPLES) {
      if (!dropOldestSample()) return;
    }
    if (entries.length >= MAX_ENTRIES && !dropOldestRepeatingMark()) return;
    entries.push(entry);
  }

  function mark(
    event: SessionDiagnosticEvent,
    fields?: SessionDiagnosticMarkFields,
  ): Promise<void> {
    if (finished || !isKnownEvent(event)) return Promise.resolve();
    if (
      !REPEATING_EVENTS.has(event) &&
      entries.some(entry => entry.type === 'mark' && entry.event === event)
    ) {
      return Promise.resolve();
    }
    const safeFields = sanitizeFields(fields, MARK_KEY_SET);
    appendMark({
      type: 'mark',
      event,
      elapsedMs: elapsedSince(createdAt, now),
      ...safeFields,
    });
    return enqueue();
  }

  function sample(stats: SessionDiagnosticSampleInput): Promise<void> {
    if (finished) return Promise.resolve();
    const safeFields = sanitizeFields(stats, SAMPLE_KEY_SET);
    if (Object.keys(safeFields).length === 0) return Promise.resolve();
    appendSample({
      type: 'sample',
      elapsedMs: elapsedSince(createdAt, now),
      ...safeFields,
    });
    return enqueue();
  }

  function finish(): Promise<void> {
    if (finishPromise) return finishPromise;
    finished = true;
    if (!entries.some(entry => entry.type === 'mark' && entry.event === 'closed')) {
      appendMark({
        type: 'mark',
        event: 'closed',
        elapsedMs: elapsedSince(createdAt, now),
      });
    }
    finishPromise = enqueue();
    return finishPromise;
  }

  return {mark, sample, finish};
}
