# Мобильное приложение Parley — дизайн экранов MVP (D1, iOS)

Дата: 2026-10-31. Автор: s-176 (designer). Статус: черновик к ревью ведущего s-174, затем к приёмке человеком.

Основание:
- план `docs/plans/2026-10-29-mobile-app-plan.md`: D1, экранные задачи A13–A16;
- спека `docs/specs/2026-10-29-mobile-app-design.md`: §7.4 (паринг), §7.9 (отзыв и сброс), §8.2–8.4 (hello моста,
  события, ошибки), §9 (push), §10.2–10.3 (переподключение, перечитывание карточек), §11.2–11.4 (экраны, облик,
  поведение), §16 (решения человека);
- черновик S7 `docs/research/2026-10-31-mobile-spike-results.md` §7.3: телефон получает **проекцию** снимка работ;
- окно Parley: слова кнопок карточек и решений (`packages/desktop/src/shared/strings.ts`), чтобы телефон и Мак
  говорили одинаково.

Прототип: `packages/mobile/prototype/index.html` — один самодостаточный файл, открывается в браузере (раздел 13).

Объём: только iOS, только этап A. Android (блок 2.5), Live Activity и всё из этапа B — вне объёма; где экран этапа A
упирается в этап B, это сказано прямо.

---

## 1. Принципы облика

«Нативно отлично» (§11.3) значит: системные элементы и системное поведение, а не перенос окна Parley.

1. **Системные компоненты.** Native tabs, native stack с крупными заголовками и свайпом назад, сгруппированные
   списки (`insetGrouped`), системные листы (sheet) с ручкой, системные алерты только для разрушительных действий,
   контекстные меню вместо самодельных поповеров. На iOS 26 — Liquid Glass у панели вкладок, панели навигации и
   нижней панели действий (`expo-glass-effect`); на iOS 17–25 — системный материал `.bar` (запасной вариант).
2. **Решение — главное действие.** Человек берёт телефон, чтобы ответить. Кнопки решения крупные (высота 50 pt),
   внизу экрана, в зоне большого пальца. Опасное действие — не по умолчанию и не там, куда палец попадает случайно.
3. **Ничего не обещать, чего не знаем.** Пока нет соединения, решения недоступны, а на экране — последний снимок с
   отметкой времени. Неподтверждённый ответ не выдаётся за принятый (§11.4).
4. **Цвет — не единственный носитель смысла.** Каждое состояние сессии — точка цвета **и** символ или слово.
5. **Мало текста.** Одна строка причины, одна строка «чем занят». Длинное — по тапу.
6. **Тексты интерфейса — английские** (как в окне), документ — русский.

---

## 2. Данные, на которых стоят экраны

Экраны Works и Session спроектированы только на полях, которые есть у телефона в этапе A. Чего нет — в открытых
вопросах (раздел 14), а не в макетах.

| Источник | Что даёт экрану |
|---|---|
| Проекция снимка работ (S7 §7.3, V1) | снимок: `revision`, работы в порядке сайдбара; работа: `projectPath`, `id`, `title`, `status`, счётчики писем; сессия: `id`, `label`, `provider`, `model`, `role`, `parent`, `lifecycle`, `result`, `stuck`, последнее событие `{event, at}`, `startedAt`, `resultAt`; комната: `id`, `title`, `members`, `lead`, `mode`, `archived`, `proposal` (`id`, `kind`, `from`, `text`, `rev`, `at`), счётчики `{total, unread}` |
| `activity.snapshot` / `activity.changed` | `activity` (`working` / `blocked` / `unseen` / `idle`), `need` (`approval` / `question` / `limit` / вход и др., `detail`, `resetsAt`), `subagents`, `waitingFor`, `turnEndedAt`, `lastEventAt` |
| `feed.snapshot {ref, scope:'attention'}` | ждущие карточки `permission` / `question` / `plan` и последний ответ модели |
| `@parley/core/card-gist` | краткое описание карточки: `run` (команда), `tool` (инструмент и путь), `fetch` (URL), `question` (первая строка), `plan` |
| `@parley/core/attention`, `session-state` | `sessionAttention` → `needs-you` / `unseen` / `working` / `idle` / `off`; порядок как в сайдбаре окна; `needsYouCount` |
| `@parley/core/stuck` `needReason` | одна строка причины «нужен ты» (`Waiting for your approval: …`, `Asked you a question in its terminal`, лимит с временем сброса) |
| `rooms.mail`, `context.messages`, `context.letter` | письма человеку: список и текст |
| hello моста, `bridge.status` | `host` (`starting` / `online` / `offline` / `incompatible`), `epoch`, `minClient`, `hostName`, версии |
| супервизор `remote-client` (§10.2) | `idle` / `connecting` / `handshaking` / `ready` / `waiting` / `offline` / `blocked` |

**Поля проекции** — по черновику S7 после подтверждения человеком (2026-10-31, `f6a36d8d`): у комнаты есть
`title`, `members` и `lead`, у сессии — `parent`, у работы — `projectPath`. Этого хватает и на названия комнат
(вопрос В1 закрыт), и на группировку экрана Works по проектам и комнатам (раздел 8).

---

## 3. Карта навигации

```
Запуск
 ├─ нет хостов ───────────────▶ Welcome ─▶ Scanner ─▶ Device name ─▶ Handshake ─▶ SAS ─▶ Paired ─▶ Notifications ─▶ Inbox
 │                                 ▲                       ▲
 │  parley://pair?… (камера iOS) ──┴─ Confirm link ────────┘
 │
 └─ есть хост ─▶ Tabs ────────────────────────────────────────────────────────────────────────────────
                 │
                 ├─ Inbox (вкладка 1, бейдж = needsYouCount)
                 │    ├─ карточка разрешения ── Allow / Deny прямо в строке (без «Always»)
                 │    ├─ вопрос / план / сессия без карточки ─▶ Session
                 │    ├─ решение комнаты ─▶ Decision ─▶ (sheet) Return for rework
                 │    ├─ письмо ─▶ Letter
                 │    └─ кнопка ✉ в панели навигации ─▶ Letters ─▶ Letter
                 │
                 ├─ Works (вкладка 2): секции по проектам
                 │    └─ Work: комнаты-группы и дерево сессий ─▶ Session
                 │            ├─ строка комнаты — свернуть / развернуть
                 │            └─ строка решения комнаты ─▶ Decision
                 │
                 └─ Settings (вкладка 3)
                      ├─ Host ─▶ Rename (sheet), Remove from this phone (alert)
                      ├─ Pair another Mac ─▶ Scanner …
                      ├─ Notifications
                      └─ Diagnostics

Push (тап) ─▶ хост по data.route ─▶ подключение ─▶ Inbox; неизвестный route ─▶ Settings → Macs
Переключатель хоста — меню в заголовке Inbox и Works (только когда хостов ≥ 2).
```

Правила:
- Паринг — модальный поток (full-screen cover) поверх вкладок; при первом запуске вкладок за ним нет.
- Session, Decision, Letter, Letters, Host — push в стек своей вкладки, свайп назад работает везде.
- Return for rework и Rename — системный sheet средней высоты (`detents: medium, large`), с клавиатурой.
- Переход Inbox → Session сохраняет позицию списка Inbox; возврат по свайпу.
- Глубокие ссылки: `parley://pair?…` (паринг) и маршрут push. Других ссылок в этапе A нет.

---

