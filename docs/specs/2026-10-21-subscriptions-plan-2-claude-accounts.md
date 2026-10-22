# Подписки, этап 2: второй аккаунт Claude Code — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** из окна Parley добавляется ещё один аккаунт Claude Code того же человека: имя, своя папка `~/.parley/providers/<id>/`, вход из Parley через `claude auth login` в браузере; он полноценный провайдер с собственными лимитами, а агенты видят в `get_map` лимиты и доступность всех провайдеров от хоста и получают при лимите участника письмо со свободными аккаунтами.

**Architecture:** запись вида `claude-account` в том же `custom-providers.json` и тот же раздел Settings → Providers, что у своих провайдеров (PR #86). Запись реестра строится из реестровой записи `claude` после `providers.json` с `configDir` и без ключа; окружение запуска — та же ветка изоляции, что у ключевых провайдеров, но без ключа и без `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`. Состояние входа узнаёт хост у самого CLI (`claude auth status --json`), вход идёт в отдельном маленьком PTY; агентам строки провайдеров отдаёт хост по `POST /agent/providers`.

**Tech Stack:** TypeScript, pnpm-монорепо, zod, vitest, React + Radix + zustand, xterm (окно), node-pty (хост), Playwright.

**Spec:** `docs/specs/2026-10-21-subscriptions-design.md` — разделы 4.1–4.3, 5.1, 5.3–5.6 (Claude), 5.8, 5.9, 6, 8 (К1–К3, К5, К7–К15, К17, К18), 9, 10. Карты кода: `…/scratchpad/map-custom-providers.md` (могут исчезнуть; ориентир — file:line ниже, по `origin/master` ad5ecbf8).

## Global Constraints

- Ветка `feat/subscriptions` после слияния этапа 1 (или от `origin/master`, если этап 1 уже влит). Коммиты и PR — по-английски, `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Тесты — только затронутых файлов; полный прогон запрещён; не больше двух параллельных исполнителей (Sonnet) по непересекающимся файлам; `get_usage` перед волной.
- После правки ядра/протокола — `pnpm --filter @parley/core build` / `pnpm --filter @parley/protocol build` до тестов хоста; окно — `pnpm --filter @parley/desktop typecheck`.
- Минимальная версия Claude Code для аккаунтов — `ACCOUNT_MIN_VERSION_CLAUDE`: не ниже `2.1.302`, точное значение даёт задача 0 (версия, где есть `claude auth login/status/logout`). GLM и свои провайдеры — прежние версии.
- Id аккаунта Claude — `custom-<slug>`, стандартный slug `claude-2`, `claude-3`, …; папка `~/.parley/providers/<id>/`.
- Parley не читает связку ключей и `.credentials.json`; состояние входа — только через команду CLI. Parley ничего не пишет в `~/.claude`, `~/.claude.json` и `$CLAUDE_CONFIG_DIR` хоста.
- `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` у аккаунтов не ставится (К12); у своих провайдеров `endpoint` остаётся.
- Тексты окна, писем и гида — английские; комментарии — по-русски со ссылкой на раздел спеки; `frame-scan` — исключения с причиной «спека подписок N.M».
- Поведение `claude`, `codex`, `glm` и своих провайдеров `endpoint` не меняется: их тесты проходят без правок ожиданий, кроме мест, где план прямо меняет форму (`needs: 'sign-in'`, `custom.kind`).

## Review Focus

1. **Аккаунт сохранён, но вход не выполнен — человек жмёт New session.** Пилюля приглушена, запуск отказан с текстом `<name> is not signed in: open Settings → Providers and press Sign in`, в карте нет записи сессии; тест — задача 5 (`sessions-service` через `createTimed` с `signedIn: () => false`).
2. **Унаследованный `ANTHROPIC_API_KEY` в окружении хоста.** Сессия аккаунта его не получает, а обычный Claude — как раньше; тест — задача 4 (`provider-env.test.ts`).
3. **Второй Sign in, пока идёт первый.** Отказ `conflict` с текстом `another sign-in is running`, первый процесс жив; тест — задача 6 (`auth-service.test.ts`).
4. **Хост недоступен из процесса MCP.** `get_map.providers` — прежние строки без `limits`, с `note`; агент не падает; тест — задача 7 (`mcp/server.test.ts` с `agent.url` на закрытый порт).
5. **Старое окно (без поля `kind`) с новым хостом и наоборот.** Старое окно показывает аккаунт как свой провайдер без формы адреса (ничего не ломается); новое окно без `kind` от старого хоста читает `endpoint`; тест — задача 8 (`custom-provider-draft.test.ts`, `kindOf`).

---

### Task 0: Пробы до кода (спека 9, задача 0)

Все пробы — в scratchpad, не в репозитории; вход в браузере выполняет человек (нужно его разрешение и присутствие).

- [ ] **Step 1:** `CLAUDE_CONFIG_DIR=$S/acct-claude claude auth login` в интерактивном терминале: открывается ли браузер, какие вопросы задаёт CLI, что печатает при успехе. После — `CLAUDE_CONFIG_DIR=$S/acct-claude claude auth status --json`: записать поля ответа (e-mail, план). Глобальный `claude auth status --json` — не изменился.
- [ ] **Step 2:** `security find-generic-password -s 'Claude Code' 2>&1 | head -3` и поиск записи с хвостом (`-<8 hex>`) — только имена, без `-w`. Записать имя записи аккаунта.
- [ ] **Step 3:** Сессия в той же папке **без** `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`: `CLAUDE_CONFIG_DIR=$S/acct-claude claude -p 'Reply with one word: ok'` отвечает на подписке; интерактивно `/login` и `/logout` трогают только запись с хвостом (повторить шаг 2 после каждого).
- [ ] **Step 4:** Версии: `claude --help` в нескольких версиях из `~/.local/share/claude/versions/` — с какой есть `auth`; результат → `ACCOUNT_MIN_VERSION_CLAUDE`.
- [ ] **Step 5:** `ANTHROPIC_API_KEY=x CLAUDE_CONFIG_DIR=$S/acct-claude claude auth status --json` и `claude -p …`: перебивает ли ключ вход (ожидание: да) — список переменных для 5.3 (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`).
- [ ] **Step 6:** Записать итоги в спеку подписок, новый подраздел «9.1 Итоги задачи 0 (Claude)»; `CLAUDE_CONFIG_DIR=$S/acct-claude claude auth logout`; папку удалить. Commit `docs(specs): subscriptions — results of the Claude Code sign-in probe`.

