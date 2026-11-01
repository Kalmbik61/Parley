// Session = the chat of a session (D1 §9, plan A32): a pinned two-line header, the feed with folded finished turns,
// the live waiting card, and at the bottom either the card's actions or the message field. The data layer is
// `remote-client`: `openFeed` keeps the subscription alive while this screen is open (A31).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, RefreshControl, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { attentionOfSession, selectWorks, sessionKey, type SessionRef } from '@parley/remote-client';
import { ConsentCardView } from '../../cards/ConsentViews';
import { ActiveCard, InfoCard } from '../../cards/CardViews';
import { goneEntries, useGoneDismiss } from '../../cards/gone';
import { timeAgo } from '../../cards/model';
import { capsuleOf, needReason, type Capsule } from '../../cards/status';
import { useConsents } from '../../cards/use-consents';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { Toast, useToast } from '../../components/Toast';
import { DEMO } from '../../dev/flags';
import { Composer } from '../../feed/Composer';
import { FoldRowView, OutBubble } from '../../feed/FeedViews';
import { foldFeed, type FoldRow } from '../../feed/fold';
import { visibleOut, type OutMessage } from '../../feed/outbox';
import { composerMode } from '../../feed/send';
import { useChat } from '../../feed/use-chat';
import { haptic } from '../../haptics';
import { useCanAct, useClient, useNow, useRemoteState } from '../../hooks/use-remote';
import { parseSessionParam, sessionParam, workParam } from '../../nav/refs';
import { runtime } from '../../runtime/instance';
import { spacing, typography, useColors } from '../../theme';
import { Button } from '../../ui/Button';
import { EmptyState, Skeleton } from '../../ui/parts';
import { attentionOf, TreeRows, type TreeEnv } from '../../works/TeamTree';
import { originOf } from '../../works/origin';
import { subtreeOf, teamLine } from '../../works/teams';

type Row = { t: 'fold'; row: FoldRow } | { t: 'out'; message: OutMessage };
const rowKey = (r: Row): string => (r.t === 'fold' ? `f:${r.row.key}` : `o:${r.message.id}`);
const NEAR_BOTTOM = 80;

function HeaderTitle({ name, capsule }: { name: string; capsule: Capsule | null }) {
  const c = useColors();
  const tone = capsule === null ? c.idle : capsule.tone === 'needsYou' ? c.needsYou : capsule.tone === 'working' ? c.working : capsule.tone === 'danger' ? c.danger : capsule.tone === 'success' ? c.success : capsule.tone === 'idle' ? c.idle : c.off;
  const status = capsule === null ? '' : capsule.detail === null ? capsule.label : `${capsule.label} · ${capsule.detail}`;
  return (
    <View accessible accessibilityRole="header" accessibilityLabel={`${name}. ${status}`} style={styles.headerTitle}>
      <Text numberOfLines={1} allowFontScaling style={[typography.headline, { color: c.label }]}>
        {name}
      </Text>
      {status !== '' && (
        <View style={styles.statusLine}>
          <View style={[styles.dot, { backgroundColor: tone }]} />
          <Text numberOfLines={1} allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
            {status}
          </Text>
        </View>
      )}
    </View>
  );
}

