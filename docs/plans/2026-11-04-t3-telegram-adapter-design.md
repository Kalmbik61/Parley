# T3 — адаптер Telegram-триггеров: дизайн для исполнителя

**Дата:** 2026-11-04. **Основание:** план `2026-11-03-voice-assistant-core-plan.md` §3 (T1–T5), Spec 1 §6.
**Сверено** по ветке `feat/voice-assistant-core` (fb5f5c08). Номера строк — оттуда.

## 1. Решения

1. **Режим до T5 — константа `TELEGRAM_ONLY`** (`mode: () => 'TELEGRAM_ONLY'` в `host.ts`). Почему:
   - отправителя канала `app` нет до T4. `route()` в `TELEGRAM_ONLY` даёт `app = false` всегда, поэтому строки `app` не копятся;
   - `telegram = presence.telegramAllowed`: всё, что сегодня уходит в Telegram, уходит и дальше;
   - `SMART`/`BOTH`/`APP_ONLY` до T4 завели бы записи `app`, которые некому отправить.
   `presence` = `{ appActive: false, telegramAllowed: telegramAllowed() }`.
2. **NotifyMemory остаётся детектором дельт.** `activityTransition`, `worksTriggers` (флаг `first`), `mailTriggers` и `rebase()` не меняются. Store отвечает за другое: что событие было и что по нему доставлено. Он даёт dedupe (VO-11), ack между каналами и вход роутера. Уровни сессий из store не выводятся: в конверте их нет. Это осознанное отступление от формулировки плана «дельта выводится из store». Оно следует §6.1: «обернуть, а не дублировать алгоритмы».
3. **Текст в store не попадает.** Триггер пишет только конверт. Само сообщение — это замыкание `present()`. Оно лежит в памяти сервиса: `payloads: Map<notificationId, () => void>`. Внутри него — сегодняшний код показа (`watchBlocked`, `notice`, `sendRoomCard`, письмо). Текст собирается в момент отправки из тех же объектов, что и сегодня. Поэтому пользователь получает то же, что и сейчас.
4. **После рестарта хоста** `payloads` пуст. Записи outbox `telegram` прошлого процесса drain закрывает через `markSent` без сообщения. Сегодня так же: очередь в памяти теряется, `rebase()` делает базу, `closeStaleCards` закрывает старые карточки. Отдельная отсечка по времени не нужна: «нет payload» и есть отсечка.
5. **Сетевую доставку по-прежнему ведёт `telegram/outbox.ts`** (429, повтор сети, замена по ключу, приоритеты). Durable-outbox отмечается `markSent` сразу после передачи в эту очередь, синхронно в том же drain. Повторной отправки по истёкшей аренде поэтому нет. Сообщение, которое было в полёте во время падения, теряется, как и сегодня.
6. **`needs-confirmation` и `job-finished` в Telegram не порождают сообщений.** Карточки помощника по-прежнему шлёт мост (`assistant-bridge.ts` → `sendAssistantCard`). У строк, записанных ingest, нет payload, и drain закрывает их через `markSent`. Второго сообщения нет. Текста Telegram для jobs сегодня нет, и вызовов `submitJob` в коде пока нет.

## 2. Типы событий и ключи

Строители — чистые функции в `telegram/notify.ts`. Все id — opaque и проходят `assertEnvelope`:
- `w-NNNN` (одна `parley.db` на все проекты, `createWork`);
- `s-NN`, `r-NN`, `m-NN`;
- `p-NN` (`nextProposalId`).

`projectPath`, названия и тексты в конверт не идут. `workspaceId` не ставится. `eventId = dedupeKey`.

| Триггер | `type` | `dedupeKey` | `entityRef` | severity / requiresAction |
|---|---|---|---|---|
| `activityTransition → 'needs-you'` | `session-needs-you` | `needs_you:{workId}:{sessionId}:{atMs}` | `session:{workId}:{sessionId}` | warning / true |
| `activityTransition → 'unseen'` | `session-finished` | `finished:{workId}:{sessionId}:{atMs}` | `session:{workId}:{sessionId}` | info / false |
| `worksTriggers.decisions` (new/revised) | `room-decision` | `room_decision:{workId}:{roomId}:{proposalId}:{rev}` | `room:{workId}:{roomId}` (+ `payloadRef: proposal:{proposalId}:{rev}`) | warning / true |
| `mailTriggers` | `mail-letter` | `letter:{workId}:{messageId}` | `letter:{workId}:{messageId}` | info / false |

