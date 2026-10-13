# Браузер Parley, этап B2 «Агент открывает страницу» — план

> **Для исполнителей-агентов:** обязательный навык — superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans. Задачи выполняются по одной. Шаги отмечены флажками (`- [ ]`).

**Цель:** агент сессии — Claude, GLM или Codex — одним вызовом `browser_open({ url })` показывает человеку страницу на localhost во встроенном браузере Parley: в новой вкладке своей работы, а не в Chrome, Chrome DevTools или Playwright. Вкладка встаёт в фоне и фокус у человека не отнимает; человек видит тост «S02 opened …» с кнопкой «Show». Читать страницу и управлять ею агент пока не может — это этапы C и D. Этап B2 ставит и весь канал, по которому они пойдут: токен сессии, путь на сервере хуков хоста, событие окну и ответ.

**Устройство:**
- хост при каждом запуске сессии выдаёт ей токен агента (32 случайных байта в hex, новый на каждый запуск) и принимает `POST /agent/browser` на сервере хуков (127.0.0.1) со своим реестром токенов: у Codex хуков нет, а канал нужен всем провайдерам;
- MCP-сервер Parley получает адрес и токен в конфиге (`PARLEY_AGENT_URL`, `PARLEY_AGENT_TOKEN`; файл `mcp/<id сессии>.json` с правами 0600 у Claude и GLM, `-c mcp_servers.parley=…` у Codex) и только тогда объявляет `browser_open`;
- хост проверяет запрос схемой протокола, шлёт его окну событием `browser.agentOp` (одному, с возможностью `browser-agent`) и ждёт ответа `browser.agentResult`;
- main окна (`main/browser/agent-ops.ts`) проверяет общий выключатель «Let agents use the browser» (`UiFile.browser.agentsAllowed`) и адрес (`shared/loopback.ts`), просит рендерер поставить вкладку событием `browser:agent-open-tab` и переводит его ответ в ответ агенту;
- рендерер (`renderer/browser/agent-open.ts`) читает раскладку работы, если окно её ещё не показывало, и ставит вкладку за последней браузерной вкладкой работы (а если их нет — справа от вкладки сессии-агента) без фокуса: активные вкладка, группа и работа человека не меняются. Страницу, которую вкладка работы уже показывает, не повторяет; держит предел в 10 вкладок; показывает тост;
- правило приоритета («для страниц на localhost сначала браузер Parley») — отдельный блок системной вставки (`BROWSER_PRIORITY_RULE` в `core/work/guidance.ts`), только у запуска, где есть канал и сервер MCP.

**Стек:** Electron 44.4.5, React 18, zustand 5, `sonner` 2; `node:http` хоста; `@modelcontextprotocol/sdk` 1.30 (низкоуровневый `Server`, JSON Schema инструментов), zod 4 в протоколе; vitest + Testing Library + jsdom; Playwright `_electron`.

**Спека:** `docs/specs/2026-10-07-browser-devtools-agent-design.md` — разделы 2 (п. 8–9), 3.7, 4.8 (общий выключатель), 5.1 (`browser_open`), 5.2, 5.4, 7, 8, 9, 10, 11 и 12 («Этап B2»). **Индекс плана** (обязательный контракт имён): `docs/specs/2026-10-07-browser-devtools-agent-plan.md`. Исполнитель читает спеку, индекс и этот файл. Планы C и D писались до B2 и ссылаются на его части; что именно B2 взял у них и где отошёл от их текста — раздел «Расхождения с планами C и D» в конце этого файла.

**Опоры, уже учтённые в задачах:**
- этап A: предел `BROWSER_LIMITS.tabsPerWork` (10) и `browserTabCount` (`renderer/browser/store.ts`), `layoutUrl` (`renderer/browser/url.ts`), `openTab(…, { focus: false })`, `findTab`, `groups`, `focusTab` (`renderer/layout/tree.ts`), `ensureHydrated` (`renderer/layout/persistence.ts`), `UiFile.browser` (`shared/ui-types.ts`);
- сессионный слой и MCP: `bothEnv`, `SESSION_VARIABLES`, `codexServerEnv`, `writeMcpConfig` (`core/work/mcp-config.ts`), `McpContext` (`core/mcp/context.ts`), `createParleyServer` (`core/mcp/tools.ts`), `buildSessionLayer` (`core/work/session-layer.ts`), `planLaunch`, `planNew`, `planResume` (`core/work/launch.ts`);
- хост: `createHookServer` (`host/hooks/hook-server.ts`), `SessionsFeedOptions` (`host/sessions/sessions-service.ts`), `MethodDeps` (`host/methods/index.ts`), реестр клиентов с `Client.features`;
- E2E: заглушка `e2e/stub-echo-agent.mjs` по строке `STUB_MCP <инструмент> <json>` запускает настоящий `parley-mcp` по конфигу сессии; менять её не нужно.

**Где работать:**
- порядок этапов — 0 → A → B → B2 → C → D, поэтому B2 начинается после слияния B в `origin/master`. Ветка `feat/browser-agent-open`, worktree `.claude/worktrees/browser-agent-open`:

```bash
cd /Users/kalmbik61/Desktop/MY/my_harnas
git fetch origin
git worktree add -b feat/browser-agent-open .claude/worktrees/browser-agent-open origin/master
cd .claude/worktrees/browser-agent-open
pnpm install
pnpm build            # без сборки @parley/protocol и @parley/core тесты хоста и окна не находят пакеты
pnpm test             # исходный прогон: числа по пакетам — в отчёт этапа
pnpm typecheck && pnpm lint
pnpm --filter @parley/desktop e2e   # после pnpm build; исходные красные — в отчёт
```

- пока B не влит, ветку берут от `feat/browser-context` (`git worktree add -b feat/browser-agent-open .claude/worktrees/browser-agent-open feat/browser-context`): план написан и проверен на её коде. Влитый позже `origin/master` вливается в ветку (`git merge origin/master`), не перебазируется;
- все команды ниже — из корня этого worktree;
- одиночный тест: `pnpm --filter @parley/<пакет> exec vitest run <путь от пакета>`;
- пакеты разрешают друг друга через `dist`: после правки `packages/protocol` перед тестами хоста и окна — `pnpm --filter @parley/protocol build`, после правки `packages/core` перед тестами хоста — `pnpm --filter @parley/core build`. В шагах ниже это сказано там, где нужно;
- E2E: `pnpm build && pnpm --filter @parley/desktop exec playwright test <файл>`;
- флейки (`works-service`, `context-pages`, `activity-service`, `wake-service` хоста под нагрузкой, порог тишины FSEvents, капризы tui-тестов) сравниваются с исходным прогоном, а не чинятся мимоходом; перед тяжёлым прогоном — `uptime`, при загрузке не ниже числа ядер прогон откладывается.

Правки в существующие файлы записаны как «после строк … вставить …» и «заменить … на …». Якорь — строки текущего кода; если он в файле не один, в блок добавлены соседние строки. Новые файлы приведены целиком.

## Глобальные ограничения

Действуют все пункты «Глобальных ограничений» индекса. Для этапа B2 особо:

- **Объём этапа.** Скелет канала, ровно одна операция `open`, общий выключатель, правило приоритета, E2E и документы. Нет: операций чтения (`tabs`, `console`, `network`, `screenshot`), «Agent access» у вкладки и значка «Agent capture W×H», управления страницей (`navigate`, `snapshot`, `action`, `wait_for`, `resize`), скилла `parley-browser`, реестра вкладок в main. Имена из индекса и планов C и D сохранены, чтобы они дописывали, а не переименовывали.
- **Агент открывает только то, что можно показать человеку.** Адрес — `http(s)` на loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`), иначе `not_loopback`. Вкладка встаёт только в работу сессии-агента: работу задаёт хост по токену (`ref` события), аргументы назвать её не могут. JS, куки, хранилища, файлы и чужие сайты — никогда.
- **Агент не меняет активную вкладку, группу и работу окна** (спека 5.2). Тост «S02 opened …» (`S.browser.agent.opened`) с кнопкой «Show» — единственный способ перейти к вкладке, и нажимает его человек.
- **Токен агента** — 32 случайных байта в hex, новый на каждый запуск сессии. Он лежит только в конфиге MCP-сервера: в файле `mcp/<id сессии>.json` (права 0600) у Claude и GLM и в `-c mcp_servers.parley=…` у Codex. В окружение PTY, в журнал хоста и в ответы окна токен не попадает. Прежних имён `HARNAS_AGENT_*` нет.
- **Журнал хоста** — одна строка на операцию: проект, работа, сессия, операция, вкладка, origin, исход, миллисекунды. Данных страницы, аргументов и токенов в нём нет. У `open` в строке только origin адреса: путь, query и фрагмент в журнал не идут.
- **Эндпоинт — только `127.0.0.1`**, на том же HTTP-сервере, что принимает хуки. Отказ доступа — без тела: токен не узнан — 401, тело больше 64 КБ — 413.
- **`browser.agentResult` зовёт только main.** Канал `host:call` окна его не пускает, а событие `browser.agentOp` рендереру не пересылается (`forwardHostToWindow`).
- **Core не импортирует ни `@parley/protocol` (тот сам зависит от core), ни код окна.** У core свои копии: операции и пределы (`BROWSER_TOOL_OPS`, `BROWSER_TOOL_LIMITS`). Совпадение операций и пределов с протоколом сверяет тест хоста (задача 6). Ограда `fence` и пометка «page data» — у этапа C: страницу B2 не читает.
- **Операция идёт одному окну** — последнему подключившемуся клиенту с возможностью `browser-agent`: два окна не должны исполнить одну операцию дважды.
- **Инструмент и правило — только там, где есть канал.** Сессия без `PARLEY_AGENT_URL` и токена `browser_*` не видит; слой сессии получает `BROWSER_PRIORITY_RULE` только у запуска с каналом и серверов MCP. Старый хост и старая сессия получают безопасный отказ с советом (индекс: «Фича — для всех, кто поставил»).
- **Готовность окна для просьбы агента** — `webContents.isLoadingMainFrame() === false`, а не `loadedWindows` из `main/index.ts`: первый `<webview>` даёт окну `did-start-loading` без `did-finish-load`, и признак `loadedWindows` снимался бы насовсем (это нашёл E2E этапа, задача 12). `loadedWindows` и его потребителей (`app:focus-target`, `app:update-available`) этап не трогает.
- **Метод `browser.agentResult` не входит в `REQUIRED_METHODS`** окна: его добавление вынудило бы запрос «Restart host…» и убило бы сессии живых агентов. Окно с хостом без канала просто не получит ни одной операции.
- **Код Orca** для канала агента не берётся (в Orca агент ходит иначе); `NOTICE` не меняется.
- **Поведение этапов A и B не меняется.** Файлы этапов правятся только там, где сказано в задачах.
- **Строки окна** — английские, в `packages/desktop/src/shared/strings.ts`: `S.browser.agent.*` и `S.settings.letAgentsUseBrowser*`. Тексты для агента — описание и ответы `browser_open`, правило приоритета, сообщения ошибок — английские. Страж — `packages/desktop/src/english-ui.test.ts` и `english-text.test.ts` пакетов core и host.
- **Комментарии, названия тестов, описания коммитов** — по-русски. Коммит — `git commit -m "<тип>(<область>): …" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"` (так подписаны последние коммиты ветки; исполнитель другой модели ставит свою строку).
- **Визуальные проверки** — окно 800×500, длинные адрес страницы и название работы, DPR 1 и 2 (`--force-device-scale-factor=2`): тост со «Show» и строка настройки в Settings → Browser (задача 14).

## Фокус ревью

Пять случаев, которые прямые тесты задач легко пропустят. Под каждый — тест в задаче-владельце.

1. **Токен: чужой, устаревший, лишний.** Запрос без токена и с чужим — 401 без тела. Токен перезапущенной сессии (второй `register`) и остановленной — 401 и к другой сессии не ведёт. Работу и вкладку агент назвать не может: лишнее поле аргументов (`workKey`, `tab`, `projectPath`) — `bad_request` и окну ничего, работу задаёт хост по токену. Токен лежит только в конфиге MCP (файл 0600): в окружении процесса агента, в argv Claude, в журнале хоста и в тексте окна его нет. Тесты — задача 3 (`browser-endpoint.test.ts`, «доступ: токен сессии»), задача 4 (`mcp-config.test.ts`, `launch.test.ts`), задача 5 (`server.test.ts`: настоящие HTTP и сокет), задача 12 (E2E).
2. **Не loopback и обходные записи.** `https://example.com/`, `http://localhost.evil.test/`, `http://127.0.0.1.nip.io/`, `http://0.0.0.0:5173/`, `http://192.168.1.10:5173/`, `http://[::ffff:127.0.0.1]/`, `http://localhost@evil.com/` (хост — `evil.com`), `file:`, `javascript:`, `data:`, относительные адреса и мусор — `not_loopback`, окну ничего не уходит. Тесты — задача 8 (`loopback.test.ts`, `agent-ops.test.ts`), задача 12 (E2E).
3. **Фон: ни вкладки, ни работы человека не отнимать; повтор и предел.** Вкладка агента встаёт и в чужую, не показанную работу: активная работа, её вкладка, группа и история переходов не меняются, «Show» — клик человека. Та же страница (без `#фрагмента`) вторую вкладку не открывает: агент получает id первой с `reused: true`. На пределе в 10 вкладок повтор уже открытой страницы проходит, новая страница — отказ `limit` без изменений и без тоста. Тесты — задача 11 (`agent-open.test.ts`, `AppShell.test.tsx`), задача 12 (E2E).
4. **Окно ушло, молчит или опоздало.** Окна нет — `window_not_connected` сразу; окно закрылось посреди операции — тоже сразу, а не через 30 с; окно молчит — `timeout`; поздний ответ и ответ не того клиента не принимаются; операция идёт одному окну. Окно с живым `<webview>` не считается «неготовым»: вторая операция после первой вкладки проходит. Тесты — задача 3 («сроки и уход окна»), задача 8 («окно ушло или молчит»), задача 10 (`host-connection.test.ts`), задача 12 (E2E: десять вкладок подряд).
5. **Инструмент и правило — только там, где есть канал.** Запуск без канала: ни переменных в конфиге, ни `browser_open`, ни правила. С каналом — правило в слое при `launch`, `new` и `resume` у Claude и GLM (`--append-system-prompt`) и у Codex (`developer_instructions`); шаблон запуска без `{mcpConfig}` правила не получает: велеть звать нечего. Тесты — задача 6 (`browser-tools.test.ts`: без канала `browser_*` нет), задача 7 (`launch.test.ts`, `session-layer.test.ts`), задача 12 (E2E: правило в argv настоящего запуска).

---

## Задача 1. Сверка с кодом ветки и планами C и D

Задача кода не пишет: она проверяет, что опоры плана на месте, и записывает исходные числа в отчёт этапа (описание PR).

**Файлы:** только чтение.

- [ ] **Шаг 1. Опоры в коде.** Каждая строка вывода — одно найденное имя; пустой вывод у любой строки — стоп, сообщить пользователю: код ушёл от того, на котором написан план.

```bash
grep -n "export function createHookServer\|export interface HookServerOptions\|export interface HookServer " packages/host/src/hooks/hook-server.ts
grep -n "features: ReadonlySet<string>" packages/host/src/client.ts
grep -n "export const COMPACT_WORKS_FEATURE" packages/protocol/src/context-pages.ts
grep -n "sessionTag" packages/core/src/index.ts
grep -n "hooks?: Pick<HookServer" packages/host/src/sessions/sessions-service.ts
grep -n "export interface MethodDeps\|export function createHostHandlers" packages/host/src/methods/index.ts
grep -n "export function mcpConfig(\|function codexServerEnv\|const SESSION_VARIABLES\|export async function writeMcpConfig" packages/core/src/work/mcp-config.ts
grep -n "export function createParleyServer" packages/core/src/mcp/tools.ts
grep -n "export interface SessionLayerInput\|export type LayerBlockBytes\|export function buildSessionLayer" packages/core/src/work/session-layer.ts
grep -n "export interface LaunchOptions" packages/core/src/work/launch.ts
grep -n "export const BROWSER_LIMITS\|export function browserTabCount" packages/desktop/src/renderer/browser/store.ts
grep -n "export function layoutUrl" packages/desktop/src/renderer/browser/url.ts
grep -n "export async function ensureHydrated" packages/desktop/src/renderer/layout/persistence.ts
grep -n "^export function openTab\|^export function focusTab\|^export function findTab\|^export function groups" packages/desktop/src/renderer/layout/tree.ts
grep -n "interface BrowserUi\|function normalizeBrowser\|export const DEFAULT_UI" packages/desktop/src/shared/ui-types.ts
grep -n "function NotificationRow" packages/desktop/src/renderer/components/settings/SettingsDialog.tsx
grep -n "export function forwardHostToWindow" packages/desktop/src/main/ipc.ts
grep -n "features: \[COMPACT_WORKS_FEATURE\]" packages/desktop/src/main/host-connection.ts
grep -n "export interface BrowserApi" packages/desktop/src/shared/browser-types.ts
```

  Ожидание: у каждой команды не меньше одной строки (у `grep` с несколькими именами — по строке на каждое).

- [ ] **Шаг 2. Имён этапа B2 в коде ещё нет.**

```bash
grep -rn "PARLEY_AGENT_URL\|PARLEY_AGENT_TOKEN\|agentsAllowed\|BROWSER_AGENT_\|browser_open\|browser\.agentOp\|agent-open-tab\|BROWSER_PRIORITY_RULE" packages/*/src packages/desktop/e2e packages/host/test | wc -l
```

  Ожидание: `0`. Иначе кто-то уже начал этап (или влит C или D): стоп, сообщить пользователю.

- [ ] **Шаг 3. Планы C и D.** Прочитать записки в начале `…-plan-c-agent-read.md` и `…-plan-d-agent-control.md` и раздел «Расхождения с планами C и D» в конце этого файла. Если C или D уже влиты в `origin/master`, их код называет операции и коды ошибок по-своему: имена из кода главнее, а расхождение записать в отчёт этапа.

- [ ] **Шаг 4. Исходный прогон.** Выполнить команды раздела «Где работать» (`pnpm build`, `pnpm test`, `pnpm typecheck && pnpm lint`, `pnpm --filter @parley/desktop e2e`) и записать числа по пакетам и исходные красные в отчёт этапа. Дальше «красное» означает «красное против этого прогона».

- [ ] **Шаг 5. Закоммитить нечего.** Задача ничего не меняет: коммита нет.

---

## Задача 2. Протокол: операция `open`, событие `browser.agentOp`, метод `browser.agentResult`

**Файлы:**
- Создать: `packages/protocol/src/browser-agent.ts`
- Изменить: `packages/protocol/src/events.ts`, `packages/protocol/src/methods.ts`, `packages/protocol/src/index.ts`
- Тест: `packages/protocol/src/browser-agent.test.ts`

**Интерфейсы:**
- Берёт: `SessionRef` (`types.ts`), `Events` и `METHODS`/`Results` (`events.ts`, `methods.ts`), `parseIncoming`.
- Отдаёт (индекс, «Протокол, хост, MCP»):
  - `BROWSER_AGENT_FEATURE = 'browser-agent'` — возможность окна в `hello.features`;
  - `BROWSER_AGENT_OPS = ['open'] as const` и `BrowserAgentOp`: C и D дописывают свои операции;
  - `BROWSER_AGENT_ERROR_CODES` (`not_loopback`, `access_denied`, `window_not_connected`, `timeout`, `unsupported`, `bad_request`) и `BrowserAgentErrorCode`: остальные коды спеки 5.1 добавляют C и D;
  - `AGENT_LIMITS = { opMs: 30_000, openMs: 10_000, requestBytes: 65_536 }`, `AGENT_INPUT = { url: 4096 }`;
  - типы `BrowserAgentOpEvent { opId, ref: SessionRef, label, op, args }`, `BrowserAgentResult` (`{ ok: true; result } | { ok: false; error: { code; message } }`), `BrowserAgentOpenResult { tab, url, reused, notes }`;
  - схемы `browserAgentArgs` (по операциям, строгие: лишнее поле — ошибка; `satisfies Record<BrowserAgentOp, z.ZodType>` не даст забыть схему новой операции), `BrowserAgentArgs<O>`, `browserAgentRequest` (тело `POST`), `browserAgentResultParams`;
  - событие хоста окну `'browser.agentOp': BrowserAgentOpEvent` и метод окна хосту `'browser.agentResult'` с результатом `{ accepted: boolean }`.

- [ ] **Шаг 1. Написать падающий тест.** Новый файл:

```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AGENT_INPUT,
  AGENT_LIMITS,
  BROWSER_AGENT_ERROR_CODES,
  BROWSER_AGENT_FEATURE,
  BROWSER_AGENT_OPS,
  browserAgentArgs,
  browserAgentRequest,
  browserAgentResultParams,
} from './browser-agent.js';
import type { BrowserAgentOpEvent, BrowserAgentOpenResult } from './browser-agent.js';
import type { EventData } from './events.js';
import * as protocol from './index.js';
import { METHODS } from './methods.js';
import type { Params, Result } from './methods.js';
import { parseIncoming } from './framing.js';

describe('канал агента к браузеру: константы (спека 3.7, 5.1, раздел 8; этап B2)', () => {
  it('возможность окна и единственная операция B2', () => {
    expect(BROWSER_AGENT_FEATURE).toBe('browser-agent');
    expect(BROWSER_AGENT_OPS).toEqual(['open']);
  });

  it('B2 отдаёт шесть кодов спеки 5.1', () => {
    expect([...BROWSER_AGENT_ERROR_CODES].sort()).toEqual([
      'access_denied',
      'bad_request',
      'not_loopback',
      'timeout',
      'unsupported',
      'window_not_connected',
    ]);
  });

  it('пределы: 30 с на операцию, 10 с окну на вкладку, 64 КБ на запрос; адрес до 4096 знаков', () => {
    expect(AGENT_LIMITS).toEqual({ opMs: 30_000, openMs: 10_000, requestBytes: 65_536 });
    expect(AGENT_INPUT).toEqual({ url: 4096 });
  });

  it('индекс пакета отдаёт имена канала', () => {
    expect(protocol.BROWSER_AGENT_FEATURE).toBe(BROWSER_AGENT_FEATURE);
    expect(protocol.browserAgentArgs).toBe(browserAgentArgs);
    expect(protocol.browserAgentRequest).toBe(browserAgentRequest);
    expect(protocol.browserAgentResultParams).toBe(browserAgentResultParams);
    expect(protocol.AGENT_LIMITS).toBe(AGENT_LIMITS);
  });
});

describe('схема аргументов open', () => {
  const ok = (args: unknown): boolean => browserAgentArgs.open.safeParse(args).success;

  it('url от одного знака до 4096; лишнее поле — в том числе tab и workKey — отказ', () => {
    expect(ok({ url: 'http://localhost:5173/' })).toBe(true);
    expect(ok({ url: 'x'.repeat(4096) })).toBe(true);
    for (const bad of [
      {},
      { url: '' },
      { url: 'x'.repeat(4097) },
      { url: 42 },
      { url: 'http://localhost/', tab: 't1' },
      { url: 'http://localhost/', workKey: '/p w-2' },
    ]) {
      expect(ok(bad), JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
  });

  it('запрос агента: op из списка, args — любые (их проверяет схема операции), лишнее поле — отказ', () => {
    expect(browserAgentRequest.safeParse({ op: 'open', args: { url: 'http://localhost/' } }).success).toBe(true);
    expect(browserAgentRequest.safeParse({ op: 'open' }).success).toBe(true);
    expect(browserAgentRequest.safeParse({ op: 'evaluate', args: {} }).success).toBe(false);
    expect(browserAgentRequest.safeParse({ op: 'open', args: {}, extra: 1 }).success).toBe(false);
  });
});

describe('метод browser.agentResult и событие browser.agentOp', () => {
  it('метод в общей таблице; успех и отказ с кодом из списка; opId обязателен', () => {
    expect(METHODS['browser.agentResult']).toBe(browserAgentResultParams);
    const parse = (params: unknown): boolean => browserAgentResultParams.safeParse(params).success;
    expect(parse({ opId: 'op-1', ok: true, result: { tab: 't1', url: 'http://localhost/', reused: false, notes: [] } })).toBe(true);
    expect(parse({ opId: 'op-1', ok: false, error: { code: 'not_loopback', message: 'Only localhost.' } })).toBe(true);
    expect(parse({ opId: 'op-1', ok: false, error: { code: 'boom', message: 'x' } })).toBe(false);
    expect(parse({ opId: '', ok: true, result: null })).toBe(false);
    expect(parse({ ok: true, result: null })).toBe(false);
    expect(parse({ opId: 'op-1', ok: true, result: null, extra: 1 })).toBe(false);
  });

  it('хост принимает вызов по общему разбору кадров: params проходят схему метода', () => {
    const line = { id: 7, method: 'browser.agentResult', params: { opId: 'op-1', ok: false, error: { code: 'timeout', message: 'x' } } };
    expect(parseIncoming(line)).toMatchObject({ kind: 'request', message: { method: 'browser.agentResult' } });
    expect(parseIncoming({ ...line, params: { opId: 'op-1' } })).toMatchObject({ kind: 'invalid' });
  });

  it('типы: параметры метода, ответ и событие', () => {
    expectTypeOf<Result<'browser.agentResult'>>().toEqualTypeOf<{ accepted: boolean }>();
    expectTypeOf<EventData<'browser.agentOp'>>().toEqualTypeOf<BrowserAgentOpEvent>();
    expectTypeOf<Params<'browser.agentResult'>>().toMatchTypeOf<{ opId: string }>();
    expectTypeOf<BrowserAgentOpenResult>().toEqualTypeOf<{ tab: string; url: string; reused: boolean; notes: string[] }>();
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/protocol exec vitest run src/browser-agent.test.ts` → FAIL: модуль `./browser-agent.js` не найден.

- [ ] **Шаг 3. Реализовать.** Новый файл:

```ts
import { z } from 'zod';
import type { SessionRef } from './types.js';

/**
 * Канал агента к встроенному браузеру окна (спека 2026-10-07-browser-devtools-agent-design.md, 3.7, 5.1; этап B2):
 * MCP-сервер сессии → `POST /agent/browser` хоста → событие `browser.agentOp` окну с возможностью `browser-agent` →
 * main окна исполняет → метод `browser.agentResult`. Схему аргументов проверяет хост до окна, main окна — у себя: ни
 * одна сторона не верит другой. Этап B2 даёт скелет и одну операцию, `open`; этапы C и D дописывают остальные.
 *
 * Core держит свою копию операций и пределов (`core/src/mcp/browser-tools.ts`): протокол зависит от core, обратного
 * импорта нет. Совпадение сверяет тест хоста `agent/browser-contract.test.ts`.
 */

/** Возможность окна в `hello.features`: оно исполняет операции агента над своим браузером. */
export const BROWSER_AGENT_FEATURE = 'browser-agent';

/**
 * Операции канала — по инструменту `browser_<op>` на каждую. Список растёт по этапам (порядок — индекс плана):
 * C ставит свои четыре чтения перед `open`, D дописывает управление после.
 */
export const BROWSER_AGENT_OPS = ['open'] as const;
export type BrowserAgentOp = (typeof BROWSER_AGENT_OPS)[number];

/** Коды отказов (спека 5.1). B2 отдаёт эти шесть; остальные коды спеки добавляют этапы C и D. */
export const BROWSER_AGENT_ERROR_CODES = [
  'not_loopback',
  'access_denied',
  'window_not_connected',
  'timeout',
  'unsupported',
  'bad_request',
] as const;
export type BrowserAgentErrorCode = (typeof BROWSER_AGENT_ERROR_CODES)[number];

/**
 * Пределы канала (спека, раздел 8). `opMs` — срок ответа окна хосту; `openMs` — сколько main ждёт, пока окно поставит
 * вкладку и ответит (вкладка встаёт за кадр, дольше — окно перезагружается или не слушает); `requestBytes` — тело
 * запроса агента.
 */
export const AGENT_LIMITS = {
  opMs: 30_000,
  openMs: 10_000,
  requestBytes: 65_536,
} as const;

/** Пределы ввода агента, которых нет в таблице спеки: длина адреса — та же, что у журнала вкладки (`DEVTOOLS_LIMITS.url`). */
export const AGENT_INPUT = { url: 4096 } as const;

/** Событие хоста окну. `label` — короткий номер сессии (`S02`) для тоста окна и журнала. */
export interface BrowserAgentOpEvent {
  opId: string;
  ref: SessionRef;
  label: string;
  op: BrowserAgentOp;
  args: unknown;
}

export type BrowserAgentResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: BrowserAgentErrorCode; message: string } };

/** Схемы аргументов по операциям; хост проверяет до окна, main окна — у себя. */
export const browserAgentArgs = {
  open: z.strictObject({ url: z.string().min(1).max(AGENT_INPUT.url) }),
} satisfies Record<BrowserAgentOp, z.ZodType>;

export type BrowserAgentArgs<O extends BrowserAgentOp> = z.infer<(typeof browserAgentArgs)[O]>;

/** Тело `POST /agent/browser`. */
export const browserAgentRequest = z.strictObject({ op: z.enum(BROWSER_AGENT_OPS), args: z.unknown().optional() });

const opId = z.string().min(1).max(64);

/** Параметры метода `browser.agentResult` (окно → хост). */
export const browserAgentResultParams = z.union([
  z.strictObject({ opId, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({
    opId,
    ok: z.literal(false),
    error: z.strictObject({ code: z.enum(BROWSER_AGENT_ERROR_CODES), message: z.string().max(2000) }),
  }),
]);

// ---- Формы ответов окна. Их читает MCP-сервер core своей копией формы (core/src/mcp/browser-tools.ts). ----

/**
 * `open`: вкладка работы, которую назвал агент. `url` — адрес, который прислал сам агент (без учётных данных); адреса
 * страницы, которую показывает вкладка, агент не получает. `reused` — вкладка работы с этой страницей уже была, новая не
 * открыта. `notes` — пояснения Parley.
 */
export interface BrowserAgentOpenResult {
  tab: string;
  url: string;
  reused: boolean;
  notes: string[];
}
```

  Событие в `src/events.ts`:

Правка 1 из 2.

После строк:

```ts
import type { BacklogChanged } from './backlog.js';
```

вставить:

```ts
import type { BrowserAgentOpEvent } from './browser-agent.js';
```

Правка 2 из 2.

После строк:

```ts
    mode: string | null;
    decisions?: FeedDecisions | null;
  };
```

вставить:

```ts
  /**
   * Операция агента над браузером окна (спека браузера 2026-10-07, 3.7): только клиенту с возможностью
   * `browser-agent` в `hello.features`, одному. Ответ — метод `browser.agentResult` с тем же `opId`.
   */
  'browser.agentOp': BrowserAgentOpEvent;
```

  Метод и его результат в `src/methods.ts`:

Правка 1 из 3.

После строк:

```ts
import { z } from 'zod';
```

вставить:

```ts
import { browserAgentResultParams } from './browser-agent.js';
```

Правка 2 из 3.

После строк:

```ts
  // «Stop» вида «Chat»: Esc агенту по нажатию человека; хост сам закрывает в ленте ход, который CLI бросил
  // без записи, и стирает из поля ввода терминала возвращённый туда текст промпта.
  'feed.interrupt': z.object({ ref: sessionRef }),
```

вставить:

```ts
  // Ответ окна на операцию агента (спека браузера 2026-10-07, 3.7): зовёт только main окна, хост принимает его только от
  // клиента, которому ушла операция.
  'browser.agentResult': browserAgentResultParams,
```

Правка 3 из 3.

После строк:

```ts
  /** `applied: false` — карточка уже не ждёт (ответили в терминале, второе нажатие); `state` — её состояние. */
  'feed.decide': { applied: boolean; state: FeedCardState };
  'feed.interrupt': { ok: true };
```

вставить:

```ts
  /** `accepted: false` — операция уже закрыта (срок, уход окна) или ушла другому клиенту. */
  'browser.agentResult': { accepted: boolean };
```

  Экспорты в `src/index.ts`:

После строк:

```ts
export { SHARED_FILE_PATH, HISTORY_SEARCH_MAX_LIMIT, HISTORY_SEARCH_DEFAULT_LIMIT, historySource, historyScope, historyHit, historySearchResult, historyMethodSchemas } from './history.js';
export type { HistoryHitView, HistorySearchView, HistoryMethodName, HistoryMethodParams, HistoryMethodResults } from './history.js';

```

вставить:

```ts
export {
  AGENT_INPUT,
  AGENT_LIMITS,
  BROWSER_AGENT_ERROR_CODES,
  BROWSER_AGENT_FEATURE,
  BROWSER_AGENT_OPS,
  browserAgentArgs,
  browserAgentRequest,
  browserAgentResultParams,
} from './browser-agent.js';
export type {
  BrowserAgentArgs,
  BrowserAgentErrorCode,
  BrowserAgentOp,
  BrowserAgentOpEvent,
  BrowserAgentOpenResult,
  BrowserAgentResult,
} from './browser-agent.js';

```

- [ ] **Шаг 4. Запустить — проходит.**
  - `pnpm --filter @parley/protocol exec vitest run src/browser-agent.test.ts` → PASS.
  - `pnpm --filter @parley/protocol exec vitest run` → PASS целиком (метод `browser.agentResult` попал в таблицы `METHODS` и `Results`, прежние проверки списка методов не сломаны).
  - `pnpm --filter @parley/protocol build` → без ошибок: хост, core и окно читают протокол из `dist`.
  - Тест хоста `src/server.test.ts` («methods — ровно ключи METHODS и NOTIFICATIONS») станет красным до задачи 5: протокол уже знает метод `browser.agentResult`, а обработчик хост заведёт там. Коммит этой задачи его не чинит — это ожидаемо, задача 5 его закрывает.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/protocol/src/browser-agent.ts packages/protocol/src/browser-agent.test.ts packages/protocol/src/events.ts packages/protocol/src/methods.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): канал агента к браузеру — операция open, событие browser.agentOp и метод browser.agentResult" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Задача 3. Хост: приёмник операций агента `agent/browser-endpoint.ts`

**Файлы:**
- Создать: `packages/host/src/agent/browser-endpoint.ts`
- Тест: `packages/host/src/agent/browser-endpoint.test.ts`

**Интерфейсы:**
- Берёт (задача 2): `AGENT_LIMITS`, `BROWSER_AGENT_FEATURE`, `browserAgentArgs`, `browserAgentRequest`, `refKey`, типы `BrowserAgentOp`, `BrowserAgentOpEvent`, `BrowserAgentResult`, `BrowserAgentErrorCode`, `SessionRef`; `sessionTag` из `@parley/core`; `Client` (`id`, `name`, `features`, `send`) и `Log` хоста.
- Отдаёт: `AGENT_BROWSER_PATH = '/agent/browser'` и `createBrowserEndpoint({ log, clients(), timeoutMs? }): BrowserEndpoint`, где `BrowserEndpoint`:
  - `register(ref: SessionRef): string` — токен запуска (32 байта hex); прежний токен той же сессии отзывается;
  - `unregister(ref)` — отзывает токен сессии;
  - `handle(req, res)` — обработчик пути для сервера хуков (задача 5);
  - `resolve(opId, result, from: Client): boolean` — ответ окна (`browser.agentResult`); `false`, если операции нет (закрыта сроком или уходом окна) или ответил не тот клиент, которому она ушла;
  - `dropClient(client)` — окно ушло: его висящие операции получают `window_not_connected`;
  - `close()` — остановка хоста: всем висящим — `window_not_connected`.
- Поведение (спека 3.7):
  - токен в `Authorization: Bearer …` находит `SessionRef`; не узнан — 401 без тела, тело больше `AGENT_LIMITS.requestBytes` — 413 без тела, соединение закрывается;
  - всё остальное — 200 и `BrowserAgentResult`: агенту нужны код и текст, а не статус HTTP. Тело не JSON, неизвестная операция или аргументы не по схеме — `bad_request` и окну ничего;
  - операция уходит **одному** окну — последнему подключившемуся клиенту с `browser-agent` в `features`. Окна нет — `window_not_connected`; есть только `desktop` без этой возможности (окно старой сборки) — `unsupported`; окно молчит `AGENT_LIMITS.opMs` — `timeout`; агент оборвал запрос — операция закрывается, поздний ответ окна не принимается;
  - событие окну: `{ opId: <uuid>, ref, label: sessionTag(ref.sessionId), op, args }`;
  - одна строка журнала на операцию (`log.info('операция агента в браузере', …)`): проект, работа, сессия, операция, вкладка, origin, исход, миллисекунды. Origin берётся из адреса аргументов или результата, путь, query и фрагмент в строку не идут.

- [ ] **Шаг 1. Написать падающий тест.** Новый файл:

```ts
/**
 * Приёмник операций агента (спека браузера 2026-10-07, 3.7; этап B2) на настоящем `node:http`: токен сессии, схема
 * протокола, одно окно с возможностью `browser-agent`, ответ окна, срок, уход окна и журнал без путей адресов и токенов.
 */
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_AGENT_FEATURE } from '@parley/protocol';
import type { BrowserAgentOpEvent, EventMessage, ResponseMessage, SessionRef } from '@parley/protocol';
import { silentLog } from '../../test/feed-fakes.js';
import type { Client } from '../client.js';
import { createBrowserEndpoint } from './browser-endpoint.js';

const REF: SessionRef = { projectPath: '/proj', workId: 'w-1', sessionId: 's-02' };
const OTHER: SessionRef = { projectPath: '/proj', workId: 'w-2', sessionId: 's-01' };
const PAGE = 'http://localhost:5173/';

type FakeClient = Client & { sent: Array<ResponseMessage | EventMessage> };

let counter = 0;
/** Клиент хоста: окно нынешней сборки заявляет `browser-agent`, окно старой — нет. */
function fakeWindow(features: string[] = [BROWSER_AGENT_FEATURE], name = 'desktop'): FakeClient {
  counter += 1;
  const sent: Array<ResponseMessage | EventMessage> = [];
  return {
    id: `client-${counter}`,
    name,
    features: new Set(features),
    sent,
    send(message) {
      sent.push(message);
      return true;
    },
    writableLength: () => 0,
    close() {},
  };
}

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers = [];
});

async function boot(clients: Client[], timeoutMs?: number) {
  const log = silentLog();
  const endpoint = createBrowserEndpoint({ log, clients: () => clients, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const server = createServer((req, res) => endpoint.handle(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent/browser`;
  return { endpoint, url, log, token: endpoint.register(REF) };
}

interface Reply {
  status: number;
  body: string;
}

function post(url: string, body: unknown, token: string | null): Promise<Reply> {
  const target = new URL(url);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const json = (reply: Reply): unknown => JSON.parse(reply.body);

/** Ждёт `index`-ю операцию, ушедшую окну. */
async function nextOp(client: FakeClient, index = 0): Promise<BrowserAgentOpEvent> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const ops = client.sent.filter((message): message is EventMessage => 'event' in message && message.event === 'browser.agentOp');
    const op = ops[index];
    if (op !== undefined) return op.data as BrowserAgentOpEvent;
    if (Date.now() > deadline) throw new Error('операция до окна не дошла');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const OPENED = { ok: true as const, result: { tab: 't1', url: PAGE, reused: false, notes: [] } };

describe('доступ: токен сессии (Фокус ревью, п. 1)', () => {
  it('нет токена, чужой и отозванный — 401 без тела; окну ничего; токена в журнале нет', async () => {
    const window = fakeWindow();
    const { endpoint, url, token, log } = await boot([window]);
    expect(await post(url, { op: 'open', args: { url: PAGE } }, null)).toEqual({ status: 401, body: '' });
    expect(await post(url, { op: 'open', args: { url: PAGE } }, 'f'.repeat(64))).toEqual({ status: 401, body: '' });
    endpoint.unregister(REF);
    expect(await post(url, { op: 'open', args: { url: PAGE } }, token)).toEqual({ status: 401, body: '' });
    expect(window.sent).toEqual([]);
    expect(JSON.stringify([vi.mocked(log.warn).mock.calls, vi.mocked(log.info).mock.calls])).not.toContain(token);
  });

  it('перезапуск сессии: новый токен, старый — 401; токен другой сессии ведёт к ней, и работа события — её, а не названная агентом', async () => {
    const window = fakeWindow();
    const { endpoint, url, token } = await boot([window]);
    const other = endpoint.register(OTHER);
    const again = endpoint.register(REF);
    expect(again).toMatch(/^[0-9a-f]{64}$/);
    expect(again).not.toBe(token);
    expect((await post(url, { op: 'open', args: { url: PAGE } }, token)).status).toBe(401);
    // Работу агент назвать не может: схема строгая, лишнее поле — отказ, окну ничего не уходит.
    const forged = json(await post(url, { op: 'open', args: { url: PAGE, workKey: '/proj w-1' } }, other)) as { error: { code: string } };
    expect(forged.error.code).toBe('bad_request');
    expect(window.sent).toEqual([]);
    const reply = post(url, { op: 'open', args: { url: PAGE } }, other);
    const op = await nextOp(window);
    expect(op.ref).toEqual(OTHER);
    endpoint.resolve(op.opId, OPENED, window);
    expect((await reply).status).toBe(200);
  });
});

describe('операция до окна и ответ', () => {
  it('операция уходит окну с browser-agent: opId, ref, метка S02, op, args; ответ окна — агенту как есть', async () => {
    const plain = fakeWindow([]);
    const window = fakeWindow();
    const { endpoint, url, token } = await boot([window, plain]);
    const reply = post(url, { op: 'open', args: { url: PAGE } }, token);
    const op = await nextOp(window);
    expect(op).toMatchObject({ ref: REF, label: 'S02', op: 'open', args: { url: PAGE } });
    expect(op.opId).toMatch(/^[0-9a-f-]{36}$/);
    expect(plain.sent).toEqual([]);
    expect(endpoint.resolve(op.opId, OPENED, window)).toBe(true);
    expect(json(await reply)).toEqual(OPENED);
  });

  it('два окна с возможностью — операция только последнему подключившемуся', async () => {
    const first = fakeWindow();
    const second = fakeWindow();
    const { endpoint, url, token } = await boot([first, second]);
    const reply = post(url, { op: 'open', args: { url: PAGE } }, token);
    const op = await nextOp(second);
    expect(first.sent).toEqual([]);
    endpoint.resolve(op.opId, OPENED, second);
    expect((await reply).status).toBe(200);
  });

  it('окон нет — сразу window_not_connected; есть только окно старой сборки — unsupported', async () => {
    const none = await boot([]);
    expect(json(await post(none.url, { op: 'open', args: { url: PAGE } }, none.token))).toMatchObject({ ok: false, error: { code: 'window_not_connected' } });
    const old = await boot([fakeWindow([])]);
    expect(json(await post(old.url, { op: 'open', args: { url: PAGE } }, old.token))).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  });

  it('схема: неизвестная операция, неверные аргументы, не JSON — bad_request, окну ничего', async () => {
    const window = fakeWindow();
    const { url, token } = await boot([window]);
    for (const body of [
      { op: 'evaluate', args: { code: '1' } },
      { op: 'open', args: {} },
      { op: 'open', args: { url: 'x'.repeat(5000) } },
      { op: 'open', args: { url: PAGE, tab: 't1' } },
      '{"op":',
    ]) {
      const reply = json(await post(url, body, token)) as { ok: boolean; error: { code: string } };
      expect(reply.error.code, JSON.stringify(body).slice(0, 60)).toBe('bad_request');
    }
    expect(window.sent).toEqual([]);
  });

  it('тело больше 64 КБ — 413', async () => {
    const { url, token } = await boot([fakeWindow()]);
    const big = JSON.stringify({ op: 'open', args: { url: PAGE }, pad: 'x'.repeat(70_000) });
    // Сервер мог оборвать соединение раньше, чем клиент дописал тело: это тоже отказ по размеру.
    const status = await post(url, big, token).then(
      (reply) => reply.status,
      (error: NodeJS.ErrnoException) => (error.code === 'EPIPE' || error.code === 'ECONNRESET' ? 413 : Promise.reject(error)),
    );
    expect(status).toBe(413);
  });
});

describe('сроки и уход окна (Фокус ревью, п. 4)', () => {
  it('окно молчит дольше срока — timeout; поздний ответ не принят', async () => {
    const window = fakeWindow();
    const { endpoint, url, token } = await boot([window], 50);
    const reply = post(url, { op: 'open', args: { url: PAGE } }, token);
    const op = await nextOp(window);
    expect(json(await reply)).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(endpoint.resolve(op.opId, OPENED, window)).toBe(false);
  });

  it('окно ушло посреди операции — сразу window_not_connected; ответ чужого клиента не принят', async () => {
    const stranger = fakeWindow();
    const window = fakeWindow();
    const { endpoint, url, token } = await boot([stranger, window]);
    const reply = post(url, { op: 'open', args: { url: PAGE } }, token);
    const op = await nextOp(window);
    expect(endpoint.resolve(op.opId, OPENED, stranger)).toBe(false);
    const started = Date.now();
    endpoint.dropClient(window);
    expect(json(await reply)).toMatchObject({ ok: false, error: { code: 'window_not_connected' } });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('close(): висящим — window_not_connected', async () => {
    const window = fakeWindow();
    const { endpoint, url, token } = await boot([window]);
    const reply = post(url, { op: 'open', args: { url: PAGE } }, token);
    await nextOp(window);
    endpoint.close();
    expect(json(await reply)).toMatchObject({ ok: false, error: { code: 'window_not_connected' } });
  });
});

describe('журнал хоста', () => {
  it('одна строка на операцию: сессия, операция, вкладка, origin, исход — без пути и query адреса, без токена', async () => {
    const window = fakeWindow();
    const { endpoint, url, token, log } = await boot([window]);
    const asked = 'http://localhost:5173/settings/ARG-PATH?token=URL-SECRET#HASH-SECRET';
    const reply = post(url, { op: 'open', args: { url: asked } }, token);
    const op = await nextOp(window);
    endpoint.resolve(op.opId, { ok: true, result: { tab: 't1', url: asked, reused: false, notes: [] } }, window);
    await reply;
    const lines = vi.mocked(log.info).mock.calls.filter(([message]) => message === 'операция агента в браузере');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]).toEqual({
      projectPath: '/proj',
      workId: 'w-1',
      sessionId: 's-02',
      op: 'open',
      tab: 't1',
      origin: 'http://localhost:5173',
      outcome: 'ok',
      ms: expect.any(Number),
    });
    const all = JSON.stringify(vi.mocked(log.info).mock.calls);
    for (const secret of ['ARG-PATH', 'URL-SECRET', 'HASH-SECRET', token]) expect(all).not.toContain(secret);
  });

  it('отказ окна и отсутствие окна тоже в журнале: исход — код; адрес не из http — origin пуст', async () => {
    const window = fakeWindow();
    const { endpoint, url, token, log } = await boot([window]);
    const reply = post(url, { op: 'open', args: { url: 'javascript:alert(1)' } }, token);
    const op = await nextOp(window);
    endpoint.resolve(op.opId, { ok: false, error: { code: 'not_loopback', message: 'Only localhost.' } }, window);
    await reply;
    const none = await boot([]);
    await post(none.url, { op: 'open', args: { url: PAGE } }, none.token);
    expect(vi.mocked(log.info).mock.calls.at(-1)?.[1]).toMatchObject({ op: 'open', tab: null, origin: null, outcome: 'not_loopback' });
    expect(vi.mocked(none.log.info).mock.calls.at(-1)?.[1]).toMatchObject({ outcome: 'window_not_connected', origin: 'http://localhost:5173', ms: 0 });
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/protocol build && pnpm --filter @parley/host exec vitest run src/agent/browser-endpoint.test.ts` → FAIL: модуль `./browser-endpoint.js` не найден.

- [ ] **Шаг 3. Реализовать.** Новый файл:

```ts
/**
 * Приёмник операций агента над браузером окна (спека 2026-10-07-browser-devtools-agent-design.md, 3.7; этап B2): путь
 * `POST /agent/browser` на том же HTTP-сервере 127.0.0.1, что принимает хуки (`hooks/hook-server.ts`, параметр
 * `routes`), но свой реестр токенов: у Codex хуков нет, а канал агента нужен всем провайдерам.
 *
 * Отказы доступа — без тела, как у хуков: токен — 401, тело больше 64 КБ — 413. Остальное — 200 и
 * `BrowserAgentResult`: агенту нужен код и текст, а не статус HTTP. Операция уходит одному окну — последнему
 * подключившемуся клиенту с возможностью `browser-agent`: два окна не должны исполнить одну операцию дважды. Окна нет —
 * `window_not_connected`, есть только окно старой сборки — `unsupported` (спека 9), окно молчит `AGENT_LIMITS.opMs` —
 * `timeout`, окно ушло — `window_not_connected` сразу. Ответ принимается только от клиента, которому ушла операция.
 *
 * Сессию находит токен, а не тело: работу операции задаёт хост (`ref` события), агент назвать чужую не может.
 *
 * Журнал — одна строка на операцию: сессия, операция, вкладка, origin, исход. Аргументов, путей и query адресов,
 * данных страницы и токенов в нём нет.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sessionTag } from '@parley/core';
import { AGENT_LIMITS, BROWSER_AGENT_FEATURE, browserAgentArgs, browserAgentRequest, refKey } from '@parley/protocol';
import type { BrowserAgentErrorCode, BrowserAgentOp, BrowserAgentOpEvent, BrowserAgentResult, SessionRef } from '@parley/protocol';
import type { Client } from '../client.js';
import type { Log } from '../log.js';

/** Путь приёмника на сервере хуков; адрес для MCP-сервера — `<origin сервера хуков><путь>`. */
export const AGENT_BROWSER_PATH = '/agent/browser';

export interface BrowserEndpointOptions {
  log: Log;
  /** Клиенты хоста; окно — клиент с `browser-agent` в `hello.features`. */
  clients(): readonly Client[];
  /** Срок ответа окна; по умолчанию `AGENT_LIMITS.opMs`. Тестам — меньше. */
  timeoutMs?: number;
}

export interface BrowserEndpoint {
  /** Токен запуска сессии для `PARLEY_AGENT_TOKEN`: 32 байта hex. Прежний токен той же сессии отзывается. */
  register(ref: SessionRef): string;
  /** Отзывает токен сессии: её запросы дальше — 401. */
  unregister(ref: SessionRef): void;
  /** Обработчик пути `AGENT_BROWSER_PATH` для сервера хуков. */
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** Ответ окна (`browser.agentResult`). `false` — операции нет (закрыта сроком или уходом окна) или ответил не тот клиент. */
  resolve(opId: string, result: BrowserAgentResult, from: Client): boolean;
  /** Окно ушло: его операции сразу получают `window_not_connected`. */
  dropClient(client: Client): void;
  /** Остановка хоста: всем висящим — `window_not_connected`. */
  close(): void;
}

interface Pending {
  client: Client;
  ref: SessionRef;
  op: BrowserAgentOp;
  args: unknown;
  startedAt: number;
  timer: NodeJS.Timeout;
  reply(result: BrowserAgentResult): void;
}

const failure = (code: BrowserAgentErrorCode, message: string): BrowserAgentResult => ({ ok: false, error: { code, message } });

/** Строка заголовка; у повторённого заголовка Node отдаёт массив — такой не принимаем. */
const headerOf = (req: IncomingMessage, name: string): string | null => {
  const value = req.headers[name];
  return typeof value === 'string' ? value : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Поле объекта, если это строка. */
function stringField(value: unknown, name: string): string | null {
  return isRecord(value) && typeof value[name] === 'string' ? value[name] : null;
}

/** Origin первого разбираемого адреса — только для журнала: путь, query и hash в него не идут. */
function originOf(...candidates: Array<string | null>): string | null {
  for (const candidate of candidates) {
    if (candidate === null) continue;
    try {
      const { origin } = new URL(candidate);
      if (origin !== 'null') return origin;
    } catch {
      // Не адрес — следующий кандидат.
    }
  }
  return null;
}

export function createBrowserEndpoint(options: BrowserEndpointOptions): BrowserEndpoint {
  const { log } = options;
  const timeoutMs = options.timeoutMs ?? AGENT_LIMITS.opMs;
  const byToken = new Map<string, SessionRef>();
  const tokenOfSession = new Map<string, string>();
  const pending = new Map<string, Pending>();

  function send(res: ServerResponse, result: BrowserAgentResult): void {
    if (res.writableEnded || res.destroyed) return;
    const payload = JSON.stringify(result);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) });
    res.end(payload);
  }

  /** Отказ без тела; соединение закрывается — недочитанное тело дальше не читается. */
  function refuse(req: IncomingMessage, res: ServerResponse, status: 401 | 413, reason: string): void {
    if (!res.headersSent) {
      log.warn('операция агента отклонена', { status, reason });
      res.writeHead(status, { 'Content-Length': '0', Connection: 'close' });
    }
    res.end(() => req.socket.destroy());
  }

  function record(ref: SessionRef, op: BrowserAgentOp, args: unknown, result: BrowserAgentResult, ms: number): void {
    log.info('операция агента в браузере', {
      projectPath: ref.projectPath,
      workId: ref.workId,
      sessionId: ref.sessionId,
      op,
      tab: stringField(args, 'tab') ?? (result.ok ? stringField(result.result, 'tab') : null),
      origin: originOf(stringField(args, 'url'), result.ok ? stringField(result.result, 'url') : null),
      outcome: result.ok ? 'ok' : result.error.code,
      ms,
    });
  }

  function finish(opId: string, result: BrowserAgentResult): void {
    const entry = pending.get(opId);
    if (entry === undefined) return;
    pending.delete(opId);
    clearTimeout(entry.timer);
    record(entry.ref, entry.op, entry.args, result, Date.now() - entry.startedAt);
    entry.reply(result);
  }

  function dispatch(ref: SessionRef, body: unknown, res: ServerResponse): void {
    const request = browserAgentRequest.safeParse(body);
    if (!request.success) {
      send(res, failure('bad_request', 'Unknown browser operation or malformed request.'));
      return;
    }
    const { op } = request.data;
    const args = browserAgentArgs[op].safeParse(request.data.args ?? {});
    if (!args.success) {
      const issue = args.error.issues[0];
      const where = issue === undefined || issue.path.length === 0 ? 'args' : issue.path.join('.');
      send(res, failure('bad_request', `Invalid arguments for ${op}: ${where} — ${issue?.message ?? 'invalid'}.`));
      return;
    }
    const clients = options.clients();
    const window = clients.filter((client) => client.features.has(BROWSER_AGENT_FEATURE)).at(-1);
    if (window === undefined) {
      const old = clients.some((client) => client.name === 'desktop');
      const result = old
        ? failure('unsupported', "Parley's window is older than its host and cannot run browser operations: ask the human to restart Parley.")
        : failure('window_not_connected', "Parley's window is not connected to the host: ask the human to open Parley.");
      record(ref, op, args.data, result, 0);
      send(res, result);
      return;
    }
    const opId = randomUUID();
    const timer = setTimeout(
      () => finish(opId, failure('timeout', `The window did not answer within ${Math.round(timeoutMs / 1000)} s.`)),
      timeoutMs,
    );
    pending.set(opId, { client: window, ref, op, args: args.data, startedAt: Date.now(), timer, reply: (result) => send(res, result) });
    // Агент оборвал запрос (MCP-клиент отменил вызов): операцию закрываем, поздний ответ окна уже не примется.
    res.on('close', () => {
      if (pending.has(opId)) finish(opId, failure('timeout', 'The agent cancelled the request.'));
    });
    const event: BrowserAgentOpEvent = { opId, ref, label: sessionTag(ref.sessionId), op, args: args.data };
    window.send({ event: 'browser.agentOp', data: event });
  }

  return {
    register(ref) {
      const key = refKey(ref);
      const previous = tokenOfSession.get(key);
      if (previous !== undefined) byToken.delete(previous);
      const token = randomBytes(32).toString('hex');
      byToken.set(token, { ...ref });
      tokenOfSession.set(key, token);
      return token;
    },
    unregister(ref) {
      const key = refKey(ref);
      const token = tokenOfSession.get(key);
      if (token === undefined) return;
      tokenOfSession.delete(key);
      byToken.delete(token);
    },
    handle(req, res) {
      const auth = headerOf(req, 'authorization');
      const token = auth?.startsWith('Bearer ') === true ? auth.slice('Bearer '.length).trim() : '';
      const ref = token === '' ? undefined : byToken.get(token);
      if (ref === undefined) {
        refuse(req, res, 401, 'token');
        return;
      }
      const declared = Number(headerOf(req, 'content-length') ?? '0');
      if (Number.isFinite(declared) && declared > AGENT_LIMITS.requestBytes) {
        refuse(req, res, 413, 'body-size');
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let rejected = false;
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        size += chunk.length;
        if (size > AGENT_LIMITS.requestBytes) {
          rejected = true;
          chunks.length = 0;
          req.pause();
          refuse(req, res, 413, 'body-size');
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => {
        rejected = true;
      });
      req.on('end', () => {
        if (rejected) return;
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
        } catch {
          send(res, failure('bad_request', 'The request body is not JSON.'));
          return;
        }
        dispatch(ref, body, res);
      });
    },
    resolve(opId, result, from) {
      const entry = pending.get(opId);
      if (entry === undefined || entry.client.id !== from.id) return false;
      finish(opId, result);
      return true;
    },
    dropClient(client) {
      for (const [opId, entry] of [...pending]) {
        if (entry.client.id === client.id) finish(opId, failure('window_not_connected', "Parley's window disconnected during the operation."));
      }
    },
    close() {
      for (const opId of [...pending.keys()]) finish(opId, failure('window_not_connected', 'The Parley host is shutting down.'));
    },
  };
}
```

- [ ] **Шаг 4. Запустить — проходит.**
  - `pnpm --filter @parley/host exec vitest run src/agent/browser-endpoint.test.ts` → PASS.
  - `pnpm --filter @parley/host exec vitest run src/english-text.test.ts` → PASS: в строковых литералах хоста нет кириллицы (журнал `log.info` — первый аргумент по-русски допустим, ответы агенту — английские).
  - Типы: `pnpm --filter @parley/host build` → без ошибок.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/host/src/agent/browser-endpoint.ts packages/host/src/agent/browser-endpoint.test.ts
git commit -m "feat(host): приёмник операций агента над браузером — токены сессий, одно окно, сроки" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Задача 4. Core: адрес и токен канала в конфиге MCP-сервера

**Файлы:**
- Изменить: `packages/core/src/work/mcp-config.ts`, `packages/core/src/mcp/context.ts`, `packages/core/src/work/launch.ts`, `packages/core/src/index.ts`, `packages/core/test/frame-check.test.ts`
- Тесты: `packages/core/src/work/mcp-config.test.ts`, `packages/core/src/mcp/context.test.ts`, `packages/core/src/work/launch.test.ts`

**Интерфейсы:**
- Берёт: `bothEnv`, `SESSION_VARIABLES`, `codexServerEnv`, `writeMcpConfig` (`mcp-config.ts`), `contextFromEnv` и `McpContext` (`context.ts`), `LaunchOptions` и `planLaunch`/`planNew`/`planResume` (`launch.ts`).
- Отдаёт (индекс: «Окружение MCP-сервера»):
  - `interface AgentChannel { url: string; token: string }`, `AGENT_URL_ENV = 'PARLEY_AGENT_URL'`, `AGENT_TOKEN_ENV = 'PARLEY_AGENT_TOKEN'` — все три экспортируются из `@parley/core`;
  - `McpConfigParams.agent?: AgentChannel` — адрес и токен кладутся в `env` сервера `parley` одинаково у Claude, GLM (файл) и Codex (`-c mcp_servers.parley=…`); только под новыми именами, прежних `HARNAS_AGENT_*` нет;
  - `LaunchOptions.agent?: AgentChannel` — хост передаёт его каждому запуску (задача 5); в окружение процесса и в argv Claude канал не попадает, только в конфиг;
  - файл конфига MCP пишется с правами 0600 — и когда его нет, и когда он уже лежит с 0644;
  - `McpContext.agent?: AgentChannel` — сервер читает канал из своего окружения, но принимает его, только если адрес — `http://127.0.0.1:<порт>/agent/browser`, а токен — 64 символа hex (сервер не пойдёт по чужому адресу с токеном сессии);
  - унаследованные `PARLEY_AGENT_URL` и `PARLEY_AGENT_TOKEN` процесса не перекрывают заданные: имена входят в `SESSION_VARIABLES` (хост, поднятый из сессии агента, унаследовал бы её канал).
- Рамочный тест `core/test/frame-check.test.ts` закрепляет места совпадений своих регэкспов по строкам: правки `mcp-config.ts` сдвигают комментарий про `~/.codex/config.toml` с 160-й строки на 191-ю. Это не нарушение рамки, а сдвиг номера: шаг 5.

- [ ] **Шаг 1. Написать падающие тесты.** В `mcp-config.test.ts` — импорт и тесты канала:

Правка 1 из 2.

Заменить:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
```

на:

```ts
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
```

Правка 2 из 2.

После строк:

```ts
      expect(env.HARNAS_SKILL_LIST_REDUCED).toBe('1');
    }
  });
});

```

вставить:

```ts
describe('канал агента к браузеру (спека браузера 3.7; этап B2)', () => {
  const agent = { url: 'http://127.0.0.1:4321/agent/browser', token: 'ab'.repeat(32) };

  it('Claude: адрес и токен — в env сервера, только под именами PARLEY_*', () => {
    const env = mcpConfig({ ...params, agent }).mcpServers[MCP_SERVER_NAME]?.env;
    expect(env).toEqual({ ...SESSION_ENV, PARLEY_AGENT_URL: agent.url, PARLEY_AGENT_TOKEN: agent.token });
    expect(env).not.toHaveProperty('HARNAS_AGENT_URL');
    expect(env).not.toHaveProperty('HARNAS_AGENT_TOKEN');
  });

  it('Codex: тот же канал в таблице env; унаследованный от хоста канал не перекрывает свой', () => {
    const inherited = {
      PARLEY_AGENT_URL: 'http://127.0.0.1:1/agent/browser',
      PARLEY_AGENT_TOKEN: 'cd'.repeat(32),
      HARNAS_AGENT_TOKEN: 'ef'.repeat(32),
      PARLEY_HOME: '/tmp/дом',
    };
    const { value } = parseTomlAssignment(codexMcpOverride({ ...params, agent, env: inherited }));
    expect((value as Record<string, TomlValue>)['env']).toEqual({
      ...SESSION_ENV,
      PARLEY_AGENT_URL: agent.url,
      PARLEY_AGENT_TOKEN: agent.token,
      PARLEY_HOME: '/tmp/дом',
    });
  });

  it('без канала переменных канала нет ни у Claude, ни у Codex — и унаследованные не просачиваются (токен чужой сессии)', () => {
    expect(mcpConfig(params).mcpServers[MCP_SERVER_NAME]?.env).not.toHaveProperty('PARLEY_AGENT_TOKEN');
    const inherited = { PARLEY_AGENT_TOKEN: 'cd'.repeat(32), HARNAS_AGENT_URL: 'http://127.0.0.1:1/agent/browser' };
    const { value } = parseTomlAssignment(codexMcpOverride({ ...params, env: inherited }));
    expect((value as Record<string, TomlValue>)['env']).toEqual(SESSION_ENV);
  });
});

describe('writeMcpConfig: токен канала агента (спека браузера 3.7; этап B2)', () => {
  let home = '';
  let project = '';
  const agent = { url: 'http://127.0.0.1:4321/agent/browser', token: 'ab'.repeat(32) };

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
    project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
    process.env.PARLEY_HOME = home;
    await createWork(project, { title: 'Авторизация' });
  });

  afterEach(async () => {
    delete process.env.PARLEY_HOME;
    await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('канал пишется в файл, а файл — с правами 0600: в нём токен', async () => {
    const file = await writeMcpConfig(project, 'w-0001', 's-01', undefined, false, { agent });
    const written = JSON.parse(await readFile(file, 'utf8')) as ReturnType<typeof mcpConfig>;
    expect(written.mcpServers[MCP_SERVER_NAME]?.env['PARLEY_AGENT_TOKEN']).toBe(agent.token);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('файл прежнего запуска с правами 0644 при новом запуске закрывается до 0600, а токен в нём — новый', async () => {
    const first = await writeMcpConfig(project, 'w-0001', 's-01');
    await chmod(first, 0o644);
    const again = await writeMcpConfig(project, 'w-0001', 's-01', undefined, false, { agent });
    expect(again).toBe(first);
    expect((await stat(again)).mode & 0o777).toBe(0o600);
    expect(await readFile(again, 'utf8')).toContain(agent.token);
  });

  it('без канала в файле его нет', async () => {
    const file = await writeMcpConfig(project, 'w-0001', 's-01');
    expect(await readFile(file, 'utf8')).not.toContain('AGENT');
  });
});

```

  В `mcp/context.test.ts`:

После строк:

```ts
  });
});

```

вставить:

```ts
describe('канал агента к браузеру (спека браузера 3.7; этап B2)', () => {
  const token = 'ab'.repeat(32);
  const url = 'http://127.0.0.1:4321/agent/browser';

  it('адрес 127.0.0.1…/agent/browser и токен из 64 hex — канал есть', () => {
    expect(contextFromEnv({ ...base, PARLEY_AGENT_URL: url, PARLEY_AGENT_TOKEN: token }).agent).toEqual({ url, token });
  });

  it('нет одной из переменных, чужой хост, путь или схема, короткий токен, прежние имена — канала нет', () => {
    for (const env of [
      { PARLEY_AGENT_URL: url },
      { PARLEY_AGENT_TOKEN: token },
      { PARLEY_AGENT_URL: 'http://evil.example:4321/agent/browser', PARLEY_AGENT_TOKEN: token },
      { PARLEY_AGENT_URL: 'http://localhost:4321/agent/browser', PARLEY_AGENT_TOKEN: token },
      { PARLEY_AGENT_URL: 'http://127.0.0.1:4321/hooks', PARLEY_AGENT_TOKEN: token },
      { PARLEY_AGENT_URL: 'https://127.0.0.1:4321/agent/browser', PARLEY_AGENT_TOKEN: token },
      { PARLEY_AGENT_URL: 'not a url', PARLEY_AGENT_TOKEN: token },
      { PARLEY_AGENT_URL: url, PARLEY_AGENT_TOKEN: 'short' },
      { PARLEY_AGENT_URL: url, PARLEY_AGENT_TOKEN: token.toUpperCase() },
      { HARNAS_AGENT_URL: url, HARNAS_AGENT_TOKEN: token },
    ]) {
      expect(contextFromEnv({ ...base, ...env }), JSON.stringify(env)).not.toHaveProperty('agent');
    }
  });
});

```

  В `work/launch.test.ts` (в конец файла):

После строк:

```ts
    expect(plan.providerSessionId).toBe('glm-conversation');
  });
});

```

вставить:

```ts
describe('канал агента к браузеру в запуске (спека браузера 3.7; этап B2)', () => {
  const agent = { url: 'http://127.0.0.1:4321/agent/browser', token: 'ab'.repeat(32) };
  const mcpEnvOf = async (args: string[]): Promise<Record<string, string>> => {
    const file = args[args.indexOf('--mcp-config') + 1] as string;
    return (JSON.parse(await readFile(file, 'utf8')) as { mcpServers: { parley: { env: Record<string, string> } } }).mcpServers.parley.env;
  };

  it('адрес и токен — в env сервера parley у claude (файл 0600) и codex (-c), не в окружении процесса и не в argv claude', async () => {
    const claude = await pending('claude');
    const plan = await planLaunch(project, claude.workId, await sessionOf(claude.workId, claude.sessionId), { agent });
    expect(await mcpEnvOf(plan.args)).toMatchObject({ PARLEY_AGENT_URL: agent.url, PARLEY_AGENT_TOKEN: agent.token });
    expect(plan.env).not.toHaveProperty('PARLEY_AGENT_TOKEN');
    expect(plan.env).not.toHaveProperty('PARLEY_AGENT_URL');
    expect(plan.args.join('\n')).not.toContain(agent.token);
    expect((await stat(plan.args[plan.args.indexOf('--mcp-config') + 1] as string)).mode & 0o777).toBe(0o600);

    const codex = await pending('codex');
    const codexPlan = await planLaunch(project, codex.workId, await sessionOf(codex.workId, codex.sessionId), { agent });
    const table = parseTomlAssignment(codexPlan.args.find((arg) => arg.startsWith('mcp_servers.parley=')) as string).value as Record<string, TomlValue>;
    expect(table['env']).toMatchObject({ PARLEY_AGENT_URL: agent.url, PARLEY_AGENT_TOKEN: agent.token });
    expect(codexPlan.env).not.toHaveProperty('PARLEY_AGENT_TOKEN');
  });

  it('без канала в конфиге MCP нет ни адреса, ни токена — у claude и codex', async () => {
    const claude = await pending('claude');
    const plan = await planLaunch(project, claude.workId, await sessionOf(claude.workId, claude.sessionId));
    expect(await mcpEnvOf(plan.args)).not.toHaveProperty('PARLEY_AGENT_TOKEN');
    expect(await mcpEnvOf(plan.args)).not.toHaveProperty('PARLEY_AGENT_URL');

    const codex = await pending('codex');
    const codexPlan = await planLaunch(project, codex.workId, await sessionOf(codex.workId, codex.sessionId));
    expect(codexPlan.args.join('\n')).not.toContain('PARLEY_AGENT');
  });
});

```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/core exec vitest run src/work/mcp-config.test.ts src/mcp/context.test.ts src/work/launch.test.ts` → FAIL: у `McpConfigParams` нет поля `agent`, переменных канала в `env` нет, `McpContext.agent` не читается.

- [ ] **Шаг 3. Реализовать.** `src/work/mcp-config.ts`: тип канала, имена переменных, окружение сервера, имена в `SESSION_VARIABLES`, права файла:

Правка 1 из 9.

Заменить:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
```

на:

```ts
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
```

Правка 2 из 9.

После строк:

```ts
    : { command, args: [] };
}

```

вставить:

```ts
/** Канал агента к браузеру окна (спека браузера 2026-10-07, 3.7): адрес эндпоинта хоста и токен запуска сессии. */
export interface AgentChannel {
  /** `http://127.0.0.1:<порт>/agent/browser`. */
  url: string;
  /** 32 байта hex; новый на каждый запуск сессии. */
  token: string;
}

/** Переменные канала у MCP-сервера — только под новыми именами: у прежних сборок канала не было. */
export const AGENT_URL_ENV = 'PARLEY_AGENT_URL';
export const AGENT_TOKEN_ENV = 'PARLEY_AGENT_TOKEN';

const agentEnv = (agent: AgentChannel | undefined): Record<string, string> =>
  agent === undefined ? {} : { [AGENT_URL_ENV]: agent.url, [AGENT_TOKEN_ENV]: agent.token };

```

Правка 3 из 9.

После строк:

```ts
  /** Родной список скиллов этого запуска сокращён: сервер объявляет это в описании `find_skill`. Только `true` попадает в окружение. */
  skillListReduced?: boolean;
  nativeContextRevision?: string;
```

вставить:

```ts
  /**
   * Канал агента к браузеру окна (спека браузера 3.7): с ним сервер объявляет инструмент `browser_open`. Хост выдаёт его
   * каждому запуску; нет — старый хост или сервер хуков не поднялся, и инструментов браузера у сессии нет.
   */
  agent?: AgentChannel;
```

Правка 4 из 9.

Заменить:

```ts
  nativeContextRevision,
}: McpConfigParams): McpConfigFile {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        ...serverLaunch(command),
        env: bothEnv({
          WORK_DIR: workDir,
          SESSION_ID: sessionId,
          ...(channel === true ? { CHANNEL: '1' } : {}),
          ...(skillNavigator === undefined ? {} : { SKILL_NAVIGATOR: skillNavigator ? '1' : '0' }),
          ...(skillListReduced === true ? { SKILL_LIST_REDUCED: '1' } : {}),
          ...(nativeContextRevision === undefined ? {} : { NATIVE_CONTEXT_REVISION: nativeContextRevision }),
        }),
      },
```

на:

```ts
  nativeContextRevision,
  agent,
}: McpConfigParams): McpConfigFile {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        ...serverLaunch(command),
        env: {
          ...bothEnv({
            WORK_DIR: workDir,
            SESSION_ID: sessionId,
            ...(channel === true ? { CHANNEL: '1' } : {}),
            ...(skillNavigator === undefined ? {} : { SKILL_NAVIGATOR: skillNavigator ? '1' : '0' }),
            ...(skillListReduced === true ? { SKILL_LIST_REDUCED: '1' } : {}),
            ...(nativeContextRevision === undefined ? {} : { NATIVE_CONTEXT_REVISION: nativeContextRevision }),
          }),
          ...agentEnv(agent),
        },
      },
```

Правка 5 из 9.

Заменить:

```ts
const OWN_VARIABLE = new RegExp(`^(?:${ENV_PREFIX}|${LEGACY_ENV_PREFIX})[A-Z0-9_]+$`);
/** Три переменные, которые харнесс задаёт сессии сам, под обоими именами: унаследованное значение их не перекрывает. */
const SESSION_VARIABLES = new Set(Object.keys(bothEnv({ WORK_DIR: '', SESSION_ID: '', CHANNEL: '', SKILL_NAVIGATOR: '', SKILL_LIST_REDUCED: '', NATIVE_CONTEXT_REVISION: '' })));

```

на:

```ts
const OWN_VARIABLE = new RegExp(`^(?:${ENV_PREFIX}|${LEGACY_ENV_PREFIX})[A-Z0-9_]+$`);
/**
 * Переменные, которые харнесс задаёт сессии сам, под обоими именами: унаследованное значение их не перекрывает. Канал
 * агента — тоже только свой: хост, поднятый из сессии агента, унаследовал бы её адрес и токен.
 */
const SESSION_VARIABLES = new Set([
  ...Object.keys(bothEnv({ WORK_DIR: '', SESSION_ID: '', CHANNEL: '', SKILL_NAVIGATOR: '', SKILL_LIST_REDUCED: '', NATIVE_CONTEXT_REVISION: '' })),
  ...Object.keys(bothEnv({ AGENT_URL: '', AGENT_TOKEN: '' })),
]);

