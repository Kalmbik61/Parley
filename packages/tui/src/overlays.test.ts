/**
 * Содержимое оверлеев: детали, пикеры и справка (макеты TUI v2, 4.1–4.4).
 * Файловой системы и Ink здесь нет — только текст.
 */

import type { SessionIndex, WorkEntry, WorkSession } from '@harnas/core';
import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { glyphs } from './glyphs.js';
import {
  detailsView,
  filterItems,
  helpView,
  historyItems,
  pickerView,
  workItems,
} from './overlays.js';

const g = glyphs({ LANG: 'ru_RU.UTF-8' });
const NOW = Date.parse('2026-09-05T10:00:00.000Z');

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-02',
    provider: 'claude',
    label: 'бэкенд',
    task: 'Реализовать шаги 1–3 плана',
    parent: null,
    contextFrom: [],
    status: 'active',
    history: [
      { status: 'pending', at: '2026-09-05T09:12:00.000Z' },
      { status: 'active', at: '2026-09-05T09:14:00.000Z' },
    ],
    startedAt: '2026-09-05T09:14:00.000Z',
    endedAt: null,
    pid: 48213,
    startedAtProcess: null,
    launchedBy: 'tui',
    providerSessionId: '7fa0e1ee-cc7b',
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    ...over,
  };
}

const entry = (over: Partial<WorkEntry['map']> = {}, sessions = [session()]): WorkEntry => ({
  projectPath: '/dev/shop',
  map: {
    schemaVersion: 1,
    work: {
      id: 'w-0042',
      title: 'Авторизация',
      goal: 'Логин по e-mail, сессии, миграции',
      status: 'active',
      createdAt: '2026-09-05T09:00:00.000Z',
      updatedAt: '2026-09-05T09:00:00.000Z',
    },
    sessions,
    messages: [],
    ...over,
  },
});

const details = (over: Partial<Parameters<typeof detailsView>[0]> = {}): string[] =>
  detailsView({
    entry: entry(),
    session: session(),
    state: 'working',
    activity: {
      activity: 'working',
      subagents: 1,
      turnEndedAt: null,
      lastEventAt: '2026-09-05T09:59:46.000Z',
      source: 'hooks',
      exited: false,
      hooksMissing: false,
    },
    index: undefined,
    atHarness: true,
    editing: null,
    prefix: 'ctrl+q',
    g,
    now: NOW,
    ...over,
  }).lines.map((line) => line.text);

