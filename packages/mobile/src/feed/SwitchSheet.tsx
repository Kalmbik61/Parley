// "Continue on another provider…" sheet (D1 §9.1, plan A38b): targets from `sessions.switchOptions` (unavailable ones
// greyed with the reason), what the session keeps, how the context goes over, Continue. Blockers: their text, no button.
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { RemoteClient, SessionRef, SwitchOptions } from '@parley/remote-client';
import { touchAppLock } from '../auth/lock-instance';
import { DEMO } from '../dev/flags';
import { demoSwitchOptions } from '../dev/demo-switch';
import { spacing, typography, useColors } from '../theme';
import { Button } from '../ui/Button';
import { hostLine } from './session-menu';
import { canContinue, CARRY_TITLE, carryChoices, defaultTarget, keepsLines, newRequestId, switchParams, switchToast, targetNote, type Carry } from './switch-model';

export function SwitchSheet({ client, sessionRef, label, onClose, onDone }: { client: RemoteClient | null; sessionRef: SessionRef; label: string; onClose(): void; onDone(text: string): void }) {
  const c = useColors();
  const [options, setOptions] = useState<SwitchOptions | null>(DEMO ? demoSwitchOptions : null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(DEMO ? defaultTarget(demoSwitchOptions) : null);
  const [carry, setCarry] = useState<Carry>('handover');
  const [busy, setBusy] = useState(false);
  // One request id per opening of the sheet: a second tap sends the same request.
  const requestId = useRef(newRequestId());

  useEffect(() => {
    if (DEMO || client === null) return;
    let stale = false;
    void client.switchOptions(sessionRef).then((res) => {
      if (stale) return;
      if (res.outcome === 'ok') {
        setOptions(res.options);
        setProvider(defaultTarget(res.options));
      } else setError(res.outcome === 'lost' ? "We couldn't load the providers — check your Mac" : hostLine(res));
    });
    return () => {
      stale = true;
    };
  }, [client, sessionRef.projectPath, sessionRef.workId, sessionRef.sessionId]);

  const target = options?.targets.find((t) => t.id === provider);
  const choices = carryChoices(target);
  const ok = options !== null && canContinue(options, target);
  const go = async (): Promise<void> => {
    if (client === null || target === undefined || busy) return;
    setBusy(true);
    const outcome = await client.switchAgent(switchParams(sessionRef, requestId.current, target, carry));
    setBusy(false);
    onDone(switchToast(outcome, target));
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
            <View style={[styles.box, { backgroundColor: c.surface }]}>
              {options.targets.map((t, i) => {
                const note = targetNote(t);
                const on = t.id === provider;
                return (
                  <Pressable
                    key={t.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on, disabled: !t.available }}
                    disabled={!t.available || busy}
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
            {choices.length > 1 && (
              <View style={[styles.box, { backgroundColor: c.surface }]}>
                {choices.map((k, i) => (
                  <Pressable key={k} accessibilityRole="radio" accessibilityState={{ selected: carry === k }} disabled={busy} onPress={() => setCarry(k)} style={[styles.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.separator }]}>
                    <Text allowFontScaling style={[typography.body, styles.flex, { color: c.label }]}>{CARRY_TITLE[k]}</Text>
                    {carry === k && <SymbolView name="checkmark" size={16} tintColor={c.tint} />}
                  </Pressable>
                ))}
              </View>
            )}
            {keepsLines(options.keeps).length > 0 && (
              <View style={styles.keeps}>
                <Text allowFontScaling style={[typography.footnote, { color: c.label2 }]}>THE SESSION KEEPS</Text>
                <Text allowFontScaling style={[typography.subheadline, { color: c.label }]}>{keepsLines(options.keeps).join(' · ')}</Text>
              </View>
            )}
            {options.blockers.map((b) => (
              <View key={b} style={styles.blocker}>
                <SymbolView name="exclamationmark.triangle" size={16} tintColor={c.needsYou} />
                <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, styles.flex, { color: c.label }]}>{b}</Text>
              </View>
            ))}
            {options.blockers.length === 0 && <Button title="Continue" variant="prominent" loading={busy} disabled={!ok} onPress={() => void go()} />}
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
