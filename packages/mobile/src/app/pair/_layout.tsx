import { Stack } from 'expo-router';

export default function PairLayout() {
  return <Stack screenOptions={{ headerShown: false, gestureEnabled: false, animation: 'fade' }} />;
}
