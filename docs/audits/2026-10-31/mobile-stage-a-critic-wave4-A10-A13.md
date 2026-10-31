# Ревью критика, волна 4: A10 (окно, Remote access) и A13 (основа приложения)

Дата: 2026-10-31. Критик: s-176 (Opus), только чтение кода. Предмет: `feat/mobile-stage-a` на `4697043e`:
- (1) A10 — `packages/desktop/src/main/{remote-launcher,remote-control,remote-ipc}.ts`,
  `renderer/components/settings/{RemoteSettings.tsx,remote-pairing.ts}`, preload и `shared/strings.ts`,
  тестовый хук `PARLEY_BRIDGE_ENTRY`; скриншоты исполнителя `1-settings-off`, `2-settings-on`, `3-pairing-dialog`,
  `4-device-list`;
- (2) A13 — `packages/mobile/**` (`app.config.ts`, адаптеры `src/platform/*`, `src/runtime/*`,
  `src/components/{ConnectionBanner.tsx,banner-model.ts}`, `src/theme/tokens.ts`, `src/dev/seed-host.ts`) и
  `HostStore.wipeAll` в `packages/remote-client`.

Критерии: план (A10, A13), спека `docs/specs/2026-10-29-mobile-app-design.md` §5.3, §6.6, §7.4, §7.8, §11.1, §12;
дизайн D1 `docs/design/2026-10-31-mobile-mvp-screens.md` §4 (плашка), §6.5 (SAS), §12a, §17 (токены), §18.

**Итог.** Блокеров нет. Два major в окне (A10). Выключение Remote access не всегда останавливает мост: при гонке
с запуском и без подключения к сокету управления мост и телефоны продолжают работать. Поле relay подсказывает
формат, который настоящий мост отвергает. Скриншот 2 снят со стабом и этого не показывает. Основа приложения
(A13) верна в главном: релиз — только `wss://` до открытия сокета, стирание Keychain при первом запуске, `inactive`
не рвёт соединение. Дальше 14 minor.

## Major

### V1 (A10). Выключение Remote access не останавливает мост, если окно в этот момент не подключено к сокету управления

- **Где.**
  - `packages/desktop/src/main/remote-launcher.ts:102-111` — `stop()` шлёт `stop` только при `client.isConnected()`,
    иначе лишь закрывает клиента;
  - `packages/desktop/src/main/remote-ipc.ts:72-117` — `bringUp` / `bringDown` не упорядочены друг с другом;
  - `remote-ipc.ts:177-184` — `init()` при выключенном переключателе ничего не проверяет.
- **Сценарий 1 (гонка).** Человек включает Remote access: `bringUp` ждёт `launcher.start()`, а это запуск процесса
  и опрос сокета до 10 с. Через 2 с человек выключает. `bringDown` → `stop()`: клиент ещё не подключён — ничего не
  отправлено, состояние `off`. Затем `doStart` подключается, `bringUp` продолжается: слушатели, присутствие,
  `process = 'running'`. Мост работает, телефоны подключаются, а переключатель в окне выключен и сохранён
  выключенным.
- **Сценарий 2 (сирота).** После сценария 1 или после падения окна посреди запуска окно стартует заново с
  сохранённым «выключено». `init()` мост не трогает, и он работает до перезагрузки Мака: доступ с телефонов остаётся
  при выключенном переключателе.
- **Сценарий 3 (обрыв сокета).** Сокет управления закрылся при живом мосте. Окно показывает «The bridge stopped» и
  больше не подключается; выключение — опять без `stop`.
- **Исправление.**
  1. `stop()`: если не подключён — `tryConnect()`, затем `stop`. Нет сокета управления — завершить процесс по
     `bridge.pid` (SIGTERM, затем SIGKILL после срока) с проверкой, что pid принадлежит мосту.
  2. `setEnabled` упорядочить (одна очередь): выключение ждёт идущий `bringUp`. После `await launcher.start()` в
     `bringUp` — проверить `state.enabled`: выключено — сразу `bringDown`.
  3. `init()` при «выключено» пробует подключиться к сокету управления и останавливает найденный мост.
  4. Тесты: выключение во время запуска → в итоге мост остановлен; запуск окна с «выключено» при живом мосте → мост
     остановлен.

### V2 (A10). Поле relay подсказывает `wss://…`, а мост принимает только `host[:port]`

- **Где.**
  - `packages/desktop/src/shared/strings.ts` — `relayPlaceholder: 'wss://relay.example.com'`;
  - `RemoteSettings.tsx` — пометка «Local dev relay, no TLS» по префиксу `ws://`;
  - мост: `controlConfigureParams = z.strictObject({ relayUrl: relayHost })` (`packages/protocol/src/remote/pairing.ts`,
    `isValidRelayHost` — без схемы и пути, исправление m3);
  - `remote-ipc.ts:132-137` передаёт строку как есть.
