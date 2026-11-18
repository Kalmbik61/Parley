# Settings → About: версия, сборка и «Check now» — план

Дата: 2026-11-18. Автор: s-469 (Opus). Основание: разговор с человеком 2026-11-18 (решения ниже приняты им).

## 1. Цель и границы

В настройках появляется раздел **About**: версия Parley, сборка (коммит, дата, архитектура), версия хоста, окружение
(Electron, Chromium, Node, macOS), пути приложения и данных, кнопки **Check now**, **Release notes** и **Copy info**.
Переключатель автопроверки и строка самообновления переезжают сюда из Notifications.

Повод: 0.36.0 не узнала о вышедшей 0.37.0 почти сутки — проверка идёт при старте и раз в сутки, а проверить вручную
можно было только выключив и включив переключатель. И любая неудача проверки сейчас неотличима от «нового нет».

Решения человека (2026-11-18):

1. Блок обновления **переносится** из Notifications в About, не дублируется.
2. **Copy info** есть.
3. Реализация — по этому плану, исполнитель на младшей модели.

Всё изменение — в `packages/desktop` плюс README и CHANGELOG. Хост, протокол, остров, телефон и сам установщик
(загрузка, замена, выход) не трогаются. Нет в работе: пункт меню «About Parley» остаётся системной панелью; проверка
по расписанию не учащается; тост не меняется.

Отступление от спеки самообновления (`docs/specs/2026-11-15-self-update-design.md` §4.2): строка обновления живёт в
Settings → About, а не в Notifications. Спеку не правим — она историческая; README и CHANGELOG говорят новое место.

## 2. Общие правила для исполнителя

- Ветка — `feat/about-section` от `origin/master@2b52d262` (релиз 0.37.0), рабочая копия
  `/Users/kalmbik61/parley/worktrees/my_harnas-00f205/w-0054-about-section`. Работать только в ней.
- Папку `/Users/kalmbik61/Desktop/MY/my_harnas` не трогать и код из неё не читать: там старая ветка.
- Одна задача за раз, только её файлы. Соседний код не улучшать. Дефект вне задачи — в отчёт, не в код.
- Коммиты — по-английски, `feat(desktop): …`, `test(desktop): …`, `docs: …`, по одному или несколько на задачу.
  Комментарии в коде и тексты тестов — на языке соседнего кода (русский). Строки интерфейса — по-английски,
  только в `shared/strings.ts`.
- Push и PR — только по команде человека.
- Перед сдачей: тесты задачи, `pnpm --filter @parley/desktop test`, `pnpm typecheck`, `pnpm lint` из корня рабочей
  копии. Упавший тест вне задачи — назвать в отчёте с выводом, не чинить.
- Отчёт (`report`): что сделано, какой тест закрывает каждый критерий приёмки, коммиты, что не проверено.

## 3. Задачи

| № | Задача | Исполнитель | Зависит от |
|---|---|---|---|
| A1 | Сведения о сборке и окружении: `app:about-info` | junior | — |
| A2 | Ручная проверка с честным итогом: `app:check-for-updates` | junior, ревью старшей | A1 |
| A3 | Раздел Settings → About, перенос блока обновления | junior | A1, A2 |
| A4 | README, тест документов, CHANGELOG | junior | A3 |

A2 трогает флаг «проверки разрешены» установщика — его ревьюит старшая модель по диффу до A3.

### Общие типы (`packages/desktop/src/shared/bridge.ts`)

A1 добавляет `AboutInfo` без `lastCheck`, A2 — `UpdateCheckFailure`, `UpdateCheckResult` и поле `lastCheck`.

