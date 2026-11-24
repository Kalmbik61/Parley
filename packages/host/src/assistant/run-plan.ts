/**
 * Выполнение плана карточки `actions` по шагам (спека 2026-10-28, 6.1): после клика человека хост идёт по шагам по
 * очереди, перед каждым сверяет цели со свежим снимком, подставляет итоги прошлых шагов вместо `"$N"` и останавливается
 * на первом сбое. Отката нет: сделанные шаги остаются. Снимок отстаёт от диска (наблюдатель за файлами с задержкой), поэтому
 * созданное этим же планом он мог ещё не увидеть: такую цель отвергает только снимок, что показывает её закрытой, а
 * отсутствие в снимке не отказ — функции хоста сами читают работу из базы и сами проверяют. Сами действия — функции хоста, что приходят как `PlanExecutors`
 * (проводит их задача 7); модуль не лезет ни в диск, ни в процессы.
 */

import { defaultSessionName, participantLabel, type QueueReason, type SessionRole } from '@parley/core';
import type { ActionsReport, SessionRef } from '@parley/protocol';
import { stateRefusal, type PreparedPlan, type PreparedStep, type RoomRef, type SessionPick, type WorkRef } from './actions.js';
import type { OverviewSource } from './overview.js';

export interface PlanExecutors {
  /** Свежий снимок для сверки перед шагом. */
  source(): OverviewSource;
  createWork(input: { projectPath: string; title: string; goal: string }): Promise<string>;
  createSession(input: { projectPath: string; workId: string; provider: string; label: string; task: string; role: SessionRole | null; model: string | null; lean: boolean }): Promise<{ ref: SessionRef; held: boolean; queued?: QueueReason }>;
  resume(ref: SessionRef, prompt: string | null): Promise<'started' | 'held' | 'queued'>;
  interrupt(ref: SessionRef): Promise<void>;
  sleep(ref: SessionRef): Promise<void>;
  close(ref: SessionRef): Promise<void>;
  createRoom(input: { projectPath: string; workId: string; title: string; members: string[]; lead: string }): Promise<string>;
  addMember(input: { projectPath: string; workId: string; roomId: string; sessionId: string }): Promise<void>;
  /** Письмо в комнату с упоминаниями (`withMentions` — у сервиса). */
  roomMessage(input: { projectPath: string; workId: string; roomId: string; to: string[]; text: string; kind: 'note' | 'question' | 'decision' }): Promise<void>;
  /** Письмо сессии: живой — `send`, спящей — подъём этим текстом. `string` — отказ, `null` — ушло. */
  sessionMessage(ref: SessionRef, name: string, text: string): Promise<string | null>;
  lean(): Promise<boolean>;
  /** Часы для `since` слежения за ответом (мс); без них — `Date.now`. */
  now?(): number;
  /**
   * Шаг дал сессии работу, и его эффект удался (слежение за ответом, спека автономии §6.2): `since` снят до эффекта.
   * Зовётся только для создания с задачей, подъёма с текстом и письма сессии.
   */
  gave?(work: { ref: SessionRef; name: string; kind: 'prompt'; since: number }): void;
}

/**
 * Итог действия для ответа модели (спека автономии §5.3): статус, что сделано, можно ли повторять и почему. Решение по
 * карточке (`applied`) им не является.
 */
export interface ActionOutcome {
  status: 'done' | 'partial' | 'not_done' | 'unknown';
  effects: string[];
  retry: 'safe' | 'unsafe';
  reason: string | null;
}

/**
 * Классы видов шагов (спека автономии §5.9): `auto` — шаг исполняется без клика, `click` — план с ним целиком идёт
 * обычной карточкой. На этапе 1 все виды — `auto`; вид, которого в таблице нет, считается `click`.
 */
