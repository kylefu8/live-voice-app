const mockSetBundle = jest.fn(async (_json: string) => undefined);
const mockIosPlatform = {OS: 'ios'};
const mockReactNative = {
  NativeModules: {
    SecureConnections: {setBundle: mockSetBundle},
  },
  Platform: mockIosPlatform,
};

jest.mock('react-native', () => mockReactNative);

const {writeIosConnectionsBundle} = require(
  '../src/ios-secure-connections',
) as typeof import('../src/ios-secure-connections');

const bundle = JSON.stringify({
  version: 2,
  connections: {voice: null, backend: null},
});

beforeEach(() => {
  mockIosPlatform.OS = 'ios';
  mockSetBundle.mockReset();
  mockSetBundle.mockResolvedValue(undefined);
  mockReactNative.NativeModules.SecureConnections = {
    setBundle: mockSetBundle,
  };
});

test('writes the complete bundle through the iOS bridge', async () => {
  await expect(writeIosConnectionsBundle(bundle)).resolves.toBeUndefined();
  expect(mockSetBundle).toHaveBeenCalledWith(bundle);
});

test('does not fall back when the native bridge is unavailable', async () => {
  mockReactNative.NativeModules.SecureConnections = undefined as never;
  await expect(writeIosConnectionsBundle(bundle)).rejects.toThrow(
    'storage_failed',
  );
  expect(mockSetBundle).not.toHaveBeenCalled();
});

test('maps native failures to the fixed storage error', async () => {
  mockSetBundle.mockRejectedValue(new Error('private keychain detail'));
  await expect(writeIosConnectionsBundle(bundle)).rejects.toThrow(
    'storage_failed',
  );
});

test('does not expose a non-iOS fallback path', async () => {
  mockIosPlatform.OS = 'android';
  await expect(writeIosConnectionsBundle(bundle)).rejects.toThrow(
    'storage_failed',
  );
  expect(mockSetBundle).not.toHaveBeenCalled();
});
