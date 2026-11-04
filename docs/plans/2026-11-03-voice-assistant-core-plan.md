# План: голос, уведомления и Assistant Core (V1)

**Дата:** 2026-11-03.
**Основание:**
- решение комнаты r-21, ред. 4: текст в m-3140, принято человеком сообщением m-3142;
- уточнения m-3147 / m-3148: `cards.decide`, `jobs.ackInline`, привязка голосовой сессии к устройству на мосту.

**Спеки:**
- Spec 1 — `docs/specs/2026-11-03-voice-remote-notifications-spec.md`;
- Spec 2 — `docs/specs/2026-11-03-personal-assistant-memory-sleep-spec.md`.

**Дизайн:** handoff «Джарвис» (high-fidelity, палитра A: README.md, ORB_MOTION_SPEC.md, design/orb-spec.js). Оригинал — архив человека `/Users/kalmbik61/Desktop/# AI-компаньон_ мобильный дизайн.zip`. Распакованный handoff кладётся в `docs/design/2026-11-03-jarvis-handoff/` тем же коммитом, что и этот план, целиком, включая `design/support.js` (CDN-рантайм макетов; это референс, в приложение не переносится). Имя в UI — «Parley».

**Факты кода** сверены по origin/master 8875924b (содержит 59a401aa). Номера строк перед реализацией исполнитель перепроверяет по текущему origin/master: локальный master отстаёт.

**Авторы разделов:**
- §2 Assistant Core — s-236;
- §3 уведомления — s-235;
- §4 голос и Settings — s-237;
- сборка — s-237.

## 1. Принятые решения (кратко, по m-3140)

- **Assistant Core** (`host/src/assistant`) — отдельный модуль. Ему принадлежат:
  - jobs;
  - durable-карточки подтверждения;
  - разговоры;
  - `/assistant/*`;
  - место под память (без таблиц до P2).

  Каналы — остров, Telegram и телефон — только транспорт.
- **Job голоса** — отдельный прогон CLI, остров он не прерывает. Не больше 2 jobs на провайдера, лишние ждут в `queued`. Исчерпанный лимит возвращает job в `queued`.
- **Голос карточку не подтверждает.** Решение принимается кнопкой (`cards.decide`), для опасных действий на телефоне — ещё и Face ID. `decidedVia ∈ island | telegram | mobile`.
- **GPT-Live:**
  - телефон отдаёт SDP по Noise, Mac делает `POST /v1/live/sessions` своим ключом;
  - sideband — только для закрытия и usage;
  - ключ не покидает Mac;
  - лимиты: только дневной, сессия до 30 минут, 1 сессия на хост;
  - переключатель «Платный голос с телефона» (`remoteVoice`) по умолчанию выключен и гейтит только `voice.session.prepare`.
- **Удалённые методы:**
  - `jobs.submit / get / cancel / ackInline`;
  - `cards.decide`;
  - `voice.session.prepare / close`;
  - `voice.usage.get`.

  Проверка и на мосту, и на хосте.
- **Уведомления** (`host/notifications`):
  - каноническая строка в parley.db + durable outbox;
  - `dedupe_key = job:{id}:{terminalState} | needs_confirmation:{cardId}`;
  - `deliveredInline` ставится по `jobs.ackInline`;
  - `expired` снимает эскалацию без push;
  - при первом старте рассылки о прошлом нет;
  - critical-события эскалируются в Telegram через 10 минут, `BOTH` — явная опция.
- **Миграции:** реестр шагов M0, номер шага = порядок мержа.
- **Секреты:** `secrets.json` 0600 через фасад `core/secrets.ts` на всех ОС, ключ `voice:openai`. Хранение средствами ОС — позже; это отступление от Spec 1 §2.
- **Settings:**
  - Qwen-TTS удаляется;
  - озвучка острова переходит на OpenAI `/v1/audio/speech`;
  - пол ассистента не меняется: берётся из последнего сохранённого значения, без UI.

## Граф волн

```text
Волна 1  M0 ──┬─► C2 ──┐
              │  C4 ───┼─► T2b ─► T2
              ├─► T1 ──┴─► T2b, T2, T3
              └─► (шаг voice_usage) ─► B2 ◄── VS1
         B1
         VS1 ─► S-TTS        ═ один релиз: VS1 + S-TTS + S-del ═

Волна 2  C1 (M0, C2)
         B3 (C4, B2) ─► T4 (T1, T2, C4, B3)
         B4 (B2, VS1)
         VM0 (B1)

Волна 3  VM1/B5 (B3, B4, VM0, C2) ─► VM2 (C1, VM1)
         T5 (T2, VS1)

Волна 4  V1-E (всё выше)
```

**Senior-only** (PARLEY.md):
- M0 — граница записи и восстановление;
- B2 — ключ и биллинг;
- VM0 — без прототипа не специфицируется.

**Senior review:**
- remote: B3, T4, VM2;
- биллинг: B2, S-TTS;
- секрет: VS1;
- security review в V1-E.

Остальное — junior-исполнители. На каждую задачу — независимый верификатор отдельной сессией.

**Правки по ревью лида (m-3153)** внесли авторы разделов:
- шапка — p-38 принят сообщением m-3142;
- §3: новый T2b — запись событий ядра (jobs и карточки) в store; в T4 — remote-Inbox `notifications.get` / `notifications.acknowledge`; в T5 — `notifications.preferences.get/set` (s-235);
- §2: файлы трёх входов decide (окно, Telegram, телефон), критерий единой карточки и событие `onCardChanged` / `card.changed` (s-236);
- handoff кладётся коммитом плана;
- VS1 явно выходит одним релизом с S-TTS и S-del.

## 2. Assistant Core

Общие ссылки кода: `packages/host/src/assistant/assistant-service.ts` (сегодня один разговор в памяти: `state/conversation/pending/running` L286–291; idle 15 мин L58; ход 180 с L59; `pending` L289; `decide` L1141), `packages/host/src/assistant/assistant-endpoint.ts` (14 инструментов, один токен), `packages/protocol/src/assistant.ts`, `packages/core/src/work/db.ts` (parley.db, node:sqlite, WORK_DB_SCHEMA_VERSION=3, `prepare()` — ручная if-цепочка ~L175–207).

### M0 — Реестр миграций parley.db

