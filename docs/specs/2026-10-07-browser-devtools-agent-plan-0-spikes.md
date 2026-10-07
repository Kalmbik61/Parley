# Браузер Parley, этап 0: спайки — план

> **Для исполнителей-агентов:** обязательный навык — superpowers:executing-plans (задачи по одной, сам исполнитель). Шаги отмечены флажками (`- [ ]`). Код продукта этот этап не трогает.

**Цель:** проверить на Electron 44.4.5 семь мест, на которые опираются этапы A–D. Записать факты и решения в отчёт `docs/research/2026-10-08-browser-stage0.md`.

**Устройство:**
- Все пробы — одноразовые скрипты Electron main в scratchpad сессии, `$S`. Их запускает бинарник Electron из `packages/desktop/node_modules/electron` worktree.
- Общий стенд `harness.cjs` даёт:
  - локальный HTTP-сервер страниц;
  - окно-хозяина с `webviewTag: true`;
  - монтирование `<webview>` с теми же атрибутами, что у Parley: `partition`, `webpreferences="contextIsolation=yes, sandbox=yes"`, `allowpopups`;
  - журнал и сторож-таймер.
- Каждый спайк — свой скрипт и свой `--user-data-dir`. Итог печатается в stdout одной строкой JSON.

**Стек:** Electron 44.4.5, Node 22, CDP 1.3 через `webContents.debugger`, React 18.3.1 (UMD из `node_modules`), React 19 (`npm pack` во временную папку), esbuild из `node_modules`, `@modelcontextprotocol/sdk` 1.30.

**Спека:** `docs/specs/2026-10-07-browser-devtools-agent-design.md`, раздел 12 «Этап 0». **Индекс плана:** `docs/specs/2026-10-07-browser-devtools-agent-plan.md`, таблица «Умолчания до спайков» — каждый спайк подтверждает или меняет её строку.

**Где работать:**
- worktree `.claude/worktrees/browser-stage0`, ветка `research/browser-stage0` от свежего `origin/master` — команды в индексе, «Как начать этап»;
- после `pnpm install` бинарник Electron лежит в `packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`;
- рабочие файлы проб — только в scratchpad сессии (`$S` ниже), не в репозитории. В репозиторий попадает только отчёт.

## Глобальные ограничения

- Проект не меняется: ни строки кода продукта, ни зависимостей в `package.json`.
- Спайки открывают окна Electron на экране человека. Каждый скрипт закрывается сам: сторож — 20 с, `app.exit(0)`.
- Живые запуски `claude` и `codex` (спайк 0.5) тратят лимит подписки человека. Перед запуском — спросить разрешения. Без «да» спайк 0.5 заканчивается записью «не проверено, умолчание остаётся; проверка — в живых проверках этапа D».
- Отчёт пишется по-русски; имена API, кодов и команд — как есть.
- Коммит: `docs(research): этап 0 браузера — спайки CDP, эмуляции и ввода` со строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Фокус ревью

1. **Повторяемость.** Каждый вывод о поведении подтверждён не меньше чем 5 запусками. Если результат плавает, в отчёте это записано с долей успехов, например «8 из 10», а решение берёт худший случай.
2. **Состояние, как в Parley.** Скрытая вкладка в Parley — это `visibility: hidden` у контейнера поверхности (`BrowserSurface.tsx`: `style={{ visibility: visible ? 'visible' : 'hidden' }}`), а не `display: none`. Спайк 0.2 проверяет именно это.
3. **Масштаб и эмуляция вместе.** Координаты проверяются при `setZoomLevel(0)` и `setZoomLevel(2)` и с эмуляцией, вписанной с `scale < 1`. Это ловит ошибку пересчёта, которую сравнение на масштабе 1 не видит.

---

## Задача 1. Стенд проб

**Файлы:** `$S/harness.cjs` (scratchpad).

- [ ] **Шаг 1. Задать переменные оболочки** (в каждой новой оболочке этапа).

```bash
export S="${CLAUDE_SCRATCHPAD:-$(mktemp -d)}/browser-stage0"   # каталог scratchpad сессии, иначе временный
mkdir -p "$S"
export WT="$PWD"                                # корень worktree browser-stage0
export E="$WT/packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
test -x "$E" && "$E" --version                  # ждём v44.4.5
```

- [ ] **Шаг 2. Записать стенд.**

```js
// $S/harness.cjs — общий стенд спайков этапа 0 (одноразовый, вне репозитория).
const { app, BrowserWindow, nativeImage } = require('electron');
const http = require('node:http');

// Без обработчика Electron завершается, когда закрыто последнее окно, — а спайки закрывают окно между прогонами.
app.on('window-all-closed', () => {});

const log = [];
const t0 = Date.now();
function note(kind, data = {}) {
  log.push({ t: Date.now() - t0, kind, ...data });
  process.stderr.write(`[probe] ${kind} ${JSON.stringify(data).slice(0, 200)}\n`);
}
function finish(extra = {}) {
  process.stdout.write(JSON.stringify({ ...extra, log }) + '\n');
  app.exit(0);
}
/** Сторож: скрипт зовёт его первой строкой после require — через ms мс печатает журнал и закрывает Electron. */
function watchdog(ms = 20000) {
  setTimeout(() => { note('watchdog'); finish({ watchdog: true }); }, ms);
}

function serve(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const route = routes[(req.url ?? '/').split('?')[0]];
      if (!route) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope'); return; }
      route(req, res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, origin: `http://127.0.0.1:${srv.address().port}` }));
  });
}
const html = (body) => (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); };
const json = (status, body) => (_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); };

async function hostWindow({ width = 1000, height = 760, show = true } = {}) {
  const win = new BrowserWindow({ width, height, show, webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true } });
  await win.loadURL('data:text/html,<body style="margin:0;background:%23888"></body>');
  return win;
}

/**
 * <webview> с атрибутами Parley. onGuest зовётся синхронно в web-contents-created гостя —
 * там же, где Parley ставит свой страж (main/browser/guard.ts).
 */
