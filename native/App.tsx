import React, { useEffect, useRef, useState } from 'react';
import { version as appVersion } from './package.json';
import {
  Alert,
  AppState,
  BackHandler,
  DeviceEventEmitter,
  Linking,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createLiveController, probeVoice } from './src/live';
import { generateHistoryTitle, probeBackend } from './src/backend';
import { createHistoryNaming } from './src/history-naming';
import { normalizeHistoryTitle } from './src/history-title';
import {
  getCredential,
  loadConnections,
  loadHistory,
  loadSettings,
  saveConnection,
  saveRecord,
  saveSettings,
  applyHistoryTitles,
  applyGeneratedRecordTitle,
  renameRecord,
  deleteRecord,
} from './src/storage';
import { requestAudioPermission, markAudioConnected, observeAudioRoute, type AudioOutput, startAudio, stopAudio } from './src/audio';
import { QrImportScreen } from './src/QrImportScreen';
import { RecordingPlayer } from './src/RecordingPlayer';
import { HistoryActions, type HistoryActionPanel } from './src/HistoryActions';
import { SwipeHistoryRow } from './src/SwipeHistoryRow';
import { LiveTranscriptScroll } from './src/LiveTranscriptScroll';
import { EdgeBackGesture } from './src/EdgeBackGesture';
import { BalancedRowValue } from './src/BalancedRowValue';
import { sessionActivity } from './src/session-activity';
import { createSessionActivitySync } from './src/session-activity-sync';
import { deleteHistoryContent } from './src/history-actions';
import { createRecordingSession } from './src/recording-session';
import { appErrorCode } from './src/app-error-code';
import {createPreferenceAutosave, type AutoSaveState} from './src/preference-autosave';
import {validateVoicePreferences, validateBackendPreferences, buildVoiceUpdateInstructions} from './src/protocol';
import {
  recordings,
  recordingAvailable,
  mergeRecordingHistory,
  type RecordingStatus,
} from './src/recordings';
import type {
  Connection,
  ConversationRecord,
  Credential,
  Kind,
  LiveController,
  Settings,
  VoicePreferences,
  BackendPreferences,
  TranscriptFragment,
} from './src/types';

