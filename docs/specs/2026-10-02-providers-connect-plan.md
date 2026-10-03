# Подключение провайдеров и GLM на подписке Z.ai — план

> **Для исполнителей.** Нужен навык superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans. Шаги отмечаются чекбоксами (`- [ ]`).

**Цель.** Строка статуса всегда показывает Claude, Codex и GLM: подключённый провайдер ярким, неподключённый — приглушённым. Клик открывает карточку провайдера с инструкцией или подключением. GLM — это официальный `claude` на адресе подписки Z.ai, ключ к которому пользователь вставляет сам.

**Устройство.**
- Ключ Z.ai лежит в `secrets.json` дома Parley (`0600`), читает и пишет его только модуль `core/secrets.ts`.
- Запись `glm` реестра запускает `claude` со своим файлом `--settings` (адрес и модели) и с идентификатором секрета.
- Хост при запуске кладёт ключ в `ANTHROPIC_AUTH_TOKEN` процесса и отказывает, если ключа нет.
- Окно получает из `providers.list` только `needs`, `keyHint` и `family`, а ключ отправляет новыми методами `providers.setKey` и `providers.clearKey`.
- Всё, что в 0.4.0 (вид Chat, лента, подсказки ввода) включено по id `'claude'`, переходит на признак `family: 'claude'`, который есть у Claude и GLM.

**Стек.** TypeScript, pnpm-монорепо (core, protocol, host, desktop), Electron 44, React, zustand, zod, vitest, Playwright.

**Спека:** `docs/specs/2026-10-02-providers-connect-design.md`. Читать вместе с планом; при расхождении права спека.

## Общие ограничения

- Комментарии, тесты, спеки и TODOS — по-русски. Тексты окна, README и тексты для агентов — по-английски.
- Не читать `~/.claude/.credentials.json`, `~/.codex/auth.json` и связку ключей. Не писать в `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.agents` — ни в коде, ни в тестах.
- Хуки — только через `--settings`. Никаких скрытых запусков агентов, автоответов на их диалоги и YOLO-флагов.
- Настоящие `claude`, `codex` и Z.ai в тестах не участвуют. Тесты живут во временном доме (`PARLEY_HOME`) и никогда не трогают настоящий `~/.parley/secrets.json`.
- Протокол — только добавления, `PROTOCOL_VERSION` остаётся 1. Новые поля ответа необязательны.
- Ключ не попадает в карту, бриф, конфиг MCP, файлы `--settings`, `LaunchPlan`, журналы, уведомления, тексты ошибок, а в окно — дальше подсказки `••••` и четырёх последних знаков.
- Окно и хост в сеть не ходят: ключ запросом не проверяется.
- Коммиты — с явными путями и строкой `Co-Authored-By` модели исполнителя. Без `git stash`.
- Тяжёлые прогоны (полные тесты, E2E) — через `heavy.sh` основной папки, по одному.

## Самые вероятные поломки

1. **Ключ, вставленный с пробелом или переводом строки по краям** (так бывает при копировании). Он сохраняется обрезанным; пробел внутри — отказ с понятным текстом. Тест — задача 1.
2. **У человека в окружении или в `~/.claude/settings.json` уже есть `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` или закреплённая модель Claude.** GLM-сессия всё равно идёт на Z.ai с сохранённым ключом и моделью GLM, а обычные сессии Claude Parley не трогает. Тест — задача 4: `ANTHROPIC_AUTH_TOKEN` процесса GLM перекрывает унаследованный, у Claude его нет.
3. **Ключ удалён, а спящие GLM-сессии остались.** Будильник и `resume` отказывают с уведомлением `launch-failed` и не запускают процесс с адресом Z.ai без ключа. Тест — задача 4.
4. **Новое окно со старым хостом.** Полей `needs` и `keyHint` нет, а методов `providers.setKey` и `providers.clearKey` хост не знает. Окно выводит «подключён» из `available`, строка статуса предлагает перезапуск хоста, карточка GLM показывает «Restart host» вместо поля. Тесты — задача 5.
5. **Узкое окно 800×500 с длинными версиями и лимитами в трёх сегментах.** Строка статуса не вылезает за край, поповер карточки помещается в окно. Проверка глазами и E2E — задачи 5 и 8.

