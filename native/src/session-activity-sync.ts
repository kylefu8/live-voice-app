import type {SessionActivityState} from './session-activity';

type Bridge = {
  start(id: string, locale: string, state: SessionActivityState): Promise<boolean>;
  update(id: string, state: SessionActivityState): Promise<void>;
  end(id: string): Promise<void>;
};

/** Publish from session events, independently of React renders/background UI scheduling. */
export function createSessionActivitySync(id: string, locale: string, bridge: Bridge) {
  let state: SessionActivityState = {
    status: 'connecting', muted: false, recording: false, backendWorking: false, startedAt: null,
  };
  let closed = false;
  let visible = false;
  let revision = 0;
  let sentRevision = -1;
  let pending: Promise<void> | null = null;
  let ending: Promise<void> | null = null;

  function flush(): Promise<void> {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    if (!visible && state.status !== 'connected') return Promise.resolve();
    let succeeded = false;
    pending = (async () => {
      if (!visible) {
        const version = revision;
        visible = await bridge.start(id, locale, {...state});
        if (!visible || closed) return;
        sentRevision = version;
      }
      while (!closed && sentRevision !== revision) {
        const version = revision;
        await bridge.update(id, {...state});
        sentRevision = version;
      }
      succeeded = true;
    })().finally(() => {
      pending = null;
      if (succeeded && visible && !closed && sentRevision !== revision) {
        void flush().catch(() => undefined);
      }
    });
    return pending;
  }

  return {
    get visible() { return visible && !closed; },
    update(patch: Partial<SessionActivityState>): Promise<void> {
      if (closed) return Promise.resolve();
      const next = {...state, ...patch};
      if (state.startedAt !== null) next.startedAt = state.startedAt;
      if (state.status !== 'connecting' && next.status === 'connecting') next.status = state.status;
      if (Object.keys(next).every(key => next[key as keyof SessionActivityState] === state[key as keyof SessionActivityState])) {
        return pending ?? Promise.resolve();
      }
      state = next;
      revision += 1;
      return flush();
    },
    /** Retry creation when the app returns to the foreground. */
    resume: flush,
    end(): Promise<void> {
      if (ending) return ending;
      closed = true;
      ending = (async () => {
        // A request already sent to ActivityKit may finish after the call ends.
        await pending?.catch(() => undefined);
        if (visible) await bridge.end(id);
        visible = false;
      })();
      return ending;
    },
  };
}
