import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import type { Attention } from '@parley/core/attention';
import type { Capsule, CapsuleTone } from '../cards/status';
import { spacing, typography, useColors, type Colors } from '../theme';

export const toneColor = (c: Colors, tone: CapsuleTone): string =>
  ({ needsYou: c.needsYou, working: c.working, idle: c.idle, success: c.success, danger: c.danger, off: c.off })[tone];

export const attentionColor = (c: Colors, a: Attention): string =>
  ({ 'needs-you': c.needsYou, unseen: c.tint, working: c.working, idle: c.idle, off: c.off })[a];

export const attentionWord = (a: Attention): string =>
  ({ 'needs-you': 'Needs you', unseen: 'Finished a turn', working: 'Working', idle: 'Idle', off: 'Closed' })[a];

/** State dot. Never the only carrier of meaning: rows add a word or symbol (D1 §1.4). */
export function Dot({ color, ring }: { color: string; ring?: boolean }) {
  return (
    <View
      accessible={false}
      style={{
        width: spacing.statusDot,
        height: spacing.statusDot,
        borderRadius: spacing.statusDot / 2,
        backgroundColor: ring === true ? 'transparent' : color,
        borderWidth: ring === true ? 2 : 0,
        borderColor: color,
      }}
    />
  );
}

/** Orange pill with a count ("waiting for you"). */
export function CountPill({ n }: { n: number }) {
  const c = useColors();
  if (n <= 0) return null;
  return (
    <View accessibilityLabel={`${n} waiting for you`} style={[styles.pill, { backgroundColor: c.needsYou }]}>
      <Text allowFontScaling style={[typography.caption2, { color: '#fff' }]}>
        {n}
      </Text>
    </View>
  );
}

export function StatusCapsule({ capsule }: { capsule: Capsule }) {
  const c = useColors();
  const color = toneColor(c, capsule.tone);
  return (
    <View accessible accessibilityLabel={`${capsule.label}${capsule.detail === null ? '' : `. ${capsule.detail}`}`} style={[styles.capsule, { backgroundColor: c.surface }]}>
      <SymbolView name={capsule.icon as SFSymbol} size={22} tintColor={color} />
      <View style={styles.flex}>
        <Text allowFontScaling style={[typography.headline, { color }]}>
          {capsule.label}
        </Text>
        {capsule.detail !== null && (
          <Text allowFontScaling style={[typography.subheadline, { color: c.label2 }]}>
            {capsule.detail}
          </Text>
        )}
      </View>
    </View>
  );
}

export function SectionHeader({ children }: { children: ReactNode }) {
  const c = useColors();
  return (
    <Text accessibilityRole="header" allowFontScaling style={[typography.footnote, styles.section, { color: c.label2 }]}>
      {typeof children === 'string' ? children.toUpperCase() : children}
    </Text>
  );
}

export function EmptyState({ icon, title, text }: { icon: SFSymbol; title: string; text?: string }) {
  const c = useColors();
  return (
    <View style={styles.empty}>
      <SymbolView name={icon} size={48} tintColor={c.label3} />
      <Text allowFontScaling style={[typography.title3, { color: c.label, textAlign: 'center' }]}>
        {title}
      </Text>
      {text !== undefined && (
        <Text allowFontScaling style={[typography.subheadline, { color: c.label2, textAlign: 'center' }]}>
          {text}
        </Text>
      )}
    </View>
  );
}

/** Three grey placeholders; pulses 0.4↔0.7 over 1.2 s unless Reduce Motion (the pulse is skipped by `reduce`). */
export function Skeleton({ rows = 3, reduce = false }: { rows?: number; reduce?: boolean }) {
  const c = useColors();
  const v = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.7, duration: 600, useNativeDriver: true }),
        Animated.timing(v, { toValue: 0.4, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, v]);
  return (
    <View accessibilityLabel="Loading" style={{ gap: spacing.cardGap }}>
      {Array.from({ length: rows }, (_, i) => (
        <Animated.View key={i} style={{ height: 96, borderRadius: spacing.cardRadius, backgroundColor: c.surface, opacity: reduce ? 0.5 : v }} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pill: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  capsule: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: spacing.cardRadius },
  section: { marginTop: 20, marginBottom: 6, marginLeft: 4 },
  empty: { alignItems: 'center', gap: 8, paddingTop: 80, paddingHorizontal: 32 },
});