---

### Задача 1: хранилище ключа (core)

**Файлы:**
- создать: `packages/core/src/secrets.ts`, `packages/core/src/secrets.test.ts`;
- изменить: `packages/core/src/index.ts` (экспорт).

**Что даёт:**
- `export type SecretId = 'zai';`
- `export const SECRET_NAMES: Readonly<Record<SecretId, string>> = { zai: 'Z.ai' };`
- `export function secretsFile(): string` — `path.join(parleyHome(), 'secrets.json')`.
- `export class SecretFormatError extends Error`.
- `export function normalizeSecret(raw: string): string` — обрезает пробелы по краям и бросает `SecretFormatError` с текстом:
  - пусто — `the key is empty`;
  - длиннее 512 знаков — `the key is longer than 512 characters`;
  - пробел или управляющий символ внутри (`/[\s\u0000-\u001f\u007f]/`) — `the key must not contain spaces or control characters`.
- `export function secretHint(key: string): string` — `'••••' + key.slice(-4)`.
- `export async function readSecret(id: SecretId): Promise<string | null>` — нет файла, нет поля или файл не разбирается — `null`.
- `export async function hasSecret(id: SecretId): Promise<boolean>`.
- `export async function writeSecret(id: SecretId, raw: string): Promise<string>`:
  - нормализует ключ;
  - кладёт его в `{ [id]: { key } }`, остальные поля файла сохраняет;
  - пишет атомарно: временный файл рядом с `mode: 0o600`, `chmod 0o600`, затем `rename`;
  - заводит дом, если его нет;
  - возвращает подсказку.
- `export async function clearSecret(id: SecretId): Promise<void>` — убирает поле; если файл остался пустым, удаляет его.

**Шаги:**
- [ ] Написать тесты (временный `PARLEY_HOME`):
  - права `0600` после записи и после перезаписи;
  - `'  zai-key-1234\n'` сохраняется как `zai-key-1234`, подсказка — `••••1234`;
  - отказы: пусто, 513 знаков, `'a b'`, `'a\tb'`;
  - `clearSecret` удаляет файл, если других полей нет, и сохраняет чужое поле `{"other":{"key":"x"}}`;
  - битый JSON: `readSecret` даёт `null`, а `writeSecret` перезаписывает файл;
  - `secretsFile()` следует за `PARLEY_HOME`.
- [ ] Запустить и увидеть падение. Реализовать. Запустить `pnpm --filter @parley/core test -- secrets` — зелёный.
- [ ] Коммит `feat(core): хранилище ключа провайдера secrets.json (0600)`.

### Задача 2: запись `glm` и её файл настроек (core)

**Файлы:**
- изменить: `packages/core/src/provider-models.ts`, `packages/core/src/providers.ts`, `packages/core/src/work/settings-file.ts`, `packages/core/src/work/launch.ts`, `packages/core/src/work/metrics.ts`, `packages/core/src/work/summary.ts`, `packages/core/src/index.ts`;
- тесты: `providers.test.ts`, `work/settings-file.test.ts`, `work/launch.test.ts`, `work/metrics.test.ts`, `work/summary.test.ts`.

**Что берёт:** `SecretId` из задачи 1.

**Что даёт:**
- `GLM_MODELS: readonly ModelOption[] = [{ id: 'glm-5.3[1m]', label: 'GLM-5.3' }, { id: 'glm-5.3-flash[1m]', label: 'GLM-5.3 Flash' }]`. Комментарий: источник — `docs.z.ai/devpack/tool/claude`, сверено 2026-10-02.
- `RunnerConfig` получает необязательные поля:
  - `settingsEnv?: Readonly<Record<string, string>>`;
  - `settingsModel?: string`;
  - `secret?: SecretId`.
