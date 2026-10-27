# Остров Parley: выбранные возможности для агентов

Дата: 2026-10-26; обновлено 2026-10-27. Этап 2 — проектирование — завершён и принят по p-19 rev0. Реализация разрешена решениями человека, переданными владельцем s-21 в m-935/936 и ведущим s-25 в r-04 m-939. D1–D4 приняты как рекомендованы, D5=B с явным принятием остаточного риска, D6 заменён точной базой origin/master d8d541a21f937b77162fca0f1db03d10d5837584. Архитектура: s-25, запись двух документов: s-27, критика: s-26, аналитика: s-23; интегратор реализации: s-31. Основание контрактов: m-737–739, m-744–746 и последующие принятые уточнения, включая m-785/787 и границу r-05. Отдельного кэша/poller нет. Реализация и проверки T7b opt2 приняты на lineage через `90d61a26`; остальные функции сохраняют границы своего плана и приёмки.

**Статус T7b opt2 addendum:** человек выбрал option 2 (решение передано s-25 в m-1262). Source/map расширение с authoritative binding evidence принято, H4 сохраняется; option 1 не выбран. Проверенная и принятая T7b lineage: B1/I1 (`77dd9042`) → P1 (`4b9c91c8`, replay correction `086dcc8d`) → P2a (`96bd76b8`) → P2b (`96086b4f`) → first-start (`90d61a26`). T8 принят на `e0aaeab4`, T9 на `7b672105`; открыты T10/T11.

## 1. Цель и границы

Человек выбрал из B4 отчёта первого этапа №1, 3, 4, 5, 7 и 8. Остров показывает полную активность Codex, позволяет отвечать на вопросы и читать/одобрять план, показывает текущий шаг и краткую историю, активных субагентов под строкой родительской сессии и ожидающие человека предложения комнат с ведущим. Клавиатурные команды ведут к ожидающим запросам. Завершение уже наблюдаемой сессии оставляет тихую отметку.

Вне объёма: №2 (лимиты подписки), №6 (дифф), #9 sounds/motion отдельной r-05, Flow, Notetaker, service pills, мобильный клиент, сторонние терминалы, Accessibility, новый транспорт или установщик хуков референсных приложений. Реализация использует собственные компоненты, подписи, звуки и иконки Parley. Код и ресурсы референсных приложений не копируются; их ресурсы распространяются под отдельными лицензиями.

## 2. Источники и исходное состояние

- Отчёт этапа 1 (исследование рынка, разделы B2–B4; вне репозитория): исследовательский источник выбора возможностей; предложения отчёта сами по себе не являются утверждёнными контрактами.
- [Остров, дизайн 12 октября](2026-10-12-island-design.md) и [его план](2026-10-12-island-plan.md): исходные поведение и ограничения окна. Старое утверждение о полном исключении Codex уже не описывает текущий код.
- `packages/desktop/src/shared/island.ts`, `main/island/`, `preload/island.ts`, `renderer/island/`: действующие мост, окно, модель и очередь. Preload — файл `preload/island.ts`, а не каталог.
- `packages/protocol/src/{feed,methods,events,types}.ts`, `packages/host/src/{activity/activity-service,feed/feed-service,methods/feed}.ts`: действующие данные и маршруты решений.

Первоначальный разбор сделан на `master = fbb7b82844c1ee256f98e33c46254714dff2b077`, с отдельным стеком r-01 до b975adb4. Актуальная принятая база реализации — точный `origin/master = d8d541a21f937b77162fca0f1db03d10d5837584`; результаты повторного аудита ссылок и пересечений приведены ниже и в плане. Рабочее дерево содержит правки человека; s-27 изменяет только данный файл и сопутствующий план, без правок приложения и коммитов. Английские feature-worktree commits разрешены исполнителям реализации; push/PR не разрешены.

Повторный read-only аудит s-23 (m-943/944), проверенный критиком в m-946, выполнен на exact d8d541a2: b975adb4 — его предок, между ними 65 изменённых путей; protocol/, desktop main/island/preload, renderer/island и host feed/activity не менялись. Числовые ссылки `protocol/methods.ts` исправлены по точной базе; это не изменение protocol между b975adb4 и d8d541a2. Остальные 23 числовые ссылки сохраняют процитированную семантику. Новый agent HTTP transport и PR111 требуют сохранения текущего host wiring и проверки browser panel visibility; они не добавляют island RPC. Это аудит исходников, не прогон runtime tests.

| Возможность сейчас | Проверенная опора |
|---|---|
| Отдельная изолированная панель, без фокуса по умолчанию | `main/island/window.ts`: sandbox, contextIsolation, постоянный кадр 480×520, `showInactive`, hit-rect |
| Состояния работы и запросов | `works.list/changed`, `activity.changed`, `activitySnapshot`, `sessionAttention` |
| Ограничение Codex | `ISLAND_ATTENTION_ONLY_PROVIDERS = new Set(['codex'])`; `model.ts` исключает обычную работу и Done |
| Разовые карточки и последний ответ | `feed.snapshot {ref, scope:'attention'}`; это не подписка |
| Ответы человека | `feed.decide {ref,cardId,decision}`; результат `{applied,state}` |
| Только простые вопросы | `simple-question.ts`: один single-select вопрос, до четырёх вариантов |
| Метрики вне вида острова | `LiveMetrics.plan`, `tasks`, `subagents`; отсутствие опционального поля означает неизвестность |
| Consents | Отдельные `consents.list/changed/decide`; доверие папке не является разрешением команды |
| Завершения | `doneKey = refKey(ref) + '\\0' + turnEndedAt`; свежий Done раскрывает остров без звука; Clear → `island:mark-seen` → `activity.seen` |

`feed.changed` и `pty.output` сейчас не входят в `ISLAND_EVENTS`. Подписки feed принадлежат клиенту хоста; main использует один `HostConnection` для основного окна и острова. Самостоятельный `feed.unsubscribe` острова способен затронуть основной Chat: расширение вида требует отдельного ограниченного контракта.

Адресуемые опоры в проверенной базе (это факты существующего кода, а не ссылки на будущую реализацию):

| Факт | Исходник |
|---|---|
| Whitelist и ограничение Codex | `packages/desktop/src/shared/island.ts:102–123`, модельный фильтр `renderer/island/model.ts:75` |
| Attention snapshot и wire решения на d8d541a2 | `packages/protocol/src/methods.ts:300–310,314,480–487,491`; `packages/host/src/feed/feed-service.ts:250–260,1200–1230` |
| Обновление карточки сейчас сохраняет known payload | `packages/desktop/src/renderer/island/requests.ts:111–113`; это исправляется в T1 |
| Сериализация вопроса и UI Other | `packages/desktop/src/renderer/chat/cards/QuestionCard.tsx:19–24,71–73,100–112` |
| План и нынешние choices | `packages/desktop/src/renderer/chat/cards/PlanCard.tsx:39–53`; формат `packages/protocol/src/feed.ts:178–184,286` |
| Метрики плана и детей | `packages/protocol/src/types.ts:87–99,138–166`; сбор `packages/host/src/activity/activity-service.ts:838–862` |
| Источник видимости | `packages/desktop/src/renderer/terminal/TerminalSurface.tsx:179`, `renderer/chat/ChatView.tsx:271`; правило `renderer/attention/seen.ts:15–33` |
| Fresh Done и seen | `packages/desktop/src/renderer/island/IslandApp.tsx:298–318`; tracker `renderer/attention/seen.ts:35–98` |
| Чтение и Codex serialization | `packages/host/src/feed/feed-service.ts:696,777–789,861`; seed/delta `feed/codex-source.ts:11,20–43` |
| Текущий живой ведущий | `packages/core/src/work/rooms.ts:122–126`; browser-safe `packages/desktop/src/renderer/lib/room-lead.ts:17–20` |
| Применение session target | `packages/desktop/src/renderer/App.tsx:135–141`, `renderer/attention/focus-target.ts:64–82`; тип `shared/bridge.ts:54–57` |
| Покрывающая browser panel, требующая уточнения visibility | `packages/desktop/src/renderer/browser/panel/PanelHost.tsx:53,74–85`; текущие producers `renderer/layout/bodies/TerminalBody.tsx:43–49`, `renderer/chat/ChatView.tsx:270–273`, `renderer/layout/SurfaceLayer.tsx:119–136` не исключают covering |
| Panel runtime без измеренной ширины в базе | `packages/desktop/src/renderer/browser/panel/runtime.ts:58–63`, `browser/panel/PanelHost.tsx:38,53,63`; T5 добавляет measured без изменения прежней UI-семантики narrow |