describe('детали сессии (макет 4.1)', () => {
  it('секции идут по порядку макета', () => {
    const lines = details();
    const labels = [
      'ЗАДАЧА',
      'СОСТ.',
      'ТОКЕНЫ',
      'СВОДКА',
      'ВХОДЯЩИЕ',
      'АРТЕФ.',
      'СУБАГ.',
      'ИСТОРИЯ',
      'ЦЕЛЬ',
    ];
    let at = -1;
    for (const label of labels) {
      const found = lines.findIndex((line, index) => index > at && line.includes(label));
      expect(found, label).toBeGreaterThan(at);
      at = found;
    }
  });

  it('СОСТ. живой — activity, длительность и время с последнего события', () => {
    const line = details().find((text) => text.includes('СОСТ.')) ?? '';
    expect(line).toContain('● working');
    expect(line).toContain('46м');
    expect(line).toContain('последнее событие 14с назад');
  });

  it('СОСТ. без событий про них молчит: «событие — назад» не значит ничего', () => {
    const line =
      details({ activity: null, index: undefined }).find((text) => text.includes('СОСТ.')) ?? '';
    expect(line).toContain('● working');
    expect(line).toContain('46м');
    expect(line).not.toContain('событие');
  });

  it('СОСТ. вышедшей — время выхода и код текстом, глиф один', () => {
    const line =
      details({
        session: session({
          status: 'exited',
          endedAt: '2026-09-05T09:40:00.000Z',
          history: [{ status: 'exited', at: '2026-09-05T09:40:00.000Z', exitCode: 0 }],
        }),
        state: 'exited',
      }).find((text) => text.includes('СОСТ.')) ?? '';
    expect(line).toContain('○ exited');
    expect(line).toContain('код 0');
  });

  it('СВОДКА: пока идёт дозаказ — «авто-резюме: считается…» (макет 4.1)', () => {
    const exited = session({ status: 'exited', endedAt: '2026-09-05T09:40:00.000Z' });
    const line =
      details({ session: exited, state: 'exited', summarizing: true }).find((text) =>
        text.includes('СВОДКА'),
      ) ?? '';
    expect(line).toContain('авто-резюме: считается…');
    expect(line).not.toContain('дозаказать');
  });

  it('токены — четыре счётчика, включая кэш (в сайдбар он не выводится)', () => {
    const line =
      details({
        index: {
          tokens: { input: 1200, output: 845, cacheRead: 50_000, cacheWrite: 3000 },
        } as SessionIndex,
      }).find((text) => text.includes('ТОКЕНЫ')) ?? '';
    expect(line).toContain('↑1.2к ↓845');
    expect(line).toContain('кэш чт 50к зп 3.0к');
  });

  it('сводка отмечает источник, а у exited зовёт дозаказать', () => {
    expect(details({ session: session({ summary: 'миграции готовы' }) }).join('\n')).toContain(
      'progress: «миграции готовы»',
    );
    expect(
      details({ session: session({ summary: 'готово', summarySource: 'auto' }) }).join('\n'),
    ).toContain('авто: «готово»');
    expect(
      details({ session: session({ status: 'exited' }), state: 'exited' }).join('\n'),
    ).toContain('ctrl+q R — дозаказать');
  });

  it('входящие: непрочитанные первыми и с глифом, прочитанные тусклые', () => {
    const view = detailsView({
      entry: entry(
        {
          messages: [
            {
              id: 'm-01',
              from: 's-01',
              to: 's-02',
              at: '2026-09-05T09:12:00.000Z',
              text: 'начинай со схемы',
              readAt: '2026-09-05T09:13:00.000Z',
            },
            {
              id: 'm-02',
              from: 's-01',
              to: 's-02',
              at: '2026-09-05T09:41:00.000Z',
              text: 'жду миграции',
              readAt: null,
            },
          ],
        },
        [session(), session({ id: 's-01', label: 'план' })],
      ),
      session: session(),
      state: 'working',
      activity: null,
      index: undefined,
      atHarness: true,
      editing: null,
      prefix: 'ctrl+q',
      g,
      now: NOW,
    });
    const inbox = view.lines.filter((line) => line.text.includes('«'));
    expect(inbox[0]?.text).toContain('▤ план');
    expect(inbox[0]?.text).toContain('жду миграции');
    expect(inbox[1]?.text).toContain('начинай со схемы');
    expect(inbox[1]?.dim).toBe(true);
  });

  it('правка цели: строка ЦЕЛЬ становится полем, подсказка меняется', () => {
    const view = detailsView({
      entry: entry(),
      session: session(),
      state: 'working',
      activity: null,
      index: undefined,
      atHarness: true,
      editing: 'новая цель',
      prefix: 'ctrl+q',
      g,
      now: NOW,
    });
    expect(view.lines.at(-1)?.text).toContain('новая цель▌');
    expect(view.footer).toContain('Enter — сохранить цель');
  });

  it('живая сессия вне харнесса помечена в состоянии', () => {
    expect(details({ atHarness: false }).join('\n')).toContain('вне харнесса');
  });
});

