/**
 * Цель «To» и «Add to chat» вкладки браузера (спека браузера 4.5): цель из раскладки или умолчание, откат с тостом,
 * когда цель пропала, и одна очередь добавлений на вкладку — чипы встают в порядке кликов, даже если запись второго
 * файла кончилась раньше первого.
 */

import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { WorkEntry } from '@parley/core';
import type { ParleyBridge } from '../../../shared/bridge.js';
import type { BrowserTarget } from '../../../shared/layout-types.js';
import { S } from '../../../shared/strings.js';
import { focusedSessionOf, useLayoutStore } from '../../layout/store.js';
import { updateTab } from '../../layout/tree.js';
import type { SendWithToastDeps } from '../../terminal/send.js';
import { addContext, type ContextDraft, type Delivered } from './deliver.js';
import { resolveTarget, targetName } from './targets.js';

export interface PageContext {
  target: BrowserTarget | null;
  setTarget(target: BrowserTarget): void;
  add(draft: ContextDraft): Promise<Delivered>;
}

export interface PageContextInput {
  bridge: ParleyBridge;
  workKey: string;
  tabId: string;
  entry: WorkEntry;
  /** `TabSpec.target` вкладки: нет поля — умолчание. */
  stored: BrowserTarget | undefined;
  sendDeps: SendWithToastDeps;
}

export function usePageContext(input: PageContextInput): PageContext {
  const { workKey, tabId, entry, stored } = input;
  const focused = useLayoutStore((state) => focusedSessionOf(state, workKey));
  const resolved = resolveTarget(entry, stored, focused);
  const latest = useRef({ input, target: resolved.target });
  latest.current = { input, target: resolved.target };

  // Цель пропала (сессию закрыли или удалили, комнату удалили или архивировали): поле снимается, тост — один раз.
  const fallback = resolved.target === null ? null : targetName(entry, resolved.target);
  useEffect(() => {
    if (!resolved.fellBack) return;
    useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId, { target: null }));
    toast(fallback === null ? S.browser.target.fellBackNowhere : S.browser.target.fellBack(fallback));
  }, [resolved.fellBack, fallback, workKey, tabId]);

  const setTarget = useCallback(
    (target: BrowserTarget): void => {
      useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId, { target }));
    },
    [workKey, tabId],
  );

  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const add = useCallback((draft: ContextDraft): Promise<Delivered> => {
    const run = async (): Promise<Delivered> => {
      const { input: now, target } = latest.current;
      if (target === null) {
        toast(S.browser.target.nowhere);
        return 'failed';
      }
      return addContext(draft, { bridge: now.bridge, entry: now.entry, target, sendDeps: now.sendDeps });
    };
    const next = queue.current.then(run, run);
    queue.current = next;
    return next;
  }, []);

  return { target: resolved.target, setTarget, add };
}