- `ProviderEntry` получает `family?: 'claude'` — запускается Claude Code (спека 4.1).
- Новые поля — только у встроенных записей. `applyOverride` берёт их из базы и никогда из `providers.json`; `checkShape` их по-прежнему не знает.
- `PROVIDERS.claude.family = 'claude'`.
- `PROVIDERS.glm`:
  - `label` — `'GLM'`, `mark` — `'GL'`, `hasHistory` — `false`;
  - `linkBy: 'session-id'`, `family: 'claude'`, `models: GLM_MODELS`;
  - `runner.command: 'claude'`;
  - `args` и `resumeArgs` — шаблоны Claude без пары `'--dangerously-load-development-channels', '{channel}'`: вынести шаблоны Claude в константы и снять пару функцией;
  - `mcpConfig: 'json-file'`;
  - `settingsModel: 'glm-5.3[1m]'`;
  - `settingsEnv` — восемь пар из спеки 4.2 дословно, строками;
  - `secret: 'zai'`.
- `export function isClaudeCode(provider: string): boolean` — `family === 'claude'` у встроенной записи с таким id, без чтения `providers.json`.
- `settings-file.ts` (в 0.4.0 у `workSettings` и `writeWorkSettings` уже есть `WorkSettingsOptions` с `hookUrl` и `hookEvents`):
  - `WorkSettingsOptions` получает `provider?: ProviderEntry`;
  - если у записи есть `settingsEnv`, `workSettings` добавляет к прежнему содержимому (командные хуки, HTTP-хуки ленты при `hookUrl`, `statusLine`) `model: entry.runner.settingsModel` и `env: { ...entry.runner.settingsEnv }`;
  - `writeWorkSettings` пишет такой файл в `settings-<id>.json` рядом с `settings.json` (каталог `events/` заводит так же) и возвращает его путь. Без `provider` или без `settingsEnv` — побайтно как в 0.4.0.
- `launch.ts`:
  - проверка транскрипта перед `--resume` берёт `!isClaudeCode(session.provider) || await claudeConversationExists(…)`;
  - `subs.settingsFile = await writeWorkSettings(projectPath, workId, { ...(hookUrl), provider: entry })` — `hookUrl` из `LaunchOptions`, как в 0.4.0.
- `metrics.ts#adapterFor` и `summary.ts#transcriptSource` вместо `provider === 'claude'` спрашивают `isClaudeCode(provider)`.

**Шаги:**
- [ ] Обновить тесты, которые закрепляют старый `glm`: `providers.test.ts` (команда `glm`, «ни MCP, ни возобновления»). Тест `packages/host/src/methods/providers.test.ts:97` («без моделей и версии») — в задаче 4.
- [ ] Новые тесты:
  - запись `glm`: команда `claude`, в шаблонах нет флага канала, `secret`, модели, `family`;
  - `startCommand(glm, …)` даёт `--session-id`, `--mcp-config`, `--settings`, `--append-system-prompt` и бриф;
  - переопределение `{"glm":{"models":[…]}}` сохраняет `secret`, `settingsEnv` и `family`, а `{"glm":{"secret":"x","settingsEnv":{},"family":"x"}}` их не меняет;
  - `isClaudeCode`: `claude` и `glm` — да, `codex` и свой провайдер — нет;
  - `settings-glm.json` без `hookUrl` и с ним: те же хуки (с `hookUrl` — и HTTP-хуки ленты) и `statusLine`, ровно восемь пар `env`, `model`, нет `ANTHROPIC_AUTH_TOKEN`; у Claude по-прежнему `settings.json`;
  - `resume` GLM без транскрипта запускается заново с тем же id, как у Claude;
  - метрики и резюме для `glm` читают лог Claude по `providerSessionId`.
- [ ] Сверить по документации Claude Code (`code.claude.com/docs/en/env-vars`), есть ли переменная, которая убирает учётные переменные из окружения дочерних процессов агента (Bash, хуки, MCP) — это риск из спеки, раздел 12.
  - Есть — она становится девятой парой `settingsEnv`, тест ждёт девять пар, README её упоминает.
  - Нет — в TODOS запись со ссылкой на спеку.
- [ ] Реализовать. Прогнать `pnpm --filter @parley/core test` и `typecheck` — зелёные.
- [ ] Коммит `feat(core): glm — claude на адресе подписки Z.ai со своим --settings`.

