# Parley обновляет себя сам — план

Дата: 2026-11-15. Спека: `docs/specs/2026-11-15-self-update-design.md` (редакция 6). Автор: s-370 (Fable).

## 1. Цель и границы

По кнопке в окне Parley скачивает найденный релиз, проверяет его, готовит рядом с приложением и по «Restart now»
заменяет себя через обычный выход. Всё изменение — в `packages/desktop`; хост, протокол, остров и телефон не
трогаются. Чего в работе нет — Спека §11.

## 2. Общие правила для исполнителей

- Ветка сборки — `feat/self-update` от `origin/master@d09aedb9`, рабочая копия
  `/Users/kalmbik61/parley/worktrees/my_harnas-00f205/w-0054-self-update`. Исполнитель работает в своей рабочей
  копии от этой ветки и сдаёт один коммит (или несколько по смыслу); в ветку сборки их переносит ведущий.
- Папку `/Users/kalmbik61/Desktop/MY/my_harnas` не трогать и код из неё не читать: там другая ветка.
- Одна задача за раз, только её файлы. Соседний код не улучшать. Нашёл дефект вне задачи — в отчёт, не в код.
- Сообщения коммитов — по-английски, в виде `feat(desktop): …`, `test(desktop): …`, `docs: …`. Комментарии в
  коде и тексты тестов — на языке соседнего кода (русский). Строки интерфейса — по-английски, в `shared/strings.ts`.
- Push и PR — только по команде человека.
- Перед сдачей: тесты задачи, `pnpm --filter @parley/desktop typecheck`, `pnpm lint`.
- Отчёт: что сделано, какие сценарии Спеки §6 закрыты каким тестом, что не проверено.

## 3. Задачи

| № | Задача | Исполнитель | Зависит от | Сценарии Спеки |
|---|---|---|---|---|
| U1 | Типы состояния, адреса, пути, «можно ли заменить себя» | junior | — | SU-23, SU-24 |
| U2 | Попытка: загрузка, проверка, подготовка рядом с приложением | senior-only | U1 | SU-03…SU-07 |
| U3 | Сценарий замены и формат итога | senior-only | U1 | SU-16…SU-19, SU-29 |
| U4 | Намерение выхода и три повтора в сторожах | senior-only | — | SU-10…SU-13 |
| U5 | Старт окна: итог, `.old`, каталоги подготовки | senior-only | U1, U3 | SU-20…SU-22, SU-30 |
| U6 | Установщик: состояние, клик, событие `quit`, связка в `index.ts` | senior-only | U1…U5 | SU-01, SU-08, SU-09, SU-14, SU-15 |
| U7 | Мост окна: каналы состояния вместо прежних двух | junior | U1, U6 | SU-08 |
| U8 | Окно: тост по состояниям и строка в настройках | junior | U7 | SU-01, SU-02 |
| U9 | README, тест документов, CHANGELOG, комментарии | junior | U8 | SU-25 |
| T1 | Приёмка и лист живого прогона | verifier (junior) | все | все; SU-26…SU-28 — лист |

**Почему senior-only.** U2 качает и распаковывает код, который потом запускается (безопасность, граница записи).
U3 и U5 переименовывают и удаляют каталоги приложения (граница записи, восстановление). U4 и U6 решают, запустится
ли замена при выходе (конкурентность). После каждой из них — ревью старшей моделью другого провайдера по диффу.

Параллельно можно вести U1 → (U2, U3) и U4; затем U5; затем U6; затем U7 → U8 → U9; затем T1.

### U1 — типы, адреса, пути, «можно ли заменить себя»

Читать: Спека §3 (решения 4, 5), §5.1, §5.2, §5.3 (имена каталогов), §5.5 (имена рядом с приложением).

Файлы: `packages/desktop/src/shared/bridge.ts` (типы), новый `packages/desktop/src/main/update-target.ts` и его тест.

1. В `shared/bridge.ts` рядом с `UpdateInfo`: `UpdateFailure`, `UpdateState` (ровно как в Спеке §5.1) и
   `UpdateResult = { kind: 'updated'; version: string } | { kind: 'failed'; version: string; reason: UpdateResultFailure }`,
   где `UpdateResultFailure` — `'still_running' | 'no_app' | 'swap_failed' | 'restore_failed' | 'launch_failed' | 'helper'`.
   Методы моста в этой задаче не менять.