function mountWebview(win, { src, id = 'w1', wrapperStyle = 'position:absolute;left:0;top:0;width:800px;height:600px', onGuest = () => {} }) {
  return new Promise((resolve) => {
    const onCreated = (_e, contents) => {
      if (contents.getType() !== 'webview') return;
      app.off('web-contents-created', onCreated);
      onGuest(contents);
      resolve(contents);
    };
    app.on('web-contents-created', onCreated);
    const code = `(() => {
      const wrap = document.createElement('div'); wrap.id = ${JSON.stringify(id + '-wrap')};
      wrap.setAttribute('style', ${JSON.stringify(wrapperStyle)});
      const w = document.createElement('webview'); w.id = ${JSON.stringify(id)};
      w.setAttribute('partition', 'persist:stage0');
      w.setAttribute('webpreferences', 'contextIsolation=yes, sandbox=yes');
      w.setAttribute('allowpopups', 'true');
      w.setAttribute('style', 'display:flex;width:100%;height:100%;background:white');
      w.src = ${JSON.stringify(src)};
      wrap.appendChild(w); document.body.appendChild(wrap);
    })()`;
    win.webContents.executeJavaScript(code);
  });
}
const waitEvent = (emitter, event, ms = 10000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout ${event}`)), ms);
  emitter.once(event, (...args) => { clearTimeout(timer); resolve(args); });
});
const withTimeout = (promise, ms, label) => Promise.race([
  promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${label}`)), ms)),
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pngSize(buffer) { const img = nativeImage.createFromBuffer(buffer); return img.getSize(); }
/** Цвет пикселя PNG (RGBA) в точке x,y — для проверки, что метка или элемент попали в снимок. */
function pixel(buffer, x, y) {
  const img = nativeImage.createFromBuffer(buffer);
  const { width } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const i = (y * width + x) * 4;
  return { r: bmp[i + 2], g: bmp[i + 1], b: bmp[i], a: bmp[i + 3] };
}
module.exports = { app, note, finish, watchdog, serve, html, json, hostWindow, mountWebview, waitEvent, withTimeout, sleep, pngSize, pixel };
```

- [ ] **Шаг 3. Проверить стенд.**

```js
// $S/smoke.cjs
const { app, note, finish, watchdog, serve, html, hostWindow, mountWebview, waitEvent } = require('./harness.cjs');
watchdog(20000);
app.whenReady().then(async () => {
  const { origin } = await serve({ '/': html('<h1 id="h">ok</h1>') });
  const win = await hostWindow();
  const guest = await mountWebview(win, { src: origin + '/' });
  await waitEvent(guest, 'did-finish-load');
  note('loaded', { url: guest.getURL(), type: guest.getType() });
  finish({ ok: true });
});
```

```bash
cd "$S" && env -u ELECTRON_RUN_AS_NODE "$E" smoke.cjs --user-data-dir="$S/ud-smoke" 2>/dev/null | tail -1
```

Ожидание: строка JSON с `"ok":true` и записью `loaded`, где `type` — `webview`. Если стенд не работает — разобраться до спайков: остальные скрипты на нём стоят.

---

## Задача 2. Спайк 0.1 — когда подключать CDP к гостю

**Вопрос:** в какой момент `debugger.attach` и `enable` ловят документ первой загрузки и ранние сообщения консоли и не зависают (проба 2026-10-07: без страницы `Runtime.enable` висит).

**Файлы:** `$S/spike-01.cjs`.

- [ ] **Шаг 1. Записать скрипт.** Варианты — по `VARIANT`:
  - `A` — подключение прямо в `web-contents-created`, `enable` без ожидания;
  - `B` — на первом `did-start-loading`;
  - `C` — на `dom-ready`, затем `reload()`.

```js
// $S/spike-01.cjs
const { app, note, finish, watchdog, serve, html, json, hostWindow, mountWebview, withTimeout, sleep } = require('./harness.cjs');
const VARIANT = process.env.VARIANT ?? 'A';
const RUNS = Number(process.env.RUNS ?? 10);
watchdog(RUNS * 6000 + 10000);

app.whenReady().then(async () => {
  const { origin } = await serve({
    '/': html(`<!doctype html><script>console.log('early-log')</script>
      <img src="/missing.png"><script>fetch('/api')</script><p>page</p>`),
    '/api': json(500, '{"error":"db down"}'),
  });
  const results = [];
  for (let run = 0; run < RUNS; run++) {
    const win = await hostWindow({ show: false });
    const seen = { doc: false, earlyLog: false, api: false, missing: false, enableMs: null, enableError: null };
    const started = Date.now();
    const attach = (contents) => {
      const dbg = contents.debugger;
      try { dbg.attach('1.3'); } catch (error) { seen.enableError = 'attach: ' + error.message; return; }
      dbg.on('message', (_e, method, params) => {
        if (method === 'Network.requestWillBeSent') {
          if (params.type === 'Document') seen.doc = true;
          if (params.request.url.endsWith('/api')) seen.api = true;
          if (params.request.url.endsWith('/missing.png')) seen.missing = true;
        }
        if (method === 'Runtime.consoleAPICalled' && params.args.some((a) => a.value === 'early-log')) seen.earlyLog = true;
      });
      const enables = ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable'].map((m) =>
        withTimeout(dbg.sendCommand(m), 10000, m));
      Promise.all(enables).then(
        () => { seen.enableMs = Date.now() - started; },
        (error) => { seen.enableError = error.message; },
      );
    };
    await mountWebview(win, {
      src: `${origin}/?run=${run}`,
      onGuest: (contents) => {
        if (VARIANT === 'A') attach(contents);
        if (VARIANT === 'B') contents.once('did-start-loading', () => attach(contents));
        if (VARIANT === 'C') contents.once('dom-ready', () => { attach(contents); contents.reload(); });
      },
    });
    await sleep(3000);
    results.push({ run, ...seen });
    win.destroy();
  }
  const ok = results.filter((r) => r.doc && r.earlyLog && r.api && r.enableError === null).length;
  note('summary', { variant: VARIANT, runs: RUNS, ok });
  finish({ variant: VARIANT, runs: RUNS, ok, results });
});
```

- [ ] **Шаг 2. Прогнать три варианта по 10 раз.**

```bash
cd "$S" && for v in A B C; do VARIANT=$v RUNS=10 env -u ELECTRON_RUN_AS_NODE "$E" spike-01.cjs --user-data-dir="$S/ud-01-$v" 2>/dev/null | tail -1 > "$S/out-01-$v.json"; node -e "const r=require('$S/out-01-$v.json');console.log(r.variant, r.ok + '/' + r.runs, r.results.map(x=>x.enableError).filter(Boolean)[0] ?? '')"; done
```

Ожидание: по строке на вариант — доля полных успехов и первая ошибка, если была.

- [ ] **Шаг 3. Решение — записать в отчёт.**
  - **A даёт 10 из 10** — умолчание индекса стоит. `capture: 'late'` ставится только при пропущенном документе — как страховка.
  - **A хуже, а B даёт 10 из 10** — в плане A инспектор подключается на первом `did-start-loading`, `late` — страховка.
  - **Иначе** — вариант C: в плане A подключение на `dom-ready`, без автоматического `reload()`. Вкладка получает `capture: 'late'` и подсказку «Reload to capture earlier requests».
  - Записать в отчёт время `enableMs` (медиана) и все ошибки.
  - Поле `missing` (картинка 404) — справочное, в решение не входит. Раздел `persist:stage0` общий у прогонов, и кэш может скрыть повторный запрос. Проверочный запуск 2026-10-07: `missing` чаще `false` во всех вариантах, а A в одном прогоне из трёх пропустил `/api`.

---

## Задача 3. Спайк 0.2 — скрытая вкладка и память

**Вопрос:**
- что работает у гостя, чей контейнер `visibility: hidden`: CDP-клик, дерево доступности, `capturePage()`, `Page.captureScreenshot` (с `fromSurface: false` и без);
- есть ли разница между «скрыт с самого начала» и «скрыт после показа»;
- помогают ли `setBackgroundThrottling(false)` или «невидимый, но рисуемый» контейнер (`opacity: 0`, увод за край);
- сколько памяти стоит держать смонтированным гостя ещё одной работы.

**Проверочный запуск 2026-10-07** (один прогон, первая версия скрипта) — что ищем:
- у `visibility: hidden` оба снимка зависли, а CDP-клик сработал (`isTrusted: true`);
- после первого зависшего снимка зависли и все следующие состояния в том же госте. Поэтому каждое состояние — свой свежий гость, а клик и дерево доступности идут раньше снимков;
- память гостя тестовой страницы — около 79 МБ.

Вторая версия скрипта (ниже), один прогон 2026-10-07:
- дерево доступности работает во всех состояниях;
- CDP-клик работает, если вкладка хоть раз была видимой. У `hidden-from-start` клики не доходят;
- снимки зависают у всех скрытых состояний, кроме `opacity0`. Там работают `capturePage` и CDP с `fromSurface: false`, а CDP по умолчанию висит;
- `noThrottle` не помогает; память гостя — около 105 МБ.

Пять прогонов либо подтверждают это, либо уточняют.

**Файлы:** `$S/spike-02.cjs`.

- [ ] **Шаг 1. Записать скрипт.**

```js
// $S/spike-02.cjs
const { app, note, finish, watchdog, serve, html, hostWindow, mountWebview, waitEvent, withTimeout, sleep, pngSize } = require('./harness.cjs');
watchdog(120000);

