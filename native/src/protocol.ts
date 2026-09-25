import type {
  Auth,
  BackendPreferences,
  Locale,
  Mode,
  VoicePreferences,
} from './types';

/** Stable codes for UI translation. Provider response bodies are never exposed. */
export const ErrorCode = {
  CONFIG_INVALID: 'config_invalid',
  ENDPOINT_INVALID: 'endpoint_invalid',
  ENDPOINT_NOT_SECURE: 'endpoint_not_secure',
  SESSION_NOT_READY: 'session_not_ready',
  SESSION_ALREADY_ACTIVE: 'session_already_active',
  SESSION_DISPOSED: 'session_disposed',
  SESSION_CANCELLED: 'session_cancelled',
  VOICE_HTTP_400: 'voice_http_400',
  VOICE_HTTP_401: 'voice_http_401',
  VOICE_HTTP_403: 'voice_http_403',
  VOICE_HTTP_404: 'voice_http_404',
  VOICE_HTTP_408: 'voice_http_408',
  VOICE_HTTP_409: 'voice_http_409',
  VOICE_HTTP_429: 'voice_http_429',
  VOICE_HTTP_500: 'voice_http_500',
  VOICE_HTTP_502: 'voice_http_502',
  VOICE_HTTP_503: 'voice_http_503',
  VOICE_HTTP_504: 'voice_http_504',
  VOICE_HTTP_OTHER: 'voice_http_other',
  VOICE_NETWORK: 'voice_network',
  VOICE_TIMEOUT: 'voice_timeout',
  VOICE_INVALID_RESPONSE: 'voice_invalid_response',
  VOICE_ICE_TIMEOUT: 'voice_ice_timeout',
  VOICE_DATA_CHANNEL: 'voice_data_channel',
  VOICE_NOT_STARTED: 'voice_not_started',
  VOICE_CLOSED_UNCONFIRMED: 'voice_closed_unconfirmed',
  VOICE_CLOSE_TIMEOUT: 'voice_close_timeout',
  VOICE_PROBE_TIMEOUT: 'voice_probe_timeout',
  VOICE_PROBE_UNCONFIRMED: 'voice_probe_unconfirmed',
  SESSION_LIMIT_ELAPSED: 'session_limit_elapsed',
  BACKEND_NOT_CONFIGURED: 'backend_not_configured',
  BACKEND_HTTP_400: 'backend_http_400',
  BACKEND_HTTP_401: 'backend_http_401',
  BACKEND_HTTP_403: 'backend_http_403',
  BACKEND_HTTP_404: 'backend_http_404',
  BACKEND_HTTP_408: 'backend_http_408',
  BACKEND_HTTP_409: 'backend_http_409',
  BACKEND_HTTP_429: 'backend_http_429',
  BACKEND_HTTP_500: 'backend_http_500',
  BACKEND_HTTP_502: 'backend_http_502',
  BACKEND_HTTP_503: 'backend_http_503',
  BACKEND_HTTP_504: 'backend_http_504',
  BACKEND_HTTP_OTHER: 'backend_http_other',
  BACKEND_NETWORK: 'backend_network',
  BACKEND_TIMEOUT: 'backend_timeout',
  BACKEND_ABORTED: 'backend_aborted',
  BACKEND_INVALID_RESPONSE: 'backend_invalid_response',
  BACKEND_EMPTY_OUTPUT: 'backend_empty_output',
  BACKEND_INCOMPLETE: 'backend_incomplete',
  BACKEND_UNSUPPORTED_OUTPUT: 'backend_unsupported_output',
  BACKEND_WEB_SEARCH_FAILED: 'backend_web_search_failed',
  BACKEND_NO_INPUT: 'backend_no_input',
  STYLE_TOO_LONG: 'style_too_long',
  COMMAND_TIMEOUT: 'command_timeout',
  COMMAND_REJECTED: 'command_rejected',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export type HttpStatusCode =
  | 400
  | 401
  | 403
  | 404
  | 408
  | 409
  | 429
  | 500
  | 502
  | 503
  | 504
  | 0;

export const HttpStatus = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  REQUEST_TIMEOUT: 408,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
  OTHER: 0,
} as const;

export class ProtocolError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: HttpStatusCode;

  constructor(code: ErrorCodeValue, status: HttpStatusCode = 0) {
    super(code);
    this.name = 'ProtocolError';
    this.code = code;
    this.status = status;
  }
}

const HTTP_CODES: Record<number, HttpStatusCode> = {
  400: 400,
  401: 401,
  403: 403,
  404: 404,
  408: 408,
  409: 409,
  429: 429,
  500: 500,
  502: 502,
  503: 503,
  504: 504,
};

