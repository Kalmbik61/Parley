# Пилот роя: ответ R (рой)

- Предмет: код Parley на коммите `36c5f6e6`, только чтение. Протокол: `docs/audits/2026-10-28/swarm-pilot-protocol.md`.
- Старт: `Wed Oct 28 10:37:10 UTC 2026` (`date -u`, до нарезки).
- Перезапуск читателей (по указанию s-38, время R считается от него): `Wed Oct 28 10:48:16 UTC 2026` (создание s-53 по карте; `date -u` королевы перед созданием — 10:47:43).
- Конец: `Wed Oct 28 10:57:50 UTC 2026`.
- Состав роя:
  - королева — s-47 (Claude Opus), сборщик;
  - читатели, первая волна (сломаны, см. журнал) — s-49, s-50, s-51, s-52 (Claude Haiku, роль `builtin:researcher`);
  - читатели, рабочая волна — s-53 (срез 1), s-54 (срез 2), s-55 (срез 3), s-56 (срез 4) (Claude Haiku, без роли, бриф «ТОЛЬКО ЧТЕНИЕ»);
  - проверяющие — s-57 (утверждения E1–E48), s-58 (утверждения W1–W40) (Sonnet на `custom-claude-2`, без роли, бриф «ТОЛЬКО ЧТЕНИЕ»).
- Пометки у утверждений: **[E<n>]/[W<n>]** — номер в реестре, подтверждено проверяющим; **[O<n>]** — нашёл проверяющий, отвечая на открытый вопрос; второй независимой проверки не было, поэтому это гипотеза с источником. Опровергнутые утверждения ниже даны только в исправленном виде.
- Сокращения путей: `AE` = `packages/host/src/rooms/autonomous-engine.ts`, `AEP` = `packages/host/src/agent/attempts-endpoint.ts`, `CR` = `packages/host/src/rooms/check-runner.ts`, `CA` = `packages/core/src/work/autonomous.ts`, `WT` = `packages/core/src/work/worktree.ts`, `WS` = `packages/host/src/worktrees/worktrees-service.ts`, `SS` = `packages/host/src/sessions/sessions-service.ts`, `ST` = `packages/core/src/mcp/session-tools.ts`, `STR` = `packages/desktop/src/shared/strings.ts`, `RC` = `packages/desktop/src/renderer/components/rooms/`.

## Короткий вывод

В папке без git автономный план отказывает уже при **предложении** плана. `AEP` propose берёт базу через `baseBranchOf(projectPath)`, то есть через `git rev-parse` в корне проекта. Проверки «это репозиторий» на этом пути нет, git падает, и ответ возвращается как отказ `{ok:false}`. До Go и попыток дело не доходит. Окно автономный режим не блокирует. Весь движок (`engine.git`, клоны попыток, `refs/candidates`, интеграция, проверки) держится на одном `projectPath`, одном base SHA и одной интеграционной ветке на план. Два вложенных `.git` код не видит нигде. Тестов на «проект не git» для движка и окна нет. Для worktree такие тесты есть.

## Q1. Отказ автономного плана в папке без git

Ответ: явной проверки «не git» на пути «предложение → Go → попытки» нет. Ломается первый вызов git в корне проекта при предложении плана. Ошибка git превращается в отказ хоста, и план не записывается.