```

Правка 6 из 9.

Заменить:

```ts
  nativeContextRevision,
}: Pick<McpConfigParams, 'workDir' | 'sessionId' | 'env' | 'skillNavigator' | 'skillListReduced' | 'nativeContextRevision'>): Array<[string, string]> {
  const inherited = Object.entries(env ?? {})
```

на:

```ts
  nativeContextRevision,
  agent,
}: Pick<McpConfigParams, 'workDir' | 'sessionId' | 'env' | 'skillNavigator' | 'skillListReduced' | 'nativeContextRevision' | 'agent'>): Array<[string, string]> {
  const inherited = Object.entries(env ?? {})
```

Правка 7 из 9.

Заменить:

```ts
    ...(nativeContextRevision === undefined ? {} : { NATIVE_CONTEXT_REVISION: nativeContextRevision }),
  })), ...inherited];
}
```

на:

```ts
    ...(nativeContextRevision === undefined ? {} : { NATIVE_CONTEXT_REVISION: nativeContextRevision }),
  })), ...Object.entries(agentEnv(agent)), ...inherited];
}
```

Правка 8 из 9.

Заменить:

```ts
  channel = false,
  snapshot: Pick<McpConfigParams, 'skillNavigator' | 'skillListReduced' | 'nativeContextRevision'> = {},
): Promise<string> {
```

на:

```ts
  channel = false,
  snapshot: Pick<McpConfigParams, 'skillNavigator' | 'skillListReduced' | 'nativeContextRevision' | 'agent'> = {},
): Promise<string> {
```

Правка 9 из 9.

Заменить:

```ts
    }),
    'utf8',
  );
  return file;
```

на:

```ts
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  // В файле — токен канала агента: читать его может только сам человек. `mode` у `writeFile` действует лишь при
  // создании, а файл переписывается на каждом запуске, и прежний мог лечь с 0644, — права ставятся явно.
  await chmod(file, 0o600);
  return file;
```

  `src/mcp/context.ts`: сервер читает канал из окружения:

Правка 1 из 5.

После строк:

```ts
import path from 'node:path';
import type { RoleCatalog } from '../roles/types.js';
import { envName, envValue, LEGACY_STATE_DIR, STATE_DIR, STATE_DIRS } from '../names.js';
```

вставить:

```ts
import { AGENT_TOKEN_ENV, AGENT_URL_ENV, type AgentChannel } from '../work/mcp-config.js';
```

Правка 2 из 5.

После строк:

```ts
   * флагом канала; без сессии звонить всё равно некому.
   */
  channel: boolean;
```

вставить:

```ts
  /**
   * Канал агента к браузеру окна (спека браузера 3.7): адрес эндпоинта хоста и токен сессии. Нет — инструмент
   * `browser_open` не объявляется (сессия до обновления или хост без эндпоинта).
   */
  agent?: AgentChannel;
```

Правка 3 из 5.

После строк:

```ts
  resourceLimits?: ResourceLimits;
}

```

вставить:

```ts
/**
 * Канал агента из окружения: только под новыми именами, только `http://127.0.0.1:<порт>/agent/browser` и токен из
 * 64 hex. Иное — не наша настройка, и канала нет: сервер не пойдёт по чужому адресу с токеном сессии.
 */
function agentFromEnv(env: NodeJS.ProcessEnv): AgentChannel | undefined {
  const url = env[AGENT_URL_ENV];
  const token = env[AGENT_TOKEN_ENV];
  if (typeof url !== 'string' || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/agent/browser') return undefined;
  return { url, token };
}

```

Правка 4 из 5.

После строк:

```ts
    );
  }

```

вставить:

```ts
  const agent = agentFromEnv(env);
```

Правка 5 из 5.

После строк:

```ts
    skillNavigator: envValue(env, 'SKILL_NAVIGATOR') === '1',
    ...(envValue(env, 'SKILL_LIST_REDUCED') === '1' ? { skillListReduced: true } : {}),
    ...(envValue(env, 'NATIVE_CONTEXT_REVISION') === undefined ? {} : { nativeContextRevision: envValue(env, 'NATIVE_CONTEXT_REVISION')! }),
```

вставить:

```ts
    ...(agent === undefined ? {} : { agent }),
```

  `src/work/launch.ts`: опция запуска и передача в конфиг (правило приоритета — задача 7):

Правка 1 из 3.

Заменить:

```ts
import { NEW_LABEL } from './names.js';
import { mcpConfigValue, writeMcpConfig } from './mcp-config.js';
import { finishSession, linkProviderSession, type MetricsRoots } from './metrics.js';
```

на:

```ts
import { NEW_LABEL } from './names.js';
import { mcpConfigValue, writeMcpConfig, type AgentChannel } from './mcp-config.js';
import { finishSession, linkProviderSession, type MetricsRoots } from './metrics.js';
```

Правка 2 из 3.

После строк:

```ts
   * `codexApprovals` даёт `-c hooks.…` в аргументах запуска Codex (спека 2026-10-07, 5.6).
   */
  codexHookCommand?: string;
```

вставить:

```ts
  /**
   * Канал агента к браузеру окна (спека браузера 2026-10-07, 3.7): адрес эндпоинта хоста и токен этого запуска. Уходит
   * только в конфиг MCP-сервера (файл `--mcp-config` у Claude и GLM, `-c mcp_servers.parley` у Codex), в окружение
   * процесса — нет. Хост передаёт его каждому запуску, если эндпоинт слушает. С ним слой сессии получает правило
   * приоритета браузера Parley (`BROWSER_PRIORITY_RULE`) — если запуск вообще несёт сервер MCP.
   */
  agent?: AgentChannel;
```

Правка 3 из 3.

Заменить:

```ts
    ...(channel ? { channel } : {}),
  };

  // Файл конфига нужен только тем, кто принимает путь; codex получает сервер
  // значением `-c`, и лишний файл ему незачем.
  const file =
    entry.runner.mcpConfig === 'json-file'
      ? await writeMcpConfig(projectPath, workId, session.id, undefined, channel, { skillNavigator, skillListReduced: skillList !== undefined, nativeContextRevision })
      : null;
```

на:

```ts
    ...(channel ? { channel } : {}),
    ...(options.agent === undefined ? {} : { agent: options.agent }),
  };

  // Файл конфига нужен только тем, кто принимает путь; codex получает сервер
  // значением `-c`, и лишний файл ему незачем.
  const file =
    entry.runner.mcpConfig === 'json-file'
      ? await writeMcpConfig(projectPath, workId, session.id, undefined, channel, {
          skillNavigator,
          skillListReduced: skillList !== undefined,
          nativeContextRevision,
          ...(options.agent === undefined ? {} : { agent: options.agent }),
        })
      : null;
```

  `src/index.ts`: экспорты (хост и E2E берут имена из `@parley/core`):

Правка 1 из 2.

После строк:

```ts
export { scanClaudeCapabilities } from './capabilities/scan.js';
export type { ScanOptions } from './capabilities/scan.js';
export {
```

вставить:

```ts
  AGENT_TOKEN_ENV,
  AGENT_URL_ENV,
```

Правка 2 из 2.

Заменить:

```ts
} from './work/mcp-config.js';
export type { McpConfigFile, McpConfigParams, McpStdioServer } from './work/mcp-config.js';
export {
```

на:

```ts
} from './work/mcp-config.js';
export type { AgentChannel, McpConfigFile, McpConfigParams, McpStdioServer } from './work/mcp-config.js';
export {
```

- [ ] **Шаг 4. Запустить — проходит.** Команда шага 2 → PASS.

- [ ] **Шаг 5. Рамочный тест: сдвиг строки.** `pnpm --filter @parley/core exec vitest run test/frame-check.test.ts` → FAIL: в списке совпадений `packages/core/src/work/mcp-config.ts:160` вместо `:191`. Сдвинулась строка комментария, код рамки не тронут. В `test/frame-check.test.ts` заменить закреплённое место:

Заменить:

```ts
        'packages/core/src/providers.ts:263',
        'packages/core/src/work/mcp-config.ts:160',
      ].sort(),
```

на:

```ts
        'packages/core/src/providers.ts:263',
        'packages/core/src/work/mcp-config.ts:191',
      ].sort(),
```

  Повторить команду → PASS. Если у исполнителя выйдет другое число, значит правки `mcp-config.ts` применены не как в плане: сверить, а не подгонять.

- [ ] **Шаг 6. Весь core и сборка.** `pnpm --filter @parley/core exec vitest run` → PASS (флейки `worktree`, `history-search`, `decision-journal` под нагрузкой сравнить с исходным прогоном). `pnpm --filter @parley/core build` → без ошибок: хост читает core из `dist`.

- [ ] **Шаг 7. Закоммитить.**

```bash
git add packages/core/src/work/mcp-config.ts packages/core/src/work/mcp-config.test.ts packages/core/src/mcp/context.ts packages/core/src/mcp/context.test.ts packages/core/src/work/launch.ts packages/core/src/work/launch.test.ts packages/core/src/index.ts packages/core/test/frame-check.test.ts
git commit -m "feat(core): адрес и токен канала агента в конфиге MCP-сервера" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Задача 5. Хост: маршрут на сервере хуков, токен при запуске сессии, `browser.agentResult`

**Файлы:**
- Изменить: `packages/host/src/hooks/hook-server.ts`, `packages/host/src/sessions/sessions-service.ts`, `packages/host/src/methods/index.ts`, `packages/host/src/host.ts`, `packages/host/test/stub-agent.mjs`
- Тесты: `packages/host/src/hooks/hook-server.test.ts`, `packages/host/src/sessions/sessions-service.test.ts`, `packages/host/src/methods/index.test.ts`, `packages/host/src/server.test.ts`

**Интерфейсы:**
- Берёт: `createBrowserEndpoint`, `AGENT_BROWSER_PATH`, `BrowserEndpoint` (задача 3); `LaunchOptions.agent` и запись канала в конфиг MCP (задача 4: нужна собранная `dist` core); `Client`, `RequestInfo` из `context.ts`.
- Отдаёт:
  - `HookServerOptions.routes?: Readonly<Record<string, (req, res) => void>>` — другие пути того же сервера, только `POST` и точное совпадение пути (`Object.hasOwn`: `/__proto__` прототип не находит); `HookServer.origin(): string | null` — `http://127.0.0.1:<порт>`;
  - `SessionsFeedOptions.agent?: { url(): string | null; register(ref): string; unregister(ref): void }` — каждый запуск сессии (`launch`, `new`, `resume`; все провайдеры) регистрирует токен до плана запуска и передаёт `{ url, token }` в `LaunchOptions.agent`; выход процесса и отказ до старта процесса токен отзывают; повторный запуск той же сессии отзывает прежний токен;
  - `MethodDeps.browserAgent?: Pick<BrowserEndpoint, 'resolve'>` и метод `browser.agentResult`: `{ accepted: endpoint.resolve(opId, result, request.client) }` — ответить может только клиент, которому ушла операция;
  - проводка в `host.ts`: эндпоинт на сервере хуков, закрытие эндпоинта при остановке хоста раньше ленты, `dropClient` при уходе клиента.
- Заглушка `test/stub-agent.mjs` записывает в `STUB_ARGS_FILE` ещё и `PARLEY_AGENT_TOKEN` своего окружения: так тесты видят, что токена там нет.

- [ ] **Шаг 1. Написать падающие тесты.** Заглушка агента хоста (тесты читают её запись окружения):

Правка 1 из 2.

Заменить:

```js
//                                HARNAS_WORK_DIR, HARNAS_SESSION_ID, CLAUDE_CODE_SESSION_ID,
//                                PARLEY_HOOK_TOKEN, PARLEY_HOOK_URL } }
//   STUB_FLOOD_MB=<n>          — при старте печатает n МБ строк (тест
```

на:

```js
//                                HARNAS_WORK_DIR, HARNAS_SESSION_ID, CLAUDE_CODE_SESSION_ID,
//                                PARLEY_HOOK_TOKEN, PARLEY_HOOK_URL, PARLEY_AGENT_TOKEN } }
//   STUB_FLOOD_MB=<n>          — при старте печатает n МБ строк (тест
```

Правка 2 из 2.

После строк:

```js
        CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID ?? null,
        PARLEY_HOOK_TOKEN: process.env.PARLEY_HOOK_TOKEN ?? null,
        PARLEY_HOOK_URL: process.env.PARLEY_HOOK_URL ?? null,
```

вставить:

```js
        // Токен канала агента лежит только в конфиге MCP-сервера: в окружении процесса его быть не должно.
        PARLEY_AGENT_TOKEN: process.env.PARLEY_AGENT_TOKEN ?? null,
```

  Сервер хуков (`hook-server.test.ts`):

После строк:

```ts
  return service.decide(REF, 'permission:t1', { kind: 'question', answers: {} }).state;
}

```

вставить:

```ts
describe('другие пути сервера (спека браузера 3.7; этап B2)', () => {
  it('POST на путь из routes уходит его обработчику без проверки токена хуков; GET туда и чужой путь — 404; origin — основа адреса', async () => {
    const seen: string[] = [];
    const { server, url, token } = await boot({
      routes: {
        '/agent/browser': (req, res) => {
          seen.push(req.method ?? '');
          res.writeHead(204).end();
        },
      },
    });
    const origin = server.origin();
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(url).toBe(`${origin}/hooks`);
    expect((await post(`${origin}/agent/browser`, {}, { token: null, session: null })).status).toBe(204);
    expect((await post(`${origin}/agent/browser`, {}, { token, method: 'GET' })).status).toBe(404);
    expect((await post(`${origin}/agent/other`, {}, { token })).status).toBe(404);
    expect((await post(`${origin}/__proto__`, {}, { token })).status).toBe(404);
    expect(seen).toEqual(['POST']);
    await server.close();
    expect(server.origin()).toBeNull();
  });

  it('без routes путь агента — 404, как любой чужой', async () => {
    const { server, url, token } = await boot();
    const origin = server.origin();
    expect(url).toBe(`${origin}/hooks`);
    expect((await post(`${origin}/agent/browser`, {}, { token })).status).toBe(404);
  });
});

```

  Сервис сессий (`sessions-service.test.ts`; в конце теста файлов запуска меняется тип записи заглушки):

Правка 1 из 3.

Заменить:

```ts
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
```

на:

```ts
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
```

Правка 2 из 3.

После строк:

```ts
    CLAUDE_CODE_SESSION_ID: string | null;
    PARLEY_HOOK_TOKEN: string | null;
    PARLEY_HOOK_URL: string | null;
```

вставить:

```ts
    PARLEY_AGENT_TOKEN: string | null;
```

Правка 3 из 3.

После строк:

```ts
    expect(unregistered).toEqual([registered[0]?.ref]);
  });
});

```

вставить:

```ts
describe('launch(): канал агента к браузеру — токен на каждый запуск у всех провайдеров (спека браузера 3.7; этап B2)', () => {
  const AGENT_URL = 'http://127.0.0.1:4321/agent/browser';

  function fakeAgent(url: string | null = AGENT_URL) {
    const registered: SessionRef[] = [];
    const unregistered: SessionRef[] = [];
    const agent: NonNullable<SessionsFeedOptions['agent']> = {
      url: () => url,
      register(ref) {
        registered.push(ref);
        return `${String(registered.length).padStart(2, '0')}${'a'.repeat(62)}`;
      },
      unregister(ref) {
        unregistered.push(ref);
      },
    };
    return { agent, registered, unregistered };
  }

  async function launchWith(provider: string, agent: NonNullable<SessionsFeedOptions['agent']>, extra: Record<string, string> = {}) {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    for (const [key, value] of Object.entries(extra)) setEnv(key, value);
    const service = createSessionsService(fakeHost(), fakeWorks(), createPtyManager(fakeHost()), fakeActivity(), { agent });
    const ref = await service.create({ projectPath: project, workId: work.work.id, provider, label: 'бэкенд', task: '', parent: null });
    return { args: await readArgs(argsFile), ref, service };
  }

  it('claude: адрес и токен — в env сервера parley файла --mcp-config (0600), не в окружении процесса', async () => {
    const { agent, registered } = fakeAgent();
    const { args, ref, service } = await launchWith('claude', agent);
    expect(registered).toEqual([ref]);
    const file = args.argv[args.argv.indexOf('--mcp-config') + 1] as string;
    const env = (JSON.parse(await readFile(file, 'utf8')) as { mcpServers: { parley: { env: Record<string, string> } } }).mcpServers.parley.env;
    expect(env['PARLEY_AGENT_URL']).toBe(AGENT_URL);
    expect(env['PARLEY_AGENT_TOKEN']).toBe(`01${'a'.repeat(62)}`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(args.env.PARLEY_AGENT_TOKEN).toBeNull();
    expect(args.argv.join('\n')).not.toContain(`01${'a'.repeat(62)}`);
    await service.stop(ref);
  });

  it('codex: тот же канал — в таблице env сервера `-c mcp_servers.parley`', async () => {
    const { agent } = fakeAgent();
    const { args, ref, service } = await launchWith('codex', agent, { PARLEY_CODEX_BIN: STUB });
    const override = args.argv.find((arg) => arg.startsWith('mcp_servers.parley=')) as string;
    expect(override).toContain(`PARLEY_AGENT_URL=${JSON.stringify(AGENT_URL)}`);
    expect(override).toContain(`PARLEY_AGENT_TOKEN=${JSON.stringify(`01${'a'.repeat(62)}`)}`);
    expect(args.env.PARLEY_AGENT_TOKEN).toBeNull();
    await service.stop(ref);
  });

  it('выход процесса снимает токен; эндпоинт не слушает — токена нет и в конфиге пусто', async () => {
    const live = fakeAgent();
    const launched = await launchWith('claude', live.agent);
    await launched.service.stop(launched.ref);
    await waitFor(() => live.unregistered.some((ref) => ref.sessionId === launched.ref.sessionId), REAL_PROCESS_WAIT_MS);

    const closed = fakeAgent(null);
    const plain = await launchWith('claude', closed.agent);
    expect(closed.registered).toEqual([]);
    const file = plain.args.argv[plain.args.argv.indexOf('--mcp-config') + 1] as string;
    expect(await readFile(file, 'utf8')).not.toContain('PARLEY_AGENT');
    await plain.service.stop(plain.ref);
  });

  it('pty.start бросил — выданный токен снимается, ошибка доходит до вызывающего', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const { agent, registered, unregistered } = fakeAgent();
    const pty = createPtyManager(fakeHost());
    const failing = {
      ...pty,
      start: () => {
        throw new Error('spawn не удался');
      },
    };
    const service = createSessionsService(fakeHost(), fakeWorks(), failing, fakeActivity(), { agent });
    await expect(
      service.create({ projectPath: project, workId: work.work.id, provider: 'claude', label: '', task: '', parent: null }),
    ).rejects.toThrow('spawn не удался');
    expect(registered).toHaveLength(1);
    expect(unregistered).toEqual([registered[0]]);
  });

  it('новый запуск той же сессии — новый вызов register: прежний токен реестр отзывает сам', async () => {
    const { agent, registered } = fakeAgent();
    const first = await launchWith('claude', agent);
    await first.service.stop(first.ref);
    await waitFor(async () => {
      const map = await readMap(project, first.ref.workId);
      return map.sessions.find((candidate) => candidate.id === first.ref.sessionId)?.lifecycle !== 'active';
    }, REAL_PROCESS_WAIT_MS);
    await first.service.launch(first.ref, 'resume');
    expect(registered).toHaveLength(2);
    expect(registered[1]).toEqual(first.ref);
    await first.service.stop(first.ref);
  });
});

```

  Метод `browser.agentResult` (`methods/index.test.ts`):

После строк:

```ts
  });
});

```

вставить:

```ts
it('browser.agentResult: ответ окна уходит приёмнику агента вместе с клиентом-отправителем (спека браузера 3.7; этап B2)', async () => {
  const { deps } = fakeDeps(Promise.resolve());
  const resolve = vi.fn(() => true);
  const handlers = createHostHandlers({ ...deps, browserAgent: { resolve } });
  const client = { id: 'c-1' };
  const handler = handlers.methods['browser.agentResult'] as unknown as (params: unknown, request: unknown) => Promise<unknown>;
  const opened = { tab: 't1', url: 'http://localhost:5173/', reused: false, notes: [] };
  await expect(handler({ opId: 'op-1', ok: true, result: opened }, { client })).resolves.toEqual({ accepted: true });
  expect(resolve).toHaveBeenLastCalledWith('op-1', { ok: true, result: opened }, client);
  resolve.mockReturnValueOnce(false);
  await expect(handler({ opId: 'op-2', ok: false, error: { code: 'not_loopback', message: 'x' } }, { client })).resolves.toEqual({ accepted: false });
  expect(resolve).toHaveBeenLastCalledWith('op-2', { ok: false, error: { code: 'not_loopback', message: 'x' } }, client);
});

it('без приёмника агента метода browser.agentResult нет', () => {
  const { deps } = fakeDeps(Promise.resolve());
  expect(createHostHandlers(deps).methods['browser.agentResult']).toBeUndefined();
});

```

  Сквозной тест по настоящим HTTP и сокету (`server.test.ts`): сессия со стабом, адрес и токен из её конфига MCP, операция, событие окну, ответ окна, отзыв токена, закрытие окна:

Правка 1 из 2.

Заменить:

```ts
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addSession, createWork, updateMap, workPaths } from '@parley/core';
import { METHODS, NOTIFICATIONS, PROTOCOL_VERSION } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
```

на:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { addSession, createWork, updateMap, workPaths } from '@parley/core';
import { BROWSER_AGENT_FEATURE, METHODS, NOTIFICATIONS, PROTOCOL_VERSION } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
```

Правка 2 из 2.

После строк:

```ts
  }, 20_000);
});

```

вставить:

```ts
describe('канал агента к браузеру: от HTTP до окна и обратно (спека браузера 3.7; этап B2)', () => {
  const STUB = fileURLToPath(new URL('../test/stub-agent.mjs', import.meta.url));
  const PAGE = 'http://localhost:5173/';

  /** Следующее сообщение, подходящее под условие; остальные рассылки пропускаются. */
  async function until(client: TestClient, match: (message: RawMessage) => boolean, timeoutMs = 10_000): Promise<RawMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('не дождались сообщения');
      const message = await Promise.race([
        client.next(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('не дождались сообщения')), left)),
      ]);
      if (match(message)) return message;
    }
  }

  async function post(url: string, token: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text === '' ? null : (JSON.parse(text) as unknown) };
  }

  it('токен сессии — из её конфига MCP; операция уходит окну с browser-agent и возвращается ответом окна; окно ушло — window_not_connected; сессия остановлена — токен 401', async () => {
    const { home, token } = await boot();
    const project = await mkdtemp(path.join(tmpdir(), 'parley-server-agent-'));
    projects.push(project);
    const argsFile = path.join(project, 'args.json');
    process.env['PARLEY_CLAUDE_BIN'] = STUB;
    process.env['STUB_ARGS_FILE'] = argsFile;
    try {
      const map = await createWork(project, { title: 'Работа' });
      const window = connectRaw(hostPaths(home).socket);
      await waitConnected(window.socket);
      const answer = await hello(window, token, { client: 'desktop', features: [BROWSER_AGENT_FEATURE] });
      expect((answer.result as { methods: string[] }).methods).toContain('browser.agentResult');

      window.send({ id: 901, method: 'sessions.create', params: { projectPath: project, workId: map.work.id, provider: 'claude', label: 'агент', task: '', parent: null } });
      const created = await until(window, (message) => message.id === 901);
      expect(created.error).toBeUndefined();
      const ref = (created.result as { ref: SessionRef }).ref;

      // Адрес и токен — из конфига MCP-сервера, как их берёт настоящий parley-mcp.
      const deadline = Date.now() + 10_000;
      while (!existsSync(argsFile)) {
        if (Date.now() > deadline) throw new Error('стаб не записал аргументы');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const args = JSON.parse(await readFile(argsFile, 'utf8')) as { argv: string[]; env: Record<string, string | null> };
      const config = JSON.parse(await readFile(args.argv[args.argv.indexOf('--mcp-config') + 1] as string, 'utf8')) as {
        mcpServers: { parley: { env: Record<string, string> } };
      };
      const { PARLEY_AGENT_URL: url, PARLEY_AGENT_TOKEN: agentToken } = config.mcpServers.parley.env;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/agent\/browser$/);
      expect(agentToken).toMatch(/^[0-9a-f]{64}$/);
      expect(args.env['PARLEY_AGENT_TOKEN']).toBeNull();

      // Чужой токен — 401.
      expect((await post(url as string, 'f'.repeat(64), { op: 'open', args: { url: PAGE } })).status).toBe(401);

      // Операция: HTTP → окно (событие) → окно отвечает методом → HTTP.
      const opened = post(url as string, agentToken as string, { op: 'open', args: { url: PAGE } });
      const event = await until(window, (message) => message.event === 'browser.agentOp');
      expect(event.data).toMatchObject({ ref, label: 'S01', op: 'open', args: { url: PAGE } });
      const { opId } = event.data as { opId: string };
      const result = { tab: 't1', url: PAGE, reused: false, notes: [] };
      window.send({ id: 902, method: 'browser.agentResult', params: { opId, ok: true, result } });
      expect((await until(window, (message) => message.id === 902)).result).toEqual({ accepted: true });
      expect(await opened).toEqual({ status: 200, json: { ok: true, result } });
      // Поздний повтор того же ответа — не принят.
      window.send({ id: 903, method: 'browser.agentResult', params: { opId, ok: true, result } });
      expect((await until(window, (message) => message.id === 903)).result).toEqual({ accepted: false });

      // Окно ушло посреди операции — агенту сразу window_not_connected.
      const dropped = post(url as string, agentToken as string, { op: 'open', args: { url: PAGE } });
      await until(window, (message) => message.event === 'browser.agentOp');
      window.close();
      expect(await dropped).toEqual({ status: 200, json: { ok: false, error: { code: 'window_not_connected', message: expect.any(String) as unknown as string } } });

      // Окон нет совсем — тот же отказ, без ожидания.
      expect((await post(url as string, agentToken as string, { op: 'open', args: { url: PAGE } })).json).toMatchObject({ ok: false, error: { code: 'window_not_connected' } });

      // Сессия остановлена — токен снят.
      const second = connectRaw(hostPaths(home).socket);
      await waitConnected(second.socket);
      await hello(second, token, { client: 'desktop', features: [BROWSER_AGENT_FEATURE] });
      second.send({ id: 904, method: 'sessions.stop', params: { ref } });
      await until(second, (message) => message.id === 904);
      const stopDeadline = Date.now() + 10_000;
      for (;;) {
        const status = (await post(url as string, agentToken as string, { op: 'open', args: { url: PAGE } })).status;
        if (status === 401) break;
        if (Date.now() > stopDeadline) throw new Error('токен остановленной сессии остался в силе');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      second.close();
    } finally {
      delete process.env['PARLEY_CLAUDE_BIN'];
      delete process.env['STUB_ARGS_FILE'];
    }
  }, 40_000);
});

```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/protocol build && pnpm --filter @parley/core build && pnpm --filter @parley/host exec vitest run src/hooks/hook-server.test.ts src/sessions/sessions-service.test.ts src/methods/index.test.ts src/server.test.ts` → FAIL: у сервера хуков нет `routes` и `origin()`, сервис сессий не знает `agent`, метода `browser.agentResult` нет, список методов в `server.test.ts` расходится.

- [ ] **Шаг 3. Реализовать.** `hooks/hook-server.ts` — маршруты и основа адресов:

Правка 1 из 6.

После строк:

```ts
  onHook(request: HookRequest): void;
  /** Предел тела; по умолчанию `HOOK_BODY_LIMIT`. Тестам — меньше. */
  bodyLimit?: number;
```

вставить:

```ts
  /**
   * Другие пути того же сервера (спека браузера 2026-10-07, 3.7): `/agent/browser`. Только POST и точное совпадение
   * пути; обработчик сам проверяет свой токен, читает тело и отвечает.
   */
  routes?: Readonly<Record<string, (req: IncomingMessage, res: ServerResponse) => void>>;
```

Правка 2 из 6.

После строк:

```ts
  listen(): Promise<string>;
  /** Адрес приёмника; `null` — ещё не слушает или уже закрыт. */
  url(): string | null;
```

вставить:

```ts
  /** `http://127.0.0.1:<порт>` — основа адресов других путей (`routes`); `null` — ещё не слушает или уже закрыт. */
  origin(): string | null;
```

Правка 3 из 6.

После строк:

```ts
  /** Запросы, которым ещё не ответили: на выключении получают `{}`. */
  const open = new Map<(json: HookResponse) => void, ServerResponse>();
  let address: string | null = null;
```

вставить:

```ts
  let base: string | null = null;
```

Правка 4 из 6.

Заменить:

```ts
  function handle(req: IncomingMessage, res: ServerResponse): void {
    const pathname = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || pathname !== HOOK_PATH) {
```

на:

```ts
  function handle(req: IncomingMessage, res: ServerResponse): void {
    const pathname = (req.url ?? '').split('?')[0] ?? '';
    // Свой путь другого приёмника (`routes`): `hasOwn` — чтобы `/__proto__` не нашёл прототип объекта.
    const route =
      req.method === 'POST' && options.routes !== undefined && Object.hasOwn(options.routes, pathname)
        ? options.routes[pathname]
        : undefined;
    if (route !== undefined) {
      route(req, res);
      return;
    }
    if (req.method !== 'POST' || pathname !== HOOK_PATH) {
```

Правка 5 из 6.

Заменить:

```ts
          const { port } = server.address() as AddressInfo;
          address = `http://127.0.0.1:${port}${HOOK_PATH}`;
          resolve(address);
        });
      });
    },
    url: () => address,
    register(ref, providerSessionId, provider = 'claude') {
```

на:

```ts
          const { port } = server.address() as AddressInfo;
          base = `http://127.0.0.1:${port}`;
          address = `${base}${HOOK_PATH}`;
          resolve(address);
        });
      });
    },
    url: () => address,
    origin: () => base,
    register(ref, providerSessionId, provider = 'claude') {
```

Правка 6 из 6.

После строк:

```ts
        ]);
        clearTimeout(timer);
        address = null;
```

вставить:

```ts
        base = null;
```

  `sessions/sessions-service.ts` — токен на запуск:

Правка 1 из 5.

После строк:

```ts
   * при включённой настройке `codexApprovals` и адресе приёмника; нет — хуки Codex не включаются.
   */
  codexHookCommand?: () => Promise<string | undefined>;
```

вставить:

```ts
  /**
   * Канал агента к браузеру окна (спека браузера 2026-10-07, 3.7): адрес эндпоинта (`null` — не слушает) и токены на
   * запуск. Всем провайдерам, в отличие от хуков ленты; без него сессии запускаются без инструмента `browser_open`.
   */
  agent?: { url(): string | null; register(ref: SessionRef): string; unregister(ref: SessionRef): void };
```

Правка 2 из 5.

После строк:

```ts
    const key = refKey(ref);
    // Токен приёмника живёт, пока жив процесс: `SessionEnd` приходит до выхода, позже хуков нет.
    hooks?.unregister(ref);
```

вставить:

```ts
    feed.agent?.unregister(ref);
```

Правка 3 из 5.

После строк:

```ts
    // Резерв слота бюджета держится до исхода: процесс стартовал — `spent`, любой отказ до старта — `released`.
    let attemptId: string | null = null;
    let processStarted = false;
```

вставить:

```ts
    let agentChannel: { url: string; token: string } | undefined;
```

Правка 4 из 5.

Заменить:

```ts
      const codexHookCommand = hookUrl !== undefined && session.provider === 'codex' ? await feed.codexHookCommand?.() : undefined;
      const planFn = mode === 'resume' ? planResume : mode === 'new' ? planNew : planLaunch;
      const plan = await planFn(ref.projectPath, ref.workId, session, {
        channel: false,
        ...(feed.roleCatalog ? { roleCatalog: await feed.roleCatalog(session.worktree?.path ?? ref.projectPath) } : {}),
        ...(hookUrl === undefined ? {} : { hookUrl }),
        ...(codexHookCommand === undefined ? {} : { codexHookCommand }),
        ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
```

на:

```ts
      const codexHookCommand = hookUrl !== undefined && session.provider === 'codex' ? await feed.codexHookCommand?.() : undefined;
      // Канал агента к браузеру (спека браузера 3.7): свой токен на каждый запуск, у всех провайдеров. Адрес и токен
      // уходят только в конфиг MCP-сервера, в окружение процесса — нет.
      const agentUrl = feed.agent?.url() ?? null;
      if (agentUrl !== null && feed.agent !== undefined) agentChannel = { url: agentUrl, token: feed.agent.register(ref) };
      const planFn = mode === 'resume' ? planResume : mode === 'new' ? planNew : planLaunch;
      const plan = await planFn(ref.projectPath, ref.workId, session, {
        channel: false,
        ...(feed.roleCatalog ? { roleCatalog: await feed.roleCatalog(session.worktree?.path ?? ref.projectPath) } : {}),
        ...(hookUrl === undefined ? {} : { hookUrl }),
        ...(codexHookCommand === undefined ? {} : { codexHookCommand }),
        ...(agentChannel === undefined ? {} : { agent: agentChannel }),
        ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
```

Правка 5 из 5.

После строк:

```ts
      });
      throw error;
    } finally {
```

вставить:

```ts
      // Процесс не стартовал — токен канала никому не нужен.
      if (agentChannel !== undefined && !processStarted) feed.agent?.unregister(ref);
```

  `methods/index.ts` — метод ответа окна:

Правка 1 из 3.

Заменить:

```ts
import type { MethodName, NotificationName } from '@parley/protocol';
import type { BacklogService } from '../backlog/backlog-service.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { AnyHandler, AnyNotificationHandler } from '../context.js';
import type { FeedService } from '../feed/feed-service.js';
```

на:

```ts
import type { BrowserAgentResult, MethodName, NotificationName, Params } from '@parley/protocol';
import type { BrowserEndpoint } from '../agent/browser-endpoint.js';
import type { BacklogService } from '../backlog/backlog-service.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { AnyHandler, AnyNotificationHandler, RequestInfo } from '../context.js';
import type { FeedService } from '../feed/feed-service.js';
```

Правка 2 из 3.

После строк:

```ts
  limits?: LimitsService;
  /** Явная проверка ключа Z.ai (`providers.check`); без неё метода нет, а в `providers.list` нет `check`. */
  glmCheck?: GlmCheckService;
```

вставить:

```ts
  /** Канал агента к браузеру окна (спека браузера 3.7): ответ окна `browser.agentResult`; без него метода нет. */
  browserAgent?: Pick<BrowserEndpoint, 'resolve'>;
```

Правка 3 из 3.

После строк:

```ts
    methods['feed.decide'] = feed.feedDecide as AnyHandler;
    methods['feed.interrupt'] = feed.feedInterrupt as AnyHandler;
  }
```

вставить:

```ts
  if (deps.browserAgent !== undefined) {
    const endpoint = deps.browserAgent;
    methods['browser.agentResult'] = (async (params: Params<'browser.agentResult'>, request: RequestInfo) => {
      const result: BrowserAgentResult = params.ok ? { ok: true, result: params.result } : { ok: false, error: params.error };
      return { accepted: endpoint.resolve(params.opId, result, request.client) };
    }) as AnyHandler;
  }
```

  `host.ts` — проводка:

Правка 1 из 5.

После строк:

```ts
import { createBacklogService } from './backlog/backlog-service.js';
import { createPlanEffectsService } from './rooms/plan-effects.js';
import { createHistoryService } from './rooms/history-service.js';
```

вставить:

```ts
import { AGENT_BROWSER_PATH, createBrowserEndpoint } from './agent/browser-endpoint.js';
```

Правка 2 из 5.

Заменить:

```ts
  }, options.codexHookGraceMs === undefined ? {} : { codexHookGraceMs: options.codexHookGraceMs });
  const hookServer = createHookServer({ log, onHook: (request) => feedService.onHook(request) });

```

на:

```ts
  }, options.codexHookGraceMs === undefined ? {} : { codexHookGraceMs: options.codexHookGraceMs });
  // Канал агента к браузеру окна (спека браузера 2026-10-07, 3.7): путь `/agent/browser` на сервере хуков и свой
  // реестр токенов — у всех провайдеров. Операцию исполняет окно с возможностью `browser-agent`.
  const browserEndpoint = createBrowserEndpoint({ log, clients: () => handle.context.clients() });
  const hookServer = createHookServer({
    log,
    onHook: (request) => feedService.onHook(request),
    routes: { [AGENT_BROWSER_PATH]: (req, res) => browserEndpoint.handle(req, res) },
  });

