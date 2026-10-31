import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { typography, useColors } from '../theme';
import { ConnectionBanner } from './ConnectionBanner';

/** Empty tab screen: banner, title, one line of text. A14–A16 replace the body. */
export function Screen({ title, children }: { title: string; children?: ReactNode }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.page, { backgroundColor: colors.bg, paddingTop: insets.top }]}>
      <ConnectionBanner />
      <View style={styles.body}>
        <Text accessibilityRole="header" allowFontScaling style={[typography.largeTitle, { color: colors.label }]}>
          {title}
        </Text>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { padding: 16, gap: 8 },
});
