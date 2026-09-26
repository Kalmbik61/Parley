/**
 * Раскладка сетки переживает перезапуск окна (кусок 2.2 плана окна, спека
 * 5.1). Хранение — в `main/layout-store.ts`, здесь только связь с dockview:
 * загрузка при готовности `api`, восстановление через `fromJSON` с отбросом
 * панелей мёртвых сессий/работ, и сохранение с тишиной 500 мс на каждое
 * изменение раскладки.
 *
 * `WORKSPACE_LAYOUT_KEY` — не `workKey` конкретной работы, хотя план куска
 * называет раскладку «на каждую работу» (спека 5.1): в `Workspace.tsx` (кусок
 * 2.1) сетка одна общая на ВСЕ работы разом — сайдбар открывает сессию любой
 * работы в ту же сетку, а не переключает «текущую работу» отдельным видом.
 * `toJSON()`/`fromJSON()` dockview сериализуют дерево групп целиком и его не
 * разрезать на куски по работам без потери взаимного расположения панелей.
 * Хранить пришлось бы либо один и тот же снимок под каждым встреченным
 * `workKey` (бессмысленное дублирование и неясно, чей ключ грузить при
 * старте), либо развести сессии разных работ по несовместимым сеткам — это
 * уже переделка `Workspace`, а не раскладка. Поэтому ключ здесь один на всё
 * окно; формат файла `main/layout-store.ts` при этом остаётся словарём по
 * ключу — если сетка станет по-настоящему за-работной, менять формат не
 * придётся, только вызывающую сторону.
 */

import { useEffect, useRef } from 'react';
import type { WorkEntry } from '@harnas/core';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { workKey, type PanelSpec, specFromPanelId } from '../../lib/panel-id.js';

export const WORKSPACE_LAYOUT_KEY = 'window';

/** Тишина после последнего изменения раскладки, прежде чем уйдёт `app.saveLayout` (план, кусок 2.2). */
const SAVE_SILENCE_MS = 500;

/** Панель dockview в объёме, которым пользуется этот хук — не весь `IDockviewPanel`. */
export interface LayoutPanel {
  readonly id: string;
  readonly api: { getParameters(): PanelSpec };
}

/** `DockviewApi` в объёме, которым пользуется этот хук — тест не тащит настоящий dockview. */
export interface LayoutApi {
  toJSON(): unknown;
  fromJSON(data: unknown): void;
  onDidLayoutChange(callback: () => void): { dispose(): void };
  readonly panels: readonly LayoutPanel[];
  removePanel(panel: LayoutPanel): void;
}

/**
 * Годна ли панель после восстановления: у терминала и «изменений» должна быть
 * жива сама сессия, у почты и комнаты — работа (план, «Перед восстановлением
 * выбрасываются панели, чьих сессий или комнат больше нет в карте»). Комнаты
 * — данные куска 3.x, которых в `WorkMap` пока нет вовсе: выбрасывать панель,
 * которую нечем проверить, значило бы терять её всегда — то же, что и не
 * восстанавливать вовсе, поэтому пока считается годной.
 */
export function isPanelValid(works: readonly WorkEntry[], spec: PanelSpec): boolean {
  const work = works.find((entry) => workKey(entry.projectPath, entry.map.work.id) === spec.workKey);
  if (work === undefined) return false;

  switch (spec.kind) {
    case 'terminal':
    case 'changes':
      return spec.ref !== undefined && work.map.sessions.some((session) => session.id === spec.ref?.sessionId);
    case 'mail':
    case 'room':
      return true;
  }
}

export interface UseLayoutPersistenceOptions {
  /** `null`, пока `DockviewReact.onReady` ещё не позвал. */
  api: LayoutApi | null;
  bridge: HarnasBridge;
  works: readonly WorkEntry[];
  /**
   * Список работ уже пришёл от хоста. До этого восстанавливать нельзя: все
   * панели сочлись бы панелями несуществующих сессий и выбросились бы.
   */
  worksLoaded?: boolean;
}

export function useLayoutPersistence({
  api,
  bridge,
  works,
  worksLoaded = true,
}: UseLayoutPersistenceOptions): void {
  // `works` меняется на каждое событие хоста — эффект ниже заведён один раз на
  // готовый `api` и не должен пересоздавать подписку из-за этого; свежий
  // список читается через ref в момент восстановления.
  const worksRef = useRef(works);
  worksRef.current = works;

  useEffect(() => {
    if (api === null || !worksLoaded) return;
    let disposed = false;
    // Пока раскладка не восстановлена, изменения не сохраняем: иначе пустая
    // сетка первого кадра перезаписала бы файл раньше, чем его прочитали.
    let restored = false;

    bridge.app
      .loadLayout(WORKSPACE_LAYOUT_KEY)
      .then((layout) => {
        if (disposed || layout === null) return;
        api.fromJSON(layout);
        for (const panel of api.panels) {
          const spec = specFromPanelId(panel.id) ?? panel.api.getParameters();
          if (!isPanelValid(worksRef.current, spec)) api.removePanel(panel);
        }
      })
      .finally(() => {
        restored = true;
      })
      .catch(() => {
        // Раскладка просто не восстановится — план требует это только от
        // самого хранилища (битый файл → пустые раскладки), здесь достаточно
        // не уронить окно, если до IPC не достучаться.
      });

    let timer: ReturnType<typeof setTimeout> | null = null;
    const subscription = api.onDidLayoutChange(() => {
      if (!restored) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        bridge.app.saveLayout(WORKSPACE_LAYOUT_KEY, api.toJSON()).catch(() => {
          // Не сохранилось (например, раскладка больше лимита) — план требует
          // здесь только не терять старый файл на диске, а это уже сделало
          // само хранилище, отказавшись писать поверх него.
        });
      }, SAVE_SILENCE_MS);
    });

    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      subscription.dispose();
    };
  }, [api, bridge, worksLoaded]);
}