## 4. Плашка подключения (A14, §11.2 п. 8)

Плашка — одна строка под панелью навигации на всех экранах вкладок и стека (`ConnectionBanner`). Она не
перекрывает контент, а сдвигает его; появляется и уходит пружиной (Reanimated, `damping 20, stiffness 220`).
Состояние `ready` при `host: online` плашки не показывает.

| Состояние | Откуда | Иконка | Текст | Вторая строка / действие | Решения | Цвет |
|---|---|---|---|---|---|---|
| Холодный старт | супервизор `connecting`/`handshaking`, снимка ещё нет | `ProgressView` | Connecting… | — (экран — скелет, раздел 5) | нет | нейтральный |
| Переподключение | `connecting`/`handshaking`/`waiting` при прошлом снимке | `arrow.triangle.2.circlepath` (вращение) | Updating… | Last updated 2 min ago | нет | нейтральный |
| Ждём отступ долго (> 30 с) | `waiting` | `arrow.triangle.2.circlepath` | Updating… | Retrying in 12 s · **Retry** | нет | нейтральный |
| Нет сети | супервизор `offline` (NetInfo + `/v1/health`) | `wifi.slash` | No internet connection | Last updated 2 min ago | нет | нейтральный |
| Relay недоступен | сокет к relay не открывается, `ready` от relay нет за 10 с | `antenna.radiowaves.left.and.right.slash` | Can't reach relay | relay.example.com · **Retry** | нет | предупреждение |
| Мак не в сети | relay `host_offline` | `desktopcomputer` + `zzz` | Mac offline | Your Mac is asleep or Parley is closed | нет | предупреждение |
| Хост запускается | `bridge.status host:'starting'` | `ProgressView` | Mac is starting… | — | нет | нейтральный |
| Хост не запущен | `bridge.status host:'offline'` | `exclamationmark.triangle` | Parley isn't running on your Mac | Open Parley on your Mac | нет | предупреждение |
| Не узнаёт телефон | relay `unknown_device` / `unknown_route` | `questionmark.circle` | This Mac does not recognize this phone | **Pair again** · **Remove** | нет | предупреждение |
| Отозван | `session.closing revoked` / `reset` (только внутри Noise) | — | экран на весь контент, раздел 11.4 | **Pair again** · **Remove** | нет | — |
| Нужна новая версия телефона | `minClient` > версии приложения | — | экран «Update required», раздел 11.5 | — | нет | — |
| Нужна новая версия Мака | `host:'incompatible'` или `protocol` клиента больше | — | экран «Update Parley on your Mac», раздел 11.5 | — | нет | — |

- Плашка «Updating…» не мигает на коротких разрывах: показывается, только если переподключение длится дольше
  1,5 с. Иначе пользователь видит её на каждом возврате в приложение.
- Тап по плашке открывает Settings → Diagnostics текущего хоста.
- Состояния «Не узнаёт телефон», «Отозван» и обе «Update» — `blocked` супервизора: выход только по действию
  человека. Неаутентифицированный сигнал relay ничего не стирает (рамка п. 12): кнопка **Remove** спрашивает
  подтверждение.
- Пока плашка видна, кнопки решений на экране выключены, а над ними подпись «Reconnecting — actions are paused».

---

## 5. Общие состояния экранов

| Состояние | Как выглядит | Где |
|---|---|---|
| Загрузка, данных нет | скелет строк (3–5 серых плашек, мерцание `opacity 0.4↔0.7`, 1,2 с; при Reduce Motion — без мерцания) | Inbox, Works, Work, Session, Letters, Letter, Decision |
| Пусто | символ 48 pt `secondaryLabel`, заголовок `title3`, одна строка `subheadline` | у каждого экрана свой текст |
| Ошибка чтения | символ `exclamationmark.triangle`, «Couldn't load», причина, кнопка **Try again** | Session, Letter, Decision (вызовы `feed.snapshot`, `context.*`) |
| Офлайн / переподключение | прошлый снимок + плашка раздела 4, решения выключены | все |
| Потянуть для обновления | системный `refreshControl`, триггер подключения (§10.2) и перечитывания | Inbox, Works, Work, Session, Letters |

---

## 6. Паринг (A14, §11.2 п. 1, §7.4)

### 6.1 Welcome — пустое состояние, хостов нет

```
┌───────────────────────────────┐
│                               │
│        [desktopcomputer]      │
│        [iphone] ⇄             │
│                               │
│    Pair with your Mac         │
│  On your Mac, open Parley →   │
│  Settings → Remote access →   │
│  Pair a device.               │
│                               │
│  ┌─────────────────────────┐  │
│  │ [qrcode.viewfinder] Scan│  │
│  │        QR code          │  │
│  └─────────────────────────┘  │
│  You can also scan it with    │
│  the Camera app.              │
└───────────────────────────────┘
```

- Кнопка **Scan QR code** — `borderedProminent`, на всю ширину минус поля.
- Подпись внизу про системную камеру: тот же поток через `parley://pair`, с экраном подтверждения.

### 6.2 Scanner

- Полноэкранный вид камеры, рамка 260×260 pt со скруглением 24 и затемнением вокруг, подпись «Point at the QR code
  on your Mac». Кнопка **Cancel** слева сверху, фонарик `flashlight.off.fill` справа.
- Код распознан → haptic `impact(light)`, рамка подсвечивается акцентом на 200 мс → экран имени.

| Состояние | Что видно |
|---|---|
| Разрешение камеры не спрошено | системный запрос (текст `NSCameraUsageDescription`: «Parley uses the camera only to scan the pairing code on your Mac.») |
| Камера запрещена | `camera.fill` с перечёркиванием (`video.slash`), «Camera access is off», **Open Settings** |
| Не тот QR (`bad_qr`) | плашка внизу: «This isn't a Parley pairing code», сканирование продолжается |
| Симулятор без камеры | то же, что «запрещена», плюс **Paste link** (только dev-сборка) |

### 6.3 Confirm link — вход по `parley://pair?…`

Ссылку могла открыть любая страница (§14 спеки), поэтому этот экран пропустить нельзя (приёмка A14, кейс).

```
  [exclamationmark.shield]
  Pair with a Mac?
  Continue only if you just scanned
  the code on your Mac.
  [ Continue ]        (borderedProminent)
  [ Cancel ]          (plain)
```

- Нет жеста «свайп вниз = Continue»: лист открывается как full-screen, свайп вниз — только отмена.

### 6.4 Device name

- Сгруппированный список: поле `Name` с именем модели по умолчанию («iPhone 16 Pro»), подпись «Your Mac shows this
  name when it asks to allow this phone.» Предел — 40 знаков.
- **Continue** в правом верхнем углу и кнопка внизу; Return на клавиатуре — то же.

### 6.5 Handshake и SAS

- Сначала «Connecting to your Mac…» со спиннером (relay `pair`, msg1, msg2). Таймауты — §10.2.
- После верного msg2 — экран SAS. Код показывается **только** после верного msg2 (§7.4).

```
┌───────────────────────────────┐
│ Cancel                        │
│                               │
│     Check your Mac            │
│                               │
│        123 456                │  ← SF Mono, 48 pt, моноширинные цифры, группы по 3
│                               │
│  Your Mac shows the same code.│
│  Click "Codes match — Allow"  │
│  there.                       │
│                               │
│  [ProgressView] Waiting for   │
│  your Mac…              1:54  │
└───────────────────────────────┘
```

