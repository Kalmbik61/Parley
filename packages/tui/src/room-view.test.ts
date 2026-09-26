/**
 * Вид комнаты: вся переписка работы, заголовок с числительным, участники и
 * решения по новым подписям (дизайн комнаты 2026-09-23, раздел 5 и 8).
 * Ни Ink, ни файловой системы здесь нет.
 */

import type { Message, MessageKind, WorkEntry, WorkSession } from '@harnas/core';
import { describe, expect, it } from 'vitest';
import { formatClock } from './format.js';
import { glyphs } from './glyphs.js';
import { participantTag, roomView, type RoomView, type RoomViewOptions } from './room-view.js';

const g = glyphs({ LANG: 'ru_RU.UTF-8' });

/** Ширина ленты по умолчанию: достаточно, чтобы теги-фикстуры не переносились. */
const WIDTH = 60;

const at = (time: string): string => `2026-09-08T${time}:00.000Z`;
const clock = (time: string): string => formatClock(at(time));

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-01',
    provider: 'claude',
    label: 'план',
    task: 'составить план',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
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
  return {
    id,
    roomId: null,
    from,
    to: [to],
    at: at(time),
    text,
    kind,
    readBy: readAt === null ? {} : { [to]: readAt },
  };
}

function entry(
  sessions: WorkSession[],
  messages: Message[],
  deletedSessions: string[] = [],
): WorkEntry {
  return {
    projectPath: '/dev/shop',
    map: {
      schemaVersion: 2,
      rooms: [],
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

/**
 * Три сессии в одной работе, письмо от удалённой `s-04` тоже в ленте (5.3).
 * `s-03` в переписке не участвует — её нет ни в одном письме.
 */
const work = (): WorkEntry =>
  entry(
    [
      session(),
      session({ id: 's-02', label: 'бэкенд', provider: 'codex' }),
      session({ id: 's-03', label: 'тесты' }),
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
      letter('m-04', 's-01', 's-02', '12:43', 'question', 'прогони e2e после мержа', null),
    ],
    ['s-04'],
  );

const modelOf =
  (
    models: Record<string, string | null> = { 's-01': 'claude-opus-5-5', 's-02': 'gpt-5.2-codex' },
  ) =>
  (id: string): string | null =>
    models[id] ?? null;

const view = (over: Partial<RoomViewOptions> = {}): RoomView =>
  roomView({
    entry: work(),
    width: WIDTH,
    height: 100,
    scroll: null,
    g,
    modelOf: modelOf(),
    ...over,
  });

const texts = (over: Partial<RoomViewOptions> = {}): string[] =>
  view(over).lines.map((line) => line.text);

describe('participantTag', () => {
  const map = work().map;

  it('известная сессия — номер и модель в скобках', () => {
    expect(participantTag(map, 's-01', modelOf())).toBe('S01 (Opus 5.5)');
    expect(participantTag(map, 's-02', modelOf())).toBe('S02 (Codex)');
  });

  it('модель неизвестна — подпись провайдера из реестра', () => {
    expect(participantTag(map, 's-03', modelOf())).toBe('S03 (Claude)');
  });

  it('провайдер не в реестре — его сырой id, функция не падает', () => {
    const withCustomProvider = entry([session({ id: 's-09', provider: 'glm-cli' })], []).map;

    expect(participantTag(withCustomProvider, 's-09', () => null)).toBe('S09 (glm-cli)');
  });

  it('удалённая сессия — «(удалена)», чужой id — как есть', () => {
    expect(participantTag(map, 's-04', modelOf())).toBe('S04 (удалена)');
    expect(participantTag(map, 's-99', modelOf())).toBe('s-99');
  });
});

describe('roomView: заголовок', () => {
  it('число писем и непрочитанные — по всей работе, а не по поддереву', () => {
    const shown = view();

    expect(shown.title).toBe('комната · 5 писем');
    expect(shown.unread).toBe(1);
  });

  it('числительное согласуется с числом писем — инвариант по диапазону', () => {
    // Независимая проверка: ICU-категории ru совпадают со склонением
    // «письмо / письма / писем» (one → письмо, few → письма, иначе — писем).
    const rules = new Intl.PluralRules('ru-RU');
    const word = (n: number): string => {
      const category = rules.select(n);
      if (category === 'one') return 'письмо';
      if (category === 'few') return 'письма';
      return 'писем';
    };

    const range = [
      ...Array.from({ length: 31 }, (_, index) => index),
      ...Array.from({ length: 26 }, (_, index) => index + 100),
    ];
    for (const count of range) {
      const sessions = [session(), session({ id: 's-02', label: 'бэкенд' })];
      const messages = Array.from({ length: count }, (_, index) =>
        letter(`m-${index}`, 's-01', 's-02', '00:00', 'note', 'текст'),
      );
      const title = roomView({
        entry: entry(sessions, messages),
        width: WIDTH,
        height: 5,
        scroll: null,
        g,
        modelOf: () => null,
      }).title;

      expect(title).toBe(`комната · ${count} ${word(count)}`);
    }
  });
});

describe('roomView: участники', () => {
  it('первая строка — теги сессий в порядке сайдбара, через « · »', () => {
    expect(texts()[0]).toBe('S01 (Opus 5.5) · S02 (Codex)');
  });

  it('сессия без единого письма не входит в строку участников', () => {
    // s-03 существует, но ни разу не отправитель и не адресат.
    expect(texts()[0]).not.toContain('S03');
  });

  it('удалённая сессия не считается участником, хотя её письмо в ленте видно', () => {
    expect(texts()[0]).not.toContain('S04');
    expect(texts()[0]).not.toContain('удал');
  });
});

describe('roomView: решения', () => {
  it('блок стоит первым после строки участников, подпись автора — participantTag', () => {
    const lines = view().lines;

    expect(lines[0]?.tone).toBe('muted');
    expect(lines[1]).toEqual({ text: 'РЕШЕНИЯ', tone: 'head' });
    expect(lines[2]).toEqual({
      text: `${g.done} ${clock('12:42')} S01 (Opus 5.5): «миграции отдельным PR»`,
      tone: 'head',
    });
    expect(lines[3]).toEqual({ text: '', tone: 'muted', rule: true });
  });

  it('видны пять последних, старше — строкой «+N раньше»', () => {
    const decisions = ['первое', 'второе', 'третье', 'четвёртое', 'пятое', 'шестое'].map(
      (text, index) => letter(`m-1${index}`, 's-01', 's-02', `12:1${index}`, 'decision', text),
    );
    const many = entry([session(), session({ id: 's-02', label: 'бэкенд' })], decisions);
    const lines = roomView({
      entry: many,
      width: WIDTH,
      height: 100,
      scroll: null,
      g,
      modelOf: () => null,
    }).lines;
    // Блок РЕШЕНИЯ — от заголовка до линейки-разделителя; письма ниже него
    // показывают то же «первое» полным текстом, это отдельная часть ленты.
    const ruleAt = lines.findIndex((line) => line.rule === true);
    const block = lines.slice(0, ruleAt).map((line) => line.text);

    expect(block).toContain('+1 раньше');
    expect(block.filter((text) => text.startsWith(`${g.done} `))).toHaveLength(5);
    expect(block.some((text) => text.includes('первое'))).toBe(false);
  });

  it('нет решений — нет блока', () => {
    const noDecisions = entry(
      [session(), session({ id: 's-02', label: 'бэкенд' })],
      [letter('m-01', 's-01', 's-02', '10:00', 'note', 'текст')],
    );
    const lines = roomView({
      entry: noDecisions,
      width: WIDTH,
      height: 100,
      scroll: null,
      g,
      modelOf: () => null,
    }).lines;

    expect(lines.some((line) => line.text === 'РЕШЕНИЯ')).toBe(false);
  });
});

describe('roomView: письмо', () => {
  it('заголовок: время, теги через стрелку, вид словом', () => {
    const lines = texts();

    expect(lines).toContain(`${clock('12:40')}  S01 (Opus 5.5) ${g.arrow} S02 (Codex) · вопрос`);
    expect(lines).toContain(`${clock('12:42')}  S01 (Opus 5.5) ${g.arrow} S02 (Codex) · решение`);
  });

  it('у заметки вид не печатается', () => {
    expect(texts()).toContain(`${clock('12:41')}  S02 (Codex) ${g.arrow} S01 (Opus 5.5)`);
  });

  it('тело — с новой строки, без отступа, во всю ширину, без обрезки', () => {
    expect(texts()).toContain('где лежит миграция users?');
    expect(texts()).toContain('db/migrations/0007_users.sql лежит рядом с ридми');
  });

  it('удалённая сессия в письме — «(удалена)», письмо из ленты не пропадает', () => {
    expect(texts()).toContain(`${clock('12:39')}  S04 (удалена) ${g.arrow} S01 (Opus 5.5)`);
  });

  it('непрочитанное помечено mark: unseen на строке заголовка, тон общий', () => {
    const lines = view().lines;
    const fresh = lines.find((line) => line.text.startsWith(`${clock('12:43')}  S01`));
    const old = lines.find(
      (line) => line.text === `${clock('12:40')}  S01 (Opus 5.5) ${g.arrow} S02 (Codex) · вопрос`,
    );

    expect(fresh?.mark).toBe('unseen');
    expect(fresh?.tone).toBe('head');
    // Прочитанность не гасит письмо: тон непрочитанного и прочитанного заголовка — один и тот же.
    expect(old?.mark).toBeUndefined();
    expect(old?.tone).toBe('head');
  });

  it('ни одна строка ленты не несёт признак приглушения из-за readAt', () => {
    // RoomLine не хранит ни `readAt`, ни `dim` вовсе — только текст, роль,
    // непрочитанность и линейку.
    const allowed = new Set(['text', 'tone', 'mark', 'rule']);
    for (const line of view().lines) {
      for (const key of Object.keys(line)) expect(allowed.has(key)).toBe(true);
    }
  });

  it('перенос по ширине без обрезки: строки не длиннее width, текст не теряется', () => {
    const long = 'раз два три четыре пять шесть семь восемь девять десять';
    const longEntry = entry(
      [session(), session({ id: 's-02', label: 'бэкенд' })],
      [letter('m-01', 's-01', 's-02', '10:00', 'note', long)],
    );
    const lines = roomView({
      entry: longEntry,
      width: 20,
      height: 100,
      scroll: null,
      g,
      modelOf: () => null,
    }).lines;
    const body = lines.filter((line) => line.tone === 'body');

    for (const line of body) expect(line.text.length).toBeLessThanOrEqual(20);
    // Строки склеиваются пробелом обратно в исходный текст — ничего не потерялось.
    expect(body.map((line) => line.text).join(' ')).toBe(long);
    expect(body.some((line) => line.text.includes(g.ellipsis))).toBe(false);
  });

  it('между письмами пустая строка, после последнего письма — нет', () => {
    const lines = view().lines;

    expect(
      lines.some((line) => line.tone === 'muted' && line.text === '' && line.rule !== true),
    ).toBe(true);
    expect(lines.at(-1)?.text).not.toBe('');
  });
});

describe('roomView: длинное решение', () => {
  it('в блоке сверху — две строки с многоточием, полный текст остаётся в ленте', () => {
    const long = Array.from({ length: 40 }, (_, index) => `пункт${index + 1}`).join(' ');
    const lines = view({
      entry: entry(
        [session(), session({ id: 's-02', label: 'бэкенд', provider: 'codex' })],
        [letter('m-01', 's-01', 's-02', '12:40', 'decision', long)],
      ),
    }).lines;

    const rule = lines.findIndex((line) => line.rule === true);
    const block = lines.slice(lines.findIndex((line) => line.text === 'РЕШЕНИЯ') + 1, rule);
    expect(block).toHaveLength(2);
    expect(block.at(-1)?.text.endsWith(g.ellipsis)).toBe(true);
    for (const line of block) expect([...line.text].length).toBeLessThanOrEqual(WIDTH);

    // В ленте письмо-решение целиком: последний пункт на месте.
    expect(lines.slice(rule).some((line) => line.text.includes('пункт40'))).toBe(true);
  });
});

describe('roomView: окно', () => {
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

  // Перенесено из теста треда (приёмка 39 прежнего дизайна): окно проверено и
  // на масштабе, а не только на пяти письмах — срез по высоте, хвост и `below`.
  it('лента в 500 писем рисуется срезом по высоте', () => {
    const minute = (index: number): string =>
      `${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`;
    const many = entry(
      [session(), session({ id: 's-02', label: 'бэкенд', provider: 'codex' })],
      Array.from({ length: 500 }, (_, index) =>
        letter(
          `m-${String(index).padStart(3, '0')}`,
          's-01',
          's-02',
          minute(index),
          'note',
          `письмо ${String(index + 1).padStart(3, '0')}`,
        ),
      ),
    );
    const cut = (scroll: number | null): RoomView => view({ entry: many, height: 20, scroll });

    // Вся лента в окно не попадает: в кадре ровно высота, а не тысячи строк.
    const tail = cut(null);
    expect(tail.total).toBeGreaterThan(1000);
    expect(tail.lines).toHaveLength(20);
    expect(tail.lines.at(-1)?.text).toBe('письмо 500');
    expect(tail.below).toBe(0);

    // От начала ленты видно первое письмо, а ниже окна — всё остальное.
    const head = cut(0);
    expect(head.lines.some((line) => line.text.startsWith(clock('00:00')))).toBe(true);
    expect(head.below).toBe(tail.total - 20);
  });

  it('прокрутка дальше хвоста окно в пустоту не уводит', () => {
    const all = texts({ height: 100 });
    const window = view({ height: 4, scroll: all.length + 10 });

    expect(window.lines.map((line) => line.text)).toEqual(all.slice(-4));
    expect(window.below).toBe(0);
  });
});

describe('roomView: данные вида w-0010', () => {
  it('корневая сессия с ярлыком в двести знаков — ни одна строка ленты его не содержит', () => {
    const longLabel = 'x'.repeat(200);
    const map = entry(
      [session({ id: 's-01', label: longLabel }), session({ id: 's-02', label: 'ревью' })],
      [
        letter('m-01', 's-01', 's-02', '10:00', 'question', 'разошлось расхождение в транскрипте'),
        letter('m-02', 's-02', 's-01', '10:05', 'decision', 'решили считать это разными работами'),
      ],
    );
    const shown = roomView({
      entry: map,
      width: WIDTH,
      height: 100,
      scroll: null,
      g,
      modelOf: () => null,
    });

    for (const line of shown.lines) expect(line.text).not.toContain(longLabel);
    expect(shown.lines.some((line) => line.text.startsWith('S01'))).toBe(true);
  });
});
