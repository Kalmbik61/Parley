/**
 * Проверка на типах (ничего не выполняется): общие объединения `@parley/core/swarm` совпадают с типами острова и
 * протокола. Разошлись члены — `pnpm typecheck` падает здесь.
 */

import type { AssistantState } from '@parley/protocol';
import type { SwarmEmotion, SwarmHost, SwarmInput, SwarmLivePhase } from '@parley/core/swarm';
import type { InputPhase } from '../assistant/store.js';
import type { LiveCallPhase } from '../live/controller.js';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Каждый элемент обязан быть `true`: `false` не присваивается кортежу ниже. */
export const swarmTypesMatch: [
  Same<SwarmInput, InputPhase>,
  Same<SwarmLivePhase, LiveCallPhase>,
  Same<SwarmEmotion, AssistantState['mood']>,
  Same<SwarmHost['phase'], AssistantState['phase']>,
] = [true, true, true, true];