- **Волна:** 1, первая задача ядра.
- **Зависит от:** —.
- **Исполнитель:** senior-only. Причина по PARLEY.md: общий write boundary всех модулей (user_version) и восстановление после сбоя посреди миграции — concurrency/recovery.
- **Scope.** Входит: замена ручной if-цепочки `prepare()` в `packages/core/src/work/db.ts` на упорядоченный массив шагов `[{version, up(db)}]`; каждый шаг — в своей транзакции; `user_version` назначается порядком мержа (без резервов); существующие шаги v1–v3 сохраняются как записанная история; тест полного replay на свежей базе; тест идемпотентности апгрейда существующей базы v3. Не входит: никаких новых таблиц — DDL notifications и assistant добавляют свои задачи своими шагами в конец массива.
- **Файлы:** `packages/core/src/work/db.ts`, `packages/core/src/work/db.test.ts`.
- **Критерии приёмки:**
  1. Свежая parley.db проходит все шаги до текущей версии (replay-тест).
  2. База на v3 апгрейдится идемпотентно; повторный запуск — no-op.
  3. Падение внутри шага (тест с симуляцией сбоя) не меняет `user_version` — частичного состояния нет.
  4. Второй handle при записи получает BUSY и ждёт в пределах `BUSY_TIMEOUT_MS` (L37), без порчи данных.
  Инфраструктура для: PA-08 (идемпотентность), VO-11 (дедуп переживает рестарт).
- **Верификатор:** независимая сессия.

### C2 — Durable jobs и карточки Assistant Core

- **Волна:** 1 (после M0).
- **Зависит от:** M0.
- **Исполнитель:** junior.
- **Scope.** Входит:
  - Шаг миграции (через реестр M0), DDL в `packages/core/src/work/db.ts`: `assistant_jobs` (jobId PK, idempotency_key UNIQUE, origin, correlation_json, state ∈ queued|running|needs_confirmation|completed|failed|cancelled, revision, request_text, result_summary, provider, created_at/updated_at, decided_at, decided_via, outcome) и `assistant_cards` (proposal_id PK, kind, view_json, source, state ∈ active|decided|expired|superseded, revision, expires_at, created_at, decided_at, decided_via, outcome).
  - `packages/host/src/assistant/jobs.ts` (новый): JobStore + раннер. `submitJob({origin: island|telegram|mobile|reminder|system, text, idempotencyKey, correlation: {voiceSessionId, delegationId, turnId} | {mode:'text'}}) → {jobId, revision}`; `getJob`; `cancelJob`; `onJobChanged` с монотонной revision + событие хоста. Кап ≤2 параллельных jobs на провайдера, лишние — queued. `classifyAssistantError → 'limit'` возвращает job в queued (retry), не failed. Job — отдельный CLI-прогон: не вызывает `runAsk`, не делает `stopTurn` разговору.
  - Карточки: перенос `pending` (`assistant-service.ts:289`) в durable-стор; переживают рестарт хоста; `expiresAt` → терминальное `expired`; «Запросить заново» — новая карточка (новый proposal_id), не повторный decide; `decide` пишет decidedAt, decidedVia ∈ island|telegram|mobile, outcome; побочный эффект выполняется один раз (захват карточки до первого await — как сегодня L1141–1142, но персистентно).
  - На старте хоста: job в `running` без процесса → re-check реального состояния, отсутствие подтверждения не считать успехом; нетерминальные карточки перепубликуются.
  Не входит: история разговоров (C1), remote-поверхность (B3), запись в уведомления (T-серия читает события), таблицы памяти, изменения 180-с таймаута интерактивного хода.
- **Файлы:** `packages/core/src/work/db.ts` (шаг реестра), `packages/host/src/assistant/jobs.ts` (новый), `packages/host/src/assistant/assistant-service.ts`, `packages/host/src/assistant/run-plan.ts`, `packages/host/src/methods/assistant.ts` (вход decide от окна, decidedVia='island'), `packages/protocol/src/assistant.ts` (расширение AssistantState/событий при необходимости), тесты `*.test.ts` рядом.
- **Критерии приёмки:**
  1. PA-14: двойной submit с одним idempotencyKey → один job; действие выполняется один раз после reconnect и рестарта хоста (crash-тест: хост убит посреди job, статус после старта честный).
  2. VO-05: финал job виден ровно один раз после закрытия voice-сессии и после рестарта хоста.
  3. PA-15: job не сообщает об исполнении без подтверждения host/tool; неизвестный исход → неопределённость.
  4. Кап: третий job на провайдере стоит в queued и стартует после освобождения слота (тест).
  5. Limit: классифицированный 'limit' → queued с повтором (fixture-тест, без реального CLI).
  6. Карточка: истёкшая expiresAt → expired терминально; decide по expired → отказ «already expired» без повторного действия; «Запросить заново» → новый proposal_id; карточка голоса не затирает карточку острова (тест двух источников).
  7. Рестарт с активной карточкой: она перепубликуется, подтверждение работает.
- **Not verified:** фактическое поведение лимитов каждого провайдера (claude/glm/codex) — проверяется классификацией `classifyAssistantError` на fixtures; реальное исчерпание подписки не эмулировалось.
- **Верификатор:** независимая сессия.

### C4 — Интерфейс Assistant Core для каналов + место под память

