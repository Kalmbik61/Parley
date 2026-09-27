import { describe, expect, expectTypeOf, it } from 'vitest';
import { METHODS } from './methods.js';
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
});

describe('works.setStatus', () => {
  const parse = (status: unknown) =>
    METHODS['works.setStatus'].safeParse({ projectPath: '/p', workId: 'w-0001', status });

  it('принимает active, done и archived, неверный статус отвергает до хоста', () => {
    for (const status of ['active', 'done', 'archived']) expect(parse(status).success).toBe(true);
    expect(parse('deleted').success).toBe(false);
  });
});
