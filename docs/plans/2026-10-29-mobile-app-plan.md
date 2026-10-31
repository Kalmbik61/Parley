# Мобильное приложение Parley — план

**Дата:** 2026-10-29. **Статус:** принят критиком s-93 после двух кругов (§5); поправлен по вводным человека 2026-10-29 (§5, правки 3–4), 2026-10-30 (§5, правки 5) и по итогу спайка, подтверждённому 2026-10-31 (§5, правки 6); Р1, Р2, Р3, Р8 и Р9 решены, Р4 — открытый вопрос, остальное ждёт человека. **Источник:** `docs/specs/2026-10-29-mobile-app-design.md` (дальше — «спека», ссылки «§N»).
**Исполнители:** задачи без пометки — одна сессия стандартного уровня (Sonnet или gpt-6.1-sol) на задачу, свой
worktree. Задачи **senior-only** — сессия старшего уровня (Opus, Fable или gpt-6-astra); причина названа в
задаче (PARLEY.md: крипто, граница доступа, восстановление связи). **Проверка:** verifier стандартного уровня
по критериям задачи. Задачи с пометкой «ревью senior» и все senior-only дополнительно смотрит критик старшего
уровня. **Принятие:** человек.

Ссылки на решения человека — «Р1…Р9» (спека §16).

## 0. Общие правила

- База — `master` после того, как человек примет спеку и план и они будут закоммичены. Ветка на задачу:
  `feat/mobile-<id>`, например `feat/mobile-a3-noise`.
- Язык — по `AGENTS.md`: код, тесты, README, CHANGELOG, коммиты и тексты UI — по-английски; документы в `docs/` —
  по-русски.
- Задача не расширяется. Нашёл нужное вне объёма → письмо ведущему, не правка.
- В каждом новом пакете есть скрипты `test` и `typecheck` (`tsc --noEmit`) и, кроме `packages/mobile`, `build`.
  Пакет подключается к общим скриптам корня так же, как соседние.
- ESLint — общий, из корня (`pnpm lint` = `eslint packages tools`); своего скрипта `lint` у пакетов нет. Для одного
  пакета — `pnpm exec eslint packages/<имя>`.
- Команды проверки в задачах пишутся каждая отдельно: `pnpm --filter <пакет> <скрипт>` запускает один скрипт, а
  слова после него уходят этому скрипту аргументами.
- Код, который идёт в Hermes или браузер (`@parley/protocol/remote`, `@parley/noise`, `@parley/remote-client`), не
  использует `Buffer`, `process` и `node:*`. Правило ESLint для этих путей ставит A1, проверку импорта без `Buffer`
  — A1 и A3.
- Секреты (ключи, `relayToken`, `routeSecret`, `s` из QR) не попадают ни в логи, ни в снимки тестов, ни в
  сообщения об ошибках. Тест-грепы на это есть в A4, A5, A6a, A6b, A7, A18a. SSH-креды мастера (A18a) — тоже.
- Числа замеров спайка входят в документ итогов S7; задачи этапа A на них ссылаются.

---

## 1. Этап 0 — спайк (1 неделя)

Цель — ответить на вопросы, от которых зависят решения этапа A: сборка стека, скорость крипто, связь с relay,
поведение в фоне, размер снимка. Спайк — только iPhone (Р3); Android — в отложенном блоке 2.5. Код спайка не
идёт в `master`, кроме скелета S1. S1 становится основой A13, если проходит её ревью.

Спайк идёт локально, VPS не нужен. Relay-заглушка работает на Маке, телефон ходит к ней по Wi-Fi той же сети
(спека §6.6). Firebase не нужен. Push в спайке не проверяется: APNs — только после оплаты аккаунта Apple (A24).
Проверка из мобильной сети — в A18b.

### S1. Скелет Expo в монорепозитории

- **Объём.** `packages/mobile`: Expo SDK 58, `expo-dev-client`, `expo-router` с двумя пустыми native tabs.
  Экран «Probe»:
  - скан QR через `expo-camera`, показ строки;
  - запись и чтение секрета в `expo-secure-store` с `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`;
  - события NetInfo и AppState в списке;
  - попытка взять токен APNs из `expo-notifications`;
  - импорт `@parley/core/attention` и `@parley/core/card-gist` с вызовом одной функции — проверка Metro на
    пакетах монорепозитория.
- **Файлы.** `packages/mobile/**`, правка `pnpm-workspace.yaml` / `.npmrc` только при необходимости для Metro.
- **Зависит.** Ни от чего. От человека: Apple ID в Xcode для Personal Team.
- **Приёмка.**
  1. Сборка Personal Team ставится на iPhone и проходит все пункты «Probe»; секрет переживает перезапуск
     приложения. Токен APNs без аккаунта не выдаётся — ожидаемо, записать.
  2. Есть записка `packages/mobile/SPIKE.md`: команды сборки и версии.
- **Проверка.** Verifier ставит сборку на iPhone по командам из `SPIKE.md`. Скриншоты экрана «Probe» — в итог
  S7.

### S2. Скорость крипто на Hermes

- **Объём.** В приложении S1 — экран «Bench».
  - `@noble/curves` x25519: генерация, один DH, четыре DH подряд — это стоимость рукопожатия IK.
  - `@noble/ciphers` ChaCha20-Poly1305 на 64 КиБ и 1 МиБ.
  - `@noble/hashes` SHA-256 и HKDF.
  - То же через `react-native-quick-crypto`, если ставится на SDK 58.
  - Попытка собрать `noise-handshake` в Metro: собирается ли, работает ли.

  Медиана из 20 прогонов.
- **Файлы.** `packages/mobile/src/probe/bench.ts` (только в ветке спайка).
- **Зависит.** S1.
- **Приёмка.** Таблица чисел на iPhone (модель указать; старший из доступных, не новее двух поколений). Вердикт
  по `noise-handshake`.
  Данные — в S7.
- **Проверка.** Verifier повторяет прогон на одном устройстве, расхождение медиан ≤ 30 %.

### S3a. Локальная relay-заглушка на Маке

- **Объём.**
  - Заглушка relay на Node `ws`: `GET /health`, эхо, склейка двух сокетов по ключу.
  - Слушает LAN-адрес Мака без TLS (спека §6.6). При старте печатает `ws://<IP Мака>:<порт>` и
    `http://<IP Мака>:<порт>/health`.
  - Запуск одной командой (`node` или `docker compose up`). Сервер, домен и TLS не нужны.
- **Файлы.** `remote-spike/relay-stub/` вне репозитория, рядом со старым стендом.
- **Зависит.** Ни от чего.
- **Приёмка.** С телефона в той же сети Wi-Fi `http://<IP Мака>:<порт>/health` открывается в браузере → 200. Эхо по
  `ws://` отвечает скрипту на Node с другого устройства в той же сети.
- **Проверка.** Verifier запускает заглушку по README и повторяет `curl` и скрипт эха.

### S3b. Связь телефона с локальным relay

- **Объём.** В приложении S1 — экран «Net» и dev-настройки сети:
  - успех подключения и время до первого байта;
  - RTT эха (медиана из 50);
  - передача 1 МиБ;
  - выключение и включение Wi-Fi; режим полёта на 10 с. LTE не проверяется: dev-relay из мобильной сети не
    виден, это делает A18b;
  - dev-профиль iOS: `NSLocalNetworkUsageDescription` и `NSAllowsLocalNetworking` (спека §6.6).

  Выгрузка результатов — JSON.
- **Файлы.** `packages/mobile/src/probe/net.ts` и правка `app.config.ts` в ветке спайка.
- **Зависит.** S1, S3a.
- **Приёмка.**
  1. Таблица по iPhone на домашнем Wi-Fi: эти числа — опора для сравнения с мобильной сетью в A18b.
  2. Записано, как iOS спрашивает доступ к локальной сети и что происходит при отказе.
  3. Релизный профиль сборки к `ws://` не подключается — записать, чем это обеспечено (ATS).
- **Проверка.** Человек запускает «Net» на своём телефоне. Verifier сверяет таблицу с выгрузкой JSON.

### S4. Фон и переподключение

- **Объём.** В приложении S1 — сценарии с открытым WebSocket к заглушке S3:
  - уход в фон на 5, 30 и 60 с и возврат;
  - блокировка экрана;
  - выключение Wi-Fi на 10 с и возврат (переход на LTE — в A18b: dev-relay из мобильной сети не виден);
  - режим полёта на 10 с.

  Для каждого сценария записать: жив ли сокет, какие события AppState и NetInfo пришли и когда, сколько занял
  новый коннект.
- **Файлы.** `packages/mobile/src/probe/background.ts` в ветке спайка.
- **Зависит.** S1, S3a.
- **Приёмка.** Таблица iOS × сценарий. Вывод о запасе в 30 с из §10.2: подтверждён или нужна правка.
- **Проверка.** Verifier повторяет два сценария.

### S5. Снята

FCM на Android ушёл в отложенный блок 2.5 (правки 5). Push iOS в спайке не проверить без оплаченного аккаунта:
его покрывают моки A5 и живая проверка A24. Номер оставлен, чтобы не сдвигать ссылки.

### S6. Размер снимка и частота событий

- **Объём.** Скрипт подключается к настоящему хосту как клиент `features: [compact-works, rooms-mail]` и зовёт
  только методы чтения: `works.list`, `feed.snapshot {scope: 'attention'}`. Час работы человека он пишет:
  - размер `works.list` сырым и после `deflate-raw`;
  - число `works.changed` в минуту и их размеры;
  - размеры `rooms.mail` и `activity.changed`;
  - размер `feed.snapshot {scope:'attention'}` у ждущей сессии — для нагрузки таймеров §10.3: 3 с на экране
    сессии, 10 с в Inbox.
- **Файлы.** Скрипт в scratch сессии, не в репозитории.
- **Зависит.** Ни от чего.
- **Приёмка.** Перцентили p50/p95/max размеров и частоты. Вывод: нужны ли дельты (§5.5, порог 256 КиБ после
  сжатия), хватает ли склейки «не чаще 1 с» и не пора ли подпискам переехать в A (§10.3).
- **Проверка.** Verifier повторяет замер `works.list` и сверяет порядок величин.

### S7. Итог спайка — senior

- **Почему senior.** Документ решает выбор крипто-библиотеки (§19.1) и замораживает набор шифров.
- **Объём.** `docs/research/2026-11-XX-mobile-spike-results.md` с числами S1–S4, S6 и выводами:
  - `@noble` или нативные примитивы, своя машина Noise или `noise-handshake`;
  - **набор шифров замораживается** в спеке (§7.1) и в плане (A3): имя набора и источник независимых
    тест-векторов для него. По умолчанию — `25519_ChaChaPoly_SHA256`; при `noise-handshake` —
    `25519_ChaChaPoly_BLAKE2b`. A3 не начинается до этой правки;
  - числа локальной связи S3b — опора для A18b;
  - нужны ли дельты снимка;
  - подтверждён ли запас фона в 30 с на Wi-Fi (по LTE — в A18b).

  Если выводы меняют спеку — правки в спеку с пометкой «по итогам спайка» и письмо человеку.
