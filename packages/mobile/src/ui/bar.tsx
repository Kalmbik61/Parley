// Plain navigation-bar buttons (plan A35a, D1 §17.4). On iOS 26+ every bar item sits in a grey Liquid Glass capsule that
// `headerTintColor` does not remove. The native-stack items API can hide that shared background: a custom item with
// `hidesSharedBackground: true` draws only what we put in it, in the Parley accent. The back button is such an item too
// (`router.back()`); the stack keeps its own edge-swipe, which does not depend on the visible button.
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { useRouter } from 'expo-router';
// The copy of @react-navigation/elements that expo-router bundles (its public `react-navigation` entry).
import { useHeaderHeight } from 'expo-router/react-navigation';
import { SymbolView } from 'expo-symbols';
import { typography, useColors } from '../theme';

/** Right-hand items without the capsule, in the order they are given (left to right). */
export function barRight(...items: Array<ReactElement | null>) {
  const shown = items.filter((x): x is ReactElement => x !== null);
  return { unstable_headerRightItems: () => shown.map((element) => ({ type: 'custom' as const, element, hidesSharedBackground: true })) };
}

/** "‹ Title" in the accent, calling `router.back()`. A `title` of `null` is the chevron alone. */
export function BackButton({ title }: { title: string | null }) {
  const c = useColors();
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title === null ? 'Back' : `Back to ${title}`}
      hitSlop={8}
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      style={styles.back}
    >
      <SymbolView name="chevron.backward" size={19} weight="semibold" tintColor={c.tint} />
      {title !== null && (
        <Text numberOfLines={1} allowFontScaling style={[typography.body, { color: c.tint, maxWidth: 140 }]}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

/** The back button as a bar item. `headerBackVisible: false` hides the native one (and its capsule). */
export function barBack(title: string | null = null) {
  return {
    headerBackVisible: false,
    unstable_headerLeftItems: () => [{ type: 'custom' as const, element: <BackButton title={title} />, hidesSharedBackground: true }],
  };
}

/** A text action on the left ("Cancel", "Later") without the capsule. */
export function barLeftText(label: string, onPress: () => void) {
  return {
    headerBackVisible: false,
    unstable_headerLeftItems: () => [{ type: 'custom' as const, element: <TextButton label={label} onPress={onPress} />, hidesSharedBackground: true }],
  };
}

function TextButton({ label, onPress }: { label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="button" hitSlop={8} onPress={onPress} style={styles.text}>
      <Text allowFontScaling style={[typography.body, { color: c.tint }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The large title drawn inside the scroll content (as Inbox and Works do) instead of the native `headerLargeTitle`
 * (plan A39): the native one is laid out by the bar and adjusted into the scroll view's inset separately, so on a back
 * navigation it showed at once and overlapped the content. Pair it with `headerTitle: ''` on the screen.
 */
export function LargeTitle({ children, padded = true }: { children: string; padded?: boolean }) {
  const c = useColors();
  return (
    <Text accessibilityRole="header" allowFontScaling numberOfLines={2} style={[typography.largeTitle, styles.large, !padded && { paddingHorizontal: 0 }, { color: c.label }]}>
      {children}
    </Text>
  );
}

/** A round symbol button (the "•••", the "+"): 44 pt target, accent, no capsule. */
export function BarSymbol({ name, label, onPress, disabled = false }: { name: ComponentProps<typeof SymbolView>['name']; label: string; onPress: () => void; disabled?: boolean }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} hitSlop={8} onPress={onPress} style={[styles.symbol, { opacity: disabled ? 0.4 : 1 }]}>
      <SymbolView name={name} size={22} tintColor={c.tint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, minWidth: 44, paddingRight: 4 },
  text: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  strip: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8, minHeight: 44 },
  stripText: { flex: 1, fontWeight: '600' },
  stripLine: { position: 'absolute', left: 16, right: 16, bottom: 0, height: StyleSheet.hairlineWidth },
  large: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  symbol: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});

/**
 * Bar material by theme (D1 §17.5). iOS 26+: transparent header with NO blur effect — the system glass follows the theme.
 * iOS 17–25: the chrome material of the current theme. A fixed `systemChromeMaterial` was the light bar in dark mode.
 */
export function useBarMaterial() {
  const dark = useColorScheme() === 'dark';
  const modern = Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26;
  return {
    headerTransparent: Platform.OS === 'ios',
    ...(modern ? {} : { headerBlurEffect: dark ? ('systemChromeMaterialDark' as const) : ('systemChromeMaterialLight' as const) }),
  };
}

/**
 * The waiting strip as the bar's second row (D1 §17.5): the solid bar colour (an RN view does not blur, so a translucent one lets the feed text show through), no warning fill, a 0.5 pt separator inset 16, text in
 * `label` semibold, the icon in the state colour, and either a tint action ("Review ›") or a `barSubtitle` chevron.
 */
export function BarStrip({ icon, iconColor, text, action, onPress }: { icon: ComponentProps<typeof SymbolView>['name']; iconColor: string; text: string; action?: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action === undefined ? text : `${text}. ${action}`}
      onPress={onPress}
      style={[styles.strip, { backgroundColor: c.barBgSolid }]}
    >
      <SymbolView name={icon} size={16} tintColor={iconColor} />
      <Text numberOfLines={1} allowFontScaling style={[typography.subheadline, styles.stripText, { color: c.label }]}>
        {text}
      </Text>
      {action === undefined ? (
        <SymbolView name="chevron.right" size={12} weight="semibold" tintColor={c.barSubtitle} />
      ) : (
        <Text allowFontScaling style={[typography.subheadline, { color: c.tint, fontWeight: '600' }]}>{action} ›</Text>
      )}
      <View pointerEvents="none" style={[styles.stripLine, { backgroundColor: c.separator }]} />
    </Pressable>
  );
}

/**
 * The strips stacked under the bar, in the layout flow above the list: a spacer as tall as the transparent bar, then the
 * strips. The whole stack, the area under the bar included, has the solid bar colour, so bar and strips read as one bar
 * (D1 §9.1). The list starts below, so its first row is never covered, large text sizes grow the stack, and scrolled
 * content is clipped at the strip. `onChange` fires when the stack's height changes (a strip appeared or grew).
 */
export function BarStripStack({ onChange, children }: { onChange?: () => void; children: ReactNode }) {
  const c = useColors();
  const headerHeight = useHeaderHeight();
  return (
    <View style={{ paddingTop: headerHeight, backgroundColor: c.barBgSolid }} onLayout={onChange}>
      {children}
    </View>
  );
}
