const mockScan = jest.fn(async () => 'synthetic-payload');
const mockPermission = jest.fn();
const mockAppState = { currentState: 'active' };
const mockPlatform = { OS: 'android' };
jest.mock('react-native', () => ({
  AppState: mockAppState,
  NativeModules: { QrConfig: { scan: mockScan } },
  PermissionsAndroid: {
    PERMISSIONS: { CAMERA: 'camera' },
    RESULTS: { GRANTED: 'granted' },
    request: mockPermission,
  },
  Platform: mockPlatform,
}));
const {scanQr} = require('../src/qr') as typeof import('../src/qr');

beforeEach(() => {
  mockScan.mockClear();
  mockPermission.mockReset();
  mockAppState.currentState = 'active';
  mockPlatform.OS = 'android';
});
test('a late permission grant cannot open the camera after cancellation', async () => {
  let allow!: (value: string) => void;
  mockPermission.mockImplementation(
    () =>
      new Promise(resolve => {
        allow = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = scanQr('zh', controller.signal);
  controller.abort();
  allow('granted');
  await expect(pending).rejects.toThrow('qr_cancelled');
  expect(mockScan).not.toHaveBeenCalled();
});

test('iOS delegates camera permission and scanning to the native bridge', async () => {
  mockPlatform.OS = 'ios';
  const { scanQr } = require('../src/qr') as typeof import('../src/qr');
  await expect(scanQr('en', new AbortController().signal)).resolves.toBe(
    'synthetic-payload',
  );
  expect(mockPermission).not.toHaveBeenCalled();
  expect(mockScan).toHaveBeenCalledWith('en');
});
test('denied permission and a backgrounded app never open the camera', async () => {
  mockPermission.mockResolvedValue('denied');
  await expect(scanQr('zh', new AbortController().signal)).rejects.toThrow(
    'camera_permission',
  );
  mockPermission.mockResolvedValue('granted');
  mockAppState.currentState = 'background';
  await expect(scanQr('zh', new AbortController().signal)).rejects.toThrow(
    'app_inactive',
  );
  expect(mockScan).not.toHaveBeenCalled();
});
