// Room = the chat of a room (D1 §9.7, plan A33): history by `context.messages`, live by `rooms.mail`, members and lead,
// a field with @mentions that sends `rooms.send`. Reached from the room container (Work), the session menu, the origin
// line and Decision. Params: `ref` (work) and `room`.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActionSheetIOS, Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { Stack, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Message } from '@parley/core';
import { capsuleOfSession } from '../cards/status';
import { attentionOfSession, roomKey, type RoomRef, type SessionCommandOutcome } from '@parley/remote-client';
import { confirmByOwner } from '../auth/lock-instance';
import { useCloseOnLock } from '../auth/use-lock-sheet';
import { useCovered } from '../auth/use-covered';
import { devMoreRoom } from '../dev/demo';
import { DEMO, DEV_FOCUS } from '../dev/flags';
import { devFocus, LONG_DRAFT, runDevScript } from '../dev/dev-script';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { Toast, useToast } from '../components/Toast';
import { useCanAct, useClient, useRemoteState } from '../hooks/use-remote';
import { parseWorkParam, sessionParam, workParam } from '../nav/refs';
import { COMPOSER_PLACEHOLDER, filterMentionable, insertMention, lines, mentionQuery, type Line, recipientsOf, roomComposer, roomHeader, deliveryLine, letterProblem, roomOutgoing, type Mentionable } from '../room/model';
import { visibleOutLetters, type OutLetter } from '../room/out-letters';
import { useFollowEnd } from '../feed/use-follow-end';
import { LetterView, MentionMenu, OutLetterView, ToLine, type Who } from '../room/RoomViews';
import { SelectTextSheet } from '../feed/SelectTextSheet';
import type { Selection } from '../feed/selection';
import { replyQuote, withQuote } from '../feed/reply';
import { ReplyPlate } from '../ui/ReplyPlate';
import { ResultSheet } from '../room/ResultSheet';
import { archiveSheet, deleteConfirm, FACE_ID_PROMPT, membersWhere, ownerGate, roomMenu, roomToast, sleepConfirm, startToast, type RoomMenuFacts } from '../room/room-menu';
import { roomRuns, runKeyOf } from '../room/room-runs';
import { useRuntimeState } from '../runtime/use-runtime';
import { useRoomChat } from '../room/use-room-chat';
import { haptic } from '../haptics';
import { RECONNECTING } from '../feed/session-menu';
import { typography, useColors } from '../theme';
import { barBack, BarStrip, BarStripStack, BarSymbol, barRight, useBarMaterial } from '../ui/bar';
import { Button } from '../ui/Button';
import { EmptyState, Skeleton } from '../ui/parts';

