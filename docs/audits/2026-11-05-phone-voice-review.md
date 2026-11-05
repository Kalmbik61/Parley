# T5: ревью критика и безопасности — голос и карточки на iPhone

Дата: 2026-11-05. Область: `404596d4..2d7da921` (5 коммитов: план, T4a карточки, T2 сфера, T1 контроллер Live).
Незакоммиченные файлы T3 (`packages/mobile/src/app`, `packages/mobile/src/voice/*-model.ts`) не рассматривались.
Код не менялся; единственный записанный файл — этот.

**Вердикт: ship with fixes.** Блокеров нет. Три major: обход переключателя `remoteCreate` через карточки,
осиротевшая платная сессия при потере ответа `prepare`, нет автозакрытия Live на телефоне.

## Прогоны

| Команда | Результат |
|---|---|
| `pnpm --filter @parley/protocol test` | 27 files, 548 passed, exit 0 |
| `pnpm --filter @parley/remote test` | 13 files, 229 passed, 3 skipped, exit 0 |
| `cd packages/host && npx vitest run src/methods src/server.test.ts src/assistant` | 55 files, 1008 passed, exit 0 |
| `pnpm --filter @parley/mobile test` | 61 files, 671 passed, exit 0 (в рабочем дереве лежали незакоммиченные тесты T3 `cards-model.test.ts`, `screen-model.test.ts`: счёт включает их) |
| дополнительно `packages/core: npx vitest run src/voice-live` | 9 files, 116 passed |
| дополнительно `packages/desktop: npx vitest run src/renderer/island` | 39 files, 1044 passed |

## Находки

### M1 (major). Карточки с телефона обходят переключатель `remoteCreate`

- **Где:** `packages/host/src/server.ts:129-142` (`REMOTE_SWITCHED_METHODS`) и `:222-227` (`remoteMethodOpen`):
  `jobs.submit`, `cards.decide`, `cards.list` в переключаемый список не входят. `cards.decide` →
  `packages/host/src/assistant/assistant-service.ts:1530-1540` → `api.decide(..., 'mobile')` исполняет карточку внутри
  процесса хоста, мимо проверок `server.ts`. В `packages/host/src/assistant` и `src/methods` слова `remoteCreate`/`remoteLaunch` нет.
- **Сценарий:** владелец выключил `remoteCreate` (телефон не создаёт сессий и комнат, не пишет агентам, не закрывает
  сессии). Телефон шлёт `jobs.submit {text: "закрой S05 и создай комнату Auth из S01 и S02"}` (метод открыт всегда) →
  помощник готовит карточки `actions`/`room`/`message` → `cards.list` (новое, T4a) отдаёт `cardId` и `revision` →
  `cards.decide {choice:'send'}` → хост выполняет `sessions.close`, `rooms.create`, `rooms.send`/`pty.send`,
  `sessions.resume` — ровно то, что `remoteCreate` запрещает. До T4a путь был латентным (`cardId` = `pN`, ревизия 1 —
  угадываемы), T4a делает его штатным. Face ID для `dangerous` (T4b) — только на клиенте, хост его не проверяет.
  Спека §4.2: «Создай комнату… — нельзя создавать без прежней host-проверки прав и согласия».
  Карточки `decision` и `room-decision` сводятся к `feed.decide` / `rooms.resolveProposal`, которые и так открыты без
  переключателя, — для них обхода нет.
- **Исправление:** решение человека, затем на хосте: `cards.decide` с `via='mobile'` для видов `actions`, `room`,
  `message` отказывать (`reason: 'not_allowed'` или `already_handled`-подобный код), пока `remoteLaunch.enabled()` ложно;
  либо добавить `cards.decide` в `REMOTE_SWITCHED_METHODS` целиком. Тест в `server.test.ts`: `remoteCreate=false` →
  карточка `actions` с телефона не исполняется. В `cards.list`/`PhoneCard` полезен признак `decidable`, чтобы UI не
  показывал кнопку, которую хост отвергнет.

