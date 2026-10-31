import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { spacing, typography, useColors } from '../theme';

export interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: 'bordered' | 'prominent' | 'plain';
  loading?: boolean;
  disabled?: boolean;
  /** Leading symbol, e.g. `faceid` on approvals that need Face ID. */
  icon?: SFSymbol;
  hint?: string;
  flex?: boolean;
}

/** D1 §17.3: 50 pt decision buttons, 44 pt minimum touch target. */
export function Button({ title, onPress, variant = 'bordered', loading = false, disabled = false, icon, hint, flex }: ButtonProps) {
  const c = useColors();
  const prominent = variant === 'prominent';
  const fg = prominent ? c.onTint : c.tint;
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={hint}
      accessibilityState={{ disabled: off, busy: loading }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        flex === true && styles.flex,
        variant === 'plain' ? styles.plain : { backgroundColor: prominent ? c.tint : c.neutralBg },
        { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.row}>
          {icon !== undefined && <SymbolView name={icon} size={18} tintColor={fg} />}
          <Text allowFontScaling style={[typography.button, { color: fg }]} numberOfLines={2}>
            {title}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: spacing.decisionButtonHeight, borderRadius: 12, paddingHorizontal: 16, justifyContent: 'center', alignItems: 'center' },
  flex: { flex: 1 },
  plain: { backgroundColor: 'transparent', minHeight: spacing.minTouchTarget },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
