# Codex: доверие к папке, политика по ролям, короткий набор инструментов — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Цель:** сессия Codex в Parley стартует без экрана доверия, спрашивает человека только там, где это задано ролью и настройкой, и координируется коротким набором инструментов с примерами; согласие на папку человек даёт в окне, на острове или в Telegram.

**Архитектура:** согласие живёт у Parley (`parleyHome()/trust.json`) и доезжает до Codex подстановкой `{trust}` в шаблон запуска; политика одобрений и песочницы считается из роли и настройки `codexWriteApprovals` и доезжает подстановками `{approvals}` / `{sandbox}`; удержание запуска без согласия — отдельный исход `launch()` и карточка `consent` нового семейства (хост → остров, окно, Telegram); профиль инструментов `short` и блок примеров — только у Codex.

**Стек:** TypeScript, pnpm-монорепозиторий (`@parley/core`, `@parley/host`, `@parley/protocol`, `@parley/desktop`), vitest, zod (протокол), zustand (окно), Playwright (E2E).

**Спека:** `docs/specs/2026-10-21-codex-trust-policy-tools-design.md` (разделы 3–9; спайк 0 выполнен, факты о Codex 0.162.0 в 4.3).

Базовая ветка: `origin/master` (локальный `master` отстаёт). Коммиты и CHANGELOG — по-английски (`AGENTS.md`); комментарии и тесты — на языке окружающего текста. Каждое сообщение коммита заканчивается строкой `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Тесты гонять только по затронутым файлам: `pnpm -F <пакет> exec vitest run <файлы>` и `pnpm -F <пакет> exec tsc --noEmit`; имена пакетов брать из `package.json` пакета.

## Глобальные ограничения

- Рамка: Parley не пишет в `~/.codex`, не выдаёт доверие хукам, не назначает `danger-full-access` и `--dangerously-bypass-approvals-and-sandbox`.
- Форма флага доверия ровно такая: `projects={"<realpath проекта>"={trust_level="trusted"}}`; при cwd ≠ проект — вторая пара `,"<realpath cwd>"={trust_level="trusted"}` в той же таблице; строки через `tomlString` (`work/mcp-config.ts`).
- Политика Codex только ключами `-c approval_policy=…`, `-c approvals_reviewer=…`, `-c sandbox_mode=…`; флаг `-a on-request` из шаблона уходит; `resume` получает те же пары.
- Роли только для чтения (`readOnly: true`): `approval_policy="never"` + `sandbox_mode="read-only"`. Пишущие: `sandbox_mode="workspace-write"` явно + режим `codexWriteApprovals`.
- `codexWriteApprovals: 'auto' | 'parley' | 'terminal'`, умолчание `'auto'`; `auto` требует Codex ≥ `0.162.0`, ниже — поведение `terminal` и уведомление `codex-auto-unsupported`. Перенос: `codexApprovals: true` → `parley`, `false` → `terminal`; `PARLEY_CODEX_APPROVALS` читается так же.
- Хуки Codex (`-c hooks.*`) только в режиме `parley`, у всех ролей Codex.
- Удерживаются только запуски Codex без согласия на проект; диалог в композере — для любой папки и любого провайдера.
- Профиль `short` прячет ровно `remember`, `memory_read`, `search_history`; `backlog_*` остаются.
- Строки `/status` Codex 0.162 для проверки руками: «Workspace (Ask for approval)», «Read Only (never)», «Read Only (Approve for me)».
- Потолки слоя не меняются: `GUIDANCE_MAX_LINES` 14, `STABLE_POLICY_MAX_BYTES` 4096, `GUIDANCE_MAX_BYTES` 8192, аргумент ≤ 96 КиБ (`validateLayerArguments`).
- Все тексты окна, острова, Telegram и слоя — по-английски; CHANGELOG — раздел `## Unreleased`.

## Review Focus

1. Папка с символической ссылкой или под `/tmp`: `realpath` у записи согласия и у ключа `projects` должен совпадать, иначе доверие «есть», а Codex показывает экран. Тест — задача 4 (`realpath` в `isTrusted`) и задача 5 (ключ из `realpath`).
2. `resume` спящей сессии Codex после смены настройки `codexWriteApprovals`: политика берётся из текущей настройки, не из треда. Тест — задача 2 (`resumeCommand` содержит пары политики).
3. Два запуска в одном проекте без согласия подряд (агент создал две сессии): одна карточка, оба запуска продолжаются по `allow`. Тест — задача 6 (`request` дедуплицирует по папке, `allow` продолжает все удержанные).
4. Перезапуск хоста с ждущей карточкой: карточка и удержанные запуски читаются из `consents.json`, закрытые сессии отбрасываются. Тест — задача 6.
5. Старый Codex (< 0.162.0) при умолчании `auto`: запуск не падает на незнакомом ключе, идёт как `terminal`. Тест — задача 7 (`effectiveCodexWriteApprovals`).

## Файлы

Создаются:
- `packages/core/src/work/codex-policy.ts` (+ `.test.ts`) — пары `-c` политики из роли и режима.
- `packages/core/src/work/trust.ts` (+ `.test.ts`) — `trust.json`: чтение, выдача, отзыв, проверка, ключ доверия.
- `packages/protocol/src/consents.ts` — тип карточки, схемы методов `consents.*` и `trust.*`, результаты.
- `packages/host/src/consents/consents-service.ts` (+ `.test.ts`) — карточки, удержанные запуски, `consents.json`.
- `packages/host/src/methods/consents.ts` — обработчики `consents.*` и `trust.*`.
- `packages/desktop/src/renderer/island/consents/store.ts` (+ `.test.ts`), `ConsentView.tsx` (+ `.test.tsx`) — карточка согласия на острове.
- `packages/desktop/src/renderer/store/consents.ts` — согласия в главном окне.
- `packages/desktop/src/renderer/components/dialogs/TrustFolderDialog.tsx` (+ `.test.tsx`).
- `packages/desktop/src/renderer/components/settings/ProjectsSettings.tsx` (+ `.test.tsx`).

Меняются (основные): `core/src/config.ts`, `core/src/providers.ts`, `core/src/roles/catalog.ts`, `core/src/work/agents.ts`, `core/src/work/launch.ts`, `core/src/work/guidance.ts`, `core/src/work/guide.ts`, `core/src/work/mcp-config.ts`, `core/src/mcp/context.ts`, `core/src/mcp/tools.ts`, `core/src/mcp/session-tools.ts`, `protocol/src/methods.ts`, `protocol/src/events.ts`, `host/src/sessions/sessions-service.ts`, `host/src/wake/wake-service.ts`, `host/src/feed/feed-service.ts`, `host/src/agent/session-endpoint.ts`, `host/src/host.ts`, `host/src/methods/index.ts`, `host/src/telegram/{types,cards,texts,service}.ts`, `desktop/src/shared/{island,strings}.ts`, `desktop/src/renderer/island/{IslandApp,IslandView}.tsx`, `desktop/src/renderer/sidebar/NewWorkComposer.tsx`, `desktop/src/renderer/components/settings/SettingsDialog.tsx`, `desktop/src/renderer/chat/ChatView.tsx`, `desktop/src/renderer/App.tsx`, `desktop/e2e/*.spec.ts`, `README.md`, `CHANGELOG.md`.

