// Session = the chat of a session (D1 §9, plan A32): a pinned two-line header, the feed with folded finished turns,
// the live waiting card, and at the bottom either the card's actions or the message field. The data layer is
// `remote-client`: `openFeed` keeps the subscription alive while this screen is open (A31).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { FeedItem } from '@parley/core';
import { attentionOfSession, selectWorks, sessionKey, type SessionRef } from '@parley/remote-client';
import { ConsentCardView } from '../../cards/ConsentViews';
import { cardBelongsToSession } from '../../cards/consent-model';
import { ActiveCard } from '../../cards/CardViews';
import { goneEntries, useGoneDismiss } from '../../cards/gone';
import { timeAgo } from '../../cards/model';
import { capsuleOf, needReason, type Capsule } from '../../cards/status';
import { useConsents } from '../../cards/use-consents';
import { ConnectionBanner } from '../../components/ConnectionBanner';
import { Toast, useToast } from '../../components/Toast';
import { DEMO } from '../../dev/flags';
import { touchAppLock } from '../../auth/lock-instance';
import { useCloseOnLock } from '../../auth/use-lock-sheet';
import { Composer } from '../../feed/Composer';
import { copyText, messageActions, sendAgainReason, type ActionId } from '../../feed/message-actions';
import { splitQuote, replyQuote } from '../../feed/reply';
import { SelectTextSheet } from '../../feed/SelectTextSheet';
import type { Selection } from '../../feed/selection';
import { FoldRowView, OutBubble, type MessageApi } from '../../feed/FeedViews';
import { foldFeed, type FoldRow } from '../../feed/fold';
import { promptCount, visibleOut, type OutMessage } from '../../feed/outbox';
import { SleepingRow } from '../../feed/ResumeViews';
import { commandToast, confirmOf, menuItems, type MenuId } from '../../feed/session-menu';
import { SwitchSheet } from '../../feed/SwitchSheet';
import { composerMode, messageProblem } from '../../feed/send';
import type { ResumeFacts } from '../../feed/resume';
import { useResume } from '../../feed/use-resume';
import { useChat } from '../../feed/use-chat';
import { haptic } from '../../haptics';
import { useCanAct, useClient, useNow, useRemoteState } from '../../hooks/use-remote';
import { parseSessionParam, sessionParam, workParam } from '../../nav/refs';
import { runtime } from '../../runtime/instance';
import { spacing, typography, useColors } from '../../theme';
import { barBack, BarStrip, BarStripStack, BarSymbol, barRight, useBarMaterial } from '../../ui/bar';
import { Button } from '../../ui/Button';
import { ReplyPlate } from '../../ui/ReplyPlate';
import { EmptyState, Skeleton } from '../../ui/parts';
import { attentionOf, TreeRows, type TreeEnv } from '../../works/TeamTree';
import { originOf } from '../../works/origin';
import { subtreeOf, teamLine } from '../../works/teams';

type Row = { t: 'fold'; row: FoldRow } | { t: 'out'; message: OutMessage };
const rowKey = (r: Row): string => (r.t === 'fold' ? `f:${r.row.key}` : `o:${r.message.id}`);
const NEAR_BOTTOM = 80;

function HeaderTitle({ name, capsule, meta }: { name: string; capsule: Capsule | null; meta: string }) {
  const c = useColors();
  const tone = capsule === null ? c.idle : capsule.tone === 'needsYou' ? c.needsYou : capsule.tone === 'working' ? c.working : capsule.tone === 'danger' ? c.danger : capsule.tone === 'success' ? c.success : capsule.tone === 'idle' ? c.idle : c.off;
  // State first and never squeezed, then `role · model · time` (D1 §9.1).
  const word = capsule === null ? '' : capsule.label;
  const status = [word, meta].filter((x) => x !== '').join(' · ');
  return (
    <View accessible accessibilityRole="header" accessibilityLabel={`${name}. ${status}`} style={styles.headerTitle}>
      <Text numberOfLines={1} allowFontScaling style={[typography.headline, { color: c.label }]}>
        {name}
      </Text>
      {status !== '' && (
        <View style={styles.statusLine}>
          <View style={[styles.dot, { backgroundColor: tone }]} />
          <Text numberOfLines={1} allowFontScaling style={[typography.caption1, { color: c.barSubtitle }]}>
            {status}
          </Text>
        </View>
      )}
    </View>
  );
}

