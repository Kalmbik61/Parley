/**
 * Вид треда: заголовок, блок решений, лента и окно строк (спецификация
 * 2026-09-08, 6.2–6.3; приёмка 8.18, 8.36, 8.39). Фикстура — карта работы, как
 * в `overlays.test.ts`: ни Ink, ни файловой системы здесь нет.
 */

import type { Message, MessageKind, WorkEntry, WorkSession } from '@harnas/core';
import { describe, expect, it } from 'vitest';
import { formatClock } from './format.js';
import { glyphs } from './glyphs.js';
import { threadView, type ThreadView, type ThreadViewOptions } from './thread-view.js';

const g = glyphs({ LANG: 'ru_RU.UTF-8' });

/** Ширина треда по умолчанию (6.1): по ней считаются переносы в макете. */
const WIDTH = 30;

const at = (time: string): string => `2026-09-08T${time}:00.000Z`;
/** Время печатается местное, поэтому ожидание считается тем же форматтером. */
const clock = (time: string): string => formatClock(at(time));

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-01',
    provider: 'claude',
    label: 'план',
    task: 'составить план',
    parent: null,
    contextFrom: [],
    status: 'active',
    history: [],
    startedAt: at('12:30'),
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: null,
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
    ...over,
  };
}

function letter(
  id: string,
  from: string,
  to: string,
  time: string,
  kind: MessageKind,
  text: string,
  readAt: string | null = at('12:44'),
): Message {
  return { id, from, to, at: at(time), text, kind, readAt };
}

function entry(
  sessions: WorkSession[],
  messages: Message[],
  deletedSessions: string[] = [],
): WorkEntry {
  return {
    projectPath: '/dev/shop',
    map: {
      schemaVersion: 1,
      work: {
        id: 'w-0042',
        title: 'Авторизация',
        goal: 'Логин по e-mail, сессии, миграции',
        status: 'active',
        createdAt: at('09:00'),
        updatedAt: at('12:43'),
        deletedSessions,
      },
      sessions,
      messages,
    },
  };
}

/** Родитель `план` с детьми `бэкенд` и `тесты`; письмо `s-04` — от удалённой. */
const work = (): WorkEntry =>
  entry(
    [
      session(),
      session({ id: 's-02', label: 'бэкенд', parent: 's-01' }),
      session({ id: 's-03', label: 'тесты', parent: 's-01' }),
    ],
    [
      letter('m-05', 's-04', 's-01', '12:39', 'note', 'черновик перенесён'),
      letter('m-01', 's-01', 's-02', '12:40', 'question', 'где лежит миграция users?'),
      letter(
        'm-02',
        's-02',
        's-01',
        '12:41',
        'note',
        'db/migrations/0007_users.sql лежит рядом с ридми',
      ),
      letter('m-03', 's-01', 's-02', '12:42', 'decision', 'миграции отдельным PR'),
      letter('m-04', 's-01', 's-03', '12:43', 'question', 'прогони e2e после мержа', null),
    ],
    ['s-04'],
  );

const view = (over: Partial<ThreadViewOptions> = {}): ThreadView =>
  threadView({
    entry: work(),
    sessionId: 's-02',
    width: WIDTH,
    height: 40,
    scroll: null,
    g,
    ...over,
  });

const texts = (over: Partial<ThreadViewOptions> = {}): string[] =>
  view(over).lines.map((line) => line.text);

describe('threadView: заголовок', () => {
  it('ярлык владельца треда и счёт непрочитанных во всём треде', () => {
    const shown = view();

    expect(shown.title).toBe('тред · план');
    expect(shown.unread).toBe(1);
  });

  it('одинокий корень видит всю работу целиком', () => {
    const alone = entry([session()], []);

    expect(
      threadView({ entry: alone, sessionId: 's-01', width: WIDTH, height: 40, scroll: null, g })
        .title,
    ).toBe('тред · работа');
  });

  it('пустой тред: подсказка вместо ленты и никакого блока решений', () => {
    const quiet = entry([session(), session({ id: 's-02', label: 'бэкенд', parent: 's-01' })], []);
    const shown = threadView({
      entry: quiet,
      sessionId: 's-02',
      width: WIDTH,
      height: 40,
      scroll: null,
      g,
    });

    expect(shown.lines).toEqual([{ text: 'писем пока нет', dim: true }]);
    expect(shown.unread).toBe(0);
  });
});

