// Letters (D1 §10.2): direct letters to the human, read-only.
import { Stack, useRouter } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { workParam } from '../../nav/refs';
import { plainPreview, selectLetters, timeLabel } from '../../letters/letters-model';
import { useLoadLetters } from '../../letters/load-letters';
import { openedLetters } from '../../letters/opened';
import { useRemoteState } from '../../runtime/use-remote';
import { spacing, typography, useColors } from '../../theme';

export default function LettersScreen() {
  const colors = useColors();
  const router = useRouter();
  const remote = useRemoteState();
  useLoadLetters();
  const rows = remote ? selectLetters(remote, openedLetters.snapshot()) : [];
  return (
    <View style={[styles.page, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: 'Letters', headerBackTitle: 'Inbox' }} />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        contentInsetAdjustmentBehavior="automatic"
        ListHeaderComponent={<ConnectionBanner />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <SymbolView name="envelope.open" tintColor={colors.idle} size={48} />
            <Text allowFontScaling style={[typography.body, { color: colors.label2 }]}>No letters</Text>
          </View>
        }
        contentContainerStyle={{ padding: spacing.screenMargin }}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/letter', params: { id: item.message.id, ref: workParam({ projectPath: item.projectPath, workId: item.workId }) } })}
            style={[styles.row, { backgroundColor: colors.surface, borderBottomColor: colors.separator }]}
          >
            <View style={[styles.dot, { backgroundColor: item.unread ? colors.tint : 'transparent' }]} />
            <View style={{ flex: 1 }}>
              <View style={styles.line}>
                <Text numberOfLines={1} allowFontScaling style={[typography.headline, { color: colors.label, flex: 1 }]}>{item.message.from}</Text>
                <Text allowFontScaling style={[typography.footnote, { color: colors.label2 }]}>{timeLabel(item.message.at)}</Text>
              </View>
              <Text numberOfLines={1} allowFontScaling style={[typography.footnote, { color: colors.label2 }]}>{item.workTitle}</Text>
              <Text numberOfLines={2} allowFontScaling style={[typography.subheadline, { color: colors.label }]}>{plainPreview(item.message.text)}</Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  row: { flexDirection: 'row', gap: 8, padding: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  line: { flexDirection: 'row', gap: 8 },
  dot: { width: spacing.statusDot, height: spacing.statusDot, borderRadius: 5, marginTop: 6 },
  empty: { alignItems: 'center', gap: 8, paddingTop: 80 },
});