Утверждения:
- Предложение плана через MCP (`propose-plan`): `validateAutonomousDraft` (`packages/core/src/mcp/plan-tools.ts:429`), затем `sendAttemptRequest` (`plan-tools.ts:441`). Git в этом пути не трогается [E30]. `validateAutonomousDraft` (`packages/core/src/work/plans.ts:214-225`) git тоже не трогает, а `cwd` проверяет только как непустой текст (`plans.ts:275`) [E31].
- На хосте `propose()` (`AEP:128`) на `AEP:135` вызывает `git(ref.projectPath, 'rev-parse', ...)` с аргументом `await baseBranchOf(ref.projectPath)`. Проверки `isGitRepo` перед этим нет [E23].
- `baseBranchOf` (`WT:86-93`) выполняет `git -C <path> rev-parse --abbrev-ref HEAD` без catch [E25]. Помощник `git()` в `AEP:109-111` тоже без try/catch [E24].
- В `perform()` (`AEP:236-243`) исключение уходит в `refusal(error)`, а `updateMap` на `AEP:144` не достигается. План не записывается [E26].
- Код отказа (`AEP:231-235`): `PlanConflictError` → `'conflict'`; ошибка с полем `code` → `String(error.code)`; иначе `message`, если он входит в список правил (`attempt-fenced`, `handoff-conflict`, `stale-criteria`, `bad-sha`, `attempt-not-running`, `attempt-not-checkable`); иначе `'bad_request'`. `message = error.message` [E27, исправлено проверяющим].
- Форма ответа — HTTP 200 и `{ok:false,error:{code,message}}` (`AEP:251`, та же на `AEP:277`) [E28].
- `isGitRepo` (`WT:73-81`) в не-тестовом коде вызывают только `SS:1089` и `WS:146`. На пути плана и движка её нет [E29].
- Go (`resolveAutonomousProposal`, `AE:94-110`) к git не обращается [E32]. `active()` (`AE:58`) смотрит на `acceptedAt !== null` и статус active/completing, git не проверяет [E33]. `start()` (`AE:1116-1130`) выходит рано только при `off || stopped || !options.works` (`AE:1117`) [E34, исправлено проверяющим]. Единственная проверка в `cycle` — провайдер исполнителя `'codex' | 'claude'`, иначе halt `'confinement'` (`AE:1013-1015`) [E35].
- Если план всё же принят (например, git пропал после предложения), первый вызов git в проекте при инициализации — `git -C loc.projectPath ls-tree <sha> -- .parley-tmp` (`AE:277`). Его вызывает `initialize` на `AE:286` [E16], а `initialize` вызывается из `cycle` на `AE:1051` [E4].
- `effect()` (`AE:232-255`) при исключении пишет `settled(op,'failed')` (`AE:248`). Затем, если ошибка не `integration-conflict` (`AE:249`), делает halt плана с причиной: при отмене `'human'`; при `confinement-unavailable` `'confinement'`; при совпадении с `/resource|limit|budget|denied/i` `'budget'`; иначе `'human'`. `detail` = `` `${op.kind}: ${текст ошибки}` `` [E20, уточнено проверяющим].

Гипотезы:
- [O1, s-57] Клиент `sendAttemptRequest` (`packages/core/src/mcp/attempt-tools.ts:221-267`) на `{ok:false}` вызывает `attemptResult` (`attempt-tools.ts:199-207`), а тот бросает `RoomRuleError` с текстом `` `${code}: ${message}` ``. Агент увидит примерно `128: Command failed: git -c core.fsmonitor=false -C <path> rev-parse --abbrev-ref HEAD\nfatal: not a git repository ...`. Код `128` и текст `fatal:` взяты из поведения git и Node, в репозитории их нет.
- [O2, s-57] Сбой на `AE:277` происходит до `intend/effect`, вне `effect()`. Поэтому halt не наступает: исключение идёт `initialize → cycle → schedule()` (`AE:1110-1113`) → `options.onFailure` (`packages/host/src/host.ts:398`, `log.error 'autonomous engine failed'`). Опрос раз в 1 с (`AE:1127`) повторяет попытку. План не halted, в окне сбоя не видно. Сбой `fetch` на `AE:292` уже внутри `effect`, он дал бы halt с `detail` `clone: …`.
- В папке «`front/` + `back/`, корень не репозиторий» отказ будет тот же, что выше, на `AEP:135`: вложенные `.git` никто не смотрит (см. Q3).
- Если папка без `.git` лежит внутри чужого репозитория, git найдёт его обходом вверх, и предложение пройдёт против его HEAD. Это поведение git, кодом не проверено.

Не нашёл: текста отказа вида «not a git repository» или «project is not a git repository» на пути плана. Просмотрено: `AEP` (целиком), `plan-tools.ts`, `attempt-tools.ts`, `plans.ts`, `packages/protocol/src/plan-actions.ts`, `packages/host/src/rooms/plan-effects.ts` (целиком), `packages/host/src/methods/rooms.ts:100-203`, `AE` (точки входа), `CA:679-700`.

## Q2. Что в движке этапа 1 требует git

Ответ: всё, кроме модели состояния в `CA`. Ниже перечень.

