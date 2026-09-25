import type {
  BackendPreferences,
  Credential,
  Locale,
  Mode,
  TranscriptFragment,
} from './types';
import {
  ErrorCode,
  ProtocolError,
  authHeaders,
  buildBackendInstructions,
  httpErrorCode,
  responsesHttpUrl,
  validateCredential,
  withTimeoutSignal,
} from './protocol';
import {buildTitleRequest, parseGeneratedTitle} from './history-title';

export interface BackendRunOptions {
  credential: Credential;
  preferences: BackendPreferences;
  history: TranscriptFragment[];
  mode: Mode;
  locale?: Locale;
  signal?: AbortSignal;
  onSources?: (sources: {title: string; url: string}[]) => void;
}

export interface BackendRunResult {
  text: string;
  usage?: unknown;
}

type JsonRecord = Record<string, unknown>;

function timeoutSeconds(preferences: BackendPreferences): number {
  const value = Number(preferences.timeoutSeconds);
  if (!Number.isFinite(value) || value < 1 || value > 300) {
    throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  }
  return value;
}

function maxOutputTokens(preferences: BackendPreferences): number {
  const value = Number(preferences.maxOutputTokens);
  if (!Number.isInteger(value) || value < 16 || value > 32768) {
    throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  }
  return value;
}

function responseRequest(
  credential: Credential,
  preferences: BackendPreferences,
  input: unknown,
  mode: Mode,
  locale: Locale,
): JsonRecord {
  const body: JsonRecord = {
    model: credential.model,
    instructions: buildBackendInstructions(locale, mode, preferences),
    input,
    max_output_tokens: maxOutputTokens(preferences),
    store: false,
  };
  if (preferences.effort !== 'default') body.reasoning = {effort: preferences.effort};
  if (preferences.webSearch) {
    body.tools = [{type: 'web_search'}];
    body.include = ['web_search_call.action.sources'];
  }
  return body;
}

function probeRequest(credential: Credential): JsonRecord {
  return {
    model: credential.model,
    instructions: 'Reply with the single word OK.',
    input: [{role: 'user', content: 'Reply with OK.'}],
    max_output_tokens: 16,
    store: false,
  };
}

async function requestJson(
  credential: Credential,
  preferences: BackendPreferences,
  body: JsonRecord,
  parentSignal?: AbortSignal,
): Promise<JsonRecord> {
  validateCredential(credential);
  const timeout = withTimeoutSignal(parentSignal, timeoutSeconds(preferences) * 1000);
  try {
    let response: Response;
    try {
      response = await fetch(responsesHttpUrl(credential.endpoint), {
        method: 'POST',
        headers: authHeaders(credential.auth, credential.apiKey),
        body: JSON.stringify(body),
        signal: timeout.signal,
        // React Native's RequestInit does not expose redirect. The native
        // OkHttp client is configured not to follow redirects; non-2xx,
        // including 3xx, is rejected below.
      });
    } catch {
      if (parentSignal?.aborted) throw new ProtocolError(ErrorCode.BACKEND_ABORTED);
      if (timeout.signal.aborted) throw new ProtocolError(ErrorCode.BACKEND_TIMEOUT);
      throw new ProtocolError(ErrorCode.BACKEND_NETWORK);
    }
    if (!response.ok) {
      throw new ProtocolError(httpErrorCode('backend', response.status), httpStatus(response.status));
    }
    try {
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ProtocolError(ErrorCode.BACKEND_INVALID_RESPONSE);
      }
      return value as JsonRecord;
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(ErrorCode.BACKEND_INVALID_RESPONSE);
    }
  } finally {
    timeout.cleanup();
  }
}