## Волны

| Волна | Задачи | Файлы не пересекаются |
| --- | --- | --- |
| 1 | 1 | `config.ts` |
| 2 | 2, 3, 4 | политика/шаблон/роли · инструменты/гид/MCP-контекст · trust + протокол |
| 3 | 5, 6, 7, 8 | `launch.ts` + `agents.ts` · хост (сессии, wake, feed, consents, методы, `host.ts`) · Telegram (без `host.ts`) · настройки окна |
| 4 | 9, 10 | остров · композер, главное окно, Chat |
| 5 | 11, 12 | E2E · документы и приёмка |

Задача 1 идёт одна: задачи 2, 5, 6, 8 импортируют её имена.

---

### Задача 1: настройка `codexWriteApprovals`

**Файлы:**
- Modify: `packages/core/src/config.ts` (`ParleyConfig` ~59, `DEFAULT_CONFIG` ~92, `ENV_NAMES` ~117, `fromFile` ~221, `fromEnv` ~248–278, `BOOLEAN_KEYS` ~364, `parseSetting` ~378)
- Test: `packages/core/src/config.test.ts`

**Interfaces:**
- Produces: `export type CodexWriteApprovals = 'auto' | 'parley' | 'terminal'`; поле `codexWriteApprovals: CodexWriteApprovals` в `ParleyConfig` (умолчание `'auto'`), ключ `ENV_NAMES.codexWriteApprovals = 'CODEX_WRITE_APPROVALS'`; `export const CODEX_WRITE_APPROVALS_VALUES: readonly CodexWriteApprovals[]`; `export function codexHooksWanted(config: Pick<ParleyConfig, 'codexWriteApprovals'>): boolean` (`true` только у `'parley'`). Поле `codexApprovals` из `ParleyConfig`, `DEFAULT_CONFIG`, `ENV_NAMES`, `BOOLEAN_KEYS` и `flag(...)` уходит.

- [ ] **Шаг 1: падающие тесты в `config.test.ts`**

```ts
it('codexWriteApprovals: умолчание auto, значения из файла и среды', async () => {
  expect(DEFAULT_CONFIG.codexWriteApprovals).toBe('auto');
  expect((await loadFrom({ codexWriteApprovals: 'parley' })).config.codexWriteApprovals).toBe('parley');
  expect((await loadFrom({}, { PARLEY_CODEX_WRITE_APPROVALS: 'terminal' })).config.codexWriteApprovals).toBe('terminal');
  expect((await loadFrom({ codexWriteApprovals: 'yes' })).warning).toMatch(/codexWriteApprovals: expected auto, parley or terminal/);
});
it('codexApprovals переносится: true → parley, false → terminal, новый ключ сильнее', async () => {
  expect((await loadFrom({ codexApprovals: true })).config.codexWriteApprovals).toBe('parley');
  expect((await loadFrom({ codexApprovals: false })).config.codexWriteApprovals).toBe('terminal');
  expect((await loadFrom({ codexApprovals: true, codexWriteApprovals: 'auto' })).config.codexWriteApprovals).toBe('auto');
  expect((await loadFrom({}, { PARLEY_CODEX_APPROVALS: '1' })).config.codexWriteApprovals).toBe('parley');
});
it('codexHooksWanted: только parley', () => {
  expect(codexHooksWanted({ codexWriteApprovals: 'parley' })).toBe(true);
  expect(codexHooksWanted({ codexWriteApprovals: 'auto' })).toBe(false);
  expect(codexHooksWanted({ codexWriteApprovals: 'terminal' })).toBe(false);
});
it('parseSetting codexWriteApprovals', () => {
  expect(parseSetting('codexWriteApprovals', 'parley')).toEqual({ value: 'parley' });
  expect(parseSetting('codexWriteApprovals', 'on')).toHaveProperty('error');
});
```

`loadFrom(fileData, env)` — хелпер теста по образцу соседних тестов файла (временный `config.json` + `loadConfig(file, env)`). Существующие ожидания `codexApprovals: false` в снимках `DEFAULT_CONFIG` (строки ~36, 77, 103, 362, 623) заменить на `codexWriteApprovals: 'auto'`.

- [ ] **Шаг 2: прогнать — падают** `pnpm -F @parley/core exec vitest run src/config.test.ts` (ожидание: FAIL, `codexWriteApprovals` undefined).

- [ ] **Шаг 3: реализовать в `config.ts`**: тип и константа значений; `take('codexWriteApprovals', isCodexWriteApprovals, 'auto, parley or terminal')`; перенос в `fromFile`: если `data.codexWriteApprovals === undefined` и `typeof data.codexApprovals === 'boolean'` → `patch.codexWriteApprovals = data.codexApprovals ? 'parley' : 'terminal'`; в `fromEnv` ветка по образцу `fontFamily` (~286–290) для `CODEX_WRITE_APPROVALS`, и перенос `CODEX_APPROVALS` через те же `TRUE`/`FALSE`-множества, только когда новая переменная не задана; ветка в `parseSetting`; `codexHooksWanted`.

- [ ] **Шаг 4: прогнать — зелёные**; `pnpm -F @parley/core exec tsc --noEmit` покажет остальных читателей `codexApprovals` (`work/launch.ts:399`, хост, окно) — они чинятся в задачах 5, 6, 8; на этом шаге допустимо оставить временный `codexApprovals?: boolean` только в типе, если без него не собирается `core`; убрать его обязан исполнитель задачи 5.

- [ ] **Шаг 5: коммит** `feat(config): codexWriteApprovals replaces codexApprovals`.

---

### Задача 2: политика Codex по роли и шаблон запуска

**Файлы:**
- Create: `packages/core/src/work/codex-policy.ts`, `packages/core/src/work/codex-policy.test.ts`
- Modify: `packages/core/src/providers.ts` (`CODEX_CONFIG_FLAGS` 146–167, `CODEX_PARLEY_FLAGS` 182), `packages/core/src/roles/catalog.ts` (~142–153), `packages/core/src/work/agents.ts` (`nativeConfigArgs` ~40–60)
- Test: `packages/core/src/providers.test.ts` (`CODEX_STATIC_ARGS` 52, ожидания `'on-request'` 265, 379, 398, 1305), `packages/core/src/roles/catalog.test.ts`, `packages/core/src/work/agents.test.ts`

