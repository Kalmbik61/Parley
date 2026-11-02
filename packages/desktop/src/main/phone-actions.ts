import path from 'node:path';
import { S } from '../shared/strings.js';

const TEXT = S.settings.remote.phoneAction;

export const PHONE_ACTION_KINDS = ['trust-folder', 'allow-always', 'plan-auto-accept', 'provider-switch', 'session-start'] as const;
export type PhoneActionKind = (typeof PHONE_ACTION_KINDS)[number];

/** Control-socket event `phone.action`. Local definition until the @parley/protocol/remote schema lands. */
export interface PhoneAction {
  deviceId: string;
  kind: PhoneActionKind;
  target: string;
}

/** The only place that reads the raw event; swap its body for the protocol schema parser later. */
export function parsePhoneAction(data: unknown): PhoneAction | null {
  if (typeof data !== 'object' || data === null) return null;
  const { deviceId, kind, target } = data as Record<string, unknown>;
  if (typeof deviceId !== 'string' || deviceId.length === 0) return null;
  if (typeof kind !== 'string' || !(PHONE_ACTION_KINDS as readonly string[]).includes(kind)) return null;
  return { deviceId, kind: kind as PhoneActionKind, target: typeof target === 'string' ? target : '' };
}

const clip = (value: string): string => (value.length > 120 ? `${value.slice(0, 119)}…` : value);

export function phoneActionBody(action: PhoneAction): string {
  switch (action.kind) {
    case 'trust-folder':
      return TEXT.trustFolder(path.basename(action.target.replace(/\/+$/, '')) || action.target);
    case 'allow-always':
      return TEXT.allowAlways(clip(action.target));
    case 'plan-auto-accept':
      return TEXT.planAutoAccept;
    case 'provider-switch':
      return TEXT.providerSwitch(clip(action.target));
    case 'session-start':
      return TEXT.sessionStart(clip(action.target));
  }
}

export interface PhoneNotificationLike {
  show(): void;
  close(): void;
  on(event: 'action' | 'click' | 'close', cb: () => void): void;
}

export const PHONE_ACTION_COALESCE_MS = 10_000;

export interface PhoneActionNotifierOptions {
  create(options: { title: string; body: string; actions: Array<{ type: 'button'; text: string }> }): PhoneNotificationLike;
  deviceName(deviceId: string): Promise<string | null>;
  focusWindow(): void;
  /** Asks the human; true = revoke. */
  confirmRevoke(deviceName: string): Promise<boolean>;
  revoke(deviceId: string): Promise<void>;
  now?: () => number;
}

export function createPhoneActionNotifier(options: PhoneActionNotifierOptions): { handle(data: unknown): void } {
  const now = options.now ?? Date.now;
  const lastShown = new Map<string, number>();
  // A reference keeps a shown notification alive until it is closed.
  const alive = new Set<PhoneNotificationLike>();

  async function show(action: PhoneAction): Promise<void> {
    const name = (await options.deviceName(action.deviceId).catch(() => null)) ?? TEXT.unknownDevice;
    const notification = options.create({
      title: TEXT.title(name),
      body: phoneActionBody(action),
      actions: [{ type: 'button', text: TEXT.revokeButton }],
    });
    alive.add(notification);
    notification.on('close', () => alive.delete(notification));
    notification.on('action', () => {
      options.focusWindow();
      void options
        .confirmRevoke(name)
        .then((ok) => (ok ? options.revoke(action.deviceId) : undefined))
        .catch((error) => console.warn('[parley] revoking a phone failed', error));
    });
    notification.show();
  }

  return {
    handle(data) {
      const action = parsePhoneAction(data);
      if (action === null) return;
      const key = `${action.deviceId}\0${action.kind}`;
      const at = now();
      const previous = lastShown.get(key);
      if (previous !== undefined && at - previous < PHONE_ACTION_COALESCE_MS) return;
      lastShown.set(key, at);
      void show(action).catch((error) => console.warn('[parley] phone action notification failed', error));
    },
  };
}
