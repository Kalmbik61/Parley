import { useEffect, useState } from 'react';
import { KIMI_NATIVE_TERMINAL_FEATURE, refKey, type KimiControl, type SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { useHostFeature, useHostSupports } from '../lib/capabilities.js';

export function useKimiControl(bridge: ParleyBridge, ref: SessionRef, kimi: boolean, persisted: boolean, running: boolean) {
  const feature = useHostFeature(KIMI_NATIVE_TERMINAL_FEATURE);
  const canRead = useHostSupports('kimi.getControl');
  const canWrite = useHostSupports('kimi.setControl');
  const supported = kimi && feature && canRead && canWrite;
  const key = refKey(ref);
  const [snapshot, setSnapshot] = useState<{ key: string; control: KimiControl }>();
  useEffect(() => {
    if (!supported) {
      setSnapshot(undefined);
      return;
    }
    let current = true;
    let changed = false;
    const off = bridge.on('kimi.control', (event) => {
      if (refKey(event.ref) !== key) return;
      changed = true;
      setSnapshot({ key, control: event.control });
    });
    void bridge.call('kimi.getControl', { ref }).then((control) => {
      if (current && !changed) setSnapshot({ key, control });
    }).catch(() => {});
    return () => { current = false; off(); };
  }, [bridge, key, supported, running]);
  const control = supported && snapshot?.key === key ? snapshot.control : undefined;
  return { supported, control, readOnly: control === undefined ? persisted : control.owner !== 'chat' };
}
