import { describe, expect, expectTypeOf, it } from 'vitest';
import { EFFORT_TOKEN_RE, PROTOCOL_VERSION } from './index.js';
import type { EffortOption } from './index.js';
import { METHODS, NOTIFICATIONS } from './methods.js';
import type { Params, PermissionModeChoice, Result } from './methods.js';
import type { EventData } from './events.js';
import type { Capabilities, FeedCardState, FeedDecision, FeedItem, ModelOption, ProviderCheck, ProviderCheckReason, ProviderLimits } from './types.js';
import { PROVIDER_CHECK_REASONS } from './types.js';

describe('providers.check — явная проверка ключа тестовым запросом', () => {
  it('принимает провайдера строкой; без провайдера — отказ', () => {
    expect(METHODS['providers.check'].safeParse({ provider: 'glm' }).success).toBe(true);
    expect(METHODS['providers.check'].safeParse({}).success).toBe(false);
    expect(METHODS['providers.check'].safeParse({ provider: 42 }).success).toBe(false);
  });

  it('отдаёт исход проверки или null (провайдер не готов локально); в списке — необязательное поле', () => {
    expectTypeOf<Result<'providers.check'>>().toEqualTypeOf<{ check: ProviderCheck | null }>();
    type Provider = Result<'providers.list'>['providers'][number];
    expectTypeOf<Provider['check']>().toEqualTypeOf<ProviderCheck | null | undefined>();
  });

  it('список причин закрыт, без повторов и совпадает с типом', () => {
    expectTypeOf<(typeof PROVIDER_CHECK_REASONS)[number]>().toEqualTypeOf<ProviderCheckReason>();
    expect(new Set(PROVIDER_CHECK_REASONS).size).toBe(PROVIDER_CHECK_REASONS.length);
  });
});

