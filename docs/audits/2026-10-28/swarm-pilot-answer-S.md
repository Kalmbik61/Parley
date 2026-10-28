# Пилот роя: ответ, вариант S (один агент)

- Исполнитель: s-48, Claude Opus, без подагентов и без `create_session`.
- Предмет: checkout `/Users/kalmbik61/Desktop/MY/my_harnas`, HEAD `36c5f6e6665845f1e88448bba422ef53a8828b2b`, только чтение.
- Начало (`date -u`): Wed Oct 28 10:37:09 UTC 2026
- Конец (`date -u`): Wed Oct 28 10:43:09 UTC 2026

Обозначения: **Факт** — с `path:line`, перепроверен чтением. **Гипотеза** — вывод без прямого источника или поведение, которое не запускалось.

---

## Q1. Где отказывает запуск автономного плана в папке без git

**Ответ.** Явной проверки «проект — git» для автономного режима нет. Отказ возникает при первом же шаге — предложении плана ведущим (`propose_decision` в комнате `autonomous`). Хост вызывает `git rev-parse --abbrev-ref HEAD` в `projectPath`; в папке без `.git` (и без git-предка) git завершается с кодом 128, исключение `execFile` превращается в ответ `{ok:false, error:{code:"128", message:"Command failed: git … rev-parse --abbrev-ref HEAD\nfatal: not a git repository …"}}`. Агент-ведущий видит ошибку инструмента `128: Command failed: …`. Карточка предложения не создаётся, поэтому человеку нечего принимать: до Go (принятия) и до старта попыток дело не доходит. В окне никакой причины не показано (см. Q6).

**Факты.**
- Путь MCP: `propose_decision` в комнате `mode === "autonomous"` проверяет черновик локально и отправляет `action: "propose-plan"` на хост — `packages/core/src/mcp/plan-tools.ts:398-441` (проверка режима комнаты — `:403`, `sendAttemptRequest` — `:441`).
- Хост: `propose()` сначала проверяет комнату и ведущего (`packages/host/src/agent/attempts-endpoint.ts:130`, `proposalRoom` — `:102-108`), затем берёт базу: `const baseSha = await git(ref.projectPath, 'rev-parse', '--verify', '--end-of-options', \`${await baseBranchOf(ref.projectPath)}^{commit}\`)` — `packages/host/src/agent/attempts-endpoint.ts:135`.
- `baseBranchOf` — `git -c core.fsmonitor=false -C <checkoutPath> rev-parse --abbrev-ref HEAD` без перехвата ошибки — `packages/core/src/work/worktree.ts:86-91`. Это первая команда, которая падает в папке без git.
- Ошибка ловится в `perform` и превращается в `refusal`: `code` берётся из `error.code`, если он есть, `message` — из `error.message` — `packages/host/src/agent/attempts-endpoint.ts:231-235, 241-242`.
- MCP превращает `{ok:false}` в `RoomRuleError(\`${code}: ${message}\`)` — `packages/core/src/mcp/attempt-tools.ts:199-207`.
- Proposal с `plan.autonomous` (включая `integration.baseSha`) пишется только после успешного `rev-parse` — `packages/host/src/agent/attempts-endpoint.ts:144-166`. Без него нет карточки и нечего принимать; «принятие человеком — это Go» — `packages/core/src/work/guide.ts:85`.
- Переключение комнаты в режим `autonomous` git не проверяет: `set_room_mode` → `setRoomMode` — `packages/core/src/mcp/plan-tools.ts:463-488`; допустимые режимы без условий — `packages/core/src/work/rooms.ts:59`.
- Если бы план всё же существовал (папка перестала быть git после Go), движок упал бы на `initialize`: `git -C <projectPath> ls-tree <baseSha> -- .parley-tmp` (`packages/host/src/rooms/autonomous-engine.ts:275-278, 286`) и `fetch` из `projectPath` (`:292`). Любая ошибка эффекта ставит план на остановку `halt` с причиной `human` и текстом `<op.kind>: <ошибка>` — `packages/host/src/rooms/autonomous-engine.ts:245-250` (запись halt — `:249`).