describe('threadView: решения', () => {
  it('блок стоит первым, решение с переносом, под ним линейка', () => {
    const lines = view().lines;

    expect(lines[0]).toEqual({ text: 'РЕШЕНИЯ' });
    expect(lines[1]?.text).toBe(`${g.done} ${clock('12:42')} план: «миграции`);
    expect(lines[2]?.text).toBe('  отдельным PR»');
    expect(lines[3]).toEqual({ text: '', rule: true });
  });

  it('видны пять последних, старше — строкой «+N раньше» над ними', () => {
    const decisions = ['первое', 'второе', 'третье', 'четвёртое', 'пятое', 'шестое'].map(
      (text, index) => letter(`m-1${index}`, 's-01', 's-02', `12:1${index}`, 'decision', text),
    );
    const many = entry(
      [session(), session({ id: 's-02', label: 'бэкенд', parent: 's-01' })],
      decisions,
    );
    const lines = threadView({
      entry: many,
      sessionId: 's-02',
      width: WIDTH,
      height: 40,
      scroll: null,
      g,
    }).lines.map((line) => line.text);

    expect(lines[0]).toBe('РЕШЕНИЯ');
    expect(lines[1]).toBe('+1 раньше');
    expect(lines[2]).toBe(`${g.done} ${clock('12:11')} план: «второе»`);
    expect(lines.filter((line) => line.startsWith(`${g.done} `))).toHaveLength(5);
    expect(lines).not.toContain(`${g.done} ${clock('12:10')} план: «первое»`);
  });
});

describe('threadView: лента', () => {
  it('письма по времени, знаки видов и текст с отступом', () => {
    const lines = texts();

    expect(lines).toContain(`${clock('12:40')} план ${g.arrow} бэкенд ?`);
    expect(lines).toContain('  где лежит миграция users?');
    expect(lines).toContain(`${clock('12:41')} бэкенд ${g.arrow} план`);
    expect(lines).toContain(`${clock('12:42')} план ${g.arrow} бэкенд ${g.done}`);
    // Порядок ленты — по времени, сверху старое (6.3).
    expect(lines.indexOf(`${clock('12:40')} план ${g.arrow} бэкенд ?`)).toBeLessThan(
      lines.indexOf(`${clock('12:42')} план ${g.arrow} бэкенд ${g.done}`),
    );
  });

  it('непрочитанное помечено конвертом и ярче прочитанного', () => {
    const lines = view().lines;
    const fresh = lines.findIndex((line) =>
      line.text.startsWith(`${g.mail} ${clock('12:43')} план ${g.arrow} тесты ?`),
    );
    const old = lines.findIndex(
      (line) => line.text === `${clock('12:40')} план ${g.arrow} бэкенд ?`,
    );

    expect(fresh).toBeGreaterThan(-1);
    expect(lines[fresh]?.dim).toBe(false);
    expect(lines[old]?.dim).toBe(true);
  });

  it('удалённая сессия подписана «(удалена)», её письмо из ленты не пропадает', () => {
    expect(texts()).toContain(`${clock('12:39')} s-04 (удалена) ${g.arrow} план`);
  });

  it('перенос по ширине без обрезки', () => {
    const lines = texts();

    for (const line of lines) expect(line.length).toBeLessThanOrEqual(WIDTH);
    expect(lines.some((line) => line.includes(g.ellipsis))).toBe(false);
    expect(lines).toContain('  db/migrations/0007_users.sql');
    expect(lines).toContain('  лежит рядом с ридми');
  });
});

describe('threadView: окно', () => {
  it('без прокрутки лента держится на хвосте', () => {
    const all = texts({ height: 100 });
    const tail = view({ height: 4 });

    expect(tail.total).toBe(all.length);
    expect(tail.lines.map((line) => line.text)).toEqual(all.slice(-4));
    expect(tail.below).toBe(0);
  });

  it('прокрутка вверх режет срез и считает строки ниже окна', () => {
    const all = texts({ height: 100 });
    const window = view({ height: 4, scroll: 1 });

    expect(window.lines.map((line) => line.text)).toEqual(all.slice(1, 5));
    expect(window.below).toBe(all.length - 5);
  });

  it('прокрутка дальше хвоста окно в пустоту не уводит', () => {
    const all = texts({ height: 100 });
    const window = view({ height: 4, scroll: all.length + 10 });

    expect(window.lines.map((line) => line.text)).toEqual(all.slice(-4));
    expect(window.below).toBe(0);
  });
});
