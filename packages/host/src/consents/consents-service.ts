/**
 * Согласия человека на папку (спека 2026-10-21, 4.2 и 4.4): запуск Codex в проекте без записи в `trust.json`
 * останавливается до решения, а хост хранит карточку «доверять ли папке агентам» и удержанные запуски. Карточка одна
 * на папку: второй запуск в том же проекте добавляет к ней своё удержание. `allow` пишет `trust.json` и продолжает все
 * удержанные запуски, `deny` отказывает им. Состояние — `<home>/consents.json`, переживает перезапуск хоста: таймаута
 * у согласия нет.
 *
 * Запись файла синхронная и атомарная (`<файл>.<uuid>.tmp` с 0600 + `rename`, образец — `telegram/state.ts`): методы
 * сервиса (`request`) отвечают сразу, а очередь записей не нужна.
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { refKey } from '@parley/protocol';
import type { AgentSwitchCard, ConsentCard, FolderTrustCard, SessionRef, TrustRecord } from '@parley/protocol';
import type { HostContext } from '../context.js';

/** Запуск, остановленный до согласия: его продолжает или отвергает решение человека. */
export interface HeldLaunch {
  ref: SessionRef;
  mode: 'launch' | 'resume';
  /** Кто просил запуск (`LaunchChoice.by`): продолжение просит его от имени того же актёра. */
  by: string;
}

export interface ConsentChange {
  upsert: ConsentCard[];
  removed: string[];
}

export interface ConsentsService {
  /** Только ждущие карточки. */
  list(): ConsentCard[];
  /** Одна карточка на `folder`: второй запрос добавляет удержание к ждущей карточке. */
  request(
    input: { projectPath: string; folder: string; requestedBy: FolderTrustCard['requestedBy'] },
    hold: HeldLaunch,
  ): ConsentCard;
  /**
   * Просьба агента продолжить сессию на другом провайдере (`request_agent_switch`): карточка `agent-switch`, ничего
   * больше не меняется. Повтор той же просьбы (цель, провайдер, модель), пока карточка ждёт, — та же карточка.
   */
  requestSwitch(input: Omit<AgentSwitchCard, 'id' | 'kind' | 'projectPath' | 'at' | 'state'>): ConsentCard;
  /**
   * `by` — откуда пришло решение (запись в `trust.json`); окно и остров — `window`. Второе решение по той же
   * карточке — `applied: false`. Продолжение или отказ удержанных запусков идут в фоне: ответ не ждёт запуска
   * процессов.
   */
  decide(
    id: string,
    decision: 'allow' | 'deny',
    by?: TrustRecord['by'],
  ): Promise<{ applied: boolean; state: ConsentCard['state'] }>;
  onChange(listener: (change: ConsentChange) => void): () => void;
  stop(): void;
}

export interface ConsentsDeps {
  home: string;
  host: Pick<HostContext, 'broadcast' | 'log'>;
  trust: { grant(folder: string, by: TrustRecord['by']): Promise<unknown> };
  continueLaunch(hold: HeldLaunch): Promise<void>;
  refuseLaunch(hold: HeldLaunch): Promise<void>;
  /** Замена агента от имени человека: `allow` карточки `agent-switch` (`requestId` — id карточки). */
  switchAgent(
    ref: SessionRef,
    request: { requestId: string; provider: string; model: string | null; by: string },
  ): Promise<unknown>;
  /** Письмо `parley` просившему агенту: отказ человека или ошибка замены. */
  tellRequester(ref: SessionRef, to: string, text: string): Promise<void>;
  /** Уведомление окну: замена, которую человек разрешил, не удалась. */
  noticeFailure(ref: SessionRef, text: string): void;
  /** Держать больше нечего: сессия уже жива, закрыта или исчезла. На старте такие удержания снимаются. */
  isLive(ref: SessionRef): Promise<boolean>;
}

interface ConsentsFile {
  version: 1;
  /** Последний выданный номер карточки: сквозной счёт переживает обрезку решённых карточек. */
  seq: number;
  cards: ConsentCard[];
  holds: Record<string, HeldLaunch[]>;
}

/** Решённых карточек в файле остаётся столько, чтобы второе нажатие получало «уже решено», а файл не рос. */
const DECIDED_KEPT = 50;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function validRef(value: unknown): value is SessionRef {
  return (
    isRecord(value) &&
    typeof value['projectPath'] === 'string' &&
    typeof value['workId'] === 'string' &&
    typeof value['sessionId'] === 'string'
  );
}

function validHold(value: unknown): value is HeldLaunch {
  return (
    isRecord(value) &&
    validRef(value['ref']) &&
    (value['mode'] === 'launch' || value['mode'] === 'resume') &&
    typeof value['by'] === 'string'
  );
}

