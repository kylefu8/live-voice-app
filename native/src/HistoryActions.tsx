import React, {useEffect, useMemo, useState} from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {normalizeHistoryTitle} from './history-title';
import type {ConversationRecord, Locale} from './types';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

type Palette = {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  button: string;
};

export type HistoryActionPanel = 'menu' | 'rename' | 'confirmAudio' | 'confirmRecord';

export type HistoryActionsProps = {
  record: ConversationRecord | null;
  title: string;
  locale: Locale;
  palette: Palette;
  busy: boolean;
  /** The active session is not allowed to mutate history or dismiss this sheet. */
  disabled: boolean;
  /** An async mutation error supplied by the parent; the sheet remains open so it can be retried. */
  error?: string;
  initialPanel?: HistoryActionPanel;
  onClose(): void;
  onRename(title: string): void;
  onDeleteRecording(): void;
  onDeleteRecord(): void;
};

export function HistoryActions({
  record,
  title,
  locale,
  palette: p,
  busy,
  disabled,
  error,
  initialPanel = 'menu',
  onClose,
  onRename,
  onDeleteRecording,
  onDeleteRecord,
}: HistoryActionsProps) {
  const insets = useSafeAreaInsets();
  const [panel, setPanel] = useState<HistoryActionPanel>(initialPanel);
  const [renameDraft, setRenameDraft] = useState('');

  const tr = (zh: string, en: string) => (locale === 'zh' ? zh : en);
  const hasRecording = Boolean(record?.recording);
  const audioOnly = Boolean(record && !record.fragments.some(fragment => fragment.text.trim()));
  const normalizedTitle = useMemo(
    () => normalizeHistoryTitle(renameDraft),
    [renameDraft],
  );
  const renameInvalid = normalizedTitle === null;
  const canMutate = !busy && !disabled;

  // Do not carry an open confirmation or stale draft into another history row.
  useEffect(() => {
    setPanel(initialPanel);
    setRenameDraft(record?.title || '');
  }, [record?.id, initialPanel]);

  if (!record) return null;

  const closeOrBack = () => {
    if (!canMutate) return;
    if (panel === 'menu' || panel === initialPanel) {
      onClose();
    } else {
      setPanel('menu');
    }
  };

  const openRename = () => {
    if (!canMutate) return;
    setRenameDraft(record.title || '');
    setPanel('rename');
  };

  const submitRename = () => {
    if (!canMutate || !normalizedTitle) return;
    onRename(normalizedTitle);
  };

  const submitDeleteRecording = () => {
    if (!canMutate || !hasRecording) return;
    onDeleteRecording();
  };

  const submitDeleteRecord = () => {
    if (!canMutate) return;
    onDeleteRecord();
  };

  const actionLabel =
    panel === 'rename'
      ? tr('修改会话名称', 'Rename conversation')
      : panel === 'confirmAudio'
        ? tr('确认删除录音', 'Confirm recording deletion')
        : panel === 'confirmRecord'
          ? tr('确认删除会话', 'Confirm conversation deletion')
          : tr('会话操作', 'Conversation actions');

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={closeOrBack}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tr('关闭会话操作', 'Close conversation actions')}
          accessibilityState={{disabled: !canMutate}}
          disabled={!canMutate}
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View
          accessibilityViewIsModal
          style={[styles.sheet, {backgroundColor: p.surface, borderColor: p.border, paddingBottom: Math.max(12, insets.bottom)}]}
        >
          <View style={[styles.handle, {backgroundColor: p.border}]} />
          <ScrollView
            bounces={false}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Text
              accessibilityRole="header"
              style={[styles.title, {color: p.text}]}
              numberOfLines={3}
            >
              {title}
            </Text>
            <Text style={[styles.heading, {color: p.text}]}>{actionLabel}</Text>

            {error ? (
              <Text
                accessibilityLiveRegion="polite"
                style={[styles.error, {color: p.accent}]}
              >
                {error}
              </Text>
            ) : null}

            {panel === 'menu' && (
              <>
                <SheetButton
                  label={tr('改名', 'Rename')}
                  palette={p}
                  disabled={!canMutate}
                  onPress={openRename}
                />
                {hasRecording ? (
                  <SheetButton
                    label={tr('删除录音', 'Delete recording')}
                    palette={p}
                    destructive
                    disabled={!canMutate}
                    onPress={() => setPanel('confirmAudio')}
                  />
                ) : null}
                <SheetButton
                  label={tr('删除记录（文字 + 录音）', 'Delete record (text + audio)')}
                  palette={p}
                  destructive
                  disabled={!canMutate}
                  onPress={() => setPanel('confirmRecord')}
                />
                <SheetButton
                  label={tr('取消', 'Cancel')}
                  palette={p}
                  secondary
                  disabled={!canMutate}
                  onPress={onClose}
                />
              </>
            )}

            {panel === 'rename' && (
              <>
                <Text
                  style={[styles.label, {color: p.muted}]}
                  accessibilityRole="text"
                >
                  {tr('会话名称', 'Conversation name')}
                </Text>
                <TextInput
                  accessibilityLabel={tr('会话名称', 'Conversation name')}
                  autoFocus
                  editable={canMutate}
                  maxLength={120}
                  onChangeText={setRenameDraft}
                  placeholder={tr('输入名称', 'Enter a name')}
                  placeholderTextColor={p.muted}
                  returnKeyType="done"
                  selectionColor={p.accent}
                  style={[styles.input, {borderColor: p.border, color: p.text}]}
                  value={renameDraft}
                  onSubmitEditing={submitRename}
                />
                <Text style={[styles.hint, {color: p.muted}]}>
                  {tr('1–60 个字符', '1–60 characters')}
                </Text>
                {renameInvalid ? (
                  <Text style={[styles.validation, {color: p.accent}]}>
                    {tr('请输入 1–60 个有效字符。', 'Enter 1–60 valid characters.')}
                  </Text>
                ) : null}
                <SheetButton
                  label={tr('保存名称', 'Save name')}
                  palette={p}
                  disabled={!canMutate || renameInvalid}
                  onPress={submitRename}
                />
                <SheetButton
                  label={tr('返回', 'Back')}
                  palette={p}
                  secondary
                  disabled={!canMutate}
                  onPress={closeOrBack}
                />
              </>
            )}

            {panel === 'confirmAudio' && (
              <>
                <Text style={[styles.confirmation, {color: p.text}]}>
                  {tr(
                    `确定删除这次会话的录音吗？文字记录会保留。${
                      audioOnly ? '这条会话没有文字，删除录音后也会从列表中移除。' : ''
                    }`,
                    `Delete this recording? The text history will stay.${
                      audioOnly ? ' Because there is no text, the row will disappear after the recording is deleted.' : ''
                    }`,
                  )}
                </Text>
                <Text style={[styles.warning, {color: p.accent}]}>
                  {tr('删除后无法恢复。', 'This cannot be undone.')}
                </Text>
                <SheetButton
                  label={tr('确认删除录音', 'Delete recording')}
                  palette={p}
                  destructive
                  disabled={!canMutate || !hasRecording}
                  onPress={submitDeleteRecording}
                />
                <SheetButton
                  label={tr('返回', 'Back')}
                  palette={p}
                  secondary
                  disabled={!canMutate}
                  onPress={closeOrBack}
                />
              </>
            )}

            {panel === 'confirmRecord' && (
              <>
                <Text style={[styles.confirmation, {color: p.text}]}>
                  {tr(
                    '确定永久删除这条记录吗？文字和录音（如果有）都会删除。',
                    'Permanently delete this record? Its text and recording, if any, will be deleted.',
                  )}
                </Text>
                <Text style={[styles.warning, {color: p.accent}]}>
                  {tr('删除后无法恢复。', 'This cannot be undone.')}
                </Text>
                <SheetButton
                  label={tr('确认删除记录', 'Delete record')}
                  palette={p}
                  destructive
                  disabled={!canMutate}
                  onPress={submitDeleteRecord}
                />
                <SheetButton
                  label={tr('返回', 'Back')}
                  palette={p}
                  secondary
                  disabled={!canMutate}
                  onPress={closeOrBack}
                />
              </>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SheetButton({
  label,
  palette: p,
  onPress,
  disabled,
  destructive = false,
  secondary = false,
}: {
  label: string;
  palette: Palette;
  onPress(): void;
  disabled: boolean;
  destructive?: boolean;
  secondary?: boolean;
}) {
  const foreground = destructive ? p.accent : secondary ? p.text : p.button;
  const background = destructive ? 'transparent' : secondary ? p.bg : p.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled}}
      disabled={disabled}
      onPress={onPress}
      style={({pressed}) => [
        styles.button,
        {
          backgroundColor: background,
          borderColor: destructive ? p.accent : p.border,
          opacity: disabled ? 0.45 : pressed ? 0.72 : 1,
        },
      ]}
    >
      <Text style={[styles.buttonText, {color: foreground}]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: Platform.OS === 'ios' ? 'transparent' : 'rgba(0, 0, 0, 0.42)',
  },
  sheet: {
    maxHeight: '88%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 10,
    paddingBottom: 12,
  },
  handle: {
    alignSelf: 'center',
    width: 44,
    height: 4,
    borderRadius: 2,
    marginBottom: 4,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 14,
    gap: 10,
  },
  title: {
    fontSize: 19,
    fontWeight: '700',
    lineHeight: 25,
    marginBottom: 2,
  },
  heading: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 2,
  },
  hint: {
    fontSize: 12,
    lineHeight: 17,
  },
  error: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  validation: {
    fontSize: 12,
    lineHeight: 17,
  },
  confirmation: {
    fontSize: 15,
    lineHeight: 23,
  },
  warning: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
  },
  button: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
});

export default HistoryActions;
