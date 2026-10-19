# Свои провайдеры через Claude Code — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** любой пользователь Parley подключает своего провайдера (Kimi, MiniMax, Qwen, DeepSeek, OpenRouter, свой адрес) как сессию Claude Code с другим адресом, ключом и картой моделей, и обычный Claude Code при этом ничего не замечает.

**Architecture:** хост пишет описания своих провайдеров в `~/.parley/custom-providers.json` (без ключей), ядро превращает каждую запись в `ProviderEntry` семейства `claude` внутри `loadProviders` — по образцу встроенного GLM, но со своей `CLAUDE_CONFIG_DIR` в `~/.parley/providers/<id>/`. Ключ — в `secrets.json` под `custom:<id>`, в процесс — только финальным окружением (`providerLaunchEnv`). Окно получает раздел Settings → Providers и «+» в строке статуса.

**Tech Stack:** TypeScript, pnpm-монорепо (`@parley/core`, `@parley/host`, `@parley/protocol`, `@parley/desktop`), zod, vitest, React + Radix + zustand, Electron.

**Spec:** `docs/specs/2026-10-17-custom-providers-design.md` (читать целиком; разделы 5, 6 и 7 — обязательно). Карты кода, по которым писался план: `/private/tmp/claude-501/-Users-kalmbik61/fecfd229-ce17-4bd8-aea5-fd8ce5e3095a/scratchpad/map-{core,host,desktop}.md` (могут исчезнуть — тогда ориентир file:line ниже).

## Global Constraints

- Ветка `feat/custom-providers` от `master` 5dbe95b6 (v0.15.2; план писался по 2965a237 — номера строк ниже могут уехать, ориентир — имена). Коммиты **по-английски** (правило `AGENTS.md` перекрывает русские заголовки коммитов в задачах ниже — их смысл переводить), в стиле репо (`feat(core): …`), в конце `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Тесты — только затронутых файлов.** Полный `vitest run`/`pnpm -r test` запрещён (ноутбук греется, ложные таймауты). Одна папка/файл: `pnpm --filter @parley/<pkg> exec vitest run <path>`. Параллельных исполнителей — не больше двух; исполнители — Sonnet.
- Хост импортирует `@parley/core` и `@parley/protocol` из `dist/`: после правки ядра или протокола — `pnpm --filter @parley/core build` / `pnpm --filter @parley/protocol build` до тестов хоста. Сборка ядра/протокола и есть их проверка типов; окно — `pnpm --filter @parley/desktop typecheck`.
- Минимальная версия Claude Code для своих провайдеров: **`2.1.302`** (на ней проверена изоляция, спека 6.1). GLM остаётся на своей `2.1.287`.
- Префикс id своих провайдеров: **`custom-`**. В `providers.json` id с этим префиксом запрещены.
- Ничего из Parley не пишет в `~/.claude` (и в `$CLAUDE_CONFIG_DIR` хоста). Ключ — только в `secrets.json` (через `core/src/secrets.ts`) и в окружении процесса сессии.
- Поведение GLM, Claude и Codex не меняется: их существующие тесты проходят без правок ожиданий (кроме мест, где план прямо меняет строку исключения `frame-scan`).
- `core/test/frame-scan.ts`: любая новая строка, попавшая под правило (`.claude.json`, `ANTHROPIC_AUTH_TOKEN`, `secrets.json`, …), — явное исключение в `FRAME_EXCEPTIONS` с причиной «спека своих провайдеров N.M». Проверка: `pnpm --filter @parley/core exec vitest run test/frame-check.test.ts`.
- Тексты окна — по-английски, комментарии — по-русски со ссылкой на раздел спеки (как в соседнем коде).
- Литерал `ANTHROPIC_AUTH_TOKEN` встречается только в `host/src/sessions/provider-env.ts`; в записи, протоколе и окне способ передачи ключа — `auth: 'bearer' | 'api-key'`.

## Review Focus

1. **Первый запуск в пустой папке провайдера** показывает онбординг, вопрос доверия к папке или подтверждение ключа — сессия «висит» в Chat. Ожидание: сессия сразу работает. Пробa — задача 0; посев и тест — задача 3.
2. **Адрес с путём и косой чертой в конце** (`https://api.kimi.com/coding/`, `https://openrouter.ai/api`) — проверка ключа уходит не туда. Ожидание: `…/coding/v1/messages`, `…/api/v1/messages`. Тест — задача 8.
3. **Переименование провайдера** меняет id и отрывает сессии, ключ и папку. Ожидание: id неизменен при правке. Тест — задача 8.
4. **Удалённый провайдер, на которого ссылаются сессии в истории.** Ожидание: окно не падает, значок — Parley, имя — id; запуск отклоняется понятной ошибкой. Тесты — задачи 2 и 12.
5. **Источник ссылки исчез или сменился** (человек удалил навык в `~/.claude/skills`, сменил `CLAUDE_CONFIG_DIR`). Ожидание: висячая ссылка в `skills/` или `agents/` провайдера убирается перед следующим запуском; настоящие файлы и папки провайдера (копии, созданное в его сессиях) не трогаются. Тест — задача 3.

---

### Task 0: Проба Claude Code 2.1.302 в пустой папке (без кода продукта)

**Files:**
- Modify: `docs/specs/2026-10-17-custom-providers-design.md` (новый подраздел 6.2 «Проба первого запуска»)

- [ ] **Step 1: Запустить интерактивный `claude` в пустой папке настроек** — в scratchpad, не в репо:
  `D=$(mktemp -d); CLAUDE_CONFIG_DIR=$D ANTHROPIC_BASE_URL=https://example.invalid ANTHROPIC_AUTH_TOKEN=x CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1 claude` в любой временной папке-проекте; записать каждый экран до поля ввода (тема, вход, доверие к папке, прочее) и что Claude Code записал в `$D/.claude.json` после каждого ответа.
- [ ] **Step 2: Повторить с `ANTHROPIC_API_KEY=x` вместо `ANTHROPIC_AUTH_TOKEN`** — появляется ли вопрос «использовать этот ключ?» и какое поле `.claude.json` он пишет.
- [ ] **Step 3: Подобрать минимальный посев `.claude.json`**, при котором шаги 1–2 сразу дают поле ввода (кандидаты: `hasCompletedOnboarding`, `lastOnboardingVersion`, `theme`, `projects[<cwd>].hasTrustDialogAccepted`). Проверить, как запускает сейчас Parley обычного Claude (диалог доверия у него не появляется? почему?).
- [ ] **Step 4: Записать итог в спеку 6.2**: точный JSON посева, поля, которые зависят от cwd, и решение для доверия к папке. Правило для доверия, если оно нужно: перед запуском переносить `hasTrustDialogAccepted` для cwd сессии **только если** он уже `true` в `.claude.json` пользователя (чтение, без записи туда) и в папке провайдера нет живой сессии.
- [ ] **Step 5: Commit** `docs(specs): проба первого запуска Claude Code в папке своего провайдера`