- **Зависит.** S1–S4, S6.
- **Приёмка.** Человек читает итог и подтверждает Р8 (Р1–Р3 уже решены). Этап A начинается после этого (Р9).
- **Итог (правки 6).** `docs/research/2026-10-31-mobile-spike-results.md`, подтверждён человеком 2026-10-31: набор
  `25519_ChaChaPoly_SHA256`, своя машина Noise, `@noble` — эталон, `react-native-quick-crypto` — скорость; проекция
  снимка в этапе A; подписки в B; Р8 — iOS 17+. Спайк остановлен до прогонов на iPhone: числа Hermes, связи по
  Wi-Fi и фона проверяются один раз на устройстве в A20, пп. 16–21 (итог S7 §8, правки 7).

**Параллельность этапа 0.** S1, S3a и S6 идут сразу. S2 — после S1. S3b и S4 — после S1 и S3a. S7 — последним.

---

## 2. Этап A — MVP «видеть и решать» (3–4 недели)

Объём — §4.2 (этап A), §11.2. Порядок и параллельность — раздел 2.3.

### 2.1 Задачи

#### A1. `@parley/protocol/remote`

- **Объём** (§3.1, §4.2–4.3, §6.3, §7.3–7.5, §8). Новый вход пакета протокола без `Buffer` и `node:*`:
  - `REMOTE_PROTOCOL = 1`; `REMOTE_POLICY_FEATURE = 'remote-policy-1'` (§4.1);
  - списки по этапам `REMOTE_STAGES.{A,B,C}` с полями `methods`, `notifications`, `events`; текущие
    `REMOTE_METHODS`, `REMOTE_NOTIFICATIONS`, `REMOTE_EVENTS` — этап A;
  - `REMOTE_FORBIDDEN` — список §4.3, только для тестов;
  - `REMOTE_PARAM_RULES`: `rooms.resolveProposal` без `rev` → отказ; для этапа B — `rooms.send` (`kind`, 16 КБ)
    и `pty.send` (16 КБ);
  - zod-схемы:
    - кадров приложения (`id` — строка ≤ 32 знаков), hello моста (§8.2);
    - событий моста (§8.3): `bridge.status` с `epoch` и `incompatible`, `activity.snapshot`, `session.closing`;
    - методов моста: `ping`, `client.info`, `push.register {apnsToken | null, env}` (§5.4, §9.1);
    - управляющих кадров relay (§6.3, без push) и payload паринга: msg1, пустой msg2, `credentials`, `paired`
      (§7.4);
    - запроса и ответа push-шлюза `POST /v1/push` (§6.5): строгая схема, без свободных строк;
    - событий и ответов сокета управления, связанных с парингом (`pair.request` и `pair.answer` с
      `requestId`, §5.3);
    - push-data `{v, kind, count, route}` (§9.4);
  - `parsePairUrl` / `buildPairUrl` (§7.3);
  - `relayUrlFor(r, {allowLocal})` — схема по §6.6: частный адрес → `ws://` только при `allowLocal`, иначе ошибка;
    остальные адреса → `wss://`;
  - base64url на `Uint8Array`.

  Значения из корня протокола не импортируются, только `import type`. Сверку с `METHODS` делает тест, не модуль.
- **Файлы.** `packages/protocol/src/remote/{index,allowlist,frames,relay,pairing,qr,b64url}.ts` и тесты рядом;
  `packages/protocol/package.json` — `exports["./remote"]`; ESLint: `no-restricted-globals` (`Buffer`,
  `process`) и `no-restricted-imports` (`node:*`, `../framing.js`, `../index.js`) для `src/remote/**`.
- **Зависит.** Ни от чего (может начаться до конца спайка, Р9).
- **Приёмка** (кейсы `vitest`):
  1. `REMOTE_METHODS ∩ REMOTE_FORBIDDEN = ∅`; `pty.input` и `pty.resize` нет ни в одном списке этапов.
  2. Каждое имя списков есть в `METHODS`, `NOTIFICATIONS` или `Events`. Проверка рантайма по ключам плюс
     `satisfies` на типах.
  3. `buildPairUrl` → `parsePairUrl` даёт исходное; URL с relay из 30 знаков ≤ 150 байт. Отвергаются: `v≠1`; `k`
     не 32 байта; `s` не 16 байт; `r` с путём, `@`, длиннее 64 знаков. `relayUrlFor`: `192.168.1.5:8787`,
     `10.0.0.2`, `172.20.1.1`, `169.254.1.1`, `mac.local` → `ws://` с `allowLocal` и ошибка без него;
     `relay.example.com`, `172.32.0.1` → `wss://`.
  4. Импорт `dist/remote/index.js` в отдельном процессе Node без `globalThis.Buffer` проходит, а `parsePairUrl`
     работает. Граф импортов `dist/remote/**` не содержит `node:` и `framing.js`.
  5. `rooms.resolveProposal` без `rev` правило отвергает, с `rev` — пропускает.
- **Проверка.** `pnpm --filter @parley/protocol build`; `pnpm --filter @parley/protocol test`; `pnpm exec eslint packages/protocol`.

#### A1b. Проекция снимка работ в `@parley/protocol/remote` (правки 6)

- **Объём** (спека §5.5 «Проекция снимка», итог S7 §7.3).
  - zod-схема `remoteWorksSnapshotSchema` и тип `RemoteWorksSnapshot`: ровно поля спеки §5.5, у записей
    `strictObject`; `proposal` комнаты — та же форма, что у хоста. Связи дерева сайдбара — `createdBy` у сессии,
    `ownerId` у комнаты, `swarms` у работы без текстов роя (правки 8).
  - Чистая функция `projectWorksSnapshot(snapshot: WorksSnapshot): RemoteWorksSnapshot` — тип хоста только через
    `import type`. Порядок работ — порядок `entries`; `lastEvent` — последняя запись `history`; `role` — имя;
    `archived` — `archivedAt != null`; счётчики — из `compact.rooms`.
  - Правила A1 для `src/remote/**` действуют: без `Buffer`, `process`, `node:*` и значений из корня протокола.
- **Файлы.** `packages/protocol/src/remote/projection.ts`, экспорт в `remote/index.ts`, тесты рядом.
- **Зависит.** A1.
- **Приёмка** (кейсы `vitest`):
  1. Фикстура снимка с двумя работами, закрытой и активной сессией, архивной комнатой с `proposal` → проекция
     проходит `remoteWorksSnapshotSchema`, поля и порядок совпадают с ожидаемыми.
  2. В проекции нет `task`, `summary`, `history`, `metrics`, `agentPlan`, `plans`, `planEffects`, `resources`,
     `branches`, а у роёв — `objective`, `result`, `failure` — проверка обходом ключей.
  3. Пустая `history` → `lastEvent: null`; нет `compact` → счётчики `null`; нет `revision` → `revision: 0`.
  4. Импорт `dist/remote/index.js` без `Buffer` и граф импортов — как A1 п. 4 (существующий тест проходит).
- **Проверка.** `pnpm --filter @parley/protocol build`; `pnpm --filter @parley/protocol test`; `pnpm exec eslint packages/protocol`.

#### A2. Роль `remote` на хосте — senior-only

- **Почему senior.** Граница доступа хоста: ошибка здесь открывает телефону весь хост (§4.1).
- **Объём** (§4.1–4.4).
  - `Client.role?: 'remote'`. Без поля — полный клиент: Telegram и прочие внутренние `Client` не меняются.
  - `handleHello`: `hello.client === 'remote'` → роль; `methods` в ответе — пересечение с `REMOTE_METHODS` и
    `hello`.
  - `handleMessage`:
    - метод вне списка → `unknown_method`;
    - уведомление вне списка → лог хоста, обработчик не зовётся;
    - правило параметров не прошло → `bad_request`, обработчик не зовётся.
  - `createClient`: для роли `remote` `send` и `sendLine` пропускают ответы и события только из `REMOTE_EVENTS`.
  - `HOST_FEATURES` (`server.ts:45`) получает `REMOTE_POLICY_FEATURE` — только вместе с тремя проверками выше, в
    одном коммите.
- **Файлы.** `packages/host/src/server.ts`, `packages/host/src/client.ts`, тесты в `server.test.ts` (и
  `client.test.ts`, если удобнее).
- **Зависит.** A1.
- **Приёмка** (кейсы):
  1. Клиент `remote`: `settings.set` → `unknown_method`; `works.list` → результат.
  2. `rooms.resolveProposal` без `rev` → `bad_request`, обработчик не вызван (шпион).
  3. Уведомления `pty.input` и `pty.resize` от `remote` до обработчика не доходят.
  4. `broadcast('telegram.changed', …)` не доходит до `remote`, `works.changed` доходит. `feed.changed`, посланный
     через `client.send`, отфильтрован.
  5. `hello.methods` у `remote` ⊆ `REMOTE_METHODS ∪ {hello}`; `hello.features` содержит `remote-policy-1`.
  6. Все прежние тесты хоста проходят без правок; клиент `desktop` видит все методы.
- **Проверка.** `pnpm --filter @parley/host build`; `pnpm --filter @parley/host test`; `pnpm exec eslint packages/host`. Ревью критика старшего уровня.

#### A3. `@parley/noise` — senior-only

- **Почему senior.** Крипто (§7): своя машина состояний Noise без аудита.
- **Объём** (§7.1, §7.4–7.7).
  - `SymmetricState`, `CipherState`, `HandshakeState` для паттернов `IK` и `IKpsk0` с набором, замороженным в S7:
    `25519_ChaChaPoly_SHA256`, своя машина на `@noble` (итог S7 §7.1, правки 6; `noise-handshake` отклонён). Примитивы —
    за одним интерфейсом, чтобы `react-native-quick-crypto` встал позже без смены машины.
  - API:
    - `initiator(...)` / `responder({pattern, prologue, s, rs?, psk?})`;
    - `writeMessage(payload)` / `readMessage(msg)`;
    - `handshakeHash()`, `split()`;
    - `FrameCodec` — нарезка, флаги, `deflate-raw` через `fflate` (§7.7);
    - `sas(h)` (§7.4);
    - `hkdf` (RFC 5869) для `psk` и `lookup`.
  - Счётчик nonce: отказ на 2⁶⁴−1, сигнал «пора закрыть» на 2³².
- **Файлы.** `packages/noise/src/{symmetric,cipher,handshake,patterns,codec,sas,hkdf,random}.ts`,
  `packages/noise/test/vectors/*.json`: `IK` — подмножество cacophony / snow `IK_25519_ChaChaPoly_SHA256`;
  `IKpsk0` — `ikpsk0-vectors.json` из спайка (итог S7 §7.2, sha256 `5511d881…8bf79` сверяется при переносе; векторы
  3–5 на BLAKE2b — проверка, что хэш набора не перепутан, — правки 6),
  `packages/noise/test/*.test.ts`, `packages/noise/README.md` (по-английски: API и инварианты).
