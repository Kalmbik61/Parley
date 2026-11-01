// New session / New room (D1 §8.4): start an agent or open a room from the phone. Face ID before every launch and every
// send; the Mac decides (rules, known works, limits) and its words come back as they are.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, usePreventRemove, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { approve } from '../auth/instance';
import { FACE_ID_CANCELLED, NO_PASSCODE, Toast, useToast } from '../components/Toast';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { DEMO } from '../dev/flags';
import { haptic } from '../haptics';
import { selectLaunchCapabilities } from '@parley/remote-client';
import { useCanAct, useRemoteState } from '../hooks/use-remote';
import { Card, Divider, Label, MenuRow, Segmented, choose } from '../launch/form-parts';
import {
  AUTONOMOUS_NOTE,
  LETTER_PLACEHOLDER,
  ROOM_MODES,
  afterPartial,
  defaultWorkspace,
  hasDraft,
  launchRoom,
  launchSession,
  letterProblem,
  methodMissing,
  providerChoices,
  roomCandidates,
  roomProblem,
  sendFirstLetter,
  sessionProblem,
  workspaces,
  type LaunchFailure,
  type NewAgent,
  type RoleChoice,
  type RoomMode,
  type Workspace,
} from '../launch/launch-model';
import { parseWorkParam, sessionParam, workParam } from '../nav/refs';
import { useRuntimeState } from '../runtime/use-runtime';
import { spacing, typography, useColors } from '../theme';