---

### Task 1: Протокол — методы и поле `custom` в `providers.list`

**Files:**
- Create: `packages/protocol/src/custom-providers.ts`
- Modify: `packages/protocol/src/methods.ts` (spread в `METHODS` около :95, `Results extends …` около :310, элемент `providers.list` :328+), `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/custom-providers.test.ts`

**Interfaces:**
- Produces:
  - `CUSTOM_PROVIDER_PREFIX = 'custom-'`, `isCustomProviderId(id: string): boolean`
  - `type CustomProviderAuth = 'bearer' | 'api-key'`
  - `interface CustomProviderModels { opus: string; sonnet: string; haiku: string; subagent: string }`
  - `interface CustomProviderInfo { preset: string | null; baseUrl: string; auth: CustomProviderAuth; models: CustomProviderModels; contextWindow: number | null; linkClaude: boolean; folder: string }`
  - методы `'providers.saveCustom'` (params `{ id: string | null; label; preset: string | null; baseUrl; auth; models; contextWindow: number | null; linkClaude: boolean }` → `{ id: string }`) и `'providers.deleteCustom'` (`{ id: string; removeFolder: boolean }` → `{ ok: true }`)
  - элемент `providers.list`: необязательное `custom?: CustomProviderInfo | null`

- [ ] **Step 1: Тесты схем**

```ts
it('saveCustom: принимает запись и id null для нового', () => {
  expect(METHODS['providers.saveCustom'].safeParse(valid).success).toBe(true);
  expect(METHODS['providers.saveCustom'].safeParse({ ...valid, id: null }).success).toBe(true);
});
it('saveCustom: отвергает пустой слот, пробел в модели, имя длиннее 40, неизвестный auth', () => {
  for (const bad of [
    { ...valid, models: { ...valid.models, haiku: '' } },
    { ...valid, models: { ...valid.models, opus: 'kimi k3' } },
    { ...valid, label: 'x'.repeat(41) },
    { ...valid, auth: 'basic' },
  ]) expect(METHODS['providers.saveCustom'].safeParse(bad).success).toBe(false);
});
it('isCustomProviderId', () => {
  expect(isCustomProviderId('custom-kimi')).toBe(true);
  expect(isCustomProviderId('glm')).toBe(false);
});
```
`valid` = `{ id: 'custom-kimi', label: 'Kimi', preset: 'kimi', baseUrl: 'https://api.moonshot.ai/anthropic', auth: 'bearer', models: { opus: 'kimi-k3[1m]', sonnet: 'kimi-k3[1m]', haiku: 'kimi-k2.7-code', subagent: 'kimi-k3[1m]' }, contextWindow: 1000000, linkClaude: true }`.

- [ ] **Step 2:** `pnpm --filter @parley/protocol exec vitest run src/custom-providers.test.ts` → FAIL (нет модуля).
- [ ] **Step 3: Реализовать** схемы zod: `label` — trim, 1–40; `baseUrl` — 1–500 (смысловая проверка адреса — в ядре); модель — тот же регэксп, что у `sessions.create.model`, но непустая, ≤200; `preset` — `/^[a-z0-9-]{1,40}$/` или null; `contextWindow` — целое > 0 или null. Подключить по образцу `assistantMethodSchemas`/`AssistantMethodResults`.
- [ ] **Step 4:** тот же запуск + `src/methods.test.ts` → PASS; `pnpm --filter @parley/protocol build` → без ошибок.
- [ ] **Step 5: Commit** `feat(protocol): методы своих провайдеров и поле custom в providers.list`

---

### Task 2: Ядро — запись своего провайдера и реестр

**Files:**
- Create: `packages/core/src/custom-providers.ts`
- Modify: `packages/core/src/providers.ts` (`RunnerConfig` :31, `ProviderEntry` :85, `isClaudeCode` :414, `claudeConfigDirFor` :427, `providerCompatibilityError` :723, `providerReadiness` :749, `providerReadinessError` :773, `applyOverride`/`checkShape` :1018–1066, `loadProviders` :1118), `packages/core/src/secrets.ts:8`, `packages/core/src/index.ts`
- Test: `packages/core/src/custom-providers.test.ts`, `packages/core/src/providers.test.ts`, `packages/core/src/provider-readiness.test.ts`

**Interfaces:**
- Consumes: ничего из задачи 1 (ядро не зависит от протокола; префикс дублируется, равенство проверяет задача 9).
- Produces (`custom-providers.ts`):
  - `CUSTOM_PROVIDER_PREFIX = 'custom-'`, `CUSTOM_MIN_VERSION = '2.1.302'`, `isCustomProviderId(id: string): boolean`
  - `interface CustomProviderRecord { id: string; label: string; preset: string | null; baseUrl: string; auth: 'bearer' | 'api-key'; models: { opus: string; sonnet: string; haiku: string; subagent: string }; contextWindow: number | null; linkClaude: boolean }`
  - `customProvidersFile(home = parleyHome()): string` → `<home>/custom-providers.json`; формат файла `{ "version": 1, "providers": CustomProviderRecord[] }`
  - `customProviderDir(id: string, home = parleyHome()): string` → `<home>/providers/<id>`
  - `customProviderSecret(id: string): SecretId` → `` `custom:${id}` ``
  - `slugProviderId(label: string, taken: ReadonlySet<string>): string` — `custom-` + латинский slug (≤24 символа, `[a-z0-9-]`, пусто → `provider`), занято → `-2`, `-3`, …
  - `baseUrlError(url: string): string | null` — `https:` или `http:` только для loopback (`localhost`, `127.0.0.1`, `[::1]`); без логина/пароля, `?` и `#`
  - `isLoopbackUrl(url: string): boolean`
  - `readCustomProviders(file = customProvidersFile()): Promise<CustomProviderRecord[]>` — нет файла или битый JSON → `[]`; неверная запись пропускается
  - `writeCustomProviders(records: readonly CustomProviderRecord[], file = customProvidersFile()): Promise<void>` — атомарно (tmp с uuid + `rename`, как `writeStore` в `secrets.ts`)
  - `customProviderEntry(record: CustomProviderRecord, home = parleyHome()): ProviderEntry`
- Produces (`providers.ts`): `RunnerConfig` += `configDir?: string; auth?: 'bearer' | 'api-key'; keyOptional?: true`; `ProviderEntry` += `custom?: CustomProviderRecord`; `loadProviders(file, codexFile, customFile = customProvidersFile())`; `SecretId = 'zai' | \`custom:${string}\``.