### Задача 3: отказы без ключа в core и признак готовности

**Файлы:**
- изменить: `packages/core/src/providers.ts`, `packages/core/src/work/launch.ts` (тип `LaunchPlan`), `packages/core/src/cli.ts`, `packages/core/src/mcp/tools.ts`, `packages/core/src/index.ts`;
- тесты: `providers.test.ts`, `work/launch.test.ts`, `cli.test.ts`, `mcp/tools.test.ts`.

**Что даёт:**
- `export async function providerNeeds(entry: ProviderEntry, env = process.env): Promise<'cli' | 'key' | null>`:
  - команды нет в `PATH` (с учётом оверрайда) — `'cli'`;
  - есть `runner.secret`, но ключа нет — `'key'`;
  - иначе — `null`.
- `export function notConnectedMessage(entry: ProviderEntry): string` — `` `${entry.label} is not connected: add a ${SECRET_NAMES[secret]} key (status bar → ${entry.label})` ``.
- `LaunchPlan.secret?: SecretId`:
  - ставится, только если у записи есть `runner.secret` и `runner.command === 'claude'`;
  - значения ключа в плане нет никогда.
- `cli.ts`, `work session new`: запись с `runner.secret` — ошибка `` `provider ${provider} starts only from the Parley window: its key is added by the Parley host` ``.
- `mcp/tools.ts`:
  - `get_map` показывает `available: (await providerNeeds(entry)) === null`;
  - `spawn_session`: `'cli'` — прежний текст, `'key'` — `notConnectedMessage(entry)`. Записи в карте нет.

**Шаги:**
- [ ] Тесты:
  - `providerNeeds` во всех трёх состояниях (временный дом, `PARLEY_CLAUDE_BIN` на временный исполняемый файл или `''`);
  - `LaunchPlan.secret` есть у `glm` и нет у Claude, Codex и `{"glm":{"command":"my-glm"}}`;
  - `JSON.stringify(plan)` не содержит записанный тестовый ключ;
  - CLI отказывает для `glm`;
  - `spawn_session` без ключа отказывает, карта не меняется.
- [ ] Реализовать, прогнать тесты core, закоммитить `feat(core): GLM без ключа не запускается — CLI, spawn_session, признак needs`.

### Задача 4: протокол и хост

**Файлы:**
- изменить: `packages/protocol/src/methods.ts`, `packages/protocol/src/events.ts`, `packages/host/src/methods/providers.ts`, `packages/host/src/methods/index.ts`, `packages/host/src/sessions/sessions-service.ts`, `packages/host/src/feed/feed-service.ts`, `packages/host/src/methods/capabilities.ts`;
- тесты: `packages/protocol/src/methods.test.ts` (схемы), `packages/host/src/methods/providers.test.ts`, `packages/host/src/sessions/sessions-service.test.ts`, тесты `feed-service` и `capabilities`.

**Что даёт:**
- **Протокол, параметры:**
  - `'providers.setKey': z.object({ provider: z.string().min(1).max(64), key: z.string().min(1).max(4096) })`;
  - `'providers.clearKey': z.object({ provider: z.string().min(1).max(64) })`.
- **Протокол, ответы:**
  - `'providers.setKey': { keyHint: string }`;
  - `'providers.clearKey': { ok: true }`;
  - элемент `providers.list` получает `needs?: 'cli' | 'key' | null`, `keyHint?: string | null` и `family?: 'claude' | null`.
- **Событие** `'providers.changed': Record<string, never>`.
- **`providers.list`:**
  - `needs` — из `providerNeeds`;
  - `available` — `needs === null`;
  - `keyHint` — только у записей с `secret`, `secretHint` сохранённого ключа или `null`;
  - `family` — `entry.family ?? null`.
