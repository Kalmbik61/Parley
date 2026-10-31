import { Text } from 'react-native';
import { Screen } from '../../components/Screen';
import { useRuntimeState } from '../../runtime/use-runtime';
import { typography, useColors } from '../../theme';

export default function SettingsScreen() {
  const colors = useColors();
  const { host, supervisor } = useRuntimeState();
  return (
    <Screen title="Settings">
      <Text allowFontScaling style={[typography.body, { color: colors.label2 }]}>
        {host === null ? 'No Mac paired' : `${host.hostName} · ${supervisor?.state ?? 'idle'}`}
      </Text>
    </Screen>
  );
}
