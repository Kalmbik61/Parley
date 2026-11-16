<!-- drone 4 s-431 model=haiku addedAt=2026-11-16T17:40:46.850Z handedAt=2026-11-16T17:48:30.596Z result=done -->
Срез D (почта), исходник: /Users/kalmbik61/parley/pilot3-subject, пути от корня копии. Прочитаны целиком: work/letter-store.ts, letter-tables.ts, letter-upgrade.ts, letters.ts, delivery.ts, thread.ts, channel.ts, events.ts; mcp/inbox-watch.ts, mcp/inbox-page.ts. Не открывались: watch-map.ts, task-giver.ts (isReportUpdateLetter), attention.ts (isHumanUnread), store.ts, map-rows.ts, context-budget.ts, MESSAGE_KINDS и HUMAN из types.ts.

**Q13: кому звонит сторож и как**
- Какие письма: `probe` берёт `unreadLetters(me)` (inbox-watch.ts:102), то есть для сессии кандидатов `message_unread` по читателю (letter-tables.ts:283-294, кандидаты 269-277) с живым правилом `isUnreadFor` (letters.ts:37-38: нет `readBy[me]`, письмо не отменённого плана, `recipientsOf` включает сессию). Закрытый читатель — []: letter-tables.ts:292. Отбрасываются письма, уже в `rung` (inbox-watch.ts:104). Пусто — `null`, ждём дальше (106). Поля `deleted` проба не проверяет (ни inbox-watch, ни letter-tables.ts:293, ни letters.ts:37), в отличие от доставки (delivery.ts:237).
- Порядок: `sort((a, b) => a.at.localeCompare(b.at))` — по строке `at` по возрастанию (inbox-watch.ts:105), не по номеру. Равные `at` — порядок выборки кандидатов по `seq` (letter-tables.ts:274). Звонки уходят по одному, по порядку (inbox-watch.ts:126-135).
- Имя отправителя: `ringFor` (inbox-watch.ts:60-72) получает `fromLabel = participantLabel(map, letter.from)` (inbox-watch.ts:109). `participantLabel` (thread.ts:162-167): PARLEY → `Parley` (163); живая сессия → её `label` (164-165); id в `work.deletedSessions` → `<id> (deleted)` (166); иначе голый id (167). В тексте: `New message from ${fromLabel} (${kind}): call check_inbox.` (inbox-watch.ts:62). В meta `from` — сырой id отправителя (65), `from_label` — подпись (66).
- Число `unread`: `String(mine.length)` (inbox-watch.ts:69, 109) — это ВСЕ непрочитанные письма читателя из `unreadLetters`, включая уже позвонённые (`rung`) и удалённые (фильтра нет), а не только текущий звонок. Один и тот же счёт на каждом звонке пачки. Расхождение: указатель доставки (delivery.ts:237) удалённые отсеивает, а `unread` в звонке — нет.
- Ограничение страницы: inbox-page.ts:65 (`INBOX_MAX_LETTERS`) действует на `check_inbox`/`wait_for`, сторож её не использует — пробa отдаёт все непозвонённые.
- Повторы: `rung.add` до `notify` (inbox-watch.ts:127), при сбое `rung.delete` и пауза (132, 138). Множество только в памяти процесса (комментарий 28-29).

**Q14: получатели комнатного письма без адресата, архив, удаляемые строки**
- Адресаты: `recipientsOf` (letters.ts:18-31). Письмо без комнаты — `to` (19). Архивная комната — `[]` (21, раньше проверки `to`, значит и явный `to` теряет адресатов). Явный `to` — как есть (22). Рассылка: участники `room.members` без человека (`HUMAN`, 25) и без отправителя (26); при `joinedSeq` — только те, кто вошёл раньше номера письма (27-30; `joinedSeq[id] ?? 0 < seq`); без `joinedSeq` — все участники (28).
- Расхождение с документом: комментарий letters.ts:12-13 говорит, что создатель комнаты — участник «даже если в `members` его не записали», но `recipientsOf` создателя не добавляет (18-31). Проверено только здесь: откуда создатель попадает в `members`, не читалось.
- Человек: не адресат, но кандидат, если `isHumanUnread` (letter-tables.ts:377-383); `isHumanUnread` из attention.ts не открывался, сослаться можно только на место вызова.
- Архив: `archived(roomId)` (letter-tables.ts:610-617) удаляет все строки `message_unread` этой комнаты, кроме читателя `HUMAN` (`reader != ?`, 614-615). Письма человека остаются. Повторное открытие — `reopened` не ставит отметок архивной комнате (619-623).
- Выход сессии: `left(roomId, reader)` (600-608) удаляет строки `message_unread` читателя этой комнаты только у писем с `recipients = '[]'` (рассылки, 604-605); письма с явным `to` остаются. Комментарий 84-85.
- Удаление строк при закрытии сессии: `dropReaderCandidates` (386-393), `DELETE FROM message_unread ... reader IN (...)`; вызывающий — store.ts, не читан.
- Удаление комнаты: `deleteRoom` (656-677) удаляет письма комнаты; отметки и кандидаты «уходят каскадом» (комментарий 660), схема не читана.
- Открыто: в каких вызовах (store.ts, room-код) `left`/`archived` зовутся при выходе/архиве — не читано.

