# Нормалайзер модели и effort — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** У Claude, GLM и Codex модель и effort выбираются в одном формате Parley, с настоящими уровнями каждой модели. Это работает в диалоге, у агентов через MCP и в идущей сессии Claude/GLM из чата, и глобальные настройки CLI при этом не меняются.

**Architecture:**
- **Каталог.** Модели с уровнями на модель — это данные в core. Для Claude и GLM они берутся из документации, для Codex — из `codex debug models` с запасным встроенным списком. Живой каталог Codex хост пишет в файл Parley `codex-models.json`, и `loadProviders` отдаёт один список окну, хосту и MCP.
- **Выбор.** Один resolver проверяет пару «модель + effort» и для окна, и для MCP. Выбор хранится в карте сессии и уходит в CLI флагами шаблонов при запуске и при resume.
- **Смена в идущей сессии.** Effort меняется ползунком `/effort` + `s` с проверкой по подвалу экрана, модель — перезапуском через resume. Обе смены идут под одним замком на сессию.

**Tech Stack:** TypeScript, pnpm-монорепо (`core`, `protocol`, `host`, `desktop`), zod, vitest + Testing Library, Playwright, node-pty, Electron + React + zustand.

**Spec:** `docs/specs/2026-10-06-model-effort-normalizer-design.md`. Читать вместе с планом.

## Global Constraints

**Протокол и данные:**
- `PROTOCOL_VERSION` остаётся `1`. Протокол меняется только добавлениями, новые поля необязательные. Старое окно с новым хостом и новое окно со старым хостом обязаны работать.
- Токен effort везде один: `/^[a-z][a-z0-9_-]{0,31}$/`. В core это `EFFORT_TOKEN`, в протоколе `EFFORT_TOKEN_RE`, и их `source` совпадает.
- «Default» означает отсутствие поля и флага CLI. Ни окно, ни хост не подставляют уровень сами.
- Отказ «сессия занята» — `conflict` с `data.reason: 'busy'` (`HOST_ERROR_REASONS.busy`, Task 6); своего кода ошибки у него нет.

**Работа с CLI:**
- Parley никогда не печатает в PTY `/model <id>` и `/effort <level>`: интерактивный Claude Code сохраняет их глобальным умолчанием. Effort меняется только ползунком `/effort` + `s`, модель — перезапуском resume.
- Смена в идущей сессии есть только у семейства `claude` (claude, glm). У Codex её в этом подпроекте нет.
- Каталог Codex берётся из `codex debug models`: таймаут 15 с, предел вывода 4 МБ, перепроба при возрасте кэша больше 6 ч. Пробу, как и пробу версий, выключает `PARLEY_SKIP_VERSION_PROBE=1`.
- Ползунок `/effort` должен появиться не дольше чем за 3 с, подтверждение по подвалу — не дольше 2 с.

**Рамка:**
- Хост и окно не читают и не пишут настройки Claude и Codex и не ходят в API провайдеров. Действуют только прежние исключения рамки: `zai-check.ts`, `zai-quota.ts`, `statusline.ts`. `codex-models.json` — свой файл Parley в его доме, а не файл CLI.
- Страж рамки `packages/core/test/frame-scan.ts` ловит в исходниках, даже в комментариях, строки `.claude/settings.json`, `.claude.json`, `.codex/config.toml` и хосты API провайдеров. Вместо них писать «настройки `~/.claude`».
- Страж рамки `packages/core/test/frame-check.test.ts` держит номера строк `packages/core/src/providers.ts` (`:17` и `:236`). Строки выше них вставляют только Task 3 (`236 → 242`) и Task 4 (`242 → 248`) и правят номер в том же коммите. Остальные задачи выше `:248` число строк не меняют (импорт `provider-models.js` — одной строкой). Проверка: `grep -n 'codex/config' packages/core/src/providers.ts`.

**Язык:**
- Комментарии, названия тестов (`describe`/`it`) и сообщения коммитов — по-русски.
- Строки окна — по-английски, в `packages/desktop/src/shared/strings.ts`. Тексты для агентов (MCP, гид) и сообщения ошибок хоста тоже по-английски; строки журнала хоста — по-русски, прямым вызовом `log.warn(…)`/`log.info(…)`/`log.error(…)` (страж `english-text.test.ts`).
- README — по-английски, TODOS и спеки — по-русски.

**Коммиты:**
- Префикс в стиле conventional commits, текст по-русски, последней строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `.omc/project-memory.json` не коммитить никогда, в `git add` — только перечисленные файлы.

**Ветка.** Ветка `feat/model-effort-normalizer` начата от master 0.5.2. Перед задачей чата (Task 13, шаг 1) влить `origin/master`, если в нём уже есть хотфикс 0.5.3 (`fix/glm-chat-model-menu`). Конфликт в `ChatView.tsx` разрешается в пользу нового меню.

**Правки и сборка:**
- Правки «Было → Стало» и «найти → заменить» накладываются по тексту «Было»: каждый такой фрагмент встречается в своём файле ровно один раз на момент задачи. Номера строк в **Files** — по исходной ветке (`2856d61`); после предыдущих задач места сдвигаются.
- Тесты хоста и окна берут `@parley/core` и `@parley/protocol` из `dist`: после правок core или protocol и перед их тестами — `pnpm --filter @parley/core build && pnpm --filter @parley/protocol build`.
- Каждая задача оставляет все пакеты зелёными. Новые методы протокола (`sessions.setEffort`, `sessions.setModel`) появляются в одном коммите с обработчиком хоста (Task 10, Task 11): `server.test.ts` хоста сверяет `hello.methods` с ключами `METHODS`.

**Команды:**
- тесты пакета: `pnpm --filter @parley/<pkg> exec vitest run <путь от пакета>`;
- полный прогон: `pnpm typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 --no-bail run test --retry=1`;
- известные флейки хоста под нагрузкой — `activity-terminal`, `works-service`: красный тест, которого задача не трогала, сверять с прогоном на коммите до неё.

## Решения при сборке

1. **Схемы смены — вместе с обработчиками.** `sessions.setEffort` и `sessions.setModel` (схемы, результаты, тесты протокола) перенесены из Task 6 в начало Task 10 и Task 11. Протокол и регистрация в хосте попадают в один коммит, и `server.test.ts` хоста не краснеет между задачами. Оба метода — в `WORKS_GATED_METHODS`, как `sessions.setMode`.
2. **«Занят» — `conflict` с причиной `busy`.** Кода `busy` в `ErrorCode` нет: хост бросает `HostError('conflict', текст, { reason: HOST_ERROR_REASONS.busy })`, а причину `busy` заводит Task 6. Окно (Task 13) по `conflict` с `reason: 'busy'` показывает свой текст «сессия занята», иной `conflict` — общий текст по коду.
3. **Один каталог Codex для окна, хоста и MCP.** После удачной пробы хост (Task 8) атомарно пишет `codex-models.json`, если список отличается от файла, и шлёт `providers.changed`. Сбой перепробы файл не трогает. Файл читает `loadProviders` (Task 5). У `providers.list` особого случая для codex нет: он только зовёт `refreshIfStale()`. `withCodexCatalog` и 4-й параметр `resolveModelChoice` убраны.
4. **Подписи Codex — `display_name` самого Codex.** Запасной `CODEX_MODELS` (Task 1) подписан `GPT-6.1-Sol`, `GPT-6-Astra`, `GPT-6-Sol`, `GPT-6-Luna`, `GPT-5.6-Sol`, `GPT-5.6-Terra`, `GPT-5.6-Luna`: диалог выглядит одинаково и с живым каталогом, и без него. Так же подписаны фикстуры окна, E2E и пример README.
5. **Номер строки в страже рамки** (`frame-check.test.ts`) меняют только Task 3 (`236 → 242`) и Task 4 (`242 → 248`).
6. **Экспорты core — до первого потребителя:** Task 1 — `EffortOption`, `ModelOption`, `effortLabel`, `CLAUDE_EFFORTS`, `LEGACY_EFFORTS`; Task 2 — `EFFORT_TOKEN`, `effortsFor`, `resolveModelEffort`, `ModelEffortChoice`, `ModelEffortResolution`; Task 5 — `codexModelsFile`, `MODEL_LABEL_MAX`, `EFFORT_DESCRIPTION_MAX`. `EFFORT_LEVELS` помечается `@deprecated` в Task 2 и удаляется в Task 7.
7. **Resolver отбрасывает и модель, если в шаблоне нет `{model}`**, как effort без `{effort}`. MCP (Task 7) берёт выбор resolver как есть. Хост (Task 9) у провайдера без `{model}` пишет в карту «Default». `setModel` (Task 11) на такую модель отвечает `bad_request`.
8. **Пустой список уровней — `null`** и в `effortsFor` core (Task 2), и в `effortChoices` окна (Task 12): поля effort нет, и явный уровень не принимается.
9. **«Агент у приглашения» — `idle` или `unseen`**, как у доставки писем. Так считают и хост (`atPrompt`), и окно: оно гасит пункты только при `working`/`blocked`. `working` с фоновыми задачами держит и модель, и effort.
10. **Окно.** У `choiceMenu` есть `modelLabel` — подпись кнопки: модель из ленты, иначе модель из карты подписью каталога. `ChatView` получает `storedModel`/`storedEffort` от `TerminalBody`. Диалог сверяет выбор строки со снимком провайдеров (`chosenModel`, `chosenEffort`).
11. **Один замок смены на сессию** — `createSwitchLock` и `SessionsService.exclusive` (Task 10). Через него идут `sessions.setEffort` и `setModel` (Task 11). Вторая смена той же сессии получает `busy` до первой клавиши.
12. **Защиты `setEffort` сверх спеки 5.7** (Task 10): `busy` без единого нажатия, если ползунок уже открыт, в поле ввода черновик, с запуска процесса не было ни одного хука (Enter мог бы ответить на вопрос доверия к папке — так же страхуется `pty.send`) или будильник печатает указатель; на время смены хост держит черновик хоста, и будильник не вклинится в клавиши.
13. **`setModel`** (Task 11) работает только у семейства `claude`. Та же модель — ни записи, ни перезапуска (`restarted: false`).
14. **Внешний ввод каталога:** `slug` проверяется правилом id модели core (`/^[^\s-]\S*$/`, не длиннее 200), повтор `slug` выбрасывается; `display_name` и описания уровней обрезаются до 100 и 300 знаков (`MODEL_LABEL_MAX`, `EFFORT_DESCRIPTION_MAX`) и в разборе хоста (Task 8), и при чтении файла (Task 5); файл с моделью не той формы core не читает целиком.
15. **Журнал хоста — прямым вызовом `log.warn(…)`.** Страж английских текстов не узнаёт строку журнала в `log?.warn(…)`.
16. **Тесты до появления схем смены.** Task 8 и Task 9 сверяются с явными списками и со схемой `sessions.create`. Тест «окну уходят списки…» в `providers.test.ts` хоста обновляет только Task 1.
17. **Стаб E2E** (Task 15) уже отвечает алгоритму Task 10: `/effort` и `\r` раздельно, строка `s for this session only`, стрелки `\x1b[D`/`\x1b[C`, `s`, подвал `<знак> <уровень> · /effort`; черновик хост считает по вводу человека (`PtyHandle.hasDraft()`), а не по экрану, а `hookedSince` даёт хук `StubReady` на старте. Ответ стаба на `codex debug models` — в форме настоящего вывода.
18. **Приёмка** (Task 16) проверяет критерий 6 по argv процесса после Resume. Что Claude Code применяет `--effort` при resume, — факт 6 раздела 3 спеки, проверенный на заглушке API.
19. **`parseMap`** отбрасывает испорченный effort молча (спека 5.5): логгера у core нет, а следующая запись карты её исправит.

## Review Focus

1. **Черновик или открытый ползунок.** Если в поле терминала есть неотправленный текст или ползунок `/effort` уже открыт, хост ничего не печатает и не жмёт Enter, а отвечает `conflict` (причина `busy`). Иначе черновик ушёл бы агенту или уровень сохранился бы умолчанием человека. Тест — в Task 10.
2. **Каталог Codex — внешний ввод.** `slug` с дефисом в начале, с пробелом или длиннее 200 знаков — модель выбрасывается (иначе станет флагом `--model`); `display_name` и `description` обрезаются (подпись ≤ 100, описание ≤ 300 знаков); незнакомый валидный уровень (`turbo`) показывается как «Turbo» и передаётся как есть. Тесты — в Task 8 (разбор `codex debug models`) и Task 5 (чтение `codex-models.json`: файл с такой моделью core не читает целиком).
3. **Два переключения подряд по одной сессии** — двойной клик или `setEffort` во время `setModel`. Второе получает `conflict` (`busy`), клавиши не перемешиваются, перезапуск один. Тесты — в Task 10 и Task 11 (общий замок на сессию).
4. **Каталог обновился при открытом диалоге** (`providers.changed`), и выбранной модели или уровня больше нет. Диалог возвращает поле в «Default», не падает и не отправляет исчезнувшее значение. Тест — в Task 12.
5. **Выбор той же модели, что уже стоит.** Перезапуска нет (`restarted: false`), карта не меняется, а отмеченный пункт меню не зовёт `sessions.setModel`. Тесты — в Task 11 и Task 13.

## Порядок задач

```
Task 0   этап 0: живые проверки CLI
   │
Task 1 → Task 2 → Task 3 → Task 4 → Task 5            core: каталог, resolver, providers.json, resume, codex-models.json
                                       │
                                 Task 6 → Task 7      protocol; MCP и гид
                                       │
                 Task 8 → Task 9 → Task 10 → Task 11  host: каталог Codex, sessions.create, setEffort, setModel
                                                │
                 Task 12 → Task 13 → Task 14 → Task 15  окно: диалог, чат, карточка; E2E и документы
                                                │
                                            Task 16   полный прогон и живая приёмка
```

Слои идут по зависимостям сборки (core → protocol → host → окно): каждая задача опирается на `dist` предыдущих и оставляет все пакеты зелёными, чат (Task 13) ждёт обоих методов хоста (Task 10–11), а E2E (Task 15) — всего хоста и окна.

---

### Task 0: Этап 0 — четыре живые проверки CLI (раздел 9 спеки)

Исследование, а не TDD: итог — дополнение к разделу 3 спеки и, если факт расходится с допущением, правка затронутой задачи плана до её начала. Скрипты живут во временной папке и не коммитятся.

**Files:**
- Create (не коммитится): `$TMPDIR/parley-stage0/slider.mjs`, `$TMPDIR/parley-stage0/glm-flash.mjs`
- Modify: `docs/specs/2026-10-06-model-effort-normalizer-design.md` — раздел 3, «Добавление от <дата>»

**Interfaces:**
- Consumes: ничего из плана; установленные `claude` (2.1.289+) и `codex` (0.160+), `node-pty` из `packages/host`, собранный `packages/core/dist`.
- Produces: факты для Task 10 (подпись подвала `xhigh`, поведение ползунка в GLM), для Task 8 (поведение `codex debug models` без сети и без входа), для Task 1 (уровни `glm-5.3-flash[1m]`) и для resolver в Task 2 (что Codex делает с неподдерживаемым уровнем).

- [ ] **Step 1: Подвал `xhigh` и ползунок в GLM-режиме (без ключей, заглушка API)**

Создать `$TMPDIR/parley-stage0/slider.mjs`:

```js
// Заглушка Anthropic API (400 на всё) + интерактивный Claude Code в PTY: что пишет подвал
// после `s` на ползунке /effort — у Claude и в GLM-режиме, как его запускает Parley.
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, realpathSync, existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pty = createRequire(path.resolve('packages/host/package.json'))('node-pty');
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'stub' } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '\n').replace(/\x1b[\]P^_][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b./g, '');
const footers = (s) => [...new Set(clean(s).split('\n').map((l) => l.trim()).filter((l) => /·\s*\/effort/.test(l)))];
const LEFT = '\x1b[D', RIGHT = '\x1b[C';
const dirs = [];

async function session(name, extraEnv, args, keys) {
  const cfg = mkdtempSync(path.join(os.tmpdir(), 'parley-stage0-cfg-'));
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'parley-stage0-cwd-')));
  dirs.push(cfg, cwd);
  writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, theme: 'dark', numStartups: 5,
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }));
  const env = {
    HOME: os.homedir(), PATH: process.env.PATH, USER: process.env.USER, LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
    CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: 'stub-token',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', ...extraEnv,
  };
  let out = '';
  const term = pty.spawn('claude', args, { name: 'xterm-256color', cols: 140, rows: 45, cwd, env });
  term.onData((d) => { out += d; });
  await sleep(10_000);
  console.log(`\n== ${name}\nстарт: ${JSON.stringify(footers(out))}`);
  const mark = out.length;
  for (const k of keys) { term.write(k); await sleep(700); }
  await sleep(3_000);
  console.log(`после ползунка: ${JSON.stringify(footers(out.slice(mark)))}`);
  const settings = path.join(cfg, 'settings.json');
  console.log(`settings.json: ${existsSync(settings) ? readFileSync(settings, 'utf8') : '(нет файла)'}`);
  term.write('\x03'); await sleep(300); term.write('\x03'); term.kill();
}

const toXhigh = ['/effort', '\r', LEFT, LEFT, LEFT, LEFT, LEFT, LEFT, RIGHT, RIGHT, RIGHT, 's'];
await session('Claude, старт с --effort xhigh, затем ползунок → xhigh', {}, ['--model', 'claude-opus-5-5', '--effort', 'xhigh'], toXhigh);
await session('GLM как у Parley, ползунок → xhigh', {
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]',
}, ['--model', 'glm-5.3[1m]', '--effort', 'high'], toXhigh);
server.close();
for (const d of dirs) rmSync(d, { recursive: true, force: true });
process.exit(0);
```

Run (из корня репозитория): `mkdir -p "$TMPDIR/parley-stage0" && node "$TMPDIR/parley-stage0/slider.mjs"`
Expected: обе сессии печатают строку подвала вида `<знак> xhigh · /effort` после ползунка, `settings.json: (нет файла)`. Записать точный текст строки `xhigh`. Если подвал для `xhigh` не совпадает с регэкспом `/(?:^|\s)([a-z]+)\s*·\s*\/effort\b/` — поправить регэксп в Task 10 до её начала.

- [ ] **Step 2: Учитывает ли Z.ai effort у `glm-5.3-flash` (ключ пользователя — только с его явного «да» в чате)**

Спросить пользователя: «Два коротких запроса к Z.ai вашим сохранённым ключом (glm-5.3-flash, effort low и max) — можно?». Без согласия шаг пропустить и записать «не проверено». С согласием: `pnpm --filter @parley/core build`, затем создать `$TMPDIR/parley-stage0/glm-flash.mjs`:

```js
// Ключ — из secrets.json Parley, только в env дочернего процесса; в вывод не попадает.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { readSecret } = await import(path.resolve('packages/core/dist/secrets.js'));
const key = await readSecret('zai');
if (key === null) { console.log('ключа Z.ai нет'); process.exit(1); }
const PROMPT = 'How many prime numbers are there between 1 and 300? Reply with only the number.';
for (const effort of ['low', 'max']) {
  const cfg = mkdtempSync(path.join(os.tmpdir(), 'parley-stage0-glm-'));
  const env = {
    HOME: os.homedir(), PATH: process.env.PATH, USER: process.env.USER, LANG: 'en_US.UTF-8', CLAUDE_CONFIG_DIR: cfg,
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
  };
  const out = await new Promise((resolve) => {
    const child = spawn('claude', ['-p', '--model', 'glm-5.3-flash', '--effort', effort, '--output-format', 'json', PROMPT], { cwd: cfg, env });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', () => resolve(stdout));
  });
  let r = null;
  try { r = JSON.parse(out); } catch {}
  console.log(`effort=${effort} answer=${JSON.stringify(r?.result)} output_tokens=${r?.usage?.output_tokens} error=${r?.is_error}`);
  rmSync(cfg, { recursive: true, force: true });
}
```

Run: `node "$TMPDIR/parley-stage0/glm-flash.mjs"`
Expected: две строки с `output_tokens`. Заметная разница (у glm-5.3 было 11 против 309) — уровни у Flash остаются; разницы нет — в Task 1 у `glm-5.3-flash[1m]` поставить `efforts: null` и записать причину в комментарий каталога.

- [ ] **Step 3: `codex debug models` без сети и без входа**

```bash
start=$(date +%s); HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 codex debug models > "$TMPDIR/parley-stage0/offline.json" 2> "$TMPDIR/parley-stage0/offline.err"; echo "offline exit $? in $(( $(date +%s) - start ))s, bytes $(wc -c < "$TMPDIR/parley-stage0/offline.json")"; head -c 300 "$TMPDIR/parley-stage0/offline.err"
```

```bash
nologin=$(mktemp -d); start=$(date +%s); CODEX_HOME="$nologin" codex debug models > "$TMPDIR/parley-stage0/nologin.json" 2> "$TMPDIR/parley-stage0/nologin.err"; echo "nologin exit $? in $(( $(date +%s) - start ))s, bytes $(wc -c < "$TMPDIR/parley-stage0/nologin.json")"; head -c 300 "$TMPDIR/parley-stage0/nologin.err"; rm -rf "$nologin"
```

Expected: записать код выхода, время и есть ли JSON. Если без сети команда отдаёт кэш (JSON, код 0) — так и записать: каталог честный, но может быть старым. Если ждёт дольше 15 с — таймаут пробы из Task 8 остаётся 15 с, а запись о долгом ожидании идёт в спеку.

- [ ] **Step 4: Codex с уровнем, которого у модели нет (квота пользователя — только с его явного «да» в чате)**

Спросить: «Один короткий запрос к Codex (`gpt-6-luna` с effort `ultra`, которого у неё нет) — можно?». С согласием:

```bash
dir=$(mktemp -d); cd "$dir" && codex exec --skip-git-repo-check -m gpt-6-luna -c 'model_reasoning_effort="ultra"' "Reply with OK" > out.txt 2> err.txt; echo "exit $?"; tail -5 out.txt; tail -5 err.txt; cd - >/dev/null; rm -rf "$dir"
```

Expected: ошибка с текстом или ответ OK (Codex опустил уровень). Ошибка — значит resolver правильно не допускает таких пар (уровни «Default» — пересечение); ответ OK — записать, что Codex опускает уровень сам.

- [ ] **Step 5: Записать факты в спеку и закоммитить**

Добавить в конец раздела 3 спеки блок:

```markdown
**Добавление от <дата> (этап 0 плана).**
14. Подвал `xhigh`: `<точная строка из шага 1>`; в GLM-режиме ползунок `/effort` + `s` ведёт себя так же (`<строка>`), `settings.json` не создаётся.
15. Z.ai и effort у `glm-5.3-flash`: <low N токенов, max M токенов | не проверено — нет согласия>.
16. `codex debug models` без сети: <код, время, JSON да/нет>; без входа: <код, время, текст ошибки>.
17. Codex с `gpt-6-luna` и `ultra`: <ошибка «…» | ответ без ошибки>.
```

Run: `git add docs/specs/2026-10-06-model-effort-normalizer-design.md && git commit -m "docs(spec): этап 0 нормалайзера — подвал xhigh, GLM Flash, каталог Codex без сети" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`
Expected: один коммит; временная папка `$TMPDIR/parley-stage0` удалена (`rm -rf "$TMPDIR/parley-stage0"`).

---

### Task 1: Каталог уровней effort у моделей (спека 5.1)

**Files:**
- Modify: `packages/core/src/provider-models.ts` (весь файл, 1–80)
- Modify: `packages/core/src/providers.ts:89-96` (`ProviderEntry.models`), `:489-501` (`selectableModels`)
- Modify: `packages/core/src/index.ts:77`
- Test: `packages/core/src/providers.test.ts` (`:24`, `:452-479`, `:519-526`, `:784-789`)
- Test: `packages/host/src/methods/providers.test.ts` (`:32`, `:147-167`) — без этой правки хост краснеет от новых данных каталога

**Interfaces:**
- Consumes: ничего нового.
- Produces (`packages/core/src/provider-models.ts`, всё — и из `@parley/core`):
  - `export interface EffortOption { id: string; label: string; description?: string }`
  - `export interface ModelOption { id: string; label: string; efforts?: EffortOption[] | null }`
  - `export function effortLabel(id: string): string`
  - `export const CLAUDE_EFFORTS: EffortOption[]` — `low, medium, high, xhigh, max`, без описаний
  - `export const LEGACY_EFFORTS: EffortOption[]` — `low, medium, high`
  - `CLAUDE_MODELS`: у всех `efforts: CLAUDE_EFFORTS`, у `haiku` — `efforts: null`; `GLM_MODELS`: обе с `CLAUDE_EFFORTS`; `CODEX_MODELS`: 7 видимых моделей 2026-10-06 в порядке `priority`, с описаниями уровней из каталога и подписями `display_name` самого Codex: `GPT-6.1-Sol`, `GPT-6-Astra`, `GPT-6-Sol`, `GPT-6-Luna`, `GPT-5.6-Sol`, `GPT-5.6-Terra`, `GPT-5.6-Luna`.
  - `selectableModels(entry): ModelOption[] | null` (`providers.ts`) отдаёт копию и уровней тоже.

- [ ] **Step 1: Написать падающие тесты каталога**

Четыре замены в `packages/core/src/providers.test.ts`.

`packages/core/src/providers.test.ts` — найти:

```ts
import { overrideValue, overrideVariable } from './work/find-binary.js';
```

заменить на:

```ts
import { CLAUDE_EFFORTS, LEGACY_EFFORTS, effortLabel } from './provider-models.js';
import { overrideValue, overrideVariable } from './work/find-binary.js';
```

`packages/core/src/providers.test.ts` — найти:

```ts
  describe('списки моделей встроенных провайдеров (открытая документация, проверено 2026-09-29)', () => {
    // Литералы, а не импорт констант: тест держит таблицу из отчёта куска 3b. Порядок — как в источнике.
    const CLAUDE = [
      { id: 'best', label: 'Best' },
      { id: 'fable', label: 'Fable' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'opus', label: 'Opus' },
      { id: 'haiku', label: 'Haiku' },
      { id: 'sonnet[1m]', label: 'Sonnet (1M context)' },
      { id: 'opus[1m]', label: 'Opus (1M context)' },
      { id: 'opusplan', label: 'Opus Plan' },
      { id: 'opusplan[1m]', label: 'Opus Plan (1M context)' },
    ];
    const CODEX = [
      { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
    ];

    it('встроенные списки моделей совпадают с подтверждёнными таблицами', () => {
      expect(selectableModels(PROVIDERS.claude)).toEqual(CLAUDE);
      expect(selectableModels(PROVIDERS.codex)).toEqual(CODEX);
      expect(selectableModels(PROVIDERS.glm)).toEqual([
        { id: 'glm-5.3[1m]', label: 'GLM-5.3 (1M context)' },
        { id: 'glm-5.3-flash[1m]', label: 'GLM-5.3 Flash (1M context)' },
      ]);
    });
```

заменить на:

```ts
  describe('каталог моделей встроенных провайдеров (спека нормалайзера модели и effort, 5.1)', () => {
    // Литералы, а не импорт констант: тест держит таблицы источников. Порядок — как в источнике.
    /** Уровни Claude Code (code.claude.com/docs/en/model-config, 2026-10-06), без описаний. */
    const CLAUDE_LEVELS = [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'Extra high' },
      { id: 'max', label: 'Max' },
    ];
    const CLAUDE = [
      { id: 'best', label: 'Best', efforts: CLAUDE_LEVELS },
      { id: 'fable', label: 'Fable', efforts: CLAUDE_LEVELS },
      { id: 'sonnet', label: 'Sonnet', efforts: CLAUDE_LEVELS },
      { id: 'opus', label: 'Opus', efforts: CLAUDE_LEVELS },
      { id: 'haiku', label: 'Haiku', efforts: null },
      { id: 'sonnet[1m]', label: 'Sonnet (1M context)', efforts: CLAUDE_LEVELS },
      { id: 'opus[1m]', label: 'Opus (1M context)', efforts: CLAUDE_LEVELS },
      { id: 'opusplan', label: 'Opus Plan', efforts: CLAUDE_LEVELS },
      { id: 'opusplan[1m]', label: 'Opus Plan (1M context)', efforts: CLAUDE_LEVELS },
    ];
    /** Уровни Codex с описаниями — снимок `codex debug models` 2026-10-06 (спека, раздел 3, п. 11–12). */
    const CODEX_LEVELS = [
      { id: 'low', label: 'Low', description: 'Fast responses with lighter reasoning' },
      { id: 'medium', label: 'Medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { id: 'high', label: 'High', description: 'Greater reasoning depth for complex problems' },
      { id: 'xhigh', label: 'Extra high', description: 'Extra high reasoning depth for complex problems' },
      { id: 'max', label: 'Max', description: 'Maximum reasoning depth for the hardest problems' },
    ];
    const CODEX_ULTRA_LEVELS = [
      ...CODEX_LEVELS,
      { id: 'ultra', label: 'Ultra', description: 'Maximum reasoning with automatic task delegation' },
    ];
    /** Видимые модели каталога Codex в порядке `priority`, подписи — `display_name`; у двух Luna нет Ultra. */
    const CODEX = [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: CODEX_ULTRA_LEVELS },
      { id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: CODEX_ULTRA_LEVELS },
      { id: 'gpt-6-sol', label: 'GPT-6-Sol', efforts: CODEX_ULTRA_LEVELS },
      { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: CODEX_LEVELS },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: CODEX_ULTRA_LEVELS },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', efforts: CODEX_ULTRA_LEVELS },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: CODEX_LEVELS },
    ];

    it('встроенные списки совпадают с таблицами источников: модели, подписи и уровни', () => {
      expect(selectableModels(PROVIDERS.claude)).toEqual(CLAUDE);
      expect(selectableModels(PROVIDERS.codex)).toEqual(CODEX);
      expect(selectableModels(PROVIDERS.glm)).toEqual([
        { id: 'glm-5.3[1m]', label: 'GLM-5.3 (1M context)', efforts: CLAUDE_LEVELS },
        { id: 'glm-5.3-flash[1m]', label: 'GLM-5.3 Flash (1M context)', efforts: CLAUDE_LEVELS },
      ]);
    });

    it('уровни Claude Code и прежние три уровня — общие константы каталога', () => {
      expect(CLAUDE_EFFORTS).toEqual(CLAUDE_LEVELS);
      expect(LEGACY_EFFORTS).toEqual(CLAUDE_LEVELS.slice(0, 3));
    });

    it('effortLabel: подписи по таблице спеки, незнакомый id — с заглавной буквы', () => {
      expect(['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'none'].map(effortLabel)).toEqual([
        'Low',
        'Medium',
        'High',
        'Extra high',
        'Max',
        'Ultra',
        'Minimal',
        'None',
      ]);
      expect(effortLabel('turbo')).toBe('Turbo');
      expect(effortLabel('x_2')).toBe('X_2');
      // Имя свойства объекта — такой же незнакомый id, а не подпись из прототипа.
      expect(effortLabel('constructor')).toBe('Constructor');
    });
```

`packages/core/src/providers.test.ts` — найти:

```ts
    it('окну отдаётся копия: правка ответа встроенный реестр не меняет', () => {
      const list = selectableModels(PROVIDERS.claude);
      if (list === null || list[0] === undefined) throw new Error('у claude нет списка');
      list[0].label = 'испорчено';
      list.pop();

      expect(selectableModels(PROVIDERS.claude)).toEqual(CLAUDE);
    });
```

заменить на:

```ts
    it('окну отдаётся копия вместе с уровнями: правка ответа встроенный реестр не меняет', () => {
      const list = selectableModels(PROVIDERS.claude);
      const levels = list?.[0]?.efforts;
      if (list === null || list[0] === undefined || levels === undefined || levels === null || levels[0] === undefined) {
        throw new Error('у claude нет списка с уровнями');
      }
      list[0].label = 'испорчено';
      levels[0].label = 'испорчено';
      levels.pop();
      list.pop();

      expect(selectableModels(PROVIDERS.claude)).toEqual(CLAUDE);
      // Массив уровней у моделей каталога общий: правка копии не должна дойти и до него.
      expect(CLAUDE_EFFORTS).toEqual(CLAUDE_LEVELS);
    });
```

`packages/core/src/providers.test.ts` — найти:

```ts
      expect(selectableModels(PROVIDERS.codex)?.map((model) => model.id)).toEqual([
        'gpt-6-astra',
        'gpt-6.1-sol',
        'gpt-6-sol',
        'gpt-6-luna',
      ]);
```

заменить на:

```ts
      expect(selectableModels(PROVIDERS.codex)?.map((model) => model.id)).toEqual([
        'gpt-6.1-sol',
        'gpt-6-astra',
        'gpt-6-sol',
        'gpt-6-luna',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
      ]);
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter @parley/core exec vitest run src/providers.test.ts`
Expected: `Tests  5 failed | 83 passed (88)`:
- «встроенные списки совпадают с таблицами источников…» — `expected [ { id: 'best', label: 'Best' }, …(8) ] to deeply equal [ { id: 'best', …(2) }, …(8) ]`;
- «уровни Claude Code и прежние три уровня…» — `expected undefined to deeply equal …`;
- «effortLabel: …» — `TypeError: undefined is not a function`;
- «окну отдаётся копия вместе с уровнями…» — `Error: у claude нет списка с уровнями`;
- «список из пар id и label заменяет встроенный целиком…» — порядок id Codex.

- [ ] **Step 3: Каталог**

Заменить `packages/core/src/provider-models.ts` целиком:

```ts
/**
 * Каталог моделей для окна и MCP: значение для флага `--model`, подпись для человека и уровни effort
 * каждой модели. Списки Claude Code и GLM взяты из открытой документации провайдера. Каталог Codex
 * даёт сам CLI: хост спрашивает его командой `codex debug models` (спека нормалайзера модели и effort,
 * 5.2), а `CODEX_MODELS` здесь — запасной снимок того же вывода на случай, когда проба не удалась.
 * Порядок — как в источнике.
 *
 * «По умолчанию» в списке нет. Это не модель, а отсутствие выбора: без флага CLI берёт свою модель
 * по умолчанию. Документация Claude Code сама называет `default` особым значением, которое лишь
 * сбрасывает выбор, а не именем модели, — окно показывает «по умолчанию» отдельной строкой и
 * ничего не передаёт хосту. Так же и с effort: «Default» — это отсутствие флага, а не уровень.
 *
 * Как обновлять. Вышла модель, которой в списке ещё нет, — дописать её сюда по источнику, источник и
 * дату проверки поправить тут же. Запасной список Codex снимают заново с вывода `codex debug models`:
 * список там меняется за дни. До обновления харнесса человек дополняет список у себя в
 * `providers.json` (поле `models`, уровни — полем `efforts`). Полные имена версий (`claude-opus-5-5`,
 * `claude-fable-5`) в список Claude Code не входят: алиасы сами указывают на актуальную версию и не
 * стареют, а закреплённую версию человек добавит записью в `providers.json`.
 */

/** Уровень effort модели: `id` — значение флага, `label` — подпись для человека. */
export interface EffortOption {
  /** Значение флага: `--effort <id>` / `model_reasoning_effort="<id>"`. */
  id: string;
  label: string;
  description?: string;
}

/** Модель в списке окна: `id` — значение `--model`, `label` — подпись для человека. */
export interface ModelOption {
  id: string;
  label: string;
  /**
   * Уровни этой модели по порядку. `null` — у модели effort нет (Haiku).
   * Поля нет — каталог не знает (свой список в providers.json): действует правило провайдера.
   */
  efforts?: EffortOption[] | null;
}

/** Подписи уровней (спека нормалайзера, 5.1). `Map`, а не объект: id вроде `constructor` — не ключ прототипа. */
const EFFORT_LABELS: ReadonlyMap<string, string> = new Map([
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high'],
  ['max', 'Max'],
  ['ultra', 'Ultra'],
  ['minimal', 'Minimal'],
  ['none', 'None'],
]);

/** Подпись уровня для человека: известный — по таблице, незнакомый id — с заглавной буквы. */
export function effortLabel(id: string): string {
  return EFFORT_LABELS.get(id) ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

/** Уровни без описаний — с подписями по `effortLabel`. */
const levels = (...ids: string[]): EffortOption[] => ids.map((id) => ({ id, label: effortLabel(id) }));

/**
 * Уровни Claude Code — `--effort` принимает `low, medium, high, xhigh, max` (code.claude.com/docs/en/model-config,
 * проверено 2026-10-06). Описаний у них нет.
 */
export const CLAUDE_EFFORTS: EffortOption[] = levels('low', 'medium', 'high', 'xhigh', 'max');

/**
 * Прежние три уровня: правило провайдера, чей каталог уровней не знает, — свой список моделей в
 * `providers.json` без `efforts` или провайдер без списка вовсе (`effortsFor`).
 */
export const LEGACY_EFFORTS: EffortOption[] = levels('low', 'medium', 'high');

/**
 * Claude Code. Источник — https://code.claude.com/docs/en/model-config (проверено 2026-09-29,
 * 17:33 GMT): таблица «Model aliases» — алиасы, которые принимают `--model` и настройка `model`, и
 * раздел про `opusplan`, который называет и `opusplan[1m]` (для него прямо сказано: флаг `--model`
 * или настройка `model`). Порядок таблицы сохранён, `opusplan[1m]` стоит следом за `opusplan`,
 * особое значение `default` пропущено (см. выше). Строка `--model` в
 * https://code.claude.com/docs/en/cli-reference называет из них `sonnet`, `opus`, `haiku` и
 * `fable`. Подписи — по имени алиаса; версию, на которую он сейчас указывает, они не называют:
 * она зависит от провайдера и от версии Claude Code. `fable[1m]` в таблице нет: документация
 * называет его лишь значением, на которое переписывает старый сохранённый выбор, и сама говорит,
 * что у Fable окно 1M и так есть, а `[1m]` выбирать не нужно.
 *
 * Уровни — по той же странице (проверено 2026-10-06): у всех алиасов, кроме `haiku`, пять уровней
 * `CLAUDE_EFFORTS`; уровень выше поддерживаемого моделью Claude Code сам опускает до ближайшего ниже. У
 * Haiku effort нет: `--effort` Claude Code молча отбрасывает (спека нормалайзера, раздел 3, п. 1–2).
 */
export const CLAUDE_MODELS: readonly ModelOption[] = [
  { id: 'best', label: 'Best', efforts: CLAUDE_EFFORTS },
  { id: 'fable', label: 'Fable', efforts: CLAUDE_EFFORTS },
  { id: 'sonnet', label: 'Sonnet', efforts: CLAUDE_EFFORTS },
  { id: 'opus', label: 'Opus', efforts: CLAUDE_EFFORTS },
  { id: 'haiku', label: 'Haiku', efforts: null },
  { id: 'sonnet[1m]', label: 'Sonnet (1M context)', efforts: CLAUDE_EFFORTS },
  { id: 'opus[1m]', label: 'Opus (1M context)', efforts: CLAUDE_EFFORTS },
  { id: 'opusplan', label: 'Opus Plan', efforts: CLAUDE_EFFORTS },
  { id: 'opusplan[1m]', label: 'Opus Plan (1M context)', efforts: CLAUDE_EFFORTS },
];

/** Уровень Codex: описание — из каталога самого CLI, как есть. */
const codexLevel = (id: string, description: string): EffortOption => ({
  id,
  label: effortLabel(id),
  description,
});

const CODEX_EFFORTS: EffortOption[] = [
  codexLevel('low', 'Fast responses with lighter reasoning'),
  codexLevel('medium', 'Balances speed and reasoning depth for everyday tasks'),
  codexLevel('high', 'Greater reasoning depth for complex problems'),
  codexLevel('xhigh', 'Extra high reasoning depth for complex problems'),
  codexLevel('max', 'Maximum reasoning depth for the hardest problems'),
];

const CODEX_ULTRA_EFFORTS: EffortOption[] = [
  ...CODEX_EFFORTS,
  codexLevel('ultra', 'Maximum reasoning with automatic task delegation'),
];

/**
 * Codex CLI — запасной список. Живой каталог аккаунта хост берёт у самого CLI (`codex debug models`) и,
 * пока проба удаётся, отдаёт окну его. Здесь — снимок того же вывода от 2026-10-06 (Codex 0.160.0;
 * спека нормалайзера, раздел 3, п. 11–12): только видимые модели (`visibility: "list"`), в порядке
 * `priority`, с уровнями (`supported_reasoning_levels`) и их описаниями. Скрытые (`gpt-5.5` и служебные)
 * в список не входят. Подписи — `display_name` каталога («GPT-6.1-Sol»): окно выглядит одинаково и с живым
 * каталогом, и без него.
 */
export const CODEX_MODELS: readonly ModelOption[] = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: CODEX_ULTRA_EFFORTS },
  { id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: CODEX_ULTRA_EFFORTS },
  { id: 'gpt-6-sol', label: 'GPT-6-Sol', efforts: CODEX_ULTRA_EFFORTS },
  { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: CODEX_EFFORTS },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: CODEX_ULTRA_EFFORTS },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', efforts: CODEX_ULTRA_EFFORTS },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: CODEX_EFFORTS },
];

/**
 * Official Z.ai Claude Code integration (2026-10-03): https://docs.z.ai/devpack/tool/claude.
 * Уровни — пять уровней Claude Code: GLM-сессию ведёт сам Claude Code, он шлёт Z.ai effort любого уровня
 * вплоть до `max`, а Z.ai его учитывает (спека нормалайзера, раздел 3, п. 8–9).
 */
export const GLM_MODELS: readonly ModelOption[] = [
  { id: 'glm-5.3[1m]', label: 'GLM-5.3 (1M context)', efforts: CLAUDE_EFFORTS },
  { id: 'glm-5.3-flash[1m]', label: 'GLM-5.3 Flash (1M context)', efforts: CLAUDE_EFFORTS },
];
```

Если Task 0, шаг 2 записал, что Z.ai не учитывает effort у `glm-5.3-flash`, то в `GLM_MODELS` у `glm-5.3-flash[1m]` поставить `efforts: null` и дописать причину в комментарий над списком. В тесте шага 1 у этой строки ждать `efforts: null`. Уровни «Default» у GLM от этого не меняются: пересечение тогда считается по одной `glm-5.3[1m]`.

Затем две правки в `packages/core/src/providers.ts` и одна в `index.ts`.

`packages/core/src/providers.ts` — найти:

```ts
  /**
   * Модели, из которых окно предлагает выбрать (`selectableModels`): значение `--model` и подпись.
   * У встроенных `claude`, `codex` и `glm` список взят из открытой документации (`provider-models.ts`), у
   * прочих — из `providers.json`.
```

заменить на:

```ts
  /**
   * Модели, из которых окно предлагает выбрать (`selectableModels`): значение `--model`, подпись и уровни
   * effort модели. У встроенных `claude`, `codex` и `glm` список — из каталога `provider-models.ts`, у
   * прочих — из `providers.json`.
```

`packages/core/src/providers.ts` — найти:

```ts
 * принимает любое значение по прежнему правилу. Отдаётся копия: ответ уходит по проводу, и правка
 * получателем не должна доходить до реестра.
 */
export function selectableModels(entry: ProviderEntry): ModelOption[] | null {
  const list = entry.models;
  if (!supportsModel(entry) || list === undefined || list === null || list.length === 0) {
    return null;
  }
  return list.map((model) => ({ ...model }));
}
```

заменить на:

```ts
 * принимает любое значение по прежнему правилу. Отдаётся копия: ответ уходит по проводу, и правка
 * получателем не должна доходить до реестра — в том числе правка уровней: массив уровней у моделей
 * каталога общий.
 */
export function selectableModels(entry: ProviderEntry): ModelOption[] | null {
  const list = entry.models;
  if (!supportsModel(entry) || list === undefined || list === null || list.length === 0) {
    return null;
  }
  return list.map((model) =>
    model.efforts === undefined || model.efforts === null
      ? { ...model }
      : { ...model, efforts: model.efforts.map((effort) => ({ ...effort })) },
  );
}
```

`packages/core/src/index.ts` — найти:

```ts
export type { ModelOption } from './provider-models.js';
```

заменить на:

```ts
export { CLAUDE_EFFORTS, LEGACY_EFFORTS, effortLabel } from './provider-models.js';
export type { EffortOption, ModelOption } from './provider-models.js';
```

- [ ] **Step 4: Тесты core зелёные**

Run: `pnpm --filter @parley/core exec vitest run src/providers.test.ts`
Expected: `Tests  88 passed (88)`.

Run: `pnpm --filter @parley/core exec vitest run`
Expected: все 72 файла зелёные. `get_map` в `src/mcp/server.test.ts` сравнивает с тем же `selectableModels` и проходит, `test/frame-check.test.ts` проходит: число строк в `providers.ts` выше `:236` не изменилось.

- [ ] **Step 5: Хост — тест `providers.list` сверяет пары id/подпись, а не объекты целиком**

Тесты хоста берут `@parley/core` из `dist`.

Run: `pnpm --filter @parley/core build && pnpm --filter @parley/host exec vitest run src/methods/providers.test.ts`
Expected до правки: `1 failed | 11 passed (12)` — «окну уходят списки из документации…»: `expected [ { id: 'best', …(2) }, …(8) ] to deeply equal [ { id: 'best', label: 'Best' }, …(8) ]`.

Три замены в `packages/host/src/methods/providers.test.ts`.

`packages/host/src/methods/providers.test.ts` — найти:

```ts
  models: Array<{ id: string; label: string }> | null;
  effort: boolean;
  version: string | null;
```

заменить на:

```ts
  models: Array<{ id: string; label: string; efforts?: Array<{ id: string; label: string; description?: string }> | null }> | null;
  effort: boolean;
  version: string | null;
```

`packages/host/src/methods/providers.test.ts` — найти:

```ts
  it('окну уходят списки из документации: claude — алиасы, codex — GPT-6; порядок и подписи как в реестре', async () => {
    const providers = await list(await boot());

    expect(byId(providers, 'claude').models).toEqual([
```

заменить на:

```ts
  it('окну уходят списки реестра: claude — алиасы, codex — запасной список; порядок, подписи и уровни как в реестре', async () => {
    const providers = await list(await boot());
    /** Пары id и подпись; уровни сверяются ниже, отдельно. */
    const pairsOf = (id: string) => byId(providers, id).models?.map((model) => ({ id: model.id, label: model.label }));

    expect(pairsOf('claude')).toEqual([
```

`packages/host/src/methods/providers.test.ts` — найти:

```ts
    expect(byId(providers, 'codex').models).toEqual([
      { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
    ]);
  });
```

заменить на:

```ts
    expect(pairsOf('codex')).toEqual([
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
      { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
      { id: 'gpt-6-sol', label: 'GPT-6-Sol' },
      { id: 'gpt-6-luna', label: 'GPT-6-Luna' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
    ]);
    // Уровни едут по проводу вместе с моделью: у Haiku их нет, у Luna нет Ultra.
    const levelsOf = (provider: string, model: string) =>
      byId(providers, provider).models?.find((option) => option.id === model)?.efforts;
    expect(levelsOf('claude', 'haiku')).toBeNull();
    expect(levelsOf('codex', 'gpt-6-luna')?.map((level) => level.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
```

Run: `pnpm --filter @parley/host exec vitest run src/methods/providers.test.ts`
Expected: `Tests  12 passed (12)`.

- [ ] **Step 6: Typecheck и lint**

Run: `pnpm typecheck && pnpm lint`
Expected: без ошибок. Новое поле `efforts?` необязательное, протокол, хост и окно компилируются как есть.

- [ ] **Step 7: Коммит**

```bash
git add packages/core/src/provider-models.ts packages/core/src/providers.ts packages/core/src/index.ts packages/core/src/providers.test.ts packages/host/src/methods/providers.test.ts
git commit -m "feat(core): уровни effort в каталоге моделей — Claude, GLM и запасной список Codex" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Токен effort, effortsFor и resolveModelEffort (спека 5.3)

**Files:**
- Modify: `packages/core/src/providers.ts` — `:5` (импорт), `:338-347` (`EffortLevel`, `EFFORT_LEVELS`), `:367-371` (`RunnerSubstitutions.effort`), `:377-383` (комментарий `INLINE_EFFORT`), `:385-396` (начало `substituteArgs`), после `modelChoiceError` (`:701`) — новые `effortsFor`, `ModelEffortChoice`, `ModelEffortResolution`, `resolveModelEffort`. Номера — по исходной ветке, Task 1 их не сдвигает.
- Modify: `packages/core/src/index.ts:55-90`
- Test: `packages/core/src/providers.test.ts` (импорт `:6-24`, новые `describe` в конце файла)

**Interfaces:**
- Consumes: из Task 1 — `LEGACY_EFFORTS`, `EffortOption`, `selectableModels` (копия с уровнями).
- Produces (`packages/core/src/providers.ts`, всё — и из `@parley/core`):
  - `export const EFFORT_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/`
  - `export type EffortLevel = string` — прежнее имя, чтобы импорты хоста, `work/types.ts`, `work/map.ts` и `work/launch.ts` компилировались без правок. `WorkSession.effort`, `NewSession.effort`, `LaunchOptions.effort`, `RunnerSubstitutions.effort` тем самым уже `string`.
  - `EFFORT_LEVELS` остаётся `@deprecated`: им пользуется MCP до Task 7, который его и удаляет.
  - `substituteArgs` бросает `Error('effort "<значение>" is not an effort level')`, если `subs.effort` задан и не проходит `EFFORT_TOKEN`. Проверка идёт до любой подстановки.
  - `export function effortsFor(entry: ProviderEntry, model: string | undefined): EffortOption[] | null` — у модели с пустым списком уровней (`efforts: []`) тоже `null`, как у окна (`effortChoices`, Task 12)
  - `export interface ModelEffortChoice { model?: string; effort?: string }`
  - `export type ModelEffortResolution = { choice: ModelEffortChoice } | { error: string }`
  - `export function resolveModelEffort(entry: ProviderEntry, choice: ModelEffortChoice): ModelEffortResolution`. Тексты ошибок: `effort "<v>" is not a level name[; allowed: …]`, `<model|the default model> has no effort levels; omit effort`, `<effort> is not a level of <model|the default model>; allowed: a, b, c`, ошибки модели — текст `modelChoiceError`.

- [ ] **Step 1: Написать падающие тесты**

Импорт:

`packages/core/src/providers.test.ts` — найти:

```ts
import {
  PROVIDERS,
  commandInPath,
  commandBinary,
  loadProviders,
  isClaudeCode,
  modelChoiceError,
  printCommand,
  providersFile,
  providersWithHistory,
  resumeCommand,
  selectableModels,
  startCommand,
  substituteArgs,
  supportsEffort,
  supportsModel,
  type ProviderEntry,
} from './providers.js';
import { CLAUDE_EFFORTS, LEGACY_EFFORTS, effortLabel } from './provider-models.js';
```

заменить на:

```ts
import {
  EFFORT_TOKEN,
  PROVIDERS,
  commandInPath,
  commandBinary,
  effortsFor,
  loadProviders,
  isClaudeCode,
  modelChoiceError,
  printCommand,
  providersFile,
  providersWithHistory,
  resolveModelEffort,
  resumeCommand,
  selectableModels,
  startCommand,
  substituteArgs,
  supportsEffort,
  supportsModel,
  type ProviderEntry,
} from './providers.js';
import { CLAUDE_EFFORTS, LEGACY_EFFORTS, effortLabel, type ModelOption } from './provider-models.js';
```

Дописать в конец `packages/core/src/providers.test.ts`:

```ts
describe('токен effort (спека нормалайзера модели и effort, 5.3)', () => {
  it('EFFORT_TOKEN принимает уровни каталогов и отвергает всё, что разорвало бы argv или TOML', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'none', 'a', 'x_y-1', `a${'b'.repeat(31)}`]) {
      expect(EFFORT_TOKEN.test(level), level).toBe(true);
    }
    for (const level of ['hi gh', '"x', 'x"', 'High', 'HIGH', '', `a${'b'.repeat(32)}`, '1low', '-low', '_low', 'low\n', 'lo\\w', "lo'w"]) {
      expect(EFFORT_TOKEN.test(level), JSON.stringify(level)).toBe(false);
    }
  });

  it('уровни встроенного каталога — токены: их можно подставить и в кавычки TOML', () => {
    for (const entry of [PROVIDERS.claude, PROVIDERS.codex, PROVIDERS.glm]) {
      for (const model of selectableModels(entry) ?? []) {
        for (const level of model.efforts ?? []) {
          expect(EFFORT_TOKEN.test(level.id), `${entry.id} ${model.id}: ${level.id}`).toBe(true);
        }
      }
    }
  });

  it('substituteArgs не пускает значение, не прошедшее токен: ни в строку -c, ни целым элементом', () => {
    for (const effort of ['hi gh', '"x', 'x"', 'high" -c x="y', 'HIGH', '', `a${'b'.repeat(32)}`]) {
      const name = JSON.stringify(effort);
      expect(() => substituteArgs(['-c', 'model_reasoning_effort="{effort}"'], { effort }), name).toThrow(/effort/);
      expect(() => startCommand(PROVIDERS.codex, { effort, prompt: 'p' }), name).toThrow(/effort/);
      expect(() => startCommand(PROVIDERS.claude, { effort, prompt: 'p' }), name).toThrow(/effort/);
    }
    // Шаблон без {effort} не спасает: проверка идёт до любой подстановки.
    expect(() => substituteArgs(['{prompt}'], { effort: 'x"', prompt: 'p' })).toThrow(/effort/);
  });

  it('уровень-токен подставляется как есть, и новые уровни тоже: xhigh у Claude Code, ultra у Codex', () => {
    const claude = startCommand(PROVIDERS.claude, { effort: 'xhigh', prompt: 'p' }).args;
    expect(claude[claude.indexOf('--effort') + 1]).toBe('xhigh');
    expect(startCommand(PROVIDERS.codex, { effort: 'ultra', prompt: 'p' }).args).toContain(
      'model_reasoning_effort="ultra"',
    );
  });
});

describe('effortsFor: уровни для выбора модели (спека нормалайзера модели и effort, 5.1 и 5.3)', () => {
  const ids = (levels: { id: string }[] | null): string[] | null =>
    levels === null ? null : levels.map((level) => level.id);
  const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];

  /** Свой провайдер с `{model}` и `{effort}` в шаблоне и данным списком моделей. */
  const custom = (models: readonly ModelOption[] | null): ProviderEntry => ({
    id: 'мой',
    label: 'Мой',
    mark: 'Мо',
    hasHistory: false,
    linkBy: 'cwd+time',
    runner: { command: 'мой', args: ['--m', '{model}', '--e', '{effort}', '{prompt}'] },
    models,
  });

  it('Claude: у моделей пять уровней low…max, у Haiku — null', () => {
    for (const model of ['best', 'fable', 'sonnet', 'opus', 'sonnet[1m]', 'opus[1m]', 'opusplan', 'opusplan[1m]']) {
      expect(ids(effortsFor(PROVIDERS.claude, model)), model).toEqual(FIVE);
    }
    expect(effortsFor(PROVIDERS.claude, 'haiku')).toBeNull();
  });

  it('Codex: у Sol и Astra есть Ultra, у Luna — нет; уровни несут описания каталога', () => {
    for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra']) {
      expect(ids(effortsFor(PROVIDERS.codex, model)), model).toEqual([...FIVE, 'ultra']);
    }
    for (const model of ['gpt-6-luna', 'gpt-5.6-luna']) {
      expect(ids(effortsFor(PROVIDERS.codex, model)), model).toEqual(FIVE);
    }
    expect(effortsFor(PROVIDERS.codex, 'gpt-6.1-sol')?.at(-1)).toEqual({
      id: 'ultra',
      label: 'Ultra',
      description: 'Maximum reasoning with automatic task delegation',
    });
  });

  it('«Default» — общие уровни моделей провайдера в порядке первой: Claude и GLM — low…max, Codex — без Ultra', () => {
    expect(ids(effortsFor(PROVIDERS.claude, undefined))).toEqual(FIVE);
    expect(ids(effortsFor(PROVIDERS.glm, undefined))).toEqual(FIVE);
    expect(ids(effortsFor(PROVIDERS.codex, undefined))).toEqual(FIVE);
  });

  it('список только из моделей без уровней (одна Haiku) или с пустым списком уровней — null', () => {
    const haikuOnly = custom([{ id: 'haiku', label: 'Haiku', efforts: null }]);
    expect(effortsFor(haikuOnly, undefined)).toBeNull();
    expect(effortsFor(haikuOnly, 'haiku')).toBeNull();
    // Пустой список — как null: явного уровня у такой модели не выбрать, окно поле прячет (`effortChoices`).
    const bare = custom([{ id: 'bare', label: 'Bare', efforts: [] }]);
    expect(effortsFor(bare, 'bare')).toBeNull();
    expect(effortsFor(bare, undefined)).toBeNull();
  });

  it('модель без поля efforts (свой список) — прежние три уровня; в пересечении «Default» — тоже они', () => {
    const entry = custom([
      { id: 'a', label: 'А' },
      { id: 'b', label: 'Б', efforts: [{ id: 'high', label: 'High' }, { id: 'max', label: 'Max' }] },
    ]);
    expect(ids(effortsFor(entry, 'a'))).toEqual(['low', 'medium', 'high']);
    expect(ids(effortsFor(entry, undefined))).toEqual(['high']);
  });

  it('общих уровней нет — у «Default» null', () => {
    const entry = custom([
      { id: 'a', label: 'А', efforts: [{ id: 'low', label: 'Low' }] },
      { id: 'b', label: 'Б', efforts: [{ id: 'high', label: 'High' }] },
    ]);
    expect(effortsFor(entry, undefined)).toBeNull();
  });

  it('провайдер без списка моделей и модель вне списка — прежние low, medium, high', () => {
    expect(ids(effortsFor(custom(null), undefined))).toEqual(['low', 'medium', 'high']);
    expect(ids(effortsFor(custom(null), 'что-угодно'))).toEqual(['low', 'medium', 'high']);
    expect(ids(effortsFor(PROVIDERS.claude, 'claude-opus-5-5'))).toEqual(['low', 'medium', 'high']);
  });

  it('провайдер без {effort} в шаблоне — null при любой модели', () => {
    const modelOnly: ProviderEntry = {
      ...PROVIDERS.claude,
      runner: { command: 'claude', args: ['--model', '{model}', '{prompt}'] },
    };
    expect(effortsFor(modelOnly, 'opus')).toBeNull();
    expect(effortsFor(modelOnly, undefined)).toBeNull();
  });

  it('отдаётся копия: правка ответа каталог не меняет', () => {
    const opus = effortsFor(PROVIDERS.claude, 'opus');
    if (opus === null || opus[0] === undefined) throw new Error('у opus нет уровней');
    opus[0].label = 'испорчено';
    opus.pop();
    const legacy = effortsFor(custom(null), undefined);
    legacy?.pop();

    expect(effortsFor(PROVIDERS.claude, 'opus')?.[0]?.label).toBe('Low');
    expect(ids(effortsFor(PROVIDERS.claude, 'opus'))).toEqual(FIVE);
    expect(ids(effortsFor(custom(null), undefined))).toEqual(['low', 'medium', 'high']);
  });
});

describe('resolveModelEffort: пара модели и effort для окна и MCP (спека нормалайзера модели и effort, 5.3)', () => {
  it('пустые строки и отсутствие полей — «Default»: в ответе полей нет вовсе', () => {
    expect(resolveModelEffort(PROVIDERS.claude, {})).toStrictEqual({ choice: {} });
    expect(resolveModelEffort(PROVIDERS.claude, { model: '', effort: '' })).toStrictEqual({ choice: {} });
    expect(resolveModelEffort(PROVIDERS.codex, { model: 'gpt-6-luna', effort: '' })).toStrictEqual({
      choice: { model: 'gpt-6-luna' },
    });
  });

  it('пара из каталога проходит как есть; при «Default» модели — общий уровень', () => {
    expect(resolveModelEffort(PROVIDERS.claude, { model: 'opus', effort: 'max' })).toStrictEqual({
      choice: { model: 'opus', effort: 'max' },
    });
    expect(resolveModelEffort(PROVIDERS.codex, { model: 'gpt-6.1-sol', effort: 'ultra' })).toStrictEqual({
      choice: { model: 'gpt-6.1-sol', effort: 'ultra' },
    });
    expect(resolveModelEffort(PROVIDERS.glm, { effort: 'xhigh' })).toStrictEqual({ choice: { effort: 'xhigh' } });
    expect(resolveModelEffort(PROVIDERS.claude, { model: 'haiku' })).toStrictEqual({ choice: { model: 'haiku' } });
  });

  it('модель — по правилу modelChoiceError: та же причина со списком допустимых', () => {
    expect(resolveModelEffort(PROVIDERS.claude, { model: 'gpt-6-sol', effort: 'high' })).toEqual({
      error: modelChoiceError(PROVIDERS.claude, 'gpt-6-sol'),
    });
    expect(resolveModelEffort(PROVIDERS.claude, { model: '--effort' })).toEqual({
      error: modelChoiceError(PROVIDERS.claude, '--effort'),
    });
  });

  it('effort не токен — ошибка, с уровнями модели, если они есть; даже у провайдера без {effort}', () => {
    for (const effort of ['hi gh', '"x', 'x"', 'High', 'x'.repeat(33)]) {
      expect(resolveModelEffort(PROVIDERS.claude, { model: 'opus', effort }), effort).toEqual({
        error: `effort ${JSON.stringify(effort)} is not a level name; allowed: low, medium, high, xhigh, max`,
      });
    }
    const plain: ProviderEntry = { ...PROVIDERS.claude, runner: { command: 'claude', args: ['{prompt}'] } };
    expect(resolveModelEffort(plain, { effort: 'x"' })).toEqual({
      error: `effort ${JSON.stringify('x"')} is not a level name`,
    });
  });

  it('провайдер без {effort} в шаблоне отбрасывает уровень молча, без {model} — и модель', () => {
    const plain: ProviderEntry = { ...PROVIDERS.claude, runner: { command: 'claude', args: ['{prompt}'] } };
    expect(resolveModelEffort(plain, { model: 'anything', effort: 'high' })).toStrictEqual({ choice: {} });
    const modelOnly: ProviderEntry = {
      ...PROVIDERS.claude,
      runner: { command: 'claude', args: ['--model', '{model}', '{prompt}'] },
    };
    expect(resolveModelEffort(modelOnly, { model: 'opus', effort: 'ultra' })).toStrictEqual({
      choice: { model: 'opus' },
    });
  });

  it('у модели без уровней — «omit effort», и у «Default», когда уровней нет ни у одной модели', () => {
    expect(resolveModelEffort(PROVIDERS.claude, { model: 'haiku', effort: 'low' })).toEqual({
      error: 'haiku has no effort levels; omit effort',
    });
    const haikuOnly: ProviderEntry = { ...PROVIDERS.claude, models: [{ id: 'haiku', label: 'Haiku', efforts: null }] };
    expect(resolveModelEffort(haikuOnly, { effort: 'low' })).toEqual({
      error: 'the default model has no effort levels; omit effort',
    });
  });

  it('уровень не из списка модели — ошибка с её уровнями; у «Default» — с общими', () => {
    expect(resolveModelEffort(PROVIDERS.codex, { model: 'gpt-6-luna', effort: 'ultra' })).toEqual({
      error: 'ultra is not a level of gpt-6-luna; allowed: low, medium, high, xhigh, max',
    });
    expect(resolveModelEffort(PROVIDERS.codex, { effort: 'ultra' })).toEqual({
      error: 'ultra is not a level of the default model; allowed: low, medium, high, xhigh, max',
    });
    expect(resolveModelEffort(PROVIDERS.claude, { model: 'opus', effort: 'minimal' })).toEqual({
      error: 'minimal is not a level of opus; allowed: low, medium, high, xhigh, max',
    });
  });

  it('свой список без уровней — прежние low, medium, high', () => {
    const mine: ProviderEntry = { ...PROVIDERS.claude, models: [{ id: 'mine', label: 'Моя' }] };
    expect(resolveModelEffort(mine, { model: 'mine', effort: 'medium' })).toStrictEqual({
      choice: { model: 'mine', effort: 'medium' },
    });
    expect(resolveModelEffort(mine, { model: 'mine', effort: 'xhigh' })).toEqual({
      error: 'xhigh is not a level of mine; allowed: low, medium, high',
    });
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter @parley/core exec vitest run src/providers.test.ts`
Expected: `Tests  20 failed | 89 passed (109)`. Причины — `TypeError: effortsFor is not a function`, `TypeError: resolveModelEffort is not a function`, `Cannot read properties of undefined (reading 'test')` (нет `EFFORT_TOKEN`). Тест «substituteArgs не пускает значение…» падает на `expected [Function] to throw an error`. Проходит один новый тест, «уровень-токен подставляется как есть…»: подстановка `xhigh`/`ultra` работает и сейчас.

- [ ] **Step 3: Реализация**

Шесть замен в `packages/core/src/providers.ts`. Импорт остаётся одной строкой: `test/frame-check.test.ts` держит номера строк `providers.ts` (`:17`, `:236`), и многострочный импорт их сдвинул бы.

`packages/core/src/providers.ts` — найти:

```ts
import { CLAUDE_MODELS, CODEX_MODELS, GLM_MODELS, type ModelOption } from './provider-models.js';
```

заменить на:

```ts
import { CLAUDE_MODELS, CODEX_MODELS, GLM_MODELS, LEGACY_EFFORTS, type EffortOption, type ModelOption } from './provider-models.js';
```

`packages/core/src/providers.ts` — найти:

```ts
/**
 * Усилие рассуждений, которое окно предлагает при запуске. Три уровня — общее подмножество
 * того, что документируют Claude Code (`low`…`max`) и Codex (`low`…`ultra`, набор зависит от
 * модели). Уровень, которого модель Claude не знает, Claude Code сам опускает до ближайшего
 * ниже (code.claude.com/docs/en/model-config); про Codex документация этого не говорит.
 */
export type EffortLevel = 'low' | 'medium' | 'high';

/** Те же уровни списком: по нему проверяет `effort` `spawn_session`, а схема окна держит свой набор. */
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high'];
```

заменить на:

```ts
/**
 * Токен уровня effort: безопасен и в argv, и в кавычках TOML (`-c model_reasoning_effort="…"`) — ни
 * пробела, ни кавычки, ни обратной косой черты. Тем же правилом проверяют `substituteArgs` (до любой
 * подстановки), `resolveModelEffort`, уровни из `providers.json` и `parseMap`.
 */
export const EFFORT_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Уровень effort — id из каталога модели (`ModelOption.efforts`): у Claude Code `low…max`, у моделей
 * Codex свои наборы, вплоть до `ultra`. Набор открыт, поэтому тип — строка; годится только значение,
 * проходящее `EFFORT_TOKEN`.
 */
export type EffortLevel = string;

/**
 * Прежние три уровня, которыми `spawn_session` проверяет `effort`.
 * @deprecated Уровни для выбора даёт `effortsFor`, проверку пары — `resolveModelEffort`.
 */
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high'];
```

`packages/core/src/providers.ts` — найти:

```ts
  /**
   * Усилие новой сессии: `--effort` у claude, `-c model_reasoning_effort` у codex. Тип — закрытый
   * набор, потому что у codex значение встаёт в кавычки строки шаблона без экранирования.
   */
  effort?: EffortLevel;
```

заменить на:

```ts
  /**
   * Усилие: `--effort` у claude, `-c model_reasoning_effort` у codex. У codex значение встаёт в
   * кавычки строки шаблона без экранирования, поэтому `substituteArgs` пускает только `EFFORT_TOKEN`.
   */
  effort?: EffortLevel;
```

`packages/core/src/providers.ts` — найти:

```ts
 * Codex принимает его только значением TOML в `-c`. Остальным подстановкам это не нужно —
 * и не позволено: усилие берётся из закрытого набора, и его можно вставить в кавычки без
 * экранирования, а модель — произвольная строка.
 */
```

заменить на:

```ts
 * Codex принимает его только значением TOML в `-c`. Остальным подстановкам это не нужно —
 * и не позволено: усилие проходит `EFFORT_TOKEN`, и его можно вставить в кавычки без
 * экранирования, а модель — произвольная строка.
 */
```

`packages/core/src/providers.ts` — найти:

```ts
 * Подстановка без значения выпадает вместе с флагом, который её вводит, —
 * предыдущим аргументом, если он пришёл из шаблона литералом и начинается с
 * `-`. Иначе от `--mcp-config {mcpConfig}` остался бы висячий флаг. Значение,
 * само похожее на флаг, соседа не уносит: оно литералом шаблона не было.
 */
export function substituteArgs(template: readonly string[], subs: RunnerSubstitutions): string[] {
  const args: string[] = [];
```

заменить на:

```ts
 * Подстановка без значения выпадает вместе с флагом, который её вводит, —
 * предыдущим аргументом, если он пришёл из шаблона литералом и начинается с
 * `-`. Иначе от `--mcp-config {mcpConfig}` остался бы висячий флаг. Значение,
 * само похожее на флаг, соседа не уносит: оно литералом шаблона не было.
 *
 * Усилие, не прошедшее `EFFORT_TOKEN`, — исключение до любой подстановки: кавычка или пробел
 * разорвали бы TOML строки `model_reasoning_effort="{effort}"` или ушли бы в CLI лишним словом.
 */
export function substituteArgs(template: readonly string[], subs: RunnerSubstitutions): string[] {
  if (subs.effort !== undefined && !EFFORT_TOKEN.test(subs.effort)) {
    throw new Error(`effort ${JSON.stringify(subs.effort)} is not an effort level`);
  }
  const args: string[] = [];
```

Новые функции — перед `isModelEntry`, сразу после `modelChoiceError`:

`packages/core/src/providers.ts` — найти:

```ts
const isModelEntry = (value: unknown): value is ModelOption =>
```

заменить на:

```ts
/**
 * Уровни effort, из которых можно выбрать при этой модели: `model` — id из списка провайдера,
 * `undefined` — «Default» (без флага модели). `null` — effort выбрать нельзя: провайдер его не
 * принимает (нет `{effort}` в шаблоне) или у модели его нет (Haiku, пустой список). Правила (спека
 * нормалайзера, 5.1 и 5.3; окно повторяет их в `effortChoices`):
 * - провайдер без списка моделей, модель вне списка и модель без поля `efforts` (свой список из
 *   `providers.json` без уровней) — прежние `low|medium|high` (`LEGACY_EFFORTS`);
 * - «Default» — уровни, общие для всех моделей провайдера с уровнями, в порядке первой из них: какую
 *   модель возьмёт CLI, Parley не знает (настройки CLI рамка читать не даёт), а общий уровень годится
 *   любой. Общих нет — `null`.
 * Отдаётся копия, как у `selectableModels`.
 */
export function effortsFor(entry: ProviderEntry, model: string | undefined): EffortOption[] | null {
  if (!supportsEffort(entry)) return null;
  const legacy = (): EffortOption[] => LEGACY_EFFORTS.map((level) => ({ ...level }));
  const list = selectableModels(entry);
  if (list === null) return legacy();
  if (model !== undefined) {
    const option = list.find((candidate) => candidate.id === model);
    if (option === undefined || option.efforts === undefined) return legacy();
    return option.efforts === null || option.efforts.length === 0 ? null : option.efforts;
  }
  const lists = list.flatMap((option) => {
    const levels = option.efforts === undefined ? legacy() : option.efforts;
    return levels === null || levels.length === 0 ? [] : [levels];
  });
  const [first, ...rest] = lists;
  if (first === undefined) return null;
  const shared = first.filter((level) =>
    rest.every((levels) => levels.some((other) => other.id === level.id)),
  );
  return shared.length === 0 ? null : shared;
}

/** Выбор модели и effort; поля нет — «Default», без флага. */
export interface ModelEffortChoice {
  model?: string;
  effort?: string;
}

/** Итог `resolveModelEffort`: что ляжет в карту и в команду, или причина отказа. */
export type ModelEffortResolution = { choice: ModelEffortChoice } | { error: string };

/**
 * Проверка пары «модель + effort» — одна для окна (`sessions.create` хоста) и MCP (`spawn_session`),
 * до записи в карту (спека нормалайзера, 5.3). Пустая строка и отсутствие поля — «Default»: в ответе
 * поля нет. Модель проверяет `modelChoiceError`. Effort должен проходить `EFFORT_TOKEN` и быть
 * уровнем из `effortsFor` для выбранной модели (или для «Default»). Флаг, которого нет в шаблоне
 * запуска, выбор отбрасывает молча, как и прежде: в ответ и в карту ложится только то, что дойдёт
 * до CLI. Ошибка — текст причины со списком допустимого.
 */
export function resolveModelEffort(
  entry: ProviderEntry,
  choice: ModelEffortChoice,
): ModelEffortResolution {
  const model = choice.model === '' ? undefined : choice.model;
  const effort = choice.effort === '' ? undefined : choice.effort;
  if (model !== undefined) {
    const refusal = modelChoiceError(entry, model);
    if (refusal !== null) return { error: refusal };
  }
  const kept = model !== undefined && supportsModel(entry) ? model : undefined;
  const resolved: ModelEffortChoice = kept === undefined ? {} : { model: kept };
  if (effort === undefined) return { choice: resolved };

  const levels = effortsFor(entry, kept);
  const allowed = levels === null ? '' : `; allowed: ${levels.map((level) => level.id).join(', ')}`;
  if (!EFFORT_TOKEN.test(effort)) {
    return { error: `effort ${JSON.stringify(effort)} is not a level name${allowed}` };
  }
  if (!supportsEffort(entry)) return { choice: resolved };
  const subject = kept ?? 'the default model';
  if (levels === null) return { error: `${subject} has no effort levels; omit effort` };
  if (!levels.some((level) => level.id === effort)) {
    return { error: `${effort} is not a level of ${subject}${allowed}` };
  }
  return { choice: { ...resolved, effort } };
}

const isModelEntry = (value: unknown): value is ModelOption =>
```

Четыре замены в `packages/core/src/index.ts`:

`packages/core/src/index.ts` — найти:

```ts
export {
  PROVIDERS,
  agentEnv,
```

заменить на:

```ts
export {
  EFFORT_TOKEN,
  PROVIDERS,
  agentEnv,
```

`packages/core/src/index.ts` — найти:

```ts
  commandInPath,
  probeCliVersion,
```

заменить на:

```ts
  commandInPath,
  effortsFor,
  probeCliVersion,
```

`packages/core/src/index.ts` — найти:

```ts
  providersWithHistory,
  resumeCommand,
```

заменить на:

```ts
  providersWithHistory,
  resolveModelEffort,
  resumeCommand,
```

`packages/core/src/index.ts` — найти:

```ts
  McpConfigKind,
  ProviderEntry,
```

заменить на:

```ts
  McpConfigKind,
  ModelEffortChoice,
  ModelEffortResolution,
  ProviderEntry,
```

- [ ] **Step 4: Тесты зелёные**

Run: `pnpm --filter @parley/core exec vitest run src/providers.test.ts`
Expected: `Tests  109 passed (109)`.

Run: `pnpm --filter @parley/core exec vitest run`
Expected: все 72 файла зелёные. MCP по-прежнему проверяет `effort` по `EFFORT_LEVELS`, его тесты не меняются. `test/frame-check.test.ts` зелёный: `grep -n 'codex/config' packages/core/src/providers.ts` по-прежнему даёт `17` и `236`.

- [ ] **Step 5: Typecheck и lint**

Run: `pnpm typecheck && pnpm lint`
Expected: без ошибок. Хост (`sessions-service.ts`) и MCP (`enumArg(args, 'effort', EFFORT_LEVELS)`) компилируются с `EffortLevel = string`.

- [ ] **Step 6: Коммит**

```bash
git add packages/core/src/providers.ts packages/core/src/index.ts packages/core/src/providers.test.ts
git commit -m "feat(core): токен effort, effortsFor и resolveModelEffort — одна проверка пары для окна и MCP" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `providers.json` — уровни моделей и `argsOverridden` (спека 5.6, 5.10)

**Files:**
- Modify: `packages/core/src/providers.ts` — `:5` (импорт), конец `ProviderEntry` (`:96-97`), `ProviderOverride.models` (`:657-662`), после `isModelList` (`:706-711`), конец `checkShape` (`:731-732`), `applyOverride` (`:761-765`, `:773-775`). Номера — по исходной ветке. После Task 2 `ProviderOverride` стоит на 20 строк ниже, а `isModelList`, `checkShape` и `applyOverride` — на 98 строк ниже: перед ними вставлены `effortsFor` и `resolveModelEffort`.
- Test: `packages/core/src/providers.test.ts` (в `describe('переопределения из PARLEY_HOME/providers.json')`)
- Test: `packages/core/test/frame-check.test.ts:417`

**Interfaces:**
- Consumes: из Task 1 — `effortLabel`. Из Task 2 — `EFFORT_TOKEN`, а в тестах `effortsFor` и `resolveModelEffort`.
- Produces:
  - `ProviderEntry.argsOverridden?: true` — ставит `applyOverride`, когда `providers.json` задаёт `args` (и у своего провайдера тоже).
  - `ProviderOverride.models?: Array<{ id: string; label: string; efforts?: string[] | null }>`. В записи реестра уровни становятся `EffortOption` с подписью `effortLabel(id)`, `null` переносится как есть, без поля — поля нет.
  - `loadProviders` отвергает плохие `efforts` ошибкой `provider <id> in <file>: model <modelId>: efforts must be null or a non-empty list of unique levels (lowercase letters, digits, - and _, up to 32 characters)`.

- [ ] **Step 1: Написать падающие тесты**

Четыре замены: три в `packages/core/src/providers.test.ts`, одна в `packages/core/test/frame-check.test.ts`. Новое поле `ProviderEntry` сдвигает второе упоминание пути конфига Codex с `:236` на `:242`.

`packages/core/src/providers.test.ts` — найти:

```ts
    expect(opencode).toEqual({
      id: 'opencode',
      label: 'OpenCode',
      mark: 'Op',
      hasHistory: false,
      linkBy: 'cwd+time',
      runner: { command: 'opencode', args: ['{prompt}'] },
    });
```

заменить на:

```ts
    expect(opencode).toEqual({
      id: 'opencode',
      label: 'OpenCode',
      mark: 'Op',
      hasHistory: false,
      linkBy: 'cwd+time',
      runner: { command: 'opencode', args: ['{prompt}'] },
      argsOverridden: true,
    });
```

`packages/core/src/providers.test.ts` — найти:

```ts
  it('встроенный реестр не мутируется переопределениями', async () => {
```

заменить на:

```ts
  it('argsOverridden — только у записи, чьи args пришли из providers.json', async () => {
    await write({
      codex: { args: ['{prompt}'] },
      claude: { command: '/opt/claude/bin/claude', resumeArgs: ['--resume', '{providerSessionId}'] },
    });
    const registry = await loadProviders();

    expect(registry['codex']?.argsOverridden).toBe(true);
    // Команда и resumeArgs — не args: выбор модели и effort по-прежнему решает встроенный шаблон.
    expect('argsOverridden' in (registry['claude'] ?? {})).toBe(false);
    expect('argsOverridden' in (registry['glm'] ?? {})).toBe(false);
    expect('argsOverridden' in PROVIDERS.codex).toBe(false);
    // Свой шаблон без {model} и {effort} выключает выбор — это окно и объясняет по argsOverridden.
    expect(supportsModel(registry['codex'] as ProviderEntry)).toBe(false);
    expect(supportsEffort(registry['codex'] as ProviderEntry)).toBe(false);
  });

  it('встроенный реестр не мутируется переопределениями', async () => {
```

`packages/core/src/providers.test.ts` — найти:

```ts
    it('повтор id в одном списке — ошибка: окно не различило бы две строки, а хост принял бы любую', async () => {
```

заменить на:

```ts
    it('efforts: уровни модели id-ами, подписи выводятся; null — effort у модели нет; без поля — прежнее правило', async () => {
      await write({
        codex: {
          models: [
            { id: 'my-sol', label: 'Моя Sol', efforts: ['low', 'xhigh', 'ultra', 'turbo'] },
            { id: 'my-mini', label: 'Моя мини', efforts: null },
            { id: 'my-old', label: 'Моя старая' },
          ],
        },
      });
      const codex = (await loadProviders())['codex'] as ProviderEntry;

      expect(selectableModels(codex)).toStrictEqual([
        {
          id: 'my-sol',
          label: 'Моя Sol',
          efforts: [
            { id: 'low', label: 'Low' },
            { id: 'xhigh', label: 'Extra high' },
            { id: 'ultra', label: 'Ultra' },
            { id: 'turbo', label: 'Turbo' },
          ],
        },
        { id: 'my-mini', label: 'Моя мини', efforts: null },
        { id: 'my-old', label: 'Моя старая' },
      ]);
      expect(effortsFor(codex, 'my-mini')).toBeNull();
      expect(effortsFor(codex, 'my-old')?.map((level) => level.id)).toEqual(['low', 'medium', 'high']);
      // «Default» — общее у моделей с уровнями: у my-sol и прежних трёх my-old общий только low.
      expect(effortsFor(codex, undefined)?.map((level) => level.id)).toEqual(['low']);
      expect(resolveModelEffort(codex, { model: 'my-sol', effort: 'turbo' })).toStrictEqual({
        choice: { model: 'my-sol', effort: 'turbo' },
      });
    });

    it('неверные efforts — loadProviders падает с причиной: провайдер, файл, модель и что не так', async () => {
      const wrong: unknown[] = [[], ['low', 'low'], ['hi gh'], ['High'], ['x"'], [''], ['a'.repeat(33)], 'low', [1], {}, [null]];
      for (const efforts of wrong) {
        await write({ codex: { models: [{ id: 'my-sol', label: 'Моя Sol', efforts }] } });
        await expect(loadProviders(), JSON.stringify(efforts)).rejects.toThrow(
          /^provider codex in .*providers\.json: model my-sol: efforts must be null or a non-empty list of unique levels/,
        );
      }
    });

    it('повтор id в одном списке — ошибка: окно не различило бы две строки, а хост принял бы любую', async () => {
```

`packages/core/test/frame-check.test.ts` — найти:

```ts
        'packages/core/src/providers.ts:236',
```

заменить на:

```ts
        'packages/core/src/providers.ts:242',
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter @parley/core exec vitest run src/providers.test.ts test/frame-check.test.ts`
Expected: `Tests  5 failed | 151 passed (156)`:
- «свой провайдер добавляется целиком» — нет `argsOverridden`;
- «argsOverridden — только у записи…» — `expected undefined to be true`;
- «efforts: уровни модели id-ами…» — уровни из файла не дошли до записи;
- «неверные efforts…» — `promise resolved … instead of rejecting`;
- рамочный «все нынешние совпадения регэкспов правил — в комментариях» — `:236` вместо `:242`.

- [ ] **Step 3: Реализация**

Семь замен в `packages/core/src/providers.ts`. Импорт по-прежнему одной строкой.

`packages/core/src/providers.ts` — найти:

```ts
import { CLAUDE_MODELS, CODEX_MODELS, GLM_MODELS, LEGACY_EFFORTS, type EffortOption, type ModelOption } from './provider-models.js';
```

заменить на:

```ts
import { CLAUDE_MODELS, CODEX_MODELS, GLM_MODELS, LEGACY_EFFORTS, effortLabel, type EffortOption, type ModelOption } from './provider-models.js';
```

`packages/core/src/providers.ts` — найти:

```ts
   * списке не хранится: это отсутствие выбора, без флага.
   */
  models?: readonly ModelOption[] | null;
}
```

заменить на:

```ts
   * списке не хранится: это отсутствие выбора, без флага.
   */
  models?: readonly ModelOption[] | null;
  /**
   * `args` пришли из `providers.json`: принимает ли провайдер модель и effort, решает уже шаблон
   * человека (`supportsModel`, `supportsEffort`), и окно говорит об этом в карточке провайдера.
   * Поля нет — шаблон встроенный.
   */
  argsOverridden?: true;
}
```

`packages/core/src/providers.ts` — найти:

```ts
  /**
   * Свой список моделей вместо встроенного, целиком (как `args`); `[]` убирает список. Элемент —
   * пара `{ id, label }`; `id` — одно слово, не с дефиса, до 200 знаков, и в списке не повторяется.
   */
  models?: ModelOption[];
}
```

заменить на:

```ts
  /**
   * Свой список моделей вместо встроенного, целиком (как `args`); `[]` убирает список. Элемент —
   * `{ id, label }` и необязательные `efforts`; `id` — одно слово, не с дефиса, до 200 знаков, и в
   * списке не повторяется. `efforts` — уровни модели (непустой список токенов `EFFORT_TOKEN` без
   * повторов, подписи выводит `effortLabel`) или `null`, если effort у модели нет; без поля —
   * прежние `low|medium|high` (`effortsFor`).
   */
  models?: Array<{ id: string; label: string; efforts?: string[] | null }>;
}
```

`packages/core/src/providers.ts` — найти:

```ts
/** Список пар без повторов `id`: два одинаковых окну не различить, а хост принял бы любое из них. */
const isModelList = (value: unknown): value is ModelOption[] =>
  Array.isArray(value) &&
  value.every(isModelEntry) &&
  new Set(value.map((model) => model.id)).size === value.length;
```

заменить на:

```ts
/** Список пар без повторов `id`: два одинаковых окну не различить, а хост принял бы любое из них. */
const isModelList = (value: unknown): value is ModelOption[] =>
  Array.isArray(value) &&
  value.every(isModelEntry) &&
  new Set(value.map((model) => model.id)).size === value.length;

/**
 * Уровни модели в `providers.json`: `null` — effort у модели нет, иначе непустой список токенов
 * `EFFORT_TOKEN` без повторов. Пустой список не «уровней нет» — для этого есть `null`.
 */
const isEffortList = (value: unknown): value is string[] | null =>
  value === null ||
  (Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && EFFORT_TOKEN.test(item)) &&
    new Set(value).size === value.length);
```

`packages/core/src/providers.ts` — найти:

```ts
  if (wrong) throw new Error(`provider ${id} in ${file}: unexpected entry shape`);
}
```

заменить на:

```ts
  if (wrong) throw new Error(`provider ${id} in ${file}: unexpected entry shape`);
  // Уровни моделей — с причиной: их правят руками, и «unexpected entry shape» не сказал бы, что не так.
  for (const model of (patch['models'] ?? []) as Array<{ id: string; efforts?: unknown }>) {
    if (model.efforts !== undefined && !isEffortList(model.efforts)) {
      throw new Error(
        `provider ${id} in ${file}: model ${model.id}: efforts must be null or a non-empty list of unique levels (lowercase letters, digits, - and _, up to 32 characters)`,
      );
    }
  }
}
```

`packages/core/src/providers.ts` — найти:

```ts
  // Из файла в запись ложатся свои копии пар, а не объекты разобранного JSON.
  const models =
    patch.models === undefined
      ? base?.models
      : patch.models.map((model) => ({ id: model.id, label: model.label }));
```

заменить на:

```ts
  // Из файла в запись ложатся свои копии пар, а не объекты разобранного JSON; уровни в файле — id,
  // в записи — с подписями, как у встроенного каталога.
  const models =
    patch.models === undefined
      ? base?.models
      : patch.models.map((model) => ({
          id: model.id,
          label: model.label,
          ...(model.efforts === undefined
            ? {}
            : {
                efforts:
                  model.efforts === null
                    ? null
                    : model.efforts.map((effort) => ({ id: effort, label: effortLabel(effort) })),
              }),
        }));
```

`packages/core/src/providers.ts` — найти:

```ts
    runner,
    ...(models === undefined ? {} : { models }),
  };
}
```

заменить на:

```ts
    runner,
    ...(models === undefined ? {} : { models }),
    ...(patch.args === undefined ? {} : { argsOverridden: true as const }),
  };
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `pnpm --filter @parley/core exec vitest run src/providers.test.ts test/frame-check.test.ts`
Expected: `Tests  156 passed (156)`. Проверка номера: `grep -n 'codex/config' packages/core/src/providers.ts` → строки `17` и `242`.

Run: `pnpm --filter @parley/core exec vitest run`
Expected: все 72 файла зелёные.

- [ ] **Step 5: Typecheck и lint**

Run: `pnpm typecheck && pnpm lint`
Expected: без ошибок.

- [ ] **Step 6: Коммит**

```bash
git add packages/core/src/providers.ts packages/core/src/providers.test.ts packages/core/test/frame-check.test.ts
git commit -m "feat(core): уровни моделей и argsOverridden из providers.json" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Resume несёт выбор из карты, испорченный effort в карте — «нет выбора» (спека 5.4, 5.5)

**Files:**
- Modify: `packages/core/src/providers.ts`, по исходной ветке. `:57-61` — документация `resumeArgs`. `:186-190` — комментарий у `--model`/`--effort` claude. `:208-211` — `claude.resumeArgs`: `--model {model} --effort {effort}` перед `--agent`. `:244-245` — комментарий Codex. `:313-318` — `glm.resumeArgs`: `--effort {effort}` после `--model {model}`.
- Modify: `packages/core/src/work/launch.ts:52-61` (`LaunchOptions`), `:269-271` и `:286-289` (`plan()`)
- Modify: `packages/core/src/work/types.ts:135-140` (документация `WorkSession.model`/`effort`)
- Modify: `packages/core/src/work/map.ts:1`, `:422-431` (`migrateSession`)
- Test: `packages/core/src/providers.test.ts` (`:313-318`, `:365`)
- Test: `packages/core/src/work/launch.test.ts` (`:548-583`, перед `:1129`)
- Test: `packages/core/src/work/map.test.ts` (перед `:582`)
- Test: `packages/core/test/frame-check.test.ts:417` (`242 → 248`)

**Interfaces:**
- Consumes: из Task 2 — `EFFORT_TOKEN`, проверка токена в `substituteArgs`.
- Produces:
  - `PROVIDERS.claude.runner.resumeArgs`: `… '--dangerously-load-development-channels', '{channel}', '--model', '{model}', '--effort', '{effort}', '--agent', '{agent}', '{prompt}'`.
  - `PROVIDERS.glm.runner.resumeArgs`: `… '--model', '{model}', '--effort', '{effort}', '--agent', '{agent}', '{prompt}'`. `codex.resumeArgs` без изменений.
  - `plan()`: при любом режиме `subs.model = options.model ?? session.model ?? entry.runner.settingsModel`, `subs.effort = options.effort ?? session.effort`. Нет значения — подстановки нет, и пара флагов выпадает. Это используют `sessions.setModel` хоста (stop + `launch(ref, 'resume')`) и подъём письмом.
  - `parseMap`: `effort`, не прошедший `EFFORT_TOKEN` (не строка, пусто, пробел, кавычка, заглавные, длиннее 32), убирается из сессии. Сессия и прочие поля остаются.

- [ ] **Step 1: Написать падающие тесты**

Две замены в `packages/core/src/providers.test.ts`:

`packages/core/src/providers.test.ts` — найти:

```ts
  it('claude при возобновлении модель и усилие не несёт: модель CLI возвращает сам', () => {
    expect(
      resumeCommand(PROVIDERS.claude, { providerSessionId: 'bb2137cb', model: 'opus', effort: 'high' })
        .args,
    ).toEqual(['--resume', 'bb2137cb']);
  });
```

заменить на:

```ts
  it('claude при возобновлении несёт модель и усилие из карты парами перед --agent; без выбора пар нет', () => {
    expect(
      resumeCommand(PROVIDERS.claude, {
        providerSessionId: 'bb2137cb',
        model: 'opus',
        effort: 'high',
        agent: 'ревьюер',
        prompt: 'New messages (1). Call check_inbox.',
      }).args,
    ).toEqual([
      '--resume',
      'bb2137cb',
      '--model',
      'opus',
      '--effort',
      'high',
      '--agent',
      'ревьюер',
      'New messages (1). Call check_inbox.',
    ]);
    // Одно усилие — одна пара; без выбора модель Claude Code при --resume восстанавливает сам.
    expect(resumeCommand(PROVIDERS.claude, { providerSessionId: 'bb2137cb', effort: 'xhigh' }).args).toEqual([
      '--resume',
      'bb2137cb',
      '--effort',
      'xhigh',
    ]);
    expect(resumeCommand(PROVIDERS.claude, { providerSessionId: 'bb2137cb' }).args).toEqual([
      '--resume',
      'bb2137cb',
    ]);
  });

  it('GLM при возобновлении несёт effort сразу за моделью; без effort пара выпадает', () => {
    expect(
      resumeCommand(PROVIDERS.glm, { providerSessionId: 'id-1', model: 'glm-5.3[1m]', effort: 'max' }).args,
    ).toEqual(['--resume', 'id-1', '--model', 'glm-5.3[1m]', '--effort', 'max']);
    expect(resumeCommand(PROVIDERS.glm, { providerSessionId: 'id-1', model: 'glm-5.3[1m]' }).args).toEqual([
      '--resume',
      'id-1',
      '--model',
      'glm-5.3[1m]',
    ]);
  });
```

`packages/core/src/providers.test.ts` — найти:

```ts
  it('codex при возобновлении модель и усилие тоже не несёт', () => {
```

заменить на:

```ts
  it('codex при возобновлении модель и усилие не несёт: тред помнит их сам', () => {
```

В `packages/core/src/work/launch.test.ts` вместо двух прежних тестов «возобновление … не несёт» — помощник и четыре теста, плюс тест GLM:

`packages/core/src/work/launch.test.ts` — найти:

```ts
  it('возобновление записанный выбор не несёт: модель Claude Code возвращает сам', async () => {
    const created = await createWork(project, { title: 'Авторизация', goal: '' });
    const workId = created.work.id;
    const sessionId = await createPendingSession(project, workId, {
      provider: 'claude',
      label: 'тесты',
      task: 'прогнать e2e',
      model: 'opus',
      effort: 'high',
    });
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((item) => item.id === sessionId);
      if (session !== undefined) session.providerSessionId = 'c0ffee00-1111-2222-3333-444455556666';
    });
    await claudeTranscript('c0ffee00-1111-2222-3333-444455556666');
    const plan = await planResume(project, workId, await sessionOf(workId, sessionId));

    expect(plan.args).not.toContain('--model');
    expect(plan.args).not.toContain('--effort');
  });

  it('возобновление выбор не несёт: модель Claude Code возвращает сам', async () => {
    const { workId, sessionId } = await pending('claude');
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((item) => item.id === sessionId);
      if (session !== undefined) session.providerSessionId = 'c0ffee00-1111-2222-3333-444455556666';
    });
    await claudeTranscript('c0ffee00-1111-2222-3333-444455556666');
    const plan = await planResume(project, workId, await sessionOf(workId, sessionId), {
      model: 'opus',
      effort: 'high',
    });

    expect(plan.args).not.toContain('--model');
    expect(plan.args).not.toContain('--effort');
  });
```

заменить на:

```ts
  /** Сессия с записанным выбором, которую есть что продолжать: id у провайдера, у Claude — и транскрипт. */
  async function resumable(
    provider: string,
    choice: { model?: string; effort?: string },
    providerSessionId: string,
  ): Promise<{ workId: string; sessionId: string }> {
    const created = await createWork(project, { title: 'Авторизация', goal: '' });
    const sessionId = await createPendingSession(project, created.work.id, {
      provider,
      label: 'тесты',
      task: 'прогнать e2e',
      ...choice,
    });
    await updateMap(project, created.work.id, (map) => {
      const session = map.sessions.find((item) => item.id === sessionId);
      if (session !== undefined) session.providerSessionId = providerSessionId;
    });
    if (provider === 'claude') await claudeTranscript(providerSessionId);
    return { workId: created.work.id, sessionId };
  }

  it('возобновление Claude несёт записанные модель и усилие: effort при --resume Claude Code сам не вернёт', async () => {
    const id = 'c0ffee00-1111-2222-3333-444455556666';
    const { workId, sessionId } = await resumable('claude', { model: 'opus', effort: 'low' }, id);
    const plan = await planResume(project, workId, await sessionOf(workId, sessionId));

    expect(plan.args.slice(0, 2)).toEqual(['--resume', id]);
    expect(plan.args[plan.args.indexOf('--model') + 1]).toBe('opus');
    expect(plan.args[plan.args.indexOf('--effort') + 1]).toBe('low');
    expect(plan.args.filter((arg) => arg === '--effort')).toHaveLength(1);
  });

  it('при возобновлении выбор запуска главнее записанного; невыбранное поле берётся из карты', async () => {
    const { workId, sessionId } = await resumable(
      'claude',
      { model: 'opus', effort: 'low' },
      'c0ffee00-1111-2222-3333-444455556666',
    );
    const plan = await planResume(project, workId, await sessionOf(workId, sessionId), { model: 'sonnet' });

    expect(plan.args[plan.args.indexOf('--model') + 1]).toBe('sonnet');
    expect(plan.args[plan.args.indexOf('--effort') + 1]).toBe('low');
  });

  it('возобновление без записанного выбора — без флагов: модель Claude Code восстанавливает сам', async () => {
    const id = 'c0ffee00-1111-2222-3333-444455556666';
    const { workId, sessionId } = await resumable('claude', {}, id);
    const plan = await planResume(project, workId, await sessionOf(workId, sessionId));

    expect(plan.args.slice(0, 2)).toEqual(['--resume', id]);
    expect(plan.args).not.toContain('--model');
    expect(plan.args).not.toContain('--effort');
  });

  it('codex при возобновлении ни модели, ни усилия не несёт, даже записанных: тред помнит их сам', async () => {
    const { workId, sessionId } = await resumable(
      'codex',
      { model: 'gpt-6-sol', effort: 'ultra' },
      '7fa0e1ee-cc7b-4a1e-9d4e-000000000001',
    );
    const plan = await planResume(project, workId, await sessionOf(workId, sessionId));

    expect(plan.args[0]).toBe('resume');
    expect(plan.args).not.toContain('--model');
    expect(plan.args.join(' ')).not.toContain('model_reasoning_effort');
  });
```

`packages/core/src/work/launch.test.ts` — найти:

```ts
  it('missing GLM transcript starts again with the assigned id', async () => {
```

заменить на:

```ts
  it('GLM: resume несёт записанный effort сразу за моделью; без записи пара --effort выпадает', async () => {
    const { workId, sessionId } = await pending('glm');
    const session = await sessionOf(workId, sessionId);
    session.providerSessionId = 'glm-conversation';
    const dir = path.join(logs, 'project');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'glm-conversation.jsonl'), '{"type":"user"}\n');

    expect((await planResume(project, workId, session)).args).not.toContain('--effort');

    session.effort = 'max';
    const plan = await planResume(project, workId, session);
    expect(plan.args.slice(0, 2)).toEqual(['--resume', 'glm-conversation']);
    expect(plan.args[plan.args.indexOf('--effort') + 1]).toBe('max');
    expect(plan.args.indexOf('--effort')).toBe(plan.args.indexOf('--model') + 2);
  });

  it('missing GLM transcript starts again with the assigned id', async () => {
```

В `packages/core/src/work/map.test.ts`, в `describe('parseMap')`:

`packages/core/src/work/map.test.ts` — найти:

```ts
  it('35: карта без kind у письма читается как note, остальные поля не тронуты', () => {
```

заменить на:

```ts
  it('испорченный effort читается как «нет выбора»: ключа нет, сессия и модель на месте', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'план', task: 't', model: 'opus', effort: 'xhigh' });
    const raw = JSON.parse(JSON.stringify(map)) as { sessions: Record<string, unknown>[] };
    for (const effort of ['hi gh', 'x"', '"x', 'HIGH', '', 'a'.repeat(33), 3, null, ['low']]) {
      raw.sessions[0]!['effort'] = effort;

      const parsed = parseMap(JSON.stringify(raw), 'map.json');
      expect(parsed.sessions, JSON.stringify(effort)).toHaveLength(1);
      expect('effort' in (parsed.sessions[0] ?? {}), JSON.stringify(effort)).toBe(false);
      expect(parsed.sessions[0]?.model).toBe('opus');
    }
  });

  it('уровни каталогов в карте читаются как есть: xhigh, max, ultra', () => {
    const map = emptyMap();
    for (const effort of ['xhigh', 'max', 'ultra']) {
      addSession(map, { provider: 'codex', label: effort, task: 't', effort });
    }

    expect(parseMap(JSON.stringify(map), 'map.json').sessions.map((session) => session.effort)).toEqual([
      'xhigh',
      'max',
      'ultra',
    ]);
  });

  it('35: карта без kind у письма читается как note, остальные поля не тронуты', () => {
```

Номер в рамочном тесте: две строки комментария и четыре строки флагов в `claude.resumeArgs` сдвигают его ещё на 6.

`packages/core/test/frame-check.test.ts` — найти:

```ts
        'packages/core/src/providers.ts:242',
```

заменить на:

```ts
        'packages/core/src/providers.ts:248',
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter @parley/core exec vitest run src/providers.test.ts src/work/launch.test.ts src/work/map.test.ts test/frame-check.test.ts`
Expected: `Tests  7 failed | 258 passed (265)`:
- `parseMap` «испорченный effort…» — `"hi gh": expected true to be false`;
- «claude при возобновлении несёт модель и усилие…» и «GLM при возобновлении несёт effort…» — в `args` нет пар;
- три теста `planResume` (`expected '--resume' to be 'opus'` / `'sonnet'` / `'max'`);
- рамочный — `:242` вместо `:248`.

- [ ] **Step 3: Реализация**

Пять замен в `packages/core/src/providers.ts`:

`packages/core/src/providers.ts` — найти:

```ts
   * `{channel}`, `{agent}`, `{model}`, `{notify}`, `{prompt}` — указатель на письма при подъёме
```

заменить на:

```ts
   * `{channel}`, `{agent}`, `{model}`, `{effort}`, `{notify}`, `{prompt}` — указатель на письма при подъёме
```

`packages/core/src/providers.ts` — найти:

```ts
        // Модель и усилие новой сессии из диалога окна. Оба флага документированы
        // (code.claude.com/docs/en/cli-reference: `--model`, `--effort`), а без выбора пара
        // выпадает целиком, и сессия живёт на модели и усилии по умолчанию. В `resumeArgs`
        // их нет: возобновлённая сессия остаётся на прежней модели (docs/en/sessions
        // того же сайта), а выбор из диалога в карте не хранится.
```

заменить на:

```ts
        // Модель и усилие из диалога окна или из карты сессии. Оба флага документированы
        // (code.claude.com/docs/en/cli-reference: `--model`, `--effort`), а без выбора пара
        // выпадает целиком, и сессия живёт на модели и усилии по умолчанию. Те же пары стоят и в
        // `resumeArgs`: effort возобновлённой сессии Claude Code сам не восстанавливает и без флага
        // уходит на умолчание (спека нормалайзера модели и effort, раздел 3, п. 6).
```

`packages/core/src/providers.ts` — найти:

```ts
        '--dangerously-load-development-channels',
        '{channel}',
        '--agent',
        '{agent}',
        // Указатель на письма, которыми хост поднимает спящую сессию (спека окна
```

заменить на:

```ts
        '--dangerously-load-development-channels',
        '{channel}',
        // Выбор из карты сессии (спека нормалайзера, 5.4). Нет выбора — пары выпадают, и модель
        // Claude Code при `--resume` восстанавливает сам.
        '--model',
        '{model}',
        '--effort',
        '{effort}',
        '--agent',
        '{agent}',
        // Указатель на письма, которыми хост поднимает спящую сессию (спека окна
```

`packages/core/src/providers.ts` — найти:

```ts
      // (openai/codex, sdk/typescript/src/exec.ts). Как и у claude, без выбора обе пары выпадают, а
      // при `resume` не передаются.
```

заменить на:

```ts
      // (openai/codex, sdk/typescript/src/exec.ts). Как и у claude, без выбора обе пары выпадают; при
      // `resume` их нет, в отличие от claude: тред Codex помнит модель и усилие сам.
```

`packages/core/src/providers.ts` — найти:

```ts
        '--model',
        '{model}',
        '--agent',
        '{agent}',
        '{prompt}',
      ],
      mcpConfig: 'json-file',
    },
  },
};
```

заменить на:

```ts
        '--model',
        '{model}',
        // Effort из карты: без флага возобновлённая сессия ушла бы на умолчание Claude Code.
        '--effort',
        '{effort}',
        '--agent',
        '{agent}',
        '{prompt}',
      ],
      mcpConfig: 'json-file',
    },
  },
};
```

Три замены в `packages/core/src/work/launch.ts`. Выбор переезжает из ветки нового запуска в общую часть `plan()`. У GLM `?? entry.runner.settingsModel` раньше стоял в отдельном `if`: значение то же, теперь и для resume.

`packages/core/src/work/launch.ts` — найти:

```ts
  /**
   * Модель и усилие новой сессии из диалога окна. Доезжают только до провайдера, у которого
   * в шаблоне запуска есть их подстановки (`supportsModel`, `supportsEffort`), и только при
   * запуске у Claude/Codex; GLM resume явно берёт настроенную модель, поскольку tier aliases
   * подавляют восстановление модели CLI. Выбор Chat /model отдельно не сохраняется. Выбор из диалога
   * в карте не хранится. Перекрывают выбор, записанный в сессию `spawn_session`ом
   * (`WorkSession.model`, `.effort`): его хост подставляет сам, когда поднимает `pending`.
   */
```

заменить на:

```ts
  /**
   * Модель и усилие из диалога окна. Доезжают только до провайдера, у которого в шаблоне есть
   * их подстановки (`supportsModel`, `supportsEffort`). Перекрывают выбор, записанный в карте
   * (`WorkSession.model`, `.effort`), — и при запуске, и при `resume`; без них берётся записанный.
   */
```

`packages/core/src/work/launch.ts` — найти:

```ts
  if (entry.runner.settingsModel !== undefined) {
    subs.model = options.model ?? session.model ?? entry.runner.settingsModel;
  }
```

заменить на:

```ts
  // Модель и усилие — из выбора запуска, а без него из карты, во всех режимах, включая `resume`:
  // Claude Code при `--resume` effort не восстанавливает (спека нормалайзера, 5.4). Нет ни того ни
  // другого — подстановки нет, флаг выпадает, и CLI берёт своё. GLM без выбора берёт настроенную
  // модель: tier aliases не дают Claude Code восстановить её самому.
  const model = options.model ?? session.model ?? entry.runner.settingsModel;
  if (model !== undefined) subs.model = model;
  const effort = options.effort ?? session.effort;
  if (effort !== undefined) subs.effort = effort;
```

`packages/core/src/work/launch.ts` — найти:

```ts
    if (first !== '') subs.prompt = first;
    const model = options.model ?? session.model;
    if (model !== undefined) subs.model = model;
    const effort = options.effort ?? session.effort;
    if (effort !== undefined) subs.effort = effort;
    if (entry.linkBy === 'session-id') {
```

заменить на:

```ts
    if (first !== '') subs.prompt = first;
    if (entry.linkBy === 'session-id') {
```

Документация поля в `packages/core/src/work/types.ts`:

`packages/core/src/work/types.ts` — найти:

```ts
  /**
   * Модель и усилие, с которыми запускается новая сессия, — их задаёт `spawn_session` (`model`, `effort`).
   * Запускает такую сессию хост позже и без диалога, поэтому выбор ложится в карту, а `planLaunch` берёт
   * его оттуда; выбор из диалога окна в карте не хранится и перекрывает эти поля. Нет поля — модель и
   * усилие по умолчанию, без флагов. На диске поля может не быть: `parseMap` их не подставляет.
   */
```

заменить на:

```ts
  /**
   * Модель и усилие сессии: с ними строятся и запуск, и `resume` (`plan` в `launch.ts`), а выбор
   * запуска их перекрывает. Нет поля — «Default»: без флага, CLI берёт своё. Усилие — id уровня из
   * каталога модели: значение, не проходящее `EFFORT_TOKEN`, `parseMap` читает как «нет выбора». На
   * диске полей может не быть: `parseMap` их не подставляет.
   */
```

`packages/core/src/work/map.ts`. Значение из `providers.js` образует цикл импорта `map → providers → store → map`. Он безвреден: токен читается только внутри функции, как и в уже существующем цикле `providers ↔ work/channel`.

`packages/core/src/work/map.ts` — найти:

```ts
import type { EffortLevel } from '../providers.js';
```

заменить на:

```ts
import { EFFORT_TOKEN, type EffortLevel } from '../providers.js';
```

`packages/core/src/work/map.ts` — найти:

```ts
/** Полей процесса в старых картах просто не было. */
function migrateSession(session: Record<string, unknown>): void {
```

заменить на:

```ts
/** Полей процесса в старых картах просто не было; испорченный effort читается как «нет выбора». */
function migrateSession(session: Record<string, unknown>): void {
```

`packages/core/src/work/map.ts` — найти:

```ts
  // Worktree появился в куске 4.1: до него все сессии работали прямо в проекте.
  session['worktree'] ??= null;
}
```

заменить на:

```ts
  // Worktree появился в куске 4.1: до него все сессии работали прямо в проекте.
  session['worktree'] ??= null;
  // Effort уходит в команду, у Codex — в кавычки TOML: значение, не прошедшее токен, не уходит никуда.
  // Ключ убирается из прочитанной карты, и следующая её запись его уже не несёт.
  const effort = session['effort'];
  if (effort !== undefined && (typeof effort !== 'string' || !EFFORT_TOKEN.test(effort))) {
    delete session['effort'];
  }
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `pnpm --filter @parley/core exec vitest run src/providers.test.ts src/work/launch.test.ts src/work/map.test.ts test/frame-check.test.ts`
Expected: `Tests  265 passed (265)`. Проверка номера: `grep -n 'codex/config' packages/core/src/providers.ts` → `17` и `248`.

Run: `pnpm --filter @parley/core exec vitest run`
Expected: все 72 файла зелёные.

Run: `pnpm --filter @parley/core build && pnpm --filter @parley/host exec vitest run src/sessions/sessions-service.test.ts src/wake/wake-service.test.ts src/methods/providers.test.ts src/sessions/model-choice.test.ts`
Expected: все зелёные. У сессий в тестах подъёма письмом выбора в карте нет, поэтому argv `--resume` у них прежний. Тест хоста с `spawn_session`-выбором (`sessions-service.test.ts`, «pending от spawn_session запускается с записанными моделью и усилием») идёт через `launch` и тоже не меняется.

- [ ] **Step 5: Typecheck и lint**

Run: `pnpm typecheck && pnpm lint`
Expected: без ошибок.

- [ ] **Step 6: Коммит**

```bash
git add packages/core/src/providers.ts packages/core/src/work/launch.ts packages/core/src/work/types.ts packages/core/src/work/map.ts packages/core/src/providers.test.ts packages/core/src/work/launch.test.ts packages/core/src/work/map.test.ts packages/core/test/frame-check.test.ts
git commit -m "feat(core): resume Claude и GLM несёт модель и effort из карты; испорченный effort в карте — «нет выбора»" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Каталог Codex из файла хоста в `loadProviders` — один список для окна, хоста и MCP (спека 5.2)

Спека 5.2, абзац «Общий для окна и MCP». MCP-сервер агента — отдельный процесс, и память хоста ему не видна. Поэтому живой каталог Codex доходит до `get_map` и `spawn_session` через файл Parley, который пишет хост, а читает `loadProviders`.

**Files:**
- Modify: `packages/core/src/providers.ts`:
  - строка документации `ProviderEntry.models` (`:91` после Task 1; число строк не меняется, номер в рамочном тесте остаётся `248`);
  - после `providersFile()` (`:642-644` по исходной ветке) — новые `codexModelsFile()`, `MODEL_LABEL_MAX` и `EFFORT_DESCRIPTION_MAX`;
  - перед `checkShape` — `isEffortOption` и `readCodexModels`;
  - `loadProviders` (`:778-798` по исходной ветке) — документация, второй параметр, подстановка.
- Modify: `packages/core/src/index.ts` (экспорт `codexModelsFile`, `MODEL_LABEL_MAX`, `EFFORT_DESCRIPTION_MAX`)
- Test: `packages/core/src/providers.test.ts` (импорт; новый `describe` внутри `describe('переопределения из PARLEY_HOME/providers.json')`, перед «чужая форма записи — ошибка»)

**Interfaces:**
- Consumes: из Task 1 — `ModelOption`, `EffortOption`. Из Task 2 — `EFFORT_TOKEN` и импорт `type EffortOption` в `providers.ts`. От Task 3 и Task 4 не зависит.
- Produces:
  - `export function codexModelsFile(): string` — `path.join(parleyHome(), 'codex-models.json')`, и из `@parley/core`.
  - `export const MODEL_LABEL_MAX = 100`, `export const EFFORT_DESCRIPTION_MAX = 300` (и из `@parley/core`) — пределы подписи модели и описания уровня из каталога CLI. Длиннее обрезают и чтение файла здесь, и разбор `codex debug models` в хосте (Task 8).
  - `loadProviders(file = providersFile(), codexFile = codexModelsFile())`. Целый непустой файл подменяет `codex.models` до `providers.json`, а `models` из `providers.json` важнее него. Файла нет, он испорчен или пуст — молча действует запасной `CODEX_MODELS`. В запись ложатся только известные поля, `fetchedAt` core не читает.
  - Формат файла (пишет хост): `{ "fetchedAt": "<ISO>", "models": [{ "id", "label", "efforts"?: [{ "id", "label", "description"? }] | null }] }`. id моделей — по правилу `modelChoiceError` (`/^[^\s-]\S*$/`, не длиннее 200) и без повторов, id уровней — `EFFORT_TOKEN` и без повторов, списки уровней непустые. Модель с id не того вида делает файл испорченным: он не читается целиком.

- [ ] **Step 1: Написать падающие тесты**

Две замены в `packages/core/src/providers.test.ts`:

`packages/core/src/providers.test.ts` — найти (импорт после Task 2):

```ts
  EFFORT_TOKEN,
  PROVIDERS,
  commandInPath,
```

заменить на:

```ts
  EFFORT_DESCRIPTION_MAX,
  EFFORT_TOKEN,
  MODEL_LABEL_MAX,
  PROVIDERS,
  codexModelsFile,
  commandInPath,
```

`packages/core/src/providers.test.ts` — найти:

```ts
  it('чужая форма записи — ошибка', async () => {
```

заменить на:

```ts
  describe('каталог Codex из файла хоста (спека нормалайзера модели и effort, 5.2)', () => {
    /** Модели, как их пишет хост из `codex debug models`: подписи — `display_name`, описания уровней — каталога. */
    const LIVE = [
      {
        id: 'gpt-7-sol',
        label: 'GPT-7-Sol',
        efforts: [
          { id: 'low', label: 'Low', description: 'Fast responses with lighter reasoning' },
          { id: 'ultra', label: 'Ultra' },
        ],
      },
      { id: 'gpt-7-mini', label: 'GPT-7-Mini', efforts: null },
    ];
    const writeLive = (data: unknown): Promise<void> =>
      writeFile(codexModelsFile(), JSON.stringify(data), 'utf8');

    it('файл лежит в доме Parley; нет файла — запасной список', async () => {
      expect(codexModelsFile()).toBe(path.join(home, 'codex-models.json'));
      expect(selectableModels((await loadProviders())['codex'] as ProviderEntry)).toEqual(
        selectableModels(PROVIDERS.codex),
      );
    });

    it('модели из файла хоста заменяют запасной список Codex — тот же список видят окно и MCP; соседи не тронуты', async () => {
      await writeLive({ fetchedAt: '2026-10-06T10:00:00.000Z', models: LIVE });
      const registry = await loadProviders();
      const codex = registry['codex'] as ProviderEntry;

      expect(selectableModels(codex)).toStrictEqual(LIVE);
      expect(resolveModelEffort(codex, { model: 'gpt-7-sol', effort: 'ultra' })).toStrictEqual({
        choice: { model: 'gpt-7-sol', effort: 'ultra' },
      });
      expect(resolveModelEffort(codex, { model: 'gpt-6.1-sol' })).toMatchObject({ error: expect.stringContaining('gpt-7-sol') });
      expect(selectableModels(registry['claude'] as ProviderEntry)).toEqual(selectableModels(PROVIDERS.claude));
      expect(selectableModels(PROVIDERS.codex)?.[0]?.id).toBe('gpt-6.1-sol');
    });

    it('models из providers.json важнее файла хоста', async () => {
      await writeLive({ fetchedAt: '2026-10-06T10:00:00.000Z', models: LIVE });
      await write({ codex: { models: [{ id: 'mine', label: 'Моя' }] } });

      expect(selectableModels((await loadProviders())['codex'] as ProviderEntry)).toStrictEqual([
        { id: 'mine', label: 'Моя' },
      ]);
    });

    it('в запись ложатся только известные поля: лишнее из файла до окна не доходит', async () => {
      await writeLive({
        fetchedAt: '2026-10-06T10:00:00.000Z',
        models: [{ id: 'a', label: 'A', priority: 1, efforts: [{ id: 'low', label: 'Low', effort: 'low' }] }],
      });

      expect(selectableModels((await loadProviders())['codex'] as ProviderEntry)).toStrictEqual([
        { id: 'a', label: 'A', efforts: [{ id: 'low', label: 'Low' }] },
      ]);
    });

    it('испорченный или пустой файл молча игнорируется: остаётся запасной список, loadProviders не падает', async () => {
      const broken = [
        '{не json',
        '[]',
        '{}',
        JSON.stringify({ models: [] }),
        JSON.stringify({ models: 'gpt-7-sol' }),
        JSON.stringify({ models: [{ id: '-x', label: 'X' }] }),
        JSON.stringify({ models: [{ id: 'a', label: 'A' }, { id: 'a', label: 'Б' }] }),
        JSON.stringify({ models: [{ id: 'a', label: 'A', efforts: [] }] }),
        JSON.stringify({ models: [{ id: 'a', label: 'A', efforts: [{ id: 'hi gh', label: 'X' }] }] }),
        JSON.stringify({ models: [{ id: 'a', label: 'A', efforts: [{ id: 'low' }] }] }),
        JSON.stringify({ models: [{ id: 'a', label: 'A', efforts: [{ id: 'low', label: 'L' }, { id: 'low', label: 'L' }] }] }),
        JSON.stringify({ models: [{ id: 'a', label: 'A', efforts: 'low' }] }),
      ];
      for (const raw of broken) {
        await writeFile(codexModelsFile(), raw, 'utf8');
        expect(selectableModels((await loadProviders())['codex'] as ProviderEntry), raw).toEqual(
          selectableModels(PROVIDERS.codex),
        );
      }
    });

    it('внешний ввод: подпись длиннее 100 и описание длиннее 300 знаков обрезаются; незнакомый уровень-токен идёт как есть', async () => {
      await writeLive({
        fetchedAt: '2026-10-06T10:00:00.000Z',
        models: [
          {
            id: 'gpt-7-sol',
            label: 'S'.repeat(150),
            efforts: [{ id: 'turbo', label: 'Turbo', description: 'd'.repeat(400) }],
          },
        ],
      });
      const codex = (await loadProviders())['codex'] as ProviderEntry;

      expect([MODEL_LABEL_MAX, EFFORT_DESCRIPTION_MAX]).toEqual([100, 300]);
      expect(selectableModels(codex)).toStrictEqual([
        {
          id: 'gpt-7-sol',
          label: 'S'.repeat(100),
          efforts: [{ id: 'turbo', label: 'Turbo', description: 'd'.repeat(300) }],
        },
      ]);
      // Уровень-токен, которого Parley не знает, не отвергается: и проверка, и подстановка — по EFFORT_TOKEN.
      expect(resolveModelEffort(codex, { model: 'gpt-7-sol', effort: 'turbo' })).toStrictEqual({
        choice: { model: 'gpt-7-sol', effort: 'turbo' },
      });
      expect(startCommand(codex, { model: 'gpt-7-sol', effort: 'turbo', prompt: 'p' }).args).toContain(
        'model_reasoning_effort="turbo"',
      );
    });

    it('id модели, который стал бы флагом или двумя аргументами `--model`, — файл не читается целиком', async () => {
      for (const id of ['-gpt', '--model', 'gpt 7', 'gpt\t7', 'x'.repeat(201)]) {
        await writeLive({
          fetchedAt: '2026-10-06T10:00:00.000Z',
          models: [{ id, label: 'X' }, { id: 'gpt-7-sol', label: 'GPT-7-Sol' }],
        });
        expect(selectableModels((await loadProviders())['codex'] as ProviderEntry), JSON.stringify(id)).toEqual(
          selectableModels(PROVIDERS.codex),
        );
      }
    });
  });

  it('чужая форма записи — ошибка', async () => {
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter @parley/core exec vitest run src/providers.test.ts`
Expected: `Tests  7 failed | 113 passed (120)`, все семь новых — `codexModelsFile is not a function`.

- [ ] **Step 3: Реализация**

Пять замен в `packages/core/src/providers.ts`. Первая меняет строку документации без изменения числа строк, вторая добавляет путь и пределы рядом с `providersFile()` (ниже `:248`, номер в рамочном тесте не сдвигается):

`packages/core/src/providers.ts` — найти:

```ts
   * effort модели. У встроенных `claude`, `codex` и `glm` список — из каталога `provider-models.ts`, у
```

заменить на:

```ts
   * effort модели. У встроенных — из каталога `provider-models.ts` (у `codex` — из `codexModelsFile`, если он есть), у
```

`packages/core/src/providers.ts` — найти:

```ts
/** Необязательный файл переопределений и дополнений реестра. */
export function providersFile(): string {
  return path.join(parleyHome(), 'providers.json');
}
```

заменить на:

```ts
/** Необязательный файл переопределений и дополнений реестра. */
export function providersFile(): string {
  return path.join(parleyHome(), 'providers.json');
}

/**
 * Каталог моделей Codex, снятый хостом с `codex debug models` (спека нормалайзера, 5.2): файл Parley в доме,
 * `{ "fetchedAt": "<ISO>", "models": ModelOption[] }`. Пишет его только хост, атомарно, после удачной пробы.
 * `loadProviders` подставляет его модели в запись `codex`, поэтому окно, хост и MCP агента (отдельный
 * процесс) видят один список.
 */
export function codexModelsFile(): string {
  return path.join(parleyHome(), 'codex-models.json');
}

/**
 * Пределы подписи модели и описания уровня из каталога CLI: длиннее обрезают и разбор `codex debug models` в хосте,
 * и чтение `codexModelsFile` — внешний ввод не растягивает ни окно, ни ответ `get_map`.
 */
export const MODEL_LABEL_MAX = 100;
export const EFFORT_DESCRIPTION_MAX = 300;
```

Проверка файла — перед `checkShape`:

`packages/core/src/providers.ts` — найти:

```ts
function checkShape(id: string, file: string, patch: Record<string, unknown>): void {
  const wrong =
```

заменить на:

```ts
/** Уровень из каталога Codex: id — токен, подпись непустая, описание — строка или его нет. */
const isEffortOption = (value: unknown): value is EffortOption =>
  isRecord(value) &&
  typeof value['id'] === 'string' &&
  EFFORT_TOKEN.test(value['id']) &&
  isNonEmptyString(value['label']) &&
  (value['description'] === undefined || typeof value['description'] === 'string');

/**
 * Модели из файла каталога Codex (`codexModelsFile`). Файла нет, он не разбирается, список пуст или хоть одна
 * модель или уровень не той формы — `null`: это кэш Parley, а не настройка человека, и тогда молча действует
 * запасной список. В запись ложатся только известные поля; подпись модели и описание уровня — не длиннее
 * `MODEL_LABEL_MAX` и `EFFORT_DESCRIPTION_MAX`.
 */
async function readCodexModels(file: string): Promise<ModelOption[] | null> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  const models = isRecord(data) ? data['models'] : undefined;
  if (!isModelList(models) || models.length === 0) return null;
  const levelsValid = models.every(
    (model) =>
      model.efforts === undefined ||
      model.efforts === null ||
      (Array.isArray(model.efforts) &&
        model.efforts.length > 0 &&
        model.efforts.every(isEffortOption) &&
        new Set(model.efforts.map((level) => level.id)).size === model.efforts.length),
  );
  if (!levelsValid) return null;
  return models.map((model) => ({
    id: model.id,
    label: model.label.slice(0, MODEL_LABEL_MAX),
    ...(model.efforts === undefined
      ? {}
      : {
          efforts:
            model.efforts === null
              ? null
              : model.efforts.map((level) => ({
                  id: level.id,
                  label: level.label,
                  ...(level.description === undefined
                    ? {}
                    : { description: level.description.slice(0, EFFORT_DESCRIPTION_MAX) }),
                })),
        }),
  }));
}

function checkShape(id: string, file: string, patch: Record<string, unknown>): void {
  const wrong =
```

`loadProviders` — второй параметр и подстановка до `providers.json`:

`packages/core/src/providers.ts` — найти:

```ts
 * Встроенный реестр плюс необязательные переопределения из
 * `providers.json` дома (`parleyHome()`): merge по id, свои провайдеры добавляются.
 * Битый файл — ошибка: реестр пишем не мы, но догадываться о его форме нельзя,
 * иначе харнесс молча запустит не то, что просил пользователь.
 */
export async function loadProviders(
  file = providersFile(),
): Promise<Record<WorkProvider, ProviderEntry>> {
```

заменить на:

```ts
 * Встроенный реестр плюс необязательные переопределения из
 * `providers.json` дома (`parleyHome()`): merge по id, свои провайдеры добавляются.
 * Битый файл — ошибка: реестр пишем не мы, но догадываться о его форме нельзя,
 * иначе харнесс молча запустит не то, что просил пользователь. Модели `codex` до
 * `providers.json` берутся из каталога хоста (`codexModelsFile`), если он есть и цел.
 */
export async function loadProviders(
  file = providersFile(),
  codexFile = codexModelsFile(),
): Promise<Record<WorkProvider, ProviderEntry>> {
```

`packages/core/src/providers.ts` — найти:

```ts
      } as ProviderEntry,
    ]),
  );

  let raw: string;
```

заменить на:

```ts
      } as ProviderEntry,
    ]),
  );

  // Живой каталог Codex — раньше `providers.json`: свой список человека важнее обоих (спека нормалайзера, 5.2).
  const codex = registry['codex'];
  const live = await readCodexModels(codexFile);
  if (codex !== undefined && live !== null) registry['codex'] = { ...codex, models: live };

  let raw: string;
```

Две замены в `packages/core/src/index.ts`:

`packages/core/src/index.ts` — найти:

```ts
  EFFORT_TOKEN,
  PROVIDERS,
```

заменить на:

```ts
  EFFORT_DESCRIPTION_MAX,
  EFFORT_TOKEN,
  MODEL_LABEL_MAX,
  PROVIDERS,
```

`packages/core/src/index.ts` — найти:

```ts
  agentEnv,
  commandBinary,
```

заменить на:

```ts
  agentEnv,
  codexModelsFile,
  commandBinary,
```

- [ ] **Step 4: Тесты зелёные**

Run: `pnpm --filter @parley/core exec vitest run src/providers.test.ts test/frame-check.test.ts`
Expected: `Tests  164 passed (164)`. `grep -n 'codex/config' packages/core/src/providers.ts` → `17` и `248`, без изменений.

Run: `pnpm --filter @parley/core exec vitest run`
Expected: все 72 файла зелёные. Тесты MCP и хоста живут в своём временном доме без `codex-models.json`, поэтому видят прежний запасной список.

Run: `pnpm --filter @parley/core build && pnpm --filter @parley/host exec vitest run src/methods/providers.test.ts src/sessions/model-choice.test.ts`
Expected: `Tests  23 passed (23)`.

- [ ] **Step 5: Typecheck и lint**

Run: `pnpm typecheck && pnpm lint`
Expected: без ошибок.

- [ ] **Step 6: Коммит**

```bash
git add packages/core/src/providers.ts packages/core/src/index.ts packages/core/src/providers.test.ts
git commit -m "feat(core): модели Codex из каталога хоста (codex-models.json) в loadProviders — один список для окна и MCP" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Протокол — токен уровня effort, `efforts` у моделей, `argsOverridden` и причина `busy`

**Files:**
- Modify: `packages/protocol/src/methods.ts`:
  - 23–25: `EFFORT_TOKEN_RE` после `PermissionModeChoice`;
  - 73–84: `sessions.create.effort`;
  - 224–233: документация `providers.list` и `argsOverridden`.
- Modify: `packages/protocol/src/types.ts`: 56–60 (переэкспорт `EffortOption`), 203–221 (`HOST_ERROR_REASONS.busy`).
- Modify: `packages/protocol/src/index.ts`: 3–4 (экспорт типа), 30 (экспорт значения).
- Test: `packages/protocol/src/methods.test.ts`:
  - 1–2: импорты;
  - 250–260: `sessions.create.effort`;
  - 280–300: типы `providers.list`;
  - новый `describe` после строки 428.
- Test: `packages/protocol/src/types.test.ts` (`HOST_ERROR_REASONS`).

**Interfaces:**
- Consumes (core, только типы; Task 1): `import type { EffortOption, ModelOption } from '@parley/core'` — `EffortOption { id: string; label: string; description?: string }`, `ModelOption { id: string; label: string; efforts?: EffortOption[] | null }`. `EffortLevel = string` в core (Task 2).
- Produces (всё — из `@parley/protocol`):
  - `export const EFFORT_TOKEN_RE = /^[a-z][a-z0-9_-]{0,31}$/` — тот же `source`, что у `EFFORT_TOKEN` core; паритет сверяет тест хоста (Task 9);
  - `export type { EffortOption, ModelOption }`;
  - `Params<'sessions.create'>['effort']: string | undefined` (схема `z.string().regex(EFFORT_TOKEN_RE).optional()`);
  - элемент `Result<'providers.list'>['providers']` получает `argsOverridden?: boolean`, у его `models` — `efforts?: EffortOption[] | null`;
  - `HOST_ERROR_REASONS.busy = 'busy'` — `data.reason` отказа `conflict` «сессия занята» (хост — Task 10 и Task 11, окно — Task 13);
  - `PROTOCOL_VERSION` остаётся `1`.

Схем и результатов `sessions.setEffort` и `sessions.setModel` здесь нет: их добавляют Task 10 и Task 11 вместе с обработчиками хоста. Иначе тест хоста `packages/host/src/server.test.ts` («methods — ровно отсортированные ключи METHODS») был бы красным между задачами.

- [ ] **Step 1: Написать падающие тесты**

`packages/protocol/src/methods.test.ts`, импорты, строки 1–2. Было:
```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import { METHODS, NOTIFICATIONS } from './methods.js';
```
Стало:
```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import { EFFORT_TOKEN_RE, PROTOCOL_VERSION } from './index.js';
import type { EffortOption } from './index.js';
import { METHODS, NOTIFICATIONS } from './methods.js';
```

В `describe('модель, усилие и поля providers.list (дизайн комнат, 3.2)')`, строки 253–260. Было:
```ts
    expectTypeOf<Params<'sessions.create'>['model']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Params<'sessions.create'>['effort']>().toEqualTypeOf<'low' | 'medium' | 'high' | undefined>();
  });

  it('effort — low, medium или high; уровни, которых нет у обоих CLI, схема не пропускает', () => {
    for (const effort of ['low', 'medium', 'high']) expect(parse({ effort }).success).toBe(true);
    for (const effort of ['xhigh', 'max', 'minimal', 'HIGH', '', 3]) expect(parse({ effort }).success).toBe(false);
  });
```
Стало:
```ts
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
```

Строки 280–300. Было:
```ts
  it('providers.list: models, effort, version, limits и check необязательны — хост, переживший окно, их не знает', () => {
    expectTypeOf<Result<'providers.list'>['providers'][number]>().toEqualTypeOf<{
      id: string;
      label: string;
      available: boolean;
      needs?: 'cli' | 'key' | null;
      keyHint?: string | null;
      family?: 'claude' | null;
      models?: Array<{ id: string; label: string }> | null;
      effort?: boolean;
      version?: string | null;
      limits?: ProviderLimits | null;
      check?: ProviderCheck | null;
    }>();
    // Хост до дизайна комнат отдаёт элементы без новых полей — тип обязан это допускать.
    const legacy: Result<'providers.list'> = { providers: [{ id: 'claude', label: 'Claude', available: true }] };
    expect(legacy.providers[0]).not.toHaveProperty('effort');
  });

  it('providers.list: models — пары id и label; «списка нет» — null, а у хоста без поля его вовсе нет', () => {
    expectTypeOf<ModelOption>().toEqualTypeOf<{ id: string; label: string }>();
```
Стало (остаток последнего теста, начиная с `const shapes`, не меняется):
```ts
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
```

Дописать в конец файла (после строки 428):
```ts

describe('EFFORT_TOKEN_RE и совместимость (нормалайзер модели и effort, 5.3, 5.6)', () => {
  it('шаблон — как EFFORT_TOKEN в core: строчная буква, затем до 31 знака из строчных букв, цифр, _ и -; без флагов', () => {
    expect(EFFORT_TOKEN_RE.source).toBe('^[a-z][a-z0-9_-]{0,31}$');
    expect(EFFORT_TOKEN_RE.flags).toBe('');
  });

  it('протокол меняется только добавлениями: PROTOCOL_VERSION остаётся 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
```

`packages/protocol/src/types.test.ts` — найти:
```ts
      worksUnreadable: 'works-unreadable',
    });
```
заменить на:
```ts
      worksUnreadable: 'works-unreadable',
      // Нормалайзер модели и effort (5.7–5.8): «сессия занята» у `sessions.setEffort` и `sessions.setModel`.
      busy: 'busy',
    });
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run (из корня):
```bash
pnpm --filter @parley/core build
pnpm --filter @parley/protocol exec vitest run src/methods.test.ts src/types.test.ts
pnpm --filter @parley/protocol exec tsc --noEmit --skipLibCheck --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --module NodeNext --moduleResolution NodeNext --target ES2022 --verbatimModuleSyntax src/methods.test.ts
```
Expected от vitest: `Tests  3 failed | 47 passed (50)`:
- «effort — токен уровня: …» — `AssertionError: xhigh: expected false to be true`;
- «шаблон — как EFFORT_TOKEN в core: …» — `TypeError: Cannot read properties of undefined (reading 'source')`;
- `HOST_ERROR_REASONS` «строки причин — прежние…» — в ответе нет `busy`.

Expected от tsc: ошибки, среди них `TS2305: Module '"./index.js"' has no exported member 'EFFORT_TOKEN_RE'` (и то же для `'EffortOption'`) и `TS2344` на типе `effort`, на `efforts` и на `argsOverridden`.

Vitest типы не проверяет (`expectTypeOf`), а `packages/protocol/tsconfig.json` тесты не компилирует: утверждения о типах держит команда tsc.

- [ ] **Step 3: Реализация**

`packages/protocol/src/methods.ts`, строки 24–25. Было:
```ts
export const permissionModeChoice = z.enum(['default', 'acceptEdits', 'plan', 'auto']);
export type PermissionModeChoice = z.infer<typeof permissionModeChoice>;
```
Стало:
```ts
export const permissionModeChoice = z.enum(['default', 'acceptEdits', 'plan', 'auto']);
export type PermissionModeChoice = z.infer<typeof permissionModeChoice>;

/**
 * Токен уровня effort (нормалайзер модели и effort, 5.3): строчная латинская буква, затем до 31 знака
 * из строчных букв, цифр, `_` и `-`. Такой токен безопасен и отдельным элементом argv (`--effort <id>`),
 * и внутри кавычек TOML (`-c model_reasoning_effort="<id>"`). Шаблон — тот же, что `EFFORT_TOKEN` в core:
 * протокол берёт из core только типы, поэтому держит свою копию, а совпадение сверяет тест хоста.
 */
export const EFFORT_TOKEN_RE = /^[a-z][a-z0-9_-]{0,31}$/;
```

Тот же файл, строки 73–84. Было:
```ts
    // Модель и усилие из диалога запуска (дизайн комнат, 3.2). Провайдер без флага их отбрасывает
    // — окно узнаёт об этом из `providers.list`. Модель — `id` из списка провайдера
    // (`providers.list.models`): одно слово, без пробелов и не с дефиса (CLI принял бы её за флаг);
    // принадлежность списку проверяет хост (`bad_request`), схема — только вид. Пустая строка, как
    // и отсутствие поля, — «по умолчанию»: без флага, модель CLI по умолчанию. Усилие — общий для
    // обоих CLI набор.
    model: z
      .string()
      .max(200)
      .regex(/^(?:[^\s-]\S*)?$/)
      .optional(),
    effort: z.enum(['low', 'medium', 'high']).optional(),
```
Стало:
```ts
    // Модель и усилие из диалога запуска (дизайн комнат, 3.2). Провайдер без флага их отбрасывает
    // — окно узнаёт об этом из `providers.list`. Модель — `id` из списка провайдера
    // (`providers.list.models`): одно слово, без пробелов и не с дефиса (CLI принял бы её за флаг);
    // принадлежность списку проверяет хост (`bad_request`), схема — только вид. Пустая строка, как
    // и отсутствие поля, — «по умолчанию»: без флага, модель CLI по умолчанию. Усилие — токен уровня
    // (`EFFORT_TOKEN_RE`, нормалайзер модели и effort, 5.6): уровни выбранной модели
    // (`providers.list.models[].efforts`) сверяет хост (`bad_request`), схема — только вид. Прежние
    // `low`, `medium` и `high` старого окна — тоже токены и проходят.
    model: z
      .string()
      .max(200)
      .regex(/^(?:[^\s-]\S*)?$/)
      .optional(),
    effort: z.string().regex(EFFORT_TOKEN_RE).optional(),
```

Тот же файл, `Results['providers.list']`, строки 224–233. Было:
```ts
      /**
       * Модели для выбора при запуске — пары `id` (значение `--model`) и `label` (подпись окна),
       * в порядке документации провайдера. «По умолчанию» в списке нет: это отсутствие выбора
       * (`sessions.create` без `model` или с пустой). `null` — списка нет: окно контрол не
       * показывает; хост тогда принимает любую модель, а провайдер без `{model}` в шаблоне
       * запуска отбрасывает её сам.
       */
      models?: ModelOption[] | null;
      /** Принимает ли провайдер усилие при запуске: нет — окно прячет контрол. */
      effort?: boolean;
```
Стало:
```ts
      /**
       * Модели для выбора при запуске — пары `id` (значение `--model`) и `label` (подпись окна),
       * в порядке документации провайдера. «По умолчанию» в списке нет: это отсутствие выбора
       * (`sessions.create` без `model` или с пустой). `null` — списка нет: окно контрол не
       * показывает; хост тогда принимает любую модель, а провайдер без `{model}` в шаблоне
       * запуска отбрасывает её сам. `efforts` модели — её уровни effort по порядку (нормалайзер
       * модели и effort, 5.1): `null` — уровней нет (Haiku), поля нет — хост до нормалайзера или свой
       * список в `providers.json`; тогда действуют прежние `low`, `medium` и `high`.
       */
      models?: ModelOption[] | null;
      /** Принимает ли провайдер усилие при запуске: нет — окно прячет контрол. */
      effort?: boolean;
      /**
       * `args` провайдера заменены записью `providers.json` (нормалайзер модели и effort, 5.6): без
       * `{model}` или `{effort}` в них выбор модели или усилия выключен, и карточка провайдера объясняет
       * почему. Поля нет — замены нет или хост до нормалайзера.
       */
      argsOverridden?: boolean;
```

`packages/protocol/src/types.ts`, строки 56–60. Было:
```ts
/**
 * Модель в списке провайдера (`providers.list`, дизайн комнат, 3.2): `id` — значение `--model`,
 * `label` — подпись для окна. Тип живёт в core рядом с реестром, откуда список и берётся.
 */
export type { ModelOption } from '@parley/core';
```
Стало:
```ts
/**
 * Модель в списке провайдера (`providers.list`, дизайн комнат, 3.2): `id` — значение `--model`,
 * `label` — подпись для окна, `efforts` — её уровни effort (нормалайзер модели и effort, 5.1). Уровень
 * (`EffortOption`): `id` — значение флага, `label` — подпись, `description` — пояснение каталога CLI.
 * Типы живут в core рядом с реестром, откуда список и берётся.
 */
export type { EffortOption, ModelOption } from '@parley/core';
```

Тот же файл, `HOST_ERROR_REASONS` — найти:
```ts
 * - `works-unreadable` (`internal`) — первое чтение работ хостом отказало, снимка нет до перезапуска
 *   хоста (раунд lane-r5).
 */
export const HOST_ERROR_REASONS = {
```
заменить на:
```ts
 * - `works-unreadable` (`internal`) — первое чтение работ хостом отказало, снимка нет до перезапуска
 *   хоста (раунд lane-r5);
 * - `busy` (`conflict`) — смену модели или effort идущей сессии хост сейчас не делает: агент работает или ждёт
 *   человека, держат фоновые задачи, в поле ввода терминала черновик, ползунок `/effort` уже открыт или идёт
 *   другая смена той же сессии (нормалайзер модели и effort, 5.7–5.8).
 */
export const HOST_ERROR_REASONS = {
```
и найти:
```ts
  worksUnreadable: 'works-unreadable',
} as const;
```
заменить на:
```ts
  worksUnreadable: 'works-unreadable',
  busy: 'busy',
} as const;
```

`packages/protocol/src/index.ts`, строки 3–4. Было:
```ts
export type {
  ErrorCode,
```
Стало:
```ts
export type {
  EffortOption,
  ErrorCode,
```
Строка 30. Было:
```ts
export { METHODS, NOTIFICATIONS, permissionModeChoice, sessionRef } from './methods.js';
```
Стало:
```ts
export { EFFORT_TOKEN_RE, METHODS, NOTIFICATIONS, permissionModeChoice, sessionRef } from './methods.js';
```

- [ ] **Step 4: Убедиться, что всё зелёное**

Run (из корня):
```bash
pnpm --filter @parley/protocol test
pnpm --filter @parley/protocol exec tsc --noEmit --skipLibCheck --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --module NodeNext --moduleResolution NodeNext --target ES2022 --verbatimModuleSyntax src/methods.test.ts
pnpm --filter @parley/protocol build
pnpm exec eslint packages/protocol/src
pnpm --filter @parley/host build
pnpm --filter @parley/host exec vitest run src/server.test.ts src/methods/sessions.test.ts src/methods/providers.test.ts
```
Expected:
- protocol: `Test Files  5 passed (5)`, `Tests  92 passed (92)`; tsc, сборка и eslint — exit 0;
- сборка хоста — exit 0: `Params<'sessions.create'>['effort']` теперь `string`, и `CreateSessionInput.effort?: EffortLevel` принимает его, потому что `EffortLevel = string` с Task 2;
- тесты хоста — PASS: новых методов протокол не завёл, `hello.methods` по-прежнему совпадает с ключами `METHODS`.

- [ ] **Step 5: Коммит**
```bash
git add packages/protocol/src/methods.ts packages/protocol/src/types.ts packages/protocol/src/index.ts packages/protocol/src/methods.test.ts packages/protocol/src/types.test.ts
git commit -m "feat(protocol): effort — токен уровня, efforts у моделей, argsOverridden и причина busy" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: MCP и гид — spawn_session сверяет effort с уровнями модели, get_map и гид про efforts

**Files:**
- Modify: `packages/core/src/mcp/tools.ts`:
  - 14–23: импорты;
  - 251: описание `get_map`;
  - 308–313: схема `spawn_session.effort`;
  - 547–554: аргумент `effort`;
  - 566–575: проверка пары.
- Modify: `packages/core/src/work/guide.ts` 104–111 (абзац про `model`/`effort` в теме `tools`).
- Modify (Step 6): `packages/core/src/providers.ts` — удалить `@deprecated` константу `EFFORT_LEVELS` (её оставил Task 2).
- Test: `packages/core/src/mcp/server.test.ts`:
  - 22–23: импорт `planLaunch`;
  - 284–297: тест схемы;
  - 367: описание `get_map`;
  - после 516: тест `efforts` в `get_map`;
  - 978–990: вместо одного теста — пять;
  - 1028–1042: тест «выбор отбрасывается молча».
- Test: `packages/core/src/work/guidance.test.ts` 255–264.

**Interfaces:**
- Consumes (core, Task 1–5):
  - `resolveModelEffort(entry: ProviderEntry, choice: ModelEffortChoice): ModelEffortResolution` из `../providers.js` (Task 2), где `ModelEffortChoice = { model?: string; effort?: string }` и `ModelEffortResolution = { choice: ModelEffortChoice } | { error: string }`. Тексты ошибок: `${model ?? 'the default model'} has no effort levels; omit effort` и `${effort} is not a level of ${model ?? 'the default model'}; allowed: a, b, c`. Флаг без подстановки в шаблоне resolver отбрасывает сам — и модель, и усилие;
  - прежние `selectableModels`, `supportsEffort`, `loadProviders`, `providerReadiness`, `providerReadinessError`;
  - каталоги `CLAUDE_MODELS` / `GLM_MODELS` / `CODEX_MODELS` с `efforts` (Task 1);
  - `WorkSession.effort?: string` (Task 2, Task 4);
  - прежний `planLaunch(projectPath, workId, session, options?)` из `../work/launch.js` (только тесты).
- Produces:
  - MCP `spawn_session.inputSchema.properties.effort = { type: 'string', description: "The new session's reasoning effort: one of the efforts of the chosen model in get_map; with the default model, the levels shared by its provider's models. A provider with effort: false drops the value. Without the field, the default effort." }`, без `enum`;
  - `get_map.providers[].models[].efforts` (через прежний `selectableModels(entry)`);
  - ошибки `spawn_session` — тексты resolver; при ошибке в карту ничего не пишется;
  - новый текст `GUIDE` (тема `tools`).

- [ ] **Step 1: Написать падающие тесты**

`packages/core/src/mcp/server.test.ts`, строки 22–23. Было:
```ts
import { activityOf } from '../work/activity.js';
import { openEvents } from '../work/events.js';
```
Стало:
```ts
import { activityOf } from '../work/activity.js';
import { openEvents } from '../work/events.js';
import { planLaunch } from '../work/launch.js';
```

Строки 284–297. Было:
```ts
  it('spawn_session: model и effort необязательны, effort — три уровня, описание отсылает к get_map', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const spawn = tools.find((tool) => tool.name === 'spawn_session');

    expect(spawn?.inputSchema.required).toEqual(['provider', 'label', 'task']);
    expect(spawn?.inputSchema.properties?.['model']).toMatchObject({ type: 'string' });
    expect(spawn?.inputSchema.properties?.['effort']).toMatchObject({
      type: 'string',
      enum: ['low', 'medium', 'high'],
    });
    expect(JSON.stringify(spawn?.inputSchema.properties?.['model'])).toContain('get_map');
    expect(JSON.stringify(spawn?.inputSchema.properties?.['effort'])).toContain('get_map');
  });
```
Стало:
```ts
  it('spawn_session: model и effort необязательны, у effort нет enum — уровни у каждой модели свои, описание отсылает к get_map', async () => {
    const client = await connect('s-01');
    const { tools } = await client.listTools();
    const spawn = tools.find((tool) => tool.name === 'spawn_session');
    const effort = spawn?.inputSchema.properties?.['effort'] as
      | { type?: string; enum?: unknown; description?: string }
      | undefined;

    expect(spawn?.inputSchema.required).toEqual(['provider', 'label', 'task']);
    expect(spawn?.inputSchema.properties?.['model']).toMatchObject({ type: 'string' });
    expect(effort?.type).toBe('string');
    // Нормалайзер модели и effort (5.6): закрытого списка больше нет — у Claude пять уровней,
    // у Codex до ultra.
    expect(effort).not.toHaveProperty('enum');
    expect(effort?.description).toContain('one of the efforts of the chosen model in get_map');
    expect(effort?.description).toContain("with the default model, the levels shared by its provider's models");
    expect(effort?.description).toContain('A provider with effort: false drops the value');
    expect(JSON.stringify(spawn?.inputSchema.properties?.['model'])).toContain('get_map');
  });
```

Строка 367 (тест «описание get_map отсылает ко второму слою гида»). Было:
```ts
    expect(getMap?.description).toMatch(/the detailed guide is the read_guide tool$/);
```
Стало:
```ts
    expect(getMap?.description).toMatch(/the detailed guide is the read_guide tool$/);
    expect(getMap?.description).toContain('models with their effort levels');
```

В `describe('get_map')`, сразу после теста «провайдеры несут то же, что providers.list окна…» (он кончается на строке 516 строками `expect(byId('glm')).toMatchObject({ models: selectableModels(PROVIDERS.glm), effort: true });` и `});`), вставить:
```ts

  it('модели несут свои уровни effort (нормалайзер, 5.6): у Claude и GLM пять, у Haiku — null, у Codex свои наборы', async () => {
    const client = await connect('s-01');
    const result = await callOk(client, 'get_map');
    type Effort = { id: string; label: string; description?: string };
    const providers = result['providers'] as {
      id: string;
      models: { id: string; efforts?: Effort[] | null }[] | null;
    }[];
    const model = (provider: string, id: string) =>
      providers.find((entry) => entry.id === provider)?.models?.find((option) => option.id === id);
    const levels = (provider: string, id: string) =>
      model(provider, id)?.efforts?.map((effort) => effort.id);

    expect(levels('claude', 'opus')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(levels('claude', 'best')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // У Haiku effort нет: агент видит это по null и поле effort не шлёт.
    expect(model('claude', 'haiku')?.efforts).toBeNull();
    expect(levels('glm', 'glm-5.3-flash[1m]')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(levels('codex', 'gpt-6.1-sol')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(levels('codex', 'gpt-6-luna')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // Подпись и описание уровня — те же, что видит окно.
    expect(model('codex', 'gpt-6.1-sol')?.efforts?.at(-1)).toEqual({
      id: 'ultra',
      label: 'Ultra',
      description: 'Maximum reasoning with automatic task delegation',
    });
  });
```

В `describe('spawn_session: модель и усилие')`, строки 978–990. Было:
```ts
  it('усилие вне трёх уровней — ошибка с перечнем, записи нет', async () => {
    const client = await connect('s-01');
    const result = await call(client, 'spawn_session', {
      provider: 'claude',
      label: 'бэк',
      task: 'делать',
      effort: 'extreme',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('low | medium | high');
    expect((await readMapFile()).sessions).toHaveLength(1);
  });
```
Стало:
```ts
  it('уровень не из уровней модели — ошибка с допустимыми, записи нет', async () => {
    process.env.PARLEY_CODEX_BIN = path.join(binDir, 'claude');
    const client = await connect('s-01');
    const cases = [
      { provider: 'claude', model: 'opus', effort: 'ultra', allowed: 'low, medium, high, xhigh, max' },
      { provider: 'claude', model: 'sonnet', effort: 'extreme', allowed: 'low, medium, high, xhigh, max' },
      // У Luna нет ultra, хотя у соседних моделей Codex он есть: сверка — по уровням выбранной модели.
      { provider: 'codex', model: 'gpt-6-luna', effort: 'ultra', allowed: 'low, medium, high, xhigh, max' },
    ];
    for (const { provider, model, effort, allowed } of cases) {
      const result = await call(client, 'spawn_session', {
        provider,
        label: 'бэк',
        task: 'делать',
        model,
        effort,
      });

      expect(result.isError, `${model}/${effort}`).toBe(true);
      expect(result.text).toContain(`${effort} is not a level of ${model}; allowed: ${allowed}`);
    }
    expect((await readMapFile()).sessions).toHaveLength(1);
  });

  it('модель по умолчанию — общие уровни моделей провайдера: xhigh у claude ложится в запись, ultra у codex — ошибка', async () => {
    process.env.PARLEY_CODEX_BIN = path.join(binDir, 'claude');
    const client = await connect('s-01');
    // Пустая модель — «по умолчанию», как и отсутствие поля.
    await callOk(client, 'spawn_session', {
      provider: 'claude',
      label: 'бэк',
      task: 'делать',
      model: '',
      effort: 'xhigh',
    });
    const stored = session(await readMapFile(), 's-02');
    expect('model' in stored).toBe(false);
    expect(stored.effort).toBe('xhigh');

    // У моделей Luna нет ultra, поэтому нет его и у «по умолчанию» Codex.
    const refused = await call(client, 'spawn_session', {
      provider: 'codex',
      label: 'бэк',
      task: 'делать',
      effort: 'ultra',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(
      'ultra is not a level of the default model; allowed: low, medium, high, xhigh, max',
    );
    expect((await readMapFile()).sessions).toHaveLength(2);
  });

  it('у Haiku уровней нет: effort с ним — ошибка «omit effort», записи нет; без effort — проходит', async () => {
    const client = await connect('s-01');
    const refused = await call(client, 'spawn_session', {
      provider: 'claude',
      label: 'бэк',
      task: 'делать',
      model: 'haiku',
      effort: 'low',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('haiku has no effort levels; omit effort');
    expect((await readMapFile()).sessions).toHaveLength(1);

    await callOk(client, 'spawn_session', {
      provider: 'claude',
      label: 'бэк',
      task: 'делать',
      model: 'haiku',
    });
    const stored = session(await readMapFile(), 's-02');
    expect(stored.model).toBe('haiku');
    expect('effort' in stored).toBe(false);
  });

  it('уровень не токеном — ошибка, записи нет: значение ушло бы в argv и в кавычки TOML', async () => {
    const client = await connect('s-01');
    for (const effort of ['HIGH', 'hi gh', '"max', 'a'.repeat(33), 3]) {
      const result = await call(client, 'spawn_session', {
        provider: 'claude',
        label: 'бэк',
        task: 'делать',
        effort,
      });
      expect(result.isError, String(effort)).toBe(true);
    }
    expect((await readMapFile()).sessions).toHaveLength(1);
  });

  it('xhigh и ultra ложатся в запись и уезжают в argv ровно одной парой флагов — как выбор из окна', async () => {
    process.env.PARLEY_CODEX_BIN = path.join(binDir, 'claude');
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', {
      provider: 'claude',
      label: 'бэк',
      task: 'делать',
      model: 'opus',
      effort: 'xhigh',
    });
    await callOk(client, 'spawn_session', {
      provider: 'codex',
      label: 'тесты',
      task: 'прогнать',
      model: 'gpt-6.1-sol',
      effort: 'ultra',
    });

    const map = await readMapFile();
    expect(session(map, 's-02')).toMatchObject({ model: 'opus', effort: 'xhigh' });
    expect(session(map, 's-03')).toMatchObject({ model: 'gpt-6.1-sol', effort: 'ultra' });

    // Хост поднимает pending без диалога: флаги берутся из записи (`planLaunch`).
    const claude = (await planLaunch(project, workId, session(map, 's-02'))).args;
    expect(claude.filter((arg) => arg === '--model')).toHaveLength(1);
    expect(claude.filter((arg) => arg === '--effort')).toHaveLength(1);
    expect(claude[claude.indexOf('--model') + 1]).toBe('opus');
    expect(claude[claude.indexOf('--effort') + 1]).toBe('xhigh');
    const codex = (await planLaunch(project, workId, session(map, 's-03'))).args;
    expect(codex.filter((arg) => arg === '--model')).toHaveLength(1);
    expect(codex[codex.indexOf('--model') + 1]).toBe('gpt-6.1-sol');
    expect(codex.filter((arg) => arg.startsWith('model_reasoning_effort='))).toEqual([
      'model_reasoning_effort="ultra"',
    ]);
  });
```

Строки 1028–1042. Было:
```ts
  it('провайдер без флагов в шаблоне выбор отбрасывает молча: запись заводится без него', async () => {
    await withProviders();
    const client = await connect('s-01');
    await callOk(client, 'spawn_session', {
      provider: 'plain',
      label: 'бэк',
      task: 'делать',
      model: 'anything',
      effort: 'high',
    });

    const stored = session(await readMapFile(), 's-02');
    expect('model' in stored).toBe(false);
    expect('effort' in stored).toBe(false);
  });
```
Стало:
```ts
  it('провайдер без флагов в шаблоне выбор отбрасывает молча: запись заводится без него', async () => {
    await withProviders();
    const client = await connect('s-01');
    // В get_map у такого провайдера effort: false: уровень не сверяется ни с чем и отбрасывается молча,
    // даже тот, которого нет ни у одной модели (так и говорят гид и описание spawn_session).
    for (const effort of ['high', 'ultra']) {
      await callOk(client, 'spawn_session', {
        provider: 'plain',
        label: 'бэк',
        task: 'делать',
        model: 'anything',
        effort,
      });
    }

    for (const id of ['s-02', 's-03']) {
      const stored = session(await readMapFile(), id);
      expect('model' in stored, id).toBe(false);
      expect('effort' in stored, id).toBe(false);
    }
  });
```

`packages/core/src/work/guidance.test.ts`, строки 255–264. Было:
```ts
  it('spawn_session: model — id из models провайдера в get_map, не из списка — ошибка; effort — три уровня', () => {
    const tools = sectionOf('## Tools', '## Rooms');

    expect(tools).toMatch(/`model` is an `id` from the `models` field of the right provider in `get_map`/);
    expect(tools).toMatch(/a value not in the list is an error, and the session is not created/);
    expect(tools).toMatch(/`models: null` has no list/);
    expect(tools).toMatch(/`low`, `medium` or `high`/);
    expect(tools).toMatch(/`effort: false` in `get_map` does not accept it, and the value is dropped/);
    expect(tools).toMatch(/it does not change a sleeping session that a message woke up/);
  });
```
Стало:
```ts
  it('spawn_session: model — id из models провайдера в get_map, не из списка — ошибка; effort — уровни выбранной модели', () => {
    const tools = sectionOf('## Tools', '## Rooms');

    expect(tools).toMatch(/`model` is an `id` from the `models` field of the right provider in `get_map`/);
    expect(tools).toMatch(/a value not in the list is an error, and the session is not created/);
    expect(tools).toMatch(/`models: null` has no list/);
    // Нормалайзер модели и effort (5.6): гид говорит то же, что описание `effort` у spawn_session.
    expect(tools).toMatch(/`effort` is the `id` of one of the `efforts` of the chosen model in `get_map`/);
    expect(tools).toMatch(/with the default model, one of the levels shared by its provider's models/);
    expect(tools).toMatch(/A model with `efforts: null` \(Haiku\) has no levels: omit `effort` for it/);
    expect(tools).toMatch(
      /A level that does not fit is an error that names the allowed levels, and the session is not created/,
    );
    expect(tools).toMatch(/`effort: false` in `get_map` does not accept it, and the value is dropped/);
    // Прежнего закрытого списка из трёх уровней в гиде нет.
    expect(GUIDE).not.toMatch(/`low`, `medium` or `high`/);
  });

  it('spawn_session: выбор хранится в записи — разбуженная письмом сессия возобновляется с той же моделью и effort', () => {
    const tools = sectionOf('## Tools', '## Rooms');

    // Resume теперь передаёт модель и effort из карты (нормалайзер, 5.4): прежняя оговорка
    // «спящую не меняет» ушла.
    expect(tools).toMatch(/a session that a message wakes from sleep resumes with the same model and effort/);
    expect(tools).not.toMatch(/it does not change a sleeping session that a message woke up/);
  });
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run (из корня): `pnpm --filter @parley/core exec vitest run src/mcp/server.test.ts src/work/guidance.test.ts`

Expected: `Tests  9 failed | 205 passed (214)`. Падают:
- guidance — оба новых теста (регэксп не совпал);
- «spawn_session: … у effort нет enum …» — `expected { type: 'string', …(2) } to not have property "enum"`;
- «описание get_map отсылает ко второму слою гида» — нет `models with their effort levels`;
- «уровень не из уровней модели …» — текст `argument effort: expected one of low | medium | high, got ultra`;
- «модель по умолчанию …» и «xhigh и ultra …» — `argument effort: expected one of low | medium | high, got xhigh`;
- «у Haiku уровней нет …» — `expected false to be true`: нынешний код принимает `low` у haiku;
- «провайдер без флагов в шаблоне …» — `got ultra`.

Новый тест `efforts` в `get_map` и тест плохого токена уже зелёные. Первый — потому что `get_map` отдаёт `selectableModels(entry)` как есть, и `efforts` каталога видны с Task 1. Второй — потому что `enumArg` и сейчас отвергает эти значения. Оба закрепляют поведение, которое должно пережить Step 3.

- [ ] **Step 3: Реализация**

`packages/core/src/mcp/tools.ts`, строки 14–23. Было:
```ts
import {
  EFFORT_LEVELS,
  providerReadiness,
  providerReadinessError,
  loadProviders,
  modelChoiceError,
  selectableModels,
  supportsEffort,
  supportsModel,
} from '../providers.js';
```
Стало:
```ts
import {
  providerReadiness,
  providerReadinessError,
  loadProviders,
  resolveModelEffort,
  selectableModels,
  supportsEffort,
} from '../providers.js';
```

Строка 251 (описание `get_map`). Было:
```ts
      'The whole workspace map: sessions, their statuses, summaries and artifacts, messages — plus the list of registry providers with an availability flag in PATH and what the provider accepts at launch (models and effort for spawn_session). Call it first; the detailed guide is the read_guide tool',
```
Стало:
```ts
      'The whole workspace map: sessions, their statuses, summaries and artifacts, messages — plus the list of registry providers with an availability flag in PATH and what the provider accepts at launch (models with their effort levels, and effort, for spawn_session). Call it first; the detailed guide is the read_guide tool',
```

Строки 308–313. Было:
```ts
        effort: {
          type: 'string',
          enum: [...EFFORT_LEVELS],
          description:
            "The new session's reasoning effort. A provider with effort: false in get_map drops the value. Without the field — the default effort.",
        },
```
Стало:
```ts
        effort: {
          type: 'string',
          description:
            "The new session's reasoning effort: one of the efforts of the chosen model in get_map; with the default model, the levels shared by its provider's models. A provider with effort: false drops the value. Without the field, the default effort.",
        },
```

Строки 547–554. Было:
```ts
  // Модель и усилие тоже необязательны; пустая строка — как отсутствие: агенты шлют её на любой
  // необязательный параметр.
  const model =
    args['model'] === undefined || args['model'] === '' ? undefined : stringArg(args, 'model');
  const effort =
    args['effort'] === undefined || args['effort'] === ''
      ? undefined
      : enumArg(args, 'effort', EFFORT_LEVELS);
```
Стало:
```ts
  // Модель и усилие тоже необязательны; пустая строка — как отсутствие: агенты шлют её на любой
  // необязательный параметр. Вид значений и принадлежность спискам сверяет `resolveModelEffort` ниже.
  const model =
    args['model'] === undefined || args['model'] === '' ? undefined : stringArg(args, 'model');
  const effort =
    args['effort'] === undefined || args['effort'] === '' ? undefined : stringArg(args, 'effort');
```

Строки 566–575. Было:
```ts
  // Модель проверяем до записи, как и роль: значение не из списка провайдера — отказ, а не `pending`,
  // который нечем запустить. Провайдер, чей шаблон запуска не принимает флаг, выбор отбрасывает молча —
  // как `sessions.create` хоста: окно узнаёт об этом из `providers.list`, агент — из `get_map`.
  let chosenModel: string | undefined;
  if (model !== undefined) {
    const refusal = modelChoiceError(entry, model);
    if (refusal !== null) throw new Error(refusal);
    if (supportsModel(entry)) chosenModel = model;
  }
  const chosenEffort = effort !== undefined && supportsEffort(entry) ? effort : undefined;
```
Стало:
```ts
  // Пару проверяем до записи, как и роль: модель не из списка провайдера или уровень не из уровней модели
  // (у «по умолчанию» — общих уровней моделей провайдера) — отказ, а не `pending`, который нечем
  // запустить. Правило одно с `sessions.create` хоста — `resolveModelEffort` в core (нормалайзер, 5.3).
  // Флаг, которого нет в шаблоне запуска провайдера, resolver отбрасывает молча — и модель, и усилие; окно
  // узнаёт об этом из `providers.list`, агент — из `get_map`.
  const resolved = resolveModelEffort(entry, {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  });
  if ('error' in resolved) throw new Error(resolved.error);
  const chosenModel = resolved.choice.model;
  const chosenEffort = resolved.choice.effort;
```
Вызов `addSession(...)` ниже не меняется: он и так раскрывает `chosenModel` и `chosenEffort`, только когда они заданы. `enumArg` нужен и дальше (`report`, `send_message`). `modelChoiceError` и `supportsModel` здесь больше не импортируются: модель проверяет и отбрасывает сам resolver (Task 2).

`packages/core/src/work/guide.ts`, тема `tools`, строки 108–111. Было:
```ts
a model as a flag, otherwise it is dropped. \`effort\` is \`low\`, \`medium\` or \`high\`; a
provider with \`effort: false\` in \`get_map\` does not accept it, and the value is dropped.
Without them the session runs on the default model and effort. The choice applies to the
launch of a new session: it does not change a sleeping session that a message woke up.
```
Стало:
```ts
a model as a flag, otherwise it is dropped. \`effort\` is the \`id\` of one of the \`efforts\`
of the chosen model in \`get_map\`; with the default model, one of the levels shared by its
provider's models. A model with \`efforts: null\` (Haiku) has no levels: omit \`effort\` for
it. A level that does not fit is an error that names the allowed levels, and the session is
not created. A provider with \`effort: false\` in \`get_map\` does not accept it, and the
value is dropped. Without them the session runs on the default model and effort. The choice
is kept in the session's record: a session that a message wakes from sleep resumes with the
same model and effort.
```

Первые строки абзаца (104–107) и сигнатура `spawn_session(provider, label, task, contextFrom, agent, worktree, model, effort)` не меняются: тест сигнатуры против схемы инструмента остаётся зелёным. Путей настроек CLI и адресов API в тексте нет — страж рамки доволен.

- [ ] **Step 4: Убедиться, что всё зелёное**

Run (из корня):
```bash
pnpm --filter @parley/core exec vitest run src/mcp src/work/guidance.test.ts src/work/brief.test.ts src/work/skill.test.ts test/frame-check.test.ts
pnpm --filter @parley/core build
pnpm exec eslint packages/core/src/mcp packages/core/src/work/guide.ts packages/core/src/work/guidance.test.ts
```
Expected:
- vitest: `Test Files  9 passed (9)`, `Tests  356 passed (356)`; в `server.test.ts` 160 тестов, в `guidance.test.ts` — 54;
- сборка и eslint — exit 0.

- [ ] **Step 5: Коммит**
```bash
git add packages/core/src/mcp/tools.ts packages/core/src/mcp/server.test.ts packages/core/src/work/guide.ts packages/core/src/work/guidance.test.ts
git commit -m "feat(core): spawn_session сверяет effort с уровнями модели, get_map и гид — про efforts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Удалить `EFFORT_LEVELS`**

Run: `grep -rn "EFFORT_LEVELS" packages/core/src packages/host/src packages/desktop/src`
Expected: одно место — объявление в `packages/core/src/providers.ts`; последнего пользователя (`tools.ts`) убрал Step 3.

`packages/core/src/providers.ts` — найти (текст из Task 2) и удалить целиком, вместе с пустой строкой после:

```ts
/**
 * Прежние три уровня, которыми `spawn_session` проверяет `effort`.
 * @deprecated Уровни для выбора даёт `effortsFor`, проверку пары — `resolveModelEffort`.
 */
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high'];
```

Константа стоит ниже `:248`: номер в `test/frame-check.test.ts` не сдвигается. Из `index.ts` она не экспортируется.

Run:
```bash
pnpm --filter @parley/core build
pnpm --filter @parley/core exec vitest run src/mcp/server.test.ts src/providers.test.ts test/frame-check.test.ts
grep -rn "EFFORT_LEVELS" packages/core/src packages/host/src packages/desktop/src
```
Expected: сборка — exit 0, три файла тестов зелёные, `grep` ничего не печатает.

- [ ] **Step 7: Коммит удаления**
```bash
git add packages/core/src/providers.ts
git commit -m "refactor(core): убрать EFFORT_LEVELS — закрытого набора уровней больше нет" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: каталог моделей Codex от CLI — файл `codex-models.json`, `providers.list` и `argsOverridden`

**Files:**
- Create: `packages/host/src/providers/codex-catalog.ts`
- Create: `packages/host/src/providers/codex-catalog.test.ts`
- Modify: `packages/host/src/host.ts:31-32` (импорты), `:52` (`HostOptions`), `:204` (запуск каталога), `:262-264` (обработчики)
- Modify: `packages/host/src/main.ts:6, 11-13, 23`
- Modify: `packages/host/src/main.test.ts:86-88, 99-102, 109-113`
- Modify: `packages/host/src/methods/index.ts:7, 45, 115`
- Modify: `packages/host/src/methods/providers.ts:18, 20-33, 34-40, 63-64`
- Modify: `packages/host/src/methods/providers.test.ts:1-10, 28-36, 42-61`, новый `describe` в конце файла (тест «окну уходят списки…» уже обновил Task 1)

**Interfaces:**
- Consumes (core): `loadProviders(): Promise<Record<string, ProviderEntry>>` (с Task 5 читает `codex-models.json`),
  `codexModelsFile(): string`, `MODEL_LABEL_MAX`, `EFFORT_DESCRIPTION_MAX` (Task 5), `commandBinary(command, env?): string`,
  `selectableModels(entry): ModelOption[] | null`, `supportsEffort(entry): boolean`, `EFFORT_TOKEN: RegExp` (Task 2),
  `effortLabel(id: string): string` (Task 1), типы `EffortOption { id; label; description? }`,
  `ModelOption { id; label; efforts?: EffortOption[] | null }`, `ProviderEntry` с `argsOverridden?: true` (Task 3).
- Consumes (protocol): событие `'providers.changed': { provider: string }`; результат `providers.list` с
  `argsOverridden?: boolean` (Task 6).
- Produces:
  ```ts
  export type CatalogProbe = (command: string) => Promise<string | null>;
  export interface CodexCatalog { ready: Promise<void>; current(): ModelOption[] | null; refreshIfStale(): void }
  export const CODEX_CATALOG_MAX_AGE_MS: number;   // 6 ч
  export const CODEX_CATALOG_TIMEOUT_MS: number;   // 15 с
  export const CODEX_CATALOG_MAX_BYTES: number;    // 4 МБ
  export function parseCodexCatalog(stdout: string, log?: Pick<Log, 'warn'>): ModelOption[] | null;
  export function startCodexCatalog(probe: CatalogProbe | undefined, log: Log, onChange: () => void, options?: { maxAgeMs?: number; now?: () => number }): CodexCatalog;
  export function probeCodexCatalog(command: string, timeoutMs?: number, env?: NodeJS.ProcessEnv): Promise<string | null>;
  // host.ts
  HostOptions.probeCodexCatalog?: CatalogProbe;
  // methods/index.ts
  MethodDeps.codexCatalog?: CodexCatalog;
  // methods/providers.ts
  export function createProvidersList(versions?: ProviderVersions, limits?: LimitsService, glmCheck?: GlmCheckService, catalog?: Pick<CodexCatalog, 'refreshIfStale'>): Handler<'providers.list'>;
  ```
- Produces (файл): после удачной пробы, давшей не тот список, что лежит в `codexModelsFile()`, хост атомарно пишет
  `{ "fetchedAt": "<ISO>", "models": ModelOption[] }` и шлёт `providers.changed` (`{ provider: 'codex' }`). Окно, хост
  (`providers.list`, `resolveModelChoice`) и MCP (`get_map`, `spawn_session`) берут модели `codex` из `loadProviders`:
  у `providers.list` особого случая для codex нет. Сбой пробы файл не трогает.

- [ ] **Step 1: Собрать core и protocol и проверить экспорты, нужные хосту**

  Run: `pnpm --filter @parley/core build && pnpm --filter @parley/protocol build`
  Expected: оба `tsc` без ошибок, exit 0.

  Run: `pnpm --filter @parley/host exec node --input-type=module -e "const c = await import('@parley/core'); const p = await import('@parley/protocol'); console.log(typeof c.effortsFor, typeof c.resolveModelEffort, typeof c.codexModelsFile, c.effortLabel('xhigh'), c.MODEL_LABEL_MAX, c.EFFORT_DESCRIPTION_MAX, c.EFFORT_TOKEN.source === p.EFFORT_TOKEN_RE.source)"`
  Expected: `function function function Extra high 100 300 true`

- [ ] **Step 2: Тесты модуля каталога (падают: модуля нет)**

  Создать `packages/host/src/providers/codex-catalog.test.ts`:

  ```ts
  import { execFile } from 'node:child_process';
  import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import path from 'node:path';
  import { promisify } from 'node:util';
  import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
  import { loadProviders, selectableModels } from '@parley/core';
  import type { ProviderEntry } from '@parley/core';
  import type { Log } from '../log.js';
  import {
    CODEX_CATALOG_MAX_AGE_MS,
    parseCodexCatalog,
    probeCodexCatalog,
    startCodexCatalog,
  } from './codex-catalog.js';

  /**
   * Настоящий codex здесь не запускается никогда, даже с `debug models`: проба зовётся либо с подменой
   * (`probe`), либо на выдуманную команду, чья переменная-оверрайд (`PARLEY_<ИМЯ>_BIN`) указывает на
   * скрипт-заглушку во временном каталоге.
   */
  const COMMAND = 'parley-fake-codex';
  const OVERRIDE = 'PARLEY_PARLEY_FAKE_CODEX_BIN';

  /** Уровни моделей каталога — как их печатает Codex 0.160 (2026-10-06). */
  const LEVELS = [
    { effort: 'low', description: 'Fast responses with lighter reasoning' },
    { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
    { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
    { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
    { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
  ];
  const WITHOUT_ULTRA = LEVELS.slice(0, 5);

  /**
   * Модели урезанного настоящего вывода `codex debug models` (целиком — около 600 КБ, десять моделей): три
   * видимые, одна из них без `ultra`, и одна скрытая. Лишние поля оставлены: разбор их не читает.
   */
  const ASTRA = {
    slug: 'gpt-6-astra',
    display_name: 'GPT-6-Astra',
    description: 'Frontier intelligence for the most demanding work.',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: LEVELS,
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: 2,
    context_window: 272000,
    input_modalities: ['text', 'image'],
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_reasoning_effort_updates: true,
  };
  const RESERVE = {
    slug: 'gpt-reserve',
    display_name: 'GPT-Reserve',
    description: 'Fast and affordable agentic coding model.',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: WITHOUT_ULTRA,
    visibility: 'hide',
    priority: 4,
    supports_reasoning_effort_updates: false,
  };
  const LUNA = {
    slug: 'gpt-6-luna',
    display_name: 'GPT-6-Luna',
    description: 'Fast and affordable model for easier tasks.',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: WITHOUT_ULTRA,
    visibility: 'list',
    priority: 4,
    context_window: 272000,
  };
  const SOL = {
    slug: 'gpt-6.1-sol',
    display_name: 'GPT-6.1-Sol',
    description: 'Latest workhorse model for coding and everyday work.',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: LEVELS,
    shell_type: 'unified_exec',
    visibility: 'list',
    priority: 0,
    base_instructions: 'You are Codex, a coding agent.',
  };
  /** Вывод целиком: модели не по порядку `priority`, скрытая — между видимыми. */
  const CATALOG = JSON.stringify({ models: [ASTRA, RESERVE, LUNA, SOL] });

  /** Подписи уровней по п. 5.1 спеки. */
  const LABELS: Record<string, string> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max',
    ultra: 'Ultra',
  };
  /** Уровни, как их получит окно: id, подпись и описание из каталога. */
  const efforts = (levels: ReadonlyArray<{ effort: string; description: string }>): unknown[] =>
    levels.map(({ effort, description }) => ({ id: effort, label: LABELS[effort], description }));

  let dir = '';
  let home = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'parley-codex-catalog-'));
    home = await mkdtemp(path.join(tmpdir(), 'parley-codex-catalog-home-'));
    process.env['PARLEY_HOME'] = home;
  });

  afterEach(async () => {
    delete process.env[OVERRIDE];
    delete process.env['PARLEY_HOME'];
    await Promise.all([dir, home].map((item) => rm(item, { recursive: true, force: true })));
  });

  const silentLog = (): Log & { warnings: Array<{ message: string; data: object | undefined }> } => {
    const warnings: Array<{ message: string; data: object | undefined }> = [];
    return {
      info: () => {},
      warn: (message: string, data?: object) => void warnings.push({ message, data }),
      error: () => {},
      warnings,
    };
  };

  const writeProviders = (data: unknown): Promise<void> =>
    writeFile(path.join(home, 'providers.json'), JSON.stringify(data), 'utf8');

  /** Модели `codex` так, как их видят окно, хост и MCP: реестр `loadProviders` вместе с файлом каталога. */
  async function codexModels(): Promise<unknown> {
    return selectableModels((await loadProviders())['codex'] as ProviderEntry);
  }

  /** Файл каталога в доме теста — `codexModelsFile()` при `PARLEY_HOME = home`. */
  const catalogFile = (): string => path.join(home, 'codex-models.json');

  /**
   * Заглушка вместо codex, как в `versions.test.ts`: свежий исполняемый файл macOS проверяет при первом запуске
   * дольше таймаута пробы, поэтому заглушка сперва запускается впрок (`--warm`).
   */
  async function stub(body: string): Promise<void> {
    const file = path.join(dir, 'fake-codex');
    await writeFile(file, `#!/bin/sh\n[ "$1" = "--warm" ] && exit 0\n${body}\n`, 'utf8');
    await chmod(file, 0o755);
    await promisify(execFile)(file, ['--warm'], { timeout: 30_000 });
    process.env[OVERRIDE] = file;
  }

  /** Ход цикла событий: после вызова пробы фоновая работа каталога — одни микрозадачи. */
  const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  describe('parseCodexCatalog: каталог из вывода `codex debug models`', () => {
    it('видимые модели в порядке priority; id, подпись и уровни с описаниями; прочие поля не читаются', () => {
      expect(parseCodexCatalog(CATALOG)).toEqual([
        { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: efforts(LEVELS) },
        { id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: efforts(LEVELS) },
        { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: efforts(WITHOUT_ULTRA) },
      ]);
    });

    it('не JSON, не та форма, пустой список и одни скрытые модели — null', () => {
      const outputs = [
        'Error: not logged in',
        '',
        '[]',
        JSON.stringify({ models: 'x' }),
        JSON.stringify({ models: [] }),
        JSON.stringify({ models: [RESERVE] }),
      ];
      for (const stdout of outputs) expect(parseCodexCatalog(stdout), stdout).toBeNull();
    });

    it('модель с уровнем не по токену выбрасывается с предупреждением, соседние остаются', () => {
      const log = silentLog();
      const spaced = {
        ...SOL,
        slug: 'gpt-spaced',
        supported_reasoning_levels: [{ effort: 'low', description: 'x' }, { effort: 'Extra High', description: 'x' }],
      };
      const quoted = { ...SOL, slug: 'gpt-quoted', supported_reasoning_levels: [{ effort: 'max"', description: 'x' }] };

      const parsed = parseCodexCatalog(JSON.stringify({ models: [spaced, quoted, LUNA] }), log);

      expect(parsed?.map((model) => model.id)).toEqual(['gpt-6-luna']);
      expect(log.warnings.map((warning) => warning.data)).toEqual([{ slug: 'gpt-spaced' }, { slug: 'gpt-quoted' }]);
    });

    it('id модели — правило `--model` core: с дефиса, с пробелом, пустой и длиннее 200 — модель выбрасывается; повтор slug — тоже', () => {
      const kept = (slug: string): boolean => parseCodexCatalog(JSON.stringify({ models: [{ ...LUNA, slug }] })) !== null;
      for (const slug of ['gpt-6.1-sol', 'a-b', 'sonnet[1m]', 'x'.repeat(200)]) expect(kept(slug), slug).toBe(true);
      // С дефиса CLI принял бы модель за флаг, с пробелом она ушла бы двумя аргументами `--model`.
      for (const slug of ['-gpt', '--model', 'gpt 6', 'gpt\t6', ' gpt', '', 'x'.repeat(201)]) {
        expect(kept(slug), JSON.stringify(slug)).toBe(false);
      }
      // Повтор slug: core не примет файл с двумя одинаковыми id, поэтому вторая запись выбрасывается здесь.
      const log = silentLog();
      const twice = parseCodexCatalog(JSON.stringify({ models: [SOL, { ...LUNA, slug: 'gpt-6.1-sol' }] }), log);
      expect(twice?.map((model) => [model.id, model.label])).toEqual([['gpt-6.1-sol', 'GPT-6.1-Sol']]);
      expect(log.warnings.map((warning) => warning.data)).toEqual([{ slug: 'gpt-6.1-sol' }]);
    });

    it('внешний ввод: display_name длиннее 100 и описание длиннее 300 знаков обрезаются; незнакомый уровень turbo — «Turbo», id как есть', () => {
      const long = {
        ...LUNA,
        display_name: 'L'.repeat(150),
        supported_reasoning_levels: [{ effort: 'turbo', description: 'd'.repeat(400) }],
      };

      expect(parseCodexCatalog(JSON.stringify({ models: [long] }))).toEqual([
        {
          id: 'gpt-6-luna',
          label: 'L'.repeat(100),
          efforts: [{ id: 'turbo', label: 'Turbo', description: 'd'.repeat(300) }],
        },
      ]);
    });

    it('модель без уровней — effort у неё нет (null), как у Haiku', () => {
      expect(parseCodexCatalog(JSON.stringify({ models: [{ ...LUNA, supported_reasoning_levels: [] }] }))).toEqual([
        { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: null },
      ]);
    });
  });

  describe('probeCodexCatalog: одна проба `<команда> debug models`', () => {
    it('отдаёт вывод как есть; зовётся ровно с двумя аргументами debug models', async () => {
      const catalogFile = path.join(dir, 'catalog.json');
      const argvFile = path.join(dir, 'argv.txt');
      await writeFile(catalogFile, CATALOG, 'utf8');
      await stub(`echo "$#:$1:$2" > "${argvFile}"; cat "${catalogFile}"`);

      expect(await probeCodexCatalog(COMMAND)).toBe(CATALOG);
      expect((await readFile(argvFile, 'utf8')).trim()).toBe('2:debug:models');
    });

    it('ненулевой выход и нет бинаря — null', async () => {
      await stub(`echo '{"models":[]}'; exit 1`);
      expect(await probeCodexCatalog(COMMAND)).toBeNull();
      process.env[OVERRIDE] = path.join(dir, 'нет-такого');
      expect(await probeCodexCatalog(COMMAND)).toBeNull();
    });

    it('зависший бинарь обрывается по таймауту — null', async () => {
      await stub('exec sleep 30');
      const started = Date.now();
      // Таймаут с запасом: под нагрузкой оболочка стартует не сразу.
      expect(await probeCodexCatalog(COMMAND, 1500)).toBeNull();
      expect(Date.now() - started).toBeLessThan(6000);
    });

    it('вывод больше 4 МБ — null: такой каталог не разбирается', async () => {
      await stub('yes x | head -c 5000000');
      expect(await probeCodexCatalog(COMMAND)).toBeNull();
    });
  });

  describe('startCodexCatalog: проба на старте, перепроба по возрасту', () => {
    it('без пробы (тесты, PARLEY_SKIP_VERSION_PROBE) каталога нет и ничего не запускается', async () => {
      let changes = 0;
      const catalog = startCodexCatalog(undefined, silentLog(), () => {
        changes += 1;
      });
      await catalog.ready;
      catalog.refreshIfStale();
      expect(catalog.current()).toBeNull();
      expect(changes).toBe(0);
    });

    it('первая проба — сразу, по команде записи codex; каталог разобран, onChange один раз', async () => {
      const calls: string[] = [];
      let changes = 0;
      const catalog = startCodexCatalog(
        async (command) => {
          calls.push(command);
          return CATALOG;
        },
        silentLog(),
        () => {
          changes += 1;
        },
      );
      await catalog.ready;

      expect(calls).toEqual(['codex']);
      expect(changes).toBe(1);
      expect(catalog.current()).toEqual(parseCodexCatalog(CATALOG));
    });

    it('свой command у codex в providers.json — проба зовёт его', async () => {
      await writeProviders({ codex: { command: 'my-codex' } });
      const calls: string[] = [];
      const catalog = startCodexCatalog(
        async (command) => {
          calls.push(command);
          return CATALOG;
        },
        silentLog(),
        () => {},
      );
      await catalog.ready;
      expect(calls).toEqual(['my-codex']);
    });

    it('проба не ответила, упала, вывод не JSON или без видимых моделей — каталога нет, предупреждение, onChange нет', async () => {
      const outcomes: Array<() => Promise<string | null>> = [
        async () => null,
        async () => {
          throw new Error('нет бинаря');
        },
        async () => 'Error: not logged in',
        async () => JSON.stringify({ models: [] }),
        async () => JSON.stringify({ models: [RESERVE] }),
      ];
      for (const outcome of outcomes) {
        const log = silentLog();
        let changes = 0;
        const catalog = startCodexCatalog(outcome, log, () => {
          changes += 1;
        });
        await catalog.ready;
        expect(catalog.current()).toBeNull();
        expect(changes).toBe(0);
        expect(log.warnings).toHaveLength(1);
      }
    });

    it('перепроба по возрасту: раньше 6 часов не идёт, после — одна на два вызова; onChange — только если каталог другой', async () => {
      let clock = 1_000;
      let stdout: string | null = CATALOG;
      const calls: string[] = [];
      let changes = 0;
      const log = silentLog();
      const catalog = startCodexCatalog(
        async (command) => {
          calls.push(command);
          return stdout;
        },
        log,
        () => {
          changes += 1;
        },
        { now: () => clock },
      );
      await catalog.ready;
      expect(changes).toBe(1);

      // Каталог свежий: проба не повторяется.
      clock += CODEX_CATALOG_MAX_AGE_MS - 1;
      catalog.refreshIfStale();
      expect(calls).toHaveLength(1);

      // Устарел: два вызова подряд — одна проба; ответ тот же — onChange нет.
      clock += 1;
      catalog.refreshIfStale();
      catalog.refreshIfStale();
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      await settled();
      expect(changes).toBe(1);

      // Снова устарел, а проба не ответила: прежний каталог остаётся, в журнале предупреждение.
      stdout = null;
      clock += CODEX_CATALOG_MAX_AGE_MS;
      catalog.refreshIfStale();
      await vi.waitFor(() => expect(calls).toHaveLength(3));
      await settled();
      expect(catalog.current()?.map((model) => model.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']);
      expect(await codexModels()).toEqual(parseCodexCatalog(CATALOG));
      expect(changes).toBe(1);
      expect(log.warnings).toHaveLength(1);

      // Каталог другой — onChange и новый список.
      stdout = JSON.stringify({ models: [LUNA] });
      clock += CODEX_CATALOG_MAX_AGE_MS;
      catalog.refreshIfStale();
      await vi.waitFor(() => expect(changes).toBe(2));
      expect(catalog.current()?.map((model) => model.id)).toEqual(['gpt-6-luna']);
      expect(await codexModels()).toEqual(parseCodexCatalog(JSON.stringify({ models: [LUNA] })));
    });
  });

  describe('файл каталога: один список для окна, хоста и MCP (спека 5.2)', () => {
    it('удачная проба пишет { fetchedAt, models } атомарно, и loadProviders отдаёт эти модели у codex', async () => {
      const catalog = startCodexCatalog(async () => CATALOG, silentLog(), () => {}, {
        now: () => Date.parse('2026-10-06T10:00:00.000Z'),
      });
      await catalog.ready;

      expect(JSON.parse(await readFile(catalogFile(), 'utf8'))).toEqual({
        fetchedAt: '2026-10-06T10:00:00.000Z',
        models: parseCodexCatalog(CATALOG),
      });
      // Временный файл записи не остаётся.
      expect((await readdir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect(await codexModels()).toEqual(parseCodexCatalog(CATALOG));
    });

    it('тот же список, что в файле, — файл не переписывается, onChange нет', async () => {
      await writeFile(catalogFile(), JSON.stringify({ fetchedAt: 'прежний', models: parseCodexCatalog(CATALOG) }), 'utf8');
      let changes = 0;
      const catalog = startCodexCatalog(async () => CATALOG, silentLog(), () => {
        changes += 1;
      });
      await catalog.ready;

      expect(changes).toBe(0);
      expect((JSON.parse(await readFile(catalogFile(), 'utf8')) as { fetchedAt: string }).fetchedAt).toBe('прежний');
    });

    it('сбой пробы файл не трогает: прежний каталог остаётся у всех', async () => {
      const before = JSON.stringify({ fetchedAt: 'прежний', models: [{ id: 'gpt-7-nova', label: 'GPT-7-Nova', efforts: null }] });
      await writeFile(catalogFile(), before, 'utf8');
      const catalog = startCodexCatalog(async () => null, silentLog(), () => {});
      await catalog.ready;

      expect(await readFile(catalogFile(), 'utf8')).toBe(before);
      expect(await codexModels()).toEqual([{ id: 'gpt-7-nova', label: 'GPT-7-Nova', efforts: null }]);
    });

    it('свой список codex из providers.json важнее файла каталога', async () => {
      await writeProviders({ codex: { models: [{ id: 'my-codex', label: 'Мой' }] } });
      const catalog = startCodexCatalog(async () => CATALOG, silentLog(), () => {});
      await catalog.ready;

      expect(await codexModels()).toEqual([{ id: 'my-codex', label: 'Мой' }]);
    });
  });

  ```

- [ ] **Step 3: Прогон — падает**

  Run: `pnpm --filter @parley/host exec vitest run src/providers/codex-catalog.test.ts`
  Expected: FAIL — `Error: Failed to load url ./codex-catalog.js (resolved id: ./codex-catalog.js) in …/codex-catalog.test.ts. Does the file exist?`

- [ ] **Step 4: Модуль каталога**

  Создать `packages/host/src/providers/codex-catalog.ts`:

  ```ts
  /**
   * Каталог моделей Codex от самого CLI (спека нормалайзера, 5.2): `codex debug models` печатает каталог аккаунта —
   * модели, их подписи и уровни effort. Проба идёт на старте хоста и повторяется в фоне, когда `providers.list`
   * застаёт каталог старше шести часов. Удачная проба со списком, которого ещё нет в файле, атомарно переписывает
   * файл Parley `codex-models.json` (`codexModelsFile` в core) и зовёт `onChange`. Файл читает `loadProviders`, поэтому
   * окно, хост и MCP-сервер агента (отдельный процесс) видят один список. Сбой пробы файл не трогает: остаётся
   * прежний каталог, а без файла действует встроенный `CODEX_MODELS` из core.
   *
   * Рамка: это команда самого CLI, как проба `--version` (`versions.ts`). Parley не читает ни ключей, ни файлов
   * входа и сам в API не ходит: каталог забирает Codex под входом человека. Запускается то, что стоит у человека в
   * PATH (или подмена `PARLEY_<КОМАНДА>_BIN`, как при запуске сессии), и никогда — без таймаута и предела вывода.
   */

  import { execFile } from 'node:child_process';
  import { randomUUID } from 'node:crypto';
  import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
  import path from 'node:path';
  import {
    codexModelsFile,
    commandBinary,
    EFFORT_DESCRIPTION_MAX,
    EFFORT_TOKEN,
    effortLabel,
    loadProviders,
    MODEL_LABEL_MAX,
    type EffortOption,
    type ModelOption,
  } from '@parley/core';
  import type { Log } from '../log.js';

  /** Одна проба: stdout `<команда> debug models`; `null` — ненулевой выход, таймаут, предел вывода или нет бинаря. */
  export type CatalogProbe = (command: string) => Promise<string | null>;

  export interface CodexCatalog {
    /** Первая проба завершена, успехом или нет; не отказывает. */
    ready: Promise<void>;
    /** Модели последней удачной пробы в порядке Codex; `null` — удачной пробы ещё не было. */
    current(): ModelOption[] | null;
    /** Каталог старше срока и проба не идёт — новая проба в фоне; новый список — в файл и `onChange`. */
    refreshIfStale(): void;
  }

  /** Срок каталога (спека 5.2): старше — `providers.list` просит пробу заново. */
  export const CODEX_CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  /** Таймаут пробы: Codex отвечает примерно за 2 с, но перед ответом сам скачивает каталог. */
  export const CODEX_CATALOG_TIMEOUT_MS = 15_000;
  /** Предел вывода: настоящий каталог на 2026-10-06 — около 600 КБ. */
  export const CODEX_CATALOG_MAX_BYTES = 4 * 1024 * 1024;

  /** `--model`: одно слово, не с дефиса, не длиннее 200 знаков — правило id модели core (`modelChoiceError`). */
  const MODEL_ID = /^[^\s-]\S*$/;
  const MODEL_ID_MAX_LENGTH = 200;

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  /** Порядок Codex — `priority` по возрастанию; запись без числа уходит в конец. */
  const priorityOf = (model: Record<string, unknown>): number =>
    typeof model['priority'] === 'number' ? model['priority'] : Number.MAX_SAFE_INTEGER;

  /**
   * Модель каталога для окна; `null` — запись не годится: id не того вида (стал бы флагом или двумя аргументами
   * `--model`), нет подписи, уровень не проходит `EFFORT_TOKEN` (значение встаёт и в argv, и в кавычки TOML
   * `model_reasoning_effort="…"`) или повторяется. Подпись и описания длиннее пределов core обрезаются.
   */
  function modelOf(model: Record<string, unknown>): ModelOption | null {
    const slug = model['slug'];
    const label = model['display_name'];
    const levels = model['supported_reasoning_levels'];
    if (
      typeof slug !== 'string' ||
      slug.length > MODEL_ID_MAX_LENGTH ||
      !MODEL_ID.test(slug) ||
      typeof label !== 'string' ||
      label === '' ||
      !Array.isArray(levels)
    ) {
      return null;
    }
    const efforts: EffortOption[] = [];
    for (const level of levels) {
      const id = isRecord(level) ? level['effort'] : undefined;
      const description = isRecord(level) ? level['description'] : undefined;
      if (typeof id !== 'string' || !EFFORT_TOKEN.test(id) || efforts.some((known) => known.id === id)) return null;
      efforts.push({
        id,
        label: effortLabel(id),
        ...(typeof description === 'string' ? { description: description.slice(0, EFFORT_DESCRIPTION_MAX) } : {}),
      });
    }
    // Уровней нет — effort у модели нет, как у Haiku.
    return { id: slug, label: label.slice(0, MODEL_LABEL_MAX), efforts: efforts.length === 0 ? null : efforts };
  }

  /**
   * Разбор вывода `{"models":[…]}`: модели с `visibility: "list"` в порядке `priority`; `id` — `slug`, подпись —
   * `display_name`, уровни — `supported_reasoning_levels` (`effort` → `id`, описание как есть). Запись не той формы
   * и повтор `slug` выбрасываются с предупреждением, прочие поля каталога не читаются. `null` — не JSON, не та форма
   * или видимых моделей не осталось.
   */
  export function parseCodexCatalog(stdout: string, log?: Pick<Log, 'warn'>): ModelOption[] | null {
    let data: unknown;
    try {
      data = JSON.parse(stdout);
    } catch {
      return null;
    }
    const list = isRecord(data) ? data['models'] : undefined;
    if (!Array.isArray(list)) return null;
    const visible = list
      .filter(isRecord)
      .filter((model) => model['visibility'] === 'list')
      .sort((a, b) => priorityOf(a) - priorityOf(b));
    const models: ModelOption[] = [];
    for (const model of visible) {
      const option = modelOf(model);
      if (option !== null && !models.some((known) => known.id === option.id)) {
        models.push(option);
        continue;
      }
      // Вызов журнала прямой: страж английских текстов узнаёт строку журнала по `log.warn(…)`, а не по `log?.warn`.
      if (log !== undefined) {
        log.warn('модель каталога Codex пропущена: id, подпись или уровень не той формы либо повтор', {
          slug: String(model['slug']),
        });
      }
    }
    return models.length === 0 ? null : models;
  }

  /**
   * Проба по команде записи `codex` реестра (свой `command` из `providers.json` тоже в силе). Не бросает: сбой —
   * `null` и предупреждение в журнал.
   */
  async function probeOnce(probe: CatalogProbe, log: Log): Promise<ModelOption[] | null> {
    let command: string | undefined;
    try {
      command = (await loadProviders())['codex']?.runner.command;
    } catch (error) {
      log.warn('каталог Codex не пробуется: реестр провайдеров не читается', { error: String(error) });
      return null;
    }
    if (command === undefined) return null;
    const stdout = await probe(command).catch(() => null);
    const models = stdout === null ? null : parseCodexCatalog(stdout, log);
    if (models === null) {
      log.warn('каталог Codex не получен: проба не ответила, вывод не JSON или видимых моделей нет', { command });
    }
    return models;
  }

  /** Модели из файла каталога как есть; файла нет или он не читается — `null`. */
  async function storedModels(file: string): Promise<unknown> {
    try {
      const data: unknown = JSON.parse(await readFile(file, 'utf8'));
      return isRecord(data) ? (data['models'] ?? null) : null;
    } catch {
      return null;
    }
  }

  /** Атомарная запись, как у проверки ключа GLM: временный файл рядом и `rename` — читатель видит старый или новый. */
  async function writeCatalog(file: string, models: ModelOption[], at: number): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ fetchedAt: new Date(at).toISOString(), models }, null, 2)}\n`, 'utf8');
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /**
   * Заводит каталог: первая проба сразу, в фоне. Без пробы (`undefined` — тесты, `PARLEY_SKIP_VERSION_PROBE`)
   * ничего не запускается и файл не трогается. Удачная проба со списком, которого нет в файле, пишет файл и зовёт
   * `onChange`; неудачная прежний файл не трогает. Файл хост читает один раз, при первой удачной пробе: дальше его
   * пишет только этот каталог. Срок считается от начала последней пробы, удачной или нет.
   */
  export function startCodexCatalog(
    probe: CatalogProbe | undefined,
    log: Log,
    onChange: () => void,
    options: { maxAgeMs?: number; now?: () => number } = {},
  ): CodexCatalog {
    const maxAgeMs = options.maxAgeMs ?? CODEX_CATALOG_MAX_AGE_MS;
    const now = options.now ?? Date.now;
    // Дом известен на старте хоста: файл не переедет, даже если окружение потом сменится (тесты гоняют хосты подряд).
    const file = codexModelsFile();
    let models: ModelOption[] | null = null;
    /** Список из файла (JSON); `undefined` — файл ещё не читали. */
    let written: string | undefined;
    let probedAt = 0;
    let running = false;

    const run = async (): Promise<void> => {
      if (probe === undefined) return;
      running = true;
      probedAt = now();
      try {
        const next = await probeOnce(probe, log);
        if (next === null) return;
        models = next;
        written ??= JSON.stringify(await storedModels(file));
        const text = JSON.stringify(next);
        if (text === written) return;
        await writeCatalog(file, next, now());
        written = text;
        onChange();
      } catch (error) {
        log.error('каталог Codex не записан', { error: String(error) });
      } finally {
        running = false;
      }
    };

    return {
      ready: run(),
      current: () => models,
      refreshIfStale() {
        if (probe === undefined || running || now() - probedAt < maxAgeMs) return;
        void run();
      },
    };
  }

  /**
   * Настоящая проба: `<команда> debug models` с подменой `PARLEY_<КОМАНДА>_BIN`, как у пробы версии
   * (`probeCliVersion` в core). Зависший бинарь убивается по таймауту, вывод сверх предела — тоже.
   */
  export function probeCodexCatalog(
    command: string,
    timeoutMs = CODEX_CATALOG_TIMEOUT_MS,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const child = execFile(
        commandBinary(command, env),
        ['debug', 'models'],
        { env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: CODEX_CATALOG_MAX_BYTES, windowsHide: true },
        (error, stdout) => resolve(error === null ? stdout : null),
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end();
    });
  }
  ```

- [ ] **Step 5: Прогон — зелёный**

  Run: `pnpm --filter @parley/host exec vitest run src/providers/codex-catalog.test.ts`
  Expected: PASS, 19 тестов (6 + 4 + 5 + 4).

- [ ] **Step 6: Тесты подключения: `providers.list`, `main.ts` (падают)**

  `packages/host/src/methods/providers.test.ts` — импорты, строки 1-10.
  Было:
  ```ts
  import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import path from 'node:path';
  import { afterEach, describe, expect, it } from 'vitest';
  import { addSession, createWork, updateMap, workPaths } from '@parley/core';
  import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
  import type { RawMessage, TestClient } from '../../test/helpers.js';
  import { startHost } from '../host.js';
  import type { HostOptions, RunningHost } from '../host.js';
  import { hostPaths } from '../paths.js';
  ```
  Стало:
  ```ts
  import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import path from 'node:path';
  import { afterEach, describe, expect, it, vi } from 'vitest';
  import { PROVIDERS, addSession, createWork, selectableModels, updateMap, workPaths } from '@parley/core';
  import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
  import type { RawMessage, TestClient } from '../../test/helpers.js';
  import type { RequestInfo } from '../context.js';
  import { startHost } from '../host.js';
  import type { HostOptions, RunningHost } from '../host.js';
  import { hostPaths } from '../paths.js';
  import { createProvidersList } from './providers.js';
  ```

  Строки 28-36 (тип уровней у моделей дописал Task 1). Было:
  ```ts
    models: Array<{ id: string; label: string; efforts?: Array<{ id: string; label: string; description?: string }> | null }> | null;
    effort: boolean;
    version: string | null;
  ```
  Стало:
  ```ts
    models: Array<{ id: string; label: string; efforts?: Array<{ id: string; label: string; description?: string }> | null }> | null;
    effort: boolean;
    argsOverridden?: boolean;
    version: string | null;
  ```

  Строки 42-61 (`boot`). Было:
  ```ts
  async function boot(
    options: {
      probeVersion?: (command: string) => Promise<string | null>;
      providersJson?: unknown;
  ```
  Стало:
  ```ts
  async function boot(
    options: {
      probeVersion?: (command: string) => Promise<string | null>;
      /** Подмена пробы каталога Codex (`codex debug models`); без неё каталога нет. */
      probeCodexCatalog?: (command: string) => Promise<string | null>;
      providersJson?: unknown;
  ```
  Было:
  ```ts
    const running = await startHost({
      home,
      ...(options.probeVersion === undefined ? {} : { probeVersion: options.probeVersion }),
  ```
  Стало:
  ```ts
    const running = await startHost({
      home,
      ...(options.probeVersion === undefined ? {} : { probeVersion: options.probeVersion }),
      ...(options.probeCodexCatalog === undefined ? {} : { probeCodexCatalog: options.probeCodexCatalog }),
  ```

  В конец файла (после строки 368) — новый `describe`:
  ```ts
  describe('providers.list: каталог Codex от CLI и argsOverridden (спека нормалайзера, 5.2, 5.6)', () => {
    /** Урезанный вывод `codex debug models`: модель, которой нет во встроенном списке, и одна из него. */
    const LIVE_CATALOG = JSON.stringify({
      models: [
        {
          slug: 'gpt-6.1-sol',
          display_name: 'GPT-6.1-Sol',
          visibility: 'list',
          priority: 1,
          supported_reasoning_levels: [
            { effort: 'low', description: 'Fast responses with lighter reasoning' },
            { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
          ],
        },
        {
          slug: 'gpt-7-nova',
          display_name: 'GPT-7-Nova',
          visibility: 'list',
          priority: 0,
          supported_reasoning_levels: [
            { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
          ],
        },
      ],
    });

    /** Проба каталога, которая отвечает, только когда тест разрешит: до того список — встроенный. */
    function gatedProbe(): {
      calls: string[];
      probe: (command: string) => Promise<string | null>;
      answer: (stdout: string | null) => void;
    } {
      const calls: string[] = [];
      let release: (stdout: string | null) => void = () => {};
      return {
        calls,
        probe: (command) => {
          calls.push(command);
          return new Promise((resolve) => {
            release = resolve;
          });
        },
        answer: (stdout) => release(stdout),
      };
    }

    /** Ближайшее `providers.changed`, прочие сообщения пропускаются; не пришло за 5 с — ошибка. */
    async function providersChanged(client: TestClient): Promise<RawMessage> {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('событие providers.changed не пришло за 5 с')), 5000);
      });
      try {
        for (;;) {
          const message = await Promise.race([client.next(), timeout]);
          if (message.event === 'providers.changed') return message;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    it('сначала встроенный список; после пробы — providers.changed и каталог CLI в порядке Codex с уровнями', async () => {
      const gate = gatedProbe();
      const client = await boot({ probeCodexCatalog: gate.probe });
      expect(byId(await list(client), 'codex').models).toEqual(selectableModels(PROVIDERS.codex));

      await vi.waitFor(() => expect(gate.calls).toEqual(['codex']));
      gate.answer(LIVE_CATALOG);
      expect((await providersChanged(client)).data).toEqual({ provider: 'codex' });

      const providers = await list(client);
      expect(byId(providers, 'codex').models).toEqual([
        {
          id: 'gpt-7-nova',
          label: 'GPT-7-Nova',
          efforts: [{ id: 'medium', label: 'Medium', description: 'Balances speed and reasoning depth for everyday tasks' }],
        },
        {
          id: 'gpt-6.1-sol',
          label: 'GPT-6.1-Sol',
          efforts: [
            { id: 'low', label: 'Low', description: 'Fast responses with lighter reasoning' },
            { id: 'ultra', label: 'Ultra', description: 'Maximum reasoning with automatic task delegation' },
          ],
        },
      ]);
      // Каталог Codex — только у codex.
      expect(byId(providers, 'claude').models).toEqual(selectableModels(PROVIDERS.claude));
    });

    it('свой список codex из providers.json важнее каталога CLI', async () => {
      const gate = gatedProbe();
      const client = await boot({
        probeCodexCatalog: gate.probe,
        providersJson: { codex: { models: [{ id: 'my-codex', label: 'Мой' }] } },
      });
      await vi.waitFor(() => expect(gate.calls).toEqual(['codex']));
      gate.answer(LIVE_CATALOG);
      await providersChanged(client);

      expect(byId(await list(client), 'codex').models).toEqual([{ id: 'my-codex', label: 'Мой' }]);
    });

    it('argsOverridden: args провайдера из providers.json — окно объяснит пропавший выбор', async () => {
      const providers = await list(await boot({ providersJson: { codex: { args: ['{prompt}'] } } }));

      expect(byId(providers, 'codex')).toMatchObject({ argsOverridden: true, models: null, effort: false });
      expect(byId(providers, 'claude')).toMatchObject({ argsOverridden: false });
    });

    it('каждый providers.list просит каталог обновиться, если он устарел; ответ пробу не ждёт', async () => {
      const refreshIfStale = vi.fn();
      const handler = createProvidersList(undefined, undefined, undefined, { refreshIfStale });

      await handler({}, {} as RequestInfo);
      await handler({}, {} as RequestInfo);

      expect(refreshIfStale).toHaveBeenCalledTimes(2);
    });
  });
  ```

  `packages/host/src/main.test.ts`, строки 86-88. Было:
  ```ts
      // Проба идёт сразу за стартом и быстрая. Без пробы даём ей время, которого хватило бы.
      const done = (): boolean =>
        existsSync(calls) && readFileSync(calls, 'utf8').trim().split('\n').length >= COMMANDS.length;
  ```
  Стало:
  ```ts
      // Пробы идут сразу за стартом и быстрые: `--version` на каждую команду и каталог Codex (`debug models`).
      // Без проб даём им время, которого хватило бы.
      const done = (): boolean =>
        existsSync(calls) && readFileSync(calls, 'utf8').trim().split('\n').length >= COMMANDS.length + 1;
  ```

  Строки 99-102. Было:
  ```ts
  describe('main.ts: проба версий CLI на старте (дизайн комнат, 3.2)', () => {
    it('по умолчанию хост зовёт `--version` по одному разу на уникальную команду: claude общий для Claude и GLM', async () => {
      const calls = await hostCalls(false);
      expect(calls.sort()).toEqual(['claude:1:--version', 'codex:1:--version']);
  ```
  Стало:
  ```ts
  describe('main.ts: пробы CLI на старте — версии (дизайн комнат, 3.2) и каталог Codex (спека нормалайзера, 5.2)', () => {
    it('по умолчанию хост зовёт `--version` по одному разу на уникальную команду (claude общий для Claude и GLM) и один раз `codex debug models`', async () => {
      const calls = await hostCalls(false);
      expect(calls.sort()).toEqual(['claude:1:--version', 'codex:1:--version', 'codex:2:debug']);
  ```

  Строки 109-111. Было:
  ```ts
      const calls = await hostCalls(false, true);
      expect(calls.sort()).toEqual(['claude:1:--version', 'codex:1:--version']);
  ```
  Стало:
  ```ts
      const calls = await hostCalls(false, true);
      expect(calls.sort()).toEqual(['claude:1:--version', 'codex:1:--version', 'codex:2:debug']);
  ```

- [ ] **Step 7: Прогон — падает**

  Run: `pnpm --filter @parley/host exec vitest run src/methods/providers.test.ts src/main.test.ts`
  Expected: FAIL. `providers.test.ts`: «сначала встроенный список…» и «свой список codex…» —
  `expected [] to deeply equal [ 'codex' ]` (хост не знает `probeCodexCatalog`); «argsOverridden…» —
  `toMatchObject` без `argsOverridden: true`; «каждый providers.list…» — `expected "spy" to be called 2 times, but got 0 times`.
  `main.test.ts`: оба теста с пробой — `expected [ 'claude:1:--version', 'codex:1:--version' ] to deeply equal [ …, 'codex:2:debug' ]`
  (каждый ждёт третьей строки до 15 с).

- [ ] **Step 8: Подключение каталога: `host.ts`, `main.ts`, `methods/index.ts`, `methods/providers.ts`**

  `packages/host/src/host.ts`, строки 31-32. Было:
  ```ts
  import { startProviderVersions } from './providers/versions.js';
  import type { VersionProbe } from './providers/versions.js';
  ```
  Стало:
  ```ts
  import { startCodexCatalog } from './providers/codex-catalog.js';
  import type { CatalogProbe } from './providers/codex-catalog.js';
  import { startProviderVersions } from './providers/versions.js';
  import type { VersionProbe } from './providers/versions.js';
  ```

  Строка 52 (`HostOptions`). Было:
  ```ts
    probeVersion?: VersionProbe;
    /**
     * Лимиты подписок (спека комнат Organic, 3.5): корень логов Codex, часы и период опроса. Боевой хост
  ```
  Стало:
  ```ts
    probeVersion?: VersionProbe;
    /**
     * Проба каталога моделей Codex на старте (`codex debug models`, спека нормалайзера, 5.2). Без неё каталога нет и
     * действует встроенный список: подключает её только `main.ts`, а тесты, где настоящий codex запускать нельзя,
     * зовут `startHost` без пробы или с подменой.
     */
    probeCodexCatalog?: CatalogProbe;
    /**
     * Лимиты подписок (спека комнат Organic, 3.5): корень логов Codex, часы и период опроса. Боевой хост
  ```

  Строка 204. Было:
  ```ts
    const providerVersions = startProviderVersions(options.probeVersion, log);
  ```
  Стало:
  ```ts
    const providerVersions = startProviderVersions(options.probeVersion, log);

    // Каталог моделей Codex (спека нормалайзера, 5.2) — проба на старте, в фоне: `providers.list` её не ждёт, а
    // новый каталог хост пишет в `codex-models.json` (его читает `loadProviders` — и окно, и MCP агента) и сообщает
    // окну событием `providers.changed`.
    const codexCatalog = startCodexCatalog(options.probeCodexCatalog, log, () => {
      handle.context.broadcast('providers.changed', { provider: 'codex' });
    });
  ```

  Строки 262-264. Было:
  ```ts
    const handlers = createHostHandlers({
      worksReady,
      providerVersions,
  ```
  Стало:
  ```ts
    const handlers = createHostHandlers({
      worksReady,
      providerVersions,
      codexCatalog,
  ```

  `packages/host/src/main.ts`. Было (строка 6):
  ```ts
  import { probeCliVersion } from './providers/versions.js';
  ```
  Стало:
  ```ts
  import { probeCodexCatalog } from './providers/codex-catalog.js';
  import { probeCliVersion } from './providers/versions.js';
  ```
  Было (строки 11-13):
  ```ts
    // Версии CLI — проба `<команда> --version` на старте. E2E окна её отключает: в их окружении
    // настоящие claude и codex запускать нельзя, и подменён у них только claude.
    const probeVersions = envValue(process.env, 'SKIP_VERSION_PROBE') !== '1';
  ```
  Стало:
  ```ts
    // Версии CLI (`<команда> --version`) и каталог Codex (`codex debug models`) — пробы на старте. E2E окна их
    // отключает: в их окружении настоящие claude и codex запускать нельзя, и подменён у них только claude.
    const probeVersions = envValue(process.env, 'SKIP_VERSION_PROBE') !== '1';
  ```
  Было (строка 23):
  ```ts
      ...(probeVersions ? { probeVersion: probeCliVersion } : {}),
  ```
  Стало:
  ```ts
      ...(probeVersions ? { probeVersion: probeCliVersion, probeCodexCatalog } : {}),
  ```

  `packages/host/src/methods/index.ts`. Было (строка 7):
  ```ts
  import type { ProviderVersions } from '../providers/versions.js';
  ```
  Стало:
  ```ts
  import type { CodexCatalog } from '../providers/codex-catalog.js';
  import type { ProviderVersions } from '../providers/versions.js';
  ```
  Было (строки 44-45):
  ```ts
    /** Версии CLI из пробы на старте хоста (`providers.list`); без них у провайдеров `version: null`. */
    providerVersions?: ProviderVersions;
  ```
  Стало:
  ```ts
    /** Версии CLI из пробы на старте хоста (`providers.list`); без них у провайдеров `version: null`. */
    providerVersions?: ProviderVersions;
    /** Каталог моделей Codex из пробы CLI: `providers.list` просит его обновиться, когда он устарел; без него — не просит. */
    codexCatalog?: CodexCatalog;
  ```
  Было (строка 115):
  ```ts
      'providers.list': createProvidersList(deps.providerVersions, deps.limits, deps.glmCheck) as AnyHandler,
  ```
  Стало:
  ```ts
      'providers.list': createProvidersList(deps.providerVersions, deps.limits, deps.glmCheck, deps.codexCatalog) as AnyHandler,
  ```

  `packages/host/src/methods/providers.ts`. Было (строка 18):
  ```ts
  import type { ProviderVersions } from '../providers/versions.js';
  ```
  Стало:
  ```ts
  import type { CodexCatalog } from '../providers/codex-catalog.js';
  import type { ProviderVersions } from '../providers/versions.js';
  ```
  Было (строки 31-33):
  ```ts
   * `check` — исход последней явной проверки сохранённого ключа (`providers.check`), только у провайдера
   * с ключом; читается локально, без сети, и только для нынешнего ключа.
   */
  ```
  Стало:
  ```ts
   * `check` — исход последней явной проверки сохранённого ключа (`providers.check`), только у провайдера
   * с ключом; читается локально, без сети, и только для нынешнего ключа.
   *
   * `models` у `codex` — из `loadProviders`: каталог самого CLI (`codex debug models`) из `codex-models.json`, пока
   * `providers.json` не задаёт свой список (спека нормалайзера, 5.2). Первую пробу ответ не ждёт: новый каталог
   * придёт событием `providers.changed`, а устаревший список просит обновить в фоне (`refreshIfStale`).
   * `argsOverridden` — `args` провайдера взяты из `providers.json`: окно объясняет этим пропавший выбор модели или
   * effort.
   */
  ```
  Было (строки 34-40):
  ```ts
  export function createProvidersList(
    versions?: ProviderVersions,
    limits?: LimitsService,
    glmCheck?: GlmCheckService,
  ): Handler<'providers.list'> {
    return async () => {
      const registry = await loadProviders();
  ```
  Стало:
  ```ts
  export function createProvidersList(
    versions?: ProviderVersions,
    limits?: LimitsService,
    glmCheck?: GlmCheckService,
    catalog?: Pick<CodexCatalog, 'refreshIfStale'>,
  ): Handler<'providers.list'> {
    return async () => {
      catalog?.refreshIfStale();
      const registry = await loadProviders();
  ```
  Было (строки 63-64):
  ```ts
            models: selectableModels(entry),
            effort: supportsEffort(entry),
  ```
  Стало:
  ```ts
            models: selectableModels(entry),
            effort: supportsEffort(entry),
            argsOverridden: entry.argsOverridden === true,
  ```

- [ ] **Step 9: Прогон — зелёный; сборка, стражи, lint**

  Run: `pnpm --filter @parley/host exec vitest run src/providers/codex-catalog.test.ts src/methods/providers.test.ts src/methods/providers-refresh.test.ts src/methods/providers-key.test.ts src/main.test.ts src/providers/versions.test.ts src/english-text.test.ts`
  Expected: PASS, все файлы. В `providers.test.ts` 4 новых теста зелёные, `main.test.ts` — 3 из 3.

  Run: `pnpm --filter @parley/host build`
  Expected: `tsc` без ошибок, exit 0.

  Run: `pnpm --filter @parley/core exec vitest run test/frame-check.test.ts`
  Expected: PASS (в новых файлах нет путей каталогов агентов и адресов API).

  Run: `pnpm exec eslint packages/host/src/providers packages/host/src/methods packages/host/src/host.ts packages/host/src/main.ts packages/host/src/main.test.ts`
  Expected: без ошибок.

- [ ] **Step 10: Коммит**

  ```bash
  git add packages/host/src/providers/codex-catalog.ts packages/host/src/providers/codex-catalog.test.ts \
    packages/host/src/host.ts packages/host/src/main.ts packages/host/src/main.test.ts \
    packages/host/src/methods/index.ts packages/host/src/methods/providers.ts packages/host/src/methods/providers.test.ts
  git commit -m "feat(host): каталог моделей Codex из codex debug models — файл codex-models.json, providers.list и argsOverridden" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 9: выбор модели и effort через resolver и в карту на всех путях `sessions.create`

**Files:**
- Modify: `packages/host/src/sessions/model-choice.ts:1-33` (переписать целиком)
- Modify: `packages/host/src/sessions/model-choice.test.ts` (новое содержимое целиком)
- Modify: `packages/host/src/sessions/sessions-service.ts:51` (импорт типа), `:80-98` (`CreateSessionInput`, `LaunchChoice`), `:102` (док `launch`), `:381-395` (`applyChoice`), `:435-489` (`create`)
- Modify: `packages/host/src/sessions/sessions-service.test.ts:10-24` (импорт `codexModelsFile`), `:274` (тип помощника `launched`), `:430-433` (новые тесты в `describe` про модель и усилие)

**Interfaces:**
- Consumes (core): `resolveModelEffort(entry, choice): { choice: ModelEffortChoice } | { error: string }` и
  `type ModelEffortChoice { model?: string; effort?: string }` (Task 2; флаг без подстановки в шаблоне resolver
  отбрасывает сам — и модель, и усилие), `EFFORT_TOKEN`, `loadProviders` (с Task 5 — и модели `codex` из
  `codex-models.json`), `codexModelsFile()` (тест), `NewSession.model?/effort?`, `WorkSession.model?/effort?: string`.
  (protocol, Task 6): `EFFORT_TOKEN_RE`, `METHODS['sessions.create']` (только тест).
- Produces:
  ```ts
  export async function resolveModelChoice(provider: string, model?: string, effort?: string): Promise<ModelEffortChoice>;
  CreateSessionInput.effort?: string;
  LaunchChoice.effort?: string;
  ```
  Живой каталог Codex resolver видит через `loadProviders` (файл пишет Task 8): особого параметра для него нет.

- [ ] **Step 1: Тесты (падают на старой сигнатуре и без записи в карту)**

  `packages/host/src/sessions/model-choice.test.ts` — новое содержимое целиком:

  ```ts
  import { mkdtemp, rm, writeFile } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import path from 'node:path';
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import { EFFORT_TOKEN, PROVIDERS, codexModelsFile, loadProviders, selectableModels } from '@parley/core';
  import type { ModelOption } from '@parley/core';
  import { EFFORT_TOKEN_RE, METHODS } from '@parley/protocol';
  import { resolveModelChoice } from './model-choice.js';

  let home = '';
  let savedHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'parley-model-choice-'));
    savedHome = process.env['PARLEY_HOME'];
    process.env['PARLEY_HOME'] = home;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env['PARLEY_HOME'];
    else process.env['PARLEY_HOME'] = savedHome;
    await rm(home, { recursive: true, force: true });
  });

  const writeProviders = (data: unknown): Promise<void> =>
    writeFile(path.join(home, 'providers.json'), JSON.stringify(data), 'utf8');

  /** Список встроенного провайдера; его отсутствие — провал, а не пустой обход, что прошёл бы впустую. */
  function builtInList(entry: typeof PROVIDERS.claude): Array<{ id: string; label: string }> {
    const list = selectableModels(entry);
    if (list === null) throw new Error(`у ${entry.id} нет списка моделей`);
    return list;
  }

  describe('resolveModelChoice: модель из диалога запуска против списка провайдера', () => {
    it('каждое значение встроенных списков claude, codex и glm проходит и возвращается как есть', async () => {
      for (const entry of [PROVIDERS.claude, PROVIDERS.codex, PROVIDERS.glm]) {
        for (const { id } of builtInList(entry))
          expect(await resolveModelChoice(entry.id, id)).toEqual({ model: id });
      }
    });

    it('и схема протокола принимает каждое значение списка: окно не предложит того, что схема отвергнет', () => {
      for (const entry of [PROVIDERS.claude, PROVIDERS.codex, PROVIDERS.glm]) {
        for (const { id } of builtInList(entry)) {
          const parsed = METHODS['sessions.create'].safeParse({
            projectPath: '/p',
            workId: 'w-0001',
            provider: entry.id,
            label: '',
            task: '',
            parent: null,
            model: id,
          });
          expect(parsed.success, `${entry.id}: ${id}`).toBe(true);
        }
      }
    });

    it('GLM принимает 5.3 и Flash из списка, а произвольную модель отклоняет', async () => {
      expect(await resolveModelChoice('glm', 'glm-5.3[1m]')).toEqual({ model: 'glm-5.3[1m]' });
      expect(await resolveModelChoice('glm', 'glm-5.3-flash[1m]')).toEqual({ model: 'glm-5.3-flash[1m]' });

      const refusal = resolveModelChoice('glm', 'что-угодно');
      await expect(refusal).rejects.toMatchObject({ name: 'HostError', code: 'bad_request' });
      await expect(refusal).rejects.toThrow(/что-угодно.*glm.*glm-5\.3\[1m\].*glm-5\.3-flash\[1m\]/s);
    });

    it('providers.json принимает в id ровно то, что примет схема sessions.create: список не пропустит значение, на котором create упадёт', async () => {
      const schemaAccepts = (model: string): boolean =>
        METHODS['sessions.create'].safeParse({
          projectPath: '/p',
          workId: 'w-0001',
          provider: 'claude',
          label: '',
          task: '',
          parent: null,
          model,
        }).success;
      // Пустое значение схема принимает как «по умолчанию»; в списке его нет, поэтому среди образцов его тоже нет.
      const samples = [
        'opus',
        'sonnet[1m]',
        'gpt-6.1-sol',
        'a-b',
        'ключ',
        'x'.repeat(200),
        'x'.repeat(201),
        ' opus',
        'op us',
        'op\tus',
        '-opus',
        '--model',
      ];

      for (const id of samples) {
        await writeProviders({ claude: { models: [{ id, label: 'Х' }] } });
        const loads = await loadProviders().then(
          () => true,
          () => false,
        );
        expect(loads, JSON.stringify(id)).toBe(schemaAccepts(id));
      }
    });

    it('модель не из списка — bad_request; в сообщении провайдер, модель и допустимые значения', async () => {
      const refusal = resolveModelChoice('claude', 'gpt-6-sol');

      await expect(refusal).rejects.toMatchObject({ name: 'HostError', code: 'bad_request' });
      await expect(refusal).rejects.toThrow(/gpt-6-sol.*claude.*opusplan/s);
      // Значение чужого провайдера и слегка иное написание — тоже не из списка: сверка точная.
      await expect(resolveModelChoice('codex', 'opus')).rejects.toMatchObject({
        code: 'bad_request',
      });
      await expect(resolveModelChoice('claude', 'Opus')).rejects.toMatchObject({
        code: 'bad_request',
      });
      await expect(resolveModelChoice('claude', 'claude-opus-5-5')).rejects.toMatchObject({
        code: 'bad_request',
      });
    });

    it('пустая модель и её отсутствие — «по умолчанию»: без флага, даже у провайдера со списком', async () => {
      expect(await resolveModelChoice('claude', undefined)).toEqual({});
      expect(await resolveModelChoice('claude', '')).toEqual({});
      expect(await resolveModelChoice('codex', '')).toEqual({});
    });

    it('провайдер без списка — прежнее правило: любое значение проходит; без `{model}` в шаблоне модель отброшена', async () => {
      await writeProviders({
        plain: { badge: 'Plain', command: 'plain', args: ['{prompt}'] },
        smart: { badge: 'Smart', command: 'smart', args: ['--m', '{model}'] },
      });
      // Без `{model}` resolver выбор отбрасывает: в карту ложится только то, что дойдёт до команды (как у spawn_session).
      expect(await resolveModelChoice('plain', 'что-угодно')).toEqual({});
      // Свой провайдер с `{model}`, но без списка: значение доедет до команды.
      expect(await resolveModelChoice('smart', 'anything')).toEqual({ model: 'anything' });
    });

    it('неизвестный провайдер не ловится здесь: об этом скажет запуск, как и прежде', async () => {
      expect(await resolveModelChoice('нет-такого', 'opus', 'high')).toEqual({ model: 'opus', effort: 'high' });
    });

    it('свой список из providers.json заменяет встроенный: своё проходит, встроенное — bad_request', async () => {
      await writeProviders({ claude: { models: [{ id: 'my-new-model', label: 'Моя новая' }] } });

      expect(await resolveModelChoice('claude', 'my-new-model')).toEqual({ model: 'my-new-model' });
      await expect(resolveModelChoice('claude', 'opus')).rejects.toMatchObject({
        code: 'bad_request',
      });
      // Соседний провайдер остался при своём списке.
      expect(await resolveModelChoice('codex', 'gpt-6-sol')).toEqual({ model: 'gpt-6-sol' });
    });

    it('пустой список в providers.json снимает проверку: списка у провайдера больше нет', async () => {
      await writeProviders({ claude: { models: [] } });

      expect(await resolveModelChoice('claude', 'claude-opus-5-5')).toEqual({ model: 'claude-opus-5-5' });
    });

    it('список у провайдера, чей шаблон не принимает {model}, окну не отдаётся — значит, и не проверяется', async () => {
      await writeProviders({
        plain: {
          badge: 'Plain',
          command: 'plain',
          args: ['{prompt}'],
          models: [{ id: 'a', label: 'А' }],
        },
      });

      // Выбор до команды всё равно не доедет: resolver его отбрасывает, отказывать нечему.
      expect(await resolveModelChoice('plain', 'b')).toEqual({});
    });
  });

  describe('resolveModelChoice: effort по уровням модели (спека нормалайзера, 5.3)', () => {
    it('уровень модели — как есть; пустой — без поля; у модели «по умолчанию» — общие уровни провайдера', async () => {
      expect(await resolveModelChoice('claude', 'opus', 'xhigh')).toEqual({ model: 'opus', effort: 'xhigh' });
      expect(await resolveModelChoice('claude', 'opus', '')).toEqual({ model: 'opus' });
      expect(await resolveModelChoice('claude', undefined, 'max')).toEqual({ effort: 'max' });
      expect(await resolveModelChoice('glm', 'glm-5.3[1m]', 'max')).toEqual({ model: 'glm-5.3[1m]', effort: 'max' });
      expect(await resolveModelChoice('codex', 'gpt-6.1-sol', 'ultra')).toEqual({ model: 'gpt-6.1-sol', effort: 'ultra' });
    });

    it('уровня нет у модели — bad_request с причиной и списком допустимого', async () => {
      await expect(resolveModelChoice('claude', 'haiku', 'high')).rejects.toMatchObject({
        name: 'HostError',
        code: 'bad_request',
      });
      await expect(resolveModelChoice('claude', 'haiku', 'high')).rejects.toThrow(/haiku has no effort levels/);
      await expect(resolveModelChoice('claude', 'opus', 'ultra')).rejects.toThrow(
        /ultra is not a level of opus; allowed: low, medium, high, xhigh, max/,
      );
      await expect(resolveModelChoice('codex', 'gpt-6-luna', 'ultra')).rejects.toThrow(/ultra is not a level of gpt-6-luna/);
      // «По умолчанию» у Codex — общие уровни видимых моделей, а `ultra` есть не у всех.
      await expect(resolveModelChoice('codex', undefined, 'ultra')).rejects.toMatchObject({ code: 'bad_request' });
    });

    it('провайдер без {effort} в шаблоне отбрасывает уровень молча, как и прежде', async () => {
      await writeProviders({ smart: { badge: 'Smart', command: 'smart', args: ['--m', '{model}'] } });

      expect(await resolveModelChoice('smart', 'anything', 'high')).toEqual({ model: 'anything' });
    });

    it('каталог Codex из файла хоста: модель и уровни из него, а свой список из providers.json важнее', async () => {
      const live: ModelOption[] = [{ id: 'gpt-7-nova', label: 'GPT-7-Nova', efforts: [{ id: 'ultra', label: 'Ultra' }] }];
      // Без файла — встроенный список, а модели из каталога в нём нет.
      await expect(resolveModelChoice('codex', 'gpt-7-nova', 'ultra')).rejects.toMatchObject({ code: 'bad_request' });

      await writeFile(codexModelsFile(), JSON.stringify({ fetchedAt: '2026-10-06T10:00:00.000Z', models: live }), 'utf8');
      expect(await resolveModelChoice('codex', 'gpt-7-nova', 'ultra')).toEqual({ model: 'gpt-7-nova', effort: 'ultra' });
      // Каталог Codex другим провайдерам не достаётся.
      await expect(resolveModelChoice('claude', 'gpt-7-nova')).rejects.toMatchObject({ code: 'bad_request' });

      await writeProviders({ codex: { models: [{ id: 'mine', label: 'Моя' }] } });
      expect(await resolveModelChoice('codex', 'mine')).toEqual({ model: 'mine' });
      await expect(resolveModelChoice('codex', 'gpt-7-nova')).rejects.toMatchObject({ code: 'bad_request' });
    });

    it('токен уровня один в core и в протоколе: EFFORT_TOKEN и EFFORT_TOKEN_RE с одним исходником', () => {
      expect(EFFORT_TOKEN_RE.source).toBe(EFFORT_TOKEN.source);
      expect(EFFORT_TOKEN_RE.flags).toBe(EFFORT_TOKEN.flags);
      // Схема sessions.create принимает effort ровно тогда, когда его примет core (схемы смены — с Task 10).
      const create = { projectPath: '/p', workId: 'w-0001', provider: 'claude', label: '', task: '', parent: null };
      const samples = ['low', 'xhigh', 'ultra', 'max_2', 'a-b', 'a', 'a'.repeat(32), 'a'.repeat(33), 'High', '1low', '-low', 'x"y', 'x y', 'low\n', ''];
      for (const effort of samples) {
        const schemaAccepts = METHODS['sessions.create'].safeParse({ ...create, effort }).success;
        expect(schemaAccepts, JSON.stringify(effort)).toBe(EFFORT_TOKEN.test(effort));
      }
    });
  });
  ```

  `packages/host/src/sessions/sessions-service.test.ts`, импорт core (строки 10-12). Было:
  ```ts
  import {
    addSession,
    createPendingSession,
  ```
  Стало:
  ```ts
  import {
    addSession,
    codexModelsFile,
    createPendingSession,
  ```

  Строка 274 (помощник `launched`). Было:
  ```ts
      choice: { model?: string; effort?: 'low' | 'medium' | 'high' },
  ```
  Стало:
  ```ts
      choice: { model?: string; effort?: string },
  ```

  Строки 430-433 (конец `describe('create(): модель и усилие из диалога…')`). Было:
  ```ts
    it('GLM rejects an unsupported model before launch', async () => {
      await expect(launched('glm', { model: 'glm-4', effort: 'high' })).rejects.toThrow();
    });
  });
  ```
  Стало:
  ```ts
    it('GLM rejects an unsupported model before launch', async () => {
      await expect(launched('glm', { model: 'glm-4', effort: 'high' })).rejects.toThrow();
    });

    it('уровень сверх прежних трёх доезжает до команды: claude --effort xhigh', async () => {
      const argv = await launched('claude', { model: 'opus', effort: 'xhigh' });

      expect(argv[argv.indexOf('--effort') + 1]).toBe('xhigh');
    });

    it('codex с каталогом из файла хоста: модель и уровень из каталога CLI доезжают до команды', async () => {
      setEnv('PARLEY_CODEX_BIN', STUB);
      // Свой дом: файл каталога не должен достаться другим тестам процесса.
      const home = await mkdtemp(path.join(tmpdir(), 'parley-sessions-home-'));
      setEnv('PARLEY_HOME', home);
      try {
        const models = [{ id: 'gpt-7-nova', label: 'GPT-7-Nova', efforts: [{ id: 'ultra', label: 'Ultra' }] }];
        await writeFile(codexModelsFile(), JSON.stringify({ fetchedAt: '2026-10-06T10:00:00.000Z', models }), 'utf8');

        const argv = await launched('codex', { model: 'gpt-7-nova', effort: 'ultra' });

        expect(argv[argv.indexOf('--model') + 1]).toBe('gpt-7-nova');
        expect(argv).toContain('model_reasoning_effort="ultra"');
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });

    it('все пути создания пишут разрешённые model и effort в запись сессии (спека нормалайзера, 5.5); без выбора полей нет', async () => {
      const work = await createWork(project, { title: 'Работа', goal: '' });
      setEnv('STUB_ARGS_FILE', await tempArgsFile());
      const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
      const parent = await createPendingSession(project, work.work.id, { provider: 'claude', label: 'родитель', task: 'т' });
      const base = { projectPath: project, provider: 'claude', label: '' };
      const choice = { model: 'opus', effort: 'xhigh' };

      // Тихий старт, новая работа под быструю сессию, дочерняя без задачи и `pending` с задачей.
      const refs = [
        await service.create({ ...base, workId: work.work.id, task: '', parent: null, ...choice }),
        await service.create({ ...base, workId: null, task: '', parent: null, ...choice }),
        await service.create({ ...base, workId: work.work.id, task: '', parent, ...choice }),
        await service.create({ ...base, workId: work.work.id, task: 'сделай штуку', parent: null, ...choice }),
      ];
      for (const ref of refs) {
        const map = await readMap(ref.projectPath, ref.workId);
        expect(map.sessions.find((candidate) => candidate.id === ref.sessionId), ref.sessionId).toMatchObject(choice);
        await service.stop(ref);
      }

      const plain = await service.create({ ...base, workId: work.work.id, task: '', parent: null });
      const session = (await readMap(project, work.work.id)).sessions.find((candidate) => candidate.id === plain.sessionId);
      expect(session).toBeDefined();
      expect(Object.keys(session ?? {})).not.toContain('model');
      expect(Object.keys(session ?? {})).not.toContain('effort');
      await service.stop(plain);
    });

    it('пара не из каталога — bad_request до первой записи: ни сессии, ни процесса', async () => {
      const work = await createWork(project, { title: 'Работа', goal: '' });
      const argsFile = await tempArgsFile();
      setEnv('STUB_ARGS_FILE', argsFile);
      const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
      const create = (task: string, choice: { model?: string; effort: string }) =>
        service.create({ projectPath: project, workId: work.work.id, provider: 'claude', label: '', task, parent: null, ...choice });

      await expect(create('', { model: 'haiku', effort: 'high' })).rejects.toThrow(/haiku has no effort levels/);
      await expect(create('сделай штуку', { model: 'opus', effort: 'ultra' })).rejects.toThrow(/ultra is not a level of opus/);
      await expect(create('', { effort: 'ultra' })).rejects.toMatchObject({ name: 'HostError', code: 'bad_request' });

      expect(existsSync(argsFile)).toBe(false);
      expect((await readMap(project, work.work.id)).sessions).toEqual([]);
    });
  });
  ```

- [ ] **Step 2: Прогон — падает**

  Run: `pnpm --filter @parley/host exec vitest run src/sessions/model-choice.test.ts src/sessions/sessions-service.test.ts`
  Expected: FAIL. `model-choice.test.ts`: `expected 'best' to deeply equal { model: 'best' }` и подобные (старая
  функция возвращает строку); `promise resolved "'haiku'" instead of rejecting` (effort не проверяется); тест
  каталога из файла — `expected 'gpt-7-nova' to deeply equal { model: 'gpt-7-nova', effort: 'ultra' }`; «провайдер без
  списка…» — `expected 'что-угодно' to deeply equal {}`. Тест паритета токенов уже зелёный.
  `sessions-service.test.ts`: «все пути создания…» — запись без `model`/`effort`; «пара не из каталога…» —
  `promise resolved … instead of rejecting`. Тесты `--effort xhigh` и «codex с каталогом из файла хоста…» уже
  зелёные: файл читает `loadProviders` (Task 5), а уровень прежний код не проверял — тесты закрепляют поведение.

- [ ] **Step 3: Реализация**

  `packages/host/src/sessions/model-choice.ts` — новое содержимое целиком:

  ```ts
  /**
   * Модель и effort из диалога запуска против каталога провайдера (дизайн комнат, 3.2; спека нормалайзера, 5.3).
   *
   * Окно предлагает только значения каталога (`providers.list.models` и их `efforts`), а хост не пускает в команду
   * ничего сверх него: пара вне каталога — `bad_request`, CLI такое значение не получает. Пустое значение, как и
   * его отсутствие, — «по умолчанию»: без флага, CLI берёт своё.
   *
   * Правило одно с `spawn_session` MCP — `resolveModelEffort` в core: провайдер без своего списка, флаг без
   * подстановки в шаблоне, модель без уровней — всё решает он. Каталог Codex из `codex-models.json` подставляет
   * `loadProviders`, поэтому окно, хост и MCP проверяют выбор по одному списку. Неизвестный провайдер здесь не
   * ловится: об этом скажет сам запуск.
   */

  import { loadProviders, resolveModelEffort, type ModelEffortChoice } from '@parley/core';
  import { HostError } from '../errors.js';

  /**
   * Разрешённый выбор для карты и команды: полей «по умолчанию» в нём нет. Зовётся до создания записи в карте:
   * отказ не должен оставлять `pending`-сессию, которую нечем запустить.
   */
  export async function resolveModelChoice(
    provider: string,
    model?: string,
    effort?: string,
  ): Promise<ModelEffortChoice> {
    const choice: ModelEffortChoice = {
      ...(model === undefined || model === '' ? {} : { model }),
      ...(effort === undefined || effort === '' ? {} : { effort }),
    };
    if (choice.model === undefined && choice.effort === undefined) return choice;

    const entry = (await loadProviders())[provider];
    if (entry === undefined) return choice;
    const resolved = resolveModelEffort(entry, choice);
    if ('error' in resolved) throw new HostError('bad_request', resolved.error);
    return resolved.choice;
  }
  ```

  `packages/host/src/sessions/sessions-service.ts`. Было (строки 51-54):
  ```ts
    type EffortLevel,
    type WorkEntry,
    type ProviderEntry,
  } from '@parley/core';
  ```
  Стало:
  ```ts
    type ModelEffortChoice,
    type WorkEntry,
    type ProviderEntry,
  } from '@parley/core';
  ```
  Было (строки 80-98):
  ```ts
    /**
     * Модель и усилие из диалога запуска (дизайн комнат, 3.2). До команды они доезжают через
     * реестр провайдеров: тот, у кого в шаблоне нет их подстановок, выбор молча отбрасывает.
     * Модель — значение из списка провайдера, если список есть (`resolveModelChoice`: вне списка —
     * `bad_request`); пустая — «по умолчанию», без флага.
     */
    model?: string;
    effort?: EffortLevel;
  }

  export type LaunchMode = 'launch' | 'resume' | 'new';

  /** Что `launch()` передаёт плану запуска сверх самой сессии. */
  export interface LaunchChoice {
    /** Указатель первым ходом `resume`, если провайдер его принимает. */
    prompt?: string;
    model?: string;
    effort?: EffortLevel;
  }
  ```
  Стало:
  ```ts
    /**
     * Модель и усилие из диалога запуска (дизайн комнат, 3.2; спека нормалайзера, 5.3). Пару проверяет
     * `resolveModelChoice`: вне каталога провайдера — `bad_request`, пустое значение — «по умолчанию», без флага.
     * Разрешённый выбор ложится в запись сессии (`WorkSession.model`, `.effort`): его берут и повторный запуск,
     * и resume.
     */
    model?: string;
    effort?: string;
  }

  export type LaunchMode = 'launch' | 'resume' | 'new';

  /** Что `launch()` передаёт плану запуска сверх самой сессии. */
  export interface LaunchChoice {
    /** Указатель первым ходом `resume`, если провайдер его принимает. */
    prompt?: string;
    model?: string;
    effort?: string;
  }
  ```
  Было (строка 102):
  ```ts
    /** `prompt` — указатель первым ходом `resume`; `model` и `effort` — только у новой сессии. */
  ```
  Стало:
  ```ts
    /** `prompt` — указатель первым ходом `resume`; `model` и `effort` перекрывают выбор из карты. */
  ```
  Было (строки 381-395):
  ```ts
    /**
     * Быстрая и дочерняя сессии core заводит с ярлыком `NEW_LABEL` и
     * провайдером claude. Ярлык и провайдер из диалога окна должны остаться —
     * иначе выбор человека молча терялся бы. Пустой ярлык оставляет `NEW_LABEL`,
     * и тогда сессию переименует заголовок Claude Code (автозаголовок).
     */
    async function applyChoice(ref: SessionRef, label: string, provider: string): Promise<void> {
      const trimmed = label.trim();
      await updateMap(ref.projectPath, ref.workId, (map) => {
        const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
        if (session === undefined) return;
        if (trimmed !== '') session.label = trimmed;
        session.provider = provider;
      });
    }
  ```
  Стало:
  ```ts
    /**
     * Быстрая и дочерняя сессии core заводит с ярлыком `NEW_LABEL` и
     * провайдером claude. Ярлык и провайдер из диалога окна должны остаться —
     * иначе выбор человека молча терялся бы. Пустой ярлык оставляет `NEW_LABEL`,
     * и тогда сессию переименует заголовок Claude Code (автозаголовок). Модель и
     * усилие ложатся в запись так же, как их пишет `spawn_session`: без выбора полей нет.
     */
    async function applyChoice(
      ref: SessionRef,
      label: string,
      provider: string,
      choice: ModelEffortChoice,
    ): Promise<void> {
      const trimmed = label.trim();
      await updateMap(ref.projectPath, ref.workId, (map) => {
        const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
        if (session === undefined) return;
        if (trimmed !== '') session.label = trimmed;
        session.provider = provider;
        if (choice.model !== undefined) session.model = choice.model;
        if (choice.effort !== undefined) session.effort = choice.effort;
      });
    }
  ```
  Было (строки 435-489, `create` целиком):
  ```ts
    async function create(input: CreateSessionInput): Promise<SessionRef> {
      const { projectPath, workId, provider, label, task, parent, worktree, effort } = input;
      // Secret-dependent GLM must refuse before every create branch. Other providers keep their
      // existing create/launch failure behavior; all launches still use the shared preflight below.
      if ((await loadProviders())[provider]?.runner.secret !== undefined) await readyProvider(provider);
      // Модель — раньше всего: значение не из списка провайдера отвергается до первой записи в карте
      // (иначе осталась бы `pending`-сессия, которую нечем запустить), а пустое — «по умолчанию».
      const model = await resolveModelChoice(provider, input.model);
      // `exactOptionalPropertyTypes`: явный `undefined` ключом в `LaunchChoice` не проходит.
      const choice: LaunchChoice = {
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
      };

      // Проверка до создания сессии, а не после (как и в `spawn_session` core,
      // кусок 4.1) — иначе в карте осталась бы pending-сессия, которую нечем завести.
      if (worktree === true && !(await isGitRepo(projectPath))) {
        throw new HostError('bad_request', 'the project has no git — a worktree cannot be created');
      }

      if (workId === null) {
        const created = await createNewSession(projectPath, null);
        const ref = { projectPath, workId: created.workId, sessionId: created.session.id };
        await applyChoice(ref, label, provider);
        if (worktree === true) await attachWorktreePlan(ref, null, false);
        return createInteractive(ref, 'new', choice);
      }

      if (task === '' && parent === null) {
        const created = await createNewSession(projectPath, workId);
        const ref = { projectPath, workId, sessionId: created.session.id };
        await applyChoice(ref, label, provider);
        if (worktree === true) await attachWorktreePlan(ref, null, false);
        return createInteractive(ref, 'new', choice);
      }

      if (task === '' && parent !== null) {
        const created = await createChildSession(projectPath, workId, parent);
        const ref = { projectPath, workId, sessionId: created.session.id };
        await applyChoice(ref, label, provider);
        if (worktree === true) await attachWorktreePlan(ref, parent, true);
        return createInteractive(ref, 'launch', choice);
      }

      const sessionId = await createPendingSession(projectPath, workId, {
        provider,
        label,
        task,
        parent,
        contextFrom: parent === null ? [] : [parent],
      });
      const ref = { projectPath, workId, sessionId };
      if (worktree === true) await attachWorktreePlan(ref, parent, true);
      return createInteractive(ref, 'launch', choice);
    }
  ```
  Стало:
  ```ts
    async function create(input: CreateSessionInput): Promise<SessionRef> {
      const { projectPath, workId, provider, label, task, parent, worktree } = input;
      // Secret-dependent GLM must refuse before every create branch. Other providers keep their
      // existing create/launch failure behavior; all launches still use the shared preflight below.
      if ((await loadProviders())[provider]?.runner.secret !== undefined) await readyProvider(provider);
      // Модель и усилие — раньше всего: пара не из каталога провайдера отвергается до первой записи в карте (иначе
      // осталась бы `pending`-сессия, которую нечем запустить), а пустое значение — «по умолчанию». Разрешённый выбор
      // пишется в запись сессии на всех путях ниже: повторный запуск и resume берут его оттуда (спека нормалайзера, 5.5).
      const choice = await resolveModelChoice(provider, input.model, input.effort);

      // Проверка до создания сессии, а не после (как и в `spawn_session` core,
      // кусок 4.1) — иначе в карте осталась бы pending-сессия, которую нечем завести.
      if (worktree === true && !(await isGitRepo(projectPath))) {
        throw new HostError('bad_request', 'the project has no git — a worktree cannot be created');
      }

      if (workId === null) {
        const created = await createNewSession(projectPath, null);
        const ref = { projectPath, workId: created.workId, sessionId: created.session.id };
        await applyChoice(ref, label, provider, choice);
        if (worktree === true) await attachWorktreePlan(ref, null, false);
        return createInteractive(ref, 'new', choice);
      }

      if (task === '' && parent === null) {
        const created = await createNewSession(projectPath, workId);
        const ref = { projectPath, workId, sessionId: created.session.id };
        await applyChoice(ref, label, provider, choice);
        if (worktree === true) await attachWorktreePlan(ref, null, false);
        return createInteractive(ref, 'new', choice);
      }

      if (task === '' && parent !== null) {
        const created = await createChildSession(projectPath, workId, parent);
        const ref = { projectPath, workId, sessionId: created.session.id };
        await applyChoice(ref, label, provider, choice);
        if (worktree === true) await attachWorktreePlan(ref, parent, true);
        return createInteractive(ref, 'launch', choice);
      }

      const sessionId = await createPendingSession(projectPath, workId, {
        provider,
        label,
        task,
        parent,
        contextFrom: parent === null ? [] : [parent],
        ...choice,
      });
      const ref = { projectPath, workId, sessionId };
      if (worktree === true) await attachWorktreePlan(ref, parent, true);
      return createInteractive(ref, 'launch', choice);
    }
  ```

- [ ] **Step 4: Прогон — зелёный; сборка и стражи**

  Run: `pnpm --filter @parley/host exec vitest run src/sessions/model-choice.test.ts src/sessions/sessions-service.test.ts src/methods/sessions.test.ts src/methods/providers.test.ts src/english-text.test.ts`
  Expected: PASS, все файлы (`model-choice.test.ts` — 16 тестов).

  Run: `pnpm --filter @parley/host build`
  Expected: exit 0 (в хосте не осталось `EffortLevel`).

  Run: `pnpm exec eslint packages/host/src/sessions`
  Expected: без ошибок.

- [ ] **Step 5: Коммит**

  ```bash
  git add packages/host/src/sessions/model-choice.ts packages/host/src/sessions/model-choice.test.ts \
    packages/host/src/sessions/sessions-service.ts packages/host/src/sessions/sessions-service.test.ts
  git commit -m "feat(host): выбор модели и effort из диалога проходит resolver и ложится в карту" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 10: `sessions.setEffort` — ползунок `/effort` и `s` со сверкой по подвалу

**Files:**
- Modify: `packages/protocol/src/methods.ts` (схема и результат `sessions.setEffort` рядом с `sessions.setMode`)
- Modify: `packages/protocol/src/methods.test.ts` (новый `describe` в конце файла)
- Create: `packages/host/src/pty/effort-switch.ts`
- Create: `packages/host/src/pty/effort-switch.test.ts`
- Create: `packages/host/test/fake-effort-screen.ts`
- Modify: `packages/host/src/sessions/sessions-service.ts:55, 57` (импорты), `:115-117` (`SessionsService`), `:128-129` (помощники и замок), `:138` (`exclusive`), `:491-497` (`setChoice` после `stop`), `:610-615` (объект сервиса)
- Modify: `packages/host/src/sessions/sessions-service.test.ts:27, 34-35` (импорты), новые `describe` в конце файла
- Modify: `packages/host/src/methods/sessions.ts` (новое содержимое целиком)
- Modify: `packages/host/src/methods/sessions.test.ts:1-5` (импорты), новый `describe` в конце файла
- Modify: `packages/host/src/methods/index.ts:68, 131`
- Modify: `packages/host/src/methods/index.test.ts:51`
- Modify: `packages/host/src/server.test.ts:168-171`

**Interfaces:**
- Consumes (core): `effortsFor(entry, model): EffortOption[] | null` и `resolveModelEffort` (Task 2), `isClaudeCode`,
  `hookedSince(activity, sinceMs)`, `readMap`, `loadProviders`, `createWork`/`createPendingSession` (тесты).
  (protocol): `EFFORT_TOKEN_RE` и `HOST_ERROR_REASONS.busy` (Task 6). (host): `ActivityService.get(ref): SessionLive |
  undefined`, `PtyManager` `write/on/get/screenText/setHostDraft`, `PtyHandle.startedAt`, `PtyHandle.hasDraft()`,
  `WakeService.inFlight(ref)`, `POLL_MS`, `QUIET_MS`, `QUIET_MAX_MS` из `pty/mode-switch.ts`.
- Produces:
  ```ts
  // pty/effort-switch.ts
  export function effortFromFooter(lines: readonly string[]): string | null;
  export interface EffortSwitchResult { effort: string | null; verified: boolean }
  export interface EffortSwitchDeps { pty: Pick<PtyManager, 'write' | 'on' | 'get' | 'screenText'>; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout }
  export async function switchEffort(ref: SessionRef, target: string, levels: readonly string[], deps: EffortSwitchDeps): Promise<EffortSwitchResult>;
  // sessions/sessions-service.ts
  export function atPrompt(live: SessionLive | undefined): boolean;
  export function busyError(message: string): HostError;   // HostError('conflict', message, { reason: 'busy' })
  export type SwitchLock = <T>(ref: SessionRef, run: () => Promise<T>) => Promise<T>;
  export function createSwitchLock(): SwitchLock;
  SessionsService.setChoice(ref: SessionRef, choice: { model?: string | null; effort?: string | null }): Promise<void>;
  SessionsService.exclusive: SwitchLock;   // общий замок sessions.setEffort и sessions.setModel (Task 11)
  // methods/sessions.ts
  SessionMethodDeps.pty: Pick<PtyManager, 'write' | 'on' | 'get' | 'screenText' | 'setHostDraft'>;
  SessionMethodDeps.activity: Pick<ActivityService, 'get'>;
  SessionMethodDeps.wake: Pick<WakeService, 'inFlight'>;
  SessionHandlers.sessionsSetEffort: Handler<'sessions.setEffort'>;
  // protocol (methods.ts)
  METHODS['sessions.setEffort'] = z.object({ ref: sessionRef, effort: z.string().regex(EFFORT_TOKEN_RE) });
  Result<'sessions.setEffort'> = { effort: string | null; verified: boolean };
  ```
- Отказы `sessions.setEffort`: `not_found` — нет живого PTY или сессии в карте; `bad_request` — сессия не семейства
  `claude` или уровня нет у модели из карты (текст resolver); `conflict` с `data.reason: 'busy'` — агент не у приглашения
  (`idle`/`unseen`), с запуска процесса не было ни одного хука (Enter мог бы ответить на вопрос доверия к папке, как
  страхуется `pty.send`), в поле ввода черновик, будильник печатает указатель, ползунок `/effort` уже открыт, идёт другая
  смена той же сессии. Во всех отказах в PTY не уходит ни одной клавиши. Пока идёт смена, хост держит черновик хоста:
  будильник не начнёт печатать указатель поверх ползунка.

- [ ] **Step 1: Протокол — схема и результат `sessions.setEffort`**

  Протокол и регистрация обработчика (шаг 8) — в одном коммите: `server.test.ts` хоста сверяет `hello.methods` с
  ключами `METHODS`.

  `packages/protocol/src/methods.ts` — найти:
  ```ts
    'sessions.setMode': z.object({ ref: sessionRef, mode: permissionModeChoice }),
  ```
  заменить на:
  ```ts
    'sessions.setMode': z.object({ ref: sessionRef, mode: permissionModeChoice }),
    // Смена effort идущей сессии из меню чата (нормалайзер модели и effort, 5.7). «По умолчанию» здесь не выбирается:
    // `/effort auto` стёр бы сохранённый уровень человека. Уровни модели сверяет хост (`bad_request`).
    'sessions.setEffort': z.object({ ref: sessionRef, effort: z.string().regex(EFFORT_TOKEN_RE) }),
  ```
  Тот же файл, `Results` — найти:
  ```ts
    'sessions.setMode': { mode: string | null; verified: boolean };
  ```
  заменить на:
  ```ts
    'sessions.setMode': { mode: string | null; verified: boolean };
    /**
     * Смена effort ползунком `/effort` (нормалайзер модели и effort, 5.7). `effort` — уровень, который
     * показал подвал CLI (`null` — подвала не нашли); `verified` — он совпал с целью, и хост записал его в
     * карту. Не совпал — карта не меняется.
     */
    'sessions.setEffort': { effort: string | null; verified: boolean };
  ```

  `packages/protocol/src/methods.test.ts` — дописать в конец файла:
  ```ts

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
  ```

  Run (из корня), до правки `methods.ts`: `pnpm --filter @parley/protocol exec vitest run src/methods.test.ts`
  Expected: `Tests  1 failed | 50 passed (51)` — «setEffort: …» падает с `TypeError: Cannot read properties of undefined (reading 'safeParse')`.

  Run (после правки):
  ```bash
  pnpm --filter @parley/protocol test
  pnpm --filter @parley/protocol exec tsc --noEmit --skipLibCheck --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --module NodeNext --moduleResolution NodeNext --target ES2022 --verbatimModuleSyntax src/methods.test.ts
  pnpm --filter @parley/protocol build
  pnpm --filter @parley/host exec node --input-type=module -e "const p = await import('@parley/protocol'); console.log(p.HOST_ERROR_REASONS.busy, 'sessions.setEffort' in p.METHODS, 'sessions.setModel' in p.METHODS)"
  ```
  Expected: `Tests  94 passed (94)`; tsc и сборка — exit 0; последняя строка — `busy true false`. До шага 8 тест хоста
  `server.test.ts` («methods — ровно отсортированные ключи METHODS») красный: обработчика ещё нет.

- [ ] **Step 2: Экран-подмена и тесты модуля ползунка (падают: модуля нет)**

  Создать `packages/host/test/fake-effort-screen.ts`:

  ```ts
  /**
   * Экран Claude Code с ползунком `/effort` для тестов смены effort (спека нормалайзера, 5.7): `PtyManager` без
   * процесса, который отвечает на печать хоста так, как Claude Code 2.1.289 на живой проверке 2026-10-06.
   * `/effort` и Enter открывают ползунок со строкой подсказки, `←`/`→` двигают уровень с упором в края, `s`
   * закрывает ползунок и показывает уровень в подвале, Esc закрывает ползунок без изменений.
   */

  import type { SessionRef } from '@parley/protocol';
  import type { EffortSwitchDeps } from '../src/pty/effort-switch.js';
  import type { PtyManager } from '../src/pty/pty-manager.js';

  /** Уровни ползунка Claude Code по порядку. */
  export const SLIDER_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

  /** Строки открытого ползунка, как их рисует Claude Code 2.1.289. */
  export const SLIDER_LINES = ['Effort', '←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel'];

  /** Знак подвала по уровню; у `xhigh` настоящего знака не видели — взят выдуманный: разбор от знака не зависит. */
  const GLYPHS: Record<string, string> = { low: '○', medium: '◐', high: '●', xhigh: '◍', max: '◈' };

  /** Подвал после `s`: «◐ medium · /effort». */
  export const footerLine = (level: string): string => `  ${GLYPHS[level] ?? '◇'} ${level} · /effort`;

  export interface FakeEffortScreen {
    deps: EffortSwitchDeps;
    /** Тот же экран для обработчика `sessions.setEffort`: он ещё держит черновик хоста. */
    pty: Pick<PtyManager, 'write' | 'on' | 'get' | 'screenText' | 'setHostDraft'>;
    /** Всё, что напечатал хост, по вызовам `write`. */
    writes: string[];
    /** Черновик хоста по вызовам `setHostDraft`: пока ползунок открыт, будильник не печатает. */
    hostDrafts: boolean[];
    live: boolean;
    /** Неотправленный текст в поле ввода (`PtyHandle.hasDraft`). */
    draft: boolean;
    /** Открывает ли Enter после `/effort` ползунок. */
    opens: boolean;
    /** Верхний уровень, который примет CLI (как предел администратора); `null` — предела нет. */
    cap: string | null;
    /** `s` теряется: ползунок остаётся открытым, подвал — прежним. */
    dropS: boolean;
    /** Через сколько мс после `s` подвал покажет новый уровень; до того — прежний. */
    footerDelayMs: number;
    /** Уровень в подвале; `null` — подвала с уровнем нет. */
    footer: string | null;
    sliderOpen: boolean;
  }

  export function fakeEffortScreen(footer: string | null): FakeEffortScreen {
    let input = '';
    let position = 0;
    const state: FakeEffortScreen = {
      deps: undefined as unknown as EffortSwitchDeps,
      pty: undefined as unknown as FakeEffortScreen['pty'],
      writes: [],
      hostDrafts: [],
      live: true,
      draft: false,
      opens: true,
      cap: null,
      dropS: false,
      footerDelayMs: 0,
      footer,
      sliderOpen: false,
    };

    const show = (level: string): void => {
      if (state.footerDelayMs === 0) {
        state.footer = level;
        return;
      }
      setTimeout(() => {
        state.footer = level;
      }, state.footerDelayMs);
    };

    const press = (data: string): void => {
      if (!state.sliderOpen) {
        if (data === '\r' && input === '/effort' && state.opens) {
          state.sliderOpen = true;
          position = Math.max(0, SLIDER_LEVELS.indexOf(state.footer ?? 'medium'));
        }
        input = data === '\r' || data === '\x1b' ? '' : input + data;
        return;
      }
      if (data === '\x1b[D') position = Math.max(0, position - 1);
      else if (data === '\x1b[C') position = Math.min(SLIDER_LEVELS.length - 1, position + 1);
      else if (data === '\x1b') state.sliderOpen = false;
      else if (data === 's' && !state.dropS) {
        state.sliderOpen = false;
        const top = state.cap === null ? SLIDER_LEVELS.length - 1 : SLIDER_LEVELS.indexOf(state.cap);
        show(SLIDER_LEVELS[Math.min(position, top)] as string);
      }
    };

    state.pty = {
      // Процесс «запущен» в нулевую миллисекунду: хук после старта (`hookedSince`) задаёт активность теста.
      get: (ref: SessionRef) => (state.live ? ({ ref, startedAt: 0, hasDraft: () => state.draft } as never) : undefined),
      write: (_ref: SessionRef, data: string) => {
        state.writes.push(data);
        press(data);
      },
      // Подвал — не последняя строка: ниже пустая, как у короткого разговора.
      screenText: () =>
        state.live
          ? [
              '',
              'Claude Code',
              `> ${input}`,
              ...(state.sliderOpen ? SLIDER_LINES : []),
              ...(state.footer === null ? [] : [footerLine(state.footer)]),
              '',
            ]
          : undefined,
      on: () => () => {},
      setHostDraft: (_ref: SessionRef, value: boolean) => {
        state.hostDrafts.push(value);
      },
    } as unknown as FakeEffortScreen['pty'];
    state.deps = { pty: state.pty };
    return state;
  }
  ```

  Создать `packages/host/src/pty/effort-switch.test.ts`:

  ```ts
  /**
   * Смена effort ползунком `/effort` и `s` со сверкой подвала (спека нормалайзера, 5.7): экран-подмена отвечает,
   * как Claude Code 2.1.289 на живой проверке, часы фальшивые — тишина, опрос и паузы между клавишами идут по ним.
   */

  import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
  import type { SessionRef } from '@parley/protocol';
  import { fakeEffortScreen, footerLine, SLIDER_LINES } from '../../test/fake-effort-screen.js';
  import { effortFromFooter, switchEffort } from './effort-switch.js';

  const ref: SessionRef = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };
  const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const LEFT = '\x1b[D';
  const RIGHT = '\x1b[C';
  const times = (key: string, count: number): string[] => Array.from({ length: count }, () => key);

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('effortFromFooter', () => {
    it('уровень из подвала после s — при любом знаке перед ним и без знака', () => {
      expect(effortFromFooter(['  ○ low · /effort'])).toBe('low');
      expect(effortFromFooter(['  ◐ medium · /effort'])).toBe('medium');
      expect(effortFromFooter(['  ● high · /effort'])).toBe('high');
      expect(effortFromFooter(['  ◈ max · /effort'])).toBe('max');
      // Знак `xhigh` на живой проверке не видели: разбор от него не зависит.
      expect(effortFromFooter(['  ◍ xhigh · /effort'])).toBe('xhigh');
      expect(effortFromFooter(['xhigh · /effort'])).toBe('xhigh');
    });

    it('строки ползунка и набранная команда — не подвал; нижний подвал главнее; ничего нет — null', () => {
      expect(effortFromFooter([...SLIDER_LINES, '> /effort'])).toBeNull();
      expect(effortFromFooter([footerLine('high'), 'мусор', footerLine('low'), ''])).toBe('low');
      expect(effortFromFooter([])).toBeNull();
    });
  });

  describe('switchEffort', () => {
    it('medium → xhigh: /effort и Enter, ← на одно больше уровней, → до цели, s; подвал подтвердил', async () => {
      const screen = fakeEffortScreen('medium');
      const result = switchEffort(ref, 'xhigh', LEVELS, screen.deps);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toEqual({ effort: 'xhigh', verified: true });
      expect(screen.writes).toEqual(['/effort', '\r', ...times(LEFT, 6), ...times(RIGHT, 3), 's']);
    });

    it('цель low — только упор влево, без →', async () => {
      const screen = fakeEffortScreen(null);
      const result = switchEffort(ref, 'low', LEVELS, screen.deps);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toEqual({ effort: 'low', verified: true });
      expect(screen.writes).toEqual(['/effort', '\r', ...times(LEFT, 6), 's']);
    });

    it('ползунок не открылся за 3 с — Esc и verified false с тем, что в подвале; ни стрелок, ни s', async () => {
      const screen = fakeEffortScreen('high');
      screen.opens = false;
      const result = switchEffort(ref, 'max', LEVELS, screen.deps);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toEqual({ effort: 'high', verified: false });
      expect(screen.writes).toEqual(['/effort', '\r', '\x1b']);
    });

    it('подвал показал другой уровень (предел CLI) — verified false с увиденным; ползунок уже закрыт, Esc нет', async () => {
      const screen = fakeEffortScreen('medium');
      screen.cap = 'high';
      const result = switchEffort(ref, 'max', LEVELS, screen.deps);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toEqual({ effort: 'high', verified: false });
      expect(screen.writes.at(-1)).toBe('s');
    });

    it('s потерялся — ползунок открыт: через 2 с Esc, ответ — то, что в подвале', async () => {
      const screen = fakeEffortScreen(null);
      screen.dropS = true;
      const result = switchEffort(ref, 'high', LEVELS, screen.deps);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toEqual({ effort: null, verified: false });
      expect(screen.writes.at(-1)).toBe('\x1b');
      expect(screen.sliderOpen).toBe(false);
    });

    it('подвал ещё показывает прежний уровень сессии — хост ждёт цель, а не первое увиденное', async () => {
      const screen = fakeEffortScreen('high');
      screen.footerDelayMs = 300;
      const result = switchEffort(ref, 'low', LEVELS, screen.deps);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toEqual({ effort: 'low', verified: true });
    });

    it('ползунок открыт до печати — conflict busy, хост не жмёт ничего: Enter в нём сохранил бы умолчание человека', async () => {
      const screen = fakeEffortScreen('medium');
      screen.sliderOpen = true;
      const refused = expect(switchEffort(ref, 'max', LEVELS, screen.deps)).rejects.toMatchObject({
        name: 'HostError',
        code: 'conflict',
        data: { reason: 'busy' },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await refused;
      expect(screen.writes).toEqual([]);
    });

    it('сессия без живого PTY — not_found', async () => {
      const screen = fakeEffortScreen(null);
      screen.live = false;
      await expect(switchEffort(ref, 'low', LEVELS, screen.deps)).rejects.toMatchObject({
        name: 'HostError',
        code: 'not_found',
      });
    });
  });
  ```

- [ ] **Step 3: Прогон — падает**

  Run: `pnpm --filter @parley/host exec vitest run src/pty/effort-switch.test.ts`
  Expected: FAIL — `Error: Failed to load url ./effort-switch.js … Does the file exist?`

- [ ] **Step 4: Модуль ползунка**

  Создать `packages/host/src/pty/effort-switch.ts`:

  ```ts
  /**
   * Смена effort идущей сессии Claude Code из окна (спека нормалайзера, 5.7): хост печатает `/effort`, открывает
   * ползунок, ставит уровень стрелками и жмёт `s` — «только для этой сессии». Так уровень не становится умолчанием
   * человека: `Enter` в ползунке и `/effort <уровень>` пишут его в настройки CLI, а `s` — нет (живая проверка на
   * Claude Code 2.1.289, 2026-10-06). Образец — `mode-switch.ts`: печать хоста, чтение экрана, ожидание тишины.
   *
   * Где сейчас бегунок, хост не читает: `←` упирается в нижний край, поэтому их на одно больше, чем уровней; дальше
   * `→` до цели по порядку уровней модели. Итог сверяется по подвалу, который Claude Code показывает после `s`
   * («◐ medium · /effort»); знак перед уровнем не читается — у `xhigh` его ещё не видели. Подвал показал другое
   * (предел администратора, потерянная клавиша) — Esc, если ползунок ещё открыт, и ответ тем, что видно. Карту
   * меняет вызывающий и только при `verified: true`.
   *
   * Ползунок уже открыт до печати (его оставил человек в терминале) — хост ничего не жмёт и отвечает `busy`: Enter
   * после `/effort` сохранил бы уровень этого ползунка умолчанием человека.
   */

  import { HOST_ERROR_REASONS, refKey } from '@parley/protocol';
  import type { SessionRef } from '@parley/protocol';
  import { HostError } from '../errors.js';
  import { POLL_MS, QUIET_MAX_MS, QUIET_MS } from './mode-switch.js';
  import type { PtyManager } from './pty-manager.js';

  /** Команда ползунка и Enter, которым она уходит. */
  const COMMAND = '/effort';
  const ENTER = '\r';
  /** Стрелки и Esc — как их шлёт терминал. */
  const LEFT = '\x1b[D';
  const RIGHT = '\x1b[C';
  const ESC = '\x1b';
  /** «Только для этой сессии»: уровень применяется без записи умолчания человека. */
  const SESSION_ONLY = 's';
  /** Подсказка открытого ползунка: «←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel». */
  const SLIDER_HINT = 's for this session only';
  /** Сколько ждать ползунка после Enter (спека 5.7, п. 2). */
  const SLIDER_MAX_MS = 3_000;
  /** Сколько ждать подвала с уровнем после `s` (спека 5.7, п. 4). */
  const FOOTER_MAX_MS = 2_000;
  /** Пауза между нажатиями: пачку стрелок CLI мог бы прочесть одним вводом. */
  const KEY_GAP_MS = 50;
  /** Подвал после `s`: «◐ medium · /effort». */
  const FOOTER = /(?:^|\s)([a-z]+)\s*·\s*\/effort\b/;

  export interface EffortSwitchResult {
    /** Что показал подвал в конце; `null` — подвала с уровнем нет. */
    effort: string | null;
    /** Подвал показал ровно целевой уровень. */
    verified: boolean;
  }

  export interface EffortSwitchDeps {
    pty: Pick<PtyManager, 'write' | 'on' | 'get' | 'screenText'>;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
  }

  /** Уровень по подвалу: нижняя строка с ним побеждает; нет — `null`. */
  export function effortFromFooter(lines: readonly string[]): string | null {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const match = FOOTER.exec(lines[i] as string);
      if (match !== null) return match[1] as string;
    }
    return null;
  }

  /**
   * Ставит уровень `target` ползунком. `levels` — уровни модели сессии по порядку (`effortsFor`): их же показывает
   * ползунок. Проверку уровня по модели и занятость агента ведёт вызывающий.
   */
  export async function switchEffort(
    ref: SessionRef,
    target: string,
    levels: readonly string[],
    deps: EffortSwitchDeps,
  ): Promise<EffortSwitchResult> {
    const setTimer = deps.setTimer ?? setTimeout;
    const clearTimer = deps.clearTimer ?? clearTimeout;
    const { pty } = deps;
    if (pty.get(ref) === undefined) {
      throw new HostError('not_found', `no live PTY for session ${ref.sessionId}`);
    }
    const key = refKey(ref);

    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimer(resolve, ms);
      });

    // Вся видимая область, как у смены режима: у короткого разговора подвал стоит не в последней строке.
    const screen = (): readonly string[] => pty.screenText(ref) ?? [];
    const sliderOpen = (): boolean => screen().some((line) => line.includes(SLIDER_HINT));
    const shown = (): string | null => effortFromFooter(screen());

    /** Ждёт `QUIET_MS` без вывода PTY, но не дольше `QUIET_MAX_MS`: печать в разгар перерисовки теряется. */
    const waitQuiet = (): Promise<void> =>
      new Promise((resolve) => {
        let quiet: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
          unsubscribe();
          if (quiet !== undefined) clearTimer(quiet);
          clearTimer(cap);
          resolve();
        };
        const arm = (): void => {
          if (quiet !== undefined) clearTimer(quiet);
          quiet = setTimer(finish, QUIET_MS);
        };
        const unsubscribe = pty.on('output', (changed) => {
          if (refKey(changed) === key) arm();
        });
        const cap = setTimer(finish, QUIET_MAX_MS);
        arm();
      });

    /** Опрашивает экран раз в `POLL_MS`, пока `done` не скажет «да», но не дольше `maxMs`. */
    const poll = async (done: () => boolean, maxMs: number): Promise<void> => {
      for (let waited = 0; !done() && waited < maxMs; waited += POLL_MS) await sleep(POLL_MS);
    };

    const press = async (data: string, count: number): Promise<void> => {
      for (let i = 0; i < count; i += 1) {
        pty.write(ref, data);
        await sleep(KEY_GAP_MS);
      }
    };

    await waitQuiet();
    if (sliderOpen()) {
      throw new HostError('conflict', 'The /effort slider is already open in the terminal; close it first', {
        reason: HOST_ERROR_REASONS.busy,
      });
    }
    pty.write(ref, COMMAND);
    await waitQuiet();
    pty.write(ref, ENTER);
    await poll(sliderOpen, SLIDER_MAX_MS);
    if (!sliderOpen()) {
      pty.write(ref, ESC);
      return { effort: shown(), verified: false };
    }
    // `←` на одно больше, чем уровней: упор в нижний край, с какого бы уровня бегунок ни начал.
    await press(LEFT, levels.length + 1);
    await press(RIGHT, levels.indexOf(target));
    pty.write(ref, SESSION_ONLY);
    // Подвал мог ещё показывать прежний уровень этой сессии: ждём цель, а не первое увиденное.
    await poll(() => shown() === target, FOOTER_MAX_MS);
    const seen = shown();
    if (seen === target) return { effort: seen, verified: true };
    if (sliderOpen()) pty.write(ref, ESC);
    return { effort: seen, verified: false };
  }
  ```

- [ ] **Step 5: Прогон модуля — зелёный**

  Run: `pnpm --filter @parley/host exec vitest run src/pty/effort-switch.test.ts src/pty/mode-switch.test.ts`
  Expected: PASS — в `effort-switch.test.ts` 10 тестов, в `mode-switch.test.ts` 13.

- [ ] **Step 6: Тесты сервиса и обработчика (падают)**

  `packages/host/src/sessions/sessions-service.test.ts`. Было (строка 27):
  ```ts
  import type { ActivityService } from '../activity/activity-service.js';
  ```
  Стало:
  ```ts
  import type { ActivityService, SessionLive } from '../activity/activity-service.js';
  ```
  Было (строки 34-35):
  ```ts
  import { createSessionsService } from './sessions-service.js';
  import type { SessionsFeedOptions } from './sessions-service.js';
  ```
  Стало:
  ```ts
  import { atPrompt, busyError, createSessionsService, createSwitchLock } from './sessions-service.js';
  import type { SessionsFeedOptions } from './sessions-service.js';
  ```
  В конец файла (после строки 1383):
  ```ts
  describe('setChoice(): выбор модели и effort в записи сессии (спека нормалайзера, 5.5)', () => {
    it('значение пишет поле, null убирает его, undefined оставляет как было', async () => {
      const work = await createWork(project, { title: 'Работа', goal: '' });
      const sessionId = await createPendingSession(project, work.work.id, {
        provider: 'claude',
        label: 'бэкенд',
        task: 'т',
        model: 'opus',
        effort: 'high',
      });
      const ref: SessionRef = { projectPath: project, workId: work.work.id, sessionId };
      const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
      const session = async () =>
        (await readMap(project, work.work.id)).sessions.find((candidate) => candidate.id === sessionId);

      await service.setChoice(ref, { effort: 'xhigh' });
      expect(await session()).toMatchObject({ model: 'opus', effort: 'xhigh' });

      await service.setChoice(ref, { model: 'haiku', effort: null });
      const cleared = await session();
      expect(cleared?.model).toBe('haiku');
      expect(Object.keys(cleared ?? {})).not.toContain('effort');

      await service.setChoice(ref, { model: null });
      expect(Object.keys((await session()) ?? {})).not.toContain('model');
    });

    it('сессии нет в карте — not_found', async () => {
      const work = await createWork(project, { title: 'Работа', goal: '' });
      const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());

      await expect(
        service.setChoice({ projectPath: project, workId: work.work.id, sessionId: 's-99' }, { effort: 'low' }),
      ).rejects.toMatchObject({ name: 'HostError', code: 'not_found' });
    });
  });

  describe('atPrompt и busyError: агент у приглашения (спека нормалайзера, 5.7–5.8)', () => {
    const live = (activity: string): SessionLive =>
      ({ activity: { activity, tasks: [] }, metrics: null }) as unknown as SessionLive;

    it('idle и unseen — у приглашения; working, blocked и нет сведений — занят', () => {
      expect(atPrompt(live('idle'))).toBe(true);
      expect(atPrompt(live('unseen'))).toBe(true);
      expect(atPrompt(live('working'))).toBe(false);
      expect(atPrompt(live('blocked'))).toBe(false);
      expect(atPrompt(undefined)).toBe(false);
    });

    it('отказ «занят» — conflict с причиной busy и текстом для окна', () => {
      expect(busyError('Wait until the agent is idle')).toMatchObject({
        name: 'HostError',
        code: 'conflict',
        message: 'Wait until the agent is idle',
        data: { reason: 'busy' },
      });
    });

    it('createSwitchLock: вторая смена той же сессии, пока идёт первая, — busy; соседняя не ждёт; сбой замок снимает', async () => {
      const lock = createSwitchLock();
      const ref: SessionRef = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };
      let release: () => void = () => {};
      const first = lock(ref, () => new Promise<string>((resolve) => {
        release = () => resolve('первая');
      }));

      await expect(lock(ref, async () => 'вторая')).rejects.toMatchObject({
        name: 'HostError',
        code: 'conflict',
        data: { reason: 'busy' },
      });
      await expect(lock({ ...ref, sessionId: 's-02' }, async () => 'соседняя')).resolves.toBe('соседняя');
      release();
      await expect(first).resolves.toBe('первая');
      await expect(lock(ref, async () => {
        throw new Error('сбой');
      })).rejects.toThrow('сбой');
      await expect(lock(ref, async () => 'после сбоя')).resolves.toBe('после сбоя');
    });
  });
  ```

  `packages/host/src/methods/sessions.test.ts`. Было (строки 1-5):
  ```ts
  import { describe, expect, it, vi } from 'vitest';
  import type { RequestInfo } from '../context.js';
  import type { SessionsService } from '../sessions/sessions-service.js';
  import { createSessionHandlers } from './sessions.js';
  import type { SessionMethodDeps } from './sessions.js';
  ```
  Стало:
  ```ts
  import { mkdtemp, rm } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import path from 'node:path';
  import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
  import { createPendingSession, createWork } from '@parley/core';
  import type { SessionRef } from '@parley/protocol';
  import { fakeEffortScreen } from '../../test/fake-effort-screen.js';
  import type { FakeEffortScreen } from '../../test/fake-effort-screen.js';
  import type { RequestInfo } from '../context.js';
  import { createSwitchLock } from '../sessions/sessions-service.js';
  import type { SessionsService, SwitchLock } from '../sessions/sessions-service.js';
  import { createSessionHandlers } from './sessions.js';
  import type { SessionMethodDeps } from './sessions.js';
  ```
  В конец файла (после строки 114):
  ```ts
  describe('sessions.setEffort (спека нормалайзера, 5.7)', () => {
    let project = '';

    beforeEach(async () => {
      project = await mkdtemp(path.join(tmpdir(), 'parley-set-effort-'));
    });

    afterEach(async () => {
      vi.useRealTimers();
      await rm(project, { recursive: true, force: true });
    });

    /** Сессия в карте временного проекта: провайдер и сохранённая модель — то, по чему хост берёт уровни. */
    async function sessionOf(provider: string, model?: string): Promise<SessionRef> {
      const work = await createWork(project, { title: 'Работа', goal: '' });
      const sessionId = await createPendingSession(project, work.work.id, {
        provider,
        label: 'бэкенд',
        task: 'сделай штуку',
        ...(model === undefined ? {} : { model }),
      });
      return { projectPath: project, workId: work.work.id, sessionId };
    }

    /**
     * Обработчик поверх экрана-подмены; `activity` — состояние агента, которое видит хост. По умолчанию после старта
     * процесса (у экрана `startedAt: 0`) уже был хук, будильник молчит, замок свой.
     */
    function setup(
      screen: FakeEffortScreen,
      activity = 'idle',
      options: { lastEventAt?: string | null; wakeInFlight?: boolean; lock?: SwitchLock } = {},
    ) {
      const setChoice = vi.fn(async () => {});
      const lastEventAt = options.lastEventAt === undefined ? '2026-10-06T10:00:00.000Z' : options.lastEventAt;
      const { sessionsSetEffort } = createSessionHandlers({
        sessions: { setChoice, exclusive: options.lock ?? createSwitchLock() } as unknown as SessionsService,
        pty: screen.pty,
        activity: {
          get: () => ({ activity: { activity, tasks: [], lastEventAt }, metrics: null }),
        } as unknown as SessionMethodDeps['activity'],
        wake: { inFlight: () => options.wakeInFlight === true },
      });
      return { sessionsSetEffort, setChoice };
    }

    /** Фальшивые часы только для таймеров: `setImmediate` остаётся настоящим (им `settle` отдаёт ввод-вывод). */
    const fakeClock = (): void => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    };

    /**
     * Ответ обработчика под фальшивыми часами: карта и реестр читаются с настоящего диска, поэтому часы крутятся
     * шагами, а между шагами настоящий цикл событий успевает отдать ввод-вывод.
     */
    async function settle<T>(promise: Promise<T>): Promise<T> {
      let done = false;
      void promise.then(
        () => {
          done = true;
        },
        () => {
          done = true;
        },
      );
      for (let step = 0; step < 2_000 && !done; step += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(50);
      }
      return promise;
    }

    it('Claude, GLM и модель «по умолчанию»: подвал подтвердил уровень — карта обновлена, ответ verified true', async () => {
      const cases = [
        ['claude', 'opus'],
        ['glm', 'glm-5.3[1m]'],
        ['claude', undefined],
      ] as const;
      for (const [provider, model] of cases) {
        const ref = await sessionOf(provider, model);
        const screen = fakeEffortScreen('medium');
        const { sessionsSetEffort, setChoice } = setup(screen);
        fakeClock();
        await expect(settle(sessionsSetEffort({ ref, effort: 'xhigh' }, request))).resolves.toEqual({
          effort: 'xhigh',
          verified: true,
        });
        vi.useRealTimers();
        expect(setChoice).toHaveBeenCalledWith(ref, { effort: 'xhigh' });
        expect(screen.writes.slice(0, 2)).toEqual(['/effort', '\r']);
        // Пока ползунок открыт, будильник не печатает: черновик хоста поставлен на время смены и снят.
        expect(screen.hostDrafts).toEqual([true, false]);
      }
    });

    it('ползунок не открылся — Esc, verified false, карта не тронута', async () => {
      const ref = await sessionOf('claude', 'opus');
      const screen = fakeEffortScreen(null);
      screen.opens = false;
      const { sessionsSetEffort, setChoice } = setup(screen);
      fakeClock();

      await expect(settle(sessionsSetEffort({ ref, effort: 'high' }, request))).resolves.toEqual({
        effort: null,
        verified: false,
      });
      expect(screen.writes.at(-1)).toBe('\x1b');
      expect(setChoice).not.toHaveBeenCalled();
    });

    it('подвал показал другой уровень (предел CLI) — verified false с увиденным, карта не тронута', async () => {
      const ref = await sessionOf('claude', 'opus');
      const screen = fakeEffortScreen('medium');
      screen.cap = 'high';
      const { sessionsSetEffort, setChoice } = setup(screen);
      fakeClock();

      await expect(settle(sessionsSetEffort({ ref, effort: 'max' }, request))).resolves.toEqual({
        effort: 'high',
        verified: false,
      });
      expect(setChoice).not.toHaveBeenCalled();
    });

    it('агент работает или ждёт ответа — conflict с причиной busy, в PTY ничего не напечатано', async () => {
      const ref = await sessionOf('claude', 'opus');
      for (const activity of ['working', 'blocked']) {
        const screen = fakeEffortScreen('medium');
        const { sessionsSetEffort, setChoice } = setup(screen, activity);
        await expect(sessionsSetEffort({ ref, effort: 'high' }, request)).rejects.toMatchObject({
          name: 'HostError',
          code: 'conflict',
          data: { reason: 'busy' },
        });
        expect(screen.writes).toEqual([]);
        expect(setChoice).not.toHaveBeenCalled();
      }
    });

    it('в поле ввода неотправленный текст — conflict busy: `/effort` и Enter ушли бы агенту вместе с ним', async () => {
      const ref = await sessionOf('claude', 'opus');
      const screen = fakeEffortScreen('medium');
      screen.draft = true;
      const { sessionsSetEffort } = setup(screen);

      await expect(sessionsSetEffort({ ref, effort: 'high' }, request)).rejects.toMatchObject({
        code: 'conflict',
        data: { reason: 'busy' },
      });
      expect(screen.writes).toEqual([]);
    });

    it('уровня нет у модели или сессия не Claude Code — bad_request, ничего не напечатано', async () => {
      const screen = fakeEffortScreen('medium');
      const { sessionsSetEffort } = setup(screen);

      await expect(
        sessionsSetEffort({ ref: await sessionOf('claude', 'haiku'), effort: 'high' }, request),
      ).rejects.toThrow(/haiku has no effort levels/);
      await expect(
        sessionsSetEffort({ ref: await sessionOf('claude', 'opus'), effort: 'ultra' }, request),
      ).rejects.toThrow(/ultra is not a level of opus/);
      await expect(
        sessionsSetEffort({ ref: await sessionOf('codex', 'gpt-6-sol'), effort: 'high' }, request),
      ).rejects.toMatchObject({ name: 'HostError', code: 'bad_request' });
      expect(screen.writes).toEqual([]);
    });

    it('нет живого PTY — not_found', async () => {
      const ref = await sessionOf('claude', 'opus');
      const screen = fakeEffortScreen('medium');
      screen.live = false;
      const { sessionsSetEffort } = setup(screen);

      await expect(sessionsSetEffort({ ref, effort: 'high' }, request)).rejects.toMatchObject({
        name: 'HostError',
        code: 'not_found',
      });
    });

    it('с запуска процесса не было ни одного хука — conflict busy, ничего не напечатано: Enter мог бы ответить на вопрос доверия к папке', async () => {
      const ref = await sessionOf('claude', 'opus');
      const screen = fakeEffortScreen('medium');
      const { sessionsSetEffort } = setup(screen, 'idle', { lastEventAt: null });

      await expect(sessionsSetEffort({ ref, effort: 'high' }, request)).rejects.toMatchObject({
        code: 'conflict',
        data: { reason: 'busy' },
      });
      expect(screen.writes).toEqual([]);
    });

    it('будильник печатает указатель на письма — conflict busy: клавиши указателя и ползунка не смешаются', async () => {
      const ref = await sessionOf('claude', 'opus');
      const screen = fakeEffortScreen('medium');
      const { sessionsSetEffort } = setup(screen, 'idle', { wakeInFlight: true });

      await expect(sessionsSetEffort({ ref, effort: 'high' }, request)).rejects.toMatchObject({
        code: 'conflict',
        data: { reason: 'busy' },
      });
      expect(screen.writes).toEqual([]);
      expect(screen.hostDrafts).toEqual([]);
    });

    it('два выбора подряд по одной сессии (двойной клик) — второй conflict busy, клавиши первого не перемешаны', async () => {
      const ref = await sessionOf('claude', 'opus');
      const screen = fakeEffortScreen('medium');
      const { sessionsSetEffort, setChoice } = setup(screen);
      fakeClock();

      const first = sessionsSetEffort({ ref, effort: 'high' }, request);
      await expect(sessionsSetEffort({ ref, effort: 'max' }, request)).rejects.toMatchObject({
        code: 'conflict',
        data: { reason: 'busy' },
      });
      await expect(settle(first)).resolves.toEqual({ effort: 'high', verified: true });
      vi.useRealTimers();

      // Одна последовательность клавиш: `/effort`, Enter, 6 × ←, 2 × →, `s`.
      expect(screen.writes).toEqual([
        '/effort',
        '\r',
        ...Array.from({ length: 6 }, () => '\x1b[D'),
        '\x1b[C',
        '\x1b[C',
        's',
      ]);
      expect(setChoice).toHaveBeenCalledTimes(1);
    });

    it('идёт смена модели той же сессии (общий замок с sessions.setModel) — conflict busy, ничего не напечатано', async () => {
      const ref = await sessionOf('claude', 'opus');
      const screen = fakeEffortScreen('medium');
      const lock = createSwitchLock();
      const { sessionsSetEffort } = setup(screen, 'idle', { lock });
      let release: () => void = () => {};
      const model = lock(ref, () => new Promise<void>((resolve) => {
        release = resolve;
      }));

      await expect(sessionsSetEffort({ ref, effort: 'high' }, request)).rejects.toMatchObject({
        code: 'conflict',
        data: { reason: 'busy' },
      });
      expect(screen.writes).toEqual([]);
      release();
      await model;
    });
  });
  ```

  `packages/host/src/server.test.ts`, строки 168-171. Было:
  ```ts
      for (const name of ['feed.snapshot', 'feed.subscribe', 'feed.unsubscribe', 'feed.decide', 'feed.interrupt']) {
        expect(methods).toContain(name);
      }
      client.close();
  ```
  Стало:
  ```ts
      for (const name of ['feed.snapshot', 'feed.subscribe', 'feed.unsubscribe', 'feed.decide', 'feed.interrupt']) {
        expect(methods).toContain(name);
      }
      // Меню «модель · effort» в чате (спека нормалайзера, 5.9): без обоих методов смены окно меню не показывает.
      expect(methods).toContain('sessions.setEffort');
      client.close();
  ```

  `packages/host/src/methods/index.test.ts`, строка 51. Было:
  ```ts
          'sessions.setMode',
  ```
  Стало:
  ```ts
          'sessions.setMode',
          'sessions.setEffort',
  ```

- [ ] **Step 7: Прогон — падает**

  Run: `pnpm --filter @parley/host exec vitest run src/sessions/sessions-service.test.ts src/methods/sessions.test.ts src/methods/index.test.ts src/server.test.ts`
  Expected: FAIL. `sessions-service.test.ts`: `TypeError: service.setChoice is not a function`,
  `TypeError: atPrompt is not a function`, `TypeError: busyError is not a function`,
  `TypeError: createSwitchLock is not a function`. `sessions.test.ts`: `TypeError: createSwitchLock is not a function` во всех
  новых тестах. `index.test.ts`:
  в перечне нет `'sessions.setEffort'`. `server.test.ts`: в `hello.methods` нет `sessions.setEffort`, а в `METHODS`
  протокола он уже есть.

- [ ] **Step 8: `setChoice`, `atPrompt`, `busyError`, замок смены, обработчик и регистрация**

  `packages/host/src/sessions/sessions-service.ts`. Было (строка 55):
  ```ts
  import { refKey } from '@parley/protocol';
  ```
  Стало:
  ```ts
  import { HOST_ERROR_REASONS, refKey } from '@parley/protocol';
  ```
  Было (строка 57):
  ```ts
  import type { ActivityService } from '../activity/activity-service.js';
  ```
  Стало:
  ```ts
  import type { ActivityService, SessionLive } from '../activity/activity-service.js';
  ```
  Было (строки 115-117):
  ```ts
    /** Поднимает прерванных без промпта — только с согласия человека (спека 10). */
    resumeInterrupted(refs: readonly SessionRef[]): Promise<void>;
  }
  ```
  Стало:
  ```ts
    /** Поднимает прерванных без промпта — только с согласия человека (спека 10). */
    resumeInterrupted(refs: readonly SessionRef[]): Promise<void>;
    /**
     * Выбор модели и effort в записи сессии (спека нормалайзера, 5.5): `null` убирает поле («по умолчанию»),
     * `undefined` оставляет как было. Процесс не трогает.
     */
    setChoice(ref: SessionRef, choice: { model?: string | null; effort?: string | null }): Promise<void>;
    /** Замок смены модели и effort этой сессии: через него идут `sessions.setEffort` и `sessions.setModel`. */
    exclusive: SwitchLock;
  }
  ```
  Было (строки 128-129):
  ```ts
  /** Ключ работы для склейки снимков «до» и «после» в autoLaunch. */
  const workKey = (projectPath: string, workId: string): string => `${projectPath}\u0000${workId}`;
  ```
  Стало:
  ```ts
  /** Ключ работы для склейки снимков «до» и «после» в autoLaunch. */
  const workKey = (projectPath: string, workId: string): string => `${projectPath}\u0000${workId}`;

  /**
   * Агент у своего приглашения (спека нормалайзера, 5.7–5.8): ход окончен — `idle` или ещё не просмотренный
   * `unseen`, как у доставки писем (`delivery.ts` в core). `working` и `blocked` — занят; сведений нет — тоже занят:
   * печатать и перезапускать вслепую хост не станет.
   */
  export function atPrompt(live: SessionLive | undefined): boolean {
    const state = live?.activity.activity;
    return state === 'idle' || state === 'unseen';
  }

  /** Отказ «агент занят»: `conflict` с причиной `busy` — окно по ней выбирает свой текст. */
  export function busyError(message: string): HostError {
    return new HostError('conflict', message, { reason: HOST_ERROR_REASONS.busy });
  }

  /** Замок смены модели и effort: вторая смена той же сессии, пока идёт первая, — `busy`. */
  export type SwitchLock = <T>(ref: SessionRef, run: () => Promise<T>) => Promise<T>;

  /**
   * Одна смена модели или effort на сессию за раз (спека нормалайзера, 5.7–5.8): двойной клик или `setEffort` во время
   * `setModel` получают `busy` до первой клавиши — клавиши двух смен не смешиваются, перезапуск один. Ключ ставится
   * синхронно, до первого `await`, и снимается и после сбоя.
   */
  export function createSwitchLock(): SwitchLock {
    const running = new Set<string>();
    return async <T>(ref: SessionRef, run: () => Promise<T>): Promise<T> => {
      const key = refKey(ref);
      if (running.has(key)) throw busyError('Another model or effort change of this session is in progress');
      running.add(key);
      try {
        return await run();
      } finally {
        running.delete(key);
      }
    };
  }
  ```
  Было (строка 138):
  ```ts
    const { hooks, providerVersions } = feed;
  ```
  Стало:
  ```ts
    const { hooks, providerVersions } = feed;
    // Одна смена модели или effort на сессию за раз — общий замок `sessions.setEffort` и `sessions.setModel`.
    const exclusive = createSwitchLock();
  ```
  Было (строки 491-497):
  ```ts
    async function stop(ref: SessionRef): Promise<void> {
      if (pty.get(ref) === undefined) return;
      await pty.stop(ref);
      // Само событие `exit` уже прошло (см. выше) — если запись карты ещё
      // пишется, дожидаемся её, чтобы вызывающая сторона не читала гонку.
      await finalizing.get(refKey(ref));
    }
  ```
  Стало:
  ```ts
    async function stop(ref: SessionRef): Promise<void> {
      if (pty.get(ref) === undefined) return;
      await pty.stop(ref);
      // Само событие `exit` уже прошло (см. выше) — если запись карты ещё
      // пишется, дожидаемся её, чтобы вызывающая сторона не читала гонку.
      await finalizing.get(refKey(ref));
    }

    async function setChoice(
      ref: SessionRef,
      choice: { model?: string | null; effort?: string | null },
    ): Promise<void> {
      await updateMap(ref.projectPath, ref.workId, (map) => {
        const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
        if (session === undefined) {
          throw new HostError('not_found', `session ${ref.sessionId} is not in the map of workspace ${ref.workId}`);
        }
        if (choice.model === null) delete session.model;
        else if (choice.model !== undefined) session.model = choice.model;
        if (choice.effort === null) delete session.effort;
        else if (choice.effort !== undefined) session.effort = choice.effort;
      });
    }
  ```
  Было (строки 610-615):
  ```ts
    return {
      create,
      launch,
      stop,
      close,
      delete: del,
  ```
  Стало:
  ```ts
    return {
      create,
      launch,
      stop,
      close,
      delete: del,
      setChoice,
      exclusive,
  ```

  `packages/host/src/methods/sessions.ts` — новое содержимое целиком:

  ```ts
  /**
   * Методы `sessions.*`: создание, возобновление, остановка, закрытие и удаление
   * сессий, прерванные падением хоста (план, куски 1.7 и 3.4). Сам запуск и правила создания живут в `SessionsService` —
   * здесь только разбор параметров протокола и форма ответа.
   */

  import { effortsFor, hookedSince, isClaudeCode, loadProviders, readMap, resolveModelEffort } from '@parley/core';
  import type { ActivityService } from '../activity/activity-service.js';
  import type { Handler } from '../context.js';
  import { HostError } from '../errors.js';
  import type { FeedService } from '../feed/feed-service.js';
  import { switchEffort } from '../pty/effort-switch.js';
  import { switchMode } from '../pty/mode-switch.js';
  import type { PtyManager } from '../pty/pty-manager.js';
  import { atPrompt, busyError } from '../sessions/sessions-service.js';
  import type { SessionsService } from '../sessions/sessions-service.js';
  import type { WakeService } from '../wake/wake-service.js';

  export interface SessionMethodDeps {
    sessions: SessionsService;
    /**
     * Печать хоста и чтение экрана для `sessions.setMode` и `sessions.setEffort`; черновик хоста `sessions.setEffort`
     * держит, пока ползунок открыт.
     */
    pty: Pick<PtyManager, 'write' | 'on' | 'get' | 'screenText' | 'setHostDraft'>;
    /** Активность сессии: `sessions.setEffort` печатает только агенту у приглашения и после первого хука процесса. */
    activity: Pick<ActivityService, 'get'>;
    /** Будильник: пока он печатает указатель на письма, `sessions.setEffort` не начинает. */
    wake: Pick<WakeService, 'inFlight'>;
    /** Лента узнаёт сверенный режим; без неё метод только отвечает. */
    feed?: Pick<FeedService, 'noteMode'>;
  }

  export interface SessionHandlers {
    sessionsCreate: Handler<'sessions.create'>;
    sessionsResume: Handler<'sessions.resume'>;
    sessionsStop: Handler<'sessions.stop'>;
    sessionsDelete: Handler<'sessions.delete'>;
    sessionsClose: Handler<'sessions.close'>;
    sessionsInterrupted: Handler<'sessions.interrupted'>;
    sessionsSetMode: Handler<'sessions.setMode'>;
    sessionsSetEffort: Handler<'sessions.setEffort'>;
    sessionsResumeInterrupted: Handler<'sessions.resumeInterrupted'>;
  }

  export function createSessionHandlers(deps: SessionMethodDeps): SessionHandlers {
    return {
      sessionsCreate: async (params) => {
        // `exactOptionalPropertyTypes`: zod даёт `worktree?: boolean | undefined`,
        // а `CreateSessionInput.worktree?: boolean` явного `undefined` ключом не
        // принимает — той же дорогой, что `LaunchOptions.prompt` в `launch.ts`.
        const { worktree, model, effort, ...rest } = params;
        const ref = await deps.sessions.create({
          ...rest,
          ...(worktree === undefined ? {} : { worktree }),
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
        });
        return { ref };
      },

      sessionsResume: async (params) => {
        await deps.sessions.launch(params.ref, 'resume');
        return { ok: true };
      },

      sessionsStop: async (params) => {
        await deps.sessions.stop(params.ref);
        return { ok: true };
      },

      sessionsDelete: async (params) => {
        await deps.sessions.delete(params.ref, params.force);
        return { ok: true };
      },

      sessionsClose: async (params) => {
        await deps.sessions.close(params.ref);
        return { ok: true };
      },

      sessionsInterrupted: async () => ({ refs: deps.sessions.interrupted() }),

      // Нажатия Shift+Tab — печать хоста по явному действию человека; ответов хукам тут нет.
      sessionsSetMode: async (params) => {
        const result = await switchMode({ pty: deps.pty }, params.ref, params.mode);
        if (result.mode !== null) deps.feed?.noteMode(params.ref, result.mode);
        return result;
      },

      // Ползунок `/effort` и `s` — печать хоста по явному выбору человека в меню чата (спека нормалайзера, 5.7).
      // Уровни — у модели из карты (или «по умолчанию»), их же предлагает меню; карта меняется, только когда
      // подвал подтвердил уровень. «По умолчанию» в идущей сессии не ставится: `/effort auto` стёр бы уровень,
      // сохранённый человеком. Одна смена на сессию за раз — общий замок с `sessions.setModel`.
      sessionsSetEffort: async ({ ref, effort }) =>
        deps.sessions.exclusive(ref, async () => {
          const handle = deps.pty.get(ref);
          if (handle === undefined) throw new HostError('not_found', `no live PTY for session ${ref.sessionId}`);
          const session = (await readMap(ref.projectPath, ref.workId)).sessions.find(
            (candidate) => candidate.id === ref.sessionId,
          );
          if (session === undefined) {
            throw new HostError('not_found', `session ${ref.sessionId} is not in the map of workspace ${ref.workId}`);
          }
          const entry = (await loadProviders())[session.provider];
          if (entry === undefined || !isClaudeCode(entry)) {
            throw new HostError('bad_request', 'effort of a running session can be changed only for Claude Code sessions');
          }
          const model = session.model;
          const resolved = resolveModelEffort(entry, { ...(model === undefined ? {} : { model }), effort });
          if ('error' in resolved) throw new HostError('bad_request', resolved.error);
          const levels = effortsFor(entry, model);
          if (levels === null) throw new HostError('bad_request', `provider ${entry.id} does not accept effort`);

          // Дальше — только то, что видно на экране и в журнале; при любом отказе в PTY не уходит ни одной клавиши.
          const live = deps.activity.get(ref);
          if (!atPrompt(live)) throw busyError('Wait until the agent is idle');
          // Ни одного хука с запуска процесса — хост не знает, что на экране: на вопросе доверия к папке Enter выбрал
          // бы ответ за человека (так же страхуется `pty.send`).
          if (!hookedSince(live?.activity, handle.startedAt)) {
            throw busyError('The agent has not reported ready since it started; check the terminal');
          }
          // `/effort` и Enter дописались бы к неотправленному тексту и ушли бы агенту вместе с ним.
          if (handle.hasDraft()) throw busyError('The input field has unsent text; send or clear it first');
          if (deps.wake.inFlight(ref)) throw busyError('A message pointer is being typed; try again in a moment');
          // Черновик хоста на время смены: будильник поверх него не печатает и не вклинится в клавиши ползунка.
          deps.pty.setHostDraft(ref, true);
          try {
            const result = await switchEffort(ref, effort, levels.map((level) => level.id), { pty: deps.pty });
            if (result.verified) await deps.sessions.setChoice(ref, { effort });
            return result;
          } finally {
            deps.pty.setHostDraft(ref, false);
          }
        }),

      sessionsResumeInterrupted: async (params) => {
        await deps.sessions.resumeInterrupted(params.refs);
        return { ok: true };
      },
    };
  }
  ```

  `packages/host/src/methods/index.ts`. Было (строка 68):
  ```ts
    'sessions.setMode',
  ```
  Стало:
  ```ts
    'sessions.setMode',
    'sessions.setEffort',
  ```
  Было (строка 131):
  ```ts
      'sessions.setMode': sessions.sessionsSetMode as AnyHandler,
  ```
  Стало:
  ```ts
      'sessions.setMode': sessions.sessionsSetMode as AnyHandler,
      'sessions.setEffort': sessions.sessionsSetEffort as AnyHandler,
  ```

- [ ] **Step 9: Прогон — зелёный; сборка, стражи, lint**

  Run: `pnpm --filter @parley/host exec vitest run src/pty/effort-switch.test.ts src/pty/mode-switch.test.ts src/sessions/sessions-service.test.ts src/methods/sessions.test.ts src/methods/index.test.ts src/server.test.ts src/english-text.test.ts`
  Expected: PASS, все файлы (`sessions.test.ts` — 5 прежних + 11 новых). `server.test.ts` зелёный: протокол и хост
  оба знают `sessions.setEffort`.

  Run: `pnpm --filter @parley/host test`
  Expected: PASS, весь пакет. Красный тест, которого эта задача не трогала, сверить с прогоном на коммите до неё
  (известные флейки под нагрузкой — `activity-terminal`, `works-service`).

  Run: `pnpm --filter @parley/host build`
  Expected: exit 0.

  Run: `pnpm --filter @parley/core exec vitest run test/frame-check.test.ts`
  Expected: PASS.

  Run: `pnpm exec eslint packages/host/src/pty packages/host/src/sessions packages/host/src/methods packages/host/test/fake-effort-screen.ts`
  Expected: без ошибок.

- [ ] **Step 10: Коммит**

  ```bash
  git add packages/protocol/src/methods.ts packages/protocol/src/methods.test.ts \
    packages/host/src/pty/effort-switch.ts packages/host/src/pty/effort-switch.test.ts packages/host/test/fake-effort-screen.ts \
    packages/host/src/sessions/sessions-service.ts packages/host/src/sessions/sessions-service.test.ts \
    packages/host/src/methods/sessions.ts packages/host/src/methods/sessions.test.ts \
    packages/host/src/methods/index.ts packages/host/src/methods/index.test.ts packages/host/src/server.test.ts
  git commit -m "feat(host): sessions.setEffort — ползунок /effort и s со сверкой по подвалу, один замок смены на сессию" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 11: `sessions.setModel` — смена модели перезапуском через resume

**Files:**
- Modify: `packages/protocol/src/methods.ts` (схема и результат `sessions.setModel` рядом с `sessions.setEffort`)
- Modify: `packages/protocol/src/methods.test.ts` (новый `describe` в конце файла)
- Modify: `packages/host/src/sessions/sessions-service.ts` (импорт `effortsFor`, интерфейс, `setModel` после `setChoice`, объект сервиса)
- Modify: `packages/host/src/sessions/sessions-service.test.ts` (импорты типов `SessionsService` и `PtyManager`, новый `describe` в конце)
- Modify: `packages/host/src/methods/sessions.ts` (интерфейс и обработчик)
- Modify: `packages/host/src/methods/sessions.test.ts` (новый `describe` в конце)
- Modify: `packages/host/src/methods/index.ts` (перечень и регистрация)
- Modify: `packages/host/src/methods/index.test.ts`
- Modify: `packages/host/src/server.test.ts:168-171`

**Interfaces:**
- Consumes: `setChoice`, `atPrompt`, `busyError`, `exclusive` (Task 10); `resolveModelChoice(provider, model?, effort?)`
  (Task 9); core `effortsFor` (Task 2), `isClaudeCode`, `readMap`, `loadProviders`; core `plan()` resume с
  `session.model`/`session.effort` и `claude.resumeArgs` с `--model {model} --effort {effort}`, `glm.resumeArgs` с
  `--effort {effort}` (Task 4).
- Produces:
  ```ts
  SessionsService.setModel(ref: SessionRef, model: string): Promise<{ model: string; effort: string | null; restarted: boolean }>;
  SessionHandlers.sessionsSetModel: Handler<'sessions.setModel'>;
  // protocol (methods.ts)
  METHODS['sessions.setModel'] = z.object({ ref: sessionRef, model: z.string().max(200).regex(/^[^\s-]\S*$/) });
  Result<'sessions.setModel'> = { model: string; effort: string | null; restarted: boolean };
  ```
- Правила `setModel`: только семейство `claude` (Claude, GLM), иначе `bad_request`; модель — через resolver
  (`bad_request` со списком допустимого), а если resolver её отбросил (в шаблоне нет `{model}`) — тоже `bad_request`;
  та же модель, что в карте, — ничего не пишется и не перезапускается (`restarted: false`); сохранённый effort остаётся,
  если он есть у новой модели, иначе сбрасывается (`effort: null`). Живая сессия — только у приглашения (`idle`/`unseen`)
  и без фоновых задач, иначе `conflict` с `reason: 'busy'`; смена идёт под замком `exclusive` (Task 10).

- [ ] **Step 1: Протокол — схема и результат `sessions.setModel`**

  Протокол и регистрация обработчика (шаг 4) — в одном коммите, как в Task 10.

  `packages/protocol/src/methods.ts` — найти (после Task 10):
  ```ts
    'sessions.setEffort': z.object({ ref: sessionRef, effort: z.string().regex(EFFORT_TOKEN_RE) }),
  ```
  заменить на:
  ```ts
    'sessions.setEffort': z.object({ ref: sessionRef, effort: z.string().regex(EFFORT_TOKEN_RE) }),
    // Смена модели идущей сессии из меню чата (нормалайзер модели и effort, 5.8): то же одно слово, что у
    // `sessions.create`, но непустое. Список моделей сверяет хост (`bad_request`).
    'sessions.setModel': z.object({ ref: sessionRef, model: z.string().max(200).regex(/^[^\s-]\S*$/) }),
  ```
  Тот же файл, `Results` — найти:
  ```ts
    'sessions.setEffort': { effort: string | null; verified: boolean };
  ```
  заменить на:
  ```ts
    'sessions.setEffort': { effort: string | null; verified: boolean };
    /**
     * Смена модели (нормалайзер модели и effort, 5.8). `model` — модель, записанная в карту; `effort` —
     * уровень после смены (`null` — «по умолчанию»: прежнего уровня у новой модели нет или он не был
     * выбран); `restarted` — живую сессию хост перезапустил через resume, спящую или ждущую запуска только
     * переписал в карте.
     */
    'sessions.setModel': { model: string; effort: string | null; restarted: boolean };
  ```

  `packages/protocol/src/methods.test.ts` — дописать в конец файла:
  ```ts

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
  ```

  Run (из корня), до правки `methods.ts`: `pnpm --filter @parley/protocol exec vitest run src/methods.test.ts`
  Expected: `Tests  1 failed | 52 passed (53)` — «setModel: …» падает с `TypeError: Cannot read properties of undefined (reading 'safeParse')`.

  Run (после правки):
  ```bash
  pnpm --filter @parley/protocol test
  pnpm --filter @parley/protocol exec tsc --noEmit --skipLibCheck --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --module NodeNext --moduleResolution NodeNext --target ES2022 --verbatimModuleSyntax src/methods.test.ts
  pnpm --filter @parley/protocol build
  ```
  Expected: `Tests  96 passed (96)`; tsc и сборка — exit 0. До шага 4 тест хоста `server.test.ts` красный: обработчика
  `sessions.setModel` ещё нет.

- [ ] **Step 2: Тесты хоста (падают)**

  `packages/host/src/sessions/sessions-service.test.ts`. Было (после Task 10):
  ```ts
  import { createPtyManager } from '../pty/pty-manager.js';
  ```
  Стало:
  ```ts
  import { createPtyManager } from '../pty/pty-manager.js';
  import type { PtyManager } from '../pty/pty-manager.js';
  ```
  Было (после Task 10):
  ```ts
  import { atPrompt, busyError, createSessionsService, createSwitchLock } from './sessions-service.js';
  import type { SessionsFeedOptions } from './sessions-service.js';
  ```
  Стало:
  ```ts
  import { atPrompt, busyError, createSessionsService, createSwitchLock } from './sessions-service.js';
  import type { SessionsFeedOptions, SessionsService } from './sessions-service.js';
  ```
  В конец файла:
  ```ts
  describe('setModel(): смена модели (спека нормалайзера, 5.8)', () => {
    let claudeRoot = '';

    beforeEach(async () => {
      claudeRoot = await mkdtemp(path.join(tmpdir(), 'parley-sessions-claude-'));
      // План resume ищет транскрипт Claude Code во временном корне, а не в ~/.claude.
      setEnv('PARLEY_CLAUDE_PROJECTS_DIR', claudeRoot);
    });

    afterEach(async () => {
      await rm(claudeRoot, { recursive: true, force: true });
    });

    /** Активность-подмена: сессия в заданном состоянии и с заданными субагентами. */
    function activityAt(state: string, tasks: Array<{ background: boolean }> = []): ActivityService {
      return {
        ...fakeActivity(),
        get: () => ({ activity: { activity: state, tasks }, metrics: null }),
      } as unknown as ActivityService;
    }

    /** Живая сессия claude на opus · xhigh; транскрипт разговора есть — resume пойдёт через `--resume`. */
    async function liveSession(
      activity: ActivityService,
    ): Promise<{ service: SessionsService; pty: PtyManager; ref: SessionRef; argsFile: string; uuid: string }> {
      const work = await createWork(project, { title: 'Работа', goal: '' });
      const argsFile = await tempArgsFile();
      setEnv('STUB_ARGS_FILE', argsFile);
      const pty = createPtyManager(fakeHost());
      const service = createSessionsService(fakeHost(), fakeWorks(), pty, activity);
      const ref = await service.create({
        projectPath: project,
        workId: work.work.id,
        provider: 'claude',
        label: '',
        task: '',
        parent: null,
        model: 'opus',
        effort: 'xhigh',
      });
      const { argv } = await readArgs(argsFile);
      const uuid = argv[argv.indexOf('--session-id') + 1] as string;
      await mkdir(path.join(claudeRoot, 'project'), { recursive: true });
      await writeFile(path.join(claudeRoot, 'project', `${uuid}.jsonl`), '{"type":"user"}\n', 'utf8');
      await rm(argsFile);
      return { service, pty, ref, argsFile, uuid };
    }

    const sessionOf = async (ref: SessionRef) =>
      (await readMap(ref.projectPath, ref.workId)).sessions.find((candidate) => candidate.id === ref.sessionId);

    it('спящая сессия: только карта, процесс не поднимается; уровень, который есть у новой модели, остаётся', async () => {
      const { service, ref } = await liveSession(activityAt('idle'));
      await service.stop(ref);

      expect(await service.setModel(ref, 'sonnet')).toEqual({ model: 'sonnet', effort: 'xhigh', restarted: false });
      expect(service.live(ref)).toBe(false);
      expect(await sessionOf(ref)).toMatchObject({ model: 'sonnet', effort: 'xhigh', lifecycle: 'sleeping' });
    });

    it('сессия ещё ждёт запуска (pending) — только карта, restarted: false; у GLM своя пара моделей', async () => {
      const work = await createWork(project, { title: 'Работа', goal: '' });
      const sessionId = await createPendingSession(project, work.work.id, {
        provider: 'glm',
        label: 'бэкенд',
        task: 'сделай штуку',
      });
      const ref: SessionRef = { projectPath: project, workId: work.work.id, sessionId };
      const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());

      expect(await service.setModel(ref, 'glm-5.3-flash[1m]')).toEqual({
        model: 'glm-5.3-flash[1m]',
        effort: null,
        restarted: false,
      });
      expect(await sessionOf(ref)).toMatchObject({ model: 'glm-5.3-flash[1m]', lifecycle: 'pending' });
      expect(service.live(ref)).toBe(false);
    });

    it('живая сессия у приглашения: карта, остановка и resume с --model и --effort из карты', async () => {
      const { service, ref, argsFile, uuid } = await liveSession(activityAt('idle'));

      expect(await service.setModel(ref, 'sonnet')).toEqual({ model: 'sonnet', effort: 'xhigh', restarted: true });

      const { argv } = await readArgs(argsFile);
      expect(argv[argv.indexOf('--resume') + 1]).toBe(uuid);
      expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
      expect(argv[argv.indexOf('--effort') + 1]).toBe('xhigh');
      expect(await sessionOf(ref)).toMatchObject({ model: 'sonnet', effort: 'xhigh', lifecycle: 'active' });
      expect(service.live(ref)).toBe(true);
      await service.stop(ref);
    });

    it('у Haiku уровней нет: effort сброшен в карте, resume без --effort; unseen — тоже у приглашения', async () => {
      const { service, ref, argsFile } = await liveSession(activityAt('unseen'));

      expect(await service.setModel(ref, 'haiku')).toEqual({ model: 'haiku', effort: null, restarted: true });

      const { argv } = await readArgs(argsFile);
      expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
      expect(argv).not.toContain('--effort');
      const session = await sessionOf(ref);
      expect(session?.model).toBe('haiku');
      expect(Object.keys(session ?? {})).not.toContain('effort');
      await service.stop(ref);
    });

    it('агент работает, ждёт ответа или идут фоновые задачи — conflict busy: процесс жив, карта прежняя', async () => {
      for (const activity of [activityAt('working'), activityAt('blocked'), activityAt('idle', [{ background: true }])]) {
        const { service, ref } = await liveSession(activity);

        await expect(service.setModel(ref, 'sonnet')).rejects.toMatchObject({
          name: 'HostError',
          code: 'conflict',
          data: { reason: 'busy' },
        });
        expect(service.live(ref)).toBe(true);
        expect(await sessionOf(ref)).toMatchObject({ model: 'opus', effort: 'xhigh' });
        await service.stop(ref);
      }
    });

    it('resume не поднялся — ошибка уходит вызывающему, а в карте уже новая модель', async () => {
      const { service, ref } = await liveSession(activityAt('idle'));
      setEnv('PARLEY_CLAUDE_BIN', path.join(project, 'нет-такого-claude'));

      await expect(service.setModel(ref, 'sonnet')).rejects.toThrow();
      expect(service.live(ref)).toBe(false);
      expect(await sessionOf(ref)).toMatchObject({ model: 'sonnet', effort: 'xhigh', lifecycle: 'sleeping' });
    });

    it('сессия не Claude Code или модель не из списка — bad_request, карта не меняется', async () => {
      const work = await createWork(project, { title: 'Работа', goal: '' });
      const codex = await createPendingSession(project, work.work.id, { provider: 'codex', label: 'a', task: 't' });
      const claude = await createPendingSession(project, work.work.id, {
        provider: 'claude',
        label: 'b',
        task: 't',
        model: 'opus',
      });
      const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity());
      const refOf = (sessionId: string): SessionRef => ({ projectPath: project, workId: work.work.id, sessionId });

      await expect(service.setModel(refOf(codex), 'gpt-6-sol')).rejects.toMatchObject({
        name: 'HostError',
        code: 'bad_request',
      });
      await expect(service.setModel(refOf(claude), 'gpt-6-sol')).rejects.toMatchObject({
        name: 'HostError',
        code: 'bad_request',
      });
      expect((await sessionOf(refOf(codex)))?.model).toBeUndefined();
      expect((await sessionOf(refOf(claude)))?.model).toBe('opus');
    });

    it('та же модель, что уже стоит, — без записи и без перезапуска: restarted false, процесс тот же', async () => {
      const { service, pty, ref } = await liveSession(activityAt('idle'));
      const pid = pty.get(ref)?.pid;
      const before = await sessionOf(ref);

      expect(await service.setModel(ref, 'opus')).toEqual({ model: 'opus', effort: 'xhigh', restarted: false });
      expect(pty.get(ref)?.pid).toBe(pid);
      expect(await sessionOf(ref)).toEqual(before);
      await service.stop(ref);
    });

    it('вторая смена, пока идёт первая, — conflict busy: перезапуск один; замок общий с sessions.setEffort', async () => {
      const { service, ref, argsFile } = await liveSession(activityAt('idle'));

      const first = service.setModel(ref, 'sonnet');
      await expect(service.setModel(ref, 'haiku')).rejects.toMatchObject({
        name: 'HostError',
        code: 'conflict',
        data: { reason: 'busy' },
      });
      // Обработчик sessions.setEffort идёт через тот же `exclusive` (Task 10).
      await expect(service.exclusive(ref, async () => 'effort')).rejects.toMatchObject({
        code: 'conflict',
        data: { reason: 'busy' },
      });
      await expect(first).resolves.toEqual({ model: 'sonnet', effort: 'xhigh', restarted: true });

      const { argv } = await readArgs(argsFile);
      expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
      expect((await sessionOf(ref))?.model).toBe('sonnet');
      await expect(service.exclusive(ref, async () => 'свободно')).resolves.toBe('свободно');
      await service.stop(ref);
    });
  });
  ```

  `packages/host/src/methods/sessions.test.ts` — в конец файла:
  ```ts
  describe('sessions.setModel (спека нормалайзера, 5.8)', () => {
    it('правила и порядок — в сервисе: обработчик отдаёт ему ref и модель и возвращает ответ как есть', async () => {
      const setModel = vi.fn(async () => ({ model: 'sonnet', effort: null, restarted: true }));
      const { sessionsSetModel } = createSessionHandlers({
        sessions: { setModel } as unknown as SessionsService,
        pty: {} as unknown as SessionMethodDeps['pty'],
        activity: {} as unknown as SessionMethodDeps['activity'],
        wake: {} as unknown as SessionMethodDeps['wake'],
      });

      await expect(sessionsSetModel({ ref, model: 'sonnet' }, request)).resolves.toEqual({
        model: 'sonnet',
        effort: null,
        restarted: true,
      });
      expect(setModel).toHaveBeenCalledWith(ref, 'sonnet');
    });
  });
  ```

  `packages/host/src/methods/index.test.ts`. Было (после Task 10):
  ```ts
          'sessions.setEffort',
  ```
  Стало:
  ```ts
          'sessions.setEffort',
          'sessions.setModel',
  ```

  `packages/host/src/server.test.ts`. Было (после Task 10):
  ```ts
      expect(methods).toContain('sessions.setEffort');
      client.close();
  ```
  Стало:
  ```ts
      expect(methods).toContain('sessions.setEffort');
      expect(methods).toContain('sessions.setModel');
      client.close();
  ```

- [ ] **Step 3: Прогон — падает**

  Run: `pnpm --filter @parley/host exec vitest run src/sessions/sessions-service.test.ts src/methods/sessions.test.ts src/methods/index.test.ts src/server.test.ts`
  Expected: FAIL. `TypeError: service.setModel is not a function` (9 тестов `setModel()`),
  `TypeError: sessionsSetModel is not a function`, в перечне `index.test.ts` нет `'sessions.setModel'`, в
  `server.test.ts` — `expected [ …(n) ] to include 'sessions.setModel'` и расхождение с ключами `METHODS`.

- [ ] **Step 4: Реализация**

  `packages/host/src/sessions/sessions-service.ts`. Было:
  ```ts
    discardWorktree,
    finishExited,
  ```
  Стало:
  ```ts
    discardWorktree,
    effortsFor,
    finishExited,
  ```
  Было (после Task 10):
  ```ts
    /** Замок смены модели и effort этой сессии: через него идут `sessions.setEffort` и `sessions.setModel`. */
    exclusive: SwitchLock;
  }
  ```
  Стало:
  ```ts
    /** Замок смены модели и effort этой сессии: через него идут `sessions.setEffort` и `sessions.setModel`. */
    exclusive: SwitchLock;
    /**
     * Смена модели (спека нормалайзера, 5.8): живую сессию у приглашения перезапускает через resume с новым
     * `--model`, остальным только пишет карту. `effort` в ответе — что осталось в карте: `null` — сброшен (у новой
     * модели такого уровня нет) или его не было. Та же модель — ни записи, ни перезапуска.
     */
    setModel(ref: SessionRef, model: string): Promise<{ model: string; effort: string | null; restarted: boolean }>;
  }
  ```
  Было (конец `setChoice`, добавлен в Task 10):
  ```ts
        if (choice.effort === null) delete session.effort;
        else if (choice.effort !== undefined) session.effort = choice.effort;
      });
    }
  ```
  Стало:
  ```ts
        if (choice.effort === null) delete session.effort;
        else if (choice.effort !== undefined) session.effort = choice.effort;
      });
    }

    /**
     * Модель проверяет resolver; сохранённый effort остаётся, если он есть у новой модели, иначе сбрасывается в
     * «по умолчанию». Та же модель, что в карте, — ничего не пишется и не перезапускается. Сессия без процесса (спит,
     * закрыта, ждёт запуска) — только запись в карту: следующий запуск или resume возьмёт новую модель. Живая — только
     * у приглашения и без фоновых задач: запись в карту, остановка и resume с флагами из карты. Resume не поднялся —
     * ошибка уходит окну, а карта уже с новой моделью: кнопка Resume повторит запуск. Всё — под замком `exclusive`.
     */
    async function setModel(
      ref: SessionRef,
      model: string,
    ): Promise<{ model: string; effort: string | null; restarted: boolean }> {
      return exclusive(ref, async () => {
        const session = (await readMap(ref.projectPath, ref.workId)).sessions.find(
          (candidate) => candidate.id === ref.sessionId,
        );
        if (session === undefined) {
          throw new HostError('not_found', `session ${ref.sessionId} is not in the map of workspace ${ref.workId}`);
        }
        const entry = (await loadProviders())[session.provider];
        if (entry === undefined || !isClaudeCode(entry)) {
          throw new HostError('bad_request', 'the model of a session can be changed only for Claude Code sessions');
        }
        const next = (await resolveModelChoice(session.provider, model)).model;
        // Шаблон запуска без `{model}` (свои `args` в providers.json): модель до CLI не доедет — менять нечего.
        if (next === undefined) throw new HostError('bad_request', `provider ${entry.id} does not accept a model`);
        // Та же модель — ни записи, ни перезапуска: меню отмечает её и так.
        if (next === session.model) return { model: next, effort: session.effort ?? null, restarted: false };
        const effort =
          session.effort !== undefined && (effortsFor(entry, next)?.some((level) => level.id === session.effort) ?? false)
            ? session.effort
            : null;
        const live = pty.get(ref) !== undefined;
        if (live) {
          const state = activity.get(ref);
          if (!atPrompt(state)) throw busyError('Wait until the agent is idle');
          if (state?.activity.tasks.some((task) => task.background) === true) {
            throw busyError('Wait until background tasks finish');
          }
        }
        await setChoice(ref, { model: next, effort });
        if (!live) return { model: next, effort, restarted: false };
        await stop(ref);
        await launch(ref, 'resume');
        return { model: next, effort, restarted: true };
      });
    }
  ```
  Было (после Task 10):
  ```ts
      setChoice,
      exclusive,
  ```
  Стало:
  ```ts
      setChoice,
      exclusive,
      setModel,
  ```

  `packages/host/src/methods/sessions.ts`. Было (после Task 10):
  ```ts
    sessionsSetEffort: Handler<'sessions.setEffort'>;
  ```
  Стало:
  ```ts
    sessionsSetEffort: Handler<'sessions.setEffort'>;
    sessionsSetModel: Handler<'sessions.setModel'>;
  ```
  Было:
  ```ts
      sessionsResumeInterrupted: async (params) => {
  ```
  Стало:
  ```ts
      // Модель — перезапуском через resume с новым `--model` (спека нормалайзера, 5.8): правила и порядок — в сервисе.
      sessionsSetModel: async ({ ref, model }) => deps.sessions.setModel(ref, model),

      sessionsResumeInterrupted: async (params) => {
  ```

  `packages/host/src/methods/index.ts`. Было (после Task 10):
  ```ts
    'sessions.setEffort',
  ```
  Стало:
  ```ts
    'sessions.setEffort',
    'sessions.setModel',
  ```
  Было (после Task 10):
  ```ts
      'sessions.setEffort': sessions.sessionsSetEffort as AnyHandler,
  ```
  Стало:
  ```ts
      'sessions.setEffort': sessions.sessionsSetEffort as AnyHandler,
      'sessions.setModel': sessions.sessionsSetModel as AnyHandler,
  ```

- [ ] **Step 5: Прогон — зелёный; весь пакет, сборка, стражи, lint**

  Run: `pnpm --filter @parley/host exec vitest run src/sessions/sessions-service.test.ts src/methods/sessions.test.ts src/methods/index.test.ts src/server.test.ts`
  Expected: PASS, все файлы.

  Run: `pnpm --filter @parley/host test`
  Expected: PASS, весь пакет. Красный тест, которого эта задача не трогала, сверить с прогоном на коммите до Task 8
  (известные флейки под нагрузкой — `activity-terminal`, `works-service`).

  Run: `pnpm --filter @parley/host build`
  Expected: exit 0.

  Run: `pnpm --filter @parley/core exec vitest run test/frame-check.test.ts`
  Expected: PASS.

  Run: `pnpm exec eslint packages/host`
  Expected: без ошибок.

- [ ] **Step 6: Коммит**

  ```bash
  git add packages/protocol/src/methods.ts packages/protocol/src/methods.test.ts \
    packages/host/src/sessions/sessions-service.ts packages/host/src/sessions/sessions-service.test.ts \
    packages/host/src/methods/sessions.ts packages/host/src/methods/sessions.test.ts \
    packages/host/src/methods/index.ts packages/host/src/methods/index.test.ts packages/host/src/server.test.ts
  git commit -m "feat(host): sessions.setModel — смена модели перезапуском через resume" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 12: Окно — уровни effort выбранной модели в диалоге «New session or room» и пункт Default

**Files:**
- Create: `packages/desktop/src/renderer/lib/effort-choices.ts`
- Create: `packages/desktop/src/renderer/lib/effort-choices.test.ts`
- Modify: `packages/desktop/src/renderer/ui/select.tsx:120-142` (`SelectItem`)
- Modify: `packages/desktop/src/renderer/ui/ui.test.tsx` (новый `describe` между строками 186 и 188)
- Modify: `packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.tsx` — шапка 34-37, импорты 61-77, 89-118, 345-351, 379-404, 509-515, 555-559, 593-634
- Modify: `packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.test.tsx` — 121-122, 196-205, 263-296, 352-391, 395-409, 979; новый `describe` после строки 392
- Modify: `packages/desktop/src/renderer/store/providers.test.ts` — новый тест после строки 151 (закрепляет поведение; кода не меняет: стор раскрывает элемент как есть)
- Modify: `packages/desktop/src/shared/strings.ts:306-312`

**Interfaces:**
- Consumes:
  - типы `@parley/protocol` (Task 6): `EffortOption { id: string; label: string; description?: string }`, `ModelOption { id: string; label: string; efforts?: EffortOption[] | null }`;
  - `Result<'providers.list'>['providers'][number]` с `models?: ModelOption[] | null`, `effort?: boolean`, `argsOverridden?: boolean`;
  - `Params<'sessions.create'>.effort?: string`.
- Produces:
  - `export const LEGACY_EFFORTS: readonly EffortOption[]`;
  - `export interface EffortSource { models?: readonly ModelOption[] | null; effort?: boolean }`;
  - `export function effortChoices(info: EffortSource | undefined, model: string | null): readonly EffortOption[] | null`;
  - проп `SelectItem` `description?: string | undefined`;
  - `S.dialogs.newSession.effortDefault: 'Default'`;
  - `AgentRow.effort: string | null` (`null` — Default); помощники диалога `chosenModel(row, info)` и `chosenEffort(row, info)`: выбор строки, если он ещё есть в снимке провайдеров, иначе `null` — Default.

- [ ] **Step 1: Тесты — правила уровней, описание пункта списка, стор, диалог**

Создать `packages/desktop/src/renderer/lib/effort-choices.test.ts`:

```ts
/** Уровни effort для окна (нормалайзер модели и effort 2026-10-06, 5.1 и 5.3): те же правила, что `effortsFor` core. */

import { describe, expect, it } from 'vitest';
import type { EffortOption, ModelOption } from '@parley/protocol';
import { effortChoices, LEGACY_EFFORTS } from './effort-choices.js';

const FIVE: EffortOption[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
];
const ULTRA: EffortOption = { id: 'ultra', label: 'Ultra', description: 'Maximum reasoning with automatic task delegation' };
const SOL: ModelOption = { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: [...FIVE, ULTRA] };
const LUNA: ModelOption = { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: FIVE };
const OPUS: ModelOption = { id: 'opus', label: 'Opus', efforts: FIVE };
const HAIKU: ModelOption = { id: 'haiku', label: 'Haiku', efforts: null };
const ids = (levels: readonly EffortOption[] | null): string[] | null => (levels === null ? null : levels.map((level) => level.id));

describe('effortChoices', () => {
  it('провайдер не принимает effort (false, поля нет) или ответа providers.list ещё нет — null', () => {
    expect(effortChoices(undefined, null)).toBeNull();
    expect(effortChoices({ models: [OPUS] }, 'opus')).toBeNull();
    expect(effortChoices({ models: [OPUS], effort: false }, 'opus')).toBeNull();
  });

  it('модель со списком — её уровни по порядку; у Haiku (efforts: null) — null', () => {
    expect(ids(effortChoices({ models: [SOL, LUNA], effort: true }, 'gpt-6.1-sol'))).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(ids(effortChoices({ models: [SOL, LUNA], effort: true }, 'gpt-6-luna'))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortChoices({ models: [OPUS, HAIKU], effort: true }, 'haiku')).toBeNull();
  });

  it('модель Default — уровни, общие для моделей с непустым списком, в порядке первой; Haiku не в счёт; общих нет — null', () => {
    expect(ids(effortChoices({ models: [SOL, LUNA], effort: true }, null))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(ids(effortChoices({ models: [HAIKU, OPUS], effort: true }, null))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortChoices({ models: [HAIKU], effort: true }, null)).toBeNull();
    expect(effortChoices({ models: [{ id: 'a', label: 'A', efforts: [ULTRA] }, LUNA], effort: true }, null)).toBeNull();
  });

  it('старый хост (у моделей нет поля efforts, effort: true) — прежние три уровня и у модели, и у Default', () => {
    const old = { models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }], effort: true };
    expect(effortChoices(old, 'opus')).toBe(LEGACY_EFFORTS);
    expect(ids(effortChoices(old, null))).toEqual(['low', 'medium', 'high']);
  });

  it('списка моделей нет (null, пусто, нет поля) или модели в нём нет — прежние три уровня', () => {
    expect(effortChoices({ models: null, effort: true }, null)).toBe(LEGACY_EFFORTS);
    expect(effortChoices({ models: [], effort: true }, null)).toBe(LEGACY_EFFORTS);
    expect(effortChoices({ effort: true }, 'anything')).toBe(LEGACY_EFFORTS);
    expect(effortChoices({ models: [OPUS], effort: true }, 'gone')).toBe(LEGACY_EFFORTS);
  });

  it('пустой список уровней модели окно показывает как null — поля нет', () => {
    expect(effortChoices({ models: [{ id: 'bare', label: 'Bare', efforts: [] }], effort: true }, 'bare')).toBeNull();
  });

  it('LEGACY_EFFORTS — low, medium, high с подписями окна', () => {
    expect(LEGACY_EFFORTS).toEqual([
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
    ]);
  });
});
```

В `packages/desktop/src/renderer/ui/ui.test.tsx` вставить между концом `describe('ui/glass — …')` (строка 186) и `describe('ui/tooltip — …')` (строка 188):

```tsx
describe('ui/select — описание пункта (нормалайзер модели и effort 2026-10-06)', () => {
  it('description — вторая строка пункта: в имя пункта и в кнопку списка не попадает', () => {
    render(
      <Select defaultOpen defaultValue="ultra">
        <SelectTrigger aria-label="Effort">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="low">Low</SelectItem>
          <SelectItem value="ultra" description="Maximum reasoning with automatic task delegation">
            Ultra
          </SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(screen.getByRole('option', { name: 'Ultra' }).textContent).toBe('UltraMaximum reasoning with automatic task delegation');
    expect(screen.getByText('Maximum reasoning with automatic task delegation').className).toContain('truncate');
    expect(screen.getByRole('option', { name: 'Low' }).textContent).toBe('Low');
    // Открытый список прячет остальное от скринридера (`aria-hidden`) — кнопку ищем с `hidden`.
    expect(screen.getByRole('combobox', { name: 'Effort', hidden: true }).textContent).toBe('Ultra');
  });
});
```

В `packages/desktop/src/renderer/store/providers.test.ts` вставить после теста «хост, переживший окно, версию не шлёт: …» (кончается на строке 151), внутри `describe('useProvidersStore.init', …)`:

```ts
  it('уровни effort у моделей и argsOverridden доходят до стора как есть (нормалайзер модели и effort 2026-10-06)', async () => {
    const bridge = createFakeBridge();
    const models = [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: [{ id: 'ultra', label: 'Ultra', description: 'Maximum reasoning with automatic task delegation' }] },
      { id: 'haiku-like', label: 'No effort', efforts: null },
    ];
    bridge.setHandler('providers.list', () => ({ providers: [{ id: 'codex', label: 'Codex', available: true, models, effort: true, argsOverridden: true }] }));
    const dispose = useProvidersStore.getState().init(bridge);
    await flush();
    expect(useProvidersStore.getState().providers[0]).toMatchObject({ models, effort: true, argsOverridden: true });
    dispose();
  });
```

В `packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.test.tsx`:

(a) Строки 121-122. Было:

```ts
/** Сегмент усилия строки: у Radix ToggleGroup единственного выбора роль — radiogroup. */
const effortGroup = (row: number): HTMLElement => within(rows()[row] as HTMLElement).getByRole('radiogroup', { name: 'Effort' });
```

Стало:

```ts
/** Список уровней effort строки (нормалайзер модели и effort 2026-10-06): Radix Select, у кнопки роль combobox. */
const effortSelect = (row: number): HTMLElement => within(rows()[row] as HTMLElement).getByRole('combobox', { name: 'Effort' });
const modelSelect = (row: number): HTMLElement => within(rows()[row] as HTMLElement).getByRole('combobox', { name: 'Model' });
/** Имена пунктов открытого списка: пункт Radix связан со своим `ItemText`, описание уровня второй строкой в имя не входит. */
async function optionNames(trigger: HTMLElement): Promise<string[]> {
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const options = await screen.findAllByRole('option');
  return options.map((option) => document.getElementById(option.getAttribute('aria-labelledby') ?? '')?.textContent ?? '');
}
```

(b) Строки 196-205. Было: тест ««+ Add agent»: провайдер последней строки, модель Default, усилие Medium». Стало:

```tsx
  it('«+ Add agent»: провайдер последней строки, модель Default, effort Default', async () => {
    await renderDialog();
    fireEvent.click(providerRadio(0, 'Codex'));
    await addAgent();
    expect(rows()).toHaveLength(2);
    expect(isChecked(providerRadio(1, 'Codex'))).toBe(true);
    expect(modelSelect(1).textContent).toBe('Default');
    expect(effortSelect(1).textContent).toBe('Default');
  });
```

(c) Строка 267, внутри теста «один sessions.create с model и effort, без rooms.create; …». Было:

```tsx
    fireEvent.click(within(effortGroup(0)).getByRole('radio', { name: 'High' }));
```

Стало (ожидаемый вызов по-прежнему с `effort: 'high'`):

```tsx
    await chooseOption(effortSelect(0), 'High');
```

(d) Строки 289-296. Было: тест «модель Default и усилие по умолчанию: model не уходит, effort — medium». Стало:

```tsx
  it('модель и effort Default: ни model, ни effort не уходят — CLI берёт своё', async () => {
    await renderDialog();
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    const params = callsOf('sessions.create')[0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('model');
    expect(params).not.toHaveProperty('effort');
    expect(params).toMatchObject({ provider: 'claude', label: '', task: '' });
  });
```

(e) Строка 360 (в `it.each` «контрола модели и усилия нет»). Было:

```tsx
    expect(within(rows()[0] as HTMLElement).queryByRole('radiogroup', { name: 'Effort' })).toBeNull();
```

Стало:

```tsx
    expect(within(rows()[0] as HTMLElement).queryByRole('combobox', { name: 'Effort' })).toBeNull();
```

(f) Строки 377 и 380 (тест «effort: false при непустом списке …»). Было:

```tsx
    expect(within(rows()[0] as HTMLElement).queryByRole('radiogroup', { name: 'Effort' })).toBeNull();
    fireEvent.click(providerRadio(0, 'Codex'));
    expect(within(rows()[0] as HTMLElement).queryByRole('combobox', { name: 'Model' })).toBeNull();
    expect(effortGroup(0)).toBeTruthy();
```

Стало:

```tsx
    expect(within(rows()[0] as HTMLElement).queryByRole('combobox', { name: 'Effort' })).toBeNull();
    fireEvent.click(providerRadio(0, 'Codex'));
    expect(within(rows()[0] as HTMLElement).queryByRole('combobox', { name: 'Model' })).toBeNull();
    expect(effortSelect(0)).toBeTruthy();
```

(g) Строки 383-391. Удалить тест «повторный клик по выбранному усилию его не снимает»: он про ToggleGroup, а у Select снять выбор нельзя. На его место:

```tsx
  it('старый хост: у моделей нет efforts, effort: true — Default, Low, Medium, High; выбранный уходит', async () => {
    await renderDialog();
    expect(await optionNames(effortSelect(0))).toEqual(['Default', 'Low', 'Medium', 'High']);
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));
    expect(effortSelect(0).textContent).toBe('Low');
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'claude', effort: 'low' });
  });
```

(h) После закрывающей `});` у `describe('NewSessionOrRoomDialog — контролы модели и усилия по providers.list (решение 5)', …)` (строка 392) добавить:

```tsx
describe('NewSessionOrRoomDialog — уровни effort по модели (нормалайзер модели и effort 2026-10-06, 5.9)', () => {
  const FIVE = [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra high' },
    { id: 'max', label: 'Max' },
  ];
  const CODEX_LEVELS = [
    { id: 'low', label: 'Low', description: 'Fast responses with lighter reasoning' },
    { id: 'medium', label: 'Medium', description: 'Balances speed and reasoning depth for everyday tasks' },
    { id: 'high', label: 'High', description: 'Greater reasoning depth for complex problems' },
    { id: 'xhigh', label: 'Extra high', description: 'Extra high reasoning depth for complex problems' },
    { id: 'max', label: 'Max', description: 'Maximum reasoning depth for the hardest problems' },
  ];
  const ULTRA = { id: 'ultra', label: 'Ultra', description: 'Maximum reasoning with automatic task delegation' };
  const LEVELED = [
    {
      id: 'claude',
      label: 'Claude',
      available: true,
      effort: true,
      models: [
        { id: 'opus', label: 'Opus', efforts: FIVE },
        { id: 'haiku', label: 'Haiku', efforts: null },
        { id: 'opusplan[1m]', label: 'Opus Plan (1M context)', efforts: FIVE },
      ],
    },
    {
      id: 'codex',
      label: 'Codex',
      available: true,
      effort: true,
      models: [
        { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: [...CODEX_LEVELS, ULTRA] },
        { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: CODEX_LEVELS },
      ],
    },
  ];

  beforeEach(() => {
    bridge.setHandler('providers.list', async () => ({ providers: LEVELED }));
  });

  it('Codex: у GPT-6.1-Sol есть Ultra с описанием второй строкой; смена на GPT-6-Luna сбрасывает Ultra в Default', async () => {
    await renderDialog();
    fireEvent.click(providerRadio(0, 'Codex'));
    expect(effortSelect(0).textContent).toBe('Default');
    await chooseOption(modelSelect(0), 'GPT-6.1-Sol');
    expect(await optionNames(effortSelect(0))).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max', 'Ultra']);
    const ultra = screen.getByRole('option', { name: 'Ultra' });
    expect(ultra.textContent).toContain('Maximum reasoning with automatic task delegation');
    fireEvent.click(ultra);
    // В кнопке — только подпись уровня, без описания.
    expect(effortSelect(0).textContent).toBe('Ultra');
    await chooseOption(modelSelect(0), 'GPT-6-Luna');
    expect(effortSelect(0).textContent).toBe('Default');
    expect(await optionNames(effortSelect(0))).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
    fireEvent.click(screen.getByRole('option', { name: 'Max' }));
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'codex', model: 'gpt-6-luna', effort: 'max' });
  });

  it('уровень, который есть и у новой модели, остаётся: Opus с High → Opus Plan (1M context) с High', async () => {
    await renderDialog();
    await chooseOption(modelSelect(0), 'Opus');
    await chooseOption(effortSelect(0), 'High');
    await chooseOption(modelSelect(0), 'Opus Plan (1M context)');
    expect(effortSelect(0).textContent).toBe('High');
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'claude', model: 'opusplan[1m]', effort: 'high' });
  });

  it('Haiku — поля effort нет и effort не уходит; снова Opus — поле на Default', async () => {
    await renderDialog();
    await chooseOption(effortSelect(0), 'Max');
    await chooseOption(modelSelect(0), 'Haiku');
    expect(within(rows()[0] as HTMLElement).queryByRole('combobox', { name: 'Effort' })).toBeNull();
    await chooseOption(modelSelect(0), 'Opus');
    expect(effortSelect(0).textContent).toBe('Default');
    await chooseOption(modelSelect(0), 'Haiku');
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'claude', model: 'haiku' });
    expect(callsOf('sessions.create')[0]).not.toHaveProperty('effort');
  });

  it('модель Default — общие уровни моделей провайдера: у Claude пять (Haiku не в счёт), у Codex — без Ultra', async () => {
    await renderDialog();
    expect(await optionNames(effortSelect(0))).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
    fireEvent.click(screen.getByRole('option', { name: 'Default' }));
    fireEvent.click(providerRadio(0, 'Codex'));
    expect(await optionNames(effortSelect(0))).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
  });

  it('каталог сменился при открытом диалоге (providers.changed): выбранных модели и уровня больше нет — поля в Default, уходит без них', async () => {
    let providers = LEVELED;
    bridge.setHandler('providers.list', async () => ({ providers }));
    await renderDialog();
    fireEvent.click(providerRadio(0, 'Codex'));
    await chooseOption(modelSelect(0), 'GPT-6.1-Sol');
    await chooseOption(effortSelect(0), 'Ultra');
    // Новый каталог Codex: GPT-6.1-Sol из него ушла, а у оставшейся модели нет Ultra.
    providers = [LEVELED[0]!, { ...LEVELED[1]!, models: [{ id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: CODEX_LEVELS }] }];
    act(() => bridge.emit('providers.changed', { provider: 'codex' }));
    await waitFor(() => expect(callsOf('providers.list')).toHaveLength(2));
    await act(async () => {});

    expect(modelSelect(0).textContent).toBe('Default');
    expect(effortSelect(0).textContent).toBe('Default');
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'codex' });
    expect(callsOf('sessions.create')[0]).not.toHaveProperty('model');
    expect(callsOf('sessions.create')[0]).not.toHaveProperty('effort');
  });

  it('смена провайдера сбрасывает и модель, и effort в Default', async () => {
    await renderDialog();
    await chooseOption(modelSelect(0), 'Opus');
    await chooseOption(effortSelect(0), 'Max');
    fireEvent.click(providerRadio(0, 'Codex'));
    expect(modelSelect(0).textContent).toBe('Default');
    expect(effortSelect(0).textContent).toBe('Default');
    fireEvent.click(providerRadio(0, 'Claude'));
    expect(modelSelect(0).textContent).toBe('Default');
    expect(effortSelect(0).textContent).toBe('Default');
  });
});
```

(i) Строки 405-409 (тест комнаты «три агента — три sessions.create …»). Было: каждый из трёх ожидаемых объектов кончается на `effort: 'medium'`. Стало:

```tsx
    expect(callsOf('sessions.create')).toEqual([
      { projectPath: PROJECT, workId: 'w-01', provider: 'claude', label: '', task: '', parent: null, worktree: false, model: 'sonnet' },
      { projectPath: PROJECT, workId: 'w-01', provider: 'codex', label: '', task: '', parent: null, worktree: false },
      { projectPath: PROJECT, workId: 'w-01', provider: 'claude', label: '', task: '', parent: null, worktree: false },
    ]);
```

(j) Строка 979 (тест GLM «Save обновляет открытый диалог…»). Было:

```tsx
    expect(within(rows()[0] as HTMLElement).queryByRole('radiogroup', { name: 'Effort' })).toBeNull();
```

Стало:

```tsx
    expect(within(rows()[0] as HTMLElement).queryByRole('combobox', { name: 'Effort' })).toBeNull();
```

- [ ] **Step 2: Прогон — красные**

Run:
```bash
pnpm --filter @parley/desktop exec vitest run src/renderer/lib/effort-choices.test.ts src/renderer/ui/ui.test.tsx src/renderer/store/providers.test.ts src/renderer/components/dialogs/NewSessionOrRoomDialog.test.tsx
```
Expected:
- `effort-choices.test.ts`: `Failed to resolve import "./effort-choices.js"`.
- `ui.test.tsx`: `expected 'Ultra' to be 'UltraMaximum reasoning with automatic task delegation'`.
- `NewSessionOrRoomDialog.test.tsx` падает во всех тестах с `effortSelect`: `Unable to find an accessible element with the role "combobox" and name "Effort"`. Падает и «модель и effort Default»: `expected {…} not to have property "effort"`.
- `providers.test.ts`: PASS. Новый тест закрепляет нынешнее поведение: стор раскрывает элемент как есть.

- [ ] **Step 3: `renderer/lib/effort-choices.ts`**

Создать `packages/desktop/src/renderer/lib/effort-choices.ts`:

```ts
/**
 * Уровни effort для окна (нормалайзер модели и effort 2026-10-06, 5.1 и 5.3): те же правила, что `effortsFor` в core,
 * но по строке ответа `providers.list` — рантайм core окну не нужен. Диалог новой сессии и меню чата берут уровни
 * отсюда, и это тот же список, по которому хост проверит выбор (`resolveModelEffort`).
 */

import type { EffortOption, ModelOption } from '@parley/protocol';
import { S } from '../../shared/strings.js';

/**
 * Прежние три уровня — `LEGACY_EFFORTS` core: так отвечают старый хост (`effort: true`, у моделей нет `efforts`),
 * свой список моделей без уровней и провайдер без списка.
 */
export const LEGACY_EFFORTS: readonly EffortOption[] = [
  { id: 'low', label: S.dialogs.newSession.effortLow },
  { id: 'medium', label: S.dialogs.newSession.effortMedium },
  { id: 'high', label: S.dialogs.newSession.effortHigh },
];

/** Что окну нужно знать о провайдере — поля строки `providers.list`. */
export interface EffortSource {
  models?: readonly ModelOption[] | null;
  effort?: boolean;
}

/** Уровни одной модели: поля `efforts` нет (свой список, старый хост) — прежние три; `null` — effort у модели нет. */
function levelsOf(model: ModelOption | undefined): readonly EffortOption[] | null {
  return model === undefined || model.efforts === undefined ? LEGACY_EFFORTS : model.efforts;
}

/**
 * Уровни выбора для модели; `model: null` — «Default»: уровни, общие для всех моделей провайдера с непустым списком,
 * в порядке первой из них. `null` — выбора effort нет: провайдер effort не принимает (`effort` не `true`, в том числе
 * ответа ещё нет), у модели уровней нет или общих нет. Пустой список окно показывает так же, как `null`: явного
 * уровня у такой модели хост всё равно не примет.
 */
export function effortChoices(info: EffortSource | undefined, model: string | null): readonly EffortOption[] | null {
  if (info?.effort !== true) return null;
  const list = info.models ?? [];
  if (list.length === 0) return LEGACY_EFFORTS;
  if (model !== null) {
    const levels = levelsOf(list.find((option) => option.id === model));
    return levels === null || levels.length === 0 ? null : levels;
  }
  const sets = list
    .map((option) => levelsOf(option))
    .filter((levels): levels is readonly EffortOption[] => levels !== null && levels.length > 0);
  const [first, ...rest] = sets;
  if (first === undefined) return null;
  const shared = first.filter((level) => rest.every((levels) => levels.some((other) => other.id === level.id)));
  return shared.length === 0 ? null : shared;
}
```

- [ ] **Step 4: `SelectItem` — вторая строка описания**

`packages/desktop/src/renderer/ui/select.tsx`, строки 120-142. Было:

```tsx
export const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
```

Стало:

```tsx
export const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & {
    /**
     * Вторая, приглушённая строка пункта — описание уровня effort (нормалайзер модели и effort 2026-10-06, 5.9). Она вне
     * `ItemText`: Radix копирует в кнопку списка и берёт в имя пункта только его, поэтому там остаётся одна подпись.
     */
    description?: string | undefined;
  }
>(({ className, children, description, ...props }, ref) => (
```

и в том же компоненте было:

```tsx
    <SelectPrimitive.ItemText className="min-w-0 truncate">{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
```

стало:

```tsx
    {description === undefined ? (
      <SelectPrimitive.ItemText className="min-w-0 truncate">{children}</SelectPrimitive.ItemText>
    ) : (
      <span className="flex min-w-0 flex-col">
        <span className="truncate">
          <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        </span>
        <span className="truncate text-[11px] leading-[15px] text-muted-foreground">{description}</span>
      </span>
    )}
  </SelectPrimitive.Item>
));
```

- [ ] **Step 5: Строка `Default` уровня**

`packages/desktop/src/shared/strings.ts`, строки 309-312. Было:

```ts
      effortField: 'Effort',
      effortLow: 'Low',
      effortMedium: 'Medium',
      effortHigh: 'High',
```

Стало:

```ts
      effortField: 'Effort',
      /** Первый пункт списка уровней: без флага `--effort` — CLI берёт уровень, сохранённый у себя (нормалайзер 2026-10-06). */
      effortDefault: 'Default',
      /** Прежние три уровня: старый хост и свои списки без уровней (`LEGACY_EFFORTS`, `lib/effort-choices.ts`). */
      effortLow: 'Low',
      effortMedium: 'Medium',
      effortHigh: 'High',
```

- [ ] **Step 6: Диалог — список уровней вместо сегмента Low/Medium/High**

`packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.tsx`:

(a) Шапка, строки 34-37. Было:

```ts
 * Модель — только из списка провайдера (`providers.list.models`, решение 5 спеки): первый пункт `Default` — без
 * флага, модель CLI по умолчанию, дальше подписи списка, в `sessions.create.model` уходит `id`. Нет списка, `null`
 * или пусто — контрола нет и модель не передаётся. Усилие — сегмент `Low` / `Medium` / `High` при `effort: true`,
 * иначе скрыт. Своих списков и свободного ввода в окне нет.
```

Стало:

```ts
 * Модель — только из списка провайдера (`providers.list.models`, решение 5 спеки): первый пункт `Default` — без
 * флага, модель CLI по умолчанию, дальше подписи списка, в `sessions.create.model` уходит `id`. Нет списка, `null`
 * или пусто — контрола нет и модель не передаётся. Effort (нормалайзер модели и effort 2026-10-06, 5.9) — список
 * `Default` и уровней выбранной модели (`lib/effort-choices.ts`; у модели `Default` — уровни, общие для моделей
 * провайдера), описание уровня — второй строкой пункта; уровней нет — поля нет. Смена модели сбрасывает уровень,
 * которого у новой модели нет, в `Default`, смена провайдера — и модель, и уровень. Уходят только явно выбранные
 * значения: `Default` — без флага, CLI берёт сохранённое у себя. Своих списков и свободного ввода в окне нет.
```

(b) Импорты. Удалить строку 74:

```ts
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group.js';
```

и после строки 61 (`import { defaultProvider } from '../../lib/default-provider.js';`) добавить:

```ts
import { effortChoices } from '../../lib/effort-choices.js';
```

(c) Строки 89-96. Было:

```ts
type Effort = 'low' | 'medium' | 'high';
type ProviderOption = Result<'providers.list'>['providers'][number];

const EFFORTS: readonly { value: Effort; label: string }[] = [
  { value: 'low', label: S.dialogs.newSession.effortLow },
  { value: 'medium', label: S.dialogs.newSession.effortMedium },
  { value: 'high', label: S.dialogs.newSession.effortHigh },
];
```

Стало:

```ts
type ProviderOption = Result<'providers.list'>['providers'][number];
```

(d) После строки 102 (`const DEFAULT_MODEL = ' default';`) добавить:

```ts

/** Пункт `Default` списка уровней — без флага `--effort`; уровень — токен без пробелов (`EFFORT_TOKEN`), с ним не совпадёт. */
const DEFAULT_EFFORT = ' default';
```

(e) Строки 109-110. Было:

```ts
  model: string | null;
  effort: Effort;
}
```

Стало:

```ts
  model: string | null;
  /** Уровень из списка модели; `null` — `Default`, без флага. */
  effort: string | null;
}
```

(f) Строки 116-118. Было:

```ts
function initialRows(room: boolean): AgentRow[] {
  return Array.from({ length: room ? 2 : 1 }, (_, index) => ({ key: index + 1, provider: null, model: null, effort: 'medium' }));
}
```

Стало:

```ts
function initialRows(room: boolean): AgentRow[] {
  return Array.from({ length: room ? 2 : 1 }, (_, index) => ({ key: index + 1, provider: null, model: null, effort: null }));
}

/**
 * Модель строки, если она есть в списке провайдера; иначе `null` — `Default`. Каталог мог смениться под открытым
 * диалогом (`providers.changed`): исчезнувшая модель не показывается выбранной и не уходит в `sessions.create`.
 */
function chosenModel(row: Pick<AgentRow, 'model'>, info: ProviderOption | undefined): string | null {
  return row.model !== null && (info?.models ?? []).some((option) => option.id === row.model) ? row.model : null;
}

/**
 * Уровень строки, если он есть среди уровней её модели; иначе `null` — `Default`. Одно правило на подпись списка, сброс
 * при смене модели и отправку: снимок провайдеров мог смениться под строкой (`providers.changed`).
 */
function chosenEffort(row: Pick<AgentRow, 'model' | 'effort'>, info: ProviderOption | undefined): string | null {
  if (row.effort === null) return null;
  return effortChoices(info, chosenModel(row, info))?.some((level) => level.id === row.effort) === true ? row.effort : null;
}
```

(g) Строка 350 (`addAgent`). Было:

```ts
    setAgents((rows) => [...rows, { key: nextKey.current++, provider: last?.provider ?? null, model: null, effort: 'medium' }]);
```

Стало:

```ts
    setAgents((rows) => [...rows, { key: nextKey.current++, provider: last?.provider ?? null, model: null, effort: null }]);
```

(h) Строки 391-404 (`submit`). Было:

```ts
        if (row.provider === null) updateAgent(row.key, { provider: providerId });
        try {
          const { ref } = await bridge.call('sessions.create', {
```

Стало:

```ts
        if (row.provider === null) updateAgent(row.key, { provider: providerId });
        const model = chosenModel(row, info);
        const effort = chosenEffort(row, info);
        try {
          const { ref } = await bridge.call('sessions.create', {
```

и было:

```ts
            // Модель и усилие — только когда контрол на экране: провайдер без списка или флага их не получает.
            ...(row.model !== null && (info?.models?.length ?? 0) > 0 ? { model: row.model } : {}),
            ...(info?.effort === true ? { effort: row.effort } : {}),
```

стало:

```ts
            // Модель и effort — только явно выбранные и ещё существующие в снимке провайдеров: `Default` — без флага,
            // провайдер без списка или флага их не получает, исчезнувший после `providers.changed` выбор не уходит.
            ...(model === null ? {} : { model }),
            ...(effort === null ? {} : { effort }),
```

(i) Строки 510-511 (обход строк). Было:

```tsx
                const info = infoOf(row);
                const models = info?.models ?? null;
```

Стало:

```tsx
                const info = infoOf(row);
                const models = info?.models ?? null;
                const efforts = effortChoices(info, chosenModel(row, info));
```

(j) Строка 557 (`onClick` пилюли провайдера). Было:

```tsx
                                      updateAgent(row.key, { provider: provider.id, model: null });
```

Стало:

```tsx
                                      updateAgent(row.key, { provider: provider.id, model: null, effort: null });
```

(k) Строки 595-597 (`Select` модели). Было:

```tsx
                          value={row.model ?? DEFAULT_MODEL}
                          disabled={rowLocked}
                          onValueChange={(value) => updateAgent(row.key, { model: value === DEFAULT_MODEL ? null : value })}
```

Стало:

```tsx
                          value={chosenModel(row, info) ?? DEFAULT_MODEL}
                          disabled={rowLocked}
                          onValueChange={(value) => {
                            const model = value === DEFAULT_MODEL ? null : value;
                            // Уровня, которого у новой модели нет, больше не выбрать — он сбрасывается в `Default` (спека 5.9).
                            updateAgent(row.key, { model, effort: chosenEffort({ model, effort: row.effort }, info) });
                          }}
```

(l) Строки 616-634. Весь блок `{info?.effort === true ? ( <ToggleGroup …> … </ToggleGroup> ) : null}` заменить на:

```tsx
                      {efforts === null ? null : (
                        <Select
                          value={chosenEffort(row, info) ?? DEFAULT_EFFORT}
                          disabled={rowLocked}
                          onValueChange={(value) => updateAgent(row.key, { effort: value === DEFAULT_EFFORT ? null : value })}
                        >
                          {/* Ширина постоянная: длинная подпись уровня не сдвигает модель и не выталкивает строку из окна 800×500. */}
                          <SelectTrigger aria-label={text.effortField} className="w-32 shrink-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className={LIST_HEIGHT}>
                            <SelectItem value={DEFAULT_EFFORT} className={ITEM_CLIP}>
                              {text.effortDefault}
                            </SelectItem>
                            {efforts.map((level) => (
                              <SelectItem key={level.id} value={level.id} description={level.description} className={ITEM_CLIP}>
                                {level.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
```

- [ ] **Step 7: Прогон — зелёные; стражи окна**

Run:
```bash
pnpm --filter @parley/desktop exec vitest run src/renderer/lib/effort-choices.test.ts src/renderer/ui/ui.test.tsx src/renderer/store/providers.test.ts src/renderer/components/dialogs/NewSessionOrRoomDialog.test.tsx src/english-ui.test.ts
```
Expected: PASS, все файлы.

Run:
```bash
pnpm typecheck && pnpm exec eslint packages/desktop/src/renderer/lib packages/desktop/src/renderer/ui packages/desktop/src/renderer/components/dialogs packages/desktop/src/shared
```
Expected: без ошибок (диалог больше не импортирует `ToggleGroup`; `Effort` и `EFFORTS` удалены).

- [ ] **Step 8: Коммит**

```bash
git add packages/desktop/src/renderer/lib/effort-choices.ts packages/desktop/src/renderer/lib/effort-choices.test.ts packages/desktop/src/renderer/ui/select.tsx packages/desktop/src/renderer/ui/ui.test.tsx packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.tsx packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.test.tsx packages/desktop/src/renderer/store/providers.test.ts packages/desktop/src/shared/strings.ts
git commit -m "feat(desktop): уровни effort выбранной модели в диалоге запуска и пункт Default" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Окно — меню «модель · effort» в чате через sessions.setModel/setEffort, без /model

**Files:**
- Modify: `packages/desktop/src/renderer/chat/ChatToolbar.tsx` (весь файл, ниже)
- Modify: `packages/desktop/src/renderer/chat/ChatView.tsx` — шапка 30-35, импорты 44 и 50-53, пропсы 84-85, помощники после 111, тело 127-143 (+4 строки после слияния 0.5.3), 162-165, 226-230, 311-313
- Modify: `packages/desktop/src/renderer/layout/bodies/TerminalBody.tsx:41-50`
- Modify: `packages/desktop/src/renderer/chat/suggestions.ts` (весь файл, ниже)
- Modify: `packages/desktop/src/renderer/chat/use-suggestions.ts:1-34, 74-79, 140`
- Modify: `packages/desktop/src/renderer/chat/Composer.tsx:11-13` (комментарий)
- Modify: `packages/desktop/src/renderer/chat/ChatView.test.tsx` — 714-823 (и тест GLM из 0.5.3), 924-938, 970-980
- Modify: `packages/desktop/src/renderer/chat/suggestions.test.ts:19-23, 44-47`
- Modify: `packages/desktop/src/shared/strings.ts:771, 778-780, 1106`

**Interfaces:**
- Consumes:
  - `effortChoices(info, model)` (Task 12);
  - протокол: `'sessions.setEffort'` (Task 10) — параметры `{ ref; effort: string }`, ответ `{ effort: string | null; verified: boolean }`; `'sessions.setModel'` (Task 11) — параметры `{ ref: SessionRef; model: string }`, ответ `{ model: string; effort: string | null; restarted: boolean }`; `HOST_ERROR_REASONS.busy` (Task 6);
  - core `WorkSession.model?: string`, `WorkSession.effort?: string` (Task 4, Task 9);
  - хост: оба метода в `hello.methods`; отказ «занят» — `conflict` с `data.reason: 'busy'` (Task 10, Task 11); у `setModel` `effort: null` при прежнем уровне в карте — сброс.
- Produces:
  - `export interface ChoiceMenuProps { models: readonly ModelOption[]; model: string | null; modelLabel: string; efforts: readonly EffortOption[] | null; effort: string | null; modelDisabled: string | null; effortDisabled: string | null; busy: boolean; onSelectModel: (id: string) => void; onSelectEffort: (id: string) => void }`;
  - `ChatToolbarProps.choiceMenu?: ChoiceMenuProps` (вместо `modelMenu`; `ModelMenuProps` удалён);
  - `ChatViewProps.storedModel: string | null`, `ChatViewProps.storedEffort: string | null`;
  - `SuggestionSource { capabilities: Capabilities | null; listDir }` (без `models`); `SuggestionContext` без `'model'`;
  - `S.chat.choice.*` (в том числе `sessionBusy`); `S.errors.actions.switchModel`, `S.errors.actions.switchEffort`;
  - test id: `chat-model` (кнопка), `chat-model-label`, `chat-effort-label`, `chat-model-option[data-model]`, `chat-effort-option[data-effort]`, `chat-model-reason`, `chat-effort-reason`.

- [ ] **Step 1: Влить master с хотфиксом 0.5.3, если он уже там**

Хотфикс 0.5.3 (ветка `fix/glm-chat-model-menu`) спрятал у GLM меню модели в `ChatView.tsx`; эта задача меню возвращает.

```bash
git fetch origin
git show origin/master:packages/desktop/src/renderer/chat/ChatView.tsx | grep -c "provider === 'glm' ? NO_MODELS : providerModels"
```
Expected: `1` — хотфикс в master, вливать; `0` — его там ещё нет: ничего не вливать и дальше брать варианты «без хотфикса».

Если `1`:
```bash
git merge origin/master -m "merge: влить master с хотфиксом 0.5.3 перед меню «модель · effort» в чате" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
grep -n "provider === 'glm' ? NO_MODELS : providerModels" packages/desktop/src/renderer/chat/ChatView.tsx
pnpm install --frozen-lockfile && pnpm --filter @parley/desktop exec vitest run src/renderer/chat
```
Expected: слияние прошло; `grep` печатает строку хотфикса (≈ строка 143); тесты чата зелёные. Конфликт в `ChatView.tsx` и `ChatView.test.tsx` решается в пользу нового меню: при конфликте взять сторону master (`git checkout --theirs <файл>`), шаги 2 и 6 ниже заменяют эти места меню «модель · effort»; конфликт в README, CHANGELOG или TODOS — тоже сторону master, Task 15 правит их поверх. Затем `git add $(git diff --name-only --diff-filter=U)` и `git commit --no-edit`.

- [ ] **Step 2: Тесты — меню чата, подсказки без `/model`**

`packages/desktop/src/renderer/chat/ChatView.test.tsx`:

(a) В `describe('ChatView — индикатор работы, Resume и меню моделей (живая проверка 2026-10-02)', …)` (строка 714):
- переименовать его в `describe('ChatView — индикатор работы и Resume (живая проверка 2026-10-02)', …)`;
- удалить его помощник `const model = (): HTMLElement => screen.getByTestId('chat-model');`;
- удалить три теста: «у провайдера есть модели — подпись становится меню; выбор шлёт «/model <id>» с submit: true», «модель ещё не известна — триггер с подписью «Model»» и «у провайдера нет моделей (нет поля или null) — меню нет, подпись как была» (строки 783-822);
- если 0.5.3 влит — удалить и следующий за ними тест «GLM — ни меню модели, ни подсказок «/model »: Claude Code сохранил бы модель Z.ai умолчанием общего ~/.claude».

Сразу после закрывающей `});` этого `describe` добавить:

```tsx
describe('ChatView — меню «модель · effort» (нормалайзер модели и effort 2026-10-06, 5.9)', () => {
  const CHOICE_METHODS = [...FEED_METHODS, 'sessions.setModel', 'sessions.setEffort'];
  const LEVELS = [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra high' },
    { id: 'max', label: 'Max' },
  ];
  const CLAUDE_LEVELS = {
    ...CLAUDE_OK,
    effort: true,
    models: [
      { id: 'opus', label: 'Opus', efforts: LEVELS },
      { id: 'haiku', label: 'Haiku', efforts: null },
      { id: 'opusplan[1m]', label: 'Opus Plan (1M context)', efforts: LEVELS },
    ],
  };
  const trigger = (): HTMLElement => screen.getByTestId('chat-model');
  const openMenu = (): void => {
    fireEvent.keyDown(trigger(), { key: 'Enter' });
  };
  const modelItems = (): HTMLElement[] => screen.queryAllByTestId('chat-model-option');
  const effortItems = (): HTMLElement[] => screen.queryAllByTestId('chat-effort-option');
  const paramsOf = (method: string): unknown[] => bridge.calls.filter((call) => call.method === method).map((call) => call.params);
  const started = (model: string): FeedItem => ({ id: 'n1', at: AT, kind: 'notice', notice: { type: 'session-start', source: 'startup', model } });
  const disabled = (items: HTMLElement[]): boolean[] => items.map((item) => item.hasAttribute('data-disabled'));

  beforeEach(() => {
    hostWith(CHOICE_METHODS);
    useProvidersStore.setState({ providers: [CLAUDE_LEVELS], loaded: true });
  });

  it('кнопка «модель · effort»: модель из ленты, иначе из карты подписью каталога; effort из карты; нет выбора — Default', () => {
    const view = renderBody(makeSession('s-01', 'S01', { model: 'opus', effort: 'xhigh' }));
    setFeed([]);
    expect(trigger().getAttribute('title')).toBe('Opus · Extra high');
    setFeed([started('claude-opus-5-5')], 2);
    expect(trigger().getAttribute('title')).toBe('claude-opus-5-5 · Extra high');
    view.unmount();
    renderBody(makeSession('s-01', 'S01'));
    setFeed([], 3);
    expect(trigger().getAttribute('title')).toBe('Default · Default');
  });

  it('разделы — модели провайдера и уровни модели из карты, без пункта Default; отмечен выбор карты', () => {
    renderBody(makeSession('s-01', 'S01', { model: 'opus', effort: 'high' }));
    setFeed([]);
    openMenu();
    expect(modelItems().map((item) => [item.dataset.model, item.textContent])).toEqual([
      ['opus', 'Opus'],
      ['haiku', 'Haiku'],
      ['opusplan[1m]', 'Opus Plan (1M context)'],
    ]);
    expect(modelItems().map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(effortItems().map((item) => item.textContent)).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max']);
    expect(effortItems().map((item) => item.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false', 'false']);
    expect(screen.queryByRole('menuitemradio', { name: 'Default' })).toBeNull();
  });

  it('модели в карте нет — уровни Default (общие для моделей провайдера); Haiku в карте — раздела effort нет, на кнопке одна модель', () => {
    const view = renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    openMenu();
    expect(effortItems().map((item) => item.dataset.effort)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    view.unmount();
    renderBody(makeSession('s-01', 'S01', { model: 'haiku' }));
    expect(trigger().getAttribute('title')).toBe('Haiku');
    openMenu();
    expect(modelItems()).toHaveLength(3);
    expect(effortItems()).toEqual([]);
  });

  it('выбор модели — sessions.setModel, текста /model нет; уровня из карты у новой модели нет — тост о сбросе', async () => {
    bridge.setHandler('sessions.setModel', () => ({ model: 'haiku', effort: null, restarted: true }));
    renderBody(makeSession('s-01', 'S01', { model: 'opus', effort: 'high' }));
    setFeed([]);
    openMenu();
    fireEvent.click(modelItems()[1]!);
    await act(async () => {});
    expect(paramsOf('sessions.setModel')).toEqual([{ ref: REF, model: 'haiku' }]);
    expect(paramsOf('pty.send')).toEqual([]);
    expect(vi.mocked(toast).mock.calls.map((call) => call[0])).toEqual([S.chat.choice.effortReset('Haiku', 'High')]);
  });

  it('уровень есть и у новой модели — тоста нет; та же модель — запроса нет', async () => {
    bridge.setHandler('sessions.setModel', () => ({ model: 'opusplan[1m]', effort: 'high', restarted: true }));
    renderBody(makeSession('s-01', 'S01', { model: 'opus', effort: 'high' }));
    setFeed([]);
    openMenu();
    fireEvent.click(modelItems()[0]!);
    openMenu();
    fireEvent.click(modelItems()[2]!);
    await act(async () => {});
    expect(paramsOf('sessions.setModel')).toEqual([{ ref: REF, model: 'opusplan[1m]' }]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('выбор уровня — sessions.setEffort; verified: false — тост «откройте терминал»; текста в терминал нет', async () => {
    bridge.setHandler('sessions.setEffort', () => ({ effort: 'medium', verified: false }));
    renderBody(makeSession('s-01', 'S01', { model: 'opus', effort: 'medium' }));
    setFeed([]);
    openMenu();
    fireEvent.click(effortItems()[4]!);
    await act(async () => {});
    expect(paramsOf('sessions.setEffort')).toEqual([{ ref: REF, effort: 'max' }]);
    expect(vi.mocked(toast).mock.calls.map((call) => call[0])).toEqual([S.chat.choice.openTerminal]);
    expect(paramsOf('pty.send')).toEqual([]);
  });

  it('отказ хоста: conflict с причиной busy — «сессия занята», прочее — текст по коду', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.setHandler('sessions.setEffort', () => {
      throw { code: 'conflict', message: 'Wait until the agent is idle', data: { reason: 'busy' } };
    });
    bridge.setHandler('sessions.setModel', () => {
      throw { code: 'bad_request', message: 'not in the list' };
    });
    renderBody(makeSession('s-01', 'S01', { model: 'opus' }));
    setFeed([]);
    openMenu();
    fireEvent.click(effortItems()[0]!);
    await act(async () => {});
    openMenu();
    fireEvent.click(modelItems()[2]!);
    await act(async () => {});
    expect(vi.mocked(toast.error).mock.calls.map((call) => call[0])).toEqual([
      S.chat.choice.sessionBusy,
      "Couldn't switch the model: invalid request.",
    ]);
    vi.restoreAllMocks();
  });

  it('агент работает — неактивны оба раздела с причиной; держат фоновые задачи — тоже; неживая сессия — только уровни', () => {
    useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'working')]), loaded: true });
    const working = renderBody(makeSession('s-01', 'S01', { model: 'opus' }));
    setFeed([]);
    openMenu();
    expect(disabled(modelItems())).toEqual([true, true, true]);
    expect(disabled(effortItems())).toEqual([true, true, true, true, true]);
    expect(screen.getByTestId('chat-model-reason').textContent).toBe(S.chat.choice.agentWorking);
    expect(screen.getByTestId('chat-effort-reason').textContent).toBe(S.chat.choice.agentWorking);
    fireEvent.click(modelItems()[1]!);
    fireEvent.click(effortItems()[0]!);
    expect(paramsOf('sessions.setModel')).toEqual([]);
    expect(paramsOf('sessions.setEffort')).toEqual([]);
    working.unmount();

    act(() => useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'working', { heldByBackground: true })]) }));
    const held = renderBody(makeSession('s-01', 'S01', { model: 'opus' }));
    openMenu();
    expect(disabled(modelItems())).toEqual([true, true, true]);
    expect(screen.getByTestId('chat-model-reason').textContent).toBe(S.chat.choice.backgroundTasks);
    expect(screen.getByTestId('chat-effort-reason').textContent).toBe(S.chat.choice.backgroundTasks);
    held.unmount();

    act(() => useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'idle')]) }));
    renderBody(makeSession('s-01', 'S01', { model: 'opus', lifecycle: 'sleeping' }));
    openMenu();
    expect(disabled(modelItems())).toEqual([false, false, false]);
    expect(screen.queryByTestId('chat-model-reason')).toBeNull();
    expect(disabled(effortItems())).toEqual([true, true, true, true, true]);
    expect(screen.getByTestId('chat-effort-reason').textContent).toBe(S.chat.choice.notLive);
  });

  it('старый хост без sessions.setModel/setEffort — меню нет, подпись текстом; /model не отправляется', async () => {
    hostWith(FEED_METHODS);
    renderBody(makeSession('s-01', 'S01', { model: 'opus', effort: 'high' }));
    setFeed([started('claude-opus-5-5')]);
    expect(trigger().tagName).toBe('SPAN');
    expect(trigger().textContent).toBe('claude-opus-5-5');
    fireEvent.keyDown(trigger(), { key: 'Enter' });
    expect(modelItems()).toEqual([]);
    await act(async () => {});
    expect(paramsOf('pty.send')).toEqual([]);
  });

  it('хост знает только один из двух методов — меню тоже нет; подпись — модель карты', () => {
    hostWith([...FEED_METHODS, 'sessions.setModel']);
    renderBody(makeSession('s-01', 'S01', { model: 'opus' }));
    setFeed([]);
    expect(trigger().tagName).toBe('SPAN');
    expect(trigger().textContent).toBe('Opus');
  });

  it('у провайдера ни моделей, ни effort — меню нет, подпись из ленты', () => {
    useProvidersStore.setState({ providers: [CLAUDE_OK], loaded: true });
    renderBody(makeSession('s-01', 'S01'));
    setFeed([started('opus')]);
    expect(trigger().tagName).toBe('SPAN');
    expect(trigger().textContent).toBe('opus');
  });

  it('GLM — меню есть (хотфикс 0.5.3 снят): модели Z.ai и пять уровней; выбор — sessions.setModel', async () => {
    const GLM_LEVELS = {
      id: 'glm',
      label: 'GLM',
      available: true,
      version: '2.1.287',
      family: 'claude' as const,
      limits: null,
      effort: true,
      models: [
        { id: 'glm-5.3[1m]', label: 'GLM-5.3 (1M context)', efforts: LEVELS },
        { id: 'glm-5.3-flash[1m]', label: 'GLM-5.3 Flash (1M context)', efforts: LEVELS },
      ],
    };
    bridge.setHandler('sessions.setModel', () => ({ model: 'glm-5.3-flash[1m]', effort: null, restarted: true }));
    useProvidersStore.setState({ providers: [CLAUDE_OK, GLM_LEVELS], loaded: true });
    renderBody(makeSession('s-01', 'S01', { provider: 'glm', model: 'glm-5.3[1m]' }));
    setFeed([]);
    expect(trigger().getAttribute('title')).toBe('GLM-5.3 (1M context) · Default');
    openMenu();
    expect(modelItems().map((item) => item.dataset.model)).toEqual(['glm-5.3[1m]', 'glm-5.3-flash[1m]']);
    expect(effortItems()).toHaveLength(5);
    fireEvent.click(modelItems()[1]!);
    await act(async () => {});
    expect(paramsOf('sessions.setModel')).toEqual([{ ref: REF, model: 'glm-5.3-flash[1m]' }]);
    expect(paramsOf('pty.send')).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('длинная модель обрезается, уровень виден целиком: правило вёрстки кнопки для окна 800 px', () => {
    renderBody(makeSession('s-01', 'S01', { model: 'opusplan[1m]', effort: 'xhigh' }));
    setFeed([]);
    const label = screen.getByTestId('chat-model-label');
    const level = screen.getByTestId('chat-effort-label');
    expect(label.textContent).toBe('Opus Plan (1M context)');
    expect(level.textContent).toBe('· Extra high');
    expect(label.className.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
    expect(level.className.split(' ')).toContain('shrink-0');
    expect(trigger().className.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'max-w-[40%]']));
  });
});
```

(b) Строки 924-938. Было: тест ««/model » — модели провайдера; выбор вставляет «/model <id>» без пробела и без отправки». Стало:

```tsx
  it('«/model » — подсказок моделей нет (нормалайзер 2026-10-06): модель меняет меню тулбара, без записи в настройки CLI', async () => {
    await renderWithCapabilities();
    type('/model ');
    expect(screen.queryByTestId('chat-suggestions')).toBeNull();
    type('/model op');
    expect(screen.queryByTestId('chat-suggestions')).toBeNull();
    expect(sends()).toEqual([]);
  });
```

(c) Строки 970-980. Было: тест «хост без capabilities.list — метод не зовётся, команд нет, модели работают». Стало:

```tsx
  it('хост без capabilities.list — метод не зовётся, команд нет', async () => {
    useProvidersStore.setState({ providers: [{ ...CLAUDE_OK, models: [{ id: 'opus', label: 'Opus' }] }], loaded: true });
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    await act(async () => {});
    type('/');
    expect(screen.queryByTestId('chat-suggestions')).toBeNull();
    type('/model ');
    expect(screen.queryByTestId('chat-suggestions')).toBeNull();
    expect(bridge.calls.filter((call) => call.method === 'capabilities.list')).toEqual([]);
  });
```

`packages/desktop/src/renderer/chat/suggestions.test.ts`:

(d) Строки 19-23. Было: тест ««/model » и «/model son» — выбор модели». Стало:

```ts
  it('«/model » — не подсказка: модель меняет меню тулбара (нормалайзер 2026-10-06); «/model» без пробела — команда', () => {
    expect(suggestionContext('/model ', 7)).toBeNull();
    expect(suggestionContext('/model son', 10)).toBeNull();
    expect(suggestionContext('/model', 6)).toEqual({ kind: 'command', query: 'model', start: 0 });
  });
```

(e) Строки 44-47. Удалить тест «модель: без пробела — человек жмёт Enter сам»: вставок модели больше нет, а вставку без хвостового пробела закрывает тест «каталог — «@src/» без пробела, подсказки продолжаются».

- [ ] **Step 3: Прогон — красные**

Run:
```bash
pnpm --filter @parley/desktop exec vitest run src/renderer/chat/ChatView.test.tsx src/renderer/chat/suggestions.test.ts
```
Expected:
- `suggestions.test.ts`: `expected { kind: 'model', query: '', start: 0 } to be null`.
- `ChatView.test.tsx`, новый `describe`: `expected 'Switch model' to be 'Opus · Extra high'` (сейчас кнопка — прежнее меню) и `Unable to find an element by: [data-testid="chat-model-label"]`. Тесты с `S.chat.choice.*` падают с `TypeError: Cannot read properties of undefined (reading 'effortReset')`.
- тест `/model ` падает: открыт список с `/model opus`.
- «старый хост без sessions.setModel/setEffort» и «хост знает только один из двух методов» падают с `expected 'BUTTON' to be 'SPAN'`: сейчас любой провайдер с моделями получает прежнее меню `/model`.
- «у провайдера ни моделей, ни effort» зелёный и до правки, и после.

- [ ] **Step 4: Строки меню и действий**

`packages/desktop/src/shared/strings.ts`:

(a) Строка 771. Было:

```ts
    /** Подсказки поля ввода: команды, скиллы, модели, `@`-файлы и субагенты (живая проверка 2026-10-02). */
```

Стало:

```ts
    /** Подсказки поля ввода: команды, скиллы, `@`-файлы и субагенты (живая проверка 2026-10-02). */
```

(b) Строки 778-780. Было:

```ts
    model: 'Model',
    /** Меню моделей в тулбаре: выбор уходит в CLI текстом `/model <id>` (живая проверка 2026-10-02). */
    modelMenu: { label: 'Switch model' },
```

Стало:

```ts
    model: 'Model',
    /**
     * Кнопка «модель · effort» в тулбаре и её меню (нормалайзер модели и effort 2026-10-06, 5.9): выбор уходит
     * `sessions.setModel` / `sessions.setEffort` и не пишется в настройки CLI. Причина неактивных пунктов — строкой под
     * заголовком раздела: у неактивного пункта нет событий указателя, тултип не всплыл бы.
     */
    choice: {
      label: 'Model and effort',
      default: 'Default',
      model: 'Model',
      effort: 'Effort',
      agentWorking: 'Wait until the agent is idle',
      backgroundTasks: 'Wait until the background tasks finish',
      /** Хост отказал `conflict` с причиной `busy`: агент занят, в поле терминала черновик, идёт другая смена. */
      sessionBusy: 'The session is busy: try again when the agent is idle and the terminal input is empty',
      notLive: 'Effort changes only while the session runs',
      /** Хост не увидел выбранный уровень в подвале: поставить его может только человек в терминале. */
      openTerminal: 'Open the terminal to change the effort',
      /** `sessions.setModel` вернул effort `null`: у новой модели нет уровня, выбранного раньше. */
      effortReset: (model: string, level: string): string => `${model} has no ${level} effort — effort is back to Default`,
    },
```

(c) Строка 1106. Было:

```ts
      switchMode: 'switch the mode',
```

Стало:

```ts
      switchMode: 'switch the mode',
      switchModel: 'switch the model',
      switchEffort: 'change the effort',
```

- [ ] **Step 5: `ChatToolbar.tsx` — меню «модель · effort»**

Заменить `packages/desktop/src/renderer/chat/ChatToolbar.tsx` целиком:

```tsx
/**
 * Тулбар вкладки сессии (план 2026-10-01, Task 3, п. 4): сегмент «Chat | Terminal». Есть в обоих
 * видах — в терминале он над поверхностью (`TerminalSurface` с отступом `TAB_TOOLBAR_PX`), иначе
 * вернуться в чат можно было бы только палитрой. Выбор пишется полем `view` вкладки в раскладку и
 * переживает перезапуск. Вид «Chat» сессии недоступен (Codex, старый `claude`) — сегмент выключен с
 * подсказкой. В виде «Chat» справа — меню режима разрешений (кусок 4a, решение 9: подпись текущего
 * режима из ленты, пункты Manual / Accept edits / Plan; выбор уходит `sessions.setMode` из `ChatView`)
 * и кнопка «модель · effort» (нормалайзер модели и effort 2026-10-06, 5.9): меню из двух разделов — модели провайдера
 * и уровни модели из карты, выбор уходит `sessions.setModel` / `sessions.setEffort` из `ChatView`; у хоста без этих
 * методов — подпись модели простым текстом («Stop» ушёл в поле ввода).
 * Левее них, пока в ленте есть работающие карточки агентов, — «N agents running» (кусок 4b): клик ведёт ленту к первой из
 * них. Высота фиксирована и строки не переносятся: от неё зависит отступ поверхности терминала.
 */

import { ChevronDown, LoaderCircle } from 'lucide-react';

import type { EffortOption, ModelOption } from '@parley/protocol';
import type { TerminalView } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { useLayoutStore } from '../layout/store.js';
import { updateTab } from '../layout/tree.js';
import { Button } from '../ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.js';

/** Высота тулбара: на столько поверхность терминала опускается под ним. */
export const TAB_TOOLBAR_PX = 36;

/**
 * Режимы меню: значения `sessions.setMode` и подписи. Auto — когда модель его даёт (у модели без auto
 * хост обойдёт круг и ответит `verified: false`); обход разрешений человек выбирает в терминале.
 */
const MODE_ITEMS = [
  { value: 'default', label: S.chat.mode.manual },
  { value: 'acceptEdits', label: S.chat.mode.acceptEdits },
  { value: 'plan', label: S.chat.mode.plan },
  { value: 'auto', label: S.chat.mode.auto },
] as const;

export type ModeChoice = (typeof MODE_ITEMS)[number]['value'];

/** Подпись режима на триггере: известные — по-человечески, прочие — сырой строкой CLI, неизвестный — «Mode». */
export function modeLabel(mode: string | null): string {
  if (mode === null) return S.chat.mode.unknown;
  return MODE_ITEMS.find((item) => item.value === mode)?.label ?? mode;
}

export interface ModeMenuProps {
  /** Текущий режим ленты (сырая строка CLI); `null` — неизвестен. */
  mode: string | null;
  /** Запрос смены в пути или сессия не живая — меню выключено. */
  busy: boolean;
  onSelect: (mode: ModeChoice) => void;
}

/**
 * Меню «модель · effort» (нормалайзер модели и effort 2026-10-06, 5.9). Пункта «Default» в разделе уровней нет:
 * `/effort auto` в идущей сессии стёр бы уровень, сохранённый человеком (спека 5.7, п. 5).
 */
export interface ChoiceMenuProps {
  /** Модели провайдера; пусто — раздела моделей нет. */
  models: readonly ModelOption[];
  /** Модель из карты (`WorkSession.model`) — отмеченный пункт; `null` — «Default», ничего не отмечено. */
  model: string | null;
  /** Подпись модели на кнопке: из ленты, иначе из карты, иначе «Default». */
  modelLabel: string;
  /** Уровни модели из карты (`effortChoices`); `null` — раздела уровней нет. */
  efforts: readonly EffortOption[] | null;
  /** Уровень из карты (`WorkSession.effort`); `null` — «Default». */
  effort: string | null;
  /** Почему пункты моделей неактивны; `null` — активны. */
  modelDisabled: string | null;
  /** Почему пункты уровней неактивны; `null` — активны. */
  effortDisabled: string | null;
  /** Запрос смены в пути — кнопка выключена. */
  busy: boolean;
  onSelectModel: (id: string) => void;
  onSelectEffort: (id: string) => void;
}

export interface ChatToolbarProps {
  workKey: string;
  tabId: string;
  /** Вид, который вкладка показывает сейчас (`effectiveView`). */
  view: TerminalView;
  /** Вид «Chat» доступен сессии; нет — сегмент выключен. */
  available: boolean;
  /** Меню режима; нет — не показывается (вид терминала или хост без `sessions.setMode`). */
  modeMenu?: ModeMenuProps;
  /** Подпись модели без меню (хост без `sessions.setModel`/`setEffort`); `null` или нет — не показывается. */
  model?: string | null;
  /** Меню «модель · effort»; есть — вместо подписи модели. */
  choiceMenu?: ChoiceMenuProps;
  /** Сколько карточек агентов ещё работает; нет — кнопки «N agents running» нет. Клик ведёт ленту к первой из них. */
  agents?: { running: number; onShow: () => void };
}

const ITEM = 'h-6 whitespace-nowrap px-2.5 text-xs';
/** Причина неактивных пунктов раздела — строкой под его заголовком. */
const REASON = 'px-2 pb-1 text-xs text-muted-foreground';

/** Уровень на кнопке: подпись из списка, незнакомый id — как есть, выбора нет — «Default»; уровней у модели нет — ничего. */
function effortText(menu: ChoiceMenuProps): string | null {
  if (menu.effort === null) return menu.efforts === null ? null : S.chat.choice.default;
  return menu.efforts?.find((level) => level.id === menu.effort)?.label ?? menu.effort;
}

function ChoiceMenu({ menu }: { menu: ChoiceMenuProps }): JSX.Element {
  const effort = effortText(menu);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={menu.busy}>
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid="chat-model"
          aria-label={S.chat.choice.label}
          title={effort === null ? menu.modelLabel : `${menu.modelLabel} · ${effort}`}
          className="min-w-0 max-w-[40%] shrink"
        >
          {/* Длинная модель обрезается многоточием, уровень виден всегда: он короткий, и его меняют чаще. */}
          <span data-testid="chat-model-label" className="min-w-0 truncate">
            {menu.modelLabel}
          </span>
          {effort === null ? null : (
            <span data-testid="chat-effort-label" className="shrink-0">
              · {effort}
            </span>
          )}
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {menu.models.length === 0 ? null : (
          <>
            <DropdownMenuLabel>{S.chat.choice.model}</DropdownMenuLabel>
            {menu.modelDisabled === null ? null : (
              <p data-testid="chat-model-reason" className={REASON}>
                {menu.modelDisabled}
              </p>
            )}
            <DropdownMenuRadioGroup value={menu.model ?? ''} onValueChange={menu.onSelectModel}>
              {menu.models.map((option) => (
                <DropdownMenuRadioItem
                  key={option.id}
                  value={option.id}
                  disabled={menu.modelDisabled !== null}
                  data-testid="chat-model-option"
                  data-model={option.id}
                >
                  {option.label === '' ? option.id : option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
        {menu.efforts === null ? null : (
          <>
            {menu.models.length === 0 ? null : <DropdownMenuSeparator />}
            <DropdownMenuLabel>{S.chat.choice.effort}</DropdownMenuLabel>
            {menu.effortDisabled === null ? null : (
              <p data-testid="chat-effort-reason" className={REASON}>
                {menu.effortDisabled}
              </p>
            )}
            <DropdownMenuRadioGroup value={menu.effort ?? ''} onValueChange={menu.onSelectEffort}>
              {menu.efforts.map((level) => (
                <DropdownMenuRadioItem
                  key={level.id}
                  value={level.id}
                  disabled={menu.effortDisabled !== null}
                  data-testid="chat-effort-option"
                  data-effort={level.id}
                >
                  {level.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ChatToolbar({ workKey, tabId, view, available, model = null, modeMenu, choiceMenu, agents }: ChatToolbarProps): JSX.Element {
  const choose = (value: string): void => {
    // Повторный клик по выбранному снял бы выбор: пустое значение пропускаем.
    if (value !== 'chat' && value !== 'terminal') return;
    useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId, { view: value }));
  };
  return (
    <div
      data-testid="chat-toolbar"
      className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-2"
      style={{ height: TAB_TOOLBAR_PX }}
    >
      {/* `title` — на обёртке: у выключенных кнопок нет событий указателя, подсказка не всплыла бы. */}
      <span title={available ? undefined : S.chat.terminalOnly} className="inline-flex">
        <ToggleGroup
          type="single"
          size="sm"
          aria-label={S.chat.viewLabel}
          value={view}
          disabled={!available}
          onValueChange={choose}
        >
          <ToggleGroupItem value="chat" className={ITEM}>
            {S.chat.segment.chat}
          </ToggleGroupItem>
          <ToggleGroupItem value="terminal" className={ITEM}>
            {S.chat.segment.terminal}
          </ToggleGroupItem>
        </ToggleGroup>
      </span>
      <span className="min-w-0 flex-1" />
      {agents === undefined ? null : (
        <Button type="button" size="xs" variant="outline" data-testid="chat-agents-running" onClick={agents.onShow} className="shrink-0">
          <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {S.chat.agent.running(agents.running)}
        </Button>
      )}
      {modeMenu === undefined ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={modeMenu.busy}>
            <Button
              type="button"
              size="xs"
              variant="outline"
              data-testid="chat-mode"
              aria-label={S.chat.mode.label}
              title={S.chat.mode.label}
              className="shrink-0"
            >
              {modeLabel(modeMenu.mode)}
              <ChevronDown className="size-3" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={modeMenu.mode ?? ''}
              onValueChange={(value) => {
                const item = MODE_ITEMS.find((candidate) => candidate.value === value);
                if (item !== undefined) modeMenu.onSelect(item.value);
              }}
            >
              {MODE_ITEMS.map((item) => (
                <DropdownMenuRadioItem key={item.value} value={item.value} data-testid="chat-mode-option" data-mode={item.value}>
                  {item.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {choiceMenu === undefined ? (
        model === null ? null : (
          <span data-testid="chat-model" title={S.chat.model} className="min-w-0 max-w-[40%] truncate text-xs text-muted-foreground">
            {model}
          </span>
        )
      ) : (
        <ChoiceMenu menu={choiceMenu} />
      )}
    </div>
  );
}
```

- [ ] **Step 6: `ChatView.tsx` — подключение меню**

`packages/desktop/src/renderer/chat/ChatView.tsx`:

(a) Шапка, строки 30-35. Было:

```ts
 * Подсказки и вложения поля ввода (живая проверка 2026-10-02): команды, скиллы и субагенты берутся у хоста
 * (`capabilities-store.ts`), модели — из провайдера, файлы — из рабочей папки сессии (`files.list`). Файлы,
```

Стало:

```ts
 * Меню «модель · effort» (нормалайзер модели и effort 2026-10-06, 5.9): подпись модели — из ленты, иначе из карты
 * (`WorkSession.model` подписью каталога), уровень — из карты; пункты — модели провайдера и уровни модели из карты
 * (`effortChoices`). Выбор уходит `sessions.setModel` (хост перезапускает живую сессию через resume) и
 * `sessions.setEffort` (ползунок `/effort` с клавишей `s`): ни текста `/model`, ни записи в настройки CLI. Хост без
 * обоих методов — меню нет. Пункты неактивны, пока агент работает или его держат фоновые задачи, уровни — ещё и у
 * неживой сессии.
 *
 * Подсказки и вложения поля ввода (живая проверка 2026-10-02): команды, скиллы и субагенты берутся у хоста
 * (`capabilities-store.ts`), файлы — из рабочей папки сессии (`files.list`). Файлы,
```

(b) Импорты. Строка 44. Было:

```ts
import { refKey, type ModelOption, type SessionRef } from '@parley/protocol';
```

Стало:

```ts
import { HOST_ERROR_REASONS, refKey, type ModelOption, type SessionRef } from '@parley/protocol';
```

После строки 52 (`import { cn } from '../lib/cn.js';`) добавить:

```ts
import { effortChoices } from '../lib/effort-choices.js';
```

Строка 53. Было:

```ts
import { activityFor, useActivityStore } from '../store/activity.js';
```

Стало:

```ts
import { activityFor, useActivityStore, type ActivityEntry } from '../store/activity.js';
```

(c) Пропсы, строки 84-85. Было:

```ts
  /** Провайдер сессии: по нему берётся список моделей для меню. */
  provider: string;
}
```

Стало:

```ts
  /** Провайдер сессии: по нему берутся модели и уровни для меню «модель · effort». */
  provider: string;
  /** Модель из карты (`WorkSession.model`); `null` — «Default», без флага. */
  storedModel: string | null;
  /** Уровень effort из карты (`WorkSession.effort`); `null` — «Default», без флага. */
  storedEffort: string | null;
}
```

(d) После строки 111 (`const NO_PATHS: readonly string[] = [];`) добавить:

```ts

/** Подпись модели по каталогу провайдера; нет в каталоге или подпись пустая — сам id. */
function modelCaption(models: readonly ModelOption[], id: string): string {
  const label = models.find((option) => option.id === id)?.label;
  return label === undefined || label === '' ? id : label;
}

/**
 * Чем занята сессия для меню «модель · effort» — по тем же признакам хост ответит отказом (спека 5.7, 5.8): агент
 * работает сам или ждёт человека — `agent`; ход окончен, а держат фоновые задачи — `background`; иначе (`idle`,
 * `unseen`, активность ещё неизвестна) — `idle`.
 */
function occupation(activity: ActivityEntry['activity'] | undefined): 'idle' | 'agent' | 'background' {
  if (activity === undefined) return 'idle';
  if (activity.activity === 'blocked' || (activity.activity === 'working' && !activity.heldByBackground)) return 'agent';
  return activity.heldByBackground || activity.tasks.some((task) => task.background) ? 'background' : 'idle';
}

/**
 * Отказ смены модели или уровня. `conflict` с причиной `busy` — сессия занята (так отвечает хост: агент работает, держат
 * фоновые задачи, в поле терминала черновик, открыт ползунок, идёт другая смена); прочее — общий текст по коду.
 */
function choiceFailed(method: string, action: string, error: unknown): void {
  const { code, message, data } = decodeIpcError(error);
  console.warn(`[parley] ${method}`, message);
  const busy = code === 'conflict' && data?.['reason'] === HOST_ERROR_REASONS.busy;
  toast.error(busy ? S.chat.choice.sessionBusy : errorText(code, action));
}
```

(e) Начало компонента. Было — со слитым 0.5.3:

```tsx
export function ChatView({ workKey, tab, sessionRef, visible, live, bridge, sendDeps, provider }: ChatViewProps): JSX.Element {
  const feed = useFeed(sessionRef);
  const items = feed?.items ?? NO_ITEMS;
  const active = live && turnActive(items);
  const model = currentModel(items);
  const blocked = useActivityStore((state) => activityFor(state.byRef, sessionRef)?.activity.activity === 'blocked');
  const waiting = blocked && !hasPendingCard(items);
  const showBanner = useHeldFor(waiting, BANNER_DELAY_MS);
  const canSetMode = useHostSupports('sessions.setMode');
  const canInterrupt = useHostSupports('feed.interrupt');
  const [modeBusy, setModeBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const providerModels = useProvidersStore((state) => state.providers.find((item) => item.id === provider)?.models) ?? NO_MODELS;
  // Смена модели из чата — текст `/model <id>`, а интерактивный Claude Code сохраняет его моделью по
  // умолчанию в общих настройках `~/.claude`. У GLM это id Z.ai: обычные сессии Claude уйдут с ним
  // в Anthropic и упадут. Пока нет смены «только для этой сессии», у GLM нет ни меню, ни подсказок.
  const modelOptions = provider === 'glm' ? NO_MODELS : providerModels;
```

(без хотфикса последние пять строк — одна: `const modelOptions = useProvidersStore((state) => state.providers.find((item) => item.id === provider)?.models) ?? NO_MODELS;`)

Стало:

```tsx
export function ChatView({ workKey, tab, sessionRef, visible, live, bridge, sendDeps, provider, storedModel, storedEffort }: ChatViewProps): JSX.Element {
  const feed = useFeed(sessionRef);
  const items = feed?.items ?? NO_ITEMS;
  const active = live && turnActive(items);
  const blocked = useActivityStore((state) => activityFor(state.byRef, sessionRef)?.activity.activity === 'blocked');
  const waiting = blocked && !hasPendingCard(items);
  const showBanner = useHeldFor(waiting, BANNER_DELAY_MS);
  const canSetMode = useHostSupports('sessions.setMode');
  const canInterrupt = useHostSupports('feed.interrupt');
  const canSetModel = useHostSupports('sessions.setModel');
  const canSetEffort = useHostSupports('sessions.setEffort');
  const [modeBusy, setModeBusy] = useState(false);
  const [choiceBusy, setChoiceBusy] = useState(false);
  const providerInfo = useProvidersStore((state) => state.providers.find((item) => item.id === provider));
  const models = providerInfo?.models ?? NO_MODELS;
  // Уровни модели из карты — тот же список, по которому хост проверит выбор; модели в карте нет — уровни «Default».
  const efforts = effortChoices(providerInfo, storedModel);
  // Подпись модели: что CLI запустил на деле (лента), иначе выбор из карты подписью каталога.
  const modelLabel = currentModel(items) ?? (storedModel === null ? null : modelCaption(models, storedModel));
  const occupied = useActivityStore((state) => occupation(activityFor(state.byRef, sessionRef)?.activity));
  const busyReason = occupied === 'agent' ? S.chat.choice.agentWorking : occupied === 'background' ? S.chat.choice.backgroundTasks : null;
  // Модель неживой сессии меняется только в карте (хост ответит `restarted: false`), уровень — только у живой: его ставит
  // ползунок самого CLI.
  const modelDisabled = live ? busyReason : null;
  const effortDisabled = live ? busyReason : S.chat.choice.notLive;
  const showChoice = canSetModel && canSetEffort && (models.length > 0 || efforts !== null);
```

(f) Строки 162-165. Было:

```tsx
  const suggestionSource = useMemo<SuggestionSource>(
    () => ({ capabilities, models: modelOptions, listDir }),
    [capabilities, modelOptions, listDir],
  );
```

Стало:

```tsx
  const suggestionSource = useMemo<SuggestionSource>(() => ({ capabilities, listDir }), [capabilities, listDir]);
```

(g) Строки 226-230. Было:

```tsx
  const selectModel = (id: string): void => {
    if (modelBusy || !live) return;
    setModelBusy(true);
    void sendWithToast(sendDeps, sessionRef, `/model ${id}`, true, { silentSuccess: true }).finally(() => setModelBusy(false));
  };
```

Стало:

```tsx
  // Модель: хост пишет её в карту и, если сессия живая, перезапускает её через resume с флагами из карты (спека 5.8).
  const selectModel = (id: string): void => {
    if (choiceBusy || modelDisabled !== null || id === storedModel) return;
    setChoiceBusy(true);
    bridge
      .call('sessions.setModel', { ref: sessionRef, model: id })
      .then((result) => {
        // Уровня из карты у новой модели нет — хост вернул «Default»; человек выбирал уровень сам и должен об этом узнать.
        if (storedEffort !== null && result.effort === null) {
          const level = efforts?.find((option) => option.id === storedEffort)?.label ?? storedEffort;
          toast(S.chat.choice.effortReset(modelCaption(models, id), level));
        }
      })
      .catch((error: unknown) => choiceFailed('sessions.setModel', S.errors.actions.switchModel, error))
      .finally(() => setChoiceBusy(false));
  };

  // Уровень: хост ставит его ползунком `/effort` с клавишей `s` — «только для этой сессии» — и сверяет подвал (спека 5.7).
  const selectEffort = (id: string): void => {
    if (choiceBusy || effortDisabled !== null || id === storedEffort) return;
    setChoiceBusy(true);
    bridge
      .call('sessions.setEffort', { ref: sessionRef, effort: id })
      .then((result) => {
        if (!result.verified) toast(S.chat.choice.openTerminal);
      })
      .catch((error: unknown) => choiceFailed('sessions.setEffort', S.errors.actions.switchEffort, error))
      .finally(() => setChoiceBusy(false));
  };
```

(h) Строки 311-313 (пропсы `<ChatToolbar …>`). Было:

```tsx
          model={model}
          {...(canSetMode ? { modeMenu: { mode: feed?.mode ?? null, busy: modeBusy || !live, onSelect: setMode } } : {})}
          {...(modelOptions.length > 0 ? { modelMenu: { options: modelOptions, busy: modelBusy || !live, onSelect: selectModel } } : {})}
```

Стало:

```tsx
          model={modelLabel}
          {...(canSetMode ? { modeMenu: { mode: feed?.mode ?? null, busy: modeBusy || !live, onSelect: setMode } } : {})}
          {...(showChoice
            ? {
                choiceMenu: {
                  models,
                  model: storedModel,
                  modelLabel: modelLabel ?? S.chat.choice.default,
                  efforts,
                  effort: storedEffort,
                  modelDisabled,
                  effortDisabled,
                  busy: choiceBusy,
                  onSelectModel: selectModel,
                  onSelectEffort: selectEffort,
                },
              }
            : {})}
```

`packages/desktop/src/renderer/layout/bodies/TerminalBody.tsx`, строки 41-50. Было:

```tsx
        sendDeps={sendDeps}
        provider={session.provider}
      />
```

Стало:

```tsx
        sendDeps={sendDeps}
        provider={session.provider}
        storedModel={session.model ?? null}
        storedEffort={session.effort ?? null}
      />
```

- [ ] **Step 7: Подсказки без `/model <id>`**

Заменить `packages/desktop/src/renderer/chat/suggestions.ts` целиком:

```ts
/**
 * Подсказки поля ввода «Chat» — чистая логика без React (живая проверка 2026-10-02): по тексту и
 * каретке понять, что человек сейчас набирает (слеш-команду или `@`-упоминание), и вставить
 * выбранное. Окно только подставляет текст в поле — разбирает его сам CLI, автоответов нет. Подсказок
 * `/model <id>` нет (нормалайзер модели и effort 2026-10-06): набранный `/model` Claude Code сохраняет
 * моделью по умолчанию для новых сессий, а меню тулбара меняет модель только этой сессии.
 */

export type SuggestionContext =
  | { kind: 'command'; query: string; start: number }
  | { kind: 'mention'; query: string; start: number };

/**
 * Что набирает человек перед кареткой: `null` — подсказок нет. Слеш-команда — только когда весь текст
 * до каретки это `/слово`; `@` в начале слова — субагент или файл.
 */
export function suggestionContext(text: string, caret: number): SuggestionContext | null {
  const before = text.slice(0, caret);
  const command = /^\/([\w:.-]*)$/.exec(before);
  if (command !== null) return { kind: 'command', query: command[1] ?? '', start: 0 };
  const mention = /(^|\s)@(\S*)$/.exec(before);
  if (mention !== null) {
    const query = mention[2] ?? '';
    return { kind: 'mention', query, start: caret - query.length - 1 };
  }
  return null;
}

/**
 * Заменяет набранный токен (от `context.start` до каретки) готовой вставкой — вместе с `/` или `@` и
 * хвостовым пробелом, если он нужен. Каретка встаёт сразу после вставки. Пробел вставки не удваивается,
 * если текст после каретки уже начинается с пробела.
 */
export function applySuggestion(
  text: string,
  caret: number,
  context: SuggestionContext,
  insert: string,
): { text: string; caret: number } {
  const rest = text.slice(caret);
  const tail = insert.endsWith(' ') && rest.startsWith(' ') ? rest.slice(1) : rest;
  return { text: `${text.slice(0, context.start)}${insert}${tail}`, caret: context.start + insert.length };
}
```

`packages/desktop/src/renderer/chat/use-suggestions.ts`:

Строки 1-12. Было:

```ts
/**
 * Строки подсказок поля ввода «Chat» (живая проверка 2026-10-02) по контексту из `suggestions.ts`:
 * `/` — команды и скиллы CLI, `/model ` — модели провайдера, `@` — субагенты и файлы рабочей папки
 * сессии. Файлы дополняются по сегментам пути: по `src/comp` читается каталог `src` (`files.list`) и
 * берутся записи на `comp`; тот же каталог при дальнейшем наборе заново не читается. Не больше 12 строк.
 */

import { useEffect, useState } from 'react';
import type { Capabilities, ModelOption } from '@parley/protocol';
```

Стало:

```ts
/**
 * Строки подсказок поля ввода «Chat» (живая проверка 2026-10-02) по контексту из `suggestions.ts`:
 * `/` — команды и скиллы CLI, `@` — субагенты и файлы рабочей папки сессии. Файлы дополняются по
 * сегментам пути: по `src/comp` читается каталог `src` (`files.list`) и берутся записи на `comp`; тот же
 * каталог при дальнейшем наборе заново не читается. Не больше 12 строк.
 */

import { useEffect, useState } from 'react';
import type { Capabilities } from '@parley/protocol';
```

Строки 21-34. Было:

```ts
  /** Что встанет в поле целиком (токен заменяется им): `/clear `, `/model opus`, `@notes.txt `. */
  insert: string;
```

и

```ts
export interface SuggestionSource {
  capabilities: Capabilities | null;
  models: readonly ModelOption[];
  /** Записи каталога корня сессии (`files.list`); `''` — корень. */
  listDir: (dir: string) => Promise<DirEntry[]>;
}
```

Стало:

```ts
  /** Что встанет в поле целиком (токен заменяется им): `/clear `, `@notes.txt `. */
  insert: string;
```

и

```ts
export interface SuggestionSource {
  capabilities: Capabilities | null;
  /** Записи каталога корня сессии (`files.list`); `''` — корень. */
  listDir: (dir: string) => Promise<DirEntry[]>;
}
```

Строки 74-79. Удалить целиком `function modelItems(models: readonly ModelOption[], query: string): SuggestionItem[] { … }`.

Строка 140. Удалить:

```ts
  if (context.kind === 'model') return modelItems(source.models, context.query).slice(0, MAX_SUGGESTIONS);
```

`packages/desktop/src/renderer/chat/Composer.tsx`, строки 11-13. Было:

```ts
 * Подсказки (живая проверка 2026-10-02): `/` — команды и скиллы, `/model ` — модели, `@` — субагенты и
 * файлы; попап над полем (`SuggestionList`), ↑/↓ выбирают, Enter и Tab принимают (Enter тогда не отправляет),
 * Esc закрывает. Окно только вставляет текст — разбирает его CLI.
```

Стало:

```ts
 * Подсказки (живая проверка 2026-10-02): `/` — команды и скиллы, `@` — субагенты и файлы; попап над полем
 * (`SuggestionList`), ↑/↓ выбирают, Enter и Tab принимают (Enter тогда не отправляет), Esc закрывает. Окно
 * только вставляет текст — разбирает его CLI. Подсказок `/model <id>` нет: модель меняет меню тулбара.
```

- [ ] **Step 8: Прогон — зелёные; стражи и типы**

Run:
```bash
pnpm --filter @parley/desktop exec vitest run src/renderer/chat src/renderer/layout src/english-ui.test.ts
grep -n "provider === 'glm'\|/model \${" packages/desktop/src/renderer/chat/ChatView.tsx
```
Expected: PASS, все файлы; `grep` ничего не печатает: строки хотфикса и отправки `/model` больше нет.

Run:
```bash
pnpm --filter @parley/core exec vitest run test/frame-check.test.ts
pnpm typecheck && pnpm exec eslint packages/desktop/src/renderer/chat packages/desktop/src/renderer/layout packages/desktop/src/shared
```
Expected:
- страж рамки PASS: путей настроек `~/.claude` в новых комментариях нет;
- `pnpm typecheck` без ошибок;
- `ModelMenuProps`, `S.chat.modelMenu`, `modelBusy` и отправка `/model` через `sendWithToast` удалены; сам `sendWithToast` по-прежнему импортирован для `submit`.

- [ ] **Step 9: Коммит**

```bash
git add packages/desktop/src/renderer/chat/ChatToolbar.tsx packages/desktop/src/renderer/chat/ChatView.tsx packages/desktop/src/renderer/chat/ChatView.test.tsx packages/desktop/src/renderer/chat/suggestions.ts packages/desktop/src/renderer/chat/suggestions.test.ts packages/desktop/src/renderer/chat/use-suggestions.ts packages/desktop/src/renderer/chat/Composer.tsx packages/desktop/src/renderer/layout/bodies/TerminalBody.tsx packages/desktop/src/shared/strings.ts
git commit -m "feat(desktop): меню «модель · effort» в чате через sessions.setModel и sessions.setEffort, без /model" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Окно — карточка провайдера объясняет аргументы запуска из providers.json

**Files:**
- Modify: `packages/desktop/src/renderer/components/providers/ProviderCard.tsx:239-242`
- Modify: `packages/desktop/src/renderer/components/providers/ProviderCard.test.tsx` — импорты 3-10, новый `describe` в конце файла
- Modify: `packages/desktop/src/shared/strings.ts:227`

**Interfaces:**
- Consumes: элементы `providers.list` с `argsOverridden?: boolean` (тип — Task 6; хост ставит поле с Task 8, когда `args` пришли из `providers.json`, Task 3), `models?: ModelOption[] | null`, `effort?: boolean`.
- Produces:
  - `S.providerCard.argsOverridden`, `S.providerCard.noModelChoice`, `S.providerCard.noEffortChoice`;
  - блок `data-testid="provider-args"` в `ProviderCard` — только при `argsOverridden === true`.

- [ ] **Step 1: Тест**

`packages/desktop/src/renderer/components/providers/ProviderCard.test.tsx`: после строки 5 (`import { encodeIpcError } from '../../../shared/ipc-error.js';`) добавить

```ts
import { S } from '../../../shared/strings.js';
```

и дописать в конец файла:

```tsx
describe('ProviderCard: аргументы запуска из providers.json (нормалайзер модели и effort 2026-10-06, 5.9)', () => {
  const codex = (patch: Partial<Provider> = {}): Provider => ({ id: 'codex', label: 'Codex', available: true, version: 'codex-cli 0.160.0', ...patch });
  const renderCard = (provider: Provider): void => {
    render(<ProviderCard provider={provider} onReload={async () => {}} onRestartHost={() => {}} />);
  };

  it('args заменены и в них нет {model} и {effort} — строка про providers.json и почему выбора нет', () => {
    renderCard(codex({ argsOverridden: true, models: null, effort: false }));
    expect(screen.getByText('Launch arguments come from providers.json.')).toBeTruthy();
    expect(screen.getByText('No model choice: these arguments have no {model}.')).toBeTruthy();
    expect(screen.getByText('No effort choice: these arguments have no {effort}.')).toBeTruthy();
  });

  it('args заменены, выбор есть — только строка про providers.json', () => {
    renderCard(codex({ argsOverridden: true, models: [{ id: 'gpt-6-luna', label: 'GPT-6-Luna' }], effort: true }));
    expect(screen.getByText(S.providerCard.argsOverridden)).toBeTruthy();
    expect(screen.queryByText(S.providerCard.noModelChoice)).toBeNull();
    expect(screen.queryByText(S.providerCard.noEffortChoice)).toBeNull();
  });

  it('модель есть, effort нет — объяснение только про effort', () => {
    renderCard(codex({ argsOverridden: true, models: [{ id: 'gpt-6-luna', label: 'GPT-6-Luna' }], effort: false }));
    expect(screen.queryByText(S.providerCard.noModelChoice)).toBeNull();
    expect(screen.getByText(S.providerCard.noEffortChoice)).toBeTruthy();
  });

  it('встроенные args (поля нет — и у старого хоста) — ни строки, ни объяснений, даже без выбора', () => {
    renderCard(codex({ models: null, effort: false }));
    expect(screen.queryByTestId('provider-args')).toBeNull();
    expect(screen.queryByText(S.providerCard.noModelChoice)).toBeNull();
    expect(screen.queryByText(S.providerCard.noEffortChoice)).toBeNull();
  });
});
```

- [ ] **Step 2: Прогон — красный**

Run: `pnpm --filter @parley/desktop exec vitest run src/renderer/components/providers/ProviderCard.test.tsx`
Expected:
- первый тест падает с `Unable to find an element with the text: Launch arguments come from providers.json.`;
- остальные — с `TypeError: Cannot read properties of undefined` или на `getByText(undefined)`: ключей `S.providerCard.*` ещё нет;
- последний тест зелёный.

- [ ] **Step 3: Строки**

`packages/desktop/src/shared/strings.ts`, строка 227. Было:

```ts
    checkAgain: 'Check again',
```

Стало:

```ts
    checkAgain: 'Check again',
    /**
     * Аргументы запуска провайдера заменены из `providers.json` (`argsOverridden`, нормалайзер модели и effort 2026-10-06):
     * без `{model}` или `{effort}` в них выбора модели или effort нет — карточка объясняет почему.
     */
    argsOverridden: 'Launch arguments come from providers.json.',
    noModelChoice: 'No model choice: these arguments have no {model}.',
    noEffortChoice: 'No effort choice: these arguments have no {effort}.',
```

- [ ] **Step 4: Карточка**

`packages/desktop/src/renderer/components/providers/ProviderCard.tsx`, строки 239-242. Было:

```tsx
      {provider.version == null ? null : (
        <p className="font-mono text-xs text-muted-foreground">{provider.version}</p>
      )}
      {isGlm ? (
```

Стало:

```tsx
      {provider.version == null ? null : (
        <p className="font-mono text-xs text-muted-foreground">{provider.version}</p>
      )}
      {provider.argsOverridden === true ? (
        // `args` из providers.json заменили встроенные: выбор модели и effort есть, только если в них `{model}`/`{effort}`.
        <div data-testid="provider-args" className="space-y-0.5 text-xs text-muted-foreground">
          <p>{S.providerCard.argsOverridden}</p>
          {(provider.models ?? []).length === 0 ? <p>{S.providerCard.noModelChoice}</p> : null}
          {provider.effort === true ? null : <p>{S.providerCard.noEffortChoice}</p>}
        </div>
      ) : null}
      {isGlm ? (
```

- [ ] **Step 5: Прогон — зелёный; стражи**

Run:
```bash
pnpm --filter @parley/desktop exec vitest run src/renderer/components/providers src/renderer/shell src/english-ui.test.ts
pnpm --filter @parley/core exec vitest run test/frame-check.test.ts
pnpm typecheck
```
Expected: PASS; `StatusBar.test.tsx` (рисует ту же карточку) зелёный; typecheck без ошибок.

- [ ] **Step 6: Коммит**

```bash
git add packages/desktop/src/renderer/components/providers/ProviderCard.tsx packages/desktop/src/renderer/components/providers/ProviderCard.test.tsx packages/desktop/src/shared/strings.ts
git commit -m "feat(desktop): карточка провайдера — аргументы запуска из providers.json и почему нет выбора" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: E2E и документы — каталог Codex в диалоге, меню чата; README, CHANGELOG, TODOS

**Files:**
- Create: `packages/desktop/e2e/model-effort.spec.ts`
- Create: `packages/desktop/e2e/fixtures/codex-debug-models.json`
- Modify: `packages/desktop/e2e/stub-codex-agent.mjs` — импорты (строки 26-27), после блока `--version` (строки 30-33)
- Modify: `packages/desktop/e2e/stub-echo-agent.mjs` — после строки 98 (`const providerSessionId = …`), между строками 237 (`const PASTE_END`) и 239 (`function typed`), начало цикла `typed`
- Modify: `packages/desktop/e2e/chat-hooks.spec.ts:476, 494-495`
- Modify: `packages/desktop/e2e/providers-connect.spec.ts:221, 293-309`
- Modify: `README.md` — 442-445, 752-754, 770-775, 985, 1026, 1028, 1257, 1323-1363, 1423-1427 (GLM), 1447, 1635-1637
- Modify: `CHANGELOG.md` — `## Unreleased`
- Modify: `TODOS.md` — раздел 4 (строки 155-160), раздел 10

**Interfaces:**
- Consumes:
  - всё из Task 1–14;
  - пробу каталога хоста (Task 8) через `PARLEY_CODEX_BIN`: её, как и пробу версий, выключает `PARLEY_SKIP_VERSION_PROBE=1` (`e2e/global-setup.ts` ставит его всем спекам), а `model-effort.spec.ts` включает (`''`); каталог доходит до `providers.list` через `codex-models.json` в `PARLEY_HOME` спека, событием `providers.changed`;
  - алгоритм `sessions.setEffort` (Task 10), которому должен отвечать стаб: хост печатает `/effort`, отдельно `\r`, ждёт на экране строку с `s for this session only`, жмёт `\x1b[D` (на одно больше, чем уровней), `\x1b[C` до цели и `s`, затем ждёт подвал `<знак> <уровень> · /effort`. Печатать он начинает только после хука процесса (стаб пишет `StubReady` в журнал событий при старте) и при пустом поле ввода — `PtyHandle.hasDraft()` считает ввод человека, а не экран, так что строка приглашения стабу не нужна;
  - подписи каталога (Task 1): `opusplan[1m]` — «Opus Plan (1M context)», `sonnet` — «Sonnet»; уровни `xhigh`, `max`, `ultra` — «Extra high», «Max», «Ultra»; модели Codex — `display_name` самого Codex (`GPT-6.1-Sol`, `GPT-6-Luna`).
- Produces:
  - переменные стаба `stub-echo-agent.mjs`: `STUB_EFFORT_SLIDER=1` (сырой режим — вместе с `STUB_BRACKETED=1`) и `STUB_LAUNCH_LOG=<файл>` — строка на каждый старт процесса: `{ sessionId, model, effort, resume }`;
  - `stub-codex-agent.mjs debug models` печатает `fixtures/codex-debug-models.json` (форма настоящего вывода, `display_name` через дефис) и выходит с 0;
  - документы для людей.

- [ ] **Step 1: E2E-спек и фикстура каталога**

Создать `packages/desktop/e2e/fixtures/codex-debug-models.json`:

```json
{
  "models": [
    {
      "slug": "gpt-6-luna",
      "display_name": "GPT-6-Luna",
      "description": "Stub catalog entry for Parley E2E.",
      "default_reasoning_level": "medium",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "Fast responses with lighter reasoning" },
        { "effort": "medium", "description": "Balances speed and reasoning depth for everyday tasks" },
        { "effort": "high", "description": "Greater reasoning depth for complex problems" },
        { "effort": "xhigh", "description": "Extra high reasoning depth for complex problems" },
        { "effort": "max", "description": "Maximum reasoning depth for the hardest problems" }
      ],
      "visibility": "list",
      "priority": 4,
      "supports_reasoning_effort_updates": true
    },
    {
      "slug": "stub-hidden-helper",
      "display_name": "Stub Hidden Helper",
      "description": "Hidden model: the window must not offer it.",
      "default_reasoning_level": "medium",
      "supported_reasoning_levels": [
        { "effort": "medium", "description": "Balances speed and reasoning depth for everyday tasks" }
      ],
      "visibility": "hide",
      "priority": 2,
      "supports_reasoning_effort_updates": false
    },
    {
      "slug": "gpt-6.1-sol",
      "display_name": "GPT-6.1-Sol",
      "description": "Stub catalog entry for Parley E2E.",
      "default_reasoning_level": "medium",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "Fast responses with lighter reasoning" },
        { "effort": "medium", "description": "Balances speed and reasoning depth for everyday tasks" },
        { "effort": "high", "description": "Greater reasoning depth for complex problems" },
        { "effort": "xhigh", "description": "Extra high reasoning depth for complex problems" },
        { "effort": "max", "description": "Maximum reasoning depth for the hardest problems" },
        { "effort": "ultra", "description": "Maximum reasoning with automatic task delegation" }
      ],
      "visibility": "list",
      "priority": 1,
      "supports_reasoning_effort_updates": true
    }
  ]
}
```

Создать `packages/desktop/e2e/model-effort.spec.ts`:

```ts
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Нормалайзер модели и effort (спека 2026-10-06, раздел 8, строка E2E). Диалог новой сессии показывает модели и уровни
 * Codex из каталога самого CLI и сбрасывает уровень, которого у новой модели нет; меню «модель · effort» в чате зовёт
 * `sessions.setEffort` и `sessions.setModel` хоста, и ни один выбор не идёт текстом `/model`.
 *
 * Настоящие CLI не запускаются. `codex` — `stub-codex-agent.mjs`: на `codex debug models` он печатает урезанный каталог
 * `fixtures/codex-debug-models.json` — две видимые модели не в порядке `priority` и одну скрытую, так что список из
 * каталога не спутать со встроенным (там семь моделей). `claude` — `stub-echo-agent.mjs` с ползунком `/effort`
 * (`STUB_EFFORT_SLIDER=1`, нужен сырой режим `STUB_BRACKETED=1`) и журналом флагов запуска (`STUB_LAUNCH_LOG`).
 * Проба версий и каталога включена (`PARLEY_SKIP_VERSION_PROBE: ''`; `global-setup.ts` выключает её всем): вид Chat
 * доступен только при известной версии `claude`, а каталог Codex хост спрашивает той же пробой.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const stubCodex = path.resolve(dirname, 'stub-codex-agent.mjs');

interface Ref {
  projectPath: string;
  workId: string;
  sessionId: string;
}

interface MapSession {
  id: string;
  provider: string;
  model?: string;
  effort?: string;
}

type Parley = { parley: { call: (method: string, params: unknown) => Promise<unknown> } };

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(
    ({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body),
    { method, params },
  )) as T;
}

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...size }), { width, height });
}

/** Сессии работы из снимка хоста — выбор модели и effort, который хост записал в карту. */
async function sessionsOf(window: Page, workId: string): Promise<MapSession[]> {
  const list = await call<{ entries: Array<{ map: { work: { id: string }; sessions: MapSession[] } }> }>(window, 'works.list', {});
  return list.entries.find((entry) => entry.map.work.id === workId)?.map.sessions ?? [];
}

/** Имена пунктов открытого списка Radix Select: пункт связан со своим `ItemText`, описание второй строкой в имя не входит. */
async function optionNames(window: Page): Promise<string[]> {
  const options = window.getByRole('option');
  await expect(options.first()).toBeVisible();
  return options.evaluateAll((nodes) =>
    nodes.map((node) => document.getElementById(node.getAttribute('aria-labelledby') ?? '')?.textContent ?? ''),
  );
}

/** Старты процесса сессии по журналу стаба `claude`: флаги модели и effort каждого запуска. */
async function launchesOf(file: string, sessionId: string): Promise<Array<{ model: unknown; effort: unknown; resume: unknown }>> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record['sessionId'] === sessionId)
    .map((record) => ({ model: record['model'], effort: record['effort'], resume: record['resume'] }));
}

test.describe('модель и effort: диалог по каталогу Codex и меню чата (нормалайзер 2026-10-06)', () => {
  let home: string;
  let project: string;
  let running: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('model-effort');
    project = await makeTempProject('model-effort');
  });

  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function launch(extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; window: Page; errors: string[] }> {
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubAgent,
      PARLEY_CODEX_BIN: stubCodex,
      PARLEY_GLM_BIN: path.join(home, 'no-glm'),
      PARLEY_SKIP_VERSION_PROBE: '',
      PARLEY_TERMINAL_RENDERER: 'dom',
      ...extraEnv,
    };
    const app = await electron.launch({ args: [mainEntry], env });
    running = app;
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    await resize(app, 1400, 900);
    await expect(window.getByTestId('landing')).toBeVisible();
    return { app, window, errors };
  }

  test('диалог: модели и уровни Codex из `codex debug models`, Ultra у GPT-6.1-Sol, сброс в Default на GPT-6-Luna, окно 800×500', async () => {
    test.setTimeout(90_000);
    const { app, window, errors } = await launch();
    // Хост ответил каталогом стаба: видимые модели по priority, скрытой нет.
    await expect
      .poll(
        async () => {
          const { providers } = await call<{ providers: Array<{ id: string; models?: Array<{ id: string }> | null }> }>(window, 'providers.list', {});
          return providers.find((provider) => provider.id === 'codex')?.models?.map((model) => model.id) ?? null;
        },
        { timeout: 20_000 },
      )
      .toEqual(['gpt-6.1-sol', 'gpt-6-luna']);

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-model-effort', goal: '' });
    await call(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: 'seed', task: '', parent: null });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await window.locator(`[data-work-key="${project} ${workId}"]:not([role="tab"])`).locator('[data-work-title]').first().click();
    await resize(app, 800, 500);

    await window.keyboard.press('Meta+T');
    const dialog = window.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'New session' })).toBeVisible();
    await dialog.getByRole('radiogroup', { name: 'Agent 1' }).getByRole('radio', { name: 'Codex' }).click();
    const model = dialog.getByRole('combobox', { name: 'Model', exact: true });
    const effort = dialog.getByRole('combobox', { name: 'Effort', exact: true });
    await expect(effort).toHaveText('Default');

    await model.click();
    expect(await optionNames(window)).toEqual(['Default', 'GPT-6.1-Sol', 'GPT-6-Luna']);
    await window.getByRole('option', { name: 'GPT-6.1-Sol', exact: true }).click();

    await effort.click();
    expect(await optionNames(window)).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max', 'Ultra']);
    // Описание уровня из каталога — второй строкой пункта.
    await expect(window.getByRole('option', { name: 'Ultra', exact: true })).toContainText('Maximum reasoning with automatic task delegation');
    await window.getByRole('option', { name: 'Extra high', exact: true }).click();
    await expect(effort).toHaveText('Extra high');
    // 800×500: подпись уровня видна целиком, поле — внутри диалога.
    expect(
      await effort.evaluate((trigger) => {
        const dialogBox = trigger.closest('[role="dialog"]')!.getBoundingClientRect();
        const value = trigger.querySelector('span')!;
        return { inside: trigger.getBoundingClientRect().right <= dialogBox.right + 0.5, whole: value.scrollWidth <= value.clientWidth };
      }),
    ).toEqual({ inside: true, whole: true });

    await effort.click();
    await window.getByRole('option', { name: 'Ultra', exact: true }).click();
    await expect(effort).toHaveText('Ultra');
    await model.click();
    await window.getByRole('option', { name: 'GPT-6-Luna', exact: true }).click();
    // У Luna нет Ultra — уровень вернулся в Default, и в списке его нет.
    await expect(effort).toHaveText('Default');
    await effort.click();
    expect(await optionNames(window)).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
    await window.getByRole('option', { name: 'Max', exact: true }).click();

    await dialog.getByRole('button', { name: 'Start session' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    // В карте — ровно явный выбор: его и получит Codex флагами.
    await expect
      .poll(async () => (await sessionsOf(window, workId)).filter((session) => session.provider === 'codex').map((session) => ({ model: session.model, effort: session.effort })), { timeout: 15_000 })
      .toEqual([{ model: 'gpt-6-luna', effort: 'max' }]);
    expect(errors).toEqual([]);
  });

  test('чат: «модель · effort» в окне 800×500, уровень — ползунком /effort, модель — перезапуском с флагами из карты', async () => {
    test.setTimeout(120_000);
    const launchLog = path.join(home, 'launches.jsonl');
    const { app, window, errors } = await launch({ STUB_BRACKETED: '1', STUB_EFFORT_SLIDER: '1', STUB_LAUNCH_LOG: launchLog });
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-chat-choice', goal: '' });
    const { ref } = await call<{ ref: Ref }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'choice',
      task: '',
      parent: null,
      model: 'opusplan[1m]',
      effort: 'xhigh',
    });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await window.locator(`[data-session-id="${ref.sessionId}"]`).click();
    const chat = window.getByTestId('chat-view');
    await expect(chat).toBeVisible({ timeout: 20_000 });
    const button = chat.getByTestId('chat-model');
    await expect(button).toHaveAttribute('title', 'Opus Plan (1M context) · Extra high');

    // 800×500: длинная модель обрезается многоточием, уровень виден целиком, кнопка не выходит за тулбар.
    await resize(app, 800, 500);
    await expect(chat).toBeVisible();
    expect(
      await button.evaluate((trigger) => {
        const bar = trigger.closest('[data-testid="chat-toolbar"]')!.getBoundingClientRect();
        const level = trigger.querySelector('[data-testid="chat-effort-label"]')!;
        return { inside: trigger.getBoundingClientRect().right <= bar.right + 0.5, whole: level.scrollWidth <= level.clientWidth };
      }),
    ).toEqual({ inside: true, whole: true });
    await resize(app, 1400, 900);

    // Уровень: хост открывает ползунок стаба, ставит Max стрелками и `s`, сверяет подвал; карта и кнопка — Max.
    await button.click();
    await expect(window.getByTestId('chat-effort-option')).toHaveCount(5);
    await window.locator('[data-testid="chat-effort-option"][data-effort="max"]').click();
    await expect(button).toHaveAttribute('title', 'Opus Plan (1M context) · Max', { timeout: 15_000 });
    expect((await sessionsOf(window, workId)).find((session) => session.id === ref.sessionId)).toMatchObject({ model: 'opusplan[1m]', effort: 'max' });

    // Модель: хост перезапускает сессию с флагами из карты — второй старт стаба с --model sonnet и тем же уровнем.
    await button.click();
    await window.locator('[data-testid="chat-model-option"][data-model="sonnet"]').click();
    await expect(button).toHaveAttribute('title', 'Sonnet · Max', { timeout: 20_000 });
    // Транскрипта у стаба нет — хост поднимает тот же id заново, а не `--resume`; флаги те же, из карты.
    await expect
      .poll(() => launchesOf(launchLog, ref.sessionId), { timeout: 20_000 })
      .toEqual([
        { model: 'opusplan[1m]', effort: 'xhigh', resume: false },
        { model: 'sonnet', effort: 'max', resume: false },
      ]);
    expect(errors).toEqual([]);
  });
});
```

Правка `packages/desktop/e2e/chat-hooks.spec.ts`.

Строка 476. Было:

```ts
    // j) Подсказки поля ввода (живая проверка 2026-10-02): скилл проекта по «/», файл проекта по «@», модели по «/model ».
```

Стало:

```ts
    // j) Подсказки поля ввода (живая проверка 2026-10-02): скилл проекта по «/», файл проекта по «@»; по «/model » подсказок
    // нет — модель меняет меню тулбара (нормалайзер модели и effort 2026-10-06).
```

Строки 494-495. Было:

```ts
    await field.pressSequentially('/model ');
    expect(await suggestions.getByTestId('chat-suggestion').count()).toBeGreaterThanOrEqual(1);
```

Стало:

```ts
    await field.pressSequentially('/model ');
    await expect(suggestions).toHaveCount(0);
```

Правка `packages/desktop/e2e/providers-connect.spec.ts`.

Строка 221 (тест «Save в открытом диалоге, Flash, …»). Было:

```ts
    expect(await launchOf(flashRef, 1)).toMatchObject({ resume: true, model: DEFAULT_MODEL, settingsModel: DEFAULT_MODEL, firstKey: true });
```

Стало:

```ts
    // Модель из диалога хранится в карте (нормалайзер 2026-10-06, 5.5): resume идёт с ней, а не с моделью по умолчанию.
    expect(await launchOf(flashRef, 1)).toMatchObject({ resume: true, model: FLASH_MODEL, settingsModel: FLASH_MODEL, firstKey: true });
```

Строки 293-309 (тест «GLM family: …»). Было — от комментария `// Выбор /model в текущем процессе не записывается как launch model следующего resume.` до проверки `expect(await launchOf(ref, 1)).toMatchObject({ resume: true, model: DEFAULT_MODEL, settingsModel: DEFAULT_MODEL });`. Если слияние 0.5.3 (Task 13) изменило этот блок, заменить слитый вариант так же — от строки с `/model ` до проверки `launchOf(ref, 1)`. Стало:

```ts
    // Меню чата у GLM (нормалайзер 2026-10-06): подсказок `/model ` нет; выбор модели — `sessions.setModel`, хост перезапускает
    // сессию через resume с новой моделью, и следующий resume берёт её из карты.
    const field = chat.getByTestId('chat-composer').locator('textarea');
    await field.fill('/model ');
    await expect(window.getByTestId('chat-suggestions')).toHaveCount(0);
    await field.fill('');
    await window.getByRole('radio', { name: 'Terminal', exact: true }).click();
    await window.getByRole('radio', { name: 'Chat', exact: true }).click();
    await expect(chat.getByTestId('chat-text')).toContainText('Hello from the GLM fixture.');
    await chat.getByTestId('chat-model').click();
    const choices = window.getByTestId('chat-model-option');
    await expect(choices).toHaveCount(2);
    await expect(choices.nth(0)).toHaveAttribute('data-model', DEFAULT_MODEL);
    await expect(choices.nth(1)).toHaveAttribute('data-model', FLASH_MODEL);
    await expect(window.getByTestId('chat-effort-option')).toHaveCount(5);
    await choices.nth(1).click();
    expect(await launchOf(ref, 1)).toMatchObject({ resume: true, model: FLASH_MODEL, settingsModel: FLASH_MODEL });
    await call(window, 'sessions.stop', { ref });
    await call(window, 'sessions.resume', { ref });
    expect(await launchOf(ref, 2)).toMatchObject({ resume: true, model: FLASH_MODEL, settingsModel: FLASH_MODEL });
```

- [ ] **Step 2: Прогон E2E — красный (стабы ещё не умеют)**

Run:
```bash
pnpm --filter @parley/host build && pnpm --filter @parley/desktop build && pnpm --filter @parley/desktop exec playwright test e2e/model-effort.spec.ts
```
Expected: 2 failed.
- тест диалога: таймаут `expect.poll` с `Received: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]` — стаб не отвечает на `debug models`, проба хоста уходит в таймаут, и действует запасной список;
- тест чата: таймаут `toHaveAttribute('title', 'Opus Plan (1M context) · Max')` — у стаба нет ползунка, хост отвечает `verified: false`, и появляется тост «Open the terminal to change the effort».

- [ ] **Step 3: Стабы — каталог Codex, ползунок `/effort`, журнал запусков**

`packages/desktop/e2e/stub-codex-agent.mjs`.

Строки 26-27. Было:

```js
import { spawn } from 'node:child_process';
import { clearInterval, setInterval } from 'node:timers';
```

Стало:

```js
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { clearInterval, setInterval } from 'node:timers';
import { URL } from 'node:url';
```

После блока `--version` (строки 30-33) добавить:

```js

// Каталог моделей (`codex debug models`; нормалайзер модели и effort 2026-10-06, спека 5.2): хост спрашивает его на
// старте, как версию. Ответ — урезанный каталог в форме настоящего (`fixtures/codex-debug-models.json`): две видимые
// модели не в порядке `priority` и одна скрытая — по ним E2E видит, что список пришёл от CLI, а не встроенный.
if (process.argv[2] === 'debug' && process.argv[3] === 'models') {
  process.stdout.write(readFileSync(new URL('./fixtures/codex-debug-models.json', import.meta.url), 'utf8'));
  process.exit(0);
}
```

`packages/desktop/e2e/stub-echo-agent.mjs`.

После строки 98 (`const providerSessionId = argvValue('--session-id');`) добавить:

```js

// Журнал запусков (STUB_LAUNCH_LOG; нормалайзер модели и effort 2026-10-06): флаги модели и effort каждого старта процесса
// сессии — E2E сверяет по нему перезапуск из меню чата (`sessions.setModel`: stop и resume с флагами из карты).
const launchLog = process.env.STUB_LAUNCH_LOG;
if (launchLog !== undefined && launchLog !== '') {
  appendFileSync(
    launchLog,
    `${JSON.stringify({ sessionId: fromEnv('SESSION_ID') ?? null, model: argvValue('--model') ?? null, effort: argvValue('--effort') ?? null, resume: argvValue('--resume') !== undefined })}\n`,
  );
}
```

Прямо перед `function typed(text) {` (после констант `PASTE_START`/`PASTE_END`) добавить:

```js
// Ползунок `/effort` Claude Code (STUB_EFFORT_SLIDER=1; нормалайзер модели и effort 2026-10-06, спека 5.7). `/effort` и
// Enter открывают его нижней строкой экрана с «s for this session only»; ←/→ (CSI или SS3) двигают уровень с упором в
// low и max, `s` применяет его «только для сессии» и пишет подвал `<знак> <уровень> · /effort` той же нижней строкой,
// Esc закрывает без смены. Так E2E проверяет смену effort из меню чата (`sessions.setEffort`) по экрану, как у
// настоящего CLI. Нужен сырой режим tty — вместе с STUB_BRACKETED=1.
const effortSlider = process.env.STUB_EFFORT_SLIDER === '1';
const SLIDER_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SLIDER_MARKS = ['○', '◐', '●', '◉', '◈'];
/** Индекс уровня, пока ползунок открыт; `null` — закрыт. */
let slider = null;

/** Строка внизу экрана: подвал Claude Code живёт у нижнего края, а не под последним выводом. */
function bottomLine(text) {
  process.stdout.write(`\x1b[999;1H\x1b[2K${text}`);
}

function openSlider() {
  slider = 1;
  bottomLine('Effort: ←/→ to adjust · Enter to save as default · s for this session only · Esc to cancel');
}

/** Клавиша открытого ползунка в начале `head`; ответ — сколько знаков она заняла. */
function sliderKey(head) {
  if (head.startsWith('\x1b[D') || head.startsWith('\x1bOD')) {
    slider = Math.max(0, slider - 1);
    return 3;
  }
  if (head.startsWith('\x1b[C') || head.startsWith('\x1bOC')) {
    slider = Math.min(SLIDER_LEVELS.length - 1, slider + 1);
    return 3;
  }
  if (head.startsWith('s')) {
    bottomLine(`${SLIDER_MARKS[slider]} ${SLIDER_LEVELS[slider]} · /effort`);
    slider = null;
    return 1;
  }
  if (head.startsWith('\x1b')) {
    bottomLine('Effort unchanged');
    slider = null;
    return 1;
  }
  return 1;
}

```

В `function typed(text)`. Было:

```js
function typed(text) {
  for (const char of text) {
    if (char === '\r' || char === '\n') {
      // Команда выхода (раунд fix-host-resync): E2E завершает свой stub сам, без сигнала чужим
      // процессам и без поиска pid по всей машине.
      if (buffer === 'STUB_EXIT') process.exit(0);
```

Стало (остаток функции не меняется):

```js
function typed(text) {
  // По индексу, а не `for…of`: открытый ползунок `/effort` забирает клавишу целиком, а стрелка — три знака.
  const chars = Array.from(text);
  for (let at = 0; at < chars.length; at += 1) {
    if (slider !== null) {
      at += sliderKey(chars.slice(at, at + 3).join('')) - 1;
      continue;
    }
    const char = chars[at];
    if (char === '\r' || char === '\n') {
      // Команда выхода (раунд fix-host-resync): E2E завершает свой stub сам, без сигнала чужим
      // процессам и без поиска pid по всей машине.
      if (buffer === 'STUB_EXIT') process.exit(0);
      // Ползунок `/effort` (STUB_EFFORT_SLIDER=1): строка не эхом, а открытым ползунком, как у настоящего CLI.
      if (effortSlider && buffer.trim() === '/effort') {
        openSlider();
        buffer = '';
        continue;
      }
```

- [ ] **Step 4: Прогон E2E — зелёные, вместе с затронутыми спеками**

Run:
```bash
pnpm --filter @parley/host build && pnpm --filter @parley/desktop build
pnpm --filter @parley/desktop exec playwright test e2e/model-effort.spec.ts e2e/chat-hooks.spec.ts e2e/dialogs-layout.spec.ts e2e/chat-view.spec.ts e2e/codex.spec.ts e2e/terminal.spec.ts
pnpm --filter @parley/desktop exec playwright test e2e/providers-connect.spec.ts --grep "Save в открытом диалоге|GLM family"
pnpm exec eslint packages/desktop/e2e
```
Expected:
- все перечисленные тесты зелёные, в том числе оба размера `dialogs-layout` (800×500) со списком effort в пяти строках агентов;
- `terminal.spec.ts` проверяет переписанный `typed` стаба в каноническом режиме;
- `providers-connect` «800×500» в прогон не входит: он красный и до этой работы (Task 16);
- ESLint чистый (`URL` — из `node:url`).

- [ ] **Step 5: Коммит E2E**

```bash
git add packages/desktop/e2e/model-effort.spec.ts packages/desktop/e2e/fixtures/codex-debug-models.json packages/desktop/e2e/stub-codex-agent.mjs packages/desktop/e2e/stub-echo-agent.mjs packages/desktop/e2e/chat-hooks.spec.ts packages/desktop/e2e/providers-connect.spec.ts
git commit -m "test(desktop): E2E — уровни Codex из каталога CLI в диалоге и меню «модель · effort» в чате" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: README**

`README.md`:

(a) Строки 442-445 (пункт «a new session or room»). Было:

```
  — the provider, a model from the list ("Default" first — no flag; the list comes from the
  provider's public documentation or from `providers.json`) and the effort "Low / Medium /
  High" (only if the provider accepts it) — and "In its own worktree". With one agent the
```

Стало:

```
  — the provider, a model from the list ("Default" first — no flag; the list comes from the
  provider's public documentation, from Codex's own catalog or from `providers.json`) and the
  effort ("Default" first — no flag, so the CLI uses the level saved in it; then the levels of
  the chosen model, with Codex's descriptions on a second line; with the "Default" model, the
  levels all the provider's models share; no field when the provider or the model has no
  levels) — and "In its own worktree". A new model resets a level it does not have to
  "Default", and a new provider resets both. With one agent the
```

(b) Строки 752-754 (**Input.**). Было (после слияния 0.5.3; в 0.5.2 фраза звучит `` `/model ` lists the models``):

```
attachments return to the field. Typing `/` lists Claude Code's commands and your skills, `/model ` lists Claude's models
and `@` lists subagents and the files of the session's working copy: ↑/↓ choose, Enter or Tab
insert, Esc closes. The window only inserts the text — Claude Code parses it.
```

Стало:

```
attachments return to the field. Typing `/` lists Claude Code's commands and your skills, and `@`
lists subagents and the files of the session's working copy: ↑/↓ choose, Enter or Tab insert,
Esc closes. The window only inserts the text — Claude Code parses it. There are no model
suggestions after `/model `: Claude Code saves a typed `/model` as your default for new
sessions, so change the model with the toolbar menu instead.
```

(c) Строки 770-775: весь абзац, начинающийся с `**Mode and model.**` (в редакции 0.5.2 или 0.5.3), заменить на:

```
**Mode, model and effort.** The toolbar's mode menu sets Manual, Accept edits, Plan or Auto.
The host presses Shift+Tab in the hidden terminal until the footer of the screen shows the
chosen mode; if it cannot confirm the change, it asks you to open the terminal. Bypass mode is
set in the terminal only. The button next to it reads "model · effort": the model the session
reports, otherwise the one chosen for it, and the effort chosen for it — "Default" when none
was chosen. Its menu, for Claude and GLM alike, lists the provider's models and the effort
levels of the session's model. A level is applied by Claude Code's `/effort` slider in the
hidden terminal "for this session only": the host checks the level in the footer, and if it
cannot confirm it, asks you to open the terminal. A model is changed by restarting the session
with `--resume` and the new model, so the conversation goes on; a level the new model does not
have goes back to "Default", and the window tells you. Neither choice changes Claude Code's
saved defaults. While the agent works, the menu items are disabled and say why; a model also
waits for background tasks, and a level needs a running session. With an older host the
button is plain text.
```

(d) Строка 985 (перечень `~/.parley/`). После строки `  providers.json      optional overrides of the provider registry` добавить:

```
  codex-models.json   the Codex model catalog the host last got from `codex debug models`
```

(e) Строка 1026. Было:

```
| `get_map()` | the whole map, plus the registry's providers with an availability mark, a list of models (`models`) and an effort flag (`effort`) |
```

Стало:

```
| `get_map()` | the whole map, plus the registry's providers with an availability mark, a list of models (`models`, each with its effort levels `efforts`) and an effort flag (`effort`) |
```

(f) Строка 1028. Было:

```
| `spawn_session(provider, label, task, contextFrom?, agent?, worktree?, model?, effort?)` | a new session in the same workspace; the host itself starts it. `model` is an `id` from the provider's list in `get_map` (a value not in the list is an error, and the session is not created), `effort` is `low`, `medium` or `high`; a provider without the flag discards the choice |
```

Стало:

```
| `spawn_session(provider, label, task, contextFrom?, agent?, worktree?, model?, effort?)` | a new session in the same workspace; the host itself starts it. `model` is an `id` from the provider's list in `get_map`, `effort` is one of the chosen model's `efforts` there — with the default model, the levels all the provider's models share (a value outside them is an error, and the session is not created); a provider without the effort flag discards the effort |
```

(g) Строка 1257. Было:

```
    `src/provider-models.ts` — the built-in model lists.
```

Стало:

```
    `src/provider-models.ts` — the built-in model lists with each model's effort levels.
```

(h) Строки 1323-1363. Весь раздел `### Models`, от заголовка до закрывающей ограды его примера JSON, заменить на:

````
### Models

The host gives the window the providers' model lists (`providers.list`), each model with its
effort levels. `sessions.create` accepts a model only from its provider's list and an effort
only from the levels of that model: a value outside them gives `bad_request` with the allowed
values, the CLI does not get it, and no record appears in the map. The chosen model and
effort are kept in the session's map, and resume passes them again. If no model is chosen
(the field is omitted or empty), it means "default": Claude Code and Codex use their own model
without `--model`; GLM uses `glm-5.3[1m]`. No effort means "default" too: the CLI uses the
level saved for the model, or the model's own default. With the "default" model, the levels on
offer are those all the provider's models share. The lists:

- Claude Code — the `--model` aliases from `code.claude.com/docs/en/model-config`: `best`,
  `fable`, `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan`, `opusplan[1m]`.
  The aliases themselves point at the current version, so pinned versions (`claude-opus-5-5`
  and the like) are not in the list. Every model except `haiku` takes the efforts `low`,
  `medium`, `high`, `xhigh` and `max`; Haiku has no effort;
- Codex — the list comes from Codex itself. At start, and again when the list is more than
  six hours old, the host runs `codex debug models`, Codex's own command that prints the
  models of your account, and takes the visible ones in Codex's order, each with its effort
  levels and their descriptions (up to `ultra`). It keeps the list in `codex-models.json` in
  Parley's home, so agents' `get_map` and `spawn_session` offer the same models. Codex may
  refresh its catalog from its server while answering; Parley reads neither Codex's files nor
  its sign-in. If the command fails (no sign-in, no network, a timeout, unexpected output),
  the built-in list is used: the visible models of 2026-10-06 — `gpt-6.1-sol`, `gpt-6-astra`,
  `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` and `gpt-5.6-luna`, each with
  `low` to `max` and, except the two Luna models, `ultra`;
- GLM — `glm-5.3[1m]` and `glm-5.3-flash[1m]`, shown as GLM-5.3 and GLM-5.3 Flash with
  1M context. The official Opus and Sonnet tiers map to GLM-5.3; Haiku maps to GLM-5.3 Flash.
  Both take Claude Code's five efforts, `low` to `max`.

For custom providers with no list, the model goes into the command unchecked — if
`args` contains `{model}`; the effort is then one of `low`, `medium` and `high`.

If a model comes out that is not in the list yet, do not wait for a Parley update: set the
list in `~/.parley/providers.json` with the `models` field. An element is a pair of `id` (the
`--model` value) and `label` (the caption in the window); `id` is a single word, does not
start with a hyphen, is at most 200 characters, and has no repeats in the list, otherwise the
file will not load. An element may also carry `efforts`: the model's effort ids (lowercase
words such as `low` or `xhigh`, no repeats), or `null` for a model without effort; without
the field the model offers `low`, `medium` and `high`. The list replaces the built-in one
entirely (like `args`), so the built-in models you need are listed again; `[]` removes the
list altogether. For Codex it also wins over Codex's own catalog. It takes effect only if the
provider's `args` contains `{model}`, and the effort only if they contain `{effort}` (the
built-in `claude`, `codex` and `glm` have both). `args` set in `providers.json` replace the
built-in ones without a migration: if they lack `{model}` or `{effort}`, there is no model or
effort choice, and the provider's card says "Launch arguments come from providers.json" and
why the choice is off.

```json
{
  "codex": {
    "models": [
      { "id": "gpt-6-sol", "label": "GPT-6-Sol" },
      { "id": "my-new-model", "label": "My new model", "efforts": ["low", "medium", "high", "xhigh"] }
    ]
  }
}
```
````

(i) Раздел GLM (≈ строки 1423-1427). Абзац, начинающийся с `GLM shares Claude Code's transcript format and Chat view.` (в редакции 0.5.2 или 0.5.3), заменить на:

```
GLM shares Claude Code's transcript format and Chat view. The first launch stays in Terminal
until the first activity hook; answer trust, onboarding and permission questions there.
Resume starts with the session's model and effort from the workspace map (GLM-5.3 when none
was chosen). GLM offers Claude Code's five effort levels, Low to Max, for both models, and
Z.ai takes them into account. Chat's model and effort menu works for GLM as for Claude and
never touches the settings GLM shares with Claude. Avoid typing `/model` and `/logout` in a
GLM terminal: Claude Code saves a `/model` choice as the default model of the local Claude
Code settings shared with your Claude sessions, and `/logout` can change their shared
sign-in.
```

(j) Строка 1447. Было:

```
substituted per session; `--model` and the effort only if chosen in the dialog):
```

Стало:

```
substituted per session; `--model` and the effort only if chosen in the dialog or by `spawn_session`):
```

(k) Строки 1635-1637 (Known limitations → The window). Было:

```
  - `claude --resume` gets neither the session's model nor its effort: they are in the map,
    but the resume command does not carry them (Claude Code takes the model from the session
    itself; the effort is not restored on resume).
```

Стало:

```
  - the model and the effort of a running Codex session cannot be changed from the window:
    Codex sessions have no Chat yet, so choose both when you start the session.
```

- [ ] **Step 7: CHANGELOG**

`CHANGELOG.md`: сразу после строки `## Unreleased` (и пустой строки за ней) вставить:

```markdown
### Added

- **Real effort levels for every model.** The New session or room dialog lists the effort
  levels of the chosen model instead of a fixed Low / Medium / High: Low to Max for Claude
  (Haiku has none) and for both GLM models, and each Codex model's own levels up to Ultra,
  with Codex's descriptions. "Default" now comes first in both the model and the effort list
  and sends no flag, so the level you saved in the CLI applies. Agents get the same levels in
  `get_map`, and `spawn_session` accepts only them.
- **Codex's own model list.** The host asks Codex for the models of your account
  (`codex debug models`) and shows them in Codex's order; if that fails, the built-in list of
  current models is used.
- **Model and effort in Chat.** The toolbar shows "model · effort", and its menu changes either
  one for this session only: the effort through Claude Code's `/effort` slider, confirmed in the
  footer, the model by restarting the session with `--resume`. Claude Code's saved defaults stay
  untouched, and GLM sessions have the menu again.

### Changed

- **The chosen model and effort stay with the session.** A session started from the dialog keeps
  them in the workspace map, and resuming a Claude or GLM session passes both again.
- **No `/model ` suggestions in Chat.** Claude Code saves a typed `/model` as the default for new
  sessions; the toolbar menu changes the model without that.
- **Launch arguments from `providers.json`.** A provider whose `args` come from `providers.json`
  says so in its card and explains why the model or effort choice is off.

```

- [ ] **Step 8: TODOS**

`TODOS.md`:

(a) Раздел 4, строки 155-160. Было:

```
- **Усилие при `resume` у Claude.** Модель и усилие теперь хранятся в
  `WorkSession` (`spawn_session` иначе не передал бы выбор хосту), но `resumeArgs`
  Claude их не несёт: модель Claude Code при `--resume` берёт из сессии сам,
  усилие по документации не восстанавливает. Решить: передавать `--effort` из
  карты при `resume`, если провайдер его принимает (у Codex `resume` восстанавливает
  всё из треда).
```

Стало:

```
- **Усилие при `resume` у Claude.** Сделано нормалайзером модели и effort
  (`docs/specs/2026-10-06-model-effort-normalizer-design.md`, 5.4–5.5): выбор из диалога
  тоже пишется в карту, `resumeArgs` Claude несут `--model`/`--effort` из неё, GLM —
  `--effort` рядом с `--model`; у Codex `resume` по-прежнему восстанавливает всё из треда.
```

(b) Раздел 10. Если пункт 0.5.3 `**Смена модели и effort из чата — «только для этой сессии».**` есть (он приходит с master), заменить его целиком на:

```
- **Смена модели и effort из чата — «только для этой сессии».** Сделано нормалайзером модели и
  effort (`docs/specs/2026-10-06-model-effort-normalizer-design.md`, 5.7–5.9): меню «модель ·
  effort» зовёт `sessions.setEffort` (ползунок `/effort` с клавишей `s` и сверка по подвалу) и
  `sessions.setModel` (перезапуск `--resume` с моделью и effort из карты); текста `/model` окно
  больше не шлёт, подсказки `/model ` убраны у всех, меню вернулось у GLM. Осталось: живая
  приёмка на настоящих Claude Code и GLM — критерии 7 и 8 спеки, настройки `~/.claude` до и
  после совпадают байт в байт.
```

Сразу после него — или после пункта `**Живые GLM-сессии после смены ключа — перезапуск с новым ключом.**`, если пункта 0.5.3 нет, — добавить:

```
- **Модель и effort — что осталось за рамкой нормалайзера** (спека
  `docs/specs/2026-10-06-model-effort-normalizer-design.md`, раздел 12):
  - смена модели и effort у идущего Codex — вместе с чатом Codex (следующий подпроект);
  - фактический effort из транскрипта Claude (`"effort"` в записях ответа) и из rollout Codex
    (`turn_context`): кнопка чата сейчас показывает effort из карты;
  - миграция старых `providers.json`: `args` без `{model}`/`{effort}` по-прежнему выключают
    выбор, карточка провайдера лишь объясняет почему;
  - показ того, во что превращается «Default»: рамка не даёт читать настройки Claude Code и
    Codex;
  - свои умолчания провайдера в Parley (profile defaults из плана
    `.omx/plans/2026-10-04-provider-adapters-and-chat.md`).
```

- [ ] **Step 9: Прогон — документы**

Run:
```bash
pnpm --filter @parley/desktop exec vitest run src/release-docs.test.ts
grep -n "Low / Medium\|/model \` lists\|sends \`/model\|gets neither the session's model" README.md
```
Expected: PASS (README и CHANGELOG — по-английски, без `harnas`, раздел «Updates» не тронут); `grep` ничего не печатает.

- [ ] **Step 10: Коммит документов**

```bash
git add README.md CHANGELOG.md TODOS.md
git commit -m "docs: модель и effort — диалог, меню чата, GLM, MCP и каталог Codex; CHANGELOG и TODOS" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Полный прогон и живая приёмка (критерии 1–12 спеки)

**Files:**
- Modify: `docs/specs/2026-10-06-model-effort-normalizer-design.md` — строка статуса и «Добавление от <дата>: приёмка»

**Interfaces:**
- Consumes: всё из Task 0–15.
- Produces: записанный итог приёмки; ветка готова к MR.

- [ ] **Step 1: Полный прогон, как в CI**

Run (из корня):
```bash
pnpm install --frozen-lockfile && pnpm build && pnpm typecheck && pnpm lint && pnpm -r --workspace-concurrency=1 --no-bail run test --retry=1
```
Expected: всё зелёное, ни одного «Unhandled error» в выводе vitest. Затем E2E: `pnpm --filter @parley/desktop run e2e` (имя скрипта сверить в `packages/desktop/package.json`). Известный красный до этой работы — `providers-connect.spec.ts` «800×500» (поле ключа видно на 0,9887): он не должен стать хуже; новые E2E этой работы — зелёные.

- [ ] **Step 2: Снимок глобальных настроек Claude до приёмки**

```bash
shasum -a 256 "$HOME/.claude/settings.json" | tee "$TMPDIR/parley-acceptance-settings.before"
```

- [ ] **Step 3: Dev-окно без переменных родительской сессии**

```bash
cd packages/desktop && env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" SHELL="$SHELL" PATH="$PATH" TMPDIR="$TMPDIR" LANG="$LANG" PARLEY_LOGIN_SHELL=skip PARLEY_HOME="$HOME/.parley-chatview" PARLEY_WORKTREE_ROOT="$HOME/.parley-chatview/worktrees" ./node_modules/.bin/electron out/main/index.js
```
Expected: окно открылось; в строке статуса Claude, Codex и GLM (GLM — если в `~/.parley-chatview` сохранён ключ; иначе пользователь вставляет его в карточке сам).

- [ ] **Step 4: Критерии 1–2 — диалог**

New session → Codex: модели в порядке Codex; у `gpt-6.1-sol` уровни Default, Low, Medium, High, Extra high, Max, Ultra; у `gpt-6-luna` нет Ultra; выбрать Ultra на `gpt-6.1-sol`, переключить модель на `gpt-6-luna` — effort стал Default. Claude: у Opus/Sonnet/Fable/Best пять уровней, у Haiku поля нет. GLM: обе модели с пятью уровнями. Снимки экрана — в отчёт.

- [ ] **Step 5: Критерий 6 — resume Claude несёт effort из карты**

New session → Claude: модель Default, effort Low. Дождаться приглашения, Stop, затем Resume.

```bash
ps -ax -o pid=,args= | grep -- '--resume' | grep -v grep
```
Expected: у процесса этой сессии — `--resume <id> … --effort low` и нет `--model` (модель не выбирали). Что Claude Code применяет `--effort` при `--resume`, проверено на заглушке API (спека, раздел 3, п. 6).

- [ ] **Step 6: Критерий 7 — смена effort в чате Claude и GLM**

Сессия Claude (Opus, Default/Default) → вид Chat → меню «модель · effort» → High. Expected: за ≤ 5 с кнопка показывает `… · High`, в терминале подвал `● high · /effort`, в карте сессии `effort: "high"`. Повторить в GLM-сессии (ключ и квота пользователя — с его «да»).

- [ ] **Step 7: Критерий 8 — смена модели в чате**

В той же сессии Claude написать «Remember the word: walnut», дождаться ответа; меню → Sonnet. Expected: процесс перезапущен (лента — SessionStart resume, модель Sonnet), effort High сохранился; вопрос «What word did I ask you to remember?» → «walnut». Пока агент отвечает, пункт смены модели неактивен с подсказкой.

- [ ] **Step 8: Глобальные настройки не изменились**

```bash
shasum -a 256 "$HOME/.claude/settings.json" | diff - "$TMPDIR/parley-acceptance-settings.before" && echo "settings.json не изменился"
```
Expected: `settings.json не изменился`. Иначе — стоп: найти, кто писал (это нарушение главного критерия), и чинить до MR.

- [ ] **Step 9: Записать итог и закоммитить**

В спеке: статус «реализовано, приёмка <дата>»; блок «Добавление от <дата>: приёмка» — по пункту на критерии 1–12 (прошло / не прошло, с чем). Критерии, которые здесь не проверялись вживую, записываются по зелёным тестам: 3–5 — Task 2, Task 4, Task 7, Task 9, Task 12; 9 — Task 8; 10 — Task 6, Task 12, Task 13; 11 — Task 3, Task 8, Task 14; 12 — Step 1. Остановить dev-хост штатно (RPC `host.shutdown`).

Run: `git add docs/specs/2026-10-06-model-effort-normalizer-design.md && git commit -m "docs(spec): приёмка нормалайзера модели и effort" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

## Покрытие спеки

| Раздел / критерий | Задачи |
|---|---|
| 3, факты этапа 0 (раздел 9, п. 1–4) | Task 0 |
| 5.1 Каталог моделей: `EffortOption`, `ModelOption.efforts`, подписи уровней, Claude/GLM/Codex, уровни «Default» | Task 1, Task 2 (`effortsFor`), Task 12 (`effortChoices`) |
| 5.2 Каталог Codex от CLI: проба, разбор, сбой, перепроба через 6 ч, `providers.changed`, приоритет списков | Task 8 |
| 5.2 Общий для окна и MCP: `codex-models.json` | Task 5 (чтение в `loadProviders`), Task 8 (атомарная запись) |
| 5.3 Один resolver: `EFFORT_TOKEN`, `effortsFor`, `resolveModelEffort`, токен в `substituteArgs` | Task 2; вызовы — Task 7 (MCP), Task 9 (хост) |
| 5.4 Шаблоны запуска и resume, `plan()` | Task 4 |
| 5.5 Хранение: выбор в карте, `WorkSession.effort: string`, `parseMap` | Task 4, Task 9, Task 10 (`setChoice`), Task 11 |
| 5.6 Протокол: `sessions.create.effort`, `efforts`, `argsOverridden` | Task 6; `argsOverridden` в `providers.list` — Task 8 |
| 5.6 Протокол: `sessions.setEffort`, `sessions.setModel`, `hello.methods` | Task 10, Task 11 |
| 5.6 MCP: `get_map`, `spawn_session.effort`, гид | Task 7 |
| 5.7 Смена effort в идущей сессии | Task 10 (подпись подвала `xhigh` — Task 0) |
| 5.8 Смена модели в идущей сессии | Task 11 |
| 5.9 Окно: диалог | Task 12 |
| 5.9 Окно: чат, меню «модель · effort», GLM, без `/model <id>` | Task 13 |
| 5.9 Окно: карточка провайдера | Task 14 |
| 5.10 `providers.json`: `efforts` у моделей, `args` без подстановок | Task 3, Task 14 |
| 6: пара не из каталога (окно, MCP) | Task 2, Task 7, Task 9 |
| 6: `codex debug models` недоступен | Task 8 |
| 6: Codex, модель «Default» и уровень не из `config.toml` | Task 0 (шаг 4), Task 2 (уровни «Default» — пересечение) |
| 6: `setEffort`, агент работает | Task 10; пункты меню — Task 13 |
| 6: ползунок не открылся или подвал показал другое | Task 10 |
| 6: `setModel`, агент занят или фоновые задачи | Task 11; пункты меню — Task 13 |
| 6: `setModel`, resume не поднялся | Task 11 |
| 6: испорченный effort в карте | Task 4 |
| 6: старое окно с новым хостом | Task 6 (прежние `low`, `medium`, `high` валидны), Task 16 |
| 6: новое окно со старым хостом | Task 12 (прежние три уровня), Task 13 (нет методов — нет меню), Task 16 |
| Критерий 1: диалог Codex по `codex debug models`, уровни `gpt-6.1-sol` и `gpt-6-luna` | Task 5, Task 8, Task 12, Task 15 (E2E), Task 16 |
| Критерий 2: диалог Claude и GLM, у Haiku поля нет | Task 1, Task 12, Task 16 |
| Критерий 3: «Default» + «Default» — без флагов | Task 2, Task 4, Task 9, Task 12 |
| Критерий 4: одна пара флагов; MCP даёт тот же argv и ту же карту | Task 7, Task 9 |
| Критерий 5: пара не из каталога — `bad_request`, ни записи, ни процесса | Task 9 (хост), Task 7 (MCP) |
| Критерий 6: Resume сессии с `low` несёт `effort: low` | Task 4, Task 16 |
| Критерий 7: смена effort в чате Claude и GLM, настройки CLI не тронуты | Task 10, Task 13, Task 15 (E2E), Task 16 |
| Критерий 8: смена модели в чате перезапуском, разговор помнится, неактивность при занятости | Task 11, Task 13, Task 15 (E2E), Task 16 |
| Критерий 9: сбой `codex debug models` — встроенный список, предупреждение, `providers.list` отвечает | Task 8 |
| Критерий 10: совместимость старого и нового окна и хоста | Task 6, Task 12, Task 13 |
| Критерий 11: `args` без `{effort}` — поля нет, карточка объясняет | Task 3, Task 8, Task 12, Task 14 |
| Критерий 12: тесты, typecheck, lint и рамочные тесты зелёные | каждая задача; Task 16 (полный прогон) |