export function httpStatusCode(status: number): HttpStatusCode {
  return HTTP_CODES[status] ?? 0;
}

export function httpErrorCode(kind: 'voice' | 'backend', status: number): ErrorCodeValue {
  const suffix = HTTP_CODES[status];
  return `${kind}_http_${suffix || 'other'}` as ErrorCodeValue;
}

export function asProtocolError(
  error: unknown,
  fallback: ErrorCodeValue,
  timeoutCode?: ErrorCodeValue,
): ProtocolError {
  if (error instanceof ProtocolError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new ProtocolError(timeoutCode ?? fallback);
  }
  return new ProtocolError(fallback);
}

function parseHttpsEndpoint(endpoint: string): URL {
  if (!endpoint || endpoint.length > 2048) throw new ProtocolError(ErrorCode.ENDPOINT_INVALID);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ProtocolError(ErrorCode.ENDPOINT_INVALID);
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new ProtocolError(ErrorCode.ENDPOINT_INVALID);
  }
  if (url.protocol !== 'https:') throw new ProtocolError(ErrorCode.ENDPOINT_NOT_SECURE);
  return url;
}

function appendPath(url: URL, suffix: string): URL {
  let path = url.pathname.replace(/\/+$/, '');
  // Match PC probes when the Azure portal's resource root is pasted.
  if (url.hostname.endsWith('.openai.azure.com') && (path === '' || path === '/openai')) path = '/openai/v1';
  else if (url.hostname === 'api.openai.com' && path === '') path = '/v1';
  if (path.endsWith(suffix)) return url;
  return new URL(`${url.origin}${path}/${suffix.replace(/^\//, '')}`);
}

export function liveHttpUrl(endpoint: string): string {
  return appendPath(parseHttpsEndpoint(endpoint), '/live/sessions').toString();
}

export function responsesHttpUrl(endpoint: string): string {
  return appendPath(parseHttpsEndpoint(endpoint), '/responses').toString();
}

export function liveWebSocketUrl(endpoint: string): string {
  return liveHttpUrl(endpoint).replace(/^https:/, 'wss:');
}

export function authHeaders(auth: Auth, apiKey: string): Record<string, string> {
  if (!apiKey) throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  return auth === 'api-key'
    ? { 'Content-Type': 'application/json', 'api-key': apiKey }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
}

export function validateCredential(credential: {
  endpoint: string;
  model: string;
  auth: Auth;
  apiKey: string;
}): void {
  if (!credential || !credential.model || !credential.apiKey) {
    throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  }
  parseHttpsEndpoint(credential.endpoint);
}

