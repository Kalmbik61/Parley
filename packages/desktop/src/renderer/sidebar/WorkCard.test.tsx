/** Тесты 3 и 7 куска 3.3: карточка работы (спека 6.3). */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkEntry } from '@harnas/core';
import { S } from '../../shared/strings.js';
import type { WorkAttention } from '../attention/derive.js';
import { workKey } from '../lib/tree-order.js';
import { makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { WorkCard, type WorkCardProps } from './WorkCard.js';

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
    ...patch,
  };
  return render(<WorkCard {...props} />);
}

const card = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('[data-work-key]');
  if (element === null) throw new Error('карточки нет');
  return element;
};

afterEach(cleanup);

describe('WorkCard (тест 3)', () => {
  const entry = makeWork('w-01', { projectPath: '/Users/me/VoiceStudio', title: 'Редизайн окна' });

  it('на корне data-work-key', () => {
    renderCard(entry);
    expect(card().getAttribute('data-work-key')).toBe(workKey('/Users/me/VoiceStudio', 'w-01'));
  });

  it('полоса orange при needs-you, yellow при working, emerald при unseen, без полосы при idle', () => {
    const strip = (): Element | null => card().querySelector('[data-attention-strip]');
    renderCard(entry, { attention: attention({ level: 'needs-you' }) });
    expect(strip()?.className).toContain('bg-orange-500');
    cleanup();
    renderCard(entry, { attention: attention({ level: 'working' }) });
    expect(strip()?.className).toContain('bg-yellow-500');
    cleanup();
    renderCard(entry, { attention: attention({ level: 'unseen' }) });
    expect(strip()?.className).toContain('bg-emerald-500');
    cleanup();
    renderCard(entry, { attention: attention({ level: 'idle' }) });
    expect(strip()).toBeNull();
  });

  it('жирный заголовок при unseen и при письме человеку, обычный без них', () => {
    renderCard(entry, { attention: attention({ unseen: 1 }) });
    expect(screen.getByText('Редизайн окна').className).toContain('font-semibold');
    cleanup();
    renderCard(entry, { attention: attention({ humanUnread: 1 }) });
    expect(screen.getByText('Редизайн окна').className).toContain('font-semibold');
    cleanup();
    renderCard(entry);
    expect(screen.getByText('Редизайн окна').className).not.toContain('font-semibold');
  });

  it('✉2 при двух письмах, клик по нему — onOpenMail, а не onActivate', () => {
    const onOpenMail = vi.fn();
    const onActivate = vi.fn();
    renderCard(entry, { attention: attention({ humanUnread: 2 }), onOpenMail, onActivate });
    fireEvent.click(screen.getByText('✉2'));
    expect(onOpenMail).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('#1 при комнате с непрочитанным; у работы с комнатами без непрочитанного — # без числа; без комнат — ничего', () => {
    const withRooms = makeWork('w-01', { title: 'T', rooms: [makeRoom('r-01', 'one'), makeRoom('r-02', 'two')] });
    renderCard(withRooms, { attention: attention({ roomsUnread: { 'r-01': 4 } }) });
    expect(screen.getByText('#1')).toBeTruthy();
    cleanup();
    renderCard(withRooms);
    expect(screen.getByText('#')).toBeTruthy();
    cleanup();
    renderCard(makeWork('w-01', { title: 'T' }));
    expect(card().querySelector('[data-rooms]')).toBeNull();
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
    expect(screen.getByText('main').className).toContain('font-mono');
    expect(card().textContent).toContain('3m');
  });

  it('закрытые спрятаны за «+2 closed», клик раскрывает их (и не активирует карточку)', () => {
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
    fireEvent.click(screen.getByText('+2 closed'));
    expect(card().querySelectorAll('[data-session-id]')).toHaveLength(3);
    expect(screen.queryByText('+2 closed')).toBeNull();
    expect(onActivate).not.toHaveBeenCalled();
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
  it('status done — opacity-60, активная — без приглушения', () => {
    renderCard(makeWork('w-01', { status: 'done' }));
    expect(card().className).toContain('opacity-60');
    cleanup();
    renderCard(makeWork('w-01'));
    expect(card().className).not.toContain('opacity-60');
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
    expect(S.sidebar.moreClosed(2)).toBe('+2 closed');
  });
});