### Task 1: Протокол — вид записи, состояние входа, методы входа, `needs: 'sign-in'`

**Files:**
- Modify: `packages/protocol/src/custom-providers.ts`, `packages/protocol/src/methods.ts:338-390` (`providers.list`), `packages/protocol/src/events.ts:26-37`, `packages/protocol/src/index.ts`.
- Test: `packages/protocol/src/custom-providers.test.ts`, `packages/protocol/src/methods.test.ts`.

**Interfaces (produces):**
```ts
export type CustomProviderKind = 'endpoint' | 'claude-account' | 'codex-account';
export const CODEX_ACCOUNT_PREFIX = 'codex-';
export function isCustomProviderId(id: string): boolean;   // как сейчас: custom-
export function isCodexAccountId(id: string): boolean;     // codex-
export function isManagedProviderId(id: string): boolean;  // custom- или codex-
export interface CustomEndpointInfo { kind: 'endpoint'; preset; baseUrl; auth; models; contextWindow; linkClaude; folder }  // прежние поля
export interface CustomAccountInfo { kind: 'claude-account' | 'codex-account'; link: boolean; folder: string; signedIn: boolean | null; signingIn: boolean }
export type CustomProviderInfo = CustomEndpointInfo | CustomAccountInfo;
```
- `customId` (`:34`) — `^(custom|codex)-[a-z0-9]+(?:-[a-z0-9]+)*$`, max 40.
- `providers.saveCustom` — `z.discriminatedUnion('kind', [endpoint, account])`: `endpoint` = прежняя схема + `kind: z.literal('endpoint')`; `account` = `{ kind: z.enum(['claude-account','codex-account']), id: customId.nullable(), label: z.string().trim().max(40).regex(/^[^\x00-\x1f]*$/) (пустая допустима), link: z.boolean() }`.
- Новые методы и результаты: `providers.authStatus {provider}` → `{ signedIn: boolean; detail: string | null }`; `providers.signIn {provider}` → `{ ok: true }`; `providers.signInInput {provider, data: string(max 4096)}` → `{ ok: true }`; `providers.signInResize {provider, cols: int 20..500, rows: int 5..200}` → `{ ok: true }`; `providers.cancelSignIn {provider}` → `{ ok: true }`; `providers.signOut {provider}` → `{ ok: true }`.
- События: `'providers.signInOutput': { provider: string; data: string }`, `'providers.signInExit': { provider: string; exitCode: number; signedIn: boolean }`.
- `providers.list`: `needs?: 'cli' | 'key' | 'sign-in' | null`; `family?: 'claude' | 'codex' | null` (значение `codex` появится в этапе 3, тип — сейчас).

