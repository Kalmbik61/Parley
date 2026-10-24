import { describe, expect, it } from 'vitest';
import { ACCOUNT_MIN_VERSION_CLAUDE, PAGE_DATA_NOTE } from '@parley/core';
import type { ErrorCode, HostNotice, NoticeKind } from '@parley/protocol';
import { errorText, noticeText, providerName, S, startErrorText } from './strings.js';

const CYRILLIC = /[Ѐ-ӿ]/;

/** Все семь кодов протокола (`packages/protocol/src/types.ts#ErrorCode`) плюс наш `'failed'`. */
const PROTOCOL_CODES: ErrorCode[] = [
  'unauthorized',
  'protocol_mismatch',
  'bad_request',
  'unknown_method',
  'not_found',
  'conflict',
  'internal',
];

/** Все виды `NoticeKind` (`packages/protocol/src/types.ts`). */
const NOTICE_KINDS: NoticeKind[] = [
  'map-lock',
  'map-corrupt',
  'map-migration-failed',
  'hooks-missing',
  'launch-failed',
  'pointer-timeout',
  'pointer-cancelled',
  'resume-failed',
  'resume-limit',
  'trust-wait',
  'startup-wait',
  'skill-foreign',
  'parley-md-created',
  'parley-md-unreadable',
  'parley-md-truncated',
  'provider-override-gap',
  'memory-truncated',
  'memory-unreadable',
  'plan-effect-failed',
  'role-truncated',
  'recipe-playbook-truncated',
  'compact-cancelled',
  'compact-failed',
  'limit-return-blocked',
];

/** `notice.text` — заведомо чужой для окна маркер (раунд исправлений 1 куска E.1) — чтобы поймать случайную подстановку. */
function hostNotice(kind: NoticeKind, ref: HostNotice['ref'] = null): HostNotice {
  return { kind, ref, text: 'РУССКИЙ_ТЕКСТ_ХОСТА_НЕ_ДОЛЖЕН_ПОПАСТЬ_В_РЕЗУЛЬТАТ', at: '2026-01-01T00:00:00.000Z' };
}

describe('S.states', () => {
  // Слова состояний — строчными (спека окна 2026-09-29, 1.2): `working`, `needs you`, `done · unseen`…
  it('содержит девять слов глоссария (спека 4.2), строчными (спека 1.2 Organic)', () => {
    expect(S.states).toEqual({
      working: 'working',
      blocked: 'needs you',
      unseen: 'done · unseen',
      idle: 'idle',
      pending: 'not started',
      asleep: 'asleep',
      closed: 'closed',
      done: 'done',
      failed: 'failed',
    });
  });

  it('ни одно слово состояния не содержит кириллицы', () => {
    for (const word of Object.values(S.states)) {
      expect(word).not.toMatch(CYRILLIC);
    }
  });
});