**Гипотезы.**
- Точный текст: `code` будет `"128"` (у `execFile` при ненулевом выходе `error.code` — число-код выхода), сообщение — `Command failed: git -c core.fsmonitor=false -C <path> rev-parse --abbrev-ref HEAD\nfatal: not a git repository (or any of the parent directories): .git`. Формат — поведение Node `execFile`, не запускалось.
- Если git не установлен — `code` будет `ENOENT`.
- Если папка без `.git`, но лежит внутри чужого репозитория-предка, `git -C` найдёт предка вверх по дереву, и отказа не будет: движок молча возьмёт базу родительского репозитория (переменные вроде `GIT_CEILING_DIRECTORIES` не задаются — `packages/core/src/work/worktree.ts:86-91`).
- Вложенные `front/.git`, `back/.git` на исход не влияют: git ищет репозиторий только вверх от `-C`, не вниз.

**Не нашёл.** Отдельного предупреждения или сообщения «нужен git» для autonomous-режима. Просмотрено: `attempts-endpoint.ts` целиком, `autonomous-engine.ts` (git-хелперы, initialize, spawn, capture, integrate, recover, cycle), `mcp/plan-tools.ts:395-500`, `mcp/attempt-tools.ts:195-285`, grep `isGitRepo|not a git|non-git` по `packages/{core,host,protocol,desktop}/src`.

---

## Q2. Какие компоненты движка этапа 1 требуют git и для чего

**Ответ.** git нужен всему движку. Состояние попыток живёт в собственном bare-репозитории `engine.git`, наполняемом из git-проекта.

**Факты (перечень).**
| Компонент | Что делает git | Источник |
|---|---|---|
| Путь `engine.git` | bare-репозиторий движка `<.parley>/works/<workId>/engine.git`, один на пространство | `packages/host/src/agent/attempts-endpoint.ts:19-21` |
| Обёртка git движка | изолированное окружение: без глобального/системного конфига, хуков, fsmonitor, подписи | `packages/host/src/rooms/autonomous-engine.ts:197-205` |
| База плана (при предложении) | `rev-parse` ветки проекта → `baseSha`; заморозка входов проверок: `rev-parse <baseSha>:<file>`, `cat-file -t` | `packages/host/src/agent/attempts-endpoint.ts:112-127, 135, 140` |
| Инициализация (клон движка) | `init --bare`, `fetch <projectPath> <baseSha>`, `update-ref refs/heads/<integration.branch>` | `packages/host/src/rooms/autonomous-engine.ts:282-296` |
| Защита `.parley-tmp` | `ls-tree <sha> -- .parley-tmp` в проекте или в `engine.git` | `packages/host/src/rooms/autonomous-engine.ts:275-281` |
| Клон попытки | `clone --no-hardlinks --no-checkout engine.git <dir>`, `checkout --detach <baseSha>` | `packages/host/src/rooms/autonomous-engine.ts:363-373` |
| Захват (capture) | временный индекс + `GIT_WORK_TREE=клон`: `read-tree`, `add -A`, `rm --cached .parley-tmp`, `write-tree`, `commit-tree -p baseSha`, `update-ref refs/attempts/<plan>/<attempt>` | `packages/host/src/rooms/autonomous-engine.ts:421-441`, ref — `:216` |
| Восстановление захвата | `cat-file --batch-all-objects`, поиск висящего коммита по сообщению | `packages/host/src/rooms/autonomous-engine.ts:442-461` |
| Квитанция | замороженные входы `rev-parse <sha>:<path>`; `merge-base --is-ancestor baseSha sha` | `packages/host/src/rooms/autonomous-engine.ts:462-468, 517-519` |
| Артефакты | `ls-tree`, `cat-file blob` из дерева захвата | `packages/host/src/rooms/autonomous-engine.ts:482-509` |
| Брифы/ревью | `diff baseSha..sha` для исполнителя, проверяющего, ревью | `packages/host/src/rooms/autonomous-engine.ts:304, 337, 413, 789` |
| Интеграционный checkout | клон `engine.git` в `.../integration`, `checkout -b <branch> <verifiedHead>`; при повторе `merge --abort`, `reset --hard`, `clean -fdx` | `packages/host/src/rooms/autonomous-engine.ts:582, 606-631` |
| Очередь слияний | `merge-base --is-ancestor` (noop), `fetch` попытки, `merge --no-ff`, конфликт по `MERGE_HEAD`, `rev-parse HEAD`, `fetch +HEAD:refs/candidates/<plan>/<attempt>` | `packages/host/src/rooms/autonomous-engine.ts:817-856`, ref — `:217` |
| Откат | `merge --abort`, `reset --hard <sha>` | `packages/host/src/rooms/autonomous-engine.ts:634-645` |
| Финальные ворота на SHA | правило `integrate` принимает только результаты с `sha === candidateHead` и переносит `verifiedHead = candidateHead` | `packages/core/src/work/autonomous.ts:1137, 1152, 1184`; вызов — `packages/host/src/rooms/autonomous-engine.ts:899-900` |
| Зеркало в проект | `update-ref` в `engine.git` + `git -C <projectPath> fetch engine.git refs/heads/<branch>:refs/heads/<branch>` (без `+`) | `packages/host/src/rooms/autonomous-engine.ts:656-667` |
| Итоговая карточка | `verifiedHead`, ветка интеграции, путь `engine.git`, «project mirror: <projectPath> refs/heads/<branch>» | `packages/host/src/rooms/autonomous-engine.ts:756-761` |
| Сверка после перезапуска | при наличии `engine.git`: `refSha refs/heads/<branch>` против `verifiedHead` (несовпадение → halt `restart`), чтение `refs/candidates/...`, разбор коммита | `packages/host/src/rooms/autonomous-engine.ts:930-997` (ключевые — `:970-981, 986-988`) |
| Проверка вердикта | `stat(engine.git)`, `git -C engine.git merge-base --is-ancestor baseSha sha` | `packages/host/src/agent/attempts-endpoint.ts:220-222` |
| Запускатель проверок | см. Q4 | `packages/host/src/rooms/check-runner.ts:105-123` |