export function newEventId(prefix: string): string {
  const cryptoValue = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoValue?.randomUUID) return `${prefix}_${cryptoValue.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function abortError(signal: AbortSignal | undefined, code: ErrorCodeValue): ProtocolError {
  return signal?.aborted ? new ProtocolError(ErrorCode.SESSION_CANCELLED) : new ProtocolError(code);
}

export function withTimeoutSignal(
  parent: AbortSignal | undefined,
  milliseconds: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), milliseconds);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

export function delayWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new ProtocolError(ErrorCode.SESSION_CANCELLED));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new ProtocolError(ErrorCode.SESSION_CANCELLED));
    };
    function done() {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const toneText: Record<VoicePreferences['tone'], { zh: string; en: string }> = {
  natural: { zh: '自然、像真实交流一样', en: 'natural and conversational' },
  warm: { zh: '温和、友善', en: 'warm and friendly' },
  relaxed: { zh: '放松、不紧张', en: 'relaxed and unhurried' },
  professional: { zh: '清晰、专业但不生硬', en: 'clear and professional without sounding stiff' },
};

const intonationText: Record<VoicePreferences['intonation'], { zh: string; en: string }> = {
  natural: { zh: '自然起伏', en: 'natural intonation' },
  steady: { zh: '平稳克制', en: 'steady intonation' },
  expressive: { zh: '更有表现力', en: 'expressive intonation' },
};

const paceText: Record<VoicePreferences['pace'], { zh: string; en: string }> = {
  normal: { zh: '正常速度', en: 'a normal pace' },
  slow: { zh: '稍慢、留出理解时间', en: 'a slightly slower pace with time to follow' },
  brisk: { zh: '利落但清楚', en: 'a brisk but clear pace' },
};

function languageLine(locale: Locale): string {
  return locale === 'zh'
    ? '跟随用户当前使用的语言交流；不要要求用户先选择固定对话语言。'
    : "Follow the language the user is currently using; do not require a fixed conversation-language setting.";
}

export function buildVoiceInstructions(
  _mode: Mode,
  locale: Locale,
  preferences: VoicePreferences,
): string {
  const language = locale === 'zh' ? 'zh' : 'en';
  const tone = toneText[preferences.tone][language];
  const intonation = intonationText[preferences.intonation][language];
  const pace = paceText[preferences.pace][language];
  const base =
    locale === 'zh'
      ? `你是一个自然、耐心的实时语音助手。用${tone}的方式交流，采用${intonation}和${pace}。用户插话时立即停止当前回答并听取用户；不要要求用户逐句按键。${languageLine(locale)}`
      : `You are a natural and patient live voice assistant. Speak in a ${tone} manner, with ${intonation} and ${pace}. When the user interrupts, stop the current answer and listen; do not require push-to-talk for every turn. ${languageLine(locale)}`;
  const modeText = locale === 'zh'
        ? '这是通用交流：直接回答并在需要时自然追问。'
        : 'This is a general conversation: answer directly and ask a natural follow-up when useful.';
  const extra = preferences.instructions.trim();
  const result = `${base} ${modeText}${extra ? ` ${extra}` : ''}`;
  if (Array.from(result).length > 800) throw new ProtocolError(ErrorCode.STYLE_TOO_LONG);
  return result;
}

/**
 * The Live protocol appends this as a new instruction block. Keep a
 * conservative codepoint budget here; the provider still performs the final
 * token-limit validation for the actual request.
 */
export const HOT_STYLE_MAX_CODEPOINTS = 480;

export function buildVoiceUpdateInstructions(
  _mode: Mode,
  locale: Locale,
  preferences: VoicePreferences,
): string {
  const language = locale === 'zh' ? 'zh' : 'en';
  const tone = toneText[preferences.tone][language];
  const intonation = intonationText[preferences.intonation][language];
  const pace = paceText[preferences.pace][language];
  const custom = preferences.instructions.trim();
  const override =
    locale === 'zh'
      ? '后续回复以以下偏好替换此前的说话风格和自定义要求，包括启动时的偏好；保留安全规则、语言跟随和可打断能力。'
      : 'Replace prior style/custom instructions, including startup preferences. Keep safety rules, follow the user’s language, and allow interruptions.';
  const details =
    locale === 'zh'
      ? `语气：${tone}；语调：${intonation}；语速：${pace}；${custom ? `自定义要求：${custom}` : '自定义要求：无（清除此前自定义要求）。'}`
      : `Tone: ${tone}; intonation: ${intonation}; pace: ${pace}; ${custom ? `Custom instruction: ${custom}` : 'Custom instruction: none (clear prior custom instructions).'}`;
  const result = `${override} ${details}`;
  if (Array.from(result).length > HOT_STYLE_MAX_CODEPOINTS) {
    throw new ProtocolError(ErrorCode.STYLE_TOO_LONG);
  }
  return result;
}

export function validateVoicePreferences(value: VoicePreferences): void {
  if (!value || typeof value !== 'object') throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  if (typeof value.voice !== 'string' || !value.voice.trim()) throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  if (!['natural', 'warm', 'relaxed', 'professional'].includes(value.tone)) {
    throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  }
  if (!['natural', 'steady', 'expressive'].includes(value.intonation)) {
    throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  }
  if (!['normal', 'slow', 'brisk'].includes(value.pace)) {
    throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  }
  const minutes = Number(value.minutes);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
    throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  }
  if (typeof value.instructions !== 'string') throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  try {
    buildVoiceInstructions('general', 'zh', value);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  }
}

export function validateBackendPreferences(value: BackendPreferences): void {
  if (!value || typeof value !== 'object') throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  if (typeof value.enabled !== 'boolean' || typeof value.webSearch !== 'boolean') {
    throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  }
  if (!['default', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.effort)) {
    throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  }
  if (!Number.isInteger(value.maxOutputTokens) || value.maxOutputTokens < 16 || value.maxOutputTokens > 32768) {
    throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  }
  if (!Number.isFinite(value.timeoutSeconds) || value.timeoutSeconds < 1 || value.timeoutSeconds > 300) {
    throw new ProtocolError(ErrorCode.CONFIG_INVALID);
  }
  if (typeof value.instructions !== 'string') throw new ProtocolError(ErrorCode.CONFIG_INVALID);
}

export function buildBackendInstructions(
  locale: Locale,
  _mode: Mode,
  preferences: BackendPreferences,
): string {
  const language =
    locale === 'zh'
      ? '用用户当前使用的语言回答，通常保持与用户相同；不要声称完成了没有证据的搜索。'
      : 'Answer in the language currently used by the user; usually match it. Never claim a search succeeded without evidence.';
  return `${language} ${preferences.instructions.trim()}`.trim();
}

export const STYLE_MAX_CODEPOINTS = 800;
