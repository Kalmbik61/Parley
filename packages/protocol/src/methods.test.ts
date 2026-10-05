import { describe, expect, expectTypeOf, it } from 'vitest';
import { METHODS, NOTIFICATIONS } from './methods.js';
import type { Params, PermissionModeChoice, Result } from './methods.js';
import type { EventData } from './events.js';
import type { Capabilities, FeedCardState, FeedDecision, FeedItem, ModelOption, ProviderLimits } from './types.js';

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

  it('rooms.create: mode и снимок рецепта необязательны; снимок строгий, режим из трёх', () => {
    const base = { projectPath: '/p', workId: 'w-0001', title: 'Возвраты', members: ['s-02', 's-03'] };
    const parse = (extra: Record<string, unknown>) => METHODS['rooms.create'].safeParse({ ...base, ...extra });
    const recipe = { id: 'project:pay', name: 'Payments', playbook: 'Lead playbook' };

    expect(parse({}).success).toBe(true);
    expect(parse({ mode: 'verified', recipe }).success).toBe(true);
    expect(parse({ recipe: { ...recipe, playbook: '' } }).success).toBe(true);
    for (const mode of ['', 'strict', 1, null]) expect(parse({ mode }).success).toBe(false);
    for (const bad of [{ ...recipe, extra: 1 }, { id: 'a', name: 'b' }, { ...recipe, name: '' }, { ...recipe, playbook: 5 }, { ...recipe, playbook: 'x'.repeat(1024 * 1024 + 1) }, null, 'text'])
      expect(parse({ recipe: bad }).success).toBe(false);
    expectTypeOf<Params<'rooms.create'>['mode']>().toEqualTypeOf<'free' | 'checklist' | 'verified' | undefined>();
    expectTypeOf<Params<'rooms.create'>['recipe']>().toEqualTypeOf<{ id: string; name: string; playbook: string } | undefined>();
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
    expectTypeOf<Params<'sessions.create'>['model']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<Params<'sessions.create'>['effort']>().toEqualTypeOf<'low' | 'medium' | 'high' | null | undefined>();
  });

  it('effort — low, medium или high; уровни, которых нет у обоих CLI, схема не пропускает', () => {
    for (const effort of ['low', 'medium', 'high']) expect(parse({ effort }).success).toBe(true);
    for (const effort of ['xhigh', 'max', 'minimal', 'HIGH', '', 3]) expect(parse({ effort }).success).toBe(false);
  });

  it('model — одно слово: алиас или полное имя, без пробелов и не похожее на флаг', () => {
    for (const model of ['opus', 'claude-sonnet-5', 'sonnet[1m]', 'gpt-6-sol', 'o3']) {
      expect(parse({ model }).success).toBe(true);
    }
    // Значение с дефисом впереди CLI принял бы за флаг, а с пробелом — не модель.
    for (const model of [' opus', 'два слова', '--dangerously-skip-permissions', '-m', 'а\nб']) {
      expect(parse({ model }).success).toBe(false);
    }
    expect(parse({ model: 'м'.repeat(200) }).success).toBe(true);
    expect(parse({ model: 'м'.repeat(201) }).success).toBe(false);
  });

  it('пустая model — не ошибка схемы: «по умолчанию», без флага (решает хост)', () => {
    // Окно с выбранным «по умолчанию» может прислать пустую строку вместо пропуска поля.
    expect(parse({ model: '' }).success).toBe(true);
    expect(parse({ model: '', effort: 'high' }).success).toBe(true);
  });

  it('providers.list: models, effort, version и limits необязательны — хост, переживший окно, их не знает', () => {
    expectTypeOf<Result<'providers.list'>['providers'][number]>().toEqualTypeOf<{
      id: string;
      label: string;
      available: boolean;
      models?: Array<{ id: string; label: string }> | null;
      effort?: boolean;
      version?: string | null;
      limits?: ProviderLimits | null;
    }>();
    // Хост до дизайна комнат отдаёт элементы без новых полей — тип обязан это допускать.
    const legacy: Result<'providers.list'> = { providers: [{ id: 'claude', label: 'Claude', available: true }] };
    expect(legacy.providers[0]).not.toHaveProperty('effort');
  });

  it('providers.list: models — пары id и label; «списка нет» — null, а у хоста без поля его вовсе нет', () => {
    expectTypeOf<ModelOption>().toEqualTypeOf<{ id: string; label: string }>();
    const shapes: Result<'providers.list'> = {
      providers: [
        { id: 'claude', label: 'Claude', available: true, models: [{ id: 'opus', label: 'Opus' }] },
        { id: 'glm', label: 'GLM', available: true, models: null },
        { id: 'old', label: 'Old', available: true },
      ],
    };
    // Окно читает отсутствие поля так же, как null: контрола модели нет.
    expect(shapes.providers.map((provider) => provider.models ?? null)).toEqual([
      [{ id: 'opus', label: 'Opus' }],
      null,
      null,
    ]);
  });
});

