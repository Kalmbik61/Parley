// Small form pieces of the New session / New room sheet (D1 §8.4): a segmented control, a menu row, a section label.
import { ActionSheetIOS, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { spacing, typography, useColors } from '../theme';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: ReadonlyArray<SegmentOption<T>>; value: T; onChange: (v: T) => void; label: string }) {
  const c = useColors();
  return (
    <View accessibilityRole="tablist" accessibilityLabel={label} style={[styles.segments, { backgroundColor: c.neutralBg }]}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected, disabled: o.disabled === true }}
            disabled={o.disabled === true}
            onPress={() => onChange(o.value)}
            style={[styles.segment, selected && { backgroundColor: c.surface }, o.disabled === true && { opacity: 0.4 }]}
          >
            <Text allowFontScaling numberOfLines={1} style={[typography.subheadline, { color: c.label, fontWeight: selected ? '600' : '400' }]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A native menu (action sheet) over a list; `null` — dismissed. */
export function choose(title: string, options: readonly string[]): Promise<number | null> {
  return new Promise((resolve) => {
    ActionSheetIOS.showActionSheetWithOptions({ title, options: [...options, 'Cancel'], cancelButtonIndex: options.length }, (index) => resolve(index === options.length ? null : index));
  });
}

export function MenuRow({ label, value, onPress, disabled }: { label: string; value: string; onPress: () => void; disabled?: boolean }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${value}`}
      disabled={disabled}
      onPress={onPress}
      style={[styles.row, { opacity: disabled === true ? 0.4 : 1 }]}
    >
      <Text allowFontScaling style={[typography.body, { color: c.label }]}>
        {label}
      </Text>
      <View style={styles.menuValue}>
        <Text allowFontScaling numberOfLines={1} style={[typography.body, { color: c.label2, flexShrink: 1 }]}>
          {value}
        </Text>
        <SymbolView name="chevron.up.chevron.down" size={12} tintColor={c.label3} />
      </View>
    </Pressable>
  );
}

export function Label({ children }: { children: ReactNode }) {
  const c = useColors();
  return (
    <Text accessibilityRole="header" allowFontScaling style={[typography.footnote, styles.label, { color: c.label2 }]}>
      {String(children).toUpperCase()}
    </Text>
  );
}

export function Card({ children }: { children: ReactNode }) {
  const c = useColors();
  return <View style={[styles.card, { backgroundColor: c.surface }]}>{children}</View>;
}

export function Divider() {
  const c = useColors();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.separator, marginLeft: 16 }} />;
}

const styles = StyleSheet.create({
  segments: { flexDirection: 'row', borderRadius: 9, padding: 2 },
  segment: { flex: 1, minHeight: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 7, paddingHorizontal: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: spacing.minTouchTarget, paddingHorizontal: 16 },
  menuValue: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  label: { marginTop: 18, marginBottom: 6, marginLeft: 16 },
  card: { borderRadius: spacing.cardRadius, overflow: 'hidden' },
});
