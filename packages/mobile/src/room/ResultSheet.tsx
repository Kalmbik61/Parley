// The result of Put all to sleep / Wake all when something failed (D1 §9.7): a row per session — name, the mark, the reason.
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { touchAppLock } from '../auth/lock-instance';
import { spacing, typography, useColors } from '../theme';
import { Button } from '../ui/Button';
import type { RunResult } from './room-menu';

export function ResultSheet({ title, results, onClose }: { title: string; results: readonly RunResult[]; onClose(): void }) {
  const c = useColors();
  return (
    <View onTouchStart={touchAppLock} style={[styles.page, { backgroundColor: c.bg }]}>
      <Text accessibilityRole="header" allowFontScaling style={[typography.title3, { color: c.label }]}>
        {title}
      </Text>
      <ScrollView contentContainerStyle={{ gap: 4 }}>
        {results.map((r) => (
          <View key={r.id} accessible accessibilityLabel={`${r.label}. ${r.status === 'ok' ? 'Done' : r.text ?? 'Failed'}`} style={[styles.row, { borderBottomColor: c.separator }]}>
            <SymbolView name={r.status === 'ok' ? 'checkmark' : 'exclamationmark.triangle'} size={18} tintColor={r.status === 'ok' ? c.tint : c.needsYou} />
            <View style={{ flex: 1 }}>
              <Text allowFontScaling style={[typography.body, { color: c.label }]}>
                {r.label}
              </Text>
              {r.text !== null && (
                <Text allowFontScaling style={[typography.footnote, { color: c.label2 }]}>
                  {r.text}
                </Text>
              )}
            </View>
          </View>
        ))}
      </ScrollView>
      <Button title="Done" onPress={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: spacing.screenMargin, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
});