Утверждения:
- `engine.git`: путь `attemptsEngineGitPath` = `workPaths(projectPath, workId).dir/engine.git` (`AEP:20-21`) [E2]. Создаётся `git init --bare` (`AE:291`) [E1].
- Захват базы в `engine.git`: `fetch` base SHA из `loc.projectPath` (`AE:292`) и `update-ref refs/heads/<integration.branch>` (`AE:293`) [E3]. Перед этим `ls-tree` в проекте (`AE:277`, из `AE:286`) [E16].
- Клон попытки: `git clone --no-hardlinks --no-checkout` из `engine.git`, затем `checkout --detach baseSha` (`AE:369-370`) [E5].
- Захват результата попытки: `read-tree` (`AE:431`), `commit-tree` (`AE:436`), `update-ref refs/attempts/...` (`AE:437`); помощник ref — `AE:214` [E6].
- `refs/candidates/<plan>/<attempt>`: помощник на `AE:215`, `fetch +HEAD:` в него на `AE:848`, чтение при сверке после перезапуска на `AE:976` [E7].
- Очередь слияний: `integrationCheckout` (`AE:606`) клонирует `engine.git` (`AE:611`) и делает `checkout -b <branch> verifiedHead` (`AE:612`); слияние — `fetch sha` (`AE:840`) и `merge --no-ff` (`AE:841`) [E8]. Вхождение проверяется через `merge-base --is-ancestor` (`AE:519`, `AE:827`) [E9].
- Финальные ворота и верификатор: diff `verifiedHead..sha` через `engine.git` (`AE:789`); diff в `prepareReview` (`AE:337`) [E10].
- Сверка после перезапуска: `rev-parse HEAD` в каталоге интеграции (`AE:847`), вызов `reconcileAfterRestart` (`AE:986`), `refSha(candidateRef)` (`AE:976`) [E7, E11].
- Зеркало в проект: `update-ref` в `engine.git` (`AE:662`) и `git -C loc.projectPath fetch` в `refs/heads/<branch>` проекта (`AE:664`) [E12].
- Проверки: клон из `engine.git` (`CR:109`), `checkout --detach`, сверка HEAD и `status --porcelain` (`CR:113-115`), frozen inputs через `rev-parse <sha>:<path>` и `cat-file -t` (`CR:117-123`) [E39–E41].
- База при предложении: `rev-parse` в проекте (`AEP:135`) и `freezeChecks` по входам на base SHA (`AEP:112-125`, ошибка «Frozen input is not a file on the base commit» на `AEP:122`; catch там глотает любую ошибку git) [E23, E38].
- `CA` git не вызывает (нет `execFile`/`spawn`/`rev-parse`), только хранит SHA [E13]. `startAttempt` требует `input.baseSha === integration.verifiedHead`, иначе `'invalid attempt base or branch'` (`CA:699-700`) [E21].

Гипотезы: нет.
Не нашёл: —.

## Q3. Как определяется корень

Ответ: корень — это `projectPath` записи работы (строка). Движок его не вычисляет и не нормализует до корня репозитория. `git rev-parse --show-toplevel` нигде на этом пути не вызывается. Git адресуется явно через `-C loc.projectPath` или `--git-dir=<engine.git>`. Если в корне нет `.git`, а `.git` есть во вложенных папках, первый же вызов git в корне падает. Вложенные репозитории не выбираются.

Утверждения:
- Тип `Location {projectPath, workId, planId}` (`AE:80`): корень приходит в движок готовым [E14]. `projectPath` берётся из записи работы, `work.projectPath` (`works-service.ts:243`, `:269`). Движок получает works-сервис в `packages/host/src/host.ts:397`, сервис создан в `host.ts:263` [E19]. Поле `projectPath: string` у работы: `packages/core/src/work/works.ts:16-18`, `:37-38` [W12].
- Git запускается `exec('git', args, {...options})` без `cwd`, в `options` только env (`AE:44-50`, вызов на `AE:48`) [E15].
- Состояние движка лежит под `workPaths(projectPath, workId).dir` (`AE:191-192`, `199`, `582`), где `workPaths = stateDir(projectPath)/works/<workId>` (`packages/core/src/work/store.ts:128-129`) [E17].
- В импортах `AE:1-19` нет `git.ts` и `worktree.ts`, в `AE` нет `--show-toplevel` и `isGitRepo` [E18]. В `WT`, `WS`, `SS`, `packages/core/src/work/launch.ts`, `packages/core/src/git.ts`, `AE` нет `--show-toplevel`. Используются `--is-inside-work-tree` (`WT:75`, `368`), `--git-common-dir` (`WT:490`), `--show-prefix` (`WT:740`), `--abbrev-ref HEAD` (`WT:87`) [W13]. По примечанию s-58, `--show-toplevel` есть в `project-context.ts:96` и `capabilities/snapshot.ts:80`, но к движку и worktree они не относятся.
- `isGitRepo` (`WT:73-80`): `git -C projectPath rev-parse --is-inside-work-tree`, `true` только при stdout `'true'`, любой сбой → `false` [W4].
- `readHead`/`gitBranch` в `packages/core/src/git.ts:28-45`, `52-58` читают только `<projectPath>/.git/HEAD` или файл `gitdir:`, без обхода вверх, иначе `null` [W14]. Это расходится с `isGitRepo`, которая через git поднимается вверх.
- Worktree-слой работает с одним репозиторием в `projectPath`: `projectCommonDir` (`WT:489-492`), `checkoutGitDir` (`WT:505-524`), `fsck --connectivity-only` (`WT:571-577`), `pinnedCheckout` → `GitStateError('worktree-corrupt', ...)` (`WT:587-595`) [W15].

