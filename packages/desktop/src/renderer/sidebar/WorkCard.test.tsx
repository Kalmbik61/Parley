/**
 * Тесты 3 и 7 куска 3.3: карточка работы (спека 6.3). Облик Organic (спека окна 2026-09-29, 1.2): радиус
 * 16, отступ 8 8 8 10; активная — фон `neutral-100` и `shadow-sm`, неактивная под курсором — `text 4%`
 * (токен `--card-hover`); в строке заголовка — значок самого срочного состояния, название, `✉N`, `#N`,
 * время; полосы внимания слева нет.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import type { WorkEntry } from '@harnas/core';
import { S } from '../../shared/strings.js';
import type { WorkAttention } from '../attention/derive.js';
import { workKey } from '../lib/tree-order.js';
import { encodeIpcError } from '../../shared/ipc-error.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';
import { useUiStore } from '../store/ui.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { activityMap, makeActivity, makeLetter, makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { WorkCard, type WorkCardProps } from './WorkCard.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

// Решение контролёра 3: пропсы строк сессий — чтобы видеть, что кеш колбэков строк чистится.
const rowProps = vi.hoisted(() => ({ all: [] as Array<import('./SessionRow.js').SessionRowProps> }));
vi.mock('./SessionRow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./SessionRow.js')>();
  const real = actual.SessionRow as unknown as { type?: (props: import('./SessionRow.js').SessionRowProps) => JSX.Element };
  const inner = real.type;
  if (typeof inner !== 'function') return actual;
  return {
    ...actual,
    SessionRow: {
      ...actual.SessionRow,
      type: (props: import('./SessionRow.js').SessionRowProps) => {
        rowProps.all.push(props);
        return inner(props);
      },
    },
  };
});

let bridge: FakeBridge;
let disposeHost: () => void = () => {};

beforeEach(() => {
  bridge = createFakeBridge();
  disposeHost = useHostStore.getState().init(bridge);
  useUiStore.setState({ sidebarHolds: {} });
  vi.mocked(toast).mockClear();
});

const NOW = new Date('2026-09-27T10:00:00.000Z');

function attention(patch: Partial<WorkAttention> = {}): WorkAttention {
  return { level: 'idle', needsYou: 0, unseen: 0, humanUnread: 0, roomsUnread: {}, lastEventAt: '2026-09-27T09:57:00.000Z', ...patch };
}

function renderCard(entry: WorkEntry, patch: Partial<WorkCardProps> = {}) {
  const props: WorkCardProps = {
    entry,
    attention: attention(),
    activity: {},
    active: false,
    pinned: false,
    branch: null,
    now: NOW,
    selectedSessionId: null,
    onActivate: () => {},
    onOpenSession: () => {},
    onOpenMail: () => {},
    onOpenRoom: () => {},
    bridge,
    ...patch,
  };
  return render(<WorkCard {...props} />);
}

const card = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('[data-work-key]');
  if (element === null) throw new Error('карточки нет');
  return element;
};

afterEach(() => {
  cleanup();
  disposeHost();
});

describe('WorkCard (тест 3)', () => {
  const entry = makeWork('w-01', { projectPath: '/Users/me/VoiceStudio', title: 'Редизайн окна' });

  it('на корне data-work-key', () => {
    renderCard(entry);
    expect(card().getAttribute('data-work-key')).toBe(workKey('/Users/me/VoiceStudio', 'w-01'));
  });

  it('полосы внимания слева нет: состояние несёт значок в строке заголовка', () => {
    for (const level of ['needs-you', 'working', 'unseen', 'idle'] as const) {
      renderCard(entry, { attention: attention({ level }) });
      expect(card().querySelector('[data-attention-strip]'), level).toBeNull();
      cleanup();
    }
  });

  it('карточка: радиус 16, отступ 8 8 8 10, зазор 6 сверху; активная — neutral-100 и shadow-sm, прочая — hover --card-hover', () => {
    renderCard(entry);
    expect(card().className).toMatch(/\brounded-md\b/);
    expect(card().className).toMatch(/\bpy-2\b/);
    expect(card().className).toMatch(/\bpl-2\.5\b/);
    expect(card().className).toMatch(/\bpr-2\b/);
    expect(card().className).toMatch(/\bmt-1\.5\b/);
    expect(card().className).toContain('hover:bg-card-hover');
    expect(card().className).not.toMatch(/\bbg-neutral-100\b/);
    expect(card().className).not.toMatch(/\bshadow-sm\b/);
    expect(card().className).not.toMatch(/\bborder\b/);
    cleanup();
    renderCard(entry, { active: true });
    expect(card().className).toMatch(/\bbg-neutral-100\b/);
    expect(card().className).toMatch(/\bshadow-sm\b/);
    expect(card().className).not.toContain('hover:bg-card-hover');
  });

  it('жирный (700) заголовок при unseen и при письме человеку, иначе 500', () => {
    renderCard(entry, { attention: attention({ unseen: 1 }) });
    expect(screen.getByText('Редизайн окна').className).toContain('font-bold');
    cleanup();
    renderCard(entry, { attention: attention({ humanUnread: 1 }) });
    expect(screen.getByText('Редизайн окна').className).toContain('font-bold');
    cleanup();
    renderCard(entry);
    expect(screen.getByText('Редизайн окна').className).toContain('font-medium');
    expect(screen.getByText('Редизайн окна').className).not.toContain('font-bold');
    expect(screen.getByText('Редизайн окна').className).toContain('text-[13px]');
  });

  it('✉N: значок Mail, число, accent-700, тултип «N unread messages to you»; клик — onOpenMail, а не onActivate', () => {
    const onOpenMail = vi.fn();
    const onActivate = vi.fn();
    renderCard(entry, { attention: attention({ humanUnread: 2 }), onOpenMail, onActivate });
    const mail = screen.getByRole('button', { name: '2 unread messages to you' });
    expect(mail.getAttribute('title')).toBe('2 unread messages to you');
    expect(mail.textContent).toBe('2');
    expect(mail.querySelector('svg.lucide-mail')?.classList.contains('size-3')).toBe(true);
    expect(mail.className).toContain('text-accent-700');
    expect(mail.className).toContain('font-semibold');
    fireEvent.click(mail);
    expect(onOpenMail).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('#N: значок Hash, число комнат с непрочитанным, neutral-700; у работы с комнатами без непрочитанного — значок без числа; без комнат — ничего', () => {
    const withRooms = makeWork('w-01', { title: 'T', rooms: [makeRoom('r-01', 'one'), makeRoom('r-02', 'two')] });
    renderCard(withRooms, { attention: attention({ roomsUnread: { 'r-01': 4 } }) });
    const rooms = screen.getByRole('button', { name: 'Rooms' });
    expect(rooms.textContent).toBe('1');
    expect(rooms.getAttribute('title')).toBe('1 room with unread messages');
    expect(rooms.querySelector('svg.lucide-hash')?.classList.contains('size-3')).toBe(true);
    expect(rooms.className).toContain('text-work-sidebar-muted-foreground');
    cleanup();
    renderCard(withRooms);
    expect(screen.getByRole('button', { name: 'Rooms' }).textContent).toBe('');
    cleanup();
    renderCard(makeWork('w-01', { title: 'T' }));
    expect(card().querySelector('[data-rooms]')).toBeNull();
  });

  describe('значок самого срочного состояния в строке заголовка (порядок прототипа)', () => {
    const ref = (id: string) => ({ projectPath: '/tmp/proj', workId: 'w-01', sessionId: id });
    const glyph = (): string | null => card().querySelector('[data-work-glyph] [data-testid="agent-state-dot"]')?.getAttribute('data-state') ?? null;
    const cases: Array<[string, Array<[string, 'blocked' | 'working' | 'unseen' | 'idle' | null]>, string | null]> = [
      ['blocked бьёт working', [['s-01', 'working'], ['s-02', 'blocked']], 'blocked'],
      ['working бьёт unseen', [['s-01', 'unseen'], ['s-02', 'working']], 'working'],
      ['unseen бьёт idle', [['s-01', 'idle'], ['s-02', 'unseen']], 'unseen'],
      ['одна живая без activity — idle', [['s-01', null]], 'idle'],
    ];
    for (const [name, states, expected] of cases) {
      it(name, () => {
        const work = makeWork('w-01', { sessions: states.map(([id]) => makeSession(id, id)) });
        const live = activityMap(states.flatMap(([id, state]) => (state === null ? [] : [makeActivity(ref(id), state)])));
        renderCard(work, { activity: live });
        expect(glyph()).toBe(expected);
      });
    }

    it('failed бьёт idle, done — последним; pending — «не запущена»', () => {
      renderCard(makeWork('w-01', { sessions: [makeSession('s-01', 'a'), makeSession('s-02', 'b', { result: 'failed' })] }));
      expect(glyph()).toBe('failed');
      cleanup();
      renderCard(makeWork('w-01', { sessions: [makeSession('s-01', 'a', { result: 'done' })] }));
      expect(glyph()).toBe('done');
      cleanup();
      renderCard(makeWork('w-01', { sessions: [makeSession('s-01', 'a', { lifecycle: 'pending' })] }));
      expect(glyph()).toBe('pending');
    });

    it('закрытые сессии значок не задают; без живых — пустое место 12px', () => {
      renderCard(makeWork('w-01', { sessions: [makeSession('s-01', 'a', { lifecycle: 'closed' })] }));
      expect(glyph()).toBeNull();
      expect(card().querySelector('[data-work-glyph]')?.className).toMatch(/\bw-3\b/);
    });

    it('в работе ждёт решение (Room.proposal) — значок вопроса, даже если срочнее нечего; у старой карты без proposal — как обычно', () => {
      const proposal = { id: 'p-1', from: 's-01', text: 'Решение', rev: 0, at: '2026-09-29T10:00:00.000Z' };
      const waiting = makeWork('w-01', { sessions: [makeSession('s-01', 'a')], rooms: [{ ...makeRoom('r-01', 'Возвраты'), proposal }] });
      renderCard(waiting, { activity: activityMap([makeActivity(ref('s-01'), 'working')]) });
      expect(glyph()).toBe('blocked');
      cleanup();
      const old = makeWork('w-01', { sessions: [makeSession('s-01', 'a')], rooms: [{ id: 'r-01', title: 'Старая', creator: 'human', members: [], createdAt: '2026-01-01T00:00:00.000Z' } as never] });
      renderCard(old, { activity: activityMap([makeActivity(ref('s-01'), 'working')]) });
      expect(glyph()).toBe('working');
    });
  });

  it('📌 при pinned', () => {
    renderCard(entry, { pinned: true });
    expect(screen.getByText('📌')).toBeTruthy();
    cleanup();
    renderCard(entry);
    expect(screen.queryByText('📌')).toBeNull();
  });

  it('мета: имя папки · 3 sessions · ветка моноширинным; время события', () => {
    const three = makeWork('w-01', {
      projectPath: '/Users/me/VoiceStudio',
      sessions: [makeSession('s-01', 'a'), makeSession('s-02', 'b'), makeSession('s-03', 'c')],
    });
    renderCard(three, { branch: 'main' });
    const meta = card().querySelector('[data-work-meta]');
    expect(meta?.textContent).toContain('VoiceStudio');
    expect(meta?.textContent).toContain('3 sessions');
    expect(meta?.className).toContain('pl-5');
    expect(meta?.className).toContain('text-[11px]');
    expect(screen.getByText('main').className).toContain('font-mono');
    expect(card().textContent).toContain('3m');
  });

  it('закрытые спрятаны за «2 more closed», клик раскрывает их, «Hide closed» прячет снова (и не активирует карточку)', () => {
    const onActivate = vi.fn();
    const mixed = makeWork('w-closed', {
      sessions: [
        makeSession('s-01', 'a'),
        makeSession('s-02', 'b', { lifecycle: 'closed' }),
        makeSession('s-03', 'c', { lifecycle: 'closed' }),
      ],
    });
    renderCard(mixed, { onActivate });
    expect(card().querySelectorAll('[data-session-id]')).toHaveLength(1);
    expect(card().querySelector('[data-work-meta]')?.textContent).toContain('1 session');
    const more = screen.getByText('2 more closed');
    expect(more.className).toContain('h-6');
    expect(more.className).toContain('pl-7');
    expect(more.className).toContain('text-[11px]');
    expect(more.className).toContain('rounded-full');
    fireEvent.click(more);
    expect(card().querySelectorAll('[data-session-id]')).toHaveLength(3);
    expect(screen.queryByText('2 more closed')).toBeNull();
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Hide closed'));
    expect(card().querySelectorAll('[data-session-id]')).toHaveLength(1);
    expect(screen.getByText('2 more closed')).toBeTruthy();
    expect(screen.queryByText('Hide closed')).toBeNull();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('блок строк: отступ сверху 6, зазор 1', () => {
    renderCard(makeWork('w-01', { sessions: [makeSession('s-01', 'a')] }));
    const group = card().querySelector('[role="group"]');
    expect(group?.className).toContain('mt-1.5');
    expect(group?.className).toContain('gap-px');
    expect(group?.className).toContain('flex-col');
  });

  it('строки сессий по treeOrder с отступом 12px на уровень; клик по строке — onOpenSession', () => {
    const onOpenSession = vi.fn();
    const tree = makeWork('w-01', {
      sessions: [makeSession('s-01', 'root'), makeSession('s-02', 'other'), makeSession('s-03', 'child', { parent: 's-01' })],
    });
    renderCard(tree, { onOpenSession });
    const rows = [...card().querySelectorAll<HTMLElement>('[data-session-id]')];
    expect(rows.map((element) => element.getAttribute('data-session-id'))).toEqual(['s-01', 's-03', 's-02']);
    const indent = (element: HTMLElement): number => Number.parseInt(element.style.paddingLeft, 10);
    expect(indent(rows[1] as HTMLElement) - indent(rows[0] as HTMLElement)).toBe(12);
    fireEvent.click(rows[2] as HTMLElement);
    expect(onOpenSession).toHaveBeenCalledWith('s-02');
  });

  it('клик по карточке — onActivate; у активной работы строки тащатся, выбранная помечена', () => {
    const onActivate = vi.fn();
    const two = makeWork('w-01', { sessions: [makeSession('s-01', 'a'), makeSession('s-02', 'b')] });
    renderCard(two, { onActivate, active: true, selectedSessionId: 's-02' });
    fireEvent.click(card());
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(card().getAttribute('data-active')).toBe('true');
    expect(document.querySelector('[data-session-id="s-01"]')?.hasAttribute('data-draggable')).toBe(true);
    expect(document.querySelector('[data-session-id="s-02"]')?.getAttribute('data-selected')).toBe('true');
    expect(document.querySelector('[data-session-id="s-01"]')?.getAttribute('data-selected')).toBe('false');
  });
});

describe('WorkCard — done и длинное название (тест 7)', () => {
  // Ревью M12: приглушение — data-dimmed (цвет текста и прозрачность значков, styles/dimmed.css),
  // а не opacity-60 всей карточки: та опускала текст ниже 4.5:1.
  it('status done — data-dimmed без opacity всей карточки (значки .6 — dimmed.css), активная — без приглушения', () => {
    renderCard(makeWork('w-01', { status: 'done' }));
    expect(card().hasAttribute('data-dimmed')).toBe(true);
    expect(card().getAttribute('data-dimmed')).toBe('');
    expect(card().className).not.toMatch(/opacity-/);
    cleanup();
    renderCard(makeWork('w-01'));
    expect(card().hasAttribute('data-dimmed')).toBe(false);
  });

  it('status archived (показ архивных, тест 6 куска 6.3) — приглушена, как done', () => {
    renderCard(makeWork('w-01', { status: 'archived' }));
    expect(card().hasAttribute('data-dimmed')).toBe(true);
    expect(card().className).not.toMatch(/opacity-/);
  });

  it('название из 60 эмодзи в DOM целиком, у заголовка класс truncate', () => {
    const title = '🎉'.repeat(60);
    renderCard(makeWork('w-01', { title }));
    const heading = screen.getByText(title);
    expect(heading.textContent).toBe(title);
    expect(heading.className).toContain('truncate');
  });
});

describe('WorkCard — строки S (английский интерфейс)', () => {
  it('sessionCount и moreClosed', () => {
    expect(S.sidebar.sessionCount(1)).toBe('1 session');
    expect(S.sidebar.sessionCount(3)).toBe('3 sessions');
    expect(S.sidebar.moreClosed(2)).toBe('2 more closed');
  });
});

// ---------------------------------------------------------------------------
// Кусок 3.4: переименование на месте, меню комнат, кеш строк.
// ---------------------------------------------------------------------------

describe('WorkCard — переименование на месте (тесты 3, 5)', () => {
  const entry = makeWork('w-01', { projectPath: '/tmp/proj', title: 'Redesign' });

  it('двойной клик по заголовку — поле с названием; без works.rename у хоста — поля нет (тест 5)', () => {
    renderCard(entry);
    fireEvent.doubleClick(screen.getByText('Redesign'));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Redesign');
    cleanup();

    act(() => bridge.setHostMethods(REQUIRED_METHODS.filter((method) => method !== 'works.rename')));
    renderCard(entry);
    fireEvent.doubleClick(screen.getByText('Redesign'));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('bad_request хоста — прежнее название на месте и тост (тест 3)', async () => {
    bridge.setHandler('works.rename', () => {
      throw encodeIpcError({ code: 'bad_request', message: 'плохое название' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderCard(entry);
    fireEvent.doubleClick(screen.getByText('Redesign'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Broken' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't rename workspace: invalid request."));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(screen.getByText('Redesign')).toBeTruthy();
    warn.mockRestore();
  });

  it('пункт Rename меню карточки открывает то же поле', () => {
    renderCard(entry);
    fireEvent.contextMenu(card());
    fireEvent.click(screen.getByText('Rename'));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Redesign');
  });
});

describe('WorkCard — меню комнат по # (тест 4)', () => {
  it('#N и значок # без числа открывают меню всех комнат; выбор — onOpenRoom, карточка не активируется', () => {
    const withRooms = makeWork('w-01', {
      title: 'T',
      rooms: [makeRoom('r-01', 'Design'), makeRoom('r-02', 'Backend')],
      messages: [makeLetter('m-1', { roomId: 'r-01', to: [] })],
    });
    const onOpenRoom = vi.fn();
    const onActivate = vi.fn();
    renderCard(withRooms, { attention: attention({ roomsUnread: { 'r-01': 1 } }), onOpenRoom, onActivate });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Rooms' }), { key: 'Enter' });
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Design1', 'Backend']);
    fireEvent.click(screen.getByText('Backend'));
    expect(onOpenRoom).toHaveBeenCalledWith('r-02');
    cleanup();

    const quiet = makeWork('w-01', { title: 'T', rooms: [makeRoom('r-01', 'Design')] });
    renderCard(quiet, { onOpenRoom, onActivate });
    const trigger = screen.getByRole('button', { name: 'Rooms' });
    expect(trigger.textContent).toBe('');
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(screen.getByText('Design'));
    expect(onOpenRoom).toHaveBeenLastCalledWith('r-01');
    expect(onActivate).not.toHaveBeenCalled();
  });
});

describe('WorkCard — кеш колбэков строк (решение контролёра 3)', () => {
  it('сессия ушла из карты — её колбэка в кеше нет: вернувшаяся строка получает новый', () => {
    const both = makeWork('w-01', { sessions: [makeSession('s-01', 'a'), makeSession('s-02', 'b')] });
    const one = makeWork('w-01', { sessions: [makeSession('s-01', 'a')] });
    rowProps.all = [];
    const { rerender } = renderCard(both);
    const lastOpen = (id: string): (() => void) | undefined => rowProps.all.filter((props) => props.session.id === id).at(-1)?.onOpen;
    const before = { s1: lastOpen('s-01'), s2: lastOpen('s-02') };

    const props = (entry: WorkEntry): WorkCardProps => ({
      entry,
      attention: attention(),
      activity: {},
      active: false,
      pinned: false,
      branch: null,
      now: NOW,
      selectedSessionId: null,
      onActivate: () => {},
      onOpenSession: () => {},
      onOpenMail: () => {},
      onOpenRoom: () => {},
      bridge,
    });
    rerender(<WorkCard {...props(one)} />);
    rerender(<WorkCard {...props(both)} />);

    expect(lastOpen('s-02')).not.toBe(before.s2);
    expect(lastOpen('s-01')).toBe(before.s1);
  });
});
