# Браузер Parley, этап A: DevTools для человека — план

> **Для исполнителей-агентов:** обязательный навык — superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans. Задачи выполняются по одной. Шаги отмечены флажками (`- [ ]`).

**Цель:**
- консоль и сеть страницы видны прямо во вкладке браузера Parley: панель Console | Network снизу вкладки, красный и жёлтый счётчики на кнопке строки, тело ответа 500 читается в деталях запроса;
- вкладку можно смотреть в размерах телефона, планшета и ноутбука; размер хранится у вкладки и переживает перезапуск;
- агенту в этом этапе ничего не уходит: «Add to chat» — только пустые слоты для этапа B.

**Устройство:**
- main подключает `webContents.debugger` к каждому гостю-браузеру (`main/browser/inspector.ts`). Подключает страж `guard.ts` на `web-contents-created` гостя. Инспектор ведёт кольца консоли и сети по вкладке и эпохи документов главного фрейма. Окну-хозяину гостя он шлёт пачки событием `browser:devtools`, как `browser:favicon`;
- гость стартует с `about:blank` (спайк 0.1, вариант D): отладчик подключается к пустому гостю, `Inspector.ready` отвечает, когда домены включены, окно зовёт `devtoolsReady` и только потом открывает адрес вкладки. Так журнал видит документ и подресурсы первой загрузки;
- эмуляция размера (`main/browser/emulation.ts`) — `Emulation.setDeviceMetricsOverride` со `scale`, касания и мобильный UA. Команды идут через тот же инспектор и его закрытый список `CDP_ALLOWED`;
- окно держит копию журнала по вкладке (`renderer/browser/devtools/store.ts`): снимок `devtoolsSnapshot` на `dom-ready`, дальше пачки своего гостя. Окно рисует панель, меню размеров и новую строку вкладки. При эмуляции оно ставит тот же узел `<webview>` по центру нейтрального поля размером ширина×scale на высота×scale.

**Стек:** Electron 44.4.5 (CDP 1.3 через `webContents.debugger`), React 18, zustand 5, `@tanstack/react-virtual` 3, Radix (`renderer/ui/dropdown-menu.tsx`, `popover.tsx`, `tabs.tsx`), `lucide-react` 1.48, `sonner`, Tailwind 4 (контейнерные запросы `@container`); vitest + Testing Library + jsdom; Playwright `_electron`.

**Спека:** `docs/specs/2026-10-07-browser-devtools-agent-design.md` — разделы 3.3, 3.4, 3.5 (строки этапа A), 4.1–4.4, 4.9 (клавиши A), 8, 9, 10.

**Индекс:** `docs/specs/2026-10-07-browser-devtools-agent-plan.md`. Имена его раздела «Общие имена» с пометкой (A) обязательны. Исполнитель читает спеку, индекс и этот файл.

**Где работать:** worktree `.claude/worktrees/browser-devtools`, ветка `feat/browser-devtools` от свежего `origin/master` после слияния этапа 0. Команды — индекс, «Как начать этап»:

```bash
cd /Users/kalmbik61/Desktop/MY/my_harnas
git fetch origin
git worktree add -b feat/browser-devtools .claude/worktrees/browser-devtools origin/master
cd .claude/worktrees/browser-devtools
pnpm install
pnpm build            # без сборки @parley/core тесты protocol и окна не находят пакет
pnpm test             # исходный прогон: числа по пакетам — в абзац «Сверка с этапом 0» ниже
pnpm typecheck && pnpm lint
pnpm --filter @parley/desktop e2e   # после pnpm build; исходные красные, если есть, — туда же
```

**Сверка с этапом 0 (задача 1, 2026-10-08):** отчёт `docs/research/2026-10-08-browser-stage0.md`, раздел «Что сделать в планах A–D» → «План A».
- **0.1 — вариант D** (решение человека 2026-10-08).
  - По критерию плана прошли A, B и C (по 10 из 10), но A и B теряют подресурсы первой загрузки — стили, картинки и скрипты из HTML (0 из 10), у C — 9 из 10, у D — 10 из 10.
  - `<webview>` стартует с `about:blank`, main подключает отладчик и ждёт `enable`, окно после `devtoolsReady` открывает адрес вкладки.
  - Правки: задачи 4, 5, 7, 16, 17, 18, 19 и «Расхождения с индексом», п. 10–11.
- **0.3 — `cdp` прошёл всё** (5 из 5), умолчание стоит.
  - Касания включаются только с новым документом: окно предлагает «Reload to apply touch», `reload()` само не делает. Эмуляция переживает `reload`, переход на другой origin и `goBack`: повтор команд не нужен.
  - Правок кода нет. Размер картинки со страницы при эмуляции — размер вида × DPR (Mobile M 2x — 750×1624): пометка в задачах 6 и 18.
- **Исходный прогон** (73bdc7e, 2026-10-08): сборка зелёная; тесты — file-icons 18, core 2870, protocol 218, host 1273, desktop 5188 (и 3 пропущенных). E2E исходно не снимались: задача 17 прогоняет соседние спеки браузера, задача 19 — весь набор.

## Глобальные ограничения

- Действуют все «Глобальные ограничения» индекса. Ниже — то, что касается этапа A.
- **Агенту ничего не уходит.** MCP, хост и протокол этап не трогает.
  - «Add to chat» и «Add errors to chat» — необязательные пропсы-слоты (`onAddToChat`, `onAddConsoleToChat`, `onAddRequestToChat`, `onAddErrorsToChat`). Без пропса кнопки нет. Колбэки передаст этап B.
- **CDP — только `Inspector.send` и внутренние команды инспектора.** Оба пути проверяют `CDP_ALLOWED`.
  - Список этапа A: `enable` и `disable` доменов `Runtime`, `Log`, `Page`, `Network`; `Network.getResponseBody`; четыре команды `Emulation.*`.
  - Нет `Runtime.evaluate` и нет `Runtime.callFunctionOn`.
  - Переходы — методами `<webview>` и `webContents`, как сейчас.
- **Панель показывает заголовки и тела как есть.** Маска (`shared/redact.ts`) — этап B и только для «Add to chat» и агента.
- **Числа.**
  - Пределы раздела 8 — только `DEVTOOLS_LIMITS` (`shared/browser-devtools.ts`).
  - Числа интерфейса — именованные константы:
    - `DEVTOOLS_PANEL` в `shared/ui-types.ts`: высота панели 120 px, доля 40 %;
    - `STAGE`, `CHROME_PX`, `MIN_PAGE_PX` в `renderer/browser/stage.ts`;
    - `NARROW_PX` в `DevtoolsPanel.tsx`.
  - Тайм-аут команды CDP — `CDP_COMMAND_MS` в `inspector.ts` (см. «Расхождения с индексом»).
- **Строки** — `S.browser.devtools.*`, `S.browser.viewport.*`, два заголовка в `S.actions`, три действия в `S.errors.actions` (задача 10).
  - Прежняя `S.browser.devTools` («DevTools») уходит вместе с кнопкой.
  - Страж `english-ui.test.ts` ловит кириллицу в литералах исходников окна. Тексты ошибок в main — тоже по-английски.
- **Команды проверок:**
  - модульные и компонентные тесты — `pnpm --filter @parley/desktop exec vitest run <файлы>`;
  - типы — `pnpm --filter @parley/desktop typecheck`;
  - E2E — `pnpm --filter @parley/desktop build && pnpm --filter @parley/desktop exec playwright test <spec>`.
- **Коммит** — по-русски, вторым `-m` строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Фокус ревью

Шесть случаев, которые спека подразумевает, а прямые тесты задач легко пропустят. Первый и второй — из «Фокуса ревью» индекса (его пункты 1 и 5), остальные четыре — свои у этапа A. Под каждый в задаче-владельце есть тест.

1. **Очень болтливая консоль** (индекс, п. 1). Тысячи сообщений в секунду не топят окно:
   - пачки идут не чаще раза в 150 мс и не больше 200 записей;
   - кольцо держит 1000;
   - повторы подряд схлопнуты в `count`.

   Тест — задача 4: «10 000 сообщений за 1 с → в окно ушло ≤ 7 пачек, в кольце 1000, у повторов count».
2. **Узкое окно и длинные значения** (индекс, п. 5). 800×500, адрес из 300 символов, название работы и ярлык сессии по 60 символов, DPR 1 и 2:
   - строка вкладки не вылезает за край;
   - сжимается адрес;
   - панель и детали запроса читаемы.

   Тесты — задача 17 (E2E при DPR 1 и 2) и задача 15 (сжимается только адрес, подписи прячет контейнерный запрос).
3. **Один упавший запрос — одна ошибка в счётчике.** У ответа 500 есть запись сети и ещё строка `Log.entryAdded` «Failed to load resource…». У CORS — ещё и строка браузера.
   - Красный счётчик считает упавшие запросы, ошибки консоли и исключения (`origin: 'console' | 'exception'`).
   - Строки сети и браузера видны в списке, но второй раз не считаются.

   Тест — задача 9, `devtoolsCounters`. E2E задачи 17 ждёт ровно 6.
4. **Записи до `dom-ready` не теряются.** Инспектор пишет с подключения, а окно узнаёт id гостя только на первом `dom-ready` — пустой страницы. Пачки до этого отбрасывает фильтр по id, их возвращает снимок `devtoolsSnapshot` на `dom-ready`. Страница вкладки при варианте D открывается позже (п. 6), поэтому её записи идут уже к известному id.

   Тест — задача 16: пачка до `dom-ready` не применяется; после — снимок с ней на месте; пачки чужого гостя не применяются.
5. **Документ навигации — уже в новой эпохе.** `Network.requestWillBeSent` документа приходит раньше `Page.frameNavigated`. Без переноса по `loaderId` было бы две беды:
   - панель без «Preserve log» после перехода не показала бы сам документ;
   - `capture` всегда был бы `late`.

   Тест — задача 4: запрос с `loaderId` нового документа — в новой эпохе и `capture: 'on'`; без него — `late`.
6. **Первая загрузка: подресурсы в журнале, пустой записи истории нет** (спайк 0.1, вариант D). Гость подключён раньше страницы, но это два шага: подключение к `about:blank` и открытие адреса.
   - Страница открывается только после `devtoolsReady`. Иначе стили, картинки и скрипты из HTML прошли бы мимо журнала (у вариантов A и B — 0 из 10).
   - Пустая страница не остаётся в истории гостя: «назад» после первой загрузки неактивна, в том числе когда страница не загрузилась.
   - Отказ или тайм-аут захвата страницу не держит: она открывается, вкладка получает `capture: 'unavailable'`.

   Тесты: задача 4 — `ready` и первая загрузка после пустой страницы; задача 5 — страж и пустая запись; задача 16 — `devtoolsReady` перед `loadURL`, в том числе после отказа; задача 17 — E2E без перезагрузки (стиль и картинка в Network, «назад» неактивна).

---

## Задача 1. Сверка с этапом 0

Итоги спайков правят задачи этого плана до их начала: индекс, «Умолчания до спайков». Этапу A нужны два спайка:
- 0.1 — когда подключать CDP;
- 0.3 — механизм эмуляции.

Остальные спайки — для этапов B–D. Сверка сделана по отчёту этапа 0: правки уже внесены в задачи ниже, исполнитель читает их исправленными. Задача сводится к записи итога.

**Файлы:**
- Читать: `docs/research/2026-10-08-browser-stage0.md`
- Изменить: этот план — абзац «Сверка с этапом 0» в шапке

- [x] **Шаг 1. Найти отчёт.**

```bash
ls docs/research/2026-10-*-browser-stage0.md
```

  Результат: один файл, `docs/research/2026-10-08-browser-stage0.md`.

- [x] **Шаг 2. Спайк 0.1 — момент подключения: вариант D.** Отчёт, раздел «0.1» и строка таблицы; решение человека 2026-10-08.
  - **Итог отчёта.** По критерию плана прошли A, B и C (по 10 из 10), D тоже. Критерий не смотрит на подресурсы, а они решают:

    | Вариант | Документ, `fetch`, XHR | Стиль, картинки, скрипт из HTML |
    |---|---|---|
    | A (`web-contents-created`) | 10/10 | 0/10 |
    | B (`did-start-loading`) | 10/10 | 0/10 |
    | C (`dom-ready` + `reload()`) | 10/10 | 9/10 |
    | D (`about:blank`, подключение, адрес) | 10/10 | 10/10 |

    По правилу плана остался бы A, но он теряет подресурсы первой загрузки. Человек выбрал D.
  - **Что делает вариант D:**
    - `<webview>` стартует с `src="about:blank"`; страж пускает такой `src` (задача 5);
    - main подключает отладчик на `web-contents-created`, пока гость пуст, и включает домены; `Inspector.ready(id)` отвечает, когда все четыре `enable` ответили, отказали или вышли по `CDP_COMMAND_MS` (задача 4);
    - окно на первом `dom-ready` (пустой страницы) зовёт `bridge.browser.devtoolsReady(id)` и после ответа открывает адрес вкладки методом `loadURL` у `<webview>` (задачи 7 и 16). Отказ или тайм-аут захвата страницу дольше `CDP_COMMAND_MS` не держат;
    - `capture: 'late'` остаётся только для повторного подключения к живой странице (после отказа `attach` или `detach`). Окно показывает там «Reload to capture earlier requests» (задача 13);
    - пустая страница не остаётся в истории гостя: страж убирает первую запись (задача 5).
  - **Где правки:** задача 4 (`ready`, тесты), задача 5 (`sanitizeWebviewAttach`, пустая запись истории), задача 7 (`devtoolsReady`), задача 16 (`BrowserSurface`), задача 17 (E2E без перезагрузки, стиль и картинка в журнале), задача 18 (документы), задача 19 (ручная проверка).
  - **Отличия от формулировки отчёта** («main ждёт `enable`, затем `loadURL`») — в «Расхождения с индексом», п. 10 и 11.

- [x] **Шаг 3. Спайк 0.3 — эмуляция: `cdp` прошёл всё, умолчание стоит.** Отчёт, раздел «0.3».
  - **Итог отчёта.** `cdp` — 5 из 5 по всем пунктам; `electron` (`enableDeviceEmulation`) теряет эмуляцию после `reload`, UA не меняет. Клик человека (`guest.sendInputEvent` в координатах вида) попадает 5 из 5 у обоих, поэтому вписанная страница остаётся уменьшенной по `scale`.
  - **Решения:**
    - механизм — CDP: `viewportCommands` (задача 6) ставит `Emulation.setDeviceMetricsOverride` со `scale`, `setTouchEmulationEnabled` и `setUserAgentOverride`;
    - касания включаются только с новым документом, поэтому окно предлагает «Reload to apply touch» (задачи 10 и 16), само `reload()` не делает: перезагрузка сбрасывает состояние формы и страницы разработчика;
    - эмуляция переживает `reload`, переход на другой origin (127.0.0.1 → localhost) и `goBack` — 3 из 3, повтор команд на навигации не нужен.
  - **Правок кода нет.** Одна пометка для этапа C: размер картинки со страницы при эмуляции — размер вида × DPR (Mobile M 2x — 750×1624), `scale` на него не влияет. Она записана комментарием в задаче 6 и в спеке окна (задача 18, шаг 3).

- [x] **Шаг 4. Итог записан в шапку плана** — абзац «Сверка с этапом 0».

- [x] **Шаг 5. Закоммитить.**

```bash
git add docs/specs/2026-10-07-browser-devtools-agent-plan-a-devtools.md
git commit -m "docs(plan): этап A — итоги этапа 0 (вариант D подключения CDP)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 2. Общие типы и пределы

**Файлы:**
- Создать: `packages/desktop/src/shared/browser-devtools.ts`
- Тест: `packages/desktop/src/shared/browser-devtools.test.ts`

**Интерфейсы:**
- Отдаёт (контракт индекса, этап A):
  - типы и константы: `ConsoleLevel`, `StackFrame`, `ConsoleEntry`, `NetworkKind`, `NetworkFailure`, `NetworkEntry`, `CaptureState`, `DevtoolsSnapshot`, `DevtoolsBatch`, `ResponseBody`, `ViewportPreset`, `ViewportDpr`, `ViewportSpec`, `VIEWPORT_PRESETS`, `MOBILE_USER_AGENT`, `DEVTOOLS_LIMITS`;
  - функции: `isFailed`, `viewportSize`, `isViewportSpec`.

- [ ] **Шаг 1. Написать падающий тест.**

```ts
// packages/desktop/src/shared/browser-devtools.test.ts
import { describe, expect, it } from 'vitest';
import {
  DEVTOOLS_LIMITS,
  isFailed,
  isViewportSpec,
  MOBILE_USER_AGENT,
  VIEWPORT_PRESETS,
  viewportSize,
  type NetworkEntry,
} from './browser-devtools.js';

function request(patch: Partial<NetworkEntry>): NetworkEntry {
  return {
    id: 'r1',
    epoch: 0,
    ts: 0,
    method: 'GET',
    url: 'http://localhost:5173/api',
    kind: 'fetch',
    status: 200,
    statusText: 'OK',
    failure: null,
    mimeType: null,
    encodedBytes: null,
    durationMs: null,
    fromCache: false,
    remoteAddress: null,
    requestHeaders: [],
    responseHeaders: [],
    hasPostData: false,
    postData: null,
    ...patch,
  };
}

describe('isFailed (спека 3.4)', () => {
  it('ответ 4xx и 5xx — упал; 2xx и 3xx — нет', () => {
    expect(isFailed(request({ status: 500 }))).toBe(true);
    expect(isFailed(request({ status: 404 }))).toBe(true);
    expect(isFailed(request({ status: 200 }))).toBe(false);
    expect(isFailed(request({ status: 304 }))).toBe(false);
  });

  it('отказ без ответа — упал; отмена и запрос в пути — нет', () => {
    expect(isFailed(request({ status: null, failure: { reason: 'cors', text: 'MissingAllowOriginHeader' } }))).toBe(true);
    expect(isFailed(request({ status: null, failure: { reason: 'net', text: 'net::ERR_CONNECTION_REFUSED' } }))).toBe(true);
    expect(isFailed(request({ status: null, failure: { reason: 'blocked', text: 'mixed-content' } }))).toBe(true);
    expect(isFailed(request({ status: null, failure: { reason: 'canceled', text: 'net::ERR_ABORTED' } }))).toBe(false);
    expect(isFailed(request({ status: null }))).toBe(false);
  });

  it('ответ 200 и отказ CORS после него — упал', () => {
    expect(isFailed(request({ status: 200, failure: { reason: 'cors', text: 'MissingAllowOriginHeader' } }))).toBe(true);
  });
});

describe('размеры вьюпорта (спека 4.2)', () => {
  it('пресеты — как в Chrome; мобильные — Mobile S, M, L и Tablet', () => {
    expect(VIEWPORT_PRESETS).toEqual({
      'mobile-s': { width: 320, height: 568, mobile: true },
      'mobile-m': { width: 375, height: 812, mobile: true },
      'mobile-l': { width: 430, height: 932, mobile: true },
      tablet: { width: 768, height: 1024, mobile: true },
      laptop: { width: 1280, height: 800, mobile: false },
      desktop: { width: 1440, height: 900, mobile: false },
    });
  });

  it('viewportSize: пресет, повёрнутый пресет, свой размер', () => {
    expect(viewportSize({ preset: 'mobile-m', rotated: false, dpr: 2 })).toEqual({ width: 375, height: 812, mobile: true, dpr: 2 });
    expect(viewportSize({ preset: 'mobile-m', rotated: true, dpr: 3 })).toEqual({ width: 812, height: 375, mobile: true, dpr: 3 });
    expect(viewportSize({ width: 1024, height: 700, mobile: false, dpr: 1 })).toEqual({ width: 1024, height: 700, mobile: false, dpr: 1 });
  });

  it('мобильный UA — iPhone Safari', () => {
    expect(MOBILE_USER_AGENT).toMatch(/iPhone.*Mobile.*Safari/);
  });
});

describe('isViewportSpec (раскладка и мост)', () => {
  it('верные пресет и свой размер — да', () => {
    expect(isViewportSpec({ preset: 'tablet', rotated: true, dpr: 1 })).toBe(true);
    expect(isViewportSpec({ width: 200, height: 2400, mobile: true, dpr: 3 })).toBe(true);
    expect(isViewportSpec({ width: 3840, height: 200, mobile: false, dpr: 2 })).toBe(true);
  });

  it('чужой пресет, DPR 4, размер вне 200–3840 × 200–2400, дробный, без полей, не объект — нет', () => {
    const bad: unknown[] = [
      { preset: 'phone', rotated: false, dpr: 2 },
      { preset: 'toString', rotated: false, dpr: 2 },
      { preset: 'mobile-m', dpr: 2 },
      { preset: 'mobile-m', rotated: false, dpr: 4 },
      { width: 199, height: 600, mobile: false, dpr: 1 },
      { width: 3841, height: 600, mobile: false, dpr: 1 },
      { width: 800, height: 2401, mobile: false, dpr: 1 },
      { width: 800.5, height: 600, mobile: false, dpr: 1 },
      { width: 800, height: 600, dpr: 1 },
      null,
      'mobile-m',
      [],
    ];
    for (const value of bad) expect(isViewportSpec(value), JSON.stringify(value)).toBe(false);
  });
});

describe('DEVTOOLS_LIMITS (спека, раздел 8)', () => {
  it('числа таблицы', () => {
    expect(DEVTOOLS_LIMITS).toEqual({
      consoleEntries: 1000,
      networkEntries: 500,
      consoleText: 10_000,
      stackFrames: 20,
      url: 4096,
      headers: 64,
      headerValue: 2048,
      postData: 65_536,
      panelBody: 1_048_576,
      batchMs: 150,
      batchMax: 200,
      resourceBuffer: 5_242_880,
      totalBuffer: 52_428_800,
      customMin: 200,
      customMaxWidth: 3840,
      customMaxHeight: 2400,
    });
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/shared/browser-devtools.test.ts` → FAIL: `Failed to resolve import "./browser-devtools.js"`.

- [ ] **Шаг 3. Реализовать.**

```ts
// packages/desktop/src/shared/browser-devtools.ts
/**
 * Консоль и сеть вкладки браузера, размеры вьюпорта (спека 2026-10-07-browser-devtools-agent-design.md, 3.4, 4.2,
 * раздел 8): общие для main (инспектор CDP, эмуляция), прелоада и окна. Имена и форма — контракт индекса плана
 * (`2026-10-07-browser-devtools-agent-plan.md`, «Общие имена»): этапы B–D ими пользуются.
 */

export type ConsoleLevel = 'error' | 'warning' | 'info' | 'debug';

export interface StackFrame {
  fn: string;
  url: string;
  line: number;
  column: number;
}

export interface ConsoleEntry {
  id: number;
  /** Номер документа главного фрейма (спека 3.3). */
  epoch: number;
  ts: number;
  level: ConsoleLevel;
  origin: 'console' | 'exception' | 'network' | 'browser';
  text: string;
  location: { url: string; line: number; column: number } | null;
  stack: StackFrame[];
  /** Одинаковые сообщения подряд. */
  count: number;
}

export type NetworkKind =
  | 'document'
  | 'fetch'
  | 'xhr'
  | 'script'
  | 'stylesheet'
  | 'image'
  | 'font'
  | 'media'
  | 'websocket'
  | 'other';

export interface NetworkFailure {
  reason: 'net' | 'cors' | 'blocked' | 'canceled';
  text: string;
}

export interface NetworkEntry {
  /** requestId CDP. */
  id: string;
  epoch: number;
  ts: number;
  method: string;
  url: string;
  kind: NetworkKind;
  status: number | null;
  statusText: string;
  failure: NetworkFailure | null;
  mimeType: string | null;
  encodedBytes: number | null;
  durationMs: number | null;
  fromCache: boolean;
  remoteAddress: string | null;
  requestHeaders: Array<[string, string]>;
  responseHeaders: Array<[string, string]>;
  hasPostData: boolean;
  postData: string | null;
}

/** Упавший: ответ 4xx–5xx или отказ, кроме отмены. Для «Failed only», красного счётчика и агента (спека 3.4). */
export function isFailed(entry: NetworkEntry): boolean {
  return (entry.status !== null && entry.status >= 400) || (entry.failure !== null && entry.failure.reason !== 'canceled');
}

/** `late` — захват подключился после начала загрузки: запросы документа могли пройти мимо. */
export type CaptureState = 'on' | 'late' | 'unavailable';

export interface DevtoolsSnapshot {
  epoch: number;
  capture: CaptureState;
  console: ConsoleEntry[];
  network: NetworkEntry[];
}

/** Пачка окну (событие `browser:devtools`): новые и изменённые записи; `reset` — журнал перед ней очищен. */
export interface DevtoolsBatch extends DevtoolsSnapshot {
  webContentsId: number;
  reset: boolean;
}

export interface ResponseBody {
  text: string;
  base64: boolean;
  truncated: boolean;
}

export type ViewportPreset = 'mobile-s' | 'mobile-m' | 'mobile-l' | 'tablet' | 'laptop' | 'desktop';
export type ViewportDpr = 1 | 2 | 3;
export type ViewportSpec =
  | { preset: ViewportPreset; rotated: boolean; dpr: ViewportDpr }
  | { width: number; height: number; mobile: boolean; dpr: ViewportDpr };

/** Пресеты device toolbar Chrome (спека 4.2): мобильные — с касаниями и мобильным UA. */
export const VIEWPORT_PRESETS: Readonly<Record<ViewportPreset, { width: number; height: number; mobile: boolean }>> = {
  'mobile-s': { width: 320, height: 568, mobile: true },
  'mobile-m': { width: 375, height: 812, mobile: true },
  'mobile-l': { width: 430, height: 932, mobile: true },
  tablet: { width: 768, height: 1024, mobile: true },
  laptop: { width: 1280, height: 800, mobile: false },
  desktop: { width: 1440, height: 900, mobile: false },
};

/** UA мобильного Safari, как у пресетов iPhone в Chrome. */
export const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Пределы раздела 8 спеки: main, окно и тесты берут числа только отсюда. */
export const DEVTOOLS_LIMITS = {
  consoleEntries: 1000,
  networkEntries: 500,
  consoleText: 10_000,
  stackFrames: 20,
  url: 4096,
  headers: 64,
  headerValue: 2048,
  postData: 65_536,
  panelBody: 1_048_576,
  batchMs: 150,
  batchMax: 200,
  resourceBuffer: 5_242_880,
  totalBuffer: 52_428_800,
  customMin: 200,
  customMaxWidth: 3840,
  customMaxHeight: 2400,
} as const;

/** Размер страницы в CSS-пикселях: пресет (с поворотом) или свой. */
export function viewportSize(spec: ViewportSpec): { width: number; height: number; mobile: boolean; dpr: ViewportDpr } {
  if (!('preset' in spec)) return { width: spec.width, height: spec.height, mobile: spec.mobile, dpr: spec.dpr };
  const preset = VIEWPORT_PRESETS[spec.preset];
  return spec.rotated
    ? { width: preset.height, height: preset.width, mobile: preset.mobile, dpr: spec.dpr }
    : { width: preset.width, height: preset.height, mobile: preset.mobile, dpr: spec.dpr };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDpr(value: unknown): value is ViewportDpr {
  return value === 1 || value === 2 || value === 3;
}

function isSide(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= DEVTOOLS_LIMITS.customMin && value <= max;
}

/** Размер из раскладки или из моста: пресет из списка или свой в пределах раздела 8. Лишние поля не проверяются. */
export function isViewportSpec(value: unknown): value is ViewportSpec {
  if (!isRecord(value) || !isDpr(value.dpr)) return false;
  if ('preset' in value) {
    return typeof value.preset === 'string' && Object.hasOwn(VIEWPORT_PRESETS, value.preset) && typeof value.rotated === 'boolean';
  }
  return (
    isSide(value.width, DEVTOOLS_LIMITS.customMaxWidth) &&
    isSide(value.height, DEVTOOLS_LIMITS.customMaxHeight) &&
    typeof value.mobile === 'boolean'
  );
}
```

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS (9 тестов). Затем `pnpm --filter @parley/desktop typecheck` → без ошибок.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/shared/browser-devtools.ts packages/desktop/src/shared/browser-devtools.test.ts
git commit -m "feat(desktop): типы журнала консоли и сети, пресеты размеров и пределы браузера" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 3. Перевод событий CDP в записи

Чистые функции без состояния: инспектор (задача 4) зовёт их на каждое событие.

**Файлы:**
- Создать: `packages/desktop/src/main/browser/cdp-entries.ts`
- Тест: `packages/desktop/src/main/browser/cdp-entries.test.ts`

**Интерфейсы:**
- Берёт: `DEVTOOLS_LIMITS`, `ConsoleEntry`, `ConsoleLevel`, `NetworkFailure`, `NetworkKind`, `StackFrame` (задача 2).
- Отдаёт:
  - типы: `RemoteObject`, `ObjectPreview`, `PropertyPreview`, `ConsoleApiParams`, `ExceptionParams`, `LogParams`, `ConsoleDraft`;
  - консоль: `clip(text, limit)`, `remoteText(arg)`, `formatConsoleArgs(args)`, `consoleFromApi(params)`, `consoleFromException(params)`, `consoleFromLog(params)`;
  - сеть: `networkKind(type)`, `headerPairs(headers)`, `failureOf(data)`, `remoteAddress(response)`, `postDataOf(request)`.

- [ ] **Шаг 1. Написать падающий тест.**

```ts
// packages/desktop/src/main/browser/cdp-entries.test.ts
import { describe, expect, it } from 'vitest';
import { DEVTOOLS_LIMITS } from '../../shared/browser-devtools.js';
import {
  clip,
  consoleFromApi,
  consoleFromException,
  consoleFromLog,
  failureOf,
  formatConsoleArgs,
  headerPairs,
  networkKind,
  postDataOf,
  remoteAddress,
  remoteText,
} from './cdp-entries.js';

const APP = 'http://localhost:5173/src/app.js';
const FRAME = { functionName: 'save', url: APP, lineNumber: 9, columnNumber: 4 };
const str = (value: string): { type: string; value: string } => ({ type: 'string', value });

describe('аргументы консоли текстом (спека 1.4, 4.3)', () => {
  it('строка, число, NaN, undefined, null, символ', () => {
    expect(remoteText(str('hi'))).toBe('hi');
    expect(remoteText({ type: 'number', value: 42, description: '42' })).toBe('42');
    expect(remoteText({ type: 'number', unserializableValue: 'NaN', description: 'NaN' })).toBe('NaN');
    expect(remoteText({ type: 'undefined' })).toBe('undefined');
    expect(remoteText({ type: 'object', subtype: 'null', value: null })).toBe('null');
    expect(remoteText({ type: 'symbol', description: 'Symbol(id)' })).toBe('Symbol(id)');
  });

  it("объект — краткий предпросмотр CDP: {theme: 'dark', items: Array(12)}", () => {
    expect(
      remoteText({
        type: 'object',
        description: 'Object',
        preview: {
          description: 'Object',
          overflow: false,
          properties: [
            { name: 'theme', type: 'string', value: 'dark' },
            { name: 'items', type: 'object', subtype: 'array', value: 'Array(12)' },
          ],
        },
      }),
    ).toBe("{theme: 'dark', items: Array(12)}");
  });

  it('массив — описание и элементы; переполнение — «…»; объект класса — с его именем', () => {
    expect(
      remoteText({
        type: 'object',
        subtype: 'array',
        description: 'Array(2)',
        preview: {
          subtype: 'array',
          description: 'Array(2)',
          overflow: false,
          properties: [
            { name: '0', type: 'number', value: '1' },
            { name: '1', type: 'number', value: '2' },
          ],
        },
      }),
    ).toBe('Array(2) [1, 2]');
    expect(
      remoteText({ type: 'object', description: 'Object', preview: { description: 'Object', overflow: true, properties: [{ name: 'a', type: 'number', value: '1' }] } }),
    ).toBe('{a: 1, …}');
    expect(
      remoteText({ type: 'object', description: 'User', preview: { description: 'User', overflow: false, properties: [{ name: 'id', type: 'number', value: '7' }] } }),
    ).toBe('User {id: 7}');
  });

  it('ошибка — описание со стеком; объект без предпросмотра — описание', () => {
    expect(remoteText({ type: 'object', subtype: 'error', description: 'Error: broken\n    at save (app.js:10:5)' })).toBe(
      'Error: broken\n    at save (app.js:10:5)',
    );
    expect(remoteText({ type: 'object', description: 'HTMLDivElement' })).toBe('HTMLDivElement');
  });

  it('формат: %c, %s, %d и %% первого аргумента; лишние аргументы — через пробел', () => {
    expect(
      formatConsoleArgs([
        str('%c%s has %d items, 100%%'),
        str('color: red'),
        str('cart'),
        { type: 'number', value: 3.7, description: '3.7' },
        { type: 'number', value: 5, description: '5' },
      ]),
    ).toBe('cart has 3 items, 100% 5');
    expect(formatConsoleArgs([str('a'), str('b')])).toBe('a b');
    expect(formatConsoleArgs([])).toBe('');
  });
});

describe('consoleFromApi (Runtime.consoleAPICalled)', () => {
  it('log — info из консоли; место и стек — с единицы', () => {
    expect(consoleFromApi({ type: 'log', args: [str('hello')], stackTrace: { callFrames: [FRAME] } })).toEqual({
      level: 'info',
      origin: 'console',
      text: 'hello',
      location: { url: APP, line: 10, column: 5 },
      stack: [{ fn: 'save', url: APP, line: 10, column: 5 }],
    });
  });

  it('уровни: error и assert — error, warning, debug; table и незнакомые — info', () => {
    const level = (type: string): string | undefined => consoleFromApi({ type, args: [str('x')] })?.level;
    expect(level('error')).toBe('error');
    expect(level('assert')).toBe('error');
    expect(level('warning')).toBe('warning');
    expect(level('debug')).toBe('debug');
    expect(level('table')).toBe('info');
    expect(level('somethingNew')).toBe('info');
    expect(consoleFromApi({ type: 'assert', args: [str('x > 0')] })?.text).toBe('Assertion failed: x > 0');
  });

  it('endGroup, clear, profile, profileEnd — не запись', () => {
    for (const type of ['endGroup', 'clear', 'profile', 'profileEnd']) {
      expect(consoleFromApi({ type, args: [] }), type).toBeNull();
    }
  });

  it('предупреждение безопасности Electron — не запись (спека 3.3)', () => {
    expect(
      consoleFromApi({ type: 'warning', args: [str('%cElectron Security Warning (Insecure Content-Security-Policy)'), str('font-weight: bold;')] }),
    ).toBeNull();
  });

  it('текст — до 10 000, стек — до 20 кадров; безымянная функция — (anonymous); без стека — без места', () => {
    const frames = Array.from({ length: 30 }, () => ({ url: APP, lineNumber: 0, columnNumber: 0 }));
    const draft = consoleFromApi({ type: 'log', args: [str('x'.repeat(20_000))], stackTrace: { callFrames: frames } });
    expect(draft?.text).toHaveLength(DEVTOOLS_LIMITS.consoleText);
    expect(draft?.stack).toHaveLength(DEVTOOLS_LIMITS.stackFrames);
    expect(draft?.stack[0]?.fn).toBe('(anonymous)');
    expect(consoleFromApi({ type: 'log', args: [str('x')] })?.location).toBeNull();
  });
});

describe('consoleFromException (Runtime.exceptionThrown)', () => {
  it('Uncaught Error: boom — первая строка описания и стек исключения', () => {
    expect(
      consoleFromException({
        exceptionDetails: {
          text: 'Uncaught',
          exception: { type: 'object', subtype: 'error', description: 'Error: boom\n    at tick (app.js:3:9)' },
          stackTrace: { callFrames: [FRAME] },
        },
      }),
    ).toEqual({
      level: 'error',
      origin: 'exception',
      text: 'Uncaught Error: boom',
      location: { url: APP, line: 10, column: 5 },
      stack: [{ fn: 'save', url: APP, line: 10, column: 5 }],
    });
  });

  it('отказ промиса и брошенная строка', () => {
    expect(
      consoleFromException({ exceptionDetails: { text: 'Uncaught (in promise)', exception: { type: 'object', subtype: 'error', description: 'Error: nope' } } }).text,
    ).toBe('Uncaught (in promise) Error: nope');
    expect(consoleFromException({ exceptionDetails: { text: 'Uncaught', exception: str('oops') } }).text).toBe('Uncaught oops');
  });

  it('текст CDP уже с сообщением — без повтора; без стека — место из url исключения', () => {
    const draft = consoleFromException({
      exceptionDetails: {
        text: 'Uncaught SyntaxError: Unexpected token',
        url: APP,
        lineNumber: 4,
        columnNumber: 2,
        exception: { type: 'object', subtype: 'error', description: 'SyntaxError: Unexpected token' },
      },
    });
    expect(draft.text).toBe('Uncaught SyntaxError: Unexpected token');
    expect(draft.location).toEqual({ url: APP, line: 5, column: 3 });
  });
});

describe('consoleFromLog (Log.entryAdded)', () => {
  it('«Failed to load resource» сети — origin network', () => {
    expect(
      consoleFromLog({
        entry: {
          source: 'network',
          level: 'error',
          text: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)',
          url: 'http://localhost:5173/api',
        },
      }),
    ).toEqual({
      level: 'error',
      origin: 'network',
      text: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)',
      location: { url: 'http://localhost:5173/api', line: 1, column: 1 },
      stack: [],
    });
  });

  it('строка с networkRequestId (CORS) — тоже network; verbose — debug; прочие — browser', () => {
    expect(
      consoleFromLog({ entry: { source: 'javascript', level: 'error', text: 'Access to fetch has been blocked by CORS policy', networkRequestId: '12.3' } }).origin,
    ).toBe('network');
    expect(consoleFromLog({ entry: { source: 'violation', level: 'verbose', text: 'slow handler' } })).toMatchObject({ origin: 'browser', level: 'debug' });
    expect(consoleFromLog({ entry: { source: 'deprecation', level: 'warning', text: 'old API' } })).toMatchObject({ origin: 'browser', level: 'warning' });
  });
});

describe('сеть (спека 3.3, раздел 8)', () => {
  it('networkKind: типы CDP → вид записи; Preflight и незнакомые — other', () => {
    expect(['Document', 'Fetch', 'XHR', 'Script', 'Stylesheet', 'Image', 'Font', 'Media', 'WebSocket', 'Preflight', 'Ping'].map(networkKind)).toEqual([
      'document',
      'fetch',
      'xhr',
      'script',
      'stylesheet',
      'image',
      'font',
      'media',
      'websocket',
      'other',
      'other',
    ]);
    expect(networkKind(undefined)).toBe('other');
    expect(networkKind('toString')).toBe('other');
  });

  it('headerPairs: пары по порядку, не больше 64, значение до 2 КБ; не объект — пусто', () => {
    const many = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`x-h${index}`, 'v']));
    expect(headerPairs(many)).toHaveLength(DEVTOOLS_LIMITS.headers);
    expect(headerPairs({ Accept: '*/*', 'X-Long': 'y'.repeat(5000) })).toEqual([
      ['Accept', '*/*'],
      ['X-Long', 'y'.repeat(DEVTOOLS_LIMITS.headerValue)],
    ]);
    expect(headerPairs(null)).toEqual([]);
  });

  it('failureOf: отмена, CORS, блок, сеть — в этом порядке', () => {
    expect(failureOf({ errorText: 'net::ERR_ABORTED', canceled: true, corsErrorStatus: { corsError: 'X' } })).toEqual({ reason: 'canceled', text: 'net::ERR_ABORTED' });
    expect(failureOf({ errorText: 'net::ERR_FAILED', corsErrorStatus: { corsError: 'MissingAllowOriginHeader', failedParameter: '' } })).toEqual({
      reason: 'cors',
      text: 'MissingAllowOriginHeader',
    });
    expect(failureOf({ errorText: 'net::ERR_BLOCKED_BY_CLIENT', blockedReason: 'mixed-content' })).toEqual({ reason: 'blocked', text: 'mixed-content' });
    expect(failureOf({ errorText: 'net::ERR_CONNECTION_REFUSED' })).toEqual({ reason: 'net', text: 'net::ERR_CONNECTION_REFUSED' });
  });

  it('remoteAddress: IPv4 с портом, IPv6 в скобках, без адреса — null', () => {
    expect(remoteAddress({ remoteIPAddress: '127.0.0.1', remotePort: 5173 })).toBe('127.0.0.1:5173');
    expect(remoteAddress({ remoteIPAddress: '::1', remotePort: 5173 })).toBe('[::1]:5173');
    expect(remoteAddress({})).toBeNull();
  });

  it('postDataOf: postData, склейка postDataEntries из base64, без тела — null; предел 64 КБ', () => {
    expect(postDataOf({ postData: '{"a":1}' })).toBe('{"a":1}');
    expect(
      postDataOf({ postDataEntries: [{ bytes: Buffer.from('a=1&').toString('base64') }, { bytes: Buffer.from('b=2').toString('base64') }] }),
    ).toBe('a=1&b=2');
    expect(postDataOf({})).toBeNull();
    expect(postDataOf({ postData: 'z'.repeat(70_000) })).toHaveLength(DEVTOOLS_LIMITS.postData);
  });

  it('clip не оставляет половину суррогатной пары', () => {
    expect(clip('ab😀', 3)).toBe('ab');
    expect(clip('abc', 5)).toBe('abc');
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/main/browser/cdp-entries.test.ts` → FAIL: `Failed to resolve import "./cdp-entries.js"`.

- [ ] **Шаг 3. Реализовать.**

```ts
// packages/desktop/src/main/browser/cdp-entries.ts
/**
 * Перевод событий CDP в записи журнала (спека 2026-10-07-browser-devtools-agent-design.md, 3.3, 3.4): консоль —
 * `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` и `Log.entryAdded`; поля сети — `Network.*`. Только чистые
 * функции: кольца, эпохи и пачки — в `inspector.ts`. Всё здесь — данные страницы: длины режутся пределами
 * `DEVTOOLS_LIMITS`, форме не верим — любое поле может отсутствовать.
 */
import {
  DEVTOOLS_LIMITS,
  type ConsoleEntry,
  type ConsoleLevel,
  type NetworkFailure,
  type NetworkKind,
  type StackFrame,
} from '../../shared/browser-devtools.js';

/** RemoteObject CDP — только читаемые поля. */
export interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  preview?: ObjectPreview;
}

export interface ObjectPreview {
  subtype?: string;
  description?: string;
  overflow?: boolean;
  properties?: PropertyPreview[];
}

export interface PropertyPreview {
  name: string;
  type: string;
  subtype?: string;
  value?: string;
}

interface CallFrame {
  functionName?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

interface StackTrace {
  callFrames?: CallFrame[];
}

export interface ConsoleApiParams {
  type?: string;
  args?: RemoteObject[];
  stackTrace?: StackTrace;
}

export interface ExceptionParams {
  exceptionDetails?: {
    text?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    stackTrace?: StackTrace;
    exception?: RemoteObject;
  };
}

export interface LogParams {
  entry?: {
    source?: string;
    level?: string;
    text?: string;
    url?: string;
    lineNumber?: number;
    stackTrace?: StackTrace;
    networkRequestId?: string;
  };
}

/** Запись консоли без полей журнала: id, эпоху, время и повторы ставит инспектор. */
export type ConsoleDraft = Pick<ConsoleEntry, 'level' | 'origin' | 'text' | 'location' | 'stack'>;

/** Служебное предупреждение Electron (CSP и прочее) — не сообщение страницы (спека 3.3). */
const ELECTRON_WARNING = '%cElectron Security Warning';

/** Тип `console.*` → уровень; null — не запись: без текста или служебное. Прочие типы — info. */
const API_LEVEL: Readonly<Record<string, ConsoleLevel | null>> = {
  error: 'error',
  assert: 'error',
  warning: 'warning',
  debug: 'debug',
  endGroup: null,
  clear: null,
  profile: null,
  profileEnd: null,
};

const KIND: Readonly<Record<string, NetworkKind>> = {
  Document: 'document',
  Fetch: 'fetch',
  XHR: 'xhr',
  Script: 'script',
  Stylesheet: 'stylesheet',
  Image: 'image',
  Font: 'font',
  Media: 'media',
  WebSocket: 'websocket',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Первые `limit` знаков; половина суррогатной пары (эмодзи) на краю не остаётся. */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function propertyText(property: PropertyPreview): string {
  return property.type === 'string' ? `'${property.value ?? ''}'` : (property.value ?? property.type);
}

function previewText(preview: ObjectPreview): string {
  const isArray = preview.subtype === 'array' || preview.subtype === 'typedarray';
  const items = (preview.properties ?? []).map((property) =>
    isArray ? propertyText(property) : `${property.name}: ${propertyText(property)}`,
  );
  if (preview.overflow === true) items.push('…');
  if (isArray) return `${preview.description ?? 'Array'} [${items.join(', ')}]`;
  const name = preview.description === undefined || preview.description === 'Object' ? '' : `${preview.description} `;
  return `${name}{${items.join(', ')}}`;
}

/** Аргумент консоли текстом: строка — как есть, объект — краткий предпросмотр CDP, ошибка — описание со стеком. */
export function remoteText(arg: RemoteObject): string {
  switch (arg.type) {
    case 'string':
      return typeof arg.value === 'string' ? arg.value : '';
    case 'undefined':
      return 'undefined';
    case 'number':
    case 'boolean':
    case 'bigint':
      return arg.unserializableValue ?? String(arg.value);
    case 'object':
      if (arg.subtype === 'null') return 'null';
      if (arg.subtype === 'error') return arg.description ?? 'Error';
      return arg.preview === undefined ? (arg.description ?? 'Object') : previewText(arg.preview);
    default:
      return arg.description ?? arg.type;
  }
}

/** Аргументы `console.*` строкой: подстановки `%s %d %i %f %o %O` первого аргумента; `%c` (стиль) выпадает. */
export function formatConsoleArgs(args: readonly RemoteObject[]): string {
  const [first, ...rest] = args;
  if (first === undefined) return '';
  if (first.type !== 'string' || typeof first.value !== 'string' || !first.value.includes('%')) {
    return args.map((arg) => remoteText(arg)).join(' ');
  }
  let used = 0;
  const head = first.value.replace(/%([sdifoOc%])/g, (match: string, code: string) => {
    if (code === '%') return '%';
    const arg = rest[used];
    if (arg === undefined) return match;
    used += 1;
    if (code === 'c') return '';
    if ((code === 'd' || code === 'i') && typeof arg.value === 'number') return String(Math.trunc(arg.value));
    return remoteText(arg);
  });
  return [head, ...rest.slice(used).map((arg) => remoteText(arg))].join(' ');
}

function frames(trace: StackTrace | undefined): StackFrame[] {
  return (trace?.callFrames ?? []).slice(0, DEVTOOLS_LIMITS.stackFrames).map((frame) => ({
    fn: frame.functionName === undefined || frame.functionName === '' ? '(anonymous)' : frame.functionName,
    url: clip(frame.url ?? '', DEVTOOLS_LIMITS.url),
    // CDP считает строки и столбцы с нуля, люди и DevTools — с единицы.
    line: (frame.lineNumber ?? 0) + 1,
    column: (frame.columnNumber ?? 0) + 1,
  }));
}

function topOf(stack: readonly StackFrame[]): ConsoleEntry['location'] {
  const top = stack[0];
  return top === undefined || top.url === '' ? null : { url: top.url, line: top.line, column: top.column };
}

function placeOf(url: string | undefined, line: number | undefined, column: number | undefined): ConsoleEntry['location'] {
  return url === undefined || url === ''
    ? null
    : { url: clip(url, DEVTOOLS_LIMITS.url), line: (line ?? 0) + 1, column: (column ?? 0) + 1 };
}

export function consoleFromApi(params: ConsoleApiParams): ConsoleDraft | null {
  const type = params.type ?? 'log';
  const level = Object.hasOwn(API_LEVEL, type) ? (API_LEVEL[type] ?? null) : 'info';
  if (level === null) return null;
  const args = params.args ?? [];
  const first = args[0];
  if (first?.type === 'string' && typeof first.value === 'string' && first.value.startsWith(ELECTRON_WARNING)) return null;
  const formatted = formatConsoleArgs(args);
  const text = type !== 'assert' ? formatted : formatted === '' ? 'Assertion failed' : `Assertion failed: ${formatted}`;
  const stack = frames(params.stackTrace);
  return { level, origin: 'console', text: clip(text, DEVTOOLS_LIMITS.consoleText), location: topOf(stack), stack };
}

export function consoleFromException(params: ExceptionParams): ConsoleDraft {
  const details = params.exceptionDetails ?? {};
  const head = details.text ?? 'Uncaught';
  const exception = details.exception;
  const body =
    exception === undefined
      ? ''
      : exception.subtype === 'error'
        ? ((exception.description ?? '').split('\n')[0] ?? '')
        : remoteText(exception);
  const text = body === '' || head.includes(body) ? head : `${head} ${body}`;
  const stack = frames(details.stackTrace);
  return {
    level: 'error',
    origin: 'exception',
    text: clip(text, DEVTOOLS_LIMITS.consoleText),
    location: topOf(stack) ?? placeOf(details.url, details.lineNumber, details.columnNumber),
    stack,
  };
}

export function consoleFromLog(params: LogParams): ConsoleDraft {
  const entry = params.entry ?? {};
  const level: ConsoleLevel =
    entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : entry.level === 'verbose' ? 'debug' : 'info';
  const stack = frames(entry.stackTrace);
  return {
    level,
    // «Failed to load resource…» и CORS — строки про запрос: красный счётчик считает сам запрос (Фокус ревью 3).
    origin: entry.source === 'network' || typeof entry.networkRequestId === 'string' ? 'network' : 'browser',
    text: clip(entry.text ?? '', DEVTOOLS_LIMITS.consoleText),
    location: topOf(stack) ?? placeOf(entry.url, entry.lineNumber, 0),
    stack,
  };
}

/** Тип ресурса CDP → вид записи; Preflight, Ping и прочие — other. */
export function networkKind(type: unknown): NetworkKind {
  return typeof type === 'string' && Object.hasOwn(KIND, type) ? (KIND[type] ?? 'other') : 'other';
}

/** Заголовки CDP (объект) → пары по порядку; не больше 64, значение до 2 КБ (раздел 8). */
export function headerPairs(headers: unknown): Array<[string, string]> {
  if (!isRecord(headers)) return [];
  return Object.entries(headers)
    .slice(0, DEVTOOLS_LIMITS.headers)
    .map(([name, value]): [string, string] => [name, clip(String(value), DEVTOOLS_LIMITS.headerValue)]);
}

/** Причина отказа `Network.loadingFailed`: отмена, CORS, блок, сеть — в этом порядке. */
export function failureOf(data: Record<string, unknown>): NetworkFailure {
  const errorText = typeof data.errorText === 'string' ? data.errorText : '';
  if (data.canceled === true) return { reason: 'canceled', text: errorText };
  if (isRecord(data.corsErrorStatus)) {
    const cors = data.corsErrorStatus.corsError;
    return { reason: 'cors', text: typeof cors === 'string' ? cors : errorText };
  }
  if (typeof data.blockedReason === 'string') return { reason: 'blocked', text: data.blockedReason };
  return { reason: 'net', text: errorText };
}

/** Адрес сервера ответа; IPv6 — в скобках, как в адресной строке. */
export function remoteAddress(response: Record<string, unknown>): string | null {
  const ip = response.remoteIPAddress;
  if (typeof ip !== 'string' || ip === '') return null;
  const host = ip.includes(':') ? `[${ip}]` : ip;
  return typeof response.remotePort === 'number' ? `${host}:${response.remotePort}` : host;
}

/** Тело запроса: `postData` или склейка `postDataEntries` (base64); до 64 КБ (раздел 8). */
export function postDataOf(request: Record<string, unknown>): string | null {
  if (typeof request.postData === 'string') return clip(request.postData, DEVTOOLS_LIMITS.postData);
  const parts: unknown[] = Array.isArray(request.postDataEntries) ? request.postDataEntries : [];
  if (parts.length === 0) return null;
  const bytes = parts.map((part) => Buffer.from(isRecord(part) && typeof part.bytes === 'string' ? part.bytes : '', 'base64'));
  return clip(Buffer.concat(bytes).toString('utf8'), DEVTOOLS_LIMITS.postData);
}
```

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS. Затем `pnpm --filter @parley/desktop exec vitest run src/english-ui.test.ts` → PASS (в литералах нет кириллицы).

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/main/browser/cdp-entries.ts packages/desktop/src/main/browser/cdp-entries.test.ts
git commit -m "feat(desktop): перевод событий CDP в записи консоли и сети" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 4. Инспектор: журнал, эпохи, захват, пачки

**Файлы:**
- Создать: `packages/desktop/src/main/browser/inspector.ts`
- Тест: `packages/desktop/src/main/browser/inspector.test.ts`

**Интерфейсы:**
- Берёт: функции и типы `cdp-entries.ts` (задача 3); `DEVTOOLS_LIMITS`, `CaptureState`, `ConsoleEntry`, `NetworkEntry`, `DevtoolsBatch`, `DevtoolsSnapshot`, `ResponseBody` (задача 2).
- Отдаёт (контракт индекса):
  - `CdpMethod`, `CDP_ALLOWED`, `Inspector`, `createInspector(deps)`;
  - сверх индекса — `CDP_COMMAND_MS` (тайм-аут команды) и `Inspector.ready` (см. «Расхождения с индексом», п. 1 и 10).
- Поведение `Inspector`:
  - `attach` — один раз на гостя; подключается сразу, пока гость пуст (спайк 0.1, вариант D);
  - `ready` — когда все четыре `enable` ответили, отказали или вышли по тайм-ауту; журнала нет — сразу;
  - `snapshot` — копии записей колец, `null` у неизвестного гостя;
  - `clear` — следующая пачка с `reset: true`;
  - `responseBody` — `null`, если тела нет;
  - `send` — отказ вне `CDP_ALLOWED`, у чужого и у отцепившегося гостя;
  - `onBatch` и `onEvent` — с отпиской.

- [ ] **Шаг 1. Написать падающий тест** — подключение, журнал консоли и сети, эпохи.

```ts
// packages/desktop/src/main/browser/inspector.test.ts
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVTOOLS_LIMITS, type DevtoolsBatch } from '../../shared/browser-devtools.js';
import { CDP_ALLOWED, CDP_COMMAND_MS, createInspector } from './inspector.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Часы теста: пачки и тайм-ауты команд идут по ним, без настоящего времени. */
function fakeClock() {
  let time = 0;
  const timers: Array<{ at: number; fn: () => void; alive: boolean }> = [];
  return {
    now: (): number => time,
    setTimer: (fn: () => void, ms: number): (() => void) => {
      const timer = { at: time + ms, fn, alive: true };
      timers.push(timer);
      return () => {
        timer.alive = false;
      };
    },
    /** Сдвинуть время, по пути исполнив сработавшие таймеры по порядку. */
    tick(ms: number): void {
      const end = time + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.alive && timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        time = due.at;
        due.alive = false;
        due.fn();
      }
      time = end;
    },
  };
}

/** Гость `<webview>`: EventEmitter, адрес и `debugger` с подставными attach и sendCommand. */
function fakeGuest(id: number, url = '') {
  const dbg = Object.assign(new EventEmitter(), {
    attach: vi.fn<(version: string) => void>(),
    sendCommand: vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(async () => ({})),
  });
  const contents = Object.assign(new EventEmitter(), {
    id,
    debugger: dbg,
    getURL: vi.fn<() => string>(() => url),
    isDestroyed: vi.fn<() => boolean>(() => false),
  });
  return { contents, dbg };
}

/** Отказы подключения инспектор пишет в журнал main — в тесте он тихий. */
function quietWarnings(): void {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

/** Отказ команды CDP обрабатывается в микрозадаче. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** `gates` — ответы на команды CDP по одному: каждая команда кладёт сюда функцию, которая её разрешает. */
function setup(options: { url?: string; attachError?: boolean; hang?: boolean; gates?: Array<() => void> } = {}) {
  const clock = fakeClock();
  const guest = fakeGuest(7, options.url);
  if (options.attachError === true) {
    guest.dbg.attach.mockImplementationOnce(() => {
      throw new Error('Another debugger is already attached');
    });
  }
  if (options.hang === true) guest.dbg.sendCommand.mockImplementation(() => new Promise<unknown>(() => {}));
  if (options.gates !== undefined) {
    const gates = options.gates;
    guest.dbg.sendCommand.mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          gates.push(() => resolve({}));
        }),
    );
  }
  const inspector = createInspector({
    fromId: (id) => (id === 7 && !guest.contents.isDestroyed() ? (guest.contents as unknown as WebContents) : null),
    now: clock.now,
    setTimer: clock.setTimer,
  });
  const batches: DevtoolsBatch[] = [];
  inspector.onBatch((batch) => batches.push(batch));
  inspector.attach(guest.contents as unknown as WebContents);
  /** Событие CDP от гостя. */
  const cdp = (method: string, params: unknown): void => {
    guest.dbg.emit('message', {}, method, params);
  };
  return { ...guest, clock, inspector, batches, cdp };
}

const APP = 'http://localhost:5173/src/app.js';

function log(text: string, line = 9): Record<string, unknown> {
  return {
    type: 'log',
    args: [{ type: 'string', value: text }],
    stackTrace: { callFrames: [{ functionName: 'run', url: APP, lineNumber: line, columnNumber: 0 }] },
  };
}

function request(requestId: string, url: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestId, loaderId: 'L1', timestamp: 100, type: 'Fetch', request: { url, method: 'GET', headers: { Accept: '*/*' } }, ...extra };
}

function mainFrame(loaderId: string, url = 'http://localhost:5173/next', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'Navigation', frame: { id: 'F1', loaderId, url }, ...extra };
}

describe('подключение (спека 3.3, спайк 0.1 — вариант D: к пустому гостю, страницу открывает окно после ready)', () => {
  it('гость: debugger.attach(1.3), enable Runtime, Log, Page и Network с буферами раздела 8', () => {
    const { dbg, inspector } = setup();
    expect(dbg.attach).toHaveBeenCalledWith('1.3');
    expect(dbg.sendCommand.mock.calls).toEqual([
      ['Runtime.enable', undefined],
      ['Log.enable', undefined],
      ['Page.enable', undefined],
      ['Network.enable', { maxResourceBufferSize: DEVTOOLS_LIMITS.resourceBuffer, maxTotalBufferSize: DEVTOOLS_LIMITS.totalBuffer }],
    ]);
    expect(inspector.snapshot(7)).toEqual({ epoch: 0, capture: 'on', console: [], network: [] });
  });

  it('attach бросил — unavailable; повтор только на навигации главного фрейма с новым документом; живая страница — late', () => {
    quietWarnings();
    const { contents, dbg, inspector } = setup({ attachError: true, url: 'http://localhost:5173/' });
    expect(inspector.snapshot(7)?.capture).toBe('unavailable');
    contents.emit('did-start-navigation', { url: 'http://localhost:5173/#top', isMainFrame: true, isSameDocument: true });
    contents.emit('did-start-navigation', { url: 'http://ads.test/', isMainFrame: false, isSameDocument: false });
    expect(dbg.attach).toHaveBeenCalledTimes(1);
    contents.emit('did-start-navigation', { url: 'http://localhost:5173/next', isMainFrame: true, isSameDocument: false });
    expect(dbg.attach).toHaveBeenCalledTimes(2);
    expect(inspector.snapshot(7)?.capture).toBe('late');
  });

  it('enable не ответил за 10 с — unavailable', async () => {
    quietWarnings();
    const { clock, inspector } = setup({ hang: true });
    clock.tick(CDP_COMMAND_MS - 1);
    await settle();
    expect(inspector.snapshot(7)?.capture).toBe('on');
    clock.tick(1);
    await settle();
    expect(inspector.snapshot(7)?.capture).toBe('unavailable');
  });

  it('detach — unavailable; на следующей навигации главного фрейма — новое подключение', () => {
    quietWarnings();
    const { contents, dbg, inspector } = setup();
    dbg.emit('detach', {}, 'target closed');
    expect(inspector.snapshot(7)?.capture).toBe('unavailable');
    contents.getURL.mockReturnValue('http://localhost:5173/');
    contents.emit('did-start-navigation', { url: 'http://localhost:5173/', isMainFrame: true, isSameDocument: false });
    expect(dbg.attach).toHaveBeenCalledTimes(2);
    expect(inspector.snapshot(7)?.capture).toBe('late');
  });

  it('повторный attach того же гостя — без второго отладчика; гость уничтожен — журнала нет', () => {
    const { contents, dbg, inspector } = setup();
    inspector.attach(contents as unknown as WebContents);
    expect(dbg.attach).toHaveBeenCalledTimes(1);
    contents.emit('destroyed');
    expect(inspector.snapshot(7)).toBeNull();
  });

  it('ready: не раньше ответа на все четыре enable', async () => {
    const gates: Array<() => void> = [];
    const { inspector } = setup({ gates });
    let ready = false;
    void inspector.ready(7).then(() => {
      ready = true;
    });
    expect(gates).toHaveLength(4);
    for (const open of gates.slice(0, 3)) open();
    await settle();
    expect(ready).toBe(false);
    gates[3]?.();
    await settle();
    expect(ready).toBe(true);
    expect(inspector.snapshot(7)?.capture).toBe('on');
  });

  it('ready: зависший enable отпускает по тайм-ауту CDP_COMMAND_MS, capture unavailable; журнала нет — готово сразу', async () => {
    quietWarnings();
    const { clock, inspector } = setup({ hang: true });
    let ready = false;
    void inspector.ready(7).then(() => {
      ready = true;
    });
    clock.tick(CDP_COMMAND_MS - 1);
    await settle();
    expect(ready).toBe(false);
    clock.tick(1);
    await settle();
    expect(ready).toBe(true);
    expect(inspector.snapshot(7)?.capture).toBe('unavailable');
    await expect(inspector.ready(8)).resolves.toBeUndefined();
  });

  it('вариант D: подключение к пустому гостю, потом первая загрузка — документ, стиль и картинка в одной эпохе, capture on', () => {
    const { cdp, inspector } = setup();
    // Гость ещё не грузился (getURL() === ''): захват не поздний.
    expect(inspector.snapshot(7)?.capture).toBe('on');
    cdp('Page.frameNavigated', mainFrame('LB', 'about:blank'));
    cdp('Network.requestWillBeSent', request('doc', 'http://localhost:5173/', { loaderId: 'L1', type: 'Document' }));
    cdp('Network.requestWillBeSent', request('css', 'http://localhost:5173/app.css', { loaderId: 'L1', type: 'Stylesheet' }));
    cdp('Network.requestWillBeSent', request('img', 'http://localhost:5173/logo.svg', { loaderId: 'L1', type: 'Image' }));
    cdp('Page.frameNavigated', mainFrame('L1', 'http://localhost:5173/'));
    const snapshot = inspector.snapshot(7);
    expect(snapshot?.network.map((entry) => [entry.id, entry.kind, entry.epoch])).toEqual([
      ['doc', 'document', 2],
      ['css', 'stylesheet', 2],
      ['img', 'image', 2],
    ]);
    expect(snapshot?.capture).toBe('on');
  });
});

describe('консоль: записи, повторы, кольцо (спека 3.3, раздел 8)', () => {
  it('сообщение — запись с id, эпохой, временем и count 1', () => {
    const { cdp, clock, inspector } = setup();
    clock.tick(5);
    cdp('Runtime.consoleAPICalled', log('hello'));
    expect(inspector.snapshot(7)?.console).toEqual([
      {
        id: 1,
        epoch: 0,
        ts: 5,
        level: 'info',
        origin: 'console',
        text: 'hello',
        location: { url: APP, line: 10, column: 1 },
        stack: [{ fn: 'run', url: APP, line: 10, column: 1 }],
        count: 1,
      },
    ]);
  });

  it('одинаковые подряд — одна запись с count; другое место или сообщение между ними — новые записи', () => {
    const { cdp, inspector } = setup();
    cdp('Runtime.consoleAPICalled', log('tick'));
    cdp('Runtime.consoleAPICalled', log('tick'));
    cdp('Runtime.consoleAPICalled', log('tick'));
    cdp('Runtime.consoleAPICalled', log('tick', 20));
    cdp('Runtime.consoleAPICalled', log('other'));
    cdp('Runtime.consoleAPICalled', log('tick', 20));
    expect(inspector.snapshot(7)?.console.map((entry) => [entry.text, entry.location?.line, entry.count])).toEqual([
      ['tick', 10, 3],
      ['tick', 21, 1],
      ['other', 10, 1],
      ['tick', 21, 1],
    ]);
  });

  it('кольцо — 1000 последних', () => {
    const { cdp, inspector } = setup();
    for (let n = 1; n <= DEVTOOLS_LIMITS.consoleEntries + 5; n += 1) cdp('Runtime.consoleAPICalled', log(`m${n}`));
    const entries = inspector.snapshot(7)?.console ?? [];
    expect(entries).toHaveLength(DEVTOOLS_LIMITS.consoleEntries);
    expect(entries[0]?.text).toBe('m6');
  });

  it('исключение и строка сети — записи; предупреждение Electron — нет', () => {
    const { cdp, inspector } = setup();
    cdp('Runtime.exceptionThrown', {
      exceptionDetails: { text: 'Uncaught', exception: { type: 'object', subtype: 'error', description: 'Error: boom\n    at x' } },
    });
    cdp('Log.entryAdded', {
      entry: { source: 'network', level: 'error', text: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)' },
    });
    cdp('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: '%cElectron Security Warning (Insecure CSP)' }] });
    expect(inspector.snapshot(7)?.console.map((entry) => [entry.origin, entry.level, entry.text])).toEqual([
      ['exception', 'error', 'Uncaught Error: boom'],
      ['network', 'error', 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)'],
    ]);
  });
});

describe('сеть: жизнь запроса (спека 3.3, 3.4)', () => {
  it('requestWillBeSent → responseReceived 500 → loadingFinished: статус, заголовки, тело запроса, размер, длительность', () => {
    const { cdp, inspector } = setup();
    cdp(
      'Network.requestWillBeSent',
      request('r1', 'http://localhost:5173/api/settings', {
        request: { url: 'http://localhost:5173/api/settings', method: 'POST', headers: { 'Content-Type': 'application/json' }, postData: '{"a":1}', hasPostData: true },
      }),
    );
    cdp('Network.responseReceived', {
      requestId: 'r1',
      type: 'Fetch',
      response: {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'content-type': 'application/json' },
        mimeType: 'application/json',
        remoteIPAddress: '127.0.0.1',
        remotePort: 5173,
      },
    });
    cdp('Network.loadingFinished', { requestId: 'r1', timestamp: 100.25, encodedDataLength: 321 });
    expect(inspector.snapshot(7)?.network).toEqual([
      {
        id: 'r1',
        epoch: 0,
        ts: 0,
        method: 'POST',
        url: 'http://localhost:5173/api/settings',
        kind: 'fetch',
        status: 500,
        statusText: 'Internal Server Error',
        failure: null,
        mimeType: 'application/json',
        encodedBytes: 321,
        durationMs: 250,
        fromCache: false,
        remoteAddress: '127.0.0.1:5173',
        requestHeaders: [['Content-Type', 'application/json']],
        responseHeaders: [['content-type', 'application/json']],
        hasPostData: true,
        postData: '{"a":1}',
      },
    ]);
  });

  it('loadingFailed: CORS и отмена; из кэша памяти — fromCache; WebSocket — вид websocket со статусом рукопожатия', () => {
    const { cdp, inspector } = setup();
    cdp('Network.requestWillBeSent', request('c', 'http://127.0.0.1:9/data'));
    cdp('Network.loadingFailed', {
      requestId: 'c',
      timestamp: 100.01,
      errorText: 'net::ERR_FAILED',
      corsErrorStatus: { corsError: 'MissingAllowOriginHeader', failedParameter: '' },
    });
    cdp('Network.requestWillBeSent', request('x', 'http://localhost:5173/abort'));
    cdp('Network.loadingFailed', { requestId: 'x', timestamp: 100.01, errorText: 'net::ERR_ABORTED', canceled: true });
    cdp('Network.requestWillBeSent', request('m', 'http://localhost:5173/logo.png', { type: 'Image' }));
    cdp('Network.requestServedFromCache', { requestId: 'm' });
    cdp('Network.webSocketCreated', { requestId: 'w', url: 'ws://localhost:5173/hmr' });
    cdp('Network.webSocketHandshakeResponseReceived', { requestId: 'w', timestamp: 1, response: { status: 101, statusText: 'Switching Protocols', headers: {} } });
    const byId = new Map((inspector.snapshot(7)?.network ?? []).map((entry) => [entry.id, entry]));
    expect(byId.get('c')).toMatchObject({ status: null, failure: { reason: 'cors', text: 'MissingAllowOriginHeader' }, durationMs: 10 });
    expect(byId.get('x')?.failure).toEqual({ reason: 'canceled', text: 'net::ERR_ABORTED' });
    expect(byId.get('m')).toMatchObject({ kind: 'image', fromCache: true });
    expect(byId.get('w')).toMatchObject({ kind: 'websocket', method: 'GET', url: 'ws://localhost:5173/hmr', status: 101 });
  });

  it('кольцо сети — 500 последних; ответ на вытесненный запрос не создаёт записи', () => {
    const { cdp, inspector } = setup();
    for (let n = 1; n <= DEVTOOLS_LIMITS.networkEntries + 3; n += 1) cdp('Network.requestWillBeSent', request(`r${n}`, `http://localhost:5173/${n}`));
    cdp('Network.responseReceived', { requestId: 'r1', response: { status: 200 } });
    const entries = inspector.snapshot(7)?.network ?? [];
    expect(entries).toHaveLength(DEVTOOLS_LIMITS.networkEntries);
    expect(entries[0]?.id).toBe('r4');
  });
});

describe('эпохи и поздний захват (спека 3.3; Фокус ревью 5)', () => {
  it('главный фрейм с новым документом — эпоха +1; подфрейм — нет', () => {
    const { cdp, inspector } = setup();
    cdp('Page.frameNavigated', { type: 'Navigation', frame: { id: 'S1', parentId: 'F1', loaderId: 'LS', url: 'http://ads.test/' } });
    expect(inspector.snapshot(7)?.epoch).toBe(0);
    cdp('Page.frameNavigated', mainFrame('L2'));
    expect(inspector.snapshot(7)?.epoch).toBe(1);
  });

  it('документ навигации и запросы его загрузки — в новой эпохе, хотя ушли до коммита; документ увиден — capture on', () => {
    const { cdp, inspector } = setup();
    cdp('Runtime.consoleAPICalled', log('old page'));
    cdp('Network.requestWillBeSent', request('old', 'http://localhost:5173/old.js', { loaderId: 'L1', type: 'Script' }));
    cdp('Network.requestWillBeSent', request('doc', 'http://localhost:5173/next', { loaderId: 'L2', type: 'Document' }));
    cdp('Page.frameNavigated', mainFrame('L2'));
    cdp('Runtime.consoleAPICalled', log('new page'));
    const snapshot = inspector.snapshot(7);
    expect(snapshot?.network.map((entry) => [entry.id, entry.epoch])).toEqual([
      ['old', 0],
      ['doc', 1],
    ]);
    expect(snapshot?.console.map((entry) => [entry.text, entry.epoch])).toEqual([
      ['old page', 0],
      ['new page', 1],
    ]);
    expect(snapshot?.capture).toBe('on');
  });

  it('документ не увиден — late; увиден — снова on; из bfcache и about:blank — capture прежний', () => {
    const { cdp, inspector } = setup();
    cdp('Page.frameNavigated', mainFrame('L9', 'http://localhost:5173/'));
    expect(inspector.snapshot(7)?.capture).toBe('late');
    cdp('Network.requestWillBeSent', request('doc', 'http://localhost:5173/', { loaderId: 'L10', type: 'Document' }));
    cdp('Page.frameNavigated', mainFrame('L10', 'http://localhost:5173/'));
    expect(inspector.snapshot(7)?.capture).toBe('on');
    cdp('Page.frameNavigated', mainFrame('L11', 'http://localhost:5173/back', { type: 'BackForwardCacheRestore' }));
    cdp('Page.frameNavigated', mainFrame('L12', 'about:blank'));
    expect(inspector.snapshot(7)).toMatchObject({ capture: 'on', epoch: 4 });
  });

  it('повтор сообщения в новой эпохе — новая запись, а не count', () => {
    const { cdp, inspector } = setup();
    cdp('Runtime.consoleAPICalled', log('x'));
    cdp('Page.frameNavigated', mainFrame('L2'));
    cdp('Runtime.consoleAPICalled', log('x'));
    expect(inspector.snapshot(7)?.console.map((entry) => [entry.epoch, entry.count])).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });
});
```

- [ ] **Шаг 2. Дописать падающие тесты** — пачки, команды, тело ответа, события.

```ts
describe('пачки окну (раздел 8; Фокус ревью 1)', () => {
  it('пачка — через 150 мс после первого изменения, не раньше; запрос, изменённый дважды, — одна запись', () => {
    const { cdp, clock, batches } = setup();
    cdp('Network.requestWillBeSent', request('r1', 'http://localhost:5173/api'));
    clock.tick(100);
    cdp('Network.responseReceived', { requestId: 'r1', type: 'Fetch', response: { status: 500, statusText: 'Internal Server Error', headers: {} } });
    expect(batches).toHaveLength(0);
    clock.tick(DEVTOOLS_LIMITS.batchMs - 100);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ webContentsId: 7, epoch: 0, capture: 'on', reset: false, console: [] });
    expect(batches[0]?.network.map((entry) => [entry.id, entry.status])).toEqual([['r1', 500]]);
  });

  it('Фокус ревью 1: 10 000 сообщений за 1 с → в окно ушло ≤ 7 пачек по ≤ 200 записей, в кольце 1000, у повторов count', () => {
    const { cdp, clock, inspector, batches } = setup();
    for (let ms = 0; ms < 1000; ms += 1) {
      for (let k = 0; k < 10; k += 1) {
        // Пары подряд одинаковые: 5000 разных сообщений, у каждого count 2.
        cdp('Runtime.consoleAPICalled', log(`message ${Math.floor((ms * 10 + k) / 2)}`));
      }
      clock.tick(1);
    }
    clock.tick(DEVTOOLS_LIMITS.batchMs);
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.length).toBeLessThanOrEqual(7);
    for (const batch of batches) expect(batch.console.length + batch.network.length).toBeLessThanOrEqual(DEVTOOLS_LIMITS.batchMax);
    const entries = inspector.snapshot(7)?.console ?? [];
    expect(entries).toHaveLength(DEVTOOLS_LIMITS.consoleEntries);
    expect(entries.every((entry) => entry.count === 2)).toBe(true);
    expect(entries.at(-1)?.text).toBe('message 4999');
  });

  it('без изменений пачек нет; отцепился — пачка с capture unavailable и без записей', () => {
    quietWarnings();
    const { dbg, clock, batches } = setup();
    clock.tick(1000);
    expect(batches).toHaveLength(0);
    dbg.emit('detach', {}, 'target closed');
    clock.tick(DEVTOOLS_LIMITS.batchMs);
    expect(batches).toEqual([{ webContentsId: 7, epoch: 0, capture: 'unavailable', reset: false, console: [], network: [] }]);
  });

  it('clear — журнал пуст, следующая пачка с reset; дальше — снова без reset', () => {
    const { cdp, clock, inspector, batches } = setup();
    cdp('Runtime.consoleAPICalled', log('a'));
    clock.tick(DEVTOOLS_LIMITS.batchMs);
    inspector.clear(7);
    expect(inspector.snapshot(7)).toMatchObject({ console: [], network: [] });
    clock.tick(DEVTOOLS_LIMITS.batchMs);
    expect(batches.at(-1)).toMatchObject({ reset: true, console: [], network: [] });
    cdp('Runtime.consoleAPICalled', log('b'));
    clock.tick(DEVTOOLS_LIMITS.batchMs);
    expect(batches.at(-1)?.reset).toBe(false);
    expect(batches.at(-1)?.console.map((entry) => entry.text)).toEqual(['b']);
  });
});

describe('команды CDP (спека 3.3)', () => {
  it('закрытый список этапа A; Runtime.evaluate и callFunctionOn в нём нет', () => {
    expect([...CDP_ALLOWED].sort()).toEqual(
      [
        'Emulation.clearDeviceMetricsOverride',
        'Emulation.setDeviceMetricsOverride',
        'Emulation.setTouchEmulationEnabled',
        'Emulation.setUserAgentOverride',
        'Log.disable',
        'Log.enable',
        'Network.disable',
        'Network.enable',
        'Network.getResponseBody',
        'Page.disable',
        'Page.enable',
        'Runtime.disable',
        'Runtime.enable',
      ].sort(),
    );
    expect(CDP_ALLOWED.has('Runtime.evaluate')).toBe(false);
    expect(CDP_ALLOWED.has('Runtime.callFunctionOn')).toBe(false);
  });

  it('send: команда вне списка — отказ без sendCommand; из списка — sendCommand и ответ', async () => {
    const { dbg, inspector } = setup();
    dbg.sendCommand.mockClear();
    await expect(inspector.send(7, 'Runtime.evaluate', { expression: '1' })).rejects.toThrow('CDP method not allowed: Runtime.evaluate');
    expect(dbg.sendCommand).not.toHaveBeenCalled();
    dbg.sendCommand.mockResolvedValueOnce({ ok: true });
    await expect(inspector.send(7, 'Emulation.clearDeviceMetricsOverride')).resolves.toEqual({ ok: true });
  });

  it('send к чужому или отцепившемуся гостю — отказ', async () => {
    quietWarnings();
    const { dbg, inspector } = setup();
    await expect(inspector.send(8, 'Page.enable')).rejects.toThrow('no browser guest: 8');
    dbg.emit('detach', {}, 'target closed');
    await expect(inspector.send(7, 'Page.enable')).rejects.toThrow('capture unavailable: 7');
  });
});

describe('тело ответа (спека 4.4)', () => {
  it('текст — как есть; длиннее предела — обрезан с truncated', async () => {
    const { dbg, inspector } = setup();
    dbg.sendCommand.mockImplementation(async (method) => (method === 'Network.getResponseBody' ? { body: '{"error":"db down"}', base64Encoded: false } : {}));
    await expect(inspector.responseBody(7, 'r1', 1000)).resolves.toEqual({ text: '{"error":"db down"}', base64: false, truncated: false });
    await expect(inspector.responseBody(7, 'r1', 5)).resolves.toEqual({ text: '{"err', base64: false, truncated: true });
    expect(dbg.sendCommand).toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'r1' });
  });

  it('base64 — предел в байтах: четыре знака на три байта', async () => {
    const { dbg, inspector } = setup();
    dbg.sendCommand.mockImplementation(async (method) => (method === 'Network.getResponseBody' ? { body: 'AAAAAAAAAAAA', base64Encoded: true } : {}));
    await expect(inspector.responseBody(7, 'img', 6)).resolves.toEqual({ text: 'AAAAAAAA', base64: true, truncated: true });
  });

  it('Chromium тело вытеснил, запрос неизвестен или гость чужой — null', async () => {
    const { dbg, inspector } = setup();
    dbg.sendCommand.mockImplementation(async (method) => {
      if (method === 'Network.getResponseBody') throw new Error('No resource with given identifier found');
      return {};
    });
    await expect(inspector.responseBody(7, 'gone', 1000)).resolves.toBeNull();
    await expect(inspector.responseBody(8, 'r1', 1000)).resolves.toBeNull();
  });
});

describe('события для этапов B и D', () => {
  it('onEvent: сырые params своего гостя и метода; отписка', () => {
    const { cdp, inspector } = setup();
    const listener = vi.fn<(params: unknown) => void>();
    const off = inspector.onEvent(7, 'Page.frameNavigated', listener);
    inspector.onEvent(8, 'Page.frameNavigated', vi.fn());
    cdp('Page.frameNavigated', mainFrame('L2'));
    cdp('Runtime.consoleAPICalled', log('x'));
    off();
    cdp('Page.frameNavigated', mainFrame('L3'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(mainFrame('L2'));
  });
});
```

  В тесте CORS длительность — 10 мс: `(100.01 − 100) × 1000`, округлено.

- [ ] **Шаг 3. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/main/browser/inspector.test.ts` → FAIL: `Failed to resolve import "./inspector.js"`.

- [ ] **Шаг 4. Реализовать.**

```ts
// packages/desktop/src/main/browser/inspector.ts
/**
 * Инспектор вкладок браузера (спека 2026-10-07-browser-devtools-agent-design.md, 3.3; индекс плана, «Общие имена»).
 *
 * `webContents.debugger` подключается к каждому гостю-браузеру на `web-contents-created` (`guard.ts`), пока гость
 * пуст (спайк 0.1, вариант D: `<webview>` стартует с `about:blank`, окно открывает адрес вкладки после `ready`):
 * `Runtime`, `Log`, `Page` и `Network` с буферами раздела 8. События переводит `cdp-entries.ts`; журнал — кольца на
 * вкладку (1000 сообщений, 500 запросов), одинаковые сообщения подряд — одна запись с `count`. Эпоха — номер документа
 * главного фрейма: растёт на `Page.frameNavigated` без `parentId`, и запросы с `loaderId` нового документа (сам
 * документ уходит до коммита) переходят в неё.
 *
 * Окну журнал идёт пачками (`onBatch`) не чаще раза в 150 мс и не больше 200 записей — сверх них самые свежие
 * изменения; остальное отдаёт `snapshot`. Команды CDP — только из `CDP_ALLOWED`, у каждой тайм-аут: без страницы
 * `enable` висит (проба 1.4). `ready` отвечает, когда все четыре `enable` отработали — ответом, отказом или
 * тайм-аутом. Не подключился или отцепился — `capture: 'unavailable'` и новая попытка на следующей навигации
 * главного фрейма.
 */
import type { WebContents } from 'electron';
import {
  DEVTOOLS_LIMITS,
  type CaptureState,
  type ConsoleEntry,
  type DevtoolsBatch,
  type DevtoolsSnapshot,
  type NetworkEntry,
  type ResponseBody,
} from '../../shared/browser-devtools.js';
import {
  clip,
  consoleFromApi,
  consoleFromException,
  consoleFromLog,
  failureOf,
  headerPairs,
  networkKind,
  postDataOf,
  remoteAddress,
  type ConsoleApiParams,
  type ConsoleDraft,
  type ExceptionParams,
  type LogParams,
} from './cdp-entries.js';

export type CdpMethod = string;

/**
 * Закрытый список команд CDP (спека 3.3). Этап A — включение доменов, тело ответа и эмуляция размера. Этап B добавит
 * DOM, Accessibility, снимки и `Runtime.callFunctionOn` с `REACT_INFO_FN`, этап C — тело запроса. `Runtime.evaluate`
 * здесь не бывает никогда.
 */
export const CDP_ALLOWED: ReadonlySet<CdpMethod> = new Set<CdpMethod>([
  'Runtime.enable',
  'Runtime.disable',
  'Log.enable',
  'Log.disable',
  'Page.enable',
  'Page.disable',
  'Network.enable',
  'Network.disable',
  'Network.getResponseBody',
  'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
  'Emulation.setTouchEmulationEnabled',
  'Emulation.setUserAgentOverride',
]);

/** Тайм-аут команды CDP (спайк 0.1): без страницы `enable` висит; дольше него `ready` страницу вкладки не держит. */
export const CDP_COMMAND_MS = 10_000;

export interface Inspector {
  attach(contents: WebContents): void;
  /**
   * Подключение закончено: все `enable` ответили, отказали или вышли по `CDP_COMMAND_MS` (спайк 0.1, вариант D).
   * Окно открывает адрес вкладки после этого. Журнала нет или гость уничтожен — готово сразу; не бросает.
   */
  ready(id: number): Promise<void>;
  snapshot(id: number): DevtoolsSnapshot | null;
  clear(id: number): void;
  responseBody(id: number, requestId: string, limit: number): Promise<ResponseBody | null>;
  send<T = unknown>(id: number, method: CdpMethod, params?: Record<string, unknown>): Promise<T>;
  onBatch(listener: (batch: DevtoolsBatch) => void): () => void;
  onEvent(id: number, method: string, listener: (params: unknown) => void): () => void;
}

interface NetRecord {
  entry: NetworkEntry;
  /** Документ запроса: по нему запрос переходит в эпоху нового документа. */
  loaderId: string;
  /** Монотонное время CDP начала, секунды: для длительности. */
  started: number;
}

interface Journal {
  id: number;
  attached: boolean;
  /** Все `enable` последнего подключения отработали; до подключения и после его отказа — уже готово. */
  ready: Promise<void>;
  epoch: number;
  capture: CaptureState;
  nextId: number;
  console: ConsoleEntry[];
  network: Map<string, NetRecord>;
  /** Изменённое с прошлой пачки: `c<id>` или `n<requestId>` → номер изменения. */
  pending: Map<string, number>;
  seq: number;
  reset: boolean;
  dirty: boolean;
  cancelFlush: (() => void) | null;
}

const ENABLE: ReadonlyArray<readonly [CdpMethod, Record<string, unknown>?]> = [
  ['Runtime.enable'],
  ['Log.enable'],
  ['Page.enable'],
  ['Network.enable', { maxResourceBufferSize: DEVTOOLS_LIMITS.resourceBuffer, maxTotalBufferSize: DEVTOOLS_LIMITS.totalBuffer }],
];

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

function isHttp(url: string | undefined): boolean {
  return url !== undefined && /^https?:/i.test(url);
}

function sameMessage(entry: ConsoleEntry, draft: ConsoleDraft): boolean {
  return (
    entry.level === draft.level &&
    entry.origin === draft.origin &&
    entry.text === draft.text &&
    entry.location?.url === draft.location?.url &&
    entry.location?.line === draft.location?.line &&
    entry.location?.column === draft.location?.column
  );
}

function durationOf(record: NetRecord, timestamp: unknown): number | null {
  const end = num(timestamp);
  return end === undefined || record.started <= 0 ? null : Math.max(0, Math.round((end - record.started) * 1000));
}

function respond(record: NetRecord, data: Record<string, unknown>): void {
  const response = fields(data.response);
  const entry = record.entry;
  entry.status = num(response.status) ?? null;
  entry.statusText = str(response.statusText) ?? '';
  entry.mimeType = str(response.mimeType) ?? null;
  entry.responseHeaders = headerPairs(response.headers);
  entry.remoteAddress = remoteAddress(response);
  entry.fromCache = entry.fromCache || response.fromDiskCache === true || response.fromPrefetchCache === true;
  const type = str(data.type);
  if (type !== undefined) entry.kind = networkKind(type);
}

export function createInspector(deps: {
  fromId(id: number): WebContents | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}): Inspector {
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): (() => void) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  const journals = new Map<number, Journal>();
  const batchListeners = new Set<(batch: DevtoolsBatch) => void>();
  const eventListeners = new Map<number, Map<string, Set<(params: unknown) => void>>>();

  function command<T>(contents: WebContents, method: CdpMethod, params?: Record<string, unknown>): Promise<T> {
    if (!CDP_ALLOWED.has(method)) return Promise.reject(new Error(`CDP method not allowed: ${method}`));
    return new Promise<T>((resolve, reject) => {
      const cancel = setTimer(() => reject(new Error(`CDP command timed out: ${method}`)), CDP_COMMAND_MS);
      contents.debugger.sendCommand(method, params).then(
        (result: unknown) => {
          cancel();
          resolve(result as T);
        },
        (error: unknown) => {
          cancel();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  function flush(journal: Journal): void {
    journal.cancelFlush = null;
    if (!journal.dirty) return;
    journal.dirty = false;
    // Сверх 200 — самые свежие изменения (Фокус ревью 1): окно не тонет в болтливой консоли, всё кольцо отдаёт snapshot.
    const keys = new Set(
      [...journal.pending.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(-DEVTOOLS_LIMITS.batchMax)
        .map(([key]) => key),
    );
    journal.pending.clear();
    const batch: DevtoolsBatch = {
      webContentsId: journal.id,
      epoch: journal.epoch,
      capture: journal.capture,
      reset: journal.reset,
      // Порядок колец: окно дописывает новые записи в конец.
      console: journal.console.filter((entry) => keys.has(`c${entry.id}`)).map((entry) => ({ ...entry })),
      network: [...journal.network.values()].filter((record) => keys.has(`n${record.entry.id}`)).map((record) => ({ ...record.entry })),
    };
    journal.reset = false;
    for (const listener of batchListeners) listener(batch);
  }

  function schedule(journal: Journal): void {
    journal.dirty = true;
    if (journal.cancelFlush !== null) return;
    journal.cancelFlush = setTimer(() => flush(journal), DEVTOOLS_LIMITS.batchMs);
  }

  function touch(journal: Journal, key: string): void {
    journal.seq += 1;
    journal.pending.set(key, journal.seq);
    schedule(journal);
  }

  function setCapture(journal: Journal, capture: CaptureState): void {
    if (journal.capture === capture) return;
    journal.capture = capture;
    schedule(journal);
  }

  function addConsole(journal: Journal, draft: ConsoleDraft | null): void {
    if (draft === null) return;
    const last = journal.console.at(-1);
    if (last !== undefined && last.epoch === journal.epoch && sameMessage(last, draft)) {
      last.count += 1;
      touch(journal, `c${last.id}`);
      return;
    }
    const entry: ConsoleEntry = { id: journal.nextId, epoch: journal.epoch, ts: now(), ...draft, count: 1 };
    journal.nextId += 1;
    journal.console.push(entry);
    if (journal.console.length > DEVTOOLS_LIMITS.consoleEntries) {
      journal.console.splice(0, journal.console.length - DEVTOOLS_LIMITS.consoleEntries);
    }
    touch(journal, `c${entry.id}`);
  }

  function startRequest(journal: Journal, data: Record<string, unknown>): void {
    const id = str(data.requestId);
    if (id === undefined) return;
    const request = fields(data.request);
    const previous = journal.network.get(id);
    const entry: NetworkEntry = {
      id,
      epoch: previous?.entry.epoch ?? journal.epoch,
      ts: previous?.entry.ts ?? now(),
      method: str(request.method) ?? 'GET',
      url: clip(str(request.url) ?? '', DEVTOOLS_LIMITS.url),
      kind: networkKind(data.type),
      status: null,
      statusText: '',
      failure: null,
      mimeType: null,
      encodedBytes: null,
      durationMs: null,
      fromCache: false,
      remoteAddress: null,
      requestHeaders: headerPairs(request.headers),
      responseHeaders: [],
      hasPostData: request.hasPostData === true || typeof request.postData === 'string',
      postData: postDataOf(request),
    };
    if (previous !== undefined) {
      // Редирект — тот же requestId: запись продолжается с новым адресом, ответ прежнего шага стирается.
      previous.entry = entry;
    } else {
      journal.network.set(id, { entry, loaderId: str(data.loaderId) ?? '', started: num(data.timestamp) ?? 0 });
      if (journal.network.size > DEVTOOLS_LIMITS.networkEntries) {
        const oldest = journal.network.keys().next();
        if (oldest.done !== true) journal.network.delete(oldest.value);
      }
    }
    touch(journal, `n${id}`);
  }

  function updateRequest(journal: Journal, data: Record<string, unknown>, change: (record: NetRecord) => void): void {
    const id = str(data.requestId);
    const record = id === undefined ? undefined : journal.network.get(id);
    if (record === undefined) return;
    change(record);
    touch(journal, `n${record.entry.id}`);
  }

  function navigated(journal: Journal, data: Record<string, unknown>): void {
    const frame = fields(data.frame);
    // Подфрейм эпоху не меняет; переход внутри документа сюда не приходит (Page.navigatedWithinDocument).
    if (data.frame === undefined || frame.parentId !== undefined) return;
    journal.epoch += 1;
    const loaderId = str(frame.loaderId);
    let sawDocument = false;
    for (const record of journal.network.values()) {
      if (loaderId === undefined || record.loaderId !== loaderId) continue;
      // Запрос документа уходит до коммита: он и запросы его загрузки — уже новая эпоха (Фокус ревью 5).
      record.entry.epoch = journal.epoch;
      if (record.entry.kind === 'document') sawDocument = true;
      touch(journal, `n${record.entry.id}`);
    }
    // Документ из bfcache приходит без запроса, about:blank — без сети: это не пропуск захвата.
    if (data.type !== 'BackForwardCacheRestore' && isHttp(str(frame.url))) setCapture(journal, sawDocument ? 'on' : 'late');
    schedule(journal);
  }

  function receive(journal: Journal, method: string, params: unknown): void {
    const data = fields(params);
    switch (method) {
      case 'Runtime.consoleAPICalled':
        addConsole(journal, consoleFromApi(data as ConsoleApiParams));
        break;
      case 'Runtime.exceptionThrown':
        addConsole(journal, consoleFromException(data as ExceptionParams));
        break;
      case 'Log.entryAdded':
        addConsole(journal, consoleFromLog(data as LogParams));
        break;
      case 'Page.frameNavigated':
        navigated(journal, data);
        break;
      case 'Network.requestWillBeSent':
        startRequest(journal, data);
        break;
      case 'Network.webSocketCreated':
        // У WebSocket своя пара событий; в журнале он — запрос вида websocket.
        startRequest(journal, { ...data, type: 'WebSocket', request: { url: data.url, method: 'GET' } });
        break;
      case 'Network.responseReceived':
      case 'Network.webSocketHandshakeResponseReceived':
        updateRequest(journal, data, (record) => respond(record, data));
        break;
      case 'Network.requestServedFromCache':
        updateRequest(journal, data, (record) => {
          record.entry.fromCache = true;
        });
        break;
      case 'Network.loadingFinished':
        updateRequest(journal, data, (record) => {
          record.entry.encodedBytes = num(data.encodedDataLength) ?? record.entry.encodedBytes;
          record.entry.durationMs = durationOf(record, data.timestamp);
        });
        break;
      case 'Network.loadingFailed':
        updateRequest(journal, data, (record) => {
          record.entry.failure = failureOf(data);
          record.entry.durationMs = durationOf(record, data.timestamp);
        });
        break;
      default:
        break;
    }
    const listeners = eventListeners.get(journal.id)?.get(method);
    if (listeners !== undefined) for (const listener of listeners) listener(params);
  }

  function connect(journal: Journal, contents: WebContents): void {
    try {
      contents.debugger.attach('1.3');
    } catch (error) {
      console.warn('[parley] devtools attach failed', error);
      setCapture(journal, 'unavailable');
      return;
    }
    journal.attached = true;
    // Первое подключение — к пустому гостю (адрес '' или about:blank): страница ещё не грузилась. Повторное — к
    // живой странице: её запросы до этого прошли мимо.
    const url = contents.getURL();
    setCapture(journal, url === '' || url === 'about:blank' ? 'on' : 'late');
    // Отказ и тайм-аут `enable` не бросают, а ставят `unavailable`: ready не должен держать страницу вкладки.
    journal.ready = Promise.all(
      ENABLE.map(([method, params]) =>
        command(contents, method, params).then(
          () => undefined,
          (error: unknown) => {
            console.warn(`[parley] devtools ${method} failed`, error);
            setCapture(journal, 'unavailable');
          },
        ),
      ),
    ).then(() => undefined);
  }

  function attach(contents: WebContents): void {
    if (journals.has(contents.id)) return;
    const journal: Journal = {
      id: contents.id,
      attached: false,
      ready: Promise.resolve(),
      epoch: 0,
      capture: 'on',
      nextId: 1,
      console: [],
      network: new Map(),
      pending: new Map(),
      seq: 0,
      reset: false,
      dirty: false,
      cancelFlush: null,
    };
    journals.set(contents.id, journal);
    contents.debugger.on('message', (_event, method: string, params: unknown) => receive(journal, method, params));
    contents.debugger.on('detach', (_event, reason: string) => {
      journal.attached = false;
      console.warn('[parley] devtools detached', reason);
      setCapture(journal, 'unavailable');
    });
    // Не подключился или отцепился — новая попытка на следующей навигации главного фрейма (спека 3.3).
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument && !journal.attached && !contents.isDestroyed()) connect(journal, contents);
    });
    contents.once('destroyed', () => {
      journal.cancelFlush?.();
      journals.delete(journal.id);
      eventListeners.delete(journal.id);
    });
    connect(journal, contents);
  }

  function live(id: number): WebContents | null {
    const contents = deps.fromId(id);
    return contents === null || contents.isDestroyed() ? null : contents;
  }

  return {
    attach,
    async ready(id) {
      await journals.get(id)?.ready;
    },
    snapshot(id) {
      const journal = journals.get(id);
      if (journal === undefined) return null;
      return {
        epoch: journal.epoch,
        capture: journal.capture,
        console: journal.console.map((entry) => ({ ...entry })),
        network: [...journal.network.values()].map((record) => ({ ...record.entry })),
      };
    },
    clear(id) {
      const journal = journals.get(id);
      if (journal === undefined) return;
      journal.console = [];
      journal.network.clear();
      journal.pending.clear();
      journal.reset = true;
      schedule(journal);
    },
    async responseBody(id, requestId, limit) {
      const contents = live(id);
      if (contents === null || journals.get(id)?.attached !== true) return null;
      try {
        const result = fields(await command(contents, 'Network.getResponseBody', { requestId }));
        if (typeof result.body !== 'string') return null;
        const base64 = result.base64Encoded === true;
        // Предел — в байтах тела: у base64 четыре знака на три байта.
        const max = base64 ? Math.floor(limit / 3) * 4 : limit;
        if (result.body.length <= max) return { text: result.body, base64, truncated: false };
        return { text: base64 ? result.body.slice(0, max) : clip(result.body, max), base64, truncated: true };
      } catch {
        // Chromium уже вытеснил тело из буфера, запрос ещё идёт или страница ушла — тела нет.
        return null;
      }
    },
    send<T>(id: number, method: CdpMethod, params?: Record<string, unknown>): Promise<T> {
      if (!CDP_ALLOWED.has(method)) return Promise.reject(new Error(`CDP method not allowed: ${method}`));
      const contents = live(id);
      if (contents === null) return Promise.reject(new Error(`no browser guest: ${id}`));
      if (journals.get(id)?.attached !== true) return Promise.reject(new Error(`capture unavailable: ${id}`));
      return command<T>(contents, method, params);
    },
    onBatch(listener) {
      batchListeners.add(listener);
      return () => {
        batchListeners.delete(listener);
      };
    },
    onEvent(id, method, listener) {
      const byMethod = eventListeners.get(id) ?? new Map<string, Set<(params: unknown) => void>>();
      eventListeners.set(id, byMethod);
      const listeners = byMethod.get(method) ?? new Set<(params: unknown) => void>();
      byMethod.set(method, listeners);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
```

- [ ] **Шаг 5. Запустить — проходит.** Команда шага 3 → PASS (30 тестов). Затем `pnpm --filter @parley/desktop typecheck` → без ошибок.

  Если `typecheck` не принимает слушателя `contents.on('did-start-navigation', (details) => …)`, сверить с `guard.ts`: там тот же обработчик читает `details.url` и `details.isMainFrame`. У `details` в Electron 44 есть и `isSameDocument`.

- [ ] **Шаг 6. Закоммитить.**

```bash
git add packages/desktop/src/main/browser/inspector.ts packages/desktop/src/main/browser/inspector.test.ts
git commit -m "feat(desktop): инспектор CDP вкладок браузера — журнал консоли и сети, эпохи, пачки окну, ready" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 5. Инспектор у гостя и пачки окну

Инспектор подключается к гостю из стража, первым его обработчиком. Пачки идут окну-хозяину гостя тем же путём, что `browser:favicon` и `browser:open-tab`. Страж пускает `<webview>` с `src` `about:blank` (спайк 0.1, вариант D) и убирает из истории гостя пустую первую запись.

**Файлы:**
- Изменить:
  - `packages/desktop/src/main/browser/guard.ts` — зависимость `inspect`;
  - `packages/desktop/src/main/browser/inspector.ts` — `forwardBatches`;
  - `packages/desktop/src/main/index.ts`.
- Тесты: `packages/desktop/src/main/browser/guard.test.ts`, `packages/desktop/src/main/browser/inspector.test.ts`

**Интерфейсы:**
- Берёт: `createInspector`, `Inspector` (задача 4); `installBrowserGuard`, `guardGuest` (`guard.ts`).
- Отдаёт:
  - `BrowserGuardDeps.inspect(contents: WebContents): void`;
  - `forwardBatches(inspector: Pick<Inspector, 'onBatch'>, fromId: (id: number) => WebContents | null): () => void` — событие `browser:devtools` с `DevtoolsBatch`;
  - `sanitizeWebviewAttach` пускает `src` `about:blank` (точное совпадение) наравне с http(s); страж убирает пустую первую запись истории гостя.

- [ ] **Шаг 1. Написать падающие тесты.**

  В `guard.test.ts`, функция `setupGuard`:
  - перед `const install = …` добавить `const inspect = vi.fn<(contents: WebContents) => void>();`;
  - в объект `installBrowserGuard({ … })` после `fetchFavicon,` — строку `inspect,`;
  - в возвращаемый объект после `fetchFavicon,` — тоже `inspect,`.

  В `guard.test.ts` ещё две правки под вариант D (спайк 0.1):
  - в `describe('sanitizeWebviewAttach (тест 3)')` из теста «чужой partition, без partition, src file:, пустой и не-http — false» убрать строку
    `expect(sanitizeWebviewAttach(evil(), { partition: BROWSER_PARTITION, src: 'about:blank' })).toBe(false);` — теперь такой `src` прикрепляется. После этого теста добавить:

```ts
  it('спайк 0.1, вариант D: src about:blank прикрепляется; about:blank с хвостом, about:srcdoc, data:, blob: и чужой раздел — нет', () => {
    expect(sanitizeWebviewAttach(evil(), { partition: BROWSER_PARTITION, src: 'about:blank' })).toBe(true);
    for (const src of ['about:blank#x', 'about:blank?x', 'about:srcdoc', 'data:text/html,x', 'blob:https://x/1']) {
      expect(sanitizeWebviewAttach(evil(), { partition: BROWSER_PARTITION, src }), src).toBe(false);
    }
    expect(sanitizeWebviewAttach(evil(), { partition: 'persist:other', src: 'about:blank' })).toBe(false);
  });
```

  - в `fakeContents` перед `const contents = Object.assign(emitter, {` добавить `const historyUrls = ['about:blank'];` — история гостя; одной записи страж не трогает. В объект после `hostWebContents: { send: vi.fn() },`:

```ts
    historyUrls,
    navigationHistory: {
      length: vi.fn(() => historyUrls.length),
      getEntryAtIndex: vi.fn((index: number) => ({ url: historyUrls[index] ?? '', title: '' })),
      removeEntryAtIndex: vi.fn((index: number) => historyUrls.splice(index, 1).length === 1),
    },
```

  В конец файла:

```ts
describe('журнал гостя (спека 2026-10-07, 3.3)', () => {
  it('гость — inspect(contents) один раз и раньше прочих обработчиков; окно и DevTools — нет', () => {
    const guard = setupGuard();
    const guest = fakeContents(42, 'webview');
    guard.created(guest);
    expect(guard.inspect).toHaveBeenCalledTimes(1);
    expect(guard.inspect).toHaveBeenCalledWith(guest);
    // До первой загрузки (спайк 0.1): раньше setWindowOpenHandler и навигации.
    expect(guard.inspect.mock.invocationCallOrder[0]).toBeLessThan(guest.setWindowOpenHandler.mock.invocationCallOrder[0] ?? 0);
    guard.created(fakeContents(43, 'remote'));
    guard.created(fakeContents(1, 'window'));
    expect(guard.inspect).toHaveBeenCalledTimes(1);
  });
});

describe('пустая запись истории гостя (спайк 0.1, вариант D; Фокус ревью 6)', () => {
  function guestWith(urls: string[]) {
    const guard = setupGuard();
    const guest = fakeContents(42, 'webview');
    guest.historyUrls.splice(0, guest.historyUrls.length, ...urls);
    guard.created(guest);
    return guest;
  }

  it('первая страница после about:blank: пустая запись убрана, и только один раз', () => {
    const guest = guestWith(['about:blank', 'http://127.0.0.1:5173/']);
    guest.emit('did-navigate', fakeEvent(), 'about:blank');
    expect(guest.navigationHistory.removeEntryAtIndex).not.toHaveBeenCalled();
    guest.emit('did-navigate', fakeEvent(), 'http://127.0.0.1:5173/');
    expect(guest.navigationHistory.removeEntryAtIndex).toHaveBeenCalledWith(0);
    expect(guest.historyUrls).toEqual(['http://127.0.0.1:5173/']);
    guest.historyUrls.unshift('about:blank');
    guest.emit('did-navigate', fakeEvent(), 'http://127.0.0.1:5173/next');
    expect(guest.navigationHistory.removeEntryAtIndex).toHaveBeenCalledTimes(1);
  });

  it('страница не загрузилась (did-fail-load главного фрейма) — запись тоже убрана; подфрейм — нет', () => {
    const guest = guestWith(['about:blank', 'http://127.0.0.1:5173/']);
    guest.emit('did-fail-load', fakeEvent(), -102, 'ERR_CONNECTION_REFUSED', 'http://ads.test/', false);
    expect(guest.navigationHistory.removeEntryAtIndex).not.toHaveBeenCalled();
    guest.emit('did-fail-load', fakeEvent(), -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:5173/', true);
    expect(guest.navigationHistory.removeEntryAtIndex).toHaveBeenCalledWith(0);
  });

  it('записи страницы ещё нет — ждёт её; первая запись не пустая (восстановленная история) — историю не трогает', () => {
    const early = guestWith(['about:blank']);
    early.emit('did-fail-load', fakeEvent(), -3, 'ERR_ABORTED', 'http://127.0.0.1:5173/', true);
    expect(early.navigationHistory.removeEntryAtIndex).not.toHaveBeenCalled();
    early.historyUrls.push('http://127.0.0.1:5173/');
    early.emit('did-navigate', fakeEvent(), 'http://127.0.0.1:5173/');
    expect(early.navigationHistory.removeEntryAtIndex).toHaveBeenCalledWith(0);

    const restored = guestWith(['http://127.0.0.1:5173/a', 'http://127.0.0.1:5173/b']);
    restored.emit('did-navigate', fakeEvent(), 'http://127.0.0.1:5173/b');
    expect(restored.navigationHistory.removeEntryAtIndex).not.toHaveBeenCalled();
  });
});
```

  В `inspector.test.ts`: импорт `forwardBatches` из `./inspector.js` и в конец файла:

```ts
describe('forwardBatches (пачки окну-хозяину гостя)', () => {
  it('пачка — событием browser:devtools окну-хозяину своего гостя; чужой и мёртвый гость — никуда', () => {
    const listeners: Array<(batch: DevtoolsBatch) => void> = [];
    const send = vi.fn<(channel: string, batch: DevtoolsBatch) => void>();
    const guest = { isDestroyed: vi.fn(() => false), hostWebContents: { send } };
    const off = forwardBatches(
      {
        onBatch: (listener) => {
          listeners.push(listener);
          return () => {};
        },
      },
      (id) => (id === 7 ? (guest as unknown as WebContents) : null),
    );
    const batch: DevtoolsBatch = { webContentsId: 7, epoch: 1, capture: 'on', reset: false, console: [], network: [] };
    listeners[0]?.(batch);
    expect(send).toHaveBeenCalledWith('browser:devtools', batch);
    listeners[0]?.({ ...batch, webContentsId: 8 });
    guest.isDestroyed.mockReturnValue(true);
    listeners[0]?.(batch);
    expect(send).toHaveBeenCalledTimes(1);
    expect(typeof off).toBe('function');
  });
});
```

- [ ] **Шаг 2. Запустить — падает.**

  `pnpm --filter @parley/desktop exec vitest run src/main/browser/guard.test.ts src/main/browser/inspector.test.ts` → FAIL: `deps.inspect` не зовётся, `forwardBatches` не экспортирован, `about:blank` не прикрепляется, пустая запись истории не убирается.

- [ ] **Шаг 3. Реализовать.**
  - **`guard.ts`:**
    - в `interface BrowserGuardDeps` после `fetchFavicon(...)` добавить:

```ts
  /** Журнал консоли и сети гостя (спека 2026-10-07-browser-devtools-agent-design.md, 3.3): index.ts — `inspector.attach`. */
  inspect(contents: WebContents): void;
```

    - у `guardGuest` второй параметр — `deps: Pick<BrowserGuardDeps, 'openTab' | 'forwardShortcuts' | 'fetchFavicon' | 'inspect'>`;
    - первой строкой тела `guardGuest`, до `contents.setWindowOpenHandler(...)`, добавить:

```ts
  // Журнал консоли и сети — первым: до первой загрузки гостя, иначе её запросы и ранние сообщения прошли бы мимо
  // (спайк 0.1).
  deps.inspect(contents);
```

    - вариант D (спайк 0.1): рядом с `isHttpUrl` добавить `const BLANK_PAGE = 'about:blank';`, а в конце `sanitizeWebviewAttach` комментарий и последнюю строку заменить:

```ts
  // Пустого src не бывает: <webview> монтируется с about:blank (вариант D: страницу вкладки окно открывает после
  // включения журнала) или с адресом http(s) (9.2a). Точное совпадение: about:blank#x и прочее — отказ.
  return params.partition === BROWSER_PARTITION && (params.src === BLANK_PAGE || isHttpUrl(params.src));
```

    - в `setWindowOpenHandler` комментарий «about:blank вкладки не открывает: …» заменить на `// about:blank вкладки не открывает: вкладка без адреса http(s) — заглушка, а не страница.`; поведение то же;
    - в `guardGuest` перед комментарием «Favicon качает main (9.2a)…» убрать пустую запись истории:

```ts
  // Вариант D (спайк 0.1): гость стартует с about:blank, и первая страница ложится в историю второй записью — «назад»
  // вело бы в пустую страницу. Первая загрузка главного фрейма, состоявшаяся или нет, убирает пустую запись
  // (проверено на Electron 44.4.5: `canGoBack` после этого false). Записи страницы ещё нет — ждём следующего события.
  let blankPruned = false;
  const pruneBlankEntry = (): void => {
    if (blankPruned) return;
    const history = contents.navigationHistory;
    if (history.length() < 2) return;
    blankPruned = true;
    if (history.getEntryAtIndex(0).url === BLANK_PAGE) history.removeEntryAtIndex(0);
  };
  contents.on('did-navigate', (_event, url) => {
    if (url !== BLANK_PAGE) pruneBlankEntry();
  });
  contents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame) pruneBlankEntry();
  });
```

  - **`inspector.ts`** — в конец файла:

```ts
/** Пачки — окну-хозяину гостя событием `browser:devtools`, как favicon и `browser:open-tab` (`guard.ts`). */
export function forwardBatches(inspector: Pick<Inspector, 'onBatch'>, fromId: (id: number) => WebContents | null): () => void {
  return inspector.onBatch((batch) => {
    const guest = fromId(batch.webContentsId);
    if (guest === null || guest.isDestroyed()) return;
    guest.hostWebContents?.send('browser:devtools', batch);
  });
}
```

  - **`main/index.ts`:**
    - импорт после строки `import { installBrowserGuard, promptDownload } from './browser/guard.js';`:

```ts
import { createInspector, forwardBatches } from './browser/inspector.js';
```

    - сразу после блока `const designMode = createDesignMode({ … });`:

```ts
    // Журнал консоли и сети вкладок браузера (спека 2026-10-07-browser-devtools-agent-design.md, 3.3): инспектор CDP на
    // каждого гостя — до стража, тот подключает гостя на web-contents-created. Пачки — окну-хозяину гостя.
    const inspector = createInspector({ fromId: (id) => webContents.fromId(id) ?? null });
    forwardBatches(inspector, (id) => webContents.fromId(id) ?? null);
```

    - в объекте `installBrowserGuard({ … })` после `fetchFavicon: …,`:

```ts
      inspect: (contents) => inspector.attach(contents),
```

- [ ] **Шаг 4. Запустить — проходит.**
  - Команда шага 2 → PASS.
  - `pnpm --filter @parley/desktop typecheck` → без ошибок.
  - `pnpm --filter @parley/desktop test` → зелёный, прочие тесты стража не сломаны.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/main/browser/guard.ts packages/desktop/src/main/browser/guard.test.ts packages/desktop/src/main/browser/inspector.ts packages/desktop/src/main/browser/inspector.test.ts packages/desktop/src/main/index.ts
git commit -m "feat(desktop): инспектор подключается к гостю из стража, пачки журнала — окну-хозяину; страж пускает about:blank и убирает пустую запись истории" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 6. Эмуляция размеров

**Файлы:**
- Создать: `packages/desktop/src/main/browser/emulation.ts`
- Тест: `packages/desktop/src/main/browser/emulation.test.ts`

**Интерфейсы:**
- Берёт: `Inspector.send`, `CdpMethod` (задача 4); `viewportSize`, `MOBILE_USER_AGENT`, `ViewportSpec` (задача 2).
- Отдаёт:
  - контракт индекса: `viewportCommands(spec, area) → { commands, scale }`, `Emulation { set, current }`, `createEmulation(deps)`;
  - сверх индекса: `ViewportArea`, `EmulationCommand`.
- `withTemporary` здесь нет: его добавляет этап C. Для возврата прежнего размера `state` хранит у вкладки и размер, и поле.

- [ ] **Шаг 1. Написать падающий тест.**

```ts
// packages/desktop/src/main/browser/emulation.test.ts
import { describe, expect, it, vi } from 'vitest';
import { MOBILE_USER_AGENT, type ViewportSpec } from '../../shared/browser-devtools.js';
import { createEmulation, viewportCommands } from './emulation.js';

const MOBILE_M: ViewportSpec = { preset: 'mobile-m', rotated: false, dpr: 2 };
const AREA = { width: 800, height: 600 };

describe('viewportCommands (спека 4.2, спайк 0.3 — механизм cdp)', () => {
  it('Fit — эмуляция, касания и подмена UA сняты; scale 1', () => {
    expect(viewportCommands(null, AREA)).toEqual({
      commands: [
        { method: 'Emulation.clearDeviceMetricsOverride', params: {} },
        { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: false } },
        { method: 'Emulation.setUserAgentOverride', params: { userAgent: '' } },
      ],
      scale: 1,
    });
  });

  it('Mobile M 2x в поле 800×600 — 375×812 со scale по высоте, касания, мобильный UA', () => {
    const scale = 600 / 812;
    expect(viewportCommands(MOBILE_M, AREA)).toEqual({
      commands: [
        { method: 'Emulation.setDeviceMetricsOverride', params: { width: 375, height: 812, deviceScaleFactor: 2, mobile: true, scale } },
        { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: true, maxTouchPoints: 5 } },
        { method: 'Emulation.setUserAgentOverride', params: { userAgent: MOBILE_USER_AGENT } },
      ],
      scale,
    });
  });

  it('Laptop в большом поле — scale 1, без касаний и мобильного UA', () => {
    expect(viewportCommands({ preset: 'laptop', rotated: false, dpr: 1 }, { width: 1600, height: 1000 })).toEqual({
      commands: [
        { method: 'Emulation.setDeviceMetricsOverride', params: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, scale: 1 } },
        { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: false } },
        { method: 'Emulation.setUserAgentOverride', params: { userAgent: '' } },
      ],
      scale: 1,
    });
  });

  it('повёрнутый пресет и свой размер — их ширина и высота', () => {
    expect(viewportCommands({ preset: 'mobile-m', rotated: true, dpr: 3 }, { width: 2000, height: 2000 }).commands[0]?.params).toMatchObject({
      width: 812,
      height: 375,
      deviceScaleFactor: 3,
    });
    expect(viewportCommands({ width: 1024, height: 700, mobile: false, dpr: 2 }, { width: 512, height: 700 }).scale).toBe(0.5);
  });

  it('поле нулевое — scale 1, а не 0', () => {
    expect(viewportCommands(MOBILE_M, { width: 0, height: 0 }).scale).toBe(1);
  });
});

describe('createEmulation', () => {
  it('set — команды по порядку через инспектор; current — размер вкладки; null — снят', async () => {
    const send = vi.fn<(id: number, method: string, params?: Record<string, unknown>) => Promise<unknown>>(async () => ({}));
    const emulation = createEmulation({ inspector: { send } });
    await expect(emulation.set(7, MOBILE_M, AREA)).resolves.toEqual({ scale: 600 / 812 });
    expect(send.mock.calls.map(([id, method]) => [id, method])).toEqual([
      [7, 'Emulation.setDeviceMetricsOverride'],
      [7, 'Emulation.setTouchEmulationEnabled'],
      [7, 'Emulation.setUserAgentOverride'],
    ]);
    expect(emulation.current(7)).toEqual(MOBILE_M);
    await emulation.set(7, null, AREA);
    expect(emulation.current(7)).toBeNull();
  });

  it('отказ инспектора — отказ set; прежний размер остаётся', async () => {
    const send = vi.fn<(id: number, method: string, params?: Record<string, unknown>) => Promise<unknown>>(async () => ({}));
    const emulation = createEmulation({ inspector: { send } });
    await emulation.set(7, MOBILE_M, AREA);
    send.mockRejectedValueOnce(new Error('capture unavailable: 7'));
    await expect(emulation.set(7, null, AREA)).rejects.toThrow('capture unavailable: 7');
    expect(emulation.current(7)).toEqual(MOBILE_M);
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/main/browser/emulation.test.ts` → FAIL: `Failed to resolve import "./emulation.js"`.

- [ ] **Шаг 3. Реализовать.**

```ts
// packages/desktop/src/main/browser/emulation.ts
/**
 * Размер вьюпорта вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, 4.2; спайк 0.3 — механизм
 * `cdp`): `Emulation.setDeviceMetricsOverride` со `scale` для вписывания в поле, касания и мобильный UA. Команды
 * идут через инспектор — его закрытый список и тайм-аут. Окно ставит `<webview>` размером ширина×scale на
 * высота×scale по центру поля страницы.
 *
 * Эмуляция переживает `reload`, переход на другой origin и `goBack` (спайк 0.3, 3 из 3): повтор команд не нужен.
 * Касания включаются только с новым документом — окно предлагает «Reload to apply touch». Размер картинки со
 * страницы при эмуляции — размер вида × DPR, а не размер на экране: `scale` его не уменьшает (Mobile M 2x даёт
 * 750×1624). Это пригодится снимку этапа C.
 *
 * Этап C добавит `withTemporary` (снимок агента в другом размере): размер и поле вкладки для возврата лежат в `state`.
 */
import { MOBILE_USER_AGENT, viewportSize, type ViewportSpec } from '../../shared/browser-devtools.js';
import type { CdpMethod, Inspector } from './inspector.js';

/** Место под страницу в поле вкладки, CSS-пиксели окна. */
export interface ViewportArea {
  width: number;
  height: number;
}

export interface EmulationCommand {
  method: CdpMethod;
  params: Record<string, unknown>;
}

/** Точек касания у мобильной эмуляции — как у пресетов Chrome. */
const TOUCH_POINTS = 5;

/** Команды CDP для размера; `null` — Fit: эмуляция, касания и подмена UA сняты. `scale` — вписывание, не больше 1. */
export function viewportCommands(spec: ViewportSpec | null, area: ViewportArea): { commands: EmulationCommand[]; scale: number } {
  if (spec === null) {
    return {
      commands: [
        { method: 'Emulation.clearDeviceMetricsOverride', params: {} },
        { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: false } },
        // Пустая строка снимает подмену UA.
        { method: 'Emulation.setUserAgentOverride', params: { userAgent: '' } },
      ],
      scale: 1,
    };
  }
  const size = viewportSize(spec);
  const fit = Math.min(1, area.width / size.width, area.height / size.height);
  // Поле ещё не измерено (нулевое) — без уменьшения: scale 0 спрятал бы страницу.
  const scale = Number.isFinite(fit) && fit > 0 ? fit : 1;
  return {
    commands: [
      {
        method: 'Emulation.setDeviceMetricsOverride',
        params: { width: size.width, height: size.height, deviceScaleFactor: size.dpr, mobile: size.mobile, scale },
      },
      {
        method: 'Emulation.setTouchEmulationEnabled',
        params: size.mobile ? { enabled: true, maxTouchPoints: TOUCH_POINTS } : { enabled: false },
      },
      { method: 'Emulation.setUserAgentOverride', params: { userAgent: size.mobile ? MOBILE_USER_AGENT : '' } },
    ],
    scale,
  };
}

export interface Emulation {
  set(id: number, spec: ViewportSpec | null, area: ViewportArea): Promise<{ scale: number }>;
  current(id: number): ViewportSpec | null;
}

export function createEmulation(deps: { inspector: Pick<Inspector, 'send'> }): Emulation {
  const state = new Map<number, { spec: ViewportSpec; area: ViewportArea }>();
  return {
    async set(id, spec, area) {
      const { commands, scale } = viewportCommands(spec, area);
      // По одной и по порядку. Отказ — отказ set; прежний размер остаётся в state.
      for (const { method, params } of commands) await deps.inspector.send(id, method, params);
      if (spec === null) state.delete(id);
      else state.set(id, { spec, area });
      return { scale };
    },
    current: (id) => state.get(id)?.spec ?? null,
  };
}
```

- [ ] **Шаг 4. Запустить — проходит.** Команда шага 2 → PASS (7 тестов). Затем `pnpm --filter @parley/desktop typecheck` → без ошибок.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/main/browser/emulation.ts packages/desktop/src/main/browser/emulation.test.ts
git commit -m "feat(desktop): эмуляция размеров вкладки браузера через CDP" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 7. Мост окна и каналы IPC

**Файлы:**
- Изменить:
  - `packages/desktop/src/shared/browser-types.ts` (`BrowserApi`);
  - `packages/desktop/src/main/ipc.ts` (`RegisterIpcOptions.browser`, пять каналов);
  - `packages/desktop/src/preload/index.ts`;
  - `packages/desktop/src/renderer/test-utils/fake-bridge.ts`;
  - `packages/desktop/src/main/index.ts`.
- Тесты: `packages/desktop/src/main/ipc.test.ts`, `packages/desktop/src/preload/index.test.ts`

**Интерфейсы:**
- Берёт: `Inspector`, `createInspector` (задачи 4, 5); `Emulation`, `createEmulation` (задача 6); `isViewportSpec`, `DEVTOOLS_LIMITS` и типы (задача 2); `browserGuest`, `withIpcError` (`main/ipc.ts`), `HostError` (`main/host-connection.ts`).
- Отдаёт:
  - **Мост и каналы (индекс):**

    | Метод `bridge.browser` | Канал |
    |---|---|
    | `devtoolsSnapshot(id): Promise<DevtoolsSnapshot>` | `browser:devtools-snapshot` |
    | `devtoolsClear(id): Promise<void>` | `browser:devtools-clear` |
    | `responseBody(id, requestId): Promise<ResponseBody \| null>` | `browser:response-body` |
    | `onDevtools(listener): () => void` | событие `browser:devtools` |
    | `setViewport(id, spec, area): Promise<{ scale: number }>` | `browser:set-viewport` |
    | `devtoolsReady(id): Promise<void>` — сверх индекса, спайк 0.1 (вариант D); «Расхождения с индексом», п. 10 | `browser:devtools-ready` |

  - **`RegisterIpcOptions.browser`** — поля `inspector: Pick<Inspector, 'snapshot' | 'clear' | 'responseBody' | 'ready'>` и `emulation: Pick<Emulation, 'set'>`.
  - **`FakeBridge`:**
    - `setDevtoolsSnapshot(snapshot)`, `emitDevtools(batch)`, `setResponseBody(answer)`, `setViewportScale(scale)`, `setDevtoolsReady(answer)`;
    - вызовы `devtoolsSnapshot`, `devtoolsClear`, `devtoolsReady`, `responseBody` и `setViewport` пишутся в `browserCalls`.

- [ ] **Шаг 1. Написать падающие тесты.**

  В `ipc.test.ts`:
  - импорт `import type { DevtoolsSnapshot, ResponseBody, ViewportSpec } from '../shared/browser-devtools.js';`;
  - после константы `designMode`:

```ts
/** Журнал и эмуляция моста (спека 2026-10-07, 3.5): подменены — мост проверяет гостя и аргументы. */
const inspector = {
  snapshot: vi.fn<(id: number) => DevtoolsSnapshot | null>(() => null),
  clear: vi.fn<(id: number) => void>(),
  ready: vi.fn<(id: number) => Promise<void>>(async () => {}),
  responseBody: vi.fn<(id: number, requestId: string, limit: number) => Promise<ResponseBody | null>>(async () => null),
};
const emulation = {
  set: vi.fn<(id: number, spec: ViewportSpec | null, area: { width: number; height: number }) => Promise<{ scale: number }>>(async () => ({
    scale: 0.5,
  })),
};
```

  - в `setup()`, в `registerIpc({ … browser: { … } })`, после `designMode,` — `inspector,` и `emulation,`;
  - в конец `describe('мост browser:* (тест 8 куска 9.1)', …)`:

```ts
  it('devtools-snapshot, devtools-clear и devtools-ready (спека 2026-10-07, 3.5; спайк 0.1): не гость раздела — bad_request; без журнала — unavailable', async () => {
    inspector.snapshot.mockClear();
    inspector.clear.mockClear();
    inspector.ready.mockClear();
    const { ipcMain } = browserSetup();
    for (const id of [1, 404, 8, 9, 7.5, '7', null]) {
      expect(await codeOf(ipcMain.invoke('browser:devtools-snapshot', id)), String(id)).toBe('bad_request');
      expect(await codeOf(ipcMain.invoke('browser:devtools-clear', id)), String(id)).toBe('bad_request');
      expect(await codeOf(ipcMain.invoke('browser:devtools-ready', id)), String(id)).toBe('bad_request');
    }
    expect(inspector.snapshot).not.toHaveBeenCalled();
    expect(inspector.ready).not.toHaveBeenCalled();
    expect(await ipcMain.invoke('browser:devtools-snapshot', 7)).toEqual({ epoch: 0, capture: 'unavailable', console: [], network: [] });
    const journal: DevtoolsSnapshot = { epoch: 2, capture: 'late', console: [], network: [] };
    inspector.snapshot.mockReturnValueOnce(journal);
    expect(await ipcMain.invoke('browser:devtools-snapshot', 7)).toEqual(journal);
    expect(inspector.snapshot).toHaveBeenLastCalledWith(7);
    await ipcMain.invoke('browser:devtools-clear', 7);
    expect(inspector.clear).toHaveBeenCalledWith(7);
    await ipcMain.invoke('browser:devtools-ready', 7);
    expect(inspector.ready).toHaveBeenCalledWith(7);
  });

  it('response-body: requestId — непустая строка до 256 знаков; предел тела — 1 МБ', async () => {
    inspector.responseBody.mockClear();
    const { ipcMain } = browserSetup();
    for (const requestId of ['', 'r'.repeat(257), 42, null]) {
      expect(await codeOf(ipcMain.invoke('browser:response-body', 7, requestId)), String(requestId)).toBe('bad_request');
    }
    expect(await codeOf(ipcMain.invoke('browser:response-body', 1, '1.2'))).toBe('bad_request');
    expect(inspector.responseBody).not.toHaveBeenCalled();
    inspector.responseBody.mockResolvedValueOnce({ text: '{}', base64: false, truncated: false });
    expect(await ipcMain.invoke('browser:response-body', 7, '1.2')).toEqual({ text: '{}', base64: false, truncated: false });
    expect(inspector.responseBody).toHaveBeenCalledWith(7, '1.2', 1_048_576);
  });

  it('set-viewport: размер — null или верный ViewportSpec, поле — положительные конечные числа; ответ — scale', async () => {
    emulation.set.mockClear();
    const { ipcMain } = browserSetup();
    const area = { width: 800, height: 600 };
    const bad: Array<[unknown, unknown]> = [
      [{ preset: 'phone', rotated: false, dpr: 2 }, area],
      [{ preset: 'mobile-m', rotated: false, dpr: 4 }, area],
      [{ width: 100, height: 600, mobile: false, dpr: 1 }, area],
      [{ preset: 'mobile-m', rotated: false, dpr: 2 }, { width: 0, height: 600 }],
      [null, { width: Number.NaN, height: 600 }],
      [null, null],
    ];
    for (const [spec, size] of bad) {
      expect(await codeOf(ipcMain.invoke('browser:set-viewport', 7, spec, size)), JSON.stringify([spec, size])).toBe('bad_request');
    }
    expect(await codeOf(ipcMain.invoke('browser:set-viewport', 1, null, area))).toBe('bad_request');
    expect(emulation.set).not.toHaveBeenCalled();
    const mobile = { preset: 'mobile-m', rotated: false, dpr: 2 };
    expect(await ipcMain.invoke('browser:set-viewport', 7, mobile, area)).toEqual({ scale: 0.5 });
    expect(emulation.set).toHaveBeenLastCalledWith(7, mobile, area);
    await ipcMain.invoke('browser:set-viewport', 7, null, area);
    expect(emulation.set).toHaveBeenLastCalledWith(7, null, area);
  });
```

  В `preload/index.test.ts`, в конец `describe('preload: последний статус и тема', …)`:

```ts
  it('browser.onDevtools: пачка приходит подписчику, отписка снимает его (спека 2026-10-07, 3.5)', async () => {
    const bridge = await loadPreload();
    const listener = vi.fn();
    const off = bridge.browser.onDevtools(listener);
    const batch = { webContentsId: 7, epoch: 0, capture: 'on', reset: false, console: [], network: [] };
    emit('browser:devtools', batch);
    off();
    emit('browser:devtools', batch);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(batch);
  });
```

- [ ] **Шаг 2. Запустить — падает.**

  `pnpm --filter @parley/desktop exec vitest run src/main/ipc.test.ts src/preload/index.test.ts` → FAIL: `нет обработчика для browser:devtools-snapshot`, `bridge.browser.onDevtools is not a function`.

- [ ] **Шаг 3. Реализовать.**
  - **`shared/browser-types.ts`:**
    - импорт `import type { DevtoolsBatch, DevtoolsSnapshot, ResponseBody, ViewportSpec } from './browser-devtools.js';`;
    - в конец `interface BrowserApi`:

```ts
  /**
   * Журнал консоли и сети гостя (спека 2026-10-07-browser-devtools-agent-design.md, 3.5). Журнала нет (захват не
   * подключался) — пустой с `capture: 'unavailable'`.
   */
  devtoolsSnapshot(webContentsId: number): Promise<DevtoolsSnapshot>;
  devtoolsClear(webContentsId: number): Promise<void>;
  /**
   * Захват включён (спайк 0.1, вариант D): все `enable` ответили, отказали или вышли по тайм-ауту. `<webview>` стартует
   * с about:blank; окно зовёт это на его первый `dom-ready` и только потом открывает адрес вкладки, иначе подресурсы
   * первой загрузки прошли бы мимо журнала. Журнала нет — готово сразу.
   */
  devtoolsReady(webContentsId: number): Promise<void>;
  /** Тело ответа до 1 МБ (`DEVTOOLS_LIMITS.panelBody`); null — Chromium его уже вытеснил. */
  responseBody(webContentsId: number, requestId: string): Promise<ResponseBody | null>;
  /** Пачки журнала всех гостей окна (событие browser:devtools); вкладка берёт свои по webContentsId. */
  onDevtools(listener: (batch: DevtoolsBatch) => void): () => void;
  /** Размер вьюпорта (спека 4.2), null — Fit; area — место под страницу в поле вкладки. Ответ — вписывание. */
  setViewport(webContentsId: number, spec: ViewportSpec | null, area: { width: number; height: number }): Promise<{ scale: number }>;
```

  - **`main/ipc.ts`:**
    - импорты:

```ts
import { DEVTOOLS_LIMITS, isViewportSpec, type DevtoolsSnapshot } from '../shared/browser-devtools.js';
import type { Emulation } from './browser/emulation.js';
import type { Inspector } from './browser/inspector.js';
```

    - в `RegisterIpcOptions.browser` после `designMode`:

```ts
    /** Журнал консоли и сети гостей (спека 2026-10-07, 3.3): main/browser/inspector.ts#createInspector. */
    inspector: Pick<Inspector, 'snapshot' | 'clear' | 'responseBody' | 'ready'>;
    /** Размер вьюпорта (спека 2026-10-07, 4.2): main/browser/emulation.ts#createEmulation. */
    emulation: Pick<Emulation, 'set'>;
```

    - рядом с `MAX_FIND_TEXT`:

```ts
/** Журнала у гостя нет (захват не подключался): мост отдаёт пустой с `unavailable`, а не null (спека 3.5). */
const NO_JOURNAL: DevtoolsSnapshot = { epoch: 0, capture: 'unavailable', console: [], network: [] };
/** requestId CDP — строка вида `1234.56`: длиннее — не наш. */
const MAX_REQUEST_ID = 256;
/** Место под страницу — CSS-пиксели окна, с запасом на любой экран. */
const MAX_AREA = 100_000;

function viewportArea(value: unknown): { width: number; height: number } | null {
  if (!isRecord(value)) return null;
  const side = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= MAX_AREA;
  return side(value.width) && side(value.height) ? { width: value.width, height: value.height } : null;
}
```

    - после обработчика `'browser:clear-data'`:

```ts
  // Консоль и сеть (спека 2026-10-07-browser-devtools-agent-design.md, 3.5): тот же страж гостя, аргументы — до инспектора.
  ipcMain.handle(
    'browser:devtools-snapshot',
    withIpcError(async (_event, id: unknown) => browser.inspector.snapshot(browserGuest(browser, id).id) ?? NO_JOURNAL),
  );

  ipcMain.handle(
    'browser:devtools-clear',
    withIpcError(async (_event, id: unknown) => {
      browser.inspector.clear(browserGuest(browser, id).id);
    }),
  );

  // Спайк 0.1, вариант D: окно ждёт включения доменов, прежде чем открыть адрес вкладки. Адрес через мост не ходит.
  ipcMain.handle(
    'browser:devtools-ready',
    withIpcError(async (_event, id: unknown) => {
      await browser.inspector.ready(browserGuest(browser, id).id);
    }),
  );

  ipcMain.handle(
    'browser:response-body',
    withIpcError(async (_event, id: unknown, requestId: unknown) => {
      const guest = browserGuest(browser, id);
      if (typeof requestId !== 'string' || requestId === '' || requestId.length > MAX_REQUEST_ID) {
        throw new HostError('bad_request', 'invalid request id');
      }
      return browser.inspector.responseBody(guest.id, requestId, DEVTOOLS_LIMITS.panelBody);
    }),
  );

  ipcMain.handle(
    'browser:set-viewport',
    withIpcError(async (_event, id: unknown, spec: unknown, area: unknown) => {
      const guest = browserGuest(browser, id);
      const viewport = spec === null ? null : isViewportSpec(spec) ? spec : undefined;
      const size = viewportArea(area);
      if (viewport === undefined || size === null) throw new HostError('bad_request', 'invalid viewport');
      return browser.emulation.set(guest.id, viewport, size);
    }),
  );
```

  - **`preload/index.ts`:**
    - в импорт из `../shared/browser-types.js` ничего не добавлять. Новый импорт:

```ts
import type { DevtoolsBatch, DevtoolsSnapshot, ResponseBody, ViewportSpec } from '../shared/browser-devtools.js';
```

    - рядом с `browserFocusListeners`: `const browserDevtoolsListeners = new Set<(batch: DevtoolsBatch) => void>();`;
    - рядом с `ipcRenderer.on('browser:focus', …)`:

```ts
ipcRenderer.on('browser:devtools', (_event, batch: DevtoolsBatch) => {
  for (const listener of browserDevtoolsListeners) listener(batch);
});
```

    - в объект `browser: { … }` после `onFocus`:

```ts
    devtoolsSnapshot: (webContentsId: number) =>
      ipcRenderer.invoke('browser:devtools-snapshot', webContentsId) as Promise<DevtoolsSnapshot>,
    devtoolsClear: (webContentsId: number) => ipcRenderer.invoke('browser:devtools-clear', webContentsId) as Promise<void>,
    devtoolsReady: (webContentsId: number) => ipcRenderer.invoke('browser:devtools-ready', webContentsId) as Promise<void>,
    responseBody: (webContentsId: number, requestId: string) =>
      ipcRenderer.invoke('browser:response-body', webContentsId, requestId) as Promise<ResponseBody | null>,
    onDevtools: (listener: (batch: DevtoolsBatch) => void) => {
      browserDevtoolsListeners.add(listener);
      return () => browserDevtoolsListeners.delete(listener);
    },
    setViewport: (webContentsId: number, spec: ViewportSpec | null, area: { width: number; height: number }) =>
      ipcRenderer.invoke('browser:set-viewport', webContentsId, spec, area) as Promise<{ scale: number }>,
```

  - **`renderer/test-utils/fake-bridge.ts`:**
    - импорт `import type { DevtoolsBatch, DevtoolsSnapshot, ResponseBody } from '../../shared/browser-devtools.js';`;
    - в `interface FakeBridge` после `pickCalls`:

```ts
  /** Ответ browser.devtoolsSnapshot (спека 2026-10-07, 3.5); по умолчанию пустой журнал с capture 'on'. */
  setDevtoolsSnapshot(snapshot: DevtoolsSnapshot): void;
  /** Пачка журнала: событие `browser:devtools` слушателям `browser.onDevtools`. */
  emitDevtools(batch: DevtoolsBatch): void;
  /** Ответ browser.responseBody; по умолчанию null. Отказ — объект с code, как у прочих отказов. */
  setResponseBody(answer: ResponseBody | null | IpcErrorInfo): void;
  /** scale ответа browser.setViewport; по умолчанию 1. */
  setViewportScale(scale: number): void;
  /** Ответ browser.devtoolsReady (спайк 0.1): промис, который тест разрешает сам, или отказ с code; по умолчанию готово. */
  setDevtoolsReady(answer: Promise<void> | IpcErrorInfo): void;
```

    - в `createFakeBridge` рядом с `pickCalls`:

```ts
  let devtoolsSnapshot: DevtoolsSnapshot = { epoch: 0, capture: 'on', console: [], network: [] };
  const devtoolsListeners = new Set<(batch: DevtoolsBatch) => void>();
  let responseBodyAnswer: ResponseBody | null | IpcErrorInfo = null;
  let viewportScale = 1;
  let devtoolsReadyAnswer: Promise<void> | IpcErrorInfo = Promise.resolve();
```

    - в возвращаемый объект после `pickCalls,`:

```ts
    setDevtoolsSnapshot: (snapshot) => {
      devtoolsSnapshot = snapshot;
    },
    emitDevtools: (batch) => {
      for (const listener of devtoolsListeners) listener(batch);
    },
    setResponseBody: (answer) => {
      responseBodyAnswer = answer;
    },
    setViewportScale: (scale) => {
      viewportScale = scale;
    },
    setDevtoolsReady: (answer) => {
      devtoolsReadyAnswer = answer;
    },
```

    - в объект `browser: { … }` после `onFocus`:

```ts
      devtoolsSnapshot: async (webContentsId) => {
        browserCalls.push({ method: 'devtoolsSnapshot', args: [webContentsId] });
        return devtoolsSnapshot;
      },
      devtoolsClear: async (webContentsId) => {
        browserCalls.push({ method: 'devtoolsClear', args: [webContentsId] });
      },
      devtoolsReady: async (webContentsId) => {
        browserCalls.push({ method: 'devtoolsReady', args: [webContentsId] });
        const answer = devtoolsReadyAnswer;
        if ('code' in answer) throw answer;
        await answer;
      },
      responseBody: async (webContentsId, requestId) => {
        browserCalls.push({ method: 'responseBody', args: [webContentsId, requestId] });
        const answer = responseBodyAnswer;
        if (answer !== null && 'code' in answer) throw answer;
        return answer;
      },
      onDevtools: (listener) => {
        devtoolsListeners.add(listener);
        return () => devtoolsListeners.delete(listener);
      },
      setViewport: async (webContentsId, spec, area) => {
        browserCalls.push({ method: 'setViewport', args: [webContentsId, spec, area] });
        return { scale: viewportScale };
      },
```

  - **`main/index.ts`:**
    - импорт `import { createEmulation } from './browser/emulation.js';`;
    - сразу после `forwardBatches(inspector, …);` (задача 5): `const emulation = createEmulation({ inspector });`;
    - в `registerIpc({ … browser: { … } })` после `designMode,`: `inspector,` и `emulation,`.

- [ ] **Шаг 4. Запустить — проходит.**
  - Команда шага 2 → PASS.
  - `pnpm --filter @parley/desktop typecheck` → без ошибок.
  - `pnpm --filter @parley/desktop test` → зелёный.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/shared/browser-types.ts packages/desktop/src/main/ipc.ts packages/desktop/src/main/ipc.test.ts packages/desktop/src/preload packages/desktop/src/renderer/test-utils/fake-bridge.ts packages/desktop/src/main/index.ts
git commit -m "feat(desktop): мост browser — журнал консоли и сети, тело ответа, размер вьюпорта, готовность захвата" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 8. Размер у вкладки и высота панели в настройках окна

**Файлы:**
- Изменить:
  - `packages/desktop/src/shared/layout-types.ts` (`TabSpec` браузера);
  - `packages/desktop/src/renderer/layout/tree.ts` (`TabPatch`, `updateTab`, разбор);
  - `packages/desktop/src/shared/ui-types.ts` (`BrowserUi`, `UiFile.browser`, `DEFAULT_UI`, `DEVTOOLS_PANEL`, `normalizeUi`);
  - `packages/desktop/src/main/ui-store.ts` (`NESTED_KEYS`).
- Тесты: `packages/desktop/src/renderer/layout/tree.test.ts`, `packages/desktop/src/shared/ui-types.test.ts`, `packages/desktop/src/main/ui-store.test.ts`

**Интерфейсы:**
- Берёт: `ViewportSpec`, `isViewportSpec` (задача 2).
- Отдаёт:
  - `TabSpec` браузера с `viewport?: ViewportSpec` (индекс: «A; Fit — поля нет»);
  - `TabPatch.viewport?: ViewportSpec | null`, где `null` — Fit, поле убирается;
  - `BrowserUi { devtoolsHeight: number | null }`, `UiFile.browser`, `DEFAULT_UI.browser = { devtoolsHeight: null }`;
  - `DEVTOOLS_PANEL = { minHeight: 120, defaultShare: 0.4 }`.
- Мусор в `viewport` на диске — вкладка без размера (Fit), раскладка цела (см. «Расхождения с индексом», п. 4).

- [ ] **Шаг 1. Написать падающие тесты.**

  В `tree.test.ts`:
  - в импорт типов добавить `ViewportSpec` из `../../shared/browser-devtools.js`;
  - в конец файла:

```ts
describe('размер вкладки браузера (спека 2026-10-07, 4.2)', () => {
  const MOBILE_M: ViewportSpec = { preset: 'mobile-m', rotated: false, dpr: 2 };

  it('updateTab: viewport ставится и снимается (null — Fit, поля нет); адрес не трогает размер', () => {
    const page = browserTab('http://localhost:5173/');
    const layout = openTab(emptyLayout(), page, 'active');
    const sized = updateTab(layout, page.id, { viewport: MOBILE_M });
    expect(groups(sized)[0]?.tabs[0]).toEqual({ ...page, viewport: MOBILE_M });
    const moved = updateTab(sized, page.id, { url: 'http://localhost:5173/a' });
    expect(groups(moved)[0]?.tabs[0]).toEqual({ ...page, url: 'http://localhost:5173/a', viewport: MOBILE_M });
    const fit = updateTab(sized, page.id, { viewport: null });
    expect(groups(fit)[0]?.tabs[0]).toEqual(page);
    expect(Object.keys(groups(fit)[0]?.tabs[0] ?? {})).not.toContain('viewport');
    expect(validateLayout(sized)).toEqual([]);
  });

  function withBrowserTab(tab: Record<string, unknown>): unknown {
    return { root: { type: 'group', id: 'g1', tabs: [tab], activeTabId: tab.id }, activeGroupId: 'g1', closedTabs: [] };
  }

  it('parseWorkLayout: пресет и свой размер читаются, лишние поля размера выкинуты', () => {
    const preset = parseWorkLayout(withBrowserTab({ kind: 'browser', id: 'browser:0000c1', url: 'http://localhost:5173/', viewport: { ...MOBILE_M, extra: 1 } }));
    expect(preset === null ? null : groups(preset)[0]?.tabs[0]).toEqual({ kind: 'browser', id: 'browser:0000c1', url: 'http://localhost:5173/', viewport: MOBILE_M });
    const custom = { width: 1024, height: 700, mobile: false, dpr: 1 };
    const own = parseWorkLayout(withBrowserTab({ kind: 'browser', id: 'browser:0000c1', url: 'http://localhost:5173/', viewport: custom }));
    expect(own === null ? null : groups(own)[0]?.tabs[0]).toEqual({ kind: 'browser', id: 'browser:0000c1', url: 'http://localhost:5173/', viewport: custom });
  });

  it('parseWorkLayout: мусор в размере — вкладка без размера (Fit), раскладка цела', () => {
    for (const viewport of [{ preset: 'phone', rotated: false, dpr: 2 }, { width: 10, height: 10, mobile: false, dpr: 1 }, 'mobile-m', null]) {
      const layout = parseWorkLayout(withBrowserTab({ kind: 'browser', id: 'browser:0000c1', url: 'http://localhost:5173/', viewport }));
      expect(layout === null ? null : groups(layout)[0]?.tabs[0], JSON.stringify(viewport)).toEqual({
        kind: 'browser',
        id: 'browser:0000c1',
        url: 'http://localhost:5173/',
      });
    }
  });
});
```

  В `ui-types.test.ts`, в конец файла:

```ts
describe('раздел browser (спека 2026-10-07, 4.3)', () => {
  it('по умолчанию высоты панели нет — 40 % вкладки', () => {
    expect(normalizeUi({}).browser).toEqual({ devtoolsHeight: null });
  });

  it('высота — целое не ниже 120; мусор — по умолчанию', () => {
    expect(normalizeUi({ browser: { devtoolsHeight: 300.4 } }).browser.devtoolsHeight).toBe(300);
    expect(normalizeUi({ browser: { devtoolsHeight: 40 } }).browser.devtoolsHeight).toBe(120);
    for (const value of [Number.NaN, Infinity, '300', null, {}]) {
      expect(normalizeUi({ browser: { devtoolsHeight: value } }).browser.devtoolsHeight, String(value)).toBeNull();
    }
  });
});
```

  В `ui-store.test.ts`, рядом с тестом `voice`:

```ts
  it('browser сохраняется и читается обратно; патч других полей его не трогает (спека 2026-10-07, 4.3)', async () => {
    const store = createUiStore(file);
    await store.save({ browser: { devtoolsHeight: 260 } });
    await store.save({ appearance: 'dark' });
    expect((await store.load()).browser).toEqual({ devtoolsHeight: 260 });
  });
```

- [ ] **Шаг 2. Запустить — падает.**

  `pnpm --filter @parley/desktop exec vitest run src/renderer/layout/tree.test.ts src/shared/ui-types.test.ts src/main/ui-store.test.ts` → FAIL: `viewport` не ставится и не читается; `browser` is undefined.

- [ ] **Шаг 3. Реализовать.**
  - **`shared/layout-types.ts`:**
    - импорт `import type { ViewportSpec } from './browser-devtools.js';`;
    - последняя строка `TabSpec`:

```ts
  // viewport: нет поля — Fit (спека 2026-10-07-browser-devtools-agent-design.md, 4.2); размер переживает перезапуск.
  | { kind: 'browser'; id: string; url: string; viewport?: ViewportSpec };
```

  - **`renderer/layout/tree.ts`:**
    - импорт `import { isViewportSpec, type ViewportSpec } from '../../shared/browser-devtools.js';`;
    - `TabPatch`:

```ts
export type TabPatch = { url?: string; view?: TerminalView; viewport?: ViewportSpec | null };
```

    - перед `export function updateTab`:

```ts
/** Адрес и размер вкладки браузера; размер null — Fit: поля нет (спека 2026-10-07, 4.2). */
function patchBrowser(tab: Extract<TabSpec, { kind: 'browser' }>, patch: TabPatch): TabSpec {
  const next = { ...tab, url: patch.url ?? tab.url };
  if (patch.viewport === null) delete next.viewport;
  else if (patch.viewport !== undefined) next.viewport = patch.viewport;
  return next;
}
```

    - в `updateTab` строку `if (tab.kind === 'browser' && patch.url !== undefined) next = { ...tab, url: patch.url };` заменить на:

```ts
  if (tab.kind === 'browser' && (patch.url !== undefined || patch.viewport !== undefined)) next = patchBrowser(tab, patch);
```

    - рядом с `parseFileRootSpec`:

```ts
/** Размер вкладки браузера: новый объект только из полей своего вида; мусор — null, то есть Fit. */
function parseViewport(value: unknown): ViewportSpec | null {
  if (!isViewportSpec(value)) return null;
  return 'preset' in value
    ? { preset: value.preset, rotated: value.rotated, dpr: value.dpr }
    : { width: value.width, height: value.height, mobile: value.mobile, dpr: value.dpr };
}
```

    - в `parseTabSpec` ветку `case 'browser':` заменить на:

```ts
    case 'browser': {
      if (typeof value.url !== 'string') return null;
      // Мусор в размере — Fit, а не битая раскладка: размер — удобство, вкладка с адресом дороже (спека 2026-10-07, 4.2).
      const viewport = parseViewport(value.viewport);
      return viewport === null ? { kind: 'browser', id, url: value.url } : { kind: 'browser', id, url: value.url, viewport };
    }
```

  - **`shared/ui-types.ts`:**
    - после `interface VoiceUi`:

```ts
/** Вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, 4.3): высота панели Console | Network — общая. */
export interface BrowserUi {
  /** null — 40 % высоты вкладки (`DEVTOOLS_PANEL.defaultShare`). */
  devtoolsHeight: number | null;
}
```

    - в `UiFile` после `voice: VoiceUi;`: `/** Вкладки браузера (спека 2026-10-07, 4.3). */ browser: BrowserUi;`;
    - в `DEFAULT_UI` после `voice: …,`: `browser: { devtoolsHeight: null },`;
    - после `RIGHT_SIDEBAR`:

```ts
/** Панель Console | Network (спека 2026-10-07, 4.3): не ниже 120 px, по умолчанию 40 % вкладки. Верх держит окно. */
export const DEVTOOLS_PANEL = { minHeight: 120, defaultShare: 0.4 } as const;
```

    - рядом с `normalizeVoice`:

```ts
function normalizeBrowser(value: unknown): BrowserUi {
  const source = isRecord(value) ? value : {};
  // Высоты вкладки ui.json не знает: здесь — только низ; верх держит окно (`renderer/browser/stage.ts#panelHeight`).
  const height = isFiniteNumber(source.devtoolsHeight) ? Math.max(Math.round(source.devtoolsHeight), DEVTOOLS_PANEL.minHeight) : null;
  return { devtoolsHeight: height };
}
```

    - в `normalizeUi` после `voice: normalizeVoice(source.voice),`: `browser: normalizeBrowser(source.browser),`.
  - **`main/ui-store.ts`:** дописать `'browser'` в `NESTED_KEYS`. Иначе патч `agentsAllowed` этапа C стёр бы `devtoolsHeight`.

- [ ] **Шаг 4. Запустить — проходит.**
  - Команда шага 2 → PASS.
  - `pnpm --filter @parley/desktop typecheck` → без ошибок. Если где-то в тестах `UiFile` собирается целиком без spread `DEFAULT_UI`, добавить ему `browser: DEFAULT_UI.browser`.
  - `pnpm --filter @parley/desktop test` → зелёный.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/shared/layout-types.ts packages/desktop/src/renderer/layout/tree.ts packages/desktop/src/renderer/layout/tree.test.ts packages/desktop/src/shared/ui-types.ts packages/desktop/src/shared/ui-types.test.ts packages/desktop/src/main/ui-store.ts packages/desktop/src/main/ui-store.test.ts
git commit -m "feat(desktop): размер вьюпорта у вкладки браузера и высота панели в ui.json" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 9. Журнал в окне

**Файлы:**
- Создать:
  - `packages/desktop/src/renderer/browser/devtools/store.ts`;
  - `packages/desktop/src/renderer/test-utils/devtools-fixtures.ts`.
- Тест: `packages/desktop/src/renderer/browser/devtools/store.test.ts`

**Интерфейсы:**
- Берёт: `DEVTOOLS_LIMITS`, `isFailed`, типы журнала (задача 2).
- Отдаёт:
  - типы и стор: `DevtoolsView`, `NetworkFilter`, `TabDevtools`, `DevtoolsPatch`, `EMPTY_DEVTOOLS`, `DevtoolsState`, `useDevtoolsStore`;
  - действия стора: `snapshot`, `batch`, `clear`, `toggle`, `show`, `hide`, `patch`, `remove`;
  - выборки: `visibleConsole(tab)`, `visibleNetwork(tab)`, `documentUrl(tab, epoch)`, `devtoolsCounters(tab)`;
  - фикстуры тестов: `consoleEntry`, `networkEntry`, `devtoolsBatch`.
- Ключ стора — id вкладки, как у `useBrowserStore` (`renderer/browser/store.ts`). Пачки своего гостя кладёт `BrowserSurface` (задача 16).

- [ ] **Шаг 1. Записать фикстуры.**

```ts
// packages/desktop/src/renderer/test-utils/devtools-fixtures.ts
/**
 * Записи журнала консоли и сети для тестов окна (спека 2026-10-07-browser-devtools-agent-design.md, 3.4): по умолчанию —
 * обычное сообщение и удачный запрос, тест правит нужные поля.
 */
import type { ConsoleEntry, DevtoolsBatch, NetworkEntry } from '../../shared/browser-devtools.js';

export function consoleEntry(id: number, patch: Partial<ConsoleEntry> = {}): ConsoleEntry {
  return { id, epoch: 0, ts: id, level: 'info', origin: 'console', text: `message ${id}`, location: null, stack: [], count: 1, ...patch };
}

export function networkEntry(id: string, patch: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    id,
    epoch: 0,
    ts: 0,
    method: 'GET',
    url: `http://localhost:5173/api/${id}`,
    kind: 'fetch',
    status: 200,
    statusText: 'OK',
    failure: null,
    mimeType: 'application/json',
    encodedBytes: 120,
    durationMs: 15,
    fromCache: false,
    remoteAddress: '127.0.0.1:5173',
    requestHeaders: [['Accept', '*/*']],
    responseHeaders: [['content-type', 'application/json']],
    hasPostData: false,
    postData: null,
    ...patch,
  };
}

export function devtoolsBatch(patch: Partial<DevtoolsBatch> = {}): DevtoolsBatch {
  return { webContentsId: 7, epoch: 0, capture: 'on', reset: false, console: [], network: [], ...patch };
}
```

- [ ] **Шаг 2. Написать падающий тест.**

```ts
// packages/desktop/src/renderer/browser/devtools/store.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { DEVTOOLS_LIMITS } from '../../../shared/browser-devtools.js';
import { consoleEntry, devtoolsBatch, networkEntry } from '../../test-utils/devtools-fixtures.js';
import {
  devtoolsCounters,
  documentUrl,
  EMPTY_DEVTOOLS,
  useDevtoolsStore,
  visibleConsole,
  visibleNetwork,
  type TabDevtools,
} from './store.js';

const TAB = 'browser:0000c1';
const tab = (): TabDevtools => useDevtoolsStore.getState().tabs[TAB] ?? EMPTY_DEVTOOLS;
const withTab = (patch: Partial<TabDevtools>): TabDevtools => ({ ...EMPTY_DEVTOOLS, ...patch });

afterEach(() => useDevtoolsStore.setState({ tabs: {} }));

describe('журнал вкладки: снимок и пачки (спека 3.5)', () => {
  it('снимок заменяет журнал и эпоху, вид панели не трогает', () => {
    const store = useDevtoolsStore.getState();
    store.show(TAB, 'network');
    store.batch(TAB, devtoolsBatch({ console: [consoleEntry(1)] }));
    store.snapshot(TAB, { epoch: 3, capture: 'late', console: [consoleEntry(5)], network: [networkEntry('r1')] });
    expect(tab()).toMatchObject({ epoch: 3, capture: 'late', open: true, view: 'network' });
    expect(tab().console.map((entry) => entry.id)).toEqual([5]);
    expect(tab().network.map((entry) => entry.id)).toEqual(['r1']);
  });

  it('пачка: новые записи — в конец, изменённые (count, ответ) — на своём месте', () => {
    const store = useDevtoolsStore.getState();
    store.batch(TAB, devtoolsBatch({ console: [consoleEntry(1), consoleEntry(2)], network: [networkEntry('r1', { status: null })] }));
    store.batch(
      TAB,
      devtoolsBatch({ console: [consoleEntry(1, { count: 4 }), consoleEntry(3)], network: [networkEntry('r1', { status: 500 }), networkEntry('r2')] }),
    );
    expect(tab().console.map((entry) => [entry.id, entry.count])).toEqual([
      [1, 4],
      [2, 1],
      [3, 1],
    ]);
    expect(tab().network.map((entry) => [entry.id, entry.status])).toEqual([
      ['r1', 500],
      ['r2', 200],
    ]);
  });

  it('reset — журнал очищен до пачки; эпоха и capture — из пачки', () => {
    const store = useDevtoolsStore.getState();
    store.batch(TAB, devtoolsBatch({ console: [consoleEntry(1)] }));
    store.batch(TAB, devtoolsBatch({ reset: true, epoch: 2, capture: 'unavailable', console: [consoleEntry(9)] }));
    expect(tab()).toMatchObject({ epoch: 2, capture: 'unavailable' });
    expect(tab().console.map((entry) => entry.id)).toEqual([9]);
  });

  it('пределы как у колец main: 1000 сообщений, 500 запросов — старшие уходят', () => {
    const store = useDevtoolsStore.getState();
    store.batch(TAB, devtoolsBatch({ console: Array.from({ length: DEVTOOLS_LIMITS.consoleEntries + 2 }, (_, index) => consoleEntry(index + 1)) }));
    store.batch(TAB, devtoolsBatch({ network: Array.from({ length: DEVTOOLS_LIMITS.networkEntries + 1 }, (_, index) => networkEntry(`r${index}`)) }));
    expect(tab().console).toHaveLength(DEVTOOLS_LIMITS.consoleEntries);
    expect(tab().console[0]?.id).toBe(3);
    expect(tab().network).toHaveLength(DEVTOOLS_LIMITS.networkEntries);
    expect(tab().network[0]?.id).toBe('r1');
  });

  it('новая эпоха без Preserve log снимает выбор запроса, с ним — оставляет; clear — пустой журнал', () => {
    const store = useDevtoolsStore.getState();
    store.batch(TAB, devtoolsBatch({ network: [networkEntry('r1')] }));
    store.patch(TAB, { selected: 'r1' });
    store.batch(TAB, devtoolsBatch({ epoch: 1 }));
    expect(tab().selected).toBeNull();
    store.patch(TAB, { selected: 'r1', preserve: true });
    store.batch(TAB, devtoolsBatch({ epoch: 2 }));
    expect(tab().selected).toBe('r1');
    store.clear(TAB);
    expect(tab()).toMatchObject({ console: [], network: [], selected: null, epoch: 2 });
  });
});

describe('вид: фильтры (спека 4.3, 4.4)', () => {
  it('Console: текущая эпоха, с Preserve log — все; Debug выключен по умолчанию; текст — без учёта регистра', () => {
    const entries = [
      consoleEntry(1, { epoch: 0, text: 'old' }),
      consoleEntry(2, { epoch: 1, text: 'Boom happened', level: 'error' }),
      consoleEntry(3, { epoch: 1, text: 'trace', level: 'debug' }),
      consoleEntry(4, { epoch: 1, text: 'ok' }),
    ];
    const ids = (value: TabDevtools): number[] => visibleConsole(value).map((entry) => entry.id);
    expect(ids(withTab({ epoch: 1, console: entries }))).toEqual([2, 4]);
    expect(ids(withTab({ epoch: 1, console: entries, preserve: true }))).toEqual([1, 2, 4]);
    expect(ids(withTab({ epoch: 1, console: entries, levels: { ...EMPTY_DEVTOOLS.levels, debug: true } }))).toEqual([2, 3, 4]);
    expect(ids(withTab({ epoch: 1, console: entries, consoleText: 'BOOM' }))).toEqual([2]);
  });

  it('Network: All, Fetch/XHR, Doc, JS, CSS, Img, Other; Failed only; URL', () => {
    const entries = [
      networkEntry('doc', { kind: 'document', url: 'http://localhost:5173/' }),
      networkEntry('api', { kind: 'fetch', status: 500 }),
      networkEntry('xhr', { kind: 'xhr' }),
      networkEntry('js', { kind: 'script' }),
      networkEntry('css', { kind: 'stylesheet' }),
      networkEntry('img', { kind: 'image' }),
      networkEntry('font', { kind: 'font' }),
      networkEntry('ws', { kind: 'websocket' }),
      networkEntry('cancel', { status: null, failure: { reason: 'canceled', text: 'net::ERR_ABORTED' } }),
    ];
    const ids = (patch: Partial<TabDevtools>): string[] => visibleNetwork(withTab({ network: entries, ...patch })).map((entry) => entry.id);
    expect(ids({})).toHaveLength(9);
    expect(ids({ networkFilter: 'fetch' })).toEqual(['api', 'xhr', 'cancel']);
    expect(ids({ networkFilter: 'doc' })).toEqual(['doc']);
    expect(ids({ networkFilter: 'js' })).toEqual(['js']);
    expect(ids({ networkFilter: 'css' })).toEqual(['css']);
    expect(ids({ networkFilter: 'img' })).toEqual(['img']);
    expect(ids({ networkFilter: 'other' })).toEqual(['font', 'ws']);
    expect(ids({ failedOnly: true })).toEqual(['api']);
    expect(ids({ urlText: 'API/XHR' })).toEqual(['xhr']);
  });

  it('documentUrl — адрес документа эпохи для разделителя «Navigated to»', () => {
    const value = withTab({ network: [networkEntry('doc', { kind: 'document', epoch: 2, url: 'http://localhost:5173/next' })] });
    expect(documentUrl(value, 2)).toBe('http://localhost:5173/next');
    expect(documentUrl(value, 1)).toBeNull();
  });
});

describe('счётчики строки (спека 4.1; Фокус ревью 3)', () => {
  it('упавший запрос и его строки «Failed to load resource» и CORS — одна ошибка на запрос', () => {
    const value = withTab({
      console: [
        consoleEntry(1, { level: 'error', origin: 'network', text: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)' }),
        consoleEntry(2, { level: 'error', origin: 'network', text: 'Access to fetch has been blocked by CORS policy' }),
      ],
      network: [networkEntry('api', { status: 500 }), networkEntry('cors', { status: null, failure: { reason: 'cors', text: 'MissingAllowOriginHeader' } })],
    });
    expect(devtoolsCounters(value)).toEqual({ errors: 2, warnings: 0 });
  });

  it('ошибки консоли с повторами, исключения и ошибки браузера без запроса (CSP) — красный, предупреждения консоли — жёлтый; прошлая эпоха и отмена — не в счёт', () => {
    const value = withTab({
      epoch: 1,
      console: [
        consoleEntry(1, { epoch: 0, level: 'error' }),
        consoleEntry(2, { epoch: 1, level: 'error', count: 3 }),
        consoleEntry(3, { epoch: 1, level: 'error', origin: 'exception' }),
        consoleEntry(4, { epoch: 1, level: 'warning', count: 2 }),
        consoleEntry(5, { epoch: 1, level: 'warning', origin: 'browser' }),
        consoleEntry(6, { epoch: 1, level: 'error', origin: 'browser', text: "Refused to load the script because it violates the Content Security Policy" }),
      ],
      network: [
        networkEntry('old', { epoch: 0, status: 500 }),
        networkEntry('x', { epoch: 1, status: null, failure: { reason: 'canceled', text: 'net::ERR_ABORTED' } }),
      ],
    });
    expect(devtoolsCounters(value)).toEqual({ errors: 5, warnings: 2 });
  });
});

describe('панель: открыть, вид, спрятать', () => {
  it('toggle, show на нужном виде, hide, remove', () => {
    const store = useDevtoolsStore.getState();
    store.toggle(TAB);
    expect(tab()).toMatchObject({ open: true, view: 'console' });
    store.toggle(TAB);
    expect(tab().open).toBe(false);
    store.show(TAB, 'network');
    expect(tab()).toMatchObject({ open: true, view: 'network' });
    store.hide(TAB);
    expect(tab().open).toBe(false);
    store.remove(TAB);
    expect(useDevtoolsStore.getState().tabs[TAB]).toBeUndefined();
  });
});
```

- [ ] **Шаг 3. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/renderer/browser/devtools/store.test.ts` → FAIL: `Failed to resolve import "./store.js"`.

- [ ] **Шаг 4. Реализовать.**

```ts
// packages/desktop/src/renderer/browser/devtools/store.ts
/**
 * Журнал консоли и сети вкладок браузера в окне (спека 2026-10-07-browser-devtools-agent-design.md, 3.5, 4.3, 4.4).
 *
 * Здесь — копия журнала main по вкладке и состояние её панели:
 * - журнал: снимок `devtoolsSnapshot`, потом пачки `browser:devtools`;
 * - панель: открыта ли, какой вид, фильтры, выбранный запрос.
 * Пределы — те же, что у колец main (`DEVTOOLS_LIMITS`). Журнал пишет `BrowserSurface`; вид — панель, кнопка строки и
 * действия `browser.devtools` и `browser.console` (клавиши, палитра).
 */

import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import {
  DEVTOOLS_LIMITS,
  isFailed,
  type CaptureState,
  type ConsoleEntry,
  type ConsoleLevel,
  type DevtoolsBatch,
  type DevtoolsSnapshot,
  type NetworkEntry,
  type NetworkKind,
} from '../../../shared/browser-devtools.js';

export type DevtoolsView = 'console' | 'network';
/** Кнопки типов Network (спека 4.4): All, Fetch/XHR, Doc, JS, CSS, Img, Other. */
export type NetworkFilter = 'all' | 'fetch' | 'doc' | 'js' | 'css' | 'img' | 'other';

export interface TabDevtools {
  epoch: number;
  capture: CaptureState;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  open: boolean;
  view: DevtoolsView;
  /** «Preserve log»: прежние эпохи остаются видны, между ними — разделитель (спека 4.3). */
  preserve: boolean;
  levels: Record<ConsoleLevel, boolean>;
  consoleText: string;
  networkFilter: NetworkFilter;
  failedOnly: boolean;
  urlText: string;
  /** requestId запроса в деталях (спека 4.4). */
  selected: string | null;
}

export type DevtoolsPatch = Partial<
  Pick<TabDevtools, 'view' | 'preserve' | 'levels' | 'consoleText' | 'networkFilter' | 'failedOnly' | 'urlText' | 'selected'>
>;

export const EMPTY_DEVTOOLS: TabDevtools = {
  epoch: 0,
  capture: 'on',
  console: [],
  network: [],
  open: false,
  view: 'console',
  preserve: false,
  // Debug по умолчанию выключен (спека 4.3).
  levels: { error: true, warning: true, info: true, debug: false },
  consoleText: '',
  networkFilter: 'all',
  failedOnly: false,
  urlText: '',
  selected: null,
};

export interface DevtoolsState {
  tabs: Record<string /* tabId */, TabDevtools>;
  snapshot(tabId: string, snapshot: DevtoolsSnapshot): void;
  batch(tabId: string, batch: DevtoolsBatch): void;
  clear(tabId: string): void;
  toggle(tabId: string): void;
  show(tabId: string, view: DevtoolsView): void;
  hide(tabId: string): void;
  patch(tabId: string, patch: DevtoolsPatch): void;
  remove(tabId: string): void;
}

const KINDS: Readonly<Record<Exclude<NetworkFilter, 'all'>, readonly NetworkKind[]>> = {
  fetch: ['fetch', 'xhr'],
  doc: ['document'],
  js: ['script'],
  css: ['stylesheet'],
  img: ['image'],
  other: ['font', 'media', 'websocket', 'other'],
};

/** Новые записи — в конец, изменённые — на своё место; сверх предела уходят старшие. */
function upsert<T extends { id: number | string }>(list: readonly T[], updates: readonly T[], limit: number): T[] {
  const next = [...list];
  const index = new Map<number | string, number>(next.map((item, at) => [item.id, at]));
  for (const item of updates) {
    const at = index.get(item.id);
    if (at === undefined) {
      index.set(item.id, next.length);
      next.push(item);
    } else {
      next[at] = item;
    }
  }
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export const useDevtoolsStore: UseBoundStore<StoreApi<DevtoolsState>> = create<DevtoolsState>((set) => {
  const update = (tabId: string, change: (tab: TabDevtools) => Partial<TabDevtools>): void =>
    set((state) => {
      const tab = state.tabs[tabId] ?? EMPTY_DEVTOOLS;
      return { tabs: { ...state.tabs, [tabId]: { ...tab, ...change(tab) } } };
    });
  return {
    tabs: {},
    snapshot: (tabId, snapshot) =>
      update(tabId, () => ({
        epoch: snapshot.epoch,
        capture: snapshot.capture,
        console: snapshot.console.slice(-DEVTOOLS_LIMITS.consoleEntries),
        network: snapshot.network.slice(-DEVTOOLS_LIMITS.networkEntries),
      })),
    batch: (tabId, batch) =>
      update(tabId, (tab) => ({
        epoch: batch.epoch,
        capture: batch.capture,
        console: upsert(batch.reset ? [] : tab.console, batch.console, DEVTOOLS_LIMITS.consoleEntries),
        network: upsert(batch.reset ? [] : tab.network, batch.network, DEVTOOLS_LIMITS.networkEntries),
        // Новая страница без «Preserve log» — прежний запрос из списка ушёл, деталям нечего показывать.
        selected: batch.reset || (batch.epoch !== tab.epoch && !tab.preserve) ? null : tab.selected,
      })),
    clear: (tabId) => update(tabId, () => ({ console: [], network: [], selected: null })),
    toggle: (tabId) => update(tabId, (tab) => ({ open: !tab.open })),
    show: (tabId, view) => update(tabId, () => ({ open: true, view })),
    hide: (tabId) => update(tabId, () => ({ open: false })),
    patch: (tabId, patch) => update(tabId, () => patch),
    remove: (tabId) =>
      set((state) => {
        if (!(tabId in state.tabs)) return state;
        const rest = { ...state.tabs };
        delete rest[tabId];
        return { tabs: rest };
      }),
  };
});

/** Записи Console по фильтрам: текущая эпоха (или все с «Preserve log»), уровни, подстрока без учёта регистра. */
export function visibleConsole(tab: TabDevtools): ConsoleEntry[] {
  const needle = tab.consoleText.trim().toLowerCase();
  return tab.console.filter(
    (entry) =>
      (tab.preserve || entry.epoch === tab.epoch) &&
      tab.levels[entry.level] &&
      (needle === '' || entry.text.toLowerCase().includes(needle)),
  );
}

/** Запросы Network по фильтрам: эпоха, тип, «Failed only» (`isFailed`), подстрока URL. */
export function visibleNetwork(tab: TabDevtools): NetworkEntry[] {
  const needle = tab.urlText.trim().toLowerCase();
  const kinds = tab.networkFilter === 'all' ? null : KINDS[tab.networkFilter];
  return tab.network.filter(
    (entry) =>
      (tab.preserve || entry.epoch === tab.epoch) &&
      (kinds === null || kinds.includes(entry.kind)) &&
      (!tab.failedOnly || isFailed(entry)) &&
      (needle === '' || entry.url.toLowerCase().includes(needle)),
  );
}

/** Адрес документа эпохи — для разделителя «Navigated to …» при «Preserve log». */
export function documentUrl(tab: TabDevtools, epoch: number): string | null {
  return tab.network.find((entry) => entry.epoch === epoch && entry.kind === 'document')?.url ?? null;
}

/**
 * Счётчики кнопки строки (спека 4.1), текущая эпоха.
 * - Красный — ошибки консоли с повторами, исключения и упавшие запросы.
 * - Жёлтый — предупреждения консоли.
 * Строки сети («Failed to load resource», CORS — у них есть `networkRequestId`) — про сам запрос: второй раз его не считают
 * (Фокус ревью 3). Ошибки браузера без запроса — нарушение CSP и прочее — считаются: пары в сети у них нет.
 */
export function devtoolsCounters(tab: TabDevtools): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const entry of tab.console) {
    if (entry.epoch !== tab.epoch) continue;
    if (entry.level === 'error' && entry.origin !== 'network') errors += entry.count;
    else if (entry.level === 'warning' && entry.origin === 'console') warnings += entry.count;
  }
  for (const entry of tab.network) if (entry.epoch === tab.epoch && isFailed(entry)) errors += 1;
  return { errors, warnings };
}
```

- [ ] **Шаг 5. Запустить — проходит.** Команда шага 3 → PASS (11 тестов). Затем `pnpm --filter @parley/desktop typecheck` → без ошибок.

- [ ] **Шаг 6. Закоммитить.**

```bash
git add packages/desktop/src/renderer/browser/devtools packages/desktop/src/renderer/test-utils/devtools-fixtures.ts
git commit -m "feat(desktop): журнал консоли и сети вкладки в окне — пачки, фильтры, счётчики" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 10. Строки, клавиши и палитра

**Файлы:**
- Изменить:
  - `packages/desktop/src/shared/strings.ts` (`S.browser.devtools`, `S.browser.viewport`, `S.actions`, `S.errors.actions`);
  - `packages/desktop/src/shared/keybindings.ts` (`ActionId`, `ACTIONS`);
  - `packages/desktop/src/renderer/keys/handler.ts` (`IMPLEMENTED_ACTIONS`);
  - `packages/desktop/src/renderer/palette/actions.ts` (`runAction`).
- Тесты:
  - `packages/desktop/src/shared/keybindings.test.ts`, `packages/desktop/src/renderer/keys/handler.test.ts`, `packages/desktop/src/main/guest-shortcuts.test.ts`;
  - `packages/desktop/src/main/menu.test.ts`, `packages/desktop/src/renderer/palette/actions.test.ts`.

**Интерфейсы:**
- Берёт: `useDevtoolsStore` (задача 9); `ActionContext.browser.active()` (`palette/actions.ts`); `forwardGuestShortcuts` (`main/guest-shortcuts.ts`): действия `when: 'browser'` с клавишами он пересылает из страницы сам.
- Отдаёт:
  - `ActionId` `'browser.devtools'` (`CmdOrCtrl+Alt+I`) и `'browser.console'` (`CmdOrCtrl+Alt+J`): `when: 'browser'`, без меню, в палитре;
  - строки `S.browser.devtools.*`, `S.browser.viewport.*`, `S.actions.toggleDevtools`, `S.actions.showConsole`;
  - действия ошибок `S.errors.actions.setViewport`, `clearDevtools`, `loadResponse`.
- `S.browser.devTools` («DevTools») пока остаётся: кнопку и строку убирает задача 15.

- [ ] **Шаг 1. Написать падающие тесты.**

  В `keybindings.test.ts`:
  - в `ALL_ACTION_IDS` после `'browser.zoomReset': true,` дописать `'browser.devtools': true, 'browser.console': true,`;
  - в тесте «действия браузера — when browser, без меню…» массив `['browser.find', 'browser.zoomIn', 'browser.zoomOut', 'browser.zoomReset']` дополнить `'browser.devtools'` и `'browser.console'`;
  - в конец файла:

```ts
describe('панель браузера (спека 2026-10-07, 4.9)', () => {
  it('browser.devtools — ⌘⌥I, browser.console — ⌘⌥J; в палитре; ⌥ даёт ˆ и ∆ — нажатие узнаётся по code', () => {
    expect(ACTIONS.find((action) => action.id === 'browser.devtools')).toMatchObject({ keys: 'CmdOrCtrl+Alt+I', menu: null, when: 'browser', inPalette: true });
    expect(ACTIONS.find((action) => action.id === 'browser.console')).toMatchObject({ keys: 'CmdOrCtrl+Alt+J', menu: null, when: 'browser', inPalette: true });
    expect(matchesAccelerator('CmdOrCtrl+Alt+I', key({ key: 'ˆ', code: 'KeyI', metaKey: true, altKey: true }))).toBe(true);
    expect(matchesAccelerator('CmdOrCtrl+Alt+J', key({ key: '∆', code: 'KeyJ', metaKey: true, altKey: true }))).toBe(true);
  });
});
```

  В `handler.test.ts`, рядом с тестом «browser.newTab реализован (9.2a)…»:

```ts
  it('панель браузера (спека 2026-10-07, 4.9): реализована, без методов хоста; ⌘⌥I рендерер окна не ловит — клавиша у гостя', () => {
    for (const id of ['browser.devtools', 'browser.console'] as const) {
      expect(IMPLEMENTED_ACTIONS.has(id)).toBe(true);
      expect(isActionAvailable(id, new Set())).toBe(true);
    }
    expect(resolveAction(cmd('ˆ', 'KeyI', { altKey: true }), 'other', false)).toBeNull();
    expect(resolveAction(cmd('∆', 'KeyJ', { altKey: true }), 'input', false)).toBeNull();
  });
```

  В `guest-shortcuts.test.ts`, в `describe('forwardGuestShortcuts (тест 7)', …)`:

```ts
  it('⌘⌥I и ⌘⌥J из страницы (спека 2026-10-07, 4.9) — гасятся в госте и уходят окну', () => {
    const guest = fakeGuest();
    const send = vi.fn<(id: ActionId) => void>();
    forwardGuestShortcuts(guest.contents, send);
    expect(guest.input({ key: 'ˆ', code: 'KeyI', meta: true, alt: true })).toBe(true);
    expect(guest.input({ key: '∆', code: 'KeyJ', meta: true, alt: true })).toBe(true);
    expect(send.mock.calls.map(([id]) => id)).toEqual(['browser.devtools', 'browser.console']);
  });
```

  В `menu.test.ts`, в тесте «у browser.*, tab.goto.N и tab.mru* пунктов нет…», в массив отсутствующих подписей дописать `'Toggle console and network'`, `'Show console'`.

  В `palette/actions.test.ts`:
  - импорт `import { useDevtoolsStore } from '../browser/devtools/store.js';`;
  - в `describe('runAction — таблица по реестру (тест 1 куска 6.3)', …)` вторым `beforeEach`: `beforeEach(() => useDevtoolsStore.setState({ tabs: {} }));`;
  - в таблицу функции `expectation` после `'browser.zoomReset'`:

```ts
    // Спека 2026-10-07, 4.3: панель вкладки браузера активной группы.
    'browser.devtools': () => expect(useDevtoolsStore.getState().tabs[BROWSER_TAB]?.open).toBe(true),
    'browser.console': () => expect(useDevtoolsStore.getState().tabs[BROWSER_TAB]).toMatchObject({ open: true, view: 'console' }),
```

  - в конец файла:

```ts
describe('панель браузера (спека 2026-10-07, 4.3)', () => {
  beforeEach(() => useDevtoolsStore.setState({ tabs: {} }));

  it('browser.devtools дважды — спрятана; browser.console — открыта на Console; без страницы — ничего', () => {
    const spies = makeContext();
    runAction('browser.devtools', spies.ctx);
    runAction('browser.devtools', spies.ctx);
    expect(useDevtoolsStore.getState().tabs[BROWSER_TAB]?.open).toBe(false);
    useDevtoolsStore.getState().show(BROWSER_TAB, 'network');
    runAction('browser.console', spies.ctx);
    expect(useDevtoolsStore.getState().tabs[BROWSER_TAB]).toMatchObject({ open: true, view: 'console' });
    useDevtoolsStore.setState({ tabs: {} });
    runAction('browser.devtools', makeContext({ browser: false }).ctx);
    expect(useDevtoolsStore.getState().tabs).toEqual({});
  });
});
```

- [ ] **Шаг 2. Запустить — падает.**

  `pnpm --filter @parley/desktop exec vitest run src/shared/keybindings.test.ts src/renderer/keys/handler.test.ts src/main/guest-shortcuts.test.ts src/main/menu.test.ts src/renderer/palette/actions.test.ts` → FAIL: в `ACTIONS` нет `browser.devtools` и `browser.console`, у `runAction` нет ветки.

- [ ] **Шаг 3. Реализовать строки.** В `shared/strings.ts`, в `browser: { … }` после `pickAgain: 'Pick again',`:

```ts
    /**
     * Панель Console | Network и кнопка строки (спека 2026-10-07-browser-devtools-agent-design.md, 4.1, 4.3, 4.4).
     * Сообщения, адреса, заголовки и тела страницы — данные, идут как есть.
     */
    devtools: {
      toggle: 'Console and network',
      console: 'Console',
      network: 'Network',
      more: 'More browser actions',
      openFull: 'Open full DevTools',
      clearAll: 'Clear console and network',
      preserveLog: 'Preserve log',
      clear: 'Clear',
      close: 'Close panel',
      resize: 'Resize panel',
      levels: { error: 'Errors', warning: 'Warnings', info: 'Info', debug: 'Debug' },
      filterConsole: 'Filter',
      filterUrl: 'Filter URL',
      kinds: { all: 'All', fetch: 'Fetch/XHR', doc: 'Doc', js: 'JS', css: 'CSS', img: 'Img', other: 'Other' },
      failedOnly: 'Failed only',
      errors: (count: number): string => `${count} ${count === 1 ? 'error' : 'errors'}`,
      warnings: (count: number): string => `${count} ${count === 1 ? 'warning' : 'warnings'}`,
      repeated: (count: number): string => `×${count}`,
      expand: 'Show stack',
      collapse: 'Hide stack',
      /** Слоты этапа B (спека 4.3–4.5): кнопки есть, только когда передан колбэк доставки. */
      addToChat: 'Add to chat',
      addErrorsToChat: 'Add errors to chat',
      navigatedTo: (url: string): string => `Navigated to ${url}`,
      navigated: 'Navigated to a new page',
      empty: 'No messages',
      emptyNetwork: 'No requests',
      late: 'Reload to capture earlier requests',
      unavailable: 'Capture unavailable — reload the page',
      columns: { status: 'Status', method: 'Method', name: 'Name', type: 'Type', size: 'Size', time: 'Time' },
      status: { cors: 'CORS', blocked: 'blocked', failed: 'failed', canceled: '(canceled)', pending: '(pending)' },
      fromCache: '(cache)',
      bytes: (bytes: number): string =>
        bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} kB` : `${(bytes / 1_048_576).toFixed(1)} MB`,
      ms: (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`),
      details: {
        headers: 'Headers',
        payload: 'Payload',
        response: 'Response',
        general: 'General',
        responseHeaders: 'Response headers',
        requestHeaders: 'Request headers',
        url: 'URL',
        method: 'Method',
        status: 'Status',
        remoteAddress: 'Remote address',
        query: 'Query',
        body: 'Body',
        noPayload: 'No payload',
        loadResponse: 'Load response',
        loading: 'Loading…',
        bodyGone: 'Body is no longer available',
        truncated: (limit: string): string => `Showing the first ${limit}`,
        binary: (size: string, type: string): string => (type === '' ? `Binary data, ${size}` : `Binary data, ${size}, ${type}`),
        copyUrl: 'Copy URL',
        close: 'Close details',
      },
    },
    /** Меню размера вкладки и подпись поля (спека 2026-10-07, 4.2). */
    viewport: {
      menu: 'Viewport size',
      fit: 'Fit',
      presets: {
        'mobile-s': 'Mobile S',
        'mobile-m': 'Mobile M',
        'mobile-l': 'Mobile L',
        tablet: 'Tablet',
        laptop: 'Laptop',
        desktop: 'Desktop',
      },
      size: (width: number, height: number): string => `${width}×${height}`,
      custom: 'Custom…',
      rotate: 'Rotate',
      dpr: (dpr: number): string => `${dpr}x`,
      width: 'Width',
      height: 'Height',
      apply: 'Apply',
      customRange: (min: number, maxWidth: number, maxHeight: number): string =>
        `Width ${min}–${maxWidth}, height ${min}–${maxHeight}`,
      label: (width: number, height: number, dpr: number, percent: number | null): string =>
        `${width} × ${height} · ${dpr}x${percent === null ? '' : ` · ${percent}%`}`,
      /** Касания включаются с новым документом (спайк 0.3). */
      touchReload: 'Reload to apply touch',
    },
```

  В `actions: { … }` после `actualSize: 'Actual size',`:

```ts
    toggleDevtools: 'Toggle console and network',
    showConsole: 'Show console',
```

  В `errors.actions` после `pickElement: 'pick element',`:

```ts
      setViewport: 'set the viewport size',
      clearDevtools: 'clear console and network',
      loadResponse: 'load the response',
```

- [ ] **Шаг 4. Реализовать клавиши и действия.**
  - **`shared/keybindings.ts`:**
    - последнюю строку `ActionId` заменить на две:

```ts
  | 'browser.find' | 'browser.zoomIn' | 'browser.zoomOut' | 'browser.zoomReset' // when: 'browser', menu: null
  | 'browser.devtools' | 'browser.console'; // when: 'browser', menu: null (спека 2026-10-07, 4.9)
```

    - в `ACTIONS` после записи `browser.zoomReset`:

```ts
  // Панель Console | Network вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, 4.3, 4.9). Из
  // страницы их пересылает main; с фокусом в строке и панели вкладки — её обработчик (`BrowserSurface`): рендерер окна
  // действия `browser` не ловит.
  { id: 'browser.devtools', title: S.actions.toggleDevtools, keywords: ['browser', 'devtools', 'console', 'network', 'inspect'], keys: 'CmdOrCtrl+Alt+I', menu: null, when: 'browser', inPalette: true },
  { id: 'browser.console', title: S.actions.showConsole, keywords: ['browser', 'devtools', 'console', 'logs'], keys: 'CmdOrCtrl+Alt+J', menu: null, when: 'browser', inPalette: true },
```

  - **`keys/handler.ts`:** в `IMPLEMENTED_ACTIONS` после `'browser.zoomReset',` дописать `'browser.devtools',` и `'browser.console',`.
  - **`palette/actions.ts`:**
    - импорт `import { useDevtoolsStore } from '../browser/devtools/store.js';`;
    - в `runAction` сразу после блока `if (zoom !== undefined || id === 'browser.find') { … }`:

```ts
  // Панель Console | Network (спека 2026-10-07, 4.3): ⌘⌥I — показать или спрятать, ⌘⌥J — сразу на Console. Цель — та
  // же вкладка браузера активной группы; без страницы — ничего.
  if (id === 'browser.devtools' || id === 'browser.console') {
    const page = ctx.browser.active();
    if (page === null) return;
    if (id === 'browser.devtools') useDevtoolsStore.getState().toggle(page.tabId);
    else useDevtoolsStore.getState().show(page.tabId, 'console');
    return;
  }
```

- [ ] **Шаг 5. Запустить — проходит.**
  - Команда шага 2 → PASS.
  - `pnpm --filter @parley/desktop exec vitest run src/english-ui.test.ts src/shared/strings.test.ts` → PASS.
  - `pnpm --filter @parley/desktop typecheck` → без ошибок.

- [ ] **Шаг 6. Закоммитить.**

```bash
git add packages/desktop/src/shared/strings.ts packages/desktop/src/shared/keybindings.ts packages/desktop/src/shared/keybindings.test.ts packages/desktop/src/renderer/keys packages/desktop/src/renderer/palette packages/desktop/src/main/guest-shortcuts.test.ts packages/desktop/src/main/menu.test.ts
git commit -m "feat(desktop): клавиши ⌘⌥I и ⌘⌥J панели браузера, строки консоли, сети и размеров" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 11. Console: форматы, фильтры, строки

**Файлы:**
- Создать:
  - `packages/desktop/src/renderer/browser/devtools/format.ts` — чистые функции текста панели, их делят Console, Network и детали;
  - `packages/desktop/src/renderer/browser/devtools/controls.tsx` — кнопки и поле фильтров;
  - `packages/desktop/src/renderer/browser/devtools/ConsoleView.tsx`.
- Тесты: `packages/desktop/src/renderer/browser/devtools/format.test.ts`, `packages/desktop/src/renderer/browser/devtools/ConsoleView.test.tsx`

**Интерфейсы:**
- Берёт: `useDevtoolsStore`, `visibleConsole`, `documentUrl`, `EMPTY_DEVTOOLS` (задача 9); `S.browser.devtools`, `S.common.copy` (задача 10); `cn` (`renderer/lib/cn.ts`).
- Отдаёт:
  - `format.ts`:
    - консоль: `frameText`, `consoleCopyText`, `sourceLabel`;
    - сеть: `StatusTone`, `statusCell`, `nameParts`, `sizeText`;
    - тела и заголовки: `prettyJson`, `base64Bytes`, `queryParams`, `formFields`, `headerValue`;
  - `controls.tsx`: `FilterToggle`, `FilterInput`, `PanelIconButton`;
  - `ConsoleView({ tabId, onAddToChat? })`. Строка — `[data-console-row=<id>][data-level=<уровень>]`, разделитель — `[data-console-nav]`.

- [ ] **Шаг 1. Написать падающие тесты.**

```ts
// packages/desktop/src/renderer/browser/devtools/format.test.ts
import { describe, expect, it } from 'vitest';
import { consoleEntry, networkEntry } from '../../test-utils/devtools-fixtures.js';
import {
  base64Bytes,
  consoleCopyText,
  formFields,
  headerValue,
  nameParts,
  prettyJson,
  queryParams,
  sizeText,
  sourceLabel,
  statusCell,
} from './format.js';

const APP = 'http://localhost:5173/src/app.js';

describe('строки консоли (спека 4.3)', () => {
  it('sourceLabel — файл:строка; без файла — хост; не адрес — как есть', () => {
    expect(sourceLabel({ url: APP, line: 10, column: 5 })).toBe('app.js:10');
    expect(sourceLabel({ url: 'http://localhost:5173/', line: 1, column: 1 })).toBe('localhost:5173:1');
    expect(sourceLabel({ url: 'eval', line: 3, column: 1 })).toBe('eval:3');
  });

  it('consoleCopyText — текст и кадры «at fn (url:строка:столбец)»', () => {
    expect(consoleCopyText(consoleEntry(1, { text: 'Uncaught Error: boom', stack: [{ fn: 'save', url: APP, line: 10, column: 5 }] }))).toBe(
      `Uncaught Error: boom\n    at save (${APP}:10:5)`,
    );
  });
});

describe('ячейки Network (спека 4.4)', () => {
  it('statusCell: отказ важнее кода; без ответа — (pending)', () => {
    expect(statusCell(networkEntry('a', { status: 500 }))).toEqual({ text: '500', tone: 'error' });
    expect(statusCell(networkEntry('a', { status: 304 }))).toEqual({ text: '304', tone: 'normal' });
    expect(statusCell(networkEntry('a', { status: 200, failure: { reason: 'cors', text: 'X' } }))).toEqual({ text: 'CORS', tone: 'error' });
    expect(statusCell(networkEntry('a', { status: null, failure: { reason: 'blocked', text: 'csp' } }))).toEqual({ text: 'blocked', tone: 'error' });
    expect(statusCell(networkEntry('a', { status: null, failure: { reason: 'net', text: 'net::ERR_CONNECTION_REFUSED' } }))).toEqual({ text: 'failed', tone: 'error' });
    expect(statusCell(networkEntry('a', { status: null, failure: { reason: 'canceled', text: '' } }))).toEqual({ text: '(canceled)', tone: 'muted' });
    expect(statusCell(networkEntry('a', { status: null }))).toEqual({ text: '(pending)', tone: 'muted' });
  });

  it('nameParts: свой origin — путь и query; чужой — ещё хост; не адрес — как есть', () => {
    expect(nameParts('http://localhost:5173/api/x?q=1', 'http://localhost:5173/page')).toEqual({ path: '/api/x?q=1', host: null });
    expect(nameParts('http://127.0.0.1:9/data', 'http://localhost:5173/')).toEqual({ path: '/data', host: '127.0.0.1:9' });
    expect(nameParts('not a url', 'http://localhost:5173/')).toEqual({ path: 'not a url', host: null });
  });

  it('sizeText: из кэша — (cache); B, kB, MB; неизвестен — тире', () => {
    expect(sizeText(networkEntry('a', { fromCache: true }))).toBe('(cache)');
    expect(sizeText(networkEntry('a', { encodedBytes: 512 }))).toBe('512 B');
    expect(sizeText(networkEntry('a', { encodedBytes: 2048 }))).toBe('2.0 kB');
    expect(sizeText(networkEntry('a', { encodedBytes: 3_145_728 }))).toBe('3.0 MB');
    expect(sizeText(networkEntry('a', { encodedBytes: null }))).toBe('—');
  });
});

describe('тела и заголовки (спека 4.4)', () => {
  it('prettyJson: JSON — с отступами; не JSON — null', () => {
    expect(prettyJson('{"a":[1]}')).toBe('{\n  "a": [\n    1\n  ]\n}');
    expect(prettyJson('<html>')).toBeNull();
  });

  it('base64Bytes: три байта на четыре знака без добивки', () => {
    expect(base64Bytes('AAAA')).toBe(3);
    expect(base64Bytes('AAA=')).toBe(2);
    expect(base64Bytes('AA==')).toBe(1);
  });

  it('queryParams и formFields — пары по порядку; headerValue — без учёта регистра имени', () => {
    expect(queryParams('http://x/a?tab=1&q=two%20words')).toEqual([
      ['tab', '1'],
      ['q', 'two words'],
    ]);
    expect(queryParams('not a url')).toEqual([]);
    expect(formFields('name=Ann&age=30')).toEqual([
      ['name', 'Ann'],
      ['age', '30'],
    ]);
    expect(headerValue([['Content-Type', 'application/json']], 'content-type')).toBe('application/json');
    expect(headerValue([], 'content-type')).toBeNull();
  });
});
```

```tsx
// packages/desktop/src/renderer/browser/devtools/ConsoleView.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ConsoleEntry } from '../../../shared/browser-devtools.js';
import { consoleEntry, networkEntry } from '../../test-utils/devtools-fixtures.js';
import { ConsoleView } from './ConsoleView.js';
import { EMPTY_DEVTOOLS, useDevtoolsStore, type TabDevtools } from './store.js';

const TAB = 'browser:0000c1';
const APP = 'http://localhost:5173/src/app.js';

const BOOM = consoleEntry(1, {
  level: 'error',
  origin: 'exception',
  text: 'Uncaught Error: boom',
  location: { url: APP, line: 10, column: 5 },
  stack: [
    { fn: 'save', url: APP, line: 10, column: 5 },
    { fn: 'click', url: APP, line: 3, column: 1 },
  ],
});
const HELLO = consoleEntry(3, {
  text: "hello {theme: 'dark', items: Array(12)}",
  location: { url: APP, line: 2, column: 1 },
  stack: [{ fn: 'run', url: APP, line: 2, column: 1 }],
});
const ENTRIES: ConsoleEntry[] = [
  BOOM,
  consoleEntry(2, { level: 'warning', text: 'careful', count: 3 }),
  HELLO,
  consoleEntry(4, { level: 'debug', text: 'trace details' }),
];

function seed(patch: Partial<TabDevtools>): void {
  useDevtoolsStore.setState({ tabs: { [TAB]: { ...EMPTY_DEVTOOLS, ...patch } } });
}

function rowIds(): Array<string | null> {
  return [...document.querySelectorAll('[data-console-row]')].map((row) => row.getAttribute('data-console-row'));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useDevtoolsStore.setState({ tabs: {} });
});

describe('ConsoleView (спека 4.3)', () => {
  it('строки: уровень, предпросмотр объекта, ×N, источник файл:строка с полным адресом в подсказке; Debug скрыт', () => {
    seed({ console: ENTRIES });
    render(<ConsoleView tabId={TAB} />);
    expect([...document.querySelectorAll('[data-console-row]')].map((row) => row.getAttribute('data-level'))).toEqual(['error', 'warning', 'info']);
    expect(screen.getByText("hello {theme: 'dark', items: Array(12)}")).toBeTruthy();
    expect(screen.getByTestId('console-count').textContent).toBe('×3');
    expect(screen.getByText('app.js:2').getAttribute('title')).toBe(APP);
  });

  it('уровни: Debug показывает отладку, Errors прячет ошибки; фильтр — подстрока без учёта регистра', () => {
    seed({ console: ENTRIES });
    render(<ConsoleView tabId={TAB} />);
    fireEvent.click(screen.getByRole('button', { name: 'Debug' }));
    expect(screen.getByText('trace details')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Errors' }));
    expect(screen.queryByText('Uncaught Error: boom')).toBeNull();
    expect(screen.getByRole('button', { name: 'Errors' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter' }), { target: { value: 'CAREF' } });
    expect(rowIds()).toEqual(['2']);
  });

  it('ошибка со стеком раскрывается кадрами; многострочное описание — остальными строками; у info раскрытия нет', () => {
    seed({ console: [BOOM, consoleEntry(5, { level: 'error', text: 'Error: broken\n    at x (a.js:1:1)' }), HELLO] });
    render(<ConsoleView tabId={TAB} />);
    const toggles = screen.getAllByRole('button', { name: 'Show stack' });
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[0] as HTMLElement);
    expect(screen.getByTestId('console-stack').textContent).toBe(`    at save (${APP}:10:5)\n    at click (${APP}:3:1)`);
    fireEvent.click(screen.getByRole('button', { name: 'Hide stack' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Show stack' })[1] as HTMLElement);
    expect(screen.getByTestId('console-stack').textContent).toBe('    at x (a.js:1:1)');
  });

  it('Copy — текст и стек в буфер; Add to chat — только с колбэком этапа B', () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    seed({ console: [BOOM] });
    const { rerender } = render(<ConsoleView tabId={TAB} />);
    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(`Uncaught Error: boom\n    at save (${APP}:10:5)\n    at click (${APP}:3:1)`);
    const onAddToChat = vi.fn();
    rerender(<ConsoleView tabId={TAB} onAddToChat={onAddToChat} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
    expect(onAddToChat).toHaveBeenCalledWith(BOOM);
  });

  it('без Preserve log — только текущая страница; с ним — все и разделитель «Navigated to» с адресом документа', () => {
    const entries = [consoleEntry(1, { epoch: 0, text: 'first page' }), consoleEntry(2, { epoch: 1, text: 'second page' })];
    const network = [networkEntry('doc', { epoch: 1, kind: 'document', url: 'http://localhost:5173/next' })];
    seed({ epoch: 1, console: entries, network });
    const { unmount } = render(<ConsoleView tabId={TAB} />);
    expect(screen.queryByText('first page')).toBeNull();
    expect(document.querySelector('[data-console-nav]')).toBeNull();
    unmount();
    seed({ epoch: 1, console: entries, network, preserve: true });
    render(<ConsoleView tabId={TAB} />);
    expect(screen.getByText('first page')).toBeTruthy();
    expect(document.querySelector('[data-console-nav]')?.textContent).toBe('Navigated to http://localhost:5173/next');
  });

  it('пусто — No messages', () => {
    seed({});
    render(<ConsoleView tabId={TAB} />);
    expect(screen.getByText('No messages')).toBeTruthy();
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/renderer/browser/devtools/format.test.ts src/renderer/browser/devtools/ConsoleView.test.tsx` → FAIL: `Failed to resolve import "./format.js"`, `"./ConsoleView.js"`.

- [ ] **Шаг 3. Реализовать форматы.**

```ts
// packages/desktop/src/renderer/browser/devtools/format.ts
/**
 * Текст панели Console | Network из записей журнала (спека 2026-10-07-browser-devtools-agent-design.md, 4.3, 4.4):
 * источник `файл:строка`, текст «Copy», ячейки Status, Name и Size, отформатированный JSON, query и поля form-тела.
 * Чистые функции — их делят виды панели и детали запроса.
 */
import type { ConsoleEntry, NetworkEntry, StackFrame } from '../../../shared/browser-devtools.js';
import { S } from '../../../shared/strings.js';

export function frameText(frame: StackFrame): string {
  return `    at ${frame.fn} (${frame.url}:${frame.line}:${frame.column})`;
}

/** Текст строки для «Copy»: сообщение и кадры стека. */
export function consoleCopyText(entry: ConsoleEntry): string {
  return [entry.text, ...entry.stack.map(frameText)].join('\n');
}

/** `app.js:10` — имя файла и строка; без файла — хост; полный адрес — в подсказке строки. */
export function sourceLabel(location: NonNullable<ConsoleEntry['location']>): string {
  try {
    const url = new URL(location.url);
    const name = url.pathname.split('/').filter((part) => part !== '').at(-1) ?? url.host;
    return `${name}:${location.line}`;
  } catch {
    return `${location.url}:${location.line}`;
  }
}

export type StatusTone = 'error' | 'muted' | 'normal';

/** Ячейка Status (спека 4.4): отказ важнее кода — CORS, blocked, failed красным, (canceled) серым; без ответа — (pending). */
export function statusCell(entry: NetworkEntry): { text: string; tone: StatusTone } {
  const status = S.browser.devtools.status;
  if (entry.failure !== null) {
    switch (entry.failure.reason) {
      case 'cors':
        return { text: status.cors, tone: 'error' };
      case 'blocked':
        return { text: status.blocked, tone: 'error' };
      case 'canceled':
        return { text: status.canceled, tone: 'muted' };
      default:
        return { text: status.failed, tone: 'error' };
    }
  }
  if (entry.status === null) return { text: status.pending, tone: 'muted' };
  return { text: String(entry.status), tone: entry.status >= 400 ? 'error' : 'normal' };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Ячейка Name: путь и query; хост — только у чужого origin (спека 4.4). */
export function nameParts(url: string, pageUrl: string): { path: string; host: string | null } {
  try {
    const target = new URL(url);
    return { path: `${target.pathname}${target.search}`, host: target.origin === originOf(pageUrl) ? null : target.host };
  } catch {
    return { path: url, host: null };
  }
}

export function sizeText(entry: NetworkEntry): string {
  if (entry.fromCache) return S.browser.devtools.fromCache;
  return entry.encodedBytes === null ? '—' : S.browser.devtools.bytes(entry.encodedBytes);
}

/** JSON — с отступом в два пробела; не JSON — null (текст показывается как есть). */
export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return null;
  }
}

/** Байт в теле base64: три на четыре знака без добивки `=`. */
export function base64Bytes(text: string): number {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

export function queryParams(url: string): Array<[string, string]> {
  try {
    return [...new URL(url).searchParams.entries()];
  } catch {
    return [];
  }
}

export function formFields(text: string): Array<[string, string]> {
  return [...new URLSearchParams(text).entries()];
}

/** Значение заголовка без учёта регистра имени; нет — null. */
export function headerValue(headers: ReadonlyArray<[string, string]>, name: string): string | null {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
}
```

- [ ] **Шаг 4. Реализовать кнопки фильтров.**

```tsx
// packages/desktop/src/renderer/browser/devtools/controls.tsx
/**
 * Кнопки и поле фильтров панели Console | Network (спека 2026-10-07-browser-devtools-agent-design.md, 4.3, 4.4):
 * переключатель с `aria-pressed`, поле поиска и значок-кнопка. Цвета — те же токены, что у кнопок строки вкладки
 * (`BrowserChrome.tsx`).
 */
import type { ReactNode } from 'react';

export function FilterToggle({ pressed, onClick, children }: { pressed: boolean; onClick(): void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className="h-5 shrink-0 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
    >
      {children}
    </button>
  );
}

export function FilterInput({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }): JSX.Element {
  return (
    <input
      type="search"
      aria-label={label}
      placeholder={label}
      spellCheck={false}
      autoComplete="off"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-5 min-w-0 flex-1 basis-24 rounded border border-input bg-background px-1.5 text-[11px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

/** Значок-кнопка панели: подпись — для скринридера и подсказки. */
export function PanelIconButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
    >
      {children}
    </button>
  );
}
```

- [ ] **Шаг 5. Реализовать Console.**

```tsx
// packages/desktop/src/renderer/browser/devtools/ConsoleView.tsx
/**
 * Вид Console панели вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, 4.3).
 * - Шапка: уровни и фильтр по тексту.
 * - Строка: значок уровня, текст моноширинным, `×N` повторов, источник `файл:строка`; у ошибки со стеком — раскрытие.
 *   Объекты приходят из main кратким предпросмотром CDP — текстом.
 * - По наведению — «Copy»; «Add to chat» — слот этапа B (`onAddToChat`): без колбэка кнопки нет.
 * - С «Preserve log» между страницами — разделитель «Navigated to …».
 * - Новые записи прокручивают список, пока человек не ушёл выше.
 */
import { ChevronDown, ChevronRight, CircleX, Copy, Info, TriangleAlert } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleEntry, ConsoleLevel } from '../../../shared/browser-devtools.js';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { FilterInput, FilterToggle, PanelIconButton } from './controls.js';
import { consoleCopyText, frameText, sourceLabel } from './format.js';
import { documentUrl, EMPTY_DEVTOOLS, useDevtoolsStore, visibleConsole } from './store.js';

const LEVELS: readonly ConsoleLevel[] = ['error', 'warning', 'info', 'debug'];
/** Ближе этого к низу список прижат: новые записи его прокручивают. */
const STICK_PX = 16;

const ROW_TONE: Readonly<Record<ConsoleLevel, string>> = {
  error: 'bg-destructive/5 text-destructive',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  info: 'text-foreground',
  debug: 'text-muted-foreground',
};

function LevelIcon({ level }: { level: ConsoleLevel }): JSX.Element {
  if (level === 'error') return <CircleX className="mt-0.5 size-3 shrink-0" aria-hidden="true" />;
  if (level === 'warning') return <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />;
  if (level === 'info') return <Info className="mt-0.5 size-3 shrink-0 opacity-40" aria-hidden="true" />;
  return <span className="w-3 shrink-0" aria-hidden="true" />;
}

function ConsoleRow({ entry, onAddToChat }: { entry: ConsoleEntry; onAddToChat: ((entry: ConsoleEntry) => void) | undefined }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [first = '', ...rest] = entry.text.split('\n');
  // Раскрытие — у ошибки со стеком (спека 4.3): остальные строки описания, а без них — кадры стека.
  const expandable = entry.level === 'error' && (rest.length > 0 || entry.stack.length > 1);
  const copy = (): void => {
    navigator.clipboard.writeText(consoleCopyText(entry)).catch((error: unknown) => console.warn('[parley] clipboard', error));
  };
  return (
    <div
      data-console-row={entry.id}
      data-level={entry.level}
      className={cn('group relative flex items-start gap-1.5 border-b border-border/60 px-2 py-0.5', ROW_TONE[entry.level])}
    >
      {expandable ? (
        <button
          type="button"
          aria-label={open ? S.browser.devtools.collapse : S.browser.devtools.expand}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="mt-0.5 shrink-0 rounded hover:bg-accent"
        >
          {open ? <ChevronDown className="size-3" aria-hidden="true" /> : <ChevronRight className="size-3" aria-hidden="true" />}
        </button>
      ) : (
        <span className="w-3 shrink-0" aria-hidden="true" />
      )}
      <LevelIcon level={entry.level} />
      <div className="min-w-0 flex-1">
        <div className="whitespace-pre-wrap break-words">{first}</div>
        {open ? (
          <pre data-testid="console-stack" className="whitespace-pre-wrap break-words opacity-80">
            {rest.length > 0 ? rest.join('\n') : entry.stack.map(frameText).join('\n')}
          </pre>
        ) : null}
      </div>
      {entry.count > 1 ? (
        <span data-testid="console-count" className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
          {S.browser.devtools.repeated(entry.count)}
        </span>
      ) : null}
      {entry.location === null ? null : (
        <span className="max-w-[40%] shrink-0 truncate text-muted-foreground" title={entry.location.url}>
          {sourceLabel(entry.location)}
        </span>
      )}
      <div className="absolute right-1 top-0 hidden items-center gap-1 rounded bg-card px-1 shadow-sm group-focus-within:flex group-hover:flex">
        {onAddToChat === undefined ? null : (
          <button type="button" onClick={() => onAddToChat(entry)} className="h-5 shrink-0 rounded px-1.5 text-[11px] text-foreground hover:bg-accent">
            {S.browser.devtools.addToChat}
          </button>
        )}
        <PanelIconButton label={S.common.copy} onClick={copy}>
          <Copy className="size-3" aria-hidden="true" />
        </PanelIconButton>
      </div>
    </div>
  );
}

export interface ConsoleViewProps {
  tabId: string;
  /** «Add to chat» строки — этап B (спека 4.3, 4.5); нет колбэка — нет кнопки. */
  onAddToChat?: ((entry: ConsoleEntry) => void) | undefined;
}

type ConsoleItem = { kind: 'entry'; entry: ConsoleEntry } | { kind: 'nav'; epoch: number; url: string | null };

export function ConsoleView({ tabId, onAddToChat }: ConsoleViewProps): JSX.Element {
  const tab = useDevtoolsStore((state) => state.tabs[tabId]) ?? EMPTY_DEVTOOLS;
  const patch = useDevtoolsStore.getState().patch;
  const items = useMemo((): ConsoleItem[] => {
    const result: ConsoleItem[] = [];
    let epoch: number | null = null;
    for (const entry of visibleConsole(tab)) {
      // Прежние страницы видны только с «Preserve log»: между ними — разделитель (спека 4.3).
      if (epoch !== null && entry.epoch !== epoch) result.push({ kind: 'nav', epoch: entry.epoch, url: documentUrl(tab, entry.epoch) });
      epoch = entry.epoch;
      result.push({ kind: 'entry', entry });
    }
    return result;
  }, [tab]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node !== null && stick.current) node.scrollTop = node.scrollHeight;
  }, [items]);

  return (
    <div data-testid="console-view" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-1.5 py-1">
        {LEVELS.map((level) => (
          <FilterToggle
            key={level}
            pressed={tab.levels[level]}
            onClick={() => patch(tabId, { levels: { ...tab.levels, [level]: !tab.levels[level] } })}
          >
            {S.browser.devtools.levels[level]}
          </FilterToggle>
        ))}
        <FilterInput label={S.browser.devtools.filterConsole} value={tab.consoleText} onChange={(value) => patch(tabId, { consoleText: value })} />
      </div>
      <div
        ref={scrollRef}
        role="log"
        onScroll={() => {
          const node = scrollRef.current;
          if (node !== null) stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_PX;
        }}
        className="min-h-0 flex-1 overflow-y-auto font-mono text-[11px] leading-4"
      >
        {items.length === 0 ? (
          <div className="p-2 text-muted-foreground">{S.browser.devtools.empty}</div>
        ) : (
          items.map((item) =>
            item.kind === 'nav' ? (
              <div key={`nav-${item.epoch}`} data-console-nav className="border-b border-border bg-muted/50 px-2 py-0.5 text-muted-foreground">
                {item.url === null ? S.browser.devtools.navigated : S.browser.devtools.navigatedTo(item.url)}
              </div>
            ) : (
              <ConsoleRow key={item.entry.id} entry={item.entry} onAddToChat={onAddToChat} />
            ),
          )
        )}
      </div>
    </div>
  );
}
```

- [ ] **Шаг 6. Запустить — проходит.** Команда шага 2 → PASS (14 тестов). Затем:
  - `pnpm --filter @parley/desktop exec vitest run src/english-ui.test.ts` → PASS;
  - `pnpm --filter @parley/desktop typecheck` → без ошибок.

- [ ] **Шаг 7. Закоммитить.**

```bash
git add packages/desktop/src/renderer/browser/devtools
git commit -m "feat(desktop): вид Console панели браузера — уровни, фильтр, повторы, стек, Copy" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 12. Network и детали запроса

**Файлы:**
- Создать: `packages/desktop/src/renderer/browser/devtools/NetworkView.tsx`, `packages/desktop/src/renderer/browser/devtools/RequestDetails.tsx`
- Тесты: `packages/desktop/src/renderer/browser/devtools/NetworkView.test.tsx`, `packages/desktop/src/renderer/browser/devtools/RequestDetails.test.tsx`

**Интерфейсы:**
- Берёт:
  - `format.ts`, `controls.tsx` (задача 11); `useDevtoolsStore`, `visibleNetwork` (задача 9);
  - `bridge.browser.responseBody` (задача 7);
  - `Tabs*` (`renderer/ui/tabs.tsx`), `useVirtualizer` (`@tanstack/react-virtual`, `initialRect` — как в `review/VirtualRows.tsx`);
  - `errorText`, `decodeIpcError`, `toast` (`sonner`).
- Отдаёт:
  - `NetworkView({ tabId, pageUrl, webContentsId, bridge, narrow, onAddToChat? })`. Строка — кнопка `[data-network-row=<requestId>][data-failed]`, ячейка статуса — `[data-tone]`, панель деталей — `[data-testid="request-details-pane"][data-overlay]`;
  - `RequestDetails({ entry, webContentsId, bridge, onClose, onAddToChat? })` — `[data-testid="request-details"]`, тело — `[data-testid="response-body"]`.

- [ ] **Шаг 1. Написать падающие тесты.**

```tsx
// packages/desktop/src/renderer/browser/devtools/NetworkView.test.tsx
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { NetworkEntry } from '../../../shared/browser-devtools.js';
import { networkEntry } from '../../test-utils/devtools-fixtures.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { NetworkView } from './NetworkView.js';
import { EMPTY_DEVTOOLS, useDevtoolsStore, type TabDevtools } from './store.js';

const TAB = 'browser:0000c1';
const PAGE = 'http://localhost:5173/';
let bridge: FakeBridge;

const ENTRIES: NetworkEntry[] = [
  networkEntry('doc', { kind: 'document', url: PAGE, mimeType: 'text/html' }),
  networkEntry('fail', { url: 'http://localhost:5173/api/fail?x=1', status: 500, statusText: 'Internal Server Error' }),
  networkEntry('cors', { url: 'http://127.0.0.1:9/data', status: null, failure: { reason: 'cors', text: 'MissingAllowOriginHeader' } }),
  networkEntry('cancel', { url: 'http://localhost:5173/abort', status: null, failure: { reason: 'canceled', text: 'net::ERR_ABORTED' } }),
  networkEntry('wait', { url: 'http://localhost:5173/slow', status: null, durationMs: null, encodedBytes: null }),
  networkEntry('img', { kind: 'image', url: 'http://localhost:5173/logo.png', fromCache: true }),
];

function seed(patch: Partial<TabDevtools> = {}): void {
  useDevtoolsStore.setState({ tabs: { [TAB]: { ...EMPTY_DEVTOOLS, network: ENTRIES, ...patch } } });
}

function rows(): string[] {
  return [...document.querySelectorAll('[data-network-row]')].map((row) => row.getAttribute('data-network-row') ?? '');
}

function row(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-network-row="${id}"]`);
  if (found === null) throw new Error(`нет строки ${id}`);
  return found;
}

function renderView(narrow = false): void {
  render(<NetworkView tabId={TAB} pageUrl={PAGE} webContentsId={7} bridge={bridge} narrow={narrow} />);
}

beforeEach(() => {
  bridge = createFakeBridge();
});

afterEach(() => {
  cleanup();
  useDevtoolsStore.setState({ tabs: {} });
});

describe('NetworkView (спека 4.4)', () => {
  it('строки по времени начала; Status: 500 и CORS красным, (canceled) и (pending) серым', () => {
    seed();
    renderView();
    expect(rows()).toEqual(['doc', 'fail', 'cors', 'cancel', 'wait', 'img']);
    const tone = (id: string): [string, string | null] => {
      const cell = row(id).querySelector('[data-tone]');
      return [cell?.textContent ?? '', cell?.getAttribute('data-tone') ?? null];
    };
    expect(tone('doc')).toEqual(['200', 'normal']);
    expect(tone('fail')).toEqual(['500', 'error']);
    expect(tone('cors')).toEqual(['CORS', 'error']);
    expect(tone('cancel')).toEqual(['(canceled)', 'muted']);
    expect(tone('wait')).toEqual(['(pending)', 'muted']);
    expect(row('fail').getAttribute('data-failed')).toBe('true');
  });

  it('Name — путь и query; хост — только у чужого origin; полный адрес — в подсказке; Size из кэша — (cache)', () => {
    seed();
    renderView();
    expect(row('fail').textContent).toContain('/api/fail?x=1');
    expect(row('fail').textContent).not.toContain('localhost:5173');
    expect(row('fail').getAttribute('title')).toBe('http://localhost:5173/api/fail?x=1');
    expect(row('cors').textContent).toContain('/data · 127.0.0.1:9');
    expect(row('img').textContent).toContain('(cache)');
  });

  it('фильтры Img, Failed only и URL — в стор вкладки', () => {
    seed();
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Img' }));
    expect(rows()).toEqual(['img']);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.click(screen.getByRole('button', { name: 'Failed only' }));
    expect(rows()).toEqual(['fail', 'cors']);
    fireEvent.click(screen.getByRole('button', { name: 'Failed only' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter URL' }), { target: { value: 'LOGO' } });
    expect(rows()).toEqual(['img']);
    expect(useDevtoolsStore.getState().tabs[TAB]?.urlText).toBe('LOGO');
  });

  it('выбор строки — детали рядом; на узкой панели — поверх списка; закрыть — выбор снят', () => {
    seed();
    renderView();
    fireEvent.click(row('fail'));
    expect(useDevtoolsStore.getState().tabs[TAB]?.selected).toBe('fail');
    expect(screen.getByTestId('request-details-pane').getAttribute('data-overlay')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(useDevtoolsStore.getState().tabs[TAB]?.selected).toBeNull();
    cleanup();
    seed({ selected: 'fail' });
    renderView(true);
    expect(screen.getByTestId('request-details-pane').getAttribute('data-overlay')).toBe('true');
  });

  it('пусто — No requests', () => {
    seed({ network: [] });
    renderView();
    expect(screen.getByText('No requests')).toBeTruthy();
  });
});
```

```tsx
// packages/desktop/src/renderer/browser/devtools/RequestDetails.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import type { NetworkEntry } from '../../../shared/browser-devtools.js';
import { networkEntry } from '../../test-utils/devtools-fixtures.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { RequestDetails } from './RequestDetails.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

let bridge: FakeBridge;

const FAILED = networkEntry('r1', {
  method: 'POST',
  url: 'http://localhost:5173/api/settings?tab=general&debug=1',
  status: 500,
  statusText: 'Internal Server Error',
  mimeType: 'application/json',
  remoteAddress: '127.0.0.1:5173',
  requestHeaders: [
    ['Content-Type', 'application/json'],
    ['Authorization', 'Bearer secret-token'],
  ],
  responseHeaders: [['content-type', 'application/json']],
  hasPostData: true,
  postData: '{"theme":"dark","items":[1,2]}',
});

function renderDetails(entry: NetworkEntry = FAILED, extra: { onAddToChat?: (entry: NetworkEntry) => void } = {}): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn();
  render(<RequestDetails entry={entry} webContentsId={7} bridge={bridge} onClose={onClose} {...extra} />);
  return { onClose };
}

async function openResponse(): Promise<void> {
  await act(async () => {
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Response' }));
  });
}

beforeEach(() => {
  bridge = createFakeBridge();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(toast).mockClear();
});

describe('RequestDetails — Headers и Payload (спека 4.4)', () => {
  it('Headers: General, заголовки ответа и запроса — как есть, без маски', () => {
    renderDetails();
    const text = screen.getByTestId('request-details').textContent ?? '';
    expect(text).toContain('URL:http://localhost:5173/api/settings?tab=general&debug=1');
    expect(text).toContain('Method:POST');
    expect(text).toContain('Status:500 Internal Server Error');
    expect(text).toContain('Remote address:127.0.0.1:5173');
    expect(text).toContain('Authorization:Bearer secret-token');
  });

  it('Payload: query по параметрам, JSON-тело — отформатированным', () => {
    renderDetails();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Payload' }));
    const text = screen.getByTestId('request-details').textContent ?? '';
    expect(text).toContain('tab:general');
    expect(text).toContain('debug:1');
    expect(screen.getByTestId('request-body').textContent).toBe('{\n  "theme": "dark",\n  "items": [\n    1,\n    2\n  ]\n}');
  });

  it('Payload: form — по полям; без query и тела — No payload', () => {
    renderDetails(networkEntry('f', { requestHeaders: [['Content-Type', 'application/x-www-form-urlencoded']], postData: 'name=Ann&age=30', hasPostData: true }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Payload' }));
    expect(screen.getByTestId('request-details').textContent).toContain('name:Ann');
    expect(screen.getByTestId('request-details').textContent).toContain('age:30');
    cleanup();
    renderDetails(networkEntry('g'));
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Payload' }));
    expect(screen.getByText('No payload')).toBeTruthy();
  });
});

describe('RequestDetails — Response по клику (спека 4.4)', () => {
  it('Response — responseBody(id гостя, requestId); JSON — отформатированным', async () => {
    bridge.setResponseBody({ text: '{"error":"db down"}', base64: false, truncated: false });
    renderDetails();
    await openResponse();
    expect(bridge.browserCalls).toContainEqual({ method: 'responseBody', args: [7, 'r1'] });
    expect(screen.getByTestId('response-body').textContent).toBe('{\n  "error": "db down"\n}');
  });

  it('тела нет — Body is no longer available', async () => {
    renderDetails();
    await openResponse();
    expect(screen.getByTestId('response-gone').textContent).toBe('Body is no longer available');
  });

  it('бинарное — размер и тип; обрезанное — пометка «Showing the first 1.0 MB»', async () => {
    bridge.setResponseBody({ text: 'AAAAAAAAAAAA', base64: true, truncated: false });
    renderDetails(networkEntry('img', { mimeType: 'image/png' }));
    await openResponse();
    expect(screen.getByTestId('response-body').textContent).toBe('Binary data, 9 B, image/png');
    cleanup();
    bridge.setResponseBody({ text: 'x'.repeat(10), base64: false, truncated: true });
    renderDetails(networkEntry('big', { mimeType: 'text/plain' }));
    await openResponse();
    expect(screen.getByText('Showing the first 1.0 MB')).toBeTruthy();
  });

  it('отказ моста — тост и снова Load response', async () => {
    bridge.setResponseBody({ code: 'failed', message: 'boom' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderDetails();
    await openResponse();
    expect(toast).toHaveBeenCalledWith("Couldn't load the response: failed.");
    expect(screen.getByRole('button', { name: 'Load response' })).toBeTruthy();
  });

  it('другой запрос — снова Headers, тело не загружено', async () => {
    bridge.setResponseBody({ text: 'ok', base64: false, truncated: false });
    const onClose = vi.fn();
    const { rerender } = render(<RequestDetails entry={FAILED} webContentsId={7} bridge={bridge} onClose={onClose} />);
    await openResponse();
    expect(screen.getByTestId('response-body').textContent).toBe('ok');
    rerender(<RequestDetails entry={networkEntry('r2')} webContentsId={7} bridge={bridge} onClose={onClose} />);
    expect(screen.getByRole('tab', { name: 'Headers' }).getAttribute('data-state')).toBe('active');
    expect(screen.queryByTestId('response-body')).toBeNull();
  });
});

describe('RequestDetails — действия', () => {
  it('Copy URL — адрес в буфер; закрыть — onClose; Add to chat — только с колбэком этапа B', () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const onAddToChat = vi.fn();
    const { onClose } = renderDetails(FAILED, { onAddToChat });
    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    expect(writeText).toHaveBeenCalledWith(FAILED.url);
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
    expect(onAddToChat).toHaveBeenCalledWith(FAILED);
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    renderDetails();
    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull();
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/renderer/browser/devtools/NetworkView.test.tsx src/renderer/browser/devtools/RequestDetails.test.tsx` → FAIL: модулей нет.

- [ ] **Шаг 3. Реализовать детали.**

```tsx
// packages/desktop/src/renderer/browser/devtools/RequestDetails.tsx
/**
 * Детали запроса панели Network (спека 2026-10-07-browser-devtools-agent-design.md, 4.4).
 * - Headers — General (URL, метод, статус, удалённый адрес), заголовки ответа и запроса.
 * - Payload — query по параметрам; тело: JSON — отформатированным, form — по полям, бинарное — размером.
 * - Response — по клику через `responseBody`, до 1 МБ: JSON отформатированным, текст как есть, бинарное — размером
 *   и типом. Вытесненное Chromium тело — «Body is no longer available».
 * Заголовки и тела — как есть: это браузер человека. Маска — только для «Add to chat» и агента (этапы B, C).
 */
import { X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { DEVTOOLS_LIMITS, type NetworkEntry, type ResponseBody } from '../../../shared/browser-devtools.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs.js';
import { PanelIconButton } from './controls.js';
import { base64Bytes, formFields, headerValue, prettyJson, queryParams, statusCell } from './format.js';

type DetailsView = 'headers' | 'payload' | 'response';
type BodyState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'gone' } | { kind: 'loaded'; body: ResponseBody };

/** Тело запроса бинарное — показывается только размер (спека 4.4). */
const BINARY_TYPE = /^(image|audio|video|font)\/|octet-stream|application\/(pdf|zip|wasm)/i;
const TRIGGER = 'px-2 py-0.5 text-[11px]';
const CONTENT = 'mt-0 min-h-0 flex-1 overflow-auto p-2 text-[11px]';
const ACTION = 'h-5 shrink-0 rounded px-1.5 text-[11px] text-foreground hover:bg-accent';

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="mb-2">
      <h3 className="mb-1 font-medium text-foreground">{title}</h3>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

function Pair({ name, value }: { name: string; value: string }): JSX.Element {
  return (
    <div className="flex min-w-0 gap-2 break-all font-mono">
      <span className="shrink-0 text-foreground">{name}:</span>
      <span className="min-w-0 text-muted-foreground">{value}</span>
    </div>
  );
}

function Pairs({ pairs }: { pairs: ReadonlyArray<[string, string]> }): JSX.Element {
  return (
    <>
      {pairs.map(([name, value], index) => (
        <Pair key={`${name}-${index}`} name={name} value={value} />
      ))}
    </>
  );
}

function statusLine(entry: NetworkEntry): string {
  if (entry.failure !== null) return `${statusCell(entry).text} ${entry.failure.text}`.trim();
  if (entry.status === null) return statusCell(entry).text;
  return `${entry.status} ${entry.statusText}`.trim();
}

function ResponseView({ entry, body }: { entry: NetworkEntry; body: ResponseBody }): JSX.Element {
  if (body.base64) {
    // Обрезанное тело своего размера не знает — берётся размер ответа из журнала.
    const bytes = body.truncated ? (entry.encodedBytes ?? base64Bytes(body.text)) : base64Bytes(body.text);
    return <p data-testid="response-body">{S.browser.devtools.details.binary(S.browser.devtools.bytes(bytes), entry.mimeType ?? '')}</p>;
  }
  return (
    <>
      {body.truncated ? (
        <p className="mb-1 text-muted-foreground">{S.browser.devtools.details.truncated(S.browser.devtools.bytes(DEVTOOLS_LIMITS.panelBody))}</p>
      ) : null}
      <pre data-testid="response-body" className="whitespace-pre-wrap break-all font-mono">
        {prettyJson(body.text) ?? body.text}
      </pre>
    </>
  );
}

export interface RequestDetailsProps {
  entry: NetworkEntry;
  webContentsId: number | null;
  bridge: ParleyBridge;
  onClose(): void;
  /** «Add to chat» запроса — этап B (спека 4.4, 4.5); нет колбэка — нет кнопки. */
  onAddToChat?: ((entry: NetworkEntry) => void) | undefined;
}

export function RequestDetails({ entry, webContentsId, bridge, onClose, onAddToChat }: RequestDetailsProps): JSX.Element {
  const [view, setView] = useState<DetailsView>('headers');
  const [body, setBody] = useState<BodyState>({ kind: 'idle' });
  // Другой запрос — свои вкладка и тело; поздний ответ прежнего отбрасывается.
  const [shownId, setShownId] = useState(entry.id);
  const currentId = useRef(entry.id);
  currentId.current = entry.id;
  if (shownId !== entry.id) {
    setShownId(entry.id);
    setView('headers');
    setBody({ kind: 'idle' });
  }

  const loadBody = (): void => {
    if (webContentsId === null) return;
    const requestId = entry.id;
    setBody({ kind: 'loading' });
    bridge.browser.responseBody(webContentsId, requestId).then(
      (result) => {
        if (currentId.current === requestId) setBody(result === null ? { kind: 'gone' } : { kind: 'loaded', body: result });
      },
      (error: unknown) => {
        if (currentId.current !== requestId) return;
        console.error('[parley] responseBody failed', error);
        toast(errorText(decodeIpcError(error).code, S.errors.actions.loadResponse));
        setBody({ kind: 'idle' });
      },
    );
  };

  const copyUrl = (): void => {
    navigator.clipboard.writeText(entry.url).catch((error: unknown) => console.warn('[parley] clipboard', error));
  };

  const details = S.browser.devtools.details;
  const query = queryParams(entry.url);
  const contentType = headerValue(entry.requestHeaders, 'content-type') ?? '';
  const payload = entry.postData;

  return (
    <div data-testid="request-details" className="flex h-full min-h-0 flex-col">
      <Tabs
        value={view}
        onValueChange={(next) => {
          const value: DetailsView = next === 'payload' || next === 'response' ? next : 'headers';
          setView(value);
          // Тело грузится по клику (спека 4.4): вкладка Response — тот самый клик.
          if (value === 'response' && body.kind === 'idle') loadBody();
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-1.5">
          <TabsList className="h-6 p-0.5">
            <TabsTrigger value="headers" className={TRIGGER}>
              {details.headers}
            </TabsTrigger>
            <TabsTrigger value="payload" className={TRIGGER}>
              {details.payload}
            </TabsTrigger>
            <TabsTrigger value="response" className={TRIGGER}>
              {details.response}
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {onAddToChat === undefined ? null : (
              <button type="button" onClick={() => onAddToChat(entry)} className={ACTION}>
                {S.browser.devtools.addToChat}
              </button>
            )}
            <button type="button" onClick={copyUrl} className={ACTION}>
              {details.copyUrl}
            </button>
            <PanelIconButton label={details.close} onClick={onClose}>
              <X className="size-3" aria-hidden="true" />
            </PanelIconButton>
          </div>
        </div>
        <TabsContent value="headers" className={CONTENT}>
          <Section title={details.general}>
            <Pair name={details.url} value={entry.url} />
            <Pair name={details.method} value={entry.method} />
            <Pair name={details.status} value={statusLine(entry)} />
            {entry.remoteAddress === null ? null : <Pair name={details.remoteAddress} value={entry.remoteAddress} />}
          </Section>
          <Section title={details.responseHeaders}>
            <Pairs pairs={entry.responseHeaders} />
          </Section>
          <Section title={details.requestHeaders}>
            <Pairs pairs={entry.requestHeaders} />
          </Section>
        </TabsContent>
        <TabsContent value="payload" className={CONTENT}>
          {query.length === 0 && payload === null ? <p className="text-muted-foreground">{details.noPayload}</p> : null}
          {query.length === 0 ? null : (
            <Section title={details.query}>
              <Pairs pairs={query} />
            </Section>
          )}
          {payload === null ? null : (
            <Section title={details.body}>
              {BINARY_TYPE.test(contentType) ? (
                <p>{details.binary(S.browser.devtools.bytes(payload.length), contentType)}</p>
              ) : contentType.includes('application/x-www-form-urlencoded') ? (
                <Pairs pairs={formFields(payload)} />
              ) : (
                <pre data-testid="request-body" className="whitespace-pre-wrap break-all font-mono">
                  {prettyJson(payload) ?? payload}
                </pre>
              )}
            </Section>
          )}
        </TabsContent>
        <TabsContent value="response" className={CONTENT}>
          {body.kind === 'idle' ? (
            <button type="button" onClick={loadBody} className="rounded border border-border px-2 py-0.5 hover:bg-accent">
              {details.loadResponse}
            </button>
          ) : null}
          {body.kind === 'loading' ? <p className="text-muted-foreground">{details.loading}</p> : null}
          {body.kind === 'gone' ? (
            <p data-testid="response-gone" className="text-muted-foreground">
              {details.bodyGone}
            </p>
          ) : null}
          {body.kind === 'loaded' ? <ResponseView entry={entry} body={body.body} /> : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

- [ ] **Шаг 4. Реализовать список.**

```tsx
// packages/desktop/src/renderer/browser/devtools/NetworkView.tsx
/**
 * Вид Network панели (спека 2026-10-07-browser-devtools-agent-design.md, 4.4).
 * - Фильтры: типы, «Failed only», подстрока URL.
 * - Список запросов по времени начала — виртуальный: в DOM видимые строки и запас.
 * - Status: ошибки красным; без ответа — `CORS`, `blocked` или `failed`, `(canceled)` серым.
 * - Name: путь и query, у чужого origin — ещё хост.
 * - Выбор строки — детали справа, на узкой панели — поверх списка.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, type CSSProperties } from 'react';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { isFailed, type NetworkEntry } from '../../../shared/browser-devtools.js';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { FilterInput, FilterToggle } from './controls.js';
import { nameParts, sizeText, statusCell } from './format.js';
import { RequestDetails } from './RequestDetails.js';
import { EMPTY_DEVTOOLS, useDevtoolsStore, visibleNetwork, type NetworkFilter } from './store.js';

const FILTERS: readonly NetworkFilter[] = ['all', 'fetch', 'doc', 'js', 'css', 'img', 'other'];
const ROW_PX = 24;
/** Размер списка до первого замера (jsdom, первый кадр): первые строки есть сразу — как `review/VirtualRows.tsx`. */
const INITIAL_RECT = { width: 600, height: 400 };
const GRID = 'grid grid-cols-[4.5rem_3.5rem_minmax(0,1fr)_4.5rem_4rem_4rem] items-center gap-2 px-2';

function NetworkRow(props: { entry: NetworkEntry; pageUrl: string; selected: boolean; style: CSSProperties; onSelect(): void }): JSX.Element {
  const { entry } = props;
  const status = statusCell(entry);
  const name = nameParts(entry.url, props.pageUrl);
  return (
    <button
      type="button"
      data-network-row={entry.id}
      data-failed={isFailed(entry)}
      aria-pressed={props.selected}
      title={entry.url}
      onClick={props.onSelect}
      style={props.style}
      className={cn(GRID, 'h-6 w-full border-b border-border/60 text-left hover:bg-accent', props.selected && 'bg-accent')}
    >
      <span
        data-tone={status.tone}
        className={cn('truncate', status.tone === 'error' && 'text-destructive', status.tone === 'muted' && 'text-muted-foreground')}
      >
        {status.text}
      </span>
      <span className="truncate">{entry.method}</span>
      <span className="min-w-0 truncate">
        {name.path}
        {name.host === null ? null : <span className="text-muted-foreground">{` · ${name.host}`}</span>}
      </span>
      <span className="truncate text-muted-foreground">{entry.kind}</span>
      <span className="truncate text-muted-foreground">{sizeText(entry)}</span>
      <span className="truncate text-muted-foreground">{entry.durationMs === null ? '—' : S.browser.devtools.ms(entry.durationMs)}</span>
    </button>
  );
}

export interface NetworkViewProps {
  tabId: string;
  /** Адрес страницы вкладки: у запросов её origin хост в Name не пишется. */
  pageUrl: string;
  webContentsId: number | null;
  bridge: ParleyBridge;
  /** Узкая панель: детали — поверх списка (спека 4.4). */
  narrow: boolean;
  /** «Add to chat» запроса — этап B; нет колбэка — нет кнопки. */
  onAddToChat?: ((entry: NetworkEntry) => void) | undefined;
}

export function NetworkView({ tabId, pageUrl, webContentsId, bridge, narrow, onAddToChat }: NetworkViewProps): JSX.Element {
  const tab = useDevtoolsStore((state) => state.tabs[tabId]) ?? EMPTY_DEVTOOLS;
  const patch = useDevtoolsStore.getState().patch;
  const rows = useMemo(() => visibleNetwork(tab), [tab]);
  const selected = tab.selected === null ? null : (tab.network.find((entry) => entry.id === tab.selected) ?? null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    getItemKey: (index) => rows[index]?.id ?? index,
    initialRect: INITIAL_RECT,
    overscan: 10,
  });
  const columns = S.browser.devtools.columns;

  return (
    <div data-testid="network-view" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-1.5 py-1">
        {FILTERS.map((filter) => (
          <FilterToggle key={filter} pressed={tab.networkFilter === filter} onClick={() => patch(tabId, { networkFilter: filter })}>
            {S.browser.devtools.kinds[filter]}
          </FilterToggle>
        ))}
        <FilterToggle pressed={tab.failedOnly} onClick={() => patch(tabId, { failedOnly: !tab.failedOnly })}>
          {S.browser.devtools.failedOnly}
        </FilterToggle>
        <FilterInput label={S.browser.devtools.filterUrl} value={tab.urlText} onChange={(value) => patch(tabId, { urlText: value })} />
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div className={cn('flex min-h-0 min-w-0 flex-col', selected !== null && !narrow ? 'w-1/2' : 'flex-1')}>
          <div className={cn(GRID, 'h-6 shrink-0 border-b border-border text-[11px] text-muted-foreground')}>
            <span>{columns.status}</span>
            <span>{columns.method}</span>
            <span>{columns.name}</span>
            <span>{columns.type}</span>
            <span>{columns.size}</span>
            <span>{columns.time}</span>
          </div>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto font-mono text-[11px]">
            {rows.length === 0 ? (
              <div className="p-2 text-muted-foreground">{S.browser.devtools.emptyNetwork}</div>
            ) : (
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const entry = rows[item.index];
                  if (entry === undefined) return null;
                  return (
                    <NetworkRow
                      key={entry.id}
                      entry={entry}
                      pageUrl={pageUrl}
                      selected={entry.id === tab.selected}
                      style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }}
                      onSelect={() => patch(tabId, { selected: entry.id })}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {selected === null ? null : (
          <div
            data-testid="request-details-pane"
            data-overlay={narrow}
            className={cn('min-h-0 min-w-0 bg-card', narrow ? 'absolute inset-0 z-10' : 'w-1/2 border-l border-border')}
          >
            <RequestDetails
              entry={selected}
              webContentsId={webContentsId}
              bridge={bridge}
              onClose={() => patch(tabId, { selected: null })}
              onAddToChat={onAddToChat}
            />
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Шаг 5. Запустить — проходит.** Команда шага 2 → PASS (14 тестов). Затем `pnpm --filter @parley/desktop typecheck` → без ошибок.

  Строк в jsdom меньше шести — проверить `initialRect`. Без него у виртуализатора в jsdom нулевая высота, и строк нет (`review/VirtualRows.tsx`, комментарий у `INITIAL_RECT`).

- [ ] **Шаг 6. Закоммитить.**

```bash
git add packages/desktop/src/renderer/browser/devtools
git commit -m "feat(desktop): вид Network панели браузера и детали запроса с телом ответа" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 13. Панель Console | Network

**Файлы:**
- Создать: `packages/desktop/src/renderer/browser/devtools/HeightResizer.tsx`, `packages/desktop/src/renderer/browser/devtools/DevtoolsPanel.tsx`
- Тест: `packages/desktop/src/renderer/browser/devtools/DevtoolsPanel.test.tsx`

**Интерфейсы:**
- Берёт:
  - `ConsoleView` (задача 11), `NetworkView` (задача 12);
  - `devtoolsCounters`, `useDevtoolsStore` (задача 9), `DEVTOOLS_PANEL` (задача 8);
  - `Tabs*` (`renderer/ui/tabs.tsx`); образец ручки — `shell/Resizer.tsx`.
- Отдаёт:
  - `HeightResizer({ height, min, max, target, onCommit })`;
  - `DevtoolsPanel(props: DevtoolsPanelProps)` — `[data-testid="devtools-panel"]`. Пропсы:
    - `tabId`, `webContentsId`, `pageUrl`, `bridge`;
    - `height`, `maxHeight`, `onResize`, `onReload`, `onClear`;
    - слоты B: `onAddConsoleToChat?`, `onAddRequestToChat?`, `onAddErrorsToChat?`.

- [ ] **Шаг 1. Написать падающий тест.**

```tsx
// packages/desktop/src/renderer/browser/devtools/DevtoolsPanel.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { consoleEntry, networkEntry } from '../../test-utils/devtools-fixtures.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { DevtoolsPanel, type DevtoolsPanelProps } from './DevtoolsPanel.js';
import { EMPTY_DEVTOOLS, useDevtoolsStore, type TabDevtools } from './store.js';

const TAB = 'browser:0000c1';
let bridge: FakeBridge;

function seed(patch: Partial<TabDevtools> = {}): void {
  useDevtoolsStore.setState({ tabs: { [TAB]: { ...EMPTY_DEVTOOLS, open: true, ...patch } } });
}

function renderPanel(extra: Partial<DevtoolsPanelProps> = {}): DevtoolsPanelProps {
  const props: DevtoolsPanelProps = {
    tabId: TAB,
    webContentsId: 7,
    pageUrl: 'http://localhost:5173/',
    bridge,
    height: 200,
    maxHeight: 400,
    onResize: vi.fn(),
    onReload: vi.fn(),
    onClear: vi.fn(),
    ...extra,
  };
  render(<DevtoolsPanel {...props} />);
  return props;
}

beforeEach(() => {
  bridge = createFakeBridge();
});

afterEach(() => {
  cleanup();
  useDevtoolsStore.setState({ tabs: {} });
});

describe('DevtoolsPanel (спека 4.3, 4.4)', () => {
  it('вкладки Console и Network — вид в сторе вкладки; высота — из пропса', () => {
    seed();
    renderPanel();
    expect(screen.getByTestId('devtools-panel').style.height).toBe('200px');
    expect(screen.getByTestId('console-view')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Network' }));
    expect(useDevtoolsStore.getState().tabs[TAB]?.view).toBe('network');
    expect(screen.getByTestId('network-view')).toBeTruthy();
  });

  it('late — «Reload to capture earlier requests», unavailable — «Capture unavailable…»; Reload — onReload', () => {
    seed({ capture: 'late' });
    const props = renderPanel();
    expect(screen.getByRole('status').textContent).toContain('Reload to capture earlier requests');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(props.onReload).toHaveBeenCalledTimes(1);
    cleanup();
    seed({ capture: 'unavailable' });
    renderPanel();
    expect(screen.getByRole('status').textContent).toContain('Capture unavailable — reload the page');
    cleanup();
    seed();
    renderPanel();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('Preserve log — в стор; Clear — onClear; Close panel — панель спрятана', () => {
    seed();
    const props = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Preserve log' }));
    expect(useDevtoolsStore.getState().tabs[TAB]?.preserve).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(props.onClear).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(useDevtoolsStore.getState().tabs[TAB]?.open).toBe(false);
  });

  it('Add errors to chat — только при ошибках и с колбэком этапа B', () => {
    const onAddErrorsToChat = vi.fn();
    seed({ network: [networkEntry('fail', { status: 500 })] });
    renderPanel({ onAddErrorsToChat });
    fireEvent.click(screen.getByRole('button', { name: 'Add errors to chat' }));
    expect(onAddErrorsToChat).toHaveBeenCalledTimes(1);
    cleanup();
    seed({ console: [consoleEntry(1)] });
    renderPanel({ onAddErrorsToChat });
    expect(screen.queryByRole('button', { name: 'Add errors to chat' })).toBeNull();
    cleanup();
    seed({ network: [networkEntry('fail', { status: 500 })] });
    renderPanel();
    expect(screen.queryByRole('button', { name: 'Add errors to chat' })).toBeNull();
  });

  it('ручка: вверх на 100 px — onResize(300); не выше maxHeight; оверлей — только во время перетаскивания', () => {
    seed();
    const props = renderPanel();
    const handle = screen.getByRole('separator', { name: 'Resize panel' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
    expect(screen.getByTestId('resize-overlay')).toBeTruthy();
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 400 });
    expect(screen.getByTestId('devtools-panel').style.height).toBe('300px');
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 400 });
    expect(props.onResize).toHaveBeenCalledWith(300);
    expect(screen.queryByTestId('resize-overlay')).toBeNull();
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 0 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 0 });
    expect(props.onResize).toHaveBeenLastCalledWith(400);
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/renderer/browser/devtools/DevtoolsPanel.test.tsx` → FAIL: `Failed to resolve import "./DevtoolsPanel.js"`.

- [ ] **Шаг 3. Реализовать ручку.**

```tsx
// packages/desktop/src/renderer/browser/devtools/HeightResizer.tsx
/**
 * Ручка высоты панели Console | Network (спека 2026-10-07-browser-devtools-agent-design.md, 4.3) — по образцу
 * `shell/Resizer.tsx`:
 * - во время перетаскивания высота пишется прямо в DOM, в `ui.json` — только на `pointerup`;
 * - поверх всего — прозрачный оверлей, иначе страница `<webview>` перехватила бы мышь;
 * - потеря захвата и уход фокуса окна прерывают перетаскивание без записи.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { S } from '../../../shared/strings.js';

export interface HeightResizerProps {
  height: number;
  min: number;
  max: number;
  /** Чью высоту двигать в DOM во время перетаскивания. */
  target: RefObject<HTMLElement>;
  /** Только на `pointerup`. */
  onCommit(height: number): void;
}

export function HeightResizer({ height, min, max, target, onCommit }: HeightResizerProps): JSX.Element {
  const start = useRef<{ y: number; height: number } | null>(null);
  const pending = useRef(height);
  const [dragging, setDragging] = useState(false);

  const cancel = useCallback((): void => {
    start.current = null;
    setDragging(false);
  }, []);

  useEffect(() => {
    if (!dragging) return undefined;
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, [dragging, cancel]);

  const end = (): void => {
    if (start.current === null) return;
    cancel();
    onCommit(pending.current);
  };

  return (
    <>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={S.browser.devtools.resize}
        className="absolute inset-x-0 -top-1.5 z-10 h-3 cursor-row-resize touch-none select-none"
        onPointerDown={(event) => {
          // `setPointerCapture` в jsdom может не быть — без него перетаскивание живёт, пока зажата кнопка.
          event.currentTarget.setPointerCapture?.(event.pointerId);
          start.current = { y: event.clientY, height };
          pending.current = height;
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const from = start.current;
          if (from === null) return;
          // Вверх — выше: панель растёт от нижнего края вкладки.
          const next = Math.min(Math.max(from.height + (from.y - event.clientY), min), max);
          pending.current = next;
          if (target.current !== null) target.current.style.height = `${next}px`;
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={() => {
          if (start.current !== null) cancel();
        }}
      />
      {dragging ? <div data-testid="resize-overlay" className="fixed inset-0 z-40 cursor-row-resize" /> : null}
    </>
  );
}
```

- [ ] **Шаг 4. Реализовать панель.**

```tsx
// packages/desktop/src/renderer/browser/devtools/DevtoolsPanel.tsx
/**
 * Панель Console | Network снизу вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, 4.3, 4.4).
 * - Шапка: виды Console и Network, «Preserve log», очистить и закрыть.
 * - Под шапкой — подсказка, если захват поздний или недоступен, с «Reload».
 * - Высота общая для вкладок (`ui.json`, `browser.devtoolsHeight`), ручка — `HeightResizer`.
 * - Узкая панель (уже `NARROW_PX`) кладёт детали запроса поверх списка.
 * - «Add errors to chat» и «Add to chat» строк и запросов — слоты этапа B.
 */
import { Ban, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { ParleyBridge } from '../../../shared/bridge.js';
import type { ConsoleEntry, NetworkEntry } from '../../../shared/browser-devtools.js';
import { S } from '../../../shared/strings.js';
import { DEVTOOLS_PANEL } from '../../../shared/ui-types.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs.js';
import { ConsoleView } from './ConsoleView.js';
import { FilterToggle, PanelIconButton } from './controls.js';
import { HeightResizer } from './HeightResizer.js';
import { NetworkView } from './NetworkView.js';
import { devtoolsCounters, EMPTY_DEVTOOLS, useDevtoolsStore } from './store.js';

/** Уже этой ширины детали запроса ложатся поверх списка (спека 4.4). */
const NARROW_PX = 640;
const TRIGGER = 'px-2 py-0.5 text-[11px]';
const CONTENT = 'mt-0 flex min-h-0 flex-1 flex-col';

export interface DevtoolsPanelProps {
  tabId: string;
  webContentsId: number | null;
  pageUrl: string;
  bridge: ParleyBridge;
  /** Высота в пределах (`stage.ts#panelHeight`). */
  height: number;
  maxHeight: number;
  /** Новая высота после перетаскивания — в `ui.json`. */
  onResize(height: number): void;
  /** «Reload» подсказок `late` и `unavailable`. */
  onReload(): void;
  /** Очистить журнал вкладки — в main и в окне. */
  onClear(): void;
  onAddConsoleToChat?: ((entry: ConsoleEntry) => void) | undefined;
  onAddRequestToChat?: ((entry: NetworkEntry) => void) | undefined;
  onAddErrorsToChat?: (() => void) | undefined;
}

export function DevtoolsPanel(props: DevtoolsPanelProps): JSX.Element {
  const { tabId, onAddErrorsToChat } = props;
  const tab = useDevtoolsStore((state) => state.tabs[tabId]) ?? EMPTY_DEVTOOLS;
  const store = useDevtoolsStore.getState();
  const panelRef = useRef<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(false);

  useLayoutEffect(() => {
    const node = panelRef.current;
    if (node === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setNarrow(width < NARROW_PX);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const errors = devtoolsCounters(tab).errors;

  return (
    <section
      ref={panelRef}
      data-testid="devtools-panel"
      aria-label={S.browser.devtools.toggle}
      style={{ height: props.height }}
      className="relative flex shrink-0 flex-col border-t border-border bg-card"
    >
      <HeightResizer height={props.height} min={DEVTOOLS_PANEL.minHeight} max={props.maxHeight} target={panelRef} onCommit={props.onResize} />
      <Tabs
        value={tab.view}
        onValueChange={(view) => store.patch(tabId, { view: view === 'network' ? 'network' : 'console' })}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-1.5">
          <TabsList className="h-6 p-0.5">
            <TabsTrigger value="console" className={TRIGGER}>
              {S.browser.devtools.console}
            </TabsTrigger>
            <TabsTrigger value="network" className={TRIGGER}>
              {S.browser.devtools.network}
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto flex min-w-0 items-center gap-1">
            {errors > 0 && onAddErrorsToChat !== undefined ? (
              <button type="button" onClick={onAddErrorsToChat} className="h-5 shrink-0 rounded px-1.5 text-[11px] hover:bg-accent">
                {S.browser.devtools.addErrorsToChat}
              </button>
            ) : null}
            <FilterToggle pressed={tab.preserve} onClick={() => store.patch(tabId, { preserve: !tab.preserve })}>
              {S.browser.devtools.preserveLog}
            </FilterToggle>
            <PanelIconButton label={S.browser.devtools.clear} onClick={props.onClear}>
              <Ban className="size-3" aria-hidden="true" />
            </PanelIconButton>
            <PanelIconButton label={S.browser.devtools.close} onClick={() => store.hide(tabId)}>
              <X className="size-3.5" aria-hidden="true" />
            </PanelIconButton>
          </div>
        </div>
        {tab.capture === 'on' ? null : (
          <div role="status" className="flex shrink-0 items-center gap-2 border-b border-border bg-amber-500/10 px-2 py-0.5 text-[11px]">
            <span className="min-w-0 truncate">{tab.capture === 'late' ? S.browser.devtools.late : S.browser.devtools.unavailable}</span>
            <button type="button" onClick={props.onReload} className="shrink-0 underline">
              {S.browser.reload}
            </button>
          </div>
        )}
        <TabsContent value="console" className={CONTENT}>
          <ConsoleView tabId={tabId} onAddToChat={props.onAddConsoleToChat} />
        </TabsContent>
        <TabsContent value="network" className={CONTENT}>
          <NetworkView
            tabId={tabId}
            pageUrl={props.pageUrl}
            webContentsId={props.webContentsId}
            bridge={props.bridge}
            narrow={narrow}
            onAddToChat={props.onAddRequestToChat}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}
```

- [ ] **Шаг 5. Запустить — проходит.** Команда шага 2 → PASS (5 тестов). Затем `pnpm --filter @parley/desktop typecheck` → без ошибок.

- [ ] **Шаг 6. Закоммитить.**

```bash
git add packages/desktop/src/renderer/browser/devtools
git commit -m "feat(desktop): панель Console | Network — виды, Preserve log, подсказки захвата, ручка высоты" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 14. Меню размеров

**Файлы:**
- Создать: `packages/desktop/src/renderer/browser/ViewportMenu.tsx`
- Тест: `packages/desktop/src/renderer/browser/ViewportMenu.test.tsx`

**Интерфейсы:**
- Берёт: `VIEWPORT_PRESETS`, `DEVTOOLS_LIMITS`, `viewportSize`, `ViewportSpec` (задача 2); `S.browser.viewport` (задача 10); `DropdownMenu*` (`renderer/ui/dropdown-menu.tsx`), `Popover`, `PopoverAnchor`, `PopoverContent` (`renderer/ui/popover.tsx`).
- Отдаёт:
  - помощники: `presetSpec(preset, current)`, `rotatedSpec(spec)`, `customSize(widthText, heightText)`, `viewportName(spec)`;
  - `ViewportMenu({ viewport, disabled, onChange })`. Кнопка — `aria-label="Viewport size"`, подпись — `[data-viewport-name]`.
- **Пункты меню:**
  - Fit;
  - шесть пресетов с размерами;
  - Custom… — поля W × H в поповере у той же кнопки;
  - Rotate;
  - 1x, 2x, 3x.
- **Правила выбора:**
  - DPR пресета — от прежнего размера; из Fit — 2x у мобильных пресетов, 1x у прочих;
  - свой размер — `mobile: false`.

- [ ] **Шаг 1. Написать падающий тест.**

```tsx
// packages/desktop/src/renderer/browser/ViewportMenu.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ViewportSpec } from '../../shared/browser-devtools.js';
import { customSize, presetSpec, rotatedSpec, viewportName, ViewportMenu } from './ViewportMenu.js';

afterEach(cleanup);

function openMenu(): HTMLElement {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Viewport size' }), { key: 'Enter' });
  return screen.getByRole('menu');
}

describe('помощники меню размеров (спека 4.2)', () => {
  it('presetSpec: DPR прежнего размера; из Fit — 2x у мобильных, 1x у прочих', () => {
    expect(presetSpec('mobile-m', null)).toEqual({ preset: 'mobile-m', rotated: false, dpr: 2 });
    expect(presetSpec('laptop', null)).toEqual({ preset: 'laptop', rotated: false, dpr: 1 });
    expect(presetSpec('tablet', { preset: 'mobile-s', rotated: true, dpr: 3 })).toEqual({ preset: 'tablet', rotated: false, dpr: 3 });
  });

  it('rotatedSpec: пресет — флаг, свой — ширина с высотой; за пределы — null', () => {
    expect(rotatedSpec({ preset: 'mobile-m', rotated: false, dpr: 2 })).toEqual({ preset: 'mobile-m', rotated: true, dpr: 2 });
    expect(rotatedSpec({ width: 1024, height: 700, mobile: false, dpr: 1 })).toEqual({ width: 700, height: 1024, mobile: false, dpr: 1 });
    expect(rotatedSpec({ width: 3000, height: 800, mobile: false, dpr: 1 })).toBeNull();
  });

  it('customSize: целые в 200–3840 × 200–2400; прочее — null', () => {
    expect(customSize('1024', ' 700 ')).toEqual({ width: 1024, height: 700 });
    const bad: Array<[string, string]> = [
      ['199', '700'],
      ['3841', '700'],
      ['1024', '2401'],
      ['10.5', '700'],
      ['', '700'],
      ['abc', '700'],
    ];
    for (const [width, height] of bad) expect(customSize(width, height), `${width}×${height}`).toBeNull();
  });

  it('viewportName: Fit, имя пресета, W×H', () => {
    expect(viewportName(null)).toBe('Fit');
    expect(viewportName({ preset: 'mobile-m', rotated: true, dpr: 2 })).toBe('Mobile M');
    expect(viewportName({ width: 1024, height: 700, mobile: false, dpr: 1 })).toBe('1024×700');
  });
});

describe('ViewportMenu (спека 4.2)', () => {
  it('пункты: Fit, шесть пресетов с размерами, Custom…, Rotate, 1x 2x 3x; при Fit Rotate и DPR неактивны', () => {
    render(<ViewportMenu viewport={null} disabled={false} onChange={vi.fn()} />);
    const menu = openMenu();
    expect(within(menu).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      'Fit',
      'Mobile S320×568',
      'Mobile M375×812',
      'Mobile L430×932',
      'Tablet768×1024',
      'Laptop1280×800',
      'Desktop1440×900',
      'Custom…',
      '1x',
      '2x',
      '3x',
    ]);
    expect(within(menu).getByRole('menuitem', { name: 'Rotate' }).hasAttribute('data-disabled')).toBe(true);
    expect(within(menu).getByRole('menuitemradio', { name: '2x' }).hasAttribute('data-disabled')).toBe(true);
  });

  it('пресет из Fit — Mobile M 2x; Fit — null; подпись кнопки — имя размера', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ViewportMenu viewport={null} disabled={false} onChange={onChange} />);
    fireEvent.click(within(openMenu()).getByRole('menuitemradio', { name: /Mobile M/ }));
    expect(onChange).toHaveBeenLastCalledWith({ preset: 'mobile-m', rotated: false, dpr: 2 });
    rerender(<ViewportMenu viewport={{ preset: 'mobile-m', rotated: false, dpr: 2 }} disabled={false} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Viewport size' }).textContent).toBe('Mobile M');
    fireEvent.click(within(openMenu()).getByRole('menuitemradio', { name: 'Fit' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('Rotate и DPR меняют текущий размер', () => {
    const onChange = vi.fn();
    const mobile: ViewportSpec = { preset: 'mobile-m', rotated: false, dpr: 2 };
    render(<ViewportMenu viewport={mobile} disabled={false} onChange={onChange} />);
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Rotate' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...mobile, rotated: true });
    fireEvent.click(within(openMenu()).getByRole('menuitemradio', { name: '3x' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...mobile, dpr: 3 });
  });

  it('Custom…: поля W и H; вне пределов — подсказка и Apply неактивна; верный — свой размер', () => {
    const onChange = vi.fn();
    render(<ViewportMenu viewport={null} disabled={false} onChange={onChange} />);
    fireEvent.click(within(openMenu()).getByRole('menuitemradio', { name: 'Custom…' }));
    const dialog = screen.getByRole('dialog');
    const width = within(dialog).getByRole('textbox', { name: 'Width' }) as HTMLInputElement;
    const height = within(dialog).getByRole('textbox', { name: 'Height' }) as HTMLInputElement;
    expect([width.value, height.value]).toEqual(['1280', '800']);
    fireEvent.change(width, { target: { value: '100' } });
    expect(within(dialog).getByRole('alert').textContent).toBe('Width 200–3840, height 200–2400');
    expect((within(dialog).getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(width, { target: { value: '1024' } });
    fireEvent.change(height, { target: { value: '700' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenCalledWith({ width: 1024, height: 700, mobile: false, dpr: 1 });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('без страницы — кнопка неактивна', () => {
    render(<ViewportMenu viewport={null} disabled onChange={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'Viewport size' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/renderer/browser/ViewportMenu.test.tsx` → FAIL: `Failed to resolve import "./ViewportMenu.js"`.

- [ ] **Шаг 3. Реализовать.**

```tsx
// packages/desktop/src/renderer/browser/ViewportMenu.tsx
/**
 * Меню размера вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, 4.2): Fit, пресеты как в device
 * toolbar Chrome, Custom… (W × H в пределах `DEVTOOLS_LIMITS`), Rotate и DPR 1x/2x/3x. Выбор уходит колбэком: размер
 * хранит раскладка (`TabSpec.viewport`), эмуляцию ставит поверхность. Подпись кнопки прячется на узкой строке —
 * контейнерный запрос строки вкладки (`@container` в `BrowserChrome.tsx`).
 */
import { MonitorSmartphone } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  DEVTOOLS_LIMITS,
  VIEWPORT_PRESETS,
  viewportSize,
  type ViewportDpr,
  type ViewportPreset,
  type ViewportSpec,
} from '../../shared/browser-devtools.js';
import { S } from '../../shared/strings.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover.js';

const PRESETS: readonly ViewportPreset[] = ['mobile-s', 'mobile-m', 'mobile-l', 'tablet', 'laptop', 'desktop'];
const DPRS: readonly ViewportDpr[] = [1, 2, 3];
const FIELD =
  'h-7 w-full rounded border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring';

function isPreset(value: string): value is ViewportPreset {
  return (PRESETS as readonly string[]).includes(value);
}

function isDpr(value: number): value is ViewportDpr {
  return value === 1 || value === 2 || value === 3;
}

/** Пресет с DPR прежнего размера; из Fit — 2x у мобильных, 1x у прочих. */
export function presetSpec(preset: ViewportPreset, current: ViewportSpec | null): ViewportSpec {
  return { preset, rotated: false, dpr: current?.dpr ?? (VIEWPORT_PRESETS[preset].mobile ? 2 : 1) };
}

/** Повёрнутый размер; свой размер, который после поворота вышел бы за пределы раздела 8, — null. */
export function rotatedSpec(spec: ViewportSpec): ViewportSpec | null {
  if ('preset' in spec) return { ...spec, rotated: !spec.rotated };
  if (spec.height > DEVTOOLS_LIMITS.customMaxWidth || spec.width > DEVTOOLS_LIMITS.customMaxHeight) return null;
  return { ...spec, width: spec.height, height: spec.width };
}

/** Поля Custom… → размер в пределах 200–3840 × 200–2400; иначе null. Пустое поле — 0, тоже вне пределов. */
export function customSize(widthText: string, heightText: string): { width: number; height: number } | null {
  const width = Number(widthText.trim());
  const height = Number(heightText.trim());
  const ok = (value: number, max: number): boolean => Number.isInteger(value) && value >= DEVTOOLS_LIMITS.customMin && value <= max;
  return ok(width, DEVTOOLS_LIMITS.customMaxWidth) && ok(height, DEVTOOLS_LIMITS.customMaxHeight) ? { width, height } : null;
}

/** Подпись кнопки: Fit, имя пресета или W×H. */
export function viewportName(spec: ViewportSpec | null): string {
  if (spec === null) return S.browser.viewport.fit;
  if ('preset' in spec) return S.browser.viewport.presets[spec.preset];
  return S.browser.viewport.size(spec.width, spec.height);
}

export interface ViewportMenuProps {
  viewport: ViewportSpec | null;
  /** Страницы ещё нет — эмулировать нечего. */
  disabled: boolean;
  onChange(spec: ViewportSpec | null): void;
}

export function ViewportMenu({ viewport, disabled, onChange }: ViewportMenuProps): JSX.Element {
  const [customOpen, setCustomOpen] = useState(false);
  const [widthText, setWidthText] = useState('');
  const [heightText, setHeightText] = useState('');
  // Custom… закрывает меню: фокус уходит в поля поповера, а не обратно на кнопку.
  const toCustom = useRef(false);
  const selected = viewport === null ? 'fit' : 'preset' in viewport ? viewport.preset : 'custom';
  const rotated = viewport === null ? null : rotatedSpec(viewport);
  const size = customSize(widthText, heightText);

  const openCustom = (): void => {
    const current = viewport === null ? VIEWPORT_PRESETS.laptop : viewportSize(viewport);
    setWidthText(String(current.width));
    setHeightText(String(current.height));
    toCustom.current = true;
    setCustomOpen(true);
  };

  const apply = (): void => {
    if (size === null) return;
    onChange({ width: size.width, height: size.height, mobile: false, dpr: viewport?.dpr ?? 1 });
    setCustomOpen(false);
  };

  return (
    <Popover open={customOpen} onOpenChange={setCustomOpen}>
      <DropdownMenu>
        <PopoverAnchor asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={S.browser.viewport.menu}
              title={S.browser.viewport.menu}
              disabled={disabled}
              className="flex h-6 shrink-0 items-center gap-1 rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <MonitorSmartphone className="size-3.5 shrink-0" aria-hidden="true" />
              <span data-viewport-name className="hidden max-w-24 truncate @min-[560px]:inline">
                {viewportName(viewport)}
              </span>
            </button>
          </DropdownMenuTrigger>
        </PopoverAnchor>
        <DropdownMenuContent
          align="end"
          className="w-56"
          onCloseAutoFocus={(event) => {
            if (!toCustom.current) return;
            toCustom.current = false;
            event.preventDefault();
          }}
        >
          <DropdownMenuRadioGroup
            value={selected}
            onValueChange={(value) => {
              if (value === 'fit') onChange(null);
              else if (isPreset(value)) onChange(presetSpec(value, viewport));
            }}
          >
            <DropdownMenuRadioItem value="fit">{S.browser.viewport.fit}</DropdownMenuRadioItem>
            <DropdownMenuSeparator />
            {PRESETS.map((preset) => (
              <DropdownMenuRadioItem key={preset} value={preset}>
                {S.browser.viewport.presets[preset]}
                <span className="ml-auto text-muted-foreground">
                  {S.browser.viewport.size(VIEWPORT_PRESETS[preset].width, VIEWPORT_PRESETS[preset].height)}
                </span>
              </DropdownMenuRadioItem>
            ))}
            {/* Custom… только открывает поля: onSelect, а не onValueChange — повторный выбор своего размера тоже их открывает. */}
            <DropdownMenuRadioItem value="custom" onSelect={openCustom}>
              {S.browser.viewport.custom}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={rotated === null}
            onSelect={() => {
              if (rotated !== null) onChange(rotated);
            }}
          >
            {S.browser.viewport.rotate}
          </DropdownMenuItem>
          <DropdownMenuRadioGroup
            value={viewport === null ? '' : String(viewport.dpr)}
            onValueChange={(value) => {
              const dpr = Number(value);
              if (viewport !== null && isDpr(dpr)) onChange({ ...viewport, dpr });
            }}
          >
            {DPRS.map((dpr) => (
              <DropdownMenuRadioItem key={dpr} value={String(dpr)} disabled={viewport === null}>
                {S.browser.viewport.dpr(dpr)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <PopoverContent align="end" className="w-64 p-3">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
          className="flex flex-col gap-2"
        >
          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
              {S.browser.viewport.width}
              <input
                aria-label={S.browser.viewport.width}
                inputMode="numeric"
                value={widthText}
                onChange={(event) => setWidthText(event.target.value)}
                className={FIELD}
              />
            </label>
            <span className="pb-1.5 text-xs text-muted-foreground" aria-hidden="true">
              ×
            </span>
            <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
              {S.browser.viewport.height}
              <input
                aria-label={S.browser.viewport.height}
                inputMode="numeric"
                value={heightText}
                onChange={(event) => setHeightText(event.target.value)}
                className={FIELD}
              />
            </label>
          </div>
          {size === null ? (
            <p role="alert" className="text-xs text-destructive">
              {S.browser.viewport.customRange(DEVTOOLS_LIMITS.customMin, DEVTOOLS_LIMITS.customMaxWidth, DEVTOOLS_LIMITS.customMaxHeight)}
            </p>
          ) : null}
          <button type="submit" disabled={size === null} className="h-7 rounded bg-primary px-3 text-xs text-primary-foreground disabled:opacity-40">
            {S.browser.viewport.apply}
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Шаг 4. Запустить — проходит.** Команда шага 2 → PASS (9 тестов). Затем `pnpm --filter @parley/desktop typecheck` → без ошибок.

  Поповер не открывается после «Custom…» — проверить, что `onSelect` стоит на самом `DropdownMenuRadioItem`. `onValueChange` группы на повторный выбор того же значения не зовётся.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/renderer/browser/ViewportMenu.tsx packages/desktop/src/renderer/browser/ViewportMenu.test.tsx
git commit -m "feat(desktop): меню размеров вкладки браузера — пресеты, Custom, Rotate, DPR" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 15. Строка вкладки

**Файлы:**
- Изменить:
  - `packages/desktop/src/renderer/browser/BrowserChrome.tsx`;
  - `packages/desktop/src/renderer/browser/BrowserSurface.tsx` — новые пропсы строки;
  - `packages/desktop/src/renderer/layout/SurfaceLayer.tsx` — `viewport` вкладки в поверхность;
  - `packages/desktop/src/shared/strings.ts` — удалить `S.browser.devTools`.
- Тесты:
  - создать `packages/desktop/src/renderer/browser/BrowserChrome.test.tsx`;
  - изменить `packages/desktop/src/renderer/browser/BrowserSurface.test.tsx`.

**Интерфейсы:**
- Берёт: `ViewportMenu` (задача 14); `devtoolsCounters`, `useDevtoolsStore`, `EMPTY_DEVTOOLS` (задача 9); `bridge.browser.devtoolsClear` (задача 7); `updateTab` с `viewport` (задача 8).
- Отдаёт:
  - **`BrowserChromeProps`** — новые пропсы `viewport`, `onViewport`, `devtoolsOpen`, `counters`, `onToggleDevtools`, `onClearDevtools`. `onDevTools` теперь пункт «⋯ → Open full DevTools».
  - **Порядок строки (спека 4.1):**
    - назад, вперёд, обновить или стоп;
    - адрес;
    - размер;
    - ⌖;
    - консоль;
    - ⋯.
  - **Пометки для тестов:**
    - корень строки — `[data-testid="browser-chrome"]`;
    - счётчики — `[data-testid="devtools-errors"]` и `[data-testid="devtools-warnings"]`.
  - **`BrowserSurfaceProps.viewport: ViewportSpec | null`**.
- ⌖ остаётся кнопкой Design Mode как есть: ⌖ Select, ✎ Annotate и «To» — этап B.

- [ ] **Шаг 1. Написать падающие тесты.**

```tsx
// packages/desktop/src/renderer/browser/BrowserChrome.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BrowserChrome, type BrowserChromeProps } from './BrowserChrome.js';

afterEach(cleanup);

function renderChrome(extra: Partial<BrowserChromeProps> = {}): BrowserChromeProps {
  const props: BrowserChromeProps = {
    url: 'http://localhost:5173/',
    loading: false,
    canGoBack: true,
    canGoForward: false,
    live: true,
    focusAddress: false,
    onBack: vi.fn(),
    onForward: vi.fn(),
    onReload: vi.fn(),
    onStop: vi.fn(),
    onNavigate: vi.fn(),
    onDevTools: vi.fn(),
    picking: false,
    onDesignMode: vi.fn(),
    viewport: null,
    onViewport: vi.fn(),
    devtoolsOpen: false,
    counters: { errors: 0, warnings: 0 },
    onToggleDevtools: vi.fn(),
    onClearDevtools: vi.fn(),
    ...extra,
  };
  render(<BrowserChrome {...props} />);
  return props;
}

describe('BrowserChrome (спека 2026-10-07, 4.1)', () => {
  it('порядок: назад, вперёд, обновить, адрес, размер, ⌖, консоль, ⋯; кнопки «DevTools» больше нет', () => {
    renderChrome();
    const chrome = screen.getByTestId('browser-chrome');
    expect(within(chrome).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Back',
      'Forward',
      'Reload',
      'Viewport size',
      'Design Mode',
      'Console and network',
      'More browser actions',
    ]);
    const address = screen.getByRole('textbox', { name: 'Address' });
    const size = screen.getByRole('button', { name: 'Viewport size' });
    expect(address.compareDocumentPosition(size) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'DevTools' })).toBeNull();
  });

  it('счётчики: нули не показываются; ошибки и предупреждения — числа с подсказкой; кнопка показывает и прячет панель', () => {
    const props = renderChrome({ counters: { errors: 3, warnings: 1 }, devtoolsOpen: true });
    expect(screen.getByTestId('devtools-errors').textContent).toBe('3');
    expect(screen.getByTestId('devtools-errors').getAttribute('title')).toBe('3 errors');
    expect(screen.getByTestId('devtools-warnings').textContent).toBe('1');
    expect(screen.getByTestId('devtools-warnings').getAttribute('title')).toBe('1 warning');
    const toggle = screen.getByRole('button', { name: 'Console and network' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(props.onToggleDevtools).toHaveBeenCalledTimes(1);
    cleanup();
    renderChrome();
    expect(screen.queryByTestId('devtools-errors')).toBeNull();
    expect(screen.queryByTestId('devtools-warnings')).toBeNull();
  });

  it('⋯: Open full DevTools и Clear console and network', () => {
    const props = renderChrome();
    fireEvent.keyDown(screen.getByRole('button', { name: 'More browser actions' }), { key: 'Enter' });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Open full DevTools' }));
    expect(props.onDevTools).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More browser actions' }), { key: 'Enter' });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Clear console and network' }));
    expect(props.onClearDevtools).toHaveBeenCalledTimes(1);
  });

  it('без страницы размер, консоль и ⋯ неактивны', () => {
    renderChrome({ live: false });
    for (const name of ['Viewport size', 'Console and network', 'More browser actions']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled, name).toBe(true);
    }
  });

  it('строка на 800 px (Фокус ревью 2): сжимается только адрес; прочее — значки с aria-label и shrink-0; подпись размера прячет контейнерный запрос', () => {
    renderChrome({ viewport: { preset: 'mobile-m', rotated: false, dpr: 2 }, counters: { errors: 12, warnings: 3 } });
    const chrome = screen.getByTestId('browser-chrome');
    expect(chrome.className).toContain('@container');
    const address = screen.getByRole('textbox', { name: 'Address' }).parentElement as HTMLElement;
    expect(address.className).toMatch(/\bmin-w-0\b/);
    expect(address.className).toMatch(/\bflex-1\b/);
    for (const button of within(chrome).getAllByRole('button')) {
      expect(button.getAttribute('aria-label'), button.outerHTML).not.toBeNull();
      expect(button.className, button.getAttribute('aria-label') ?? '').toMatch(/\bshrink-0\b/);
    }
    expect(chrome.querySelector('[data-viewport-name]')?.className).toContain('@min-[560px]:inline');
  });
});
```

  Ширину jsdom не меряет. Здесь проверяется устройство строки: сжимается только адрес, подпись прячет контейнерный запрос. Сама ширина 800×500 — в E2E задачи 17.

  В `BrowserSurface.test.tsx`:
  - импорты:

```tsx
import { devtoolsBatch, networkEntry } from '../test-utils/devtools-fixtures.js';
import { useDevtoolsStore } from './devtools/store.js';
```

  - в общий `afterEach` файла — строка `useDevtoolsStore.setState({ tabs: {} });`;
  - рядом с `layoutUrlOfTab`:

```tsx
function tabOfLayout(): TabSpec | undefined {
  const layout = useLayoutStore.getState().layouts[WORK_KEY];
  const found = layout === undefined ? null : findTab(layout, TAB);
  return found?.group.tabs[found.index];
}
```

  - тест «DevTools — browser.openDevTools(webContentsId); отказ — тост, окно живо» заменить на:

```tsx
  it('⋯ → Open full DevTools — browser.openDevTools(webContentsId); до dom-ready ⋯ неактивна', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 9);
    const more = screen.getByRole('button', { name: 'More browser actions' }) as HTMLButtonElement;
    expect(more.disabled).toBe(true);
    fire(view, 'dom-ready');
    fireEvent.keyDown(more, { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open full DevTools' }));
    expect(bridge.browserCalls).toContainEqual({ method: 'openDevTools', args: [9] });
  });
```

  - в конец файла:

```tsx
describe('BrowserSurface — строка вкладки (спека 2026-10-07, 4.1, 4.2)', () => {
  it('счётчики — из журнала вкладки; ⋯ → Clear console and network — devtoolsClear(id), журнал пуст', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 9), 'dom-ready');
    act(() => useDevtoolsStore.getState().batch(TAB, devtoolsBatch({ webContentsId: 9, network: [networkEntry('fail', { status: 500 })] })));
    expect(screen.getByTestId('devtools-errors').textContent).toBe('1');
    fireEvent.keyDown(screen.getByRole('button', { name: 'More browser actions' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear console and network' }));
    expect(bridge.browserCalls).toContainEqual({ method: 'devtoolsClear', args: [9] });
    expect(useDevtoolsStore.getState().tabs[TAB]?.network).toEqual([]);
    expect(screen.queryByTestId('devtools-errors')).toBeNull();
  });

  it('размер из меню — в раскладку вкладки (TabSpec.viewport); Fit — поля нет', () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 9), 'dom-ready');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Viewport size' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Mobile M/ }));
    expect(tabOfLayout()).toEqual({ kind: 'browser', id: TAB, url: 'http://localhost:5173/', viewport: { preset: 'mobile-m', rotated: false, dpr: 2 } });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Viewport size' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Fit' }));
    expect(tabOfLayout()).toEqual({ kind: 'browser', id: TAB, url: 'http://localhost:5173/' });
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/renderer/browser/BrowserChrome.test.tsx src/renderer/browser/BrowserSurface.test.tsx` → FAIL: нет кнопок размера, консоли и «⋯»; кнопка «DevTools» ещё на месте.

- [ ] **Шаг 3. Реализовать строку.** `BrowserChrome.tsx` целиком:

```tsx
// packages/desktop/src/renderer/browser/BrowserChrome.tsx
/**
 * Строка над страницей вкладки браузера (кусок 9.2a, спека 12.1; спека 2026-10-07-browser-devtools-agent-design.md,
 * 4.1), 36px. Слева направо:
 * - «назад», «вперёд», «перезагрузить» или «остановить»;
 * - адрес;
 * - размер вьюпорта (`ViewportMenu`);
 * - ⌖ Design Mode — подсвечен, пока идёт выбор элемента;
 * - консоль: значок со счётчиками ошибок (красный) и предупреждений (жёлтый); нули не показываются;
 * - «⋯»: «Open full DevTools» (прежняя кнопка «DevTools») и «Clear console and network».
 * Под строкой — полоса загрузки 2px. ⌖ Select, ✎ Annotate и «To» займут место ⌖ на этапе B.
 *
 * Узкая строка (окно 800×500): подписи прячет контейнерный запрос самой строки (`@container`), остаются значки;
 * сжимается первым адрес — у остальных `shrink-0`.
 *
 * Страницей строка не управляет сама: всё — колбэками `BrowserSurface`, у которого `<webview>`.
 */

import { ArrowLeft, ArrowRight, Crosshair, MoreHorizontal, RotateCw, SquareTerminal, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ViewportSpec } from '../../shared/browser-devtools.js';
import { S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { AddressBar } from './AddressBar.js';
import { ViewportMenu } from './ViewportMenu.js';

export interface BrowserChromeProps {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Страница есть и готова (`dom-ready`): без неё «перезагрузить», размер, консоль и «⋯» некуда слать. */
  live: boolean;
  /** Новая вкладка без страницы — фокус в адресной строке (спека 12.1). */
  focusAddress: boolean;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  onStop(): void;
  onNavigate(url: string): void;
  /** «⋯ → Open full DevTools»: полный Chromium DevTools отдельным окном. */
  onDevTools(): void;
  /** Идёт выбор элемента Design Mode: ⌖ подсвечен, повторное нажатие выбор снимает. */
  picking: boolean;
  onDesignMode(): void;
  /** Размер вьюпорта вкладки (`TabSpec.viewport`); null — Fit. */
  viewport: ViewportSpec | null;
  onViewport(spec: ViewportSpec | null): void;
  /** Панель Console | Network открыта. */
  devtoolsOpen: boolean;
  /** Счётчики текущей страницы (`devtools/store.ts#devtoolsCounters`). */
  counters: { errors: number; warnings: number };
  onToggleDevtools(): void;
  /** «⋯ → Clear console and network». */
  onClearDevtools(): void;
}

const ICON_BUTTON =
  'flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40';

function IconButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick(): void; children: ReactNode }): JSX.Element {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className={ICON_BUTTON}>
      {children}
    </button>
  );
}

export function BrowserChrome(props: BrowserChromeProps): JSX.Element {
  const { url, loading, canGoBack, canGoForward, live, counters } = props;
  return (
    <div data-testid="browser-chrome" className="@container relative flex h-9 shrink-0 items-center gap-1 border-b border-border bg-card px-1.5">
      <IconButton label={S.actions.back} disabled={!live || !canGoBack} onClick={props.onBack}>
        <ArrowLeft className="size-3.5" aria-hidden="true" />
      </IconButton>
      <IconButton label={S.actions.forward} disabled={!live || !canGoForward} onClick={props.onForward}>
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </IconButton>
      {loading ? (
        <IconButton label={S.browser.stop} disabled={!live} onClick={props.onStop}>
          <X className="size-3.5" aria-hidden="true" />
        </IconButton>
      ) : (
        <IconButton label={S.browser.reload} disabled={!live} onClick={props.onReload}>
          <RotateCw className="size-3.5" aria-hidden="true" />
        </IconButton>
      )}
      <AddressBar url={url} onNavigate={props.onNavigate} autoFocus={props.focusAddress} />
      <ViewportMenu viewport={props.viewport} disabled={!live} onChange={props.onViewport} />
      <button
        type="button"
        aria-label={S.browser.designMode}
        title={S.browser.designMode}
        aria-pressed={props.picking}
        disabled={!live}
        onClick={props.onDesignMode}
        className={
          props.picking
            ? 'flex size-6 shrink-0 items-center justify-center rounded bg-blue-500/15 text-blue-600 dark:text-blue-400'
            : ICON_BUTTON
        }
      >
        <Crosshair className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={S.browser.devtools.toggle}
        title={S.browser.devtools.toggle}
        aria-pressed={props.devtoolsOpen}
        disabled={!live}
        onClick={props.onToggleDevtools}
        className={cn(
          'flex h-6 shrink-0 items-center gap-1 rounded px-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40',
          props.devtoolsOpen && 'bg-accent text-accent-foreground',
        )}
      >
        <SquareTerminal className="size-3.5 shrink-0" aria-hidden="true" />
        {counters.errors > 0 ? (
          <span
            data-testid="devtools-errors"
            title={S.browser.devtools.errors(counters.errors)}
            className="rounded-full bg-red-500/15 px-1 text-[10px] font-medium leading-4 text-red-600 dark:text-red-400"
          >
            {counters.errors}
          </span>
        ) : null}
        {counters.warnings > 0 ? (
          <span
            data-testid="devtools-warnings"
            title={S.browser.devtools.warnings(counters.warnings)}
            className="rounded-full bg-amber-500/15 px-1 text-[10px] font-medium leading-4 text-amber-700 dark:text-amber-400"
          >
            {counters.warnings}
          </span>
        ) : null}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={S.browser.devtools.more} title={S.browser.devtools.more} disabled={!live} className={ICON_BUTTON}>
            <MoreHorizontal className="size-3.5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={props.onDevTools}>{S.browser.devtools.openFull}</DropdownMenuItem>
          <DropdownMenuItem onSelect={props.onClearDevtools}>{S.browser.devtools.clearAll}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {loading ? <div data-testid="browser-loading" className="absolute inset-x-0 -bottom-px h-0.5 animate-pulse bg-blue-500" /> : null}
    </div>
  );
}
```

- [ ] **Шаг 4. Подключить строку к поверхности.**
  - **`BrowserSurface.tsx`:**
    - импорты: `useMemo` — в импорт из `react`; ещё две строки:

```tsx
import type { ViewportSpec } from '../../shared/browser-devtools.js';
import { devtoolsCounters, EMPTY_DEVTOOLS, useDevtoolsStore } from './devtools/store.js';
```

    - в `BrowserSurfaceProps` после `url: string;`:

```tsx
  /** Размер вьюпорта вкладки (`TabSpec.viewport`, спека 2026-10-07, 4.2); null — Fit. */
  viewport: ViewportSpec | null;
```

    - в деструктуризации пропсов `BrowserSurface` после `url,` — `viewport,`;
    - после `const state = useBrowserStore(...) ?? IDLE;`:

```tsx
  const devtools = useDevtoolsStore((store) => store.tabs[tabId]) ?? EMPTY_DEVTOOLS;
  const counters = useMemo(() => devtoolsCounters(devtools), [devtools]);
```

    - после функции `openDevTools`:

```tsx
  // «⋯ → Clear console and network» и «Clear» панели (спека 2026-10-07, 4.1, 4.3): журнал окна — сразу, main — мостом.
  const clearDevtools = (): void => {
    useDevtoolsStore.getState().clear(tabId);
    const id = state.webContentsId;
    if (id === null) return;
    bridge.browser.devtoolsClear(id).catch((error: unknown) => {
      console.error('[parley] devtoolsClear failed', error);
      toast(errorText(decodeIpcError(error).code, S.errors.actions.clearDevtools));
    });
  };

  // Размер вьюпорта (спека 2026-10-07, 4.2) — в раскладку: он переживает перезапуск, эмуляцию ставит поверхность.
  const setViewport = (next: ViewportSpec | null): void => {
    useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId, { viewport: next }));
  };
```

    - в `<BrowserChrome … />` после `onDesignMode={…}`:

```tsx
        viewport={viewport}
        onViewport={setViewport}
        devtoolsOpen={devtools.open}
        counters={counters}
        onToggleDevtools={() => useDevtoolsStore.getState().toggle(tabId)}
        onClearDevtools={clearDevtools}
```

  - **`layout/SurfaceLayer.tsx`:**
    - импорт `import type { ViewportSpec } from '../../shared/browser-devtools.js';`;
    - в `SurfaceSpec` вариант браузера: `{ kind: 'browser'; tabId: string; url: string; viewport: ViewportSpec | null; groupId: string; visible: boolean }`;
    - в цикле: `surfaces.push({ kind: 'browser', tabId: tab.id, url: tab.url, viewport: tab.viewport ?? null, groupId: group.id, visible });`;
    - в `<BrowserSurface … />` после `url={surface.url}`: `viewport={surface.viewport}`.
  - **`shared/strings.ts`:** удалить строку `devTools: 'DevTools',` из `S.browser` — кнопки больше нет.

- [ ] **Шаг 5. Запустить — проходит.**
  - Команда шага 2 → PASS.
  - `pnpm --filter @parley/desktop exec vitest run src/renderer/browser src/renderer/layout src/english-ui.test.ts` → PASS.
  - `pnpm --filter @parley/desktop typecheck` → без ошибок: других читателей `S.browser.devTools` нет, проверено поиском по `src` и `e2e`.

- [ ] **Шаг 6. Закоммитить.**

```bash
git add packages/desktop/src/renderer/browser packages/desktop/src/renderer/layout/SurfaceLayer.tsx packages/desktop/src/shared/strings.ts
git commit -m "feat(desktop): строка вкладки браузера — размер, консоль со счётчиками, меню ⋯ с полным DevTools" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 16. Поверхность: журнал, панель, эмуляция, клавиши

**Файлы:**
- Создать:
  - `packages/desktop/src/renderer/browser/stage.ts` — геометрия поля и высоты панели;
  - `packages/desktop/src/renderer/browser/use-viewport.ts`;
  - `packages/desktop/src/renderer/browser/devtools/use-devtools-feed.ts`.
- Изменить: `packages/desktop/src/renderer/browser/BrowserSurface.tsx` — целиком, текст ниже.
- Тесты: создать `packages/desktop/src/renderer/browser/stage.test.ts`; изменить `packages/desktop/src/renderer/browser/BrowserSurface.test.tsx`.

**Интерфейсы:**
- Берёт:
  - `DevtoolsPanel` (задача 13); `useDevtoolsStore` (задача 9);
  - `bridge.browser.devtoolsSnapshot`, `devtoolsReady`, `onDevtools`, `setViewport` (задача 7);
  - `DEVTOOLS_PANEL`, `useUiStore#patchUi` (задача 8, `renderer/store/ui.ts`);
  - `ACTIONS`, `matchesAccelerator` (`shared/keybindings.ts`).
- Отдаёт:
  - `stage.ts`: `STAGE`, `CHROME_PX`, `MIN_PAGE_PX`, `FieldSize`, `StageBox`, `fitArea(field)`, `stageBox(field, spec, scale)`, `panelHeight(saved, rootHeight)`;
  - `useViewport({ bridge, webContentsId, viewport, field, captureLost }) → AppliedViewport | null`;
  - `useDevtoolsFeed(bridge, tabId, webContentsId, open)`;
  - пометки: `[data-testid="browser-field"]`, `[data-testid="viewport-label"]`.
- Узел `<webview>` при эмуляции не пересоздаётся: меняются только класс и стиль, иначе гость перезагрузился бы (`SurfaceLayer.tsx`, шапка).

- [ ] **Шаг 1. Написать падающие тесты.**

```ts
// packages/desktop/src/renderer/browser/stage.test.ts
import { describe, expect, it } from 'vitest';
import { fitArea, panelHeight, stageBox } from './stage.js';

describe('поле страницы при эмуляции (спека 4.2)', () => {
  it('fitArea: без полей 16 px и строки подписи 20 px; не меньше 1×1', () => {
    expect(fitArea({ width: 800, height: 600 })).toEqual({ width: 768, height: 548 });
    expect(fitArea({ width: 10, height: 10 })).toEqual({ width: 1, height: 1 });
  });

  it('stageBox: Mobile M 2x со scale 0.5 — 187×406 по центру, в подписи процент', () => {
    expect(stageBox({ width: 800, height: 600 }, { preset: 'mobile-m', rotated: false, dpr: 2 }, 0.5)).toEqual({
      left: 307,
      top: 107,
      width: 187,
      height: 406,
      label: '375 × 812 · 2x · 50%',
    });
  });

  it('stageBox: влезает целиком — без процента', () => {
    expect(stageBox({ width: 1600, height: 1000 }, { preset: 'laptop', rotated: false, dpr: 1 }, 1)).toMatchObject({
      left: 160,
      width: 1280,
      height: 800,
      label: '1280 × 800 · 1x',
    });
  });
});

describe('высота панели (спека 4.3)', () => {
  it('по умолчанию — 40 % вкладки; не ниже 120; не выше места над страницей', () => {
    expect(panelHeight(null, 700)).toEqual({ height: 280, max: 584 });
    expect(panelHeight(50, 700)).toEqual({ height: 120, max: 584 });
    expect(panelHeight(900, 700)).toEqual({ height: 584, max: 584 });
    expect(panelHeight(null, 0)).toEqual({ height: 120, max: 120 });
  });
});
```

  В `BrowserSurface.test.tsx`:
  - в импорт из `@testing-library/react` добавить `within`;
  - в импорт из `../layout/tree.js` (там уже `findTab`) добавить `updateTab`;
  - в импорт из `../test-utils/devtools-fixtures.js` (задача 15) добавить `consoleEntry`;
  - новые импорты:

```tsx
import type { ViewportSpec } from '../../shared/browser-devtools.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { useUiStore } from '../store/ui.js';
```

  - в общий `afterEach` файла — `useUiStore.setState({ ui: DEFAULT_UI });`;
  - два существующих теста правятся под вариант D (спайк 0.1): `<webview>` монтируется с `src="about:blank"`, адрес вкладки открывается на первом `dom-ready` после `devtoolsReady`:
    - в `describe('BrowserSurface — новая вкладка (тест 5)')`, в тесте «без адреса: webview нет, фокус в адресной строке; Enter с localhost:5173 — updateTab и webview с этим src», заголовок закончить на `… updateTab и webview (src about:blank) для этого адреса`, а последнюю строку заменить на `expect(webview()?.getAttribute('src')).toBe('about:blank');`;
    - в `describe('BrowserSurface — src один раз (тесты 6, 7)')` тест «did-navigate-in-page — …» заменить целиком:

```tsx
  it('did-navigate-in-page — новый url в раскладке, id прежний, src и loadURL не тронуты; Enter живой страницы — loadURL', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview());
    const setAttribute = vi.spyOn(view, 'setAttribute');
    fire(view, 'dom-ready');
    // Единственный loadURL до адресной строки — первая загрузка после захвата (вариант D).
    await act(async () => {});
    expect(view.loadURL.mock.calls).toEqual([['http://localhost:5173/']]);
    view.loadURL.mockClear();

    fire(view, 'did-navigate-in-page', { url: 'http://localhost:5173/#/next', isMainFrame: true });
    expect(layoutUrlOfTab()).toBe('http://localhost:5173/#/next');
    expect(webview()).toBe(view);
    fire(view, 'did-navigate-in-page', { url: 'http://localhost:5173/frame', isMainFrame: false });
    expect(layoutUrlOfTab()).toBe('http://localhost:5173/#/next');
    expect(setAttribute.mock.calls.filter(([name]) => name === 'src')).toEqual([]);
    expect(view.loadURL).not.toHaveBeenCalled();

    const field = screen.getByRole('textbox', { name: 'Address' });
    fireEvent.change(field, { target: { value: 'localhost:5173/other' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(view.loadURL).toHaveBeenCalledWith('http://localhost:5173/other');
    expect(view.getAttribute('src')).toBe('about:blank');
    expect(setAttribute.mock.calls.filter(([name]) => name === 'src')).toEqual([]);
  });
```

  - в конец файла:

```tsx
const MOBILE_M: ViewportSpec = { preset: 'mobile-m', rotated: false, dpr: 2 };

/** RO с размерами: поле страницы — 800×600, вкладка целиком и прочее — 800×700. */
class SizedResizeObserver {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    const rect = target.matches('[data-testid="browser-field"]') ? { width: 800, height: 600 } : { width: 800, height: 700 };
    this.callback([{ target, contentRect: rect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

function setBrowserTabSized(url: string, viewport: ViewportSpec): void {
  setBrowserTab(url);
  useLayoutStore.getState().apply(WORK_KEY, (layout) => updateTab(layout, TAB, { viewport }));
}

describe('BrowserSurface — журнал (спека 2026-10-07, 3.5; Фокус ревью 4)', () => {
  it('пачка до dom-ready не применяется; на dom-ready — снимок своего гостя; дальше — только его пачки', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 7);
    act(() => bridge.emitDevtools(devtoolsBatch({ webContentsId: 7, console: [consoleEntry(1, { text: 'early' })] })));
    expect(useDevtoolsStore.getState().tabs[TAB]).toBeUndefined();
    bridge.setDevtoolsSnapshot({ epoch: 0, capture: 'on', console: [consoleEntry(1, { text: 'early' })], network: [] });
    fire(view, 'dom-ready');
    await act(async () => {});
    expect(bridge.browserCalls).toContainEqual({ method: 'devtoolsSnapshot', args: [7] });
    expect(useDevtoolsStore.getState().tabs[TAB]?.console.map((item) => item.text)).toEqual(['early']);
    act(() => bridge.emitDevtools(devtoolsBatch({ webContentsId: 7, console: [consoleEntry(2, { level: 'error', text: 'late' })] })));
    act(() => bridge.emitDevtools(devtoolsBatch({ webContentsId: 8, console: [consoleEntry(3, { text: 'foreign' })] })));
    expect(useDevtoolsStore.getState().tabs[TAB]?.console.map((item) => item.text)).toEqual(['early', 'late']);
    expect(screen.getByTestId('devtools-errors').textContent).toBe('1');
  });

  it('кнопка строки — панель; ⌘⌥I в адресной строке — спрятать; ⌘⌥J — сразу Console; закрытие вкладки — журнал убран', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Console and network' }));
    expect(screen.getByTestId('devtools-panel')).toBeTruthy();
    const address = screen.getByRole('textbox', { name: 'Address' });
    fireEvent.keyDown(address, { key: 'ˆ', code: 'KeyI', metaKey: true, altKey: true });
    expect(screen.queryByTestId('devtools-panel')).toBeNull();
    act(() => useDevtoolsStore.getState().patch(TAB, { view: 'network' }));
    fireEvent.keyDown(address, { key: '∆', code: 'KeyJ', metaKey: true, altKey: true });
    expect(useDevtoolsStore.getState().tabs[TAB]).toMatchObject({ open: true, view: 'console' });
    cleanup();
    expect(useDevtoolsStore.getState().tabs[TAB]).toBeUndefined();
  });

  it('открытие панели снимает журнал заново: в болтливой консоли пачки отдают только свежее', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    const snapshots = (): number => bridge.browserCalls.filter((call) => call.method === 'devtoolsSnapshot').length;
    const before = snapshots();
    bridge.setDevtoolsSnapshot({ epoch: 0, capture: 'on', console: [consoleEntry(1), consoleEntry(2)], network: [] });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Console and network' }));
    });
    expect(snapshots()).toBe(before + 1);
    expect(useDevtoolsStore.getState().tabs[TAB]?.console).toHaveLength(2);
  });

  it('late — в панели «Reload to capture earlier requests», Reload — reload() страницы', async () => {
    setBrowserTab('http://localhost:5173/');
    renderWork();
    const view = arm(webview(), 7);
    bridge.setDevtoolsSnapshot({ epoch: 1, capture: 'late', console: [], network: [] });
    fire(view, 'dom-ready');
    await act(async () => {});
    act(() => useDevtoolsStore.getState().show(TAB, 'console'));
    const panel = screen.getByTestId('devtools-panel');
    expect(within(panel).getByRole('status').textContent).toContain('Reload to capture earlier requests');
    fireEvent.click(within(panel).getByRole('button', { name: 'Reload' }));
    expect(view.reload).toHaveBeenCalledTimes(1);
  });
});

describe('BrowserSurface — размер вьюпорта (спека 2026-10-07, 4.2)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', SizedResizeObserver);
  });

  it('Mobile M: setViewport(id, размер, место под страницу); тот же webview — по scale и по центру; подпись с процентом', async () => {
    setBrowserTabSized('http://localhost:5173/', MOBILE_M);
    bridge.setViewportScale(0.5);
    renderWork();
    const view = arm(webview(), 7);
    fire(view, 'dom-ready');
    await act(async () => {});
    expect(bridge.browserCalls).toContainEqual({ method: 'setViewport', args: [7, MOBILE_M, { width: 768, height: 548 }] });
    expect(webview()).toBe(view);
    expect([view.style.left, view.style.top, view.style.width, view.style.height]).toEqual(['307px', '107px', '187px', '406px']);
    expect(screen.getByTestId('viewport-label').textContent).toContain('375 × 812 · 2x · 50%');
  });

  it('Fit после размера — setViewport(id, null), webview во всё поле, подписи нет; Fit сразу — main не зовётся', async () => {
    setBrowserTabSized('http://localhost:5173/', MOBILE_M);
    renderWork();
    const view = arm(webview(), 7);
    fire(view, 'dom-ready');
    await act(async () => {});
    await act(async () => {
      useLayoutStore.getState().apply(WORK_KEY, (layout) => updateTab(layout, TAB, { viewport: null }));
    });
    expect(bridge.browserCalls.filter((call) => call.method === 'setViewport').at(-1)?.args.slice(0, 2)).toEqual([7, null]);
    expect(view.style.width).toBe('');
    expect(screen.queryByTestId('viewport-label')).toBeNull();
    cleanup();
    bridge = createFakeBridge();
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    expect(bridge.browserCalls.some((call) => call.method === 'setViewport')).toBe(false);
  });

  it('мобильный размер на документе без касаний — «Reload to apply touch»; после перезагрузки подсказки нет (спайк 0.3)', async () => {
    setBrowserTabSized('http://localhost:5173/', MOBILE_M);
    renderWork();
    const view = arm(webview(), 7);
    fire(view, 'did-navigate', { url: 'http://localhost:5173/' });
    fire(view, 'dom-ready');
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Reload to apply touch' }));
    expect(view.reload).toHaveBeenCalledTimes(1);
    fire(view, 'did-navigate', { url: 'http://localhost:5173/' });
    expect(screen.queryByRole('button', { name: 'Reload to apply touch' })).toBeNull();
  });

  it('высота панели — из ui.json; ручка пишет новую в настройки окна', async () => {
    useUiStore.setState({ ui: { ...useUiStore.getState().ui, browser: { devtoolsHeight: 300 } } });
    setBrowserTab('http://localhost:5173/');
    renderWork();
    fire(arm(webview(), 7), 'dom-ready');
    await act(async () => {});
    act(() => useDevtoolsStore.getState().show(TAB, 'console'));
    expect(screen.getByTestId('devtools-panel').style.height).toBe('300px');
    const handle = screen.getByRole('separator', { name: 'Resize panel' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 450 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 450 });
    expect(useUiStore.getState().ui.browser.devtoolsHeight).toBe(350);
    expect(screen.getByTestId('devtools-panel').style.height).toBe('350px');
  });
});

describe('BrowserSurface — первая загрузка после захвата (спайк 0.1, вариант D; Фокус ревью 6)', () => {
  it('webview стартует с about:blank; адрес вкладки — на первом dom-ready и только после devtoolsReady; дальше не повторяется', async () => {
    setBrowserTab('http://localhost:5173/app');
    let release: () => void = () => {};
    bridge.setDevtoolsReady(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    renderWork();
    const view = arm(webview(), 7);
    expect(view.getAttribute('src')).toBe('about:blank');
    fire(view, 'dom-ready');
    await act(async () => {});
    expect(bridge.browserCalls).toContainEqual({ method: 'devtoolsReady', args: [7] });
    expect(view.loadURL).not.toHaveBeenCalled();
    await act(async () => release());
    expect(view.loadURL.mock.calls).toEqual([['http://localhost:5173/app']]);
    // dom-ready открытой страницы ничего не открывает: ни ожидания захвата, ни повторной загрузки.
    fire(view, 'dom-ready');
    await act(async () => {});
    expect(view.loadURL).toHaveBeenCalledTimes(1);
    expect(bridge.browserCalls.filter((call) => call.method === 'devtoolsReady')).toHaveLength(1);
  });

  it('devtoolsReady отказал — страница всё равно открывается', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setBrowserTab('http://localhost:5173/');
    bridge.setDevtoolsReady({ code: 'failed', message: 'boom' });
    renderWork();
    const view = arm(webview(), 7);
    fire(view, 'dom-ready');
    await act(async () => {});
    expect(view.loadURL.mock.calls).toEqual([['http://localhost:5173/']]);
    warn.mockRestore();
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/renderer/browser/stage.test.ts src/renderer/browser/BrowserSurface.test.tsx` → FAIL: нет `stage.js`, снимка на `dom-ready`, панели, эмуляции и `devtoolsReady`.

- [ ] **Шаг 3. Реализовать геометрию.**

```ts
// packages/desktop/src/renderer/browser/stage.ts
/**
 * Геометрия поверхности вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, 4.2, 4.3).
 * - При эмуляции размера страница стоит по центру нейтрального поля, над ней — подпись «375 × 812 · 2x». Не влезает —
 *   уменьшена по `scale` из main, в подписи процент.
 * - Высота панели Console | Network — сохранённая или 40 % вкладки, не ниже 120 px; странице над панелью остаётся место.
 */
import { viewportSize, type ViewportSpec } from '../../shared/browser-devtools.js';
import { S } from '../../shared/strings.js';
import { DEVTOOLS_PANEL } from '../../shared/ui-types.js';

/** Поля вокруг страницы и строка подписи над ней, CSS-пиксели окна. */
export const STAGE = { pad: 16, label: 20 } as const;
/** Строка над страницей — `h-9` в `BrowserChrome`. */
export const CHROME_PX = 36;
/** Над панелью странице остаётся не меньше этого. */
export const MIN_PAGE_PX = 80;

export interface FieldSize {
  width: number;
  height: number;
}

export interface StageBox {
  left: number;
  top: number;
  width: number;
  height: number;
  label: string;
}

/** Место под страницу: поле без полей по краям и строки подписи; не меньше 1×1 — main ждёт положительные числа. */
export function fitArea(field: FieldSize): FieldSize {
  return {
    width: Math.max(1, Math.floor(field.width - 2 * STAGE.pad)),
    height: Math.max(1, Math.floor(field.height - 2 * STAGE.pad - STAGE.label)),
  };
}

/** Где стоит страница размера `spec`, уменьшенная по `scale`, и что написано над ней. */
export function stageBox(field: FieldSize, spec: ViewportSpec, scale: number): StageBox {
  const size = viewportSize(spec);
  const width = Math.floor(size.width * scale);
  const height = Math.floor(size.height * scale);
  const area = fitArea(field);
  return {
    left: Math.max(0, Math.round((field.width - width) / 2)),
    top: STAGE.pad + STAGE.label + Math.max(0, Math.round((area.height - height) / 2)),
    width,
    height,
    label: S.browser.viewport.label(size.width, size.height, size.dpr, scale < 1 ? Math.round(scale * 100) : null),
  };
}

/** Высота панели: сохранённая или 40 % вкладки, не ниже 120 и не выше, чем оставляет место странице. */
export function panelHeight(saved: number | null, rootHeight: number): { height: number; max: number } {
  const max = Math.max(DEVTOOLS_PANEL.minHeight, Math.floor(rootHeight - CHROME_PX - MIN_PAGE_PX));
  const wanted = saved ?? Math.round(rootHeight * DEVTOOLS_PANEL.defaultShare);
  return { height: Math.min(Math.max(wanted, DEVTOOLS_PANEL.minHeight), max), max };
}
```

- [ ] **Шаг 4. Реализовать хуки журнала и эмуляции.**

```ts
// packages/desktop/src/renderer/browser/devtools/use-devtools-feed.ts
/**
 * Журнал гостя в окне (спека 2026-10-07-browser-devtools-agent-design.md, 3.5, раздел 9).
 * - Как только известен гость (`dom-ready`), — снимок `devtoolsSnapshot`, дальше — пачки `browser:devtools` своего гостя.
 * - Пачки до `dom-ready` фильтр по id отбрасывает: их возвращает снимок (Фокус ревью 4). Подписка — раньше снимка: пачка
 *   между ними уже в снимке, а повтор записи по id безвреден.
 * - Открытие панели снимает журнал заново: в болтливой консоли пачки несут только свежее (Фокус ревью 1).
 * - Вкладка ушла — её журнал из окна убран.
 */
import { useEffect } from 'react';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { useDevtoolsStore } from './store.js';

export function useDevtoolsFeed(bridge: ParleyBridge, tabId: string, webContentsId: number | null, open: boolean): void {
  useEffect(() => {
    if (webContentsId === null) return undefined;
    return bridge.browser.onDevtools((batch) => {
      if (batch.webContentsId === webContentsId) useDevtoolsStore.getState().batch(tabId, batch);
    });
  }, [bridge, tabId, webContentsId]);

  useEffect(() => {
    if (webContentsId === null) return undefined;
    let current = true;
    bridge.browser.devtoolsSnapshot(webContentsId).then(
      (snapshot) => {
        if (current) useDevtoolsStore.getState().snapshot(tabId, snapshot);
      },
      (error: unknown) => console.warn('[parley] devtools snapshot failed', error),
    );
    return () => {
      current = false;
    };
  }, [bridge, tabId, webContentsId, open]);

  useEffect(() => () => useDevtoolsStore.getState().remove(tabId), [tabId]);
}
```

```ts
// packages/desktop/src/renderer/browser/use-viewport.ts
/**
 * Эмуляция размера вкладки в окне (спека 2026-10-07-browser-devtools-agent-design.md, 4.2).
 * - Размер из раскладки уходит в main (`setViewport`) вместе с местом под страницу; ответ `scale` ставит `<webview>`.
 * - Повтор — на смену размера, поля и гостя и после возврата захвата: отцепившийся отладчик эмуляцию теряет.
 * - Fit без прежней эмуляции main не трогает. Отказ — тост, страница во всё поле.
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ParleyBridge } from '../../shared/bridge.js';
import type { ViewportSpec } from '../../shared/browser-devtools.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { fitArea, type FieldSize } from './stage.js';

export interface AppliedViewport {
  spec: ViewportSpec;
  scale: number;
}

export function useViewport(input: {
  bridge: ParleyBridge;
  webContentsId: number | null;
  viewport: ViewportSpec | null;
  field: FieldSize | null;
  /** Захват недоступен: команды CDP откажут — ждём его возврата. */
  captureLost: boolean;
}): AppliedViewport | null {
  const { bridge, webContentsId, viewport, field, captureLost } = input;
  const [applied, setApplied] = useState<AppliedViewport | null>(null);
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  const width = field?.width ?? null;
  const height = field?.height ?? null;

  useEffect(() => {
    if (webContentsId === null || captureLost || width === null || height === null) return undefined;
    if (viewport === null && appliedRef.current === null) return undefined;
    let current = true;
    bridge.browser.setViewport(webContentsId, viewport, fitArea({ width, height })).then(
      ({ scale }) => {
        if (current) setApplied(viewport === null ? null : { spec: viewport, scale });
      },
      (error: unknown) => {
        if (!current) return;
        console.error('[parley] setViewport failed', error);
        toast(errorText(decodeIpcError(error).code, S.errors.actions.setViewport));
        setApplied(null);
      },
    );
    return () => {
      current = false;
    };
  }, [bridge, webContentsId, viewport, width, height, captureLost]);

  return applied;
}
```

- [ ] **Шаг 5. Переписать поверхность.** `BrowserSurface.tsx` целиком. Это прежний файл с правками задачи 15 и новыми частями:
  - замер поля и вкладки;
  - журнал гостя и эмуляция;
  - первая загрузка после захвата (спайк 0.1, вариант D): `src="about:blank"` и `devtoolsReady` перед `loadURL`;
  - поле с подписью;
  - панель;
  - клавиши ⌘⌥I и ⌘⌥J.

```tsx
// packages/desktop/src/renderer/browser/BrowserSurface.tsx
/**
 * Поверхность вкладки браузера (кусок 9.2a, спека 12.1, 12.2): строка над страницей и
 * `<webview>` в слое поверхностей работы (`layout/SurfaceLayer.tsx`), привязанные CSS-якорем к телу
 * группы — как у терминала. Перенос вкладки меняет только якорь: узел `<webview>` в DOM не
 * переносится, иначе гость перезагрузился бы. Это держит сортировка слоя по id вкладки (2.5).
 *
 * Страница — недоверенная: мостов окна и Node в госте нет (страж main, 9.1), а рендерер зовёт
 * у `<webview>` только навигацию — `loadURL`, `goBack`, `goForward`, `reload`, `stop`.
 * Программный доступ к странице — только у main (спека 12.2): Design Mode (9.3b) тоже идёт мостом —
 * `pickStart` и `pickCancel`, а не `executeJavaScript` у `<webview>`.
 *
 * `<webview>` монтируется один раз, при первом адресе http(s) вкладки, и с `src="about:blank"` (спайк 0.1, вариант D):
 * к пустому гостю main уже подключил отладчик, а адрес вкладки окно открывает на первом `dom-ready` после
 * `devtoolsReady` — иначе подресурсы первой загрузки (стили, картинки, скрипты из HTML) прошли бы мимо журнала.
 * Гость сам пишет в `src` адрес коммита, а любое присвоение `src` — новая загрузка: проп с адресом вкладки
 * перезагружал бы страницу на каждом переходе SPA и делал бы «назад» новой навигацией. Адрес идёт только из
 * страницы в раскладку (`updateTab`), обратно — нет; адресная строка живой страницы — `loadURL`.
 *
 * Консоль, сеть и размер (спека 2026-10-07-browser-devtools-agent-design.md, 4.1–4.3, 4.9):
 * - журнал гостя — снимок и пачки main (`devtools/use-devtools-feed.ts`); панель — снизу вкладки, высота общая
 *   (`ui.json`); ⌘⌥I и ⌘⌥J с фокусом в строке или панели ловит этот компонент;
 * - размер — из раскладки (`TabSpec.viewport`): эмуляцию ставит main (`use-viewport.ts`), а окно ставит тот же узел
 *   `<webview>` размером ширина×scale на высота×scale по центру нейтрального поля с подписью.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { WorkEntry } from '@parley/core';
import type { ParleyBridge } from '../../shared/bridge.js';
import { viewportSize, type ViewportSpec } from '../../shared/browser-devtools.js';
import { BROWSER_PARTITION } from '../../shared/browser-types.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { ACTIONS, matchesAccelerator, type ActionId, type KeyLike } from '../../shared/keybindings.js';
import { errorText, S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { useLayoutStore } from '../layout/store.js';
import { focusTab, updateTab } from '../layout/tree.js';
import { useUiStore } from '../store/ui.js';
import { isHttpUrl } from '../terminal/links.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { BrowserChrome } from './BrowserChrome.js';
import { DesignModeCard } from './DesignModeCard.js';
import { DevtoolsPanel } from './devtools/DevtoolsPanel.js';
import { devtoolsCounters, EMPTY_DEVTOOLS, useDevtoolsStore } from './devtools/store.js';
import { useDevtoolsFeed } from './devtools/use-devtools-feed.js';
import { FindBar } from './FindBar.js';
import { panelHeight, STAGE, stageBox, type FieldSize } from './stage.js';
import { clearAddressFocus, useBrowserStore, wantsAddressFocus, type BrowserTabState } from './store.js';
import { layoutUrl } from './url.js';
import { useViewport } from './use-viewport.js';

/** Методы `<webview>` Electron, которые зовёт окно; до `dom-ready` они бросают. */
interface WebviewElement extends HTMLElement {
  getWebContentsId(): number;
  loadURL(url: string): Promise<void>;
  reload(): void;
  stop(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
}

/** Поля событий `<webview>` лежат на самом событии (`Electron.*Event` у `WebviewTag`). */
type WebviewEvent = Event & { url?: string; title?: string; isMainFrame?: boolean; errorCode?: number };

/** `net::ERR_ABORTED`: загрузку прервали (новый переход, Stop, скачивание) — это не ошибка страницы. */
const ERR_ABORTED = -3;

/** Стартовая страница `<webview>` (спайк 0.1, вариант D): страж пускает такой `src`, адрес вкладки открывается позже. */
const BLANK_SRC = 'about:blank';

/**
 * Атрибуты `<webview>` строками: React 18 булев `allowpopups` у тега без дефиса не выводит, а
 * @types/react типизирует его как boolean. Без атрибута Electron гасит `window.open` и
 * `target=_blank` ещё до `setWindowOpenHandler` (9.1), и вкладка по ссылке не откроется.
 */
const WEBVIEW_ATTRIBUTES = {
  partition: BROWSER_PARTITION,
  webpreferences: 'contextIsolation=yes, sandbox=yes',
  allowpopups: 'true',
} as Record<string, string>;

/**
 * Клавиши панели (спека 2026-10-07, 4.9) — из реестра. В странице их пересылает main; с фокусом в строке или панели
 * вкладки — этот обработчик: рендерер окна действия `browser` не ловит (`keys/handler.ts#whenAllows`).
 */
const PANEL_KEYS = ACTIONS.filter((action) => action.id === 'browser.devtools' || action.id === 'browser.console');

function panelKey(event: KeyLike): ActionId | null {
  return PANEL_KEYS.find((action) => action.keys !== null && matchesAccelerator(action.keys, event))?.id ?? null;
}

export interface BrowserSurfaceProps {
  workKey: string;
  tabId: string;
  /** Адрес вкладки из раскладки; '' — новая вкладка. */
  url: string;
  /** Размер вьюпорта вкладки (`TabSpec.viewport`, спека 2026-10-07, 4.2); null — Fit. */
  viewport: ViewportSpec | null;
  groupId: string;
  visible: boolean;
  bridge: ParleyBridge;
  /** Работа вкладки — сессии получателей карточки Design Mode (9.3b). */
  entry: WorkEntry;
  sendDeps: SendWithToastDeps;
}

const IDLE: BrowserTabState = {
  title: null,
  favicon: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  crashed: false,
  webContentsId: null,
  findOpen: false,
  loadFailed: false,
  pick: 'off',
};

export function BrowserSurface({ workKey, tabId, url, viewport, groupId, visible, bridge, entry, sendDeps }: BrowserSurfaceProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<WebviewElement | null>(null);
  const readyRef = useRef(false);
  // Адрес вкладки уже открывали после захвата (спайк 0.1): повторные dom-ready страницы его не открывают.
  const firstPageRef = useRef(false);
  // Номер текущего выбора Design Mode: ответ выбора, который уже сняли (⌖, Esc, навигация), карточку не ставит.
  const pickTokenRef = useRef(0);
  const state = useBrowserStore((store) => store.tabs[tabId]) ?? IDLE;
  const devtools = useDevtoolsStore((store) => store.tabs[tabId]) ?? EMPTY_DEVTOOLS;
  const counters = useMemo(() => devtoolsCounters(devtools), [devtools]);
  const devtoolsHeight = useUiStore((store) => store.ui.browser.devtoolsHeight);

  // Первый адрес http(s) — и только он — открывается в `<webview>`. Без адреса (новая вкладка) и с чужим
  // адресом (раскладку правили руками) — заглушка: открывать нечего.
  const [src, setSrc] = useState<string | null>(() => (isHttpUrl(url) ? url : null));
  if (src === null && isHttpUrl(url)) setSrc(url);

  // Фокус адресной строки — только у вкладки, которую человек открыл сейчас (перенос 9.2a), а не у
  // пустой вкладки восстановленной раскладки. Просьба читается при монтировании и снимается эффектом.
  const [addressFocus] = useState(() => wantsAddressFocus(tabId));
  useEffect(() => clearAddressFocus(tabId), [tabId]);

  // Поле страницы и вкладка целиком (спека 2026-10-07, 4.2, 4.3): поле — место под страницу при эмуляции, вкладка —
  // предел высоты панели. Размеры — из ResizeObserver: CSS-якорь меняет их без React.
  const [field, setField] = useState<FieldSize | null>(null);
  const [rootHeight, setRootHeight] = useState(0);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const fieldNode = fieldRef.current;
    if (root === null || fieldNode === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((items) => {
      for (const item of items) {
        if (item.target === root) setRootHeight(item.contentRect.height);
        else setField({ width: item.contentRect.width, height: item.contentRect.height });
      }
    });
    observer.observe(root);
    observer.observe(fieldNode);
    return () => observer.disconnect();
  }, []);

  // Журнал гостя: снимок на dom-ready и при открытии панели, дальше — пачки своего гостя (Фокус ревью 4).
  useDevtoolsFeed(bridge, tabId, state.webContentsId, devtools.open);
  const applied = useViewport({
    bridge,
    webContentsId: state.webContentsId,
    viewport,
    field,
    captureLost: devtools.capture === 'unavailable',
  });
  const stage = applied === null || field === null ? null : stageBox(field, applied.spec, applied.scale);
  // Касания включаются с новым документом (спайк 0.3): мобильный размер на странице без них — подсказка «Reload».
  const appliedMobile = applied !== null && viewportSize(applied.spec).mobile;
  const appliedMobileRef = useRef(appliedMobile);
  appliedMobileRef.current = appliedMobile;
  const [docMobile, setDocMobile] = useState(false);
  const touchStale = stage !== null && appliedMobile !== docMobile;

  // Якорные свойства — через `setProperty`, как у терминала: в `CSSProperties` @types/react 18 их нет.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    el.style.setProperty('position-anchor', `--g-${groupId}`);
    el.style.setProperty('top', 'anchor(top)');
    el.style.setProperty('left', 'anchor(left)');
    el.style.setProperty('width', 'anchor-size(width)');
    el.style.setProperty('height', 'anchor-size(height)');
  }, [groupId]);

  // `inert` в React 18 — не булев проп. Скрытая вкладка не получает ни фокуса, ни кликов.
  useLayoutEffect(() => {
    rootRef.current?.toggleAttribute('inert', !visible);
  }, [visible]);

  const setView = useCallback((node: HTMLElement | null) => {
    viewRef.current = node as WebviewElement | null;
  }, []);

  // События `<webview>` React не знает — только `addEventListener`.
  useEffect(() => {
    const view = viewRef.current;
    if (src === null || view === null) return;
    readyRef.current = false;
    const update = (patch: Partial<BrowserTabState>): void => useBrowserStore.getState().update(tabId, patch);
    const history = (): void => {
      if (!readyRef.current) return;
      try {
        update({ canGoBack: view.canGoBack(), canGoForward: view.canGoForward() });
      } catch (error) {
        console.warn('[parley] webview history unavailable', error);
      }
    };
    // Адрес — только в раскладку, и только http(s) без user:pass@ (спека 12.1).
    const saveUrl = (next: string | undefined): void => {
      const safe = next === undefined ? null : layoutUrl(next);
      if (safe !== null) useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId, { url: safe }));
    };
    // Первая страница вкладки (спайк 0.1, вариант D): `<webview>` стартует с about:blank, main к его первому dom-ready
    // уже подключил отладчик и ждёт ответов enable. Адрес открываем после `devtoolsReady`: иначе подресурсы первой
    // загрузки прошли бы мимо журнала. Отказ захвата страницу не держит.
    const openFirstPage = (id: number): void => {
      if (firstPageRef.current) return;
      firstPageRef.current = true;
      const open = (): void => {
        view.loadURL(src).catch((error: unknown) => console.warn('[parley] first page load failed', error));
      };
      bridge.browser.devtoolsReady(id).then(open, (error: unknown) => {
        console.warn('[parley] devtools capture is not ready, opening the page anyway', error);
        open();
      });
    };

    const listeners: Record<string, (event: WebviewEvent) => void> = {
      // Раньше dom-ready getWebContentsId() бросает.
      'dom-ready': () => {
        readyRef.current = true;
        const id = view.getWebContentsId();
        update({ webContentsId: id });
        history();
        openFirstPage(id);
      },
      'did-start-loading': () => update({ loading: true, crashed: false, loadFailed: false }),
      'did-stop-loading': () => update({ loading: false }),
      'page-title-updated': (event) => update({ title: event.title ?? null }),
      // Новый документ: заголовок и значок прежней страницы ему не принадлежат.
      // Карточка и выбор прошлой страницы к новой не относятся; main и сам ответит выбору null (9.3a).
      // Касания у нового документа — как у эмуляции в этот миг (спайк 0.3).
      'did-navigate': (event) => {
        saveUrl(event.url);
        pickTokenRef.current += 1;
        setDocMobile(appliedMobileRef.current);
        update({ title: null, favicon: null, pick: 'off' });
        history();
      },
      'did-navigate-in-page': (event) => {
        if (event.isMainFrame === true) saveUrl(event.url);
        history();
      },
      // Полоса поиска мёртвой страницы искать не может: закрывается вместе с падением.
      'render-process-gone': () => update({ crashed: true, loading: false, findOpen: false }),
      // Chromium в `<webview>` своей страницы ошибки не рисует — без слоя человек видел бы пустоту.
      'did-fail-load': (event) => {
        if (event.isMainFrame === true && event.errorCode !== ERR_ABORTED) update({ loadFailed: true });
      },
    };
    for (const [type, listener] of Object.entries(listeners)) view.addEventListener(type, listener);
    return () => {
      for (const [type, listener] of Object.entries(listeners)) view.removeEventListener(type, listener);
    };
  }, [bridge, src, tabId, workKey]);

  // Favicon качает main (CSP окна внешних картинок не пускает) и шлёт всем вкладкам окна; своя — по id гостя.
  useEffect(
    () =>
      bridge.browser.onFavicon((event) => {
        const own = useBrowserStore.getState().tabs[tabId]?.webContentsId ?? null;
        if (own !== null && event.webContentsId === own) useBrowserStore.getState().update(tabId, { favicon: event.dataUrl });
      }),
    [bridge, tabId],
  );

  useEffect(() => () => useBrowserStore.getState().remove(tabId), [tabId]);

  /** Метод живой страницы; до `dom-ready` Electron бросает — это не повод ронять окно. */
  const onPage = (action: (view: WebviewElement) => unknown): void => {
    const view = viewRef.current;
    if (view === null) return;
    try {
      const result = action(view);
      if (result instanceof Promise) result.catch((error: unknown) => console.warn('[parley] webview navigation failed', error));
    } catch (error) {
      console.warn('[parley] webview is not ready', error);
    }
  };

  const navigate = (next: string): void => {
    if (src !== null) {
      onPage((view) => view.loadURL(next));
      return;
    }
    // Страницы ещё нет: адрес — в раскладку, и `<webview>` смонтируется с ним как с первым `src`.
    const safe = layoutUrl(next);
    if (safe !== null) useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId, { url: safe }));
  };

  const reload = (): void => {
    useBrowserStore.getState().update(tabId, { crashed: false, loadFailed: false });
    onPage((view) => view.reload());
  };

  const openDevTools = (): void => {
    const id = state.webContentsId;
    if (id === null) return;
    bridge.browser.openDevTools(id).catch((error: unknown) => {
      console.error('[parley] openDevTools failed', error);
      toast(errorText(decodeIpcError(error).code, S.errors.actions.openDevTools));
    });
  };

  // «⋯ → Clear console and network» и «Clear» панели (спека 2026-10-07, 4.1, 4.3): журнал окна — сразу, main — мостом.
  const clearDevtools = (): void => {
    useDevtoolsStore.getState().clear(tabId);
    const id = state.webContentsId;
    if (id === null) return;
    bridge.browser.devtoolsClear(id).catch((error: unknown) => {
      console.error('[parley] devtoolsClear failed', error);
      toast(errorText(decodeIpcError(error).code, S.errors.actions.clearDevtools));
    });
  };

  // Размер вьюпорта (спека 2026-10-07, 4.2) — в раскладку: он переживает перезапуск; эмуляцию ставит useViewport.
  const setViewport = (next: ViewportSpec | null): void => {
    useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId, { viewport: next }));
  };

  // Design Mode (спека 12.3): выбор — только по ⌖ или «Pick again» человека.
  const startPick = (): void => {
    const id = state.webContentsId;
    if (id === null) return;
    pickTokenRef.current += 1;
    const token = pickTokenRef.current;
    const update = (patch: Partial<BrowserTabState>): void => {
      if (token === pickTokenRef.current) useBrowserStore.getState().update(tabId, patch);
    };
    update({ pick: 'picking' });
    bridge.browser.pickStart(id).then(
      (result) => update({ pick: result === null ? 'off' : { result } }),
      (error: unknown) => {
        if (token !== pickTokenRef.current) return;
        console.error('[parley] pickStart failed', error);
        toast(errorText(decodeIpcError(error).code, S.errors.actions.pickElement));
        update({ pick: 'off' });
      },
    );
  };

  const cancelPick = (): void => {
    const id = state.webContentsId;
    pickTokenRef.current += 1;
    useBrowserStore.getState().update(tabId, { pick: 'off' });
    if (id !== null) bridge.browser.pickCancel(id).catch((error: unknown) => console.warn('[parley] pickCancel failed', error));
  };

  const picking = state.pick === 'picking';

  // Скрытую вкладку человек не видит: выбор в ней снимается, а не ест клики страницы до возврата.
  const cancelPickRef = useRef(cancelPick);
  cancelPickRef.current = cancelPick;
  useEffect(() => {
    if (!visible && picking) cancelPickRef.current();
  }, [visible, picking]);

  // Поверхность — сосед тела группы, а не потомок: клик в строку сама делает свою вкладку активной.
  const focusOwnTab = (): void => {
    useLayoutStore.getState().apply(workKey, (layout) => focusTab(layout, tabId));
  };

  const live = src !== null && state.webContentsId !== null;
  const panel = panelHeight(devtoolsHeight, rootHeight);
  const commitPanelHeight = (height: number): void => {
    const ui = useUiStore.getState();
    ui.patchUi({ browser: { ...ui.ui.browser, devtoolsHeight: height } });
  };

  return (
    <div
      ref={rootRef}
      data-tab-id={tabId}
      className="absolute flex flex-col overflow-hidden bg-background"
      style={{ visibility: visible ? 'visible' : 'hidden' }}
      onPointerDownCapture={focusOwnTab}
      onFocusCapture={focusOwnTab}
      onKeyDown={(event) => {
        // Esc при фокусе в окне (после клика по ⌖ он на кнопке): в странице Esc ловит сам скрипт выбора.
        if (event.key === 'Escape' && picking) {
          event.preventDefault();
          cancelPick();
          return;
        }
        // ⌘⌥I и ⌘⌥J с фокусом в строке или панели вкладки (спека 2026-10-07, 4.9).
        const action = live ? panelKey(event.nativeEvent) : null;
        if (action === null) return;
        event.preventDefault();
        if (action === 'browser.console') useDevtoolsStore.getState().show(tabId, 'console');
        else useDevtoolsStore.getState().toggle(tabId);
      }}
    >
      <BrowserChrome
        url={url}
        loading={state.loading}
        canGoBack={state.canGoBack}
        canGoForward={state.canGoForward}
        live={live}
        focusAddress={addressFocus && src === null && visible}
        onBack={() => onPage((view) => view.goBack())}
        onForward={() => onPage((view) => view.goForward())}
        onReload={reload}
        onStop={() => onPage((view) => view.stop())}
        onNavigate={navigate}
        onDevTools={openDevTools}
        picking={picking}
        onDesignMode={picking ? cancelPick : startPick}
        viewport={viewport}
        onViewport={setViewport}
        devtoolsOpen={devtools.open}
        counters={counters}
        onToggleDevtools={() => useDevtoolsStore.getState().toggle(tabId)}
        onClearDevtools={clearDevtools}
      />
      <div ref={fieldRef} data-testid="browser-field" className={cn('relative min-h-0 flex-1 overflow-hidden', stage !== null && 'bg-muted')}>
        {src === null ? (
          <div data-testid="browser-placeholder" className="h-full w-full bg-background" />
        ) : (
          // Белая подложка: гость прозрачен, и страница без своего фона легла бы на тёмную тему окна. При эмуляции —
          // тот же узел, другие класс и стиль: новый узел перезагрузил бы гостя. `src` всегда about:blank: адрес вкладки
          // открывает openFirstPage (вариант D).
          <webview
            ref={setView}
            src={BLANK_SRC}
            className={stage === null ? 'flex h-full w-full bg-white' : 'absolute flex bg-white shadow-md'}
            {...(stage === null ? {} : { style: { left: stage.left, top: stage.top, width: stage.width, height: stage.height } })}
            {...WEBVIEW_ATTRIBUTES}
          />
        )}
        {stage === null ? null : (
          <div
            data-testid="viewport-label"
            className="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-1 text-[11px] text-muted-foreground"
            style={{ top: stage.top - STAGE.label, height: STAGE.label }}
          >
            <span>{stage.label}</span>
            {touchStale ? (
              <button type="button" onClick={reload} className="pointer-events-auto underline">
                {S.browser.viewport.touchReload}
              </button>
            ) : null}
          </div>
        )}
        {state.findOpen && state.webContentsId !== null ? (
          // Полоса поиска (⌘F в странице, 9.2b) — поверх страницы, как у терминала.
          <FindBar
            bridge={bridge}
            webContentsId={state.webContentsId}
            onClose={() => {
              useBrowserStore.getState().update(tabId, { findOpen: false });
              // Поиск открыли из страницы (⌘F в ней) — туда и фокус, как у терминала с его SearchBar.
              viewRef.current?.focus();
            }}
          />
        ) : null}
        {typeof state.pick === 'object' ? (
          <DesignModeCard workKey={workKey} entry={entry} result={state.pick.result} sendDeps={sendDeps} onPickAgain={startPick} />
        ) : null}
        {state.loadFailed && !state.crashed ? (
          <div
            data-testid="browser-load-failed"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground"
          >
            <span>{S.browser.loadFailed}</span>
            <button
              type="button"
              onClick={reload}
              className="rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-accent"
            >
              {S.browser.reload}
            </button>
          </div>
        ) : null}
        {state.crashed ? (
          // Слой поверх страницы: тело группы лежит под поверхностью, и заглушка в нём была бы не видна.
          <div
            data-testid="browser-crashed"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground"
          >
            <span>{S.browser.pageCrashed}</span>
            <button
              type="button"
              onClick={reload}
              className="rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-accent"
            >
              {S.browser.reload}
            </button>
          </div>
        ) : null}
      </div>
      {devtools.open ? (
        <DevtoolsPanel
          tabId={tabId}
          webContentsId={state.webContentsId}
          pageUrl={url}
          bridge={bridge}
          height={panel.height}
          maxHeight={panel.max}
          onResize={commitPanelHeight}
          onReload={reload}
          onClear={clearDevtools}
        />
      ) : null}
    </div>
  );
}
```

  Порядок детей поля не меняется: `<webview>` всегда первый. Подпись, полоса поиска и слои идут после него. React поэтому не пересоздаёт узел гостя при переходе Fit ↔ размер; тест «тот же webview» это ловит.

- [ ] **Шаг 6. Запустить — проходит.**
  - Команда шага 2 → PASS.
  - `pnpm --filter @parley/desktop exec vitest run src/renderer/browser src/renderer/layout src/english-ui.test.ts` → PASS, прежние тесты поверхности тоже.
  - `pnpm --filter @parley/desktop typecheck` → без ошибок.
  - `pnpm --filter @parley/desktop test` → зелёный.

- [ ] **Шаг 7. Закоммитить.**

```bash
git add packages/desktop/src/renderer/browser
git commit -m "feat(desktop): поверхность браузера — журнал гостя, панель снизу, эмуляция размера, ⌘⌥I и ⌘⌥J, первая загрузка после захвата" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 17. E2E: панель, размер, узкое окно

**Файлы:**
- Создать: `packages/desktop/e2e/browser-devtools.spec.ts`

**Интерфейсы:**
- Берёт:
  - помощники E2E: `quitApp`, `stopApp` (`e2e/stop-app.ts`), `stopHost` (`e2e/stop-host.ts`), `makeTempHome`, `makeTempProject` (`e2e/tmp.ts`), `e2e/stub-echo-agent.mjs`;
  - приёмы `browser-page.spec.ts`: `menu`, `guestUrls`, ввод в гостя `sendInputEvent`.
- Покрывает:
  - спека 10 — E2E 1, 5 и 7;
  - «Фокус ревью» — п. 2, 3 и 6.

- [ ] **Шаг 1. Написать E2E.**

```ts
// packages/desktop/e2e/browser-devtools.spec.ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { quitApp, stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Консоль, сеть и размеры вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, раздел 10: E2E 1, 5, 7).
 * - Страница своего сервера пишет в консоль, бросает исключение и отказ промиса, ходит за 500 с JSON, за 404 и на чужой
 *   origin без CORS: панель показывает всё это, счётчики верны, тело 500 читается; ⌘⌥I и ⌘⌥J работают из страницы.
 *   Стиль и картинка из HTML видны в сети с первой загрузки, без перезагрузки; «назад» после неё неактивна
 *   (спайк 0.1, вариант D).
 * - Mobile M даёт странице `innerWidth` 375 и переживает перезапуск окна.
 * - 800×500 при DPR 1 и 2 с длинными адресом, работой и сессией: строка и панель не вылезают за края.
 * Внешних сайтов нет — два своих сервера на 127.0.0.1 (второй — «чужой origin» для CORS). Настоящий `claude` не
 * запускается. Ввод в гостя — `sendInputEvent` main, как в `browser-page.spec.ts`. Снимки — `test-results/browser-devtools/`.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const shots = path.resolve(dirname, '../test-results/browser-devtools');
/** Название работы и ярлык сессии — по 60 символов (Фокус ревью 2). */
const LONG_TITLE = `devtools-workspace-${'w'.repeat(41)}`;
const LONG_LABEL = `devtools-session-${'s'.repeat(43)}`;

/**
 * Страница: консоль всех уровней, исключение, отказ промиса, 500, 404 и CORS; значок — data:, без лишнего запроса.
 * Стиль и картинка из HTML (оба 200, счётчик ошибок не меняют) проверяют подресурсы первой загрузки (спайк 0.1).
 */
function devtoolsPage(corsOrigin: string): string {
  return `<!doctype html><title>Devtools page</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/app.css">
<script>
  console.log('hello', { theme: 'dark', items: [1, 2] });
  console.warn('careful');
  console.error(new Error('broken'));
  setTimeout(() => { throw new Error('boom'); }, 0);
  Promise.reject(new Error('nope'));
  fetch('/api/fail').catch(() => {});
  fetch('/missing').catch(() => {});
  fetch('${corsOrigin}/data').catch(() => {});
</script>
<img src="/logo.svg" alt="" width="1" height="1"><p>devtools page</p>`;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
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

/** JS в мире страницы гостя — только у теста: окну и агенту этого не дано. */
async function guestEval<T>(app: ElectronApplication, prefix: string, code: string): Promise<T | null> {
  return app.evaluate(
    async ({ webContents }, [p, c]) => {
      const guest = webContents.getAllWebContents().find((item) => item.getType() === 'webview' && item.getURL().startsWith(p));
      return guest === undefined ? null : ((await guest.executeJavaScript(c)) as unknown);
    },
    [prefix, code] as const,
  ) as Promise<T | null>;
}

/** Нажатие в гостя — как его увидел бы before-input-event от человека. */
async function pressInGuest(app: ElectronApplication, prefix: string, keyCode: string, modifiers: Array<'meta' | 'alt'>): Promise<void> {
  await app.evaluate(
    ({ webContents }, [p, k, m]) => {
      const guest = webContents.getAllWebContents().find((item) => item.getType() === 'webview' && item.getURL().startsWith(p as string));
      const mods = m as Array<'meta' | 'alt'>;
      guest?.sendInputEvent({ type: 'keyDown', keyCode: k as string, modifiers: mods });
      guest?.sendInputEvent({ type: 'keyUp', keyCode: k as string, modifiers: mods });
    },
    [prefix, keyCode, modifiers] as const,
  );
}

test.describe('консоль, сеть и размеры вкладки браузера (этап A)', () => {
  test.setTimeout(120_000);
  let home: string;
  let project: string;
  let server: Server;
  let cors: Server;
  let origin: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('browser-devtools');
    project = await makeTempProject('browser-devtools');
    // «Чужой origin»: ответ без Access-Control-Allow-Origin — fetch со страницы падает по CORS.
    cors = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    const corsOrigin = await listen(cors);
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      if (pathname === '/api/fail') {
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"db down"}');
        return;
      }
      if (pathname === '/' || pathname.startsWith('/long/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(devtoolsPage(corsOrigin));
        return;
      }
      if (pathname === '/app.css') {
        res.writeHead(200, { 'content-type': 'text/css' }).end('body { margin: 0; }');
        return;
      }
      if (pathname === '/logo.svg') {
        res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    });
    origin = await listen(server);
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => cors.close(() => resolve()));
  });

  async function launch(extraArgs: string[] = []): Promise<{ electronApp: ElectronApplication; window: Page }> {
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry, ...extraArgs], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    return { electronApp, window };
  }

  async function setSize(electronApp: ElectronApplication, width: number, height: number): Promise<void> {
    await electronApp.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...size }), { width, height });
  }

  /** Работа с сессией; клик по строке сессии делает работу активной. */
  async function openWork(window: Page, title: string, label: string): Promise<void> {
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title, goal: '' });
    const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label,
      task: '',
      parent: null,
    });
    await window.locator(`[data-work-key="${project} ${workId}"] [data-session-id="${created.ref.sessionId}"]`).click();
    await expect(window.locator(`[role="tab"][data-tab-id="terminal:${created.ref.sessionId}"]`)).toBeVisible();
  }

  async function openPage(electronApp: ElectronApplication, window: Page, url: string): Promise<void> {
    await menu(electronApp, 'browser.newTab');
    const address = window.getByRole('textbox', { name: 'Address' });
    await expect(address).toBeFocused();
    await address.fill(url);
    await address.press('Enter');
    await expect.poll(() => guestUrls(electronApp)).toEqual([url]);
  }

  test('панель: консоль, исключения, 500, 404 и CORS; счётчики 6 и 1; тело 500; подресурсы первой загрузки; ⌘⌥I и ⌘⌥J из страницы (E2E 1)', async () => {
    const { electronApp, window } = await launch();
    await setSize(electronApp, 1400, 900);
    await expect(window.getByTestId('landing')).toBeVisible();
    await openWork(window, 'e2e-devtools', 'agent');
    // Без перезагрузки (спайк 0.1, вариант D): гость стартует с about:blank, страница открывается после включения журнала.
    await openPage(electronApp, window, `${origin}/`);

    // Красный — console.error, исключение, отказ промиса, 500, 404 и CORS; жёлтый — console.warn (Фокус ревью 3).
    await expect(window.getByTestId('devtools-errors')).toHaveText('6');
    await expect(window.getByTestId('devtools-warnings')).toHaveText('1');
    // Пустая страница не осталась в истории (Фокус ревью 6): «назад» после первой загрузки неактивна.
    await expect(window.getByTestId('browser-chrome').getByRole('button', { name: 'Back' })).toBeDisabled();

    // ⌘⌥I из страницы — панель, ещё раз — спрятана; ⌘⌥J — сразу на Console.
    const panel = window.getByTestId('devtools-panel');
    await pressInGuest(electronApp, `${origin}/`, 'I', ['meta', 'alt']);
    await expect(panel).toBeVisible();
    await pressInGuest(electronApp, `${origin}/`, 'I', ['meta', 'alt']);
    await expect(panel).toHaveCount(0);
    await pressInGuest(electronApp, `${origin}/`, 'J', ['meta', 'alt']);
    await expect(panel.getByRole('tab', { name: 'Console' })).toHaveAttribute('data-state', 'active');

    const message = (text: string) => panel.locator('[data-console-row]', { hasText: text });
    await expect(message("hello {theme: 'dark', items: Array(2)}")).toHaveAttribute('data-level', 'info');
    await expect(message('careful')).toHaveAttribute('data-level', 'warning');
    await expect(message('Error: broken')).toHaveAttribute('data-level', 'error');
    await expect(message('Uncaught Error: boom')).toBeVisible();
    await expect(message('Uncaught (in promise) Error: nope')).toBeVisible();

    await panel.getByRole('tab', { name: 'Network' }).click();
    const request = (text: string) => panel.locator('[data-network-row]', { hasText: text });
    await expect(request('/api/fail')).toContainText('500');
    await expect(request('/missing')).toContainText('404');
    await expect(request('/data')).toContainText('CORS');
    // Подресурсы первой загрузки (Фокус ревью 6): стиль и картинка из HTML видны без перезагрузки, захват не поздний.
    await expect(request('/app.css')).toContainText('200');
    await expect(request('/logo.svg')).toContainText('200');
    await expect(panel.getByRole('status')).toHaveCount(0);
    await request('/api/fail').click();
    await panel.getByRole('tab', { name: 'Response' }).click();
    await expect(panel.getByTestId('response-body')).toContainText('"error": "db down"');
  });

  test('Mobile M: в странице innerWidth 375 и подпись размера; размер переживает перезапуск окна (E2E 5)', async () => {
    let { electronApp, window } = await launch();
    await setSize(electronApp, 1400, 900);
    await expect(window.getByTestId('landing')).toBeVisible();
    await openWork(window, 'e2e-viewport', 'agent');
    await openPage(electronApp, window, `${origin}/`);
    await window.getByRole('button', { name: 'Viewport size' }).click();
    await window.getByRole('menuitemradio', { name: /Mobile M/ }).click();
    await expect.poll(() => guestEval<number>(electronApp, `${origin}/`, 'innerWidth')).toBe(375);
    await expect(window.getByTestId('viewport-label')).toContainText('375 × 812 · 2x');

    await quitApp(electronApp);
    app = null;
    ({ electronApp, window } = await launch());
    await setSize(electronApp, 1400, 900);
    await expect.poll(() => guestEval<number>(electronApp, `${origin}/`, 'innerWidth'), { timeout: 30_000 }).toBe(375);
    await expect(window.getByTestId('viewport-label')).toContainText('375 × 812 · 2x');
  });

  for (const dpr of [1, 2]) {
    test(`800×500 при DPR ${dpr}: адрес 300 знаков, работа и сессия по 60 — строка и панель в пределах (E2E 7; Фокус ревью 2)`, async () => {
      const { electronApp, window } = await launch([`--force-device-scale-factor=${dpr}`]);
      await setSize(electronApp, 800, 500);
      await expect(window.getByTestId('landing')).toBeVisible();
      expect(await window.evaluate(() => globalThis.devicePixelRatio)).toBe(dpr);
      await openWork(window, LONG_TITLE, LONG_LABEL);
      const prefix = `${origin}/long/`;
      await openPage(electronApp, window, prefix + 'a'.repeat(300 - prefix.length));
      // Как в E2E 1: без перезагрузки, журнал первой загрузки полный.
      await expect(window.getByTestId('devtools-errors')).toHaveText('6');

      await window.getByRole('button', { name: 'Console and network' }).click();
      const panel = window.getByTestId('devtools-panel');
      await expect(panel).toBeVisible();
      await panel.getByRole('tab', { name: 'Network' }).click();
      await panel.locator('[data-network-row]', { hasText: '/api/fail' }).click();
      await expect(panel.getByTestId('request-details')).toBeVisible();

      const layout = await window.evaluate(() => {
        const box = (element: Element): DOMRect => element.getBoundingClientRect();
        const chrome = document.querySelector('[data-testid="browser-chrome"]');
        const panelNode = document.querySelector('[data-testid="devtools-panel"]');
        const details = document.querySelector('[data-testid="request-details"]');
        if (chrome === null || panelNode === null || details === null) throw new Error('нет строки, панели или деталей');
        const chromeBox = box(chrome);
        return {
          viewportWidth: document.documentElement.clientWidth,
          chromeRight: chromeBox.right,
          chromeOverflow: chrome.scrollWidth - chrome.clientWidth,
          outside: [...chrome.querySelectorAll('button, input')]
            .filter((node) => box(node).right > chromeBox.right + 0.5 || box(node).left < chromeBox.left - 0.5)
            .map((node) => node.getAttribute('aria-label')),
          panelOverflow: panelNode.scrollWidth - panelNode.clientWidth,
          panelRight: box(panelNode).right,
          detailsRight: box(details).right,
          detailsWidth: box(details).width,
        };
      });
      expect(layout.chromeOverflow).toBeLessThanOrEqual(0);
      expect(layout.outside).toEqual([]);
      expect(layout.chromeRight).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.panelOverflow).toBeLessThanOrEqual(0);
      expect(layout.detailsRight).toBeLessThanOrEqual(layout.panelRight + 0.5);
      expect(layout.detailsWidth).toBeGreaterThan(200);
      await window.screenshot({ path: path.join(shots, `800x500-dpr${dpr}.png`) });
    });
  }
});
```

- [ ] **Шаг 2. Запустить E2E.**

  `pnpm --filter @parley/desktop build && pnpm --filter @parley/desktop exec playwright test e2e/browser-devtools.spec.ts` → PASS (4 теста).

  Если не сходится:
  - **Ошибок не 6.** Сначала посмотреть строки консоли в панели. Ошибка без `networkRequestId` (так может прийти строка CORS) — строка браузера, счётчик её не считает: так и задумано (Фокус ревью 3). Если в счёт попало лишнее, проверить `origin` записи в `consoleFromLog` (задача 3), а не менять ожидание теста.
  - **⌘⌥I из страницы не дошёл.** Проверить в `app.evaluate`, что у `before-input-event` гостя `input.alt === true`. Синтетическое нажатие может прийти без `code`; тогда реестр узнаёт клавишу по `key` (`matchesAccelerator`).
  - **DPR не 2.** Проверить, что ключ дошёл до Chromium: `app.commandLine.hasSwitch('force-device-scale-factor')` в `electronApp.evaluate`.
  - **Нет `/app.css` или `/logo.svg` в Network, ошибок не 6.** Гость начал грузиться раньше, чем домены включились. Проверить, что окно зовёт `devtoolsReady` до `loadURL` (задача 16) и что у `<webview>` `src` — `about:blank`.
  - **«Назад» активна после первой загрузки.** Страж не убрал пустую запись: проверить `pruneBlankEntry` (задача 5) и порядок событий — `did-navigate` страницы приходит раньше, чем окно спрашивает `canGoBack`.

- [ ] **Шаг 3. Прогнать соседние E2E браузера** — правка строки и поверхности их не должна задеть.

  `pnpm --filter @parley/desktop exec playwright test e2e/browser.spec.ts e2e/browser-page.spec.ts e2e/browser-tab.spec.ts e2e/browser-guard.spec.ts` → PASS.

- [ ] **Шаг 4. Закоммитить.**

```bash
git add packages/desktop/e2e/browser-devtools.spec.ts
git commit -m "test(desktop): E2E консоли и сети, размера Mobile M и окна 800×500 при DPR 1 и 2" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 18. Документы этапа

**Файлы:**
- Изменить:
  - `CHANGELOG.md` — раздел `Unreleased`;
  - `README.md` — абзац о встроенном браузере и таблица клавиш;
  - `docs/specs/2026-09-26-desktop-orca-ui-design.md` — 12.1, 12.4, 12.5 и абзац об инспекторе в 12.2 (см. «Расхождения с индексом», п. 7).
- Тест: `packages/desktop/src/release-docs.test.ts`. В README и CHANGELOG нет кириллицы и прежнего имени проекта. Имя раздела `persist:…` в README не писать.

- [ ] **Шаг 1. CHANGELOG.** В `## Unreleased` → `### Added` первыми пунктами:

```markdown
- **Console and network in the browser tab.** The console button in the tab's bar (⌘⌥I; ⌘⌥J opens it on
  Console) shows a panel at the bottom of the tab. Console lists the page's messages and exceptions with the
  levels Errors, Warnings, Info and Debug, a text filter, repeats as "×N", the stack of an error, objects as a
  short preview and "Copy". Network lists the requests with type filters, "Failed only" and a URL filter; a
  request opens Headers, Payload and Response — the body up to 1 MB. A red counter on the button shows the
  errors of the current page (console errors, exceptions and failed requests), a yellow one — the warnings.
- **Viewport sizes for the browser tab.** Fit, Mobile S/M/L, Tablet, Laptop, Desktop, "Custom…", "Rotate" and
  1x/2x/3x: the page is emulated at that size (mobile sizes with touch and a mobile user agent) and centered
  with a "375 × 812 · 2x" label; the size stays with the tab after a restart.
```

  В `### Changed` первым пунктом:

```markdown
- The "DevTools" button of a browser tab moved to "⋯" → "Open full DevTools"; the same menu has "Clear console
  and network".
```

- [ ] **Шаг 2. README.**
  - **Абзац о встроенном браузере.** Предложение `There are the buttons "Back" / "Forward", "Reload" (or "Stop" while loading) and "DevTools".` заменить. В файле оно перенесено на две строки: после `while` идёт перевод строки.

```markdown
There are the buttons "Back" / "Forward", "Reload" (or "Stop" while loading), the viewport size, the console with
error and warning counters, and "⋯" with "Open full DevTools" (Chromium DevTools in its own window) and "Clear
console and network".
```

  - **Два новых пункта** — перед пунктом `- Design Mode: the ⌖ in the bar above the page; …`:

```markdown
- the console and network of a browser tab: the console button (⌘⌥I; ⌘⌥J opens the panel on Console) shows a
  panel at the bottom of the tab, and its height is shared by all tabs. Console lists the page's messages,
  exceptions and the browser's own lines with the levels "Errors", "Warnings", "Info" and "Debug" (off by
  default), a text filter, "×N" for repeats in a row, the stack of an error, objects as a short preview and
  "Copy". Network lists the requests with "All", "Fetch/XHR", "Doc", "JS", "CSS", "Img", "Other", "Failed
  only" and a URL filter; a request opens "Headers", "Payload" and "Response" — the body up to 1 MB, loaded on
  click; "Body is no longer available" means Chromium has already dropped it — and "Copy URL". The red counter
  on the button counts the console errors, exceptions and failed requests of the current page; the yellow one
  counts the console warnings. Without "Preserve log" a new page clears the panel. A tab keeps up to 1000
  messages and 500 requests. "Reload to capture earlier requests" means the page began loading before the
  capture; "Capture unavailable — reload the page" means it could not attach. Headers and bodies are shown as
  they are: it is your browser, nothing goes to an agent;
- the viewport size of a browser tab: "Fit" (the default), "Mobile S" 320×568, "Mobile M" 375×812, "Mobile L"
  430×932, "Tablet" 768×1024, "Laptop" 1280×800, "Desktop" 1440×900, "Custom…" (200–3840 × 200–2400),
  "Rotate" and 1x/2x/3x. Mobile sizes and "Tablet" emulate touch and a mobile user agent; touch applies from
  the next page load ("Reload to apply touch"). The page stands in the middle of the tab with a label like
  "375 × 812 · 2x" and is scaled down, with a percent in the label, when it does not fit. The size is kept
  with the tab and survives a restart;
```

  - **Таблица клавиш** — после строки `| Browser page zoom | ⌘+ / ⌘− / ⌘0 | — |`:

```markdown
| Console and network of a browser tab; open it on Console | ⌘⌥I; ⌘⌥J — in the page or the tab's bar | — |
```

- [ ] **Шаг 3. Спека окна, 12.1.** Список под «Строка над страницей, 36px:» заменить:

```markdown
Строка над страницей, 36px (спека 2026-10-07-browser-devtools-agent-design.md, 4.1):
- «назад», «вперёд», «перезагрузить» / «остановить»;
- адресная строка — на узкой вкладке сжимается первой;
- размер вьюпорта: Fit, Mobile S 320×568, Mobile M 375×812, Mobile L 430×932, Tablet 768×1024, Laptop 1280×800,
  Desktop 1440×900, Custom… (200–3840 × 200–2400), Rotate, DPR 1x/2x/3x. Страница стоит по центру нейтрального
  поля с подписью «375 × 812 · 2x»; не влезает — уменьшена, в подписи процент. Мобильные размеры — с касаниями и
  мобильным UA; касания включаются с новым документом («Reload to apply touch»). Уменьшает страницу только показ в
  окне: сама страница видит заданный размер, а картинка с неё (снимок этапа C) — размер вида × DPR, у Mobile M 2x это
  750 × 1624 (спайк 0.3). Размер хранится у вкладки (`TabSpec.viewport`), у Fit поля нет;
- ⌖ Design Mode;
- консоль: значок со счётчиками — красный (ошибки консоли, исключения и упавшие запросы текущей страницы) и
  жёлтый (предупреждения консоли), нули не показываются; показывает и прячет панель Console | Network (⌘⌥I; ⌘⌥J —
  сразу Console);
- «⋯»: «Open full DevTools» (прежняя кнопка «DevTools») и «Clear console and network»;
- индикатор загрузки — полоса 2px под строкой.

На узкой вкладке подписи прячутся (контейнерный запрос строки), остаются значки.

**Панель Console | Network** — снизу вкладки. Высота общая для вкладок (`ui.json`, `browser.devtoolsHeight`;
минимум 120 px, по умолчанию 40 % вкладки), ручка — над панелью.
- Console: уровни Errors, Warnings, Info, Debug (Debug выключен), фильтр по тексту, `×N` для повторов подряд,
  раскрытие стека у ошибки, объекты — кратким предпросмотром CDP, «Copy».
- Network: типы All, Fetch/XHR, Doc, JS, CSS, Img, Other, «Failed only», фильтр URL; список виртуальный, по времени
  начала. Детали — справа, на узкой панели поверх списка: Headers, Payload, Response (тело по клику, до 1 МБ;
  вытесненное Chromium — «Body is no longer available»), «Copy URL».
- «Preserve log»: без него новая страница очищает вид, с ним — разделитель «Navigated to …». Поздний захват —
  «Reload to capture earlier requests», отказ — «Capture unavailable — reload the page».
- Заголовки и тела — как есть: это браузер человека.
```

- [ ] **Шаг 4. Спека окна, 12.2.**
  - Перед пунктом `- **Агент браузером не управляет.** …` вставить:

```markdown
- **Инспектор CDP** (`main/browser/inspector.ts`, спека 2026-10-07-browser-devtools-agent-design.md, 3.3).
  - Страж подключает `webContents.debugger` к каждому гостю на `web-contents-created`, до первой загрузки: `<webview>`
    стартует с `src` `about:blank` (страж пускает такой `src`), а адрес вкладки окно открывает после `devtoolsReady`,
    когда домены включены (спайк 0.1, вариант D). Пустая первая запись истории гостя убирается.
  - Инспектор ведёт журнал консоли и сети для панели вкладки: кольца на вкладку, эпохи документов, пачки окну
    событием `browser:devtools`.
  - Команды — только из закрытого списка `CDP_ALLOWED`: `enable`/`disable` доменов `Runtime`, `Log`, `Page`,
    `Network`, `Network.getResponseBody` и четыре команды `Emulation.*` для размера. `Runtime.evaluate` в нём нет.
  - Переходы — по-прежнему методами `webContents`, их видит страж. Полный DevTools с инспектором уживается.
```

  - В пункте «Агент браузером не управляет» второе предложение заменить: «Программный доступ к странице есть только у main: по действию человека — Design Mode, DevTools и размер вьюпорта; инспектор CDP только читает консоль и сеть.». Сам пункт целиком заменит этап C.

- [ ] **Шаг 5. Спека окна, 12.4.** В конец списка:

```markdown
- Журнал вкладки (спека 2026-10-07, раздел 8):
  - до 1000 сообщений — текст до 10 000 символов, стек до 20 кадров;
  - до 500 запросов — URL до 4096 символов, до 64 заголовков по 2 КБ, тело запроса до 64 КБ.
- Буфер тел Chromium — 5 МБ на ответ и 50 МБ на вкладку; тело в панели — до 1 МБ.
- Окну журнал идёт пачками раз в ~150 мс, до 200 записей.
- Размеры: Custom 200–3840 × 200–2400, DPR 1–3.
```

- [ ] **Шаг 6. Спека окна, 12.5.**
  - В блок `interface BrowserApi { … }` перед закрывающей скобкой:

```ts
  // Консоль, сеть и размер (спека 2026-10-07-browser-devtools-agent-design.md, 3.5; этап A)
  devtoolsSnapshot(webContentsId: number): Promise<DevtoolsSnapshot>;  // журнала нет — пустой, capture 'unavailable'
  devtoolsClear(webContentsId: number): Promise<void>;
  devtoolsReady(webContentsId: number): Promise<void>;  // все enable отработали: после этого окно открывает адрес вкладки
  responseBody(webContentsId: number, requestId: string): Promise<ResponseBody | null>;  // до 1 МБ; null — тело вытеснено
  onDevtools(listener: (batch: DevtoolsBatch) => void): () => void;  // пачки ~150 мс, до 200 записей
  setViewport(webContentsId: number, spec: ViewportSpec | null, area: { width: number; height: number }): Promise<{ scale: number }>;  // null — Fit
```

  - После блока к пунктам о `webContentsId` добавить пункт: «Типы журнала и размеров — `shared/browser-devtools.ts`. Каналы — `browser:devtools-snapshot`, `browser:devtools-clear`, `browser:devtools-ready`, `browser:response-body`, `browser:set-viewport`, событие `browser:devtools`.».

- [ ] **Шаг 7. Проверить документы.** `pnpm --filter @parley/desktop exec vitest run src/release-docs.test.ts` → PASS.

- [ ] **Шаг 8. Закоммитить.**

```bash
git add CHANGELOG.md README.md docs/specs/2026-09-26-desktop-orca-ui-design.md
git commit -m "docs: консоль, сеть и размеры вкладки браузера — README, CHANGELOG, спека окна 12.1, 12.2, 12.4, 12.5" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Задача 19. Завершение этапа

По чек-листу индекса, «Завершение этапа».

- [ ] **Шаг 1. Полный прогон.**
  - Команды: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm --filter @parley/desktop e2e`.
  - Числа — против исходного прогона из абзаца «Сверка с этапом 0».
  - Флейки сравниваются с исходным прогоном, а не чинятся мимоходом: `works-service` хоста под нагрузкой, порог тишины FSEvents.

- [ ] **Шаг 2. Визуальная проверка в dev-окне** (`pnpm dev:desktop`).
  - **Окно и экраны:**
    - окно 800×500, длинные адрес, название работы и ярлык сессии;
    - DPR 1 — внешний экран при 100 % или снимок `test-results/browser-devtools/800x500-dpr1.png`;
    - DPR 2 — экран MacBook или снимок `…-dpr2.png`.
  - **Пройти руками:**
    - страница с ошибками консоли: строки, `×N`, раскрытие стека, «Copy»;
    - Network: «Failed only», детали 500, «Response» с отформатированным JSON;
    - «Custom…»: поля в поповере берут фокус, Esc закрывает;
    - Mobile M: клик мышью по кнопке страницы попадает (спайк 0.3), «Reload to apply touch» включает касания;
    - первая загрузка без перезагрузки (спайк 0.1, вариант D): стиль и картинки страницы в Network, «назад» неактивна; страница на закрытом порту — «Couldn't load page», «назад» тоже неактивна;
    - ⌘⌥I в странице, в адресной строке и в фильтре панели;
    - «⋯ → Open full DevTools» при открытой панели: журнал панели продолжает идти (проба 1.4 спеки);
    - ручка высоты над страницей: страница мышь не перехватывает.

- [ ] **Шаг 3. CHANGELOG и README** — сделаны в задаче 18. Сверить строки с тем, что вышло.

- [ ] **Шаг 4. Спека окна** — 12.1, 12.4, 12.5 и абзац об инспекторе в 12.2 сделаны в задаче 18. Сверить с кодом: имена каналов, пределы, порядок строки.

- [ ] **Шаг 5. Ревью ветки свежим ревьюером** (навык superpowers:requesting-code-review).
  - Ревьюеру — этот план, индекс и спеку; в фокусе — шесть пунктов «Фокуса ревью».
  - Правки по ревью — отдельными коммитами.

- [ ] **Шаг 6. Push ветки `feat/browser-devtools`, PR во встроенном браузере** (`gh` не установлен).
  - Описание: что сделано; исходный и итоговый прогон; итог сверки с этапом 0; снимки 800×500.
  - Последняя строка описания — `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
  - Вливает человек.

---

## Расхождения с индексом

Имена индекса план не переименовывает. Ниже — места, где индекс молчит или где код требует уточнения, и что предлагает план.

1. **Тайм-аут команды CDP (10 с).** Это число спайка 0.1 (дольше него `Inspector.ready` страницу вкладки не держит), а не предел раздела 8. В `DEVTOOLS_LIMITS`, форму которого задаёт индекс, его нет. План держит его константой `CDP_COMMAND_MS` в `main/browser/inspector.ts`.
   - Если правило «чисел мимо констант нет» распространяется и на него, индексу стоит дописать `commandMs: 10_000` в `DEVTOOLS_LIMITS`, а `inspector.ts` — брать его оттуда.
2. **`devtoolsSnapshot` без журнала.** По индексу `Inspector.snapshot(id)` отдаёт `DevtoolsSnapshot | null`, а мост по спеке 3.5 — объект.
   - План: канал `browser:devtools-snapshot` превращает `null` в `{ epoch: 0, capture: 'unavailable', console: [], network: [] }`.
   - `BrowserApi.devtoolsSnapshot` отдаёт `Promise<DevtoolsSnapshot>` без `null`.
3. **Клавиши `when: 'browser'` с фокусом в окне.** Рендерер такие действия не ловит (`keys/handler.ts#whenAllows`): их из страницы пересылает main.
   - Чтобы ⌘⌥I и ⌘⌥J работали с фокусом в адресной строке и в фильтрах панели, `BrowserSurface` ловит те же сочетания реестра сам (`onKeyDown` корня поверхности).
   - Реестр и `when` — как в индексе.
4. **Мусор в `TabSpec.viewport` на диске.** Индекс не говорит, что с ним делать.
   - У поля `view` вкладки терминала мусор делает невалидной всю раскладку.
   - Для размера план выбрал мягче: вкладка без размера (Fit), раскладка цела. Размер — удобство, и терять из-за него раскладку работы несоразмерно.
5. **`S.browser.devTools`.** Прежняя строка кнопки «DevTools» после переноса в «⋯» не нужна, а именем сталкивается с пространством индекса `S.browser.devtools`. План её удаляет (задача 15).
6. **Строки слотов «Add to chat».** Кнопки слотов живут в панели этапа A, поэтому `S.browser.devtools.addToChat` и `addErrorsToChat` заводит A.
   - Этап B передаёт только колбэки: `onAddConsoleToChat`, `onAddRequestToChat`, `onAddErrorsToChat` у `DevtoolsPanel`, `onAddToChat` у `ConsoleView`, `NetworkView` и `RequestDetails`.
   - B не заводит эти строки заново в `S.browser.target.*`.
7. **Абзац об инспекторе в 12.2 спеки окна.** По индексу 12.2 правит этап C, но инспектор появляется в A.
   - План A дописывает в 12.2 абзац об инспекторе CDP (журнал и закрытый список этапа A) и уточняет одно предложение пункта «Агент браузером не управляет».
   - Сам пункт и правило агента оставлены этапу C.
8. **`createEmulation(deps)`.** Индекс: `deps: { inspector: Inspector }`. План берёт `Pick<Inspector, 'send'>`. Это совместимо: полный `Inspector` подходит. Этап C расширит выборку, если `withTemporary` понадобится `onEvent`.
9. **Что считает красный счётчик.** Спека 4.1: «ошибки консоли, исключения и упавшие запросы». Индекс не уточняет, что делать со строками `Log.entryAdded`.
   - План считает ошибки консоли (`'console'`), исключения (`'exception'`), ошибки браузера без запроса (`'browser'` — нарушение CSP и прочее) и упавшие запросы (`isFailed`).
   - Строки сети (`'network'`) видны в списке красными, но в счётчик не идут. Иначе одна 500 или CORS считалась бы дважды: «Failed to load resource…» плюс сам запрос. Строку CORS задача 3 относит к `'network'`, потому что у неё есть `networkRequestId`.
   - Решение принято при сверке индекса 2026-10-07: первая версия плана не считала и CSP. Тест — задача 9.
10. **`Inspector.ready` и `devtoolsReady` (спайк 0.1, вариант D).** Отчёт этапа 0: «main подключает отладчик, ждёт `enable`, затем `loadURL`». Индекс не знает ни метода инспектора, ни канала. План добавляет `Inspector.ready(id)`, канал `browser:devtools-ready` и `bridge.browser.devtoolsReady(id)`.
    - Адрес вкладки открывает окно (`loadURL` у `<webview>`) на первом `dom-ready` пустой страницы, после ответа `devtoolsReady`. Порядок тот же, что в отчёте: сначала ответы `enable`, потом загрузка.
    - Вариант «main зовёт `loadURL` сам» отвергнут: мосту пришлось бы принимать адрес и открывать его в госте. Сейчас у моста нет ни одного метода навигации, и страж по-прежнему проверяет всё, что идёт в гостя (спека окна 12.2).
    - `ready` не бросает: отказ и тайм-аут `enable` дают `capture: 'unavailable'`, страница открывается не позже чем через `CDP_COMMAND_MS`.
11. **Пустая запись истории гостя (спайк 0.1, вариант D).** Отчёт её не упоминает. Проверка на Electron 44.4.5:
    - после `about:blank` и `loadURL` у гостя две записи, «назад» ведёт на пустую страницу; если страница не загрузилась (порт закрыт), то же самое, при этом `did-navigate` нет, есть `did-fail-load`;
    - `navigationHistory.removeEntryAtIndex(0)` на первом `did-navigate` страницы или `did-fail-load` главного фрейма оставляет одну запись, и `canGoBack` false.
    - Страж убирает запись сам (задача 5); E2E задачи 17 проверяет, что «назад» неактивна.
