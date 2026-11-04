# Телефон: кнопка микрофона (A47)

Дата: 2026-11-04. Статус: редакция 3 лида s-174.
- Ревью: `docs/audits/2026-11-04/mobile-voice-critic-A47-spec.md` (s-250). Первое — 3 блокера, 7 major, 10 minor;
  повторное (r2) — 0 блокеров, 2 major, 4 minor.
- Источник языка (§2.3) выбрал человек: вариант (а), язык клавиатуры (s-38, m-3336).

Задача пришла от человека через s-38. Человеку нужна своя кнопка микрофона в приложении, «как в окне», а не диктовка
клавиатуры iOS.

Образец в окне:
- `docs/specs/2026-10-06-voice-input-design.md` §1, §3.2–3.3, §6.5;
- `packages/desktop/src/renderer/voice/`: `MicButton.tsx`, `insert.ts`, `targets.ts`, `dictation-store.ts`.

Связано:
- план `docs/plans/2026-10-29-mobile-app-plan.md`, раздел A47;
- экраны `docs/design/2026-10-31-mobile-mvp-screens.md` §9.5, абзац «Микрофон».

## 1. Что берём из окна, а что меняется

Как в окне:
- **Старт и стоп.** Тап по кнопке начинает запись, второй тап её останавливает. Пока запись запускается, тап по
  кнопке ничего не делает.
- **Вставка.** Текст встаёт на место курсора. Если перед курсором стоит не пробел и поле не пустое, добавляется
  пробел. Ничего не отправляется.
- **Отмена.** Cancel выбрасывает запись, поле не меняется.
- **Предел.** Через 2 минуты запись сама останавливается и идёт в распознавание.
- **Одна запись на приложение.** Тап по микрофону другого поля отменяет прежнюю запись и начинает новую. Пока идёт
  распознавание, все кнопки микрофона недоступны.
- **Состояния.** Готово; запись (красная точка, полоска громкости, таймер); распознавание.
- **Отправка во время записи.** ⬆ и «Start session» не отправляют: запись завершается, и текст встаёт в поле
  (`finishBeforeSend` окна).
- **Первая запись.** После того как человек выдал разрешения на первом тапе, запись начинается сразу.

Отличия от окна:
- **Движок — Apple Speech на устройстве.** Whisper не используется, моделей скачивать не нужно, экрана Settings → Voice
  нет.
- **Язык выбирается сам** (§2.3), настройки языка нет.
- **Кнопка включена всегда.** Переключателя «Voice input» нет. Если для языка нет распознавания на устройстве, кнопка
  тусклая и по тапу объясняет причину (§3.1).
- **Cancel — кнопка в полоске записи.** Esc и горячей клавиши на телефоне нет.
- **Поле исчезло во время распознавания.** Текст дописывается в черновик этого поля: у сессии и комнаты черновики
  живут в хранилище приложения. Буфер обмена берётся только для New session (в окне — всегда буфер).
- **Нет порога громкости.** Пустую расшифровку Apple отдаёт сама; тогда показывается тост «No speech detected».

Звук не покидает телефон: ни на Mac, ни на серверы Apple (§2.2). Протокол, хост и мост не меняются.

## 2. Решения

### 2.1 Библиотека: `expo-speech-recognition` 58.0.1

Версия выпущена 2026-10-29 для Expo SDK 58 (dist-tag `latest`, ветка `58.x` = SDK 58). Лицензия MIT.

Почему она:
- **Тот же движок.** Внутри `SFSpeechRecognizer` и `SFSpeechAudioBufferRecognitionRequest`, то есть Apple Speech.
- **Всё нужное есть:**
  - параметры `requiresOnDeviceRecognition`, `continuous`, `addsPunctuation`, `iosTaskHint: 'dictation'`;
  - громкость — событие `volumechange`, от −2 до 10;
  - запрос обоих разрешений — `requestPermissionsAsync`;
  - `stop` с последним результатом и `abort` без результата;
  - `setAudioSessionActiveIOS`.
- **Готовая платформенная часть.** Аудиосессия, прерывания и коды ошибок Apple уже обработаны. Своих сетевых вызовов
  в `ios/*.swift` нет (проверил критик).
- **Плагин конфигурации** пишет `NSSpeechRecognitionUsageDescription` нашим текстом.

Отвергнуты:
- **Свой модуль Expo на Swift.** Около 250 строк нативного кода со звуком, без тестов в vitest. Выигрыша против
  заплатки из нескольких правок (§2.2) нет.
- **`@react-native-voice/voice`.** Не модуль Expo и без плагина конфигурации. Распознавание на сервере в нём не
  запретить.
- **Whisper на телефоне и отправка звука на Mac** — вне задачи по условию человека.

### 2.2 Звук не уходит с телефона: заплатка библиотеки

По документации Apple `SFSpeechRecognitionRequest.requiresOnDeviceRecognition` учитывается, **только если**
`SFSpeechRecognizer.supportsOnDeviceRecognition == true`. Без этого распознаватель работает через сеть. Флаг запроса
сам по себе ничего не гарантирует.

