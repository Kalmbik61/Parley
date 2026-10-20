# Управление Parley через помощника и канал Telegram — дизайн

Дата: 2026-10-19. Основа: спека помощника `docs/specs/2026-10-14-assistant-design.md` (этап 1 в master), остров одобрений (v0.12.0), спека удалённого доступа `docs/specs/2026-10-01-remote-access-design.md` (не реализована; её рамка §2 здесь сужена под Telegram) и реверс-обзор Telegram-канала OpenClaw `docs/audits/2026-10-19/OpenClaw-telegram-review-2026-10-19.md` (далее «обзор»; каталог `docs/audits` не в git). Код читался по `master` 8e06f0c3 (после v0.16.1).

Документ — для строителя, который спеку помощника и код Parley видит впервые. Он должен уметь написать по нему план, не возвращаясь к человеку.

## 1. Зачем

Человек не за Mac, в руках телефон. Он хочет из Telegram спросить помощника, что делают комнаты и кто его ждёт, поручить ему письмо агенту, создание комнаты или ответ на разрешение, попросить «проверь через 5 минут» и получить доклад, а ещё получать первым то, что сейчас показывают остров и уведомления macOS: кто ждёт, кто закончил, кто написал, кто просит разрешение. Нажатие кнопки в Telegram должно быть тем же, что клик на острове.

Второе, что здесь добавляется и работает без Telegram: помощник получает право **предлагать** создание комнат и решения по разрешениям, вопросам и планам и ставить себе напоминания. Все предложения проходят через карточку и нажатие человека, как письмо сейчас.

## 2. Решения человека (2026-10-19)

| # | Вопрос | Решение |
|---|---|---|
| 1 | Сценарий | Не за компьютером: писать помощнику в Telegram, чтобы он что-то сделал, проверил или рассказал, что делают комнаты; управлять удалённо и понимать, что происходит |
| 2 | Самостоятельность | **Всё проходит через человека.** Помощник не будит сессии, не пишет агентам, не отвечает на разрешения сам. Он читает, предлагает карточку, человек нажимает |
| 3 | Напоминания | «Проверь через 5 минут комнату» — помощник ставит себе таймер, через 5 минут сам проверяет и докладывает. Таймер держит хост (раздел 7), а не процесс CLI |
| 4 | Объём первой версии | Полный: письма агентам и комнатам (есть), создание комнат, разрешения словами через помощника и кнопками, напоминания, всё это в Telegram с привязкой и переключателями |
| 5 | Образец | Telegram-модуль OpenClaw; берём механизмы, код пишем сами (обзор §8) |

Решения, принятые мной и названные человеку 2026-10-19 (он не возразил):

| # | Вопрос | Решение |
|---|---|---|
| 6 | Содержимое в Telegram | Полное: команды, тексты писем, ответы помощника. Иначе кнопки одобрения бессмысленны. Текст лежит на серверах Telegram, сквозного шифрования нет — это принято и написано в настройках |
| 7 | Разговор | Один разговор помощника на остров и Telegram (спека помощника, решение 8) |
| 8 | Помощник выключен | Привязка, уведомления и кнопки на карточках работают без помощника. Вопрос помощнику при выключенном помощнике получает ответ «Turn on the assistant in Settings → Assistant» |
| 9 | Ответ на письмо агента из Telegram | Reply на уведомление о письме уходит в комнату сразу, без карточки: текст набрал сам человек |
| 10 | Присутствие | Telegram получает всё всегда, и когда человек за Mac. Управление — переключателями |
| 11 | Сеть | `HTTPS_PROXY`/`https_proxy` из окружения входа (`shell-env`, как у CLI). Поля прокси в настройках нет |
| 12 | Голос | Сначала спайк: принимает ли `whisper-cli` OGG/Opus напрямую (раздел 12). Если нет — декодер в хосте |
| 13 | Несколько Mac | Один бот на один Parley. Второй Mac с тем же токеном вытесняет первого (раздел 9.5) |

Решения после проверки документа строителем (2026-10-19, мои):

| # | Вопрос | Решение |
|---|---|---|
| 14 | Вторая кнопка плана | `manual` у плана — это «одобрить, но подтверждать каждую правку» (`hookDecisionResponse` отвечает `allow`), а не «отложить». Кнопки везде честные: **Accept** (`auto-accept`) и **Approve each edit** (`manual`); кнопки «посмотреть на Mac» нет — человек просто не нажимает |
| 15 | Модель Whisper для голосовых | Та, что человек выбрал в Settings → Voice (`ui.voice.model`); приходит хосту в `assistant.configure`, не в env. Голос выключен или модель не скачана — бот отвечает «Turn on Voice input in Settings → Voice on your Mac» и не расшифровывает. Хост моделей сам не выбирает |
| 16 | Второй Mac, 409 | Проигравший хост (получивший 409) останавливает опрос до действия человека: кнопка **Use this Mac** в настройках или следующий старт хоста. Повторов с backoff по 409 нет: два опроса по очереди делили бы обновления и теряли нажатия. Telegram отдаёт 409 прежнему опросу, так что побеждает тот Mac, что начал опрос последним |
| 17 | Фразы подтверждения в Telegram | Только кнопки. Текст «да»/«yes» при ждущей карточке уходит модели как обычный вопрос (она попросит нажать кнопку). Причина: голосовое с ошибкой распознавания не должно разрешать действие агента. На острове фразы работают как прежде |
| 18 | Напоминание при выключенном помощнике | Разовое: один раз «Reminder r3: the assistant is off — <what>» в Telegram (если привязан), затем удаляется. Повторяющееся: это сообщение один раз, дальше тики пропускаются молча, пока помощник выключен; удаляется по своим 24 ч |

Решения человека после проверки строителем (2026-10-19):

| # | Вопрос | Решение |
|---|---|---|
| 19 | Решения ведущего в комнате | **Полностью**: четвёртый вид карточки `room-decision` (Accept / Return с заметкой), инструмент `propose_room_decision`, кнопки на острове и в Telegram (5.5, 6, 10.1) |
| 20 | Главный переключатель Telegram | В Settings → Notifications у Telegram свой переключатель **Send to Telegram**. Уведомления уходят в Telegram, только когда он включён (11.1) |

Мои уточнения к ним:

