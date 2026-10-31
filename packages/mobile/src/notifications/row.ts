// Pure model of the Settings notification row (D1 §11.2).
export type Permission = 'granted' | 'denied' | 'undetermined';

export type NotificationRow = { kind: 'switch'; on: boolean } | { kind: 'denied' } | { kind: 'unavailable' };

export interface RowInput {
  permission: Permission;
  /** The switch in the app (the app asks iOS to show or hide). */
  enabled: boolean;
  pushAvailable: boolean;
}

/** D1 §11.2 table: unavailable build → no switch; iOS says no → "Turned off in iOS Settings"; else the switch. */
export function notificationRow({ permission, enabled, pushAvailable }: RowInput): NotificationRow {
  if (!pushAvailable) return { kind: 'unavailable' };
  if (permission === 'denied') return { kind: 'denied' };
  return { kind: 'switch', on: permission === 'granted' && enabled };
}
