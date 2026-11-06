# План: голосовой помощник Parley на iPhone (VM1/B5 + VM0)

Дата: 2026-11-05. Лид: s-282 (Opus). Владелец: s-38. Комната r-24.
Источник истины: `docs/plans/2026-11-03-voice-assistant-core-plan.md` — разделы VM0, VM1/B5 (критерии VO-01…07, VO-15);
спека `docs/specs/2026-11-03-voice-remote-notifications-spec.md` §3–§4; `docs/specs/2026-11-04-voice-assistant-modules-design.md`;
handoff `docs/design/2026-11-03-jarvis-handoff/` (`ORB_MOTION_SPEC.md`, `design/orb-spec.js`, `orb-states.json`, `tokens.ts`).
База: `origin/master` 404596d4 (v0.30.0). Ветка работы: `parley/w-0054/s-282`; итоговая ветка `feat/mobile-voice-assistant` указывает на тот же коммит.

## Что проверено на master (s-282, 2026-11-05)

- Remote-поверхность A: `jobs.submit/get/cancel/ackInline`, `cards.decide`, `voice.session.prepare/close`, `voice.usage.get`;
  события `jobs.changed`, `voice.session.closed` (`packages/protocol/src/remote/allowlist.ts:50-70`, схемы `remote/voice.ts`).
- `packages/host/src/methods/voice.ts:32-35`: для `remote` клиента `prepare` идёт без `liveSessionConfig()` (заглушка).
- `@parley/core/voice-live`: мост делегаций, очередь речи, ack, status, idle-close, телеметрия — чистый TS.
- Разбор событий канала `oai-events` живёт только в острове: `packages/desktop/src/renderer/island/live/events.ts`
  (без импортов, чистый TS). Эталон проводки — `island/live/delegation.ts` и `island/live/controller.ts`.
- Телефон: `react-native-webrtc` 155.0.1, `incall-manager`, `reanimated` 4.7.1, `react-native-svg` 15.16.0,
  `expo-local-authentication`; модель `mobile/src/voice/voice-model.ts` (состояния и `orbStateOf`); `auth/confirm-owner.ts`;
  события хоста — `supervisor.onEvent` в `remote-client/src/supervisor.ts:165`, вызов — `AppRuntime.call`.
- **Сферы (VM0) на master нет** — компонента `mobile/src/voice/orb/` не существует.
- **Пробел карточек:** телефон не видит карточек помощника. `assistant.card.changed` в remote-события не входит
  (`assistant.*` запрещён, `allowlist.ts:157`), метода списка карточек нет; `cards.decide` вызвать не с чем
  (`cardId` = `proposalId` вида `pN`, `revision` — ревизия карточки, не job). Решение — у человека (вопрос s-38).

## Отличия от плана 2026-11-03

1. VM0 по плану senior-only («нельзя специфицировать без прототипа»). Теперь все параметры движения сгенерированы в
   `ORB_MOTION_SPEC.md` из `orb-spec.js`, прототип есть — задача специфицируема, её делает junior (Sonnet) по данным
   `orb-spec.js`; лид проверяет витрину, человек сверяет с R21 на устройстве.
2. Телефонный протокол `jobs.submit` не несёт `context` моста (последние реплики, открытые поручения), в отличие от
   `requests.submit` острова. В этой работе контекст не передаётся; это отмечается в «Not verified».
3. `turnId` в correlation телефона = `delegationId` (у Live отдельного turn id нет).

## Задачи

Каждая задача — один исполнитель Sonnet, одна задача за раз; тесты → ревью лида → коммит лида.

### T1 · Контроллер Live на телефоне + перенос разбора событий + снятие заглушки хоста

