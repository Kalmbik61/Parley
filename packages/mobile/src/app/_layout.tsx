import '../polyfills';
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { runtime } from '../runtime/instance';

export default function RootLayout() {
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
