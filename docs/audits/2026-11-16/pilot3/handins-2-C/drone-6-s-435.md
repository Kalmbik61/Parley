<!-- drone 6 s-435 model=haiku addedAt=2026-11-16T17:49:31.545Z handedAt=2026-11-16T17:52:23.152Z result=done -->
Q05 и Q07, срез `9eabc014` (`/Users/kalmbik61/parley/pilot3-subject`). Все пути относительно корня копии. Прочитаны целиком: packages/core/src/work/{plans,plan-effects,plan-snapshots,stored-texts,shared-markdown,plan-state,rooms}.ts; store.ts 1–1349 и 1518–1545; packages/host/src/rooms/plan-effects.ts; packages/core/src/mcp/plan-tools.ts (точки вызова).

## Q05 — закрытый владелец в принятом плане

**Trigger path (открытая часть). Поправка к предшественнику: reconcile НЕ внутри каждой записи карты.**
- `store.ts:1034` `updateMap` → `:1120` `applyMapUpdate` → `mutate(current, letters)` `:1219`. В store.ts нет ни `reservePlanEffects`, ни `reconcileRoomPlans` (grep по packages: вызовов в store.ts нет).
- Реальные вызывающие:
  1. MCP-инструменты плана: `mcp/plan-tools.ts:511–522` — `updateMap` и первым действием `reconcileRoomPlans(map)` (`:522`); в конце мутации `reservePlanEffects(map, letters)` (`:707`).
  2. Хост, записи комнат/планов: `host/src/methods/rooms.ts:125` (`reconcileRoomPlans`) и `:177` (`reservePlanEffects`) внутри `updateMap` (`:120–179`).
  3. Ответ на решение: `host/src/rooms/rooms-service.ts:251` `reservePlanEffects` внутри `updateMap`.
  4. Драйвер эффектов `host/src/rooms/plan-effects.ts`: `scan` (по `works.onChange`, версия работы) → `flush` → `process`: `:189` пробный `reservePlanEffects` на копии, при `changed` — отдельный `io.updateMap` с `reservePlanEffects` `:197`; затем `io.flush` (`:~235`).
- Закрытие сессии само по себе: в `host.ts` не прослеживал. Чистого пути «закрытие → reconcile в той же транзакции» в коде нет: reconcile для закрытого владельца идёт либо через явные записи (п. 1–3), либо асинхронно через драйвер (п. 4) после коммита.
- Внутри `reserve` порядок: `reconcileRoomPlans` `plan-effects.ts:360`, сигнатура `:291`. Подтверждено.

**Per-status (после reconcile), `plans.ts`:**
- Владелец «не живой» = не участник комнаты, сессия отсутствует в карте или закрыта: `liveOwner` `:91–98`, `participant` `:60–74`. Пункты живых владельцев пропускаются `:991`.
- Комната без живых участников (`isRoomClosed`, `rooms.ts:116–118`) и не автономный план → план `cancelled`, `proposal=null`, снимок `cancelled`, без строки в ленту `:983–988`.
- `done` → без изменений, ждёт проверяющего `:993`.
- `blocked` → без изменений `:994–1005`. Легаси: если последняя запись журнала — `system blocked` с «Owner is closed or deleted.» и предыдущая — `done`, пункт возвращается в `done` `:996–1003`.
- Удовлетворённые (`verified`; checklist `done`; `done` с `acceptedChecklistRevision < rev`, `plan-state.ts:10–18`) → без изменений `:1006` (ветка не достигается).
- `waiting`, `ready`, `in_progress`, `returned` → `blocked`, note «Owner is closed or deleted.», журнал от `system` `:1006–1007`, `log` `:419–430` (сбрасывает `acceptedChecklistRevision` `:428`).
- В комнату строка ленты при reconcile не пишется (`plans.ts:974–1011` без `addSystemMessage`). Человек не получает ничего, кроме состояния пункта.

**Письма (`plan-effects.ts`):**
- `blocked` (любой) → получатель `liveLead(map, room)` `:139–142`; письмо только если `actionable` `:144–146`, `:90–97` (работа активна, комната не закрыта, цель — участник и не закрыта). Нет живого ведущего → письма нет.
- `done` при непроверенном пункте (verified) → проверяющему, а если он недоступен — ведущему `:127–134`.
- Бывшее письмо `ready` для ставшего `blocked` пункта: эффект становится не текущим и отменяется, отправленное — `letters.effectCancelled` `:439–447`.
- Бюджет `PLAN_LETTERS_PER_HOUR = 120` на комнату, `:33`, проверка `:449`; сверх бюджета эффект остаётся `queued`.

**Подтверждено из предшественника:** `:974–1011` (reconcile), `:291–296`/`:360`, владелец `:91–98`/`:60–74`, `:991`, `:993`, `:994–1005`, `:1006–1007`, `:419–430`, закрытая комната `:983–988`, письма `:139–146`, `:127–134`, `:90–97`, бюджет `:33`/`:449`.
**Поправлено:** «внутри каждой записи карты» — неверно (см. выше). Письмо получает `liveLead`, а не владелец; для `done` — проверяющий, не ведущий, если он доступен.

## Q07 — Markdown-снимки