Гипотезы:
- Корень без `.git` с `front/.git` и `back/.git`: `isGitRepo` → `false`, `baseBranchOf` и `AEP:135` падают, `AE:277` и `AE:664` упали бы тоже. Ни один вложенный репозиторий не берётся. Вывод из кода, запуском не проверено.
- [O4, s-58] Если корень лежит внутри чужого репозитория, `isGitRepo` → `true` намеренно (комментарий `WT:72`: «Проект (или его подкаталог) внутри рабочего дерева git»), а worktree создаётся для всего внешнего репозитория. Подкаталог частично учтён в diff и merge (`projectPrefix` `WT:739-741`, `isDirty` `WT:834`, `mergeWorktree` `WT:1038`, `--relative` `WT:911`), но не при запуске агента (`launch.ts:239`).

Не нашёл: место, где движок сам выбирает или проверяет корень репозитория. Просмотрено: `AE`, `CA` (выборочно), `git.ts` (целиком), `AEP`, `host.ts` (срез), `store.ts:127-137`, `works.ts:10-45`.

## Q4. Зависит ли запускатель проверок от git

Ответ: да, от git, но от `engine.git`, а не от репозитория проекта. Из папки проекта берётся только `realpath` и проверка «не во временном корне». Каталог проверок — клон `engine.git` на точном SHA. Косвенно проверки зависят от git проекта, потому что `engine.git` наполняется `fetch` из проекта (`AE:292`).

Утверждения:
- Клон из `attemptsEngineGitPath(project, ctx.workId)` (`CR:109`), не из папки проекта [E39].
- `checkout --detach <sha>`, сверка HEAD, пустой `status --porcelain`, иначе исключения `'checkout-sha-mismatch'`/`'checkout-not-clean'` (`CR:113-115`) [E40].
- Frozen inputs: `rev-parse <sha>:<path>` и `cat-file -t`, при расхождении `frozen-inputs-changed: ...` (`CR:117-123`) [E41].
- SHA должен быть 40 или 64 hex, иначе `'invalid-check'` (`CR:84`) [E42].
- Из папки проекта: только `realpath(projectPath)` и запрет `'check-directory-in-temporary-root'` (`CR:88-92`) [E45].
- Каталог проверок: `workPaths(project).dir/autonomous/<plan>/attempts/<attempt>/checks/<specDirectory(spec.id)>`, результат в подкаталоге `ctx.resultId` (`CR:93-96`) [E46, уточнено].
- `cwd = realpath(checkout/spec.cwd)`, должен быть внутри checkout, иначе `'cwd-outside-checkout'` (`CR:125-126`) [E43]. Запуск: `sandbox-exec -f <profile> ...spec.argv` с этим `cwd` (`CR:141-142`) [E44].
- Любое исключение (например, сбой clone без `engine.git`) → `summary = error.message`, verdict `'error'` по умолчанию (`CR:216-217`, `CR:63`) [E47].

Гипотезы: нет.
Не нашёл: —.

## Q5. `create_session` с `worktree: true`

Ответ: в папке без git сессия не создаётся. Хост проверяет `isGitRepo(projectPath)` до создания записи и отказывает с `bad_request`. Запасного пути (запуска без worktree) нет. В папке с вложенными репозиториями поведение то же, потому что проверяется только сам `projectPath`. Если сбой случился уже при создании worktree перед запуском, приходит уведомление `launch-failed`.