- **Файлы:**
  - `packages/core/src/voice-live/live-events.ts` (+ тест): перенос `desktop/.../island/live/events.ts` без изменений
    логики; экспорт из `voice-live/index.ts`; остров импортирует из `@parley/core/voice-live`, старый файл и тест удалены
    (тест переезжает). `import-guard.test.ts` остаётся зелёным.
  - `packages/mobile/src/voice/live-controller.ts` (+ `live-controller.test.ts`): чистый TS, без React; зависимости
    внедряются: `call(method, params)`, `onHostEvent(listener)`, фабрика peer/канала/микрофона, `now`, `setTimer`, `setTick`.
  - `packages/mobile/src/voice/live-peer.ts`: проводка на `react-native-webrtc` + `incall-manager` (по образцу
    `src/dev/voice-loopback.ts`), без логики.
  - `packages/host/src/methods/voice.ts`: `prepare` всегда с `liveSessionConfig()`; тест в `voice.test.ts`
    (remote-клиент получает инструкции и `delegation: client`; `remoteVoice=false` по-прежнему отвергается).
- **Поведение контроллера:**
  1. `start()`: микрофон → peer → канал `oai-events` → offer → `voice.session.prepare {sdp}`; `ok:false` → отказ с кодом
     `no_key | limit_reached | busy | failed`; ошибка микрофона → `mic`; таймаут подключения как у острова.
  2. Сообщения канала → `parseLiveEvent` (core) → `createDelegationBridge` (`delegationCreated`, транскрипты).
     Реплика собирается только мостом core: своей сборки по `offset_ms` на телефоне нет (b-027 — общий подозреваемый,
     починка в core должна покрыть остров и телефон; b-027 в эту работу не входит).
  3. `bridge.submit` → `jobs.submit {text, idempotencyKey, correlation: {voiceSessionId, delegationId, turnId: delegationId}}`;
     `idempotencyKey` детерминирован из `voiceSessionId`+`delegationId` и проходит `REMOTE_ID_RE` (`^[\w.:-]{1,64}$`) —
     короткий хеш, не обрезка. Ответ → `{requestId: jobId, jobId, created: true}`.
  4. `jobs.changed` только для job этой сессии (`correlation.voiceSessionId`) → `status` (`session.thinking.append`) и
     очередь речи (`session.commentary.append`, ≤ 500 токенов — правило очереди core).
  5. VO-15: job `cancelled` и событие с `revision` ≤ уже виденной никогда не озвучиваются; итог старой делегации,
     перекрытой новой в той же сессии, помечается `stale` по правилу очереди core.
  6. `appended(commentary)` → `jobs.ackInline {jobId, revision}` только если `foreground && !muted` (сеттеры контроллера).
  7. `voice.session.closed` от хоста или `stop()` → `voice.session.close`, микрофон и peer закрыты, мост и очередь
     освобождены; jobs не отменяются (VO-04).
  8. Наружу: подписка на события для `voice-model.ts` (`connected`, `speechStart/End`, `thinking`, `delegateStart/End`,
     `limitReached`, `fail`, `stop`) и снимок (`voiceSessionId`, активные jobs этой сессии).
  9. В контроллере нет пути к `cards.decide`: голосом карточку не решить (VO-06).
  10. Тексты, SDP и ключ не логируются.
- **Критерии приёмки:** тесты на fake data channel: (a) делегация → один `jobs.submit` с верной correlation и ключом;
  повтор того же `delegationId` — тот же ключ; (b) `completed` → `commentary.append` один раз; повторное событие той же
  ревизии — ничего; (c) `cancelled` и устаревшая ревизия не озвучены; (d) ack только в foreground без mute; (e) `stop()`
  закрывает сессию и не отменяет job; (f) `ok:false` для каждого кода → нужное событие модели; (g) нет вызова
  `cards.decide` ни в одном сценарии. Остров: его тесты зелёные без изменения ожиданий. Хост: `voice.test.ts` зелёный.
  `pnpm -r typecheck`, lint затронутых пакетов, тесты core/mobile/host/desktop зелёные.

### T2 · Сфера «Джарвис» (VM0) — параллельно T1

- **Файлы:** `packages/mobile/src/voice/orb/` (новый): `orb-spec.ts` (типизированный перенос параметров и `simulate()`
  из `design/orb-spec.js`, задержки 150 и 400 мс), `Orb.tsx` (`react-native-svg` + `reanimated`), тесты переходов;
  палитра A в теме (`packages/mobile/src/components/ui.tsx` или `theme`); витрина 10 состояний в `src/app/bench.tsx`.