**(a) Конфликт при повторном снимке.**
- Идентичность: имя `${work.id}-${roomId}-${plan.id}-rev-${rev}-${event}.md` `plan-snapshots.ts:47`; event ∈ accepted|completed|cancelled `:44`; проверка regex/префикса `:22–34`, `:153–154`; тот же regex в `plan-effects.ts:1191`.
- `capturePlanSnapshot` `plan-snapshots.ts:41–124`: если в `planExports` уже есть файл с тем же именем — сравнивает `exportSha256(previous)` с `sha256Hex(content)` (`:115–118`, `stored-texts.ts:34`). Совпало → возвращает прежний intent, изменение плана идёт дальше `:120`. Не совпало → `PlanSnapshotError("snapshot-conflict")` `:118–119`.
- Вызовы: `plans.ts:452, 514, 851, 943, 987, 1039`. Все внутри `edit` или `mutate`.
- `edit` `plans.ts:112–126`: при исключении тела назначения `map.*` не выполняются (`:120–125` после `body`), letters откатываются через `savepoint`. Далее `applyMapUpdate`: исключение из `mutate` `store.ts:1219` → `writeTransaction` `:300–311` делает `ROLLBACK`; `retryLocked` пробрасывает не `LockNotTakenError` `:340`. Итог: **изменение плана отклоняется целиком, без частичной записи**.
- Наружу: `mcp/plan-tools.ts` ловит только `PlanConflictError`, `ProposalConflictError`, `RoomRuleError`, `PageError`; `PlanSnapshotError` попадает в общее «Plan operation could not be completed.» (`plan-tools.ts:~719–732`). Путь хоста (`asHostError`) не прочитан — **открыто**.
- Конфликт на уровне файла (другой текст в `.md`): `shared-markdown.ts:93–95` (уже есть файл, текст отличается → `conflict`), `:121–125` (EEXIST при `link`), маппинг `plan-snapshots.ts:163–165` → `snapshot-conflict`. Здесь план не отклоняется; intent остаётся `pending`, драйвер исключает файл из повторов `host/.../plan-effects.ts` (`excludedSnapshotFiles`).
- Ни в одном прочитанном пути не нашёл, как одинаковые (work, room, plan, rev, event) получают разный текст — ветка `snapshot-conflict` выглядит защитной. **Не воспроизведено и не проверено.**

**(b) Подтверждение записи.**
- `flushPlanSnapshots` `plan-snapshots.ts:134–202`: `readMap` `:139`; pending без `excludedFiles` `:145–147`; `sharedProjectPaths` `:152`; `withSharedProjectLock` `:155–171` (`store.ts:1518–1527`: `acquireLock` с таймаутом, при таймауте `SharedStateError('backlog-lock-timeout')` → не PlanSnapshotError → `snapshot-write-failed`), внутри `prepareSharedIgnore` и `publishImmutableMarkdown` `:162`.
- Публикация: временный `.plan-<uuid>.tmp` `shared-markdown.ts:43`, `link` `:121`, `unlink` в `finally` `:132–141`. Существующий идентичный файл — успех `:93–95`.
- Ack: `updateMap(..., {touch:false})` `plan-snapshots.ts:174–186`: совпадение файла и `sha256` → `settleExport` (`stored-texts.ts:49–57`: `sha256`, `bytes`, `title`, удаление `content`, `status=written`). Ошибка → `failed` (`:188–196`), intent остаётся `pending`; повтор сравнивает исходный текст.
- Вызывается после `updateMap`: `flushPlanEffects` `plan-effects.ts:888–921` (`:903–909`). Вызывающие: `mcp/plan-tools.ts:432–436` (`finish`, после `updateMap` и `:716`); драйвер `host/src/rooms/plan-effects.ts` (`io.flush` после своего `updateMap`; ручной `flush` с `manual=true`).

**Удаление записи (prune):** `plan-effects.ts:325–345`, вызов `:411`, при переполнении `:412–418` с `all=true`. Pending не удаляются (`:339`). Written удаляются, если `ended` (`completedAt ?? cancelledAt`) старше 7 дней `PLAN_EFFECTS_KEEP_MS` `:27`, `:339`.
- **Поправка:** `endedAt` ищет план по `id` **и** `rev` (`:327–329`). Поправка плана заменяет его на rev+1 (`plans.ts:509`, `:357`), поэтому снимки прежних ревизий не находят план → `ended=null` → **хранятся без срока**. Так же для планов, удалённых `deleteRoom` (`rooms.ts:438`, `planExports` не трогаются `:435–442`).
- **Поправка:** переполнение (`overLimit`, `:405–410`) считает только `planEffects` и `planBacklogIntents`, не `planExports`. Лимиты `EFFECT_LIMIT`/`EFFECT_BYTES` (`:24–25`) к экспортам не относятся. Экспорты пишутся в `validatePlanStorage` с лимитом 30 000 (`plans.ts:1105–1106`).

## Сверка с предшественником
Подтверждено: `plan-snapshots.ts:47`, `:44`, `:115–121`, `stored-texts.ts:34`, `:118–119`, `plans.ts:120–125`, `:134–202`, `:131`, `:145–147`, `:155–171`, `shared-markdown.ts:93–95`, `:13–146`, `:174–186`, `stored-texts.ts:49–57`, `:188–196`, `plan-effects.ts:325–345`, `:27`, `:326`, `:339`, `:411–418`, `:24–25`, `rooms.ts:418–420`, `:438–442`, `plan-effects.ts:888–921`.
Поправлено: reconcile не внутри каждой записи; overflow не касается экспортов; written-экспорты прежних ревизий и удалённых комнат не удаляются по сроку.

Coverage: partial — open: (1) путь закрытия сессии в `host.ts` и момент `works.onChange` (`works-service.ts:143, 148`) — прочитаны только комментарии; (2) `asHostError` и маппинг `PlanSnapshotError` в хостовых методах (`methods/rooms.ts`) — не прочитаны; (3) поведение конфликта повторного снимка «другим текстом» — путь воспроизведения в коде не найден, не проверено; (4) `store.ts:1349–1571` кроме 1518–1545 не прочитаны (`readSharedFile`, `sharedProjectPaths`, `prepareSharedIgnore`).