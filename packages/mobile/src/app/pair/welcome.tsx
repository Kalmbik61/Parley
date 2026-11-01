import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { PrimaryButton } from '../../components/ui';
import { spacing, typography, useColors } from '../../theme';

/** D1 §6.1: no Mac paired yet. */
export default function Welcome() {
  const colors = useColors();
  const router = useRouter();
  return (
    <View style={[styles.page, { backgroundColor: colors.bg }]}>
      <View style={styles.center}>
        <SymbolView name="desktopcomputer" size={72} tintColor={colors.tint} />
        <Text accessibilityRole="header" allowFontScaling style={[typography.largeTitle, { color: colors.label, textAlign: 'center' }]}>
          Pair with your Mac
        </Text>
        <Text allowFontScaling style={[typography.body, { color: colors.label2, textAlign: 'center' }]}>
          On your Mac, open Parley → Settings → Remote access → Pair a device.
        </Text>
      </View>
      <View style={styles.bottom}>
        <PrimaryButton title="Scan QR code" onPress={() => router.push('/pair/scan')} />
        <Text allowFontScaling style={[typography.footnote, { color: colors.label2, textAlign: 'center' }]}>
          You can also scan it with the Camera app.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: spacing.screenMargin, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  bottom: { gap: 12 },
});
