// The message field of the session screen (D1 §9.5): multiline, Return is a newline, ⬆ sends through `useChat`.
import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { DEV_FOCUS } from '../dev/flags';
import { devFocus } from '../dev/dev-script';
import { typography, useColors } from '../theme';
import { DictationStrip } from '../voice/DictationStrip';
import { dictation } from '../voice/dictation';
import { MicButton } from '../voice/MicButton';
import { useDictationHidden, useDictationTarget } from '../voice/use-dictation-target';
import { messageProblem, sizeCounter, type ComposerMode } from './send';

export function Composer({
  label,
  mode,
  draft,
  onChange,
  onSend,
  busy,
  measured,
  dictation: dictationProps,
}: {
  label: string;
  mode: ComposerMode;
  draft: string;
  onChange(text: string): void;
  onSend(): void;
  busy: boolean;
  /** What would go (the draft with the reply plate's quote): the 16 KB problem, the counter and ⬆ use it (critic A42 M3). */
  measured?: string;
  /** The microphone (A47): the field's dictation id, the key of its draft and the screen's toast. */
  dictation?: { id: string; draftKey: string; toast(text: string): void };
}) {
  const c = useColors();
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  useEffect(() => devFocus.listen(() => input.current?.focus()), []);
  const dictationId = dictationProps?.id ?? '';
  const mic = useDictationTarget({
    id: dictationId,
    input,
    value: draft,
    apply: onChange,
    fallback: { kind: 'session', key: dictationProps?.draftKey ?? '' },
    toast: dictationProps?.toast ?? (() => undefined),
  });
  useDictationHidden(dictationId, mode.kind === 'hidden');
  if (mode.kind === 'hidden') {
    return mode.text === '' ? null : (
      <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, styles.line, { color: c.label2 }]}>
        {mode.text}
      </Text>
    );
  }
  const whole = measured ?? draft;
  const problem = messageProblem(draft) ?? messageProblem(whole);
  const counter = sizeCounter(whole);
  const canSend = mode.sendEnabled && problem === null && !busy;
  return (
    <View style={styles.wrap}>
      {counter !== null && (
        <Text allowFontScaling style={[typography.caption1, { color: problem !== null && draft.trim() !== '' ? c.danger : c.label2, textAlign: 'right' }]}>
          {problem !== null && draft.trim() !== '' ? `${problem} · ${counter}` : counter}
        </Text>
      )}
      {dictationProps !== undefined && <DictationStrip id={dictationId} />}
      <View style={styles.row}>
        <TextInput
          ref={input}
          autoFocus={DEV_FOCUS}
          accessibilityLabel={`Message ${label}`}
          multiline
          editable={!busy && mode.sendEnabled}
          value={draft}
          onChangeText={onChange}
          onSelectionChange={mic.onSelectionChange}
          placeholder={`Message ${label}`}
          placeholderTextColor={c.label3}
          style={[typography.body, styles.input, { backgroundColor: c.surface, color: c.label, opacity: busy ? 0.6 : 1 }]}
        />
        {dictationProps !== undefined && <MicButton id={dictationId} editable={!busy && mode.sendEnabled} />}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !canSend, busy }}
          disabled={!canSend}
          onPress={() => (dictationProps !== undefined && dictation.finishBeforeSend(dictationId)) || onSend()}
          style={styles.send}
        >
          <SymbolView name="arrow.up.circle.fill" size={32} tintColor={canSend ? c.tint : c.off} />
        </Pressable>
      </View>
      {mode.note !== null && (
        <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
          {mode.note}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: { flex: 1, minHeight: 44, maxHeight: 130, borderRadius: 22, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11 },
  send: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  line: { textAlign: 'center', paddingVertical: 8 },
});
