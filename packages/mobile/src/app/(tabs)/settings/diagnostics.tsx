// Diagnostics (D1 §11.3): key — value, values selectable (long press → Copy), Reconnect.
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ConnectionBanner } from '../../../components/ConnectionBanner';
import { PrimaryButton, Row, Section } from '../../../components/ui';
import { DEV_BUILD } from '../../../dev/build';
import { diagnosticsRows } from '../../../hosts/diagnostics';
import { runtime } from '../../../runtime/instance';
import { useRuntimeState } from '../../../runtime/use-runtime';
import { useColors } from '../../../theme';

export default function Diagnostics() {
  const colors = useColors();
  const router = useRouter();
  const state = useRuntimeState();
  const [rtt, setRtt] = useState<number | null>(null);
  const measure = useCallback(() => void runtime.measureRtt().then(setRtt), []);
  const ready = state.supervisor?.state === 'ready';
  useEffect(() => {
    if (ready) measure();
    else setRtt(null);
  }, [ready, measure]);
  const rows = diagnosticsRows({
    host: state.host,
    supervisor: state.supervisor,
    hostStatus: state.hostStatus,
    rtt,
  });
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={styles.content}
    >
      <ConnectionBanner />
      <Section>
        {rows.map((r, i) => (
          <Row key={r.key} title={r.key} value={r.value} mono last={i === rows.length - 1} />
        ))}
      </Section>
      {DEV_BUILD && (
        <Section header="Developer build" footer="A20 item 16: crypto speed of this phone.">
          <Row last title="Crypto bench" right="chevron" onPress={() => router.push('/bench')} />
        </Section>
      )}
      <View style={{ marginHorizontal: 16 }}>
        <PrimaryButton
          title="Reconnect"
          disabled={state.host === null}
          onPress={() => {
            runtime.reconnect();
            setTimeout(measure, 1500);
          }}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({ content: { paddingBottom: 120, gap: 24 } });
