import {NativeModules, Platform} from 'react-native';

export type SessionActivityState = {
  status: 'connecting' | 'connected' | 'closing';
  muted: boolean;
  recording: boolean;
  backendWorking: boolean;
  /** Unix epoch milliseconds, or null before the live session connects. */
  startedAt: number | null;
};

type SessionActivityNative = {
  start(identifier: string, locale: string, state: SessionActivityState): Promise<boolean>;
  update(identifier: string, state: SessionActivityState): Promise<void>;
  end(identifier: string): Promise<void>;
};

function bridge(): SessionActivityNative | null {
  if (Platform.OS !== 'ios') return null;
  const value = (NativeModules as {VoiceSessionActivity?: SessionActivityNative})
    .VoiceSessionActivity;
  if (
    !value ||
    typeof value.start !== 'function' ||
    typeof value.update !== 'function' ||
    typeof value.end !== 'function'
  ) {
    return null;
  }
  return value;
}

export const sessionActivity = {
  async start(identifier: string, locale: string, state: SessionActivityState): Promise<boolean> {
    return (await bridge()?.start(identifier, locale, state)) ?? false;
  },

  async update(identifier: string, state: SessionActivityState): Promise<void> {
    await bridge()?.update(identifier, state);
  },

  async end(identifier: string): Promise<void> {
    await bridge()?.end(identifier);
  },
};
