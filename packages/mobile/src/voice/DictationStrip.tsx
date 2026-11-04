// The recording strip above the field (A47, spec 3.2): language, level, timer and Cancel while this field dictates.
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { typography, useColors } from '../theme';
import { dictation } from './dictation';
import { formatElapsed } from './elapsed';
import { useDictationState } from './use-dictation-target';

function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

export function DictationStrip({ id }: { id: string }) {
  const c = useColors();
  const state = useDictationState();
  const elapsed = useElapsed(state.phase === 'recording' ? state.startedAt : null);
  if (state.targetId !== id || state.phase === 'idle') return null;
  const code = state.lang === null ? null : (state.lang.split(/[-_]/)[0] ?? '').toUpperCase();
  const time = formatElapsed(elapsed);
  const cancel = (
    <Pressable accessibilityRole="button" accessibilityLabel="Cancel dictation" onPress={() => dictation.cancel()} style={styles.cancel}>
      <Text allowFontScaling style={[typography.body, { color: c.tint }]}>Cancel</Text>
    </Pressable>
  );
  if (state.phase === 'recording') {
    return (
      <View
        accessible
        accessibilityLabel={`Dictating${state.lang === null ? '' : ` in ${state.lang}`}, ${time}`}
        style={styles.strip}
      >
        <View style={[styles.dot, { backgroundColor: c.danger }]} />
        <View style={[styles.track, { backgroundColor: c.separator }]}>
          <View style={[styles.fill, { backgroundColor: c.danger, width: `${Math.round(state.level * 100)}%` }]} />
        </View>
        {code !== null && <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>{code}</Text>}
        <Text allowFontScaling style={[typography.subheadline, styles.time, { color: c.label }]}>{time}</Text>
        <View style={styles.spacer} />
        {cancel}
      </View>
    );
  }
  const text = state.phase === 'starting' ? 'Starting…' : state.phase === 'transcribing' ? 'Transcribing…' : 'Stopping…';
  return (
    <View accessible accessibilityLabel={text} style={styles.strip}>
      <Text allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>{text}</Text>
      {state.phase === 'starting' && code !== null && <Text allowFontScaling style={[typography.caption1, { color: c.label2 }]}>{code}</Text>}
      <View style={styles.spacer} />
      {state.phase === 'starting' && cancel}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  track: { width: 40, height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  time: { fontVariant: ['tabular-nums'] },
  spacer: { flex: 1 },
  cancel: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
});
