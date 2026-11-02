// The lock screen (decision 6, plan A33): covers the whole app until Face ID says yes, and also while the app is not
// active, so the app switcher shows no data. It shows nothing of the app — only the name, a lock and Unlock.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { DEMO } from '../dev/flags';
import { appLock, startLock } from '../auth/lock-instance';
import { shouldCover, type AppLock, type UnlockResult } from '../auth/app-lock';
import { runtime } from '../runtime/instance';
import { typography, useColors } from '../theme';
import { Button } from '../ui/Button';
import { biometryKind, biometryLabel, type BiometryKind } from '../settings/biometric';

const subscribeNone = (): (() => void) => () => undefined;

function useLockState(lock: AppLock | null): { covered: boolean; locked: boolean } {
  const state = useSyncExternalStore(
    (cb) => (lock === null ? subscribeNone() : lock.subscribe(cb)),
    () => (lock === null ? 'locked' : lock.state()),
    () => 'locked',
  );
  return { covered: state !== 'unlocked', locked: state === 'locked' };
}

/** Developer build with made-up data (`PARLEY_MOBILE_DEV_DEMO=1`): no lock, so screens can be looked at. Never in release. */
export function LockGate({ children }: { children: ReactNode }) {
  return DEMO ? <>{children}</> : <RealLockGate>{children}</RealLockGate>;
}

function RealLockGate({ children }: { children: ReactNode }) {
  const c = useColors();
  const [lock, setLock] = useState<AppLock | null>(appLock);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [kind, setKind] = useState<BiometryKind>('faceid');
  const [note, setNote] = useState<string | null>(null);
  const { locked } = useLockState(lock);

  // The setting decides whether the lock exists at all; until it is read the app stays covered.
  useEffect(() => {
    if (lock !== null) return;
    let live = true;
    void runtime.lockEnabled().then((enabled) => live && setLock(startLock(enabled)));
    return () => {
      live = false;
    };
  }, [lock]);
  useEffect(() => void biometryKind().then(setKind), []);

  const ask = (l: AppLock): void => {
    void l.unlock().then((r: UnlockResult) => setNote(r === 'no-passcode' ? 'Set a device passcode to unlock Parley' : null));
  };

  // Cold start: ask at once. Foreground after a long trip: the lock locks itself, then asks.
  useEffect(() => {
    if (lock === null) return;
    if (lock.state() === 'locked' && AppState.currentState === 'active') ask(lock);
    const sub = AppState.addEventListener('change', (s) => {
      setActive(s === 'active');
      if (s === 'active') {
        lock.onForeground();
        if (lock.state() === 'locked') ask(lock);
      } else lock.onBackground();
    });
    // Five minutes without a touch while on screen lock again (plan A34): the term is checked every few seconds.
    const timer = setInterval(() => lock.tick(), 10_000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [lock]);

  const label = biometryLabel(kind);
  // Locked (or still reading the setting), or away from the foreground with the lock on (the app switcher snapshot is
  // taken as the app goes inactive): nothing of the app shows.
  const hide = shouldCover(lock, active);
  return (
    // `onTouchStart` bubbles from every touch inside, whoever handles it: it only restarts the idle term.
    <View style={styles.flex} onTouchStart={() => lock?.touch()}>
      {children}
      {hide && (
        <View accessibilityViewIsModal style={[styles.cover, { backgroundColor: c.bg }]}>
          <SymbolView name="lock.fill" size={44} tintColor={c.label2} />
          <Text accessibilityRole="header" allowFontScaling style={[typography.title3, { color: c.label }]}>
            Parley is locked
          </Text>
          {locked && active && <Button title={`Unlock with ${label}`} variant="prominent" onPress={() => lock !== null && ask(lock)} />}
          {note !== null && (
            <Text accessibilityLiveRegion="polite" allowFontScaling style={[typography.subheadline, { color: c.label2, textAlign: 'center' }]}>
              {note}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  cover: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
});
