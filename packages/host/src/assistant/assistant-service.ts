/**
 * Помощник на хосте (спека 2026-10-14, разделы 6–7): один разговор на приложение, ход — процесс CLI выбранного
 * провайдера, инструменты — через маршрут `/assistant/*` hook-сервера с токеном разговора, карточка подтверждения
 * и отправка от имени человека. Состояние для окна — событием `assistant.changed`.
 */

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ASSISTANT_DEFAULT_MODELS,
  ASSISTANT_PROVIDER_ORDER,
  assistantCodexMcp,
  assistantCommand,
  assistantCwd,
  assistantMcpJson,
  assistantPrompt,
  cardDetail,
  cardGist,
  codexInstructionsFile,
  parseClaudeLine,
  parseCodexLine,
  participantLabel,
  pendingCards,
  planRefOf,
  readLetters,
  sessionDotState,
  sessionMention,
  splitMood,
  WorkNotFoundError,
  type AssistantLanguage,
  type FeedCard,
  type FeedDecision,
  type ProviderEntry,
  type SessionLifecycle,
  type WorkMap,
} from '@parley/core';
import { feedDecision, refKey, type AssistantDetail, type AssistantProposal, type AssistantOrigin, type AssistantSettings, type AssistantState, type EventData, type EventName, type Params, type SendResult, type SessionRef } from '@parley/protocol';
import { HostError } from '../errors.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { FeedService } from '../feed/feed-service.js';
import { ASSISTANT_PATH, type AssistantReply } from './assistant-endpoint.js';
import type { WorksService } from '../works/works-service.js';
import { detailText, overviewText, resolveTarget, targetsOf, type AssistantTarget, type OverviewSource } from './overview.js';
import { isLastCheck, type Reminder, type ReminderStore } from './reminders.js';
import { appendSent, readSent } from './sent-log.js';
import { runTurn, type TurnEnd, type TurnHandle, type TurnSpec } from './turn.js';

export const ASSISTANT_IDLE_MS = 15 * 60_000;
export const ASSISTANT_TURN_MS = 60_000;
const MAX_TEXT = 4000;
const MAX_TITLE = 80;
const CARD_SHOWN = 'Shown to the person as a card; they will confirm or cancel it. Tell them in one short sentence what you prepared.';

export interface AssistantServiceDeps {
  broadcast<E extends EventName>(event: E, data: EventData<E>): void;
  works: Pick<WorksService, 'snapshot'>;
  activity: Pick<ActivityService, 'get'>;
  feed?: Pick<FeedService, 'snapshot' | 'decide'>;
  /** Общий отправитель хоста (`createSender`) — тот же, что у `pty.send`. */
  send(params: { ref: SessionRef; text: string; submit: boolean }): Promise<SendResult>;
  /**
   * Подъём спящей сессии подтверждённым текстом (`sessions.launch`). `by: 'human'` — это действие человека,
   * подтверждённое на карточке, и лимиты будильника (`resumeRate`) на него не распространяются.
   */
  launch(ref: SessionRef, mode: 'resume', options: { by: 'human'; prompt: string }): Promise<void>;
  /** `sendHumanLetter` с `via: 'assistant'`. */
  sendLetter(input: Params<'rooms.send'>): Promise<string>;
  /** `createHumanRoom`: комната из карточки `room`; возвращает id комнаты. */
  createRoom(input: Params<'rooms.create'>): Promise<string>;
  /** `resolveRoomProposal`: принять или вернуть решение ведущего из карточки `room-decision`. */
  resolveRoomProposal(input: Params<'rooms.resolveProposal'>): Promise<string>;
  /** Сервер хуков (`origin`) и приёмник помощника (`setToken`, задача 8). */
  endpoint: { origin(): string | null; setToken(token: string | null): void };
  providers(): Promise<Record<string, ProviderEntry>>;
  /** `null` — провайдер готов; иначе причина по-английски. */
  ready(entry: ProviderEntry): Promise<string | null>;
  launchEnv(entry: ProviderEntry): Promise<NodeJS.ProcessEnv>;
  binary(command: string): Promise<string>;
  /** Напоминания (`schedule_check`, `list_reminders`, `cancel_reminder`); срабатывание приходит в `onReminder`. */
  reminders: Pick<ReminderStore, 'add' | 'list' | 'cancel'>;
  home: string;
  log(line: string): void;
  /** Напоминание сработало, пока помощник выключен в настройках: канал сообщает об этом человеку. */
  onReminderWhileOff?(reminder: Reminder): void;
  run?(spec: TurnSpec, onEvent: Parameters<typeof runTurn>[1]): TurnHandle;
  now?(): number;
  idleMs?: number;
  turnTimeoutMs?: number;
}

export interface AssistantService {
  ask(params: Params<'assistant.ask'>, origin?: AssistantOrigin): Promise<void>;
  /** Слушатель состояния: зовётся после каждого `assistant.changed`. Возвращает отписку. */
  onState(listener: (state: AssistantState) => void): () => void;
  /** Зеркало настроек окна (`assistant.configure`), в памяти. */
  configure(settings: AssistantSettings): void;
  /** `null` — зеркала нет (старое окно). */
  settings(): AssistantSettings | null;
  cancel(): void;
  decide(proposalId: string, decision: 'send' | 'cancel'): Promise<{ applied: boolean; error: string | null }>;
  reset(): void;
  state(): AssistantState;
  sent(ref: SessionRef): Promise<Array<{ text: string; at: string }>>;
  tool(name: string, args: unknown): Promise<AssistantReply>;
  /** Срок напоминания (его отдаёт хост в `reminders.start`): ждёт конца идущего хода и сам запускает новый. */
  onReminder(reminder: Reminder, late: boolean): Promise<'fired' | 'skipped' | 'later' | 'retry'>;
  stop(): void;
}

interface Conversation {
  provider: string;
  model: string | null;
  language: AssistantLanguage;
  token: string;
  sessionId: string | null;
  endAfterTurn: boolean;
}

type RoomTarget = Extract<AssistantTarget, { kind: 'room' }>;
type SessionTarget = Extract<AssistantTarget, { kind: 'session' }>;
type WorkTarget = Extract<AssistantTarget, { kind: 'work' }>;

