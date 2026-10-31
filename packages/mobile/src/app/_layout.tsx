import '../polyfills';
import { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { useClearOnOpen, usePushTaps } from '../push/notifications';
import { runtime } from '../runtime/instance';

export default function RootLayout() {
  const router = useRouter();
  usePushTaps(router);
  useClearOnOpen();
  useEffect(() => {
    void runtime.start();
    return () => runtime.stop();
  }, []);
  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}