| # | Вопрос | Решение |
|---|---|---|
| 21 | Что гасит переключатель | Всё: при выключенном Send to Telegram хост не опрашивает бота, ничего не шлёт и не держит себя запущенным; токен и привязка сохраняются. Умолчание — включён (без токена и привязки он всё равно бездействует) |
| 22 | Обновления за время «выкл» | После включения, привязки или **Use this Mac** накопившиеся у Telegram обновления пропускаются (первый `getUpdates` с `offset = -1`): бот, который был выключен, не отвечает задним числом |
| 23 | Заметка к Return в Telegram | Кнопка **Return…** просит заметку следующим сообщением (10 минут, `/skip` — без заметки); на острове заметка — текст карточки, который предложила модель |

## 3. Что сейчас (проверено по master 8e06f0c3)

- **Помощник** (этап 1): `host/src/assistant/assistant-service.ts`, инструменты `parley_overview`, `parley_detail`, `propose_message`, `end_conversation` (`core/src/mcp/assistant.ts`, приёмник `host/src/assistant/assistant-endpoint.ts` на `/assistant/<tool>` сервера хуков). Карточка одна (`AssistantProposal` в `protocol/src/assistant.ts`: `id`, `target`, `where`, `kind`, `text`, `mentions`, `wake`), решение — `assistant.decide { proposalId, decision: 'send' | 'cancel' }`. Остров получает состояние событием `assistant.changed` (`AssistantState`: `phase`, `detail`, `question`, `answer`, `mood`, `proposal`, `outcome`, `error`, `turn`, `askId`). Настройки помощника — в `ui.json` у main (`ui.assistant`: `enabled`, `provider`, `model`, `language`, `hotkey`, `speak`); хост получает провайдера, модель и язык в каждом `assistant.ask`. Цели помощника — `host/src/assistant/overview.ts` (`AssistantTarget`: комната или сессия с `id` вида `room:<проект>:<работа>:<roomId>` / `session:…`).
- **Разрешения, вопросы и планы агентов** — карточки ленты (`core/src/feed/types.ts`: `FeedPermissionCard`, `FeedQuestionCard`, `FeedPlanCard`; состояние `pending | allowed | denied | answered | elsewhere | stale`). Решение — `feed.decide { ref, cardId, decision }`, `FeedDecision` — `{ kind: 'permission', behavior: 'allow' | 'deny', always?: true, message? }`, `{ kind: 'question', answers }`, `{ kind: 'plan', choice: 'auto-accept' | 'manual' }`. Применяет только хост: `FeedService.decide` (`host/src/feed/feed-service.ts`) сверяет удержанный хук и отвечает `{ applied, state }`; второе нажатие — `applied: false`. Остров показывает ждущие карточки через `feed.snapshot` со `scope: 'attention'` и решает тем же `feed.decide` (`shared/island.ts`, `ISLAND_METHODS`).
- **Уведомления macOS** считает renderer главного окна (`renderer/attention/notify.ts`, чистые функции `renderer/attention/derive.ts`: `sessionAttention`, `roomAwaitsDecision`, `humanUnreadLetters`, `humanUnreadMentions`), показывает main (`main/notifications.ts`). Переключатели — `ui.json.notifications: { needsYou, finished, mail, sound }` (`shared/ui-types.ts:72`), вкладка Settings → Notifications (`renderer/components/settings/SettingsDialog.tsx`). Без открытого окна уведомлений нет.
- **Секреты**: одно хранилище `core/src/secrets.ts` — `SecretId = 'zai'`, `readSecret`/`writeSecret`/`clearSecret`, файл `~/.parley/secrets.json` (0600, атомарная запись), окну уходит только `secretHint`. Методы `providers.setKey`/`clearKey` (`host/src/methods/providers.ts`) пропускают только `runner.secret === 'zai'`.
- **Хост** (`host/src/host.ts`): один процесс Node, запускает main (`main/host-launcher.ts`); сервер хуков слушает только `127.0.0.1`; хост гаснет через `DEFAULT_IDLE_MS = 300_000` без клиентов и занятых сессий (`host/src/context.ts`, `busyKeys`); выход из приложения останавливает хост после вопроса (`main/quit-guard.ts`). Конфиг хоста — `ParleyConfig` (`core/src/config.ts`, плоские ключи, `settings.set { key, value }`).
- **Голос**: `whisper-cli` и модели ищет main (`main/voice/engine.ts`: `Contents/Resources/whisper` у сборки, `build/whisper` в dev, иначе PATH), запуск — `main/voice/transcribe.ts` (`-m`, `-f <wav>`, `-l`, `--vad`). Хост о движке не знает.
- **Комнаты**: `rooms.create { projectPath, workId, title, members[], lead?, quiet?, mode? }`, письмо — `rooms.send { projectPath, workId, roomId, to[], text, kind }`; помощник уже шлёт письма через `sendHumanLetter(…, { via: 'assistant' })`.
- **Статусы** — только из `core/src/work/session-state.ts` (правило 2026-10-17): свой расчёт состояния — дефект.

## 4. Объём и этапы

Одна спека, два этапа, у каждого свой план и PR (как у помощника):

- **Этап A — права помощника и напоминания** (разделы 5–7). Работает на острове без Telegram. Новые инструменты `propose_room`, `propose_decision`, `propose_room_decision`, `schedule_check`, `list_reminders`, `cancel_reminder`; карточки комнаты, решения по запросу агента и решения по комнате на острове; напоминания в хосте.
- **Этап B — канал Telegram** (разделы 8–11). Модуль хоста, привязка, уведомления, карточки с кнопками, вопросы помощнику текстом и голосом, настройки.

**Этап C (не в этой спеке, после живой приёмки B):** запуск новой сессии, остановка и архив сессий, роли в комнате — теми же карточками. Назван здесь, чтобы строитель не закладывал под них ничего, кроме общего вида карточки (5.1).

Вне объёма: группы и топики Telegram, Mini App, несколько ботов, webhook, стриминг ответа черновиками, замена спеки удалённого доступа (PWA и push остаются отдельной темой; что из неё берётся — сказано по месту), голосовые ответы помощника в Telegram, языки помощника кроме ru/en.

## 5. Права помощника: карточки предложений

### 5.1 Общий вид карточки

Карточка помощника расширяется с одного вида (письмо) до четырёх: письмо, комната, решение по запросу агента, решение по комнате. `AssistantProposal` получает поле `action`:

```ts
type AssistantProposal =
  | { id; action: 'message'; target; where; kind; text; mentions?; wake }          // как сейчас
  | { id; action: 'room'; where; title; members: string[]; lead: string; task: string | null }
  | { id; action: 'decision'; target; where; card: ProposalCardView; decision: FeedDecision }
  | { id; action: 'room-decision'; target; where; proposal: RoomProposalView; choice: 'accept' | 'return'; note: string | null }
```

`RoomProposalView = { proposalId, rev, kind: 'decision' | 'completion', from: string, text: string, planId?: string, planRev?: number }` — слот `room.proposal` комнаты (`core/src/work/types.ts`, `Proposal`): `text` целиком до 10 000 знаков, остров и Telegram показывают первые 1500 с «…».

- `members` и `lead` — имена сессий («S03 Ruslan»), `where` — «работа · проект», как у письма.
- `ProposalCardView` — то, что человек должен видеть, чтобы решить: `{ cardId, kind: 'permission' | 'question' | 'plan', summary: string, detail: string | null }`. `summary` — одна строка по тем же правилам, что у острова (`renderer/attention/ask-summary.ts`; вынести в `@parley/core/attention`, см. 8.3); `detail` — команда или правка (`toolInput` разрешения) до 1500 знаков, текст вопроса с вариантами, первые 1500 знаков плана.
- Старое окно и остров без поля `action` читают карточку как письмо: `action` отсутствует → `'message'`. Хост не шлёт `room`/`decision`/`room-decision` клиенту, который не объявил поддержку (версия протокола события или поле `capabilities` в `assistant.state`; строитель выбирает по тому, как остров сейчас узнаёт новые поля).
- По-прежнему одна карточка: новая заменяет старую, сброс разговора снимает, решение — `assistant.decide { proposalId, decision: 'send' | 'cancel' }`. Для `room` и `decision` `'send'` значит «сделать».
- На острове фразы подтверждения те же (`core/src/assistant/text.ts`), «да» подтверждает любую карточку. В Telegram карточки подтверждаются только кнопками (решение 17).
- Исход в следующий вопрос модели: `[system: proposal <id> was done|cancelled]`; `outcome` в `AssistantState` расширяется до `'sent' | 'done' | 'cancelled' | null`; остров пишет «Sent ✓» у письма и «Done ✓» у остальных.

### 5.2 `propose_room`

```
propose_room({ work, title, members, lead?, task? })
```

- `work` — id работы из `parley_overview` (работы в обзоре получают id `work:<проект>:<workId>`; сейчас id есть только у комнат и сессий — добавить). Точное имя работы тоже принимается, если уникально, как у `TARGET`.
- `members` — id или имена сессий этой работы, минимум одна; `lead` — одна из них, иначе первая; `title` — непустая строка до 80 знаков; `task` — текст первого письма в комнату (необязателен).
- Хост проверяет: работа есть и не в архиве; все `members` — сессии этой работы, не `closed`; имена уникальны. Не прошло — модели ответ с причиной, карточки нет (как у `propose_message`).
- Подтверждение: `rooms.create { projectPath, workId, title, members, lead }`, затем при `task` — `rooms.send { roomId, to: [], text: task, kind: 'note' }` через `sendHumanLetter(…, { via: 'assistant' })`. Спящие участники просыпаются от письма, как обычно; без `task` комната создаётся как из окна без `quiet` (приглашения уходят).
- Ответ модели после создания — исход `done` с `roomId` в системной строке: `[system: proposal p3 was done: room Auth created]`, чтобы следующий вопрос «напиши туда» нашёл комнату через свежий `parley_overview`.

### 5.3 `propose_decision`

```
propose_decision({ target, decision })
decision: { kind: 'permission', behavior: 'allow' | 'deny', always?: true }
        | { kind: 'question', answers: Record<string, string> }
        | { kind: 'plan', choice: 'auto-accept' | 'manual' }
```

- `target` — сессия (`TARGET`). Хост берёт её ждущие карточки через `feed.snapshot(ref, undefined, 'attention')` (как остров). Ровно одна ждущая карточка нужного `kind` → карточка-предложение с `ProposalCardView`. Несколько → модели список `cardId` и сводок, пусть уточнит у человека; ноль → «S03 is not waiting for anything». Карточки Codex без удержанного хука (`decisions` снимка не `window`) не предлагаются: ответ «Answer at your Mac».
- `always: true` допускается, только если карточка несёт `suggestions` (то, что CLI сам предложил), иначе хост обрезает до разового `allow` и говорит об этом модели.
- Для `question` модель передаёт ответы по id вопросов из `ProposalCardView.detail`; свободный текст допустим там, где карточка его допускает (как в окне).
- Для `plan` оба выбора — одобрение: `auto-accept` (все правки без вопросов) и `manual` (каждая правка придёт отдельной карточкой разрешения). Промпт объясняет это модели; слова «посмотрю потом» карточки не дают (решение 14).
- Подтверждение: `feed.decide { ref, cardId, decision }`. `applied: false` (ответили в терминале, на острове или в Telegram раньше) → исход `cancelled` с системной строкой `[system: proposal p4 was cancelled: already answered]`, остров показывает «Already answered».
- Промпт помощника (`host/src/assistant/prompt.ts` или где он лежит) получает абзац: разрешения, вопросы и планы — только через `propose_decision`; слова «разреши», «запрети», «allow», «deny» — повод для карточки, а не для действия; никогда не выдумывать `cardId`.

### 5.4 Что в обзоре нового

`parley_overview` у сессии в состоянии `blocked` показывает, чего она ждёт, уже сейчас (`waitingFor`). Добавить строку вида `waits: permission — Bash: rm -rf dist (card c12)` / `question — 2 questions` / `plan — 40 lines`, чтобы модель могла предложить решение без лишнего `parley_detail`. Сводка — та же функция, что для `ProposalCardView.summary`.

### 5.5 `propose_room_decision`

```
propose_room_decision({ target, choice: 'accept' | 'return', note? })
```

- `target` — комната (`TARGET`). Хост берёт `room.proposal`; `null` → «Auth has no decision waiting»; иначе карточка с `RoomProposalView` и выбором. `note` (до 4000 знаков) — заметка ведущему при `return`, словами человека; при `accept` отбрасывается. Решение `completion` (ведущий считает работу по плану законченной) идёт тем же инструментом: `accept` принимает завершение.
- Подтверждение: `rooms.resolveProposal { projectPath, workId, roomId, proposalId, action: choice, note, rev, planId, planRev }` (оба `plan*` только если есть в слоте). Ведущий успел переделать текст (`ProposalConflictError`, `rev` не совпал) → исход `cancelled` с системной строкой `[system: proposal p5 was cancelled: the lead revised the decision]`, остров показывает «Revised, look again»; следующий `parley_overview` покажет новый текст.
- Промпт: решения ведущего в комнатах — только через `propose_room_decision`; «прими», «верни на доработку», «accept», «return» — повод для карточки.
- Обзор (5.4): у комнаты с решением строка `waits: decision from S01 (p-03, rev 1): <первые 200 знаков>`.