Версия 58.0.1 к тому же выставляет флаг только при поддержке
(`ios/ExpoSpeechRecognizer.swift`, `prepareRequest`):

```swift
if recognizer.supportsOnDeviceRecognition {
  request.requiresOnDeviceRecognition = options.requiresOnDeviceRecognition
}
```

Для языка без распознавания на устройстве библиотека молча идёт на сервер Apple. Её `supportsOnDeviceRecognition()`
и `isRecognitionAvailable()` проверяют распознаватель языка по умолчанию (`SFSpeechRecognizer()`), а не того языка,
который мы передаём в `start`.

Зависимость подключается с заплаткой pnpm: `pnpm patch`, ключ `pnpm.patchedDependencies` в корневом `package.json`,
файл `patches/expo-speech-recognition@58.0.1.patch`. В заплатке ровно эти правки:

1. **Охрана — настоящая гарантия.** В `ExpoSpeechRecognizer.startRecognizer`, сразу после
   `guard let recognizer, recognizer.isAvailable else { … }` и до `prepareRequest`, `prepareFileRecognition` и
   `prepareMicrophoneRecognition`:

   ```swift
   // Parley: never fall back to Apple's servers (Apple honours requiresOnDeviceRecognition only when supported).
   if options.requiresOnDeviceRecognition && !recognizer.supportsOnDeviceRecognition {
     errorHandler(RecognizerError.nilRecognizer)
     reset(andEmitEnd: true)
     return
   }
   ```

   Проверка стоит на том экземпляре распознавателя, который реально запускается, при каждом старте, в том числе при
   повторном старте на закэшированном распознавателе. `RecognizerError.nilRecognizer` библиотека уже переводит в
   событие `error` с кодом `language-not-supported`, а `reset(andEmitEnd: true)` шлёт `end`. Микрофон до этого места
   не включается.
2. **Подстраховка.** В `prepareRequest` флаг ставится без условия:
   `request.requiresOnDeviceRecognition = options.requiresOnDeviceRecognition`.
3. **Проверка по языку.** `supportsOnDeviceRecognition` в `ExpoSpeechRecognitionModule.swift` принимает необязательный
   `lang: String?`. С ним проверяется `SFSpeechRecognizer(locale: Locale(identifier: lang))?.supportsOnDeviceRecognition
   ?? false`, без него — прежнее поведение. Объявление типа в `build/ExpoSpeechRecognitionModule.types.d.ts` получает
   тот же необязательный параметр.
4. **Язык клавиатуры (§2.3).** `AsyncFunction("currentInputLanguage")` в
   `ExpoSpeechRecognitionModule.swift` с `.runOnQueue(.main)`, потому что UIKit трогают только на главной очереди.
   Функция находит первый ответчик через `UIApplication.shared.sendAction(_:to:nil,from:nil,for:nil)` с маленьким
   расширением `UIResponder` и возвращает `responder?.textInputMode?.primaryLanguage`, иначе `nil`. Тип в `.d.ts` —
   `currentInputLanguage(): Promise<string | null>`.

Сопровождение заплатки:
- **Тест `src/voice/patch.test.ts`** читает установленные файлы библиотеки и проверяет, что каждая правка на месте:
  охрана стоит внутри `startRecognizer` раньше `prepareRequest`; флаг в `prepareRequest` без условия; у
  `supportsOnDeviceRecognition` есть параметр. Если библиотеку обновят или заплатку снимут, тест упадёт.
- **`pnpm install` упадёт,** если pnpm не сможет наложить заплатку на новую версию.
- **Телефон вызывает `start` только с `requiresOnDeviceRecognition: true`.** Это проверяет тест модуля движка (§6).
- **`isRecognitionAvailable()` не вызывается:** она смотрит не тот распознаватель (ревью M1). Недоступность
  распознавателя приходит из охраны `isAvailable` в `startRecognizer` как ошибка `service-not-allowed`.

### 2.3 Язык

**Источник языка — решение человека** (вопрос лида m-3329, ответ s-38 m-3336): вариант (а). Вариант (б) отклонён и
оставлен ниже для истории. Формулировку «device/keyboard locale» в задаче написал s-38, а не человек.

- **(а) Язык клавиатуры, иначе язык устройства.**
  - В момент тапа: если поле в фокусе (клавиатура поднята), первым кандидатом берётся
    `currentInputLanguage()` (§2.2, правка 4). Значения не в виде языкового тега (`emoji`, `dictation`, `nil`)
    пропускаются.
  - Если поле не в фокусе, первым кандидатом идёт последний язык клавиатуры, полученный на прошлом тапе за этот
    запуск приложения (ревью r2, n2). Так в одном поле язык не скачет от того, поднята ли клавиатура.
  - Иначе, а также если язык клавиатуры не дал подходящего распознавателя, берётся первый предпочитаемый язык
    устройства: `expo-localization` `~58.0.5`, `getLocales()[0]`. Чтобы такой переход не прошёл незаметно, полоска
    показывает код языка попытки (§3.2).
