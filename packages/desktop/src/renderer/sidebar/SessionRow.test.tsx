/**
 * Тесты 4, 11, 12, 13 куска 3.3: строка сессии карточки. Тест 12 переехал сюда из
 * тестов прежнего дерева сессий (контракт перетаскивания 2.6), удалённого в 3.5.
 *
 * Облик Organic (спека окна 2026-09-29, 1.2): пилюля 26px, отступ слева 8 + 12 на уровень, зазор 6,
 * 12px; значок состояния 12, значок агента 13, слово состояния 11px строчными, ветка своего worktree —
 * значок GitBranch 11, время 10px шириной 22. Подкраска: `blocked` — `accent-200` (слово `accent-800`),
 * `unseen` — `accent-2-200` (слово `accent-2-800`), выбранная и hover — `text 9%`; закрытая — .5 при
 * правиле `dimmed.css`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { Activity, WorkSession } from '@parley/core';
import type { HostNotice, LiveMetrics, LiveTask } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { formatMetricsLine } from '../lib/metrics-line.js';
import { workKey } from '../lib/tree-order.js';
import { useNoticesStore } from '../store/notices.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeActivity, makeSession } from '../test-utils/work-fixtures.js';
import { SessionRow } from './SessionRow.js';

// «Открыть» строку поповера агентов — переход окна (`chat/open-agent.ts`, свой тест): здесь важно лишь, что строка зовёт его.
const openAgentCard = vi.hoisted(() => vi.fn());
vi.mock('../chat/open-agent.js', () => ({ openAgentCard }));

const PROJECT = '/tmp/proj';
const WORK = 'w-01';
const KEY = workKey(PROJECT, WORK);
const NOW = new Date('2026-09-27T10:00:00.000Z');
const BRIDGE = createFakeBridge();

function renderRow(
  session: WorkSession,
  options: {
    activity?: Activity | null;
    /** Время последнего события активности; по умолчанию 09:57. `null` — событий ещё не было. */
    lastEventAt?: string | null;
    draggable?: boolean;
    selected?: boolean;
    onOpen?: () => void;
  } = {},
) {
  const built =
    options.activity === undefined || options.activity === null
      ? null
      : makeActivity({ projectPath: PROJECT, workId: WORK, sessionId: session.id }, options.activity, {
          lastEventAt: options.lastEventAt ?? '2026-09-27T09:57:00.000Z',
        });
  const activity =
    built !== null && options.lastEventAt === null
      ? { ...built, activity: { ...built.activity, lastEventAt: null } }
      : built;
  return render(
    <SessionRow
      workKey={KEY}
      projectPath={PROJECT}
      workId={WORK}
      bridge={BRIDGE}
      session={session}
      depth={0}
      activity={activity}
      now={NOW}
      draggable={options.draggable ?? true}
      selected={options.selected ?? false}
      onOpen={options.onOpen ?? (() => {})}
    />,
  );
}

const row = (id = 's-01'): HTMLElement => {
  const element = document.querySelector<HTMLElement>(`[data-session-id="${id}"]`);
  if (element === null) throw new Error(`строки ${id} нет`);
  return element;
};

beforeEach(() => useNoticesStore.setState({ notices: [] }));
afterEach(cleanup);