export const STEP_CLASSES: Record<string, 'auto' | 'click'> = {
  create_work: 'auto',
  create_session: 'auto',
  wake: 'auto',
  interrupt: 'auto',
  sleep: 'auto',
  close: 'auto',
  create_room: 'auto',
  add_to_room: 'auto',
  message: 'auto',
};

/** Политика плана: `null` — весь план можно исполнить без клика; иначе причина по-английски, почему нужен клик. */
export function planClick(steps: readonly { do: string }[]): string | null {
  for (const [index, step] of steps.entries()) {
    const kind = Object.hasOwn(STEP_CLASSES, step.do) ? STEP_CLASSES[step.do] : undefined;
    if (kind === undefined) return `step ${index + 1} (${step.do}) is not known to run without a click`;
    if (kind === 'click') return `step ${index + 1} (${step.do}) always needs the person's click`;
  }
  return null;
}

/**
 * Ход исполнения плана для durable-записи: `started` — перед эффектом шага, `confirmed` — после его успешного возврата.
 * `effect` — эффект, подтверждённый внутри составного шага до его сбоя (комната создана, задача ещё отправляется).
 */
export interface PlanHooks {
  started(step: number): void;
  confirmed(step: number): void;
  effect?(step: number, what: string): void;
}

/** Что сделал шаг: на это ссылаются `"$N"` последующих шагов. */
type Output =
  | { kind: 'work'; projectPath: string; workId: string; title: string }
  | { kind: 'session'; ref: SessionRef; name: string }
  | { kind: 'room'; projectPath: string; workId: string; roomId: string; title: string };

interface ResolvedWork {
  projectPath: string;
  workId: string;
  title: string;
}
interface ResolvedRoom extends ResolvedWork {
  roomId: string;
}
interface ResolvedSession {
  ref: SessionRef;
  name: string;
  /** Созданная этим планом: её запись может ещё стоять в `pending` или не дойти до снимка, письмо и комната её принимают. */
  created: boolean;
}

const HELD_NOTE = 'waits for you to trust the folder';
// Машине тесно (спека ёмкости 2026-10-30, 4.2): запуск стоит в очереди и стартует сам, когда освободится слот.
const QUEUED_NOTE = 'is queued for a free agent slot';
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function entryOf(source: OverviewSource, projectPath: string, workId: string) {
  return source.entries.find((entry) => entry.projectPath === projectPath && entry.map.work.id === workId);
}
function sessionIdsOf(source: OverviewSource, projectPath: string, workId: string): Set<string> {
  return new Set(entryOf(source, projectPath, workId)?.map.sessions.map((session) => session.id));
}

/**
 * Выполняет план. Возвращает итоговый отчёт; ход виден через `onProgress` — он получает копию отчёта после каждой смены
 * статуса шага. `stop()` проверяется перед каждым шагом: `true` — хост закрывается, строка — причина остановки (человек
 * нажал «Stop»); идущий шаг не прерывается. `hooks` получают ход исполнения: `started(k)` — перед эффектом шага k,
 * `confirmed(k)` — после его успешного возврата.
 */
