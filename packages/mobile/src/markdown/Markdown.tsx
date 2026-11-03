// Renders the mdast of `parse.ts` with Text only: no Image, no WebView, no network. A link asks before it opens
// (D1 §9.2–9.3). A render error falls back to the raw text, the screen never crashes.
import * as Clipboard from 'expo-clipboard';
import { SymbolView } from 'expo-symbols';
import { Component, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { typography, useColors } from '../theme';
import { columnWidths, noHyphenBreak } from './helpers';
import { definitionsOf, hostOf, isOpenableUrl, parseMarkdown, rawRoot, type MdNode } from './parse';

export function confirmOpen(url: string): void {
  const host = hostOf(url) ?? url;
  Alert.alert(`Open ${host} in Safari?`, undefined, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open', onPress: () => void Linking.openURL(url) },
  ]);
}

interface Ctx {
  defs: Map<string, { url: string; title: string | null }>;
  labelOf?: (sessionId: string) => string;
  /** Screenshots only: a table starts scrolled sideways by this much. */
  tableOffset?: number;
}

function Inlines({ nodes, ctx, size }: { nodes: MdNode[]; ctx: Ctx; size: number }) {
  const c = useColors();
  return (
    <>
      {nodes.map((n, i) => {
        const kids = <Inlines nodes={n.children ?? []} ctx={ctx} size={size} />;
        switch (n.type) {
          case 'text':
          case 'html':
            return n.value ?? '';
          case 'break':
            return '\n';
          case 'strong':
            return (
              <Text key={i} style={styles.bold}>
                {kids}
              </Text>
            );
          case 'emphasis':
            return (
              <Text key={i} style={styles.italic}>
                {kids}
              </Text>
            );
          case 'delete':
            return (
              <Text key={i} style={styles.strike}>
                {kids}
              </Text>
            );
          case 'inlineCode':
            return (
              <Text key={i} style={[styles.mono, { fontSize: Math.max(11, size - 2), backgroundColor: c.surface2 }]}>
                {noHyphenBreak(n.value ?? '')}
              </Text>
            );
          case 'link':
          case 'linkReference': {
            const url = n.type === 'link' ? (n.url ?? '') : (ctx.defs.get(n.identifier ?? '')?.url ?? '');
            if (!isOpenableUrl(url)) return <Text key={i}>{kids}</Text>;
            return (
              <Text key={i} accessibilityRole="link" onPress={() => confirmOpen(url.trim())} style={{ color: c.tint, textDecorationLine: 'underline' }}>
                {kids}
              </Text>
            );
          }
          case 'image':
          case 'imageReference': {
            const url = n.type === 'image' ? (n.url ?? '') : (ctx.defs.get(n.identifier ?? '')?.url ?? '');
            const host = hostOf(url);
            return `\n[Image not loaded${host === null ? '' : ` · ${host}`}]\n`;
          }
          case 'mention':
          case 'humanMention': {
            if (ctx.labelOf === undefined) return n.raw ?? '';
            const label = n.type === 'mention' ? ctx.labelOf(n.sessionId ?? '') : 'you';
            return (
              <Text key={i} accessibilityLabel={`mention ${label}`} style={{ color: c.tint, fontWeight: '600' }}>
                @{label}
              </Text>
            );
          }
          default:
            // footnoteReference was turned into text by the parser; anything unknown shows its text.
            return n.children !== undefined ? <Text key={i}>{kids}</Text> : (n.value ?? '');
        }
      })}
    </>
  );
}

function Para({ node, ctx, style }: { node: MdNode; ctx: Ctx; style?: object }) {
  const c = useColors();
  const base = typography.body;
  return (
    <Text allowFontScaling style={[base, { color: c.label }, style]}>
      <Inlines nodes={node.children ?? []} ctx={ctx} size={base.fontSize} />
    </Text>
  );
}

