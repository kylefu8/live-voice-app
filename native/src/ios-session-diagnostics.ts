import {NativeModules, Platform} from 'react-native';
import {createSessionDiagnostics} from './session-diagnostics';

let activeGeneration = 0;

/** iOS first-minute diagnosis only. Counters do not establish intelligible speech
 * or server receipt. Native first-frame times are relative to audio activation;
 * event/sample times are relative to connect(), after audio activation. */
export function startIosSessionDiagnostics() {
  const bridge = NativeModules.VoiceAudio;
  if (Platform.OS !== 'ios' || !bridge?.diagnosticAudio || !bridge?.writeDiagnostic) return null;
  const generation = ++activeGeneration;
  const trace = createSessionDiagnostics(async snapshot => {
    if (generation === activeGeneration) await bridge.writeDiagnostic(snapshot);
  });
  let stopped = false;
  let sampling = false;
  let polls = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let peer: {getStats: () => Promise<any>} | null = null;
  const sample = async () => {
    if (stopped || sampling || generation !== activeGeneration) return;
    sampling = true;
    try {
      const audio = await bridge.diagnosticAudio();
      const counters: Record<string, number> = {...audio};
      try {
        const stats = await peer?.getStats();
        stats?.forEach((row: any) => {
          if (row.kind !== 'audio' && row.mediaType !== 'audio') return;
          if (row.type === 'outbound-rtp') {
            counters.packetsSent = row.packetsSent;
            counters.bytesSent = row.bytesSent;
          } else if (row.type === 'inbound-rtp') {
            counters.packetsReceived = row.packetsReceived;
            counters.bytesReceived = row.bytesReceived;
          } else if (row.type === 'media-source') {
            counters.totalAudioEnergy = row.totalAudioEnergy;
          } else if (row.type === 'remote-inbound-rtp') {
            counters.roundTripTime = row.roundTripTime;
          }
        });
      } catch { /* Stats support varies by WebRTC version. Keep native counters. */ }
      if (!stopped) trace.sample(counters);
    } catch { /* Diagnostics must never affect a call. */ }
    finally {
      sampling = false;
      if (++polls >= 30 && timer) { clearInterval(timer); timer = null; }
    }
  };
  trace.mark('connect_requested');
  void sample();
  timer = setInterval(() => { void sample(); }, 2000);
  return {
    mark: trace.mark,
    attachPeer(value: typeof peer) { peer = value; },
    finish() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      peer = null;
      trace.finish();
    },
  };
}