**Interfaces:**
- Consumes: `CodexWriteApprovals` из задачи 1.
- Produces: `export const CODEX_AUTO_MIN_VERSION = '0.162.0'`; `export function codexPolicyArgs(role: { readOnly: boolean }, mode: CodexWriteApprovals): string[]` — для `readOnly` `['-c', 'approval_policy="never"']`, иначе `['-c', 'approval_policy="on-request"']` плюс `['-c', 'approvals_reviewer="auto_review"']` при `mode === 'auto'`; `export function trustArgs(keys: { project: string; cwd: string }): string[]` — `['-c', 'projects={…}']` по форме из ограничений (cwd добавляется, когда отличается от project; обе строки через `tomlString`). Подстановки `{approvals}` и `{trust}` — самостоятельные элементы шаблона, разворачиваются массивом как `{codexHooks}`. `resolveRoleChoice` для `provider === 'codex'` при `sandboxMode === null` ставит `'workspace-write'` (а `readOnly` по-прежнему `'read-only'`). `nativeConfigArgs` пропускает `{approvals}` и `{trust}` как `{codexHooks}`; `projectSkillRunnerContext(entry, template, extraConfigArgs: readonly string[] = [])` добавляет `extraConfigArgs` в `configArgs`.

- [ ] **Шаг 1: тесты `codex-policy.test.ts`**

```ts
it('read-only role → never, no reviewer', () => {
  expect(codexPolicyArgs({ readOnly: true }, 'auto')).toEqual(['-c', 'approval_policy="never"']);
});
it('writing role: on-request; auto adds the reviewer', () => {
  expect(codexPolicyArgs({ readOnly: false }, 'auto')).toEqual(['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"']);
  expect(codexPolicyArgs({ readOnly: false }, 'parley')).toEqual(['-c', 'approval_policy="on-request"']);
  expect(codexPolicyArgs({ readOnly: false }, 'terminal')).toEqual(['-c', 'approval_policy="on-request"']);
});
it('trustArgs: one key when cwd is the project, two otherwise, quotes escaped', () => {
  expect(trustArgs({ project: '/p', cwd: '/p' })).toEqual(['-c', 'projects={"/p"={trust_level="trusted"}}']);
  expect(trustArgs({ project: '/p', cwd: '/p/.claude/worktrees/wt' })).toEqual(['-c', 'projects={"/p"={trust_level="trusted"},"/p/.claude/worktrees/wt"={trust_level="trusted"}}']);
  expect(trustArgs({ project: '/a "q" x', cwd: '/a "q" x' })[1]).toBe('projects={"/a \\"q\\" x"={trust_level="trusted"}}');
});
```

В `providers.test.ts`: `CODEX_STATIC_ARGS` без `'-a', 'on-request'`; новый тест: `PROVIDERS.codex.runner.args` и `resumeArgs` содержат `'{approvals}'` и `'{trust}'`, а `startCommand(PROVIDERS.codex, { ...subs, approvals: ['-c', 'approval_policy="never"'], trust: ['-c', 'projects={}'] }).args` содержит обе пары и не содержит `'on-request'`; `resumeCommand` — то же. В `catalog.test.ts`: `resolveRoleChoice` для builtin executor с `provider: 'codex'` даёт `sandboxMode: 'workspace-write'`; для critic — `'read-only'`; для роли Codex из каталога с `sandbox_mode = "danger-full-access"` — как в роли; для `provider: 'claude'` — `null`. В `agents.test.ts`: шаблон с `'{approvals}'`/`'{trust}'` остаётся `verified`; `projectSkillRunnerContext(entry, template, ['-c', 'projects={}'])` возвращает `configArgs` с этой парой.

- [ ] **Шаг 2: прогнать — падают** `pnpm -F @parley/core exec vitest run src/work/codex-policy.test.ts src/providers.test.ts src/roles/catalog.test.ts src/work/agents.test.ts`.

- [ ] **Шаг 3: реализовать**: `codex-policy.ts`; в `providers.ts` убрать `'-a', 'on-request'` из `CODEX_PARLEY_FLAGS`, в `CODEX_CONFIG_FLAGS` после `'{sandbox}'` добавить элементы `'{approvals}'`, `'{trust}'` и обновить комментарий (политика ключами, доверие флагом, решения спеки 9–11); `catalog.ts` — умолчание `'workspace-write'`; `agents.ts` — пропуск плейсхолдеров и `extraConfigArgs`.

- [ ] **Шаг 4: прогнать — зелёные**, `tsc --noEmit` для `core`.

- [ ] **Шаг 5: коммит** `feat(codex): approval policy and trust placeholders in the launch template`.

---

### Задача 3: профиль `short`, примеры и правило остановки

**Файлы:**
- Modify: `packages/core/src/work/mcp-config.ts` (`McpConfigParams` 41–62, env в `mcpConfig` ~111 и `codexServerEnv` ~183, список ключей 159), `packages/core/src/mcp/context.ts` (~20–40 и чтение env ~24–36), `packages/core/src/mcp/tools.ts` (`createParleyServer` ~1528–1563), `packages/core/src/work/guidance.ts` (`GuidanceOptions` 34, `stableGuidance` 82, строка 103, последняя строка списка), `packages/core/src/work/guide.ts` (`guide` 558, `guideTopic` 581, секция `tools` 117–148)
- Test: `packages/core/src/work/mcp-config.test.ts`, `packages/core/src/mcp/context.test.ts`, `packages/core/src/work/guidance.test.ts`, `packages/core/src/work/guide.test.ts`

**Interfaces:**
- Produces: `export type ToolProfile = 'short'`; `McpConfigParams.toolProfile?: ToolProfile` → переменная `TOOL_PROFILE` (под обоими префиксами, как `SKILL_NAVIGATOR`); `McpContext.toolProfile?: ToolProfile` из `envValue(env, 'TOOL_PROFILE')`; `export const SHORT_PROFILE_HIDDEN_TOOLS = ['remember', 'memory_read', 'search_history'] as const`; `GuidanceOptions.toolProfile?: ToolProfile`; `guide(options?: { skillNavigator?: boolean; toolProfile?: ToolProfile })` и `guideTopic(topic, options?)` с тем же объектом (прежняя булева форма вызова сохраняется перегрузкой или заменяется у всех вызывающих — на выбор исполнителя); `export const CODEX_TOOL_EXAMPLES: string` — текст из спеки 6.2 дословно; в `stableGuidance` последняя строка получает окончание «…; after report, end the turn.».

- [ ] **Шаг 1: тесты**

