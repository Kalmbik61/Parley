import { describe, expect, it } from 'vitest';
import type { ProviderEntry, RoleSummary, WorkEntry, WorkMap } from '@parley/core';
import { chooseProvider, resolveProject, resolveRole } from './new-agent.js';
import { targetsOf, type OverviewSource } from './overview.js';

function work(projectPath: string, workId: string, title: string, status = 'active'): WorkEntry {
  return {
    projectPath,
    map: {
      schemaVersion: 2,
      work: { id: workId, title, goal: '', status },
      sessions: [],
      messages: [],
      rooms: [],
    } as unknown as WorkMap,
  };
}
function source(entries: WorkEntry[]): OverviewSource {
  return { entries, live: () => undefined, roomTail: () => [], home: '/u' };
}
const workId = (src: OverviewSource, title: string): string => {
  const found = targetsOf(src, { hidden: true }).find((target) => target.kind === 'work' && target.name === title);
  if (found === undefined) throw new Error(`no work ${title}`);
  return found.id;
};

// «Billing» в проекте scanum, архивная работа «Old» в проекте legacy.
const src = source([work('/u/scanum', 'w-1', 'Billing'), work('/u/legacy', 'w-2', 'Old', 'archived')]);
// Два проекта с одним именем папки в разных родительских.
const dupSrc = source([work('/u/Desktop/scanum', 'w-1', 'Billing'), work('/u/work/scanum', 'w-2', 'Search')]);

describe('resolveProject', () => {
  it('по имени папки, по пути, по id работы, архивные тоже', () => {
    expect(resolveProject(src, 'scanum')).toEqual({ projectPath: '/u/scanum', label: 'scanum' });
    expect(resolveProject(src, 'SCANUM')).toEqual({ projectPath: '/u/scanum', label: 'scanum' });
    expect(resolveProject(src, '/u/scanum')).toEqual({ projectPath: '/u/scanum', label: 'scanum' });
    expect(resolveProject(src, workId(src, 'Billing'))).toEqual({ projectPath: '/u/scanum', label: 'scanum' });
    expect(resolveProject(src, 'legacy')).toEqual({ projectPath: '/u/legacy', label: 'legacy' });
    expect(resolveProject(src, workId(src, 'Old'))).toEqual({ projectPath: '/u/legacy', label: 'legacy' });
  });
  it('два проекта с одним именем — отказ с id работ и родительскими папками', () => {
    expect(resolveProject(dupSrc, 'scanum')).toEqual({
      error: expect.stringMatching(/^"scanum" matches several projects: scanum in ~\/Desktop \(work:[^)]+\), scanum in ~\/work \(work:[^)]+\)\. Name one by a work id\.$/),
    });
  });
  it('двойника можно назвать путём или id работы — подпись с родительской папкой', () => {
    expect(resolveProject(dupSrc, '/u/work/scanum')).toEqual({ projectPath: '/u/work/scanum', label: 'scanum in ~/work' });
    expect(resolveProject(dupSrc, workId(dupSrc, 'Billing'))).toEqual({ projectPath: '/u/Desktop/scanum', label: 'scanum in ~/Desktop' });
  });
  it('незнакомая папка — not a Parley project', () => {
    expect(resolveProject(src, 'nowhere')).toEqual({ error: '"nowhere" is not a Parley project; add it in Parley first.' });
  });
});

function role(name: string, from: RoleSummary['source'], extra: Partial<RoleSummary> = {}): RoleSummary {
  return { id: `${from}:${name}`, name, description: '', source: from, provider: 'claude', model: null, effort: null, readOnly: false, ...extra };
}