**Гипотезы.** Отдельной не-git ветки (копирование каталога, снимки без git) в движке нет — в просмотренном коде я её не увидел.

**Не нашёл.** Абстракции VCS или альтернативной реализации захвата. Просмотрено: `autonomous-engine.ts` (вся область с `git(`/`bare(`), `check-runner.ts` целиком, `attempts-endpoint.ts` целиком.

---

## Q3. Как определяется корень, с которым работает движок

**Ответ.** Корень — `projectPath` пространства/сессии как есть. `git rev-parse --show-toplevel` движок не вызывает, и поиск репозиториев вниз тоже не делает. Все git-команды к проекту идут через `git -C <projectPath>`, и git сам ищет `.git` вверх по дереву. Если корень — папка без `.git`, а внутри `front/.git` и `back/.git`, вызовы в `projectPath` падают с «not a git repository» (Q1). Вложенные репозитории не обнаруживаются и не используются.

**Факты.**
- Предложение плана берёт `ref.projectPath` из токена сессии — `packages/host/src/agent/attempts-endpoint.ts:135` (ref проверяется в `:270-273`).
- Движок берёт `projectPath` из снимка пространств (`works.snapshot().entries[].projectPath`) — `packages/host/src/rooms/autonomous-engine.ts:1116-1126`. Дальше `loc.projectPath` уходит в `initialize` (`:292`), зеркало (`:664`) и `ls-tree` (`:277`).
- Состояние движка (`engine.git`, клоны, проверки) лежит под каталогом состояния внутри `projectPath`: `workPaths(projectPath, workId).dir = <stateDir(projectPath)>/works/<workId>` — `packages/core/src/work/store.ts:128-129`, `packages/core/src/work/state-dir.ts:23-28`; `engine.git` — `packages/host/src/agent/attempts-endpoint.ts:20-21`.
- `baseBranchOf` / `isGitRepo` — только `git -C <path> rev-parse …` (`--abbrev-ref HEAD` / `--is-inside-work-tree`) — `packages/core/src/work/worktree.ts:73-91`.
- Для контраста: только общий контекст проекта (`resolveSharedProjectContext`, используется хранилищем — `packages/core/src/work/store.ts:1278`) явно различает `non-git` и использует `--show-toplevel` — `packages/core/src/work/project-context.ts:69-117`. «Не git» он доказывает проходом по предкам, не по потомкам: `hasNoRepositoryMarker` — `packages/core/src/work/project-context.ts:50-62`. Движок этот модуль не использует (в `autonomous-engine.ts` и `attempts-endpoint.ts` импорта нет — см. импорты `autonomous-engine.ts:7-19`, `attempts-endpoint.ts:7-16`).

