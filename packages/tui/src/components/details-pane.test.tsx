import type { Message, Subsession, WorkEntry, WorkSession } from '@harnas/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import { buildRows, type LiveMetrics, type WorkRow } from '../work-rows.js';
import { DetailsPane } from './details-pane.js';

const NOW = Date.parse('2026-09-02T15:00:00.000Z');
const clock = (iso: string): string => new Date(iso).toTimeString().slice(0, 5);

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-02',
    provider: 'codex',
    label: 'бэкенд',
    task: 'Реализовать шаги 1–3 плана',
    parent: null,
    contextFrom: [],
    status: 'active',
    history: [
      { status: 'pending', at: '2026-09-02T09:12:00.000Z' },
      { status: 'active', at: '2026-09-02T09:14:00.000Z' },
    ],
    startedAt: '2026-09-02T09:14:00.000Z',
    endedAt: null,
    providerSessionId: 'uuid-2',
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    ...over,
  };
}

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'm-01',
    from: 's-01',
    to: 's-02',
    at: '2026-09-02T09:41:00.000Z',
    text: 'жду миграции',
    readAt: null,
    ...over,
  };
}

const sender = (): WorkSession =>
  session({ id: 's-01', label: 'план', provider: 'claude', status: 'done' });

function entry(sessions: WorkSession[], messages: Message[]): WorkEntry {
  return {
    projectPath: '/home/user/dev/shop',
    map: {
      schemaVersion: 1,
      work: {
        id: 'w-0001',
        title: 'Авторизация',
        goal: 'логин по e-mail, сессии, миграции',
        status: 'active',
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-02T10:00:00.000Z',
      },
      sessions,
      messages,
    },
  };
}

const live = (over: Partial<LiveMetrics> = {}): LiveMetrics => ({
  durationMs: 32 * 60_000,
  tokens: { input: 1_200, output: 845, cacheRead: 50_000, cacheWrite: 3_000 },
  model: 'gpt-5.2',
  lastRecordAt: null,
  ...over,
});

/** Ряд выбранной сессии: нулевой ряд — сама работа, дальше её сессии. */
function rowsOf(
  sessions: WorkSession[],
  messages: Message[] = [],
  metrics: LiveMetrics = live(),
): WorkRow[] {
  return buildRows([entry(sessions, messages)], { live: () => metrics });
}

function subsession(over: Partial<Subsession> = {}): Subsession {
  return {
    agentId: 'a-1',
    file: '/logs/a-1.jsonl',
    workflowRunId: null,
    agentType: 'explore',
    name: null,
    task: 'explore repo',
    taskSource: 'meta',
    toolUseId: null,
    models: ['claude-opus-4-1'],
    startedAt: '2026-09-02T09:20:00.000Z',
    endedAt: '2026-09-02T09:24:00.000Z',
    durationMs: 4 * 60_000,
    records: 10,
    ...over,
  };
}

interface PaneOptions {
  width?: number;
  height?: number;
  selected?: number;
  subsessions?: Subsession[];
}

function paneOf(row: WorkRow | undefined, options: PaneOptions = {}): string {
  const { width = 60, height = 40, selected = 0, subsessions = [] } = options;
  const { lastFrame } = render(
    <DetailsPane
      row={row}
      width={width}
      height={height}
      selected={selected}
      subsessions={subsessions}
      now={NOW}
    />,
  );
  return lastFrame() ?? '';
}

const lineWith = (frame: string, text: string): string =>
  frame.split('\n').find((line) => line.includes(text)) ?? '';

pinUnicodeGlyphs();

