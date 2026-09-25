export type AutoSaveState<R> =
  | {phase: 'idle' | 'pending' | 'saving'}
  | {phase: 'saved'; result: R}
  | {phase: 'error'; error: unknown};

/** Debounced latest-value writes. Different sections share one serial queue;
 * an older ACK must never replace the status of a newer edit. */
export function createPreferenceAutosave<K extends string, T, R>(
  commit: (kind: K, value: T) => Promise<R>,
  onState: (kind: K, state: AutoSaveState<R>) => void,
) {
  type Job = {kind: K; value: T; revision: number; ready: boolean};
  const jobs = new Map<K, Job>();
  const latest = new Map<K, T>();
  const revisions = new Map<K, number>();
  const timers = new Map<K, ReturnType<typeof setTimeout>>();
  const errors = new Map<K, unknown>();
  let running: Promise<void> | null = null;
  let disposed = false;
  function publish(kind: K, state: AutoSaveState<R>) {
    if (!disposed) {
      try { onState(kind, state); } catch { /* UI cannot interrupt persistence. */ }
    }
  }
  function drain(): Promise<void> {
    if (running) return running;
    running = Promise.resolve().then(async () => {
      while (!disposed) {
        const job = [...jobs.values()].find(item => item.ready);
        if (!job) break;
        jobs.delete(job.kind);
        publish(job.kind, {phase: 'saving'});
        try {
          const result = await commit(job.kind, job.value);
          if (revisions.get(job.kind) === job.revision) {
            errors.delete(job.kind);
            publish(job.kind, {phase: 'saved', result});
          }
        } catch (error) {
          if (revisions.get(job.kind) === job.revision) {
            errors.set(job.kind, error);
            publish(job.kind, {phase: 'error', error});
          }
        }
      }
    }).finally(() => { running = null; });
    return running;
  }
  function schedule(kind: K, value: T, delayMs = 500) {
    if (disposed) return;
    const revision = (revisions.get(kind) ?? 0) + 1;
    revisions.set(kind, revision);
    latest.set(kind, value);
    errors.delete(kind);
    const oldTimer = timers.get(kind);
    if (oldTimer) clearTimeout(oldTimer);
    const job = {kind, value, revision, ready: false};
    jobs.set(kind, job);
    publish(kind, {phase: 'pending'});
    timers.set(kind, setTimeout(() => {
      timers.delete(kind);
      job.ready = true;
      void drain();
    }, delayMs));
  }
  async function flush() {
    while (!disposed && (jobs.size || running)) {
      timers.forEach(clearTimeout); timers.clear();
      jobs.forEach(job => { job.ready = true; });
      await drain();
    }
    if (errors.size) throw errors.values().next().value;
  }
  function retry(kind: K) {
    if (latest.has(kind)) schedule(kind, latest.get(kind)!, 0);
    return flush();
  }
  function retryFailed() {
    for (const kind of [...errors.keys()]) {
      if (latest.has(kind)) schedule(kind, latest.get(kind)!, 0);
    }
    return flush();
  }
  function dispose() {
    disposed = true;
    timers.forEach(clearTimeout); timers.clear(); jobs.clear();
  }
  return {schedule, flush, retry, retryFailed, dispose};
}