```

Правка 3 из 5.

Заменить:

```ts
    activityService,
    { hooks: hookServer, providerVersions, codexHookCommand: codexHookCommandOnce },
  );
  handle.context.onShutdown(() => sessionsService.stopAll());
  // После остановки сессий: их `SessionEnd` ещё доходят до ленты и получают ответ. Потом всем
  // висящим хукам — `{}`, и приёмник закрывается.
  handle.context.onShutdown(async () => {
    await feedService.stop();
```

на:

```ts
    activityService,
    {
      hooks: hookServer,
      providerVersions,
      codexHookCommand: codexHookCommandOnce,
      agent: {
        url: () => {
          const origin = hookServer.origin();
          return origin === null ? null : `${origin}${AGENT_BROWSER_PATH}`;
        },
        register: (ref) => browserEndpoint.register(ref),
        unregister: (ref) => browserEndpoint.unregister(ref),
      },
    },
  );
  handle.context.onShutdown(() => sessionsService.stopAll());
  // После остановки сессий: их `SessionEnd` ещё доходят до ленты и получают ответ. Потом всем
  // висящим хукам — `{}`, и приёмник закрывается.
  handle.context.onShutdown(async () => {
    // Висящим операциям агента — `window_not_connected`, а не обрыв соединения.
    browserEndpoint.close();
    await feedService.stop();
```

Правка 4 из 5.

После строк:

```ts
    wake: wakeService,
    worktrees: worktreesService,
    feed: feedService,
```

вставить:

```ts
    browserAgent: browserEndpoint,
```

Правка 5 из 5.

После строк:

```ts
    unregisterClient: (client) => {
      handle.removeClient(client);
      feedService.dropClient(client);
```

вставить:

```ts
      browserEndpoint.dropClient(client);
```

- [ ] **Шаг 4. Запустить — проходит.** Команда шага 2 → PASS. Затем `pnpm --filter @parley/host exec vitest run src/english-text.test.ts` и `pnpm --filter @parley/host build` → без ошибок.

- [ ] **Шаг 5. Весь хост.** `pnpm --filter @parley/host exec vitest run` → PASS, в том числе `server.test.ts` «methods — ровно ключи METHODS и NOTIFICATIONS»: хост снова отвечает на каждый метод протокола (флейки `works-service`, `context-pages`, `activity-service`, `wake-service` под нагрузкой сравнить с исходным прогоном: упавший файл перезапустить отдельно).

- [ ] **Шаг 6. Закоммитить.**

```bash
git add packages/host/src/hooks/hook-server.ts packages/host/src/hooks/hook-server.test.ts packages/host/src/sessions/sessions-service.ts packages/host/src/sessions/sessions-service.test.ts packages/host/src/methods/index.ts packages/host/src/methods/index.test.ts packages/host/src/host.ts packages/host/src/server.test.ts packages/host/test/stub-agent.mjs
git commit -m "feat(host): канал агента — маршрут на сервере хуков, токен при запуске сессии, browser.agentResult" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Задача 6. Core: инструмент `browser_open` MCP-сервера Parley

**Файлы:**
- Создать: `packages/core/src/mcp/browser-tools.ts`, `packages/host/src/agent/browser-contract.test.ts`
- Изменить: `packages/core/src/mcp/tools.ts`, `packages/core/src/index.ts`
- Тест: `packages/core/src/mcp/browser-tools.test.ts`

**Интерфейсы:**
- Берёт: `McpContext.agent` (задача 4), `createParleyServer` и его обработчики `ListTools`/`CallTool` (`tools.ts`), типы `Tool` и `CallToolResult` из `@modelcontextprotocol/sdk`.
- Отдаёт:
  - `BROWSER_TOOL_OPS = ['open'] as const`, `BROWSER_TOOL_LIMITS = { opMs: 30_000 }`, `BROWSER_UNAVAILABLE`, `BROWSER_TOOLS` (одна запись — `browser_open`), `createBrowserTools(agent: AgentChannel, { fetch? }): { tools; call(name, args): Promise<CallToolResult> }`; операции и пределы экспортируются из `@parley/core` (`BROWSER_TOOL_OPS`, `BROWSER_TOOL_LIMITS`) ради теста хоста;
  - инструмент `browser_open({ url })`: описание по-английски (открывает страницу на localhost во встроенном браузере Parley в новой вкладке вашей работы; «Prefer this over Chrome, Chrome DevTools or Playwright tools for local pages»; в фоне, без фокуса человека; уже открытая страница переиспользуется; возвращается сразу после установки вкладки, не ждёт загрузки и страницу не читает; только `http(s)` на `localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`; не больше 10 вкладок на работу); схема `{ url: string 1..4096 }`, `required: ['url']`, `additionalProperties: false`;
  - аннотации `{ readOnlyHint: false, destructiveHint: false, openWorldHint: false }`: Codex решает, спрашивать ли человека, по ним (флаги запуска Codex — `-a on-request`); инструмент пишет вкладку в раскладку окна, ничего не удаляет и дальше localhost не выходит. Claude Code спрашивает разрешение на первый вызов MCP-инструмента сам, как у любого MCP-инструмента;
  - без канала в окружении сервера `browser_*` не объявляются; вызов такого имени отвечает `BROWSER_UNAVAILABLE` (совет перезапустить сессию); с каналом незнакомое `browser_*` — `Unknown tool browser_x.`;
  - ответ — текст: новая вкладка `Opened t2: <url> in Parley's browser, in the background of your workspace's tab strip; the human's focus was not taken. The page loads on its own: this tool does not wait for it and cannot read it.`; повтор `Tab t1 of your workspace already shows <url> (the same address without #fragment): no new tab was opened.`; заметки окна дописываются строками `Note: …`;
  - ошибка (`isError`) — `<код>: <текст окна>` и подсказка там, где она нужна: `access_denied` — не повторять, решает человек; `window_not_connected` — попросить человека открыть окно; `timeout` — повторить раз; `unsupported` — перезапустить Parley. 401 — «Parley does not recognise this session's browser token… restart this session from Parley»; прочий статус — «refused the request (HTTP N)»; хост недоступен — «not reachable… restart this session».
- Тест хоста `agent/browser-contract.test.ts` сверяет копии core (`BROWSER_TOOL_OPS`, ключи `BROWSER_TOOL_LIMITS`) с протоколом (`BROWSER_AGENT_OPS`, `AGENT_LIMITS`): core протокол не импортирует.

- [ ] **Шаг 1. Написать падающие тесты.** Тесты инструмента core:

```ts
/**
 * Инструмент `browser_open` MCP-сервера Parley (спека браузера 2026-10-07, 3.7, 5.1; этап B2): поддельный эндпоинт хоста на
 * `node:http`, настоящий сервер Parley через InMemoryTransport. Проверяется объявление по каналу, аннотации (по ним Codex
 * решает, спрашивать ли человека), запрос с токеном, тексты ответов и ошибки с подсказками.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BROWSER_TOOL_LIMITS, BROWSER_TOOL_OPS, BROWSER_TOOLS, BROWSER_UNAVAILABLE, createBrowserTools } from './browser-tools.js';
import { createParleyServer } from './tools.js';

const TOKEN = 'ab'.repeat(32);
const PAGE = 'http://localhost:5173/form';

let server: Server | null = null;
let answers: Array<{ status: number; body: unknown }> = [];
let seen: Array<{ auth: string | undefined; body: unknown }> = [];

/** Поддельный эндпоинт хоста: отвечает по очереди из `answers`, запоминает запросы. */
async function startEndpoint(): Promise<string> {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
      const answer = answers.shift() ?? { status: 200, body: { ok: true, result: { tab: 't1', url: PAGE, reused: false, notes: [] } } };
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(answer.status === 200 ? JSON.stringify(answer.body) : '');
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent/browser`;
}

beforeEach(() => {
  answers = [];
  seen = [];
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())));
  server = null;
});

/** Клиент MCP к настоящему серверу Parley — с каналом агента (`url`) или без него (`null`). */
async function connect(url: string | null): Promise<Client> {
  const parley = createParleyServer({
    projectPath: '/no/such/project',
    workId: 'w-0001',
    workDir: '/no/such/project/.parley/works/w-0001',
    sessionId: 's-01',
    channel: false,
    ...(url === null ? {} : { agent: { url, token: TOKEN } }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), parley.connect(serverTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return { isError: result.isError === true, text: content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n') };
}

describe('объявление инструмента', () => {
  it('без канала browser_* нет; вызов такого инструмента — отказ с советом перезапустить сессию', async () => {
    const client = await connect(null);
    expect((await client.listTools()).tools.some((tool) => tool.name.startsWith('browser_'))).toBe(false);
    const result = await call(client, 'browser_open', { url: PAGE });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(BROWSER_UNAVAILABLE);
    expect(result.text).toContain('restart this session');
  });

  it('с каналом — browser_open: аннотации «пишет, но не разрушает» (Codex не спрашивает человека), строгая схема, описание по-английски называет Chrome, DevTools и Playwright', async () => {
    const client = await connect(await startEndpoint());
    const tools = (await client.listTools()).tools.filter((tool) => tool.name.startsWith('browser_'));
    expect(tools.map((tool) => tool.name)).toEqual(BROWSER_TOOL_OPS.map((op) => `browser_${op}`));
    const [open] = tools;
    expect(open?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(open?.inputSchema).toMatchObject({ required: ['url'], additionalProperties: false });
    expect(open?.description).not.toMatch(/[А-Яа-яЁё]/);
    for (const phrase of ['Prefer this over Chrome, Chrome DevTools or Playwright', 'localhost', 'without taking the human', 'reused', 'at most 10']) {
      expect(open?.description, phrase).toContain(phrase);
    }
    expect(BROWSER_TOOLS).toHaveLength(1);
  });

  it('предел операции — тот же 30 с, что в протоколе (сверяет тест хоста)', () => {
    expect(BROWSER_TOOL_LIMITS).toEqual({ opMs: 30_000 });
  });
});

describe('запрос к эндпоинту хоста', () => {
  it('POST с Bearer-токеном сессии и телом { op: open, args }; аргументы — как есть', async () => {
    const client = await connect(await startEndpoint());
    await call(client, 'browser_open', { url: PAGE });
    expect(seen).toEqual([{ auth: `Bearer ${TOKEN}`, body: { op: 'open', args: { url: PAGE } } }]);
  });
});

describe('ответы — текстом для агента', () => {
  it('новая вкладка: id и адрес, фон без фокуса, страницу инструмент не ждёт и не читает', async () => {
    const client = await connect(await startEndpoint());
    answers.push({ status: 200, body: { ok: true, result: { tab: 't2', url: PAGE, reused: false, notes: [] } } });
    const result = await call(client, 'browser_open', { url: PAGE });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(`Opened t2: ${PAGE}`);
    expect(result.text).toContain('the human\'s focus was not taken');
    expect(result.text).toContain('does not wait for it and cannot read it');
  });

  it('вкладка уже была: сказано, что новая не открыта; заметки окна добавлены', async () => {
    const client = await connect(await startEndpoint());
    answers.push({ status: 200, body: { ok: true, result: { tab: 't1', url: PAGE, reused: true, notes: ['The workspace is not open in Parley\'s window.'] } } });
    const result = await call(client, 'browser_open', { url: PAGE });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('Tab t1 of your workspace already shows');
    expect(result.text).toContain('no new tab was opened');
    expect(result.text).toContain("Note: The workspace is not open in Parley's window.");
  });
});

describe('ошибки', () => {
  it('код окна — isError: код, текст окна и подсказка там, где она нужна', async () => {
    const client = await connect(await startEndpoint());
    answers.push(
      { status: 200, body: { ok: false, error: { code: 'access_denied', message: 'The human turned off agent access to the browser.' } } },
      { status: 200, body: { ok: false, error: { code: 'not_loopback', message: 'Only http(s) pages on localhost can be opened.' } } },
      { status: 200, body: { ok: false, error: { code: 'window_not_connected', message: "Parley's window is not connected to the host." } } },
    );
    const denied = await call(client, 'browser_open', { url: PAGE });
    expect(denied.isError).toBe(true);
    expect(denied.text).toBe('access_denied: The human turned off agent access to the browser. Do not retry: the human decides when agents may use the browser.');
    const outside = await call(client, 'browser_open', { url: 'https://example.com/' });
    expect(outside.text).toBe('not_loopback: Only http(s) pages on localhost can be opened.');
    const away = await call(client, 'browser_open', { url: PAGE });
    expect(away.text).toContain("Ask the human to open Parley's window, then retry.");
  });

  it('401 — токен не узнан: перезапустить сессию; хост недоступен — тоже; прочий статус — отказ хоста', async () => {
    const client = await connect(await startEndpoint());
    answers.push({ status: 401, body: null });
    expect((await call(client, 'browser_open', { url: PAGE })).text).toContain("does not recognise this session's browser token");
    answers.push({ status: 413, body: null });
    expect((await call(client, 'browser_open', { url: PAGE })).text).toContain('refused the request (HTTP 413)');
    const closed = await createBrowserTools({ url: 'http://127.0.0.1:1/agent/browser', token: TOKEN }).call('browser_open', { url: PAGE });
    expect(closed.isError).toBe(true);
    expect(JSON.stringify(closed.content)).toContain('not reachable');
  });

  it('неизвестный browser_* при канале — Unknown tool', async () => {
    const client = await connect(await startEndpoint());
    const result = await call(client, 'browser_evaluate', { code: '1' });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('Unknown tool browser_evaluate.');
    expect(seen).toEqual([]);
  });
});
```

  Контрактный тест в хосте:

```ts
/**
 * Core не импортирует протокол (тот сам зависит от core) и держит свою копию операций и пределов канала агента
 * (`core/src/mcp/browser-tools.ts`). Хост видит оба пакета — здесь сверка, что копии не разошлись.
 */
import { describe, expect, it } from 'vitest';
import { BROWSER_TOOL_LIMITS, BROWSER_TOOL_OPS } from '@parley/core';
import { AGENT_LIMITS, BROWSER_AGENT_OPS } from '@parley/protocol';

describe('копии core совпадают с протоколом', () => {
  it('инструменты browser_* — ровно операции канала, в том же порядке', () => {
    expect([...BROWSER_TOOL_OPS]).toEqual([...BROWSER_AGENT_OPS]);
  });

  it('пределы инструментов — те же числа, что AGENT_LIMITS', () => {
    for (const [key, value] of Object.entries(BROWSER_TOOL_LIMITS)) {
      expect(AGENT_LIMITS[key as keyof typeof AGENT_LIMITS], key).toBe(value);
    }
  });
});
```

- [ ] **Шаг 2. Запустить — падает.**
  - `pnpm --filter @parley/core exec vitest run src/mcp/browser-tools.test.ts` → FAIL: модуль `./browser-tools.js` не найден.
  - `pnpm --filter @parley/host exec vitest run src/agent/browser-contract.test.ts` → FAIL: `@parley/core` не экспортирует `BROWSER_TOOL_OPS` и `BROWSER_TOOL_LIMITS`.

- [ ] **Шаг 3. Реализовать.** Новый файл:

```ts
/**
 * Инструменты `browser_*` MCP-сервера Parley (спека 2026-10-07-browser-devtools-agent-design.md, 3.7, 5.1; этап B2:
 * `browser_open`). Вызов идёт `fetch` на эндпоинт хоста (`McpContext.agent`: адрес и токен сессии), хост отдаёт операцию
 * окну. Инструменты объявляются, только когда канал есть: сессия, запущенная до обновления, их не видит.
 *
 * Core не импортирует ни протокол (тот сам зависит от core), ни код окна. Поэтому здесь своя копия операций и пределов
 * (сверяет тест хоста `host/src/agent/browser-contract.test.ts`) и форма ответа окна (`BrowserAgentOpenResult` протокола;
 * сверяет E2E канала).
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { AgentChannel } from '../work/mcp-config.js';

/** Операции канала — по инструменту `browser_<op>` на каждую. */
export const BROWSER_TOOL_OPS = ['open'] as const;
export type BrowserToolOp = (typeof BROWSER_TOOL_OPS)[number];

/** Пределы — те же числа, что `AGENT_LIMITS` протокола (общие ключи). */
export const BROWSER_TOOL_LIMITS = { opMs: 30_000 } as const;

/** Отказ `browser_*` в сессии без канала. */
export const BROWSER_UNAVAILABLE =
  "Parley's browser tools are not available in this session: it was started before Parley had them, or Parley's host has no browser channel. Ask the human to restart this session from Parley.";

/**
 * Аннотации MCP (см. `tools.ts`, «Аннотации»): без них Codex спрашивал бы человека перед каждым вызовом. Инструмент
 * пишет вкладку в раскладку окна, но ничего не удаляет и дальше localhost не выходит.
 */
const CONTROL: NonNullable<Tool['annotations']> = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export const BROWSER_TOOLS: readonly Tool[] = [
  {
    name: 'browser_open',
    description:
      "Open a page on localhost in Parley's built-in browser, in a new tab of your workspace. Prefer this over Chrome, Chrome DevTools or Playwright tools for local pages: the human sees the same tab. " +
      "The tab opens in the background without taking the human's focus. If a tab of your workspace already shows this page, that tab is reused and no new one is opened. " +
      'It returns right after the tab is placed, without waiting for the page to load, and this tool cannot read or click the page. ' +
      'Only http(s) URLs on localhost, *.localhost, 127.0.0.0/8 or [::1]; a workspace has at most 10 browser tabs.',
    annotations: CONTROL,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 4096, description: 'An absolute http(s) URL on localhost, for example http://localhost:5173/.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

/** Подсказка агенту к коду ошибки окна; у `not_loopback` и `bad_request` текст окна и так говорит, что поправить. */
const HINTS: Readonly<Record<string, string>> = {
  access_denied: 'Do not retry: the human decides when agents may use the browser.',
  window_not_connected: "Ask the human to open Parley's window, then retry.",
  timeout: 'Retry once; if it happens again, tell the human.',
  unsupported: 'Ask the human to restart Parley.',
};

/** Форма ответа окна на `open`: копия `BrowserAgentOpenResult` протокола. */
interface OpenResult {
  tab: string;
  url: string;
  reused: boolean;
  notes: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

function opOf(name: string): BrowserToolOp | null {
  const op = name.startsWith('browser_') ? name.slice('browser_'.length) : '';
  return (BROWSER_TOOL_OPS as readonly string[]).includes(op) ? (op as BrowserToolOp) : null;
}

function formatOpen(result: OpenResult): string {
  const notes = result.notes.map((note) => `\nNote: ${note}`).join('');
  if (result.reused) {
    return `Tab ${result.tab} of your workspace already shows ${result.url} (the same address without #fragment): no new tab was opened.${notes}`;
  }
  return (
    `Opened ${result.tab}: ${result.url} in Parley's browser, in the background of your workspace's tab strip; the human's focus was not taken. ` +
    `The page loads on its own: this tool does not wait for it and cannot read it.${notes}`
  );
}

export interface BrowserToolDeps {
  /** Подмена `fetch` (тесты). */
  fetch?: typeof fetch;
}

export interface BrowserTools {
  tools: readonly Tool[];
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

export function createBrowserTools(agent: AgentChannel, deps: BrowserToolDeps = {}): BrowserTools {
  const doFetch = deps.fetch ?? fetch;

  /** Запрос к эндпоинту: результат окна или готовый текст отказа для агента. */
  async function request(op: BrowserToolOp, args: Record<string, unknown>): Promise<{ ok: true; result: unknown } | { ok: false; text: string }> {
    let response: Response;
    try {
      response = await doFetch(agent.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, args }),
        signal: AbortSignal.timeout(BROWSER_TOOL_LIMITS.opMs + 5_000),
      });
    } catch {
      return { ok: false, text: "Parley's host is not reachable: it may have restarted. Ask the human to restart this session from Parley." };
    }
    if (response.status === 401) {
      return { ok: false, text: "Parley does not recognise this session's browser token: the host or the session was restarted. Ask the human to restart this session from Parley." };
    }
    if (response.status !== 200) return { ok: false, text: `Parley's host refused the request (HTTP ${response.status}).` };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, text: "Parley's host sent an unreadable answer." };
    }
    if (!isRecord(body)) return { ok: false, text: "Parley's host sent an unreadable answer." };
    if (body.ok === true) return { ok: true, result: body.result };
    const error = isRecord(body.error) ? body.error : {};
    const code = typeof error.code === 'string' ? error.code : 'unsupported';
    const message = typeof error.message === 'string' ? error.message : '';
    const hint = HINTS[code];
    return { ok: false, text: `${code}: ${message}${hint === undefined ? '' : ` ${hint}`}` };
  }

  return {
    tools: BROWSER_TOOLS,
    async call(name, args) {
      const op = opOf(name);
      if (op === null) return text(`Unknown tool ${name}.`, true);
      const answer = await request(op, args);
      if (!answer.ok) return text(answer.text, true);
      try {
        switch (op) {
          case 'open':
            return text(formatOpen(answer.result as OpenResult));
        }
      } catch (error) {
        return text(`The window answered in an unexpected form: ${(error as Error).message}`, true);
      }
    },
  };
}
```

  `src/mcp/tools.ts` — объявление и вызов:

Правка 1 из 3.

После строк:

```ts
  type WorkSession,
} from '../work/types.js';
import { baseBranchOf, isGitRepo, plannedWorktree } from '../work/worktree.js';
```

вставить:

```ts
import { BROWSER_UNAVAILABLE, createBrowserTools } from './browser-tools.js';
```

Правка 2 из 3.

Заменить:

```ts
  const navigator = context.skillNavigator === true ? skillNavigator(context) : null;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: navigator ? [...TOOLS, await navigator.list()] : TOOLS }));
  // Тред Codex привязывается один раз за жизнь сервера — с первого вызова, где `_meta.threadId` есть.
```

на:

```ts
  const navigator = context.skillNavigator === true ? skillNavigator(context) : null;
  // Инструмент браузера окна (спека браузера 2026-10-07, 3.7) — только при канале агента в окружении сервера.
  const browser = context.agent === undefined ? null : createBrowserTools(context.agent);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOLS, ...(browser?.tools ?? []), ...(navigator ? [await navigator.list()] : [])],
  }));
  // Тред Codex привязывается один раз за жизнь сервера — с первого вызова, где `_meta.threadId` есть.
```

Правка 3 из 3.

После строк:

```ts
        return { content: [{ type: 'text', text: 'Skill navigator is disabled for this launch.' }], isError: true };
      // До самого инструмента: `wait_for` может держать вызов до получаса, а привязка нужна сразу.
      if (!threadBound) threadBound = await bindCodexThread(context, request.params._meta);
```

вставить:

```ts
      // Инструменты браузера отвечают сами: без канала — отказ с советом перезапустить сессию.
      if (request.params.name.startsWith('browser_')) {
        return browser === null ? { content: [{ type: 'text', text: BROWSER_UNAVAILABLE }], isError: true } : browser.call(request.params.name, args);
      }
```

  `src/index.ts` — экспорты для теста хоста:

После строк:

```ts
  probeChannelSupport,
} from './work/channel.js';
export type { ChannelProbe } from './work/channel.js';
```

вставить:

```ts
export { BROWSER_TOOL_LIMITS, BROWSER_TOOL_OPS } from './mcp/browser-tools.js';
```

- [ ] **Шаг 4. Запустить — проходит.**
  - `pnpm --filter @parley/core exec vitest run src/mcp/browser-tools.test.ts` → PASS.
  - `pnpm --filter @parley/core exec vitest run src/mcp src/english-text.test.ts` → PASS: таблица аннотаций прежних инструментов цела, в строках core нет кириллицы.
  - `pnpm --filter @parley/core build && pnpm --filter @parley/host exec vitest run src/agent/browser-contract.test.ts` → PASS.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/core/src/mcp/browser-tools.ts packages/core/src/mcp/browser-tools.test.ts packages/core/src/mcp/tools.ts packages/core/src/index.ts packages/host/src/agent/browser-contract.test.ts
git commit -m "feat(core): инструмент browser_open MCP-сервера Parley — только при канале агента" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Задача 7. Core: правило приоритета браузера Parley в системной вставке запуска

**Файлы:**
- Изменить: `packages/core/src/work/guidance.ts`, `packages/core/src/work/session-layer.ts`, `packages/core/src/work/launch.ts`, `packages/core/src/index.ts`
- Тесты: `packages/core/src/work/guidance.test.ts`, `packages/core/src/work/session-layer.test.ts`, `packages/core/src/work/launch.test.ts`

**Интерфейсы:**
- Берёт: `LaunchOptions.agent` (задача 4), `buildSessionLayer`, `SessionLayerInput`, `LayerBlockBytes`, переменную `mcpRoute` запуска (шаблон провайдера содержит `{mcpConfig}`: сервер MCP до агента доходит).
- Отдаёт:
  - `BROWSER_PRIORITY_RULE` (экспорт из `@parley/core`): две английские фразы — для страниц на localhost сначала браузер Parley (`browser_open` показывает страницу во вкладке этой работы, человек видит ту же вкладку); Chrome, Chrome DevTools и Playwright — для других сайтов, для того, чего инструменты браузера Parley не делают (пока: чтение и клики по странице, JS, куки, файлы, трассы производительности), и когда `browser_open` недоступен;
  - `SessionLayerInput.browser?: string` и ключ `browser` в `LayerBlockBytes`: отдельный блок слоя сразу после гида — `guidance → browser → bridge → role → playbook → brief → parleyMd → memoryFacts`; пустой блок не оставляет ни пустых строк, ни следа в слое;
  - в `launch.ts` блок добавляется только при `options.agent !== undefined && mcpRoute`: у Claude и GLM — в `--append-system-prompt`, у Codex — в `developer_instructions`, при `launch`, `new` и `resume`. Стабильная политика (`stableGuidance`) и вставка гида правила не несут: это те же байты у всех сессий, нельзя велеть агенту звать инструмент, которого у него нет.
- Текст правила смягчён оговоркой «(so far: reading or clicking the page, …)»: инструмент B2 страницу не читает. Когда этапы C и D дадут чтение и управление, правило переписывается в их задачах.

- [ ] **Шаг 1. Написать падающие тесты.** В `guidance.test.ts`:

Правка 1 из 2.

Заменить:

```ts
import { contextBytes, GUIDANCE_MAX_BYTES, STABLE_POLICY_MAX_BYTES, textHash } from './context-budget.js';
import { guidanceBudgetProblems, stableGuidance, systemGuidance } from './guidance.js';
import { ACCEPTED_LETTER, RETURNED_LETTER } from './proposals.js';
```

на:

```ts
import { contextBytes, GUIDANCE_MAX_BYTES, STABLE_POLICY_MAX_BYTES, textHash } from './context-budget.js';
import { BROWSER_PRIORITY_RULE, guidanceBudgetProblems, stableGuidance, systemGuidance } from './guidance.js';
import { ACCEPTED_LETTER, RETURNED_LETTER } from './proposals.js';
```

Правка 2 из 2.

После строк:

```ts
    expect(text).not.toMatch(/must (call|use) find_skill/i);
  });
});

```

вставить:

```ts
describe('правило приоритета браузера Parley (этап B2)', () => {
  it('короткое, по-английски, называет browser_open и всех, кого он обгоняет, и оставляет им то, чего он не делает', () => {
    expect(BROWSER_PRIORITY_RULE).not.toMatch(/[А-Яа-яЁё]/);
    expect(contextBytes(BROWSER_PRIORITY_RULE)).toBeLessThanOrEqual(700);
    expect(BROWSER_PRIORITY_RULE).toContain("use Parley's browser first");
    expect(BROWSER_PRIORITY_RULE).toContain('browser_open');
    expect(BROWSER_PRIORITY_RULE).toContain('the human sees the same tab');
    for (const other of ['Chrome', 'Chrome DevTools', 'Playwright']) expect(BROWSER_PRIORITY_RULE, other).toContain(other);
    for (const left of ['other sites', 'running JS', 'cookies', 'files', 'performance traces', 'browser_open is not available']) {
      expect(BROWSER_PRIORITY_RULE, left).toContain(left);
    }
  });

  it('вставка и стабильная политика его не несут: они одни и те же байты у каждой сессии', () => {
    expect(stableGuidance()).not.toContain('browser_open');
    expect(systemGuidance(mapOf('Authorization', 'login by e-mail'), 's-03')).not.toContain('browser_open');
  });
});

```

  В `session-layer.test.ts`:

Правка 1 из 2.

После строк:

```ts
  it('orders every block and omits empty blocks without persisting anything', () => {
    const result = buildSessionLayer({
      guidance: 'GUIDE',
```

вставить:

```ts
      browser: 'BROWSER',
```

Правка 2 из 2.

Заменить:

```ts
    expect(result.text).toBe(
      'GUIDE\n\nBRIDGE\n\nROLE\n\nPLAYBOOK\n\nBRIEF\n\nTeam rules of this project (PARLEY.md):\nRULES\n\nFACTS',
    );
    expect(result.warnings).toEqual([]);
```

на:

```ts
    expect(result.text).toBe(
      'GUIDE\n\nBROWSER\n\nBRIDGE\n\nROLE\n\nPLAYBOOK\n\nBRIEF\n\nTeam rules of this project (PARLEY.md):\nRULES\n\nFACTS',
    );
    expect(result.blockBytes.browser).toBe(7);
    // Без блока браузера слой прежний: пустой блок не оставляет ни пустых строк, ни следа.
    expect(buildSessionLayer({ guidance: 'GUIDE', bridge: 'BRIDGE' }).text).toBe('GUIDE\n\nBRIDGE');
    expect(result.warnings).toEqual([]);
```

  В `launch.test.ts` — импорт и тесты запусков (после блока «системная вставка гида»):

Правка 1 из 2.

После строк:

```ts
  startSession,
  UNTITLED_WORK,
} from './launch.js';
```

вставить:

```ts
import { BROWSER_PRIORITY_RULE } from './guidance.js';
```

Правка 2 из 2.

После строк:

```ts
    expect(plan.args).not.toContain('--append-system-prompt');
  });
});

```

вставить:

```ts
describe('правило приоритета браузера Parley в запуске (спека браузера 5.1; этап B2)', () => {
  const agent = { url: 'http://127.0.0.1:4321/agent/browser', token: 'ab'.repeat(32) };
  /** Значение `--append-system-prompt` (Claude и GLM); '' — флага нет. */
  const claudeLayer = (args: string[]): string => args[args.indexOf('--append-system-prompt') + 1] ?? '';
  const codexLayer = (args: string[]): string => {
    const arg = args.find((value) => value.startsWith('developer_instructions='));
    if (arg === undefined) throw new Error('developer layer missing');
    return JSON.parse(arg.slice('developer_instructions='.length)) as string;
  };

  it('без канала правила нет — у claude и codex (Фокус ревью, п. 5)', async () => {
    const claude = await pending('claude');
    const plan = await planLaunch(project, claude.workId, await sessionOf(claude.workId, claude.sessionId));
    expect(claudeLayer(plan.args)).not.toContain('browser_open');

    const codex = await pending('codex');
    const codexPlan = await planLaunch(project, codex.workId, await sessionOf(codex.workId, codex.sessionId));
    expect(codexLayer(codexPlan.args)).not.toContain('browser_open');
  });

  it('Claude с каналом: правило приоритета в слое при launch, new и resume (Фокус ревью, п. 5)', async () => {
    const { workId, sessionId } = await pending('claude');
    const session = await sessionOf(workId, sessionId);
    const id = '7fa0e1ee-cc7b-4a1e-9d4e-0000000000a1';
    await claudeTranscript(id);
    for (const plan of [
      await planLaunch(project, workId, session, { agent }),
      await planNew(project, workId, session, { agent }),
      await planResume(project, workId, { ...session, providerSessionId: id }, { agent }),
    ]) {
      expect(claudeLayer(plan.args)).toContain(BROWSER_PRIORITY_RULE);
    }
    // Слой тот же, что и без канала, плюс один блок после гида: остальное не сдвинулось.
    const without = claudeLayer((await planLaunch(project, workId, session)).args);
    const withRule = claudeLayer((await planLaunch(project, workId, session, { agent })).args);
    expect(withRule.replace(`\n\n${BROWSER_PRIORITY_RULE}`, '')).toBe(without);
  });

  it('GLM — тот же Claude Code: правило в слое и канал в файле конфига', async () => {
    const { workId, sessionId } = await pending('codex');
    const session = { ...(await sessionOf(workId, sessionId)), provider: 'glm' };
    const plan = await planLaunch(project, workId, session, { agent });
    expect(claudeLayer(plan.args)).toContain(BROWSER_PRIORITY_RULE);
    const file = plan.args[plan.args.indexOf('--mcp-config') + 1] as string;
    expect(JSON.parse(await readFile(file, 'utf8')).mcpServers.parley.env).toMatchObject({ PARLEY_AGENT_TOKEN: agent.token });
  });

  it('Codex с каналом: правило приоритета в developer_instructions при launch, new и resume (Фокус ревью, п. 5)', async () => {
    const { workId, sessionId } = await pending('codex');
    const session = await sessionOf(workId, sessionId);
    for (const plan of [
      await planLaunch(project, workId, session, { agent }),
      await planNew(project, workId, session, { agent }),
      await planResume(project, workId, { ...session, providerSessionId: 'codex-thread' }, { agent, prompt: 'INBOX POINTER' }),
    ]) {
      expect(codexLayer(plan.args)).toContain(BROWSER_PRIORITY_RULE);
    }
  });

  it('канал есть, а сервера MCP у запуска нет (свой шаблон без {mcpConfig}) — правила нет: велеть звать нечего', async () => {
    const { workId, sessionId } = await pending('claude');
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({ claude: { args: ['--append-system-prompt', '{systemPrompt}', '{prompt}'] } }));
    const plan = await planLaunch(project, workId, await sessionOf(workId, sessionId), { agent });
    expect(plan.args).toContain('--append-system-prompt');
    expect(plan.args).not.toContain('--mcp-config');
    expect(claudeLayer(plan.args)).not.toContain('browser_open');
  });
});

```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/core exec vitest run src/work/guidance.test.ts src/work/session-layer.test.ts src/work/launch.test.ts` → FAIL: `BROWSER_PRIORITY_RULE` не экспортируется, у слоя нет блока `browser`.

- [ ] **Шаг 3. Реализовать.** `src/work/guidance.ts` — текст правила:

После строк:

```ts
  return ' find_skill — skills by task, if needed.';
}

```

вставить:

```ts
/**
 * Приоритет браузера Parley для страниц на localhost (спека браузера 2026-10-07, этап B2). Отдельный блок слоя сессии, а не
 * строка `stableGuidance`: он идёт только запуску с каналом агента и сервером MCP (`launch.ts`), а у остальных его нет —
 * нельзя велеть агенту звать инструмент, которого у него нет. Вставка и политика остаются теми же байтами у всех сессий.
 */
export const BROWSER_PRIORITY_RULE =
  "For pages on localhost, use Parley's browser first: browser_open shows the page in a tab of this workspace, and the human sees the same tab. " +
  "Use Chrome, Chrome DevTools or Playwright tools only for other sites, for what Parley's browser tools do not do (so far: reading or clicking the page, running JS, cookies, files, performance traces), or when browser_open is not available.";

```

  `src/work/session-layer.ts` — блок слоя:

Правка 1 из 4.

После строк:

```ts

export interface SessionLayerInput {
  guidance: string;
```

вставить:

```ts
  /** Приоритет браузера Parley (`BROWSER_PRIORITY_RULE`): только запуску с каналом агента и сервером MCP. */
  browser?: string;
```

Правка 2 из 4.

Заменить:

```ts
export type LayerBlockBytes = Record<
  'guidance' | 'bridge' | 'role' | 'playbook' | 'brief' | 'parleyMd' | 'memoryFacts',
  number
```

на:

```ts
export type LayerBlockBytes = Record<
  'guidance' | 'browser' | 'bridge' | 'role' | 'playbook' | 'brief' | 'parleyMd' | 'memoryFacts',
  number
```

Правка 3 из 4.

После строк:

```ts
  if (memory?.truncated) warnings.push({ code: 'memory-truncated', message: 'Parley cut project memory at 12 KiB; clean up memory.md to include the remaining facts.' });
  const parts = {
    guidance: input.guidance,
```

вставить:

```ts
    browser: input.browser ?? '',
```

Правка 4 из 4.

После строк:

```ts
    throw new SessionLayerTooLargeError({ memoryBytes: blockBytes.memoryFacts, blockBytes });
  const text = [
    parts.guidance,
```

вставить:

```ts
    parts.browser,
```

  `src/work/launch.ts` — правило только запуску с каналом и сервером MCP:

Правка 1 из 2.

Заменить:

```ts
import { loadBrief, writeBrief } from './brief.js';
import { systemGuidance } from './guidance.js';
import { readParleyMd } from './parley-md.js';
```

на:

```ts
import { loadBrief, writeBrief } from './brief.js';
import { BROWSER_PRIORITY_RULE, systemGuidance } from './guidance.js';
import { readParleyMd } from './parley-md.js';
```

Правка 2 из 2.

После строк:

```ts
        omitGoal: brief !== null || (!resuming && mode !== 'new' && !quiet),
      }),
      bridge,
```

вставить:

```ts
      // Правило — только там, где у агента есть `browser_open`: канал выдан и сервер MCP доходит шаблоном с `{mcpConfig}`.
      ...(options.agent !== undefined && mcpRoute ? { browser: BROWSER_PRIORITY_RULE } : {}),
```

  `src/index.ts` — экспорт для E2E:

Заменить:

```ts
} from './work/skill-install.js';
export { systemGuidance } from './work/guidance.js';
export {
```

на:

