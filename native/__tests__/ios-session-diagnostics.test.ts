export {};
const mockPlatform = {OS: 'ios'};
const mockBridge = {
  diagnosticAudio: jest.fn(async () => ({micFrames: 480, micPeak: 0.1})),
  writeDiagnostic: jest.fn(async (_snapshot: unknown) => undefined),
};
jest.mock('react-native', () => ({Platform: mockPlatform, NativeModules: {VoiceAudio: mockBridge}}));
const {startIosSessionDiagnostics} = require('../src/ios-session-diagnostics');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => {
  jest.useFakeTimers();
  mockPlatform.OS = 'ios';
  mockBridge.diagnosticAudio.mockReset().mockResolvedValue({micFrames: 480, micPeak: 0.1});
  mockBridge.writeDiagnostic.mockReset().mockResolvedValue(undefined);
});
afterEach(() => jest.useRealTimers());

test('records only numeric audio stats, stops polling at finish, and never forwards addresses', async () => {
  const trace = startIosSessionDiagnostics();
  const peer = {getStats: jest.fn(async () => new Map([
    ['audio', {type: 'outbound-rtp', kind: 'audio', packetsSent: 42, bytesSent: 900, address: 'private'}],
    ['candidate', {type: 'candidate-pair', address: 'private', packetsSent: 99}],
  ]))};
  trace.attachPeer(peer);
  await flush();
  jest.advanceTimersByTime(2000);
  await flush();
  trace.finish();
  await flush();
  const output = JSON.stringify(mockBridge.writeDiagnostic.mock.calls);
  expect(output).toContain('42');
  expect(output).not.toContain('private');
  expect(output).not.toContain('candidate');
  const calls = peer.getStats.mock.calls.length;
  jest.advanceTimersByTime(60000);
  await flush();
  expect(peer.getStats).toHaveBeenCalledTimes(calls);
  expect(jest.getTimerCount()).toBe(0);
});

test('stale async samples cannot overwrite a newer session and failures remain nonfatal', async () => {
  let complete!: (value: any) => void;
  mockBridge.diagnosticAudio.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const old = startIosSessionDiagnostics();
  await flush();
  const next = startIosSessionDiagnostics();
  await flush();
  const calls = mockBridge.writeDiagnostic.mock.calls.length;
  complete({micFrames: 12345});
  await flush();
  expect(mockBridge.writeDiagnostic).toHaveBeenCalledTimes(calls);
  mockBridge.diagnosticAudio.mockRejectedValue(new Error('ignored'));
  jest.advanceTimersByTime(2000);
  await flush();
  old.finish();
  next.finish();
  await flush();
  expect(jest.getTimerCount()).toBe(0);
});

test('polling is bounded and other platforms do no diagnostic work', async () => {
  mockPlatform.OS = 'android';
  expect(startIosSessionDiagnostics()).toBeNull();
  expect(mockBridge.diagnosticAudio).not.toHaveBeenCalled();
  mockPlatform.OS = 'ios';
  const trace = startIosSessionDiagnostics();
  await flush();
  for (let i = 0; i < 40; i++) { jest.advanceTimersByTime(2000); await flush(); }
  expect(mockBridge.diagnosticAudio).toHaveBeenCalledTimes(30);
  expect(jest.getTimerCount()).toBe(0);
  trace.finish();
  await flush();
});
