// Small building blocks of the A14 screens: buttons and the grouped list of D1 §1 / §11.
import type { ComponentProps, ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { spacing, typography, useColors } from '../theme';

type SymbolName = ComponentProps<typeof SymbolView>['name'];

export function PrimaryButton({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.primary, { backgroundColor: colors.tint, opacity: disabled ? 0.4 : 1 }]}
    >
      <Text allowFontScaling style={[typography.button, { color: colors.onTint }]}>
        {title}
      </Text>
    </Pressable>
  );
}

export function PlainButton({ title, onPress, destructive }: { title: string; onPress: () => void; destructive?: boolean }) {
  const colors = useColors();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.plain}>
      <Text allowFontScaling style={[typography.body, { color: destructive ? colors.danger : colors.tint }]}>
        {title}
      </Text>
    </Pressable>
  );
}

export function Section({ header, footer, children }: { header?: string; footer?: string; children: ReactNode }) {
  const colors = useColors();
  return (
    <View style={styles.section}>
      {header !== undefined && (
        <Text accessibilityRole="header" allowFontScaling style={[typography.footnote, styles.header, { color: colors.label2 }]}>
          {header.toUpperCase()}
        </Text>
      )}
      <View style={[styles.group, { backgroundColor: colors.surface }]}>{children}</View>
      {footer !== undefined && (
        <Text allowFontScaling style={[typography.footnote, styles.footer, { color: colors.label2 }]}>
          {footer}
        </Text>
      )}
    </View>
  );
}

export interface RowProps {
  title: string;
  subtitle?: string;
  value?: string;
  icon?: SymbolName;
  iconColor?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  right?: 'chevron' | 'check' | null;
  destructive?: boolean;
  mono?: boolean;
  /** A switch on the right; the whole row is not tappable then. */
  toggle?: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean };
  last?: boolean;
  accessibilityHint?: string;
}

export function Row(p: RowProps) {
  const colors = useColors();
  const body = (
    <View style={[styles.row, !p.last && { borderBottomColor: colors.separator, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      {p.icon !== undefined && (
        <View style={styles.rowIcon}>
          <SymbolView name={p.icon} size={22} tintColor={p.iconColor ?? colors.tint} />
        </View>
      )}
      <View style={styles.rowText}>
        <Text allowFontScaling style={[typography.body, { color: p.destructive ? colors.danger : colors.label }]}>
          {p.title}
        </Text>
        {p.subtitle !== undefined && (
          <Text allowFontScaling style={[typography.subheadline, { color: colors.label2 }]}>
            {p.subtitle}
          </Text>
        )}
      </View>
      {p.value !== undefined && (
        <Text
          allowFontScaling
          selectable
          style={[typography.body, { color: colors.label2 }, p.mono && { fontFamily: 'Menlo', fontSize: 15 }]}
        >
          {p.value}
        </Text>
      )}
      {p.toggle !== undefined && (
        <Switch
          accessibilityLabel={p.title}
          value={p.toggle.value}
          disabled={p.toggle.disabled}
          onValueChange={p.toggle.onChange}
          trackColor={{ true: colors.tint }}
        />
      )}
      {p.right === 'check' && <SymbolView name="checkmark" size={18} tintColor={colors.tint} />}
      {p.right === 'chevron' && <SymbolView name="chevron.right" size={14} tintColor={colors.label3} />}
    </View>
  );
  if (p.onPress === undefined) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={p.accessibilityHint}
      onPress={p.onPress}
      onLongPress={p.onLongPress}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  primary: { minHeight: spacing.decisionButtonHeight, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  plain: { minHeight: spacing.minTouchTarget, alignItems: 'center', justifyContent: 'center' },
  section: { gap: 6 },
  header: { paddingHorizontal: 32 },
  footer: { paddingHorizontal: 32 },
  group: { borderRadius: spacing.cardRadius, overflow: 'hidden', marginHorizontal: spacing.screenMargin },
  row: { minHeight: spacing.minTouchTarget, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  rowIcon: { width: 28, alignItems: 'center' },
  rowText: { flex: 1, gap: 2 },
});
