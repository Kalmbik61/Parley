# Телефон: кнопка микрофона (A47)

Дата: 2026-11-04. Статус: черновик лида s-174, ждёт критика.

Задача пришла от человека через s-38. Человеку нужна своя кнопка микрофона в приложении, «как в окне», а не диктовка
клавиатуры iOS.

Образец в окне:
- `docs/specs/2026-10-06-voice-input-design.md` §1, §3.2–3.3, §6.5;
- `packages/desktop/src/renderer/voice/`: `MicButton.tsx`, `insert.ts`, `targets.ts`, `dictation-store.ts`.

Связано:
- план `docs/plans/2026-10-29-mobile-app-plan.md`, раздел A47;
- экраны `docs/design/2026-10-31-mobile-mvp-screens.md` §9.5 (абзац «Микрофон»).

## 1. Что берём из окна, а что меняется

Как в окне:
- **Старт и стоп.** Тап по кнопке начинает запись, второй тап её останавливает.
- **Вставка.** Текст встаёт на место курсора. Если перед курсором стоит не пробел и поле не пустое, добавляется
  пробел. Ничего не отправляется.
- **Отмена.** Cancel выбрасывает запись, поле не меняется.
- **Предел.** Через 2 минуты запись сама останавливается и идёт в распознавание.
- **Одна запись на приложение.** Начать запись в другом поле — значит отменить прежнюю. Пока идёт распознавание, все
  кнопки микрофона недоступны.
- **Состояния.** Готово; запись (красная точка, полоска громкости, таймер); распознавание.
- **Send во время записи.** Отправка не происходит: запись завершается, и текст встаёт в поле
  (`finishBeforeSend` окна).
- **Поле исчезло.** Если поле закрылось, пока шло распознавание, текст кладётся в буфер обмена и показывается тост.

Отличия от окна:
- **Движок — Apple Speech на устройстве.** Whisper не используется, моделей скачивать не нужно, экрана Settings → Voice
  нет.
- **Язык — первый предпочитаемый язык устройства.** Настройки языка нет.
- **Кнопка включена всегда.** Переключателя «Voice input» нет. Если распознавание на устройстве для этого языка
  недоступно, кнопка тусклая и объясняет причину (§3.1).
- **Cancel — кнопка.** Esc и горячей клавиши на телефоне нет, поэтому отмена — кнопка в полоске записи.
- **Нет «No speech detected» по порогу громкости.** Пустую расшифровку Apple отдаёт сама; тогда показывается тост
  «No speech detected».

Звук не покидает телефон: ни на Mac, ни на серверы Apple (§2.2). Протокол, хост и мост не меняются.

## 2. Решения

### 2.1 Библиотека: `expo-speech-recognition` 58.0.1

Версия выпущена 2026-10-29 для Expo SDK 58 (dist-tag `latest`, ветка `58.x` = SDK 58). Лицензия MIT.

Почему она:
- **Тот же движок.** Внутри `SFSpeechRecognizer` и `SFSpeechAudioBufferRecognitionRequest`, то есть Apple Speech.
- **Всё нужное есть:** `requiresOnDeviceRecognition`, `continuous`, `addsPunctuation`, `iosTaskHint: 'dictation'`.
  Есть громкость (событие `volumechange`, от −2 до 10), запрос обоих разрешений (`requestPermissionsAsync`), `stop`
  с последним результатом и `abort` без результата.
- **Готовая платформенная часть.** Аудиосессия, прерывания и коды ошибок Apple уже обработаны. Свой модуль на Swift
  пришлось бы писать и проверять с нуля.
- **Плагин конфигурации** пишет `NSMicrophoneUsageDescription` и `NSSpeechRecognitionUsageDescription` нашим
  текстом.

Отвергнуты:
- **Свой модуль Expo на Swift.** Около 250 строк нативного кода со звуком, без тестов в vitest. Выигрыша против
  заплатки на три места (§2.2) нет.
- **`@react-native-voice/voice`.** Не модуль Expo и без плагина конфигурации. На устройстве нельзя запретить
  распознавание на сервере.
- **Whisper на телефоне и отправка звука на Mac** — вне задачи по условию человека.

