// Crypto bench for A20 item 16 (developer builds only: see `DEV_BUILD`). Runs the S2 cases on `@parley/noise` on this
// device and shares the JSON. Measure in the Release configuration of the dev variant (`scripts/device-run.sh`); a Debug
// number is not usable and the screen says so.
import { useCallback, useState } from 'react';
import { ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import * as Device from 'expo-device';
import { Redirect } from 'expo-router';
import { PrimaryButton, Row, Section } from '../components/ui';
import { runBench, type BenchReport, type BenchRow } from '../dev/bench';
import { DEV_BUILD } from '../dev/build';
import { typography, useColors, voicePalette } from '../theme';
import { Orb } from '../voice/orb/Orb';
import { STATES } from '../voice/orb/orb-spec';

const fmt = (ms: number) => (ms < 1 ? ms.toFixed(3) : ms.toFixed(1)) + ' ms';
const hermes = (globalThis as { HermesInternal?: unknown }).HermesInternal !== undefined;

export default function Bench() {
  const colors = useColors();
  const [rows, setRows] = useState<BenchRow[]>([]);
  const [report, setReport] = useState<BenchReport | null>(null);
  const [running, setRunning] = useState(false);
  const run = useCallback(async () => {
    setRunning(true);
    setRows([]);
    setReport(null);
    const device = {
      model: Device.modelName,
      modelId: Device.modelId,
      os: `${Device.osName} ${Device.osVersion}`,
      hermes,
      dev: __DEV__,
    };
    const done = await runBench(
      { runs: 20, warmup: 3, now: () => performance.now() },
      device,
      (r) => setRows((prev) => [...prev, r]),
      () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    );
    setReport(done);
    setRunning(false);
  }, []);
  if (!DEV_BUILD) return <Redirect href="/" />;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: colors.bg }} contentContainerStyle={styles.content}>
      <Text style={[typography.footnote, { color: __DEV__ || !hermes ? colors.danger : colors.label2, marginHorizontal: 16 }]}>
        {__DEV__ ? 'DEBUG BUILD: these numbers are not usable, rebuild with scripts/device-run.sh' : 'Release'} · {hermes ? 'Hermes' : 'not Hermes'} ·{' '}
        {Device.modelName ?? '?'} · keep the phone on the charger, Low Power Mode off, screen on
      </Text>
      <View style={{ marginHorizontal: 16 }}>
        <PrimaryButton title={running ? 'Running…' : 'Run (20 runs per case)'} disabled={running} onPress={() => void run()} />
      </View>
      <Section header="Orb · 10 states" footer="Parley voice orb at 168 px and 32 px (mini, d ≤ 48). Reduced motion follows the system setting.">
        <View style={[styles.orbs, { backgroundColor: voicePalette.bg }]}>
          {STATES.map((s) => (
            <View key={s.n} style={styles.orbCell}>
              <Orb state={s.n} size={168} level={s.id === 'speaking' || s.id === 'listening' || s.id === 'recording' ? 0.5 : undefined} />
              <Orb state={s.n} size={32} />
              <Text style={[typography.caption1, { color: voicePalette.text2 }]}>{s.n} {s.id}</Text>
            </View>
          ))}
        </View>
      </Section>
      <Section header="Median (min–max)">
        {rows.map((r, i) => (
          <Row key={r.id} title={r.label} value={`${fmt(r.median)} (${fmt(r.min)}–${fmt(r.max)})`} mono last={i === rows.length - 1} />
        ))}
      </Section>
      {report && (
        <>
          <Section header="A20 item 16" footer="Thresholds of the S7 verdict: one IK side ≤ 150 ms, ChaCha20-Poly1305 64 KiB ≤ 50 ms.">
            <Row title="IK, one side (worse of two)" value={fmt(report.verdict.ikOneSideMs)} mono />
            <Row title="ChaCha20-Poly1305 64 KiB (worse of two)" value={fmt(report.verdict.chacha64KiBMs)} mono />
            <Row title="Verdict" value={report.verdict.ok ? 'within thresholds' : 'OVER A THRESHOLD'} last />
          </Section>
          <View style={{ marginHorizontal: 16 }}>
            <PrimaryButton title="Share JSON" onPress={() => void Share.share({ message: JSON.stringify(report, null, 2) })} />
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 120, gap: 20, paddingTop: 12 },
  orbs: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 28, paddingVertical: 36, paddingHorizontal: 16 },
  orbCell: { alignItems: 'center', gap: 12 },
});
