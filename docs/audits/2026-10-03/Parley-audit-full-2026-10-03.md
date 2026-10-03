# Parley: полный доказательный аудит и приложения

Срез 3 октября 2026. Этот файл включает весь основной отчет, полные шесть тематических приложений и машинные результаты локальных воспроизведений. Все пути исходников относительно указанного Mac; для родительской задачи весь текст приложений приведён здесь, открывать локальные файлы не требуется. Пробы были синтетическими, живые модельные сессии не запускались.



---

# ДОКУМЕНТ: PARLEY-AUDIT-RU.md

# Parley: доказательный аудит Agentic DE

Дата: 3 октября 2026. Репозиторий: `/Users/kalmbik61/Desktop/MY/my_harnas`. Версия: **0.4.0**, HEAD `72a87361d8073c011e60f31e5d254f1045ff086b`.

## Вывод и ближайшие приоритеты

**Parley уже реализует цельную локальную среду работы с командой агентов.** Это больше, чем коллекция MCP-инструментов: есть GUI, собственный сохраняющийся host, терминалы, комнаты, ведущий, адресные сообщения и broadcast, карточка решения, вмешательство человека, просмотр файлов и реальных Git-изменений. Архитектурная ценность — объединение этих действий в одном рабочем процессе поверх штатных Claude Code и Codex, с их авторизацией и инструментами. Импорт старых разговоров не использовался как главный критерий оценки.

**Качество инженерной основы хорошее для раннего персонального продукта; надёжность длительной автономной работы пока слабее широты интерфейса.** В коде много конкретных защит и тестов, но есть воспроизводимые дефекты в самом цикле команды: смена адресатов черновика, незавершённая остановка доставки, блокировка состояния после аварии, рост контекста без границ и неодинаковая передача инструкций вендорам. Это основания сначала укрепить ядро, затем расширять capabilities/router и remote access.

**Экономность сейчас не доказана.** Хорошие решения уже есть: native CLI владеет кэшированием; краткий onboarding; ленивый `read_guide`; сообщения доставляются указателями; повторные подъёмы и некоторые письма ограничены. Но `get_map` выгружает всю историю, brief копирует решения и summaries, fanout не имеет общего бюджета, GUI не показывает надёжный полный token ledger. Router по текущему дизайну локальный, без отдельной модели: направление разумное, однако измерять нужно стоимость успешно завершённой задачи вместе с ошибками выбора и повторными попытками.

Ближайшая очередь:

1. Закрыть выход из каталога в destructive `works.delete`, исправить смену broadcast/DM при восстановлении черновика.
2. Сделать остановку и lifecycle атомарными для доставки/запуска; восстановление file locks — безопасным после аварии.
3. Разделить проверенную и эвристическую identity Codex; согласовать trusted instructions и resume с реальными контрактами CLI.
4. Убрать безлимитную историю из map/bootstrap, ввести страницы/курсоры, бюджеты сообщений и fanout.
5. Починить метрики, затем сравнивать navigator с baseline. Пройти живую матрицу Claude/Codex с отдельным явно выделенным бюджетом; в этом аудите платных прогонов не было.

P0 не установлен. P1 ниже означает серьёзный риск для основного сценария или destructive API; это не утверждение, что дефект уже произошёл у пользователя. Для security замечаний отдельно указаны необходимые права.

## Область, снимок и ограничения

- Исходники, настройки и пользовательские данные не изменялись. Пробы создавали только синтетические данные в временных каталогах/каталоге аудита. Агентные разговоры, API генерации и внешние изменения не запускались.
- Пользователь параллельно разрабатывает capabilities и navigator. Их незакоммиченные design-документы рассмотрены как **WIP**, а отсутствие реализации не объявлено регрессией завершённого продукта. Начальный status: изменён `.omc/project-memory.json`; untracked `.superpowers`, `.pnpm-store`, три новых design-документа, prototype и временный файл памяти. Содержание личной памяти/credentials не исследовалось.
- В корне проекта и проверенных родительских каталогах `AGENTS.md`/`CLAUDE.md` не обнаружены. Прочитан `.agents/skills/parley/SKILL.md`: это stub, отсылающий к version-matched `read_guide`; он не применялся как разрешение координировать реальные пользовательские сессии. Применён read-only навык `analyze`; его ссылка на общий `templates/AGENTS.md` локально не разрешилась.
- Сохранены [снимок исходников](audit-baseline.json), [расширенный vendor-снимок](vendor-audit-source-snapshot.json), [ранняя карта](parley-early-map.md). Финальная сверка вынесена в `audit-final-snapshot.json`.
- Безопасные локальные `--version` дали **Claude Code 2.1.287** и **Codex 0.156.1**. `codex --no-daemon --help` и `codex resume <synthetic-id> -c … --help` завершились с кодом 0: аргументы парсятся; это не доказательство успешного resume или значения TUI-настроек. Codex сообщил о запрещённом sandbox создании PATH aliases; привилегии для этой операции не повышались. [Вывод версий](cli-version-evidence.json), [проверка парсера](codex-flag-parse-evidence.json).
- GUI и живые модельные сценарии не запускались. Оценка удобства основана на путях интерфейса, тестах и воспроизведениях отдельных функций; сравнительного usability-теста с другими продуктами не было. Аналоги/новизну отдельно исследует родительская задача.
- Единственный root commit полной, не shallow истории: `94e29be2c3fcb66f55084014a2f83da362118ed4`, author и committer `2026-09-01T17:59:16+03:00`, `chore: ralph scaffolding`. Это начало доступной Git-истории, не доказательство даты идеи, публикации или заимствования.

## Реальный стек и схема ответственности

| Слой | Реализация | Ответственность и границы |
|---|---|---|
| Desktop | Electron 44.4.5, React 18, Zustand, xterm, Monaco, Tailwind | Проекты/сессии/комнаты, терминал и Chat, файлы, Changes, браузер, уведомления |
| Host | Node, node-pty, xterm/headless | CLI-процессы, PTY, доставка/wake, feed/hooks, жизненный цикл; переживает закрытие окна |
| Protocol | TypeScript + Zod, NDJSON Unix socket | Валидируемые RPC и события; 8 МиБ на кадр |
| Core | TypeScript strict, MCP SDK, JSON-файлы/locks | Карта работы, комнаты, сообщения, proposal, briefs, vendor launch, чтение логов и skills |
| Vendor | Немодифицированные установленные `claude`, `codex`; extensible registry | Авторизация, модель, sandbox, инструменты, actual model context и caching |

Workspace — проектная папка + работа (`work`); session — процессная жизнь и отдельный результат; room — круг участников с ведущим и proposal. На диске сохраняются map, письма, reports и события. MCP-сервер каждого агента читает/пишет эту карту напрямую; host отслеживает изменения и будит получателей. GUI видит ту же карту через host.

Разделение `lifecycle` и `result` полезно: `report(done)` сдаёт результат, сохраняя доступность агента. Нельзя трактовать `done` как остановленный процесс или прекращённый расход. Git worktree изолирует рабочую копию, но не OS-права, аккаунт, секреты и общую карту.

Состояние хранится в JSON с атомарным rename и блокировками: это легко изучать и восстанавливать вручную, но нагрузка/конкурентность и crash recovery должны иметь явные пределы. Сейчас вся переписка является частью управляющей карты, и это основная точка роста сложности.

### Native CLI и подписка

Фактический путь — [launch.ts:285](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/work/launch.ts:285) → [sessions-service.ts:280](/Users/kalmbik61/Desktop/MY/my_harnas/packages/host/src/sessions/sessions-service.ts:280) → [pty-process.ts:39](/Users/kalmbik61/Desktop/MY/my_harnas/packages/host/src/pty/pty-process.ts:39), вызов `node-pty.spawn(command,args,{cwd,env})`, без shell-интерполяции prompt. `agentEnv` копирует окружение и удаляет три маркера родительской Claude-сессии.

