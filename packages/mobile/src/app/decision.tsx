// Decision (D1 §10.1): accept or return a room's proposal. Both go with the shown `rev`; Accept asks Face ID.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { approve } from '../auth/instance';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { Markdown } from '../markdown/Markdown';
import { parseWorkParam } from '../nav/refs';
import { FACE_ID_CANCELLED, Toast, useToast } from '../components/Toast';
import { RETURN_NOTE_MAX, canSendReturn, submitDecision, type DecisionView, type Proposal } from '../decision/decision-flow';
import { useRemoteState } from '../runtime/use-remote';
import { useRuntimeState } from '../runtime/use-runtime';
import { spacing, typography, useColors } from '../theme';

const str = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));

export default function DecisionScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ ref: string; room: string; proposal?: string }>();
  const roomId = str(params.room);
  const { projectPath, workId } = parseWorkParam(str(params.ref)) ?? { projectPath: '', workId: '' };
  const remote = useRemoteState();
  const { client, supervisor } = useRuntimeState();
  const toast = useToast();

  const work = remote?.snapshot?.works.find((w) => w.projectPath === projectPath && w.id === workId);
  const room = work?.rooms.find((r) => r.id === roomId);
  const live = room?.proposal ?? null;

  // What the human is looking at. A conflict replaces it; a live change of the proposal never silently re-targets a tap.
  const [view, setView] = useState<DecisionView | null>(null);
  const [busy, setBusy] = useState<'accept' | 'return' | null>(null);
  const [sheet, setSheet] = useState(false);
  const [note, setNote] = useState('');
  const sending = useRef(false);

  useEffect(() => {
    if (view === null && live !== null) setView({ kind: 'pending', shown: live, conflict: false });
    // The proposal vanished while we looked at it and nothing is in flight: it was answered at the Mac.
    if (live === null && remote?.snapshot && view?.kind === 'pending' && !sending.current) setView({ kind: 'gone' });
  }, [live, remote?.snapshot, view]);

  const done = view?.kind === 'accepted' || view?.kind === 'returned';
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => router.back(), 1000);
    return () => clearTimeout(t);
  }, [done, router]);

  const online = supervisor?.state === 'ready';
  const shown: Proposal | null = view?.kind === 'pending' || view?.kind === 'unconfirmed' ? view.shown : null;

  const send = async (action: 'accept' | 'return') => {
    if (!client || !shown || sending.current) return;
    sending.current = true;
    setBusy(action);
    try {
      const res = await submitDecision(client, approve, { projectPath, workId, roomId, shown, action, note: action === 'return' ? note : undefined });
      if (res.kind === 'cancelled') toast.show(FACE_ID_CANCELLED);
      else if (res.kind === 'rejected') toast.show(res.message);
      else {
        setView(res.view);
        if (res.view.kind !== 'pending') setSheet(false);
      }
    } finally {
      sending.current = false;
      setBusy(null);
    }
  };

  const title = shown?.kind === 'completion' ? 'Completion' : 'Decision';
  const canAct = view?.kind === 'pending' && online && busy === null;

  return (
    <View style={[styles.page, { backgroundColor: colors.bg }]}>
      <ConnectionBanner />
      <ScrollView contentContainerStyle={styles.body}>
        <Text accessibilityRole="header" allowFontScaling style={[typography.largeTitle, { color: colors.label }]}>
          {done ? '' : title}
        </Text>
        {room && work ? (
          <Text allowFontScaling style={[typography.subheadline, { color: colors.label2 }]}>
            {room.title} · {work.title}
          </Text>
        ) : null}
        {view === null || remote?.snapshot == null ? <ActivityIndicator /> : null}
        {view?.kind === 'pending' && view.conflict ? (
          <View style={[styles.banner, { backgroundColor: colors.warningBg }]}>
            <SymbolView name="exclamationmark.arrow.triangle.2.circlepath" tintColor={colors.needsYou} size={20} />
            <Text allowFontScaling style={[typography.subheadline, { color: colors.label, flex: 1 }]}>
              The lead changed the decision — review the new text
            </Text>
          </View>
        ) : null}
        {shown ? (
          <>
            <Text allowFontScaling style={[typography.caption1, { color: colors.label2 }]}>
              {shown.planId ? `${shown.planId} · ` : ''}
              <Text style={view?.kind === 'pending' && view.conflict ? { color: colors.needsYou, fontWeight: '700' } : undefined}>rev {shown.rev}</Text> · from {shown.from}
            </Text>
            <View style={[styles.card, { backgroundColor: colors.surface }]}>
              <Markdown text={shown.text} />
            </View>
          </>
        ) : null}
        {view?.kind === 'unconfirmed' ? (
          <Text allowFontScaling style={[typography.subheadline, { color: colors.needsYou }]}>
            We couldn't confirm your answer
          </Text>
        ) : null}
        {view?.kind === 'gone' ? (
          <Text allowFontScaling style={[typography.body, { color: colors.label2 }]}>
            {live === null ? 'This decision was answered at your Mac' : 'This decision is no longer pending'}
          </Text>
        ) : null}
        {done ? (
          <View style={styles.result}>
            <SymbolView name={view.kind === 'accepted' ? 'checkmark.seal.fill' : 'arrow.uturn.backward.circle'} tintColor={colors.success} size={64} />
            <Text allowFontScaling style={[typography.title3, { color: colors.label }]}>
              {view.kind === 'accepted' ? 'Accepted' : 'Returned for rework'}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {shown ? (
        <View style={[styles.bar, { backgroundColor: colors.surface, borderTopColor: colors.separator }]}>
          <Pressable
            accessibilityRole="button"
            disabled={!canAct}
            onPress={() => setSheet(true)}
            style={[styles.btn, { borderColor: colors.tint, opacity: canAct ? 1 : 0.4 }]}
          >
            <Text allowFontScaling style={[typography.button, { color: colors.tint }]}>Return for rework</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!canAct}
            onPress={() => void send('accept')}
            style={[styles.btn, { backgroundColor: colors.tint, borderColor: colors.tint, opacity: canAct ? 1 : 0.4 }]}
          >
            {busy === 'accept' ? (
              <ActivityIndicator color={colors.onTint} />
            ) : (
              <>
                <SymbolView name="faceid" tintColor={colors.onTint} size={18} />
                <Text allowFontScaling style={[typography.button, { color: colors.onTint }]}>Accept</Text>
              </>
            )}
          </Pressable>
        </View>
      ) : null}

      <Modal visible={sheet} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => void (busy === null && setSheet(false))}>
        <View style={[styles.page, { backgroundColor: colors.bg, padding: spacing.screenMargin, gap: 12 }]}>
          <View style={styles.sheetHead}>
            <Text accessibilityRole="header" allowFontScaling style={[typography.title3, { color: colors.label }]}>Return for rework</Text>
            <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => setSheet(false)}>
              <Text allowFontScaling style={[typography.body, { color: colors.tint }]}>Cancel</Text>
            </Pressable>
          </View>
          <TextInput
            autoFocus
            multiline
            value={note}
            onChangeText={setNote}
            placeholder="What should the lead change?"
            placeholderTextColor={colors.label3}
            style={[typography.body, styles.input, { backgroundColor: colors.surface, color: colors.label }]}
          />
          <Text allowFontScaling style={[typography.caption1, { color: note.length > RETURN_NOTE_MAX ? colors.danger : colors.label2, textAlign: 'right' }]}>
            {note.length} / {RETURN_NOTE_MAX}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={!canSendReturn(note) || !canAct}
            onPress={() => void send('return')}
            style={[styles.btn, { backgroundColor: colors.tint, borderColor: colors.tint, opacity: canSendReturn(note) && canAct ? 1 : 0.4 }]}
          >
            {busy === 'return' ? <ActivityIndicator color={colors.onTint} /> : <Text allowFontScaling style={[typography.button, { color: colors.onTint }]}>Send</Text>}
          </Pressable>
        </View>
      </Modal>
      <Toast message={toast.message} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { padding: spacing.screenMargin, gap: 8 },
  card: { borderRadius: spacing.cardRadius, padding: 16 },
  banner: { flexDirection: 'row', gap: 8, alignItems: 'center', padding: 12, borderRadius: spacing.nestedRadius },
  bar: { flexDirection: 'row', gap: 12, padding: spacing.screenMargin, borderTopWidth: StyleSheet.hairlineWidth },
  btn: { flex: 1, minHeight: spacing.decisionButtonHeight, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  result: { alignItems: 'center', gap: 12, paddingTop: 48 },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  input: { minHeight: 160, borderRadius: spacing.nestedRadius, padding: 12, textAlignVertical: 'top' },
});