Полные пути для сокращений renderer/shared/feed разрешаются относительно соответствующего package/src в той же строке. При иной базе исполнитель перепроверяет адреса; значения протокола определяют разделы ниже.

## 3. Общие инварианты и состояния

Идентичность сессии — полный `SessionRef {projectPath,workId,sessionId}`, ключ — `refKey`; имя провайдера, label и относительный путь не являются ключами. Идентичность карточки — `refKey + cardId`, содержимое имеет отдельный fingerprint. Предложение комнаты — полный work ref, `roomId`, `proposal.id`, `proposal.rev`. Новая ревизия не наследует взвод кнопок или черновик предыдущей.

Основные состояния: отключённый хост (данные и очередь сняты), свёрнутая панель, список, выбранная карточка, раскрытая деталь сессии, помощник. Карточки feed/consent и ожидающие предложения комнат приоритетнее истории и Done; помощник сохраняет существующий режим. Новый pending раскрывает свёрнутый остров и даёт имеющийся звуковой сигнал по Sound, но не вырывает фокус и набранный текст уже открытого вопроса: обновляются badge и очередь. История не раскрывает панель сама.

Клавиатурой владеет один режим `assistant | request | null` в `IslandApp`, использующий существующий `island.keyboard(on)`. Второй независимый флаг для вопроса запрещён. Blur, Escape, сворачивание, отключение и уничтожение панели освобождают клавиатуру; прежнее приложение снова получает ввод. Существующее `onAssistantBlur` / `island:assistant-blur` переименовывается согласованно в общее `onKeyboardBlur` / `island:keyboard-blur`, с адаптацией помощника.

Все решения доступны после 500 мс непрерывного показа для тройки `showId + cardKey + contentFingerprint`. Смена содержимого, выбранной карточки, повторное раскрытие и переподключение заново взводят защиту. Во время `deciding` повторная отправка запрещена. Начальный фокус — контейнер/заголовок, а не кнопка решения. Навигационные обработчики и Enter в Other не вызывают `decide`; обычная активация явно сфокусированной через Tab кнопки Enter/Space после взвода допустима и эквивалентна click. IME composition не переключает карточку и не отправляет ответ.

Смена fingerprint того же cardId также снимает DOM-фокус с Approve/Submit и переводит его на контейнер, **если request уже владеет клавиатурой**. Автоматически захватывать фокус из другого приложения нельзя. Даже спустя 500 мс Enter не одобряет новый текст до нового явного фокуса кнопки: одного rearm без blur недостаточно.

Состояния отправки общие: `ready → deciding → removed` при `applied:true`; `applied:false,state:'pending'` — видимая ошибка и явный повтор; иной state или `not_found` — `Already answered`, затем снятие карточки; транспортная ошибка — `Try again`, без автоматического решения. Ответы snapshot/decide проверяют connection generation, ключ запроса и актуальное содержимое. Поздний ответ старого подключения не удаляет новую карточку и не возвращает старый черновик.

Выбранная видимая pending карточка перепроверяется attention snapshot при открытии, возврате keyboard и раз в 1000 мс; один in-flight на ref, остановка на collapse/disconnect, generation guard. Так ответ извне замечается даже при неизменном activity, когда у сессии остаётся другое ожидание. При snapshot с тем же cardId, но новым содержимым store заменяет payload, summary и fingerprint, а не возвращает старую card из known map. Ошибка revalidation не отправляет решение и не превращает неизвестность в доступное Allow.

Main для island sender принимает `feed.snapshot` только как строгий `{ref,scope:'attention'}`: ref проходит существующую sessionRef schema; missing/wrong scope, agentId и любые лишние top-level поля отвергаются **до HostConnection.call**. Если старый хост молча игнорирует scope и отдаёт полную ленту, main до renderer оставляет все pending cards и последний text после последнего prompt; если prompt нет — последний text вообще. Нельзя заменить эту границу скрытием лишних данных в DOM. Основной Chat продолжает получать свой прежний snapshot.

## 4. №1 — полная активность Codex

Удалить `ISLAND_ATTENTION_ONLY_PROVIDERS` и модельный фильтр, обновить все импорты, комментарии и тесты, которые закрепляли прежнее исключение. Codex участвует в working, needs-you, Done, счётчиках, группах работ и комнат и превью последнего ответа по тем же правилам, что остальные провайдеры. `requests.ts` сохраняет terminal fallback с актуальным `needReason`: отсутствие карточки или `decisions:'terminal'` не даёт права отвечать через остров.

Данные: существующие works/activity, `sessionAttention`, `feed.snapshot` для Done. Протокол и whitelist не меняются. Consents доверия папке остаются отдельным маршрутом. Нет нового запуска app-server, хуков или распознавания терминала.

Приёмка C1: working Codex даёт ровно одну родительскую строку и входит в счётчик; needs-you без карточки открывает терминал и не вызывает `feed.decide`; завершение создаёт Done с тем же ключом и Clear, что Claude. При закрытом Chat Done получает доступный последний ответ после штатного обновления source; свежесть eventual, без SLA задержки журнала. Ошибка/отсутствие последнего текста оставляет Done без выдуманного ответа. Две сессии Codex разных worktree не смешиваются.

## 5. №3 — полные вопросы

Новый островной `QuestionForm` поддерживает 1–4 вопроса, произвольное допустимое число вариантов с прокруткой, single-select, multi-select, описания и Other. Вопросы идут страницами `Back/Next`, на последней — явный `Submit`; все ответы отправляются одним решением. Next требует непустого текущего ответа, Submit — непустых ответов всех вопросов. Back сохраняет выбор в пределах активной карточки. Other при single заменяет выбранную подпись, при multi дополняет выбранные подписи; пробелы по краям Other удаляются.

Сериализация совпадает с `QuestionCard.answerOf`: `{[question.question]: answer}`, multi — подписи и непустой Other через `, `. Чистую функцию можно выделить в `renderer/lib/question-answer.ts` с parity-тестами чата и острова. Остров не импортирует `QuestionCard`, chat store, `RoomMarkdown` или широкий bridge.

Один локальный черновик хранится по `refKey + cardId + fingerprint(questions)` только для активной карточки. При выборе другой, разрешении извне, изменении вопросов или disconnect он очищается. Появление нового pending без смены выбранного ключа черновик сохраняет. Пустые/невалидные тексты вопросов или labels, одинаковые тексты вопросов, одинаковые labels внутри вопроса, `truncated:true` и более четырёх вопросов дают объяснение и `Open in Parley`; локальный Submit недоступен. `options:[]` допустимо как Other-only: пустой список вариантов сам по себе не ошибка. Дубликаты не получают придуманных wire-id: действующий wire использует текст как ключ, поэтому остров не может исправить неоднозначность сам.

Other и итог каждого ответа ограничены `FEED_DECISION_ANSWER_LIMIT` (16 384 символа); превышение видно до отправки, ответ не усекается молча. Пределы входа повторяют действующую модель feed, а не новый произвольный формат. Пустой список questions не рисуется успешной карточкой. `decisions:'terminal'` показывает текст/переход, без кнопки отправки.

Данные: `feed.snapshot {ref,scope:'attention'}`. Решение ровно `feed.decide {ref,cardId,decision:{kind:'question',answers}}`; новый host method, event или изменение `FeedDecision` не нужны. Ввод получает клавиатуру через общий owner; scroll/selection не перетаскивают окно.

Приёмка Q1: три вопроса с single/multi/Other после Back/Next дают точный payload чата. Q2: смена cardId/fingerprint/ref и disconnect очищают draft; новый pending оставляет draft активного вопроса. Q3: ввод, IME, Enter из Other и навигация не отправляют решение; Tab→Submit→Enter после 500 мс отправляет один раз. Q4: дубликаты, усечение, 0/5 вопросов и переполнение ответа дают безопасный fallback. Q5: `pending` после неуспешного decide остаётся повторяемым, `elsewhere/not_found` не переоткрывает форму; поздние ответы старого поколения игнорируются.

## 6. №4 — просмотр и решение плана

