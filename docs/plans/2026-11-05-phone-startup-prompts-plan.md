# Стартовые вопросы CLI с телефона — план реализации sg-23

> Для исполнителей: после отдельного разрешения на реализацию выполнять по одной задаче через
> `superpowers:executing-plans` с собственным проверочным циклом. В текущем раунде разрешены только
> спецификация и план. Этот документ не является разрешением писать код или запускать реализацию.

**Goal:** новая сессия из iOS в свежем известном проекте достигает первого хода после решений на телефоне.

**Architecture:** host preflight подавляет уже решённые вопросы конфигурацией; отдельный coordinator
распознаёт оставшиеся startup-экраны и отвечает на них после `consents.decide`. Предстартовые holds не
смешиваются с живыми PTY. Клиент не получает терминального ввода.

**Tech Stack:** TypeScript, Zod, Vitest, node-pty, существующий @xterm/headless; React / React Native.

**Spec:** `docs/specs/2026-11-05-phone-startup-prompts-design.md` (читать целиком, особенно §3, §4.3, §5 и Q1–Q3).

## Общие ограничения

- Q1–Q3 приняты человеком 2026-11-05 (s-02, r-03, m-26): только подключённый провайдер; карточка риска
  для уже запрошенного bypass/full-access (allow — этот запуск, deny — stop); folder-trust для всего
  Claude-family, включая desktop/wake. Разрешены фиксация документов и коммит; реализация требует отдельного разрешения.
- Анализ сделан по локальному `origin/master` `54d64f7516a5bb0c4a955d53254de35e11a8c034`;
  исходный checkout `f7978af8` отстаёт и не содержит mobile/MCP design. Документы находятся в отдельном
  worktree ветки `docs/phone-startup-prompts`, созданной от указанного `origin/master`. До выдачи задач s-02 называет
  интеграционную базу с A29, проектным MCP consent и mobile. Не делать checkout/rebase чужого дерева.
