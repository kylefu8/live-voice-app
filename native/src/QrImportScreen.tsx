import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { probeBackend } from './backend';
import { probeVoice } from './live';
import { scanQr, decryptQr, cancelQr } from './qr';
import { createQrImporter, type QrImportState } from './qr-import';
import { saveImportedConnections } from './storage';
import type { Connection, Kind, Settings } from './types';

type Palette = {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  button: string;
};
type Props = {
  palette: Palette;
  settings: Settings;
  formatError(code: string): string;
  onImported(connections: Record<Kind, Connection | null>): void;
  onCommitChange(value: boolean): void;
};

export function QrImportScreen(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [state, setState] = useState<QrImportState>({
    phase: 'idle',
    preview: {},
  });
  const [passphrase, setPassphrase] = useState('');
  const [selected, setSelected] = useState<Kind[]>([]);
  const previousPhase = useRef(state.phase);
  const importer = useRef<ReturnType<typeof createQrImporter> | null>(null);
  if (!importer.current)
    importer.current = createQrImporter(
      {
        scan: scanQr,
        decrypt: decryptQr,
        cancelNative: cancelQr,
        test: (kind, credential, signal) =>
          kind === 'voice'
            ? probeVoice(credential, signal)
            : probeBackend(
                credential,
                { ...latest.current.settings.backend, enabled: true },
                signal,
              ),
        save: saveImportedConnections,
        onSaved: connections => latest.current.onImported(connections),
      },
      value => {
        if (
          value.phase === 'preview' &&
          previousPhase.current === 'decrypting'
        ) {
          setSelected(
            (['voice', 'backend'] as const).filter(kind =>
              Boolean(value.preview[kind]),
            ),
          );
        }
        previousPhase.current = value.phase;
        latest.current.onCommitChange(value.phase === 'saving');
        setState(value);
      },
    );

  useEffect(() => {
    const current = importer.current!;
    const appState = AppState.addEventListener('change', next => {
      // Opening our own native CaptureActivity pauses the React Activity.
      // The scanner Activity itself handles being sent to the background.
      if (next !== 'active' && current.phase !== 'scanning') {
        setPassphrase('');
        current.cancel();
      }
    });
    return () => {
      appState.remove();
      current.dispose();
      latest.current.onCommitChange(false);
    };
  }, []);

  const p = props.palette;
  const tr = (zh: string, en: string) =>
    props.settings.locale === 'en' ? en : zh;
  const busy = ['scanning', 'decrypting', 'testing', 'saving'].includes(
    state.phase,
  );
  const action = (
    label: string,
    handler: () => void,
    disabled = false,
    secondary = false,
  ) => (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={handler}
      style={[
        styles.button,
        {
          backgroundColor: secondary ? p.surface : p.accent,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      <Text
        style={{
          color: secondary ? p.text : p.button,
          fontSize: 16,
          fontWeight: '600',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
  return (
    <View style={styles.container}>
      <Text style={[styles.body, { color: p.muted }]}>
        {tr(
          '扫描电脑端生成的 Live Voice 加密二维码。相机只识别二维码，不保存照片。',
          'Scan an encrypted Live Voice QR code from your computer. The camera reads the code without saving photos.',
        )}
      </Text>
      {state.errorCode && (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.body, { color: p.accent }]}
        >
          {props.formatError(state.errorCode)}
        </Text>
      )}
      {state.errorCode === 'camera_permission' &&
        action(
          tr('打开系统设置', 'Open system settings'),
          () => {
            void Linking.openSettings();
          },
          false,
          true,
        )}
      {busy && (
        <View style={styles.progress}>
          <ActivityIndicator color={p.accent} />
          <Text
            accessibilityLiveRegion="polite"
            style={[styles.body, { color: p.text }]}
          >
            {state.phase === 'scanning'
              ? tr('正在打开相机…', 'Opening camera…')
              : state.phase === 'decrypting'
              ? tr('正在解密…', 'Decrypting…')
              : state.phase === 'saving'
              ? tr('正在安全保存…', 'Saving securely…')
              : state.testingKind === 'voice'
              ? tr('正在测试语音连接…', 'Testing voice connection…')
              : tr('正在测试后端连接…', 'Testing backend connection…')}
          </Text>
        </View>
      )}
      {['idle', 'passphrase', 'preview', 'saved'].includes(state.phase) &&
        action(
          state.phase === 'idle'
            ? tr('打开相机扫码', 'Scan with camera')
            : tr('重新扫码', 'Scan again'),
          () => {
            setPassphrase('');
            void importer.current!.scan(props.settings.locale);
          },
          false,
          state.phase !== 'idle',
        )}
      {state.phase === 'passphrase' && (
        <View
          style={[
            styles.card,
            { backgroundColor: p.surface, borderColor: p.border },
          ]}
        >
          <Text style={[styles.title, { color: p.text }]}>
            {tr('二维码已识别', 'QR code recognized')}
          </Text>
          <Text style={[styles.body, { color: p.muted }]}>
            {tr(
              '输入生成二维码时使用的导入口令。',
              'Enter the passphrase used to create the QR code.',
            )}
          </Text>
          <TextInput
            accessibilityLabel={tr('导入口令', 'Import passphrase')}
            value={passphrase}
            onChangeText={setPassphrase}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            importantForAutofill="no"
            maxLength={512}
            placeholder={tr('导入口令', 'Passphrase')}
            placeholderTextColor={p.muted}
            style={[
              styles.input,
              { color: p.text, borderColor: p.border, backgroundColor: p.bg },
            ]}
          />
          {action(
            tr('解密并查看', 'Decrypt and review'),
            () => {
              const value = passphrase;
              setPassphrase('');
              void importer.current!.decrypt(value);
            },
            passphrase.length === 0,
          )}
        </View>
      )}
      {['preview', 'testing', 'saving'].includes(state.phase) && (
        <>
          <Text style={[styles.title, { color: p.text }]}>
            {tr('核对并选择要导入的连接', 'Review and select connections')}
          </Text>
          {(['voice', 'backend'] as const).map(kind => {
            const connection = state.preview[kind];
            if (!connection) return null;
            return (
              <View
                key={kind}
                style={[
                  styles.card,
                  { backgroundColor: p.surface, borderColor: p.border },
                ]}
              >
                <View style={styles.row}>
                  <Text style={[styles.title, { color: p.text }]}>
                    {kind === 'voice'
                      ? tr('语音连接', 'Voice connection')
                      : tr('后端连接', 'Backend connection')}
                  </Text>
                  <Switch
                    accessibilityLabel={
                      kind === 'voice'
                        ? tr('导入语音连接', 'Import voice connection')
                        : tr('导入后端连接', 'Import backend connection')
                    }
                    disabled={busy}
                    value={selected.includes(kind)}
                    onValueChange={value =>
                      setSelected(current =>
                        value
                          ? [...current, kind]
                          : current.filter(item => item !== kind),
                      )
                    }
                  />
                </View>
                <Text style={[styles.body, { color: p.text }]}>
                  {connection.endpoint}
                </Text>
                <Text style={[styles.body, { color: p.text }]}>
                  {tr('模型', 'Model')} · {connection.model}
                </Text>
                <Text style={[styles.body, { color: p.muted }]}>
                  {connection.auth} · {connection.keyMask}
                </Text>
              </View>
            );
          })}
          <Text style={[styles.body, { color: p.muted }]}>
            {tr(
              '请先确认地址。点击后会连接这些服务进行测试，可能产生服务用量；全部通过后才保存选中的连接。',
              'Check the addresses first. Testing contacts these services and may incur usage. Selected connections are saved only after every test passes.',
            )}
          </Text>
          {action(
            tr('测试并保存', 'Test and save'),
            () => {
              void importer.current!.testAndSave(selected);
            },
            busy || selected.length === 0,
          )}
        </>
      )}
      {state.phase !== 'idle' &&
        action(
          tr('取消导入', 'Cancel import'),
          () => {
            setPassphrase('');
            importer.current!.cancel();
          },
          state.phase === 'saving',
          true,
        )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 16 },
  card: { padding: 16, gap: 12, borderWidth: 1, borderRadius: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 17, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 23 },
  input: { borderWidth: 1, borderRadius: 12, padding: 14, fontSize: 16 },
  button: {
    minHeight: 48,
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderRadius: 14,
    alignItems: 'center',
  },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