**Гипотезы.**
- Если человек откроет пространство на `front/` (у которого свой `.git`), движок заработает, но только для фронта: `back/` для него вне корня.
- Если `projectPath` — подкаталог git-репозитория, `fetch`/`ls-tree`/`rev-parse` сработают на репозитории-предке. При этом `CheckSpec.cwd` считается от корня клона (`packages/core/src/work/types.ts:304`; `check-runner.ts:125`), а не от `projectPath`, так что пути в проверках разойдутся с ожиданием ведущего.

**Не нашёл.** Мест, где движок выбирает репозиторий среди вложенных или спрашивает человека, какой репозиторий взять. Просмотрено: grep `show-toplevel|rev-parse|isGitRepo|baseBranchOf` по `packages/host/src` и `packages/core/src/work`.

---

## Q4. Зависит ли запускатель проверок от git

**Ответ.** Да, напрямую. Рабочий каталог проверки — свежий git-клон `engine.git` на нужном SHA, а не папка проекта. Без `engine.git` проверка падает на `clone`. Результат в этом случае — `verdict: 'error'` с текстом ошибки git в `summary`.

**Факты.**
- Окружение git хоста без наследуемых переменных — `packages/host/src/rooms/check-runner.ts:105-107`.
- `git clone --no-hardlinks --no-checkout -- <engine.git> <checkout>` — `packages/host/src/rooms/check-runner.ts:109`; запрет alternates — `:110-112`.
- `checkout --detach <sha>`, сверка `rev-parse HEAD`, `status --porcelain` на чистоту — `packages/host/src/rooms/check-runner.ts:113-115`.
- Замороженные входы через `rev-parse <sha>:<path>` и `cat-file -t` — `packages/host/src/rooms/check-runner.ts:116-124`.
- `cwd` проверки — `spec.cwd` относительно checkout, выход за его пределы запрещён — `packages/host/src/rooms/check-runner.ts:125-126`.
- Требование формата SHA (40/64 hex) — `packages/host/src/rooms/check-runner.ts:84`.
- Любое исключение → `result.summary = error.message` при `verdict: 'error'` по умолчанию — `packages/host/src/rooms/check-runner.ts:61-65, 216-217`.
- `projectPath` используется только для `realpath`, запрета временных корней и каталога результатов — `packages/host/src/rooms/check-runner.ts:88-96`.
- Песочница — macOS `sandbox-exec` и `log show` — `packages/host/src/rooms/check-runner.ts:36-38, 73-78, 141`.

**Не нашёл.** Режима «прогнать проверку в рабочем каталоге без git». Просмотрено: `check-runner.ts` целиком.

---

## Q5. `create_session` с `worktree: true` в папке без git / с вложенными репозиториями

**Ответ.** Проверка одна: `isGitRepo(projectPath)` (`rev-parse --is-inside-work-tree` в `projectPath`). В папке без git, в том числе с вложенными `front/.git` и `back/.git`, она даёт `false`, и хост отказывает с `bad_request` «the project has no git — a worktree cannot be created» ещё до записи сессии в карту. Запасного пути нет: worktree не создаётся во вложенном репозитории, и сессия без worktree тоже не создаётся — отказ целиком. Агент видит ошибку инструмента `bad_request: the project has no git — a worktree cannot be created`.

**Факты.**
- Схема инструмента: `worktree: { type: 'boolean', description: 'Own git worktree; git projects only.' }` — `packages/core/src/mcp/session-tools.ts:16`.
- Эндпоинт агента пропускает `worktree` в `options.create` — `packages/host/src/agent/session-endpoint.ts:40, 45, 56`; ошибка → `{ok:false, error:{code, message}}` — `:60`.
- Проверка до создания записи: `if (worktree === true && !(await timer.step('git', () => isGitRepo(projectPath)))) throw new HostError('bad_request', 'the project has no git — a worktree cannot be created')` — `packages/host/src/sessions/sessions-service.ts:1088-1091`.
- `HostError` несёт `code` — `packages/host/src/errors.ts:9-15`.
- `isGitRepo` — `rev-parse --is-inside-work-tree`, любая ошибка → `false` — `packages/core/src/work/worktree.ts:72-80`.
- MCP-клиент выводит `${code}: ${message}` как ошибку инструмента — `packages/core/src/mcp/session-tools.ts:58-59`.
- Сам worktree создаётся `git -C <projectPath> worktree add` — `packages/core/src/work/worktree.ts:98-113`; путь — `<root>/<basename(projectPath)>-<hash>/<workId>-<sessionId>` — `:55-70`.
- `worktrees.available` для окна — то же `isGitRepo(projectPath)` — `packages/host/src/worktrees/worktrees-service.ts:146`.