describe('SessionRow — девять состояний таблицы 4.2 (тест 4)', () => {
  const cases: Array<{ name: string; session: WorkSession; activity: Activity | null; state: string; lifecycle?: string; word: string }> = [
    { name: 'работает', session: makeSession('s-01', 'a'), activity: 'working', state: 'working', word: S.states.working },
    { name: 'ждёт тебя', session: makeSession('s-01', 'a'), activity: 'blocked', state: 'blocked', word: S.states.blocked },
    { name: 'не просмотрено', session: makeSession('s-01', 'a'), activity: 'unseen', state: 'unseen', word: S.states.unseen },
    { name: 'простаивает', session: makeSession('s-01', 'a'), activity: null, state: 'idle', word: S.states.idle },
    { name: 'ожидает запуска', session: makeSession('s-01', 'a', { lifecycle: 'pending' }), activity: null, state: 'pending', word: S.states.pending },
    { name: 'спит', session: makeSession('s-01', 'a', { lifecycle: 'sleeping' }), activity: null, state: 'exited', lifecycle: 'sleeping', word: S.states.asleep },
    { name: 'закрыта', session: makeSession('s-01', 'a', { lifecycle: 'closed' }), activity: null, state: 'exited', lifecycle: 'closed', word: S.states.closed },
    { name: 'готово', session: makeSession('s-01', 'a', { result: 'done' }), activity: null, state: 'done', word: S.states.done },
    { name: 'сбой', session: makeSession('s-01', 'a', { result: 'failed' }), activity: null, state: 'failed', word: S.states.failed },
  ];

  for (const c of cases) {
    it(`${c.name}: значок ${c.state} и слово «${c.word}»`, () => {
      renderRow(c.session, { activity: c.activity });
      const dot = row().querySelector('[data-testid="agent-state-dot"]');
      expect(dot?.getAttribute('data-state')).toBe(c.state);
      if (c.lifecycle !== undefined) expect(dot?.getAttribute('data-lifecycle')).toBe(c.lifecycle);
      expect(row().textContent).toContain(c.word);
    });
  }

  it('девять пар (значок, слово) различны', () => {
    const pairs = new Set(cases.map((c) => `${c.state}/${c.lifecycle ?? ''}/${c.word}`));
    expect(pairs.size).toBe(9);
  });

  // Ревью M12: закрытая строка приглушена data-dimmed (styles/dimmed.css), а не opacity-50 —
  // та опускала текст строки ниже 4.5:1. Значение `row` — значки .5 (у done-карточки .6).
  it('закрытая строка — data-dimmed="row" без opacity, открытая — без приглушения', () => {
    renderRow(makeSession('s-01', 'a', { lifecycle: 'closed' }));
    expect(row().hasAttribute('data-dimmed')).toBe(true);
    expect(row().getAttribute('data-dimmed')).toBe('row');
    expect(row().className).not.toMatch(/opacity-/);
    cleanup();
    renderRow(makeSession('s-01', 'a'));
    expect(row().hasAttribute('data-dimmed')).toBe(false);
  });

  it('GitBranch 11px только у сессии со своим worktree, тултип «Own worktree · ветка»', () => {
    renderRow(makeSession('s-01', 'a'));
    expect(row().querySelector('[data-worktree]')).toBeNull();
    cleanup();
    renderRow(makeSession('s-01', 'a', { worktree: { path: '/tmp/wt', branch: 'harnas/s-01', base: 'main', createdAt: null } }));
    const branch = row().querySelector('[data-worktree]');
    expect(branch?.getAttribute('title')).toBe('Own worktree · harnas/s-01');
    expect(branch?.querySelector('svg.lucide-git-branch')?.classList.contains('size-[11px]')).toBe(true);
    expect(row().textContent).not.toContain('⎇');
  });

  it('подкраска: needs-you — accent-200 (слово accent-800), unseen — accent-2-200 (слово accent-2-800), у работающей — нет; на строке data-session-id', () => {
    renderRow(makeSession('s-01', 'a'), { activity: 'blocked' });
    expect(row().className).toContain('bg-accent-200');
    expect(row().className).toContain('hover:bg-accent-200');
    expect(row().className).not.toContain('amber');
    expect(screen.getByText(S.states.blocked).className).toContain('text-accent-800');
    cleanup();
    renderRow(makeSession('s-01', 'a'), { activity: 'unseen' });
    expect(row().className).toContain('bg-accent-2-200');
    expect(row().className).toContain('hover:bg-accent-2-200');
    expect(screen.getByText(S.states.unseen).className).toContain('text-accent-2-800');
    cleanup();
    renderRow(makeSession('s-01', 'a'), { activity: 'working' });
    expect(row().className).not.toMatch(/bg-accent(-2)?-200/);
    expect(screen.getByText(S.states.working).className).toContain('text-work-sidebar-muted-foreground');
    expect(row().getAttribute('data-session-id')).toBe('s-01');
  });

  it('пилюля 26px, 12px, зазор 6; выбранная и hover — text 9%, выбранная — вес 700; подкраска бьёт выбранную', () => {
    renderRow(makeSession('s-01', 'исполнитель'));
    expect(row().className).toMatch(/\bh-\[26px\]/);
    expect(row().className).toMatch(/\brounded-full\b/);
    expect(row().className).toMatch(/\bgap-1\.5\b/);
    expect(row().className).toMatch(/\btext-xs\b/);
    expect(row().className).toContain('hover:bg-work-sidebar-accent');
    expect(screen.getByText('S01 исполнитель').className).not.toContain('font-bold');
    cleanup();
    renderRow(makeSession('s-01', 'исполнитель'), { selected: true });
    expect(row().className).toMatch(/\bbg-work-sidebar-accent\b/);
    expect(screen.getByText('S01 исполнитель').className).toContain('font-bold');
    cleanup();
    renderRow(makeSession('s-01', 'исполнитель'), { selected: true, activity: 'blocked' });
    expect(row().className).toContain('bg-accent-200');
    expect(row().className).not.toMatch(/\bbg-work-sidebar-accent\b/);
  });

  // Правки ревью куска 2: в приглушённом поддереве (done-карточка, закрытая строка) основной цвет сайдбара уже
  // равен вторичному, поэтому подмена «вторичный := основной» на hover ничего не меняла и текст оставался
  // `neutral-700` на заливке hover (3.86:1 в светлой). Строка на hover задаёт оба цвета явно — основным текстом.
  // Закрытая строка несёт `data-dimmed` сама: там неслойное правило `dimmed.css` бьёт утилиту по основному
  // цвету, и он сводится к вторичному, а вторичный на hover — основной текст (цепочка без петли).
  it('hover: основной и вторичный цвет строки — явно --color-text (в приглушённом поддереве подмена одной другой не работает)', () => {
    renderRow(makeSession('s-01', 'a'));
    expect(row().className).toContain('hover:[--work-sidebar-foreground:var(--color-text)]');
    expect(row().className).toContain('hover:[--work-sidebar-muted-foreground:var(--color-text)]');
    expect(row().className).not.toContain('hover:[--work-sidebar-muted-foreground:var(--work-sidebar-foreground)]');
  });

  it('значок состояния 12, значок агента 13, время 10px шириной 22, слово 11px', () => {
    renderRow(makeSession('s-01', 'a'), { activity: 'working' });
    expect(row().querySelector('[data-testid="agent-state-dot"]')?.classList.contains('size-3')).toBe(true);
    expect(row().querySelector('img')?.getAttribute('width')).toBe('13');
    const time = screen.getByText('3m');
    expect(time.className).toContain('w-[22px]');
    expect(time.className).toContain('text-[10px]');
    expect(time.className).toContain('text-right');
    expect(screen.getByText(S.states.working).className).toContain('text-[11px]');
  });

  it('отступ слева — 8 + 12 на уровень', () => {
    render(
      <SessionRow workKey={KEY} projectPath={PROJECT} workId={WORK} bridge={BRIDGE} session={makeSession('s-02', 'b')} depth={2} activity={null} now={NOW} draggable selected={false} onOpen={() => {}} />,
    );
    expect(row('s-02').style.paddingLeft).toBe('32px');
    cleanup();
    renderRow(makeSession('s-01', 'a'));
    expect(row('s-01').style.paddingLeft).toBe('8px');
  });

  it('длинная метка (40 знаков) не выталкивает слово и время: метка сжимается многоточием', () => {
    const label = 'я'.repeat(40);
    renderRow(makeSession('s-01', label), { activity: 'working' });
    const name = screen.getByText(`S01 ${label}`);
    expect(name.className).toContain('min-w-0');
    expect(name.className).toContain('flex-1');
    expect(name.className).toContain('truncate');
    expect(screen.getByText(S.states.working).className).toContain('shrink-0');
    expect(screen.getByText('3m').className).toContain('shrink-0');
  });

  it('подпись S01 и время последнего события; клик зовёт onOpen', () => {
    const onOpen = vi.fn();
    renderRow(makeSession('s-01', 'исполнитель'), { activity: 'working', onOpen });
    expect(row().textContent).toContain('S01 исполнитель');
    expect(row().textContent).toContain('3m');
    fireEvent.click(row());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

// Кусок 5 плана «Organic», спека окна 2026-09-29, 1.2: участник развёрнутой комнаты — та же строка, но с отступом слева
// 18 и без правого поля (его даёт строка комнаты), а у ведущего после названия `★`.
describe('SessionRow — участник комнаты (кусок 5)', () => {
  const inRoom = (session: WorkSession, lead: boolean) =>
    render(
      <SessionRow workKey={KEY} projectPath={PROJECT} workId={WORK} bridge={BRIDGE} session={session} depth={3} activity={null} now={NOW} draggable selected={false} onOpen={() => {}} inRoom lead={lead} />,
    );

  it('отступ слева 18 (глубина не в счёт), правое поле 0; обычная строка держит 8 + 12·depth и 6', () => {
    inRoom(makeSession('s-01', 'a'), false);
    expect(row().style.paddingLeft).toBe('18px');
    expect(row().className).toMatch(/\bpr-0\b/);
    expect(row().className).not.toMatch(/\bpr-1\.5\b/);
    expect(row().className).toMatch(/\bh-\[26px\]/);
    cleanup();
    renderRow(makeSession('s-01', 'a'));
    expect(row().style.paddingLeft).toBe('8px');
    expect(row().className).toMatch(/\bpr-1\.5\b/);
  });

  it('★ у ведущего: после названия и перед словом состояния, 11px, accent-700, тултип «Lead»; у прочих её нет', () => {
    inRoom(makeSession('s-01', 'исполнитель'), true);
    const star = row().querySelector<HTMLElement>('[data-lead]') as HTMLElement;
    expect(star.textContent).toBe('★');
    expect(star.getAttribute('title')).toBe('Lead');
    expect(star.className).toContain('text-[11px]');
    expect(star.className).toContain('text-accent-700');
    expect(star.className).toContain('shrink-0');
    const label = screen.getByText('S01 исполнитель');
    expect(label.compareDocumentPosition(star) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(star.compareDocumentPosition(screen.getByText(S.states.idle)) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    cleanup();
    inRoom(makeSession('s-01', 'исполнитель'), false);
    expect(row().querySelector('[data-lead]')).toBeNull();
  });

  it('обычная строка сессии звезды не знает: lead без комнаты не рисуется, если его не просили', () => {
    renderRow(makeSession('s-01', 'a'));
    expect(row().querySelector('[data-lead]')).toBeNull();
  });
});

describe('SessionRow — пометка trust-wait (тест 11)', () => {
  it('host.notice trust-wait по ref строки — ⚠ с тултипом; у строки другой сессии пометки нет', () => {
    const notice: HostNotice = {
      kind: 'trust-wait',
      text: 'молчит',
      ref: { projectPath: PROJECT, workId: WORK, sessionId: 's-01' },
    } as HostNotice;
    useNoticesStore.setState({ notices: [notice] });

    renderRow(makeSession('s-01', 'a'));
    renderRow(makeSession('s-02', 'b'));
    expect(row('s-01').querySelector(`[title="${S.sidebar.trustWaitTooltip}"]`)?.textContent).toBe('⚠');
    expect(row('s-02').querySelector(`[title="${S.sidebar.trustWaitTooltip}"]`)).toBeNull();
  });
});

describe('SessionRow — пометка startup-wait (Codex на экране старта)', () => {
  it('host.notice startup-wait по ref строки — ⚠ со своим тултипом про вход и доверие; у другой сессии нет', () => {
    const notice: HostNotice = {
      kind: 'startup-wait',
      text: 'ждёт входа',
      ref: { projectPath: PROJECT, workId: WORK, sessionId: 's-01' },
    } as HostNotice;
    useNoticesStore.setState({ notices: [notice] });

    renderRow(makeSession('s-01', 'a'));
    renderRow(makeSession('s-02', 'b'));
    expect(row('s-01').querySelector(`[title="${S.sidebar.startupWaitTooltip}"]`)?.textContent).toBe('⚠');
    expect(row('s-01').querySelector(`[title="${S.sidebar.trustWaitTooltip}"]`)).toBeNull();
    expect(row('s-02').querySelector(`[title="${S.sidebar.startupWaitTooltip}"]`)).toBeNull();
  });

  it('тултип на английском, без кириллицы', () => {
    expect(S.sidebar.startupWaitTooltip).not.toMatch(/[а-яё]/i);
  });

  const startupNotice = (at: string): HostNotice =>
    ({
      kind: 'startup-wait',
      text: 'ждёт входа',
      ref: { projectPath: PROJECT, workId: WORK, sessionId: 's-01' },
      at,
    }) as HostNotice;
  const mark = (): Element | null => row('s-01').querySelector(`[title="${S.sidebar.startupWaitTooltip}"]`);

  it('Codex дошёл до Ready или Working после уведомления — ⚠ снимается, хотя уведомление ещё в буфере', () => {
    // Хост знает состояние Codex: известный сигнал позже уведомления (у него время синтетического «нужен ты»)
    // значит, что экран старта пройден. Подсказка «may need sign-in» рядом с работающей сессией — ложная.
    useNoticesStore.setState({ notices: [startupNotice('2026-09-27T09:50:00.000Z')] });
    renderRow(makeSession('s-01', 'a'), { activity: 'working' });
    expect(mark()).toBeNull();
    cleanup();
    renderRow(makeSession('s-01', 'a'), { activity: 'idle' });
    expect(mark()).toBeNull();
  });

  it('сессия всё ещё на экране старта — ⚠ стоит: последнее событие — то самое «нужен ты» со временем уведомления', () => {
    const at = '2026-09-27T09:57:00.000Z';
    useNoticesStore.setState({ notices: [startupNotice(at)] });
    renderRow(makeSession('s-01', 'a'), { activity: 'blocked', lastEventAt: at });
    expect(mark()?.textContent).toBe('⚠');
  });

  it('уведомление свежее последнего события или у уведомления нет времени — ⚠ стоит', () => {
    useNoticesStore.setState({ notices: [startupNotice('2026-09-27T09:58:00.000Z')] });
    renderRow(makeSession('s-01', 'a'), { activity: 'blocked' });
    expect(mark()?.textContent).toBe('⚠');
    cleanup();

    useNoticesStore.setState({ notices: [{ ...startupNotice(''), at: undefined } as unknown as HostNotice] });
    renderRow(makeSession('s-01', 'a'), { activity: 'working' });
    expect(mark()?.textContent).toBe('⚠');
  });

  it('событий у сессии ещё нет (`lastEventAt` — null) — ⚠ стоит', () => {
    useNoticesStore.setState({ notices: [startupNotice('2026-09-27T09:50:00.000Z')] });
    renderRow(makeSession('s-01', 'a'), { activity: 'idle', lastEventAt: null });
    expect(mark()?.textContent).toBe('⚠');
  });

  it('trust-wait состояния не знает — снимается, как и раньше, только уходом уведомления из буфера', () => {
    const notice = {
      kind: 'trust-wait',
      text: 'молчит',
      ref: { projectPath: PROJECT, workId: WORK, sessionId: 's-01' },
      at: '2026-09-27T09:50:00.000Z',
    } as HostNotice;
    useNoticesStore.setState({ notices: [notice] });
    renderRow(makeSession('s-01', 'a'), { activity: 'working' });
    expect(row('s-01').querySelector(`[title="${S.sidebar.trustWaitTooltip}"]`)?.textContent).toBe('⚠');
  });
});

describe('SessionRow — контракт перетаскивания (тест 12)', () => {
  it('у строки неактивной работы нет data-draggable и курсор not-allowed, у активной — есть; HTML5 draggable нет; у выбранной — data-selected', () => {
    renderRow(makeSession('s-01', 'a'), { draggable: false });
    expect(row().hasAttribute('data-draggable')).toBe(false);
    expect(row().className).toContain('cursor-not-allowed');
    expect(row().getAttribute('draggable')).toBeNull();
    expect(row().getAttribute('data-selected')).toBe('false');
    cleanup();

    renderRow(makeSession('s-01', 'a'), { draggable: true, selected: true });
    expect(row().hasAttribute('data-draggable')).toBe(true);
    expect(row().className).not.toContain('cursor-not-allowed');
    expect(row().getAttribute('draggable')).toBeNull();
    expect(row().getAttribute('data-selected')).toBe('true');
  });
});

describe('SessionRow — тултип (тест 13)', () => {
  it('задача (первые 300 символов), summary, слово итога, модель и строка метрик', async () => {
    const task = 'x'.repeat(320);
    const session = makeSession('s-01', 'a', { task, summary: 'Сделал ревью', result: 'done' });
    const metrics = { tokensIn: 1200, tokensOut: 300, durationMs: 65_000, unread: 0, subagents: 0, model: 'claude-opus' };
    render(
      <SessionRow
        workKey={KEY}
        projectPath={PROJECT}
        workId={WORK}
        bridge={BRIDGE}
        session={session}
        depth={0}
        activity={makeActivity({ projectPath: PROJECT, workId: WORK, sessionId: 's-01' }, 'idle', { metrics })}
        now={NOW}
        draggable
        selected={false}
        onOpen={() => {}}
      />,
    );
    act(() => row().focus());
    const tooltip = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-session-tooltip]');
      if (element === null) throw new Error('тултипа нет');
      return element;
    });
    const text = tooltip.textContent ?? '';
    expect(text).toContain(`${'x'.repeat(300)}…`);
    expect(text).not.toContain('x'.repeat(301));
    expect(text).toContain('Сделал ревью');
    expect(text).toContain(S.states.done);
    expect(text).toContain('claude-opus');
    expect(text).toContain(formatMetricsLine(metrics));
    expect(screen.getAllByText('claude-opus').length).toBeGreaterThan(0);
  });
});

/** Как в окне: один `DndContext` с порогом 4 px (`AppShell.tsx`) и строки активной работы. */
function DndRows({ sessions }: { sessions: WorkSession[] }): JSX.Element {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  return (
    <DndContext sensors={sensors}>
      {sessions.map((session) => (
        <SessionRow
          key={session.id}
          workKey={KEY}
          projectPath={PROJECT}
          workId={WORK}
          bridge={BRIDGE}
          session={session}
          depth={0}
          activity={null}
          now={NOW}
          draggable
          selected={false}
          onOpen={() => {}}
        />
      ))}
    </DndContext>
  );
}

const tooltipText = (): string | null => document.querySelector('[data-session-tooltip]')?.textContent ?? null;
const pause = (ms: number): Promise<void> => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

describe('SessionRow — метка новой сессии (раунд исправлений 1 куска 3.3)', () => {
  it('метка-страж core даёт английский текст в строке, обычная — как была', () => {
    renderRow(makeSession('s-01', 'new session'));
    expect(row('s-01').textContent).toContain('S01 New session');
    expect(row('s-01').textContent).not.toContain('new session');
    cleanup();
    // Карта старой сборки хранит метку по-русски — строка та же.
    renderRow(makeSession('s-01', 'новая сессия'));
    expect(row('s-01').textContent).toContain('S01 New session');
    expect(row('s-01').textContent).not.toContain('новая сессия');
    cleanup();
    renderRow(makeSession('s-02', 'исполнитель'));
    expect(row('s-02').textContent).toContain('S02 исполнитель');
  });
});

// Агенту комнаты пришли письма: название сессии прежнее, рядом мигает значок письма, пока агент их не прочёл.
describe('SessionRow — значок новых писем агента', () => {
  const REF = { projectPath: PROJECT, workId: WORK, sessionId: 's-01' };
  const metricsOf = (unread: number): LiveMetrics => ({ tokensIn: 1, tokensOut: 1, durationMs: null, unread, subagents: 0, model: null });
  const rowWith = (metrics: LiveMetrics | null, session = makeSession('s-01', 'new session')): JSX.Element => (
    <SessionRow
      workKey={KEY}
      projectPath={PROJECT}
      workId={WORK}
      bridge={BRIDGE}
      session={session}
      depth={0}
      activity={makeActivity(REF, 'idle', { metrics })}
      now={NOW}
      draggable
      selected={false}
      onOpen={() => {}}
    />
  );
  const marker = (): HTMLElement | null => row().querySelector<HTMLElement>('[data-agent-unread]');

  it('unread > 0 — мигающий значок «Has new messages» после названия; название прежнее', () => {
    render(rowWith(metricsOf(2)));
    const found = marker();
    expect(found).not.toBeNull();
    expect(found?.getAttribute('title')).toBe(S.sidebar.agentUnread);
    expect(found?.getAttribute('aria-label')).toBe('Has new messages');
    expect(found?.querySelector('svg.lucide-mail')?.classList.contains('size-[11px]')).toBe(true);
    // Мигает, но не под `prefers-reduced-motion`; не сжимается — сжимается название.
    expect(found?.className).toContain('animate-pulse');
    expect(found?.className).toContain('motion-reduce:animate-none');
    expect(found?.className).toContain('shrink-0');
    expect(found?.className).toContain('text-accent-700');
    expect(screen.getByText('S01 New session').className).toContain('truncate');
    expect(row().textContent).not.toContain('New messages');
  });

  it('писем нет, метрик ещё нет — значка нет', () => {
    render(rowWith(metricsOf(0)));
    expect(marker()).toBeNull();
    cleanup();
    render(rowWith(null));
    expect(marker()).toBeNull();
  });

  it('агент прочёл письма — значок ушёл, название то же', () => {
    const view = render(rowWith(metricsOf(1), makeSession('s-01', 'ревьюер')));
    expect(marker()).not.toBeNull();
    view.rerender(rowWith(metricsOf(0), makeSession('s-01', 'ревьюер')));
    expect(marker()).toBeNull();
    expect(row().textContent).toContain('S01 ревьюер');
  });

  it('спящей и ожидающей запуска письма ждут — значок есть; закрытой не доставляются — значка нет', () => {
    for (const lifecycle of ['sleeping', 'pending'] as const) {
      render(rowWith(metricsOf(1), makeSession('s-01', 'a', { lifecycle })));
      expect(marker(), lifecycle).not.toBeNull();
      cleanup();
    }
    render(rowWith(metricsOf(1), makeSession('s-01', 'a', { lifecycle: 'closed' })));
    expect(marker()).toBeNull();
  });

  it('участник развёрнутой комнаты — та же строка, тот же значок', () => {
    render(
      <SessionRow
        workKey={KEY}
        projectPath={PROJECT}
        workId={WORK}
        bridge={BRIDGE}
        session={makeSession('s-01', 'new session')}
        depth={0}
        activity={makeActivity(REF, 'working', { metrics: metricsOf(1) })}
        now={NOW}
        draggable
        selected={false}
        onOpen={() => {}}
        inRoom
      />,
    );
    expect(marker()).not.toBeNull();
  });
});

describe('SessionRow — тултип и перетаскивание (раунд исправлений 1 куска 3.3, ревью B)', () => {
  it('во время перетаскивания тултип закрыт, после броска у перетащенной не открывается, наведение на соседнюю — её задача', async () => {
    render(<DndRows sessions={[makeSession('s-02', 'implementer', { task: 'implementer task' }), makeSession('s-03', 'reviewer', { task: 'reviewer task' })]} />);
    const s03 = row('s-03');

    // Браузер фокусирует строку (tabIndex=0) по pointerdown — Radix открывает тултип по фокусу.
    act(() => s03.focus());
    await waitFor(() => expect(tooltipText()).toContain('reviewer task'));

    fireEvent.pointerDown(s03, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 30, clientY: 10 });
    await pause(0);
    expect(tooltipText()).toBeNull();
    expect(document.activeElement).not.toBe(s03);

    fireEvent.pointerUp(document, { isPrimary: true, clientX: 30, clientY: 10 });
    await pause(700);
    expect(tooltipText()).toBeNull();

    // jsdom не считает :hover, а тултип открывается только под указателем (раунд исправлений 2).
    const s02 = row('s-02');
    const matches = Element.prototype.matches;
    const hover = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':hover' ? this === s02 : matches.call(this, selector);
    });
    fireEvent.pointerEnter(s02, { pointerType: 'mouse' });
    await waitFor(() => expect(tooltipText()).toContain('implementer task'));
    hover.mockRestore();
    expect(tooltipText()).not.toContain('reviewer task');
    expect(document.querySelectorAll('[data-session-tooltip]')).toHaveLength(1);
  });
});

