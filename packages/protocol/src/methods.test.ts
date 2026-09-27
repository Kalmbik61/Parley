import { describe, expect, expectTypeOf, it } from 'vitest';
import { METHODS, NOTIFICATIONS } from './methods.js';
import type { Params, Result } from './methods.js';

describe('типы методов', () => {
  it('у Params<sessions.create> поле workId имеет тип string | null', () => {
    expectTypeOf<Params<'sessions.create'>['workId']>().toEqualTypeOf<string | null>();
  });

  it('у Result<pty.attach> есть snapshot: string', () => {
    expectTypeOf<Result<'pty.attach'>>().toHaveProperty('snapshot');
    expectTypeOf<Result<'pty.attach'>['snapshot']>().toEqualTypeOf<string>();
  });

  it('hello отдаёт необязательный список methods: старый хост его не шлёт', () => {
    expectTypeOf<Result<'hello'>['methods']>().toEqualTypeOf<string[] | undefined>();
  });
});

describe('works.rename', () => {
  const base = { projectPath: '/p', workId: 'w-0001' };
  const parse = (title: string) => METHODS['works.rename'].safeParse({ ...base, title });

  it('обрезает пробелы и отвергает пустое название', () => {
    expect(parse('  Новая  ')).toMatchObject({ success: true, data: { title: 'Новая' } });
    expect(parse('').success).toBe(false);
    expect(parse('   ').success).toBe(false);
  });

  it('120 эмодзи проходят, 121 символ — нет: счёт по кодовым точкам', () => {
    expect(parse('😀'.repeat(120)).success).toBe(true);
    expect(parse('я'.repeat(121)).success).toBe(false);
  });

  it('невидимые символы формата — как пробелы: пустое отвергается, края обрезаются', () => {
    for (const invisible of ['\u200B\u200B\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF', ' \u200B \u2060 ']) {
      expect(parse(invisible).success).toBe(false);
    }
    expect(parse('\u200B Новая\u200Dx \u2060')).toMatchObject({
      success: true,
      data: { title: 'Новая\u200Dx' },
    });
  });

  it('сырая строка длиннее 480 UTF-16 отвергается до подсчёта кодовых точек', () => {
    // После обрезки в обоих случаях 120 эмодзи; решает сырая длина: 480 — да, 481 — нет.
    expect(parse(' '.repeat(120) + '😀'.repeat(120) + ' '.repeat(120)).success).toBe(true);
    expect(parse(' '.repeat(121) + '😀'.repeat(120) + ' '.repeat(120)).success).toBe(false);
    expect(parse(' '.repeat(481)).success).toBe(false);
  });
});

describe('works.setStatus', () => {
  const parse = (status: unknown) =>
    METHODS['works.setStatus'].safeParse({ projectPath: '/p', workId: 'w-0001', status });

  it('принимает active, done и archived, неверный статус отвергает до хоста', () => {
    for (const status of ['active', 'done', 'archived']) expect(parse(status).success).toBe(true);
    expect(parse('deleted').success).toBe(false);
  });
});

describe('mail.markRead', () => {
  const parse = (messageIds: unknown) =>
    METHODS['mail.markRead'].safeParse({ projectPath: '/p', workId: 'w-0001', messageIds });
  const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => `m-${i + 1}`);

  it('пачка 1–500 id проходит, пустая и 501 — отвергаются на схеме', () => {
    expect(parse(ids(1)).success).toBe(true);
    expect(parse(ids(500)).success).toBe(true);
    expect(parse([]).success).toBe(false);
    expect(parse(ids(501)).success).toBe(false);
  });

  it('результат — число отметок', () => {
    expectTypeOf<Result<'mail.markRead'>>().toEqualTypeOf<{ marked: number }>();
  });
});

describe('activity.seen', () => {
  it('уведомление с ref сессии', () => {
    const ref = { projectPath: '/p', workId: 'w-0001', sessionId: 's-01' };
    expect(NOTIFICATIONS['activity.seen'].safeParse({ ref }).success).toBe(true);
    expect(NOTIFICATIONS['activity.seen'].safeParse({}).success).toBe(false);
    expectTypeOf<Params<'activity.seen'>>().toEqualTypeOf<{
      ref: { projectPath: string; workId: string; sessionId: string };
    }>();
  });
});

describe('pty.send', () => {
  const ref = { projectPath: '/p', workId: 'w-0001', sessionId: 's-01' };

  it('текст 1+ символов и submit; пустой текст и без submit — отвергаются на схеме', () => {
    expect(METHODS['pty.send'].safeParse({ ref, text: 'hi', submit: true }).success).toBe(true);
    expect(METHODS['pty.send'].safeParse({ ref, text: '', submit: true }).success).toBe(false);
    expect(METHODS['pty.send'].safeParse({ ref, text: 'hi' }).success).toBe(false);
  });

  it('результат — SendResult', () => {
    expectTypeOf<Result<'pty.send'>>().toEqualTypeOf<{
      inserted: boolean;
      submitted: boolean;
      reason: 'blocked' | 'busy' | 'no-paste-mode' | 'draft' | 'input' | 'restarted' | null;
    }>();
  });
});
