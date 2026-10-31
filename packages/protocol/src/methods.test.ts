import { describe, expect, expectTypeOf, it } from 'vitest';
import { EFFORT_TOKEN_RE, PROTOCOL_VERSION } from './index.js';
import type { EffortOption } from './index.js';
import { METHODS, NOTIFICATIONS } from './methods.js';
import type { Params, PermissionModeChoice, Result } from './methods.js';
import type { CustomAccountInfo, CustomProviderInfo } from './custom-providers.js';
import type { EventData } from './events.js';
import type { FeedDecisions } from './feed.js';
import type { Capabilities, FeedCardState, FeedDecision, FeedItem, ModelOption, ProviderCheck, ProviderCheckReason, ProviderLimits } from './types.js';
import { PROVIDER_CHECK_REASONS } from './types.js';
import * as protocolExports from './index.js';
import { progressLine, progressResult, type ProgressResult } from './feed-progress.js';

describe('feed.progress registration', () => {
  const ref = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };
  it('registers a strict ref-only method and preserves existing feed params', () => {
    expect(METHODS).toHaveProperty('feed.progress');
    expect(METHODS['feed.progress'].safeParse({ ref }).success).toBe(true);
    for (const extra of [{ agentId: 'agent' }, { path: '/secret' }, { limit: 20 }, { scope: 'attention' }, { generation: 1 }]) expect(METHODS['feed.progress'].safeParse({ ref, ...extra }).success).toBe(false);
    for (const value of [{}, { ref: null }, { ref: { sessionId: 's-01' } }]) expect(METHODS['feed.progress'].safeParse(value).success).toBe(false);
    expect(METHODS['feed.snapshot'].safeParse({ ref, agentId: 'agent', scope: 'attention' }).success).toBe(true);
    expect(NOTIFICATIONS).not.toHaveProperty('feed.progress');
  });
  it('exports schemas, bounds and result types through the public protocol entry point', () => {
    expect(protocolExports.progressLine).toBe(progressLine);
    expect(protocolExports.progressResult).toBe(progressResult);
    expect(protocolExports.FEED_PROGRESS_ID_LIMIT).toBe(128);
    expect(protocolExports.FEED_PROGRESS_RECENT_LIMIT).toBe(20);
    expect(protocolExports.FEED_PROGRESS_MAX_BYTES).toBe(16 * 1024);
    expectTypeOf<Params<'feed.progress'>>().toEqualTypeOf<{ ref: { projectPath: string; workId: string; sessionId: string } }>();
    expectTypeOf<Result<'feed.progress'>>().toEqualTypeOf<ProgressResult>();
  });
});

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
    expectTypeOf<Provider['needs']>().toEqualTypeOf<'cli' | 'key' | 'sign-in' | null | undefined>();
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

