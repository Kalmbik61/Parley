/**
 * Разбор и проверка плана карточки `actions` (спека 2026-10-28, 6.1 и 6.4): модель присылает шаги как JSON, хост
 * разбирает весь план сразу и отказывает целиком, если хоть один шаг не годится. Модуль чистый: снимок работ, роли и
 * реестр провайдеров приходят снаружи (`PlanContext`); на диск и в процессы он не лезет. Выполняет план `run-plan.ts`.
 *
 * Разбор полей — вручную, как у остальных инструментов помощника: у хоста нет зависимости от zod, она есть только у
 * протокола.
 */

import {
  participantLabel,
  providerLabel,
  roleFromId,
  sessionDotStateWithNeed,
  type ProviderEntry,
  type RoleSummary,
  type SessionLifecycle,
  type SessionRole,
  type WorkMap,
  type WorkSession,
} from '@parley/core';
import { sessionNeed } from '@parley/core/attention';
import type { ActionStepView, ActionVerb, SessionRef } from '@parley/protocol';
import type { SessionLive } from '../activity/activity-service.js';
import type { AssistantReply } from './assistant-endpoint.js';
import { chooseProvider, resolveProject, resolveRole } from './new-agent.js';
import { projectLabel, resolveTarget, targetsOf, type AssistantTarget, type OverviewSource } from './overview.js';

export const MAX_STEPS = 20;
const MAX_TEXT = 4000;
const MAX_TITLE = 80;
/** Сколько знаков текста под шагом видит человек: у карточки из одного шага больше, чем у каждого из нескольких. */
const SHOWN_SINGLE = 1500;
const SHOWN_MANY = 300;
const VERBS: readonly ActionVerb[] = ['create_work', 'create_session', 'wake', 'interrupt', 'sleep', 'close', 'create_room', 'add_to_room', 'message'];
const MESSAGE_KINDS = ['note', 'question', 'decision'] as const;

export type WorkRef = { step: number } | { projectPath: string; workId: string; title: string };
export type RoomRef = { step: number } | { projectPath: string; workId: string; roomId: string; title: string };
/** Сессия шага: созданная этим планом (`step`) или известная (`ref`); `name` — как её называет карточка. */
export type SessionPick = { step: number; name: string } | { ref: SessionRef; name: string };
export type PreparedStep =
  | { do: 'create_work'; projectPath: string; title: string; goal: string }
  | { do: 'create_session'; work: WorkRef; label: string; role: SessionRole | null; provider: string; model: string | null; task: string }
  | { do: 'wake'; session: SessionPick; text: string | null }
  | { do: 'interrupt' | 'sleep' | 'close'; session: SessionPick }
  | { do: 'create_room'; work: WorkRef; title: string; members: SessionPick[]; lead: SessionPick; task: string | null }
  | { do: 'add_to_room'; room: RoomRef; session: SessionPick }
  | { do: 'message'; room: RoomRef | null; session: SessionPick | null; text: string; kind: 'note' | 'question' | 'decision' | null; to: SessionPick[] };

export interface PreparedPlan {
  steps: PreparedStep[];
  view: ActionStepView[];
  target: string;
  where: string;
  text: string;
}

export interface PlanContext {
  source: OverviewSource;
  roles(projectPath: string): Promise<readonly RoleSummary[]>;
  registry: Readonly<Record<string, ProviderEntry>>;
  ready(entry: ProviderEntry): Promise<string | null>;
  fallbackProvider: string | null;
}

/**
 * Почему с этой сессией нельзя сделать `verb` сейчас; `null` — можно. Общая для проверки при предложении и перед шагом.
 * Нет сессии в карте — как закрытая.
 */
