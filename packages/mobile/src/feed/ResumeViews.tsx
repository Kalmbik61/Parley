// The row above the composer of a sleeping session (D1 §9.5 "Пробуждение спящей сессии"): "Sleeping" + Resume,
// "Waking up…", the refusal with Retry, "Still waking up". No Face ID: the app lock covers it.
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { typography, useColors } from '../theme';
import { lineText, type ResumeLine } from './resume';

export function SleepingRow({ line, enabled, onResume }: { line: ResumeLine; enabled: boolean; onResume(): void }) {
  const c = useColors();
  const busy = line.kind === 'waking';
  const failed = line.kind === 'failed' || line.kind === 'unconfirmed';
  const text = lineText(line);
  return (
    <View style={styles.row}>
      {busy ? <ActivityIndicator size="small" color={c.label2} /> : <SymbolView name={failed ? 'exclamationmark.triangle' : 'moon.zzz'} size={16} tintColor={failed ? c.needsYou : c.idle} />}
      <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, styles.text, { color: c.label2 }]}>
        {text}
      </Text>
      {line.kind !== 'waking' && line.kind !== 'still' && (
        <Pressable accessibilityRole="button" accessibilityLabel={failed ? 'Retry' : 'Resume'} disabled={!enabled} onPress={onResume} style={[styles.button, { opacity: enabled ? 1 : 0.4 }]}>
          <Text allowFontScaling style={[typography.subheadline, styles.semibold, { color: c.tint }]}>{failed ? 'Retry' : 'Resume'}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, marginBottom: 4 },
  text: { flex: 1 },
  button: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  semibold: { fontWeight: '600' },
});
