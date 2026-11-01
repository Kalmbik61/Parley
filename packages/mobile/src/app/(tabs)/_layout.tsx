import { useMemo } from 'react';
import { NativeTabs } from 'expo-router/native-tabs';
import { selectNeedsYouCount } from '@parley/remote-client';
import { useRemoteState } from '../../hooks/use-remote';

export default function TabLayout() {
  const state = useRemoteState();
  const needsYou = useMemo(() => (state === null ? 0 : selectNeedsYouCount(state)), [state]);
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
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
