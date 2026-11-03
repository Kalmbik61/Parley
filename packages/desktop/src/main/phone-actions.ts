import path from 'node:path';
import { phoneActionEvent, type PhoneActionEvent } from '@parley/protocol/remote';
import { S } from '../shared/strings.js';

const TEXT = S.settings.remote.phoneAction;

export type PhoneAction = PhoneActionEvent;

/** Parses the raw `phone.action` control event with the protocol schema. */
export function parsePhoneAction(data: unknown): PhoneAction | null {
  const parsed = phoneActionEvent.safeParse(data);
  return parsed.success ? parsed.data : null;
}

const clip = (value: string): string => (value.length > 120 ? `${value.slice(0, 119)}…` : value);

/** Title of the work a session `ref` belongs to; `null` when the window does not know the work. */
export type WorkTitleLookup = (ref: { projectPath: string; workId: string }) => Promise<string | null>;

const baseName = (folder: string): string => path.basename(folder.replace(/\/+$/, '')) || folder;

/**
 * What the notification names: the work title, then basename(projectPath) only for an unknown work; the repo name for MCP.
 * For `session-close`, `room-archive`, `room-delete` and a direct `provider-switch` it is the work too; the session label comes from `action.target`.
 */
async function targetText(target: PhoneAction['target'], workTitle: WorkTitleLookup | undefined): Promise<string> {
  if (typeof target === 'string') return target;
  if ('repo' in target) return baseName(target.repo);
  const title = await workTitle?.(target).catch(() => null);
  return title && title.trim() !== '' ? title : path.basename(target.projectPath) || target.projectPath;
}

/** Same work (or same string target) = same coalescing key; two folders trusted in a row both notify. */
const targetKey = (target: PhoneAction['target']): string =>
  typeof target === 'string'
    ? target
    : 'repo' in target
      ? `${target.repo}\0${target.servers.join('\0')}`
      : 'label' in target
        ? // One key per session (or room): closing, moving, archiving or deleting the same one twice in 10 s notifies once.
          `${target.projectPath}\0${target.workId}\0${'roomId' in target ? target.roomId : target.sessionId}`
        : `${target.projectPath}\0${target.workId}`;

/** `target` is the already resolved text (see `targetText`); `mcp-enable` also lists the server names of `action.target`. */
export function phoneActionBody(action: Pick<PhoneAction, 'kind'> & { target?: PhoneAction['target'] }, target: string): string {
  switch (action.kind) {
    case 'trust-folder':
      return TEXT.trustFolder(baseName(target));
    case 'mcp-enable': {
      const servers = typeof action.target === 'object' && 'servers' in action.target ? action.target.servers : [];
      return TEXT.mcpEnable(servers.length, clip(target), clip(servers.join(', ')));
    }
    case 'allow-always':
      return TEXT.allowAlways(clip(target));
    case 'plan-auto-accept':
      return TEXT.planAutoAccept;
    case 'provider-switch': {
      // A direct switch from the phone names the session, its work and the provider; the agent-switch card only the provider.
      if (typeof action.target === 'object' && 'provider' in action.target) {
        return TEXT.providerMove(clip(action.target.label), clip(target), clip(action.target.provider));
      }
      return TEXT.providerSwitch(clip(target));
    }
    case 'session-create':
      return TEXT.sessionStart(clip(target));
    case 'room-archive':
    case 'room-delete': {
      const label = typeof action.target === 'object' && 'label' in action.target ? action.target.label : '';
      return (action.kind === 'room-archive' ? TEXT.roomArchive : TEXT.roomDelete)(clip(label), clip(target));
    }
    case 'session-close': {
      const label = typeof action.target === 'object' && 'label' in action.target ? action.target.label : '';
      return TEXT.sessionClose(clip(label), clip(target));
    }
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
  workTitle?: WorkTitleLookup;
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
      body: phoneActionBody(action, await targetText(action.target, options.workTitle)),
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
      const key = `${action.deviceId}\0${action.kind}\0${targetKey(action.target)}`;
      const at = now();
      const previous = lastShown.get(key);
      if (previous !== undefined && at - previous < PHONE_ACTION_COALESCE_MS) return;
      lastShown.set(key, at);
      void show(action).catch((error) => console.warn('[parley] phone action notification failed', error));
    },
  };
}