- Исходный план 2 ноября находится в **docs/specs/**, а не docs/plans. Его T6/T7 не реализуются заново.
- `pty.input` / `pty.resize` запрещены телефону всегда. Не добавлять remote методы, принимающие клавиши/команды.
- `allow` не расширяет сам sandbox; обычные tool approvals не входят в startup-механизм.
- Только собственные профили custom provider получают существующий onboarding/API-key seed. Никакого blanket
  trust, auto-approve MCP, fake OAuth, автоматического запуска updater или отключения защит CLI.
- Один task — один исполнитель; обычно Executor на Sol/Sonnet. T4/T6/T7 **senior-only** по именованным причинам.
  Лид делает приёмку. Каждый получает scope, файлы, зависимости и критерии из этого документа.
- Не трогать чужие изменения. Коммит только после прямого запроса s-02; commit/branch/PR — по-английски.
- Матрица C01–C08/X01–X07 содержит 15 ID. «Н» закрывается воспроизведением либо доказанным N/A, не догадкой.
- Первое нажатие резервирует решение до I/O; live PTY binding не восстанавливается из старой эпохи.
- Не добавлять production-зависимости без отдельного обоснования. Fixtures не содержат секретов, env-значений,
  ключей, key suffix, персональной истории или реальных токенов.

## Файлы и ответственность

| Область | Файлы на базе / новые файлы | Ответственность |
|---|---|---|
| Trust/config | `packages/core/src/work/{trust,claude-trust,launch,codex-policy}.ts`, `core/src/{providers,custom-provider-dir}.ts`, `host/src/sessions/provider-env.ts` | Только существующие config/preflight решения, без TUI bytes |
| Holds/card storage | `packages/host/src/consents/{consents-service,held-launches,project-mcp}.ts` | Предстартовые holds и durable consent state |
| Contract | `packages/protocol/src/consents.ts`, `remote/allowlist.ts`, `packages/remote-client/src/actions.ts` | Проверяемые DTO, решения и отсутствие raw input |
| Экран | `packages/host/src/pty/{screen,pty-manager}.ts` | После-парсинга snapshot, процесс/эпоха и внутренняя запись |
| Распознавание (новые) | `packages/host/src/sessions/startup-prompt-registry.ts`, `startup-prompt-registry.test.ts`, `fixtures/startup-prompts/` | Чистые adapters и обезличенные PTY fixtures |
| Coordinator (новые) | `packages/host/src/sessions/startup-prompts.ts`, `startup-prompts.test.ts` | Startup state machine, live bindings, проверка до write |
| Интеграция | `packages/host/src/sessions/sessions-service.ts`, `packages/host/src/methods/consents.ts`, `packages/host/src/host.ts` | Wiring coordinator и существующего lifecycle |
| Phone | `packages/mobile/src/cards/{consent-model,use-consents}.ts`, `ConsentViews.tsx`; `packages/remote-client/test/actions.test.ts` | Карточка, точный ref, stale/lost handling |
| Desktop | `packages/desktop/src/renderer/components/dialogs/ConsentPrompt.tsx`, `island/consents/ConsentView.tsx`, соответствующие stores/tests | Паритет и неизвестные виды |

Фактическая точка host composition уточняется T1/T2 на принятой базе; это не разрешение рефакторить весь host.

## Review focus

1. Несовпадающие эпоха/процесс/кадр: allow никогда не попадает в новую сессию или composer — T6/T7.
2. Параллельные startup-диалоги и split ANSI: одна карточка не отвечает на следующий экран — T5/T7.
3. Общий профиль Claude/GLM и ротация ключа: чужие поля/решения сохраняются, секретов на wire нет — T1/T4.
4. Один consent удерживает сессии разных work, одинаковые `s-01` в разных проектах: точные refs — T3/T8.
5. CLI обновился/managed policy переопределила flags: unsupported виден на телефоне, нет blind Enter — T2/T5/T10.

## Последовательность и контрольные точки

T1 и T2 независимы. После них лид утверждает конкретные версии/fixtures; до этого live terminal writers
не реализуются. T3 (b-021) можно делать независимо. T4 зависит от T1/T2 и применяет принятое Q3. T5 зависит от T1/T2.
T6 зависит от T5 и принятого DTO §5; T7 — от T4/T5/T6. T8 и T9 независимы после T3/T6.
T10 проверяет собранный результат. Задачи перечислены для будущей выдачи, исполнители сейчас не запущены.

Каждый implementation task: добавить содержательный failing case → запустить точный файл теста и увидеть
ожидаемую причину → минимальная реализация → повтор точного набора и typecheck затронутых consumers → ревью.
Случаи, подтверждающие существующее поведение, остаются baseline-pass; не изображать их новыми исправлениями.

### Соответствие инвентаря проверкам

Каждая строка — самостоятельный named test, даже когда несколько строк живут в одном тестовом файле.
T10 проверяет весь manifest; здесь указан владелец реализации/регрессии после исследовательских T1/T2.

| ID | Проверка | Владелец |
|---|---|---|
| C01 | Новый repo/worktree, allow/deny, ошибка A29, отзыв trust | T4 + T7 |
| C02 | MCP выбор/deny-all, смена fingerprint, повторный preflight | T3 + T4 + T7 |
| C03 | Карточка риска для запрошенного bypass: allow только этот запуск, deny stop; unknown variant без ввода | T5 + T6 |
| C04 | Custom key rotation/bearer и обычный Claude key notice без утечки | T4 + T6 |
| C05 | Onboarding seed/тема; сохранённый выбор не перезаписывается | T4 + T5 + T7 |
| C06 | Security notes ack/deny; следующий экран не получает Enter | T5 + T6 + T7 |
| C07 | Нет credentials/expired: готовность отказана или startup остановлен с причиной | T4 + T7 |
| C08 | Неблокирующий banner не даёт consent; неизвестный modal без ввода | T5 + T7 |
| X01 | Folder access, два ответа, realpath/worktree, точный hold | T3 + T4 |
| X02 | Update suppression при launch/resume без prompt | T4 |
| X03 | Миграция: keep current; current удалена — явный отказ | T5 + T6 + T7 |
| X04 | Resume в другом cwd, путь отсутствует, trust для выбранной папки | T4 |
| X05 | Login не получает ввода; verified welcome имеет отдельный ack/deny case | T4 + T5 + T7 |
| X06 | Неблокирующий full-access banner; blocking вариант — risk card по принятому Q2 | T5 + T6 |
| X07 | Hooks warning без auto-trust; unknown daemon recovery без auto-repair | T5 + T7 |

## T1. Claude-family: подтвердить матрицу и профили

**Исполнитель:** junior Executor; лид проверяет выводы. **Scope:** исследование C01–C08, без production edits.

**Файлы:** новый `docs/research/2026-11-05-phone-startup-prompts-evidence.md` (секция Claude), будущие fixtures
`packages/host/src/sessions/fixtures/startup-prompts/claude-*.txt` и manifest; ссылки на E2/E4/E5/E6.

- [ ] Зафиксировать реальный бинарь/версию, итоговый argv и профиль каждого из Claude, GLM, custom bearer,
  custom api-key, extra account. Использовать изолированные временные профили; реальный home не редактировать.
- [ ] Воспроизвести C01–C08 безопасными setup-кейсами; установить точные пункты/выбранный пункт/байты ответа
  и критерий готовности. Новые найденные блокирующие диалоги добавить в инвентарь до реализации.
- [ ] Подтвердить, где onboarding seed допустим, что произойдёт с explicit false и locked/corrupt profile;
  отдельно отсутствие записи секретов в capture. Для API-key использовать фиктивный локальный endpoint.
- [ ] C03 проверить только в изолированном fixture-проекте без задачи исполнения; не включать bypass для
  рабочего проекта. По принятому Q2 проверить allow только для этого запуска и deny = stop;
  постоянное разрешение опасного режима не создаётся.
- [ ] Сохранить команды/версии/ожидаемые экраны и результат: verified / N/A / not verified с причиной.

**Приёмка:** каждая C-строка имеет проверяемое основание и test ID; непроверенный сценарий остаётся явным
блокером своей поддержки. Credentialed model-turn не обязателен для записи screen fixture; его проверяет T10.
**Measure:** покрытие C01–C08 по manifest; успешность настоящего first turn — not measured в T1.

## T2. Codex: подтвердить suppression и оставшиеся экраны

**Исполнитель:** junior Executor. **Scope:** X01–X07, audit runner overrides; без production edits.

**Файлы:** тот же evidence-документ (секция Codex; не параллельная запись одной секции), `fixtures/startup-prompts/codex-*.txt`, manifest.

- [ ] Зафиксировать установленную версию и source tag. Проверить X01/X02 по свежему временному проекту/кэшу;
  личные `~/.codex` и настройки не менять, updater не запускать.
- [ ] Для X03 получить migration fixture с известными current/target и вариантом «keep current»;
  отдельно сценарий, где current model удалена. Не подменять выбранную человеком модель автоматически.
- [ ] Для X04 проверить `--cd` в реальном синтаксисе resume; зафиксировать один поддержанный способ.
  Не оставлять выбор между `--cd` и `tui.resume_cwd` на усмотрение каждого исполнителя.
- [ ] Классифицировать X05–X07 как блокирующие/неблокирующие на проверенной версии, проверить custom argv.
  Внутренние помощники `exec`/`-p` и произвольные CLI пометить вне интерактивной гарантии.
- [ ] Лид принимает manifest поддержанных версий и список неопределённостей. Если неизвестный вопрос мешает
  основному positive пути, соответствующий provider ещё нельзя объявить поддержанным.

**Приёмка:** X01–X07 имеют независимые cases или доказанные N/A; suppress-флаг не принимается за результат
без screen probe. **Measure:** покрытие X-матрицы; новая версия/неизвестный override не auto-supported.

## T3. b-021: holds в существующих карточках

**Исполнитель:** junior Executor. Перед выдачей s-02 проверяет владельца b-021: если уже сделано, задача —
только сверка зависимости, без дублирующего патча. **Зависимости:** согласованная база.

**Файлы:** `packages/protocol/src/consents.ts`, `consents.test.ts`;
`packages/host/src/consents/consents-service.ts`, `.test.ts`; дополнение §7.2 существующего дизайна 2 ноября.

- [ ] Добавить red cases: один folder/MCP consent удерживает две сессии, добавление второго hold даёт upsert;
  prune/close удаляет только соответствующий ref; одинаковые sessionId разных проектов различаются.
- [ ] Вывести `holds: SessionRef[]` из `state.holds`, не из requestedBy; дедупликация полного ref.
  При изменении только holds MCP server revision прежняя; store/restart возвращает тот же актуальный набор.
- [ ] Обновить типы/фикстуры; описать совместимость старого хоста без поля. Не менять allow/deny семантику.
- [ ] Проверить protocol и consents-service tests.

**Приёмка:** holds точно равны удержаниям; UI может отказаться от work-level фильтра. **Measure:** матрица
one/many/pruned/restored holds, ноль ошибочных refs; runtime speed — not declared, не цель задачи.

## T4. Общий preflight и безопасная подготовка CLI

**Исполнитель:** **senior-only** — меняет доверие проекту, границу записи профилей и взаимодействие с отзывом.
**Зависимости:** T1/T2; применять принятое Q3. Лид явно называет исключение из junior implementation до выдачи.

**Файлы:** `packages/host/src/sessions/sessions-service.ts`, `sessions-service.consent.test.ts`;
`packages/core/src/work/{trust,claude-trust,launch,codex-policy}.ts` и тесты рядом; `core/src/providers.ts`,
`providers.test.ts`; `custom-provider-dir.ts` только если T1 доказал конкретный пробел.

- [ ] Red cases C01/X01: untrusted Claude-family hold до spawn/worktree/reserve, allow продолжает один launch,
  deny применяет нынешнюю разницу fresh/resume/switch; `trustFolder` не спрашивает повторно.
- [ ] Подключить общий gate к `isTrusted`; сохранить A29 serial trust / marks / revoke, state-file selection.
  Native-only trust не молча импортировать в Parley. Проверить realpath, repo/worktree и отдельный configDir.
- [ ] Сохранить MCP preflight/final inspect и правила отказа. При неудаче trust seed вернуть coordinator
  структурированный outcome, а не интерпретировать warning как успех; unsupported не маскировать.
- [ ] C07/X05: связать уже существующую проверку подключения с запуском; отсутствие credentials даёт
  понятную причину до spawn. Не считать login-status гарантией валидного токена: неожиданный login обрабатывает T7.
- [ ] Добавить проверенный T2 resume cwd способ; сохранить X02 launch/resume suppression.
- [ ] Подтвердить C04/C05 существующие seed-пути: key rotation, bearer switch, explicit preference, чужие поля.
  Не писать guessed onboarding/bypass flags и не менять sandbox policy.

**Приёмка:** C01/C02/C04/C05 и X01/X02/X04 проходят exact tests; no trust → no launch side effects;
revoke сериализован; чужие настройки сохранены. **Measure:** конфиги до/после и количество spawn, а не число строк кода.

## T5. Чистый детектор и завершённые кадры xterm

**Исполнитель:** junior Executor. **Зависимости:** принятые fixtures T1/T2. **Scope:** чтение/классификация,
без PTY write, persistence и remote mutation.

**Файлы:** новые `packages/host/src/sessions/startup-prompt-registry.ts`, `.test.ts`, fixtures;
`packages/host/src/pty/screen.ts`, `screen.test.ts` (минимальный parse-complete callback).

- [ ] Для каждого поддержанного prompt завести полный shape matcher и версионную область. Результат чистый:
  `{ promptId, semanticFingerprint, safeContext, selectedChoice } | null`, без свободного UI-текста.
- [ ] Red cases: текст вопроса в scrollback, цитата в агентском ответе, частичный кадр, ANSI split, другой cwd,
  переотрисовка и перенос строки, изменённый выбранный пункт, неизвестная версия. Ложные совпадения → null.
- [ ] Добавить read-after-parse путь в Screen, не таймер «подождать 100 ms». Детерминированно прогнать fixture
  цельным блоком и несколькими разбиениями; сопоставить одинаковый итоговый кадр.
- [ ] Неблокирующие C08/X06/X07 не дают consent. Watchdog не входит в matcher и не классифицирует prompt по времени.

**Приёмка:** каждый verified fixture имеет самостоятельный тест; ноль write в этой задаче.
**Measure:** fixture→promptId, отрицательные совпадения и chunk-invariance; длительность parser — not measured,
если нет конкретной performance-проблемы.

## T6. DTO и транзакция решения живого startup-вопроса

**Исполнитель:** **senior-only** — security/write boundary, at-most-once, crash recovery. **Зависимости:** T5,
принятое Q2, §5 дизайна. **Scope:** contract и изолированный coordinator с fake PTY; wiring отдельной задачей.

**Файлы:** `packages/protocol/src/consents.ts`, `consents.test.ts`; новые
`packages/host/src/sessions/startup-prompts.ts`, `.test.ts`; `host/src/consents/consents-service.ts`, `.test.ts`;
`host/src/methods/consents.ts`, `.test.ts`. Минимальные unknown-kind guards в consumers, чтобы union компилировался.

- [ ] Ввести discriminated `cli-startup` version 1/context с полями §5; `revision` обязателен для нового вида,
  `enabled` допустим только для MCP. Проверить запрет raw input/keys/command полей и неправильного context.
- [ ] Разделить live bindings и HeldLaunch; idempotent decision не вызывает `continueLaunch` живого процесса.
- [ ] Синхронно зарезервировать решение, validate текущие launchId/epoch/ref/screen, сохранить intent с
  fail-closed outcome. No persistence → no write. Сохранить прежний RPC result shape и `by: phone`.
- [ ] At-most-once tests: два решения, save failure, crash до/после write, write exception, stale revision,
  смена процесса между чтениями, переход на другой экран между клавишами, unknown id после рестарта.
- [ ] Удалять потерянные live cards при restart/close/switch; не переигрывать записанный intent и не объявлять
  first turn по одному `applied:true`. Prelaunch holds продолжают восстанавливаться отдельно.

**Приёмка:** матрица гонок даёт максимум одну разрешённую последовательность на решение и ноль write в
чужой процесс; секретов в serialised DTO/аудите нет. **Measure:** fake PTY write log и persisted intent;
exactly-once не заявляется.

## T7. Подключить coordinator к lifecycle, очереди и PTY

**Исполнитель:** **senior-only** — гонки между launch/stop/manual input и write, недопущение повторного task.
**Зависимости:** T4/T5/T6.

**Файлы:** `packages/host/src/pty/pty-manager.ts`, `.test.ts`; `sessions/startup-prompts.ts`, `.test.ts`;
`sessions/sessions-service.ts`, `sessions-service.consent.test.ts`; `host.ts` (wiring), существующие send/wake
точки только для startup gate. Новый интеграционный `sessions/startup-prompts.integration.test.ts`.

- [ ] При spawn назначить launchId и зарегистрировать observation до потери первых bytes; observer получает
  завершённые кадры, detach на ready/exit. Ручной input инвалидирует карточку перед записью.
- [ ] Подключить только внутренний guarded writer; чужие входы не получают его callback. Для каждого шага
  ответа повторно проверить кадр; при неизвестном результате никакого слепого Enter.
- [ ] Initial argv prompt не дублировать; send/wake delivery ждёт ready, unread/queue semantics сохранить.
  Для остаточного MCP остановить только доказанно pre-turn процесс, re-inspect и вернуть preflight card.
- [ ] Fake clock: 30 секунд без ready/известной карточки → host notice / видимый blocked reason, ноль ввода;
  поздняя готовность снимает notice. Known pending card не истекает по таймеру.
- [ ] C07/X05: распознанный login после неудачной авторизации останавливает startup с причиной
  provider-needs-sign-in; никаких ответов в login, автоматического OAuth или перезапуска с задачей.
- [ ] End-to-end fake PTY: C05 → C06 → C01 → ready, две сессии, deny, close, switch, restart, MCP rediscovery;
  первый ход прекращает startup detection навсегда для этого launchId.

**Приёмка:** нет второго процесса из live consent, нет повторного task, очередь не попадает в меню,
все реальные writes имеют trace решения или разрешённого neutral theme adapter.
**Measure:** spawn count, task delivery count, write log, deterministic timeout; не измерять модельный latency фейком.

## T8. Phone и remote-client: карточка и точная сессия

**Исполнитель:** junior Executor. **Зависимости:** T3/T6; runtime E2E требует T7.

**Файлы:** `packages/mobile/src/cards/{consent-model,use-consents}.ts`, `ConsentViews.tsx`, тесты рядом;
`packages/remote-client/src/actions.ts`, `test/actions.test.ts`; `packages/protocol/src/remote/allowlist.ts`
и его тест только для проверки сохранения границ, не для расширения списка методов.

- [ ] Добавить UI каждого поддержанного prompt с точной семантикой allow/deny §5, explicit bypass copy;
  версия неизвестна → нет Allow, понятная подсказка обновить клиент. Не отображать raw screen.
- [ ] Session filtering использует полный ref: holds для folder/MCP, ref для cli-startup/agent-switch.
  На старом хосте без holds оставить Inbox, убрать неверную work-level привязку.
- [ ] Передавать revision обоих ответов нового вида; stale показывает перечитанный запрос; lost response
  не повторяется. «Решение принято» не подменяет статус реального запуска.
- [ ] Проверить Inbox/session, foreground restore, два проекта с одинаковыми work/session IDs, два устройства,
  app lock и выключенный desktop toggle. Remote `pty.input`/resize/keys по-прежнему rejected.

**Приёмка:** все новые prompts доступны через существующие consents RPC; 0 raw input RPC; 0 карточек чужой
сессии. **Measure:** action payload assertions, UI states и снимки agreed cases после реализации.

## T9. Desktop/island и совместимость consumers

**Исполнитель:** junior Executor. **Зависимости:** T3/T6; не пересекаться с файлами T8.

**Файлы:** `packages/desktop/src/renderer/components/dialogs/ConsentPrompt.tsx`, тест;
`renderer/island/consents/ConsentView.tsx`, тест/store; desktop store tests;
`packages/host/src/telegram/service.consent.test.ts` и соответствующий consumer только при ошибке unknown-kind handling.

- [ ] Отобразить те же типизированные решения/тексты, revision для обоих ответов; обновить устаревшую
  подпись «For Claude Code nothing changes yet» в затронутых UI строках согласно Q3.
- [ ] Проверить отсутствие предположения «всё, кроме agent-switch, это folder-trust» во всех consumers.
  Старые/неподдержанные клиенты не могут отправить неоднозначный allow.
- [ ] Двойное решение desktop/phone обновляет обе поверхности без повторного write; live binding не
  удаляется prelaunch prune как якобы уже запущенная сессия.
- [ ] Снять agreed UI states через Parley browser для web/desktop-preview; native mobile снимки — T10.

**Приёмка:** protocol consumers typecheck, неизвестный вид безопасен, семантика MCP deny прежняя.
**Measure:** одинаковая семантика кнопок и wire решений; снимки — после реализации, сейчас not declared.

## T10. Матрица first-turn и окончательная проверка

**Исполнитель:** junior Verifier; окончательный verdict пишет senior lead. **Зависимости:** T1–T9.

**Файлы:** `docs/research/2026-11-05-phone-startup-prompts-evidence.md`, новый
`docs/audits/2026-11-05/phone-startup-prompts-verification.md`; новые/расширенные integration fixtures только
по найденному пробелу. Production edits возвращаются владельцу соответствующего task.

- [ ] Проверить manifest: ровно все ID дизайна имеют тест/обоснованное N/A; неизвестные живые блокировки
  не спрятаны под общим timeout case. Повторить version probes после изменений бинаря.
- [ ] На принятой базе выполнить адресные команды, например:
  `pnpm --filter @parley/host exec vitest run src/sessions/startup-prompts.test.ts src/sessions/startup-prompts.integration.test.ts`;
  `pnpm --filter @parley/protocol exec vitest run src/consents.test.ts`;
  `pnpm --filter @parley/remote-client exec vitest run test/actions.test.ts`.
  T3–T9 также запускают собственные перечисленные тесты. Проверить typecheck изменённых packages и обычный lint;
  полный build/test расширять при интеграционном риске или требовании CI, не повторять без причины.
- [ ] С реального iOS клиента выполнить positive маршрут §7 для шести provider/profile вариантов, fresh
  project/worktree, chained prompts, Codex resume; безопасная задача с узнаваемым первым ответом.
- [ ] Зафиксировать 0 desktop действий после launch и 0 remote `pty.input`, по одному завершению первого
  хода, версию CLI/app/host, refs, timestamps и redacted write provenance. Отдельно отрицательные случаи
  отсутствия credentials, deny, unknown version, отключённый toggle и lost response.
- [ ] Для UI web-проверок использовать Parley browser; реальный iOS first-turn не заменять браузерным mock.
  Непроведённые device/auth случаи перечислить в «Не проверено», без pass и без выдуманных чисел.
- [ ] Лид сопоставляет evidence с приёмкой, фиксирует impact card: Goal, Behaviour, Numbers, Screens,
  For the human, Risk, Cost, Verdict. До доказанного positive маршрута функция не считается доставленной.

**Приёмка:** доказан no-Mac first turn на поддержанных версиях и профилях; отрицательные случаи понятны
на телефоне; нет ослабления permissions, разглашения ключей или повторного исполнения задач.
**Measure:** cases baseline→head, exact prompt coverage, desktop actions, remote PTY calls, task/write counts,
время после последнего решения отдельно от очереди/человека/сети. Если значение не получено — not measured.

## Не проверено в документальном раунде

- Живое воспроизведение CLI: использованы прежние документированные пробы, код и первичные внешние источники.
- Текущий установленный набор версий и все неизвестные варианты C03/C08/X03–X07; их закрывают T1/T2.
- Runtime tests, сборка и реальные iOS first-turn: код не менялся, функция ещё не реализована.
- Интеграционная база будущей реализации: её выберет s-02 перед выдачей задач; база документальной
  ветки — `54d64f75`. Q1–Q3 уже приняты и не являются открытыми вопросами.

## Impact card плана

Goal: разбить sg-23 на проверяемые задачи без незаявленного расширения remote-доступа.
Behaviour: 10 задач с файлами, зависимостями, проверками и измерением; runtime unchanged.
Numbers: 15 ID матрицы; 3 senior-only задачи (T4/T6/T7); длительность/стоимость реализации — not measured.
Screens: not declared — документальный раунд, экраны не реализованы.
For the human: принятые границы входа, опасных режимов и доверия отражены в задачах; продуктовых развилок Q1–Q3 нет.
Risk: T1/T2 могут обнаружить несовместимые версии; это требует уточнения adapters, не silent fallback.
Cost: два документа вместе со спецификацией; dependencies 0; tokens/runtime test time — not measured.
Verdict: план подготовлен s-06 для review; приёмка реализации остаётся невыполненной.
