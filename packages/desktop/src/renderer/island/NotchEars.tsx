/**
 * Уши острова в вырезе (#9 §12.1, план 3b B28): на дисплее с вырезом убранная форма продолжает вырез — чёрная полоса
 * высотой выреза, слева от него мини-рой, справа один статус. Оба уха одной ширины `max(h + 4, статус + 18)`: иначе
 * форма сползла бы с центра выреза. Ширину статуса уши замеряют сами, поэтому невидимые уши в зоне нажатия
 * (`IslandTab`) выходят той же ширины, что и видимые в форме (`IslandView`).
 *
 * Статус по приоритету: ошибка помощника (красная точка и «!») → ждёт тебя N (сессии и предложения комнат) → работает
 * N (синяя точка, пульсирует прозрачностью) → `✅ N`. Рой в ухе — 24 px, по правилам малого роя: реакция только
 * вспышкой, в покое 0 к/с, 30 к/с — пока помощник занят, как мини-рой пилюли. Уши проступают `island-reveal`; при
 * уменьшенном движении (§12.5) появление, пульс точки и рой стоят.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { IslandConfig } from '../../shared/island.js';
import { S } from '../../shared/strings.js';
import { HOST_IDLE } from './assistant/store.js';
import type { IslandAssistantProps } from './IslandView.js';
import type { IslandModel } from './model.js';
import { Swarm } from './swarm/Swarm.js';
import { swarmSpecFor, type SwarmPulse } from './swarm/spec.js';

/** Вырез дисплея острова (`IslandConfig.notch`): ширина, высота и центр от левого края кадра окна, pt. */
export type Notch = NonNullable<IslandConfig['notch']>;

/** Один статус правого уха. */
export type EarStatus = { kind: 'error' } | { kind: 'waiting' | 'working' | 'done'; count: number };

/** Статус правого уха по приоритету; `null` — ничего нет, ухо пустое. */
export function earStatus(model: Pick<IslandModel, 'waiting' | 'working' | 'proposals'>, doneCount: number, error: boolean): EarStatus | null {
  if (error) return { kind: 'error' };
  const waiting = model.waiting + (model.proposals ?? 0);
  if (waiting > 0) return { kind: 'waiting', count: waiting };
  if (model.working > 0) return { kind: 'working', count: model.working };
  return doneCount > 0 ? { kind: 'done', count: doneCount } : null;
}

/** Ширина уха: не уже высоты формы с запасом и вмещает статус с полями по 9 px. */
export const earWidth = (height: number, statusWidth: number): number => Math.max(height + 4, Math.ceil(statusWidth) + 18);

/**
 * Сдвиг формы от середины кадра окна к центру выреза. Кадр стоит в целых точках, а центр выреза может прийтись на
 * половину точки (на 14″ — 755,5): её держит этот сдвиг.
 */
export const notchShift = (notch: Notch): number => notch.centerX - window.innerWidth / 2;

/** Цвет точки статуса: ошибка — красная, ждёт — акцент, работает — синяя и пульсирует. */
const DOT: Record<Exclude<EarStatus['kind'], 'done'>, string> = {
  error: 'bg-[#dc604c]',
  waiting: 'bg-[var(--color-accent)]',
  working: 'island-ear-pulse bg-[#5fb4ff]',
};

function statusLabel(status: EarStatus): string {
  return status.kind === 'error' ? S.island.ears.error : S.island.ears[status.kind](status.count);
}

function EarSwarm({ assistant, reducedMotion, pulse }: { assistant: IslandAssistantProps | null; reducedMotion: boolean; pulse: SwarmPulse | null }): JSX.Element {
  const host = assistant?.view.host ?? HOST_IDLE;
  const input = assistant?.view.input ?? 'idle';
  const sentenceMood = assistant?.view.sentenceMood ?? undefined;
  const spec = useMemo(() => swarmSpecFor(host, input, true, sentenceMood), [host.phase, host.mood, input, sentenceMood]);
  return (
    <Swarm spec={spec} souls={120} width={24} height={24} d={15} cy={12} k={0.15} minPx={1.4} seed={5} fps={assistant?.busy === true ? 30 : 0} pulse={pulse} reducedMotion={reducedMotion} />
  );
}

export function NotchEars({
  notch,
  status,
  swarm,
  onEar,
}: {
  notch: Notch;
  status: EarStatus | null;
  /**
   * Рой левого уха; `null` — без роя (невидимые уши зоны нажатия только задают размер). `pulse` — реакции мини-роя:
   * события агентов и наведение есть и при выключенном помощнике (критик m-1489).
   */
  swarm: { assistant: IslandAssistantProps | null; reducedMotion: boolean; pulse: SwarmPulse | null } | null;
  /** Ширина уха после замера статуса: по ней выдвинутый вид держит ширину не меньше ушей. */
  onEar?(ear: number): void;
}): JSX.Element {
  const statusRef = useRef<HTMLSpanElement>(null);
  const [statusWidth, setStatusWidth] = useState(0);
  const statusKey = status === null ? '' : status.kind === 'error' ? 'error' : `${status.kind}:${status.count}`;
  useLayoutEffect(() => {
    setStatusWidth(statusRef.current?.offsetWidth ?? 0);
  }, [statusKey]);
  const ear = earWidth(notch.height, statusWidth);
  useLayoutEffect(() => {
    onEar?.(ear);
  }, [ear, onEar]);
  return (
    <div data-testid="island-ears" className="island-reveal flex" style={{ height: notch.height }}>
      <div
        data-testid="island-ear-left"
        className="flex items-center justify-center"
        style={{ width: ear }}
        {...(swarm === null ? {} : { role: 'img', 'aria-label': S.island.ears.swarm })}
      >
        {swarm === null ? null : <EarSwarm assistant={swarm.assistant} reducedMotion={swarm.reducedMotion} pulse={swarm.pulse} />}
      </div>
      <div data-testid="island-notch-gap" style={{ width: notch.width }} />
      <div
        data-testid="island-ear-right"
        className="flex items-center justify-center"
        style={{ width: ear }}
        {...(status === null ? {} : { role: 'img', 'aria-label': statusLabel(status) })}
      >
        {status === null ? null : (
          <span ref={statusRef} className="flex items-center whitespace-nowrap text-[13px] tabular-nums">
            {status.kind === 'done' ? null : <span data-testid="island-ear-dot" className={`mr-[5px] size-1.5 shrink-0 rounded-full ${DOT[status.kind]}`} />}
            {status.kind === 'error' ? '!' : status.kind === 'done' ? S.island.donePeek(status.count) : status.count}
          </span>
        )}
      </div>
    </div>
  );
}
