import type { Mode, RecordingInfo } from './types';
import type { RecordingStatus } from './recordings';

type Dependencies = {
  start(id: string, mode: Mode, startedAt: number): Promise<void>;
  markConnected(id: string): Promise<void>;
  finish(id: string, confirmed: boolean): Promise<RecordingInfo | null>;
  discard(id: string): Promise<void>;
};
export function recordingErrorCode(error: unknown): string {
  const value = error as { code?: string; message?: string };
  const code = value?.code || value?.message;
  return code === 'recording_storage_full' ? code : 'recording_failed';
}

/** Await startup before finalization, and persist only sessions that actually connected. */
export function createRecordingSession(
  meta: { id: string; mode: Mode; startedAt: number },
  dependencies: Dependencies,
  onState: (state: RecordingStatus) => void,
) {
  let connected = false;
  let started = false;
  let beginning: Promise<void> | null = null;
  let marking: Promise<void> | null = null;
  let ending: Promise<RecordingInfo | null> | null = null;
  const publish = (state: RecordingStatus['state'], code?: string) =>
    onState({ id: meta.id, state, code });
  return {
    start() {
      if (ending) return Promise.resolve();
      if (!beginning)
        beginning = (async () => {
          try {
            await dependencies.start(meta.id, meta.mode, meta.startedAt);
            started = true;
            if (!ending) publish('recording');
          } catch (error) {
            publish('error', recordingErrorCode(error));
          }
        })();
      return beginning;
    },
    connected() {
      if (ending) return;
      connected = true;
      if (!marking)
        marking = (async () => {
          await beginning;
          if (!started) return;
          try {
            await dependencies.markConnected(meta.id);
          } catch (error) {
            publish('error', recordingErrorCode(error));
          }
        })();
    },
    finish(confirmed: boolean) {
      if (!ending)
        ending = (async () => {
          await beginning;
          await marking;
          if (!started) return null;
          try {
            if (!connected) {
              await dependencies.discard(meta.id);
              publish('idle');
              return null;
            }
            publish('saving');
            const result = await dependencies.finish(meta.id, confirmed);
            if (!result) publish('error', 'recording_failed');
            else publish(result.errorCode ? 'error' : 'idle', result.errorCode);
            return result;
          } catch (error) {
            publish('error', recordingErrorCode(error));
            return null;
          }
        })();
      return ending;
    },
  };
}
