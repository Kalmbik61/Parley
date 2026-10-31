import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import type { InboxItem } from '@parley/remote-client';
import { spacing, typography, useColors } from '../theme';
import { Button } from '../ui/Button';
import { gistView, timeAgo } from './model';
import { needReason } from './status';
import { useDecision } from './use-decision';

const PAUSED = 'Reconnecting — actions are paused';

export interface InboxRowProps {
  item: InboxItem;
  now: number;
  canAct: boolean;
  onOpen(): void;
  /** Long press: the context menu of D1 §7. */
  onMenu?(): void;
}

function Shell({ icon, kind, at, now, title, sub, children, onOpen, onMenu, dim, label }: {
  icon: SFSymbol;
  kind: string;
  at: string;
  now: number;
  title: string;
  sub: string | null;
  children?: React.ReactNode;
  onOpen(): void;
  onMenu?(): void;
  dim?: boolean;
  label: string;
}) {
  const c = useColors();
  return (
    <View style={[styles.card, { backgroundColor: c.surface, opacity: dim === true ? 0.6 : 1 }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint="Long press for more" onPress={onOpen} onLongPress={onMenu} style={styles.top}>
        <View style={styles.meta}>
          <SymbolView name={icon} size={16} tintColor={c.needsYou} />
          <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
            {kind}
            {timeAgo(at, now) === null ? '' : ` · ${timeAgo(at, now)}`}
          </Text>
        </View>
        <Text numberOfLines={1} allowFontScaling style={[typography.headline, { color: c.label }]}>
          {title}
        </Text>
        {sub !== null && (
          <Text numberOfLines={1} allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>
            {sub}
          </Text>
        )}
      </Pressable>
      {children}
    </View>
  );
}

function Gist({ text, mono }: { text: string; mono: boolean }) {
  const c = useColors();
  return (
    <View style={[styles.gist, { backgroundColor: c.surface2 }]}>
      <Text numberOfLines={2} allowFontScaling style={[typography.footnote, { color: c.label, fontFamily: mono ? 'Menlo' : undefined }]}>
        {mono ? `$ ${text}` : text}
      </Text>
    </View>
  );
}

function CardRow({ item, now, canAct, onOpen, onMenu }: InboxRowProps & { item: Extract<InboxItem, { kind: 'card' }> }) {
  const c = useColors();
  const d = useDecision(item.ref, item.card.cardId);
  const view = gistView(item.gist);
  const card = item.card;
  return (
    <Shell
      icon={view.icon}
      kind={card.kind === 'permission' ? 'Permission' : card.kind === 'question' ? 'Question' : 'Plan'}
      at={item.at}
      now={now}
      title={item.sessionLabel}
      sub={item.workTitle}
      dim={d.busy}
      onOpen={onOpen}
      onMenu={onMenu}
      label={`${card.kind === 'permission' ? 'Permission' : card.kind === 'question' ? 'Question' : 'Plan'}. ${item.sessionLabel}, ${item.workTitle}. ${view.summary}. ${timeAgo(item.at, now) ?? ''} ago.`}
    >
      {card.kind === 'permission' ? (
        <>
          <Gist text={view.summary} mono={view.mono} />
          <View style={styles.pair}>
            <Button title="Deny" flex disabled={!canAct || d.busy} onPress={() => void d.submit({ kind: 'permission', behavior: 'deny' })} />
            <Button title="Allow" variant="prominent" icon="faceid" hint="Requires Face ID" flex loading={d.busy} disabled={!canAct} onPress={() => void d.submit({ kind: 'permission', behavior: 'allow' })} />
          </View>
        </>
      ) : (
        <Pressable accessibilityRole="button" onPress={onOpen} style={styles.open}>
          <Text allowFontScaling style={[typography.subheadline, { color: c.label2, flex: 1 }]} numberOfLines={2}>
            {card.kind === 'question' ? item.gist.kind === 'question' ? item.gist.text : '' : 'Plan ready for review'}
          </Text>
          <Text allowFontScaling style={[typography.subheadline, { color: c.tint, fontWeight: '600' }]}>
            {card.kind === 'question' ? 'Answer ›' : 'Review ›'}
          </Text>
        </Pressable>
      )}
      {(!canAct || d.message !== null) && (
        <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.caption1, styles.note, { color: c.label2 }]}>
          {!canAct ? PAUSED : d.message}
        </Text>
      )}
    </Shell>
  );
}

