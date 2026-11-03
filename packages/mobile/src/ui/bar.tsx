// Plain navigation-bar buttons (plan A35a, D1 §17.4). On iOS 26+ every bar item sits in a grey Liquid Glass capsule that
// `headerTintColor` does not remove. The native-stack items API can hide that shared background: a custom item with
// `hidesSharedBackground: true` draws only what we put in it, in the Parley accent. The back button is such an item too
// (`router.back()`); the stack keeps its own edge-swipe, which does not depend on the visible button.
import type { ComponentProps, ReactElement } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';
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
  symbol: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