- **Волна:** 1 (параллельно C2; типы первыми).
- **Зависит от:** — (контракт); координация с C2 (реализация) и B3 (remote-поверхность).
- **Исполнитель:** junior.
- **Scope.** Входит: zod-схемы в `packages/protocol/src/assistant.ts` для origin-enum и correlation-union (переиспользуются B3 без дублей); мутация `cards.decide({cardId, revision, choice: send|cancel})` — карточки принадлежат ядру и бывают без job (propose_message с острова); одна реализация decide на три входа: окно (`assistant.decide`, decidedVia='island'), Telegram-кнопка ('telegram'), телефон (`cards.decide`, 'mobile'); хост сверяет revision и expiresAt, устаревшая/истёкшая — чистый отказ без повторного действия; Face ID на телефоне — до вызова, хосту не виден; идемпотентный `jobs.ackInline({jobId, revision})` — единственный эффект флаг deliveredInline (читает T2); события жизненного цикла карточек `onCardChanged`/`card.changed` (needs_confirmation, expired, decided) тем же envelope, что onJobChanged, — на них подписывается T2/T2b (владелец записи — раздел уведомлений, ядро только эмитит); детерминированный метод чтения `overview()` — поднятие существующего `overviewText` (`packages/host/src/assistant/overview.ts`) без CLI; место под память: каталог `packages/host/src/assistant/memory/` и интерфейс `AssistantMemoryStore` (ownerId, scope {personal|workspace|project:id}, kind, statement, provenance[], status, revision, visibility) — только тип и место, без таблиц и реализации. Не входит: allowlist моста/хоста (B3), voice-сессии (B-серия), таблицы/retreival памяти (P2), секреты.
- **Файлы:** `packages/protocol/src/assistant.ts`, `packages/host/src/assistant/overview.ts`, `packages/host/src/assistant/memory/store.ts` (новый, только интерфейс), `packages/host/src/methods/assistant.ts` (все три входа decide замыкаются на одну реализацию ядра), `packages/host/src/telegram/callbacks.ts` и `packages/host/src/telegram/cards.ts` (решение кнопкой Telegram пишется через ядро; сегодня карточки Telegram живут в state.json — это остаётся презентацией, истина в durable-карточке ядра), тесты схем.
- **Критерии приёмки:**
  1. VO-03: ответ «сколько агентов/что зависло» выдаётся методом overview() без запуска CLI-процесса (тест).
  2. Zod-схемы принимают валидные origin/correlation и отвергают невалидные (voice-сессия без voiceSessionId, mode:'text' с delegationId и т.п.).
  3. cards.decide: stale revision → отказ (VO-15/VO-10 семантика already_handled), expired → отказ без действия; decidedVia='mobile' записан (общий тест с C2); карточка без job (propose_message) решается тем же методом.
  3а. Один decide на три входа: кнопка Telegram пишет decidedVia='telegram', окно `assistant.decide` — 'island', телефон `cards.decide` — 'mobile' — в одну и ту же durable-карточку ядра (интеграционный тест; state.json Telegram остаётся только презентацией).
  4. jobs.ackInline: повторный вызов — no-op, флаг установлен один раз (идемпотентность, тест).
  5. Место памяти: каталог и интерфейс существуют, компилируются; схема БД не изменилась (версия та же — таблиц памяти нет); PA-05 как инвариант интерфейса (личное — не в git/.parley/memory.md) отражено в doc-комментарии.
- **Верификатор:** независимая сессия.

### C1 — Durable conversations

- **Волна:** 2.
- **Зависит от:** M0, C2 (карточки уже перенесены). Питает вторую половину V1-D (лента R01/R02/R04).
- **Исполнитель:** junior.
- **Scope.** Входит: шаг миграции — `assistant_conversations`, `assistant_messages` (канал — атрибут сообщения); write-through ходов ask/answer острова и Telegram; история переживает рестарт; сериализация ходов внутри одной conversation (поведение острова «новый ask отменяет текущий ход» сохраняется — это внутри одного разговора); CLI sessionId остаётся в памяти, как сегодня (решение о его персистентности человеком не принято). Не входит: мобильная лента UI (V1-D), память, мультиарендность.
- **Файлы:** `packages/core/src/work/db.ts` (шаг), `packages/host/src/assistant/conversation-store.ts` (новый), `packages/host/src/assistant/assistant-service.ts`, `packages/host/src/telegram/assistant-bridge.ts` (паритет истории), тесты.
- **Критерии приёмки:**
  1. PA-01 (остров + Telegram): сообщение в одном канале и продолжение в другом видят одну общую историю; повторной команды не требуется.
  2. Рестарт хоста: история разговоров цела (тест), карточки из C2 — тоже.
  3. PA-02 (часть истории): 15-минутный idle может завершить CLI-диалог, но история и карточки остаются.
- **Not verified:** идемпотентность записи истории при двойных событиях стрима — покрыть тестом при реализации.
- **Верификатор:** независимая сессия.

## 3. Уведомления

Модель (m-3140): `host/notifications`; каноническая строка в parley.db + durable outbox; `Router(event, mode, presence, deliveredInline)`; `dedupe_key = job:{id}:{terminalState} | needs_confirmation:{cardId}`; `expired` снимает эскалацию без push; первая рассылка без прошлого; `notify.ts` только пишет события; `telegram/outbox.ts` остаётся очередью отправки.

### T1 — Схема уведомлений, canonical store, durable outbox (пассивный сток)
- **Волна:** 1
- **Зависит от:** M0 (реестр миграций). Шаг — в реестре M0, номер по порядку мержа; координация с C2, добавляющим свои шаги в ту же волну.
- **Исполнитель:** junior. Write boundary (durable write + recovery) закрыт механизмом M0 (senior: atomic migration, BEGIN IMMEDIATE, user_version); сам шаг T1 — SQLite DDL + ON CONFLICT.
- **Scope (входит):**
  - Таблицы в `core/work/db.ts` через шаг M0: `notifications` (envelope-only: `id`, `dedupeKey`, `eventId`, `hostId`, `workspaceId`, `entityRef`, `type`, `severity`, `createdAt`, `revision`, `requiresAction`, `payloadRef`, `notificationId`) и `notification_outbox` (durable: `pending/sent/failed`, `attempts`, `nextAttemptAt` + jitter).
  - Envelope-only: в строках нет пользовательских текстов (названия проектов, тексты агентов, команд, секретов) — только `kind`, `count`, `route`, opaque ID (§6.4).
  - `packages/host/src/notifications/store.ts` (новый): `write`, `get`, `ack`, `seen`, `markExpired`; dedupe через `UNIQUE(dedupeKey)` + `ON CONFLICT DO NOTHING`.
  - `dedupeKey`/`eventId` переживают рестарт (VO-11).
  - No backfill: при первом старте рассылки о прошлых событиях нет.
- **Scope (не входит):** реестр миграций (M0, senior); запись событий (T2b/T3); роутер (T2); APNs (T4).
- **Файлы:** `packages/core/src/work/db.ts` (шаг миграции), `packages/host/src/notifications/store.ts` (новый).
- **Критерии приёмки:**
  - VO-11: повтор host events / reconnect / restart не создаёт новых записей с тем же `dedupeKey`.
  - Envelope-only: тест, что в строках/JSON нет пользовательских текстов (§6.4).
  - Durable retries с ограничением попыток и jitter (§6.4).
