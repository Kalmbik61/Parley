// Opening the app clears the notifications of the opened host (D1 §12): those whose `data.route` is its route.
import type { HostRecord } from '@parley/remote-client';
import { pushDataSchema } from '@parley/protocol/remote';

export interface NotificationsLike {
  getPresentedNotificationsAsync(): Promise<Array<{ request: { identifier: string; content: { data?: unknown } } }>>;
  dismissNotificationAsync(identifier: string): Promise<void>;
  setBadgeCountAsync(count: number): Promise<boolean>;
}

export async function clearHostNotifications(n: NotificationsLike, host: HostRecord, needsYouCount: number): Promise<void> {
  try {
    for (const item of await n.getPresentedNotificationsAsync()) {
      const data = pushDataSchema.safeParse(item.request.content.data);
      if (data.success && data.data.route === host.routeId) await n.dismissNotificationAsync(item.request.identifier);
    }
    await n.setBadgeCountAsync(needsYouCount);
  } catch {
    // Cosmetic.
  }
}