Утверждения:
- В схеме MCP описание `worktree`: `'Own git worktree; git projects only.'` (`ST:16`) [W1]. Аргументы уходят как есть: `POST /agent/sessions`, `body: JSON.stringify(args)` (`ST:36-39`) [W2]. Поле `worktree?: boolean` в `CreateSessionInput` (`SS:124-125`) [W6].
- `SS:1089-1091`: `if (worktree === true && !(await isGitRepo(projectPath))) throw new HostError('bad_request', 'the project has no git — a worktree cannot be created')`. Комментарий на `SS:1088`: проверка стоит до создания, чтобы в карте не осталась pending-сессия. Запасного пути нет [W3].
- `isGitRepo` проверяет только `projectPath` (`WT:73-80`), вложенные папки не смотрит [W4].
- Ветки ответа MCP: при не-200 у 401 и 404 свои тексты, остальным — «Parley's host refused the request (HTTP ${status}). Check get_map before retrying: the host may already have created the session.» (`ST:46-48`); при HTTP 200 и `ok === false` — `` `${code}: ${message}` `` (`ST:58-59`) [W5].
- Если git есть: `base = baseBranchOf(ref.projectPath)` (`SS:1011`), `plannedWorktree(..., config.worktreeRoot)` (`SS:1016-1022`) [W7]. Путь `<root>/<basename проекта>-<хеш6>/<workId>-<sessionId>`, ветка `BRANCH_PREFIX<workId>/<sessionId>` (`WT:55-70`, хеш `WT:62-63`) [W8]. `createWorktree`: `git -C projectPath worktree add -b <branch> --end-of-options <path> <base>` (`WT:98-113`) [W9].
- Создание перед первым запуском (`SS:679-682`; про resume сказано в комментарии `SS:676-678`). При сбое: `host.notice` kind `'launch-failed'` с текстом `` `worktree for ${tag} was not created: ${message}` ``, письмо SYSTEM родителю, `throw` (`SS:683-706`) [W10].
- `cwd` сессии: `session.workspace?.path ?? session.worktree?.path ?? projectPath` (`launch.ts:239`) [W11].

Гипотезы:
- [O3, s-58] `packages/host/src/agent/session-endpoint.ts:59-60` отвечает `{ok:false,error:{code,message}}`, а `reply()` (`:15-18`) всегда ставит HTTP 200. `HostError` несёт `code` (`packages/host/src/errors.ts:9-18`). Значит, агент видит ветку `ST:58-59`: `bad_request: the project has no git — a worktree cannot be created`. Ветка `ST:48` срабатывает только для 401/413.
- [O4, s-58] Проект-подкаталог чужого репозитория: проверка проходит, worktree создаётся от корня внешнего репозитория, и `cwd` агента — корень worktree, а не соответствующий подкаталог. Отказа «корень репозитория ≠ projectPath» в коде нет.
- Текст отказа про папку `front/ + back/` не говорит, что внутри есть репозитории. Агент не узнает причину из сообщения.

Не нашёл: запасного пути (создать сессию без worktree) и обработки вложенных `.git`. Просмотрено: `WT` (выборочно 1–113, 287–379, 484–595, 727–745, 1024–1076), `WS` (целиком), `packages/host/src/methods/worktrees.ts` (целиком), `ST` (целиком), `SS` (выборочно), `git.ts`, `launch.ts` (выборочно).

## Q6. Что показывает окно

Ответ: окно автономный режим и verified-план в проекте без git не блокирует и не предупреждает. Признак «не git» (`worktrees.available`) окно получает только в диалоге новой сессии или комнаты и в составителе работы. Он влияет на флажок worktree, а не на панель плана. Остановка плана показывается по причинам из закрытого перечня, причины «не git» там нет.

