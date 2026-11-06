// Crypto bench for A20 item 16 (developer builds only: see `DEV_BUILD`). Runs the S2 cases on `@parley/noise` on this
// device and shares the JSON. Measure in the Release configuration of the dev variant (`scripts/device-run.sh`); a Debug
// number is not usable and the screen says so.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import * as Device from 'expo-device';
import { Redirect } from 'expo-router';
import { PrimaryButton, Row, Section } from '../components/ui';
import { runBench, type BenchReport, type BenchRow } from '../dev/bench';
import { DEV_BUILD } from '../dev/build';
import { typography, useColors, voicePalette } from '../theme';
import type { SwarmEmotion, SwarmLive } from '@parley/core/swarm';
import { createLevelSource, SILENT, type LevelSource } from '../voice/face/level-source';
import { SwarmFace } from '../voice/face/SwarmFace';
import { phoneSwarmSpec } from '../voice/face/phone-spec';

const fmt = (ms: number) => (ms < 1 ? ms.toFixed(3) : ms.toFixed(1)) + ' ms';
const IDLE: SwarmLive = { phase: 'idle', humanSpeaking: false, modelPlaying: false, checking: false, emotion: 'calm' };
const LIVE: SwarmLive = { ...IDLE, phase: 'live' };
const EMOTIONS: SwarmEmotion[] = ['calm', 'joy', 'sad', 'surprise', 'anger'];
// One sample per phone state; `level` marks the samples fed with a fake ~20 Hz loudness (see `useFakeLevel`).
const FACES: { name: string; link: 'online' | 'offline'; live: SwarmLive; level?: number }[] = [
  { name: 'online idle', link: 'online', live: IDLE },
  { name: 'connecting', link: 'online', live: { ...IDLE, phase: 'connecting' } },
  { name: 'listening', link: 'online', live: { ...LIVE, humanSpeaking: true }, level: 0.5 },
  ...EMOTIONS.map((emotion) => ({
    name: `model speaking · ${emotion}`,
    link: 'online' as const,
    live: { ...LIVE, modelPlaying: true, emotion },
    level: 0.5,
  })),
  { name: 'checking', link: 'online', live: { ...LIVE, checking: true } },
  { name: 'error', link: 'online', live: { ...LIVE, modelPlaying: true, emotion: 'error' }, level: 0.5 },
  { name: 'offline', link: 'offline', live: IDLE },
];
/** Stand-in for the getStats() loudness: a speech-like 0..1 signal at 20 Hz, delivered through a level source like the real one. */
function useFakeLevel(): LevelSource {
  const source = useMemo(createLevelSource, []);
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now() / 1000;
      source.set(Math.max(0, Math.min(1, 0.45 + 0.35 * Math.sin(t * 5.1) * Math.sin(t * 1.7) + 0.15 * Math.sin(t * 13))));
    }, 50);
    return () => clearInterval(id);
  }, [source]);
  return source;
}
const hermes = (globalThis as { HermesInternal?: unknown }).HermesInternal !== undefined;

export default function Bench() {
  const colors = useColors();
  const fakeLevel = useFakeLevel();
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
      <Section header="Swarm · phone states" footer="Island swarm sphere (700 souls, Skia) at 160 pt, one per phone state. Reduced motion follows the system setting.">
        <View style={[styles.orbs, { backgroundColor: voicePalette.bg }]}>
          {FACES.map((f) => (
            <View key={f.name} style={styles.orbCell}>
              <SwarmFace spec={phoneSwarmSpec({ link: f.link, live: f.live })} levelSource={f.level === undefined ? SILENT : fakeLevel} size={160} />
              <Text style={[typography.caption1, { color: voicePalette.text2 }]}>{f.name}</Text>
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