const PAGE = `<!doctype html><body style="margin:0">
  <button id="b" style="position:absolute;left:100px;top:100px;width:200px;height:80px;background:rgb(255,0,0)"
    onclick="window.clicks=(window.clicks||0)+1; window.trusted=event.isTrusted">B</button>
  <div id="heavy"></div>
  <script>
    const heavy = document.getElementById('heavy');
    for (let i = 0; i < 5000; i++) { const d = document.createElement('div'); d.textContent = 'row ' + i; heavy.appendChild(d); }
    window.blob = Array.from({ length: 200000 }, (_, i) => ({ i, s: 'x'.repeat(20) }));
  </script></body>`;
const BASE = 'position:absolute;left:0;top:0;width:800px;height:600px';
// Каждое состояние — свой свежий гость: зависший снимок держит очередь CDP и отравил бы следующие.
const STATES = [
  { label: 'visible', start: '', later: null },
  { label: 'hidden-from-start', start: 'visibility:hidden', later: null },
  { label: 'hidden-after-visible', start: '', later: 'visibility:hidden' },
  { label: 'hidden+noThrottle', start: '', later: 'visibility:hidden', noThrottle: true },
  { label: 'opacity0', start: '', later: 'opacity:0;pointer-events:none' },
  { label: 'offscreen', start: '', later: 'left:-5000px' },
];

async function tryAll(guest, label) {
  const dbg = guest.debugger;
  const out = { label };
  // Клик и дерево доступности — первыми: зависший снимок держит очередь команд CDP.
  try {
    await guest.executeJavaScript('window.clicks = 0');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await withTimeout(dbg.sendCommand('Input.dispatchMouseEvent', { type, x: 200, y: 140, button: 'left', clickCount: 1 }), 3000, type);
    }
    await sleep(100);
    out.click = await guest.executeJavaScript('({ clicks: window.clicks, trusted: window.trusted })');
  } catch (error) { out.click = error.message; }
  try {
    const ax = await withTimeout(dbg.sendCommand('Accessibility.getFullAXTree'), 3000, 'ax');
    out.axNodes = ax.nodes.length;
  } catch (error) { out.axNodes = error.message; }
  try {
    const img = await withTimeout(guest.capturePage(), 3000, 'capturePage');
    out.capturePage = img.isEmpty() ? 'empty' : img.getSize();
  } catch (error) { out.capturePage = error.message; }
  try {
    const shot = await withTimeout(dbg.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: false }), 3000, 'cdp-noSurface');
    out.cdpNoSurface = pngSize(Buffer.from(shot.data, 'base64'));
  } catch (error) { out.cdpNoSurface = error.message; }
  try {
    const shot = await withTimeout(dbg.sendCommand('Page.captureScreenshot', { format: 'png' }), 3000, 'cdp-shot');
    out.cdpShot = pngSize(Buffer.from(shot.data, 'base64'));
  } catch (error) { out.cdpShot = error.message; }
  note('try', out);
  return out;
}

