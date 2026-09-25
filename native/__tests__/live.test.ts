const mockChannels: MockChannel[] = [];
const mockPeers: MockPeer[] = [];

class MockChannel {
  readyState = 'connecting';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: {data: string}) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }

  message(value: unknown): void {
    this.onmessage?.({data: JSON.stringify(value)});
  }

  close(): void {
    this.readyState = 'closed';
    this.onclose?.();
  }
}

class MockTrack {
  enabled = true;
  stopped = false;

  stop(): void {
    this.stopped = true;
  }
}

class MockStream {
  tracks = [new MockTrack()];

  getAudioTracks(): MockTrack[] {
    return this.tracks;
  }

  getTracks(): MockTrack[] {
    return this.tracks;
  }

  release(): void {
    this.tracks.forEach((track) => track.stop());
  }
}

class MockPeer {
  iceGatheringState = 'complete';
  iceConnectionState = 'new';
  connectionState = 'new';
  localDescription: {type: string; sdp: string} | null = null;
  closed = false;
  ontrack: ((event: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;

  constructor() {
    mockPeers.push(this);
  }

  createDataChannel(): MockChannel {
    const channel = new MockChannel();
    mockChannels.push(channel);
    return channel;
  }

  async createOffer(): Promise<{type: string; sdp: string}> {
    return {type: 'offer', sdp: 'v=0 synthetic'};
  }

  async setLocalDescription(description: {type: string; sdp: string}): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(): Promise<void> {}

  addTrack(): void {}

  close(): void {
    this.closed = true;
  }
}

jest.mock('react-native-webrtc', () => ({
  MediaStream: jest.fn(),
  RTCPeerConnection: jest.fn(),
  RTCSessionDescription: jest.fn((value: {type: string; sdp: string}) => value),
  mediaDevices: {
    getUserMedia: jest.fn(),
  },
}));

jest.mock('../src/backend', () => ({
  runBackendDelegation: jest.fn(),
}));

import {createLiveController, probeVoice} from '../src/live';
import {runBackendDelegation} from '../src/backend';
import {ErrorCode} from '../src/protocol';
import type {LiveCallbacks, SessionConfig} from '../src/types';
import {mediaDevices, RTCPeerConnection} from 'react-native-webrtc';

const config: SessionConfig = {
  mode: 'practice',
  voiceCredential: {
    endpoint: 'https://voice.example/v1',
    model: 'gpt-live-1',
    auth: 'bearer',
    apiKey: 'synthetic-voice-key',
  },
  backendCredential: null,
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
    effort: 'max',
    maxOutputTokens: 128,
    webSearch: false,
    timeoutSeconds: 5,
    instructions: '',
  },
};

function callbacks(): LiveCallbacks {
  return {
    onStatus: jest.fn(),
    onTranscript: jest.fn(),
    onError: jest.fn(),
    onBackendStatus: jest.fn(),
    onSources: jest.fn(),
    onClosed: jest.fn(),
  };
}

function response(): Response {
  return {
    ok: true,
    status: 201,
    json: async () => ({session: {id: 'live_synthetic'}, transport: {type: 'webrtc', sdp: 'v=0 answer'}}),
  } as Response;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

async function connectReady(
  controller: ReturnType<typeof createLiveController>,
  events?: LiveCallbacks,
  sessionConfig: SessionConfig = config,
): Promise<MockChannel> {
  const promise = controller.connect(sessionConfig);
  for (let attempt = 0; attempt < 20 && !mockChannels.length; attempt += 1) await flush();
  const channel = mockChannels[mockChannels.length - 1];
  if (!channel) {
    await expect(promise).resolves.toBeUndefined();
    throw new Error(`synthetic channel was not created: ${JSON.stringify({status: (events?.onStatus as jest.Mock | undefined)?.mock.calls, errors: (events?.onError as jest.Mock | undefined)?.mock.calls})}`);
  }
  channel.open();
  channel.message({type: 'session.started', session: {id: 'live_synthetic'}});
  await promise;
  return channel;
}

describe('Live direct controller', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    mockChannels.splice(0);
    mockPeers.splice(0);
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(new MockStream());
    (RTCPeerConnection as unknown as jest.Mock).mockImplementation(() => new MockPeer());
    fetchMock = jest.fn().mockResolvedValue(response());
    Object.defineProperty(globalThis, 'fetch', {configurable: true, value: fetchMock});
    (runBackendDelegation as jest.Mock).mockReset();
    (runBackendDelegation as jest.Mock).mockResolvedValue({text: 'synthetic backend result'});
  });

