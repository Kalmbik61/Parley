# Ревью критика, итог волны экранов: перепроверка A14–A16 и ревью A26 (New session / New room)

Дата: 2026-10-31. Критик: s-176 (Opus), только чтение кода. Предмет: `feat/mobile-stage-a` на `cf25953f`.
- Перепроверка находок из `mobile-stage-a-critic-screens-A14-A16.md` по коммитам:
  - s-187 `4cc54a3c` и доработки Inbox `5fbc60ec`;
  - s-190 `83006dee`;
  - s-189 `8e325f36`.
- Ревью A26: s-184 `32852b97`, D1 §8.4 и §12a.

Тесты и typecheck в моём worktree не запускались: зависимости мобильного пакета там не установлены
(`expo/tsconfig.base` не найден). Опираюсь на прогоны исполнителей. Новых скриншотов после правок нет — проверка
по коду.

**Итог.**
- Волна экранов: M1, M2, M3 и все 9 minor закрыты.
- A26: пункты ведущего выполнены. Один major: повтор «Create room» после частичного сбоя заново запускает уже
  запущенных агентов. Ещё 4 minor и один вопрос ведущему про переключатель Face ID.

## 1. Перепроверка находок A14–A16

| Находка | Вердикт | Где и как |
|---|---|---|
| M1 баннер вне прокрутки | закрыта | `app/decision.tsx:83-84`, `app/letter.tsx:46-47`: баннер — первый ребёнок `ScrollView` с `automatic`; `app/letters/index.tsx:25-26`: `ListHeaderComponent`; Session «загрузка» и «сессии нет» — внутри `ScrollView` (`4cc54a3c`) |
| M2 нет входа в Letters | закрыта | `app/(tabs)/index.tsx`: кнопка `envelope` 44×44 в строке над крупным заголовком, число непрочитанных, VoiceOver «Letters, N unread» (`5fbc60ec`). Плюс `letters/load-letters.ts` дочитывает новейшую страницу каждой работы (см. ниже) |
| M3 линии дерева | закрыта | `works/guides.ts` (`computeGuides`, тест `guides.test.ts`): стволы предков, «├» и угол у последнего ребёнка; `works/TeamTree.tsx:36-59`: угол `borderBottomLeftRadius: 10`, линия 1,5 pt; комнаты и рои подключены (`Guides` у `RoomBlock` / `SwarmBlock`); ствол шапки — из-под аватара; линии скрыты от VoiceOver; отступ 16 pt при `fontScale ≥ 1.35`; цвета `treeLine` — как в D1 |
| m1 подмена хоста в ссылке | закрыта | `markdown/parse.ts`: строгий `SAFE_URL` — без userinfo, `\` и пробелов; такая ссылка — просто текст; тесты в `parse.test.ts` |
| m2 ссылка обрывает паринг | закрыта | `pairing/session.ts` `isBusy()`; `app/pair/index.tsx`: при идущем паринге — алерт «Keep current» / «Use new link» |
| m3 приватный relay | закрыта | `pairing/session.ts` `#check` → `private-relay`, свой текст на сканере, у ссылки и на экране сбоя (`bad_qr`). Ошибки разбора отсеиваются раньше, поэтому `bad_qr` здесь означает relay |
| m4 нет пароля = «cancelled» | закрыта для карточек и Decision | `auth/approve.ts`: `no-passcode` при `passcode_not_set` / `not_available`, тост `NO_PASSCODE`. В A26 не подхвачено — см. a2 |
| m5 повтор последнего пуша | закрыта | `push/notifications.ts`: `once()` по `identifier` + `actionIdentifier` за запуск |
| m6 haptics §16 | закрыта | карточки: `cards/haptics-map.ts` `hapticFor` (Deny → warning, отмена → ничего); Decision: `decision/decision-flow.ts:76` (Accept → success, остальное → warning, отмена → ничего); `selection` на выбор варианта и на новую карточку в Session |
| m7 сырой Markdown в превью | закрыта | `letters-model.ts` `plainPreview` + тест |
| m8 знак «Other» | закрыта | `cards/CardViews.tsx`: тот же знак, что у вариантов вопроса |
| m9 таймер роя | закрыта | `TeamTree.tsx`: `elapsed(createdAt, endedAt, now)` |

