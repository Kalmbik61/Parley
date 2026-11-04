// The microphone button (A47, spec 3.1): one component for the session composer, the room composer and the New session task.
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useColors } from '../theme';
import { dictation } from './dictation';
import { useDictationState } from './use-dictation-target';

const HINT = 'Records until you tap again. The text goes into the field; nothing is sent.';

export function MicButton({ id, editable = true }: { id: string; editable?: boolean }) {
  const c = useColors();
  const state = useDictationState();
  const mine = state.targetId === id;
  const busyElsewhere = !mine && state.phase !== 'idle' && state.phase !== 'recording';
  let label = 'Dictate';
  let hint: string | undefined = HINT;
  let body: React.ReactNode = <SymbolView name="mic" size={22} tintColor={c.tint} />;
  let disabled = !editable;
  if (mine && state.phase === 'starting') {
    label = 'Starting dictation';
    hint = undefined;
    body = <ActivityIndicator />;
    disabled = true;
  } else if (mine && state.phase === 'recording') {
    label = 'Stop dictation';
    hint = undefined;
    body = <View style={[styles.dot, { backgroundColor: c.danger }]} />;
  } else if (mine && state.phase === 'transcribing') {
    label = 'Transcribing';
    hint = undefined;
    body = <ActivityIndicator />;
    disabled = true;
  } else if (mine && state.phase === 'cancelling') {
    label = 'Stopping';
    hint = undefined;
    body = <ActivityIndicator />;
    disabled = true;
  } else if (busyElsewhere) {
    body = <SymbolView name="mic" size={22} tintColor={c.off} />;
    disabled = true;
  } else if (state.availability.state === 'unavailable' && state.phase === 'idle') {
    // Not `disabled`: the tap and VoiceOver must reach the reason.
    label = 'Dictation unavailable';
    hint = state.availability.reason;
    body = <SymbolView name="mic.slash" size={22} tintColor={c.off} />;
  }
  if (!editable) body = <SymbolView name={state.availability.state === 'unavailable' ? 'mic.slash' : 'mic'} size={22} tintColor={c.off} />;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(hint === undefined ? {} : { accessibilityHint: hint })}
      accessibilityState={{ disabled, busy: mine && state.phase !== 'recording' && state.phase !== 'idle' }}
      disabled={disabled}
      onPress={() => dictation.toggle(id)}
      style={styles.button}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6 },
});
