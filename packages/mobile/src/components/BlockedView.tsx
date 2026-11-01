// Full-screen blocked states of D1 §11.4–11.5: removed from the Mac, and "Update Parley on your phone / Mac". The supervisor
// is `blocked` (it does not retry); nothing here wipes the host record: "Remove" asks first (confirmRemove).
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { MIN_CLIENT_VERSION } from '@parley/protocol/remote';
import { confirmRemove } from '../hosts/confirm-remove';
import { useRuntimeState } from '../runtime/use-runtime';
import { displayName } from '../settings/local-settings';
import { typography, useColors } from '../theme';
import { blockedScreen } from './banner-model';
import { PlainButton, PrimaryButton } from './ui';

export function useBlockedScreen() {
  const state = useRuntimeState();
  return state.host === null || state.supervisor === null ? null : blockedScreen(state.supervisor.blocked, state.hostStatus);
}

export function BlockedView() {
  const colors = useColors();
  const router = useRouter();
  const state = useRuntimeState();
  const screen = useBlockedScreen();
  if (screen === null || state.host === null) return null;
  const name = displayName(state.host, state.hostNames);
  const hostId = state.host.hostId;
  const content =
    screen === 'revoked'
      ? { icon: 'desktopcomputer.trianglebadge.exclamationmark' as const, title: `Removed from ${name}`, text: 'This Mac no longer allows this phone.' }
      : screen === 'update-phone'
        ? {
            icon: 'arrow.down.app' as const,
            title: 'Update Parley on your phone',
            text: `Your Mac needs version ${MIN_CLIENT_VERSION} or later. Install the new build from Xcode.`,
          }
        : { icon: 'desktopcomputer' as const, title: 'Update Parley on your Mac', text: 'This phone needs a newer Parley on your Mac.' };
  return (
    <View style={[StyleSheet.absoluteFill, styles.page, { backgroundColor: colors.bg }]} accessibilityViewIsModal>
      <SymbolView name={content.icon} size={56} tintColor={colors.label2} />
      <Text allowFontScaling style={[typography.title3, styles.center, { color: colors.label }]}>
        {content.title}
      </Text>
      <Text allowFontScaling style={[typography.body, styles.center, { color: colors.label2 }]}>
        {content.text}
      </Text>
      {screen === 'revoked' && (
        <View style={styles.buttons}>
          <PrimaryButton title="Pair again" onPress={() => router.push('/pair/scan')} />
          <PlainButton title="Remove" destructive onPress={() => confirmRemove(hostId, name)} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 },
  center: { textAlign: 'center' },
  buttons: { alignSelf: 'stretch', gap: 8, marginTop: 16 },
});
