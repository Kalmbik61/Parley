// The recording strip above the field (A47, spec 3.2): language, level, timer and Cancel while this field dictates.
import { useEffect, useState } from 'react';
import { PixelRatio, Pressable, StyleSheet, Text, View } from 'react-native';
import { typography, useColors } from '../theme';
import { dictation } from './dictation';
import { formatElapsed } from './elapsed';
import { useDictationState } from './use-dictation-target';

/** The left group (dot, bar, code, timer) keeps the level bar only when all of it fits: the texts grow with Dynamic Type. */
const levelMinWidth = (): number => 60 + 90 * PixelRatio.getFontScale();

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
  // The level bar is the first thing to go when the left group is short of room; Cancel never shrinks (it is the only way to discard).
  const [leftWidth, setLeftWidth] = useState(1000);
  const elapsed = useElapsed(state.phase === 'recording' ? state.startedAt : null);
  if (state.targetId !== id || state.phase === 'idle') return null;
  const code = state.lang === null ? null : (state.lang.split(/[-_]/)[0] ?? '').toUpperCase();
  const time = formatElapsed(elapsed);
  const cancel = (
    <Pressable accessibilityRole="button" accessibilityLabel="Cancel dictation" onPress={() => dictation.cancel()} style={styles.cancel}>
      <Text numberOfLines={1} allowFontScaling style={[typography.body, { color: c.tint }]}>Cancel</Text>
    </Pressable>
  );
  if (state.phase === 'recording') {
    return (
      <View
        accessible
        accessibilityLabel={`Dictating${state.lang === null ? '' : ` in ${state.lang}`}, ${time}`}
        style={styles.strip}
      >
        <View style={styles.left} onLayout={(e) => setLeftWidth(e.nativeEvent.layout.width)}>
          <View style={[styles.dot, { backgroundColor: c.danger }]} />
          {leftWidth >= levelMinWidth() && (
            <View style={[styles.track, { backgroundColor: c.separator }]}>
              <View style={[styles.fill, { backgroundColor: c.danger, width: `${Math.round(state.level * 100)}%` }]} />
            </View>
          )}
          {code !== null && <Text numberOfLines={1} allowFontScaling style={[typography.caption1, { color: c.label2 }]}>{code}</Text>}
          <Text allowFontScaling style={[typography.subheadline, styles.time, { color: c.label }]}>{time}</Text>
        </View>
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
  time: { fontVariant: ['tabular-nums'], flexShrink: 0 },
  spacer: { flex: 1 },
  left: { flex: 1, flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 8, overflow: 'hidden' },
  cancel: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, flexShrink: 0 },
});
