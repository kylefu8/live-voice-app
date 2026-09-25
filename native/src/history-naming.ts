import type {ConversationRecord, Credential, Locale} from './types';

type Dependencies = {
  generate(credential: Credential, record: ConversationRecord, locale: Locale, signal: AbortSignal): Promise<string | null>;
  apply(id: string, title: string): Promise<boolean>;
  onUpdated(): Promise<void>;
};

/** Optional post-save jobs are independent of voice sessions and never recreate records. */
export function createHistoryNaming(deps: Dependencies) {
  const pending = new Map<string, AbortController>();
  return {
    async start(record: ConversationRecord, credential: Credential, locale: Locale) {
      if (pending.has(record.id) || record.title || !record.fragments.some(f => f.role === 'user' && f.text.trim())) return;
      const request = new AbortController();
      pending.set(record.id, request);
      try {
        const title = await deps.generate(credential, record, locale, request.signal);
        if (!title || request.signal.aborted) return;
        if (await deps.apply(record.id, title)) await deps.onUpdated();
      } catch {
        // Saving and future conversations must not depend on optional naming.
      } finally {
        if (pending.get(record.id) === request) pending.delete(record.id);
      }
    },
    cancel(id: string) {
      pending.get(id)?.abort();
    },
    cancelAll() {
      for (const request of pending.values()) request.abort();
    },
  };
}