- **Зависит.** S7: выбор библиотеки и замороженный набор шифров с источником векторов.
- **Приёмка** (кейсы):
  1. Все независимые векторы `IK` и `IKpsk0` для замороженного набора проходят — и рукопожатие, и транспорт.
  2. Перекрёстная проверка: в тестах на `node:crypto` (x25519, chacha20-poly1305 и хэш набора: `sha256` или
     `blake2b512`) — те же байты рукопожатия при тех же ключах.
  3. Отрицательные: чужой тег; неверный psk → ошибка на чтении `s` в msg1; чужой статический ключ ответчика;
     обрезанный, переставленный и повторённый транспортный кадр — ошибка.
  4. `FrameCodec`: кадр 1 МиБ режется на куски ≤ 65 535 и собирается обратно; потолок распаковки соблюдается
     (бомба `deflate` → ошибка).
  5. SAS: одна детерминированная фикстура msg1 с одним psk, прочитанная двумя независимыми ответчиками с разными
     `e`, даёт два разных SAS. У инициатора и ответчика одного рукопожатия SAS совпадает.
  6. Импорт без `Buffer` — как A1 п. 4.
  7. Рукопожатие IK на Node < 5 мс для одной стороны — проба `bench.ts`, медиана из 100 (по S2: одна сторона ≈ 3,6 мс,
     обе в одном процессе ≈ 7,1 мс; правки 6).
- **Проверка.** `pnpm --filter @parley/noise build`; `pnpm --filter @parley/noise test`; `pnpm --filter @parley/noise typecheck`; `pnpm exec eslint packages/noise`. Ревью критика старшего
  уровня — по исходникам, не по отчёту.

#### A4. Relay v1: маршруты, устройства, офферы, трубы — ревью senior

- **Объём** (§6.1–6.4).
  - Сервер `ws`: `/v1/host`, `/v1/accept`, `/v1/connect`, `GET /v1/health`.
  - Хранилище маршрутов и устройств в SQLite (`better-sqlite3`) или в JSON-файле с атомарной записью; оффер и
    потоки — в памяти.
  - Доверие при первом использовании для маршрута; сравнение хэшей за постоянное время.
  - Склейка труб; закрытие одной стороны закрывает другую.
  - Лимиты §6.4, WS ping раз в 25 с.
  - `Dockerfile` (образы `amd64` и `arm64`) и шаблоны развёртывания `deploy/{compose.yml,Caddyfile}` с Caddy —
    их же берёт мастер A18a. По умолчанию relay слушает `127.0.0.1` за Caddy.
  - Локальный dev-relay (§6.6): скрипт `dev` слушает LAN-адрес Мака без TLS и печатает `ws://<IP>:<порт>` для
    поля Relay в Settings. С ним работают все задачи этапа A до A18b.
- **Файлы.** `packages/relay/src/{main,server,store,routes,pipe,limits,health,log}.ts`, тесты,
  `packages/relay/Dockerfile`, `packages/relay/deploy/{compose.yml,Caddyfile}`.
- **Зависит.** A1.
- **Приёмка** (кейсы на живых `ws` в тесте):
  1. Первый `hello` создаёт маршрут, второй с чужим секретом → ошибка; маршрут переживает перезапуск сервера.
  2. `devices` заменяет список; `connect` с верным токеном → `incoming` у моста, затем `ready`; с неверным →
     `unknown_device`; хост не подключён → `host_offline`.
  3. `pair` с открытым и закрытым оффером; оффер с истёкшим `exp` закрыт.
  4. Байты идут по трубе в обе стороны без изменений; закрытие одной стороны закрывает другую.
  5. Лимиты: 31-й `connect` с одного IP за минуту → `rate_limited`; кадр больше 65 599 байт → закрытие.
  6. В логе нет токенов и секретов — тест-греп по логу прогона.
  7. Без `dev` сервер слушает только `127.0.0.1`; с `dev` — LAN-адрес, а `GET /v1/health` с другого адреса той же
     сети отвечает 200.
- **Проверка.** `pnpm --filter @parley/relay build`; `pnpm --filter @parley/relay test`; `pnpm exec eslint packages/relay`; `docker buildx build --platform linux/amd64,linux/arm64 packages/relay`; `pnpm --filter @parley/relay dev` и `curl http://<IP Мака>:<порт>/v1/health` с другого устройства. Ревью критика по
  безопасности.

#### A5. Push-шлюз `packages/push-gateway` — ревью senior

- **Объём** (§6.5). Отдельный сервис автора, не часть relay.
  - `POST /v1/push {v, token, env, count, route}` → APNs: токенный JWT `.p8` (ES256, обновление раз в 50 мин),
    HTTP/2, `alert` «Parley» / «N waiting», `apns-collapse-id` и `thread-id` = `route`, `badge`,
    `data = {v, kind, count, route}`; `sandbox` и `production` — разные хосты APNs.
  - Строгая схема: лишние поля и свободные строки → 400. Текст собирает шлюз.
  - Ответы: 200, 410 (токен недействителен — наружу как есть), 400, 429.
  - Лимиты в памяти: на токен ≤ 1 push в 3 с и ≤ 60 в час, на IP ≤ 600 запросов в час.
  - Ничего не хранит: ключ, Key ID, Team ID и тема — из окружения; тела, токены и IP не пишутся никуда.
  - `GET /v1/health`; `Dockerfile`; README по-английски: что шлюз видит и чего не хранит.
  - Без ключа в окружении сервис не стартует.
- **Файлы.** `packages/push-gateway/src/{main,server,apns,jwt,limits,schema}.ts`, тесты с моком APNs на
  `node:http2`, `packages/push-gateway/{Dockerfile,README.md}`.
- **Зависит.** A1 (схема запроса); может начаться до конца спайка (Р9). Развёртывание у автора — A24.
- **Приёмка** (кейсы):
  1. Тело и заголовки APNs сравниваются целиком: только `Parley`, `N waiting`, `route`, `count`, `kind`, `v`;
     `apns-push-type: alert`, тема из окружения. Два `route` → разные `apns-collapse-id`.
  2. Лишнее поле или строка вместо числа → 400, в APNs ничего не ушло.
  3. 410 от мока APNs → 410 наружу.
  4. Второй push на тот же токен через 1 с → 429.
  5. Тест-греп: в логе прогона нет токенов, тел запросов, IP и ключа.
- **Проверка.** `pnpm --filter @parley/push-gateway build`; `pnpm --filter @parley/push-gateway test`;
  `pnpm exec eslint packages/push-gateway`. Ревью критика старшего уровня: публичный вход и ключ APNs. Живой push
  — в A24.

#### A6a. Мост: файлы, сокет управления, журнал — контракты

- **Объём** (§5.2–5.3, §5.8). Хранилище и транспорт управления; поведения безопасности здесь нет.
  - Файлы `~/.parley/remote/`: 0700 / 0600; атомарная запись (временный файл, `fsync`, переименование) для
    `remote.json`, `keys.json`, `devices.json`.
  - Сокет управления: транспорт, токен, схемы A1. Методы `status`, `configure`, `audit.tail`, `presence`,
    `push.test`, `stop` обслуживает сам.
  - `pair.*`, `devices.revoke`, `reset` — только маршрутизация в типизированные обработчики
    (`ControlHandlers`), которые регистрирует A7. Пока их нет — `not_ready`.
  - Журнал: формат §5.8, ротация по 5 МБ, последний архив.
  - Процесса и `main` здесь нет — их собирает A22.
- **Файлы.** `packages/remote/src/{paths,files,control,audit,log}.ts`, тесты, `packages/remote/package.json`.
- **Зависит.** A1 (может начаться до конца спайка, Р9).
- **Приёмка** (кейсы):
  1. Права созданных файлов и каталога — 0600 и 0700; оборванная запись (сбой между записью и переименованием)
     оставляет прежний файл целым.
  2. Сокет управления отвергает неверный токен; `status` отвечает схемой из A1.
  3. `devices.revoke` без зарегистрированного обработчика → `not_ready`; с обработчиком-шпионом — вызов с
     `deviceId`, ответ окну только после того, как обработчик завершился.
  4. Ротация журнала на 5 МБ.
  5. Тест-греп: в логе прогона нет `control.token`.
- **Проверка.** `pnpm --filter @parley/remote build`; `pnpm --filter @parley/remote test`; `pnpm exec eslint packages/remote`.

#### A6b. Мост: клиент хоста, эпоха, загрузка, кэш активности

- **Объём** (§4.1, §5.1).
  - Клиент хоста: `hello {client: 'remote', features}`, переподключение с отступом, `host.token` при каждом
    переподключении, ответы по `id`, события наружу.
  - Закрытие по умолчанию: нет `remote-policy-1` в ответе `hello` → `host: 'incompatible'`, вызовы к хосту не
    идут.
  - Эпоха `<bootId>:<n>` на каждое подключение к хосту; кэш последнего `activity.changed` по `ref` (повтор при
    регистрации и события); сброс кэшей на новой эпохе; незавершённые вызовы прошлой эпохи → `host_offline`.
  - Загрузка эпохи: после проверки признака — `works.list`; параллельные `works.changed` применяются по
    `revision`; статус `starting` до ответа; повтор `works.list` с отступом при ошибке.
  - Наружу — интерфейс `HostLink`: эпоха, статус, снимок, активность, `call()`, события. Им пользуются A8 и A9.
- **Файлы.** `packages/remote/src/host-link.ts`, тесты со стабом хоста на временном unix-сокете.
- **Зависит.** A1, A6a: манифест, `tsconfig` и скрипты пакета `@parley/remote` создаёт A6a. Может начаться до конца
  спайка (Р9).
- **Приёмка** (кейсы):
  1. Мост шлёт `hello` с `client: 'remote'` и двумя `features`. Стаб упал → статус `offline`, поднялся →
     переподключение с новым токеном и новой эпохой; кэш активности очищен.
  2. Стаб старого хоста без `remote-policy-1` → `incompatible`; `call()` к стабу не доходит (счётчик вызовов
     стаба = 0).
  3. Повтор `activity.changed` при регистрации и последующие события попадают в кэш; последнее по `ref`
     выигрывает.
  4. Стаб хоста уже работает и больше ничего не шлёт: снимок есть из `works.list`, статус `starting` → `online`.
     `works.changed` с большим `revision`, пришедший раньше ответа `works.list`, ответом не откатывается.
  5. Две эпохи одного запуска различны; эпохи двух запусков различны.
  6. Тест-греп: в логе прогона нет `host.token`.
- **Проверка.** `pnpm --filter @parley/remote build`; `pnpm --filter @parley/remote test`; `pnpm exec eslint packages/remote`.

#### A7. Мост: relay, сессии Noise, паринг, подключение — senior-only

- **Почему senior.** Крипто-протокол и доступ к хосту. Здесь решается, кто получает сессию (§7.4–7.9).
- **Объём.**
  - Управление к relay: `hello`, замена `devices`, `offer`, `incoming` → `accept`, переподключение. Адрес — через
    `relayUrlFor` (A1) с `allowLocal: true`: на Маке разрешён локальный dev-relay (§6.6).
  - Паринг (§7.3–7.4):
    - `pair.start` / `pair.cancel`, перевыпуск оффера;
    - msg1 расходует оффер, а на неверном psk ещё и сжигает его;
    - msg2 — сразу, пустой; SAS по законченному рукопожатию;
    - событие `pair.request` с `requestId`; `pair.answer {requestId, allow}` с атомарной проверкой → иначе
      `stale_request`;
    - после «Allow»: запись устройства на диск → регистрация `relayToken` на relay → транспортный кадр
      `credentials`;
    - ожидание `{t:'paired'}` 30 с, `pair.done` / `pair.failed`; при неудаче — удаление тем же порядком, что
      отзыв.
  - Подключение (§7.5):
    - поиск `DS_pub`, сверка с `deviceId` из `incoming`;
    - `ts > lastTs`, отложенная запись `lastTs`;
    - подтверждение первым транспортным кадром; замена старой сессии только после подтверждения;
    - неподтверждённая сессия живёт 10 с.
  - Время жизни сессии (§7.6): час и 2³² кадров → `session.closing rekey`.
  - Отзыв и сброс (§7.9) — строго в порядке спеки:
    1. поколение `deviceGen` и недействительность живых и неподтверждённых сессий — синхронно;
    2. атомарная запись на диск с `fsync`, ответ окну только после неё;
    3. `session.closing` внутри Noise и закрытие;
    4. relay отдельно, с повтором при каждом переподключении.

    Активация сессии и разбор каждого кадра сверяют поколение. Сброс — новый `HS`, `routeId` и `routeSecret`.
  - Интерфейс для A8: `onFrame(deviceId, frame)`, `send(deviceId, frame)`, `close(deviceId, reason)`.
  - Обработчики `ControlHandlers` для A6a: `pair.*`, `devices.revoke`, `reset` — вся их семантика здесь.
  - Записи журнала §5.8.