/** Ждущая карточка. Вид (`kind`) совпадает с `view.action` и сужает остальные поля; `token` — разговор, что её создал. */
type Pending = PendingBody & { token: string };
type PendingBody =
  | {
      kind: 'message';
      view: Extract<AssistantProposal, { action?: 'message' }>;
      target: RoomTarget | SessionTarget;
      /** Упомянутые участники комнаты (id сессий) — `to` письма. */
      to: string[];
    }
  | {
      kind: 'room';
      view: Extract<AssistantProposal, { action: 'room' }>;
      work: WorkTarget;
      /** id сессий-участников; `lead` — один из них. */
      members: string[];
      lead: string;
    }
  | {
      kind: 'room-decision';
      view: Extract<AssistantProposal, { action: 'room-decision' }>;
      room: RoomTarget;
    }
  | {
      kind: 'decision';
      view: Extract<AssistantProposal, { action: 'decision' }>;
      /** Сессия, чью карточку решаем; сама карточка — `view.card.cardId`. */
      ref: SessionRef;
    };

const EMPTY: AssistantState = { phase: 'idle', detail: null, question: null, answer: '', mood: 'calm', proposal: null, outcome: null, error: null, turn: 0, askId: null };

/** Вопрос, по которому запускается ход: `id` окна и билет — отмена или новый вопрос его гасят, и ход не стартует. */
interface Ask {
  id: string | null;
  ticket: number;
  origin: AssistantOrigin;
}

/** Чем кончился запуск хода: `not-ready` и `evicted` — повторять позже, `failed` — ошибка уже показана окну. */
type StartReason = 'started' | 'not-ready' | 'evicted' | 'failed';

/** Хвост комнаты из базы работы (спека хранилища 6.2). Работу могли удалить, пока её запись ещё в снимке: хвоста нет. */
const roomTailOf: OverviewSource['roomTail'] = (entry, roomId, count) => {
  try {
    return readLetters(entry.projectPath, entry.map.work.id, { roomId, limit: count, newestFirst: true }).reverse();
  } catch (error) {
    if (error instanceof WorkNotFoundError) return [];
    throw error;
  }
};

const firstLine = (text: string): string => text.split('\n')[0]?.trim() ?? '';
/** Почему сессии в этом состоянии нельзя передать сообщение; `null` — можно (`active` — отправка, `sleeping` — подъём). Нет сессии — закрыта. */
const unreachable = (name: string, lifecycle: SessionLifecycle | undefined): string | null =>
  lifecycle === undefined || lifecycle === 'closed' ? `${name} is closed` : lifecycle === 'pending' ? `${name} has not started yet` : null;
/**
 * Токены `@s03` упомянутых в начало письма, как их ставит поле комнаты; упоминание, что модель уже вписала в текст
 * (`@s03` или `@s-03` — лента комнаты считает их одним), не повторяется.
 */
const withMentions = (to: readonly string[], text: string): string => {
  const pattern = (id: string): string => {
    const digits = /^s-(\d+)$/.exec(id)?.[1];
    return digits === undefined ? `@${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` : `@s-?${digits}`;
  };
  const missing = to.filter((id) => !new RegExp(`(?<![\\p{L}\\p{N}_@])${pattern(id)}(?![\\p{L}\\p{N}_])`, 'iu').test(text));
  return missing.length === 0 ? text : `${missing.map(sessionMention).join(' ')} ${text}`;
};
/** Суть карточки по-английски для карточки помощника: что агент просит или спрашивает. */
const hostSummary = (card: FeedCard, projectPath: string): string => {
  const gist = cardGist(card, projectPath);
  switch (gist.kind) {
    case 'run':
      return `${card.toolName}: ${gist.command}`;
    case 'tool':
      return gist.path === null ? gist.tool : `${gist.tool} ${gist.path}`;
    case 'fetch':
      return `Fetch ${gist.url}`;
    case 'question':
      return `Question: ${gist.text}`;
    case 'plan':
      return 'Plan';
  }
};
const stringArg = (input: Record<string, unknown>, key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '');

function detailOf(name: string, input: Record<string, unknown>, targets: readonly AssistantTarget[]): AssistantDetail {
  if (name === 'parley_overview') return { tool: 'overview', target: null };
  if (name === 'propose_message' || name === 'propose_room' || name === 'propose_room_decision' || name === 'propose_decision') return { tool: 'propose', target: null };
  if (name === 'parley_detail') {
    const found = resolveTarget(targets, stringArg(input, 'target'));
    return { tool: 'detail', target: 'target' in found ? found.target.name : null };
  }
  return { tool: 'other', target: null };
}

