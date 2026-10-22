# Подписки, этап 3: семейство Codex и второй аккаунт Codex — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** у Codex появляется семейство (`family: 'codex'`, `isCodex`), всё, что сейчас проверяет `=== 'codex'`, работает для любого провайдера семейства; история, лимиты и индекс журналов Codex читаются из папки провайдера; из окна добавляется второй аккаунт Codex с `CODEX_HOME=~/.parley/providers/codex-<slug>/`, входом `codex login` из Parley и своими лимитами.

**Architecture:** зеркало этапа 2 для Codex поверх сквозной правки: `isCodex(entry|id)` рядом с `isClaudeCode`, `codexHomeFor(entry, env)` рядом с `claudeConfigDirFor`, `codexRootFor(provider)` и `codexAccountRoots()` рядом с `claudeRootFor`/`customProviderProjectRoots`. Запись реестра аккаунта — копия реестровой записи `codex` после каталога моделей и `providers.json`. Служба входа этапа 2 получает команды Codex.

**Tech Stack:** как в этапе 2.

**Spec:** `docs/specs/2026-10-21-subscriptions-design.md` — 5.1 (id `codex-`), 5.2, 5.3 (Codex), 5.4 (Codex), 5.6, 5.7 (Codex), 8 (К4, К6, К8, К11, К15), 9, 10. Карта кода: `…/scratchpad/map-codex-limits.md` (может исчезнуть; ориентир — file:line ниже, `origin/master` ad5ecbf8).

## Global Constraints

- Те же, что в этапе 2 (ветка, язык коммитов, тесты только по файлам, два исполнителя Sonnet, сборка ядра/протокола перед хостом, `frame-scan`).
- Минимальная версия Codex для аккаунтов — `ACCOUNT_MIN_VERSION_CODEX` (задача 0; известно, что `0.162.0` подходит). Глобальный `codex` — без `minVersion`, как сейчас.
- Parley не читает `auth.json` ни в одной папке и не пишет `config.toml` ни в `~/.codex`, ни в папке аккаунта (К6: доверие к папке — по согласию, не молча).
- Каталог моделей `codex-models.json` — один на все аккаунты (К4).
- Поведение глобального `codex` не меняется: его тесты проходят без правок ожиданий, кроме мест, где `=== 'codex'` заменён на `isCodex` (та же истина для id `codex`).

## Review Focus

1. **Запись `providers.json` с id `codex-mine`.** Отказ `the custom- and codex- prefixes are reserved` (этап 2, задача 2) — не переопределение; тест — задача 1 (`providers.test.ts`).
2. **Rollout-лог аккаунта и глобального Codex с одним cwd и временем старта.** Привязка `cwd+time` ищет только в корне провайдера сессии и не захватывает чужой лог; тест — задача 3 (`metrics.test.ts`, два корня, одинаковые `cwd`/`startedAt`).
3. **Лимиты: у аккаунта логи есть, у глобального нет.** В строке статуса шкала только у аккаунта; `codex` без лимитов; тест — задача 4 (`limits-service.test.ts`).
4. **Первый запуск сессии аккаунта в пустом `CODEX_HOME` — экран доверия.** Сессия показывается как эпизод `startup` с уведомлением, не как сбой; после прохода человеком экрана запуск продолжается; проверка — задача 0 (проба) и задача 7 (E2E с заглушкой, печатающей экран доверия до `Ready`).
5. **`OPENAI_API_KEY` в окружении хоста.** Сессия аккаунта его не получает; глобальный Codex — как раньше; тест — задача 6 (`provider-env.test.ts`).

---

### Task 0: Пробы до кода (спека 9)

