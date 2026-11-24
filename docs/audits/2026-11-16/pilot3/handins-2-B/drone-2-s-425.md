<!-- drone 2 s-425 model=haiku addedAt=2026-11-16T17:40:38.931Z handedAt=2026-11-16T17:42:27.842Z result=done -->
Drone B (s-425), срез plans. Источник: /Users/kalmbik61/parley/pilot3-subject, коммит 9eabc014. Открыты целиком: packages/core/src/work/plans.ts (1200 строк), plan-effects.ts (921), plan-tasks.ts (565), plan-state.ts (281), plan-snapshots.ts (202). Пути относительно корня копии. Тесты не читались.

## Q05. Принятый (не автономный) план в открытой комнате; у части пунктов владелец закрыт — что с пунктами и кто получает письмо

Атомарные утверждения:
- Сверка выполняется в записи карты через `reserve` → `reconcileRoomPlans`: plan-effects.ts:360; определение plans.ts:974-1011.
- Автономные планы пропускаются: plans.ts:981. Комната закрыта → план отменяется целиком: plans.ts:983-988.
- «Владелец жив» = участник комнаты и сессия не `closed`: plans.ts:60-74 (`participant`), plans.ts:91-98 (`liveOwner`).
- Пункт с `done` (сдан, ждёт проверки) не трогается: plans.ts:993.
- Пункт `blocked`, заблокированный версией 0.32.0 при ожидании проверки (последняя запись `system`/`blocked`/`Owner is closed or deleted.`, перед ней `done`), возвращается в `done`: plans.ts:994-1004. Прочие `blocked` не трогаются: plans.ts:1005.
- Любой другой ещё не удовлетворённый пункт (`waiting`, `ready`, `in_progress`, `returned`) получает запись журнала `system` → `blocked` с текстом «Owner is closed or deleted.»: plans.ts:1006-1007, константа plans.ts:972. Удовлетворённые (verified) пропускаются через `planItemSatisfied` (plan-plan-state.ts:10-18, вызов plans.ts:1006).
- Письмо `blocked` адресуется живому лиду: plan-effects.ts:139-142 (target = `liveLead`, текст «Blocked: …»).
- Письма `ready` и `returned` адресуются владельцу; владелец закрыт → `actionable` ложно → письма нет: plan-effects.ts:118-121, 135-138, 144-146, 90-97.
- Письмо `verify` (сданный пункт, verified) адресуется named-проверяющему, а при его недоступности лиду: plan-effects.ts:122-134, цель plan-effects.ts:128-129.
- Если живого лида нет, цель `""`, `actionable` ложно, письма нет: plan-effects.ts:129, 141, 144-146.
- Письма плана ограничены 120 в час на комнату; сверх — очередь `queued`: plan-effects.ts:33, 449, 467-469.
- Для закрытого владельца обязанности по пункту: `blocked` → обязанность лида `resolve-block`: plan-state.ts:86-87, 120-121; сданный verified → владелец `wait` (verification): plan-state.ts:96-100.
- Вид списка заданий скрывает архивные и закрытые комнаты: plan-tasks.ts:209-228 (`visiblePlans`).

Ответ: отвечено. Статус → действие: waiting/ready/in_progress/returned → `blocked` + системная запись, письмо лиду; blocked (маркер 0.32.0 и done до него) → `done`; done → без изменений, письмо проверяющему (или лиду, если проверяющий недоступен); blocked прочий → без изменений. Письмо владельцу не уходит никогда (он закрыт). Открыто: кто и когда вызывает `reservePlanEffects` на каждой записи (store.ts не читался) и что такое `liveLead` (rooms.ts не читался).

## Q06. Verified-пункт сдан, именованный проверяющий недоступен — когда недоступен, кто действует, что если и владелец, примет ли verify