Утверждения:
- Подсказка режима autonomous: «The engine runs attempts after Go; the human accepts the result» (`STR:56`), без git [W20].
- `select` режимов `free/checklist/verified/autonomous` без условия по git (`RC/PlanPanel.tsx:205-206`) [W21].
- `cwd` чипа роли владельца пункта плана (не карточки попытки): `session.worktree?.path ?? entry.projectPath` (`RC/PlanPanel.tsx:344`, внутри `RC/PlanPanel.tsx:335-345`) [W22, исправлено проверяющим].
- Причины остановки `haltReason: { budget, no_progress, stuck, restart, confinement }` (`STR:65`) [W23, исправлено: строка 65, не 63]. `HaltCard` выводит причину через `S.plans.haltReason[halted.reason]` (кроме `'human'`) и `halted.detail` как есть (`RC/HaltCard.tsx:19-20`) [W24]. Значок «Execution stopped» показывается только при `plan.autonomous?.halted` (`RC/PlanChip.tsx:93-95`) [W25].
- Строки про git: `noWorktree` «This project is not a Git repository, so agents share the project folder.» (`STR:325`). Показывается в `packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.tsx:653` при `multi && !worktreeAvailable && agents.some(row => row.worktree === true)` [W27]. Подсказка worktree «… Needs a Git repository.» (`STR:906`) [W28]. `notARepo` «This folder is not a git repository» (`STR:1334`) используется только во вкладке изменений, `packages/desktop/src/renderer/review/state.ts:92` [W29]. Общее уведомление `'git-connectivity-failed'` (`STR:2718`) [W26].
- Откуда признак: `bridge.call('worktrees.available', { projectPath })` → `setWorktreeAvailable` (`NewSessionOrRoomDialog.tsx:276-277`), так же в `packages/desktop/src/renderer/sidebar/NewWorkComposer.tsx:240` [W30]. Протокол: вход `{ projectPath }` (`packages/protocol/src/methods.ts:279`), выход `{ available: boolean }` (`methods.ts:469`) [W31]. Хост: `available: isGitRepo(projectPath)` (`WS:146`) [W16]; обработчик `worktreesAvailable` (`packages/host/src/methods/worktrees.ts:25-26`) [W19].
- В `RC/PlanPanel.tsx`, `RoomPanel.tsx`, `HaltCard.tsx`, `CompletionCard.tsx` нет `worktrees.available`/`worktreeAvailable` [W32].

Гипотезы:
- Предложение плана в не-git проекте отказывает у агента (Q1). Окно ничего не показывает: плана нет, карточки нет. Если план принят и сломался на `AE:277`, по [O2] halt не наступает, и окно тоже молчит.
- Номера строк `STR` даны на `36c5f6e6`. В текущем рабочем дереве (ветка `feat/archived-sleep-emoji`) строки после 470 сдвинуты на +2.

Не нашёл: блокировки или предупреждения «не git» в панели плана. Просмотрено: `STR` (блоки 49–75, 320–326, 906, 1334–1336, 2683–2718), `RC/PlanPanel.tsx`, `HaltCard.tsx`, `PlanChip.tsx`, `RoomPanel.tsx` и `CompletionCard.tsx` (по grep), `NewSessionOrRoomDialog.tsx`, `NewWorkComposer.tsx:240`.

## Q7. Тесты

Ответ: «проект не git» покрыт только для слоя worktree и `gitBranch`. Для движка, проверок, предложения плана и окна — нет. «Несколько репозиториев» не покрыто нигде. Есть тесты на вложенный репозиторий внутри git-проекта (worktree) и на расхождение `engine.git` с репозиторием проекта.

Утверждения:
- `packages/core/src/work/worktree.test.ts`: `describe('isGitRepo')` «не git — false, после init — true» (`:182-186`) [W33]; «папка без коммитов — no-commits; не под git — not-a-repo» (`:848`), «PATH без git — git-missing» (`:858`) [W34]; вложенный репозиторий — `describe` и хелпер `nestedRepo` (`:780-788`), «неотслеживаемый вложенный репозиторий в worktree — один элемент, не падает» (`:800`), «подложенный .git в чекауте базы …» (`:1150`) [W35].
- `packages/host/src/worktrees/worktrees-service.test.ts`: «git-проект — true, обычный каталог — false» (`:110`), «папка не под git — bad_request с причиной not-a-repo» (`:379`), «git-missing — internal с причиной; not-a-repo и no-commits — bad_request» (`:395`) [W36].
- `packages/core/src/git.test.ts`: `describe('gitBranch')` (`:21`), пять тестов, среди них `:47` worktree/`gitdir` и `:71` «не репозиторий и пустой HEAD — ветки нет». Не-git покрыт, вложенные и несколько репозиториев — нет [W38, исправлено: тестов пять, не один].
- `packages/host/src/agent/attempts-endpoint.test.ts:320`: «requires the engine repository even when the SHA exists in the project» [W37].
- e2e `packages/desktop/e2e/parley-integration.spec.ts`: `initRepo` (`:49-57`), тест `worktree: …` (`:594`) только с git-проектом. Теста «проект не git» нет [W39].
- В `packages/host/src/rooms/autonomous-engine.test.ts`, `autonomous-cycle.test.ts`, `check-runner.test.ts`, `packages/core/src/work/autonomous.test.ts` и `RC/PlanPanel.test.tsx` нет случаев «не git» и «несколько репозиториев». Фикстуры везде с реальным `git init`. Ближайшее — `autonomous-engine.test.ts:107` «isolates session and capture identities for two plans sharing a work» (два плана, один репозиторий) [W40].