2. `update-target.ts`, чистые функции без обращения к диску:
   - `archiveName(arch)` → `parley-macos-arm64.zip` / `parley-macos-x64.zip`; другая архитектура → `null`;
   - `assetUrl(version, file)` → адрес из решения 5; версия не вида `X.Y.Z` → исключение;
   - `bundleOf(exePath)` → `{ parent, name, app }` для пути вида `<каталог>/<имя>.app/Contents/MacOS/<файл>`, иначе `null`;
   - `besideApp(bundle)` → `{ old, result, lock }` и `stagingDir(bundle, pid, n)` по именам Спеки;
   - `parseStagingName(name, bundleName)` → `{ pid, n } | null` (для старта окна, U5);
   - `installRefusal(input)` → `null` или причина; вход — `{ platform, packaged, exePath, canWrite(path), lockfWorks }`;
     условия — Спека §5.2.
3. Отдельно `probeLockf(run, file)`: запускает `/bin/sh -c 'exec 9>"$1" && /usr/bin/lockf -s -t 0 9' sh <file>` через
   переданную функцию запуска и возвращает `true` при коде 0.

Тесты: таблицы входов для каждой функции; SU-23 по `installRefusal`; SU-24 — имя архива равно `artifactName` из
`packages/desktop/electron-builder.yml` с подставленной архитектурой (файл читается тестом); `probeLockf` — на
настоящем `/usr/bin/lockf` (тест помечен «только macOS»).

Готово, когда: тесты проходят; в отчёте — список экспортов.

### U2 — попытка: загрузка, проверка, подготовка (senior-only)

Читать: Спека §3 (решения 5–7), §5.1 («Попытка»), §5.3; `main/update-check.ts` (как устроены `UpdateFetch`,
пределы, чтение потока).

Файлы: новый `packages/desktop/src/main/update-download.ts` и тест.

`runAttempt(deps, input)` → объект `{ done: Promise<{ ok: true; stagedApp: string } | { ok: false; reason: UpdateFailure }>, cancel(): Promise<void> }`.
Вход: версия, архитектура, каталог загрузки, каталог подготовки. Зависимости: `fetch` (тип как `UpdateFetch`, но с
телом ответа), `run(command, args)` для `ditto`, `defaults`, `xattr` с возможностью завершить процесс, `onProgress`,
часы и таймеры.

Шаги — ровно Спека §5.3, пункты 1–7, с её пределами (64 КиБ и 30 с на манифест; 1 ГиБ и 60 с без байтов на архив).
`cancel()` обрывает запрос, завершает дочерний процесс, ждёт его конца и только потом удаляет оба каталога; после
отмены `done` не меняет ничего снаружи. Адреса берутся из `assetUrl` (U1), а не из входа.

Тесты (подставной `fetch`, настоящие `ditto`/`defaults`/`xattr` на архиве, собранном тестом из поддельного
`Parley.app` с `Info.plist`): SU-03, SU-04, SU-05, SU-06, SU-07. Для SU-07 распаковка задерживается подставной
`run`, и проверяется порядок: каталоги удалены после конца дочернего процесса.

Готово, когда: тесты проходят; в отчёте — таблица «отказ → причина» и что именно проверяет каждый тест.

### U3 — сценарий замены и формат итога (senior-only)

Читать: Спека §5.5 целиком, §6 (абзац о стенде), §7 (риски 2, 3); скрипт `~/.local/bin/parley-update` как образец
порядка действий.

Файлы: новый `packages/desktop/src/main/update-helper.ts` и тест.

1. `helperScript(options?)` → текст сценария. Параметры — только время ожидания и пути утилит (`mv`, `rm`, `lockf`,
   `open`, `ps`); значения по умолчанию — константы Спеки. Пути приложения и версия в текст не попадают: сценарий
   берёт их из пяти аргументов (pid окна, путь приложения, путь подготовленного приложения, версия, путь итога).
   Тело — в функции, вызываемой последней строкой.
2. Шаги, исходы и состояние диска — таблица Спеки §5.5. Замок — `exec 9>"$LOCK"` и `lockf -s -t 0 9`; `open`
   запускается с закрытым дескриптором (`9>&-`). Перед каждым `mv` — проверка, что места назначения нет.
3. `formatResult` / `parseResult` для строки итога (`swapped X.Y.Z`, `failed X.Y.Z <код>`); чужая форма → `null`.

Тесты запускают настоящий `/bin/sh` во временном каталоге (стенд — Спека §6): SU-16, SU-17 (каждый отказ таблицы
отдельным случаем), SU-18, SU-19, SU-29. Подставные утилиты — файлы, которые тест кладёт рядом; настоящий
`/usr/bin/lockf` — в SU-29.

Готово, когда: тесты проходят; в отчёте — текст сценария целиком и таблица «исход → что на диске», сверенная с
тестами.

### U4 — намерение выхода и три повтора (senior-only)

Читать: Спека §3 (решение 3), §5.4; `main/quit-guard.ts`, `main/window.ts` (`guardWindowClose`).

Файлы: новый `packages/desktop/src/main/quit-intent.ts` и тест; `main/quit-guard.ts`, `main/window.ts` и их тесты.