// Имя провайдера для строки статуса и тултипов окна (спека 1.1, решение 3): по handoff — «Claude Code» и
// «Codex», прочим — метка хоста. Одна функция: ту же берёт тултип свёрнутой комнаты «2 Claude Code agents».
describe('S.sidebar — тексты карточки и строк (Organic, 1.2)', () => {
  it('тултип «+» заголовка проекта называет проект', () => {
    expect(S.sidebar.newWorkspaceInProject('shop')).toBe('New workspace in shop');
  });

  it('тултипы ✉N и #N — с числом и единственным числом при одном', () => {
    expect(S.sidebar.unreadMail(1)).toBe('1 unread message to you');
    expect(S.sidebar.unreadMail(3)).toBe('3 unread messages to you');
    expect(S.sidebar.roomsWithUnread(1)).toBe('1 room with unread messages');
    expect(S.sidebar.roomsWithUnread(2)).toBe('2 rooms with unread messages');
  });

  it('тултип ветки своего worktree, «N more closed» и «Hide closed»', () => {
    expect(S.sidebar.ownWorktree('harnas/s-01')).toBe('Own worktree · harnas/s-01');
    expect(S.sidebar.moreClosed(2)).toBe('2 more closed');
    expect(S.sidebar.hideClosed).toBe('Hide closed');
  });

  // Спека архива комнат и проектов, 6, 6.2 и 6.3: ссылка группы проекта, текст архивации работы, «Remove from list…».
  it('ссылка группы проекта, подтверждение архивации работы и «Remove from list…» — тексты спеки', () => {
    expect(S.sidebar.archivedWorks(3)).toBe('3 archived');
    expect(S.sidebar.hideArchivedWorks).toBe('Hide archived');
    expect(S.cardMenu.archiveConfirmDescription).toBe(
      'Running agents will be stopped. Find it under "archived" at the bottom of its project, then "Reopen" it to resume them.',
    );
    expect(S.sidebar.removeFromList).toBe('Remove from list…');
    expect(S.sidebar.removeFromListBlocked).toBe('Archive its workspaces first');
    expect(S.sidebar.removeProjectTitle('shop')).toBe('Remove "shop" from the list?');
    expect(S.sidebar.removeProjectDescription).toBe(
      'Its workspaces stay on disk. The project comes back when a workspace is created in it.',
    );
    expect(S.sidebar.removeProjectConfirm).toBe('Remove');
  });

  // Кусок 5 плана «Organic»: строка комнаты (1.2) и строка «New session or room» под строками карточки.
  it('строка комнаты: шеврон, слова состояния, `★` ведущего', () => {
    expect(S.sidebar.showAgents).toBe('Show agents');
    expect(S.sidebar.hideAgents).toBe('Hide agents');
    expect(S.sidebar.roomDecision).toBe('decision');
    expect(S.sidebar.roomNew(3)).toBe('3 new');
    expect(S.sidebar.lead).toBe('Lead');
    expect(S.sidebar.newSessionOrRoom).toBe('New session or room');
  });

  it('тултип значка провайдера свёрнутой комнаты — число и имя провайдера, единственное число при одном', () => {
    expect(S.sidebar.roomAgents(2, providerName('claude', 'Claude'))).toBe('2 Claude Code agents');
    expect(S.sidebar.roomAgents(1, providerName('claude', 'Claude'))).toBe('1 Claude Code agent');
    expect(S.sidebar.roomAgents(3, providerName('codex', 'OpenAI Codex'))).toBe('3 Codex agents');
    expect(S.sidebar.roomAgents(1, providerName('gemini', 'Gemini CLI'))).toBe('1 Gemini CLI agent');
  });

  it('тултип строки комнаты: ведущий и участники; комната без живых участников — без ведущего', () => {
    expect(S.sidebar.roomTooltip('S01', ['S01', 'S02', 'S03', 'S04'])).toBe('Room · lead S01 · S01, S02, S03, S04');
    expect(S.sidebar.roomTooltip(null, ['S01'])).toBe('Room · S01');
    expect(S.sidebar.roomTooltip(null, [])).toBe('Room');
  });
});

describe('S.terminal — карточка неживой сессии (Organic, 1.8)', () => {
  it('последнее событие и суффикс «ago»', () => {
    expect(S.terminal.lastEvent('3h ago')).toBe('last event 3h ago');
    expect(S.time.ago('3h')).toBe('3h ago');
  });
});

// Тост о новой версии и переключатель в настройках (V6 плана релиза 0.1.0): всё по-английски, имя продукта — Parley.
describe('S.update и S.settings.checkForUpdates', () => {
  it('тост: «Parley X.Y.Z is available», кнопки «Download» и «Later»', () => {
    expect(S.update.available('0.2.0')).toBe('Parley 0.2.0 is available');
    expect(S.update.available('10.0.1')).toBe('Parley 10.0.1 is available');
    expect(S.update.download).toBe('Download');
    expect(S.update.later).toBe('Later');
  });

  it('переключатель: «Check for updates» и пояснение о GitHub', () => {
    expect(S.settings.checkForUpdates).toBe('Check for updates');
    expect(S.settings.checkForUpdatesHint).toMatch(/GitHub/);
  });

  it('ни одного кириллического знака', () => {
    const texts = [
      S.update.available('0.2.0'),
      S.update.download,
      S.update.later,
      S.settings.checkForUpdates,
      S.settings.checkForUpdatesHint,
    ];
    for (const text of texts) expect(text).not.toMatch(CYRILLIC);
  });
});