- **Сценарий.** Человек вводит адрес так, как подсказано (`wss://relay.example.com` или `ws://192.168.1.10:8787`), и
  получает `bad_request` от настоящего моста. На скриншоте 2 `ws://192.168.1.10:8787` сохранён и «Relay: connected»
  только потому, что снят со стабом (`PARLEY_BRIDGE_ENTRY`). Пометка о dev-relay при верном вводе (`192.168.1.10:8787`)
  не появится никогда.
- **Исправление.** Поле — `host[:port]`: подсказка `relay.example.com`, пример `192.168.1.10:8787`. В main снять
  `ws://` / `wss://` и проверить `isValidRelayHost` до вызова, ошибку показать у поля. Пометку «Local dev relay, no
  TLS» показывать по `isPrivateRelayHost(relay)` — та же функция решает `ws://` на телефоне. Тест на настоящих схемах
  A1: ввод со схемой принимается как хост, путь или `@` — ошибка у поля.

## Minor

### A10

- **v3. Код SAS без разбивки.** `RemoteSettings.tsx` (`remote-pair-sas`), скриншот 3: `482913`. Телефон по D1 §6.5
  показывает `482 913`, спека §7.4 — «Your phone shows 123 456». Сверять одинаковую запись легче: разбить на две
  группы, моноширинно.
- **v4. «Platform: ios».** Сырое значение `platform` (скриншоты 3, 4). Показывать `iOS` (`android` → `Android`); имя —
  после очистки m4 от управляющих символов, это верно.
- **v5. Нет кнопки «Check».** Спека §12: «статус, кнопка «Check»». Есть только «Save»; проверка relay — строкой
  статуса после сохранения. Либо добавить «Check» (`status` после `configure`), либо поправить спеку.
- **v6. Нет переподключения к сокету управления.** `remote-ipc.ts:90-97`: по закрытию сокета — «The bridge stopped»,
  без попытки подключиться снова. Живой мост после короткого обрыва остаётся без окна: без присутствия (push
  перестают подавляться при активном Маке, §9.3) и без событий паринга. Повторять `tryConnect` с отступом, пока
  переключатель включён.
- **v7. Параллельные `connect()` клиента управления.** `remote-control.ts:96-122`: `connected` ставится после
  `hello`, два одновременных `connect()` создают два сокета, второй затирает первый. Сейчас их разводит `starting` в
  запускателе; защита в самом клиенте (общий промис подключения) дешевле, чем помнить это правило.
- **v8. Activity — сырые ISO-времена** (скриншот 4: `2026-10-31T16:15:58.183Z`). Местное время, как у Devices.
- **v9. Скриншот 1:** открыт Remote access, а в боковом списке выделен пункт Appearance (рамка фокуса). Проверить
  рецепт снимка или выделение текущего раздела.

### A13

- **v10. После `stop()` приложение не стартует снова.** `packages/mobile/src/runtime/runtime.ts` — `start()`
  идемпотентен через `#started`, `stop()` его не сбрасывает; `src/app/_layout.tsx:7-10` зовёт `stop()` в очистке
  эффекта. Перемонтирование корня (Fast Refresh, двойной вызов эффекта в StrictMode) оставляет приложение без
  супервизора. Сбрасывать `#started` в `stop()` или перезапускать в `start()` после `stop()`.
- **v11. Порядок записи в Keychain оставляет сирот, которых `wipeAll` не видит.** `src/platform/key-store.ts:51-60`:
  `put` пишет запись, потом индекс; `remove` пишет индекс, потом удаляет запись. Сбой между шагами оставляет запись с
  `dsPriv` вне индекса — её не найдёт ни `list()`, ни `wipeAll()` (`remote-client/src/host-store.ts:75-79`). Ключи в
  ход не пойдут, но цель §7.8 — не оставлять их после переустановки. Порядок: `put` — сначала индекс, потом запись;
  `remove` — сначала запись, потом индекс (`list()` уже пропускает id без записи).
- **v12. Тестовый хост dev-сборки остаётся первым и после настоящего паринга.** `src/runtime/runtime.ts` (`#start`) и
  `src/dev/seed-host.ts`: запись `dev-seed` пишется в Keychain и всегда `hosts[0]`. С A14 dev-сборка будет
  подключаться к поддельному хосту вместо сопряжённого. Держать тестовый хост только в памяти или удалять, как
  только есть настоящий; выбор текущего хоста — не «первый в списке».
