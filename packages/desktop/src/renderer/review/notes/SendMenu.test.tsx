/**
 * Тест 3 куска 8.4b (меню получателя; сделано в 9.3b, решение контролёра): по умолчанию — сессия,
 * которую назвал вызывающий; сессия без живого процесса неактивна с подписью `not running`.
 * Отправка — только нажатием человека: ни монтирование, ни открытие меню `onSend` не зовут.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useActivityStore } from '../../store/activity.js';
import { makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { SendMenu } from './SendMenu.js';

afterEach(() => {
  cleanup();
  useActivityStore.setState({ byRef: {} });
});

const ENTRY = makeWork('w-01', {
  sessions: [
    makeSession('s-01', 'planner', { startedAt: '2026-09-27T08:00:00.000Z' }),
    makeSession('s-02', 'executor', { startedAt: '2026-09-27T08:00:00.000Z' }),
    makeSession('s-03', 'sleeper', { lifecycle: 'sleeping' }),
  ],
});

function openMenu(): HTMLElement {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Choose recipient' }), { key: 'Enter' });
  return screen.getByRole('menu');
}

describe('SendMenu (тест 3 куска 8.4b)', () => {
  it('по умолчанию — названная сессия: она отмечена в меню и видна на главной кнопке; её нажатие — onSend(s-02)', () => {
    const onSend = vi.fn();
    render(<SendMenu entry={ENTRY} defaultSessionId="s-02" label="Send to agent" onSend={onSend} />);
    expect(onSend).not.toHaveBeenCalled();

    const main = screen.getByRole('button', { name: /^Send to agent/ });
    expect(main.textContent).toContain('S02');
    const menu = openMenu();
    expect(onSend).not.toHaveBeenCalled();
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.getAttribute('data-session-id'))).toEqual(['s-01', 's-02', 's-03']);
    expect(items.filter((item) => item.hasAttribute('data-default')).map((item) => item.getAttribute('data-session-id'))).toEqual(['s-02']);
    // Точка состояния, ярлык сессии.
    expect(within(items[0] as HTMLElement).queryByTestId('agent-state-dot')).not.toBeNull();
    expect(items[0]?.textContent).toContain('S01 planner');

    fireEvent.click(items[0] as HTMLElement);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('s-01');

    fireEvent.click(screen.getByRole('button', { name: /^Send to agent/ }));
    expect(onSend).toHaveBeenLastCalledWith('s-02');
  });

  it('сессия с lifecycle sleeping неактивна с подписью not running; выбор её не шлёт', () => {
    const onSend = vi.fn();
    render(<SendMenu entry={ENTRY} defaultSessionId="s-01" label="Send" onSend={onSend} />);
    const menu = openMenu();
    const sleeper = within(menu).getAllByRole('menuitem').find((item) => item.getAttribute('data-session-id') === 's-03');
    expect(sleeper?.getAttribute('aria-disabled')).toBe('true');
    expect(sleeper?.textContent).toContain('not running');
    fireEvent.click(sleeper as HTMLElement);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('по умолчанию не запущена или её нет — главная кнопка неактивна, меню открывается', () => {
    const onSend = vi.fn();
    const { unmount } = render(<SendMenu entry={ENTRY} defaultSessionId="s-03" label="Send" onSend={onSend} />);
    expect((screen.getByRole('button', { name: /^Send/ }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    render(<SendMenu entry={ENTRY} defaultSessionId={null} label="Send" onSend={onSend} />);
    expect((screen.getByRole('button', { name: /^Send/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(openMenu()).getAllByRole('menuitem')).toHaveLength(3);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('disabled — обе кнопки неактивны', () => {
    render(<SendMenu entry={ENTRY} defaultSessionId="s-01" label="Send" disabled onSend={vi.fn()} />);
    expect((screen.getByRole('button', { name: /^Send/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Choose recipient' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('длинный ярлык сессии обрезается, а не раздвигает меню', () => {
    const long = makeWork('w-02', { sessions: [makeSession('s-01', 'x'.repeat(300))] });
    render(<SendMenu entry={long} defaultSessionId="s-01" label="Send" onSend={vi.fn()} />);
    const item = within(openMenu()).getByRole('menuitem');
    expect(item.querySelector('.truncate')).not.toBeNull();
  });
});
