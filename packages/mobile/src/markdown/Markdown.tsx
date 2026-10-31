// Renders parsed Markdown with Text only: no Image, no WebView, no network. A link asks before it opens (D1 §9.3).
import { Alert, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { typography, useColors } from '../theme';
import { hostOf, parseMarkdown, type Block, type Inline } from './parse';

export function confirmOpen(url: string): void {
  const host = hostOf(url) ?? url;
  Alert.alert(`Open ${host} in Safari?`, undefined, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open', onPress: () => void Linking.openURL(url) },
  ]);
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  const c = useColors();
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text':
            return n.text;
          case 'bold':
            return (
              <Text key={i} style={styles.bold}>
                <Inlines nodes={n.children} />
              </Text>
            );
          case 'italic':
            return (
              <Text key={i} style={styles.italic}>
                <Inlines nodes={n.children} />
              </Text>
            );
          case 'code':
            return (
              <Text key={i} style={[styles.mono, { backgroundColor: c.surface2 }]}>
                {n.text}
              </Text>
            );
          case 'link':
            return (
              <Text key={i} accessibilityRole="link" onPress={() => confirmOpen(n.url)} style={{ color: c.tint, textDecorationLine: 'underline' }}>
                <Inlines nodes={n.children} />
              </Text>
            );
          case 'image':
            return `\n[Image not loaded${n.host === null ? '' : ` · ${n.host}`}]\n`;
        }
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  const c = useColors();
  switch (block.t) {
    case 'paragraph':
      return (
        <Text allowFontScaling style={[typography.body, { color: c.label }]}>
          <Inlines nodes={block.inline} />
        </Text>
      );
    case 'heading':
      return (
        <Text accessibilityRole="header" allowFontScaling style={[block.level <= 2 ? typography.title3 : typography.headline, { color: c.label }]}>
          <Inlines nodes={block.inline} />
        </Text>
      );
    case 'code':
      return (
        <ScrollView horizontal style={[styles.code, { backgroundColor: c.surface2 }]}>
          <Text allowFontScaling style={[styles.mono, typography.footnote, { color: c.label }]}>
            {block.text}
          </Text>
        </ScrollView>
      );
    case 'quote':
      return (
        <View style={[styles.quote, { borderLeftColor: c.separator }]}>
          {block.blocks.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
        </View>
      );
    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((item, i) => (
            <View key={i} style={styles.item}>
              <Text allowFontScaling style={[typography.body, { color: c.label2, width: 22 }]}>
                {block.ordered ? `${i + 1}.` : '•'}
              </Text>
              <Text allowFontScaling style={[typography.body, styles.flex, { color: c.label }]}>
                <Inlines nodes={item} />
              </Text>
            </View>
          ))}
        </View>
      );
    case 'rule':
      return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.separator }} />;
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <View style={styles.gap}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 10 },
  flex: { flex: 1 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  mono: { fontFamily: 'Menlo' },
  code: { borderRadius: 10, padding: 10 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, gap: 6 },
  list: { gap: 4 },
  item: { flexDirection: 'row' },
});