Гипотезы: нет.
Не нашёл: тестов на предложение плана в не-git проекте, на `create_session` с `worktree:true` в не-git (на уровне `SS`), на проект-подкаталог чужого репозитория. Просмотрено: имена `describe/it` и строки по ключевым словам в 11 тестовых файлах; тела не читались, кроме `worktree.test.ts:780-800` и `:848-860`.

## Q8. Где предполагается ровно один репозиторий

Ответ: везде, где есть `projectPath`, base SHA и интеграционная ветка. Для «фронт + бэк в двух git внутри одной папки» придётся менять места ниже. Каждое из них — одно значение на работу или план.

Перечень:
1. Один base SHA на план из корня проекта: `AEP:135` (`baseBranchOf(ref.projectPath)` + `rev-parse`) [E23]; запись `integration {baseSha, verifiedHead}` (`AEP:164`) [E37].
2. Одна интеграционная ветка на план `` `parley/${workId}/integration/${planId}` `` (`AEP:164`) [E37]; её используют `AE:293`, `612`, `662`, `664` [E3, E8, E12].
3. Один `engine.git` на `(projectPath, workId)`: `AEP:20-21` [E2], создание и наполнение из одного проекта (`AE:291-293`) [E1, E3].
4. Один каталог интеграции на план (`AE:582`) и каталоги попыток (`AE:191-192`) под `workPaths(projectPath, workId)` [E17].
5. Один `verifiedHead` как база каждой попытки: `CA:699-700` [E21], `startReady → startAttempt` (`AE:1083`) [E36].
6. Одна проверка `.parley-tmp` в корне проекта (`AE:277`, `286`) [E16].
7. Одно зеркало в проекте: `refs/heads/<branch>` через `git -C loc.projectPath fetch` (`AE:662-664`) [E12]; в тексте инструкции «project mirror: ${loc.projectPath}» (`AE:758`) [E22].
8. Frozen inputs проверок разрешаются в одном `projectPath` на одном base SHA (`AEP:112-125`) [E38]; проверки клонируют один `engine.git` (`CR:109`) [E39], `cwd` — внутри одного checkout (`CR:125-126`) [E43]; в черновике `cwd` — просто текст (`packages/core/src/mcp/plan-tools.ts:90`) [E48].
9. Один `Location.projectPath` в движке (`AE:80`) [E14] и одно поле `projectPath` у работы (`works.ts:16-18`, `37-38`) [W12].
10. Worktree: одна проверка `isGitRepo(projectPath)` (`SS:1089`, `WS:146`) [W3, W16], одна база `baseBranchOf(projectPath)` (`SS:1011`) [W7], `worktree add` в одном репозитории (`WT:98-113`) [W9], слияние ищет базу в `listWorktrees(projectPath)` (`WT:1024-1033`, `727-732`) [W17], одна проверка связности (`WT:571-577`) [W15], один `cwd` сессии (`launch.ts:239`) [W11].
11. Окно: один признак `worktrees.available` на `projectPath` (`methods.ts:279`, `469`) [W31]; `cwd` чипа роли — `entry.projectPath` (`RC/PlanPanel.tsx:344`) [W22].

Гипотезы:
- Самый дешёвый путь для `front/`+`back/` — работа на каждый репозиторий (`projectPath` = подпапка). Тогда код не меняется, но план и интеграция будут раздельными. Общий план на два репозитория потребует, чтобы пункты 1–8 стали списком «репозиторий → base SHA/ветка/`engine.git`». Это вывод королевы, не факт из кода.

Не нашёл: место, где движок или worktree допускали бы список репозиториев. Просмотрено: срезы 1–3 (см. Q1–Q5).

## Журнал роя

- **Нарезка (королева).** До запуска читателей королева сама смотрела только дерево: `ls packages/*/src`, `git ls-files | grep` по именам (engine, attempt, worktree, check-run, plan, autonomous), `wc -l` входных файлов, `grep -l` имён (`plan-actions`, `AutonomousEngine`, `autonomous` в `desktop/src/renderer`). Содержимое исходников не читала.
- **Срезы и швы:**
  - срез 1 «движок и git» (Q2, Q3-движок, Q8-движок): входы `AE`, `packages/core/src/git.ts`, `CA`; швы — `CR` (сигнатура), `WT` (сигнатура), `host.ts`;
  - срез 2 «запуск и проверки» (Q1, Q4, Q8-план): входы `CR`, `packages/host/src/methods/rooms.ts`, `packages/protocol/src/plan-actions.ts`, `plans.ts`, `plan-effects.ts`, `AEP`, `plan-tools.ts`, `attempt-tools.ts`; швы — старт в `AE`, предусловия в `CA`;
  - срез 3 «worktree и корень» (Q5, Q3-корень, Q8-worktree): входы `WT`, `WS`, `methods/worktrees.ts`, `ST`, `SS`, `git.ts`, `launch.ts`; швы — `works.ts`, вызовы worktree в `AE`;
  - срез 4 «окно и тесты» (Q6, Q7): входы `STR`, `RC/*.tsx` и 11 тестовых файлов; шов — откуда окно получает признак «не git».
