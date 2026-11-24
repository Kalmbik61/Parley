<!-- drone 7 s-436 model=haiku addedAt=2026-11-16T17:49:31.770Z handedAt=2026-11-16T17:53:50.264Z result=done -->
Drone D2 mail, слайс D, Q14–Q16. Только чтение копии /Users/kalmbik61/parley/pilot3-subject; пути относительно корня копии (packages/core/src/…). Коммит 9eabc014 не сверял (git не запускал).

## Q14. Получатель письма комнаты без адресата; архив; удаление кандидатов

**Адресаты** (packages/core/src/work/letters.ts): прямое письмо (roomId null) → to (:19); комната не найдена → [] (:23); архивная комната → [] (:21), раньше явного to; явный to → как есть (:22); рассылка → room.members без HUMAN (:25) и без отправителя (:26); при joinedSeq — только участники с порогом меньше номера письма (:27-30), без joinedSeq — все (:28). Создатель не добавляется: recipientsOf берёт только room.members (:24).
- Подтверждено предшественником: :19, :21, :22, :25, :26, :27-30, :28.
- Поправка: пропущено :23 (комнаты нет → []).

**Человек**: кандидат, если isHumanUnread (packages/core/src/work/attention.ts:77-83: не от человека, без readBy.human, roomId не null или to содержит human). Кандидатство для письма комнаты не зависит от членства: candidateReaders (work/letter-tables.ts:377-383) добавляет HUMAN по isHumanUnread({...message, readBy:{}}), затем отбрасывает прочитанное; insertLetter пишет кандидатов (letter-tables.ts:439-444). Архивация не трогает строки человека (letter-tables.ts:614). Подтверждено.

**Создатель как адресат** — letters.ts:12-13 неверен для текущих комнат. addRoom (work/rooms.ts:61-93) берёт members как переданы; агентский create_room: members = membersInput без создателя, приглашаются members кроме себя (packages/core/src/mcp/tools.ts:1508-1509, addRoom 1525-1528); хостовый create: creator HUMAN, members без HUMAN (packages/host/src/rooms/rooms-service.ts:103, 117-120). Создатель попадает в members только в миграции карты без ownerId: work/map.ts:706-711 (`members.push(creator)`). Итог: комментарий верен только для legacy-карт; по коду создатель, не записанный в members, не адресат. Предшественник: частично подтверждено, поправка.

**Где вызывается left/archived** (подтверждено и уточнено):
- left(roomId, reader) — только из leaveOtherRooms (work/rooms.ts:148), а она — при входе в другую комнату: addMember (rooms.ts:221), agent create_room (tools.ts:1533), host rooms-service.ts:132, и через addMember — rooms-service.ts:225, host/src/rooms/autonomous-engine.ts:273. Отдельного «выхода из комнаты» нет: единственное удаление из members — rooms.ts:149.
  Удаляет кандидатов читателя в этой комнате только у писем с recipients = '[]' (letter-tables.ts:600-608). Письма с явным to остаются (как и recipientsOf).
- archived(roomId) — из archiveRoom (rooms.ts:497), вызов хоста rooms-service.ts:387. Удаляет кандидатов ВСЕХ читателей комнаты кроме HUMAN, для любых писем комнаты, включая явный to (letter-tables.ts:610-617).

**Прочие удаления кандидатов** (не названы предшественником):
- Закрытие сессии: dropReaderCandidates(readers) по всем её письмам, не по комнате (letter-tables.ts:386-393); вызов в store.ts:1222-1224 для сессий, ставших closed в этой записи (closedNow).
- Удаление сессии: removeSession (work/map.ts:175-213) → letters.flagDeleted (map.ts:204) → удаляет ВСЕ кандидаты читателя (letter-tables.ts:686-691) и ставит deleted.
- deleteRoom: письма комнаты удаляются (letter-tables.ts:661-663); отметки и кандидаты — каскадом: FK ON DELETE CASCADE (work/db.ts:76-82), PRAGMA foreign_keys = ON (db.ts:497). Подтверждено.
- reopened: удаляет кандидатов, у которых появилась отметка (letter-tables.ts:644-650). effectCancelled: кандидаты, кроме человека (:704-706).
- Снятие кандидатов не восстанавливается при повторном входе: joinedSeq (rooms.ts:183-187) режет старые рассылки, кандидаты создаются только при записи письма (candidateReaders).