Островная `PlanView` показывает полный доступный `item.plan` как экранированный plain text в прокручиваемой области, сохраняет переносы и помещается в постоянный кадр 480×520 с учётом чёлки. Body — максимум 280 px и не больше оставшегося пространства после header/footer/notch; текст без line-clamp. Длинная строка переносится, кнопки и выход остаются доступны. Нет исполнения HTML, загрузки картинок, активных внешних ссылок или чтения `planFilePath`. Если текст усечён хостом, показываются явный `Truncated` и переход в основной интерфейс: остров не обещает восстановить отсутствующие байты.

Две явные кнопки отправляют существующие значения:

```ts
feed.decide({ ref, cardId, decision: { kind: 'plan', choice: 'auto-accept' } })
feed.decide({ ref, cardId, decision: { kind: 'plan', choice: 'manual' } })
```

Подписи различают автоматическое принятие дальнейших edits и одобрение каждого edit. `Change plan in terminal` только открывает целевую сессию в терминале; это не Deny, interrupt, отправка текста или редактирование файла из острова. Для этого session-вариант `FocusTarget` получает опциональное `view:'terminal'`, несовместимое с `cardId`. `isFocusTarget`, IPC, очередь целей `App.tsx` и `attention/focus-target.ts` проверяют и применяют его: сохранённая вкладка Chat действительно переключается в terminal. Старые цели без view ведут себя как прежде, cardId открывает Chat.

Данные и решения: прежние feed snapshot/decide; whitelist хоста не расширяется. `decisions:'terminal'` запрещает локальное одобрение. Обновление текста заново взводит 500 мс; состояние sending/elsewhere/error — как §3.

Приёмка P1: план 16 КиБ с длинными строками читается до конца прокруткой, HTML и URL остаются текстом. P2: каждая кнопка отправляет ровно свой choice после взвода; двойной click и ответ из Chat/Telegram не меняют уже принятое решение. Focused Approve + замена текста того же cardId + 500 мс + Enter не отправляет решения до явного повторного фокуса кнопки. P3: Change plan открывает terminal даже при сохранённом Chat и не вызывает ни одного mutating host method. P4: `cardId + view:'terminal'` отвергается; обычный cardId и старые цели не регрессируют; truncated и terminal-only дают явный переход.

## 7. №5 — текущий шаг и краткая история

### 7.1 Представление и жизненный цикл

У одной выбранной строки сессии можно раскрыть деталь. Она показывает `Loading`, доступные текущий шаг/историю, пустое состояние `No recent actions` либо `Unavailable` с `Open in Parley`. Текущий шаг — последняя running top-level tool-строка из возвращённого окна. Это фактический инструмент, а не обещание намерения агента. Агентский `metrics.plan` в этой функции не используется и удаляется из островной activity projection; №4 показывает отдельную ожидающую feed plan card.

История — канонический хвост максимум из 20 уникальных tool ids, с running/done/failed/rejected, локальными подписями категорий и временем. Обновление одного id заменяет статус, не добавляет второй action. `current` ссылается на ту же строку `recent` и не является 21-м элементом. Если ранний running выпал из хвоста, его нет в current; `truncated:true` объясняет неполноту. Параллельные running внутри окна остаются в истории, current — последний по каноническому порядку. Отсутствие running даёт `current:null`. История ограничена живым feed, не является долговечным аудитом.

Остров опрашивает только одну раскрытую сессию: стандартный следующий запрос через **500 мс после завершения предыдущего**, один in-flight. Main/host defence сохраняет min250ms/max4sec, оставляя запас относительно UI polling. Опрос приостановлен при сворачивании, скрытии окна, disconnect, открытом помощнике или карточке pending. Возобновление начинается со свежего запроса. Результат проверяет generation/ref/selection; переход к другой сессии не переносит историю, поздний результат закрытой детали отбрасывается. При throttle последний результат сохраняется как `Stale / Update delayed` и применяется retryAfterMs; при отсутствии первого результата остаётся loading, а не мигающий unavailable. Прочие ошибки дают generic unavailable; UI не выполняет немедленных бесконечных повторов. Если старый хост не объявил метод в `HostStatus.connected.methods` или список `null`, показывается unavailable без периодических `unknown_method`.

### 7.2 Точный новый контракт

Добавляется один метод, без новых событий и подписок:

```ts
// Строгий объект: лишние limit/agentId/path и другие поля отвергаются.
'feed.progress': { ref: SessionRef }

type ProgressLine = {
  id: string; // wire 1..128; host всегда SHA-256, 64 lowercase hex символа
  at: string; // canonical UTC ISO, ровно 24 символа Date.toISOString()
  category: 'read' | 'edit' | 'execute' | 'search' | 'delegate' | 'other';
  status: 'running' | 'done' | 'failed' | 'rejected';
  endedAt?: string; // такая же canonical UTC ISO24-метка
};
type ProgressResult = {
  revision: number; // неотрицательное безопасное целое feed.revision
  availability: 'available' | 'unavailable';
  current: ProgressLine | null;
  recent: ProgressLine[]; // <=20 уникальных id, current входит сюда
  truncated: boolean;
};
```

Все объекты результата строгие. Временные метки нормализуются из валидной даты в canonical UTC ISO24; невалидная дата или расширенный год, не помещающийся в 24 символа, даёт unavailable всей проекции, исходный текст даты не копируется. Сериализованный результат целиком — максимум 16 КиБ UTF-8; предел проверяется после проекции. Если корректная ограниченная форма не получается, возвращается unavailable, без сырых ошибок: `current:null,recent:[],truncated:false`, revision 0 при отсутствии feed state, иначе сохранённая feed revision. Предыдущая история не выдаётся за актуальную при unavailable. Доступная форма с пустой recent означает отсутствие действий; unavailable означает отсутствие надёжных данных. Область revision — `SessionRef + connectionGeneration + session process lifecycle`, значение берётся из feed, а не из renderer polling counter. Reconnect и новый процесс сбрасывают ожидания renderer. Сравниваются только available результаты в одной области; unavailable не понижает expected revision.

На хосте новый чистый `feed/progress.ts` строит категории по известным именам инструментов и возвращает только enum. В transport запрещены `name`, `input`, `args`, `response`, `patch`, `path`, `command`, ошибки источника, текст prompt, transcriptPath и результаты инструментов. Подписи локальны в renderer, максимум 160 символов; неизвестное имя становится `other`, а не исходным именем. Не читать файлы по переданному renderer пути и не запускать команду ради превью.

Метод регистрируется через `protocol/feed-progress.ts`, схемы methods/results и exports; обработчик получает `request.client`. После валидации ref и `sessionOf` выполняется seed-if-needed существующего source, затем чистая проекция допустимых строк текущего `feed.state`. Internal stamp `provider/providerSessionId/startedAtProcess` сверяется перед materialization и delivery; тот же SessionRef/connection не доказывает актуальность журнала после смены binding или процесса. Stamp, raw provider ids и внутренняя progress-эпоха не входят в wire. Контракт результата выше не меняется; новая эпоха относится только к progress, без rebind/reset общей Chat/feed и без изменения её подписок.

**Дополнение recovery B2, принято s-25 в m-1111.** На существующей ленте хранится ограниченное состояние progress-эпохи: подтверждённый stamp и eligible IDs текущих parent-tool items, либо отсутствие подтверждённой эпохи. В проекцию допускаются только `kind:'tool'` с отсутствующим agentId и ID из eligible; agent cards, children и инструменты субагентов не становятся историей родителя. Это метаданные допустимости, не кэш ответов или копия журнала. Eligible — подмножество IDs текущего feed state, очищается при trim/remove/state replacement, максимум FEED_MAX_ITEMS (2000) на ленту; forget удаляет его вместе с лентой. Invalidation очищает eligibility и инвалидирует in-flight progress старой эпохи. Результат старого чтения после await не подтверждает новую эпоху; запрет поздней доставки и single-flight underlying read из §7.3 сохраняются.

На onStart фиксируется граница нового PTY **независимо от существования feed** (m-1195/1196/1199). Pending хранит captured start pid; previousStartedAt при отсутствии observedSource берётся из карты, а не теряется вместе с отсутствующим source/file/proof. Подтверждение lifecycle отдельно от source admission: пока живой `pty.get(ref)` существует, его pid должен совпасть с captured pid и map.pid, а startedAtProcess карты должен стать новым непустым значением относительно captured previousStartedAt. Наличие log file, индексации или Codex root proof для снятия lifecycle pending не требуется. Works-change может провести эту проверку и снять pending, но сам не создаёт progress epoch и не делает строки eligible. OS startedAtProcess не сравнивается с Date.now-based startedAt: это разные источники времени.