function validCard(value: unknown): value is ConsentCard {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['projectPath'] === 'string' &&
    isRecord(value['requestedBy']) &&
    typeof value['at'] === 'string' &&
    (value['state'] === 'pending' || value['state'] === 'allowed' || value['state'] === 'denied') &&
    (value['kind'] === 'agent-switch'
      ? validRef(value['ref']) &&
        typeof value['provider'] === 'string' &&
        typeof value['providerLabel'] === 'string' &&
        (value['model'] === null || typeof value['model'] === 'string') &&
        typeof value['reason'] === 'string' &&
        typeof value['requestedBy']['sessionId'] === 'string'
      : value['kind'] === 'folder-trust' && typeof value['folder'] === 'string')
  );
}

const cardNumber = (id: string): number => {
  const match = /^c-(\d+)$/.exec(id);
  return match === null ? 0 : Number(match[1]);
};

export function createConsentsService(deps: ConsentsDeps): ConsentsService {
  const file = path.join(deps.home, 'consents.json');
  const listeners = new Set<(change: ConsentChange) => void>();
  let stopped = false;
  const state = load();

  function load(): ConsentsFile {
    const empty: ConsentsFile = { version: 1, seq: 0, cards: [], holds: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      // Файла нет — первый запуск; прочее — битый файл: начинаем с пустого, человека спросят ещё раз.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        deps.host.log.warn('consents: файл повреждён, начинаем с пустого', { error: String(error) });
      }
      return empty;
    }
    if (!isRecord(parsed) || parsed['version'] !== 1 || !Array.isArray(parsed['cards'])) {
      deps.host.log.warn('consents: неожиданная форма файла, начинаем с пустого');
      return empty;
    }
    const cards = parsed['cards'].filter(validCard);
    const holdsRaw = isRecord(parsed['holds']) ? parsed['holds'] : {};
    const holds: Record<string, HeldLaunch[]> = {};
    for (const card of cards) {
      const list = holdsRaw[card.id];
      if (card.state === 'pending' && Array.isArray(list)) holds[card.id] = list.filter(validHold);
    }
    const seq = Math.max(
      typeof parsed['seq'] === 'number' ? parsed['seq'] : 0,
      ...cards.map((card) => cardNumber(card.id)),
    );
    return { version: 1, seq, cards, holds };
  }

  function save(): void {
    try {
      mkdirSync(deps.home, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, file);
      } catch (error) {
        rmSync(tmp, { force: true });
        throw error;
      }
    } catch (error) {
      deps.host.log.warn('consents: файл не записан', { error: String(error) });
    }
  }

  function emit(change: ConsentChange): void {
    if (stopped) return;
    deps.host.broadcast('consents.changed', change);
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (error) {
        deps.host.log.warn('consents: подписчик упал', { error: String(error) });
      }
    }
  }

  const pending = (): ConsentCard[] => state.cards.filter((card) => card.state === 'pending');

  /** Решённые карточки старше последних `DECIDED_KEPT` забываются. */
  function trimDecided(): void {
    const decided = state.cards.filter((card) => card.state !== 'pending');
    const drop = new Set(decided.slice(0, Math.max(0, decided.length - DECIDED_KEPT)).map((card) => card.id));
    if (drop.size > 0) state.cards = state.cards.filter((card) => !drop.has(card.id));
  }

  /**
   * Старт хоста: удержания сессий, которым держать нечего (уже живы, закрыты, исчезли), снимаются; карточка без
   * удержаний — тоже. Идёт в фоне — сервис отвечает сразу; сбой проверки оставляет удержание на месте.
   */
  async function prune(): Promise<void> {
    const snapshot = pending().map((card) => ({ id: card.id, holds: [...(state.holds[card.id] ?? [])] }));
    const gone = new Map<string, Set<string>>();
    for (const item of snapshot) {
      for (const hold of item.holds) {
        const live = await deps.isLive(hold.ref).catch(() => false);
        if (!live) continue;
        const keys = gone.get(item.id) ?? new Set<string>();
        keys.add(`${refKey(hold.ref)}\0${hold.mode}`);
        gone.set(item.id, keys);
      }
    }
    if (stopped) return;
    const removed: string[] = [];
    for (const [id, keys] of gone) {
      const card = state.cards.find((candidate) => candidate.id === id);
      if (card === undefined || card.state !== 'pending') continue;
      const left = (state.holds[id] ?? []).filter((hold) => !keys.has(`${refKey(hold.ref)}\0${hold.mode}`));
      if (left.length > 0) {
        state.holds[id] = left;
        continue;
      }
      state.cards = state.cards.filter((candidate) => candidate.id !== id);
      delete state.holds[id];
      removed.push(id);
    }
    if (removed.length === 0 && gone.size === 0) return;
    save();
    if (removed.length > 0) emit({ upsert: [], removed });
  }

  void prune().catch((error: unknown) => {
    deps.host.log.warn('consents: сверка удержаний не удалась', { error: String(error) });
  });

  async function run(label: string, hold: HeldLaunch, action: (hold: HeldLaunch) => Promise<void>): Promise<void> {
    try {
      await action(hold);
    } catch (error) {
      deps.host.log.warn(`consents: ${label} удержанного запуска не удалось`, { ref: hold.ref, error: String(error) });
    }
  }

  /** Исход карточки `agent-switch`: `allow` — замена от имени человека, `deny` — письмо просившему. */
  async function answerSwitch(card: AgentSwitchCard, decision: 'allow' | 'deny'): Promise<void> {
    const { ref, requestedBy } = card;
    const target = `@${ref.sessionId.replace('-', '')}`;
    const tell = (text: string): Promise<void> =>
      deps.tellRequester(ref, requestedBy.sessionId, text).catch((error: unknown) => {
        deps.host.log.warn('consents: письмо о замене не записано', { ref, error: String(error) });
      });
    if (decision === 'deny') {
      await tell(`@human declined to continue ${target} on ${card.providerLabel}. Nothing changed.`);
      return;
    }
    try {
      await deps.switchAgent(ref, { requestId: card.id, provider: card.provider, model: card.model, by: requestedBy.sessionId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.host.log.warn('consents: замена агента не удалась', { ref, error: reason });
      deps.noticeFailure(ref, `continuing ${ref.sessionId} on ${card.providerLabel} failed: ${reason}`);
      await tell(`@human allowed continuing ${target} on ${card.providerLabel}, but the switch failed: ${reason}`);
    }
  }

  return {
    list: () => pending().map((card) => ({ ...card })),

    request(input, hold) {
      const existing = pending().find((card) => card.kind === 'folder-trust' && card.folder === input.folder);
      if (existing !== undefined) {
        const holds = state.holds[existing.id] ?? [];
        const same = (candidate: HeldLaunch): boolean =>
          refKey(candidate.ref) === refKey(hold.ref) && candidate.mode === hold.mode;
        if (!holds.some(same)) {
          state.holds[existing.id] = [...holds, hold];
          save();
        }
        return { ...existing };
      }
      state.seq += 1;
      const card: ConsentCard = {
        id: `c-${String(state.seq).padStart(2, '0')}`,
        kind: 'folder-trust',
        folder: input.folder,
        projectPath: input.projectPath,
        requestedBy: input.requestedBy,
        at: new Date().toISOString(),
        state: 'pending',
      };
      state.cards.push(card);
      state.holds[card.id] = [hold];
      save();
      emit({ upsert: [{ ...card }], removed: [] });
      return { ...card };
    },

    requestSwitch(input) {
      const existing = pending().find(
        (card) =>
          card.kind === 'agent-switch' &&
          refKey(card.ref) === refKey(input.ref) &&
          card.provider === input.provider &&
          card.model === input.model,
      );
      if (existing !== undefined) return { ...existing };
      state.seq += 1;
      const card: AgentSwitchCard = {
        ...input,
        id: `c-${String(state.seq).padStart(2, '0')}`,
        kind: 'agent-switch',
        projectPath: input.ref.projectPath,
        at: new Date().toISOString(),
        state: 'pending',
      };
      state.cards.push(card);
      save();
      emit({ upsert: [{ ...card }], removed: [] });
      return { ...card };
    },

    async decide(id, decision, by = 'window') {
      const card = state.cards.find((candidate) => candidate.id === id);
      // Незнакомая карточка — уже закрытая (решена давно и забыта): «уже решено», а не ошибка.
      if (card === undefined) return { applied: false, state: 'denied' };
      if (card.state !== 'pending') return { applied: false, state: card.state };
      // Решение занимается синхронно: второе нажатие, пришедшее за время записи доверия, получит `applied: false`.
      card.state = decision === 'allow' ? 'allowed' : 'denied';
      if (card.kind === 'agent-switch') {
        // Карточка сама ничего не запускает: замену выполняет только `allow`, и в фоне — как удержанные запуски.
        trimDecided();
        save();
        void answerSwitch(card, decision);
        emit({ upsert: [], removed: [id] });
        return { applied: true, state: card.state };
      }
      if (decision === 'allow') {
        try {
          await deps.trust.grant(card.folder, by);
        } catch (error) {
          card.state = 'pending';
          throw error;
        }
      }
      const holds = state.holds[id] ?? [];
      delete state.holds[id];
      trimDecided();
      save();
      const action = decision === 'allow' ? deps.continueLaunch : deps.refuseLaunch;
      const label = decision === 'allow' ? 'continuation' : 'refusal';
      // В фоне: запуск процесса занимает секунды, а ответ человеку («Done ✓», «Trusted ✓») ждать его не должен.
      for (const hold of holds) void run(label, hold, action);
      emit({ upsert: [], removed: [id] });
      return { applied: true, state: card.state };
    },

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    stop() {
      stopped = true;
      listeners.clear();
    },
  };
}
