// The reply plate above the field, one for the session and the room (D1 §9.2, §9.7): a 3 pt `tint` bar on the left,
// `arrowshape.turn.up.left`, an optional "Reply to <name>" line (room), the quote in two lines (shown without Markdown marks),
// `xmark` "Remove the reply". The container is not one accessible element, so VoiceOver reaches the button (critic A42 M4).
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { quotePreview } from '../feed/quote-preview';
import { typography, useColors } from '../theme';

export function ReplyPlate({ title, quote, onClear }: { title?: string | null; /** The quote as Markdown source: shown as plain text. */ quote: string; onClear(): void }) {
  const c = useColors();
  const shown = quotePreview(quote);
  return (
    <View style={[styles.plate, { backgroundColor: c.surface }]}>
      <View style={[styles.bar, { backgroundColor: c.tint }]} />
      <SymbolView name="arrowshape.turn.up.left" size={16} tintColor={c.label2} />
      <View accessible accessibilityLabel={`${title ?? 'Reply'}: ${shown}`} style={styles.text}>
        {title != null && (
          <Text numberOfLines={1} allowFontScaling style={[typography.footnote, { color: c.label, fontWeight: '600' }]}>
            {title}
          </Text>
        )}
        <Text numberOfLines={2} allowFontScaling style={[typography.footnote, { color: c.label2 }]}>
          {shown}
        </Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Remove the reply" onPress={onClear} hitSlop={12}>
        <SymbolView name="xmark" size={14} tintColor={c.label3} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  plate: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, paddingRight: 12, paddingVertical: 8, marginBottom: 6, overflow: 'hidden' },
  bar: { width: 3, alignSelf: 'stretch' },
  text: { flex: 1 },
});