После подтверждения сохраняется сам факт наблюдавшейся lifecycle boundary, даже если feed ещё не создан: deferred seed не начинает initial generation0 и не включает прежнюю историю. Pending и boundary metadata ограничены известными session refs и очищаются при forget/удалении сессии/stop FeedService; это не новый source cache/poller. Exit PTY не является подтверждением и не заменяет эту очистку: неподтверждённый pending остаётся fail-closed и при feed, созданном впервые после exit. MarkStarted при живом matching handle может подтвердить lifecycle без log/proof; последующий exit не отменяет состоявшегося подтверждения, поздний qualifying proof/file проверяется отдельно. Достоверный cold seed остановленной сессии с полным неизменным stamp остаётся допустимым (m-1115), но наблюдавшаяся граница не даёт повторно включить историю как первый seed. Claude по-прежнему требует новый hook с `body.session_id === current.providerSessionId`; ранний hook до markStarted и hook с чужим session_id не получают eligibility. В eligible включаются только ID, созданные под подтверждённой эпохой; обновление статуса старого неeligible ID не делает его новым.

Codex admission в выбранном opt2 требует не только providerSessionId, но отдельное доказательство авторитетной MCP-привязки ниже. Существующая карта не различает запасной link по cwd/time и MCP binding в одном providerSessionId; поэтому самого этого поля недостаточно для H4. Коллизия соседних сессий описана в `packages/core/src/mcp/tools.ts:1390–1395`. До полного matching proof progress unavailable; существующий fallback Chat/source этим не исправляется и не меняется (backlog b-005). Возможность показа чужих fallback-строк не объявляется принятым человеком риском progress.

Подтверждение Codex идёт только через уже существующий seed/tail read, со stamp/generation guards до и после await. Для первого trustworthy seed **до любого lifecycle invalidation** допустима вся его история parent tools. После invalidation seed не объявляет старую историю новой: eligibility получают только subsequent новые source rows под подтверждённой эпохой; изменённые старые IDs не включаются. После подтверждения допустим `available` с пустой recent. Консервативный пропуск строки на переходе предпочтительнее выдачи прежнего read. Новый poller/cache/serial-обёртка для recovery не добавляются.

**Opt2 — приватное доказательство Codex binding.** Это выбранное минимальное source evidence, не новый room/plan контракт r-01 и не замена raw Chat binding:

```ts
// Optional WorkSession field; внутреннее хранение, не island/MCP/public works payload.
codexThreadBinding?: {
  launchRevision: string; // canonical lowercase UUID, ровно36 символов
  pid: number; // positive safe integer
  startedAtProcess: string; // 1..64 UTF-16 code units, без control chars
  threadId: string | null; // null=unverified/fallback, иначе canonical lowercase UUID36
};
```

Объект строгий: только четыре указанных ключа. Record создаётся, сбрасывается и подтверждается только для `provider === 'codex'`; для non-Codex его не создавать, случайно сохранённое поле удалять при normalization. StartedAtProcess не trim/normalize, сравнивается точно с process stamp карты; реальный producer выдаёт ISO, но сравнение разных часов не вводится. UUID валидируются как canonical lowercase UUID36; malformed proof удаляется целиком, не портит сессию и не превращается в trust. Старые карты без поля продолжают читаться; schema version не поднимается. Read/update/write roundtrip других писателей сохраняет валидный Codex record, не требует изменения room/plan логики r-01. Отдельного source enum нет: null thread неавторитетен, ненулевой threadId пишет только MCP proof producer.

Источником launchRevision служит уже существующий launch env UUID/nativeContextRevision, создаваемый независимо от skillNavigator и уже передаваемый в startSession и MCP context. Новый native-context descriptor и изменение context.ts не нужны. Lifecycle атомарен под updateMap:

- Новый валидный launch UUID и полный process stamp создают record с threadId:null при новом start/resume.
- Повтор того же валидного UUID с тем же полным pid/startedAtProcess сохраняет record. Тот же UUID с другим полным process stamp **также сохраняет прежний record без изменений**, а map process остаётся фактическим incoming: proof tuple mismatch даёт progress unavailable. Структурно валидный retained record переживает map read/write roundtrip даже при несовпадении процесса: mismatch отвергает consumer, а не превращает record в отсутствующий. Повтор такого вызова не создаёт новую authority; только новый valid UUID с полным process выполняет reset. Это защита конкретного replay при доверенном host caller, не универсальный ledger запусков (m-1173).
- Repair без UUID сохраняет record только для точно того же процесса, иначе удаляет; не придумывает UUID и не подтверждает trust. Невалидный переданный UUID или неполный process stamp удаляет record.
- Выполненная fallback-привязка в core/work/launch.ts:linkSession только demotes threadId→null, сохраняя корректные launch/process identity; host activity не становится новым proof writer. Существующее поведение raw providerSessionId не меняется.

Raw-bind once latch и отдельный proof latch/retry независимы. Для **proof**, в отличие от legacy raw bind, оба metadata `_meta.threadId` и `_meta.sessionId` должны быть валидными UUID и равны после canonical normalization; missing/invalid/mismatch не дают proof. MCP захватывает первый qualifying root thread и launch UUID своего процесса; child/malformed marker не подтверждает proof и не подменяет захваченный root. Внутри updateMap lock proof producer сравнивает captured launch с record.launchRevision, полный current process с record process и raw providerSessionId с captured root thread. Только после всех сравнений записывается record.threadId. Если одним вызовом меняются raw binding и proof, это один updateMap. Отсутствие/ошибка proof не меняет прежнее raw bind поведение и latch: threadId-only call может успешно записать raw binding, но progress unavailable до qualifying proof call. Already-same raw thread не пропускает proof write. До markStarted proof pending; повтор делается на следующем MCP call с тем же captured root/launch. Если нового call нет, progress остаётся unavailable — явное ограничение, не таймер или фоновый retry. Существующие fixtures подтверждают этот тестовый metadata контракт, но не универсальную совместимость всех версий Codex; отсутствие root marker ограничивает доступность №5. Remote MCP подчиняется тому же правилу.

Старый MCP writer после нового start/resume имеет прежний launch UUID и не может записать proof новой эпохи; reset и proof сериализованы одним map lock. Поздний proof после stop допустим для того же полного сохранённого tuple до нового запуска: stopped cold seed остаётся доступным. Новый launch сбрасывает record; missing/malformed proof не заменяется fallback-эвристикой.

Только progress consumer требует полного совпадения proof tuple с текущими raw binding/process, плюс существующий live-PTY pid gate. Внутренний Codex epoch/read token захватывает **provider, threadId (=providerSessionId), proof.launchRevision, pid, startedAtProcess и tail file**. Token проверяется до/после await и перед delivery; новый nonce инвалидирует epoch/in-flight даже при прежних thread/pid/start. LaunchRevision и token не входят в wire. Public Chat/source не начинают требовать proof. Initial fallback seed — raw-only: до авторитетного proof его строки не eligible для progress. При proof на том же thread существующий tail read может подтвердить новую progress-эпоху только при совпадении binding/file; eligible получают subsequent новые IDs, а прежние fallback rows не включаются. Это не повторный полный seed доверия. Если existing tail закреплён за другим thread, progress unavailable до host restart/removal; raw Chat продолжает прежнюю работу. First trustworthy seed с полным proof до любой invalidation допускает свою историю; остановленная сессия с сохранённым полным tuple допускает достоверный cold seed. Без proof, несовпадающем tuple или раннем неподтверждённом onStart остаётся unavailable.

**Exposure и совместимость выбранного opt2.** Core work/context-pages.ts удаляет codexThreadBinding из всех agent/map projections. Host works/works-service.ts удаляет его из публичных compact и legacy works.list/works.changed; внутренние entry/snapshot/onChange сохраняют record. Main дополнительно удаляет поле из island works.list и works.changed одинаково, как backstop для старого host, прочитавшего карту с новым optional полем. Проекции не мутируют source maps. Не добавлять proof в MCP/get_map, новые RPC/whitelist/events; feed.progress остаётся единственным новым RPC этапа. Canary-tests проверяют отсутствие нового proof object/launchRevision в serialized public payload и сохранность во внутренних объектах; существующие raw поля Chat не меняют семантику. Producer, public stripping и progress gate принимаются только всем стеком, а не отдельным доказательством на диске без consumer guards.

