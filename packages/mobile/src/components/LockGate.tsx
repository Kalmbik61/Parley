// The lock screen (decision 6, plan A33): covers the whole app until Face ID says yes, and also while the app is not
// active, so the app switcher shows no data. It shows nothing of the app — only the name, a lock and Unlock.
//
// Above everything (critic N2, plan A35b): natively presented screens (New session/room, the RN <Modal> sheets) sit above
// the root view, so the cover is drawn in a `FullWindowOverlay`. It adds its container to the window once, as it appears,
// so it lies above the controllers presented BEFORE it; a controller presented later would lie above it. That is why the
// open sheets close on lock (`lock-sheets.ts`) and nothing is opened under the cover. The one screen that opens by itself
// is pairing, and only with no paired Mac — and then there is no lock at all (spec §11.4, critic s-220 m1), so pairing
// never meets the cover. A plain RN <Modal> would not do: it is presented from the root controller, and UIKit does not
// present a second controller from one that already presents a sheet.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { SymbolView } from 'expo-symbols';
import { DEMO, DEV_LOCK_MS } from '../dev/flags';
import { appLock, startLock } from '../auth/lock-instance';
import { knownHosts } from '../auth/use-covered';
import { shouldCover, type AppLock, type UnlockResult } from '../auth/app-lock';
import { runtime } from '../runtime/instance';
import { useRuntimeState } from '../runtime/use-runtime';
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

/**
 * Developer build with made-up data (`PARLEY_MOBILE_DEV_DEMO=1`): no lock, so screens can be looked at — unless
 * `PARLEY_MOBILE_DEV_LOCK_MS` asks for the lock too. Never in release.
 */
export function LockGate({ children }: { children: ReactNode }) {
  return DEMO && DEV_LOCK_MS === null ? <>{children}</> : <RealLockGate>{children}</RealLockGate>;
}

function RealLockGate({ children }: { children: ReactNode }) {
  const c = useColors();
  const [lock, setLock] = useState<AppLock | null>(appLock);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [kind, setKind] = useState<BiometryKind>('faceid');
  const [note, setNote] = useState<string | null>(null);
  const { locked } = useLockState(lock);
  // Paired Macs: `null` while the list is not read yet (it is set before `ready`, so empty and booting means unknown).
  const { phase, hosts: hostList } = useRuntimeState();
  const hosts = knownHosts(hostList, phase);
  // No paired Mac — no lock (spec §11.4): Face ID is not asked either; it is asked once the first Mac is paired.
  const paired = hosts !== null && hosts > 0;
  const pairedRef = useRef(paired);
  pairedRef.current = paired;

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

  // Cold start (or the first Mac just paired): ask at once. Foreground after a long trip: the lock locks itself, then asks.
  useEffect(() => {
    if (lock !== null && paired && lock.state() === 'locked' && AppState.currentState === 'active') ask(lock);
  }, [lock, paired]);
  useEffect(() => {
    if (lock === null) return;
    const sub = AppState.addEventListener('change', (s) => {
      setActive(s === 'active');
      if (s === 'active') {
        lock.onForeground();
        if (lock.state() === 'locked' && pairedRef.current) ask(lock);
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
  const hide = shouldCover(lock, active, hosts);
  return (
    // `onTouchStart` bubbles from every touch inside, whoever handles it: it only restarts the idle term.
    <View style={styles.flex} onTouchStart={() => lock?.touch()}>
      {children}
      {hide && (
        <FullWindowOverlay>
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
        </FullWindowOverlay>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  cover: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
});
