import { createDesktopLive } from './live.ts';
import { createAudioDeviceManager } from './audio-devices.mjs';
import { drawQr } from '../../pc-config/qr.mjs';
import { normalizeHistoryTitle } from '../../native/src/history-title.ts';

const root = document.querySelector('#app');
const audio = document.querySelector('#live-audio');
const bridge = window.liveVoice;
const mediaTheme = window.matchMedia('(prefers-color-scheme: dark)');

const DEFAULTS = {
  locale: 'zh',
  theme: 'system',
  mode: 'general',
  audio: {inputDeviceId: '', outputDeviceId: ''},
  voice: {
    voice: 'marin',
    tone: 'natural',
    intonation: 'natural',
    pace: 'normal',
    minutes: 10,
    instructions: '',
  },
  backend: {
    enabled: false,
    effort: 'low',
    maxOutputTokens: 32768,
    webSearch: true,
    timeoutSeconds: 60,
    instructions: '',
  },
};

const VOICES = ['marin', 'quartz', 'ripple', 'vesper', 'willow', 'stone', 'gleam', 'meridian', 'bossa', 'tempo', 'beacon', 'delta', 'cinder'];
const TONES = ['natural', 'warm', 'relaxed', 'professional'];
const INTONATIONS = ['natural', 'steady', 'expressive'];
const PACES = ['normal', 'slow', 'brisk'];
const SESSION_MINUTES = [0, 5, 10, 15, 30];
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
// Older records retain their mode value so they remain readable, but the
// current client has one conversation experience.
const RECORD_MODES = ['general', 'practice'];
const THEMES = ['system', 'light', 'dark'];
const LOCALES = ['zh', 'en'];
const MAX_STORED_TRANSCRIPT_FRAGMENTS = 500;
const MAX_DISPLAYED_TRANSCRIPT_FRAGMENTS = 24;
const ICONS = {
  conversation: '◌', history: '◷', settings: '⚙', phone: '⌁', home: '⌂', back: '←', chevron: '›', plus: '+', mic: '●', muted: '⊘', end: '■', captions: '▤', sources: '↗', check: '✓', warning: '!', close: '×', download: '↓', qr: '▦', lock: '◆', sun: '☼', moon: '◐', language: '文', play: '▶', pause: 'Ⅱ', refresh: '↻', arrow: '→', info: 'i', external: '↗',
};

const state = {
  booted: false,
  version: '',
  startupError: '',
  notice: '',
  noticeKind: 'info',
  page: 'conversation',
  settingsTab: 'preferences',
  selectedRecord: null,
  settings: clone(DEFAULTS),
  savedSettings: clone(DEFAULTS),
  connections: { voice: null, backend: null },
  connectionDrafts: { voice: emptyConnection('voice'), backend: emptyConnection('backend') },
  keyDrafts: { voice: '', backend: '' },
  connectionResults: { voice: '', backend: '' },
  connectionResultKinds: { voice: '', backend: '' },
  connectionBusy: { voice: false, backend: false },
  testPending: { voice: '', backend: '' },
  testSerial: { voice: 0, backend: 0 },
  voiceDraft: clone(DEFAULTS.voice),
  backendDraft: clone(DEFAULTS.backend),
  audioDraft: clone(DEFAULTS.audio),
  dirty: { voice: false, backend: false },
  actionBusy: '',
  qr: { kinds: ['voice'], passphrase: '', confirmation: '', payload: '', error: '', busy: false, revision: 0 },
  controller: null,
  controllerToken: null,
  closingHistoryPromise: null,
  session: { status: 'idle', mode: 'general', muted: false, startedAt: 0, fragments: [], backendStatus: 'idle', sources: [], sourcesExpanded: false },
  history: [],
  historyBusy: '',
  historyDialog: null,
  unsubscribeClosing: null,
};

let audioManager;
let audioView = {inputs:[],outputs:[],microphoneStatus:'idle',outputStatus:'idle',level:0,error:'',notice:''};
let audioViewSignature = '';
let outputListKnown = false;
const historyTitleWatchers = new Map();
function onAudioDevicesChanged(next) {
  audioView = next;
  const signature = JSON.stringify({...next,level:0});
  const meter = root.querySelector('.microphone-level');
  if(meter) meter.value = Math.min(1,Math.max(0,next.level||0));
  const selected = state.savedSettings.audio?.outputDeviceId;
  if(outputListKnown && isSessionActive() && selected && !next.outputs.some(item=>item.id===selected)) {
    showNotice('audio_output_unavailable');
    void closeSession();
  }
  if(next.outputs.length) outputListKnown = true;
  if(signature !== audioViewSignature) {
    audioViewSignature = signature;
    if(state.booted && state.page==='settings' && state.settingsTab==='audio') render();
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyConnection(kind) {
  return { endpoint: '', model: kind === 'voice' ? 'gpt-live-1' : '', auth: kind === 'voice' ? 'api-key' : 'bearer' };
}

function node(tag, className = '', text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function icon(name) {
  return node('span', `icon icon-${name}`, ICONS[name] || '•');
}

function setAttrs(element, attrs = {}) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') element.className = String(value);
    else if (key === 'text') element.textContent = String(value);
    else if (key === 'dataset' && value && typeof value === 'object') {
      for (const [dataKey, dataValue] of Object.entries(value)) element.dataset[dataKey] = String(dataValue);
    } else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden') element[key] = Boolean(value);
    else element.setAttribute(key, String(value));
  }
  return element;
}

function button(label, action, className = 'secondary', value) {
  const element = node('button', className, label);
  element.type = 'button';
  if (action) element.dataset.action = action;
  if (value !== undefined) element.dataset.value = String(value);
  return element;
}

function iconButton(name, label, action, value) {
  const element = button('', action, 'icon-button', value);
  element.append(icon(name));
  element.setAttribute('aria-label', label);
  return element;
}

function titleText(zh, en) {
  return state.settings.locale === 'en' ? en : zh;
}

function t(zh, en) {
  return state.settings.locale === 'en' ? en : zh;
}

function valid(value, values) {
  return values.includes(value) ? value : values[0];
}

function normalizeSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  const voice = source.voice && typeof source.voice === 'object' ? source.voice : {};
  const backend = source.backend && typeof source.backend === 'object' ? source.backend : {};
  const audioSettings = source.audio && typeof source.audio === 'object' ? source.audio : {};
  const deviceId = value => typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : '';
  return {
    locale: valid(source.locale, LOCALES),
    theme: valid(source.theme, THEMES),
    mode: 'general',
    audio: {inputDeviceId:deviceId(audioSettings.inputDeviceId),outputDeviceId:deviceId(audioSettings.outputDeviceId)},
    voice: {
      voice: typeof voice.voice === 'string' && voice.voice.trim() ? voice.voice : DEFAULTS.voice.voice,
      tone: valid(voice.tone, TONES),
      intonation: valid(voice.intonation, INTONATIONS),
      pace: valid(voice.pace, PACES),
      minutes: SESSION_MINUTES.includes(Number(voice.minutes)) ? Number(voice.minutes) : DEFAULTS.voice.minutes,
      instructions: typeof voice.instructions === 'string' ? voice.instructions.slice(0, 1500) : '',
    },
    backend: {
      enabled: Boolean(backend.enabled),
      effort: valid(backend.effort, EFFORTS),
      maxOutputTokens: Number.isInteger(backend.maxOutputTokens) && backend.maxOutputTokens >= 16 && backend.maxOutputTokens <= 32768 ? backend.maxOutputTokens : DEFAULTS.backend.maxOutputTokens,
      webSearch: typeof backend.webSearch === 'boolean' ? backend.webSearch : DEFAULTS.backend.webSearch,
      timeoutSeconds: Number.isInteger(backend.timeoutSeconds) && backend.timeoutSeconds >= 5 && backend.timeoutSeconds <= 300 ? backend.timeoutSeconds : DEFAULTS.backend.timeoutSeconds,
      instructions: typeof backend.instructions === 'string' ? backend.instructions.slice(0, 1500) : '',
    },
  };
}

function normalizeConnection(value, kind) {
  if (!value || typeof value !== 'object') return null;
  const auth = value.auth === 'bearer' || value.auth === 'api-key' ? value.auth : null;
  if (typeof value.endpoint !== 'string' || typeof value.model !== 'string' || !auth) return null;
  return { endpoint: value.endpoint, model: value.model, auth, keyMask: typeof value.keyMask === 'string' ? value.keyMask : t('已保存 key', 'Saved key') };
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(record => record && typeof record === 'object' && typeof record.id === 'string' && RECORD_MODES.includes(record.mode) && Number.isFinite(record.startedAt) && Number.isFinite(record.durationSeconds) && Array.isArray(record.fragments)).slice(0, 50).map(record => {
    const clean = {
      id: record.id,
      mode: record.mode,
      startedAt: record.startedAt,
      durationSeconds: record.durationSeconds,
      confirmedClose: Boolean(record.confirmedClose),
      fragments: record.fragments.filter(fragment => fragment && (fragment.role === 'user' || fragment.role === 'assistant') && typeof fragment.text === 'string').slice(0, 500).map(fragment => ({
        role: fragment.role,
        text: fragment.text.slice(0, 16000),
        startMs: Number.isFinite(fragment.startMs) ? fragment.startMs : 0,
        endMs: Number.isFinite(fragment.endMs) ? fragment.endMs : 0,
      })),
    };
    const title = normalizeHistoryTitle(record.title);
    if (title) {
      clean.title = title;
      if (record.titleSource === 'manual' || record.titleSource === 'auto') clean.titleSource = record.titleSource;
    }
    return clean;
  });
}

function applyTheme() {
  const theme = state.settings.theme === 'system' ? (mediaTheme.matches ? 'dark' : 'light') : state.settings.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.lang = state.settings.locale === 'en' ? 'en' : 'zh-CN';
}

function statusText(status) {
  return {
    idle: t('准备就绪', 'Ready'),
    connecting: t('正在连接', 'Connecting'),
    connected: t('语音已连接', 'Voice connected'),
    closing: t('正在结束', 'Closing'),
    closed: t('已结束', 'Closed'),
  }[status] || t('状态未知', 'Unknown status');
}

function statusDetail(status) {
  return {
    idle: t('点击开始，进入自然交流。', 'Start a conversation when you are ready.'),
    connecting: t('正在建立实时语音会话…', 'Opening the live voice session…'),
    connected: t('可以自然交流，也可以随时插话。', 'Speak naturally and interrupt whenever you need.'),
    closing: t('正在释放音频与会话资源…', 'Releasing audio and session resources…'),
    closed: t('会话已结束。', 'The session has ended.'),
  }[status] || '';
}