const HEADING = [
  { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  typography.title3,
  typography.headline,
  typography.headline,
  { ...typography.subheadline, fontWeight: '600' },
  { ...typography.subheadline, fontWeight: '600' },
] as const;

function Heading({ node, ctx }: { node: MdNode; ctx: Ctx }) {
  const c = useColors();
  const style = HEADING[Math.min(Math.max((node.depth ?? 1) - 1, 0), 5)]!;
  return (
    <Text accessibilityRole="header" allowFontScaling style={[style, { color: c.label }]}>
      <Inlines nodes={node.children ?? []} ctx={ctx} size={style.fontSize} />
    </Text>
  );
}

function CodeBlock({ node }: { node: MdNode }) {
  const c = useColors();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const text = node.value ?? '';
  const copy = (): void => {
    void Clipboard.setStringAsync(text).then(() => {
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <View style={[styles.code, { backgroundColor: c.surface2, borderColor: c.separator }]}>
      <View style={styles.codeHead}>
        <Text allowFontScaling numberOfLines={1} style={[typography.caption1, styles.flex, { color: c.label2 }]}>
          {node.caption ?? ''}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel={copied ? 'Copied' : 'Copy code'} hitSlop={8} onPress={copy} style={styles.copy}>
          <SymbolView name={copied ? 'checkmark' : 'doc.on.doc'} size={13} tintColor={c.tint} />
          <Text allowFontScaling style={[typography.caption1, { color: c.tint }]}>
            {copied ? 'Copied' : 'Copy'}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text allowFontScaling style={[styles.mono, typography.footnote, { color: c.label }]}>
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

function Table({ node, ctx }: { node: MdNode; ctx: Ctx }) {
  const c = useColors();
  const rows = node.children ?? [];
  const widths = useMemo(() => columnWidths(rows), [rows]);
  const align = node.align ?? [];
  const size = typography.subheadline.fontSize;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tableScroll} contentOffset={{ x: ctx.tableOffset ?? 0, y: 0 }}>
      <View style={[styles.table, { borderColor: c.separator }]}>
        {rows.map((row, r) => (
          <View key={r} style={[styles.row, r < rows.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.separator }, r === 0 && { backgroundColor: c.surface2 }]}>
            {widths.map((w, col) => {
              const cell = row.children?.[col];
              return (
                <View key={col} style={[styles.cell, { width: w }, col < widths.length - 1 && { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: c.separator }]}>
                  <Text
                    allowFontScaling
                    style={[typography.subheadline, { color: c.label, textAlign: align[col] === 'right' ? 'right' : align[col] === 'center' ? 'center' : 'left' }, r === 0 && styles.semibold]}
                  >
                    <Inlines nodes={cell?.children ?? []} ctx={ctx} size={size} />
                  </Text>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function ListView({ node, ctx }: { node: MdNode; ctx: Ctx }) {
  const c = useColors();
  const first = node.start ?? 1;
  const items = node.children ?? [];
  const digits = String(first + items.length - 1).length;
  const markerWidth = node.ordered === true ? Math.max(22, digits * 10 + 12) : 22;
  return (
    <View style={styles.list}>
      {items.map((item, i) => (
        <View key={i} style={styles.item}>
          <View style={{ width: markerWidth }}>
            {typeof item.checked === 'boolean' ? (
              <SymbolView
                name={item.checked ? 'checkmark.square.fill' : 'square'}
                size={17}
                tintColor={item.checked ? c.tint : c.label2}
                accessibilityLabel={item.checked ? 'done' : 'not done'}
                style={styles.task}
              />
            ) : (
              <Text allowFontScaling style={[typography.body, { color: c.label2 }]}>
                {node.ordered === true ? `${first + i}.` : '•'}
              </Text>
            )}
          </View>
          <View style={[styles.flex, styles.itemBody]}>
            {(item.children ?? []).map((b, k) => (
              <BlockView key={k} node={b} ctx={ctx} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

function BlockView({ node, ctx }: { node: MdNode; ctx: Ctx }) {
  const c = useColors();
  switch (node.type) {
    case 'paragraph':
      return <Para node={node} ctx={ctx} />;
    case 'heading':
      return <Heading node={node} ctx={ctx} />;
    case 'code':
      return <CodeBlock node={node} />;
    case 'blockquote':
      return (
        <View style={[styles.quote, { borderLeftColor: c.separator }]}>
          {(node.children ?? []).map((b, i) => (
            <BlockView key={i} node={b} ctx={ctx} />
          ))}
        </View>
      );
    case 'list':
      return <ListView node={node} ctx={ctx} />;
    case 'table':
      return <Table node={node} ctx={ctx} />;
    case 'thematicBreak':
      return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.separator }} />;
    case 'definition':
      return null;
    case 'html':
      return (
        <Text allowFontScaling style={[typography.body, { color: c.label }]}>
          {node.value ?? ''}
        </Text>
      );
    default:
      return node.children !== undefined ? <Para node={node} ctx={ctx} /> : null;
  }
}

function RawText({ text }: { text: string }) {
  const c = useColors();
  return (
    <Text allowFontScaling style={[typography.body, { color: c.label }]}>
      {text}
    </Text>
  );
}

class Boundary extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidUpdate(prev: { text: string }): void {
    if (prev.text !== this.props.text && this.state.failed) this.setState({ failed: false });
  }
  override render(): ReactNode {
    return this.state.failed ? <RawText text={this.props.text} /> : this.props.children;
  }
}

function Tree({ text, labelOf, tableOffset }: { text: string; labelOf?: (sessionId: string) => string; tableOffset?: number }) {
  const root = useMemo<MdNode>(() => {
    try {
      return parseMarkdown(text);
    } catch {
      return rawRoot(text);
    }
  }, [text]);
  const ctx = useMemo<Ctx>(() => ({ defs: definitionsOf(root), ...(labelOf === undefined ? {} : { labelOf }), ...(tableOffset === undefined ? {} : { tableOffset }) }), [root, labelOf, tableOffset]);
  return (
    <View style={styles.gap}>
      {(root.children ?? []).map((b, i) => (
        <BlockView key={i} node={b} ctx={ctx} />
      ))}
    </View>
  );
}

/** `labelOf` turns a session id into the name shown in a `@s-02` mention; without it mentions stay as written. */
export function Markdown({ text, labelOf, tableOffset }: { text: string; labelOf?: (sessionId: string) => string; tableOffset?: number }) {
  return (
    <Boundary text={text}>
      <Tree text={text} {...(labelOf === undefined ? {} : { labelOf })} {...(tableOffset === undefined ? {} : { tableOffset })} />
    </Boundary>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 10 },
  flex: { flex: 1 },
  bold: { fontWeight: '700' },
  semibold: { fontWeight: '600' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  mono: { fontFamily: 'Menlo' },
  code: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 10, gap: 6 },
  codeHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  copy: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, gap: 6 },
  list: { gap: 4 },
  item: { flexDirection: 'row' },
  itemBody: { gap: 4 },
  task: { width: 17, height: 22 },
  tableScroll: { flexGrow: 0 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'stretch' },
  cell: { paddingHorizontal: 10, paddingVertical: 6 },
});