- **(б) Только язык устройства:** `getLocales()[0]`. Отклонён.

**Выбор распознавателя.** Чистая функция `localeCandidates(tag, supported)` возвращает упорядоченный список
идентификаторов из `supported`. Список `supported` берётся из `getSupportedLocales({}).locales`; на iOS это вида
`ru-RU`, `en-US`. Порядок кандидатов:
1. точное совпадение тега (с заменой `_` на `-`);
2. `язык-РЕГИОН` из тега: `ru-US` → нет, `en-GB` → `en-GB`;
3. `язык-ЯЗЫК`: `de-DE`, `fr-FR`, `ru-RU`, `ja-JP`, `it-IT`;
4. короткий список предпочтений:
   - `en` → `en-US`;
   - `es` → `es-ES`;
   - `pt` → `pt-BR`;
   - `zh` со скриптом `Hans` или регионом `CN`/`SG` → `zh-CN`;
   - `zh` со скриптом `Hant` или регионом `TW` → `zh-TW`, с регионом `HK` → `zh-HK`;
5. остальные варианты того же языка из `supported` по алфавиту. Например, если скачан только `en-GB`, `en-RU` дойдёт
   до него (ревью r2, n2). Для `zh` шаг 5 не применяется: варианты `zh` — разные языки.

Дубли из списка убираются, а кандидаты не из `supported` отбрасываются. Выбирается первый кандидат, у которого
`supportsOnDeviceRecognition(tag)` равно `true`. Если такого нет, кнопка «недоступна» с причиной (§3.1).

**Когда проверяется.**
- **При показе.** Тусклое состояние кнопки считается по языку устройства при первом показе кнопки за запуск
  приложения и заново при каждом возврате приложения на передний план: человек мог включить диктовку в Настройках.
- **На каждом тапе** выбор делается заново, с языком клавиатуры. Тусклая кнопка тоже начинает запись, если язык
  клавиатуры подошёл.
- Разрешений проверка не спрашивает.

### 2.4 Разрешения

- **Тексты в `app.config.ts`.**
  - У плагина `expo-camera` `microphonePermission: false` меняется на текст про микрофон ниже. Мод `withInfoPlist`
    камеры выполняется после статического `ios.infoPlist`, куда пишет плагин распознавания. При `false` он удаляет ключ
    микрофона при любом порядке плагинов, и первый тап обрушил бы приложение (ревью B2). Камера звук не пишет; ключ —
    только текст системного запроса.
  - Плагин `expo-speech-recognition` получает оба текста.
  - Проверка — оба ключа есть в собранном `ios/Parley/Info.plist` (§6).
- **Тексты.**
  - `NSMicrophoneUsageDescription`: «Parley listens only while you dictate into a message. Audio stays on this
    iPhone.»
  - `NSSpeechRecognitionUsageDescription`: «Parley turns your speech into text on this iPhone. Audio is not sent
    anywhere.»
- **Когда спрашиваются.** На первом тапе по микрофону, не при запуске. `getPermissionsAsync()`: если не выдано и
  `canAskAgain`, то `requestPermissionsAsync()`, оба разрешения разом. Если выдано, запись начинается сразу.
- **Отказ** (`granted === false`, не `restricted`): запись не начинается. `Alert` с заголовком «Microphone or speech
  recognition is off», текстом «Allow both for Parley in Settings to dictate.» и кнопками «Not now» и «Open Settings»
  (`Linking.openSettings()`).
- **`restricted`** (Экранное время или MDM): `Alert` с заголовком «Dictation is restricted on this iPhone», текстом
  «Screen Time or your organization blocks the microphone or speech recognition.» и одной кнопкой «OK».

## 3. Что видит человек

### 3.1 Кнопка

Одна кнопка `MicButton` в трёх местах:
1. **Поле сессии** (`src/feed/Composer.tsx`): между полем и `⬆`.
2. **Поле комнаты** (`src/app/room.tsx`): между полем и `⬆`; `@` остаётся слева.
3. **Поле Task в New session** (`src/app/new.tsx`): справа от поля, по нижнему краю.

Цель 44×44, значок SF Symbols 22 pt. В карточках вопросов, в поле письма комнаты New room и в остальных полях кнопки
нет. Если поле скрыто (`mode.kind === 'hidden'`), кнопки нет. Если поле выключено (`editable === false`), кнопка
недоступна.

Состояния:

| Состояние | Значок | VoiceOver: label / hint | Тап |
|---|---|---|---|
| **недоступно**: нет распознавания на устройстве для языка или распознаватель недоступен | `mic.slash`, `c.off` | «Dictation unavailable» / причина | выбор заново (§2.3); не вышло — тост с причиной |
| **готово** | `mic`, `c.tint` | «Dictate» / «Records until you tap again. The text goes into the field; nothing is sent.» | старт |
| **запуск** этого поля | `ActivityIndicator` | «Starting dictation» | ничего |
| **запись** этого поля | красная точка 12 pt (`c.danger`) | «Stop dictation» | стоп |
| **распознавание** этого поля | `ActivityIndicator` | «Transcribing» | недоступна |
| **отмена** этого поля | `ActivityIndicator` | «Stopping» | недоступна |
| **запись** другого поля | `mic`, `c.tint` | «Dictate» | отменить ту, начать эту (§4.2) |
| **запуск, распознавание или отмена** другого поля | `mic`, `c.off` | «Dictate», недоступна | ничего |

«Недоступно» не помечается `disabled`: иначе тап и VoiceOver не дойдут до причины.

Причины:
- «On-device dictation isn't available for <tag>. Turn on Dictation for this language in Settings › General ›
  Keyboard.» — кандидаты есть, но ни у одного нет распознавания на устройстве; `<tag>` — первый кандидат;
- «Dictation isn't available for <languageTag>.» — кандидатов нет;
- «Dictation is off or its language isn't downloaded. Turn on Dictation in Settings › General › Keyboard.» — пришла
  ошибка `service-not-allowed`.

### 3.2 Полоска записи

Пока это поле запускает или ведёт запись, прямо над строкой поля стоит полоска `DictationStrip`. Порядок сверху вниз:
- меню упоминаний;
- плашка цитаты;
- строка «To»;
- счётчик 16 КБ;
- полоска;
- строка поля.

Состав полоски:
- **запуск:** «Starting…» и справа «Cancel»;
- **запись:** красная точка, полоска громкости 40×4 pt, таймер `0:07` (цифры моноширинные), справа текстовая кнопка
  «Cancel» (цель 44 pt по высоте);
- **распознавание:** «Transcribing…», без Cancel;
- **отмена:** «Stopping…», без Cancel.

В полоске запуска и записи перед таймером стоит код языка попытки: `RU`, `EN` (первая часть
тега, заглавными). VoiceOver читает его как часть метки полоски, например «Dictating in ru-RU, 0:07».

Громкость приходит в `volumechange` раз в 100 мс: `level = clamp(value, 0, 10) / 10`. Значения ≤ 0 библиотека
называет неслышимыми. Таймер и предел 2 минуты считаются от события `start` библиотеки, а не от тапа.

### 3.3 Результат

**Сборка текста.**
- Берутся результаты с `isFinal: true` и непустым `results`. Из каждого — `results[0].transcript` без пробелов по
  краям; куски склеиваются через один пробел.
- Пустые результаты и событие `nomatch` пропускаются и попытку **не завершают**: на iOS 18+ библиотека отдаёт пустой
  финальный результат после последнего куска и `nomatch` на шуме посреди записи.

**Конец попытки — только событие `end`** (или таймаут из §4.2):
- **Отменили мы** (Cancel, переключение поля, уход с экрана, фон) — ничего не вставляется.
- **Иначе** (стоп, 2 минуты, ⬆, звонок, ошибка посреди записи, таймаут ожидания):
  - собранный текст непуст — он вставляется, даже после `interrupted` или `no-speech`;
  - текст пуст — тост по последней ошибке (§3.4), а без ошибки — «No speech detected».

**Вставка.** `spliceTranscript(value, caret, text)` — перенос `insert.ts` окна без изменений.
- **Курсор** — последнее значение `selection.start` из `onSelectionChange`, ограниченное длиной текста на момент
  вставки. Если поле на этом экране ещё ни разу не сообщало выделение — конец текста. Клавиатура во время записи не
  убирается, человек может печатать, поэтому курсор берётся в момент вставки, а не старта.
- **После вставки**, если поле в фокусе, курсор ставится за вставку (`setSelection`), когда новое значение уже
  отрисовано (`requestAnimationFrame`).

**Поле исчезло** (снято с регистрации до конца распознавания):
- **сессия и комната** — текст дописывается в конец черновика этого поля (с `joinTranscript`), тост «Dictation added
  to the draft». Черновики живут в разных хранилищах:
  - сессия — `draftOf`/`setDraft(sessionKey(ref), …)` из `feed/outbox.ts`;
  - комната — закрытая `Map` `drafts` в `room/use-room-chat.ts:11`. Модуль экспортирует `roomDraftOf(key)` и
    `setRoomDraft(key, text)` над той же `Map`, и запасной путь комнаты пишет через них под `roomKey(room)`. Тогда
    новый `useRoomChat` того же ключа увидит дописанный текст (ревью r2, N2);
- **New session** — `Clipboard.setStringAsync(text)`, тост «Transcript copied to clipboard».

**Отмена без вставки:**
- экран ушёл из фокуса (`useIsFocused()` = `false`: открыт другой экран поверх, модальный New session и т. п.) или
  размонтирован во время запуска или записи;