```ts
/** Почему проверка новой версии не ответила. */
export type UpdateCheckFailure =
  | 'network'       // нет ответа, обрыв, таймаут, 5xx и прочие не-2xx, кроме ниже
  | 'rate_limited'  // 403 или 429: лимит GitHub для запросов без токена
  | 'bad_response'; // ответ пришёл, но не годится: 404, больше предела, не JSON, не стабильный релиз

/** Итог проверки — по кнопке «Check now» или по расписанию. */
export type UpdateCheckResult =
  | { kind: 'current'; latest: string; checkedAt: number }   // последний релиз не новее запущенной версии
  | { kind: 'available'; latest: string; checkedAt: number } // есть новее
  | { kind: 'failed'; reason: UpdateCheckFailure; checkedAt: number }
  | { kind: 'unavailable' };                                   // окно не собрано или PARLEY_UPDATE_CHECK=off

export interface AboutInfo {
  /** `app.getVersion()` собранного окна; `null` — разработка (как `appVersion` в `ipc.ts`). */
  version: string | null;
  /** Сборка: короткий SHA (8 знаков), дата коммита `YYYY-MM-DD`, правки отслеживаемых файлов. Нет git — `null`. */
  commit: string | null;
  commitDate: string | null;
  dirty: boolean;
  arch: string;            // process.arch
  electron: string;        // process.versions.electron
  chrome: string;          // process.versions.chrome
  node: string;            // process.versions.node
  os: string;              // `macOS ${process.getSystemVersion()}`
  /** Путь `.app` (`bundleOf(app.getPath('exe'))?.app`); не из `.app` — `null`. Домашний каталог заменён на `~`. */
  appPath: string | null;
  /** `parleyHome()`; домашний каталог заменён на `~`. */
  dataDir: string;
  /** Проверка возможна вообще: `updateCheckAllowed(env, app.isPackaged)`. */
  updateChecks: boolean;
  /** A2: последняя завершённая проверка, ручная или по расписанию; `null` — ещё не было. */
  lastCheck: UpdateCheckResult | null;
}
```

### A1 — сведения о сборке и окружении

Файлы: `packages/desktop/electron.vite.config.ts`, новый `packages/desktop/src/main/build-info.ts` и его тест,
`src/shared/bridge.ts`, `src/main/ipc.ts`, `src/main/index.ts`, `src/preload/index.ts`,
`src/renderer/test-utils/fake-bridge.ts`, `src/main/ipc.test.ts`.

1. `electron.vite.config.ts`: при загрузке конфига узнать у git сборку — `git rev-parse --short=8 HEAD`,
   `git show -s --format=%cs HEAD`, `git diff --quiet HEAD --` (код 1 — `dirty: true`; неотслеживаемые файлы не
   считаются). `execFileSync` с `cwd` пакета; любая ошибка (нет git, нет `.git`) — `commit: null, commitDate: null,
   dirty: false`. Положить в `main.define` рядом с `__PARLEY_RELAY_IMAGE_DIGEST__`:
   `__PARLEY_BUILD__: JSON.stringify({ commit, commitDate, dirty })`. Только для `main`.
2. `main/build-info.ts`: `declare const __PARLEY_BUILD__: unknown;` и `readBuildInfo(raw: unknown)` → `{ commit,
   commitDate, dirty }` с проверкой формы (по образцу `relay-setup/image.ts`: `typeof __PARLEY_BUILD__`), чужое или
   отсутствующее — нули. Там же `tildify(path, home)`: путь внутри домашнего каталога → `~/…`, сам каталог → `~`,
   прочее как есть (`/Users/annabel` при доме `/Users/anna` не трогается).
3. `ipc.ts`: опция `aboutInfo: () => AboutInfo` и `ipcMain.handle('app:about-info', …)` через `withIpcError`.
   `index.ts` собирает `AboutInfo` из полей выше (`lastCheck: null` до A2). Сеть не трогается.
4. Мост: `bridge.app.aboutInfo(): Promise<AboutInfo>` в типе моста, прелоаде и `fake-bridge.ts` (подставная —
   правдоподобные значения, `version: '0.0.0-test'`, `updateChecks: false`).

Приёмка:

- `build-info.test.ts`: `readBuildInfo` — правильная форма, `undefined`, чужие типы полей; `tildify` — дом, путь
  внутри дома, сосед с общим префиксом, путь вне дома.
- `ipc.test.ts`: `app:about-info` отдаёт то, что вернула опция.
- `pnpm --filter @parley/desktop build` проходит; в `out/main/index.js` есть строка с SHA текущего `HEAD`
  (`grep $(git rev-parse --short=8 HEAD) packages/desktop/out/main/index.js`). Вывод команды — в отчёт.

### A2 — ручная проверка с честным итогом

