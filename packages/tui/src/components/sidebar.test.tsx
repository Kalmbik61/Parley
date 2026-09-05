import type { WorkSession } from '@harnas/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import { Sidebar, sidebarWidth, type SidebarSession, type SidebarWork } from './sidebar.js';

pinUnicodeGlyphs();

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-01',
    provider: 'claude',
    label: 'план',
    task: 'разложить работу по шагам',
    parent: null,
    contextFrom: [],
    status: 'active',
    history: [],
    startedAt: '2026-09-05T09:12:00.000Z',
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: null,
    providerSessionId: 'uuid-1',
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    ...over,
  };
}

function work(over: Partial<SidebarWork> = {}): SidebarWork {
  return {
    key: '/dev/shop w-0001',
    number: 1,
    title: 'Авторизация',
    project: '~/dev/shop',
    branch: 'main',
    state: 'working',
    done: false,
    ...over,
  };
}

function item(over: Partial<SidebarSession> = {}): SidebarSession {
  return {
    session: session(),
    state: 'working',
    live: {
      durationMs: 12 * 60_000,
      tokens: { input: 1200, output: 845, cacheRead: 0, cacheWrite: 0 },
      model: null,
      lastRecordAt: null,
    },
    unread: 0,
    subagents: 0,
    ...over,
  };
}

const lines = (node: Parameters<typeof render>[0]): string[] =>
  (render(node).lastFrame() ?? '').split('\n');

const lineWith = (all: readonly string[], text: string): string =>
  all.find((line) => line.includes(text)) ?? '';

/** Колонка разделителя `│` — она же ширина содержимого сайдбара. */
const dividerAt = (line: string): number => Array.from(line).indexOf('│');