describe('лента: feed.* (план 2026-10-01, Task 2)', () => {
  const ref = { projectPath: '/p', workId: 'w-0001', sessionId: 's-01' };
  const decide = (decision: unknown, cardId: unknown = 'permission:t1') =>
    METHODS['feed.decide'].safeParse({ ref, cardId, decision });
  const answers = (count: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`Q${i + 1}`, `A${i + 1}`]));

  it('feed.decide: разрешение, вопрос и план проходят', () => {
    expect(decide({ kind: 'permission', behavior: 'allow' }).success).toBe(true);
    expect(decide({ kind: 'permission', behavior: 'allow', always: true }).success).toBe(true);
    expect(decide({ kind: 'permission', behavior: 'deny', message: 'use rg' }).success).toBe(true);
    expect(decide({ kind: 'question', answers: { 'Which?': 'Red' } }, 'question:t2').success).toBe(true);
    expect(decide({ kind: 'plan', choice: 'auto-accept' }, 'plan:t3').success).toBe(true);
    expect(decide({ kind: 'plan', choice: 'manual' }, 'plan:t3').success).toBe(true);
  });

  it('feed.decide: текст отказа — до 4000 знаков', () => {
    const deny = (message: string) => decide({ kind: 'permission', behavior: 'deny', message });
    expect(deny('я'.repeat(4000)).success).toBe(true);
    expect(deny('я'.repeat(4001)).success).toBe(false);
  });

  it('feed.decide: ответы — до 20 вопросов, ответ до 16 КиБ', () => {
    const answer = (value: Record<string, string>) => decide({ kind: 'question', answers: value }, 'question:t2');
    expect(answer(answers(20)).success).toBe(true);
    expect(answer(answers(21)).success).toBe(false);
    expect(answer({ Q: 'x'.repeat(16 * 1024) }).success).toBe(true);
    expect(answer({ Q: 'x'.repeat(16 * 1024 + 1) }).success).toBe(false);
  });

  it('feed.interrupt: только ref сессии', () => {
    expect(METHODS['feed.interrupt'].safeParse({ ref }).success).toBe(true);
    expect(METHODS['feed.interrupt'].safeParse({}).success).toBe(false);
  });

  it('feed.decide: неизвестный вид решения, cardId длиннее 200 и без ref — отвергаются', () => {
    expect(decide({ kind: 'allow' }).success).toBe(false);
    expect(decide({ kind: 'permission', behavior: 'maybe' }).success).toBe(false);
    expect(decide({ kind: 'permission', behavior: 'allow' }, 'c'.repeat(200)).success).toBe(true);
    expect(decide({ kind: 'permission', behavior: 'allow' }, 'c'.repeat(201)).success).toBe(false);
    expect(
      METHODS['feed.decide'].safeParse({ cardId: 'x', decision: { kind: 'plan', choice: 'manual' } }).success,
    ).toBe(false);
  });

  it('feed.snapshot: agentId необязателен; только буквы, цифры, _ и -, до 80 знаков', () => {
    const snapshot = (extra: Record<string, unknown>) => METHODS['feed.snapshot'].safeParse({ ref, ...extra });
    expect(snapshot({}).success).toBe(true);
    expect(snapshot({ agentId: 'ad2fe21e96ffde3ba' }).success).toBe(true);
    expect(snapshot({ agentId: 'a'.repeat(80) }).success).toBe(true);
    for (const agentId of ['../etc', '../../x', 'a/b', '', 'a'.repeat(81), 'a.b', 'a b']) {
      expect(snapshot({ agentId }).success).toBe(false);
    }
  });

  it('feed.subscribe и feed.unsubscribe — ref', () => {
    expect(METHODS['feed.subscribe'].safeParse({ ref }).success).toBe(true);
    expect(METHODS['feed.unsubscribe'].safeParse({ ref }).success).toBe(true);
    expect(METHODS['feed.subscribe'].safeParse({}).success).toBe(false);
  });

  it('результаты feed.* и событие feed.changed', () => {
    expectTypeOf<Result<'feed.snapshot'>>().toEqualTypeOf<{
      items: FeedItem[];
      revision: number;
      schemaVersion: number;
      mode: string | null;
    }>();
    expectTypeOf<Result<'feed.subscribe'>>().toEqualTypeOf<{ ok: true }>();
    expectTypeOf<Result<'feed.unsubscribe'>>().toEqualTypeOf<{ ok: true }>();
    expectTypeOf<Result<'feed.decide'>>().toEqualTypeOf<{ applied: boolean; state: FeedCardState }>();
    expectTypeOf<EventData<'feed.changed'>>().toEqualTypeOf<{
      ref: { projectPath: string; workId: string; sessionId: string };
      revision: number;
      upsert: FeedItem[];
      removed: string[];
      mode: string | null;
    }>();
    expectTypeOf<Params<'feed.decide'>['decision']>().toEqualTypeOf<FeedDecision>();
  });
});

