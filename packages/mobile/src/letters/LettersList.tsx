// The Letters segment of the Inbox (D1 §7, §10.2): all direct letters to the human, read and unread, unread dot.
import { useRouter } from 'expo-router';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { ReactElement } from 'react';
import { workParam } from '../nav/refs';
import { plainPreview, selectLetters, timeLabel } from './letters-model';
import { useLoadLetters } from './load-letters';
import { openedLetters } from './opened';
import { useRemoteState } from '../hooks/use-remote';
import { spacing, typography, useColors } from '../theme';

export function LettersList({ header, refreshControl }: { header: ReactElement; refreshControl?: ReactElement<typeof RefreshControl> }) {
  const colors = useColors();
  const router = useRouter();
  const remote = useRemoteState();
  useLoadLetters();
  const rows = remote ? selectLetters(remote, openedLetters.snapshot()) : [];
  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.key}
      ListHeaderComponent={header}
      refreshControl={refreshControl as never}
      ListEmptyComponent={
        <View style={styles.empty}>
          <SymbolView name="envelope.open" tintColor={colors.idle} size={48} />
          <Text allowFontScaling style={[typography.body, { color: colors.label2 }]}>
            No letters
          </Text>
        </View>
      }
      contentContainerStyle={{ padding: spacing.screenMargin }}
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            router.push({
              pathname: '/letter',
              params: {
                id: item.message.id,
                ref: workParam({ projectPath: item.projectPath, workId: item.workId }),
              },
            })
          }
          style={[styles.row, { backgroundColor: colors.surface, borderBottomColor: colors.separator }]}
        >
          <View style={[styles.dot, { backgroundColor: item.unread ? colors.tint : 'transparent' }]} />
          <View style={{ flex: 1 }}>
            <View style={styles.line}>
              <Text numberOfLines={1} allowFontScaling style={[typography.headline, { color: colors.label, flex: 1 }]}>
                {item.message.from}
              </Text>
              <Text allowFontScaling style={[typography.footnote, { color: colors.label2 }]}>
                {timeLabel(item.message.at)}
              </Text>
            </View>
            <Text numberOfLines={1} allowFontScaling style={[typography.footnote, { color: colors.label2 }]}>
              {item.workTitle}
            </Text>
            <Text numberOfLines={2} allowFontScaling style={[typography.subheadline, { color: colors.label }]}>
              {plainPreview(item.message.text)}
            </Text>
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, padding: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  line: { flexDirection: 'row', gap: 8 },
  dot: { width: spacing.statusDot, height: spacing.statusDot, borderRadius: 5, marginTop: 6 },
  empty: { alignItems: 'center', gap: 8, paddingTop: 80 },
});
