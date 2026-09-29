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
      reason: 'blocked' | 'busy' | 'no-paste-mode' | 'draft' | 'input' | 'restarted' | 'blocked-before-enter' | null;
    }>();
  });
});

describe('ревью изменений (кусок 8.1)', () => {
  const ref = { projectPath: '/p', workId: 'w-0001', sessionId: 's-01' };

  it('worktrees.diff принимает необязательный patch', () => {
    expect(METHODS['worktrees.diff'].safeParse({ ref }).success).toBe(true);
    expect(METHODS['worktrees.diff'].safeParse({ ref, patch: false }).success).toBe(true);
    expect(METHODS['worktrees.diff'].safeParse({ ref, patch: 'нет' }).success).toBe(false);
  });

  it('worktrees.mergeCheck и changes.project — ref, у changes.project необязательный patch', () => {
    expect(METHODS['worktrees.mergeCheck'].safeParse({ ref }).success).toBe(true);
    expect(METHODS['worktrees.mergeCheck'].safeParse({}).success).toBe(false);
    expect(METHODS['changes.project'].safeParse({ ref }).success).toBe(true);
    expect(METHODS['changes.project'].safeParse({ ref, patch: false }).success).toBe(true);
  });

  it('changes.commitProject: сообщение 1–10 000 символов', () => {
    const parse = (message: string) => METHODS['changes.commitProject'].safeParse({ ref, message });
    expect(parse('m').success).toBe(true);
    expect(parse('я'.repeat(10_000)).success).toBe(true);
    expect(parse('').success).toBe(false);
    expect(parse('я'.repeat(10_001)).success).toBe(false);
  });

  it('результаты: MergeCheck, ProjectChanges, { commit }, WorktreeDiff с новыми полями', () => {
    expectTypeOf<Result<'worktrees.mergeCheck'>>().toEqualTypeOf<
      { status: 'clean' } | { status: 'conflicts'; files: string[] } | { status: 'unsupported' }
    >();
    expectTypeOf<Result<'changes.project'>>().toHaveProperty('branch');
    expectTypeOf<Result<'changes.project'>['branch']>().toEqualTypeOf<string | null>();
    expectTypeOf<Result<'changes.commitProject'>>().toEqualTypeOf<{ commit: string }>();
    expectTypeOf<Result<'worktrees.diff'>['stats']>().toEqualTypeOf<{ additions: number; deletions: number }>();
    expectTypeOf<Result<'worktrees.diff'>['uncommittedPaths']>().toEqualTypeOf<string[]>();
  });
});