- [ ] **Step 1:** `CODEX_HOME=$S/acct-codex codex login` в интерактивном терминале: браузер, вопросы, порт обратного вызова; после — `CODEX_HOME=$S/acct-codex codex login status` (текст и код возврата при входе), `ls $S/acct-codex` (`auth.json` появился), `stat -f %m ~/.codex/auth.json` до и после — не изменился.
- [ ] **Step 2:** `CODEX_HOME=$S/acct-codex codex` в пустом проекте: какие экраны до композера (доверие к папке, онбординг); что Codex сам пишет в `$S/acct-codex/config.toml` после согласия.
- [ ] **Step 3:** `OPENAI_API_KEY=x CODEX_HOME=$S/acct-codex codex login status` и короткий `codex exec`: перебивает ли ключ вход → список переменных для 5.3.
- [ ] **Step 4:** Версии: с какой `codex` есть `login status` → `ACCOUNT_MIN_VERSION_CODEX`.
- [ ] **Step 5:** Если обратный вызов из PTY не срабатывает — повторить с `codex login --device-auth` (К15) и записать.
- [ ] **Step 6:** Итоги → спека, подраздел «9.2 Итоги задачи 0 (Codex)»; `CODEX_HOME=$S/acct-codex codex logout`; папку удалить. Commit `docs(specs): subscriptions — results of the Codex sign-in probe`.

### Task 1: Ядро — семейство Codex, `isCodex`, `codexHomeFor`, корни

**Files:**
- Modify: `packages/core/src/providers.ts` (`ProviderFamily` `:30`, запись `codex` `:305` — `family: 'codex'`, рядом с `isClaudeCode` `:423` и `claudeConfigDirFor` `:436`), `packages/core/src/codex/discover.ts:12`, `packages/core/src/index.ts`.
- Test: `packages/core/src/providers.test.ts`, `packages/core/src/codex/discover.test.ts`.

**Interfaces (produces):**
```ts
export type ProviderFamily = 'claude' | 'codex';
export function isCodex(entry: ProviderEntry | string): boolean;      // строка: id === 'codex' || isCodexAccountId(id); запись: family === 'codex'
export function codexHomeFor(entry: ProviderEntry | string, env: NodeJS.ProcessEnv = process.env): string | undefined; // runner.configDir ?? env.CODEX_HOME (для строки — по реестру не ходит: строка 'codex' → env.CODEX_HOME, 'codex-*' → customProviderDir(id))
export function codexRootFor(provider: string): string;              // codex-* → <customProviderDir>/sessions; иначе defaultCodexRoot()
export function codexAccountRoots(home?: string): string[];           // <home>/providers/codex-*/sessions, отсортировано
```
- `isClaudeCode('codex-x')` остаётся `false` (строковая ветка — `custom-`).

- [ ] **Step 1: Падающие тесты:** `isCodex('codex')`, `isCodex('codex-two')` true, `isCodex('custom-a')` false, `isCodex(registry.codex)` true; `codexRootFor('codex-two')` = `<home>/providers/codex-two/sessions`; `codexAccountRoots` видит только `codex-*`; `providers.json` с `codex-mine` → отказ (Review Focus 1).
- [ ] **Step 2:** FAIL → **Step 3: Реализовать; build** → **Step 4:** PASS → **Step 5: Commit** `feat(core): codex family — isCodex, codexHomeFor, per-provider Codex roots`.

### Task 2: Ядро — `=== 'codex'` → `isCodex`, папка из записи

**Files (по карте кода):**
- Modify: `packages/core/src/work/launch.ts:268,275,300,351,357,398,413,429,451` (и `roots.codexHome` `:273` → `codexHomeFor(entry, process.env)`, lean-флаги `:358` → тот же источник), `packages/core/src/work/agents.ts:67,111,119,162-189` (`sessionRoleCatalog` — запись Codex по провайдеру сессии, `codexHome` из записи), `packages/core/src/work/metrics.ts:64-65` (`adapterFor`: `isCodex(provider)` → `codexRootFor(provider)`), `packages/core/src/work/summary.ts:107-108`, `packages/core/src/work/room-usage.ts:73`, `packages/core/src/work/native-context.ts:166`, `packages/core/src/mcp/tools.ts:1374-1377,1440,1477,1490`, `packages/core/src/all-sessions.ts:27`, `packages/core/src/watch.ts:70`, `packages/core/src/codex/index-session.ts:395`, `packages/core/src/cli.ts:306`.
- Test: тесты рядом (`launch.test.ts`, `agents.test.ts`, `metrics.test.ts`, `summary.test.ts`, `room-usage.test.ts`, `mcp/server.test.ts`, `all-sessions.test.ts`, `watch.test.ts`).

