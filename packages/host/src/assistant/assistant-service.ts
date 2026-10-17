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
  codexInstructionsFile,
  parseClaudeLine,
  parseCodexLine,
  participantLabel,
  sessionMention,
  splitMood,
  type AssistantLanguage,
  type ProviderEntry,
  type SessionLifecycle,
} from '@parley/core';
import type { AssistantDetail, AssistantProposal, AssistantState, EventData, EventName, Params, SendResult, SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { FeedService } from '../feed/feed-service.js';
import { ASSISTANT_PATH, type AssistantReply } from './assistant-endpoint.js';
import type { WorksService } from '../works/works-service.js';
import { detailText, overviewText, resolveTarget, targetsOf, type AssistantTarget, type OverviewSource } from './overview.js';
import { appendSent, readSent } from './sent-log.js';
import { runTurn, type TurnEnd, type TurnHandle, type TurnSpec } from './turn.js';

export const ASSISTANT_IDLE_MS = 15 * 60_000;
export const ASSISTANT_TURN_MS = 60_000;
const MAX_TEXT = 4000;

export interface AssistantServiceDeps {
  broadcast<E extends EventName>(event: E, data: EventData<E>): void;
  works: Pick<WorksService, 'snapshot'>;
  activity: Pick<ActivityService, 'get'>;
  feed?: Pick<FeedService, 'snapshot'>;
  /** Общий отправитель хоста (`createSender`) — тот же, что у `pty.send`. */
  send(params: { ref: SessionRef; text: string; submit: boolean }): Promise<SendResult>;
  /**
   * Подъём спящей сессии подтверждённым текстом (`sessions.launch`). `by: 'human'` — это действие человека,
   * подтверждённое на карточке, и лимиты будильника (`resumeRate`) на него не распространяются.
   */
  launch(ref: SessionRef, mode: 'resume', options: { by: 'human'; prompt: string }): Promise<void>;
  /** `sendHumanLetter` с `via: 'assistant'`. */
  sendLetter(input: Params<'rooms.send'>): Promise<string>;
  /** Сервер хуков (`origin`) и приёмник помощника (`setToken`, задача 8). */
  endpoint: { origin(): string | null; setToken(token: string | null): void };
  providers(): Promise<Record<string, ProviderEntry>>;
  /** `null` — провайдер готов; иначе причина по-английски. */
  ready(entry: ProviderEntry): Promise<string | null>;
  launchEnv(entry: ProviderEntry): Promise<NodeJS.ProcessEnv>;
  binary(command: string): Promise<string>;
  home: string;
  log(line: string): void;
  run?(spec: TurnSpec, onEvent: Parameters<typeof runTurn>[1]): TurnHandle;
  now?(): number;
  idleMs?: number;
  turnTimeoutMs?: number;
}

export interface AssistantService {
  ask(params: Params<'assistant.ask'>): Promise<void>;
  cancel(): void;
  decide(proposalId: string, decision: 'send' | 'cancel'): Promise<{ applied: boolean; error: string | null }>;
  reset(): void;
  state(): AssistantState;
  sent(ref: SessionRef): Promise<Array<{ text: string; at: string }>>;
  tool(name: string, args: unknown): Promise<AssistantReply>;
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

interface Pending {
  view: AssistantProposal;
  target: AssistantTarget;
  /** Упомянутые участники комнаты (id сессий) — `to` письма. */
  to: string[];
}

const EMPTY: AssistantState = { phase: 'idle', detail: null, question: null, answer: '', mood: 'calm', proposal: null, outcome: null, error: null, turn: 0, askId: null };

/** Вопрос, по которому запускается ход: `id` окна и билет — отмена или новый вопрос его гасят, и ход не стартует. */
interface Ask {
  id: string | null;
  ticket: number;
}

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
const stringArg = (input: Record<string, unknown>, key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '');

function detailOf(name: string, input: Record<string, unknown>, targets: readonly AssistantTarget[]): AssistantDetail {
  if (name === 'parley_overview') return { tool: 'overview', target: null };
  if (name === 'propose_message') return { tool: 'propose', target: null };
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

  const publish = (patch: Partial<AssistantState>): void => {
    state = { ...state, ...patch, instance };
    deps.broadcast('assistant.changed', state);
  };
  const source = (): OverviewSource => ({ entries: deps.works.snapshot().entries, live: (ref) => deps.activity.get(ref) });
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

  function stopTurn(): void {
    const old = turn;
    turn = null;
    old?.cancel();
  }

  async function start(entry: ProviderEntry, model: string | null, language: AssistantLanguage, text: string, retried: boolean, ask: Ask): Promise<void> {
    const current = await ensure(entry, model, language);
    const next = state.turn + 1;
    const askId = ask.id;
    const base = deps.endpoint.origin();
    if (base === null) {
      publish({ ...EMPTY, proposal: state.proposal, phase: 'error', mood: 'error', question: text, error: 'Parley is still starting — try again', turn: next, askId });
      return;
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
      publish({ ...EMPTY, proposal: state.proposal, phase: 'offline', question: text, error: `${entry.label} can't run the assistant`, turn: next, askId });
      return;
    }
    let binary: string;
    try {
      binary = await deps.binary(command.command);
    } catch {
      publish({ ...EMPTY, proposal: state.proposal, phase: 'offline', question: text, error: `${entry.label} CLI is not installed`, turn: next, askId });
      return;
    }
    const env = await deps.launchEnv(entry);
    // Пока запуск ждал, человек отменил вопрос (закрыл остров) или задал новый: этот ход не нужен.
    if (ask.ticket !== asks) return;
    publish({ phase: 'thinking', detail: null, question: text, answer: '', mood: 'calm', outcome: null, error: null, turn: next, askId });

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
      });
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
      view: {
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
    return { status: 200, body: { text: 'Shown to the person as a card; they will confirm or cancel it. Tell them in one short sentence what you prepared.' } };
  }

  function settle(current: Pending, outcome: 'sent' | 'cancelled'): { applied: true; error: null } {
    pending = null;
    outcomeNote = `[system: proposal ${current.view.id} was ${outcome}]`;
    touch();
    publish({ proposal: null, outcome, phase: turn === null ? 'idle' : state.phase });
    return { applied: true, error: null };
  }

  return {
    async ask(params) {
      stopTurn();
      asks += 1;
      const ask: Ask = { id: params.askId ?? null, ticket: asks };
      try {
        const picked = await pick(params.provider);
        if ('offline' in picked) {
          publish({ ...EMPTY, proposal: state.proposal, phase: 'offline', question: params.text, error: picked.offline, turn: state.turn + 1, askId: ask.id });
          return;
        }
        const model = params.model ?? ASSISTANT_DEFAULT_MODELS[picked.entry.id] ?? null;
        await start(picked.entry, model, params.language, params.text, false, ask);
      } catch (error) {
        deps.log(`assistant: ask failed: ${(error as Error).message}`);
        // Номер хода и `askId` — и у сбоя: окно по ним узнаёт, что вопрос дошёл, и перестаёт показывать «Sending…».
        publish({ ...EMPTY, proposal: state.proposal, phase: 'error', mood: 'error', question: params.text, error: 'Something went wrong — try again', turn: state.turn + 1, askId: ask.id });
      }
    },
    cancel() {
      asks += 1;
      if (turn === null) return;
      stopTurn();
      publish({ phase: restPhase(), detail: null });
    },
    async decide(proposalId, decision) {
      const current = pending;
      if (current === null || current.view.id !== proposalId) return { applied: false, error: 'This card is no longer current' };
      if (decision === 'cancel') return settle(current, 'cancelled');
      try {
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
      } catch (error) {
        return { applied: false, error: (error as Error).message };
      }
      return settle(current, 'sent');
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
        case 'parley_overview':
          return { status: 200, body: { text: overviewText(src) } };
        case 'parley_detail': {
          const found = resolveTarget(targets, stringArg(input, 'target'));
          if ('error' in found) return { status: 404, body: { error: found.error } };
          const reply = found.target.kind === 'session' ? await lastReply(found.target.ref) : null;
          return { status: 200, body: { text: detailText(src, found.target, reply) } };
        }
        case 'propose_message':
          return propose(input, src, targets);
        case 'end_conversation':
          current.endAfterTurn = true;
          return { status: 200, body: { text: 'The conversation starts over after this reply.' } };
        default:
          return { status: 404, body: { error: `unknown tool ${name}` } };
      }
    },
    stop() {
      stopTurn();
      if (idleTimer !== null) clearTimeout(idleTimer);
      deps.endpoint.setToken(null);
    },
  };
}