- [ ] **Step 1: Тесты записи и реестра**

```ts
it('customProviderEntry строится по раннеру GLM, со своей папкой и картой слотов', () => {
  const entry = customProviderEntry(kimi, home);
  expect(entry.family).toBe('claude');
  expect(entry.runner.args).toEqual(PROVIDERS.glm.runner.args);
  expect(entry.runner.configDir).toBe(path.join(home, 'providers', 'custom-kimi'));
  expect(entry.runner.secret).toBe('custom:custom-kimi');
  expect(entry.runner.minVersion).toBe('2.1.302');
  expect(entry.runner.settingsModel).toBe('kimi-k3[1m]');
  expect(entry.runner.env).toMatchObject({
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k3[1m]', ANTHROPIC_DEFAULT_FABLE_MODEL: 'kimi-k3[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k3[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.7-code',
    CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k3[1m]', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
  });
  expect(Object.keys(entry.runner.env!).some((name) => /KEY|TOKEN/.test(name))).toBe(false);
  expect(entry.models?.map((m) => m.id)).toEqual(['kimi-k3[1m]', 'kimi-k2.7-code']); // без повторов, sonnet первым
});
it('loadProviders добавляет свои записи; встроенные и providers.json побеждают при совпадении id', …);
it('loadProviders: id с префиксом custom- в providers.json — ошибка', …);
it('loadProviders без файла своих провайдеров — реестр побайтно прежний', async () => {
  expect(await loadProviders(pj, cx, missing)).toEqual(await loadProviders(pj, cx, emptyFile));
});
it('isClaudeCode по строке узнаёт custom-*', () => expect(isClaudeCode('custom-kimi')).toBe(true));
it('claudeConfigDirFor: своя папка у custom, undefined у GLM, env у claude', …);
it('baseUrlError: http на удалённый адрес, логин в URL, ? и # — ошибка; http://localhost:4000 — можно', …);
it('slugProviderId: «Corp LLM» → custom-corp-llm; занято → custom-corp-llm-2; «Кими» → custom-provider', …);
it('readiness: нет ключа → needs key; у loopback-адреса ключ не нужен (keyOptional)', …);
it('readiness: claude 2.1.301 → needs cli; текст ошибки называет имя провайдера, а не GLM', …);
it('Review Focus 4: удалённая запись — registry[id] отсутствует, isClaudeCode(id) всё ещё true', …);
```