```ts
} from './work/skill-install.js';
export { BROWSER_PRIORITY_RULE, systemGuidance } from './work/guidance.js';
export {
```

- [ ] **Шаг 4. Запустить — проходит.** Команда шага 2 → PASS. Затем `pnpm --filter @parley/core exec vitest run` → PASS целиком (бюджет гида `guidanceBudgetProblems` не затронут: правило вне `stableGuidance`) и `pnpm --filter @parley/core build` → без ошибок.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/core/src/work/guidance.ts packages/core/src/work/guidance.test.ts packages/core/src/work/session-layer.ts packages/core/src/work/session-layer.test.ts packages/core/src/work/launch.ts packages/core/src/work/launch.test.ts packages/core/src/index.ts
git commit -m "feat(core): правило приоритета браузера Parley — блок слоя сессии у запуска с каналом" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Задача 8. Main: loopback и операция `open` (`agent-ops.ts`)

**Файлы:**
- Создать: `packages/desktop/src/shared/loopback.ts`, `packages/desktop/src/main/browser/agent-ops.ts`
- Изменить: `packages/desktop/src/shared/browser-types.ts` (типы `AgentOpenTab` и `AgentOpenTabResult`)
- Тесты: `packages/desktop/src/shared/loopback.test.ts`, `packages/desktop/src/main/browser/agent-ops.test.ts`

**Интерфейсы:**
- Берёт (задача 2): `AGENT_LIMITS`, `browserAgentArgs`, типы `BrowserAgentArgs`, `BrowserAgentErrorCode`, `BrowserAgentOpEvent`, `BrowserAgentOpenResult`, `BrowserAgentResult` из `@parley/protocol`; `workKey` из `shared/work-keys.ts`.
- Отдаёт (индекс: `shared/loopback.ts`, `main/browser/agent-ops.ts`):
  - `isLoopbackUrl(url): boolean` — разбор WHATWG `URL`: схема `http` или `https`, хост `localhost`, `*.localhost` (и с точкой на конце), `[::1]` или `127.x.x.x` (`127.1`, `0x7f.1` приводятся к `127.0.0.1` самим `URL`); `0.0.0.0`, адреса локальной сети, `localhost.evil.test`, `127.0.0.1.nip.io`, `[::ffff:127.0.0.1]`, `http://localhost@evil.com/` (хост — `evil.com`) и всё, что не разбирается, — нет. Ей же дальше пользуются `guard.ts` и умолчание «Agent access» (этапы C и D);
  - типы `AgentOpenTab { requestId, workKey, url, sessionId, session }` (просьба main окну: адрес уже проверен и без учётных данных; работа — из `ref` события хоста) и `AgentOpenTabResult = { tabId; reused; mounted } | { error: 'limit' | 'no_work' }` (ответ окна);
  - `createAgentOps({ agentsAllowed(), openTab(e): boolean, openMs? }): AgentOps` с `run(request: BrowserAgentOpEvent): Promise<BrowserAgentResult>` и `openTabResult(requestId, result)` (ответ окна; чужой и поздний id молча игнорируется); `AgentOpError`, `loopbackHref(raw)` (адрес без учётных данных, с фрагментом; не loopback — `null`), `NOT_MOUNTED_NOTE`.
- Порядок проверок в `run` (спека 3.7, 5.1): неизвестная операция — `unsupported`; аргументы не по схеме (в том числе лишнее поле) — `bad_request`; общий выключатель выключен — `access_denied` (читается на каждую операцию); адрес не loopback — `not_loopback`, окну ничего; дальше просьба окну и ожидание не дольше `AGENT_LIMITS.openMs`: окно не получило просьбу (нет окна, закрыто посреди вызова) — `window_not_connected`; молчит — `timeout`; `limit` — `bad_request` («10 browser tabs», совет закрыть одну); `no_work` — `window_not_connected` («try again in a moment»).
- Ответ агенту: `{ tab: 't1', url, reused, notes }`. Короткий id вкладки (`t1`, `t2`…) у каждой работы свой и держится, пока жив main; вкладка в раскладке названа длинным id, соответствие хранит `agentIdFor`. Работа не смонтирована (вне LRU окна) — вкладка добавлена, ответ `ok` с заметкой `NOT_MOUNTED_NOTE`, а не отказ. Страницу main не трогает: ни гостя, ни CDP, ни ожидания загрузки (этапы C и D).

- [ ] **Шаг 1. Написать падающие тесты.** Loopback:

```ts
import { describe, expect, it } from 'vitest';
import { isLoopbackUrl } from './loopback.js';

describe('isLoopbackUrl (спека 7)', () => {
  it('localhost, *.localhost, 127.0.0.0/8 и [::1] по http и https — loopback', () => {
    for (const url of [
      'http://localhost:5173/',
      'https://localhost/settings?x=1',
      'http://LOCALHOST:3000',
      'http://localhost.:5173/',
      'http://app.localhost:8080/',
      'http://a.b.localhost/',
      'http://127.0.0.1:5173/',
      'http://127.1.2.3/',
      'https://127.255.255.254:8443/x',
      'http://127.1/',
      'http://0x7f.1/',
      'http://[::1]:5173/',
      'http://user:pw@localhost:5173/',
    ]) {
      expect(isLoopbackUrl(url), url).toBe(true);
    }
  });

  it('локальная сеть, 0.0.0.0, чужие и похожие имена, хитрые адреса с @ — не loopback', () => {
    for (const url of [
      'http://192.168.1.10:5173/',
      'http://10.0.0.5/',
      'http://172.16.0.1/',
      'http://0.0.0.0:5173/',
      'http://128.0.0.1/',
      'https://example.com/',
      'http://localhost.example.com/',
      'http://localhost.evil.test/',
      'http://mylocalhost/',
      'http://127.0.0.1.nip.io/',
      'http://[::2]/',
      'http://[::ffff:127.0.0.1]/',
      'http://localhost@evil.com/',
      'http://localhost:80@evil.com/',
      'http://127.0.0.1@evil.com/',
    ]) {
      expect(isLoopbackUrl(url), url).toBe(false);
    }
  });

  it('только http и https: file:, ws:, about:blank, data:, javascript: и не адрес — нет', () => {
    for (const url of ['file:///etc/hosts', 'ws://localhost:5173/', 'about:blank', 'data:text/html,x', 'javascript:alert(1)', 'localhost:5173', '/relative', '', 'not a url']) {
      expect(isLoopbackUrl(url), url).toBe(false);
    }
  });
});
```

  Операция `open` в main:

```ts
/**
 * Операция `open` агента в main (спека браузера 2026-10-07, 3.7, 5.1–5.2, 7; этап B2): проверки доступа и адреса, просьба окну,
 * перевод его ответа в ответ агенту. Окно подменено: проверяется логика main, а раскладку и тост проверяют тесты рендерера.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BrowserAgentOpEvent, BrowserAgentOpenResult, BrowserAgentResult } from '@parley/protocol';
import type { AgentOpenTab, AgentOpenTabResult } from '../../shared/browser-types.js';
import { workKey } from '../../shared/work-keys.js';
import { createAgentOps, loopbackHref, NOT_MOUNTED_NOTE, type AgentOps } from './agent-ops.js';

const REF = { projectPath: '/proj', workId: 'w-1', sessionId: 's-02' };
const OTHER_REF = { projectPath: '/proj', workId: 'w-2', sessionId: 's-01' };
const WORK = workKey(REF.projectPath, REF.workId);
const OTHER_WORK = workKey(OTHER_REF.projectPath, OTHER_REF.workId);
const PAGE = 'http://localhost:5173/form';

/** Окно отвечает на просьбу своим ответом (если он задан) сразу после неё, как ответил бы рендерер. */
function setup(overrides: { allowed?: boolean; reply?: AgentOpenTabResult | null; sent?: boolean; openMs?: number } = {}) {
  const asked: AgentOpenTab[] = [];
  const state = { allowed: overrides.allowed ?? true, reply: overrides.reply === undefined ? { tabId: 'browser:aaaaaa', reused: false, mounted: true } : overrides.reply };
  const openTab = vi.fn((e: AgentOpenTab): boolean => {
    asked.push(e);
    if (overrides.sent === false) return false;
    if (state.reply !== null) {
      const reply = state.reply;
      queueMicrotask(() => ops.openTabResult(e.requestId, reply));
    }
    return true;
  });
  const ops: AgentOps = createAgentOps({ agentsAllowed: async () => state.allowed, openTab, ...(overrides.openMs === undefined ? {} : { openMs: overrides.openMs }) });
  const run = (args: unknown, ref = REF, op = 'open'): Promise<BrowserAgentResult> =>
    ops.run({ opId: 'op-1', ref, label: ref.sessionId === 's-02' ? 'S02' : 'S01', op: op as BrowserAgentOpEvent['op'], args });
  return { ops, run, asked, openTab, state };
}

const codeOf = (result: BrowserAgentResult): string => (result.ok ? 'ok' : result.error.code);
const messageOf = (result: BrowserAgentResult): string => (result.ok ? '' : result.error.message);
function okResult(result: BrowserAgentResult): BrowserAgentOpenResult {
  if (!result.ok) throw new Error(`операция отказала: ${result.error.code} ${result.error.message}`);
  return result.result as BrowserAgentOpenResult;
}

describe('open (спека 5.1 browser_open)', () => {
  it('просьба окну — работа из ref события, адрес, сессия и её номер; ответ агенту — id вкладки t1, адрес, reused и заметки', async () => {
    const { run, asked } = setup();
    expect(okResult(await run({ url: PAGE }))).toEqual({ tab: 't1', url: PAGE, reused: false, notes: [] });
    expect(asked).toEqual([{ requestId: expect.any(String) as unknown as string, workKey: WORK, url: PAGE, sessionId: 's-02', session: 'S02' }]);
  });

  it('id вкладок — свой счёт у каждой работы и стабильный: та же вкладка — тот же id, новая — следующий, другая работа — снова t1', async () => {
    const { run, state } = setup();
    expect(okResult(await run({ url: PAGE })).tab).toBe('t1');
    state.reply = { tabId: 'browser:bbbbbb', reused: false, mounted: true };
    expect(okResult(await run({ url: 'http://localhost:5173/other' })).tab).toBe('t2');
    state.reply = { tabId: 'browser:aaaaaa', reused: true, mounted: true };
    expect(okResult(await run({ url: PAGE }))).toMatchObject({ tab: 't1', reused: true });
    state.reply = { tabId: 'browser:cccccc', reused: false, mounted: true };
    expect(okResult(await run({ url: PAGE }, OTHER_REF)).tab).toBe('t1');
  });

  it('работу назвать нельзя: лишнее поле аргументов — bad_request, окну ничего; ключ работы берётся из ref', async () => {
    const { run, asked } = setup();
    expect(codeOf(await run({ url: PAGE, workKey: OTHER_WORK }))).toBe('bad_request');
    expect(codeOf(await run({ url: PAGE, tab: 't1' }))).toBe('bad_request');
    expect(codeOf(await run({}))).toBe('bad_request');
    expect(codeOf(await run({ url: '' }))).toBe('bad_request');
    expect(asked).toEqual([]);
    await run({ url: PAGE }, OTHER_REF);
    expect(asked.map((e) => e.workKey)).toEqual([OTHER_WORK]);
  });

  it('Фокус ревью 2: не loopback и обходные записи — not_loopback, окну ничего', async () => {
    const { run, asked } = setup();
    for (const url of [
      'https://example.com/',
      'http://localhost.evil.test/',
      'http://127.0.0.1.nip.io/',
      'http://0.0.0.0:5173/',
      'http://192.168.1.10:5173/',
      'http://[::ffff:127.0.0.1]/',
      'http://localhost@evil.com/',
      'file:///etc/hosts',
      'javascript:alert(1)',
      'data:text/html,x',
      'localhost:5173',
      '/relative',
      'not a url',
    ]) {
      expect(codeOf(await run({ url })), url).toBe('not_loopback');
    }
    expect(asked).toEqual([]);
  });

  it('адрес уходит окну без учётных данных, с фрагментом (маршрут SPA) и в виде, как его запишет раскладка', async () => {
    const { run, asked } = setup();
    expect(okResult(await run({ url: 'http://user:pw@LOCALHOST:5173/a?b=1#/route' })).url).toBe('http://localhost:5173/a?b=1#/route');
    expect(asked[0]?.url).toBe('http://localhost:5173/a?b=1#/route');
    expect(loopbackHref('http://127.1/')).toBe('http://127.0.0.1/');
    expect(loopbackHref('https://example.com/')).toBeNull();
  });

  it('общий выключатель «Let agents use the browser» — access_denied, окну ничего', async () => {
    const { run, asked } = setup({ allowed: false });
    const result = await run({ url: PAGE });
    expect(codeOf(result)).toBe('access_denied');
    expect(messageOf(result)).toContain('Let agents use the browser');
    expect(asked).toEqual([]);
  });

  it('неизвестная операция — unsupported', async () => {
    const { run, asked } = setup();
    expect(codeOf(await run({ code: '1' }, REF, 'evaluate'))).toBe('unsupported');
    expect(asked).toEqual([]);
  });

  it('предел вкладок — bad_request с советом; работы нет в окне — window_not_connected', async () => {
    const limit = setup({ reply: { error: 'limit' } });
    const refused = await limit.run({ url: PAGE });
    expect(codeOf(refused)).toBe('bad_request');
    expect(messageOf(refused)).toContain('10 browser tabs');
    const noWork = setup({ reply: { error: 'no_work' } });
    const unknown = await noWork.run({ url: PAGE });
    expect(codeOf(unknown)).toBe('window_not_connected');
    expect(messageOf(unknown)).toContain('try again in a moment');
  });

  it('работа не смонтирована — вкладка добавлена, ответ ok с заметкой, а не отказ', async () => {
    const { run } = setup({ reply: { tabId: 'browser:aaaaaa', reused: false, mounted: false } });
    expect(okResult(await run({ url: PAGE }))).toEqual({ tab: 't1', url: PAGE, reused: false, notes: [NOT_MOUNTED_NOTE] });
  });
});

describe('окно ушло или молчит (Фокус ревью, п. 4)', () => {
  it('окна нет (просьба не ушла) и окно закрылось посреди вызова — window_not_connected сразу', async () => {
    const none = setup({ sent: false });
    expect(codeOf(await none.run({ url: PAGE }))).toBe('window_not_connected');
    const ops = createAgentOps({
      agentsAllowed: async () => true,
      openTab: () => {
        throw new Error('Object has been destroyed');
      },
    });
    const result = await ops.run({ opId: 'op-1', ref: REF, label: 'S02', op: 'open', args: { url: PAGE } });
    expect(codeOf(result)).toBe('window_not_connected');
  });

  it('окно молчит — timeout через openMs; поздний ответ ничего не ломает и ничего не принимает', async () => {
    const { run, ops, asked } = setup({ reply: null, openMs: 30 });
    expect(codeOf(await run({ url: PAGE }))).toBe('timeout');
    expect(() => ops.openTabResult(asked[0]?.requestId ?? '', { tabId: 'browser:late00', reused: false, mounted: true })).not.toThrow();
    expect(() => ops.openTabResult('never-asked', { error: 'limit' })).not.toThrow();
  });

  it('ответ на чужую просьбу не закрывает другую: каждая ждёт свой requestId', async () => {
    const { run, ops, asked } = setup({ reply: null, openMs: 200 });
    const first = run({ url: PAGE });
    const second = run({ url: 'http://localhost:5173/second' });
    await Promise.resolve();
    expect(asked).toHaveLength(2);
    ops.openTabResult(asked[1]?.requestId ?? '', { tabId: 'browser:bbbbbb', reused: false, mounted: true });
    expect(okResult(await second).url).toBe('http://localhost:5173/second');
    ops.openTabResult(asked[0]?.requestId ?? '', { tabId: 'browser:aaaaaa', reused: false, mounted: true });
    expect(okResult(await first).url).toBe(PAGE);
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/shared/loopback.test.ts src/main/browser/agent-ops.test.ts` → FAIL: модули `./loopback.js` и `./agent-ops.js` не найдены.

- [ ] **Шаг 3. Реализовать.** Новый файл `shared/loopback.ts`:

```ts
/**
 * Loopback для агента (спека 2026-10-07-browser-devtools-agent-design.md, раздел 7): URL со схемой http или https и
 * хостом `localhost`, `*.localhost`, `127.0.0.0/8` или `[::1]`. Адреса локальной сети, `0.0.0.0` и прочие — не loopback.
 * Функция одна на всё окно: ей пользуются `agent-ops.ts` (этап B2) и дальше `guard.ts` и умолчание «Agent access» вкладки
 * (этапы C и D). Разбор — WHATWG `URL`: он сам приводит `127.1`, десятичную и шестнадцатеричную запись IPv4 к виду a.b.c.d
 * и отделяет имя хоста от `user@`: у `http://localhost@evil.com/` хост — `evil.com`.
 */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // Точка в конце имени (`localhost.`) — то же имя: её снимают и браузер, и DNS.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]') return true;
  return IPV4.exec(host)?.[1] === '127';
}
```

  Типы в `shared/browser-types.ts`:

После строк:

```ts
  pngPath: string | null;
}

```

вставить:

```ts
/**
 * Агент просит окно открыть вкладку (событие `browser:agent-open-tab`, спека браузера 2026-10-07, 3.5, 5.1 `browser_open`;
 * этап B2). Адрес main уже проверил: http(s) на loopback, без учётных данных. Работу называет хост по токену сессии, а не
 * агент.
 */
export interface AgentOpenTab {
  requestId: string;
  workKey: string;
  url: string;
  /** Сессия-агент: справа от её вкладки встаёт новая, если браузерных вкладок в работе нет. */
  sessionId: string;
  /** Короткий номер сессии для тоста «S02 opened …». */
  session: string;
}

/**
 * Ответ окна на `AgentOpenTab` (канал `browser:agent-open-tab-result`): id вкладки раскладки (новой или уже показывавшей эту
 * страницу — `reused`) и смонтирована ли работа (LRU: у размонтированной гостя нет, страница загрузится, когда человек её
 * откроет); или почему вкладки нет — предел 10 вкладок или работы нет в окне.
 */
export type AgentOpenTabResult =
  | { tabId: string; reused: boolean; mounted: boolean }
  | { error: 'limit' | 'no_work' };

```

  Новый файл `main/browser/agent-ops.ts`:

```ts
/**
 * Операции агента над браузером окна в main (спека 2026-10-07-browser-devtools-agent-design.md, 3.7, 5.1–5.2, 7; этап B2:
 * `open`). Событие хоста `browser.agentOp` приходит сюда (`host-connection.ts#answerBrowserAgentOps`), ответ уходит
 * методом `browser.agentResult`.
 *
 * Агент называет только адрес: работу вкладки задаёт хост по токену сессии (`ref` события), а не аргументы. Адрес должен
 * быть http(s) на loopback (`shared/loopback.ts`) и до окна доходит без учётных данных. Раскладка — дело окна:
 * место вкладки, предел 10, повтор уже открытой страницы и тост решает рендерер (`renderer/browser/agent-open.ts`), main
 * просит его событием `browser:agent-open-tab`, ждёт ответ не дольше `AGENT_LIMITS.openMs` и переводит его в ответ агенту.
 * Страницу main не трогает: ни гостя, ни CDP, ни ожидания загрузки (это этапы C и D).
 *
 * Вкладку агент называет коротким id (`t1`, `t2`…): у каждой работы свой счёт, id держится, пока жив main. Этапы C и D
 * опираются на те же id.
 */
import { randomUUID } from 'node:crypto';
import { AGENT_LIMITS, browserAgentArgs } from '@parley/protocol';
import type { BrowserAgentArgs, BrowserAgentErrorCode, BrowserAgentOpEvent, BrowserAgentOpenResult, BrowserAgentResult } from '@parley/protocol';
import type { AgentOpenTab, AgentOpenTabResult } from '../../shared/browser-types.js';
import { isLoopbackUrl } from '../../shared/loopback.js';
import { workKey as workKeyOf } from '../../shared/work-keys.js';

export interface AgentOpsDeps {
  /** «Let agents use the browser» (`UiFile.browser.agentsAllowed`): читается на каждую операцию. */
  agentsAllowed(): Promise<boolean>;
  /** Просит окно открыть вкладку (`browser:agent-open-tab`); `false` — окно не готово слушать. */
  openTab(e: AgentOpenTab): boolean;
  /** Сколько ждать ответа окна; по умолчанию `AGENT_LIMITS.openMs`. Тестам — меньше. */
  openMs?: number;
}

export interface AgentOps {
  run(request: BrowserAgentOpEvent): Promise<BrowserAgentResult>;
  /** Ответ окна на `browser:agent-open-tab` (канал `browser:agent-open-tab-result`); чужой и поздний id молча игнорируется. */
  openTabResult(requestId: string, result: AgentOpenTabResult): void;
}

/** Отказ операции с кодом протокола; текст читает агент. */
export class AgentOpError extends Error {
  readonly code: BrowserAgentErrorCode;

  constructor(code: BrowserAgentErrorCode, message: string) {
    super(message);
    this.name = 'AgentOpError';
    this.code = code;
  }
}

/** Схема аргументов по имени операции: хост другой версии может прислать незнакомую. */
type ArgsSchema = { safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } };
const ARGS: Partial<Record<string, ArgsSchema>> = browserAgentArgs;

const ok = (result: unknown): BrowserAgentResult => ({ ok: true, result });
const failure = (code: BrowserAgentErrorCode, message: string): BrowserAgentResult => ({ ok: false, error: { code, message } });

/** Пояснение агенту, когда работа вне LRU окна: вкладка в раскладке есть, гостя пока нет. */
export const NOT_MOUNTED_NOTE = "The workspace is not open in Parley's window, so the page loads when the human opens it.";

/** Адрес, который агент может открыть: http(s) на loopback, без учётных данных; иначе `null`. Фрагмент (#…) остаётся: им бывают маршруты SPA. */
export function loopbackHref(raw: string): string | null {
  if (!isLoopbackUrl(raw)) return null;
  const parsed = new URL(raw);
  parsed.username = '';
  parsed.password = '';
  return parsed.href;
}

export function createAgentOps(deps: AgentOpsDeps): AgentOps {
  const openMs = deps.openMs ?? AGENT_LIMITS.openMs;
  /** Ждущие ответа окна: id просьбы → продолжение. */
  const pendingOpens = new Map<string, (result: AgentOpenTabResult | 'no_window' | 'timeout') => void>();
  /** id агента по работе и вкладке; счёт — свой у каждой работы. */
  const ids = new Map<string, string>();
  const counters = new Map<string, number>();

  function agentIdFor(workKey: string, tabId: string): string {
    const key = `${workKey}\n${tabId}`;
    const known = ids.get(key);
    if (known !== undefined) return known;
    const next = (counters.get(workKey) ?? 0) + 1;
    counters.set(workKey, next);
    const id = `t${next}`;
    ids.set(key, id);
    return id;
  }

  function askWindow(event: AgentOpenTab): Promise<AgentOpenTabResult | 'no_window' | 'timeout'> {
    return new Promise((resolve) => {
      const done = (result: AgentOpenTabResult | 'no_window' | 'timeout'): void => {
        clearTimeout(timer);
        pendingOpens.delete(event.requestId);
        resolve(result);
      };
      const timer = setTimeout(() => done('timeout'), openMs);
      pendingOpens.set(event.requestId, done);
      let sent = false;
      try {
        sent = deps.openTab(event);
      } catch {
        // Окно закрыто посреди вызова — как будто его нет.
      }
      if (!sent) done('no_window');
    });
  }

  async function openOf(request: BrowserAgentOpEvent, args: BrowserAgentArgs<'open'>): Promise<BrowserAgentOpenResult> {
    const url = loopbackHref(args.url);
    if (url === null) {
      throw new AgentOpError('not_loopback', 'Only http(s) pages on localhost can be opened: pass an absolute URL such as http://localhost:5173/.');
    }
    const workKey = workKeyOf(request.ref.projectPath, request.ref.workId);
    const answer = await askWindow({ requestId: randomUUID(), workKey, url, sessionId: request.ref.sessionId, session: request.label });
    if (answer === 'no_window') throw new AgentOpError('window_not_connected', "Parley's window is not ready: ask the human to open it.");
    if (answer === 'timeout') throw new AgentOpError('timeout', `The window did not place the tab within ${Math.round(openMs / 1000)} s.`);
    if ('error' in answer) {
      throw answer.error === 'limit'
        ? new AgentOpError('bad_request', 'This workspace already has 10 browser tabs, the most Parley allows. Ask the human to close one.')
        : new AgentOpError('window_not_connected', "Parley's window does not know this workspace yet: try again in a moment.");
    }
    return { tab: agentIdFor(workKey, answer.tabId), url, reused: answer.reused, notes: answer.mounted ? [] : [NOT_MOUNTED_NOTE] };
  }

  return {
    async run(request) {
      const schema = ARGS[request.op];
      if (schema === undefined) {
        return failure('unsupported', `This window does not know the operation ${String(request.op)}: ask the human to restart Parley.`);
      }
      const parsed = schema.safeParse(request.args ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined || issue.path.length === 0 ? 'args' : issue.path.map(String).join('.');
        return failure('bad_request', `Invalid arguments for ${request.op}: ${where} — ${issue?.message ?? 'invalid'}.`);
      }
      if (!(await deps.agentsAllowed())) {
        return failure('access_denied', 'The human turned off agent access to the browser (Settings → Browser → Let agents use the browser).');
      }
      try {
        switch (request.op) {
          case 'open':
            return ok(await openOf(request, parsed.data as BrowserAgentArgs<'open'>));
        }
      } catch (error) {
        if (error instanceof AgentOpError) return failure(error.code, error.message);
        return failure('unsupported', error instanceof Error ? error.message : String(error));
      }
    },
    openTabResult(requestId, result) {
      pendingOpens.get(requestId)?.(result);
    },
  };
}
```

- [ ] **Шаг 4. Запустить — проходит.**
  - Команда шага 2 → PASS.
  - `pnpm --filter @parley/desktop typecheck` → без ошибок.
  - `pnpm --filter @parley/desktop exec vitest run src/english-ui.test.ts` → PASS.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/shared/loopback.ts packages/desktop/src/shared/loopback.test.ts packages/desktop/src/shared/browser-types.ts packages/desktop/src/main/browser/agent-ops.ts packages/desktop/src/main/browser/agent-ops.test.ts
git commit -m "feat(desktop): main — loopback и операция open агента: проверки, просьба окну, ответ агенту" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Задача 9. Настройка «Let agents use the browser»

**Файлы:**
- Изменить: `packages/desktop/src/shared/ui-types.ts`, `packages/desktop/src/shared/strings.ts`, `packages/desktop/src/renderer/components/settings/SettingsDialog.tsx`
- Тесты: `packages/desktop/src/shared/ui-types.test.ts`, `packages/desktop/src/main/ui-store.test.ts`, `packages/desktop/src/renderer/components/settings/SettingsDialog.test.tsx`; правка существующего теста `packages/desktop/src/renderer/browser/BrowserSurface.test.tsx` под новый тип

**Интерфейсы:**
- Берёт (этап A): `UiFile.browser` (`BrowserUi { devtoolsHeight }`), `normalizeUi`/`normalizeBrowser`, `DEFAULT_UI`; `NotificationRow`, `useUiStore.patchUi`, `uiLoaded` в `SettingsDialog`.
- Отдаёт (индекс: `UiFile.browser.agentsAllowed`, `S.settings.letAgentsUseBrowser`):
  - `BrowserUi.agentsAllowed: boolean` (по умолчанию `true`); `ui.json` без поля или с не-boolean в нём читается как `true`: `normalizeUi` чинит старый файл;
  - строки `S.settings.letAgentsUseBrowser` («Let agents use the browser») и `S.settings.letAgentsUseBrowserHint`;
  - переключатель в Settings → Browser под «Clear browser data», подпись и подсказка. Он показывается всегда, как «Clear browser data»: старый хост просто не пришлёт операций, и прятать выключатель по `useHostSupports` незачем.
- Читает значение main на каждую операцию (`uiStore.load()`, задача 10), поэтому выключатель действует сразу, без перезапуска сессий.

- [ ] **Шаг 1. Написать падающие тесты.** `shared/ui-types.test.ts`:

Правка 1 из 2.

Заменить:

```ts
  it('по умолчанию высоты панели нет — 40 % вкладки', () => {
    expect(normalizeUi({}).browser).toEqual({ devtoolsHeight: null });
  });
```

на:

```ts
  it('по умолчанию высоты панели нет — 40 % вкладки', () => {
    expect(normalizeUi({}).browser).toEqual({ devtoolsHeight: null, agentsAllowed: true });
  });
```

Правка 2 из 2.

После строк:

```ts
      expect(normalizeUi({ hiddenProjects: garbage }).hiddenProjects, JSON.stringify(garbage)).toEqual([]);
    }
  });
});

```

вставить:

```ts
describe('browser.agentsAllowed (спека браузера 4.8; этап B2)', () => {
  it('по умолчанию включён; false сохраняется; не boolean — по умолчанию', () => {
    expect(DEFAULT_UI.browser.agentsAllowed).toBe(true);
    expect(normalizeUi({}).browser.agentsAllowed).toBe(true);
    expect(normalizeUi({ browser: { agentsAllowed: false } }).browser.agentsAllowed).toBe(false);
    expect(normalizeUi({ browser: { agentsAllowed: 'no' } }).browser.agentsAllowed).toBe(true);
    expect(normalizeUi({ browser: { agentsAllowed: 0 } }).browser.agentsAllowed).toBe(true);
  });

  it('поле высоты панели рядом не теряется', () => {
    expect(normalizeUi({ browser: { agentsAllowed: false, devtoolsHeight: 300 } }).browser).toEqual({ devtoolsHeight: 300, agentsAllowed: false });
  });
});

```

  `main/ui-store.test.ts` (поле хранится и читается обратно):

Заменить:

```ts
    const store = createUiStore(file);
    await store.save({ browser: { devtoolsHeight: 260 } });
    await store.save({ appearance: 'dark' });
    expect((await store.load()).browser).toEqual({ devtoolsHeight: 260 });
  });

  it('пустой патч browser не стирает сохранённую высоту панели: browser сливается по одному уровню (NESTED_KEYS)', async () => {
    const store = createUiStore(file);
    await store.save({ browser: { devtoolsHeight: 260 } });
    await store.save({ browser: {} });
    expect((await store.load()).browser).toEqual({ devtoolsHeight: 260 });
  });
```

на:

```ts
    const store = createUiStore(file);
    await store.save({ browser: { ...DEFAULT_UI.browser, devtoolsHeight: 260 } });
    await store.save({ appearance: 'dark' });
    expect((await store.load()).browser).toEqual({ devtoolsHeight: 260, agentsAllowed: true });
  });

  it('browser.agentsAllowed сохраняется и читается обратно; патч других полей его не трогает (этап B2)', async () => {
    const store = createUiStore(file);
    await store.save({ browser: { ...DEFAULT_UI.browser, agentsAllowed: false } });
    await store.save({ appearance: 'dark' });
    expect((await store.load()).browser).toEqual({ devtoolsHeight: null, agentsAllowed: false });
  });

  it('пустой патч browser не стирает сохранённую высоту панели: browser сливается по одному уровню (NESTED_KEYS)', async () => {
    const store = createUiStore(file);
    await store.save({ browser: { ...DEFAULT_UI.browser, devtoolsHeight: 260 } });
    await store.save({ browser: {} as typeof DEFAULT_UI.browser });
    expect((await store.load()).browser).toEqual({ devtoolsHeight: 260, agentsAllowed: true });
  });
```

  `SettingsDialog.test.tsx`:

После строк:

```tsx
    expect(screen.queryByRole('switch', { name: 'Answer Codex approvals in Parley' })).toBeNull();
  });
});

```

вставить:

```tsx
describe('SettingsDialog — «Let agents use the browser» (спека браузера 4.8; этап B2)', () => {
  it('в секции Browser, включён по умолчанию; клик — app.saveUi с browser.agentsAllowed: false и зеркало ui', async () => {
    const bridge = createFakeBridge();
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    openSettings(bridge);

    switchTo('Browser');
    const toggle = await screen.findByLabelText('Let agents use the browser');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(S.settings.letAgentsUseBrowserHint)).toBeTruthy();
    fireEvent.click(toggle);

    await waitFor(() => expect(saveUiSpy).toHaveBeenCalledWith({ browser: { ...DEFAULT_UI.browser, agentsAllowed: false } }));
    expect(useUiStore.getState().ui.browser.agentsAllowed).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('выключенный выключатель из ui.json показан выключенным; высота панели в патче не теряется', async () => {
    const bridge = createFakeBridge();
    await bridge.app.saveUi({ browser: { devtoolsHeight: 320, agentsAllowed: false } });
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    openSettings(bridge);

    switchTo('Browser');
    const toggle = await screen.findByLabelText('Let agents use the browser');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(saveUiSpy).toHaveBeenCalledWith({ browser: { devtoolsHeight: 320, agentsAllowed: true } }));
  });
});

```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/shared/ui-types.test.ts src/main/ui-store.test.ts src/renderer/components/settings/SettingsDialog.test.tsx` → FAIL: у `BrowserUi` нет `agentsAllowed`, переключателя в диалоге нет.

- [ ] **Шаг 3. Реализовать.** `shared/ui-types.ts`:

Правка 1 из 3.

Заменить:

```ts

/** Вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, 4.3): высота панели Console | Network — общая. */
export interface BrowserUi {
  /** null — 40 % высоты вкладки (`DEVTOOLS_PANEL.defaultShare`). */
  devtoolsHeight: number | null;
}
```

на:

```ts

/** Вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, 4.3, 4.8): высота панели Console | Network — общая. */
export interface BrowserUi {
  /** null — 40 % высоты вкладки (`DEVTOOLS_PANEL.defaultShare`). */
  devtoolsHeight: number | null;
  /** «Let agents use the browser» (спека 4.8): выключен — все операции агента получают `access_denied`. */
  agentsAllowed: boolean;
}
```

Правка 2 из 3.

Заменить:

```ts
  voice: { enabled: false, model: null, language: 'auto' },
  browser: { devtoolsHeight: null },
};
```

на:

```ts
  voice: { enabled: false, model: null, language: 'auto' },
  browser: { devtoolsHeight: null, agentsAllowed: true },
};
```

Правка 3 из 3.

Заменить:

```ts
  const height = isFiniteNumber(source.devtoolsHeight) ? Math.max(Math.round(source.devtoolsHeight), DEVTOOLS_PANEL.minHeight) : null;
  return { devtoolsHeight: height };
}
```

на:

```ts
  const height = isFiniteNumber(source.devtoolsHeight) ? Math.max(Math.round(source.devtoolsHeight), DEVTOOLS_PANEL.minHeight) : null;
  return {
    devtoolsHeight: height,
    agentsAllowed: typeof source.agentsAllowed === 'boolean' ? source.agentsAllowed : DEFAULT_UI.browser.agentsAllowed,
  };
}
```

  `shared/strings.ts`:

После строк:

```ts
    checkForUpdatesHint: 'Looks for a newer Parley release on GitHub at start and once a day',
    /** Секция «Браузер» (кусок 9.1): куки, хранилища и кеш раздела встроенного браузера. */
    clearBrowserData: 'Clear browser data',
```

вставить:

```ts
    /** Общий выключатель агентов в браузере (спека браузера 4.8, этап B2). */
    letAgentsUseBrowser: 'Let agents use the browser',
    letAgentsUseBrowserHint:
      'Agents can open pages on localhost in a tab of their own workspace. Off: every browser request from an agent is refused.',
```

  `SettingsDialog.tsx`:

После строк:

```tsx
            <Button type="button" variant="outline" className="self-start" onClick={clearBrowserData}>
              {S.settings.clearBrowserData}
            </Button>
```

вставить:

```tsx
            {/* Общий выключатель агентов (спека браузера 4.8): строка та же, что у уведомлений, а смысл свой — доступ агента. */}
            {uiLoaded ? (
              <>
                <NotificationRow
                  label={S.settings.letAgentsUseBrowser}
                  checked={ui.browser.agentsAllowed}
                  onCheckedChange={(checked) => patchUi({ browser: { ...ui.browser, agentsAllowed: checked } })}
                />
                <p className="text-xs text-muted-foreground">{S.settings.letAgentsUseBrowserHint}</p>
              </>
            ) : null}
```

  Существующий тест `BrowserSurface.test.tsx` собирал `ui.browser` вручную без нового поля: поправка для типов, на поведение теста не влияет.

Заменить:

```tsx
  it('высота панели — из ui.json; ручка пишет новую в настройки окна', async () => {
    useUiStore.setState({ ui: { ...useUiStore.getState().ui, browser: { devtoolsHeight: 300 } } });
    setBrowserTab('http://localhost:5173/');
```

на:

```tsx
  it('высота панели — из ui.json; ручка пишет новую в настройки окна', async () => {
    useUiStore.setState({ ui: { ...useUiStore.getState().ui, browser: { ...useUiStore.getState().ui.browser, devtoolsHeight: 300 } } });
    setBrowserTab('http://localhost:5173/');
```

