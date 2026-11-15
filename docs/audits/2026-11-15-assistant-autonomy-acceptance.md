# Приёмка этапа 1: автономный режим помощника (T1)

Ветка `feat/assistant-autonomy`, head `51c2b77c`, база `origin/master` `3672f0a1`. Проверяющий: s-390, независимо от исполнителей. Код и тесты не менялись. Живая часть не пройдена (лист ниже).

## 1. Полный прогон

| Команда | Итог |
|---|---|
| `pnpm build` | прошёл, все пакеты, desktop собран |
| `pnpm lint` | прошёл, замечаний нет |
| `pnpm typecheck` | прошёл, ошибок нет |
| `pnpm test` | остановился на первом упавшем пакете (core), поэтому дальше прогнан `pnpm -r --no-bail test`: 23 820 тестов прошло, 2 упало (оба до ветки, см. ниже), 41 пропущен |
| `pnpm --filter @parley/desktop e2e` | запустился (сеть не понадобилась): 236 прошло, 64 упало, 1 пропущен, 6,7 мин. Причина падений НЕ установлена, см. 1.3 |

По пакетам (прошло / упало / пропущено): core 6736/1/1, host 4982/1/7, protocol 560, desktop 10246/0/30, mobile 745, remote 230/0/3, remote-client 168, relay 40, push-gateway 30, noise 65, file-icons 18.

### 1.1 Два упавших юнит-теста: оба зависят от машины, на базе падают так же