- [ ] **Step 1: Падающие тесты** (`custom-providers.test.ts`): `saveCustom` принимает прежнюю запись с `kind: 'endpoint'` и отвергает без `kind`; принимает `{ kind: 'claude-account', id: null, label: '', link: true }`; отвергает `label` длиннее 40 и с управляющим символом; `deleteCustom` принимает `codex-two`; `isCodexAccountId('codex-two')` true, `isCustomProviderId('codex-two')` false; `methods.test.ts`: шесть новых методов есть в `METHODS`, `signInInput` отвергает `data` длиннее 4096.
- [ ] **Step 2:** `pnpm --filter @parley/protocol exec vitest run src/custom-providers.test.ts src/methods.test.ts` → FAIL.
- [ ] **Step 3: Реализовать** по интерфейсу; `pnpm --filter @parley/protocol build`.
- [ ] **Step 4:** тесты → PASS.
- [ ] **Step 5: Commit** `feat(protocol): account kind of custom providers, sign-in methods and events, needs sign-in`.

### Task 2: Ядро — запись аккаунта, реестр, готовность

**Files:**
- Modify: `packages/core/src/custom-providers.ts` (`CUSTOM_ID_PATTERN` `:52`, `asRecord` `:110`, `customProviderEntry` `:165`), `packages/core/src/providers.ts` (`ProviderReadiness` `:742`, `ProviderReadinessOptions` `:748`, `providerReadiness` `:759`, `providerReadinessError` `:783`, `applyOverride` `:1071`, `loadProviders` `:1135`), `packages/core/src/discover.ts:54` (`customProviderProjectRoots` — только `custom-`), `packages/core/src/index.ts`.
- Test: `packages/core/src/custom-providers.test.ts`, `packages/core/src/providers.test.ts`, `packages/core/src/provider-readiness.test.ts`, `packages/core/src/discover.test.ts`.

**Interfaces (produces):**
```ts
export interface CustomEndpointRecord { kind: 'endpoint'; id; label; preset; baseUrl; auth; models; contextWindow; linkClaude }  // прежняя запись + kind
export interface CustomAccountRecord { kind: 'claude-account' | 'codex-account'; id: string; label: string; link: boolean }
export type CustomProviderRecord = CustomEndpointRecord | CustomAccountRecord;
export const ACCOUNT_MIN_VERSION_CLAUDE: string;   // из задачи 0
export function isAccountRecord(record: CustomProviderRecord): record is CustomAccountRecord;
export function isValidCustomProviderId(id: string): boolean;   // оба префикса
export function defaultAccountLabel(kind: CustomAccountRecord['kind'], records: readonly CustomProviderRecord[]): string; // 'Claude Code N' / 'Codex N', N = число записей того же kind + 2
export function accountLabel(record: CustomAccountRecord, records: readonly CustomProviderRecord[]): string; // label || defaultAccountLabel
export function accountProviderEntry(record: CustomAccountRecord, registry: Readonly<Record<string, ProviderEntry>>, home?: string): ProviderEntry;
```
- `asRecord`: запись без `kind` читается как `endpoint` (миграции нет); `claude-account` требует `id` с `custom-`, `codex-account` — с `codex-`.
- `accountProviderEntry` для `claude-account`: раннер — копия `registry['claude'].runner` (все поля, включая `args`, `resumeArgs`, `printArgs`, `assistant*`, `mcpConfig`, `settingsModel`) плюс `configDir: customProviderDir(id, home)`, `minVersion: ACCOUNT_MIN_VERSION_CLAUDE`; **без** `secret`, `auth`, `env`, `keyOptional`; `family: 'claude'`, `label: accountLabel(…)`, `mark` — 2 символа имени, `hasHistory: true`, `linkBy: 'session-id'`, `models: registry['claude'].models`, `custom: record`. Для `codex-account` — бросает `Error('codex accounts arrive in stage 3')` (этап 3 заменяет).
- `loadProviders`: `endpoint` → `customProviderEntry` (как сейчас, `customProviderEntry` принимает только `endpoint`); аккаунты → `accountProviderEntry(record, registry)`; `codex-account` до этапа 3 — пропуск с `console.warn` **не** допускается: запись в файл такого вида хост на этом этапе не создаёт (задача 5), а чужую — `loadProviders` пропускает молча и тест это фиксирует (строка в комментарии: «этап 3»).
- `ProviderReadiness.needs: 'cli' | 'key' | 'sign-in' | null`; `ProviderReadinessOptions.signedIn?: boolean | null`; правило: `entry.custom !== undefined && isAccountRecord(entry.custom) && options.signedIn !== true` → `{ needs: 'sign-in', error: null, version }` после проверок CLI и версии. `providerReadinessError` для `sign-in`: `` `${label} is not signed in: open Settings → Providers and press Sign in` ``; для `cli` у аккаунта: `` `${label} requires Claude Code ${minVersion} or newer; install or update the CLI and check again` ``.
- `applyOverride`: `isManagedProviderId(id)` → `the custom- and codex- prefixes are reserved`.
- `customProviderProjectRoots`: фильтр `isCustomProviderId(entry.name)` (не `isValidCustomProviderId`).

