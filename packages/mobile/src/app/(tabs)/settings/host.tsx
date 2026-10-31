// One Mac (D1 §11.1): local name, pairing date, relay, Remove.
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Row, Section } from '../../../components/ui';
import { confirmRemove } from '../../../hosts/confirm-remove';
import { runtime } from '../../../runtime/instance';
import { useRuntimeState } from '../../../runtime/use-runtime';
import { displayName } from '../../../settings/local-settings';
import { typography, useColors } from '../../../theme';

const pairedOn = (ms: number): string =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export default function HostScreen() {
  const colors = useColors();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { hosts, hostNames } = useRuntimeState();
  const host = hosts.find((h) => h.hostId === id);
  if (host === undefined) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  const name = displayName(host, hostNames);

  const rename = (): void =>
    Alert.prompt(
      'Rename',
      'This name is only shown on this phone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Save', onPress: (value?: string) => void runtime.renameHost(host.hostId, value ?? '') },
      ],
      'plain-text',
      name,
    );

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: colors.bg }} contentContainerStyle={styles.content}>
      <Section>
        <Row title="Name" value={name} right="chevron" onPress={rename} />
        <Row title="Paired" value={pairedOn(host.pairedAt)} />
        <Row last title="Relay" value={host.relay} mono />
      </Section>
      <View style={styles.remove}>
        <Section>
          <Row
            last
            destructive
            title="Remove from this phone"
            onPress={() => confirmRemove(host.hostId, name, () => router.back())}
          />
        </Section>
        <Text allowFontScaling style={[typography.footnote, { color: colors.label2, paddingHorizontal: 32 }]}>
          This removes the keys on this phone. Your Mac still lists the phone until you revoke it there: Settings → Remote access → Devices.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 16, paddingBottom: 40, gap: 24 },
  remove: { gap: 8 },
});