export function stateRefusal(verb: 'wake' | 'interrupt' | 'sleep' | 'close' | 'message', name: string, session: WorkSession | undefined, live: SessionLive | undefined): string | null {
  const lifecycle = session?.lifecycle;
  const unreachable = lifecycle === undefined || lifecycle === 'closed' ? `${name} is closed` : lifecycle === 'pending' ? `${name} has not started yet` : null;
  switch (verb) {
    case 'message':
      return unreachable;
    case 'close':
      return lifecycle === undefined || lifecycle === 'closed' ? unreachable : null;
    case 'wake':
      return lifecycle === 'sleeping' ? null : lifecycle === 'active' ? `${name} is already awake` : unreachable;
    case 'sleep':
      return lifecycle === 'active' ? null : lifecycle === 'sleeping' ? `${name} is already asleep` : unreachable;
    case 'interrupt': {
      if (lifecycle === 'sleeping') return `${name} is asleep`;
      if (session === undefined || lifecycle !== 'active') return unreachable;
      const state = sessionDotStateWithNeed(session, live?.activity.activity ?? null, sessionNeed(session, live?.activity ?? null));
      return state === 'working' || state === 'blocked' ? null : `${name} is not doing anything right now`;
    }
  }
}

/**
 * Сессия работы по id, имени («S03», «S03 Ruslan») или полному id цели; закрытые тоже находятся — о них скажет `unreachable`.
 * Полный id принимается только этой работы (`prefix`): номера сессий у каждой работы свои, чужой `s-03` не подходит.
 */
export function memberOf(map: WorkMap, wanted: string, prefix: string): { session: { id: string; name: string; lifecycle: SessionLifecycle } } | AssistantReply {
  const key = wanted.trim().toLowerCase();
  const all = map.sessions.map((session) => ({ id: session.id, name: participantLabel(map, session.id), lifecycle: session.lifecycle }));
  const matches = all.filter((session) => key !== '' && (session.id.toLowerCase() === key || key === `session:${prefix}:${session.id}`.toLowerCase() || session.name.toLowerCase() === key || session.name.toLowerCase().split(' ')[0] === key));
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return { session: only };
  if (matches.length > 1) return { status: 400, body: { error: `"${wanted}" matches several sessions of "${map.work.title}": ${matches.map((session) => session.name).join(', ')}` } };
  return { status: 404, body: { error: `No session "${wanted}" in work "${map.work.title}". Call parley_overview for the current ids.` } };
}

// --- разбор полей шага ---

/** Отказ шага: сообщение уйдёт модели с номером шага впереди. */
class Refusal extends Error {}
function refuse(message: string): never {
  throw new Refusal(message);
}

type Raw = Readonly<Record<string, unknown>>;