`guidance.test.ts`:
```ts
it('short profile drops the memory sentence and keeps the budget', () => {
  const full = stableGuidance(); const short = stableGuidance({ toolProfile: 'short' });
  expect(full).toContain('Memory: remember'); expect(short).not.toContain('Memory: remember');
  expect(short).not.toContain('search_history'); expect(short).toContain('backlog_list');
  expect(guidanceBudgetProblems(short, short)).toEqual([]);
});
it('CODEX_TOOL_EXAMPLES names real tools and real argument keys', () => {
  const calls = [...CODEX_TOOL_EXAMPLES.matchAll(/tools\.mcp__parley__(\w+)\((\{[^)]*\})?/g)];
  expect(calls.map((m) => m[1])).toEqual(['get_map', 'send_message', 'check_inbox', 'wait_for', 'report']);
  for (const [, name, args] of calls) {
    const tool = TOOLS.find((t) => t.name === name)!; // TOOLS импортируется из mcp/tools.js только в тесте
    for (const key of [...(args ?? '').matchAll(/(\w+):/g)].map((m) => m[1])) expect(Object.keys(tool.inputSchema.properties ?? {})).toContain(key);
  }
  expect(CODEX_TOOL_EXAMPLES.split('\n').length).toBeLessThanOrEqual(8);
  expect(Buffer.byteLength(CODEX_TOOL_EXAMPLES)).toBeLessThanOrEqual(1024);
});
it('stable guidance ends the report line with the stop rule', () => {
  expect(stableGuidance()).toMatch(/call report — otherwise the result will not go anywhere; after report, end the turn\.$/m);
});
```
`guide.test.ts`: `guide({ toolProfile: 'short' })` не содержит `memory_read`, `guide()` содержит. `mcp-config.test.ts`: `mcpConfigJson({ …, toolProfile: 'short' })` даёт `PARLEY_TOOL_PROFILE: 'short'` и `HARNAS_TOOL_PROFILE: 'short'`; `codexMcpOverride({ …, toolProfile: 'short' })` содержит `PARLEY_TOOL_PROFILE="short"`; без поля переменной нет. `context.test.ts`: `PARLEY_TOOL_PROFILE=short` → `context.toolProfile === 'short'`, иначе `undefined`. Тест сервера (в `mcp/tools.test.ts`, если есть, иначе новый `mcp/server-profile.test.ts`): `createParleyServer({ …, toolProfile: 'short' })` — список `tools/list` не содержит трёх имён и содержит `backlog_list`; без профиля содержит все.

- [ ] **Шаг 2: прогнать — падают.**

- [ ] **Шаг 3: реализовать** по интерфейсам; в `createParleyServer` фильтр `TOOLS.filter((t) => context.toolProfile !== 'short' || !SHORT_PROFILE_HIDDEN_TOOLS.includes(t.name))`; в `guide.ts` секция `tools` при `short` без абзаца о памяти и без этих имён в `summary`; в `read_guide` (`tools.ts` ~1114–1116) передавать `context.toolProfile`.

- [ ] **Шаг 4: прогнать — зелёные**, `tsc --noEmit`.

- [ ] **Шаг 5: коммит** `feat(mcp): short tool profile, Codex call examples and the stop rule`.

---

### Задача 4: запись доверия и протокол согласий

**Файлы:**
- Create: `packages/core/src/work/trust.ts`, `packages/core/src/work/trust.test.ts`, `packages/protocol/src/consents.ts`
- Modify: `packages/core/src/index.ts` (экспорт), `packages/protocol/src/methods.ts` (90–311 spread схем, `Results` 321–480), `packages/protocol/src/events.ts` (`Events` 17–57), `packages/protocol/src/index.ts`
- Test: `packages/core/src/work/trust.test.ts`, тест протокола, если в `packages/protocol` есть тесты схем (иначе только `tsc`)

**Interfaces:**
- Produces (core `trust.ts`): `export interface TrustRecord { folder: string; grantedAt: string; by: 'window' | 'island' | 'telegram' }`; `export interface TrustFile { version: 1; folders: Record<string, Omit<TrustRecord, 'folder'>> }`; `export function trustFilePath(home = parleyHome()): string` (`<home>/trust.json`); `export async function trustKey(folder: string): Promise<string>` (`fs.realpath`, при ENOENT — `path.resolve`); `export async function readTrust(home?): Promise<TrustFile>`; `export async function isTrusted(folder: string, home?): Promise<boolean>`; `export async function grantTrust(folder: string, by: TrustRecord['by'], home?): Promise<TrustRecord>`; `export async function revokeTrust(folder: string, home?): Promise<boolean>`; `export async function listTrust(home?): Promise<TrustRecord[]>`. Запись — `tmp` + `rename`, права `0o600` (образец `host/src/telegram/state.ts:56–67`).
- Produces (protocol `consents.ts`): `export interface ConsentCard { id: string; kind: 'folder-trust'; folder: string; projectPath: string; requestedBy: { source: 'agent' | 'resume' | 'launch'; sessionId?: string; workId?: string; label?: string }; at: string; state: 'pending' | 'allowed' | 'denied' }`; `export const consentMethodSchemas = { 'consents.list': z.object({}), 'consents.decide': z.object({ id: z.string().min(1), decision: z.enum(['allow', 'deny']) }), 'trust.list': z.object({}), 'trust.grant': z.object({ folder: z.string().min(1), by: z.enum(['window', 'island', 'telegram']) }), 'trust.revoke': z.object({ folder: z.string().min(1) }) }`; `export interface ConsentMethodResults { 'consents.list': { items: ConsentCard[] }; 'consents.decide': { applied: boolean; state: ConsentCard['state'] }; 'trust.list': { folders: TrustRecord[] }; 'trust.grant': { folder: TrustRecord }; 'trust.revoke': { removed: boolean } }` (тип `TrustRecord` дублируется в протоколе, как другие типы протокола); событие `'consents.changed': { upsert: ConsentCard[]; removed: string[] }` в `Events`. Схемы и результаты подмешиваются в `METHODS` / `Results` по образцу `telegramMethodSchemas` / `TelegramMethodResults`.

- [ ] **Шаг 1: тесты `trust.test.ts`** (временный `home` в `tmpdir`): `isTrusted` false на пустом доме; `grantTrust(dir, 'window')` → `isTrusted(dir)` true и true для `dir` через символическую ссылку на него (`fs.symlink`), файл с правами `0o600`, `version: 1`; `revokeTrust` → false и `removed: true`, второй раз `false`; `listTrust` отдаёт записи с `folder`; повреждённый JSON → `readTrust` отдаёт пустой файл и не бросает.

- [ ] **Шаг 2: прогнать — падают.**

- [ ] **Шаг 3: реализовать** `trust.ts` и `consents.ts`, подмешать схемы и событие, экспортировать из индексов.

- [ ] **Шаг 4: прогнать — зелёные**, `tsc --noEmit` для `core` и `protocol`.

- [ ] **Шаг 5: коммит** `feat(trust): trust.json record and consent protocol`.

---

### Задача 5: подстановки в `launch.ts`

**Файлы:**
- Modify: `packages/core/src/work/launch.ts` (`LaunchOptions` 60–110, `launchConfig` 210, проекция 262–280, подстановки 364–370, хуки 395–403, `bridge` ~451, параметры MCP-конфига там, где строится `codexMcpOverride`/`writeMcpConfig`), `packages/core/src/work/agents.ts` (только если задача 2 оставила хвост)
- Test: `packages/core/src/work/launch.test.ts`

