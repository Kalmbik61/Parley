/**
 * Сервис ёмкости машины (спека сна агентов и ёмкости 2026-10-30, 4.2): допуск запусков под общий потолок живых CLI,
 * резерв слота и очередь запусков с её продвижением.
 *
 * Решение «стартовать, стартовать сверх потолка или встать в очередь» принимает чистая `machineAdmission` из core; здесь
 * её входные числа из хоста и всё, что решение за собой тянет:
 * - занято = живые PTY хоста плюс запуски с резервом. Запуск, прошедший допуск, держит слот, пока процесс не стартовал или
 *   запуск не отказал (`settle`). Хост на машине один, поэтому проверка и резерв идут одним синхронным участком, без
 *   замка: между ними нет ни одного `await`;
 * - очередь — записи `queued` в картах работ (`WorkSession.queued`), своей копии у сервиса нет: после перезапуска хоста
 *   очередь собирается из снимка работ заново, в том же порядке (`compareQueued`);
 * - насос (`pump`) продвигает записи очереди, когда освободился слот (процесс вышел), давление спало, снимок работ
 *   изменился или потолок выключили. Своего таймера у сервиса нет: сроки считаются по часам при очередном проходе, а проход
 *   приходит с каждым чтением датчика памяти, пока очередь не пуста.
 *
 * Запись очереди не держит запуски позади себя, пока её нельзя запустить: она на паузе после отказа бюджета работы
 * (`backoff`) или `stale` — подъём письмом, чей `retry` так и не дошёл до допуска. Такая запись не входит в `ahead` чужих
 * запусков. Запись в продвижении (`inFlight`) не входит в `ahead` других продвигаемых записей: насос продвигает по числу
 * свободных слотов, и они стартуют вместе. Но новый запуск, пришедший раньше её допуска, встаёт за ней: слот освобождён ей,
 * и класс очереди не должен переворачиваться из-за окна между продвижением и допуском. А та запись, чей запуск уже идёт
 * (резерв или процесс есть, снимок работ ещё несёт `queued`), не продвигается второй раз.
 *
 * Запись, которую насос продвинул, а допуск вернул в очередь (ответ `queue`), «отскочила». Пока слот на деле не освободился
 * (процесс вышел, `settle` без процесса, датчик сообщил другой уровень давления), насос не берёт её `BOUNCE_MS`: иначе слот,
 * который проверка насоса видит свободным, а допуск нет (давление сменилось, сон никого не усыпил под замком карты),
 * крутил бы запуск по кругу, с записями в карту на каждом обороте. В `ahead` чужих запусков отскочившая запись входит: она
 * ждёт по-настоящему, и новые запуски её не обгоняют.
 *
 * Работающих агентов сервис не трогает: слот ради запуска освобождает сервис сна (`freeSlot`), и только простаивающих.
 */

import { totalmem } from 'node:os';
import {
  SYSTEM,
  compareQueued,
  machineAdmission,
  machineLimit,
  queuedAhead,
  sessionTag,
  updateMap,
  type Admission,
  type AdmissionInput,
  type LaunchClass,
  type MachineTicket,
  type MemoryPressure,
  type ParleyConfig,
  type QueuedLaunch,
} from '@parley/core';
import { refKey } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { HostError } from '../errors.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';

/** Через сколько после отказа бюджета работы запись очереди пробуют снова (спека 4.2, «Очередь»). */
export const BUDGET_BACKOFF_MS = 30_000;

/**
 * Сколько ждут, что подъём письмом (`retry` будильнику) дойдёт до допуска. Не дошёл — будильник сессию сейчас не поднимает
 * (лимит часа, пауза, нет провайдера), и запись становится `stale`: очередь она не держит.
 */
export const IN_FLIGHT_MS = 60_000;

/** Сколько насос не берёт «отскочившую» запись (допуск вернул её в очередь): столько же, как между чтениями датчика памяти. */
export const BOUNCE_MS = 10_000;

