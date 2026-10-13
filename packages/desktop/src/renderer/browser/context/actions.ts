// packages/desktop/src/renderer/browser/context/actions.ts
/**
 * «Add to chat» из панели Console | Network и Select (спека браузера 4.3, 4.4, 4.6): запись консоли, запрос с телом,
 * все видимые ошибки разом и выбранный элемент — файлом-контекстом в цель «To» (`usePageContext().add`). Тело ответа
 * читается в момент клика (`responseBody`): Chromium мог его уже вытеснить — тогда в файле пометка.
 */

import type { ParleyBridge } from '../../../shared/bridge.js';
import { isFailed, type ConsoleEntry, type NetworkEntry } from '../../../shared/browser-devtools.js';
import {
  consoleContext,
  elementContext,
  errorsContext,
  requestContext,
  type BuiltContext,
  type ElementContextInput,
} from '../../../shared/context-markdown.js';
import type { TabDevtools } from '../devtools/store.js';
import type { ContextDraft, Delivered } from './deliver.js';

export interface PageContextActions {
  console(entry: ConsoleEntry): void;
  request(entry: NetworkEntry): void;
  /** «Add errors to chat» панели: `pageErrors` журнала вкладки одним файлом. */
  errors(): void;
}

export interface PageContextDeps {
  bridge: ParleyBridge;
  /** Гость вкладки сейчас; `null` — страницы нет. */
  webContentsId(): number | null;
  /** Адрес страницы сейчас (`TabSpec.url`). */
  pageUrl(): string;
  /** Журнал вкладки в окне сейчас (`useDevtoolsStore`). */
  devtools(): TabDevtools;
  add(draft: ContextDraft): Promise<Delivered>;
}

/**
 * Ошибки для «Add errors to chat» (спека 4.3): как у красного счётчика (`devtoolsCounters`), но по видимым эпохам —
 * текущей, а с «Preserve log» и прежним. Строки сети («Failed to load resource», CORS) не берутся: их запрос и так
 * в файле. Фильтры уровня и текста не действуют: кнопка обещает все ошибки.
 */
export function pageErrors(tab: TabDevtools): { console: ConsoleEntry[]; requests: NetworkEntry[] } {
  const visible = (epoch: number): boolean => tab.preserve || epoch === tab.epoch;
  return {
    console: tab.console.filter((entry) => visible(entry.epoch) && entry.level === 'error' && entry.origin !== 'network'),
    requests: tab.network.filter((entry) => visible(entry.epoch) && isFailed(entry)),
  };
}

function draft(built: BuiltContext, imagePath: string | null = null): ContextDraft {
  return { ...built, imagePath, count: 1 };
}

export function elementDraft(pick: ElementContextInput, viewportNote: string | null): ContextDraft {
  return draft(elementContext({ pick, viewportNote }), pick.imagePath);
}

export function createPageContextActions(deps: PageContextDeps): PageContextActions {
  return {
    console: (entry) => {
      void deps.add(draft(consoleContext({ pageUrl: deps.pageUrl(), entry })));
    },
    request: (entry) => {
      void (async () => {
        const id = deps.webContentsId();
        // Ответа нет (CORS, сеть, отмена) — и тела нет: не спрашиваем.
        const body = id === null || entry.status === null ? null : await deps.bridge.browser.responseBody(id, entry.id).catch(() => null);
        await deps.add(draft(requestContext({ pageUrl: deps.pageUrl(), entry, responseBody: body })));
      })();
    },
    errors: () => {
      const errors = pageErrors(deps.devtools());
      if (errors.console.length === 0 && errors.requests.length === 0) return;
      void deps.add(draft(errorsContext({ pageUrl: deps.pageUrl(), ...errors })));
    },
  };
}
