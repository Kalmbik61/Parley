import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { attentionOfSession, selectWorks, sessionKey, type RemoteState, type SessionRef } from '@parley/remote-client';
import { ActiveCard, InfoCard } from '../../cards/CardViews';
import { goneEntries, useGoneDismiss } from '../../cards/gone';
import { capsuleOf, needReason } from '../../cards/status';
import { timeAgo } from '../../cards/model';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { DEMO } from '../../dev/flags';
import { haptic } from '../../haptics';
import { useCanAct, useClient, useNow, useRemoteState } from '../../hooks/use-remote';
import { Markdown } from '../../markdown/Markdown';
import { parseSessionParam, sessionParam, workParam } from '../../nav/refs';
import { runtime } from '../../runtime/instance';
import { spacing, typography, useColors } from '../../theme';
import { Button } from '../../ui/Button';
import { EmptyState, SectionHeader, Skeleton, StatusCapsule } from '../../ui/parts';
import { attentionOf, TreeRows, type TreeEnv } from '../../works/TeamTree';
import { subtreeOf, teamLine } from '../../works/teams';
import { originOf } from '../../works/origin';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Reply preview: ~6 lines of body text, then "Show more" (D1 §9.3). */
const REPLY_CLAMP = 6 * 22;

function Reply({ text }: { text: string }) {
  const c = useColors();
  const [more, setMore] = useState(false);
  const long = text.length > 280 || text.split('\n').length > 6;
  return (
    <View style={[styles.box, { backgroundColor: c.surface }]}>
      <View style={!more && long ? { maxHeight: REPLY_CLAMP, overflow: 'hidden' } : undefined}>
        <Markdown text={text} />
      </View>
      {long && <Button variant="plain" title={more ? 'Show less' : 'Show more'} onPress={() => setMore((m) => !m)} />}
    </View>
  );
}

