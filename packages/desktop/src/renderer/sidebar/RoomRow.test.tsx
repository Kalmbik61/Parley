/**
 * Кусок 5 плана «Organic»: строка комнаты в карточке сайдбара (спека окна 2026-09-29, 1.2, 2.6, решения 4, 6, 7).
 * Свёрнутая — значки провайдеров со счётчиком всех агентов провайдера; развёрнутая — строки участников 26px, `★` у
 * ведущего. Фон по состоянию: решение ждёт — `accent-200`, выбрана — `text 9 %`, развёрнута — `text 4 %` (hover 6 %).
 * Развёрнутость: правило 2.6 (вкладка комнаты или участника показана в активной работе) и ручной шеврон поверх него.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Message, Proposal, Room, WorkEntry, WorkSession } from '@harnas/core';
import { refKey } from '@harnas/protocol';
import type { LayoutNode, TabSpec, WorkLayout } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { useLayoutStore } from '../layout/store.js';
import { roomKey } from '../lib/room-view.js';
import { workKey } from '../lib/tree-order.js';
import { useProvidersStore } from '../store/providers.js';
import { useUiStore } from '../store/ui.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { activityMap, makeActivity, makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { RoomRow, type RoomRowProps } from './RoomRow.js';
import { cardRows, type CardRoomRow } from './sort.js';

const PROJECT = '/tmp/proj';
const WORK = 'w-01';
const KEY = workKey(PROJECT, WORK);
const NOW = new Date('2026-09-29T10:00:00.000Z');
const BRIDGE = createFakeBridge();

const proposal: Proposal = { id: 'p-01', from: 's-01', text: 'Решение', rev: 0, at: '2026-09-29T09:58:00.000Z' };
const room = (patch: Partial<Room> = {}): Room => ({ ...makeRoom('r-01', 'Возвраты'), members: ['s-01', 's-02', 's-03', 's-04'], lead: 's-01', ...patch });
const sessions = (...ids: string[]): WorkSession[] => ids.map((id) => makeSession(id, `${id} label`));
const message = (id: string, at: string, patch: Partial<Message> = {}): Message => ({
  id,
  roomId: 'r-01',
  from: 's-02',
  to: [],
  at,
  text: 'text',
  kind: 'note',
  readBy: {},
  ...patch,
});

/** Строка комнаты из настоящего `cardRows`: тесты берут ту же форму данных, что даёт карточка. */
function roomRowOf(entry: WorkEntry, showClosed = false): CardRoomRow {
  const found = cardRows(entry.map, showClosed).find((row): row is CardRoomRow => row.kind === 'room');
  if (found === undefined) throw new Error('строки комнаты нет');
  return found;
}

interface Options extends Partial<Omit<RoomRowProps, 'row'>> {
  showClosed?: boolean;
  /** Обработчик клика предка — карточки: строка комнаты не должна отдавать ему клики шеврона и участников. */
  onParentClick?: () => void;
}

function renderRow(entry: WorkEntry, options: Options = {}) {
  const { showClosed, onParentClick, ...props } = options;
  return render(
    <div onClick={onParentClick}>
      <RoomRow
        workKey={KEY}
        projectPath={PROJECT}
        workId={WORK}
        bridge={BRIDGE}
        row={roomRowOf(entry, showClosed)}
        unread={0}
        activity={{}}
        now={NOW}
        active={false}
        selectedSessionId={null}
        onOpen={() => {}}
        openerFor={() => () => {}}
        {...props}
      />
    </div>,
  );
}

const rowEl = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('[data-room-row]');
  if (element === null) throw new Error('строки комнаты нет');
  return element;
};
const header = (): HTMLElement => rowEl().firstElementChild as HTMLElement;
const memberRows = (): HTMLElement[] => [...rowEl().querySelectorAll<HTMLElement>('[data-session-id]')];
const badges = (): HTMLElement[] => [...rowEl().querySelectorAll<HTMLElement>('[data-provider-badge]')];