1. `createQuitIntent<T>()` → `{ arm(payload), ownQuit(quit), onBeforeQuit(), clear(), take(): T | null }`.
   `ownQuit(quit)` ставит отметку на время вызова `quit()` (`try/finally`); `onBeforeQuit()` без отметки сбрасывает
   намерение; `take()` отдаёт намерение один раз.
2. `guardAppQuit`: необязательная зависимость `retryQuit?: (quit: () => void) => void`; повтор в `run()` идёт через
   неё (по умолчанию — прямой вызов). Поведение без неё не меняется.
3. `guardWindowClose`: необязательный параметр `retryQuit` с тем же смыслом — в ответе «закрыть»
   (`if (quit) app.quit()`) и в «Quit anyway» зависшей страницы, но там только если стоял `quitting`; без `quitting`
   вызов остаётся прямым.

Тесты: SU-10 (на уровне модуля: `arm` → свой `before-quit` → `take`), SU-11, SU-12, SU-13. Подставной `app` в
тестах, как Electron, не порождает `before-quit` на `quit()` во время идущего выхода. Существующие тесты сторожей
не меняются.

Готово, когда: тесты проходят; в отчёте — таблица «путь выхода → намерение живо или сброшено».

### U5 — старт окна: итог, `.old`, каталоги подготовки (senior-only)

Читать: Спека §4.3, §5.4 (файл `handoff`), §5.6, риски 2 и 7.

Файлы: новый `packages/desktop/src/main/update-startup.ts` и тест.

`runUpdateStartup(deps)` → `UpdateResult | null`. Зависимости: пути (U1), запущенная версия, свой pid, `isAlive(pid)`,
файловые операции. Делает ровно Спеку §5.6, пункты 1–3. Удаление `.old` и каталогов — в фоне, ошибки удаления — в
журнал, наружу не бросаются.

Тесты: SU-20, SU-21; SU-22 и SU-30 — вместе со сценарием из U3 (настоящий `/bin/sh`, подставной `mv`, который
ждёт сигнала теста; случай с убитой оболочкой и живым дочерним `mv`).

Готово, когда: тесты проходят; в отчёте — таблица «что лежит рядом с приложением → что сделал старт».

### U6 — установщик и связка в main (senior-only)

Читать: Спека §5.1, §5.4, §5.6; `main/index.ts` (места: `createUpdateChecker`, `guardAppQuit`, `guardWindowClose`,
`powerMonitor`, блокировка единственного экземпляра); `main/update-check.ts`.

Файлы: новый `packages/desktop/src/main/update-installer.ts` и тест; `main/index.ts`.

1. `createUpdateInstaller(deps)` — состояние и переходы Спеки §5.1: `onFound(info)`, `checksDisabled()`,
   `download()`, `cancel()`, `install()`, `state()`, `onState(listener)`. Номер попытки, один выбранный релиз,
   события хода не чаще четырёх в секунду.
2. `install()` — Спека §5.4, «Клик»: проверка, запись сценария, `intent.arm(...)`, `intent.ownQuit(() => app.quit())`.
3. Слушатель `quit` — Спека §5.4, «Событие `quit`»: файл `handoff`, `spawn`, слушатель `error`, отказ `helper` с
   флагом `wx`.
4. `index.ts`: проверка версии передаёт находку установщику (`onUpdate` → `onFound`); выключенный переключатель →
   `checksDisabled()`; `before-quit` → `intent.onBeforeQuit()`; три повтора сторожей получают `intent.ownQuit`;
   обработчик `powerMonitor 'shutdown'` вызывает `intent.clear()` до `app.quit()`; `runUpdateStartup` — до создания
   окон; его результат отдаётся окну один раз (`takeUpdateResult`).

Тесты: SU-01, SU-08, SU-09, SU-14, SU-15 — на `createUpdateInstaller` с подставными зависимостями.

Готово, когда: тесты проходят, `pnpm --filter @parley/desktop build` собирается; в отчёте — перечень правок
`index.ts` с номерами строк.

### U7 — мост окна

Читать: Спека §5.1 (мост), §9; `main/ipc.ts` (`getUpdate`, `app:get-update`), `preload/index.ts`
(`onUpdateAvailable`), `renderer/test-utils/fake-bridge.ts`.

Файлы: `shared/bridge.ts`, `main/ipc.ts`, `preload/index.ts`, `main/index.ts` (только передача зависимостей в
`ipc.ts` и отправка `app:update-state`), `renderer/test-utils/fake-bridge.ts`, их тесты, e2e
`window-ready.spec.ts` и `telegram.spec.ts`, если они называют прежние каналы.