app.whenReady().then(async () => {
  const { origin } = await serve({ '/': html(PAGE) });
  const results = [];
  let memoryKb = null;
  for (const state of STATES) {
    const win = await hostWindow({ show: true });
    const guest = await mountWebview(win, { src: origin + '/', wrapperStyle: BASE + ';' + state.start });
    await waitEvent(guest, 'did-finish-load');
    guest.debugger.attach('1.3');
    for (const m of ['Page.enable', 'Accessibility.enable']) await guest.debugger.sendCommand(m);
    if (state.noThrottle) guest.setBackgroundThrottling(false);
    if (state.later) await win.webContents.executeJavaScript(`document.getElementById('w1-wrap').style.cssText += ';${state.later}'`);
    await sleep(1500);
    results.push(await tryAll(guest, state.label));
    if (state.label === 'visible') {
      const metric = app.getAppMetrics().find((m) => m.pid === guest.getOSProcessId());
      memoryKb = metric?.memory?.workingSetSize ?? null;
    }
    win.destroy();
    await sleep(300);
  }
  note('memory', { memoryKb });
  finish({ results, memoryKb });
});
```

- [ ] **Шаг 2. Прогнать 5 раз.**

```bash
cd "$S" && for i in 1 2 3 4 5; do env -u ELECTRON_RUN_AS_NODE "$E" spike-02.cjs --user-data-dir="$S/ud-02-$i" 2>/dev/null | tail -1 > "$S/out-02-$i.json"; node -e "const r=require('$S/out-02-$i.json');for(const x of r.results)console.log(x.label.padEnd(22), 'click', JSON.stringify(x.click), 'ax', x.axNodes, 'capturePage', JSON.stringify(x.capturePage), 'noSurface', JSON.stringify(x.cdpNoSurface), 'cdp', JSON.stringify(x.cdpShot));console.log('memoryKb', r.memoryKb)"; done
```

Ожидание: по 6 строк на прогон и память гостя. У `visible` всё работает: клик `{"clicks":1,"trusted":true}`, `ax` — число узлов, три снимка 800×600 (или вдвое больше на Retina).

- [ ] **Шаг 3. Решение — записать в отчёт.** По каждой операции агента — работает ли она у скрытой вкладки:
  - **`snapshot` и `action`.** Если `click` и `ax` работают у `hidden-*`, на скрытых вкладках они разрешены: план D, задачи действий и `snapshot`, без `tab_hidden`.
  - **`screenshot`:**
    - какой-то снимок работает у `hidden-*` — он и берётся, планы B и C;
    - работает только с `noThrottle` — на время снимка `setBackgroundThrottling(false)`, потом `true`;
    - работает только у `opacity0` или `offscreen` — на время снимка окно переводит контейнер скрытой вкладки в этот вид по событию `browser:agent-activity` с `phase: 'start'` и возвращает на `end` (план C);
    - не работает ничего — у снимка скрытой вкладки остаётся `tab_hidden`.
  - **Память.** `memoryKb` этой страницы — нижняя граница. Если гость стоит до 200 МБ, в плане D работы, где агент пользовался браузером последние `AGENT_LIMITS.recentMinutes` минут, держатся смонтированными сверх LRU-3, не больше двух. Иначе — `tab_not_loaded`.

---

## Задача 4. Спайк 0.3 — эмуляция размеров и координаты

**Вопрос:**
- какой механизм даёт верные `innerWidth`, `devicePixelRatio`, медиазапросы, касания и UA при вписывании в меньший `<webview>` (`scale < 1`);
- попадает ли клик человека в нужный элемент вписанной страницы;
- переживает ли эмуляция перезагрузку.

**Проверочный запуск 2026-10-07** (один прогон, первая версия скрипта) — что ищем:
- `cdp`: до перезагрузки `w: 375`, `dpr: 2`, UA iPhone, но `touch: false`; после перезагрузки всё то же и `touch: true`. Значит, касания включаются только с новым документом. Снимок 750×1624, обрезка 120×120;
- `electron` (`enableDeviceEmulation`): после перезагрузки эмуляция пропала (`w: 277`, `dpr: 1`);
- клик «человека» событием окну-хозяину не попал ни у одного механизма. Нужен контрольный раунд без эмуляции и второй способ — событие самому гостю.

Вторая версия скрипта (ниже), один прогон: `hostHit` — 0 везде, событие окну до гостя не доходит. `guestHit` — 1 и в `control`, и в `emulated` у обоих механизмов: пересчёт вид → страница при `scale` верный.

**Файлы:** `$S/spike-03.cjs`.

- [ ] **Шаг 1. Записать скрипт.**

```js
// $S/spike-03.cjs
const { app, note, finish, watchdog, serve, html, hostWindow, mountWebview, waitEvent, sleep, pngSize } = require('./harness.cjs');
watchdog(45000);
const MECH = process.env.MECH ?? 'cdp'; // cdp | electron
const PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0">
  <button id="t" style="position:absolute;left:300px;top:300px;width:60px;height:60px"
    onclick="window.hit=(window.hit||0)+1">T</button>
  <script>window.metrics = () => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
    narrow: matchMedia('(max-width: 400px)').matches, touch: 'ontouchstart' in window, ua: navigator.userAgent.slice(0, 60) });</script></body>`;
const T = { x: 330, y: 330 }; // центр кнопки в CSS-пикселях страницы
const W = 375, H = 812, DPR = 2;
const AREA = { width: 800, height: 600 };
const scale = Math.min(1, AREA.width / W, AREA.height / H);
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

// Два способа «клика человека»: событие окну-хозяину в координатах окна и событие самому гостю в координатах
// его вида. Контрольный раунд без эмуляции показывает, какой способ вообще доходит до страницы.
async function clicks(win, guest, view, k, label) {
  const read = () => guest.executeJavaScript('window.hit || 0');
  const start = await read();
  const hx = view.left + Math.round(T.x * k), hy = view.top + Math.round(T.y * k);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: hx, y: hy, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: hx, y: hy, button: 'left', clickCount: 1 });
  await sleep(300);
  const afterHost = await read();
  const gx = Math.round(T.x * k), gy = Math.round(T.y * k);
  guest.sendInputEvent({ type: 'mouseDown', x: gx, y: gy, button: 'left', clickCount: 1 });
  guest.sendInputEvent({ type: 'mouseUp', x: gx, y: gy, button: 'left', clickCount: 1 });
  await sleep(300);
  const afterGuest = await read();
  return { label, hostHit: afterHost - start, guestHit: afterGuest - afterHost };
}

app.whenReady().then(async () => {
  const { origin } = await serve({ '/': html(PAGE) });
  const win = await hostWindow({ show: true });
  const guest = await mountWebview(win, { src: origin + '/', wrapperStyle: `position:absolute;left:0;top:0;width:${AREA.width}px;height:${AREA.height}px` });
  await waitEvent(guest, 'did-finish-load');
  const dbg = guest.debugger; dbg.attach('1.3'); await dbg.sendCommand('Page.enable');
  await sleep(300);
  const control = await clicks(win, guest, { left: 0, top: 0 }, 1, 'control');

  const ew = Math.round(W * scale), eh = Math.round(H * scale);
  const left = Math.round((AREA.width - ew) / 2), top = Math.round((AREA.height - eh) / 2);
  await win.webContents.executeJavaScript(`Object.assign(document.getElementById('w1-wrap').style, { left: '${left}px', top: '${top}px', width: '${ew}px', height: '${eh}px' })`);
  await sleep(300);
  if (MECH === 'cdp') {
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: true, scale });
    await dbg.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await dbg.sendCommand('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA });
  } else {
    guest.enableDeviceEmulation({ screenPosition: 'mobile', screenSize: { width: W, height: H }, viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: DPR, viewSize: { width: W, height: H }, scale });
  }
  await sleep(500);
  const before = await guest.executeJavaScript('window.metrics()');
  const emulated = await clicks(win, guest, { left, top }, scale, 'emulated');

  const full = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' });
  const crop = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', clip: { x: 300, y: 300, width: 60, height: 60, scale: 1 } });

  guest.reload(); await waitEvent(guest, 'did-finish-load'); await sleep(300);
  const afterReload = await guest.executeJavaScript('window.metrics()');
  const result = { MECH, scale, control, before, emulated, full: pngSize(Buffer.from(full.data, 'base64')), crop: pngSize(Buffer.from(crop.data, 'base64')), afterReload };
  note('result', result);
  finish(result);
});
```

- [ ] **Шаг 2. Прогнать оба механизма по 5 раз.**

```bash
cd "$S" && for m in cdp electron; do for i in 1 2 3 4 5; do MECH=$m env -u ELECTRON_RUN_AS_NODE "$E" spike-03.cjs --user-data-dir="$S/ud-03-$m-$i" 2>/dev/null | tail -1 > "$S/out-03-$m-$i.json"; node -e "const x=require('$S/out-03-$m-$i.json');console.log(x.MECH, 'control', JSON.stringify(x.control), 'emulated', JSON.stringify(x.emulated), JSON.stringify(x.before), 'full', JSON.stringify(x.full), 'crop', JSON.stringify(x.crop), 'reload', JSON.stringify(x.afterReload))"; done; done
```

Ожидание у годного механизма:
- `control`: хотя бы один способ с `1` — им и меряем `emulated`;
- `emulated`: у того же способа `1`;
- `before`: `w: 375`, `dpr: 2`, `narrow: true`; `touch` может быть `false` до перезагрузки;
- `crop` — 120×120 (60 × DPR); `full` — записать размер;
- `afterReload`: `w: 375`, `dpr: 2`, а у `cdp` ещё `touch: true`.

- [ ] **Шаг 3. Решение — записать в отчёт.**
  - **`cdp` прошёл всё** — умолчание индекса стоит. Записать в план A, задачу эмуляции:
    - касания включаются только с новым документом: после включения мобильного пресета окно предлагает перезагрузить страницу или делает `reload()` само — выбор записать;
    - размер `full` — его учитывает `browser_screenshot` в плане C;
    - если эмуляция пропадает после `reload`, `Emulation.set` повторяет команды на `Page.frameNavigated` главного фрейма.
  - **`cdp` не прошёл, а `electron` прошёл** — в плане A `viewportCommands` заменяется вызовом `contents.enableDeviceEmulation(...)`, который повторяется после каждой загрузки (проверочный запуск: сам он не переживает `reload`).
  - **В `control` попал способ, а в `emulated` тот же способ промахнулся** у обоих механизмов — в плане A `<webview>` не уменьшается. Страница эмулируется в размере элемента без `scale`, а вписывание остаётся подписью с прокруткой. Это сужение функции записать в отчёт и предложить человеку.
  - **В `control` не попал ни один способ** — проверка клика человека этим стендом невозможна. Записать и проверить руками в dev-окне этапа A: включить Mobile M во вкладке, кликнуть кнопку мышью.