function errorText(code) {
  const messages = {
    bridge_unavailable: ['桌面桥接不可用，无法启动应用。', 'The desktop bridge is unavailable.'],
    bridge_failed: ['桌面服务没有完成请求。', 'The desktop service did not complete the request.'],
    not_configured: ['请先保存语音连接配置。', 'Save a voice connection first.'],
    backend_not_configured: ['请配置后端模型，或关闭后端模型。', 'Configure the backend or turn it off.'],
    key_required: ['请输入 key；更换地址或鉴权方式时需要替换 key。', 'Enter a key; changing the URL or auth method requires a replacement key.'],
    invalid_endpoint: ['请填写有效的 HTTPS 服务地址。', 'Enter a valid HTTPS service URL.'],
    invalid_model: ['请输入模型或部署名称。', 'Enter a model or deployment name.'],
    invalid_tokens: ['请输入 16–32768 之间的整数。', 'Enter an integer from 16 to 32768.'],
    invalid_title: ['名称不能为空，且最多 60 个字符。', 'The name cannot be empty and must be at most 60 characters.'],
    history_not_found: ['这条历史记录已不存在。', 'This history record no longer exists.'],
    active_session: ['请先结束当前会话。', 'End the current conversation first.'],
    session_limit_elapsed: ['新时长短于已进行的会话，请选择更长时长或不设上限。', 'The new limit is shorter than elapsed time. Choose a longer limit or no app limit.'],
    mic_permission: ['需要麦克风权限才能开始语音。', 'Microphone permission is required.'],
    app_inactive: ['请回到前台后重试。', 'Return to the app and try again.'],
    style_too_long: ['当前风格指令太长，请缩短后重试。', 'The style instruction is too long. Shorten it and retry.'],
    payload_too_large: ['配置太长，建议只选择一个连接生成二维码。', 'The configuration is too large. Generate a QR code for one connection.'],
    passphrase_short: ['口令至少需要 4 个字符。', 'The passphrase must be at least 4 characters.'],
    passphrase_mismatch: ['两次输入的口令不一致。', 'The passphrases do not match.'],
    save_failed: ['保存没有完成，请重试。', 'The save did not complete. Try again.'],
    invalid_key: ['请输入完整 API key，不要输入遮罩值。', 'Enter the complete API key, not a masked value.'],
    invalid_passphrase: ['导入口令至少 4 个字符，不能全为空白。', 'Use at least 4 characters, not only whitespace.'],
    config_invalid: ['配置不完整或参数无效，请检查设置。', 'Configuration is incomplete or invalid. Check settings.'],
    credential_missing: ['请先保存所选连接配置。', 'Save the selected connection first.'],
    encryption_unavailable: ['Windows 加密存储不可用，无法保存密钥。', 'Windows encrypted storage is unavailable; keys cannot be saved.'],
    storage_failed: ['无法读取或保存本机数据，请检查存储状态。', 'Local data could not be read or saved. Check storage availability.'],
    auth_failed: ['鉴权失败，请检查 API key 与鉴权方式。', 'Authentication failed. Check the API key and authentication method.'],
    access_denied: ['服务拒绝访问，请检查账号或模型权限。', 'Access denied. Check account and model permissions.'],
    model_unavailable: ['模型不可用，请检查模型或部署名称。', 'Model unavailable. Check the model or deployment name.'],
    endpoint_not_found: ['接口不存在，请检查服务基础地址。', 'Endpoint not found. Check the service base URL.'],
    request_rejected: ['服务不接受该请求，请检查配置及协议支持。', 'The service rejected the request. Check configuration and protocol support.'],
    rate_limited: ['请求受限，请检查配额后重试。', 'Rate or quota limit reached. Check quota and retry.'],
    service_unavailable: ['服务暂时不可用，请稍后重试。', 'Service unavailable. Please retry later.'],
    network_error: ['无法连接服务，请检查地址、网络和证书。', 'Could not connect. Check the address, network and certificate.'],
    timeout: ['请求超时，请检查网络或服务状态。', 'Request timed out. Check the network and service.'],
    cancelled: ['测试已取消。', 'Test cancelled.'],
    test_cancelled: ['测试已取消。', 'Test cancelled.'],
    test_busy: ['已有测试在进行，请稍后重试。', 'Other tests are running. Please retry shortly.'],
    test_in_progress: ['测试正在进行。', 'A test is already running.'],
    invalid_response: ['未收到有效协议响应，尚未验证通过。', 'No valid protocol response was received; the test has not passed.'],
    response_incomplete: ['模型响应未完成，尚未验证通过。', 'The model response was incomplete; the test has not passed.'],
    close_unconfirmed: ['已建立语音会话，但服务未确认关闭。', 'Voice session started, but closure was not confirmed.'],
    redirect_refused: ['服务要求重定向，请填写最终地址以避免转发密钥。', 'The service redirected. Enter the final endpoint to avoid forwarding the key.'],
    microphone_denied: ['麦克风未获授权，请检查 Windows 麦克风权限。', 'Microphone access was denied. Check Windows microphone permissions.'],
    voice_playback: ['无法播放语音，请检查系统输出设备。', 'Audio could not play. Check the system output device.'],
    audio_permission_denied: ['麦克风未获授权，请在 Windows 中允许桌面应用访问麦克风。', 'Microphone access was denied. Allow desktop apps to use the microphone in Windows.'],
    audio_input_unavailable: ['所选麦克风不可用，请重新选择或使用系统默认。', 'The selected microphone is unavailable. Select another device or the system default.'],
    audio_output_unavailable: ['所选输出设备不可用，请重新选择或使用系统默认。', 'The selected output device is unavailable. Select another device or the system default.'],
    audio_output_unsupported: ['当前环境不支持选择输出设备，请使用系统默认。', 'This environment cannot select an output device. Use the system default.'],
    audio_test_failed: ['音频测试未完成，请检查设备或权限。', 'Audio testing failed. Check the device and permissions.'],
    backend_token_limit: ['后端已用完输出 Token 预算（包含推理），未完成回答。请提高 Token 上限或降低推理强度，下次会话生效。', 'The backend exhausted its output token budget, including reasoning, before finishing. Increase the token limit or lower reasoning effort for the next conversation.'],
    backend_content_filter: ['后端响应被服务的内容过滤中止，未返回完整回答。', 'The service stopped the backend response through content filtering; no complete answer was returned.'],
  };
  const category = {voice_network:'network_error',backend_network:'network_error',voice_timeout:'timeout',backend_timeout:'timeout',voice_ice_timeout:'timeout',voice_close_timeout:'close_unconfirmed',voice_closed_unconfirmed:'close_unconfirmed',voice_invalid_response:'invalid_response',backend_invalid_response:'invalid_response',backend_incomplete:'response_incomplete',backend_empty_output:'invalid_response',session_cancelled:'cancelled',backend_aborted:'cancelled'};
  const httpStatus = /^(?:voice|backend)_http_(\d+)$/.exec(code)?.[1];
  if (httpStatus) code = {400:'request_rejected',401:'auth_failed',403:'access_denied',404:'endpoint_not_found',408:'timeout',429:'rate_limited',500:'service_unavailable',502:'service_unavailable',503:'service_unavailable',504:'service_unavailable'}[httpStatus] || code;
  code = category[code] || code;
  const pair = messages[code] || ['操作未完成，请检查配置和网络后重试。', 'The operation did not complete. Check configuration and network.'];
  return t(pair[0], pair[1]);
}

function fixedCode(error, fallback = 'bridge_failed') {
  return error instanceof Error && /^[a-z0-9_\-]+$/.test(error.message) ? error.message : fallback;
}

async function bridgeCall(method, args) {
  if (!bridge || typeof bridge[method] !== 'function') throw new Error('bridge_unavailable');
  let envelope;
  try {
    envelope = await bridge[method](args);
  } catch {
    throw new Error('bridge_failed');
  }
  if (!envelope || typeof envelope !== 'object') throw new Error('bridge_failed');
  if (envelope.ok !== true) throw new Error(typeof envelope.code === 'string' ? envelope.code : 'bridge_failed');
  return envelope.value;
}

function showNotice(codeOrText, kind = 'error') {
  state.notice = codeOrText && typeof codeOrText === 'string' && /^[a-z0-9_\-]+$/.test(codeOrText) ? errorText(codeOrText) : String(codeOrText || '');
  state.noticeKind = kind;
}

