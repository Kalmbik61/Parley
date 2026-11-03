// "Continue on another provider…" sheet (D1 §9.1, plan A38b): targets from `sessions.switchOptions` (unavailable ones
// greyed with the reason), what the session keeps, how the context goes over, Continue. Blockers: their text, no button.
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { sessionKey, type RemoteClient, type SessionRef, type SwitchOptions } from '@parley/remote-client';
import { touchAppLock } from '../auth/lock-instance';
import { DEMO } from '../dev/flags';
import { demoSwitchOptions } from '../dev/demo-switch';
import { spacing, typography, useColors } from '../theme';
import { Button } from '../ui/Button';
import { hostLine } from './session-menu';
import { canContinue, CARRY_TITLE, carryChoices, currentLine, defaultTarget, forgetLost, keepsLines, newAttempt, NO_TARGETS, recallLost, rememberLost, switchParams, switchStep, targetNote, UNCONFIRMED_LINE, type Carry, type SwitchAttempt, type Target } from './switch-model';

export function SwitchSheet({ client, sessionRef, label, roomTitle, providerLabel, canAct, onClose, onDone, onToast }: { client: RemoteClient | null; sessionRef: SessionRef; label: string; roomTitle(id: string): string; providerLabel(id: string): string | null; canAct: boolean; onClose(): void; onDone(text: string): void; onToast(text: string): void }) {
  const c = useColors();
  const [options, setOptions] = useState<SwitchOptions | null>(DEMO ? demoSwitchOptions : null);
  const [error, setError] = useState<string | null>(null);
  const key = sessionKey(sessionRef);
  // A call that got no answer outlives the sheet: its target and carry stay frozen and "Try again" repeats the same request.
  const recalled = useRef(recallLost(key));
  const [provider, setProvider] = useState<string | null>(recalled.current?.target.id ?? (DEMO ? defaultTarget(demoSwitchOptions) : null));
  const [carry, setCarry] = useState<Carry>(recalled.current?.carry ?? 'handover');
  const [busy, setBusy] = useState(false);
  const attempt = useRef<SwitchAttempt>(recalled.current?.attempt ?? newAttempt());
  const [lost, setLost] = useState(recalled.current !== undefined);
  const [reason, setReason] = useState<string | null>(recalled.current?.line ?? null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true; // Fast Refresh re-runs the effect after its cleanup
    return () => void (mounted.current = false);
  }, []);
  const frozenTarget = useRef<Target | undefined>(recalled.current?.target);

  useEffect(() => {
    if (DEMO || client === null) return;
    let stale = false;
    void client.switchOptions(sessionRef).then((res) => {
      if (stale) return;
      if (res.outcome === 'ok') {
        setOptions(res.options);
        if (recalled.current === undefined) setProvider(defaultTarget(res.options));
      } else setError(res.outcome === 'lost' ? "We couldn't load the providers — check your Mac" : hostLine(res));
    });
    return () => {
      stale = true;
    };
  }, [client, sessionRef.projectPath, sessionRef.workId, sessionRef.sessionId]);

  const target = frozenTarget.current ?? options?.targets.find((t) => t.id === provider);
  const choices = carryChoices(target);
  const ok = options !== null && canContinue(options, target);
  const go = async (): Promise<void> => {
    if (client === null || target === undefined || busy || !canAct) return;
    setBusy(true);
    const id = attempt.current.requestId;
    frozenTarget.current = target;
    // The attempt is on record BEFORE the call: closing the sheet mid-call and reopening shows it frozen, same id.
    rememberLost(key, { attempt: { ...attempt.current, lost: true }, line: UNCONFIRMED_LINE, target, carry });
    const outcome = await client.switchAgent(switchParams(sessionRef, id, target, carry));
    const step = switchStep(attempt.current, outcome, target);
    if (step.close) {
      // A definite answer ends the attempt. A late one reaches the person as a toast, and never closes a newer sheet.
      if (recallLost(key)?.attempt.requestId === id) forgetLost(key);
      attempt.current = step.attempt;
      if (mounted.current) onDone(step.toast ?? '');
      else onToast(step.toast ?? '');
      return;
    }
    if (recallLost(key)?.attempt.requestId === id) rememberLost(key, { attempt: step.attempt, line: step.line ?? UNCONFIRMED_LINE, target, carry });
    attempt.current = step.attempt;
    if (mounted.current) {
      setBusy(false);
      setLost(true);
      setReason(step.line);
    }
  };

  return (
    // A touch in the sheet restarts the idle term of the app lock (plan A35b).
    <View onTouchStart={touchAppLock} style={[styles.page, { backgroundColor: c.bg }]}>
      <View style={styles.head}>
        <Text accessibilityRole="header" allowFontScaling numberOfLines={1} style={[typography.headline, styles.flex, { color: c.label }]}>
          Continue on another provider
        </Text>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.bar}>
          <Text allowFontScaling style={[typography.body, { color: c.tint }]}>Cancel</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <Text allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>
          {label} continues with another agent in the same place.
        </Text>
        {error !== null ? (
          <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, { color: c.needsYou }]}>{error}</Text>
        ) : options === null ? (
          <ActivityIndicator color={c.label2} />
        ) : (
          <>
            <Text allowFontScaling style={[typography.footnote, { color: c.label2 }]}>{currentLine(options.current, providerLabel)}</Text>
            {options.targets.length === 0 && <Text allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>{NO_TARGETS}</Text>}
            {options.targets.length > 0 && (
            <View style={[styles.box, { backgroundColor: c.surface }]}>
              {(lost && frozenTarget.current !== undefined ? [frozenTarget.current] : options.targets).map((t, i) => {
                const note = targetNote(t);
                const on = t.id === provider;
                return (
                  <Pressable
                    key={t.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on, disabled: !t.available }}
                    disabled={!t.available || busy || lost}
                    onPress={() => {
                      setProvider(t.id);
                      setCarry('handover');
                    }}
                    style={[styles.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.separator }, { opacity: t.available ? 1 : 0.45 }]}
                  >
                    <View style={styles.flex}>
                      <Text allowFontScaling style={[typography.body, { color: c.label }]}>{t.label}</Text>
                      {note !== null && (
                        <Text allowFontScaling style={[typography.footnote, { color: t.available ? c.label2 : c.needsYou }]}>{note}</Text>
                      )}
                    </View>
                    {on && <SymbolView name="checkmark" size={16} tintColor={c.tint} />}
                  </Pressable>
                );
              })}
            </View>
            )}
            {choices.length > 1 && (
              <View style={[styles.box, { backgroundColor: c.surface }]}>
                {choices.map((k, i) => (
                  <Pressable key={k} accessibilityRole="radio" accessibilityState={{ selected: carry === k }} disabled={busy || lost} onPress={() => setCarry(k)} style={[styles.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.separator }]}>
                    <Text allowFontScaling style={[typography.body, styles.flex, { color: c.label }]}>{CARRY_TITLE[k]}</Text>
                    {carry === k && <SymbolView name="checkmark" size={16} tintColor={c.tint} />}
                  </Pressable>
                ))}
              </View>
            )}
            {keepsLines(options.keeps, roomTitle).length > 0 && (
              <View style={styles.keeps}>
                <Text allowFontScaling style={[typography.footnote, { color: c.label2 }]}>THE SESSION KEEPS</Text>
                <Text allowFontScaling style={[typography.subheadline, { color: c.label }]}>{keepsLines(options.keeps, roomTitle).join(' · ')}</Text>
              </View>
            )}
            {options.blockers.map((b) => (
              <View key={b} style={styles.blocker}>
                <SymbolView name="exclamationmark.triangle" size={16} tintColor={c.needsYou} />
                <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, styles.flex, { color: c.label }]}>{b}</Text>
              </View>
            ))}
            {lost && <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, { color: c.needsYou }]}>{reason ?? UNCONFIRMED_LINE}</Text>}
            {options.blockers.length === 0 && options.targets.length > 0 && <Button title={lost ? 'Try again' : 'Continue'} variant="prominent" loading={busy} disabled={(!ok && !lost) || !canAct} onPress={() => void go()} />}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  flex: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12 },
  bar: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 16 },
  box: { borderRadius: spacing.cardRadius, paddingHorizontal: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 56, paddingVertical: 8 },
  keeps: { gap: 4 },
  blocker: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
});