- приложение ушло в фон (`AppState` = `background`) во время запуска или записи.

Во время распознавания результат ждётся как обычно и вставляется в поле, если оно ещё зарегистрировано, даже без
фокуса.

**Аудиосессия.** После каждого `end` — `setAudioSessionActiveIOS(false, { notifyOthersOnDeactivation: true })` в
`try/catch`, чтобы музыка или подкаст человека продолжились.

### 3.4 Ошибки

Событие `error` запоминается как «последняя ошибка» попытки. Решение о показе принимается на `end` (§3.3).

| Последняя ошибка, текст пуст | Что видит человек |
|---|---|
| `not-allowed`, разрешения по `getPermissionsAsync()` не выданы | Alert отказа из §2.4 |
| `not-allowed`, разрешения выданы (ошибка создания распознавателя) | тост «Dictation failed» |
| `language-not-supported` | тост с первой причиной из §3.1; кнопка «недоступна» до следующей проверки |
| `service-not-allowed` | тост с третьей причиной из §3.1; кнопка «недоступна» до следующей проверки |
| `no-speech`, `nomatch` или ошибки нет | тост «No speech detected» |
| `interrupted` (звонок, Siri, будильник) | тост «Dictation was interrupted» |
| `aborted` после нашей отмены | ничего |
| остальное (`audio-capture`, `network`, `busy`, …), таймауты §4.2 | тост «Dictation failed» |

Если текст непуст, он вставляется, а тост показывается только для `interrupted`.

Тосты — существующий `useToast`/`Toast` экрана.

## 4. Устройство

### 4.1 Модули

Новая папка `packages/mobile/src/voice/`:
- **`insert.ts`** — `joinTranscript` и `spliceTranscript`, копия `insert.ts` окна (те же тесты).
- **`locale.ts`** — `localeCandidates(tag, supported)` и `isLanguageTag(value)`.
- **`level.ts`** — `levelOf(value)`.
- **`transcript.ts`** — `assembleTranscript(results)`.
- **`elapsed.ts`** — `formatElapsed(ms)`, как в окне.
- **`dictation.ts`** — хранилище диктовки приложения: `useSyncExternalStore`, как хранилище черновиков A45.
  - **Состояние:** `{ phase: 'idle' | 'starting' | 'recording' | 'transcribing' | 'cancelling', targetId, level,
    startedAt, availability }`.
  - **Действия:** `register(target)` → функция снятия, `toggle(id)`, `cancel()`, `finishBeforeSend(id)`,
    `refreshAvailability()`, `onBackground()`, `onBlur(id)`, `suspend()`/`resume()` для Dictation check (§4.4).
  - **Зависимости через `configure(deps)`:** движок, разрешения, выбор языка, `toast`, `alert`, `copy`,
    `appendDraft`, таймеры, `now`. Так тесты подставляют свои.
- **`engine.ts`** — единственное место, где импортируется `expo-speech-recognition`. Тонкая обёртка:
  - `start(lang)` всегда с параметрами
    `{ lang, requiresOnDeviceRecognition: true, continuous: true, interimResults: false, addsPunctuation: true,
    iosTaskHint: 'dictation', volumeChangeEventOptions: { enabled: true, intervalMillis: 100 } }`;
    `recordingOptions` не передаются;
  - `stop()`, `abort()`, `releaseAudioSession()`;
  - подписки на `start`, `result`, `nomatch`, `error`, `end`, `volumechange`;
  - `supportsOnDevice(lang)`, `supportedLocales()`, `inputLanguage()`, разрешения.
- **`fake-engine.ts`** — поддельный движок для разработки (§4.4).
- **`use-dictation-target.ts`** — хук поля. Принимает `id`, ref на `TextInput`, текущее значение, `apply(value)` и
  `fallback` (`{ draftKey }` или `'clipboard'`).
  - Отслеживает `onSelectionChange` и `useIsFocused()`.
  - Регистрирует цель и снимает её при размонтировании. Снимает только свой объект, как `register` в окне: один экран
    может стоять в стеке дважды с одним `id`.
  - При потере фокуса экрана зовёт `onBlur(id)`.
- **`MicButton.tsx`** и **`DictationStrip.tsx`** — §3.1 и §3.2.

Поля:
- **Сессия.** `Composer.tsx` получает `dictationId` (`session:<ref>`) и черновик `sessionKey(ref)`. Обработчик ⬆
  внутри `Composer` сначала зовёт `finishBeforeSend(id)`, до `onSend`. Так это работает и для «Resume and send» у
  спящей сессии.
- **Комната.** Обработчик ⬆ в `room.tsx` сначала зовёт `finishBeforeSend('room:<id>')`. Черновик — `roomKey(room)`
  через `roomDraftOf`/`setRoomDraft` из `room/use-room-chat.ts` (§3.3).
- **New session.** `submit` в `new.tsx` сначала зовёт `finishBeforeSend('new-session-task')`; запасной путь — буфер
  обмена.