- [ ] **Шаг 4. Запустить — проходит.**
  - Команда шага 2 → PASS.
  - `pnpm --filter @parley/desktop exec vitest run src/renderer/browser/BrowserSurface.test.tsx src/english-ui.test.ts` → PASS.
  - `pnpm --filter @parley/desktop typecheck` → без ошибок.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/shared/ui-types.ts packages/desktop/src/shared/ui-types.test.ts packages/desktop/src/shared/strings.ts packages/desktop/src/main/ui-store.test.ts packages/desktop/src/renderer/components/settings/SettingsDialog.tsx packages/desktop/src/renderer/components/settings/SettingsDialog.test.tsx packages/desktop/src/renderer/browser/BrowserSurface.test.tsx
git commit -m "feat(desktop): настройка «Let agents use the browser» — общий выключатель агентов" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Задача 10. Мост операций агента: `hello`, `host-connection`, IPC, preload, проводка main

**Файлы:**
- Изменить: `packages/desktop/src/main/host-connection.ts`, `packages/desktop/src/main/ipc.ts`, `packages/desktop/src/preload/index.ts`, `packages/desktop/src/main/index.ts`, `packages/desktop/src/shared/browser-types.ts` (`BrowserApi`), `packages/desktop/src/renderer/test-utils/fake-bridge.ts`
- Тесты: `packages/desktop/src/main/host-connection.test.ts`, `packages/desktop/src/main/host-connection.oversize.test.ts`, `packages/desktop/src/main/ipc.test.ts`, `packages/desktop/src/preload/index.test.ts`

**Интерфейсы:**
- Берёт: `createAgentOps`, `AgentOps` (задача 8), `UiFile.browser.agentsAllowed` (задача 9), `HostConnection.onEvent`/`call`, `forwardHostToWindow`, `registerIpc` (его параметр `browser`), поверхность `bridge.browser` в `preload/index.ts` и её двойник `FakeBridge`.
- Отдаёт (индекс: «Мост окна»):
  - `hello.features` окна — `[COMPACT_WORKS_FEATURE, BROWSER_AGENT_FEATURE]`: хост направляет операции агента только окну с этой возможностью;
  - `answerBrowserAgentOps(connection, run): () => void` (`host-connection.ts`) — подписка main на событие `browser.agentOp`; ответ — метод `browser.agentResult` с тем же `opId`; сбой `run` — `unsupported` с текстом ошибки; оборванную связь хост закрывает сам;
  - `browser.agentResult` зовёт только main: канал `host:call` окна его не пускает (`MAIN_ONLY_METHODS`), а `forwardHostToWindow` не пересылает рендереру событие `browser.agentOp`;
  - `RegisterIpcOptions.browser.agent: Pick<AgentOps, 'openTabResult'>`, `parseAgentOpenTabResult(raw)` и канал `browser:agent-open-tab-result` (`requestId` 1–64 символа, форма ответа проверяется до main, иначе `bad_request`); событие окну `browser:agent-open-tab`;
  - `bridge.browser.onAgentOpenTab(listener)` и `bridge.browser.agentOpenTabResult(requestId, result)` (`BrowserApi`, preload); `FakeBridge`: `emitAgentOpenTab(e)`, `browser.onAgentOpenTab`, `browser.agentOpenTabResult` (журнал `browserCalls`: `{ method: 'agentOpenTabResult', args: [requestId, result] }`);
  - проводка `main/index.ts`: `agentsAllowed` читает `uiStore.load()` на каждую операцию; подписка `answerBrowserAgentOps` ставится до первого подключения к хосту (пока окно поднимается, агент получает `window_not_connected` с внятным текстом, а не тайм-аут); `openTab` отправляет просьбу окну, только если окно живо и его главный кадр не грузится (`webContents.isLoadingMainFrame()`; **не** `loadedWindows`: первый `<webview>` снимал бы его навсегда — глобальные ограничения). Эту проводку проверяет E2E (задача 12): в юнит-тест замыкание `main/index.ts` не вынесено.

- [ ] **Шаг 1. Написать падающие тесты.** `host-connection.test.ts`: журнал полученного фейковым хостом, `hello` с двумя возможностями, операции агента:

Правка 1 из 4.

Заменить:

```ts
import type { HostPaths } from '@parley/host';
import { encodeLine, LineDecoder, PROTOCOL_VERSION } from '@parley/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S } from '../shared/strings.js';
import { HostConnection } from './host-connection.js';

```

на:

```ts
import type { HostPaths } from '@parley/host';
import { BROWSER_AGENT_FEATURE, COMPACT_WORKS_FEATURE, encodeLine, LineDecoder, PROTOCOL_VERSION } from '@parley/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S } from '../shared/strings.js';
import { answerBrowserAgentOps, HostConnection } from './host-connection.js';

```

Правка 2 из 4.

После строк:

```ts
  methods?: string[];
  /** События сразу после ответа `hello` — как повтор активности настоящего хоста. */
  afterHello?: unknown[];
```

вставить:

```ts
  /** Всё, что клиент прислал: `hello`, вызовы методов (этап B2: что окно шлёт хосту). */
  received?: unknown[];
```

Правка 3 из 4.

После строк:

```ts
    const server = createServer((socket: Socket) => {
      const decoder = new LineDecoder();
      socket.on('data', (chunk: Buffer) => {
        for (const raw of decoder.push(chunk)) {
```

вставить:

```ts
          options.received?.push(raw);
```

Правка 4 из 4.

После строк:

```ts
  }, 10000);
});

```

вставить:

```ts
describe('операции агента над браузером (этап B2, спека браузера 3.7)', () => {
  let home: string;
  let paths: HostPaths;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-'));
    paths = {
      dir: path.join(home, 'host'),
      socket: path.join(home, 'host', 'host.sock'),
      token: path.join(home, 'host', 'host.token'),
      pid: path.join(home, 'host', 'host.pid'),
      log: path.join(home, 'host', 'host.log'),
    };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const op = (opId: string) => ({
    event: 'browser.agentOp',
    data: { opId, ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-02' }, label: 'S02', op: 'open', args: { url: 'http://localhost:5173/' } },
  });

  it('hello заявляет compact-works и browser-agent', async () => {
    await writeToken(paths);
    const received: unknown[] = [];
    const server = await startFakeServer(paths, { received });
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000 });
    await connection.connect();
    const hello = received.find((message) => (message as { method?: string }).method === 'hello') as { params: { features: string[] } };
    expect(hello.params.features).toEqual([COMPACT_WORKS_FEATURE, BROWSER_AGENT_FEATURE]);
    connection.close();
    server.close();
  });

  it('операция агента уходит в run, ответ — browser.agentResult с тем же opId; сбой run — unsupported', async () => {
    await writeToken(paths);
    const received: unknown[] = [];
    const server = await startFakeServer(paths, { received, afterHello: [op('op-1'), op('op-2')] });
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000 });
    answerBrowserAgentOps(connection, async (event) => {
      if (event.opId === 'op-2') throw new Error('boom');
      return { ok: true, result: { tab: 't1', url: 'http://localhost:5173/', reused: false, notes: [] } };
    });
    await connection.connect();
    const results = (): unknown[] =>
      received.filter((message) => (message as { method?: string }).method === 'browser.agentResult').map((message) => (message as { params: unknown }).params);
    await vi.waitFor(() => expect(results()).toHaveLength(2));
    expect(results()).toEqual(
      expect.arrayContaining([
        { opId: 'op-1', ok: true, result: { tab: 't1', url: 'http://localhost:5173/', reused: false, notes: [] } },
        { opId: 'op-2', ok: false, error: { code: 'unsupported', message: 'boom' } },
      ]),
    );
    connection.close();
    server.close();
  });

  it('прочие события run не получают; отписка снимает слушателя', async () => {
    await writeToken(paths);
    const server = await startFakeServer(paths, { afterHello: [{ event: 'wake.changed', data: { paused: true } }] });
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000 });
    const run = vi.fn(async () => ({ ok: true as const, result: null }));
    const off = answerBrowserAgentOps(connection, run);
    await connection.connect();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(run).not.toHaveBeenCalled();
    off();
    connection.close();
    server.close();
  });
});

```

  `host-connection.oversize.test.ts` (прежний тест `hello` ждал одну возможность):

Правка 1 из 2.

Заменить:

```ts
import type { HostPaths } from '@parley/host';
import { COMPACT_WORKS_FEATURE, encodeLine, LineDecoder, MAX_LINE_BYTES, PROTOCOL_VERSION } from '@parley/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
```

на:

```ts
import type { HostPaths } from '@parley/host';
import { BROWSER_AGENT_FEATURE, COMPACT_WORKS_FEATURE, encodeLine, LineDecoder, MAX_LINE_BYTES, PROTOCOL_VERSION } from '@parley/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
```

Правка 2 из 2.

Заменить:

```ts

  it('hello сообщает возможность compact-works', async () => {
    const fake = await startOversizeHost(paths);
    fakes.push(fake);
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000 });
    await connection.connect();
    expect(fake.hellos[0]?.['features']).toEqual([COMPACT_WORKS_FEATURE]);
    connection.close();
```

на:

```ts

  it('hello сообщает возможности compact-works и browser-agent', async () => {
    const fake = await startOversizeHost(paths);
    fakes.push(fake);
    const connection = new HostConnection({ paths, env: process.env, spawn: vi.fn(), connectTimeoutMs: 1000 });
    await connection.connect();
    expect(fake.hellos[0]?.['features']).toEqual([COMPACT_WORKS_FEATURE, BROWSER_AGENT_FEATURE]);
    connection.close();
```

  `ipc.test.ts`: подмена `agent-ops`, отказ `host:call` для `browser.agentResult`, `browser.agentOp` не уходит странице, форма ответа окна:

Правка 1 из 4.

Заменить:

```ts
import type { NotesFile } from '../shared/notes-types.js';
import { forwardHostToPages, registerIpc, withIpcError } from './ipc.js';
import { createRootsRegistry, FilesDeniedError, type RootsRegistry } from './roots.js';
```

на:

```ts
import type { NotesFile } from '../shared/notes-types.js';
import { forwardHostToPages, forwardHostToWindow, registerIpc, withIpcError } from './ipc.js';
import { createRootsRegistry, FilesDeniedError, type RootsRegistry } from './roots.js';
```

Правка 2 из 4.

После строк:

```ts
    scale: 0.5,
  })),
};
```

вставить:

```ts
/** Ответы окна на просьбы агента (этап B2): main/browser/agent-ops.ts подменён — мост проверяет только форму. */
const agentOps = { openTabResult: vi.fn() };
```

Правка 3 из 4.

После строк:

```ts
      annotate,
      inspector,
      emulation,
```

вставить:

```ts
      agent: agentOps,
```

Правка 4 из 4.

После строк:

```ts
    expect(annotate.capture).toHaveBeenCalledWith(7);
  });
});

```

вставить:

```ts
describe('канал агента — только для main (этап B2, спека браузера 3.7)', () => {
  const codeOf = async (promise: unknown): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      return decodeIpcError(error).code;
    }
    return 'resolved';
  };

  it('host:call не пускает browser.agentResult: ответ на операцию агента шлёт только main', async () => {
    const { ipcMain, connection } = setup();
    await expect(ipcMain.invoke('host:call', 'browser.agentResult', { opId: 'op-1', ok: true, result: {} })).rejects.toBeDefined();
    expect(connection.call).not.toHaveBeenCalled();
    // Положительный контроль: обычный метод проходит тем же путём.
    await ipcMain.invoke('host:call', 'works.list', {});
    expect(connection.call).toHaveBeenCalledWith('works.list', {});
  });

  it('forwardHostToWindow не пересылает странице browser.agentOp; прочие события — пересылает', () => {
    const captured: { listener?: (message: unknown) => void } = {};
    const connection = {
      onEvent: (listener: (message: unknown) => void) => {
        captured.listener = listener;
        return () => {};
      },
      onStatus: () => () => {},
    } as unknown as HostConnection;
    const sent: unknown[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (channel: string, data: unknown) => sent.push([channel, data]) } };
    forwardHostToWindow(connection, window as unknown as BrowserWindow);
    captured.listener?.({ event: 'browser.agentOp', data: { opId: 'op-1', args: { url: 'http://localhost:5173/' } } });
    captured.listener?.({ event: 'wake.changed', data: { paused: true } });
    expect(sent).toEqual([['host:event', { event: 'wake.changed', data: { paused: true } }]]);
  });

  it('agent-open-tab-result: ответ окна — в main; чужая форма, не вкладка браузера и не строка id — bad_request', async () => {
    const { ipcMain } = setup();
    agentOps.openTabResult.mockClear();
    await ipcMain.invoke('browser:agent-open-tab-result', 'r1', { tabId: 'browser:abc123', reused: false, mounted: false });
    expect(agentOps.openTabResult).toHaveBeenLastCalledWith('r1', { tabId: 'browser:abc123', reused: false, mounted: false });
    await ipcMain.invoke('browser:agent-open-tab-result', 'r2', { error: 'limit' });
    expect(agentOps.openTabResult).toHaveBeenLastCalledWith('r2', { error: 'limit' });
    await ipcMain.invoke('browser:agent-open-tab-result', 'r3', { error: 'no_work' });
    expect(agentOps.openTabResult).toHaveBeenLastCalledWith('r3', { error: 'no_work' });
    const bad: Array<[unknown, unknown]> = [
      ['r4', { tabId: 'terminal:s-01', reused: false, mounted: true }],
      ['r4', { tabId: 'browser:abc123', reused: 'yes', mounted: true }],
      ['r4', { tabId: 'browser:abc123', reused: false }],
      ['r4', { tabId: `browser:${'x'.repeat(200)}`, reused: false, mounted: true }],
      ['r4', { error: 'boom' }],
      ['r4', null],
      [7, { error: 'limit' }],
      ['', { error: 'limit' }],
      ['x'.repeat(65), { error: 'limit' }],
    ];
    for (const [requestId, raw] of bad) {
      expect(await codeOf(ipcMain.invoke('browser:agent-open-tab-result', requestId, raw)), JSON.stringify(raw)).toBe('bad_request');
    }
    expect(agentOps.openTabResult).toHaveBeenCalledTimes(3);
  });
});

```

  `preload/index.test.ts`:

После строк:

```ts
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(batch);
  });
```

вставить:

```ts

  it('browser.onAgentOpenTab: просьба агента приходит подписчику, отписка снимает его; agentOpenTabResult зовёт browser:agent-open-tab-result (этап B2)', async () => {
    const bridge = await loadPreload();
    const { ipcRenderer } = await import('electron');
    const listener = vi.fn();
    const off = bridge.browser.onAgentOpenTab(listener);
    const request = { requestId: 'r1', workKey: '/p w-1', url: 'http://localhost:5173/', sessionId: 's-02', session: 'S02' };
    emit('browser:agent-open-tab', request);
    off();
    emit('browser:agent-open-tab', request);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(request);
    await bridge.browser.agentOpenTabResult('r1', { tabId: 'browser:abc123', reused: false, mounted: true });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('browser:agent-open-tab-result', 'r1', { tabId: 'browser:abc123', reused: false, mounted: true });
  });
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/main/host-connection.test.ts src/main/host-connection.oversize.test.ts src/main/ipc.test.ts src/preload/index.test.ts` → FAIL: `answerBrowserAgentOps` не экспортируется, `hello` не несёт `browser-agent`, в `registerIpc` нет `browser.agent`, в preload нет `onAgentOpenTab`.

- [ ] **Шаг 3. Реализовать.** `main/host-connection.ts`:

Правка 1 из 3.

Заменить:

```ts
import {
  COMPACT_WORKS_FEATURE,
  encodeLine,
  LineDecoder,
  LineTooLongError,
  PROTOCOL_VERSION,
  refKey,
  type EventData,
```

на:

```ts
import {
  BROWSER_AGENT_FEATURE,
  COMPACT_WORKS_FEATURE,
  encodeLine,
  LineDecoder,
  LineTooLongError,
  PROTOCOL_VERSION,
  refKey,
  type BrowserAgentOpEvent,
  type BrowserAgentResult,
  type EventData,
```

Правка 2 из 3.

Заменить:

```ts
        method: 'hello',
        // Окно читает компактный снимок работ (P35): письма хвостом, старше — страницами `context.messages`.
        params: { token, protocol: PROTOCOL_VERSION, client: 'desktop', features: [COMPACT_WORKS_FEATURE] },
      }),
```

на:

```ts
        method: 'hello',
        // Окно читает компактный снимок работ (P35): письма хвостом, старше — страницами `context.messages`, и исполняет
        // операции агента над своим браузером (спека браузера 3.7).
        params: { token, protocol: PROTOCOL_VERSION, client: 'desktop', features: [COMPACT_WORKS_FEATURE, BROWSER_AGENT_FEATURE] },
      }),
```

Правка 3 из 3.

После строк:

```ts
    this.candidate = null;
  }
}

```

вставить:

```ts
/**
 * Операции агента над браузером окна (спека браузера 2026-10-07, 3.7; этап B2): событие хоста `browser.agentOp` исполняет
 * `run` в main, ответ уходит методом `browser.agentResult` с тем же `opId`. Сбой `run` — `unsupported` с текстом ошибки.
 * Ответ не дошёл (связь оборвалась) — хост сам ответит агенту `window_not_connected` или `timeout`.
 */
export function answerBrowserAgentOps(
  connection: Pick<HostConnection, 'onEvent' | 'call'>,
  run: (event: BrowserAgentOpEvent) => Promise<BrowserAgentResult>,
): () => void {
  return connection.onEvent((message) => {
    if (message.event !== 'browser.agentOp') return;
    const event = message.data as BrowserAgentOpEvent;
    void run(event)
      .catch(
        (error: unknown): BrowserAgentResult => ({
          ok: false,
          error: { code: 'unsupported', message: error instanceof Error ? error.message : String(error) },
        }),
      )
      .then((result) => connection.call('browser.agentResult', { opId: event.opId, ...result }))
      .catch((error: unknown) => console.warn('[parley] browser.agentResult failed', error));
  });
}

```

  `main/ipc.ts`:

Правка 1 из 8.

Заменить:

```ts
import { DEVTOOLS_LIMITS, isViewportSpec, type DevtoolsSnapshot } from '../shared/browser-devtools.js';
import type { ContextInput, SavedContext } from '../shared/browser-types.js';
import type { Appearance, UiFile } from '../shared/ui-types.js';
```

на:

```ts
import { DEVTOOLS_LIMITS, isViewportSpec, type DevtoolsSnapshot } from '../shared/browser-devtools.js';
import type { AgentOpenTabResult, ContextInput, SavedContext } from '../shared/browser-types.js';
import type { Appearance, UiFile } from '../shared/ui-types.js';
```

Правка 2 из 8.

После строк:

```ts
import { openOrReveal, revealInFinder } from './files/open-path.js';
import { FilesDeniedError, type RootsRegistry } from './roots.js';
import { parseAnnotationPins, type createAnnotate } from './browser/annotate.js';
```

вставить:

```ts
import type { AgentOps } from './browser/agent-ops.js';
```

Правка 3 из 8.

После строк:

```ts
const METHOD_NAMES = new Set<string>(Object.keys(METHODS));
const NOTIFICATION_NAMES = new Set<string>(Object.keys(NOTIFICATIONS));

```

вставить:

```ts
/**
 * Методы, которые зовёт только main (спека браузера 2026-10-07, 3.7): ответ на операцию агента не приходит от страницы
 * окна — иначе она ответила бы агенту сама.
 */
const MAIN_ONLY_METHODS: ReadonlySet<string> = new Set(['browser.agentResult']);

```

Правка 4 из 8.

После строк:

```ts
    isFocusTarget(value.target)
  );
}

```

вставить:

```ts
/** Ответ окна на просьбу агента открыть вкладку (спека браузера 3.5, этап B2): форма — до main. */
export function parseAgentOpenTabResult(raw: unknown): AgentOpenTabResult | null {
  if (!isRecord(raw)) return null;
  if (raw.error === 'limit' || raw.error === 'no_work') return { error: raw.error };
  const { tabId, reused, mounted } = raw;
  if (typeof tabId !== 'string' || !tabId.startsWith('browser:') || tabId.length > 200) return null;
  if (typeof reused !== 'boolean' || typeof mounted !== 'boolean') return null;
  return { tabId, reused, mounted };
}

```

Правка 5 из 8.

После строк:

```ts
    inspector: Pick<Inspector, 'snapshot' | 'clear' | 'responseBody' | 'ready'>;
    /** Размер вьюпорта (спека 2026-10-07, 4.2): main/browser/emulation.ts#createEmulation. */
    emulation: Pick<Emulation, 'set'>;
```

вставить:

```ts
    /** Ответы окна на просьбы агента (спека браузера 3.7, этап B2): main/browser/agent-ops.ts. */
    agent: Pick<AgentOps, 'openTabResult'>;
```

Правка 6 из 8.

Заменить:

```ts
    withIpcError(async (_event, method: unknown, params: unknown) => {
      if (typeof method !== 'string' || !isMethodName(method)) {
        throw new Error(`unknown method: ${String(method)}`);
```

на:

```ts
    withIpcError(async (_event, method: unknown, params: unknown) => {
      if (typeof method !== 'string' || !isMethodName(method) || MAIN_ONLY_METHODS.has(method)) {
        throw new Error(`unknown method: ${String(method)}`);
```

Правка 7 из 8.

После строк:

```ts
      return browser.inspector.responseBody(guest.id, requestId, DEVTOOLS_LIMITS.panelBody);
    }),
  );

```

вставить:

```ts
  // Ответ окна на `browser:agent-open-tab` (спека браузера 3.7, этап B2): id вкладки раскладки или причина отказа. Чужой или
  // поздний id main просто не найдёт — просьба уже закрыта.
  ipcMain.handle(
    'browser:agent-open-tab-result',
    withIpcError(async (_event, requestId: unknown, raw: unknown) => {
      const result = parseAgentOpenTabResult(raw);
      if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 64 || result === null) {
        throw new HostError('bad_request', 'invalid agent open-tab result');
      }
      browser.agent.openTabResult(requestId, result);
    }),
  );

```

Правка 8 из 8.

После строк:

```ts
): { dispose: () => void } {
  const unsubEvent = connection.onEvent((message) => {
    if (window.isDestroyed()) return;
```

вставить:

```ts
    // Операция агента — дело main (`answerBrowserAgentOps`): странице окна её аргументы не нужны.
    if (message.event === 'browser.agentOp') return;
```

  `preload/index.ts`:

Правка 1 из 4.

После строк:

```ts
import type { AppNote, CloseAnswer, FocusTarget, ParleyBridge, HostStatus, UpdateInfo } from '../shared/bridge.js';
import type { DevtoolsBatch, DevtoolsSnapshot, ResponseBody, ViewportSpec } from '../shared/browser-devtools.js';
import type {
```

вставить:

```ts
  AgentOpenTab,
  AgentOpenTabResult,
```

Правка 2 из 4.

После строк:

```ts
const browserFaviconListeners = new Set<(e: BrowserFavicon) => void>();
const browserFocusListeners = new Set<(e: { webContentsId: number }) => void>();
const browserDevtoolsListeners = new Set<(batch: DevtoolsBatch) => void>();
```

вставить:

```ts
const browserAgentOpenTabListeners = new Set<(e: AgentOpenTab) => void>();
```

Правка 3 из 4.

После строк:

```ts
  for (const listener of browserDevtoolsListeners) listener(batch);
});

```

вставить:

```ts
ipcRenderer.on('browser:agent-open-tab', (_event, e: AgentOpenTab) => {
  for (const listener of browserAgentOpenTabListeners) listener(e);
});

```

Правка 4 из 4.

После строк:

```ts
    },
    setViewport: (webContentsId: number, spec: ViewportSpec | null, area: { width: number; height: number }) =>
      ipcRenderer.invoke('browser:set-viewport', webContentsId, spec, area) as Promise<{ scale: number }>,
```

вставить:

```ts
    onAgentOpenTab: (listener: (e: AgentOpenTab) => void) => {
      browserAgentOpenTabListeners.add(listener);
      return () => browserAgentOpenTabListeners.delete(listener);
    },
    agentOpenTabResult: (requestId: string, result: AgentOpenTabResult) =>
      ipcRenderer.invoke('browser:agent-open-tab-result', requestId, result) as Promise<void>,
```

  Типы моста в `shared/browser-types.ts`:

После строк:

```ts
  onDevtools(listener: (batch: DevtoolsBatch) => void): () => void;
  /** Размер вьюпорта (спека 4.2), null — Fit; area — место под страницу в поле вкладки. Ответ — вписывание. */
  setViewport(webContentsId: number, spec: ViewportSpec | null, area: { width: number; height: number }): Promise<{ scale: number }>;
```

вставить:

```ts
  /** Агент просит открыть вкладку (`browser:agent-open-tab`, этап B2): окно ставит её и отвечает `agentOpenTabResult`. */
  onAgentOpenTab(listener: (e: AgentOpenTab) => void): () => void;
  /** Ответ окна main на просьбу агента (`browser:agent-open-tab-result`): id вкладки раскладки или причина отказа. */
  agentOpenTabResult(requestId: string, result: AgentOpenTabResult): Promise<void>;
```

  Двойник моста окна `renderer/test-utils/fake-bridge.ts`:

Правка 1 из 5.

После строк:

```ts
import type { AppNote, CloseAnswer, FocusTarget, ParleyBridge, HostStatus, UpdateInfo } from '../../shared/bridge.js';
import type { DevtoolsBatch, DevtoolsSnapshot, ResponseBody } from '../../shared/browser-devtools.js';
import type {
```

вставить:

```ts
  AgentOpenTab,
```

Правка 2 из 5.

После строк:

```ts
  emitFavicon(e: BrowserFavicon): void;
  /** Фокус гостя: событие `browser:focus` слушателям `browser.onFocus` (кусок 9.2b). */
  emitBrowserFocus(e: { webContentsId: number }): void;
```

вставить:

```ts
  /** Агент просит открыть вкладку: событие `browser:agent-open-tab` слушателям `browser.onAgentOpenTab` (этап B2). */
  emitAgentOpenTab(e: AgentOpenTab): void;
```

Правка 3 из 5.

После строк:

```ts
  const browserOpenTabListeners = new Set<(e: BrowserOpenTab) => void>();
  const browserFaviconListeners = new Set<(e: BrowserFavicon) => void>();
  const browserFocusListeners = new Set<(e: { webContentsId: number }) => void>();
```

вставить:

```ts
  const agentOpenTabListeners = new Set<(e: AgentOpenTab) => void>();
```

Правка 4 из 5.

После строк:

```ts
    emitBrowserFocus: (e) => {
      for (const listener of browserFocusListeners) listener(e);
    },
```

вставить:

```ts
    emitAgentOpenTab: (e) => {
      for (const listener of agentOpenTabListeners) listener(e);
    },
```

Правка 5 из 5.

После строк:

```ts
        browserCalls.push({ method: 'setViewport', args: [webContentsId, spec, area] });
        return { scale: viewportScale };
      },
```

вставить:

```ts
      onAgentOpenTab: (listener) => {
        agentOpenTabListeners.add(listener);
        return () => agentOpenTabListeners.delete(listener);
      },
      agentOpenTabResult: async (requestId, result) => {
        browserCalls.push({ method: 'agentOpenTabResult', args: [requestId, result] });
      },
```

  Проводка `main/index.ts`:

Правка 1 из 5.

После строк:

```ts
import type { WorksSnapshot } from '@parley/protocol';
import { BROWSER_PARTITION } from '../shared/browser-types.js';
import { S } from '../shared/strings.js';
```

вставить:

```ts
import { createAgentOps, type AgentOps } from './browser/agent-ops.js';
```

Правка 2 из 5.

Заменить:

```ts
import { registerFilesIpc } from './files/ipc.js';
import { HostConnection } from './host-connection.js';
import { hostPaths, resolveHostEntry, resolveNodeBin, spawnHost } from './host-launcher.js';
```

на:

```ts
import { registerFilesIpc } from './files/ipc.js';
import { answerBrowserAgentOps, HostConnection } from './host-connection.js';
import { hostPaths, resolveHostEntry, resolveNodeBin, spawnHost } from './host-launcher.js';
```

Правка 3 из 5.

После строк:

```ts
          return null;
        }
      },
    });

```

вставить:

```ts
    // Операции агента над браузером (спека браузера 2026-10-07, 3.7; этап B2). Подписка — до первого подключения: операция,
    // пришедшая, пока окно поднимается, получает внятный отказ, а не тайм-аут хоста.
    let agentOps: AgentOps | null = null;
    answerBrowserAgentOps(connection, async (event) =>
      agentOps === null
        ? { ok: false, error: { code: 'window_not_connected', message: "Parley's window is still starting: try again in a moment." } }
        : agentOps.run(event),
    );

```

Правка 4 из 5.

После строк:

```ts
          window.webContents.send('app:update-available', info);
        }
      },
    });

```

вставить:

```ts
    // Вкладку агента ставит окно (спека браузера 3.7): место, предел, повтор страницы и тост — его дело. Окно, у которого
    // страница ещё грузится (прелоад не подписан) или которое закрыто, просьбу не получит: агенту сразу window_not_connected.
    // `loadedWindows` тут не годится: первый же `<webview>` даёт окну `did-start-loading` (а `did-finish-load` — нет), и признак
    // снимался бы насовсем; главный кадр окна от гостей не зависит.
    const ops = createAgentOps({
      agentsAllowed: async () => (await uiStore.load()).browser.agentsAllowed,
      openTab: (e) => {
        const window = mainWindow;
        if (window === null || window.isDestroyed() || window.webContents.isLoadingMainFrame()) return false;
        window.webContents.send('browser:agent-open-tab', e);
        return true;
      },
    });
    agentOps = ops;

```

Правка 5 из 5.

После строк:

```ts
        annotate,
        inspector,
        emulation,
```

вставить:

```ts
        agent: ops,
```

- [ ] **Шаг 4. Запустить — проходит.**
  - Команда шага 2 → PASS.
  - `pnpm --filter @parley/desktop typecheck` → без ошибок: `BrowserApi`, preload, `FakeBridge` и `main/index.ts` сходятся.
  - `pnpm --filter @parley/desktop exec vitest run src/main src/preload src/shared` → PASS (проверка, что прежние тесты main не сломаны; флейки сравнить с исходным прогоном).

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/main/host-connection.ts packages/desktop/src/main/host-connection.test.ts packages/desktop/src/main/host-connection.oversize.test.ts packages/desktop/src/main/ipc.ts packages/desktop/src/main/ipc.test.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/index.test.ts packages/desktop/src/main/index.ts packages/desktop/src/shared/browser-types.ts packages/desktop/src/renderer/test-utils/fake-bridge.ts
git commit -m "feat(desktop): мост операций агента — hello с browser-agent, host-connection, IPC, preload и проводка main" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Задача 11. Окно: вкладка агента — место, фон без фокуса, повтор, предел, тост «Show»

**Файлы:**
- Создать: `packages/desktop/src/renderer/browser/agent-open.ts`
- Изменить: `packages/desktop/src/renderer/browser/url.ts`, `packages/desktop/src/shared/strings.ts`, `packages/desktop/src/renderer/shell/AppShell.tsx`
- Тесты: `packages/desktop/src/renderer/browser/agent-open.test.ts`, `packages/desktop/src/renderer/browser/url.test.ts`, `packages/desktop/src/renderer/shell/AppShell.test.tsx`

**Интерфейсы:**
- Берёт: `bridge.browser.onAgentOpenTab` и `agentOpenTabResult` (задача 10); `AgentOpenTab`, `AgentOpenTabResult` (задача 8); `useLayoutStore` (`apply`, `layouts`, `setActiveWork`); `openTab(layout, tab, where, { focus: false })`, `findTab`, `groups`, `focusTab` (`layout/tree.ts`); `tabId.browser()` и `tabId.terminal(sessionId)` (`layout/ids.ts`); `BROWSER_LIMITS`, `browserTabCount` (`browser/store.ts`); `layoutUrl` (`browser/url.ts`); `ensureHydrated` (`layout/persistence.ts`); `toast` (`sonner`).
- Отдаёт:
  - `pageKey(url): string | null` (`browser/url.ts`) — страница без `#фрагмента`: `origin + pathname + search`; не `http(s)` и мусор — `null`;
  - `S.browser.agent.opened(session, url)` («S02 opened <url>», адрес длиннее 100 знаков режется многоточием) и `S.browser.agent.show` («Show»);
  - `openAgentTab(e, deps): AgentOpenTabResult` (`browser/agent-open.ts`):
    - раскладки работы нет — `{ error: 'no_work' }`;
    - вкладка работы уже показывает эту страницу (`pageKey` совпал) — `{ tabId, reused: true, mounted }`: раскладка, тост и предел не трогаются (повтор проверяется **до** предела: на пределе в 10 вкладок открытая страница по-прежнему отдаётся);
    - в работе уже 10 браузерных вкладок — `{ error: 'limit' }` без изменений и без тоста;
    - иначе вкладка встаёт без фокуса (`{ focus: false }`: активные вкладка и группа прежние, в пустой работе вкладка единственная и потому активная) **за последней браузерной вкладкой работы** (в визуальном порядке групп), а если их нет — **справа от вкладки сессии-агента**, а если нет и её — в активной группе; адрес в раскладку идёт через `layoutUrl` (без пароля из ссылки, с фрагментом); тост «S02 opened …» с действием «Show» (`announce`);
  - `showAgentTab(workKey, id)` — «Show» тоста, клик человека: `setActiveWork` и `focusTab`;
  - `answerAgentOpen(event, { hydrate, open, reply })` — просьба целиком: раскладку работы, которую окно за этот запуск не показывало, читают с диска до решения (`ensureHydrated`; иначе `layouts[workKey]` пуст и работа сошла бы за несуществующую); сбой чтения не мешает ответить; затем вкладка и ответ main (`agentOpenTabResult`); не дошедший ответ не бросает;
  - в `AppShell` — подписка `bridge.browser.onAgentOpenTab` с боевыми зависимостями: `mounted` — `lru.has(workKey)` (работа в LRU окна; вне LRU гостя нет, пока человек её не откроет).
- Активная работа, её вкладки, группа и история переходов человека агентом не меняются — ни при чужой, ни при своей работе (спека 5.2).

- [ ] **Шаг 1. Написать падающие тесты.** `browser/url.test.ts`:

Правка 1 из 2.

Заменить:

```ts
import { describe, expect, it } from 'vitest';
import { layoutUrl, normalizeUrl } from './url.js';

```

на:

```ts
import { describe, expect, it } from 'vitest';
import { layoutUrl, normalizeUrl, pageKey } from './url.js';

```

Правка 2 из 2.

После строк:

```ts
    expect(layoutUrl('')).toBeNull();
  });
});

```

вставить:

```ts
describe('pageKey (спека браузера 5.1, повторный browser_open; этап B2)', () => {
  it('origin, путь и query; фрагмент, учётные данные, регистр хоста и порт по умолчанию ключ не меняют', () => {
    const key = pageKey('http://localhost:5173/app?tab=1');
    expect(key).toBe('http://localhost:5173/app?tab=1');
    for (const same of ['http://localhost:5173/app?tab=1#/route', 'http://u:p@LOCALHOST:5173/app?tab=1', 'http://localhost:5173/app?tab=1#']) {
      expect(pageKey(same), same).toBe(key);
    }
    expect(pageKey('http://localhost:5173')).toBe(pageKey('http://localhost:5173/'));
    expect(pageKey('http://localhost:80/')).toBe(pageKey('http://localhost/'));
  });

  it('другая страница — другой ключ: путь, query, порт, схема и косая черта в конце различаются', () => {
    const keys = new Set(
      ['http://localhost:5173/app', 'http://localhost:5173/app/', 'http://localhost:5173/app?a=1', 'http://localhost:5173/app?a=2', 'http://localhost:5174/app', 'https://localhost:5173/app'].map(
        (url) => pageKey(url),
      ),
    );
    expect(keys.size).toBe(6);
  });

  it('не http(s) и не адрес — null', () => {
    for (const url of ['', 'about:blank', 'file:///etc/hosts', 'javascript:alert(1)', 'localhost:5173', 'not a url']) {
      expect(pageKey(url), url).toBeNull();
    }
  });
});

```

  Новый файл `browser/agent-open.test.ts`:

```ts
/**
 * Вкладка агента (`browser_open`, спека браузера 2026-10-07, 5.1, 5.2; этап B2): место, фон без фокуса, повтор уже открытой
 * страницы, предел 10, тост «S02 opened …» с «Show», гидрация раскладки работы, которую окно ещё не показывало.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentOpenTab, AgentOpenTabResult } from '../../shared/browser-types.js';
import type { GroupNode, TabSpec, WorkLayout } from '../../shared/layout-types.js';
import { tabId } from '../layout/ids.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore, type LayoutOp } from '../layout/store.js';
import { emptyLayout, findTab, focusTab, groups, openTab, splitGroup } from '../layout/tree.js';
import { answerAgentOpen, openAgentTab, showAgentTab, type AgentOpenAnswerDeps, type AgentOpenDeps } from './agent-open.js';
import { browserTabCount, wantsAddressFocus } from './store.js';

const KEY = '/tmp/p w-01';
const OTHER = '/tmp/q w-02';
const PAGE = 'http://localhost:5173/form';

const terminal = (sessionId: string): TabSpec => ({ kind: 'terminal', id: tabId.terminal(sessionId), sessionId });
const browser = (n: number, url = `http://localhost:${5170 + n}/`): TabSpec => ({ kind: 'browser', id: `browser:00000${n.toString(16)}`, url });

