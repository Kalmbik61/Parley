import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { selectWorks, workKeyOf, type WorkView } from '@parley/remote-client';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { useRemoteState } from '../../hooks/use-remote';
import { workParam } from '../../nav/refs';
import { runtime } from '../../runtime/instance';
import { spacing, typography, useColors } from '../../theme';
import { attentionColor, CountPill, Dot, EmptyState, Skeleton } from '../../ui/parts';
import { projectColor, worksSummary } from '../../works/summary';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function WorksScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const state = useRemoteState();
  const [refreshing, setRefreshing] = useState(false);
  const [showDone, setShowDone] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => (state === null ? [] : selectWorks(state)), [state]);
  const open = (v: WorkView): void => router.push(`/work/${workParam({ projectPath: v.work.projectPath, workId: v.work.id })}` as never);

  const row = (v: WorkView, last: boolean) => {
    const unread = state?.letterUnread[workKeyOf(v.work.projectPath, v.work.id)] ?? 0;
    return (
      <Pressable
        key={v.key}
        accessibilityRole="button"
        accessibilityLabel={`${v.work.title}. ${worksSummary(v)}${v.needsYou > 0 ? `. ${v.needsYou} waiting for you` : ''}`}
        onPress={() => open(v)}
        style={[styles.work, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.separator }]}
      >
        <Dot color={attentionColor(c, v.level)} ring={v.level === 'unseen'} />
        <View style={styles.flex}>
          <Text numberOfLines={1} allowFontScaling style={[typography.headline, { color: c.label }]}>
            {v.work.title}
          </Text>
          <Text numberOfLines={2} allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>
            {worksSummary(v)}
          </Text>
        </View>
        {unread > 0 && (
          <View style={styles.mail}>
            <SymbolView name="envelope" size={14} tintColor={c.label2} />
            <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
              {unread}
            </Text>
          </View>
        )}
        <CountPill n={v.needsYou} />
        <SymbolView name="chevron.right" size={12} tintColor={c.label3} />
      </Pressable>
    );
  };

  return (
    <View style={[styles.page, { backgroundColor: c.bg, paddingTop: insets.top }]}>
      <ConnectionBanner />
      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              runtime.retry();
              setTimeout(() => setRefreshing(false), 800);
            }}
          />
        }
      >
        <Text accessibilityRole="header" allowFontScaling style={[typography.largeTitle, { color: c.label, marginBottom: 12 }]}>
          Works
        </Text>
        {state === null || state.snapshot === null ? (
          <Skeleton />
        ) : groups.length === 0 ? (
          <EmptyState icon="square.stack.3d.up" title="No works yet" text="Create a work on your Mac." />
        ) : (
          groups.map((g) => {
            const active = g.works.filter((w) => w.work.status !== 'done');
            const done = g.works.filter((w) => w.work.status === 'done');
            return (
              <View key={g.projectPath} style={{ marginBottom: 16 }}>
                <View accessibilityRole="header" style={styles.project}>
                  <View style={[styles.projectDot, { backgroundColor: projectColor(g.projectPath) }]} />
                  <Text allowFontScaling style={[typography.footnote, { color: c.label2 }]}>
                    {g.name} · {g.works.length}
                  </Text>
                </View>
                <View style={[styles.card, { backgroundColor: c.surface }]}>
                  {active.map((w, i) => row(w, i === active.length - 1 && done.length === 0))}
                  {done.length > 0 && (
                    <>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ expanded: showDone[g.projectPath] === true }}
                        onPress={() => setShowDone((s) => ({ ...s, [g.projectPath]: s[g.projectPath] !== true }))}
                        style={styles.work}
                      >
                        <Text allowFontScaling style={[typography.body, styles.flex, { color: c.label2 }]}>
                          Done ({done.length})
                        </Text>
                        <SymbolView name={showDone[g.projectPath] === true ? 'chevron.down' : 'chevron.right'} size={12} tintColor={c.label3} />
                      </Pressable>
                      {showDone[g.projectPath] === true && done.map((w, i) => row(w, i === done.length - 1))}
                    </>
                  )}
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  flex: { flex: 1 },
  list: { padding: 16, paddingBottom: 32 },
  project: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6, marginLeft: 4 },
  projectDot: { width: 10, height: 10, borderRadius: 5 },
  card: { borderRadius: spacing.cardRadius, overflow: 'hidden' },
  work: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 56 },
  mail: { flexDirection: 'row', alignItems: 'center', gap: 2 },
});