- **Вид Chat для семейства Claude Code** (литералы 0.4.0 → `isClaudeCode`, спека 4.1):
  - `sessions-service.ts#feedHookUrl` — адрес приёмника для любой сессии семейства. Версия для порога — по `entry.runner.command` (у GLM это `claude`), как и сейчас;
  - `feed/feed-service.ts#seed` и `#seedAside` — журнал сессии через `activity.logFile` для семейства;
  - `methods/capabilities.ts` — скан `scanClaudeCapabilities` для семейства, у прочих пустые списки, как сейчас.
- **`providers.setKey` и `providers.clearKey`:**
  - неизвестный провайдер или провайдер без `secret` — `HostError('bad_request', …)`;
  - `SecretFormatError` — `bad_request` с его текстом;
  - после записи хост рассылает `providers.changed`.
- **`sessions-service.ts`:**
  - `create()` до записи в карту: у записи есть `secret`, а ключа нет — `HostError('bad_request', notConnectedMessage(entry))`.
  - `launch()` после плана: если `plan.secret` задан, хост читает ключ.
    - Ключа нет — уведомление `launch-failed` с `notConnectedMessage` и отказ, процесс не стартует.
    - Ключ есть — `env.ANTHROPIC_AUTH_TOKEN = key` поверх `{ ...agentEnv(process.env), ...plan.env }`, там же, где 0.4.0 кладёт `PARLEY_HOOK_TOKEN`.

**Шаги:**
- [ ] Обновить `providers.test.ts:97` хоста: у `glm` теперь есть модели и версия `claude`.
- [ ] Тесты хоста:
  - `providers.list`: нет `claude` — `needs: 'cli'`; нет ключа — `'key'`, `keyHint: null`; всё есть — `null` и `••••1234`; у Claude и Codex `keyHint` нет;
  - `setKey` и `clearKey` с событием и отказами;
  - `create` GLM без ключа — `bad_request`, карта не изменилась;
  - окружение `pty.start`: у GLM есть `ANTHROPIC_AUTH_TOKEN` (и он перекрывает унаследованный из `process.env`), у Claude нет;
  - тестового ключа нет ни в уведомлении, ни в ошибке, ни в файле лога хоста (`createLog`, `log.ts`) после `setKey`, запуска и отказа;
  - будильник или `resume` GLM после `clearKey` — `launch-failed`, `pty.start` не вызван;
  - GLM-сессия на `claude` не ниже 2.1.286 получает `hookUrl` и `PARLEY_HOOK_TOKEN`, Codex — нет;
  - лента GLM-сессии сеется из журнала;
  - `capabilities.list` с `provider: 'glm'` возвращает скан, с `codex` — пустые списки;
  - `providers.list` отдаёт `family`: `'claude'` у `claude` и `glm`, `null` у `codex`.
- [ ] Реализовать, прогнать тесты protocol и host, закоммитить `feat(host): providers.setKey/clearKey, needs, family и ключ Z.ai в окружение GLM-сессии`.

### Задача 5: строка статуса и карточка провайдера (окно)

**Файлы:**
- создать: `packages/desktop/src/renderer/shell/ProviderCard.tsx`, `ProviderCard.test.tsx`, `packages/desktop/src/renderer/lib/provider-install.ts`;
- изменить: `packages/desktop/src/renderer/store/providers.ts`, `shell/StatusBar.tsx`, `StatusBar.test.tsx`, `lib/capabilities.ts`, `lib/feed-view.ts` и его тест, `shared/strings.ts`.

**Что даёт:**
- **Стор.** У `ProviderInfo` с 0.4.0 уже есть `models` и `loaded`. Добавляются поля:
  - `needs: 'cli' | 'key' | null` — от старого хоста: `available ? null : 'cli'`;
  - `keyHint: string | null`;
  - `family: 'claude' | null` — от старого хоста: `id === 'claude' ? 'claude' : null`.
- **Вид Chat** (`lib/feed-view.ts`, спека 4.1):
  - `feedAvailable` и `feedAvailability` вместо `provider !== 'claude'` спрашивают семейство провайдера сессии из стора;
  - пока список не загружен (`loaded` ложно), ответ для любого провайдера, кроме известного не-Claude, — `null` («неизвестно»);
  - `claudeVersion` превращается в версию записи провайдера сессии (у GLM это та же версия `claude`).

  `init` подписывается на `providers.changed` и перечитывает список; поздние ответы отбрасываются, как сейчас. Новый `reload(): Promise<void>` нужен для «Check again».
