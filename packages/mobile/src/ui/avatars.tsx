// Who is who on every screen (D1 §8.2, plan A33): a session is a round avatar with the provider's mark; a room is a `#`
// and its title in a container (drawn by the callers). The provider's SVG mark needs a native SVG renderer the app does
// not carry, so the avatar is the brand colour with the provider's initial — the same slot, the same size.
import { StyleSheet, Text, View } from 'react-native';
import { typography, useColors } from '../theme';
import { brandOf } from './brand';

export function ProviderAvatar({ provider, size = 24, badge }: { provider: string; size?: number; badge?: React.ReactNode }) {
  const c = useColors();
  const b = brandOf(provider);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
      <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: b.bg ?? c.surface2 }]}>
        <Text style={[typography.caption2, { color: b.fg ?? c.label2, fontSize: Math.round(size * 0.46), lineHeight: Math.round(size * 0.56) }]}>{b.mark}</Text>
      </View>
      {badge !== undefined && <View style={[styles.badge, { backgroundColor: c.surface }]}>{badge}</View>}
    </View>
  );
}

/** A letter of an agent in the room history: the first letter of the name on the accent (the window's `SenderAvatar`). */
export function SenderAvatar({ name, size = 28 }: { name: string; size?: number }) {
  const c = useColors();
  return (
    <View accessibilityElementsHidden style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: c.tint }]}>
      <Text style={[typography.caption2, { color: c.onTint, fontSize: Math.round(size * 0.46) }]}>{(name.trim().slice(0, 1) || '?').toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', right: -3, bottom: -3, borderRadius: 8, padding: 1 },
});
