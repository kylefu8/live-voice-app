import {DeviceEventEmitter, NativeEventEmitter, NativeModules, Platform} from 'react-native';

export type AudioOutput = 'system' | 'speaker' | 'receiver' | 'headphones' | 'bluetooth';

type VoiceAudioNative = {
  requestPermission?: () => Promise<void>;
  start: () => Promise<void>;
  conversationConnected: () => Promise<void>;
  getRoute: () => Promise<{output: AudioOutput}>;
  stop: () => Promise<void>;
};

export async function requestAudioPermission(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const module = nativeAudio();
  if (!module.requestPermission) throw new Error('audio_module_unavailable');
  await module.requestPermission();
}

function nativeAudio(): VoiceAudioNative {
  const module = NativeModules.VoiceAudio as VoiceAudioNative | undefined;
  if (
    module === undefined ||
    typeof module.start !== 'function' ||
    typeof module.conversationConnected !== 'function' ||
    typeof module.stop !== 'function'
  ) {
    throw new Error('audio_module_unavailable');
  }
  return module;
}

/** Configure the platform voice route before the WebRTC session starts. */
export async function startAudio(): Promise<void> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return;
  }
  await nativeAudio().start();
}

/** Enable proximity only after connection, so sensor blanking cannot cancel startup. */
export async function markAudioConnected(): Promise<void> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return;
  }
  await nativeAudio().conversationConnected();
}

export function observeAudioRoute(onRoute: (output: AudioOutput) => void, onFailure: () => void): () => void {
  const module = NativeModules.VoiceAudio;
  if (!module || (Platform.OS !== 'ios' && Platform.OS !== 'android')) return () => {};
  const emitter = Platform.OS === 'ios' ? new NativeEventEmitter(module) : DeviceEventEmitter;
  let observing = true;
  let receivedRouteEvent = false;
  const publish = (value: {output?: string}) => {
    if (observing && ['system', 'speaker', 'receiver', 'headphones', 'bluetooth'].includes(value?.output ?? '')) onRoute(value.output as AudioOutput);
  };
  const changed = emitter.addListener('VoiceAudioRouteChanged', value => { receivedRouteEvent = true; publish(value); });
  const failed = emitter.addListener('VoiceAudioRouteFailed', onFailure);
  void module.getRoute?.().then((value: {output?: string}) => { if (!receivedRouteEvent) publish(value); }).catch(() => {});
  return () => { observing = false; changed.remove(); failed.remove(); };
}

/** Release the platform route and restore the previous audio session state. */
export async function stopAudio(): Promise<void> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return;
  }
  await nativeAudio().stop();
}