describe('Sidebar', () => {
  // Чек-лист 22.
  it('ширины 26, 18 и скрытый сайдбар считаются по ширине терминала', () => {
    expect(sidebarWidth(120, 26)).toBe(26);
    // Терминал ровно 80 колонок — сайдбар узкий (макет 1.2).
    expect(sidebarWidth(81, 26)).toBe(26);
    expect(sidebarWidth(80, 26)).toBe(18);
    expect(sidebarWidth(79, 26)).toBe(18);
    expect(sidebarWidth(60, 26)).toBe(18);
    expect(sidebarWidth(59, 26)).toBeNull();
    // Настроенная ширина уже 18 — сужать нечего.
    expect(sidebarWidth(79, 18)).toBe(18);
  });

  it('на 26 рисует номер, заголовок, проект с веткой, `new`, заголовок сессий и дерево', () => {
    const all = lines(
      <Sidebar
        works={[work(), work({ key: 'k2', number: 2, title: 'Платежи', state: null })]}
        sessions={[
          item(),
          item({ session: session({ id: 's-02', label: 'ревью', parent: 's-01' }) }),
        ]}
        selectedWork="/dev/shop w-0001"
        selectedSession="s-01"
        width={26}
        height={14}
      />,
    );

    expect(lineWith(all, 'Авторизация')).toContain('1 Авторизация');
    expect(lineWith(all, 'Авторизация')).toContain('●');
    expect(lineWith(all, '~/dev/shop')).toContain('~/dev/shop · main');
    expect(lineWith(all, 'new')).toContain(' new');
    expect(lineWith(all, 'сессии ·')).toContain('сессии · Авторизация');
    expect(lineWith(all, 'план')).toContain('working');
    // Дочерняя сессия — отступом и глифом `└` (макет 1.1).
    expect(lineWith(all, 'ревью')).toContain('└ ●');

    // Каждая строка сайдбара кончается разделителем на 27-й колонке.
    for (const line of all) expect(dividerAt(line)).toBe(26);
  });

  it('у работы без сессий точка не рисуется (решение №6)', () => {
    const all = lines(
      <Sidebar
        works={[work({ state: null })]}
        sessions={[]}
        selectedWork="/dev/shop w-0001"
        selectedSession={null}
        width={26}
        height={10}
      />,
    );

    expect(lineWith(all, 'Авторизация')).not.toContain('●');
    expect(lineWith(all, 'сессий нет')).toContain('сессий нет');
  });

  it('done-работа занимает одну строку без проекта (решение №4)', () => {
    const all = lines(
      <Sidebar
        works={[work({ title: 'Релиз 1.2', done: true, state: 'done' })]}
        sessions={[]}
        selectedWork={null}
        selectedSession={null}
        width={26}
        height={10}
      />,
    );

    expect(lineWith(all, 'Релиз 1.2')).toContain('✓');
    expect(all.some((line) => line.includes('~/dev/shop'))).toBe(false);
  });

  // Чек-лист 23.
  it('слово состояния не отбрасывается, ярлык режется до 4 знаков', () => {
    const long = 'исследовать варианты миграции платёжного провайдера';
    const all = lines(
      <Sidebar
        works={[work({ title: 'Перенос платёжного провайдера на новый шлюз' })]}
        sessions={[item({ session: session({ label: long }), state: 'idle' })]}
        selectedWork="/dev/shop w-0001"
        selectedSession={null}
        width={26}
        height={10}
      />,
    );

    const row = lineWith(all, 'idle');
    expect(row).toContain('idle');
    expect(row).toContain('…');
    expect(row).toContain('иссле');
    expect(dividerAt(row)).toBe(26);

    const title = lineWith(all, 'Перенос');
    expect(title).toContain('…');
    expect(dividerAt(title)).toBe(26);
  });

  // Чек-лист 26.
  it('компактная строка под выбранной сессией: токены, длительность, ▤N и ⋮N', () => {
    const all = lines(
      <Sidebar
        works={[work()]}
        sessions={[
          item({ unread: 2, subagents: 1 }),
          item({ session: session({ id: 's-02', label: 'бэкенд' }), unread: 3, subagents: 4 }),
        ]}
        selectedWork="/dev/shop w-0001"
        selectedSession="s-01"
        width={26}
        height={12}
      />,
    );

    // Счётчики не отбрасываются никогда, токены — первыми (§7).
    const compact = lineWith(all, '▤2');
    expect(compact).toContain('12м');
    expect(compact).toContain('▤2');
    expect(compact).toContain('⋮1');
    expect(dividerAt(compact)).toBe(26);

    // Под невыбранной сессией счётчиков нет (макет §5).
    expect(all.some((line) => line.includes('⋮4'))).toBe(false);
  });

  it('в компактной строке помещаются токены, длительность и ⋮N (макет 1.1)', () => {
    const all = lines(
      <Sidebar
        works={[work()]}
        sessions={[item({ subagents: 1 })]}
        selectedWork="/dev/shop w-0001"
        selectedSession="s-01"
        width={26}
        height={10}
      />,
    );

    expect(lineWith(all, '↑')).toContain('↑1.2к ↓845 · 12м · ⋮1');
  });

  it('у pending-сессии компактной строки нет (решение №7)', () => {
    const all = lines(
      <Sidebar
        works={[work()]}
        sessions={[
          item({
            session: session({ status: 'pending', label: 'доки' }),
            state: 'pending',
            unread: 1,
          }),
        ]}
        selectedWork="/dev/shop w-0001"
        selectedSession="s-01"
        width={26}
        height={10}
      />,
    );

    expect(lineWith(all, 'доки')).toContain('pending');
    expect(all.some((line) => line.includes('▤1'))).toBe(false);
  });

  it('сессия без метрик показывает `—` вместо чисел', () => {
    const all = lines(
      <Sidebar
        works={[work()]}
        sessions={[
          item({
            session: session({ label: 'разведка' }),
            live: { durationMs: null, tokens: null, model: null, lastRecordAt: null },
          }),
        ]}
        selectedWork="/dev/shop w-0001"
        selectedSession="s-01"
        width={26}
        height={10}
      />,
    );

    expect(lineWith(all, '—')).toContain('—');
  });

  // Чек-лист 22, вторая половина: на 18 вторых строк работ нет, слово — буквой.
  it('на 18 отброшены вторая строка работы и токены, слово заменено буквой', () => {
    const all = lines(
      <Sidebar
        works={[work()]}
        sessions={[
          item({ unread: 1, subagents: 1 }),
          item({
            session: session({ id: 's-02', label: 'тесты', status: 'exited' }),
            state: 'exited',
          }),
        ]}
        selectedWork="/dev/shop w-0001"
        selectedSession="s-01"
        width={18}
        height={12}
      />,
    );

    expect(all.some((line) => line.includes('~/dev/shop'))).toBe(false);
    const row = lineWith(all, 'план');
    expect(row).not.toContain('working');
    expect(row).toContain('w');
    // Жизненный цикл различим глифом — буквы у него нет (макет 1.2).
    expect(lineWith(all, 'тесты')).not.toContain('exited');

    const compact = lineWith(all, '12м');
    expect(compact).not.toContain('↑');
    expect(compact).toContain('▤1');
    expect(compact).toContain('⋮1');

    for (const line of all) expect(dividerAt(line)).toBe(18);
  });

  it('работ нет — верх сайдбара из двух строк', () => {
    const all = lines(
      <Sidebar
        works={[]}
        sessions={[]}
        selectedWork={null}
        selectedSession={null}
        width={26}
        height={8}
      />,
    );

    expect(lineWith(all, 'работ нет')).toContain('работ нет');
    expect(lineWith(all, 'первая')).toContain('new — первая сессия');
  });

  it('длинный список сессий сворачивается в окно с липким заголовком', () => {
    const sessions = Array.from({ length: 20 }, (_, at) =>
      item({
        session: session({ id: `s-${at}`, label: `шаг ${at}` }),
        state: at === 19 ? 'working' : 'idle',
      }),
    );
    const all = lines(
      <Sidebar
        works={[work()]}
        sessions={sessions}
        selectedWork="/dev/shop w-0001"
        selectedSession="s-19"
        width={26}
        height={12}
      />,
    );

    expect(lineWith(all, 'сессии ·')).toContain('сессии · Авторизация');
    expect(lineWith(all, 'выше')).toMatch(/… \d+ выше/);
    expect(lineWith(all, 'шаг 19')).toContain('шаг 19');
  });
});