export async function runPlan(proposalId: string, plan: PreparedPlan, exec: PlanExecutors, onProgress: (report: ActionsReport) => void, stop: () => boolean | string, hooks?: PlanHooks): Promise<ActionsReport> {
  const report: ActionsReport = {
    proposalId,
    status: 'running',
    steps: plan.view.map((step) => ({ line: step.line, status: 'waiting' })),
    failedStep: null,
    reason: null,
    notes: [],
  };
  const outputs = new Map<number, Output>();
  // Копия отчёта: получатель держит её, пока выполнение идёт дальше.
  const copy = (): ActionsReport => ({ ...report, steps: report.steps.map((step) => ({ ...step })), notes: [...report.notes] });
  const progress = (): void => onProgress(copy());
  const setStatus = (index: number, status: ActionsReport['steps'][number]['status']): void => {
    const step = report.steps[index];
    if (step !== undefined) step.status = status;
    progress();
  };

  // --- ссылки шага: итог прошлого шага или известная цель, проверенная по свежему снимку ---

  function workOf(ref: WorkRef, source: OverviewSource): ResolvedWork {
    if ('step' in ref) {
      const output = outputs.get(ref.step);
      if (output?.kind !== 'work') throw new Error(`Step ${ref.step} did not create a work`);
      return output;
    }
    const entry = entryOf(source, ref.projectPath, ref.workId);
    if (entry === undefined) throw new Error(`Work "${ref.title}" is no longer in Parley`);
    if (entry.map.work.status === 'archived') throw new Error(`Work "${ref.title}" is archived`);
    return ref;
  }
  function roomOf(ref: RoomRef, source: OverviewSource): ResolvedRoom {
    if ('step' in ref) {
      const output = outputs.get(ref.step);
      if (output?.kind !== 'room') throw new Error(`Step ${ref.step} did not create a room`);
      return output;
    }
    const entry = entryOf(source, ref.projectPath, ref.workId);
    if (entry === undefined) throw new Error(`Work of room "${ref.title}" is no longer in Parley`);
    if (entry.map.work.status === 'archived') throw new Error(`Room "${ref.title}" is archived`);
    const room = entry.map.rooms.find((candidate) => candidate.id === ref.roomId);
    if (room === undefined) throw new Error(`Room "${ref.title}" is no longer in Parley`);
    if (typeof room.archivedAt === 'string') throw new Error(`Room "${ref.title}" is archived`);
    return ref;
  }
  function sessionOf(pick: SessionPick): ResolvedSession {
    if ('step' in pick) {
      const output = outputs.get(pick.step);
      if (output?.kind !== 'session') throw new Error(`Step ${pick.step} did not create an agent`);
      return { ref: output.ref, name: output.name, created: true };
    }
    return { ref: pick.ref, name: pick.name, created: false };
  }
  // Сессия, над которой шаг делает `verb`: состояние сверяется заново. Созданной планом сессии хватает не быть закрытой в снимке:
  // если снимок её ещё не видит, она принимается под именем из итога шага.
  function checked(pick: SessionPick, verb: 'wake' | 'interrupt' | 'sleep' | 'close' | 'message', source: OverviewSource): ResolvedSession {
    const resolved = sessionOf(pick);
    const session = entryOf(source, resolved.ref.projectPath, resolved.ref.workId)?.map.sessions.find((candidate) => candidate.id === resolved.ref.sessionId);
    const name = session?.label ?? resolved.name;
    if (resolved.created) {
      if (session?.lifecycle === 'closed') throw new Error(`${name} is closed`);
    } else {
      const refusal = stateRefusal(verb, name, session, source.live(resolved.ref));
      if (refusal !== null) throw new Error(refusal);
    }
    return { ...resolved, name };
  }

  // --- один шаг ---

  async function runStep(step: PreparedStep, n: number): Promise<void> {
    const source = exec.source();
    const clock = (): number => (exec.now ?? Date.now)();
    // Эффект шага начинается: до этого шаг только сверял цели и мог отказать без последствий.
    const begin = (): void => hooks?.started(n);
    switch (step.do) {
      case 'create_work': {
        begin();
        const workId = await exec.createWork({ projectPath: step.projectPath, title: step.title, goal: step.goal });
        outputs.set(n, { kind: 'work', projectPath: step.projectPath, workId, title: step.title });
        return;
      }
      case 'create_session': {
        const work = workOf(step.work, source);
        const before = sessionIdsOf(source, work.projectPath, work.workId);
        let created: { ref: SessionRef; held: boolean; queued?: QueueReason };
        let since = 0;
        try {
          const lean = await exec.lean();
          begin();
          since = clock();
          created = await exec.createSession({
            projectPath: work.projectPath,
            workId: work.workId,
            provider: step.provider,
            label: step.label,
            task: step.task,
            role: step.role,
            model: step.model,
            lean,
          });
        } catch (error) {
          // Запись могла появиться до сбоя запуска: человек увидит её в Parley как pending и не будет гадать.
          const after = exec.source();
          const map = entryOf(after, work.projectPath, work.workId)?.map;
          const appeared = map?.sessions.find((session) => !before.has(session.id));
          if (map !== undefined && appeared !== undefined) throw new Error(`${messageOf(error)}; ${participantLabel(map, appeared.id)} was created but did not start; it is in Parley as pending`);
          throw error;
        }
        const fresh = entryOf(exec.source(), created.ref.projectPath, created.ref.workId)?.map;
        // Снимок мог не успеть за диском: тогда имя — ярлык со шага или то, что ядро даёт сессии без имени.
        const name = fresh?.sessions.some((candidate) => candidate.id === created.ref.sessionId) === true ? participantLabel(fresh, created.ref.sessionId) : step.label || defaultSessionName(created.ref.sessionId);
        outputs.set(n, { kind: 'session', ref: created.ref, name });
        if (created.held) report.notes.push(`${name} ${HELD_NOTE}`);
        if (created.queued !== undefined) report.notes.push(`${name} ${QUEUED_NOTE}; it starts by itself`);
        // Работа дана, если сессия стартовала сразу: удерживаемая и стоящая в очереди задачу пока не получила.
        if (step.task.trim() !== '' && !created.held && created.queued === undefined) exec.gave?.({ ref: created.ref, name, kind: 'prompt', since });
        return;
      }
      case 'wake': {
        const target = checked(step.session, 'wake', source);
        begin();
        const since = clock();
        const outcome = await exec.resume(target.ref, step.text);
        if (outcome === 'started' && step.text !== null && step.text.trim() !== '') exec.gave?.({ ref: target.ref, name: target.name, kind: 'prompt', since });
        if (outcome === 'held') report.notes.push(`${target.name} ${HELD_NOTE}`);
        if (outcome === 'queued') report.notes.push(`${target.name} ${QUEUED_NOTE}; send the text again after it starts`);
        return;
      }
      case 'interrupt': {
        const target = checked(step.session, 'interrupt', source);
        begin();
        await exec.interrupt(target.ref);
        return;
      }
      case 'sleep': {
        const target = checked(step.session, 'sleep', source);
        begin();
        await exec.sleep(target.ref);
        return;
      }
      case 'close': {
        const target = checked(step.session, 'close', source);
        begin();
        await exec.close(target.ref);
        return;
      }
      case 'create_room': {
        const work = workOf(step.work, source);
        const members = step.members.map((pick) => checked(pick, 'message', source));
        const lead = checked(step.lead, 'message', source);
        begin();
        const roomId = await exec.createRoom({ projectPath: work.projectPath, workId: work.workId, title: step.title, members: members.map((member) => member.ref.sessionId), lead: lead.ref.sessionId });
        outputs.set(n, { kind: 'room', projectPath: work.projectPath, workId: work.workId, roomId, title: step.title });
        if (step.task !== null) {
          hooks?.effect?.(n, `room "${step.title}" created`);
          try {
            await exec.roomMessage({ projectPath: work.projectPath, workId: work.workId, roomId, to: [], text: step.task, kind: 'note' });
          } catch (error) {
            throw new Error(`room "${step.title}" was created, but its task was not sent: ${messageOf(error)}`);
          }
        }
        return;
      }
      case 'add_to_room': {
        const room = roomOf(step.room, source);
        const target = checked(step.session, 'message', source);
        begin();
        await exec.addMember({ projectPath: room.projectPath, workId: room.workId, roomId: room.roomId, sessionId: target.ref.sessionId });
        return;
      }
      case 'message': {
        if (step.room !== null) {
          const room = roomOf(step.room, source);
          const to = step.to.map((pick) => checked(pick, 'message', source).ref.sessionId);
          begin();
          await exec.roomMessage({ projectPath: room.projectPath, workId: room.workId, roomId: room.roomId, to, text: step.text, kind: step.kind ?? 'note' });
          return;
        }
        if (step.session === null) throw new Error('The message has no target');
        const target = checked(step.session, 'message', source);
        begin();
        const since = clock();
        const refusal = await exec.sessionMessage(target.ref, target.name, step.text);
        if (refusal !== null) throw new Error(refusal);
        exec.gave?.({ ref: target.ref, name: target.name, kind: 'prompt', since });
        return;
      }
    }
  }

  for (const [index, step] of plan.steps.entries()) {
    const stopping = stop();
    if (stopping === false) setStatus(index, 'running');
    let failure: string | null = null;
    try {
      if (stopping !== false) throw new Error(stopping === true ? 'Parley is stopping' : stopping);
      await runStep(step, index + 1);
    } catch (error) {
      failure = messageOf(error);
    }
    if (failure === null) {
      // Эффект шага вернулся: шаг сделан, даже если его подтверждение не записалось. Тогда следующие шаги не начинаются.
      let unrecorded: string | null = null;
      try {
        hooks?.confirmed(index + 1);
      } catch (error) {
        unrecorded = messageOf(error);
      }
      setStatus(index, 'done');
      if (unrecorded === null) continue;
      report.status = 'stopped';
      report.failedStep = index + 1;
      report.reason = `step ${index + 1} was done, but Parley could not record it (${unrecorded}); later steps were not started`;
      for (let rest = index + 1; rest < report.steps.length; rest += 1) {
        const skipped = report.steps[rest];
        if (skipped !== undefined) skipped.status = 'skipped';
      }
      progress();
      return copy();
    }
    report.status = 'stopped';
    report.failedStep = index + 1;
    report.reason = failure;
    for (let rest = index + 1; rest < report.steps.length; rest += 1) {
      const skipped = report.steps[rest];
      if (skipped !== undefined) skipped.status = 'skipped';
    }
    setStatus(index, 'failed');
    return copy();
  }
  report.status = 'done';
  return copy();
}