Почему в ключах активности стоит `atMs` (время перехода по `now()` сервиса):
- у эпизода «нужен ты» нет стабильного id. `turnBoundaryAt` склеил бы два запроса одного хода;
- повторы одного уровня гасит `memory.levels`, а рестарт — `rebase()`. VO-11 для Telegram держится на них. Для комнат и писем его держит ещё и сам ключ.

Закрытие строк в T3:
- **room-decision.** Успешный `resolveRoom` из Telegram → `store.ack(key, 'telegram')`. `worksTriggers.closed` с `accepted`/`returned` → `store.ack(key, 'island')`: вернёт `false`, если Telegram уже закрыл строку. `revised`/`gone` → `store.markExpired(key)`.
- **needs-you, finished, letter** в T3 не закрываются: это Inbox, `seen`/`ack` — T4.

## 3. Поток и drain

```
триггер (onActivity/onWorks/onMail) ─ guard canSend() как сегодня ─ тумблер (telegramNeedsYou/Finished/Mail) как сегодня
  → publish(event, present):
      try { {row, created} = store.write(event, now()) } catch → log + present() напрямую (Telegram не замолкает из-за store)
      if (!created) return                      // dedupe: второго сообщения нет
      payloads.set(row.notificationId, present)
      router.dispatch(row, false)               // TELEGRAM_ONLY → запись outbox 'telegram' на now
      drainNotifications()
```

`drainNotifications()` живёт в `telegram/service.ts`, и вызывает его только сервис:

- `if (!canSend()) return;` — проверка «Telegram разрешён и привязан» перед отправкой. Это отложенная находка ревью T2. Аренда при этом не берётся, записи остаются `pending`.
- `for (row of store.dueOutbox(now(), 'telegram'))`:
  - `present = payloads.get(row.notificationId)`, затем `payloads.delete(...)`;
  - нет `present` → `store.markSent(row.id, now())`. Сюда попадают записи прошлого процесса, `needs-confirmation`, `job-finished`, а также строки, чей payload снят отвязкой;
  - иначе `try { present(); store.markSent(row.id, now()) } catch { log; store.markFailed(row.id, now()); payloads.set(...) }`.
- Без `present` в лог пишется одна строка на проход: `telegram: N notification(s) without payload marked handled`.

`present()` перед показом ещё раз проверяет свой тумблер `cfg` (тот мог смениться между записью и drain). Остальные проверки остаются как сегодня внутри `watchBlocked`/`sendRoomCard`.

Таймер: `setInterval(drainNotifications, 30_000)` с `unref`. Ставится в `begin()`, снимается в `disable()`. Он нужен для повторов `markFailed` и для строк, которые ingest заводит вне сервиса. Аренда (`LEASE_MS`) работает только при падении посреди прохода: после рестарта такая строка снова due, payload у неё нет, и она закрывается без сообщения.

`payloads.clear()` вызывается в `rebase()` (а значит, и в `begin`/`onStart`/`takeOver`), `unlink()` и `disable()`. После перепривязки старое не уходит новому владельцу.

Что идёт мимо store, как сегодня, — это показ уже открытого эпизода или карточки, а не новый повод:
- правки и закрытия карточек (`closeCard`, `edit`);
- дослыл карточек ленты (`onFeedChanged`, ветка «всё ещё blocked» в `onActivity`);
- карточки согласий;
- ответы и карточки моста помощника;
- `reminderWhileOff`.

## 4. Подключение в `host.ts` (L826–865)

1. Один `notificationStore = createNotificationStore(workDb())` на ingest, роутер и Telegram. Сейчас он создаётся прямо внутри `createIngest`.
2. Перед роутером: `let telegramAllowed = (): boolean => false;`. После `createTelegramService(...)` переменная переназначается на `() => { const s = telegram.status(); return s.enabled && s.token === 'set' && s.owner !== null && s.polling !== 'conflict'; }`. Так нет TDZ: события ядра могут прийти раньше, чем создан `telegram`.
3. `router = createRouter({ store: notificationStore, mode: () => 'TELEGRAM_ONLY', presence: () => ({ appActive: false, telegramAllowed: telegramAllowed() }) })`.
4. `createIngest({ store, hostId: 'local', dispatch: (row, inline) => router.dispatch(row, inline) })`. Ingest зовёт `dispatch` только при `created === true`.
5. **Повтор активных карточек на старте не диспатчится.** Повтор события по существующей строке даёт `created: false`. По коду старта `emitCard` на старте не зовётся: вызовы — в decide/reissue/sweep. Карточки в чат возвращает мост, как сегодня.
6. `deliveredInline`: в `createMethods` (L973) передаётся обёртка `{ ...assistantJobs, ackInline(jobId, rev) { const r = assistantJobs.ackInline(jobId, rev); if (r.ok) { const job = assistantJobs.getJob(jobId); if (job) notificationIngest.onInlineDelivered(job); } return r; } }`. `createJobs` возвращает литерал, поэтому spread корректен. `onInlineDelivered` снимает ожидающую запись `app` строки `jobKey(job.jobId, job.state)`. В `TELEGRAM_ONLY` её нет, но T4 получает готовое поведение.
7. В `createTelegramService` передаётся `notifications: { store: notificationStore, router, hostId: 'local' }`.