### 2.2 Звук не уходит с телефона: заплатка библиотеки

Версия 58.0.1 включает `requiresOnDeviceRecognition` у запроса, только если распознаватель языка умеет работать на
устройстве:

```swift
// ios/ExpoSpeechRecognizer.swift, prepareRequest
if recognizer.supportsOnDeviceRecognition {
  request.requiresOnDeviceRecognition = options.requiresOnDeviceRecognition
}
```

Для языка без распознавания на устройстве библиотека **молча идёт на сервер Apple**, даже если мы просили
`requiresOnDeviceRecognition: true`. Кроме того, её `supportsOnDeviceRecognition()` проверяет распознаватель
языка по умолчанию (`SFSpeechRecognizer()`), а не того языка, который мы передаём в `start`.

Поэтому зависимость подключается с заплаткой pnpm (`pnpm patch`, ключ `pnpm.patchedDependencies` в корневом
`package.json`, файл `patches/expo-speech-recognition@58.0.1.patch`). В заплатке три правки и ничего больше:

1. **`prepareRequest`** ставит `request.requiresOnDeviceRecognition = options.requiresOnDeviceRecognition` без
   условия. Если язык не умеет работать на устройстве, задача Apple падает с ошибкой, а не идёт на сервер.
2. **`start` в `ExpoSpeechRecognitionModule.swift`** — после `resolveLocale` и до создания распознавателя:
   если `options.requiresOnDeviceRecognition` и
   `SFSpeechRecognizer(locale: locale)?.supportsOnDeviceRecognition != true`, то
   `sendErrorAndStop(error: "language-not-supported", message: "On-device recognition is not available for <lang>")`
   и выход. Звук при этом не захватывается вовсе.
3. **`supportsOnDeviceRecognition`** принимает необязательный `lang: String?`. С ним проверяется
   `SFSpeechRecognizer(locale: Locale(identifier: lang))`, без него — прежнее поведение. Тип в
   `build/ExpoSpeechRecognitionModule.types.d.ts` (или там, где объявлена функция) получает тот же необязательный
   параметр.

Тест `src/voice/patch.test.ts` читает установленные файлы библиотеки и проверяет, что все три правки на месте. Если
кто-то обновит библиотеку или снимет заплатку, тест упадёт. Если pnpm не сможет наложить заплатку на новую версию,
упадёт `pnpm install`.

Телефон зовёт `start` только с `requiresOnDeviceRecognition: true`. Без этого флага `start` не вызывается нигде:
проверка в тесте модуля движка (§4).

### 2.3 Язык

- **Источник.** `expo-localization` `~58.0.5`: `getLocales()[0]` — первый предпочитаемый язык устройства. Язык
  клавиатуры из JS не прочитать, поэтому он не учитывается (условие человека: «device/keyboard locale»).
- **Выбор.** Чистая функция `pickLocale(first, supported)`. Список `supported` берётся из
  `getSupportedLocales({}).locales`; на iOS это идентификаторы вида `ru-RU`, `en-US`.
  1. Точное совпадение `languageTag` (с заменой `_` на `-`).
  2. Иначе `languageCode-regionCode`.
  3. Иначе первый по алфавиту из `supported` с тем же `languageCode`.
  4. Иначе `null`.

  Второй и следующие языки устройства не перебираются.
- **Проверка.** `isRecognitionAvailable()` и `supportsOnDeviceRecognition(lang)` (§2.2, правка 3). Проверка идёт при
  первом показе кнопки за запуск приложения и заново при каждом возврате приложения на передний план: человек мог
  включить диктовку в Настройках. Разрешений проверка не спрашивает.

### 2.4 Разрешения

- **Тексты в `app.config.ts`.** Плагин `expo-speech-recognition` с `microphonePermission` и
  `speechRecognitionPermission`. Плагин стоит **после** `expo-camera`: у того `microphonePermission: false` удаляет
  ключ микрофона из Info.plist. Проверка — оба ключа есть в собранном `ios/Parley/Info.plist` (§6).
  - `NSMicrophoneUsageDescription`: «Parley listens only while you dictate into a message. Audio stays on this
    iPhone.»
  - `NSSpeechRecognitionUsageDescription`: «Parley turns your speech into text on this iPhone. Audio is not sent
    anywhere.»