- **Верификатор:** независимая junior-сессия.

### T2b — Запись событий ядра (jobs + карточки) в store
- **Волна:** 1
- **Зависит от:** T1; C2 (`onJobChanged`, карточки, `expiresAt`/`expired`); C4 (`cards.decide`).
- **Исполнитель:** junior.
- **Scope (входит):**
  - Подписчик `packages/host/src/notifications/ingest.ts` (новый): слушает `onJobChanged` (C2) и `onCardChanged`/`card.changed` (needs_confirmation/expired/decided), пишет canonical-строки в T1-store. Собственного состояния не держит — дельту выводит из store.
  - Job terminal (`completed|failed|cancelled`) → строка `dedupeKey = job:{id}:{terminalState}`, type=job-finished. Нетерминальные (`queued|running`) строк не дают.
  - Карточка `needs_confirmation` → строка `dedupeKey = needs_confirmation:{cardId}`, severity=critical, requiresAction=true.
  - Карточка `decided` (`decidedVia: island|telegram|mobile`) → ack строки; `expired` → терминальное состояние `expired` (эскалация снимается, без push).
- **Scope (не входит):** роутер/доставка (T2); триггеры activity (T3); push (T4); сами методы C2/C4.
- **Файлы:** `packages/host/src/notifications/ingest.ts` (новый); контракт `onJobChanged` и `onCardChanged`/`card.changed` из `packages/host/src/assistant/*` (C2).
- **Критерии приёмки:** VO-11 (dedupe на повторные события); нет строк на нетерминальный job; `needs_confirmation` даёт ровно одну критическую строку; `expired` → строка терминальна.
- **Верификатор:** независимая junior-сессия.

### T2 — Router: режимы, dedupe, deliveredInline, expired как отзыв
- **Волна:** 1
- **Зависит от:** T1, T2b; C2 (`expired`/`expiresAt`); C4 (`jobs.ackInline` ставит флаг deliveredInline, `cards.decide` — источник ack).
- **Исполнитель:** junior.
- **Scope (входит):**
  - `packages/host/src/notifications/router.ts` (новый): `Router(event, mode, presence, deliveredInline)`.
  - Режимы `APP_ONLY | TELEGRAM_ONLY | SMART | BOTH` (§6.2). `SMART` — default после pairing и отдельного согласия: App основной, Telegram резерв только для критических неподтверждённых; обычные не дублируются (VO-08). `BOTH` — явный diagnostic/legacy, с предупреждением о дублях, не default.
  - deliveredInline: если `jobs.ackInline` поставил флаг по job (или достоверный presence heartbeat для устройства), push по тому же событию не шлём — Inbox-запись остаётся (§6.4). `deliveredInline` — производный вход роутера, читается из флага C4, отдельной таблицы нет.
  - `expired` как отзыв: переход карточки в `expired` (C2) снимает ожидающую критическую эскалацию; push «окно закрылось» в V1 не шлём.
  - Critical-эскалация: `severity=critical` + `requiresAction=true`, через настраиваемый интервал (пилот 10 мин), только если нет подтверждённого действия и Telegram разрешён; второе оповещение — тот же `notificationId`, без повторения операции (VO-09).
  - ack из любого канала (`decidedVia: island|telegram|mobile`) обновляет каноническое событие и badge; повторное действие возвращает `already_handled` (VO-10).
- **Scope (не входит):** запись событий (T1/T2b/T3); отправка в Telegram (`telegram/outbox.ts` — очередь); APNs (T4); сами методы C4.
- **Файлы:** `packages/host/src/notifications/router.ts` (новый); `packages/host/src/telegram/outbox.ts` (остаётся очередью отправки).
- **Критерии приёмки:** VO-08; VO-09; VO-10; deliveredInline (активный экран + флаг ackInline → нет push); expired → эскалация снята без push.
- **Верификатор:** независимая junior-сессия.

### T3 — Адаптер существующих Telegram-триггеров
- **Волна:** 1
- **Зависит от:** T1; end-to-end проверка — после T2.
- **Исполнитель:** junior.
- **Scope (входит):**
  - Обернуть `NotifyMemory`, `worksTriggers`, `activityTransition`, `mailTriggers` так, чтобы они записывали события в canonical store, не держа собственное состояние (§6.1 «не дублировать алгоритмы»).
  - `notify.ts` — только писатель событий; `telegram/outbox.ts` — очередь отправки (m-3140).
  - Дельта-состояние выводится из store; `first`-флаг baseline `worksTriggers` и `rebase()` сохраняются.
- **Scope (не входит):** роутер (T2); события ядра jobs/карточки (T2b); push (T4).
- **Файлы:** `packages/host/src/telegram/notify.ts`, `packages/host/src/telegram/service.ts` (`onWorks`, `onActivity`, `onMail`, `enqueue`, `notice`, `rebase`), `packages/host/src/telegram/state.ts`.
- **Критерии приёмки:** единственный источник истины — store (§6.1); VO-11 для Telegram-канала; регрессионный тест `telegram/outbox.ts` (429-aware, keyed replacement).
- **Верификатор:** независимая junior-сессия.

### T4 — Mobile push + удалённый Inbox: content-free APNs, badge, ack, capability
- **Волна:** 2
- **Зависит от:** T1, T2; C4 (`cards.decide` как путь ack); B3 (remote-обёртка, проверка мост+хост).
- **Исполнитель:** junior; review remote — senior (решение m-3140).
- **Scope (входит):**
  - `packages/remote/src/push.ts` (`createPushNotifier`) читает canonical store/outbox; presence-aware батчинг (3s) сохраняется.
  - APNs payload без содержимого: `kind`, `count`, `route`, opaque ID — без текстов (§6.4); схема уже в `packages/protocol/src/remote/push.ts` (`pushDataSchema={v,kind,count,route}`).
  - ack из приложения (через `cards.decide`, mobile) обновляет каноническое событие и badge; старые кнопки → `already_handled` (VO-10).
  - **Удалённый Inbox** (§5): хост-методы `notifications.get` (snapshot Inbox, envelope-only) и `notifications.acknowledge` (seen + ack для уведомлений без карточки; seen ≠ ack).
  - События `notification.created` / `notification.acknowledged` в A_EVENTS (fanout подписанным устройствам; reconnect → snapshot + monotonic sequence/revision).
  - Параметры: zod-схемы, role `remote` allowlist на bridge и host; клиент не зовёт внутренние `/assistant/*` напрямую.
  - Capability protocol с закрытой удалённой поверхностью: события не покидают host без paired/authorized device (§9 V1-A).
