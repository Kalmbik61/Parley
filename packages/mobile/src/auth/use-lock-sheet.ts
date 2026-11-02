// A sheet that closes when the app locks (plan A35b): register while open, unregister when closed or unmounted.
import { useEffect, useRef } from 'react';
import { lockSheets } from './lock-instance';

export function useCloseOnLock(open: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => (open ? lockSheets.add(() => latest.current()) : undefined), [open]);
}
