import { z } from 'zod';
import type { HarnasConfig, MergeCheck, MergeResult, ProjectChanges, WorktreeDiff } from '@harnas/core';
import type { SendResult, SessionRef, WorksSnapshot } from './types.js';

export const sessionRef = z.object({
  projectPath: z.string(),
  workId: z.string(),
  sessionId: z.string(),
});

/** Края названия работы: пробелы и невидимые символы формата (ZWSP, ZWNJ, ZWJ, WJ, BOM). */
const TITLE_EDGES = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

/** Схемы параметров запросов (с ответом, с числовым `id`). */
export const METHODS = {
  hello: z.object({ token: z.string(), protocol: z.number().int(), client: z.string() }),
  'host.info': z.object({}),
  'host.shutdown': z.object({}),
  'providers.list': z.object({}),
  'works.list': z.object({}),
  'works.create': z.object({ projectPath: z.string(), title: z.string(), goal: z.string() }),
  'works.delete': z.object({ projectPath: z.string(), workId: z.string() }),
  // Предел — по кодовым точкам: `.max(120)` zod считает UTF-16, эмодзи шло бы за два.
  // Сырой предел 480 единиц UTF-16 (4 × 120) — `title.length`, O(1): отсекает
  // заведомый мусор до обрезки и обхода по кодовым точкам. Обрезка — та же, что
  // у `renameWork` в core: невидимые символы формата по краям считаются
  // пробелами, иначе название из одних ZWSP прошло бы.
  'works.rename': z.object({
    projectPath: z.string(),
    workId: z.string(),
    title: z
      .string()
      .refine((title) => title.length <= 480, { abort: true })
      .transform((title) => title.replace(TITLE_EDGES, ''))
      .pipe(
        z
          .string()
          .min(1)
          .refine((title) => [...title].length <= 120),
      ),
  }),
  'works.setStatus': z.object({
    projectPath: z.string(),
    workId: z.string(),
    status: z.enum(['active', 'done', 'archived']),
  }),
  'sessions.create': z.object({
    projectPath: z.string(),
    workId: z.string().nullable(),
    provider: z.string(),
    label: z.string(),
    task: z.string(),
    parent: z.string().nullable(),
    worktree: z.boolean().optional(),
    // Модель и усилие из диалога запуска (дизайн комнат, 3.2). Провайдер без флага их отбрасывает
    // — окно узнаёт об этом из `providers.list`. Модель — одно слово: алиас или полное имя,
    // без пробелов и не с дефиса (CLI принял бы её за флаг); усилие — общий для обоих CLI набор.
    model: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\s-]\S*$/)
      .optional(),
    effort: z.enum(['low', 'medium', 'high']).optional(),
  }),
  'sessions.resume': z.object({ ref: sessionRef }),
  'sessions.stop': z.object({ ref: sessionRef }),
  'sessions.delete': z.object({ ref: sessionRef, force: z.boolean().optional() }),
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
    // Ведущий — один из `members`; без него хост берёт первого (дизайн комнат, 3.2). Старый хост
    // поле отбросит, старое окно его не шлёт.
    lead: z.string().optional(),
  }),
  // Дизайн комнат, 3.2: человек вводит сессию в комнату; она уходит из прочих комнат работы.
  'rooms.addMember': z.object({
    projectPath: z.string(),
    workId: z.string(),
    roomId: z.string(),
    sessionId: z.string(),
  }),
  // Ответ человека на решение ведущего. Устаревший `proposalId` хост отвергает как `conflict`;
  // заметка возврата — до 4000 знаков, длиннее не проходит схему.
  'rooms.resolveProposal': z.object({
    projectPath: z.string(),
    workId: z.string(),
    roomId: z.string(),
    proposalId: z.string(),
    action: z.enum(['accept', 'return']),
    note: z.string().max(4000).optional(),
  }),
  'rooms.send': z.object({
    projectPath: z.string(),
    workId: z.string(),
    roomId: z.string().nullable(),
    to: z.array(z.string()),
    text: z.string().min(1),
    kind: z.enum(['note', 'question', 'decision']),
  }),
  'worktrees.available': z.object({ projectPath: z.string() }),
  // `patch` только добавлен: старый хост его отбросит, старое окно не шлёт. false — `patch: ''`.
  'worktrees.diff': z.object({ ref: sessionRef, patch: z.boolean().optional() }),
  'worktrees.commit': z.object({ ref: sessionRef, message: z.string().min(1) }),
  'worktrees.merge': z.object({ ref: sessionRef }),
  'worktrees.discard': z.object({ ref: sessionRef, force: z.boolean() }),
  // Этап 8: конфликты до слияния и изменения папки проекта для сессии без worktree (спека 3.2, 11.5).
  'worktrees.mergeCheck': z.object({ ref: sessionRef }),
  'changes.project': z.object({ ref: sessionRef, patch: z.boolean().optional() }),
  'changes.commitProject': z.object({ ref: sessionRef, message: z.string().min(1).max(10000) }),
  // Пачка окна — до 500 id (500 мс тишины); пустую слать незачем.
  'mail.markRead': z.object({
    projectPath: z.string(),
    workId: z.string(),
    messageIds: z.array(z.string()).min(1).max(500),
  }),
  // Предел 64 КиБ хост считает в байтах UTF-8 после очистки (спека 8.6, шаг 2): схема
  // байтов не видит, поэтому здесь только «не пусто».
  'pty.send': z.object({ ref: sessionRef, text: z.string().min(1), submit: z.boolean() }),
} as const;

