# Обновление CLI из Parley и стартовые вопросы — план

Спека: `docs/specs/2026-11-02-cli-update-and-startup-prompts-design.md` (решения человека — раздел 9).
Лид s-209, владелец s-38. Исполнители — Claude Sonnet (`builtin:executor`, provider `claude`), одна задача за раз,
каждую проверяет лид. Без push и PR без человека. Коммиты — на английском.

Часть 1 (`-c check_for_update_on_startup=false`) уже в ветке: `9cb024ec`.

## T1. core: последняя версия и способ установки

- Файлы: новый `packages/core/src/cli-updates.ts`, `packages/core/src/cli-updates.test.ts`, экспорт в
  `packages/core/src/index.ts`.
- Состав:
  - `installMethod(provider: 'codex' | 'claude', realBinary: string, home: string)` →
    `'standalone' | 'npm' | 'brew' | 'native' | 'unknown'`. Codex: под `<home>/.codex/packages/standalone/` →
    standalone, в пути `node_modules/@openai/codex/` → npm, `Caskroom` или `/opt/homebrew/`, `/usr/local/Caskroom` →
    brew. Claude: под `<home>/.local/share/claude/versions/` → native, `node_modules/@anthropic-ai/claude-code/` → npm.
  - `fetchLatestVersion(source, fetchImpl, timeoutMs = 5000)` → `string | null`. Источники:
    Codex — `https://api.github.com/repos/openai/codex/releases/latest`, поле `tag_name` вида `rust-v0.166.0`,
    `prerelease: true` → `null`; Codex через brew — `https://formulae.brew.sh/api/cask/codex.json`, поле `version`;
    Claude — `https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags`, поле по каналу
    (`latest` по умолчанию). Любая ошибка, таймаут, не-200 или чужая форма → `null`, без исключений и без логов
    с телом ответа.
  - `isNewer(installed, latest)`: semver x.y.z, пре-релизы → `false`.
- Приёмка: тесты на фейковом `fetch` для каждого источника, включая таймаут (AbortSignal), 403, битый JSON и
  пре-релиз; тесты `installMethod` на путях человека (`~/.codex/packages/standalone/releases/0.162.0-aarch64-apple-darwin/bin/codex`,
  `~/.nvm/versions/node/v22.23.3/lib/node_modules/@openai/codex/bin/codex.js`, `~/.local/share/claude/versions/2.1.316`).
  Сеть в тестах не используется. `npx vitest run` в core, lint, `tsc --noEmit` — зелёные.

## T2. host: проверка раз в сутки, кэш и «Пропустить»

- Файлы: новый `packages/host/src/providers/updates.ts` (+ `.test.ts`); `packages/host/src/providers/versions.ts`
  только если нужен доступ к версии; `packages/host/src/methods/providers.ts` (поле в `providers.list`, метод
  `providers.skipUpdate`); `packages/protocol/src/methods.ts`, `packages/protocol/src/types.ts` (схемы и типы);
  подключение в `packages/host/src/host.ts` / `main.ts`.
- Поведение:
  - кэш `<parleyHome>/cli-updates.json`: `{ version: 1, providers: { codex: { latest, checkedAt, method, skipped } } }`;
    запись атомарная (tmp + rename), битый файл = пустой;
  - первая проверка — в фоне после старта хоста, затем каждые 24 ч; не чаще раза в 20 ч по `checkedAt`;
    запуск сессий и `providers.list` проверку не ждут;
  - проверяются только команды `codex` и `claude` из реестра (GLM и свои провайдеры показывают строку `claude`);
  - путь бинаря — тот же, что запускает Parley (`findBinary` / `findRunnerBinary` из `core/work/find-binary.ts`,
    учитывая `PARLEY_<КОМАНДА>_BIN`), затем `realpath` для `installMethod`;
  - `providers.list` получает у провайдера поле `update: { latest: string; method: string; checkedAt: string } | null`;
    `null`, если версия не новее, если её пропустили (`skipped === latest`) или если проверки не было;
  - `providers.skipUpdate({ provider })` пишет `skipped = latest`; при выходе следующей версии строка возвращается;
  - без сети — тишина: в кэш пишется только `checkedAt`, `latest` не стирается.
- Приёмка: тесты на фейковом времени и fetch — интервал 20/24 ч, офлайн, пропуск версии, битый кэш, путь бинаря
  с подменой `PARLEY_CODEX_BIN`; протокол-тест схем; тесты host и protocol, lint, typecheck — зелёные.

## T3. host: `providers.update`

- Файлы: `packages/host/src/providers/update-run.ts` (+ `.test.ts`), `packages/host/src/methods/providers.ts`,
  `packages/protocol/src/methods.ts`.
- Поведение:
  - `providers.update({ provider: 'codex' | 'claude' })` запускает `<абсолютный путь бинаря> update` через
    `execFile` без pty и без shell; окружение — `agentEnv(process.env)` без `CODEX_MANAGED_BY_*` и
    `CODEX_MANAGED_PACKAGE_ROOT`; stdin закрыт; таймаут 5 мин, затем SIGKILL;
  - одно обновление на провайдера за раз: повторный вызов, пока идёт первый, получает `{ state: 'busy' }`;
  - после выхода — `versions.fresh(command)`; для Codex пробный `codex -c check_for_update_on_startup=false --version`;
  - ответ: `{ ok, from, to, output }`, где `output` — последние 4 КБ stdout+stderr; при `ok: false` — ещё
    `manualCommand` (`<путь> update`); кэш T2 обновляется, строка гаснет;
  - работающие сессии не трогаются; ответ несёт `runningSessions` — число активных сессий этого провайдера;
  - метод изменяющий: пишет запись в журнал хоста (кто, когда, from → to, ok).