- **Когда спрашиваются.** На первом тапе по микрофону, не при запуске. `getPermissionsAsync()`: если не выдано и
  `canAskAgain`, то `requestPermissionsAsync()` (оба разрешения разом).
- **Отказ.** Если разрешение не выдано или `restricted`, запись не начинается. Показывается `Alert`: заголовок
  «Microphone or speech recognition is off», текст «Allow both for Parley in Settings to dictate.», кнопки
  «Not now» и «Open Settings» (`Linking.openSettings()`).

## 3. Что видит человек

### 3.1 Кнопка

Одна кнопка `MicButton` в трёх местах:
1. **Поле сессии** (`src/feed/Composer.tsx`): между полем и `⬆`.
2. **Поле комнаты** (`src/app/room.tsx`): между полем и `⬆`; `@` остаётся слева.
3. **Поле Task в New session** (`src/app/new.tsx`): справа от поля, по нижнему краю.

Цель 44×44, значок SF Symbols 22 pt. В карточках вопросов, в поле письма комнаты New room и в остальных полях кнопки
нет. Если поле скрыто (`mode.kind === 'hidden'`) или выключено (`editable === false`), кнопки нет или она
недоступна — как у поля.

Состояния:

| Состояние | Значок | VoiceOver | Тап |
|---|---|---|---|
| **недоступно** — язык без распознавания на устройстве, нет распознавателя или выключена диктовка | `mic.slash`, `c.off` | «Dictation unavailable», hint — причина | тост с причиной |
| **готово** | `mic`, `c.tint` | «Dictate» | старт |
| **запись** этого поля | красная точка 12 pt (`c.danger`) | «Stop dictation» | стоп |
| **распознавание** этого поля | `ActivityIndicator` | «Transcribing» | недоступна |
| запись или распознавание **другого** поля | `mic`, `c.tint` | «Dictate» | запись: отменить ту, начать эту; распознавание: недоступна |

Причины для тоста:
- «On-device dictation isn't available for <tag>. Turn on Dictation for this language in Settings › General ›
  Keyboard.» — `pickLocale` нашёл язык, но `supportsOnDeviceRecognition(tag)` вернул `false`;
- «Dictation isn't available for <languageTag>.» — `pickLocale` вернул `null`;
- «Dictation isn't available on this iPhone right now.» — `isRecognitionAvailable()` вернул `false`.

### 3.2 Полоска записи

Пока идёт запись в это поле, над строкой поля (там же, где счётчик 16 КБ) стоит полоска:
- красная точка;
- полоска громкости 40×4 pt;
- таймер `0:07` (цифры моноширинные);
- справа текстовая кнопка «Cancel» (цель 44 pt по высоте).

Пока идёт распознавание, в полоске «Transcribing…», Cancel нет.

Громкость `volumechange`, приходит раз в 100 мс: `level = clamp(value, 0, 10) / 10`. Значения ≤ 0 библиотека
называет неслышимыми.

### 3.3 Результат

- **Стоп** (тап, Send или 2 минуты): `stop()`, затем ждём событие `end`, но не дольше 10 с. Собранный текст встаёт в
  поле.
- **Сборка текста.** Берутся результаты с `isFinal: true` и непустым `results`. Из каждого — `results[0].transcript`
  без пробелов по краям; куски склеиваются через один пробел. Пустые результаты пропускаются: на iOS 18+ библиотека
  отдаёт финальный пустой результат после последнего куска.
- **Пусто** — тост «No speech detected», поле не меняется.
- **Вставка.** `spliceTranscript(value, caret, text)` — перенос `insert.ts` окна без изменений. Курсор:
  - если в начале записи поле было в фокусе — это его `selection.start` (последнее значение `onSelectionChange`);
  - иначе — конец текста.

  После вставки поле в фокусе, курсор стоит за вставкой (`setSelection`), если поле было в фокусе в начале записи.
- **Поле исчезло** (экран закрыт во время распознавания) — `Clipboard.setStringAsync(text)` и тост «Transcript
  copied to clipboard».
