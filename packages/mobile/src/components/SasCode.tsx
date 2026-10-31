import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { groupSas, sasLabel, countdown, isLastSeconds } from '../pairing/sas';
import { typography, useColors } from '../theme';

/** The six-digit code of D1 §6.5: two groups of three, monospaced, read digit by digit by VoiceOver. */
export function SasCode({ code }: { code: string }) {
  const colors = useColors();
  return (
    <Text
      accessibilityLabel={sasLabel(code)}
      accessibilityRole="text"
      allowFontScaling
      maxFontSizeMultiplier={1.3}
      style={[styles.code, { color: colors.label }]}
    >
      {groupSas(code)}
    </Text>
  );
}

/** "Waiting for your Mac…  1:54"; the digits turn orange in the last 10 seconds. */
export function SasCountdown({ expiresAt }: { expiresAt: number }) {
  const colors = useColors();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  return (
    <View style={styles.wait}>
      <Text allowFontScaling style={[typography.body, { color: colors.label2, flex: 1 }]}>
        Waiting for your Mac…
      </Text>
      <Text
        allowFontScaling
        style={[typography.body, { fontVariant: ['tabular-nums'], color: isLastSeconds(expiresAt, now) ? colors.needsYou : colors.label2 }]}
      >
        {countdown(expiresAt, now)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  code: { fontSize: 48, fontFamily: 'Menlo', fontWeight: '600', fontVariant: ['tabular-nums'], textAlign: 'center' },
  wait: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