- [ ] **Step 1: Падающие тесты**

`custom-providers.test.ts`:
```ts
it('asRecord: запись без kind — endpoint; claude-account без адреса и ключа (спека 5.1)', async () => { /* файл с двумя записями → readCustomProviders даёт [endpoint, account] */ });
it('accountProviderEntry: копия раннера claude из реестра после providers.json, своя папка, без секрета и env (спека 5.2, К11, К12)', async () => {
  const registry = await loadProviders(providersJsonWithClaudeArgsOverride, codexFile, customFile);
  const entry = accountProviderEntry({ kind: 'claude-account', id: 'custom-claude-2', label: '', link: true }, registry, home);
  expect(entry.runner.args).toEqual(registry['claude']!.runner.args);
  expect(entry.runner.configDir).toBe(path.join(home, 'providers', 'custom-claude-2'));
  expect(entry.runner.secret).toBeUndefined(); expect(entry.runner.env).toBeUndefined();
  expect(entry.runner.minVersion).toBe(ACCOUNT_MIN_VERSION_CLAUDE);
  expect(entry.label).toBe('Claude Code 2'); expect(entry.family).toBe('claude'); expect(entry.linkBy).toBe('session-id');
});
it('defaultAccountLabel: второй аккаунт — 2, третий — 3; endpoint не считается (К1)', …);
it('isValidCustomProviderId принимает codex-two, isCustomProviderId — нет (К8)', …);
```
`provider-readiness.test.ts`: аккаунт с `signedIn: null` → `needs: 'sign-in'`; с `signedIn: true` → `needs: null`; `providerReadinessError` даёт текст выше; `endpoint` и `glm` — прежние ожидания.
`providers.test.ts`: `providers.json` с id `codex-mine` → ошибка `the custom- and codex- prefixes are reserved`.
`discover.test.ts`: папки `custom-a` и `codex-b` в `<home>/providers` → `customProviderProjectRoots` возвращает только `custom-a/projects`.
Run: `pnpm --filter @parley/core exec vitest run src/custom-providers.test.ts src/providers.test.ts src/provider-readiness.test.ts src/discover.test.ts` → FAIL.

- [ ] **Step 2: Реализовать** по интерфейсу; `pnpm --filter @parley/core build`.
- [ ] **Step 3:** тесты шага 1 + `src/secrets.test.ts` → PASS.
- [ ] **Step 4: Commit** `feat(core): account records of custom providers, registry entry of a Claude account, needs sign-in`.

### Task 3: Ядро — папка аккаунта и правило о ссылках

**Files:**
- Modify: `packages/core/src/custom-provider-dir.ts` (`prepareCustomProviderDir` `:161` — `record.linkClaude` → `wantLinks(record)`; `syncApiKeyApproval` `:264` — для аккаунта no-op), `packages/core/src/work/launch.ts:434-435` (`linkedSettingsRule` при `link`).
- Test: `packages/core/src/custom-provider-dir.test.ts`, `packages/core/src/work/launch.test.ts`.

**Interfaces:**
- Produces: `export function wantLinks(record: CustomProviderRecord): boolean` — `endpoint` → `linkClaude`, аккаунт → `link`. `prepareCustomProviderDir(record, options)` принимает оба вида; для аккаунта посев `.claude.json` тот же (`hasCompletedOnboarding: true`).
- `syncApiKeyApproval(id, key)` — вызывать только для `endpoint` (хост, задача 5); в ядре функция не меняется.

- [ ] **Step 1: Падающие тесты:** `custom-provider-dir.test.ts` — аккаунт с `link: true` получает ссылки `CLAUDE.md`, `skills/*`, `agents/*`; с `link: false` — папка и `.claude.json`, ссылок нет; `launch.test.ts` — сессия аккаунта с `link: true` получает правило `linkedSettingsRule` в брифе, с `link: false` — нет.
- [ ] **Step 2:** `pnpm --filter @parley/core exec vitest run src/custom-provider-dir.test.ts src/work/launch.test.ts` → FAIL. **Step 3: Реализовать; build.** **Step 4:** PASS. **Step 5: Commit** `feat(core): account folder — seeding and links by the account's link flag`.

### Task 4: Ядро и хост — окружение запуска и признаки «свой токен хуков» (5.3, К12, К13, К18)

