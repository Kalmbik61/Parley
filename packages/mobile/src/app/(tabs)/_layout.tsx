import { useMemo } from 'react';
import { NativeTabs } from 'expo-router/native-tabs';
import { selectNeedsYouCount } from '@parley/remote-client';
import { useRemoteState } from '../../hooks/use-remote';
import { useColors } from '../../theme';

export default function TabLayout() {
  const state = useRemoteState();
  const needsYou = useMemo(() => (state === null ? 0 : selectNeedsYouCount(state)), [state]);
  const colors = useColors();
  return (
    // The selected tab is the Parley accent, not system blue (plan A35d).
    <NativeTabs tintColor={colors.tint}>
      {/* Voice is the first tab and the screen the app opens on (`index`, VO-01); Inbox lives at `/inbox`. */}
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Voice</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="waveform" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="inbox">
        <NativeTabs.Trigger.Label>Inbox</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="tray" />
        <NativeTabs.Trigger.Badge hidden={needsYou === 0}>{String(needsYou)}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="works">
        <NativeTabs.Trigger.Label>Works</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="square.stack.3d.up" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
