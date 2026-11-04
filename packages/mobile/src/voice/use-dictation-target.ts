// The glue between the dictation store and the screens (A47): the real dependencies of the store, wired once, and the hook a
// text field uses to become a dictation target. The only file here that knows Alert, Clipboard, Linking and AppState.
import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { AccessibilityInfo, Alert, AppState, Linking, type TextInput, type TextInputSelectionChangeEvent } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { getLocales } from 'expo-localization';
import { useIsFocused, useLocalSearchParams } from 'expo-router';
import { DEV_VOICE } from '../dev/flags';
import { draftOf, setDraft } from '../feed/outbox';
import { roomDraftOf, setRoomDraft } from '../room/room-drafts';
import { appendToDraft } from './draft';
import { dictation, type DictationState, type DictationTarget, type Fallback } from './dictation';
import { engine } from './engine';
import { spliceTranscript } from './insert';
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
    announce: (text) => AccessibilityInfo.announceForAccessibility(text),
    appendDraft: (fallback, text) =>
      appendToDraft({ session: { get: draftOf, set: setDraft }, room: { get: roomDraftOf, set: setRoomDraft } }, fallback, text),
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
  const registered = useRef<DictationTarget | null>(null);
  useEffect(() => {
    ensureWired();
    const target: DictationTarget = {
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
    };
    registered.current = target;
    return dictation.register(target);
  }, [o.id, fallbackKey]);
  // The same screen can stand in the stack twice with one id: the upper copy's registration replaced ours, and its removal
  // took the id away. A screen that gets its focus back registers its own target again (i3).
  useEffect(() => {
    if (screenFocused && registered.current !== null) dictation.register(registered.current);
  }, [screenFocused]);
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

/** The field hid while the screen stays (a question card came, the session closed, the Mac switched messaging off): the recording
 *  ends as if ⬆ were pressed, so the text lands in the field or its draft (I1). */
export function useDictationHidden(id: string, hidden: boolean): void {
  useEffect(() => {
    if (hidden) dictation.onHidden(id);
  }, [hidden, id]);
}

/** For a screen that cannot call the hook after its early returns: render it next to the field. */
export function DictationHiddenGuard({ id, hidden }: { id: string; hidden: boolean }): null {
  useDictationHidden(id, hidden);
  return null;
}