- **v13. Долгое ожидание всегда называется «Can't reach relay».** `src/components/banner-model.ts:129-140`: после
  30 с в `waiting` плашка — «Can't reach relay» при любой причине. D1 §4 различает: relay недоступен (сокет к relay
  не открывается, нет `ready` за 10 с) и долгий отступ при доступном relay («Updating… · Retrying in N s · Retry»,
  нейтральная). Причина у супервизора есть (`relayError`, стадия отказа) — выбирать по ней.
- **v14. Плашка перерисовывается раз в секунду всё время и читает `hostStatus` без подписки.**
  `ConnectionBanner.tsx` — `useNow(state.supervisor !== null)` и `state.client?.store.getState().hostStatus`.
  `hostStatus` подхватывается только тиком (до 1 с задержки). Подписаться на стор клиента, тикать только когда на
  плашке есть часы.
- **v15. Анимация плашки без учёта Reduce Motion.** `ConnectionBanner.tsx` — `LayoutAnimation` пружиной всегда; D1
  §17.3, §18 — при Reduce Motion только fade 150 мс (`AccessibilityInfo.isReduceMotionEnabled`).
- **v16. Мелочи по токенам и проверке релиза.**
  - В `src/theme/tokens.ts` нет из D1 §17: точки `needsYou` (`#FF9500`), вариантов `tint` для Increase Contrast
    (`#8C4519` / `#F09A62`) и моно-ролей (команда, SAS). Добавить вместе с экранами A14 и A15.
  - Проверка, что в релизном `Info.plist` нет ключей локальной сети, — ручной шаг README. Включить его в чек-лист
    A20 / A24 (или скрипт с `expo config --type introspect`).

## Проверено и верно

**A10.**
- Диалог паринга привязан к своему запросу. `pair.answer` уходит с `requestId` открытого диалога. Перевыпуск
  оффера (`offer`) закрывает ждущий запрос, срок запроса закрывает диалог. Закрытие диалога (крестик, Esc) — это
  Deny. Фокус по умолчанию — на Deny, первой кнопке. `stale_request` показывается текстом.
- Таймер перевыпуска стоит, пока открыт запрос (`reissueDue`). `pair.offerClosed {bad-psk}` — новый QR сразу и строка
  «Someone tried to pair with a wrong code».
- `reset_failed` и `busy` — читаемые тексты. «Revoke all and reset key» — с подтверждением.
- Переключатель «Allow creating sessions and rooms from the phone» пишет `remoteCreate` через `settings.set`
  (`'1'`/`'0'` парсятся как флаг). Он выключен, пока конфиг не загружен, и при переопределении из окружения
  (`locked`).
- IPC: один канал `remote:call` с белым списком имён; preload отдаёт renderer'у только `remote.call` и `remote.on`.
  Окно говорит с мостом только через main и локальный сокет, не через relay.
- Присутствие: `getSystemIdleState(60)` раз в 15 с и на `lock-screen` / `unlock-screen`.
- `PARLEY_BRIDGE_ENTRY` действует только в несобранном приложении (`test-switches.ts`, тест).
- Тексты экрана соответствуют §12: фраза под переключателем, статусы моста, хоста и relay, «Codes match — Allow»,
  «(unverified)», «Phone connected ✓», Devices с «Revoke», Activity.

**A13.**
- `app.config.ts`: варианты `dev` и `release`. В релизе нет `NSLocalNetworkUsageDescription`,
  `NSAllowsLocalNetworking`, dev-клиента и `devRelay`. iOS 17. Строки камеры и Face ID по делу. Push выключен до A24.
- `createOpenSocket` проверяет схему до конструктора: `ws://` — только в `__DEV__` и только на частный адрес; тест на
  релиз есть. `probeRelay` строит адрес через `relayUrlFor` и никогда не бросает.
- Keychain: `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. Стирание при первом запуске идёт до любого чтения хостов, метка
  пишется после стирания (сбой между ними повторяет стирание). Один `HostStore` на приложение (`AppRuntime`).
- `inactive` (Face ID, Пункт управления) не переводит приложение в фон — D1 §12a.
- Тестовый хост — только `__DEV__` и вариант `dev` (`extra.devRelay`).
- `getRandomValues` для Noise — из `expo-crypto` (системный генератор).
- Плашка покрывает состояния D1 §4: Connecting, Updating с задержкой 1,5 с и «Last updated», No internet, Mac offline,
  Mac is starting, Parley isn't running, This Mac does not recognize this phone с «Pair again» / «Remove».
  Отозван и обе «Update» — экраны, не плашка. Объявление VoiceOver — при смене вида.
- Токены цветов, типографика и отступы — по D1 §17.
