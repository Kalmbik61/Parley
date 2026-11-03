// A43: the two links at the bottom of a work (window: WorkCard) — "N more closed" / "Hide closed" and "N archived rooms" /
// "Hide archived rooms" — and the rows of archived rooms under the second one. The Team sheet passes its own closed count
// and no archived rooms.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { WorkRow } from '@parley/remote-client';
import { haptic } from '../haptics';
import { typography, useColors } from '../theme';
import { archivedLabel, closedLabel } from './closed-state';
import { closedStore, type Expansion } from './closed-store';

function Link({ label, expanded, onPress }: { label: string; expanded: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded }}
      onPress={() => { onPress(); haptic.selection(); }}
      style={({ pressed }) => [styles.link, { opacity: pressed ? 0.5 : 1 }]}
    >
      <Text allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>{label}</Text>
    </Pressable>
  );
}

export function ClosedLinks({ closedCount, archivedRooms, storeKey, expansion, onOpenRoom }: {
  closedCount: number;
  archivedRooms: Array<Extract<WorkRow, { kind: 'room' }>>;
  storeKey: string;
  expansion: Expansion;
  onOpenRoom: (roomId: string) => void;
}) {
  const c = useColors();
  return (
    <View>
      {closedCount > 0 && <Link label={closedLabel(closedCount, expansion.closed)} expanded={expansion.closed} onPress={() => closedStore.toggle(storeKey, 'closed')} />}
      {archivedRooms.length > 0 && <Link label={archivedLabel(archivedRooms.length, expansion.archived)} expanded={expansion.archived} onPress={() => closedStore.toggle(storeKey, 'archived')} />}
      {expansion.archived &&
        archivedRooms.map((row) => (
          <Pressable
            key={row.room.id}
            accessibilityRole="button"
            accessibilityLabel={`Archived room ${row.room.title}`}
            accessibilityHint="Opens the room chat"
            onPress={() => onOpenRoom(row.room.id)}
            style={({ pressed }) => [styles.link, styles.archivedRow, { opacity: pressed ? 0.5 : 1 }]}
          >
            {/* Dimmed like the window's dimmed.css: the icon only; the text keeps the secondary colour (contrast). */}
            <View style={styles.dim}>
              <SymbolView name="number" size={15} tintColor={c.label2} />
            </View>
            <Text numberOfLines={1} allowFontScaling style={[typography.subheadline, styles.flex, { color: c.label2 }]}>{row.room.title}</Text>
            <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>{row.sessions.length} agent{row.sessions.length === 1 ? '' : 's'}</Text>
            <SymbolView name="chevron.right" size={12} tintColor={c.label3} />
          </Pressable>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  archivedRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dim: { opacity: 0.6 },
});
