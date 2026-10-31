// Settings (D1 §11): Macs, Security, Notifications, About.
import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, ScrollView, StyleSheet } from 'react-native';
import { approve } from '../../../auth/instance';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { ConnectionBanner } from '../../../components/ConnectionBanner';
import { Row, Section } from '../../../components/ui';
import { haptic } from '../../../haptics';
import { getPermission, requestPermission } from '../../../notifications/permission';
import { notificationRow, type Permission } from '../../../notifications/row';
import { runtime } from '../../../runtime/instance';
import { useRuntimeState } from '../../../runtime/use-runtime';
import { displayName } from '../../../settings/local-settings';
import { biometryKind, biometryLabel, type BiometryKind } from '../../../settings/biometric';
import { useColors } from '../../../theme';
import { hostStatusLine } from '../../../hosts/status-line';

export default function SettingsScreen() {
  const colors = useColors();
  const router = useRouter();
  const state = useRuntimeState();
  const [biometric, setBiometric] = useState(true);
  const [kind, setKind] = useState<BiometryKind>('faceid');
  const [permission, setPermission] = useState<Permission>('undetermined');
  const [notifOn, setNotifOn] = useState(true);
  const [rtt, setRtt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setBiometric(await runtime.requireBiometric());
    setKind(await biometryKind());
    setNotifOn(await runtime.notificationsEnabled());
    setPermission(await getPermission());
  }, []);
  useEffect(() => {
    void refresh();
    // Back from iOS Settings: re-read the permission.
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void refresh());
    return () => sub.remove();
  }, [refresh]);
  const ready = state.supervisor?.state === 'ready';
  useEffect(() => {
    if (!ready) return setRtt(null);
    void runtime.measureRtt().then(setRtt);
  }, [ready, state.host?.hostId]);

  const label = biometryLabel(kind);
  const row = notificationRow({ permission, enabled: notifOn, pushAvailable: state.pushAvailability !== 'unavailable' });
  const version = Constants.expoConfig?.version ?? '0.0.0';

  const toggleBiometric = async (on: boolean): Promise<void> => {
    if (!on && (await approve('disable')) !== 'ok') return; // turning protection off is itself protected
    setBiometric(on);
    await runtime.setRequireBiometric(on);
  };
  const toggleNotifications = async (on: boolean): Promise<void> => {
    if (on && permission === 'undetermined') {
      const result = await requestPermission();
      setPermission(result);
      if (result !== 'granted') return;
    }
    setNotifOn(on);
    await runtime.setNotificationsEnabled(on);
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: colors.bg }} contentContainerStyle={styles.content}>
      <ConnectionBanner />
      <Section header="Macs">
        {state.hosts.map((h) => {
          const current = h.hostId === state.host?.hostId;
          return (
            <Row
              key={h.hostId}
              icon="desktopcomputer"
              title={displayName(h, state.hostNames)}
              subtitle={current ? hostStatusLine(state.supervisor, state.hostStatus, rtt) : 'Not connected'}
              right={current ? 'check' : 'chevron'}
              onPress={() => {
                if (current) return router.push({ pathname: '/settings/host', params: { id: h.hostId } });
                haptic.selection();
                void runtime.selectHost(h.hostId);
              }}
              onLongPress={() => router.push({ pathname: '/settings/host', params: { id: h.hostId } })}
              accessibilityHint={current ? 'Opens Mac details' : 'Makes this the current Mac'}
            />
          );
        })}
        <Row last icon="plus.circle.fill" title="Pair another Mac" onPress={() => router.push('/pair/scan')} />
      </Section>
      <Section
        header="Security"
        footer={
          biometric
            ? `Parley asks for ${label} before Allow and Accept. Deny, Return for rework, answers and viewing never ask.`
            : `Allow and Accept are sent without ${label}. Anyone holding this unlocked iPhone can approve.`
        }
      >
        <Row
          last
          icon={kind === 'passcode' ? 'lock.fill' : kind}
          title={`Require ${label} to allow`}
          subtitle={kind === 'passcode' ? `${label} isn't set up — your passcode is used` : undefined}
          toggle={{ value: biometric, onChange: (v) => void toggleBiometric(v) }}
        />
      </Section>
      <Section
        header="Notifications"
        footer={row.kind === 'unavailable' ? undefined : 'Notifications arrive only while your Mac is awake and Parley is running.'}
      >
        {row.kind === 'switch' && (
          <Row last title="Notifications" toggle={{ value: row.on, onChange: (v) => void toggleNotifications(v) }} />
        )}
        {row.kind === 'denied' && (
          <Row last title="Turned off in iOS Settings" right="chevron" onPress={() => void Linking.openSettings()} subtitle="Open Settings" />
        )}
        {row.kind === 'unavailable' && <Row last title="Notifications unavailable on this build" />}
      </Section>
      <Section header="About">
        <Row title="Version" value={version} />
        <Row last title="Diagnostics" right="chevron" onPress={() => router.push('/settings/diagnostics')} />
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 120, gap: 24 },
});
