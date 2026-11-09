# План: ложный Done на острове и в сайдбаре

**Goal:** Done показывается один раз на настоящий конец хода, а идущий ход не выглядит законченным.

**Behaviour:** Сессия Claude с открытым ходом остаётся `working` в окне, на острове, на телефоне, у помощника и в Telegram,
даже если молчит дольше 30 с. Напоминание `idle_prompt` после уже законченного хода не создаёт новый Done и не возвращает
просмотренную сессию в `unseen`. Доставка писем, сон, сжатие и `pty.send` работают как раньше.

## Установленные факты

Воспроизведено на настоящей `activityOf` (проба удалена):

| Сценарий | Результат сейчас |
| --- | --- |
| `UserPromptSubmit`, последняя запись +5 с, сейчас +45 с, ход идёт | `unseen`, `turnEndedAt` = +5 с |
| Та же сессия, новая запись +50 с | `working`, `turnEndedAt` = null |
| `Stop` +10 с, сессию посмотрели | `idle`, `turnEndedAt` = +10 с |
| Затем `idle_prompt` +70 с | `unseen`, `turnEndedAt` = +70 с |

`doneKey` острова содержит `turnEndedAt` (`island/model.ts:114`). Новый `turnEndedAt` означает новую строку Done: `Clear` её не
скрывает, снимок ответа запрашивается снова, остров выдвигается и удержание заводится заново.

Измерения на диске, только чтение, работа `w-0054`:

- Журналы: 3354 `Stop` и 2145 `idle_prompt` сразу после `Stop`. Ещё 4 `idle_prompt` идут сразу после `SessionStart`, 15 — в
  других местах. В строках журнала нет времени, поэтому задержка `idle_prompt` не измерена.
- Транскрипты с 2026-11-02, 72 файла, 2246 ходов: 1099 пауз дольше 30 с внутри хода, в 334 ходах (14,9%). Из них 653 — длинный
  инструмент (медиана 74 с), 446 — ответ модели (медиана 43 с). Максимум в одном ходу — 47, в 127 ходах — 3 и больше.
- Паузы `wait_for` (761) и `Agent`/`Task` (3) исключены. События журнала внутри пауз учесть нельзя, поэтому 1099 — верхняя оценка.

## Решения

1. **Порог тишины в `activityOf` не меняется.** На сырое значение опираются письма (`core/work/delivery.ts:272-277`), пробуждение
   (`wake-service`), сон и сжатие. Сейчас письмо печатается в сессию после 30 с тишины посреди хода; если сделать её честной
   `working` внутри хоста, письмо ждало бы конца хода. Поэтому меняется только показ.
2. **Показ правится на границе хоста.** Хост хранит сырое значение (`live`, `activity.get`, `onChange`) и отдаёт показанное
   клиентам. Окно, остров и телефон получают `activity.changed` и `current()`, поэтому правка в рендерере не нужна. Схема протокола
   не меняется: служебное поле наружу не уходит.
3. **Тишина не считается концом только при открытом ходе.** Открытый ход — фаза `working` перед разбором тишины: `Stop` ещё
   должен прийти. Сессии без хуков и запись лога после `Stop` читаются как раньше.
4. **Предел — 15 минут, отдельная константа `DEFAULT_QUIET_TURN_HOLD_MS`.** Решение человека от 2026-11-09. После него сессия снова
   считается законченной, чтобы не зависнуть в `working`. Из 1126 измеренных пауз дольше 30 с длиннее 15 минут только 8. Предел
   `backgroundHoldMs` (час) остаётся для фоновых субагентов и `wait_for`.
5. **Порядок сайдбара не меняется.** `ATTENTION_RANK` (`unseen` выше `working`) — решение спеки о сортировке. Значок карточки
   уже ставит `working` выше `unseen` (`WorkCard.tsx:92`). Менять порядок может только человек.

## Этап A. `idle_prompt` не сдвигает конец хода

Файл: `packages/core/src/work/activity.ts`.

- Завести `endedInProcess`: `end()` ставит `true`, `SessionStart` с `isLaunchSource` ставит `false` после своего `end()`.
- В ветке `idle_prompt`: `turnBoundaryAt` обновляется как раньше; если `phase === 'ended'`, `endedInProcess` и `turnEndedAt` не
  `null`, вызвать `end` с прежним `turnEndedAt`, иначе — с `event.at`.