**Files:**
- Modify: `packages/host/src/sessions/provider-env.ts:23-40`, `packages/core/src/work/launch.ts:385-388`, `packages/core/src/work/settings-file.ts:194`, `packages/host/src/sessions/sessions-service.ts:619-672` (секрет, папка, `watchClaudeRoot`, имя переменной токена `:669`), `:864-872` (`createTimed` — ранняя готовность).
- Test: `packages/host/src/sessions/provider-env.test.ts`, `packages/host/src/sessions/provider-launch.test.ts`, `packages/core/src/work/launch.test.ts`, `packages/core/src/work/settings-file.test.ts`.

**Interfaces:**
- `providerLaunchEnv(entry, inherited, planEnv, key)`: ветка изоляции при `entry.runner.secret !== undefined || entry.runner.configDir !== undefined`; в ней, как сейчас, срезаются `ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, `GLM_SELECTORS`, добавляется `runner.env` (у аккаунта его нет) и `CLAUDE_CONFIG_DIR = configDir`; `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` и ключ — **только** при `secret !== undefined`.
- Признак «свой токен хуков» — `export function ownsHookToken(entry: ProviderEntry): boolean` в `core/src/providers.ts` = `entry.id === 'glm' || entry.custom !== undefined`; `launch.ts:385-388` и `sessions-service.ts:669` используют его; `workSettings` (`settings-file.ts:194`) получает `hookTokenEnv` явно от `launch.ts` (умолчание по `provider === 'glm'` остаётся для старых вызовов).
- `sessions-service.ts`: блок `entry.custom !== undefined` (`:628-653`) — `syncApiKeyApproval` только при `isAccountRecord(custom) === false`; `createTimed` (`:869-871`) — `readyProvider` при `secret !== undefined || configDir !== undefined`.
- `readyProvider(provider)` (`:434`) принимает `signedIn` от службы входа (задача 6): `createSessionsService(…, { signedIn?: (id: string) => boolean | null })`.

- [ ] **Step 1: Падающие тесты**

`provider-env.test.ts`:
```ts
it('аккаунт Claude: своя папка, срезанные ключи и OAuth-переменные, без MANAGED_BY_HOST и без ключа (спека 5.3, К12)', () => {
  const env = providerLaunchEnv(account, { ...process.env, ANTHROPIC_API_KEY: 'inherited', CLAUDE_CODE_OAUTH_TOKEN: 'x', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/y' }, {}, null);
  expect(env.CLAUDE_CONFIG_DIR).toBe(account.runner.configDir);
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST']) expect(env[name]).toBeUndefined();
});
it('обычный claude: ничего не срезается (прежнее поведение)', …);
```
`provider-launch.test.ts`: запуск аккаунта → `PARLEY_HOOK_CAPABILITY` в окружении, файл настроек `settings-custom-claude-2.json`, `watchClaudeRoot(<папка>/projects)` вызван, `secrets.json` не читался (`readSecret` не вызван); `createTimed` с `signedIn: () => false` → `HostError` с текстом `… is not signed in …` и карта без сессии.
Run: `pnpm --filter @parley/core build && pnpm --filter @parley/host exec vitest run src/sessions/provider-env.test.ts src/sessions/provider-launch.test.ts` → FAIL.

- [ ] **Step 2: Реализовать; build core.** **Step 3:** тесты шага 1 + `core/src/work/launch.test.ts src/work/settings-file.test.ts` → PASS. **Step 4: Commit** `feat(host,core): launch environment of an account — own folder without a key; one hook-token predicate`.

### Task 5: Хост — сохранение аккаунта, список провайдеров

**Files:**
- Modify: `packages/host/src/methods/custom-providers.ts:43-90` (`saveCustom`/`deleteCustom` по `kind`), `packages/host/src/methods/providers.ts:44-125` (`providers.list`: `custom` по виду, `signedIn`, `needs`), `packages/host/src/methods/index.ts` (deps: `auth?: AuthService`).
- Test: `packages/host/src/methods/custom-providers.test.ts`, `packages/host/src/methods/providers.test.ts`.

**Interfaces:**
- Consumes: `AuthService.status(id)` (задача 6; до неё — `undefined` → `signedIn: null`).
- `saveCustom`: `kind: 'endpoint'` — как сейчас; `claude-account` — без `baseUrlError`, id из `slugProviderId(label || 'claude', taken)` с принудительным `custom-claude-N` при пустом имени (`defaultAccountSlug(kind, taken)`: `claude-2`, `claude-3`, …), запись `{kind, id, label, link}`, `prepareCustomProviderDir`, `providers.changed`; `codex-account` → `HostError('bad_request', 'Codex accounts are not supported by this host yet')` (снимает этап 3).
- `providers.list`: `custom` для аккаунта — `{ kind, link, folder, signedIn: auth?.status(id) ?? null, signingIn: auth?.signingIn(id) ?? false }`; `providerReadiness(entry, { …, signedIn })`.

- [ ] **Step 1: Падающие тесты:** сохранить `{ kind: 'claude-account', id: null, label: '', link: true }` → id `custom-claude-2`, файл записей без `baseUrl`, папка с `.claude.json` и ссылками; `providers.list` отдаёт `custom.kind === 'claude-account'`, `needs: 'sign-in'`, `available: false`, `label: 'Claude Code 2'`; с `auth.status` → `true` — `available: true`; `codex-account` → `bad_request`.
- [ ] **Step 2:** FAIL → **Step 3: Реализовать** → **Step 4:** PASS → **Step 5: Commit** `feat(host): save and list Claude accounts`.

### Task 6: Хост — служба входа (5.5, К14, К17)

**Files:**
- Create: `packages/host/src/providers/auth-service.ts`, `packages/host/src/providers/auth-service.test.ts`.
- Modify: `packages/host/src/methods/providers.ts` (обработчики шести методов), `packages/host/src/methods/index.ts`, `packages/host/src/host.ts` (создание рядом с `createCustomCheckService` `:531`, передача в `createSessionsService` как `signedIn`), `packages/host/src/sessions/sessions-service.ts:434` (`readyProvider` с `signedIn`).
- Test: `auth-service.test.ts`, `providers.test.ts`.

**Interfaces (produces):**
```ts
export interface AuthService {
  status(id: string): boolean | null;                 // кэш; null — не проверялось
  signingIn(id: string): boolean;                     // процесс входа этого аккаунта жив
  refresh(id: string): Promise<boolean>;              // команда статуса; не чаще раза в 30 с (К5), иначе кэш
  signIn(id: string, size?: { cols: number; rows: number }): Promise<void>; // conflict, если вход уже идёт
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  cancel(id: string): void;
  signOut(id: string): Promise<void>;
  stop(): void;
}
export interface AuthServiceOptions { spawn?: PtySpawn; exec?: (command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<{ code: number; stdout: string }>; now?: () => number; timeoutMs?: number /* 600_000 */; minGapMs?: number /* 30_000 */ }
export function createAuthService(host: HostContext, options?: AuthServiceOptions): AuthService;
export function authCommands(entry: ProviderEntry): { status: string[]; login: string[]; logout: string[]; parse(code: number, stdout: string): boolean } // claude: ['auth','status','--json'] → JSON.loggedIn === true; ['auth','login','--claudeai']; ['auth','logout']
```
- Окружение команд — `providerLaunchEnv(entry, process.env, {}, null)`; cwd — папка аккаунта; команда — `commandBinary(entry.runner.command)` (подмена `PARLEY_CLAUDE_BIN` работает, как у сессий).
- PTY входа — тот же спавн, что у `pty-process.ts` (исполнитель берёт существующий помощник спавна node-pty), **не** `PtyManager`; вывод → `host.broadcast('providers.signInOutput', { provider, data })`; выход → `refresh(id)` → `host.broadcast('providers.signInExit', { provider, exitCode, signedIn })` и `providers.changed`.
- Замок: один вход на хост (`signIn` при живом процессе любого id → `HostError('conflict', 'another sign-in is running')`); таймаут `timeoutMs` = `cancel`.
- `refresh` зовётся: при `start` хоста для всех аккаунтов, после `saveCustom`, после выхода процесса входа, после `signOut`, из `providers.refreshLimits`, из службы «застрял» при эпизоде `sign-in` у сессии аккаунта (этап 1, задача 5 — через `options.signedIn`/`refresh`).

- [ ] **Step 1: Падающие тесты** (`auth-service.test.ts`, фальшивые `exec`/`spawn`): `refresh` разбирает `{"loggedIn":true}` → `status === true`; повторный `refresh` раньше 30 с не зовёт `exec`; `signIn` шлёт `providers.signInOutput` с данными процесса и после выхода — `signInExit` с `signedIn` из свежего `refresh`; второй `signIn` → `conflict`; `cancel` убивает; `signOut` зовёт `['auth','logout']` и затем `refresh`; окружение команды не содержит `ANTHROPIC_API_KEY` из `process.env` и содержит `CLAUDE_CONFIG_DIR` папки.
- [ ] **Step 2:** FAIL → **Step 3: Реализовать** → **Step 4:** PASS (+ `providers.test.ts` для обработчиков) → **Step 5: Commit** `feat(host): sign-in service — status via the CLI, sign-in in a small PTY, sign-out`.

### Task 7: Хост и ядро — строки провайдеров агентам (5.8, К7)

**Files:**
- Create: `packages/host/src/agent/providers-endpoint.ts` (+ тест), `packages/core/src/mcp/provider-rows.ts` (+ тест).
- Modify: `packages/host/src/host.ts:341` (маршрут `AGENT_PROVIDERS_PATH`), `packages/core/src/mcp/tools.ts:589-606` (`getMap`), `packages/core/src/mcp/session-tools.ts:4-20` (описание `create_session`), `packages/core/src/index.ts`.
- Test: `providers-endpoint.test.ts`, `provider-rows.test.ts`, `packages/core/src/mcp/server.test.ts`.

**Interfaces:**
- Хост: `export const AGENT_PROVIDERS_PATH = '/agent/providers'`; `createProvidersEndpoint({ authenticate, list: () => Promise<ProviderRow[]> })` — `POST` с пустым телом (сервер хуков принимает на путях агента только `POST`), тот же `authenticate`, ответ `{ ok: true, result: { providers } }`; `list` — строки `providers.list` без `keyHint`/`check`/`custom`: `export interface ProviderRow { id; label; family: 'claude' | 'codex' | null; available; needs; models; effort; limits: ProviderLimits | null }`.
- Ядро: `export async function fetchProviderRows(agent: AgentChannel, signal: AbortSignal): Promise<ProviderRow[] | null>` (таймаут 5 с, `null` при любой ошибке); `getMap`: при `context.agent` — строки от хоста (`{id, label, family, available, models, effort, limits}`), иначе прежние строки + `note: 'host unreachable: sign-in state and limits unknown'`.
- `CREATE_SESSION_TOOL.description` += ` An account of the same CLI (for example custom-claude-2) is a separate subscription with its own limits — see providers[].limits in get_map.`

- [ ] **Step 1: Падающие тесты:** эндпоинт — 401 без токена, 200 со строками `list`; `fetchProviderRows` — `null` при закрытом порте; `server.test.ts` — `get_map` с `agent` отдаёт `limits` строк хоста, без `agent` — `note`.
- [ ] **Step 2:** FAIL → **Step 3: Реализовать; build core** → **Step 4:** PASS → **Step 5: Commit** `feat(host,core): agents read provider availability and limits from the host`.

### Task 8: Окно — плитки, форма аккаунта, вход, карточка, строка статуса (4.1–4.3, 5.9)

**Files:**
- Modify: `packages/desktop/src/renderer/components/providers/CustomProviderPanel.tsx` (шаг `vendor` `:104-134`, форма), `custom-provider-draft.ts`, `custom-presets.ts` (две плитки аккаунтов первыми: `{ id: 'claude-account', label: 'Another Claude Code account', billing: 'Your own subscription, signed in from Parley' }`, `codex-account` — плитка есть, но до этапа 3 помечена `comingSoon: true` и неактивна), `ProviderCard.tsx:170-200`, `shell/StatusBar.tsx:157-164`, `AgentIcon.tsx:38` (значок по `family` из стора; `custom-*` без `family` — Parley), `store/providers.ts` (`ProviderInfo.family`), `shared/strings.ts` (`S.accounts`), `settings/ProvidersSettings.tsx`.
- Create: `packages/desktop/src/renderer/components/providers/AccountPanel.tsx` (+ тест), `packages/desktop/src/renderer/components/providers/SignInTerminal.tsx` (xterm на `providers.signInOutput`/`signInExit`, ввод → `providers.signInInput`, размер → `providers.signInResize`).
- Test: `custom-provider-draft.test.ts`, `AccountPanel.test.tsx`, `ProviderCard.test.tsx`, `StatusBar.test.tsx`, `AgentIcon.test.tsx`.

**Interfaces:**
- `export function kindOf(custom: CustomProviderInfo | null | undefined): CustomProviderKind | null` — `kind ?? 'endpoint'` при наличии `custom`.
- `AccountPanel({ provider })`: при `custom.signingIn` терминал входа показан сразу (вход, начатый до закрытия Settings, — спека 10); поля `Name` (плейсхолдер — стандартное имя от хоста: `provider.label`), галочка `Bring from Claude Code` (по умолчанию включена), строка папки `Own Claude Code settings: <folder> — sign-in, history and memory separate from your regular Claude Code.`, состояние `Not signed in` / `Signed in`, кнопки `Save`, `Sign in` / `Cancel`, `Sign out`, `Delete` + `Also delete its folder`; подпись `Sign in with a different account than your regular Claude Code; the same account twice gives no extra limit.`
- `StatusBar`: сегмент при `kindOf(provider.custom)` — аккаунт → поповер с `ProviderCard` (как у основных); `endpoint` — как сейчас.
- `ProviderCard` для аккаунта: значок, имя, `Signed in`/`Not signed in`, лимиты (как у основных), кнопки `Sign in` (→ `openSettingsDialog('providers', { provider, signIn: true })`) и `Open in Settings`.
- Атрибуты для E2E: `[data-vendor-tile="claude-account"]`, `[data-account-form="<id>"]`, `[data-sign-in-terminal]`, `[data-account-state]`.

- [ ] **Step 1: Падающие тесты:** `kindOf(undefined)` null, `kindOf({ …без kind })` `'endpoint'`; `AccountPanel` рисует плейсхолдер имени и состояние; `Sign in` зовёт `providers.signIn` и показывает терминал; `StatusBar` — сегмент аккаунта открывает поповер; `AgentIcon` с `family: 'claude'` у `custom-claude-2` — значок Claude.
- [ ] **Step 2:** FAIL → **Step 3: Реализовать** → **Step 4:** тесты + `typecheck` → PASS → **Step 5: Commit** `feat(desktop): Claude account — vendor tile, form, sign-in terminal, card and status bar segment`.

### Task 9: Хост — свободные аккаунты в письме ведущему (5.8)

**Files:**
- Modify: `packages/host/src/stuck/stuck-service.ts` (этап 1, задача 5): `limitAlternatives` получает `signedIn: auth.status`; `packages/host/src/host.ts`.
- Test: `stuck-service.test.ts`.

- [ ] **Step 1: Падающий тест:** реестр `claude` + аккаунт `custom-claude-2` (вошёл, лимиты недели 31 %), сессия на `claude` упёрлась в лимит → письмо ведущему содержит `Other Claude Code accounts in Parley right now: Claude Code 2 (weekly 31 % used`.
- [ ] **Step 2:** FAIL → **Step 3: Реализовать** → **Step 4:** PASS → **Step 5: Commit** `feat(host): the lead letter lists signed-in accounts of the same CLI`.

### Task 10: E2E (спека 9)

**Files:**
- Modify: `packages/desktop/e2e/stub-custom-agent.mjs` — подкоманды `auth status --json` (читает `$CLAUDE_CONFIG_DIR/stub-auth.json`: `{ "loggedIn": true }` → печатает его, иначе `{"loggedIn":false,…}`), `auth login --claudeai` (печатает `Open https://stub.invalid/login in your browser`, ждёт строку на stdin или 1 с, пишет `stub-auth.json`, выходит 0), `auth logout` (удаляет файл).
- Create: `packages/desktop/e2e/claude-account.spec.ts`.

**Сценарии** (как `custom-providers.spec.ts`: настоящий хост, временный дом, окно 800×500, светлая и тёмная темы):
1. «+» → `Another Claude Code account` → `Save` без имени: пилюля `custom-claude-2` с именем `Claude Code 2`, сегмент приглушён, `[data-account-state]` = `Not signed in`; `custom-providers.json` без `baseUrl`; папка с `.claude.json` и ссылками на `<HOME>/.claude`.
2. `Sign in` → терминал показывает `Open https://stub.invalid/login`; после выхода заглушки состояние `Signed in`, сегмент не приглушён, `secrets.json` не появился.
3. New session на аккаунте: заглушка получает `CLAUDE_CONFIG_DIR=<папка>`, не получает `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`; соседняя сессия `claude` — без `CLAUDE_CONFIG_DIR`; `<HOME>/.claude` не изменился (дерево до/после).
4. Лимиты: файл `limits/<session>.json` от заглушки аккаунта → шкала у сегмента `custom-claude-2`, у `claude` — нет; `STUB_MCP get_map {}` из сессии `claude` отдаёт `providers[].limits` у `custom-claude-2`.
5. `Sign out` → `Not signed in`; `Delete` с `Also delete its folder` → папки нет.
6. 800×500: плитки и форма без горизонтальной прокрутки, обе темы.

- [ ] **Step 1:** заглушка и тест. **Step 2:** `pnpm --filter @parley/desktop build && pnpm --filter @parley/desktop exec playwright test e2e/claude-account.spec.ts` (DPR 1 и `--force-device-scale-factor=2`) → PASS. **Step 3: Commit** `test(desktop): e2e for Claude accounts`.

### Task 11: Документы, frame-scan, ревью, PR

**Files:** `README.md` (раздел про провайдеров: абзац «Another account of Claude Code»), `CHANGELOG.md` (`## Unreleased` → «Accounts»), `docs/specs/2026-10-21-subscriptions-design.md` (статус этапа 2), `packages/core/test/frame-scan.ts` (исключения, если появились).

- [ ] **Step 1:** правки; `pnpm --filter @parley/desktop exec vitest run src/release-docs.test.ts` и `pnpm --filter @parley/core exec vitest run test/frame-check.test.ts` → PASS.
- [ ] **Step 2: Commit** `docs: Claude accounts — README, CHANGELOG, spec status`.
- [ ] **Step 3:** ревью диффа этапа свежим рецензентом (Opus), `verification-before-completion`, push; PR «Second Claude Code account as a provider» открывает человек.