export function createAssistantService(deps: AssistantServiceDeps): AssistantService {
  const run = deps.run ?? runTurn;
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? ASSISTANT_IDLE_MS;
  const dir = assistantCwd(deps.home); // та же папка, что пропускает обнаружение сессий (задача 5а)

  const instance = randomBytes(8).toString('hex');
  let state: AssistantState = { ...EMPTY, instance };
  let conversation: Conversation | null = null;
  let turn: TurnHandle | null = null;
  let pending: Pending | null = null;
  let outcomeNote: string | null = null;
  let proposals = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  /** Билет последнего вопроса: `cancel`, `reset` и новый вопрос сдвигают его, и запуск, что ещё в пути, не стартует. */
  let asks = 0;
  /** Параметры последнего вопроса человека: по ним идут ходы по напоминаниям. */
  let lastAsk: Pick<Params<'assistant.ask'>, 'provider' | 'model' | 'language'> = { provider: null, model: null, language: 'en' };
  /** Вопросы, что ещё запускают ход (`ask` не вернулся), и ждущие конца хода напоминания. */
  let inflight = 0;
  let idleWaiters: Array<() => void> = [];
  let stopped = false;
  let mirror: AssistantSettings | null = null;
  const stateListeners = new Set<(state: AssistantState) => void>();
  /** Выключенный помощник сообщает о повторяющемся напоминании один раз. */
  const notifiedOff = new Set<string>();

  const publish = (patch: Partial<AssistantState>): void => {
    state = { ...state, ...patch, instance };
    deps.broadcast('assistant.changed', state);
    for (const listener of [...stateListeners]) listener(state);
  };
  const source = (): OverviewSource => ({
    entries: deps.works.snapshot().entries,
    live: (ref) => deps.activity.get(ref),
    roomTail: roomTailOf,
  });
  /**
   * Реестр провайдеров и часы для строки `need` в обзоре (имя аккаунта и время сброса в причине); сбой реестра —
   * без имён, строка называет провайдера по id.
   */
  const reasonContext = async (): Promise<Pick<OverviewSource, 'providers' | 'now'>> => ({
    providers: await deps.providers().catch(() => undefined),
    now: new Date(now()),
  });
  const restPhase = (): AssistantState['phase'] => (pending === null ? 'idle' : 'awaiting-confirm');

  function endConversation(): void {
    conversation = null;
    deps.endpoint.setToken(null);
    outcomeNote = null;
    if (pending !== null) {
      pending = null;
      publish({ proposal: null, phase: turn === null ? 'idle' : state.phase });
    }
  }

  function touch(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (turn === null) endConversation();
    }, idleMs);
    idleTimer.unref?.();
  }

  async function pick(wanted: string | null): Promise<{ entry: ProviderEntry } | { offline: string }> {
    const registry = await deps.providers();
    // Причина — от первого провайдера, который мог бы ходить, но не готов; без единого такого — общая.
    let reason: string | null = null;
    for (const id of wanted === null ? ASSISTANT_PROVIDER_ORDER : [wanted]) {
      const entry = registry[id];
      if (entry === undefined || entry.runner.assistantArgs === undefined) {
        if (wanted !== null) reason = `${entry?.label ?? id} can't run the assistant`;
        continue;
      }
      const problem = await deps.ready(entry);
      if (problem === null) return { entry };
      reason ??= problem;
    }
    return { offline: reason ?? 'No connected provider can run the assistant — open Settings' };
  }

  async function ensure(entry: ProviderEntry, model: string | null, language: AssistantLanguage): Promise<Conversation> {
    if (conversation !== null && (conversation.provider !== entry.id || conversation.model !== model || conversation.language !== language)) {
      endConversation();
    }
    if (conversation === null) {
      conversation = { provider: entry.id, model, language, token: randomBytes(32).toString('hex'), sessionId: null, endAfterTurn: false };
      deps.endpoint.setToken(conversation.token);
    }
    return conversation;
  }

  async function files(current: Conversation, url: string): Promise<{ mcpFile: string; promptFile: string }> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const mcpFile = path.join(dir, 'mcp.json');
    const promptFile = path.join(dir, `prompt-${current.language}.md`);
    await writeFile(mcpFile, assistantMcpJson({ url, token: current.token }), { mode: 0o600 });
    await chmod(mcpFile, 0o600);
    await writeFile(promptFile, assistantPrompt(current.language), { mode: 0o600 });
    return { mcpFile, promptFile };
  }

  /** Будит ждущие напоминания, когда хода нет и вопрос не запускается; кому не досталось — ждёт снова. */
  function releaseWaiters(): void {
    if (turn !== null || inflight > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const wake of waiters) wake();
  }

  function stopTurn(): void {
    const old = turn;
    turn = null;
    old?.cancel();
    releaseWaiters();
  }

  async function start(entry: ProviderEntry, model: string | null, language: AssistantLanguage, text: string, retried: boolean, ask: Ask): Promise<StartReason> {
    const current = await ensure(entry, model, language);
    const next = state.turn + 1;
    const askId = ask.id;
    const base = deps.endpoint.origin();
    if (base === null) {
      publish({ ...EMPTY, proposal: state.proposal, phase: 'error', mood: 'error', question: text, error: 'Parley is still starting — try again', turn: next, askId, origin: ask.origin });
      return 'not-ready';
    }
    const url = `${base}${ASSISTANT_PATH}`;
    const { mcpFile, promptFile } = await files(current, url);
    const codex = entry.runner.mcpConfig === 'codex-override';
    const prompt = outcomeNote === null ? text : `${outcomeNote}\n${text}`;
    outcomeNote = null;
    const command = assistantCommand(
      entry,
      {
        prompt,
        mcpConfig: codex ? assistantCodexMcp({ url, token: current.token }) : mcpFile,
        systemPrompt: assistantPrompt(language),
        developerInstructions: codexInstructionsFile(promptFile),
        ...(model === null ? {} : { model }),
        ...(current.sessionId === null ? {} : { providerSessionId: current.sessionId }),
      },
      current.sessionId !== null,
    );
    if (command === null) {
      publish({ ...EMPTY, proposal: state.proposal, phase: 'offline', question: text, error: `${entry.label} can't run the assistant`, turn: next, askId, origin: ask.origin });
      return 'failed';
    }
    let binary: string;
    try {
      binary = await deps.binary(command.command);
    } catch {
      publish({ ...EMPTY, proposal: state.proposal, phase: 'offline', question: text, error: `${entry.label} CLI is not installed`, turn: next, askId, origin: ask.origin });
      return 'failed';
    }
    const env = await deps.launchEnv(entry);
    // Пока запуск ждал, человек отменил вопрос (закрыл остров) или задал новый: этот ход не нужен.
    // Остановка хоста во время запуска — то же самое: процесс уже не нужен.
    if (ask.ticket !== asks || stopped) return 'evicted';
    publish({ phase: 'thinking', detail: null, question: text, answer: '', mood: 'calm', outcome: null, error: null, turn: next, askId, origin: ask.origin });

    // Эмоцию решает первый текст после последнего инструмента: GLM ставит метку до инструмента отдельным блоком.
    let moodBuffer: string | null = '';
    const handle: TurnHandle = run(
      { command: binary, args: command.args, env, cwd: dir, parse: codex ? parseCodexLine : parseClaudeLine, timeoutMs: deps.turnTimeoutMs ?? ASSISTANT_TURN_MS },
      (event) => {
        if (turn !== handle) return;
        if (event.type === 'session') {
          current.sessionId = event.id;
        } else if (event.type === 'tool') {
          moodBuffer = '';
          publish({ phase: 'tool', detail: detailOf(event.name, event.input, targetsOf(source())), answer: '' });
        } else if (event.type === 'text') {
          if (moodBuffer === null) {
            publish({ phase: 'answering', detail: null, answer: state.answer + event.delta });
            return;
          }
          moodBuffer += event.delta;
          const split = splitMood(moodBuffer, false);
          if (split === null) return;
          moodBuffer = null;
          publish({ phase: 'answering', detail: null, mood: split.mood, answer: split.text });
        }
      },
    );
    turn = handle;
    // Ход идёт в фоне: `ask` возвращается, как только процесс запущен, иначе метод хоста ждал бы весь ход.
    void handle.done
      .then(async (end) => {
        if (turn !== handle) return;
        turn = null;
        if (moodBuffer !== null && moodBuffer !== '') {
          const split = splitMood(moodBuffer, true);
          if (split !== null) publish({ mood: split.mood, answer: split.text });
        }
        await finish(end, entry, model, language, text, retried, current, ask);
      })
      .catch((error: unknown) => {
        deps.log(`assistant: turn failed: ${(error as Error).message}`);
        publish({ phase: 'error', mood: 'error', detail: null, error: 'Something went wrong — try again' });
      })
      .finally(releaseWaiters);
    return 'started';
  }

  async function finish(end: TurnEnd, entry: ProviderEntry, model: string | null, language: AssistantLanguage, text: string, retried: boolean, current: Conversation, ask: Ask): Promise<void> {
    if (end.ok) {
      if (current.endAfterTurn) endConversation();
      else touch();
      publish({ phase: restPhase(), detail: null });
      return;
    }
    if (end.kind === 'cancelled') {
      publish({ phase: restPhase(), detail: null });
      return;
    }
    // Повтор без `--resume` в том же разговоре: карточка и токен остаются, а окно не видит `idle` посреди хода — иначе
    // очередь острова ушла бы вторым вопросом поверх повтора.
    if (end.kind === 'resume' && !retried && current.sessionId !== null) {
      current.sessionId = null;
      await start(entry, model, language, text, true, ask);
      return;
    }
    deps.log(`assistant: turn failed (${end.kind}): ${firstLine(end.message)}`);
    const error =
      end.kind === 'limit'
        ? `${entry.label} limit reached — ${firstLine(end.message)}`
        : end.kind === 'timeout'
          ? 'No answer in 60 s'
          : end.kind === 'start'
            ? `${entry.label} CLI didn't start`
            : 'Something went wrong — try again';
    publish({ phase: 'error', mood: 'error', detail: null, error });
  }

  async function lastReply(ref: SessionRef): Promise<string | null> {
    if (deps.feed === undefined) return null;
    try {
      const { items } = await deps.feed.snapshot(ref);
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item?.kind === 'text' && !item.streaming && item.text.trim() !== '') return item.text;
      }
    } catch {
      // ленты у сессии нет — без последнего ответа
    }
    return null;
  }

  /** Упомянутые участники комнаты (`mention`) → сессии: по id из снимка или однозначному имени среди сессий этой работы. */
  function mentionsOf(room: RoomTarget, wanted: readonly string[], src: OverviewSource, targets: readonly AssistantTarget[]): { ok: SessionTarget[] } | AssistantReply {
    const map = src.entries.find((entry) => entry.projectPath === room.projectPath && entry.map.work.id === room.workId)?.map;
    const members = map?.rooms.find((candidate) => candidate.id === room.roomId)?.members ?? [];
    const sessions = targets.filter((target): target is SessionTarget => target.kind === 'session' && target.ref.projectPath === room.projectPath && target.ref.workId === room.workId);
    const picked: SessionTarget[] = [];
    for (const name of wanted) {
      const found = resolveTarget(sessions, name);
      if ('error' in found) return { status: 404, body: { error: found.error } };
      const session = found.target as SessionTarget;
      if (!members.includes(session.ref.sessionId)) {
        const names = map === undefined ? '' : members.map((id) => participantLabel(map, id)).join(', ');
        return { status: 400, body: { error: `${session.name} is not in room "${room.name}"; its members: ${names || 'none'}` } };
      }
      const refusal = unreachable(session.name, session.lifecycle);
      if (refusal !== null) return { status: 409, body: { error: refusal } };
      if (!picked.includes(session)) picked.push(session);
    }
    return { ok: picked };
  }

  function propose(input: Record<string, unknown>, src: OverviewSource, targets: readonly AssistantTarget[]): AssistantReply {
    const text = stringArg(input, 'text').trim();
    if (text === '') return { status: 400, body: { error: 'text is empty' } };
    if (text.length > MAX_TEXT) return { status: 400, body: { error: `text is longer than ${MAX_TEXT} characters` } };
    const found = resolveTarget(targets, stringArg(input, 'target'));
    if ('error' in found) return { status: 404, body: { error: found.error } };
    const target = found.target;
    if (target.kind === 'work') return { status: 400, body: { error: `${target.name} is a work; message a room or a session` } };
    const wanted = Array.isArray(input['mention']) ? input['mention'].filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
    let mentioned: SessionTarget[] = [];
    if (target.kind === 'session') {
      if (wanted.length > 0) return { status: 400, body: { error: 'mention is only for rooms; to write to one agent directly, use its session id as the target' } };
      const refusal = unreachable(target.name, target.lifecycle);
      if (refusal !== null) return { status: 409, body: { error: refusal } };
    } else {
      const result = mentionsOf(target, wanted, src, targets);
      if (!('ok' in result)) return result;
      mentioned = result.ok;
    }
    const kind = input['kind'];
    proposals += 1;
    pending = {
      token: conversation?.token ?? '',
      kind: 'message',
      view: {
        action: 'message',
        id: `p${proposals}`,
        target: target.name,
        where: target.where,
        kind: target.kind === 'room' ? (kind === 'question' || kind === 'decision' ? kind : 'note') : null,
        text,
        mentions: mentioned.map((session) => session.name),
        wake: target.kind === 'session' && target.lifecycle === 'sleeping',
      },
      target,
      to: mentioned.map((session) => session.ref.sessionId),
    };
    publish({ proposal: pending.view, outcome: null });
    return { status: 200, body: { text: CARD_SHOWN } };
  }

  const workMap = (src: OverviewSource, target: { projectPath: string; workId: string }): WorkMap | undefined =>
    src.entries.find((entry) => entry.projectPath === target.projectPath && entry.map.work.id === target.workId)?.map;

  /**
 * Сессия работы по id, имени («S03», «S03 Ruslan») или полному id цели; закрытые тоже находятся — о них скажет `unreachable`.
 * Полный id принимается только этой работы (`prefix`): номера сессий у каждой работы свои, чужой `s-03` не подходит.
 */
  function memberOf(map: WorkMap, wanted: string, prefix: string): { session: { id: string; name: string; lifecycle: SessionLifecycle } } | AssistantReply {
    const key = wanted.trim().toLowerCase();
    const all = map.sessions.map((session) => ({ id: session.id, name: participantLabel(map, session.id), lifecycle: session.lifecycle }));
    const matches = all.filter((session) => key !== '' && (session.id.toLowerCase() === key || key === `session:${prefix}:${session.id}`.toLowerCase() || session.name.toLowerCase() === key || session.name.toLowerCase().split(' ')[0] === key));
    const [only] = matches;
    if (matches.length === 1 && only !== undefined) return { session: only };
    if (matches.length > 1) return { status: 400, body: { error: `"${wanted}" matches several sessions of "${map.work.title}": ${matches.map((session) => session.name).join(', ')}` } };
    return { status: 404, body: { error: `No session "${wanted}" in work "${map.work.title}". Call parley_overview for the current ids.` } };
  }

  function proposeRoom(input: Record<string, unknown>, src: OverviewSource, targets: readonly AssistantTarget[]): AssistantReply {
    const found = resolveTarget(targets, stringArg(input, 'work'));
    if ('error' in found) return { status: 404, body: { error: found.error } };
    const work = found.target;
    if (work.kind !== 'work') return { status: 404, body: { error: `${work.name} is not a work` } };
    const map = workMap(src, work);
    if (map === undefined) return { status: 404, body: { error: `No work "${work.name}"` } };
    const title = stringArg(input, 'title').trim();
    if (title === '' || title.length > MAX_TITLE) return { status: 400, body: { error: `title must be 1–${MAX_TITLE} characters` } };
    const wanted = Array.isArray(input['members']) ? input['members'].filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
    if (wanted.length === 0) return { status: 400, body: { error: 'members is empty; name at least one session of the work' } };
    const prefix = work.id.replace(/^work:/, '');
    const members: Array<{ id: string; name: string }> = [];
    for (const name of wanted) {
      const result = memberOf(map, name, prefix);
      if (!('session' in result)) return result;
      const { session } = result;
      const refusal = unreachable(session.name, session.lifecycle);
      if (refusal !== null) return { status: 409, body: { error: refusal } };
      if (members.some((member) => member.id === session.id)) return { status: 400, body: { error: `${session.name} is listed twice in members` } };
      members.push(session);
    }
    const leadWanted = stringArg(input, 'lead').trim();
    let lead = members[0] as { id: string; name: string };
    if (leadWanted !== '') {
      const result = memberOf(map, leadWanted, prefix);
      if (!('session' in result)) return result;
      const chosen = members.find((member) => member.id === result.session.id);
      if (chosen === undefined) return { status: 400, body: { error: `lead ${result.session.name} is not among members` } };
      lead = chosen;
    }
    const task = stringArg(input, 'task').trim();
    if (task.length > MAX_TEXT) return { status: 400, body: { error: `task is longer than ${MAX_TEXT} characters` } };
    const names = members.map((member) => member.name);
    proposals += 1;
    pending = {
      token: conversation?.token ?? '',
      kind: 'room',
      view: {
        action: 'room',
        id: `p${proposals}`,
        target: title,
        where: work.where,
        text: `Create room "${title}" with ${names.join(', ')} (lead ${lead.name})${task === '' ? '' : `\n${task}`}`,
        title,
        members: names,
        lead: lead.name,
        task: task === '' ? null : task,
      },
      work,
      members: members.map((member) => member.id),
      lead: lead.id,
    };
    publish({ proposal: pending.view, outcome: null });
    return { status: 200, body: { text: CARD_SHOWN } };
  }

  function proposeRoomDecision(input: Record<string, unknown>, src: OverviewSource, targets: readonly AssistantTarget[]): AssistantReply {
    const found = resolveTarget(targets, stringArg(input, 'target'));
    if ('error' in found) return { status: 404, body: { error: found.error } };
    const room = found.target;
    if (room.kind !== 'room') return { status: 404, body: { error: `${room.name} is not a room` } };
    const choice = input['choice'];
    if (choice !== 'accept' && choice !== 'return') return { status: 400, body: { error: 'choice must be "accept" or "return"' } };
    const map = workMap(src, room);
    const slot = map?.rooms.find((candidate) => candidate.id === room.roomId)?.proposal ?? null;
    if (map === undefined || slot === null) return { status: 409, body: { error: `${room.name} has no decision waiting` } };
    const note = stringArg(input, 'note').trim();
    if (note.length > MAX_TEXT) return { status: 400, body: { error: `note is longer than ${MAX_TEXT} characters` } };
    const kept = choice === 'return' && note !== '' ? note : null;
    proposals += 1;
    pending = {
      token: conversation?.token ?? '',
      kind: 'room-decision',
      view: {
        action: 'room-decision',
        id: `p${proposals}`,
        target: room.name,
        where: room.where,
        text: `${choice === 'accept' ? 'Accept' : 'Return'} ${room.name}: ${slot.text}`,
        proposal: {
          proposalId: slot.id,
          rev: slot.rev,
          kind: slot.kind ?? 'decision',
          from: participantLabel(map, slot.from),
          text: slot.text,
          ...(planRefOf(slot) ?? {}),
        },
        choice,
        note: kept,
      },
      room,
    };
    publish({ proposal: pending.view, outcome: null });
    return { status: 200, body: { text: CARD_SHOWN } };
  }

  /**
   * Ответы на вопросы карточки: ключ — номер вопроса (`1`, `Q1`) или его точный текст, как у окна. Покрыть нужно каждый
   * вопрос; ответ, совпавший с меткой варианта по регистру, берётся в её написании, остальное остаётся свободным текстом.
   */
  function checkAnswers(card: Extract<FeedCard, { kind: 'question' }>, given: Record<string, string>): { answers: Record<string, string> } | { error: string } {
    const answers: Record<string, string> = {};
    let unknown = false;
    for (const [rawKey, value] of Object.entries(given)) {
      const key = rawKey.trim();
      const number = /^q?(\d+)$/i.exec(key)?.[1];
      const question = card.questions.find((candidate) => candidate.question.trim() === key) ?? (number === undefined ? undefined : card.questions[Number(number) - 1]);
      if (question === undefined) {
        unknown = true;
        continue;
      }
      const labels = question.options.map((option) => option.label);
      const label = (text: string): string => labels.find((candidate) => candidate.toLowerCase() === text.trim().toLowerCase()) ?? text.trim();
      const whole = labels.find((candidate) => candidate.toLowerCase() === value.trim().toLowerCase());
      answers[question.question] = whole ?? (question.multiSelect ? value.split(', ').map(label).join(', ') : value.trim());
    }
    if (!unknown && card.questions.every((question) => (answers[question.question] ?? '') !== '')) return { answers };
    const list = card.questions
      .map((question, index) => `${index + 1}. "${question.question}"${question.options.length === 0 ? '' : ` — options: ${question.options.map((option) => option.label).join(' | ')}`} (free text allowed)`)
      .join('; ');
    return { error: `answers must cover every question, by its number or exact text: ${list}` };
  }

  async function proposeDecision(input: Record<string, unknown>, targets: readonly AssistantTarget[]): Promise<AssistantReply> {
    const found = resolveTarget(targets, stringArg(input, 'target'));
    if ('error' in found) return { status: 404, body: { error: found.error } };
    const session = found.target;
    if (session.kind !== 'session') return { status: 404, body: { error: `${session.name} is not a session` } };
    const parsed = feedDecision.safeParse(input['decision']);
    if (!parsed.success) return { status: 400, body: { error: 'decision must be {kind:"permission",behavior:"allow"|"deny"}, {kind:"question",answers:{...}} or {kind:"plan",choice:"auto-accept"|"manual"}' } };
    let decision: FeedDecision = parsed.data;
    if (deps.feed === undefined) return { status: 409, body: { error: `${session.name} has no feed to answer` } };
    let snapshot: Awaited<ReturnType<NonNullable<typeof deps.feed>['snapshot']>>;
    try {
      snapshot = await deps.feed.snapshot(session.ref, undefined, 'attention');
    } catch {
      return { status: 409, body: { error: `${session.name} has no feed to answer` } };
    }
    if (snapshot.decisions === 'terminal') return { status: 409, body: { error: `${session.name} answers at your Mac only` } };
    const cards = pendingCards(snapshot.items).filter((card) => card.kind === decision.kind);
    const projectPath = session.ref.projectPath;
    const wanted = stringArg(input, 'card').trim();
    const chosen = wanted === '' ? cards : cards.filter((card) => card.cardId === wanted);
    const [card] = chosen;
    if (card === undefined) return { status: 409, body: { error: `${session.name} is not waiting for a ${decision.kind}${wanted === '' ? '' : ` with card ${wanted}`}` } };
    if (chosen.length > 1) {
      const list = chosen.map((item) => `${item.cardId} — ${hostSummary(item, projectPath)}`).join('; ');
      return { status: 409, body: { error: `${session.name} has ${chosen.length} pending requests of this kind: ${list}. Say which one (pass its card id as "card").` } };
    }
    // «Не спрашивать больше» предлагается не всегда: без вариантов у CLI остаётся разовое разрешение.
    let note = '';
    if (decision.kind === 'permission' && decision.always === true && card.kind === 'permission' && card.suggestions.length === 0) {
      decision = { kind: 'permission', behavior: decision.behavior, ...(decision.message === undefined ? {} : { message: decision.message }) };
      note = ' (always is not offered for this request, proposed a one-time allow)';
    }
    let chosenAnswers: string[] = [];
    if (decision.kind === 'question' && card.kind === 'question') {
      const checked = checkAnswers(card, decision.answers);
      if ('error' in checked) return { status: 400, body: { error: checked.error } };
      decision = { kind: 'question', answers: checked.answers };
      chosenAnswers = card.questions.map((question) => checked.answers[question.question] ?? '');
    }
    const summary = hostSummary(card, projectPath);
    const detail = cardDetail(card);
    const verb =
      decision.kind === 'permission' ? (decision.behavior === 'allow' ? 'Allow' : 'Deny') : decision.kind === 'question' ? 'Answer' : decision.choice === 'auto-accept' ? 'Accept plan' : 'Approve each edit';
    const answerLines = chosenAnswers.map((answer, index) => `\n${chosenAnswers.length === 1 ? 'A' : `A${index + 1}`}: ${answer}`).join('');
    proposals += 1;
    pending = {
      token: conversation?.token ?? '',
      kind: 'decision',
      view: {
        action: 'decision',
        id: `p${proposals}`,
        target: session.name,
        where: session.where,
        text: `${verb} ${session.name}: ${summary}${detail === null || detail === '' ? '' : `\n${detail}`}${answerLines}`,
        card: { cardId: card.cardId, kind: card.kind, summary, detail },
        decision,
      },
      ref: session.ref,
    };
    publish({ proposal: pending.view, outcome: null });
    return { status: 200, body: { text: CARD_SHOWN + note } };
  }

  /** Карточки ждущих запросов по сессиям, что стоят `blocked`; остальных не опрашиваем. Сбой ленты — без карточек. */
  async function waitingCards(src: OverviewSource): Promise<Map<string, readonly FeedCard[]>> {
    const map = new Map<string, readonly FeedCard[]>();
    const feed = deps.feed;
    if (feed === undefined) return map;
    const refs: SessionRef[] = [];
    for (const entry of src.entries) {
      for (const session of entry.map.sessions) {
        if (session.lifecycle === 'closed') continue;
        const ref: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
        if (sessionDotState(session, src.live(ref)?.activity.activity ?? null) === 'blocked') refs.push(ref);
      }
    }
    await Promise.all(
      refs.map(async (ref) => {
        try {
          const { items } = await feed.snapshot(ref, undefined, 'attention');
          map.set(refKey(ref), pendingCards(items));
        } catch {
          // ленты нет — строка сессии без карточек
        }
      }),
    );
    return map;
  }

  /** Ждущие карточки одной сессии для `parley_detail`; сбой ленты — без карточек. */
  async function waitingCardsOf(ref: SessionRef): Promise<readonly FeedCard[]> {
    if (deps.feed === undefined) return [];
    try {
      return pendingCards((await deps.feed.snapshot(ref, undefined, 'attention')).items);
    } catch {
      return [];
    }
  }

  /** Закрывает карточку: `reason` попадает в системную заметку модели, `error` — в ответ окну (карточка при этом уже закрыта). */
  function settle(current: Pending, outcome: 'sent' | 'done' | 'cancelled', reason?: string, error?: string): { applied: true; error: string | null } {
    // Карточку `decide` уже забрал; новую, что предложили за время ожидания, не трогаем. Заметку пишем только
    // в тот разговор, что создал карточку: после `reset` она ушла бы в чужой.
    if (conversation?.token === current.token) outcomeNote = `[system: proposal ${current.view.id} was ${outcome}${reason === undefined ? '' : `: ${reason}`}]`;
    touch();
    publish({ proposal: pending?.view ?? null, outcome, phase: turn === null ? restPhase() : state.phase });
    return { applied: true, error: error ?? null };
  }

  async function applyMessage(current: Extract<Pending, { kind: 'message' }>): Promise<{ applied: boolean; error: string | null }> {
    if (current.target.kind === 'room') {
      const { projectPath, workId, roomId } = current.target;
      await deps.sendLetter({ projectPath, workId, roomId, to: current.to, text: withMentions(current.to, current.view.text), kind: current.view.kind ?? 'note' });
    } else {
      const { ref, name } = current.target;
      // Решает состояние сессии сейчас, а не в момент предложения: за время ожидания карточки она могла проснуться или закрыться.
      const session = deps.works
        .snapshot()
        .entries.find((entry) => entry.projectPath === ref.projectPath && entry.map.work.id === ref.workId)
        ?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
      const refusal = unreachable(name, session?.lifecycle);
      if (refusal !== null) return { applied: false, error: refusal };
      if (session?.lifecycle === 'sleeping') {
        await deps.launch(ref, 'resume', { by: 'human', prompt: current.view.text });
      } else {
        const result = await deps.send({ ref, text: current.view.text, submit: true });
        if (!result.inserted) return { applied: false, error: `${name} can't take a message now (${result.reason ?? 'busy'})` };
      }
      await appendSent(deps.home, ref, current.view.text, new Date(now()).toISOString());
    }
    return settle(current, 'sent');
  }

  async function applyRoom(current: Extract<Pending, { kind: 'room' }>): Promise<{ applied: boolean; error: string | null }> {
    const { projectPath, workId } = current.work;
    const { title, task } = current.view;
    const roomId = await deps.createRoom({ projectPath, workId, title, members: current.members, lead: current.lead });
    if (task !== null) {
      try {
        await deps.sendLetter({ projectPath, workId, roomId, to: [], text: task, kind: 'note' });
      } catch (error) {
        // Комната уже есть: карточку не оставляем, иначе повтор создал бы вторую.
        const message = (error as Error).message;
        return settle(current, 'done', `room "${title}" created, but its task was not sent: ${message}`, `Room created, but the task was not sent: ${message}`);
      }
    }
    return settle(current, 'done', `room "${title}" created`);
  }

  async function applyRoomDecision(current: Extract<Pending, { kind: 'room-decision' }>): Promise<{ applied: boolean; error: string | null }> {
    const { projectPath, workId, roomId } = current.room;
    const { proposal, choice, note } = current.view;
    try {
      await deps.resolveRoomProposal({
        projectPath,
        workId,
        roomId,
        proposalId: proposal.proposalId,
        action: choice,
        ...(note === null ? {} : { note }),
        rev: proposal.rev,
        ...(proposal.planId === undefined || proposal.planRev === undefined ? {} : { planId: proposal.planId, planRev: proposal.planRev }),
      });
    } catch (error) {
      // Ведущий успел переделать решение: ответ на старую версию не принимается, карточка устарела.
      if (error instanceof HostError && error.code === 'conflict') {
        // Решение могли принять в другом месте (тогда слота уже нет) или переделать (тогда id тот же, версия другая).
        const slot = workMap(source(), current.room)?.rooms.find((candidate) => candidate.id === roomId)?.proposal ?? null;
        if (slot === null || slot.id !== proposal.proposalId) return settle(current, 'cancelled', 'already answered', 'Already answered');
        return settle(current, 'cancelled', 'the lead revised the decision', 'The lead revised the decision — look again');
      }
      throw error;
    }
    return settle(current, 'done');
  }

  async function applyDecision(current: Extract<Pending, { kind: 'decision' }>): Promise<{ applied: boolean; error: string | null }> {
    if (deps.feed === undefined) return { applied: false, error: 'The agent feed is not available' };
    const result = await deps.feed.decide(current.ref, current.view.card.cardId, current.view.decision);
    // Карточку успели закрыть в другом месте (терминал, окно): ответ не ушёл, показываем это, а не успех.
    if (!result.applied) {
      // Хук ещё не удержан: карточка остаётся, человек повторит.
      if (result.state === 'pending') return { applied: false, error: 'The agent is not ready for the answer yet — try again' };
      if (result.state === 'stale') return settle(current, 'cancelled', 'expired', 'Expired — the request is no longer open');
      return settle(current, 'cancelled', 'already answered', 'Already answered');
    }
    return settle(current, 'done');
  }

  /** Запускает ход по вопросу человека (`island`) или по напоминанию (`reminder`). */
  async function runAsk(params: Params<'assistant.ask'>, origin: AssistantOrigin): Promise<StartReason> {
    inflight += 1;
    try {
      stopTurn();
      asks += 1;
      const ask: Ask = { id: params.askId ?? null, ticket: asks, origin };
      try {
        const picked = await pick(params.provider);
        if ('offline' in picked) {
          publish({ ...EMPTY, proposal: state.proposal, phase: 'offline', question: params.text, error: picked.offline, turn: state.turn + 1, askId: ask.id, origin });
          return 'failed';
        }
        const model = params.model ?? ASSISTANT_DEFAULT_MODELS[picked.entry.id] ?? null;
        return await start(picked.entry, model, params.language, params.text, false, ask);
      } catch (error) {
        deps.log(`assistant: ask failed: ${(error as Error).message}`);
        // Номер хода и `askId` — и у сбоя: окно по ним узнаёт, что вопрос дошёл, и перестаёт показывать «Sending…».
        publish({ ...EMPTY, proposal: state.proposal, phase: 'error', mood: 'error', question: params.text, error: 'Something went wrong — try again', turn: state.turn + 1, askId: ask.id, origin });
        return 'failed';
      }
    } finally {
      inflight -= 1;
      releaseWaiters();
    }
  }

  const clock = (at: number): string => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);

  function reminderTool(name: string, input: Record<string, unknown>): AssistantReply {
    if (name === 'list_reminders') {
      const all = deps.reminders.list();
      const text = all.length === 0 ? 'No reminders scheduled' : all.map((item) => `${item.id} — ${clock(Date.parse(item.at))}${new Date(Date.parse(item.at)).toDateString() === new Date(now()).toDateString() ? '' : ' tomorrow'} — ${item.every === null ? '' : `every ${item.every} min — `}${item.what}`).join('\n');
      return { status: 200, body: { text } };
    }
    if (name === 'cancel_reminder') {
      const id = stringArg(input, 'id').trim();
      if (id === '') return { status: 400, body: { error: 'id is empty' } };
      return { status: 200, body: { text: `Cancelled ${deps.reminders.cancel(id)} reminder(s)` } };
    }
    const number = (key: string): number | undefined | null => {
      const value = input[key];
      return value === undefined ? undefined : typeof value === 'number' ? value : null;
    };
    const inMinutes = number('in_minutes');
    const everyMinutes = number('every_minutes');
    const at = input['at'];
    if (inMinutes === null || everyMinutes === null || (at !== undefined && typeof at !== 'string')) return { status: 400, body: { error: 'in_minutes and every_minutes are numbers, at is a string' } };
    const stamp = now();
    const added = deps.reminders.add({
      what: stringArg(input, 'what'),
      ...(inMinutes === undefined ? {} : { inMinutes }),
      ...(at === undefined ? {} : { at }),
      ...(everyMinutes === undefined ? {} : { everyMinutes }),
      now: stamp,
    });
    if ('error' in added) return { status: 400, body: { error: added.error } };
    const delay = Date.parse(added.at) - stamp;
    const minutes = Math.max(1, Math.round(delay / 60_000));
    const when = delay < 60_000 ? 'in less than a minute' : `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
    return { status: 200, body: { text: `Scheduled ${added.id} for ${clock(Date.parse(added.at))} (${when})` } };
  }

  return {
    async ask(params, origin = 'island') {
      lastAsk = { provider: params.provider, model: params.model, language: params.language };
      await runAsk(params, origin);
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    configure(settings) {
      mirror = settings;
    },
    settings: () => mirror,
    cancel() {
      asks += 1;
      if (turn === null) return;
      stopTurn();
      publish({ phase: restPhase(), detail: null });
    },
    async decide(proposalId, decision) {
      const current = pending;
      if (current === null || current.view.id !== proposalId) return { applied: false, error: 'This card is no longer current' };
      // Карточка забирается до первого await: второй `decide` с тем же id не выполнит действие повторно.
      pending = null;
      if (decision === 'cancel') return settle(current, 'cancelled');
      // Не вышло — карточка возвращается, если никто не предложил новую и разговор тот же (после `reset` её уже нет).
      const restore = (): void => {
        if (pending === null && conversation?.token === current.token) pending = current;
      };
      try {
        const result =
          current.kind === 'room'
            ? await applyRoom(current)
            : current.kind === 'room-decision'
              ? await applyRoomDecision(current)
              : current.kind === 'decision'
                ? await applyDecision(current)
                : await applyMessage(current);
        if (!result.applied) restore();
        return result;
      } catch (error) {
        restore();
        return { applied: false, error: (error as Error).message };
      }
    },
    reset() {
      asks += 1;
      stopTurn();
      endConversation();
      pending = null;
      publish({ ...EMPTY, turn: state.turn });
    },
    state: () => state,
    sent: (ref) => readSent(deps.home, ref),
    async tool(name, args) {
      const current = conversation;
      if (current === null) return { status: 409, body: { error: 'No assistant conversation is active' } };
      const input = typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
      const src = source();
      const targets = targetsOf(src);
      switch (name) {
        case 'parley_overview': {
          const cards = await waitingCards(src);
          return { status: 200, body: { text: overviewText({ ...src, ...(await reasonContext()), cards: (ref) => cards.get(refKey(ref)) }) } };
        }
        case 'parley_detail': {
          const found = resolveTarget(targets, stringArg(input, 'target'));
          if ('error' in found) return { status: 404, body: { error: found.error } };
          const target = found.target;
          const reply = target.kind === 'session' ? await lastReply(target.ref) : null;
          const waiting = target.kind === 'session' ? await waitingCardsOf(target.ref) : [];
          return { status: 200, body: { text: detailText({ ...src, ...(await reasonContext()) }, target, reply, waiting) } };
        }
        case 'propose_message':
          return propose(input, src, targets);
        case 'propose_room':
          return proposeRoom(input, src, targets);
        case 'propose_room_decision':
          return proposeRoomDecision(input, src, targets);
        case 'propose_decision':
          return proposeDecision(input, targets);
        case 'schedule_check':
        case 'list_reminders':
        case 'cancel_reminder':
          return reminderTool(name, input);
        case 'end_conversation':
          current.endAfterTurn = true;
          return { status: 200, body: { text: 'The conversation starts over after this reply.' } };
        default:
          return { status: 404, body: { error: `unknown tool ${name}` } };
      }
    },
    async onReminder(reminder, late) {
      // Идущий ход не перебиваем: ждём, пока он закончится и никакой вопрос человека не запускается. Параметры
      // последнего вопроса и провайдера читаем уже после ожидания; если пока выбирали провайдера, человек успел
      // спросить снова, ждём ещё раз.
      if (mirror !== null && !mirror.enabled) {
        if (!notifiedOff.has(reminder.id)) {
          notifiedOff.add(reminder.id);
          deps.onReminderWhileOff?.(reminder);
        }
        return 'skipped';
      }
      let wanted = lastAsk;
      for (;;) {
        while ((turn !== null || inflight > 0) && !stopped) await new Promise<void>((resolve) => idleWaiters.push(resolve));
        if (stopped) return 'later';
        wanted = mirror?.enabled ? { provider: mirror.provider, model: mirror.model, language: mirror.language } : lastAsk;
        const picked = await pick(wanted.provider);
        if (stopped) return 'later';
        if ('offline' in picked) {
          deps.log(`assistant: reminder ${reminder.id} skipped: ${picked.offline}`);
          return 'skipped';
        }
        if (turn === null && inflight === 0) break;
      }
      const flags = `${late ? ', late' : ''}${isLastCheck(reminder, now()) ? ', last check' : ''}`;
      const result = await runAsk({ text: `[reminder ${reminder.id}, asked at ${reminder.askedAt}${flags}] Check: ${reminder.what}`, ...wanted }, 'reminder');
      // Хоста ещё нет или запуск перебит — ход ещё можно провести позже; ошибка уже показана окну.
      return result === 'started' ? 'fired' : result === 'failed' ? 'skipped' : 'retry';
    },
    stop() {
      stopped = true;
      asks += 1; // запуск, что ещё в пути, не стартует
      stopTurn();
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const wake of waiters) wake(); // ждущие напоминания узнают, что хост останавливается
      if (idleTimer !== null) clearTimeout(idleTimer);
      deps.endpoint.setToken(null);
    },
  };
}