describe('sessions.setMode (план 2026-10-01, решение 4)', () => {
  const ref = { projectPath: '/p', workId: 'w', sessionId: 's' };

  it('принимает четыре режима окна и отвергает прочие', () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto']) {
      expect(METHODS['sessions.setMode'].safeParse({ ref, mode }).success).toBe(true);
    }
    for (const mode of ['bypassPermissions', 'dontAsk', '', 5]) {
      expect(METHODS['sessions.setMode'].safeParse({ ref, mode }).success).toBe(false);
    }
    expect(METHODS['sessions.setMode'].safeParse({ mode: 'plan' }).success).toBe(false);
  });

  it('результат и тип выбора', () => {
    expectTypeOf<Result<'sessions.setMode'>>().toEqualTypeOf<{ mode: string | null; verified: boolean }>();
    expectTypeOf<Params<'sessions.setMode'>['mode']>().toEqualTypeOf<PermissionModeChoice>();
  });
});

describe('capabilities.list (живая проверка 2026-10-02: подсказки поля ввода)', () => {
  it('принимает проект и провайдера, отвергает пустые', () => {
    expect(METHODS['capabilities.list'].safeParse({ projectPath: '/p', provider: 'claude' }).success).toBe(true);
    expect(METHODS['capabilities.list'].safeParse({ projectPath: '', provider: 'claude' }).success).toBe(false);
    expect(METHODS['capabilities.list'].safeParse({ projectPath: '/p' }).success).toBe(false);
  });

  it('результат — команды, скиллы и субагенты', () => {
    expectTypeOf<Result<'capabilities.list'>>().toEqualTypeOf<Capabilities>();
  });
});


describe('recipes.list', () => {
  it('принимает только абсолютно заданный проект без лишних полей', () => {
    expect(METHODS['recipes.list'].safeParse({ projectPath: '/p' }).success).toBe(true);
    expect(METHODS['recipes.list'].safeParse({ projectPath: '' }).success).toBe(false);
    expect(METHODS['recipes.list'].safeParse({ projectPath: '/p', extra: 1 }).success).toBe(false);
    expectTypeOf<Result<'recipes.list'>['partial']>().toEqualTypeOf<boolean>();
  });
});

describe('session role protocol compatibility', () => {
  const base = { projectPath: '/p', workId: null, provider: 'claude', label: 'Plan', task: '', parent: null };
  it('accepts old omitted choices, exact nullable clears, and source-qualified role data', () => {
    expect(METHODS['sessions.create'].safeParse(base).success).toBe(true);
    expect(METHODS['sessions.create'].safeParse({ ...base, model: null, effort: null, role: { source: 'builtin', name: 'planner' } })).toMatchObject({ success: true, data: { model: null, effort: null, role: { source: 'builtin', name: 'planner' } } });
    expect(METHODS['sessions.create'].safeParse({ ...base, role: { source: 'unknown', name: 'planner' } }).success).toBe(false);
  });
  it('accepts current participant scope for safe role listings', () => {
    expect(METHODS['roles.list'].safeParse({ projectPath: '/p', ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-1' } }).success).toBe(true);
    expect(METHODS['roles.list'].safeParse({ projectPath: '/p' }).success).toBe(true);
  });
});