- Haptic `impact(medium)` в момент появления кода — телефон в руке «щёлкает», внимание на экран.
- Таймер — оставшиеся из 120 с ожидания решения на Маке. В последние 10 с цифры `systemOrange`.
- VoiceOver читает код по цифрам: «1 2 3, 4 5 6» (`accessibilityLabel` с пробелами).
- Нет кнопки «коды совпадают» на телефоне: решает только Мак.

| Итог | Экран |
|---|---|
| `credentials` пришли | Paired (6.6) |
| `denied` | `xmark.octagon` «Your Mac denied this phone», **Try again** (новый QR) |
| `timeout` (120 с) | `clock.badge.exclamationmark` «Your Mac didn't answer in time», **Try again** |
| `offer_closed` | `qrcode` с перечёркиванием «This code was already used», «Make a new code on your Mac: Pair a device.», **Scan again**. Если на Маке при этом виден код — это попытка чужого телефона: на Маке нажмите Deny (подпись мелким текстом) |
| relay недоступен | «Can't reach relay», адрес relay из QR, **Try again** |

### 6.6 Paired и разрешение уведомлений

```
  [checkmark.circle.fill]  (зелёный, анимация «draw-on» 400 мс)
  Paired with Evgeniy's MacBook Pro
  [ Continue ]
```

- Haptic `notification(success)`.
- Затем свой экран перед системным запросом (запрос iOS — только один раз в жизни приложения):

```
  [bell.badge]
  Know when an agent needs you
  Parley sends a notification when a session
  waits for your answer. It shows only how many
  things are waiting — no names, no text.
  [ Turn on notifications ]   → системный запрос
  [ Not now ]
```

- Сборка без push (Personal Team): этот экран не показывается; в Settings — строка «Notifications unavailable on
  this build» (A16).
- После — вкладки, Inbox. Haptic не нужен.

### 6.7 Состояния паринга — сводно

Welcome · Scanner (нет разрешения / запрещено / не тот QR) · Confirm link · Device name · Connecting · SAS (ждём /
последние 10 с) · Paired · Notifications prompt · ошибки `denied` / `timeout` / `offer_closed` / relay недоступен.

---

## 7. Inbox (A15, §11.2 п. 2)

Первая вкладка. Всё, где нужен человек, **на текущем хосте**, сначала новые. Бейдж вкладки — `needsYouCount`,
тот же счётчик, что в push.

```
┌───────────────────────────────┐
│ Evgeniy's MBP ⌄           ✉ 3 │  ← меню хоста (только ≥ 2 хостов) и Letters
│ Inbox                         │  ← крупный заголовок
│ ┌───────────────────────────┐ │
│ │ ● Permission · 2 min      │ │
│ │ Mobile-D1-designer        │ │  ← label сессии, headline
│ │ Улучшайзинг               │ │  ← работа, subheadline secondary
│ │ ┌───────────────────────┐ │ │
│ │ │ $ pnpm lint           │ │ │  ← gist run: SF Mono, 2 строки максимум
│ │ └───────────────────────┘ │ │
│ │ [ Deny ]      [ Allow  ]  │ │
│ └───────────────────────────┘ │
│ ┌───────────────────────────┐ │
│ │ ● Question · 5 min        │ │
│ │ Task3-plan-rules          │ │
│ │ Which branch should I …   │ │
│ │                  Answer › │ │
│ └───────────────────────────┘ │
│ ┌───────────────────────────┐ │
│ │ ◆ Decision · 12 min       │ │
│ │ iOS app: stage A          │ │
│ │ Ship A1 with the …        │ │
│ │                  Review › │ │
│ └───────────────────────────┘ │
│ ┌───────────────────────────┐ │
│ │ ✉ Letter · 1 h            │ │
│ │ Greta → you               │ │
│ │ PR #143 is ready for …    │ │
│ └───────────────────────────┘ │
├───────────────────────────────┤
│ [tray 3]   [Works]  [Settings]│
└───────────────────────────────┘
```

### 7.1 Виды строк

| Вид | Иконка (SF Symbol) | Строки | Действие в строке | Тап |
|---|---|---|---|---|
| Разрешение, `gist.run` | `terminal` | label, работа, команда (моно, 2 строки) | **Deny** / **Allow** | Session |
| Разрешение, `gist.tool` | `doc.text` (Edit/Write), `wrench.and.screwdriver` (прочее) | label, работа, «Edit · src/app.ts» | **Deny** / **Allow** | Session |
| Разрешение, `gist.fetch` | `globe` | label, работа, хост URL | **Deny** / **Allow** | Session |
| Вопрос | `questionmark.bubble` | label, работа, первая строка вопроса | **Answer ›** | Session |
| План | `list.bullet.clipboard` | label, работа, «Plan ready for review» | **Review ›** | Session |
| «Нужен ты» без карточки (Codex, `blocked` без события) | `hand.raised` | label, работа, `needReason` | — | Session («Answer at your Mac») |
| Лимит / вход | `hourglass` / `person.badge.key` | label, работа, `needReason` (с временем сброса) | — | Session |
| Решение комнаты | `checkmark.seal` | комната, работа, первая строка решения | **Review ›** | Decision |
| Письмо человеку | `envelope` | «Greta → you», работа, первая строка | — | Letter |

- «Always» в Inbox нет никогда: только на экране сессии, где видно всё правило (§11.2 п. 4).
- Allow в строке — для быстрых разрешений; полный вход карточки и последний ответ модели — на Session.
- Свайп строки влево — нет (случайный свайп в списке решений опасен).
- Контекстное меню (долгое нажатие): Open session, Open work, Copy command (только `run`).

### 7.2 Состояния Inbox

| Состояние | Что видно |
|---|---|
| Загрузка (холодный старт) | скелет 3 карточек + плашка «Connecting…» |
| Пусто | `checkmark.circle` «All clear», «Nothing needs you on Evgeniy's MacBook Pro.» |
| Пусто, но есть другие хосты с push | то же + строка «Other Macs may need you — switch in the menu above» (этап A: подключён один хост, §11.4) |
| Список | строки 7.1, сначала новые |
| Отправка решения | нажатая кнопка — спиннер, вторая выключена, у строки `opacity 0.6` |
| `applied: true` | haptic, строка уходит (сворачивание по высоте 250 мс + fade) |
| `applied: false` | в строке «Already answered at your Mac» на 2 с, затем уходит |
| Ответили на Маке (карточки нет в новом снимке) | «Answered at your Mac» на 2 с, затем уходит (§10.3) |
| `connection_lost` / `lost` | после переподключения: «This request is no longer pending» и уход, **или** строка снова с подписью «We couldn't confirm your answer» |
| Переподключение / офлайн | прошлый список, плашка, кнопки выключены, подпись «Reconnecting — actions are paused» |
| Ошибка чтения карточки одной сессии | строка с «Couldn't load the request · Open» вместо описания |

---

## 8. Works и Work (A15, §11.2 п. 3)

Редизайн по замечаниям человека к прототипу (2026-10-31): Works делится по проектам, а экран работы — по
связям сессий, как сайдбар окна (спека окна `2026-09-29-desktop-rooms-organic-design.md` §1.2, §2.7). Общего
потока всех сессий нет: это сотни строк, а поток того, что ждёт человека, уже есть — Inbox. Поля для группировки
есть в проекции V1 (раздел 2): `projectPath` у работы, `parent` у сессии, `members` и `lead` у комнаты.

