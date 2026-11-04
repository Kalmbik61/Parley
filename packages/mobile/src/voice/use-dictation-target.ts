// The glue between the dictation store and the screens (A47): the real dependencies of the store, wired once, and the hook a
// text field uses to become a dictation target. The only file here that knows Alert, Clipboard, Linking and AppState.
import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { Alert, AppState, Linking, type TextInput, type TextInputSelectionChangeEvent } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { getLocales } from 'expo-localization';
import { useIsFocused, useLocalSearchParams } from 'expo-router';
import { DEV_VOICE } from '../dev/flags';
import { draftOf, setDraft } from '../feed/outbox';
import { roomDraftOf, setRoomDraft } from '../room/use-room-chat';
import { dictation, type DictationState, type Fallback } from './dictation';
import { engine } from './engine';
import { joinTranscript, spliceTranscript } from './insert';
import { createLanguageChooser } from './language';

let wired = false;
function ensureWired(): void {
  if (wired) return;
  wired = true;
  dictation.configure({
    engine,
    permissions: { get: () => engine.getPermissions(), request: () => engine.requestPermissions() },
    chooseLanguage: createLanguageChooser(engine, () => getLocales()[0]?.languageTag ?? 'en-US'),
    showDenied: () =>
      Alert.alert('Microphone or speech recognition is off', 'Allow both for Parley in Settings to dictate.', [
        { text: 'Not now', style: 'cancel' },
        { text: 'Open Settings', onPress: () => void Linking.openSettings() },
      ]),
    showRestricted: () =>
      Alert.alert('Dictation is restricted on this iPhone', 'Screen Time or your organization blocks the microphone or speech recognition.', [{ text: 'OK' }]),
    copy: (text) => Clipboard.setStringAsync(text).then(() => undefined),
    appendDraft: (fallback, text) => {
      const [read, write] = fallback.kind === 'room' ? [roomDraftOf, setRoomDraft] : [draftOf, setDraft];
      const before = read(fallback.key);
      write(fallback.key, before + joinTranscript(before, text));
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  });
  AppState.addEventListener('change', (next) => {
    if (next === 'background') dictation.onBackground();
    if (next === 'active') void dictation.refreshAvailability();
  });
  void dictation.refreshAvailability();
}

export function useDictationState(): DictationState {
  return useSyncExternalStore(dictation.subscribe, dictation.getState, dictation.getState);
}

/**
 * Makes a text field a dictation target. `apply` takes the whole new value (the field's own setter); the caret is the last
 * `selection.start` the field reported (the end of the text when it never did), taken at the moment of insertion.
 */
export function useDictationTarget(o: {
  id: string;
  input: RefObject<React.ComponentRef<typeof TextInput> | null>;
  value: string;
  apply(value: string): void;
  fallback: Fallback;
  toast(text: string): void;
}): { onSelectionChange(e: TextInputSelectionChangeEvent): void } {
  const latest = useRef(o);
  latest.current = o;
  const selection = useRef<number | null>(null);
  const screenFocused = useIsFocused();
  const fallbackKey = typeof o.fallback === 'string' ? o.fallback : `${o.fallback.kind}:${o.fallback.key}`;
  useEffect(() => {
    ensureWired();
    return dictation.register({
      id: o.id,
      fallback: latest.current.fallback,
      isFocused: () => latest.current.input.current?.isFocused() === true,
      toast: (text) => latest.current.toast(text),
      insert: (text) => {
        const { value, apply, input } = latest.current;
        const { value: next, caret } = spliceTranscript(value, selection.current ?? value.length, text);
        apply(next);
        selection.current = caret;
        if (input.current?.isFocused() === true) requestAnimationFrame(() => input.current?.setSelection(caret, caret));
      },
    });
  }, [o.id, fallbackKey]);
  // Developer evidence (A47): `?dev=mic@4000,mic@10000` taps this field's microphone at those times (fake engine only).
  const { dev } = useLocalSearchParams<{ dev?: string }>();
  useEffect(() => {
    if (DEV_VOICE === null || typeof dev !== 'string') return;
    const timers = dev
      .split(',')
      .filter((t) => t.startsWith('mic@'))
      .map((t) => setTimeout(() => dictation.toggle(o.id), Number(t.slice(4))));
    return () => timers.forEach(clearTimeout);
  }, [dev, o.id]);
  useEffect(() => {
    if (!screenFocused) dictation.onBlur(o.id);
  }, [screenFocused, o.id]);
  return { onSelectionChange: (e) => void (selection.current = e.nativeEvent.selection.start) };
}