function request(patch: Partial<AgentOpenTab> = {}): AgentOpenTab {
  return { requestId: 'r1', workKey: KEY, url: PAGE, sessionId: 's-02', session: 'S02', ...patch };
}

/** Раскладка работы: терминалы s-01 и s-02 (активен s-01), потом `tabs`. */
function layoutWith(...tabs: TabSpec[]): WorkLayout {
  let layout = openTab(emptyLayout(), terminal('s-01'));
  layout = openTab(layout, terminal('s-02'));
  for (const tab of tabs) layout = openTab(layout, tab);
  return focusTab(layout, tabId.terminal('s-01'));
}

/** Зависимости над одной раскладкой в памяти: `apply` исполняет операцию сразу, как гидрированный стор. */
function deps(initial: WorkLayout | undefined, mounted = true) {
  let current = initial;
  const apply = vi.fn((key: string, op: LayoutOp) => {
    if (key === KEY && current !== undefined) {
      const next = op(current);
      current = 'layout' in next ? next.layout : next;
    }
    return null;
  });
  const announce = vi.fn<AgentOpenDeps['announce']>();
  const show = vi.fn<AgentOpenDeps['show']>();
  const all: AgentOpenDeps = {
    apply,
    get layouts() {
      return current === undefined ? {} : { [KEY]: current };
    },
    mounted,
    announce,
    show,
  };
  return { deps: all, apply, announce, show, current: () => current };
}

const placed = (result: AgentOpenTabResult): string => {
  if ('error' in result) throw new Error(`вкладка не встала: ${result.error}`);
  return result.tabId;
};

describe('openAgentTab — место и фон (спека 5.1, 5.2)', () => {
  it('браузерных вкладок нет — справа от вкладки сессии-агента; активная вкладка и группа прежние; адрес не просит фокус', () => {
    const d = deps(layoutWith());
    const before = d.current() as WorkLayout;
    const id = placed(openAgentTab(request(), d.deps));
    const after = d.current() as WorkLayout;
    const group = groups(after)[0] as GroupNode;
    expect(group.tabs.map((tab) => tab.id)).toEqual([tabId.terminal('s-01'), tabId.terminal('s-02'), id]);
    expect(group.tabs[2]).toEqual({ kind: 'browser', id, url: PAGE });
    expect(group.activeTabId).toBe(groups(before)[0]?.activeTabId);
    expect(after.activeGroupId).toBe(before.activeGroupId);
    expect(wantsAddressFocus(id)).toBe(false);
  });

  it('вкладка агента встаёт между вкладками, если сессия-агент не последняя', () => {
    let layout = openTab(emptyLayout(), terminal('s-02'));
    layout = openTab(layout, terminal('s-03'));
    const d = deps(layout);
    const id = placed(openAgentTab(request({ sessionId: 's-02' }), d.deps));
    expect((groups(d.current() as WorkLayout)[0] as GroupNode).tabs.map((tab) => tab.id)).toEqual([tabId.terminal('s-02'), id, tabId.terminal('s-03')]);
  });

  it('браузерные вкладки есть — за последней из них в визуальном порядке (в последней группе, где она есть)', () => {
    let layout = layoutWith(browser(1), browser(2));
    const first = layout.activeGroupId;
    layout = splitGroup(layout, first, 'row', terminal('s-03')).layout;
    layout = openTab(layout, browser(3));
    const d = deps(focusTab(layout, tabId.terminal('s-01')));
    const id = placed(openAgentTab(request(), d.deps));
    const all = groups(d.current() as WorkLayout);
    expect(all[1]?.tabs.map((tab) => tab.id)).toEqual([tabId.terminal('s-03'), browser(3).id, id]);
    expect(all[0]?.tabs.at(-1)?.id).toBe(browser(2).id);
  });

  it('пустая работа — вкладка единственная и потому активная: отнимать фокус не у кого', () => {
    const d = deps(emptyLayout());
    const id = placed(openAgentTab(request(), d.deps));
    expect((groups(d.current() as WorkLayout)[0] as GroupNode).activeTabId).toBe(id);
  });

  it('адрес без учётных данных; ответ — id вкладки, reused: false и смонтирована ли работа', () => {
    const d = deps(layoutWith(), false);
    const result = openAgentTab(request({ url: 'http://user:pw@localhost:5173/form#/step' }), d.deps);
    expect(result).toEqual({ tabId: expect.stringMatching(/^browser:[0-9a-f]{6}$/) as unknown as string, reused: false, mounted: false });
    const tab = findTab(d.current() as WorkLayout, placed(result));
    expect(tab?.group.tabs[tab.index]).toMatchObject({ kind: 'browser', url: 'http://localhost:5173/form#/step' });
  });
});

describe('openAgentTab — тост «Show»', () => {
  it('тост называет сессию и адрес; «Show» зовёт show с работой и новой вкладкой', () => {
    const d = deps(layoutWith());
    const id = placed(openAgentTab(request(), d.deps));
    expect(d.announce).toHaveBeenCalledTimes(1);
    const [text, show] = d.announce.mock.calls[0] as [string, () => void];
    expect(text).toBe('S02 opened http://localhost:5173/form');
    expect(d.show).not.toHaveBeenCalled();
    show();
    expect(d.show).toHaveBeenCalledWith(KEY, id);
  });

  it('длинный адрес в тосте режется многоточием; в раскладку идёт целиком', () => {
    const long = `http://localhost:5173/${'a'.repeat(300)}`;
    const d = deps(layoutWith());
    const id = placed(openAgentTab(request({ url: long }), d.deps));
    const [text] = d.announce.mock.calls[0] as [string, () => void];
    expect(text.length).toBeLessThanOrEqual('S02 opened '.length + 100);
    expect(text.endsWith('…')).toBe(true);
    const tab = findTab(d.current() as WorkLayout, id);
    expect(tab?.group.tabs[tab.index]).toMatchObject({ url: long });
  });
});

describe('openAgentTab — повтор и предел (Фокус ревью, п. 3)', () => {
  it('страница уже открыта (адрес без фрагмента) — её id, reused: true, раскладка и тост не тронуты', () => {
    const d = deps(layoutWith(browser(1, 'http://localhost:5173/form?step=2')));
    const before = d.current();
    const result = openAgentTab(request({ url: 'http://localhost:5173/form?step=2#/review' }), d.deps);
    expect(result).toEqual({ tabId: browser(1).id, reused: true, mounted: true });
    expect(d.apply).not.toHaveBeenCalled();
    expect(d.announce).not.toHaveBeenCalled();
    expect(d.current()).toBe(before);
  });

  it('другой query или путь — новая вкладка', () => {
    const d = deps(layoutWith(browser(1, 'http://localhost:5173/form?step=2')));
    const id = placed(openAgentTab(request({ url: 'http://localhost:5173/form?step=3' }), d.deps));
    expect(id).not.toBe(browser(1).id);
    expect(browserTabCount(d.current() as WorkLayout)).toBe(2);
  });

  it('два одинаковых запроса подряд — одна вкладка: второй видит первую', () => {
    const d = deps(layoutWith());
    const first = openAgentTab(request({ requestId: 'r1' }), d.deps);
    const second = openAgentTab(request({ requestId: 'r2' }), d.deps);
    expect(second).toEqual({ tabId: placed(first), reused: true, mounted: true });
    expect(browserTabCount(d.current() as WorkLayout)).toBe(1);
    expect(d.announce).toHaveBeenCalledTimes(1);
  });

  it('десять вкладок: новая страница — limit без изменений и тоста; уже открытая — по-прежнему reused', () => {
    const tabs = Array.from({ length: 10 }, (_, n) => browser(n));
    const d = deps(layoutWith(...tabs));
    const before = d.current();
    expect(openAgentTab(request(), d.deps)).toEqual({ error: 'limit' });
    expect(d.apply).not.toHaveBeenCalled();
    expect(d.announce).not.toHaveBeenCalled();
    expect(d.current()).toBe(before);
    expect(openAgentTab(request({ url: 'http://localhost:5173/' }), d.deps)).toEqual({ tabId: browser(3).id, reused: true, mounted: true });
  });

  it('закрытые вкладки в предел не идут; раскладки работы нет — no_work', () => {
    const closed = { ...layoutWith(...Array.from({ length: 9 }, (_, n) => browser(n))), closedTabs: [browser(11), browser(12)] };
    const d = deps(closed);
    expect(placed(openAgentTab(request(), d.deps))).toMatch(/^browser:/);
    expect(openAgentTab(request(), deps(undefined).deps)).toEqual({ error: 'no_work' });
  });
});

describe('вкладка агента в сторе окна: работа и вкладка человека не меняются (спека 5.2)', () => {
  beforeEach(() => {
    useLayoutStore.setState({ activeWorkKey: null, layouts: {}, hydrated: {}, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
  });

  afterEach(() => {
    useLayoutStore.setState({ activeWorkKey: null, layouts: {}, hydrated: {}, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
  });

  it('агент другой работы открывает вкладку: активная работа, её вкладка и история прежние; «Show» переключает на вкладку', () => {
    const own = layoutWith(browser(1));
    const away = openTab(openTab(emptyLayout(), terminal('s-07')), terminal('s-08'));
    useLayoutStore.setState({ activeWorkKey: KEY, layouts: { [KEY]: own, [OTHER]: away }, hydrated: { [KEY]: true, [OTHER]: true } });
    const before = useLayoutStore.getState();
    const announce = vi.fn<AgentOpenDeps['announce']>();
    const state = useLayoutStore.getState();
    const id = placed(
      openAgentTab(request({ workKey: OTHER, sessionId: 's-08', session: 'S08' }), {
        apply: state.apply,
        layouts: state.layouts,
        mounted: false,
        announce,
        show: showAgentTab,
      }),
    );
    const after = useLayoutStore.getState();
    expect(after.activeWorkKey).toBe(KEY);
    expect(after.layouts[KEY]).toBe(before.layouts[KEY]);
    expect(after.history).toBe(before.history);
    const group = groups(after.layouts[OTHER] as WorkLayout)[0] as GroupNode;
    expect(group.tabs.map((tab) => tab.id)).toEqual([tabId.terminal('s-07'), tabId.terminal('s-08'), id]);
    expect(group.activeTabId).toBe(tabId.terminal('s-08'));

    const [, show] = announce.mock.calls[0] as [string, () => void];
    show();
    expect(useLayoutStore.getState().activeWorkKey).toBe(OTHER);
    expect((groups(useLayoutStore.getState().layouts[OTHER] as WorkLayout)[0] as GroupNode).activeTabId).toBe(id);
  });
});

describe('answerAgentOpen — гидрация, вкладка, ответ main', () => {
  const calls: string[] = [];
  const answerDeps = (overrides: Partial<AgentOpenAnswerDeps> = {}): AgentOpenAnswerDeps => ({
    hydrate: async () => {
      calls.push('hydrate');
    },
    open: () => {
      calls.push('open');
      return { tabId: 'browser:abc123', reused: false, mounted: true };
    },
    reply: async () => {
      calls.push('reply');
    },
    ...overrides,
  });

  beforeEach(() => {
    calls.length = 0;
  });

  it('сперва гидрация работы, потом вкладка, потом ответ с тем же requestId', async () => {
    const reply = vi.fn<AgentOpenAnswerDeps['reply']>(async () => {
      calls.push('reply');
    });
    await answerAgentOpen(request({ requestId: 'req-7' }), answerDeps({ reply }));
    expect(calls).toEqual(['hydrate', 'open', 'reply']);
    expect(reply).toHaveBeenCalledWith('req-7', { tabId: 'browser:abc123', reused: false, mounted: true });
  });

  it('гидрация упала — вкладка и ответ всё равно идут: main не ждёт срок впустую', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await answerAgentOpen(
      request(),
      answerDeps({
        hydrate: () => {
          throw new Error('диск недоступен');
        },
      }),
    );
    expect(calls).toEqual(['open', 'reply']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ответ main не дошёл — не бросает', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(answerAgentOpen(request(), answerDeps({ reply: () => Promise.reject(new Error('ipc')) }))).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
```

  `shell/AppShell.test.tsx` — подписка, ответ main, тост и «Show» на настоящем `AppShell` с `FakeBridge`:

После строк:

```tsx
    act(() => bridge.emitBrowserOpenTab({ url: 'http://127.0.0.1:5173/x', openerWebContentsId: 99 }));
    expect(useLayoutStore.getState().layouts[key]).toBe(before);
  });
});

```

вставить:

```tsx
describe('AppShell — вкладка агента (browser_open, спека браузера 5.1, 5.2; этап B2)', () => {
  const REQUEST = { requestId: 'req-1', url: 'http://127.0.0.1:5173/form', sessionId: 's-02', session: 'S02' };

  /** w-01 активна и показана, w-02 — работа сессии-агента s-02. */
  async function agentWork(options: { shown: boolean }): Promise<void> {
    await renderShell([
      work('w-01', '2026-01-01', 'Первая', [session('s-01', 'один')]),
      work('w-02', '2026-01-02', 'Вторая', [session('s-02', 'два')]),
    ]);
    if (options.shown) await activateWithTerminal(keyOf('w-02'), 's-02');
    await activateWithTerminal(keyOf('w-01'), 's-01');
    vi.mocked(toast).mockClear();
  }

  const replies = (): Array<{ method: string; args: unknown[] }> => bridge.browserCalls.filter((call) => call.method === 'agentOpenTabResult');

  it('работа смонтирована: вкладка справа от терминала агента, его вкладка и активная работа прежние, ответ main, тост «Show» ведёт на вкладку', async () => {
    await agentWork({ shown: true });
    const away = keyOf('w-02');
    act(() => bridge.emitAgentOpenTab({ ...REQUEST, workKey: away }));
    await waitFor(() => expect(replies()).toHaveLength(1));

    const reply = replies()[0]?.args as [string, { tabId: string; reused: boolean; mounted: boolean }];
    expect(reply[0]).toBe('req-1');
    expect(reply[1]).toMatchObject({ reused: false, mounted: true });
    const group = groups(useLayoutStore.getState().layouts[away]!)[0]!;
    expect(group.tabs.map((tab) => tab.id)).toEqual([tabId.terminal('s-02'), reply[1].tabId]);
    expect(group.tabs[1]).toMatchObject({ kind: 'browser', url: 'http://127.0.0.1:5173/form' });
    expect(group.activeTabId).toBe(tabId.terminal('s-02'));
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-01'));

    const [text, options] = vi.mocked(toast).mock.calls.at(-1) as [string, { action: { label: string; onClick: () => void } }];
    expect(text).toBe('S02 opened http://127.0.0.1:5173/form');
    expect(options.action.label).toBe('Show');
    act(() => options.action.onClick());
    expect(useLayoutStore.getState().activeWorkKey).toBe(away);
    expect(groups(useLayoutStore.getState().layouts[away]!)[0]?.activeTabId).toBe(reply[1].tabId);
  });

  it('работу окно за этот запуск не показывало: раскладка читается с диска, вкладка встаёт, mounted: false, активная работа прежняя', async () => {
    await agentWork({ shown: false });
    const away = keyOf('w-02');
    expect(useLayoutStore.getState().hydrated[away]).toBeUndefined();
    act(() => bridge.emitAgentOpenTab({ ...REQUEST, workKey: away }));
    await waitFor(() => expect(replies()).toHaveLength(1));
    expect(useLayoutStore.getState().hydrated[away]).toBe(true);
    expect(replies()[0]?.args[1]).toMatchObject({ reused: false, mounted: false });
    expect(browserTabsOf(away)).toHaveLength(1);
    expect(useLayoutStore.getState().activeWorkKey).toBe(keyOf('w-01'));
  });

  it('та же страница второй раз — тот же tabId, reused: true, вкладок не больше, второго тоста нет; работы нет в окне — no_work', async () => {
    await agentWork({ shown: true });
    const away = keyOf('w-02');
    act(() => bridge.emitAgentOpenTab({ ...REQUEST, workKey: away }));
    await waitFor(() => expect(replies()).toHaveLength(1));
    act(() => bridge.emitAgentOpenTab({ ...REQUEST, requestId: 'req-2', workKey: away, url: 'http://127.0.0.1:5173/form#/step-2' }));
    await waitFor(() => expect(replies()).toHaveLength(2));
    const first = replies()[0]?.args[1] as { tabId: string };
    expect(replies()[1]?.args).toEqual(['req-2', { tabId: first.tabId, reused: true, mounted: true }]);
    expect(browserTabsOf(away)).toHaveLength(1);
    expect(vi.mocked(toast)).toHaveBeenCalledTimes(1);

    act(() => bridge.emitAgentOpenTab({ ...REQUEST, requestId: 'req-3', workKey: '/tmp/nowhere w-99' }));
    await waitFor(() => expect(replies()).toHaveLength(3));
    expect(replies()[2]?.args).toEqual(['req-3', { error: 'no_work' }]);
  });

  /** Браузерные вкладки раскладки работы. */
  function browserTabsOf(key: string): TabSpec[] {
    return groups(useLayoutStore.getState().layouts[key]!).flatMap((group) => group.tabs.filter((tab) => tab.kind === 'browser'));
  }
});

```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/renderer/browser/url.test.ts src/renderer/browser/agent-open.test.ts src/renderer/shell/AppShell.test.tsx` → FAIL: `pageKey` нет, модуля `./agent-open.js` нет, `AppShell` не слушает `onAgentOpenTab`.

- [ ] **Шаг 3. Реализовать.** `browser/url.ts`:

После строк:

```ts
  return parsed.href;
}

```

вставить:

```ts
/**
 * Ключ страницы для сверки адресов (спека браузера 5.1, `browser_open`): origin, путь и query, без #фрагмента и учётных
 * данных. У двух адресов с одним ключом — одна страница, и повторный `browser_open` вкладку не добавляет. Не http(s) или не
 * адрес — `null`.
 */
export function pageKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

```

  Строки в `shared/strings.ts`:

После строк:

```ts
      fellBack: (name: string): string => `The chosen session or room is gone — page context now goes to ${name}`,
      fellBackNowhere: 'The chosen session or room is gone, and there is no other one',
    },
```

вставить:

```ts
    /** Агент во вкладках (спека браузера 2026-10-07, 4.8, 5.1; этап B2: `browser_open`). */
    agent: {
      /** Тост, когда агент открыл вкладку (`browser_open`): адрес длиннее 100 знаков режется многоточием. */
      opened: (session: string, url: string): string => `${session} opened ${url.length > 100 ? `${url.slice(0, 99)}…` : url}`,
      /** Действие тоста: сделать эту вкладку активной. */
      show: 'Show',
    },
```

  Новый файл `browser/agent-open.ts`:

```ts
/**
 * Вкладка, которую открывает агент (`browser_open`, спека 2026-10-07-browser-devtools-agent-design.md, 5.1, 5.2; этап B2).
 * Main просит окно событием `browser:agent-open-tab` (`main/browser/agent-ops.ts`), окно ставит вкладку в раскладку работы
 * агента и отвечает `agentOpenTabResult`.
 *
 * Вкладка встаёт в работу сессии-агента и без фокуса: активные вкладка, группа и работа человека не меняются (спека 5.2).
 * Место — за последней браузерной вкладкой работы, а если их нет — справа от вкладки сессии-агента. Страница, которую
 * вкладка работы уже показывает (адрес без #фрагмента), открыта повторно не бывает: агент получает её id, а вкладок не
 * прибавляется — без `navigate` у агента повторные `browser_open` иначе копили бы вкладки до предела. Предел — те же 10,
 * что у человека (`BROWSER_LIMITS`), но отказ получает агент, а не тост человека. Тост «S02 opened …» говорит человеку,
 * откуда вкладка, и предлагает «Show» — сделать её активной (это клик человека).
 */

import type { AgentOpenTab, AgentOpenTabResult } from '../../shared/browser-types.js';
import type { WorkLayout } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore, type LayoutState } from '../layout/store.js';
import { findTab, focusTab, groups, openTab, type Where } from '../layout/tree.js';
import { BROWSER_LIMITS, browserTabCount } from './store.js';
import { layoutUrl, pageKey } from './url.js';

export interface AgentOpenDeps {
  apply: LayoutState['apply'];
  layouts: LayoutState['layouts'];
  /** Смонтирована ли работа (LRU окна): у размонтированной гостя не будет, пока человек её не откроет. */
  mounted: boolean;
  /** Тост «S02 opened …»; `show` — его действие «Show». */
  announce(text: string, show: () => void): void;
  /** Делает вкладку активной, а её работу — активной работой окна. */
  show(workKey: string, tabId: string): void;
}

/** Место вкладки агента: за последней браузерной вкладкой работы, иначе справа от вкладки сессии-агента, иначе в активной группе. */
function agentTabPlace(layout: WorkLayout, sessionId: string): Where {
  const all = groups(layout);
  for (let g = all.length - 1; g >= 0; g -= 1) {
    const group = all[g];
    if (group === undefined) continue;
    for (let i = group.tabs.length - 1; i >= 0; i -= 1) {
      if (group.tabs[i]?.kind === 'browser') return { groupId: group.id, index: i + 1 };
    }
  }
  const agent = findTab(layout, tabId.terminal(sessionId));
  return agent === null ? 'active' : { groupId: agent.group.id, index: agent.index + 1 };
}

/** Вкладка работы, которая уже показывает эту страницу. */
function sameDocumentTab(layout: WorkLayout, url: string): string | null {
  const key = pageKey(url);
  if (key === null) return null;
  for (const group of groups(layout)) {
    for (const tab of group.tabs) if (tab.kind === 'browser' && pageKey(tab.url) === key) return tab.id;
  }
  return null;
}

/**
 * Ставит вкладку агента (или называет уже открытую) и возвращает ответ для main. Раскладку работы читает уже гидрированной
 * (`answerAgentOpen`): `apply` тогда выполняется сразу, и решение о повторе и пределе принимается на той же раскладке, на
 * которую встаёт вкладка.
 */
export function openAgentTab(e: AgentOpenTab, deps: AgentOpenDeps): AgentOpenTabResult {
  const layout = deps.layouts[e.workKey];
  if (layout === undefined) return { error: 'no_work' };
  const same = sameDocumentTab(layout, e.url);
  if (same !== null) return { tabId: same, reused: true, mounted: deps.mounted };
  if (browserTabCount(layout) >= BROWSER_LIMITS.tabsPerWork) return { error: 'limit' };
  // Пароль из ссылки в раскладку и в src не идёт (спека окна 12.1).
  const url = layoutUrl(e.url) ?? e.url;
  const id = tabId.browser();
  deps.apply(e.workKey, (current) => openTab(current, { kind: 'browser', id, url }, agentTabPlace(current, e.sessionId), { focus: false }));
  deps.announce(S.browser.agent.opened(e.session, url), () => deps.show(e.workKey, id));
  return { tabId: id, reused: false, mounted: deps.mounted };
}

/** «Show» тоста: работа становится активной, вкладка — активной в своей группе. Нажимает человек. */
export function showAgentTab(workKey: string, id: string): void {
  const state = useLayoutStore.getState();
  state.setActiveWork(workKey);
  state.apply(workKey, (layout) => focusTab(layout, id));
}

export interface AgentOpenAnswerDeps {
  /** Гидрирует раскладку работы, которую окно ещё не показывало за этот запуск (`ensureHydrated`). */
  hydrate(workKey: string): Promise<void>;
  /** `openAgentTab` на живых сторах окна. */
  open(event: AgentOpenTab): AgentOpenTabResult;
  /** `bridge.browser.agentOpenTabResult`. */
  reply(requestId: string, result: AgentOpenTabResult): Promise<void>;
}

/**
 * Просьба агента целиком: раскладка работы, которую человек ещё не открывал, читается с диска до решения (иначе
 * `layouts[workKey]` пуст, и работа сошла бы за несуществующую), затем вкладка ставится и main получает ответ. Сбой чтения
 * раскладки не мешает ответить: работы нет — `no_work`.
 */
export async function answerAgentOpen(event: AgentOpenTab, deps: AgentOpenAnswerDeps): Promise<void> {
  try {
    await deps.hydrate(event.workKey);
  } catch (error) {
    console.warn('[parley] hydrate before agent open failed', error);
  }
  const result = deps.open(event);
  await deps.reply(event.requestId, result).catch((error: unknown) => console.warn('[parley] agentOpenTabResult failed', error));
}
```

  Проводка в `shell/AppShell.tsx`:

Правка 1 из 2.

Заменить:

```tsx
import { SurfaceLayer } from '../layout/SurfaceLayer.js';
import { useLayoutPersistence } from '../layout/persistence.js';
import { useLayoutStore } from '../layout/store.js';
import { measureGroupSizes } from '../layout/measure.js';
import { findTab, focusTab, groups, openTab } from '../layout/tree.js';
import { openBrowserTabFrom, useBrowserStore } from '../browser/store.js';
```

на:

```tsx
import { SurfaceLayer } from '../layout/SurfaceLayer.js';
import { ensureHydrated, useLayoutPersistence } from '../layout/persistence.js';
import { useLayoutStore } from '../layout/store.js';
import { measureGroupSizes } from '../layout/measure.js';
import { findTab, focusTab, groups, openTab } from '../layout/tree.js';
import { answerAgentOpen, openAgentTab, showAgentTab } from '../browser/agent-open.js';
import { openBrowserTabFrom, useBrowserStore } from '../browser/store.js';
```

Правка 2 из 2.

После строк:

```tsx
        });
      }),
    [bridge],
  );

```

вставить:

```tsx
  // Вкладка агента (`browser_open`, спека браузера 5.1; этап B2): в работе сессии-агента и без фокуса. Раскладку работы,
  // которую человек за этот запуск не открывал, окно сперва читает с диска; ответ main — id вкладки и смонтирована ли работа
  // (LRU): у работы вне LRU гостя не будет, пока человек её не откроет.
  useEffect(
    () =>
      bridge.browser.onAgentOpenTab((event) => {
        void answerAgentOpen(event, {
          hydrate: (key) =>
            ensureHydrated({
              bridge,
              works: useWorksStore.getState().entries.filter((entry) => workKey(entry.projectPath, entry.map.work.id) === key),
            }),
          open: (e) => {
            const state = useLayoutStore.getState();
            return openAgentTab(e, {
              apply: state.apply,
              layouts: state.layouts,
              mounted: lru.has(e.workKey),
              announce: (text, show) => toast(text, { action: { label: S.browser.agent.show, onClick: show } }),
              show: showAgentTab,
            });
          },
          reply: (requestId, result) => bridge.browser.agentOpenTabResult(requestId, result),
        });
      }),
    [bridge, lru],
  );

```

- [ ] **Шаг 4. Запустить — проходит.**
  - Команда шага 2 → PASS.
  - `pnpm --filter @parley/desktop typecheck` → без ошибок.
  - `pnpm --filter @parley/desktop exec vitest run src/renderer/browser src/renderer/shell src/english-ui.test.ts` → PASS (прежние тесты вкладок и оболочки целы).

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/renderer/browser/agent-open.ts packages/desktop/src/renderer/browser/agent-open.test.ts packages/desktop/src/renderer/browser/url.ts packages/desktop/src/renderer/browser/url.test.ts packages/desktop/src/shared/strings.ts packages/desktop/src/renderer/shell/AppShell.tsx packages/desktop/src/renderer/shell/AppShell.test.tsx
git commit -m "feat(desktop): вкладка агента в окне — место, фон без фокуса, повтор страницы, предел, тост «Show»" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Задача 12. E2E: `browser_open` — вкладка в фоне, повтор, предел, выключатель, токен

**Файлы:**
- Создать: `packages/desktop/e2e/browser-agent-open.spec.ts`

**Интерфейсы:**
- Берёт: всё предыдущее. Адрес и токен сессии тест берёт из её конфига MCP: путь — аргумент `--mcp-config` в журнале запусков заглушки (`STUB_ARGV_LOG`), в файле — `mcpServers.parley.env.PARLEY_AGENT_URL` и `PARLEY_AGENT_TOKEN`. Операции идут прямо в эндпоинт хоста (`fetch`, как у MCP-сервера), а проверка уровня MCP — через `STUB_MCP <инструмент> <json>`: заглушка запускает настоящий `parley-mcp` по тому же конфигу (`e2e/stub-echo-agent.mjs`, менять её не нужно). Правило приоритета тест берёт из `@parley/core` (`BROWSER_PRIORITY_RULE`), перезапуск окна — из `e2e/stop-app.ts` (`quitApp`).
- Тестов пять, у каждого свой дом и свой проект:
  1. **Вкладка в фоне рядом с сессией.** Вкладка встаёт справа от вкладки сессии-агента, вторая — за последней браузерной; выбранная вкладка прежняя; страница грузится; тост «S01 opened …», «Show» делает вкладку выбранной; та же страница с другим `#фрагментом` — вкладка `t1` и «no new tab was opened»; `https://example.com/`, `http://localhost.evil.test/`, `file:` — `not_loopback`, вкладки нет; токен — только в конфиге 0600, не в окружении процесса агента, не в argv, не в журнале хоста, не в тексте окна; в журнале хоста строки с origin, без пути, query и фрагмента; правило приоритета есть в `--append-system-prompt`.
  2. **Работа, которую окно после перезапуска не показывало.** Окно перезапущено с тем же домом и показывает вторую работу; агент первой работы открывает вкладку: ответ с заметкой о закрытой работе, активная работа и её вкладки прежние, страница не грузилась; «Show» переключает на работу агента, вкладка выбрана, страница грузится. Раскладку этой работы окно читает с диска по просьбе агента.
  3. **Предел десять вкладок.** Десять страниц подряд открываются (это же проверяет, что окно с живыми `<webview>` не считается неготовым); одиннадцатая — `bad_request` с «10 browser tabs»; уже открытая страница на пределе — «already shows».
  4. **«Let agents use the browser».** Через настоящий диалог Settings → Browser: выключен — `access_denied` (и по HTTP, и по MCP, с «Do not retry»), вкладки нет; включён — снова открывает.
  5. **Эндпоинт.** Чужой токен, пустой токен и запрос без токена — 401; лишние поля аргументов (`workKey`, `tab`, `projectPath`) — `bad_request`, вкладок нет; свой токен работает; после `sessions.stop` тот же токен — 401.

- [ ] **Шаг 1. Написать E2E.** Новый файл:

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_PRIORITY_RULE } from '@parley/core';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { quitApp, stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Канал агента, этап B2: `browser_open` (спека 2026-10-07-browser-devtools-agent-design.md, 3.7, 5.1, 5.2, 7; раздел 10,
 * E2E 6 в части открытия). Заглушка claude запускается хостом с конфигом MCP; тест берёт из конфига адрес и токен сессии,
 * зовёт эндпоинт хоста сам, как MCP-сервер, а через `STUB_MCP` — настоящий `parley-mcp`. Страницы — свой сервер на
 * 127.0.0.1. Настоящий агент не запускается, внешних сайтов нет.
 *
 * Проверяется:
 * - вкладка встаёт в работу сессии-агента в фоне: после последней браузерной вкладки, а если их нет — справа от вкладки
 *   сессии; выбранная вкладка не меняется; тост «S01 opened …» и «Show» делает вкладку выбранной (это клик человека);
 * - повтор той же страницы (без #фрагмента) новой вкладки не открывает; не loopback — `not_loopback`; одиннадцатая
 *   вкладка — отказ с советом, а повтор открытой страницы на пределе проходит;
 * - работа, которую окно после перезапуска ещё не показывало (её раскладку окно читает с диска по просьбе агента): вкладка
 *   добавлена без загрузки страницы, ответ агенту — с заметкой, активная работа не меняется, «Show» переключает на неё и
 *   страница грузится;
 * - «Let agents use the browser» выключен — `access_denied`, включён — снова работает;
 * - безопасность: чужой токен и запрос без токена — 401, в аргументах нельзя назвать ни работу, ни вкладку, после остановки
 *   сессии токен отозван, токен лежит только в конфиге MCP (0600), а не в окружении и argv процесса, журнал хоста
 *   называет origin и не называет путь, query и токен;
 * - правило приоритета (`BROWSER_PRIORITY_RULE`) есть в системной вставке сессии с каналом.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
/** Секрет в query адреса: в журнал хоста, в окружение и в argv процесса он попасть не должен. */
const QUERY_SECRET = 'e2e-query-secret-91';
const NOT_MOUNTED = "The workspace is not open in Parley's window";

interface Launch {
  argv: string[];
  env: Record<string, string>;
}
interface McpResult {
  session: string;
  tool: string;
  isError: boolean;
  text: string;
}
interface Opened {
  tab: string;
  url: string;
  reused: boolean;
  notes: string[];
}
type Reply = { ok: true; result: Opened } | { ok: false; error: { code: string; message: string } };
interface Channel {
  url: string;
  token: string;
  /** Файл конфигурации MCP сессии: в нём, и только в нём, лежит токен. */
  config: string;
  launch: Launch;
}

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

async function menu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, action) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:action', action);
  }, id);
}

async function guestUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((c) => c.getType() === 'webview')
      .map((c) => c.getURL()),
  );
}

async function readLines<T>(file: string): Promise<T[]> {
  return (await readFile(file, 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as T);
}

/** Вкладки полосы по порядку и выбранные: ровно то, что видит человек. */
async function strip(window: Page): Promise<{ ids: string[]; selected: string[] }> {
  return window.locator('[role="tab"][data-tab-id]').evaluateAll((tabs) => ({
    ids: tabs.map((tab) => tab.getAttribute('data-tab-id') ?? ''),
    selected: tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').map((tab) => tab.getAttribute('data-tab-id') ?? ''),
  }));
}

/** Адрес и токен канала сессии — из её конфига MCP (`--mcp-config` в argv заглушки); сессия — по номеру и каталогу работы. */
async function channelOf(argvLog: string, workId: string, sessionId: string): Promise<Channel> {
  let found: Launch | undefined;
  await expect
    .poll(
      async () => {
        found = (await readLines<Launch>(argvLog)).find(
          (item) => item.env['PARLEY_SESSION_ID'] === sessionId && (item.env['PARLEY_WORK_DIR'] ?? '').endsWith(`${path.sep}${workId}`),
        );
        return found !== undefined && found.argv.includes('--mcp-config');
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  const launch = found as Launch;
  const config = launch.argv[launch.argv.indexOf('--mcp-config') + 1] as string;
  const env = (JSON.parse(await readFile(config, 'utf8')) as { mcpServers: { parley: { env: Record<string, string> } } }).mcpServers.parley.env;
  return { url: env['PARLEY_AGENT_URL'] as string, token: env['PARLEY_AGENT_TOKEN'] as string, config, launch };
}

/** Операция агента прямо в эндпоинт хоста — как её шлёт MCP-сервер; токен можно подменить. */
async function agentOp(channel: Channel, args: Record<string, unknown>, token: string | null = channel.token): Promise<{ status: number; reply: Reply | null }> {
  const response = await fetch(channel.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ op: 'open', args }),
  });
  const reply = response.status === 200 ? ((await response.json()) as Reply) : null;
  return { status: response.status, reply };
}

const codeOf = (reply: Reply | null): string => (reply === null ? 'none' : reply.ok ? 'ok' : reply.error.code);