`bridge.app`: вместо `onUpdateAvailable` — `getUpdateState()`, `onUpdateState(listener)`, `downloadUpdate()`,
`cancelUpdateDownload()`, `installUpdate()`, `takeUpdateResult()`. Ни один не принимает параметров (кроме
слушателя). Каналы `app:update-available` и `app:get-update` удаляются. Подписчик `onUpdateState` получает
текущее состояние сразу, как прежний `onUpdateAvailable` получал найденное.

Тесты: `ipc.test.ts`, `fake-bridge.test.ts` — новые каналы; SU-08 — у вызовов нет параметров.

Готово, когда: тесты и typecheck проходят; прежних имён каналов нет в `packages/desktop/src`.

### U8 — окно: тост и строка настроек

Читать: Спека §4.1, §4.2, §4.3; `renderer/update/update-notice.ts` и его тест; `SettingsDialog.tsx` (место
переключателя `checkForUpdates`, около строки 700); `shared/strings.ts` (`S.update`).

Файлы: `renderer/update/update-notice.ts`, новый небольшой компонент строки настроек рядом с ним, `SettingsDialog.tsx`,
`shared/strings.ts`, тесты.

1. Тост — таблица §4.1: один `UPDATE_TOAST_ID`, состояния сменяются на месте; «Update» версию закрытой не
   записывает; «Restart now» тост не закрывает; «Cancel» зовёт `cancelUpdateDownload()`.
2. Строка в Settings → Notifications под переключателем — таблица §4.2.
3. Итог после перезапуска — §4.3: `takeUpdateResult()` при старте, тост один раз. Тексты причин — в `S.update`
   по одной строке на каждый код `UpdateFailure` и `UpdateResultFailure`.

Тесты: `update-notice.test.ts` — по строке на каждое состояние и кнопку (SU-01, SU-02 со стороны окна); тест
строки настроек; правила `dismissedUpdate` из шапки файла сохраняются.

Готово, когда: тесты проходят; в отчёте — снимки тоста в каждом состоянии и строки настроек, светлая и тёмная
тема (окно разработки с подставным состоянием).

### U9 — документы

Читать: Спека §8; `README.md` («Updates», «Allow the first launch», перечень собственных запросов);
`packages/desktop/src/release-docs.test.ts`; последние три записи `CHANGELOG.md`.

Файлы: `README.md`, `packages/desktop/src/release-docs.test.ts`, `CHANGELOG.md`, шапки `main/update-check.ts` и
`renderer/update/update-notice.ts`, комментарий в `packages/desktop/electron-builder.yml`,
`docs/specs/2026-10-01-release-0.1.0-plan.md` (одна строка у V6).

README «Updates»: кнопка «Update», затем «Restart now»; перезапуск гасит агентов и спрашивает об этом; когда
вместо «Update» стоит «Download» и что тогда делать (прежняя ручная замена); строка ручного восстановления
`mv /Applications/.Parley.app.old /Applications/Parley.app`; доступы macOS спрашиваются заново. Перечень
собственных запросов: загрузка архива и `SHA256SUMS.txt` с GitHub по клику.

Тест документов держит новые обещания и перестаёт требовать «it does not update itself».

Готово, когда: `release-docs.test.ts` проходит; `git diff --stat` показывает только названные файлы; в отчёте —
текст записи CHANGELOG и раздела «Updates» целиком.

### T1 — приёмка

Читать: Спека §6, §10; отчёты задач.

1. `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @parley/desktop e2e` в рабочей копии
   ветки сборки; то же на `origin/master` для сравнения упавших тестов.
2. Таблица SU-01…SU-30: файл и название теста, прошёл ли; без теста — «не покрыт».
3. Лист живого прогона для человека (SU-26, SU-27): как собрать приложение из ветки с заниженной версией
   (`pnpm --filter @parley/desktop dist --dir`), куда положить, с каким домом Parley запустить, что нажать, что
   должно произойти, что убрать после. Поля результата пустые. SU-28 — отдельной строкой «после двух релизов».
4. Код не править: дефект — в отчёт с воспроизведением.

Итог: `docs/audits/2026-11-15-self-update-acceptance.md` (дата фактическая), один коммит `docs(audits): …`, с
карточкой влияния; строки про живую часть — «not measured: ждёт прогона человека».

## 4. Ревью и сборка

- U2–U6: после сдачи — ревью старшей моделью другого провайдера по диффу против Спеки; возврат — тому же
  исполнителю.
- U1, U7–U9: дифф читает ведущий.
- Ведущий переносит принятые коммиты в `feat/self-update` и после каждого переноса гоняет тесты
  `packages/desktop` и typecheck.

## 5. Что останется непроверенным до релиза

SU-28: полный путь «версия с этой работой → следующая версия» (тост «updated to», уборка `.old`, замена моста
Remote access) проверяется только на первом обновлении после двух релизов.
