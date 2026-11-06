import { useEffect, useMemo } from 'react';
import { ActionSheetIOS, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { SymbolView } from 'expo-symbols';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { selectInbox, type InboxItem, type RemoteState } from '@parley/remote-client';
import { goneEntries, useGoneDismiss, type GoneEntry } from '../../cards/gone';
import { ConsentCardView } from '../../cards/ConsentViews';
import { useConsents } from '../../cards/use-consents';
import { InboxRow, GoneRow } from '../../cards/InboxRow';
import { fullCommand } from '../../cards/model';
import { Segmented } from '../../launch/form-parts';
import { LettersList } from '../../letters/LettersList';
import { lettersSegmentLabel, parseInboxSegment, withoutLetters, type InboxSegment } from '../../letters/letters-model';
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
import type { ConsentRow } from '../../cards/use-consents';

const MAX_ROWS = 100;

/** The label and provider of the session a provider-switch card is about, from the projection. */
function switchContext(state: RemoteState | null, row: ConsentRow): { switchLabel?: string; fromLabel?: string } {
  const card = row.card;
  if (card.kind !== 'agent-switch' || state === null) return {};
  const session = state.snapshot?.works.find((w) => w.projectPath === card.ref.projectPath && w.id === card.ref.workId)?.sessions.find((x) => x.id === card.ref.sessionId);
  if (session === undefined) return {};
  return { switchLabel: session.label, fromLabel: [session.provider, session.model].filter((x) => x !== null && x !== '').join(' · ') };
}

type Row = { t: 'item'; item: InboxItem } | { t: 'gone'; entry: GoneEntry } | { t: 'consent'; row: ConsentRow };

export default function InboxScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ segment?: string }>();
  const [segment, setSegment] = useState<InboxSegment>(parseInboxSegment(params.segment));
  // A push / deep link can ask for the Letters segment while the screen is already mounted.
  useEffect(() => {
    if (params.segment !== undefined) setSegment(parseInboxSegment(params.segment));
  }, [params.segment]);
  const client = useClient();
  useDemoData();
  const state = useRemoteState();
  const { host, hosts, hostNames, supervisor } = useRuntimeState();
  const canAct = useCanAct();
  const now = useNow(30_000);
  const [refreshing, setRefreshing] = useState(false);
  const items = useMemo(() => (state === null ? [] : withoutLetters(selectInbox(state)).slice(0, MAX_ROWS)), [state]);
  const gone = useMemo(() => (state === null ? [] : goneEntries(state)), [state]);
  useGoneDismiss(client, gone);
  const consents = useConsents();
  const rows = useMemo<Row[]>(
    () => [
      ...consents.rows.map((row): Row => ({ t: 'consent', row })),
      ...gone.map((entry): Row => ({ t: 'gone', entry })),
      ...items.map((item): Row => ({ t: 'item', item })),
    ],
    [consents.rows, gone, items],
  );
  const unreadLetters = useMemo(() => Object.values(state?.letterUnread ?? {}).reduce((a, b) => a + b, 0), [state]);

  // Tell the refresher which sessions' cards are on screen (D1 §10.3: visible rows poll every 10 s).
  const visible = useMemo(() => items.flatMap((i) => (i.kind === 'card' || i.kind === 'need' ? [i.ref] : [])), [items]);
  const visibleKey = visible.map(sessionParam).join(',');
  useEffect(() => {
    client?.refresher.setScreen({ kind: 'inbox', visible });
    return () => client?.refresher.setScreen({ kind: 'other' });
  }, [client, visibleKey]);

  const open = (item: InboxItem): void => {
    if (item.kind === 'card' || item.kind === 'need') router.push(`/session/${sessionParam(item.ref)}` as never);
    else if (item.kind === 'decision') router.push({ pathname: '/decision', params: { ref: workParam(item), room: item.roomId, proposal: item.proposalId } } as never);
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
  const header = (
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
      </View>
      <Text accessibilityRole="header" allowFontScaling style={[typography.largeTitle, { color: c.label }]}>
        Inbox
      </Text>
      <View style={{ marginTop: 8 }}>
        <Segmented<InboxSegment>
          label="Inbox section"
          value={segment}
          onChange={setSegment}
          options={[
            { value: 'needs-you', label: 'Needs you' },
            { value: 'letters', label: lettersSegmentLabel(unreadLetters) },
          ]}
        />
      </View>
    </View>
  );
  return (
    <View style={[styles.page, { backgroundColor: c.bg, paddingTop: insets.top }]}>
      <ConnectionBanner />
      {segment === 'letters' ? (
        <LettersList header={header} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => (r.t === 'gone' ? `gone:${r.entry.key}` : r.t === 'consent' ? `consent:${r.row.card.id}` : r.item.key)}
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
          ListHeaderComponent={header}
          ListEmptyComponent={cold ? <Skeleton /> : <EmptyState icon="checkmark.circle" title="All clear" text={`Nothing needs you on ${host?.hostName ?? 'your Mac'}.`} />}
          renderItem={({ item: r }) =>
            r.t === 'gone' ? (
              <GoneRow sessionLabel={r.entry.sessionLabel} workTitle={r.entry.workTitle} />
            ) : r.t === 'consent' ? (
              <ConsentCardView
                row={r.row}
                now={now}
                canAct={canAct}
                onDecide={consents.decide}
                {...switchContext(state, r.row)}
                onOpenSession={() => r.row.card.kind === 'agent-switch' && router.push(`/session/${sessionParam(r.row.card.ref)}` as never)}
              />
            ) : (
              <InboxRow item={r.item} now={now} canAct={canAct} onOpen={() => open(r.item)} onMenu={() => menu(r.item)} />
            )
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  list: { padding: 16, paddingBottom: 32 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44 },
  hostBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, minWidth: 44, justifyContent: 'center' },
});
