import React, {useRef, useState} from 'react';
import {
  AppRegistry,
  NativeModules,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {LiveTranscriptScroll} from '../../src/LiveTranscriptScroll';
import {sessionActivity} from '../../src/session-activity';
import {createSessionActivitySync} from '../../src/session-activity-sync';
import {createSessionDiagnostics} from '../../src/session-diagnostics';

const ACTIVITY_ID = 'ui-activity-test';
const MAX_LINES = 200;

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  const compact = value.replace(/\s+/g, ' ').trim();
  return (compact || 'Unknown activity error').slice(0, 160);
}

function Harness() {
  const [lineCount, setLineCount] = useState(50);
  const [activityStatus, setActivityStatus] = useState(
    'No real voice · synthetic UI only',
  );
  const [activityError, setActivityError] = useState('');
  const [activityBusy, setActivityBusy] = useState(false);
  const activity = useRef<ReturnType<typeof createSessionActivitySync> | null>(null);

  function appendLine() {
    setLineCount(current => Math.min(MAX_LINES, current + 1));
  }

  async function startActivity() {
    if (activityBusy) return;
    setActivityBusy(true);
    setActivityError('');
    try {
      const sync = createSessionActivitySync(ACTIVITY_ID, 'en', sessionActivity);
      activity.current = sync;
      await sync.update({recording: false});
      // Same publisher used by the real connected callback. The initial
      // request must contain this clock; there is no later update to fill it in.
      await sync.update({status: 'connected', startedAt: Date.now() - 65_000});
      if (!sync.visible) {
        setActivityStatus('Activity unavailable');
        return;
      }
      setActivityStatus('Activity started');
      try {
        await sync.update({
          status: 'connecting', muted: false, recording: false,
          backendWorking: false, startedAt: null,
        });
      } catch (error) {
        setActivityError(`Activity update failed: ${boundedError(error)}`);
      }
    } catch (error) {
      setActivityStatus('Activity unavailable');
      setActivityError(`Activity start failed: ${boundedError(error)}`);
    } finally {
      setActivityBusy(false);
    }
  }

  async function endActivity() {
    if (activityBusy) return;
    setActivityBusy(true);
    setActivityError('');
    try {
      await activity.current?.end();
      activity.current = null;
      setActivityStatus('Activity ended');
    } catch (error) {
      setActivityError(`Activity end failed: ${boundedError(error)}`);
    } finally {
      setActivityBusy(false);
    }
  }

  async function checkDiagnostics() {
    try {
      const trace = createSessionDiagnostics(snapshot => NativeModules.VoiceAudio.writeDiagnostic(snapshot));
      trace.mark('connect_requested');
      trace.sample(await NativeModules.VoiceAudio.diagnosticAudio());
      trace.mark('session_started');
      await trace.finish();
      // The test also reads the written file from the simulator container.
      setActivityStatus('Diagnostics exercised');
    } catch { setActivityStatus('Diagnostics failed'); }
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>
            Session UI harness
          </Text>
          <Text style={styles.subtitle}>No real voice · synthetic UI only</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Check diagnostics"
            onPress={() => void checkDiagnostics()}>
            <Text>Check diagnostics</Text>
          </Pressable>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Append line"
              testID="append-line"
              style={styles.action}
              onPress={appendLine}
            >
              <Text style={styles.actionText}>Append line</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Start activity"
              testID="start-activity"
              disabled={activityBusy}
              style={[styles.action, activityBusy && styles.disabled]}
              onPress={() => void startActivity()}
            >
              <Text style={styles.actionText}>Start activity</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="End activity"
              testID="end-activity"
              disabled={activityBusy}
              style={[styles.action, activityBusy && styles.disabled]}
              onPress={() => void endActivity()}
            >
              <Text style={styles.actionText}>End activity</Text>
            </Pressable>
          </View>
          <Text accessibilityLiveRegion="polite" style={styles.status}>
            {activityStatus}
          </Text>
          {!!activityError && (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {activityError}
            </Text>
          )}
        </View>
        <LiveTranscriptScroll
          sessionKey="ui-session"
          testID="transcript-harness"
          style={styles.transcript}
          contentContainerStyle={styles.transcriptContent}
        >
          {Array.from({length: lineCount}, (_, index) => (
            <View
              key={index}
              accessible
              accessibilityLabel={`Transcript line ${index}`}
              testID={`transcript-line-${index}`}
              style={styles.line}
            >
              <Text style={styles.lineText}>Synthetic line {index}</Text>
            </View>
          ))}
        </LiveTranscriptScroll>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

AppRegistry.registerComponent('LiveVoiceApp', () => Harness);

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: '#fbfaf8'},
  header: {paddingHorizontal: 14, paddingBottom: 8, gap: 4},
  title: {fontSize: 22, fontWeight: '700', color: '#222'},
  subtitle: {fontSize: 13, color: '#6b665f'},
  actions: {flexDirection: 'row', gap: 6, paddingVertical: 4},
  action: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: 4,
    borderRadius: 10,
    backgroundColor: '#bb5f43',
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {opacity: 0.45},
  actionText: {fontSize: 12, fontWeight: '700', color: '#fffaf6'},
  status: {fontSize: 13, color: '#4b4945'},
  error: {fontSize: 12, color: '#a32f2f'},
  transcript: {flex: 1, marginHorizontal: 14},
  transcriptContent: {paddingBottom: 16},
  line: {
    height: 60,
    marginBottom: 4,
    paddingHorizontal: 12,
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: '#eee9e2',
  },
  lineText: {fontSize: 16, color: '#252522'},
});
