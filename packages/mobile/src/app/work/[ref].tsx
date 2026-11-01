import { useMemo } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { selectWorks } from '@parley/remote-client';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { useRemoteState } from '../../hooks/use-remote';
import { parseWorkParam, sessionParam, workParam } from '../../nav/refs';
import { runtime } from '../../runtime/instance';
import { NewButton } from '../../launch/NewButton';
import { typography, useColors } from '../../theme';
import { EmptyState, Skeleton } from '../../ui/parts';
import { attentionOf, SingleGroup, TeamCard, type TreeEnv } from '../../works/TeamTree';
import { buildTeams, type Team } from '../../works/teams';

export default function WorkScreen() {
  const c = useColors();
  const router = useRouter();
  const { ref: param } = useLocalSearchParams<{ ref: string }>();
  const ref = parseWorkParam(param);
  const state = useRemoteState();
  const view = useMemo(() => {
    if (state === null || ref === null) return null;
    for (const g of selectWorks(state, { showClosed: true })) {
      const v = g.works.find((w) => w.work.projectPath === ref.projectPath && w.work.id === ref.workId);
      if (v !== undefined) return v;
    }
    return null;
  }, [state, ref?.projectPath, ref?.workId]);

  const body = (() => {
    if (state === null || state.snapshot === null) return <Skeleton />;
    if (view === null || ref === null) return <EmptyState icon="square.stack.3d.up" title="This work is no longer on your Mac" />;
    const env: TreeEnv = {
      state,
      view,
      actions: {
        openSession: (id) => router.push(`/session/${sessionParam({ projectPath: ref.projectPath, workId: ref.workId, sessionId: id })}` as never),
        openDecision: (roomId, proposalId) => router.push({ pathname: '/decision', params: { ref: workParam(ref), room: roomId, proposal: proposalId } } as never),
      },
    };
    const teams = buildTeams(view.rows, {
      session: (s) => attentionOf(env, s) === 'needs-you',
      room: (r) => r.room.proposal !== null,
    });
    if (teams.length === 0) return <EmptyState icon="person.2" title="No sessions yet" />;
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
        {view.archivedRooms.length > 0 && (
          <Text allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>
            {view.archivedRooms.length} archived room{view.archivedRooms.length === 1 ? '' : 's'}
          </Text>
        )}
      </View>
    );
  })();

  return (
    <View style={[styles.page, { backgroundColor: c.bg }]}>
      <Stack.Screen options={{ title: view?.work.title ?? 'Work', headerLargeTitle: true, headerBackTitle: 'Works', headerRight: () => <NewButton work={ref} /> }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.list} refreshControl={<RefreshControl refreshing={false} onRefresh={() => runtime.retry()} />}>
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
  banner: { marginHorizontal: -16, marginTop: -16, marginBottom: 8 },
});