Атомарные утверждения:
- Недоступность: `verifier !== null && !participant(...)`: plans.ts:76-82. `participant`: HUMAN всегда доступен; иначе участник комнаты и сессия есть в карте и `lifecycle !== "closed"`: plans.ts:60-74. То есть недоступен, если сессия закрыта или не в комнате.
- Недоступность вычисляется при каждом расчёте (письма, обязанности, список заданий): plan-effects.ts:128; plan-state.ts:101-106 (параметр `verifierUnavailable`); plan-tasks.ts:253-257.
- Письмо с недоступным проверяющим: цель — живой лид (`liveLead`), текст «The named verifier is unavailable… if you own this item, propose an amended plan with another verifier.»: plan-effects.ts:128-134.
- Обязанности: при `done` и недоступном проверяющем с живым лидом; если лид не владелец — обязанность `verify` у лида; если лид — владелец — обязанность `resolve-block` у лида: plan-state.ts:101-111. Владелец получает `wait`, `verification`, `by: item.verifier`: plan-state.ts:96-100. Без живого лида обязанностей у проверяющего нет: plan-state.ts:101-106 (ветка уходит, `liveLeadId === null` не даёт обязанностей).
- Владелец, он же лид, письмо получает (цель — лид), но проверить не может: plan-effects.ts:129; plans.ts:768-771 (`actor === item.owner` отказывает).
- Приём verify: `verifyPlanItem`, plans.ts:741-823. Требуется: режим verified, план active, пункт `done` (plans.ts:761-765). Далее: HUMAN проходит всегда (plans.ts:768 условие с `actor !== HUMAN`). Не-HUMAN принимается, если: актор — именованный проверяющий; либо актор — живой лид, проверяющий недоступен, и актор не владелец (plans.ts:768-779). Иначе `RoomRuleError`.
- Лид, который не владелец и не проверяющий, при недоступном проверяющем — принимается: plans.ts:772-775.
- Проверка проходит через `mutablePlan`, то есть актор должен быть живым участником: plans.ts:531-540.
- Владелец-лид не может проверить свой пункт, даже как лид: plans.ts:768-771 (комментарий plans.ts:767).
- Позиция проверяющего сбрасывается при вердикте: plans.ts:783, `dropVerifierCheckpoint` plans.ts:567-571.
- При принятии поправки проверяющим назначается лид по умолчанию: plans.ts:176; если лид — владелец и он единственный живой участник, проверяющим становится человек: plans.ts:177-184.

Ответ: отвечено. Недоступен = сессия закрыта или не участник комнаты. Действует живой лид (письмо и обязанность `verify`). Если лид владелец — письмо и обязанность `resolve-block`, проверить он не может, нужна поправка с другим проверяющим. Проверку принимает человек всегда и лид, не владелец, при недоступности. Если живого лида нет — никто не назначен, письма и обязанности нет, проверить может только человек. Открыто: точное определение `liveLead` (rooms.ts не читался).

## Q07. Markdown-снимки плана: идентичность, повторный захват, подтверждение записи, удаление записи

Атомарные утверждения:
- Имя файла: `${work.id}-${roomId}-${plan.id}-rev-${rev}-${event}.md`: plan-snapshots.ts:47. Событие — `accepted | completed | cancelled`: plan-snapshots.ts:23-27, 44.
- Запись экспорта (`PlanExportIntent`): `file`, `planId`, `rev`, `event`, `content`, `status: "pending"`: plan-snapshots.ts:105-112. Ключ идентичности — `file`: plan-snapshots.ts:115.
- Ограничения: текст ≤1 МБ: plan-snapshots.ts:33; до 30 000 записей: plans.ts:1106.
- Точки захвата: принятие (plans.ts:514-521), завершение при checklist (plans.ts:452), завершение verified (plans.ts:1039), отмена (plans.ts:851), смена режима на free (plans.ts:943), отмена при закрытии комнаты (plans.ts:987).
- Повторный захват того же файла с тем же текстом: возвращается прежняя запись, новой не создаётся: plan-snapshots.ts:115-121 (сравнение sha256, plan-snapshots.ts:118).
- Повторный захват того же файла с другим текстом: `PlanSnapshotError("snapshot-conflict")`: plan-snapshots.ts:118-119.
- Последствие для изменения плана, вызвавшего захват: исключение выходит из тела `edit`; `edit` копирует черновик обратно только после успешного тела (plans.ts:112-125). Изменение плана не применяется. Для записи с письмами откат делает `savepoint` (plans.ts:120). Это вывод из кода, не запускал.
- Подтверждение записи: `flushPlanSnapshots` вызывается после `updateMap` (plan-snapshots.ts:131-133). Для каждого `pending` (plan-snapshots.ts:145-147) проверяется префикс имени (plan-snapshots.ts:153-154), файл пишется под блокировкой общего хранилища через `publishImmutableMarkdown` (plan-snapshots.ts:155-171). Ошибки маппятся в `snapshot-conflict | snapshot-invalid | snapshot-write-failed` (plan-snapshots.ts:162-167).
- Ack: отдельный `updateMap` (touch:false) вызывает `settleExport` только для записи с тем же файлом и тем же sha256 текста (plan-snapshots.ts:172-186). Файл считается записанным (plan-snapshots.ts:187). При сбое intent остаётся `pending`, повтор сравнивает точный текст (plan-snapshots.ts:131-133, 188-196).
- Сбои снимков возвращаются вызывающему (`snapshotFailures`), в карту не пишутся: plan-effects.ts:898-919. Сводка считает `pendingSnapshots`: plan-effects.ts:872-874.
- Удаление записи: `prune` (plan-effects.ts:325-345), вызывается из `reserve` (plan-effects.ts:411, 413 — с `all=true` при переполнении). Записи `written` удаляются, если завершающая дата плана (`completedAt ?? cancelledAt`, plan-effects.ts:327-332) раньше срока 7 дней (plan-effects.ts:27, 326, 337-340). С `all=true` возраст не важен: plan-effects.ts:337-340. Записи `pending` не удаляются: plan-effects.ts:339.
- Запись без найденной даты завершения (`ended === null`) не удаляется: plan-effects.ts:339. План ищется по паре (id, rev): plan-effects.ts:328. Хранится один план на id, при поправке он заменяется (plans.ts:509), поэтому снимок прежней ревизии не находит пару — вывод из кода, такой снимок не удаляется.