export interface CapacityDeps {
  pty: Pick<PtyManager, 'list' | 'get' | 'on'>;
  works: Pick<WorksService, 'snapshot' | 'onChange'>;
  /** Датчик памяти (`PressureSensor` из `capacity/memory-pressure.ts`); нужен только уровень. */
  pressure: {
    current(): { level: MemoryPressure };
    onReading(listener: (reading: { level: MemoryPressure }) => void): () => void;
  };
  /** Настройки читаются на каждом допуске и проходе насоса: человек меняет потолок на ходу. */
  config: () => Promise<Pick<ParleyConfig, 'machineConcurrent' | 'sleepAfterMinutes'>>;
  /**
   * Поздняя привязка: `SessionsService.launch` для записей, кроме подъёма письмом. Исход `held` — запуск Codex ждёт согласия
   * человека на папку: дальше его ведёт путь согласия.
   */
  launch: (
    ref: SessionRef,
    mode: QueuedLaunch['mode'],
    choice: { by: string },
  ) => Promise<'started' | 'held' | 'queued'>;
  /** Поздняя привязка: `WakeService.retry` для подъёма письмом. */
  retry: (ref: SessionRef) => void;
  /** Поздняя привязка: сервис сна; нет — освобождать слоты нечем. */
  sleep: () => { freeSlot(): Promise<boolean>; slotCandidate(): boolean } | undefined;
  /** По умолчанию `os.totalmem()`. */
  totalMemBytes?: number;
  now?: () => number;
}

export interface CapacityService {
  start(): void;
  stop(): void;
  /** В `launch()` после бюджета работы: решение и, при `start`/`overflow`, резерв слота. */
  admit(request: { ref: SessionRef; launchClass: LaunchClass }): Promise<MachineTicket>;
  /** Запуск кончился (процесс стартовал или отказ): резерв снят. Повтор безвреден. */
  settle(ref: SessionRef): void;
  /** Продвинуть очередь (запись встала, слот освободился). */
  pump(): void;
  /** Записи очереди по порядку `compareQueued` — из снимка работ, без архивных работ. */
  queue(): Array<{ ref: SessionRef; queued: QueuedLaunch }>;
  /** Сессии, занимающие слот: живые PTY и запуски с резервом, без повторов (тот же счёт, что у допуска). */
  occupied(): number;
}

/** Запись очереди со своим ключом `refKey`. */
interface Entry {
  ref: SessionRef;
  key: string;
  queued: QueuedLaunch;
}

/**
 * Положение записи очереди: `waiting` и `bounced` ждут по-настоящему и держат очередь, остальные — нет. `waiting` насос
 * продвигает, `bounced` (допуск вернул её в очередь меньше `BOUNCE_MS` назад) — пока нет. `starting` — запуск уже идёт
 * (резерв или процесс есть, а снимок работ ещё несёт `queued`); `in-flight` — продвигается сейчас и держит очередь только
 * для нового запуска (не для другой продвигаемой записи); `paused` — пауза после отказа бюджета работы; `stale` — подъём
 * письмом, который будильник не принял в срок.
 */
type Standing = 'waiting' | 'bounced' | 'starting' | 'in-flight' | 'paused' | 'stale';

/**
 * Продвигаемая запись. Срок `deadline` есть только у подъёма письмом (его `retry` ничего не обещает): запуск через `launch`
 * кончается исходом своего промиса, и срока у него нет. `admitted` — допуск этой сессии уже был.
 */
interface Flight {
  deadline: number | null;
  admitted: boolean;
}

