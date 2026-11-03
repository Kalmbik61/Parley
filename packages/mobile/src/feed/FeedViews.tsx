// Feed rows for the session screen (D1 §9.2–9.3): bubbles, Markdown replies, tool rows, subagents, notices, the folded
// work row and the turn status line. Raw Markdown is never shown: replies and prompts go through <Markdown>/<Text>.
import { memo, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import type { FeedItem } from '@parley/core';
import { haptic } from '../haptics';
import { Markdown } from '../markdown/Markdown';
import { spacing, typography, useColors } from '../theme';
import { Button } from '../ui/Button';
import type { FoldRow, WorkKind } from './fold';
import { turnStatusText } from './fold';
import { CARD_STATE_TEXT, errorText, noticeText, toolName, toolSummary } from './summary';
import type { OutMessage } from './outbox';
import { HELD_BUBBLE, WAITING_BUBBLE } from './resume';
import type { Action, ActionId } from './message-actions';
import { quotePreview } from './quote-preview';
import { splitQuote } from './reply';

export const soft = (color: string, alpha = '26'): string => (/^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : color);

const KIND_ICON: Record<WorkKind, SFSymbol> = {
  read: 'doc.text',
  search: 'magnifyingglass',
  shell: 'terminal',
  edit: 'pencil',
  web: 'globe',
  browser: 'safari',
  agents: 'person.2',
  parley: 'bubble.left.and.bubble.right',
  tools: 'wrench.and.screwdriver',
};

/** What the long-press sheet does, shared with VoiceOver's custom actions (critic A42 M6). Stable: it is read through a ref. */
export interface MessageApi {
  actions(item: FeedItem): Action[];
  run(item: FeedItem, id: ActionId): void;
  sheet(item: FeedItem): void;
}

/** The prompt's leading `>` lines as a folded quote (D1 §9.2): a `tint` bar, up to three lines, without Markdown marks. */
export function QuoteBlock({ quote }: { quote: string }) {
  const c = useColors();
  return (
    <View style={[styles.quote, { borderLeftColor: c.tint }]}>
      <Text numberOfLines={3} allowFontScaling style={[typography.footnote, { color: c.label2 }]}>
        {quotePreview(quote)}
      </Text>
    </View>
  );
}

function Bubble({ text, dim, msg, item, children }: { text: string; dim?: boolean; msg?: MessageApi; item?: FeedItem; children?: React.ReactNode }) {
  const c = useColors();
  // The host's paste may leave blank lines at the edges: split the trimmed text (as the window does).
  const { quote, text: body } = splitQuote(text.trim());
  const label = `You: ${quote === null ? '' : `quoting ${quotePreview(quote)}. `}${body}`;
  const style = [styles.bubble, { backgroundColor: soft(c.tint), opacity: dim === true ? 0.6 : 1 }];
  const inner = (
    <>
      {quote !== null && <QuoteBlock quote={quote} />}
      {body !== '' && (
        <Text allowFontScaling style={[typography.body, { color: c.label }]}>
          {body}
        </Text>
      )}
    </>
  );
  const actions = msg !== undefined && item !== undefined ? msg.actions(item).filter((a) => a.disabled !== true) : [];
  return (
    <View style={styles.bubbleWrap}>
      {msg === undefined || item === undefined ? (
        <View accessible accessibilityLabel={label} style={style}>
          {inner}
        </View>
      ) : (
        <Pressable
          onLongPress={() => msg.sheet(item)}
          accessible
          accessibilityLabel={label}
          accessibilityActions={actions.map((a) => ({ name: a.id, label: a.title }))}
          onAccessibilityAction={(e) => msg.run(item, e.nativeEvent.actionName as ActionId)}
          style={style}
        >
          {inner}
        </Pressable>
      )}
      {children}
    </View>
  );
}

const toolIcon = (name: string): SFSymbol => {
  const kind = /^(Read|NotebookRead|ViewImage)$/.test(name) ? 'read' : /^(Grep|Glob|LS)$/.test(name) ? 'search' : /^(Bash|exec_command|BashOutput)$/.test(name) ? 'shell' : /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/.test(name) ? 'edit' : /^(WebFetch|WebSearch)$/.test(name) ? 'web' : 'tools';
  return KIND_ICON[kind];
};

function ToolRow({ item }: { item: Extract<FeedItem, { kind: 'tool' }> }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const summary = toolSummary(item);
  const status: SFSymbol | null = item.status === 'done' ? 'checkmark' : item.status === 'failed' ? 'xmark.circle' : item.status === 'rejected' ? 'hand.raised' : null;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Tool ${toolName(item.name)}, ${summary}, ${item.status}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        style={styles.toolRow}
      >
        <SymbolView name={toolIcon(item.name)} size={16} tintColor={c.label2} />
        <Text allowFontScaling style={[typography.subheadline, { color: c.label, fontWeight: '600' }]}>
          {toolName(item.name)}
        </Text>
        <Text numberOfLines={1} allowFontScaling style={[typography.footnote, styles.flex, { color: c.label2, fontFamily: 'Menlo' }]}>
          {summary}
        </Text>
        {status === null ? (
          <Text allowFontScaling style={[typography.caption1, { color: c.working }]}>
            …
          </Text>
        ) : (
          <SymbolView name={status} size={14} tintColor={item.status === 'failed' ? c.danger : c.label2} />
        )}
      </Pressable>
      {open && (
        <View style={[styles.detail, { backgroundColor: c.surface2 }]}>
          <ScrollView horizontal>
            <Text selectable allowFontScaling style={[typography.footnote, { color: c.label, fontFamily: 'Menlo' }]}>
              {JSON.stringify(item.input, null, 2).slice(0, 4000)}
            </Text>
          </ScrollView>
          {item.response !== undefined && item.response.text !== '' && (
            <ScrollView horizontal>
              <Text selectable allowFontScaling style={[typography.footnote, { color: c.label2, fontFamily: 'Menlo' }]}>
                {item.response.text.slice(0, 4000)}
                {item.response.truncated ? '\n… truncated, open the terminal' : ''}
              </Text>
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}

function AgentCard({ item }: { item: Extract<FeedItem, { kind: 'agent' }> }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.agent, { backgroundColor: c.surface2 }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((o) => !o)} style={styles.toolRow}>
        <SymbolView name={item.status === 'running' ? 'person.crop.circle' : 'person.crop.circle.badge.checkmark'} size={18} tintColor={c.label2} />
        <View style={styles.flex}>
          <Text numberOfLines={1} allowFontScaling style={[typography.subheadline, { color: c.label, fontWeight: '600' }]}>
            {item.description ?? item.agentType ?? 'Agent'}
          </Text>
          <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
            {item.toolCount === 1 ? '1 tool call' : `${item.toolCount} tool calls`}
            {item.background ? ' · background' : ''}
            {item.status === 'failed' ? ' · failed' : ''}
          </Text>
        </View>
      </Pressable>
      {open && item.result !== undefined && <Markdown text={item.result} />}
    </View>
  );
}

function Centered({ text, icon, tone }: { text: string; icon?: SFSymbol; tone?: 'danger' | 'needs' }) {
  const c = useColors();
  const color = tone === 'danger' ? c.danger : tone === 'needs' ? c.needsYou : c.label2;
  return (
    <View style={styles.centered}>
      {icon !== undefined && <SymbolView name={icon} size={13} tintColor={color} />}
      <Text allowFontScaling style={[typography.caption1, { color, textAlign: 'center' }]}>
        {text}
      </Text>
    </View>
  );
}

/** An agent reply: one accessible element "Agent: <text>" (D1 §9.6) with the message actions; long press anywhere, links included. */
function ReplyText({ item, msg }: { item: Extract<FeedItem, { kind: 'text' }>; msg?: MessageApi }) {
  const c = useColors();
  const label = useMemo(() => `Agent: ${quotePreview(item.text)}`, [item.text]);
  const actions = msg === undefined ? [] : msg.actions(item).filter((a) => a.disabled !== true);
  const sheet = msg !== undefined && !item.streaming ? () => msg.sheet(item) : undefined;
  return (
    <Pressable
      disabled={sheet === undefined}
      onLongPress={sheet}
      accessible
      accessibilityLabel={label}
      accessibilityActions={sheet === undefined ? [] : actions.map((a) => ({ name: a.id, label: a.title }))}
      onAccessibilityAction={(e) => msg?.run(item, e.nativeEvent.actionName as ActionId)}
      style={styles.reply}
    >
      <Markdown text={item.text} streaming={item.streaming} {...(sheet === undefined ? {} : { onLongPress: sheet })} />
      {item.streaming && (
        <Text accessibilityElementsHidden allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
          Writing…
        </Text>
      )}
      {item.truncated === true && (
        <Text allowFontScaling style={[typography.footnote, { color: c.label2 }]}>
          Text truncated — open the terminal for the rest
        </Text>
      )}
    </Pressable>
  );
}

/** Items of the feed. Pending cards are not drawn here: the screen shows the live card body at the end (D1 §9.4). */
export const FeedItemView = memo(function FeedItemView({ item, msg }: { item: FeedItem; /** Message actions on an agent reply and an own prompt (D1 §9.2). */ msg?: MessageApi }) {
  switch (item.kind) {
    case 'prompt':
      return <Bubble text={item.images > 0 && item.text === '' ? `${item.images} images` : item.text} {...(msg === undefined || item.text.trim() === '' ? {} : { msg, item })} />;
    case 'text':
      return <ReplyText item={item} {...(msg === undefined ? {} : { msg })} />;
    case 'tool':
      return <ToolRow item={item} />;
    case 'agent':
      return <AgentCard item={item} />;
    case 'permission':
    case 'question':
    case 'plan':
      return item.state === 'pending' ? null : <Centered text={CARD_STATE_TEXT[item.state] ?? item.state} icon={item.state === 'denied' ? 'xmark.circle' : 'checkmark.circle'} />;
    case 'notice':
      return <Centered text={noticeText(item)} />;
    case 'error':
      return <Centered text={errorText(item)} icon="exclamationmark.triangle" tone={item.retry === undefined ? 'danger' : undefined} />;
    case 'turn':
      return null;
  }
});

export function FoldRowView({ row, onToggleGroup, onToggleTurn, msg }: { row: FoldRow; onToggleGroup(key: string): void; onToggleTurn(key: string): void; msg?: MessageApi }) {
  const c = useColors();
  if (row.kind === 'item') return <FeedItemView item={row.item} {...(msg === undefined ? {} : { msg })} />;
  if (row.kind === 'control') {
    const tone = row.status === 'failed' ? c.danger : row.status === 'stopped' ? c.needsYou : c.label2;
    const text = turnStatusText(row.status, row.durationMs);
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={text} onPress={() => onToggleTurn(row.key)} style={styles.control}>
        <View style={[styles.rule, { backgroundColor: c.separator }]} />
        <Text allowFontScaling style={[typography.caption1, { color: tone }]}>
          {text}
        </Text>
        <View style={[styles.rule, { backgroundColor: c.separator }]} />
      </Pressable>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.title}, ${row.count} steps, ${row.open ? 'expanded' : 'collapsed'}`}
      accessibilityState={{ expanded: row.open }}
      onPress={() => {
        haptic.selection();
        onToggleGroup(row.key);
      }}
      style={styles.group}
    >
      <SymbolView name={row.open ? 'chevron.down' : 'chevron.right'} size={12} tintColor={c.label2} />
      {row.kinds.slice(0, 3).map((k) => (
        <SymbolView key={k} name={KIND_ICON[k]} size={14} tintColor={c.label2} />
      ))}
      <Text numberOfLines={1} allowFontScaling style={[typography.subheadline, styles.flex, { color: c.label2 }]}>
        {row.title} · {row.count}
      </Text>
    </Pressable>
  );
}

/** My message not (yet) in the feed, with its state (D1 §9.5). */
export function OutBubble({ message, onRetry, onEdit }: { message: OutMessage; onRetry(m: OutMessage): void; onEdit(m: OutMessage): void }) {
  const c = useColors();
  const s = message.state;
  let caption: string | null = null;
  let icon: SFSymbol | null = null;
  if (s.kind === 'sending') caption = 'Sending…';
  else if (s.kind === 'waking') caption = WAITING_BUBBLE;
  else if (s.kind === 'held') {
    caption = HELD_BUBBLE;
    icon = 'hand.raised.fill';
  }
  else if (s.kind === 'sent') caption = 'Sent';
  else if (s.kind === 'queued') {
    caption = 'Queued — the agent reads it when the turn ends';
    icon = 'clock';
  } else if (s.kind === 'unconfirmed') {
    caption = "We couldn't confirm it was sent";
    icon = 'exclamationmark.arrow.triangle.2.circlepath';
  } else if (s.kind === 'typed-not-sent') {
    caption = s.message;
    icon = 'exclamationmark.triangle';
  } else {
    caption = s.message;
    icon = 'exclamationmark.circle';
  }
  return (
    <Bubble text={message.text} dim={s.kind === 'sending' || s.kind === 'waking' || s.kind === 'held'}>
      <View style={styles.caption}>
        {s.kind === 'waking' && <ActivityIndicator size="small" color={c.label2} />}
        {icon !== null && <SymbolView name={icon} size={12} tintColor={s.kind === 'failed' || s.kind === 'typed-not-sent' || s.kind === 'held' ? c.needsYou : c.label2} />}
        <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.caption1, styles.flexShrink, { color: c.label2, textAlign: 'right' }]}>
          {caption}
        </Text>
      </View>
      {(s.kind === 'unconfirmed' || (s.kind === 'failed' && s.retry)) && <Button variant="plain" title="Retry" onPress={() => onRetry(message)} />}
      {s.kind === 'failed' && s.edit && <Button variant="plain" title="Edit" onPress={() => onEdit(message)} />}
    </Bubble>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  bubbleWrap: { alignItems: 'flex-end', gap: 4 },
  bubble: { maxWidth: '80%', borderRadius: spacing.cardRadius, paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  quote: { borderLeftWidth: 3, paddingLeft: 8 },
  reply: { gap: 4 },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  detail: { borderRadius: 10, padding: 10, gap: 8 },
  agent: { borderRadius: spacing.cardRadius, paddingHorizontal: 12 },
  centered: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  control: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  group: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  caption: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '90%' },
});