---

## Задача 5. Спайк 0.4 — ввод через CDP

**Вопрос:** от точки по `DOM.getBoxModel` для `backendNodeId` из `Accessibility.getFullAXTree` через `Input.*` получаем:
- клик с `isTrusted`;
- ввод в управляемое поле React;
- Enter, Tab и стрелки.

И всё это верно при `setZoomLevel(2)` и при эмуляции с `scale < 1`.

**Файлы:** `$S/spike-04.cjs`.

- [ ] **Шаг 1. Записать скрипт.** Страница — React 18 из UMD-файлов `node_modules`. Сервер отдаёт их по путям `/react.js` и `/react-dom.js`.

```js
// $S/spike-04.cjs
const fs = require('node:fs');
const path = require('node:path');
const { app, note, finish, watchdog, serve, html, hostWindow, mountWebview, waitEvent, sleep } = require('./harness.cjs');
watchdog(60000);
const WT = process.env.WT;
const umd = (rel) => (_req, res) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(fs.readFileSync(path.join(WT, rel))); };
const REACT = 'node_modules/.pnpm/react@18.3.1/node_modules/react/umd/react.development.js';
const REACT_DOM = 'node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/umd/react-dom.development.js';
const PAGE = `<!doctype html><body style="margin:0"><div id="root"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script><script>
  const h = React.createElement;
  function App() {
    const [text, setText] = React.useState('');
    const [clicks, setClicks] = React.useState(0);
    const [submitted, setSubmitted] = React.useState(0);
    window.state = { text, clicks, submitted };
    return h('form', { onSubmit: (e) => { e.preventDefault(); setSubmitted((n) => n + 1); }, style: { padding: '40px' } },
      h('input', { 'aria-label': 'Name', value: text, onChange: (e) => setText(e.target.value) }),
      h('button', { type: 'button', onClick: (e) => { window.lastTrusted = e.isTrusted; setClicks((n) => n + 1); }, style: { marginLeft: '600px', marginTop: '500px' } }, 'Save'),
      h('select', { 'aria-label': 'Size', defaultValue: 'a' }, h('option', { value: 'a' }, 'A'), h('option', { value: 'b' }, 'B')));
  }
  ReactDOM.createRoot(document.getElementById('root')).render(h(App));
</script></body>`;

async function axNode(dbg, role, name) {
  const { nodes } = await dbg.sendCommand('Accessibility.getFullAXTree');
  const node = nodes.find((n) => n.role?.value === role && n.name?.value === name);
  return node?.backendDOMNodeId ?? null;
}
async function center(dbg, backendNodeId) {
  await dbg.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId });
  const { model } = await dbg.sendCommand('DOM.getBoxModel', { backendNodeId });
  const q = model.content; // [x1,y1,x2,y2,x3,y3,x4,y4] в CSS-пикселях вьюпорта
  return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 };
}
async function click(dbg, p) {
  for (const type of ['mousePressed', 'mouseReleased']) await dbg.sendCommand('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
}
async function key(dbg, k, code, vk, text) {
  await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
  await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
}

async function round(guest, dbg, label) {
  const save = await axNode(dbg, 'button', 'Save');
  const input = await axNode(dbg, 'textbox', 'Name');
  const select = await axNode(dbg, 'combobox', 'Size');
  await click(dbg, await center(dbg, save)); await sleep(100);
  await dbg.sendCommand('DOM.focus', { backendNodeId: input });
  await dbg.sendCommand('Input.insertText', { text: 'hello' }); await sleep(100);
  await key(dbg, 'Enter', 'Enter', 13, '\r'); await sleep(100);
  await dbg.sendCommand('DOM.focus', { backendNodeId: select });
  await key(dbg, 'ArrowDown', 'ArrowDown', 40); await sleep(100);
  const afterArrow = await guest.executeJavaScript('document.querySelector("select").value');
  await key(dbg, 'Escape', 'Escape', 27); // на macOS стрелка открывает меню списка — закрыть его
  await dbg.sendCommand('DOM.focus', { backendNodeId: select });
  await key(dbg, 'b', 'KeyB', 66, 'b'); await sleep(100); // поиск по первой букве
  const state = await guest.executeJavaScript('({ ...window.state, trusted: window.lastTrusted, select: document.querySelector("select").value })');
  state.afterArrow = afterArrow;
  note('round', { label, state });
  await guest.reload(); await waitEvent(guest, 'did-finish-load'); await sleep(300);
  return { label, state };
}

app.whenReady().then(async () => {
  const { origin } = await serve({ '/': html(PAGE), '/react.js': umd(REACT), '/react-dom.js': umd(REACT_DOM) });
  const win = await hostWindow({ show: true });
  const guest = await mountWebview(win, { src: origin + '/' });
  await waitEvent(guest, 'did-finish-load'); await sleep(300);
  const dbg = guest.debugger; dbg.attach('1.3');
  for (const m of ['DOM.enable', 'Accessibility.enable', 'Page.enable']) await dbg.sendCommand(m);
  const out = [];
  out.push(await round(guest, dbg, 'zoom0'));
  guest.setZoomLevel(2); await sleep(300);
  out.push(await round(guest, dbg, 'zoom2'));
  guest.setZoomLevel(0);
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, scale: 0.6 });
  await sleep(300);
  out.push(await round(guest, dbg, 'emul-scale0.6'));
  finish({ out });
});
```

> Пути к UMD — по раскладке pnpm. Если версия React в `node_modules` другая, взять фактические каталоги (`ls node_modules/.pnpm | grep -E '^react(-dom)?@18'`).

- [ ] **Шаг 2. Прогнать 5 раз.**

```bash
cd "$S" && for i in 1 2 3 4 5; do WT="$WT" env -u ELECTRON_RUN_AS_NODE "$E" spike-04.cjs --user-data-dir="$S/ud-04-$i" 2>/dev/null | tail -1 > "$S/out-04-$i.json"; node -e "const r=require('$S/out-04-$i.json');for(const x of r.out)console.log(x.label, JSON.stringify(x.state))"; done
```

Ожидание в каждом раунде: `{"text":"hello","clicks":1,"submitted":1,"trusted":true,"select":"b"}`; `afterArrow` — записать, сменила ли значение стрелка.

Проверочный запуск 2026-10-07, первая версия, один прогон:
- `zoom0` и `zoom2` — `text`, `clicks`, `submitted` и `trusted` верны, а стрелка в `<select>` значение не сменила;
- `emul-scale0.6` — ввод и Enter верны, клик промахнулся (`clicks: 0`). Пересчёт координат под `scale` эмуляции нужен — найти множитель.

Вторая версия (выше), один прогон: поиск по первой букве (`b`) меняет значение `<select>`, стрелка — нет (`afterArrow: "a"`). Клик при `scale` 0,6 по-прежнему мимо.