**Interfaces:**
- Consumes: `codexHooksWanted`, `CodexWriteApprovals` (задача 1); `codexPolicyArgs`, `trustArgs`, `projectSkillRunnerContext(entry, template, extra)` (задача 2); `CODEX_TOOL_EXAMPLES`, `toolProfile` (задача 3).
- Produces: `LaunchOptions.trust?: { project: string; cwd: string }` (realpath считает хост; нет поля — `{trust}` выпадает); `LaunchOptions.codexWriteApprovals?: CodexWriteApprovals` (переопределение хоста после пробы версии; нет — из `launchConfig`). Для `entry.id === 'codex'`: `subs.approvals = codexPolicyArgs(role, mode)`, `subs.trust = trustArgs(options.trust)` при наличии, `subs.codexHooks` только при `mode === 'parley'` (вместо `launchConfig.codexApprovals`), `toolProfile: 'short'` в параметрах MCP-конфига, `bridge` = `[CODEX_APPROVAL_GUIDANCE, CODEX_TOOL_EXAMPLES, bridge]`, `systemGuidance(..., { toolProfile: 'short' })`; `projectSkillRunnerContext(entry, template, subs.trust ?? [])`. Диагностика `provider-override-gap` для пользовательского шаблона без `{trust}` или `{approvals}` (по образцу `{developerInstructions}`, сообщение: «Custom Codex runner has no {trust}/{approvals}; add these placeholders so Parley can pass folder trust and the approval policy. The runner keeps its own flags.»).

- [ ] **Шаг 1: тесты `launch.test.ts`** (по образцу существующих тестов плана Codex): executor Codex при `codexWriteApprovals: 'auto'` → `args` содержит `approval_policy="on-request"`, `approvals_reviewer="auto_review"`, `sandbox_mode="workspace-write"`, не содержит `'-a'` и `hooks.`; critic Codex → `approval_policy="never"`, `sandbox_mode="read-only"`; режим `'parley'` с `hookUrl` и `codexHookCommand` → есть `hooks.PermissionRequest`, нет `approvals_reviewer`; `options.trust` → `projects={"<project>"={trust_level="trusted"}}` (и вторая пара при cwd worktree), без `options.trust` — ни одного `projects=`; `planResume` даёт те же пары; `developer_instructions` содержит `tools.mcp__parley__report(` и не содержит `Memory: remember`; конфиг MCP содержит `PARLEY_TOOL_PROFILE="short"`; у Claude ничего из этого нет; пользовательский шаблон Codex без `{trust}` → диагностика `provider-override-gap`.

- [ ] **Шаг 2: прогнать — падают.**

- [ ] **Шаг 3: реализовать**; убрать временный `codexApprovals` из типа конфига, если задача 1 его оставила.

- [ ] **Шаг 4: прогнать — зелёные**, `tsc --noEmit`; `pnpm -F @parley/core exec vitest run src/providers.test.ts src/work/launch.test.ts`.

- [ ] **Шаг 5: коммит** `feat(launch): Codex policy, trust and tool profile substitutions`.

---

### Задача 6: хост — согласия, удержание запуска, методы

**Файлы:**
- Create: `packages/host/src/consents/consents-service.ts`, `packages/host/src/consents/consents-service.test.ts`, `packages/host/src/methods/consents.ts`
- Modify: `packages/host/src/sessions/sessions-service.ts` (`launch` 474–520, `feedHookUrl` 420–432, `create`/`createTimed` ~859–949, `SessionsFeedOptions` ~190–200), `packages/host/src/wake/wake-service.ts` (`resumeSession` 416–466, `recompute` 571–642, `WakeService`), `packages/host/src/feed/feed-service.ts` (139–140, 316–317, 1083–1085), `packages/host/src/agent/session-endpoint.ts` (48–58), `packages/core/src/mcp/session-tools.ts` (49–50), `packages/host/src/host.ts` (создание сервисов ~292, 326–329, 469–492), `packages/host/src/methods/index.ts` (`MethodDeps` 73–116, таблица 201–304, `WORKS_GATED_METHODS` 133–163)
- Test: `packages/host/src/sessions/sessions-service.test.ts`, `packages/host/src/feed/feed-service.test.ts`, `packages/host/src/methods/index.test.ts`, `packages/core/src/mcp/session-tools.test.ts`

**Interfaces:**
- Consumes: `trust.ts` (задача 4), `ConsentCard`, схемы (задача 4), `codexHooksWanted` (задача 1), `CODEX_AUTO_MIN_VERSION` (задача 2), `LaunchOptions.trust` / `.codexWriteApprovals` (задача 5).
- Produces (`consents-service.ts`): `export interface HeldLaunch { ref: SessionRef; mode: 'launch' | 'resume'; by: string }`; `export interface ConsentsService { list(): ConsentCard[]; request(input: { projectPath: string; folder: string; requestedBy: ConsentCard['requestedBy'] }, hold: HeldLaunch): ConsentCard` (одна карточка на `folder`, второй запрос добавляет удержание к ней); `decide(id: string, decision: 'allow' | 'deny'): Promise<{ applied: boolean; state: ConsentCard['state'] }>`; `onChange(listener: (change: { upsert: ConsentCard[]; removed: string[] }) => void): () => void`; `stop(): void }`; `export function createConsentsService(deps: { home: string; host: Pick<HostContext, 'broadcast' | 'log'>; trust: { grant(folder: string, by: TrustRecord['by']): Promise<unknown> }; continueLaunch(hold: HeldLaunch): Promise<void>; refuseLaunch(hold: HeldLaunch): Promise<void>; isLive(ref: SessionRef): Promise<boolean> }): ConsentsService`. Файл `<home>/consents.json` `{ version: 1, cards: ConsentCard[], holds: Record<cardId, HeldLaunch[]> }`, атомарная запись 0600; при старте удержания живых или закрытых сессий отбрасываются (`isLive`); `decide('allow')` → `trust.grant` (`by` — из аргумента метода, см. ниже), затем `continueLaunch` по каждому удержанию, событие `consents.changed { removed: [id] }`; `decide('deny')` → `refuseLaunch` по каждому; второе решение → `{ applied: false }`.
- Produces (`sessions-service.ts`): `launch(ref, mode, options): Promise<'started' | 'held'>` (`'started'` и при раннем выходе из-за `launching`/живого PTY — как сегодня `void`); проверка согласия сразу после `readyProvider` и до `reserveLaunch`: `session.provider === 'codex' && !(await isTrusted(ref.projectPath))` → `consents.request({ projectPath, folder: await trustKey(ref.projectPath), requestedBy: { source: mode === 'resume' ? 'resume' : options.by === 'human' ? 'launch' : 'agent', sessionId: session.parent ?? undefined, workId: ref.workId, label: session.label } }, { ref, mode, by })` и `return 'held'`; при согласии — `options.trust = { project: await trustKey(ref.projectPath), cwd: await trustKey(session.worktree?.path ?? ref.projectPath) }` в вызов `planFn`; `codexWriteApprovals` в `planFn`: `effectiveCodexWriteApprovals(config, version)` — `'auto'` при версии Codex < `CODEX_AUTO_MIN_VERSION` (та же `providerVersions.get(...)`, что в `feedHookUrl`) → `'terminal'` и один `host.notice` `{ kind: 'codex-auto-unsupported', ref, text }` на процесс хоста; `feedHookUrl`: `codexHooksWanted(config)` вместо `codexApprovals`; `create()` возвращает `SessionRef & { held?: 'folder-trust' }`, проверка согласия в нём идёт до `reserveAttempt` (937) — при удержании запись `pending` создаётся, резерв не берётся; `SessionsFeedOptions.consents?: ConsentsService`. `continueLaunch(hold)` в `host.ts`: `pending` → `sessionsService.launch(hold.ref, 'launch', { by: hold.by })`, `sleeping` → `wakeService.retry(hold.ref)`; `refuseLaunch(hold)`: `pending` → закрыть сессию с итогом `failed` тем же путём, что метод `sessions.close` (найти по `git grep -n "'sessions.close'" origin/master -- packages/host/src/methods`), системное письмо создателю «launch refused: folder not trusted» (`addMessage` под `updateMap`, как в `resumeFailed`); `sleeping` → ничего (письма ждут).
- Produces (`wake-service.ts`): результат `'held'` от `sessions.launch` обрабатывается как отказ по бюджету без письма о сбое: `limiter.release(ref)`, id писем убираются из `state.pointed`, `state.trustHeld = true`, `publishWaiting(ref, state, 'folder-trust')` (новая причина в типе причин `publishWaiting`); в `recompute` `trustHeld` действует как `backedOff`; `WakeService.retry(ref: SessionRef): void` сбрасывает `trustHeld` и `budgetDeniedAt` и зовёт `recompute(ref)`.
- Produces (`feed-service.ts`): опция `codexApprovals?: () => Promise<boolean>` переименовывается в `codexHooks?: () => Promise<boolean>` с умолчанием `codexHooksWanted((await loadConfig()).config)`.
- Produces (`session-endpoint.ts`, `session-tools.ts`): ответ `{ ok: true, result: { sessionId, provider, held?: 'folder-trust' } }`; инструмент при `held` добавляет к JSON строку «The session waits for the human to trust the folder; it starts by itself after that.».
- Produces (`methods/consents.ts`): `createConsentHandlers(deps: { consents: ConsentsService; home: string }): Record<string, AnyHandler>` для `consents.list`, `consents.decide` (`by` для `trust.grant` берётся из `request.client` — остров/окно → `'window'`, Telegram зовёт сервис напрямую с `'telegram'`), `trust.list`, `trust.grant`, `trust.revoke`; регистрация в `methods/index.ts` (не в `WORKS_GATED_METHODS`); `host.ts` создаёт сервис и передаёт его в `sessions`, `telegram` (поле `consents`, задача 7) и обработчики.

