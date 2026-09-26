import { z } from 'zod';
import type { HarnasConfig } from '@harnas/core';
import type { SessionRef, WorksSnapshot } from './types.js';

export const sessionRef = z.object({
  projectPath: z.string(),
  workId: z.string(),
  sessionId: z.string(),
});

/** Схемы параметров запросов (с ответом, с числовым `id`). */
export const METHODS = {
  hello: z.object({ token: z.string(), protocol: z.number().int(), client: z.string() }),
  'host.info': z.object({}),
  'host.shutdown': z.object({}),
  'providers.list': z.object({}),
  'works.list': z.object({}),
  'works.create': z.object({ projectPath: z.string(), title: z.string(), goal: z.string() }),
  'works.delete': z.object({ projectPath: z.string(), workId: z.string() }),
  'sessions.create': z.object({
    projectPath: z.string(),
    workId: z.string().nullable(),
    provider: z.string(),
    label: z.string(),
    task: z.string(),
    parent: z.string().nullable(),
  }),
  'sessions.resume': z.object({ ref: sessionRef }),
  'sessions.stop': z.object({ ref: sessionRef }),
  'sessions.delete': z.object({ ref: sessionRef }),
  'sessions.close': z.object({ ref: sessionRef }),
  'sessions.interrupted': z.object({}),
  'sessions.resumeInterrupted': z.object({ refs: z.array(sessionRef) }),
  'pty.attach': z.object({ ref: sessionRef }),
  'pty.detach': z.object({ ref: sessionRef }),
  'wake.pause': z.object({}),
  'wake.resume': z.object({}),
  'wake.state': z.object({}),
  'settings.get': z.object({}),
  'settings.set': z.object({ key: z.string(), value: z.string() }),
  'rooms.create': z.object({
    projectPath: z.string(),
    workId: z.string(),
    title: z.string().min(1),
    members: z.array(z.string()).min(1),
  }),
  'rooms.send': z.object({
    projectPath: z.string(),
    workId: z.string(),
    roomId: z.string().nullable(),
    to: z.array(z.string()),
    text: z.string().min(1),
    kind: z.enum(['note', 'question', 'decision']),
  }),
} as const;

// Уведомления клиента — без id и без ответа: их слишком много, чтобы ждать каждое.
export const NOTIFICATIONS = {
  'pty.input': z.object({ ref: sessionRef, data: z.string() }),
  'pty.resize': z.object({ ref: sessionRef, cols: z.number().int().min(2), rows: z.number().int().min(2) }),
} as const;

export interface Results {
  hello: { hostVersion: string; protocol: number; pid: number };
  'host.info': { hostVersion: string; pid: number; startedAt: string; clients: number; liveSessions: number };
  'host.shutdown': { ok: true };
  'providers.list': { providers: Array<{ id: string; label: string; available: boolean }> };
  'works.list': WorksSnapshot;
  'works.create': { workId: string };
  'works.delete': { ok: true };
  'sessions.create': { ref: SessionRef };
  'sessions.resume': { ok: true };
  'sessions.stop': { ok: true };
  'sessions.delete': { ok: true };
  'sessions.close': { ok: true };
  'sessions.interrupted': { refs: SessionRef[] };
  'sessions.resumeInterrupted': { ok: true };
  'pty.attach': { snapshot: string; cols: number; rows: number };
  'pty.detach': { ok: true };
  'wake.pause': { paused: boolean };
  'wake.resume': { paused: boolean };
  'wake.state': { paused: boolean };
  'settings.get': { config: HarnasConfig; locked: Record<string, string> };
  'settings.set': { config: HarnasConfig };
  'rooms.create': { roomId: string };
  'rooms.send': { messageId: string };
}

export type MethodName = keyof typeof METHODS;
export type NotificationName = keyof typeof NOTIFICATIONS;

export type Params<M extends MethodName | NotificationName> = z.infer<
  (typeof METHODS & typeof NOTIFICATIONS)[M]
>;
export type Result<M extends MethodName> = Results[M];
