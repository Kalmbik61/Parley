// "Select Text" (D1 §9.2): the message source in a read-only multiline field — system selection with handles, the system Copy
// on a selection — and "Reply with selection", enabled only with a non-empty selection. Selection does not live in the feed:
// `Text selectable` fights the long-press sheet, and a selection cannot cross the blocks of rendered Markdown.
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { touchAppLock } from '../auth/lock-instance';
import { spacing, typography, useColors } from '../theme';
import { Button } from '../ui/Button';
import { selectedFragment, type Selection } from './selection';

export type { Selection };

export function SelectTextSheet({ text, initial, onReply, onClose }: { text: string; /** Developer preview: a selection to show. */ initial?: Selection; onReply(selected: string): void; onClose(): void }) {
  const c = useColors();
  const [sel, setSel] = useState<Selection>(initial ?? { start: 0, end: 0 });
  const selected = selectedFragment(text, sel);
  return (
    <View onTouchStart={touchAppLock} style={[styles.page, { backgroundColor: c.bg }]}>
      <View style={styles.head}>
        <Text accessibilityRole="header" allowFontScaling style={[typography.title3, { color: c.label }]}>
          Select Text
        </Text>
        <Button variant="plain" title="Done" onPress={onClose} />
      </View>
      <TextInput
        accessibilityLabel="Message text"
        multiline
        editable={false}
        scrollEnabled
        value={text}
        {...(initial === undefined ? {} : { selection: sel })}
        onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
        autoFocus={initial !== undefined}
        style={[typography.body, styles.input, { backgroundColor: c.surface, color: c.label }]}
      />
      <Button title="Reply with selection" disabled={selected === ''} onPress={() => onReply(selected)} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: spacing.screenMargin, gap: 12 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  input: { flex: 1, borderRadius: 14, padding: 14, textAlignVertical: 'top' },
});
