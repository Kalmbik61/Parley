// Pieces of the room chat screen (D1 §9.7): letters, the recipients line, the mention menu, the reply plate.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { Message } from '@parley/core';
import { haptic } from '../haptics';
import { Markdown } from '../markdown/Markdown';
import { spacing, typography, useColors } from '../theme';
import { SenderAvatar } from '../ui/avatars';
import { soft } from '../feed/FeedViews';
import { quote, toLine, type Mentionable } from './model';
import type { OutLetter } from './out-letters';
import { Button } from '../ui/Button';

export interface Who {
  label(id: string): string;
}

const time = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Text of an own letter with `@Name` chips set in the accent. */
function Mentions({ text, labels }: { text: string; labels: readonly string[] }) {
  const c = useColors();
  if (labels.length === 0) return <Text style={[typography.body, { color: c.label }]}>{text}</Text>;
  const re = new RegExp(`(@(?:${labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))(?=$|[\\s.,;:!?])`, 'g');
  return (
    <Text selectable allowFontScaling style={[typography.body, { color: c.label }]}>
      {text.split(re).map((part, i) =>
        i % 2 === 1 ? (
          <Text key={i} accessibilityLabel={`mention ${part.slice(1)}`} style={{ color: c.tint, fontWeight: '600' }}>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

export function LetterView({
  message,
  header,
  who,
  labels,
  quoted,
  delivery,
  onLongPress,
  onOpenQuote,
}: {
  message: Message;
  header: boolean;
  who: Who;
  labels: readonly string[];
  /** The letter it replies to, when held. */
  quoted: Message | null;
  delivery: string | null;
  onLongPress(m: Message): void;
  onOpenQuote(id: string): void;
}) {
  const c = useColors();
  if (message.from === 'system') {
    return (
      <Text allowFontScaling style={[typography.caption1, { color: c.label2, textAlign: 'center' }]}>
        — {quote(message.text, 160)} —
      </Text>
    );
  }
  const name = message.from === 'human' ? 'You' : who.label(message.from);
  const to = message.to.length > 0 ? message.to.map((id) => `@${who.label(id)}`).join(', ') : null;
  const quoteLine = message.replyTo !== undefined && (
    <Pressable accessibilityRole="button" onPress={() => onOpenQuote(message.replyTo!)} style={[styles.quote, { borderLeftColor: c.tint }]}>
      <Text numberOfLines={1} allowFontScaling style={[typography.footnote, { color: c.label2 }]}>
        {quoted === null ? 'Earlier message' : `${quoted.from === 'human' ? 'You' : who.label(quoted.from)}: ${quote(quoted.text, 60)}`}
      </Text>
    </Pressable>
  );
  if (message.from === 'human') {
    return (
      <Pressable onLongPress={() => onLongPress(message)} accessibilityLabel={`You${to === null ? '' : `, to ${to}`}: ${message.text}`} style={styles.mine}>
        <View style={[styles.bubble, { backgroundColor: soft(c.tint) }]}>
          {quoteLine}
          <Mentions text={message.text} labels={labels} />
        </View>
        {delivery !== null && (
          <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
            {delivery}
          </Text>
        )}
      </Pressable>
    );
  }
  return (
    <Pressable onLongPress={() => onLongPress(message)} accessibilityLabel={`${name}, ${time(message.at)}${to === null ? '' : `, to ${to}`}: ${message.text}`} style={styles.theirs}>
      {header ? <SenderAvatar name={name} /> : <View style={{ width: 28 }} />}
      <View style={styles.flex}>
        {header && (
          <View style={styles.head}>
            <Text allowFontScaling style={[typography.subheadline, { color: c.label, fontWeight: '600' }]}>
              {name}
            </Text>
            <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
              {time(message.at)}
            </Text>
            {message.kind === 'question' && (
              <View style={[styles.capsule, { backgroundColor: c.neutralBg }]}>
                <Text allowFontScaling style={[typography.caption2, { color: c.label2 }]}>
                  Question
                </Text>
              </View>
            )}
          </View>
        )}
        {to !== null && header && (
          <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
            → {to}
          </Text>
        )}
        {quoteLine}
        <Markdown text={message.text} />
        {message.textBytes !== undefined && (
          <Text allowFontScaling style={[typography.footnote, { color: c.label2 }]}>
            Text shortened — open the terminal for the rest
          </Text>
        )}
      </View>
    </Pressable>
  );
}

export function OutLetterView({ letter, onRetry }: { letter: OutLetter; onRetry(l: OutLetter): void }) {
  const c = useColors();
  return (
    <View style={styles.mine}>
      <View style={[styles.bubble, { backgroundColor: soft(c.tint), opacity: letter.state === 'sending' ? 0.6 : 1 }]}>
        <Text selectable allowFontScaling style={[typography.body, { color: c.label }]}>
          {letter.text}
        </Text>
      </View>
      <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.caption1, { color: letter.state === 'failed' ? c.needsYou : c.label2 }]}>
        {letter.state === 'sending' ? 'Sending…' : letter.state === 'sent' ? 'Sent' : (letter.note ?? 'Not sent')}
      </Text>
      {letter.state === 'failed' && <Button variant="plain" title="Retry" onPress={() => onRetry(letter)} />}
    </View>
  );
}

/** "To Greta, Critic-A1" above the field. */
export function ToLine({ names }: { names: readonly string[] }) {
  const c = useColors();
  return (
    <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
      {toLine(names)}
    </Text>
  );
}

/** The menu of agents above the keyboard (D1 §9.7): avatar, name, `model · state`. */
export function MentionMenu({ agents, onPick }: { agents: readonly Mentionable[]; onPick(a: Mentionable): void }) {
  const c = useColors();
  return (
    <View accessibilityLabel="Agents in this room" style={[styles.menu, { backgroundColor: c.surface, borderColor: c.separator }]}>
      <Text allowFontScaling style={[typography.caption1, { color: c.label2, paddingHorizontal: 12, paddingTop: 8 }]}>
        Agents in this room
      </Text>
      {agents.length === 0 ? (
        <Text allowFontScaling style={[typography.subheadline, { color: c.label2, padding: 12 }]}>
          No agents match
        </Text>
      ) : (
        agents.map((a) => (
          <Pressable
            key={a.id}
            accessibilityRole="button"
            accessibilityLabel={`Mention ${a.label}, ${a.meta}`}
            onPress={() => {
              haptic.selection();
              onPick(a);
            }}
            style={styles.menuRow}
          >
            <SenderAvatar name={a.label} size={24} />
            <Text numberOfLines={1} allowFontScaling style={[typography.subheadline, { color: c.label, fontWeight: '600' }]}>
              {a.label}
            </Text>
            <Text numberOfLines={1} allowFontScaling style={[typography.caption1, styles.flex, { color: c.label2, textAlign: 'right' }]}>
              {a.meta}
            </Text>
          </Pressable>
        ))
      )}
    </View>
  );
}

export function ReplyPlate({ message, who, onClear }: { message: Message; who: Who; onClear(): void }) {
  const c = useColors();
  return (
    <View style={[styles.plate, { backgroundColor: c.surface2 }]}>
      <Text numberOfLines={1} allowFontScaling style={[typography.footnote, styles.flex, { color: c.label2 }]}>
        Reply to {message.from === 'human' ? 'yourself' : who.label(message.from)} · {quote(message.text, 50)}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Remove the reply" onPress={onClear} hitSlop={12}>
        <SymbolView name="xmark.circle.fill" size={18} tintColor={c.label3} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  mine: { alignItems: 'flex-end', gap: 4 },
  bubble: { maxWidth: '80%', borderRadius: spacing.cardRadius, paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  theirs: { flexDirection: 'row', gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  capsule: { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  quote: { borderLeftWidth: 2, paddingLeft: 8, marginVertical: 2 },
  menu: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, marginBottom: 8, overflow: 'hidden' },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 44 },
  plate: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 6 },
});
