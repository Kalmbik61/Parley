import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { typography, useColors } from '../theme';

export const FACE_ID_CANCELLED = 'Face ID cancelled — nothing was sent';
export const NO_PASSCODE = 'Set a device passcode to approve from the phone';

/** A 2 s toast (D1 §12a). */
export function useToast(): { message: string | null; show: (m: string) => void } {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const show = useCallback((m: string) => {
    setMessage(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), 2000);
  }, []);
  return { message, show };
}

export function Toast({ message }: { message: string | null }) {
  const colors = useColors();
  if (message === null) return null;
  return (
    <View pointerEvents="none" style={styles.wrap}>
      <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, styles.toast, { backgroundColor: colors.label, color: colors.bg }]}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, bottom: 110, alignItems: 'center' },
  toast: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 14, overflow: 'hidden', textAlign: 'center' },
});
