/**
 * Сочетания окна из страницы встроенного браузера (кусок 6.1a, спека 9.6): нажатия внутри
 * `<webview>` до DOM окна не доходят, поэтому main слушает `before-input-event` гостя — так
 * делает Orca (`src/shared/window-shortcut-policy.ts`). Подключится к `<webview>` в 9.1.
 */
import type { Event, Input, WebContents } from 'electron';
import { ACTIONS, matchesAccelerator } from '../shared/keybindings.js';
import type { ActionDef, ActionId, KeyLike } from '../shared/keybindings.js';

/**
 * ⌘⇧↑↓ таблица 9.6 отдаёт полю ввода, а main не знает, в поле ли фокус страницы: остаются
 * ей. ⌃Tab/⌃⇧Tab — тоже (решение сверки 9): цикл MRU кончается отпусканием ⌃, а keyUp из
 * гостя окну не пересылается — цикл остался бы открытым. Роли «Правки» (⌘C…) в реестре не
 * живут и так не трогаются.
 */
const KEPT_BY_PAGE = new Set<ActionId>(['work.prev', 'work.next', 'tab.mruNext', 'tab.mruPrev']);

const FORWARDED: readonly ActionDef[] = ACTIONS.filter(
  (action) =>
    action.keys !== null && (action.when === 'always' || action.when === 'browser') && !KEPT_BY_PAGE.has(action.id),
);

/**
 * before-input-event гостя: Input Electron → KeyLike, только keyDown. Сочетания с when 'always' и
 * 'browser' гасятся в госте и уходят окну; ⌘⇧↑↓ остаются странице.
 */
export function forwardGuestShortcuts(
  contents: Pick<WebContents, 'on' | 'off'>,
  send: (id: ActionId) => void,
): () => void {
  const listener = (event: Event, input: Input): void => {
    if (input.type !== 'keyDown' || input.isComposing) return;
    const key: KeyLike = {
      key: input.key,
      code: input.code,
      metaKey: input.meta,
      ctrlKey: input.control,
      altKey: input.alt,
      shiftKey: input.shift,
      isComposing: input.isComposing,
    };
    const action = FORWARDED.find((candidate) => matchesAccelerator(candidate.keys as string, key));
    if (action === undefined) return;
    event.preventDefault();
    // Автоповтор гасится и у неповторяемых — иначе страница получила бы удержанный ⌘N.
    if (input.isAutoRepeat && action.repeatable !== true) return;
    send(action.id);
  };
  contents.on('before-input-event', listener);
  return () => {
    contents.off('before-input-event', listener);
  };
}
