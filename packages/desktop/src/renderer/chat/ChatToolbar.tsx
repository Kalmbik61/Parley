/**
 * Тулбар вкладки сессии (план 2026-10-01, Task 3, п. 4): сегмент «Chat | Terminal». Есть в обоих
 * видах — в терминале он над поверхностью (`TerminalSurface` с отступом `TAB_TOOLBAR_PX`), иначе
 * вернуться в чат можно было бы только палитрой. Выбор пишется полем `view` вкладки в раскладку и
 * переживает перезапуск. Вид «Chat» сессии недоступен (Codex, старый `claude`) — сегмент выключен с
 * подсказкой. В виде «Chat» справа — меню режима разрешений (кусок 4a, решение 9: подпись текущего
 * режима из ленты, пункты Manual / Accept edits / Plan; выбор уходит `sessions.setMode` из `ChatView`)
 * и кнопка «модель · effort» (нормалайзер модели и effort 2026-10-06, 5.9): меню из двух разделов — модели провайдера
 * и уровни модели из карты, выбор уходит `sessions.setModel` / `sessions.setEffort` из `ChatView`; у хоста без этих
 * методов — подпись модели простым текстом («Stop» ушёл в поле ввода).
 * Левее них, пока в ленте есть работающие карточки агентов, — «N agents running» (кусок 4b): клик ведёт ленту к первой из
 * них. Высота фиксирована и строки не переносятся: от неё зависит отступ поверхности терминала.
 */

import { ChevronDown, LoaderCircle } from 'lucide-react';

import type { EffortOption, ModelOption } from '@parley/protocol';
import type { TerminalView } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { useLayoutStore } from '../layout/store.js';
import { updateTab } from '../layout/tree.js';
import { Button } from '../ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.js';
import { MicButton } from '../voice/MicButton.js';

/** Высота тулбара: на столько поверхность терминала опускается под ним. */
export const TAB_TOOLBAR_PX = 36;

/**
 * Режимы меню: значения `sessions.setMode` и подписи. Auto — когда модель его даёт (у модели без auto
 * хост обойдёт круг и ответит `verified: false`); обход разрешений человек выбирает в терминале.
 */