describe('providerName', () => {
  it('claude — «Claude Code», codex — «Codex», независимо от метки хоста', () => {
    expect(providerName('claude', 'Claude')).toBe('Claude Code');
    expect(providerName('codex', 'OpenAI Codex')).toBe('Codex');
  });

  it('регистр id не важен, как и у значка провайдера', () => {
    expect(providerName('Claude', 'x')).toBe('Claude Code');
    expect(providerName('CODEX', 'x')).toBe('Codex');
  });

  it('прочим провайдерам — метка, которую отдал хост', () => {
    expect(providerName('gemini', 'Gemini CLI')).toBe('Gemini CLI');
  });

  it('пустая метка — сам id, а не пустая строка', () => {
    expect(providerName('gemini', '')).toBe('gemini');
  });
});

describe('errorText', () => {
  it.each(PROTOCOL_CODES)('код протокола %s даёт непустой английский текст', (code) => {
    const text = errorText(code);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(CYRILLIC);
  });

  it.each(PROTOCOL_CODES)('код протокола %s с action тоже без кириллицы', (code) => {
    const text = errorText(code, 'create session');
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(CYRILLIC);
    expect(text).toContain('create session');
  });

  it('наш код failed даёт непустой текст', () => {
    expect(errorText('failed').length).toBeGreaterThan(0);
  });

  it('неизвестный код — тот же общий текст, что и failed', () => {
    expect(errorText('no-such-code')).toBe(errorText('failed'));
  });

  it('action встраивается в фразу целиком', () => {
    expect(errorText('conflict', 'merge')).toBe("Couldn't merge: conflicting state.");
  });

  it('без action — только причина с большой буквы', () => {
    expect(errorText('not_found')).toBe('Not found.');
  });
});

