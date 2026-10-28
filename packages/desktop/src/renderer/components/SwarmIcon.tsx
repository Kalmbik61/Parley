/**
 * Значок роя (спека роя v1, 7.5). Живая иконка на движке роя души острова — следующий коммит; пока значок статичный,
 * чтобы все четыре места показа уже стояли на своих местах и не менялись при подключении анимации.
 */

import type { SwarmStatus } from '@parley/core/swarms';

export interface SwarmIconProps {
  status: SwarmStatus;
  /** Сторона значка, px: строка роя ~16, чип шапки и значок карточки ~14. */
  size: number;
  /** Сколько участников уже сдали: рост даёт вспышку (`glint`). */
  handed?: number;
  /** Значок группы проекта и всё, что не должно двигаться. */
  still?: boolean;
  /** Окно или остров: у каждого свой предел живых иконок. */
  scope?: 'window' | 'island';
}

export function SwarmIcon({ status, size }: SwarmIconProps): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-swarm-icon={status}
      className="inline-flex shrink-0 items-center justify-center leading-none"
      style={{ width: size, height: size, fontSize: size - 2 }}
    >
      🐝
    </span>
  );
}