- `idle_prompt` после запуска процесса по-прежнему двигает `turnEndedAt`: на этом держится `pointerAfter` в
  `wake-service.ts:1141-1147`. Эту ветку не менять.

Приёмка, тесты в `activity.test.ts`:

1. `Stop` T, `idle_prompt` T+60: `turnEndedAt` = T, `turnBoundaryAt` = T+60; с `seen: true` — `idle`.
2. `UserPromptSubmit`, `idle_prompt` без `Stop`: ход окончен временем `idle_prompt`.
3. `Stop`, `SessionStart` (`resume`), `idle_prompt`: `turnEndedAt` = время `idle_prompt`.
4. `StopFailure`, `idle_prompt`: `turnEndedAt` не меняется, `need` на месте.
5. `Stop` с фоновой задачей, `idle_prompt` с ней же, `SubagentStop`: `turnEndedAt` = время `SubagentStop`.

## Этап B. Тишина открытого хода показывается как `working`

**Core, `packages/core/src/work/activity.ts`:**

- `SessionActivity` получает `quietTurn?: true`: ход открыт, а `unseen`/`idle` выведены только из тишины.
- Перед `if (phase !== 'blocked')` (строка 579) запомнить `const turnOpen = phase === 'working'`. Так учтён и ответ на разрешение.
- В ветке тишины, где ставится `phase = 'ended'` (строка 611), поставить флаг при `turnOpen && now - quietAt <= backgroundHoldMs`.
- `tasks`: `phase === 'ended' && !quietTurn ? [] : tasksOf(started, background)`, иначе счётчик агентов пропадал бы при `working`.
- Поле не выставлять, если `reportedNeed` вернул не `null`.
- Экспортировать чистую `presentedActivity(activity)`. С `quietTurn` она возвращает копию без этого поля, с `activity: 'working'` и
  `turnEndedAt: null`. Без него возвращает тот же объект.

**Host, `packages/host/src/activity/activity-service.ts`:**

- Строка 1320 и `current()` (строка 1818) отдают `presentedActivity(...)`.
- Широковещание идёт, только если изменилось показанное значение. `listeners` по-прежнему вызываются по сырому `sameLive`.
- `scheduleSilenceTimer` (строка 751): выходить, только если сессия не `working` и не `quietTurn`, иначе предел не сработает.
- `live`, `get`, `onChange` остаются сырыми.

**Показ в остальных местах хоста:** `assistant/assistant-service.ts:432` и чтения активности в `telegram/service.ts` (561, 820, 1371)
используют `presentedActivity`. Не трогать: `wake-service`, `delivery`, `auto-sleep`, `compaction`, `pty/send`, `sessions-service`,
`methods/sessions`, `methods/diagnostics`, `feed-service`, `stuck-service`, `agent/tool-context`.

Приёмка, тесты core:

1. Открытый ход, тишина 40 с: сырое `unseen`, `quietTurn: true`; показанное `working`, `turnEndedAt: null`, поля `quietTurn` нет.
2. Новая запись: `working` без флага. Затем `Stop`: `unseen`, флага нет, `turnEndedAt` = `Stop`.
3. Тишина дольше `backgroundHoldMs`: `unseen` без флага.
4. `events: null`, только лог, тишина: `unseen` без флага.
5. `Stop`, новая запись, тишина: `unseen` без флага.
6. `PermissionRequest`, ответ, тишина: флаг есть.
7. `SubagentStart`, тишина: флаг есть, `tasks` содержит агента.

Приёмка, тесты хоста:

8. В момент срабатывания тишины нет широковещания, `get` даёт `unseen`, `current()` даёт `working`.
9. По истечении предела приходит одно широковещание с `unseen`.
10. Письмо по-прежнему доставляется после 30 с тишины посреди хода, как сейчас.
11. Telegram не шлёт «finished» в тишине открытого хода и шлёт его на `Stop`.
12. Помощник называет такую сессию `working`.

## Этап C. Завершение работы исполнителя

- `CHANGELOG.md`, `## Unreleased`, `### Fixed`, на английском: идущая сессия больше не выглядит законченной, напоминание о простое
  не создаёт повторный Done.
- Прогнать и привести вывод: тесты `packages/core`, `packages/host` (activity, wake, telegram, assistant), `packages/remote`,
  `packages/desktop` (`island`, `attention`, `sidebar`), затем `pnpm typecheck` и `pnpm lint`.
- Существующий тест, противоречащий плану, не переписывать: сообщить лиду.
- Не коммитить, не пушить, не запускать настоящих агентов и живой хост.