`finishBeforeSend(id)` возвращает `true` и ничего не отправляется, если у этого поля запуск, запись (тогда запись
останавливается, как тапом) или распознавание. Иначе возвращает `false`.

### 4.2 Порядок вызовов библиотеки (ревью B3)

`start`, `stop` и `abort` библиотеки выполняются в несвязанных `Task` Swift и между собой не упорядочены. События не
несут номера попытки. Поэтому хранилище держит протокол:

1. **Занятость.** Нативная сторона «занята» от вызова `start` до её `end`. Новый `start` вызывается только при
   свободной нативной стороне. Все события до `end` относятся к текущей нативной попытке.
2. **Запуск.**
   - Тап → фаза `starting`, вызов `start`.
   - Переход в `recording` — только по событию `start`. С этого момента идут таймер и предел 2 минуты.
3. **Отмена во время запуска** (Cancel, уход с экрана, фон, ⬆) ставит флаг «после старта: abort» (для ⬆ — «stop»),
   фаза `cancelling` (для ⬆ — `transcribing`). Когда придёт событие `start`, вызывается `abort()` (`stop()`). Если
   раньше придёт `end`, попытка закончена.
4. **Отмена во время записи** — `abort()`, фаза `cancelling` до `end`.
5. **Стоп** — `stop()`, фаза `transcribing` до `end`.
6. **Переключение поля во время записи** — `abort()` прежней попытки, фаза `cancelling`. Новое поле ставится в
   очередь (одно место, последнее побеждает) и стартует после `end`.
7. **Конец.** `end` освобождает нативную сторону: снимаются таймеры, отпускается аудиосессия, итог по §3.3, фаза
   `idle`, затем запуск из очереди.
8. **Таймауты** (каждое ожидание — свой):
   - `starting` без `start` и без `end` 5 с → `abort()`, фаза `cancelling`, тост «Dictation failed»;
   - `transcribing` без `end` 10 с → `abort()`, собранный текст вставляется сразу, фаза `cancelling`;
   - `cancelling` без `end` 3 с → нативная сторона считается свободной, фаза `idle`, `console.warn`;
   - `error` без `end` 1 с → считается, что `end` пришёл. Бывает после ошибки создания распознавателя.
9. **Результаты и громкость** в фазе `cancelling` пропускаются.
10. **Чужой `start` гасится сразу (ревью r2, N1).** Событие `start` гасится немедленным `abort()` в трёх случаях:
    - фаза `idle`;
    - фаза `cancelling`;
    - фаза `starting` с флагом отмены (п. 3).

    Это инвариант, а не ветка таймаута. `abort()` библиотеки при ещё не созданной задаче сразу шлёт `end`, а старт
    в своём `Task` идёт дальше. Поэтому после таймаута `starting` или отмены во время запуска поздний `start`
    возможен и после `end`. Такой `start` не открывает новую попытку и не меняет фазу. У этого `abort()` есть
    настоящая задача, он пришлёт `aborted` и `end`, поэтому он добавляет единицу долга из п. 11 (ревью r3, d1).
11. **Запоздалый `end` поглощается (ревью r2, N1; r3, d2).** Хранилище держит счётчик долга — число ожидаемых
    запоздалых `end`. Единицу долга добавляют:
    - освобождение нативной стороны таймаутом (`cancelling` 3 с или `error` 1 с);
    - `abort()` чужого `start` (п. 10).

    Долг гасится так:
    - `end` в фазе `idle` (вместе с `aborted` перед ним) пропускается и уменьшает долг на единицу;
    - `end` в фазе `starting` новой попытки до её `start` и без её `error` при долге больше нуля пропускается и тоже
      уменьшает долг.

    Если новая попытка в это время упала сама, её закроет таймаут `starting`. Долг не уходит ниже нуля.
12. **Синхронный отказ `start` (ревью r2, n4).** Если `engine.start` бросил исключение, нативная сторона свободна,
    фаза сразу `idle`, тост «Dictation failed».

### 4.3 Доступность

`availability` — `{ state: 'unknown' | 'ready' | 'unavailable', reason?, lang? }`. Считается по §2.3 при первой
регистрации цели и на каждом переходе `AppState` в `active`. На тапе выбор делается заново. Ошибки
`language-not-supported` и `service-not-allowed` переводят состояние в `unavailable` с причиной до следующего
пересчёта.

### 4.4 Поддельный движок и проверка охраны

- **Поддельный движок.** При `PARLEY_MOBILE_DEV_VOICE=fake` (`extra.devVoice`, `DEV_VOICE` в `src/dev/flags.ts`,
  только при `__DEV__`, как `DEV_DEMO`) `engine.ts` подменяется поддельным:
  - события `start`, `result`, `end` идут в настоящем асинхронном порядке, с задержками;
  - громкость — синус;
  - после `stop` приходит текст «This is a dictated test sentence.»;
  - доступность и разрешения — «выдано».

  Он нужен для снимков и проверки на симуляторе. В сборке release его нет.