Доработки Inbox (`5fbc60ec`):
- «Answered at your Mac» — строка `GoneRow` из `state.gone`, снимается через 2 с от `gone.at`;
- переключатель Мака — только при двух и более хостах;
- контекстное меню по долгому нажатию: Open session / Open work / Copy command;
- хуки клиента сведены в один модуль.

Всё сделано верно.

**Поправка к моей реплике m-2141.** Я писал, что список Letters уже показывает прочитанные письма и нужна только
проверка. Это верно для выборки (`selectLetters` не фильтрует), но не для данных: клиент тянул страницу
`context.messages` только для работ с непрочитанными письмами. s-190 прав, что добавил `useLoadLetters`.

**Замечания (не блокируют).**
- **r1. Две таблицы haptics для Decision.** `cards/haptics-map.ts:22` (`hapticForResolve`) нигде не вызывается, кроме
  теста. Экран берёт `decision-flow.ts:76`. Убрать одну, иначе таблицы разойдутся.
- **r2. Лишние запросы при открытии Letters.** `letters/load-letters.ts` при каждом открытии шлёт
  `context.messages` по всем работам снимка. Для десятков работ это десятки запросов через relay. Можно ограничить
  активными работами или работами, где писем больше, чем лежит в `state.letters`.
- **r3. Устаревшие скриншоты A16 в git.** `docs/screenshots/mobile-a16/0{1,2,3}-*.png` всё ещё отслеживаются
  (с `5ce23a33`) и показывают дефект M1 до правки. По правилу ведущего «no PNGs in commits» их стоит снять с учёта,
  как A14 в `8e325f36`.
- **r4. Нет haptic при выборе Мака.** Переключатель Мака не даёт `selection`, хотя D1 §16 его задаёт.

## 2. Ревью A26 — New session / New room (`32852b97`)

### Пункты ведущего

| Пункт | Вердикт | Где |
|---|---|---|
| Кнопка `+` только при методе в hello моста, выключена без связи | да | `launch/NewButton.tsx:15` — `canShowNew` (`sessions.create` или `rooms.create`); `disabled={!online}`; на Works — в строке крупного заголовка, на Work — `headerRight` |
| Face ID перед каждым запуском и каждым письмом в комнату | да, с вопросом ниже | `launch/launch-model.ts`: `launchSession`, `launchRoom` (один запрос на весь «Create room», как в D1 §8.4) и `sendFirstLetter` (второй запрос) — гейт стоит до первого вызова, отмена ничего не шлёт |
| Нет autonomous и рецептов | да | `ROOM_MODES` — только free / checklist / verified; подпись `AUTONOMOUS_NOTE`; `rooms.create` без `recipe` и `origin` |
| Отказы понятны | да | `refusalMessage`: слова хоста как есть, `unknown_method` → «…turned off on your Mac.»; haptic `error`; причина неготового провайдера — с хоста (`providerChoices`) |
| «May still be starting» для `unknown` | да | `failure()` → `MAY_BE_STARTING` |
| Черновик переживает `lost` | да | форма и письмо остаются в состоянии экрана, над кнопкой `NOT_CONFIRMED`; повтора нет (перечитывание — в `remote-client`) |

### Major

#### A1. Повтор «Create room» после частичного сбоя заново запускает уже запущенных агентов

- **Где.**
  - `launch/launch-model.ts` `launchRoom`: агенты запускаются по одному. При сбое возвращается
    `{ kind: 'partial', started: <число> }` — без id запущенных сессий.
  - `app/new.tsx:150`: `partial` → `fail(res)`, форма остаётся как была, `agents` не меняются.
