# Остров — хвосты после помощника: план правок

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** закрыть семь хвостов острова, найденных при реализации и живых проверках помощника: битый E2E «×», неподтверждённый возврат ввода после закрытия вида, конфликт ⌥Space с Claude Desktop, неразличимая ошибка «движок голоса не найден», rAF-цикл роя без остановки и отсутствие замера CPU, потеря первого звукового сигнала, остров под вырезом при скрытой строке меню.

**Architecture:** правки точечные, в существующих модулях острова: `main/island/{window,placement}.ts`, `renderer/island/{IslandApp,IslandView}.tsx`, `renderer/island/assistant/{listen,store}.ts`, `renderer/island/swarm/Swarm.tsx`, настройки `shared/ui-types.ts` + `SettingsDialog.tsx`, E2E `e2e/island.spec.ts`. Новых зависимостей нет. Каждая задача независима и проверяется отдельно; порядок — от дешёвых и наверняка нужных к тем, что ждут живой проверки.

**Tech Stack:** Electron 44 (main: `screen`, `globalShortcut`, `app.getAppMetrics`), React 18, zustand, vitest + jsdom, Playwright `_electron`.

**Spec:** `docs/specs/2026-10-14-assistant-design.md` (разделы 8.1, 8.2, 9 «Бюджет», 12), `docs/specs/2026-10-12-island-plan.md` (остров одобрений), `TODOS.md` раздел 23, журнал `.superpowers/sdd/2026-10-15-assistant-plan-1/progress.md` (хвосты этапа 1, Rulings 19–22, 31). Разведка кода для этого плана — отчёт `recon-island` 2026-10-17 (номера строк ниже — из него, по состоянию master после PR #71).

## Global Constraints

- Тексты UI только по-английски и только в `packages/desktop/src/shared/strings.ts`; комментарии, тесты, документы — по-русски.
- Parley пишет только в свои каталоги; чужие файлы (конфиг Claude Desktop) — только чтение, сбой чтения молча.
- Никаких `secrets.json`, `ANTHROPIC_AUTH_TOKEN`, `--dangerously-*` в новом коде; `CLAUDECODE` не трогать.
- eslint репозитория: нет игнора `_x` для неиспользуемого, `prefer-const`, плагина react-hooks нет; страж `english-text` в core/protocol (здесь не задеты).
- Тесты: `LC_ALL=C` для прогона; E2E окна 800×500 с длинными именами работ; один процесс vitest за раз.
- Собранное приложение локально не запускать (TCC микрофона); dev-окно — `npx electron out/main/index.js` с `PARLEY_HOME=~/.parley-voice`.
- Коммит на задачу, сообщение по-русски, подпись `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Исполнители не запускают vitest/tsc/eslint/сборку и не коммитят — это делает контролёр после каждой задачи.

## Review Focus

1. Остров без хоста или с задержкой `island.config()` (invoke отклонён) — остров всё равно должен показать карточку и не зависнуть в ожидании конфига (Задача 1: тест «config отклонён — карточка есть, сигнала нет»).
2. Голос: IPC `voice:transcribe` бросает (хост перезапускается) — остров не должен застрять в `transcribing` (Задача 3: тест «transcribe бросает → notice voiceFailed, input idle»).
3. Рой при `fps=0` и `prefers-reduced-motion` одновременно — ни одного лишнего кадра, но первый кадр нарисован (Задача 4: тест «fps 0 + reduced motion → ровно один кадр»).
4. Внешний монитор без выреза при ручном отступе «Notch» — отступ применяется только к внутреннему экрану (Задача 6: тест `notchInset` с `internal: false` и ручным значением → 0).
5. Переход «мини-рой занят → свободен» при убранном острове — rAF остановлен, повторное `fps=30` снова запускает цикл (Задача 4: тест «fps 30 → 0 → 30»).

---

### Task 1: Первый звуковой сигнал не теряется до прихода настроек острова

**Files:**
- Modify: `packages/desktop/src/renderer/island/IslandApp.tsx` (INITIAL_CONFIG :71–77, загрузка конфига :154–155, эффект новых запросов :248–262)
- Test: `packages/desktop/src/renderer/island/IslandApp.test.tsx`

**Interfaces:**
- Consumes: `bridge.island.config(): Promise<IslandConfig>`, `bridge.island.onConfig(cb)`, `bridge.island.beep()`.
- Produces: внутреннее состояние `configReady: boolean`; внешних интерфейсов нет.

- [ ] **Step 1: Написать падающий тест**

```tsx
it('ждущий запрос пришёл раньше настроек острова — сигнал звучит, когда настройки пришли (sound: true)', async () => {
  let resolveConfig: (config: IslandConfig) => void = () => undefined;
  const bridge = fakeIslandBridge({ config: () => new Promise((resolve) => { resolveConfig = resolve; }) });
  render(<IslandApp bridge={bridge} />);
  bridge.pushWorks(worksWithPendingPermission('w-1', 's-01'));   // карточка ждёт до конфига
  await screen.findByTestId('island-card');
  expect(bridge.beeps).toBe(0);
  await act(async () => { resolveConfig({ ...DEFAULT_ISLAND_CONFIG, sound: true }); });
  await waitFor(() => expect(bridge.beeps).toBe(1));
});
it('config отклонён — карточка есть, остров не ждёт настроек, сигнала нет', async () => { /* reject → карточка видна, beeps 0 */ });
```

Имена фабрик — те, что уже есть в `IslandApp.test.tsx` (`setup`, фейковый мост с `pushWorks`); если `beeps` не считается — добавить счётчик в фейк рядом.

- [ ] **Step 2: Запустить тест, убедиться, что падает** — `pnpm --dir packages/desktop exec vitest run src/renderer/island/IslandApp.test.tsx -t "раньше настроек"`, ожидание: FAIL (beeps остаётся 0).

- [ ] **Step 3: Реализация** — в `IslandApp.tsx` добавить `const [configReady, setConfigReady] = useState(false)`; в загрузке конфига `bridge.island.config().then(apply).catch(() => undefined).finally(() => setConfigReady(true))` (push `onConfig` тоже ставит `configReady`); в эффекте новых запросов первой строкой `if (!configReady) return;` и `configReady` в зависимостях. Сигнал и `setRetracted(false)` остаются как есть. Комментарий: до конфига `sound` неизвестен, и ключи не считаются «увиденными».

- [ ] **Step 4: Прогнать весь файл** — `… vitest run src/renderer/island/IslandApp.test.tsx`, ожидание: PASS (если старые тесты ждут карточку без `await` над `config()`, обернуть их `await act`/`findBy*`).

- [ ] **Step 5: Коммит** — `fix(island): первый сигнал ждёт настроек острова, а не теряется`.

---

### Task 2: E2E «×» острова — тест без зависимости от курсора

**Files:**
- Modify: `packages/desktop/e2e/island.spec.ts:261–275`
- (Продукт не меняется.)

**Interfaces:**
- Consumes: канал `island:hover` (main → остров, `preload/island.ts:33`), `data-testid="island-tuck"` (IslandView.tsx:374–388), `data-retracted` на `[data-testid="island"]` (IslandView.tsx:346–347), помощник `islandVisible()` из спека (~:64).

- [ ] **Step 1: Переписать тест** — вместо кнопки «Hide until the next request» (в коде её нет с b93dbef9):

```ts
test('⌃ убирает остров в брусок; следующий запрос раскрывает его снова', async () => {
  await hold(app, 'PermissionRequest');                  // как в соседних тестах спека
  const island = await islandPage(app);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('island.html'));
    win?.webContents.send('island:hover', true);          // main шлёт hover по реальному курсору; в E2E курсора нет
  });
  await island.getByTestId('island-tuck').click();
  await expect(island.getByTestId('island')).toHaveAttribute('data-retracted', 'true');
  expect(await islandVisible(app)).toBe(true);           // окно не прячется (IslandApp.tsx:298)
  await hold(app, 'PermissionRequest', { session: 's-02' });
  await expect(island.getByTestId('island')).toHaveAttribute('data-retracted', 'false');
});
```

- [ ] **Step 2: Прогнать** — `pnpm --dir packages/desktop exec playwright test e2e/island.spec.ts -g "убирает остров"` трижды подряд, ожидание: 3/3 PASS независимо от положения мыши.

- [ ] **Step 3: Коммит** — `test(e2e): остров — ⌃ и повторный запрос без зависимости от курсора`.

Если Step 2 нестабилен (клик по стрелке не доходит), запасной путь — смахивание: `page.mouse.move/down/move(−12 px)/up` по `[data-testid="island"]` (`SWIPE_UP_PX=8`, `renderer/island/drag.ts:26`). Рубильник в main (`PARLEY_ISLAND=hover`) не заводим.

---

### Task 3: Остров различает «движок не найден» и «модель не скачана»

**Files:**
- Modify: `packages/desktop/src/renderer/island/assistant/listen.ts:39, 92–94`, `renderer/island/assistant/store.ts:85–93`, `shared/strings.ts` (блок `assistant`)
- Test: `renderer/island/assistant/listen.test.ts`, `renderer/island/assistant/store.test.ts`

**Interfaces:**
- Produces: `ListenResult = { text } | { error: 'mic' | 'no_speech' | 'engine' | 'model' | 'voice' | 'cancelled' }`.
- Строки: `S.assistant.voiceEngineMissing = 'Voice engine not found — Settings → Voice'`, `S.assistant.voiceModelMissing = 'Voice model is missing — Settings → Voice'` (по образцу `voiceOff`; остров не умеет открывать настройки окна, `FocusTarget` знает только session/mail/room).

- [ ] **Step 1: Падающие тесты** — `listen.test.ts`: `transcribe` отвечает `{ error: 'engine_missing' }` → `result.error === 'engine'`; `{ error: 'model_missing' }` → `'model'`; `{ error: 'failed' }` → `'voice'`; `transcribe` бросает → `'voice'` (сейчас обещание зависает — Review Focus 2). `store.test.ts`: результат `'engine'` → `notice === S.assistant.voiceEngineMissing`, `input === 'idle'`; `'model'` → `voiceModelMissing`.

- [ ] **Step 2: Запустить, убедиться, что падают.**

- [ ] **Step 3: Реализация** — в `listen.ts` обернуть `deps.transcribe(...)` в try/catch (исключение → `{ error: 'voice' }`), ошибки движка отобразить явно: `engine_missing → 'engine'`, `model_missing → 'model'`, `no_speech → 'no_speech'`, иначе `'voice'`. В `store.ts` две новые ветки notice. Строки — в `strings.ts`.

- [ ] **Step 4: Прогнать оба файла тестов** — PASS.

- [ ] **Step 5: Коммит** — `fix(island): голос помощника — отдельные подсказки про движок и модель, без зависания при сбое IPC`. Обновить Ruling 31 в журнале: решение отменено человеком («всё»).

---

### Task 4: Рой — остановка rAF при `fps=0` и замер CPU

**Files:**
- Modify: `packages/desktop/src/renderer/island/swarm/Swarm.tsx:65–75`
- Create: `packages/desktop/e2e/island-cpu.spec.ts` (замер, выполняется только с `PARLEY_CPU=1`)
- Modify: `docs/specs/2026-10-14-assistant-design.md:358` (порог по первому замеру), `TODOS.md` раздел 23 (снять пункт)
- Test: `renderer/island/swarm/Swarm.test.tsx`

**Interfaces:**
- Consumes: `SwarmEngine.needsFrame()`, проп `fps` у `<Swarm>`.
- Produces: цикл rAF живёт, только пока `fps > 0 || engine.needsFrame()`; при переходе в покой цикл снимается, при смене `fps`/спеки — взводится заново.

- [ ] **Step 1: Падающие тесты (`Swarm.test.tsx`, rAF подменён на ручной)** — «`fps=0`, переходов нет → после первого кадра `requestAnimationFrame` больше не зовётся»; «`fps` 30 → 0 → 30: цикл остановился и запустился снова»; «`fps=0` + reduced motion → ровно один кадр» (Review Focus 3, 5).

- [ ] **Step 2: Запустить, убедиться, что падают** (сейчас rAF перевзводится каждый кадр).

- [ ] **Step 3: Реализация** — в `Swarm.tsx` держать `rafRef`; функция `tick` после кадра планирует следующий только если `fpsRef.current > 0 || engine.needsFrame()`; эффекты на смену `fps` и спеки зовут `ensureLoop()` (взвести, если не взведён). Размонтирование снимает rAF (как сейчас :75).

- [ ] **Step 4: PASS по файлу.**

- [ ] **Step 5: Замер** — `e2e/island-cpu.spec.ts`: `test.skip(!process.env.PARLEY_CPU)`; стаб помощника `e2e/stub-assistant-agent.mjs` как в `assistant.spec.ts`; pid окна острова через `webContents.getOSProcessId()`; `app.getAppMetrics()` дважды с паузой 15 с в трёх состояниях: (а) пилюля свободна (`fps 0`), (б) пилюля занята (ход стаба, мини 30 fps), (в) вид открыт, облако (60 fps). В отчёт — `cpu.percentCPUUsage` и `cpu.idleWakeupsPerSecond` renderer-процесса острова. Запуск: `PARLEY_CPU=1 pnpm --dir packages/desktop exec playwright test e2e/island-cpu.spec.ts --reporter=line`.

- [ ] **Step 6: Зафиксировать порог** — числа замера на M1 вписать в спеку :358 («порог фиксируется в плане этапа 2 по первому замеру») как порог приёмки: свободная пилюля ≤ 1 %, занятая ≤ 8 %, открытое облако ≤ 20 % — это ориентир контролёра; если замер выше, уменьшить `souls` большого вида (700 → 500) и повторить, решение записать в журнал.

- [ ] **Step 7: Коммит** — `perf(island): рой не будит процесс при fps 0; замер CPU острова`.

---

### Task 5: Возврат ввода после закрытия вида помощника — живая проверка и запасной ход

**Files:**
- Modify (только если проверка провалена): `packages/desktop/src/main/island/window.ts:261–278` (`setKeyboard(false)`)
- Test: `main/island/window.test.ts:256–295`

**Interfaces:**
- Consumes: `hide()` + `showInactive()` в `setKeyboard(false)`; выходы из режима — Esc, ⌃, смахивание, blur (все через `hideAssistant()`, IslandApp.tsx:97–103).

- [ ] **Step 1: Живая проверка (человек, dev-окно `~/.parley-voice`)** — открыть TextEdit, поставить курсор в документ; ⌥Space, напечатать что-нибудь помощнику, Esc; сразу печатать — буквы должны идти в TextEdit. Повторить с ⌃ (убрать) и с кликом мимо острова во время хода. Три прохода. Результат записать в журнал плана.

- [ ] **Step 2 (только при провале): тест и правка** — тест в `window.test.ts`: «`setKeyboard(false)`: `showInactive` зовётся после `hide` на следующем тике» (fake timers); правка: `setTimeout(() => this.win.showInactive(), 0)` с комментарием про пробу 2026-10-15 (спайк делал паузу 2,5 с; мгновенный вариант не подтверждён). Если и так ввод не возвращается — показ по следующему `island:visible`.

- [ ] **Step 3: Коммит** (при правке) — `fix(island): showInactive после hide — следующим тиком, ввод возвращается прежнему приложению`.

---

### Task 6: Остров под вырезом при скрытой строке меню — запомненный отступ и ручной выбор

**Files:**
- Modify: `packages/desktop/src/shared/ui-types.ts:36–40, 114, 259–267` (`IslandUi.topInset`), `main/island/placement.ts:37–42` (`notchInset`), `main/island/window.ts:302` (`topInset()`), `main/index.ts:~511` (конфиг), `renderer/components/settings/SettingsDialog.tsx:~455–461` (поле под переключателем острова), `shared/strings.ts` (`settings.islandTopInset*`)
- Test: `main/island/placement.test.ts`, `shared/ui-types.test.ts` (normalizeIsland), `SettingsDialog.test.tsx`, `main/ui-store.test.ts` (если есть снимок DEFAULT_UI)

**Interfaces:**
- Produces: `IslandUi.topInset: 'auto' | 'none' | 'notch'` (умолчание `'auto'`); `notchInset(display, mode: IslandUi['topInset'], remembered: number | null): number`:
  `'none'` → 0; `'notch'` → `remembered ?? 32`; `'auto'` → как сейчас (`internal && menuBar >= 32 ? menuBar : 0`), а при `menuBar === 0` на внутреннем экране — `remembered ?? 0`.
- `remembered` — последняя увиденная высота строки меню внутреннего экрана (≥ 32), main хранит в `ui.json` рядом с `displayId` (пишет только main, как `displayId`/`anchor`).
- Строки: `settings.islandTopInset: 'Island top offset'`, варианты `islandTopInsetAuto: 'Auto'`, `islandTopInsetNone: 'None'`, `islandTopInsetNotch: 'Below the notch'`, подсказка `islandTopInsetHint: 'Auto follows the menu bar; pick "Below the notch" if the menu bar hides automatically.'`.

- [ ] **Step 1: Падающие тесты** — `placement.test.ts`: таблица (`internal`, `menuBar`, `mode`, `remembered`) → ожидаемый отступ, включая внешний монитор с `'notch'` → 0 (Review Focus 4) и внутренний с `menuBar 0`, `'auto'`, `remembered 37` → 37. `ui-types.test.ts`: `normalizeIsland` принимает три значения, иначе `'auto'`; старые `ui.json` без поля → `'auto'`. `SettingsDialog.test.tsx`: выбор «Below the notch» пишет патч `{ island: { topInset: 'notch' } }`.

- [ ] **Step 2: Запустить, убедиться, что падают.**

- [ ] **Step 3: Реализация** по интерфейсам выше; запоминание высоты — в `relayoutIsland`/`display-metrics-changed` (main/index.ts:~538–544): если `internal && menuBar >= 32` → сохранить. `Select` в настройках — по образцу языка помощника (`AssistantSettings.tsx`).

- [ ] **Step 4: PASS по четырём файлам тестов**; E2E `dialogs-layout.spec.ts` (800×500: новое поле в Notifications помещается).

- [ ] **Step 5: Коммит** — `feat(island): отступ под вырез — запомненная строка меню и ручной выбор в настройках`.

---

### Task 7: Подсказка о Claude Desktop — по факту установки

**Files:**
- Modify: `packages/desktop/src/main/assistant/claude-desktop.ts` (новый: чтение `~/Library/Application Support/Claude/claude_desktop_config.json`, ключ `globalShortcut`), `main/ipc.ts:418` (`app:assistant-shortcut` отдаёт ещё `clash: 'claude-desktop' | null`), `shared/island.ts` (`AssistantShortcutStatus.clash`), `renderer/components/settings/AssistantSettings.tsx:47, 133–134`, `shared/strings.ts` (`shortcutClaudeDesktopInstalled`)
- Test: `main/assistant/claude-desktop.test.ts`, `AssistantSettings.test.tsx`

**Interfaces:**
- Produces: `claudeDesktopQuickEntry(readFile): Promise<string | null>` — `null`, если файла нет или ключ `""`; иначе сочетание из ключа или `'Alt+Space'` по умолчанию (аудит REA п. 63). `AssistantShortcutStatus.clash === 'claude-desktop'`, когда наш accelerator совпадает с ним по нормализованной форме.
- Строка: `shortcutClaudeDesktopInstalled: 'Claude Desktop on this Mac uses the same shortcut for Quick Entry — change it here or there.'` (показывается вместо мягкой подсказки; красная `shortcutTaken` остаётся для `ok === false`).

- [ ] **Step 1: Падающие тесты** — файла нет → `null`; `{}` → `'Alt+Space'`; `{ "globalShortcut": "" }` → `null`; `{ "globalShortcut": "Ctrl+Space" }` → `'Ctrl+Space'`; битый JSON → `null`. `AssistantSettings.test.tsx`: `clash: 'claude-desktop'` → виден новый текст, мягкой подсказки нет.

- [ ] **Step 2: Запустить, убедиться, что падают.**

- [ ] **Step 3: Реализация**; детекции перехвата через Electron нет (`register` молча отдаёт `true`), поэтому только факт установки и конфиг. Чтение файла — только чтение, любая ошибка → `null`.

- [ ] **Step 4: PASS.**

- [ ] **Step 5: Коммит** — `feat(assistant): подсказка о Quick Entry Claude Desktop по его конфигу`.

---

## Вне плана

- Снимок работ хоста отстаёт от `rooms.create` (Ruling 21) — хост, не остров.
- Тёплый старт CLI помощника — отдельная задача после живой проверки (решение 2026-10-16).
- Codex на острове и общий поток запросов на хосте (TODOS 23) — отдельные спеки.

## Порядок и проверка

Задачи 1 → 3 → 4 → 2 → 6 → 7, Задача 5 — живая проверка человеком в любой момент после сборки. После каждой: `tsc --noEmit` desktop, eslint по тронутым файлам, тесты файла; после всех — `pnpm build`, `pnpm typecheck`, `pnpm lint`, `LC_ALL=C pnpm --dir packages/desktop run test`, E2E `island.spec.ts`, `island-cpu.spec.ts` (с `PARLEY_CPU=1`), `dialogs-layout.spec.ts`, `assistant.spec.ts`; dev-окно для живой проверки Задач 5 и 6.