### M2 (major). Потерянный ответ `voice.session.prepare` оставляет платную сессию без владельца

- **Где:** телефон ждёт `prepare` 15 с: `packages/remote-client/src/rpc.ts:17-36` (`voice.session.prepare` не в
  `MUTATING_METHODS`, значит `RPC_TIMEOUT_MS`); мост ждёт хост 30 с (`packages/remote/src/host-link.ts:87`); хост готовит
  сессию до ~51 с (`CREATE_TIMEOUT_MS` 20 с, `live-client.ts:22`, плюс 3 попытки sideband по 10 с и паузы 0,25+1 с,
  `voice-session-service.ts:20-22,242-249`). Контроллер: `packages/mobile/src/voice/live-controller.ts:585-589` — при
  ошибке вызова `voiceSessionId === null`, `closeHostSession()` ничего не делает.
- **Сценарий:** медленный OpenAI или медленный sideband: через 15 с телефон получает `timeout`, рвёт peer, показывает
  «Voice could not connect». Хост дописывает сессию (`ok:true`), мост привязывает её к устройству
  (`dispatch.ts:258-263`) — устройство на связи, значит, никто её не закрывает; если хост ответил позже 30 с, мост ответа
  не видит вовсе и привязки нет. Слот хоста занят (`busy` на каждый новый старт), оценка расхода идёт, таймер закроет
  сессию только через `MAX_SESSION_MS` = 30 мин или по дневному бюджету. Закрывает ли OpenAI сессию, чей WebRTC так и не
  подключился, — не проверено. Телефон закрыть её не может: id он не узнал, а `voice.session.close` мост пускает только с id.
- **Исправление:** (1) телефону — `voice.session.prepare` (и заодно `cards.decide`, `jobs.submit`) в список долгих
  вызовов `rpc.ts` (45 с > 30 с моста); (2) хосту — закрывать готовую сессию, если в неё не пришёл первый usage/событие
  WebRTC за N секунд, или мосту при `timeout` своего вызова `prepare` закрывать то, что хост вернёт позже;
  (3) тест контроллера: `prepare` отвергнут таймаутом → снимок `idle`, повторный старт после ответа хоста не висит в `busy`.

### M3 (major). У телефона нет автозакрытия Live (T6, 3 мин тишины)

- **Где:** `packages/mobile/src/voice/live-controller.ts` не использует `createIdleCloser`
  (`packages/core/src/voice-live/idle-close.ts`); остров использует (`desktop/.../island/live/delegation.ts:168-173`).
  Спека модулей `docs/specs/2026-11-04-voice-assistant-modules-design.md:140-141`: автозакрытие считает клиент.
- **Сценарий:** человек начал разговор, отложил телефон с включённым экраном (зарядка, CarPlay, отключённая
  автоблокировка). Приложение в foreground, `stop()` из AppState не срабатывает, сессия тарифицируется до 30 мин или до
  дневного лимита. Остров в том же положении закрылся бы через 3 мин.
- **Исправление:** подключить `createIdleCloser` в `openSession` так же, как остров: `humanSpeaking/modelPlaying` из
  `setSpeech`, `activity()` на `delegationCreated`, `step()` в `tick`, `busy()` — открытые jobs сессии, речь `queued`/
  `submitted`, `ack.awaiting()`; `onIdle` → `stop()` с событием `stop` (причина `idle_timeout`). Тест на фейковых часах.

### m1 (minor). Закрытие хостом по лимиту приходит в модель как `stop`, а не `limitReached`; лишний `fail` при закрытии во время подключения

- **Где:** `live-controller.ts:251-259` (`finish` даёт `fail` только для `connection_lost`/`channel_closed`, иначе
  `stop`); `:480-482`; `:571-577`.
- **Сценарий:** (1) посреди разговора хост закрывает сессию с `reason: 'daily_limit'`
  (`voice-session-service.ts:264-266`) → модель получает `stop`, экран уходит в idle вместо R15 «Daily voice limit
  reached» (VO-07, B4 критерий 2). (2) `voice.session.closed` приходит, пока канал не открыт: `finish` шлёт `stop`, затем
  `abandon('failed')` шлёт ещё и `fail` — два конечных события подряд.