## 5. Изменения по файлам

**Задача T3a — notifications.** Выполняется первой; трогает `host.ts`, поэтому T3b идёт после неё, а не параллельно.
- `packages/host/src/notifications/store.ts`:
  - `dueOutbox(now, channel?)` — фильтр `AND o.channel = ?`, если канал передан; без канала поведение прежнее. Без фильтра drain Telegram взял бы аренду и чужих (`app`) записей;
  - новый `cancelPending(dedupeKey, channel): boolean` — `DELETE ... WHERE notification_id = ? AND channel = ? AND state = 'pending'`.
- `packages/host/src/notifications/ingest.ts`:
  - `IngestDeps.dispatch?(row, deliveredInline)`. Зовётся при `created`, для job с `job.deliveredInline`, для карточки `needs_confirmation` — с `false`;
  - новый `onInlineDelivered(job: Job): void` → `store.cancelPending(jobKey(...), 'app')`.
- `packages/host/src/host.ts`: пункты 1–6 из §4. Пункт 7 — в T3b; до T3b `telegramAllowed` уже работает через `status()`.

**Задача T3b — Telegram.** После T3a.
- `packages/host/src/telegram/notify.ts`: строители `needsYouEvent(ref, at, hostId)`, `finishedEvent(ref, at, hostId)`, `roomDecisionKey(workId, roomId, proposalId, rev)`, `roomDecisionEvent(entry, room, hostId)`, `letterEvent(entry, message, hostId)`. Возвращают `NewNotification` без `channels`. Существующие функции не меняются.
- `packages/host/src/telegram/service.ts`:
  - `TelegramServiceDeps.notifications: { store: Pick<NotificationStore, 'write'|'ack'|'markExpired'|'dueOutbox'|'markSent'|'markFailed'>; router: Pick<Router,'dispatch'>; hostId: string }` — обязательная;
  - новые `payloads`, `publish`, `drainNotifications`, таймер;
  - `onActivity` (L773): ветка `needs-you` → `publish(needsYouEvent, () => watchBlocked(...))` при `telegramNeedsYou`; ветка `unseen` → `publish(finishedEvent, () => notice(...))` при `telegramFinished`;
  - `onWorks` (L794): `decisions` → `publish(roomDecisionEvent, () => sendRoomCard(...))`; в `closed` — ack/markExpired по §2;
  - `onMail` (L814): `publish(letterEvent, () => send(...letter card...))`;
  - `resolveRoom` (L648): ack `'telegram'` при успехе;
  - `rebase`, `unlink`, `disable`, `begin`: payloads и таймер по §3.
- `packages/host/src/host.ts`: пункт 7 из §4.
- `state.ts` и `outbox.ts` **не меняются**. state.json остаётся презентацией карточек, а outbox — сетевой очередью.

## 6. Тесты и критерии приёмки

Запуск: `pnpm --filter @parley/host exec vitest run <файлы>`; `tsc --noEmit -p packages/host`; eslint по тронутым файлам.

**T3a** (`notifications/store.test.ts`, `notifications/ingest.test.ts`, `notifications/router.test.ts`):
1. `dueOutbox(now, 'telegram')` отдаёт только записи `telegram`; запись `app` той же строки после этого вызова отдаётся `dueOutbox(now, 'app')` без задержки на аренду.
2. `dueOutbox(now)` без канала — прежние тесты зелёные без правок.
3. `cancelPending(key, 'app')` удаляет только ожидающую `app`, запись `telegram` цела; для `sent` и для неизвестного ключа → `false`.
4. ingest: первое терминальное событие job → `dispatch` один раз с `job.deliveredInline`; повтор того же события → `dispatch` не зовётся. Повтор `needs_confirmation` по существующей строке → не зовётся.
5. `onInlineDelivered` после терминального события с записью `app` (store + роутер в `SMART`, `appActive=false`) → записи `app` нет, строка `notifications` цела.
6. Роутер с `mode: 'TELEGRAM_ONLY'` по job, карточке и `telegramAllowed` true/false → ни одной записи `app` (регрессия «app не копится»).

