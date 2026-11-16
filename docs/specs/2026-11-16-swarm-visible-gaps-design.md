# Рой: видимые дыры (имя среза, поле покрытия, письмо конца волны)

Дата: 2026-11-16. Автор: s-396 по согласию человека в чате s-396. Критик: s-398 (Codex gpt-6-astra), позиция m-8337. Код читался на `origin/master` `9eabc014`; ссылки `путь:строка` — на него. Рабочая папка проекта стоит на старом `f7978af8`, там кода роя нет.

## 1. Цель и границы

Сейчас никто, кроме королевы, не видит, какой срез трутень закрыл не полностью: покрытие — строчка свободного текста в сдаче. Письмо хоста в конце волны при этом велит королеве писать сводку.

После изменения хост знает имя среза и самооценку покрытия каждого участника, перечисляет незакрытое в письме королеве, в итоге создателю и в окне. Решение, что делать с дырой, остаётся за королевой.

Это только наблюдаемость. Спека не обещает, что ответы роя станут лучше, и не вводит замену трутней. Пользу повторной попытки проверяет отдельный замер: `docs/audits/2026-11-16/swarm-pilot-3-protocol.md`.

## 2. Как сейчас

- Участник роя хранит `sessionId`, `role`, `n`, `addedAt`, `handedAt` (`packages/core/src/work/swarms.ts:26`). Среза и покрытия в записи нет.
- `swarm_add` принимает `role`, `task`, `provider`, `label`, `agentRole`, `model`, `effort` (`packages/core/src/mcp/swarm-tools.ts:27`, `packages/host/src/agent/swarm-endpoint.ts:52`).
- `report` принимает `status`, `summary`, `artifacts`, `backlog` (`packages/core/src/mcp/tools.ts:489`, обработчик `:872`). Сдача участника — `result === 'done'`, хост ставит `handedAt` (`packages/host/src/swarms/swarms-service.ts:227`). Сдача с текстом «partial» неотличима от полной.
- Когда все участники выбыли, рой переходит в `collecting`, королеве уходит письмо «All members … have handed in. Write the summary…» или «… N of M did not hand in … Write the summary…» (`swarms-service.ts:256`).
- `swarm_add` в `collecting` возвращает рой в `running` (`packages/host/src/swarms/spawn.ts:143`), то есть вторая волна уже возможна.
- Итог создателю: `Swarm sw-NN [Tag] done, N/M handed in, time` (`swarms-service.ts:169`).
- Окно: строка участника показывает «Drone 2» и слово состояния (`packages/desktop/src/renderer/sidebar/SwarmRow.tsx:167`, `packages/desktop/src/renderer/lib/swarm-view.ts:75`).

## 3. Что меняется

### 3.1 Данные (`packages/core/src/work/swarms.ts`)

```ts
export const SWARM_COVERAGES = ['covered', 'partial'] as const;
export type SwarmCoverage = (typeof SWARM_COVERAGES)[number];
export const SWARM_SLICE_MAX = 60;

interface WorkSwarmMember {
  // …прежние поля
  /** Имя среза из `swarm_add`; `null` — не дано. У королевы всегда `null`. */
  slice?: string | null;
  /** Самооценка покрытия из `report done` участника; `null` — не указана. */
  coverage?: SwarmCoverage | null;
}

interface WorkSwarm {
  // …прежние поля
  /** Сколько записей `members` (с начала массива, королева включена) уже вошло в письма конца волны; 0 — писем не было. */
  announced?: number;
}
```

Поля необязательные в типе, чтобы прежние записи и фикстуры оставались верными. Нормализация карты (`packages/core/src/work/map.ts:746`) приводит их к значению:

- `slice` — по правилу `isSwarmSlice`, значение хранится без пробелов по краям; иначе `null`. У королевы всегда `null`.
- `coverage` — одно из двух значений, иначе `null`. У королевы всегда `null`.
- `announced` — целое от 0 до `members.length`, иначе 0.

Версия схемы карты не меняется. Строгих проверок записи участника в путях карты нет (`map.ts:742` смотрит базовую форму и роль), поэтому новые поля переживают запись и повторное чтение.