- **Критерии приёмки:** 10 состояний (`orb-states.json`), размеры 168 и 32 (мини при d ≤ 48), reduced motion выключает
  циклы (`useReducedMotion`), переходы совпадают с `simulate()` (тесты перенесены), имя в UI — «Parley». Только
  существующие нативные модули. typecheck/lint/тесты mobile зелёные.

### T3 · Голосовой экран — после T1 и T2

- **Файлы:** `packages/mobile/src/app/(tabs)/voice.tsx` (новый), `(tabs)/_layout.tsx`, `mobile/src/voice/use-live-voice.ts`
  (хук: контроллер + `voice-model` + AppState), компоненты экрана в `mobile/src/voice/`.
- **Поведение:** вкладка Voice первая и открывается при запуске; Inbox/Works/Settings и переходы из push работают
  (VO-01). Сфера 168 по `orbStateOf`; подписи состояний (connecting скрыт первые 150 мс). Кнопки старт/стоп и mute.
  Шаблон R15 с текстовым полем для: нет доступа к микрофону, дневной лимит (`limit_reached`, остаток из `voice.usage.get`),
  нет ключа на Mac (`no_key`), голос выключен на Mac (`canUseVoice=false`), Mac недоступен (`offline`). Строка «ход
  работы» — состояние последнего job экрана. Текстовое поле → `jobs.submit {text, idempotencyKey: uuid, correlation:
  {mode:'text'}}`; итог показывается один раз и подтверждается `jobs.ackInline` на экране в foreground (VO-05).
  `needs_confirmation` → «Confirm on Mac» (пока нет решения по карточкам, T4). Уход в фон → `stop()`: сессия закрыта,
  микрофон выключен; job продолжается.
- **Критерии приёмки:** VO-01, VO-04/05, VO-06 (голос не решает карточку), VO-07 (лимит и нет ключа → R15 с текстом);
  тесты чистых частей (выбор шаблона R15, строка хода работы, AppState → stop); typecheck/lint/тесты mobile зелёные.

### T4 · Карточки на телефоне

Решение человека 2026-11-05 (через s-38, вариант A): карточки на телефоне в этой ветке. Покрывает backlog sg-22.

**T4a · Remote-поверхность карточек (хост + протокол) — параллельно T1/T2.**

- **Файлы:** `packages/protocol/src/remote/cards.ts` (новый: схема и проекция), `remote/allowlist.ts` (A-список: метод
  `cards.list`, событие `cards.changed`; правило параметров `cards.list` — `strictObject({})`), `remote/index.ts`
  (экспорт), тесты протокола; `packages/host/src/methods/assistant.ts` (`cards.list`), `packages/host/src/host.ts`
  (рассылка `cards.changed` из `assistantService.onCardChanged`), при необходимости метод чтения активных карточек с
  `view` в `assistant-service.ts`; тесты хоста; тест границы моста `packages/remote/test/` (если там перечислены события).
- **Проекция `PhoneCard`** — по явному списку полей, как `projectPhoneJob`: `cardId`, `revision`, `kind`, `state`
  (`needs_confirmation | decided | expired | superseded`), `title` (строка «что и кому»: `target` + `where`, ≤ 120 знаков),
  `text` (≤ 280 знаков, обрезка с «…»), `dangerous` (`true`, если у карточки `actions` есть шаг с `danger: true`, иначе
  `false`), `expiresAt`, `jobId` (если хост связывает карточку с job, иначе поле отсутствует). Никаких `payload`, путей,
  argv, токенов, `decidedVia`.
- **Поверхность:** `cards.list {}` → `{cards: PhoneCard[]}` — только активные; событие `cards.changed {card: PhoneCard}`
  — каждая смена состояния, включая терминальные (телефон убирает карточку). Имена не под `assistant.*`;
  `assistant.*` остаётся запрещённым. Метод и событие проходят allowlist моста и хоста (общие списки протокола).
- **Критерии приёмки:** тест проекции (лишние поля отброшены, обрезка, `dangerous`); deny-тесты: `assistant.*`
  методы и события по-прежнему отвергаются для `remote`, `cards.list` с лишним ключом — `bad_request`; хост: `cards.list`
  отдаёт только активные, `cards.changed` уходит на decide/expire; `cards.decide` со старой ревизией — `already_handled`
  (тест уже есть — зелёный). typecheck/lint/тесты protocol, host, remote зелёные.

