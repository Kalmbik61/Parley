// Источник и связь job помощника: общие для хоста, моста и телефона (план голоса, C4 и B3).
import { z } from 'zod';

/** Откуда пришло поручение job: общий список для хоста, телефона и голоса (спека 2026-11-03, C4). */
export const assistantJobOriginSchema = z.enum(['island', 'telegram', 'mobile', 'reminder', 'system']);
export type AssistantJobOrigin = z.infer<typeof assistantJobOriginSchema>;

/**
 * Связь job с источником: голосовая сессия (все три поля обязательны) или текстовый режим (только `mode`). `strict`:
 * `mode: 'text'` с `delegationId` и голос без `voiceSessionId` отвергаются, а не теряют поля молча.
 */
export const assistantJobCorrelationSchema = z.union([
  z.object({ voiceSessionId: z.string().min(1), delegationId: z.string().min(1), turnId: z.string().min(1) }).strict(),
  z.object({ mode: z.literal('text') }).strict(),
]);
export type AssistantJobCorrelation = z.infer<typeof assistantJobCorrelationSchema>;