Ответ: отвечено по срезу. Открыто: тело `publishImmutableMarkdown` (shared-markdown.ts) и `settleExport`/`exportSha256` (stored-texts.ts) не открывались; поведение повтора уже записанного файла с тем же текстом и вывод «в ack записи текст сохраняется» не проверены. Кто вызывает `flushPlanEffects` — не проверено (store/route вне среза).

## Q08. Поправка активного плана принята — какие пункты сохраняют прогресс, что сохраняется у начатого заново пункта, как checklist-пункт считается сделанным после повышения до verified

Атомарные утверждения:
- Приём: `acceptRoomPlan`, plans.ts:457-524. Тот же id, rev = прежний + 1: plans.ts:469-474. Режим комнаты должен совпасть: plans.ts:465.
- Что «изменилось»: `amendmentChanges`, plan-state.ts:146-183. Сравниваемые поля (`semantics`): title, owner, scope, after, criteria, verifier — plan-state.ts:126-134, сравнение plan-state.ts:170-171. Новые пункты в `changed`: plan-state.ts:170-171 (`!previous`).
- Транзитивная зависимость: пункт, зависящий по `after` от изменённого, тоже `changed`: plan-state.ts:173-181.
- Исключение повышения checklist → verified: `promotionExempt` при: прежний план checklist, новый verified, `existing.acceptedAt !== null`, прежний пункт `done`, одинаковые title/owner/scope/after (`sameCore`): plan-state.ts:155-169.
- Неизменённый пункт сохраняет: status, evidence, note, log, progress, submissions: plans.ts:480-488, 489-490 (submissions). Для exempt — `acceptedChecklistRevision = existing.rev`: plans.ts:491-492; иначе — прежнее значение: plans.ts:493-494.
- Изменённый существующий пункт: submissions сохраняются (plans.ts:496-497); журнал = прежний журнал + запись `{by: HUMAN, status: "waiting", note: "Assignment changed; previous evidence invalidated."}`: plans.ts:498-506. Сам пункт берётся из `validateDraft` с пустыми evidence, note, log и без progress и acceptedChecklistRevision: plans.ts:198-210, 475. Итоговый статус — `ready` или `waiting` по зависимостям: plans.ts:511-513, plan-state.ts:21-26.
- Новый пункт: без журнальной записи о смене, статус по зависимостям: plans.ts:510 (новый план), 511-513.
- Пункты, убранные поправкой, попадают в снимок «accepted» как `removedItems`: plans.ts:514-521; в снимке выводятся отдельным разделом: plan-snapshots.ts:60-64.
- Сделанный checklist-пункт после повышения: `acceptedChecklistRevision` выставлен на `existing.rev`, а `planItemSatisfied` в verified требует `status === "done"` и `acceptedChecklistRevision ∈ [0, plan.rev)`: plan-state.ts:10-18; проверка при загрузке: plans.ts:1158-1165. Без сверки: в снимке пишется «no verification claimed»: plan-snapshots.ts:79-83.
- Исключение действует и при смене критериев/проверяющего, потому что `sameCore` их не сравнивает: plan-state.ts:155-161.
- Сброс исключения: смена режима verified → checklist обнуляет `acceptedChecklistRevision`: plans.ts:955.
- Граничный случай (выведен чтением, не запускался): `promotionExempt`-пункт не исключается из транзитивного замыкания (plan-state.ts:176 проверяет только `changed`). Если его зависимость изменилась, пункт попадает в `changed`. Тогда он идёт по ветке изменённого (plans.ts:495-507) и теряет `done` и `acceptedChecklistRevision`, то есть не считается сделанным без проверки.
- `planRemaining` (карточка до принятия) повторяет то же правило: plan-state.ts:209-281, в частности exempt и `acceptedChecklistRevision`: plan-state.ts:240-244.

Ответ: отвечено (с граничным случаем, выведенным по коду). Открыто: граничный случай не воспроизведён запуском.

Coverage: partial — не открыты shared-markdown.ts, stored-texts.ts (settleExport, exportSha256, hasDigestOnly, sha256Hex), rooms.ts (liveLead, isMember, isRoomClosed, isRoomArchived), store.ts (updateMap, readMap, reservePlanEffects callers), letter-store.ts; тесты вне области. Прямо нет в срезе: кто вызывает reconcile и flush, и точное определение «живого лида».

Not verified: поведение при реальном запуске (ничего не запускалось); граничный случай Q08 с зависимостью exempt-пункта; повтор записи уже записанного файла на диске.