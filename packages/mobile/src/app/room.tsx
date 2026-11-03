// Room = the chat of a room (D1 §9.7, plan A33): history by `context.messages`, live by `rooms.mail`, members and lead,
// a field with @mentions that sends `rooms.send`. Reached from the room container (Work), the session menu, the origin
// line and Decision. Params: `ref` (work) and `room`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Message } from '@parley/core';
import { attentionOfSession, roomKey, type RoomRef } from '@parley/remote-client';
import { confirmByOwner } from '../auth/lock-instance';
import { useCloseOnLock } from '../auth/use-lock-sheet';
import { DEMO, DEV_FOCUS } from '../dev/flags';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { Toast, useToast } from '../components/Toast';
import { useCanAct, useClient, useRemoteState } from '../hooks/use-remote';
import { parseWorkParam, sessionParam, workParam } from '../nav/refs';
import { COMPOSER_PLACEHOLDER, filterMentionable, insertMention, lines, mentionQuery, type Line, recipientsOf, roomComposer, roomHeader, deliveryLine, letterProblem, type Mentionable } from '../room/model';
import { visibleOutLetters, type OutLetter } from '../room/out-letters';
import { LetterView, MentionMenu, OutLetterView, ReplyPlate, ToLine, type Who } from '../room/RoomViews';
import { ResultSheet } from '../room/ResultSheet';
import { archiveSheet, deleteConfirm, FACE_ID_PROMPT, membersWhere, NO_FACE_ID_TOAST, roomMenu, roomToast, runAll, runSummary, sleepConfirm, type RoomMenuFacts, type RunResult } from '../room/room-menu';
import { useRoomChat } from '../room/use-room-chat';
import { haptic } from '../haptics';
import { typography, useColors } from '../theme';
import { barBack, BarStrip, BarStripStack, BarSymbol, barRight, useBarMaterial } from '../ui/bar';
import { Button } from '../ui/Button';
import { EmptyState, Skeleton } from '../ui/parts';