**Interfaces:**
- Consumes: `isCodex`, `codexHomeFor`, `codexRootFor` (задача 1).
- Правило: где проверка значила «это Codex как CLI» — `isCodex`; где «именно глобальный `codex`» (каталог `codex-models.json`, `registry.codex` как источник флагов для **чужого** провайдера) — остаётся по id с комментарием «глобальный Codex: спека подписок 5.2». `sessionRoleCatalog(cwd, { provider })` берёт запись `registry[provider]`, когда `isCodex(provider)`, иначе `registry.codex`.

- [ ] **Step 1: Падающие тесты:** `adapterFor('codex-two')` читает `<папка>/sessions` (Review Focus 2: два корня, одинаковые `cwd` и `startedAt` — привязывается лог из корня провайдера); `launch` сессии `codex-two` пишет дескриптор с `roots.codexHome` = папка аккаунта и lean-флаги по `<папка>/config.toml`; `find_skill` для `codex-two` идёт по ветке Codex; `bindCodexThread` обновляет `providerSessionId` у `codex-two`.
- [ ] **Step 2:** FAIL → **Step 3: Реализовать; build** → **Step 4:** тесты + прежние тесты `codex` без правок ожиданий → PASS → **Step 5: Commit** `refactor(core): codex family checks and the Codex home from the provider entry`.

### Task 3: Хост — индекс журналов, активность, лента, остальные `=== 'codex'`

**Files (по карте):**
- Modify: `packages/host/src/activity/log-index.ts:95` (`logFamily` → `isCodex`), `:124-134` (`codexRoots` по образцу `customRoots` → `codexAccountRoots()`), `:316-340` (`codexSource` на каждый корень; `watchCodexRoot(root)`), `packages/host/src/activity/activity-service.ts:300,418,670,693,1112`, `packages/host/src/activity/codex-log-poll.ts:56`, `packages/host/src/feed/feed-service.ts:627,677,918,978,1019,1085,1241,1315`, `packages/host/src/hooks/hook-server.ts:321`, `packages/host/src/pty/pty-manager.ts:157`, `packages/host/src/pty/send.ts:76`, `packages/host/src/sessions/sessions-service.ts:421,579,671` (и `watchCodexRoot(<папка>/sessions)` перед запуском аккаунта, рядом с `watchClaudeRoot` `:655-663`), `packages/host/src/wake/wake-service.ts:654`, `packages/host/src/compaction/compaction-service.ts:40,163`, `packages/host/src/context/context-service.ts:64`, `packages/host/src/capabilities/snapshot.ts:100-116` и `native-targets.ts:32-47` и `share-skill.ts:84` (`codexHome` из записи провайдера сессии), `packages/host/src/methods/role-catalog-cache.ts:38`.
- Test: тесты рядом с каждым файлом; `log-index.test.ts` — новый корень.

**Interfaces:**
- `LogIndex.watchCodexRoot(root: string): void` — как `watchClaudeRoot`; `ActivityService.watchCodexRoot` — проброс.
- `codexLogFiles()`/`logFile()` находят rollout в любом из корней Codex.

- [ ] **Step 1: Падающие тесты:** `log-index.test.ts` — rollout в `<home>/providers/codex-two/sessions/...` виден сессии провайдера `codex-two`, а глобальному `codex` — нет; `feed-service.test.ts` — лента сессии `codex-two` читает rollout из её корня; `sessions-service` — запуск `codex-two` зовёт `watchCodexRoot`.
- [ ] **Step 2:** FAIL → **Step 3: Реализовать** → **Step 4:** тесты затронутых файлов → PASS → **Step 5: Commit** `refactor(host): codex family — log index with account roots, feed, hooks and services by isCodex`.

### Task 4: Хост — лимиты Codex по провайдерам

**Files:**
- Modify: `packages/host/src/limits/limits-service.ts:184-212` (`collect`: для каждой записи реестра семейства `codex` — `readCodexLimits(codexRootFor(id))` → `consider(id, …)`; `options.codexRoot` остаётся переопределением только для глобального `codex`).
- Test: `limits-service.test.ts`.

- [ ] **Step 1: Падающий тест:** корень аккаунта с rollout, у глобального — пусто → `get('codex-two')` есть, `get('codex')` null (Review Focus 3); событие `providers.limitsChanged` с `id: 'codex-two'`.
- [ ] **Step 2:** FAIL → **Step 3: Реализовать** → **Step 4:** PASS → **Step 5: Commit** `feat(host): Codex limits per provider of the codex family`.