- **Файлы.** `packages/remote/src/{relay-link,pairing,sessions,devices,keys}.ts`, тесты.
- **Зависит.** A3, A4 (протокол и сервер для тестов), A6a.
- **Приёмка** (кейсы с локальным relay из A4 и тестовым клиентом на `@parley/noise`):
  1. Паринг с верным QR → `pair.request` с тем же SAS, что у клиента; `allow` с этим `requestId` →
     `credentials`; `paired` → устройство активно, `relayToken` зарегистрирован. До `allow` в `devices.json` и на
     relay нового устройства нет.
  2. Неверный psk → оффер сожжён, второй msg1 → `offer_closed`, запись `pair-failed bad-psk`.
  3. **Противник паринга** (спека §15): тестовый «relay» задерживает msg1 настоящего клиента и шлёт msg1
     противника с тем же `s`.
     - Настоящий клиент получает `offer_closed` и `onSas` не вызывается.
     - msg1, повторённый против нового оффера, отвергается (`pair-failed bad-psk`).
     - До `allow` нет ни `credentials`, ни записи устройства.
  4. `pair.answer` с `requestId` истёкшего или отменённого запроса после перевыпуска оффера → `stale_request`;
     текущий запрос не одобрен.
  5. Нет `paired` 30 с → устройство удалено из `devices.json` и с relay.
  6. Повтор msg1 подключения → `connect-refused replay`; живая сессия того же устройства не тронута.
  7. Чужой `DS_pub` при верном `relayToken` → `device-mismatch`.
  8. Новая подтверждённая сессия закрывает старую с `replaced`; неподтверждённая старую не трогает.
  9. Отзыв: живая сессия получает `session.closing revoked`, затем закрытие; следующее рукопожатие →
     `unknown-key`.
  10. Отзыв между msg1 и подтверждением — сессия не активируется, кадры не доходят до A8.
  11. Отзыв при relay, который не отвечает, — ответ окну приходит; следующее рукопожатие отозванного телефона →
      `unknown-key`.
  12. Отзыв, затем перезапуск моста — устройство отозвано.
  13. Сброс:
      - relay в документированном состоянии (старый маршрут без устройств) отвечает старому телефону
        `unknown_device`;
      - relay, который ещё пускает старый токен (стаб с устаревшим списком), — рукопожатие старого телефона всё
        равно падает локально: его msg1 зашифрован на прежний `HS_pub`;
      - новый QR работает.
  14. Тест-греп: в логе нет `s`, `psk`, ключей и токенов.
- **Проверка.** `pnpm --filter @parley/remote build`; `pnpm --filter @parley/remote test`; `pnpm exec eslint packages/remote`. Ревью критика старшего уровня.

#### A8. Мост: прикладной слой — ревью senior

- **Объём** (§5.4–5.5, §5.7, §8).
  - Диспетчер: подмена `id`; белый список этапа A и правила параметров из A1; лимиты; ≤ 16 запросов в работе;
    потолки кадров.
  - Методы моста: `ping`, `client.info`, `push.register` (токен в `devices.json`, атомарная запись).
  - Фильтр событий; склейка `works.changed` по `revision` не чаще 1 с на телефон; склейка `activity.changed` по `ref`
    (последнее выигрывает) не чаще 1 с на телефон (итог S7 §7.5); сжатие кадров больше 1 КиБ через `FrameCodec`.
  - Телефону идёт проекция снимка `projectWorksSnapshot` из A1b — и в начальном состоянии, и в каждом
    `works.changed` (спека §5.5, правки 6). Полный снимок `HostLink` наружу не уходит.
  - Начальное состояние телефона (§5.5): после подтверждения сессии и загрузки эпохи в очередь по порядку
    `bridge.status {host, epoch}`, проекция снимка эпохи, `activity.snapshot`; потом живые события. До загрузки —
    только `bridge.status starting`. Новая эпоха → то же всем телефонам и сброс склейки.
  - Медленный телефон (очередь > 4 МиБ) → `session.closing slow`.
  - `bridge.status`; журнал `call` / `call-refused`.
- **Файлы.** `packages/remote/src/{dispatch,fanout,limits,local-methods}.ts`, тесты с фейковым клиентом хоста и
  фейковыми сессиями (интерфейс A7).
- **Зависит.** A1, A1b, A6a, A6b. Интерфейс A7 можно мокать.
- **Приёмка** (кейсы):
  1. `settings.set` от телефона до клиента хоста не доходит → `unknown_method` и `call-refused`.
  2. Два телефона шлют одинаковые `id` — ответы не путаются.
  3. 10 `works.changed` за 300 мс → телефон получает последний, один раз.
  4. 31-й изменяющий вызов за минуту → `rate_limited`.
  5. Кадр от телефона больше 64 КиБ → закрытие сессии.
  6. Хост упал → телефоны получают `bridge.status offline`; вызов в это время → `host_offline`.
  7. Телефон подключается, когда сессия уже `blocked`, — первые три кадра: статус, снимок, `activity.snapshot` с
     этой сессией в `blocked`.
  8. Перезапуск хоста → новая эпоха; снимок с `revision: 1` доходит до телефона, хотя прошлый был `revision: 40`.
     То же при перезапуске моста и хоста вместе.
  9. `host: 'incompatible'` (A6b) → любой вызов телефона → `host_offline`, к хосту ничего не уходит.
  10. Телефон подключился, пока эпоха грузится, — получает `starting`, затем начальное состояние; вызов в
      `starting` → `host_offline`.
  11. Снимок и `works.changed` у телефона проходят `remoteWorksSnapshotSchema`; ключей `task`, `summary`, `plans`
      в кадрах нет (правки 6).
  12. 10 `activity.changed` одного `ref` за 300 мс → телефон получает последнее, один раз; события двух `ref` не
      теряются (правки 6).
- **Проверка.** `pnpm --filter @parley/remote build`; `pnpm --filter @parley/remote test`; `pnpm exec eslint packages/remote`. Ревью критика — белый список и лимиты.

#### A9. Push-поводы: `needsYouCount` и отправка из моста

- **Объём** (§9.2–9.3).
  - `needsYouItems(entries, activities)` и `needsYouCount(...)` в `@parley/core/attention` — модуль остаётся
    чистым.
  - В мосте (§9.2): множество ключей ждущих пунктов эпохи — сессия с номером входа в `needs-you`,
    `proposalId:rev`, `messageId` новых прямых писем из `rooms.mail`; первая картина эпохи — база.
  - Новый ключ → пачка 3 с → проверка `presence` → `POST /v1/push` push-шлюзу (§6.5) на каждое устройство с
    токеном; адрес шлюза — из сборки, `remote.json.pushGatewayUrl` переопределяет; 410 → токен стёрт из
    `devices.json`; шлюз недоступен → пропуск без повтора, запись в лог.
- **Файлы.** `packages/core/src/work/attention.ts` и `attention.test.ts`; `packages/remote/src/{push,push-gateway-client}.ts`
  и тесты с моком шлюза.
- **Зависит.** A1 (схема шлюза), A6b, A8 (`push.register`; можно мокать).
- **Приёмка** (кейсы):
  1. Фикстуры: blocked-сессия, сессия с `need`, комната с решением, непрочитанное прямое письмо, архивная комната с
     решением (не считается), упоминание `@human` (не считается). Счётчик совпадает с суммой предикатов окна на тех
     же данных.
  2. Два новых пункта за 1 с → один push через 3 с; уход пункта (2 → 1) — push нет; `presence active` — push нет;
     окна нет — push есть.
  3. Ведущий заменил решение (новый `rev`, счётчик тот же) → push. Сессия вышла из `needs-you` и снова вошла →
     push.
  4. Первая картина после подключения к хосту (новая эпоха) push не даёт.
  5. Непрочитанные `m-01` в двух работах → два ключа и push на второй. Прочтение `m-01` в одной работе не снимает
     ключ другой.
  6. Модуль `attention.ts` по-прежнему без импортов значений (существующий тест модуля проходит).
  7. Мок шлюза отвечает 410 → токен стёрт; устройство без токена → запроса нет; в теле только поля схемы A1.
- **Проверка.** `pnpm --filter @parley/core build`; `pnpm --filter @parley/core test`; `pnpm --filter @parley/remote test`; `pnpm exec eslint packages/core packages/remote`.

#### A22. Мост: сборка в рабочий процесс — ревью senior

- **Объём.** `main` моста собирает A6a, A6b, A7, A8, A9 в один процесс и бинарь `parley-remote`.
  - Порядок старта: ключи и устройства с диска → сокет управления и обработчики A7 → `HostLink` → relay-link →
    приём сессий.
  - Порядок остановки (сокет `stop`, SIGTERM): перестать принимать сессии → `session.closing shutdown` → закрыть
    relay-link → закрыть `HostLink` → дописать журнал → удалить `bridge.pid`.
  - `configure` применяет новый адрес relay без перезапуска процесса.
  - PID и лог.
- **Почему ревью senior.** Порядок старта и остановки решает, не примет ли мост сессию раньше, чем загружен список
  устройств, и не останется ли полуотозванное устройство.
- **Файлы.** `packages/remote/src/{main,bridge}.ts`, `packages/remote/test/bridge.integration.test.ts`,
  `packages/remote/package.json` (`bin`, `exports["./main"]`).
- **Зависит.** A6a, A6b, A7, A8, A9.
- **Приёмка** (кейсы на настоящем процессе — `child_process`, стаб хоста, локальный relay A4):
  1. `status` по сокету управления → `running`, хост `online`.
  2. Паринг тестовым клиентом и вызов `works.list` через relay.
  3. `devices.revoke` → `session.closing revoked` у клиента.
  4. SIGTERM → `session.closing shutdown` у клиента, выход с кодом 0, `bridge.pid` удалён.
  5. Перезапуск → устройства на месте, отозванное отозвано.
  6. Шпион на `net.Server.prototype.listen`: только unix-путь.
- **Проверка.** `pnpm --filter @parley/remote build`; `pnpm --filter @parley/remote test`; `pnpm exec eslint packages/remote`. Ревью критика старшего уровня.

#### A10. Окно: запуск моста и Settings → Remote access