describe('пикер работ (макет 4.2)', () => {
  const items = (): ReturnType<typeof workItems> =>
    workItems(
      [
        entry(),
        {
          projectPath: '/dev/billing',
          map: {
            ...entry().map,
            work: { ...entry().map.work, id: 'w-0043', title: 'Автоплатежи' },
          },
        },
      ],
      (key) => (key === 'w-0042' ? 'blocked' : null),
      () => 'main',
      (item) => item.map.work.id,
      g,
    );

  it('строка — заголовок, проект с веткой и точка состояния', () => {
    const first = items()[0]?.text ?? '';
    expect(first).toContain('Авторизация');
    expect(first).toContain('/dev/shop · main');
    expect(first.trimEnd().endsWith('●')).toBe(true);
    // Ширина строки не больше тела рамки 56 − 2.
    expect(first.length).toBeLessThanOrEqual(54);
  });

  it('фильтр — поиск подстроки без регистра', () => {
    expect(filterItems(items(), 'авт')).toHaveLength(2);
    expect(filterItems(items(), 'платеж')).toHaveLength(1);
    expect(filterItems(items(), 'неттакого')).toHaveLength(0);
  });

  it('выбранная строка подсвечена, пустой список объясняет себя', () => {
    const view = pickerView({
      title: 'работы',
      items: items(),
      filter: 'авт',
      at: 1,
      footer: ' Enter — выбрать · Esc',
      g,
    });
    expect(view.lines[0]?.text).toBe(' > авт▌');
    expect(view.lines[1]?.rule).toBe(true);
    expect(view.lines[3]?.selected).toBe(true);

    const empty = pickerView({ title: 'работы', items: [], filter: 'x', at: 0, footer: '', g });
    expect(empty.lines.at(-1)?.text).toContain('ничего не нашлось');
  });
});

describe('пикер истории (макет 4.3)', () => {
  const index = (over: Partial<SessionIndex>): SessionIndex =>
    ({
      id: 'uuid-1',
      title: 'исправить flaky-тест auth',
      endedAt: '2026-09-05T08:00:00.000Z',
      durationMs: 41 * 60_000,
      tokens: { input: 12_000, output: 3100, cacheRead: 0, cacheWrite: 0 },
      ...over,
    }) as SessionIndex;

  it('заголовок, возраст, длительность и токены', () => {
    const line = historyItems([index({})], g, NOW)[0]?.text ?? '';
    expect(line).toContain('исправить flaky-тест auth');
    expect(line).toContain('2ч · 41м · 12к/3.1к');
  });

  it('длинный заголовок режет хвост: токены отбрасываются первыми, возраст остаётся', () => {
    const line = historyItems([index({ title: 'э'.repeat(60) })], g, NOW)[0]?.text ?? '';
    expect(line).not.toContain('12к/3.1к');
    expect(line).toContain('2ч');
    expect(line.length).toBeLessThanOrEqual(54);
  });
});

describe('справка (макет 4.4)', () => {
  it('первая строка — как сменить префикс', () => {
    const view = helpView('ctrl+q', '', path.join(homedir(), '.harnas', 'config.json'), g);
    expect(view.lines[0]?.text).toContain('префикс перехватывает терминал?');
    expect(view.lines[1]?.text).toContain('HARNAS_PREFIX');
    expect(view.lines[1]?.text).toContain('~/.harnas/config.json');
    expect(view.title).toContain('префикс ctrl+q');
  });

  it('перечисляет все привязки и фильтруется набором текста', () => {
    const all = helpView('ctrl+q', '', '/c.json', g)
      .lines.map((line) => line.text)
      .join('\n');
    for (const key of [
      'c ',
      'w ',
      'g ',
      'i ',
      'j / k',
      '1..9',
      's ',
      'b ',
      'x ',
      'r ',
      'R ',
      '? ',
      'q ',
    ]) {
      expect(all, key).toContain(` ${key}`);
    }
    // Правило строки `new` записано одной строкой справки (5.1).
    expect(all).toContain('на строке new — новая работа');

    const filtered = helpView('ctrl+q', 'резюме', '/c.json', g).lines;
    expect(filtered.filter((line) => line.text.includes('дозаказать'))).toHaveLength(1);
    expect(filtered.some((line) => line.text.includes('пикер работ'))).toBe(false);
  });
});