- **`REQUIRED_METHODS`** пополняется `'providers.setKey'` и `'providers.clearKey'`.
- **`provider-install.ts`.** Команды и ссылки установки Claude Code и Codex. Перед записью сверить с официальной документацией на дату работы; в комментарии — ссылка и дата сверки.
- **`StatusBar.tsx`:**
  - `CORE_PROVIDERS` — `claude`, `codex`, `glm`;
  - сегмент — кнопка-триггер поповера `renderer/ui/popover.tsx`;
  - неподключённый — `opacity-40` (подобрать по контрасту в обеих темах), без версии, лимитов и «not found»;
  - `aria-label` — `` `${name} — connected` `` или `` `${name} — not connected. Click to connect` ``;
  - порядок сжатия сегментов прежний.
- **`ProviderCard.tsx`** — содержимое по спеке 3.2:
  - установка с кнопкой «Copy» (`navigator.clipboard`);
  - строки про вход и PATH, кнопка «Check again»;
  - у GLM: поле `type="password"` с `autoComplete="off"`, «Save», «Replace», «Remove», «Get a key» через `bridge.openExternal`, предупреждение про `/logout`, ошибки под полем;
  - хост без `providers.setKey` — «Restart host» открывает существующий диалог перезапуска;
  - после «Save» поле очищается, ключ не хранится ни в сторе, ни в состоянии после ответа.
- **`strings.ts`:**
  - тексты карточки и `aria-label` — новая секция `providerCard`;
  - `statusBar.providerNotFound` и `providerNotFoundTitle` удалить: они больше не используются.

**Шаги:**
- [ ] Тесты:
  - `StatusBar`: три сегмента при пустом PATH; приглушение по `available`; нет «not found»; клик открывает карточку;
  - `ProviderCard`: варианты Claude — нет CLI / подключён; варианты GLM — нет `claude` / нет ключа / есть ключ / старый хост;
  - «Save» вызывает `providers.setKey` и очищает поле; ошибка хоста показывается; «Remove» вызывает `clearKey`;
  - стор: событие `providers.changed` перечитывает список; ответ старого хоста без `needs` и `family` разбирается;
  - `feed-view`: у GLM-сессии Chat доступен с `family: 'claude'` и версией не ниже 2.1.286; у Codex — нет; у старого хоста без `family` Chat есть только у `claude`.
- [ ] Реализовать.
- [ ] Посмотреть глазами в окне 800×500 (тёмная и светлая темы) с длинной версией, лимитами и открытой карточкой.
- [ ] Коммит `feat(desktop): провайдеры в строке статуса — ярко/тускло и карточка подключения`.

### Задача 6: пилюля провайдера в диалоге новой сессии

**Файлы:** изменить `packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.tsx` и его тест.

**Что даёт:**
- **Пилюля неподключённого провайдера:**
  - `aria-disabled="true"` вместо `disabled`, приглушённая;
  - клик открывает поповер с `ProviderCard` у пилюли и не меняет выбор;
  - `rowLocked` по-прежнему блокирует.
- **После подключения.** Диалог перечитывает `providers.list` по `providers.changed`, и пилюля становится выбираемой.
- **У GLM** список моделей приходит из `providers.list` сам.

**Шаги:**
- [ ] Тесты:
  - клик по тусклой GLM открывает карточку, выбор остаётся прежним;
  - после события GLM выбирается;
  - модели GLM видны в выпадающем списке.
- [ ] Реализовать, коммит `feat(desktop): тусклая пилюля провайдера открывает его карточку`.

### Задача 7: README, CHANGELOG и страж рамки

**Файлы:** `README.md`, `CHANGELOG.md`, `packages/core/test/frame-scan.ts`; проверяет `packages/core/test/frame-check.test.ts`.