const MODE_ITEMS = [
  { value: 'default', label: S.chat.mode.manual },
  { value: 'acceptEdits', label: S.chat.mode.acceptEdits },
  { value: 'plan', label: S.chat.mode.plan },
  { value: 'auto', label: S.chat.mode.auto },
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

/**
 * Меню «модель · effort» (нормалайзер модели и effort 2026-10-06, 5.9). Пункта «Default» в разделе уровней нет:
 * `/effort auto` в идущей сессии стёр бы уровень, сохранённый человеком (спека 5.7, п. 5).
 */
export interface ChoiceMenuProps {
  /** Модели провайдера; пусто — раздела моделей нет. */
  models: readonly ModelOption[];
  /** Модель из карты (`WorkSession.model`) — отмеченный пункт; `null` — «Default», ничего не отмечено. */
  model: string | null;
  /** Подпись модели на кнопке: из ленты, иначе из карты, иначе «Default». */
  modelLabel: string;
  /** Уровни модели из карты (`effortChoices`); `null` — раздела уровней нет. */
  efforts: readonly EffortOption[] | null;
  /** Уровень из карты (`WorkSession.effort`); `null` — «Default». */
  effort: string | null;
  /** Почему пункты моделей неактивны; `null` — активны. */
  modelDisabled: string | null;
  /** Почему пункты уровней неактивны; `null` — активны. */
  effortDisabled: string | null;
  /** Запрос смены в пути — кнопка выключена. */
  busy: boolean;
  onSelectModel: (id: string) => void;
  onSelectEffort: (id: string) => void;
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
  /** Подпись модели без меню (хост без `sessions.setModel`/`setEffort`); `null` или нет — не показывается. */
  model?: string | null;
  /** Меню «модель · effort»; есть — вместо подписи модели. */
  choiceMenu?: ChoiceMenuProps;
  /** Сколько карточек агентов ещё работает; нет — кнопки «N agents running» нет. Клик ведёт ленту к первой из них. */
  agents?: { running: number; onShow: () => void };
  /** Цель диктовки вида Terminal (`terminal:<refKey>`, спека 3.2); нет — кнопки нет. */
  micTargetId?: string;
}

const ITEM = 'h-6 whitespace-nowrap px-2.5 text-xs';
/** Причина неактивных пунктов раздела — строкой под его заголовком. */
const REASON = 'px-2 pb-1 text-xs text-muted-foreground';

/** Уровень на кнопке: подпись из списка, незнакомый id — как есть, выбора нет — «Default»; уровней у модели нет — ничего. */
function effortText(menu: ChoiceMenuProps): string | null {
  if (menu.effort === null) return menu.efforts === null ? null : S.chat.choice.default;
  return menu.efforts?.find((level) => level.id === menu.effort)?.label ?? menu.effort;
}

function ChoiceMenu({ menu }: { menu: ChoiceMenuProps }): JSX.Element {
  const effort = effortText(menu);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={menu.busy}>
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid="chat-model"
          aria-label={S.chat.choice.label}
          title={effort === null ? menu.modelLabel : `${menu.modelLabel} · ${effort}`}
          className="min-w-0 max-w-[40%] shrink"
        >
          {/* Длинная модель обрезается многоточием, уровень виден всегда: он короткий, и его меняют чаще. */}
          <span data-testid="chat-model-label" className="min-w-0 truncate">
            {menu.modelLabel}
          </span>
          {effort === null ? null : (
            <span data-testid="chat-effort-label" className="shrink-0">
              · {effort}
            </span>
          )}
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {menu.models.length === 0 ? null : (
          <>
            <DropdownMenuLabel>{S.chat.choice.model}</DropdownMenuLabel>
            {menu.modelDisabled === null ? null : (
              <p data-testid="chat-model-reason" className={REASON}>
                {menu.modelDisabled}
              </p>
            )}
            <DropdownMenuRadioGroup value={menu.model ?? ''} onValueChange={menu.onSelectModel}>
              {menu.models.map((option) => (
                <DropdownMenuRadioItem
                  key={option.id}
                  value={option.id}
                  disabled={menu.modelDisabled !== null}
                  data-testid="chat-model-option"
                  data-model={option.id}
                >
                  {option.label === '' ? option.id : option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
        {menu.efforts === null ? null : (
          <>
            {menu.models.length === 0 ? null : <DropdownMenuSeparator />}
            <DropdownMenuLabel>{S.chat.choice.effort}</DropdownMenuLabel>
            {menu.effortDisabled === null ? null : (
              <p data-testid="chat-effort-reason" className={REASON}>
                {menu.effortDisabled}
              </p>
            )}
            <DropdownMenuRadioGroup value={menu.effort ?? ''} onValueChange={menu.onSelectEffort}>
              {menu.efforts.map((level) => (
                <DropdownMenuRadioItem
                  key={level.id}
                  value={level.id}
                  disabled={menu.effortDisabled !== null}
                  data-testid="chat-effort-option"
                  data-effort={level.id}
                >
                  {level.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ChatToolbar({ workKey, tabId, view, available, model = null, modeMenu, choiceMenu, agents, micTargetId }: ChatToolbarProps): JSX.Element {
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
      {agents === undefined ? null : (
        <Button type="button" size="xs" variant="outline" data-testid="chat-agents-running" onClick={agents.onShow} className="shrink-0">
          <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {S.chat.agent.running(agents.running)}
        </Button>
      )}
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
      {choiceMenu === undefined ? (
        model === null ? null : (
          <span data-testid="chat-model" title={S.chat.model} className="min-w-0 max-w-[40%] truncate text-xs text-muted-foreground">
            {model}
          </span>
        )
      ) : (
        <ChoiceMenu menu={choiceMenu} />
      )}
      {micTargetId === undefined ? null : (
        <span className="ml-auto">
          <MicButton targetId={micTargetId} size="sm" />
        </span>
      )}
    </div>
  );
}