## Проверка лида

Лид проверяет на отдельной сборке с временным `PARLEY_HOME` и настоящей сессией Claude: длинный `sleep` дольше 30 с показывает
`working` без Done; `Stop` даёт один Done; `idle_prompt` его не повторяет; письмо доходит посреди хода; прерывание `Esc` приводит к
Done через `idle_prompt`.

## Итог проверки лида и этап D

Настоящая сессия Claude Code 2.1.319, `haiku`, сборка этой ветки, временный `PARLEY_HOME`. Подтвердилось: команда на 75 с без
вывода даёт сырое `unseen` и показанное `working`, у острова нет Done до `Stop`, потом одно `✓ 1 Done`; `idle_prompt` не меняет
`turnEndedAt`; письмо в тишине открытого хода доходит сразу.

**Предположение плана о `Esc` не подтвердилось.** После `Esc` не пришли ни `Stop`, ни `idle_prompt` за 150 с наблюдения, и сессия
осталась показанной `working`. По журналам с 2026-11-02 ход ни разу не закрылся через `idle_prompt` (0 случаев на 3683 хода с
`UserPromptSubmit`). Сессия после `Esc` была бы `working` до предела в 60 минут. Это блокирует выпуск.

В логе прерывание видно: запись пользователя `[Request interrupted by user]` или `[Request interrupted by user for tool use]`.
В транскриптах с 2026-11-02 таких ходов 4.

Этап D, файлы `packages/core/src/session-index.ts`, `packages/host/src/activity/log-index.ts`, `packages/core/src/work/activity.ts`:

- `SessionIndex` получает `lastInterruptAt: string | null`: самое позднее время записи `role === 'user'`, чей текст начинается с
  `[Request interrupted by user`. Индекс Codex поле не заполняет. `log-index.ts` передаёт его в лог свёртки.
- `ActivityLog` получает необязательное `lastInterruptAt?: string | null`.
- В `activityOf`: ход прерван, если время прерывания новее `restartAt` и нет записи новее него. Тогда `turnOpen` ложно. Дальше
  сессия идёт прежним путём: `working` до порога тишины, затем настоящий конец хода без `quietTurn`.

Приёмка, тесты:

1. `UserPromptSubmit`, запись прерывания, тишина 40 с: `unseen`, без `quietTurn`; показанное значение тоже `unseen`.
2. То же, но после прерывания новый `UserPromptSubmit`, тишина 40 с: `quietTurn: true`.
3. То же, но после прерывания новая запись работы без нового промпта, тишина 40 с: `quietTurn: true`.
4. `SessionIndex` разбирает обе формы текста и не реагирует на запись пользователя с этой строкой не в начале.
5. Тест `SessionIndex` проходит на настоящем фрагменте транскрипта с записью прерывания, без подмены разбора.

Этап E, предел 15 минут (решение 4), файлы `packages/core/src/work/activity.ts`, `packages/host/src/activity/activity-service.ts`:

- `activity.ts`: экспортировать `DEFAULT_QUIET_TURN_HOLD_MS = 15 * 60 * 1000`, добавить опцию `quietTurnHoldMs` и ставить
  `quietTurn` при `turnOpen && now - quietAt <= quietTurnHoldMs`.
- `activity-service.ts`: опция `quietTurnHoldMs` передаётся в оба вызова `activityOf`. В `scheduleSilenceTimer`:
  `holdAt = quietAt + (activity.quietTurn === true ? quietTurnHoldMs : backgroundHoldMs)`.
- Тесты 3 и 9 этапа B проверяют новый предел; добавить тест: при тишине дольше 15 минут и `backgroundHoldMs` в час флага нет.
- `CHANGELOG.md`: в записи указать, что сессия показывается работающей до 15 минут тишины.

После этапов D и E лид повторяет проверку `Esc` на настоящей сессии: Done появляется примерно через 30 с после прерывания.

**Результат повторной проверки, 7 из 7.** Claude Code 2.1.319, `haiku`, сборка этой ветки, временный `PARLEY_HOME`. Блокер снят: Done
появился через 30 с после `Esc`, без `Stop` и `idle_prompt`. Просмотренная сессия осталась `idle` после `idle_prompt`.

## Вне плана

- Порядок сайдбара и ранг `unseen` (решение 5).
- `idle_prompt` после запуска процесса без хода: 4 случая в журналах, от него зависит `pointerAfter`.
- Codex: у живого терминала порог тишины уже не действует.