`isSwarmSlice(value)` — рядом с `isSwarmTag`, по тому же образцу: строка без `\r` и `\n` в любом месте, включая края (проверка идёт по исходной строке, до `trim`); после `trim` не пустая и не длиннее `SWARM_SLICE_MAX`. Эндпойнт и нормализация применяют одно и то же правило и один и тот же `trim`.

Граница волны — счётчик, а не время: массив `members` только растёт (удалённый участник остаётся записью, спека роя v1, 2), а сравнение `addedAt` ломается на одинаковой миллисекунде и на откате часов. Новые функции, константы и типы добавляются в явный список экспортов `packages/core/src/index.ts`.

### 3.2 Исход участника (чистая функция в `swarms.ts`)

```ts
export type SwarmMemberOutcome = 'covered' | 'partial' | 'unstated' | 'failed' | 'missing' | 'open';
export function memberOutcome(member: WorkSwarmMember, session: SessionAxes | undefined): SwarmMemberOutcome;
```

- `handedAt !== null`: `coverage === 'covered'` → `covered`; `'partial'` → `partial`; иначе → `unstated`.
- `handedAt === null`: `session?.result === 'failed'` → `failed`; сессии нет или она закрыта → `missing`; иначе → `open` (ещё работает или ждёт).

`unstated` не приравнивается к `covered`: сдача без поля покрытия — неизвестное покрытие. `memberState` не меняется.

Участник, который заснул без итога, остаётся `open`: функция не знает порога молчания хоста (`DRONE_SILENT_MS`, `swarms-service.ts:100`). Письмо конца волны пишется только когда все участники выбыли, поэтому в нём `open` печатается как `did not hand in` (3.5). Порог и жизненный цикл не меняются; участник в `pending` по-прежнему не даёт волне закончиться.

### 3.3 `swarm_add`: параметр `slice`

- Схема (`swarm-tools.ts`): `slice: { type: 'string', minLength: 1, maxLength: 60, description: 'Short slice name; shown to the human and in the wave letter.' }`. Необязательный.
- Эндпойнт (`swarm-endpoint.ts`): ключ `slice` разрешён только для `op: 'add'`; проверка `isSwarmSlice`, иначе ошибка `slice must be 1-60 characters without line breaks.`; значение сохраняется без пробелов по краям.
- `SwarmSpawn` вида `add` получает `slice: string | null`; `admitSwarmSession` пишет его в запись участника вместе с `coverage: null` (`spawn.ts:141`).
- Потолки размера инструментов роя (`packages/core/src/mcp/tools-size.test.ts`, `SWARM_*_MAX_BYTES`) поднимаются ровно на добавленные байты, с комментарием по образцу соседних.

Параметр необязательный: королева со старым текстом скилла продолжает работать, участник без среза показывается без имени.

### 3.4 `report`: параметр `coverage`

- Схема (`tools.ts:489`): `coverage: { type: 'string', enum: ['covered', 'partial'], description: 'Swarm members only: covered if the whole slice is read and its questions answered, else partial.' }`. Необязательный. Общие потолки `DESCRIPTIONS_MAX_BYTES` и `SCHEMAS_MAX_BYTES` поднимаются ровно на добавленные байты, с комментарием.
- Обработчик (`tools.ts:872`): значение вне перечисления — ошибка аргумента, как у `status`, до любой записи. В той же записи карты, что пишет `summary`, после проверки «сессия закрыта»: если поле передано, `status === 'done'` и сессия — участник роя не в роли королевы, то `member.coverage = coverage`. Во всех остальных случаях запись участника не меняется: поле не передано, не участник роя, королева, `progress`, `failed`.
- Повторный `report done` до закрытия разрешён и сейчас. Семантика: переданное поле заменяет прежнее (последняя самооценка), сдача без поля прежнее не стирает. Гонки параллельных `report` спека не чинит.
- Порядок важен: покрытие записано до смены `result` — `finishSession` ставит его отдельной записью позже (`tools.ts:885`, `:912`). Хост, увидев `result === 'done'`, уже видит и покрытие; пока `result` пуст, участник сдавшим не считается.
- Закрытая сессия и ошибочный аргумент не меняют ни `summary`, ни `coverage`.
- Ответ инструмента не меняется.

Поле не обязательное и сдачу без него хост принимает: отказ добавил бы новый способ не сдать. Такая сдача видна как `unstated`.