// ── раскладки для правила 2.6 ─────────────────────────────────────────────────────────────────────────────────────────

const group = (id: string, tabs: TabSpec[], activeTabId: string | null): LayoutNode => ({ type: 'group', id, tabs, activeTabId });
const layoutOf = (tabs: TabSpec[], activeTabId: string | null): WorkLayout => ({ root: group('g-1', tabs, activeTabId), activeGroupId: 'g-1', closedTabs: [] });
const roomTab: TabSpec = { kind: 'room', id: 'room:r-01', roomId: 'r-01' };
const terminalTab = (sessionId: string): TabSpec => ({ kind: 'terminal', id: `terminal:${sessionId}`, sessionId });

function showLayout(layout: WorkLayout | undefined, activeWorkKey: string | null = KEY): void {
  act(() => useLayoutStore.setState({ activeWorkKey, layouts: layout === undefined ? {} : { [KEY]: layout } }));
}

beforeEach(() => {
  useUiStore.setState({ roomExpanded: {}, dark: false });
  useLayoutStore.setState({ activeWorkKey: null, layouts: {} });
  useProvidersStore.setState({
    providers: [
      { id: 'claude', label: 'Claude', available: true, version: null },
      { id: 'codex', label: 'OpenAI Codex', available: true, version: null },
    ],
  });
});
afterEach(cleanup);

/** Комната из четырёх сессий: S01 ведёт, S02 ждёт тебя, S03 не просмотрена, S04 не запущена. */
const fourAgents = (roomPatch: Partial<Room> = {}, extra: { messages?: Message[]; sessions?: WorkSession[] } = {}): WorkEntry =>
  makeWork(WORK, {
    projectPath: PROJECT,
    sessions: extra.sessions ?? sessions('s-01', 's-02', 's-03', 's-04'),
    rooms: [room(roomPatch)],
    messages: extra.messages ?? [],
  });

