/**
 * Живая иконка роя (спека роя v1, 7.5): готовый `<Swarm>` из `island/swarm/` — canvas и частицы движка острова, без
 * нового движка; облик выбирает `swarmIconSpec(status)`. Идущий рой анимируется (~12 к/с), законченный и все иконки
 * сверх трёх (`useSwarmIconSlot`) — статичный кадр. Reduce motion (настройка Parley или системная) и `still` (значок
 * свёрнутой группы) — статично. Одна реакция на переход в `done`, вспышка (`glint`), когда сдал новый участник.
 *
 * Рой стоит на тёмном диске: свечение движка аддитивное и на светлом сайдбаре почти не видно. `size` — сторона холста,
 * диск добавляет 1–2 px вокруг; в 14–16 px рой рисуется крупнее, чем в капсуле (`d` на весь холст), иначе видна одна точка.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SwarmStatus } from '@parley/core/swarms';
import { isSwarmTerminal } from '@parley/core/swarms';
import { Swarm } from '../island/swarm/Swarm.js';
import { REACTION_FOR, type SwarmPulse } from '../island/swarm/spec.js';
import { useSwarmIconSlot } from '../lib/swarm-icon-slots.js';
import { SWARM_ICON_FPS, swarmIconSpec } from '../lib/swarm-view.js';

export interface SwarmIconProps {
  status: SwarmStatus;
  /** Сторона холста, px: строка роя ~16, чип шапки и значок карточки ~14. */
  size: number;
  /** Сколько участников уже сдали: рост даёт вспышку (`glint`). */
  handed?: number;
  /** Значок группы проекта и всё, что не должно двигаться. */
  still?: boolean;
  /**
   * Настройка Parley «Reduce motion»: у окна — `ui.island.motion` (`useSwarmIconMotion`), у острова — `config.motion`.
   * Системное «уменьшить движение» `<Swarm>` учитывает сам. Стор окна иконка не импортирует: её берёт и остров.
   */
  reducedMotion?: boolean;
}

export function SwarmIcon({ status, size, handed = 0, still = false, reducedMotion = false }: SwarmIconProps): JSX.Element {
  const reduced = reducedMotion;
  const slot = useSwarmIconSlot(!isSwarmTerminal(status) && !still && !reduced);
  const spec = useMemo(() => swarmIconSpec(status), [status]);

  // Реакции: переход в `done` и каждый новый сдавший. Первый показ реакций не даёт.
  const [pulse, setPulse] = useState<SwarmPulse | null>(null);
  const previous = useRef({ status, handed });
  useEffect(() => {
    const before = previous.current;
    previous.current = { status, handed };
    if (status !== before.status && status === 'done') setPulse({ reaction: REACTION_FOR.done, at: performance.now() });
    else if (handed > before.handed) setPulse({ reaction: 'glint', at: performance.now() });
  }, [status, handed]);

  return (
    <span
      aria-hidden="true"
      data-swarm-icon={status}
      data-live={slot ? '' : undefined}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-[#1b1612] leading-[0]"
      style={{ padding: size <= 14 ? 1 : 2 }}
    >
      <Swarm
        spec={spec}
        souls={size >= 20 ? 150 : 110}
        width={size}
        height={size}
        d={Math.round(size * 0.9)}
        cy={size / 2}
        k={0.15}
        minPx={1.8}
        seed={5}
        fps={slot ? SWARM_ICON_FPS : 0}
        pulse={pulse}
        reducedMotion={reduced}
        className="block"
      />
    </span>
  );
}
