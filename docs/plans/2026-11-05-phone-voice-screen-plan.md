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

### T4 · Карточки на телефоне — ждёт решения человека

Нужна новая remote-поверхность: проекция активных карточек помощника (`cardId`, `revision`, `kind`, краткий текст,
`dangerous`, `expiresAt`, `jobId?`), событие и метод снимка при переподключении, правила параметров, allowlist моста и
хоста, тесты на запрет остального. Экран: R06 поверх карточек, `cards.decide`, опасные — через `confirmWithOwner`
(Face ID до вызова). Без решения человека не начинается.

### T5 · Критик и безопасность (Opus) — после T1–T3

Независимое ревью кода и remote-поверхности: что телефон получает от хоста (проекция job, конфиг сессии, SDP-ответ),
расход OpenAI (лимит, закрытие при фоне, idle), ключ OpenAI не покидает Mac. Файл ревью:
`docs/audits/2026-11-05-phone-voice-review.md`. Затем typecheck/lint/тесты один раз на итоговой ветке.

## Not verified (заранее)

- Реальный звук, задержка, barge-in, Face ID, фон/блокировка — на iPhone проверяет человек (V1-E).
- VO-02/VO-03 («Сколько агентов?» через `overview()`) — путь хоста; на телефоне проверяется только вручную.
- Контекст поручения (реплики, открытые поручения) с телефона не передаётся (протокол `jobs.submit`).