### 8.1 Works — проекты и работы

Секции — проекты, как заголовки проектов в сайдбаре: цветная точка проекта, имя, число работ. Внутри — работы.
Порядок секций и работ — по самому срочному внутри (ранг внимания §2.7 окна: «нужен ты» 4, `unseen` 3, `working`
2, `idle` 1, законченные 0), при равенстве — проекты по имени, работы в порядке сайдбара.

```
│ Works                         │
│ ● codex-bridge  1             │  ← заголовок проекта: точка цвета проекта, имя, число работ
│ ┌───────────────────────────┐ │
│ │ ● Codex bridge        2 › │ │  ← точка = внимание работы, капсула = сколько ждут тебя
│ │   3 sessions · idle       │ │
│ ├───────────────────────────┤ │
│ │   Done (2)              › │ │  ← работы status: done свёрнуты внутри проекта
│ └───────────────────────────┘ │
│ ● parley  2                   │
│ ┌───────────────────────────┐ │
│ │ ● Improvements   ✉1  5  › │ │
│ │   9 sessions · 2 rooms ·  │ │
│ │   2 working               │ │
│ ├───────────────────────────┤ │
│ │ ● Rooms organic         › │ │
│ │   2 sessions · 1 room ·   │ │
│ │   idle                    │ │
│ ├───────────────────────────┤ │
│ │   Done (3)              › │ │
│ └───────────────────────────┘ │
```

- Вторая строка собирается из проекции: число незакрытых сессий, число комнат (если есть), число `working` или
  «idle».
- Капсула справа — сколько в работе ждут человека: сессии `needs-you` плюс комнаты с решением (капсула
  `systemOrange`). Рядом `envelope` с числом непрочитанных писем человеку.
- Работы `done` — строка «Done (N)» в конце своего проекта; `archived` в этапе A не показываются.
- Имя проекта — последняя часть `projectPath`. Цвет проекта выводится из пути, как в окне
  (`desktop/src/renderer/lib/project-color.ts`: FNV-1a от `projectPath` по трём ступеням палитры): один проект —
  один цвет на Маке и на телефоне, нового поля не нужно.
- Секции проектов не сворачиваются: проектов обычно мало, а свёрнутая секция прячет ждущее.
- Пусто: `square.stack.3d.up` «No works yet», «Create a work on your Mac.»

### 8.2 Work — комнаты и дерево сессий

Один сгруппированный список, как карточка работы в сайдбаре:
- **Комната — группа.** Строка комнаты стоит на месте первого по порядку участника, участники идут под ней и
  отдельно не повторяются. Комнаты без живых участников — в конце.
- **Остальные сессии — деревом по `parent`** (`treeOrder` окна): дети сразу под родителем, с отступом 20 pt на
  уровень, не глубже двух уровней (глубже — на втором). Сессия, чей родитель в комнате, — корень своего дерева.
- **Порядок групп** — по самому срочному внутри группы (ранг выше), при равенстве — порядок сайдбара. Поэтому
  отдельной секции «Needs you» нет: группа с ждущей сессией или решением сама поднимается наверх.

```
│ ‹ Works                       │
│ Improvements                  │
│ ● parley                      │  ← проект под заголовком
│ ┌───────────────────────────┐ │
│ │ ✋ Task1-types           › │ │  ← корень дерева, ждёт тебя
│ │   Waiting for your        │ │
│ │   approval: Edit …        │ │
│ │   executor · sonnet       │ │
│ │   ✓ Task5-check-runner  › │ │  ← дети с отступом
│ │     Done · 1 h ago        │ │
│ │   ✗ Task6-engine        › │ │
│ │     Failed · 2 h ago      │ │
│ │ ○ Greta                 › │ │
│ │   ✋ Push-planner        › │ │
│ ├───────────────────────────┤ │
│ │ ✪ iOS app: stage A (no    │ │  ← строка комнаты, фон tintSoft при решении
│ │   device)               ⌄ │ │
│ │   [Decision] 4 agents ·   │ │
│ │   lead Mobile-stage-A-lead│ │
│ │     p-03 · rev 2 Ship A1… │ │  ← строка решения → Decision
│ │                  Review › │ │
│ │   ● Mobile-stage-A-lead ★›│ │  ← участники, фон surface2, ★ — ведущий
│ │   ✋ Mobile-A1-protocol  › │ │
│ │   ✋ Mobile-D1-designer  › │ │
│ │   ● Critic-A1           › │ │
│ ├───────────────────────────┤ │
│ │ # Browser               › │ │  ← свёрнутая комната: точки состояний участников
│ │   ● ● 2 agents            │ │
│ ├───────────────────────────┤ │
│ │   Closed (31)           › │ │
│ └───────────────────────────┘ │
```

**Строка комнаты.**
- Значок: `checkmark.seal` акцентом, если решение ждёт человека, иначе `#` (`number`, `secondaryLabel`).
- Название — `headline`, до двух строк (не обрезается одной строкой: имена комнат длинные).
- Вторая строка: капсула **Decision** или `3 new` (непрочитанное комнаты), затем `4 agents · lead <label>`;
  у свёрнутой — точки состояний участников вместо имени ведущего.
- Шеврон справа поворачивается: `chevron.right` — свёрнута, вниз — развёрнута (поворот 150 мс, без него при Reduce
  Motion). Тап по строке комнаты — свернуть или развернуть, haptic `selection`.
- **По умолчанию развёрнута**, если в комнате ждёт решение или кто-то из участников ждёт человека; иначе свёрнута.
  Ручной выбор держится до перезапуска приложения.
- **Строка решения** под шапкой — `p-03 · rev 2` и первая строка текста, справа **Review ›** → Decision. Она видна
  и у свёрнутой комнаты: решение не должно прятаться.
- Участники — строки сессий с отступом одного уровня на фоне `surface2`; у ведущего (`lead`, при `null` — первый
  из `members`) `★` акцентом.
- Ленты комнаты в этапе A нет: участники открывают свои экраны Session, сама комната — только группа (В4).

**Строка «чем занят»** — без текстов задач и итогов, их в проекции нет:

| Внимание | Точка | Строка |
|---|---|---|
| `needs-you` | `systemOrange` + `hand.raised` | `needReason` (`Waiting for your approval: <detail>`, `Asked you a question in its terminal`, лимит) |
| `working` | акцент, пульс 1,6 с (без пульса при Reduce Motion) | `Working` · `2 subagents` · `Waiting for s-12` (`waitingFor`) |
| `unseen` | акцент, кольцо | `Finished a turn · 3 min ago` (`turnEndedAt`) |
| `idle` | `systemGray` | `Idle · 20 min ago` (`lastEventAt`) |
| `off` / `sleeping` | `systemGray3`, полая | `Sleeping` / `Closed`; при `result`: `Done · 1 h ago` (зелёная галочка `checkmark.circle.fill`) или `Failed · 1 h ago` (`xmark.circle.fill`, `systemRed`) |

- Под строкой мелко: `role · model` (`caption1`, `secondaryLabel`), например «executor · sonnet».
- Закрытые сессии свёрнуты в «Closed (N)» в конце списка (V2 S7 — решение экрана, не транспорта).
- Архивные комнаты не показываются; их бывшие участники — обычные строки дерева.
- При Dynamic Type `accessibility1+` отступ дерева — 12 pt на уровень, чтобы текст не сжимался.
- VoiceOver: строка комнаты — «Room iOS app: stage A, decision waiting, 4 agents, lead Mobile-stage-A-lead»,
  `accessibilityState.expanded`; участник — «…, room lead» у ведущего. Уровень дерева читается как «child of
  Task1-types» (`accessibilityHint`).