describe('RoomRow — свёрнутая (1.2)', () => {
  it('корень: radius 14, отступ 4 6 7 8, зазор 4, 12px; шапка 18px, зазор 6; значок вопроса — только у ждущего решения', () => {
    renderRow(fourAgents());
    expect(rowEl().className).toContain('rounded-[14px]');
    expect(rowEl().className).toMatch(/\bpt-1\b/);
    expect(rowEl().className).toMatch(/\bpr-1\.5\b/);
    expect(rowEl().className).toContain('pb-[7px]');
    expect(rowEl().className).toMatch(/\bgap-1\b/);
    expect(rowEl().className).toContain('text-xs');
    expect(rowEl().style.paddingLeft).toBe('8px');
    expect(header().className).toContain('h-[18px]');
    expect(header().className).toContain('gap-1.5');
    expect(rowEl().querySelector('[data-testid="agent-state-dot"]')).toBeNull();
  });

  it('отступ слева — 8 + 12 на уровень глубины первого участника', () => {
    const nested = makeWork(WORK, {
      projectPath: PROJECT,
      sessions: [makeSession('s-01', 'root'), makeSession('s-02', 'child', { parent: 's-01' })],
      rooms: [room({ members: ['s-02'], lead: 's-02' })],
    });
    renderRow(nested);
    expect(rowEl().style.paddingLeft).toBe('20px');
  });

  it('шапка: Hash 13px, название, шеврон в кнопке 16px (тултип «Show agents») и время последнего сообщения', () => {
    renderRow(fourAgents({}, { messages: [message('m-1', '2026-09-29T09:50:00.000Z'), message('m-2', '2026-09-29T09:57:00.000Z')] }));
    const hash = header().querySelector('svg.lucide-hash');
    expect(hash?.classList.contains('size-[13px]')).toBe(true);
    expect(header().textContent).toContain('Возвраты');
    const chevron = screen.getByRole('button', { name: S.sidebar.showAgents });
    expect(chevron.getAttribute('title')).toBe('Show agents');
    expect(chevron.className).toMatch(/\bsize-4\b/);
    expect(chevron.querySelector('svg.lucide-chevron-down')?.classList.contains('size-[13px]')).toBe(true);
    expect(chevron.querySelector('svg')?.classList.contains('-rotate-90')).toBe(true);
    // Время — последнее сообщение комнаты (3m назад), а не время создания.
    expect(header().textContent).toContain('3m');
  });

  it('значки провайдеров: строка с отступом 37 и зазором 14, значок 14 и счётчик в правом нижнем углу (left 9, top 8)', () => {
    renderRow(fourAgents());
    const strip = badges()[0]?.parentElement as HTMLElement;
    expect(strip.className).toContain('pl-[37px]');
    expect(strip.className).toContain('gap-3.5');
    expect(badges()).toHaveLength(1);
    const badge = badges()[0] as HTMLElement;
    expect(badge.className).toMatch(/\brelative\b/);
    expect(badge.className).toContain('size-[14px]');
    const count = badge.querySelector<HTMLElement>('[data-provider-count]') as HTMLElement;
    expect(count.textContent).toBe('4');
    for (const cls of ['absolute', 'left-[9px]', 'top-[8px]', 'h-3', 'min-w-3', 'rounded-full', 'bg-neutral-300', 'px-[3px]', 'text-[9px]', 'font-bold', 'leading-3']) {
      expect(count.className, cls).toContain(cls);
    }
  });

  it('счётчик — число ВСЕХ агентов провайдера в комнате, не только запущенных (решение 7); тултип — «N Claude Code agents»', () => {
    const mixed = fourAgents(
      { members: ['s-01', 's-02', 's-03', 's-04'] },
      {
        sessions: [
          makeSession('s-01', 'a'),
          makeSession('s-02', 'b', { lifecycle: 'sleeping' }),
          makeSession('s-03', 'c', { lifecycle: 'closed' }),
          makeSession('s-04', 'd', { provider: 'codex', lifecycle: 'pending' }),
        ],
      },
    );
    renderRow(mixed);
    const [claude, codex] = badges();
    expect(claude?.getAttribute('data-provider-badge')).toBe('claude');
    expect(claude?.querySelector('[data-provider-count]')?.textContent).toBe('3');
    expect(claude?.getAttribute('title')).toBe('3 Claude Code agents');
    expect(codex?.getAttribute('data-provider-badge')).toBe('codex');
    expect(codex?.querySelector('[data-provider-count]')?.textContent).toBe('1');
    expect(codex?.getAttribute('title')).toBe('1 Codex agent');
  });

  it('значок провайдера без слова рядом называет себя для скринридера (alt = тултип); провайдеры — по алфавиту, порядок записи не важен', () => {
    const entry = fourAgents({ members: ['s-01', 's-02'] }, { sessions: [makeSession('s-01', 'a', { provider: 'codex' }), makeSession('s-02', 'b')] });
    renderRow(entry);
    expect(badges().map((badge) => badge.getAttribute('data-provider-badge'))).toEqual(['claude', 'codex']);
    expect(screen.getByAltText('1 Claude Code agent')).toBeTruthy();
    expect(screen.getByAltText('1 Codex agent')).toBeTruthy();
  });

  it('неизвестный провайдер — метка хоста из providers.list, а без неё — сам id; значок — буква', () => {
    useProvidersStore.setState({ providers: [{ id: 'gemini', label: 'Gemini CLI', available: true, version: null }] });
    const entry = fourAgents({ members: ['s-01', 's-02'] }, { sessions: [makeSession('s-01', 'a', { provider: 'gemini' }), makeSession('s-02', 'b', { provider: 'mystery' })] });
    renderRow(entry);
    expect(badges().map((badge) => badge.getAttribute('title'))).toEqual(['1 Gemini CLI agent', '1 mystery agent']);
    expect(badges()[0]?.querySelector('[data-agent-icon]')?.textContent).toBe('G');
  });

  it('обводка счётчика — цвет фона карточки: у активной neutral-100, у неактивной surface (1.5px)', () => {
    renderRow(fourAgents(), { active: true });
    expect(badges()[0]?.querySelector('[data-provider-count]')?.className).toContain('shadow-[0_0_0_1.5px_var(--color-neutral-100)]');
    cleanup();
    renderRow(fourAgents(), { active: false });
    expect(badges()[0]?.querySelector('[data-provider-count]')?.className).toContain('shadow-[0_0_0_1.5px_var(--color-surface)]');
  });

  it('участников нет — полосы значков нет; строк участников у свёрнутой нет', () => {
    renderRow(fourAgents({ members: [] }));
    expect(badges()).toHaveLength(0);
    expect(memberRows()).toHaveLength(0);
  });

  it('тултип шапки: «Room · lead S01 · S01, S02, S03, S04»; комната без живых участников — без ведущего', () => {
    renderRow(fourAgents());
    expect(header().getAttribute('title')).toBe('Room · lead S01 · S01, S02, S03, S04');
    cleanup();
    const closed = fourAgents({ members: ['s-01', 's-02'] }, { sessions: [makeSession('s-01', 'a', { lifecycle: 'closed' }), makeSession('s-02', 'b', { lifecycle: 'closed' })] });
    renderRow(closed);
    expect(header().getAttribute('title')).toBe('Room · S01, S02');
  });

  it('у корня роль treeitem, aria-expanded и data-room-row; шеврон — настоящая кнопка', () => {
    renderRow(fourAgents());
    expect(rowEl().getAttribute('role')).toBe('treeitem');
    expect(rowEl().getAttribute('aria-expanded')).toBe('false');
    expect(rowEl().getAttribute('data-room-row')).toBe('r-01');
    expect(screen.getByRole('button', { name: 'Show agents' }).tagName).toBe('BUTTON');
  });

  it('пустое название — «Room»; комната старой карты без lead и proposal читается, решения нет', () => {
    const old = { id: 'r-01', title: '', creator: 'human', members: ['s-01'], createdAt: '2026-01-01T00:00:00.000Z' } as unknown as Room;
    renderRow(makeWork(WORK, { projectPath: PROJECT, sessions: sessions('s-01'), rooms: [old] }));
    expect(header().textContent).toContain(S.rooms.fallbackTitle);
    expect(header().querySelector('[data-testid="agent-state-dot"]')).toBeNull();
    expect(rowEl().className).not.toContain('bg-accent-200');
  });
});