**Гипотезы.** Если папка без `.git` лежит внутри репозитория-предка, `isGitRepo` даст `true`, и worktree будет создан от репозитория-предка — не от `front/` или `back/`.

**Не нашёл.** Запасного пути (выбор вложенного репозитория, деградация до сессии без worktree) — его нет. Просмотрено: `sessions-service.ts:1050-1130`, `session-endpoint.ts:30-62`, `session-tools.ts` (1-60), `worktree.ts:1-113`, `worktrees-service.ts:120-215`.

---

## Q6. Что окно показывает или блокирует для автономного режима в проекте без git

**Ответ.** Для автономного режима — ничего специального. Режим `Autonomous` доступен в селекторе режима комнаты и в диалоге новой комнаты без учёта git. Отказ при предложении плана (Q1) получает агент, а не окно: карточка не появляется, и человек видит только то, что ведущий напишет в комнате. Если план остановлен (`halted`), окно показывает `HaltCard` с сырым `detail`. git-специфичные блокировки в окне есть только для worktree и вкладки «Изменения».

**Факты.**
- Строки режима: `modes.autonomous: 'Autonomous'`, `modeHelp.autonomous: 'The engine runs attempts after Go; the human accepts the result'` — `packages/desktop/src/shared/strings.ts:55-56`. Упоминания git нет.
- Селектор режима комнаты перечисляет все четыре режима без условий; блокировка только по `rooms.setMode`/busy/архиву — `packages/desktop/src/renderer/components/rooms/PlanPanel.tsx:148-210` (опции — `:205`, `disabled` — `:194`).
- Диалог новой комнаты: список режимов `MODES` с `autonomous` — `packages/desktop/src/renderer/components/dialogs/agent-rows.ts:51-52`; рендер без условий — `packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.tsx:637-641`.
- Остановка: `S.plans.halted = 'Execution stopped'`, `haltReason`, `haltNotice` — `packages/desktop/src/shared/strings.ts:64-66`; `HaltCard` выводит `halted.detail` как есть и кнопку `Continue` (`plans.resumeAutonomous`) — `packages/desktop/src/renderer/components/rooms/HaltCard.tsx:8-30`; бейдж в селекторе — `PlanPanel.tsx:213`.
- worktree: флажок неактивен, пока `worktrees.available` не вернёт `true` — `packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.tsx:276, 616-617`; подсказка `S.recipes.noWorktree = 'This project is not a Git repository, so agents share the project folder.'` — `packages/desktop/src/shared/strings.ts:325`, показ — `NewSessionOrRoomDialog.tsx:653`; то же в `NewWorkComposer.tsx:240, 598`; построчно — `AgentRowsEditor.tsx:284`.
- Вкладка «Изменения»: `S.changes.notARepo = 'This folder is not a git repository'` — `packages/desktop/src/shared/strings.ts:1334`, выбор по причине `not-a-repo` — `packages/desktop/src/renderer/review/state.ts:92`, код причины — `packages/protocol/src/types.ts:287`.
- Подсказка «Own worktree … Needs a Git repository.» — `packages/desktop/src/shared/strings.ts:906`.

**Гипотезы.** Человек в проекте без git может выбрать Autonomous и не получить ни предупреждения, ни карточки. Единственный сигнал — текст ведущего с `128: Command failed …` в комнате, если ведущий его перескажет.

**Не нашёл.** Строк или компонентов о git для autonomous/verified-плана. Просмотрено: grep `autonom|engine|halt|git` по `strings.ts`; grep `autonomous` по `packages/desktop/src/{renderer,main,shared}` (без тестов); `HaltCard.tsx`, `PlanPanel.tsx:135-230`.

---

## Q7. Тесты на «проект не git» и «несколько репозиториев»