- **Проверка охраны на iPhone.** В Settings › Diagnostics строка «Dictation check». Видна при `DEV_BUILD`
  (`src/dev/build.ts`): это и сборка `device-run.sh`, в release-варианте её нет. Экран показывает:
  - выбранный язык и `supportsOnDevice` для него;
  - кнопку «Try a language without on-device recognition». Она находит в `supportedLocales()` первый язык с
    `supportsOnDevice(lang) === false` и вызывает **настоящий** `engine.start(lang)` мимо проверки JS **два раза
    подряд** на одном языке: второй раз идёт по пути закэшированного распознавателя из ревью B1. Каждый запуск ждёт
    `end` не дольше 3 с, события пишутся на экран.

  Правила проверки (ревью r2, n1):
  - **Первое событие `start` — провал.** Сразу `abort()` и красное «FAIL: recognition started», без ожидания: если
    охрана сломана, звук не должен успеть уйти на сервер.
  - **Ожидаемо** в обоих запусках: `error language-not-supported`, затем `end`; события `start` нет; оранжевая точка
    микрофона iOS не загорается. Итог — зелёное «PASS».
  - **Нужна сеть.** Без сети язык только с серверным распознаванием даёт `service-not-allowed` (охрана `isAvailable`
    раньше правки 1), и правка 1 не проверяется. При `service-not-allowed` экран пишет «Connect to the internet and run
    again», итог не PASS.
  - **Изоляция от хранилища.** Проверка запускается только при фазе хранилища `idle`. Пока она идёт, хранилище
    приостановлено (`suspend()`/`resume()`): события библиотеки глобальны, и без этого хранилище погасило бы `start`
    проверки по п. 10 §4.2 и спутало бы её `end` со своими. Кнопки микрофона в это время недоступны.
  - Если языка без распознавания на устройстве нет, экран так и пишет.

## 5. Приватность

- **Звук не уходит с устройства.** Распознавание только на устройстве. Сервер Apple исключён охраной в
  `startRecognizer` (§2.2, правка 1) с подстраховкой флагом запроса (правка 2). На iPhone это проверяет
  «Dictation check» (§4.4).
- **Звук не сохраняется.** Запись в файл не включается (`recordingOptions` не передаются).
- **Расшифровка** хранится только в поле или в черновике этого поля в памяти приложения. Для New session при
  исчезнувшем поле она попадает в буфер обмена (§3.3), а оттуда может уйти через Универсальный буфер на Mac.
- **Мост и хост ничего нового не получают.** Текст уходит, только когда человек сам нажмёт ⬆.

## 6. Проверка и приёмка

Тесты vitest (`packages/mobile`):
1. **`insert`** — те же случаи, что `insert.test.ts` окна.
2. **`localeCandidates`, `isLanguageTag`:**
   - точное совпадение, `_`;
   - `ru-US` → `ru-RU`;
   - `en-GB`;
   - `en-RU` → `en-US`, но не `en-AE`; при `supported` без `en-US`, но с `en-GB` → `en-GB`;
   - `de-RU` → `de-DE`;
   - `zh-Hans-CN` → `zh-CN`, `zh-Hant-US` → `zh-TW`, `zh-Hant-HK` → `zh-HK`;
   - нет языка, пустой `supported`;
   - `emoji`, `dictation`.
3. **`levelOf`, `assembleTranscript`, `formatElapsed`.** У `assembleTranscript`: куски с пробелом спереди (iOS 18),
   пустой финальный результат, не финальные результаты.
4. **`dictation`** с поддельными зависимостями и движком, который шлёт события асинхронно в заданном порядке:
   - старт → `start` → стоп → `result` → `end` со вставкой; курсор из последнего выделения, ограничение длиной,
     конец без выделения;
   - тап во время `starting` ничего не делает;
   - Cancel в записи; Cancel во время `starting`, и `start` приходит **после** `abort` → вызван `abort`, фаза не
     `idle` до `end`, ничего не вставлено;
   - 2 минуты от события `start` → автостоп со вставкой;
   - вторая цель во время записи: `abort` первой, `start` второй только после `end` первой; чужой `end` не завершает
     вторую;
   - во время распознавания и отмены `toggle` не действует;
   - `finishBeforeSend` в записи, в запуске, в распознавании и без записи;
   - поле снято во время распознавания — черновик (`appendDraft`) или буфер с тостом; поле снято или ушло из фокуса во
     время записи — `abort`; снятие чужого объекта с тем же `id` цель не снимает;
   - фон во время записи — `abort`;
   - разрешения: не выдано + `canAskAgain` → запрос, затем сразу старт; отказ → Alert, `start` не вызван;
     `restricted` → свой Alert;
   - `nomatch` и пустой финальный результат посреди записи не завершают попытку;
   - `interrupted` после двух кусков — текст вставлен, тост; `no-speech` после куска — текст вставлен;
   - каждая строка таблицы §3.4 при пустом тексте;
   - таймауты §4.2: `starting` 5 с, `transcribing` 10 с (собранное вставлено, вызван `abort`), `cancelling` 3 с,
     `error` без `end` 1 с;
   - чужой `start` (п. 10 §4.2): `start` пришёл после таймаута `starting` и его `end` → сразу вызван `abort`, фаза
     `idle` не меняется; `start` в `cancelling` → `abort`;
   - запоздалый `end` (п. 11 §4.2): после таймаута `cancelling` следующая попытка не завершается чужим `end`, пришедшим
     до её `start`; её собственная ошибка закрывает её как обычно;
   - синхронное исключение `engine.start` → `idle` и тост, без ожидания 5 с;
   - `suspend()`: события пропускаются, `toggle` не действует; после `resume()` всё как прежде;
   - запасной путь комнаты: после снятия цели комнаты `roomDraftOf(roomKey(room))` содержит дописанный текст;
   - `availability`: недоступно → тап делает выбор заново и при неудаче даёт тост, `start` не вызван; язык клавиатуры
     подошёл → старт;
   - после `end` вызван `releaseAudioSession`.