describe('RoomRow — развёрнутая (1.2)', () => {
  const expand = (): void => useUiStore.getState().setRoomExpanded(roomKey(KEY, 'r-01'), true);

  it('строки участников 26px, как строки сессий, но с отступом слева 18 и без правого поля; значков-счётчиков нет', () => {
    expand();
    renderRow(fourAgents());
    expect(rowEl().getAttribute('aria-expanded')).toBe('true');
    const rows = memberRows();
    expect(rows.map((row) => row.getAttribute('data-session-id'))).toEqual(['s-01', 's-02', 's-03', 's-04']);
    expect(rows[0]?.className).toMatch(/\bh-\[26px\]/);
    expect(rows[0]?.style.paddingLeft).toBe('18px');
    expect(rows[0]?.className).toMatch(/\bpr-0\b/);
    expect(rows[0]?.className).not.toMatch(/\bpr-1\.5\b/);
    expect(badges()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Hide agents' }).querySelector('svg')?.classList.contains('-rotate-90')).toBe(false);
    const group = rows[0]?.parentElement as HTMLElement;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.className).toContain('mt-0.5');
    expect(group.className).toContain('gap-px');
  });

  it('★ — только у ведущего: 11px accent-700, тултип «Lead»', () => {
    expand();
    renderRow(fourAgents());
    const stars = rowEl().querySelectorAll<HTMLElement>('[data-lead]');
    expect(stars).toHaveLength(1);
    expect(stars[0]?.textContent).toBe('★');
    expect(stars[0]?.getAttribute('title')).toBe('Lead');
    expect(stars[0]?.className).toContain('text-[11px]');
    expect(stars[0]?.className).toContain('text-accent-700');
    expect(stars[0]?.closest('[data-session-id]')?.getAttribute('data-session-id')).toBe('s-01');
  });

  it('ведущий — roomLiveLead: закрытого назначенного подменяет первый живой; у старой карты без lead — первый из members', () => {
    expand();
    const closedLead = fourAgents({ lead: 's-01' }, { sessions: [makeSession('s-01', 'a', { lifecycle: 'closed' }), ...sessions('s-02', 's-03', 's-04')] });
    renderRow(closedLead, { showClosed: true });
    expect(rowEl().querySelector('[data-lead]')?.closest('[data-session-id]')?.getAttribute('data-session-id')).toBe('s-02');
    cleanup();
    renderRow(fourAgents({ lead: null, members: ['s-03', 's-02'] }));
    expect(rowEl().querySelector('[data-lead]')?.closest('[data-session-id]')?.getAttribute('data-session-id')).toBe('s-03');
    expect(header().getAttribute('title')).toContain('lead S03');
  });

  it('строка участника — обычная строка сессии: состояние, слово, клик открывает свою сессию, а не комнату', () => {
    expand();
    const onOpen = vi.fn();
    const opened: string[] = [];
    const entry = fourAgents();
    const live = activityMap([makeActivity({ projectPath: PROJECT, workId: WORK, sessionId: 's-02' }, 'blocked')]);
    renderRow(entry, { onOpen, activity: live, openerFor: (id) => () => opened.push(id) });
    const second = memberRows()[1] as HTMLElement;
    expect(second.querySelector('[data-state="blocked"]')).not.toBeNull();
    expect(second.textContent).toContain(S.states.blocked);
    fireEvent.click(second);
    expect(opened).toEqual(['s-02']);
    expect(onOpen).not.toHaveBeenCalled();
    expect(useUiStore.getState().roomExpanded[roomKey(KEY, 'r-01')]).toBe(true);
  });

  it('закрытые участники — строками только при показанных закрытых (showClosed)', () => {
    expand();
    const entry = fourAgents({}, { sessions: [...sessions('s-01', 's-02', 's-03'), makeSession('s-04', 'd', { lifecycle: 'closed' })] });
    renderRow(entry);
    expect(memberRows().map((row) => row.getAttribute('data-session-id'))).toEqual(['s-01', 's-02', 's-03']);
    cleanup();
    renderRow(entry, { showClosed: true });
    expect(memberRows().map((row) => row.getAttribute('data-session-id'))).toEqual(['s-01', 's-02', 's-03', 's-04']);
    expect(memberRows()[3]?.getAttribute('data-dimmed')).toBe('row');
  });

  it('участники тащатся только в активной работе, выбранный помечен', () => {
    expand();
    renderRow(fourAgents(), { active: true, selectedSessionId: 's-03' });
    expect(memberRows()[0]?.hasAttribute('data-draggable')).toBe(true);
    expect(memberRows()[2]?.getAttribute('data-selected')).toBe('true');
    cleanup();
    renderRow(fourAgents(), { active: false });
    expect(memberRows()[0]?.hasAttribute('data-draggable')).toBe(false);
  });
});