describe('startErrorText — отказ запуска называет причину и что делать', () => {
  const refused = (data: Record<string, unknown>) => ({
    code: 'conflict',
    message: 'session limit reached: raw technical host text',
    data: { code: 'resource-budget', ...data },
  });

  it('concurrent в комнате: счёт, где, что сделать и название настройки', () => {
    expect(startErrorText(refused({ reason: 'concurrent', scope: 'room', limit: 6, used: 6 }), 'resume Bruno')).toBe(
      'Couldn\'t resume Bruno: 6 of 6 sessions are already running in this room. Put one to sleep or raise "Running sessions, room" in Settings.',
    );
  });

  it('concurrent в работе: «workspace» и настройка работы', () => {
    const text = startErrorText(refused({ reason: 'concurrent', scope: 'work', limit: 10, used: 10 }), 'create session');
    expect(text).toContain('10 of 10 sessions are already running in this workspace');
    expect(text).toContain(`"${S.settings.limits.workConcurrent}"`);
  });

  it('launches: запуски за последний час и настройка по области', () => {
    const text = startErrorText(refused({ reason: 'launches', scope: 'room', limit: 20, used: 20 }), 'resume session');
    expect(text).toContain('20 of 20 starts and wake-ups in the last hour in this room');
    expect(text).toContain(`"${S.settings.limits.roomLaunches}"`);
  });

  it.each([
    ['new-sessions', 'work', 'workNewSessions'],
    ['messages', 'room', 'roomMessages'],
    ['fanout', 'work', 'fanout'],
  ] as const)('reason %s называет свою настройку', (reason, scope, key) => {
    const text = startErrorText(refused({ reason, scope, limit: 3, used: 4 }), 'start');
    expect(text).toContain(`"${S.settings.limits[key]}"`);
    expect(text).not.toContain('raw technical host text');
  });

  it('resume-rate: короткая фраза про пробуждения сессии', () => {
    expect(startErrorText(refused({ reason: 'resume-rate', scope: 'session', limit: 6, used: 6 }), 'resume session')).toMatch(
      /^Couldn't resume session: 6 of 6 wake-ups of this session in the last hour\./,
    );
  });

  it('неизвестный reason: limit и used без названия настройки', () => {
    expect(startErrorText(refused({ reason: 'brand-new', scope: 'work', limit: 5, used: 7 }), 'start')).toBe(
      "Couldn't start: a limit was reached (7 of 5). Wait a while or check the limits in Settings.",
    );
  });

  it('поля не пришли: фраза без чисел, но с причиной', () => {
    expect(startErrorText(refused({ reason: 'concurrent' }), 'start')).toMatch(/^Couldn't start: .*running.*Settings\.$/);
  });

  it('прочие ошибки — прежний errorText', () => {
    expect(startErrorText({ code: 'conflict', message: 'x' }, 'merge')).toBe(errorText('conflict', 'merge'));
    expect(startErrorText({ code: 'conflict', message: 'x', data: { code: 'other' } }, 'merge')).toBe(errorText('conflict', 'merge'));
  });
});

// Раунд исправлений 1 куска E.1 (ревью линза A, Critical): HostNotice.text
// приходит рантаймом по сокету, страж `english-ui` его не ловит. `noticeText` —
// английский смысл по `notice.kind`, параллельно `errorText(code)`.
describe('noticeText', () => {
  it.each(NOTICE_KINDS)('вид %s без ярлыка — непустой английский текст без кириллицы', (kind) => {
    const text = noticeText(hostNotice(kind));
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(CYRILLIC);
  });

  it.each(NOTICE_KINDS)('вид %s не подставляет русский notice.text хоста в результат', (kind) => {
    expect(noticeText(hostNotice(kind))).not.toContain('РУССКИЙ_ТЕКСТ_ХОСТА');
  });

  it('без ярлыка — фраза с большой буквы и точкой', () => {
    expect(noticeText(hostNotice('trust-wait'))).toBe(
      'Not responding since launch — may be waiting for folder trust.',
    );
  });

  it('с ярлыком — ярлык впереди через двоеточие, без кириллицы', () => {
    const ref = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-03' };
    const text = noticeText(hostNotice('trust-wait', ref), 'S03 backend');
    expect(text).toBe('S03 backend: not responding since launch — may be waiting for folder trust.');
    expect(text).not.toMatch(CYRILLIC);
  });

  it('startup-wait — причина: Codex на экране входа или доверия, отвечать надо в его терминале', () => {
    expect(noticeText(hostNotice('startup-wait'))).toBe(
      'Waiting at startup — Codex may need sign-in or folder trust in its terminal.',
    );
    const ref = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-03' };
    expect(noticeText(hostNotice('startup-wait', ref), 'S03 codex')).toBe(
      'S03 codex: waiting at startup — Codex may need sign-in or folder trust in its terminal.',
    );
  });

  it('limit-return-blocked — лимит сброшен, а сессию вернуть не вышло (спека застрявших 7.1)', () => {
    expect(S.notifications.limitReturnBlocked).toBe('limit has reset');
    expect(noticeText(hostNotice('limit-return-blocked'))).toBe(
      'The limit has reset, but Parley could not continue this session — check its terminal.',
    );
  });

  // Слова — как у хоста, гида и README: строка, которую хост набирает в терминал агента, — «pointer»,
  // письма — «messages», а не «nudge» и «mail».
  it('pointer-* и resume-limit: «pointer» и «messages» — как в сообщениях хоста', () => {
    expect(noticeText(hostNotice('pointer-timeout'))).toBe('No response after the pointer.');
    expect(noticeText(hostNotice('pointer-cancelled'))).toBe('Pointer cancelled by your input.');
    expect(noticeText(hostNotice('resume-limit'))).toBe('Hourly resume limit reached — messages are waiting.');
  });

  it('skill-foreign (ref: null) — английский смысл: скилл не поставлен, путь чужой', () => {
    expect(noticeText(hostNotice('skill-foreign'))).toBe(
      "Agent skill not installed — that path already exists and wasn't created by Parley.",
    );
  });

  it('map-migration-failed (ref: null), текст не путь map.json — общая фраза: работа осталась в прежнем файле (спека хранилища 6.6)', () => {
    expect(noticeText(hostNotice('map-migration-failed'))).toBe(
      "A workspace couldn't be moved to the new storage; it stays in its old file.",
    );
  });

  it('map-migration-failed называет работу и папку проекта по пути map.json; причина со следующей строки в окно не попадает', () => {
    const notice = (text: string): HostNotice => ({ kind: 'map-migration-failed', ref: null, text, at: '2026-01-01T00:00:00.000Z' });
    const expected =
      "Workspace w-0051 in scanum couldn't be moved to the new storage — it is hidden until this is fixed. Details are in the host log.";
    expect(noticeText(notice('/Users/me/Desktop/scanum/.parley/works/w-0051/map.json'))).toBe(expected);
    expect(noticeText(notice('/Users/me/Desktop/scanum/.parley/works/w-0051/map.json\nbusy: map.lock is held by a running process'))).toBe(
      expected,
    );
    // Проект ещё на прежнем имени каталога состояния и с пробелом в имени.
    expect(noticeText(notice('/p/my shop/.harnas/works/w-0002/map.json\nSyntaxError: Unexpected token'))).toBe(
      "Workspace w-0002 in my shop couldn't be moved to the new storage — it is hidden until this is fixed. Details are in the host log.",
    );
    expect(noticeText(notice('/p/shop/.parley/works/w-0003/map.json\nreason'))).not.toMatch(CYRILLIC);
  });

  it('map-migration-failed: путь не той формы или без проекта — общая фраза', () => {
    const notice = (text: string): HostNotice => ({ kind: 'map-migration-failed', ref: null, text, at: '2026-01-01T00:00:00.000Z' });
    const generic = "A workspace couldn't be moved to the new storage; it stays in its old file.";
    expect(noticeText(notice('/p/shop/.parley/works/w-0003/map.v2.json'))).toBe(generic);
    expect(noticeText(notice('/p/shop/map.json'))).toBe(generic);
    expect(noticeText(notice('/.parley/works/w-0001/map.json'))).toBe(generic);
    expect(noticeText(notice(''))).toBe(generic);
  });

  it('map-lock и map-corrupt (ref: null, без сессии) тоже дают английский текст', () => {
    expect(noticeText(hostNotice('map-lock'))).not.toMatch(CYRILLIC);
    expect(noticeText(hostNotice('map-corrupt'))).not.toMatch(CYRILLIC);
  });
});


it('backlog labels and safe warnings are English and do not interpolate raw errors', () => {
  const labels = [S.backlog.title, S.backlog.failed, S.backlog.liveUnavailable, S.backlog.markFailed, ...Object.values(S.backlog.ignore)];
  for (const label of labels) { expect(label).not.toMatch(/[А-Яа-яЁё]/); expect(label.length).toBeGreaterThan(0); }
  expect(S.backlog.suggested(3)).toBe('Suggested (3)'); expect(S.backlog.itemTaken('w-01/r-01')).toBe('Taken: w-01/r-01');
});

it('plugin strings distinguish unknown cost, data loss and native recovery without promising live adoption',()=>{
 expect(S.capabilities.plugins.unknown).toBe('Unknown');expect(S.capabilities.plugins.dataLoss).toContain('permanently delete');
 expect(S.capabilities.plugins.appliesToNew).toContain('new sessions');expect(S.capabilities.plugins.codes['native-only']).not.toContain('/mcp');
 expect(S.capabilities.plugins.codexRecovery).toContain('native Codex plugin');
});

it('plan UI labels distinguish verification from human-accepted Checklist completion and captured exports',()=>{
 expect(S.plans.basis(2)).toBe('Done in Checklist · human accepted revision 2');
 expect(S.plans.progress('verified',1,3,1)).toBe('1/3 verified · 1 accepted from Checklist');
 expect(S.plans.progress('checklist',2,3,0)).toBe('2/3 done');
 expect(S.plans.snapshot('accepted',1,'pending')).toBe('accepted · revision 1 · pending');
 expect(S.plans.freeCancels).toContain('cancels the active plan');
});

it('manual skill sharing labels and fixed codes are English and keep generic adoption/owned cleanup semantics',()=>{
 const labels=S.capabilities.skillShare;expect(labels.share('Codex')).toBe('Share with Codex');expect(labels.unshare('Claude')).toBe('Unshare from Claude');
 for(const value of Object.values(labels))if(typeof value==='string')expect(value).not.toMatch(CYRILLIC);
 for(const value of Object.values(labels.codes))expect(value).not.toMatch(CYRILLIC);
 expect(labels.projectHint).toContain('Git status');expect(labels.userHint).toContain('absolute symlink');expect(labels.cleanup).toContain('original skill stays');expect(labels.appliesToNew).not.toMatch(/\d+ sessions/);
});

it('describes closed-work plan controls without labeling pending delivery retry unavailable',()=>{
 expect(S.plans.workClosed).toBe('Reopen this workspace to change the plan.');
 expect(S.plans.retry).toBe('Retry pending deliveries');
});

it('decisions and room history labels are English, Share warns about Git and secrets, Unshare does not promise history removal', () => {
  const walk = (value: unknown): string[] => typeof value === 'string' ? [value] : typeof value === 'function' ? [String((value as (n: never) => string)(1 as never))]
    : value && typeof value === 'object' ? Object.values(value).flatMap(walk) : [];
  for (const label of [...walk(S.decisions), ...walk(S.roomHistory)]) { expect(label).not.toMatch(CYRILLIC); expect(label.length).toBeGreaterThan(0); }
  expect(S.roomHistory.shareWarning).toContain('shared Git files'); expect(S.roomHistory.shareWarning).toContain('secrets');
  expect(S.roomHistory.unshareWarning).toContain('Previous Git commits retain it');
  expect(S.roomHistory.sharedAt('2026-10-05T10:00:00.000Z')).toMatch(/^Shared at /);
  expect(S.decisions.open).toBe('Open accepted revision');
});

it('recipe labels are English, name every parse diagnostic and the template playbook stays short', () => {
  const R = S.recipes;
  const labels = [R.field, R.none, R.loadFailed, R.modeField, R.worktreeField, R.noWorktree, R.singleDropsRecipe, R.gone, R.save, R.saveTitle, R.saveHint, R.nameField, R.descriptionField,
    R.fileField, R.playbookField, R.nameRequired, R.fileInvalid, R.needRoles, R.needAgents, R.confirmSave, R.back, R.replace, R.rename, R.noPlaybook,
    R.roleMissing('claude:x'), R.exists('x'), R.saved('X'), R.savedNotOpened('X'), R.chip('X'), R.playbookFor('X'), R.playbookTemplate, ...Object.values(R.reason)];
  for (const label of labels) { expect(label).not.toMatch(/[А-Яа-яЁё]/); expect(label.length).toBeGreaterThan(0); }
  // Каждый код разбора рецепта (`RecipeCode` core) имеет свою причину в списке рецептов.
  for (const code of ['invalid-id', 'missing-frontmatter', 'invalid-yaml', 'invalid-schema', 'invalid-role', 'invalid-count', 'invalid-lead', 'too-few-agents', 'invalid-utf8', 'file-too-large', 'unreadable', 'discovery-limit'])
    expect(R.reason[code], code).toBeTruthy();
  expect(R.playbookTemplate.split('\n').length).toBeLessThanOrEqual(30);
  expect(R.invalidOption('broken.md', R.reason['invalid-yaml'] as string)).toBe('broken.md · Not valid YAML');
});

it('S.island.donePeek — выглядывающий остров «✅ N», без слов', () => {
  expect(S.island.donePeek(1)).toBe('✅ 1');
  expect(S.island.donePeek(12)).toBe('✅ 12');
});

describe('пометка данных страницы', () => {
  it('PAGE_DATA_NOTE core равна S.contextFile.pageDataNote', () => {
    expect(PAGE_DATA_NOTE).toBe(S.contextFile.pageDataNote);
  });
});

describe('аккаунты подписки: минимальная версия CLI (спека подписок 10)', () => {
  it('текст «нужен Claude Code» называет ту же версию, что ACCOUNT_MIN_VERSION_CLAUDE ядра', () => {
    expect(S.accounts.needsCli('Claude Code 2')).toBe(`Claude Code 2 requires Claude Code ${ACCOUNT_MIN_VERSION_CLAUDE} or newer`);
  });
});
