/**
 * Лимит подъёмов спящей сессии письмами (спецификация 7.4): не больше
 * `resumeRate` за скользящий час на сессию. Без него переписка двух агентов,
 * которые будят друг друга, за ночь сожгла бы подписку.
 *
 * Час скользящий, а не календарный: шесть подъёмов в 00:59 и ещё шесть в 01:01
 * — это двенадцать за две минуты, и календарный час бы их пропустил.
 */

import { refKey } from '@harnas/protocol';
import type { SessionRef } from '@harnas/protocol';

const HOUR_MS = 60 * 60 * 1000;

export class ResumeLimiter {
  /** Моменты разрешённых подъёмов по сессиям — только в пределах последнего часа. */
  private readonly taken = new Map<string, number[]>();
  private readonly rate: () => number;
  private readonly now: () => number;

  /** `rate` — функцией: настройку можно поменять, пока хост жив. */
  constructor(rate: () => number, now: () => number = Date.now) {
    this.rate = rate;
    this.now = now;
  }

  /** Берёт подъём из лимита сессии; `false` — лимит часа исчерпан, подъёма нет. */
  tryTake(ref: SessionRef): boolean {
    const key = refKey(ref);
    const at = this.now();
    const recent = (this.taken.get(key) ?? []).filter((moment) => at - moment < HOUR_MS);
    const allowed = recent.length < this.rate();
    if (allowed) recent.push(at);
    this.taken.set(key, recent);
    return allowed;
  }
}