- [ ] **Step 2:** `pnpm --filter @parley/core exec vitest run src/custom-providers.test.ts src/providers.test.ts src/provider-readiness.test.ts` → новые FAIL.
- [ ] **Step 3: Реализовать `custom-providers.ts`.** `customProviderEntry`: `mark` = первые 2 символа `label`; `hasHistory: true`; `linkBy: 'session-id'`; `models` — уникальные из `[sonnet, opus, haiku]` с `label = id` и `efforts: CLAUDE_EFFORTS`; раннер — копия полей `args/resumeArgs/printArgs/assistantArgs/assistantResumeArgs/mcpConfig` из `PROVIDERS.glm.runner` + `command: 'claude'`; `env` — ровно ключи из теста плюс `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'`, `API_TIMEOUT_MS: '3000000'`; `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — только при `contextWindow !== null`; `keyOptional: true` при loopback-адресе; `custom: record`.
- [ ] **Step 4: Встроить в `providers.ts`.** `isClaudeCode(string)` = прежнее `|| isCustomProviderId(entry)`; `claudeConfigDirFor` = `entry.runner.configDir ?? (прежнее)`; `providerCompatibilityError` и проверка ключа в `providerReadiness` — для любого `runner.secret` (у `keyOptional` ключ не обязателен); `providerReadinessError` — для `entry.custom` тексты `` `${label} requires Claude Code ${minVersion}` `` и `` `${label} requires a saved key in Settings → Providers` ``, у GLM — прежние; `applyOverride` для нового id с префиксом — `throw new Error(\`provider ${id} in ${file}: the custom- prefix is reserved\`)`; `loadProviders` — после `providers.json`: каждая запись, чей id ещё не занят (`Object.hasOwn`), → `customProviderEntry`.
- [ ] **Step 5:** тесты шага 2 + `src/secrets.test.ts` → PASS; `pnpm --filter @parley/core build` → без ошибок.
- [ ] **Step 6: Commit** `feat(core): запись своего провайдера и её место в реестре`

---

### Task 3: Ядро — папка провайдера: посев и ссылки

**Files:**
- Create: `packages/core/src/custom-provider-dir.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/test/frame-scan.ts` (исключение для строки с `.claude.json`)
- Test: `packages/core/src/custom-provider-dir.test.ts`

**Interfaces:**
- Consumes: `CustomProviderRecord`, `customProviderDir`, `isCustomProviderId` (задача 2).
- Produces:
  - `LINKED_CLAUDE_ITEMS = ['CLAUDE.md', 'skills', 'agents'] as const`
  - `userClaudeConfigDir(env = process.env, home = homedir()): string` — `CLAUDE_CONFIG_DIR` (trim, непустой) или `~/.claude`
  - `prepareCustomProviderDir(record: CustomProviderRecord, options: { claudeConfigDir: string; home?: string }): Promise<void>`
  - `removeCustomProviderDir(id: string, home = parleyHome()): Promise<void>`

- [ ] **Step 1: Тесты (временные дома, без реального `~`)**

```ts
it('создаёт папку 0700 и projects/, сеет .claude.json из пробы 6.2 и не перезаписывает существующий', …);
it('linkClaude: CLAUDE.md — ссылка; skills/ и agents/ — настоящие папки со ссылкой на каждую запись оригинала (спека 5.4, К14)', async () => {
  expect((await fs.lstat(path.join(dir, 'skills'))).isDirectory()).toBe(true);
  expect((await fs.lstat(path.join(dir, 'skills'))).isSymbolicLink()).toBe(false);
  expect(await fs.readlink(path.join(dir, 'skills', 'x'))).toBe(path.join(claudeDir, 'skills', 'x'));
  expect(await fs.readlink(path.join(dir, 'agents', 'a.md'))).toBe(path.join(claudeDir, 'agents', 'a.md'));
  expect(await fs.readlink(path.join(dir, 'CLAUDE.md'))).toBe(path.join(claudeDir, 'CLAUDE.md'));
});
it('записи с точкой (.trash, .DS_Store) не связываются; отсутствующий источник — без ссылки', …);
it('повторный prepare: новый навык оригинала получает ссылку; копия (настоящая папка skills/x) и навык, созданный у провайдера, не тронуты, ссылка поверх копии не ставится', …);
it('linkClaude выключен — ссылки убраны, копии и настоящий CLAUDE.md в папке провайдера не тронуты', …);
it('Review Focus 5: навык оригинала удалён — висячая ссылка убрана; источник сменился — ссылки переставлены', …);
it('содержимое claudeDir (пути + sha256) до и после prepare и remove — одинаковое', …);
it('removeCustomProviderDir: удаляет папку, ссылки удаляются как ссылки (источники целы)', …);
it('removeCustomProviderDir: id без префикса или с ../ — отказ, ничего не удалено', …);
```

- [ ] **Step 2:** `pnpm --filter @parley/core exec vitest run src/custom-provider-dir.test.ts` → FAIL.
- [ ] **Step 3: Реализовать.** Посев — ровно JSON из спеки 6.2 (задача 0), запись только если файла нет (`open` с `'wx'`). Ссылки — поштучно (спека 5.4): `CLAUDE.md` — ссылка на файл; `skills/` и `agents/` создаются настоящими папками, в них ссылка `<имя>` → `<claudeConfigDir>/<папка>/<имя>` на каждую запись оригинала без точки в начале. Всё через `lstat`: трогать только символические ссылки, настоящие файлы и папки — никогда; занятое настоящей записью имя пропускается. Если на месте `skills` или `agents` стоит ссылка или файл — не трогать и не связывать (записать в журнал). `removeCustomProviderDir` проверяет, что `path.dirname(resolved) === <home>/providers` и `isCustomProviderId(id)`, затем `fs.rm(dir, { recursive: true, force: true })` (`rm` не ходит по ссылкам — тест это фиксирует). Если задача 0 решила переносить доверие к папке — функция `mirrorProjectTrust(record, cwd, options)` здесь же, по правилу из 6.2, со своим тестом.
- [ ] **Step 4:** тест шага 2 + `test/frame-check.test.ts` → PASS (новое исключение: правило `запись в каталоги агентов`, причина «спека своих провайдеров 5.4: посев .claude.json только в папке провайдера в доме Parley»); `pnpm --filter @parley/core build`.
- [ ] **Step 5: Commit** `feat(core): папка своего провайдера — посев и ссылки на настройки Claude Code`

---

### Task 3a: Ядро — предостережение агенту о ссылках (спека 5.8)

**Files:**
- Modify: `packages/core/src/work/guidance.ts` (рядом с `BROWSER_PRIORITY_RULE`), `packages/core/src/work/session-layer.ts` (вход `links?: string`, `LayerBlockBytes` += `'links'`, блок сразу после `bridge`), `packages/core/src/work/launch.ts` (около `bridge`, :424), `packages/core/src/index.ts`
- Test: `packages/core/src/work/guidance.test.ts`, `packages/core/src/work/session-layer.test.ts`, `packages/core/src/work/launch.test.ts`

**Interfaces:**
- Consumes: `entry.custom` (задача 2), `customProviderDir`, `userClaudeConfigDir` (задачи 2–3).
- Produces: `linkedSettingsRule(dir: string, source: string): string` — ровно текст спеки 5.8 с подстановкой `{dir}` и `{source}`, одной строкой (переносы цитаты — пробелы).

- [ ] **Step 1: Тесты**

```ts
it('linkedSettingsRule: текст спеки 5.8 с папкой провайдера и источником, одна строка', () => {
  const rule = linkedSettingsRule('/h/.parley/providers/custom-kimi', '/h/.claude');
  expect(rule).toContain('settings folder is /h/.parley/providers/custom-kimi, not ~/.claude');
  expect(rule).toContain('main Claude Code settings (/h/.claude)');
  expect(rule).toContain('rm without -r and without a trailing slash');
  expect(rule).not.toContain('\n');
});
it('слой: блок links идёт после bridge и считается в blockBytes.links', …);
it('запуск custom-сессии с linkClaude: в --append-system-prompt правило со своей папкой; то же при resume', …);
it('custom без linkClaude, claude, GLM, codex — правила нет, текст слоя побайтно прежний', …);
```

- [ ] **Step 2:** `pnpm --filter @parley/core exec vitest run src/work/guidance.test.ts src/work/session-layer.test.ts src/work/launch.test.ts` → новые FAIL.
- [ ] **Step 3: Реализовать.** В `launch.ts` — `links: entry.custom?.linkClaude === true ? linkedSettingsRule(entry.runner.configDir!, userClaudeConfigDir()) : ''`, рядом с `bridge`; комментарий — ссылка на спеку 5.8 и на то, что Write/Edit Claude Code сам отправляет агента по настоящему пути ссылки.
- [ ] **Step 4:** тесты шага 2 → PASS; `pnpm --filter @parley/core build`.
- [ ] **Step 5: Commit** `feat(core): правило агенту своего провайдера — подтянутое общее, сначала копия`

---

### Task 4: Ядро — история из папки провайдера

**Files:**
- Modify: `packages/core/src/discover.ts:33-50`, `packages/core/src/work/metrics.ts:49-50`, `packages/core/src/work/summary.ts:100-101`, `packages/core/src/mcp/tools.ts:1599-1623`, `packages/core/src/index.ts`
- Test: `packages/core/src/discover.test.ts`, `packages/core/src/work/launch.test.ts` (возобновление), `packages/core/src/mcp/find-skill.test.ts`

**Interfaces:**
- Consumes: `customProviderDir`, `isCustomProviderId`, `CUSTOM_PROVIDER_PREFIX` (задача 2).
- Produces:
  - `customProviderProjectRoots(home = parleyHome()): string[]` — синхронно: подпапки `<home>/providers/` с префиксом → `<папка>/projects`; нет каталога → `[]`
  - `claudeProjectRoots(env, home)` — при отсутствии подмены `PARLEY_CLAUDE_PROJECTS_DIR` дополнительно возвращает корни своих провайдеров (`parleyHome(env, home)`)
  - `claudeRootFor(provider: WorkProvider): string` — `custom-*` → `<customProviderDir>/projects`, иначе `defaultRoot()`

- [ ] **Step 1: Тесты**

```ts
it('claudeProjectRoots: ~/.claude/projects и корни custom-* в доме Parley; подмена — только она', …);
it('claudeRootFor: custom-kimi → <home>/providers/custom-kimi/projects; claude → defaultRoot()', …);
it('возобновление: транскрипт <uuid>.jsonl в папке провайдера → resume, а не новый запуск', …);
it('find_skill в сессии custom-*: каталог из папки провайдера (ссылки skills видны), без падения на поиске записи', …);
```

- [ ] **Step 2:** `pnpm --filter @parley/core exec vitest run src/discover.test.ts src/work/launch.test.ts src/mcp/find-skill.test.ts` → новые FAIL.
- [ ] **Step 3: Реализовать.** `metrics.ts` и `summary.ts` — `claudeRootFor(provider)` вместо `defaultRoot()`. `mcp/tools.ts:1614` — запись из `(await loadProviders())[session.provider]` вместо `Object.values(PROVIDERS).find(...)!`; записи нет → тот же отказ, что у неизвестного провайдера (не исключение).
- [ ] **Step 4:** тесты шага 2 → PASS; `pnpm --filter @parley/core build`.
- [ ] **Step 5: Commit** `feat(core): история, возобновление и find_skill своих провайдеров — из их папки`

---

### Task 5: Хост — окружение запуска

**Files:**
- Modify: `packages/host/src/sessions/provider-env.ts`, `packages/host/src/sessions/sessions-service.ts:613-626`, `packages/core/src/work/launch.ts:382` (настройки хуков), `packages/core/test/frame-scan.ts` (строка исключения `ключ GLM вне окружения процесса` меняется)
- Test: `packages/host/src/sessions/provider-launch.test.ts`, `packages/core/src/work/launch.test.ts`

**Interfaces:**
- Consumes: `RunnerConfig.configDir/auth/keyOptional`, `entry.custom` (задача 2); `prepareCustomProviderDir`, `userClaudeConfigDir` (задача 3).
- Produces: `providerLaunchEnv(entry, inherited, planEnv, key)` — та же сигнатура.

- [ ] **Step 1: Тесты**

```ts
it('custom: чистит ANTHROPIC_*, CLAUDE_SECURESTORAGE_CONFIG_DIR и CLAUDE_CONFIG_DIR хоста, ставит свою папку', () => {
  const env = providerLaunchEnv(kimiEntry, { ANTHROPIC_BASE_URL: 'x', ANTHROPIC_API_KEY: 'host', CLAUDE_CONFIG_DIR: '/u/.claude', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/u/.claude' }, {}, 'sk-1');
  expect(env.CLAUDE_CONFIG_DIR).toBe(kimiEntry.runner.configDir);
  expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
  expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-1');
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
});
it("auth 'api-key' — ключ в ANTHROPIC_API_KEY, AUTH_TOKEN нет", …);
it('loopback без ключа — плейсхолдер parley-local в переменной auth, вход не спрашивается', …);
it('обычный claude: окружение с сохранёнными своими провайдерами и без них совпадает', …);
it('GLM: окружение побайтно как до правки', …);
it('настройки хуков custom-сессии — с PARLEY_HOOK_CAPABILITY, как у GLM', …);
```

- [ ] **Step 2:** `pnpm --filter @parley/core build && pnpm --filter @parley/host exec vitest run src/sessions/provider-launch.test.ts` → FAIL.
- [ ] **Step 3: Реализовать.** В `providerLaunchEnv`: условие очистки — `entry.runner.secret !== undefined`; после `Object.assign(env, entry.runner.env)` — `if (entry.runner.configDir !== undefined) env.CLAUDE_CONFIG_DIR = entry.runner.configDir`; имя переменной ключа — `entry.runner.auth === 'api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'`; ключа нет и `keyOptional` → значение `'parley-local'`. В `sessions-service.ts`: ключа нет и у записи нет `keyOptional` → отказ через `providerReadinessError` (без зашитого «GLM…», у GLM текст тот же); при `keyOptional` — запуск с плейсхолдером; имя переменной токена хуков — по `entry.runner.secret !== undefined`, перед `pty.start` для `entry.custom` — `await prepareCustomProviderDir(entry.custom, { claudeConfigDir: userClaudeConfigDir() })` (и перенос доверия, если он есть по задаче 0). В `launch.ts:382` — `entry.id === 'glm' ? { provider: 'glm' } : entry.custom !== undefined ? { hookTokenEnv: 'PARLEY_HOOK_CAPABILITY' } : {}`.
- [ ] **Step 4:** тесты шага 2 + `src/sessions/sessions-service.test.ts` + core `src/work/launch.test.ts` + `test/frame-check.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(host): окружение запуска своего провайдера — своя папка, ключ только в процессе`

---

### Task 6: Хост — индекс логов из нескольких корней Claude

**Files:**
- Modify: `packages/host/src/activity/log-index.ts:88-230`, `packages/host/src/activity/activity-service.ts` (проброс), `packages/host/src/sessions/sessions-service.ts` (вызов перед запуском)
- Test: `packages/host/src/activity/log-index.test.ts`

**Interfaces:**
- Consumes: `customProviderProjectRoots` (задача 4).
- Produces: `createLogIndex(roots: MetricsRoots & { customRoots?: () => string[] })`; у индекса и `ActivityService` — `watchClaudeRoot(root: string): void` (идемпотентно).

- [ ] **Step 1: Тесты**

```ts
it('транскрипт в корне своего провайдера, лежавший до старта, попадает в индекс; index(session) находит его по uuid', …);
it('watchClaudeRoot: новый корень после старта — живые записи индексируются; повторный вызов не плодит наблюдателей', …);
it('usageIn для custom-сессии считает подагентов от своего корня, не от ~/.claude/projects', …);
it('остановка индекса закрывает и наблюдателей добавленных корней', …);
```

- [ ] **Step 2:** `pnpm --filter @parley/core build && pnpm --filter @parley/host exec vitest run src/activity/log-index.test.ts` → FAIL.
- [ ] **Step 3: Реализовать.** Начальный список — `buildAllSessions` по `claudeRoot` и каждому корню `customRoots()` (по умолчанию `customProviderProjectRoots()`), слитый; наблюдатели — по одному `claudeSource(root)` на корень, список закрывается на `stop`; в `usageIn` корень — тот из известных, внутри которого лежит `found.file`. `sessions-service` перед `pty.start` custom-сессии создаёт `<configDir>/projects` и зовёт `watchClaudeRoot`.
- [ ] **Step 4:** тесты шага 2 + `src/activity/activity-service.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(host): индекс логов видит транскрипты своих провайдеров`

---

### Task 7: Хост — проверка адреса тестовым сообщением

**Files:**
- Create: `packages/host/src/providers/custom-check.ts`
- Modify: `packages/host/src/limits/zai-check.ts` (экспорт `reasonOfStatus`, без иных правок)
- Test: `packages/host/src/providers/custom-check.test.ts`

**Interfaces:**
- Consumes: `ProviderEntry.custom`, `isLoopbackUrl` (задача 2); `ProviderCheck` (протокол).
- Produces:
  - `messagesUrl(baseUrl: string): string`
  - `checkAnthropicEndpoint(target: { baseUrl: string; auth: 'bearer' | 'api-key'; model: string }, key: string | null, options?: { fetch?: typeof fetch; timeoutMs?: number }): Promise<Omit<ProviderCheck, 'at'>>` — не бросает
  - `createCustomCheckService(host: { broadcast(...) }): CustomCheckService` с `current(id: string, key: string | null): ProviderCheck | null`, `run(entry: ProviderEntry, key: string | null): Promise<ProviderCheck>`, `forget(id: string): void` — в памяти, по id + sha256-отпечатку ключа; `providers.changed { provider: id }` только при смене исхода

- [ ] **Step 1: Тесты**

```ts
it('Review Focus 2: messagesUrl', () => {
  expect(messagesUrl('https://api.kimi.com/coding/')).toBe('https://api.kimi.com/coding/v1/messages');
  expect(messagesUrl('https://openrouter.ai/api')).toBe('https://openrouter.ai/api/v1/messages');
  expect(messagesUrl('https://api.deepseek.com/anthropic')).toBe('https://api.deepseek.com/anthropic/v1/messages');
});
it('bearer → Authorization: Bearer; api-key → x-api-key; без ключа (loopback) — без заголовка', …);
it('тело: модель слота Sonnet, max_tokens 1; redirect: error', …);
it('200 и type message → ok; 401 → authentication; 429 → rate_limited; 5xx → server_error; таймаут → timeout; сеть → network', …);
it('ключ не попадает ни в исход, ни в текст ошибки', …);
it('сервис: повторный run с тем же ключом во время первого — один запрос; forget сбрасывает current', …);
```

- [ ] **Step 2:** `pnpm --filter @parley/host exec vitest run src/providers/custom-check.test.ts` → FAIL.
- [ ] **Step 3: Реализовать** по образцу `zai-check.ts` (заголовки `anthropic-version: 2023-06-01`, `content-type`, `accept`; таймаут 20 с; предел тела 256 КБ).
- [ ] **Step 4:** тест шага 2 + `src/limits/zai-check.test.ts` + core `test/frame-check.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(host): проверка своего провайдера тестовым сообщением`

---

### Task 8: Хост — методы сохранения, удаления, ключа и списка

**Files:**
- Create: `packages/host/src/methods/custom-providers.ts`
- Modify: `packages/host/src/methods/providers.ts` (`createProvidersList` :43, `providerSecret` :88, `createProvidersSetKey` :98, `createProvidersClearKey` :119, `createProvidersCheck` :143), `packages/host/src/methods/index.ts:84-92,206-210`, `packages/host/src/host.ts` (создание `createCustomCheckService`)
- Test: `packages/host/src/methods/custom-providers.test.ts`, `packages/host/src/methods/providers-key.test.ts`, `packages/host/src/methods/providers.test.ts`

**Interfaces:**
- Consumes: задачи 1, 2, 3, 7.
- Produces: обработчики `providers.saveCustom`, `providers.deleteCustom`; `providers.setKey/clearKey/check` работают для любого провайдера с `runner.secret`; элемент `providers.list` с `custom: CustomProviderInfo` (`folder` = `runner.configDir`) у своих и `custom: null`/нет у прочих.

- [ ] **Step 1: Тесты (настоящий хост по сокету, `tempHome()` + `startHost({ home })`, заглушка `claude` 2.1.302 как в `providers-key.test.ts`)**

```ts
it('saveCustom без id создаёт custom-kimi, папку и запись; providers.list показывает его с needs key', …);
it('Review Focus 3: saveCustom с id и новым label — id, папка и ключ прежние', …);
it('saveCustom: http на удалённый адрес → bad_request; неизвестный id → bad_request', …);
it('setKey/clearKey для custom-kimi пишут secrets.json под custom:custom-kimi; keyHint в списке — маска', …);
it('check для custom-kimi идёт через custom-check (заглушка fetch), для glm — прежним путём', …);
it('deleteCustom: запись и ключ удалены, папка остаётся; removeFolder: true — папки нет', …);
it('каждое изменение рассылает providers.changed { provider: id }', …);
it('в custom-providers.json нет ключа ни в каком виде', …);
```

- [ ] **Step 2:** `pnpm --filter @parley/core build && pnpm --filter @parley/protocol build && pnpm --filter @parley/host exec vitest run src/methods/custom-providers.test.ts src/methods/providers-key.test.ts src/methods/providers.test.ts` → FAIL.
- [ ] **Step 3: Реализовать.** `saveCustom`: `baseUrlError` → `bad_request`; `id === null` → `slugProviderId(label, ключи loadProviders() ∪ id записей)`, иначе id обязан быть среди записей; запись → `writeCustomProviders` → `prepareCustomProviderDir(record, { claudeConfigDir: userClaudeConfigDir() })` → `customCheck.forget(id)` → broadcast. `deleteCustom`: убрать запись, `clearSecret(customProviderSecret(id))`, при `removeFolder` — `removeCustomProviderDir(id)`, forget, broadcast. В `providers.ts`: `providerSecret` пускает любой `runner.secret`; для `entry.custom` — `customCheck` вместо `glmCheck`/`limits.invalidateGlm`; `check` в списке — `customCheck.current(id, key)`. Методы регистрируются всегда (как `setKey`).
- [ ] **Step 4:** тесты шага 2 + `src/limits/glm-check.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(host): сохранение, удаление и ключи своих провайдеров`

---

### Task 9: Гарантия «Claude Code не задет» (спека, раздел 6)

**Files:**
- Create: `packages/host/src/methods/custom-providers.isolation.test.ts`

**Interfaces:**
- Consumes: всё из задач 2–8. Кода продукта задача не меняет; если тест красный — чинить в задаче-владельце.

- [ ] **Step 1: Тесты (песочница `HOME` хоста; в ней `~/.claude` с `CLAUDE.md`, `skills/x/SKILL.md`, `agents/a.md`, `settings.json`, `.claude.json` рядом в `~`)**

```ts
it('saveCustom (linkClaude) → setKey → check → запуск заглушки claude → deleteCustom(removeFolder): дерево ~/.claude и ~/.claude.json (пути + sha256) побайтно прежние', …);
it('копия по шагам правила 5.8 (cp оригинала во временное имя, rm ссылки без -r, mv) и правка копии; новый skills/new/SKILL.md в папке провайдера; следующий prepare — дерево ~/.claude побайтно прежнее, копия на месте', …);
it('реестр: registry.claude и registry.glm с двумя своими провайдерами и без них — deepEqual', …);
it('ключ custom-провайдера не встречается в логе хоста, в argv запущенной заглушки, в custom-providers.json, в ответе providers.list', …);
it('окружение заглушки custom-сессии: CLAUDE_CONFIG_DIR = папка провайдера, CLAUDE_SECURESTORAGE_CONFIG_DIR нет', …);
it('префикс custom- одинаков в @parley/core и @parley/protocol', () => {
  expect(core.CUSTOM_PROVIDER_PREFIX).toBe(protocol.CUSTOM_PROVIDER_PREFIX);
});
```
Заглушка `claude` печатает своё окружение и argv в файл — по образцу заглушек в `host/test/`.

- [ ] **Step 2:** `pnpm --filter @parley/host exec vitest run src/methods/custom-providers.isolation.test.ts` → PASS (если FAIL — исправление в задаче-владельце, повторить).
- [ ] **Step 3: Commit** `test(host): своя сессия не трогает ~/.claude, обычный Claude и ключ`

---

### Task 10: Окно — раздел Providers, «+» и сегменты в строке статуса

**Files:**
- Modify: `packages/desktop/src/renderer/store/ui.ts:26,91,161,226,291`, `packages/desktop/src/renderer/components/settings/SettingsDialog.tsx:52-62,~499`, `packages/desktop/src/renderer/shell/StatusBar.tsx:117-250`, `packages/desktop/src/shared/strings.ts` (`settings.sections` :915, `statusBar`, новая группа `customProviders`)
- Create: `packages/desktop/src/renderer/components/settings/ProvidersSettings.tsx` (каркас: пилюли + место под форму; форма — задача 11)
- Test: `packages/desktop/src/renderer/shell/StatusBar.test.tsx`, `packages/desktop/src/renderer/components/settings/SettingsDialog.test.tsx`, `packages/desktop/src/renderer/store/ui.test.ts`

**Interfaces:**
- Consumes: элемент `providers.list` с `custom` (задача 1).
- Produces:
  - `SettingsSection` += `'providers'`; `openSettingsDialog(section?: SettingsSection, options?: { provider?: string | 'new' }): void`; состояние `settingsProvider: string | 'new' | null`
  - `ProvidersSettings(): JSX.Element` — пилюли: Claude Code, Codex, GLM, свои, «+ Add provider»; выбранная встроенная — `<ProviderCard provider onReload={reload} />` без изменений; своя или `'new'` — место для `CustomProviderPanel` (задача 11)
  - строки: `S.settings.sections.providers = 'Providers'`, `S.statusBar.addProvider = 'Add provider'`

- [ ] **Step 1: Тесты**

```ts
it('Settings: пункт Providers стоит после Agents', () => {
  expect(tabs.map((t) => t.textContent)).toEqual(['Appearance', 'Terminal', 'Agents', 'Providers', 'Notifications', 'Browser', 'Voice', 'Assistant']);
});
it('«+» в конце строки статуса открывает Settings на Providers с выбором вендора', () => {
  fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
  expect(useUiStore.getState()).toMatchObject({ settingsSection: 'providers', settingsProvider: 'new' });
});
it('свой провайдер без ключа виден в строке статуса приглушённым; клик открывает Settings на нём', …);
it('прочие провайдеры из providers.json по-прежнему видны только найденными', …);
it('openSettingsDialog() без аргументов — appearance и settingsProvider null (App.tsx, палитра)', …);
```

- [ ] **Step 2:** `pnpm --filter @parley/desktop exec vitest run src/renderer/shell/StatusBar.test.tsx src/renderer/components/settings/SettingsDialog.test.tsx src/renderer/store/ui.test.ts` → FAIL.
- [ ] **Step 3: Реализовать.** Пилюли — классы `PILL` из `NewSessionOrRoomDialog.tsx:206` (вынести константу в общий модуль `components/providers/pill.ts`, импортировать в обоих местах); данные — `useProvidersStore`. В строке статуса свои провайдеры (`custom != null`) показываются всегда, сегмент вместо поповера зовёт `openSettingsDialog('providers', { provider: id })`; «+» — кнопка-иконка `Plus` после сегментов, классы как у кнопки обновления лимитов.
- [ ] **Step 4:** тесты шага 2 → PASS; `pnpm --filter @parley/desktop typecheck`.
- [ ] **Step 5: Commit** `feat(desktop): раздел Providers в Settings и «+» в строке статуса`

---

### Task 11: Окно — выбор вендора и форма своего провайдера

**Files:**
- Create: `packages/desktop/src/renderer/components/providers/custom-presets.ts`, `custom-provider-draft.ts`, `CustomProviderPanel.tsx` (шаг 1 — плитки, шаг 2 — форма); `packages/desktop/src/renderer/components/providers/check-line.tsx` (вынесенные из `ProviderCard.tsx` `CheckLine`, `maskedHint`, `clock`, `newerCheck` — `ProviderCard` импортирует их оттуда, поведение то же)
- Modify: `ProvidersSettings.tsx`, `strings.ts` (`S.customProviders`)
- Test: `custom-provider-draft.test.ts`, `CustomProviderPanel.test.tsx`, `ProviderCard.test.tsx` (без правок ожиданий)

**Interfaces:**
- Consumes: методы и типы задачи 1; `providers.setKey/clearKey/check` (задача 8).
- Produces:
  - `interface CustomPresetEndpoint { id: string; label: string; baseUrl: string; auth: CustomProviderAuth; models: CustomProviderModels; contextWindow: number | null }`, `interface CustomPreset { id: string; label: string; billing: string; keyUrl: string; endpoints: readonly CustomPresetEndpoint[] }`, `CUSTOM_PRESETS: readonly CustomPreset[]` (порядок: kimi, minimax, qwen, deepseek, openrouter)
  - `interface CustomProviderDraft { id: string | null; label: string; preset: string | null; endpointId: string | null; baseUrl: string; auth: CustomProviderAuth; models: CustomProviderModels; oneModel: boolean; contextWindow: number | null; linkClaude: boolean; key: string }`
  - `draftFromPreset(preset: CustomPreset | null, endpoint: CustomPresetEndpoint | null): CustomProviderDraft` (`null` — «Own address», `linkClaude: true` — К4), `draftFromProvider(item): CustomProviderDraft`, `draftError(draft, keySaved: boolean): string | null`, `saveParams(draft): Params<'providers.saveCustom'>`
  - `CustomProviderPanel({ providerId: string | 'new', onSaved(id: string): void, onDeleted(): void }): JSX.Element`

- [ ] **Step 1: Сверить пресеты с официальными страницами** (WebFetch) по ссылкам из исследования, раздел 3: адрес, `auth` (Bearer / x-api-key), имена моделей по слотам, окно контекста. Таблица исследования — стартовые значения; страница вендора побеждает. Чего не удалось установить (хосты Qwen по регионам, слаги OpenRouter) — пустая строка, человек вписывает сам. У Kimi два адреса: Moonshot API (токены) и Kimi Code (подписка). Отдельно (спека 9.5): какие модели отвечают 400 без thinking (по исследованию — Kimi k2.7-code, MiniMax Flash) — такую модель не ставить в пресет по умолчанию на слот, где Claude Code может звать без thinking (Haiku, фоновые задачи); поведение effort в этой работе не меняется. Итог — коммент в `custom-presets.ts` со ссылкой и датой сверки.
- [ ] **Step 2: Тесты**

```ts
it('draftError: пустое имя, http на удалённый адрес, пустой слот без oneModel — свои тексты; oneModel заполняет все слоты значением Sonnet', …);
it('draftError: новый провайдер без ключа — ошибка, кроме loopback-адреса', …);
it('saveParams: oneModel → четыре одинаковых слота; id null у нового', …);
it('панель new: плитки Kimi, MiniMax, Qwen, DeepSeek, OpenRouter, Own address; Kimi подставляет адрес и модели', …);
it('Save: saveCustom → setKey (если ключ введён) → onSaved(id); ошибка хоста — текстом под формой, ключ в тексте не появляется', …);
it('галочка «Bring from Claude Code» включена у нового и показывает подпись про ссылки; строка с папкой показывает custom.folder', …);
it('Check зовёт providers.check и показывает CheckLine; Delete спрашивает подтверждение, «also delete folder» выключен по умолчанию (К6)', …);
it('хост без providers.saveCustom — форма недоступна и говорит перезапустить хост', …);
```

- [ ] **Step 3:** `pnpm --filter @parley/desktop exec vitest run src/renderer/components/providers/` → FAIL.
- [ ] **Step 4: Реализовать.** Тексты — `S.customProviders`: подписи полей и подсказки из спеки 4.3 по-английски (`Name in Parley`, `Address (Anthropic-compatible)`, `API key`, `Instead of Opus/Sonnet/Haiku`, `Subagents`, `One model for all slots`, `Bring from Claude Code: CLAUDE.md, skills, agents`, подпись `These are links: editing them in this provider changes the originals your Claude sessions use. To change something only here, ask the agent to make a copy first.`, `Own Claude Code settings: <folder> — sign-in, history and memory stay separate from Claude.`, `Check`, `Save`, `Delete provider`, `Also delete its folder (history)`). Ключ после сохранения — `Key ••••a1b2` + Replace/Remove, как у GLM в `ProviderCard`. Выбор адреса пресета с двумя адресами — `Select`.
- [ ] **Step 5:** тесты шага 3 → PASS; `pnpm --filter @parley/desktop typecheck`.
- [ ] **Step 6: Commit** `feat(desktop): выбор вендора и форма своего провайдера`

---

### Task 12: Окно — значок Parley, карточка в New session, NOTICE

**Files:**
- Create: `packages/desktop/src/renderer/assets/providers/parley.svg` (копия `docs/media/brand/parley-icon.svg`)
- Modify: `packages/desktop/src/renderer/components/AgentIcon.tsx`, `components/providers/ProviderCard.tsx` (ветка своего провайдера), `NOTICE` (раздел «Значки провайдеров»)
- Test: `components/AgentIcon.test.tsx`, `components/providers/ProviderCard.test.tsx`, `components/dialogs/NewSessionOrRoomDialog.test.tsx`

**Interfaces:**
- Consumes: `isCustomProviderId` (протокол), `openSettingsDialog` (задача 10).

- [ ] **Step 1: Тесты**

```ts
it('AgentIcon: custom-* → img parley.svg; glm по-прежнему буква G', () => {
  render(<AgentIcon provider="custom-kimi" />);
  expect(container.querySelector('img')?.getAttribute('src')).toMatch(/parley\.svg$/);
});
it('Review Focus 4: AgentIcon для удалённого custom-id (нет в сторе) — всё равно значок Parley', …);
it('ProviderCard своего провайдера: имя, состояние и кнопка Open in Settings → openSettingsDialog("providers", { provider: id })', …);
it('New session: свой провайдер — пилюля с меткой; неподключённый открывает карточку с Open in Settings; меню модели — настоящие имена', …);
```

- [ ] **Step 2:** `pnpm --filter @parley/desktop exec vitest run src/renderer/components/AgentIcon.test.tsx src/renderer/components/providers/ProviderCard.test.tsx src/renderer/components/dialogs/NewSessionOrRoomDialog.test.tsx` → FAIL.
- [ ] **Step 3: Реализовать.** `brandIcon`: `isCustomProviderId(provider)` → `parleyUrl` (вендорские значки — следующая работа, спека 3.7). В `ProviderCard` — ветка `provider.custom != null` до веток Claude/Codex/GLM. NOTICE: `assets/providers/parley.svg` — собственный знак проекта, копия `docs/media/brand/parley-icon.svg`.
- [ ] **Step 4:** тесты шага 2 + `src/renderer/csp.test.ts` → PASS; `pnpm --filter @parley/desktop typecheck`.
- [ ] **Step 5: Commit** `feat(desktop): значок Parley и карточка своего провайдера`

---

### Task 13: Документация и живая приёмка

**Files:**
- Modify: `README.md` (раздел «Providers»), `CHANGELOG.md` (Unreleased), `docs/specs/2026-10-17-custom-providers-design.md` (раздел 9 — результаты)

- [ ] **Step 1: README и CHANGELOG** — как подключить своего провайдера, что папка своя и что переносится ссылками, что модели без Anthropic-адреса идут через прокси человека, минимальная версия Claude Code 2.1.302. Отдельный абзац (спека 5.8): правка подтянутых CLAUDE.md, навыков и агентов меняет основной Claude Code; чтобы поменять только у провайдера — попросить агента сначала сделать копию; серверы MCP у каждого провайдера свои.
- [ ] **Step 2: Живая проба** (`pnpm --filter @parley/desktop build`, запуск окна): для каждого пресета, к которому есть ключ, — сохранить, «Check», комната из Claude + этого провайдера, письмо через MCP Parley, вызов инструмента, возобновление после перезапуска сессии, `find_skill`. Нет ключа — пункт помечается «не проверено», не «работает». На одном пресете — проба правила 5.8: попросить агента поправить подтянутый навык; ожидание — агент сначала спрашивает «для обоих или только здесь», на «только здесь» делает копию, sha256 файлов оригинала в `~/.claude/skills/<навык>` прежние.
- [ ] **Step 3: Проба `/logout` — делает человек**, не агент: войти в свою сессию через `/login` невозможно без аккаунта Anthropic, поэтому — `/logout` в сессии своего провайдера, затем обычная сессия Claude должна остаться в аккаунте. Восстановление, если нет: `claude` → `/login`. Записать исход в спеку 6.1. Linux и Windows (спека 9.2) в этой работе не проверяются — так и записать в раздел 9.
- [ ] **Step 4:** снова `custom-providers.isolation.test.ts` и `test/frame-check.test.ts` → PASS.
- [ ] **Step 5: Commit** `docs: свои провайдеры — README, CHANGELOG, итоги живой пробы`