- **Scope (не входит):** роутер/режимы (T2); содержимое Telegram; voice-методы (B-серия).
- **Файлы:** `packages/host/src/methods/notifications.ts` (новый); `packages/protocol/src/remote/allowlist.ts` (allowlist `notifications.*`); `packages/protocol/src/remote/push.ts` (или новый `notifications.ts` для envelope/событий); `packages/remote/src/dispatch.ts`, `packages/remote/src/fanout.ts`, `packages/remote/src/push.ts`, `packages/remote/src/push-gateway-client.ts`, `packages/remote/src/devices.ts`, `packages/remote/src/host-link.ts`, `packages/remote/src/send-dedupe.ts`.
- **Критерии приёмки:** VO-12 (payload без текстов, и в `notifications.get`; Telegram off → бот не шлёт); VO-13 (отозванный iPhone не получает события); `notifications.acknowledge` обновляет canonical event (seen≠ack); ack из App → событие + badge; методы проходят allowlist на bridge и host.
- **Верификатор:** независимая junior-сессия + senior review remote (§9).

### T5 — Настройки уведомлений (V1-D)
- **Волна:** 3
- **Зависит от:** T2; VS1 (Settings-инфраструктура).
- **Исполнитель:** junior.
- **Scope (входит):**
  - Выбор режима `APP_ONLY | TELEGRAM_ONLY | SMART | BOTH` (§6.2), default SMART после pairing.
  - Настраиваемый интервал эскалации (пилот 10 мин, подтвердить UX-тестом — §11).
  - Переключатель содержимого в Telegram с предупреждением об отсутствии E2EE (§6.4).
  - `notifications.preferences.get/set` (§5) как хост-методы.
- **Scope (не входит):** delivery-логика (T2); Settings-инфраструктура (VS1, s-237).
- **Файлы:** host-предпочтения (parley.db или settings) + `packages/host/src/methods/notifications.ts` (preferences) + мобильный Settings (V1-D) + island Settings.
- **Критерии приёмки:** смена режима без рестарта host; `BOTH` — с предупреждением, не default; `SMART` default после pairing.
- **Верификатор:** независимая junior-сессия.

### Not verified (уведомления)
- Точные номера строк `notify.ts`/`service.ts`/`outbox.ts` сверялись по origin/master@59a401aa ранее в обсуждении; перед реализацией исполнитель перепроверяет по текущему origin/master (локальный master отстаёт).
- `pushDataSchema` уже content-free — подтверждено ранее, в этой задаче не перепроверял.
- Точное место A_EVENTS/fanout (`fanout.ts` vs `feed-subs.ts`) и форма `notifications.preferences.*` требуют сверки с текущим remote-кодом при реализации.
- Состав мобильного Settings-экрана (T5) требует сверки с V1-D/VS1 у s-237.

## 4. Голос и Settings

Пути — по origin/master 8875924b (содержит 59a401aa). Новые файлы помечены «(новый)». Ссылки VO-xx ведут на Spec 1 §10.

### VS1 · Секция «Voice provider (API)» и ключ OpenAI

- **Волна:** 1, один релиз с S-TTS и S-del.
- **Зависит от:** нет.
- **Исполнитель:** junior. Ревью senior: секрет и remote-запрет.
- **Scope — входит:**
  - `SecretId` += `'voice:openai'`;
  - методы окна `voiceProvider.get | setKey | clearKey | check`. `check` делает реальный запрос к OpenAI с ключом и сообщает, доступна ли модель `gpt-live-1`;
  - настройки в `core/config.ts`: `remoteVoice: false` (переключатель «Платный голос с телефона») и `voiceDailyMinutes` (дневной лимит), по образцу `remoteCreate`;
  - UI: секция «Voice provider (API)» в Settings → Assistant на месте блока Qwen — плитка OpenAI, поле ключа, Check, дневной лимит. Переключатель `remoteVoice` — в Settings → Remote рядом с `remoteCreate`.
- **Scope — не входит:** Keychain, другие вендоры, проверка остатка кредитов (API её не отдаёт напрямую — Spec 1 §2).
- **Файлы:**
  - `packages/core/src/secrets.ts:8`;
  - `packages/core/src/config.ts:119,150,179,342,438,519` (по образцу `remoteCreate`);
  - `packages/protocol/src/methods.ts:97` (METHODS и результаты);
  - `packages/host/src/methods/voice-provider.ts` (новый), регистрация в `packages/host/src/methods/index.ts:271`;
  - `packages/protocol/src/remote/allowlist.ts:100` (`REMOTE_FORBIDDEN` += `'voiceProvider.*'`);
  - `packages/desktop/src/renderer/components/settings/VoiceProviderSection.tsx` (новый), `AssistantSettings.tsx`, `RemoteSettings.tsx:283-290`;
  - переиспользовать `renderer/components/providers/check-line.tsx` (`CheckLine`, `maskedHint`) и приём поля ключа из `CustomProviderPanel.tsx`;
  - `packages/desktop/src/shared/strings.ts`.
- **Критерии приёмки:**
  1. Ключ не встречается ни в результатах методов, ни в событиях, ни в логах хоста и окна. Тест: вызов с маркерным ключом и поиск маркера во всех выходах. Наружу идёт только `secretHint` (Spec 1 §7).
  2. `voiceProvider.*` с роли `remote` отвергается и мостом (`remote/src/dispatch.ts:485`), и хостом (`host/src/server.ts:109`). Тесты в `dispatch.test` и `server.test`.
  3. `providers.list` и меню запуска агентов не меняются: голосовой провайдер не попадает в реестр CLI-провайдеров.
  4. «Grant active» или «Ready» показывается только после успешного `check`. При ошибке — код причины без текста ключа (VO-07).
  5. `remoteVoice` по умолчанию `false`, env-оверрайд и lock — как у `remoteCreate`.
- **Верификатор:** независимая сессия; читает тесты 1–2 и проверяет UI вручную.