- [ ] **Шаг 3. Решение — записать в отчёт.**
  - **Все раунды верны** — умолчание индекса стоит: CSS-пиксели вьюпорта, без поправок.
  - **`zoom2` или `emul-scale0.6` промахнулся** — записать, на сколько: по журналу `round` и `getBoxModel`. План D, задача действий, умножает точку на найденный множитель: `getZoomFactor()` или `scale` эмуляции.
  - **`text` пуст после `insertText`** в управляемом поле — план D для `type` использует посимвольный `Input.dispatchKeyEvent` с `text`. Записать это.
  - **`select` не сменился** — в скилле (план D) рецепт для `<select>`: фокус и `press ArrowDown`/`Enter` не работают, нужна другая последовательность. Записать найденную.

---

## Задача 6. Спайк 0.6 — компонент React и источник

**Вопрос:** что отдаёт фиксированная функция `REACT_INFO_FN` через `DOM.getNodeForLocation` → `DOM.resolveNode` → `Runtime.callFunctionOn` для React 18 (`_debugSource`) и React 19 (`_debugStack`). Как разбирать источник у React 19.

**Файлы:** `$S/spike-06.cjs`, `$S/r19/` (временные пакеты React 19 и сборка).

- [ ] **Шаг 1. Подготовить React 19 во временной папке.** Сеть — только npm registry, в проект ничего не ставится.

```bash
mkdir -p "$S/r19" && cd "$S/r19"
npm init -y >/dev/null && npm install --no-audit --no-fund react@19 react-dom@19 >/dev/null   # scheduler подтянется сам
cat > app.jsx <<'EOF'
import { createRoot } from 'react-dom/client';
function SaveButton() { return <button id="save" style={{ margin: 80, width: 120, height: 40 }}>Save</button>; }
function SettingsForm() { return <form><SaveButton /></form>; }
function SettingsPage() { return <main><SettingsForm /></main>; }
createRoot(document.getElementById('root')).render(<SettingsPage />);
EOF
ESB=$(ls -d "$WT"/node_modules/.pnpm/esbuild@0.2*/node_modules/esbuild/bin/esbuild | tail -1)
"$ESB" app.jsx --bundle --format=iife --jsx=automatic --jsx-dev --define:process.env.NODE_ENV='"development"' --outfile=app19.js
ls -la app19.js
```

Ожидание: `app19.js` собран (несколько сотен КБ). Если `npm install` недоступен (нет сети), записать в отчёт «React 19 не проверен». Тогда решение по 0.6 — «у React 19 только имена» (столбец «Иначе» индекса).

- [ ] **Шаг 2. Записать скрипт.** React 18: `__source` передаётся руками — так делает dev-трансформация JSX. React 19: собранный `app19.js`.

```js
// $S/spike-06.cjs
const fs = require('node:fs');
const path = require('node:path');
const { app, note, finish, watchdog, serve, html, hostWindow, mountWebview, waitEvent, sleep } = require('./harness.cjs');
watchdog(40000);
const WT = process.env.WT, S = process.env.S;
const file = (abs) => (_req, res) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(fs.readFileSync(abs)); };
const REACT = path.join(WT, 'node_modules/.pnpm/react@18.3.1/node_modules/react/umd/react.development.js');
const REACT_DOM = path.join(WT, 'node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/umd/react-dom.development.js');
const PAGE18 = `<!doctype html><body style="margin:0"><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
  const h = React.createElement;
  function SaveButton() { return h('button', { id: 'save', style: { margin: 80, width: 120, height: 40 }, __source: { fileName: 'src/components/SaveButton.tsx', lineNumber: 12 } }, 'Save'); }
  function SettingsForm() { return h('form', { __source: { fileName: 'src/SettingsForm.tsx', lineNumber: 5 } }, h(SaveButton, { __source: { fileName: 'src/SettingsForm.tsx', lineNumber: 6 } })); }
  function SettingsPage() { return h('main', null, h(SettingsForm, { __source: { fileName: 'src/SettingsPage.tsx', lineNumber: 3 } })); }
  ReactDOM.createRoot(document.getElementById('root')).render(h(SettingsPage));
</script></body>`;
const PAGE19 = `<!doctype html><body style="margin:0"><div id="root"></div><script src="/app19.js"></script></body>`;

// Черновик REACT_INFO_FN (спека 3.8): берётся в план B, если спайк его подтвердил.
const REACT_INFO_FN = `function () {
  const out = { components: [] };
  try {
    const key = Object.keys(this).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return null;
    let fiber = this[key];
    // Источник самого элемента: JSX, который нарисовал этот DOM-узел, — точнее всего для агента.
    const hostSource = fiber._debugSource;
    if (hostSource && typeof hostSource.fileName === 'string') out.element = { file: hostSource.fileName, line: hostSource.lineNumber ?? null, approx: false };
    else if (fiber._debugStack && typeof fiber._debugStack.stack === 'string') out.element = { stack: fiber._debugStack.stack.split('\\n').slice(0, 6), approx: true };
    while (fiber && out.components.length < 3) {
      const type = fiber.type;
      if (typeof type === 'function' && (type.displayName || type.name)) {
        let source = null;
        const ds = fiber._debugSource;
        if (ds && typeof ds.fileName === 'string') source = { file: ds.fileName, line: ds.lineNumber ?? null, approx: false };
        else if (fiber._debugStack && typeof fiber._debugStack.stack === 'string') source = { stack: fiber._debugStack.stack.split('\\n').slice(0, 6), approx: true };
        out.components.push({ name: String(type.displayName || type.name).slice(0, 100), source });
      }
      fiber = fiber.return;
    }
  } catch (error) { return { error: String(error).slice(0, 200) }; }
  return out;
}`;

async function probe(guest, label) {
  const dbg = guest.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  await dbg.sendCommand('DOM.enable'); await dbg.sendCommand('Accessibility.enable');
  await dbg.sendCommand('DOM.getDocument', { depth: 0 });
  const { backendNodeId } = await dbg.sendCommand('DOM.getNodeForLocation', { x: 140, y: 100, includeUserAgentShadowDOM: false });
  const described = await dbg.sendCommand('DOM.describeNode', { backendNodeId });
  const ax = await dbg.sendCommand('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false });
  const { object } = await dbg.sendCommand('DOM.resolveNode', { backendNodeId });
  const { result } = await dbg.sendCommand('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: REACT_INFO_FN, returnByValue: true });
  await dbg.sendCommand('Runtime.releaseObject', { objectId: object.objectId });
  const role = ax.nodes[0]?.role?.value, name = ax.nodes[0]?.name?.value;
  note('probe', { label, tag: described.node.nodeName, role, name, react: result.value });
  return { label, tag: described.node.nodeName, role, name, react: result.value };
}

app.whenReady().then(async () => {
  const routes = { '/18': html(PAGE18), '/19': html(PAGE19), '/react.js': file(REACT), '/react-dom.js': file(REACT_DOM) };
  if (fs.existsSync(path.join(S, 'r19/app19.js'))) routes['/app19.js'] = file(path.join(S, 'r19/app19.js'));
  const { origin } = await serve(routes);
  const win = await hostWindow({ show: true });
  const out = [];
  for (const v of ['18', '19']) {
    if (v === '19' && !routes['/app19.js']) { out.push({ label: '19', skipped: true }); continue; }
    const guest = await mountWebview(win, { src: `${origin}/${v}`, id: 'w' + v });
    await waitEvent(guest, 'did-finish-load'); await sleep(500);
    out.push(await probe(guest, v));
  }
  finish({ out });
});
```