describe('resolveRole', () => {
  const roles = [role('Reviewer', 'builtin'), role('Code Reviewer', 'claude'), role('Planner', 'builtin')];
  it('точное имя побеждает подстроку', () => expect(resolveRole(roles, 'reviewer')).toMatchObject({ role: { name: 'Reviewer' } }));
  it('подстрока — одна', () => expect(resolveRole(roles, 'plan')).toMatchObject({ role: { name: 'Planner' } }));
  it('неоднозначно — список', () =>
    expect(resolveRole(roles, 'view')).toEqual({ error: expect.stringContaining('Reviewer (builtin), Code Reviewer (claude)') }));
  it('неоднозначно — полная фраза', () =>
    expect(resolveRole(roles, 'view')).toEqual({ error: '"view" matches several roles: Reviewer (builtin), Code Reviewer (claude). Say which one.' }));
  it('нет — список ролей', () =>
    expect(resolveRole(roles, 'chef')).toEqual({ error: 'No role "chef". Roles: Reviewer, Code Reviewer, Planner.' }));
  it('два точных имени из разных источников — тоже неоднозначно', () =>
    expect(resolveRole([role('Reviewer', 'builtin'), role('reviewer', 'codex')], 'Reviewer')).toEqual({
      error: expect.stringContaining('matches several roles: Reviewer (builtin), reviewer (codex)'),
    }));
});

function provider(id: string, label: string, models?: ProviderEntry['models']): ProviderEntry {
  return { id, label, mark: id.slice(0, 2), hasHistory: true, ...(models === undefined ? {} : { models }) } as unknown as ProviderEntry;
}
// Реестр нарочно в порядке, отличном от claude, glm, codex: порядок умолчания задаёт ASSISTANT_PROVIDER_ORDER.
const registry: Record<string, ProviderEntry> = {
  codex: provider('codex', 'Codex', [{ id: 'gpt-5-codex', label: 'GPT-5 Codex' }]),
  'custom-claude-2': provider('custom-claude-2', 'Claude (work)'),
  glm: provider('glm', 'GLM'),
  claude: provider('claude', 'Claude', [
    { id: 'opus', label: 'Opus 4.6' },
    { id: 'sonnet', label: 'Sonnet 4.6' },
  ]),
};
const base = {
  role: null as RoleSummary | null,
  provider: null as string | null,
  model: null as string | null,
  fallback: null as string | null,
  registry,
  ready: async (): Promise<string | null> => null,
};
const builtinReviewer = role('Reviewer', 'builtin', { models: { claude: 'opus', codex: 'gpt-5-codex' } });
const codexTriager = role('Triager', 'codex', { provider: 'codex', model: 'gpt-5-codex' });

