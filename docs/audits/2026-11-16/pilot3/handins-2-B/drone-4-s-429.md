<!-- drone 4 s-429 model=haiku addedAt=2026-11-16T17:40:45.962Z handedAt=2026-11-16T17:47:08.773Z result=done -->
Drone D (почта), источник: /Users/kalmbik61/parley/pilot3-subject, коммит 9eabc014, только чтение. Прочитаны целиком: packages/core/src/mcp/inbox-watch.ts, mcp/inbox-page.ts, work/delivery.ts, work/letters.ts, work/letter-store.ts, work/letter-tables.ts, work/thread.ts, work/channel.ts, work/events.ts, work/letter-upgrade.ts. Дополнительно открыты точечно: work/rooms.ts:124-126, 145-149, 426-440, 497, 546; work/plans.ts:110-125; work/plan-effects.ts:297-312; work/db.ts:36-85; work/types.ts:327-335, 796-802; work/task-giver.ts:74-76; work/store.ts:1150-1175. Тесты не читались.

## Q13 — звонок сторожа (inbox-watch)
- Письма для звонка: непрочитанные письма сессии по `unreadLetters(...)` (inbox-watch.ts:102; letter-store.ts:396-401), затем без уже звонивших id (`rung`, inbox-watch.ts:79, 104). Непрочитанное = кандидаты `message_unread` + правила `isUnreadFor` (letter-tables.ts:283-294, 269-277; letters.ts:37-38): нет `readBy[me]`, письмо не отменённого эффекта плана, я в `recipientsOf`.
- Удалённые письма (`deleted`) сторож НЕ отсекает: фильтра нет в inbox-watch.ts:102-105, в `unreadOfSession` (letter-tables.ts:293) и в `isUnreadFor` (letters.ts:37-38). Вывод по чтению, не запуском: звонок может прийти про письмо с `deleted = true`. Для сравнения, указатель отсекает (delivery.ts:237). `flagDeleted` убирает кандидатов только удалённого читателя (letter-tables.ts:686-688), у других читателей строки остаются.
- Порядок: по возрастанию `at` (строковое `localeCompare`), затем звонок по порядку (inbox-watch.ts:105, 126-129).
- Звонок ставится без ожидания тишины: сторож не вызывает `settleDelayMs`; проба запускается из `waitForMap` (inbox-watch.ts:117). Как `waitForMap` срабатывает по смене версии — в watch-map.ts, не читал.
- Имя отправителя: `participantLabel(map, letter.from)` (inbox-watch.ts:109; thread.ts:162-167): `parley` → `Parley`; живая сессия → её `label`; след в `deletedSessions` → `${id} (deleted)`; иначе сырой id (так `human` остаётся `human`; types.ts:331 `HUMAN = 'human'`).
- Текст звонка: `New message from ${fromLabel} (${kind}): call check_inbox.` (inbox-watch.ts:60-62). meta: `message_id`, `from` (сырой id), `from_label`, `kind`, `unread` (inbox-watch.ts:63-70).
- Число `unread` = `mine.length` (inbox-watch.ts:109, 68-69): все непрочитанные письма сессии на момент пробы, включая уже звонившие и удалённые; не только новые.
- Сбой `notify`: id снимается с `rung`, пауза `pollMs` (inbox-watch.ts:129-138).

## Q14 — адресаты комнатного письма и строки кандидатов
- Явный `to` непуст → адресаты = `to` (letters.ts:22).
- Без явного адресата (рассылка комнаты): участники комнаты минус `human` (letters.ts:25) минус отправитель (letters.ts:26); комнаты нет в карте → пусто (letters.ts:23); если у участника есть `joinedSeq`, он адресат только для писем с номером больше порога (letters.ts:27-30).
- Архив: `recipientsOf` возвращает пусто при любом `to`, если комната архивная (letters.ts:20-21, проверка раньше строки 22). Архивная комната = строка `archivedAt` (rooms.ts:124-126). Человек остаётся кандидатом (letter-tables.ts:377-383, `isHumanUnread`).
- Кандидаты при записи письма: `candidateReaders` (letter-tables.ts:556, 377-383), вставка строк `message_unread` (letter-tables.ts:439-444).
- Выход из комнаты: `left(roomId, reader)` удаляет строки `message_unread` этого читателя, этой комнаты, и только письма с `recipients = '[]'` (рассылки); письма с явным `to` остаются (letter-tables.ts:600-608, комментарий 601). Вызов — `leaveOtherRooms`, только для комнат, где сессия числится (rooms.ts:145-149, вызов на 148). В packages/core/src (без тестов) других вызовов `.left(` не найдено.
- Архив: `archived(roomId)` удаляет все строки `message_unread` комнаты кроме человека (letter-tables.ts:610-617); вызов в `archiveRoom` (rooms.ts:497).
- Возврат из архива: `reopened` ставит `readBy` текущим адресатам и убирает отмеченных кандидатов; для архивной комнаты выходит раньше (letter-tables.ts:619-654); вызов rooms.ts:546.
- Удаление комнаты: `DELETE FROM messages` по комнате (letter-tables.ts:660-662); отметки `message_reads` и кандидаты `message_unread` уходят каскадом по внешнему ключу `ON DELETE CASCADE` (db.ts:73-82). Вызов `letters.deleteRoom` — rooms.ts:437.