**Ответ.**
- **Движок, попытки, запускатель проверок** — нет: все фикстуры начинаются с `git init`.
- **worktree** — «не git» покрыт (`isGitRepo`, `sessions.create`, `worktrees.available`/`not-a-repo`). «Несколько репозиториев» покрыт только как неотслеживаемый вложенный репозиторий внутри git-проекта, для диффа, а не как корень без git.
- **Окно** — «не git» покрыт только для флажка worktree, подсказки рецепта и вкладки «Изменения»; для autonomous — нет.

**Факты.**
- Фикстуры движка с `git init -b main`: `packages/host/src/rooms/autonomous-engine.test.ts:34`, `packages/host/src/rooms/autonomous-cycle.test.ts:44`, `packages/host/src/rooms/check-runner.test.ts:67`, `packages/host/src/agent/attempts-endpoint.test.ts:42`. grep `not a git|no git|non-git|nested|front` по этим файлам и по `core/src/work/autonomous.test.ts`, `core/src/mcp/plan-tools.test.ts` совпадений по теме не дал (единственное `nested` в `check-runner.test.ts:176` — о песочнице Codex).
- `isGitRepo`: «не git — false, после init — true» — `packages/core/src/work/worktree.test.ts:182-186`.
- Вложенный репозиторий: блок «вложенный репозиторий и каталог состояния в worktree» — `packages/core/src/work/worktree.test.ts:780-800` (неотслеживаемый `nested/` в git-проекте и в worktree — один элемент диффа, не падает).
- `sessions.create({ worktree: true })` в проекте без git — `bad_request` с текстом, записей нет — `packages/host/src/sessions/sessions-service.test.ts:1377-1395`.
- `worktrees.available`: «git-проект — true, обычный каталог — false» — `packages/host/src/worktrees/worktrees-service.test.ts:110`; «папка не под git — bad_request с причиной not-a-repo» — `:379`; коды `git-missing`/`not-a-repo`/`no-commits` — `:395`.
- Эндпоинт агента: передача `worktree: true`, отказ на `worktree: 'yes'` — `packages/host/src/agent/session-endpoint.test.ts:33-35, 56`. Случая «без git» здесь нет.
- Общий контекст проекта: доказательство non-Git, вложенные папки в git-checkout — `packages/core/src/work/project-context.test.ts:29-48, 60-80`.
- Окно: флажок worktree неактивен в не-git проекте — `packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.test.tsx:795-799`; подсказка «This project is not a Git repository…» — `:1457-1461`; «Изменения» `not-a-repo` — `packages/desktop/src/renderer/review/ChangesPanel.test.tsx:484`, `packages/desktop/src/renderer/review/state.test.ts:147-151`.
- Ветка через `gitdir:` (worktree/субмодуль) — `packages/core/src/git.test.ts:47`.

**Не нашёл.** Тестов «autonomous в проекте без git», «propose-plan без git», «движок/проверки при нескольких репозиториях», «окно: autonomous без git». Просмотрено: grep `not a git|has no git|non-git|nonGit|isGitRepo|notARepo|noWorktree|no-git` по всем `*.test.ts(x)` в `packages` (кроме `dist/out/node_modules`) — 8 файлов, перечислены выше; плюс точечный grep по 6 тестам движка/планов.

---

## Q8. Где предполагается ровно один репозиторий на пространство

**Ответ.** Модель данных и движок построены вокруг одного репозитория. Для «фронт + бэк в двух git в одной папке» придётся менять перечисленные места: либо делать всё по репозиторию (массивы баз, веток, `engine.git`), либо вводить сводный репозиторий.

