import { useEffect, useMemo } from 'react';
import { FlatList, LayoutAnimation, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { selectInbox, type InboxItem } from '@parley/remote-client';
import { InboxRow } from '../../cards/InboxRow';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { useDemoData } from '../../hooks/use-demo';
import { useCanAct, useClient, useNow, useRemoteState } from '../../hooks/use-remote';
import { sessionParam, workParam } from '../../nav/refs';
import { runtime } from '../../runtime/instance';
import { useRuntimeState } from '../../runtime/use-runtime';
import { typography, useColors } from '../../theme';
import { EmptyState, Skeleton } from '../../ui/parts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useState } from 'react';

const MAX_ROWS = 100;

export default function InboxScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = useClient();
  useDemoData();
  const state = useRemoteState();
  const { host, supervisor } = useRuntimeState();
  const canAct = useCanAct();
  const now = useNow(30_000);
  const [refreshing, setRefreshing] = useState(false);
  const items = useMemo(() => (state === null ? [] : selectInbox(state).slice(0, MAX_ROWS)), [state]);

  // Tell the refresher which sessions' cards are on screen (D1 §10.3: visible rows poll every 10 s).
  const visible = useMemo(() => items.flatMap((i) => (i.kind === 'card' || i.kind === 'need' ? [i.ref] : [])), [items]);
  const visibleKey = visible.map(sessionParam).join(',');
  useEffect(() => {
    client?.refresher.setScreen({ kind: 'inbox', visible });
    return () => client?.refresher.setScreen({ kind: 'other' });
  }, [client, visibleKey]);

  // Rows leave with a short height/fade animation.
  useEffect(() => {
    LayoutAnimation.configureNext(LayoutAnimation.create(250, 'easeInEaseOut', 'opacity'));
  }, [items.length]);

  const open = (item: InboxItem): void => {
    if (item.kind === 'card' || item.kind === 'need') router.push(`/session/${sessionParam(item.ref)}` as never);
    else if (item.kind === 'decision')
      router.push({ pathname: '/decision', params: { ref: workParam(item), room: item.roomId, proposal: item.proposalId } } as never);
    else router.push({ pathname: '/letter', params: { ref: workParam(item), id: item.message.id } } as never);
  };

  const cold = state === null || (state.snapshot === null && supervisor?.state !== 'ready' && supervisor?.state !== undefined);
  return (
    <View style={[styles.page, { backgroundColor: c.bg, paddingTop: insets.top }]}>
      <ConnectionBanner />
      <FlatList
        data={items}
        keyExtractor={(i) => i.key}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              runtime.retry();
              void Promise.all(visible.map((r) => client?.readCards(r))).finally(() => setRefreshing(false));
            }}
          />
        }
        ListHeaderComponent={
          <Text accessibilityRole="header" allowFontScaling style={[typography.largeTitle, { color: c.label, marginBottom: 12 }]}>
            Inbox
          </Text>
        }
        ListEmptyComponent={
          cold ? (
            <Skeleton />
          ) : (
            <EmptyState icon="checkmark.circle" title="All clear" text={`Nothing needs you on ${host?.hostName ?? 'your Mac'}.`} />
          )
        }
        renderItem={({ item }) => <InboxRow item={item} now={now} canAct={canAct} onOpen={() => open(item)} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  list: { padding: 16, paddingBottom: 32 },
});