describe('SessionRow — таймер открытия тултипа и перетаскивание (раунд исправлений 2 куска 3.3)', () => {
  // jsdom не считает :hover — строка «под указателем» задаётся тестом.
  let hovered: Element | null = null;
  beforeEach(() => {
    hovered = null;
    const original = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':hover' ? this === hovered : original.call(this, selector);
    });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const advance = (ms: number): void => act(() => void vi.advanceTimersByTime(ms));
  const enter = (element: HTMLElement): void => {
    hovered = element;
    fireEvent.pointerEnter(element, { pointerType: 'mouse' });
  };

  it('таймер наведения S03, запущенный до порога перетаскивания, не открывает её тултип поверх S02', () => {
    render(<DndRows sessions={[makeSession('s-02', 'implementer', { task: 'implementer task' }), makeSession('s-03', 'reviewer', { task: 'reviewer task' })]} />);
    const s03 = row('s-03');

    enter(s03);
    advance(200);
    fireEvent.pointerDown(s03, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document, { isPrimary: true, clientX: 10, clientY: 40 });
    advance(100);
    // pointerleave у S03 в окне не приходит (захват указателя @dnd-kit) — здесь его тоже нет.
    fireEvent.pointerUp(document, { isPrimary: true, clientX: 10, clientY: 40 });
    enter(row('s-02'));

    advance(300); // таймер S03 истёк (600 мс от её наведения)
    expect(tooltipText()).toBeNull();
    advance(300); // таймер S02
    expect(tooltipText()).toContain('implementer task');
    expect(tooltipText()).not.toContain('reviewer task');
    expect(document.querySelectorAll('[data-session-tooltip]')).toHaveLength(1);
  });

  it('обычное наведение без перетаскивания открывает свой тултип после openDelay', () => {
    render(<DndRows sessions={[makeSession('s-02', 'implementer', { task: 'implementer task' }), makeSession('s-03', 'reviewer', { task: 'reviewer task' })]} />);
    enter(row('s-03'));
    advance(599);
    expect(tooltipText()).toBeNull();
    advance(1);
    expect(tooltipText()).toContain('reviewer task');
  });
});