### 3.5 Письмо конца волны (хост)

Условие перехода `running → collecting` не меняется (`swarms-service.ts:256`). Меняется текст письма королеве и добавляется запись `announced`.

**Волна** — трутни и проверяющие среди `members.slice(swarm.announced ?? 0)`. В той же записи карты, что переводит рой в `collecting` и кладёт письмо, хост ставит `swarm.announced = swarm.members.length`. Повторная сверка второго письма не пишет, как и сейчас: рой уже в `collecting`. Перезапуск хоста до записи повторяет переход целиком, после записи — ничего не делает.

Рой, который обновление застало в `collecting` без поля, получает `announced = 0`: письмо о его текущей волне уже ушло старым текстом, а следующая волна перечислит всех участников. Это разовое следствие обновления.

Исход `open` в письме печатается как `did not hand in` и считается вместе с `missing` (3.2).

Текст строит чистая функция рядом с брифами (`packages/host/src/swarms/briefs.ts`). Строки по порядку:

1. Заголовок. Все участники волны `covered`:
   `Wave finished in swarm sw-03: all 4 members handed in and declared full coverage.`
   Иначе счёт по исходам, только ненулевые, в порядке covered, partial, coverage not stated, reported failure, did not hand in:
   `Wave finished in swarm sw-03: 6 members — 3 covered, 2 partial, 1 did not hand in.`
2. Если есть участники волны с исходом не `covered` — блок:
   ```
   Not closed:
   - Drone 2 (s-412) "host/sessions": partial
   - Drone 5 (s-415): coverage not stated
   - Drone 6 (s-416) "mobile": did not hand in
   ```
   Имя — `memberName(role, n)`; срез в кавычках, если он есть; слова исходов: `partial`, `coverage not stated`, `reported failure`, `did not hand in`.
3. Если в прежних волнах есть участники с исходом не `covered`:
   `Earlier waves: 2 members not closed; your register says which of those gaps are closed since.`
4. Остаток, если лимиты прочитаны:
   `Left: 9 of 16 swarm sessions, 71 min.`
   Сессии: `swarmSessions − members.length`, не меньше нуля. Минуты: до срока жизни, округление вверх; при `swarmMinutes = 0` — `no time limit`. Лимиты не прочитаны — строки нет.
5. Всегда:
   `Coverage is the member's own estimate. Check the hand-ins against the objective, then either add members with swarm_add (a drone for a gap, verifiers for the claims) or call report with the combined result and name what stays uncovered.`

Единственное число: при одном участнике пишется `1 member`, а не `1 members` — `Wave finished in swarm sw-03: 1 member handed in and declared full coverage.`, `Wave finished in swarm sw-03: 1 member — 1 partial.`, `Earlier waves: 1 member not closed; …`. Других склонений нет.

Письмо о сроке жизни и остальные переходы не меняются. `reconcileSwarm` получает лимиты с `swarmSessions` (сейчас только `swarmMinutes`).

### 3.6 Итог создателю

Заголовок итога (`deliveryText`, `swarms-service.ts:169`) называет частичные сдачи, если они есть: `Swarm sw-03 [Audit] done, 5/6 handed in (2 declared partial), 4:12`. Считаются все участники роя с исходом `partial`. При нуле текст прежний. Так создатель роя и человек видят частичное покрытие, даже если королева о нём умолчала.

Число — история самооценок участников, а не остаток дыр: продолжатель мог закрыть пробел. Поэтому слово `declared`.

### 3.7 Брифы и скилл

`queenBrief` (`briefs.ts:17`):

- строка про участников: `Add members with \`swarm_add\` (role "drone" with a slice task and a short \`slice\` name, later role "verifier" to recheck the key claims); the slice task must be self-contained. You cannot create other sessions or another swarm.`
- строка про ожидание: `Wait with \`wait_for\` on a member id or "inbox". Wait for the Parley letter that the wave has finished before you write the final summary: it lists the members that handed in partial coverage or did not hand in, and what is left of the swarm's sessions and time. An early \`report done\` closes the swarm and its still-working members. Read a member's result with \`get_map {session, field: "summary"}\`.`
- строка про дыры: `Members close themselves when they hand in. For a gap worth the time, add one drone for that gap with a narrower task and the predecessor's hand-in, or cover it yourself; otherwise name the gap in the summary.`