**Факты (места).**
1. **Один `engine.git` на пространство:** `attemptsEngineGitPath(projectPath, workId)` → `.../works/<workId>/engine.git` — `packages/host/src/agent/attempts-endpoint.ts:20-21`. Его используют движок (`autonomous-engine.ts:205, 291, 369, 611, 664, 840`), запускатель (`check-runner.ts:109`) и проверка вердикта (`attempts-endpoint.ts:220-222`).
2. **Одна база плана:** `baseSha` из `baseBranchOf(ref.projectPath)` — `packages/host/src/agent/attempts-endpoint.ts:135`; заморозка входов в одном репозитории — `:112-127`.
3. **Одна интеграционная ветка и одна голова:** `integration: { branch: 'parley/<workId>/integration/<planId>', baseSha, verifiedHead, candidateHead, queue, suspended }` — `packages/host/src/agent/attempts-endpoint.ts:164`; тип `Integration` (один `branch`/`baseSha`/`verifiedHead`/`candidateHead`) — `packages/core/src/work/types.ts:322-329`; `AutonomousPlan.integration` — `:252`; проверка карты — `packages/core/src/work/map.ts:409`.
4. **Одна попытка — один коммит:** `PlanAttempt.branch/baseSha/sha/tree` — `packages/core/src/work/types.ts:266-268`; правило старта требует `baseSha === integration.verifiedHead` — `packages/core/src/work/autonomous.ts:699`; движок даёт `branch: attempts/<id>` — `packages/host/src/rooms/autonomous-engine.ts:1083`.
5. **Один корень попытки:** клон в `.../attempts/<id>/clone` — `packages/host/src/rooms/autonomous-engine.ts:191-192, 363-373`; сессия исполнителя получает `workspace: {kind:'clone', path, branch, sha}` (одно значение) — `:383`; валидация `workspace` в сервисе сессий — `packages/host/src/sessions/sessions-service.ts:1055`.
6. **Один захват:** `GIT_WORK_TREE=клон`, один `write-tree`/`commit-tree` — `packages/host/src/rooms/autonomous-engine.ts:428-438`.
7. **Один интеграционный каталог и одна очередь слияний:** `integrationDirectory` — `packages/host/src/rooms/autonomous-engine.ts:582`; `integrateQueue` и `refs/candidates/<plan>/<attempt>` — `:817-856, 217`.
8. **Одна проверка — один checkout:** `CheckSpec.cwd` «относительно checkout» — `packages/core/src/work/types.ts:304`; черновик проверки `{argv, cwd, inputs…}` — `:215`; в запускателе один клон и один SHA — `packages/host/src/rooms/check-runner.ts:109-126`.
9. **Одно зеркало в проект:** `git -C <projectPath> fetch … refs/heads/<branch>` — `packages/host/src/rooms/autonomous-engine.ts:656-667`; итоговая карточка с одним `verifiedHead` и одной веткой — `:756-761`.
10. **Одна сверка после перезапуска:** одна ветка и один `candidateRef` — `packages/host/src/rooms/autonomous-engine.ts:968-981`; правило `reconcileAfterRestart` с одним `integrationHead` — `packages/core/src/work/autonomous.ts:1342-1391`.
11. **Одна SHA-цель для проверяющего:** `attempt_verify(attemptId, sha, …)`, ожидание `attempt.sha` или `candidateHead` — `packages/host/src/agent/attempts-endpoint.ts:218-219`; формат SHA в MCP — `packages/core/src/mcp/attempt-tools.ts:377-387`.
12. **worktree сессии — от одного `projectPath`:** `isGitRepo(projectPath)` — `packages/host/src/sessions/sessions-service.ts:1089`; `git -C <projectPath> worktree add` — `packages/core/src/work/worktree.ts:98-113`; план пути и ветки на сессию один — `:55-70`; `worktrees.available(projectPath)` — `packages/host/src/worktrees/worktrees-service.ts:146`.
13. **Окно:** один флажок `worktrees.available` на проект — `packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.tsx:276`; одна «Изменения» по `projectPath` — `packages/desktop/src/renderer/review/state.ts:86-92`.

**Гипотезы.**
- Самый дешёвый путь без переделки модели — вести каждый репозиторий как отдельное пространство (`front/`, `back/`). Межрепозиторные пункты плана тогда невозможны, нужна координация через комнаты разных пространств. Не проверял, умеет ли Parley комнаты между пространствами.
- Путь «один сводный репозиторий» (движок сам собирает `front`+`back` в один `engine.git`, например через subtree) сохранил бы пункты 3–11. Но потребует нового `initialize` (`autonomous-engine.ts:282-296`), нового зеркала (`:656-667`) и новой базы (`attempts-endpoint.ts:135`).
- Путь «по репозиторию» затрагивает все 13 пунктов и типы `Integration`/`PlanAttempt`/`CheckSpec` с проверкой карты (`map.ts:389, 409`).

**Не нашёл.** Ни одного места, где движок или worktree работает со списком репозиториев. Просмотрено: см. Q2–Q5 и grep `baseSha|engine.git|refs/candidates` по `packages/{core,host,protocol}/src`.