Progress не вызывает `pollCodex` на каждом запросе и не заводит нового source poller. Codex уже обновляется через `onLogChange → seedAside → pollCodex` (`feed-service.ts:1190–1194,924–936`); использовать эту действующую цепочку и тестировать работу при закрытом Chat. `pollCodex` уже сериализован внутри, дополнительная serialCodex-обёртка запрещена. Никаких subscribe/unsubscribe и изменений состояния подписчиков Chat. 250 мс — защитный minimum interval main, UI по умолчанию ждёт500мс после settled запроса; ни одно число не обещает свежесть source. `activity/log-index.ts:103` содержит minimum interval2000мс, который также не является SLA≤2с при задержке журнала/index.

### 7.3 Ограничения стоимости и очистка

| Граница | Контракт |
|---|---|
| Частота доставки | Main sender-specific limiter: не чаще одного island feed.progress за 250 мс; renderer по умолчанию ждёт 500 мс после settled request |
| Клиентская квота | Не более 4 вызовов/сек на client, не более одного одновременного вызова; превышение отклоняется до seed/read/projection |
| Отказ по квоте | Существующий RPC code `conflict`, `data.reason:'island-progress-rate-limit'`, `data.retryAfterMs <= 250`; новый error code не вводится |
| Хранение | Используется существующий feed state; нового LRU/TTL кэша ответов, таймера и source poller нет |
| Ожидание результата | Через 2 с caller получает unavailable; underlying single-flight остаётся занят до конца чтения, новый read по тому же ref не запускается |
| Позднее завершение | Не публикуется после removal/stop/смены connection generation; результат закрытой детали игнорирует renderer |
| Освобождение | `dropClient`, удаление сессии, disconnect/stop очищают клиентскую квоту/доставку; per-ref cold-read single-flight не снимается одним timeout |

Важно различать transport/projection caps и I/O. 20 строк, 16 КиБ и 250 мс — новые ограничения проекции и доставки. Они **не ограничивают стоимость холодного чтения журнала**: действующий Claude seed читает transcript; Codex seed имеет свой лимит 32 МиБ, а delta может выделить `size-offset`. Существующие maxItems/maxBytes ограничивают feed state, но не доказывают bounded disk I/O. Этап не переписывает journal pipeline. Квота и coalesced cold-read single-flight снижают повторную стоимость; зависший источник даёт unavailable и переход в Parley, без очереди новых чтений.

**Ограничения WATCH m-1190 для T11.** Любой наблюдённый переход source stamp non-null→null инвалидирует progress history, в том числе временный null при задержке log indexing или перечитывании works. После восстановления source история не возвращается: recovery допускает available empty и только новые строки. Это принятая консервативная граница, а не обещание без потерь; проверить transient null/переиндексацию в T11 или на реальном хосте, не менять raw Chat/source producers. `CODEX_EARLY_TOOLS` остаётся false. Его включение требует отдельного ревью eligibility: tool IDs, заранее созданные хуком, уже присутствуют в before, и последующий tail update не считается созданием нового eligible ID. Изменение флага или этого будущего контракта вне текущей задачи.

Редакционное уточнение m-1213: любой наблюдённый onStart ставит lifecycle boundary. Ранние **новые** строки Codex, уже попавшие в первый raw seed до подтверждённого source, не становятся progress history задним числом. Поэтому после запуска/возобновления допустима пустая история, затем только subsequent verified rows; для Claude — новые matching hooks. Полную seed-историю допускает только trustworthy generation0 до наблюдавшихся lifecycle boundaries; этот путь не ограничивается исключительно stopped-сессиями. Это описание существующего контракта и ограничения, не новый runtime proof.

### 7.4 Приёмка истории

- H1: burst из 100 изменений сохраняет максимум 20 уникальных строк и не больше четырёх доставок/сек через island sender; одинаковый id получает окончательный статус, отдельный source poller не создаётся.
- H2: результат не содержит запрещённых полей и контрольных секретов даже как serialized bytes; валиден по строгой схеме и не превышает 16 КиБ UTF-8. Длинные id/даты обрабатываются без утечки исходного значения.
- H3: ранний running + более 20 поздних settled даёт не 21 строку, current берётся только из recent, truncated виден; parallel running не теряются внутри хвоста.
- H4: две сессии одного провайдера и два worktree с одинаковыми относительными путями не смешиваются; смена selection/disconnect/removal не принимает поздний ответ.
- H5 по выбранному opt2: закрытый Chat не мешает штатному Codex Done; progress требует полного matching authoritative proof и immutable tail binding/file. Без proof/thread progress unavailable. Initial fallback seed raw-only; same-thread MCP proof требует отдельной записи даже после успешного raw bind и допускает в existing tail только subsequent новые IDs, без прежних fallback rows. Different-thread tail остаётся unavailable до host restart/removal, Chat не меняется. Первый trustworthy seed под полным proof до invalidation допускает историю; stopped cold seed с сохранённым полным tuple допустим без PTY. Available empty допустим. Нет нового poll/rebind/subscription, SLA задержки журнала не придумывается.
- H6: превышение квоты не запускает source read/projection; renderer сохраняет stale результат и выдерживает backoff, первый loading не мигает unavailable. Отдельного кэша/периодического source poller нет; reconnect не ломает scope revision.
- H7: зависшее чтение за 2 с даёт unavailable; повтор не создаёт параллельный read; позднее завершение после удаления не восстанавливает строку. Collapse/assistant/pending прекращают polling; старый host не получает unknown-method цикл.
- H8: A→B binding при том же SessionRef/connection, restart того же binding, unknown→confirmed binding, missing source timestamp, resume mid-seed и remove/readd ref не публикуют прежние строки; поздний A не подтверждает B. Cold Claude/Codex seed в полёте→onStart→seed завершился: Chat принимает элементы и Codex tail работает, progress прежние IDs не выдаёт. При live PTY map pid mismatch блокирует progress; отсутствие PTY допускает достоверный cold seed с полным неизменным stamp, но exit неподтверждённого pending onStart не разрешает ранние строки. Works-change не подтверждает epoch. Hook до markStarted/с чужим session_id не eligible, следующий matching hook добавляет только новые IDs; status update старого ID его не включает. После resume история начинается с новых действий, available empty допустим. Trim/remove/state replacement держат eligible⊆current items≤FEED_MAX_ITEMS, forget удаляет epoch; invalidation запрещает late delivery. Проверить отсутствие agent-child строк и неизменность Chat/feed/subscriptions; methods/feed.ts fallback сохраняет feed revision, а не возвращает0 при имеющейся ленте. Ref revision не считается доказательством provenance.
- H8-lifecycle (m-1199): onStart без feed сохраняет pending; previousStartedAt берётся из map при отсутствии observedSource. Feed, созданный до неподтверждённого exit или впервые после него, остаётся fail-closed. Положительный контроль: live handle.pid==captured pid==map.pid и новый непустой startedAtProcess подтверждают lifecycle через works-change без log/proof; markStarted→exit→поздний qualifying proof/file не застревает в pending. Если feed появился после такого подтверждения, boundary всё равно исключает initial generation0 и старую seed-историю; works-change не создаёт epoch. Stopped cold seed под полным допустимым tuple не запрещён. Forget/удаление/stop FeedService очищают per-ref pending/boundary даже при отсутствии feed; нет утечки ref-state, raw Chat/source producers прежние.
- H8-opt2: новые/same UUID и same/different process, start retry после map-lock failure, repair без UUID, stale MCP после resume, same-thread raw bind с отдельным proof retry, strict metadata root и early-call-before-markStarted. Отдельный replay AC: start A/proof→same UUID processB дважды сохраняет старый record A; map process B фактический, старый MCP не подтверждает B, consumer возвращает unavailable по tuple mismatch; затем new UUID reset threadId:null. Repair без UUID при другом/unknown процессе, invalid UUID или incomplete process drop остаются отдельными случаями. ThreadId-only/missing/invalid/mismatched sessionId сохраняют legacy raw результат, но не дают proof; equal canonical-normalized UUIDs допускают qualifying root, включая remote MCP. Нет следующего call — unavailable; поздний proof после stop того же tuple допустим, после нового launch — отказ. Same thread/pid/start, но новый launchRevision: старый in-flight read не подтверждает epoch, прежние IDs не eligible. Create/reset/proof только Codex, non-Codex normalization удаляет поле; старые/invalid maps не синтезируют trust. Проверить strict keys/UUID/pid/string bounds, roundtrip и non-mutating projections. Canary proof отсутствует в agent/public works compact+legacy/island event+snapshot, internal entry/snapshot/onChange его сохраняют; старый public raw providerSessionId может иметь то же значение, что удалённый proof.threadId. Fallback rows не становятся eligible задним числом; H4 проверяется на соседних Codex-сессиях в одном cwd. Реализация и проверка T7b приняты на lineage через `90d61a26`; это не утверждает приёмку T8/T9.