- [ ] **Шаг 1: тесты** `consents-service.test.ts` (временный home, фейки `trust`, `continueLaunch`, `refuseLaunch`): два `request` на одну папку → одна карточка и два удержания; `decide('allow')` зовёт `trust.grant` один раз и `continueLaunch` дважды, второй `decide` → `applied: false`; `decide('deny')` зовёт `refuseLaunch`; после `stop()` и повторного `createConsentsService` карточка и удержания читаются из файла, удержание сессии с `isLive → true` отброшено; событие `onChange` при `request` и `decide`. `sessions-service.test.ts`: запуск Codex в проекте без записи в `trust.json` возвращает `'held'`, не трогает бюджет и не создаёт worktree, а `consents.request` вызван с `source: 'agent'` для `by: 'auto'`; с записью → `'started'` и `planLaunch` получил `trust` с realpath; Claude без записи → `'started'`; версия Codex `0.160.0` при `auto` → `planLaunch` получил `codexWriteApprovals: 'terminal'` и ушёл `host.notice` `codex-auto-unsupported`. `feed-service.test.ts`: переименованная опция. `index.test.ts`: пять новых методов в списке. `session-tools.test.ts`: ответ с `held` содержит фразу ожидания.

- [ ] **Шаг 2: прогнать — падают.**

- [ ] **Шаг 3: реализовать** по интерфейсам; wake — отдельным коммитом внутри задачи, если удобнее.

- [ ] **Шаг 4: прогнать — зелёные**: `pnpm -F @parley/host exec vitest run src/consents src/sessions/sessions-service.test.ts src/feed/feed-service.test.ts src/methods/index.test.ts` и `tsc --noEmit` в `host` и `core`.

- [ ] **Шаг 5: коммит** `feat(host): folder-trust consents hold Codex launches`.

---

### Задача 7: Telegram — карточка согласия

**Файлы:**
- Modify: `packages/host/src/telegram/types.ts` (`CardRecord` 51–82, `AuditEntry.kind` 107), `packages/host/src/telegram/cards.ts`, `packages/host/src/telegram/texts.ts`, `packages/host/src/telegram/service.ts` (`TelegramServiceDeps` 48–68, `cardHeader` 344, `closeCard` 389, `sendRoomCard` 583 как образец, `onCallback` 927–956, `waitingCard` 808, `onCommand` 882, `closeStaleCards` 1023, `start` 1087)
- Test: `packages/host/src/telegram/cards.test.ts`, `packages/host/src/telegram/callbacks.test.ts`, тест сервиса для карточки согласия (новый `service.consent.test.ts` по образцу существующих тестов сервиса, если такие есть; иначе — тесты `cards.ts` плюс проверка `onCallback` через публичный `handleUpdate`, как делают соседние тесты)

**Interfaces:**
- Consumes: `ConsentCard`, `ConsentsService` (`list`, `decide`, `onChange`) из задач 4 и 6; `host.ts` уже передаёт `consents` (задача 6) — здесь только тип `TelegramServiceDeps.consents?: Pick<ConsentsService, 'list' | 'decide' | 'onChange'>`.
- Produces: `CardRecord` + `{ kind: 'consent'; consentId: string; chatId: number; messageId: number; at: string }`; `export function consentCardMessage(input: { card: ConsentCard; projectName: string; requestedByLabel: string; shortId: string }): { text: string; keyboard: InlineKeyboard }` — текст `<b>Trust folder for agents?</b>\n<папка>\nRequested by <label> · <projectName>`, кнопки `B.trust` (`pc1:<shortId>:a`) и `B.deny` (`pc1:<shortId>:d`); `T.trusted = 'Trusted ✓'`, `T.denied = 'Denied'`; в сервисе `sendConsentCard(card)` по событию `consents.onChange` (`upsert` с `state: 'pending'`, при `cfg.telegramCards === true` и `canSend()`), закрытие по `removed` или по решению в другом месте — `closeCard(shortId, T.answeredAtMac)`; `onCallback`: `record.kind === 'consent'` → `consents.decide(consentId, code === 'a' ? 'allow' : 'deny')`, `applied: false` → `T.answeredAtMac`, успех → `closeCard(shortId, T.trusted | T.denied)` и `audit({ kind: 'decision', shortId, result })`; `cardHeader` для `consent` — `<b>Trust folder</b>`; `closeStaleCards` закрывает и `consent`; старт сервиса отправляет уже ждущие `consents.list()`.

- [ ] **Шаг 1: тесты**: `consentCardMessage` даёт ожидаемый HTML и клавиатуру с данными `pc1:<id>:a` / `pc1:<id>:d`; `parseCallback('pc1:abc:a')` уже проходит; сервис: событие `onChange` с карточкой → `send('card', …)` вызван и запись `kind: 'consent'` в `state.cards`; callback `a` → `consents.decide(id, 'allow')` и `editMessageText` с `Trusted ✓`; `removed` → закрытие с `T.answeredAtMac`.

