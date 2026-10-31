import '../polyfills';
import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { cardsApprove } from '../auth/instance';
import { ApproveContext } from '../cards/approve-context';
import { useClearOnOpen, usePushTaps } from '../push/notifications';
import { runtime } from '../runtime/instance';
import { useRuntimeState } from '../runtime/use-runtime';

export default function RootLayout() {
  const { phase, hosts } = useRuntimeState();
  const segments = useSegments();
  const router = useRouter();
  usePushTaps(router);
  useClearOnOpen();
  useEffect(() => {
    void runtime.start();
    return () => runtime.stop();
  }, []);
  // No Mac paired (first start, or the last one removed): the pairing flow, which has no tabs behind it (D1 §3).
  const inPairing = (segments[0] as string) === 'pair';
  useEffect(() => {
    if (phase === 'ready' && hosts.length === 0 && !inPairing) router.replace('/pair/welcome');
  }, [phase, hosts.length, inPairing, router]);
  // Developer build only: `EXPO_PUBLIC_DEV_ROUTE=/pair/preview?step=sas` opens that route once the app is ready (screenshots).
  const devRoute = __DEV__ ? process.env.EXPO_PUBLIC_DEV_ROUTE : undefined;
  useEffect(() => {
    if (devRoute && phase === 'ready') router.replace(devRoute as never);
  }, [devRoute, phase, router]);
  return (
    <ApproveContext.Provider value={cardsApprove}>
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="pair"
        options={{ headerShown: false, presentation: 'fullScreenModal', gestureEnabled: false }}
      />
    </Stack>
    </ApproveContext.Provider>
  );
}