### Task 5: Окно — `=== 'codex'` → семейство

**Files:**
- Modify: `packages/desktop/src/renderer/chat/ChatView.tsx:187`, `lib/feed-view.ts:49,78`, `components/providers/ProviderCard.tsx:58`, `island/requests.ts:154`, `attention/notify.ts:220`, `components/rooms/RoomContextChip.tsx:81`, `components/context/CompactForm.tsx:24`, `components/dialogs/AgentRowsEditor.tsx:125`.
- Test: тесты рядом.

**Interfaces:**
- Где есть строка `providers.list` — `provider.family === 'codex'`; где только id сессии — `isCodexProviderId(id)` из протокола: `export const isCodexProviderId = (id: string): boolean => id === 'codex' || isCodexAccountId(id)` (добавить в `protocol/src/custom-providers.ts`); карточка установки (`ProviderCard.tsx:58`) — по-прежнему только у глобального `codex`.

- [ ] **Step 1: Падающие тесты:** `feed-view` для `codex-two` строит ленту Codex; `ChatView` у `codex-two` — режим Codex; остров — у `codex-two` без карточки — «in terminal», как у `codex`.
- [ ] **Step 2:** FAIL → **Step 3: Реализовать** → **Step 4:** тесты + `typecheck` → PASS → **Step 5: Commit** `refactor(desktop): codex family checks by family and id prefix`.

### Task 6: Ядро и хост — аккаунт Codex: запись, папка, окружение, вход, сохранение

**Files:**
- Modify: `packages/core/src/custom-providers.ts` (`accountProviderEntry` — ветка `codex-account`, `ACCOUNT_MIN_VERSION_CODEX`), `packages/core/src/custom-provider-dir.ts` (новая `prepareCodexAccountDir`), `packages/host/src/sessions/provider-env.ts` (семейство `codex`: `CODEX_HOME`), `packages/host/src/providers/auth-service.ts` (`authCommands` для Codex), `packages/host/src/methods/custom-providers.ts` (снять отказ `codex-account`; `prepareCodexAccountDir`), `packages/host/src/sessions/sessions-service.ts:628-653` (подготовка папки по семейству; `mirrorProjectTrust` только у Claude).
- Test: `custom-providers.test.ts`, `custom-provider-dir.test.ts`, `provider-env.test.ts`, `auth-service.test.ts`, `methods/custom-providers.test.ts`, `provider-launch.test.ts`.

**Interfaces:**
- `accountProviderEntry(record: { kind: 'codex-account' }, registry, home)`: раннер — копия `registry['codex'].runner` плюс `configDir: customProviderDir(id, home)`, `minVersion: ACCOUNT_MIN_VERSION_CODEX`; `family: 'codex'`, `models: registry['codex'].models`, `linkBy: 'cwd+time'`, `hasHistory: true`, `label: accountLabel(…)` (`Codex 2`), `custom: record`.
- `export async function prepareCodexAccountDir(record: CustomAccountRecord, options: { codexHome: string; home?: string; warn?: (text: string) => void }): Promise<void>` — папка 0700, `sessions/`; при `record.link` — ссылки поштучно, тем же механизмом `.parley-link-source`: `AGENTS.md` (файл) и папки `skills`, `agents` из `options.codexHome` (имена — те, что читают `roles/codex.ts:45` и `skills/codex.ts:111`; исполнитель сверяет по коду и фиксирует тестом). `config.toml` не создаётся.
- `providerLaunchEnv`: семейство `codex` с `configDir` → срезать `CODEX_HOME`, `OPENAI_API_KEY` и список из задачи 0; поставить `CODEX_HOME = configDir`; `CLAUDE_*`-селекторы не трогать.
- `authCommands` (Codex): status `['login','status']` → `code === 0 && !/Not logged in/.test(stdout)`; login `['login']` (или `['login','--device-auth']`, если так решила задача 0); logout `['logout']`.
- `saveCustom` для `codex-account`: id `codex-<slug>` (`defaultAccountSlug` → `codex-2`, …), `prepareCodexAccountDir({ codexHome: process.env.CODEX_HOME ?? ~/.codex })`.
- Запуск: для `codex-account` — `prepareCodexAccountDir` в `serialized`, без `mirrorProjectTrust` и `syncApiKeyApproval`; `watchCodexRoot(<папка>/sessions)`.
- `linkedSettingsRule` (`work/launch.ts:434`, этап 2 задача 3) для семейства `codex` называет `~/.codex` и `AGENTS.md` вместо `~/.claude` и `CLAUDE.md`; тест в `launch.test.ts`.