function httpStatus(status: number): 400 | 401 | 403 | 404 | 408 | 409 | 429 | 500 | 502 | 503 | 504 | 0 {
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return status;
  }
  return 0;
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function sourceRows(result: JsonRecord): {rows: {title: string; url: string}[]; searchFailed: boolean} {
  const rows: {title: string; url: string}[] = [];
  let searchFailed = false;
  const output = Array.isArray(result.output) ? result.output : [];
  for (const rawItem of output) {
    if (!isRecord(rawItem)) continue;
    if (rawItem.type === 'web_search_call' && rawItem.status !== 'completed') searchFailed = true;
    const action = isRecord(rawItem.action) ? rawItem.action : null;
    const actionSources = action && Array.isArray(action.sources) ? action.sources : [];
    for (const rawSource of actionSources) {
      if (!isRecord(rawSource)) continue;
      const url = safeUrl(rawSource.url);
      if (url) rows.push({title: nonEmptyText(rawSource.title) ? rawSource.title : url, url});
    }
    const content = Array.isArray(rawItem.content) ? rawItem.content : [];
    for (const rawPart of content) {
      if (!isRecord(rawPart)) continue;
      const annotations = Array.isArray(rawPart.annotations) ? rawPart.annotations : [];
      for (const rawAnnotation of annotations) {
        if (!isRecord(rawAnnotation) || rawAnnotation.type !== 'url_citation') continue;
        const url = safeUrl(rawAnnotation.url);
        if (url) rows.push({title: nonEmptyText(rawAnnotation.title) ? rawAnnotation.title : url, url});
      }
    }
  }
  return {
    rows: [...new Map(rows.map((row) => [row.url, row])).values()].slice(0, 20),
    searchFailed,
  };
}

export function extractOutputText(result: unknown): string {
  if (!isRecord(result)) return '';
  const output = Array.isArray(result.output) ? result.output : [];
  const parts: string[] = [];
  for (const rawItem of output) {
    if (!isRecord(rawItem)) continue;
    const content = Array.isArray(rawItem.content) ? rawItem.content : [];
    for (const rawPart of content) {
      if (!isRecord(rawPart) || rawPart.type !== 'output_text' || !nonEmptyText(rawPart.text)) continue;
      parts.push(rawPart.text);
    }
  }
  return parts.join('\n').trim();
}

function hasUnsupportedOutput(result: JsonRecord): boolean {
  const output = Array.isArray(result.output) ? result.output : [];
  return output.some((rawItem) => isRecord(rawItem) && rawItem.type === 'function_call');
}

function historyInput(history: TranscriptFragment[]): {role: 'user' | 'assistant'; content: string}[] {
  return history
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && nonEmptyText(item.text))
    .slice(-80)
    .map((item) => ({role: item.role, content: item.text}));
}

export async function runBackendDelegation(options: BackendRunOptions): Promise<BackendRunResult> {
  if (!options.preferences.enabled) throw new ProtocolError(ErrorCode.BACKEND_NOT_CONFIGURED);
  const input = historyInput(options.history);
  if (!input.some((item) => item.role === 'user')) throw new ProtocolError(ErrorCode.BACKEND_NO_INPUT);
  const locale = options.locale ?? 'zh';
  const result = await requestJson(
    options.credential,
    options.preferences,
    responseRequest(options.credential, options.preferences, input, options.mode, locale),
    options.signal,
  );
  const {rows, searchFailed} = sourceRows(result);
  if (rows.length) options.onSources?.(rows);
  if (searchFailed) throw new ProtocolError(ErrorCode.BACKEND_WEB_SEARCH_FAILED);
  if (hasUnsupportedOutput(result)) throw new ProtocolError(ErrorCode.BACKEND_UNSUPPORTED_OUTPUT);
  const text = extractOutputText(result);
  if (!text) {
    if (result.status === 'incomplete') throw new ProtocolError(ErrorCode.BACKEND_INCOMPLETE);
    throw new ProtocolError(ErrorCode.BACKEND_EMPTY_OUTPUT);
  }
  return {text, usage: result.usage};
}

export async function probeBackend(
  credential: Credential,
  preferences: BackendPreferences,
  signal?: AbortSignal,
): Promise<void> {
  if (!preferences.enabled) throw new ProtocolError(ErrorCode.BACKEND_NOT_CONFIGURED);
  const result = await requestJson(credential, preferences, probeRequest(credential), signal);
  if (!extractOutputText(result)) throw new ProtocolError(ErrorCode.BACKEND_EMPTY_OUTPUT);
}

/** Optional post-save work. Failure keeps the local, date-based record title. */
export async function generateHistoryTitle(
  credential: Credential,
  history: TranscriptFragment[],
  locale: Locale,
  signal?: AbortSignal,
): Promise<string | null> {
  const body = buildTitleRequest(credential.model, history, locale);
  if (!body || signal?.aborted) return null;
  const preferences: BackendPreferences = {
    enabled: true, effort: 'default', maxOutputTokens: 1024, webSearch: false,
    timeoutSeconds: 20, instructions: '',
  };
  try {
    const result = await requestJson(credential, preferences, body, signal);
    return signal?.aborted ? null : parseGeneratedTitle(result);
  } catch {
    return null;
  }
}
