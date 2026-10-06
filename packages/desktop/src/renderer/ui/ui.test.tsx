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
import { TOAST_BOTTOM_OFFSET, TOAST_INSET_VAR, Toaster } from './sonner.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip.js';
import { buttonVariants } from './button.js';
import { Input } from './input.js';
import { Textarea } from './textarea.js';
import { Badge } from './badge.js';
import { Toggle } from './toggle.js';
import { ToggleGroup, ToggleGroupItem } from './toggle-group.js';
import { DialogFooter, DialogTitle } from './dialog.js';
import { Card, CardKicker, CardTitle } from './card.js';
import { Checkbox } from './checkbox.js';

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

describe('ui/select — описание пункта (нормалайзер модели и effort 2026-10-06)', () => {
  it('description — вторая строка пункта: в имя пункта и в кнопку списка не попадает', () => {
    render(
      <Select defaultOpen defaultValue="ultra">
        <SelectTrigger aria-label="Effort">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="low">Low</SelectItem>
          <SelectItem value="ultra" description="Maximum reasoning with automatic task delegation">
            Ultra
          </SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(screen.getByRole('option', { name: 'Ultra' }).textContent).toBe('UltraMaximum reasoning with automatic task delegation');
    expect(screen.getByText('Maximum reasoning with automatic task delegation').className).toContain('truncate');
    expect(screen.getByRole('option', { name: 'Low' }).textContent).toBe('Low');
    // Открытый список прячет остальное от скринридера (`aria-hidden`) — кнопку ищем с `hidden`.
    expect(screen.getByRole('combobox', { name: 'Effort', hidden: true }).textContent).toBe('Ultra');
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

describe('ui/sonner — угол с плавающей панелью (кусок 12)', () => {
  it('отступ снизу — 2.5rem плюс --toast-inset-bottom панели в углу, но не выше окна (100vh − 4.5rem)', async () => {
    expect(TOAST_INSET_VAR).toBe('--toast-inset-bottom');
    expect(TOAST_BOTTOM_OFFSET).toBe('min(calc(2.5rem + var(--toast-inset-bottom, 0px)), calc(100vh - 4.5rem))');

    render(<Toaster />);
    toast('Проверка отступа');
    await waitFor(() => {
      const list = document.querySelector<HTMLElement>('[data-sonner-toaster]');
      expect(list?.style.getPropertyValue('--offset-bottom')).toBe(TOAST_BOTTOM_OFFSET);
    });
  });

  it('свой offset из props перекрывает отступ по умолчанию', async () => {
    render(<Toaster offset={{ bottom: '10px' }} />);
    toast('Проверка своего отступа');
    await waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-sonner-toaster]')?.style.getPropertyValue('--offset-bottom')).toBe('10px');
    });
  });
});

/**
 * Облик Organic (кусок 1 плана «Organic», спека окна 2026-09-29, раздел 4 «Компоненты Organic»):
 * пилюли, Caprasimo в кнопках и заголовках диалогов, сегмент с выбранной опцией на главном цвете,
 * теги трёх видов, карточка, диалог на `surface` с радиусом 32 и тенью `--shadow-lg`. Контраст
 * пар (текст на главной кнопке, теги) держит `styles/tokens.test.ts`; здесь — что примитивы берут
 * именно эти токены.
 */
describe('ui/button — Organic', () => {
  const cls = (options?: Parameters<typeof buttonVariants>[0]): string => buttonVariants(options);

  it('пилюля, Caprasimo 14px/1.2, gap 6, рамка 1px прозрачная у всех вариантов', () => {
    const base = cls();
    for (const token of ['rounded-full', 'font-heading', 'text-sm', 'leading-[1.2]', 'gap-1.5', 'border', 'border-transparent']) {
      expect(base, token).toContain(token);
    }
    expect(base).toContain('disabled:opacity-[.45]');
    expect(base).not.toContain('shadow');
  });

  it('главная — фон --primary, hover и active — свои токены (решение 1: светлая accent-700/800/900, тёмная accent/600/700)', () => {
    const primary = cls({ variant: 'default' });
    expect(primary).toContain('bg-primary');
    expect(primary).toContain('text-primary-foreground');
    expect(primary).toContain('hover:bg-primary-hover');
    expect(primary).toContain('active:bg-primary-active');
  });

  it('secondary (outline) — рамка divider, hover text 7 %, active text 14 %', () => {
    const secondary = cls({ variant: 'outline' });
    expect(secondary).toContain('border-border');
    expect(secondary).toContain('hover:bg-foreground/7');
    expect(secondary).toContain('active:bg-foreground/14');
    expect(secondary).not.toContain('shadow');
  });

  it('destructive — текст --destructive-foreground: 5.7:1 / 9.4:1 (белый в тёмной давал 2.1:1), без dark:-подмен', () => {
    const destructive = cls({ variant: 'destructive' });
    expect(destructive).toContain('bg-destructive');
    expect(destructive).toContain('text-destructive-foreground');
    expect(destructive).not.toContain('text-white');
    expect(destructive).not.toContain('dark:');
  });

  it('размеры прежние — раскладка не сдвигается: 36 / 32 / 24 и квадрат 24', () => {
    expect(cls({ size: 'default' })).toContain('h-9');
    expect(cls({ size: 'sm' })).toContain('h-8');
    expect(cls({ size: 'xs' })).toContain('h-6');
    expect(cls({ size: 'icon-xs' })).toMatch(/\bh-6\b.*\bw-6\b/);
  });
});

describe('ui/input и ui/textarea — Organic', () => {
  it('поле — пилюля 36px на surface, рамка divider, hover text 45 %, фокус — рамка accent, caret accent', () => {
    render(<Input aria-label="поле" />);
    const classes = screen.getByLabelText('поле').className;
    for (const token of ['h-9', 'rounded-full', 'bg-background', 'border-input', 'px-[14px]', 'py-[6px]', 'text-sm', 'caret-ring', 'hover:border-foreground/45', 'focus-visible:border-ring']) {
      expect(classes, token).toContain(token);
    }
    expect(classes).not.toContain('shadow');
    // `file:bg-transparent` (поле выбора файла) остаётся — прозрачным не должно быть само поле.
    expect(classes).not.toMatch(/(^| )bg-transparent/);
  });

  it('textarea — радиус 16 и от 90px, те же фон, рамка и фокус', () => {
    render(<Textarea aria-label="текст" />);
    const classes = screen.getByLabelText('текст').className;
    for (const token of ['rounded-md', 'min-h-[90px]', 'bg-background', 'border-input', 'px-[14px]', 'hover:border-foreground/45', 'focus-visible:border-ring', 'caret-ring']) {
      expect(classes, token).toContain(token);
    }
    expect(classes).not.toContain('rounded-full');
  });

  it('select — триггер того же вида, что поле; список — сплошная подложка меню', () => {
    render(
      <Select defaultValue="a">
        <SelectTrigger aria-label="выбор">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Вариант</SelectItem>
        </SelectContent>
      </Select>,
    );
    const trigger = screen.getByLabelText('выбор').className;
    for (const token of ['h-9', 'rounded-full', 'bg-background', 'border-input', 'hover:border-foreground/45', 'focus:border-ring']) {
      expect(trigger, token).toContain(token);
    }
  });
});

describe('ui/glass — Organic: меню, попапы и список select на --popover', () => {
  it('сплошной фон --popover, тень shadow-lg, радиус md; ни стекла, ни белого/чёрного', () => {
    for (const token of ['bg-popover', 'text-popover-foreground', 'shadow-lg', 'rounded-md']) expect(MENU_GLASS, token).toContain(token);
    expect(MENU_GLASS).not.toMatch(/backdrop-blur|bg-white|bg-black|border-black|border-white/);
  });
});

describe('ui/badge — теги трёх видов', () => {
  it('11px, tracking .02em, пилюля, padding 3×10', () => {
    render(<Badge>тег</Badge>);
    const base = screen.getByText('тег').className;
    for (const token of ['rounded-full', 'text-[11px]', 'tracking-[0.02em]', 'px-2.5', 'py-[3px]']) expect(base, token).toContain(token);
  });

  it.each([
    ['accent', 'bg-accent-100', 'text-accent-800'],
    ['accent-2', 'bg-accent-2-100', 'text-accent-2-800'],
    ['neutral', 'bg-neutral-100', 'text-neutral-800'],
    // Теги на листе центра: в светлой теме 100-е ступени — почти сам лист (`neutral-100` — он и есть), тег слился бы
    // с ним (в тёмной — 100).
    ['neutral-sheet', 'bg-neutral-200', 'text-neutral-800'],
    ['accent-sheet', 'bg-accent-200', 'text-accent-800'],
    ['accent-2-sheet', 'bg-accent-2-200', 'text-accent-2-800'],
  ] as const)('вид %s — фон и текст 800 своей рампы (на листе светлой — 200)', (variant, background, text) => {
    render(<Badge variant={variant}>вид</Badge>);
    const classes = screen.getByText('вид').className;
    expect(classes).toContain(background);
    expect(classes).toContain(text);
  });

  it.each([
    ['neutral-sheet', 'neutral'],
    ['accent-sheet', 'accent'],
    ['accent-2-sheet', 'accent-2'],
  ] as const)(
    '%s: светлая — фон 200, тёмная — 100 (как в handoff dark-08); голой заливки 100 нет — на листе светлой темы она невидима',
    (variant, ramp) => {
      render(<Badge variant={variant}>вид</Badge>);
      const classes = screen.getByText('вид').className.split(/\s+/);
      expect(classes).toContain(`bg-${ramp}-200`);
      expect(classes).toContain(`dark:bg-${ramp}-100`);
      expect(classes).not.toContain(`bg-${ramp}-100`);
    },
  );
});

describe('ui/toggle-group — сегмент', () => {
  it('рамка divider, пилюля, без зазоров: разделитель между опциями, обрезка по скруглению', () => {
    render(
      <ToggleGroup type="single" value="a" data-testid="segment">
        <ToggleGroupItem value="a">Один</ToggleGroupItem>
        <ToggleGroupItem value="b">Два</ToggleGroupItem>
      </ToggleGroup>,
    );
    const group = screen.getByTestId('segment').className;
    for (const token of ['rounded-full', 'border', 'border-border', 'overflow-hidden', 'inline-flex']) expect(group, token).toContain(token);
    expect(group).not.toContain('gap-1');
    const second = screen.getByRole('radio', { name: 'Два' }).className;
    expect(second).toContain('border-l');
    expect(second).toContain('rounded-none');
  });

  it('выбранная опция — --primary с текстом --primary-foreground, hover невыбранной — text 7 %; края и кольца прежнего toggle нет', () => {
    render(
      <ToggleGroup type="single" value="a">
        <ToggleGroupItem value="a">Один</ToggleGroupItem>
        <ToggleGroupItem value="b">Два</ToggleGroupItem>
      </ToggleGroup>,
    );
    const selected = screen.getByRole('radio', { name: 'Один' });
    expect(selected.getAttribute('data-state')).toBe('on');
    for (const token of ['data-[state=on]:bg-primary', 'data-[state=on]:text-primary-foreground', 'data-[state=on]:hover:bg-primary-hover', 'hover:bg-foreground/7']) {
      expect(selected.className, token).toContain(token);
    }
    expect(selected.className).not.toContain('toggle-on-edge');
  });

  it('опция — 13px обычным весом, padding 7×12, gap 6 (спека 4, «сегмент»); без фиксированной высоты у размера по умолчанию', () => {
    render(
      <ToggleGroup type="single" value="a">
        <ToggleGroupItem value="a">Один</ToggleGroupItem>
      </ToggleGroup>,
    );
    const classes = screen.getByRole('radio', { name: 'Один' }).className;
    for (const token of ['text-[13px]', 'px-3', 'py-[7px]', 'gap-1.5']) expect(classes, token).toContain(token);
    expect(classes).not.toMatch(/\bfont-medium\b|\btext-sm\b|\bh-9\b/);
  });

  it('фокус внутри сегмента — обводка внутрь: снаружи её обрежет overflow-hidden', () => {
    render(
      <ToggleGroup type="single" value="a">
        <ToggleGroupItem value="a">Один</ToggleGroupItem>
      </ToggleGroup>,
    );
    expect(screen.getByRole('radio', { name: 'Один' }).className).toContain('focus-visible:-outline-offset-2');
  });

  it('одиночный тумблер — пилюля с тем же признаком выбранного', () => {
    render(<Toggle pressed>Перенос</Toggle>);
    const classes = screen.getByRole('button', { name: 'Перенос' }).className;
    for (const token of ['rounded-full', 'data-[state=on]:bg-primary', 'data-[state=on]:text-primary-foreground']) expect(classes, token).toContain(token);
  });
});

describe('ui/dialog — Organic', () => {
  it('на surface, радиус 32, отступ 17.6, зазор 13.2, тень shadow-lg; затемнение — токен --scrim', () => {
    render(
      <Dialog defaultOpen>
        <DialogContent aria-describedby={undefined} data-testid="dialog">
          <DialogTitle>Заголовок</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const content = screen.getByTestId('dialog').className;
    for (const token of ['bg-background', 'rounded-xl', 'p-(--space-4)', 'gap-(--space-3)', 'shadow-lg']) expect(content, token).toContain(token);
    expect(content).not.toMatch(/\bbg-card\b|border-border|shadow-\[/);
    const overlay = document.querySelector('[data-state="open"].fixed.inset-0');
    expect(overlay?.className).toContain('bg-scrim');
  });

  it('заголовок — Caprasimo 20px; кнопки справа с зазором 8.8 и отступом сверху 8.8', () => {
    render(
      <Dialog defaultOpen>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Заголовок</DialogTitle>
          <DialogFooter data-testid="footer">кнопки</DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    const title = screen.getByText('Заголовок').className;
    for (const token of ['font-heading', 'text-xl', 'font-normal']) expect(title, token).toContain(token);
    const footer = screen.getByTestId('footer').className;
    for (const token of ['sm:justify-end', 'gap-(--space-2)', 'mt-(--space-2)']) expect(footer, token).toContain(token);
  });
});

describe('ui/card — Organic', () => {
  it('карточка на surface: радиус 32, отступ 13.2, зазор 8.8; kicker 10px .1em, заголовок Caprasimo 17px', () => {
    render(
      <Card data-testid="card">
        <CardKicker>Not started</CardKicker>
        <CardTitle>S04 тесты</CardTitle>
      </Card>,
    );
    const card = screen.getByTestId('card').className;
    for (const token of ['flex', 'flex-col', 'gap-(--space-2)', 'rounded-xl', 'bg-background', 'p-(--space-3)']) expect(card, token).toContain(token);
    const kicker = screen.getByText('Not started').className;
    for (const token of ['text-[10px]', 'uppercase', 'tracking-[0.1em]']) expect(kicker, token).toContain(token);
    const title = screen.getByText('S04 тесты').className;
    for (const token of ['font-heading', 'text-[17px]', 'leading-[1.2]']) expect(title, token).toContain(token);
  });

  it('свои классы ложатся поверх: заголовок пустого состояния — 20px', () => {
    render(<CardTitle className="text-xl">Пусто</CardTitle>);
    const classes = screen.getByText('Пусто').className;
    expect(classes).toContain('text-xl');
    expect(classes).not.toContain('text-[17px]');
  });
});

describe('ui/checkbox — радиус шкалы Organic', () => {
  it('квадрат 16px не превращается в круг: `rounded-sm` теперь 8px, поэтому радиус свой — 5px', () => {
    render(<Checkbox aria-label="флажок" />);
    const classes = screen.getByRole('checkbox', { name: 'флажок' }).className;
    expect(classes).toContain('rounded-[5px]');
    expect(classes).not.toMatch(/(^| )rounded-sm( |$)/);
    expect(classes).toContain('size-4');
  });
});
