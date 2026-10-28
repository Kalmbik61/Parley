/**
 * Капсула острова в вырезе (B26 F-B26-3, решение человека m-1518; заменяет голый вырез F-B26-1 в фоне): одна сплошная
 * форма высотой выреза и шириной `capsuleWidth` — вырез и по 80 pt с каждой стороны, без швов и отдельных ушей.
 * Содержимое — слева и справа от камеры.
 *
 * Капсула стоит, пока есть что показать: агенты работают, непросмотренный Done, помощник свёрнут или говорит, ошибка
 * помощника. Иначе форма — ровно вырез. Слева — лицо помощника, пока он говорит (рот идёт по голосу), его мини-сфера,
 * пока он свёрнут или в ошибке, иначе мини-рой работающих агентов. Справа — `✓ N Done`, пока Done не просмотрен,
 * иначе точка и число работающих. Клик открывает остров (`onOpen`); наведение — нет. Рой — по правилам малого роя:
 * реакция только вспышкой, 30 к/с — пока помощник занят, иначе 0; при уменьшенном движении стоит.
 */

import { useMemo } from 'react';
import { S } from '../../shared/strings.js';
import { HOST_IDLE } from './assistant/store.js';
import type { IslandAssistantProps } from './IslandView.js';
import type { IslandModel } from './model.js';
import { CAPSULE_SIDE, type Notch } from './notch.js';
import { SwarmIcon } from '../components/SwarmIcon.js';
import { Swarm } from './swarm/Swarm.js';
import { swarmSpecFor, type SwarmPulse } from './swarm/spec.js';

/** Что в капсуле: слева помощник или агенты (`null` — пусто), справа один статус (`null` — пусто). */
export interface CapsuleContent {
  left: 'assistant' | 'agents' | null;
  right: { kind: 'done' | 'working'; count: number } | { kind: 'swarm'; handed: number; total: number } | null;
}

type CapsuleAssistant = Pick<IslandAssistantProps, 'open' | 'collapsed'> & { view: Pick<IslandAssistantProps['view'], 'host' | 'input'> };

/** Содержимое капсулы; `null` — показывать нечего, форма — ровно вырез. */
export function capsuleContent(model: Pick<IslandModel, 'active' | 'working' | 'swarm'>, doneCount: number, assistant: CapsuleAssistant | null): CapsuleContent | null {
  const input = assistant?.view.input;
  const shown = assistant !== null &&
    ((assistant.open && assistant.collapsed) || input === 'speaking' || input === 'settling' || assistant.view.host.phase === 'error');
  // `🐝 3/5` приоритетнее «точка и число работающих», но ниже `✓ N Done` (спека роя, 7.4).
  const right = doneCount > 0
    ? { kind: 'done' as const, count: doneCount }
    : model.swarm !== undefined
      ? { kind: 'swarm' as const, handed: model.swarm.handed, total: model.swarm.total }
      : model.working > 0 ? { kind: 'working' as const, count: model.working } : null;
  const left = shown ? 'assistant' : model.active ? 'agents' : null;
  return left === null && right === null ? null : { left, right };
}

/**
 * Рой капсулы и лицо говорящего помощника: его же берёт кнопка пилюли полосы, пока помощник говорит (`MiniSwarm`).
 * Размер — 28 px, но не выше `height - 4`.
 */
export function CapsuleSwarm({ assistant, face, pulse, reducedMotion, height }: {
  assistant: IslandAssistantProps | null;
  face: boolean;
  pulse: SwarmPulse | null;
  reducedMotion: boolean;
  height: number;
}): JSX.Element {
  const host = assistant?.view.host ?? HOST_IDLE;
  const input = assistant?.view.input ?? 'idle';
  const sentenceMood = assistant?.view.sentenceMood ?? undefined;
  // Лицо — облик большого вида (`mini` ложно): у мини-облика речь — сфера без рта.
  const spec = useMemo(() => swarmSpecFor(host, input, !face, sentenceMood), [host.phase, host.mood, input, sentenceMood, face]);
  const size = Math.min(28, height - 4);
  return (
    <Swarm
      spec={spec}
      souls={face ? 220 : 150}
      width={size}
      height={size}
      d={Math.round(size * 0.62)}
      cy={size / 2}
      k={0.15}
      minPx={1.4}
      seed={5}
      fps={assistant?.busy === true ? 30 : 0}
      {...(face && assistant?.view.voice !== undefined ? { voice: assistant.view.voice } : {})}
      pulse={pulse}
      reducedMotion={reducedMotion}
    />
  );
}

export function NotchCapsule({ notch, content, assistant, pulse, reducedMotion, onOpen }: {
  notch: Notch;
  content: CapsuleContent;
  assistant: IslandAssistantProps | null;
  /** Реакции мини-роя: события агентов есть и при выключенном помощнике. */
  pulse: SwarmPulse | null;
  reducedMotion: boolean;
  onOpen(): void;
}): JSX.Element {
  const { left, right } = content;
  const face = left === 'assistant' && assistant?.view.input === 'speaking';
  return (
    // Не кнопка: за капсулу остров тащится и смахивается, как за пилюлю; нажатие без сдвига — клик.
    <div data-testid="island-capsule" className="island-reveal flex cursor-pointer" style={{ height: notch.height }} onClick={onOpen}>
      <div
        data-testid="island-capsule-left"
        className="flex items-center justify-center"
        style={{ width: CAPSULE_SIDE }}
        {...(left === null ? {} : { role: 'img', 'aria-label': left === 'assistant' ? S.island.capsule.assistant : S.island.capsule.agents })}
      >
        {left === null ? null : <CapsuleSwarm assistant={assistant} face={face} pulse={pulse} reducedMotion={reducedMotion} height={notch.height} />}
      </div>
      <div style={{ width: notch.width }} />
      <div data-testid="island-capsule-right" className="flex items-center justify-center whitespace-nowrap text-[13px] tabular-nums" style={{ width: CAPSULE_SIDE }}>
        {right === null ? null : right.kind === 'done' ? (
          <span>{S.island.capsule.done(right.count)}</span>
        ) : right.kind === 'swarm' ? (
          <span data-testid="island-capsule-swarm" className="flex items-center gap-1" role="img" aria-label={S.workSwarm.island.capsule(right.handed, right.total)}>
            <SwarmIcon status="running" size={14} handed={right.handed} reducedMotion={reducedMotion} />
            {S.workSwarm.counter(right.handed, right.total)}
          </span>
        ) : (
          <span className="flex items-center" role="img" aria-label={S.island.capsule.working(right.count)}>
            <span className="mr-[5px] size-1.5 shrink-0 rounded-full bg-[#5fb4ff]" />
            {right.count}
          </span>
        )}
      </div>
    </div>
  );
}