type RoomRow = { t: 'line'; l: Line } | { t: 'out'; o: OutLetter };
const str = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default function RoomScreen() {
  const c = useColors();
  const material = useBarMaterial();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const router = useRouter();
  const params = useLocalSearchParams<{ ref?: string; room?: string; preview?: string; dev?: string }>();
  const work = parseWorkParam(str(params.ref));
  const roomId = str(params.room);
  const target: RoomRef | null = work !== null && roomId !== undefined && roomId !== '' ? { ...work, roomId } : null;
  const client = useClient();
  const state = useRemoteState();
  const canAct = useCanAct();
  const toast = useToast();
  const list = useRef<FlatList<RoomRow>>(null);
  const roomInput = useRef<React.ComponentRef<typeof TextInput>>(null);
  useEffect(() => devFocus.listen(() => roomInput.current?.focus()), []);
  const chat = useRoomChat(target, toast.show);
  // The menu's action in flight and the unseen result live outside the screen (room-runs.ts): leaving does not stop a run.
  const hostId = useRuntimeState().host?.hostId ?? null;
  const runKey = target === null ? '' : runKeyOf(hostId, target);
  const run = useSyncExternalStore(roomRuns.subscribe, () => roomRuns.get(runKey), () => roomRuns.get(runKey));
  const covered = useCovered();
  const focused = useIsFocused();
  const [deleted, setDeleted] = useState(false);
  // Select Text (D1 §9.7, as 9.2); `initial` is a developer-preview selection.
  const [selectFor, setSelectFor] = useState<{ message: Message; initial?: Selection } | null>(null);
  useCloseOnLock(selectFor !== null, () => setSelectFor(null));
  // Back after a successful delete: only while this screen is in front, and only if there is somewhere to go (critic m1).
  useEffect(() => {
    if (deleted && focused && router.canGoBack()) router.back();
  }, [deleted, focused]);
  const previewActs = useRef<{ menu(): void; archive(): void; remove(): void; result(): void; busy(): void; plate(): void; select(): void; outgoing(): void } | null>(null);

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
        const word = found === null || target === null ? 'idle' : capsuleOfSession(state!, { projectPath: target.projectPath, workId: target.workId, sessionId: s.id }, s, Date.now()).label.toLowerCase();
        return { id: s.id, label: s.label, meta: `${s.model ?? s.provider} · ${word}` };
      }),
    [members, state, found, target],
  );
  const attention = (id: string) => (target === null || state === null ? 'idle' : attentionOfSession(state, { projectPath: target.projectPath, workId: target.workId, sessionId: id }, members.find((s) => s.id === id)!));

  const entry = state !== null && target !== null ? state.roomChats[roomKey(target)] : undefined;
  const messages = entry?.messages ?? [];
  const rows = useMemo(() => lines(messages), [messages]);
  const out = useMemo(() => visibleOutLetters(chat.out, messages), [chat.out, messages]);
  const data = useMemo<RoomRow[]>(() => [...rows.map((l): RoomRow => ({ t: 'line', l })), ...out.map((o): RoomRow => ({ t: 'out', o }))], [rows, out]);
  const rowKey = (r: RoomRow): string => (r.t === 'line' ? r.l.message.id : r.o.id);
  // "New" is whatever comes after the last item the person has seen, so earlier pages at the top are never counted.
  const keys = useMemo(() => data.map(rowKey), [data]);
  const follow = useFollowEnd(list, keys);
  // Developer evidence (A44): `?dev=focus,draft,up,more` — see dev/dev-script.ts.
  useEffect(() => {
    if (!DEMO || found === null || params.dev === undefined || client === null || target === null) return;
    return runDevScript(params.dev, {
      focus: devFocus.fire,
      draft: () => chat.setDraft(LONG_DRAFT),
      up: () => list.current?.scrollToOffset({ offset: 1500, animated: false }),
      more: () => devMoreRoom(client, target),
      card: () => undefined,
    });
  }, [found !== null]);
  const lastHuman = useMemo(() => [...messages].reverse().find((m) => m.from === 'human')?.id ?? null, [messages]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const labels = useMemo(() => mentionables.map((m) => m.label), [mentionables]);

  const onLongPress = (m: Message): void => {
    haptic.selection();
    ActionSheetIOS.showActionSheetWithOptions({ options: ['Reply', 'Copy', 'Select Text', 'Cancel'], cancelButtonIndex: 3 }, (i) => {
      if (i === 0) chat.setReply({ message: m, selected: '' });
      else if (i === 1) void Clipboard.setStringAsync(m.text);
      else if (i === 2) setSelectFor({ message: m });
    });
  };
  // Demo data has no hello: every menu method counts as present (screenshots).
  const menuMethods = DEMO ? ['sessions.stop', 'sessions.resume', 'rooms.archive', 'rooms.delete'] : (state?.methods ?? null);
  const menuFacts = (): RoomMenuFacts | null =>
    found === null
      ? null
      : {
          methods: menuMethods,
          room: { id: found.room.id, title: found.room.title, mode: found.room.mode, hasProposal: found.room.proposal !== null, members: found.room.members, archived: found.room.archived },
          sessions: found.work.sessions,
          otherRooms: found.work.rooms,
          online: canAct && !(DEMO && params.preview === 'offline'),
          pending: run.pending,
        };
  // The latest facts, read when a run starts: the snapshot may have changed while a confirm was on screen (critic m2).
  const factsRef = useRef<RoomMenuFacts | null>(null);
  factsRef.current = menuFacts();
  const runSession = async (kind: 'sleep' | 'wake', call?: (id: string) => Promise<SessionCommandOutcome>): Promise<void> => {
    const f = factsRef.current;
    if (f === null || target === null || (client === null && call === undefined)) return;
    const who = membersWhere(f, kind === 'sleep' ? 'active' : 'sleeping');
    if (who.length === 0) return;
    toast.show(startToast(kind, who.length));
    const sum = await roomRuns.run(runKey, kind, who, call ?? ((id) => {
      const r = { projectPath: target.projectPath, workId: target.workId, sessionId: id };
      return kind === 'sleep' ? client!.sessionCommand('sessions.stop', r) : client!.resumeSession(r);
    }));
    if (sum === null) return;
    if (sum.allOk) {
      haptic.success();
      toast.show(sum.title);
    } else haptic.error();
  };
  // Face ID first, then the call, in the room's single slot. Cancelled: nothing is sent and nothing is said.
  const ownerThen = async (kind: 'archive' | 'delete', send: () => Promise<SessionCommandOutcome>): Promise<void> => {
    // Offline now (the connection dropped while a sheet was up): no slot, no Face ID.
    if (factsRef.current?.online !== true) {
      toast.show(RECONNECTING);
      return;
    }
    const res = await roomRuns.hold(runKey, kind, () => ownerGate(async () => (factsRef.current?.online === true ? confirmByOwner(FACE_ID_PROMPT[kind]) : 'cancelled'), send));
    if (!res.started || res.value.kind === 'silent') return;
    if (res.value.kind === 'toast') {
      toast.show(res.value.text);
      return;
    }
    const outcome = res.value.outcome;
    if (outcome.outcome === 'ok') {
      haptic.success();
      if (kind === 'delete') setDeleted(true);
      else toast.show(roomToast(kind, outcome));
    } else {
      haptic.error();
      toast.show(roomToast(kind, outcome));
    }
  };
  const archive = (): void => {
    const f = factsRef.current;
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
    const f = factsRef.current;
    if (f === null || target === null || client === null) return;
    const q = deleteConfirm(f);
    Alert.alert(q.title, q.message, [
      { text: 'Cancel', style: 'cancel' },
      { text: q.button, style: 'destructive', onPress: () => void ownerThen('delete', () => client.deleteRoom(target)) },
    ]);
  };
  const openMenu = (): void => {
    const f = factsRef.current;
    if (f === null) return;
    const m = roomMenu(f);
    const acts: Record<string, () => void> = {
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
        if (it !== undefined) acts[it.id]?.();
      },
    );
  };
  // Developer preview: the result sheet comes out of the real runner with a fake call that answers what the bridge and host say.
  const previewCall = (id: string): Promise<SessionCommandOutcome> => {
    const nth = factsRef.current === null ? 0 : membersWhere(factsRef.current, 'active').findIndex((x) => x.id === id);
    if (nth === 2) return Promise.resolve({ outcome: 'rejected', code: 'rate_limited', message: 'too many changes per minute' });
    if (nth === 3) return Promise.resolve({ outcome: 'rejected', code: 'not_connected', message: 'not connected' });
    return Promise.resolve({ outcome: 'ok' });
  };
  previewActs.current = {
    menu: openMenu,
    archive,
    remove,
    result: () => void runSession('sleep', previewCall),
    plate: () => {
      const m = messages.find((x) => x.from !== 'human' && x.from !== 'system');
      if (m !== undefined) chat.setReply({ message: m, selected: '' });
    },
    select: () => {
      const m = messages.find((x) => x.from !== 'human' && x.from !== 'system');
      if (m !== undefined) setSelectFor({ message: m, initial: { start: 0, end: Math.max(0, m.text.indexOf(' A28')) } });
    },
    outgoing: () => {
      const m = messages.find((x) => x.from !== 'human' && x.from !== 'system');
      if (m !== undefined) chat.seedOut({ id: 'out-demo', text: withQuote('Wave 3 is merged; next A27', 'Why not in parallel with A28?'), typed: 'Why not in parallel with A28?', to: [], replyTo: m.id, at: Date.now(), state: 'sent', note: null, messageId: null });
    },
    busy: () => {
      roomRuns.seedPending(runKey, { kind: 'sleep', done: 2, total: 4 });
      // The menu reads the facts of the last render: let the screen see the progress first.
      setTimeout(() => previewActs.current?.menu(), 300);
    },
  };
  useEffect(() => {
    if (!DEMO || found === null || params.preview === undefined) return;
    const t = setTimeout(() => {
      const p = previewActs.current;
      if (params.preview === 'menu' || params.preview === 'offline') p?.menu();
      else if (params.preview === 'archive') p?.archive();
      else if (params.preview === 'delete') p?.remove();
      else if (params.preview === 'result') p?.result();
      else if (params.preview === 'busy') p?.busy();
      else if (params.preview === 'plate') p?.plate();
      else if (params.preview === 'select') p?.select();
      else if (params.preview === 'outgoing') p?.outgoing();
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
  const outgoing = roomOutgoing(chat.draft, chat.reply);
  // The whole letter is measured, with the selected fragment's quote block (critic A42 M3).
  const problem = letterProblem(chat.draft) ?? letterProblem(outgoing.text);
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
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={-insets.bottom} style={styles.flex}>
        {(room.proposal !== null || waiting[0] !== undefined) && (
          <BarStripStack onChange={follow.keepEnd}>
            {room.proposal !== null && (
              <BarStrip icon="checkmark.seal" iconColor={c.tint} text={`Decision ${room.proposal.id} · rev ${room.proposal.rev}`} action="Review" onPress={() => router.push({ pathname: '/decision', params: { ref: workParam(target), room: room.id, proposal: room.proposal!.id } } as never)} />
            )}
            {waiting[0] !== undefined && (
              <BarStrip icon="hand.raised" iconColor={c.needsYou} text={`${waiting[0].label} needs you`} onPress={() => router.push(`/session/${sessionParam({ ...target, sessionId: waiting[0]!.id })}` as never)} />
            )}
          </BarStripStack>
        )}
        <View style={styles.flex}>
          {!follow.revealed && data.length > 0 && (
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { paddingTop: headerHeight + 8, paddingHorizontal: 16 }]}>
              <Skeleton rows={4} />
            </View>
          )}
        <FlatList
          ref={list}
          style={{ opacity: follow.revealed || data.length === 0 ? 1 : 0 }}
          accessibilityElementsHidden={!follow.revealed && data.length > 0}
          data={data}
          keyExtractor={rowKey}
          {...follow.handlers}
          onScroll={(e) => {
            follow.handlers.onScroll(e);
            // Scrolled to the start: the next older page (not while the open is still pinning to the end).
            if (e.nativeEvent.contentOffset.y < 40 && target !== null && !follow.isPinned()) client?.loadOlder(target);
          }}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          scrollEventThrottle={64}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="never"
          contentContainerStyle={[styles.list, { paddingTop: room.proposal !== null || waiting[0] !== undefined ? 8 : headerHeight + 8 }]}
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
                  if (at >= 0) follow.leave();
                  if (at >= 0) list.current?.scrollToIndex({ index: at, animated: true, viewPosition: 0.3 });
                }}
              />
            )
          }
          onScrollToIndexFailed={() => undefined}
        />
        </View>
        {follow.away > 0 && (
          <View pointerEvents="box-none" style={styles.jumpAnchor}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Jump to latest, ${follow.away} new`}
            onPress={follow.jump}
            style={[styles.jump, { backgroundColor: c.surface, borderColor: c.separator }]}
          >
            <SymbolView name="arrow.down" size={14} tintColor={c.tint} />
            <Text allowFontScaling style={[typography.footnote, { color: c.tint }]}>Jump to latest · {follow.away}</Text>
          </Pressable>
          </View>
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
              {chat.reply !== null && (
                <ReplyPlate
                  title={`Reply to ${chat.reply.message.from === 'human' ? 'yourself' : who.label(chat.reply.message.from)}`}
                  quote={replyQuote(chat.reply.message.text, chat.reply.selected)}
                  onClear={() => chat.setReply(null)}
                />
              )}
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
                  ref={roomInput}
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
      <Modal visible={selectFor !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSelectFor(null)}>
        {selectFor !== null && (
          <SelectTextSheet
            text={selectFor.message.text}
            {...(selectFor.initial === undefined ? {} : { initial: selectFor.initial })}
            onClose={() => setSelectFor(null)}
            onReply={(selected) => {
              chat.setReply({ message: selectFor.message, selected });
              setSelectFor(null);
            }}
          />
        )}
      </Modal>
      {/* The result opens by itself, so it waits for the unlock instead of opening over the lock cover (critic M1). */}
      <Modal visible={run.unseen !== null && !covered && focused && selectFor === null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => roomRuns.seen(runKey)}>
        {run.unseen !== null && <ResultSheet title={run.unseen.title} results={run.unseen.results} onClose={() => roomRuns.seen(runKey)} />}
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

// The capsule's slot: in flow right above the composer area, overlapping the list by its own height (net layout height 0),
// so it follows the composer through the keyboard, a taller draft, the reply plate, the Resume row and cards.
const JUMP_H = 52;
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
  jumpAnchor: { height: JUMP_H, marginTop: -JUMP_H, justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 8 },
  jump: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8 },
});
