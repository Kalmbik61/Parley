/**
 * Тулбар вкладки сессии (план 2026-10-01, Task 3, п. 4): сегмент «Chat | Terminal». Есть в обоих
 * видах — в терминале он над поверхностью (`TerminalSurface` с отступом `TAB_TOOLBAR_PX`), иначе
 * вернуться в чат можно было бы только палитрой. Выбор пишется полем `view` вкладки в раскладку и
 * переживает перезапуск. Вид «Chat» сессии недоступен (Codex, старый `claude`) — сегмент выключен с
 * подсказкой. В виде «Chat» справа — меню режима разрешений (кусок 4a, решение 9: подпись текущего
 * режима из ленты, пункты Manual / Accept edits / Plan; выбор уходит `sessions.setMode` из `ChatView`),
 * модель сессии (из ленты; с меню выбора, если у провайдера есть список моделей — живая проверка 2026-10-02; «Stop» ушёл в поле ввода). Высота фиксирована и строки не переносятся: от неё зависит отступ
 * поверхности терминала.
 */

import { ChevronDown } from 'lucide-react';

import type { ModelOption } from '@parley/protocol';
import type { TerminalView } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { useLayoutStore } from '../layout/store.js';
import { updateTab } from '../layout/tree.js';
import { Button } from '../ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.js';

/** Высота тулбара: на столько поверхность терминала опускается под ним. */
export const TAB_TOOLBAR_PX = 36;

/** Режимы меню: значения `sessions.setMode` и подписи; auto и обход разрешений человек выбирает в терминале. */
const MODE_ITEMS = [
  { value: 'default', label: S.chat.mode.manual },
  { value: 'acceptEdits', label: S.chat.mode.acceptEdits },
  { value: 'plan', label: S.chat.mode.plan },
] as const;

export type ModeChoice = (typeof MODE_ITEMS)[number]['value'];

/** Подпись режима на триггере: известные — по-человечески, прочие — сырой строкой CLI, неизвестный — «Mode». */
export function modeLabel(mode: string | null): string {
  if (mode === null) return S.chat.mode.unknown;
  return MODE_ITEMS.find((item) => item.value === mode)?.label ?? mode;
}

export interface ModeMenuProps {
  /** Текущий режим ленты (сырая строка CLI); `null` — неизвестен. */
  mode: string | null;
  /** Запрос смены в пути или сессия не живая — меню выключено. */
  busy: boolean;
  onSelect: (mode: ModeChoice) => void;
}

export interface ModelMenuProps {
  options: readonly ModelOption[];
  /** Отправка в пути или сессия не живая — меню выключено. */
  busy: boolean;
  onSelect: (id: string) => void;
}

export interface ChatToolbarProps {
  workKey: string;
  tabId: string;
  /** Вид, который вкладка показывает сейчас (`effectiveView`). */
  view: TerminalView;
  /** Вид «Chat» доступен сессии; нет — сегмент выключен. */
  available: boolean;
  /** Меню режима; нет — не показывается (вид терминала или хост без `sessions.setMode`). */
  modeMenu?: ModeMenuProps;
  /** Модель сессии; `null` или нет — не показывается. */
  model?: string | null;
  /** Меню моделей; нет — подпись модели просто текстом. */
  modelMenu?: ModelMenuProps;
}

const ITEM = 'h-6 whitespace-nowrap px-2.5 text-xs';

export function ChatToolbar({ workKey, tabId, view, available, model = null, modeMenu, modelMenu }: ChatToolbarProps): JSX.Element {
  const choose = (value: string): void => {
    // Повторный клик по выбранному снял бы выбор: пустое значение пропускаем.
    if (value !== 'chat' && value !== 'terminal') return;
    useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId, { view: value }));
  };
  return (
    <div
      data-testid="chat-toolbar"
      className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-2"
      style={{ height: TAB_TOOLBAR_PX }}
    >
      {/* `title` — на обёртке: у выключенных кнопок нет событий указателя, подсказка не всплыла бы. */}
      <span title={available ? undefined : S.chat.terminalOnly} className="inline-flex">
        <ToggleGroup
          type="single"
          size="sm"
          aria-label={S.chat.viewLabel}
          value={view}
          disabled={!available}
          onValueChange={choose}
        >
          <ToggleGroupItem value="chat" className={ITEM}>
            {S.chat.segment.chat}
          </ToggleGroupItem>
          <ToggleGroupItem value="terminal" className={ITEM}>
            {S.chat.segment.terminal}
          </ToggleGroupItem>
        </ToggleGroup>
      </span>
      <span className="min-w-0 flex-1" />
      {modeMenu === undefined ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={modeMenu.busy}>
            <Button
              type="button"
              size="xs"
              variant="outline"
              data-testid="chat-mode"
              aria-label={S.chat.mode.label}
              title={S.chat.mode.label}
              className="shrink-0"
            >
              {modeLabel(modeMenu.mode)}
              <ChevronDown className="size-3" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={modeMenu.mode ?? ''}
              onValueChange={(value) => {
                const item = MODE_ITEMS.find((candidate) => candidate.value === value);
                if (item !== undefined) modeMenu.onSelect(item.value);
              }}
            >
              {MODE_ITEMS.map((item) => (
                <DropdownMenuRadioItem key={item.value} value={item.value} data-testid="chat-mode-option" data-mode={item.value}>
                  {item.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {modelMenu === undefined ? (
        model === null ? null : (
          <span data-testid="chat-model" title={S.chat.model} className="min-w-0 max-w-[40%] truncate text-xs text-muted-foreground">
            {model}
          </span>
        )
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={modelMenu.busy}>
            <Button
              type="button"
              size="xs"
              variant="outline"
              data-testid="chat-model"
              aria-label={S.chat.modelMenu.label}
              title={S.chat.modelMenu.label}
              className="min-w-0 max-w-[40%] shrink"
            >
              <span className="truncate">{model ?? S.chat.model}</span>
              <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={model ?? ''} onValueChange={(value) => modelMenu.onSelect(value)}>
              {modelMenu.options.map((option) => (
                <DropdownMenuRadioItem key={option.id} value={option.id} data-testid="chat-model-option" data-model={option.id}>
                  {option.label === '' ? option.id : option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
