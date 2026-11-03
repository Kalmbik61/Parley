import { Stack } from 'expo-router';
import { useColors } from '../../../theme';
import { barBack } from '../../../ui/bar';

export default function SettingsLayout() {
  const colors = useColors();
  return (
    <Stack screenOptions={{ headerTintColor: colors.tint, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="index" options={{ title: 'Settings', headerLargeTitle: false, headerShadowVisible: false }} />
      <Stack.Screen name="host" options={{ title: 'Mac', ...barBack('Settings') }} />
      <Stack.Screen name="diagnostics" options={{ title: 'Diagnostics', ...barBack('Settings') }} />
    </Stack>
  );
}