- **Сбой первой волны.** Читатели s-49…s-52 созданы около 10:38 UTC с ролью `builtin:researcher`. По сообщению s-38 (m-1588, 10:47:35 UTC), роль ломается известным багом: CLI получает `--disallowedTools`, стартовый бриф уходит как имена инструментов («Deny rule … matches no tool»), и задачи у сессии нет. Исправление — PR #124, в запущенное приложение не установлено. Сессии не дождались и не закрыли. Ожидание s-49 остановлено. На момент записи s-49 в карте не найдена (`session s-49 is not in the map`).
- **Перезапуск.** В 10:48:16 UTC созданы s-53…s-56 без роли, с первой строкой брифа «ТОЛЬКО ЧТЕНИЕ…». Сдача: s-56 — 10:49:51, s-53 — 10:50:29, s-54 и s-55 — до 10:51:50. Все четыре сдали `coverage: partial`.
- **Факты читателей:** 124 (s-53 — 26, s-54 — 37, s-55 — 31, s-56 — 30). После дедупа и слияния смежных фактов в реестре 88 утверждений: E1–E48 (срезы 1–2) и W1–W40 (срезы 3–4).
- **Противоречия и дыры в реестре, разрешены проверкой:**
  - s-53 не нашёл, где задаётся `integration.baseSha`, а s-54 указал `AEP:164`. Подтверждено [E37].
  - s-53 считал первым сбоем в не-git проекте `AE:277` с halt, а s-54 — отказ при предложении (`AEP:135`). Подтверждено, что предложение идёт раньше [E23]. По [O2], сбой `AE:277` к halt не ведёт.
  - s-55 (H3) сомневался, какую ветку ответа `ST` увидит агент. Разрешено [O3]: ветка `ST:58-59`.
- **Проверка.** s-57 (Sonnet, `custom-claude-2`) проверил E1–E48 с 10:52:41 до 10:53:54: подтверждено 46, опровергнуто 2 (E27 — неполный перечень кодов отказа; E34 — условие раннего выхода `start()` шире). s-58 проверил W1–W40 с 10:52:41 до 10:54:36: подтверждено 37, опровергнуто 3 (W22 — не карточка попытки, а чип роли; W23 — строка `STR:65`, не 63; W38 — в `git.test.ts` пять тестов, не-git покрыт на `:71`). Непроверяемых 0. **Итого: 88 проверено, 83 подтверждено, 5 опровергнуто, 0 непроверяемых.** Опровергнутые в ответ вошли только в исправленном виде. Ответы проверяющих на открытые вопросы O1–O4 даны как гипотезы с источником.
- **Сбой передачи s-58.** `report` s-58 содержал только итог без вердиктов по пунктам. Королева задала один вопрос (m-1589) и в 10:55:18 получила поправки и O3/O4 письмом (m-1590).
- **Где королева сама открывала код и зачем.** s-54 и s-55 сообщили, что рабочее дерево не на `36c5f6e6`. Королева проверила это: `git branch --show-current` (`feat/archived-sleep-emoji`), `git rev-parse HEAD` (`0b65b9a2`), `git diff --stat 36c5f6e6 -- packages` и `git diff 36c5f6e6 -- packages/desktop/src/shared/strings.ts`. Расхождение — три файла desktop (`WorkCard.tsx`, `WorkCard.test.tsx`, `strings.ts` +2 строки после 470). Файлы движка, worktree и проверок не изменены. Поэтому проверяющим велено читать только `git show 36c5f6e6:`. Других обращений к коду у королевы не было.
- **Прочее.** s-54 копировал входные файлы через `git show` в свой scratchpad вне репозитория. В репозитории никто, кроме королевы (этот файл), ничего не писал. s-53 читал файлы движка из рабочего дерева, но эти файлы совпадают с `36c5f6e6`. Сессии не закрывались, коммитов нет.
- Конец: `Wed Oct 28 10:57:50 UTC 2026` (`date -u` после записи файла).
