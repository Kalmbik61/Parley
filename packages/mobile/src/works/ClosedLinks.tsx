// A43: the two links at the bottom of a work (window: WorkCard) — "N more closed" / "Hide closed" and "N archived rooms" /
// "Hide archived rooms" — and the dimmed rows of archived rooms under the second one.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { WorkView } from '@parley/remote-client';
import { haptic } from '../haptics';
import { typography, useColors } from '../theme';
import { archivedLabel, closedLabel } from './closed-state';
import { closedStore, type Expansion } from './closed-store';

function Link({ label, onPress }: { label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => { onPress(); haptic.selection(); }} style={styles.link}>
      <Text allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>{label}</Text>
    </Pressable>
  );
}

export function ClosedLinks({ view, storeKey, expansion, onOpenRoom, only }: {
  view: WorkView;
  storeKey: string;
  expansion: Expansion;
  onOpenRoom: (roomId: string) => void;
  /** The Team sheet shows only the closed link. */
  only?: 'closed';
}) {
  const c = useColors();
  const archived = view.archivedRooms;
  return (
    <View>
      {view.closedCount > 0 && <Link label={closedLabel(view.closedCount, expansion.closed)} onPress={() => closedStore.toggle(storeKey, 'closed')} />}
      {only !== 'closed' && archived.length > 0 && <Link label={archivedLabel(archived.length, expansion.archived)} onPress={() => closedStore.toggle(storeKey, 'archived')} />}
      {only !== 'closed' && expansion.archived &&
        archived.map((room) => (
          <Pressable key={room.id} accessibilityRole="button" accessibilityLabel={`Archived room ${room.title}`} accessibilityHint="Opens the room chat" onPress={() => onOpenRoom(room.id)} style={[styles.link, styles.archivedRow, { opacity: 0.6 }]}>
            <SymbolView name="number" size={15} tintColor={c.label2} />
            <Text numberOfLines={1} allowFontScaling style={[typography.subheadline, styles.flex, { color: c.label2 }]}>{room.title}</Text>
            <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>{room.members.length} agent{room.members.length === 1 ? '' : 's'}</Text>
          </Pressable>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  archivedRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
