import {NativeModules, Platform} from 'react-native';

type SecureConnectionsBridge = {
  setBundle(json: string): Promise<void>;
};

const STORAGE_ERROR = 'storage_failed';

/**
 * Atomically replace the iOS v2 connection bundle in the Keychain.
 *
 * The native implementation updates the existing generic-password item and
 * only falls back to SecItemAdd when the item is absent. There is deliberately
 * no AsyncStorage or react-native-keychain fallback here: losing the previous
 * bundle after an unsuccessful write would make the two connections diverge.
 */
export async function writeIosConnectionsBundle(json: string): Promise<void> {
  if (Platform.OS !== 'ios') {
    throw new Error(STORAGE_ERROR);
  }

  const bridge = (NativeModules as {SecureConnections?: SecureConnectionsBridge})
    .SecureConnections;
  if (!bridge || typeof bridge.setBundle !== 'function') {
    throw new Error(STORAGE_ERROR);
  }

  try {
    await bridge.setBundle(json);
  } catch {
    // Do not expose native status, Keychain details, or the JSON bundle.
    throw new Error(STORAGE_ERROR);
  }
}