### S-del · Удаление локального TTS Qwen3

- **Волна:** 1, один релиз с VS1 и S-TTS.
- **Зависит от:** нет. Мержится вместе с S-TTS.
- **Исполнитель:** junior.
- **Scope — удалить:**
  - `packages/desktop/scripts/fetch-speech.mjs`, `src/fetch-speech.test.ts`, скрипт `fetch-speech` в `packages/desktop/package.json:23`;
  - шаг «Build the speech engine» в `.github/workflows/release.yml:297-299`;
  - `packages/desktop/electron-builder.yml:53-55` (лицензия Qwen) и `:68-72` (`build/speech`);
  - `src/main/assistant/licenses/Qwen3-TTS-LICENSE.txt`;
  - разделы speech.cpp, Qwen3-TTS и «ggml (сборка speech.cpp)» в `NOTICE` (около стр. 393-440);
  - `src/main/assistant/speech-worker.ts`, его тесты, live-тест и `fixtures/speech-worker-*.jsonl`;
  - движок Qwen в `src/main/assistant/tts.ts` (`createTtsService`), загрузку и удаление весов, `ttsModelsDir` в `src/main/voice/models.ts:25`;
  - каталог голосов и моделей `src/shared/tts-types.ts` (`TTS_MODELS`, `TTS_VOICES`);
  - блок голосов и весов `AssistantSettings.tsx:43-125,228-279`;
  - IPC скачивания и удаления голосов в `src/main/ipc.ts`, `src/preload/index.ts`, `shared/bridge.ts`;
  - строки голосов и весов `strings.ts:3029-3043` (строки `speak` и `voice` остаются для S-TTS);
  - упоминания в `release-config.test.ts`, `scripts/site/fixtures/releases.json`, e2e `island-sound.spec.ts`, `assistant.spec.ts`.
- **Scope — НЕ удалять:**
  - `createModelStore` и Whisper в `src/main/voice/models.ts`;
  - вкладку Voice (`renderer/voice/VoiceSettings.tsx`);
  - `renderer/assets/providers/qwen.svg` (знак CLI-провайдера);
  - флаг `assistant.speak`, `renderer/island/assistant/speaker.ts`, IPC `tts-chunk`, значок динамика;
  - `createFakeTtsService` и `PARLEY_TTS=fake` — нужны S-TTS и E2E.
- **Пол ассистента — без видимых изменений:**
  - разовая миграция при загрузке ui.json: из старого `assistant.voice` (Qwen) вычисляется пол и пишется в новое поле `assistant.gender`;
  - `src/main/assistant-mirror.ts:23` шлёт `voiceGender` из `assistant.gender`;
  - нет поля — хост по умолчанию `'female'`, как сейчас (`host/src/assistant/assistant-service.ts:365`);
  - UI нет.
- **Очистка весов:** при первом запуске новой версии удалить `~/.parley/desktop/voice/tts`, включая недокачанные файлы. Запись в CHANGELOG: «освобождает до 3,5 ГБ».
- **Критерии приёмки:**
  1. `git grep -i "qwen3-tts\|speech-worker\|fetch-speech\|build/speech"` по `packages/` и `.github/` пуст. Исключения: CHANGELOG и строка миграции пола.
  2. Тест очистки на временном home: удаляется только `desktop/voice/tts`, каталог моделей Whisper цел, повторный запуск ничего не делает.
  3. Схема `assistant.configure` (`protocol/src/assistant.ts:223`) не меняется. Integration-тест пары версий: старое окно (шлёт `voiceGender` из голоса) → новый хост, и новое окно → хост без поля. Оба работают.
  4. Пользователь со старым `assistant.voice = qwen3-0.6b/aiden` после обновления получает `voiceGender: 'male'`.
  5. Релизная сборка проходит без `build/speech` (`release-config.test.ts`).
- **Верификатор:** независимая сессия; прогон тестов и grep-критерия.

### S-TTS · Озвучка острова через OpenAI

- **Волна:** 1, один релиз с VS1 и S-del.
- **Зависит от:** VS1 (ключ).
- **Исполнитель:** junior. Senior review биллинга.
- **Scope — входит:**
  - `src/main/assistant/openai-tts.ts` (новый) реализует `TtsService` (`src/main/assistant/tts.ts:71`): `speak / cancel / cancelAll / state / onState / stop`;
  - `download / models / remove / cancelDownload` из интерфейса уходят. `TtsState`: `unavailable | no-key | ready | speaking`;
  - `POST /v1/audio/speech` с потоковым PCM, конвертация s16le → f32 в существующий `TtsChunk`. Отмена — `AbortController`;
  - ключ читает main через `readSecret('voice:openai')` из `@parley/core`, только через фасад;
  - список голосов OpenAI заменяет радио Qwen. Выбор хранится в новом `assistant.apiVoice`, а не в `assistant.voice` (тот теперь только источник пола).
- **Scope — не входит:** голос на телефоне, учёт расходов TTS в дневном лимите голоса.
- **Файлы:**
  - `src/main/assistant/openai-tts.ts` (новый), `tts.ts` (интерфейс);
  - `src/main/index.ts:586-611` (проводка);
  - `src/shared/ui-types.ts:76-79,162,343-344` (`apiVoice`);
  - `AssistantSettings.tsx` (список голосов);
  - `src/shared/island.ts` (`ttsAvailable` → по наличию ключа).
- **Критерии приёмки:**
  1. Нет ключа → `no-key`, остров отвечает текстом, значок динамика объясняет причину.
  2. `speak` отдаёт куски в `speaker.ts` без изменений плеера. `cancel` прерывает запрос — тест на fake fetch.
  3. Ключ не попадает в логи main и в IPC (маркерный тест).
  4. E2E на `PARLEY_TTS=fake` зелёные.
  5. Senior review: модель, цена и формат ответа сверены со страницей OpenAI на дату реализации и записаны в PR.
- **Верификатор:** независимая сессия.

### B1 · Нативный WebRTC и библиотеки сферы — одна пересборка

- **Волна:** 1.
- **Зависит от:** нет.
- **Исполнитель:** junior. После двух неудачных попыток — senior (PARLEY.md).
- **Scope — входит:**
  - `react-native-webrtc` с config-plugin;
  - `react-native-svg`, `react-native-reanimated` 4 + `react-native-worklets`, шрифт Golos Text через `expo-font` (OFL — в NOTICE);
  - `NSMicrophoneUsageDescription`;
  - audio session playAndRecord с эхоподавлением;
  - dev-маршрут loopback.