function clearNotice() {
  state.notice = '';
  state.noticeKind = 'info';
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat(state.settings.locale === 'en' ? 'en-GB' : 'zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(timestamp));
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(state.settings.locale === 'en' ? 'en-GB' : 'zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes ? t(`${minutes} 分钟`, `${minutes} min`) : t(`${rest} 秒`, `${rest} sec`);
}

function historyTitle(record) {
  return record?.title || `${t('对话', 'Conversation')} · ${formatDate(record?.startedAt ?? Date.now())}`;
}

function formatClock(startedAt) {
  if (!startedAt) return '00:00';
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function optionSelect(field, options, value, group, ariaLabel) {
  const select = node('select', 'field-input');
  select.setAttribute('aria-label', ariaLabel);
  select.dataset.draftGroup = group;
  select.dataset.field = field;
  for (const option of options) {
    const item = node('option', '', option.label);
    item.value = option.value;
    item.selected = String(option.value) === String(value);
    select.append(item);
  }
  return select;
}

function field(label, control, help = '') {
  const wrapper = node('label', 'field');
  wrapper.append(node('span', 'field-label', label), control);
  if (help) wrapper.append(node('span', 'field-help', help));
  return wrapper;
}

function textInput(value, group, fieldName, type = 'text', placeholder = '') {
  const input = node('input', 'field-input');
  input.type = type;
  input.value = value ?? '';
  input.placeholder = placeholder;
  input.autocomplete = type === 'password' ? 'new-password' : 'off';
  input.autocapitalize = 'none';
  input.spellcheck = false;
  input.dataset.draftGroup = group;
  input.dataset.field = fieldName;
  return input;
}

function textArea(value, group, fieldName, placeholder = '') {
  const textarea = node('textarea', 'field-input');
  textarea.rows = 4;
  textarea.value = value ?? '';
  textarea.placeholder = placeholder;
  textarea.maxLength = 1500;
  textarea.dataset.draftGroup = group;
  textarea.dataset.field = fieldName;
  return textarea;
}

function sectionHeading(title, description = '') {
  const heading = node('div', 'section-heading');
  const text = node('div', 'section-heading-copy');
  text.append(node('h2', '', title));
  if (description) text.append(node('p', 'muted', description));
  heading.append(text);
  return heading;
}

function settingCard(title, description = '') {
  const card = node('section', 'settings-card');
  card.append(sectionHeading(title, description));
  return card;
}

function statusBadge(status, label = statusText(status)) {
  const badge = node('span', `status-badge status-${status}`);
  badge.append(node('span', 'status-dot'), node('span', '', label));
  return badge;
}

function noticeElement() {
  if (!state.notice) return null;
  const notice = node('div', `notice notice-${state.noticeKind}`);
  notice.setAttribute('role', state.noticeKind === 'error' ? 'alert' : 'status');
  notice.append(icon(state.noticeKind === 'error' ? 'warning' : 'info'), node('span', '', state.notice));
  const close = iconButton('close', t('关闭提示', 'Dismiss notice'), 'dismiss-notice');
  notice.append(close);
  return notice;
}

function pageTitle(kicker, title, description = '') {
  const heading = node('header', 'page-header');
  const copy = node('div', 'page-header-copy');
  copy.append(node('p', 'eyebrow', kicker), node('h1', '', title));
  if (description) copy.append(node('p', 'page-description', description));
  heading.append(copy);
  return heading;
}

function buildSidebar() {
  const aside = node('aside', 'sidebar');
  const brand = button('', 'go-page', 'brand-button', 'conversation');
  const logo = node('img', 'brand-logo');
  logo.src = './logo.png';
  logo.alt = 'Live Voice';
  brand.append(logo, node('span', 'brand-name', 'Live Voice'), node('span', 'brand-caption', t('GPT-Live-1 语音客户端', 'GPT-Live-1 voice client')));
  aside.append(brand);

  const navigation = node('nav', 'side-nav');
  navigation.setAttribute('aria-label', t('主导航', 'Main navigation'));
  const pages = [
    ['conversation', 'conversation', t('对话', 'Conversation')],
    ['history', 'history', t('历史记录', 'History')],
    ['settings', 'settings', t('设置', 'Settings')],
  ];
  for (const [page, iconName, label] of pages) {
    const item = button('', 'go-page', 'nav-item', page);
    item.append(icon(iconName), node('span', '', label));
    if (state.page === page || (state.page === 'history-detail' && page === 'history')) item.setAttribute('aria-current', 'page');
    navigation.append(item);
  }
  aside.append(navigation);

  const footer = node('div', 'sidebar-footer');
  footer.append(node('p', 'prototype-label', t('桌面版 · 本地数据', 'Windows · local data')));
  const footerRow = node('div', 'sidebar-footer-row');
  const localeButton = button(state.settings.locale === 'zh' ? '中文' : 'English', 'toggle-locale', 'footer-button');
  localeButton.setAttribute('aria-label', t('切换英文', 'Switch to Chinese'));
  footerRow.append(localeButton, statusBadge(state.booted ? 'ready' : 'connecting', state.booted ? t('本地就绪', 'Local ready') : t('启动中', 'Starting')));
  footer.append(footerRow);
  aside.append(footer);
  return aside;
}

function buildMain() {
  const main = node('main', 'main-area');
  const scroll = node('div', 'main-scroll');
  if (!state.booted) {
    const loading = node('section', 'startup-panel');
    loading.append(node('div', 'startup-mark', state.startupError ? '!' : '◎'), node('h1', '', state.startupError ? t('桌面服务无法启动', 'Desktop service could not start') : t('正在准备本地工作区…', 'Preparing the local workspace…')));
    if (state.startupError) loading.append(node('p', 'error-copy', state.startupError));
    else loading.append(node('p', 'muted', t('正在读取本地设置和历史记录。', 'Loading local settings and history.')));
    if (state.startupError) loading.append(button(t('重新尝试', 'Try again'), 'retry-boot', 'primary'));
    scroll.append(loading);
  } else if (state.page === 'conversation') scroll.append(buildConversation());
  else if (state.page === 'history') scroll.append(buildHistory());
  else if (state.page === 'history-detail') scroll.append(buildHistoryDetail());
  else if (state.page === 'settings') scroll.append(buildSettings());
  main.append(scroll);
  const historyDialog = buildHistoryDialog();
  if (historyDialog) main.append(historyDialog);
  return main;
}

function buildConversation() {
  const page = node('section', 'view view-conversation');
  page.append(pageTitle(t('实时语音', 'LIVE VOICE'), t('对话', 'Conversation'), t('面向 GPT-Live-1 模型的实时语音客户端，可搭配独立后端 LLM。', 'A real-time voice client for GPT-Live-1, with an optional separate backend LLM.')));
  const topMeta = node('div', 'page-header-meta');
  topMeta.append(statusBadge(state.session.status), node('span', 'connection-meta', connectionSummary()));
  page.querySelector('.page-header').append(topMeta);

  if (isSessionActive()) page.append(buildSessionCard());
  else page.append(buildWelcomeCard());
  const notice = noticeElement();
  if (notice) page.append(notice);
  return page;
}

function connectionSummary() {
  if (!state.connections.voice) return t('尚未配置语音连接', 'Voice connection not configured');
  const name = state.connections.voice.model || 'gpt-live-1';
  return `${t('语音', 'Voice')} · ${name}`;
}

function buildWelcomeCard() {
  const card = node('section', 'welcome-card');
  const copy = node('div', 'welcome-copy');
  copy.append(node('p', 'eyebrow', t('自然交流', 'SPEAK NATURALLY')), node('h2', '', t('想聊什么？\n自然交流。', 'What is on your mind?\nSpeak naturally.')));
  copy.append(node('p', 'muted', t('从一句话开始，换话题、请求解释，或者随时插话。', 'Start with one sentence. Change topics, ask for an explanation, or interrupt at any time.')));
  const orb = node('div', 'voice-orb orb-idle');
  orb.append(node('div', 'orb-halo'), node('div', 'orb-core', ICONS.mic));
  const configured = Boolean(state.connections.voice);
  const start = button('', configured ? 'start-session' : 'open-connections', 'primary start-button');
  start.append(icon(configured ? 'play' : 'settings'), node('span', '', configured ? t('开始对话', 'Start conversation') : t('配置语音服务', 'Configure voice service')));
  start.disabled = Boolean(state.actionBusy);
  card.append(copy, orb, start);

  const summary = node('div', 'welcome-summary');
  const voice = node('div', 'summary-item');
  voice.append(node('span', 'summary-label', t('语音连接', 'Voice connection')), node('strong', '', state.connections.voice ? `${t('已配置', 'Configured')} · ${state.connections.voice.model}` : t('需要配置', 'Needs setup')));
  const backend = node('div', 'summary-item');
  backend.append(node('span', 'summary-label', t('后端模型', 'Backend model')), node('strong', '', state.settings.backend.enabled && state.connections.backend ? t('已启用', 'Enabled') : t('未启用', 'Off')));
  summary.append(voice, backend);
  card.append(summary);
  return card;
}

function isSessionActive() {
  return Boolean(state.controller && ['connecting', 'connected', 'closing'].includes(state.session.status));
}

function buildSessionCard() {
  const card = node('section', 'session-card');
  const meta = node('div', 'session-meta');
  meta.append(node('span', 'badge', t('对话', 'Conversation')), node('span', 'session-timer', formatClock(state.session.startedAt)), statusBadge(state.session.status));
  card.append(meta);
  const orb = node('div', `voice-orb orb-${state.session.status}`);
  orb.append(node('div', 'orb-halo'), node('div', 'orb-core', state.session.status === 'connected' ? ICONS.mic : '…'));
  card.append(orb);
  const stateCopy = node('div', 'session-state');
  stateCopy.append(node('h2', '', statusText(state.session.status)), node('p', 'muted', statusDetail(state.session.status)));
  card.append(stateCopy);
  const backendStatus = state.session.backendStatus;
  if(state.savedSettings.backend.enabled || backendStatus !== 'idle') {
    const progress = node('div',`backend-progress backend-progress-${backendStatus}`);
    progress.setAttribute('role','status');
    const labels = {idle:t('后端待命','Backend ready'),working:t('后端处理中','Backend processing'),done:t('后端已返回','Backend returned'),error:t('后端请求失败','Backend request failed')};
    progress.append(node('strong','',labels[backendStatus]||labels.idle));
    if(backendStatus==='working') {
      progress.append(node('span','backend-progress-timer',t('已等待 ','Waiting ')+formatClock(state.session.backendStartedAt)));
      progress.append(node('span','',t('你仍可以讲话或打断。','You can still speak or interrupt.')));
    } else if(backendStatus==='error') progress.append(node('span','',t('本次请求已结束，请查看下方原因。','This request has ended. See the reason below.')));
    card.append(progress);
  }

  const controls = node('div', 'session-controls');
  const mute = button('', 'toggle-mute', 'secondary');
  mute.setAttribute('aria-pressed', String(state.session.muted));
  mute.append(icon(state.session.muted ? 'muted' : 'mic'), node('span', '', state.session.muted ? t('取消静音', 'Unmute') : t('静音', 'Mute')));
  const end = button('', 'close-session', 'danger-button');
  end.disabled = state.session.status === 'closing';
  end.append(icon('end'), node('span', '', t('结束对话', 'End conversation')));
  controls.append(mute, end);
  card.append(controls);

  if (state.session.status === 'connected') card.append(button(t('对话设置', 'Conversation settings'), 'open-preferences', 'text-button'));

  {
    const transcript = node('div', 'transcript-panel');
    transcript.append(node('div', 'panel-heading', t('实时字幕', 'Live captions')));
    if (state.session.fragments.length === 0) transcript.append(node('p', 'empty-copy', t('等待第一句对话…', 'Waiting for the first turn…')));
    else {
      for (const fragment of state.session.fragments.slice(-MAX_DISPLAYED_TRANSCRIPT_FRAGMENTS)) {
        const turn = node('article', `turn ${fragment.role === 'user' ? 'turn-user' : 'turn-assistant'}`);
        turn.append(node('span', 'turn-label', fragment.role === 'user' ? t('你', 'You') : t('助手', 'Assistant')), node('p', '', fragment.text));
        transcript.append(turn);
      }
    }
    card.append(transcript);
  }
  if (state.session.sources.length) {
    const sources = node('div', 'sources-panel');
    const expanded = Boolean(state.session.sourcesExpanded);
    const toggle = button(`${t('搜索来源', 'Search sources')} (${state.session.sources.length}) · ${expanded ? t('收起来源 ▴', 'Collapse sources ▴') : t('展开来源 ▾', 'Expand sources ▾')}`, 'toggle-sources', 'sources-toggle');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-controls', 'search-sources-list');
    sources.append(toggle);
    if (expanded) {
      const list = node('div', 'sources-list'); list.id = 'search-sources-list';
      for (const source of state.session.sources) {
        const row = node('div', 'source-row');
        row.append(icon('sources'), node('span', '', source.title || source.url || ''));
        list.append(row);
      }
      sources.append(list);
    }
    card.append(sources);
  }
  return card;
}

function buildHistory() {
  const page = node('section', 'view view-history');
  page.append(pageTitle(t('本机记录', 'LOCAL RECORDS'), t('历史记录', 'History'), t('可改名或删除；保存后会尝试由已配置后端生成标题，只发送简短文字摘录并产生少量用量，失败时使用日期标题。', 'Rename or delete records. After saving, the configured backend may create a title from a short text excerpt, using a small amount of usage; the date is used if it fails.')));
  // Records created by older builds may still carry mode: practice. Keep and
  // display them together with new records; the removed mode is not a history
  // partition anymore.
  const records = state.history;
  const list = node('div', 'history-list');
  if (!records.length) {
    const empty = node('div', 'empty-state');
    empty.append(node('div', 'empty-icon', '◌'), node('h2', '', t('还没有记录', 'No records yet')), node('p', 'muted', t('结束一次对话后，文字记录会出现在这里。', 'Finished conversations appear here as local text records.')));
    list.append(empty);
  } else {
    let currentDate = '';
    for (const record of records) {
      const date = formatDate(record.startedAt);
      if (date !== currentDate) { list.append(node('h2', 'history-date', date)); currentDate = date; }
      const row = button('', 'open-history', 'history-row', record.id);
      const copy = node('span', 'history-row-copy');
      copy.append(node('span', 'history-row-title', historyTitle(record)));
      copy.append(node('span', 'history-row-preview', record.fragments[0]?.text || t('无文字内容', 'No text content')));
      copy.append(node('span', 'history-row-meta', `${formatDuration(record.durationSeconds)} · ${record.confirmedClose ? t('已正常结束', 'Closed normally') : t('结束未确认', 'Closure unconfirmed')}`));
      row.append(copy, icon('chevron'));
      list.append(row);
    }
  }
  page.append(list);
  const notice = noticeElement();
  if (notice) page.append(notice);
  return page;
}

function buildHistoryDetail() {
  const record = state.selectedRecord;
  const page = node('section', 'view view-history-detail');
  const header = node('div', 'detail-header');
  header.append(iconButton('back', t('返回历史记录', 'Back to history'), 'go-page', 'history'));
  const copy = node('div', 'detail-title');
  copy.append(node('p', 'eyebrow', t('历史记录', 'HISTORY RECORD')), node('h1', '', record ? historyTitle(record) : t('记录不可用', 'Record unavailable')));
  header.append(copy);
  page.append(header);
  if (!record) {
    page.append(node('p', 'muted', t('这条记录已不存在或无法读取。', 'This record is unavailable.')), button(t('返回历史', 'Back to history'), 'go-page', 'history'));
    return page;
  }
  const actions = node('div', 'history-detail-actions');
  actions.append(
    button(t('改名', 'Rename'), 'rename-history', 'secondary', record.id),
    button(t('删除', 'Delete'), 'delete-history', 'danger-button', record.id),
  );
  page.append(actions);
  const meta = node('div', 'detail-meta');
  meta.append(node('span', 'badge', t('对话', 'Conversation')), node('span', 'muted', `${formatDate(record.startedAt)} · ${formatDuration(record.durationSeconds)}`), node('span', record.confirmedClose ? 'close-status confirmed' : 'close-status', record.confirmedClose ? t('结束已确认', 'Closure confirmed') : t('结束未确认', 'Closure unconfirmed')));
  page.append(meta);
  const transcript = node('div', 'detail-transcript');
  for (const fragment of record.fragments) {
    const turn = node('article', `turn ${fragment.role === 'user' ? 'turn-user' : 'turn-assistant'}`);
    turn.append(node('span', 'turn-label', fragment.role === 'user' ? t('你', 'You') : t('助手', 'Assistant')), node('p', '', fragment.text));
    transcript.append(turn);
  }
  if (!record.fragments.length) transcript.append(node('p', 'muted', t('没有可显示的文字内容。', 'There is no text content to show.')));
  page.append(transcript);
  page.append(node('p', 'detail-note', t('这份记录不会继续当前上下文，也不会恢复为新的会话。删除前会再次确认；如有关联音频也会一并删除。', 'This record cannot continue or restore a conversation. Deletion asks for confirmation; any associated audio is removed with it.')));
  return page;
}

function buildHistoryDialog() {
  const dialog = state.historyDialog;
  if (!dialog) return null;
  const backdrop = node('div', 'history-dialog-backdrop');
  backdrop.setAttribute('role', 'presentation');
  const panel = node('section', 'history-dialog');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  const title = dialog.kind === 'rename'
    ? t('重命名会话', 'Rename conversation')
    : t('确认删除会话', 'Confirm deletion');
  panel.append(node('h2', '', title));
  if (dialog.kind === 'rename') {
    panel.append(node('p', 'muted', t('名称只保存在本机，最多 60 个字符。', 'The name is stored locally and can be up to 60 characters.')));
    const input = node('input', 'field-input');
    input.type = 'text';
    input.value = dialog.title || '';
    // HTML maxLength counts UTF-16 code units; allow two per code point and
    // let the shared normalizer enforce the actual 60-code-point limit.
    input.maxLength = 120;
    input.autocomplete = 'off';
    input.dataset.historyDialogField = 'title';
    input.setAttribute('aria-label', t('会话名称', 'Conversation name'));
    panel.append(input);
    if (dialog.error) panel.append(node('p', 'error-copy', dialog.error));
    const actions = node('div', 'history-dialog-actions');
    actions.append(
      button(t('取消', 'Cancel'), 'close-history-dialog', 'secondary'),
      button(t('保存', 'Save'), 'confirm-rename-history', 'primary'),
    );
    panel.append(actions);
  } else {
    panel.append(
      node('p', 'dialog-copy', t(`将删除“${dialog.title}”。此操作无法恢复，关联音频（如有）也会一并删除。`, `“${dialog.title}” will be deleted. This cannot be undone; any associated audio will also be deleted.`)),
    );
    const actions = node('div', 'history-dialog-actions');
    actions.append(
      button(t('取消', 'Cancel'), 'close-history-dialog', 'secondary'),
      button(t('确认删除', 'Delete'), 'confirm-delete-history', 'danger-button'),
    );
    panel.append(actions);
  }
  backdrop.append(panel);
  return backdrop;
}

function settingsSubnav() {
  const nav = node('div', 'settings-tabs');
  const tabs = [
    ['preferences', t('对话设置', 'Conversation settings')],
    ['connections', t('连接管理', 'Connections')],
    ['audio', t('音频设备', 'Audio devices')],
    ['interface', t('外观与语言', 'Appearance & language')],
    ['about', t('关于', 'About')],
  ];
  for (const [value, label] of tabs) {
    const item = button(label, 'settings-tab', (value === state.settingsTab || (value === 'connections' && state.settingsTab === 'phone')) ? 'settings-tab-button selected' : 'settings-tab-button', value);
    item.setAttribute('aria-pressed', String(value === state.settingsTab || (value === 'connections' && state.settingsTab === 'phone')));
    nav.append(item);
  }
  return nav;
}

function buildSettings() {
  const page = node('section', 'view view-settings');
  page.append(pageTitle(t('本地偏好', 'LOCAL PREFERENCES'), t('设置', 'Settings'), t('对话偏好与连接配置分开管理。', 'Manage conversation preferences separately from connections.')));
  page.append(settingsSubnav());
  if (isSessionActive()) page.append(button(t('返回当前对话', 'Return to conversation'), 'go-page', 'secondary', 'conversation'));
  if (state.settingsTab === 'preferences') page.append(buildPreferenceSettings());
  else if (state.settingsTab === 'connections') page.append(buildConnectionSettings());
  else if (state.settingsTab === 'interface') page.append(buildInterfaceSettings());
  else if (state.settingsTab === 'audio') page.append(buildAudioSettings());
  else if (state.settingsTab === 'about') page.append(buildAbout());
  else page.append(buildPhoneLinking());
  const notice = noticeElement();
  if (notice) page.append(notice);
  return page;
}

function buildAbout() {
  const card = settingCard('Live Voice', t('关于此应用', 'About this app'));
  card.append(node('p', 'field-hint', t('专为 GPT-Live-1 实时语音模型使用。可连接独立的后端 LLM 提供推理与联网搜索。', 'Built for the GPT-Live-1 real-time voice model. Connect a separate backend LLM for reasoning and web search.')));
  const details = node('dl', 'about-details');
  for (const [label, value] of [
    [t('版本号', 'Version'), state.version || '—'],
    [t('作者', 'Author'), 'kylefu8'],
    [t('GitHub 仓库', 'GitHub repository'), 'https://github.com/kylefu8/live-voice-app'],
  ]) details.append(node('dt', '', label), node('dd', '', value));
  card.append(details);
  return card;
}

function buildAudioSettings() {
  const fragment = document.createDocumentFragment();
  const card = settingCard(t('语音输入与输出', 'Voice input and output'), t('选择设备后保存，下次对话将使用这些设备。系统默认会跟随 Windows 的设置。', 'Save your selections for the next conversation. System default follows Windows settings.'));
  const deviceOptions = (items, selected, isInput) => {
    const options = [{value:'',label:t('系统默认','System default')}];
    items.forEach((item,index)=>options.push({value:item.id,label:item.label||t(`${isInput?'麦克风':'扬声器'} ${index+1}`,`${isInput?'Microphone':'Speaker'} ${index+1}`)}));
    if(selected&&!items.some(item=>item.id===selected)) options.push({value:selected,label:t('已选设备未检测到（请刷新或重新选择）','Selected device not detected (refresh or select another)')});
    return options;
  };
  const inputs=audioView.inputs.filter(item=>item.id&&item.id!=='default'&&item.id!=='communications');
  const outputs=audioView.outputs.filter(item=>item.id&&item.id!=='default'&&item.id!=='communications');
  card.append(field(t('麦克风 · 输入','Microphone · input'),optionSelect('inputDeviceId',deviceOptions(inputs,state.audioDraft.inputDeviceId,true),state.audioDraft.inputDeviceId,'audio',t('麦克风 · 输入','Microphone · input'))));
  const micRow=node('div','audio-test-row');
  const micActive=audioView.microphoneStatus!=='idle';
  const micButton=button(micActive?t('停止麦克风测试','Stop microphone test'):t('测试麦克风','Test microphone'),'audio-mic','secondary');
  micButton.disabled=isSessionActive();
  const meter=node('meter','microphone-level'); meter.min=0;meter.max=1;meter.value=audioView.level||0;meter.setAttribute('aria-label',t('麦克风实时音量','Live microphone level'));
  micRow.append(micButton,meter);
  card.append(micRow,node('p','field-hint',micActive?t('请说话，观察音量条；15 秒后自动停止。','Speak and watch the level meter; testing stops after 15 seconds.'):t('只显示实时音量，不录制、保存或上传声音。','Shows the live level only. Audio is not recorded, saved or uploaded.')));
  card.append(field(t('扬声器 / 耳机 · 输出','Speaker / headphones · output'),optionSelect('outputDeviceId',deviceOptions(outputs,state.audioDraft.outputDeviceId,false),state.audioDraft.outputDeviceId,'audio',t('扬声器 / 耳机 · 输出','Speaker / headphones · output'))));
  const outputRow=node('div','audio-test-row');
  const outputButton=button(audioView.outputStatus==='testing'?t('停止提示音','Stop test tone'):t('播放测试提示音','Play test tone'),'audio-output','secondary');
  outputButton.disabled=isSessionActive(); outputRow.append(outputButton);
  card.append(outputRow,node('p','field-hint',t('播放约一秒的轻柔提示音，请确认所选设备能听到声音。','Plays a short, quiet tone. Confirm that you hear it on the selected device.')));
  const actions=node('div','form-actions');
  const refresh=button(t('刷新设备 / 授权麦克风','Refresh devices / allow microphone'),'audio-refresh','secondary');refresh.disabled=isSessionActive();
  const save=button(t('保存音频设备','Save audio devices'),'save-audio','primary');save.disabled=state.actionBusy==='save-audio';
  actions.append(refresh,save);card.append(actions);
  const dirty=JSON.stringify(state.audioDraft)!==JSON.stringify(state.savedSettings.audio);
  card.append(node('p','field-hint',dirty?t('有未保存修改','Unsaved changes'):t('设备选择已保存','Device selection saved')));
  if(isSessionActive()) {
    card.querySelectorAll('input,select,button').forEach(control=>{control.disabled=true;});
    card.append(node('p','field-hint',t('音频设备在会话结束后可修改和测试。','Audio devices can be changed and tested after the conversation ends.')));
  }
  if(audioView.error)card.append(node('p','notice notice-error',errorText(audioView.error)));
  else if(audioView.notice)card.append(node('p','field-hint',audioView.notice==='output_done'?t('提示音播放已结束，请确认是否听到。','The tone has finished. Please confirm whether you heard it.'):t('麦克风测试已结束。','Microphone test finished.')));
  fragment.append(card);
  return fragment;
}

async function runAudioAction(action) {
  if(!audioManager||isSessionActive())return;
  try {
    if(action==='audio-refresh')await audioManager.refresh({requestPermission:true});
    else if(action==='audio-mic') {
      if(audioView.microphoneStatus!=='idle')audioManager.stopMicrophoneTest();
      else await audioManager.startMicrophoneTest(state.audioDraft.inputDeviceId);
    } else if(action==='audio-output') {
      if(audioView.outputStatus==='testing')audioManager.stopOutputTest();
      else await audioManager.testOutput(state.audioDraft.outputDeviceId);
    }
  }catch(error){showNotice(errorText(fixedCode(error)));render();}
}

async function saveAudioSettings() {
  if(isSessionActive()) return;
  audioManager?.stopTests(); state.actionBusy='save-audio'; clearNotice();render();
  try {
    const settings=normalizeSettings(await bridgeCall('saveSettings',{settings:{...state.savedSettings,audio:clone(state.audioDraft)}}));
    state.settings=settings;state.savedSettings=clone(settings);state.audioDraft=clone(settings.audio);
    showNotice(t('音频设备已保存，下次对话生效。','Audio devices saved for the next conversation.'),'success');
  }catch(error){showNotice(errorText(fixedCode(error)));}
  finally{state.actionBusy='';render();}
}

function buildInterfaceSettings() {
  const fragment = document.createDocumentFragment();
  const global = settingCard(t('界面', 'Interface'), t('这些选择会立即保存，不会覆盖下面未保存的参数草稿。', 'These choices save immediately and do not overwrite unsaved parameter drafts below.'));
  const localeRow = node('div', 'choice-row');
  localeRow.append(node('div', 'choice-copy', t('语言', 'Language')));
  const locales = node('div', 'choice-group');
  for (const locale of LOCALES) {
    const item = button(locale === 'zh' ? '中文' : 'English', 'set-locale', locale === state.settings.locale ? 'choice-button selected' : 'choice-button', locale);
    item.setAttribute('aria-pressed', String(locale === state.settings.locale));
    locales.append(item);
  }
  localeRow.append(locales);
  const themeRow = node('div', 'choice-row');
  themeRow.append(node('div', 'choice-copy', t('主题', 'Theme')));
  const themes = node('div', 'choice-group');
  const themeLabels = { system: t('跟随系统', 'System'), light: t('浅色', 'Light'), dark: t('深色', 'Dark') };
  for (const theme of THEMES) {
    const item = button(themeLabels[theme], 'set-theme', theme === state.settings.theme ? 'choice-button selected' : 'choice-button', theme);
    item.setAttribute('aria-pressed', String(theme === state.settings.theme));
    themes.append(item);
  }
  themeRow.append(themes);
  global.append(localeRow, themeRow);
  fragment.append(global);
  return fragment;
}

function buildPreferenceSettings() {
  const fragment = document.createDocumentFragment();
  const voiceCard = settingCard(t('对话设置', 'Conversation settings'), t('音色、交流风格和单次会话总时长（包含静默）。语言跟随用户，不单独锁定。', 'Voice, conversation style and total connected session time, including silence. Language follows the user.'));
  const voiceFields = node('div', 'form-grid');
  voiceFields.append(field(t('音色', 'Voice'), optionSelect('voice', VOICES.map(value => ({ value, label: value })), state.voiceDraft.voice, 'voice', t('音色', 'Voice'))));
  voiceFields.append(field(t('语气', 'Tone'), optionSelect('tone', TONES.map(value => ({ value, label: tTone(value) })), state.voiceDraft.tone, 'voice', t('语气', 'Tone'))));
  voiceFields.append(field(t('语调', 'Intonation'), optionSelect('intonation', INTONATIONS.map(value => ({ value, label: tIntonation(value) })), state.voiceDraft.intonation, 'voice', t('语调', 'Intonation'))));
  voiceFields.append(field(t('节奏', 'Pace'), optionSelect('pace', PACES.map(value => ({ value, label: tPace(value) })), state.voiceDraft.pace, 'voice', t('节奏', 'Pace'))));
  voiceFields.append(field(t('单次会话总时长（含静默）', 'Total session time (including silence)'), optionSelect('minutes', SESSION_MINUTES.map(value => ({ value, label: value === 0 ? t('不设应用上限', 'No app limit') : t(`${value} 分钟`, `${value} minutes`) })), state.voiceDraft.minutes, 'voice', t('单次会话总时长（含静默）', 'Total session time including silence'))));
  const instructions = textArea(state.voiceDraft.instructions, 'voice', 'instructions', t('例如：耐心一点，每次只追问一个问题。', 'For example: stay patient and ask one question at a time.'));
  const voiceChoice = voiceFields.querySelector('[data-field="voice"]');
  voiceChoice.disabled = isSessionActive();
  if (isSessionActive()) voiceFields.append(node('p','field-hint',t('音色在会话结束后可修改。','Voice can be changed after the conversation ends.')));
  voiceCard.append(voiceFields, field(t('自定义指令', 'Custom instructions'), instructions, t('不要输入 API key。', 'Do not enter an API key.')));
  const voiceActions = node('div', 'form-actions');
  const saveVoice = button(state.session.status === 'connected' ? t('保存并应用到当前会话', 'Save and apply to this session') : t('保存语音参数', 'Save voice settings'), 'save-voice', 'primary');
  saveVoice.disabled = Boolean(state.actionBusy) || (isSessionActive() && state.session.status !== 'connected');
  voiceActions.append(saveVoice, node('span', 'draft-status', state.dirty.voice ? t('有未保存修改', 'Unsaved changes') : t('已保存', 'Saved')));
  voiceCard.append(node('p', 'field-hint', t('保存后更新当前会话的语气、语调、节奏、指令与时长；音色从下一次会话生效。', 'Saving updates this session’s tone, intonation, pace, instructions and time limit. Voice changes apply next session.')));
  voiceCard.append(voiceActions);
  fragment.append(voiceCard);

  const backendCard = settingCard(t('后端推理参数', 'Backend reasoning'), t('可选的推理、搜索与超时偏好；实际能力取决于后端服务。', 'Optional reasoning, search and timeout preferences; support depends on the backend service.'));
  backendCard.append(node('p', 'field-hint', t('对话记忆最多携带 500 段文字，发送内容上限 256 KiB。超出时优先保留开头信息和最新问题，裁剪较旧的中间内容；最大输出 Token 不会改变这一限制。', 'Conversation context includes up to 500 text segments within a 256 KiB request limit. If needed, older middle content is trimmed while keeping the opening context and latest question. Maximum output tokens do not change this limit.')));
  const enabledRow = node('div', 'toggle-row');
  const enabled = node('input');
  enabled.type = 'checkbox'; enabled.checked = state.backendDraft.enabled; enabled.dataset.draftGroup = 'backend'; enabled.dataset.field = 'enabled'; enabled.setAttribute('aria-label', t('启用后端模型', 'Enable backend model'));
  enabledRow.append(node('div', 'choice-copy', t('启用后端模型', 'Enable backend model')), enabled);
  backendCard.append(enabledRow);
  const backendFields = node('fieldset', 'backend-fields');
  backendFields.disabled = !state.backendDraft.enabled;
  const backendGrid = node('div', 'form-grid');
  backendGrid.append(field(t('推理强度', 'Reasoning effort'), optionSelect('effort', EFFORTS.map(value => ({ value, label: tEffort(value) })), state.backendDraft.effort, 'backend', t('推理强度', 'Reasoning effort'))));
  const tokens = textInput(String(state.backendDraft.maxOutputTokens), 'backend', 'maxOutputTokens', 'number'); tokens.min = '16'; tokens.max = '32768'; tokens.step = '1';
  backendGrid.append(field(t('最大输出 Token（含推理）', 'Max output tokens (including reasoning)'), tokens, t('推理也占用此预算。较高推理强度配合较小上限，可能在回答前就耗尽预算。', 'Reasoning also uses this budget. High reasoning effort with a small limit can exhaust it before an answer is produced.')));
  const timeout = textInput(String(state.backendDraft.timeoutSeconds), 'backend', 'timeoutSeconds', 'number'); timeout.min = '5'; timeout.max = '300'; timeout.step = '1';
  backendGrid.append(field(t('请求超时（秒）', 'Request timeout (seconds)'), timeout));
  const searchRow = node('div', 'toggle-row');
  const search = node('input'); search.type = 'checkbox'; search.checked = state.backendDraft.webSearch; search.dataset.draftGroup = 'backend'; search.dataset.field = 'webSearch'; search.setAttribute('aria-label', t('联网搜索', 'Web search'));
  searchRow.append(node('div', 'choice-copy', t('联网搜索', 'Web search')), search);
  const backendInstructions = textArea(state.backendDraft.instructions, 'backend', 'instructions', t('给后端模型的补充指令。', 'Additional instructions for the backend model.'));
  backendGrid.append(field(t('后端指令', 'Backend instructions'), backendInstructions));
  backendFields.append(backendGrid, searchRow);
  backendCard.append(backendFields);
  const backendActions = node('div', 'form-actions');
  const saveBackend = button(t('保存后端参数', 'Save backend settings'), 'save-backend', 'primary');
  saveBackend.disabled = Boolean(state.actionBusy) || (isSessionActive() && state.session.status !== 'connected');
  backendActions.append(saveBackend, node('span', 'draft-status', state.dirty.backend ? t('有未保存修改', 'Unsaved changes') : t('已保存', 'Saved')));
  backendCard.append(backendActions, node('p', 'field-hint', t('保存后从下一次后端请求生效，正在处理的请求保持原参数。', 'Saved changes apply to the next backend request; a request already in progress keeps its settings.')));
  fragment.append(backendCard);
  return fragment;
}

function tTone(value) { return ({ natural: t('自然', 'Natural'), warm: t('温和', 'Warm'), relaxed: t('轻松', 'Relaxed'), professional: t('专业', 'Professional') })[value] || value; }
function tIntonation(value) { return ({ natural: t('自然', 'Natural'), steady: t('平稳', 'Steady'), expressive: t('有表现力', 'Expressive') })[value] || value; }
function tPace(value) { return ({ normal: t('正常', 'Normal'), slow: t('慢一些', 'Slower'), brisk: t('轻快', 'Brisk') })[value] || value; }
function tEffort(value) { return ({ default: t('服务默认', 'Service default'), low: t('低', 'Low'), medium: t('中', 'Medium'), high: t('高', 'High'), xhigh: t('很高', 'Very high'), max: t('最大', 'Maximum') })[value] || value; }

function buildConnectionSettings() {
  const fragment = document.createDocumentFragment();
  const intro = node('div', 'settings-subheading');
  intro.append(node('h2', '', t('独立连接配置', 'Independent connections')), node('p', 'muted', t('语音和后端分别保存 endpoint、模型、鉴权方式与 key。', 'Voice and backend each have their own endpoint, model, auth method and key.')));
  const link = settingCard(t('手机联动', 'Phone linking'), t('将已保存的连接生成加密二维码，供手机扫码导入。', 'Generate an encrypted QR code from saved connections for your phone.'));
  link.append(button(t('生成配置二维码', 'Generate configuration QR'), 'settings-tab', 'secondary', 'phone'));
  fragment.append(intro, link, buildConnectionCard('voice'), buildConnectionCard('backend'));
  return fragment;
}

function buildConnectionCard(kind) {
  const connection = state.connections[kind];
  const draft = state.connectionDrafts[kind];
  const card = settingCard(kind === 'voice' ? t('语音连接', 'Voice connection') : t('后端连接', 'Backend connection'), kind === 'voice' ? t('连接 GPT-Live-1 实时语音模型。', 'Connect to the GPT-Live-1 real-time voice model.') : t('用于可选的推理或搜索。', 'Used for optional reasoning or search.'));
  const grid = node('div', 'form-grid connection-form-grid');
  const endpoint = textInput(draft.endpoint, `connection-${kind}`, 'endpoint', 'url', 'https://…'); endpoint.dataset.connectionKind = kind; endpoint.dataset.connectionField = 'endpoint'; endpoint.autocomplete = 'off';
  const model = textInput(draft.model, `connection-${kind}`, 'model', 'text', kind === 'voice' ? 'gpt-live-1' : 'model-or-deployment'); model.dataset.connectionKind = kind; model.dataset.connectionField = 'model';
  const auth = optionSelect('auth', [{ value: 'bearer', label: t('Bearer', 'Bearer') }, { value: 'api-key', label: t('API key', 'API key') }], draft.auth, `connection-${kind}`, t('鉴权方式', 'Authentication'));
  auth.dataset.connectionKind = kind; auth.dataset.connectionField = 'auth';
  const key = textInput('', `connection-${kind}`, 'apiKey', 'password', connection ? t('留空以保留已保存 key', 'Leave blank to keep the saved key') : t('输入 key', 'Enter key'));
  key.dataset.connectionKind = kind; key.dataset.keyField = 'apiKey'; key.setAttribute('aria-label', t('API key，密码输入框', 'API key, password field')); key.maxLength = 4096;
  grid.append(field(t('Endpoint', 'Endpoint'), endpoint), field(t('模型 / 部署名', 'Model / deployment'), model), field(t('鉴权方式', 'Authentication'), auth), field(t('API key', 'API key'), key));
  card.append(grid);
  const keyState = node('p', 'key-state', connection ? `${t('已保存：', 'Saved: ')}${connection.keyMask}` : t('尚未保存 key。', 'No key saved.'));
  card.append(keyState);
  const actions = node('div', 'connection-actions');
  const test = button(t('测试连接', 'Test connection'), 'test-connection', 'secondary', kind);
  const cancel = button(t('取消测试', 'Cancel test'), 'cancel-test', 'text-button', kind);
  cancel.hidden = !state.testPending[kind];
  test.disabled = Boolean(state.connectionBusy[kind]) || isSessionActive();
  const save = button(t('保存连接', 'Save connection'), 'save-connection', 'primary', kind);
  save.disabled = Boolean(state.connectionBusy[kind]);
  actions.append(test, cancel, save);
  card.append(actions);
  const result = node('p', 'connection-test-result', state.connectionResults[kind]);
  result.dataset.status = state.connectionResultKinds[kind];
  card.append(result);
  if (isSessionActive()) {
    card.querySelectorAll('input,select,button').forEach(control=>{control.disabled=true;});
    card.append(node('p','field-hint',t('连接配置在会话结束后可修改和测试。','Connections can be changed and tested after the conversation ends.')));
  }
  return card;
}

function buildPhoneLinking() {
  const fragment = document.createDocumentFragment();
  const intro = node('div', 'settings-subheading');
  intro.append(node('h2', '', t('连接手机', 'Link a phone')), node('p', 'muted', t('导出已保存的连接配置，手机端稍后用口令导入。', 'Export saved connection settings for a phone to import with a passphrase.')));
  fragment.append(button(t('返回连接管理', 'Back to connections'), 'settings-tab', 'secondary', 'connections'), intro);
  const card = settingCard(t('加密二维码', 'Encrypted QR code'), t('口令只用于这次导出，不会进入二维码，也不会被保存。', 'The passphrase is used only for this export and is never stored or placed in the QR code.'));
  const choices = node('div', 'qr-kind-grid');
  for (const kind of ['voice', 'backend']) {
    const label = node('label', 'qr-kind');
    const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = state.qr.kinds.includes(kind); checkbox.dataset.qrKind = kind; checkbox.disabled = !state.connections[kind];
    label.append(checkbox, node('strong', '', kind === 'voice' ? t('语音连接', 'Voice connection') : t('后端连接', 'Backend connection')), node('small', '', state.connections[kind] ? t('已保存，可导出', 'Saved and exportable') : t('尚未保存', 'Not saved')));
    choices.append(label);
  }
  card.append(choices);
  const passphrase = textInput(state.qr.passphrase, 'qr', 'passphrase', 'password', t('至少 4 个字符', 'At least 4 characters')); passphrase.dataset.qrField = 'passphrase'; passphrase.maxLength = 256;
  const confirmation = textInput(state.qr.confirmation, 'qr', 'confirmation', 'password', t('再次输入口令', 'Repeat the passphrase')); confirmation.dataset.qrField = 'confirmation'; confirmation.maxLength = 256;
  card.append(field(t('导入口令', 'Passphrase'), passphrase), field(t('确认口令', 'Confirm passphrase'), confirmation));
  const qrActions = node('div', 'form-actions');
  const generate = button(state.qr.busy ? t('正在生成…', 'Generating…') : t('生成加密二维码', 'Generate encrypted QR'), 'generate-qr', 'primary');
  generate.disabled = state.qr.busy;
  qrActions.append(generate);
  card.append(qrActions);
  if (state.qr.error) card.append(node('p', 'error-copy', state.qr.error));
  if (state.qr.payload) {
    const preview = node('div', 'qr-preview');
    const canvas = node('canvas', 'qr-canvas'); canvas.setAttribute('aria-label', t('加密配置二维码', 'Encrypted connection QR code'));
    preview.append(canvas);
    const meta = node('div', 'qr-preview-meta');
    meta.append(node('strong', '', t('二维码已生成', 'QR code ready')), node('p', 'muted', t('只展示加密载荷，不显示 endpoint、模型或 key。', 'Only the encrypted payload is shown; endpoint, model and key stay hidden.')));
    const saveQr = button(t('保存 PNG', 'Save PNG'), 'save-qr', 'secondary');
    meta.append(saveQr);
    preview.append(meta);
    card.append(preview);
    queueMicrotask(() => {
      try { drawQr(canvas, state.qr.payload); } catch { state.qr.error = errorText('payload_too_large'); }
    });
  }
  fragment.append(card);
  const pending = settingCard(t('在手机上导入', 'Import on your phone'));
  pending.append(node('p', 'pending-note', t('手机端在“设置 → 连接管理 → 扫码导入连接”扫描此码，输入口令、核对地址，再测试并保存。', 'On your phone, open Settings → Connections → Import connections from QR. Enter the passphrase, review, then test and save.')));
  fragment.append(pending);
  return fragment;
}

function render() {
  applyTheme();
  root.replaceChildren(buildSidebar(), buildMain());
  root.classList.toggle('has-notice', Boolean(state.notice));
  root.setAttribute('aria-busy', String(!state.booted || Boolean(state.actionBusy || state.historyBusy)));
  if (state.qr.payload) {
    const canvas = root.querySelector('.qr-canvas');
    if (canvas) { try { drawQr(canvas, state.qr.payload); } catch { /* fixed error is shown on next action */ } }
  }
}

function syncRuntimeNotice() {
  const view = root.querySelector('.view');
  if (!view) return false;
  const current = view.querySelector('.notice');
  if (state.notice) {
    const next = noticeElement();
    if (current) current.replaceWith(next);
    else view.append(next);
  } else if (current) {
    current.remove();
  }
  return true;
}

function refreshRuntimeView() {
  if (!state.booted) {
    render();
    return;
  }
  if (state.page === 'conversation') {
    const current = root.querySelector('.view-conversation');
    if (current) {
      current.replaceWith(buildConversation());
      root.setAttribute('aria-busy', String(Boolean(state.actionBusy)));
      return;
    }
  }
  syncRuntimeNotice();
}

function markDraft(group, fieldName, value) {
  if(group==='audio'&&['inputDeviceId','outputDeviceId'].includes(fieldName)){audioManager?.stopTests();state.audioDraft[fieldName]=value;render();return;}
  if (group === 'voice') { state.voiceDraft[fieldName] = fieldName === 'minutes' ? Number(value) : value; state.dirty.voice = true; }
  if (group === 'backend') {
    state.backendDraft[fieldName] = fieldName === 'maxOutputTokens' || fieldName === 'timeoutSeconds' ? Number(value) : value;
    state.dirty.backend = true;
  }
  if (group === 'backend' && fieldName === 'enabled') {
    const fields = root.querySelector('.backend-fields');
    if (fields) fields.disabled = !state.backendDraft.enabled;
  }
  updateDraftStatus(group);
}

function updateDraftStatus(group) {
  const selector = group === 'voice' ? '.view-settings .settings-card:nth-of-type(2) .draft-status' : '.view-settings .settings-card:nth-of-type(3) .draft-status';
  const status = root.querySelector(selector);
  if (status) status.textContent = state.dirty[group] ? t('有未保存修改', 'Unsaved changes') : t('已保存', 'Saved');
}

function cancelTest(kind) {
  const requestId = state.testPending[kind];
  if (!requestId) return;
  state.testPending[kind] = '';
  state.testSerial[kind] += 1;
  void bridgeCall('cancelTest', { requestId }).catch(() => undefined);
}

function handleInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
  if (target.dataset.historyDialogField && state.historyDialog) {
    state.historyDialog[target.dataset.historyDialogField] = target.value;
    state.historyDialog.error = '';
    target.closest('.history-dialog')?.querySelector('.error-copy')?.remove();
    return;
  }
  if (['voice','backend','audio'].includes(target.dataset.draftGroup)) {
    const value = target instanceof HTMLInputElement && target.type === 'checkbox' ? target.checked : target.value;
    markDraft(target.dataset.draftGroup, target.dataset.field, value);
    return;
  }
  if (target.dataset.connectionKind && target.dataset.connectionField) {
    const kind = target.dataset.connectionKind;
    state.connectionDrafts[kind][target.dataset.connectionField] = target.value;
    cancelTest(kind);
    state.connectionResults[kind] = '';
    state.connectionResultKinds[kind] = '';
    const card = target.closest('.settings-card');
    const result = card?.querySelector('.connection-test-result');
    if (result) { result.textContent = ''; result.dataset.status = ''; }
    return;
  }
  if (target.dataset.keyField) {
    const kind = target.dataset.connectionKind;
    state.keyDrafts[kind] = target.value;
    cancelTest(kind);
    return;
  }
  if (target.dataset.qrField) {
    if (state.qr.payload || state.qr.busy) invalidateQr();
    state.qr[target.dataset.qrField] = target.value;
    state.qr.error = '';
  }
}

function handleChange(event) {
  handleInput(event);
  const target = event.target;
  if (target instanceof HTMLInputElement && target.dataset.qrKind) {
    invalidateQr();
    const kind = target.dataset.qrKind;
    if (target.checked && !state.qr.kinds.includes(kind)) state.qr.kinds.push(kind);
    if (!target.checked) state.qr.kinds = state.qr.kinds.filter(item => item !== kind);
    render();
  }
}

async function saveGlobal(patch) {
  const next = normalizeSettings({ ...state.settings, ...patch, voice: state.settings.voice, backend: state.settings.backend });
  state.actionBusy = 'save-global';
  clearNotice();
  render();
  try {
    const saved = normalizeSettings(await bridgeCall('saveSettings', { settings: next }));
    state.settings = saved;
    state.savedSettings = clone(saved);
    state.actionBusy = '';
    render();
  } catch (error) {
    state.actionBusy = '';
    showNotice(errorText(fixedCode(error)));
    render();
  }
}

async function saveVoice() {
  if (state.actionBusy || (isSessionActive() && state.session.status !== 'connected')) return;
  const controller = state.session.status === 'connected' ? state.controller : null;
  state.actionBusy = 'save-voice'; clearNotice(); render();
  let persisted = false;
  try {
    const next = normalizeSettings({ ...state.savedSettings, voice: {...clone(state.voiceDraft), voice: controller ? state.savedSettings.voice.voice : state.voiceDraft.voice} });
    const saved = normalizeSettings(await bridgeCall('saveSettings', { settings: next }));
    state.settings = saved; state.savedSettings = clone(saved); state.voiceDraft = clone(saved.voice); state.dirty.voice = false;
    persisted = true;
    if (controller && state.controller === controller) {
      await controller.updatePreferences({voice: saved.voice});
      if (state.controller !== controller) return;
      showNotice(t('已保存并更新当前风格与时长；音色从下一次会话生效。', 'Saved and applied style and duration. Voice changes apply next session.'), 'success');
    } else showNotice(t('已保存，下次会话生效。', 'Saved for the next conversation.'), 'success');
  } catch (error) {
    showNotice((persisted ? t('参数已保存，但当前会话未确认更新；对话继续，可再次保存重试。 ', 'Settings saved, but this session’s update was not confirmed. The call continues; save again to retry. ') : '') + errorText(fixedCode(error)));
  } finally {state.actionBusy = ''; render();}
}

async function saveBackend() {
  if (state.actionBusy || (isSessionActive() && state.session.status !== 'connected')) return;
  const controller = state.session.status === 'connected' ? state.controller : null;
  state.actionBusy = 'save-backend'; clearNotice(); render();
  try {
    if (state.backendDraft.enabled && (!Number.isInteger(Number(state.backendDraft.maxOutputTokens)) || Number(state.backendDraft.maxOutputTokens) < 16 || Number(state.backendDraft.maxOutputTokens) > 32768)) throw new Error('invalid_tokens');
    const next = normalizeSettings({ ...state.savedSettings, backend: clone(state.backendDraft) });
    const saved = normalizeSettings(await bridgeCall('saveSettings', { settings: next, applyBackendToSession: Boolean(controller) }));
    state.settings = saved; state.savedSettings = clone(saved); state.backendDraft = clone(saved.backend); state.dirty.backend = false;
    if (controller && state.controller === controller) {
      await controller.updatePreferences({backend: saved.backend});
      showNotice(t('已保存，从下一次后端请求生效；当前请求保持原参数。', 'Saved for the next backend request; the current request keeps its settings.'), 'success');
    } else showNotice(t('已保存，下次会话生效。', 'Saved for the next conversation.'), 'success');
  } catch (error) {showNotice(errorText(fixedCode(error)));}
  finally {state.actionBusy = ''; render();}
}

function connectionPayload(kind) {
  return { endpoint: state.connectionDrafts[kind].endpoint, model: state.connectionDrafts[kind].model, auth: state.connectionDrafts[kind].auth, apiKey: state.keyDrafts[kind] };
}

async function saveConnection(kind) {
  if(isSessionActive()) return;
  cancelTest(kind);
  state.connectionBusy[kind] = true; clearNotice(); render();
  try {
    const saved = normalizeConnection(await bridgeCall('saveConnection', { kind, credential: connectionPayload(kind) }), kind);
    if (!saved) throw new Error('save_failed');
    state.connections[kind] = saved;
    state.connectionDrafts[kind] = { endpoint: saved.endpoint, model: saved.model, auth: saved.auth };
    state.keyDrafts[kind] = '';
    state.connectionResults[kind] = t('已保存。', 'Saved.');
    state.connectionResultKinds[kind] = 'success';
    invalidateQr();
    state.connectionBusy[kind] = false;
    render();
  } catch (error) { state.connectionBusy[kind] = false; state.connectionResults[kind] = errorText(fixedCode(error)); state.connectionResultKinds[kind] = 'failed'; render(); }
}

async function testConnection(kind) {
  if(isSessionActive()) return;
  cancelTest(kind);
  const requestId = `desktop-${kind}-${++state.testSerial[kind]}-${Date.now()}`;
  state.testPending[kind] = requestId;
  state.connectionResults[kind] = t('正在测试…', 'Testing…');
  state.connectionResultKinds[kind] = 'pending';
  render();
  try {
    const value = await bridgeCall('testConnection', { requestId, kind, credential: connectionPayload(kind) });
    if (state.testPending[kind] !== requestId) return;
    state.testPending[kind] = '';
    if (!value || value.ok !== true) throw new Error(value?.code || 'bridge_failed');
    state.connectionResults[kind] = t(`测试通过 · ${value.durationMs || 0} ms`, `Test passed · ${value.durationMs || 0} ms`);
    state.connectionResultKinds[kind] = 'success';
    render();
  } catch (error) {
    if (state.testPending[kind] !== requestId) return;
    state.testPending[kind] = '';
    state.connectionResults[kind] = errorText(fixedCode(error));
    state.connectionResultKinds[kind] = 'failed';
    render();
  }
}

function invalidateQr({ clearPassphrase = false } = {}) {
  state.qr.revision += 1;
  state.qr.payload = '';
  state.qr.error = '';
  state.qr.busy = false;
  root.querySelector('.qr-preview')?.remove();
  const generate = root.querySelector('[data-action="generate-qr"]');
  if (generate) {
    generate.disabled = false;
    generate.textContent = t('生成加密二维码', 'Generate encrypted QR');
  }
  if (clearPassphrase) {
    state.qr.passphrase = '';
    state.qr.confirmation = '';
  }
}

async function generateQr() {
  const kinds = state.qr.kinds.filter(kind => Boolean(state.connections[kind]));
  const revision = state.qr.revision;
  const passphrase = state.qr.passphrase;
  const confirmation = state.qr.confirmation;
  state.qr.error = '';
  if (!kinds.length) { state.qr.error = errorText('not_configured'); render(); return; }
  if ([...passphrase.trim()].length < 4) { state.qr.error = errorText('passphrase_short'); render(); return; }
  if (passphrase !== confirmation) { state.qr.error = errorText('passphrase_mismatch'); render(); return; }
  state.qr.busy = true; state.qr.payload = ''; render();
  try {
    const value = await bridgeCall('exportQr', { kinds, passphrase });
    if (state.qr.revision !== revision) return;
    if (!value || typeof value.payload !== 'string' || !value.payload) throw new Error('bridge_failed');
    state.qr.payload = value.payload;
    state.qr.passphrase = '';
    state.qr.confirmation = '';
    state.qr.busy = false;
    render();
  } catch (error) { state.qr.busy = false; state.qr.error = errorText(fixedCode(error)); render(); }
}

async function saveQr() {
  const canvas = root.querySelector('.qr-canvas');
  if (!canvas) return;
  try {
    const dataUrl = canvas.toDataURL('image/png');
    const saved = await bridgeCall('saveQrPng', { dataUrl });
    if (!saved || saved.saved !== true) return;
    showNotice(t('二维码 PNG 已保存。', 'The QR PNG was saved.'), 'success'); render();
  } catch (error) { showNotice(errorText(fixedCode(error))); render(); }
}

function makeController() {
  const token = Symbol('live-controller');
  state.controllerToken = token;
  const callbacks = {
    onStatus(status) {
      if (state.controllerToken !== token) return;
      state.session.status = status;
      if (state.page === 'settings') render(); else refreshRuntimeView();
    },
    onTranscript(fragment) {
      if (state.controllerToken !== token || !fragment || typeof fragment.text !== 'string') return;
      const role = fragment.role === 'user' ? 'user' : 'assistant';
      const text = fragment.text.slice(0, 16000);
      const startMs = Number(fragment.startMs) || 0;
      const endMs = Number(fragment.endMs) || 0;
      const fragments = state.session.fragments;
      const previous = fragments[fragments.length - 1];
      if (previous && previous.role === role && previous.text.length < 16000) {
        const remaining = 16000 - previous.text.length;
        previous.text += text.slice(0, remaining);
        previous.endMs = Math.max(previous.endMs || 0, endMs);
      } else {
        fragments.push({ role, text, startMs, endMs });
      }
      state.session.fragments = fragments.slice(-MAX_STORED_TRANSCRIPT_FRAGMENTS);
      refreshRuntimeView();
    },
    onError(code) {
      if (state.controllerToken !== token) return;
      if(typeof code==='string'&&code.startsWith('backend_'))state.session.backendErrorCode=code;
      showNotice(errorText(typeof code === 'string' ? code : 'bridge_failed'));
      refreshRuntimeView();
    },
    onBackendStatus(status) {
      if (state.controllerToken !== token) return;
      if(status==='working') {
        state.session.backendStartedAt=Date.now();
        if(state.session.backendErrorCode && state.notice===errorText(state.session.backendErrorCode))clearNotice();
        state.session.backendErrorCode='';
      }
      state.session.backendStatus = status;
      refreshRuntimeView();
    },
    onSources(sources) {
      if (state.controllerToken !== token || !Array.isArray(sources)) return;
      state.session.sourcesExpanded = false;
      state.session.sources = sources.filter(source => source && typeof source === 'object').slice(0, 8).map(source => ({ title: typeof source.title === 'string' ? source.title.slice(0, 300) : '', url: typeof source.url === 'string' ? source.url.slice(0, 500) : '' }));
      refreshRuntimeView();
    },
    onClosed(result) {
      if (state.controllerToken !== token) return;
      state.closingHistoryPromise = handleControllerClosed(result, token);
    },
  };
  try {
    return createDesktopLive({ api: bridge, audio, callbacks, audioDevices:clone(state.savedSettings.audio) });
  } catch (error) {
    showNotice(errorText(fixedCode(error)));
    state.controllerToken = null;
    return null;
  }
}

async function startSession() {
  audioManager?.stopTests();
  if (!state.connections.voice) { showNotice('not_configured'); render(); return; }
  if (isSessionActive()) return;
  clearNotice();
  const controller = makeController();
  if (!controller) { render(); return; }
  state.controller = controller;
  state.session = { status: 'connecting', mode: 'general', muted: false, startedAt: Date.now(), fragments: [], backendStatus: 'idle', sources: [], sourcesExpanded: false };
  render();
  try {
    await controller.start('general');
  } catch (error) {
    if (state.controller === controller) {
      controller.dispose(); state.controller = null; state.controllerToken = null; state.session = { status: 'idle', mode: 'general', muted: false, startedAt: 0, fragments: [], backendStatus: 'idle', sources: [], sourcesExpanded: false }; showNotice(errorText(fixedCode(error))); render();
    }
  }
}

async function closeSession() {
  if (!state.controller) return;
  state.session.status = 'closing'; render();
  try {
    await state.controller.close();
    if (state.closingHistoryPromise) await state.closingHistoryPromise;
  } catch (error) { showNotice(errorText(fixedCode(error))); render(); }
}

async function handleControllerClosed(result, token) {
  const record = result && typeof result === 'object' && result.record ? result.record : null;
  const confirmed = typeof result === 'boolean' ? result : Boolean(result?.confirmed);
  try {
    if (record) {
      const saved = await bridgeCall('saveHistory', { record });
      state.history = normalizeHistory(saved);
      if (!record.title) watchHistoryTitle(record.id);
    }
  } catch (error) { showNotice(errorText(fixedCode(error))); }
  if (state.controllerToken !== token) return;
  state.controller?.dispose();
  state.controller = null;
  state.controllerToken = null;
  state.session = { status: 'idle', mode: 'general', muted: false, startedAt: 0, fragments: [], backendStatus: 'idle', sources: [], sourcesExpanded: false };
  if (!state.notice) {
    if (record) {
      showNotice(confirmed ? t('会话已结束，文字记录已保存。', 'Conversation ended and the text record was saved.') : t('会话已结束；服务端结束状态未确认，文字记录已保存。', 'Conversation ended; server closure was not confirmed, but the text record was saved.'), confirmed ? 'success' : 'info');
    } else {
      showNotice(confirmed ? t('会话已结束，没有可保存的文字记录。', 'Conversation ended; there was no text record to save.') : t('会话已结束；没有可保存的文字记录，服务端结束状态也未确认。', 'Conversation ended; there was no text record to save and server closure was not confirmed.'), 'info');
    }
  }
  if (state.page === 'settings') render(); else refreshRuntimeView();
}

function mergeHistoryTitle(id, value) {
  const remote = normalizeHistory(value).find(item => item.id === id);
  const index = state.history.findIndex(item => item.id === id);
  if (!remote || index < 0) return false;
  const current = state.history[index];
  // A local manual rename wins over a response that was already in flight.
  if (current.titleSource === 'manual') return true;
  if (!remote.title || current.title === remote.title) return Boolean(current.title);
  state.history[index] = {...current, title: remote.title, titleSource: remote.titleSource || 'auto'};
  if (state.selectedRecord?.id === id) state.selectedRecord = state.history[index];
  return true;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function watchHistoryTitle(id) {
  if (!id || historyTitleWatchers.has(id)) return;
  const watcher = {cancelled: false};
  historyTitleWatchers.set(id, watcher);
  void (async () => {
    try {
      // The title request is deliberately independent from session shutdown;
      // poll only the named record and never replace the whole local array.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await delay(attempt === 0 ? 500 : 1_000);
        if (watcher.cancelled) return;
        const current = state.history.find(item => item.id === id);
        if (!current || current.title) return;
        const remote = await bridgeCall('loadHistory');
        if (watcher.cancelled || !state.history.some(item => item.id === id)) return;
        if (mergeHistoryTitle(id, remote)) {
          if (state.page === 'history' || state.page === 'history-detail') render();
          return;
        }
      }
    } catch {
      // Title generation is best effort; the date fallback remains visible.
    } finally {
      if (historyTitleWatchers.get(id) === watcher) historyTitleWatchers.delete(id);
    }
  })();
}

function openRenameHistoryDialog(id) {
  const record = state.history.find(item => item.id === id) || state.selectedRecord;
  if (!record || state.historyBusy) return;
  state.historyDialog = {kind: 'rename', id, title: record.title || '', error: ''};
  render();
}

async function confirmRenameHistory() {
  const dialog = state.historyDialog;
  if (!dialog || dialog.kind !== 'rename' || state.historyBusy) return;
  const title = normalizeHistoryTitle(dialog.title);
  if (!title) {
    state.historyDialog.error = errorText('invalid_title');
    render();
    return;
  }
  const {id} = dialog;
  state.historyBusy = `rename:${id}`;
  state.historyDialog = null;
  clearNotice();
  render();
  try {
    const returned = normalizeHistory(await bridgeCall('renameHistory', {id, title}));
    const updated = returned.find(item => item.id === id);
    const index = state.history.findIndex(item => item.id === id);
    if (updated && index >= 0) state.history[index] = updated;
    if (state.selectedRecord?.id === id && index >= 0) state.selectedRecord = state.history[index];
    showNotice(t('名称已更新。', 'Conversation name updated.'), 'success');
  } catch (error) {
    showNotice(errorText(fixedCode(error)));
  } finally {
    state.historyBusy = '';
    render();
  }
}

function openDeleteHistoryDialog(id) {
  const record = state.history.find(item => item.id === id) || state.selectedRecord;
  if (!record || state.historyBusy) return;
  state.historyDialog = {kind: 'delete', id, title: historyTitle(record), error: ''};
  render();
}

async function confirmDeleteHistory() {
  const dialog = state.historyDialog;
  if (!dialog || dialog.kind !== 'delete' || state.historyBusy) return;
  const {id} = dialog;
  state.historyBusy = `delete:${id}`;
  state.historyDialog = null;
  clearNotice();
  render();
  const watcher = historyTitleWatchers.get(id);
  if (watcher) watcher.cancelled = true;
  try {
    const returned = normalizeHistory(await bridgeCall('deleteHistory', {id}));
    // Apply only the confirmed deletion locally. A stale response cannot
    // restore a record that another action already removed.
    state.history = state.history.filter(item => item.id !== id);
    state.selectedRecord = null;
    state.page = 'history';
    showNotice(t('记录已删除。', 'Record deleted.'), 'success');
    void returned;
  } catch (error) {
    showNotice(errorText(fixedCode(error)));
  } finally {
    state.historyBusy = '';
    render();
  }
}

function toggleMute() {
  if (!state.controller) return;
  state.session.muted = !state.session.muted;
  state.controller.setMuted(state.session.muted);
  render();
}

async function retryBoot() {
  state.startupError = '';
  await boot();
}

async function handleAction(action, value) {
  if(['audio-refresh','audio-mic','audio-output'].includes(action)){await runAudioAction(action);return;}
  if(action==='save-audio'){await saveAudioSettings();return;}
  if (action === 'dismiss-notice') { clearNotice(); render(); return; }
  if (action === 'retry-boot') { await retryBoot(); return; }
  if (action === 'go-page') {
    audioManager?.stopTests();
    if (isSessionActive() && value !== 'conversation' && value !== 'settings') { showNotice(t('请先结束当前会话。', 'End the current conversation first.'), 'info'); render(); return; }
    if (state.page === 'settings' && state.settingsTab === 'phone' && value !== 'settings') invalidateQr({ clearPassphrase: true });
    if (value === 'settings' && isSessionActive()) state.settingsTab = 'preferences';
    state.page = value; state.selectedRecord = null; state.historyDialog = null; clearNotice(); render(); return;
  }
  if (action === 'set-locale') { await saveGlobal({ locale: valid(value, LOCALES) }); return; }
  if (action === 'set-theme') { await saveGlobal({ theme: valid(value, THEMES) }); return; }
  if (action === 'toggle-locale') { await saveGlobal({ locale: state.settings.locale === 'zh' ? 'en' : 'zh' }); return; }
  if (action === 'open-preferences') { state.page = 'settings'; state.settingsTab = 'preferences'; clearNotice(); render(); return; }
  if (action === 'open-connections') { state.page = 'settings'; state.settingsTab = 'connections'; clearNotice(); render(); return; }
  if (action === 'open-history') { state.selectedRecord = state.history.find(record => record.id === value) || null; state.page = 'history-detail'; render(); return; }
  if (action === 'rename-history') { openRenameHistoryDialog(value); return; }
  if (action === 'delete-history') { openDeleteHistoryDialog(value); return; }
  if (action === 'close-history-dialog') { state.historyDialog = null; render(); return; }
  if (action === 'confirm-rename-history') { await confirmRenameHistory(); return; }
  if (action === 'confirm-delete-history') { await confirmDeleteHistory(); return; }
  if (action === 'settings-tab') { if(state.settingsTab==='audio'&&value!=='audio')audioManager?.stopTests(); if (state.settingsTab === 'phone' && value !== 'phone') invalidateQr({ clearPassphrase: true }); state.settingsTab = value; clearNotice(); render(); if(value==='audio')void audioManager?.refresh().catch(()=>undefined); return; }
  if (action === 'start-session') { await startSession(); return; }
  if (action === 'close-session') { await closeSession(); return; }
  if (action === 'toggle-mute') { toggleMute(); return; }
  if (action === 'toggle-sources') { state.session.sourcesExpanded = !state.session.sourcesExpanded; render(); return; }
  if (action === 'save-voice') { await saveVoice(); return; }
  if (action === 'save-backend') { await saveBackend(); return; }
  if (action === 'save-connection') { await saveConnection(value); return; }
  if (action === 'test-connection') { await testConnection(value); return; }
  if (action === 'cancel-test') { cancelTest(value); state.connectionResults[value] = t('测试已取消。', 'Test cancelled.'); state.connectionResultKinds[value] = 'pending'; render(); return; }
  if (action === 'generate-qr') { await generateQr(); return; }
  if (action === 'save-qr') { await saveQr(); return; }
}

root.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest('button') : null;
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  if (!action) return;
  void handleAction(action, target.dataset.value).catch(error => { showNotice(errorText(fixedCode(error))); render(); });
});