## 8. №5 — активные субагенты и предложения комнат

### 8.1 Субагенты

Данные уже есть в `LiveMetrics.tasks` и `subagents`; остров получает их из activity event и snapshot. В обеих main проекциях каждый task.id **всегда** заменяется SHA-256 lowercase hex64, даже короткий исходный id. Строка ребёнка имеет стабильный `refKey + projected task.id`; raw id не становится обходным free-text каналом.

Main передаёт максимум 8 валидных уникальных tasks. Desktop-only тип `IslandActivityEntry = EventData<'activity.changed'> & {islandTasksTotal?:number}` содержит число валидных уникальных source task IDs **до take8**. Тип объявляется в `shared/island.ts`, renderer `store/activity.ts:ActivityEntry` принимает optional intersection; host/protocol `LiveMetrics` не меняется. EventName остаётся activity.changed, activitySnapshot отдаёт те же projected entries. При absent tasks total отсутствует, при `tasks:[]` total=0. `+N = max(0,islandTasksTotal - deliveredTasks.length)`; `subagents` — отдельный reported count, не источник overflow. Несовпадение count с tasks не создаёт вымышленных identity.

**Принятое D5=B:** показывать type≤48 и description≤160 как plain text, удалять controls/newline, маскировать известные credential patterns; при сбое sanitizer — generic label. Человек явно принял остаточный риск произвольного секрета в свободном тексте (m-939 со ссылкой на решения владельца m-935/936). Regex не даёт абсолютной гарантии отсутствия секретов; эта оговорка сохраняется после выбора B. Вариант A с generic labels/allowlisted type и описаниями только в основном окне был альтернативой проектирования и не является текущим режимом. Структурные задачи, hashed ids, cap и overflow одинаковы независимо от этой альтернативы.

Фоновая задача может пережить родительский ход. Done ортогонален детям: родитель в Done сохраняет doneKey/reply/badge и вложенные tasks, одна родительская строка, working=0, done=1. После Clear done=0, но родитель остаётся как `Subagents active` с отдельным числом. Idle родитель с активными tasks/count также сохраняется без подделки working. После завершения последнего ребёнка очищенный idle parent исчезает без повторного Done; новый turnEndedAt даёт новый Done. Tasks не превращаются в самостоятельные сессии и не увеличивают working sessions.

Перед передачей острову main минимизирует metrics в обоих маршрутах: `activity.changed` через `forwardHostToWindow/Pages` и `host:activity-snapshot` только для island sender. Неиспользуемый `metrics.plan` удаляется; в островной проекции остаются только нужные числовые counters и принятые bounded labels/hashed task IDs, `model` равен `null`, usage и произвольные metadata не передаются. `activity.tasks` проецируется как `[]`, поэтому вложенные raw tasks и `transcriptPath` не образуют дополнительный канал; отдельное поле `transcriptPath` не добавляется. Для основного Chat данные не меняются. Явные credential, URL-with-auth и token key=value patterns маскируются; failure sanitizer даёт generic label. Текст не трактуется как HTML/Markdown/путь. Redaction — best effort, не доказательство отсутствия любого произвольного секрета; человек принял этот остаточный риск. Сырые tool arguments не поступают даже до sanitizer в feed.progress.

Островная activity-проекция также устанавливает `waitingFor:null` и `need.detail:null`: detail общего needs-you summary может содержать approval-команду или аргументы. Это осознанное отличие activity-derived fallback от K16: вместо команды показывается generic «approval in terminal». Сама сессия не подавляется: `need.kind` сохраняется, отдельная permission/consent карточка остаётся видимой и доступной своим штатным маршрутом. Основной Chat и Telegram сохраняют прежний `needReason(detail)` и общий K16; эта privacy-граница не меняет их поведение и не меняет feed/consent protocol. Regression AC: Chat по-прежнему показывает `needReason(detail)`, островная projection сериализует `detail:null`, а renderer показывает generic fallback; тест не удаляет и не ослабляет проверку Chat. Фоновый `heldByBackground` без существующего `turnEndedAt` остаётся `Subagents active` (`working=0`, `done=0`): timestamp не реконструируется и новая Done не создаётся.

Приёмка S1: running background task удерживает строку idle/Done родителя, не увеличивая working; Done сохраняет reply/badge, Clear снимает только Done, последний ребёнок не воспроизводит очищенный Done, новый turnEndedAt работает заново; held-only без turnEndedAt даёт `Subagents active`, `working=0`, `done=0`. S2: 12 tasks/count5 дают 8 строк,+4,count5; 3 tasks/count12 дают 3 строки без+9,count12; []/count12 — известный пустой список без вымышленных детей; absent — unknown. S3: обе доставки одинаково очищают auth URL/ключи/controls по выбранной policy; островная проекция имеет только нужные numeric counters, `model:null`, bounded task labels/hashed IDs и top-level total, без `metrics.plan`, usage/arbitrary metadata, raw nested tasks/transcriptPath, `waitingFor` и `need.detail`; основной Chat получает исходные данные, Chat/Telegram сохраняют K16 `needReason(detail)`, а activity-derived Island fallback остаётся generic «approval in terminal» при видимой permission/consent карточке; regression сравнивает обе поверхности; sanitize failure безопасен. S4: reordering tasks не теряет stable keys, parent removal/disconnect очищает детей. S5: raw short-id canary отсутствует в serialized event/snapshot, projected id всегда hex64; total считает валидные unique ids до cap одинаково в обоих маршрутах.

### 8.2 Предложения комнат

Из существующего works snapshot/event показывать неархивную комнату с `proposal !== null` даже при busy=0 и Done=0, но только при `work.status === 'active'`, сохраняя прежнюю границу острова. Suspended/closed/done work не получает новой видимости из-за proposal. Строка получает `Waiting for you`, имя комнаты и **текущего живого ведущего**, определённого семантикой `liveLead`: назначенный живой участник, иначе первый живой member. `proposal.from` — автор текста, не доказательство текущего ведущего; owner также не заменяет lead. Отсутствие ведущего даёт нейтральную подпись. Используется существующий browser-safe `renderer/lib/room-lead.ts:roomLiveLead` с parity-fixtures; новый дубликат helper/core export не нужен, Node-модули core в renderer не импортируются.

Учитываются `kind:'decision'` и `'completion'`, legacy без kind — decision. Полный текст, preview предложения, аргументы и файлы на остров не добавляются: единственное действие `Open room` ведёт в комнату, где человек видит актуальный текст и штатные варианты ответа. Это также сохраняет семантику r-01, включая типы предложений его стека. Нет `rooms.resolveProposal`, plan actions или скрытого Accept с острова. Обновление proposal.rev меняет identity pending; удаление/ответ/архив комнаты снимает элемент. Смена lead обновляет подпись без переадресации чужой сессии.

r-01 halted без proposal — вне выбранного расширения: отсутствие предложения нельзя заменить произвольным «комната ждёт человека», не придумываются proposal или кнопка resume. `plans.resumeAutonomous` остаётся запрещён острову.

Новая ожидающая комната раскрывает свёрнутую панель и входит в очередь #7. При редактировании вопроса она не меняет выбранную карточку, только badge/сигнал. Дедупликация по полному work/room/proposal/rev, а не заголовку комнаты; состояние не дублирует комнату в списке.