- **Объём** (§12).
  - Запускатель моста по образцу `host-launcher.ts`; клиент сокета управления в main.
  - IPC в renderer.
  - Экран Settings:
    - переключатель, поле relay, статус; кнопка «Set up on my server…» открывает мастер A18a;
    - «Pair a device»: QR через `qrcode` в main → data URL, таймер, перевыпуск;
    - диалог запроса с SAS и «Codes match — Allow» / «Deny»; ответ несёт `requestId` своего диалога;
      `stale_request` и истечение срока закрывают диалог; «Phone connected ✓»;
    - Devices с «Revoke», «Revoke all and reset key» с подтверждением;
    - Activity.
  - Присутствие из `powerMonitor.getSystemIdleState(60)` раз в 15 с и на смену.
  - Тексты — в `shared/strings.ts`.
- **Файлы.** `packages/desktop/src/main/{remote-launcher,remote-control}.ts`, правки `ipc.ts`,
  `shared/bridge.ts`, `shared/strings.ts`, `renderer/settings/remote/*.tsx`, тесты.
- **Зависит.** A6a (протокол управления), A7 (события паринга). UI можно начать на фейковом сервере управления.
  Запуск собранного моста в `.app` — A23.
- **Приёмка.**
  1. Кейсы: запускатель поднимает и останавливает мост (по образцу `host-launcher.test.ts`); IPC передаёт
     `pair.request` в renderer и `pair.answer` с тем же `requestId` обратно. Диалог, открытый до перевыпуска
     оффера, после него не отправляет «Allow» для нового запроса.
  2. Страж `english-ui` проходит.
  3. Экраны (скриншоты по одному рецепту): Settings выключено / включено / диалог паринга / список устройств.
- **Проверка.** `pnpm --filter @parley/desktop test`; `pnpm typecheck`; `pnpm exec eslint packages/desktop`; скриншоты — в отчёт.

#### A23. Мост в собранном приложении

- **Объём.** Сейчас `dist` окна раскладывает в `.app` только хост (`packages/desktop/package.json`, скрипт `dist`;
  `electron-builder.yml`, `extraResources: out/host`). Мост должен ехать так же.
  - `dist`: `pnpm --filter @parley/remote deploy --prod "$PWD/out/remote"` и те же шаги очистки, что для хоста.
  - `electron-builder.yml`: `out/remote` → `Resources/remote` (вместе с `node_modules`).
  - `resolveBridgeEntry({packaged, resourcesPath})` по образцу `resolveHostEntry` (`host-launcher.ts:31-42`):
    в `.app` — `Resources/remote/dist/main.js`, в dev — `require.resolve('@parley/remote/main')`.
  - Мост запускается тем же Node, что хост в `.app`, а не системным.
- **Файлы.** `packages/desktop/package.json`, `packages/desktop/electron-builder.yml`,
  `packages/desktop/src/main/remote-launcher.ts`, тесты запускателя.
- **Зависит.** A10, A22.
- **Приёмка.**
  1. Кейсы: `resolveBridgeEntry` для обоих режимов.
  2. `pnpm --filter @parley/desktop dist` даёт `.app`, в котором есть `Contents/Resources/remote/dist/main.js`.
  3. Дымовой прогон: `.app` скопирован во временный каталог вне репозитория и запущен с
     `env -i PATH=/usr/bin:/bin`, то есть без checkout и без системного Node. Включение Remote access поднимает
     мост: `bridge.pid` есть, `status` отвечает, в `bridge.log` пути только из `Resources`.
- **Проверка.** `pnpm --filter @parley/desktop test`; `pnpm --filter @parley/desktop dist`; дымовой прогон по шагам
  из отчёта исполнителя, вывод — в отчёт.

#### A11. `remote-client`: паринг, супервизор подключения, RPC — senior-only

- **Почему senior.** Восстановление связи и использование крипто на клиенте (§10.2, §7.4–7.5). Ошибки дают
  вечный цикл переподключений, запертое устройство или действие по неаутентифицированному сигналу.
- **Объём.**
  - Интерфейс `Platform` (§10).
  - `pair()` (§10.1): SAS — только после верного msg2; `credentials` ждутся до 120 с; запись хоста — до
    `paired`.
  - Супервизор (§10.2):
    - состояния, триггеры, отступ с джиттером, heartbeat;
    - запас фона 30 с (или число из S4);
    - одна попытка на хост;
    - `lastTs` записывается до msg1;
    - `rekey` без отступа;
    - `blocked` только по аутентифицированному `session.closing` или по версии.
  - Клиент relay; RPC с таймаутами и `connection_lost`.
- **Файлы.** `packages/remote-client/src/{platform,host-store,relay-client,pair,supervisor,rpc}.ts`, тесты с
  фейковыми таймерами и фейковым relay в памяти.
- **Зависит.** A1, A3. A4 — для интеграционного прогона в A17.
- **Приёмка** (кейсы):
  1. Обрыв в `ready` → отступ 0,5 → 1 → 2 … ≤ 30 с; `appState active` сбрасывает отступ и подключает сразу.
  2. `ping` без ответа 10 с → переподключение; смена сети → `ping` с таймаутом 3 с.
  3. `background` → через 30 с закрытие; `active` через 10 с при живом `ping` — без переподключения.
  4. Ошибка relay `unknown_device` → состояние `waiting` с плашкой, запись хоста не стёрта.
     `session.closing revoked` внутри Noise → `blocked`.
  5. Две быстрые попытки подключения → одна в работе; `ts` второй строго больше.
  6. Ожидающие RPC при обрыве получают `connection_lost`; изменяющий вызов не повторяется.
  7. Паринг: `offer_closed` до msg2 → ошибка без `onSas`; msg2 с чужим ключом хоста → ошибка рукопожатия без
     `onSas`.
- **Проверка.** `pnpm --filter @parley/remote-client build`; `pnpm --filter @parley/remote-client test`; `pnpm exec eslint packages/remote-client`. Ревью критика
  старшего уровня.

#### A12. `remote-client`: состояние, производные, действия

- **Объём** (§10.1).
  - Редьюсер: снимок по `(epoch, revision)`, активность (`activity.snapshot` заменяет, `activity.changed`
    правит), письма из `rooms.mail` и `context.messages`, статус хоста. Снимок у телефона — проекция
    `RemoteWorksSnapshot` из A1b, а не `WorksSnapshot` хоста (спека §5.5, правки 6); производные строятся только на её
    полях.
  - Перечитывание карточек этапа A (§10.3): по событиям со склейкой 300 мс; таймер экрана сессии раз в 3 с в
    любом её состоянии; таймер Inbox раз в 10 с с двумя бюджетами — видимые (≤ 10) и круг по остальным (≤ 10, от
    самой давней, без повторов видимых). Только на переднем плане, одна заявка на сессию.
  - Эпоха: кадры другой эпохи не применяются; ответы на вызовы прошлой эпохи — `lost`.
  - Стор, совместимый с zustand.
  - Производные: Inbox, работы в порядке сайдбара, краткие описания карточек.
  - Действия `decide` и `resolveProposal` с итогами `applied | conflict | stale | lost`; после `lost` —
    перечитывание.
- **Файлы.** `packages/remote-client/src/{state,reducer,inbox,works-view,actions,store}.ts`, тесты на фикстурах
  снимков.
- **Зависит.** A1, A1b. RPC A11 можно мокать.
- **Приёмка** (кейсы):
  1. Старый `revision` той же эпохи не откатывает новый. Другая `epoch` сбрасывает состояние, и снимок с меньшим
     `revision` применяется. Ответ на вызов прошлой эпохи → `lost`.
  2. Inbox на фикстуре даёт ожидаемый список и порядок.
  3. `feed.decide → applied:false` → итог `stale`; `resolveProposal → conflict` → `conflict`, новый текст
     решения берётся из снимка.
  4. `lost` → вызов `feed.snapshot` и итог по его данным.
  5. Импорты — только подпути `@parley/core/*` и `import type` из корней (правило ESLint, как в A1).
  6. Перечитывание (фейковые таймеры):
     - карточка исчезла в ответе → итог «answered elsewhere»;
     - новая карточка той же сессии видна через ≤ 3 с без переподключения;
     - экран сессии в `working`: новый ответ модели виден через ≤ 3 с;
     - 30 ждущих сессий в Inbox, 9 из них постоянно видимы: каждая невидимая перечитана за ≤ 30 с, видимые —
       каждые 10 с, за круг ≤ 20 запросов;
     - 10 постоянно видимых и 5 невидимых: невидимые всё равно перечитываются каждые 10 с;
     - в `background` запросов нет;
     - две причины за 300 мс — один запрос.
- **Проверка.** `pnpm --filter @parley/remote-client build`; `pnpm --filter @parley/remote-client test`; `pnpm exec eslint packages/remote-client`.

#### D1. Дизайн экранов MVP — senior (роль designer)

- **Почему senior.** Требование «нативно отлично» (§11.3); решения облика задают все экранные задачи.
- **Объём.** Экраны §11.2 для iOS (Android — блок 2.5): состояния (пусто, загрузка, ошибка, офлайн), переходы, haptics,
  иконки (SF Symbols), тёмная тема. Кликабельный HTML-прототип или макеты.
- **Файлы.** `docs/design/2026-11-XX-mobile-mvp-screens.md` и прототип в `packages/mobile/prototype/` (не в
  сборке).
- **Зависит.** Ни от чего, кроме спеки.
- **Приёмка.** Человек принимает макеты. У каждого экрана A14–A16 есть макет и список состояний.

#### A13. Приложение: основа

- **Объём** (§11.1).
  - Из скелета S1 после ревью: `app.config.ts` (схема `parley://`, минимальные ОС по Р8, права камеры и
    уведомлений), `eas.json` (профиль development). Только iOS; Android — блок 2.5.
  - Dev-профиль для локального relay (§6.6, итог S3b): `NSLocalNetworkUsageDescription` и
    `NSAllowsLocalNetworking`. В релизном профиле этого нет.
  - Реализация `Platform` (§10): `expo-secure-store`, WebSocket, AppState, NetInfo с проверкой `/v1/health`
    relay. Адрес relay строится через `relayUrlFor` (A1) с `allowLocal = __DEV__`.
  - Native tabs Inbox / Works / Settings; токены темы; компонент плашки подключения.
  - Подключение стора `remote-client`; стирание записей Keychain при первом запуске (§7.8).
- **Файлы.** `packages/mobile/**` (имя пакета `@parley/mobile`; ESLint-конфиг корня покрывает его файлы RN —
  правка `eslint.config.*` при необходимости): `app/_layout.tsx`, `app/(tabs)/*`, `src/platform/*`, `src/theme/*`,
  `src/components/ConnectionBanner.tsx`.
- **Зависит.** S1, S7, D1 (токены облика). Интерфейсы A11 и A12 можно заглушить.
- **Приёмка.**
  1. Сборка Personal Team запускается на iPhone, вкладки переключаются, плашка подключения видит локальный
     dev-relay по Wi-Fi.
  2. Кейсы `jest-expo` на адаптеры `Platform`, в том числе: при `__DEV__ = false` частный адрес relay отвергается
     до открытия сокета.
  3. Свежая установка → записи Keychain с прошлой установки стёрты (ручная проверка на iPhone, шаг в чек-листе
     A20).