**Q15: указатель сразу или по тишине**
- Сразу (`wakesAtOnce`/`urgencyOf`, delivery.ts:173-182): письмо срочное, если не `isReportUpdateLetter` И (`from === HUMAN` ИЛИ `to` не пуст ИЛИ `kind !== 'note'` ИЛИ текст содержит `@sNN`/`@s-NN` получателя, 175-176, `mentionPattern` 160-165). Одно срочное в пачке забирает всю пачку: `settleDelayMs` возвращает 0, если `letters.some(urgencyOf)` (delivery.ts:198).
- Ожидание тишины (`settleDelayMs`, delivery.ts:190-209): константы `SETTLE_MS = 30_000` (20), `SETTLE_MAX_MS = 120_000` (21). Пусто — 0 (197). Срочное — 0 (198). Нечитаемый `at` (`Date.parse` NaN) — 0 (199-200). `newest − now > settleMs` (далёкое будущее или скачок часов) — 0 (206). Иначе `max(0, min(min(newest + settleMs, oldest + settleMaxMs) − now, settleMaxMs))` (208). Итог не выше `settleMaxMs` и не ниже 0.
- Что входит: в `deliveryAction` (delivery.ts:215) для живой сессии `unread` без удалённых (237) и без уже указанных (`pointed`, 253 в `settleIn`). Срочность проверяется по этой выборке (198). Сама `settleIn` через `session.id` (254-257).
- Путь простаивающего агента: `lifecycle === 'active'` (272), `hooked` (275), `activity` — `unseen`/`idle`, либо `queue` (Codex, 281) или `parked` (279) (282-287); потом `draft` (288), `in-flight` (289), затем `settling` с `retryInMs` (290-291); иначе `type-pointer` (293-298) с текстом по всем `letters` (295), включая уже указанные.
- Открыто: `isReportUpdateLetter` (task-giver.ts) не читан: исключение «итог не срочен» (175) опирается на него; `MESSAGE_KINDS` (types.ts) не читан.

**Q16: номер письма, rollback**
- Номер: `LetterTx.add` в таблицах (letter-tables.ts:537-562): `top = MAX(seq)` по работе (539), `seq = max(map.work.messageSeq ?? 0, top) + 1` (541), id `m-` + номер с дополнением до двух знаков (543), например `m-01`, `m-100`. Ниже `messageSeq` не опускается (комментарий 540), то есть после удаления комнаты номера не переиспользуются, пока `messageSeq` сохраняется.
- Удаление комнаты: `deleteRoom` (656-677) берёт `top` = MAX(seq) всей работы до удаления (657-659), удаляет письма комнаты (661-663); без писем — return (665); иначе `messageSeq = max(before, top)` (666-669), журнал `droppedRooms` (676).
- Вариант в памяти: `mapLetterTx.deleteRoom` (letter-store.ts:286-299) — `max(messageSeq, maxNumber(...))` (291).
- Формат id проверяет `assertStorableLetterIds` (letter-tables.ts:463-468): `^m-\d+$`, положительный номер, без повторов.
- Вложенный `savepoint` (letter-tables.ts:710-736): имя `letters_N` (711-712), `SAVEPOINT` (716), отмены — в свой журнал (717). При успехе журнал переходит внешнему (725). При ошибке (727-735): отмены журнала в обратном порядке (729) — среди них возврат `work.messageSeq` (670-673, push в `undo.at(-1)`); `wrote` восстанавливается (730); журнал обрезается (731); `ROLLBACK TO` возвращает строки `messages`, `message_reads`, `message_unread` (732); `RELEASE` (733); ошибка пробрасывается (734).
- Итог: при провале внутреннего savepoint возвращаются: строки писем, отметок и кандидатов (SQLite), `work.messageSeq` в памяти (через журнал), флаг записи, журнал записанного. Внешняя транзакция продолжается.
- Открыто: сохранение `work.messageSeq` в базе и блокировка записи (MAX читается внутри записи) — store.ts не читан; без него утверждение «номера не переиспользуются» держится только в пределах той же записи.
- Не читано: схема таблиц (каскад из комментария 660), `letter-upgrade.ts` читан целиком: переезд сохраняет номера писем (`letterSeq`, 1-рефы 130-161), но номер `work.messageSeq` при переезде не переписывается — это здесь не проверялось.

**Coverage**
- Q13: covered.
- Q14: partial — open: Q14 «когда» (вызывающие `left`, `archived`, `dropReaderCandidates` в store.ts/room-коде), схема каскада при `deleteRoom`, создатель комнаты в `members`.
- Q15: partial — open: Q15 `isReportUpdateLetter` (task-giver.ts) и список видов `MESSAGE_KINDS` (types.ts), влияют на «сразу/тишина».
- Q16: partial — open: Q16 сохранение `work.messageSeq` и блокировка записи (store.ts), схема таблиц.

Ни одного файла не изменено, команд не запускалось.