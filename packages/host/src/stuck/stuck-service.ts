/**
 * Служба «застрял» (спека застрявших 3.5, 4.4, 5.2, 8; спека подписок 5.8): слушает активность сессий, ведёт эпизоды
 * ожидания человека и по порогам записывает их в карту (`session.stuck`), в ленту комнаты (строка для человека) и в
 * письма Parley ведущему и тем, кто ждёт ответа застрявшего. Тексты — только из core (`work/stuck.ts`), здесь
 * решается, КОГДА и КОМУ их писать.
 *
 * Эпизод ведётся по сессии и по виду `need` без перерыва, а не по точному `since`: у одного эпизода `since` и `detail`
 * могут сдвинуться, а повторных писем из-за этого быть не должно. Все изменения эпизодов одной сессии идут по очереди
 * (`enqueue`): доклад ещё пишется, а эпизод уже кончился — «back» увидит доложенное.
 */

import {
  addMessage,
  addSystemMessage,
  backLetter,
  backLine,
  envValue,
  isClaudeCode,
  isManagedProviderId,
  isRoomArchived,
  liveLead,
  loadProviders,
  PARLEY,
  PROVIDERS,
  parleyNote,
  providerLabel,
  roomOfSession,
  STUCK_REPORT_MS,
  stuckLetter,
  stuckLine,
  unreadFor,
  updateMap,
  type LimitAlternative,
  type NeedKind,
  type SessionNeed,
  type WorkMap,
  type WorkSession,
} from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import type { ActivityService, SessionLive } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { WorksService } from '../works/works-service.js';
import { limitAlternatives } from './limit-alternatives.js';

export interface StuckServiceOptions {
  /** Срок, после которого одобрение и вопрос считаются застрявшими; по умолчанию `STUCK_REPORT_MS` (3.5). */
  reportMs?: number | undefined;
  now?: () => number;
  /**
   * Другие вошедшие аккаунты того же CLI для письма о лимите (спека подписок 5.8). По умолчанию — `limitAlternatives`
   * без лимитов и без службы входа, то есть пусто; хост подставляет свои службы.
   */
  alternatives?: (provider: string) => Promise<readonly LimitAlternative[]>;
  /**
   * Служба доложила эпизод `sign-in` у сессии аккаунта (`custom-`/`codex-`): служба входа проверяет вход этого провайдера
   * заново (спека подписок 5.5, К5). Не аккаунт получатель отсеивает сам. Бросил — доклад всё равно записывается.
   */
  onSignIn?: (providerId: string) => void;
}

/**
 * Рычаг E2E: `PARLEY_STUCK_REPORT_MS` (и прежняя `HARNAS_STUCK_REPORT_MS`) — порог доклада в миллисекундах. Тест не
 * может ждать две минуты. Не число, меньше 100 мс или больше десяти минут — переменная игнорируется.
 */
export function stuckReportFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const raw = envValue(env, 'STUCK_REPORT_MS')?.trim();
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 100 && value <= 600_000 ? value : undefined;
}

/** Виды, о которых докладывают сразу, а письмо «back» пишут при возвращении (3.5, 5.2). */
const IMMEDIATE: ReadonlySet<NeedKind> = new Set<NeedKind>(['limit', 'sign-in', 'startup']);
/** Виды, что сменяют друг друга внутри одного эпизода ожидания человека, не открывая его заново (3.5). */
const WAITING: ReadonlySet<NeedKind> = new Set<NeedKind>(['startup', 'question', 'approval']);

const sameEpisode = (a: NeedKind, b: NeedKind): boolean => a === b || (WAITING.has(a) && WAITING.has(b));

const sameNeed = (a: SessionNeed, b: SessionNeed): boolean =>
  a.kind === b.kind &&
  a.since === b.since &&
  a.detail === b.detail &&
  a.resetsAt === b.resetsAt &&
  a.window === b.window &&
  a.account === b.account;

interface Episode {
  /** Последнее значение `need` эпизода: доклад и обновление берут его. */
  need: SessionNeed;
  /** То, что доложено и лежит в `session.stuck`; `null` — доклада ещё не было. */
  told: SessionNeed | null;
  timer: NodeJS.Timeout | undefined;
}

/** Что написать в комнату: строка ленты (ей нужно знать, ведущий ли застрявший) и письмо агентам; `null` — письма нет. */
interface Posting {
  line: (isLead: boolean) => string;
  letter: string | null;
}