describe('DetailsPane — секции', () => {
  it('широкая колонка: провайдер, модель и секции в фиксированном порядке (дизайн 3)', () => {
    const frame = paneOf(rowsOf([session()])[1]);

    expect(frame).toContain('Codex GPT');
    const order = [
      'ЗАДАЧА',
      'СТАТУС',
      'ТОКЕНЫ',
      'СВОДКА',
      'ВХОДЯЩИЕ',
      'АРТЕФ.',
      'СУБАГ.',
      'ИСТОРИЯ',
    ];
    const positions = order.map((label) => frame.indexOf(label));
    expect(positions.filter((at) => at < 0)).toEqual([]);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('узкая колонка: компактная раскладка без ярлыков секций (макет 2.1)', () => {
    const frame = paneOf(rowsOf([session()])[1], {
      width: 26,
      subsessions: [subsession(), subsession({ agentId: 'a-2', file: '/logs/a-2.jsonl' })],
    });

    expect(frame).not.toContain('ЗАДАЧА');
    expect(frame).not.toContain('СУБАГ.');
    // Артефакты и субагенты на этой ширине — одной строкой (макет 2.1).
    expect(frame).toContain('арт: — · суб: 2');
    expect(lineWith(frame, 'ист:')).toContain('→');
    // Задача и статус видны и здесь — просто без ярлыков.
    expect(frame).toContain('Реализовать');
    expect(lineWith(frame, 'active')).toContain('32м');
  });

  it('ТОКЕНЫ: четыре счётчика на широкой, кэш одной парой на узкой (6.3)', () => {
    const wide = paneOf(rowsOf([session()])[1]);
    expect(lineWith(wide, 'ТОКЕНЫ')).toContain('↑1.2к ↓845');
    expect(lineWith(wide, 'ТОКЕНЫ')).toContain('кэш чт 50к зп 3.0к');

    const narrow = paneOf(rowsOf([session()])[1], { width: 26 });
    expect(lineWith(narrow, '↑1.2к')).toContain('⇄50к/3.0к');
  });

  it('ТОКЕНЫ: прочерк, пока сессия не привязана к логам (раздел 7)', () => {
    const frame = paneOf(rowsOf([session()], [], live({ tokens: null, durationMs: null }))[1]);
    expect(lineWith(frame, 'ТОКЕНЫ')).toContain('—');
    expect(lineWith(frame, 'ТОКЕНЫ')).not.toContain('↑');
    expect(lineWith(frame, 'СТАТУС')).toContain('—');
  });
});

describe('DetailsPane — СТАТУС', () => {
  it('idle показывает, сколько молчит лог (правило 3)', () => {
    const row = rowsOf(
      [session({ status: 'idle' })],
      [],
      live({ lastRecordAt: new Date(NOW - 14 * 60_000).toISOString() }),
    )[1];

    expect(lineWith(paneOf(row), 'СТАТУС')).toContain('молчит 14м');
  });

  it('active про молчание не пишет', () => {
    const row = rowsOf(
      [session()],
      [],
      live({ lastRecordAt: new Date(NOW - 14 * 60_000).toISOString() }),
    )[1];

    expect(paneOf(row)).not.toContain('молчит');
  });

  it('exited: время выхода и код (правило 3, решение №11)', () => {
    const row = rowsOf([
      session({
        status: 'exited',
        history: [
          { status: 'active', at: '2026-09-02T13:10:00.000Z' },
          { status: 'exited', at: '2026-09-02T14:02:00.000Z', exitCode: 0 },
        ],
      }),
    ])[1];

    const line = lineWith(paneOf(row), 'СТАТУС');
    expect(line).toContain('exited');
    expect(line).toContain(clock('2026-09-02T14:02:00.000Z'));
    expect(line).toContain('код 0');
  });

  it('снятый сигналом процесс — «сигнал 9», а не код', () => {
    const row = rowsOf([
      session({
        status: 'failed',
        history: [{ status: 'failed', at: '2026-09-02T14:02:00.000Z', exitCode: 137, signal: 9 }],
      }),
    ])[1];

    const line = lineWith(paneOf(row), 'СТАТУС');
    expect(line).toContain('сигнал 9');
    expect(line).not.toContain('код 137');
  });
});

describe('DetailsPane — СВОДКА', () => {
  const summaryLine = (over: Partial<WorkSession>): string =>
    lineWith(paneOf(rowsOf([session(over)])[1]), 'СВОДКА');

  it('незавершённый отчёт агента помечен как progress', () => {
    const line = summaryLine({ summary: 'миграции готовы', summarySource: 'agent' });
    expect(line).toContain('progress:');
    expect(line).toContain('миграции готовы');
  });

  it('финальный отчёт идёт без пометки', () => {
    const line = summaryLine({ status: 'done', summary: 'план готов', summarySource: 'agent' });
    expect(line).toContain('план готов');
    expect(line).not.toContain('progress');
    expect(line).not.toContain('авто');
  });

  it('дозаказанное резюме помечено как авто', () => {
    expect(
      summaryLine({ status: 'exited', summary: 'вышел на середине', summarySource: 'auto' }),
    ).toContain('авто:');
  });

  it('отчёта нет: у exited добавляется подсказка про s', () => {
    expect(summaryLine({ status: 'exited' })).toContain('(отчёта нет — s дозаказать)');
    const active = summaryLine({});
    expect(active).toContain('(отчёта нет)');
    expect(active).not.toContain('дозаказать');
  });
});

describe('DetailsPane — ВХОДЯЩИЕ', () => {
  it('непрочитанные первыми, прочитанных не больше пяти, исходящих нет (решение №10)', () => {
    const read = Array.from({ length: 6 }, (_, at) =>
      message({
        id: `m-r${at}`,
        at: `2026-09-02T10:0${at}:00.000Z`,
        text: `прочитано ${at}`,
        readAt: '2026-09-02T11:00:00.000Z',
      }),
    );
    const messages: Message[] = [
      ...read,
      message({ id: 'm-out', from: 's-02', to: 's-01', text: 'исходящее' }),
      message({ id: 'm-new', at: '2026-09-02T09:41:00.000Z', text: 'жду миграции' }),
    ];
    const frame = paneOf(rowsOf([session(), sender()], messages)[1]);

    expect(frame).toContain('жду миграции');
    expect(frame).not.toContain('исходящее');
    // Непрочитанное — с конвертом и выше прочитанных, хотя оно старше их.
    expect(lineWith(frame, 'жду миграции')).toContain('✉');
    expect(frame.indexOf('жду миграции')).toBeLessThan(frame.indexOf('прочитано 5'));
    // Отправитель — его роль, а не id, и время сообщения.
    expect(lineWith(frame, 'жду миграции')).toContain('план');
    expect(lineWith(frame, 'жду миграции')).toContain(clock('2026-09-02T09:41:00.000Z'));
    // Прочитанных ровно пять: самое старое не показывается.
    expect(frame).toContain('прочитано 5');
    expect(frame).not.toContain('прочитано 0');
  });

  it('сообщений нет — прочерк', () => {
    expect(lineWith(paneOf(rowsOf([session()])[1]), 'ВХОДЯЩИЕ')).toContain('—');
  });
});

describe('DetailsPane — АРТЕФАКТЫ и СУБАГЕНТЫ', () => {
  it('путь артефакта усекается слева — важен хвост (6.4)', () => {
    const row = rowsOf([
      session({
        artifacts: [
          { kind: 'plan', path: '.harnas/works/w-0042/artifacts/подробный-план-миграции.md' },
        ],
      }),
    ])[1];
    const frame = paneOf(row, { width: 40 });

    expect(lineWith(frame, 'plan:')).toContain('…');
    expect(lineWith(frame, 'plan:')).toContain('миграции.md');
    expect(frame).not.toContain('.harnas/works');
  });

  it('СУБАГЕНТЫ — те же строки, что в списке подсессий', () => {
    const frame = paneOf(rowsOf([session()])[1], { subsessions: [subsession()] });
    const line = lineWith(frame, 'explore repo');

    expect(line).toContain('4м');
    expect(line).toContain('Opus');
  });
});

describe('DetailsPane — ИСТОРИЯ', () => {
  const withHistory = session({
    history: [
      { status: 'pending', at: '2026-09-02T09:12:00.000Z' },
      { status: 'active', at: '2026-09-02T09:14:00.000Z' },
      { status: 'idle', at: '2026-09-02T13:20:00.000Z' },
    ],
  });

  it('цепочка переходов со стрелками', () => {
    const line = lineWith(paneOf(rowsOf([withHistory])[1]), 'ИСТОРИЯ');
    expect(line).toContain(`◌ ${clock('2026-09-02T09:12:00.000Z')}`);
    expect(line).toContain('→');
    expect(line).toContain(`◐ ${clock('2026-09-02T13:20:00.000Z')}`);
  });

  it('на узкой ширине — только два последних перехода (раздел 3)', () => {
    const frame = paneOf(rowsOf([withHistory])[1], { width: 26 });
    expect(lineWith(frame, 'ист:')).toContain(clock('2026-09-02T13:20:00.000Z'));
    expect(frame).not.toContain(clock('2026-09-02T09:12:00.000Z'));
  });
});

describe('DetailsPane — прокрутка и работа', () => {
  it('панель листается окном: нижние секции видны при прокрутке (раздел 3)', () => {
    const row = rowsOf([session()])[1];
    const top = paneOf(row, { height: 3 });
    const bottom = paneOf(row, { height: 3, selected: 40 });

    expect(top).toContain('ЗАДАЧА');
    expect(top).not.toContain('ИСТОРИЯ');
    expect(bottom).toContain('ИСТОРИЯ');
    expect(bottom).not.toContain('ЗАДАЧА');
  });

  it('выбрана работа — сводка работы, а не сессии', () => {
    const frame = paneOf(rowsOf([session()])[0]);
    expect(frame).toContain('логин по e-mail');
    expect(frame).toContain('●1');
  });

  it('список пуст — панель это говорит', () => {
    expect(paneOf(undefined)).toContain('Работа не выбрана.');
  });
});