/**
 * Итог законченного плана для модели (спека автономии §5.3). `started` — шаги, чей эффект был начат: шаг, упавший до
 * эффекта, — отказ без последствий; упавший после — исход шага неизвестен. `partial` — эффекты, подтверждённые внутри
 * упавшего составного шага (`PlanHooks.effect`): с ними итог — `partial`.
 */
export function planOutcome(report: ActionsReport, started: ReadonlySet<number>, partial: ReadonlyMap<number, readonly string[]> = new Map()): ActionOutcome {
  const done = report.steps.filter((step) => step.status === 'done').map((step) => step.line);
  const notes = report.notes.length === 0 ? null : report.notes.join('; ');
  // Все шаги сделаны (в том числе когда не записалось подтверждение последнего): действие выполнено целиком.
  if (report.status !== 'stopped' || report.steps.every((step) => step.status === 'done')) {
    const reason = [report.status === 'stopped' ? report.reason : null, notes].filter((part) => part !== null).join('; ');
    return { status: 'done', effects: done, retry: 'unsafe', reason: reason === '' ? null : reason };
  }
  const at = report.failedStep ?? report.steps.length;
  const inside = partial.get(at) ?? [];
  const effects = [...done, ...inside];
  // Шаг остановки сделан (не записалось подтверждение) или его эффект известен — «мог случиться» не про него.
  const touched = report.steps[at - 1]?.status !== 'done' && started.has(at) && inside.length === 0;
  const reason = `stopped at step ${at} of ${report.steps.length}: ${report.reason ?? 'unknown reason'}${touched ? `; step ${at} may have taken effect` : ''}`;
  if (effects.length > 0) return { status: 'partial', effects, retry: 'unsafe', reason };
  if (touched) return { status: 'unknown', effects: [], retry: 'unsafe', reason };
  return { status: 'not_done', effects: [], retry: 'safe', reason };
}