- **Проверка.** `pnpm --filter @parley/mobile typecheck`; `pnpm --filter @parley/mobile test`; `pnpm exec eslint packages/mobile`; сборка по командам из
  README пакета.

#### A14. Приложение: паринг, хосты, Settings

- **Объём** (§11.2 пп. 1, 7, 8).
  - Сканер; экран подтверждения для ссылки `parley://pair`; имя устройства; экран SAS; итог.
  - Запрос разрешения на уведомления.
  - Settings: хосты, «Remove», уведомления, версия, диагностика.
  - Плашка подключения со всеми состояниями.
- **Файлы.** `packages/mobile/app/pair/*`, `app/(tabs)/settings/*`, `src/components/*`.
- **Зависит.** A11, A13, D1.
- **Приёмка.**
  1. Кейсы: компонент SAS показывает код из `onSas`; экран подтверждения ссылки нельзя пропустить.
  2. Экраны по макетам D1 (скриншоты iOS).
- **Проверка.** `pnpm --filter @parley/mobile typecheck`; `pnpm --filter @parley/mobile test`; `pnpm exec eslint packages/mobile`; скриншоты;
  сквозной паринг — в A20.

#### A15. Приложение: Inbox, Works, Session

- **Объём** (§11.2 пп. 2–4, §11.4).
  - Inbox, список работ, экран сессии.
  - Карточки разрешения, вопроса и плана с действиями; «Always» — только если CLI предложил.
  - «Answer at your Mac».
  - Markdown без HTML и удалённых картинок; ссылки — через подтверждение.
  - Haptics и блокировка кнопки до ответа; итоги `applied`, `stale`, `lost`.
- **Файлы.** `packages/mobile/app/(tabs)/{inbox,works}/*`, `app/session/[ref].tsx`, `src/cards/*`,
  `src/markdown/*`.
- **Зависит.** A12, A13, D1.
- **Приёмка.**
  1. Кейсы: карточка без `permission_suggestions` не показывает «Always»; Markdown с `<img src=https://…>` и
     `![](https://…)` не делает сетевого запроса (мок `fetch` / `Image`).
  2. Экраны по макетам D1.
- **Проверка.** `pnpm --filter @parley/mobile typecheck`; `pnpm --filter @parley/mobile test`; `pnpm exec eslint packages/mobile`; скриншоты.

#### A16. Приложение: Decision, Letters, push

- **Объём** (§11.2 пп. 5–6, §9).
  - `DecisionCard` с `rev`; экран `conflict` с новым текстом.
  - Letters только для чтения.
  - Push:
    - токен APNs → `push.register` внутри Noise после каждого `ready` и при смене токена (§9.1);
    - тап → хост по `data.route` (`routeId` записи хоста), Inbox; неизвестный `route` → список хостов;
    - снятие уведомлений хоста при открытии;
    - нет токена (iPhone на Personal Team) — `push.register {apnsToken: null}`, в Settings строка «Notifications
      unavailable on this build», остальное работает.
- **Файлы.** `packages/mobile/app/room/[id]/decision.tsx`, `app/letters/*`, `src/push/*`.
- **Зависит.** A12, A13, A1 (формат push и `push.register`), D1.
- **Приёмка.**
  1. Кейсы: `resolveProposal` уходит с `rev` показанной ревизии; `conflict` показывает новый текст и не повторяет
     вызов.
  2. Разбор `data` push выбирает нужный хост из двух по `route`; неизвестный `route` открывает список хостов.
     Ошибка получения токена не мешает подключению (кейс с моком `getDevicePushTokenAsync`).
  3. Экраны по макетам D1.
- **Проверка.** `pnpm --filter @parley/mobile typecheck`; `pnpm --filter @parley/mobile test`; `pnpm exec eslint packages/mobile`; скриншоты;
  живой push — A20.

#### A17. Сквозной и пограничный тесты — ревью senior

- **Объём** (§15, §2).
  - Сквозной тест на Node: стаб хоста ← мост ↔ локальный relay ↔ `remote-client` с `Platform` для Node. Сценарий
    §15, десять шагов, в том числе ответ «на Маке» с последующим запросом без переподключения и push второго
    хоста.
  - Пограничный тест рамки:
    - белый список против `REMOTE_FORBIDDEN`;
    - хост с ролью `remote` (из A2);
    - мост в этапе A не открывает TCP-слушателей — шпион на `net.Server.prototype.listen`: только unix-путь.
  - Режим внешнего relay: `PARLEY_E2E_RELAY_URL` — подмножество сценария против развёрнутого узла вместо
    локального; без переменной режим пропускается. Что проверяет каждый режим:

    | Шаг §15 | Локальный relay | Внешний relay |
    |---|---|---|
    | 1–3: паринг, подключение, снимок | да | да |
    | 4: `blocked` у стаба хоста | да | да |
    | 5: push | да, мок push-шлюза внутри теста | да: push идёт мимо relay, к тому же моку шлюза. Доставку на устройство проверяет A24 |
    | 6–8: решения, обновление карточек, `conflict` | да | да |
    | 9: push второго хоста | да | да, мок шлюза; на устройстве — A24 |
    | 10: отзыв | да | да, плюс `unknown_device` от узла на следующем `connect` |

    Внешний режим использует отдельный маршрут, который каждый прогон создаёт заново (`routeId` теста), и
    реальных телефонов не касается.
- **Файлы.** `packages/remote/test/{e2e,frame-boundary}.test.ts`, тестовый `Platform` в
  `packages/remote-client/test/node-platform.ts`.
- **Зависит.** A2, A4, A11, A12, A22. Мок шлюза — по схеме A1, без A5.
- **Приёмка.** Все шаги сценария проходят; пограничный тест падает, если временно добавить `settings.set` в
  список (проверяет verifier).
- **Проверка.** `pnpm -r build`; `pnpm -r test`; внешний режим — `PARLEY_E2E_RELAY_URL=<узел> pnpm --filter @parley/remote test -- e2e`.

#### A18a. Мастер установки relay по SSH — ревью senior

- **Почему ревью senior.** Безопасность: SSH-креды пользователя и команды с `sudo` на его сервере (спека §6.7,
  §14).
- **Объём** (§6.7). В main-процессе окна, SSH — `ssh2`; UI — шаг в Settings → Remote access.
  - Ввод: хост или IP, порт, пользователь; ключ из `~/.ssh` или `ssh-agent`, либо пароль; необязательный домен.
  - Ключ хоста: отпечаток на подтверждение, хранение в `~/.parley/remote/known_hosts`, смена ключа → остановка.
  - Разведка только чтением: ОС, архитектура, `sudo`, Docker и Compose, слушатели 80/443, `ufw`, прежняя установка.
  - План команд целиком на экране, выполнение только после «Run», живой лог по шагам.
  - Шаги-шаблоны, каждый «проверить → сделать»: Docker из официального apt-репозитория; `/opt/parley-relay/` с
    шаблонами A4; образ по digest версии Parley; Caddy с Let's Encrypt; `ufw`; `docker compose up -d`.
  - Адрес: свой домен (проверка A/AAAA) или `<ip-через-дефисы>.sslip.io`.
  - Занятые порты: 443 занят и 80 свободен → Caddy на 8443; 80 занят → relay на `127.0.0.1`, сниппет reverse
    proxy для найденного nginx или Apache, чужие конфиги не правятся.
  - Проверка здоровья с Мака по TLS с системной проверкой сертификата, затем `configure` моста.
  - Повторный запуск = обновление с сохранением `data/`; «Roll back» к прошлому digest; «Remove relay».
  - Ubuntu 22.04 / 24.04 и Debian 12; другая ОС — остановка после разведки и ссылка на ручную инструкцию.
  - Креды: только в памяти main на один прогон, не в renderer, не на диске, не в Keychain, не в логе.
  - Публикация образа relay (GHCR, `amd64` и `arm64`, digest в сборке Parley) — шаг выпуска; публикует человек.
- **Файлы.** `packages/desktop/src/main/relay-setup/{ssh,probe,plan,steps,templates,health,known-hosts}.ts`,
  `packages/desktop/src/renderer/settings/remote/RelaySetup*.tsx`, `shared/strings.ts`, тесты;
  `packages/desktop/test/relay-setup/` — стенд на Docker (Ubuntu 24.04 и Debian 12 с `sshd`).
- **Зависит.** A4 (шаблоны и образ), A10 (экран Settings).
- **Приёмка** (кейсы на стенде):
  1. Первый прогон на чистом Ubuntu 24.04 и Debian 12 ставит Docker и relay; `/v1/health` по TLS отвечает
     (на стенде — сертификат тестового ACME, Pebble).
  2. Второй прогон без изменений версии ничего не меняет: план пуст или только проверки.
  3. Обновление меняет digest, `data/` и маршрут на месте: стаб моста подключается тем же `routeSecret`.
  4. «Roll back» возвращает прошлый digest; «Remove relay» убирает каталог и правила `ufw` мастера, `data/` — только
     после отдельного подтверждения.
  5. На стенде с nginx на 80/443 мастер не трогает его конфиги и показывает сниппет; со свободным 80 и занятым
     443 — Caddy на 8443, порт попадает в адрес Relay.
  6. Смена ключа хоста между прогонами → остановка без выполнения команд.
  7. Поля с `; rm -rf /`, `$(…)`, переводом строки, пробелами в домене отвергаются до подключения.
  8. Тест-греп: пароля SSH, пароля `sudo` и парольной фразы нет в логе прогона, в IPC renderer и на диске.
  9. Неподдерживаемая ОС (стенд Alpine) → остановка после разведки, на сервере ничего не изменено.
- **Проверка.** `pnpm --filter @parley/desktop test`; `pnpm typecheck`; `pnpm exec eslint packages/desktop`;
  стенд — командой из README теста. Ревью критика старшего уровня.

#### A18b. Relay на сервере человека и проверка из мобильной сети

До A18b весь этап A идёт на локальном dev-relay (§6.6). A18b ставит relay на сервер человека мастером A18a
(Р1 решено).

- **Объём.**
  - **Установка** (после A18a): мастер ставит relay на сервер человека; домен или `sslip.io` — по выбору
    человека. Резервная копия `data/`, мониторинг `/v1/health`.
  - **Завершение** (после A17): сквозной сценарий в режиме внешнего relay.
  - **Мобильная сеть** (после завершения и A14). Мак дома на Wi-Fi, iPhone на LTE с выключенным Wi-Fi:
    - паринг по QR через сервер, подключение, снимок Inbox, одно решение;
    - переход Wi-Fi ↔ LTE при открытом приложении — переподключение без действий человека; сценарии S4 с LTE;
    - время подключения и RTT `ping` из диагностики Settings — таблица Wi-Fi / LTE рядом с локальными числами
      S3b.

    Телефоны, сопряжённые с dev-relay, паруются заново (§6.6).
- **Файлы.** `packages/relay/DEPLOY.md` (по-английски: мастер и ручной путь); секреты — вне репозитория; таблица
  мобильной сети — `docs/audits/2026-11-XX/mobile-relay-network.md`.