export function InboxRow(props: InboxRowProps) {
  const c = useColors();
  const { item, now, onOpen, onMenu } = props;
  if (item.kind === 'card') return <CardRow {...props} item={item} />;
  if (item.kind === 'need') {
    const icon: SFSymbol = item.need?.kind === 'limit' ? 'hourglass' : item.need?.kind === 'sign-in' ? 'person.badge.key' : 'hand.raised';
    const reason = item.loadError ? "Couldn't load the request · Open" : needReason(item.need);
    return (
      <Shell icon={icon} kind="Needs you" at={item.at} now={now} title={item.sessionLabel} sub={item.workTitle} onOpen={onOpen} onMenu={onMenu} label={`Needs you. ${item.sessionLabel}, ${item.workTitle}. ${reason}`}>
        <Pressable accessibilityRole="button" onPress={onOpen} style={styles.open}>
          <Text allowFontScaling style={[typography.subheadline, { flex: 1, color: c.label2 }]} numberOfLines={2}>
            {reason}
          </Text>
        </Pressable>
      </Shell>
    );
  }
  if (item.kind === 'decision') {
    return (
      <Shell icon="checkmark.seal" kind="Decision" at={item.at} now={now} title={item.roomTitle} sub={item.workTitle} onOpen={onOpen} onMenu={onMenu} label={`Decision. ${item.roomTitle}, ${item.workTitle}. ${item.text.split('\n')[0]}`}>
        <Pressable accessibilityRole="button" onPress={onOpen} style={styles.open}>
          <Text allowFontScaling style={[typography.subheadline, { flex: 1, color: c.label2 }]} numberOfLines={2}>
            {item.text.split('\n').find((l) => l.trim() !== '') ?? ''}
          </Text>
          <Text allowFontScaling style={[typography.subheadline, { color: c.tint, fontWeight: '600' }]}>
            Review ›
          </Text>
        </Pressable>
      </Shell>
    );
  }
  return (
    <Shell icon="envelope" kind="Letter" at={item.at} now={now} title={`${item.message.from} → you`} sub={item.workTitle} onOpen={onOpen} onMenu={onMenu} label={`Letter from ${item.message.from}. ${item.workTitle}`}>
      <Text numberOfLines={2} allowFontScaling style={[typography.subheadline, styles.note, { color: c.label2 }]}>
        {item.message.text.split('\n').find((l) => l.trim() !== '') ?? ''}
      </Text>
    </Shell>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: spacing.cardRadius, padding: 16, gap: 12 },
  top: { gap: 4 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  gist: { borderRadius: spacing.nestedRadius, padding: 10 },
  pair: { flexDirection: 'row', gap: 12 },
  open: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  note: { marginTop: -4 },
});

/** Row shown for 2 s after a card was answered at the Mac. */
export function GoneRow({ sessionLabel, workTitle }: { sessionLabel: string; workTitle: string }) {
  const c = useColors();
  return (
    <View accessibilityLiveRegion="polite" style={[styles.card, { backgroundColor: c.surface, opacity: 0.8 }]}>
      <Text numberOfLines={1} allowFontScaling style={[typography.headline, { color: c.label }]}>
        {sessionLabel}
      </Text>
      <Text allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>
        Answered at your Mac{workTitle === '' ? '' : ` · ${workTitle}`}
      </Text>
    </View>
  );
}