В исследованных production-путях не найдено чтения OAuth access/refresh tokens, `auth.json`, `.credentials.json`, keychain extraction или собственного model API relay. Claude limits берутся из statusline JSON, Codex — из rollout logs. Это подтверждает native-CLI архитектуру; Parley не доказывает и не навязывает вид оплаты: обычный CLI может использовать подписку либо пользовательские API-настройки. Бесплатность оболочки не означает бесплатную модель или отсутствие лимитов. Проверенные технические факты не являются договорной гарантией. [Официальное разъяснение Anthropic](https://code.claude.com/docs/en/legal-and-compliance) отдельно различает credential relay и пользовательский вход в немодифицированный Claude Code.

| Provider | Передача | Реально поддержано |
|---|---|---|
| Claude Code | `--session-id`, `--mcp-config`, `--settings`, `--append-system-prompt`, optional `--agent/model/effort`; resume конкретного id | История, MCP, hooks, statusline, терминал и Chat при нужной версии |
| Codex | `--no-daemon -a on-request`, MCP и TUI/notify через `-c`, positional user prompt; `resume id` | История, MCP, терминал, OSC/notify; Chat parity отсутствует |
| GLM | Только `glm`, без шаблонов prompt/MCP/resume | Terminal-only; не полноценный участник автономной комнаты |

Источники: [providers.ts:141](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/providers.ts:141), [providers.ts:211](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/providers.ts:211), [providers.ts:248](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/providers.ts:248). Открытый registry позволяет добавить runner, но сам по себе не создаёт адаптер истории, разрешений, bootstrap и координации.

## Сценарии Agentic DE: что есть и где граница

| Сценарий | Подтверждённая реализация | Оценка и предел доказательства |
|---|---|---|
| Подготовить среду | Bundled Node; поиск CLI и shell env; генерация MCP/settings; установка parley stub | Не нужен ручной перенос MCP-конфига. Уже установленные и залогиненные CLI обязательны; trust/login/permissions остаются native |
| Создать команду | Диалог запускает N сессий, назначает lead, создаёт room | Реальный составной workflow; частичные ошибки и состояние после них важнее красивого happy path |
| Дать общую задачу | Room composer → `rooms.send`, пустой `to` означает broadcast | Задача остаётся сообщением с историей; нет отдельного типизированного task revision/acceptance contract |
| Написать конкретному агенту | Recipient chips, адреса `to`; отдельная почта сессии | Прямая адресация есть. `@` в plain text и restored draft ведут себя неодинаково — R2 |
| Дополнить задачу | Новое сообщение человеку/room, wake после хода; lead читает inbox | Есть, но это очередь сообщений; не гарантированная немедленная отмена уже выполняемого поручения |
| Обсудить разногласия | Общая room feed; question/note/decision; позиции участников и lead в инструкциях | Система хранит обсуждение, но не проверяет независимость голосов, полноту позиций, evidence или consensus |
| Принять решение | Proposal от lead, accept/return, проверка id+rev | Хорошая защита от принятия изменённой карточки. Не hard gate для всех будущих действий агента |
| Вмешаться/остановить | Stop отдельной сессии, Chat interrupt, pause wake | Не единая атомарная остановка команды; есть race R4 и неявные ошибки UI |
| Увидеть изменения | Файлы, Git diff, commit, merge/worktree, conflict checks | Реальные артефакты доступны для инженерного review. Принятие room proposal не равно проверке diff/тестов/слиянию |
| Принять итог | report и артефакты, ручной review, дальнейшее общение | Итог сдаётся агентом; автоматической доказательной проверки результата как отдельного цикла нет |

Ключевые UI-пути: [NewSessionOrRoomDialog.tsx:302](/Users/kalmbik61/Desktop/MY/my_harnas/packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.tsx:302), [RoomPanel.tsx:288](/Users/kalmbik61/Desktop/MY/my_harnas/packages/desktop/src/renderer/components/rooms/RoomPanel.tsx:288). Подробная проверка интерфейса — [UX-аудит](parley-ux-audit.md).

Сильная сторона продукта — сведение уже полезных инструментов в единый daily workflow. Доказать, что он удобнее всех конкурентов, по коду нельзя. Для демонстрации ценнее законченный сценарий с ошибкой, вмешательством и реальным review, чем число кнопок или число одновременно запущенных агентов.

## Приоритетные замечания

### R1 — P1: `works.delete` допускает удаление вне каталога работы

**Доказательство:** [protocol/methods.ts:35](/Users/kalmbik61/Desktop/MY/my_harnas/packages/protocol/src/methods.ts:35) принимает любой `workId`; [host/methods/works.ts:30](/Users/kalmbik61/Desktop/MY/my_harnas/packages/host/src/methods/works.ts:30) игнорирует сбой `readMap`, затем вызывает удаление; [store.ts:58](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/work/store.ts:58) строит путь, [store.ts:202](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/work/store.ts:202) делает recursive rm.

**Механизм/эффект:** `workId='../../../victim'` выходит из `.parley/works` к соседней папке. Валидной map/записи index не требуется. Предусловие — авторизованный local RPC, ошибка privileged caller либо скомпрометированный renderer; удалённая атака без токена не показана. UI не генерирует такой id штатно, но destructive backend обязан ограничивать область.

**Проверка:** через реальную Zod-схему и handler удалена исключительно synthetic sibling-папка; высокая уверенность. Направление: строгий id, канонический root containment, отказ при несоответствии map/index, defensive проверка непосредственно перед удалением. [Harness и результат](security-probes-output.json).

### R2 — P1: один и тот же черновик меняет broadcast на DM после восстановления

**Доказательство:** [mention-editor.ts:34](/Users/kalmbik61/Desktop/MY/my_harnas/packages/desktop/src/renderer/components/rooms/mention-editor.ts:34) определяет получателей только по chips; `:119–136` при `fillEditor` превращает распознанные текстовые `@s02` в chips.

**Механизм/эффект:** пользователь вводит «Всем: @s02 проверит API, остальные пишут тесты». До remount `to:[]`, после восстановления неизменённого текста `to:['s-02']`. Переключение вкладки/восстановление после сбоя отправки может исключить остальных адресатов. Это дефект основного сценария, а не косметика.

**Проверка:** реальные функции с jsdom, unrelated display helper заглушён; одинаковый текст и разные `to` воспроизведены. Высокая уверенность в преобразовании, полный GUI не запускался. Направление: хранить адресатов структурно вместе с draft и одинаково интерпретировать текст при вводе, сохранении и восстановлении.

### R3 — P1: авария владельца file lock оставляет работу заблокированной

**Доказательство:** [store.ts:110](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/work/store.ts:110) создаёт lock через `open('wx')`, при EEXIST лишь ждёт timeout; удаление lock только в `finally` [store.ts:135](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/work/store.ts:135).

**Механизм/эффект:** SIGKILL/crash между acquire/release оставляет ownerless lock. Повторные записи после рестарта продолжают падать; `works-index.lock` способен затронуть разные работы. Существующий host PID lock не решает эту проблему data locks.

**Проверка:** временный собственный child остановлен во время реального `updateMap`; два следующих вызова дали `MapLockTimeoutError`, lock остался. Высокая уверенность. Известная часть уже записана в [TODOS.md:183](/Users/kalmbik61/Desktop/MY/my_harnas/TODOS.md:183). Направление: owner PID+start time/lease и безопасное восстановление после проверки смерти; не удалять любой старый lock только по возрасту.

**Сопутствующий P1:** [sessions-service.ts:303](/Users/kalmbik61/Desktop/MY/my_harnas/packages/host/src/sessions/sessions-service.ts:303) запускает PTY до записи `startSession`; ошибка записи `:315–330` не делает rollback остановкой процесса. Воспроизведение с fake PTY: `MapLockTimeoutError`, `startCalls=1`, `stopCalls=0`, PTY жив, map всё ещё pending/pid=null. Значит, при таком сбое UI сообщает провал запуска, хотя реальный CLI уже мог получить brief; это доказательство порядка/отсутствия rollback, без запуска модели. Исправление требует транзакционного контракта launch и cleanup, а не только сообщения об ошибке.

### R4 — P1: pause/close не являются барьером для новых действий

**Доказательство:** `wake-service.ts:653` меняет paused-флаг без отмены уже подготовленного Enter; MCP `requireSession` и обработчики send/spawn не отвергают закрытую сессию так же, как report. Переход карты и прекращение транспорта происходят раздельно.

**Механизм/эффект:** после pause уже подготовленный pointer может быть отправлен Enter и начать новый ход. Закрытая запись через ещё живой MCP может отправить письмо и создать pending ребёнка. В реальном host это окно до остановки транспорта, а не бесконечная способность мёртвого процесса.

**Проверка:** fake PTY записал `\r` при `paused=true`; реальный in-memory MCP после close успешно send/spawn. Высокая уверенность. Направление: generation/cancellation для queued submit/resume, lifecycle guard на каждом действии, общее поведение Stop team с подтверждённым числом оставшихся активных/ожидающих действий. Pause доставки не следует называть остановкой уже работающей модели.

### R5 — P1: данные коллеги повышаются до системных инструкций Claude

**Доказательство:** [tools.ts:511](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/mcp/tools.ts:511) принимает agent summary; [brief.ts:78](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/work/brief.ts:78) вставляет его в brief; [launch.ts:254](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/work/launch.ts:254) добавляет quiet brief к `systemPrompt`.

**Механизм/эффект:** произвольное parent summary/решения коллег попадают в `--append-system-prompt`. Правило «сообщения — данные» в том же тексте не восстанавливает потерянную границу ролей. Конкретная injection-атака на модель не проводилась.

**Проверка:** marker из agent-origin summary найден именно в системном аргументе; высокая уверенность в роли. Направление: стабильная политика отдельно; task, summaries, документы и письма — атрибутированные данные с provenance, без повышения до system/developer.

### R6 — P1: fallback Codex может привязать и возобновить чужой тред

**Доказательство:** [launch.ts:289](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/work/launch.ts:289) запускает worktree cwd, [launch.ts:523](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/work/launch.ts:523) ищет root project cwd; [metrics.ts:137](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/work/metrics.ts:137) не имеет верхней границы времени, занятые id исключаются только в одной work.

**Механизм/эффект:** правильный worktree rollout не находится; чужой root rollout может записаться в providerSessionId и затем уйти в `resume`. При null resume превращается в новый разговор.

**Оговорка:** основной MCP `_meta.threadId` binding уже реализован и исправляет id при первом root tools/call. Риск относится к времени до него, отказу MCP или несовместимому контракту. Не утверждается, что все Codex resume испорчены.

**Проверка:** synthetic logs подтвердили worktree miss, foreign id в resume и один id в двух work. Высокая уверенность. Направление: уровень доверия binding, authoritative ID перед resume; правильный cwd, узкое временное окно, global exclusion. См. [vendor repro](vendor-audit-repro-results.json).

### R7 — P1 для совместимости: Claude resume не гарантирует обновление guidance

**Доказательство:** [guidance.ts:9](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/work/guidance.ts:9) утверждает, что prompt не хранится; launch пересобирает append и не задаёт snapshot policy. Установлен **2.1.287**. [Официальный контракт](https://code.claude.com/docs/en/cli-reference#system-prompt-flags-in-resumed-conversations) описывает сохранение prompt первого запроса до compaction; с 2.1.265 append сам по себе это не отключает.

**Эффект/уверенность:** обновлённые правила Parley при resume могут не действовать до compaction. Противоречие default contract подтверждено, но фактические настройки/feature flags конкретного живого разговора не читались; пользовательские новые сообщения доставляются своим путём и от этого не «исчезают». Живой prompt не измерялся.

**Направление:** выбрать и документировать семантику versioned policy; стабильное policy ядро, динамические данные отдельно; versioned contract test. Автоматически отключать snapshot ради «исправления» без проверки влияния на cache не следует.

### R8 — P1 для длительной работы: вся история раздувает context и ломает GUI transport

**Доказательство:** [tools.ts:488](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/mcp/tools.ts:488) возвращает всю map; [map.ts:203](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/work/map.ts:203) накапливает сообщения; `rooms.send` не ограничивает text сверху. [works.ts:47](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/work/works.ts:47) включает даже archived работы; [works-service.ts:80](/Users/kalmbik61/Desktop/MY/my_harnas/packages/host/src/works/works-service.ts:80) и `:265` публикуют весь snapshot. [framing.ts:11](/Users/kalmbik61/Desktop/MY/my_harnas/packages/protocol/src/framing.ts:11) ограничивает кадр 8 МиБ, [host-connection.ts:327](/Users/kalmbik61/Desktop/MY/my_harnas/packages/desktop/src/main/host-connection.ts:327) уничтожает соединение при отказе декодера.

**Проверка:** 900 сообщений по 10 000 ASCII символов → кадр 9 109 799 байт → `LineTooLongError`. Отдельная проба со штатной map: 2 100 решений по 4 000 символов → 8 673 023 байта и тот же отказ. Объём может суммироваться по нескольким работам. Это предел структуры, а не утверждение о размере текущих данных пользователя.

**Эффект:** переполнение модельного контекста/лишние compactions задолго до предела transport; затем GUI не получает снимок даже после reconnect. Высокая уверенность. Направление: компактная topology map, пагинация истории/курсоры, отдельный message store и incremental events, bounded brief, лимиты ответа до сериализации. [Чисто in-memory repro](snapshot-frame-repro.mts).

### R9 — P2: формальные ограничения расхода не покрывают fanout

`messageRate=20` и `resumeRate=6` по умолчанию — локальные ограничения, `autoLaunch=true` ([config.ts:58](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/config.ts:58)). `spawn_session` не использует этот бюджет; invitation через `create_room` обходит исчерпанный `send_message` rate. ResumeLimiter хранится только в памяти host.

Воспроизведены invitation после исчерпания rate и 12 созданных pending детей при `messageRate=1`. Модели не запускались; в обычном host такие новые agent-created pending записи являются кандидатами autoLaunch. Отдельных max concurrent/per-work launch budget и общего token limit в данном маршруте нет. Значит, эти knobs ограничивают отдельные петли, а не всю стоимость задачи. Высокая уверенность. Нужны budgets на room/work + лимиты fanout/retries; сохранение counters там, где рестарт не должен давать новый бюджет.

### R10 — P2: смысл доставки и адресации слабее возможных ожиданий

- `check_inbox` помечает письма прочитанными **до** подтверждения получения ответа клиентом (`tools.ts:825–834`): при потере ответа retry пуст. Воспроизведены firstCount>0/retryCount=0; реальный сетевой сбой не моделировался. Нужны cursor/ack или документированная at-most-once семантика и доступный replay.
- Broadcast recipients вычисляются по **текущему** членству: новый участник получает старую задачу как unread, ушедший теряет старое pending письмо. Воспроизведено. Историю и новую доставку следует различать.
- `to` управляет уведомлением/inbox, не приватностью. `read_room` показывает весь room feed, `get_map` — вообще всю map; nonmember получает через map то, что `read_room` ему запрещает. Для общей доверенной проектной команды это может быть намеренно, но [guide.ts:141](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/work/guide.ts:141) нельзя обещать видимость «только названным».

### R11 — P2: room authority и принятие человеком частично остаются инструкциями

Проверки lead для proposal/add_to_room, membership и proposal revision действительно есть. Но `create_room` позволяет обычному агенту забрать существующего ведущего в другую room; `close_session` проверяет self/descendant, а не запись human consent; `spawn_session` не проверяет принятие плана. Все три механизма подтверждены кодом, первые два — synthetic MCP.

Это не доказанный remote privilege escalation. Все агенты работают в доверенном local user domain, MCP identity берётся из env, worktree не является sandbox. Для личного harness такой выбор допустим, но гарантию «агенты не исполнят до принятия» по этому коду дать нельзя. Нужен выбор продукта: явно advisory coordination либо host-enforced policy с user action/operation capability и task revision. MCP annotations — лишь hints, не замена authorization.

### R12 — P2: счётчики расхода после report/resume могут отставать и не дают cache ledger

[activity-service.ts:454](/Users/kalmbik61/Desktop/MY/my_harnas/packages/host/src/activity/activity-service.ts:454) предпочитает `session.metrics` свежему `indexed.tokens`; [metrics.ts:222](/Users/kalmbik61/Desktop/MY/my_harnas/packages/core/src/work/metrics.ts:222) фиксирует metrics при report/sleeping; active transition их не сбрасывает. Извлечённая неизменённая функция при snapshot 100/20 и живом index 1000/200 вернула старые 100/20. Полный service-level repro здесь не запускался; static chain и pure function проверены.

Кроме того, [LiveMetrics:79](/Users/kalmbik61/Desktop/MY/my_harnas/packages/protocol/src/types.ts:79) не передаёт cacheRead/cacheWrite в GUI, хотя core их разбирает. Сравнивать navigator по видимым стрелкам tokensIn/out некорректно. Нужны live-vs-final source selection и per-turn ledger с cached/uncached полями без смешения vendor semantics.

### R13 — P2: неодинаковые bootstrap и capabilities провайдеров

Для тихого Codex-ребёнка brief подготовлен на диске, но не попадает ни в positional prompt, ни в system slot (у Codex такого slot в шаблоне нет). Родительский summary присутствует в файле, отсутствует в argv; остаётся доступен через map. Skill/MCP tool descriptions частично помогают, но это не равнозначная гарантированная доставка правил Claude.

Дополнительно: default history roots игнорируют `CODEX_HOME`/`CLAUDE_CONFIG_DIR`, хотя CLI наследует их; GLM создаётся как pending с задачей, но запускается без неё и MCP; новый Codex получает принудительное `on-request`, resume — без этого override. Не все эти конфигурации используются на данном Mac, но кодовые пути конкретны. Требуется явная capability matrix: terminal, room, history, resume, mandatory bootstrap, permissions, metrics. Полные доказательства и official links — [vendor report](vendor-contracts-audit.md).

### R14 — P2: UI скрывает сбои ключевых действий и может терять отправленный draft

Session menu stop/resume/close/delete и Chat Stop некоторые ошибки оставляют только в `console.warn`; room-level Stop team в просмотренных контролах нет. Composer очищает DOM и persisted draft до успешного `rooms.send`; если при отказе уже введён новый текст или компонент размонтирован, исходный draft не восстанавливается. Защита нового текста полезна, но нужен отдельный failed outgoing item/retry. Подробные ссылки, воспроизведение R2 и сценарии — [UX-аудит](parley-ux-audit.md). Дополнительно уведомление «lead collected positions» возникает просто при новом proposal: backend не подтверждает, что позиции действительно собраны. Формулировку стоит сделать нейтральной либо связать с evidence участников.

### R15 — P2: текущий список skills не является точным представлением доступных CLI skills

Claude capabilities scanner проходит plugin cache без фактического enabled/installed состояния, версии сортирует как строки. Synthetic disabled plugin с 2.9.0 и 2.10.0 появился в списке как OLD 2.9.0. Для других providers endpoint возвращает пустые списки. Это дефект уже существующих подсказок; он **не** приписывается ещё не реализованному navigator. TODO честно признаёт часть проблемы. Общему новому индексатору нужна сверка с эффективной загрузкой native CLI, включая worktree cwd, настройки и model-invocable ограничения.

## Skills, knowledge и экономный navigator

### Что работает сейчас

Три уровня: обязательная краткая guidance для Claude; task/parent brief; ленивый `read_guide(topic)` плюс короткий stub skill `parley`. Полный гид не обязан попадать каждому агенту на каждом ходу. Установка stub идёт из одного version-matched source в project/worktree, не перезаписывая произвольные чужие skills. Это хорошая основа для экономии и синхронизации документации.

Однако ограничение «14 строк» не ограничивает контекст: строка цели может иметь произвольную длину. `get_map` в обязательной инструкции «call it first» загружает всю map. Full guide пересекается с system/stub/tool descriptions, а brief копирует summaries и decisions; есть качественная компрессия через summaries, но нет строгого бюджета и ссылки вместо бесконечного включения.

Отдельного общего knowledge engine, retrieval memory, memory decay/provenance или межвендорного агентного обучения в исследуемом completed коде не установлено. `.omc/.omx` разработки не следует выдавать за runtime memory продукта. Claude agents — в основном именованные определения родного CLI; `agent` не универсальная роль с одинаковой семантикой для Codex.

### Измеренный статический baseline

Это **символы и байты синтетических функций**, не billable tokens и не измерение экономии подписки.

| Вход | Полученный объём |
|---|---:|
| Обычная systemGuidance | 2 832 символа / 2 878 UTF-8 байт, 14 строк |
| Stub skill `parley` | 3 680 символов |
| Полный `GUIDE` | 21 974 символа |
| Goal 100 000 символов | guidance 102 813 символов, всё ещё 14 строк |
| 100 решений по 4 000 символов | brief 402 357 символов, map 413 922 байта |
| 2 100 таких решений | map 8 673 023 байта, отказ декодера 8 МиБ |

Перевод «4 символа = токен» для русского текста, кода и разных моделей ненадёжен. Можно использовать грубую оценку для alarm thresholds, но нельзя публиковать её как usage. Детальный [context proof](parley-audit/context-proof-output.txt).

### Текущий замысел navigator

В [design:54](/Users/kalmbik61/Desktop/MY/my_harnas/docs/specs/2026-10-03-skill-navigator-design.md:54) роутером является **сама модель сессии**. Parley локально ищет по словам/BM25 среди name/description; отдельного LLM, embeddings, сети и hook на каждый prompt нет. Результат `find_skill` ограничен 5 по умолчанию/10 максимум, тело выбранного skill загружается родным CLI. Это экономнее дополнительной классифицирующей модели и сохраняет стандартный формат skills.

Открытые риски дизайна, а не дефекты ещё не написанного кода:

- Name-only список всё ещё O(число skills); повторять все имена в MCP description для Codex — постоянная стоимость и возможная смена cache prefix при обновлении каталога.
- Local search бесплатен относительно inference, но query, результат, выбор модели, skill body и повторный запрос не бесплатны по контексту/ходам.
- English-only query с ожиданием, что модель сама повторит перевод, может тратить больше на no-match/retry и ошибочные инструкции; нужен bounded fallback, примеры/alias, multilingual quality cases.
- Отключение native skills ради сокращения списка должно сохранять допустимость вызова выбранного skill и настройки человека. В design это правильно оставлено за «разведкой 0»; закрыть до rollout.
- Lead ищет skill участника, участник потом загружает его: полезно передать только ID/путь/version/hash и смысл выбора, не копировать полное тело в broadcast всем.
- Если budget flag перестанет работать и включится полный native list **плюс** `find_skill`, экономия превращается в overhead. Нужны измерение effective prompt и явный fallback/telemetry.

### Рекомендуемый экономный контракт

Предлагаемые бюджеты — критерии проектирования, не найденные существующие ограничения:

1. Stable trusted bootstrap: ориентир ≤1 000 vendor-token-equivalent на старте; не включать туда summaries, message history и динамический список всех skills. Отдельный version/hash политики. Проверять tokenizer или actual prompt-input, когда доступно.
2. `get_map` по умолчанию: только identity, topology, lead, lifecycle/result, unread counts, короткие summary refs. Бюджет ответа, например 16 КБ; подробности и архив — по cursor/IDs.
3. `read_room`/`check_inbox`: пагинация и explicit cursor; default bounded batch. ACK должен обозначать доставку, а не чтение файла сервером. Старую историю отдавать как history, не новое поручение.
4. Skill discovery: стабильная маленькая схема; `limit<=5` обычно, ограничение bytes каждого description/всего result; zero-match — один корректирующий поиск, затем прозрачный native fallback. Включённость и scope совпадают с CLI.
5. Skill body: загрузить выбранное тело один раз в нужного исполнителя; сохранять ID/version/hash и происхождение. Не дублировать тело в system, lead chat, room broadcast и каждый child brief.
6. Context/knowledge: утверждённые решения с revision и scope, короткие summaries с ссылками на evidence; retrieval по задаче. Не инжектировать всю накопленную memory на каждый ход. Старое и неподтверждённое явно маркировать.
7. Per-work execution budget: max concurrent agents, max new sessions, retries, clarification rounds, wake budget; предупреждение и остановка новых действий при исчерпании. Отдельный уже выполняемый процесс не исчезает от pause.
8. Cache: стабильные tool schema и trusted prefix, dynamic data позже; native CLI управляет реальным cache. Изменения model/toolset/plugin list фиксировать в telemetry как cache-breaking candidates. Нельзя обещать общий cache между вендорами.

[Claude Code caching](https://code.claude.com/docs/en/prompt-caching) и [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) описывают повторное использование общего префикса. Parley не задаёт собственные `cache_control`/`prompt_cache_key`; наличие `resume` не доказывает cache hit. API-документация объясняет механизм, но не является обещанием тарифного эффекта для CLI-подписки.

### Benchmark baseline против navigator

Сначала offline corpus тестирует правильные IDs/top-k, active/disabled/version/worktree scopes, deterministic rank, zero-match и bytes; никакие модели не нужны. Затем отдельно разрешённый live-прогон:

| Измерение | Как фиксировать |
|---|---|
| Варианты | A: текущий native list без navigator; B: navigator + сокращённый список; C: navigator с fallback/native full list |
| Задачи | 15–30 парных задач: skill нужен/не нужен/несколько похожих; RU/EN; code/docs/Figma; новая и продолженная сессия; 1 агент и mixed room |
| Контроль | Одинаковые CLI versions, model/effort, skill corpus/hash, repo snapshot; сравнить cold/warm cache отдельно, менять порядок A/B |
| Качество | Выполнена ли задача по независимым критериям; верный skill; лишние skills; ошибки, исправления и человеческие вмешательства |
| Расход | Все input/output/cache read/cache write по каждому участнику и всем повторам; model-specific semantics; aggregate на завершённую задачу |
| Дополнительные | tool turns, find_skill calls, retries/no-match, fanout, wake, compactions, wall time, p50/p95 |
| Gate | Качество не хуже заданного допуска; не больше опасных/лишних skill calls; снижение total cost/token workload без скрытого роста retries и p95 |

Отдельно фиксировать стоимость неуспешных задач: исключение failure runs искусственно улучшит результат. Если vendor не отдаёт cache-write поле, записывать `unknown`, а не 0. Для подписки не подменять token ledger долларами: модельная цена и rate-limit weighting могут отличаться. Нынешний GUI для benchmark недостаточен из-за R12.

## Документация, тесты и инженерное качество

Документация подробная, с конкретными решениями, review focus и признанными ограничениями. README описывает prerequisites, обновление host, разные CLI и работу hooks. TODO прямо оставляет живую проверку mixed room, skills/resume, stale locks и type-test gap. Это сильнее бездоказательного «всё готово».

Слабость — накопительный объём: README около 110 КБ, TODO около 78 КБ, множество датированных spec/plan/research. Текущее поведение, старые допущения и нерешённые acceptance criteria легко расходятся. Пример — утверждение о несохранении system prompt. Полезен один короткий актуальный contract index: функция → поддержанный provider/version → code/test → live evidence → known gaps. WIP plans не должны попадать в список поддерживаемых возможностей до gate.

Положительные инженерные доказательства:

- TypeScript strict с `noUncheckedIndexedAccess` и `exactOptionalPropertyTypes`; доменная логика отделена от UI, Zod на RPC.
- Host socket с random token, каталог 0700/token 0600; local HTTP hooks только loopback, отдельные rotating bearer; blocked/timeout hook не превращается автоматически в allow.
- Electron contextIsolation/sandbox, Node выключен в renderer; webview без preload/Node; Markdown без raw HTML. Реальные file roots и symlinks проверяются; запрет опасных file open типов.
- CAS proposal id+revision, атомарные записи, pid/start-time lease/liveness, состояние доставки и работа с native terminal input, отдельные тестовые fixtures.
- Native CLI авторизация и checkout/worktree интеграция сохраняют привычный инженеру рабочий процесс; project changes можно проверить руками до merge.

Существенные пробелы verification: CI macOS/Node22 включает build/typecheck/lint/unit с retry, но не E2E; [CI:39](/Users/kalmbik61/Desktop/MY/my_harnas/.github/workflows/ci.yml:39) это прямо объясняет. Многие E2E используют echo/stub агента и собственную имитацию OSC/notify — они подтверждают продуктовые потоки, но не контракт реального вендора. TypeScript `expectTypeOf` тесты protocol исключены из tsc, обычный Vitest их не typechecks; [TODOS:299](/Users/kalmbik61/Desktop/MY/my_harnas/TODOS.md:299) это признаёт.

### Выполненная верификация

Полный журнал и итоговые числа — [отчёт проверки](audit-validation/verification-report-ru.md). Проверки не суммируются бездумно: targeted suites пересекаются с полным core.

| Первый полный валидный прогон на Node 22, без retry | Passed / total | Наблюдение |
|---|---:|---|
| Core, 70 файлов | 1675 / 1677 | `cli-work`: timeout и каскадный следующий тест; отдельный повтор 20/20 прошёл |
| Protocol, 5 файлов | 81 / 81 | Дополнительный настоящий tsc по protocol tests также прошёл |
| Host, 49 файлов | 686 / 687 | ENOTEMPTY в test teardown; исходный сбой не повторился, targeted run встретил другой известный timeout |
| Desktop, 234 файла | 4502 / 4502 | Без запуска GUI |
| Всего | **6944 / 6947** | 358 файлов; это не полностью зелёный полный прогон |

Сбои core/host согласуются с известной нестабильностью tests и наблюдаемыми гонками их teardown; они не доказывают отдельно порчу product session ID или неправильный lifetime hook token. Они также не должны исчезать из отчёта только потому, что выборочный повтор прошёл. Build core/protocol/host/desktop, desktop typecheck и lint в подготовленной копии завершились успешно.

- Read-only проверка дерева, Git/истории/status, инструкция stub, tracing production routes и текущих WIP designs.
- Изолированные собственные proof harness: security 4 сценария; orchestration 8; vendor binding/bootstrap; context growth/scanner; metrics source selection; mention draft routing; frame overflow.
- Targeted existing core: 351 тест; начальный sandbox не разрешал `ps`, затем affected liveness/lease повторены с разрешённым локальным исполнением и прошли. Security: 38 тестов прошли.
- Original local dependency links были устаревшими `@harnas/*`, тогда как manifests уже `@parley/*`: исходный build-copy сначала дал TS2307. В audit-копии связи восстановлены по manifests, исходный проект не менялся; core/protocol/host build прошли. Это состояние локальной установки, не доказанная ошибка clean install или установленного Parley.app.
- Node/CLI version и help-only проверки описаны выше. Полных live/vendor/UI/cost runs нет.

## Приоритетный план без реализации

| Этап | Конкретный результат | Приёмка |
|---|---|---|
| 1. Защитить основной workflow | R1, R2, R4; видимые ошибки stop/send; failed draft retry | Нельзя удалить вне work; адресаты неизменны после remount; после Stop нет новых submits/spawns; ошибка понятна пользователю |
| 2. Переживать аварии | R3, R6; idempotent delivery/ack, authoritative identity, restart recovery | Crash в каждой критической секции; restart возвращает работоспособность без чужого resume/потери последней задачи |
| 3. Унифицировать инструкции | R5, R7, R13; stable policy + attributed data; truthful capability matrix | Для Claude/Codex new/task/quiet-child/resume/compaction известно, что и в какой роли видит агент; unsupported runner не попадает в room silently |
| 4. Ограничить накопление и расход | R8–R10, R12; compact map, cursor, bounded brief, per-work budget, cache ledger | 10k сообщений/много архивов не рвут GUI; указаны bytes/tokens; fanout и retry не обходят budget |
| 5. Завершить capabilities/navigator | Общий корректный index и offline corpus; feature off до gates; затем контролируемый A/B | Правильные active scopes/versions, без disabled skills; качество и cost per successful task не хуже baseline |
| 6. Подготовить демонстрацию/релиз | Версионная live matrix, стабильный demo-script, воспроизводимый clean setup, CI type-tests и stub E2E | Mixed Claude+Codex room проходит весь сценарий, в том числе отказ/уточнение/остановку/review; результаты и пределы опубликованы |

Remote access разумно отложить до фиксации local authorization/capability boundaries: перенос текущего broad local API в сеть расширит последствия ошибок. Это архитектурная последовательность, не оценка ещё не реализованного remote кода.

## Как проект работает на инженерное портфолио

Parley способен быть сильным портфолио-проектом для ролей developer tools, desktop/platform engineering, agent infrastructure и human-agent interaction. Доказуемые достоинства — не сам факт «много агентов», а изоляция host/UI, process lifecycle, typed protocol, работа с нестабильными внешними CLI, безопасный Electron/file IO, продуктовый room workflow и готовность документировать ограничения.

Перед показом потенциальному работодателю я бы подготовил один воспроизводимый 5–10-минутный сценарий: mixed room → одна задача → разные позиции → уточнение человеком → принятое предложение → работа в отдельных checkout → тесты/diff → принятие результата; затем намеренная остановка/ошибка и восстановление. Рядом — архитектурная схема, короткий threat model, честная vendor matrix, crash/contract regression suite и таблица baseline vs navigator с качеством и полным расходом. Исправленные R1/R2/R3/R4 дадут больше инженерного веса, чем ещё одна большая панель настроек.

Портфолио может помочь начать профессиональный разговор, в том числе с OpenAI, но этот аудит не оценивает найм и не обещает интервью/оффер. Значение будут иметь релевантность роли, демонстрируемая глубина решений, доказательства качества и способность объяснить tradeoffs. Сходство с существующими Agentic DE само по себе ни обесценивает реализацию, ни доказывает заимствование; сравнительное позиционирование следует делать отдельно.

## Подробные приложения

- [Адаптеры, инструкции и vendor contracts](vendor-contracts-audit.md)
- [Безопасность и границы доверия](security-audit.md)
- [Оркестрация](orchestration-audit.md) — маршруты комнат, остановка, доставка, результаты воспроизведений
- [Цельные UI-сценарии](parley-ux-audit.md) — drafts/адресаты, review и приёмка
- [Skills/context](parley-audit/skills-context-report.md) — измерения, дизайн navigator и benchmark
- [Проверки](audit-validation/verification-report-ru.md) — команды, результаты suite, среда и ограничения
- [Машинный вывод orchestration probes](parley-orchestration-repro-results.json), [security probes](security-probes-output.json), [vendor probes](vendor-audit-repro-results.json)

Итоговый inventory: [AUDIT-ARTIFACTS.md](AUDIT-ARTIFACTS.md). Основной вывод этого отчёта самодостаточен; приложения дают более подробные механизмы и команды воспроизведения.


---

# ДОКУМЕНТ: vendor-contracts-audit.md

# Parley: аудит адаптеров вендоров, доставки инструкций и resume

Проверено 2026-10-03. Исходники: `/Users/kalmbik61/Desktop/MY/my_harnas`. Файлы проекта не изменялись. Ни Claude, ни Codex, ни другие агентные CLI не запускались. Выводы о фактическом поведении модели отделены от воспроизводимых свойств кода и документированных контрактов.

Срез исходников повторно проверен в `2026-10-03T18:03:37.134Z`; SHA-256 и mtime десяти ключевых файлов сохранены в `vendor-audit-source-snapshot.json`. На момент проверки указанные файлы исходников не были отмечены `git status` как измененные. Новые `docs/specs/2026-10-02-capabilities-design.md` и `2026-10-03-skill-navigator-design.md` — активные принятые дизайны, у которых план должен следовать после разведки. Этот отчет не объявляет еще не реализованные пункты этих дизайнов дефектами готовой функциональности. V1–V7 относятся к уже существующим маршрутам запуска/координации.

Главный результат: оболочка действительно запускает локальные CLI через PTY и оставляет учетные данные провайдеру. Но надежность комнаты зависит от неполностью согласованных способов передачи правил Claude/Codex, а fallback-привязка Codex способна выбрать чужой тред. Две проблемы подтверждены локальными фикстурами; отдельное важное расхождение обнаружено в актуальной документации Claude о сохранении системного промпта.

## Существенные замечания

### V1 — P1: Claude resume не гарантирует обновление системных правил

**Код:** `packages/core/src/work/launch.ts:231–259`, `packages/core/src/work/guidance.ts:9–10`, `packages/core/src/providers.ts:183–199`. Вставка заново строится и передается через `--append-system-prompt`; комментарии утверждают, что системный промпт не сохраняется в транскрипте. `--system-prompt-snapshot off` нигде в маршруте запуска не передается.

**Контракт:** актуальный [Claude CLI reference, resumed conversations](https://code.claude.com/docs/en/cli-reference#system-prompt-flags-in-resumed-conversations) описывает сохранение системного промпта первого запроса и повторное использование при resume/continue до compaction. Начиная с 2.1.265 передача append сама по себе больше не отключает snapshot. Новый текст флага начинает действовать после compaction либо в новом разговоре; для немедленной пересборки существует отдельный флаг.

**Эффект:** обновленные правила Parley и цель работы не обязаны попасть в уже начатый разговор при возобновлении. При импорте внешнего разговора отсутствует гарантия, что bootstrap Parley вообще станет активным системным руководством до compaction. Основной GUI-сценарий новых комнат затрагивается при последующих resume и обновлении политики, даже если импорт старых разговоров второстепенен.

**Уверенность:** высокая для противоречия кода официальному контракту; реальный CLI не запускался. Тест `work/launch.test.ts:770–790` проверяет наличие аргументов, а не то, какой prompt реально использует vendor.

**Следующий шаг:** явно выбрать политику сохранения/обновления инструкций и кэша, учитывать версию CLI, добавить контрактный сценарий «start → изменить guidance → resume → проверить фактический prompt». Не следует автоматически отключать все кэширование без измерений.

### V2 — P1: эвристика Codex может возобновить чужой тред до первого MCP-вызова

**Код:** процесс получает `cwd = session.worktree.path` в `work/launch.ts:289–291`, но `linkSession` передает в поиск `cwd: projectPath` в `work/launch.ts:523–526`. `work/metrics.ts:155` сравнивает cwd точно. Поиск выбирает самый ранний лог после `startedAt − 5 секунд`, без верхней временной границы (`metrics.ts:137–159`). Исключаются занятые id только внутри той же работы (`launch.ts:519–522,536–540`).

**Воспроизведено:** фикстура с настоящим логом в worktree дает `actualLink: null`, хотя поиск по правильному cwd находит его. Если добавить чужой лог с cwd корня проекта, worktree-сессия получает его id и план возобновления становится `resume <foreign-id>`. Еще одна работа того же проекта может получить тот же id. Если id остался null, `planResume` строит новый запуск, а не продолжение (`launch.ts:191–194,265–282`).

**Существенная оговорка:** основной путь через `mcp/tools.ts:1029–1066,1110–1117` привязывает текущий Codex по `_meta.threadId` первого root `tools/call` и исправляет ошибочную эвристику. Это реализовано, а не TODO. Поля присутствуют в текущем [официальном исходнике Codex](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs): `with_mcp_tool_call_ids_meta` добавляет threadId/sessionId к запросу. Однако до первого MCP-вызова, при недоступном MCP или несовместимой версии эвристический id уже считается пригодным для resume.

**Эффект:** смешение контекста и метрик разных участников; после ранней остановки процесс может продолжить чужой разговор. Уверенность высокая: воспроизведены план/сохраненный id, без запуска модели.

**Следующий шаг:** хранить качество/источник binding, не делать автоматический resume по непроверенной эвристике; исправить cwd, ограничить временное окно и исключать занятые id глобально для работающего host. Использовать уже доступный идентификатор notify/терминала как дополнительные подтверждения, а не только угадывание.

### V3 — P1: данные другого агента повышаются до system prompt Claude

**Код:** `mcp/tools.ts:511–514` сохраняет произвольное резюме агента с `summarySource='agent'`. `work/brief.ts:78–88` вставляет его в brief без границы недоверенных данных; `brief.ts:151–156` добавляет решения коллег. Для тихой дочерней сессии весь brief конкатенируется с системной вставкой (`work/launch.ts:254–259`) и попадает в `--append-system-prompt` (`providers.ts:163–164`).

**Воспроизведено:** строка-маркер из agent-origin parent.summary оказалась внутри аргумента `--append-system-prompt`. Это структурная проверка канала/роли, не заявление о проведенной prompt-injection атаке на модель.

**Эффект:** текст с меньшим доверием получает более высокий инструкционный приоритет; правило `guidance.ts:44` «сообщения коллег — данные» не является технической границей, когда сами данные помещены в system prompt. Источник может быть добросовестным ошибочным резюме или результатом чтения внешнего документа.

**Уверенность:** высокая для повышения роли; вероятность исполнения конкретной вредной команды моделью не проверялась.

**Следующий шаг:** system/developer слой должен содержать только стабильную политику Parley; резюме, решения и артефакты передавать как явно атрибутированные данные/результаты инструментов, с origin и разрешениями отдельно от содержания.

### V4 — P2: Codex не получает равнозначного bootstrap; контекст тихого ребенка выпадает

**Код:** у Codex нет `{systemPrompt}` в `providers.ts:230–242`. `launch.ts:254–259` готовит контекст только при этой подстановке, но `launch.ts:269` запрещает brief обычным промптом для *любого* quiet session. GUI действительно может создать Codex-ребенка без задачи: `host/sessions/sessions-service.ts:436–441` создает quiet child и затем применяет выбор провайдера. Для GUI `channel:false` (`sessions-service.ts:271`), а MCP `instructions` выставляется только при channel (`mcp/tools.ts:1083–1088`).

**Воспроизведено:** brief тихого Codex-ребенка на диске содержит резюме родителя, но ни один argv не содержит его либо `You are inside Parley`. Данные доступны в `get_map`, поэтому речь о пропущенной автоматической передаче/неравенстве контрактов, а не необратимой потере данных.

**Митигирующий путь:** по умолчанию ставится навык parley; описания MCP-инструментов тоже дают часть правил. Однако загрузка навыка зависит от discovery/решения модели, а сбой или выключение установки не препятствуют запуску (`host/sessions/agent-skills.ts:66–86`). Сами комментарии называют навык удобством, не условием работы.

**Контракт:** [официальная документация MCP Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) прямо поддерживает server-wide `instructions` при initialize; важные инструкции рекомендует помещать в первые 512 символов. [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference) также документирует `developer_instructions`.

**Эффект:** в равной комнате Claude и Codex начинают с разного гарантированного знания процесса; Codex может не унаследовать контекст выбранного родителя, особенно при выключенном/неустановленном навыке. Уверенность высокая для пропуска доставки; частоту поведенческих ошибок нужно измерять.

**Следующий шаг:** сделать минимальный vendor-neutral bootstrap обязательным, а подробный guide — ленивым; проверить new/task/quiet-child/resume и disabled-skills отдельно для каждого адаптера.

### V5 — P2: история и метрики ищутся не в пользовательском vendor home

**Код:** Codex `codex/discover.ts:12–15` использует `~/.codex/sessions` и тестовый override, игнорируя `CODEX_HOME`. Claude `discover.ts:34–37` аналогично игнорирует `CLAUDE_CONFIG_DIR` в основном `defaultRoot`; только проверка существования разговора знает альтернативные корни (`discover.ts:20–30`). `work/metrics.ts:45–64` использует эти default root. Процесс наследует окружение (`providers.ts:450–454`, `host/sessions/sessions-service.ts:291–294`).

**Контракт:** [Codex advanced config](https://learn.chatgpt.com/docs/config-file/config-advanced#config-and-state-locations) помещает состояние под CODEX_HOME; [Claude settings](https://code.claude.com/docs/en/settings#find-or-create-your-settings-files) переносит session history вместе с CLAUDE_CONFIG_DIR.

**Эффект:** CLI корректно работает с собственным профилем, а Parley не видит его историю/метрики; эвристика Codex может смотреть чужой стандартный профиль. Для Claude resume existence-check и metric lookup расходятся. **Уверенность:** высокая, статический анализ; реальная конфигурация пользователя не читалась.

**Следующий шаг:** единый resolver home/history на адаптер, одинаковый для запуска, index/watch/metrics и resume; тесты custom home без доступа к настоящим учетным данным.

### V6 — P2: provider availability не означает способность работать в комнате

**Код:** GLM в `providers.ts:246–253` — только `{command:'glm'}`, без prompt/MCP/resume. `mcp/tools.ts:475–484` сообщает агенту доступность команды и выбор model/effort, без capabilities координации. `spawnSession` проверяет наличие команды и допускает запись pending (`tools.ts:553–563,603–610`). `startCommand` для отсутствующих args дает пустой массив (`providers.ts:362–366`).

**Воспроизведено:** pending GLM содержит задачу в brief, но launch plan — `glm` с `args: []`. Следовательно задача не передается, MCP нет, report/send_message недоступны через данный адаптер.

**Эффект:** «провайдер доступен» может привести к запуску участника, который не знает назначенную задачу и не включен в автоматическую координацию. То же касается пользовательских runner-only entries. **Уверенность:** высокая для встроенного GLM, не проверялись внешние реализации glm.

**Следующий шаг:** разделить terminal-only и room-capable providers; проверять prompt/MCP/resume/bootstrap capabilities перед spawn в команду. Не считать наличие бинаря достаточной проверкой.

### V7 — P2: политика разрешений Codex не сохраняется прозрачно, а «ответ человека» не гарантирован

**Код:** `providers.ts:124–132` принудительно устанавливает `-a on-request`; комментарий сам признает замену более строгой пользовательской политики. При resume этот флаг не передается (`providers.ts:238–242`). При этом `approvals_reviewer='user'` не задается.

**Контракт:** [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference) различает approval policy и reviewer: под on-request проверяющим может быть `user` либо `auto_review`. Поэтому `-a on-request` не гарантирует обещанное комментарием участие человека. Утверждение «never ломает parley» чрезмерно широкое: [исходник MCP Codex](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs) отклоняет при never именно вызов, *которому требуется approval*, а не все MCP-вызовы.

**Эффект:** ожидания пользователя о сохранении native-политики и ожидания UI о запросах человеку могут расходиться с реальным запуском. Это не доказательство автоматического обхода sandbox: sandbox/reviewer остаются у самого Codex. **Уверенность:** высокая для аргументов и официального определения reviewer; конкретные конфиги пользователя не исследовались.

**Следующий шаг:** сделать effective policy видимой и осознанной; сохранять выбор пользователя либо явно предлагать профиль Parley. Тестировать start/resume и strict/granular/auto_review конфигурации.

## Что реализовано хорошо

- Запуск shell-free через `node-pty.spawn(command,args)` (`host/pty/pty-process.ts:39–49`), а не интерполяцией промпта в shell. Поиск бинаря проверяет исполняемый файл, поддерживает явные override (`work/find-binary.ts:38–55,80–84`). Это не криптографическая проверка «официальности», но корректная модель запуска пользовательского CLI.
- Нет собственного API-клиента для моделей в проверенном маршруте: вход/подписку/ключи обслуживает native CLI. Файлы auth не читаются индексатором (`codex/discover.ts:7–10`). [Codex auth docs](https://learn.chatgpt.com/docs/auth#openai-authentication) допускает ChatGPT subscription и API key; какой режим фактически активен, зависит от входа CLI. Parley не должен обещать подписочный биллинг только из наличия команды.
- Claude получает внешне заданный UUID; Codex — точный threadId из MCP metadata с фильтрацией subagent и коррекцией fallback. Проверки `mcp/thread-binding.test.ts` моделируют исправление чужого id и отсутствие поля.
- Для MCP Codex реализовано TOML-экранирование с контролем DEL/одиночных surrogate (`work/mcp-config.ts:94–107`), отдельные startup/tool timeout (`:116–117`) и явная передача собственных переменных окружения без копирования произвольного env (`:119–159`).
- Системная вставка короткая, подробный guide ленивый; brief содержит пути к артефактам, а не их полное содержимое (`work/brief.ts:50–52,78–88`). Но «не более 14 строк» не является ограничением токенов: одна строка `guidance.ts:42` содержит большой протокол комнаты.
- Host защищается от двойного launch, закрытых sessions и гонки мгновенного exit/start (`sessions-service.ts:135–154,204–221,315–327`).
- Codex notify ограничивает размер последнего ответа и не бросает ошибки в vendor (`work/codex-notify.ts:42–51,86–108`). Терминальный parser имеет состояние unknown и лимит накопления, а не выдает неизвестное событие за Ready (`host/pty/codex-terminal.ts:12–15,47,61–81,147–150`).

## Граница проверенности и проверочные сценарии

Код сам отмечает, что Codex OSC title/notifications и порядок paste→60ms→Enter/Tab не проверялись на живом CLI (`host/pty/codex-terminal.ts:12–15`, `host/pty/codex-input.ts:12–13,27,62–63`). Это не означает, что они сломаны, но unit tests на придуманных байтах не подтверждают turnkey-работу текущего vendor. `providers.ts:128–130` прямо отмечает непроверенность дополнительных resume flags.

Подтверждены официальными источниками: Claude append/session-id/agent flags; новое snapshot-поведение; MCP instructions/developer_instructions Codex; notify/OSC config keys; thread metadata в текущем исходнике. `_meta` и точный текст OSC остаются зависимостью от реализации vendor, не стабильным общим протоколом.

Запущена локальная проверка `vendor-audit-repro.mts` через Node 25.8.0 + установленный tsx loader. Использованы реальные TypeScript-функции из src, все записи — синтетические map/brief/logs во временном каталоге, который удален после проверки. CLI не запускались. Машинный результат: `vendor-audit-repro-results.json`. Скрипт выполнен дважды: первый вариант — identity/context; второй добавил GLM. Оба завершились exit 0.

Полный suite в этой ветке аудита не запускался. Прочитаны релевантные тесты launch, codex-link, thread-binding и sandbox-home. Они подробно проверяют сборку аргументов, условия и фикстуры; обнаруженные провалы лежат между слоями и в семантике vendor, а не в отсутствии любых тестов.

Приоритетный план без реализации:

1. Устранить доверие к эвристическому Codex id как к основанию resume; добавить регрессии worktree, две работы, ранний stop, MCP unavailable, исправление metadata.
2. Разделить стабильную политику Parley и чужие данные; убрать повышение parent.summary/decisions до system.
3. Зафиксировать Claude snapshot semantics; сделать обязательный bootstrap Codex, совместимый с quiet-child/resume и disabled-skills.
4. Ввести матрицу capabilities и проверенные диапазоны версий адаптеров; GLM обозначать terminal-only до реализации room contract.
5. Согласовать vendor home и effective permission policy; добавить видимую диагностику готовности CLI/MCP/идентичности.
6. На отдельно согласованном тестовом аккаунте/лимите провести небольшой end-to-end контрактный прогон двух родных CLI: новая комната, common task, question/note/decision, принятие, добавление участника во время работы, idle wake, active queue, stop/resume, отказ MCP, approvals. Этот аудит не запускал такой платный прогон.


---

# ДОКУМЕНТ: security-audit.md

# Parley: аудит безопасности и границ доверия

Дата проверки: 2026-10-03. Корень исходников: `/Users/kalmbik61/Desktop/MY/my_harnas`. Проверялся текущий рабочий код, без изменения исходников, настроек и пользовательского состояния. Ни штатный хост, ни CLI вендоров не запускались; реальные токены и содержимое личных сессий не читались.

## Главные результаты

1. **P1 — подтвержден выход за каталог при `works.delete`.** Авторизованный RPC-клиент может передать `workId` с `../`; сервер удалит произвольный достижимый каталог, даже если там нет работы Parley. Воспроизведено на одноразовой временной папке.
2. **P2 — обычный участник может переместить чужого ведущего из существующей комнаты.** MCP `create_room` принимает любые живые сессии текущей работы и удаляет их из старых комнат. Правило lead-only у `add_to_room` не распространяется на эту альтернативную операцию. Воспроизведено.
3. **P2 — human consent для `close_session` остается текстовым правилом.** В backend нет подтвержденного состояния согласия человека; достаточны self/descendant. Воспроизведено закрытие дочерней сессии без human action. Это ограничение гарантий оркестратора, не утверждение, что конкретный CLI всегда выполнит вызов без своего вопроса.
4. **Комнаты не являются границами видимости данных.** Nonmember получает отказ `read_room`, но читает те же сообщения через `get_map`. Воспроизведено. Для доверенных агентов одного проекта это может быть допустимая модель; нельзя описывать комнаты как приватные.
5. По проверенным production-маршрутам **Parley запускает native CLI вендоров, а не извлекает OAuth для собственного API-клиента**. Проверка не является юридической оценкой подписочных условий.
6. Локальные транспорты, WebView и файловый интерфейс имеют существенные защитные механизмы. 38 существующих проверок browser guard/held hooks успешно прошли.

## Проверенные замечания

### S1. P1: `works.delete` допускает directory traversal и удаление несуществующей «работы»

**Доказательства:**

- `packages/protocol/src/methods.ts:35`: `workId` — произвольная `z.string()` без формата ID и запрета разделителей.
- `packages/host/src/methods/works.ts:30`: любое исключение `readMap` преобразуется в `null`.
- `packages/host/src/methods/works.ts:31`: проверка busy выполняется только при успешно прочитанной карте.
- `packages/host/src/methods/works.ts:37`: затем безусловно вызывается `deleteWorkFiles`.
- `packages/core/src/work/store.ts:58`: `workPaths` строит адрес через `path.join(stateDir(projectPath), 'works', workId)`.
- `packages/core/src/work/store.ts:202`: `rm(dir, {recursive:true, force:true})` до обновления индекса, без canonical-boundary и без проверки зарегистрированной работы.

**Механизм:** для `projectPath=/tmp/<sandbox>/project` и `workId='../../../victim'` адрес нормализуется в `/tmp/<sandbox>/victim`. Карты в victim нет, чтение тихо игнорируется, recursive remove проходит.

**Предусловия и модель угроз:** нужен авторизованный клиент локального host socket или доступ к main bridge из основного renderer. Удаленный сайт без токена и без дополнительного нарушения изоляции такого доступа не имеет. Процесс под тем же UID, которому уже разрешен весь диск, не получает новых OS-привилегий. Дефект важен как необоснованно широкое destructive API и как усиление ошибки/компрометации клиента.

**Эффект:** потеря каталогов пользователя за пределами выбранной работы; `force` и подавление read-error делают отсутствие карты не защитой.

**Воспроизводимость:** `security-probes.mts` пропускает параметры через реальную Zod schema и вызывает реальный TS-source `worksDelete`; tsconfig aliases направляют `@parley/core` в source. Перед удалением harness проверяет, что цель ровно созданная им disposable victim внутри собственного `/tmp` sandbox. `security-probes-output.json`: `schemaAccepted:true`, `handlerResult:{ok:true}`, `victimExistsAfter:false`. Реальная сеть/socket не использовались. **Уверенность высокая.**

**Направление исправления:** строгие work/session ID на всех границах плюс независимая проверка canonical path в destructive core API; удаление только записи известной работы; отсутствие/ошибка карты — осознанный отдельный recovery flow, а не безусловное разрешение удаления. Регрессия должна охватить `..`, абсолютные пути, пустые ID, symlink ancestor, unknown project и broken map.

### S2. P2: `create_room` обходит ограничения на изменение существующего состава

**Доказательства:**

- `packages/core/src/mcp/tools.ts:837`: реализация `createRoom`.
- `packages/core/src/mcp/tools.ts:848`: вызывающий должен лишь существовать в карте.
- `packages/core/src/mcp/tools.ts:852`: другие участники проверяются на существование и незакрытость; принадлежность родительскому дереву и разрешение их нынешнего lead отсутствуют.
- `packages/core/src/mcp/tools.ts:863`: новая комната получает caller как creator и, по умолчанию, lead.
- `packages/core/src/mcp/tools.ts:872`: все перечисленные участники удаляются из других комнат.
- Для сравнения: `packages/core/src/work/rooms.ts:198` у `addMemberByLead` действительно проверяется текущий lead.

**Механизм и эффект:** любой сессионный MCP-клиент работы вызывает `create_room` с ID ведущего другой комнаты. Ведущий оказывается в новой комнате под caller, старая теряет lead; если оставшиеся закрыты, комната перестает функционировать. Это может случиться из добросовестного ошибочного планирования агентом, без shell, подделки токена и вредоносного процесса.

**Воспроизводимость:** синтетическая human room имела lead `s-01`, член `s-02`; `s-03`, не состоявший в комнате, создал новую с member `s-01`. Вызов успешен, прежняя `lead:null`, новая `lead:s-03`. См. `nonLeadMovesOriginalLead` в выводе harness. **Уверенность высокая.**

**Направление исправления:** определить, кто имеет право переносить уже занятых участников. Разрешить свободное добавление незанятых собственных children, а перенос из существующей комнаты сделать отдельным проверяемым действием. Одна room на сессию — продуктовый выбор; молчаливый межкомнатный перенос всем агентам из него не следует автоматически.

### S3. P2: `close_session` не проверяет заявленное согласие человека

**Доказательства:**

- `packages/core/src/mcp/tools.ts:446`: tool description требует explicit human consent.
- `.agents/skills/parley/SKILL.md:40`: то же правило в skill.
- `packages/core/src/mcp/tools.ts:956`: backend `closeSession`.
- `packages/core/src/mcp/tools.ts:965`: единственная authority-проверка — self либо descendant.
- `packages/core/src/mcp/tools.ts:970`: состояние сразу меняется на closed.
- `packages/core/src/mcp/tools.ts:243`: `destructiveHint:true` передает подсказку клиенту, но не дает серверу доказательства human action.

**Эффект:** Parley не может гарантировать, что постоянное исключение сессии из почты и auto-wake последовало за человеком, если модель нарушила инструкцию или клиент уже доверяет инструменту. Это особенно важно для автономных длинных цепочек.

**Воспроизводимость:** прямой MCP-вызов родителя закрывает synthetic child без поля согласия/идентификатора human decision; результат `isError:false`, lifecycle `closed`. **Уверенность высокая для backend; поведение каждого CLI approval flow не запускалось.**

**Направление исправления:** либо честно документировать prompt-only policy, либо ввести явный human approval record/capability на target и операцию, проверяемый хостом. Аналогично разделить «участники обсудили» и «человек разрешил исполнять»: `spawn_session` (`tools.ts:531`) не проверяет acceptance proposal, а room decision сам по себе не является execution gate.

### S4. P2: MCP annotations объявляют некоторые заменяющие операции только добавляющими

**Доказательства:**

- `packages/core/src/mcp/tools.ts:240`: общий `WRITES` — `destructiveHint:false`.
- Он назначен `report` (`:255`), `create_room` (`:373`), `add_to_room` (`:396`), `propose_decision` (`:427`).
- `report` перезаписывает summary и artifacts (`:511`), новая комната удаляет участников из прежних (`:872`), обновление proposal заменяет текст (`packages/core/src/work/proposals.ts:91`).
- Комментарий `tools.ts:231` прямо обосновывает non-destructive тем, что целые сущности остаются; это уже иная семантика, чем в MCP.

Актуальная официальная спецификация MCP на момент проверки определяет `destructiveHint:false` как только добавляющие обновления. Аннотации при этом остаются подсказками, а не гарантированным механизмом доступа: [MCP ToolAnnotations, revision 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/schema#toolannotations).

**Эффект:** доверенный CLI может выбирать менее строгий approval flow по неверному обещанию. Сам факт обхода конкретного пользовательского approval диалога не проверялся. **Уверенность высокая в несовпадении с контрактом, средняя в влиянии на UX разных CLI.**

**Направление исправления:** классифицировать tools отдельно по реальным эффектам; не использовать annotations как замену собственной authorization. Для `spawn_session` учитывать запускаемую следом внешнюю агентную работу при выборе `openWorldHint` — это требует согласования с фактическим vendor approval behavior.

## Архитектурные границы, которые нельзя обещать пользователю сверх кода

### T1. Общая карта — общий доступ, приватных комнат нет

`packages/core/src/mcp/tools.ts:488` возвращает `readMap(...)` целиком, включая messages всех комнат и DM; при этом `readRoom` в `:909` проверяет membership. Harness подтвердил, что nonmember получает отказ второго API и тот же synthetic message первого. Это не дефект при намеренно общем доверенном проекте; иначе privacy-gate обходится штатным инструментом. Следствие для контекста: карта тащит и нерелевантную переписку, не только компактный каталог участников.

Рекомендуется либо закрепить эту семантику явно, либо разделить topology/status map и полномочные чтения conversation по участнику. Это также дает естественную точку ограничения контекстного объема.

### T2. Identity и human authority держатся на доверии к процессам одного пользователя

`packages/core/src/mcp/context.ts:46` получает project/work/session из env; `:64` принимает session ID как строку. MCP — отдельный stdio process (`mcp/server.ts:25`), но он сам читает/пишет проектную map (`mcp/tools.ts:504`, `:773`), не запрашивая session-scoped host capability. Directory token хоста защищает от другого UID, но авторизованному RPC после hello доступны все методы (`host/server.ts:122`, `:151`, `:177`); client name — строка, не роль.

Нормальное `send_message` не позволяет выбрать `from`: он выводится из контекста (`tools.ts:802`). Это полезная защита от ошибки аргументов. Однако агент с достаточным shell/filesystem доступом под тем же пользователем способен изменить карту, env/config и прочитать доступный пользователю host token. Поэтому room lead и human accepted — не криптографически доказанная изоляция между hostile agents. Для личного local harness это допустимый уровень доверия, если он так и описан. Worktree изолирует рабочую копию Git, не OS-права и не общую координационную карту.

### T3. Consent карточки proposal не означает блокировку исполнения

`packages/core/src/work/proposals.ts:65` проверяет lead/живость/длину; `:121` разрешает human answer, `:136` отвергает устаревший rev, `:142` очищает proposal, `:153` добавляет сообщения об acceptance. Это хороший transactional UI-flow, но нет разрешения исполнения, связанного с конкретной задачей/набором файлов/планом. `spawn_session` и `send_message` не проверяют proposal; backend контролирует переписку и метаданные, а содержимое поручения остается текстом. Для главной продуктовой цели важно не смешивать «согласованное предложение показано человеку» с «оркестратор технически запрещает работу до acceptance».

### T4. Codex policy принудительно переопределяется

Новая сессия всегда получает `-a on-request` (`packages/core/src/providers.ts:132`); комментарий `:124` прямо признает замену более строгой личной политики. Для resume флаг не передается (`:128`). Это не режим bypass, но меняет expectation пользователя; следует либо наследовать policy, либо явно показывать override и обеспечить одинаковую contract-семантику new/resume. Официальный контракт конкретной CLI-версии проверяет отдельная ветка vendor-аудита.

### T5. IPC sender validation отсутствует как дополнительная защита

`packages/desktop/src/main/ipc.ts:293` игнорирует event и вызывает все разрешенные host methods; `withIpcError` (`:32`) только кодирует ошибки. Поиск `senderFrame`, `validateSender`, `sender.getURL` в IPC/preload не выявил входной проверки происхождения. Официальные рекомендации Electron требуют валидировать sender всех privileged IPC: [Electron security, пункт 17](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages).

Это **hardening P2, не доказанный удаленный exploit**: гостевые webview лишены preload и Node, в основном renderer не найден путь исполнения произвольного HTML. При исправлении следует связывать caller с конкретным main window/main frame и проверять происхождение до host/files/browser действий.

### T6. Дополнительные копии содержимого и отсутствие приватного режима файлов состояния

`packages/core/src/work/settings-file.ts:31` сохраняет полный JSON ряда Claude hooks в project-local `events/<id>.jsonl` через `cat >>`; в список входит `UserPromptSubmit` (`:35`). `state-dir.ts:54` и `store.ts:158` создают папки/файлы с обычными правами умолчания (зависит от umask), без явных 0700/0600; `brief.ts:183` пишет стартовые инструкции тем же образом. Поэтому в проекте появляются дополнительные копии prompts/координации, доступность другим пользователям/синхронизации определяется ACL проекта, а не защищенным host dir. Наличие реальных секретов не проверялось и не утверждается.

Хорошо: новая `.parley` сама исключает содержимое из git (`state-dir.ts:31`, `:55`). Для расширения продукта стоит явно описать retention, локальную приватность и удаление копий; если обещается private-by-default, установить отдельные права состояния и минимизировать raw hook payload. Это P2 при чувствительных проектах/shared directories; для личного Mac без такого сценария — P3.

## Что сделано хорошо

- **Host transport:** случайный 32-byte token на каждый запуск; directory 0700, token 0600 (`host/host.ts:107`, `:128`); hello token check (`host/server.ts:103`), таймер незавершенного hello (`:48`), ограничение длины фрейма (`:54`), обработка socket error (`:78`).
- **HTTP hooks:** только `127.0.0.1` (`host/hooks/hook-server.ts:277`), 32-byte bearer на запуск сессии с отзывом прежнего (`:290`), session header (`:149`), max body 16 MiB (`:24`, `:164`). Токен передается env и не записывается literal в settings (`core/work/settings-file.ts:138`, `:141`; `host/sessions/sessions-service.ts:298`).
- **Human permission UI:** held hooks отвечают один раз; timeout/shutdown возвращают `{}`, не auto-allow (`host/hooks/pending.ts:68`, `:87`, `:131`). `allow/deny` строится из `FeedDecision`, иначе пустой ответ (`host/hooks/decisions.ts:39`). Это отличается от advisory room approval.
- **Proposal consistency:** revision check предотвращает принятие уже замененного текста (`core/work/proposals.ts:136`); повтор/старый ID конфликтует (`:131`).
- **Renderer:** contextIsolation и sandbox включены, nodeIntegration выключен (`desktop/main/window.ts:28`); CSP запрещает внешние scripts/connect и inline JS (`desktop/renderer/index.html:7`).
- **WebView:** снимается preload, отключаются Node workers/subframes, включается webSecurity (`desktop/main/browser/guard.ts:63`); навигация ограничена, окна перехватываются; session permissions и client certificate отказываются (`:189`, `:195`).
- **Файлы:** roots проверяются через realpath с учетом Unicode/case-sensitive volume (`desktop/main/roots.ts:76`, `:324`); запрет записи `.git`/`.parley`; `fs-api.ts:143` создает уникальный temporary file через `wx` и повторяет проверки. FIFO блокируются через `O_NONBLOCK` плюс regular-file check (`fs-api.ts:64`).
- **Открытие артефактов:** allowlist вместо исполнения произвольных `.app`, `.command`, `.py`, проверка x-bit и повторная inode/realpath сверка (`desktop/main/files/open-path.ts:15`, `:35`, `:76`).
- **Markdown:** `react-markdown` без `rehype-raw`; raw HTML не подключен как исполняемый контент (`desktop/renderer/components/rooms/RoomMarkdown.tsx:14`, mail/Letter.tsx:8`).

## Native CLI и учетные данные

Поиск credential/API access маршрутов по production `packages/core/src`, `packages/host/src`, `packages/desktop/src/main` не выявил чтения OAuth access/refresh token и собственного вызова Anthropic/OpenAI generation endpoints. Единственные production HTTP-клиенты обнаружены для локальных hooks, favicon встроенного браузера и проверки GitHub release.

Фактический запуск: `core/work/launch.ts:285` → `host/sessions/sessions-service.ts:280` разрешает бинарь → `:304` передает command/args/cwd/env → `host/pty/pty-process.ts:39` вызывает node-pty spawn. `core/codex/discover.ts:9` явно запрещает чтение соседнего auth.json и возвращает каталог sessions (`:15`). `core/providers.ts:451` лишь копирует окружение и убирает три parent-session marker Claude; не парсит учетные данные. Возможность переопределить binary поддерживается явно (`providers.ts:431`).

Вывод ограничен прочитанными source-маршрутами: это запуск пользовательских CLI с их собственной авторизацией. Не проверялось содержимое установленных vendor binaries, домашние credentials, условия тарифа и договорная допустимость автоматизации. Запуск CLI может наследовать пользовательские API env vars так же, как обычный терминальный запуск; это не extraction OAuth.

## Запущенные проверки и ограничения

### Собственный изолированный harness

Файлы рядом с отчетом:

- `security-probes.mts` — синтетические MCP/core/host-handler сценарии.
- `security-probes-tsconfig.json` — aliases на source `@parley/core`/`@parley/protocol`.
- `security-probes-output.json` — фактический успешный вывод.

Команда:

```sh
TSX_TSCONFIG_PATH=security-probes-tsconfig.json node --import /Users/kalmbik61/Desktop/MY/my_harnas/node_modules/tsx/dist/loader.mjs security-probes.mts
```

Результат exit 0. Проверки: nonmember map visibility, close без consent, room lead movement, traversal deletion. MCP подключен через InMemoryTransport; только synthetic temporary files; provider PATH очищен внутри harness, CLI не запускались, временное состояние в конце удалено.

Начальная попытка через executable `tsx` получила `EPERM` на собственной IPC pipe в sandbox до исполнения harness. Перезапуск через Node loader не требовал IPC-сервера и прошел. Escalation не запрашивалась.

### Существующие unit tests

Прочитаны перед запуском; используют mock webContents и fake timers, не открывают браузер/сеть/CLI:

```sh
node /Users/kalmbik61/Desktop/MY/my_harnas/node_modules/vitest/vitest.mjs run --config /Users/kalmbik61/Documents/Codex/2026-10-03/task/security-vitest.config.mjs
```

Конфигурация и вывод: `security-vitest.config.mjs`, `security-vitest-output.txt`. Cache выключен, cacheDir вне репозитория.

- `packages/desktop/src/main/browser/guard.test.ts` — 25 passed.
- `packages/host/src/hooks/pending.test.ts` — 7 passed.
- `packages/host/src/hooks/decisions.test.ts` — 6 passed.
- Итого **3 файла, 38 тестов, все passed**.

Не запускались live HTTP hooks, реальный host socket, GUI Electron, paid agents, OAuth flows и реальные vendor approvals. Системный аудит независимой уязвимости Electron/XSS не проводился. Файлы `.claude/worktrees` исключены из исследования. Подтвержденного пути remote unauthenticated RCE не найдено; это не доказательство его отсутствия.

## Приоритетный план без реализации

1. Закрыть S1 на границе protocol и внутри destructive core; сохранить regression на synthetic sibling directory.
2. Зафиксировать authority model: who may move members, close children, accept proposal и start work. Привести backend к обещаниям UI/skill либо явно уменьшить обещания.
3. Развести компактную карту участников и чтение переписки; решить, общие ли комнаты и DM в рамках одной работы. Это одновременно снижает лишний контекст.
4. Исправить MCP annotations по эффектам; проверить их на поддерживаемых версиях Claude/Codex отдельно от unit tests.
5. Добавить IPC sender guard и заранее выбранную политику Codex approval overrides.
6. Формализовать локальное хранение hooks/briefs/messages: права, retention, редактирование чувствительного payload, пользователю понятные пути удаления.
7. Только если нужны недоверенные агенты: перенос mutation authority в host с session-scoped capabilities и отдельной OS-изоляцией. Одни worktrees и env session IDs такой модели не обеспечивают.


---

# ДОКУМЕНТ: orchestration-audit.md

# Parley: аудит комнат, оркестрации и восстановления

Дата: 2026-10-03. Проверенный корень: `/Users/kalmbik61/Desktop/MY/my_harnas`. Все ссылки `packages/...:line` ниже относятся к этому корню. Исходники, настройки и пользовательские данные не изменялись. Агентные CLI не запускались. Тестовые записи создавались только во временных каталогах.

**Главный вывод.** Реализован работающий транспорт координации поверх нативных CLI: комнаты, ведущий, адресные и общие сообщения, карточка предложения человеку, пробуждение через терминал, возобновление сессий, история и отчёты. Это не законченный исполнитель задач с формальной моделью согласования и гарантированной доставкой. Разрешение начать работу, сбор позиций, раздача частей, человеческое согласие на закрытие и сдача общего результата в значительной мере зависят от инструкций модели. Наиболее существенные подтверждённые дефекты — невосстанавливаемые блокировки после аварии, отсутствие отката уже запущенного процесса при ошибке записи его состояния и отсутствие общего бюджета размножения сессий.

Проверено восемь дополнительных сценариев на временных данных; все подтвердили описанные механизмы. Из 351 выбранного штатного теста все прошли с учётом повторного запуска двух файлов вне ограничения на `ps`. Первые шесть ошибок оказались свойством аудиторской песочницы, а не обнаруженными регрессиями продукта.

**1. Реальный маршрут комнаты.**

| Действие | Код и фактическое поведение |
|---|---|
| Человек собирает комнату | `packages/host/src/rooms/rooms-service.ts:71`: `createHumanRoom` проверяет сессии и ведущего под `updateMap`, исключает участников из остальных комнат этой работы, пишет приглашения, если не задан `quiet`. |
| Общая задача или адресное письмо | `packages/host/src/rooms/rooms-service.ts:108`: `sendHumanLetter`; пустой `to` в комнате — рассылка, непустой — адресное сообщение участникам. |
| Агент пишет | `packages/core/src/mcp/tools.ts:760`: `sendMessage`; проверка членства, адресатов, `replyTo`, часового лимита, затем запись сообщения. |
| Ведущий предлагает решение | `packages/core/src/mcp/tools.ts:920` → `packages/core/src/work/proposals.ts:65`: только текущий `liveLead`, непустой текст не длиннее 10 000 символов. Повтор обновляет `rev` того же предложения. |
| Человек принимает или возвращает | `packages/host/src/rooms/rooms-service.ts:161` → `packages/core/src/work/proposals.ts:120`: проверка `proposalId` и переданной версии, очистка слота и запись сообщений одной мутацией карты. При принятии — решение комнате, системная строка и письмо ведущему `Decision accepted.`. |
| Ведущий добавляет участника | `packages/core/src/mcp/tools.ts:881` → `packages/core/src/work/rooms.ts:192`: право ведущего проверяется кодом; сессия уходит из прежней комнаты. Автоматическое приглашение новому участнику не пишется; руководство требует отдельного сообщения от ведущего (`guide.ts:201–208`). |
| Доставка живому агенту | `packages/core/src/work/delivery.ts:91` решает по активности, черновику, паузе, хукам и уже указанным сообщениям; `packages/host/src/wake/wake-service.ts:366` печатает указатель в PTY. Сами сообщения забираются через MCP. |
| Возобновление спящего | `wake-service.ts:316` использует `resumeArgs` провайдера и известный `providerSessionId`; новый процесс запускает `sessions-service.ts:204`. |
| Итог | `packages/core/src/mcp/tools.ts:493`: `report` записывает резюме/артефакты и отдельно результат `done`/`failed`; это заявление агента, не проверка результата и не человеческая приёмка. |

**2. Подтверждённые замечания.** Приоритет P1 — исправить перед длительной автономной работой; P2 — следующий обязательный слой надёжности/предсказуемости. Уверенность относится к механизму в коде; поведение реальной модели не имитировалось.

**O1 — P1. Авария писателя навсегда оставляет блокировку карты; такая же схема используется глобальным индексом.**

- Место: `packages/core/src/work/store.ts:110–139`, `store.ts:237–247`, `store.ts:389–405`.
- Механизм: блокировка — пустой файл, создаваемый `open(..., 'wx')`. Освобождение только в `finally`. PID, время старта и владелец в файл не записываются; при `EEXIST` код только ждёт и выдаёт `MapLockTimeoutError`. Обнаружение и безопасное снятие осиротевшей блокировки отсутствуют. Это отличается от хорошо проработанного `host.pid` в `packages/host/src/host.ts:406–465`, где есть владелец и восстановление после аварии.
- Эффект: SIGKILL, падение Node или выключение машины во время записи оставляют `map.lock`, после чего письма, отчёты и принятие решений этой работы перестают записываться даже после перезапуска. Осиротевший `works-index.lock` влияет на мутации всех работ, поскольку любой `updateMap` обновляет индекс.
- Воспроизведение: отдельный наш дочерний Node-процесс захватил реальный `updateMap` на временной карте и сообщил о захвате. После SIGKILL две новые попытки получили `MapLockTimeoutError`; файл остался. Глобальный вариант следует из общей реализации `withLock`, отдельно SIGKILL для него не выполнялся.
- Уверенность: высокая. Исправление: единый протокол владельца блокировки и восстановления, защищённый от удаления блокировки нового владельца; тесты аварии отдельно для карты и индекса.

**O2 — P1. Ошибка записи старта не останавливает уже запущенный процесс.**

- Место: `packages/host/src/sessions/sessions-service.ts:303–330`; `packages/core/src/work/launch.ts:478–499`.
- Механизм: сначала вызывается `pty.start`, затем асинхронно `startSession` записывает PID и `active`. Если запись не удалась, ошибка возвращается вызывающему, но нет `pty.stop` или другого компенсирующего действия. Внешний `finally` только удаляет запись из `launching`.
- Эффект: интерфейс/будильник получает ошибку запуска, карта остаётся `pending` с `pid: null`, хотя агент уже получил бриф и начал процесс. Это нарушает согласованность между процессом, оплатой/лимитом CLI, картой и управлением сессией. O1 создаёт прямой воспроизводимый триггер.
- Воспроизведение: временная карта с осиротевшей блокировкой; реальный `SessionsService` и подставной PTY, который только записывает вызовы и не исполняет программу. Результат: `MapLockTimeoutError`, `startCalls=1`, `stopCalls=0`, ручка PTY остаётся живой, в карте `pending` и `pid=null`.
- Уверенность: высокая для пути отказа и отсутствия отката; настоящий оплачиваемый процесс не запускался. Исправление: оформлять запуск как операцию с устойчивым промежуточным состоянием; при невозможности подтвердить старт останавливать именно созданный процесс и завершать очистку регистрации хуков.

**O3 — P1. Лимиты писем и пробуждений не ограничивают создание новых сессий и общий расход комнаты.**

- Место: `packages/core/src/mcp/tools.ts:208–217`, `tools.ts:531–627`, `tools.ts:837–877`; `packages/core/src/config.ts:61–64`; `packages/host/src/sessions/auto-launch.ts:16–29`; `sessions-service.ts:529–559`.
- Механизм: `messageRate` проверяется только в `sendMessage`. `createRoom` напрямую добавляет приглашение каждому участнику без `assertRate`. `spawnSession` проверяет провайдера, модель, роль и worktree, затем добавляет дочернюю запись; ограничений числа/глубины/частоты создания, конкурентных процессов и бюджета комнаты здесь нет. Хост при `autoLaunch=true` (значение по умолчанию) запускает каждую новую дочернюю `pending`-сессию. `resumeRate` применяется к возобновлениям через будильник, не к новым запускам.
- Эффект: даже при корректной переписке ведущий может породить много исполнителей, каждый со своим лимитом сообщений. Часовые лимиты не дают общей границы расхода подписки. Это конкретный пробел политики ресурсов, а не доказательство того, что любая модель обязательно уйдёт в бесконечный цикл.
- Воспроизведение: `messageRate=1`; второе обычное письмо отклонено, но последующий `create_room` успешно добавил второе исходящее сообщение-приглашение. После исчерпания лимита 12 последовательных `spawn_session` успешно создали 12 дочерних `pending`-сессий. Хост не запускался, ни один CLI не исполнялся.
- Уверенность: высокая. Исправление: общий бюджет работы/комнаты, максимальная конкурентность, число/глубина новых сессий и явное разрешение на расширение бюджета; проверять все пути генерации сообщений/работы, а не один инструмент.

**O4 — P2. Адресаты рассылки пересчитываются по нынешнему составу комнаты.**

- Место: `packages/core/src/work/letters.ts:10–26`; `packages/core/src/work/rooms.ts:112–124`, `rooms.ts:143–167`.
- Механизм: у рассылки сохранено `to: []`; `recipientsOf` при каждом чтении берёт текущие `room.creator` и `members`. Момент вступления участника и снимок адресатов сообщения не хранятся.
- Эффект: добавленный посреди работы агент получает прежние общие задания/решения как непрочитанные входящие; перемещённый в другую комнату агент перестаёт быть адресатом ещё не забранных рассылок прежней комнаты. История и новая входящая работа смешиваются. Для заявленного сценария добавления участника посреди задачи это существенная неоднозначность: агент может повторно интерпретировать старое поручение как текущее.
- Воспроизведение: до добавления S03 его входящие пусты; после `addMember` там появляется `OLD TASK — before newcomer joined`. S02, которому та же рассылка изначально адресовалась, после перевода в другую комнату получает пустой inbox.
- Уверенность: высокая. Исправление: сохранять получателей при отправке либо вводить границу входящих по вступлению; историю выдавать отдельно как контекст, явно помечая её как историю.

**O5 — P2. Auto-wake paused не отменяет уже запланированный Enter; это также не аварийная остановка работы.**

- Место: `packages/host/src/wake/wake-service.ts:366–409`, `wake-service.ts:653–663`; `packages/host/src/pty/type-and-submit.ts:83–122`; `packages/host/src/methods/wake.ts:20–32`.
- Механизм ошибки: `pause()` только ставит флаг и рассылает событие. Уже созданный `typeAndSubmit` продолжает таймер. Его `beforeEnter` проверяет `blocked`, но не `isPaused`.
- Воспроизведение: подставной PTY записал указатель, затем вызван `wake.pause()`, затем тот же PTY получил `\r` при `paused=true`. Никакой CLI при проверке не запускался.
- Эффект: один уже подготовленный ход может стартовать после включения паузы. Важно не смешивать этот дефект с контрактом кнопки: даже после его исправления пауза доставки сама по себе не должна считаться остановкой уже выполняющегося агентного хода. Автозапуск новых дочерних сессий — отдельный путь `sessions-service.ts:529–559`, который не проверяет флаг wake. Пауза хранится только в памяти (`wake-service.ts:163`).
- Текущие способы остановки: `sessions.stop` останавливает конкретный PTY (`sessions-service.ts:456`), сессия затем спит и может проснуться от нового письма; `sessions.close` останавливает и переводит в `closed` (`:464`); `stopAll` используется при выключении хоста (`:582`, `packages/host/src/host.ts:209`). Отдельного подтверждённого общего состояния «эта комната остановлена и не может породить/возобновить работу» в изученной модели нет.
- Уверенность: высокая. Исправление: отменять неотправленные попытки на паузе; отдельно определить и реализовать общий Stop для комнаты/работы, блокирующий новые запуски и доставку до явного Resume.

**O6 — P2. Доставка не имеет подтверждения обработки; сбой ответа или один пропущенный указатель оставляет поручение без автоматического повтора.**

- Место: `packages/core/src/mcp/tools.ts:825–834`, `tools.ts:1119–1125`; `packages/host/src/wake/wake-service.ts:392–433`; `packages/core/src/work/delivery.ts:112–114`.
- Механизм: `check_inbox` помечает все входящие прочитанными внутри записи карты до формирования/доставки MCP-ответа. Подтверждения от агента нет. Будильник, в свою очередь, добавляет сообщения в `pointed` при печати указателя; после таймаута, отмены человеком или появления blocked повторный набор для тех же писем не производится.
- Эффект: потерянный MCP-ответ после успешной записи означает, что повтор `check_inbox` уже не вернёт эти сообщения; обращение к истории может восстановить контекст, но автоматической гарантии обработки нет. После несработавшего указателя письма остаются непрочитанными и видимыми человеку, однако агент может не продолжить без нового события/письма или ручного вмешательства. Отказ от повторного Enter после ввода человека имеет понятную защитную причину; проблема — отсутствие другого пути подтверждения/восстановления.
- Проверка: первый `check_inbox` вернул 3 сообщения, повтор — 0; фактический обрыв транспорта в этом прогоне не моделировался. Порядок записи до ответа доказан чтением кода. Однократность указателя явно описана реализацией и README.
- Уверенность: высокая в механизме, условная в частоте полевых сбоев. Исправление: отличать `announced`, `delivered`, `acknowledged/handled`; выдавать стабильную пачку по receipt/cursor и отдельное подтверждение. Для таймаутов предусмотреть безопасный способ повторного уведомления и ручной Retry без повторного исполнения задачи.

**O7 — P2. `closed` не является общей проверяемой границей полномочий MCP-сессии.**

- Место: `packages/core/src/mcp/tools.ts:168–171`, `tools.ts:600–625`, `tools.ts:773–778`, `tools.ts:847–875`, `tools.ts:978–1000`; для сравнения корректная проверка `report` — `tools.ts:505–510`.
- Механизм: `send_message`, `create_room` и `spawn_session` требуют существование вызывающей сессии, но не запрещают `lifecycle: closed`. Общего `requireLiveCaller` в dispatch нет. `close_session` проверяет родство, а подтверждение человека — текстовое требование/аннотация инструмента, не серверное доказательство согласия (`tools.ts:956–971`).
- Эффект: пока MCP-транспорт закрытого агента ещё существует, он может писать и порождать работу. В GUI окно риска обычно ограничивает обработчик `stopClosed` (`sessions-service.ts:508–526`), который останавливает PTY по обновлению карты; это не заменяет запрет в самом инструменте, особенно при конкурентных вызовах или недоступном хосте.
- Воспроизведение: после успешного `close_session` тот же ID через MCP успешно отправил письмо и создал ребёнка. Проверка не изображает обычный живой GUI-процесс после его остановки; она непосредственно показывает отсутствие серверной проверки.
- Уверенность: высокая. Исправление: централизованная проверка вызывающей сессии под той же блокировкой, что и мутация; определить разрешённые чтения после закрытия отдельно.

**O8 — P2, документация/контракт. Адресное сообщение не является приватным.**

- Место: `packages/core/src/work/guide.ts:141–143` обещает для `to` “seen only by those named”; `packages/core/src/mcp/tools.ts:473–490` отдаёт всю карту, `tools.ts:913–917` отдаёт всю ленту выбранной комнаты, без фильтра по адресатам.
- Эффект: `to` управляет inbox/пробуждением, а не видимостью. README описывает видимость всей ленты участникам точнее. Даже проверка членства `read_room` не делает комнаты конфиденциальными друг от друга, поскольку `get_map` отдаёт карту целиком.
- Проверка: статический полный маршрут ответа; отдельный сценарий обхода конфиденциальности не запускался, поскольку весь return-объект виден непосредственно в коде.
- Уверенность: высокая. Исправление: честно назвать адресность уведомлением; если требуется разграничение доступа — фильтровать все чтения и модель доступа последовательно.

**3. Что обеспечено кодом, а что пока является соглашением с моделью.**

| Свойство | Статус |
|---|---|
| Только ведущий создаёт карточку решения | Обеспечено `setProposal` через `liveLead`. |
| Только ведущий добавляет участника через `add_to_room` | Обеспечено `addMemberByLead`. Но любой агент может создать новую комнату с существующими участниками и тем самым перевести их из старой — `tools.ts:837–877`; полномочие на такой перевод отдельно не ограничено. |
| Устаревший/повторный Accept не применяется дважды | Обеспечено для `proposalId` и переданной `rev`, под одной блокировкой. `rev` остаётся необязательной для совместимости (`proposals.ts:99–106`); актуальному клиенту необходимо всегда передавать её. |
| Все участники согласились | Не является проверяемым условием. Руководство разрешает ведущему при долгом молчании предложить решение по имеющимся позициям (`guide.ts:172–175`). Это управляемое ведущим обсуждение, не кворумный консенсус. |
| Нельзя писать файлы/создавать исполнителей до Accept | Текстовая инструкция `guide.ts:183–198`; proposal не является capability gate для vendor tools или `spawn_session`. |
| Человек принимает готовый результат | В изученной механике карточка в первую очередь принимает план и распределение ролей, после чего начинается работа (`guide.ts:176–196`). `report(done)` — самодекларация агента. Отдельное автоматическое доказательство качества или обязательная финальная приёмка артефактов этим маршрутом не обеспечены. |
| Повторная задача существующей сессии имеет собственный результат | Нет идентификатора задания/итерации в `WorkSession.result`. `wait_for(target)` возвращает любой уже имеющийся результат (`tools.ts:61–65`, `:684–703`); руководство прямо предупреждает после повторного поручения ждать inbox (`guide.ts:117–119`). Для постоянных комнат это ограничение модели задач. |
| Смена ведущего при недоступности | Смена только при closed/удалении. `isAlive` в `rooms.ts:80–82` значит «существует и не closed», поэтому sleeping/pending тоже удерживают лидерство (`:105–109`). Это не проверка готовности процесса или срока ответа. |
| Закрытие только по согласию человека | Prompt rule и destructive annotation; отдельной серверной записи согласия нет. |

**4. Сильные стороны текущей реализации.**

- Основные правила комнаты вынесены в core и повторно используются хостом и MCP, что уменьшает расхождение поведения интерфейса и агентов.
- Атомарная замена файла карты, резервная предыдущая версия и блокировка защищают от обычного конкурентного lost update (`store.ts:155–160`, `:389–405`). Ошибки различаются: конфликт предложения, нарушение правила комнаты, отсутствие работы, занятая блокировка.
- Proposal ID и revision — хорошая защита от принятия уже изменившегося текста; два Accept не дублируют сообщение (`proposals.ts:129–160`).
- Жизнь процесса отделена от результата: `report(done)` не уничтожает сессию, которую затем можно использовать в комнате. Запрет возобновления closed проверяется самим launch (`sessions-service.ts:218–222`).
- Будильник проверяет активность, ввод человека, наличие свежих хуков и blocked; перед отправкой повторно проверяется состояние процесса. Codex получает отдельный путь вставки/очереди, а не общий Enter для всех.
- Есть диагностические причины ожидания (`busy`, `draft`, `no-hooks`, `resume-limit`, `pointed`), предупреждения о таймауте указателя и неудачном resume (`wake-service.ts:220–239`, `:263–309`). Это полезная основа расследования зависших комнат.
- На старте хоста старые непрочитанные сообщения не поднимают спящих автоматически (`wake-service.ts:253–261`), а pending, существовавшие при первом чтении, не получают autoLaunch. Это снижает риск неожиданного платного продолжения после перезапуска.
- Liveness использует PID вместе со временем старта ОС; тесты этой части прошли после снятия аудиторского запрета на `ps`.

**5. Приоритетный план без реализации.**

1. Исправить O1/O2 как одну цепочку восстановления: владелец и безопасное снятие stale lock, аварийные тесты карты/индекса, rollback процесса при незафиксированном старте. Критерий: после SIGKILL одного писателя следующая безопасная запись проходит, а неуспешный launch не оставляет работающий неучтённый PTY.
2. Ввести общую политику ресурсов: лимит активных процессов, число/глубина spawn, budget работы, обработка приглашений; показывать человеку запланированное расширение. Критерий: ограничение выдерживается всеми MCP/host-путями и не сбрасывается созданием новой дочерней сессии.
3. Определить Stop/Pause/Close на уровне продукта. Пауза должна гарантированно отменять неотправленные указатели; общий Stop должен блокировать новые запуски и возобновления и иметь понятную судьбу уже выполняющихся команд.
4. Зафиксировать адресатов сообщений на момент отправки, отделить исторический контекст от поручений новым участникам; добавить task/assignment ID для повторного использования сессий и результатов.
5. Добавить подтверждение доставки/обработки, идемпотентные повторные вызовы, явно ограниченные retry и удобное восстановление человеком. Не использовать прочтение карты как доказательство того, что модель обработала задачу.
6. Централизовать полномочия: закрытый вызывающий, перевод участников между комнатами, план/исполнение/финальная приёмка. Если product остаётся «мягким координатором», точно назвать эти ограничения; если нужен формальный gate, он должен существовать в исполнении, а не только в guide.
7. Закрепить контрактные тесты реальных CLI отдельно от unit-тестов: подготовка/blocked/очередь/прерывание/resume. В этом аудите платные CLI не запускались, и наблюдения о реальных версиях вендоров должны поступить из отдельной проверки официальных контрактов и контролируемого smoke-теста с разрешения владельца.

**6. Проверки, артефакты и ограничения.**

Дополнительный воспроизводитель: [parley-orchestration-repro.mts](/Users/kalmbik61/Documents/Codex/2026-10-03/task/parley-orchestration-repro.mts), конфигурация импортов [parley-orchestration-tsconfig.json](/Users/kalmbik61/Documents/Codex/2026-10-03/task/parley-orchestration-tsconfig.json), результаты [parley-orchestration-repro-results.json](/Users/kalmbik61/Documents/Codex/2026-10-03/task/parley-orchestration-repro-results.json). Итог: 8 сценариев прошли. Fake PTY только регистрирует вызовы; availability провайдера подставлена `/usr/bin/true`, но через PTY эта программа тоже не запускается. Единственный аварийно завершённый процесс — созданный воспроизводителем Node, держащий временную блокировку.

Команда:

```sh
TSX_TSCONFIG_PATH=./parley-orchestration-tsconfig.json node --import /Users/kalmbik61/Desktop/MY/my_harnas/node_modules/tsx/dist/loader.mjs ./parley-orchestration-repro.mts
```

Выбранные существующие тесты: MCP server 153, store 43, rooms 44, proposals 40, delivery 31, liveness 16, letters 16, lease 8 — всего 351. Первый прогон: 345 passed, 6 failed; все шесть зависели от получения времени процесса через запрещённый песочницей `ps`. Отдельная read-only команда `ps -o lstart= -p $$` подтвердила `operation not permitted`. Разрешённый повтор liveness и lease: 24/24 passed. Таким образом, 351 уникальный тест прошёл в соответствующем допустимом окружении, но это не один исходно полностью зелёный прогон.

Конфигурация запуска находится в [parley-core-audit-vitest.mts](/Users/kalmbik61/Documents/Codex/2026-10-03/task/parley-core-audit-vitest.mts), журнал первого прогона — [parley-core-audit-vitest-results.txt](/Users/kalmbik61/Documents/Codex/2026-10-03/task/parley-core-audit-vitest-results.txt), успешный повтор — [parley-core-audit-liveness-unsandboxed.txt](/Users/kalmbik61/Documents/Codex/2026-10-03/task/parley-core-audit-liveness-unsandboxed.txt). Cache направлен в `/tmp`, тестовые home/project — во временные каталоги штатным setup.

Воспроизводитель импортирует актуальные исходники через TSX aliases: обычный импорт `@parley/core` из host в имеющейся локальной установке не разрешился. Для аудита не выполнялись install/build и не исправлялись package links. Это ограничение проверочного окружения, не самостоятельное доказательство дефекта релизного приложения. Нативные GUI/e2e, реальный CLI, стоимость токенов и актуальные внешние vendor contracts в этой части не проверялись. Секреты и пользовательские транскрипты не читались и не включены в отчёт.


---

# ДОКУМЕНТ: parley-ux-audit.md

# Parley: аудит цельного сценария Agentic DE

Дата: 3 октября 2026. Область: GUI и сценарии команды. Исходники: `/Users/kalmbik61/Desktop/MY/my_harnas`. Аудит только чтением; приложение, host, реальные CLI и платные сессии не запускались, исходники/данные не менялись. В рабочем дереве есть промежуточные незакоммиченные файлы; выводы относятся к прочитанному состоянию, а не обязательно к последнему релизу. Работу других активных сессий не трогали.

## Главное

По коду Parley уже представляет связную среду ежедневной работы с командой агентов: создать workspace; запустить участников разных провайдеров; выбрать ведущего; обсуждать в комнате; писать всем или выбранным участникам; получать решения и возвращать их на доработку; переходить в native terminal/Claude Chat; смотреть diff, коммитить, разбирать конфликты и сливать worktree. Это существенно больше набора отдельных MCP-команд. Наличие функций подтверждено исходниками и существенным набором GUI/E2E-тестов, но реальная удобность и надёжность пары Claude+Codex в этом аудите не измерялись.

Обнаружен воспроизведённый дефект именно главной функции: восстановление черновика может без изменения текста переключить получателей с broadcast на одного агента. Ещё два подтверждённых по коду дефекта: текст неудачной отправки теряется, если уже начато следующее сообщение/закрыта вкладка; ошибки остановки и возобновления сессии невидимы пользователю.

«Accept» комнаты означает принять текст решения ведущего. Эта операция не означает проверить/слить конкретный diff, остановить команду или пометить workspace завершённым. Полноценная сдача результата складывается из нескольких отдельных интерфейсов. Это важно объяснять на демо, не выдавая отсутствие общей транзакции за сломанную существующую кнопку.

Техническое условие «работает сразу»: native `claude`/`codex` уже установлены и авторизованы; app находит их в login-shell PATH. Встроенного установки/входа в провайдера нет. README прямо обозначает эти границы. Бесплатность harness не свидетельствует о бесплатности моделей или отсутствии лимитов подписки.

## Матрица сценариев

| Сценарий | Что действительно есть | Граница / доказательство |
|---|---|---|
| Первый проект | Landing → New workspace → выбор папки, провайдера, названия/первого prompt | `shell/Landing.tsx:23`, `sidebar/NewWorkComposer.tsx:204,217,265`. Новый workspace обязательно запускает первую одиночную сессию; это ещё не команда. |
| Новая команда | New session or room, Add agent, ведущий звездой, выбор модели/effort по возможностям провайдера, own worktree | `components/dialogs/NewSessionOrRoomDialog.tsx:290–348,419–499`. N CLI запускаются последовательно без задачи; комната создаётся после успеха всех. |
| Команда из идущих сессий | Drag session onto session → MergeRoomDialog; drag session onto room → add member | `sidebar/RoomRow.tsx:32`, E2E `rooms-dialogs.spec.ts:170`. Путь только перетаскиванием, keyboard/menu альтернатива пока TODO (`TODOS.md:342–346`). |
| Общая задача | Сообщение без mention-чипов → `to:[]` → всем участникам | `components/rooms/Composer.tsx:149–164,235`, `RoomPanel.tsx:288–305`. Это обычное сообщение note, не отдельная версионированная сущность задания. |
| DM / subset | Выбрать участника в меню @; чипы определяют `to[]`, явная подпись To everyone / To S02 | `Composer.tsx:140–146,235–236`, `mention-editor.ts:39–64`. Найден дефект round trip текста, см. UX-1. «Адресное» не следует рекламировать как криптографически/файлово приватное. |
| Дополнить задачу во время работы | Поле комнаты доступно; сообщения имеют статус picked up / waiting с причинами | `RoomPanel.tsx:288`, `feed-model.ts:323–332`, `RoomMessage.tsx:149–169`. Picked up означает чтение inbox, а не доказанное исполнение новой инструкции. |
| Следить за агентами | Participant strip, статусы, занятость, субагенты, click → сессия; needs-you, уведомления/фокус | `RoomBody.tsx:44–50`, `RoomPanel.tsx:88–94`, `attention/notify.ts:177–199`. Хорошая операционная видимость; не измеряет качество рассуждений. |
| Вмешаться | Открыть native terminal, отправить текст; у поддерживаемого Claude Chat — разрешения, вопросы, планы и Stop | `chat/ChatView.tsx:187–207,278–287,324–338`; E2E `chat-hooks.spec.ts:609,632`. Codex остаётся в terminal; единый Chat UX не симметричен по вендорам. |
| Остановить | Сессию — context menu Stop + confirm; Claude Chat turn — Stop/interrupt | `sidebar/SessionRowMenu.tsx:121–123,144–150`, `ChatView.tsx:278–287`. Общей кнопки Stop team / Pause room в прочитанных RoomPanel/Header/Row нет; ошибки скрыты (UX-3). |
| Разногласия | Лента сообщений, цитаты с переходом, ведущий предлагает текст решения, Return for rework | `RoomMessage.tsx:75–95`, `RoomPanel.tsx:307–327`. Нет отдельного реестра позиций/голосов/неразрешённых возражений; консенсус не проверяется системой. |
| Принять решение | Карточка Accept/Return; id+rev защищают от принятия уже заменённого текста; история decisions | `RoomPanel.tsx:308–325`, `DecisionCard.tsx:57–69,100–107`, `core/src/work/proposals.ts:121–161`. Это сильный механизм целостности текста решения. |
| Проверить фактический результат | Changes по выбранной сессии, project/worktree diff, commit list, конфликтные файлы, Ask agent, commit/merge | `review/ChangesPanel.tsx:193–258,279–301`, `review/state.ts:29–38`, `PrimaryAction.tsx:125–187`. Для общей папки честное предупреждение, что изменения принадлежат не только этой сессии. |
| Сдать итог проекта | Отдельно принять решение; отдельно проверить/commit/merge нужные worktree; отдельно Mark done | `core/src/work/proposals.ts:151–160`, `review/PrimaryAction.tsx:125–165`, `sidebar/CardMenu.tsx:187–194`. Нет общего связанного review-пакета с snapshot SHA, тестами и артефактами. |

Все пути таблицы относительно `packages/desktop/src/renderer`, кроме явно обозначенных E2E, core и TODOS.

## Существенные замечания

### UX-1 — P2, обязательно исправить перед демонстрацией адресации: получатели черновика меняются при восстановлении

**Места:** `packages/desktop/src/renderer/components/rooms/mention-editor.ts:34–64,119–136`; `Composer.tsx:107–114,129–135,159–163`.

**Механизм:** `readEditor` получает recipients исключительно из DOM-чипов. Ручной/вставленный текст `@s02` не адресат. Черновик хранит только текст; `fillEditor` затем превращает любой распознанный `@s02` в чип существующего участника. Тип исходного ввода не сохраняется. Восстановление вызывается при remount/смене комнаты и после отказа отправки.

**Эффект:** без редактирования содержания broadcast становится DM/subset. Часть команды пропускает общую задачу или её уточнение. Если исходное сообщение содержало чип одному участнику и простой текст о другом, recipients могут также расшириться. Это нарушение семантики маршрутизации, а не просто оформление mentions.

**Воспроизведение:** локально выполнены реальные `mention.ts` и `mention-editor.ts` после TypeScript transpile в jsdom. Только неиспользуемый в маршрутизации formatter `sessionTag` подставлен для обхода сломанного package-resolution рабочей среды. Вход `Всем: @s02 проверит API, остальные пишут тесты`: перед сериализацией `{to:[]}`; после `fillEditor` `{to:['s-02']}`; `unchangedText:true`. Результат приложен в `parley-ux-routing-repro.json`.

**Уверенность:** высокая, исполнено. Полный Electron сценарий не запускался. **Рекомендация:** хранить адресатов/структуру отдельно от текста либо одинаково разбирать текст до отправки и после восстановления; гарантировать round-trip invariant recipients+text; добавить регрессии tab switch, retry и pasted text.

### UX-2 — P2: неудачно отправленный текст может исчезнуть без возможности повтора

**Места:** `packages/desktop/src/renderer/components/rooms/Composer.tsx:155–164`; `store/ui.ts:224–232`; существующий тест `Composer.test.tsx:823–833`. Аналогичный путь Chat: `chat/ChatView.tsx:192–207`.

**Механизм:** до завершения `rooms.send` очищаются DOM и draft-store. При reject восстановление производится только если редактор ещё смонтирован и пуст. Пользователь успел начать следующее сообщение или ушёл из вкладки — старый текст нигде не сохранён. Тест осознанно проверяет, что второе сообщение не затирается, но не проверяет сохранение первого. В Chat draft хранится независимо от вкладки, но новое сообщение также подавляет восстановление старого, а queued-элемент удаляется.

**Воспроизведение:** отложить reject `onSend`, отправить длинное A, набрать B или сменить вкладку, завершить reject; A не возвращается и не становится failed-outbox элементом. Существующий unit-test подтверждает ветку B; отдельный React/Electron прогон в этом аудите не запускался.

**Эффект:** потеря подготовленной общей задачи/уточнения при ошибке хоста. **Уверенность:** высокая по коду. **Рекомендация:** хранить in-flight/failed сообщения по id отдельно от draft и давать Retry/Copy/Edit; не восстанавливать путём перезаписи другого черновика.

### UX-3 — P2: пользователь не узнаёт об отказе Stop/Resume/Close/Delete

**Места:** `packages/desktop/src/renderer/sidebar/SessionRowMenu.tsx:63–66,118–125,144–168`; `chat/ChatView.tsx:280–287`.

**Механизм:** rejected IPC завершается только `console.warn`. Stop confirm закрывается, отдельной ошибки/Retry нет. Chat Stop также не показывает reject. Комментарий «строка сама покажет исход» недостаточен: при отказе строка может остаться прежней без причины.

**Эффект:** ложная уверенность, что вмешательство доставлено, либо ощущение неработающего UI; особенно заметно при остановке модели, продолжающей выполнять инструменты. **Воспроизведение:** заставить bridge.call('sessions.stop'/'feed.interrupt') вернуть ошибку; в GUI ошибка не создаётся. **Уверенность:** высокая, статическая. **Рекомендация:** явное pending/result состояние, toast/inline error+retry, подтверждение фактической остановки. Командный Stop/Pause проектировать отдельно: нельзя утверждать, что individual Stop отсутствует.

### UX-4 — P2, смысл интерфейса: «collected positions» не подтверждается данными

**Места:** `packages/desktop/src/shared/strings.ts:991`; `renderer/attention/notify.ts:131–170`; `packages/core/src/work/proposals.ts:65–92`.

**Механизм:** новый proposal автоматически вызывает уведомление «S01 collected positions». Core проверяет живую комнату, право ведущего и непустой текст. Наличие ответов остальных, разногласия и завершение обсуждения не проверяются.

**Эффект:** UI заявляет о состоявшемся сборе мнений сильнее, чем хранилище способно доказать. Не значит, что агенты никогда не согласуют решение; это означает зависимость от их поведения и инструкций. **Воспроизведение:** ведущий вызывает propose_decision сразу в пустой комнате — код допускает, уведомление то же. **Уверенность:** высокая по коду. **Рекомендация:** нейтральное «Lead proposed a decision» или реальные ссылки на позиции участников/открытые возражения.

### UX-5 — P2, продуктовая граница: принятие решения не связано с принятой версией артефактов

**Места:** `packages/core/src/work/proposals.ts:121–161`; `packages/desktop/src/renderer/review/ChangesPanel.tsx:193–258`; `review/PrimaryAction.tsx:125–165`; `sidebar/CardMenu.tsx:187–194`.

**Механизм:** Accept дописывает сообщения и очищает proposal. Diff/review выбранной сессии, commit/merge и done — независимые действия. Proposal не фиксирует reviewed SHA, список артефактов, результаты проверок или факт остановки писателей.

**Эффект:** пользователю нужно самому свести текст решения с конкретными изменениями; команда может продолжать менять файлы после принятия текста. Это допустимый ранний дизайн, но пока не доказанная «сдал задачу команде → принял проверенный итог» атомарная цепочка.

**Уверенность:** высокая как ограничение, не утверждение о порче данных. **Рекомендация:** следующий этап — review-package со ссылками на commits/diffs/test evidence, явно разделёнными decision approval и final acceptance; не обязательно автоматизировать merge.

## Onboarding, целостность и доказанные сильные стороны

1. **Turnkey при подготовленной машине правдоподобен, полноценный нулевой onboarding — нет.** `README.md:53–65` документирует установленные и авторизованные CLI, Git, macOS; bundled Node убирает ещё одну установку. `packages/host/src/methods/providers.ts:23–30` определяет available через наличие команды, а не auth/совместимость/готовность trust. `NewWorkComposer.tsx:333–340` скрывает отсутствующих провайдеров и не предлагает установить/войти. Это техническая граница, не юридическая оценка OAuth.
2. **Trust/onboarding не обходятся для удобства.** README `1394–1403` описывает вход и trust в terminal, needs-you после задержки и отсутствие автоматического Enter. Проверка контрактов вендоров — отдельная часть общего аудита; здесь установлено, что GUI предусматривает ручной fallback.
3. **Team-first путь требует лишней первой сессии.** Landing открывает только New workspace; он обязательно вызывает sessions.create. New room затем создаёт N новых сессий, а не включает seed по умолчанию (`NewSessionOrRoomDialog.tsx:302–348`, E2E `rooms-dialogs.spec.ts:150–156`). Для подготовленного workspace это приемлемо, для первого открытия можно улучшить командный маршрут. Слияние уже открытых сессий доступно только мышью и честно числится в TODO.
4. **Надёжный каркас human-in-the-loop.** Proposal id+rev, обработка conflict, блокировка повторного Accept, явный Return for rework — хорошее инженерное решение и заметная ценность для портфолио. Это конкретный механизм, а не рекламная формулировка.
5. **Видимость доставки и внимания продумана.** Picked up vs waiting; причины ожидания; @human; переход из уведомления в правильную сессию/комнату; чтение только видимого сообщения с фокусом; защита читающего историю от автоскролла (`RoomPanel.tsx:19–37,227–269`). Это признаки продуманного рабочего инструмента.
6. **Реальный review, не декоративный diff.** Путь commit/merge учитывает dirty buffers, работающего агента, общую project folder, конфликт базы; можно отправить агенту редактируемую просьбу разрешить конфликты (`PrimaryAction.tsx:5–15,101–165`, `AskAgentDialog.tsx:46–55`).
7. **Отдельная сессия может оставаться native terminal.** Разница Claude Chat/Codex terminal документирована (`README.md:59–60,760`); на демо это следует показать как текущую матрицу поддерживаемых интерфейсов, не обещать одинаковые возможности всех вендоров.

## Что доказано тестами, а что ещё нет

Прочитаны, но не запускались: `packages/desktop/e2e/rooms-dialogs.spec.ts`, `room-decision.spec.ts`, `attention.spec.ts`, соответствующие unit-tests Composer/RoomPanel и исходники Chat/Changes.

- `rooms-dialogs.spec.ts:9–15,99–105,109–167`: настоящий host/Electron, Claude заменён echo-agent; создание сессии/комнаты, lead, пустой старт и drag membership проверяются реальным UI.
- `room-decision.spec.ts:13–31,150–175,180–245`: echo-agent запускает настоящий MCP-server, проверяются предложение/ревизия/Accept/Return, уведомления, picked-up. Wake намеренно выключен (`wake.pause`), поэтому этот тест не доказывает автономную доставку/обсуждение реальными моделями.
- `chat-hooks.spec.ts:609,632,802,910,990`: заявлены кейсы Stop до ответа, permissions/questions/plans, субагенты, небольшое окно. Это полезное покрытие UI-контрактов, но не доказательство стабильности vendor hooks будущих версий.
- `TODOS.md:70–82` прямо оставляет живой Codex и реальную пару Claude+Codex с decision/accept/rework в открытых проверках. Нельзя превращать наличие E2E-заглушек в утверждение «смешанная команда независимо подтверждена в бою».
- `TODOS.md:149–154` честно фиксирует создание orphan session при launch failure; GUI retry не может удалить запись, потому что ошибка не возвращает id. Диалог это документирует (`NewSessionOrRoomDialog.tsx:18–32`), но дефект остаётся.
- `TODOS.md:338–341`: планы с владельцами, роли/инструкции агентов и Launch prepared принадлежат следующему этапу/прототипу. Не учитывать их как shipped UX.

## Порядок доработок без реализации

1. До демо: исправить routing round trip, не терять failed messages, показывать ошибки stop/resume; добавить минимальные регрессии с задержанными/rejected RPC и сменой вкладки. Зафиксировать версии бинарей для воспроизводимости демо.
2. В демо честно показать один законченный сценарий: готовая авторизованная машина → room Claude+Codex → общая задача → DM и broadcast → уточнение → disagree/rework → принятый текст → конкретный diff/tests → merge либо ручное принятие → Stop/Done. Живую проверку проводить только отдельно с явным разрешением владельца на агентные вызовы.
3. До внешней беты: функционально связать проверенный итог с артефактами; добавить заметный контроль всей команды и ясную семантику pause vs interrupt vs close; убрать неподтверждённое «collected positions».
4. Затем: first-run диагностика installed/auth-needed/unsupported-version, team-first создание без лишнего seed, keyboard-эквивалент drag membership, структурированные позиции/возражения при потребности.

Для портфолио уже можно доказательно показывать архитектурное разделение host/renderer, native CLI integration, восстановление состояния, типизированные протоколы, аккуратный human decision flow и широкие stub-based E2E. Нельзя на этой основе обещать успешный найм, превосходство над всеми аналогами или проверенную полностью автономную командную работу реальных моделей.

## Запущенные проверки и ограничения

- Только чтение файлов через `rg`, `nl`, `sed`, `cat`; просмотр `git status --short`; CLI `node --version`.
- Прямой импорт TS-функций через tsx: не завершился из-за `ERR_MODULE_NOT_FOUND @parley/protocol` в существующем workspace. Установку/сборку для обхода не выполняли.
- Успешно: изолированная локальная проверка реального исходного кода mention parser/editor через TypeScript transpile + jsdom; без host/CLI/сети. Артефакты `parley-ux-routing-repro.mjs` и `.json`.
- Полный test-run принадлежит отдельной проверочной ветке аудита. Живую ОС/UI-удобность, реальные CLI contracts, стоимость/лимиты, консенсус/качество выводов моделей эта часть не проверяет.


---

# ДОКУМЕНТ: parley-audit/skills-context-report.md

# Parley: аудит skills, knowledge, agents и экономии контекста

Срез 2026-10-03, репозиторий `/Users/kalmbik61/Desktop/MY/my_harnas`, HEAD `72a87361d8073c011e60f31e5d254f1045ff086b`. Аудит только на чтение исходников, настроек и пользовательских данных. Синтетические данные создавались только в `/tmp`, доказательства — в рабочей папке аудита. Настоящие агентные сессии, установка зависимостей, изменения проекта и пользовательских настроек не запускались.

Пользователь уточнил, что две отдельные сессии сейчас развивают capabilities/skills/agents/memory и skill router. Поэтому отсутствие будущих компонентов ниже — граница текущего среза, **не дефект завершенной реализации**. Хеши исследованных файлов и время фиксации — `context-baseline.json`; повторная проверка — `context-recheck.json`.

## Полезные выводы

1. Реальная основа уже осмысленная: компактная постоянная вставка, короткие брифы с путями артефактов вместо содержимого, подробный гид по темам через MCP, native skills вместо собственной дублирующей экосистемы. Но к ней не применён сквозной бюджет контекста. Обязательный `get_map` загружает всю переписку; брифы включают все решения и неограниченные summaries. Это существенно важнее первых нескольких тысяч символов списка skills.
2. Рост карты имеет не только токенную цену: карта входит в полный GUI snapshot, а входящий кадр ограничен 8 MiB. Синтетическая валидная по структуре карта из 2 100 сообщений по 4 000 символов уже вызывает `LineTooLongError`; GUI при такой ошибке уничтожает соединение.
3. Для измерения будущей экономии текущие GUI metrics недостаточны: после `report(done)`/sleeping старый снимок метрик имеет приоритет перед свежим логом; cache reads/writes в `LiveMetrics` вообще не доходят. Значения `↑` и `↓` не являются полной стоимостью работы комнаты.
4. Skills autocomplete сейчас — частичный индекс Claude. Он не совпадает с нативно доступными возможностями: считает все папки cache установленными/включенными, выбирает версии алфавитно, получает путь главного проекта вместо worktree. Последние проблемы честно записаны в `TODOS.md:754–756`.
5. Skill router по принятому дизайну **не делает дополнительный LLM-вызов**: это локальный BM25. Его польза пока не измерена; дополнительные расходы возможны в основной модели через поиск, результаты, неудачные запросы, лишние загрузки и повторы. Бесплатный поиск не означает бесплатный агентный цикл.

## Существенные замечания с механизмом и проверкой

### C1 — P1: неограниченная карта/история раздувает контекст и может отключать GUI

**Код:**

- `packages/core/src/mcp/tools.ts:247–251` обещает целую карту и велит звать её первой; `473–490` возвращает весь `readMap` без проекции/страниц/лимита.
- `packages/core/src/work/brief.ts:78–90` копирует summaries и все ссылки артефактов `contextFrom`; `151–156` копирует все решения треда.
- `packages/core/src/work/thread.ts:46–48,69–71` у одинокого корня охватывает всю работу и возвращает все сообщения `kind: decision` без ограничения числа/размера/актуальности.
- `packages/core/src/mcp/tools.ts:79–84,493–513` проверяет summary лишь как непустую строку, не как ограниченный бюджет.
- `packages/host/src/works/works-service.ts:80–83,264–265` публикует полный snapshot всех работ.
- `packages/protocol/src/framing.ts:11,54–68`: максимальная строка 8 MiB.
- `packages/desktop/src/main/host-connection.ts:322–331`: ошибка декодирования уничтожает socket.

**Эффект:** важная краткая память существует, но смешана с полным журналом. Каждому новому агенту и каждому повторному `get_map` доступна растущая масса сообщений; последующие запросы native CLI несут историю дальше. Несколько комнат/работ суммируются в одном snapshot. Достигнутая граница NDJSON ломает получение состояния GUI, независимо от лимита контекста модели.

**Воспроизведение:** `context-proof.mts` импортирует реальные `buildBrief`, `systemGuidance`, `LineDecoder`, создает карту в памяти. В GUI envelope используется форма `{event:'works.changed', data:{entries:[{projectPath,map}],branches:{}}}`. Не запускается процесс агента.

| Число решений × 4 000 символов | Символов брифа | Байт карты | Результат LineDecoder |
|---|---:|---:|---|
| 10 | 40 827 | 42 401 | принимает |
| 100 | 402 357 | 413 922 | принимает |
| 1 000 | 4 017 657 | 4 130 023 | принимает |
| 2 100 | 8 436 357 | 8 673 023 | `LineTooLongError` |

Это проверка предела, а не утверждение, что пользовательская карта уже достигла его. Высокая уверенность в механизме; работа живой модели и GUI не запускалась. Ограничение скорости писем замедляет рост, но не ограничивает общий объём долговечной работы.

**Предлагаемое решение:** отдельно индекс состояния и отдельно append-only переписка; компактный `get_map` по умолчанию, запросы комнаты/сессии с курсором, бюджет ответа в байтах/токенах, последняя действующая ревизия решений и указатель на старые; GUI snapshot без полных писем, инкрементальные изменения. Не лечить простым повышением 8 MiB.

### C2 — P2: метрики активной сессии застывают после первого итогового отчёта или сна

**Код:**

- `packages/core/src/work/metrics.ts:178–224` сохраняет итоговые metrics в карте и при `report(done/failed)`, и при sleeping.
- `packages/core/src/work/map.ts:228–250` при переходе обратно в active не сбрасывает metrics; `257–270` итог не меняет жизненный цикл.
- `packages/host/src/activity/activity-service.ts:452–458` выбирает `session.metrics?.tokens ?? indexed?.tokens` и аналогично duration.

**Механизм:** отчёт не закрывает сессию — это намеренный контракт. Агент продолжает принимать новые вопросы или просыпается, native log растёт, но сохранённые старые показатели имеют приоритет. Перезапуск индекса не помогает, пока новый `finishSession` не перезапишет snapshot.

**Доказательство:** `metrics-proof-isolated.mjs` извлекает фактическую `metricsFor` из исходника через TypeScript AST, транспилирует и вызывает её в VM со стабами несущественных зависимостей. При active/done, snapshot input/output=100/20, свежем index=1000/200 функция отдаёт 100/20; без snapshot тот же index возвращает 1000/200. Это изолированная проверка реальной функции, не переписанная копия логики. Полноценный импорт службы был заблокирован отсутствующей workspace-связью `@parley/core`; зависимости не устанавливались.

**Эффект:** особенно опасно для проверки экономии router или повторных задач в комнате: GUI может выглядеть дешёвым именно потому, что отображает старые числа. Уверенность высокая; полная интеграция не выполнялась.

**Предлагаемое решение:** при живой сессии предпочитать свежий index; frozen metrics использовать как fallback/архив и обозначать время измерения. Проверить active → report → новый turn и sleeping → resume → новые сообщения.

### C3 — P2: GUI не передаёт счётчики кэша и не даёт полного измерения комнаты

**Код:**

- `packages/core/src/adapter-v1.ts:101–104` корректно читает четыре счётчика Claude.
- `packages/core/src/session-index.ts:143–162` устраняет повторный учёт частей одного message.id — положительная защита от двойного счёта.
- `packages/core/src/codex/index-session.ts:21–39` читает накопительный итог, вычитает cached input из input и отдельно хранит `cacheRead`; `cacheWrite:0` отражает отсутствие такого поля в источнике.
- `packages/host/src/activity/activity-service.ts:454–457`, `packages/protocol/src/types.ts:78–84` передают только input/output.
- `packages/desktop/src/renderer/lib/metrics-line.ts:52–58` показывает стрелки без разделения обычного входа и кэша.

**Механизм/эффект:** базовые счётчики есть, но диагностический слой теряет наиболее нужные поля. `↑` представляет uncached input, а не полный вход. Отдельно расходы native subagents не агрегируются самим `indexSessionFile` (`session-index.ts:101–104` явно индексирует один файл). Для сравнения A/B нужны сумма всех участников/потомков, cache read/write, попытки, tool turns и качество результата. Это P2 для наблюдаемости, не утверждение о неверном счёте каждого парсера.

**Предлагаемое решение:** разделить total input, uncached input, cached input, cache write, output; отметка источника и свежести; room/task-run attribution. Не выдавать сумму токенов за точные деньги либо за процент подписочного лимита без соответствующих данных вендора.

### C4 — P2: подсказки capabilities расходятся с нативными skills агента

**Код:** `packages/core/src/capabilities/scan.ts:144–163` обходит весь cache, сортирует имена версий reverse lexicographic; `168–175` оставляет первый дубль; `178–201` не читает enabledPlugins/installed registry, сканирует только фиксированные папки. `packages/host/src/methods/capabilities.ts:20–21` ограничен Claude, берёт входной projectPath. `TODOS.md:754–756` уже перечисляет часть расхождений.

**Воспроизведение:** во временном home созданы `demo/2.9.0/skills/sample` и `demo/2.10.0/skills/sample`, а в settings.json `enabledPlugins['demo@market']=false`. Реальный `scanClaudeCapabilities` вернул `demo:sample` с description `old` из `2.9.0`.

**Эффект:** человеку обещается команда, которой CLI может не предоставить, или описание от иной версии; для worktree возможна подсказка о skill основной копии, которого в рабочей копии нет. Если такой индекс станет источником автоматического router без исправлений, неправильная доступность превратится в дополнительные ходы/ошибочный выбор. Нынешний scanner сам не запускает выключенный plugin: это ошибка отображаемого каталога, не доказанный обход контроля CLI. Уверенность высокая.

**Предлагаемое решение:** общий provider-aware scanner для UI и router, но с разными фильтрами human-invocable/model-invocable; официальный active installation path, scopes, overrides, symlink deduplication и фактический cwd сессии; контрактные fixture, сравнение с нативным списком. Официальная документация Claude подтверждает, что plugin skill доступен там, где plugin включён; она также описывает команды, synced skills и родительские project directories: https://code.claude.com/docs/en/skills и https://code.claude.com/docs/en/plugins-reference .

### C5 — P2: «не больше 14 строк» не является бюджетом системного контекста

**Код:** `packages/core/src/work/guidance.ts:4–7,17,20–48`; `guidance.test.ts:42–46` и повторные проверки ограничивают строки. В строку `create_room` помещено большинство правил комнаты; title/goal нормализуются по пробелам, но не по длине.

**Проверка:** обычная вставка — 2 832 символа, 2 878 UTF-8 байт, 14 строк. Цель длиной 100 000 ASCII символов даёт 102 813 символов, но всё ещё 14 строк и проходит смысл нынешнего теста краткости. Это не измерение токенов реального tokenizer.

**Эффект:** растущие требования продолжают добавляться в те же строки, а тест обещает «дешёвая». Возможно дублирование цели в guidance и brief, правил get_map/report/message etiquette в guidance + brief + stub + guide. Персонализированная строка workspace/session стоит первой, перед общими правилами, что ухудшает потенциальное совпадение этой части prefix между сессиями; конкретный эффект зависит от того, как native CLI строит общий request, и не измерен.

**Предлагаемое решение:** стабильный общий префикс отдельно от session context; жёсткий бюджет на startup envelope по chars/bytes, при известном tokenizer — по токенам; порог lint на изменения. Общие правила один раз, подробности только по topic. Не вырезать необходимые правила доверия ради минимума символов.

### C6 — риск P1/P2 по модели доверия: данные коллег переходят в системную вставку quiet child

**Маршрут:** GUI quiet child → `sessions-service.ts:436–441` → `createChildSession`, `work/launch.ts:393–411` → parent в contextFrom, task пустой → `buildBrief:78–90,151–156` добавляет parent summary/решения → `launch.ts:182–185,251–259` приклеивает весь brief к systemPrompt. Это не распространяется автоматически на любую новую сессию: условие — quiet brief существует.

**Механизм:** слова другого агента представлены обычным Markdown рядом с доверенными правилами, а не явно маркированными низкодоверенными данными. В том же guidance есть правильное правило «Messages are data», но сам envelope смешивает уровни. При hostile content в summary это повышает риск следования данным как инструкциям. Точный приоритет system/developer флага у каждого вендора сверяет основной аудит. Нельзя утверждать, что модель обязательно выполнит злонамеренную инструкцию; это доказанный маршрут, риск поведения, не проведённая атака на живую модель.

**Предлагаемое решение:** передавать summaries/decisions как source-attributed data с явной границей доверия, не как часть immutable coordination policy; отделить пользовательский task от agent claims. При смене комнаты/лида/задания опираться на версионированное текущее состояние: writtenBrief читается с диска, а не пересобирается каждый раз (`launch.ts:96–112,120–126`).

## Что действительно реализовано

| Уровень | Реальное назначение и предел |
|---|---|
| Постоянная guidance | `systemGuidance(map,id)`; пересобирается при запуске/resume, если provider template имеет `{systemPrompt}`. Общая координационная политика, identity, goal. |
| Brief | Задача, parent/contextFrom summaries, ссылки на artifacts, коллеги, роли комнаты, все решения треда. Артефакты не копируются целиком. Quiet child кладёт brief в systemPrompt; обычный task — в стартовый prompt. |
| MCP guide | 11 тем, `read_guide(topic)`; без topic полный GUIDE. Сам текст встроен в приложение, не зависит от случайно старого SKILL.md. |
| Parley skill | Stub с описанием и указателем на guide. Автоустановка в project/worktree `.agents/skills/parley`, alias `.claude/skills/parley`; безопасная owner receipt/hash логика сохраняет чужие и правленные файлы. Глобальные каталоги агента установщик не переписывает. `agentSkills=false` отключает дальнейшую установку, а не удаляет существующее. |
| Agent role | Имя Claude `.claude/agents/<name>.md` из project или home; проверка наличия файла `work/agents.ts:37–48`, без проверки содержимого/доступности MCP tools. `guide.ts:414–416` честно предупреждает о trimmed tools. Не универсальная role schema между вендорами. |
| Shared knowledge | `map.json`, session summary, artifacts paths, сообщения/решения. Нет доказательства отдельного общего knowledge engine с retrieval/provenance/versioning; нативные памяти, AGENTS/CLAUDE и skills продолжают жить в vendor CLI. |
| UI capabilities | Только autocomplete Claude, read-only, первые 4 KiB frontmatter, предел 500 entries и локальный UI TTL 60 секунд. Это cache файлового каталога, не prompt cache модели. |

**Плюсы установщика:** отказ от прохода через опасные symlink parents и глобальных пользовательских каталогов, ownership receipt, сохранение ручных изменений, идемпотентность и сериализация по проекту (`work/skill-install.ts:30–49,92–95,211–225,456–473`). В этом обзоре не доказана эксплуатация race/TOCTOU; не превращать её в подтверждённую уязвимость.

**Старое auto-summary:** `work/summary.ts` действительно умеет ограничить transcript 40 000 символами, отдельные реплики — 2 000 и вызвать `claude -p`. Но актуальные вызовы `requestAutoSummary` — лишь определение и export, GUI не использует его; `TODOS.md:26–28` прямо относит это к оставшемуся коду после удаления TUI. Нельзя описывать это как работающую бесплатную компрессию памяти. Оно потенциально тратит native model usage, если вызвать его отдельно; в аудите не вызывалось.

## Измеренный размер контекстных слоёв

Синтетическая работа с короткой целью и двумя сессиями:

| Текст | Символы | UTF-8 байты | Строки |
|---|---:|---:|---:|
| Always-on guidance | 2 832 | 2 878 | 14 |
| Простой brief участника | 635 | 647 | 24 |
| Полное тело skill stub | 3 680 | 3 724 | 43 |
| Полный GUIDE | 21 974 | 22 088 | 373 |
| Topic overview | 642 | 642 | 12 |
| Topic lead | 3 350 | 3 370 | 50 |
| Topic member | 1 584 | 1 592 | 24 |
| Topic letters | 3 529 | 3 549 | 57 |

Полное тело skill/guide не надо считать всегда загруженным: это lazy слои. Метаданные skill и MCP tools загружает native CLI по собственным правилам. Например, guidance + простой brief + загруженный stub + весь guide составляют 29 121 символ без MCP schemas, native project memory, реального task, history, tool results. Это верхний сценарий конкретных слоёв, не реальный счетчик пользователя. При topic-based чтении сумма ниже. Конвертация chars/4 для английского была бы лишь приблизительной; в доказательствах указаны символы/байты, не придуманные токены.

## Cache: что можно и чего нельзя обещать

Код Parley не формирует модельные API requests и не задаёт `cache_control`, `prompt_cache_key`, `prompt_cache_retention`. Он запускает native CLI и читает usage из журналов. Claude Code сам управляет prompt caching; точный prefix должен сохраняться, а изменение моделей, MCP и части plugin-конфигурации способно инвалидировать cache. Это описано в официальном https://code.claude.com/docs/en/prompt-caching . OpenAI также описывает cache как reuse общего prefix; сама по себе долговечная session не гарантирует hit: https://developers.openai.com/api/docs/guides/prompt-caching .

Следствия: Parley может уменьшать собственные вводимые тексты, число ходов, fanout и повторные большие чтения; выбирать стабильную форму контекста и показывать cache telemetry. Он не может гарантировать общий cache Claude↔Codex, экономию подписочного лимита по одной лишь длине prompt или API-прайсу, либо отсутствие cache misses после перерыва/resume. Cache экономит повторную обработку, но не освобождает окно контекста. Нативный CLI продолжает посылать контекст и обрабатывает compaction по своим правилам.

## Оценка активных планов

`docs/specs/2026-10-02-capabilities-design.md:3–5,320–340` — принятый дизайн, с разведкой контрактов перед реализацией. Он сохраняет native ecosystem и предусматривает источник установки/включенности, redaction секретов, read-only просмотр первым этапом. Реальная широкая панель — будущая часть, нынешнее совпадение имени capabilities означает только autocomplete. Не считать несуществующие методы `capabilities.get/refresh`, plugin install UI или skill sharing сломанной выполненной работой.

`docs/specs/2026-10-03-skill-navigator-design.md:3–6,57–81,146–196` — активный дизайн navigator:

- локальный BM25 по именам и описаниям, максимум 5 результатов по умолчанию/10 cap, английский поиск формулирует основная модель;
- нативная загрузка выбранного skill, только доступные skills нужного provider; lead может искать для участника;
- Claude names-only, Codex механизм отключения списка требует разведки; fallback оставляет native список;
- выключение стороннего jev в пределах запусков Parley, настройка по умолчанию off, без правки глобальных конфигов;
- исключены внешний LLM-router, embeddings, сеть и hook на каждый prompt.

Направление разумное для native CLI продукта. Хрупкие точки вынесены как вопросы, что хорошо: undocumented budget settings, реальная включенность/scopes, условия отключения jev, Codex skill config. Для main-task direct/broadcast/addition особенно важно, чтобы указатель «New messages» не запускал повторную подборку и не подменял смысл задачи новой skill.

Пока отсутствует **измеримый экономический контракт**. Спека содержит правильную проверку качества на ~15 prompts и размер skill_listing ≤3 000 символов (`258–275`), но этого недостаточно для заявления, что вся работа стала дешевле: у lookup появляются schema/catalog, query, результаты, tool turn, загрузка тела; ошибочный выбор удлиняет выполнение, а no-match требует переформулировки. В комнате каждый агент может снова читать одну и ту же память. Предложенная метрика размера должна быть лишь диагностикой.

## Приёмка экономии без изменения продукта в этом аудите

Сначала записать baseline, затем разрешённый человеком будущий live A/B. Во время данного аудита платные прогоны не выполнялись.

1. **Зафиксировать два режима:** stock native skills в Parley и тот же Parley с navigator. Одинаковые provider/model/effort, CLI versions, plugins, project/worktree state, skill content hashes, задача, число участников и заданные права. Отдельно отметить вариант с jev: сравнение «router vs jev» не заменяет «router vs native baseline».
2. **Набор задач:** одиночная без skill; одиночная с одним очевидным skill; неоднозначная; русскоязычная; несколько skills; room lead+два provider; direct message; broadcast; добавление/исправление человеком во время работы; остановка/возобновление; большой skill; disabled skill; unavailable plugin; no-match; длительная работа через compaction. Для повторяемости заранее зафиксировать критерии результата и skill/no-skill labels.
3. **Основная единица — принятый результат задачи**, а не отдельный удачный ответ поиска. Суммировать все main sessions/native subagents/повторные попытки до приемки. Отдельно качество (успех, ошибки, нужные исправления человеком, следование запретам/заданию), latency до принятого результата и число запусков.
4. **Снять сырые показатели:** input, output, cached input, cache write, tool calls и tool-result bytes, число `find_skill`, no-match/reformulation, loaded skill bodies/bytes, повторные загрузки, число сообщений и fanout, respawns/retries, compactions, always-on bytes и memory duplication. Для provider, где поле неизвестно, `unknown`, а не 0. CacheWrite Codex — «не наблюдается», даже если внутренний нормализатор ставит 0.
5. **Контролировать cache:** cold и warm сценарии отдельно, одинаковые интервалы, одинаковая модель; reset/restart и TTL expiry отдельно. Не выдавать случайный warm cache одного режима за преимущество router. Из журналов сохранять request/message identity для дедупликации, избегать двойного счета partial records.
6. **Сравнение:** показывать абсолютные величины и распределение по задачам, медиану и хвосты, paired difference. Экономия = снижение ресурса на принятый результат при неухудшенном качестве. Отдельно actual vendor quota если доступна, но без вывода точных денег из подписочных токенов. ~15 prompts годятся для smoke-eval, не для сильного статистического обещания; расширять набор до покрытия всех важных ветвей и повторять шумные случаи.
7. **Gate:** отключенные/чужие skills не предлагаются; качество и соблюдение поручения не хуже baseline; нет роста retries/fanout/случайных skill loads, съедающего выигрыш; overhead пустого/no-skill запроса ограничен; ошибки provider contract ведут к штатному native списку. До выполнения gate — opt-in, явное «экспериментально», без обещания конкретного процента экономии.

## Приоритетный план без реализации

1. **Сначала бюджет и наблюдаемость:** устранить C1–C3, сделать компактную карту/курсорные письма и актуальные полные usage metrics. Это одновременно устойчивость GUI и основа проверки выгод.
2. **Уровни доверия и свежесть:** вынести agent-sourced summary/решения из privileged guidance; задать task revision и свежие роли/принятый план отдельно от archived brief. Проверить mid-task additions и прямые задания при pending proposal.
3. **Общий native capability contract:** реализующим capabilities и navigator сессиям договориться об одном resolver/индексе, фактическом cwd, active installations, overrides и фильтрах доступности, чтобы не появилось два расходящихся сканера.
4. **Минимальный router под flag:** BM25, отложенные описания, явный no-match, native loading, не более нужного числа retrieval; не вводить платный роутер без отдельного доказательства необходимости.
5. **A/B gate:** сравнить качество и суммарный ресурс по набору выше. После результатов решать default-on и дальнейшую memory/retrieval архитектуру.
6. **Свести документы:** краткая таблица implemented/in-progress/planned/live-verified + версия CLI и тест. В TODOS старое «нет chat feed» (`688–690`) соседствует с последующим «сделано 1–5» (`711–716`); исторические записи сохранять, но отделить от текущего статуса. Не переносить текущую активную разработку в список «дефектов реализации».

## Запущенные проверки и ограничения

- Прочитаны исходники onboarding, guide, stub/install, capabilities scanner/frontend cache, MCP map/report/read_guide, brief/thread, metrics и GUI framing; README/TODOS и две активные спеки. `.claude/worktrees` массово не читалась.
- `context-proof.mts`: реальные pure functions, synthetic map growth, LineDecoder boundary, 14-line budget counterexample, disabled-plugin/version counterexample. Exit 0, вывод `context-proof-output.txt`.
- `metrics-proof-isolated.mjs`: AST extraction реальной metricsFor, проверка frozen snapshot precedence. Exit 0, вывод `metrics-proof-output.txt`.
- Попытка full-service fixture (`metrics-proof.mts`) остановилась на `ERR_MODULE_NOT_FOUND: @parley/core`; пользовательский проект/зависимости не менялись. Изолированная проверка не заменяет integration test.
- Проверены официальные веб-источники caching и Claude skills, перечисленные рядом с утверждениями. Живые native provider контракты, фактический расход tokens/quotas и выполнение router не запускались.
- Размеры в таблицах — измеренные chars/UTF-8 bytes; никаких утверждений о фактической токенной/денежной экономии.
- Отдельные тестовые fixtures в `/tmp` оставлены как воспроизводимые доказательства. Исходники, настройки, пользовательские данные и рабочие ветки не изменялись этим исполнителем.


---

# ДОКУМЕНТ: audit-validation/verification-report-ru.md

# Parley: локальная верификация, тесты и наблюдаемость

Проверена изолированная копия `/Users/kalmbik61/Desktop/MY/my_harnas`, HEAD на момент наблюдения `72a87361d8073c011e60f31e5d254f1045ff086b`, версия package.json `0.4.0`. Аудит исходники проекта не изменял. Пользователь сообщил о двух параллельных сессиях разработки: выводы относятся к скопированному состоянию, а незавершённые изменения и состояние установленного node_modules не выдаются за регрессию релизной версии.

Главный результат: код имеет обширный проверяемый контур и успешно собирается, однако объявлять весь набор зелёным нельзя. Первый полноценный прогон на Node 22: **6944 успешных / 6947 тестов**, **358 файлов**, три сбоя в core/host. Все 4502 desktop unit tests и все 81 protocol tests успешны. Повтор проблемного файла core — 20/20; повтор файла host устранил исходный сбой, но получил другой таймаут. Это подтверждает нестабильность асинхронных тестов, а не три независимых продуктовых дефекта.

Ни настоящий Claude/Codex/GLM, ни платные агентные сессии, ни GUI-приложение, ни внешние API в рамках проверки не запускались. Реальные vendor commands дополнительно перекрывались запрещающими заглушками; журнал их срабатываний не создан.

## Результаты проверок

| Проверка | Результат | Доказательство |
|---|---:|---|
| core unit, Node 22.18.0 | 1675 pass / 2 fail, 70 файлов, 136.25 с | `core-node22.log`, `core-node22.json` |
| protocol unit, Node 22.18.0 | 81/81, 5 файлов | `protocol-node22.log`, `protocol-node22.json` |
| host unit, Node 22.18.0 | 686 pass / 1 fail, 49 файлов, 71.08 с | `host-node22.log`, `host-node22.json` |
| desktop unit, Node 22.18.0 | 4502/4502, 234 файла, 102.02 с | `desktop-node22.log`, `desktop-node22.json` |
| Повтор `core/src/cli-work.test.ts` | 20/20, 43.15 с | `core-cli-node22.log`, `core-cli-node22.json` |
| Повтор `host/src/sessions/sessions-service.test.ts` | 46 pass / 1 fail, 9.18 с; другой тест | `host-sessions-node22.log`, `host-sessions-node22.json` |
| Принудительная сборка core/protocol/host на Node 22 | exit 0 | `build-libraries-node22.log` |
| desktop build на Node 22 | exit 0 | `desktop-build-node22.log` |
| desktop typecheck на Node 22 | exit 0 | `desktop-types-node22.log` |
| ESLint packages/tools | exit 0 | `lint-node22.log` |
| Дополнительный TypeScript по всем protocol tests | exit 0 | `protocol-test-types.log`, `source/packages/protocol/audit-types.tsconfig.json` |

Полные suite запускались с `--maxWorkers=2 --minWorkers=1`, **без retry**. Целевые перепрогоны пересекаются с полными и не прибавляются к 6947. Некоторые независимые сборки/целевые перепрогоны перекрывались по времени; нагрузка остальных приложений Mac не контролировалась. `*-execution.json` сохраняют точные argv, cwd, время начала/конца и код завершения.

## Существенные замечания

### V1. Ключевой продуктовый сценарий ещё не подтверждён живым vendor acceptance test — P1, пробел в доказательствах

- **Доказательство:** `TODOS.md:30-82` прямо оставляет на будущую ручную проверку доставку через настоящий MCP, `--resume`/`--agent`, видимость skill, поведение Codex и комнату Claude+Codex с предложением и принятием решения. `packages/desktop/e2e/codex.spec.ts:14-17` объясняет, что Codex заменён собственным stub, имитирующим OSC и notify. `packages/desktop/e2e/global-setup.ts:51-54` отключает version probes настоящих CLI.
- **Механизм:** production-код и заглушки могут разделять одно неверное предположение о формате/приоритете инструкций/терминальном протоколе. Их согласованность не проверяет внешнюю реализацию вендора.
- **Эффект:** большое число зелёных unit/E2E не доказывает основное обещание «существующие сессии разных вендоров самостоятельно работают в общей комнате».
- **Уверенность:** высокая относительно отсутствия заявленного acceptance gate в репозитории; живое поведение в этом аудите не проверялось по заданному ограничению. Это не утверждение, что продуктовый сценарий сломан.
- **Рекомендация:** после согласования отдельного live-прогона — короткая матрица закреплённых CLI versions: свежая/возобновлённая сессия, Claude+Claude/Claude+Codex, initial guidance, check_inbox, room proposal, accept/rework, stop/resume, отсутствие дубликатов и лишней рассылки. Сохранять обезличенный transcript и критерии прохождения. Официальный контракт и CLI observations документировать отдельно.

### V2. Нестабильные тесты и незавершённые фоновые операции снижают надёжность gate — P2, воспроизведено

**Core:** полный прогон дал `work prune` timeout 60000 ms и затем `work new`: ожидался `w-0001`, получен `w-0002`. Отдельный повтор всех 20 тестов файла прошёл.

- `packages/core/src/cli-work.test.ts:16-19` хранит изменяемые `home/project/binDir/stub` между тестами;
- `:37-47` запускает `pnpm exec tsx` через `execFile` без timeout/AbortSignal;
- `:70-83` меняет эти переменные и удаляет каталоги в beforeEach/afterEach;
- `:86-104` первый тест содержит несколько последовательных async операций и имеет только внешний Vitest timeout.

Vitest timeout сам по себе не отменяет дочерний процесс и дальнейшее async продолжение. Продолжение первого теста потенциально читает уже изменённые глобальные переменные следующего; это объясняет каскад с `w-0002`, однако именно этот порядок событий не инструментировался. **Таймаут и последующее несовпадение ID подтверждены, причинная связь каскада — сильная гипотеза.** Известное зависание уже записано в `TODOS.md:244-248`.

**Host:** полный прогон провалился на `sessions-service.test.ts:627-637` («токен снимается по выходу процесса») с `ENOTEMPTY` при удалении временного проекта. Тест ждёт `unregister`; это не конец фоновой записи: `sessions-service.ts:168-185` вызывает unregister синхронно, затем асинхронно делает `finishExited`. `sessions-service.test.ts:117-122` удаляет проект, не дождавшись этой финализации для созданного через `launchWith` сервиса. Этот механизм соответствует наблюдаемой гонке уборки.

Повтор 47 тестов того же файла прошёл исходный сценарий, но упал на другой проверке: autoLaunch worktree, timeout 5000 ms. Этот класс флейка уже назван в `TODOS.md:254-256`.

- **Эффект:** ложные красные прогоны и каскадные ошибки; CI в `.github/workflows/ci.yml:56-60` маскирует часть нестабильности `--retry=1`. Нельзя представлять такой gate как детерминированное свидетельство корректности.
- **Уверенность:** высокая по результатам и механизму host teardown; средняя по точной причине core timeout.
- **Рекомендация:** ограничить и отменять child processes; фиксировать fixture paths в неизменяемом контексте отдельного теста; дожидаться служебных finalizers перед удалением; ожидать наблюдаемое событие вместо временной паузы. Измерять flake rate отдельно от retry-green статуса.

### V3. CI не исполняет имеющиеся type assertions и не включает Electron E2E — P2, подтверждено

- `packages/protocol/src/methods.test.ts:1-19` и `:77-89` содержат `expectTypeOf`.
- `packages/protocol/tsconfig.json:8` исключает `src/**/*.test.ts`; `package.json` root script `typecheck` строит зависимости и проверяет desktop.
- `packages/protocol/package.json:13` запускает обычный `vitest run --passWithNoTests`, без typecheck.
- `.github/workflows/ci.yml:40-60` явно исключает Electron binary и запускает только build/typecheck/lint/unit. `TODOS.md:299-302` и `:600-609` признаёт обе недостающие проверки.

**Механизм/эффект:** runtime-transpile удаляет TS-типы; зелёный `expectTypeOf` в обычном Vitest не является выполненным сравнением типов. Регрессия межпакетного type contract может не обнаружиться этим тестом. Переход main/preload/renderer и поведение окна не проверяются в CI как целое.

**Проверка аудита:** дополнительный изолированный tsconfig, включающий protocol tests, прошёл. Текущей ошибки типов не найдено; найден именно отсутствующий gate. **Уверенность высокая.** Добавить tsc/Vitest typecheck job и небольшой детерминированный E2E smoke subset после защиты временных каталогов. Полный графический suite и реальные vendor acceptance tests — разные уровни доказательства.

### V4. Cache usage собирается, но теряется в живой телеметрии окна — P2, статически подтверждено

- `packages/core/src/adapter-v1.ts:97-105` извлекает `input`, `output`, `cacheRead`, `cacheWrite` из Claude usage.
- `packages/core/src/work/metrics.ts:69-75` сохраняет token totals в метрики карты.
- `packages/host/src/activity/activity-service.ts:454-458` в LiveMetrics переносит только input/output/duration.
- `packages/protocol/src/types.ts:79-85` не имеет cacheRead/cacheWrite; `packages/desktop/src/renderer/lib/metrics-line.ts:56-58` показывает только вход/выход.

**Эффект:** из интерфейса нельзя проверить cache hit rate или доказать экономию от стабильного guidance/brief. Это разрыв наблюдаемости, не свидетельство отсутствия prompt caching у CLI. Стоимость и семантика «input» зависят от конкретного вендора и отдельно требуют официальной проверки.

**Уверенность высокая.** Сначала протянуть уже существующие cache counters с различением unknown/zero, затем оценивать по комнате и по сессии затраты на initial instructions, inbox, guides, summaries, retries. Не обещать экономию по одному размеру текстов.

## Что сделано качественно

- core/host имеют sandbox-home setup с временным HOME/USERPROFILE, удалением унаследованных PARLEY_HOME/HARNAS_HOME; host дополнительно отключает настоящие version probes (`packages/core/test/sandbox-home.ts`, `packages/host/test/sandbox-home.ts`).
- Тесты CLI version probe используют собственные shell stubs всех трёх providers (`packages/host/src/main.test.ts:39-80`).
- Реальные обезличенные Claude fixtures представлены отдельно от синтетических крайних случаев (`packages/core/test/fixtures/README.md:3-23`). Снимки схем честно помечены как наблюдение, не спецификация (`docs/schema/README.md:1-11`, `:20-28`).
- Есть regression tests framing, схем RPC, блокировок, corrupt maps, launch/resume, hooks, delivery, room decisions, migrations, release scripts и UI; большой объём тестов в данном снимке подтверждён запуском.
- CI использует read-only permissions, pinned action SHA и frozen lockfile (`.github/workflows/ci.yml:11-45`).
- Наблюдаемость отделена от PTY-потока: `host/log.ts:9-22` пишет структурированные JSON-строки с time/level/msg и ротацией примерно на 5 МиБ. `protocol/types.ts:103-125` задаёт предметные notice categories; причины ожидания доставки доступны как mailWaiting. Это полезнее одной общей ошибки.
- Feed bounded: `packages/host/src/feed/feed-service.ts:53-55` ограничивает ленту 2000 элементов / 4 МиБ. Не все исторические структуры bounded: `core/work/events.ts:207-230` накапливает события и возвращает копию всей истории, `activity-service.ts:595-610` сворачивает её дважды. Это риск будущего масштабирования длинных сессий; нагрузочный дефект здесь не утверждается без замера.

## Изоляция и ограничения

Копия с node_modules создана в `audit-validation/source`; исключены `.git`, `.claude`, `.parley`, `.harnas`, root `.env*`, package dist, desktop out/prototype. Скопированные абсолютные pnpm `.bin` wrappers перенаправлены на копию. Удалены только скопированные incremental build files, поскольку выход dist не копировался.

В существующей локальной установке исходного проекта оказались старые workspace-ссылки `@harnas/*` вместо `@parley/*`, а desktop не имел прямых ссылок `remark-parse`/`unified`, уже объявленных в manifest. Это **состояние локального install**, возможно связанное с текущей разработкой, не ошибка свежего frozen install. В копии ссылки восстановлены из её же packages/.pnpm, без скачивания/изменения версий и без правки оригинала. Сырые исходные ошибки сохранены в `build-*-log` и `desktop-*-stale-install.*`; успешные последующие проверки не скрывают эту подготовку.

Первый core-run внутри sandbox на Node 25 оказался непригоден для продуктового вывода: `uv_uptime EPERM`, `listen EPERM` для временных Unix-сокетов и связанные сбои. Его журнал `core-tests.log` сохранён отдельно. Валидные повторные unit tests запускались на явном Node 22.18.0 с разрешёнными локальными sockets/PTY. В desktop test config только в копии добавлен существующий core sandbox-home setup.

GUI E2E не запускались: это отдельное вмешательство в фокус приложений; TODO дополнительно признаёт, что полный guard worktree-root ещё не сделан (`TODOS.md:291-298`). Настоящие provider CLIs/API, пользовательские auth/settings/history, миграции живых данных, платные сессии и release/deploy не запускались. Зависимости заново из registry не устанавливались: supply-chain и воспроизводимость чистого install остаются вне проверки.

`snapshot.json` содержит хэши 899 скопированных исходных/служебных файлов и read-only git status. При повторной сверке `snapshot-after.json` исходники ещё совпадали со снимком (0 отличий); HEAD тот же. Это не блокирует дальнейшие изменения двух дев-сессий: после времени проверки результат может устареть. Секреты в отчёт не включались.

Проверка процессов после завершения: `owned-process-check.json` не нашла процессов, чья command line содержит путь тестовой копии. Ограничение проверки: процесс, полностью переписавший свою command line, таким фильтром не идентифицируется. Процессы пользователя не завершались.

## Команды и воспроизведение

В `run-validation.py` хранится точный запуск с Node22-first PATH, удалением inherited provider overrides и deny-vendors directory. Для suite использовались:

```text
pnpm --filter @parley/core run test --maxWorkers=2 --minWorkers=1 --reporter=default --reporter=json --outputFile=<audit>/core-node22.json
pnpm --filter @parley/protocol run test --maxWorkers=2 --minWorkers=1 --reporter=default --reporter=json --outputFile=<audit>/protocol-node22.json
pnpm --filter @parley/host run test --maxWorkers=2 --minWorkers=1 --reporter=default --reporter=json --outputFile=<audit>/host-node22.json
pnpm --filter @parley/desktop run test --config audit-vitest.config.ts --maxWorkers=2 --minWorkers=1 --reporter=default --reporter=json --outputFile=<audit>/desktop-node22.json
pnpm --filter @parley/core run test src/cli-work.test.ts <те же параметры отчёта>
pnpm --filter @parley/host run test src/sessions/sessions-service.test.ts <те же параметры отчёта>
node22 node_modules/typescript/bin/tsc -b packages/core packages/protocol packages/host --force
pnpm --filter @parley/desktop run build
pnpm --filter @parley/desktop run typecheck
pnpm run lint
node22 node_modules/typescript/bin/tsc -p packages/protocol/audit-types.tsconfig.json
```

Предложения выше — план проверки/исправления, не внесённые изменения в проект.


---

## ПРОТОКОЛ ПРОВЕРКИ: audit-baseline.json

```
{
  "at": "2026-10-03T18:02:49.518475+00:00",
  "root": "/Users/kalmbik61/Desktop/MY/my_harnas",
  "head": "72a87361d8073c011e60f31e5d254f1045ff086b",
  "files": {
    "packages/core/src/providers.ts": "e65ee841ebff669c9f96d6bde34966a6b4ce96d9dbbc848438a2a4da98c436e2",
    "packages/core/src/work/launch.ts": "164b324db7ac8738e2da0cd6a8029ead09d3e3008b4a1344791bfceb293db44d",
    "packages/core/src/mcp/tools.ts": "a9cc5170d190b1d6514bae4e75f882e3c1d7252034f18c03e3a940a6d691c388",
    "packages/core/src/work/store.ts": "0e3df84fdb08bd250e083c9cf6f7f6585cc210c8b17127e1a6493d97d1de32f9",
    "packages/host/src/wake/wake-service.ts": "7654b8e4206a332871e2d12c8c658d487bbcc4394292a85741f8bcfba7e04793",
    "docs/specs/2026-10-02-capabilities-design.md": "0a236e1d9d7de8a7df60d63e958a0e49d2d335657f31f5a52ded0244dbd80533",
    "docs/specs/2026-10-03-skill-navigator-design.md": "97270ea5ad3ab27fef69a7c6ea21d30160dbaa73c5d2530210f4738cb9021b24"
  }
}

```


---

## ПРОТОКОЛ ПРОВЕРКИ: audit-final-snapshot.json

```
{
  "at": "2026-10-03T18:18:31.889010+00:00",
  "head": "72a87361d8073c011e60f31e5d254f1045ff086b",
  "status": " M .omc/project-memory.json\n?? .omc/.project-memory.json.tmp.e84df327-b2c6-4aee-a997-e2674c932d03\n?? .pnpm-store/\n?? .superpowers/\n?? docs/specs/2026-10-01-remote-access-design.md\n?? docs/specs/2026-10-02-capabilities-design.md\n?? docs/specs/2026-10-03-skill-navigator-design.md\n?? packages/desktop/prototype/\n",
  "hashes": {
    "packages/core/src/providers.ts": "e65ee841ebff669c9f96d6bde34966a6b4ce96d9dbbc848438a2a4da98c436e2",
    "packages/core/src/work/launch.ts": "164b324db7ac8738e2da0cd6a8029ead09d3e3008b4a1344791bfceb293db44d",
    "packages/core/src/mcp/tools.ts": "a9cc5170d190b1d6514bae4e75f882e3c1d7252034f18c03e3a940a6d691c388",
    "packages/core/src/work/store.ts": "0e3df84fdb08bd250e083c9cf6f7f6585cc210c8b17127e1a6493d97d1de32f9",
    "packages/host/src/wake/wake-service.ts": "7654b8e4206a332871e2d12c8c658d487bbcc4394292a85741f8bcfba7e04793",
    "docs/specs/2026-10-02-capabilities-design.md": "0a236e1d9d7de8a7df60d63e958a0e49d2d335657f31f5a52ded0244dbd80533",
    "docs/specs/2026-10-03-skill-navigator-design.md": "97270ea5ad3ab27fef69a7c6ea21d30160dbaa73c5d2530210f4738cb9021b24"
  },
  "changedFromBaseline": []
}

```


---

## ПРОТОКОЛ ПРОВЕРКИ: cli-version-evidence.json

```
{
  "at": "2026-10-03T18:05:06.099006+00:00",
  "commands": [
    {
      "argv": [
        "/Users/kalmbik61/.local/bin/claude",
        "--version"
      ],
      "exit": 0,
      "stdout": "2.1.287 (Claude Code)",
      "stderr": ""
    },
    {
      "argv": [
        "/Users/kalmbik61/.nvm/versions/node/v22.18.0/bin/node",
        "/Users/kalmbik61/.nvm/versions/node/v22.18.0/lib/node_modules/@openai/codex/bin/codex.js",
        "--version"
      ],
      "exit": 0,
      "stdout": "codex-cli 0.156.1",
      "stderr": "WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)"
    }
  ]
}

```


---

## ПРОТОКОЛ ПРОВЕРКИ: codex-flag-parse-evidence.json

```
[
  {
    "args": [
      "--no-daemon",
      "--help"
    ],
    "exit": 0,
    "stdout_head": "Codex CLI\n\nIf no subcommand is specified, options will be forwarded to the interactive CLI.\n\nUsage: codex [OPTIONS] [PROMPT]\n       codex [OPTIONS] <COMMAND> [ARGS]\n\nCommands:\n  agents            Browse all agent sessions on the shared local app-server daemon\n  exec              Run Codex non-interactively [aliases: e]\n  review            Run a code review non-interactively\n  login             Manage login\n  logout            Remove stored authentication credentials\n  mcp               Manage external MCP servers for Codex\n  plugin            Manage Codex plugins\n  app-server        [experimen",
    "stderr": "WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)\n"
  },
  {
    "args": [
      "resume",
      "00000000-0000-0000-0000-000000000000",
      "-c",
      "tui.terminal_title=[\"spinner\",\"status\",\"session-id\"]",
      "--help"
    ],
    "exit": 0,
    "stdout_head": "Resume a previous interactive session (picker by default; use --last to continue the most recent)\n\nUsage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]\n\nArguments:\n  [SESSION_ID]\n          Session id (UUID) or session name. UUIDs take precedence if it parses. If omitted, use\n          --last to pick the most recent recorded session\n\n  [PROMPT]\n          Optional user prompt to start the session\n\nOptions:\n  -c, --config <key=value>\n          Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`.\n          Use a dotted path (`foo.bar.baz`) to override nested va",
    "stderr": "WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)\n"
  }
]

```


---

## ПРОТОКОЛ ПРОВЕРКИ: security-probes-output.json

```
{
  "sandbox": "/tmp/parley-security-audit-Y64gNl",
  "realProvidersLaunched": false,
  "nonMemberRoomVisibility": {
    "readRoomDenied": true,
    "getMapContainsRoomMessage": true
  },
  "closeWithoutConsentParameter": {
    "isError": false,
    "lifecycle": "closed"
  },
  "nonLeadMovesOriginalLead": {
    "isError": false,
    "original": {
      "id": "r-01",
      "title": "Original human room",
      "creator": "human",
      "members": [
        "s-02"
      ],
      "createdAt": "2026-10-03T18:00:40.209Z",
      "lead": null,
      "proposal": null
    },
    "newRoom": {
      "id": "r-02",
      "title": "New agent room",
      "creator": "s-03",
      "members": [
        "s-01"
      ],
      "createdAt": "2026-10-03T18:00:40.221Z",
      "lead": "s-03",
      "proposal": null
    }
  },
  "deleteTraversal": {
    "schemaAccepted": true,
    "resolvedTargetWasSyntheticVictim": true,
    "handlerResult": {
      "ok": true
    },
    "victimExistsAfter": false
  }
}

```


---

## ПРОТОКОЛ ПРОВЕРКИ: parley-orchestration-repro-results.json

```
{
  "checksPassed": 8,
  "outputs": [
    {
      "name": "broadcast membership is retroactive",
      "evidence": {
        "preJoin": [],
        "postJoin": [
          "OLD TASK — before newcomer joined"
        ],
        "oldRecipientAfterMove": []
      }
    },
    {
      "name": "create_room bypasses exhausted messageRate with invitation",
      "evidence": {
        "blocked": {
          "error": true,
          "data": "too many messages: 1 from this session in the last hour (limit 1); call report and turn to the human"
        },
        "bypass": {
          "error": false,
          "data": {
            "roomId": "r-03"
          }
        },
        "sentCount": 2
      }
    },
    {
      "name": "closed session can send and spawn via still-connected MCP",
      "evidence": {
        "closed": {
          "error": false,
          "data": {
            "sessionId": "s-01"
          }
        },
        "afterClose": {
          "error": false,
          "data": {
            "messageId": "m-05"
          }
        },
        "spawnedAfterClose": {
          "error": false,
          "data": {
            "sessionId": "s-04"
          }
        }
      }
    },
    {
      "name": "messageRate=1 does not limit spawn_session fanout",
      "evidence": {
        "pendingChildrenCreated": 12,
        "ids": [
          "s-05",
          "s-06",
          "s-07",
          "s-08",
          "s-09",
          "s-10",
          "s-11",
          "s-12",
          "s-13",
          "s-14",
          "s-15",
          "s-16"
        ]
      }
    },
    {
      "name": "check_inbox consumes before any explicit delivery acknowledgement",
      "evidence": {
        "firstCount": 3,
        "retryCount": 0
      }
    },
    {
      "name": "pause after pointer does not cancel pending Enter",
      "evidence": [
        {
          "value": "New messages (1). Call check_inbox.",
          "paused": false
        },
        {
          "value": "\r",
          "paused": true
        }
      ]
    },
    {
      "name": "SIGKILL lock holder leaves unrecoverable map lock",
      "evidence": {
        "outcomes": [
          "MapLockTimeoutError",
          "MapLockTimeoutError"
        ],
        "lockStillPresent": true
      }
    },
    {
      "name": "launch error after PTY start does not roll back process",
      "evidence": {
        "launchError": "MapLockTimeoutError",
        "startCalls": 1,
        "stopCalls": 0,
        "fakePtyStillLive": true,
        "recordLifecycle": "pending",
        "recordPid": null
      }
    }
  ]
}

```


---

## ПРОТОКОЛ ПРОВЕРКИ: vendor-audit-repro-results.json

```
{
  "worktree": {
    "launchCwdIsWorktree": true,
    "correctCwdWouldFind": "019ce3d5-584a-7be2-922e-b8185a8d7c19",
    "actualLink": null
  },
  "resumeWithoutBindingIsNewSession": true,
  "foreignRootThreadCanBindToWorktree": "019ce3d5-aaaa-7be2-922e-b8185a8d0003",
  "resumeUsesForeignThread": [
    "resume",
    "019ce3d5-aaaa-7be2-922e-b8185a8d0003"
  ],
  "sameThreadCanBindAcrossWorks": "019ce3d5-aaaa-7be2-922e-b8185a8d0003",
  "agentSummaryIsPromotedToClaudeSystemPrompt": true,
  "quietCodexChild": {
    "briefOnDiskContainsParentSummary": true,
    "anyLaunchArgumentContainsParentSummary": false,
    "anyArgumentHasGuidance": false
  },
  "glmTaskDropped": {
    "command": "glm",
    "args": [],
    "taskInBrief": true
  }
}

```


---

## ПРОТОКОЛ ПРОВЕРКИ: parley-ux-routing-repro.json

```
{
  "before": {
    "text": "Всем: @s02 проверит API, остальные пишут тесты",
    "to": []
  },
  "after": {
    "text": "Всем: @s02 проверит API, остальные пишут тесты",
    "to": ["s-02"]
  },
  "unchangedText": true,
  "routingChanged": true
}

```


---

## ПРОТОКОЛ ПРОВЕРКИ: parley-audit/context-proof-output.txt

```
TEXT_SIZES {"guidance":{"characters":2832,"bytes":2878,"words":486,"lines":14},"brief":{"characters":635,"bytes":647,"words":109,"lines":24},"skill":{"characters":3680,"bytes":3724,"words":615,"lines":43},"fullGuide":{"characters":21974,"bytes":22088,"words":3738,"lines":373},"topics":[{"topic":"overview","characters":642,"bytes":642,"words":113,"lines":12},{"topic":"lifecycle","characters":811,"bytes":817,"words":133,"lines":14},{"topic":"tools","characters":3545,"bytes":3569,"words":612,"lines":52},{"topic":"rooms","characters":1953,"bytes":1963,"words":337,"lines":31},{"topic":"lead","characters":3350,"bytes":3370,"words":570,"lines":50},{"topic":"member","characters":1584,"bytes":1592,"words":281,"lines":24},{"topic":"brief","characters":481,"bytes":481,"words":84,"lines":9},{"topic":"window","characters":3672,"bytes":3680,"words":611,"lines":78},{"topic":"worktrees","characters":1515,"bytes":1519,"words":258,"lines":30},{"topic":"letters","characters":3529,"bytes":3549,"words":588,"lines":57},{"topic":"rules","characters":857,"bytes":871,"words":155,"lines":14}]}
GROWTH {"messages":10,"brief":{"characters":40827,"bytes":40839,"words":152,"lines":37},"mapBytes":42401,"frameBytes":42510,"framing":"accepted"}
GROWTH {"messages":100,"brief":{"characters":402357,"bytes":402369,"words":512,"lines":127},"mapBytes":413922,"frameBytes":414031,"framing":"accepted"}
GROWTH {"messages":1000,"brief":{"characters":4017657,"bytes":4017669,"words":4112,"lines":1027},"mapBytes":4130023,"frameBytes":4130132,"framing":"accepted"}
GROWTH {"messages":2100,"brief":{"characters":8436357,"bytes":8436369,"words":8512,"lines":2127},"mapBytes":8673023,"frameBytes":8673132,"framing":"LineTooLongError"}
LARGE_GOAL {"characters":102813,"bytes":102859,"words":484,"lines":14}
DISABLED_PLUGIN_VERSION [{"name":"demo:sample","description":"old","source":"plugin","path":"/tmp/parley-capabilities-audit-ZyjpyM/home/.claude/plugins/cache/market/demo/2.9.0/skills/sample"}]

```


---

## ПРОТОКОЛ ПРОВЕРКИ: parley-audit/metrics-proof-output.txt

```
ACTUAL_METRICS_FOR_AFTER_DONE {"lifecycle":"active","result":"done","indexedTokens":{"input":1000,"output":200,"cacheRead":500,"cacheWrite":0},"live":{"tokensIn":100,"tokensOut":20,"durationMs":100,"unread":0,"subagents":0,"model":"synthetic","tasks":[],"waitingFor":null,"mailWaiting":null}}
SAME_FUNCTION_WITHOUT_FROZEN_SNAPSHOT {"live":{"tokensIn":1000,"tokensOut":200,"durationMs":1000,"unread":0,"subagents":0,"model":"synthetic","tasks":[],"waitingFor":null,"mailWaiting":null}}

```