**T3b** (`telegram/notify.test.ts`, `telegram/service.test.ts`, `telegram/service.consent.test.ts`, `telegram/outbox.test.ts`):
1. **Главный критерий регрессии:** все существующие тесты `service.test.ts` и `service.consent.test.ts` зелёные. Меняется только `make()`: реальный store на `openMemoryDb()` и роутер `TELEGRAM_ONLY` с `telegramAllowed: () => true`, у роутера и сервиса одни часы.
2. `notify.test.ts`: каждый строитель → `store.write` не бросает. В JSON строки нет `projectPath` (`/Users/...`), названия работы или комнаты (кириллица) и текста письма.
3. Решение комнаты → одна строка `room-decision`, одна запись outbox `sent`, одно `sendMessage` с прежним текстом и кнопками. Повторный `onWorks` с тем же снимком → ни новой строки, ни сообщения.
4. Рестарт: первый экземпляр пишет строку при `canSend() === false` на drain (запись `pending`). Второй экземпляр на той же базе после `start()` и продвижения таймера закрывает запись (`sent`) без вызова Bot API.
5. `canSend()` ложен (нет владельца, `conflict`) → `dueOutbox` не вызывается, аренда не взята (`next_attempt_at` не изменился).
6. `unlink()` между записью и drain → после перепривязки сообщение не уходит.
7. Запись `telegram` по строке `needs-confirmation` (ingest + роутер, как в host) → drain ставит `sent` без `sendMessage`. Карточка помощника уходит ровно один раз — через мост.
8. «Accept» в Telegram → строка `acked` с `ackedVia='telegram'`. Следующий `onWorks` с `closed: accepted` строку не меняет.
9. `closed: revised` / `gone` → строка `expired`.
10. Тумблер выключен в момент триггера → строки нет. Выключен между записью и drain → сообщения нет, запись `sent`.
11. `store.write` бросает (подменённый store) → сообщение уходит напрямую, в логе строка ошибки.
12. `outbox.test.ts` (429-пауза, замена по ключу) — без правок, зелёный.

## 7. Риски

- **T5 должен закрыть обходы роутера.** Карточки моста и согласий, дослыл ленты и `reminderWhileOff` идут мимо роутера. При `APP_ONLY` они всё равно попадут в Telegram, если T5 их не загейтит. Эскалация `SMART` по `needs-confirmation` требует, чтобы drain Telegram умел показывать карточку; сейчас это no-op.
- **Inbox неполон при выключенном Telegram.** Триггеры по-прежнему под `canSend()`, поэтому при выключенном Telegram комнаты, письма и активность в store не попадают. Для Inbox (T4) расчёт поводов придётся вынести из-под guard.
- **Рост таблицы.** Ретенции `notifications` нет. Строка пишется на каждый переход «нужен ты», а при `telegramFinished` — и на каждый конец хода.
- **`markSent` означает «обработано каналом», а не «сообщение ушло».** Записи без payload помечаются `sent` без отправки. Отдельного состояния `skipped` нет: схему ради него не меняли.
- **Повтор при сбое.** `markFailed` с повтором возможен, только если `present()` бросил синхронно, а это редкость. Сетевые ошибки после передачи в очередь durable-outbox не видит, как и сегодня.
- **Совпадение `workId`** между проектами (старые немигрированные карты) склеит ключи. Следствие — пропущенное сообщение, а не лишнее.

## Not verified

- Уникальность `workId` по всем проектам: опирается на комментарий `createWork` («id по всей базе», одна `parley.db`). Старые карты, не переехавшие в базу, не проверял.
- Что `emitCard` не зовётся на старте хоста: проверено только grep по `assistant-service.ts` (вызовы в decide/reissue/sweep/emitSuperseded). Ранний `sweep` может выдать `expired` → `markExpired`; это безопасно.
- Форматы id `s-NN`/`r-NN`/`m-NN` взяты из комментариев core, `p-NN` — из `nextProposalId`. Что `sessionId` никогда не содержит символов вне `[A-Za-z0-9:_./-]`, не проверял. На этот случай есть страховка `publish` (п. 11 тестов T3b).
- Поведение сервисных тестов с fake timers при новом `setInterval`: ни один тест не запускал. В них есть `advanceTimersByTimeAsync` до 20 с, интервал 30 с.
- Объём строк в реальной работе (переходы «нужен ты» в день) не измерял.