- **Версии:** точные, совместимые с RN 0.88.1 / Expo 58.
- **Scope — не входит:** экраны, GPT-Live.
- **Файлы:**
  - `packages/mobile/package.json`;
  - `packages/mobile/app.config.ts:48-70`. `microphonePermission` у `expo-camera` остаётся `false`, текст микрофона — отдельным infoPlist;
  - `packages/mobile/src/app/bench.tsx` (dev-маршрут loopback);
  - `NOTICE`.
- **План Б (не делать заранее):** если модуль WebRTC не собирается — WebSocket-транспорт GPT-Live с хоста, аудио по Noise. Это решение лида.
- **Критерии приёмки:**
  1. Dev-client собирается.
  2. На реальном iPhone loopback двух `RTCPeerConnection` передаёт звук с микрофона в динамик без эха.
  3. Svg и reanimated рендерят тестовую анимацию на native driver.
  4. Регресс VO-01: pairing, Inbox, Works, Settings работают.
  5. typecheck и тесты mobile зелёные.
- **Верификатор:** независимая сессия; приёмку на iPhone делает человек.

### B2 · Хостовый клиент GPT-Live и VoiceSessionService

- **Волна:** 1.
- **Зависит от:** VS1, M0 (таблица учёта).
- **Исполнитель:** senior-only. Причина по PARLEY.md: ключ и биллинг, граница безопасности.
- **Scope — входит:**
  - `host/src/voice/live-client.ts` (новый): `POST /v1/live/sessions` `{session, transport:{type:'webrtc', sdp}}` → `{session.id, transport.sdp}`. Sideband `wss://api.openai.com/v1/live/sessions/{id}/attach` только для закрытия и usage;
  - `host/src/voice/voice-session-service.ts` (новый): `prepare(sdpOffer)`, `close(voiceSessionId)`, не больше 1 сессии на хост, сессия до 30 минут (предупреждение за 2), учёт секунд по usage;
  - шаг миграции M0 `voice_usage(day, voice_session_id, seconds_estimate, seconds_final, cost_final)`.
- **Scope — не входит:** remote-методы (B3), дневной лимит как политика (B4).
- **Критерии приёмки:**
  1. Ключ не выходит из `live-client` (маркерный тест по результатам, событиям, логам).
  2. Второй `prepare` при активной сессии → `busy`.
  3. Через 30 минут хост закрывает сессию через sideband.
  4. `close` закрывает sideband и сессию OpenAI.
  5. `session.closed` от OpenAI переводит запись в terminal и пишет usage.
  6. Unit-тесты без сети, на fake fetch и fake WebSocket.
- **Not verified до реализации:** точное имя команды закрытия по sideband и форма usage-событий у GPT-Live. Сверить на странице voice-server-controls.
- **Верификатор:** независимая сессия + senior review.

### B3 · Remote-поверхность голоса, jobs и карточек

- **Волна:** 2.
- **Зависит от:** C4 (интерфейс ядра, `cards.decide`), B2.
- **Исполнитель:** junior. Senior review remote.
- **Scope — входит:**
  - `protocol/src/remote/voice.ts` (новый): zod-схемы `jobs.submit / get / cancel`, `jobs.ackInline`, `cards.decide`, `voice.session.prepare / close`, `voice.usage.get`; события `jobs.changed`, `voice.session.closed`;
  - добавление в `A_METHODS` и `A_EVENTS` (`protocol/src/remote/allowlist.ts:11,47`) и в `REMOTE_PARAM_RULES` (`:293`);
  - handlers на хосте поверх C4 и B2;
  - проекция job для телефона без логов и argv (по образцу `RESULT_PROJECTIONS`, `remote/src/dispatch.ts:78`);
  - гейт `remoteVoice` только для `voice.session.prepare` (по образцу `REMOTE_SWITCHED_METHODS`, `host/src/server.ts:120,198`);
  - на мосту — привязка `voiceSessionId → deviceId` из результата `prepare`. При `devices.revoke` (`remote/src/access.ts:192`) и закрытии сессии устройства мост вызывает `voice.session.close`. Хост deviceId не знает: `remote/src/host-link.ts:72`;
  - `jobs.submit`, `jobs.cancel`, `cards.decide`, `voice.session.prepare` добавить в `MUTATING_METHODS` (`remote/src/limits.ts:17`).
- **Правила параметров:**
  - `sdp` ≤ 32 КиБ;
  - `text` ≤ `REMOTE_TEXT_LIMIT_BYTES`;
  - `idempotencyKey`, `jobId`, `cardId`, `delegationId` — `^[\w.:-]{1,64}$`;
  - `correlation` — строго одна из двух форм;
  - лишний ключ → `bad_request`.
- **Критерии приёмки:**
  1. VO-14: запрещённый метод через `voice.*` или `jobs.*` отвергается и мостом, и хостом.
  2. VO-13: отозванное устройство не получает события, его вызовы отвергаются, открытая сессия закрыта через `voice.session.close` (тест моста).
  3. `remoteVoice=false` → `voice.session.prepare` нет в `hello.methods` (`remote-client/src/capabilities.ts`), прямой вызов отвергается хостом.
  4. Повтор `jobs.submit` с тем же `idempotencyKey` даёт тот же `jobId` (VO-11 / PA-14).
  5. `cards.decide` с устаревшей revision или после `expiresAt` → отказ. `decidedVia='mobile'`.
  6. `isRemoteForbidden` не задевает новые имена — тест на списки.
- **Верификатор:** независимая сессия + senior review remote.

### B4 · Дневной лимит и состояния голосовой сессии

- **Волна:** 2.
- **Зависит от:** B2, VS1.
- **Исполнитель:** junior.
- **Scope — входит:**
  - политика на хосте `host/src/voice/budget.ts` (новый): `voiceDailyMinutes`. Превышение → отказ `prepare` с `limit_reached` и закрытие открытой сессии. Только дневной лимит, месячного нет;
  - чистая state-машина на телефоне `mobile/src/voice/voice-model.ts` (новый): `idle | connecting | listening | speaking | delegating | paused | offline | limit_reached | error` (Spec 1 §4.1);
  - функция `orbStateOf(voice, jobs)` по соответствию m-3140 §4.
