// Renders the mdast of `parse.ts` with Text only: no Image, no WebView, no network. A link asks before it opens
// (D1 §9.2–9.3). A render error falls back to the raw text, the screen never crashes.
import * as Clipboard from 'expo-clipboard';
import { SymbolView } from 'expo-symbols';
import { Component, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { typography, useColors } from '../theme';
import { codeText, columnWidths, imageLine, linkLabelIsEmpty, linkTarget, addressOf, type Defs } from './helpers';
import { definitionsOf, hostOf, parseMarkdown, rawRoot, type MdNode } from './parse';

export function confirmOpen(url: string): void {
  const host = hostOf(url) ?? url;
  Alert.alert(`Open ${host} in Safari?`, undefined, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open', onPress: () => void Linking.openURL(url) },
  ]);
}

/** Longer inline code is drawn without the fill: iOS stretches the fill of a wrapped nested Text to the line end. */
const INLINE_FILL_MAX = 24;

interface Ctx {
  /** Long press on a link or "Copy code" opens the message's action sheet instead of the link (A42). */
  onLongPress?: () => void;
  defs: Defs;
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
              <Text key={i} style={[styles.mono, { fontSize: Math.max(11, size - 2) }, (n.value ?? '').length <= INLINE_FILL_MAX && { backgroundColor: c.codeFill }]}>
                {codeText(n.value ?? '', (n.value ?? '').length <= INLINE_FILL_MAX)}
              </Text>
            );
          case 'link':
          case 'linkReference': {
            const target = linkTarget(n, ctx.defs);
            // A blank label shows the address, so the human sees what the agent wrote.
            const label = linkLabelIsEmpty(n) ? addressOf(n, ctx.defs) : kids;
            if (target === null) return <Text key={i}>{label}</Text>;
            return (
              <Text key={i} accessibilityRole="link" onPress={() => confirmOpen(target)} {...(ctx.onLongPress === undefined ? {} : { onLongPress: ctx.onLongPress })} style={{ color: c.tint, textDecorationLine: 'underline' }}>
                {label}
              </Text>
            );
          }
          case 'image':
          case 'imageReference': {
            // On its own line, but no extra blank lines; the title (" (title)") stays on the image line.
            const prev = nodes[i - 1];
            const next = nodes[i + 1];
            const lead = prev !== undefined && prev.type !== 'break' ? '\n' : '';
            const titled = next?.type === 'text' && next.literal === true && (next.value ?? '').startsWith(' (');
            const trail = next !== undefined && next.type !== 'break' && !titled ? '\n' : '';
            return `${lead}${imageLine(n, ctx.defs)}${trail}`;
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

function CodeBlock({ node, onLongPress }: { node: MdNode; onLongPress?: () => void }) {
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
    <View style={[styles.code, { backgroundColor: c.codeFill, borderColor: c.separator }]}>
      <View style={styles.codeHead}>
        <Text allowFontScaling style={[typography.caption1, styles.flex, { color: c.label2 }]}>
          {node.caption ?? ''}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel={copied ? 'Copied' : 'Copy code'} hitSlop={8} onPress={copy} {...(onLongPress === undefined ? {} : { onLongPress })} style={styles.copy}>
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
  const { fontScale } = useWindowDimensions();
  const widths = useMemo(() => columnWidths(rows, fontScale), [rows, fontScale]);
  const align = node.align ?? [];
  const size = typography.subheadline.fontSize;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tableScroll} contentOffset={{ x: ctx.tableOffset ?? 0, y: 0 }}>
      <View style={[styles.table, { borderColor: c.separator }]}>
        {rows.map((row, r) => (
          <View key={r} style={[styles.row, r < rows.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.separator }, r === 0 && { backgroundColor: c.codeFill }]}>
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
  const { fontScale } = useWindowDimensions();
  const first = node.start ?? 1;
  const items = node.children ?? [];
  const digits = String(first + items.length - 1).length;
  const markerWidth = Math.ceil((node.ordered === true ? Math.max(22, digits * 10 + 12) : 22) * fontScale);
  const symbol = Math.round(17 * fontScale);
  return (
    <View style={styles.list}>
      {items.map((item, i) => {
        const blocks = item.children ?? [];
        if (typeof item.checked === 'boolean') {
          // A task item: only the marker is the accessible element ("done" / "not done"); the text stays normal text.
          const head = blocks[0]?.type === 'paragraph' ? blocks[0] : null;
          const rest = head === null ? blocks : blocks.slice(1);
          return (
            <View key={i} style={styles.itemBody}>
              <View style={styles.item}>
                <View
                  accessible
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: item.checked }}
                  accessibilityLabel={item.checked ? 'done' : 'not done'}
                  style={{ width: markerWidth }}
                >
                  <SymbolView name={item.checked ? 'checkmark.square.fill' : 'square'} size={symbol} tintColor={item.checked ? c.tint : c.label2} style={{ width: symbol, height: Math.round(22 * fontScale) }} />
                </View>
                <View style={styles.flex}>{head !== null && <BlockView node={head} ctx={ctx} />}</View>
              </View>
              {rest.length > 0 && (
                <View style={[styles.itemBody, { paddingLeft: markerWidth }]}>
                  {rest.map((b, k) => (
                    <BlockView key={k} node={b} ctx={ctx} />
                  ))}
                </View>
              )}
            </View>
          );
        }
        return (
          <View key={i} style={styles.item}>
            <View style={{ width: markerWidth }}>
              <Text allowFontScaling style={[typography.body, { color: c.label2 }]}>
                {node.ordered === true ? `${first + i}.` : '•'}
              </Text>
            </View>
            <View style={[styles.flex, styles.itemBody]}>
              {blocks.map((b, k) => (
                <BlockView key={k} node={b} ctx={ctx} />
              ))}
            </View>
          </View>
        );
      })}
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
      return <CodeBlock node={node} {...(ctx.onLongPress === undefined ? {} : { onLongPress: ctx.onLongPress })} />;
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

const Tree = memo(function Tree({ text, labelOf, tableOffset, onLongPress }: { text: string; labelOf?: (sessionId: string) => string; tableOffset?: number; onLongPress?: () => void }) {
  const root = useMemo<MdNode>(() => {
    try {
      return parseMarkdown(text);
    } catch {
      return rawRoot(text);
    }
  }, [text]);
  const ctx = useMemo<Ctx>(() => ({ defs: definitionsOf(root), ...(labelOf === undefined ? {} : { labelOf }), ...(tableOffset === undefined ? {} : { tableOffset }), ...(onLongPress === undefined ? {} : { onLongPress }) }), [root, labelOf, tableOffset, onLongPress]);
  return (
    <View style={styles.gap}>
      {(root.children ?? []).map((b, i) => (
        <BlockView key={i} node={b} ctx={ctx} />
      ))}
    </View>
  );
});

/** While `active` (a reply being written) the text is taken at most every `ms`; otherwise at once. */
function useThrottled(text: string, active: boolean, ms: number): string {
  const [shown, setShown] = useState(text);
  const last = useRef(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      last.current = Date.now();
      setShown(text);
    }, Math.max(0, last.current + ms - Date.now()));
    return () => clearTimeout(timer);
  }, [text, active, ms]);
  return active ? shown : text;
}

export const STREAM_PARSE_MS = 250;

/**
 * `labelOf` turns a session id into the name shown in a `@s-02` mention; without it mentions stay as written.
 * `streaming`: the reply is still being written, so it is parsed at most every 250 ms.
 */
export function Markdown({ text, labelOf, tableOffset, streaming = false, onLongPress }: { text: string; labelOf?: (sessionId: string) => string; tableOffset?: number; streaming?: boolean; onLongPress?: () => void }) {
  const shown = useThrottled(text, streaming, STREAM_PARSE_MS);
  return (
    <Boundary text={shown}>
      <Tree text={shown} {...(labelOf === undefined ? {} : { labelOf })} {...(tableOffset === undefined ? {} : { tableOffset })} {...(onLongPress === undefined ? {} : { onLongPress })} />
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
  tableScroll: { flexGrow: 0 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'stretch' },
  cell: { paddingHorizontal: 10, paddingVertical: 6 },
});
