// The message field of the session screen (D1 §9.5): multiline, Return is a newline, ⬆ asks Face ID through `useChat`.
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { typography, useColors } from '../theme';
import { messageProblem, sizeCounter, type ComposerMode } from './send';

export function Composer({
  label,
  mode,
  draft,
  onChange,
  onSend,
  busy,
}: {
  label: string;
  mode: ComposerMode;
  draft: string;
  onChange(text: string): void;
  onSend(): void;
  busy: boolean;
}) {
  const c = useColors();
  if (mode.kind === 'hidden') {
    return mode.text === '' ? null : (
      <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, styles.line, { color: c.label2 }]}>
        {mode.text}
      </Text>
    );
  }
  const problem = messageProblem(draft);
  const counter = sizeCounter(draft);
  const canSend = mode.sendEnabled && problem === null && !busy;
  return (
    <View style={styles.wrap}>
      {counter !== null && (
        <Text allowFontScaling style={[typography.caption1, { color: problem !== null && draft.trim() !== '' ? c.danger : c.label2, textAlign: 'right' }]}>
          {problem !== null && draft.trim() !== '' ? `${problem} · ${counter}` : counter}
        </Text>
      )}
      <View style={styles.row}>
        <TextInput
          accessibilityLabel={`Message ${label}`}
          multiline
          editable={!busy && mode.sendEnabled}
          value={draft}
          onChangeText={onChange}
          placeholder={`Message ${label}`}
          placeholderTextColor={c.label3}
          style={[typography.body, styles.input, { backgroundColor: c.surface, color: c.label, opacity: busy ? 0.6 : 1 }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityHint="Requires Face ID"
          accessibilityState={{ disabled: !canSend, busy }}
          disabled={!canSend}
          onPress={onSend}
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
