import type { Connection, Credential, Kind } from './types';

export type ImportedCredentials = Partial<Record<Kind, Credential>>;
export type QrImportPhase =
  | 'idle'
  | 'scanning'
  | 'passphrase'
  | 'decrypting'
  | 'preview'
  | 'testing'
  | 'saving'
  | 'saved';
export type QrImportState = {
  phase: QrImportPhase;
  preview: Partial<Record<Kind, Connection>>;
  testingKind?: Kind;
  errorCode?: string;
};
export type QrImportDependencies = {
  scan(locale: 'zh' | 'en', signal: AbortSignal): Promise<string>;
  decrypt(
    payload: string,
    passphrase: string,
  ): Promise<{ version: 1; connections: ImportedCredentials }>;
  cancelNative(): Promise<unknown>;
  test(kind: Kind, credential: Credential, signal: AbortSignal): Promise<void>;
  save(
    connections: ImportedCredentials,
    signal: AbortSignal,
  ): Promise<Record<Kind, Connection | null>>;
  onSaved(connections: Record<Kind, Connection | null>): void;
};

const codes = new Set([
  'qr_cancelled',
  'qr_busy',
  'qr_unavailable',
  'qr_failed',
  'camera_permission',
  'camera_unavailable',
  'invalid_config',
  'invalid_endpoint',
  'invalid_model',
  'invalid_key',
  'invalid_passphrase',
  'invalid_payload',
  'unsupported_version',
  'payload_too_large',
  'decrypt_failed',
  'storage_failed',
  'key_required',
  'app_inactive',
  'voice_network',
  'voice_timeout',
  'voice_not_started',
  'voice_close_timeout',
  'voice_closed_unconfirmed',
  'voice_invalid_response',
  'voice_data_channel',
  'backend_network',
  'backend_timeout',
  'backend_incomplete',
  'backend_empty_output',
  'backend_invalid_response',
  'backend_not_configured',
  'session_cancelled',
]);

function errorCode(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown };
  const candidate =
    typeof value?.code === 'string' ? value.code : value?.message;
  return typeof candidate === 'string' &&
    (codes.has(candidate) || /^(voice|backend)_http_\d{3}$/.test(candidate))
    ? candidate
    : 'qr_failed';
}

function previewOf(
  connections: ImportedCredentials,
): Partial<Record<Kind, Connection>> {
  const preview: Partial<Record<Kind, Connection>> = {};
  for (const kind of ['voice', 'backend'] as const) {
    const credential = connections[kind];
    if (!credential) continue;
    const characters = Array.from(credential.apiKey);
    const keyMask =
      characters.length <= 8
        ? '••••••••'
        : `${characters.slice(0, 4).join('')}••••••${characters
            .slice(-4)
            .join('')}`;
    preview[kind] = {
      endpoint: credential.endpoint,
      model: credential.model,
      auth: credential.auth,
      keyMask,
    };
  }
  return preview;
}

/** Credentials stay in this short-lived closure; React receives masked previews only. */
export function createQrImporter(
  deps: QrImportDependencies,
  onState: (state: QrImportState) => void,
) {
  let phase: QrImportPhase = 'idle';
  let preview: QrImportState['preview'] = {};
  let payload = '';
  let credentials: ImportedCredentials | null = null;
  let revision = 0;
  let disposed = false;
  let request: AbortController | null = null;
  const publish = (next: QrImportPhase, error?: string, testingKind?: Kind) => {
    phase = next;
    if (!disposed) onState({ phase, preview, errorCode: error, testingKind });
  };
  const clear = () => {
    payload = '';
    credentials = null;
    preview = {};
  };
  const current = (id: number) => !disposed && id === revision;
  const cancelNative = () => {
    void deps.cancelNative().catch(() => undefined);
  };

  function cancel() {
    request?.abort();
    if (phase === 'saving') return; // An atomic write already started may still commit.
    revision += 1;
    cancelNative();
    clear();
    publish('idle', 'qr_cancelled');
  }
  async function scan(locale: 'zh' | 'en') {
    if (disposed || !['idle', 'passphrase', 'preview', 'saved'].includes(phase))
      return;
    request?.abort();
    clear();
    const id = ++revision;
    const operation = new AbortController();
    request = operation;
    publish('scanning');
    try {
      const result = await deps.scan(locale, operation.signal);
      if (!current(id)) return;
      payload = result;
      publish('passphrase');
    } catch (error) {
      if (current(id)) {
        clear();
        publish('idle', errorCode(error));
      }
    } finally {
      if (request === operation) request = null;
    }
  }
  async function decrypt(passphrase: string) {
    if (disposed || phase !== 'passphrase' || !payload) return;
    const id = revision;
    publish('decrypting');
    try {
      const value = await deps.decrypt(payload, passphrase);
      if (!current(id)) return;
      if (
        value.version !== 1 ||
        !value.connections ||
        (!value.connections.voice && !value.connections.backend)
      )
        throw new Error('invalid_config');
      credentials = value.connections;
      preview = previewOf(credentials);
      payload = '';
      publish('preview');
    } catch (error) {
      if (current(id)) {
        credentials = null;
        preview = {};
        publish('passphrase', errorCode(error));
      }
    }
  }
  async function testAndSave(kinds: Kind[]) {
    if (disposed || phase !== 'preview' || !credentials) return;
    const selected: ImportedCredentials = {};
    for (const kind of ['voice', 'backend'] as const)
      if (kinds.includes(kind) && credentials[kind])
        selected[kind] = credentials[kind];
    if (!selected.voice && !selected.backend) {
      publish('preview', 'invalid_config');
      return;
    }
    const id = revision;
    const operation = new AbortController();
    request = operation;
    try {
      for (const kind of ['voice', 'backend'] as const) {
        if (!selected[kind]) continue;
        publish('testing', undefined, kind);
        await deps.test(kind, selected[kind]!, operation.signal);
        if (!current(id) || operation.signal.aborted) return;
      }
      publish('saving');
      const result = await deps.save(selected, operation.signal);
      // Successful completion is authoritative even if a background transition
      // occurred after the single secure-storage write began.
      clear();
      publish('saved');
      deps.onSaved(result);
    } catch (error) {
      if (current(id)) {
        if (operation.signal.aborted) {
          clear();
          publish('idle', 'qr_cancelled');
        } else publish('preview', errorCode(error));
      }
    } finally {
      if (request === operation) request = null;
    }
  }
  return {
    scan,
    decrypt,
    testAndSave,
    cancel,
    get phase() {
      return phase;
    },
    dispose() {
      disposed = true;
      request?.abort();
      revision += 1;
      cancelNative();
      clear();
    },
  };
}
