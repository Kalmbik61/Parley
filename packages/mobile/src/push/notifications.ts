// Push in the running app: foreground policy, tap → host, clear on open (D1 §12).
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { selectNeedsYouCount } from '@parley/remote-client';
import { useRemoteState } from '../runtime/use-remote';
import { useRuntimeState } from '../runtime/use-runtime';
import { runtime } from '../runtime/instance';
import { clearHostNotifications } from './clear';
import { resolvePushTarget } from './route';

/** Foreground: no banner (Inbox updates itself), badge yes. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: true }),
});

/** The slice of the expo-router `router` used here. */
export interface Navigator {
  navigate(href: string | { pathname: string; params?: Record<string, string> }): void;
}

export const UNPAIRED_TOAST = "This notification is from a Mac that isn't paired anymore";

export async function openFromPush(data: unknown, router: Navigator): Promise<void> {
  const target = resolvePushTarget(data, await runtime.hostStore.list());
  if (target.kind === 'host') {
    await runtime.selectHost(target.host.hostId);
    router.navigate('/');
  } else {
    // Unknown route: the host list (Settings → Macs) with a toast.
    router.navigate({ pathname: '/settings', params: { toast: UNPAIRED_TOAST } });
  }
}

const handled = new Set<string>();
/** A notification response is acted on once per launch: the start response comes from both the listener and `getLast…`. */
const once = (r: Notifications.NotificationResponse): boolean => {
  const id = `${r.notification.request.identifier}\u0000${r.actionIdentifier}`;
  if (handled.has(id)) return false;
  handled.add(id);
  return true;
};

/** Mount once in the root layout. */
export function usePushTaps(router: Navigator): void {
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      if (once(r)) void openFromPush(r.notification.request.content.data, router);
    });
    void Notifications.getLastNotificationResponseAsync().then((r) => {
      if (r && once(r)) void openFromPush(r.notification.request.content.data, router);
    });
    return () => sub.remove();
  }, [router]);
}

/** Clear the current host's notifications once it is shown; badge = `needsYouCount`. */
export function clearForCurrentHost(needsYouCount: number): void {
  const host = runtime.getState().host;
  if (host) void clearHostNotifications(Notifications, host, needsYouCount);
}

/** Mount once in the root layout: clears the shown host's notifications when it opens and on every return to the foreground. */
export function useClearOnOpen(): void {
  const { host } = useRuntimeState();
  const remote = useRemoteState();
  const count = remote ? selectNeedsYouCount(remote) : 0;
  useEffect(() => {
    clearForCurrentHost(count);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && clearForCurrentHost(count));
    return () => sub.remove();
  }, [host?.hostId, count]);
}
