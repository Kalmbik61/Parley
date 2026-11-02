// Consent cards (D1 §7.3): folder trust and provider switch. The app lock covers Face ID.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { ConsentCard } from '@parley/protocol';
import { spacing, typography, useColors } from '../theme';
import { Button } from '../ui/Button';
import { folderName, TRUST_BODY, TRUST_LINE, trustRequestedBy, trustTitle } from './consent-model';
import { timeAgo } from './model';
import type { ConsentRow } from './use-consents';

const PAUSED = 'Reconnecting — actions are paused';

export function ConsentCardView({
  row,
  now,
  canAct,
  onDecide,
  onOpenSession,
  switchLabel,
  fromLabel,
}: {
  row: ConsentRow;
  now: number;
  canAct: boolean;
  onDecide(card: ConsentCard, decision: 'allow' | 'deny'): void;
  onOpenSession?(): void;
  /** The label of the session that is continued (from the projection). */
  switchLabel?: string;
  /** "Claude · opus" of that session. */
  fromLabel?: string;
}) {
  const c = useColors();
  const { card } = row;
  const [more, setMore] = useState(false);
  const off = !canAct || row.busy || row.settled;
  const isTrust = card.kind === 'folder-trust';
  const ago = timeAgo(card.at, now);
  return (
    <View style={[styles.card, { backgroundColor: c.surface, opacity: row.settled ? 0.7 : 1 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={isTrust ? trustTitle(card) : `Continue ${switchLabel ?? 'the session'} on ${card.providerLabel}?`}
        onPress={() => (isTrust ? setMore((m) => !m) : onOpenSession?.())}
        style={styles.top}
      >
        <View style={styles.meta}>
          <SymbolView name={isTrust ? 'folder.badge.questionmark' : 'arrow.left.arrow.right.circle'} size={16} tintColor={c.needsYou} />
          <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
            {isTrust ? 'Folder trust' : 'Provider switch'}
            {ago === null ? '' : ` · ${ago}`}
          </Text>
        </View>
        {isTrust ? (
          <>
            <Text allowFontScaling style={[typography.headline, { color: c.label }]}>
              {trustTitle(card)}
            </Text>
            <Text numberOfLines={1} ellipsizeMode="middle" allowFontScaling style={[typography.footnote, { color: c.label2, fontFamily: 'Menlo' }]}>
              {card.folder}
            </Text>
            <Text allowFontScaling style={[typography.footnote, { color: c.label2 }]}>
              {trustRequestedBy(card)}
            </Text>
            <Text allowFontScaling style={[typography.footnote, { color: c.label2 }]}>
              {more ? TRUST_BODY : TRUST_LINE} <Text style={{ color: c.tint }}>{more ? 'Less' : 'More'}</Text>
            </Text>
          </>
        ) : (
          <>
            <Text allowFontScaling style={[typography.headline, { color: c.label }]}>
              Continue {switchLabel ?? folderName(card.projectPath)} on {card.providerLabel}?
            </Text>
            <View accessible accessibilityLabel={`From ${fromLabel ?? 'the current provider'} to ${card.providerLabel} ${card.model ?? 'default'}`} style={[styles.pill, { backgroundColor: c.surface2 }]}>
              <Text allowFontScaling style={[typography.footnote, { color: c.label }]}>
                {fromLabel ?? '—'} → {card.providerLabel} · {card.model ?? 'default'}
              </Text>
            </View>
            <Text numberOfLines={3} allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>
              “{card.reason}”
            </Text>
            <Text allowFontScaling style={[typography.footnote, { color: c.label2 }]}>
              Asked by {card.requestedBy.label} · Allow stops {switchLabel ?? 'the session'} now and continues it there.
            </Text>
          </>
        )}
      </Pressable>
      {row.settled ? (
        <View style={styles.result}>
          <SymbolView name="checkmark.circle.fill" size={18} tintColor={c.success} />
          <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, { color: c.label }]}>
            {row.message}
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.pair}>
            <Button title="Deny" flex disabled={off} onPress={() => onDecide(card, 'deny')} />
            <Button title="Allow" variant="prominent" flex loading={row.busy} disabled={!canAct || row.busy} onPress={() => onDecide(card, 'allow')} />
          </View>
          {(!canAct || row.message !== null) && (
            <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>
              {!canAct ? PAUSED : row.message}
            </Text>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: spacing.cardRadius, padding: 16, gap: 12 },
  top: { gap: 4 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pill: { alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  pair: { flexDirection: 'row', gap: 12 },
  result: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