- **Зависит.** Установка — A18a; сервер даёт человек. Завершение — A17. Мобильная сеть — завершение и A14.
- **Приёмка.**
  1. Мастер прошёл на сервере человека; `/v1/health` отвечает по TLS; повторный прогон ничего не меняет.
  2. `PARLEY_E2E_RELAY_URL=<узел> pnpm --filter @parley/remote test -- e2e` проходит по столбцу «Внешний relay»
     таблицы A17.
  3. Таблица мобильной сети заполнена. Переход Wi-Fi ↔ LTE восстанавливает связь в пределах запаса §10.2, иначе —
     правка спеки и задача-исправление до A20.

  Живая доставка push в A18b не проверяется — её проверяет A24.
- **Проверка.** Verifier повторяет команды пп. 1–2 и один прогон мобильной сети.

#### A19. Документы

- **Объём.**
  - README: раздел «Remote access (mobile)» — честная рамка п. 10, что видят relay и push-шлюз, ограничения push
    (Мак не спит, шлюз один на всех), как включить, как отозвать.
  - `packages/relay/README.md`: мастер установки, ручной путь, локальный dev-relay для разработки с
    предупреждением «no TLS»; у каждого пользователя свой relay.
  - `packages/push-gateway/README.md` — из A5, сверка с кодом.
  - CHANGELOG.
  - Строка README про «the window's only network request» правится так, чтобы было ясно: мост ходит в сеть только
    при включённом Remote access, окно — ещё и по SSH, когда человек запускает мастер.
- **Файлы.** `README.md`, `packages/relay/README.md`, `packages/push-gateway/README.md`, `CHANGELOG.md`.
- **Зависит.** A5, A6a–A18b, A22, A23.
- **Приёмка.** Ревью ведущего: каждое утверждение README сверено со спекой и кодом.

#### A20. Приёмка на устройствах — verifier и человек

- **Объём.** Чек-лист на iPhone против relay на сервере человека (A18b). Сборка Personal Team, если аккаунт Apple
  ещё не оплачен, иначе TestFlight. Пункты push (12, 15) без аккаунта и шлюза не проверить — они проходят в A24.
  1. паринг;
  2. несовпадение SAS → Deny;
  3. гонка: второй телефон (второй iPhone или тестовый клиент на Node) сканирует тот же QR;
  4. решение разрешения;
  5. решение комнаты; `conflict` после правки ведущим;
  6. отзыв;
  7. сброс;
  8. фон и возврат;
  9. Wi-Fi ↔ LTE;
  10. Мак выключен;
  11. relay выключен;
  12. push при убитом приложении и заблокированном экране — A24;
  13. переустановка приложения → нужен новый паринг;
  14. перезапуск Parley на Маке при открытом приложении: «Mac is starting…», затем свежее состояние без
      перезапуска приложения;
  15. два Мака на одном телефоне: push второго открывает второй — A24; переключение хостов без push — здесь.

  **Проверки спайка на устройстве** (правки 7: отдельных прогонов спайка на iPhone нет, они идут здесь, один
  раз, на приложении с полным дизайном; шаги — `packages/mobile/SPIKE.md` ветки `parley/w-0054/s-128` и итог S7 §8):
  16. скорость крипто Hermes на телефоне: таблица S2 (модель записать) — одна сторона IK, ChaCha20-Poly1305 64 КиБ
      и 1 МиБ на `@noble`; сверка с порогом итога S7 §7.1 (одна сторона IK ≤ 150 мс, 64 КиБ ≤ 50 мс). Сверх порога —
      быстрые примитивы (`react-native-quick-crypto`) становятся задачей-исправлением;
  17. `react-native-quick-crypto` ставится и работает в сборке Personal Team на устройстве (если п. 16 его требует);
  18. связь по Wi-Fi с dev-relay на Маке (S3b): open, первый байт, медиана RTT, 1 МиБ — опора для п. 9 и A18b;
      запрос Local Network и поведение при отказе; релизная сборка не принимает `ws://` (код, а не ATS);
  19. фон и переподключение (S4): фон 5, 30 и 60 с, блокировка, Wi-Fi off 10 с, режим полёта 10 с — жив ли
      сокет, события AppState и NetInfo, время нового коннекта;
  20. запас фона 30 с (§10.2): подтверждён или нужна правка — по сценариям фона 30 и 60 с п. 19;
  21. установка Personal Team, скан QR системной камерой и сканером приложения, Keychain после перезапуска (S1).
- **Файлы.** `docs/audits/2026-11-XX/mobile-mvp-acceptance.md`.
- **Зависит.** A13–A18b, A23. Мак — собранный `.app` из A23, не dev-сборка.
- **Приёмка.**
  - **Блокирующие пункты** — 1–7, 10, 11, 14, 15 (без push): паринг, гонка, решения, отзыв, сброс,
    восстановление связи. Пп. 12 и 15 (push) — блокирующие в A24.
    Каждый должен пройти. Провал → задача-исправление → повторный прогон этого пункта и тех, что от него
    зависят. Только после этого A20 закрыт.
  - **Остальные** (8, 9, 13) можно отложить, только если человек явно согласился. Отложенный дефект записан в
    отчёте с задачей.
  - **Проверки спайка** (16–21) — блокирующие по записи: каждое число снято и внесено в итог S7 §8. Если число
    противоречит выводам S7 (п. 16 сверх порога, п. 20 — запас не держится), решение S7 пересматривается с
    человеком, а исправление — отдельная задача.
  - Человек подписывает отчёт.

#### A21. Выпуск Android — перенесён в блок 2.5

#### A24. Выпуск iOS — после оплаты аккаунта Apple Developer

- **Объём.**
  - Аккаунт: App ID с push, ключ APNs `.p8` (Sandbox & Production), профили подписи.
  - **Push-шлюз A5 на сервере автора:** образ, TLS, секреты `.p8`, Key ID, Team ID и тема в окружении,
    мониторинг `/v1/health`; адрес шлюза — в сборку Parley.
  - `eas.json`: профили TestFlight и App Store; версии и номера сборок.
  - Сборка в TestFlight на устройства человека.
  - Пункты A20, которые на Personal Team не проверить: 12 (push при убитом приложении и заблокированном экране)
    и 15 (push второго Мака открывает второй). Плюс `apns-collapse-id`: второй push того же хоста заменяет
    первый; `badge` равен счётчику.
  - Страница политики приватности: что видят relay и push-шлюз, что уходит в push.
  - Карточка App Store, ярлыки приватности (по той же странице), заметки для App Review с доводом по guideline
    4.2.7 (спека §17 п. 2).
- **Файлы.** `packages/mobile/eas.json`, `packages/mobile/RELEASE.md`, `packages/push-gateway/DEPLOY.md`,
  `docs/promo/`; ключи и сертификаты — вне репозитория; результаты пп. 12 и 15 — в отчёт A20.
- **Зависит.** A20, A5, Р3. Оплаченный аккаунт Apple Developer и сервер для шлюза — от человека.
- **Приёмка.**
  1. `/v1/health` шлюза отвечает по TLS; лог шлюза после прогона пп. 12 и 15 без токенов и IP.
  2. Сборка TestFlight ставится и проходит пп. 12 и 15 A20 на iPhone — это блокирующие пункты.
  3. Обновление TestFlight N → N+1: паринг сохраняется, подключение без нового QR.
  4. Переустановка → записи Keychain стёрты, нужен новый паринг (A13 п. 3) — на релизной подписи.
  5. Пакет для App Review готов; подаёт человек. Публичная выкладка — после внешнего криптоаудита (раздел 4).
- **Проверка.** Verifier повторяет пп. 1–2 на одном iPhone по `RELEASE.md`.

### 2.2 Сводка senior-only

| Задача | Причина |
|---|---|
| A2 | граница доступа хоста |
| A3 | крипто: своя машина Noise |
| A7 | крипто-протокол моста и выдача сессии к хосту |
| A11 | восстановление связи и крипто на клиенте |
| S7, D1 | решения, на которых стоит этап (выбор библиотек, облик), — не код |

Ревью критика старшего уровня обязательно ещё для A4, A5, A8, A18a, A22 и A17: безопасность relay, публичный
вход и ключ push-шлюза, белый список моста, SSH-креды и команды мастера, порядок старта и остановки моста,
пограничный тест. В этапе B senior-only — ещё B16 (Live Activity, раздел 3).

Номера A22 и A23 добавлены после ревью плана, A24 — по вводным человека, A18a/A18b — по правкам 5; порядок
выполнения — по графу 2.3, а не по номерам.

### 2.3 Порядок и параллельность

```
Сразу:             D1
Р9 (можно до S7):  A1 ──┬─▶ A2*
                         ├─▶ A6a ─▶ A6b
                         └─▶ A5
После S7:          A3*   A13(из S1)   A4 (после A1)   A1b (после A1)   A12 (после A1b)
                   A3, A4, A6a ─▶ A7*
                   A1b, A6a, A6b ─▶ A8
                   A1, A3 ─▶ A11*
                   A6a (+A7) ─▶ A10
                   A6b, A8 ─▶ A9
                   A6a, A6b, A7, A8, A9 ─▶ A22
                   A10, A22 ─▶ A23
                   A4, A10 ─▶ A18a
                   A11, A13, D1 ─▶ A14
                   A12, A13, D1 ─▶ A15
                   A12, A13, D1 ─▶ A16
                   A2, A4, A11, A12, A22 ─▶ A17
                   A18a ─▶ A18b (установка);  A17 ─▶ A18b (завершение)
                   A18b (завершение), A14 ─▶ A18b (мобильная сеть)
                   A13–A18b, A23 ─▶ A20;  A5, A6a–A23 ─▶ A19
                   A20, A5 + оплаченный аккаунт Apple ─▶ A24
После приёмки A:   блок 2.5 (Android), этап B
* senior-only
```

До A18b все задачи с relay работают на локальном dev-relay из A4 (`pnpm --filter @parley/relay dev`).

Пик параллельности — 5–6 исполнителей: волна после A7/A11 (A8–A10, A14–A16, A18a). Критический путь:
S7 → A3 → A7 → A22 → A17 → A18b (завершение и мобильная сеть) → A20 → A24, как только оплачен аккаунт Apple.
A5 и A18a идут вне критического пути.

### 2.4 Что ждёт решений человека

| Задача | Решение |
|---|---|
| A18a, A18b | Р1 решено: свой relay, мастер по SSH; сервер (и по желанию домен) — к A18b |
| A5, A9, A24 | Р2 решено: push-шлюз автора; сервер для шлюза и ключ `.p8` — к A24 |
| S1, A13 | Р3 решено: сначала iOS; Apple ID для Personal Team |
| A24 | Р3 решено; оплаченный аккаунт Apple Developer |
| Блок 2.5 | Р3: Android после этапа A; FCM или UnifiedPush/ntfy — решение человека при старте блока |
| A13 | Р8 решено 2026-10-31: iOS 17+ |
| A1, A2, A5, A6a, A6b до конца спайка | Р9 решено: начаты до конца спайка |
| A3 и задачи после S7 | S7 подтверждён 2026-10-31 (правки 6) |
| Этап B: B11 | Р4 — открытый вопрос: должна ли релизная сборка без сервера работать в той же сети Wi-Fi |
| Этап B: B13 | Р6 |
| Этап B: B16 | Р10 — что видно на плашке Live Activity |
| Этап C: C1 | Р5 |

### 2.5 Отложено: Android (после приёмки этапа A)