- Пусто: «No sessions in this work», «Start a session on your Mac.»

### 8.3 Состояния Works и Work

Загрузка (скелет) · пусто · список · переподключение / офлайн (прошлый снимок + плашка) · новая эпоха (снимок
целиком заменяется без анимации строк, чтобы не «прыгало» 300 строк) · работа исчезла из снимка, пока открыт
Work → «This work is no longer on your Mac» и возврат к Works.

Состояния группировки на экране Work:
- комната развёрнута / свёрнута (по умолчанию — по правилу 8.2, затем ручной выбор);
- решение комнаты принято или возвращено (здесь или на Маке) — строка решения уходит, фон шапки гаснет, комната
  опускается по рангу при следующем снимке; если человек её не трогал, она сворачивается;
- участник вышел из комнаты или комнату архивировали — его строка возвращается в дерево по `parent`;
- новая сессия в снимке — встаёт на место по порядку без анимации сдвига всего списка (fade 150 мс самой строки).

---

## 9. Session (A15, §11.2 п. 4, §10.3, §11.4)

```
│ ‹ Улучшайзинг            ⋯    │
│ Mobile-D1-designer            │  ← крупный заголовок = label
│ designer · opus · 42 min      │  ← role · model · время с startedAt
│ ┌───────────────────────────┐ │
│ │ [hand.raised] Needs you   │ │  ← статус-капсула
│ │ Waiting for your approval │ │
│ └───────────────────────────┘ │
│ PERMISSION                    │
│ ┌───────────────────────────┐ │
│ │ [terminal] Run a command  │ │
│ │ ┌───────────────────────┐ │ │
│ │ │ pnpm lint && pnpm -r  │ │ │  ← весь вход, моно, прокрутка по горизонтали
│ │ │ build                 │ │ │
│ │ └───────────────────────┘ │ │
│ │ in packages/mobile        │ │
│ └───────────────────────────┘ │
│ LAST REPLY                    │
│ ┌───────────────────────────┐ │
│ │ I'll run the linter to …  │ │  ← Markdown, 6 строк, «Show more»
│ └───────────────────────────┘ │
├───────────────────────────────┤
│ [Allow and don't ask again]   │  ← только если CLI предложил (suggestions)
│ [  Deny  ]   [   Allow    ]   │  ← нижняя панель, стекло
└───────────────────────────────┘
```

### 9.1 Карточки

- **Разрешение.** Иконка и заголовок по `card-gist`: `Run a command` / `Edit a file` / `Fetch a page` / `Use <tool>`.
  Вход карточки целиком (моно, `footnote`, горизонтальная прокрутка у длинных строк). Кнопки: **Deny**
  (`bordered`), **Allow** (`borderedProminent`), над ними — **Allow and don't ask again** (`bordered`, во всю
  ширину) **только** при непустом `permission_suggestions` (приёмка A15, кейс); под ней мелко «Adds the rule:
  Bash(pnpm lint:*)». Перед «Always» нет алерта: правило видно на кнопке.
- **Вопрос.** Для каждого вопроса — `header` (капсула), текст, варианты как строки сгруппированного списка с
  описанием второй строкой. Один выбор — галочка `checkmark`; `multiSelect` — `checkmark.circle.fill` /
  `circle`. Поле «Other» — свой ответ (≤ предела `FEED_DECISION_ANSWER_LIMIT`). Кнопка **Send answer** внизу
  активна, когда на каждый вопрос есть ответ.
- **План.** Текст плана — Markdown во всю ширину, прокрутка. Внизу две кнопки, слова как в окне: **Approve,
  auto-accept edits** (`borderedProminent`) и **Approve, approve each edit** (`bordered`). Вариант «отклонить»
  в CLI — ответ в терминале: ниже ссылка-подпись «To keep planning, answer at your Mac».
- **Нет карточки при `blocked`** (Codex, экран без события) → карточка
  `[desktopcomputer] Answer at your Mac` с `needReason` и строкой «This request can only be answered in the
  terminal on your Mac.»
- **Лимит / вход** — информационная карточка: `hourglass` «Usage limit · resets at 14:30» или `person.badge.key`
  «Signed out of Claude» и «Answer at your Mac». Действий нет.

### 9.2 Статус-капсула

| Внимание | Капсула | Вторая строка |
|---|---|---|
| `needs-you` | `hand.raised.fill` **Needs you** (оранжевый) | `needReason` |
| `working` | `ellipsis` анимированный **Working** (акцент) | `2 subagents` / `Waiting for s-12` |
| `unseen` / `idle` | `pause.circle` **Idle** | `Finished a turn · 3 min ago` |
| `sleeping` | `moon.zzz` **Sleeping** | `Last active 1 h ago` |
| `closed` + `done` | `checkmark.circle.fill` **Done** (зелёный) | `resultAt` |
| `closed` + `failed` | `xmark.circle.fill` **Failed** (красный) | `resultAt` |

### 9.3 Последний ответ модели

Markdown без HTML; удалённые картинки не грузятся — на их месте строка `photo` «Image not loaded · example.com»;
ссылки — подчёркнутые, тап → алерт «Open example.com in Safari?» [Cancel] [Open] (§11.1). Блоки кода — моно с
горизонтальной прокруткой. Первые 6 строк, затем **Show more** (раскрывает на месте).

### 9.4 Состояния Session

| Состояние | Что видно |
|---|---|
| Загрузка | шапка из проекции сразу, карточки — скелет |
| Нет ждущих карточек | статус-капсула + Last reply; нижней панели нет |
| Ждёт ответа (разрешение / вопрос / план) | карточка + нижняя панель действий |
| Без карточки при `blocked` | «Answer at your Mac» |
| Отправка | нажатая кнопка — спиннер, остальные выключены |
| `applied: true` | haptic, карточка сворачивается, капсула меняется на **Working** при следующем перечитывании |
| `applied: false` | «Already answered at your Mac» (капсула-тост 2 с), карточка уходит |
| Ответили на Маке (перечитывание 3 с) | «Answered at your Mac» на 2 с, карточка уходит (§10.3) |
| Новая карточка во время показа | появляется сверху со сдвигом 12 pt + fade; haptic `selection` |
| `connection_lost` → `lost` | после переподключения: «This request is no longer pending» **или** карточка снова с подписью «We couldn't confirm your answer» |
| Переподключение / офлайн | прошлое состояние, плашка, кнопки выключены с подписью «Reconnecting — actions are paused» |
| Ошибка `feed.snapshot` | шапка из проекции; вместо карточек — «Couldn't load the session», **Try again** |
| Сессия исчезла из снимка | «This session is no longer on your Mac» |

---

## 10. Decision и Letters (A16, §11.2 пп. 5–6)

### 10.1 Decision

```
│ ‹ Inbox                       │
│ Decision                      │
│ iOS app: stage A · Улучшайзинг│
│ p-03 · rev 2 · from s-174     │  ← caption, secondary
│ ┌───────────────────────────┐ │
│ │ ## Ship A1                │ │
│ │ Markdown текста решения … │ │  ← прокрутка, весь текст
│ └───────────────────────────┘ │
├───────────────────────────────┤
│ [ Return for rework ] [Accept]│
└───────────────────────────────┘
```