- **Исправление:** `daily_limit` → `limitReached`; в `start()` после `opened === false` проверять `target.closedEmitted`
  и возвращать `refuseQuietly`.

### m2 (minor). Ветка `catch` в `start()` разбирает глобальную `live`, а не свою сессию

- **Где:** `live-controller.ts:585-588` (`if (live !== null) teardown(live)`).
- **Сценарий:** start#1 ждёт `prepare` → `stop()` → start#2 получает сессию S2 (`live = S2`) → вызов #1 отвергается
  таймаутом (запрос не дошёл до хоста) → `catch` #1 вызывает `teardown(S2)`: S2 закрыта локально, `voice.session.close`
  для S2 не уходит (у #1 `voiceSessionId === null`, а #2 в `:573` видит `live !== target` и тоже не закрывает) — S2 на
  хосте живёт до лимита. Узкая гонка, но исход — платная сессия без клиента.
- **Исправление:** в `catch` разбирать только сессию, созданную этим вызовом (`let mineLive: Live | null`), и закрывать
  её id на хосте.

### m3 (minor). После переподключения к мосту контроллер не сверяет jobs сессии

- **Где:** `live-controller.ts:320-331` — только события `jobs.changed`, без `jobs.get` по открытым jobs.
- **Сценарий:** мобильная сеть моргнула, `jobs.changed {completed}` ушёл в пустоту → итог голосом не прозвучит, сфера
  останется в `delegating` до конца сессии. Спека §5: «на reconnect — snapshot + revision». VO-05 спасает только
  другой канал (экран/уведомление).
- **Исправление:** на событие «соединение восстановлено» звать `jobs.get` для `live.jobs` в открытом состоянии и
  пропускать ответ через `onJobChanged` (ревизионная защита уже есть).

### Заметки

- n1. Устаревшие комментарии: `packages/host/src/voice/voice-prompt.ts:60` («Телефон получает прежний конфиг без
  триггеров») и `voice-session-service.ts:49-52` («телефон без моста делегаций получает прежний конфиг»).
- n2. Телефону теперь уходит и Decisions-триггер эмоции (`voice-prompt.ts:62`, тест `voice.test.ts` фиксирует
  `phone[1] == island[1]`), а контроллер телефона событие `decision` не использует. Если Decisions тарифицируются
  отдельно — лишний расход на каждой телефонной сессии (стоимость не проверялась).
- n3. `PhoneCard.title` для карточек `actions` может содержать `~/parent` (`overview.ts:83-88`, `projectLabel` при
  одноимённых проектах), а `text` карточки `decision` — `detail` разрешения (команду агента,
  `assistant-service.ts:990`). Новой утечки нет: те же данные телефон уже видит в `works.list` (`projectPath` в `ref`)
  и `feed.snapshot`.

## Проверено и в порядке

- **Поверхность (вопрос 1).** Новое для телефона: метод `cards.list` и событие `cards.changed`
  (`allowlist.ts:59,72`); плюс `voice.session.prepare` теперь создаёт сессию с инструкциями и `delegation: client`.
  Оба имени в общих списках протокола → проходят и мост, и хост (`client.ts:28-38`, `server.ts:222`); `assistant.*`
  по-прежнему закрыт (тест `voice.test.ts` протокола). Параметры: `strictObject({})` и на мосту
  (`cardsParamRules`), и на хосте (`METHODS`), лишний ключ — отказ без вызова хоста (`bridge-app.test.ts:1596-1605`).
- **Проекция.** `projectPhoneCard` строит объект по явному списку полей (`cards.ts:408-427`); хост проецирует перед
  рассылкой (`assistant-service.ts:395-404`, `host.ts:895-899`), мост повторно режет схемой: ответ `cards.list` —
  `projectCardsResult` (`dispatch.ts:86`), событие — `phoneCardSchema.safeParse` (`fanout.ts:203-208`, `z.object`
  отбрасывает лишние ключи). `payload` (с `token` разговора), `decidedVia`, `outcome`, `source`, `view.card`,
  `view.decision`, `steps` в проекцию не попадают; тесты с `SECRET`/`T0KEN` зелёные. `jobs.*` и проекция job не менялись.
- **Конфиг сессии (вопрос 2).** Телефону конфиг не уходит: хост шлёт его в OpenAI, телефон получает только
  `{voiceSessionId, sdpAnswer}`. Инструкции общие, без имён, путей и ключей. Гейт `remoteVoice` для `prepare` на месте
  (`server.ts:225`, тесты `server.test.ts:2093`ff), выключение закрывает активную сессию и рвёт remote-клиентов
  (`host.ts:1130-1133`).
- **Расход (вопрос 3).** `stop()` → `voice.session.close` → `finish` без второго close (`:593-611`); обрыв peer,
  закрытие канала, `session.closed` по каналу → `finish` с `close` на хост (`:251-256`); закрытие хостом — без
  повторного close; `stop()` во время `openMic`/`prepare` — сессия закрывается после ответа (`:503-506,547-552`);
  таймаут открытия канала закрывает сессию на хосте (`:571-577`). Уход устройства или отзыв → мост закрывает его сессии
  (`dispatch.ts:249-255,474,682`). Остановка хоста → `closeActiveVoice` (`host.ts:1055-1058`). Дневной лимит и 30 мин
  на хосте не тронуты (`voice-session-service.ts:211,258-266`).
- **Ключ и SDP (вопрос 4).** Ключ живёт только в `live-client`; ответ `prepare` его не содержит. Контроллер и
  `live-peer.ts` в консоль не пишут (тест `live-controller.test.ts:528`), хостовый обработчик тоже
  (`voice.test.ts` «ничего не пишет в консоль»). Журнал моста пишет SDP только длиной и sha256-префиксом
  (`dispatch.ts:102-113`).
- **Контроллер против T1 (a–g, вопрос 5).** (a) ключ `dg_` + два cyrb53 в base36, ≤ 25 знаков, проходит `REMOTE_ID_RE`,
  тот же для повтора (`:151-154`, тест `:288`); correlation `{voiceSessionId, delegationId, turnId: delegationId}`.
  (b) повтор ревизии отсекается (`:324-326`). (c) VO-15: `cancelled` не входит в `finished` очереди core
  (`speech-queue.ts:191-193`), `stale` для отменённых и перекрытых → `dropped` (`:201,229-231`); тесты `:344,355,364`.
  (d) ack только по `appended(commentary)` и только при `foreground && !muted` (`:383-391`); `ack` эффекта очереди
  синхронен с `send`, поэтому `lastSentId` верен. (e) `stop()` не зовёт `jobs.cancel`. (f) коды `ok:false` → события
  модели (`:221-224,541`). (g) `PhoneCallMap` не содержит `cards.decide`/`jobs.cancel` — тип делает вызов невозможным.
- **Решение карточки (вопрос 5).** Устаревшая ревизия, решённая и вытесненная карточки → `already_handled`
  (`assistant-service.ts:1537`, тесты `assistant-service.test.ts:1753,1757`); `expired` и `not_found` — отдельно.
  Вытеснение (`emitSuperseded`), отзыв (`withdrawBySource`), истечение (`sweep`) рассылают `cards.changed`.
- **Остров (вопрос 6).** `events.ts` → `core/voice-live/live-events.ts` переименован со 100 % совпадением, тест — 99 %
  (только путь импорта); остров импортирует из `@parley/core/voice-live`, откуда уже брал мост делегаций. Поведение не
  изменилось: тесты острова и core зелёные (см. «Прогоны»).

## Not verified

- Закрывает ли OpenAI сессию, чей WebRTC не подключился (влияет на тяжесть M2), и стоимость Decisions-триггера (n2).
- Реальный звук, задержки, фон/блокировка iOS, поведение `InCallManager` с экраном — только на устройстве.
- `pnpm -r typecheck` и lint не запускались (рабочее дерево содержит незакоммиченные файлы T3).
- Сфера (T2, `Orb.tsx`, `orb-spec.ts`) смотрелась только на предмет безопасности: сети и хоста она не касается.
  Соответствие движения `ORB_MOTION_SPEC.md` не проверялось.
- Экран T3 (как он зовёт `setForeground`, `setMuted`, `stop()` по AppState и `cards.decide` с Face ID) не закоммичен.

## Дельта T3 (aad6d76a)

Область: только `git show aad6d76a` (экран Voice, `use-live-voice.ts`, `CardSheet.tsx`, `cards-model.ts`,
`screen-model.ts`, `runtime.onHostEvent`, перенос Inbox в `/inbox`, переход из push). Файлы, которые сейчас правит
исполнитель (M2, M3, m1, m2), не перечитывались. Mute экрана глушит только микрофон и намеренно не гейтит `jobs.ackInline`.

**Вердикт дельты: do not ship без B1.** B1 — правка в несколько строк; после неё и M4–M6 — ship with fixes.

### B1 (blocker). Карточка открывается поверх замка приложения, и её можно отправить без Face ID

- **Где:** `packages/mobile/src/voice/CardSheet.tsx:9` — `<Modal visible={card !== null} …>`, без `useCovered()` и без
  `useCloseOnLock`. Инвариант замка: `packages/mobile/src/components/LockGate.tsx:4-10` («контроллер, показанный позже,
  ляжет над обложкой… поэтому ничего не открывается под обложкой»), `auth/lock-sheets.ts:1-6`. Образец правильного
  поведения в том же коде: `app/room.tsx:595` — `visible={… && !covered && focused …}`.
- **Сценарий:** включён «Lock Parley with Face ID», Parley заблокирован (простой или возврат из фона), телефон в руках не у
  владельца. На хост приходит карточка (из Telegram, острова или текстового job) → `cards.changed` → `CardSheet`
  показывается нативно над `FullWindowOverlay` замка. Виден `title`/`text` (текст письма агенту, команда из разрешения), а
  «Send» у не-`dangerous` карточек (`message`, `decision` = Allow разрешения агента, `room`) уходит без Face ID
  (`cards-model.ts:412`). Замок обойдён, действие на Mac выполнено от имени владельца.
- **Исправление:** `visible={card !== null && !covered}` (через `useCovered()`) и `useCloseOnLock(card !== null, …)`;
  решение принимать только при `!covered`. Тест: при `covered` лист не виден и `decide` ничего не зовёт.

### M4 (major). Лист карточки не закрывается и запирает экран: Stop, Mute и вкладки недоступны, пока карточка не решена

- **Где:** `CardSheet.tsx:9` (`transparent`, на весь экран, `onRequestClose={() => undefined}`, кнопки только Send/Cancel);
  `use-live-voice.ts:267` (`currentCard` — всегда первая активная).
- **Сценарий:** посреди голосовой сессии помощник готовит карточку («подготовил карточку, подтвердите»). Лист закрывает
  весь экран вместе с таб-баром. Остановить платную сессию, выключить микрофон или уйти в Inbox, чтобы посмотреть
  контекст, нельзя: только решить карточку или увести приложение в фон. Человека подталкивают к поспешному «Send»; при
  нескольких карточках они идут подряд без паузы. Лист живёт во вкладке Voice, но `NativeTabs` её не размонтирует, а RN
  `Modal` показывается от корневого контроллера, поэтому карточка всплывёт и поверх Inbox/Settings; если там уже открыт
  pageSheet (New, Team), UIKit второй контроллер не покажет и карточка молча потеряется до следующей смены `visible` (на
  устройстве не проверено).
- **Исправление:** карточка — плашка в разметке экрана или лист с «Later» (свернуть до значка), Stop/Mute остаются
  доступны; показывать только при `focused` вкладки Voice, иначе — бейдж.

### M5 (major). После отказа R15 повторить старт нельзя до перезапуска приложения

- **Где:** `VoiceScreen.tsx:56-82` — при `fallback !== null` кнопки Start/Mute не рисуются; `use-live-voice.ts:72,205` —
  `failure` сбрасывается только внутри `start()`; `voice-model.ts:84-85` — из `limit_reached` выходит только `start`.
- **Сценарий:** (1) `no_key` → человек добавил ключ на Mac → экран по-прежнему «No OpenAI key on the Mac» без кнопки.
  (2) `mic` → разрешил микрофон в Настройках, вернулся → тот же шаблон. (3) `limit_reached` → прошла полночь Mac → шаблон
  остаётся. Выход — только убить приложение (вкладку `NativeTabs` не размонтирует). `voice_off` и `mac_unreachable`
  восстанавливаются сами (зависят от живого состояния), эти три — нет.
- **Исправление:** в шаблоне R15 оставить кнопку «Try again» (кроме `voice_off`/`mac_unreachable`), сбрасывать `failure`
  при возврате в `active` и при `macBack`; для лимита перечитывать `voice.usage.get` и снимать шаблон при
  `remainingSeconds > 0`. Тест на `chooseFallback` + сброс.

### M6 (major). Текст запроса на разрешение микрофона теперь ложный

- **Где:** `packages/mobile/app.config.ts:15,63,69,72` — `MICROPHONE_TEXT = 'Parley listens only while you dictate into a
  message. Audio stays on this iPhone.'`, тот же текст у плагина `react-native-webrtc`. Файл в коммит не входит, но
  неправдой текст стал с этим коммитом: экран Voice шлёт звук в OpenAI через WebRTC.
- **Сценарий:** человек даёт доступ к микрофону, прочитав «звук остаётся на iPhone», а голос уходит в облако. Это
  нарушение App Review 5.1.1 (назначение разрешения должно быть точным) и честности перед пользователем.
- **Исправление:** текст вида «Parley uses the microphone for dictation (on this iPhone) and for voice conversations,
  which are sent to OpenAI through your Mac.» во всех трёх местах.

### m4 (minor). Сбой `cards.list` теряет буфер событий и не повторяется

- **Где:** `use-live-voice.ts:165-175` — в `catch` буфер `buffered` не применяется, повтора нет.
- **Сценарий:** `cards.list` упал по таймауту при переподключении → карточки, пришедшие событием во время запроса, и
  все активные невидимы до следующей смены `reachable`.
- **Исправление:** в `catch` применить `buffered` к пустому списку и запланировать повтор.

### m5 (minor). Повтор текстового запроса после таймаута создаёт дубль job

- **Где:** `use-live-voice.ts:249-252` — новый UUID на каждую попытку; `jobs.submit` у телефона ждёт 15 с (см. M2).
- **Сценарий:** ответ не дошёл → «Could not send. Try again» → человек жмёт ещё раз → второй job с тем же текстом
  (первый дошёл до хоста). Для запроса «закрой S05» это две карточки.
- **Исправление:** держать ключ, пока текст не изменился и запрос не подтверждён; новый ключ — только для нового текста.

### m6 (minor). Контроллер создаётся в `useMemo`, а освобождается в cleanup эффекта

- **Где:** `use-live-voice.ts:87-129`.
- **Сценарий:** при StrictMode (двойной mount/cleanup в dev) или Fast Refresh cleanup зовёт `controller.dispose()` и
  снимает его подписки на `jobs.changed`/`voice.session.closed`. После этого эффект запускается снова, но `useMemo([])`
  отдаёт тот же уже освобождённый контроллер, и тот больше не слышит хост. В релизе без StrictMode не проявляется. Плюс
  размонтирование зовёт `stop()` и `dispose()` подряд: два `voice.session.close` и двойной `teardown` (безвредно).
- **Исправление:** создавать контроллер в эффекте (`useRef` + создание в `useEffect`) или не вызывать `dispose` в
  cleanup, который может повториться.

### Заметки дельты

- n4. Фон: `stop()` контроллера сначала ждёт ответа `voice.session.close` и только потом гасит микрофон и peer
  (`live-controller.ts:604-610`). Если хост не отвечает, микрофон остаётся открытым до таймаута RPC (15 с). Без
  `UIBackgroundModes: audio` iOS сам прерывает захват в фоне, мост закрывает сессию при уходе устройства, так что расход
  ограничен. Но порядок «сначала локально, потом хост» надёжнее. Файл сейчас правит исполнитель — передаю как
  пожелание к M2/M3.
- n5. `inactive` (входящий звонок, Пункт управления) сессию не рвёт по замыслу. Долгий звонок держит Live открытой до
  автозакрытия из M3.
- n6. Исход `reason: 'failed'` хоста (действие не выполнилось) показывается как «This card is no longer current», и
  карточка убирается (`cards-model.ts:424`). Человек не узнаёт, что отправка сорвалась.
- n7. `ui/bar.tsx:28` (`back` без стека → `router.replace('/')`) теперь ведёт на Voice, а не в Inbox. На практике
  стек есть всегда: push открывает `/inbox`, остальные экраны открываются из вкладок. Pairing после успеха
  (`pair/flow.tsx:25`) уходит на Voice — это и требует VO-01.

### Проверено и в порядке (дельта)

- **VO-06.** Голос карточку не решает: `decide` зовёт только кнопка `CardSheet` (`use-live-voice.ts:268-291`); у
  контроллера пути к `cards.decide` нет (T1, тип `PhoneCallMap`).
- **Face ID.** Опасная карточка с «Send» сначала спрашивает владельца. При `cancelled` или `unavailable` вызова нет вообще
  (`cards-model.ts:411-417`, тест `cards-model.test.ts:62-67`). «Cancel» Face ID не просит. `confirmWithOwner` то же, что
  `confirmByOwner` в `room.tsx`. `dangerous` ставится только по шагам `actions` (`decision` = Allow разрешения без
  Face ID, как и в Inbox).
- **Фон.** `background` → `controller.stop()`, `active` → `setForeground(true)` (`use-live-voice.ts:132-142`,
  `screen-model.ts:585-587`, тест `screen-model.test.ts:113`). Размонтирование зовёт `stop()` и `dispose()`. Mute
  выключает дорожку (`live-peer.ts` `setEnabled`), сессия остаётся.
- **VO-05.** Итог текстового job показывается один раз по `jobId` (`shownRef`), только в foreground. `jobs.ackInline`
  уходит вместе с показом и только при `!deliveredInline` (`use-live-voice.ts:195-202`, `screen-model.ts:562-565`). Гонку
  «событие раньше ответа submit» закрывает `jobs.get` с ревизионной защитой (`:256-258`).
- **VO-01, навигация.** `inbox.tsx` побайтно равен прежнему `index.tsx` (`diff` пуст). Параметр `segment` и бейдж
  Needs-you на месте. Push ведёт в `/inbox` (с `segment=letters` для писем), неизвестный адресат — в Settings. Все
  `'/'` в коде: dev-редиректы (`bench`, `md`, `dictation-check`, `voice-loopback`), pairing и `bar.tsx` (n7). Ни один из
  них не ждёт именно Inbox.
- **Слушатели.** `runtime.onHostEvent` возвращает отписку; все три подписки хука снимаются в cleanup
  (`use-live-voice.ts:158-179,183-192`, контроллер — в `dispose`). Падение слушателя изолировано
  (`runtime.ts:276-282`).

### Not verified (дельта)

- Тесты, typecheck и lint на `aad6d76a` отдельно не запускались: рабочее дерево содержит незакоммиченные правки
  исполнителя M2/M3. Тесты `cards-model`/`screen-model` вошли в прогон mobile из первой части (671 passed).
- Показ RN `Modal` из невидимой вкладки `NativeTabs`, его поведение при открытом pageSheet и над `FullWindowOverlay` —
  выводы по комментариям `LockGate.tsx` и коду, на устройстве не проверены.