type Palette = {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  button: string;
};
const displayVersion = appVersion;
const light: Palette = {
  bg: '#faf8f3',
  surface: '#eee9e2',
  text: '#252522',
  muted: '#69645d',
  border: '#d8d1c8',
  accent: '#bb5f43',
  button: '#fffaf6',
};
const dark: Palette = {
  bg: '#191b1d',
  surface: '#282b2d',
  text: '#f3efe9',
  muted: '#bbb5ad',
  border: '#454749',
  accent: '#e29170',
  button: '#201b18',
};
const defaults: Settings = {
  locale: 'zh',
  theme: 'system',
  mode: 'general',
  recordingEnabled: true,
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
const empty = (kind: Kind): Omit<Connection, 'keyMask'> => ({
  endpoint: '',
  model: kind === 'voice' ? 'gpt-live-1' : '',
  auth: kind === 'voice' ? 'api-key' : 'bearer',
});
const voices = [
  'marin',
  'quartz',
  'ripple',
  'vesper',
  'willow',
  'stone',
  'gleam',
  'meridian',
  'bossa',
  'tempo',
  'beacon',
  'delta',
  'cinder',
];
function Button({
  label,
  onPress,
  p,
  secondary = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  p: Palette;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        {
          backgroundColor: secondary ? p.surface : p.accent,
          borderColor: p.border,
          opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
        },
      ]}
    >
      <Text style={[s.buttonText, { color: secondary ? p.text : p.button }]}>
        {label}
      </Text>
    </Pressable>
  );
}
function SessionAction({
  label,
  onPress,
  p,
  disabled = false,
  destructive = false,
}: {
  label: string;
  onPress: () => void;
  p: Palette;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.sessionAction,
        {
          backgroundColor: destructive ? p.accent : p.surface,
          borderColor: destructive ? p.accent : p.border,
          opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
        },
      ]}
    >
      <Text
        style={[
          s.sessionActionText,
          { color: destructive ? p.button : p.text },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}
function Field({
  label,
  value,
  onChange,
  p,
  placeholder = '',
  secret = false,
  multiline = false,
  numeric = false,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  p: Palette;
  placeholder?: string;
  secret?: boolean;
  multiline?: boolean;
  numeric?: boolean;
  disabled?: boolean;
}) {
  return (
    <View style={s.field}>
      <Text style={[s.label, { color: p.muted }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityState={{disabled}}
        editable={!disabled}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={p.muted}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        importantForAutofill="noExcludeDescendants"
        secureTextEntry={secret}
        contextMenuHidden={secret}
        selectTextOnFocus={false}
        multiline={multiline}
        keyboardType={numeric ? 'number-pad' : 'default'}
        maxLength={secret ? 4096 : multiline ? 1500 : 500}
        style={[
          s.input,
          {
            color: p.text,
            borderColor: p.border,
            backgroundColor: p.surface,
            minHeight: multiline ? 100 : 50,
            opacity: disabled ? 0.45 : 1,
          },
        ]}
      />
    </View>
  );
}
function Row({
  label,
  value,
  onPress,
  onLongPress,
  onActions,
  accessibilityHint,
  testID,
  disabled = false,
  p,
}: {
  label: string;
  value: string;
  onPress: () => void;
  onLongPress?: () => void;
  onActions?: () => void;
  accessibilityHint?: string;
  testID?: string;
  disabled?: boolean;
  p: Palette;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      disabled={disabled}
      accessibilityState={{disabled}}
      accessibilityHint={accessibilityHint}
      accessibilityActions={onActions ? [{name: 'historyActions', label: accessibilityHint}] : undefined}
      onAccessibilityAction={event => {
        if (event.nativeEvent.actionName === 'historyActions') onActions?.();
      }}
      testID={testID}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={450}
      style={[s.row, { borderColor: p.border, opacity: disabled ? 0.45 : 1 }]}
    >
      <Text style={[s.rowLabel, s.entryLabel, { color: p.text }]}>{label}</Text>
      <BalancedRowValue value={value} color={p.muted} />
      <Text accessible={false} style={{color: p.muted, fontSize: 18}}>›</Text>
    </Pressable>
  );
}
function Toggle({
  label,
  value,
  onChange,
  p,
  disabled = false,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  p: Palette;
  disabled?: boolean;
}) {
  return (
    <View style={[s.row, { borderColor: p.border }]}>
      <Text style={[s.rowLabel, { color: p.text }]}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        accessibilityState={{disabled, checked: value}}
        disabled={disabled}
        value={value}
        onValueChange={onChange}
        trackColor={{ false: p.border, true: p.accent }}
      />
    </View>
  );
}
function grouped(fragments: TranscriptFragment[]) {
  const out: { role: 'user' | 'assistant'; text: string; at: number }[] = [];
  for (const f of fragments) {
    const last = out[out.length - 1];
    if (last && last.role === f.role) last.text += f.text;
    else out.push({ role: f.role, text: f.text, at: f.startMs });
  }
  return out;
}

function Main() {
  const systemTheme = useColorScheme();
  const [settings, setSettings] = useState<Settings>(defaults);
  const [connections, setConnections] = useState<
    Record<Kind, Connection | null>
  >({ voice: null, backend: null });
  const [drafts, setDrafts] = useState({
    voice: empty('voice'),
    backend: empty('backend'),
  });
  const [keys, setKeys] = useState({ voice: '', backend: '' });
  const [keyOpen, setKeyOpen] = useState({ voice: false, backend: false });
  const [expanded, setExpanded] = useState({ voice: false, backend: false });
  const [results, setResults] = useState({ voice: '', backend: '' });
  const [records, setRecords] = useState<ConversationRecord[]>([]);
  const [moreRecordings, setMoreRecordings] = useState(false);
  const recordingOffset = useRef(0);
  const historyRevision = useRef(0);
  const recordingId = useRef<string | null>(null);
  const [recordingState, setRecordingState] = useState<RecordingStatus>({
    state: 'idle',
  });
  const recordingSaving = useRef(false);
  const sessionGeneration = useRef(0);
  const [selected, setSelected] = useState<ConversationRecord | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [historyActionRecord, setHistoryActionRecord] = useState<ConversationRecord | null>(null);
  const [historyActionError, setHistoryActionError] = useState('');
  const [historyActionPanel, setHistoryActionPanel] = useState<HistoryActionPanel>('menu');
  const [openHistoryRow, setOpenHistoryRow] = useState<string | null>(null);
  const [historySwipeActive, setHistorySwipeActive] = useState(false);
  const naming = useRef<ReturnType<typeof createHistoryNaming> | null>(null);
  if (!naming.current) naming.current = createHistoryNaming({
    generate: (credential, record, locale, signal) => generateHistoryTitle(credential, record.fragments, locale, signal),
    apply: (id, title) => applyGeneratedRecordTitle(id, title, () => audioExists(id)),
    onUpdated: () => readHistory(),
  });
  const [page, setPage] = useState('home');
  const [ready, setReady] = useState(false);
  const [bootFailed, setBootFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importCommitting, setImportCommitting] = useState(false);
  const importCommittingRef = useRef(false);
  const mounted = useRef(true);
  const pageRef = useRef(page);
  pageRef.current = page;
  const [notice, setNotice] = useState('');
  const [status, setStatus] = useState('idle');
  const [muted, setMuted] = useState(false);
  const [audioOutput, setAudioOutput] = useState<AudioOutput>('system');
  const [elapsed, setElapsed] = useState(0);
  const [fragments, setFragments] = useState<TranscriptFragment[]>([]);
  const [backendStatus, setBackendStatus] = useState('idle');
  const [sources, setSources] = useState<{ title: string; url: string }[]>([]);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [picker, setPicker] = useState<{
    title: string;
    selected: string;
    options: { value: string; label: string }[];
    choose: (value: string) => void;
  } | null>(null);
  const controller = useRef<LiveController | null>(null);
  const recordRef = useRef<ConversationRecord | null>(null);
  const transcriptSessionKey = useRef('idle');
  const started = useRef<number | null>(null);
  const activityRef = useRef<ReturnType<typeof createSessionActivitySync> | null>(null);
  const snapshot = useRef<Settings | null>(null);
  const lock = useRef(false);
  const settingsRef = useRef(settings);
  const savedSettings = useRef<Settings>(defaults);
  const statusRef = useRef(status);
  statusRef.current = status;
  const preferenceDrafts = useRef({voice: defaults.voice, backend: defaults.backend});
  const settingsWrites = useRef<Promise<unknown>>(Promise.resolve());
  type AutoOutcome = 'saved' | 'applied' | 'next-request';
  const [autoStates, setAutoStates] = useState<Record<Kind, AutoSaveState<AutoOutcome>>>({voice:{phase:'idle'}, backend:{phase:'idle'}});
  const autosaveRef = useRef<ReturnType<typeof createPreferenceAutosave<Kind, VoicePreferences | BackendPreferences, AutoOutcome>> | null>(null);
  if (!autosaveRef.current) autosaveRef.current = createPreferenceAutosave(commitPreference, (kind, value) => {
    if (mounted.current) setAutoStates(current => ({...current, [kind]:value}));
  });
  const autosave = autosaveRef.current;

  const testRequests = useRef<Record<Kind, AbortController | null>>({
    voice: null,
    backend: null,
  });
  settingsRef.current = settings;
  const p =
    settings.theme === 'dark' ||
    (settings.theme === 'system' && systemTheme === 'dark')
      ? dark
      : light;
  const tr = (zh: string, en: string) =>
    settingsRef.current.locale === 'en' ? en : zh;
  const active = ['connecting', 'connected', 'closing'].includes(status);
  useEffect(() => {
    if (active || busy || page !== 'history') setOpenHistoryRow(null);
  }, [active, busy, page]);
  function errorText(error: unknown) {
    const code = appErrorCode(error);
    const http = /^(voice|backend)_http_(\d{3})$/.exec(code);
    if (http) {
      const service =
        http[1] === 'voice'
          ? tr('语音服务', 'Voice service')
          : tr('后端服务', 'Backend service');
      const statusCode = Number(http[2]);
      const explanation = [401, 403].includes(statusCode)
        ? tr(
            '请检查密钥、鉴权方式及访问权限。',
            'Check the key, authentication method and access rights.',
          )
        : statusCode === 404
        ? tr(
            '未找到模型或接口，请检查地址和部署名。',
            'Model or API not found. Check the URL and deployment name.',
          )
        : statusCode === 429
        ? tr(
            '额度或请求频率受限，请稍后重试。',
            'Quota or rate limit reached. Retry later.',
          )
        : statusCode === 400
        ? tr(
            '服务拒绝了配置，请检查模型支持的参数。',
            'The service rejected the configuration. Check supported parameters.',
          )
        : tr(
            '服务暂时无法完成请求。',
            'The service could not complete the request.',
          );
      return `${service} · HTTP ${statusCode}\n${explanation}`;
    }
    if (/(?:timeout|not_started)$/.test(code))
      return tr(
        '请求超时或会话未就绪，请检查网络和服务。',
        'Request timed out or session did not become ready. Check network and service.',
      );
    if (/_network$/.test(code))
      return tr(
        '网络连接失败，请检查地址、证书和网络。',
        'Network connection failed. Check the URL, certificate and network.',
      );
    if (code.startsWith('audio_'))
      return tr(
        '音频设备暂不可用，请结束其他通话并检查权限。',
        'Audio is unavailable. End other calls and check permissions.',
      );
    if (code.startsWith('recording_') && code !== 'recording_saving')
      return tr(
        '录音模块暂不可用，请重新打开应用后重试。',
        'Recording is temporarily unavailable. Reopen the app and retry.',
      );
    const messages: Record<string, [string, string]> = {
      session_limit_elapsed: ['当前会话已超过新时长，请选择更长时间或不设上限。', 'This session has already exceeded that duration. Choose a longer duration or no limit.'],
      invalid_title: ['请输入 1–60 个字符的名称。', 'Enter a name of 1–60 characters.'],
      history_not_found: ['这条会话已不存在，请返回历史列表。', 'This conversation is no longer available. Return to history.'],
      recording_saving: [
        '录音正在保存，请稍候再开始下一次对话。',
        'Recording is being saved. Start the next conversation in a moment.',
      ],
      qr_cancelled: ['导入已取消。', 'Import cancelled.'],
      qr_busy: [
        '正在处理二维码，请稍候。',
        'A QR operation is already in progress.',
      ],
      qr_unavailable: [
        '此平台尚未支持相机导入，请手动配置。',
        'Camera import is not available on this platform. Configure manually.',
      ],
      qr_failed: [
        '导入未完成，请重新扫码或重试。',
        'Import did not complete. Scan again or retry.',
      ],
      camera_permission: [
        '请允许相机权限；如果已拒绝，可在系统设置中开启。',
        'Allow camera access. If denied, enable it in system settings.',
      ],
      camera_unavailable: [
        '相机暂不可用，请关闭其他相机应用后重试。',
        'The camera is unavailable. Close other camera apps and retry.',
      ],
      invalid_config: [
        '二维码中的连接配置不完整或格式不受支持。',
        'The QR connection configuration is incomplete or unsupported.',
      ],
      invalid_key: [
        '二维码中的密钥无效，不能导入遮罩文字。',
        'The QR key is invalid. Masked text cannot be imported.',
      ],
      invalid_passphrase: [
        '请输入原始导入口令，最多 256 个字符，不可全为空白或包含控制字符。',
        'Enter the original passphrase, up to 256 characters, without control characters or only whitespace.',
      ],
      invalid_payload: [
        '这不是有效的 Live Voice 配置二维码。',
        'This is not a valid Live Voice configuration QR code.',
      ],
      unsupported_version: [
        '此二维码版本不受支持，请用当前电脑端重新生成。',
        'This QR version is unsupported. Generate a new code with the current desktop tool.',
      ],
      payload_too_large: [
        '二维码内容过长，请在电脑端分别生成两组连接。',
        'The QR payload is too large. Export each connection separately.',
      ],
      decrypt_failed: [
        '口令不正确或二维码已损坏，请重新输入口令或扫码。',
        'The passphrase is incorrect or the QR code is damaged. Retry the passphrase or scan again.',
      ],
      invalid_endpoint: [
        '请填写不含账号、查询参数或片段的 HTTPS 地址。',
        'Enter an HTTPS URL without credentials, query parameters or fragments.',
      ],
      invalid_model: [
        '请输入有效模型或部署名称。',
        'Enter a valid model or deployment name.',
      ],
      key_required: [
        '请输入 key；更换地址或鉴权方式时需替换 key。',
        'Enter a key; changing address or authentication requires a replacement key.',
      ],
      storage_failed: [
        '安全存储读写失败，请解锁手机后重试。',
        'Secure storage failed. Unlock the phone and retry.',
      ],
      mic_permission: [
        '需要麦克风权限才能开始语音。',
        'Microphone permission is required.',
      ],
      not_configured: [
        '请先配置语音服务。',
        'Configure the voice service first.',
      ],
      backend_not_configured: [
        '请配置后端模型，或关闭后端。',
        'Configure the backend or disable it.',
      ],
      active_session: [
        '请先结束当前会话再测试。',
        'End the current session before testing.',
      ],
      invalid_tokens: [
        '请输入 16–32768 之间的整数；实际限制依模型而定。',
        'Enter an integer from 16 to 32768; actual limits vary by model.',
      ],
      app_inactive: [
        '请回到前台后重新开始。',
        'Return to the foreground and start again.',
      ],
      auth_failed: [
        '鉴权失败，请检查密钥和鉴权方式。',
        'Authentication failed. Check the key and authentication method.',
      ],
      timeout: [
        '请求超时，请检查网络和服务地址。',
        'Request timed out. Check the network and service URL.',
      ],
      network_error: [
        '网络连接失败，请检查地址和网络。',
        'Network connection failed. Check the URL and network.',
      ],
      style_too_long: [
        '追加指令过长，请缩短后重试。',
        'Live instructions are too long. Shorten them and retry.',
      ],
      session_not_ready: [
        '语音会话尚未就绪。',
        'The voice session is not ready.',
      ],
    };
    const message = messages[code];
    return message
      ? tr(...message)
      : tr(
          '操作未完成，请重试；若再次出现，请保留提示信息以便排查。',
          'The action did not complete. Retry, and retain the message if it happens again.',
        );
  }
  async function run(task: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice('');
    try {
      await task();
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function readHistory(): Promise<void> {
    const revision = ++historyRevision.current;
    const texts = await loadHistory();
    async function publish(items: ConversationRecord[]) {
      const titled = await applyHistoryTitles(items);
      const currentSelected = selectedRef.current;
      const detail = currentSelected ? (await applyHistoryTitles([currentSelected]))[0] : null;
      if (!mounted.current || historyRevision.current !== revision) return;
      setRecords(titled);
      if (detail) setSelected(current => current?.id === detail.id ? {...current, title: detail.title, titleSource: detail.titleSource} : current);
    }
    if (!recordingAvailable()) {
      await publish(texts);
      return;
    }
    try {
      const audio = await recordings.list();
      if (!mounted.current || historyRevision.current !== revision) return;
      recordingOffset.current = audio.items.length;
      setMoreRecordings(audio.hasMore);
      await publish(mergeRecordingHistory(texts, audio.items));
    } catch {
      if (mounted.current && historyRevision.current === revision) {
        setNotice(
          tr(
            '录音列表暂时无法读取，已有录音未删除。',
            'Recordings could not be loaded. Existing audio has not been deleted.',
          ),
        );
        await publish(texts);
      }
    }
  }
  async function loadMoreRecordings() {
    const revision = historyRevision.current;
    const offset = recordingOffset.current;
    const audio = await recordings.list(offset);
    if (
      !mounted.current ||
      historyRevision.current !== revision ||
      recordingOffset.current !== offset
    )
      return;
    const titled = await applyHistoryTitles(mergeRecordingHistory(recordsRef.current, audio.items));
    if (!mounted.current || historyRevision.current !== revision || recordingOffset.current !== offset) return;
    recordingOffset.current += audio.items.length;
    setMoreRecordings(audio.hasMore);
    setRecords(titled);
  }
  async function audioExists(id: string): Promise<boolean> {
    return recordingAvailable() && Boolean(await recordings.get(id));
  }
  function recordTitle(record: ConversationRecord): string {
    return record.title || `${tr('对话', 'Conversation')} · ${new Date(record.startedAt).toLocaleString(settingsRef.current.locale === 'zh' ? 'zh-CN' : 'en-GB')}`;
  }
  async function renameSelected() {
    const record = selectedRef.current;
    const title = normalizeHistoryTitle(renameDraft);
    if (!record || !title) throw new Error('invalid_title');
    await renameHistoryItem(record, title);
    setRenameDraft(null);
  }
  async function renameHistoryItem(record: ConversationRecord, title: string) {
    naming.current?.cancel(record.id);
    if (!await renameRecord(record.id, title, () => audioExists(record.id))) throw new Error('history_not_found');
    await readHistory();
  }
  async function deleteHistoryItem(record: ConversationRecord, scope: 'audio' | 'conversation') {
    historyRevision.current += 1;
    try {
      await deleteHistoryContent(record.id, scope, {
        audioExists,
        deleteAudio: recordings.delete,
        deleteText: deleteRecord,
        cancelNaming: id => naming.current?.cancel(id),
      });
      if (selectedRef.current?.id === record.id) {
        if (scope === 'conversation' || !record.fragments.length) {
          setSelected(null);
          setRenameDraft(null);
          go('history');
        } else setSelected(current => current?.id === record.id ? {...current, recording: undefined} : current);
      }
    } finally {
      await readHistory();
      const audio = recordingAvailable() ? await recordings.get(record.id) : null;
      setSelected(current => current?.id === record.id ? {...current, recording: audio ?? undefined} : current);
    }
  }
  function runHistoryAction(action: (record: ConversationRecord) => Promise<void>) {
    const record = historyActionRecord;
    if (!record || busy || active) return;
    void run(async () => {
      setHistoryActionError('');
      try {
        await action(record);
        setHistoryActionRecord(null);
      } catch (error) {
        setHistoryActionError(errorText(error));
        throw error;
      }
    });
  }
  function openHistoryActions(record: ConversationRecord, panel: HistoryActionPanel = 'menu') {
    if (busy || active) return;
    setOpenHistoryRow(null);
    setHistoryActionError('');
    setHistoryActionPanel(panel);
    setHistoryActionRecord(record);
  }
  function confirmDeleteSelected() {
    const record = selectedRef.current;
    if (!record || busy || active) return;
    Alert.alert(tr('删除这条会话？', 'Delete this conversation?'), tr(
      '这条会话的文字和录音将一并删除，无法恢复。',
      'This conversation’s text and recording will be deleted permanently.',
    ), [
      {text: tr('取消', 'Cancel'), style: 'cancel'},
      {text: tr('删除会话', 'Delete conversation'), style: 'destructive', onPress: () => void run(async () => {
        await deleteHistoryItem(record, 'conversation');
      })},
    ]);
  }
  async function recordingDeleted() {
    await readHistory();
    if (selected?.fragments.length)
      setSelected({ ...selected, recording: undefined });
    else {
      setSelected(null);
      go('history');
    }
  }
  async function boot() {
    setBootFailed(false);
    try {
      const [loaded, configured] = await Promise.all([
        loadSettings(),
        loadConnections(),
        readHistory(),
      ]);
      setSettings(loaded);
      savedSettings.current = loaded;
      preferenceDrafts.current = {voice:{...loaded.voice}, backend:{...loaded.backend}};
      setConnections(configured);
      setDrafts({
        voice: configured.voice
          ? {
              endpoint: configured.voice.endpoint,
              model: configured.voice.model,
              auth: configured.voice.auth,
            }
          : empty('voice'),
        backend: configured.backend
          ? {
              endpoint: configured.backend.endpoint,
              model: configured.backend.model,
              auth: configured.backend.auth,
            }
          : empty('backend'),
      });
      setReady(true);
    } catch (e) {
      setNotice(errorText(e));
      setBootFailed(true);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void boot();
    return () => {
      mounted.current = false;
      void autosave.flush().catch(() => {}).finally(() => autosave.dispose());
      naming.current?.cancelAll();
      sessionGeneration.current += 1;
      controller.current?.dispose();
      void recordings.stopPlayback().catch(() => undefined);
      void stopAudio().catch(() => undefined);
    };
    // Bootstrap once; settingsRef supplies the current locale to errors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => observeAudioRoute(setAudioOutput, () => {
    if (mounted.current) setNotice(tr('音频设备切换未成功，当前输出保持不变。', 'Audio routing did not change; the current output is retained.'));
  }), []);
  useEffect(() => {
    const app = AppState.addEventListener('change', next => {
      if (next === 'active') void activityRef.current?.resume().catch(() => undefined);
      if (next !== 'active') {
        void autosave.flush().catch(() => {});
        naming.current?.cancelAll();
        void recordings.stopPlayback().catch(() => undefined);
        testRequests.current.voice?.abort();
        testRequests.current.backend?.abort();
        setKeys({ voice: '', backend: '' });
        // An established iOS call owns an audio background session. Merely
        // opening another app is not an audio interruption.
        if (Platform.OS === 'ios' && controller.current && started.current !== null) return;
        sessionGeneration.current += 1;
        if (controller.current) {
          controller.current.dispose();
          void stopAudio().catch(() => undefined);
          setNotice(
            tr(
              '已离开前台，音频已停止；服务端结束可能未确认。',
              'The app left the foreground. Audio stopped; server closure may be unconfirmed.',
            ),
          );
        }
      }
    });
    const audio = DeviceEventEmitter.addListener('VoiceAudioFocusLost', () => {
      sessionGeneration.current += 1;
      controller.current?.dispose();
      void stopAudio().catch(() => undefined);
      setNotice(
        tr(
          '其他应用占用了音频，会话已停止。',
          'Another app took audio focus. The session stopped.',
        ),
      );
    });
    return () => {
      app.remove();
      audio.remove();
    };
  }, []);
  useEffect(() => {
    const link = Linking.addEventListener('url', ({url}) => {
      if (url === 'livevoice://session' && controller.current) go('session');
    });
    return () => link.remove();
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!started.current) return;
      const seconds = Math.floor((Date.now() - started.current) / 1000);
      setElapsed(seconds);
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let pending = false;
    const timer = setInterval(() => {
      const id = recordingId.current;
      if (!id || pending) return;
      pending = true;
      void recordings
        .status()
        .then(value => {
          if (mounted.current && recordingId.current === id && value.id === id) {
            setRecordingState(value);
            void activityRef.current?.update({recording: value.state === 'recording'}).catch(() => undefined);
          }
        })
        .catch(() => {
          if (mounted.current && recordingId.current === id) {
            setRecordingState({ id, state: 'error', code: 'recording_failed' });
            void activityRef.current?.update({recording: false}).catch(() => undefined);
          }
        })
        .finally(() => {
          pending = false;
        });
    }, 500);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (picker) {
        setPicker(null);
        return true;
      }
      if (page === 'home') return false;
      go(
        parentPage(),
      );
      return true;
    });
    return () => back.remove();
    // Navigation is rebound with the page/picker; commit blocking uses a live ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, picker]);
  function parentPage() {
    if (page === 'detail') return 'history';
    if (page === 'qr') return 'connections';
    if (page === 'backend') return active ? 'session' : 'voice';
    if (page === 'voice') return active ? 'session' : 'settings';
    if (page === 'connections') return 'settings';
    return 'home';
  }
  function go(next: string) {
    if (importCommittingRef.current) return;
    void autosave.flush().catch(() => {});
    if (next === 'qr' && active) {
      setNotice(errorText(new Error('active_session')));
      return;
    }
    if (page === 'connections') {
      for (const kind of ['voice', 'backend'] as const) {
        testRequests.current[kind]?.abort();
        testRequests.current[kind] = null;
      }
    }
    setKeys({ voice: '', backend: '' });
    setKeyOpen({ voice: false, backend: false });
    setNotice('');
    setHistoryActionRecord(null);
    setHistoryActionError('');
    setOpenHistoryRow(null);
    setRenameDraft(null);
    setPage(next);
  }
  function importedConnections(value: Record<Kind, Connection | null>) {
    if (!mounted.current) return;
    setConnections(value);
    setDrafts({
      voice: value.voice
        ? {
            endpoint: value.voice.endpoint,
            model: value.voice.model,
            auth: value.voice.auth,
          }
        : empty('voice'),
      backend: value.backend
        ? {
            endpoint: value.backend.endpoint,
            model: value.backend.model,
            auth: value.backend.auth,
          }
        : empty('backend'),
    });
    setKeys({ voice: '', backend: '' });
    importCommittingRef.current = false;
    setImportCommitting(false);
    if (pageRef.current === 'qr') setPage('connections');
    setNotice(
      tr(
        '连接已导入，可在对话设置中调整后端启用与参数。',
        'Connections imported. Adjust backend enablement and preferences in Conversation settings.',
      ),
    );
  }
  function persistSettingsPatch(patch: Partial<Settings>): Promise<Settings> {
    const task = settingsWrites.current.then(async () => {
      const next = {...savedSettings.current, ...patch};
      await saveSettings(next);
      savedSettings.current = next;
      return next;
    });
    settingsWrites.current = task.catch(() => undefined);
    return task;
  }
  function globalSettings(patch: Partial<Pick<Settings, 'locale' | 'theme'>>) {
    setSettings(current => ({...current, ...patch}));
    void persistSettingsPatch(patch).catch(e => setNotice(errorText(e)));
  }
  async function commitPreference(kind: Kind, value: VoicePreferences | BackendPreferences): Promise<AutoOutcome> {
    const session = controller.current;
    const connected = session && statusRef.current === 'connected';
    if (session && !connected) throw new Error('session_not_ready');
    const voice = kind === 'voice' ? {...value as VoicePreferences} : null;
    const backend = kind === 'backend' ? {...value as BackendPreferences} : null;
    if (voice) {
      if (session) voice.voice = savedSettings.current.voice.voice;
      validateVoicePreferences(voice);
      if (connected) {
        const previous = snapshot.current?.voice;
        if (!previous || (['tone','intonation','pace','instructions'] as const).some(key => previous[key] !== voice[key])) {
          buildVoiceUpdateInstructions('general', savedSettings.current.locale, voice);
        }
        if (voice.minutes > 0 && started.current !== null && voice.minutes * 60000 <= Date.now() - started.current) throw new Error('session_limit_elapsed');
      }
    }
    if (backend) {
      if (!Number.isInteger(backend.maxOutputTokens) || backend.maxOutputTokens < 16 || backend.maxOutputTokens > 32768) throw new Error('invalid_tokens');
      validateBackendPreferences(backend);
      if (backend.enabled && !await getCredential('backend')) throw new Error('backend_not_configured');
    }
    await persistSettingsPatch(voice ? {voice} : {backend:backend!});
    if (!connected || controller.current !== session || statusRef.current !== 'connected') return 'saved';
    try {
      if (voice) {
        await session.updatePreferences({voice});
        if (controller.current === session && snapshot.current) snapshot.current = {...snapshot.current, voice:{...voice, voice:snapshot.current.voice.voice}};
      } else {
        const credential = backend!.enabled ? await getCredential('backend') : null;
        if (controller.current !== session) return 'saved';
        await session.updatePreferences({backend:backend!, backendCredential:credential});
        if (controller.current === session && snapshot.current) snapshot.current = {...snapshot.current, backend:backend!};
      }
    } catch (error) {
      if (controller.current !== session) return 'saved';
      throw Object.assign(new Error('auto_apply_failed'), {saved:true, reason:error});
    }
    return controller.current === session ? (voice ? 'applied' : 'next-request') : 'saved';
  }
  async function saveRecordingPreference(recordingEnabled: boolean) {
    if (active) return;
    await persistSettingsPatch({recordingEnabled});
    setSettings(current => ({ ...current, recordingEnabled }));
    setNotice(tr('已保存，下次会话生效。', 'Saved for the next session.'));
  }
  function choose(
    title: string,
    value: string,
    options: { value: string; label: string }[],
    onChoose: (value: string) => void,
  ) {
    setPicker({ title, selected: value, options, choose: onChoose });
  }
  function voiceField(field: keyof Settings['voice'], value: string | number) {
    if (field === 'voice' && controller.current) return;
    const voice = {...preferenceDrafts.current.voice, [field]:value};
    preferenceDrafts.current.voice = voice;
    setSettings(current => ({...current, voice}));
    autosave.schedule('voice', {...voice}, field === 'instructions' ? 500 : 0);
  }
  function backendField(field: keyof Settings['backend'], value: string | number | boolean) {
    const backend = {...preferenceDrafts.current.backend, [field]:value};
    preferenceDrafts.current.backend = backend;
    setSettings(current => ({...current, backend}));
    autosave.schedule('backend', {...backend}, field === 'instructions' || field === 'maxOutputTokens' ? 500 : 0);
  }
  function connectionField(
    kind: Kind,
    field: 'endpoint' | 'model' | 'auth',
    value: string,
  ) {
    testRequests.current[kind]?.abort();
    testRequests.current[kind] = null;
    setDrafts(x => ({ ...x, [kind]: { ...x[kind], [field]: value } }));
    setResults(x => ({ ...x, [kind]: '' }));
  }
  async function draftCredential(kind: Kind): Promise<Credential> {
    const d = drafts[kind];
    let url: URL;
    try {
      url = new URL(d.endpoint);
    } catch {
      throw new Error('invalid_endpoint');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('invalid_endpoint');
    if (!/^[A-Za-z0-9_.:/-]{1,120}$/.test(d.model))
      throw new Error('invalid_model');
    const endpoint = url.href.replace(/\/$/, '');
    const old = await getCredential(kind);
    const apiKey =
      keys[kind].trim() ||
      (old?.endpoint === endpoint && old.auth === d.auth ? old.apiKey : '');
    if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('key_required');
    return { endpoint, model: d.model, auth: d.auth, apiKey };
  }
  async function saveCurrent(kind: Kind) {
    if (active && (kind === 'voice' || status !== 'connected')) return;
    const c = await saveConnection(kind, drafts[kind], keys[kind] || undefined);
    setConnections(x => ({ ...x, [kind]: c }));
    setDrafts(x => ({
      ...x,
      [kind]: { endpoint: c.endpoint, model: c.model, auth: c.auth },
    }));
    setKeys(x => ({ ...x, [kind]: '' }));
    setKeyOpen(x => ({ ...x, [kind]: false }));
    setResults(x => ({ ...x, [kind]: '' }));
    const session = controller.current;
    if (kind === 'backend' && status === 'connected' && session) {
      try {
        const backendCredential = await getCredential('backend');
        if (controller.current !== session) return;
        await session.updatePreferences({backend: savedSettings.current.backend, backendCredential});
        if (controller.current !== session) return;
        setNotice(tr('连接已安全保存，当前会话的下一次后端请求将使用新连接。', 'Connection securely saved. The next backend request in this session will use it.'));
      } catch (error) {
        setNotice(`${tr('连接已保存，但当前会话仍使用原连接；可再次保存以重试。', 'Connection saved, but this session still uses the original connection. Save again to retry.')}\n${errorText(error)}`);
      }
      return;
    }
    setNotice(
      tr(
        '连接已安全保存，下次会话使用。',
        'Connection securely saved for the next session.',
      ),
    );
  }
  async function testCurrent(kind: Kind) {
    if (controller.current) throw new Error('active_session');
    const c = await draftCredential(kind);
    const request = new AbortController();
    testRequests.current[kind] = request;
    setResults(x => ({
      ...x,
      [kind]: tr('正在测试真实服务…', 'Testing the service…'),
    }));
    try {
      if (kind === 'voice') await probeVoice(c, request.signal);
      else await probeBackend(c, settings.backend, request.signal);
      if (request.signal.aborted || testRequests.current[kind] !== request)
        return;
      setResults(x => ({
        ...x,
        [kind]:
          kind === 'voice'
            ? tr('语音会话已验证并关闭。', 'Voice session verified and closed.')
            : tr(
                '已收到有效后端响应；未验证搜索工具。',
                'Valid backend response received; search tools were not tested.',
              ),
      }));
    } catch (e) {
      if (request.signal.aborted || testRequests.current[kind] !== request)
        return;
      setResults(x => ({ ...x, [kind]: errorText(e) }));
      throw e;
    } finally {
      if (testRequests.current[kind] === request)
        testRequests.current[kind] = null;
    }
  }
  async function startSession() {
    if (recordingSaving.current) throw new Error('recording_saving');
    if (controller.current) {
      go('session');
      return;
    }
    // A fresh explicit start can retry a previously failed local save or an
    // update rejected by the now-ended session, before creating a new session.
    await autosave.retryFailed();
    await settingsWrites.current;
    const voiceCredential = await getCredential('voice');
    if (!voiceCredential) throw new Error('not_configured');
    const backendCredential = savedSettings.current.backend.enabled
      ? await getCredential('backend')
      : null;
    if (savedSettings.current.backend.enabled && !backendCredential)
      throw new Error('backend_not_configured');
    await requestAudioPermission();
    if (Platform.OS === 'android') {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
      if (result !== PermissionsAndroid.RESULTS.GRANTED)
        throw new Error('mic_permission');
      if (Number(Platform.Version) >= 31)
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        );
    }
    if (AppState.currentState !== 'active') throw new Error('app_inactive');
    const config = JSON.parse(
      JSON.stringify(savedSettings.current),
    ) as Settings;
    snapshot.current = config;
    started.current = null;
    setFragments([]);
    setSources([]);
    setSourcesExpanded(false);
    setMuted(false);
    setElapsed(0);
    setBackendStatus('idle');
    setRecordingState({ state: 'idle' });
    const generation = ++sessionGeneration.current;
    const sessionRecord: ConversationRecord = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      mode: config.mode,
      startedAt: Date.now(),
      durationSeconds: 0,
      confirmedClose: false,
      fragments: [],
    };
    recordRef.current = sessionRecord;
    transcriptSessionKey.current = sessionRecord.id;
    const activity = createSessionActivitySync(sessionRecord.id, config.locale, sessionActivity);
    activityRef.current = activity;
    const recorder = config.recordingEnabled && recordingAvailable()
      ? createRecordingSession(sessionRecord, recordings, value => {
          void activity.update({recording: value.state === 'recording'}).catch(() => undefined);
          if (
            mounted.current &&
            (sessionGeneration.current === generation ||
              recordingSaving.current)
          )
            setRecordingState(value);
        })
      : null;
    let finalized: Promise<void> | null = null;
    function finalize(confirmed: boolean) {
      if (finalized) return finalized;
      finalized = (async () => {
        if (recordingId.current === sessionRecord.id)
          recordingId.current = null;
        sessionRecord.durationSeconds = Math.max(
          1,
          Math.floor((Date.now() - sessionRecord.startedAt) / 1000),
        );
        sessionRecord.confirmedClose = confirmed;
        recordingSaving.current = Boolean(recorder);
        let textSaved = false;
        try {
          // Preserve text even if encoding or listing the independent audio catalog fails.
          if (sessionRecord.fragments.length) {
            await saveRecord(sessionRecord);
            textSaved = true;
          }
        } catch {
          if (mounted.current)
            setNotice(errorText(new Error('storage_failed')));
        }
        try {
          await recorder?.finish(confirmed);
          await readHistory();
        } finally {
          recordingSaving.current = false;
        }
        if (textSaved && savedSettings.current.backend.enabled && mounted.current && AppState.currentState === 'active') {
          const titleCredential = await getCredential('backend');
          if (titleCredential) void naming.current?.start(sessionRecord, titleCredential, savedSettings.current.locale);
        }
      })();
      return finalized;
    }
    const instance = createLiveController({
      onStatus(next) {
        if (next === 'connected') {
          if (started.current === null) void markAudioConnected().catch(() => {
            if (mounted.current && controller.current) setNotice(tr('自动切换音频设备暂不可用，当前对话继续。', 'Automatic audio switching is unavailable; the conversation continues.'));
          });
          recorder?.connected();
          if (started.current === null) started.current = Date.now();
          void activity.update({status: 'connected', startedAt: started.current}).catch(() => undefined);
          if (recordRef.current) recordRef.current.startedAt = started.current;
        }
        if (next === 'closing') void activity.update({status: 'closing'}).catch(() => undefined);
        setStatus(next);
      },
      onTranscript(fragment) {
        const record = recordRef.current;
        if (!record) return;
        const previous = record.fragments[record.fragments.length - 1];
        if (
          previous &&
          previous.role === fragment.role &&
          previous.text.length + fragment.text.length <= 16000
        ) {
          previous.text += fragment.text;
          previous.endMs = Math.max(previous.endMs, fragment.endMs);
        } else record.fragments.push({ ...fragment });
        setFragments(record.fragments.slice(-120));
      },
      onError(code) {
        setNotice(errorText(new Error(code)));
      },
      onBackendStatus(next) {
        setBackendStatus(next);
        void activity.update({backendWorking: next === 'working'}).catch(() => undefined);
      },
      onSources(value) {
        setSources(value);
        setSourcesExpanded(false);
      },
      onClosed(confirmed) {
        void activity.end().catch(() => undefined);
        if (activityRef.current === activity) activityRef.current = null;
        recordRef.current = null;
        started.current = null;
        controller.current = null;
        setStatus('closed');
        void stopAudio().catch(() => undefined);
        void finalize(confirmed).catch(e => {
          if (mounted.current) setNotice(errorText(e));
        });
        if (!confirmed)
          setNotice(
            tr(
              '本地音频已释放，服务端最终结束状态未确认。',
              'Local audio released; final server closure is unconfirmed.',
            ),
          );
      },
    });
    controller.current = instance;
    setPage('session');
    try {
      // Playback must stop even when this session will not be recorded.
      await recordings.stopPlayback();
      if (
        sessionGeneration.current !== generation ||
        AppState.currentState !== 'active'
      )
        throw new Error('app_inactive');
      if (recorder) {
        recordingId.current = sessionRecord.id;
        await recorder.start();
      }
      if (
        sessionGeneration.current !== generation ||
        AppState.currentState !== 'active'
      )
        throw new Error('app_inactive');
      await startAudio();

      if (
        sessionGeneration.current !== generation ||
        AppState.currentState !== 'active'
      )
        throw new Error('app_inactive');
      await instance.connect({
        mode: config.mode,
        voiceCredential,
        backendCredential,
        voice: config.voice,
        backend: config.backend,
      });
    } catch (e) {
      instance.dispose();
      void activity.end().catch(() => undefined);
      if (activityRef.current === activity) activityRef.current = null;
      await finalize(false);
      if (controller.current === instance) {
        controller.current = null;
        recordRef.current = null;
        started.current = null;
        setStatus('closed');
      }
      await stopAudio().catch(() => undefined);
      throw e;
    }
  }
  async function endSession() {
    if (controller.current) await controller.current.close();
    await stopAudio();
  }
  function recordingLabel() {
    if (snapshot.current?.recordingEnabled === false)
      return tr('本次对话不录音 · 仍保存文字历史', 'Recording off · Text history is still saved');
    if (recordingState.state === 'recording')
      return tr(
        '● 正在录音 · 双方声音仅保存在本机',
        '● Recording both voices · Saved on this device',
      );
    if (recordingState.state === 'saving')
      return tr('正在保存录音…', 'Saving recording…');
    if (recordingState.state === 'error')
      return recordingState.code === 'recording_storage_full'
        ? tr(
            '空间不足，录音已停止；对话可继续。',
            'Storage is low. Recording stopped; conversation can continue.',
          )
        : tr(
            '录音出现问题，可能不完整；对话可继续。',
            'Recording encountered an issue and may be incomplete. Conversation can continue.',
          );
    return '';
  }
  function toggleSessionMute() {
    const next = !muted;
    controller.current?.setMuted(next);
    setMuted(next);
    void activityRef.current?.update({muted: next}).catch(() => undefined);
    const id = recordingId.current;
    if (id)
      void recordings.setMuted(id, next).catch(() => {
        void recordings.finish(id, false).catch(() => undefined);
        void activityRef.current?.update({recording: false}).catch(() => undefined);
        if (mounted.current)
          setRecordingState({ id, state: 'error', code: 'recording_failed' });
      });
  }
  const labels: Record<string, string> = {
    idle: tr('未连接', 'Not connected'),
    connecting: tr('正在连接', 'Connecting'),
    connected: tr('已连接，可以自然交流', 'Connected — speak naturally'),
    closing: tr('正在结束会话', 'Finishing session'),
    closed: tr('会话已结束', 'Session ended'),
  };
  function section(zh: string, en: string) {
    return <Text style={[s.section, { color: p.muted }]}>{tr(zh, en)}</Text>;
  }
  function connectionSection(kind: Kind) {
    const d = drafts[kind];
    const locked = active && (kind === 'voice' || status !== 'connected');
    return (
      <View
        style={[s.card, { backgroundColor: p.surface, borderColor: p.border }]}
      >
        <Row
          p={p}
          label={kind === 'voice' ? tr('语音模型连接', 'Voice connection') : tr('后端模型连接', 'Backend connection')}
          value={expanded[kind] ? tr('收起', 'Hide') : tr('展开', 'Show')}
          onPress={() => setExpanded(x => ({ ...x, [kind]: !x[kind] }))}
        />
        {locked && <Text style={[s.hint, {color:p.muted}]}>{tr('会话结束后可修改连接配置。', 'Connection settings are available after the conversation ends.')}</Text>}
        {expanded[kind] && (
          <View style={s.cardInner}>
            <Field
              disabled={locked}
              p={p}
              label="Endpoint"
              value={d.endpoint}
              onChange={v => connectionField(kind, 'endpoint', v)}
              placeholder="https://…/v1"
            />
            <Field
              disabled={locked}
              p={p}
              label={tr('模型 / 部署', 'Model / deployment')}
              value={d.model}
              onChange={v => connectionField(kind, 'model', v)}
            />
            <Row
              disabled={locked}
              p={p}
              label={tr('鉴权方式', 'Authentication')}
              value={d.auth}
              onPress={() =>
                choose(
                  tr('鉴权方式', 'Authentication'),
                  d.auth,
                  [
                    { value: 'bearer', label: 'Bearer' },
                    { value: 'api-key', label: 'api-key' },
                  ],
                  v => connectionField(kind, 'auth', v),
                )
              }
            />
            <Text style={[s.hint, { color: p.muted }]}>
              API key ·{' '}
              {connections[kind]?.keyMask || tr('未配置', 'Not configured')}
            </Text>
            {!keyOpen[kind] ? (
              <Button
                secondary
                p={p}
                label={tr('更换 API key', 'Replace API key')}
                disabled={busy || locked}
                onPress={() => setKeyOpen(x => ({ ...x, [kind]: true }))}
              />
            ) : (
              <Field
                disabled={locked}
                secret
                p={p}
                label={tr('新的 API key', 'New API key')}
                value={keys[kind]}
                onChange={v => {
                  testRequests.current[kind]?.abort();
                  testRequests.current[kind] = null;
                  setKeys(x => ({ ...x, [kind]: v }));
                  setResults(x => ({ ...x, [kind]: '' }));
                }}
                placeholder={tr(
                  '留空保留原有 key',
                  'Leave empty to keep the current key',
                )}
              />
            )}
            <Text style={[s.hint, { color: p.muted }]}>
              {tr(
                '密钥使用系统安全存储，只显示头尾，不提供明文和复制操作。',
                'Keys use system secure storage. Only the prefix and suffix are shown, with no reveal or copy action.',
              )}
            </Text>
            <Button
              p={p}
              label={tr('保存连接配置', 'Save connection')}
              disabled={busy || locked}
              onPress={() => void run(() => saveCurrent(kind))}
            />
            <Button
              secondary
              p={p}
              label={tr('测试连接', 'Test connection')}
              disabled={busy || active}
              onPress={() => void run(() => testCurrent(kind))}
            />
            <Text style={[s.hint, { color: p.muted }]}>
              {kind === 'voice'
                ? tr(
                    '测试创建并关闭短语音会话，可能产生用量，不使用麦克风。',
                    'Testing opens and closes a short voice session and may incur usage. It does not use the microphone.',
                  )
                : tr(
                    '测试发送最小后端请求，可能产生用量。',
                    'Testing sends a minimal backend request and may incur usage.',
                  )}
            </Text>
            {!!results[kind] && (
              <Text
                accessibilityLiveRegion="polite"
                style={[s.notice, { color: p.text, borderColor: p.border }]}
              >
                {results[kind]}
              </Text>
            )}
          </View>
        )}
      </View>
    );
  }
  function voicePage() {
    const v = settings.voice;
    return (
      <>
        <Text style={[s.hint, { color: p.muted }]}>
          {tr('调整说话方式与会话偏好。修改后自动保存并应用支持实时修改的设置，不中断对话。', 'Adjust speaking style and conversation preferences. Supported changes apply automatically during a call without ending it.')}
        </Text>
        <Row
          p={p}
          label={tr('音色', 'Voice')}
          disabled={active}
          value={v.voice}
          onPress={() =>
            choose(
              tr('音色', 'Voice'),
              v.voice,
              voices.map(value => ({ value, label: value })),
              value => voiceField('voice', value),
            )
          }
        />
        <Text style={[s.hint, { color: p.muted }]}>
          {tr(
            active ? '音色在会话结束后可修改。' : '跟随用户语言交流，音色在下一次会话生效。',
            active ? 'Voice can be changed after the conversation ends.' : 'Conversation follows the user’s language. Voice changes apply next session.',
          )}
        </Text>
        {section('说话风格', 'Speaking style')}
        {(
          [
            [
              'tone',
              tr('语气', 'Tone'),
              [
                ['natural', tr('自然', 'Natural')],
                ['warm', tr('温暖', 'Warm')],
                ['relaxed', tr('轻松', 'Relaxed')],
                ['professional', tr('专业', 'Professional')],
              ],
            ],
            [
              'intonation',
              tr('语调', 'Intonation'),
              [
                ['natural', tr('自然', 'Natural')],
                ['steady', tr('平稳', 'Steady')],
                ['expressive', tr('生动', 'Expressive')],
              ],
            ],
            [
              'pace',
              tr('节奏', 'Pace'),
              [
                ['normal', tr('适中', 'Moderate')],
                ['slow', tr('慢一些', 'Slower')],
                ['brisk', tr('快一些', 'Faster')],
              ],
            ],
          ] as const
        ).map(([name, label, options]) => (
          <Row
            key={name}
            p={p}
            label={label}
            value={options.find(([value]) => value === v[name])?.[1] || v[name]}
            onPress={() =>
              choose(
                label,
                v[name],
                options.map(([value, text]) => ({ value, label: text })),
                value => voiceField(name, value),
              )
            }
          />
        ))}
        <Field
          p={p}
          multiline
          label={tr('自定义指令', 'Custom instructions')}
          value={v.instructions}
          onChange={value => voiceField('instructions', value)}
        />
        <Row
          p={p}
          label={tr('单次会话总时长', 'Total session duration')}
          value={
            v.minutes
              ? `${v.minutes} ${tr('分钟', 'min')}`
              : tr('不设应用上限', 'No app limit')
          }
          onPress={() =>
            choose(
              tr('单次会话总时长', 'Total session duration'),
              String(v.minutes),
              [0, 5, 10, 15, 30, 60].map(n => ({
                value: String(n),
                label: n
                  ? `${n} ${tr('分钟', 'minutes')}`
                  : tr('不设应用上限', 'No app limit'),
              })),
              value => voiceField('minutes', Number(value)),
            )
          }
        />
        <Text style={[s.hint, { color: p.muted }]}>
          {tr(
            '整个 session 的运行上限，包含静音和停顿；服务仍可能有自己的时长限制。',
            'Limits the whole session, including pauses and mute time. The provider may have its own limit.',
          )}
        </Text>
      </>
    );
  }
  function backendPage() {
    const b = settings.backend;
    return (
      <>
        <Toggle
          p={p}
          label={tr('启用后端', 'Enable backend')}
          value={b.enabled}
          onChange={v => backendField('enabled', v)}
        />
        <Row
          p={p}
          label={tr('推理强度', 'Reasoning effort')}
          value={b.effort}
          onPress={() =>
            choose(
              tr('推理强度', 'Reasoning effort'),
              b.effort,
              ['default', 'low', 'medium', 'high', 'xhigh', 'max'].map(
                value => ({ value, label: value }),
              ),
              v => backendField('effort', v),
            )
          }
        />
        <Field
          p={p}
          numeric
          label={tr('最大输出 Token', 'Maximum output tokens')}
          value={String(b.maxOutputTokens || '')}
          onChange={v => backendField('maxOutputTokens', Number(v))}
        />
        <Toggle
          p={p}
          label={tr('联网搜索', 'Web search')}
          value={b.webSearch}
          onChange={v => backendField('webSearch', v)}
        />
        <Row
          p={p}
          label={tr('单次请求超时', 'Request timeout')}
          value={`${b.timeoutSeconds}s`}
          onPress={() =>
            choose(
              tr('请求超时', 'Request timeout'),
              String(b.timeoutSeconds),
              [15, 30, 60, 120].map(n => ({
                value: String(n),
                label: `${n}s`,
              })),
              v => backendField('timeoutSeconds', Number(v)),
            )
          }
        />
        <Field
          p={p}
          multiline
          label={tr('后端指令', 'Backend instructions')}
          value={b.instructions}
          onChange={v => backendField('instructions', v)}
        />
        <Text style={[s.hint, { color: p.muted }]}>
          {tr(
            'max 和搜索支持取决于模型及服务。修改后自动保存，从下一次后端请求开始生效，不打断正在处理的请求。',
            'Max reasoning and search support depend on the model and service. Changes automatically update subsequent backend requests without interrupting one already in progress.',
          )}
        </Text>
      </>
    );
  }
  function transcriptView(items: TranscriptFragment[]) {
    return grouped(items).map((item, index) => (
      <View
        key={`${index}-${item.at}`}
        style={[s.turn, { borderColor: p.border }]}
      >
        <Text
          style={[
            s.label,
            { color: item.role === 'user' ? p.accent : p.muted },
          ]}
        >
          {item.role === 'user' ? tr('我', 'You') : tr('助手', 'Assistant')} ·{' '}
          {Math.floor(item.at / 60000)}:
          {String(Math.floor(item.at / 1000) % 60).padStart(2, '0')}
        </Text>
        <Text selectable style={[s.body, { color: p.text }]}>
          {item.text}
        </Text>
      </View>
    ));
  }
  const titles: Record<string, string> = {
    home: 'Live Voice',
    settings: tr('设置', 'Settings'),
    qr: tr('扫码导入', 'Import from QR'),
    voice: tr('对话设置', 'Conversation settings'),
    connections: tr('连接管理', 'Connections'),
    backend: tr('后端推理参数', 'Backend reasoning'),
    session: tr('对话', 'Conversation'),
    history: tr('历史会话', 'History'),
    detail: tr('会话记录', 'Conversation record'),
  };
  const navigationPage =
    page === 'session'
      ? 'session'
      : page === 'history' || page === 'detail'
      ? 'history'
      : page === 'settings' ||
        page === 'voice' ||
        page === 'backend' ||
        page === 'qr' || page === 'connections'
      ? 'settings'
      : 'home';
  function bottomNavigation() {
    const items = [
      { page: 'home', icon: '◉', label: tr('对话', 'Conversation') },
      { page: 'history', icon: '◷', label: tr('历史', 'History') },
      { page: 'settings', icon: '⚙', label: tr('设置', 'Settings') },
    ];
    return (
      <View
        style={[s.bottomNav, { backgroundColor: p.bg, borderColor: p.border }]}
      >
        {items.map(item => {
          const selectedPage =
            navigationPage === item.page ||
            (item.page === 'home' && navigationPage === 'session');
          return (
            <Pressable
              key={item.page}
              accessibilityRole="tab"
              accessibilityState={{ selected: selectedPage }}
              accessibilityLabel={item.label}
              style={s.navItem}
              onPress={() => {
                if (item.page === 'home' && controller.current) go('session');
                else go(item.page);
              }}
            >
              <Text
                style={[
                  s.navIcon,
                  { color: selectedPage ? p.accent : p.muted },
                ]}
              >
                {item.icon}
              </Text>
              <Text
                style={[
                  s.navLabel,
                  { color: selectedPage ? p.accent : p.muted },
                ]}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    );
  }
  const preferenceKind: Kind | null = page === 'voice' ? 'voice' : page === 'backend' ? 'backend' : null;
  function autoFeedback(kind: Kind) {
    const state = autoStates[kind];
    let text = tr('修改后自动保存；会话中自动应用。', 'Changes save automatically and apply during the conversation.');
    if (state.phase === 'pending') text = tr('等待输入完成…', 'Waiting for you to finish typing…');
    if (state.phase === 'saving') text = tr('正在自动保存并更新…', 'Saving and updating…');
    if (state.phase === 'saved') text = state.result === 'applied' && active ? tr('已自动保存并应用', 'Saved and applied automatically')
      : state.result === 'next-request' && active ? tr('已自动保存，下次后端请求生效', 'Saved for the next backend request')
      : tr('已自动保存，下次会话使用', 'Saved for the next conversation');
    if (state.phase === 'error') {
      const value = state.error as {saved?:boolean;reason?:unknown};
      text = `${value?.saved ? tr('已保存，但当前会话尚未确认应用。', 'Saved, but the current-session update is unconfirmed.') : tr('修改未保存或应用，仍使用之前的设置。', 'Changes were not saved or applied; previous settings remain active.')} ${errorText(value?.reason ?? state.error)}`;
    }
    return <View key={kind} style={{gap:6}}>
      <Text accessibilityLiveRegion="polite" testID={`autosave-${kind}`} style={[s.hint,{color:state.phase === 'error' ? p.accent : p.muted}]}>{text}</Text>
      {state.phase === 'error' && <Button secondary p={p} label={tr('重试更新', 'Retry update')} onPress={() => {void autosave.retry(kind).catch(() => {});}} />}
    </View>;
  }
  const autoFeedbackKinds = (['voice','backend'] as const).filter(kind => kind === preferenceKind || autoStates[kind].phase === 'error' || (page === 'session' && ['pending','saving'].includes(autoStates[kind].phase)));
  const notices = (
    <>
      {!!notice && (
        <Text
          accessibilityLiveRegion="polite"
          style={[s.notice, { borderColor: p.border, color: p.text }]}
        >
          {notice}
        </Text>
      )}
      {busy && (
        <Text
          accessibilityLiveRegion="polite"
          style={[s.hint, { color: p.accent }]}
        >
          {tr('正在处理…', 'Working…')}
        </Text>
      )}
    </>
  );
  return (
    <EdgeBackGesture enabled={page !== 'home' && !picker && !historyActionRecord && !importCommitting}
      onBack={() => go(parentPage())} color={p.text} background={p.surface}>
    <SafeAreaView style={[s.safe, { backgroundColor: p.bg }]}>
      <StatusBar
        barStyle={p === dark ? 'light-content' : 'dark-content'}
        backgroundColor={p.bg}
      />
      <View style={s.header}>
        {page !== 'home' && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={tr('返回', 'Back')}
            disabled={importCommitting}
            style={s.smallButton}
            onPress={() =>
              go(
                parentPage(),
              )
            }
          >
            <Text style={[s.body, { color: p.text }]}>‹</Text>
          </Pressable>
        )}
        <View style={s.headerTitle}>
          <Text style={[s.heading, { color: p.text }]}>{titles[page]}</Text>
          {page === 'home' && (
            <Text style={[s.hint, { color: p.muted }]}>
              {tr('版本', 'Version')} {displayVersion}
            </Text>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          style={s.smallButton}
          onPress={() =>
            globalSettings({ locale: settings.locale === 'zh' ? 'en' : 'zh' })
          }
        >
          <Text style={{ color: p.accent }}>
            {settings.locale === 'zh' ? 'EN' : '中文'}
          </Text>
        </Pressable>
      </View>
      {autoFeedbackKinds.length > 0 && <View style={s.preferenceTop}>
        {autoFeedbackKinds.map(autoFeedback)}
        {preferenceKind && notices}
      </View>}
      {active && page !== 'session' && !preferenceKind && (
        <Button
          secondary
          p={p}
          label={tr('对话进行中 · 返回', 'Session active · Return')}
          onPress={() => go('session')}
        />
      )}
      {page === 'session' && (
        <View style={s.sessionLayout}>
          {notices}
          <View style={s.sessionMeta}>
            <Text
              accessibilityLiveRegion="polite"
              style={[s.sessionTitle, { color: p.text }]}
            >
              {labels[status] || status}
            </Text>
            <Text style={[s.hint, { color: p.muted }]}>
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
            </Text>
            <Text style={[s.hint, {color: p.muted}]}>
              {tr('声音', 'Audio')} · {({system: tr('系统默认', 'System default'), speaker: tr('内置麦克风与扬声器', 'Built-in mic & speaker'), receiver: tr('内置麦克风与听筒', 'Built-in mic & earpiece'), headphones: tr('耳机 / 外接设备', 'Headphones / external device'), bluetooth: tr('蓝牙设备', 'Bluetooth device')})[audioOutput]} · {tr('自动', 'Automatic')}
            </Text>
            {backendStatus === 'working' && (
              <Text style={[s.hint, { color: p.accent }]}>
                {tr('后端正在处理…', 'Backend is working…')}
              </Text>
            )}
            {!!recordingLabel() && (
              <Text
                accessibilityLiveRegion="polite"
                style={[s.hint, { color: p.accent }]}
              >
                {recordingLabel()}
              </Text>
            )}
          </View>
          <View style={[s.transcriptHeader, { borderColor: p.border }]}>
            <Text style={[s.label, { color: p.text }]}>
              {tr('实时字幕', 'Live transcript')}
            </Text>
          </View>
          <LiveTranscriptScroll
            sessionKey={transcriptSessionKey.current}
            testID="live-transcript"
            style={s.transcriptScroll}
            contentContainerStyle={s.transcriptContent}
          >
            {grouped(fragments).length === 0 ? (
              <Text style={[s.hint, { color: p.muted }]}>
                {status === 'connected'
                  ? tr('可以开始说话。', 'You can start speaking.')
                  : tr(
                      '连接后会在这里显示字幕。',
                      'The transcript will appear here when connected.',
                    )}
              </Text>
            ) : (
              transcriptView(fragments)
            )}
          </LiveTranscriptScroll>
          {sources.length > 0 && (
            <View style={{borderTopWidth: 1, borderColor: p.border, paddingHorizontal: 16}}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${tr('搜索来源', 'Search sources')} (${sources.length})`}
                accessibilityState={{expanded: sourcesExpanded}}
                testID="search-sources-toggle"
                onPress={() => setSourcesExpanded(value => !value)}
                style={{minHeight: 44, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}
              >
                <Text style={[s.hint, {color: p.muted}]}>{tr('搜索来源', 'Search sources')} ({sources.length})</Text>
                <Text style={[s.hint, {color: p.accent}]}>{sourcesExpanded ? tr('收起来源 ▴', 'Collapse sources ▴') : tr('展开来源 ▾', 'Expand sources ▾')}</Text>
              </Pressable>
              {sourcesExpanded && (
                <ScrollView testID="search-sources-list" nestedScrollEnabled style={{maxHeight: 160}}>
                  {sources.map((source, index) => (
                    <Text key={`${index}-${source.url}`} selectable style={[s.hint, {color: p.muted, paddingBottom: 10}]}>
                      {source.title}{'\n'}{source.url}
                    </Text>
                  ))}
                </ScrollView>
              )}
            </View>
          )}
          <View
            style={[
              s.sessionControls,
              { borderColor: p.border, backgroundColor: p.bg },
            ]}
          >
            {active ? (
              <>
                <View style={s.sessionActionRow}>
                  <SessionAction
                    p={p}
                    disabled={status !== 'connected'}
                    label={tr('对话设置', 'Conversation settings')}
                    onPress={() => go('voice')}
                  />
                  <SessionAction
                    p={p}
                    disabled={status !== 'connected'}
                    label={
                      muted ? tr('取消静音', 'Unmute') : tr('静音', 'Mute')
                    }
                    onPress={toggleSessionMute}
                  />
                  <SessionAction
                    p={p}
                    destructive
                    disabled={status === 'closing'}
                    label={tr('结束', 'End')}
                    onPress={() =>
                      void endSession().catch(e => setNotice(errorText(e)))
                    }
                  />
                </View>
              </>
            ) : (
              <Button
                p={p}
                label={tr('回到首页', 'Back to home')}
                onPress={() => go('home')}
              />
            )}
          </View>
        </View>
      )}
      {page !== 'session' && (
        <ScrollView
          key={page}
          contentContainerStyle={s.content}
          keyboardShouldPersistTaps="handled"
          scrollEnabled={!historySwipeActive}
        >
          {!preferenceKind && notices}
          {!ready ? (
            <>
              <Text style={[s.body, { color: p.text }]}>
                {bootFailed
                  ? tr(
                      '无法读取本机配置，原有数据没有被覆盖。',
                      'Could not read local configuration. Existing data was not overwritten.',
                    )
                  : tr('正在读取本机配置…', 'Reading local configuration…')}
              </Text>
              {bootFailed && (
                <Button
                  p={p}
                  label={tr('重试', 'Retry')}
                  onPress={() => void boot()}
                />
              )}
            </>
          ) : (
            <>
              {page === 'home' && (
                <>
                  <Text style={[s.hero, { color: p.text }]}>
                    {tr('想聊什么？', 'What’s on your mind?')}
                  </Text>
                  <Text style={[s.hint, {color: p.muted}]}>
                    {tr('面向 GPT-Live-1 模型的实时语音客户端', 'A real-time voice client for the GPT-Live-1 model')}
                  </Text>
                  <View
                    style={[
                      s.orb,
                      { borderColor: p.border, backgroundColor: p.surface },
                    ]}
                  >
                    <Text style={[s.orbText, { color: p.accent }]}>〰</Text>
                  </View>
                  <Button
                    p={p}
                    label={
                      controller.current
                        ? tr('返回对话', 'Return to conversation')
                        : connections.voice
                        ? tr('开始对话', 'Start conversation')
                        : tr('配置语音服务', 'Configure voice service')
                    }
                    disabled={busy}
                    onPress={() =>
                      connections.voice ? void run(startSession) : go('connections')
                    }
                  />
                  <Text
                    style={[s.hint, { color: p.muted, textAlign: 'center' }]}
                  >
                    {connections.voice
                      ? tr(
                          '准备好后，点一下即可开始。',
                          'When ready, tap once to begin.',
                        )
                      : tr(
                          '先配置语音服务，再开始对话。',
                          'Configure the voice service to get started.',
                        )}
                  </Text>
                  {recordingAvailable() && (
                    <Text
                      style={[s.hint, { color: p.muted, textAlign: 'center' }]}
                    >
                      {settings.recordingEnabled ? tr(
                        '对话自动录音 · 仅保存在此设备',
                        'Conversations are recorded · Saved on this device',
                      ) : tr('自动录音已关闭 · 仍保存文字历史', 'Recording off · Text history is still saved')}
                    </Text>
                  )}
                </>
              )}
              {page === 'settings' && (
                <>
                  <Row p={p} label={tr('对话设置', 'Conversation settings')}
                    value={tr('声音、指令、时长与录音', 'Voice, instructions, duration & recording')}
                    onPress={() => go('voice')} />
                  <Row p={p} label={tr('连接管理', 'Connections')}
                    value={tr('模型地址、密钥与扫码导入', 'Model endpoints, keys & QR import')}
                    onPress={() => go('connections')} />
                  {section('外观', 'Appearance')}
                  <View style={s.segment}>
                    {(['system', 'light', 'dark'] as const).map(
                      (theme, index) => (
                        <Pressable
                          key={theme}
                          accessibilityRole="button"
                          accessibilityState={{
                            selected: settings.theme === theme,
                          }}
                          style={[
                            s.segmentItem,
                            {
                              backgroundColor:
                                settings.theme === theme ? p.accent : p.surface,
                            },
                          ]}
                          onPress={() => globalSettings({ theme })}
                        >
                          <Text
                            style={[
                              s.label,
                              {
                                color:
                                  settings.theme === theme ? p.button : p.text,
                              },
                            ]}
                          >
                            {
                              [
                                tr('跟随系统', 'System'),
                                tr('浅色', 'Light'),
                                tr('深色', 'Dark'),
                              ][index]
                            }
                          </Text>
                        </Pressable>
                      ),
                    )}
                  </View>
                  {section('关于 Live Voice', 'About Live Voice')}
                  <View style={[s.aboutCard, { backgroundColor: p.surface, borderColor: p.border }]}>
                    <Text style={[s.body, {color: p.text}]}>{tr('专为 GPT-Live-1 实时语音模型使用。可连接独立的后端 LLM 提供推理与联网搜索。', 'Built for the GPT-Live-1 real-time voice model. Connect a separate backend LLM for reasoning and web search.')}</Text>
                    <Text style={[s.label, { color: p.muted }]}>{tr('版本号', 'Version')}</Text>
                    <Text selectable style={[s.body, { color: p.text }]}>
                      {displayVersion}
                    </Text>
                    <Text style={[s.label, { color: p.muted }]}>{tr('作者', 'Author')}</Text>
                    <Text selectable style={[s.body, { color: p.text }]}>kylefu8</Text>
                    <Text style={[s.label, { color: p.muted }]}>{tr('GitHub 仓库', 'GitHub repository')}</Text>
                    <Text selectable style={[s.body, { color: p.accent }]}>https://github.com/kylefu8/live-voice-app</Text>
                  </View>
                </>
              )}
              {page === 'voice' && <>
                {voicePage()}
                  {recordingAvailable() && (
                    <>
                      {section('录音', 'Recording')}
                      <Toggle
                        p={p}
                        label={tr('自动保存对话录音', 'Automatically record conversations')}
                        value={settings.recordingEnabled}
                        disabled={busy || active}
                        onChange={value => void run(() => saveRecordingPreference(value))}
                      />
                      <Text style={[s.hint, { color: p.muted }]}>
                        {tr(
                          active ? '录音开关在会话结束后可修改，当前录音保持不变。' : '从下一次会话生效。开启后保存双方声音，仅存于此设备；关闭不影响文字历史或已有录音。',
                          active ? 'Recording can be changed after the conversation ends. Current recording stays unchanged.' : 'Applies to the next conversation. Saves both voices on this device. Turning it off keeps text history and existing recordings.',
                        )}
                      </Text>
                    </>
                  )}
                <Row p={p} label={tr('后端推理参数', 'Backend reasoning')}
                  value={tr('推理强度、联网搜索与输出长度', 'Reasoning, web search & output limit')}
                  onPress={() => go('backend')} />
              </>}
              {page === 'connections' && <>
                <Text style={[s.hint, {color: p.muted}]}>
                  {tr('语音连接用于 GPT-Live-1 模型，后端 LLM 单独配置。首次使用可扫码导入，也可手动编辑并测试。', 'The voice connection is for GPT-Live-1; configure the backend LLM separately. Import a QR code or edit and test manually for first-time setup.')}
                </Text>
                <Row p={p} disabled={active} label={tr('扫码导入连接', 'Import connections from QR')}
                  value={active ? tr('请先结束当前会话', 'End the current conversation first') : tr('来自电脑端的加密二维码', 'Encrypted QR from your computer')}
                  onPress={() => go('qr')} />
                {connectionSection('voice')}
                {connectionSection('backend')}
                {active && <Text style={[s.hint, {color: p.muted}]}>
                  {tr('通话中暂停扫码和连接测试。语音连接的修改从下一次会话生效。', 'QR import and connection tests are unavailable during a call. Voice connection changes apply next session.')}
                </Text>}
              </>}

              {page === 'backend' && backendPage()}
              {page === 'qr' && (
                <QrImportScreen
                  palette={p}
                  settings={savedSettings.current}
                  formatError={code => errorText(new Error(code))}
                  onImported={importedConnections}
                  onCommitChange={value => {
                    importCommittingRef.current = value;
                    if (mounted.current) setImportCommitting(value);
                  }}
                />
              )}
              {page === 'history' && (
                <>
                  <Text style={[s.hint, { color: p.muted }]}>
                    {Platform.OS === 'ios'
                      ? tr('向左滑动会话可改名、删除录音或删除整条记录。', 'Swipe left on a conversation to rename it, delete its recording or delete the entire record.')
                      : tr('长按会话可改名、删除录音或删除整条记录。', 'Long-press a conversation to rename it, delete its recording or delete the entire record.')}
                    {' '}{tr('启用后端时，保存后会发送简短文字摘录生成名称，产生少量用量；失败则使用日期。', 'With the backend enabled, a short excerpt is sent to create a title, using some service quota; dates are used if naming fails.')}
                  </Text>
                  {recordingAvailable() && (
                    <Text style={[s.hint, { color: p.muted }]}>
                      {tr(
                        '录音保留到你手动删除，点击会话即可回放。',
                        'Recordings stay until you delete them. Open a conversation to listen.',
                      )}
                    </Text>
                  )}
                  {records.length === 0 ? (
                    <Text style={[s.hint, { color: p.muted }]}>
                      {tr(
                        '尚无记录，结束一次对话后会显示在这里。',
                        'No records yet. Finished conversations appear here.',
                      )}
                    </Text>
                  ) : (
                    records.map(record => {
                      const row = (
                      <Row
                        testID={`history-row-${record.id}`}
                        p={p}
                        label={recordTitle(record)}
                        accessibilityHint={Platform.OS === 'ios'
                          ? tr('向左滑动显示快捷操作', 'Swipe left for conversation actions')
                          : tr('长按打开会话快捷操作', 'Long-press for conversation actions')}
                        onActions={busy || active ? undefined : () => openHistoryActions(record)}
                        onLongPress={Platform.OS === 'ios' || busy || active ? undefined : () => openHistoryActions(record)}
                        value={`${
                          record.recording ? tr('录音 · ', 'Audio · ') : ''
                        }${Math.floor(
                          (record.recording
                            ? record.recording.durationMs / 1000
                            : record.durationSeconds) / 60,
                        )}:${String(
                          Math.floor(
                            (record.recording
                              ? record.recording.durationMs / 1000
                              : record.durationSeconds) % 60,
                          ),
                        ).padStart(2, '0')}`}
                        onPress={() => {
                          if (openHistoryRow === record.id) {
                            setOpenHistoryRow(null);
                            return;
                          }
                          setSelected(record);
                          go('detail');
                        }}
                      />
                      );
                      return Platform.OS === 'ios' ? (
                        <SwipeHistoryRow
                          key={record.id}
                          open={openHistoryRow === record.id}
                          enabled={!busy && !active}
                          onOpenChange={open => setOpenHistoryRow(current => open ? record.id : current === record.id ? null : current)}
                          onSwipeActiveChange={setHistorySwipeActive}
                          palette={p}
                          actions={[
                            {id: `${record.id}-rename`, label: tr('改名', 'Rename'), onPress: () => openHistoryActions(record, 'rename')},
                            ...(record.recording ? [{id: `${record.id}-audio`, label: tr('删除录音', 'Delete audio'), onPress: () => openHistoryActions(record, 'confirmAudio')}] : []),
                            {id: `${record.id}-delete`, label: tr('删除记录', 'Delete record'), onPress: () => openHistoryActions(record, 'confirmRecord')},
                          ]}
                        >{row}</SwipeHistoryRow>
                      ) : <React.Fragment key={record.id}>{row}</React.Fragment>;
                    })
                  )}
                  {moreRecordings && (
                    <Button
                      p={p}
                      secondary
                      disabled={busy}
                      label={tr('加载更早录音', 'Load older recordings')}
                      onPress={() => void run(loadMoreRecordings)}
                    />
                  )}
                </>
              )}
              {page === 'detail' && selected && (
                <>
                  <Text style={[s.modalTitle, { color: p.text }]}>{recordTitle(selected)}</Text>
                  <Text style={[s.hint, { color: p.muted }]}>
                    {new Date(selected.startedAt).toLocaleString(settings.locale === 'zh' ? 'zh-CN' : 'en-GB')}
                  </Text>
                  {renameDraft !== null ? (
                    <>
                      <Field p={p} label={tr('会话名称', 'Conversation name')} value={renameDraft} onChange={setRenameDraft} />
                      <Text style={[s.hint, {color: p.muted}]}>{tr('1–60 个字符', '1–60 characters')}</Text>
                      <View style={s.segment}>
                        <Button p={p} label={tr('保存名称', 'Save name')} disabled={busy || active} onPress={() => void run(renameSelected)} />
                        <Button p={p} label={tr('取消', 'Cancel')} disabled={busy} onPress={() => setRenameDraft(null)} />
                      </View>
                    </>
                  ) : (
                    <View style={s.segment}>
                      <Button p={p} label={tr('改名', 'Rename')} disabled={busy || active} onPress={() => setRenameDraft(selected.title || '')} />
                      <Button p={p} label={tr('删除会话', 'Delete conversation')} disabled={busy || active} onPress={confirmDeleteSelected} />
                    </View>
                  )}
                  {selected.recording ? (
                    <RecordingPlayer
                      key={selected.recording.id}
                      recording={selected.recording}
                      palette={p}
                      locale={settings.locale}
                      disabled={active}
                      onDeleted={() => void run(recordingDeleted)}
                    />
                  ) : (
                    <Text style={[s.hint, { color: p.muted }]}>
                      {tr(
                        '这次会话没有保存录音。',
                        'No audio was saved for this conversation.',
                      )}
                    </Text>
                  )}
                  <Text style={[s.hint, { color: p.muted }]}>
                    {selected.confirmedClose
                      ? tr('会话已结束', 'Session finalized')
                      : tr(
                          '本地记录 · 服务端结束状态未确认',
                          'Local record · server closure unconfirmed',
                        )}
                  </Text>
                  {transcriptView(selected.fragments)}
                  {!selected.fragments.length && (
                    <Text style={[s.hint, { color: p.muted }]}>
                      {tr(
                        '没有可用的文字记录，可播放上方录音。',
                        'No text is available. You can listen to the recording above.',
                      )}
                    </Text>
                  )}
                </>
              )}
            </>
          )}
        </ScrollView>
      )}
      {ready && bottomNavigation()}
      <HistoryActions
        record={historyActionRecord}
        title={historyActionRecord ? recordTitle(historyActionRecord) : ''}
        locale={settings.locale}
        palette={p}
        busy={busy}
        disabled={active}
        error={historyActionError}
        initialPanel={historyActionPanel}
        onClose={() => { if (!busy) setHistoryActionRecord(null); }}
        onRename={title => runHistoryAction(record => renameHistoryItem(record, title))}
        onDeleteRecording={() => runHistoryAction(record => deleteHistoryItem(record, 'audio'))}
        onDeleteRecord={() => runHistoryAction(record => deleteHistoryItem(record, 'conversation'))}
      />
      <Modal
        visible={!!picker}
        transparent
        animationType="fade"
        onRequestClose={() => setPicker(null)}
      >
        <View style={s.shade}>
          <View style={[s.modal, { backgroundColor: p.bg }]}>
            <Text style={[s.modalTitle, { color: p.text }]}>
              {picker?.title}
            </Text>
            <ScrollView>
              {picker?.options.map(option => (
                <Pressable
                  key={option.value}
                  accessibilityRole="button"
                  accessibilityState={{
                    selected: picker.selected === option.value,
                  }}
                  style={[s.row, { borderColor: p.border }]}
                  onPress={() => {
                    picker.choose(option.value);
                    setPicker(null);
                  }}
                >
                  <Text
                    style={[
                      s.body,
                      {
                        color:
                          picker.selected === option.value ? p.accent : p.text,
                      },
                    ]}
                  >
                    {option.label}
                    {picker.selected === option.value ? ' ✓' : ''}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <Button
              secondary
              p={p}
              label={tr('取消', 'Cancel')}
              onPress={() => setPicker(null)}
            />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
    </EdgeBackGesture>
  );
}
const s = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  headerTitle: { flex: 1 },
  heading: { fontSize: 20, fontWeight: '700' },
  smallButton: {
    minWidth: 48,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: { padding: 20, gap: 16, paddingBottom: 50 },
  aboutCard: { padding: 16, gap: 8, borderRadius: 16, borderWidth: 1 },
  body: { fontSize: 16, lineHeight: 25 },
  label: { fontSize: 14, fontWeight: '600' },
  hint: { fontSize: 13, lineHeight: 21 },
  section: { fontSize: 13, fontWeight: '700', marginTop: 14 },
  button: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
  sessionAction: {
    flex: 1,
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sessionActionText: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  field: { gap: 8, marginVertical: 8 },
  input: { borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 15 },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: { fontSize: 15, fontWeight: '600', flex: 1 },
  entryLabel: { flex: 0, flexShrink: 1, maxWidth: '45%' },
  card: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 14 },
  cardInner: { paddingVertical: 12, gap: 12 },
  notice: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    fontSize: 13,
    lineHeight: 21,
  },
  hero: { fontSize: 29, fontWeight: '700', lineHeight: 38, marginTop: 14 },
  orb: {
    width: 132,
    height: 132,
    borderRadius: 66,
    borderWidth: 2,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 16,
  },
  orbText: { fontSize: 54 },
  segment: { flexDirection: 'row', gap: 6 },
  segmentItem: {
    flex: 1,
    minHeight: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 6,
  },
  sessionTitle: { fontSize: 22, fontWeight: '700' },
  sessionLayout: { flex: 1, paddingHorizontal: 20 },
  sessionMeta: { gap: 5, paddingTop: 10, paddingBottom: 8 },
  transcriptHeader: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  transcriptScroll: { flex: 1 },
  transcriptContent: { paddingBottom: 12 },
  sessionControls: {
    gap: 8,
    paddingTop: 10,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sessionActionRow: { flexDirection: 'row', gap: 8 },
  preferenceTop: { paddingHorizontal: 20, paddingBottom: 8, gap: 8 },
  bottomNav: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    minHeight: 68,
    paddingHorizontal: 8,
    paddingBottom: 4,
  },
  navItem: {
    flex: 1,
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  navIcon: { fontSize: 19, lineHeight: 24 },
  navLabel: { fontSize: 12, fontWeight: '600' },
  turn: { gap: 6, paddingVertical: 12, borderBottomWidth: 1 },
  shade: {
    flex: 1,
    backgroundColor: '#0008',
    justifyContent: 'center',
    padding: 24,
  },
  modal: { maxHeight: '80%', padding: 20, borderRadius: 22, gap: 16 },
  modalTitle: { fontSize: 20, fontWeight: '700' },
});
export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}