- Заголовок — **Decision** или **Completion** (по `proposal.kind`; у старых решений без `kind` — Decision).
- Длинный текст (> предела проекции) дочитывается через `context.text`, пока — скелет абзацев.
- **Accept** — `borderedProminent`; **Return for rework** — `bordered`, открывает sheet:

```
  Return for rework                     Cancel
  ┌─────────────────────────────────┐
  │ What should the lead change?    │  ← многострочное поле, автофокус
  │                                 │
  └─────────────────────────────────┘
                              0 / 4000
  [ Send ]   (borderedProminent; выключена при пустом поле и > 4000)
```

- Оба действия уходят с `rev` показанной ревизии (приёмка A16, кейс).
- Haptic: Accept → `notification(success)`, Return → `notification(warning)` после ответа хоста.

| Состояние | Что видно |
|---|---|
| Загрузка | шапка, скелет текста |
| Ждёт ответа | текст + две кнопки |
| Отправка | спиннер в нажатой кнопке, вторая выключена; sheet закрывается только по итогу |
| `applied` | haptic, экран: `checkmark.seal.fill` «Accepted» / `arrow.uturn.backward.circle` «Returned for rework», через 1 с — назад |
| **`conflict`** | баннер сверху `exclamationmark.arrow.triangle.2.circlepath` «The lead changed the decision — review the new text», новый текст, ревизия «rev 3» подсвечена; прежнее нажатие **не применяется**, кнопки снова доступны; заметка Return, если была, сохраняется в sheet. Вызов не повторяется сам |
| Решения больше нет (ответили на Маке) | «This decision was answered at your Mac», кнопок нет |
| `lost` | после переподключения — перечитывание снимка: «This decision is no longer pending» **или** экран снова с подписью «We couldn't confirm your answer» |
| Переподключение / офлайн | текст, плашка, кнопки выключены |
| Ошибка `context.text` | «Couldn't load the full text», **Try again**; кнопки выключены, пока текст не полон |

### 10.2 Letters и Letter

Letters — прямые письма человеку, только чтение (ответ — этап B). Вход: кнопка `envelope` в панели навигации
Inbox (с числом непрочитанных) и строки писем в Inbox.

```
│ ‹ Inbox                       │
│ Letters                       │
│ ┌───────────────────────────┐ │
│ │ • Greta            10:42  │ │  ← точка = не прочитано на Маке
│ │   Улучшайзинг             │ │
│ │   PR #143 is ready for…   │ │
│ ├───────────────────────────┤ │
│ │   s-174            Yesterday│
│ │   Улучшайзинг             │ │
│ │   S7 draft is committed…  │ │
│ └───────────────────────────┘ │
```

- Letter: от кого → you, работа, время; тело — Markdown (те же правила, что 9.3); внизу подпись «Reply at your Mac
  — replies from the phone come later.»
- В этапе A телефон не отмечает письма прочитанными (`mail.markRead` — этап B): письмо остаётся в счётчике, пока
  его не прочтут на Маке. Внутри приложения письмо, открытое на телефоне, получает отметку «Opened on this
  phone» и уходит в Inbox вниз. См. В3.

| Экран | Состояния |
|---|---|
| Letters | загрузка · пусто («No letters», `envelope.open`) · список · следующая страница (`context.messages`, спиннер внизу) · ошибка страницы · офлайн |
| Letter | загрузка · текст · ошибка `context.letter` · письмо удалено |

---

## 11. Settings (A14, §11.2 п. 7)

```
│ Settings                      │
│ MACS                          │
│ ┌───────────────────────────┐ │
│ │ [desktopcomputer]         │ │
│ │ Evgeniy's MacBook Pro   ✓ │ │  ← текущий
│ │ Connected · 48 ms       › │ │
│ ├───────────────────────────┤ │
│ │ [desktopcomputer]         │ │
│ │ Studio Mac              › │ │
│ │ Not connected             │ │
│ ├───────────────────────────┤ │
│ │ [plus] Pair another Mac   │ │
│ └───────────────────────────┘ │
│ NOTIFICATIONS                 │
│ ┌───────────────────────────┐ │
│ │ Notifications       [on]  │ │
│ └───────────────────────────┘ │
│  Notifications arrive only while your Mac is awake
│  and Parley is running.
│ ABOUT                         │
│ │ Version         1.0.0 (12) │
│ │ Diagnostics              › │
```

### 11.1 Хосты

- Тап по строке хоста — сделать текущим (галочка, haptic `selection`) и переподключиться; шеврон / долгое
  нажатие → экран Host.
- **Host:** имя (локальное, для себя) → **Rename** (sheet), «Paired Oct 30», relay, **Remove from this phone**
  (красная, внизу). Подпись под ней: «This removes the keys on this phone. Your Mac still lists the phone until
  you revoke it there: Settings → Remote access → Devices.»
- **Remove** — алерт `destructive`: «Remove Evgeniy's MacBook Pro?» [Cancel] [Remove]. После — haptic
  `notification(warning)`; если хост был последним — Welcome.

### 11.2 Уведомления

| Состояние | Строка |
|---|---|
| Включены | переключатель `on` |
| Выключены в приложении | переключатель `off` (push продолжают приходить от моста, но приложение просит iOS их не показывать — см. В5) |
| Запрещены в iOS | «Turned off in iOS Settings» + **Open Settings** |
| Сборка без push (нет токена) | «Notifications unavailable on this build» (серым, без переключателя), остальное работает |

### 11.3 Diagnostics

Список «ключ — значение», моно для значений, долгое нажатие — Copy: Relay (адрес), State (`ready` / …), RTT (по
последнему `ping`), Last connected, Host (`online` / …), Epoch, Bridge version, Host version, Stage (A), Device ID
(первые 8 знаков). Кнопка **Reconnect**.

### 11.4 Removed from this Mac — отозван или сброс

Только по `session.closing {reason:'revoked' | 'reset'}` внутри Noise. Экран на месте контента вкладки, вкладки
видны (можно перейти к другому хосту в Settings):

```
  [desktopcomputer.trianglebadge.exclamationmark]
  Removed from Evgeniy's MacBook Pro
  This Mac no longer allows this phone.
  [ Pair again ]     (borderedProminent)
  [ Remove ]         (plain, destructive)
```

Haptic `notification(error)` один раз при появлении.

### 11.5 Update required

- **Телефон старше** (`minClient` > версии): `arrow.down.app` «Update Parley on your phone», «Your Mac needs
  version 1.2 or later.», кнопка **Open App Store** (в Personal Team-сборке — без кнопки, «Install the new build
  from Xcode»).
- **Мак старше** (`host:'incompatible'` или `protocol` клиента больше): `desktopcomputer` «Update Parley on your
  Mac», «This phone needs a newer Parley on your Mac.»
- Оба — `blocked`: прошлого снимка не показываем, решения невозможны.

---

## 12. Push (A16, §9)

- Текст — от моста: «Parley — 3 waiting». Приложение текст не меняет (Notification Service Extension — вне
  объёма).
- Тап: хост по `data.route` → он становится текущим → подключение → Inbox. Неизвестный `route` → Settings, секция
  Macs, тост «This notification is from a Mac that isn't paired anymore».