## Q15. Срочные письма и окно тишины

**Срочность** (packages/core/src/work/delivery.ts:173-182): письмо срочное, если НЕ isReportUpdateLetter И (from === HUMAN ИЛИ to непуст ИЛИ kind !== 'note' ИЛИ текст упоминает получателя). Упоминание: mentionPattern (delivery.ts:160-165) — `@sNN` и для id s-NN ещё `@s-NN`, граница слова. Подтверждено (:175-176, :160-165).
- Срочны сразу: прямые письма сессии; письма с явным to (в т.ч. в комнате); письма человека (в т.ч. «задача всем» в комнате); question/decision; рассылка с упоминанием получателя.
- Ждут тишины: note в комнате без to, не от человека, без упоминания получателя; и update-письма (ниже).
- Виды: MESSAGE_KINDS = ['note','question','decision'] (packages/core/src/work/types.ts:327-328).
- isReportUpdateLetter (packages/core/src/work/task-giver.ts:74-76): from === 'system', roomId null, текст начинается с `\S+ reported (done|failed) (update)`. Пишется в mcp/tools.ts:961-973 с to = ids (адресное, но исключено из срочности); `(update)` — когда в окне 60 с (REPORT_UPDATE_WINDOW_MS, task-giver.ts:8) было другое письмо о сдаче. Подтверждено, с уточнением: регулярка только для done/failed.

**Вычисление** settleDelayMs (delivery.ts:190-209): SETTLE_MS = 30 000 (:20), SETTLE_MAX_MS = 120 000 (:21).
- пусто → 0 (:197); хоть одно срочное → 0 (:198); любой at NaN → 0 (:199-200); newest − now > settleMs → 0 (:206, «скачок часов»; равенство ещё ждёт); иначе max(0, min(min(newest+settleMs, oldest+settleMaxMs) − now, settleMaxMs)) (:208).
- Следствие: если самое старое письма пачки старше settleMaxMs, срок 0 (oldest+settleMaxMs − now ≤ 0) — пачка уходит сразу.
- at в хранилище канонический ISO (letter-tables.ts:549 sinceBound; map.ts:674 migrateMessage), NaN на пути записи/миграции не возникает (map.ts:526 отказ) — вывод по коду, не запускал. Далёкое будущее возможно (at принимается как есть) и даёт 0.
- Переопределение settleMs/settleMaxMs только тестами: wake-service.ts:102, 435-437; mcp/context.ts:59.
- Подтверждено предшественником: :197, :198, :199-200, :206, :208, :20, :21.

**Какие письма входят**: deliveryAction (delivery.ts:215): unread → без deleted (:237) → settleIn берёт только не указанные (:251-258, фильтр !pointed.has). Срочность и settleDelayMs видят этот же набор. Поправка: текст указателя pointerText(letters, rooms) (:295, :267) строится из ВСЕХ непрочитанных без deleted, включая уже указанные. Порядок правил: paused, closed, no-letters (:238), stuck (:244), all-pointed (:245), sleeping (:262-271), not-live (:272), no-hooks (:275), busy/queue/parked (:279-287), draft (:288), in-flight (:289), settle (:290-291), type-pointer (:293-298).
- Вход unread в хосте: wake-service.ts:623 → unreadLetters(..., {map}) → letter-tables.ts:283-294 (кандидаты + isUnreadFor, letters.ts:37-38). Вызовы deliveryAction: wake-service.ts:1617, 1631, 1717.
- Прочие потребители: wait_for inbox (mcp/tools.ts:1137, 1247) считает settle по ВСЕМ непрочитанным, включая указанные; inbox-watch.ts:98-106 окна не использует (звонит по каждому непозвонённому письму — по коду пробы, не запускал).