Android не удалён, а отложен (Р3, правки 5). Блок планируется после приёмки этапа A; общий клиент
(`remote-client`, протокол, мост, relay) не меняется, правки — по итогам AN1.

| Задача | Что | Заметки |
|---|---|---|
| AN1 | Спайк Android: Android-части бывших S1–S4 — debug-APK с экраном «Probe», крипто на Hermes на среднем Android, связь с dev-relay (cleartext только в debug через network security config), фон, Doze и переподключение | итог — правки спеки, как S7 |
| AN2 | Выбор и реализация push: FCM HTTP v1 (Firebase, через push-шлюз автора) или UnifiedPush/ntfy (ntfy ложится на прямой APK и self-host у пользователя, телефоны без сервисов Google) | решение человека по итогам AN1; ревью senior: схема шлюза или ntfy-сервера |
| AN3 | Приложение на Android: Material 3, предиктивный «назад», Material Symbols, канал уведомлений `needs-you`, Keystore в `expo-secure-store`, профиль preview-apk | экраны по макетам D1 с Android-вариантами |
| AN4 | Приёмка A20 на Android: тот же чек-лист, включая push при убитом приложении и в Doze | блокирующие пункты — как в A20 |
| A21 | Выпуск Android: подпись (ключ вне репозитория, где — решает человек), релизный APK, GitHub Releases с SHA-256, инструкция установки; чистая установка и обновление N → N+1 тем же ключом с сохранением паринга; push работает в релизной сборке | прежняя приёмка A21; публичная выкладка — после внешнего криптоаудита (раздел 4) |

---

## 3. Этап B — «вести» (3–5 недель)

Крупные блоки. План этапа пишется после приёмки A.

| Блок | Что | Заметки |
|---|---|---|
| B1 | Белый список B на хосте и в мосте, правила параметров | ревью senior |
| B2 | Мультиплексирование подписок в мосте: `feed.subscribe`, `pty.attach` | senior-only: конкурентность счётчиков подписок |
| B3 | Лента комнаты с вводом и `@`, `rooms.send` с защитой от дубля (`clientMsgId` и дедупликация в мосте), `mail.markRead` | |
| B4 | Лента сессии `feed.*` (редьюсер из `@parley/core/feed-turn`), `pty.send`, «Stop» (`feed.interrupt`) | |
| B5 | Терминал только для просмотра: xterm в WebView, снимок и поток, без `pty.resize` | замер производительности на длинной сессии |
| B6 | `sessions.resume` / `sessions.stop` | |
| B7 | Карточки согласий `consents.*` | |
| B8 | Кэш на диске для холодного старта, защита файлов | |
| B9 | Общий Inbox по нескольким хостам | |
| B10 | Ротация ключа устройства `device.rotate`; журнал на телефоне | senior-only: крипто |
| B11 | Прямой путь: `127.0.0.1` за Tailscale Serve, проверки `Host`/`Origin`, гонка путей в супервизоре | по Р4; senior-only: переподключение |
| B12 | Несколько узлов relay | |
| B13 | Биометрия на решения | по Р6 |
| B14 | Перенесён в блок 2.5 (AN2): push без сервисов Google решается вместе с Android | |
| B15 | Push «закончил ход» за переключателем, по умолчанию выключен | |
| B16 | Live Activity (спека §9.6): спайк (доставка токена обновления, JS в фоне для `LiveActivityIntent`, `@bacons/apple-targets` против Voltra); расширение виджета; `push.register` с токенами LA и `laKey`; правила старт / обновление / конец по `presence locked` и лимитам; `POST /v1/live-activity` в шлюзе A5; `live.decide` со сверкой `fp`; Allow — только на разблокированном телефоне; переключатель в окне | senior-only: крипто (`fp`, `laKey`, `detail`) и привязка решения к карточке; по Р10; нужен оплаченный аккаунт Apple и шлюз A24 |

## 4. Этап C — полный доступ

- **C1.** `sessions.create` за переключателем в окне (Р5).
- **C2.** Ответы Codex без хуков — по отдельной разведке.
- **C3.** Перенесён в этап A как A24 (Р3).
- **C4.** Виджеты, Notification Service Extension для зашифрованных деталей. Live Activity — B16.
- **C5.** iPad.
- **C6.** Джарвис как второй клиент `remote-client`.
- **Внешний криптоаудит** `@parley/noise`, A7 и A11 — до публичной выкладки, то есть до публикации A21 и A24.
  Вопрос commit-then-reveal для SAS (спека §7.11 п. 3) — туда же.

## 5. Ревью критика

Ревью плана s-93, первый круг (m-1725): семь major и одно minor, все приняты.

| № | Замечание | Где учтено |
|---|---|---|
| 1 | мост в собранном `.app` | A23 (новая), A20 — приёмка на `.app` |
| 2 | A6 разделена; есть задача сборки моста | A6a, A6b, A22 (новая); обработчики отзыва и сброса — у A7 |
| 3 | команды проверки — по реальным скриптам | раздел 0, «Проверка» всех задач |
| 4 | провалы приёмки закрываются до выпуска | A20 — блокирующие пункты |
| 5 | порядок спайка и A18 | S3a / S3b, A18 — подготовка и завершение, A17 — режим внешнего relay, граф 2.3 |
| 6 | проверка обновления Android | A21 — чистая установка и обновление тем же ключом |
| 7 | набор шифров замораживается в S7 | S7, A3 |
| 8 | итог сброса в тесте | A7 п. 13 |

Второй круг (m-1727): 1, 3, 4, 6, 7, 8 закрыты. Ещё два:

| № | Замечание | Где учтено |
|---|---|---|
| 2.1 | A6b собирается только после манифеста пакета | A6b зависит от A6a, граф 2.3 |
| 2.2 | что проверяет режим внешнего relay | A17 — таблица шагов по режимам; A18 — столбец «Внешний relay»; push на устройстве — A20 |

**Правки 3 — вводные человека, 2026-10-29** (письмо ведущего s-38, m-1730). Меняются рамки и порядок, не
крипто, поэтому без критика:

| № | Вводная | Что изменено |
|---|---|---|
| 3.1 | Человек в Казахстане, ограничения РФ — не исходные условия | S3b без операторов РФ и белых списков; S5 без «сети РФ»; A21 — Google Play вместо RuStore; B14 |
| 3.2 | Аккаунт Apple оплачивается до выкладки, iOS наравне с Android | блок W удалён (разделы перенумерованы: B — 3, C — 4, ревью — 5); S1, S5, S7 без PWA и web; A16 — работа без push-токена; A20 — iPhone пп. 12 и 15 в A24; новая A24 «Выпуск iOS»; C3 перенесён в A24 |
| 3.3 | Relay — на сервере человека, Р1 решено | S7 не выбирает узел; A18 — сервер человека; 2.4 |
| 3.4 | Сначала всё локально, сервер — в конце этапа A | вступление этапа 0; S3a — локальная заглушка на Маке; S3b — связь по Wi-Fi и dev-профиль; S4 — без LTE; A1 — `relayUrlFor`; A4 — скрипт `dev`; A7, A13 — схема по §6.6; A18 — перенос на сервер и проверка из мобильной сети; граф 2.3 |
| 3.5 | Р1 и Р3 решены | S7 (приёмка), 2.4 |

**Правки 4 — решение человека, 2026-10-29.** Меняется способ выкладки Android, не крипто, поэтому без критика:

| № | Вводная | Что изменено |
|---|---|---|
| 4.1 | Android — прямой APK (GitHub Releases) вместо Google Play | A21 — без AAB, карточки Play, Data safety и закрытого теста; публикация в GitHub Releases с SHA-256; 2.4 — без аккаунта Play Console |

**Правки 5 — решения человека, 2026-10-30** (спека §20, правки 6). Меняются платформы, push, хостинг relay и
объём этапа B, не крипто этапа A, поэтому без критика. B16 и A18a идут на критика при планировании и ревью.

| № | Решение | Что изменено |
|---|---|---|
| 5.1 | iOS первым, Android — после этапа A; Firebase на этапах 0 и A не нужен | статус; этап 0: вступление, S1–S4 только iPhone, S5 снята, S7, параллельность; A13–A16 без Android; D1; A20 только iPhone; A21 и Android-части спайка — **новый блок 2.5** (AN1–AN4, A21); B14 → AN2; C3; 2.3; 2.4 |
| 5.2 | Relay у каждого пользователя свой, адрес — в Settings Мака и в QR | A18b; A19; 2.4 |
| 5.3 | Мастер установки relay по SSH из окна | **A18 разделена: A18a (мастер, новая) и A18b** (установка мастером, внешний e2e, мобильная сеть); A4 — шаблоны `deploy/` и образы двух архитектур; A10 — кнопка мастера; раздел 0; 2.2; 2.3 |
| 5.4 | Один push-шлюз у автора, отдельно от relay | **A5 переписана** (`packages/push-gateway`); A1 — схемы шлюза и `push.register`; A8 — `push.register`; A9 — отправка в шлюз; A16 — токен через `push.register`; A17 — push через мок шлюза в обоих режимах; A19; A24 — развёртывание шлюза; 2.2; 2.3; 2.4 |
| 5.5 | Live Activity — этап B | **B16 (новый)**; C4; 2.2; 2.4 (Р10) |
| 5.6 | CloudKit не берём | только спека §18 |
| 5.7 | Без сервера — только путь в той же сети Wi-Fi | 2.4 (Р4 — открытый вопрос) |

**Правки 6 — итог спайка подтверждён человеком, 2026-10-31** (спека §20, правки 7–8; итог
`docs/research/2026-10-31-mobile-spike-results.md`). Набор шифров и протокол Noise не меняются. Новая задача A1b
мелкая и без крипто, поэтому без отдельного круга критика: её смотрит критик вместе с волной этапа A.

| № | Итог | Что изменено |
|---|---|---|
| 6.1 | S7 подтверждён; Р8 — iOS 17+; Р9 — задачи A1, A2, A5, A6a, A6b начаты до конца спайка | статус; S7 («Итог»); 2.4 |
| 6.2 | Набор `25519_ChaChaPoly_SHA256`, своя машина Noise, источник векторов `IKpsk0` | A3: объём, «Файлы», приёмка п. 7 (одна сторона) |
| 6.3 | Проекция снимка в этапе A | **A1b (новая)**; A8: проекция, приёмка пп. 11–12; A12: состояние на проекции; 2.3 |
| 6.4 | Склейка `activity.changed` по `ref` | A8 |

**Правки 7 — решение человека, 2026-10-31.** Отдельных прогонов спайка на iPhone нет: проверки на устройстве идут
один раз, в A20, на приложении с полным дизайном (A13–A16 поверх D1). Промежуточных сессий с телефоном для человека
не планируется.

| № | Решение | Что изменено |
|---|---|---|
| 7.1 | Проверки S1–S4 на устройстве — в приёмке A20 | S7 («Итог»); **A20: пп. 16–21 (новые)** и правило их приёмки; итог S7 §8 |

**Правки 8 — запрос человека к прототипу D1, 2026-10-31** (спека §20, правки 9). Экран работы строит то же дерево,
что сайдбар окна.

| № | Запрос | Что изменено |
|---|---|---|
| 8.1 | Подсессии, подкомнаты и рои — под главной сессией | A1b: в проекции `createdBy`, `ownerId`, `swarms` без текстов; приёмка п. 2 |
