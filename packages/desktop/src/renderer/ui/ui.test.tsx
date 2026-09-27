/**
 * Тесты 1, 4 и 7 куска 1.2 плана: `cn`, поведение диалога/выпадающего
 * меню/палитры команд (клавиатура и фокус — то, что не видно из чтения кода)
 * и тема тостов sonner от `useUiStore`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { Command, CommandInput, CommandItem, CommandList } from './command.js';
import { Toaster } from './sonner.js';

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
});

describe('ui/sonner — тест 7', () => {
  it('dark: true в сторе — тема dark, dark: false — light', async () => {
    const initialDark = useUiStore.getState().dark;
    useUiStore.setState({ dark: true });

    // `Toaster` рендерится порталом в `document.body`, а не в контейнер RTL, и
    // без единого активного тоста sonner вовсе не рисует помеченный тегом
    // `[data-sonner-toaster]` контейнер (`toasts.length === 0` → null) — сначала
    // кладём тост, потом проверяем тему.
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

    useUiStore.setState({ dark: initialDark });
  });
});