type RoomRow = { t: 'line'; l: Line } | { t: 'out'; o: OutLetter };
const NEAR_BOTTOM = 80;
const str = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default function RoomScreen() {
  const c = useColors();
  const material = useBarMaterial();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ ref?: string; room?: string; preview?: string }>();
  const work = parseWorkParam(str(params.ref));
  const roomId = str(params.room);
  const target: RoomRef | null = work !== null && roomId !== undefined && roomId !== '' ? { ...work, roomId } : null;
  const client = useClient();
  const state = useRemoteState();
  const canAct = useCanAct();
  const toast = useToast();
  const list = useRef<FlatList<RoomRow>>(null);
  const atBottom = useRef(true);
  const seen = useRef(0);
  const [away, setAway] = useState(0);
  const chat = useRoomChat(target, toast.show);
  const [result, setResult] = useState<{ title: string; results: RunResult[] } | null>(null);
  useCloseOnLock(result !== null, () => setResult(null));
  const busyMenu = useRef(false);
  const previewActs = useRef<{ menu(): void; archive(): void; remove(): void; result(): void } | null>(null);

  useEffect(() => {
    if (client === null || target === null || DEMO) return;
    return client.openRoom(target);
  }, [client, target?.projectPath, target?.workId, target?.roomId]);

  const found = useMemo(() => {
    if (state === null || target === null) return null;
    const w = state.snapshot?.works.find((x) => x.projectPath === target.projectPath && x.id === target.workId);
    const room = w?.rooms.find((r) => r.id === target.roomId);
    return w !== undefined && room !== undefined ? { work: w, room } : null;
  }, [state, target?.projectPath, target?.workId, target?.roomId]);

  const members = useMemo(() => (found === null ? [] : found.room.members.flatMap((id) => found.work.sessions.filter((s) => s.id === id))), [found]);
  const labelOf = useCallback((id: string): string => found?.work.sessions.find((s) => s.id === id)?.label ?? id, [found]);
  const who: Who = useMemo(() => ({ label: labelOf }), [labelOf]);
  const mentionables = useMemo<Mentionable[]>(
    () =>
      members.map((s) => {
        const a = found === null || target === null ? 'idle' : attentionOfSession(state!, { projectPath: target.projectPath, workId: target.workId, sessionId: s.id }, s);
        return { id: s.id, label: s.label, meta: `${s.model ?? s.provider} · ${a === 'needs-you' ? 'needs you' : a === 'working' ? 'working' : 'idle'}` };
      }),
    [members, state, found, target],
  );
  const attention = (id: string) => (target === null || state === null ? 'idle' : attentionOfSession(state, { projectPath: target.projectPath, workId: target.workId, sessionId: id }, members.find((s) => s.id === id)!));

  const entry = state !== null && target !== null ? state.roomChats[roomKey(target)] : undefined;
  const messages = entry?.messages ?? [];
  const rows = useMemo(() => lines(messages), [messages]);
  const out = useMemo(() => visibleOutLetters(chat.out, messages), [chat.out, messages]);
  const data = useMemo<RoomRow[]>(() => [...rows.map((l): RoomRow => ({ t: 'line', l })), ...out.map((o): RoomRow => ({ t: 'out', o }))], [rows, out]);
  const total = data.length;
  const lastHuman = useMemo(() => [...messages].reverse().find((m) => m.from === 'human')?.id ?? null, [messages]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const labels = useMemo(() => mentionables.map((m) => m.label), [mentionables]);

  const onContentSizeChange = (): void => {
    if (atBottom.current) {
      list.current?.scrollToEnd({ animated: seen.current !== 0 });
      setTimeout(() => atBottom.current && list.current?.scrollToEnd({ animated: false }), 120);
      seen.current = total;
    } else setAway(Math.max(0, total - seen.current));
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    atBottom.current = contentSize.height - layoutMeasurement.height - contentOffset.y < NEAR_BOTTOM;
    if (atBottom.current && away !== 0) {
      seen.current = total;
      setAway(0);
    }
    // Scrolled to the start: the next older page.
    if (contentOffset.y < 40 && target !== null) client?.loadOlder(target);
  };

  const onLongPress = (m: Message): void => {
    ActionSheetIOS.showActionSheetWithOptions({ options: ['Reply', 'Copy', 'Cancel'], cancelButtonIndex: 2 }, (i) => {
      if (i === 0) chat.setReply(m);
      else if (i === 1) void Clipboard.setStringAsync(m.text);
    });
  };
  // Demo data has no hello: every menu method counts as present (screenshots).
  const menuMethods = DEMO ? ['sessions.stop', 'sessions.resume', 'rooms.archive', 'rooms.delete'] : (state?.methods ?? null);
  const menuFacts = (): RoomMenuFacts | null =>
    found === null
      ? null
      : {
          methods: menuMethods,
          room: { id: found.room.id, title: found.room.title, mode: found.room.mode, hasProposal: found.room.proposal !== null, members: found.room.members },
          sessions: found.work.sessions,
          otherRooms: found.work.rooms,
        };
  const runSession = async (kind: 'sleep' | 'wake'): Promise<void> => {
    const f = menuFacts();
    if (f === null || target === null || client === null || busyMenu.current) return;
    const who = membersWhere(f, kind === 'sleep' ? 'active' : 'sleeping');
    busyMenu.current = true;
    try {
      const results = await runAll(who, (id) => {
        const r = { projectPath: target.projectPath, workId: target.workId, sessionId: id };
        return kind === 'sleep' ? client.sessionCommand('sessions.stop', r) : client.resumeSession(r);
      });
      const sum = runSummary(kind, results);
      if (sum.allOk) {
        haptic.success();
        toast.show(sum.title);
      } else {
        haptic.error();
        setResult({ title: sum.title, results });
      }
    } finally {
      busyMenu.current = false;
    }
  };
  // Face ID first, then the call. Cancelled: nothing is sent and nothing is said.
  const ownerThen = async (kind: 'archive' | 'delete', send: () => Promise<Parameters<typeof roomToast>[1]>): Promise<void> => {
    const owner = await confirmByOwner(FACE_ID_PROMPT[kind]);
    if (owner === 'cancelled') return;
    if (owner === 'unavailable') {
      toast.show(NO_FACE_ID_TOAST);
      return;
    }
    const outcome = await send();
    if (outcome.outcome === 'ok') {
      haptic.success();
      if (kind === 'delete') router.back();
      else toast.show(roomToast(kind, outcome));
    } else {
      haptic.error();
      toast.show(roomToast(kind, outcome));
    }
  };
  const archive = (): void => {
    const f = menuFacts();
    if (f === null || target === null || client === null) return;
    const sheet = archiveSheet(f);
    ActionSheetIOS.showActionSheetWithOptions(
      { title: sheet.title, message: sheet.message, options: [...sheet.options.map((o) => o.title), 'Cancel'], cancelButtonIndex: sheet.options.length },
      (i) => {
        const o = sheet.options[i];
        if (o !== undefined) void ownerThen('archive', () => client.archiveRoom(target, o.stopSessions));
      },
    );
  };
  const remove = (): void => {
    const f = menuFacts();
    if (f === null || target === null || client === null) return;
    const q = deleteConfirm(f);
    Alert.alert(q.title, q.message, [
      { text: 'Cancel', style: 'cancel' },
      { text: q.button, style: 'destructive', onPress: () => void ownerThen('delete', () => client.deleteRoom(target)) },
    ]);
  };
  const openMenu = (): void => {
    const f = menuFacts();
    if (f === null) return;
    const m = roomMenu(f);
    const run: Record<string, () => void> = {
      sleepAll: () => {
        const q = sleepConfirm(membersWhere(f, 'active').length);
        Alert.alert(q.title, q.message, [{ text: 'Cancel', style: 'cancel' }, { text: q.button, onPress: () => void runSession('sleep') }]);
      },
      wakeAll: () => void runSession('wake'),
      copy: () => {
        void Clipboard.setStringAsync(f.room.id);
        toast.show('Copied');
      },
      archive,
      delete: remove,
    };
    const disabled = m.items.flatMap((it, i) => (it.disabled === true ? [i] : []));
    const destructive = m.items.findIndex((it) => it.destructive === true);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [...m.items.map((it) => it.title), 'Cancel'],
        cancelButtonIndex: m.items.length,
        ...(m.title === undefined ? {} : { title: m.title }),
        ...(disabled.length > 0 ? { disabledButtonIndices: disabled } : {}),
        ...(destructive >= 0 ? { destructiveButtonIndex: destructive } : {}),
      },
      (i) => {
        const it = m.items[i];
        if (it !== undefined) run[it.id]?.();
      },
    );
  };
  previewActs.current = {
    menu: openMenu,
    archive,
    remove,
    result: () =>
      setResult({
        title: 'Put to sleep: 2 of 4',
        results: [
          { id: 'a', label: 'Research drone 1', status: 'ok', text: null },
          { id: 'b', label: 'Research queen', status: 'ok', text: null },
          { id: 'c', label: 'Changelog-writer', status: 'refused', text: 'Too many changes from the phone — try again in a minute' },
          { id: 'd', label: 'Docs-editor', status: 'not-sent', text: 'Not sent — reconnecting' },
        ],
      }),
  };
  useEffect(() => {
    if (!DEMO || found === null || params.preview === undefined) return;
    const t = setTimeout(() => {
      const p = previewActs.current;
      if (params.preview === 'menu') p?.menu();
      else if (params.preview === 'archive') p?.archive();
      else if (params.preview === 'delete') p?.remove();
      else if (params.preview === 'result') p?.result();
    }, 700);
    return () => clearTimeout(t);
  }, [params.preview, found !== null]);

  if (target === null) return <Shell title="Room" body={<EmptyState icon="questionmark.circle" title="This room link is not valid" />} />;
  if (state === null || state.snapshot === null) return <Shell title="Room" body={<Skeleton />} />;
  if (found === null) return <Shell title="Room" body={<EmptyState icon="questionmark.circle" title="This room is no longer on your Mac" />} />;

  const { room } = found;
  const working = members.filter((s) => attention(s.id) === 'working').length;
  const waiting = members.filter((s) => attention(s.id) === 'needs-you');
  const header = roomHeader(room, members, waiting.length, working, room.lead === null ? null : labelOf(room.lead));
  const composer = roomComposer(room, DEMO || (state.methods?.includes('rooms.send') ?? false), canAct);
  const hidden = chat.switchedOff ? ({ kind: 'hidden', text: 'Messaging agents from the phone is turned off on your Mac' } as const) : composer;
  const q = mentionQuery(chat.draft);
  const menu = q === null || hidden.kind === 'hidden' ? null : filterMentionable(mentionables, q.query);
  const to = recipientsOf(chat.draft, chat.chips).map((x) => x.label);
  const problem = letterProblem(chat.draft);
  const canSend = hidden.kind === 'input' && hidden.sendEnabled && problem === null && !chat.busy;
  const memberIds = room.members;

  return (
    <View style={[styles.page, { backgroundColor: c.bg }]}>
      <Stack.Screen
        options={{
          headerLargeTitle: false,
          ...barBack(null),
          title: room.title,
          ...material,
          headerTitle: () => (
            <View accessible accessibilityRole="header" accessibilityLabel={`Room ${room.title}. ${header.subtitle}`} style={styles.titleBox}>
              <Text numberOfLines={1} allowFontScaling style={[typography.headline, { color: c.label }]}>
                <Text style={{ color: c.label2 }}>#</Text> {room.title}
              </Text>
              <View style={styles.statusLine}>
                <View style={[styles.dot, { backgroundColor: header.state === 'needs-you' || header.state === 'decision' ? c.needsYou : header.state === 'working' ? c.working : c.idle }]} />
                <Text numberOfLines={1} allowFontScaling style={[typography.caption1, { color: c.barSubtitle }]}>
                  {header.subtitle}
                </Text>
              </View>
            </View>
          ),
          ...barRight(<BarSymbol name="ellipsis.circle" label="More" onPress={openMenu} />),
        }}
      />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        {(room.proposal !== null || waiting[0] !== undefined) && (
          <BarStripStack onChange={() => atBottom.current && list.current?.scrollToEnd({ animated: false })}>
            {room.proposal !== null && (
              <BarStrip icon="checkmark.seal" iconColor={c.tint} text={`Decision ${room.proposal.id} · rev ${room.proposal.rev}`} action="Review" onPress={() => router.push({ pathname: '/decision', params: { ref: workParam(target), room: room.id, proposal: room.proposal!.id } } as never)} />
            )}
            {waiting[0] !== undefined && (
              <BarStrip icon="hand.raised" iconColor={c.needsYou} text={`${waiting[0].label} needs you`} onPress={() => router.push(`/session/${sessionParam({ ...target, sessionId: waiting[0]!.id })}` as never)} />
            )}
          </BarStripStack>
        )}
        <FlatList
          ref={list}
          data={data}
          keyExtractor={(r) => (r.t === 'line' ? r.l.message.id : r.o.id)}
          onContentSizeChange={onContentSizeChange}
          onScroll={onScroll}
          scrollEventThrottle={64}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListHeaderComponent={
            <View style={{ gap: 8, marginBottom: 8 }}>
              <ConnectionBanner />
              {entry?.older != null && (
                <View style={styles.older}>
                  {entry.more === 'error' ? (
                    <Button variant="plain" title="Couldn't load earlier messages · Try again" onPress={() => client?.loadOlder(target)} />
                  ) : (
                    <Button variant="plain" title={entry.more === 'loading' ? 'Loading…' : 'Load earlier messages'} disabled={entry.more === 'loading'} onPress={() => client?.loadOlder(target)} />
                  )}
                </View>
              )}
            </View>
          }
          ListEmptyComponent={
            entry === undefined || entry.status === 'loading' ? (
              <Skeleton rows={4} />
            ) : entry.status === 'error' ? (
              <View style={styles.center}>
                <Text allowFontScaling style={[typography.headline, { color: c.label, textAlign: 'center' }]}>Couldn't load the conversation</Text>
                <Button title="Try again" onPress={() => client?.reloadRoom(target)} />
              </View>
            ) : (
              <View style={styles.center}>
                <SymbolView name="bubble.left.and.bubble.right" size={28} tintColor={c.label3} />
                <Text allowFontScaling style={[typography.headline, { color: c.label }]}>No messages yet</Text>
                <Text allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>Write the task for everyone below.</Text>
              </View>
            )
          }
          renderItem={({ item }) =>
            item.t === 'out' ? (
              <OutLetterView letter={item.o} onRetry={(l) => void chat.retry(l)} />
            ) : (
              <LetterView
                message={item.l.message}
                header={item.l.header}
                who={who}
                labels={labels}
                quoted={item.l.message.replyTo === undefined ? null : (byId.get(item.l.message.replyTo) ?? null)}
                delivery={item.l.message.id === lastHuman ? deliveryLine(item.l.message, memberIds, labelOf) : null}
                onLongPress={onLongPress}
                onOpenQuote={(id) => {
                  const at = rows.findIndex((r) => r.message.id === id);
                  if (at >= 0) list.current?.scrollToIndex({ index: at, animated: true, viewPosition: 0.3 });
                }}
              />
            )
          }
          onScrollToIndexFailed={() => undefined}
        />
        {away > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Jump to latest, ${away} new`}
            onPress={() => {
              list.current?.scrollToEnd({ animated: true });
              atBottom.current = true;
              seen.current = total;
              setAway(0);
            }}
            style={[styles.jump, { backgroundColor: c.surface, borderColor: c.separator }]}
          >
            <SymbolView name="arrow.down" size={14} tintColor={c.tint} />
            <Text allowFontScaling style={[typography.footnote, { color: c.tint }]}>Jump to latest · {away}</Text>
          </Pressable>
        )}
        <View style={[styles.footer, { backgroundColor: c.bg, borderTopColor: c.separator, paddingBottom: insets.bottom + 8 }]}>
          {hidden.kind === 'hidden' ? (
            <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, { color: c.label2, textAlign: 'center', paddingVertical: 8 }]}>
              {hidden.text}
            </Text>
          ) : (
            <>
              {menu !== null && (
                <MentionMenu
                  agents={menu}
                  onPick={(a) => {
                    chat.addChip(a);
                    chat.setDraft(insertMention(chat.draft, a.label));
                  }}
                />
              )}
              {chat.reply !== null && <ReplyPlate message={chat.reply} who={who} onClear={() => chat.setReply(null)} />}
              <ToLine names={to} />
              <View style={styles.row}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Mention an agent"
                  onPress={() => chat.setDraft(`${chat.draft}${chat.draft === '' || /\s$/.test(chat.draft) ? '' : ' '}@`)}
                  style={styles.at}
                >
                  <SymbolView name="at" size={22} tintColor={c.tint} />
                </Pressable>
                <TextInput
                  autoFocus={DEV_FOCUS}
                  accessibilityLabel="Message the room"
                  multiline
                  editable={!chat.busy && hidden.sendEnabled}
                  value={chat.draft}
                  onChangeText={chat.setDraft}
                  placeholder={COMPOSER_PLACEHOLDER}
                  placeholderTextColor={c.label3}
                  style={[typography.body, styles.input, { backgroundColor: c.surface, color: c.label, opacity: chat.busy ? 0.6 : 1 }]}
                />
                <Pressable accessibilityRole="button" accessibilityLabel="Send" accessibilityState={{ disabled: !canSend, busy: chat.busy }} disabled={!canSend} onPress={() => void chat.send()} style={styles.send}>
                  <SymbolView name="arrow.up.circle.fill" size={32} tintColor={canSend ? c.tint : c.off} />
                </Pressable>
              </View>
              {hidden.note !== null && (
                <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>
                  {hidden.note}
                </Text>
              )}
              {problem !== null && chat.draft.trim() !== '' && (
                <Text allowFontScaling style={[typography.caption1, { color: c.danger }]}>
                  {problem}
                </Text>
              )}
            </>
          )}
        </View>
        <Toast message={toast.message} />
      </KeyboardAvoidingView>
      <Modal visible={result !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setResult(null)}>
        {result !== null && <ResultSheet title={result.title} results={result.results} onClose={() => setResult(null)} />}
      </Modal>
    </View>
  );
}

function Shell({ title, body }: { title: string; body: React.ReactNode }) {
  const c = useColors();
  return (
    <View style={[styles.page, { backgroundColor: c.bg, padding: 16, gap: 12 }]}>
      <Stack.Screen options={{ title }} />
      <ConnectionBanner />
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  flex: { flex: 1 },
  list: { padding: 16, paddingTop: 8, paddingBottom: 12 },
  titleBox: { alignItems: 'flex-start', maxWidth: 240 },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  bar: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  older: { alignItems: 'center' },
  center: { alignItems: 'center', gap: 8, paddingVertical: 24 },
  footer: { paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, gap: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  at: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, minHeight: 44, maxHeight: 130, borderRadius: 22, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11 },
  send: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  jump: { position: 'absolute', alignSelf: 'center', bottom: 140, flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8 },
});