- [ ] **Шаг 2: прогнать — падают.**

- [ ] **Шаг 3: реализовать.**

- [ ] **Шаг 4: прогнать — зелёные**: `pnpm -F @parley/host exec vitest run src/telegram` и `tsc --noEmit`.

- [ ] **Шаг 5: коммит** `feat(telegram): folder-trust consent card`.

---

### Задача 8: настройки окна — три режима и список согласий

**Файлы:**
- Create: `packages/desktop/src/renderer/components/settings/ProjectsSettings.tsx`, `ProjectsSettings.test.tsx`
- Modify: `packages/desktop/src/renderer/components/settings/SettingsDialog.tsx` (`SECTION_LABELS`/`SECTION_ORDER` 56–67, блок `codexApprovals` 358–379), `packages/desktop/src/renderer/store/ui.ts` (`SettingsSection` 26), `packages/desktop/src/shared/strings.ts` (`settings` 1014–1025, 1042–1043), `packages/desktop/src/renderer/test-utils/fake-bridge.ts` (ответы `trust.list` / `trust.revoke`)
- Test: тест `SettingsDialog` (существующий файл рядом), `ProjectsSettings.test.tsx`

**Interfaces:**
- Consumes: `ParleyConfig.codexWriteApprovals` (задача 1), методы `trust.list` / `trust.revoke` (задачи 4, 6), `settings.set { key: 'codexWriteApprovals', value }`.
- Produces: в секции Agents вместо `Switch` — три варианта (`ToggleGroup`, как в композере), `aria-label={S.settings.codexWriteApprovals}`, значения `auto | parley | terminal`, подписи `S.settings.codexWriteApprovalsOptions.{auto,parley,terminal}` = «Auto-review (Codex's reviewer decides; nothing to answer)», «Ask in Parley (cards on the island and in Telegram; Codex asks once to trust Parley's hooks)», «Ask in the terminal»; подсказка про `/hooks` только при `parley`; `locked.codexWriteApprovals` блокирует. Новая секция `projects` (`SettingsSection` + `SECTION_LABELS.projects = 'Projects'`), компонент `ProjectsSettings({ bridge })`: список `trust.list` (папка, дата, `by`), кнопка `Revoke` → `trust.revoke` и перечитывание, пустое состояние «No trusted folders yet». Строки `codexApprovals`/`codexApprovalsHint` удаляются.

- [ ] **Шаг 1: тесты**: SettingsDialog показывает три варианта и зовёт `settings.set` с `{ key: 'codexWriteApprovals', value: 'parley' }`; `ProjectsSettings` рендерит две папки из фейка, `Revoke` зовёт `trust.revoke` с той же папкой и убирает строку.

- [ ] **Шаг 2: прогнать — падают.**

- [ ] **Шаг 3: реализовать.**

- [ ] **Шаг 4: прогнать — зелёные**: `pnpm -F @parley/desktop exec vitest run src/renderer/components/settings` и `tsc --noEmit`.

- [ ] **Шаг 5: коммит** `feat(settings): Codex approval modes and trusted folders`.

---

### Задача 9: остров — карточка согласия

**Файлы:**
- Create: `packages/desktop/src/renderer/island/consents/store.ts`, `store.test.ts`, `ConsentView.tsx`, `ConsentView.test.tsx`
- Modify: `packages/desktop/src/shared/island.ts` (`ISLAND_METHODS` 102–111, `ISLAND_EVENTS` 118), `packages/desktop/src/renderer/island/IslandApp.tsx` (подписки 150–161 и 198–230, `idle` 232, эффект «новый запрос → выдвинуть + beep» 259–271), `packages/desktop/src/renderer/island/IslandView.tsx` (пропсы 75–105, выбор 369–378), `packages/desktop/src/shared/strings.ts` (`island`)
- Test: `store.test.ts`, `ConsentView.test.tsx`, `IslandApp.test.tsx`, `IslandView.test.tsx`

**Interfaces:**
- Consumes: `consents.list`, `consents.decide`, событие `consents.changed` (задачи 4, 6).
- Produces: `ISLAND_METHODS` + `'consents.list'`, `'consents.decide'`; `ISLAND_EVENTS` + `'consents.changed'`; стор `useConsentsStore` (`createConsentsStore()` по образцу `createAssistantStore`): состояние `{ items: ConsentCard[]; deciding: string | null; note: 'elsewhere' | 'failed' | null }`, `configure({ call })`, `apply(change: { upsert; removed })`, `replace(items)`, `decide(id, decision: 'allow' | 'deny')` → `consents.decide`, `applied: false` → `note: 'elsewhere'` на `ELSEWHERE_MS`; подписка в `IslandApp` как у помощника (начальный `consents.list`, `bridge.on('consents.changed')`); `IslandView` показывает `ConsentView` раньше карточек ленты, когда `consents.items.length > 0` и помощник не раскрыт; `ConsentView({ card, deciding, note, onDecide })`: заголовок `S.island.consentTitle` = «Trust folder for agents?», папка с сокращением середины (как у заголовков), строка «requested by <label> · <source>», кнопки `data-testid="island-consent-trust"` («Trust») и `island-consent-deny` («Deny»), взвод кнопок `CARD_ARM_MS`, «Done ✓» на `ANSWER_HOLD_MS`, «Already answered» при `elsewhere`; новая карточка выдвигает остров и даёт `beep` при `config.sound` (тот же эффект, что для запросов); фразы подтверждения («да») решают `allow`, когда показана карточка согласия (`replies.ts`).

- [ ] **Шаг 1: тесты**: стор — `apply` с `upsert` добавляет, с `removed` убирает, `decide` зовёт `consents.decide` и чистит `deciding`; `ConsentView` — кнопки и подписи, клик `Trust` → `onDecide(id, 'allow')`; `IslandView` — при карточке согласия и ждущем запросе ленты показывается согласие; `IslandApp` — подписка на `consents.changed` и начальный `consents.list`.

- [ ] **Шаг 2: прогнать — падают.**

- [ ] **Шаг 3: реализовать.**

- [ ] **Шаг 4: прогнать — зелёные**: `pnpm -F @parley/desktop exec vitest run src/renderer/island` и `tsc --noEmit`.

- [ ] **Шаг 5: коммит** `feat(island): folder-trust consent card`.

---

### Задача 10: окно — диалог доверия в композере, карточка при открытом окне, подсказка в Chat

**Файлы:**
- Create: `packages/desktop/src/renderer/components/dialogs/TrustFolderDialog.tsx`, `TrustFolderDialog.test.tsx`, `packages/desktop/src/renderer/store/consents.ts`
- Modify: `packages/desktop/src/renderer/sidebar/NewWorkComposer.tsx` (`submit` 385–409 между `validateDraft` и `works.create`), `packages/desktop/src/renderer/App.tsx` (подписки 189–239), `packages/desktop/src/renderer/chat/ChatView.tsx` (подсказка 383–385, 471–481), `packages/desktop/src/shared/strings.ts`, `packages/desktop/src/renderer/test-utils/fake-bridge.ts`
- Test: `TrustFolderDialog.test.tsx`, тест композера (существующий рядом с `NewWorkComposer.tsx`), тест `ChatView`