export function createStuckService(
  host: HostContext,
  works: WorksService,
  activity: ActivityService,
  options: StuckServiceOptions = {},
): { start(): void; stop(): void } {
  const reportMs = options.reportMs ?? STUCK_REPORT_MS;
  const now = options.now ?? Date.now;
  const alternatives =
    options.alternatives ??
    ((provider: string) => limitAlternatives(provider, { limits: { get: () => null }, signedIn: () => null }));

  const episodes = new Map<string, Episode>();
  /** Сессии, чьё первое изменение активности уже было: на нём эпизоды сверяются с картой (4.4). */
  const seen = new Set<string>();
  /** Сессии, чьё последнее событие активности пришло без `need` (синхронно, до очереди). */
  const withoutNeed = new Set<string>();
  const chains = new Map<string, Promise<void>>();
  let unsubscribe: (() => void) | undefined;

  function enqueue(key: string, task: () => Promise<void>): void {
    if (unsubscribe === undefined) return;
    const run = (chains.get(key) ?? Promise.resolve()).then(task).catch((error: unknown) => {
      host.log.error('служба «застрял» не обработала событие сессии', { key, error: String(error) });
    });
    chains.set(key, run);
    void run.then(() => {
      if (chains.get(key) === run) chains.delete(key);
    });
  }

  /** Имя провайдера для людей и агентов — по реестру: аккаунт называется своим именем, а не id (спека подписок 5.8). */
  async function providerName(id: string): Promise<string> {
    try {
      return providerLabel((await loadProviders())[id] ?? { id, label: id });
    } catch (error) {
      host.log.error('реестр провайдеров не прочитался для письма о застрявшей сессии', { id, error: String(error) });
      return providerLabel({ id, label: id });
    }
  }

  /**
   * Имя семейства CLI для заголовка «Other <family> accounts» письма о лимите (спека подписок 4.4, решение 11):
   * Claude Code (`claude`, `glm`, свои аккаунты `custom-*`) или Codex; у незнакомого семейства — имя самого провайдера.
   */
  function familyName(id: string, provider: string): string {
    if (isClaudeCode(id)) return providerLabel(PROVIDERS.claude);
    if (id.toLowerCase() === PROVIDERS.codex.id) return providerLabel(PROVIDERS.codex);
    return provider;
  }

  async function alternativesFor(provider: string): Promise<readonly LimitAlternative[]> {
    try {
      return await alternatives(provider);
    } catch (error) {
      host.log.error('альтернативы для письма о лимите не собрались', { provider, error: String(error) });
      return [];
    }
  }

  /** Одна `updateMap` по сессии; сбой — строка в журнале хоста, без исключения наружу. */
  async function write(ref: SessionRef, mutate: (map: WorkMap, session: WorkSession) => void): Promise<boolean> {
    try {
      await updateMap(ref.projectPath, ref.workId, (map) => {
        const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
        if (session !== undefined) mutate(map, session);
      });
      return true;
    } catch (error) {
      host.log.error('служба «застрял» не записала карту', { ref, error: String(error) });
      return false;
    }
  }

  /**
   * Получатели письма (5.2): живой ведущий комнаты и отправители непрочитанных писем к застрявшему; без самого
   * застрявшего, человека, системы и Parley (их нет среди сессий), без закрытых и удалённых. Вне комнаты ведущего нет.
   */
  function recipientsOf(map: WorkMap, session: WorkSession, lead: string | null): string[] {
    const to = new Set<string>();
    if (lead !== null) to.add(lead);
    for (const message of unreadFor(map, session.id)) to.add(message.from);
    to.delete(session.id);
    return [...to].filter((id) => map.sessions.some((candidate) => candidate.id === id && candidate.lifecycle !== 'closed'));
  }

  /**
   * Строка в комнату (для человека) и письма Parley (агентам). Комната сессии — по `members`; архивная не получает
   * ничего (8.8); без комнаты строки нет, а письма уходят отправителям без комнаты (как «did not resume»).
   */
  function post(map: WorkMap, session: WorkSession, at: Date, posting: Posting): void {
    const roomId = roomOfSession(map, session.id);
    const room = roomId === null ? undefined : map.rooms.find((candidate) => candidate.id === roomId);
    if (room !== undefined && isRoomArchived(room)) return;
    const stamp = at.toISOString();
    const lead = room === undefined ? null : liveLead(map, room);
    if (room !== undefined) addSystemMessage(map, room.id, posting.line(lead === session.id), stamp);
    if (posting.letter === null) return;
    for (const to of recipientsOf(map, session, lead)) {
      if (room === undefined) addMessage(map, { from: PARLEY, to: [to], text: posting.letter }, stamp);
      else parleyNote(map, room.id, to, posting.letter, stamp);
    }
  }

  /** Доклад: `stuck` в карту, строка в комнату, письма — всё одной записью. */
  async function report(ref: SessionRef, key: string, episode: Episode): Promise<void> {
    if (episode.told !== null) return;
    const at = new Date(now());
    const need = episode.need;
    const session = works.entry(ref.projectPath, ref.workId)?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
    if (session === undefined) {
      episodes.delete(key);
      return;
    }
    if (need.kind === 'sign-in' && isManagedProviderId(session.provider)) {
      try {
        options.onSignIn?.(session.provider);
      } catch (error) {
        host.log.error('служба входа не приняла эпизод sign-in', { provider: session.provider, error: String(error) });
      }
    }
    const provider = await providerName(session.provider);
    const who = { id: session.id, provider, family: familyName(session.provider, provider) };
    // Единственное место, где собирается письмо: тексты и состав письма о лимите — в core (`stuckLetter`, `limitLetter`).
    const letter = stuckLetter(who, need, at, need.kind === 'limit' ? await alternativesFor(session.provider) : []);
    if (unsubscribe === undefined || episodes.get(key) !== episode) return;
    const written = await write(ref, (map, current) => {
      current.stuck = need;
      post(map, current, at, { line: (isLead) => stuckLine(who, need, at, isLead), letter });
    });
    if (written) episode.told = need;
  }

  /** Тот же эпизод, но `need` сменился после доклада (появилось время сброса, ушёл сдвиг `since`): карта без писем. */
  async function refresh(ref: SessionRef, episode: Episode): Promise<void> {
    const need = episode.need;
    const written = await write(ref, (_map, session) => {
      session.stuck = need;
    });
    if (written) episode.told = need;
  }

  /**
   * Эпизод кончился. Не докладывали — только снять таймер. Доложенное снимается из карты; живой сессии (`active`) ещё и
   * «back» в комнату, а для лимита, входа и старта — письмо тем же получателям. Спящая, закрытая и удалённая — молча (8.7).
   * `silent` — «back» о нём было бы неправдой: эпизод заменён другим видом либо это первая сверка после старта хоста.
   */
  async function finish(ref: SessionRef, key: string, episode: Episode, silent: boolean): Promise<void> {
    clearTimeout(episode.timer);
    if (episodes.get(key) === episode) episodes.delete(key);
    const told = episode.told;
    if (told === null) return;
    const at = new Date(now());
    await write(ref, (map, session) => {
      session.stuck = null;
      if (silent || session.lifecycle !== 'active') return;
      post(map, session, at, {
        line: () => backLine(session.id, told.kind),
        letter: IMMEDIATE.has(told.kind) ? backLetter(session.id, told.kind) : null,
      });
    });
  }

  async function open(ref: SessionRef, key: string, need: SessionNeed): Promise<void> {
    const episode: Episode = { need, told: null, timer: undefined };
    episodes.set(key, episode);
    if (IMMEDIATE.has(need.kind)) {
      await report(ref, key, episode);
      return;
    }
    episode.timer = setTimeout(() => {
      enqueue(key, async () => {
        if (episodes.get(key) === episode) await report(ref, key, episode);
      });
    }, reportMs);
  }

  async function handle(ref: SessionRef, key: string, need: SessionNeed | null): Promise<void> {
    if (unsubscribe === undefined) return;
    const session = works.entry(ref.projectPath, ref.workId)?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
    if (session === undefined) {
      // Сессии в карте уже нет: снимать с неё `stuck` и писать «back» некуда.
      const gone = episodes.get(key);
      if (gone !== undefined) clearTimeout(gone.timer);
      episodes.delete(key);
      return;
    }
    const first = !seen.has(key);
    seen.add(key);
    // Сверка после старта хоста (4.4): доложенное в карте принимается за идущий эпизод и дальше идёт обычными
    // правилами — совпал вид: писем нет; need нет: `stuck` снимается молча; другой вид: замена без «back».
    const known = session.stuck ?? null;
    if (first && known !== null && !episodes.has(key)) episodes.set(key, { need: known, told: known, timer: undefined });

    const episode = episodes.get(key);
    if (need === null) {
      // На первой сверке после старта «back» писать нельзя, даже живой сессии: после перезапуска хоста нужда, выведенная
      // запасным путём (лимит по журналу), потеряна, и «back» был бы ложным. «Back» — для эпизодов, что видела сама служба.
      if (episode !== undefined) await finish(ref, key, episode, first);
      return;
    }
    if (episode === undefined) {
      await open(ref, key, need);
      return;
    }
    if (!sameEpisode(episode.need.kind, need.kind)) {
      await finish(ref, key, episode, true);
      await open(ref, key, need);
      return;
    }
    episode.need = need;
    if (episode.told !== null && !sameNeed(episode.told, need)) await refresh(ref, episode);
  }

  function onActivity(ref: SessionRef, value: SessionLive): void {
    const key = refKey(ref);
    const need = value.activity.need;
    // Активность меняется часто (метрики), а нужда — редко: сессия без нужды, у которой уже была сверка, очередь не будит.
    if (need === null && withoutNeed.has(key)) return;
    if (need === null) withoutNeed.add(key);
    else withoutNeed.delete(key);
    enqueue(key, () => handle(ref, key, need));
  }

  return {
    start() {
      if (unsubscribe !== undefined) return;
      unsubscribe = activity.onChange(onActivity);
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      for (const episode of episodes.values()) clearTimeout(episode.timer);
      episodes.clear();
      seen.clear();
      withoutNeed.clear();
      chains.clear();
    },
  };
}