## 6. Остров: карточки комнаты и решения

- Карточка **комнаты**: заголовок «New room in Parley · my_harnas», строка «Auth · S02 Ruslan, S04 Igor · lead S02», ниже текст задачи (если есть). Кнопки **Create** и **Cancel**.
- Карточка **решения**: заголовок «Allow S03 Ruslan?» / «Deny S03 Ruslan?» / «Answer S03 Ruslan?» / «Accept plan of S03 Ruslan?», ниже `summary` и `detail` в моноширинном блоке (прокрутка, как у карточек ленты). Кнопки **Allow**/**Deny**/**Answer**/**Accept plan**/**Approve each edit** (по `decision`) и **Cancel**. У `always: true` подпись «Allow, don't ask again».
- Карточка **решения по комнате**: заголовок «Accept decision in Auth?» / «Return to S01 for rework?», ниже текст решения (прокрутка, первые 1500 знаков) и заметка при `return`. Кнопки **Accept**/**Return** (по `choice`) и **Cancel**. Конфликт версии после нажатия — «Revised, look again» на 8 с.
- Значения кнопок — в `shared/strings.ts` (`S.assistant.card.*`), только английский.
- Поведение совпадает с письмом: Enter, фразы, замена карточки, «Done ✓» на 8 с (`ANSWER_HOLD_MS`), мини-вид с подписью «Card» при убранном острове.
- Если карточка-решение на острове дублирует ждущую карточку ленты той же сессии (остров показывает и то и другое), остров показывает только карточку помощника, пока она есть; её отмена возвращает карточку ленты. Это правка `renderer/island` там, где остров выбирает, что показать.

## 7. Напоминания

### 7.1 Инструменты

```
schedule_check({ in_minutes?: number, at?: string, every_minutes?: number, what: string })
list_reminders()
cancel_reminder({ id })
```

- Одно из `in_minutes` (1…1440) или `at` (ISO-время в будущем, не дальше 24 ч); `every_minutes` (5…1440) делает напоминание повторяющимся, не дольше 24 ч от создания. `what` — что проверить, словами человека, до 500 знаков.
- Не больше 10 активных напоминаний; 11-е — отказ модели с причиной.
- `schedule_check` отвечает модели «scheduled r3 for 14:07», та пересказывает человеку. Это **не** карточка: напоминание ничего не меняет в Parley, карточки появятся при срабатывании, если помощник что-то предложит.
- `list_reminders` — список `{ id, at, every, what }`; `cancel_reminder` — отмена по id или «все», если модель передала `id: '*'`.

### 7.2 Хост

- Модуль `host/src/assistant/reminders.ts`: файл `~/.parley/assistant/reminders.json` (атомарная запись, как `sent.jsonl` рядом), таймеры `setTimeout` до ближайшего срока, пересчёт при старте хоста. Перезапуск хоста не теряет напоминания; просроченные за время простоя срабатывают сразу по одному с пометкой «late».
- Срабатывание = новый ход помощника: `assistant.ask` с текстом `[reminder r3, asked at 14:02] Check: <what>` и `origin: 'reminder'`, провайдер/модель/язык — последние, что были у разговора, иначе значения из зеркала настроек (8.4). Если ход уже идёт — напоминание ждёт его конца; если помощник выключен — разовое напоминание один раз пишет в Telegram (если привязан) «Reminder r3: the assistant is off — <what>» и удаляется; повторяющееся пишет это один раз, дальше тики пропускаются молча, пока помощник выключен (решение 18).
- Ответ хода помечен `origin: 'reminder'` в `AssistantState` (новое поле). Остров показывает его как обычный ответ и раскрывается сам (как при приходе ответа в мини-виде, спека помощника, решение 11); Telegram получает его сообщением (10.3). Карточка, если модель её предложила, идёт обычным путём.
- Повторяющееся напоминание после 24 ч от создания удаляется с последним докладом «last check».

## 8. Канал Telegram: место и состав

### 8.1 Где

Процесс хоста, новый каталог `packages/host/src/telegram/` (обзор §5). Поднимается в `startHost` рядом с `createAssistantService`, гасится shutdown-хуком. Нужны только исходящие HTTPS к `api.telegram.org` через `fetch` Node (прокси — из окружения входа, решение 11; `undici` `EnvHttpProxyAgent`, если `fetch` без него прокси не берёт — проверить в спайке 12.2). Входящего порта нет; сервер хуков по-прежнему только loopback.

Без grammY и без воркера: long polling прямым `fetch` с `AbortController`; воркер — только если профиль покажет задержки (обзор §5).

**Хост не гаснет, пока Telegram привязан и включён.** Привязанный бот при включённом Send to Telegram держит ключ в `busyKeys` контекста (`host/src/context.ts`): простой без клиентов хост не останавливает. Останавливает его выход из приложения (quit-guard), отвязка или выключение переключателя (решение 21). Main уже перезапускает хост при его падении; с привязанным Telegram main держит хост запущенным, пока запущено приложение, и без окна (проверить в `host-launcher.ts`, что перезапуск не требует открытого окна; если требует — добавить).

### 8.2 Модуль

| Файл | Роль |
|---|---|
| `poller.ts` | `getUpdates`, offset, сторож, backoff на 409, статус канала |
| `outbox.ts` | очередь отправки на токен, 429 `retry_after`, приоритет карточек над уведомлениями, повтор только неотправленного |
| `ingress.ts` | проверка владельца, разбор `message` и `callback_query`, маршрутизация |
| `link.ts` | одноразовый код, `/start <code>`, подтверждение |
| `cards.ts` | карточки разрешений, вопросов, планов и помощника; таблица `shortId`; закрытие |
| `assistant-bridge.ts` | вопросы помощнику, typing, доставка ответов и карточек, напоминания |
| `notify.ts` | поводы needs you, finished, письма и упоминания; склейка за 3 с |
| `voice.ts` | `getFile`, декодирование, `whisper-cli`, удаление файлов |
| `format.ts` | HTML-экранирование, обрезка до 4096, повтор простым текстом |
| `state.ts` | `~/.parley/telegram/state.json`, атомарная запись |
| `../methods/telegram.ts` | методы 8.5 и событие `telegram.changed` |

### 8.3 Что переезжает в core

Чистые функции внимания из `renderer/attention/derive.ts` (`sessionAttention`, `roomAwaitsDecision`, `humanUnreadLetters`, `humanUnreadMentions`, `isHumanUnread`, `isHumanMention`) и сводка запроса `renderer/attention/ask-summary.ts` — в `@parley/core/attention`; окно реэкспортирует. Это то, что планировала спека удалённого доступа §7; хосту они нужны, чтобы считать поводы для Telegram теми же правилами, что окно. Зависимости derive от renderer (`room-remark`, `iso-time`, `room-archive`, `tree-order`, `store/activity`) переносятся или заменяются аргументами; поведение окна не меняется, его тесты остаются.

### 8.4 Что хосту нужно знать о помощнике

Настройки помощника живут в `ui.json` у main. Хосту для Telegram и напоминаний нужны `enabled`, `provider`, `model`, `language`. Новый метод `assistant.configure { enabled, provider, model, language, voiceModel }`: main зовёт его при подключении к хосту и в `onUiSaved`, хост держит последнее значение в памяти (не на диске: источник правды остаётся `ui.json`). `voiceModel` — `ui.voice.model`, если `ui.voice.enabled` и модель скачана, иначе `null` (решение 15). Пока зеркала нет (старое окно) — помощник для Telegram считается выключенным, голос — недоступным.

Путь к движку голоса: main передаёт хосту `PARLEY_WHISPER_DIR` (каталог с `bin/whisper-cli` и моделью VAD, как находит `resolveEngine`) и `PARLEY_WHISPER_MODELS` (каталог моделей) в env при запуске хоста (`host-launcher.ts`); эти пути за время работы не меняются. Нет переменных или `voiceModel === null` — голосовые в Telegram получают ответ «Turn on Voice input in Settings → Voice on your Mac» и не расшифровываются.

### 8.5 Методы и событие

| Метод | Параметры | Что |
|---|---|---|
| `telegram.setToken` | `{ token }` | формат `^\d{6,}:[A-Za-z0-9_-]{30,}$`, иначе `bad_request` без эха; `getMe` с таймаутом 15 с и до 3 попыток при сетевой ошибке; 401 → `bad_request` «Telegram rejected the token»; успех → `writeSecret('telegram', token)`, сброс состояния по 9.5, старт опроса, ответ `{ botUsername, hint }` |
| `telegram.clearToken` | `{}` | стоп опроса, `clearSecret('telegram')`, удаление `state.json` |
| `telegram.link` | `{}` | новый одноразовый код (9.1), ответ `{ code, expiresAt, deepLink }` |
| `telegram.unlink` | `{}` | `owner = null`, карточки закрываются «Unlinked» |
| `telegram.takeOver` | `{}` | снова начать опрос после 409 (решение 16); другой Mac получит 409 и остановится |
| `telegram.status` | `{}` | `{ enabled, token: 'none' \| 'set', botUsername, hint, owner: { username, linkedAt } \| null, pendingLink: { expiresAt } \| null, polling: 'off' \| 'ok' \| 'conflict' \| 'error', error: string \| null, lastUpdateAt }` |
| `settings.set` | ключи 11.2 | переключатели |

Событие `telegram.changed` = `telegram.status` после любого изменения; окно показывает его в настройках. Методы доступны только окну (не острову: `ISLAND_METHODS` не расширяется).

## 9. Доступ и привязка

### 9.1 Поток

1. Settings → Notifications → Telegram: человек вставляет токен бота (создал у @BotFather сам; в подсказке — одна строка, как его получить) и нажимает **Check**. Хост делает 8.5 `setToken`; настройки показывают «@parley_evgeniy_bot · ••••abcd».
2. **Link Telegram**: хост делает код — 6 групп по 4 символа из алфавита без 0/O/1/I (`crypto.randomInt`), срок 10 минут, одна активная попытка; хранится только `sha256` кода. Окно показывает код, ссылку `https://t.me/<bot>?start=<code>` и QR с этой ссылкой (QR рисует renderer; библиотека без зависимостей на `canvas`, например `qrcode` с SVG-выводом — выбор строителя).
3. Человек на телефоне открывает ссылку или пишет боту `/start <code>`. Бот принимает `/start <code>` от любого `from.id` в личке, пока код жив: совпал хеш → `owner = { userId, chatId, username, linkedAt }`, ответ «Linked to Parley on <имя Mac>. You will get requests and can ask the assistant here.»; не совпал → молчание и `attempts += 1`; после 5 попыток код сгорает. Чужой `/start` без кода или с чужим кодом ответа не получает.
4. Настройки показывают «Linked: @username · since …» и **Unlink**. Отвязка — только на Mac.

Паринг в обратную сторону, чем у OpenClaw (там код выдаёт бот незнакомцу, одобряет владелец вне Telegram; обзор §2.1): у Parley код рождается на Mac, потому что подтверждение всё равно на Mac, а бот не должен отвечать незнакомцам ничем.

### 9.2 Проверка отправителя

До любого действия: принимаются только `message` и `callback_query` из private chat, где `chat.id === owner.chatId` и `from.id === owner.userId`. Всё остальное (чужие личные сообщения, группы, каналы, правки сообщений, реакции) отбрасывается молча и до разбора. Исключение — `/start <code>` при живом `pendingLink` (9.1). `callback_query` чужого отвечается пустым `answerCallbackQuery` (чтобы у него погас индикатор) и забывается. Один владелец; `owner` меняется только через Unlink → Link.

При старте опроса после включения, привязки или **Use this Mac** первый `getUpdates` идёт с `offset = -1` и `timeout = 0`: всё, что накопилось, пока бот был выключен или опрос стоял, пропускается (решение 22). Дальше `offset = last + 1`.

### 9.3 Команды

Только три, в меню бота (`setMyCommands` при привязке): `/status` — то же, что вопрос «что происходит» (ход помощника); `/new` — `assistant.reset`; `/help` — одно сообщение с тем, что умеет бот. Всё остальное — текст помощнику.

### 9.4 Состояние

`~/.parley/telegram/state.json` (каталог 0700, файл 0600, атомарная запись): `version`, `botId` (числовой префикс токена), `tokenFingerprint` (первые 16 hex sha256), `botUsername`, `owner | null`, `pendingLink | null` (`codeHash`, `expiresAt`, `attempts`), `offset`, кольцо последних 100 `update_id`, `cards` (`shortId → { ref, cardId, kind, chatId, messageId, at }`, чистится после закрытия и по возрасту 7 дней), `assistantMessages` (сообщения карточек помощника: `proposalId → messageId`). Журнал действий из Telegram — `~/.parley/telegram/audit.jsonl`: `{ at, kind: 'decision' | 'assistant' | 'reply' | 'link' | 'unlink', shortId?, cardId?, text? (первые 200 знаков), result }`.

### 9.5 Смена токена и бота

Новый `botId` → сброс `owner`, `offset`, `cards`, `pendingLink`. Тот же `botId` с новым отпечатком (перевыпущенный токен) → только `offset`. `clearToken` удаляет `state.json`. Второй Mac с тем же токеном: Telegram отвечает 409 прежнему опросу, когда приходит новый. Хост, получивший 409, **останавливает опрос** (`polling: 'conflict'`), показывает в настройках «Another Parley is using this bot» и кнопку **Use this Mac** (`telegram.takeOver`); сам он опрос не возобновляет до этой кнопки или следующего старта хоста (решение 16). Backoff по 409 не делается: два опроса по очереди делили бы `update_id` и теряли нажатия. Уведомления и карточки в состоянии `conflict` не отправляются и не копятся. Это и есть решение 13: один бот на один Mac.

## 10. Что приходит в Telegram и что в нём можно нажать

Все тексты — английские, в `host/src/telegram/texts.ts` (у хоста нет `shared/strings.ts`; тот же принцип: только английский, одна константа на фразу). Ответы помощника — на его языке.

### 10.1 Карточки запросов агентов

Повод: карточка ленты сессии перешла в `pending` (хост видит это там же, где остров: `FeedService` публикует изменения; подписка модуля — внутренняя, без `Client`). Для сессий Codex — только если `codexApprovals` включён и карточка удержана (`decisions` снимка — `window`); иначе уведомление без кнопок «S03 Ruslan needs you at your Mac».

Сообщение (HTML): `<b>S03 Ruslan</b> · Parley · my_harnas` / `Permission: Bash` / `<pre>rm -rf dist</pre>` (команда или правка до 1500 знаков; план — первые 1500 знаков; вопрос — текст и варианты) / `Expires with the session's turn`.

Кнопки:
- `permission`: **Allow** и **Deny**; **Allow always** — только при `suggestions`; **Deny with a note…** нет (ответ текстом не поддерживается в v1).
- `question`: по кнопке на вариант первого вопроса (подпись до 64 знаков, в ответ уходит полный label), по одной в ряд; **Other…** — следующий текст владельца становится ответом (ожидание 10 минут, помечено в `state.cards`). Несколько вопросов в одной карточке — по очереди, одним сообщением на вопрос.
- `plan`: **Accept** (`auto-accept`) и **Approve each edit** (`manual`; дальше каждая правка придёт карточкой разрешения, если включён Needs you). Обе кнопки одобряют план (решение 14).

**Решение ведущего в комнате** (слот `room.proposal` появился или сменился `rev`): сообщение `<b>Auth</b> · Parley · my_harnas` / `Decision from S01 Ruslan` (или `Completion from S01 Ruslan`) / текст до 1500 знаков. Кнопки **Accept** и **Return…**. **Return…** → ответ «Send a note for S01 within 10 minutes, or /skip», следующий текст владельца — заметка (ожидание помечено в `state.cards`), `/skip` — без заметки. Нажатие → `rooms.resolveProposal` с `proposalId`, `rev`, `planId`/`planRev` из записи карточки; `ProposalConflictError` → квитанция «Revised — see the new text below», и новое сообщение с новым текстом приходит как обычный повод. Закрытие на всех поверхностях: слот опустел или сменился `rev` → квитанция «✅ Accepted», «↩ Returned» или «Revised» по тому, что случилось.

`callback_data`: `pc1:<shortId>:<код решения>`, `shortId` — 8 символов base62 из `crypto`, таблица в `state.cards` (запись карточки ленты: `ref`, `cardId`, `kind`; записи решения комнаты: `projectPath`, `workId`, `roomId`, `proposalId`, `rev`, `planId?`, `planRev?`). 64 байта с запасом; путей и id сессий в `callback_data` нет.

Нажатие: `answerCallbackQuery` сразу и пустой; проверка владельца; `feed.decide`; при `applied: true` сообщение правится в квитанцию «✅ Allowed · 14:07» без кнопок; при `applied: false` — «Already answered at your Mac» без кнопок. Карточка, решённая на острове, в окне или в терминале, закрывается в Telegram по тому же событию ленты (`state !== 'pending'`), текст квитанции по состоянию: `allowed`, `denied`, `answered`, `elsewhere` → «Answered at your Mac», `stale` → «Expired». «message is not modified» — успех; если правка не удалась — снять кнопки отдельно.

### 10.2 Уведомления

Поводы считаются функциями 8.3 по `works.onChange` и `activity.onChange` хоста, только на переход «не было → есть» (как push в спеке удалённого доступа §7), с склейкой за 3 с:

| Повод | Переключатель | Сообщение | Кнопки |
|---|---|---|---|
| Сессия перешла в `blocked` без карточки (терминал) | Needs you | «S03 Ruslan needs you · Parley · my_harnas» + последние 2 строки ответа | нет |
| Новая ждущая карточка | Needs you | карточка 10.1 | по виду |
| Решение ведущего ждёт человека (`roomAwaitsDecision`, новый слот или новый `rev`) | Needs you | карточка решения комнаты 10.1 | **Accept**, **Return…** |
| Сессия закончила ход (`unseen`) | Finished | «S03 Ruslan finished · Parley · my_harnas» + последние 2 строки ответа, `disable_notification: true` | нет |
| Новое письмо человеку или `@human` в комнате | Mail and mentions | «S02 → you · Auth: <текст до 1500>» | нет; **reply** на это сообщение = ответ в комнату (10.4) |
| Карточка помощника | Assistant cards | 10.3 | **Send/Create/Allow…** и **Cancel** |
| Ошибка канала (401, 409 дольше 10 мин) | всегда | в настройках, не в Telegram | — |

Без привязки, при выключенном **Send to Telegram** или с выключенным переключателем вида ничего не уходит и не копится (решения 20–21).

### 10.3 Помощник в Telegram

- Текст владельца, не являющийся командой и не reply на письмо/вопрос, уходит в `assistant.ask` — и при ждущей карточке тоже: фразы подтверждения в Telegram не распознаются, карточки подтверждаются только кнопками (решение 17). Такой текст уходит (до 4000 знаков; длиннее — ответ «Too long, up to 4000 characters») с `origin: 'telegram'`. Пока ход идёт — `sendChatAction typing` раз в 4 с. Новый текст во время хода — обрывает ход (`cancel`) и начинает новый, как на острове. Ответ — одним сообщением после конца хода (без стриминга); длиннее 4096 — нарезка по абзацам, порядок гарантирован очередью.
- Ответ хода с `origin: 'island'` в Telegram не дублируется; ответ с `origin: 'telegram'` или `'reminder'` уходит в Telegram и показывается на острове.
- Карточка помощника (`AssistantProposal`) при `origin: 'telegram'`, при `origin: 'reminder'` и при включённом переключателе Assistant cards для хода с острова: «Send to S02 Ruslan · Parley · my_harnas» / текст / **Send** **Cancel**; «Create room Auth · S02, S04 · lead S02» / задача / **Create** **Cancel**; «Allow S03 Ruslan? Bash: rm -rf dist» / **Allow** **Cancel**. `callback_data` `pa1:<proposalId>:<send|cancel>`. Решение — `assistant.decide`; `applied: false` → «This card is no longer current». Карточка, решённая на острове, в Telegram правится в квитанцию «✅ Sent», «✅ Done», «Cancelled».
- Ошибки хода (`phase: 'error' | 'offline'`) уходят текстом `error` как есть («GLM CLI is not installed»).
- Помощник выключен (8.4) → «Turn on the assistant in Settings → Assistant on your Mac».

### 10.4 Ответ на письмо

Reply (цитата) на уведомление о письме или упоминании: текст владельца уходит `rooms.send { roomId, to: [from письма], text, kind: 'note' }` через `sendHumanLetter` без `via` (это сам человек) — решение 9. Reply на что-либо другое — обычный вопрос помощнику. Подтверждение — реакция «👍» на сообщение владельца (`setMessageReaction`; если метод недоступен — ответ «Sent to S02»).

### 10.5 Голосовые

Владелец присылает voice → `getFile` → файл в `~/.parley/telegram/tmp/` (0600) → декодирование OGG/Opus в WAV 16 кГц моно (спайк 12.1 решает чем) → `whisper-cli` с моделью `voiceModel` из зеркала настроек (8.4) и теми же аргументами, что у окна (`-l <язык помощника>`, `--vad`) → текст уходит как 10.3, а перед ответом бот показывает «🎤 <распознанный текст>» (чтобы было видно, что он услышал). Файлы удаляются в `finally`. Дольше 2 минут — «Voice up to 2 minutes». Звук в сторонние STT не уходит.

## 11. Настройки

### 11.1 Settings → Notifications

Под существующими четырьмя переключателями — раздел **Telegram**:

- Переключатель **Send to Telegram** (`telegramEnabled`, решения 20–21) — первым в разделе; выключен → строка состояния «Off», опрос стоит, ничего не уходит, остальные элементы раздела приглушены, токен и привязка на месте.
- Строка состояния: «Off» / «Not set up» / «@bot · ••••abcd · not linked» / «Linked: @username · since 19 Oct» / «Error: Telegram rejected the token» / «Another Parley is using this bot» с кнопкой **Use this Mac**.
- Поле **Bot token** (password-поле, подсказка «Create a bot with @BotFather and paste its token»), кнопка **Check** (`telegram.setToken`), **Remove** (`clearToken`).
- Кнопка **Link Telegram** → код, ссылка и QR на 10 минут; после привязки — **Unlink**.
- Переключатели видов (только при привязке и включённом Send to Telegram): **Needs you**, **Finished**, **Mail and mentions**, **Assistant cards** — по умолчанию включены все, кроме Finished.
- Подсказка: «Messages go through Telegram servers and are stored there. Requests and replies work only while this Mac is awake and Parley is running.»

### 11.2 Ключи

В `ParleyConfig` хоста (плоско, как остальные; env-имена рядом): `telegramEnabled` (`TELEGRAM_ENABLED`), `telegramNeedsYou` (`TELEGRAM_NEEDS_YOU`), `telegramFinished`, `telegramMail`, `telegramCards` — булевы; умолчания `true, true, false, true, true`. Токен и владелец — не в конфиге (9.4, 8.5). В `ui.json` ничего нового: состояние окно берёт из `telegram.status`/`telegram.changed`.

## 12. Спайки до плана этапа B

1. **Голосовые.** Принимает ли `whisper-cli` из `build/whisper` OGG/Opus напрямую (`-f voice.oga`)? Если да — декодер не нужен. Если нет — выбрать декодер без нативных зависимостей (`ogg-opus-decoder`, WASM, MIT) или `afconvert`, если CoreAudio берёт Ogg/Opus на macOS 14+; замерить 30-секундное голосовое. Результат — раздел A.1 этой спеки.
2. **Прокси.** Берёт ли `fetch` Node 22 `HTTPS_PROXY` сам; если нет — `EnvHttpProxyAgent` из `undici` (уже в Node). Проверить `getMe` через прокси из `shell-env`.
3. **Bot API.** Ручной прогон с реальным ботом автора: `getUpdates` с `timeout=25`, 409 при двух опросах, `editMessageText` с `inline_keyboard: []`, `setMessageReaction`, `sendChatAction`, `disable_notification`. Тест-бот и чат автора; токен в репозиторий не попадает.

## 13. Проверки

- **Юнит (core):** функции внимания после переезда — тесты окна остаются зелёными; `ProposalCardView.summary` для permission/question/plan.
- **Юнит (host):** `propose_room` (валидация, `rooms.create` + письмо, исход), `propose_decision` (одна/несколько/ноль карточек, `always` без `suggestions`, `applied: false`), `propose_room_decision` (нет слота, `return` с заметкой, конфликт `rev`, `completion` с `planId`/`planRev`), напоминания (файл, перезапуск, late, повтор, лимит 10), `link` (код, хеш, 5 попыток, срок), `ingress` (чужой отправитель, группа, правка, чужой `callback_query`), `cards` (`shortId`, квитанции по всем состояниям, закрытие по событию ленты; решение комнаты: Return… с заметкой и `/skip`, конфликт `rev`, закрытие при новом `rev`), переключатель Send to Telegram (выкл → нет опроса и отправок, хост не удерживается; вкл → первый `getUpdates` с `offset = -1`), `outbox` (429 `retry_after`, порядок нарезки), `format` (экранирование, повтор без `parse_mode`), `poller` (offset после записи, 409 → стоп и `conflict`, `takeOver`), маскировка токена в логе; всё с фейковым `fetch`, без сети.
- **Юнит (desktop):** карточки комнаты, решения и решения по комнате на острове (кнопки, Enter, фразы, замена, «Done ✓», «Revised, look again»); раздел Telegram в настройках (состояния строки, код и QR, переключатели только при привязке).
- **E2E:** остров — карточка решения поверх карточки ленты и её отмена; настройки — раздел Telegram с фейковым хостом (`telegram.status`).
- **Живая приёмка автора:** привязка через QR, Allow из Telegram на реальном разрешении Claude, Accept и Return… на решении ведущего, выключение Send to Telegram во время работы комнаты, закрытие карточки при ответе на острове, «проверь через 2 минуты» из Telegram, создание комнаты голосовым, reply на письмо, выключенный помощник, второй опрос того же бота (409), выход из приложения.

## 14. Рамка

- Выключено по умолчанию: без токена и привязки хост не ходит в Telegram вообще; переключатель Send to Telegram гасит канал целиком.
- Только человек решает: бот передаёт нажатие в `feed.decide`/`assistant.decide`; «авто-allow», политик и ответов за человека нет; напоминание только докладывает.
- Один владелец, один бот, один Mac; чужим бот не отвечает ничем.
- Пишем только в `~/.parley` (`secrets.json`, `telegram/`, `assistant/reminders.json`).
- Токен — только у хоста, в логах и Diagnostics — отпечаток; шаблоны маскировки `bot\d{6,}:[A-Za-z0-9_-]{20,}` и голого токена — в core (хост не импортирует `desktop/shared/redact.ts`).
- Нет API-ключей Parley, нет Keychain (как у ключа Z.ai).
- Звук — только локальный Whisper; сторонних STT нет.
- Всё видно: журнал `audit.jsonl`, карточки закрываются на всех поверхностях, отвязка на Mac.
- Старый хост с новым окном: окно прячет раздел Telegram, если `telegram.status` отвечает `method not found`; старое окно с новым хостом: карточки `room`/`decision` не шлются (5.1).

## 15. Что оставлено строителю

- Как остров объявляет поддержку новых видов карточек (5.1) и где именно он выбирает между карточкой помощника и карточкой ленты (6).
- Устройство очереди `outbox` и таблицы `shortId`; формат `audit.jsonl`.
- Библиотека QR (без нативных зависимостей) и вид раздела в настройках по образцу раздела Assistant.
- Как main передаёт хосту каталоги Whisper (env в `host-launcher.ts`) и где в `onUiSaved` звать `assistant.configure`.
- Точные тексты бота (английские, короткие, без слов OpenClaw).

## 16. Открытые вопросы

1. **Этап C** (запуск, остановка, архив сессий, роли) — после приёмки B или раньше? Пока вне спеки.
2. **Уведомления macOS, когда окно закрыто.** Сейчас их нет (считает renderer). После переезда функций в core хост мог бы слать их и без окна — отдельная тема, здесь не делается.
3. **Имя помощника** (спека помощника, 15.1) — в текстах бота везде «the assistant».

## Приложение A. Результаты спайков (2026-10-20)

### A.1 Голосовые

`whisper-cli` из сборки приложения (`Parley.app/Contents/Resources/whisper/bin/whisper-cli`, whisper.cpp с miniaudio) OGG/Opus **не читает**: `read_audio_data: failed to read audio data` на файле, который сделал `ffmpeg -c:a libopus` (48 кГц, моно, 32 кбит/с — как у голосовых Telegram). `afconvert` контейнер Ogg тоже не открывает. Тот же звук в WAV 16 кГц моно распознаётся.

Декодер: **`ogg-opus-decoder` 1.7.5** (MIT, автор eshaz, чистый JS + WASM, без нативных зависимостей; тянет `opus-decoder`, `codec-parser`, `@wasm-audio-decoders/common`, `simple-yenc`). `await decoder.decodeFile(bytes)` → `Float32Array[]` на 48 кГц; усреднение по 3 отсчёта даёт 16 кГц; WAV-заголовок — 44 байта (как `main/voice/wav.ts`). Замеры на M-серии: голосовое 4 с — декод 21 мс; 17 с — декод 39 мс, `whisper-cli -m ggml-large-v3-turbo-q5_0 -l en --vad --vad-model ggml-silero-v6.2.0.bin` — 1,3 с, текст точный. Решение: декодер в хосте (`telegram/voice.ts`), файл `.oga` → PCM → WAV во временном каталоге → `whisper-cli` с теми же аргументами, что у окна.

### A.2 Прокси

Хост идёт под Node из Electron (Electron 44.4.5 → **Node 24.21.0**). `fetch` там честно берёт `HTTPS_PROXY` **только при `NODE_USE_ENV_PROXY=1`**: с переменной и прокси `http://127.0.0.1:9` запрос упал `ECONNREFUSED` (пошёл в прокси), без переменной — ушёл напрямую и получил 401 от `api.telegram.org`. `undici` как зависимость не нужен. Решение: `host-launcher.ts` ставит `NODE_USE_ENV_PROXY=1` в окружение хоста (флаг безвреден без переменных прокси); `HTTPS_PROXY`/`https_proxy`/`NO_PROXY` берутся из окружения входа, как и сейчас для CLI (решение 11).

### A.3 Bot API

Живой прогон с ботом автора **не сделан**: токена у исполнения нет и быть не должно. Поведение `getUpdates` (`timeout=25`, 409 при втором опросе, `offset=-1`), `editMessageText` с пустой клавиатурой, `setMessageReaction`, `sendChatAction`, `disable_notification` взяты из документации Bot API и обзора OpenClaw (§3–4); все тесты — с фейковым `fetch`. Прогон 12.3 переносится в живую приёмку автора (раздел 13): первый же запуск с настоящим токеном покажет расхождения, модуль должен переживать неожиданные ответы (401/409/429/5xx, `description` без `ok`) без падения хоста.