export default function SessionScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { ref: param } = useLocalSearchParams<{ ref: string }>();
  const ref = parseSessionParam(param);
  const client = useClient();
  const state = useRemoteState();
  const canAct = useCanAct();
  const now = useNow(30_000);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = (r: SessionRef): void => {
    setLoadFailed(false);
    void client?.readCards(r).then((res) => {
      setLoading(false);
      setLoadFailed(!res.ok && client.store.getState().cards[sessionKey(r)]?.error === true);
    });
  };
  useEffect(() => {
    if (ref === null || client === null) return;
    if (DEMO) return setLoading(false);
    client.refresher.setScreen({ kind: 'session', ref });
    load(ref);
    return () => client.refresher.setScreen({ kind: 'other' });
  }, [client, ref?.projectPath, ref?.workId, ref?.sessionId]);

  const goneHere = useMemo(() => (state === null || ref === null ? [] : goneEntries(state).filter((g) => g.gone.sessionKey === sessionKey(ref))), [state, ref?.projectPath, ref?.workId, ref?.sessionId]);
  useGoneDismiss(client, goneHere);

  // A card that appears while the screen is open: a light selection tick (D1 §16); the first load is not "new".
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

  if (ref === null || state === null || state.snapshot === null) {
    return (
      <View style={[styles.page, { backgroundColor: c.bg }]}>
        <Stack.Screen options={{ title: 'Session' }} />
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.pad}>
          <View style={styles.banner}>
            <ConnectionBanner />
          </View>
          {ref === null ? <EmptyState icon="questionmark.circle" title="This session link is not valid" /> : <Skeleton />}
        </ScrollView>
      </View>
    );
  }
  if (found === null || view === null) {
    return (
      <View style={[styles.page, { backgroundColor: c.bg }]}>
        <Stack.Screen options={{ title: 'Session' }} />
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.pad}>
          <View style={styles.banner}>
            <ConnectionBanner />
          </View>
          <EmptyState icon="questionmark.circle" title="This session is no longer on your Mac" />
        </ScrollView>
      </View>
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
  const subtitle = [session.role, session.model, started === null ? null : `${started}`].filter((x) => x !== null && x !== '').join(' · ');
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

  const content = (parts: { body: React.ReactNode; actions: React.ReactNode } | null) => (
    <View style={styles.page}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.pad, { paddingBottom: parts === null ? insets.bottom + 24 : 24 }]}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => { runtime.retry(); load(ref); }} />}
      >
        <View style={styles.banner}>
          <ConnectionBanner />
        </View>
        <Text allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>
          {subtitle}
        </Text>
        {origin.length > 0 && (
          <View style={styles.origin}>
            <SymbolView name="arrow.turn.left.up" size={14} tintColor={c.label2} />
            <Text allowFontScaling numberOfLines={2} style={[typography.footnote, styles.flex, { color: c.label2 }]}>
              {origin.map((o) => o.label).join(' › ')}
            </Text>
          </View>
        )}
        <StatusCapsule capsule={capsule} />
        {goneHere.length > 0 && (
          <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, { color: c.label2, textAlign: 'center' }]}>
            Answered at your Mac
          </Text>
        )}
        {loading && entry === undefined && <Skeleton rows={1} />}
        {loadFailed && first === undefined && (
          <View style={{ gap: 8, alignItems: 'center', paddingVertical: 8 }}>
            <Text allowFontScaling style={[typography.headline, { color: c.label }]}>Couldn't load the session</Text>
            <Button title="Try again" onPress={() => load(ref)} />
          </View>
        )}
        {first !== undefined && (
          <>
            <SectionHeader>{first.kind === 'permission' ? 'Permission' : first.kind === 'question' ? 'Question' : 'Plan'}</SectionHeader>
            {parts?.body}
            {rest.length > 0 && (
              <Text allowFontScaling style={[typography.footnote, { color: c.label2, marginTop: 8 }]}>
                {rest.length} more request{rest.length === 1 ? '' : 's'} waiting — answer this one first
              </Text>
            )}
          </>
        )}
        {first === undefined && attention === 'needs-you' && !loading && !loadFailed && (
          need?.kind === 'limit' ? (
            <InfoCard icon="hourglass" title="Usage limit" detail={needReason(need)} text="Answer at your Mac" />
          ) : need?.kind === 'sign-in' ? (
            <InfoCard icon="person.badge.key" title="Signed out" detail={needReason(need)} text="Answer at your Mac" />
          ) : (
            <InfoCard icon="desktopcomputer" title="Answer at your Mac" detail={needReason(need)} text="This request can only be answered in the terminal on your Mac." />
          )
        )}
        {entry?.lastReply != null && entry.lastReply.text !== '' && (
          <>
            <SectionHeader>Last reply</SectionHeader>
            <Reply text={entry.lastReply.text} />
          </>
        )}
        {team.length > 0 && (
          <>
            <SectionHeader>{teamLine(counts)}</SectionHeader>
            <View style={[styles.box, { backgroundColor: c.surface, paddingHorizontal: 0 }]}>
              <TreeRows rows={team} env={env} />
            </View>
          </>
        )}
      </ScrollView>
      {parts !== null && (
        <View style={[styles.footer, { backgroundColor: c.bg, borderTopColor: c.separator, paddingBottom: insets.bottom + 12 }]}>{parts.actions}</View>
      )}
    </View>
  );

  return (
    <View style={[styles.page, { backgroundColor: c.bg }]}>
      <Stack.Screen options={{ title: session.label, headerLargeTitle: true, headerBackTitle: work.title }} />
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

export type { RemoteState };
export { attentionOf };

const styles = StyleSheet.create({
  page: { flex: 1 },
  flex: { flex: 1 },
  pad: { padding: 16, gap: 12 },
  // Full-bleed inside the padded scroll content; inside the scroll view so it sits below the native header.
  banner: { marginHorizontal: -16, marginTop: -16 },
  origin: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  box: { borderRadius: spacing.cardRadius, padding: 16 },
  footer: { padding: 16, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