describe('комнаты: ведущий и решение (дизайн комнат, 3.2)', () => {
  const room = { projectPath: '/p', workId: 'w-0001', roomId: 'r-01' };

  it('rooms.create: ведущий необязателен, но строка', () => {
    const base = { projectPath: '/p', workId: 'w-0001', title: 'Возвраты', members: ['s-01', 's-02'] };
    expect(METHODS['rooms.create'].safeParse(base).success).toBe(true);
    expect(METHODS['rooms.create'].safeParse({ ...base, lead: 's-02' }).success).toBe(true);
    expect(METHODS['rooms.create'].safeParse({ ...base, lead: 2 }).success).toBe(false);
    expectTypeOf<Params<'rooms.create'>['lead']>().toEqualTypeOf<string | undefined>();
  });

  it('rooms.create: origin — пара строк, quiet — булево; оба необязательны, старое окно их не шлёт', () => {
    const base = { projectPath: '/p', workId: 'w-0001', title: 'Возвраты', members: ['s-02', 's-03'] };
    const parse = (extra: Record<string, unknown>) => METHODS['rooms.create'].safeParse({ ...base, ...extra });

    expect(parse({ origin: ['s-03', 's-02'] }).success).toBe(true);
    expect(parse({ quiet: true }).success).toBe(true);
    expect(parse({ quiet: false, origin: ['s-03', 's-02'], lead: 's-03' }).success).toBe(true);
    // origin — ровно две сессии, из которых собрана комната (диалог 1.6), и ничего иного.
    for (const origin of [[], ['s-03'], ['s-03', 's-02', 's-01'], 's-03', [3, 2], null]) {
      expect(parse({ origin }).success).toBe(false);
    }
    for (const quiet of ['yes', 1, null]) expect(parse({ quiet }).success).toBe(false);
    expectTypeOf<Params<'rooms.create'>['origin']>().toEqualTypeOf<[string, string] | undefined>();
    expectTypeOf<Params<'rooms.create'>['quiet']>().toEqualTypeOf<boolean | undefined>();
  });

  it('rooms.addMember: комната и сессия обязательны', () => {
    expect(METHODS['rooms.addMember'].safeParse({ ...room, sessionId: 's-04' }).success).toBe(true);
    expect(METHODS['rooms.addMember'].safeParse(room).success).toBe(false);
    expect(METHODS['rooms.addMember'].safeParse({ projectPath: '/p', workId: 'w-0001', sessionId: 's-04' }).success).toBe(
      false,
    );
    expectTypeOf<Result<'rooms.addMember'>>().toEqualTypeOf<{ messageId: string }>();
  });

  it('rooms.resolveProposal: accept или return, заметка необязательна и до 4000 знаков', () => {
    const accept = { ...room, proposalId: 'p-01', action: 'accept' };
    expect(METHODS['rooms.resolveProposal'].safeParse(accept).success).toBe(true);
    expect(METHODS['rooms.resolveProposal'].safeParse({ ...accept, action: 'return', note: 'мало' }).success).toBe(true);
    expect(METHODS['rooms.resolveProposal'].safeParse({ ...accept, action: 'return', note: '' }).success).toBe(true);
    expect(METHODS['rooms.resolveProposal'].safeParse({ ...accept, note: 'я'.repeat(4000) }).success).toBe(true);
    expect(METHODS['rooms.resolveProposal'].safeParse({ ...accept, note: 'я'.repeat(4001) }).success).toBe(false);
    expect(METHODS['rooms.resolveProposal'].safeParse({ ...accept, action: 'reject' }).success).toBe(false);
    expect(METHODS['rooms.resolveProposal'].safeParse({ ...room, action: 'accept' }).success).toBe(false);
    expectTypeOf<Params<'rooms.resolveProposal'>['action']>().toEqualTypeOf<'accept' | 'return'>();
    expectTypeOf<Result<'rooms.resolveProposal'>>().toEqualTypeOf<{ messageId: string }>();
  });

  it('rooms.resolveProposal: rev — версия показанной карточки, целое от 0; без него — как раньше', () => {
    const accept = { ...room, proposalId: 'p-01', action: 'accept' };
    const parse = (extra: Record<string, unknown>) => METHODS['rooms.resolveProposal'].safeParse({ ...accept, ...extra });

    expect(parse({}).success).toBe(true);
    for (const rev of [0, 1, 7]) expect(parse({ rev }).success).toBe(true);
    for (const rev of [-1, 1.5, '1', null]) expect(parse({ rev }).success).toBe(false);
    expectTypeOf<Params<'rooms.resolveProposal'>['rev']>().toEqualTypeOf<number | undefined>();
  });
});

describe('модель, усилие и поля providers.list (дизайн комнат, 3.2)', () => {
  const create = { projectPath: '/p', workId: 'w-0001', provider: 'claude', label: '', task: '', parent: null };
  const parse = (extra: Record<string, unknown>) => METHODS['sessions.create'].safeParse({ ...create, ...extra });

  it('sessions.create: model и effort необязательны — старое окно их не шлёт', () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ model: 'opus', effort: 'high' }).success).toBe(true);
    expectTypeOf<Params<'sessions.create'>['model']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Params<'sessions.create'>['effort']>().toEqualTypeOf<'low' | 'medium' | 'high' | undefined>();
  });

  it('effort — low, medium или high; уровни, которых нет у обоих CLI, схема не пропускает', () => {
    for (const effort of ['low', 'medium', 'high']) expect(parse({ effort }).success).toBe(true);
    for (const effort of ['xhigh', 'max', 'minimal', 'HIGH', '', 3]) expect(parse({ effort }).success).toBe(false);
  });

  it('model — одно слово: алиас или полное имя, без пробелов и не похожее на флаг', () => {
    for (const model of ['opus', 'claude-sonnet-5', 'sonnet[1m]', 'gpt-5.5', 'o3']) {
      expect(parse({ model }).success).toBe(true);
    }
    // Значение с дефисом впереди CLI принял бы за флаг, а пустое или с пробелом — не модель.
    for (const model of ['', ' opus', 'два слова', '--dangerously-skip-permissions', '-m', 'а\nб']) {
      expect(parse({ model }).success).toBe(false);
    }
    expect(parse({ model: 'м'.repeat(200) }).success).toBe(true);
    expect(parse({ model: 'м'.repeat(201) }).success).toBe(false);
  });

  it('providers.list: models, effort и version необязательны — хост, переживший окно, их не знает', () => {
    expectTypeOf<Result<'providers.list'>['providers'][number]>().toEqualTypeOf<{
      id: string;
      label: string;
      available: boolean;
      models?: string[] | null;
      effort?: boolean;
      version?: string | null;
    }>();
    // Хост до дизайна комнат отдаёт элементы без новых полей — тип обязан это допускать.
    const legacy: Result<'providers.list'> = { providers: [{ id: 'claude', label: 'Claude', available: true }] };
    expect(legacy.providers[0]).not.toHaveProperty('effort');
  });
});
