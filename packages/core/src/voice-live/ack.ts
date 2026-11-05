/**
 * Правило подтверждений (спека «Голос↔Ассистент» §4, T0 §2b–c): любой `thinking.append` / `commentary.append` может
 * подавить ещё ожидающее автоподтверждение делегации. Пока открытая делегация ждёт слышимого подтверждения, append
 * откладывается, но не дольше `ACK_WAIT_MS` от `delegation.created`; прогресс своей делегации можно слать сразу.
 * После срока фиксируется `ack_audible`: `true` (модель начала воспроизведение), `false` или `'unknown'`.
 * Отсутствие звука append навсегда не блокирует. Старт job от подтверждения не зависит.
 */

export const ACK_WAIT_MS = 2500;

export type AckAudible = boolean | 'unknown';

export interface AckTrackerOptions {
  now(): number;
  /** Может ли клиент вообще измерить воспроизведение (есть ли удалённый трек); нет — вместо `false` будет `'unknown'`. */
  canMeasurePlayback?(): boolean;
  waitMs?: number;
  onResolved?(delegationId: string, audible: AckAudible, waitedMs: number): void;
}

export type AppendPurpose = 'progress' | 'result';

export interface AckTracker {
  open(delegationId: string): void;
  /** Сигнал «модель воспроизводит»: включение закрывает самое раннее ожидание как слышимое. */
  modelPlaying(value: boolean): void;
  /** Закрывает ожидания, у которых вышел срок. Вызывается и из `canAppend`, и тиком. */
  tick(): void;
  /** Делегации, чьё подтверждение ещё ждём (после `tick`). */
  awaiting(): string[];
  /** `progress` своей делегации разрешён сразу; остальное — когда никто не ждёт подтверждения. */
  canAppend(delegationId: string | null, purpose: AppendPurpose): boolean;
  /** Итог по делегации; `undefined` — неизвестная, `'pending'` — ещё ждём. */
  result(delegationId: string): AckAudible | 'pending' | undefined;
  /** Забыть всё (новая сессия). */
  reset(): void;
}

interface Pending {
  delegationId: string;
  openedAt: number;
}

export function createAckTracker(options: AckTrackerOptions): AckTracker {
  const waitMs = options.waitMs ?? ACK_WAIT_MS;
  let pending: Pending[] = [];
  let playing = false;
  const results = new Map<string, AckAudible>();

  const resolve = (item: Pending, audible: AckAudible): void => {
    pending = pending.filter((candidate) => candidate !== item);
    results.set(item.delegationId, audible);
    options.onResolved?.(item.delegationId, audible, options.now() - item.openedAt);
  };

  const tick = (): void => {
    const at = options.now();
    for (const item of [...pending]) {
      if (at - item.openedAt < waitMs) continue;
      // Модель уже говорила до делегации и не замолкала: чьё это подтверждение, не различить.
      const measurable = options.canMeasurePlayback?.() ?? true;
      resolve(item, !measurable || playing ? 'unknown' : false);
    }
  };

  return {
    open(delegationId) {
      if (results.has(delegationId) || pending.some((item) => item.delegationId === delegationId)) return;
      pending.push({ delegationId, openedAt: options.now() });
    },
    modelPlaying(value) {
      const rising = value && !playing;
      if (rising) tick();
      playing = value;
      if (!rising) return;
      const oldest = pending[0];
      if (oldest !== undefined) resolve(oldest, true);
    },
    tick,
    awaiting() {
      tick();
      return pending.map((item) => item.delegationId);
    },
    canAppend(delegationId, purpose) {
      tick();
      const blockers = pending.filter((item) => !(purpose === 'progress' && delegationId !== null && item.delegationId === delegationId));
      return blockers.length === 0;
    },
    result(delegationId) {
      tick();
      if (pending.some((item) => item.delegationId === delegationId)) return 'pending';
      return results.get(delegationId);
    },
    reset() {
      pending = [];
      results.clear();
      playing = false;
    },
  };
}