`memberBrief` (`briefs.ts:35`), последняя строка правил:
`Hand in with \`report\`: status done and \`coverage\` — "covered" if you read the whole slice and answered its questions, otherwise "partial". In the summary give facts with sources (\`path:line\` or url) and say what is left unread. If you could not do the task at all, report failed. After that you are closed.`

Скилл `research-swarm` (`packages/core/src/work/research-swarm-skill.ts`) приводится в соответствие: параметр `slice` в разделе «Drone task»; шаблон сдачи требует `coverage` в `report` и оставляет в тексте `COVERAGE: what you read`; раздел «Collecting hand-ins» описывает письмо конца волны; раздел «Summary» цитирует новый текст письма вместо «All members … have handed in»; формат итога создателю в разделе «Starting a swarm» — с `(K declared partial)`. Предел в 220 строк остаётся. Старый текст письма роя в агентских текстах, руководстве и тестах ищется поиском по `have handed in` и приводится к новому; правятся только письма и тексты роя, чужие формулировки с теми же словами не трогаются.

### 3.8 Окно (`packages/desktop`)

- Раскрытая строка участника: `Drone 2 · host/sessions`, срез обрезается многоточием, полное имя в `title`. `aria-label`: `Drone 2, host/sessions: partial`.
- Слово состояния: сдавший с покрытием `partial` — `partial` (новая строка `S.workSwarm.member.partial`). Остальные слова прежние, в том числе `handed in ✓` для `covered` и `unstated`.
- Точки свёрнутой строки: новое значение `partial` (`data-dot="partial"`), видимо отличное и от сдавшей, и от открытой; цвета — из уже существующих токенов сайдбара.
- Маркер в строке участника для `partial` тоже отличается от сдавшего.
- Счётчик `3/5` и значок роя не меняются: частичная сдача — сдача.

### 3.9 Чего нет

- Автозамены трутней, заданий с поколениями, отказа в сдаче без покрытия.
- Проверки завершения: королева по-прежнему может сдать `report done` раньше письма.
- Телефона: удалённая проекция (`packages/protocol/src/remote/projection.ts:83`) строгая и новых полей не несёт; проекция и `packages/mobile` не трогаются.
- Записи в `CHANGELOG.md`: её делает выпуск.

## 4. Задачи

Ветка `feat/swarm-visible-gaps` от `origin/master`. Задачи идут по очереди, каждая — отдельный коммит или несколько, сообщения по-английски.

### T1. Core, хост, тексты

Объём: разделы 3.1–3.7. Файлы: `packages/core/src/work/swarms.ts`, `map.ts`; `packages/core/src/index.ts` (экспорты); `packages/core/src/mcp/tools.ts`, `swarm-tools.ts`, `tools-size.test.ts`; `packages/core/src/work/research-swarm-skill.ts`; `packages/host/src/agent/swarm-endpoint.ts`; `packages/host/src/swarms/spawn.ts`, `briefs.ts`, `swarms-service.ts`; тесты рядом, включая новый `packages/host/src/swarms/briefs.test.ts` для чистого построителя письма, и фикстуры лимитов со `swarmSessions`. Другие файлы — только если без них не собирается, с объяснением в отчёте.

Приёмка:

