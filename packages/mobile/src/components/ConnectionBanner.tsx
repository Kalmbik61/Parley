import { useEffect, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, LayoutAnimation, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { runtime } from '../runtime/instance';
import { useRuntimeState } from '../runtime/use-runtime';
import { typography, useColors } from '../theme';
import { bannerFor, type Banner, type BannerAction } from './banner-model';

const LABELS: Record<BannerAction, string> = { retry: 'Retry', 'pair-again': 'Pair again', remove: 'Remove' };

/** Re-evaluates every second while a banner with a clock (`Last updated…`, `Retrying in…`) could be on screen. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** One line under the navigation bar (D1 §4). A14 wires "Pair again"/"Remove" and the tap to Diagnostics. */
export function ConnectionBanner({ onAction }: { onAction?: (action: BannerAction) => void }) {
  const colors = useColors();
  const state = useRuntimeState();
  const now = useNow(state.supervisor !== null);
  const banner = bannerFor({
    supervisor: state.supervisor,
    hostStatus: state.client?.store.getState().hostStatus ?? null,
    hasSnapshot: state.lastUpdatedAt !== null,
    lastUpdatedAt: state.lastUpdatedAt,
    waitingSince: state.waitingSince,
    relay: state.host?.relay ?? null,
    now,
  });

  // The "Updating…" banner waits 1.5 s so a short reconnect does not flash it.
  const kind = banner?.kind ?? null;
  const delayMs = banner?.delayMs ?? 0;
  const [shownKind, setShownKind] = useState<Banner['kind'] | null>(null);
  useEffect(() => {
    if (kind === null) return setShownKind(null);
    if (delayMs === 0) return setShownKind(kind);
    const t = setTimeout(() => setShownKind(kind), delayMs);
    return () => clearTimeout(t);
  }, [kind, delayMs]);

  const visible = banner !== null && shownKind === banner.kind;
  useEffect(() => {
    LayoutAnimation.configureNext(LayoutAnimation.create(250, 'spring', 'opacity'));
  }, [visible]);
  useEffect(() => {
    if (visible && banner !== null) AccessibilityInfo.announceForAccessibility(banner.text);
    // Announce on kind change only (D1 §18).
  }, [visible, kind]);

  if (!visible || banner === null) return null;
  const onPress = (a: BannerAction): void => {
    if (a === 'retry') runtime.retry();
    onAction?.(a);
  };
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.bar, { backgroundColor: banner.tone === 'warning' ? colors.warningBg : colors.neutralBg }]}
    >
      <View style={styles.icon}>
        {banner.icon === 'progress' ? (
          <ActivityIndicator />
        ) : (
          <SymbolView name={banner.icon} size={18} tintColor={colors.label} />
        )}
      </View>
      <View style={styles.texts}>
        <Text allowFontScaling style={[typography.subheadline, { color: colors.label }]}>
          {banner.text}
        </Text>
        {banner.detail !== null && (
          <Text allowFontScaling style={[typography.caption1, { color: colors.label2 }]}>
            {banner.detail}
          </Text>
        )}
      </View>
      {banner.actions.map((a) => (
        <Pressable key={a} accessibilityRole="button" onPress={() => onPress(a)} style={styles.action}>
          <Text allowFontScaling style={[typography.subheadline, { color: colors.tint, fontWeight: '600' }]}>
            {LABELS[a]}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, gap: 12 },
  icon: { width: 24, alignItems: 'center' },
  texts: { flex: 1, gap: 2 },
  action: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
});
