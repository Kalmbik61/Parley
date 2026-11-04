// Dictation check (A47 spec 4.4, developer builds only): proves on an iPhone that the library patch refuses a language without
// on-device recognition instead of falling back to Apple's servers. Watch that the orange microphone dot stays off.
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { getLocales } from 'expo-localization';
import { Redirect } from 'expo-router';
import { PrimaryButton, Section } from '../components/ui';
import { DEV_BUILD } from '../dev/build';
import { typography, useColors } from '../theme';
import { dictation } from '../voice/dictation';
import { engine } from '../voice/engine';
import { runGuardCheck, type CheckVerdict } from '../voice/guard-check';
import { createLanguageChooser } from '../voice/language';
import { useDictationState } from '../voice/use-dictation-target';

const VERDICT: Record<CheckVerdict, string> = {
  pass: 'PASS',
  fail: 'FAIL: recognition started',
  'no-pass': 'No PASS',
  'no-language': 'No language without on-device recognition',
};

export default function DictationCheck() {
  const colors = useColors();
  const state = useDictationState();
  const [lines, setLines] = useState<string[]>([]);
  const [verdict, setVerdict] = useState<CheckVerdict | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const chooseDeviceLanguage = () => createLanguageChooser(engine, () => getLocales()[0]?.languageTag ?? 'en-US')({ useKeyboard: false, focused: false });
  // The selected language is shown when the screen opens (spec 4.4); it needs no permission.
  useEffect(() => {
    if (!DEV_BUILD) return;
    void chooseDeviceLanguage().then((choice) => setChosen(`${choice.lang} · on-device recognition: ${choice.ok ? 'yes' : 'no'}`), () => undefined);
  }, []);
  if (!DEV_BUILD) return <Redirect href="/" />;
  const idle = state.phase === 'idle';

  const run = async (): Promise<void> => {
    if (!idle || running) return;
    setRunning(true);
    setLines([]);
    setVerdict(null);
    setReason(null);
    // The library's events are global: the store must not take this start for its own.
    dictation.suspend();
    try {
      const report = await runGuardCheck(engine, (line) => setLines((l) => [...l, line]));
      setVerdict(report.verdict);
      setReason(report.reason ?? null);
    } finally {
      dictation.resume();
      setRunning(false);
    }
  };

  const color = verdict === 'pass' ? colors.success : verdict === null ? colors.label : colors.danger;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: colors.bg }} contentContainerStyle={styles.content}>
      <Section header="Selected language" footer="Offline, iOS refuses a server-only language before Parley's guard runs, so the check would prove nothing.">
        <Text allowFontScaling selectable style={[typography.body, styles.pad, { color: colors.label }]}>{chosen ?? '…'}</Text>
      </Section>
      <View style={styles.pad}>
        <PrimaryButton title="Try a language without on-device recognition" disabled={!idle || running} onPress={() => void run()} />
      </View>
      {verdict !== null && (
        <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.headline, styles.pad, { color }]}>{VERDICT[verdict]}{reason === null ? '' : `: ${reason}`}</Text>
      )}
      <Section header="Events">
        <Text allowFontScaling selectable style={[typography.footnote, styles.pad, { color: colors.label2, fontVariant: ['tabular-nums'] }]}>
          {lines.length === 0 ? 'None yet' : lines.join('\n')}
        </Text>
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({ content: { paddingBottom: 120, gap: 16 }, pad: { marginHorizontal: 16, paddingVertical: 8 } });