## Q15 — указатель: сразу или по тишине
- Срочность письма (`urgencyOf`, delivery.ts:173-177): не «письмо-обновление итога» (`isReportUpdateLetter`, task-giver.ts:74-76) И (от `human` ИЛИ `to` непуст ИЛИ `kind !== 'note'` ИЛИ упоминание `@sNN`/`@s-NN` адресата, delivery.ts:154-165). Виды писем: `note | question | decision` (types.ts:327). Срочны всегда `question`/`decision`; `note` без адресата — только с упоминанием.
- Сразу (0 мс): `wakesAtOnce` (delivery.ts:180-182) и `settleDelayMs` возвращает 0, если в списке есть срочное письмо (delivery.ts:198).
- Тишина: константы `SETTLE_MS = 30_000` (delivery.ts:20), `SETTLE_MAX_MS = 120_000` (delivery.ts:21). `settleDelayMs` (delivery.ts:190-209): пустой список → 0 (197); нечитаемый `at` (`Date.parse` = NaN) → 0 (199-200); самый новый `at` дальше `now` больше чем на `settleMs` (будущее) → 0 (206); иначе `max(0, min(min(newest+settle, oldest+settleMax) − now, settleMax))` (208).
- Какие письма входят: вход `unread` из хоста (delivery.ts:29); удалённые отсекаются (delivery.ts:237); в расчёт тишины — только ещё не указанные (delivery.ts:252-254). Текст указателя `pointerText(letters)` берёт все не удалённые непрочитанные, включая уже указанные (delivery.ts:268, 295). Это вывод по коду.
- Порядок правил: delivery.ts:233-298. Для простаивающего активного: нужен хук (275), `activity` = `unseen` или `idle` (284), не `draft` (288), не `inFlight` (289), затем тишина (290-291), затем `type-pointer` (293-298). Для спящего — подъём с лимитом `resumeAllowed` (262-271).

## Q16 — номер письма и откат
- Вид id: `m-` + номер, дополненный нулём до двух цифр (`m-${String(seq).padStart(2,'0')}`, letter-tables.ts:543); хранится как текст `id` и число `seq` (letter-tables.ts:400, 421); `m-3795` приведён в комментарии db.ts:51. Уникальность: индекс `messages_id` (db.ts:69), PK `(project_path, work_id, seq)` (db.ts:67).
- Номер: `max(work.messageSeq ?? 0, MAX(seq) писем работы) + 1` (letter-tables.ts:539-541), под блокировкой записи (комментарий 540).
- Не переиспользуются после удаления комнаты: `deleteRoom` запоминает наибольший номер ДО удаления (верхний номер снимается до `DELETE` на 657-658, `DELETE` на 662) в `work.messageSeq`, только если он больше прежнего (letter-tables.ts:666-670). Поле описано в types.ts:796-802; назначение — rooms.ts:426-427.
- Сохранение `messageSeq`: записывается в `work_json` при `UPDATE_WORK_HEAD` (store.ts:1158-1174), проверено по коду частично.
- Вложенный откат (`savepoint`, letter-tables.ts:710-736): `SAVEPOINT letters_N`; при исключении журнал отмен проигрывается в обратном порядке (729) — это возвращает `work.messageSeq` (undo на 670-672) и `wrote` (730); журнал обрезается до прежних длин (731); `ROLLBACK TO` откатывает SQL-изменения области, включая удаление писем комнаты и каскадные отметки/кандидатов (732); затем `RELEASE` (733) и проброс ошибки (734). Удачная вложенная область отдаёт свои отмены внешней (725), так что внешний откат их тоже снимает.
- Уровень вызывающего: `edit` (plans.ts:112-125) и `reservePlanEffects` (plan-effects.ts:297-312) копируют черновик, возвращают его в карту только после успешного `savepoint` — при исключении возврата нет.
- В packages/core/src (без тестов) `rooms.deleteRoom` (rooms.ts:427) не вызывается ни из одного места; вызовы `savepoint` — plans.ts:120 и plan-effects.ts:307. Какой путь реально гоняет удаление комнаты внутри такой области — не проверено (вне core/src).

## Статус вопросов
- Q13: answered (кроме `waitForMap`/timing из watch-map.ts — open).
- Q14: answered по правилам и вызовам в core/src; вне core/src (host) вызовы не искались — open.
- Q15: answered по delivery.ts; кто и с каким `unread`/`now` вызывает `deliveryAction` (host/wake) — open, не читал.
- Q16: answered; открыт вопрос, какой внешний путь вызывает `deleteRoom` внутри `savepoint` в продакшене; поведение SQLite ROLLBACK TO взято из общего знания SQLite, по ссылке не проверял.

Not verified: watch-map.ts (waitForMap), host/wake (caller of deliveryAction), rooms.ts вне указанных диапазонов, store.ts вне 1150-1175, map.ts addMessage, поведение в рантайме (тесты и запуск не делались — по правилам).

Coverage: partial — не покрыты watch-map.ts, host/wake и вызыватели вне packages/core/src; вывод по удалённым письмам в сторожах (Q13) и по откату через внешний путь (Q16) — только по чтению кода.