- [ ] **Шаг 3. Прогнать 5 раз и записать вывод.**

```bash
cd "$S" && for i in 1 2 3 4 5; do WT="$WT" S="$S" env -u ELECTRON_RUN_AS_NODE "$E" spike-06.cjs --user-data-dir="$S/ud-06-$i" 2>/dev/null | tail -1 > "$S/out-06-$i.json"; done; node -e "const r=require('$S/out-06-1.json');console.log(JSON.stringify(r.out,null,1))"
```

Ожидание:
- для 18: `tag: "BUTTON"`, `role: "button"`, `name: "Save"`, компоненты `SaveButton`, `SettingsForm`, `SettingsPage` с `file`/`line` из `__source`;
- для 19: те же имена и `stack` — первые 6 строк;
- `element` — источник самой кнопки: для 18 — `src/components/SaveButton.tsx:12`.

Проверочный запуск 2026-10-07, первая версия, один прогон, React 18:
- роль, имя и цепочка `SaveButton < SettingsForm < SettingsPage` верны;
- `_debugSource` компонента — место, где его *использовали* в родителе (у `SaveButton` — `src/SettingsForm.tsx:6`). Поэтому функция теперь берёт ещё и `element` — источник самого DOM-элемента.

- [ ] **Шаг 4. Решение — записать в отчёт.**
  - **18 верен** — `_debugSource` стоит. В план B и файл-контекст: строка `Source:` — из `element` (где написан сам элемент); у компонентов цепочки `файл:строка` — место использования, и шаблон подписывает это как `used at`.
  - **19:** по строкам `stack` найти правило — первая строка с путём, который не из `react`/`react-dom`. Записать его готовым кодом разбора: план B берёт его в `REACT_INFO_FN` с пометкой `approx.`. Правила нет — у React 19 только имена (столбец «Иначе» индекса).
  - **`getNodeForLocation`** вернул не кнопку (обёртку, текстовый узел) — записать. План B сверяет узел по тегу и классам и поднимается к элементу, если пришёл текстовый узел.

---

## Задача 7. Спайк 0.7 — снимок всей страницы и обрезка элемента

**Вопрос:** даёт ли `Page.captureScreenshot({ captureBeyondViewport: true, clip })` в `<webview>`:
- снимок всей длинной страницы с меткой изолированного мира и без двойного фиксированного заголовка;
- обрезку элемента ниже видимой части без прокрутки.

И то же при `setZoomLevel(2)` и при эмуляции.

**Файлы:** `$S/spike-07.cjs`.

- [ ] **Шаг 1. Записать скрипт.**

```js
// $S/spike-07.cjs
const { app, note, finish, watchdog, serve, html, hostWindow, mountWebview, waitEvent, sleep, pngSize, pixel } = require('./harness.cjs');
watchdog(40000);
const PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0;height:3000px;background:white">
  <header style="position:fixed;top:0;left:0;right:0;height:60px;background:rgb(0,0,255)"></header>
  <div id="target" style="position:absolute;left:100px;top:2500px;width:200px;height:100px;background:rgb(0,200,0)"></div></body>`;
const PIN = `(() => { const p = document.createElement('div');
  p.style.cssText = 'position:absolute;left:90px;top:2490px;width:20px;height:20px;border-radius:50%;background:rgb(255,0,255);z-index:2147483647;pointer-events:none';
  document.documentElement.appendChild(p); return true; })()`;

async function shots(guest, label) {
  const dbg = guest.debugger;
  const metrics = await dbg.sendCommand('Page.getLayoutMetrics');
  const { width, height } = metrics.cssContentSize;
  const full = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
  const fullBuf = Buffer.from(full.data, 'base64');
  const size = pngSize(fullBuf);
  const k = size.height / height; // пикселей PNG на CSS-пиксель
  const pinColor = pixel(fullBuf, Math.round(100 * k), Math.round(2500 * k));
  const headerTwice = pixel(fullBuf, Math.round(10 * k), Math.round(1500 * k)); // посреди страницы заголовка быть не должно
  const crop = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 100, y: 2500, width: 200, height: 100, scale: 1 } });
  const cropBuf = Buffer.from(crop.data, 'base64');
  const out = { label, css: { width, height }, png: size, pinColor, headerTwice, crop: pngSize(cropBuf), cropColor: pixel(cropBuf, 10, 10) };
  note('shots', out);
  return out;
}