**Что даёт:**
- **README:**
  - «Legal boundary» — формулировка из спеки 7 дословно;
  - таблица «Providers» — строка GLM: `as Claude Code (~/.claude/projects)` и `claude on Z.ai's GLM Coding Plan endpoint`;
  - абзац о строке статуса — ярко или тускло, карточка вместо «not found»;
  - новый раздел «GLM (Z.ai)»: подписка, ключ, где он хранится, модели, что не работает (лимиты, канал, картинки у GLM-5.3), предупреждение про `/logout`, совет Z.ai о параллельности.
- **CHANGELOG** — `## Unreleased` над разделом `0.4.0`, с двумя пунктами Added. Номер версии ставится при выпуске — следующий после 0.4.0.
- **README про вид Chat** — требование «Chat view (optional) needs Claude Code 2.1.286 or newer…» и раздел «Chat view»: GLM-сессии тоже открываются в чате.
- **Страж:**
  - правило `адрес Z.ai` (`/api\.z\.ai/`) с исключением строки константы в `providers.ts`;
  - правило `хранилище секретов` (`/secrets\.json/`) с исключением строки в `secrets.ts`;
  - правило `ключ в окружение` (`/ANTHROPIC_AUTH_TOKEN/`) с исключением строки в `sessions-service.ts`;
  - каждое исключение — с `reason` и ссылкой на спеку.

**Шаги:**
- [ ] Обновить README и CHANGELOG.
- [ ] Добавить правила и исключения. `frame-check.test.ts` зелёный, а намеренно вставленный во временный файл `api.z.ai` ловится.
- [ ] Коммит `docs: GLM на подписке Z.ai и подключение провайдеров; страж рамки`.

### Задача 8: E2E

**Файлы:** создать `packages/desktop/e2e/providers-connect.spec.ts` и `packages/desktop/e2e/stub-glm-agent.mjs`.

**Заглушка.** Печатает строку `ARGS:` с аргументами, строку `AUTH:set` или `AUTH:unset` (только наличие `ANTHROPIC_AUTH_TOKEN`) и строку `BASE_URL:` со значением `env.ANTHROPIC_BASE_URL` из файла `--settings`. Значение ключа не печатает никогда.

**Сценарий** (временный `PARLEY_HOME`, `PARLEY_CLAUDE_BIN` на заглушку, `PARLEY_CODEX_BIN=''`):
1. Claude яркий, Codex и GLM тусклые.
2. Клик по GLM открывает карточку с полем. Ввести тестовый ключ `test-glm-key-1234` и сохранить: GLM яркий, в карточке `••••1234`, у `secrets.json` во временном доме права `0600`.
3. GLM-сессия из диалога: в терминале `AUTH:set`, `BASE_URL:https://api.z.ai/api/anthropic`, `--settings …settings-glm.json`, нет флага канала.
4. Вкладка GLM-сессии показывает переключатель Chat | Terminal. Для этого заглушке нужны HTTP-хуки ленты: взять приём из `chat-hooks.spec.ts`, где заглушка шлёт события на адрес из файла `--settings`.
5. «Remove»: GLM тусклый. Новая GLM-сессия — ошибка с текстом «GLM is not connected».
6. Окно 800×500: строка статуса и карточка в пределах окна.

**Шаги:**
- [ ] Написать и прогнать через `heavy.sh` (`pnpm --filter @parley/desktop e2e -- providers-connect`).
- [ ] Коммит `test(e2e): подключение GLM через строку статуса`.

---

## Порядок и полосы

- **A1 — задачи 1–2 (core).** **A2 — задачи 3–4 (core, protocol, host),** после A1.
- **B — задачи 5–6 (окно),** после A2: нужны типы протокола.
- **C — задачи 7–8,** после B.

Каждая полоса работает в своём worktree от `feat/providers-connect` и вливается в неё. Контролёр сам читает диф каждой полосы. После C — полный прогон проверок (`build`, `typecheck`, `lint`, юнит-тесты, E2E) и финальное ревью ветки на Opus.

## Живая проверка

Делает пользователь, на собранной ветке, по спеке, раздел 9. До неё убрать стенд автора: запись `glm` из `~/.parley/providers.json` и `~/.local/bin/claude-glm`.