describe('RoomRow — фон и слово состояния (1.2)', () => {
  it('решение ждёт — accent-200 (и на hover), слово «decision» accent-800, значок вопроса, название жирное', () => {
    renderRow(fourAgents({ proposal }));
    expect(rowEl().className).toContain('bg-accent-200');
    expect(rowEl().className).toContain('hover:bg-accent-200');
    expect(rowEl().querySelector('[data-testid="agent-state-dot"]')?.getAttribute('data-state')).toBe('blocked');
    const word = screen.getByText(S.sidebar.roomDecision);
    expect(word.className).toContain('text-accent-800');
    expect(word.className).toContain('text-[11px]');
    expect(screen.getByText('Возвраты').className).toContain('font-bold');
  });

  it('непрочитанное — слово «N new» neutral-800 и жирное название; иначе слова нет, название обычное', () => {
    renderRow(fourAgents(), { unread: 3 });
    const word = screen.getByText('3 new');
    expect(word.className).toContain('text-neutral-800');
    expect(screen.getByText('Возвраты').className).toContain('font-bold');
    cleanup();
    renderRow(fourAgents());
    expect(header().textContent).not.toContain('new');
    expect(screen.getByText('Возвраты').className).not.toContain('font-bold');
    expect(screen.getByText('Возвраты').className).toContain('font-normal');
  });

  it('решение важнее непрочитанного: слово «decision», а не «N new»', () => {
    renderRow(fourAgents({ proposal }), { unread: 2 });
    expect(header().textContent).toContain('decision');
    expect(header().textContent).not.toContain('2 new');
  });

  it('выбрана — text 9 % (и на hover), название жирное; hover свёрнутой — тот же text 9 %, без заливки в покое', () => {
    showLayout(layoutOf([roomTab], roomTab.id));
    renderRow(fourAgents(), { active: true });
    expect(rowEl().getAttribute('data-selected')).toBe('true');
    expect(rowEl().className).toContain('bg-work-sidebar-accent');
    expect(rowEl().className).toContain('hover:bg-work-sidebar-accent');
    expect(screen.getByText('Возвраты').className).toContain('font-bold');
    cleanup();
    showLayout(undefined);
    renderRow(fourAgents(), { active: true });
    expect(rowEl().className).not.toMatch(/(^|\s)bg-/);
    expect(rowEl().className).toContain('hover:bg-work-sidebar-accent');
  });

  it('развёрнута — text 4 %, hover 6 %', () => {
    useUiStore.getState().setRoomExpanded(roomKey(KEY, 'r-01'), true);
    renderRow(fourAgents());
    expect(rowEl().className).toContain('bg-foreground/4');
    expect(rowEl().className).toContain('hover:bg-foreground/6');
  });

  it('решение перекрывает и «выбрана», и «развёрнута» — подкраска бьёт заливки, как у строки сессии', () => {
    showLayout(layoutOf([roomTab], roomTab.id));
    renderRow(fourAgents({ proposal }), { active: true });
    expect(rowEl().className).toContain('bg-accent-200');
    expect(rowEl().className).not.toContain('bg-work-sidebar-accent');
    expect(rowEl().className).not.toContain('bg-foreground/4');
  });

  it('свёрнутая на hover и без решения — основной цвет текста вместо вторичного (на заливке hover neutral-700 ниже 4.5:1); развёрнутая — вторичный neutral-800', () => {
    renderRow(fourAgents());
    expect(rowEl().className).toContain('hover:[--work-sidebar-muted-foreground:var(--color-text)]');
    expect(rowEl().className).toContain('hover:[--work-sidebar-foreground:var(--color-text)]');
    cleanup();
    useUiStore.getState().setRoomExpanded(roomKey(KEY, 'r-01'), true);
    renderRow(fourAgents());
    expect(rowEl().className).toContain('[--work-sidebar-muted-foreground:var(--color-neutral-800)]');
    expect(rowEl().className).not.toContain('hover:[--work-sidebar-muted-foreground');
  });

  it('вторичный текст шапки — токен сайдбара (`--work-sidebar-muted-foreground`), приглушаемый dimmed.css вместе с карточкой', () => {
    renderRow(fourAgents({}, { messages: [message('m-1', '2026-09-29T09:57:00.000Z')] }));
    const time = [...header().querySelectorAll<HTMLElement>('span')].find((span) => span.textContent === '3m');
    expect(time?.className).toContain('text-work-sidebar-muted-foreground');
    expect(time?.className).toContain('text-[10px]');
    expect(header().querySelector('svg.lucide-hash')?.getAttribute('class')).toContain('text-work-sidebar-muted-foreground');
  });
});