root.addEventListener('input', handleInput);
root.addEventListener('change', handleChange);

setInterval(() => {
  if (!isSessionActive()) return;
  const timer = root.querySelector('.session-timer');
  if (timer) timer.textContent = formatClock(state.session.startedAt);
  const backendTimer=root.querySelector('.backend-progress-timer');
  if(backendTimer&&state.session.backendStatus==='working')backendTimer.textContent=t('已等待 ','Waiting ')+formatClock(state.session.backendStartedAt);
}, 500);

mediaTheme.addEventListener('change', () => { if (state.settings.theme === 'system') { applyTheme(); render(); } });
window.addEventListener('pagehide',()=>{
  audioManager?.dispose();
  for (const watcher of historyTitleWatchers.values()) watcher.cancelled = true;
  historyTitleWatchers.clear();
});

async function boot() {
  root.setAttribute('aria-busy', 'true');
  try {
    const bootstrap = await bridgeCall('bootstrap');
    state.version = typeof bootstrap?.version === 'string' ? bootstrap.version : '';
    const settings = normalizeSettings(bootstrap?.settings);
    state.settings = settings;
    state.savedSettings = clone(settings);
    state.voiceDraft = clone(settings.voice);
    state.backendDraft = clone(settings.backend);
    state.audioDraft = clone(settings.audio);
    state.connections = { voice: normalizeConnection(bootstrap?.connections?.voice, 'voice'), backend: normalizeConnection(bootstrap?.connections?.backend, 'backend') };
    state.connectionDrafts = {
      voice: state.connections.voice ? { endpoint: state.connections.voice.endpoint, model: state.connections.voice.model, auth: state.connections.voice.auth } : emptyConnection('voice'),
      backend: state.connections.backend ? { endpoint: state.connections.backend.endpoint, model: state.connections.backend.model, auth: state.connections.backend.auth } : emptyConnection('backend'),
    };
    state.history = normalizeHistory(bootstrap?.history);
    state.booted = true;
    state.startupError = '';
    attachClosing();
    render();
    if(!audioManager)audioManager=createAudioDeviceManager({onChange:onAudioDevicesChanged});
    void audioManager.refresh().catch(()=>undefined);
  } catch (error) {
    state.booted = false;
    state.startupError = errorText(fixedCode(error));
    render();
  }
}

function attachClosing() {
  if (!bridge || typeof bridge.onClosing !== 'function' || state.unsubscribeClosing) return;
  try {
    state.unsubscribeClosing = bridge.onClosing(async () => {
      audioManager?.dispose();
      try {
        if (state.controller && isSessionActive()) {
          await state.controller.close();
          if (state.closingHistoryPromise) await state.closingHistoryPromise;
        } else {
          state.controller?.dispose();
        }
      } catch {
        state.controller?.dispose();
      } finally {
        state.controller = null;
        state.controllerToken = null;
        try { await bridgeCall('readyToClose'); } catch { /* main process has a force-close timeout */ }
      }
    });
  } catch {
    state.unsubscribeClosing = null;
  }
}

render();
void boot();