/** Отказ бюджета работы из `sessions.launch`: код ошибки хоста несёт `data.code` (как в будильнике). */
const isResourceDenial = (error: unknown): boolean =>
  error instanceof HostError && error.data?.['code'] === 'resource-budget';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createCapacityService(host: HostContext, deps: CapacityDeps): CapacityService {
  const now = deps.now ?? Date.now;
  const totalMem = deps.totalMemBytes ?? totalmem();

  /** Запуски, прошедшие допуск: слот за ними, а процесса ещё нет или `settle` не позвали. Ключ — `refKey`. */
  const reserved = new Set<string>();
  /** Запуски человека сверх потолка, пока они живы или запускаются: больше `HUMAN_OVERFLOW` их не бывает. */
  const overflow = new Set<string>();
  /** Записи очереди, которые продвигают сейчас. */
  const inFlight = new Map<string, Flight>();
  /** Подъёмы письмом, чей `retry` за `IN_FLIGHT_MS` не дошёл до допуска. Отметку снимает первый допуск этой сессии. */
  const stale = new Set<string>();
  /** Пауза после отказа бюджета работы: до какого момента (мс часов сервиса) запись не продвигают. */
  const backoff = new Map<string, number>();
  /** Записи, которые насос продвинул, а допуск вернул в очередь: до какого момента насос их не берёт (`BOUNCE_MS`). */
  const bounced = new Map<string, number>();
  /** Когда `stale` подъёму письмом в последний раз звали `retry`: чаще раза в `BUDGET_BACKOFF_MS` не зовём. */
  const staleRetriedAt = new Map<string, number>();

  /**
   * Допуски, которые сейчас усыпляют сессию ради слота. Освободившееся место принадлежит им: пока усыпление идёт, насос
   * не отдаёт его следующей записи очереди, иначе та обогнала бы запись, ради которой сессию усыпили.
   */
  let freeing = 0;

  let stopped = true;
  let pumping = false;
  let pumpAgain = false;
  let unsubscribes: Array<() => void> = [];
  /** Уровень давления в предыдущем чтении датчика: другой уровень снимает отметки «отскочила». */
  let lastLevel: MemoryPressure = 'unknown';

  function queue(): Array<{ ref: SessionRef; queued: QueuedLaunch }> {
    const found: Array<{ ref: SessionRef; queued: QueuedLaunch }> = [];
    for (const entry of deps.works.snapshot().entries) {
      if (entry.map.work.status === 'archived') continue;
      for (const session of entry.map.sessions) {
        if (session.queued == null) continue;
        found.push({
          ref: { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id },
          queued: session.queued,
        });
      }
    }
    return found.sort((a, b) => compareQueued(a.queued, b.queued));
  }

  /** Сессии, занимающие слот: живые PTY хоста и запуски с резервом (у только что стартовавшего есть и то, и другое). */
  function occupiedKeys(): Set<string> {
    const keys = new Set(reserved);
    for (const handle of deps.pty.list()) keys.add(refKey(handle.ref));
    return keys;
  }

  /**
   * Снимает отметку продвижения у подъёма письмом: его `retry` ничего не обещает, и она уходит по `settle`, ответу `queue`
   * или сроку. У запуска через `launch` отметку снимает исход его промиса (`launchFromQueue`), поэтому здесь она остаётся:
   * пока запуск не вернулся, насос не берёт запись второй раз.
   */
  function releaseMail(key: string): void {
    if (inFlight.get(key)?.deadline != null) inFlight.delete(key);
  }

  /** Записи очереди по порядку и их положение. Подъём письмом, не дошедший до допуска к сроку, становится `stale`. */
  function standings(): Array<Entry & { standing: Standing }> {
    const t = now();
    for (const [key, flight] of inFlight) {
      if (flight.deadline === null || flight.admitted || t < flight.deadline) continue;
      inFlight.delete(key);
      stale.add(key);
    }
    const taken = occupiedKeys();
    return queue().map((entry) => {
      const key = refKey(entry.ref);
      let standing: Standing = 'waiting';
      if (taken.has(key)) standing = 'starting';
      else if (inFlight.has(key)) standing = 'in-flight';
      else if ((backoff.get(key) ?? 0) > t) standing = 'paused';
      else if (stale.has(key)) standing = 'stale';
      else if ((bounced.get(key) ?? 0) > t) standing = 'bounced';
      return { ...entry, key, standing };
    });
  }

  /**
   * Вход допуска по состоянию хоста сейчас. Без `await`: решение и резерв видят одно и то же. Сам запуск в занятых и среди
   * «сверх потолка» не считается; своя запись, если сессия уже в очереди, берёт свой `at` из снимка, иначе запуск новый —
   * и встаёт за всеми. Записи в продвижении идут в `ahead` только нового запуска: запуск самой продвигаемой записи (его ключ
   * в `inFlight`) их не считает, иначе записи, продвинутые вместе на несколько слотов, отбрасывали бы друг друга.
   */
  function inputOf(ref: SessionRef, launchClass: LaunchClass, limit: number | null): AdmissionInput {
    const key = refKey(ref);
    const entries = standings();
    const own = entries.find((entry) => entry.key === key);
    const at = own?.queued.at ?? new Date(now()).toISOString();
    const pumped = inFlight.has(key);
    // Движок в очередь не встаёт: впереди него не ждёт никто.
    const ahead =
      launchClass === 'engine'
        ? 0
        : queuedAhead(
            entries.filter(
              (entry) =>
                entry.standing === 'waiting' ||
                entry.standing === 'bounced' ||
                (entry.standing === 'in-flight' && !pumped),
            ),
            { key, class: launchClass, at },
          );
    const taken = occupiedKeys();
    return {
      launchClass,
      occupied: taken.size - (taken.has(key) ? 1 : 0),
      limit,
      pressure: deps.pressure.current().level,
      overflowLive: overflow.size - (overflow.has(key) ? 1 : 0),
      ahead,
    };
  }

  async function admit(request: { ref: SessionRef; launchClass: LaunchClass }): Promise<MachineTicket> {
    const { ref, launchClass } = request;
    const key = refKey(ref);
    // Допуск этой сессии начался: подъём письмом дошёл до `launch` — по сроку он `stale` уже не станет, а запись,
    // застрявшую раньше, допуск возвращает в очередь.
    stale.delete(key);
    staleRetriedAt.delete(key);
    const flight = inFlight.get(key);
    if (flight !== undefined) flight.admitted = true;

    const config = await deps.config();
    const limit = machineLimit(config.machineConcurrent, totalMem);

    // От проверки до резерва — ни одного `await`: два допуска подряд при одном свободном слоте видят разное число занятых.
    let input = inputOf(ref, launchClass, limit);
    let decision: Admission = machineAdmission(input);

    // Слота нет: до очереди хост пробует освободить его сном самой давней простаивающей сессии. Только если впереди никого
    // нет: освободившееся место принадлежит тому, кто впереди, и новый запуск не обгоняет очередь.
    if (decision.kind !== 'start' && limit !== null && input.ahead === 0 && config.sleepAfterMinutes > 0) {
      const sleeper = deps.sleep();
      if (sleeper !== undefined) {
        let freed = false;
        freeing += 1;
        try {
          freed = await sleeper.freeSlot();
        } catch (error) {
          // Сбой сна не должен ронять запуск: слот не освободился, решает класс.
          host.log.error('очередь машины: сон ради слота не удался', { ref, error: String(error) });
        } finally {
          freeing -= 1;
        }
        // Места могли занять, пока усыпляли: проверка и резерв снова идут одним синхронным участком.
        input = inputOf(ref, launchClass, limit);
        decision = freed && input.occupied < limit ? { kind: 'start' } : machineAdmission(input);
      }
    }

    if (decision.kind === 'queue') {
      // Запись, которую насос только что продвинул, вернулась: до освобождения слота или `BOUNCE_MS` её не берут заново.
      if (inFlight.has(key)) bounced.set(key, now() + BOUNCE_MS);
      // Запись снова ждёт своей очереди.
      releaseMail(key);
    } else {
      reserved.add(key);
      if (decision.kind === 'overflow') overflow.add(key);
    }
    return { ...decision, live: input.occupied, limit };
  }

  /** Просит будильник перепроверить письма сессии. Не бросает: сбой одной записи не должен остановить проход насоса. */
  function retryMail(ref: SessionRef): void {
    try {
      deps.retry(ref);
    } catch (error) {
      host.log.error('очередь машины: будильник не принял повтор', { ref, error: String(error) });
    }
  }

  /**
   * Снимает запись очереди. `message` — почему запуск отказал насовсем (иначе очередь крутилась бы вечно): тогда создатель-
   * агент, который ещё в карте и не закрыт, получает системное письмо. `null` — запуск не отказан, а передан пути согласия
   * на папку: письма нет. Одна запись карты. Не бросает; `false` — запись не удалось снять (карта недоступна).
   */
  async function dropQueued(ref: SessionRef, message: string | null): Promise<boolean> {
    const result: { dropped: boolean; notified: string | null } = { dropped: false, notified: null };
    try {
      await updateMap(
        ref.projectPath,
        ref.workId,
        (map, letters) => {
          const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
          // Записи уже нет: сессия стартовала, закрыта или удалена — отказывать нечему.
          if (session?.queued == null) return;
          const { queued } = session;
          // Ключ удаляется, а не пишется `null`, как у `transitionSession`.
          delete session.queued;
          result.dropped = true;
          const creator = session.createdBy;
          if (message === null || queued.class !== 'agent' || creator == null) return;
          if (!map.sessions.some((candidate) => candidate.id === creator && candidate.lifecycle !== 'closed')) return;
          letters.add({
            roomId: null,
            from: SYSTEM,
            to: [creator],
            text: `${sessionTag(ref.sessionId)} was not started: ${message}`,
            kind: 'note',
          });
          result.notified = creator;
        },
        // Служебная запись, не событие работы: карточка работы не всплывает в сайдбаре.
        { touch: false },
      );
    } catch (mapError) {
      host.log.error('очередь машины: запись очереди не снялась', { ref, error: String(mapError) });
      return false;
    }
    if (result.dropped) {
      if (message === null) {
        host.log.info('очередь машины: запуск ждёт согласия на папку, запись очереди снята', { ref });
      } else {
        host.log.warn('очередь машины: запуск из очереди отказал насовсем, запись снята', {
          ref,
          error: message,
          notified: result.notified,
        });
      }
    }
    return true;
  }

  /** Запись остаётся в очереди, но насос не берёт её `BUDGET_BACKOFF_MS`. */
  function pause(key: string): void {
    backoff.set(key, now() + BUDGET_BACKOFF_MS);
  }

  /** Продолжает запись через `launch`: по исходу снимает продвижение и зовёт насос. */
  async function launchFromQueue({ ref, key, queued }: Entry): Promise<void> {
    try {
      const outcome = await deps.launch(ref, queued.mode, { by: queued.by });
      backoff.delete(key);
      // Codex ждёт согласия человека на папку: запуск ведёт путь согласия и сам продолжит его после решения, запись очереди
      // ему не нужна. Письма нет — запуск не отказан, а отложен. Отметка продвижения стоит, пока запись снимают.
      if (outcome === 'held' && !(await dropQueued(ref, null))) pause(key);
    } catch (error) {
      if (isResourceDenial(error)) {
        // Запись остаётся: бюджет работы освободится сам, повтор не раньше чем через `BUDGET_BACKOFF_MS`.
        pause(key);
        host.log.info('очередь машины: бюджет работы отказал, запись ждёт', { ref, pauseMs: BUDGET_BACKOFF_MS });
      } else if (!(await dropQueued(ref, messageOf(error)))) {
        // Запись не снялась: повтор не сразу, иначе отказ и неудачная запись крутились бы без пауз.
        pause(key);
      }
    } finally {
      inFlight.delete(key);
    }
    pump();
  }

  /**
   * Продвигает запись. Подъём письмом (`resume` от `wake`) идёт через будильник: он сам соберёт указатель на письма заново;
   * остальное — через `launch`, как у удержанного запуска (`consents/held-launches.ts`).
   */
  function advance(entry: Entry): void {
    const { ref, key, queued } = entry;
    const byMail = queued.mode === 'resume' && queued.by === 'wake';
    inFlight.set(key, { deadline: byMail ? now() + IN_FLIGHT_MS : null, admitted: false });
    host.log.info('очередь машины: запись продвигается', { ref, class: queued.class, mode: queued.mode, by: queued.by });
    if (byMail) retryMail(ref);
    else void launchFromQueue(entry);
  }

  /** Один проход насоса по уже прочитанным настройкам: все вычисления идут синхронно. */
  function advanceQueue(limit: number | null, sleepEnabled: boolean): void {
    const entries = standings();
    const present = new Set(entries.map((entry) => entry.key));
    for (const key of stale) if (!present.has(key)) stale.delete(key);
    for (const key of backoff.keys()) if (!present.has(key)) backoff.delete(key);
    for (const key of bounced.keys()) if (!present.has(key)) bounced.delete(key);
    for (const key of staleRetriedAt.keys()) if (!stale.has(key)) staleRetriedAt.delete(key);

    // Подъёму письмом, которого будильник не принял в срок, условия могли смениться. Но `retry` снимает у будильника его
    // паузу бюджета: на каждом проходе отказанный запуск шёл бы заново и писал бы отказ в журнал, поэтому — раз в
    // `BUDGET_BACKOFF_MS` на запись.
    const t = now();
    for (const entry of entries) {
      if (entry.standing !== 'stale') continue;
      const last = staleRetriedAt.get(entry.key);
      if (last !== undefined && t - last < BUDGET_BACKOFF_MS) continue;
      staleRetriedAt.set(entry.key, t);
      retryMail(entry.ref);
    }

    const waiting = entries.filter((entry) => entry.standing === 'waiting');
    if (waiting.length === 0) return;
    let batch: Entry[] = [];
    if (limit === null) {
      // Потолок выключен: все оставшиеся записи стартуют сами.
      batch = waiting;
    } else {
      const free = deps.pressure.current().level === 'critical' ? 0 : limit - occupiedKeys().size - freeing;
      if (free > 0) batch = waiting.slice(0, free);
      // Мест нет, но есть кого усыпить: продвигается одна первая, а её допуск сам усыпит кандидата.
      else if (sleepEnabled && deps.sleep()?.slotCandidate() === true) batch = waiting.slice(0, 1);
    }
    for (const entry of batch) advance(entry);
  }

  async function pass(): Promise<void> {
    // Очередь пуста — настройки с диска не читаем: насос зовут на каждое изменение работ.
    if (queue().length === 0) {
      stale.clear();
      backoff.clear();
      bounced.clear();
      staleRetriedAt.clear();
      return;
    }
    const config = await deps.config();
    if (stopped) return;
    advanceQueue(machineLimit(config.machineConcurrent, totalMem), config.sleepAfterMinutes > 0);
  }

  /** Насос идёт по одному за раз: событие, пришедшее посреди прохода, даёт ещё один проход после него. */
  function pump(): void {
    if (stopped) return;
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    void pass()
      .catch((error: unknown) => {
        host.log.error('очередь машины: проход насоса не удался', { error: String(error) });
      })
      .finally(() => {
        pumping = false;
        if (pumpAgain) {
          pumpAgain = false;
          pump();
        }
      });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      lastLevel = deps.pressure.current().level;
      unsubscribes = [
        // Процесс вышел: слот свободен, «сверх потолка» этой сессии больше нет, а отскочившие записи могут идти.
        deps.pty.on('exit', (ref) => {
          overflow.delete(refKey(ref));
          bounced.clear();
          pump();
        }),
        deps.works.onChange(() => pump()),
        // Раз в 10 с, пока очередь не пуста: давление могло спасть, а настройки — смениться (потолок выключили). Другой
        // уровень давления, чем в прошлом чтении, меняет и решение допуска: отскочившие записи могут идти.
        deps.pressure.onReading((reading) => {
          if (reading.level !== lastLevel) bounced.clear();
          lastLevel = reading.level;
          pump();
        }),
      ];
      // Старт хоста: очередь собирается из карт заново.
      pump();
    },

    stop() {
      stopped = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      unsubscribes = [];
      reserved.clear();
      overflow.clear();
      inFlight.clear();
      stale.clear();
      backoff.clear();
      bounced.clear();
      staleRetriedAt.clear();
      pumpAgain = false;
    },

    admit,

    settle(ref) {
      const key = refKey(ref);
      const released = reserved.delete(key);
      releaseMail(key);
      // Процесса нет — запуск отказал до старта, и места «сверх потолка» он не занимает.
      if (deps.pty.get(ref) === undefined) {
        overflow.delete(key);
        // Резерв снят, а процесса нет: слот на деле освободился, отскочившие записи могут идти — насос зовём сразу.
        if (released) {
          bounced.clear();
          pump();
        }
      }
    },

    pump,

    queue,

    occupied: () => occupiedKeys().size,
  };
}