- **Критерии приёмки:**
  1. Пороговые тесты лимита: ровно на лимите, за 2 минуты до конца сессии, после смены суток по локальному времени Mac.
  2. VO-07: `limit_reached` и `no-key` переводят телефон на шаблон R15 с текстовым вводом.
  3. Таблица `orbStateOf` покрыта тестом на каждое из 10 соответствий; `needs_confirmation` перекрывает `delegating`.
  4. Без сети и без React.
- **Верификатор:** независимая сессия.

### VM0 · Перенос handoff «Джарвис» на RN 0.88

- **Волна:** 2.
- **Зависит от:** B1.
- **Исполнитель:** senior-only. Причина: задачу нельзя специфицировать без прототипа — нужно сопоставить движение сферы с новым стеком.
- **Scope — входит:**
  - компонент сферы `mobile/src/voice/orb/` (новый): 10 состояний, размеры 168 и 32, reduced motion, перенос `simulate()` (задержки 150 и 400 мс) из `design/orb-spec.js`;
  - палитра A в теме mobile (`packages/mobile/src/components/ui.tsx`);
  - иконки из handoff;
  - dev-витрина в `src/app/bench.tsx`.
- **Источник:** `docs/design/2026-11-03-jarvis-handoff/` (README, ORB_MOTION_SPEC.md, design/orb-spec.js), положен коммитом плана. Имя в UI — «Parley».
- **Scope — не входит:** экраны, логика сессии, новые нативные модули (они пришли в B1).
- **Критерии приёмки:**
  1. Переходы совпадают с `simulate()` — тесты, перенесённые из orb-spec.
  2. Все 10 состояний на витрине.
  3. Reduced motion выключает циклы.
  4. Человек сверяет витрину с листом R21.
- **Верификатор:** независимая сессия + человек.

### VM1 / B5 · Голосовой экран и контроллер (V1-D, первая половина)

- **Волна:** 3.
- **Зависит от:** B3, B4, VM0, C2.
- **Исполнитель:** junior.
- **Scope — входит:**
  - `mobile/src/voice/live-controller.ts` (новый):
    - `voice.session.prepare` → `RTCPeerConnection` → data channel;
    - транскрипт;
    - `session.delegation.created` → реплика собирается из transcript deltas до `offset_ms` → `jobs.submit` с `correlation: {voiceSessionId, delegationId, turnId}`;
    - `jobs.changed` → `session.thinking.append` (промежуточное) и `session.commentary.append` (проверенный итог, ≤ 500 токенов);
    - по `session.commentary.appended` в foreground и без mute → `jobs.ackInline`.
  - Экраны:
    - вкладка Voice первой (`src/app/(tabs)/_layout.tsx:14`);
    - R14·1 «слушает», R14·2 «говорит»;
    - шаблон R15 (нет микрофона, дневной лимит, нет ключа на Mac, голос выключен на Mac);
    - строка «ход работы» по шагам job;
    - R06 поверх карточек ядра через `cards.decide`, для опасных — `auth/confirm-owner.ts`;
    - текстовое поле → `jobs.submit` с `{mode:'text'}`.
  - Уход в фон → сессия закрывается, микрофон выключен.
- **Scope — не входит:** лента разговора R01/R02/R04 (VM2), встреча, память, журнал, история.
- **Критерии приёмки:**
  - VO-01: приложение открывается на Voice, старые вкладки работают;
  - VO-02, VO-03: «Сколько агентов?» — через `overview()` без CLI;
  - VO-04, VO-05: job переживает закрытие голоса, итог виден ровно один раз;
  - VO-06: до нажатия в комнату ничего не пишется; голосовое «да» карточку не решает;
  - VO-07;
  - VO-15: результат устаревшей revision или отменённого job не озвучивается.
  - Unit-тесты контроллера на fake data channel; ручная приёмка на iPhone в V1-E.
- **Верификатор:** независимая сессия.

### VM2 · Лента разговора (V1-D, вторая половина)

- **Волна:** 3, после C1.
- **Зависит от:** C1, VM1.
- **Исполнитель:** junior. Senior review remote — новый метод чтения.
- **Scope:** экраны R01/R02/R04 с карточками. Remote-чтение истории — метод из интерфейса C1, с проекцией и правилом параметров (по образцу B3).
- **Критерии приёмки:** PA-01 — история одинакова на острове, в Telegram и на телефоне после рестарта хоста; R04 — после done ввод разблокирован, карточка приходит отдельно.
- **Верификатор:** независимая сессия.

### V1-E · Приёмка на реальном iPhone и hardening

- **Волна:** 4.
- **Зависит от:** всё выше.
- **Исполнитель:** verifier (junior) по сценариям, security review — senior.
- **Сценарии.** Числа фиксируются по факту, а не задаются заранее; всё пишется в отчёт верификатора.
  1. Время до первого аудио, мс.
  2. Barge-in — время до тишины, мс (VO-02).
  3. 2-минутная сессия: оценка против usage из sideband, $ (VO-16).
  4. Отзыв устройства на Mac → время до закрытия сессии, с (VO-13).
  5. Дневной лимит → закрытие и текстовый fallback (VO-07).
  6. Уход в фон → микрофон выключен.
  7. Reconnect мобильной сети посреди job (VO-05, VO-11).
  8. Рестарт хоста посреди job (VO-05, PA-14).
  9. Telegram-эскалация критичного события и повторное нажатие (VO-09, VO-10).
  10. APNs без пользовательского текста (VO-12).
- **Security review (senior):** remote-поверхность B3, биллинг B2 и S-TTS, хранение ключа (отступление от Spec 1 §2 записать).
- **Верификатор:** независимая сессия; приёмку на iPhone делает человек.

### Not verified (голосовая часть)

- Имя команды закрытия и форма usage у sideband GPT-Live: в документации прочитаны только attach и копии событий.
- Модель, цена и формат потокового ответа `/v1/audio/speech` на дату реализации.
- Сборка react-native-webrtc, Reanimated 4 + worklets и react-native-svg на RN 0.88.1 / Expo 58.
- Реальные вызовы OpenAI API в ходе обсуждения не делались.