Файлы: `src/main/update-check.ts` и тест, `src/main/update-installer.ts` и тест, `src/shared/bridge.ts`,
`src/main/ipc.ts` и тест, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/test-utils/fake-bridge.ts`.

1. `update-check.ts`: `fetchLatestReleaseResult(fetch, timeoutMs?)` →
   `{ ok: true; info: UpdateInfo } | { ok: false; reason: UpdateCheckFailure }` по таблице в типе
   `UpdateCheckFailure`. Таймаут — та же гонка, что сейчас. `fetchLatestRelease` остаётся обёрткой
   (`ok ? info : null`): прежние тесты не меняются.
2. Проверщик (`createUpdateChecker`):
   - `checkNow(): Promise<UpdateCheckResult>` — без оглядки на `isEnabled` (кнопка — явная просьба человека).
     Идущая ручная проверка не запускает вторую: повторный вызов получает тот же промис. Новее запущенной — `found`
     и `onUpdate(found)`, как у проверки по расписанию. Никогда не бросает.
   - Плановая `check()` после настоящего запроса тоже записывает итог.
   - `lastCheck(): UpdateCheckResult | null` — последний записанный итог. `checkedAt` — из `now` опций
     (`now?: () => number`, по умолчанию `Date.now`), чтобы тесты не зависели от часов.
3. Установщик (`update-installer.ts`): сейчас `checksDisabled()` при каждом сохранении `ui.json` с выключенным
   переключателем сбрасывает состояние в `idle` и отменяет загрузку. С ручной проверкой при выключенном
   переключателе это отменяло бы загрузку от любого сохранения настроек (ширина сайдбара, тема). Поэтому:
   - флаг `enabled` делится на `auto` (переключатель) и `manual` (была ручная проверка); разрешено — `auto || manual`;
   - `checksEnabled()` — `auto = true`; новый `manualCheck()` — `manual = true`;
   - `checksDisabled()` действует только при переходе `auto: true → false` (тогда `auto = false`, `manual = false` и
     прежний сброс); при `auto === false` — ничего не делает.
4. `index.ts` и `ipc.ts`: `ipcMain.handle('app:check-for-updates', …)`. Не разрешено
   (`updateCheckAllowed(shellEnv.env, app.isPackaged)` ложно) — `{ kind: 'unavailable' }` без сети. Иначе
   `updateInstaller.manualCheck()`, затем `updates.checkNow()`. `aboutInfo` отдаёт `lastCheck: updates.lastCheck()`.
5. Мост: `bridge.app.checkForUpdates(): Promise<UpdateCheckResult>` — тип, прелоад, подставной мост (по умолчанию
   `{ kind: 'unavailable' }`, тест может подменить).

Приёмка (каждый пункт — тест):

- `fetchLatestReleaseResult`: 200 со стабильным релизом — `ok`; 403 и 429 — `rate_limited`; 404 — `bad_response`;
  500 — `network`; отказ `fetch` — `network`; таймаут — `network`; тело больше предела, не JSON, prerelease —
  `bad_response`.
- `checkNow`: при `isEnabled() === false` всё равно идёт в сеть; новее — `available` и один `onUpdate`; та же
  версия и старше — `current`; два вызова подряд — один запрос; `lastCheck` после плановой и после ручной проверки.
- Установщик: переключатель выключен, `manualCheck()` + `onFound(новее)` — `available`; затем `checksDisabled()`
  (сохранение настроек при выключенном переключателе) — состояние и загрузка не тронуты; переключатель был включён,
  `checksDisabled()` — прежний сброс в `idle`, как в существующих тестах.
- `ipc.test.ts`: канал отдаёт итог опции.

### A3 — раздел Settings → About

Файлы: `src/renderer/store/ui.ts` (`SettingsSection`), `src/renderer/components/settings/SettingsDialog.tsx` и тест,
новые `src/renderer/components/settings/AboutSettings.tsx`, `src/renderer/components/settings/about-text.ts` и их
тесты, `src/shared/strings.ts` и `src/shared/strings.test.ts`, новый `e2e/settings-about.spec.ts`.

1. `SettingsSection` += `'about'`; в `SECTION_ORDER` — последним; подпись `S.settings.sections.about = 'About'`.
2. `AboutSettings` (проп `bridge`), данные — `bridge.app.aboutInfo()` при открытии раздела, версия хоста — из
   статуса связи в сторе окна (как `StatusBar`), не через новый канал:
   - заголовок `Parley 0.37.0`; `version === null` — `Parley (development build)`;
   - строка сборки `Build 2b52d262 · 2026-11-17 · arm64`, при `dirty` — ` · modified`; отсутствующее не выводится;
   - список: Host (`0.37.0` или `Not connected`), Electron, Chromium, Node, macOS, App (если не `null`), Data;
   - кнопки: **Check now**, **Release notes** (`https://github.com/Kalmbik61/Parley/releases/tag/v<version>` через
     `bridge.app.openExternal`; при `version === null` кнопки нет), **Copy info**;
   - под кнопками строка итога: во время проверки `Checking…` (кнопка неактивна), затем по `kind`:
     `current` — `Parley <latest> is the latest version`; `available` — `Parley <latest> is available` (действие
     даёт строка обновления ниже); `failed` — `network`: `Couldn't reach GitHub. Check your connection.`,
     `rate_limited`: `GitHub's rate limit was reached. Try again later.`, `bad_response`:
     `GitHub sent an unexpected answer. Try again later.`; `unavailable` — `Update checks are off in this build`
     и кнопка **Check now** неактивна с самого начала (`updateChecks === false`);
   - до первой ручной проверки, если `lastCheck !== null`: `Last checked <время>` — время локальным форматом;
     если в `renderer/lib` уже есть форматтер времени, взять его;
   - переключатель `S.settings.checkForUpdates` (значение строки — `Check for updates automatically`) и подсказка
     `S.settings.checkForUpdatesHint` — тот же `patchUi({ checkForUpdates })`, что сейчас в Notifications;
   - `<UpdateSettingsRow bridge={bridge} />` — **всегда**, не только при включённом переключателе: найденное ручной
     проверкой должно быть видно и с выключенной автопроверкой.