  test('waits for session.started and closes only after session.closed', async () => {
    const events = callbacks();
    const controller = createLiveController(events);
    const channel = await connectReady(controller, events);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      session: {model: 'gpt-live-1', delegation: {type: 'client'}},
      transport: {type: 'webrtc'},
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).session.store).toBe(false);
    // connectReady uses an old practice config: the actual request must be general.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).session.instructions).toContain('这是通用交流');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).session.instructions).not.toContain('口语练习');
    expect(channel.sent.some((value) => JSON.parse(value).type === 'session.start')).toBe(false);

    const closing = controller.close();
    expect(JSON.parse(channel.sent.at(-1) as string).type).toBe('session.close');
    channel.message({type: 'session.closed', usage: {seconds: 2}, reason: 'close_requested'});
    await expect(closing).resolves.toBe(true);
    expect(events.onClosed).toHaveBeenCalledTimes(1);
    expect(events.onClosed).toHaveBeenCalledWith(true);
  });

  test('dispose releases resources and ignores a late session response', async () => {
    let resolveFetch: ((value: Response) => void) | null = null;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const events = callbacks();
    const controller = createLiveController(events);
    const connecting = controller.connect(config);
    for (let attempt = 0; attempt < 20 && !mockPeers.length; attempt += 1) await flush();
    controller.dispose();
    expect(events.onClosed).toHaveBeenCalledWith(false);
    expect(mockPeers[0]?.closed).toBe(true);
    expect((events.onError as jest.Mock).mock.calls.some(([code]) => code === ErrorCode.SESSION_CANCELLED)).toBe(false);
    const resolveLate = resolveFetch as ((value: Response) => void) | null;
    if (resolveLate) resolveLate(response());
    await expect(connecting).resolves.toBeUndefined();
  });

  test('appendStyle uses instructions append and waits for its exact ack', async () => {
    const events = callbacks();
    const controller = createLiveController(events);
    const channel = await connectReady(controller, events);
    const append = controller.appendStyle({...config.voice, pace: 'slow'});
    await flush();
    const sent = JSON.parse(channel.sent.at(-1) as string);
    expect(sent.type).toBe('session.instructions.append');
    channel.message({type: 'session.instructions.appended', client_event_id: sent.event_id});
    await expect(append).resolves.toBeUndefined();
    controller.dispose();
  });

  test('hot voice updates append an explicit override and keep the negotiated voice immutable', async () => {
    const events = callbacks();
    const controller = createLiveController(events);
    const channel = await connectReady(controller, events);
    const update = controller.updatePreferences({
      voice: {...config.voice, voice: 'cedar', pace: 'slow'},
    });
    await flush();
    const sent = JSON.parse(channel.sent.at(-1) as string);
    expect(sent).toMatchObject({
      type: 'session.instructions.append',
      delegation_id: null,
    });
    expect(sent.content).toContain('包括启动时的偏好');
    expect(sent.content).toContain('稍慢');
    expect(sent.audio).toBeUndefined();
    channel.message({type: 'session.instructions.appended', client_event_id: sent.event_id});
    await expect(update).resolves.toBeUndefined();
    controller.dispose();
  });

  test('a rejected hot update leaves the local snapshot unchanged and concurrent updates serialize', async () => {
    const events = callbacks();
    const controller = createLiveController(events);
    const channel = await connectReady(controller, events);
    const first = controller.updatePreferences({voice: {...config.voice, pace: 'slow'}});
    const second = controller.updatePreferences({voice: {...config.voice, pace: 'brisk'}});
    await flush();
    const firstSent = JSON.parse(channel.sent.at(-1) as string);
    expect(firstSent.content).toContain('稍慢');
    channel.message({type: 'error', client_event_id: firstSent.event_id});
    await expect(first).rejects.toMatchObject({code: ErrorCode.COMMAND_REJECTED});

    await flush();
    const secondSent = JSON.parse(channel.sent.at(-1) as string);
    expect(secondSent.content).toContain('利落但清楚');
    channel.message({type: 'session.instructions.appended', client_event_id: secondSent.event_id});
    await expect(second).resolves.toBeUndefined();
    controller.dispose();
  });

  test('a queued update cannot apply to a replacement session', async () => {
    const events = callbacks();
    const controller = createLiveController(events);
    const firstChannel = await connectReady(controller, events);
    const first = controller.updatePreferences({voice: {...config.voice, pace: 'slow'}});
    const queued = controller.updatePreferences({voice: {...config.voice, pace: 'brisk'}});
    await flush();
    const firstSent = JSON.parse(firstChannel.sent.at(-1) as string);
    firstChannel.message({type: 'session.closed'});
    await expect(first).rejects.toMatchObject({code: ErrorCode.SESSION_CANCELLED});
    await expect(queued).rejects.toMatchObject({code: ErrorCode.SESSION_NOT_READY});

    const replacement = controller.connect(config);
    for (let attempt = 0; attempt < 20 && mockChannels.length < 2; attempt += 1) await flush();
    const secondChannel = mockChannels[mockChannels.length - 1];
    secondChannel.open();
    secondChannel.message({type: 'session.started', session: {id: 'live_synthetic'}});
    await replacement;
    expect(firstSent.type).toBe('session.instructions.append');
    expect(secondChannel.sent.some((value) => JSON.parse(value).type === 'session.instructions.append')).toBe(false);
    controller.dispose();
  });

  test('backend hot updates do not mutate an in-flight delegation snapshot', async () => {
    jest.useFakeTimers();
    try {
      let resolveDelegation: ((value: {text: string}) => void) | null = null;
      let delegationOptions: any = null;
      (runBackendDelegation as jest.Mock).mockImplementationOnce((options: any) => {
        delegationOptions = options;
        return new Promise<{text: string}>((resolve) => {
          resolveDelegation = resolve;
        });
      });
      const oldCredential = {
        endpoint: 'https://backend.example/v1',
        model: 'gpt-backend-old',
        auth: 'bearer' as const,
        apiKey: 'synthetic-old-key',
      };
      const newCredential = {...oldCredential, model: 'gpt-backend-new', apiKey: 'synthetic-new-key'};
      const oldBackend = {...config.backend, enabled: true};
      const sessionConfig: SessionConfig = {
        ...config,
        backendCredential: oldCredential,
        backend: oldBackend,
      };
      const events = callbacks();
      const controller = createLiveController(events);
      const connecting = controller.connect(sessionConfig);
      await flushMicrotasks();
      const channel = mockChannels[mockChannels.length - 1];
      expect(channel).toBeDefined();
      channel.open();
      channel.message({type: 'session.started', session: {id: 'live_synthetic'}});
      jest.advanceTimersByTime(20);
      await connecting;
      channel.message({type: 'session.delegation.created', delegation: {target: 'client', id: 'delegation-old'}});
      jest.advanceTimersByTime(250);
      await flushMicrotasks();
      expect(runBackendDelegation).toHaveBeenCalledTimes(1);
      expect(delegationOptions.credential).toEqual(oldCredential);
      expect(delegationOptions.preferences).toEqual(oldBackend);

      await expect(
        controller.updatePreferences({
          backend: {...oldBackend, maxOutputTokens: 1024, instructions: 'new backend style'},
          backendCredential: newCredential,
        }),
      ).resolves.toBeUndefined();
      expect(delegationOptions.credential).toEqual(oldCredential);
      expect(delegationOptions.preferences).toEqual(oldBackend);

      const finishDelegation = resolveDelegation as ((value: {text: string}) => void) | null;
      finishDelegation?.({text: 'old snapshot result'});
      await flushMicrotasks();
      const commentary = JSON.parse(channel.sent.at(-1) as string);
      expect(commentary.type).toBe('session.commentary.append');
      channel.message({type: 'session.commentary.appended', client_event_id: commentary.event_id});
      await flushMicrotasks();
      controller.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  test('minutes=0 does not create an automatic close timer', async () => {
    jest.useFakeTimers();
    try {
      const events = callbacks();
      const controller = createLiveController(events);
      const connecting = controller.connect({...config, voice: {...config.voice, minutes: 0}});
      await flushMicrotasks();
      const channel = mockChannels[mockChannels.length - 1];
      expect(channel).toBeDefined();
      channel.open();
      channel.message({type: 'session.started', session: {id: 'live_synthetic'}});
      jest.advanceTimersByTime(20);
      await connecting;
      jest.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(events.onClosed).not.toHaveBeenCalled();
      controller.dispose();
      expect(events.onClosed).toHaveBeenCalledWith(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('session duration starts after session.started, not while preparing', async () => {
    jest.useFakeTimers();
    try {
      const events = callbacks();
      const controller = createLiveController(events);
      const connecting = controller.connect({...config, voice: {...config.voice, minutes: 0.1}});
      await flushMicrotasks();
      const channel = mockChannels[mockChannels.length - 1];
      expect(channel).toBeDefined();
      channel.open();
      jest.advanceTimersByTime(7_000);
      expect(events.onClosed).not.toHaveBeenCalled();
      channel.message({type: 'session.started', session: {id: 'live_synthetic'}});
      jest.advanceTimersByTime(20);
      await connecting;
      jest.advanceTimersByTime(6_100);
      expect((events.onStatus as jest.Mock).mock.calls.some(([value]) => value === 'closing')).toBe(true);
      channel.message({type: 'session.closed', usage: {seconds: 1}, reason: 'expired'});
      await flushMicrotasks();
      expect(events.onClosed).toHaveBeenCalledWith(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('rejects an elapsed hot session limit without closing the live session', async () => {
    jest.useFakeTimers();
    try {
      const events = callbacks();
      const controller = createLiveController(events);
      const connecting = controller.connect({...config, voice: {...config.voice, minutes: 10}});
      await flushMicrotasks();
      const channel = mockChannels[mockChannels.length - 1];
      expect(channel).toBeDefined();
      channel.open();
      channel.message({type: 'session.started', session: {id: 'live_synthetic'}});
      jest.advanceTimersByTime(20);
      await connecting;
      jest.advanceTimersByTime(60_000);

      const expired = controller.updatePreferences({voice: {...config.voice, minutes: 0.5}});
      await expect(expired).rejects.toMatchObject({code: ErrorCode.SESSION_LIMIT_ELAPSED});
      expect(channel.sent.some((value) => JSON.parse(value).type === 'session.instructions.append')).toBe(false);
      expect(events.onClosed).not.toHaveBeenCalled();

      const unlimited = controller.updatePreferences({voice: {...config.voice, minutes: 0, pace: 'slow'}});
      await flushMicrotasks();
      const sent = JSON.parse(channel.sent.at(-1) as string);
      channel.message({type: 'session.instructions.appended', client_event_id: sent.event_id});
      await expect(unlimited).resolves.toBeUndefined();
      expect(events.onClosed).not.toHaveBeenCalled();
      controller.dispose();
    } finally {
      jest.useRealTimers();
    }
  });
});

class MockWebSocket {
  static current: MockWebSocket;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: {data: string}) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor() {
    MockWebSocket.current = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.onopen?.();
  }

  message(value: unknown): void {
    this.onmessage?.({data: JSON.stringify(value)});
  }
}

test('probeVoice performs a no-microphone short WebSocket session', async () => {
  Object.defineProperty(globalThis, 'WebSocket', {configurable: true, value: MockWebSocket});
  const probe = probeVoice(config.voiceCredential);
  const socket = MockWebSocket.current;
  socket.open();
  socket.message({type: 'session.started', session: {id: 'probe'}});
  expect(JSON.parse(socket.sent[0]).type).toBe('session.start');
  expect(JSON.parse(socket.sent[1]).type).toBe('session.close');
  expect(socket.sent.some((value) => value.includes('input_audio.append'))).toBe(false);
  socket.message({type: 'session.closed', usage: {seconds: 1}, reason: 'close_requested'});
  await expect(probe).resolves.toBeUndefined();
});