app.whenReady().then(async () => {
  const { origin } = await serve({ '/': html(PAGE) });
  const win = await hostWindow({ show: true });
  const guest = await mountWebview(win, { src: origin + '/' });
  await waitEvent(guest, 'did-finish-load');
  guest.debugger.attach('1.3'); await guest.debugger.sendCommand('Page.enable');
  const pinOk = await guest.executeJavaScriptInIsolatedWorld(1001, [{ code: PIN }]);
  note('pin', { pinOk });
  const out = [];
  out.push(await shots(guest, 'plain'));
  guest.setZoomLevel(2); await sleep(300);
  out.push(await shots(guest, 'zoom2'));
  guest.setZoomLevel(0);
  await guest.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true, scale: 0.7 });
  await sleep(300);
  out.push(await shots(guest, 'emulated'));
  finish({ out });
});
```

- [ ] **Шаг 2. Прогнать 5 раз.**

```bash
cd "$S" && for i in 1 2 3 4 5; do env -u ELECTRON_RUN_AS_NODE "$E" spike-07.cjs --user-data-dir="$S/ud-07-$i" 2>/dev/null | tail -1 > "$S/out-07-$i.json"; node -e "const r=require('$S/out-07-$i.json');for(const x of r.out)console.log(x.label, JSON.stringify(x.png), 'pin', JSON.stringify(x.pinColor), 'mid', JSON.stringify(x.headerTwice), 'crop', JSON.stringify(x.crop), JSON.stringify(x.cropColor))"; done
```

Ожидание в каждом раунде:
- `pin` — пурпурный (`r≈255, g≈0, b≈255`);
- `mid` — белый: заголовок не повторился посреди снимка;
- `crop` — зелёный, размер 200×100 × DPR.

Проверочный запуск 2026-10-07, первая версия без `meta viewport`, один прогон, главный экран DPR 1:
- `plain` — снимок 800×3000, `crop` зелёный, но пиксель метки белый: метка не попала или стоит не там. Проверить `pinOk` и положение;
- `zoom2` — снимок 555×3000 (CSS-пиксели), `crop` белый: при масштабе `clip` промахнулся;
- `emulated` — без `meta viewport` страница шириной 980, а посреди снимка синий — фиксированный заголовок размножился.

Вторая версия (с `meta viewport` и проверкой метки), один прогон:
- `pinOk: true`. Метка видна в обрезке при эмуляции (пурпурный), но в снимке всей страницы её пиксель белый во всех раундах — разобраться, почему;
- `emulated` — 750×6000, заголовок посреди снимка всё так же размножен.

Решения здесь важнее, чем у других спайков: от них зависят снимки элемента (план B) и `fullPage` (план C).

- [ ] **Шаг 3. Решение — записать в отчёт.**
  - **Всё верно** — умолчание индекса стоит: элементы и аннотации снимаются этим вызовом.
  - **Метка не попала, фиксированный заголовок повторился или `crop` пуст** вне видимой части — план B делает так:
    - прокручивает элемент в видимую часть (`DOM.scrollIntoViewIfNeeded`);
    - снимает видимую часть через `capturePage` с пересчётом на `getZoomFactor()` и `scale`;
    - снимок аннотаций — только видимой части (столбец «Иначе» индекса).
  - Записать соотношение пикселей PNG к CSS-пикселям в каждом раунде. От него зависят пределы снимка агента в плане C: длинная сторона до 1568 px и `fullPage` не длиннее трёх вьюпортов.

---

## Задача 8. Спайк 0.5 — картинка из MCP у Claude Code и Codex

**Вопрос:**
- видит ли модель картинку из блока `image` в ответе MCP-инструмента в `claude` (2.1.286+) и в `codex`;
- если Codex не видит — открывает ли она файл по пути через `view_image`.

**Файлы:** `$S/mcp/server.mjs`, `$S/mcp/claude.json`, `$S/mcp/red.png`.

- [ ] **Шаг 1. Спросить человека.** «Спайк 0.5 запускает `claude -p` и `codex exec` по одному разу: это тратит немного лимита подписки. Запускать?» Без «да» — сразу шаг 5.

- [ ] **Шаг 2. Записать сервер.**

```js
// $S/mcp/server.mjs — один инструмент: красный квадрат 64×64 блоком image и путь текстом.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
const PNG = process.env.PROBE_PNG;
const server = new Server({ name: 'probe', version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'probe_image', description: 'Returns a probe image.', inputSchema: { type: 'object', properties: {} } }] }));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [
    { type: 'image', data: readFileSync(PNG).toString('base64'), mimeType: 'image/png' },
    { type: 'text', text: `Screenshot saved: ${PNG}` },
  ],
}));
await server.connect(new StdioServerTransport());
```

```bash
mkdir -p "$S/mcp" && cd "$S/mcp"
# красный квадрат 64×64 — через Electron nativeImage, чтобы не тянуть зависимости
cat > mkpng.cjs <<'EOF'
const { app, nativeImage } = require('electron'); const fs = require('node:fs');
app.whenReady().then(() => { const buf = Buffer.alloc(64 * 64 * 4); for (let i = 0; i < 64 * 64; i++) { buf[i*4] = 0; buf[i*4+1] = 0; buf[i*4+2] = 255; buf[i*4+3] = 255; }
  fs.writeFileSync(process.env.OUT, nativeImage.createFromBitmap(buf, { width: 64, height: 64 }).toPNG()); app.exit(0); });
EOF
OUT="$S/mcp/red.png" env -u ELECTRON_RUN_AS_NODE "$E" mkpng.cjs --user-data-dir="$S/ud-png" && ls -la red.png
ln -sfn "$WT/node_modules" "$S/mcp/node_modules"   # SDK из worktree
cat > claude.json <<EOF
{ "mcpServers": { "probe": { "command": "node", "args": ["$S/mcp/server.mjs"], "env": { "PROBE_PNG": "$S/mcp/red.png" } } } }
EOF
```

> `createFromBitmap` ждёт BGRA, поэтому байты `0,0,255` дают красный.

- [ ] **Шаг 3. Claude Code.**

```bash
cd "$S/mcp" && claude -p "Call the probe_image tool once and tell me, in one word, the color of the image it returns." --mcp-config claude.json --allowedTools mcp__probe__probe_image
```

Ожидание: ответ «Red» (или «red»). Ответ без цвета или «I can't see images» — Claude Code блок `image` не передал модели. Записать дословно.

- [ ] **Шаг 4. Codex.**

```bash
cd "$S/mcp" && codex exec -c "mcp_servers.probe={command=\"node\",args=[\"$S/mcp/server.mjs\"],env={PROBE_PNG=\"$S/mcp/red.png\"}}" "Call the probe_image tool once and tell me, in one word, the color of the image it returns. If you cannot see the image, open the file path from the tool's text output with your image viewing tool and answer."
```

Ожидание — одно из трёх, записать дословно:
- «Red» без `view_image` в журнале — блок `image` дошёл;
- «Red» после `view_image` — запасной путь работает;
- нет цвета — у Codex снимок только путём, человеку подсказка в скилле.

- [ ] **Шаг 5. Решение — записать в отчёт.**
  - **Claude видит** — умолчание стоит для Claude и GLM.
  - **Codex видит блок** — умолчание стоит для всех.
  - **Codex — только через `view_image`** — план C ничего не меняет (текст с путём уже есть), а скилл (план D) велит Codex открыть путь через `view_image`.
  - **Не проверено** (человек не разрешил) — умолчание остаётся, проверка уходит в живые проверки этапа D.

---

## Задача 9. Отчёт, индекс и коммит

**Файлы:**
- Создать: `docs/research/2026-10-08-browser-stage0.md`. Дата в имени — день прогона; если он другой, имя меняется, а план A ищет `docs/research/2026-10-*-browser-stage0.md`.
- Изменить: `docs/specs/2026-10-07-browser-devtools-agent-plan.md` — в таблицу «Умолчания до спайков» добавить столбец «Итог этапа 0».

- [ ] **Шаг 1. Записать отчёт** по образцу:

```markdown
# Браузер Parley, этап 0: итоги спайков

**Дата:** 2026-10-08. **Electron:** 44.4.5. **Машина:** macOS <версия>, <чип>, DPR главного экрана <1|2>.
**Скрипты:** scratchpad сессии, в репозиторий не входят; код — в плане `2026-10-07-browser-devtools-agent-plan-0-spikes.md`.

| Спайк | Результат (доля запусков) | Решение | Что меняется в планах |
|---|---|---|---|
| 0.1 Подключение CDP | A: 10/10 полных, enable медиана N мс | умолчание стоит | — |
| … | … | … | … |

## 0.1 Подключение CDP
<факты: вывод скриптов, медианы, ошибки дословно>
<решение и правило, по которому оно принято>
…
## Что сделать в планах A–D
- План A, задача <N>: <конкретно>.
- …
```

- [ ] **Шаг 2. Дописать столбец «Итог этапа 0»** в индексе. В каждой строке — «умолчание стоит» или выбранный вариант со ссылкой на раздел отчёта.

- [ ] **Шаг 3. Проверить, что в репозиторий попали только два файла.**

```bash
cd "$WT" && git status --short
```

Ожидание: `?? docs/research/2026-10-08-browser-stage0.md` и ` M docs/specs/2026-10-07-browser-devtools-agent-plan.md`, больше ничего.

- [ ] **Шаг 4. Коммит.**

```bash
git add docs/research/2026-10-08-browser-stage0.md docs/specs/2026-10-07-browser-devtools-agent-plan.md
git commit -m "docs(research): этап 0 браузера — спайки CDP, эмуляции и ввода

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Шаг 5. Сообщить человеку итог одной таблицей** (строки отчёта) и спросить про push ветки и PR. PR — во встроенном браузере (`gh` не установлен).
