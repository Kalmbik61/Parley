import type { WorkEntry, WorkMap, WorkSession } from '@harnas/core';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRows } from '../work-rows.js';
import { WorkList } from './work-list.js';

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-01',
    provider: 'codex',
    label: 'бэкенд',
    task: 'реализовать шаги 1–3',
    parent: null,
    contextFrom: [],
    status: 'active',
    history: [],
    startedAt: '2026-09-02T09:12:00.000Z',
    endedAt: null,
    providerSessionId: 'uuid-1',
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    ...over,
  };
}

function entry(
  sessions: WorkSession[],
  over: Partial<WorkMap['work']> = {},
  messages: WorkMap['messages'] = [],
): WorkEntry {
  return {
    projectPath: '/home/user/dev/shop',
    map: {
      schemaVersion: 1,
      work: {
        id: 'w-0001',
        title: 'Авторизация',
        goal: 'логин по e-mail',
        status: 'active',
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-02T10:00:00.000Z',
        ...over,
      },
      sessions,
      messages,
    },
  };
}

const live = () => ({
  durationMs: 32 * 60_000,
  tokens: { input: 1_200, output: 845, cacheRead: 50_000, cacheWrite: 3_000 },
  model: 'gpt-5.2',
});

const frameOf = (node: Parameters<typeof render>[0]): string => render(node).lastFrame() ?? '';
const lineWith = (frame: string, text: string): string =>
  frame.split('\n').find((line) => line.includes(text)) ?? '';

afterEach(() => {
  delete process.env.HARNAS_ASCII;
});