- **Экран закрыт во время записи** — `abort()`, ничего не вставляется.
- **Приложение ушло в фон или сработала блокировка приложения** во время записи — `abort()`, ничего не вставляется.
  Во время распознавания результат ждётся как обычно.

### 3.4 Ошибки

| Событие `error` библиотеки | Что видит человек |
|---|---|
| `not-allowed` | Alert отказа из §2.4 |
| `language-not-supported` | тост с причиной из §3.1; кнопка переходит в «недоступно» до следующей проверки |
| `no-speech`, `nomatch` (событие) | тост «No speech detected» |
| `audio-capture` | тост «Microphone is busy» |
| `interrupted` (звонок, Siri, будильник) | запись выброшена, тост «Dictation was interrupted» |
| `aborted` после нашей отмены | ничего |
| остальное, таймаут 10 с ожидания `end` | тост «Dictation failed» |

Тосты — существующий `useToast`/`Toast` экрана.

## 4. Устройство

Новая папка `packages/mobile/src/voice/`:
- **`insert.ts`** — `joinTranscript` и `spliceTranscript`, копия `insert.ts` окна (те же тесты).
- **`locale.ts`** — `pickLocale`.
- **`level.ts`** — `levelOf(value)`.
- **`transcript.ts`** — `assembleTranscript(results)`.
- **`elapsed.ts`** — `formatElapsed(ms)`, как в окне.
- **`dictation.ts`** — хранилище диктовки приложения (через `useSyncExternalStore`, как хранилище черновиков A45).
  - **Состояние:** `{ phase: 'idle' | 'starting' | 'recording' | 'transcribing', targetId, level, startedAt,
    availability }`.
  - **Действия:** `register(target)`, `toggle(id)`, `cancel()`, `finishBeforeSend(id)`, `refreshAvailability()`,
    `onBackground()`.
  - **Цель** (`DictationTarget`): `{ id, remember(): void, insert(text): void }`.
  - **Номер попытки.** Отмена во время старта или стопа делает результат прежней попытки чужим (как `session` в
    окне).
  - **Зависимости через `configure(deps)`:** движок, разрешения, `toast`, `alert`, `copy`, таймеры, `now`. Так тесты
    подставляют свои.
- **`engine.ts`** — единственное место, где импортируется `expo-speech-recognition`. Тонкая обёртка: `start(lang)`
  всегда с параметрами
  `{ lang, requiresOnDeviceRecognition: true, continuous: true, interimResults: false, addsPunctuation: true,
  iosTaskHint: 'dictation', volumeChangeEventOptions: { enabled: true, intervalMillis: 100 } }`; `stop`, `abort`,
  подписки на `result`, `error`, `end`, `nomatch`, `volumechange`.
- **`use-dictation-target.ts`** — хук поля. Принимает `id`, ref на `TextInput`, текущее значение и `apply(value)`.
  Отслеживает `onSelectionChange` и фокус, регистрирует цель и снимает её при размонтировании.
- **`MicButton.tsx`** и **`DictationStrip.tsx`** — §3.1 и §3.2.

Поля: `Composer.tsx`, `room.tsx`, `new.tsx` подключают хук, кнопку и полоску. ⬆ и `chat.send()` сначала зовут
`finishBeforeSend(id)`: если вернулось `true`, отправки нет. Идентификаторы целей: `session:<ref>`, `room:<id>`,
`new-session-task`.

Разработческий движок. При `PARLEY_MOBILE_DEV_VOICE=fake` (как `DEV_DEMO`, только при `__DEV__`, через
`extra.devVoice`) `engine.ts` подменяется поддельным:
- громкость — синус;
- после `stop` приходит текст «This is a dictated test sentence.»;
- доступность и разрешения — «выдано».

Он нужен для снимков и проверки на симуляторе. В release-варианте его нет.

## 5. Приватность

- **Звук не уходит с устройства.** Распознавание только на устройстве; сервер Apple исключён заплаткой (§2.2).
- **Звук не сохраняется.** Запись в файл не включается (`recordingOptions` не передаётся).
- **Расшифровка нигде не хранится,** кроме поля, куда встала, и буфера обмена в случае из §3.3.
- **Мост и хост ничего нового не получают.** Текст уходит, только когда человек сам нажмёт ⬆.

