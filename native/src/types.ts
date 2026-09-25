export type Kind = 'voice' | 'backend';
export type Locale = 'zh' | 'en';
// Legacy history/recording metadata can still contain practice; new sessions use general.
export type Mode = 'general' | 'practice';
export type Auth = 'bearer' | 'api-key';
export interface Credential {endpoint: string; model: string; auth: Auth; apiKey: string}
export interface Connection {endpoint: string; model: string; auth: Auth; keyMask: string}
export interface VoicePreferences {
  voice: string;
  tone: 'natural' | 'warm' | 'relaxed' | 'professional';
  intonation: 'natural' | 'steady' | 'expressive';
  pace: 'normal' | 'slow' | 'brisk';
  minutes: number;
  instructions: string;
}
export interface BackendPreferences {
  enabled: boolean;
  effort: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxOutputTokens: number;
  webSearch: boolean;
  timeoutSeconds: number;
  instructions: string;
}
export interface Settings {
  locale: Locale;
  theme: 'system' | 'light' | 'dark';
  mode: Mode;
  recordingEnabled: boolean;
  voice: VoicePreferences;
  backend: BackendPreferences;
}
export interface TranscriptFragment {
  role: 'user' | 'assistant';
  text: string;
  startMs: number;
  endMs: number;
}
export interface ConversationRecord {
  id: string;
  title?: string;
  titleSource?: 'manual' | 'auto';
  mode: Mode;
  startedAt: number;
  durationSeconds: number;
  confirmedClose: boolean;
  fragments: TranscriptFragment[];
  /** Runtime association with the native recording catalog; absent for old/text-only records. */
  recording?: RecordingInfo;
}
export interface RecordingInfo {
  id: string;
  mode: Mode;
  startedAt: number;
  durationMs: number;
  sizeBytes: number;
  confirmedClose: boolean;
  errorCode?: string;
}
export type SessionStatus = 'idle' | 'connecting' | 'connected' | 'closing' | 'closed';
export interface SessionConfig {
  mode: Mode;
  voiceCredential: Credential;
  backendCredential: Credential | null;
  voice: VoicePreferences;
  backend: BackendPreferences;
}
/** Preferences that may be applied while an active Live session is running. */
export interface LivePreferencesUpdate {
  /** Voice is applied as a mutable speaking-style instruction. The voice id itself stays fixed for the session. */
  voice?: VoicePreferences;
  /** Backend preferences affect the next client delegation. */
  backend?: BackendPreferences;
  /** Omit to keep the current backend credential; null explicitly clears it. */
  backendCredential?: Credential | null;
}
export interface LiveCallbacks {
  onStatus: (status: SessionStatus) => void;
  onTranscript: (fragment: TranscriptFragment) => void;
  onError: (code: string) => void;
  onBackendStatus: (status: 'idle' | 'working' | 'done' | 'error') => void;
  onSources: (sources: {title: string; url: string}[]) => void;
  onClosed: (confirmed: boolean) => void;
}
export interface LiveController {
  connect: (config: SessionConfig) => Promise<void>;
  close: () => Promise<boolean>;
  dispose: () => void;
  setMuted: (muted: boolean) => void;
  appendStyle: (preferences: VoicePreferences) => Promise<void>;
  updatePreferences: (update: LivePreferencesUpdate) => Promise<void>;
}
