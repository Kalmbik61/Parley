// Consent cards (D1 §7.3): folder trust and provider switch. The app lock covers Face ID.
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { AgentSwitchCard, ConsentCard, FolderTrustCard, ProjectMcpCard } from '@parley/protocol';
import { spacing, typography, useColors } from '../theme';
import { Button } from '../ui/Button';
import { enabledPairs, folderName, MCP_AT_MAC, mcpShapeKey, mcpTitle, projectMcpDrawable, TRUST_BODY, TRUST_LINE, trustRequestedBy, trustTitle } from './consent-model';
import { DEMO } from '../dev/flags';
import { DEMO_MCP_ON } from '../dev/demo';
import { timeAgo } from './model';
import type { ConsentRow } from './use-consents';

const PAUSED = 'Reconnecting — actions are paused';

type Enabled = ReadonlyArray<{ name: string; fingerprint: string }>;
interface ConsentCardViewProps {
  row: ConsentRow;
  now: number;
  canAct: boolean;
  onDecide(card: ConsentCard, decision: 'allow' | 'deny', enabled?: Enabled): void;
  onOpenSession?(): void;
  /** The label of the session that is continued (from the projection). */
  switchLabel?: string;
  /** "Claude · opus" of that session. */
  fromLabel?: string;
}

export function ConsentCardView(props: ConsentCardViewProps) {
  const card = props.row.card;
  if (card.kind === 'project-mcp') return <ProjectMcpCardView {...props} card={card} />;
  return <ClassicConsentCard {...props} card={card} />;
}

/** Project MCP servers (spec 2026-11-02, 7.2): every server off by default; the human switches on what to start. */
function ProjectMcpCardView({ row, now, canAct, onDecide, card }: ConsentCardViewProps & { card: ProjectMcpCard }) {
  const c = useColors();
  const [on, setOn] = useState<ReadonlySet<string>>(() => new Set(DEMO ? (DEMO_MCP_ON[card.id] ?? []) : []));
  const shape = mcpShapeKey(card);
  // The list changed (re-read after bad_request, or a new host state): the switches were set for another card.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else setOn(new Set());
  }, [shape]);
  const ago = timeAgo(card.at, now);
  const off = !canAct || row.busy || row.settled;
  const drawable = projectMcpDrawable(card);
  const toggle = (name: string, value: boolean): void =>
    setOn((prev) => {
      const next = new Set(prev);
      if (value) next.add(name);
      else next.delete(name);
      return next;
    });
  return (
    <View style={[styles.card, { backgroundColor: c.surface, opacity: row.settled ? 0.7 : 1 }]}>
      <View style={styles.top}>
        <View style={styles.meta}>
          <SymbolView name="server.rack" size={16} tintColor={c.needsYou} />
          <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
            Project MCP servers
            {ago === null ? '' : ` · ${ago}`}
          </Text>
        </View>
        <Text allowFontScaling style={[typography.headline, { color: c.label }]}>
          {mcpTitle(card)}
        </Text>
        <Text numberOfLines={1} ellipsizeMode="middle" allowFontScaling style={[typography.footnote, { color: c.label2, fontFamily: 'Menlo' }]}>
          {card.repo}
        </Text>
        {drawable &&
          card.servers.map((server) => (
            <View key={server.name} style={styles.server}>
              <View style={styles.serverText}>
                <Text allowFontScaling style={[typography.body, { color: c.label }]}>
                  {server.name}
                </Text>
                <Text numberOfLines={2} allowFontScaling style={[typography.footnote, { color: c.label2, fontFamily: 'Menlo' }]}>
                  {server.command}
                </Text>
              </View>
              <Switch accessibilityLabel={`Enable ${server.name}`} value={on.has(server.name)} disabled={off || !row.canDecide} onValueChange={(v) => toggle(server.name, v)} />
            </View>
          ))}
      </View>
      {row.settled ? (
        <View style={styles.result}>
          <SymbolView name="checkmark.circle.fill" size={18} tintColor={c.success} />
          <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, { color: c.label }]}>
            {row.message}
          </Text>
        </View>
      ) : !drawable || !row.canDecide ? (
        <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>
          {drawable ? `${MCP_AT_MAC} — approving from the phone is turned off there` : MCP_AT_MAC}
        </Text>
      ) : (
        <>
          <View style={styles.pair}>
            <Button title="Reject all" flex disabled={off} onPress={() => onDecide(card, 'deny')} />
            <Button title="Enable selected" variant="prominent" flex loading={row.busy} disabled={!canAct || row.busy || on.size === 0} onPress={() => onDecide(card, 'allow', enabledPairs(card, on))} />
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

function ClassicConsentCard({
  row,
  now,
  canAct,
  onDecide,
  onOpenSession,
  switchLabel,
  fromLabel,
  card,
}: ConsentCardViewProps & { card: FolderTrustCard | AgentSwitchCard }) {
  const c = useColors();
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
      ) : !row.canDecide ? (
        <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>
          Answer at your Mac — approving from the phone is turned off there
        </Text>
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
  server: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 8 },
  serverText: { flex: 1, gap: 2 },
  result: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