describe('WorkList', () => {
  it('рисует проект, работу и двухэтажный ряд сессии', () => {
    const rows = buildRows([entry([session()])], { live });
    const frame = frameOf(<WorkList rows={rows} selected={0} height={12} width={60} />);

    expect(frame).toContain('/dev/shop');
    expect(lineWith(frame, 'Авторизация')).toContain('▾');
    expect(lineWith(frame, 'Авторизация')).toContain('●1');
    // Строка 1 — статус, label и метрики; строка 2 — провайдер и модель.
    expect(lineWith(frame, 'бэкенд')).toContain('●');
    expect(lineWith(frame, 'бэкенд')).toContain('32м');
    expect(frame).toContain('Codex GPT');
  });

  it('свёрнутая работа показывает число сессий и не показывает их самих', () => {
    const rows = buildRows([entry([session()], { title: 'Релиз', status: 'done' })], { live });
    const frame = frameOf(<WorkList rows={rows} selected={0} height={12} width={60} />);

    expect(lineWith(frame, 'Релиз')).toContain('▸');
    expect(lineWith(frame, 'Релиз')).toContain('(1)');
    expect(frame).not.toContain('бэкенд');
  });

  it('дочерняя сессия — отступом, глиф └ только с ширины 36 (вариант А, 2.4)', () => {
    const rows = buildRows(
      [entry([session(), session({ id: 's-02', label: 'ревью', parent: 's-01' })])],
      { live },
    );

    const wide = frameOf(<WorkList rows={rows} selected={0} height={12} width={40} />);
    expect(lineWith(wide, 'ревью')).toContain('└');
    expect(lineWith(wide, 'ревью').indexOf('ревью')).toBeGreaterThan(
      lineWith(wide, 'бэкенд').indexOf('бэкенд'),
    );

    const narrow = frameOf(<WorkList rows={rows} selected={0} height={12} width={30} />);
    expect(lineWith(narrow, 'ревью')).not.toContain('└');
    expect(lineWith(narrow, 'ревью').indexOf('ревью')).toBeGreaterThan(
      lineWith(narrow, 'бэкенд').indexOf('бэкенд'),
    );
  });

  it('токены появляются с ширины 36, на 30 их нет (6.3)', () => {
    const rows = buildRows([entry([session()])], { live });

    expect(frameOf(<WorkList rows={rows} selected={0} height={12} width={40} />)).toContain(
      '1.2к/845',
    );
    const narrow = frameOf(<WorkList rows={rows} selected={0} height={12} width={30} />);
    expect(narrow).not.toContain('1.2к');
    expect(narrow).toContain('32м');
  });

  it('в строке 1 длительность стоит перед токенами (макеты 2.1, 2.2, 6.6)', () => {
    const rows = buildRows([entry([session()])], { live });
    const line = lineWith(
      frameOf(<WorkList rows={rows} selected={0} height={12} width={60} />),
      'бэкенд',
    );

    expect(line.indexOf('32м')).toBeLessThan(line.indexOf('1.2к/845'));
  });

  it('непрочитанные не отбрасываются даже в узкой колонке', () => {
    const rows = buildRows(
      [
        entry([session(), session({ id: 's-02', label: 'план', provider: 'claude' })], {}, [
          {
            id: 'm-01',
            from: 's-02',
            to: 's-01',
            at: '2026-09-02T09:41:00.000Z',
            text: 'жду миграции',
            readAt: null,
          },
        ]),
      ],
      { live },
    );
    const frame = frameOf(<WorkList rows={rows} selected={0} height={12} width={30} />);
    expect(lineWith(frame, 'бэкенд')).toContain('✉1');
  });

  it('pending без модели — только провайдер, метрики прочерком (раздел 7)', () => {
    const rows = buildRows([
      entry([
        session({
          id: 's-04',
          label: 'тесты',
          provider: 'claude',
          status: 'pending',
          providerSessionId: null,
        }),
      ]),
    ]);
    const frame = frameOf(<WorkList rows={rows} selected={0} height={12} width={40} />);

    expect(lineWith(frame, 'тесты')).toContain('◌');
    expect(lineWith(frame, 'тесты')).toContain('—');
    expect(frame).toContain('Claude');
    expect(frame).not.toContain('Claude —');
  });

  it('длинный заголовок усекается, а хвост остаётся', () => {
    const rows = buildRows(
      [entry([session({ label: 'исследовать варианты переноса платежей' })])],
      {
        live,
      },
    );
    const frame = frameOf(<WorkList rows={rows} selected={0} height={12} width={30} />);
    const line = lineWith(frame, 'исследовать');

    expect(line).toContain('…');
    expect(line).toContain('32м');
    expect(line.length).toBeLessThanOrEqual(30);
  });

  it('много сессий: липкие заголовки и счётчики скрытых (6.6)', () => {
    const many = Array.from({ length: 24 }, (_, at) =>
      session({ id: `s-${at}`, label: `шаг ${at}` }),
    );
    const rows = buildRows([entry(many, { title: 'Миграция БД' })], { live });
    const frame = frameOf(<WorkList rows={rows} selected={20} height={9} width={40} />);

    expect(frame).toContain('Миграция БД');
    expect(frame).toContain('выше');
    expect(frame).toContain('шаг 20');
    expect(frame.split('\n').length).toBeLessThanOrEqual(9);
    // У липкого заголовка развёрнутой работы число сессий остаётся: сами они
    // не видны, и только по нему понятно, сколько их всего (макет 6.6).
    expect(lineWith(frame, 'Миграция БД')).toContain('(24)');
    for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(40);
  });

  it('пустая работа и работа, опустевшая от фильтра, объясняют себя (раздел 7)', () => {
    const empty = frameOf(
      <WorkList
        rows={buildRows([entry([], { title: 'Платежи' })])}
        selected={0}
        height={12}
        width={40}
      />,
    );
    expect(empty).toContain('сессий нет · n — новая');

    const filtered = frameOf(
      <WorkList
        rows={buildRows([entry([session({ provider: 'claude' })])], { filter: 'codex' })}
        selected={0}
        height={12}
        width={40}
      />,
    );
    expect(filtered).toContain('фильтр: Cx');
  });

  it('ни одна строка не вылезает за ширину колонки', () => {
    const rows = buildRows(
      [
        entry([session(), session({ id: 's-02', label: 'ревью', parent: 's-01' })], {}, [
          {
            id: 'm-01',
            from: 's-02',
            to: 's-01',
            at: '2026-09-02T09:41:00.000Z',
            text: 'жду',
            readAt: null,
          },
        ]),
      ],
      { live },
    );

    for (const width of [26, 30, 36, 41, 60]) {
      const frame = frameOf(<WorkList rows={rows} selected={1} height={12} width={width} />);
      for (const line of frame.split('\n')) {
        expect(line.length, `ширина ${width}: «${line}»`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('без работ показывает, что делать дальше', () => {
    const frame = frameOf(<WorkList rows={[]} selected={0} height={12} width={40} />);
    expect(frame).toContain('Работ нет.');
    expect(frame).toContain('N — новая работа');
    expect(frame).toContain('w — ко всем сессиям');
  });

  it('бейдж модели, совпавший с провайдером, не двоится', () => {
    const rows = buildRows([entry([session()])], {
      live: () => ({ durationMs: null, tokens: null, model: 'gpt-5.2-codex' }),
    });
    const frame = frameOf(<WorkList rows={rows} selected={0} height={12} width={40} />);
    expect(frame).toContain('Codex');
    expect(frame).not.toContain('Codex Codex');
  });

  it('HARNAS_ASCII=1 заменяет глифы', () => {
    process.env.HARNAS_ASCII = '1';
    const rows = buildRows([entry([session()])], { live });
    const frame = frameOf(<WorkList rows={rows} selected={0} height={12} width={40} />);

    expect(frame).not.toContain('▾');
    expect(frame).not.toContain('●');
    expect(lineWith(frame, 'Авторизация')).toContain('v');
    expect(lineWith(frame, 'бэкенд')).toContain('*');
  });
});