- Приёмка: тесты с фейковым бинарём-скриптом во временной папке (успех с ростом версии, ненулевой выход, таймаут,
  занятость, очистка `CODEX_MANAGED_BY_NPM` из окружения, отсутствие shell). Настоящий `codex update` в тестах
  и вручную не запускается — первый настоящий запуск делает человек кнопкой.

## T4. desktop: строка в настройках и метка «↑»

- Файлы: `packages/desktop/src/renderer/components/settings/ProvidersSettings.tsx`,
  `packages/desktop/src/renderer/shell/StatusBar.tsx`, строки интерфейса (тот же файл строк, что `S.statusBar`),
  тесты рядом по принятому в desktop образцу.
- Поведение:
  - строка провайдера: «Codex 0.162.0 → 0.166.0 · standalone · [Обновить] · Пропустить эту версию»; во время
    обновления — индикатор и недоступная кнопка; после — итог («Обновлено до 0.166.0» или ошибка с командой
    для ручного запуска); при `runningSessions > 0` подпись «N сессий Codex останутся на 0.162.0 до перезапуска»;
  - строка состояния: рядом с версией в сегменте провайдера — тихая метка «↑» с подсказкой
    «Доступна 0.166.0»; по щелчку открываются Настройки → Провайдеры;
  - без `update` ничего нового не рисуется.
- Приёмка: тесты компонентов (есть обновление / нет / идёт / ошибка / пропуск); typecheck desktop; снимок
  экрана настроек и строки состояния из живого окна (браузер Parley) приложен к отчёту.

## T5. Спайк: что гасит вопрос Claude о серверах MCP

- Только исследование, код и файлы репозитория не меняются. Временная папка в scratchpad: `git init`,
  `.mcp.json` с двумя безвредными stdio-серверами (`node -e` с пустым ответом), Claude 2.1.316.
- Проверить в pty (как в Части 1), какой вариант убирает вопрос «N new MCP servers found»:
  1) `--settings '{"enabledMcpjsonServers":["a"],"disabledMcpjsonServers":["b"]}'`;
  2) `.claude/settings.local.json` с теми же ключами;
  3) запись `projects[<cwd>]` в `~/.claude.json` — **не делать**, только отметить как вариант;
  4) для варианта, который сработал: подключён ли «a» (`claude mcp list` в той же папке) и выключен ли «b».
  Плюс: появляется ли вопрос снова в новом worktree той же папки (`git worktree add`).
- Приёмка: команды, выводы и вывод «какой путь работает» в отчёте; лид переносит результат в раздел 7 спеки.
  Доверие к временной папке даётся только ей и потом удаляется.

## T6. host: карточка согласия `project-mcp`

Затрагивает доверие к исполнению кода и границу записи: обязательно ревью старшей модели (лид), отдельным проходом.

- Файлы: новый `packages/host/src/consents/project-mcp.ts` (+ `.test.ts`), `consents-service.ts`, `held-launches.ts`,
  `packages/protocol/src/consents.ts`, место запуска Claude в `packages/host/src/sessions/sessions-service.ts`;
  хранение — `<parleyHome>/mcp-consent.json`.
- Поведение (по итогу T5, путь записи — тот, что сработал):
  - перед запуском сессии Claude-семейства хост читает `.mcp.json` в папке сессии и выше, вплоть до домашней папки;
    отпечаток сервера — sha256 от `type`/`command`/`args`/`url` без `env` и `headers`;
  - ключ решения — realpath корня основного репозитория (для worktree — `git rev-parse --git-common-dir`, его родитель),
    плюс имя и отпечаток сервера;
  - есть сервер без решения (или с другим отпечатком) → запуск откладывается, поднимается карточка
    `project-mcp` со списком и выбором для каждого, по умолчанию всё выключено; `consents.decide` принимает
    `{ enabled: string[] }`; отказ = все выключены;
  - перед запуском решение передаётся Claude выбранным в T5 путём; в репозиторий ничего не коммитится;
  - молча ничего не включается; без ответа запуск ждёт, как при `folder-trust`.
- Приёмка: тесты — новый сервер → карточка; решение → запуск с нужными ключами; worktree того же репозитория →
  без карточки; изменённый отпечаток → карточка снова; битый `.mcp.json` → карточка не поднимается, запуск
  без серверов проекта и запись в журнал; ни одна ветка не включает сервер без решения.

## T7. Окно, остров и телефон: вид карточки `project-mcp`

- Файлы: `packages/desktop/src/renderer/components/dialogs/ConsentPrompt.tsx`,
  `packages/desktop/src/renderer/island/consents/ConsentView.tsx`, вид согласий в `packages/mobile/src`
  (Inbox → Needs you), строки интерфейса.
- Поведение: список серверов с переключателем для каждого (по умолчанию выключено), показаны имя и команда/URL,
  кнопки «Включить выбранные» и «Отклонить все».
- Приёмка: тесты компонентов в desktop и mobile; снимок окна; ответ с телефона проходит через `consents.decide`
  без `pty.input`.

## Проверка всей работы

- После T4: живое окно показывает строку и метку на настоящем кэше (`latest` 0.166.0 у установленной 0.162.0);
  кнопку нажимает человек.
- После T7: сессия Claude в проекте с `.mcp.json`, запущенная с телефона, доходит до первого хода без визита к Mac.