**Interfaces:**
- Consumes: `trust.list`, `trust.grant { folder, by: 'window' }`, `consents.list`, `consents.decide`, `consents.changed`.
- Produces: `TrustFolderDialog({ open, folder, requestedBy?: string, onTrust, onCancel })` на базе `ConfirmDialog`: заголовок «Trust <папка> for agents?», текст из спеки 4.2 п. 1 (без экрана доверия Codex, `workspace-write`, конфигурация `.codex/` репозитория, действует до отзыва в Settings → Projects, для Claude Code пока ничего не меняется), кнопки «Trust» / «Cancel»; композер: после `validateDraft` — `trust.list`; папки нет → диалог; `Trust` → `trust.grant` → дальше `works.create`; `Cancel` → возврат в композер без работы; стор `useConsentsStore` главного окна (как стор острова, с `init(bridge)`): при `upsert` и активном окне — тот же `TrustFolderDialog` с `requestedBy`, решение → `consents.decide` (`Trust` → allow, `Cancel` → ничего, карточка остаётся на острове); `ChatView`: у сессии, чей `sessionId` есть в `requestedBy` ждущей карточки (или `lifecycle === 'pending'` при ждущей карточке того же `projectPath`) — строка `S.chat.waitingForTrust` = «Waiting for folder trust» и кнопка «Trust folder», открывающая диалог; `hooksHint` показывается только при `codexWriteApprovals === 'parley'` (окно читает конфиг через `settings.get`, как делает `SettingsDialog`, или получает его из `onConfigChange`).

- [ ] **Шаг 1: тесты**: композер с фейком `trust.list → []` показывает диалог и не зовёт `works.create` до `Trust`; после `Trust` — `trust.grant({ folder, by: 'window' })` и `works.create`; `Cancel` — ни того ни другого; с папкой в `trust.list` диалога нет; `TrustFolderDialog` — текст содержит папку и `.codex`; `ChatView` — строка ожидания при ждущей карточке.

- [ ] **Шаг 2: прогнать — падают.**

- [ ] **Шаг 3: реализовать.**

- [ ] **Шаг 4: прогнать — зелёные**: `pnpm -F @parley/desktop exec vitest run src/renderer/sidebar src/renderer/components/dialogs src/renderer/chat` и `tsc --noEmit`.

- [ ] **Шаг 5: коммит** `feat(window): trust-folder dialog, consent prompt and waiting hint`.

---

### Задача 11: E2E

**Файлы:**
- Modify: `packages/desktop/e2e/island.spec.ts` (`open` 205–242, образец теста 244), `packages/desktop/e2e/codex-chat.spec.ts` (166), `packages/desktop/e2e/agent-skills.spec.ts` (214), общий хелпер E2E, где создаётся `PARLEY_HOME`, новый спек `packages/desktop/e2e/trust.spec.ts`
- Test: сами спеки

**Interfaces:**
- Consumes: `trust.json` (задача 4), карточка согласия на острове (задача 9), диалог композера (задача 10), `PARLEY_CODEX_WRITE_APPROVALS` (задача 1).
- Produces: хелпер `seedTrust(home: string, folder: string)` пишет `trust.json` с realpath папки проекта перед стартом приложения; все спеки, запускающие Codex (`stub-codex-agent.mjs`), сеют доверие; `PARLEY_CODEX_APPROVALS: '1'` в спеках заменяется на `PARLEY_CODEX_WRITE_APPROVALS: 'parley'`; новый `trust.spec.ts`: (1) без `seedTrust` создание сессии Codex через `sessions.create` оставляет её `pending`, на острове появляется `island-card` с `island-consent-trust`, клик → сессия стартует (`chat-view` живой), `trust.json` содержит папку; (2) композер в новой папке показывает диалог, `Cancel` не создаёт работу, `Trust` создаёт; окно 800×500 без горизонтальной прокрутки (как в соседних E2E).

- [ ] **Шаг 1: написать спеки и хелпер.**

- [ ] **Шаг 2: прогнать** `pnpm -F @parley/desktop exec playwright test e2e/trust.spec.ts e2e/island.spec.ts e2e/codex-chat.spec.ts` (при высокой нагрузке машины — по одному; см. память о чувствительности E2E) — ожидание: PASS.

- [ ] **Шаг 3: коммит** `test(e2e): folder trust card and dialog`.

---

### Задача 12: документы и приёмка

**Файлы:**
- Modify: `README.md` (разделы Codex и остров), `CHANGELOG.md` (`## Unreleased`), `docs/research/2026-09-29-codex-research.md` (пометки к 13.2 и 13.3), `docs/specs/2026-10-21-codex-trust-policy-tools-design.md` (раздел 9: цифры 6.4 и отметки приёмки)

- [ ] **Шаг 1: README и CHANGELOG** — по-английски: доверие к папке (диалог, остров, Telegram, Settings → Projects, без записи в `~/.codex`), три режима `codexWriteApprovals` и их смысл, `never` у ролей только для чтения, профиль `short`, правило «после report — стоп».

- [ ] **Шаг 2: исследование** — в 13.2 и 13.3 ссылка на спеку и принятые решения.

- [ ] **Шаг 3: живая приёмка по разделу 9 спеки** (человек, на его Codex): пункты 1–5 и 7; цифры 6.4 «до/после» записать в спеку; при зацикливании роли только для чтения на отвергнутой записи — откат из 5.1 отдельной правкой.

- [ ] **Шаг 4: коммит** `docs: Codex trust, approval modes and short tool profile`.

---

## Самопроверка плана

- Покрытие спеки: 4.1 → задача 4; 4.2 → 6, 10, 11; 4.3 → 2, 5, 6; 4.4 → 4, 6, 7, 9; 5.1–5.2 → 1, 2, 5, 6, 8; 5.4 → ветка `fix/claude-browser-tools-allow` (вне плана, уже запушена); 6.1–6.3 → 3, 5; 6.4 и раздел 9 → 12; раздел 7 — все задачи.
- Имена сквозные: `codexWriteApprovals` / `CodexWriteApprovals` / `codexHooksWanted` (1 → 5, 6, 8, 10); `codexPolicyArgs`, `trustArgs`, `CODEX_AUTO_MIN_VERSION` (2 → 5, 6); `toolProfile` / `TOOL_PROFILE` / `CODEX_TOOL_EXAMPLES` (3 → 5); `trustKey`, `isTrusted`, `grantTrust`, `revokeTrust`, `listTrust`, `ConsentCard`, `consentMethodSchemas` (4 → 6, 7, 8, 9, 10); `launch(): Promise<'started' | 'held'>`, `ConsentsService`, `HeldLaunch`, `WakeService.retry` (6 → 7); `useConsentsStore` — два разных стора (остров `island/consents/store.ts`, окно `store/consents.ts`), импортируются из своих путей.
- Review Focus: пять пунктов привязаны к задачам 2, 4, 5, 6, 7.