Приёмка R1: pending в пустой комнате активной работы виден; completion и legacy поддержаны; archived и неактивная работа скрыты; halted без proposal не создаёт pending/action. R2: смена/закрытие ведущего выбирает liveLead как основной UI, `proposal.from` не используется вместо него. R3: новая ревизия/возврат/удаление не оставляют устаревшее ожидание, одинаковые room ids разных worktree независимы. R4: Open room не вызывает ни одного метода решения; текст предложения не появляется в DOM острова; новый pending не стирает вопрос.

### 8.3 Удержание видимости и сосуществование ожиданий

`IslandModel.active` учитывает активные фоновые children и pending room proposals. Они сохраняют существующую видимость и held-parent semantics; автоматическое сворачивание может ждать завершения/снятия такого элемента часами. Это принятая UX-граница, а не таймерная гарантия; поведение кода не меняется. В native acceptance proposal badge должен оставаться рядом с permission/question, не закрывая их, а строка активного ребёнка — оставаться читаемой. Проверяется длительное удержание и обновление обычной видимости после завершения child либо снятия proposal; задержка сама по себе не считается ошибкой.

## 9. №8 — тихий Done уже наблюдаемой сессии

Источником видимости служит существующий `visibleSessionRefs` основного renderer (TerminalSurface и ChatView), совместно с `documentVisible` и состоянием main window. Видимыми считаются все реальные активные split panes. Sidebar, строка сессии в комнате, неактивная вкладка или просто факт фокуса Parley не означают просмотра сессии. Чужие приложения/терминалы не исследуются.

Уточнение D3 на новой базе (m-945/947/950): raw visibleSessionRefs недостаточно, если открытая browser panel покрывает pane. Quiet-Done publisher использует `layout.panels` и panel runtime hosts и подписывается на оба источника. Для session ref исключение ровно `panel.open && (host отсутствует || !host.measured || host.narrow)`; закрытая panel измерения не требует, beside оставляет ref. Открытие/закрытие и resize перепубликуют видимость.

В `browser/panel/runtime.ts` host получает additive `measured:boolean`; `mountHost` принимает optional argument measured с default false для совместимости. `PanelHost` публикует measured=`width>0`, narrow продолжает вычисляться существующим `PANEL_LIMITS.narrowBelow`. Не дублировать 560 в publisher и не менять прежнее поведение UI narrow; нулевая/неизвестная ширина больше не считается доказательством видимости для quiet Done. PR111 изменил порог covering720→560px. Добавляются адресные тесты runtime/PanelHost и relay; global seen tracker и producers ChatView/TerminalSurface/SurfaceLayer остаются без изменений.

Обновление host сравнивает **оба** narrow/measured в equality guard runtime, а эффект PanelHost зависит от runtimeKey/narrow/measured. Переход width0→600 при narrow=false в обоих состояниях обязан опубликовать measured false→true. Ключ переиспользуется из существующего `panelRuntimeKey(workKey, owner)`, без ручной склейки; room-owner panel не считается перекрытием session pane. В jsdom тест подменяет ResizeObserver и getBoundingClientRect, чтобы проверить фактическую смену измерения, а не вечный width0.

Известное ограничение (m-946c): существующий seen tracker всё ещё может пометить перекрытую сессию просмотренной через1с, поскольку его raw visibleSessionRefs не исключает covering. Quiet-Done relay исправляет только подавление раскрытия острова; он не исправляет этот старый seen эффект и не обещает стойкий badge. Отдельное исправление seen не входит в T5.

Desktop-only relay: основной renderer отправляет `app:session-visibility {refs:SessionRef[],documentVisible:boolean,seq:number}`. Main принимает только текущий main webContents и его main frame, валидирует refs/предел 50, documentVisible и монотонную seq текущей страницы. Renderer заранее ограничивает refs стабильными первыми 50; прочие дают обычный Done. Main отвергает malformed/over50, не усекает чужой payload сам. Хранит refs только при alive/focused/visible/non-minimized окне, очищает на blur/minimize/navigation/crash/close; при focus renderer перепубликует актуальную видимость. Сброс seq-generation для нового main document разрешён только из main lifecycle, а не произвольным сообщением.

Getter `IslandApi.visibility()` и `onVisibility` используют `island:session-visibility` snapshot `{version:number,refs:SessionRef[]}`. Version монотонна в процессе main; при рестарте main кэш сбрасывается. Getter island-only, событие main→island. Подписка раньше getter, новое событие не затирается поздним snapshot. Невалидные/неизвестные данные дают пустую видимость и обычный Done.

При свежем `doneKey` точное совпадение полного ref подавляет только автоматическое `setRetracted(false)` и freshDone hold timer. Badge и учёт Done остаются штатными. Ключ сразу отмечается в локальном `seenDone` даже при подавлении: последующий blur не всплывает тем же завершением. Смена конца хода — новый ключ. Уже раскрытый список не закрывается из-за quiet Done.

Подавление не вызывает `activity.seen` и не меняет unseen само. Основной seen tracker сохраняет свои 1 с видимости и повторы; badge может затем штатно исчезнуть после seen и не обещается как постоянная отметка. Clear сохраняет нынешний `island:mark-seen` с пакетами до 50. Permission, question, plan, consents и room proposal остаются заметны независимо от видимости. Нет новых host methods/events или фоновых оконных детекторов.

