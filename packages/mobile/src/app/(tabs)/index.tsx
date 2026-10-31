import { useEffect, useMemo } from 'react';
import { ActionSheetIOS, FlatList, LayoutAnimation, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { SymbolView } from 'expo-symbols';
import { useRouter } from 'expo-router';
import { selectInbox, type InboxItem } from '@parley/remote-client';
import { goneEntries, useGoneDismiss, type GoneEntry } from '../../cards/gone';
import { InboxRow, GoneRow } from '../../cards/InboxRow';
import { fullCommand } from '../../cards/model';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { haptic } from '../../haptics';
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

type Row = { t: 'item'; item: InboxItem } | { t: 'gone'; entry: GoneEntry };

export default function InboxScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = useClient();
  useDemoData();
  const state = useRemoteState();
  const { host, hosts, hostNames, supervisor } = useRuntimeState();
  const canAct = useCanAct();
  const now = useNow(30_000);
  const [refreshing, setRefreshing] = useState(false);
  const items = useMemo(() => (state === null ? [] : selectInbox(state).slice(0, MAX_ROWS)), [state]);
  const gone = useMemo(() => (state === null ? [] : goneEntries(state)), [state]);
  useGoneDismiss(client, gone);
  const rows = useMemo<Row[]>(() => [...gone.map((entry): Row => ({ t: 'gone', entry })), ...items.map((item): Row => ({ t: 'item', item }))], [gone, items]);
  const unreadLetters = useMemo(() => Object.values(state?.letterUnread ?? {}).reduce((a, b) => a + b, 0), [state]);

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
  }, [rows.length]);

  const open = (item: InboxItem): void => {
    if (item.kind === 'card' || item.kind === 'need') router.push(`/session/${sessionParam(item.ref)}` as never);
    else if (item.kind === 'decision')
      router.push({ pathname: '/decision', params: { ref: workParam(item), room: item.roomId, proposal: item.proposalId } } as never);
    else router.push({ pathname: '/letter', params: { ref: workParam(item), id: item.message.id } } as never);
  };

  const menu = (item: InboxItem): void => {
    const workItem = item.kind === 'card' || item.kind === 'need' ? { projectPath: item.ref.projectPath, workId: item.ref.workId } : item;
    const command = item.kind === 'card' ? fullCommand(item.card) : null;
    const entries: Array<{ title: string; run(): void }> = [];
    if (item.kind === 'card' || item.kind === 'need') entries.push({ title: 'Open session', run: () => open(item) });
    entries.push({ title: 'Open work', run: () => router.push(`/work/${workParam(workItem)}` as never) });
    if (command !== null) entries.push({ title: 'Copy command', run: () => void Clipboard.setStringAsync(command) });
    ActionSheetIOS.showActionSheetWithOptions({ options: [...entries.map((e) => e.title), 'Cancel'], cancelButtonIndex: entries.length }, (i) => entries[i]?.run());
  };
  const switchHost = (): void => {
    const names = hosts.map((h) => hostNames[h.hostId] ?? h.hostName);
    ActionSheetIOS.showActionSheetWithOptions({ options: [...names, 'Cancel'], cancelButtonIndex: names.length, title: 'Mac' }, (i) => {
      const h = hosts[i];
      if (h !== undefined && h.hostId !== host?.hostId) {
        haptic.selection();
        void runtime.selectHost(h.hostId);
      }
    });
  };

  const cold = state === null || (state.snapshot === null && supervisor?.state !== 'ready' && supervisor?.state !== undefined);
  return (
    <View style={[styles.page, { backgroundColor: c.bg, paddingTop: insets.top }]}>
      <ConnectionBanner />
      <FlatList
        data={rows}
        keyExtractor={(r) => (r.t === 'gone' ? `gone:${r.entry.key}` : r.item.key)}
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
          <View style={{ marginBottom: 12 }}>
            <View style={styles.topRow}>
              {hosts.length >= 2 ? (
                <Pressable accessibilityRole="button" accessibilityLabel="Switch Mac" onPress={switchHost} style={styles.hostBtn}>
                  <Text allowFontScaling numberOfLines={1} style={[typography.subheadline, { color: c.tint, flexShrink: 1 }]}>
                    {hostNames[host?.hostId ?? ''] ?? host?.hostName ?? 'Mac'}
                  </Text>
                  <SymbolView name="chevron.down" size={11} tintColor={c.tint} />
                </Pressable>
              ) : (
                <View />
              )}
              <Pressable accessibilityRole="button" accessibilityLabel={unreadLetters > 0 ? `Letters, ${unreadLetters} unread` : 'Letters'} onPress={() => router.push('/letters' as never)} style={styles.hostBtn}>
                <SymbolView name="envelope" size={20} tintColor={c.tint} />
                {unreadLetters > 0 && (
                  <Text allowFontScaling style={[typography.subheadline, { color: c.tint }]}>
                    {unreadLetters}
                  </Text>
                )}
              </Pressable>
            </View>
            <Text accessibilityRole="header" allowFontScaling style={[typography.largeTitle, { color: c.label }]}>
              Inbox
            </Text>
          </View>
        }
        ListEmptyComponent={
          cold ? (
            <Skeleton />
          ) : (
            <EmptyState icon="checkmark.circle" title="All clear" text={`Nothing needs you on ${host?.hostName ?? 'your Mac'}.`} />
          )
        }
        renderItem={({ item: r }) =>
          r.t === 'gone' ? (
            <GoneRow sessionLabel={r.entry.sessionLabel} workTitle={r.entry.workTitle} />
          ) : (
            <InboxRow item={r.item} now={now} canAct={canAct} onOpen={() => open(r.item)} onMenu={() => menu(r.item)} />
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  list: { padding: 16, paddingBottom: 32 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44 },
  hostBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, minWidth: 44, justifyContent: 'center' },
});