3. Из Notifications убрать переключатель, подсказку и `UpdateSettingsRow`. Обновить комментарии, которые называют
   Notifications местом строки (`UpdateSettingsRow.tsx`, `strings.ts` у `update.row`, шапка `SettingsDialog.tsx`).
4. `about-text.ts`: чистая `aboutText(info: AboutInfo, hostVersion: string | null): string` для **Copy info**:

   ```text
   Parley 0.37.0 (arm64)
   Build 2b52d262, 2026-11-17
   Host 0.37.0
   Electron 44.4.5, Chromium <версия>, Node <версия>
   macOS 27.2
   App /Applications/Parley.app
   Data ~/.parley
   ```

   Отсутствующее опускается (`modified` — `Build 2b52d262, 2026-11-17, modified`). Копирование —
   `navigator.clipboard.writeText` и тост `Copied` по образцу `ProviderUpdateRow.tsx`; ошибка — `console.warn`.
5. e2e `settings-about.spec.ts` по образцу соседних спеков с настройками: открыть Settings → About, увидеть
   `Parley`, строку `Build`, неактивную **Check now** и `Update checks are off in this build` (в E2E
   `PARLEY_UPDATE_CHECK=off`), сохранить снимок раздела в `test-results/settings-about.png`.

Приёмка:

- `about-text.test.ts`: полная форма; `version`, `commit`, `appPath` и хост — `null`; `dirty`.
- `AboutSettings.test.tsx`: заголовок и сборка из подставного моста; `development build`; **Check now** → каждый
  `kind` даёт свою строку и кнопка неактивна, пока промис не решён; `updateChecks: false` — кнопка неактивна сразу;
  **Release notes** открывает адрес с `v<version>`; **Copy info** пишет текст `aboutText`; `Last checked` при
  `lastCheck`.
- `SettingsDialog.test.tsx`: блоки «Check for updates» и «строка самообновления» ищут переключатель и строку в
  разделе About; новый тест — в Notifications их нет; строка обновления видна при `checkForUpdates: false`.
- `strings.test.ts`: новые строки на месте, `checkForUpdates` — новое значение.
- e2e проходит, снимок сохранён (путь — в отчёт).

### A4 — README, тест документов, CHANGELOG

Файлы: `README.md`, `packages/desktop/src/release-docs.test.ts`, `CHANGELOG.md`.

1. README, раздел «Updates»: проверку выключают в Settings → About; там же **Check now** и строка **Update**.
   Остальные обещания раздела не трогать.
2. `release-docs.test.ts`: раздел настроек в «Updates» сверяется с `S.settings.sections.about`, а не с
   Notifications; остальные проверки как есть.
3. CHANGELOG, `## Unreleased`: в **Added** — пункт о разделе About (что в нём, **Check now** отвечает и при
   выключенной автопроверке, различает «последняя версия», «нет связи», «лимит GitHub», **Copy info** заменяет дом
   на `~`); в **Changed** — переключатель и строка обновления переехали из Notifications в About.

Приёмка: `pnpm --filter @parley/desktop test -- release-docs` проходит; README и CHANGELOG не обещают того, чего нет в
коде.

## 4. Приёмка работы целиком (ведущий)

- `pnpm --filter @parley/desktop test`, `pnpm typecheck`, `pnpm lint` — зелёные; вывод в отчёт.
- e2e `settings-about.spec.ts` — зелёный, снимок раздела приложен.
- Ревью диффа A2 старшей моделью: флаги `auto`/`manual` установщика, дедупликация ручной проверки, отсутствие
  исключений из `checkNow`.

Не проверяется в этой работе: настоящий запрос к GitHub из собранного `.app` (E2E выключает сеть), вид раздела в
собранном приложении на Intel.