describe('SessionRow — меню строки (кусок 3.4)', () => {
  it('правая кнопка открывает меню строки; клики в меню и в подтверждении — не клик по строке', () => {
    const onOpen = vi.fn();
    renderRow(makeSession('s-01', 'plan'), { onOpen });
    fireEvent.contextMenu(row());
    expect(screen.getByText('Open to the side')).toBeTruthy();
    fireEvent.click(screen.getByText('Stop'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.contextMenu(row());
    fireEvent.click(screen.getByText('Open'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

// Кусок 4b плана 2026-10-01 (решение 13): живые субагенты — бейдж «N agents» с поповером в самой строке сессии вместо `▤N`.
describe('SessionRow — бейдж агентов (кусок 4b)', () => {
  const REF = { projectPath: PROJECT, workId: WORK, sessionId: 's-01' };
  const task = (id: string, extra: Partial<LiveTask> = {}): LiveTask => ({
    id,
    agentType: 'Explore',
    description: `Task ${id}`,
    background: true,
    ...extra,
  });
  const metricsOf = (extra: Partial<LiveMetrics>): LiveMetrics => ({
    tokensIn: 1200,
    tokensOut: 300,
    durationMs: 65_000,
    unread: 0,
    subagents: 0,
    model: null,
    ...extra,
  });
  const rowWith = (metrics: LiveMetrics | null, session = makeSession('s-01', 'agent row'), onOpen: () => void = () => {}): JSX.Element => (
    <SessionRow
      workKey={KEY}
      projectPath={PROJECT}
      workId={WORK}
      bridge={BRIDGE}
      session={session}
      depth={0}
      activity={makeActivity(REF, 'working', { metrics })}
      now={NOW}
      draggable
      selected={false}
      onOpen={onOpen}
    />
  );
  const renderWith = (metrics: LiveMetrics | null, session = makeSession('s-01', 'agent row'), onOpen: () => void = () => {}) =>
    render(rowWith(metrics, session, onOpen));
  const badge = (): HTMLElement | null => row().querySelector<HTMLElement>('[data-testid="agents-badge"]');
  const tooltipText = (): string | null => document.querySelector('[data-session-tooltip]')?.textContent ?? null;

  beforeEach(() => openAgentCard.mockClear());

  it('есть metrics.tasks — бейдж «2 agents» в строке между названием и словом состояния; без них — бейджа нет', () => {
    renderWith(metricsOf({ subagents: 2, tasks: [task('a'), task('b')] }));
    expect(badge()?.textContent).toBe('2 agents');
    expect(row().textContent).toContain('S01 agent row2 agentsworking');
    cleanup();
    renderWith(metricsOf({ subagents: 0, tasks: [] }));
    expect(badge()).toBeNull();
    cleanup();
    renderWith(null);
    expect(badge()).toBeNull();
  });

  it('в строке метрик тултипа ▤N нет, когда бейдж его заменил; хост без поля tasks — бейджа нет, а ▤N в тултипе как был', async () => {
    renderWith(metricsOf({ subagents: 2, tasks: [task('a'), task('b')] }));
    act(() => row().focus());
    await waitFor(() => expect(tooltipText()).not.toBeNull());
    expect(tooltipText()).not.toContain('▤');
    cleanup();

    const old = metricsOf({ subagents: 2 });
    renderWith(old);
    expect(badge()).toBeNull();
    act(() => row().focus());
    await waitFor(() => expect(tooltipText()).toContain(formatMetricsLine(old)));
    expect(tooltipText()).toContain('▤2');
  });

  it('спящая и закрытая сессия: метрики прошлого процесса бейджа не дают', () => {
    for (const lifecycle of ['sleeping', 'closed'] as const) {
      renderWith(metricsOf({ subagents: 1, tasks: [task('a')] }), makeSession('s-01', 'a', { lifecycle }));
      expect(badge(), lifecycle).toBeNull();
      cleanup();
    }
  });

  it('поповер: тип, описание и «background» по каждому агенту; строка зовёт openAgentCard со ссылкой на сессию и id агента', () => {
    const onOpen = vi.fn();
    renderWith(
      metricsOf({
        subagents: 2,
        tasks: [task('agent-1', { description: 'Look around' }), task('agent-2', { agentType: 'Plan', description: 'Plan it', background: false })],
      }),
      makeSession('s-01', 'agent row'),
      onOpen,
    );
    fireEvent.click(badge()!);
    const rows = screen.getAllByTestId('agents-popover-row');
    expect(rows.map((item) => item.textContent)).toEqual(['ExplorebackgroundLook around', 'PlanPlan it']);
    fireEvent.click(rows[1]!);
    expect(openAgentCard).toHaveBeenCalledTimes(1);
    expect(openAgentCard).toHaveBeenCalledWith(REF, 'agent-2');
    // Строка поповера — не клик по строке сессии: она ведёт на карточку агента сама.
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByTestId('agents-popover')).toBeNull();
  });

  it('клик по бейджу и Enter на нём строку сессии не открывают', () => {
    const onOpen = vi.fn();
    renderWith(metricsOf({ subagents: 1, tasks: [task('a')] }), makeSession('s-01', 'agent row'), onOpen);
    fireEvent.click(badge()!);
    fireEvent.keyDown(badge()!, { key: 'Enter' });
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByTestId('agents-popover')).toBeTruthy();
  });

  it('пока поповер открыт, тултип строки скрыт; закрылся поповер — тултип снова может открыться', async () => {
    renderWith(metricsOf({ subagents: 1, tasks: [task('a')] }));
    act(() => row().focus());
    await waitFor(() => expect(tooltipText()).not.toBeNull());
    fireEvent.click(badge()!);
    await waitFor(() => expect(tooltipText()).toBeNull());
    expect(within(document.body).getByTestId('agents-popover')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('agents-popover'), { key: 'Escape' });
    await waitFor(() => expect(tooltipText()).not.toBeNull());
  });

  it('последний агент закончил при открытом поповере — бейдж ушёл, и тултип строки снова открывается', async () => {
    const view = renderWith(metricsOf({ subagents: 1, tasks: [task('a')] }));
    fireEvent.click(badge()!);
    expect(screen.getByTestId('agents-popover')).toBeTruthy();
    view.rerender(rowWith(metricsOf({ subagents: 0, tasks: [] })));
    expect(badge()).toBeNull();
    expect(screen.queryByTestId('agents-popover')).toBeNull();
    act(() => row().focus());
    await waitFor(() => expect(tooltipText()).not.toBeNull());
  });

  it('бейдж — в порядке Tab только у строки под курсором сайдбара (roving tabindex): у остальных -1', () => {
    renderWith(metricsOf({ subagents: 1, tasks: [task('a')] }));
    // Курсор сайдбара на этой строке не стоит — и бейдж из порядка Tab выпал вместе с ней.
    expect(row().getAttribute('tabindex')).toBe('-1');
    expect(badge()?.getAttribute('tabindex')).toBe('-1');
  });

  it('пилюля бейджа: высота 18px, текст 10px, строка её не сжимает', () => {
    renderWith(metricsOf({ subagents: 1, tasks: [task('a')] }));
    expect(badge()?.className).toContain('h-[18px]');
    expect(badge()?.className).toContain('shrink-0');
    expect(badge()?.className).toContain('text-[10px]');
  });
});