1. `swarms.test.ts`: `isSwarmSlice` (границы длины, перевод строки, пустая после `trim`); `memberOutcome` — все шесть исходов, заснувший без итога участник — `open`.
2. `map.test.ts`: нормализация `slice`, `coverage`, `announced` — верные значения сохраняются; неверные и отсутствующие дают `null`, `null` и 0; у королевы `slice` и `coverage` всегда `null`; `announced` больше длины массива, дробное и отрицательное дают 0; старая запись без полей читается; значения переживают запись и повторное чтение.
3. Тесты `report` (`packages/core/src/mcp/server.test.ts`): трутень с `coverage: 'partial'` и `status: 'done'` → в записи участника `partial`; без поля → `null`; повторный `done` без поля прежнее `partial` не стирает, с полем заменяет; королева, сессия вне роя, `progress`, `failed` → запись не меняется; значение вне перечисления → ошибка, ни `summary`, ни `coverage` не тронуты; закрытая сессия → отказ, оба поля не тронуты; между записью покрытия и записью `result` участник ещё не сдавший, после `done` покрытие на месте.
4. `swarm-endpoint.test.ts`, `swarm-spawn.test.ts`: `slice` доходит до записи участника обрезанным; неверный отвергается с текстом из 3.3; `slice` при `op: 'create'` — `Unknown swarm argument.`
5. `briefs.test.ts`: тексты письма дословно по 3.5 — все покрыли; смесь `partial`, `unstated`, `failed`, `missing`, `open` с именами срезов и id сессий, `open` печатается как `did not hand in`; участник без среза; строка `Earlier waves`; строка `Left` с лимитом, без срока и без лимитов.
6. `swarms-service.test.ts`: `announced` стоит в той же записи, что `collecting` и письмо; вторая волна перечисляет только участников после `announced`, в том числе добавленного в ту же миллисекунду и при откате часов; повторная сверка и перезапуск после записи письма не дублируют; участник в `pending` не даёт волне закончиться; рой в `collecting` без поля `announced` письма не получает повторно; просрочка идёт прежним путём без письма конца волны; королева, сдавшая раньше конца волны, письма не получает; лимиты не прочитаны — письмо без строки `Left`; заголовок итога с `(K declared partial)` и без.
7. Тест скилла (`research-swarm-skill.test.ts`) зелёный, текст не длиннее 220 строк; старого текста письма роя в `packages/*/src` не осталось.
8. `tools-size.test.ts`: потолки подняты ровно на измеренные байты, числа названы в комментарии.
9. `pnpm --filter @parley/core test`, `pnpm --filter @parley/host test`, `pnpm typecheck`, `pnpm lint` проходят. В отчёте — вывод команд (число тестов, ноль ошибок).

### T2. Окно

Объём: раздел 3.8. Файлы: `packages/desktop/src/shared/strings.ts`, `packages/desktop/src/renderer/lib/swarm-view.ts`, `packages/desktop/src/renderer/sidebar/SwarmRow.tsx`, фикстуры и тесты рядом, `packages/desktop/e2e/swarm.spec.ts`.

Приёмка:

1. `swarm-view.test.ts`: слово `partial`; точка `partial`; название участника со срезом и без; старая сдача без поля покрытия показывается как `handed in ✓`; частичная сдача остаётся `partial` после закрытия участника и после отмены роя.
2. `SwarmRow.test.tsx`: строка участника со срезом, `aria-label` по 3.8, `data-dot="partial"`; длинное имя среза обрезается, полное стоит в `title`; участник без среза выглядит как сейчас.
3. `e2e/swarm.spec.ts`: рой с участниками `covered`, `partial`, `failed` и работающим — слово и точка частичной сдачи видны.
4. Снимки свёрнутой и раскрытой строки такого роя в светлой и тёмной теме: `docs/audits/2026-11-16/visible-gaps/`. На снимках точка и маркер частичной сдачи отличимы глазом от сдавшей и от открытой.
5. `pnpm --filter @parley/desktop test`, `pnpm typecheck`, `pnpm lint` проходят; e2e роя проходит. В отчёте — вывод команд.

## 5. Риски

- **Самооценка неточна.** `covered` — слово трутня. В пилоте 2 проверяющий пропустил три из пяти ложных находок (`docs/audits/2026-10-28/swarm-pilot-2-result.md:41`). Письмо прямо говорит, что это оценка участника.
- **Письмо можно не прочитать.** Королева может сдать раньше него. Итог создателю с `(K declared partial)` от этого не зависит.
- **Счётчик прежних волн не уменьшается.** Хост не знает, закрыло ли продолжение прежнюю дыру: связи «задание → попытки» нет. Строка `Earlier waves` говорит об этом прямо.
- **Размер описаний инструментов.** `report` уходит каждой сессии на каждом ходу; добавка — одно свойство с коротким описанием.
- **Старый хост и новое окно, и наоборот.** Поля необязательные; отсутствие читается как `null`.

## 6. Не проверено

- Как часто модели разных провайдеров заполняют `coverage` без отказа в сдаче: покажут живые рои после выпуска.
- Поведение телефона с роем, у которого есть частичные сдачи: проекция полей не несёт, показ не менялся.
