/**
 * Протокол канала Telegram (план B): токен бота, привязка владельца, перехват опроса и состояние канала, которое
 * хост рассылает событием `telegram.changed`.
 */

import { z } from 'zod';

export const telegramMethodSchemas = {
  'telegram.setToken': z.object({ token: z.string().min(1).max(512) }),
  'telegram.clearToken': z.object({}),
  'telegram.link': z.object({}),
  'telegram.unlink': z.object({}),
  'telegram.takeOver': z.object({}),
  'telegram.status': z.object({}),
} as const;

/** Состояние опроса: выключен, идёт, перехвачен другим хостом (`conflict`) или упал (`error`). */
export type TelegramPolling = 'off' | 'ok' | 'conflict' | 'error';

export interface TelegramStatus {
  enabled: boolean;
  token: 'none' | 'set';
  botUsername: string | null;
  /** Подсказка о токене (хвост), чтобы человек узнал свой; сам токен наружу не отдаётся. */
  hint: string | null;
  owner: { username: string | null; linkedAt: string } | null;
  pendingLink: { expiresAt: string } | null;
  polling: TelegramPolling;
  error: string | null;
  lastUpdateAt: string | null;
}

export interface TelegramMethodResults {
  'telegram.setToken': { botUsername: string; hint: string };
  'telegram.clearToken': { ok: true };
  'telegram.link': { code: string; expiresAt: string; deepLink: string };
  'telegram.unlink': { ok: true };
  'telegram.takeOver': { ok: true };
  'telegram.status': TelegramStatus;
}
