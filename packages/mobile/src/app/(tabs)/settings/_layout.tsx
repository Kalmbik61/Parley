import { Stack } from 'expo-router';
import { useColors } from '../../../theme';

export default function SettingsLayout() {
  const colors = useColors();
  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal', contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="index" options={{ title: 'Settings', headerLargeTitle: true }} />
      <Stack.Screen name="host" options={{ title: 'Mac' }} />
      <Stack.Screen name="diagnostics" options={{ title: 'Diagnostics' }} />
    </Stack>
  );
}