/** Строка поля без пробелов по краям; нет поля — пустая строка. */
function readText(raw: Raw, name: string, max = MAX_TEXT): string {
  const value = raw[name];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return refuse(`${name} must be a string`);
  const text = value.trim();
  return text.length > max ? refuse(`${name} is longer than ${max} characters`) : text;
}
function readRequired(raw: Raw, name: string): string {
  const text = readText(raw, name);
  return text === '' ? refuse(`${name} is required`) : text;
}
/** Название работы, комнаты или агента: 1…80 знаков; у необязательного пустое — «не названо». */
function readTitle(raw: Raw, name: string, required: boolean): string {
  const value = raw[name];
  if (value === undefined || value === null) return required ? refuse(`${name} is required`) : '';
  if (typeof value !== 'string') return refuse(`${name} must be a string`);
  const title = value.trim();
  if (title === '') return required ? refuse(`${name} is required`) : '';
  return title.length > MAX_TITLE ? refuse(`${name} must be 1–${MAX_TITLE} characters`) : title;
}
function readList(raw: Raw, name: string): string[] {
  const value = raw[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return refuse(`${name} must be a list of strings`);
  return (value as string[]).map((item) => item.trim()).filter((item) => item !== '');
}
function readKind(raw: Raw): (typeof MESSAGE_KINDS)[number] | null {
  const value = raw['kind'];
  if (value === undefined || value === null || value === '') return null;
  return MESSAGE_KINDS.find((kind) => kind === value) ?? refuse('kind must be note, question or decision');
}

const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// --- что план знает о работах, пока разбирается ---

interface WorkInfo {
  ref: WorkRef;
  /** Общий ключ работы: известная — путь проекта и id, созданная планом — номер шага. */
  key: string;
  title: string;
  projectPath: string;
  /** Для известной работы: её карта и приставка id целей; у созданной планом — `null`. */
  known: { workId: string; prefix: string; map: WorkMap } | null;
}
/** Что создаёт шаг плана: на него ссылаются `"$N"` последующих шагов. */
type Made =
  | { kind: 'work'; work: WorkInfo }
  | { kind: 'session'; work: WorkInfo; display: string }
  | { kind: 'room'; work: WorkInfo; key: string; title: string };
interface RoomInfo {
  ref: RoomRef;
  key: string;
  title: string;
  work: WorkInfo;
}
interface Picked {
  key: string;
  name: string;
  pick: SessionPick;
  /** Известная сессия: её запись в карте и ref; созданная планом — `null`. */
  known: { ref: SessionRef; session: WorkSession | undefined } | null;
}
/** Комната в ходе разбора: состав меняется по шагам плана, чтобы «уже в комнате» и «покинет комнату» были верны. */
interface RoomState {
  title: string;
  workKey: string;
  members: Array<{ key: string; name: string }>;
}
interface Planned {
  step: PreparedStep;
  verb: ActionVerb;
  line: string;
  /** Текст, который уйдёт агенту или в комнату; пусто — нечего показать. */
  text: string;
  danger: boolean;
  /** Известная работа шага (для строки «где»); у шагов только над созданным планом — `null`. */
  work: WorkInfo | null;
}

const refKey = (ref: SessionRef): string => `${ref.projectPath}|${ref.workId}|${ref.sessionId}`;

/**
 * Разбирает и проверяет план целиком. Отказ — `{ error }` с номером шага (`Step 3: …`), модель правит план и зовёт
 * инструмент снова. Состояние сессий сверяется со снимком сейчас; перед каждым шагом `run-plan.ts` сверяет заново.
 */
export async function preparePlan(input: unknown, ctx: PlanContext): Promise<{ plan: PreparedPlan } | { error: string }> {
  const list = typeof input === 'object' && input !== null ? (input as Raw)['steps'] : undefined;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_STEPS) return { error: `A plan has 1 to ${MAX_STEPS} steps.` };

  const { source } = ctx;
  const everything = targetsOf(source, { hidden: true });
  const open = everything.filter((target) => target.hidden === undefined);
  const hidden = everything.filter((target) => target.hidden !== undefined);
  const verbs = new Map<number, ActionVerb>();
  const made = new Map<number, Made>();
  const rooms = new Map<string, RoomState>();
  const loaded = new Set<string>();
  const roleCache = new Map<string, Promise<readonly RoleSummary[]>>();

  const rolesOf = (projectPath: string): Promise<readonly RoleSummary[]> => {
    const cached = roleCache.get(projectPath);
    if (cached !== undefined) return cached;
    const asked = ctx.roles(projectPath);
    roleCache.set(projectPath, asked);
    return asked;
  };

  // `"$N"`: номер шага или `null`, если это не ссылка. Ссылаться можно только назад.
  function stepRef(wanted: string, n: number): number | null {
    const match = /^\$(\d+)$/.exec(wanted.trim());
    if (match === null) return null;
    const step = Number(match[1]);
    if (step >= n) return refuse(`"$${step}" points to a later step`);
    if (step < 1) return refuse(`"$${step}" is not a step of this plan`);
    return step;
  }
  function madeBy<K extends Made['kind']>(step: number, kind: K): Extract<Made, { kind: K }> {
    const item = made.get(step);
    if (item === undefined) return refuse(`"$${step}" is a ${verbs.get(step) ?? 'later'} step, not a ${kind}`);
    if (item.kind !== kind) return refuse(`"$${step}" is a ${item.kind}, not a ${kind}`);
    return item as Extract<Made, { kind: K }>;
  }

  // Известная цель из снимка; скрытая (закрытая, архивная) для шагов не годится.
  function knownTarget(wanted: string): AssistantTarget {
    const found = resolveTarget(open, wanted, { hidden });
    if ('error' in found) return refuse(found.error);
    const { target } = found;
    if (target.hidden !== undefined) return refuse(`${target.name} is ${target.hidden}; reopen it in Parley first`);
    return target;
  }
  function known<K extends AssistantTarget['kind']>(wanted: string, kind: K): Extract<AssistantTarget, { kind: K }> {
    const target = knownTarget(wanted);
    if (target.kind !== kind) return refuse(`${target.name} is a ${target.kind}, not a ${kind}`);
    return target as Extract<AssistantTarget, { kind: K }>;
  }

  function knownWork(projectPath: string, workId: string): WorkInfo {
    const entry = source.entries.find((item) => item.projectPath === projectPath && item.map.work.id === workId);
    if (entry === undefined) return refuse(`Work ${workId} is no longer in Parley`);
    const target = everything.find((item) => item.kind === 'work' && item.projectPath === projectPath && item.workId === workId);
    const title = entry.map.work.title;
    return {
      ref: { projectPath, workId, title },
      key: `${projectPath}|${workId}`,
      title,
      projectPath,
      known: { workId, prefix: target?.id.replace(/^work:/, '') ?? workId, map: entry.map },
    };
  }
  function workOf(wanted: string, n: number): WorkInfo {
    const step = stepRef(wanted, n);
    if (step !== null) return madeBy(step, 'work').work;
    const target = known(wanted, 'work');
    return knownWork(target.projectPath, target.workId);
  }

  // Комнаты известной работы со всеми участниками — один раз, до первого шага, что их трогает.
  function loadRooms(work: WorkInfo): void {
    if (work.known === null || loaded.has(work.key)) return;
    loaded.add(work.key);
    const { map } = work.known;
    for (const room of map.rooms) {
      if (typeof room.archivedAt === 'string') continue;
      rooms.set(`${work.key}|${room.id}`, {
        title: room.title,
        workKey: work.key,
        members: room.members.map((id) => ({ key: `${work.key}|${id}`, name: participantLabel(map, id) })),
      });
    }
  }
  function moveTo(picked: Picked, roomKey: string): void {
    const target = rooms.get(roomKey);
    if (target === undefined) return;
    for (const state of rooms.values()) {
      if (state.workKey === target.workKey) state.members = state.members.filter((member) => member.key !== picked.key);
    }
    target.members.push({ key: picked.key, name: picked.name });
  }
  const roomOfMember = (picked: Picked, work: WorkInfo, exceptKey: string): { key: string; title: string } | null => {
    for (const [key, state] of rooms) {
      if (state.workKey === work.key && key !== exceptKey && state.members.some((member) => member.key === picked.key)) return { key, title: state.title };
    }
    return null;
  };

  function roomOf(wanted: string, n: number): RoomInfo {
    const step = stepRef(wanted, n);
    if (step !== null) {
      const item = madeBy(step, 'room');
      return { ref: { step }, key: item.key, title: item.title, work: item.work };
    }
    const target = known(wanted, 'room');
    const work = knownWork(target.projectPath, target.workId);
    loadRooms(work);
    return {
      ref: { projectPath: target.projectPath, workId: target.workId, roomId: target.roomId, title: target.name },
      key: `${work.key}|${target.roomId}`,
      title: target.name,
      work,
    };
  }

  const sessionOf = (ref: SessionRef): WorkSession | undefined =>
    source.entries.find((entry) => entry.projectPath === ref.projectPath && entry.map.work.id === ref.workId)?.map.sessions.find((session) => session.id === ref.sessionId);
  function pickKnown(ref: SessionRef, name: string): Picked {
    return { key: refKey(ref), name, pick: { ref, name }, known: { ref, session: sessionOf(ref) } };
  }
  // Сессия работы `work` по ссылке на шаг или по имени среди сессий этой работы (правило `memberOf`).
  function sessionIn(wanted: string, work: WorkInfo, n: number): Picked {
    const step = stepRef(wanted, n);
    if (step !== null) {
      const item = madeBy(step, 'session');
      if (item.work.key !== work.key) return refuse(`the agent from step ${step} is in another work than "${work.title}"`);
      return { key: `plan:${step}`, name: item.display, pick: { step, name: item.display }, known: null };
    }
    if (work.known === null) return refuse(`No session "${wanted}" in work "${work.title}"; it is created by this plan, so name its agents as "$N"`);
    const found = memberOf(work.known.map, wanted, work.known.prefix);
    if (!('session' in found)) return refuse('error' in found.body ? found.body.error : found.body.text);
    return pickKnown({ projectPath: work.projectPath, workId: work.known.workId, sessionId: found.session.id }, found.session.name);
  }
  // Письмо и комната берут только живую или спящую сессию.
  function reachable(picked: Picked): void {
    if (picked.known === null) return;
    const refusal = stateRefusal('message', picked.name, picked.known.session, source.live(picked.known.ref));
    if (refusal !== null) refuse(refusal);
  }

  // Сессия, над которой шаг делает `verb`: только известная, и состояние должно подходить.
  function actionSession(raw: Raw, n: number, verb: 'wake' | 'interrupt' | 'sleep' | 'close'): { picked: Picked; work: WorkInfo } {
    const wanted = readRequired(raw, 'session');
    const step = stepRef(wanted, n);
    if (step !== null) {
      madeBy(step, 'session');
      return refuse(`the agent from step ${step} is created by this plan`);
    }
    const target = known(wanted, 'session');
    const picked = pickKnown(target.ref, target.name);
    const refusal = stateRefusal(verb, target.name, picked.known?.session, source.live(target.ref));
    if (refusal !== null) return refuse(refusal);
    return { picked, work: knownWork(target.ref.projectPath, target.ref.workId) };
  }

  async function plan(raw: Raw, n: number, verb: ActionVerb): Promise<Planned> {
    switch (verb) {
      case 'create_work': {
        const wanted = readRequired(raw, 'project');
        const title = readTitle(raw, 'title', true);
        const goal = readText(raw, 'goal');
        const project = resolveProject(source, wanted);
        if ('error' in project) return refuse(project.error);
        made.set(n, { kind: 'work', work: { ref: { step: n }, key: `plan:${n}`, title, projectPath: project.projectPath, known: null } });
        return { step: { do: 'create_work', projectPath: project.projectPath, title, goal }, verb, line: `Create work "${title}" in project ${project.label}`, text: '', danger: false, work: null };
      }
      case 'create_session': {
        const workWanted = readRequired(raw, 'work');
        const name = readTitle(raw, 'name', false);
        const roleWanted = readText(raw, 'role');
        const providerWanted = readText(raw, 'provider');
        const modelWanted = readText(raw, 'model');
        const task = readText(raw, 'task');
        const work = workOf(workWanted, n);
        let role: RoleSummary | null = null;
        if (roleWanted !== '') {
          const found = resolveRole(await rolesOf(work.projectPath), roleWanted);
          if ('error' in found) return refuse(found.error);
          role = found.role;
        }
        const chosen = await chooseProvider({
          role,
          provider: providerWanted === '' ? null : providerWanted,
          model: modelWanted === '' ? null : modelWanted,
          fallback: ctx.fallbackProvider,
          registry: ctx.registry,
          ready: ctx.ready,
        });
        if ('error' in chosen) return refuse(chosen.error);
        const { choice } = chosen;
        made.set(n, { kind: 'session', work, display: name === '' ? `the agent from step ${n}` : `agent "${name}" from step ${n}` });
        const parts = [`Create an agent${name === '' ? '' : ` "${name}"`} in "${work.title}"`, role === null ? null : `role ${role.name}`, providerLabel(choice.provider), choice.shownModel];
        return {
          step: { do: 'create_session', work: work.ref, label: name, role: role === null ? null : roleFromId(role.id), provider: choice.provider.id, model: choice.model, task },
          verb,
          line: parts.filter((part): part is string => part !== null).join(' · '),
          text: task,
          danger: false,
          work: work.known === null ? null : work,
        };
      }
      case 'wake': {
        const text = readText(raw, 'text');
        const { picked, work } = actionSession(raw, n, 'wake');
        return { step: { do: 'wake', session: picked.pick, text: text === '' ? null : text }, verb, line: `Wake ${picked.name}`, text, danger: false, work };
      }
      case 'interrupt':
      case 'sleep':
      case 'close': {
        const { picked, work } = actionSession(raw, n, verb);
        const line = verb === 'interrupt' ? `Stop what ${picked.name} is doing` : verb === 'sleep' ? `Put ${picked.name} to sleep` : `Close ${picked.name} for good`;
        return { step: { do: verb, session: picked.pick }, verb, line, text: '', danger: verb === 'close', work };
      }
      case 'create_room': {
        const workWanted = readRequired(raw, 'work');
        const title = readTitle(raw, 'title', true);
        const wantedMembers = readList(raw, 'members');
        if (wantedMembers.length === 0) return refuse('members is empty; name at least one session of the work');
        const leadWanted = readText(raw, 'lead');
        const task = readText(raw, 'task');
        const work = workOf(workWanted, n);
        loadRooms(work);
        const members: Picked[] = [];
        for (const wanted of wantedMembers) {
          const picked = sessionIn(wanted, work, n);
          reachable(picked);
          if (members.some((member) => member.key === picked.key)) return refuse(`${picked.name} is listed twice in members`);
          members.push(picked);
        }
        let lead: Picked | undefined = members[0];
        if (leadWanted !== '') {
          const picked = sessionIn(leadWanted, work, n);
          lead = members.find((member) => member.key === picked.key);
          if (lead === undefined) return refuse(`lead ${picked.name} is not among members`);
        }
        if (lead === undefined) return refuse('members is empty; name at least one session of the work');
        // Сессия состоит не больше чем в одной комнате работы: новая комната забирает участников из прежних.
        rooms.set(`plan:${n}`, { title, workKey: work.key, members: [] });
        for (const member of members) moveTo(member, `plan:${n}`);
        made.set(n, { kind: 'room', work, key: `plan:${n}`, title });
        const names = members.map((member) => member.name).join(', ');
        return {
          step: { do: 'create_room', work: work.ref, title, members: members.map((member) => member.pick), lead: lead.pick, task: task === '' ? null : task },
          verb,
          line: `Create room "${title}" in "${work.title}" with ${names} (lead ${lead.name})`,
          text: task,
          danger: false,
          work: work.known === null ? null : work,
        };
      }
      case 'add_to_room': {
        const roomWanted = readRequired(raw, 'room');
        const sessionWanted = readRequired(raw, 'session');
        const room = roomOf(roomWanted, n);
        const picked = sessionIn(sessionWanted, room.work, n);
        reachable(picked);
        if (rooms.get(room.key)?.members.some((member) => member.key === picked.key) === true) return refuse(`${picked.name} is already in room "${room.title}"`);
        const leaves = roomOfMember(picked, room.work, room.key);
        moveTo(picked, room.key);
        return {
          step: { do: 'add_to_room', room: room.ref, session: picked.pick },
          verb,
          line: `Add ${picked.name} to room "${room.title}"${leaves === null ? '' : ` (leaves room "${leaves.title}")`}`,
          text: '',
          danger: false,
          work: room.work.known === null ? null : room.work,
        };
      }
      case 'message': {
        const wanted = readRequired(raw, 'target');
        const text = readRequired(raw, 'text');
        const kind = readKind(raw);
        const mentions = readList(raw, 'mention');
        let room: RoomInfo | null = null;
        let session: Picked | null = null;
        const step = stepRef(wanted, n);
        if (step !== null) {
          const item = made.get(step);
          if (item === undefined) return refuse(`"$${step}" is a ${verbs.get(step) ?? 'later'} step, not a room or a session`);
          if (item.kind === 'work') return refuse(`"$${step}" is a work; message a room or a session`);
          if (item.kind === 'session') return refuse(`give the agent from step ${step} its first turn as task`);
          room = { ref: { step }, key: item.key, title: item.title, work: item.work };
        } else {
          const target = knownTarget(wanted);
          if (target.kind === 'work') return refuse(`${target.name} is a work; message a room or a session`);
          if (target.kind === 'room') {
            const work = knownWork(target.projectPath, target.workId);
            loadRooms(work);
            room = { ref: { projectPath: target.projectPath, workId: target.workId, roomId: target.roomId, title: target.name }, key: `${work.key}|${target.roomId}`, title: target.name, work };
          } else {
            session = pickKnown(target.ref, target.name);
          }
        }
        if (session !== null) {
          if (mentions.length > 0) return refuse('mention is only for rooms');
          reachable(session);
          const sleeping = session.known?.session?.lifecycle === 'sleeping';
          return {
            step: { do: 'message', room: null, session: session.pick, text, kind: null, to: [] },
            verb,
            line: `Message ${session.name}${sleeping ? ' (wakes it)' : ''}`,
            text,
            danger: false,
            work: session.known === null ? null : knownWork(session.known.ref.projectPath, session.known.ref.workId),
          };
        }
        if (room === null) return refuse('target is required');
        const to: Picked[] = [];
        for (const name of mentions) {
          const picked = sessionIn(name, room.work, n);
          const members = rooms.get(room.key)?.members ?? [];
          if (!members.some((member) => member.key === picked.key)) return refuse(`${picked.name} is not in room "${room.title}"; its members: ${members.map((member) => member.name).join(', ') || 'none'}`);
          reachable(picked);
          if (!to.some((other) => other.key === picked.key)) to.push(picked);
        }
        return {
          step: { do: 'message', room: room.ref, session: null, text, kind: kind ?? 'note', to: to.map((picked) => picked.pick) },
          verb,
          line: `Message room "${room.title}"${to.length === 0 ? '' : ` for ${to.map((picked) => picked.name).join(', ')}`}`,
          text,
          danger: false,
          work: room.work.known === null ? null : room.work,
        };
      }
    }
  }

  const planned: Planned[] = [];
  for (const [index, item] of list.entries()) {
    const n = index + 1;
    try {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return refuse('a step must be an object');
      const raw = item as Raw;
      const verb = VERBS.find((candidate) => candidate === raw['do']);
      if (verb === undefined) return refuse(`do must be one of ${VERBS.join(', ')}`);
      verbs.set(n, verb);
      planned.push(await plan(raw, n, verb));
    } catch (error) {
      if (error instanceof Refusal) return { error: `Step ${n}: ${error.message}` };
      throw error;
    }
  }

  const shown = planned.length === 1 ? SHOWN_SINGLE : SHOWN_MANY;
  const view = planned.map<ActionStepView>((item) => ({ verb: item.verb, line: item.line, text: item.text === '' ? null : shorten(item.text, shown), danger: item.danger }));
  const first = planned.find((item) => item.work !== null)?.work ?? null;
  return {
    plan: {
      steps: planned.map((item) => item.step),
      view,
      target: planned.length === 1 ? (view[0]?.line ?? '') : `${planned.length} steps`,
      where: first === null ? 'Parley' : `${first.title} · ${projectLabel(source.entries, first.projectPath, source.home)}`,
      text: ['Update Parley to confirm this card.', ...view.map((item, index) => `${index + 1}. ${item.line}`)].join('\n'),
    },
  };
}