test.describe('канал агента: browser_open (этап B2)', () => {
  test.setTimeout(150_000);
  let home: string;
  let project: string;
  let logs: string;
  let server: Server;
  let origin: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('agent-open');
    project = await makeTempProject('agent-open');
    logs = await makeTempProject('agent-open-logs');
    // Правила проекта уже есть: без них первая сессия кладёт PARLEY.md и показывает тост «Parley added PARLEY.md … Open»,
    // а он делит угол окна с тостом «S01 opened …».
    await writeFile(path.join(project, 'PARLEY.md'), 'E2E project rules.\n');
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>Page ${pathname}</title><p>page ${pathname}</p>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await Promise.all([home, project, logs].map((dir) => rm(dir, { recursive: true, force: true })));
    // Соединения гостей с сервером закрыты насильно: убитое окно держит их, и `close` без этого ждал бы их хвост.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * Окно с заглушкой claude вместо агента; `mcp` — вызов инструмента настоящего `parley-mcp` от лица сессии работы.
   * `restart` — окно поднимается с домом, где уже есть работы: вместо пустого экрана оболочка с последней активной работой.
   */
  async function openApp(restart = false) {
    const argvLog = path.join(logs, 'argv.jsonl');
    const mcpLog = path.join(logs, 'mcp.jsonl');
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom', STUB_ARGV_LOG: argvLog, STUB_MCP_LOG: mcpLog };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId(restart ? 'app-shell' : 'landing')).toBeVisible();
    // Будильник печатал бы в терминал заглушки указатели на письма, склеиваясь со строками вызовов.
    await call(window, 'wake.pause', {});

    const newWork = async (title: string): Promise<string> => (await call<{ workId: string }>(window, 'works.create', { projectPath: project, title, goal: '' })).workId;
    const newSession = async (workId: string, label: string): Promise<string> =>
      (await call<{ ref: { sessionId: string } }>(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label, task: '', parent: null })).ref.sessionId;
    const row = (workId: string, sessionId: string) => window.locator(`[data-work-key="${project} ${workId}"] [data-session-id="${sessionId}"]`);

    /** Агент зовёт инструмент `parley-mcp`: строка `STUB_MCP` в его терминал, результат — из журнала заглушки. */
    const mcp = async (workId: string, sessionId: string, tool: string, args: unknown = {}): Promise<McpResult> => {
      const before = (await readLines<McpResult>(mcpLog)).length;
      await window.evaluate(
        ([ref, line]) => (globalThis as unknown as { parley: { notify: (method: string, params: unknown) => void } }).parley.notify('pty.input', { ref, data: line }),
        [{ projectPath: project, workId, sessionId }, `STUB_MCP ${tool} ${JSON.stringify(args)}\r`] as const,
      );
      await expect.poll(async () => (await readLines<McpResult>(mcpLog)).length, { timeout: 30_000 }).toBeGreaterThan(before);
      return (await readLines<McpResult>(mcpLog))[before] as McpResult;
    };
    /** «Show» тоста с этим текстом: тостов в углу окна бывает несколько, и у каждого своя кнопка. */
    const show = (text: string) => window.locator('[data-sonner-toast]', { hasText: text }).getByRole('button', { name: 'Show', exact: true });
    return { electronApp, window, argvLog, newWork, newSession, row, mcp, show };
  }

  test('вкладка в фоне рядом с сессией, тост «Show», повтор без дубля, не loopback; токен только в конфиге, правило приоритета в системной вставке', async () => {
    const { electronApp, window, argvLog, newWork, newSession, row, mcp, show } = await openApp();
    const workId = await newWork('e2e-agent-open');
    const agent = await newSession(workId, 'agent');
    const viewer = await newSession(workId, 'viewer');
    expect([agent, viewer]).toEqual(['s-01', 's-02']);
    const channel = await channelOf(argvLog, workId, agent);
    expect(channel.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/agent\/browser$/);
    expect(channel.token).toMatch(/^[0-9a-f]{64}$/);

    // Вкладки сессий: агент, потом вторая; выбрана вкладка агента.
    await row(workId, agent).click();
    await row(workId, viewer).click();
    await window.locator(`[role="tab"][data-tab-id="terminal:${agent}"]`).click();
    await expect.poll(() => strip(window)).toEqual({ ids: [`terminal:${agent}`, `terminal:${viewer}`], selected: [`terminal:${agent}`] });

    // Инструмент объявлен только при канале; описание зовёт предпочесть браузер Parley.
    const listed = JSON.parse((await mcp(workId, agent, 'tools/list')).text) as Array<{ name: string; description: string }>;
    const tool = listed.find((item) => item.name === 'browser_open');
    expect(tool?.description).toContain('Prefer this over Chrome, Chrome DevTools or Playwright');

    // 1. Первая вкладка — справа от вкладки сессии-агента; страница грузится в фоне; выбранная вкладка прежняя.
    const first = await mcp(workId, agent, 'browser_open', { url: `${origin}/` });
    expect(first.isError).toBe(false);
    expect(first.text).toContain(`Opened t1: ${origin}/ in Parley's browser`);
    await expect.poll(async () => (await strip(window)).ids.length).toBe(3);
    const afterFirst = await strip(window);
    expect(afterFirst.ids[0]).toBe(`terminal:${agent}`);
    expect(afterFirst.ids[1]).toMatch(/^browser:/);
    expect(afterFirst.ids[2]).toBe(`terminal:${viewer}`);
    expect(afterFirst.selected).toEqual([`terminal:${agent}`]);
    await expect.poll(() => guestUrls(electronApp)).toEqual([`${origin}/`]);
    const firstTab = afterFirst.ids[1] as string;

    // 2. Тост говорит человеку, откуда вкладка; «Show» делает её выбранной.
    await expect(window.locator('[data-sonner-toast]', { hasText: `S01 opened ${origin}/` })).toBeVisible();
    await show(`S01 opened ${origin}/`).click();
    await expect.poll(async () => (await strip(window)).selected).toEqual([firstTab]);
    await window.locator(`[role="tab"][data-tab-id="terminal:${agent}"]`).click();
    await expect.poll(async () => (await strip(window)).selected).toEqual([`terminal:${agent}`]);

    // 3. Вторая страница — после последней браузерной вкладки работы; query с секретом доходит до вкладки, но не до журнала хоста.
    const second = await mcp(workId, agent, 'browser_open', { url: `${origin}/other?token=${QUERY_SECRET}#frag` });
    expect(second.isError).toBe(false);
    expect(second.text).toContain('Opened t2:');
    await expect.poll(async () => (await strip(window)).ids.length).toBe(4);
    const afterSecond = await strip(window);
    expect(afterSecond.ids).toEqual([`terminal:${agent}`, firstTab, expect.stringMatching(/^browser:/) as unknown as string, `terminal:${viewer}`]);
    expect(afterSecond.selected).toEqual([`terminal:${agent}`]);

    // 4. Та же страница без учёта #фрагмента — вкладка t1, новой нет.
    const again = await mcp(workId, agent, 'browser_open', { url: `${origin}/#elsewhere` });
    expect(again.isError).toBe(false);
    expect(again.text).toContain('Tab t1 of your workspace already shows');
    expect(again.text).toContain('no new tab was opened');
    expect((await strip(window)).ids).toHaveLength(4);

    // 5. Не loopback — отказ без вкладки и без запроса к внешнему сайту.
    for (const url of ['https://example.com/', 'http://localhost.evil.test/', 'file:///etc/hosts']) {
      const refused = await mcp(workId, agent, 'browser_open', { url });
      expect(refused.isError, url).toBe(true);
      expect(refused.text, url).toMatch(/^not_loopback: /);
    }
    expect((await strip(window)).ids).toHaveLength(4);
    expect((await guestUrls(electronApp)).some((url) => url.includes('example.com') || url.includes('evil'))).toBe(false);

    // 6. Токен — только в конфиге MCP (0600): ни в окружении процесса агента, ни в его argv, ни в журнале хоста, ни в окне.
    expect((await stat(channel.config)).mode & 0o777).toBe(0o600);
    expect(channel.launch.env['PARLEY_AGENT_TOKEN']).toBeUndefined();
    expect(channel.launch.env['PARLEY_AGENT_URL']).toBeUndefined();
    expect(JSON.stringify(channel.launch)).not.toContain(channel.token);
    const hostLog = await readFile(path.join(home, 'host', 'host.log'), 'utf8').catch(() => '');
    expect(hostLog).not.toContain(channel.token);
    expect(await window.evaluate(() => document.body.innerText)).not.toContain(channel.token);

    // 7. Журнал хоста: на каждую операцию строка с origin, без пути, query и фрагмента.
    const agentLines = hostLog.split('\n').filter((line) => line.includes('операция агента в браузере'));
    expect(agentLines.length).toBeGreaterThanOrEqual(5);
    expect(agentLines.some((line) => line.includes(origin))).toBe(true);
    for (const line of agentLines) {
      expect(line).not.toContain(QUERY_SECRET);
      expect(line).not.toContain('/other');
      expect(line).not.toContain('#');
    }

    // 8. Системная вставка запуска с каналом несёт правило приоритета.
    expect(channel.launch.argv.join('\n')).toContain(BROWSER_PRIORITY_RULE);
  });

  test('работа, которую окно после перезапуска не показывало: раскладка читается с диска, вкладка без загрузки страницы, заметка агенту, активная работа та же; «Show» переключает и страница грузится', async () => {
    const first = await openApp();
    const hidden = await first.newWork('hidden-work');
    const agent = await first.newSession(hidden, 'agent');
    const visible = await first.newWork('visible-work');
    const viewer = await first.newSession(visible, 'viewer');
    await channelOf(first.argvLog, hidden, agent);
    // Человек открыл вкладку агента, а потом ушёл в другую работу; обе раскладки и активная работа — на диске.
    await first.row(hidden, agent).click();
    await expect(first.window.locator(`[role="tab"][data-tab-id="terminal:${agent}"]`)).toBeVisible();
    await first.row(visible, viewer).click();
    const layoutsFile = path.join(home, 'desktop', 'layouts.json');
    const uiFile = path.join(home, 'desktop', 'ui.json');
    await expect
      .poll(
        async () => {
          try {
            const layouts = JSON.parse(await readFile(layoutsFile, 'utf8')) as { works: Record<string, unknown> };
            const ui = JSON.parse(await readFile(uiFile, 'utf8')) as { activeWorkKey: string | null };
            return { saved: Object.keys(layouts.works).sort(), active: ui.activeWorkKey };
          } catch {
            return null;
          }
        },
        { timeout: 10_000 },
      )
      .toEqual({ saved: [`${project} ${hidden}`, `${project} ${visible}`].sort(), active: `${project} ${visible}` });
    await quitApp(first.electronApp);
    app = null;

    // Новое окно с тем же домом: хост и агенты живы, окно показывает последнюю активную работу, первую не читало.
    const { electronApp, window, mcp, show } = await openApp(true);
    await expect.poll(() => strip(window)).toEqual({ ids: [`terminal:${viewer}`], selected: [`terminal:${viewer}`] });

    const opened = await mcp(hidden, agent, 'browser_open', { url: `${origin}/` });
    expect(opened.isError).toBe(false);
    expect(opened.text).toContain(`Opened t1: ${origin}/`);
    expect(opened.text).toContain(`Note: ${NOT_MOUNTED}`);
    // Активная работа и её вкладки прежние; страница не грузилась.
    await expect(window.locator('[data-sonner-toast]', { hasText: `S01 opened ${origin}/` })).toBeVisible();
    expect(await strip(window)).toEqual({ ids: [`terminal:${viewer}`], selected: [`terminal:${viewer}`] });
    expect(await guestUrls(electronApp)).toEqual([]);

    // «Show» — клик человека: работа агента становится активной, вкладка — выбранной (после вкладки сессии), страница грузится.
    await show(`S01 opened ${origin}/`).click();
    await expect.poll(async () => (await strip(window)).ids.length).toBe(2);
    const shown = await strip(window);
    expect(shown.ids[0]).toBe(`terminal:${agent}`);
    expect(shown.ids[1]).toMatch(/^browser:/);
    expect(shown.selected).toEqual([shown.ids[1]]);
    await expect.poll(() => guestUrls(electronApp)).toEqual([`${origin}/`]);
  });

  test('предел десять вкладок: одиннадцатая — отказ с советом, повтор открытой страницы на пределе проходит', async () => {
    const { window, argvLog, newWork, newSession, row, mcp } = await openApp();
    const workId = await newWork('e2e-agent-limit');
    const agent = await newSession(workId, 'agent');
    await channelOf(argvLog, workId, agent);
    await row(workId, agent).click();

    for (let n = 1; n <= 10; n += 1) {
      const result = await mcp(workId, agent, 'browser_open', { url: `${origin}/p${n}` });
      expect(result.isError, `p${n}: ${result.text}`).toBe(false);
      await expect(window.locator('[role="tab"][data-tab-id^="browser:"]')).toHaveCount(n);
    }
    const eleventh = await mcp(workId, agent, 'browser_open', { url: `${origin}/p11` });
    expect(eleventh.isError).toBe(true);
    expect(eleventh.text).toMatch(/^bad_request: /);
    expect(eleventh.text).toContain('10 browser tabs');
    await expect(window.locator('[role="tab"][data-tab-id^="browser:"]')).toHaveCount(10);

    const reopened = await mcp(workId, agent, 'browser_open', { url: `${origin}/p3` });
    expect(reopened.isError).toBe(false);
    expect(reopened.text).toContain('Tab t3 of your workspace already shows');
    await expect(window.locator('[role="tab"][data-tab-id^="browser:"]')).toHaveCount(10);
  });

  test('«Let agents use the browser»: выключен — access_denied и вкладки нет, включён — снова работает', async () => {
    const { electronApp, window, argvLog, newWork, newSession, row, mcp } = await openApp();
    const workId = await newWork('e2e-agent-switch');
    const agent = await newSession(workId, 'agent');
    const channel = await channelOf(argvLog, workId, agent);
    await row(workId, agent).click();

    await menu(electronApp, 'settings.open');
    await window.getByRole('tab', { name: 'Browser' }).click();
    const toggle = window.getByRole('switch', { name: 'Let agents use the browser' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await window.keyboard.press('Escape');

    await expect.poll(async () => codeOf((await agentOp(channel, { url: `${origin}/` })).reply)).toBe('access_denied');
    const denied = await mcp(workId, agent, 'browser_open', { url: `${origin}/` });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/^access_denied: /);
    expect(denied.text).toContain('Do not retry');
    await expect(window.locator('[role="tab"][data-tab-id^="browser:"]')).toHaveCount(0);

    await menu(electronApp, 'settings.open');
    await window.getByRole('tab', { name: 'Browser' }).click();
    await window.getByRole('switch', { name: 'Let agents use the browser' }).click();
    await expect(window.getByRole('switch', { name: 'Let agents use the browser' })).toHaveAttribute('aria-checked', 'true');
    await window.keyboard.press('Escape');
    await expect.poll(async () => (await mcp(workId, agent, 'browser_open', { url: `${origin}/` })).isError).toBe(false);
    await expect(window.locator('[role="tab"][data-tab-id^="browser:"]')).toHaveCount(1);
  });

  test('эндпоинт: чужой токен и запрос без токена — 401, работу и вкладку в аргументах назвать нельзя, после остановки сессии токен отозван', async () => {
    const { window, argvLog, newWork, newSession, row } = await openApp();
    const workId = await newWork('e2e-agent-token');
    const agent = await newSession(workId, 'agent');
    const channel = await channelOf(argvLog, workId, agent);
    await row(workId, agent).click();

    expect((await agentOp(channel, { url: `${origin}/` }, 'f'.repeat(64))).status).toBe(401);
    expect((await agentOp(channel, { url: `${origin}/` }, null)).status).toBe(401);
    expect((await agentOp(channel, { url: `${origin}/` }, '')).status).toBe(401);
    // Вкладок нет: отказы дошли до хоста, а не до окна.
    await expect(window.locator('[role="tab"][data-tab-id^="browser:"]')).toHaveCount(0);

    // Работу назвать нельзя: хост берёт её по токену, лишние поля — bad_request, окну ничего.
    for (const extra of [{ workKey: 'other', url: `${origin}/` }, { tab: 't1', url: `${origin}/` }, { url: `${origin}/`, projectPath: '/etc' }]) {
      const refused = await agentOp(channel, extra);
      expect(refused.status).toBe(200);
      expect(codeOf(refused.reply)).toBe('bad_request');
    }
    await expect(window.locator('[role="tab"][data-tab-id^="browser:"]')).toHaveCount(0);

    // Свой токен работает; остановили сессию — тот же токен больше не принимается.
    const own = await agentOp(channel, { url: `${origin}/` });
    expect(own.status).toBe(200);
    expect(codeOf(own.reply)).toBe('ok');
    await call(window, 'sessions.stop', { ref: { projectPath: project, workId, sessionId: agent } });
    await expect.poll(async () => (await agentOp(channel, { url: `${origin}/` })).status).toBe(401);
  });
});
```

- [ ] **Шаг 2. Запустить E2E.** `pnpm build && pnpm --filter @parley/desktop exec playwright test e2e/browser-agent-open.spec.ts` → PASS, 5 тестов (около минуты на спокойной машине).

  Если тест не находит канал (`channelOf` ждёт до 20 с): проверить, что хост собран из этой ветки (`packages/host/dist`) и что `--mcp-config` есть в argv (`STUB_ARGV_LOG`). Если вторая операция после первой вкладки даёт `window_not_connected`: готовность окна в `main/index.ts` проверяется по `loadedWindows`, а не по `isLoadingMainFrame()` (задача 10). Если перед тестом 2 нет оболочки (`app-shell`): окно с тем же домом не подняло работы — проверить, что `quitApp` дождался сохранения раскладок (`layouts.json`, `ui.json` в доме теста).

  Прогнать файл ещё дважды подряд: тесты не должны зависеть от порядка и от остатков прежнего прогона. Под нагрузкой машины (`uptime`) допустим повтор один раз; стабильно красный тест — дефект, не флейк.

- [ ] **Шаг 3. Закоммитить.**

```bash
git add packages/desktop/e2e/browser-agent-open.spec.ts
git commit -m "test(desktop): E2E browser_open — вкладка в фоне, перезапуск окна, предел, выключатель, токен" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Задача 13. Документы: CHANGELOG, README, спека окна

**Файлы:**
- Изменить: `CHANGELOG.md`, `README.md`, `docs/specs/2026-09-26-desktop-orca-ui-design.md`

**Интерфейсы:**
- Спека браузера (`2026-10-07-browser-devtools-agent-design.md`), индекс плана и записки планов C и D уже правлены вместе с этим планом; здесь — документы продукта.
- README: правило «агент браузером не управляет» (раздел о рамке) уточняется, раздел о браузере получает абзац об открытии страниц агентом, раздел Settings → Browser — выключатель.
- Спека окна: 12.2 (правило агента), 12.5 (мост), 15.1 п. 9, 15.2 (канал агента). Остальные пункты раздела 11 спеки браузера (12.1, 12.3, 12.4) принадлежат этапам A и B; чтение и управление (12.2, 15.1 п. 9) дополнят C и D.

- [ ] **Шаг 1. CHANGELOG, README и спека окна.** Правки применяются как в задачах выше — по якорю. Тексты английские в CHANGELOG и README, русские в спеке окна.

  `CHANGELOG.md`:

  После строк:

```md
  without Enter. A toast offers "Open" and "Undo". Nothing is sent by itself.
```

  вставить:

```md
- **Agents open pages in Parley's browser.** An agent (Claude, GLM or Codex) can call `browser_open` with a
  URL on localhost: the page opens in a new tab of the agent's own workspace, after the workspace's last
  browser tab (or next to the agent's tab), in the background — your active tab, group and workspace stay
  as they are. A toast says "S02 opened …" and offers "Show". The same page (ignoring the `#fragment`) is
  not opened twice, and the limit of 10 browser tabs per workspace holds for agents too. Agents are asked to
  prefer this over Chrome, Chrome DevTools and Playwright for localhost pages. Only `http(s)` on
  `localhost`, `*.localhost`, `127.0.0.0/8` and `[::1]`; an agent cannot read, click or script the page yet.
  Settings → Browser → "Let agents use the browser" turns it off: every request is then refused. Each
  session gets its own token for this channel; it lives only in the session's MCP config.
```

  `README.md`:

  Заменить:

```md
- the agent does not control the embedded browser; Select and Annotate work only on a human's click;
```

  на:

```md
- the agent does not control the embedded browser: it can only open a page on `localhost` in a tab of its
  own workspace (`browser_open`) — in the background, without taking your focus, and Settings → Browser can
  turn that off; Select and Annotate work only on a human's click;
```

  Заменить:

```md
  input without Enter. A toast says what was added, with "Open" and "Undo". Nothing is sent
  until you send it.
```

  на:

```md
  input without Enter. A toast says what was added, with "Open" and "Undo". Nothing is sent
  until you send it;
- an agent opens pages for you: with `browser_open`, an agent (Claude, GLM or Codex) shows a page on
  `localhost` in a new tab of its own workspace — after the workspace's last browser tab, or next to the
  agent's own tab. The tab opens in the background: your active tab, group and workspace do not change,
  and a toast "S02 opened …" offers "Show". The same page (ignoring the `#fragment`) is not opened
  twice, and the limit of 10 browser tabs per workspace holds for the agent too. Only `http(s)` on
  `localhost`, `*.localhost`, `127.0.0.0/8` and `[::1]` is opened; the agent cannot read, click or script
  the page. Agents are asked to prefer this over Chrome, Chrome DevTools and Playwright for localhost
  pages. Settings → Browser → "Let agents use the browser" turns it off: every request is then refused.
  Each session gets its own token for this channel; it lives only in the session's MCP config.
```

  Заменить:

```md
- **Browser** — "Clear browser data": the cookies, storage and cache of the embedded browser.
```

  на:

```md
- **Browser** — "Clear browser data": the cookies, storage and cache of the embedded browser; "Let agents
  use the browser": on by default, off refuses every browser request from an agent.
```

  `docs/specs/2026-09-26-desktop-orca-ui-design.md`:

  Заменить:

```md
- **Агент браузером не управляет.** Программный доступ к странице есть только у main: по действию человека — Select и
  Annotate, DevTools и размер вьюпорта; инспектор CDP читает консоль и сеть, а по выбору человека — роль, имя и
  компонент React элемента (`Runtime.callFunctionOn` — только с `REACT_INFO_FN`) и снимки.
```

  на:

```md
- **Агент браузером не управляет, он только открывает страницы.** Программный доступ к странице есть только у main: по
  действию человека — Select и Annotate, DevTools и размер вьюпорта; инспектор CDP читает консоль и сеть, а по выбору
  человека — роль, имя и компонент React элемента (`Runtime.callFunctionOn` — только с `REACT_INFO_FN`) и снимки. Агент
  (спека `2026-10-07-browser-devtools-agent-design.md`, 5.1–5.2, этап B2) может одно: `browser_open` — поставить вкладку с
  адресом на loopback в раскладку своей работы, в фоне и без фокуса (активная вкладка, группа и работа человека не
  меняются). Страницу он не читает и не трогает; main для этого не пользуется ни гостем, ни CDP. Общий выключатель —
  Settings → Browser → «Let agents use the browser».
```

  После строк:

```md
  annotateCapture(webContentsId: number): Promise<{ path: string | null }>;  // снимок с номерами; меток нет — null
```

  вставить:

```md
  // Агент открывает вкладку (спека 2026-10-07-browser-devtools-agent-design.md, 3.7, 5.1; этап B2): main просит, окно ставит и отвечает
  onAgentOpenTab(listener: (e: AgentOpenTab) => void): () => void;
  agentOpenTabResult(requestId: string, result: AgentOpenTabResult): Promise<void>;
```

  После строк:

```md
  браузера). Каналы этапа B — `browser:save-context`, `browser:annotate-start`, `browser:annotate-cancel`,
  `browser:annotate-sync`, `browser:annotate-capture`.
```

  вставить:

```md
- Типы `AgentOpenTab` и `AgentOpenTabResult` — `shared/browser-types.ts` (этап B2 браузера). Каналы — событие
  `browser:agent-open-tab` и `browser:agent-open-tab-result`. Просьба main окну: `{ requestId, workKey, url, sessionId,
  session }` (адрес main уже проверил, работу назвал хост по токену сессии). Ответ окна — `{ tabId, reused, mounted }`
  или `{ error: 'limit' | 'no_work' }`; `mounted: false` — работа вне LRU окна, вкладка в раскладке есть, гостя пока нет.
```

  Заменить:

```md
9. Агент браузером не управляет. Select и Annotate — только по клику человека.
```

  на:

```md
9. Агент браузером не управляет: он может только открыть страницу на loopback (`browser_open`) во вкладке своей
   работы — в фоне и без фокуса. Select и Annotate — только по клику человека. Доступ агента выключается в Settings →
   Browser («Let agents use the browser»).
```

  После строк:

```md
  `browser:open-tab` и `browser:focus` окну — только адрес и id гостя.
```

  вставить:

```md
- **Канал агента к браузеру** (этап B2). У хоста — `POST /agent/browser` на том же сервере 127.0.0.1, что принимает хуки,
  с токеном сессии: 32 случайных байта в hex, на каждый запуск новый; лежит только в конфиге MCP-сервера (файл с правами
  0600 или `-c mcp_servers.parley`), не в окружении процесса и не в журнале хоста. Операцию получает одно окно с
  возможностью `browser-agent` (`hello.features`); ответ — метод `browser.agentResult`, который зовёт только main
  (`host:call` окна его не пускает, `forwardHostToWindow` не пересылает `browser.agentOp`). Окну уходит только адрес, номер
  сессии и ключ работы; адрес main проверяет по `isLoopbackUrl` и без учётных данных.
```

- [ ] **Шаг 2. Проверить.** `git diff --stat` — затронуты ровно три файла: README меняется в трёх местах (правило рамки, раздел о браузере, Settings → Browser), CHANGELOG — одной записью в `Unreleased → Added`, спека окна — в 12.2, 12.5, 15.1 п. 9 и 15.2. Тестов у задачи нет.

- [ ] **Шаг 3. Закоммитить.**

```bash
git add CHANGELOG.md README.md docs/specs/2026-09-26-desktop-orca-ui-design.md
git commit -m "docs: browser_open — CHANGELOG, README и спека окна" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Задача 14. Завершение этапа

**Файлы:** только проверки и PR.

- [ ] **Шаг 1. Полный прогон.** `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm --filter @parley/desktop e2e`. Числа — против исходного прогона (задача 1, шаг 4). Новое красное — дефект этапа; исходное красное и флейки под нагрузкой (`works-service`, `context-pages`, `activity-service`, `wake-service`, FSEvents, капризы tui-тестов) — в отчёт, а упавший файл перезапускается отдельно.

- [ ] **Шаг 2. Рамка.** `pnpm --filter @parley/core exec vitest run test/frame-check.test.ts` → PASS (закреплённая строка `mcp-config.ts:191`, задача 4), `grep -rn "HARNAS_AGENT" packages/*/src` → пусто, `git status` — в `~/.claude`, `~/.codex`, `~/.cursor` ничего не писалось (этап их не трогает).

- [ ] **Шаг 3. Визуальная проверка в dev-окне.** Окно из исходников с чистым домом: `PARLEY_HOME="$(mktemp -d)" pnpm --filter @parley/desktop dev`. Собранное приложение локально не запускать. Агент — заглушка `e2e/stub-echo-agent.mjs` (`PARLEY_CLAUDE_BIN`) и строка `STUB_MCP browser_open {"url":"…"}` в её терминал. Проверить при 800×500 и DPR 1 и 2 (`--force-device-scale-factor=2`), с названием работы и ярлыком сессии по 60 символов и адресом страницы из 300 символов:
  - тост «S01 opened …» режет адрес многоточием, «Show» виден и нажимается, тост не закрывает кнопки панели;
  - вкладка агента встала справа от вкладки сессии и не стала выбранной; строка вкладок не вылезает за край;
  - Settings → Browser: «Let agents use the browser», переключатель и подсказка в границах диалога, кнопка «Done» на месте.
  Снимки экрана — в отчёт этапа (в репозиторий не коммитятся).

- [ ] **Шаг 4. Живая проверка с настоящими агентами — только с согласия человека.** Запуск `claude` и `codex` тратит недельный лимит подписки: перед каждым спросить и ждать явного «да». Если согласие есть: сессия Claude и сессия Codex в работе с dev-сервером на localhost просят «открой страницу в браузере». Ожидание: инструмент `browser_open` в списке инструментов (`/mcp`), агент выбирает его, а не Chrome или Playwright, вкладка встаёт в фоне. Записать в отчёт, спрашивал ли Claude Code разрешение на первый вызов MCP-инструмента (это поведение самого CLI), и не спрашивал ли Codex (аннотации инструмента). Нет согласия — отметить в отчёте «живая проверка не проводилась».

- [ ] **Шаг 5. Ревью.** Ветка уходит на ревью свежему ревьюеру (навык superpowers:requesting-code-review). Рецензенту дать «Фокус ревью» этого плана и «Расхождения с планами C и D»; правки — отдельными коммитами.

- [ ] **Шаг 6. Push и PR.** Ветку запушить. PR открывается во встроенном браузере (`gh` не установлен); вливает человек. Описание PR: что сделано по задачам, числа прогона против исходного, расхождения с планом, итог шагов 3 и 4. Описание кончается строкой `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Расхождения с планами C и D

Планы C и D писались до B2. B2 взял из них канал и операцию `open` и поставил их раньше, поэтому с их текстом есть расхождения. В начале планов C и D стоит записка, какие задачи B2 уже закрыл; полная переписка этих планов — позже.

**Что B2 закрывает вместо C и D**

| План | Задача | Что с ней |
|---|---|---|
| C | 2 (loopback) | закрыта целиком — задача 8 B2 |
| C | 5 (приёмник хоста), 6 (адрес и токен в конфиге MCP), 7 (проводка хоста) | закрыты целиком — задачи 3, 4, 5 B2 |
| C | 16 (настройка «Let agents use the browser») | закрыта целиком — задача 9 B2 |
| C | 4 (протокол), 8 (инструменты MCP), 10 (`agent-ops.ts`), 13 (мост и проводка main) | частично: файлы, проводка и мост созданы под одну операцию `open`; C дописывает свои операции и реестр вкладок |
| C | 17 (E2E), 18 (документы) | частично: у B2 свой E2E и свои строки документов; C дописывает |
| D | 2 (протокол), 3 (инструменты MCP), 14 (main `open`), 15 (мост: `onAgentOpenTab`, `agentOpenTabResult`), 16 (окно: вкладка агента), 20 (E2E), 22 (документы) | части про `open` сделаны B2 в иной форме (см. ниже); D дописывает остальное |

**Расхождения по пунктам**

1. **`BROWSER_AGENT_OPS` = `['open']`.** Индекс перечисляет все десять операций. B2 даёт одну; C ставит свои четыре перед `open`, D дописывает остальные пять после. Схема `browserAgentArgs` объявлена как `satisfies Record<BrowserAgentOp, z.ZodType>`: операцию без схемы нельзя добавить.
2. **`BROWSER_AGENT_ERROR_CODES` — шесть кодов.** `not_loopback`, `access_denied`, `window_not_connected`, `timeout`, `unsupported`, `bad_request`. Остальные коды спеки 5.1 (`no_tab`, `tab_hidden`, `tab_not_loaded`, `navigation_blocked`, `human_busy`, `stale_ref`) добавляют C и D вместе со своими операциями. Предел вкладок отдельного кода в спеке не имеет — это `bad_request` с текстом (так и в D).
3. **`AGENT_LIMITS = { opMs, openMs, requestBytes }`.** `openMs: 10_000` — новый ключ, которого нет в индексе: сколько main ждёт, пока окно поставит вкладку и ответит. Вкладка встаёт за кадр; дольше — окно перезагружается или не слушает. В D `open` ждал ещё и загрузку (`loadMs`) и регистрацию гостя; `open` B2 возвращается, как только окно поставило вкладку. `AGENT_INPUT = { url: 4096 }` — предел длины адреса в аргументах; у C этот объект уже есть с другими ключами (`pattern`, `requestId`), он дописывает их к `url`.
4. **`BrowserAgentOpenResult = { tab, url, reused, notes }`** вместо `{ tab, url, title, loaded, visible, notes }` из D. Страницу B2 не читает: нет ни заголовка, ни состояния загрузки. `url` — адрес, который прислал агент (без учётных данных), а не адрес страницы после редиректов (его читает `contents.getURL()`, у B2 гостя в main нет). Новое поле `reused`.
5. **`AgentOpenTabResult = { tabId, reused, mounted } | { error: 'limit' | 'no_work' }`** вместо `{ tabId, mounted } | { error }` из индекса и D: добавлено `reused`.
6. **Ошибки окна.** `limit` → `bad_request` (как в D). `no_work` → `window_not_connected`, а не `tab_not_loaded` из D: такого кода у B2 нет, а смысл — окно ещё не знает работу, повторить через миг. Работа не смонтирована (вне LRU окна) — не ошибка: вкладка уже в раскладке, агенту нечего повторять, ответ `ok` с заметкой `NOT_MOUNTED_NOTE`. В D это был `tab_not_loaded`.
7. **Гидрация раскладки.** В D окно отвечало `no_work`, если раскладки работы нет в сторе. Раскладки грузятся лениво, при первом показе работы, и такой отказ получала бы любая работа, не открытая за этот запуск. B2: `answerAgentOpen` перед решением читает раскладку (`ensureHydrated`); сбой чтения не мешает ответить. Проверено на E2E после перезапуска окна.
8. **Повтор той же страницы.** В C и D его нет: у агента без `browser_navigate` повторные `browser_open` копили бы вкладки до предела. B2 ищет вкладку работы с той же страницей (`pageKey`: адрес без `#фрагмента`) и отдаёт её id с `reused: true`; проверка идёт **до** предела, поэтому на десяти вкладках открытая страница по-прежнему отдаётся. Границы: SPA-маршрут в `#фрагменте` одной вкладкой не различается; редирект сервера на другой путь повтор не распознаёт (вкладка получит другой адрес, чем запросил агент).
9. **Место вкладки.** Как в D (за последней браузерной вкладкой работы в визуальном порядке групп, иначе справа от вкладки сессии-агента); добавлено «нет и её — активная группа».
10. **Тост получил действие «Show».** В спеке тост только сообщает. Перейти к вкладке, не отнимая фокус сам, можно только по клику человека — «Show» (`S.browser.agent.show`) делает работу активной и вкладку выбранной (`showAgentTab`).
11. **Где живёт логика окна.** D описывал `openAgentTab` внутри `BrowserSurface.tsx`/`AppShell.tsx`. B2 вынес её в `renderer/browser/agent-open.ts` (чистые функции над зависимостями, тесты без React) и оставил в `AppShell` только подписку.
12. **Короткие id вкладок (`t1`, `t2`…).** У C их выдаёт реестр вкладок main (`agentIdFor`). У B2 реестра нет, поэтому `createAgentOps` держит свою карту «работа + id вкладки раскладки → id агента» (свой счёт на работу, id держится, пока жив main). Когда C принесёт реестр, его `agentIdFor` заменяет карту B2 с той же нумерацией.
13. **Аннотации инструмента.** `CONTROL = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }` — из задачи 3 плана D; в B2 она нужна `browser_open`. Читающие инструменты C останутся с `READ`. По аннотациям Codex решает, спрашивать ли человека.
14. **`fence`, `redact`, `PAGE_DATA_NOTE`** B2 не нужны: страницу он не читает. Core `fence` и пометку «page data» получает вместе с C.
15. **Готовность окна для просьбы агента.** C и D о ней не говорят (в D `openTab` проверял только `mainWindow !== null && !isDestroyed()`). B2 добавил проверку `!webContents.isLoadingMainFrame()`: просьба, посланная в загружающееся окно, терялась бы. `loadedWindows` из `main/index.ts` для этого не годится (E2E: первый `<webview>` снимает признак навсегда) и остаётся как есть.
16. **Правило приоритета** (`BROWSER_PRIORITY_RULE`, блок `browser` слоя сессии) в C и D отсутствует: D предполагал, что агента направит скилл `parley-browser`. Скилл остаётся в D; правило нужно раньше, пока скилла нет, и смягчено оговоркой «(so far: reading or clicking the page, …)». C и D переписывают его, когда у браузера Parley появляются чтение и управление.
17. **`answerBrowserAgentOps`** (`host-connection.ts`) — как в C, но подписка ставится в `main/index.ts` до первого подключения к хосту, пока окно поднимается (`agentOps === null` → `window_not_connected` «still starting»).
18. **`browser.agentResult` в `REQUIRED_METHODS` не добавлен.** Добавление заставило бы окно требовать «Restart host…» и убило бы живые сессии у человека с хостом старой сборки. Окно со старым хостом просто не получит операций; переключатель в Settings виден всегда.
19. **Журнал хоста.** В C `tab` берётся из аргументов, а origin — из `url` результата операции. У `open` вкладки в аргументах нет, поэтому B2 берёт `tab` из результата, а origin — из адреса аргументов (иначе отказы `not_loopback` и `access_denied`, у которых результата нет, остались бы без origin), а когда адреса там нет — из результата. Путь, query и фрагмент в журнал не идут: они у dev-сервера могут нести токены.
20. **E2E.** Файл `browser-agent-open.spec.ts` (у C — `browser-agent-read.spec.ts`, у D — `browser-agent-control.spec.ts`). Пять тестов вместо одного большого: у каждого свой дом и приложение.
21. **Трейлер коммитов.** В планах C и D стоит `Claude Opus 5.5`; в B2 — `Claude Sonnet 5.5`, как в последних коммитах ветки.

## Допущения и риски

- **Разрешение на первый вызов.** Claude Code спрашивает человека перед первым вызовом MCP-инструмента — это поведение самого CLI; Parley не пишет в `~/.claude` и обойти его не может. Codex по аннотациям не спрашивает.
- **Токен Codex в argv.** Конфиг сервера Codex идёт значением `-c mcp_servers.parley=…`, и токен виден в списке процессов (`ps`) тому же пользователю машины. Эндпоинт слушает только `127.0.0.1`, токен на запуск новый и отзывается с процессом; остальное окружение сервера Codex лежит там же.
- **Событие, посланное в окно, которое перезагружается.** Операция доходит до окна, а рендерер ещё не подписался: main дождётся `AGENT_LIMITS.openMs` (10 с) и ответит `timeout`. Окно до `did-finish-load` главного кадра просьб не получает вовсе (`window_not_connected`).
- **Правило приоритета — подсказка, не запрет.** Модель может выбрать Chrome DevTools; живая проверка (задача 14, шаг 4) показывает, насколько правило работает. Проверки поведения моделей автоматически нет.
- **Повтор страницы.** SPA-маршрут в `#фрагменте` и редирект сервера на другой путь повтор не распознают (пункт 8).
- **E2E проверены на macOS.** Linux и Windows в проекте не собираются.
