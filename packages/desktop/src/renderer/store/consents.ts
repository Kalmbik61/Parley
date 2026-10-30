/**
 * Согласия человека в главном окне (спека 2026-10-21, 4.4): карточки «доверять ли папке агентам», которые хост держит за
 * запуски Codex (`consents.json`). Старт — `consents.list` (только ждущие), дальше `consents.changed`; в сторе остаются
 * одни ждущие карточки. Решение — `consents.decide`; хост сам продолжит или закроет удержанные запуски и разошлёт событие.
 *
 * `asking` — карточка, которую окно сейчас показывает диалогом (`components/dialogs/ConsentPrompt.tsx`): её выбирает
 * приход карточки при активном окне или кнопка «Trust folder» в Chat. «Cancel» в диалоге лишь снимает `asking`:
 * карточка остаётся, остров и Telegram показывают её дальше.
 */

import { create } from 'zustand';
import type { WindowWorkEntry } from '@parley/core';
import type { AgentSwitchCard, ConsentCard, FolderTrustCard } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { sessionRowLabel } from '../lib/participant.js';

type ConsentBridge = Pick<ParleyBridge, 'call' | 'on'>;

export interface ConsentsState {
  /** Ждущие карточки по порядку прихода. */
  cards: ConsentCard[];
  /** Карточка, которую показывает диалог окна; `null` — диалога нет. */
  asking: string | null;
  /** Подписывается на мост и один раз запрашивает `consents.list`; возвращает отписку. */
  init: (bridge: ConsentBridge) => () => void;
  /** `consents.decide`; ошибку хоста бросает вызывающему (тост — у него). */
  decide: (id: string, decision: 'allow' | 'deny') => Promise<{ applied: boolean }>;
  ask: (id: string) => void;
  stopAsking: () => void;
}

/** Мост текущего подключения: `decide` без него звать некому. */
let current: ConsentBridge | null = null;

export const useConsentsStore = create<ConsentsState>((set) => ({
  cards: [],
  asking: null,
  init: (bridge) => {
    let disposed = false;
    current = bridge;
    // Карточки старого подключения не переживают переподключение: хост мог быть другим процессом.
    set({ cards: [], asking: null });
    // Убранные событиями, пока `consents.list` ещё в пути: ответ, снятый раньше события, их не воскрешает.
    const gone = new Set<string>();
    const apply = (upsert: readonly ConsentCard[], removed: readonly string[]): void => {
      for (const id of removed) gone.add(id);
      for (const card of upsert) if (card.state !== 'pending') gone.add(card.id);
      set((state) => {
        const next = new Map(state.cards.map((card) => [card.id, card]));
        for (const id of gone) next.delete(id);
        for (const card of upsert) if (card.state === 'pending') next.set(card.id, card);
        return { cards: [...next.values()] };
      });
    };

    bridge.call('consents.list', {}).then(
      (result) => {
        if (disposed) return;
        // Событие свежее снимка: карточка, что уже пришла событием, остаётся его версией.
        set((state) => {
          const known = new Set(state.cards.map((card) => card.id));
          const fresh = result.items.filter((card) => card.state === 'pending' && !gone.has(card.id) && !known.has(card.id));
          return { cards: [...fresh, ...state.cards] };
        });
      },
      () => {
        // Хост прежней сборки без `consents.*`: карточек у него нет.
      },
    );

    const unsubscribe = bridge.on('consents.changed', (event) => apply(event.upsert, event.removed));
    return () => {
      disposed = true;
      if (current === bridge) current = null;
      unsubscribe();
    };
  },
  decide: async (id, decision) => {
    if (current === null) throw new Error('consents: not connected');
    const { applied } = await current.call('consents.decide', { id, decision });
    return { applied };
  },
  ask: (id) => set({ asking: id }),
  stopAsking: () => set({ asking: null }),
}));

/**
 * Карточка, которой ждёт сессия (строка «Waiting for folder trust» в Chat): у сессии Codex без процесса (`pending` —
 * ещё не стартовала, `sleeping` — спит) — ждущая карточка её проекта. Карточка одна на папку, а поле `requestedBy.sessionId`
 * называет не удержанную сессию, а просившую, поэтому связь идёт по проекту: Allow продолжает все удержанные запуски папки.
 */
export function trustCardFor(
  cards: readonly ConsentCard[],
  projectPath: string,
  lifecycle: string | undefined,
  provider: string,
): FolderTrustCard | undefined {
  if (provider !== 'codex' || (lifecycle !== 'pending' && lifecycle !== 'sleeping')) return undefined;
  return cards.find((card): card is FolderTrustCard => card.kind === 'folder-trust' && card.projectPath === projectPath);
}

/**
 * Кто просил, для диалога: «S03 Ruslan · create_session». Просившая сессия берётся из карты работы карточки, нет её
 * (человек, автозапуск, сессия уже ушла) — ярлык карточки, нет и его — один источник.
 */
export function consentRequester(card: FolderTrustCard, entries: readonly WindowWorkEntry[]): string {
  const { requestedBy } = card;
  const via = S.dialogs.trustFolder.via[requestedBy.source];
  const session =
    requestedBy.sessionId === undefined
      ? undefined
      : entries
          .find((entry) => entry.projectPath === card.projectPath && entry.map.work.id === requestedBy.workId)
          ?.map.sessions.find((item) => item.id === requestedBy.sessionId);
  const who = session === undefined ? requestedBy.label : sessionRowLabel(session.id, session.label);
  return who === undefined || who === '' ? via : `${who} · ${via}`;
}

/** `s-03` → `@s03`: упоминание сессии, как в письмах агентов. */
const mention = (sessionId: string): string => `@${sessionId.replace('-', '')}`;

/** Просьба агента одной строкой: «@s11 asks to continue @s03 on Codex (gpt-6-astra): the Claude limit is near». */
export function switchRequestText(card: AgentSwitchCard): string {
  const model = card.model === null ? '' : ` (${card.model})`;
  return S.dialogs.agentSwitch.asks(mention(card.requestedBy.sessionId), mention(card.ref.sessionId), `${card.providerLabel}${model}`, card.reason);
}