## 6. Проверка и приёмка

Тесты vitest (`packages/mobile`):
1. **`insert`** — те же случаи, что `insert.test.ts` окна.
2. **`pickLocale`** — точное совпадение, `_`, язык+регион, только язык, нет языка, пустой список.
3. **`levelOf`, `assembleTranscript`, `formatElapsed`.** У `assembleTranscript` — куски с пробелом спереди
   (iOS 18), пустой финальный результат, не финальные результаты.
4. **`dictation`** с поддельными зависимостями:
   - старт и стоп со вставкой; позиция курсора — фокус и без фокуса;
   - Cancel;
   - 2 минуты — автостоп со вставкой;
   - вторая цель отменяет первую;
   - во время распознавания `toggle` не действует;
   - `finishBeforeSend` в записи, в распознавании и без записи;
   - поле снято во время распознавания — буфер обмена и тост; поле снято во время записи — `abort`;
   - фон — `abort`;
   - отказ в разрешении — Alert, `start` не вызывается; `canAskAgain` — запрос;
   - каждая ошибка таблицы §3.4;
   - таймаут 10 с;
   - отмена во время `starting` — результат старта выброшен;
   - `availability`: недоступно → тап даёт тост с причиной, `start` не вызывается.
5. **`engine`** — `start` всегда с `requiresOnDeviceRecognition: true` и `continuous: true`. Модуль библиотеки
   подменяется через `vi.mock`.
6. **`patch.test.ts`** — три правки §2.2 на месте в установленной библиотеке.

Сборка и конфиг:
- `pnpm --filter @parley/mobile typecheck`, тесты, корневой `pnpm lint` — зелёные;
- `expo prebuild` проходит; в `ios/Parley/Info.plist` есть оба ключа с текстами §2.4;
- `Podfile.lock` содержит `ExpoSpeechRecognition` и `ExpoLocalization`.

Снимки на симуляторе (поддельный движок), светлая и тёмная тема, в `docs/audits/2026-11-04/screens-A47/`:
- поле сессии: готово, запись, распознавание, недоступно (тост);
- поле комнаты: запись;
- New session: запись.

На iPhone (человек) — в «Not verified», пока не проверено:
- первая диктовка спрашивает оба разрешения, текст встаёт в поле;
- русский и английский язык устройства;
- две фразы с паузой — обе в тексте по одному разу;
- авиарежим — диктовка работает (звук не нужен сети);
- отказ в разрешении → Open Settings;
- 2 минуты — автостоп.

## 7. Файлы

- `package.json` (корень): `pnpm.patchedDependencies`;
- `patches/expo-speech-recognition@58.0.1.patch`;
- `pnpm-lock.yaml`;
- `packages/mobile/package.json`: `expo-speech-recognition` `58.0.1` (точная версия, под заплатку) и
  `expo-localization` `~58.0.5`;
- `packages/mobile/app.config.ts`: плагин и тексты, `extra.devVoice`;
- `packages/mobile/src/dev/flags.ts`: `DEV_VOICE`;
- `packages/mobile/src/voice/*` (новые) и тесты;
- `packages/mobile/src/feed/Composer.tsx`, `src/app/session/[ref].tsx` (если `Composer` нужен `id` цели),
  `src/app/room.tsx`, `src/app/new.tsx`;
- `docs/specs/2026-11-04-mobile-voice-input-design.md` (эта спека),
  `docs/plans/2026-10-29-mobile-app-plan.md` (раздел A47),
  `docs/design/2026-10-31-mobile-mvp-screens.md` (§9.5, ссылка).

## 8. Вне задачи

- Whisper на телефоне, отправка звука на Mac, распознавание на сервере Apple.
- Настройка языка и перебор нескольких языков устройства.
- Микрофон в карточках вопросов, в письме New room, в терминале.
- Горячие клавиши (внешняя клавиатура).
- Android, Windows, Live Activity.
- Протокол, хост, мост.