export default function SessionScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { ref: param, fresh } = useLocalSearchParams<{ ref: string; fresh?: string }>();
  const ref = parseSessionParam(param);
  const client = useClient();
  const state = useRemoteState();
  const canAct = useCanAct();
  const now = useNow(30_000);
  const toast = useToast();
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const list = useRef<FlatList<Row>>(null);
  const atBottom = useRef(true);
  const [away, setAway] = useState(0);
  const [teamOpen, setTeamOpen] = useState(false);
  const seen = useRef(0);

  const load = (r: SessionRef): void => {
    setLoadFailed(false);
    void client?.readCards(r).then((res) => {
      setLoading(false);
      setLoadFailed(!res.ok && client.store.getState().cards[sessionKey(r)]?.error === true);
    });
  };
  // Cards (attention) keep their own reader; the feed subscription lives exactly as long as this screen.
  useEffect(() => {
    if (ref === null || client === null) return;
    if (DEMO) return setLoading(false);
    client.refresher.setScreen({ kind: 'session', ref });
    load(ref);
    const closeFeed = client.openFeed(ref);
    return () => {
      closeFeed();
      client.refresher.setScreen({ kind: 'other' });
    };
  }, [client, ref?.projectPath, ref?.workId, ref?.sessionId]);

  const goneHere = useMemo(() => (state === null || ref === null ? [] : goneEntries(state).filter((g) => g.gone.sessionKey === sessionKey(ref))), [state, ref?.projectPath, ref?.workId, ref?.sessionId]);
  useGoneDismiss(client, goneHere);

  const cardCount = state !== null && ref !== null ? (state.cards[sessionKey(ref)]?.cards.length ?? 0) : 0;
  const seenCount = useRef<number | null>(null);
  useEffect(() => {
    if (loading) return;
    if (seenCount.current !== null && cardCount > seenCount.current) haptic.selection();
    seenCount.current = cardCount;
  }, [cardCount, loading]);

  const found = useMemo(() => {
    if (state === null || ref === null) return null;
    const work = state.snapshot?.works.find((w) => w.projectPath === ref.projectPath && w.id === ref.workId);
    const session = work?.sessions.find((s) => s.id === ref.sessionId);
    return work !== undefined && session !== undefined ? { work, session } : null;
  }, [state, ref?.projectPath, ref?.workId, ref?.sessionId]);

  const view = useMemo(() => {
    if (state === null || ref === null) return null;
    for (const g of selectWorks(state, { showClosed: true })) {
      const v = g.works.find((w) => w.work.projectPath === ref.projectPath && w.work.id === ref.workId);
      if (v !== undefined) return v;
    }
    return null;
  }, [state, ref?.projectPath, ref?.workId]);

  const feed = state !== null && ref !== null ? state.feeds[sessionKey(ref)] : undefined;
  const items = feed?.items;
  const folded = useMemo(() => foldFeed(items ?? [], openGroups), [items, openGroups]);
  const turnRunning = useMemo(() => {
    const last = (items ?? []).findLast((i) => i.kind === 'prompt' || i.kind === 'turn');
    return last?.kind === 'prompt';
  }, [items]);
  const chat = useChat(ref, turnRunning, toast.show);
  const out = useMemo(() => visibleOut(chat.out, items ?? []), [chat.out, items]);
  const rows = useMemo<Row[]>(() => [...folded.map((row): Row => ({ t: 'fold', row })), ...out.map((message): Row => ({ t: 'out', message }))], [folded, out]);

  const toggleGroup = useCallback((key: string) => setOpenGroups((s) => (s.has(key) ? new Set([...s].filter((k) => k !== key)) : new Set([...s, key]))), []);
  // The status line of a turn opens or closes every work group of that turn.
  const toggleTurn = useCallback(
    (controlKey: string) => {
      const at = folded.findIndex((r) => r.key === controlKey);
      const keys: string[] = [];
      for (let i = at - 1; i >= 0 && folded[i]!.kind !== 'control'; i--) {
        const r = folded[i]!;
        if (r.kind === 'item' && r.item.kind === 'prompt') break;
        if (r.kind === 'group') keys.push(r.key);
      }
      setOpenGroups((s) => (keys.every((k) => s.has(k)) ? new Set([...s].filter((k) => !keys.includes(k))) : new Set([...s, ...keys])));
    },
    [folded],
  );

  // New items: follow the end while the person is at the bottom; otherwise count them for "Jump to latest".
  const onContentSizeChange = (): void => {
    if (atBottom.current) {
      const animated = seen.current !== 0;
      // Row heights are estimated until drawn: scroll once now and once after layout settles.
      list.current?.scrollToEnd({ animated });
      setTimeout(() => atBottom.current && list.current?.scrollToEnd({ animated: false }), 120);
    }
    else setAway(Math.max(0, rows.length - seen.current));
    if (atBottom.current) seen.current = rows.length;
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const bottom = contentSize.height - layoutMeasurement.height - contentOffset.y < NEAR_BOTTOM;
    atBottom.current = bottom;
    if (bottom && away !== 0) {
      seen.current = rows.length;
      setAway(0);
    }
  };

  const shell = (title: string, body: React.ReactNode) => (
    <View style={[styles.page, { backgroundColor: c.bg }]}>
      <Stack.Screen options={{ title, headerLargeTitle: false }} />
      <View style={styles.padded}>
        <ConnectionBanner />
        {body}
      </View>
    </View>
  );
  if (ref === null || state === null || state.snapshot === null) {
    return shell('Session', ref === null ? <EmptyState icon="questionmark.circle" title="This session link is not valid" /> : <Skeleton />);
  }
  if (found === null || view === null) {
    // A session started a moment ago is not in the snapshot yet (D1 §9.6): wait for it instead of calling it gone.
    return shell(
      'Session',
      fresh === '1' ? (
        <>
          <Skeleton />
          <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, { color: c.label2, textAlign: 'center' }]}>
            Starting… the session will appear on your Mac shortly
          </Text>
        </>
      ) : (
        <EmptyState icon="questionmark.circle" title="This session is no longer on your Mac" />
      ),
    );
  }

  const { work, session } = found;
  const live = state.activity[sessionKey(ref)];
  const attention = attentionOfSession(state, ref, session);
  const need = live?.activity.need ?? session.stuck;
  const capsule = capsuleOf({ session, attention, need, subagents: live?.activity.subagents ?? 0, waitingFor: live?.activity.waitingFor ?? null, turnEndedAt: live?.activity.turnEndedAt ?? null, now });
  const entry = state.cards[sessionKey(ref)];
  const cards = entry?.cards ?? [];
  const first = cards[0];
  const rest = cards.slice(1);
  const origin = originOf(work, session.id);
  const started = timeAgo(session.startedAt, now);
  const subtitle = [session.role, session.model, started === null ? null : `started ${started} ago`].filter((x) => x !== null && x !== '').join(' · ');
  const env: TreeEnv = {
    state,
    view,
    actions: {
      openSession: (id) => router.push(`/session/${sessionParam({ ...ref, sessionId: id })}` as never),
      openDecision: (roomId, proposalId) => router.push({ pathname: '/decision', params: { ref: workParam(ref), room: roomId, proposal: proposalId } } as never),
    },
  };
  const team = subtreeOf(view.rows, session.id);
  const counts = { agents: 1 + team.filter((x) => x.row.kind === 'session').length + team.reduce((n, x) => n + (x.row.kind === 'room' ? x.row.members.length : x.row.kind === 'swarm' ? x.row.members.length : 0), 0), rooms: team.filter((x) => x.row.kind === 'room').length, swarms: team.filter((x) => x.row.kind === 'swarm').length };
  const blockedNoCard = first === undefined && attention === 'needs-you' && need?.kind !== 'limit' && need?.kind !== 'sign-in' && !loading;
  const mode = composerMode({
    hasMethod: DEMO || (state.methods?.includes('pty.send') ?? false),
    closed: session.lifecycle === 'closed',
    sleeping: session.lifecycle === 'sleeping',
    hasCard: first !== undefined,
    blockedNoCard,
    working: attention === 'working' || turnRunning,
    online: canAct,
    limitNote: need?.kind === 'limit' ? `${needReason(need)} — the agent reads it after the reset` : null,
    feedReady: feed?.status === 'ready',
  });
  const hidden = chat.switchedOff ? ({ kind: 'hidden', text: 'Messaging agents from the phone is turned off on your Mac' } as const) : mode;
  const header = (
    <View style={styles.passport}>
      <ConnectionBanner />
      {subtitle !== '' && (
        <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
          {subtitle}
        </Text>
      )}
      {origin.length > 0 && (
        <View style={styles.origin}>
          <SymbolView name="arrow.turn.left.up" size={14} tintColor={c.label2} />
          <Text allowFontScaling numberOfLines={2} style={[typography.footnote, styles.flex, { color: c.label2 }]}>
            {origin.map((o) => o.label).join(' › ')}
          </Text>
        </View>
      )}
      {team.length > 0 && (
        <View style={[styles.box, { backgroundColor: c.surface, paddingHorizontal: 0 }]}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: teamOpen }} onPress={() => setTeamOpen((o) => !o)} style={styles.teamRow}>
            <SymbolView name="person.2" size={16} tintColor={c.label2} />
            <Text allowFontScaling style={[typography.footnote, styles.flex, { color: c.label2 }]}>
              {teamLine(counts)}
            </Text>
            <SymbolView name={teamOpen ? 'chevron.down' : 'chevron.right'} size={12} tintColor={c.label2} />
          </Pressable>
          {teamOpen && <TreeRows rows={team} env={env} />}
        </View>
      )}
    </View>
  );

  const content = (parts: { body: React.ReactNode; actions: React.ReactNode } | null) => (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0} style={styles.flex}>
      <FlatList
        ref={list}
        data={rows}
        keyExtractor={rowKey}
        onContentSizeChange={onContentSizeChange}
        onScroll={onScroll}
        scrollEventThrottle={64}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => { runtime.retry(); load(ref); client?.live.reloadFeed(ref); }} />}
        ListHeaderComponent={header}
        renderItem={({ item: r }) => (r.t === 'fold' ? <FoldRowView row={r.row} onToggleGroup={toggleGroup} onToggleTurn={toggleTurn} /> : <OutBubble message={r.message} onRetry={(m) => void chat.retry(m)} onEdit={chat.edit} />)}
        ListEmptyComponent={
          feed === undefined || feed.status === 'loading' ? (
            <Skeleton rows={3} />
          ) : feed.status === 'error' ? (
            <View style={styles.center}>
              <Text allowFontScaling style={[typography.headline, { color: c.label, textAlign: 'center' }]}>Couldn't load the conversation — open the terminal on your Mac</Text>
              <Button title="Try again" onPress={() => client?.live.reloadFeed(ref)} />
            </View>
          ) : (
            <View style={styles.center}>
              <SymbolView name="bubble.left" size={28} tintColor={c.label3} />
              <Text allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>No messages yet</Text>
            </View>
          )
        }
        ListFooterComponent={
          <View style={{ gap: 12, marginTop: 12 }}>
            {goneHere.length > 0 && (
              <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, { color: c.label2, textAlign: 'center' }]}>
                Answered at your Mac
              </Text>
            )}
            {loadFailed && first === undefined && (
              <View style={styles.center}>
                <Text allowFontScaling style={[typography.headline, { color: c.label }]}>Couldn't load the requests</Text>
                <Button title="Try again" onPress={() => load(ref)} />
              </View>
            )}
            {first !== undefined && (
              <>
                {parts?.body}
                {rest.length > 0 && (
                  <Text allowFontScaling style={[typography.footnote, { color: c.label2 }]}>
                    {rest.length} more request{rest.length === 1 ? '' : 's'} waiting — answer this one first
                  </Text>
                )}
              </>
            )}
            {blockedNoCard && <InfoCard icon="desktopcomputer" title="Answer at your Mac" detail={needReason(need)} text="This request can only be answered in the terminal on your Mac." />}
            {first === undefined && need?.kind === 'limit' && <InfoCard icon="hourglass" title="Usage limit" detail={needReason(need)} text="Answer at your Mac" />}
            {first === undefined && need?.kind === 'sign-in' && <InfoCard icon="person.badge.key" title="Signed out" detail={needReason(need)} text="Answer at your Mac" />}
            {turnRunning && first === undefined && (
              <Text allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>
                Working…
              </Text>
            )}
          </View>
        }
      />
      {away > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Jump to latest, ${away} new`}
          onPress={() => {
            list.current?.scrollToEnd({ animated: true });
            atBottom.current = true;
            seen.current = rows.length;
            setAway(0);
          }}
          style={[styles.jump, { backgroundColor: c.surface, borderColor: c.separator }]}
        >
          <SymbolView name="arrow.down" size={14} tintColor={c.tint} />
          <Text allowFontScaling style={[typography.footnote, { color: c.tint }]}>Jump to latest · {away}</Text>
        </Pressable>
      )}
      <View style={[styles.footer, { backgroundColor: c.bg, borderTopColor: c.separator, paddingBottom: insets.bottom + 8 }]}>
        <SwitchCards sessionRef={ref} />
        {first !== undefined && parts !== null ? (
          parts.actions
        ) : (
          <Composer label={session.label} mode={hidden} draft={chat.draft} onChange={chat.setDraft} onSend={() => void chat.send()} busy={chat.busy} />
        )}
      </View>
      <Toast message={toast.message} />
    </KeyboardAvoidingView>
  );

  return (
    <View style={[styles.page, { backgroundColor: c.bg }]}>
      <Stack.Screen
        options={{
          headerLargeTitle: false,
          headerBackTitle: work.title,
          title: session.label,
          headerTitle: () => <HeaderTitle name={session.label} capsule={capsule} />,
          headerTransparent: Platform.OS === 'ios',
          headerBlurEffect: 'systemChromeMaterial',
        }}
      />
      {first !== undefined ? (
        <ActiveCard key={first.cardId} card={first} sessionRef={ref} projectPath={work.projectPath} canAct={canAct}>
          {(parts) => content(parts)}
        </ActiveCard>
      ) : (
        content(null)
      )}
    </View>
  );
}

/** A provider-switch request for this session stands above the feed with the same Deny / Allow as in Inbox (D1 §9.4). */
function SwitchCards({ sessionRef }: { sessionRef: SessionRef }) {
  const consents = useConsents();
  const canAct = useCanAct();
  const now = useNow(30_000);
  const mine = consents.rows.filter((r) => r.card.kind === 'agent-switch' && r.card.ref.sessionId === sessionRef.sessionId && r.card.ref.workId === sessionRef.workId);
  if (mine.length === 0) return null;
  return (
    <View style={styles.switchWrap}>
      {mine.map((row) => (
        <ConsentCardView key={row.card.id} row={row} now={now} canAct={canAct} onDecide={consents.decide} />
      ))}
    </View>
  );
}

export { attentionOf };

const styles = StyleSheet.create({
  page: { flex: 1 },
  flex: { flex: 1 },
  padded: { flex: 1, padding: 16, gap: 12 },
  list: { padding: 16, paddingTop: 8, paddingBottom: 12 },
  passport: { gap: 8, marginHorizontal: -16, paddingHorizontal: 16, paddingBottom: 12 },
  origin: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  box: { borderRadius: spacing.cardRadius, paddingVertical: 12, paddingHorizontal: 16 },
  footer: { paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  center: { alignItems: 'center', gap: 8, paddingVertical: 24 },
  headerTitle: { alignItems: 'center', maxWidth: 240 },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  jump: { position: 'absolute', alignSelf: 'center', bottom: 90, flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8 },
  teamRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, minHeight: 28 },
  switchWrap: { gap: 8, marginBottom: 8 },
});
