// The "+" of Works and of a work (D1 §8.4): there only when the bridge hello offers a launch method, off without a link.
import { Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCanAct, useRemoteState } from '../hooks/use-remote';
import { workParam, type WorkRef } from '../nav/refs';
import { useColors } from '../theme';
import { canShowNew } from './launch-model';

export function NewButton({ work }: { work?: WorkRef | null }) {
  const c = useColors();
  const router = useRouter();
  const state = useRemoteState();
  const online = useCanAct();
  if (state === null || !canShowNew(state)) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New session or room"
      accessibilityState={{ disabled: !online }}
      disabled={!online}
      hitSlop={8}
      onPress={() => router.push({ pathname: '/new', params: work ? { ref: workParam(work) } : {} } as never)}
      style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: online ? 1 : 0.4 }}
    >
      <SymbolView name="plus" size={22} tintColor={c.tint} />
    </Pressable>
  );
}