- При открытии приложения уведомления этого хоста снимаются; бейдж иконки — `needsYouCount` текущего хоста.
- Пока приложение на переднем плане, push не показывается баннером (`shouldShowAlert: false`); Inbox и так
  обновится. Бейдж вкладки — да.

---

## 13. Прототип

`packages/mobile/prototype/index.html` — один файл, инлайн CSS и JS, без сборки и без сети. Открывается напрямую
или через `python3 -m http.server` из корня рабочего дерева.

- Рамка iPhone 393×852 pt, остров, индикатор Home.
- Панель справа: тема (Light / Dark / System), состояние подключения (все строки раздела 4), сценарий данных
  (обычный / пусто / загрузка / ошибка), размер шрифта (Default / XL — проверка Dynamic Type), Reduce Motion,
  кнопки «Simulate: answered at Mac», «Simulate: conflict», «Simulate: lost», переход к любому экрану.
- Кликабельно: паринг от Welcome до Inbox, вкладки, Inbox → Session / Decision / Letter, Works → Work → Session,
  Settings → Host / Diagnostics, решения с итогами, sheet Return for rework, алерт Remove.
- Haptics в прототипе показаны тостом-индикатором «haptic: success» в углу рамки — чтобы ревьюер видел, где они.
- Иконки SF Symbols в браузере недоступны: прототип рисует простые SVG-заменители, имя символа — в `title`.
  Настоящие символы — по таблице раздела 15.

---

## 14. Открытые вопросы к человеку

- **В1. Название комнаты в проекции** — закрыт: `title` есть в проекции V1 (S7 после подтверждения).
- **В2. Строка «чем занят» без текстов.** В проекции нет `summary`, поэтому строка сессии строится из активности
  («Working · 2 subagents», «Idle · 20 min ago»). Нужен ли телефону короткий итог сессии — например первая строка
  `summary` до 120 знаков? Это +~10 КБ сырыми на 350 сессий. По умолчанию — нет, хватает активности.
- **В3. Письма и счётчик в этапе A.** Телефон не умеет `mail.markRead` (этап B), поэтому прочитанное на телефоне
  письмо остаётся в бейдже и push-счётчике, пока его не прочтут на Маке. Варианты: (а) так и оставить, письмо
  уходит в Inbox вниз с отметкой «Opened on this phone» — по умолчанию; (б) перенести `mail.markRead` в этап A.
- **В4. Комната без решения.** В этапе A у телефона нет ленты комнаты: тап по такой комнате ничего не открывает.
  Достаточно ли этого, или нужен экран комнаты только для чтения (`context.messages` по комнате)?
- **В5. Переключатель уведомлений.** Выключить push можно двумя способами: (а) телефон шлёт
  `push.register {apnsToken: null}` и мост перестаёт слать — честно и экономно, по умолчанию; (б) только скрывать
  на телефоне. (а) требует, чтобы `push.register` с `null` значил «не слать», — так и в A16.
- **В6. Порядок и отбор работ.** Работы `done` свёрнуты, `archived` не показываются, закрытые сессии свёрнуты
  (V2 S7 на уровне экрана). Нужен ли фильтр V3 «только работы с активностью за 7 дней»? Для него у работы нужно
  время последней активности (`updatedAt`) — в проекции V1 его нет.
- **В7. Allow прямо в Inbox.** Макет даёт Allow / Deny разрешения прямо в строке Inbox (без «Always»). Это
  быстро, но человек видит только краткое описание (команду в 2 строки). Альтернатива — только переход на Session.
  По умолчанию — в строке, команда целиком по тапу.
- **В8. Акцент.** Терракотовый акцент Parley (`#C67139`) на белом даёт 3,6:1 — мало для текста. Макеты берут
  затемнённый `#A8531E` (5,4:1) в светлой теме и `#E08A52` в тёмной. Подходит ли, или акцентом iOS-приложения
  оставить системный синий?
- **В9. Биометрия.** Решение 6 (§16) — по умолчанию выключена в этапе A; макеты без Face ID. Если включить —
  перед Allow / Accept системный запрос Face ID, кнопка показывает `faceid`.

---

## 15. Таблица иконок (SF Symbols)

| Где | Символ | Вес / режим |
|---|---|---|
| Вкладка Inbox | `tray.fill` | системный, бейдж |
| Вкладка Works | `square.stack.3d.up.fill` | системный |
| Вкладка Settings | `gearshape.fill` | системный |
| Letters (панель навигации) | `envelope` | regular |
| Меню хоста | `desktopcomputer`, `chevron.down` | regular / small |
| Разрешение: команда | `terminal` | regular, hierarchical |
| Разрешение: файл | `doc.text` | regular |
| Разрешение: инструмент | `wrench.and.screwdriver` | regular |
| Разрешение: сеть | `globe` | regular |
| Вопрос | `questionmark.bubble` | regular |
| План | `list.bullet.clipboard` | regular |
| Нужен ты | `hand.raised.fill` | палитра: оранжевый |
| Лимит | `hourglass` | regular |
| Вход слетел | `person.badge.key` | regular |
| Answer at your Mac | `desktopcomputer` | hierarchical |
| Решение комнаты | `checkmark.seal` / принято `checkmark.seal.fill` | regular |
| Возвращено | `arrow.uturn.backward.circle` | regular |
| Conflict | `exclamationmark.arrow.triangle.2.circlepath` | палитра: оранжевый |
| Письмо | `envelope` / прочитано `envelope.open` | regular |
| Пусто Inbox | `checkmark.circle` | ultraLight, 48 pt |
| Пусто Works | `square.stack.3d.up` | ultraLight, 48 pt |
| Done / Failed | `checkmark.circle.fill` / `xmark.circle.fill` | multicolor |
| Sleeping | `moon.zzz` | regular |
| Idle | `pause.circle` | regular |
| Сканер | `qrcode.viewfinder` | regular |
| Фонарик | `flashlight.off.fill` / `flashlight.on.fill` | regular |
| Камера запрещена | `video.slash` | regular |
| Код использован | `qrcode` + перечёркивание (`xmark.circle` бейджем) | — |
| Ссылка из камеры | `exclamationmark.shield` | hierarchical |
| Paired | `checkmark.circle.fill` | multicolor, `symbolEffect(.drawOn)` на iOS 26, иначе `.bounce` |
| Отказ / таймаут | `xmark.octagon` / `clock.badge.exclamationmark` | regular |
| Уведомления | `bell.badge` | multicolor |
| Updating | `arrow.triangle.2.circlepath` | `symbolEffect(.rotate)` |
| Нет сети | `wifi.slash` | regular |
| Relay недоступен | `antenna.radiowaves.left.and.right.slash` | regular |
| Мак не в сети | `desktopcomputer` + `zzz` (композиция) | — |
| Не узнаёт телефон | `questionmark.circle` | regular |
| Удалён с Мака | `desktopcomputer.trianglebadge.exclamationmark` | hierarchical |
| Update | `arrow.down.app` | regular |
| Pair another Mac | `plus.circle.fill` | multicolor |
| Картинка не загружена | `photo` | regular |

---

## 16. Haptics (`expo-haptics`)