- **Сценарий.** Человек создаёт комнату с тремя новыми агентами.
  - Два стартовали, третий отклонён лимитом хоста, или `rooms.create` вернул отказ или `lost`. На экране «2 agents
    started, the room was not created: …», кнопка «Create room» снова активна.
  - Человек правит причину (убирает третьего агента или меняет провайдера) и нажимает снова. `launchRoom` опять
    запускает всех из `agents`.
  - На Маке уже четыре тихих агента без задачи. Два первых остались сиротами, вне комнаты.
  - При `lost` на `rooms.create` повтор может дать и вторую комнату: перечитывание не нашло первую, а она создалась.
- **Почему major.** Каждое нажатие запускает на Маке реальные процессы агентов, и это стоит человеку денег.
  D1 §8.4 требует, чтобы запущенные сессии были видны в работе. Здесь же форма предлагает запустить их ещё раз.
- **Исправление.**
  - `partial` возвращает `startedIds: Map<agentKey, sessionId>`. Экран переносит их из `agents` в `members` (ведущий
    переносится тоже) и пишет «2 agents started — they are now members; Create room tries the room again with them».
  - При `lost` на самом `rooms.create` кнопку закрыть до перечитывания снимка или до явного «Try again».
  - Тест в `launch-model.test.ts`: сбой на втором агенте, повтор → `createSession` вызывается только для
    незапущенных.

### Minor

- **a2. В A26 «нет пароля» снова показано как отмена.**
  - Где: `launch-model.ts` (`approve(...) !== 'ok'` → `cancelled`), `app/new.tsx:138/144/149` — строки тостов
    захардкожены.
  - Сценарий: без пароля устройства человек видит «Face ID cancelled — nothing was started».
  - Исправление: передавать `reason` как в `gated-actions.ts` и брать `NO_PASSCODE` и `FACE_ID_CANCELLED` из
    `components/Toast.tsx`.
- **a3. Face ID спрашивается ради вызова, который точно не пройдёт.**
  - Где: `app/new.tsx` — `methodsGone` даёт только текст, в `ready` не входит.
  - Сценарий: на Маке выключили переключатель при открытом листе. Кнопка активна, Face ID спрашивается, затем хост
    отвечает `unknown_method`. D1 §12a: «спрашивать ради вызова, который не уйдёт, нельзя».
  - Исправление: `ready = … && !methodsGone`. Так же быть с сегментом Room без `rooms.create` и шагом письма без
    `rooms.send` (рассинхрон версий): сегмент скрыть, кнопку выключить.
- **a4. Баннер в листе стоит так же, как стоял в M1.**
  - Где: `app/new.tsx:217-219` — `<ConnectionBanner />` перед `ScrollView`, у `ScrollView` нет
    `contentInsetAdjustmentBehavior`.
  - Если заголовок модального листа полупрозрачный, как у экранов M1, баннер и сегменты уйдут под него.
  - Исправление: снять скриншот листа с баннером `not-recognized`; при наложении — тот же приём, что в M1.
- **a5. Свайп вниз с черновиком не спрашивает, а просто заблокирован.**
  - Где: `gestureEnabled: !draft`. D1 §8.4: свайп вниз с текстом спрашивает «Discard this draft?».
  - Сейчас свайп ничего не делает, вопрос есть только у Cancel. Это допустимое упрощение для RN; если
    `react-native-screens` даёт событие попытки закрыть лист, лучше спросить.

### Вопрос ведущему (решение — за человеком)

**Q1. Переключатель «Require Face ID to allow» отключает Face ID и для запуска.**
- `auth/approve.ts:49`: при выключенной настройке всё, кроме `disable`, проходит без Face ID. Значит, и `launch`, и
  `letter` тоже.
- Решение 5 и D1 §8.4 говорят «Face ID перед каждым запуском и каждой отправкой». Таблица 12a ставит запуск рядом
  с Allow, то есть под тот же переключатель.
- Запуск агента с произвольной задачей опаснее одного Allow. Варианты:
  - (а) запуск и письмо всегда спрашивают, как `disable`;
  - (б) оставить как есть и переименовать настройку в «Require Face ID to approve and start».

  Рекомендую (а).
