/**
 * Тесты 1, 4 и 7 куска 1.2 плана: `cn`, поведение диалога/выпадающего
 * меню/палитры команд (клавиатура и фокус — то, что не видно из кода) и тема
 * тостов sonner от `useUiStore`. Плюс раунд исправлений 1: общая «стеклянная»
 * подложка пяти поверхностей (находка A №2) и общий `TooltipProvider`
 * (находка B №4).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { cn } from '../lib/cn.js';
import { useUiStore } from '../store/ui.js';
import { Dialog, DialogContent, DialogTrigger } from './dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu.js';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from './context-menu.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select.js';
import { MENU_GLASS } from './glass.js';
import { Command, CommandInput, CommandItem, CommandList, CommandShortcut } from './command.js';
import { Toaster } from './sonner.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip.js';
import { buttonVariants } from './button.js';
import { contrastRatio, compositeOver } from '../test-utils/contrast.js';

afterEach(cleanup);

// cmdk измеряет список через ResizeObserver и прокручивает выделенный пункт
// через scrollIntoView — этого нет в jsdom, заглушки нужны только для теста
// `ui/command`, но безвредны и для остальных.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);
Element.prototype.scrollIntoView = vi.fn();

describe('cn — тест 1', () => {
  it("cn('px-2', 'px-4') → 'px-4' (tailwind-merge убирает конфликт)", () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });
});

describe('ui/dialog — тест 4', () => {
  it('открывается по триггеру, Esc закрывает, фокус возвращается на триггер', async () => {
    render(
      <Dialog>
        <DialogTrigger>Открыть</DialogTrigger>
        <DialogContent aria-describedby={undefined}>Содержимое диалога</DialogContent>
      </Dialog>,
    );

    const trigger = screen.getByText('Открыть');
    fireEvent.click(trigger);

    const content = await screen.findByText('Содержимое диалога');
    fireEvent.keyDown(content, { key: 'Escape' });

    await screen.findByText('Открыть');
    expect(screen.queryByText('Содержимое диалога')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('ui/dropdown-menu — тест 4', () => {
  it('стрелки ходят по пунктам, Enter выбирает подсвеченный', async () => {
    const onSelectA = vi.fn();
    const onSelectB = vi.fn();

    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Меню</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelectA}>Пункт А</DropdownMenuItem>
          <DropdownMenuItem onSelect={onSelectB}>Пункт Б</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    // Триггер открывается по `pointerdown`, не по `click` (сам Radix ловит
    // клик отдельно от открытия, чтобы не путать источники ввода) — обычный
    // `fireEvent.click` в jsdom меню не откроет.
    fireEvent.pointerDown(screen.getByText('Меню'), { button: 0 });
    const itemA = await screen.findByText('Пункт А');

    // Фокус после открытия Radix переносит асинхронно (requestAnimationFrame) —
    // не полагаемся на то, что он уже переехал к моменту находки текста, и
    // ставим его сами: важно поведение стрелок/Enter, а не то, кто по
    // умолчанию получает фокус первым.
    itemA.focus();
    fireEvent.keyDown(itemA, { key: 'ArrowDown' });
    const itemB = screen.getByText('Пункт Б');
    fireEvent.keyDown(itemB, { key: 'Enter' });

    expect(onSelectB).toHaveBeenCalledTimes(1);
    expect(onSelectA).not.toHaveBeenCalled();
  });
});

describe('ui/glass — раунд исправлений 1 (находка A №2)', () => {
  // Открываем каждую поверхность через `defaultOpen`, а не реальным
  // взаимодействием — цель теста не переповторить открытие/закрытие (это уже
  // проверено выше и в отчёте исполнителя), а убедиться, что рецепт «стекла»
  // (`ui/glass.ts#MENU_GLASS`) реально применён у всех пяти одинаково.
  const glassTokens = MENU_GLASS.split(' ');

  function expectGlass(element: HTMLElement | null): void {
    expect(element).not.toBeNull();
    for (const token of glassTokens) {
      expect(element?.className).toContain(token);
    }
  }

  it('dropdown-menu', () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Меню</DropdownMenuTrigger>
        <DropdownMenuContent data-testid="glass-surface">
          <DropdownMenuItem>Пункт</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expectGlass(screen.queryByTestId('glass-surface'));
  });

  it('context-menu', () => {
    // У ContextMenu нет `defaultOpen` (в отличие от прочих четырёх) — открытие
    // всегда идёт от реального события `contextmenu` с точкой на экране.
    render(
      <ContextMenu>
        <ContextMenuTrigger>Область</ContextMenuTrigger>
        <ContextMenuContent data-testid="glass-surface">Пункт</ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('Область'));
    expectGlass(screen.queryByTestId('glass-surface'));
  });

  it('popover', () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Триггер</PopoverTrigger>
        <PopoverContent data-testid="glass-surface">Содержимое</PopoverContent>
      </Popover>,
    );
    expectGlass(screen.queryByTestId('glass-surface'));
  });

  it('hover-card', () => {
    render(
      <HoverCard defaultOpen>
        <HoverCardTrigger>Триггер</HoverCardTrigger>
        <HoverCardContent data-testid="glass-surface">Содержимое</HoverCardContent>
      </HoverCard>,
    );
    expectGlass(screen.queryByTestId('glass-surface'));
  });

  it('select', () => {
    render(
      <Select defaultOpen defaultValue="a">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent data-testid="glass-surface">
          <SelectItem value="a">Вариант А</SelectItem>
        </SelectContent>
      </Select>,
    );
    expectGlass(screen.queryByTestId('glass-surface'));
  });
});

describe('ui/tooltip — раунд исправлений 1 (находка B №4)', () => {
  it('один TooltipProvider на несколько тултипов — второй показывается без повторной задержки', () => {
    // Реальные таймеры тут не годятся: `findByText` сам ждёт до ~1с, поэтому
    // даже полная задержка в 400 мс осталась бы незамеченной — нужен точный
    // момент времени, а не факт «рано или поздно появилось».
    vi.useFakeTimers();
    try {
      render(
        <TooltipProvider delayDuration={400}>
          <Tooltip>
            <TooltipTrigger>Первый</TooltipTrigger>
            <TooltipContent>Подсказка 1</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger>Второй</TooltipTrigger>
            <TooltipContent>Подсказка 2</TooltipContent>
          </Tooltip>
        </TooltipProvider>,
      );

      const first = screen.getByText('Первый');
      // Фокус открывает тултип мгновенно (клавиатурная навигация, минуя
      // задержку наведения) — этим же путём тултип 1 «показан».
      fireEvent.focus(first);
      expect(screen.queryByText('Подсказка 1')).not.toBeNull();

      // Закрытие тултипа 1 переводит общий провайдер в окно `skipDelayDuration`
      // (300 мс у Radix по умолчанию) — до его истечения наведение на любой
      // другой тултип открывает его сразу, без повторной задержки в 400 мс.
      fireEvent.blur(first);

      const second = screen.getByText('Второй');
      fireEvent.pointerMove(second, { pointerType: 'mouse' });

      // Спустя всего 50 мс (меньше и 400-мс задержки открытия, и 300-мс окна
      // skip-delay) тултип 2 уже должен быть виден — иначе он ждёт полную
      // задержку заново (старый баг — свой `TooltipProvider` на каждый `Tooltip`).
      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(screen.queryByText('Подсказка 2')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ui/command — тест 4', () => {
  it('ввод в CommandInput фильтрует пункты', () => {
    render(
      <Command>
        <CommandInput placeholder="Поиск команд" />
        <CommandList>
          <CommandItem>Терминал</CommandItem>
          <CommandItem>Файлы проекта</CommandItem>
        </CommandList>
      </Command>,
    );

    expect(screen.getByText('Терминал')).toBeTruthy();
    expect(screen.getByText('Файлы проекта')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Поиск команд'), { target: { value: 'файл' } });

    expect(screen.queryByText('Терминал')).toBeNull();
    expect(screen.getByText('Файлы проекта')).toBeTruthy();
  });

  it('CommandShortcut — 10px, как подсказки клавиш dropdown/context-menu (раунд исправлений 1, находка A minor №1)', () => {
    render(<CommandShortcut>⌘K</CommandShortcut>);
    const shortcut = screen.getByText('⌘K');
    expect(shortcut.className).toContain('text-[10px]');
    expect(shortcut.className).toContain('opacity-60');
  });
});

describe('ui/sonner — тест 7', () => {
  it('dark: true в сторе — тема dark, dark: false — light', async () => {
    const initialDark = useUiStore.getState().dark;
    // Раунд исправлений 1 (находка A minor №2): восстановление стора — в
    // finally, а не последней строкой теста, иначе упавший раньше ассерт
    // оставляет `dark` мутированным для тестов, идущих следом в том же файле.
    try {
      useUiStore.setState({ dark: true });

      // `Toaster` рендерится порталом в `document.body`, а не в контейнер RTL,
      // и без единого активного тоста sonner вовсе не рисует помеченный тегом
      // `[data-sonner-toaster]` контейнер (`toasts.length === 0` → null) —
      // сначала кладём тост, потом проверяем тему.
      const { rerender } = render(<Toaster />);
      toast('Проверка темы');
      await waitFor(() => {
        expect(
          document.querySelector('[data-sonner-toaster]')?.getAttribute('data-sonner-theme'),
        ).toBe('dark');
      });

      useUiStore.setState({ dark: false });
      rerender(<Toaster />);
      await waitFor(() => {
        expect(
          document.querySelector('[data-sonner-toaster]')?.getAttribute('data-sonner-theme'),
        ).toBe('light');
      });
    } finally {
      useUiStore.setState({ dark: initialDark });
    }
  });
});

describe('ui/button — раунд исправлений 1 куска 1.4 (ревью B, находка «текст destructive-кнопки нечитаем в тёмной теме»)', () => {
  it('вариант destructive — белый текст, а не --destructive-foreground (тот в Orca — цвет красного текста на обычном фоне, не текста на красной кнопке)', () => {
    const classes = buttonVariants({ variant: 'destructive' });
    expect(classes).toContain('text-white');
    expect(classes).toContain('dark:bg-destructive/60');
    expect(classes).toContain('hover:bg-destructive/90');
    expect(classes).not.toContain('destructive-foreground');
  });

  it('контраст белого текста на destructive-кнопке — WCAG AA (≥4.5) в обеих темах, значения из tokens.css', () => {
    // Светлая тема: `bg-destructive` непрозрачный — --destructive #e40014 (tokens.css:152).
    expect(contrastRatio([255, 255, 255], [0xe4, 0x00, 0x14])).toBeGreaterThanOrEqual(4.5);

    // Тёмная тема: `dark:bg-destructive/60` — 60% --destructive #ff6568 (tokens.css:275)
    // поверх --background #0a0a0a (tokens.css:260), эффективный фон ≈ #9d4142.
    const darkEffectiveBg = compositeOver([0xff, 0x65, 0x68], 0.6, [0x0a, 0x0a, 0x0a]);
    expect(contrastRatio([255, 255, 255], darkEffectiveBg)).toBeGreaterThanOrEqual(4.5);
  });
});
