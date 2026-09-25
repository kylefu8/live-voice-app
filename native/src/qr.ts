import {
  AppState,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import type { ImportedCredentials } from './qr-import';

type QrBridge = {
  scan(locale: string): Promise<string>;
  decrypt(
    payload: string,
    passphrase: string,
  ): Promise<{ version: 1; connections: ImportedCredentials }>;
  cancel(): Promise<null>;
};
function bridge(): QrBridge {
  if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || !NativeModules.QrConfig)
    throw new Error('qr_unavailable');
  return NativeModules.QrConfig as QrBridge;
}
export async function scanQr(
  locale: 'zh' | 'en',
  signal: AbortSignal,
): Promise<string> {
  const native = bridge();
  if (signal.aborted) throw new Error('qr_cancelled');
  if (Platform.OS === 'android') {
    const permission = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.CAMERA,
    );
    if (signal.aborted) throw new Error('qr_cancelled');
    if (permission !== PermissionsAndroid.RESULTS.GRANTED)
      throw new Error('camera_permission');
  }
  if (AppState.currentState !== 'active') throw new Error('app_inactive');
  return native.scan(locale);
}
export function decryptQr(payload: string, passphrase: string) {
  return bridge().decrypt(payload, passphrase);
}
export async function cancelQr() {
  if ((Platform.OS === 'android' || Platform.OS === 'ios') && NativeModules.QrConfig)
    await bridge().cancel();
}
