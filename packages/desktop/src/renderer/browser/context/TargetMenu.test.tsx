import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { REQUIRED_METHODS } from '../../lib/capabilities.js';
import { useHostStore } from '../../store/host.js';
import { useProvidersStore } from '../../store/providers.js';
import { makeRoom, makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { TargetMenu } from './TargetMenu.js';

const LONG = 'x'.repeat(60);
const WORK = makeWork('w-01', {
  sessions: [makeSession('s-02', `backend ${LONG}`), makeSession('s-03', 'helper', { provider: 'codex' }), makeSession('s-04', 'gone', { lifecycle: 'closed' })],
  rooms: [makeRoom('r-01', `review ${LONG}`)],
});

afterEach(() => {
  cleanup();
  useHostStore.setState({ status: { state: 'connecting' } });
  useProvidersStore.setState({ providers: [], loaded: false });
});

/** Хост с лентой и claude с версией не ниже порога ленты: у Claude-сессий вид Chat есть. */
function withFeed(): void {
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.3.0', methods: [...REQUIRED_METHODS, 'feed.snapshot'] } });
  useProvidersStore.setState({ providers: [{ id: 'claude', label: 'Claude Code', available: true, version: '2.1.286', limits: null }], loaded: true });
}

function openMenu(): HTMLElement {
  fireEvent.keyDown(screen.getByRole('button', { name: /^To:/ }), { key: 'Enter' });
  return screen.getByRole('menu');
}

describe('TargetMenu (спека браузера 4.1, 4.5)', () => {
  it('кнопка — «To: имя цели» и режется многоточием; меню — Sessions и Rooms, текущая отмечена', () => {
    withFeed();
    render(<TargetMenu entry={WORK} target={{ kind: 'room', roomId: 'r-01' }} onChange={vi.fn()} />);
    const button = screen.getByRole('button', { name: /^To:/ });
    expect(button.textContent).toBe(`To: review ${LONG}`);
    expect(button.className).toContain('max-w-40');
    expect(button.querySelector('[data-target-label]')?.className).toContain('truncate');
    const menu = openMenu();
    expect(within(menu).getByText('Sessions')).toBeTruthy();
    expect(within(menu).getByText('Rooms')).toBeTruthy();
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.getAttribute('data-target-key'))).toEqual(['session:s-02', 'session:s-03', 'room:r-01']);
    expect(items.filter((item) => item.hasAttribute('data-current')).map((item) => item.getAttribute('data-target-key'))).toEqual(['room:r-01']);
  });

  it('Фокус ревью 2: длинные ярлык сессии и название комнаты — целиком в title, на экране режутся; вид chat | terminal', () => {
    withFeed();
    render(<TargetMenu entry={WORK} target={{ kind: 'session', sessionId: 's-02' }} onChange={vi.fn()} />);
    const menu = openMenu();
    const [backend, helper, room] = within(menu).getAllByRole('menuitem') as [HTMLElement, HTMLElement, HTMLElement];
    expect(backend.getAttribute('title')).toBe(`S02 backend ${LONG}`);
    expect(backend.querySelector('span.truncate')?.textContent).toBe(`S02 backend ${LONG}`);
    expect(backend.textContent).toContain('chat');
    expect(helper.textContent).toContain('terminal');
    expect(room.getAttribute('title')).toBe(`review ${LONG}`);
    expect(menu.className).toContain('max-w-[calc(100vw-32px)]');
  });

  it('выбор пункта — onChange с целью; закрытой сессии в меню нет; без цели — «To: —»', () => {
    const onChange = vi.fn();
    render(<TargetMenu entry={WORK} target={null} onChange={onChange} />);
    expect(screen.getByRole('button', { name: /^To:/ }).textContent).toBe('To: —');
    const menu = openMenu();
    expect(within(menu).queryByText(/S04/)).toBeNull();
    fireEvent.click(within(menu).getAllByRole('menuitem')[1] as HTMLElement);
    expect(onChange).toHaveBeenCalledWith({ kind: 'session', sessionId: 's-03' });
  });

  it('ни сессий, ни комнат — кнопка неактивна', () => {
    render(<TargetMenu entry={makeWork('w-02')} target={null} onChange={vi.fn()} />);
    expect((screen.getByRole('button', { name: /^To:/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('сессия без процесса (sleeping, pending) — пометка «not running» вместо вида, но выбрать её можно; живая — вид', () => {
    withFeed();
    const onChange = vi.fn();
    const work = makeWork('w-03', {
      sessions: [makeSession('s-02', 'live'), makeSession('s-03', 'nap', { lifecycle: 'sleeping' }), makeSession('s-05', 'queued', { lifecycle: 'pending' })],
    });
    render(<TargetMenu entry={work} target={null} onChange={onChange} />);
    const [live, nap, queued] = within(openMenu()).getAllByRole('menuitem') as [HTMLElement, HTMLElement, HTMLElement];
    expect(live.textContent).toContain('chat');
    expect(live.textContent).not.toContain('not running');
    for (const row of [nap, queued]) {
      expect(row.textContent).toContain('not running');
      expect(row.textContent).not.toContain('chat');
      expect(row.hasAttribute('data-disabled')).toBe(false);
    }
    fireEvent.click(nap);
    expect(onChange).toHaveBeenCalledWith({ kind: 'session', sessionId: 's-03' });
  });
});
