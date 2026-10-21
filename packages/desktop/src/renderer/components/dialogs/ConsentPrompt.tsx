/**
 * Диалог доверия по карточке согласия хоста (спека 2026-10-21, 4.2 п. 3): запуск Codex удержан, потому что папка проекта
 * не доверена, и если главное окно открыто и впереди, оно спрашивает тем же `TrustFolderDialog`, что и композер. Карточка
 * на острове и в Telegram появляется всё равно; ответ в любом месте закрывает остальные (хост шлёт `consents.changed`).
 *
 *  — «Trust» — `consents.decide(allow)`: хост запишет доверие и продолжит удержанные запуски;
 *  — «Cancel» — диалог закрывается, карточка остаётся (остров, Telegram, кнопка «Trust folder» в Chat).
 *
 * Диалог показывается, когда карточка появилась, а окно активно (`isWindowActive`): карточка, пришедшая в свёрнутое окно,
 * его не будит — о ней скажут остров и Telegram. Каждая карточка предлагается один раз; несколько — по очереди.
 */

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { isWindowActive } from '../../attention/notify.js';
import { consentRequester, useConsentsStore } from '../../store/consents.js';
import { useWorksStore } from '../../store/works.js';
import { TrustFolderDialog } from './TrustFolderDialog.js';

export function ConsentPrompt(): JSX.Element | null {
  const cards = useConsentsStore((state) => state.cards);
  const asking = useConsentsStore((state) => state.asking);
  const entries = useWorksStore((state) => state.entries);
  /** Карточки, что уже предлагались (или пришли в неактивное окно): отклонённая сама не всплывает. */
  const offered = useRef(new Set<string>());

  useEffect(() => {
    const { ask, stopAsking } = useConsentsStore.getState();
    // Карточку решили в другом месте (остров, Telegram) — диалог по ней закрывается.
    if (asking !== null && !cards.some((card) => card.id === asking)) {
      stopAsking();
      return;
    }
    // Диалог занят: следующая карточка ждёт ответа на нынешнюю.
    if (asking !== null) return;
    const fresh = cards.filter((card) => !offered.current.has(card.id));
    const [first] = fresh;
    if (first === undefined) return;
    if (!isWindowActive()) {
      for (const card of fresh) offered.current.add(card.id);
      return;
    }
    offered.current.add(first.id);
    ask(first.id);
  }, [cards, asking]);

  const card = asking === null ? undefined : cards.find((item) => item.id === asking);
  if (card === undefined) return null;

  const trust = (): void => {
    useConsentsStore.getState().stopAsking();
    useConsentsStore
      .getState()
      .decide(card.id, 'allow')
      .catch((err: unknown) => {
        const info = decodeIpcError(err);
        console.warn('[parley] consents.decide', info.message);
        toast.error(errorText(info.code, S.errors.actions.grantTrust));
      });
  };

  return (
    <TrustFolderDialog
      open
      folder={card.folder}
      requestedBy={consentRequester(card, entries)}
      onTrust={trust}
      onCancel={() => useConsentsStore.getState().stopAsking()}
    />
  );
}