- [ ] **Step 1: Падающие тесты:** запись реестра аккаунта Codex (поля выше; `args` равны реестровым после `providers.json`); `prepareCodexAccountDir` с `link: true` даёт ссылки `AGENTS.md`, `skills/<x>`, `agents/<y>` и не создаёт `config.toml`; `providerLaunchEnv` аккаунта Codex: `CODEX_HOME` = папка, `OPENAI_API_KEY` срезан, глобальный `codex` не тронут (Review Focus 5); `authCommands(codexAccount).parse(1, 'Not logged in')` false, `.parse(0, 'Logged in using ChatGPT')` true; `saveCustom` `codex-account` → `codex-2`.
- [ ] **Step 2:** FAIL → **Step 3: Реализовать; build core** → **Step 4:** PASS → **Step 5: Commit** `feat(core,host): Codex account — registry entry, folder with links, CODEX_HOME launch environment, sign-in commands`.

### Task 7: Окно и E2E аккаунта Codex

**Files:**
- Modify: `custom-presets.ts` (плитка `codex-account` активна), `AccountPanel.tsx` (тексты по семейству: `Bring from Codex`, `Own Codex settings: <folder> — sign-in, history and memory separate from your regular Codex.`), `AgentIcon.tsx` (семейство `codex` → значок Codex).
- Modify: `packages/desktop/e2e/stub-codex-agent.mjs` — подкоманды `login status` (файл `$CODEX_HOME/stub-auth.json` → `Logged in using ChatGPT`, код 0; иначе `Not logged in`, код 1), `login` (печатает ссылку, ждёт строку или 1 с, пишет файл), `logout`; rollout — в `$CODEX_HOME/sessions/<y>/<m>/<d>/rollout-*.jsonl` (если переменная есть).
- Create: `packages/desktop/e2e/codex-account.spec.ts`.

**Сценарии:** зеркало этапа 2, задача 10, для Codex: добавить → `Codex 2`, `Not signed in`; `Sign in` → `Signed in`; New session → заглушка получает `CODEX_HOME=<папка>` и не получает `OPENAI_API_KEY`; соседний `codex` — без `CODEX_HOME`; `<HOME>/.codex` не изменился; лимиты из rollout аккаунта — шкала у `codex-2`, у `codex` нет; первый запуск с экраном доверия (заглушка печатает `Trust this folder?` и ждёт Enter) → сессия в состоянии `startup`, уведомление; после `Enter` в терминале — `Ready`; 800×500 обе темы.

- [ ] **Step 1:** заглушка, окно, тест. **Step 2:** `pnpm --filter @parley/desktop build && pnpm --filter @parley/desktop exec playwright test e2e/codex-account.spec.ts` (DPR 1 и 2) → PASS. **Step 3: Commit** `feat(desktop): Codex account tile and form; e2e for Codex accounts`.

### Task 8: Документы, ревью, PR

**Files:** `README.md`, `CHANGELOG.md` (`## Unreleased` — «Accounts» дополняется Codex), `docs/specs/2026-10-21-subscriptions-design.md` (статус: этапы 1–3 выполнены; что проверено вживую, что нет), `packages/core/test/frame-scan.ts`.

- [ ] **Step 1:** правки; `release-docs.test.ts`, `frame-check.test.ts` → PASS. **Step 2: Commit** `docs: Codex accounts — README, CHANGELOG, spec status`.
- [ ] **Step 3:** ревью диффа этапа свежим рецензентом (Opus); `verification-before-completion`; push; PR «Codex family and a second Codex account» открывает человек. Релиз (CHANGELOG → версия, тег) — по обычному порядку релизов после слияния третьего PR.
