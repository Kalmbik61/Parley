/**
 * Кнопка «Browser» у вида хозяина (спека браузера 4.11): показывает и прячет панель браузера справа от вида. Нажата — панель
 * открыта. Первое нажатие создаёт панель с пустой страницей (`actions.ts#togglePanel`). Значок без подписи: шапка вида
 * сессии и без неё тесна на окне 800×500, имя — в `aria-label` и подсказке.
 */

import { Globe } from 'lucide-react';
import type { BrowserOwner } from '../../../shared/layout-types.js';
import { S } from '../../../shared/strings.js';
import { ownerKey } from '../../layout/ids.js';
import { useLayoutStore } from '../../layout/store.js';
import { Toggle } from '../../ui/toggle.js';
import { togglePanel } from './actions.js';

export interface PanelToggleProps {
  workKey: string;
  owner: BrowserOwner;
}

export function PanelToggle({ workKey, owner }: PanelToggleProps): JSX.Element {
  const open = useLayoutStore((state) => state.layouts[workKey]?.panels?.[ownerKey(owner)]?.open === true);
  return (
    <Toggle
      size="xs"
      variant="outline"
      pressed={open}
      onPressedChange={() => togglePanel(workKey, owner)}
      aria-label={S.browser.panel.toggle}
      title={S.browser.panel.toggleTitle}
      data-testid="browser-panel-toggle"
      className="shrink-0"
    >
      <Globe className="size-3.5" aria-hidden="true" />
    </Toggle>
  );
}
