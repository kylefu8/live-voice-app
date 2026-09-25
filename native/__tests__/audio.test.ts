export {};

const mockNative = {
  requestPermission: jest.fn(async () => undefined),
  start: jest.fn(async () => undefined),
  conversationConnected: jest.fn(async () => undefined),
  getRoute: jest.fn<Promise<{output: string}>, []>(async () => ({output:'system'})),
  stop: jest.fn(async () => undefined),
};
const mockPlatform = {OS: 'android'};
const mockListeners = new Map<string, (value: any) => void>();
const mockEmitter = {addListener: (name: string, listener: (value: any) => void) => {
  mockListeners.set(name, listener); return {remove: () => mockListeners.delete(name)};
}};

jest.mock('react-native', () => ({
  NativeModules: {VoiceAudio: mockNative},
  Platform: mockPlatform,
  DeviceEventEmitter: mockEmitter,
  NativeEventEmitter: jest.fn(() => mockEmitter),
}));

const audio = require('../src/audio') as typeof import('../src/audio');

beforeEach(() => {
  mockPlatform.OS = 'android';
  mockNative.requestPermission.mockClear().mockResolvedValue(undefined);
  mockNative.start.mockClear().mockResolvedValue(undefined);
  mockNative.conversationConnected.mockClear().mockResolvedValue(undefined);
  mockNative.stop.mockClear().mockResolvedValue(undefined);
  mockListeners.clear();
  mockNative.getRoute.mockReset().mockResolvedValue({output:'system'});
});

test.each(['android', 'ios'])('%s observes route changes, rejects unknown labels and unsubscribes', async platform => {
  mockPlatform.OS = platform;
  const route=jest.fn(), failure=jest.fn();
  const stop=audio.observeAudioRoute(route,failure);
  await Promise.resolve();
  mockListeners.get('VoiceAudioRouteChanged')?.({output:'bluetooth'});
  mockListeners.get('VoiceAudioRouteChanged')?.({output:'untrusted-device-name'});
  mockListeners.get('VoiceAudioRouteFailed')?.(null);
  expect(route.mock.calls.map(args=>args[0])).toEqual(['system','bluetooth']);
  expect(failure).toHaveBeenCalledTimes(1);
  stop();expect(mockListeners.size).toBe(0);
});

test('a delayed initial route cannot overwrite a newer hardware event', async () => {
  let finish!: (value:{output:string}) => void;
  mockNative.getRoute.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const route=jest.fn();const stop=audio.observeAudioRoute(route,()=>{});
  mockListeners.get('VoiceAudioRouteChanged')?.({output:'bluetooth'});
  finish({output:'speaker'});await Promise.resolve();
  expect(route.mock.calls.map(args=>args[0])).toEqual(['bluetooth']);stop();
});

test('iOS permission preflight is separate from session activation', async () => {
  mockPlatform.OS = 'ios';
  await audio.requestAudioPermission();
  expect(mockNative.requestPermission).toHaveBeenCalledTimes(1);
  expect(mockNative.start).not.toHaveBeenCalled();
});

test.each(['android', 'ios'])('%s dispatches all audio operations to VoiceAudio', async platform => {
  mockPlatform.OS = platform;
  await audio.startAudio();
  await audio.markAudioConnected();
  await audio.stopAudio();
  expect(mockNative.start).toHaveBeenCalledTimes(1);
  expect(mockNative.conversationConnected).toHaveBeenCalledTimes(1);
  expect(mockNative.stop).toHaveBeenCalledTimes(1);
});

test('an iOS native permission failure reaches the caller unchanged', async () => {
  mockPlatform.OS = 'ios';
  const error = Object.assign(new Error('permission'), {code: 'mic_permission'});
  mockNative.start.mockRejectedValue(error);
  await expect(audio.startAudio()).rejects.toBe(error);
});

test.each(['android', 'ios'])('%s reports an unavailable native module', async platform => {
  mockPlatform.OS = platform;
  const modules = require('react-native').NativeModules as {
    VoiceAudio?: unknown;
  };
  modules.VoiceAudio = undefined;
  await expect(audio.startAudio()).rejects.toThrow('audio_module_unavailable');
  modules.VoiceAudio = mockNative;
});

test('unsupported platforms retain the no-op behavior', async () => {
  mockPlatform.OS = 'web';
  const modules = require('react-native').NativeModules as {
    VoiceAudio?: unknown;
  };
  modules.VoiceAudio = undefined;
  await expect(audio.startAudio()).resolves.toBeUndefined();
  await expect(audio.markAudioConnected()).resolves.toBeUndefined();
  await expect(audio.stopAudio()).resolves.toBeUndefined();
});