describe('provider key protocol additions', () => {
  it('accepts key mutations and rejects non-string inputs', () => {
    expect(METHODS['providers.setKey'].safeParse({ provider: 'glm', key: 'fake-key' }).success).toBe(true);
    expect(METHODS['providers.setKey'].safeParse({ provider: 'glm', key: 42 }).success).toBe(false);
    expect(METHODS['providers.clearKey'].safeParse({ provider: 'glm' }).success).toBe(true);
    expect(METHODS['providers.clearKey'].safeParse({}).success).toBe(false);
  });

  it('keeps list additions optional and exposes only a hint in mutation results', () => {
    type Provider = Result<'providers.list'>['providers'][number];
    expectTypeOf<Provider['needs']>().toEqualTypeOf<'cli' | 'key' | null | undefined>();
    expectTypeOf<Provider['keyHint']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<Provider['family']>().toEqualTypeOf<'claude' | null | undefined>();
    expectTypeOf<Result<'providers.setKey'>>().toEqualTypeOf<{ keyHint: string }>();
    expectTypeOf<Result<'providers.clearKey'>>().toEqualTypeOf<{ ok: true }>();
    expectTypeOf<EventData<'providers.changed'>>().toEqualTypeOf<{ provider: string }>();
  });
});

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
    // Уровень — строка-токен: набор уровней у каждой модели свой (нормалайзер модели и effort, 5.6).
    expectTypeOf<Params<'sessions.create'>['effort']>().toEqualTypeOf<string | undefined>();
  });

  it('effort — токен уровня: прежние low, medium, high старого окна и новые xhigh, max, ultra проходят', () => {
    const good = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'none', 'a'.repeat(32)];
    for (const effort of good) expect(parse({ effort }).success, effort).toBe(true);
  });

  it('effort: заглавные, пробел, кавычка, пустое, 33 знака и не строка — отказ схемы: токен уходит в argv и в кавычки TOML', () => {
    // Принадлежность уровня модели проверяет хост (`bad_request`); схема держит только вид токена.
    const bad = ['HIGH', 'High', 'hi gh', '"max', 'max"', '', 'a'.repeat(33), '-high', '1high', 'high\n', 3, null];
    for (const effort of bad) expect(parse({ effort }).success, JSON.stringify(effort)).toBe(false);
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

  it('providers.list: models, effort, argsOverridden, version, limits и check необязательны — хост, переживший окно, их не знает', () => {
    expectTypeOf<Result<'providers.list'>['providers'][number]>().toEqualTypeOf<{
      id: string;
      label: string;
      available: boolean;
      needs?: 'cli' | 'key' | null;
      keyHint?: string | null;
      family?: 'claude' | null;
      models?: Array<{
        id: string;
        label: string;
        efforts?: Array<{ id: string; label: string; description?: string }> | null;
      }> | null;
      effort?: boolean;
      argsOverridden?: boolean;
      version?: string | null;
      limits?: ProviderLimits | null;
      check?: ProviderCheck | null;
    }>();
    // Хост до дизайна комнат отдаёт элементы без новых полей — тип обязан это допускать.
    const legacy: Result<'providers.list'> = { providers: [{ id: 'claude', label: 'Claude', available: true }] };
    expect(legacy.providers[0]).not.toHaveProperty('effort');
    expect(legacy.providers[0]).not.toHaveProperty('argsOverridden');
  });

  it('providers.list: у модели efforts — уровни по порядку, null — уровней нет (Haiku), поля нет — хост до нормалайзера', () => {
    const shapes: Result<'providers.list'> = {
      providers: [
        {
          id: 'claude',
          label: 'Claude',
          available: true,
          effort: true,
          models: [
            {
              id: 'opus',
              label: 'Opus',
              efforts: [
                { id: 'low', label: 'Low' },
                { id: 'xhigh', label: 'Extra high' },
              ],
            },
            { id: 'haiku', label: 'Haiku', efforts: null },
          ],
        },
        {
          id: 'codex',
          label: 'Codex',
          available: true,
          effort: true,
          models: [
            {
              id: 'gpt-6.1-sol',
              label: 'GPT-6.1-Sol',
              efforts: [
                { id: 'ultra', label: 'Ultra', description: 'Maximum reasoning with automatic task delegation' },
              ],
            },
            // Хост до нормалайзера: у модели нет efforts — окно читает прежние три уровня.
            { id: 'gpt-6-sol', label: 'GPT-6-Sol' },
          ],
        },
        // args из providers.json без {model} и {effort}: выбора нет, карточка объясняет почему.
        {
          id: 'custom',
          label: 'Custom',
          available: true,
          models: null,
          effort: false,
          argsOverridden: true,
        },
      ],
    };
    const levels = shapes.providers
      .flatMap((provider) => provider.models ?? [])
      .map((model) =>
        model.efforts === undefined ? 'нет поля' : (model.efforts?.map((effort) => effort.id) ?? null),
      );

    expect(levels).toEqual([['low', 'xhigh'], null, ['ultra'], 'нет поля']);
    expect(shapes.providers.map((provider) => provider.argsOverridden ?? false)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('providers.list: models — пары id и label; «списка нет» — null, а у хоста без поля его вовсе нет', () => {
    expectTypeOf<ModelOption>().toEqualTypeOf<{
      id: string;
      label: string;
      efforts?: EffortOption[] | null;
    }>();
    expectTypeOf<EffortOption>().toEqualTypeOf<{ id: string; label: string; description?: string }>();
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

describe('EFFORT_TOKEN_RE и совместимость (нормалайзер модели и effort, 5.3, 5.6)', () => {
  it('шаблон — как EFFORT_TOKEN в core: строчная буква, затем до 31 знака из строчных букв, цифр, _ и -; без флагов', () => {
    expect(EFFORT_TOKEN_RE.source).toBe('^[a-z][a-z0-9_-]{0,31}$');
    expect(EFFORT_TOKEN_RE.flags).toBe('');
  });

  it('протокол меняется только добавлениями: PROTOCOL_VERSION остаётся 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