- `packages/host/src/methods/providers.test.ts` «версии кэшируются по отпечатку бинаря…»: на `origin/master` (временный `git worktree`, зависимости ветки по ссылкам) упал так же: `Tests 1 failed | 20 passed`, `calls` содержит `qwen` четыре раза вместо одного.
- `packages/core/src/work/launch.test.ts` «claude получает id сессии, конфиг MCP файлом…»: ожидает `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, а в окружении проверяющего эта переменная уже задана (`1860000`), код её не добавляет. На базе падает так же (`1 failed | 257 passed`). С `env -u CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` на ветке: `258 passed`. Это второй тест, зависящий от окружения; исполнители о нём не сообщали.

### 1.2 Прогон e2e

Заявленная исполнителем A8 причина («playwright качает Electron, сети нет») на этой машине не подтвердилась: Electron запустился, 236 сценариев прошли.

### 1.3 Падения e2e: не отнесены ни к ветке, ни к среде

64 падения в 26 файлах. Все 12 сценариев `assistant.spec.ts` (включая новый A8 «значок Auto», AU-18) падают на одном шаге: `expect.poll(() => islandPage(app) !== undefined) — остров создан` не дождался окна острова за 5 с (`assistant.spec.ts:340`). Тот же текст «остров создан/показан» у падающих `island.spec.ts` (6), `island-sound.spec.ts` (2) и сценариев, не связанных с помощником (claude-account 7, custom-providers 5, providers-connect 3, parley-integration 5, chat-hooks 3 и др.). Повтор одного A8 отдельно упал так же.
Базовый прогон e2e (сборка `origin/master` с отдельными зависимостями) не делался: ссылки на зависимости ветки подставили бы пакеты ветки. Поэтому ответить «регрессия или среда» нельзя. Признак среды: окно острова не создаётся и в сценариях, которые ветка не трогала. Критерии, зависящие от e2e (AU-18), отмечены NOT VERIFIED.
Побочный эффект прогона: e2e переписал `docs/audits/2026-11-09/session-processes-chip.png`; возвращено `git checkout`, в коммит не вошло.

## 2. AU-01: промпты и описания при выключенном флаге (скрипт)

Скрипт `dump.mts` (tsx) загружает исходники ветки и `origin/master` и сравнивает строки. Результат:

| Что | Итог |
|---|---|
| `assistantPrompt` (ru/en × female/male, без опций) | равны посимвольно |
| `JOB_PROMPT` | равен |
| описания и схемы 16 прежних инструментов `ASSISTANT_TOOLS` | равны (по `JSON.stringify` каждого) |
| `VOICE_PROMPT` | отличается (спека AU-01 это разрешает) |
| список инструментов | **17 против 16**: добавлен `action_status` |

Системный промпт job при выключенном флаге: `JOB_PROMPT` (константа) равен; `createJobPrompt` (вход job) этим скриптом не сравнивался.

## 3. Размер списка инструментов: `JSON.stringify(ASSISTANT_TOOLS)`

| | знаков | байт UTF-8 |
|---|---|---|
| база | 15 101 | 15 143 |
| ветка | 15 708 | 15 750 |
| разница | +607 | +607 |

## 4. Пара версий (§9) по коду и тестам

- Окно не зовёт `assistant.journal` без него в `hello.methods`: `AssistantJournal.tsx:16` (`hostMethods(status).has`), тест `AssistantJournal.test.tsx` «не зовёт метод, когда его нет в hello.methods». PASS.
- То же для `assistant.stopPlan`: `IslandApp.tsx:879` даёт `onStopPlan` только если метод в `progressConnection.methods`. Тест на `AssistantView` проверяет только кнопку при заданном `onStopPlan`; самой привязки в `IslandApp` тест не проверяет. Код верный, прямого теста нет.
- Переключатель скрыт без ключа в `config`: `AssistantSettings.tsx:152`, тест «переключателя нет, когда ключа нет в config». PASS.
- Request без `origin` читается как `island`: `delegation.ts:91`, тест `delegation.test.ts` «origin служебного; у старого хоста поля нет → island». PASS.
- Связанное: `remote` не видит и не зовёт `assistant.stopPlan`, `assistant.journal`, `settings.set`: `server.test.ts:624` («unknown_method»). PASS.

## 4.1 Допуск системного job (AU-07)

Пересказчик (`system`) токена и записи допуска не получает (RW-15: ни токена, ни `--mcp-config`), поэтому «поздний вызов старого хода» для него невозможен. `autoAtStart = false` для `system` проверен: `job-executor.test.ts:356` (по таблице происхождение×флаг), `job-tokens.test.ts:87`.

## 5. Таблица сценариев

«Прошёл» = тест входит в прогон выше и зелёный. Колонка статуса: PASS, PARTIAL (часть не покрыта тестом), LIVE (только живой прогон), NOT VERIFIED.

### AU

| ID | Статус | Тест |
|---|---|---|
| AU-01 | PASS (скриптом) + отклонение D1 | сравнение §2; `voice-prompt.test.ts`, `core/src/assistant/launch.test.ts` |
| AU-02 | PASS | `assistant-service.test.ts` «AU-02: просьба с острова…» |
| AU-03 | PARTIAL | job с `origin: island` и итог `completed`: `job-executor.test.ts` (autoAtStart по таблице; «I sent the report» → completed). Итог, звучащий голосом, — живой прогон |
| AU-04 | PASS | `assistant-service.test.ts` «AU-04/AU-05: ход %s…» |
| AU-05 | PASS | то же + «AU-05: job с телефона…» |
| AU-06 | PASS | «AU-06: флаг выключили посреди запуска» и ещё два «AU-06…» |
| AU-07 | PASS | `assistant-service.test.ts` «ход %s сменился ходом island… 401» (reminder, telegram), «отмена хода между проверкой токена и обработкой»; `assistant-endpoint.test.ts` «токен попытки хода…»; `job-executor.test.ts` autoAtStart system=false |
| AU-08 | PASS | «AU-08: отмена job, пока propose_actions ждёт слот…» |
| AU-09 | PASS | «AU-09: два propose_actions одновременно…» |
| AU-10 | PASS (Claude и Codex отдельно не проверены) | «AU-10: слот занят дольше срока», «AU-10/AU-21: план дольше остатка срока». Проверка «на Claude и Codex» из спеки отдельным тестом не видна |
| AU-11 | PASS | три «AU-11…» + «AU-11 через план» |
| AU-12 | PASS | «AU-12: план из 5 шагов падает на третьем» |
| AU-13 | PASS | «AU-13: план с шагом неизвестного вида» |
| AU-14 | PASS | два «AU-14…» в `assistant-service.test.ts`; «при активном Live» отдельно не проверено |
| AU-15 | PASS | `describe('AU-15: рестарт хоста…')`, «AU-15: job закончился до рестарта…» |
| AU-16 | PASS | «AU-16: автоматическая карточка — не телефону и не в Telegram» |
| AU-17 | LIVE | нет автоматического теста (живой лист) |
| AU-18 | NOT VERIFIED | e2e `assistant.spec.ts:494` падает на создании окна острова (§1.3); юнит: `AssistantView.test.tsx` «Stop», `AssistantSettings.test.tsx`; значок и 800×500 живым e2e не подтверждены |
| AU-19 | PASS | `server.test.ts:624`; «AU-19: autonomous в состоянии равен флагу…» |
| AU-20 | PASS | «AU-20: journal — решённые карточки новыми первыми…»; `AssistantJournal.test.tsx` |
| AU-21 | PASS | три «AU-21…» |

### RW

| ID | Статус | Тест |
|---|---|---|
| RW-01 | LIVE (отдельного теста нет) | цепочка частично в RW-19 |
| RW-02 | PARTIAL | `reply-watch.test.ts` «RW-02: ждёт человека → arm resume → конец хода»; сквозного «ответ человека → итог» нет |
| RW-03 | PASS | `speech-queue-service.test.ts`, `delegation.test.ts` «RW-03…» |
| RW-04 | PASS | `reply-watch.test.ts` ×3, `requests.test.ts`, `assistant-service.test.ts` |
| RW-05 | PASS | `reply-watch.test.ts` «RW-05…» |
| RW-06 | PASS | `reply-watch.test.ts`, `run-plan.test.ts` «RW-06…» |
| RW-07 | PASS | `reply-watch.test.ts` «RW-07…» |
| RW-08 | PASS | `reply-snapshot.test.ts`, `job-executor.test.ts` |
| RW-09 | PASS | `reply-snapshot.test.ts` ×2, `job-executor.test.ts` «RW-09…» |
| RW-10 | PASS | `requests.test.ts` ×2, `request-link.test.ts`, `request-status.test.ts`, `job-context.test.ts`, `status.test.ts`, `delegation.test.ts` |
| RW-11 | PASS | `jobs.test.ts` ×4 |
| RW-12 | PASS | `ingest.test.ts`, `protocol/remote/voice.test.ts` |
| RW-13 | PASS | `delegation.test.ts` «RW-13…» |
| RW-14 | PASS | `delegation.test.ts` ×2, `speech-queue-service.test.ts` |
| RW-15 | PASS | `job-executor.test.ts` ×2 (Claude, Codex) |
| RW-16 | PASS | `assistant-service.test.ts` «RW-16…» |
| RW-17 | PARTIAL | `job-context.test.ts` блок «Agents you recently gave work to» (вход пересказчика и job); что «Y» уходит созданной сессии, зависит от модели — живое |
| RW-18 | LIVE | живой лист |
| RW-19 | PASS | `job-executor.test.ts` «RW-19…», `delegation.test.ts` «RW-19…» |
| RW-20 | PASS | `reply-watch.test.ts` «RW-20…» |
| RW-21 | PASS | `assistant-service.test.ts` ×2 «RW-21…» |
| RW-22 | PASS | `jobs.test.ts` ×2, `delegation.test.ts` «RW-22…» |
| RW-23 | PASS | `speech-queue-service.test.ts`, `delegation.test.ts` «RW-14/RW-23…» |

### Сводка

- AU (21): покрыто и прошло 18 (в т.ч. AU-01 скриптом); частично 2 (AU-03, AU-18); не покрыто автоматикой 1 (AU-17, живой); покрыто и упало 0.
- RW (23): покрыто и прошло 19; частично 2 (RW-02, RW-17); не покрыто автоматикой 2 (RW-01, RW-18, живые); покрыто и упало 0.

## 6. Дефекты и замечания

- **D1 (низкий, спорный).** При выключенном флаге список инструментов разговорного помощника уже содержит `action_status` (17 вместо 16 инструментов, +607 байт). AU-01 требует совпадения описаний с базой: описания прежних инструментов совпадают, но модель при выключенном режиме видит лишний инструмент. Воспроизведение: `ASSISTANT_TOOLS.map(t => t.name)` на ветке и на `origin/master`; `createAssistantServer` без `mode: 'auto'` отдаёт его в `ListTools` для токена разговора (`packages/core/src/mcp/assistant.ts:440–443`). Решить автору спеки: допустимо ли.
- **D2 (замечание).** Тест `launch.test.ts` зависит от переменной окружения `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` (§1.1).
- **D3 (замечание).** Привязка `onStopPlan` к `hello.methods` в `IslandApp.tsx:879` прямым тестом не закрыта (§4).
- **D4 (не дефект ветки).** `providers.test.ts` падает и на базе (§1.1).
- Падения e2e (§1.3) не классифицированы.

## 7. Живой прогон (проходит человек, Mac, реальный ключ OpenAI)

Подготовка: приложение с веткой; Settings → Assistant → Autonomous mode (включить/выключить по шагам); Live острова открыт. Результат писать в колонку «Результат» (пусто до прогона).

| Шаг | Что сказать или нажать | Ожидается | Результат |
|---|---|---|---|
| AU-03 | Режим включён. Голосом: «создай сессию в работе X и дай задачу Y» | Сессия создана без клика; голос говорит, что сделано; job `completed` | |
| AU-17a | Режим включён, голосом «передай сессии Z: …» | Голос говорит «сделано»; «сделано» не звучит до фактического исполнения | |
| AU-17b | Режим выключен, та же просьба | Голос: «подтвердите на экране»; карточка ждёт клика | |
| RW-01 | Режим включён, Live открыт. Попросить передать письмо рабочей сессии; дождаться её ответа | В паузе голос сам пересказывает ответ, без вопроса человека | |
| RW-02 | Сессия просит разрешение | Голос говорит, что сессия спрашивает; ответить голосом; сессия продолжает, заканчивает; голос пересказывает итог | |
| RW-03 | Запустить письмо сессии, закрыть Live до итога | Остров открывается, итог показан сразу и озвучен обычной озвучкой; при новом старте Live не повторяется | |
| RW-13 | Открыть Live на телефоне, на острове закрыт; получить итог сессии | Карточка и обычная озвучка на острове | |
| RW-14 | Закрыть Live, пока идёт пересказ; затем открыть, пока итог ждёт озвучки | Первый или второй путь по состоянию; итог прозвучал один раз | |
| RW-18 | Итог с `delegation_id: null` без открытой делегации (письмо, ответ сессии позже) | Итог звучит | |
| RW-23 | Открывать и закрывать Live на моменте отправки итога (по 5 раз) | Итог доставлен ровно один раз каждый | |

Замеры, по 10 повторов (заполняет человек):

| Замер | Повтор 1–10 | Медиана |
|---|---|---|
| Время от конца реплики до озвученного итога действия (с) | | |
| Длительность пересказа ответа сессии, `job_duration_ms` из `voice.telemetry.list` (мс) | | |

## 8. Карточка

```
Goal: independent acceptance of the autonomous assistant branch against spec §6.5, §9, §10
Behaviour: cases +0 (verifier adds none) · changed expectations 0 · regressions 0 found (2 unit failures reproduce on base)
Numbers: AU 18/0/3 (passed/failed/not covered or partial) · RW 19/0/4 · unit 23 820 passed, 2 failed (pre-existing, environment) · e2e 236 passed, 64 failed (not classified) · tool list 15 101 → 15 708 chars (+607)
Screens: not measured: island window did not open in e2e on this machine
For the human: now you can run the live sheet in §7 (AU-03, AU-17, RW-01/02/03/13/14/18/23) and the two 10-repeat timings
Cost: files 1 (+ this report), no dependencies; full unit run ~1 min, e2e 6.7 min
Verdict: partial — base 3672f0a1, head 51c2b77c (automatic part done; live part and AU-18 e2e not verified)
```