## Q16. Номер письма, messageSeq, savepoint

**Номер**: LetterTx.add: top = MAX(seq) по работе (letter-tables.ts:539), seq = max(work.messageSeq ?? 0, top) + 1 (:541), id = `m-` + String(seq).padStart(2,'0') (:543) → m-01, m-99, m-100… Stored seq = letterSeq(id) (insertLetter, letter-tables.ts:400). Номер сравнивается числом: m-07 = m-7 (letter-tables.ts:461-462). Уникальность в БД: PRIMARY KEY (project_path, work_id, seq) (db.ts:67) и UNIQUE INDEX messages_id (db.ts:69). Подтверждено.

**deleteRoom** (letter-tables.ts:656-677): top = MAX(seq) до удаления (:657-659); DELETE messages комнаты (:661-663); removed = 0 → return (:665); before = work.messageSeq; messageSeq = max(before ?? 0, top) (:666-669); undo-закрытие (:670-673); wrote (:675); droppedRooms (:676). Подтверждено.
- Верхний уровень: rooms.ts:427-464 deleteRoom вызывает letters.deleteRoom (rooms.ts:437); в начале ещё work.roomSeq (rooms.ts:431). Значит messageSeq — нижняя граница номеров писем, как поле в types.ts:796-802.

**Персистентность messageSeq — да**: work сериализуется в works.work_json как JSON.stringify(map.work) (work/map-rows.ts:191); запись: UPDATE_WORK_HEAD и UPDATE_WORK пишут work_json (work/store.ts:374-376; быстрый путь store.ts ~1160-1180); чтение: rowsToMap (map-rows.ts:201-213). Значит высокая отметка переживает перезапуск при коммите записи. Не проверено на рантайме.
- Оговорка: replaceLetters (letter-tables.ts:452-456) удаляет все письма без правки messageSeq; в коде, который я читал, messageSeq только повышается (letter-tables.ts:669; letter-store.ts:291 в mapLetterTx). Понижение не найдено.

**Savepoint** (letter-tables.ts:710-736):
- Имя letters_N (:711-712), SAVEPOINT (:716), свой undo-лог (:717).
- Успех: undo.pop (:722), RELEASE (:723); undo-действия дописываются во внешний лог (:725). Поправка к предшественнику: в :725 передаётся undo-лог, а не журнал; журнал — один общий объект, записи в нём остаются (letter-tables.ts:533, 524-527).
- Провал fn: undo.pop (:728); откат лога в обратном порядке (:729) — вернёт messageSeq (закрытие :670-673) и восстановит wrote (:730); журнал обрезается до прежних длин (:731, truncateJournal :504-508); ROLLBACK TO (:732) — откатывает строки комнаты, отметки и кандидатов в БД; RELEASE (:733); throw (:734). Подтверждено.
- deleteRoom вне savepoint: undo.at(-1)?.push (:670) ничего не запишет; LetterTx не откатит messageSeq в памяти. Провал всей записи отбрасывает кэш карты (store.ts: mapCache.delete перед мутацией в быстром пути и в общем пути) и SQLite откатывает БД — по коду, не запускал.

**Возможный дефект (вывод по чтению, не запускал)**: если RELEASE на :723 бросит ошибку, catch (:727-728) сделает undo.pop() второй раз, снимая лог внешней области, и выполнит успешный лог (:729). Срабатывает только при сбое RELEASE.

## Не проверено / ограничения
- Коммит 9eabc014 не сверял.
- Не читал целиком: packages/core/src/work/channel.ts, events.ts, packages/core/src/mcp/inbox-page.ts (не нужны открытым частям); mcp/inbox-watch.ts только 80-120; store.ts только 1100-1275; wake-service.ts только фрагменты; letter-upgrade.ts только начало.
- Рантайм-проверок не делалось (правило: только чтение).

Coverage: covered — по открытым частям Q14, Q15, Q16 (с перечисленными непрочитанными фрагментами, не относящимися к открытым частям).