Граница с отдельной r-05 (#9 sounds/motion): quiet Done — чистая policy `suppressExpansion`, без новых прямых beep/animation hooks. Согласован desktop-only presentation outcome:

```ts
type IslandPresentationOutcome = {
  key: string; // полный identity ref/card либо work/room/proposal/rev, для Done — doneKey
  kind: 'permission' | 'question' | 'plan' | 'consent' | 'room-proposal' | 'done' | 'terminal-request';
  fresh: boolean;
  expand: boolean;
  soundEligible: boolean;
};
```

Единая точка freshness/presentation dispatch использует существующий callback seam, без отдельного одноразового framework; beep остаётся существующим fallback. Codex fallback с `card:null` имеет kind `terminal-request`, а не вымышленную permission card (m-940). Все Done пока `soundEligible:false`, quiet Done дополнительно `expand:false`; permission/consent не подавляются. #9 сохраняет suppression и не дублирует cue тем же key из собственного edge hook. R-04 не меняет swarm/ и island.css; r-05 владеет новыми sound/*, motion.ts, swarm/* и CSS, перебазируется после r-04. Общие IslandApp/View/main beep интегрируются последовательно. По согласованному m-856 r-05 после нас меняет RETRACT_MORPH_MS в IslandApp.tsx с 250 на 300 мс; сама анимация остаётся вне r-04. Реализация #9 и его callbacks/pulse не входят в задачи этого плана.

Приёмка D1: целевая сессия в видимом split pane и main focused — badge без автораскрытия (проверять fake timers до штатной отметки seen за 1 с); другая сессия, main blur/minimized/hidden и неизвестность — обычный Done. D2: Chat и Terminal одинаково учитываются, sidebar/room tab не учитываются. D3: quiet Done не шлёт seen; blur не воспроизводит suppressed key; новый turnEndedAt работает заново. D4: event-before-snapshot, старая seq и старый main frame не портят состояние; close/crash/reload сбрасывают refs. D5: одновременно pending/consent раскрываются, Clear и held Done сохраняют прежнюю семантику.

Приёмка V1 для layout: покрытые открытой browser panel Chat и Terminal получают ordinary Done, beside panel — quiet Done; в split layout исключается только покрытый ref. Open/close и resize559↔560 обновляют relay; unknown measurement при открытой panel не подавляет Done. Первый mount width0/measured=false → ResizeObserver600/measured=true при unchanged narrow=false обновляет runtime/relay и включает quiet Done. Используется panelRuntimeKey; global seen tracker и прежние visibility producers не изменены. Этот V1 — критерий layout, не решение D6 о базе.

## 10. №7 — клавиатурная навигация

После появления всех видов pending вводится единая стабильная navigation queue: consent → feed request → room proposal; внутри вида — `since`, затем полный key. Выбор хранится по key, индекс только вычисляется. При снятии выбранного элемента выбирается ближайший оставшийся, draft не переносится; повторная ревизия перевзводит защиту. Terminal-only fallback — feed request с переходом без решения. Очередь работает и для мыши, иначе hotkey мог бы выбирать объект, скрытый другой приоритетной карточкой.

Принятое глобальное сочетание `Control+Alt+I`, настраиваемое или отключаемое. Main регистрирует его только при включённом Island, доступной панели и подключённом хосте. Сочетание помощника имеет самостоятельное владение: конфликт не снимает его регистрацию. Повтор одного удержанного global key coalesced. Ошибка регистрации видна в Settings; остаются click и обычный переход в Parley. Во время записи ShortcutField текущая регистрация приостанавливается, затем восстанавливается; collision/off/reconfigure/quit освобождают только принадлежащую этой функции регистрацию.

Точное desktop расширение: `IslandUi.pendingHotkey:string|null` (null — off), `app:island-shortcut` getter `{accelerator:string|null,ok:boolean}`, `app:island-shortcut-suspend` с boolean на период записи. Их вызывает основной renderer; main проверяет отправителя. `IslandApi.onNavigate` слушает main→island команду, `onKeyboardBlur` — общий blur. Это desktop IPC, не значения host EventName/ISLAND_EVENTS.

Main посылает только `island:navigate {command:'pending'}`. Остров раскрывается, выбирает ожидающий элемент, получает клавиатуру общим owner и ставит фокус на контейнер/заголовок. Стрелки переключают pending только вне input/textarea/contenteditable и IME. Escape отдаёт клавиатуру и выходит из режима; Ctrl+Enter открывает feed/room цель в основном окне — карточку Chat, terminal fallback либо room. Для consent навигация раскрывает существующий inline ConsentView; Ctrl+Enter ничего не делает, подсказка Open session не показывается. У consent нет FocusTarget, optional requestedBy не превращается в выдуманный SessionRef. Ни одна навигационная команда не вызывает решения, Trust/Allow/Deny/Submit или room resolve. Явные Trust/Deny сохраняются после arm. При пустой очереди — краткое `No pending requests`, без host calls. Новый pending во время ввода не перехватывает выбранную карточку.

Приёмка K1: global trigger, repeat, стрелки, Ctrl+Enter и Escape не вызывают feed/consent/room decisions; consent без workId/sessionId безопасен, Ctrl+Enter не делает host call/перехода. K2: Tab→явная кнопка→Enter/Space после 500 мс отправляет ровно один ответ; стартовый фокус, смена карточки и fingerprint того же cardId снимают focus с decision button, Enter без явного повторного фокуса не отправляет решение. K3: Other/IME и contenteditable сохраняют ввод и стрелки, новые pending не уносят draft. K4: consent/feed/room соблюдают стабильный порядок; removed selection и revised proposal не выбирают чужой key. K5: conflict, одинаковое сочетание с assistant, отключение, hidden/disconnected и empty queue не оставляют global registration/keyboard owner. Возврат фокуса проверяется на настоящем macOS.

## 11. Матрица протокола и whitelist

| Уровень | Точное изменение |
|---|---|
| Host protocol | Добавить только `feed.progress {ref}` и строгий result §7.2 в method schemas/results/exports; существующие FeedItem/FeedDecision/FEED_SCHEMA_VERSION не менять |
| Host events | Без изменений: новый polling method не создаёт события |
| `ISLAND_METHODS` | Полный итоговый список: `works.list`, `feed.snapshot`, `feed.decide`, `assistant.ask`, `assistant.cancel`, `assistant.decide`, `assistant.reset`, `assistant.state`, `consents.list`, `consents.decide`, **`feed.progress`**. 10 существующих + 1 новый |
| `ISLAND_EVENTS` | Без изменений: works.changed, activity.changed, assistant.changed, consents.changed |
| Запрещённые расширения | Не добавлять feed.subscribe/unsubscribe/changed, pty.*, fs/files.*, rooms.*, plans.*, providers.* |
| Desktop target | Session FocusTarget: `view?:'terminal'`, несовместимое с cardId; новый валидатор и route, не host wire |
| Keyboard | Общий `island:keyboard-blur` вместо assistant-blur; main→island `island:navigate {command:'pending'}`; существующий island:keyboard, sender island-only |
| Visibility | main-only reporter `app:session-visibility`, island-only getter/event `island:session-visibility`; schema §9, версия в snapshot |
| Config/shortcut | `IslandUi.pendingHotkey:string|null`; main-renderer `app:island-shortcut` status `{accelerator,ok}`, `app:island-shortcut-suspend:boolean`; без общего host:notify для острова |
| Snapshot policy | Для island sender строгий `{ref,scope:'attention'}`; missing/wrong scope, agentId/extra fields отвергнуты до call; ответ старого host проецируется в main до передачи, Chat без изменений |
| Tasks envelope | Desktop-only `IslandActivityEntry` с optional `islandTasksTotal`; максимум8 hashed-id tasks в event/snapshot. Host/protocol LiveMetrics и EventName не меняются |
| Presentation seam | Desktop-only IslandPresentationOutcome по §9, один dispatch; это не host event и не расширение ISLAND_EVENTS |
| Opt2 private evidence | Optional WorkSession.codexThreadBinding только внутри хранения: agent/public works compact+legacy и island event/snapshot его удаляют. Нет schema bump, новых RPC/events или whitelist; приёмка всего opt2 stack атомарна |

События activity и snapshot main проецирует только для острова; ограничения sender дополняются проверкой main frame и актуального webContents там, где они необходимы. `host:call` продолжает применять белый список по отправителю в main, а не только TypeScript в preload. Getter видимости также island-only; renderer не может сам объявить себя основным окном. Все слушатели/таймеры снимаются на reload/dispose. CSP, navigation guard, sandbox, contextIsolation, отсутствие Node и click-through кадра сохраняются.

## 12. Проверка и ограничения

Доказательство реализации потребует protocol schema tests, чистых projector/sanitizer/model tests, host fake-clock/single-flight тестов, bridge/IPC sender tests, renderer interaction tests и focused Electron E2E. В плане приведены точные файлы, команды и зависимости. Системный фокус, регистрация global shortcut и multi-monitor поведение требуют ручного macOS smoke; jsdom не доказывает их. Этап 2 проверяет только согласованность документов, существование исходных путей и полноту критериев, а не утверждает, что приложение уже изменено.

## Принятые решения D1–D6

Решения человека переданы в m-939; исходный docs-only этап завершён. Числа и UX-границы ниже действуют при реализации, а не ожидают повторного выбора.

1. **D1 — числовые границы, принято.** 1–4 вопроса; история20/16КиБ, default polling500мс после settled, main limiter250мс, host4/sec/client и concurrent1; caller2s; tasks≤8, type48/description160; visibility≤50. Нет нового кэша/source poller. Изменение пределов требует пересмотра контракта, AC и тестов.
2. **D2 — глобальное сочетание, принято.** `Control+Alt+I`, изменение/off в Settings, явная диагностика конфликта; navigation без решений, native focused button activation по §3 сохраняется.
3. **D3 — quiet Done, принято.** Точные refs видимых Chat/Terminal split panes сфокусированного non-minimized main window с исключением covering browser panel; beside учитывается, unknown measurement — обычный Done. Само подавление не отправляет seen.
4. **D4 — предложения комнат, принято.** Badge + live lead + Open room, без preview/ответа с острова, без перехвата активного ввода; active-work-only и proposal-presence сохраняются.
5. **D5 — принято B.** Type≤48/description≤160, plain text, known credential masking, generic fallback; человек явно принял остаточный риск произвольных секретов. Абсолютная no-secrets гарантия не заявляется.
6. **D6 — принята новая база и старт.** Используется существующий worktree s-31 `/Users/kalmbik61/parley/worktrees/my_harnas-00f205/w-0054-s-31`, feature-ветка `feat/island-agents` (прежнее имя ветки удалено) от точного `origin/master d8d541a21f937b77162fca0f1db03d10d5837584`, вместо прежней рекомендации b975adb4. До T0 — принятие аудита новой базы. Переключение ветки только в собственном worktree s-31; master checkout остаётся fbb7b828 и dirty. Разрешены английские коммиты исполнителей в feature-worktree; push/PR не разрешены. S-27 продолжает только сопровождение двух docs без коммитов.

## Решения, ещё открытые для человека

T7b принят на lineage до `90d61a26`; T8 принят на `e0aaeab4`, T9 — на `7b672105`. Открыты T10/T11. Рекомендация — завершить их по согласованным gates, сохраняя принятые контракты и границы T7b–T9. Push/PR и внешняя публикация остаются отдельными действиями человека; рекомендация — решать после реализации и проверок T10/T11. Новый дефект или конфликт требований сначала рассматривает ведущий; это не разрешение исполнителю расширять scope.