describe('rooms.send', () => {
  const base = { projectPath: '/p', workId: 'w-0001', roomId: 'r-01', to: [], text: 'hi', kind: 'note' };

  it('replyTo необязателен: со строкой и без поля схема проходит, пустая строка — нет', () => {
    expect(METHODS['rooms.send'].safeParse(base).success).toBe(true);
    const parsed = METHODS['rooms.send'].safeParse({ ...base, replyTo: 'm-1' });
    expect(parsed.success && parsed.data.replyTo).toBe('m-1');
    expect(METHODS['rooms.send'].safeParse({ ...base, replyTo: '' }).success).toBe(false);
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

  it('rooms.create: mode и снимок рецепта необязательны; снимок строгий, режим из четырёх', () => {
    const base = { projectPath: '/p', workId: 'w-0001', title: 'Возвраты', members: ['s-02', 's-03'] };
    const parse = (extra: Record<string, unknown>) => METHODS['rooms.create'].safeParse({ ...base, ...extra });
    const recipe = { id: 'project:pay', name: 'Payments', playbook: 'Lead playbook' };

    expect(parse({}).success).toBe(true);
    expect(parse({ mode: 'verified', recipe }).success).toBe(true);
    expect(parse({ recipe: { ...recipe, playbook: '' } }).success).toBe(true);
    for (const mode of ['', 'strict', 1, null]) expect(parse({ mode }).success).toBe(false);
    for (const bad of [{ ...recipe, extra: 1 }, { id: 'a', name: 'b' }, { ...recipe, name: '' }, { ...recipe, playbook: 5 }, { ...recipe, playbook: 'x'.repeat(1024 * 1024 + 1) }, null, 'text'])
      expect(parse({ recipe: bad }).success).toBe(false);
    expectTypeOf<Params<'rooms.create'>['mode']>().toEqualTypeOf<'free' | 'checklist' | 'verified' | 'autonomous' | undefined>();
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

  it('rooms.rename: название по правилу works.rename — края обрезаются, пустое и длиннее 120 кодовых точек не проходят', () => {
    const parse = (title: unknown) => METHODS['rooms.rename'].safeParse({ ...room, title });
    expect(parse('  Платежи\u200B ').data?.title).toBe('Платежи');
    for (const title of ['', '   ', '\u200B\u2060', '😀'.repeat(121), 5]) expect(parse(title).success).toBe(false);
    expect(parse('😀'.repeat(120)).success).toBe(true);
    expect(METHODS['rooms.rename'].safeParse({ projectPath: '/p', workId: 'w-0001', title: 'x' }).success).toBe(false);
    expectTypeOf<Result<'rooms.rename'>>().toEqualTypeOf<{ ok: true }>();
  });

  it('rooms.setLead: комната и сессия обязательны; ответ — id системной строки', () => {
    expect(METHODS['rooms.setLead'].safeParse({ ...room, sessionId: 's-02' }).success).toBe(true);
    expect(METHODS['rooms.setLead'].safeParse(room).success).toBe(false);
    expect(METHODS['rooms.setLead'].safeParse({ ...room, sessionId: 2 }).success).toBe(false);
    expectTypeOf<Result<'rooms.setLead'>>().toEqualTypeOf<{ messageId: string }>();
  });

  it('rooms.setOwner accepts an existing session id or null and requires the room address', () => {
    for (const sessionId of ['s-01', null]) {
      expect(METHODS['rooms.setOwner'].safeParse({ ...room, sessionId }).success).toBe(true);
    }
    expect(METHODS['rooms.setOwner'].safeParse(room).success).toBe(false);
    expect(METHODS['rooms.setOwner'].safeParse({ ...room, sessionId: 1 }).success).toBe(false);
    expectTypeOf<Result<'rooms.setOwner'>>().toEqualTypeOf<{ ok: true }>();
  });

  it('rooms.delete: только комната — сессии окно удаляет отдельно, через sessions.delete', () => {
    expect(METHODS['rooms.delete'].safeParse(room).success).toBe(true);
    expect(METHODS['rooms.delete'].safeParse({ projectPath: '/p', workId: 'w-0001' }).success).toBe(false);
    expectTypeOf<Params<'rooms.delete'>>().toEqualTypeOf<{ projectPath: string; workId: string; roomId: string }>();
    expectTypeOf<Result<'rooms.delete'>>().toEqualTypeOf<{ ok: true }>();
  });

  it('rooms.archive: комната и флажок stopSessions обязательны; ответ — ok', () => {
    expect(METHODS['rooms.archive'].safeParse({ ...room, stopSessions: true }).success).toBe(true);
    expect(METHODS['rooms.archive'].safeParse({ ...room, stopSessions: false }).success).toBe(true);
    // Умолчание флажка — дело окна: без него хост не знает, останавливать ли агентов.
    expect(METHODS['rooms.archive'].safeParse(room).success).toBe(false);
    expect(METHODS['rooms.archive'].safeParse({ ...room, stopSessions: 'yes' }).success).toBe(false);
    expect(METHODS['rooms.archive'].safeParse({ projectPath: '/p', workId: 'w-0001', stopSessions: true }).success).toBe(false);
    expectTypeOf<Params<'rooms.archive'>>().toEqualTypeOf<{
      projectPath: string;
      workId: string;
      roomId: string;
      stopSessions: boolean;
    }>();
    expectTypeOf<Result<'rooms.archive'>>().toEqualTypeOf<{ ok: true }>();
  });

  it('rooms.reopen: только комната; ответ — ok', () => {
    expect(METHODS['rooms.reopen'].safeParse(room).success).toBe(true);
    expect(METHODS['rooms.reopen'].safeParse({ projectPath: '/p', workId: 'w-0001' }).success).toBe(false);
    expectTypeOf<Params<'rooms.reopen'>>().toEqualTypeOf<{ projectPath: string; workId: string; roomId: string }>();
    expectTypeOf<Result<'rooms.reopen'>>().toEqualTypeOf<{ ok: true }>();
  });

  it('rooms.usage: комната обязательна', () => {
    expect(METHODS['rooms.usage'].safeParse(room).success).toBe(true);
    expect(METHODS['rooms.usage'].safeParse({ projectPath: '/p', workId: 'w-0001' }).success).toBe(false);
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

  it('sessions.create rejects new parent links', () => {
    expect(parse({ parent: null }).success).toBe(true);
    expect(parse({ parent: 's-01' }).success).toBe(false);
    expectTypeOf<Params<'sessions.create'>['parent']>().toEqualTypeOf<null>();
  });

  it('sessions.create: model и effort необязательны — старое окно их не шлёт', () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ model: 'opus', effort: 'high' }).success).toBe(true);
    expectTypeOf<Params<'sessions.create'>['model']>().toEqualTypeOf<string | null | undefined>();
    // Уровень — строка-токен: набор уровней у каждой модели свой (нормалайзер модели и effort, 5.6);
    // null — явное «по умолчанию» (снимает умолчание роли).
    expectTypeOf<Params<'sessions.create'>['effort']>().toEqualTypeOf<string | null | undefined>();
  });

  it('sessions.create: lean необязателен — старое окно его не шлёт, новое передаёт явный выбор', () => {
    expect(parse({}).success).toBe(true);
    expect(parse({}).data).not.toHaveProperty('lean');
    expect(parse({ lean: true })).toMatchObject({ success: true, data: { lean: true } });
    expect(parse({ lean: false })).toMatchObject({ success: true, data: { lean: false } });
    for (const lean of ['true', 1, null]) expect(parse({ lean }).success, JSON.stringify(lean)).toBe(false);
    expectTypeOf<Params<'sessions.create'>['lean']>().toEqualTypeOf<boolean | undefined>();
  });

  it('effort — токен уровня: прежние low, medium, high старого окна и новые xhigh, max, ultra проходят', () => {
    const good = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'none', 'a'.repeat(32)];
    for (const effort of good) expect(parse({ effort }).success, effort).toBe(true);
  });

  it('effort: заглавные, пробел, кавычка, пустое, 33 знака и не строка (кроме null) — отказ схемы: токен уходит в argv и в кавычки TOML', () => {
    // Принадлежность уровня модели проверяет хост (`bad_request`); схема держит только вид токена.
    const bad = ['HIGH', 'High', 'hi gh', '"max', 'max"', '', 'a'.repeat(33), '-high', '1high', 'high\n', 3];
    for (const effort of bad) expect(parse({ effort }).success, JSON.stringify(effort)).toBe(false);
  });

  it('effort: null — явный «по умолчанию» (снимает умолчание роли), схема его пропускает', () => {
    expect(parse({ effort: null }).success).toBe(true);
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
      needs?: 'cli' | 'key' | 'sign-in' | null;
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
      custom?: CustomProviderInfo | null;
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

  it('feed.snapshot: scope необязателен, допустим только attention', () => {
    const snapshot = (extra: Record<string, unknown>) => METHODS['feed.snapshot'].safeParse({ ref, ...extra });
    expect(snapshot({}).success).toBe(true);
    expect(snapshot({ scope: 'attention' }).success).toBe(true);
    for (const scope of ['full', '', 'Attention', 1, null]) expect(snapshot({ scope }).success).toBe(false);
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
      decisions?: FeedDecisions | null;
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
      decisions?: FeedDecisions | null;
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

describe('sessions.setKeepAwake (спека сна агентов, 4.1)', () => {
  const ref = { projectPath: '/p', workId: 'w', sessionId: 's' };
  const parse = (value: unknown) => METHODS['sessions.setKeepAwake'].safeParse(value);

  it('принимает сессию и булево значение; без значения, с не-булевым и без сессии — отказ', () => {
    for (const keepAwake of [true, false]) {
      expect(parse({ ref, keepAwake }).success, String(keepAwake)).toBe(true);
    }
    expect(parse({ ref }).success).toBe(false);
    for (const keepAwake of ['true', 1, 0, null]) {
      expect(parse({ ref, keepAwake }).success, JSON.stringify(keepAwake)).toBe(false);
    }
    expect(parse({ keepAwake: true }).success).toBe(false);
  });

  it('параметры и результат: сессия и новое значение; ответ — значение, которое стоит в карте', () => {
    expectTypeOf<Params<'sessions.setKeepAwake'>>().toEqualTypeOf<{
      ref: { projectPath: string; workId: string; sessionId: string };
      keepAwake: boolean;
    }>();
    expectTypeOf<Result<'sessions.setKeepAwake'>>().toEqualTypeOf<{ keepAwake: boolean }>();
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

describe('EFFORT_TOKEN_RE и совместимость (нормалайзер модели и effort, 5.3, 5.6)', () => {
  it('шаблон — как EFFORT_TOKEN в core: строчная буква, затем до 31 знака из строчных букв, цифр, _ и -; без флагов', () => {
    expect(EFFORT_TOKEN_RE.source).toBe('^[a-z][a-z0-9_-]{0,31}$');
    expect(EFFORT_TOKEN_RE.flags).toBe('');
  });

  it('протокол меняется только добавлениями: PROTOCOL_VERSION остаётся 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('sessions.setEffort (нормалайзер модели и effort, 5.7)', () => {
  const ref = { projectPath: '/p', workId: 'w-0001', sessionId: 's-01' };

  it('setEffort: ref и токен уровня обязательны; xhigh, max и ultra проходят', () => {
    const parse = (effort: unknown) => METHODS['sessions.setEffort'].safeParse({ ref, effort });
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      expect(parse(effort).success, effort).toBe(true);
    }
    // «По умолчанию» в идущей сессии не выбирается (5.7): пустого уровня нет и здесь.
    for (const effort of ['', 'HIGH', 'hi gh', '"max', 'a'.repeat(33), undefined, null, 3]) {
      expect(parse(effort).success, JSON.stringify(effort)).toBe(false);
    }
    expect(METHODS['sessions.setEffort'].safeParse({ effort: 'high' }).success).toBe(false);
  });

  it('параметры и результат: уровень, который показал подвал, и сверка', () => {
    expectTypeOf<Params<'sessions.setEffort'>>().toEqualTypeOf<{
      ref: { projectPath: string; workId: string; sessionId: string };
      effort: string;
    }>();
    expectTypeOf<Result<'sessions.setEffort'>>().toEqualTypeOf<{ effort: string | null; verified: boolean }>();
  });
});

describe('sessions.setModel (нормалайзер модели и effort, 5.8)', () => {
  const ref = { projectPath: '/p', workId: 'w-0001', sessionId: 's-01' };

  it('setModel: одно слово до 200 знаков, не с дефиса; флаг, пробелы и пустое — отказ', () => {
    const parse = (model: unknown) => METHODS['sessions.setModel'].safeParse({ ref, model });
    const good = ['opus', 'sonnet[1m]', 'glm-5.3-flash[1m]', 'gpt-6.1-sol', 'м'.repeat(200)];
    for (const model of good) expect(parse(model).success, model).toBe(true);
    // Модель уходит в argv (`--resume <id> --model <модель>`): с дефиса CLI принял бы её за флаг,
    // пробел разорвал бы её на два аргумента.
    const bad = ['-m', '--model', ' opus', 'op us', 'opus ', 'op\tus', 'а\nб', '', 'м'.repeat(201), undefined, null];
    for (const model of bad) expect(parse(model).success, JSON.stringify(model)).toBe(false);
    expect(METHODS['sessions.setModel'].safeParse({ model: 'opus' }).success).toBe(false);
  });

  it('параметры и результат: модель, уровень после смены и перезапуск', () => {
    expectTypeOf<Params<'sessions.setModel'>>().toEqualTypeOf<{
      ref: { projectPath: string; workId: string; sessionId: string };
      model: string;
    }>();
    expectTypeOf<Result<'sessions.setModel'>>().toEqualTypeOf<{
      model: string;
      effort: string | null;
      restarted: boolean;
    }>();
  });
});

describe('sessions.rename (часть 2 спеки архива комнат, 15)', () => {
  const ref = { projectPath: '/p', workId: 'w-0001', sessionId: 's-01' };
  const parse = (label: unknown) => METHODS['sessions.rename'].safeParse({ ref, label });

  it('ярлык по правилу works.rename: края обрезаются, пустое и длиннее 120 кодовых точек не проходят', () => {
    expect(parse('  Ruslan​ ').data?.label).toBe('Ruslan');
    for (const label of ['', '   ', '​⁠', '😀'.repeat(121), 5, undefined, null]) {
      expect(parse(label).success, JSON.stringify(label)).toBe(false);
    }
    expect(parse('😀'.repeat(120)).success).toBe(true);
    expect(METHODS['sessions.rename'].safeParse({ label: 'x' }).success).toBe(false);
  });

  it('параметры и результат: сессия и новый ярлык; ответ — ok', () => {
    expectTypeOf<Params<'sessions.rename'>>().toEqualTypeOf<{
      ref: { projectPath: string; workId: string; sessionId: string };
      label: string;
    }>();
    expectTypeOf<Result<'sessions.rename'>>().toEqualTypeOf<{ ok: true }>();
  });
});

describe('вход в аккаунт подписки (спека подписок 5.5)', () => {
  const NEW_METHODS = [
    'providers.authStatus',
    'providers.signIn',
    'providers.signInInput',
    'providers.signInResize',
    'providers.cancelSignIn',
    'providers.signOut',
  ] as const;

  it('шесть новых методов есть в METHODS и требуют провайдера строкой', () => {
    for (const name of NEW_METHODS) {
      expect(METHODS, name).toHaveProperty([name]);
      expect(METHODS[name].safeParse({}).success, name).toBe(false);
      expect(METHODS[name].safeParse({ provider: 42 }).success, name).toBe(false);
    }
    for (const name of ['providers.authStatus', 'providers.signIn', 'providers.cancelSignIn', 'providers.signOut'] as const) {
      expect(METHODS[name].safeParse({ provider: 'custom-claude-2' }).success, name).toBe(true);
    }
  });

  it('signInInput: данные не длиннее 4096', () => {
    const parse = (data: unknown) => METHODS['providers.signInInput'].safeParse({ provider: 'custom-claude-2', data });
    expect(parse('code-from-browser\r').success).toBe(true);
    expect(parse('x'.repeat(4096)).success).toBe(true);
    expect(parse('x'.repeat(4097)).success).toBe(false);
    expect(parse(42).success).toBe(false);
    expect(METHODS['providers.signInInput'].safeParse({ provider: 'custom-claude-2' }).success).toBe(false);
  });

  it('signInResize: cols 20..500 и rows 5..200, целые', () => {
    const parse = (cols: unknown, rows: unknown) => METHODS['providers.signInResize'].safeParse({ provider: 'codex-two', cols, rows });
    expect(parse(20, 5).success).toBe(true);
    expect(parse(500, 200).success).toBe(true);
    expect(parse(19, 24).success).toBe(false);
    expect(parse(501, 24).success).toBe(false);
    expect(parse(80, 4).success).toBe(false);
    expect(parse(80, 201).success).toBe(false);
    expect(parse(80.5, 24).success).toBe(false);
    expect(parse('80', 24).success).toBe(false);
  });

  it('результаты и события входа', () => {
    expectTypeOf<Result<'providers.authStatus'>>().toEqualTypeOf<{ signedIn: boolean; detail: string | null }>();
    expectTypeOf<Result<'providers.signIn'>>().toEqualTypeOf<{ ok: true }>();
    expectTypeOf<Result<'providers.signInInput'>>().toEqualTypeOf<{ ok: true }>();
    expectTypeOf<Result<'providers.signInResize'>>().toEqualTypeOf<{ ok: true }>();
    expectTypeOf<Result<'providers.cancelSignIn'>>().toEqualTypeOf<{ ok: true }>();
    expectTypeOf<Result<'providers.signOut'>>().toEqualTypeOf<{ ok: true }>();
    expectTypeOf<Params<'providers.signInInput'>>().toEqualTypeOf<{ provider: string; data: string }>();
    expectTypeOf<Params<'providers.signInResize'>>().toEqualTypeOf<{ provider: string; cols: number; rows: number }>();
    expectTypeOf<EventData<'providers.signInOutput'>>().toEqualTypeOf<{ provider: string; data: string }>();
    expectTypeOf<EventData<'providers.signInExit'>>().toEqualTypeOf<{ provider: string; exitCode: number; signedIn: boolean }>();
  });

  it('типы записи: providers.list.custom — запись с адресом (kind необязателен) или аккаунт', () => {
    type Provider = Result<'providers.list'>['providers'][number];
    expectTypeOf<Provider['custom']>().toEqualTypeOf<CustomProviderInfo | null | undefined>();
    // Хост и окно до подписок: запись с адресом без `kind` остаётся допустимой.
    const endpoint = {
      preset: null,
      baseUrl: 'https://api.example.com',
      auth: 'bearer',
      models: { opus: 'm', sonnet: 'm', haiku: 'm', subagent: 'm' },
      contextWindow: null,
      linkClaude: true,
      folder: '/home/u/.parley/providers/custom-x',
    } satisfies CustomProviderInfo;
    expect(endpoint).not.toHaveProperty('kind');
    const account = {
      kind: 'claude-account',
      link: true,
      folder: '/home/u/.parley/providers/custom-claude-2',
      signedIn: null,
      signingIn: false,
    } satisfies CustomAccountInfo;
    // Аккаунт — часть общего типа записи, а не отдельная форма: окно сужает его по `kind`.
    expectTypeOf(account).toMatchTypeOf<CustomProviderInfo>();
    expectTypeOf(account.signedIn).toEqualTypeOf<null>();
  });
});

describe('explicit autonomous resume', () => {
  const input = { projectPath: '/project', workId: 'w-01', roomId: 'r-01', planId: 'pl-01', rev: 4 };
  it('requires the displayed plan identity and excludes actor impersonation', () => {
    expect(METHODS['plans.resumeAutonomous']?.safeParse(input).success).toBe(true);
    for (const invalid of [{ ...input, rev: -1 }, { ...input, rev: Number.MAX_SAFE_INTEGER + 1 }, { ...input, roomId: undefined }, { ...input, requestedBy: 'engine' }])
      expect(METHODS['plans.resumeAutonomous']?.safeParse(invalid).success).toBe(false);
    expectTypeOf<Result<'plans.resumeAutonomous'>>().toEqualTypeOf<{ ok: true }>();
  });
});

it('accepts autonomous room creation and mode changes while rejecting unknown modes', () => {
  const create = { projectPath: '/p', workId: 'w-01', title: 'Engine', members: ['s-01', 's-02'] };
  const change = { projectPath: '/p', workId: 'w-01', roomId: 'r-01', reason: 'Human choice' };
  expect(METHODS['rooms.create'].safeParse({ ...create, mode: 'autonomous' }).success).toBe(true);
  expect(METHODS['rooms.setMode'].safeParse({ ...change, mode: 'autonomous' }).success).toBe(true);
  expect(METHODS['rooms.create'].safeParse({ ...create, mode: 'unknown' }).success).toBe(false);
  expect(METHODS['rooms.setMode'].safeParse({ ...change, mode: 'unknown' }).success).toBe(false);
});

describe('swarms.* — рой из окна (спека роя v1, 6)', () => {
  const work = { projectPath: '/p', workId: 'w-0001' };
  const create = { ...work, tag: 'Research', objective: 'Audit the repo', provider: 'claude' };

  it('swarms.create: тег 1–24 знака без перевода строки, задача до 4096; модель, effort и роль необязательны', () => {
    expect(METHODS['swarms.create'].safeParse(create).success).toBe(true);
    expect(METHODS['swarms.create'].safeParse({ ...create, tag: 'Аудит', model: 'opus', effort: 'high', role: null }).success).toBe(true);
    expect(METHODS['swarms.create'].safeParse({ ...create, role: { source: 'builtin', name: 'researcher' } }).success).toBe(true);
    for (const tag of ['', 'x'.repeat(25), 'a\nb', 'a\rb']) expect(METHODS['swarms.create'].safeParse({ ...create, tag }).success).toBe(false);
    expect(METHODS['swarms.create'].safeParse({ ...create, tag: 'x'.repeat(24) }).success).toBe(true);
    expect(METHODS['swarms.create'].safeParse({ ...create, objective: 'x'.repeat(4097) }).success).toBe(false);
    expect(METHODS['swarms.create'].safeParse({ ...create, model: '-flag' }).success).toBe(false);
    expect(METHODS['swarms.create'].safeParse({ ...work, tag: 'Research', objective: 'x' }).success).toBe(false);
    expectTypeOf<Result<'swarms.create'>>().toEqualTypeOf<{ swarmId: string; queenSessionId: string }>();
  });

  it('swarms.cancel и swarms.seen: работа и id роя обязательны; ответ — ok', () => {
    for (const method of ['swarms.cancel', 'swarms.seen'] as const) {
      expect(METHODS[method].safeParse({ ...work, swarmId: 'sw-01' }).success).toBe(true);
      expect(METHODS[method].safeParse(work).success).toBe(false);
      expectTypeOf<Result<typeof method>>().toEqualTypeOf<{ ok: true }>();
    }
  });

  it('виды уведомлений роя входят в NoticeKind', () => {
    expectTypeOf<'swarm-done' | 'swarm-failed'>().toExtend<import('./types.js').NoticeKind>();
  });
});

describe('очередь запусков машины в протоколе', () => {
  it('уведомление о запуске сверх потолка входит в NoticeKind', () => {
    expectTypeOf<'machine-over-limit'>().toExtend<import('./types.js').NoticeKind>();
  });

  it('запуск в очереди — причина, по которой письмо ещё не забрано (MailWait)', () => {
    expectTypeOf<'queued'>().toExtend<import('./types.js').MailWait>();
  });
});

describe('sessions.switchOptions / sessions.switchAgent', () => {
  const ref = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };
  const requestId = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
  const parse = (v: unknown) => METHODS['sessions.switchAgent'].safeParse(v);
  it('switchOptions принимает только ref', () => {
    expect(METHODS['sessions.switchOptions'].safeParse({ ref }).success).toBe(true);
    expect(METHODS['sessions.switchOptions'].safeParse({}).success).toBe(false);
  });
  it('валидные параметры разбираются; без carry — handover', () => {
    const r = parse({ ref, requestId, provider: 'codex' });
    expect(r.success && r.data.carry).toBe('handover');
    const full = parse({ ref, requestId, provider: 'claude', model: null, effort: 'high', carry: 'transcript', force: true });
    expect(full.success && full.data.carry).toBe('transcript');
  });
  it('кривой requestId, провайдер, carry и effort отклоняются', () => {
    expect(parse({ ref, requestId: 'nope', provider: 'codex' }).success).toBe(false);
    expect(parse({ ref, requestId, provider: '' }).success).toBe(false);
    expect(parse({ ref, requestId, provider: 'codex', carry: 'x' }).success).toBe(false);
    expect(parse({ ref, requestId, provider: 'codex', effort: 'High!' }).success).toBe(false);
  });
  it('результат switchAgent и тип лимитов цели', () => {
    expectTypeOf<Result<'sessions.switchAgent'>['outcome']>().toEqualTypeOf<'started' | 'held'>();
    expectTypeOf<Result<'sessions.switchOptions'>['targets'][number]['limits']>().toEqualTypeOf<ProviderLimits | null>();
  });
});