**T4b · R06 на телефоне** — входит в T3: снимок `cards.list` при подключении + `cards.changed`; карточка поверх
экрана; «Send»/«Cancel» → `cards.decide {cardId, revision, choice}`; `dangerous` → `confirmWithOwner` (Face ID) до
вызова, отказ Face ID — ничего не отправлено; ответ `already_handled`/`expired`/`not_found` → «This card is no longer
current», карточка убрана. Голосом карточку не решить: у контроллера нет пути к `cards.decide` (тест T1).

### T5 · Критик и безопасность (Opus) — после T1–T3

Независимое ревью кода и remote-поверхности: что телефон получает от хоста (проекция job, конфиг сессии, SDP-ответ),
расход OpenAI (лимит, закрытие при фоне, idle), ключ OpenAI не покидает Mac. Файл ревью:
`docs/audits/2026-11-05-phone-voice-review.md`. Затем typecheck/lint/тесты один раз на итоговой ветке.

## Not verified (заранее)

- Реальный звук, задержка, barge-in, Face ID, фон/блокировка — на iPhone проверяет человек (V1-E).
- VO-02/VO-03 («Сколько агентов?» через `overview()`) — путь хоста; на телефоне проверяется только вручную.
- Контекст поручения (реплики, открытые поручения) с телефона не передаётся (протокол `jobs.submit`).

## Дополнение 2026-11-06 · Лицо острова вместо сферы, поле ввода над таб-баром

Решение человека (через s-38, m-3618): сферу убрать; экран Voice выглядит как помощник острова — тот же рой душ со
всеми переключениями облика (рой, рот по голосу Live, облики Live, лицо ошибки, эмоции). Чистые состояние, геометрию и
движение — в общий пакет, отрисовка — своя на каждой платформе. Эмоции на телефоне — как в острове. Плюс баг: нижнее
поле ввода залезает под таб-бар.

**Что общее (`@parley/core/swarm`, новый подпуть по образцу `voice-live`, `git mv` с историей):**

| Сейчас (остров) | Станет | Что внутри |
| --- | --- | --- |
| `desktop/.../island/swarm/spec.ts` (+test) | `core/src/swarm/spec.ts` | палитры, `EMO`, `DUR`, `BLOBS`, `swarmSpecFor`, `swarmSpecForLive`, `haloFor`, реакции |
| `desktop/.../island/swarm/engine.ts` (+test, reactions.test) | `core/src/swarm/engine.ts` | души, формы, лицо, рот, L2, реакции, шаг кадра |
| `desktop/.../island/assistant/voice-features.ts` (+test) | `core/src/swarm/voice-features.ts` | `VoiceFrame`, виземы, громкость, интонация (чистая математика) |
| `desktop/.../island/live/emotion.ts` (+test) | `core/src/voice-live/emotion.ts` | сглаживатель эмоций Decisions |

- Движок перестаёт знать о Canvas: вместо `ctx: CanvasRenderingContext2D | null` — узкий приёмник
  `SwarmSink { begin(w, h); soul(pal, colorIndex, x, y, size, alpha); end() }`. Порядок, альфа и кроссфейд палитры —
  в движке, как сейчас; спрайты и `'lighter'` — у приёмника.
- Типы, которые `spec.ts` берёт из острова (`InputPhase`, `LiveCallPhase`), объявляются в `core/swarm` как объединения
  строк; остров и телефон их используют. Тест-страж импортов, как у `voice-live` (без Node, DOM и чужих пакетов).

**Что своё на платформе:**

- Остров: `Swarm.tsx` — canvas-приёмник со спрайтами (как сейчас), без изменения облика. Тесты острова зелёные.
- Телефон: `mobile/src/voice/face/SwarmFace.tsx` — `@shopify/react-native-skia` (новая нативная зависимость):
  спрайт души — радиальный градиент Skia, души — `drawAtlas` с `BlendMode.Plus` (аналог `'lighter'`). Движок шагает на
  JS-потоке, 30 кадров/с только пока `needsFrame()` или Live активен (правило острова), иначе стоит; reduced motion — как
  в острове. 700 душ (как `AssistantView`).
