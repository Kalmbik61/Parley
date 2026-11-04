// Voice loopback (B1, developer builds only: see `DEV_BUILD`): the microphone of this phone through two in-process WebRTC
// connections to the loud speaker, plus a pulsing test orb (react-native-svg + reanimated on the UI thread) and a line in
// Golos Text, to prove the native modules of the voice work. Keep the volume low: a loud speaker next to the microphone.
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { GolosText_400Regular, useFonts } from '@expo-google-fonts/golos-text';
import { Redirect } from 'expo-router';
import Animated, { Easing, useAnimatedProps, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { PrimaryButton, Row, Section } from '../components/ui';
import { DEV_BUILD } from '../dev/build';
import { startLoopback, type Loopback, type LoopbackState } from '../dev/voice-loopback';
import { typography, useColors } from '../theme';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

function TestOrb({ color }: { color: string }) {
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, [pulse]);
  const animatedProps = useAnimatedProps(() => ({ r: 36 + 16 * pulse.value, opacity: 0.45 + 0.55 * pulse.value }));
  return (
    <Svg width={120} height={120} viewBox="0 0 120 120">
      <AnimatedCircle cx={60} cy={60} fill={color} animatedProps={animatedProps} />
    </Svg>
  );
}

export default function VoiceLoopback() {
  const colors = useColors();
  const [state, setState] = useState<LoopbackState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [fontsLoaded, fontError] = useFonts({ GolosText_400Regular });
  const loop = useRef<Loopback | null>(null);
  const busy = useRef(false);
  // Bumped by every stop (and by unmount): a start that resolves under an older value must stop what it got.
  const generation = useRef(0);
  const start = async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    // A loopback left behind by a 'failed' state still holds the mic and the audio session.
    loop.current?.stop();
    loop.current = null;
    const mine = ++generation.current;
    setError(null);
    try {
      const l = await startLoopback((s) => {
        if (generation.current === mine) setState(s);
      });
      if (generation.current === mine) loop.current = l;
      else l.stop();
    } catch (e) {
      if (generation.current === mine) setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  };
  const stop = (): void => {
    generation.current++;
    loop.current?.stop();
    loop.current = null;
  };
  useEffect(() => stop, []);
  if (!DEV_BUILD) return <Redirect href="/" />;
  const running = state === 'starting' || state === 'connecting' || state === 'connected';
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: colors.bg }} contentContainerStyle={styles.content}>
      <Text style={[typography.footnote, { color: colors.label2, marginHorizontal: 16 }]}>
        Your voice goes through two WebRTC connections inside this app and comes out of the loud speaker. Keep the volume low.
        Say a few words: you should hear them back about a quarter of a second later, without a squeal.
      </Text>
      <Section header="Connection">
        <Row title="State" value={state} mono last />
      </Section>
      {error !== null && <Text style={[typography.footnote, { color: colors.danger, marginHorizontal: 16 }]}>{error}</Text>}
      <View style={{ marginHorizontal: 16 }}>
        <PrimaryButton title={running ? 'Stop' : 'Start'} onPress={() => {
            if (running) {
              stop();
              setState('closed');
            } else void start();
          }} />
      </View>
      <View style={styles.orb}>
        <TestOrb color={colors.tint} />
        <Text style={{ color: colors.label, fontSize: 17, fontFamily: fontsLoaded ? 'GolosText_400Regular' : undefined }}>
          Парли слушает · Parley is listening
        </Text>
        <Text style={[typography.footnote, { color: colors.label2 }]}>
          {fontError ? 'Golos Text failed to load' : fontsLoaded ? 'Golos Text loaded' : 'Golos Text loading'}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 120, gap: 20, paddingTop: 12 },
  orb: { alignItems: 'center', gap: 12, marginTop: 8 },
});