// Уведомления клиента — без id и без ответа: их слишком много, чтобы ждать каждое.
export const NOTIFICATIONS = {
  'pty.input': z.object({ ref: sessionRef, data: z.string() }),
  'pty.resize': z.object({ ref: sessionRef, cols: z.number().int().min(2), rows: z.number().int().min(2) }),
  // Окно видит терминал сессии — «просмотрено» ставит видимость, а не подключение (спека 7.2).
  'activity.seen': z.object({ ref: sessionRef }),
} as const;

export interface Results {
  /** `methods` — все методы и уведомления хоста; нет поля — хост до этапа 3 (спека 3.2). */
  hello: { hostVersion: string; protocol: number; pid: number; methods?: string[] };
  'host.info': { hostVersion: string; pid: number; startedAt: string; clients: number; liveSessions: number };
  'host.shutdown': { ok: true };
  'providers.list': {
    providers: Array<{
      id: string;
      label: string;
      available: boolean;
      /**
       * Закрытый список моделей. `null` — списка нет: у Claude Code и Codex документация его не
       * даёт (`--model` принимает и алиас, и полное имя), а провайдер без флага модель не принимает.
       */
      models: string[] | null;
      /** Принимает ли провайдер усилие при запуске: нет — окно прячет контрол. */
      effort: boolean;
      /** Версия CLI из пробы на старте хоста; `null` — не узнали. */
      version: string | null;
    }>;
  };
  'works.list': WorksSnapshot;
  'works.create': { workId: string };
  'works.delete': { ok: true };
  'works.rename': { ok: true };
  'works.setStatus': { ok: true };
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
  /** `messageId` — системная строка ленты «@s04 joined the room». */
  'rooms.addMember': { messageId: string };
  /** `messageId` — сообщение `decision` при `accept`, письмо ведущему при `return`. */
  'rooms.resolveProposal': { messageId: string };
  'rooms.send': { messageId: string };
  'worktrees.available': { available: boolean };
  'worktrees.diff': WorktreeDiff;
  'worktrees.commit': { commit: string };
  'worktrees.merge': MergeResult;
  'worktrees.discard': { ok: true };
  'worktrees.mergeCheck': MergeCheck;
  'changes.project': ProjectChanges;
  'changes.commitProject': { commit: string };
  'mail.markRead': { marked: number };
  'pty.send': SendResult;
}

export type MethodName = keyof typeof METHODS;
export type NotificationName = keyof typeof NOTIFICATIONS;

export type Params<M extends MethodName | NotificationName> = z.infer<
  (typeof METHODS & typeof NOTIFICATIONS)[M]
>;
export type Result<M extends MethodName> = Results[M];