describe('RoomRow — правило развёртывания 2.6', () => {
  it('вкладка комнаты активна в активной работе — развёрнута и выбрана', () => {
    showLayout(layoutOf([roomTab], roomTab.id));
    renderRow(fourAgents(), { active: true });
    expect(rowEl().getAttribute('aria-expanded')).toBe('true');
    expect(rowEl().getAttribute('data-selected')).toBe('true');
    expect(memberRows()).toHaveLength(4);
  });

  it('терминал одного из участников активен — развёрнута, но не выбрана', () => {
    showLayout(layoutOf([terminalTab('s-03')], 'terminal:s-03'));
    renderRow(fourAgents(), { active: true });
    expect(rowEl().getAttribute('aria-expanded')).toBe('true');
    expect(rowEl().getAttribute('data-selected')).toBe('false');
  });

  it('открыт терминал чужой сессии или вкладка другой комнаты — свёрнута', () => {
    showLayout(layoutOf([terminalTab('s-09')], 'terminal:s-09'));
    renderRow(fourAgents(), { active: true });
    expect(rowEl().getAttribute('aria-expanded')).toBe('false');
    cleanup();
    showLayout(layoutOf([{ kind: 'room', id: 'room:r-02', roomId: 'r-02' }], 'room:r-02'));
    renderRow(fourAgents(), { active: true });
    expect(rowEl().getAttribute('aria-expanded')).toBe('false');
  });

  it('работа не активна — свёрнута, даже если в её раскладке открыта вкладка комнаты', () => {
    showLayout(layoutOf([roomTab], roomTab.id), 'другая работа');
    renderRow(fourAgents(), { active: false });
    expect(rowEl().getAttribute('aria-expanded')).toBe('false');
  });

  it('раскладки работы ещё нет (не гидрирована) — свёрнута', () => {
    showLayout(undefined);
    renderRow(fourAgents(), { active: true });
    expect(rowEl().getAttribute('aria-expanded')).toBe('false');
  });

  it('ручной шеврон перекрывает правило в обе стороны и живёт в сторе окна (в памяти)', () => {
    showLayout(layoutOf([roomTab], roomTab.id));
    renderRow(fourAgents(), { active: true });
    fireEvent.click(screen.getByRole('button', { name: 'Hide agents' }));
    expect(useUiStore.getState().roomExpanded[roomKey(KEY, 'r-01')]).toBe(false);
    expect(rowEl().getAttribute('aria-expanded')).toBe('false');
    cleanup();
    showLayout(undefined);
    renderRow(fourAgents(), { active: false });
    expect(rowEl().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Show agents' }));
    expect(rowEl().getAttribute('aria-expanded')).toBe('true');
    expect(memberRows()).toHaveLength(4);
  });

  it('шеврон не открывает комнату и не всплывает к карточке; клик по самой строке и по участнику — тоже не к карточке', () => {
    const onOpen = vi.fn();
    const onParentClick = vi.fn();
    useUiStore.getState().setRoomExpanded(roomKey(KEY, 'r-01'), false);
    renderRow(fourAgents(), { onOpen, onParentClick });
    fireEvent.click(screen.getByRole('button', { name: 'Show agents' }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onParentClick).not.toHaveBeenCalled();
    fireEvent.click(memberRows()[0] as HTMLElement);
    expect(onParentClick).not.toHaveBeenCalled();
    fireEvent.click(rowEl());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it('клик по строке открывает комнату и разворачивает её; клик по уже открытой развёрнутой — сворачивает (и всё равно открывает)', () => {
    const onOpen = vi.fn();
    renderRow(fourAgents(), { onOpen, active: true });
    fireEvent.click(rowEl());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(rowEl().getAttribute('aria-expanded')).toBe('true');
    // Строка открыта (вкладка комнаты активна) — второй клик её сворачивает.
    showLayoutAfterOpen();
    fireEvent.click(rowEl());
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(useUiStore.getState().roomExpanded[roomKey(KEY, 'r-01')]).toBe(false);
    expect(rowEl().getAttribute('aria-expanded')).toBe('false');
    // Третий — снова разворачивает: правило «выбрана и развёрнута» уже не выполнено.
    fireEvent.click(rowEl());
    expect(useUiStore.getState().roomExpanded[roomKey(KEY, 'r-01')]).toBe(true);
  });

  it('клик по развёрнутой строке, которая не выбрана (открыт терминал участника), оставляет её развёрнутой', () => {
    showLayout(layoutOf([terminalTab('s-02')], 'terminal:s-02'));
    const onOpen = vi.fn();
    renderRow(fourAgents(), { active: true, onOpen });
    expect(rowEl().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(rowEl());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().roomExpanded[roomKey(KEY, 'r-01')]).toBe(true);
  });

  it('Enter и пробел на самой строке — как клик; те же клавиши на строке участника открывают только участника', () => {
    const onOpen = vi.fn();
    const opened: string[] = [];
    useUiStore.getState().setRoomExpanded(roomKey(KEY, 'r-01'), true);
    renderRow(fourAgents(), { onOpen, openerFor: (id) => () => opened.push(id) });
    fireEvent.keyDown(rowEl(), { key: 'Enter' });
    fireEvent.keyDown(rowEl(), { key: ' ' });
    expect(onOpen).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(memberRows()[1] as HTMLElement, { key: 'Enter' });
    expect(opened).toEqual(['s-02']);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  /** «Клик открыл комнату»: вкладка комнаты стала активной в активной работе — то, что делает `AppShell`. */
  function showLayoutAfterOpen(): void {
    showLayout(layoutOf([roomTab], roomTab.id));
  }
});

describe('RoomRow — длинные значения', () => {
  it('название из 120 знаков — в DOM целиком, строка обрезает многоточием и не выталкивает шеврон и время; метка участника 40 знаков — тоже', () => {
    const title = `Return-${'R'.repeat(113)}`;
    const label = `label-${'L'.repeat(34)}`;
    useUiStore.getState().setRoomExpanded(roomKey(KEY, 'r-01'), true);
    const entry = makeWork(WORK, {
      projectPath: PROJECT,
      sessions: [makeSession('s-01', label), makeSession('s-02', 'b')],
      rooms: [{ ...room({ members: ['s-01', 's-02'], lead: 's-01' }), title }],
    });
    renderRow(entry, { unread: 12 });
    const name = screen.getByText(title);
    expect(name.textContent).toBe(title);
    expect(name.className).toContain('truncate');
    expect(name.className).toContain('min-w-0');
    expect(name.className).toContain('flex-1');
    const labelEl = screen.getByText(`S01 ${label}`);
    expect(labelEl.className).toContain('truncate');
    // Слово, шеврон и время не сжимаются: сжимается только название.
    expect(screen.getByText('12 new').className).toContain('shrink-0');
    expect(screen.getByRole('button', { name: 'Hide agents' }).className).toContain('shrink-0');
    expect(rowEl().className).toContain('min-w-0');
  });
});

describe('RoomRow — активность и время', () => {
  it('срез активности идёт строкам участников по refKey сессии', () => {
    useUiStore.getState().setRoomExpanded(roomKey(KEY, 'r-01'), true);
    const entry = fourAgents();
    const ref = { projectPath: PROJECT, workId: WORK, sessionId: 's-03' };
    const live = activityMap([makeActivity(ref, 'unseen')]);
    expect(Object.keys(live)).toEqual([refKey(ref)]);
    renderRow(entry, { activity: live });
    expect(memberRows()[2]?.querySelector('[data-state="unseen"]')).not.toBeNull();
    expect(memberRows()[0]?.querySelector('[data-state="idle"]')).not.toBeNull();
  });
});