5. **`engine`** — `start` всегда с `requiresOnDeviceRecognition: true` и `continuous: true`, без `recordingOptions`.
   Модуль библиотеки подменяется через `vi.mock`.
6. **`patch.test.ts`** — правки §2.2 на месте в установленной библиотеке; охрана — внутри `startRecognizer` раньше
   `prepareRequest`.

Сборка и конфиг:
- `pnpm --filter @parley/mobile typecheck`, тесты, корневой `pnpm lint` — зелёные;
- `expo prebuild` проходит; в `ios/Parley/Info.plist` есть оба ключа с текстами §2.4;
- `Podfile.lock` содержит `ExpoSpeechRecognition` и `ExpoLocalization`.

Снимки на симуляторе (поддельный движок), светлая и тёмная тема, в `docs/audits/2026-11-04/screens-A47/`:
- поле сессии: готово, запуск, запись, распознавание, недоступно (тост);
- поле комнаты: запись — на iPhone 17 и на iPhone SE (3-го поколения), плюс SE с крупным Dynamic Type
  (`accessibilityExtraLarge`);
- New session: запись;
- Settings › Diagnostics › Dictation check.

На iPhone (человек). В «Not verified» стоит всё, что не проверено:
- первая диктовка спрашивает оба разрешения, запись начинается сразу, текст встаёт в поле;
- Dictation check: язык без распознавания на устройстве даёт `language-not-supported`, оранжевая точка не загорается;
- русский и английский; переключение клавиатуры меняет язык и код в полоске;
- сторонние клавиатуры (Gboard, SwiftKey) могут отдавать `primaryLanguage` `en-US` при любом языке;
- «фраза, пауза, стоп» — текст ровно один раз; «стоп посреди фразы» — хвост на месте;
- авиарежим — диктовка работает;
- звонок посреди записи; уход в фон;
- отказ в разрешении → Open Settings;
- 2 минуты — автостоп;
- музыка продолжается после диктовки;
- VoiceOver: объявления из динамика могут попасть в запись;
- iOS 17 и iOS 18+ отдельно (сборка кусков на них разная) — на устройстве человека только одна версия iOS.

## 7. Файлы

- `package.json` (корень): `pnpm.patchedDependencies`;
- `patches/expo-speech-recognition@58.0.1.patch`;
- `pnpm-lock.yaml`;
- `packages/mobile/package.json`: `expo-speech-recognition` `58.0.1` (точная версия, под заплатку) и
  `expo-localization` `~58.0.5`;
- `packages/mobile/app.config.ts`: тексты разрешений (в том числе у `expo-camera`), плагин, `extra.devVoice`;
- `packages/mobile/src/dev/flags.ts`: `DEV_VOICE`;
- `packages/mobile/src/voice/*` (новые) и тесты;
- `packages/mobile/src/room/use-room-chat.ts`: экспорт `roomDraftOf`/`setRoomDraft`;
- `packages/mobile/src/feed/Composer.tsx`, `src/app/session/[ref].tsx`, `src/app/room.tsx`, `src/app/new.tsx`;
- `packages/mobile/src/app/(tabs)/settings/diagnostics.tsx` и новый экран Dictation check;
- `docs/specs/2026-11-04-mobile-voice-input-design.md` (эта спека),
  `docs/plans/2026-10-29-mobile-app-plan.md` (раздел A47),
  `docs/design/2026-10-31-mobile-mvp-screens.md` (§9.5, ссылка).

## 8. Вне задачи

- Whisper на телефоне, отправка звука на Mac, распознавание на сервере Apple.
- Экран настроек языка и выбор языка вручную.
- Микрофон в карточках вопросов, в письме New room, в терминале.
- Горячие клавиши (внешняя клавиатура).
- Android, Windows, Live Activity.
- Протокол, хост, мост.
