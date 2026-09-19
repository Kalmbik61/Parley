import type { SessionIndex, WorkEntry, WorkSession } from '@harnas/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import { glyphs } from '../glyphs.js';
import {
  branchOf,
  frameLine,
  Sidebar,
  sidebarCursorRows,
  SidebarOverlay,
  sidebarTargets,
  sidebarWidth,
  stepCursor,
  type SidebarSession,
  type SidebarWork,
} from './sidebar.js';

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

/** Строка-грань блока (план рамок, задача 3): начинается с верхнего или нижнего угла. */
const isFrameLine = (line: string): boolean => {
  const g = glyphs();
  return line.startsWith(g.frame.topLeft) || line.startsWith(g.frame.bottomLeft);
};

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

    // Каждая обычная строка сайдбара кончается разделителем на 27-й колонке;
    // строки-грани (план рамок, задача 3) разделителя не несут — своя граница.
    for (const line of all) if (!isFrameLine(line)) expect(dividerAt(line)).toBe(26);
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

  // Чек-лист 23, нижняя граница: места нет вовсе, а ярлык всё равно 4 знака.
  it('на экстремально узкой строке ярлык — 4 знака, буква состояния на месте', () => {
    const all = lines(
      <Sidebar
        works={[work()]}
        sessions={[item({ session: session({ label: 'исследовать миграции' }), state: 'blocked' })]}
        selectedWork="/dev/shop w-0001"
        selectedSession="s-01"
        width={9}
        height={8}
      />,
    );

    const row = lineWith(all, 'исс');
    // Три буквы и знак усечения — короче ярлык не режется (§7).
    expect(row).toContain('исс…');
    expect(row).not.toContain('иссл');
    // Буква состояния не отбрасывается никогда (макет 1.2).
    expect(row).toContain('b');
    expect(dividerAt(row)).toBe(9);
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

    for (const line of all) if (!isFrameLine(line)) expect(dividerAt(line)).toBe(18);
  });

  // Кнопка выше подсказки, а подсказка — своей строкой (план рамок, задача 4).
  it('работ нет — кнопка, за ней «работ нет» и подсказка отдельной строкой', () => {
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

    expect(lineWith(all, '+ new')).toContain('+ new');
    expect(lineWith(all, 'работ нет')).toContain('работ нет');
    expect(lineWith(all, 'первая сессия')).toContain('первая сессия');
    // Длинная подсказка больше не спрятана внутри кнопки.
    expect(lineWith(all, '+ new')).not.toContain('первая сессия');
  });

  // Макет 1.3: место разделителя занимает рамка оверлея, а не знак усечения.
  // Высота 10, а не 8: две дополнительные грани блока работ (план рамок, задача 3)
  // отъедают чистых 2 строки бюджета — без запаса единственная сессия сама
  // попала бы в окно с «… N ниже», что тут ни при чём.
  it('в оверлее строки кончаются рамкой без своего разделителя и без «…»', () => {
    const all = lines(
      <SidebarOverlay
        works={[work()]}
        sessions={[item()]}
        selectedWork="/dev/shop w-0001"
        selectedSession="s-01"
        width={26}
        height={10}
      />,
    );

    const body = all.filter((line) => line.startsWith('│'));
    expect(body.length).toBeGreaterThan(0);
    for (const line of body) {
      expect(Array.from(line)).toHaveLength(28);
      expect(line.endsWith('│')).toBe(true);
      expect(line.slice(0, -1)).not.toContain('…');
    }
    // Точка работы стоит на своём месте и рамкой не съедена (макет 1.1).
    expect(lineWith(all, 'Авторизация')).toContain('●');
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

describe('frameLine', () => {
  it('верхняя грань занимает всю ширину и несёт заголовок', () => {
    const line = frameLine({ title: 'работы', width: 26, g: glyphs(), top: true });
    expect(line).toHaveLength(26);
    expect(line.startsWith('╭─ работы ')).toBe(true);
    expect(line.endsWith('╮')).toBe(true);
  });

  it('заголовок длиннее ширины усекается', () => {
    const line = frameLine({
      title: 'сессии · ОченьДлинноеНазваниеРаботы',
      width: 18,
      g: glyphs(),
      top: true,
    });
    expect(line).toHaveLength(18);
    expect(line).toContain(glyphs().ellipsis);
  });

  it('нижняя грань без заголовка', () => {
    expect(frameLine({ title: null, width: 26, g: glyphs(), top: false })).toBe(
      `╰${'─'.repeat(24)}╯`,
    );
  });

  // Заголовок впритык к ширине занимал место пробела и упирался в угол.
  it('усечённый заголовок сохраняет пробел перед углом', () => {
    const line = frameLine({ title: 'сессии · Авторизация', width: 18, g: glyphs(), top: true });
    expect(line).toHaveLength(18);
    expect(line.endsWith(' ╮')).toBe(true);
  });

  it('без места под подпись грань остаётся глухой', () => {
    expect(frameLine({ title: 'работы', width: 5, g: glyphs(), top: true })).toBe(
      `╭${'─'.repeat(3)}╮`,
    );
  });
});

// layout() собирает сайдбар двумя блоками с гранями (план рамок, задача 3).
describe('Sidebar блоки с гранями', () => {
  const twoWorks = [work(), work({ key: 'k2', number: 2, title: 'Платежи' })];

  it('строки граней не ломают соответствие строки и цели клика', () => {
    const props = {
      works: twoWorks,
      sessions: [item()],
      selectedWork: '/dev/shop w-0001',
      selectedSession: 's-01',
      width: 26,
      height: 14,
    };
    const targets = sidebarTargets(props);
    const all = lines(<Sidebar {...props} />);

    // Грань — там, где цели нет.
    expect(targets[0]).toBeNull();
    expect(all[0]).toContain('╭');
    // Цель строки работы совпадает с её номером сверху.
    const at = all.findIndex((line) => line.includes('Авторизация'));
    expect(targets[at]).toEqual({ kind: 'work', key: '/dev/shop w-0001' });
  });

  it('высота сайдбара остаётся ровно height при разных значениях', () => {
    const base = {
      works: twoWorks,
      sessions: [item()],
      selectedWork: '/dev/shop w-0001',
      selectedSession: 's-01',
      width: 26,
    };
    expect(sidebarTargets({ ...base, height: 24 })).toHaveLength(24);
    expect(sidebarTargets({ ...base, height: 14 })).toHaveLength(14);
    expect(sidebarTargets({ ...base, height: 10 })).toHaveLength(10);
  });

  // Четыре грани не влезают в высоту меньше четырёх, а `prefix b` на терминале
  // в 5–7 строк открывает оверлей ровно с `height` 3 (`app.tsx:259`). Строк
  // должно остаться ровно столько, сколько места: на длине массива стоит клик.
  it('на вырожденной высоте раскладка не перерастает отведённое место', () => {
    const base = {
      works: [work()],
      sessions: [],
      selectedWork: '/dev/shop w-0001',
      selectedSession: null,
      width: 26,
    };
    for (const height of [0, 1, 2, 3, 4, 5]) {
      expect(sidebarTargets({ ...base, height })).toHaveLength(height);
    }
  });

  it('оба блока собраны гранью-верхом с заголовком, гранью-низом и без старой линейки', () => {
    const all = lines(
      <Sidebar
        works={[work()]}
        sessions={[item()]}
        selectedWork="/dev/shop w-0001"
        selectedSession="s-01"
        width={26}
        height={14}
      />,
    );

    const frames = all.filter(isFrameLine);
    // Две грани у блока работ, две — у блока сессий (§3, инвариант 3).
    expect(frames).toHaveLength(4);
    expect(frames[0]).toContain('работы');
    expect(frames[2]).toContain('сессии · Авторизация');
    // Нижние грани заголовка не несут.
    expect(frames[1]).not.toContain('работы');
    expect(frames[3]).not.toContain('сессии');
    // Старая отдельная строка-линейка `────…` (без заголовка, вне грани) исчезла.
    expect(all.some((line) => line === glyphs().rule.repeat(26))).toBe(false);
  });

  it('грани блоков разделителя не несут — у обычных строк он остаётся', () => {
    const all = lines(
      <Sidebar
        works={[work()]}
        sessions={[item()]}
        selectedWork="/dev/shop w-0001"
        selectedSession="s-01"
        width={26}
        height={14}
      />,
    );

    const frames = all.filter(isFrameLine);
    expect(frames).toHaveLength(4);
    for (const line of frames) expect(dividerAt(line)).toBe(-1);
    for (const line of all.filter((line) => !isFrameLine(line))) expect(dividerAt(line)).toBe(26);
  });
});

// Кнопка `new` наверху блока работ (план рамок, задача 4).
describe('Кнопка new вверху блока работ', () => {
  it('кнопка стоит первой строкой блока работ, до самих работ', () => {
    const all = lines(
      <Sidebar
        works={[work(), work({ key: 'k2', number: 2, title: 'Платежи' })]}
        sessions={[item()]}
        selectedWork="/dev/shop w-0001"
        selectedSession="s-01"
        width={26}
        height={14}
      />,
    );

    const button = all.findIndex((line) => line.includes('+ new'));
    const firstWork = all.findIndex((line) => line.includes('Авторизация'));
    expect(button).toBeGreaterThanOrEqual(0);
    expect(button).toBeLessThan(firstWork);
  });

  it('текст кнопки короткий, остальная ширина строки — обычная добивка пробелами', () => {
    const all = lines(
      <Sidebar
        works={[work()]}
        sessions={[item()]}
        selectedWork="/dev/shop w-0001"
        selectedSession="s-01"
        width={26}
        height={12}
      />,
    );

    const row = lineWith(all, '+ new');
    const before = row.slice(0, dividerAt(row));
    // Плашка не растянута на всю ширину: перед разделителем — только текст
    // кнопки и пустая добивка, а не всякий заполненный фон (план рамок, задача 4).
    expect(before.trim()).toBe('+ new');
    expect(before).toHaveLength(26);
  });

  // Без работ подсказка «первая сессия» не влезла бы в компактную плашку —
  // остаётся отдельной строкой под кнопкой (план рамок, задача 4).
  it('без работ кнопка и подсказка — разные строки', () => {
    const all = lines(
      <Sidebar
        works={[]}
        sessions={[]}
        selectedWork={null}
        selectedSession={null}
        width={18}
        height={8}
      />,
    );

    expect(lineWith(all, '+ new')).not.toContain('первая сессия');
    expect(all.some((line) => line.includes('первая сессия'))).toBe(true);
  });
});

describe('branchOf', () => {
  const entry = (sessions: WorkSession[]): WorkEntry => ({
    projectPath: '/dev/shop',
    map: {
      schemaVersion: 1,
      work: {
        id: 'w-0001',
        title: 'Авторизация',
        goal: '',
        status: 'active',
        createdAt: '2026-09-05T09:00:00.000Z',
        updatedAt: '2026-09-05T09:00:00.000Z',
      },
      sessions,
      messages: [],
    },
  });

  const logged = (): SessionIndex => ({ gitBranch: 'feat/pay' }) as SessionIndex;

  it('лог провайдера важнее `.git/HEAD`', () => {
    expect(branchOf(entry([session()]), logged, () => 'main')).toBe('feat/pay');
  });

  it('у работы без лога ветка берётся из `.git/HEAD` проекта', () => {
    expect(
      branchOf(
        entry([session()]),
        () => undefined,
        () => 'main',
      ),
    ).toBe('main');
  });

  it('ни лога, ни репозитория — ветки нет', () => {
    expect(
      branchOf(
        entry([]),
        () => undefined,
        () => null,
      ),
    ).toBeNull();
  });
});

// Дефект приёмки: строка `new` и строки работ были недостижимы с клавиатуры.
describe('sidebarCursorRows', () => {
  const rows = (): ReturnType<typeof sidebarCursorRows> =>
    sidebarCursorRows([work(), work({ key: 'k2', number: 2, title: 'Платежи' })], ['s-01', 's-02']);

  it('курсор ходит по работам, строке new и сессиям выбранной работы (3.2)', () => {
    expect(rows().map((row) => `${row.kind} ${row.key}`)).toEqual([
      'work /dev/shop w-0001',
      'work k2',
      'new ',
      'session s-01',
      'session s-02',
    ]);
  });

  it('пять j с первой работы доходят до new и до сессий и замыкают круг', () => {
    const all = rows();
    let cursor = all[0] ?? null;
    const visited = [];
    for (let step = 0; step < 5; step++) {
      cursor = stepCursor(all, cursor, 1);
      visited.push(cursor === null ? '—' : `${cursor.kind} ${cursor.key}`);
    }

    expect(visited).toEqual([
      'work k2',
      'new ',
      'session s-01',
      'session s-02',
      'work /dev/shop w-0001',
    ]);
  });

  it('k ходит в обратную сторону, а забытый курсор начинает сверху', () => {
    const all = rows();
    expect(stepCursor(all, all[0] ?? null, -1)).toEqual({ kind: 'session', key: 's-02' });
    // Работа, на которой стоял курсор, закончилась — начинаем с первой строки.
    expect(stepCursor(all, { kind: 'work', key: 'пропала' }, 1)).toEqual(all[0]);
    expect(stepCursor([], null, 1)).toBeNull();
  });
});

describe('Sidebar курсор навигации', () => {
  it('строка new под курсором подсвечена, как выбранные строки (макет 1.5)', () => {
    const all = lines(
      <Sidebar
        works={[work()]}
        sessions={[item()]}
        selectedWork="/dev/shop w-0001"
        selectedSession="s-01"
        cursor={{ kind: 'new', key: '' }}
        width={26}
        height={10}
      />,
    );

    // Курсор виден только цветом, и сама подсветка проверяется там, где цвета
    // включены (`sidebar-selection.test.tsx`); здесь — что раскладка не поехала.
    expect(lineWith(all, 'new')).toContain(' new');
    expect(lineWith(all, 'план')).toContain('working');
  });
});