type Kind = 'session' | 'room';
const str = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default function NewScreen() {
  const c = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ ref?: string; mode?: string }>();
  const state = useRemoteState();
  const { client } = useRuntimeState();
  const online = useCanAct();
  const toast = useToast();
  const sending = useRef(false);

  const caps = selectLaunchCapabilities(state ?? { methods: DEMO ? ['sessions.create', 'rooms.create', 'rooms.send'] : null });
  const [kind, setKind] = useState<Kind>(str(params.mode) === 'room' || (!caps.canCreateSession && caps.canCreateRoom) ? 'room' : 'session');
  const list = useMemo(() => (state === null ? [] : workspaces(state)), [state]);
  const from = useMemo(() => parseWorkParam(str(params.ref)), [params.ref]);
  const [ws, setWs] = useState<Workspace | null>(null);
  useEffect(() => {
    if (ws === null && list.length > 0) setWs(defaultWorkspace(list, from));
  }, [list, from, ws]);

  // Catalogs: providers once, roles per project.
  useEffect(() => {
    if (client !== null && state?.providers == null) void client.loadProviders();
  }, [client, state?.providers == null]);
  useEffect(() => {
    if (client !== null && ws !== null && state?.roles[ws.projectPath] === undefined) void client.loadRoles(ws.projectPath);
  }, [client, ws?.projectPath]);
  const providers = useMemo(() => (state === null ? [] : providerChoices(state)), [state?.providers]);
  const roles = ws === null ? [] : (state?.roles[ws.projectPath]?.roles ?? []);
  const catalogsReady = state?.providers != null;

  // New session.
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState<string | null>(null);
  const [role, setRole] = useState<RoleChoice | null>(null);
  const [name, setName] = useState('');
  const [task, setTask] = useState('');
  const [worktree, setWorktree] = useState(false);
  useEffect(() => {
    if (provider === '' && providers.length > 0) setProvider((providers.find((p) => p.available) ?? providers[0]!).id);
  }, [providers, provider]);
  const providerOf = providers.find((p) => p.id === provider);

  // New room.
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<RoomMode>('free');
  const [members, setMembers] = useState<string[]>([]);
  const [agents, setAgents] = useState<NewAgent[]>([]);
  const [lead, setLead] = useState<string | null>(null);
  const work = state?.snapshot?.works.find((w) => ws !== null && w.projectPath === ws.projectPath && w.id === ws.workId) ?? null;
  const candidates = work === null ? [] : roomCandidates(work);

  // Step 2 of a room: the first message.
  const [step, setStep] = useState<'form' | 'letter'>('form');
  const [made, setMade] = useState<{ ref: { projectPath: string; workId: string; roomId: string }; agents: number } | null>(null);
  const [letter, setLetter] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionForm = { projectPath: ws?.projectPath ?? '', workId: ws?.workId ?? '', provider, model, role, name, task, worktree };
  const roomForm = { projectPath: ws?.projectPath ?? '', workId: ws?.workId ?? '', title, mode, members, agents, lead };
  // A method the action needs is gone (the Mac switch was turned off while the sheet was open): the text says so and
  // Face ID is not asked for a call that will not go (D1 §12a).
  const gone = state === null || DEMO ? null : methodMissing(state, step === 'letter' ? 'letter' : kind, kind === 'room' ? agents.length : 0);

  const problem = step === 'letter' ? letterProblem(letter) : kind === 'session' ? sessionProblem(sessionForm, providers) : roomProblem(roomForm, providers);
  const ready = ws !== null && catalogsReady && problem === null && online && !busy && gone === null;
  const draft = hasDraft(kind, sessionForm, roomForm, letter);

  const fail = useCallback((f: LaunchFailure | { message: string }) => {
    setError(f.message);
    haptic.error();
  }, []);

  // Leaving goes through state so the "dirty sheet" guard is already off when the screen is dismissed.
  const navigation = useNavigation();
  const [exit, setExit] = useState<{ route: string | null } | null>(null);
  useEffect(() => {
    if (exit === null) return;
    router.dismiss();
    if (exit.route !== null) router.push(exit.route as never);
  }, [exit, router]);
  const askDiscard = (onDiscard: () => void) =>
    Alert.alert('Discard this draft?', undefined, [{ text: 'Keep editing', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: onDiscard }]);
  // Swipe-down on a dirty sheet asks instead of being blocked (D1 §8.4).
  usePreventRemove(draft && exit === null && !busy, ({ data }) => askDiscard(() => navigation.dispatch(data.action)));

  const close = () => (draft && !busy ? askDiscard(() => setExit({ route: null })) : setExit({ route: null }));

  const finish = (route: string, message: string) => {
    haptic.success();
    toast.show(message);
    setTimeout(() => setExit({ route }), 600);
  };

  const submit = async () => {
    if (client === null || ws === null || sending.current || !ready) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (step === 'letter' && made !== null) {
        const res = await sendFirstLetter(client, approve, made.ref, letter);
        if (res.kind === 'cancelled') return toast.show(res.reason === 'no-passcode' ? NO_PASSCODE : FACE_ID_CANCELLED);
        if (res.kind !== 'sent') return fail(res);
        return finish(`/work/${workParam({ projectPath: made.ref.projectPath, workId: made.ref.workId })}`, 'Task sent to the room');
      }
      if (kind === 'session') {
        const res = await launchSession(client, approve, sessionForm);
        if (res.kind === 'cancelled') return toast.show(res.reason === 'no-passcode' ? NO_PASSCODE : FACE_ID_CANCELLED);
        if (res.kind !== 'created') return fail(res);
        return finish(`/session/${sessionParam(res.ref)}`, 'Session started');
      }
      const res = await launchRoom(client, approve, roomForm);
      if (res.kind === 'cancelled') return toast.show(res.reason === 'no-passcode' ? NO_PASSCODE : FACE_ID_CANCELLED);
      if (res.kind === 'partial') {
        // Agents that started stay: they become members, so a retry starts only what is missing.
        const next = afterPartial(roomForm, res.startedAgents);
        setMembers(next.members);
        setAgents(next.agents);
        setLead(next.lead);
        return fail(res);
      }
      haptic.success();
      setMade({ ref: res.ref, agents: res.agents });
      setStep('letter');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const later = () => {
    if (made === null) return;
    toast.show('Write the task in the room on your Mac');
    setTimeout(() => setExit({ route: `/work/${workParam({ projectPath: made.ref.projectPath, workId: made.ref.workId })}` }), 900);
  };

  const pickWorkspace = async () => {
    if (list.length < 2) return;
    const i = await choose('Workspace', list.map((w) => `${w.title} · ${w.projectName}`));
    if (i === null) return;
    setWs(list[i]!);
    setRole(null);
    setMembers([]);
    setLead(null);
  };
  const pickModel = async () => {
    const models = providerOf?.models ?? [];
    if (models.length === 0) return;
    const i = await choose('Model', ['Default', ...models.map((m) => m.label)]);
    if (i !== null) setModel(i === 0 ? null : models[i - 1]!.id);
  };
  const pickRole = async () => {
    if (roles.length === 0) return;
    const i = await choose('Role', ['None', ...roles.map((r) => r.name)]);
    if (i !== null) setRole(i === 0 ? null : { source: roles[i - 1]!.source, name: roles[i - 1]!.name });
  };
  const toggleMember = (id: string) => {
    haptic.selection();
    setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
    if (lead === id) setLead(null);
  };
  const addAgent = () => {
    const p = providers.find((x) => x.available) ?? providers[0];
    if (p === undefined) return;
    setAgents((a) => [...a, { key: `n${Date.now()}${a.length}`, provider: p.id, model: null, role: null }]);
  };

  const count = members.length + agents.length;
  const summary =
    step === 'letter'
      ? ''
      : kind === 'session'
        ? `One session in ${ws?.title ?? '…'}`
        : `Room with ${count} ${count === 1 ? 'agent' : 'agents'} in ${ws?.title ?? '…'}`;
  const actionTitle = step === 'letter' ? 'Send to the room' : kind === 'session' ? 'Start session' : 'Create room';
  const off = !online ? 'Reconnecting — actions are paused' : gone;

  return (
    <View style={[styles.page, { backgroundColor: c.bg }]}>
      <Stack.Screen options={{ title: step === 'letter' ? 'Room created' : kind === 'session' ? 'New session' : 'New room', headerBackVisible: false, headerLeft: () => (
        <Pressable accessibilityRole="button" hitSlop={8} onPress={step === 'letter' ? later : close}>
          <Text allowFontScaling style={[typography.body, { color: c.tint }]}>{step === 'letter' ? 'Later' : 'Cancel'}</Text>
        </Pressable>
      ) }} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {/* First child of the scroll view, so it sits below a translucent sheet header (as on the M1 screens). */}
          <View style={styles.banner}>
            <ConnectionBanner />
          </View>
          {step === 'letter' && made !== null ? (
            <>
              <View style={styles.created}>
                <SymbolView name="checkmark.circle.fill" size={44} tintColor={c.success} />
                <Text allowFontScaling style={[typography.headline, { color: c.label }]}>{title.trim()}</Text>
                <Text allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>
                  {made.agents} {made.agents === 1 ? 'agent' : 'agents'} · {mode}
                </Text>
              </View>
              <Label>{LETTER_PLACEHOLDER}</Label>
              <TextInput
                accessibilityLabel={LETTER_PLACEHOLDER}
                autoFocus
                multiline
                value={letter}
                onChangeText={setLetter}
                placeholder="What should the room do?"
                placeholderTextColor={c.label3}
                style={[typography.body, styles.input, { backgroundColor: c.surface, color: c.label, minHeight: 140 }]}
              />
              <Text allowFontScaling style={[typography.footnote, { color: c.label2, marginTop: 8, marginHorizontal: 16 }]}>
                The room started quietly: this message is its task. Every agent in the room gets it.
              </Text>
            </>
          ) : (
            <>
              {caps.canCreateSession && caps.canCreateRoom ? (
                <Segmented<Kind> label="What to create" value={kind} onChange={(k) => { setKind(k); setError(null); }} options={[{ value: 'session', label: 'Session' }, { value: 'room', label: 'Room' }]} />
              ) : null}
              <Label>Workspace</Label>
              <Card>
                <MenuRow label="Workspace" value={ws === null ? '…' : `${ws.title}`} onPress={() => void pickWorkspace()} disabled={list.length < 2} />
              </Card>

              {kind === 'session' ? (
                <>
                  <Label>Agent</Label>
                  <Card>
                    {!catalogsReady ? (
                      <View style={styles.loading}><ActivityIndicator /></View>
                    ) : (
                      <>
                        <View style={styles.pad}>
                          <Segmented
                            label="Agent"
                            value={provider}
                            onChange={(p) => { setProvider(p); setModel(null); }}
                            options={providers.map((p) => ({ value: p.id, label: p.label, disabled: !p.available }))}
                          />
                          {providerOf?.reason ? (
                            <Text allowFontScaling style={[typography.footnote, { color: c.danger, marginTop: 6 }]}>{providerOf.reason}</Text>
                          ) : null}
                        </View>
                        <Divider />
                        <MenuRow label="Model" value={model === null ? 'Default' : (providerOf?.models.find((m) => m.id === model)?.label ?? model)} onPress={() => void pickModel()} disabled={(providerOf?.models.length ?? 0) === 0} />
                        <Divider />
                        <MenuRow label="Role" value={role?.name ?? 'None'} onPress={() => void pickRole()} disabled={roles.length === 0} />
                      </>
                    )}
                  </Card>
                  <Label>Session name</Label>
                  <TextInput accessibilityLabel="Session name" value={name} onChangeText={setName} placeholder="Optional" placeholderTextColor={c.label3} maxLength={64} style={[typography.body, styles.field, { backgroundColor: c.surface, color: c.label }]} />
                  <Label>Task</Label>
                  <TextInput accessibilityLabel="Task" multiline value={task} onChangeText={setTask} placeholder="What should the agent do?" placeholderTextColor={c.label3} style={[typography.body, styles.input, { backgroundColor: c.surface, color: c.label }]} />
                  <Card>
                    <View style={[styles.row, styles.pad]}>
                      <SymbolView name="arrow.triangle.branch" size={18} tintColor={c.label2} />
                      <Text allowFontScaling style={[typography.body, styles.flex, { color: c.label }]}>Own worktree</Text>
                      <Switch accessibilityLabel="Own worktree" value={worktree} onValueChange={setWorktree} />
                    </View>
                  </Card>
                </>
              ) : (
                <>
                  <Label>Room name</Label>
                  <TextInput accessibilityLabel="Room name" value={title} onChangeText={setTitle} placeholder="What the agents will discuss" placeholderTextColor={c.label3} maxLength={128} style={[typography.body, styles.field, { backgroundColor: c.surface, color: c.label }]} />
                  <Label>Mode</Label>
                  <Segmented<RoomMode> label="Mode" value={mode} onChange={setMode} options={ROOM_MODES.map((m) => ({ value: m.mode, label: m.title }))} />
                  <Text allowFontScaling style={[typography.footnote, styles.note, { color: c.label2 }]}>
                    {ROOM_MODES.find((m) => m.mode === mode)?.hint}. {AUTONOMOUS_NOTE}.
                  </Text>
                  <Label>Members · ★ lead</Label>
                  <Card>
                    {candidates.length === 0 ? (
                      <Text allowFontScaling style={[typography.subheadline, styles.pad, { color: c.label2 }]}>No running sessions in this work. Add new agents below.</Text>
                    ) : (
                      candidates.map((s, i) => {
                        const on = members.includes(s.id);
                        return (
                          <View key={s.id}>
                            {i > 0 ? <Divider /> : null}
                            <View style={[styles.row, styles.memberRow]}>
                              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={s.label} onPress={() => toggleMember(s.id)} style={[styles.row, styles.flex]}>
                                <SymbolView name={on ? 'checkmark.circle.fill' : 'circle'} size={22} tintColor={on ? c.tint : c.label3} />
                                <View style={styles.flex}>
                                  <Text numberOfLines={1} allowFontScaling style={[typography.body, { color: c.label }]}>{s.label}</Text>
                                  {s.role ? <Text numberOfLines={1} allowFontScaling style={[typography.footnote, { color: c.label2 }]}>{s.role}</Text> : null}
                                </View>
                              </Pressable>
                              {on ? (
                                <Pressable accessibilityRole="button" accessibilityLabel={lead === s.id ? 'Lead' : 'Make lead'} hitSlop={8} onPress={() => setLead(lead === s.id ? null : s.id)} style={styles.star}>
                                  <SymbolView name={lead === s.id ? 'star.fill' : 'star'} size={20} tintColor={lead === s.id ? c.needsYou : c.label3} />
                                </Pressable>
                              ) : null}
                            </View>
                          </View>
                        );
                      })
                    )}
                  </Card>
                  <Label>New agents</Label>
                  {agents.length > 0 ? (
                    <Card>
                      {agents.map((a, i) => (
                        <View key={a.key}>
                          {i > 0 ? <Divider /> : null}
                          <View style={[styles.row, styles.memberRow]}>
                            <View style={styles.flex}>
                              <Segmented
                                label="Agent"
                                value={a.provider}
                                onChange={(p) => setAgents((all) => all.map((x) => (x.key === a.key ? { ...x, provider: p, model: null } : x)))}
                                options={providers.map((p) => ({ value: p.id, label: p.label, disabled: !p.available }))}
                              />
                            </View>
                            <Pressable accessibilityRole="button" accessibilityLabel={lead === a.key ? 'Lead' : 'Make lead'} hitSlop={8} onPress={() => setLead(lead === a.key ? null : a.key)} style={styles.star}>
                              <SymbolView name={lead === a.key ? 'star.fill' : 'star'} size={20} tintColor={lead === a.key ? c.needsYou : c.label3} />
                            </Pressable>
                            <Pressable accessibilityRole="button" accessibilityLabel="Remove agent" hitSlop={8} onPress={() => { setAgents((all) => all.filter((x) => x.key !== a.key)); if (lead === a.key) setLead(null); }} style={styles.star}>
                              <SymbolView name="xmark.circle.fill" size={20} tintColor={c.label3} />
                            </Pressable>
                          </View>
                        </View>
                      ))}
                    </Card>
                  ) : null}
                  <Pressable accessibilityRole="button" disabled={!catalogsReady} onPress={addAgent} style={[styles.addAgent, { borderColor: c.tint, opacity: catalogsReady ? 1 : 0.4 }]}>
                    <SymbolView name="plus" size={16} tintColor={c.tint} />
                    <Text allowFontScaling style={[typography.subheadline, { color: c.tint }]}>New agent</Text>
                  </Pressable>
                </>
              )}
            </>
          )}
        </ScrollView>

        <View style={[styles.bar, { backgroundColor: c.surface, borderTopColor: c.separator }]}>
          {off !== null || error !== null ? (
            <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.footnote, { color: c.danger, textAlign: 'center' }]}>
              {off ?? error}
            </Text>
          ) : (
            <Text allowFontScaling style={[typography.footnote, { color: c.label2, textAlign: 'center' }]}>{problem !== null && step === 'form' && (task !== '' || title !== '' || count > 0) ? problem : summary}</Text>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={actionTitle}
            accessibilityState={{ disabled: !ready, busy }}
            disabled={!ready}
            onPress={() => void submit()}
            style={[styles.action, { backgroundColor: c.tint, opacity: ready ? 1 : 0.4 }]}
          >
            {busy ? (
              <ActivityIndicator color={c.onTint} />
            ) : (
              <>
                <SymbolView name="faceid" size={18} tintColor={c.onTint} />
                <Text allowFontScaling style={[typography.button, { color: c.onTint }]}>{actionTitle}</Text>
              </>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
      <Toast message={toast.message} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  flex: { flex: 1 },
  body: { padding: spacing.screenMargin, paddingBottom: 32 },
  banner: { marginHorizontal: -spacing.screenMargin, marginTop: -spacing.screenMargin, marginBottom: 8 },
  pad: { padding: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  memberRow: { paddingHorizontal: 16, minHeight: spacing.minTouchTarget },
  star: { minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  loading: { padding: 20, alignItems: 'center' },
  field: { borderRadius: spacing.nestedRadius, paddingHorizontal: 16, minHeight: spacing.minTouchTarget },
  input: { borderRadius: spacing.nestedRadius, padding: 12, minHeight: 120, textAlignVertical: 'top', marginBottom: 12 },
  note: { marginTop: 8, marginHorizontal: 16 },
  addAgent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: spacing.minTouchTarget, borderRadius: 22, borderWidth: 1, marginTop: 12 },
  created: { alignItems: 'center', gap: 6, paddingVertical: 12 },
  bar: { gap: 8, padding: spacing.screenMargin, borderTopWidth: StyleSheet.hairlineWidth },
  action: { minHeight: spacing.decisionButtonHeight, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
});
