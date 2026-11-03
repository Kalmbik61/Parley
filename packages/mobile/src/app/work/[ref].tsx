import { useEffect, useMemo } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { selectWork } from '@parley/remote-client';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { useRemoteState } from '../../hooks/use-remote';
import { parseWorkParam, sessionParam, workParam } from '../../nav/refs';
import { runtime } from '../../runtime/instance';
import { NewButton } from '../../launch/NewButton';
import { barBack, barRight, LargeTitle, useBarTitleOnScroll } from '../../ui/bar';
import { useColors } from '../../theme';
import { EmptyState, Skeleton } from '../../ui/parts';
import { attentionOf, SingleGroup, TeamCard, type TreeEnv } from '../../works/TeamTree';
import { ClosedLinks } from '../../works/ClosedLinks';
import { DEMO } from '../../dev/flags';
import { closedStore, useExpansion } from '../../works/closed-store';
import { buildTeams, type Team } from '../../works/teams';

export default function WorkScreen() {
  const c = useColors();
  const router = useRouter();
  const { ref: param, preview } = useLocalSearchParams<{ ref: string; preview?: string }>();
  const ref = parseWorkParam(param);
  const state = useRemoteState();
  const { key: storeKey, expansion } = useExpansion(ref);
  // Developer build, screenshots: `preview=closed-open` / `archived-open` expands the links by itself.
  useEffect(() => {
    if (!DEMO || storeKey === '') return;
    if (preview === 'closed-open' && !expansion.closed) closedStore.toggle(storeKey, 'closed');
    if (preview === 'archived-open' && !expansion.archived) closedStore.toggle(storeKey, 'archived');
  }, [preview, storeKey]);
  // An archived work still opens; `showClosed` only decides the rows (A43).
  const view = useMemo(() => (state === null || ref === null ? null : selectWork(state, ref, { showClosed: expansion.closed })), [state, ref?.projectPath, ref?.workId, expansion.closed]);

  const body = (() => {
    if (state === null || state.snapshot === null) return <Skeleton />;
    if (view === null || ref === null) return <EmptyState icon="square.stack.3d.up" title="This work is no longer on your Mac" />;
    const env: TreeEnv = {
      state,
      view,
      actions: {
        openSession: (id) => router.push(`/session/${sessionParam({ projectPath: ref.projectPath, workId: ref.workId, sessionId: id })}` as never),
        openDecision: (roomId, proposalId) => router.push({ pathname: '/decision', params: { ref: workParam(ref), room: roomId, proposal: proposalId } } as never),
        openRoom: (roomId) => router.push({ pathname: '/room', params: { ref: workParam(ref), room: roomId } } as never),
      },
    };
    const teams = buildTeams(view.rows, {
      session: (s) => attentionOf(env, s) === 'needs-you',
      room: (r) => r.room.proposal !== null,
    });
    const links = <ClosedLinks view={view} storeKey={storeKey} expansion={expansion} onOpenRoom={env.actions.openRoom} />;
    if (teams.length === 0) return view.closedCount > 0 || view.archivedRooms.length > 0 ? links : <EmptyState icon="person.2" title="No sessions yet" />;
    // Single sessions that follow each other share one card.
    const out: Array<{ key: string; singles?: Team[]; team?: Team }> = [];
    for (const t of teams) {
      const last = out[out.length - 1];
      if (t.single && last?.singles !== undefined) last.singles.push(t);
      else if (t.single) out.push({ key: t.id, singles: [t] });
      else out.push({ key: t.id, team: t });
    }
    return (
      <View style={{ gap: 12 }}>
        {out.map((o) => (o.team !== undefined ? <TeamCard key={o.key} team={o.team} env={env} /> : <SingleGroup key={o.key} teams={o.singles!} env={env} />))}
        {links}
      </View>
    );
  })();

  const scroll = useBarTitleOnScroll(view?.work.title ?? 'Work');
  return (
    <View style={[styles.page, { backgroundColor: c.bg }]}>
      <Stack.Screen options={{ title: view?.work.title ?? 'Work', headerTitle: scroll.headerTitle, headerLargeTitle: false, ...barBack('Works'), ...barRight(<NewButton work={ref} />) }} />
      <ScrollView onScroll={scroll.onScroll} scrollEventThrottle={scroll.scrollEventThrottle} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.list} refreshControl={<RefreshControl refreshing={false} onRefresh={() => runtime.retry()} />}>
        <LargeTitle padded={false}>{view?.work.title ?? 'Work'}</LargeTitle>
        <View style={styles.banner}>
          <ConnectionBanner />
        </View>
        {body}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  list: { padding: 16, paddingBottom: 32 },
  // Full-bleed inside the padded scroll content; inside the scroll view so it sits below the native header.
  banner: { marginHorizontal: -16, marginBottom: 8 },
});