export default function SessionScreen() {
  const c = useColors();
  const material = useBarMaterial();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { ref: param, fresh, preview } = useLocalSearchParams<{ ref: string; fresh?: string; preview?: string }>();
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
  useCloseOnLock(teamOpen, () => setTeamOpen(false));
  const [switchOpen, setSwitchOpen] = useState(false);
  useCloseOnLock(switchOpen, () => setSwitchOpen(false));
  // Select Text (D1 §9.2): the message source in a read-only field; `initial` is a developer-preview selection.
  const [selectFor, setSelectFor] = useState<{ text: string; initial?: Selection } | null>(null);
  useCloseOnLock(selectFor !== null, () => setSelectFor(null));
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
  // A37b: waking a sleeping session; "Resume and send" holds the text here until the agent is ready.
  const consents = useConsents();
  const resumeFacts = useMemo<ResumeFacts | null>(() => {
    if (found === null || state === null || ref === null) return null;
    const { session: sn } = found;
    const attn = attentionOfSession(state, ref, sn);
    return {
      lifecycle: sn.lifecycle === 'sleeping' ? 'sleeping' : sn.lifecycle === 'closed' ? 'closed' : 'other',
      // A provider switch (agent-switch) does not hold a wake-up; project MCP and folder trust of this work do.
      held: consents.rows.some(({ card }) => card.kind !== 'agent-switch' && cardBelongsToSession(card, ref)),
      idle: attn === 'idle' || attn === 'unseen',
      // Only a hook event counts (the map's history holds lifecycle moves, not hooks).
      lastEventAt: state.activity[sessionKey(ref)]?.activity.lastEventAt ?? null,
    };
  }, [found, state, consents.rows, ref?.projectPath, ref?.workId, ref?.sessionId]);
  const resume = useResume(client, ref, resumeFacts, { send: chat.sendText, textBack: chat.giveBack, notify: toast.show });
  const hasResume = DEMO || (state?.methods?.includes('sessions.resume') ?? false);
  // ⬆ on a sleeping session asks first; the text stays in the field until the person agrees.
  const askResumeAndSend = (text: string, fromField = true): void =>
    Alert.alert(`${found?.session.label ?? 'This session'} is sleeping`, undefined, [
      { text: 'Resume and send', onPress: () => { if (resume.start(text) && fromField) chat.setDraft(''); } },
      { text: 'Cancel', style: 'cancel' },
    ]);
  const pendingRow = resume.view.pending;
  const pendingMessage: OutMessage | null = pendingRow === null ? null : { id: 'resume-pending', text: pendingRow.text, at: 0, state: { kind: pendingRow.held ? 'held' : 'waking' } };
  const rows = useMemo<Row[]>(
    () => [...folded.map((row): Row => ({ t: 'fold', row })), ...out.map((message): Row => ({ t: 'out', message })), ...(pendingMessage === null ? [] : [{ t: 'out', message: pendingMessage } as Row])],
    [folded, out, pendingRow?.text, pendingRow?.held],
  );
  // Developer preview of the message pieces (A42): set during render once the session is found.
  // The message actions, read through a ref so the feed rows keep a stable prop and `memo` works (critic A42 m8).
  const msgRef = useRef<MessageApi | null>(null);
  const msgApi = useMemo<MessageApi>(() => ({ actions: (i) => msgRef.current?.actions(i) ?? [], run: (i, id) => msgRef.current?.run(i, id), sheet: (i) => msgRef.current?.sheet(i), copyCode: (code) => msgRef.current?.copyCode(code) }), []);
  const previewMsg = useRef<{ reply(): void; prompt(): void; select(): void; plate(): void } | null>(null);
  useEffect(() => {
    if (!DEMO || found === null || preview === undefined) return;
    const t = setTimeout(() => {
      if (preview === 'actions-reply') previewMsg.current?.reply();
      else if (preview === 'actions-prompt') previewMsg.current?.prompt();
      else if (preview === 'select') previewMsg.current?.select();
      else if (preview === 'plate') previewMsg.current?.plate();
    }, 900);
    return () => clearTimeout(t);
  }, [preview, found !== null]);
  // Developer preview of the ⋯ menu pieces: the functions exist only once the session is found (set during render).
  const previewActs = useRef<{ menu(): void; close(): void; switchSheet(): void } | null>(null);
  useEffect(() => {
    if (!DEMO || found === null) return;
    const t = setTimeout(() => {
      if (preview === 'menu') previewActs.current?.menu();
      else if (preview === 'close') previewActs.current?.close();
      else if (preview === 'switch') previewActs.current?.switchSheet();
    }, 600);
    return () => clearTimeout(t);
  }, [preview, found !== null]);
  // Developer preview (screenshots): `?preview=waking|failed|pending|alert` sets the state without taps.
  useEffect(() => {
    if (!DEMO || preview === undefined) return;
    if (preview === 'waking') resume.seed({ line: { kind: 'waking' }, hidden: false, pending: null });
    else if (preview === 'failed') resume.seed({ line: { kind: 'failed', message: "Couldn't wake it — no free slot on your Mac" }, hidden: false, pending: null });
    else if (preview === 'pending') resume.seed({ line: { kind: 'waking' }, hidden: false, pending: { text: 'Please run the linter once more', held: false } });
    else if (preview === 'alert') {
      chat.setDraft('Please run the linter once more');
      askResumeAndSend('Please run the linter once more');
    }
  }, [preview]);


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
  const subtitle = [session.role, session.model, started === null ? null : `${started}`].filter((x) => x !== null && x !== '').join(' · ');
  const env: TreeEnv = {
    state,
    view,
    actions: {
      openSession: (id) => router.push(`/session/${sessionParam({ ...ref, sessionId: id })}` as never),
      openDecision: (roomId, proposalId) => router.push({ pathname: '/decision', params: { ref: workParam(ref), room: roomId, proposal: proposalId } } as never),
      openRoom: (roomId) => router.push({ pathname: '/room', params: { ref: workParam(ref), room: roomId } } as never),
    },
  };
  const team = subtreeOf(view.rows, session.id);
  const counts = { agents: 1 + team.filter((x) => x.row.kind === 'session').length + team.reduce((n, x) => n + (x.row.kind === 'room' ? x.row.members.length : x.row.kind === 'swarm' ? x.row.members.length : 0), 0), rooms: team.filter((x) => x.row.kind === 'room').length, swarms: team.filter((x) => x.row.kind === 'swarm').length };
  const sleeping = session.lifecycle === 'sleeping';
  const blockedNoCard = first === undefined && attention === 'needs-you' && need?.kind !== 'limit' && need?.kind !== 'sign-in' && !loading;
  const mode = composerMode({
    hasMethod: DEMO || (state.methods?.includes('pty.send') ?? false),
    closed: session.lifecycle === 'closed',
    sleeping: session.lifecycle === 'sleeping',
    hasResume,
    hasCard: first !== undefined,
    blockedNoCard,
    working: attention === 'working' || turnRunning,
    online: canAct,
    limitNote: need?.kind === 'limit' ? `${needReason(need)} — the agent reads it after the reset` : null,
    feedReady: feed?.status === 'ready',
  });
  const hidden = chat.switchedOff ? ({ kind: 'hidden', text: 'Messaging agents from the phone is turned off on your Mac' } as const) : mode;
  // The origin is the first line of the history (it scrolls away); the team and the actions are behind "•••".
  const header = (
    <View style={styles.passport}>
      <ConnectionBanner />
      {origin.length > 0 && (
        <View style={styles.origin}>
          <SymbolView name="arrow.turn.left.up" size={14} tintColor={c.label2} />
          <Text allowFontScaling numberOfLines={2} style={[typography.footnote, styles.flex, { color: c.label2 }]}>
            {origin.map((o) => o.label).join(' › ')}
          </Text>
        </View>
      )}
    </View>
  );
  const memberOf = view.rows.find((r) => r.kind === 'room' && r.room.members.includes(session.id));
  // Demo data has no hello: every menu method counts as present (screenshots).
  const menuMethods = DEMO ? ['sessions.resume', 'feed.interrupt', 'sessions.stop', 'sessions.close', 'sessions.switchOptions', 'sessions.switchAgent'] : state.methods;
  const runCommand = (id: 'stop' | 'sleep' | 'close'): void => {
    const method = id === 'stop' ? 'feed.interrupt' : id === 'sleep' ? 'sessions.stop' : 'sessions.close';
    void client?.sessionCommand(method, ref).then((outcome) => {
      if (outcome.outcome === 'ok') haptic.success();
      else haptic.error();
      toast.show(commandToast(id, outcome));
    });
  };
  const confirmThen = (id: 'sleep' | 'close'): void => {
    const q = confirmOf(id, session.label);
    Alert.alert(q.title, q.message, [{ text: q.button, style: id === 'close' ? 'destructive' : 'default', onPress: () => runCommand(id) }, { text: 'Cancel', style: 'cancel' }]);
  };
  const menu = (): void => {
    const items = menuItems({
      methods: menuMethods,
      lifecycle: session.lifecycle,
      working: attention === 'working' || turnRunning,
      teamAgents: team.length > 0 ? counts.agents : 0,
      inRoom: memberOf !== undefined && memberOf.kind === 'room',
    });
    const run: Record<MenuId, () => void> = {
      team: () => setTeamOpen(true),
      room: () => memberOf !== undefined && memberOf.kind === 'room' && env.actions.openRoom(memberOf.room.id),
      resume: () => resume.start(null),
      stop: () => runCommand('stop'),
      sleep: () => confirmThen('sleep'),
      switch: () => setSwitchOpen(true),
      copy: () => void Clipboard.setStringAsync(session.id),
      close: () => confirmThen('close'),
    };
    const destructive = items.findIndex((i) => i.destructive === true);
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [...items.map((i) => i.title), 'Cancel'], cancelButtonIndex: items.length, ...(destructive >= 0 ? { destructiveButtonIndex: destructive } : {}) },
      (i) => (items[i] === undefined ? undefined : run[items[i]!.id]()),
    );
  };
  previewActs.current = { menu, close: () => confirmThen('close'), switchSheet: () => setSwitchOpen(true) };
  // The message actions (D1 §9.2): one `run` for the long-press sheet and for VoiceOver's custom actions.
  const kindOf = (item: FeedItem): 'agent' | 'prompt' => (item.kind === 'prompt' ? 'prompt' : 'agent');
  const actionsOf = (item: FeedItem) => {
    if (item.kind !== 'text' && item.kind !== 'prompt') return [];
    const canSend = hidden.kind === 'input' && hidden.sendEnabled && !chat.busy && resume.view.pending === null && messageProblem(item.text.trim()) === null;
    return messageActions({ kind: kindOf(item), hasPtySend: DEMO || (state.methods?.includes('pty.send') ?? false), closed: session.lifecycle === 'closed', canSend });
  };
  const runAction = (item: FeedItem, id: ActionId): void => {
    if (item.kind !== 'text' && item.kind !== 'prompt') return;
    const kind = kindOf(item);
    // The list for VoiceOver may be older than the field's state: check the action against the facts of now (critic m17).
    const now = actionsOf(item).find((a) => a.id === id);
    if (now === undefined) return;
    if (now.disabled === true) {
      toast.show(sendAgainReason({ mode: hidden, busy: chat.busy || resume.view.pending !== null, text: item.text.trim() }) ?? 'Not available right now');
      return;
    }
    if (id === 'copy') {
      void Clipboard.setStringAsync(copyText(kind, item.text));
      toast.show('Copied');
    } else if (id === 'reply') {
      // An own prompt that carries a quote is quoted without it (no quote inside a quote).
      const own = splitQuote(item.text.trim()).text;
      chat.setQuote(replyQuote(kind === 'prompt' && own !== '' ? own : item.text, ''));
    } else if (id === 'again') {
      const text = item.text.trim();
      if (sleeping) askResumeAndSend(text, false);
      else void chat.again(text, promptCount(items ?? [], text));
    } else if (id === 'select') setSelectFor({ text: kind === 'prompt' ? item.text.trim() : item.text });
  };
  msgRef.current = {
    actions: actionsOf,
    run: runAction,
    copyCode: (code) => {
      void Clipboard.setStringAsync(code);
      toast.show('Copied');
    },
    sheet: (item) => {
      const actions = actionsOf(item);
      if (actions.length === 0) return;
      haptic.selection();
      const off = actions.flatMap((a, i) => (a.disabled === true ? [i] : []));
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...actions.map((a) => a.title), 'Cancel'], cancelButtonIndex: actions.length, ...(off.length > 0 ? { disabledButtonIndices: off } : {}) },
        (i) => {
          const a = actions[i];
          if (a !== undefined) runAction(item, a.id);
        },
      );
    },
  };
  // Developer preview of the message pieces (screenshots, A42): `?preview=actions-reply|actions-prompt|select|plate`.
  previewMsg.current = {
    reply: () => { const i = (items ?? []).find((x) => x.kind === 'text'); if (i !== undefined) msgApi.sheet(i); },
    prompt: () => { const i = [...(items ?? [])].reverse().find((x) => x.kind === 'prompt'); if (i !== undefined) msgApi.sheet(i); },
    select: () => { const i = (items ?? []).find((x) => x.kind === 'text'); if (i?.kind === 'text') setSelectFor({ text: i.text, initial: { start: 0, end: i.text.indexOf(' found') } }); },
    plate: () => { const i = (items ?? []).find((x) => x.kind === 'text'); if (i !== undefined) msgApi.run(i, 'reply'); },
  };
  // "Needs you" without a card on screen is one pinned line under the bar (D1 §9.1); with a card the card says it.
  const strip =
    attention === 'needs-you' && first === undefined && !loading
      ? need?.kind === 'limit'
        ? { icon: 'hourglass' as const, text: needReason(need) }
        : need?.kind === 'sign-in'
          ? { icon: 'person.badge.key' as const, text: `${needReason(need)} — sign in at your Mac` }
          : { icon: 'desktopcomputer' as const, text: 'Answer at your Mac — in its terminal' }
      : null;

  const content = (parts: { body: React.ReactNode; actions: React.ReactNode } | null) => (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0} style={styles.flex}>
      {strip !== null && (
        <BarStripStack onChange={() => atBottom.current && list.current?.scrollToEnd({ animated: false })}>
          <BarStrip icon={strip.icon} iconColor={c.needsYou} text={strip.text} onPress={() => list.current?.scrollToEnd({ animated: true })} />
        </BarStripStack>
      )}
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
        renderItem={({ item: r }) => (r.t === 'fold' ? <FoldRowView row={r.row} onToggleGroup={toggleGroup} onToggleTurn={toggleTurn} msg={msgApi} /> : <OutBubble message={r.message} onRetry={(m) => void chat.retry(m)} onEdit={chat.edit} />)}
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
        {sleeping && hasResume && first === undefined && !resume.view.hidden && <SleepingRow line={resume.view.line} enabled={canAct} onResume={() => resume.start(null)} />}
        {first !== undefined && parts !== null ? (
          parts.actions
        ) : (
          <>
            {chat.quote !== null && hidden.kind === 'input' && <ReplyPlate quote={chat.quote} onClear={() => chat.setQuote(null)} />}
          <Composer
            label={session.label}
            mode={hidden}
            draft={chat.draft}
            onChange={chat.setDraft}
            onSend={() => (sleeping ? messageProblem(chat.draft) === null && messageProblem(chat.composed) === null && askResumeAndSend(chat.composed) : void chat.send())}
            busy={chat.busy || resume.view.pending !== null}
            measured={chat.composed}
          />
          </>
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
          ...barBack(null),
          title: session.label,
          headerTitle: () => <HeaderTitle name={session.label} capsule={capsule} meta={subtitle} />,
          ...barRight(<BarSymbol name="ellipsis.circle" label="More" onPress={menu} />),
          ...material,
        }}
      />
      <Modal visible={teamOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setTeamOpen(false)}>
        {/* A touch in the sheet restarts the idle term; the lock closes the sheet (plan A35b). */}
        <View onTouchStart={touchAppLock} style={[styles.page, { backgroundColor: c.bg }]}>
          <View style={styles.sheetHead}>
            <Text accessibilityRole="header" allowFontScaling style={[typography.headline, styles.flex, { color: c.label }]}>
              {teamLine(counts)}
            </Text>
            <Pressable accessibilityRole="button" onPress={() => setTeamOpen(false)} style={styles.bar}>
              <Text allowFontScaling style={[typography.body, { color: c.tint }]}>Done</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            <View style={[styles.box, { backgroundColor: c.surface, paddingHorizontal: 0 }]}>
              <TreeRows rows={team} env={{ ...env, actions: { openSession: (id) => { setTeamOpen(false); env.actions.openSession(id); }, openDecision: (r, p) => { setTeamOpen(false); env.actions.openDecision(r, p); }, openRoom: (r) => { setTeamOpen(false); env.actions.openRoom(r); } } }} />
            </View>
          </ScrollView>
        </View>
      </Modal>
      <Modal visible={switchOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSwitchOpen(false)}>
        <SwitchSheet
          client={client}
          sessionRef={ref}
          label={session.label}
          roomTitle={(id) => view.work.rooms.find((r) => r.id === id)?.title ?? id}
          providerLabel={(id) => state.providers?.providers.find((p) => p.id === id)?.label ?? null}
          canAct={canAct}
          onToast={toast.show}
          onClose={() => setSwitchOpen(false)}
          onDone={(text) => {
            setSwitchOpen(false);
            toast.show(text);
          }}
        />
      </Modal>
      <Modal visible={selectFor !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSelectFor(null)}>
        {selectFor !== null && (
          <SelectTextSheet
            text={selectFor.text}
            {...(selectFor.initial === undefined ? {} : { initial: selectFor.initial })}
            onClose={() => setSelectFor(null)}
            onReply={(selected) => {
              chat.setQuote(replyQuote(selectFor.text, selected));
              setSelectFor(null);
            }}
          />
        )}
      </Modal>
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

/** A provider-switch or project-MCP request for this session stands above the feed with the same Deny / Allow as in Inbox (D1 §9.4). */
function SwitchCards({ sessionRef }: { sessionRef: SessionRef }) {
  const consents = useConsents();
  const canAct = useCanAct();
  const now = useNow(30_000);
  const mine = consents.rows.filter(({ card }) => cardBelongsToSession(card, sessionRef));
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
  bar: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  teamRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, minHeight: 28 },
  switchWrap: { gap: 8, marginBottom: 8 },
});
