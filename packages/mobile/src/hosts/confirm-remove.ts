import { Alert } from 'react-native';
import { haptic } from '../haptics';
import { runtime } from '../runtime/instance';

/** D1 §11.1: destructive alert; erases the keys on this phone only (the Mac still lists the phone, spec §7.9). */
export function confirmRemove(hostId: string, name: string, onRemoved?: () => void): void {
  Alert.alert(`Remove ${name}?`, 'This removes the keys on this phone. The Mac still lists the phone until you revoke it there.', [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Remove',
      style: 'destructive',
      onPress: () => {
        void runtime.removeHost(hostId).then(() => {
          haptic.warning();
          onRemoved?.();
        });
      },
    },
  ]);
}