describe('chooseProvider', () => {
  it('названный провайдер — по id и по подписи, без учёта регистра', async () => {
    expect(await chooseProvider({ ...base, provider: 'CODEX' })).toMatchObject({ choice: { provider: { id: 'codex' } } });
    expect(await chooseProvider({ ...base, provider: 'claude (work)' })).toMatchObject({ choice: { provider: { id: 'custom-claude-2' } } });
  });
  it('незнакомый провайдер — отказ со списком id', async () => {
    expect(await chooseProvider({ ...base, provider: 'gemini' })).toEqual({ error: 'No provider "gemini". Providers: codex, custom-claude-2, glm, claude.' });
  });
  it('роль Codex и названный claude — отказ', async () => {
    expect(await chooseProvider({ ...base, role: codexTriager, provider: 'claude' })).toEqual({
      error: 'Role Triager runs on Codex; leave the provider out or pick another role.',
    });
  });
  it('роль Codex сама навязывает свой провайдер, названный тот же — можно', async () => {
    expect(await chooseProvider({ ...base, role: codexTriager, fallback: 'claude' })).toMatchObject({ choice: { provider: { id: 'codex' }, model: null, shownModel: 'gpt-5-codex' } });
    expect(await chooseProvider({ ...base, role: codexTriager, provider: 'codex' })).toMatchObject({ choice: { provider: { id: 'codex' } } });
  });
  it('встроенная роль: названный провайдер главнее своего; не названный — провайдер роли, а не умолчание окна', async () => {
    expect(await chooseProvider({ ...base, role: builtinReviewer, provider: 'codex' })).toMatchObject({ choice: { provider: { id: 'codex' }, shownModel: 'gpt-5-codex' } });
    expect(await chooseProvider({ ...base, role: builtinReviewer, fallback: 'codex' })).toMatchObject({ choice: { provider: { id: 'claude' } } });
  });
  it('выбранный провайдер не готов — отказ с причиной, умолчание не подставляется', async () => {
    const ready = async (entry: ProviderEntry): Promise<string | null> => (entry.id === 'claude' ? 'not signed in' : null);
    expect(await chooseProvider({ ...base, provider: 'claude', ready })).toEqual({ error: 'Claude Code is not ready: not signed in' });
    expect(await chooseProvider({ ...base, role: builtinReviewer, fallback: 'codex', ready })).toEqual({ error: 'Claude Code is not ready: not signed in' });
  });
  it('умолчание из окна; без него — первый готовый по порядку claude, glm, codex', async () => {
    expect(await chooseProvider({ ...base, fallback: 'codex' })).toMatchObject({ choice: { provider: { id: 'codex' } } });
    expect(await chooseProvider({ ...base, fallback: null })).toMatchObject({ choice: { provider: { id: 'claude' } } });
    expect(await chooseProvider({ ...base, fallback: null, ready: async (e) => (e.id === 'claude' ? 'not signed in' : null) })).toMatchObject({ choice: { provider: { id: 'glm' } } });
  });
  it('умолчание не готово или не в реестре — по порядку; после трёх встроенных идут остальные id реестра', async () => {
    const notClaudeGlmCodex = async (e: ProviderEntry): Promise<string | null> => (e.id === 'custom-claude-2' ? null : 'off');
    expect(await chooseProvider({ ...base, fallback: 'codex', ready: async (e) => (e.id === 'codex' ? 'off' : null) })).toMatchObject({ choice: { provider: { id: 'claude' } } });
    expect(await chooseProvider({ ...base, fallback: 'gone' })).toMatchObject({ choice: { provider: { id: 'claude' } } });
    expect(await chooseProvider({ ...base, fallback: null, ready: notClaudeGlmCodex })).toMatchObject({ choice: { provider: { id: 'custom-claude-2' } } });
  });
  it('готового нет — отказ', async () => {
    expect(await chooseProvider({ ...base, ready: async () => 'off' })).toEqual({ error: 'No provider is ready to start an agent — open Settings.' });
    expect(await chooseProvider({ ...base, registry: {} })).toEqual({ error: 'No provider is ready to start an agent — open Settings.' });
  });
  it('модель подписью — уходит значением', async () => {
    expect(await chooseProvider({ ...base, provider: 'claude', model: 'Opus 4.6' })).toMatchObject({ choice: { model: 'opus', shownModel: 'opus' } });
    expect(await chooseProvider({ ...base, provider: 'claude', model: 'SONNET' })).toMatchObject({ choice: { model: 'sonnet', shownModel: 'sonnet' } });
  });
  it('незнакомая модель — отказ со списком; без списка у провайдера — как есть', async () => {
    expect(await chooseProvider({ ...base, provider: 'claude', model: 'gpt-9' })).toEqual({ error: 'Claude Code has no model "gpt-9". Models: opus, sonnet.' });
    expect(await chooseProvider({ ...base, provider: 'glm', model: 'glm-5' })).toMatchObject({ choice: { model: 'glm-5', shownModel: 'glm-5' } });
    const emptyList = { ...registry, glm: provider('glm', 'GLM', []), claude: provider('claude', 'Claude', null) };
    expect(await chooseProvider({ ...base, registry: emptyList, provider: 'glm', model: 'glm-5' })).toMatchObject({ choice: { model: 'glm-5' } });
    expect(await chooseProvider({ ...base, registry: emptyList, provider: 'claude', model: 'anything' })).toMatchObject({ choice: { model: 'anything' } });
  });
  it('модель не названа — не передаётся, показывается модель роли', async () => {
    expect(await chooseProvider({ ...base, role: builtinReviewer, fallback: 'claude' })).toMatchObject({ choice: { model: null, shownModel: 'opus' } });
    expect(await chooseProvider({ ...base, fallback: 'claude' })).toMatchObject({ choice: { model: null, shownModel: null } });
  });
});