| Событие | Haptic | Почему |
|---|---|---|
| QR распознан | `impactAsync(Light)` | подтверждение без взгляда |
| Появился код SAS | `impactAsync(Medium)` | пора смотреть на экран |
| Paired | `notificationAsync(Success)` | итог потока |
| Allow / Accept / Approve / Send answer → `applied: true` | `notificationAsync(Success)` | §11.3 |
| Deny / Return for rework → `applied: true` | `notificationAsync(Warning)` | §11.3: отказ ощущается иначе, чем согласие |
| `applied: false` (уже ответили), `conflict`, `lost` | `notificationAsync(Warning)` | действие не применилось |
| Removed from this Mac, Update required | `notificationAsync(Error)` один раз | блокирующее состояние |
| Выбор хоста, выбор варианта ответа | `selectionAsync()` | системный паттерн выбора |
| Новая карточка на открытом экране сессии | `selectionAsync()` | лёгкое «появилось» |
| Remove хоста подтверждён | `notificationAsync(Warning)` | разрушительное действие |
| Нажатие кнопки решения (до ответа) | нет | haptic — на итог, не на нажатие, иначе ложное «принято» |
| Pull-to-refresh | системный (`refreshControl`) | не дублируем |

Haptics только на переднем плане и при включённой системной настройке (expo-haptics её уважает).

---

## 17. Токены

### 17.1 Цвета

Основа — системные семантические цвета iOS (`PlatformColor` в RN), они сами меняются со светлой темой на тёмную и
с режимом повышенного контраста. Свои — только акцент и состояния.

| Токен | Светлая | Тёмная | Источник / замечание |
|---|---|---|---|
| `bg` | `#F2F2F7` | `#000000` | `systemGroupedBackground` |
| `surface` (карточка, ячейка) | `#FFFFFF` | `#1C1C1E` | `secondarySystemGroupedBackground` |
| `surface2` (вложенный блок: команда, код) | `#F2F2F7` | `#2C2C2E` | `tertiarySystemGroupedBackground` |
| `label` | `#000000` | `#FFFFFF` | `label` |
| `label2` | `#3C3C43` 60 % | `#EBEBF5` 60 % | `secondaryLabel` |
| `label3` | `#3C3C43` 30 % | `#EBEBF5` 30 % | `tertiaryLabel` |
| `separator` | `#3C3C43` 29 % | `#545458` 60 % | `separator` |
| `tint` (акцент) | `#A8531E` (5,4:1 на белом) | `#E08A52` (6,4:1 на `surface`) | терракота Parley, затемнённая для текста (В8) |
| `onTint` (текст на заливке акцента) | `#FFFFFF` | `#000000` | на тёмной — чёрный, 7,9:1 |
| `needsYou` | `#C93400` (текст) / `#FF9500` (точка) | `#FF9F0A` | `systemOrange`; текстом — тёмный вариант 5,3:1 |
| `working` | = `tint` | = `tint` | работа — «свой» цвет Parley |
| `idle` | `#8E8E93` | `#98989D` | `systemGray` |
| `off` | `#C7C7CC` | `#48484A` | `systemGray3` |
| `success` | `#248A3D` | `#30D158` | `systemGreen` (тёмный вариант для текста в светлой) |
| `danger` | `#D70015` | `#FF453A` | `systemRed` (повышенный контраст в светлой) |
| `warningBg` (плашка) | `#FFF4E5` | `#3A2A12` | плашка предупреждения, текст `label` |
| `neutralBg` (плашка) | `#E5E5EA` | `#2C2C2E` | `systemGray5` |

### 17.2 Типографика

SF Pro через системный шрифт, только стили Dynamic Type (никаких фиксированных размеров), `allowFontScaling` везде.

| Роль | Стиль Dynamic Type | Размер / интерлиньяж (Large, по умолчанию) |
|---|---|---|
| Заголовок экрана | `largeTitle` bold | 34 / 41 |
| Код SAS | SF Mono, `largeTitle` × 1,4, `monospacedDigit` | 48 / 56 |
| Заголовок пустого состояния | `title3` semibold | 20 / 25 |
| Имя сессии в строке, заголовок карточки | `headline` | 17 / 22 |
| Основной текст, Markdown | `body` | 17 / 22 |
| Кнопки | `body` semibold | 17 / 22 |
| Вторая строка (работа, причина) | `subheadline` | 15 / 20 |
| Команда, код | SF Mono `footnote` | 13 / 18 |
| Подписи секций, сноски | `footnote` | 13 / 18 |
| `role · model`, время | `caption1` | 12 / 16 |
| Бейдж | `caption2` semibold | 11 / 13 |

### 17.3 Отступы и формы

| Токен | Значение |
|---|---|
| Сетка | 4 pt |
| Поля экрана | 16 pt (системные `layoutMargins`; 20 pt на Pro Max) |
| Внутренний отступ карточки | 16 pt по горизонтали, 14 pt по вертикали |
| Между карточками | 12 pt |
| Между строками внутри карточки | 4 pt; между блоками — 12 pt |
| Скругление карточки | 16 pt, `continuous` (на iOS 26 — системное скругление ячеек) |
| Скругление вложенного блока | 10 pt |
| Высота кнопки решения | 50 pt (`controlSize: .large`), минимальная цель касания 44×44 |
| Нижняя панель действий | 16 pt поля, 12 pt между кнопками, над безопасной зоной |
| Точка состояния | 10 pt; кольцо `unseen` — 2 pt |
| Анимации | пружина `damping 20, stiffness 220`; уход карточки 250 мс; тост 2 с; при Reduce Motion — fade 150 мс без сдвигов и пульса |

---

## 18. Dynamic Type и VoiceOver

**Dynamic Type.**
- Все тексты — стили раздела 17.2, проверка до `AX5` (accessibility sizes).
- Начиная с `accessibility1`: строки списка переходят в вертикальную раскладку (бейдж и `role · model` под
  текстом, а не справа); кнопки Deny / Allow встают друг под другом во всю ширину (Allow сверху).
- Команды и код не переносятся по словам, прокручиваются по горизонтали; размер — как `footnote` с масштабом.
- Код SAS при `AX3+` переносится на две строки «123» / «456», не уменьшается.
- Нижняя панель действий не закрывает контент: контент получает нижний отступ по её реальной высоте.

**VoiceOver.**
- Строка Inbox — один элемент: «Permission. Mobile-D1-designer, Улучшайзинг. Run a command: pnpm lint. 2 minutes
  ago.» Кнопки Allow / Deny — отдельные элементы и `accessibilityActions` строки («Allow», «Deny»), чтобы ответить
  без поиска кнопки.
- Точка состояния не читается отдельно: состояние входит в метку строки («Needs you», «Working»).
- Плашка подключения — `accessibilityLiveRegion` / `announceForAccessibility` при смене (не чаще раза в 5 с),
  кнопки плашки — отдельные элементы.
- Код SAS — по цифрам; таймер — `accessibilityLabel` «1 minute 54 seconds left», обновление не объявляется.
- Итоги решений («Allowed», «Already answered at your Mac») объявляются `announceForAccessibility`.
- Выключенные кнопки — `accessibilityState.disabled` и подсказка «Reconnecting — actions are paused».
- Заголовки секций — `accessibilityRole="header"`, чтобы ротор «Заголовки» работал.
- Увеличенный контраст (`Increase Contrast`): системные цвета подстраиваются сами; у `tint` — вариант `#8C4519` /
  `#F09A62`.

---

## 19. Что берут экранные задачи

| Задача | Разделы |
|---|---|
| A13 | 1, 3 (вкладки, стек), 4 (компонент плашки), 17 (токены темы), 18 |
| A14 | 4, 6, 11 |
| A15 | 7, 8, 9, 16 |
| A16 | 10, 11.2, 12 |