- Рот: на телефоне нет доступа к PCM удалённого трека из JS. Громкость берётся из `getStats()` WebRTC
  (`inbound-rtp.audioLevel` — голос модели, `media-source.audioLevel` — микрофон для эффекта listen) примерно 20 раз/с;
  лицо в режиме `voiceMode: 'loudness'` (режим F1 движка). Виземы и интонация (L1-формы, L2) телефону недоступны без
  нативного аудио-модуля.
- Эмоции: хост снова даёт телефону триггер Decisions (как острову), контроллер телефона разбирает решения общим
  разборщиком и сглаживателем, лицо ошибки — коралл со вспышкой, как в сторе острова. Цена: по замеру спайка
  (`docs/research/2026-11-05-gpt-live-decisions-spike.md` §5) ≈0,0007 USD/мин к 0,05 USD/мин Live (≈+1,4 %).

**Задачи (исполнители Sonnet):**

- **F1 · Общий пакет.** Перенос четырёх модулей в core, приёмник вместо Canvas, остров на импортах core.
  Приёмка: тесты перенесены и зелёные в core; desktop typecheck, build и тесты зелёные (число тестов desktop меньше
  ровно на перенесённые); страж импортов; поведение острова не меняется.
- **F2 · Лицо на телефоне** (после F1 и ответа по Skia). Skia, `SwarmFace`, замена `Orb` на экране и в bench; сфера
  (`voice/orb/`, `orb-spec`, `Orb.test.ts`) удаляется. Приёмка: тест приёмника (буфер атласа из кадра движка), тест
  выбора облика по состоянию телефона через `swarmSpecForLive`; mobile tsc/lint/тесты.
- **F3 · Сигналы Live для лица** (после F1). Хост: `liveSessionConfig()` для всех клиентов (тесты); контроллер телефона —
  `emotion` (Decisions + сглаживатель + вспышка ошибки), `checking`, громкость модели и микрофона из `getStats`.
  Приёмка: тесты контроллера на эмоцию/ошибку/громкость с фейковым peer.
- **F4 · Поле ввода над таб-баром** (сразу). Нижний отступ = высота таб-бара + safe area, поле над клавиатурой.
  Приёмка: тест/модель отступа где возможно; проверка на устройстве — после сборки.
- **F5 · Критик (Opus)** — короткий проход по порту (совпадение облика с островом, перф, ресурсы), затем сборка и
  установка на iPhone.

**Открыто (вопрос к s-38):** новая нативная зависимость Skia (+несколько МБ к приложению; иначе 700 душ с аддитивным
смешением не нарисовать: `react-native-svg` и `View` такого смешения не дают); рот на телефоне — только по громкости.

**Решение человека 2026-11-06 (m-3620):**
- Skia — да.
- Рта на телефоне нет: телефон показывает только сферу роя острова, 700 душ.
  - Поддерживаются все облики роя: Live, ошибка, эмоции.
  - Облик `face` на телефоне превращается в сферу с палитрой и `dim` эмоции — так же, как мини-вид острова.
  - Во время разговора сфера пульсирует и дрожит с громкостью из `getStats().audioLevel`, около 20 раз/с.
- Нативного аудио-модуля нет.

Поправки к задачам:
- В F2/F3 рот, виземы и `voiceMode` не используются.
- Пульс громкости — опция общего движка `soundPulse` (по умолчанию выключена, остров не меняется): масштаб, яркость и
  лёгкое дрожание немедленных форм по уровню 0..1; при reduced motion — только яркость.

**Решение человека 2026-11-06 (m-3624):** отдельного переключателя `remoteVoice` нет. Голос на телефоне включён, когда на Mac
настроен голос: «Speak answers» включён и сохранён ключ OpenAI. Окно присылает «Speak answers» хосту полем `speak` в
`assistant.configure`; `voice.session.prepare` для клиента `remote` есть в `hello.methods` только при `speak: true`, а
отсутствие ключа даёт отказ `no_key` («No OpenAI key on the Mac» на телефоне). Сохранённое ранее значение `remoteVoice`
игнорируется. Состояние R15 `voice_off` теперь значит «Speak answers выключен на Mac». `cards.decide` по-прежнему зависит
от `remoteCreate`.
