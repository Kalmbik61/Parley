# Голосовой ввод: локальный Whisper

Дата: 2026-10-06. Статус: дизайн согласован в брейншторме 2026-10-06. Спека ждёт ревью пользователя, после него будет план реализации.

Связано:
- TODOS, пункт 17 «Голосовой ввод» — эта спека его заменяет;
- разведка `docs/research/2026-10-06-voice-input-spike.md`: `/voice` Claude Code годится только для сессий Claude на логине claude.ai, у Codex CLI диктовки нет. Поэтому — свой локальный движок.

## 1. Зачем

Человек нажимает микрофон в любом поле ввода Parley и говорит. Текст встаёт в поле, а отправляет его человек сам. Голос работает одинаково для Claude, GLM и Codex, в комнате, в чате и в терминале сессии.

Распознаёт whisper.cpp на машине человека. Звук никуда не уходит; токенов, API и аккаунтов нет. Рамка проекта не задета.

Голос нужен не всем, поэтому он выключен по умолчанию. Пока человек его не включил, ничего не скачивается и доступ к микрофону не запрашивается.

## 2. Решения брейншторма

| # | Вопрос | Решение |
|---|---|---|
| 1 | Движок | Только локальный Whisper. Без `/voice` CLI, без API по ключу, без выбора «Transcription provider» из TODOS 17 |
| 2 | Как запускать | Программа `whisper-cli` из whisper.cpp внутри .app, главный процесс запускает её на каждую запись. Нативный модуль Node и WebGPU в окне отвергнуты |
| 3 | Где движок | В приложении (несколько МБ на архитектуру). Модели качаются только после включения голоса |
| 4 | Запись | Клик по кнопке — старт и стоп, Esc — отмена, горячая клавиша ⌘⇧M делает то же самое |
| 5 | Модели | Короткий список из трёх: base, small, large-v3-turbo q5_0 |
| 6 | Язык | Настройка, по умолчанию Auto |
| 7 | Пока голос выключен | Тусклая кнопка микрофона, клик открывает Settings → Voice. Горячая клавиша не действует |

## 3. Что видит человек

### 3.1 Settings → Voice

Новая вкладка в `SettingsDialog`, после «Notifications». Все надписи по-английски, в `shared/strings.ts`.

- **Voice input** — переключатель, по умолчанию выключен. Включить можно только при скачанной модели. До этого под переключателем подсказка «Download a model first».
- **Model** — три строки. В каждой название, размер, подпись о качестве и скорости и кнопки «Download» / «Delete». Пока идёт скачивание — прогресс в процентах и мегабайтах и кнопка «Cancel». Выбранная модель отмечена, выбрать можно только скачанную.
- **Language** — выпадающий список: «Auto», «English», «Russian», затем остальные языки Whisper по алфавиту. По умолчанию «Auto».
- **Shortcut** — строка только для чтения: «⌘⇧M». Переназначения пока нет (раздел 12).

| Модель | Файл | Размер | Подпись |
|---|---|---|---|
| Base | `ggml-base.bin` | ~142 МБ | «Fastest. Weak for Russian.» |
| Small | `ggml-small.bin` | ~466 МБ | «Good balance.» |
| Large v3 Turbo (Q5) | `ggml-large-v3-turbo-q5_0.bin` | ~547 МБ | «Best quality. Recommended on Apple Silicon.» |

Источник — `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<файл>`. Размеры и sha256 закрепляются в коде (раздел 9, этап 0).

### 3.2 Кнопка микрофона

Одна кнопка `MicButton` в четырёх местах:
1. поле комнаты (`components/rooms/Composer.tsx`);
2. поле чата сессии (`chat/Composer.tsx`);
3. поле первого промпта в диалоге «New workspace» (`sidebar/NewWorkComposer.tsx`). В TODOS 17 стоял диалог «New session or room», но поля для текста в нём больше нет: задачу пишут уже в терминале или в комнате;
4. панель вида Terminal сессии — `ChatToolbar` с `view="terminal"` (`layout/bodies/TerminalBody.tsx`). Эта панель есть только у сессий с лентой (`hasFeed`). У сессий без ленты (сейчас Codex) кнопки в терминале нет, диктовка там — только горячей клавишей (раздел 3.4).

Состояния:
- **голос не настроен** (выключен или нет модели): кнопка тусклая, подсказка «Set up voice input», клик открывает Settings → Voice;
- **готово**: обычный значок микрофона, подсказка «Dictate (⌘⇧M)»;
- **запись**: красная точка, полоска громкости, таймер `0:07`. Клик или ⌘⇧M — стоп, Esc — отмена;
- **распознавание**: спиннер и «Transcribing…». Кнопка недоступна.

### 3.3 Запись и результат

- Первая запись: если macOS ещё не спрашивала доступ к микрофону, окно запрашивает его. Системный диалог показывает свой текст Parley (раздел 4.3).
- Стоп — текст встаёт на место курсора, курсор переходит в конец вставки. Если перед вставкой нет пробела и поле не пустое, пробел добавляется. Ничего не отправляется.
- В виде Terminal текст уходит в PTY вставкой без Enter: `sendToAgent(bridge, ref, text, false)` из `terminal/send.ts`.
- Esc во время записи — всё выбрасывается, поле не меняется.
- Через 2 минуты запись сама останавливается и идёт в распознавание.
- Одновременно идёт одна запись на окно. Если начать новую, прежняя отменяется.

### 3.4 Горячая клавиша

Действие `voice.toggle` в реестре `shared/keybindings.ts`, по умолчанию `CmdOrCtrl+Shift+M`, в палитре — «Toggle dictation».

Работает там, где сейчас фокус:
- в поле с кнопкой микрофона — диктовка в это поле;
- в терминале сессии — диктовка в её PTY.

В других местах, а также пока голос не настроен, нажатие ничего не делает и не гасится.

## 4. Устройство

### 4.1 Окно: `renderer/voice/`

- **`recorder.ts`** — захват микрофона:
  - `getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })`;
  - `AudioContext({ sampleRate: 16000 })` и AudioWorklet;
  - копит PCM Int16 моно 16 кГц и раз в кадр отдаёт громкость (RMS) для полоски;
  - отдельно хранит пик громкости — для порога тишины (раздел 6.1);
  - `stop()` возвращает `{ pcm: ArrayBuffer, durationMs, peak }`, `cancel()` всё выбрасывает.
- **`level.ts`** — чистые функции RMS и порога тишины, без DOM.
- **`dictation-store.ts`** — общий store: какая цель записывает сейчас (`targetId`) и в каком состоянии (`idle | recording | transcribing`). Это и гарантирует одну запись на окно.
- **`use-dictation.ts`** — хук для цели. Принимает `targetId` и `insert(text)`, отдаёт `state`, `level`, `elapsedMs`, `toggle()`, `cancel()`. Esc ловит, пока идёт запись.
- **`MicButton.tsx`** — кнопка из раздела 3.2. Не знает, куда вставлять: это передаёт место.
- **Цели вставки.** Поля вставляют текст на место курсора в своём `textarea` и обновляют своё состояние. Терминал вызывает `sendToAgent(..., false)`.
- **Горячая клавиша.** `keys/handler.ts` по `voice.toggle` находит активную цель через `focus-context.ts` и зовёт её `toggle()`.
- **Настройки** — раздел `voice` в `ui.json`, через `store/ui.ts`, как Appearance и Notifications:

  ```ts
  interface VoiceUi {
    enabled: boolean;          // по умолчанию false
    model: VoiceModelId | null; // 'base' | 'small' | 'large-v3-turbo-q5_0'
    language: string;          // 'auto' | код Whisper ('en', 'ru', …), по умолчанию 'auto'
  }
  ```

  `normalizeUi` в `shared/ui-types.ts` дополняет старый `ui.json` значениями по умолчанию.

### 4.2 Главный процесс: `main/voice/`

- **`models.ts`** — каталог и файлы моделей:
  - каталог из трёх записей: `id`, файл, URL, размер в байтах, sha256;
  - папка `~/.parley/desktop/voice/models/` — рядом с `ui.json` и `drops`, от `parleyHome()` (в E2E это `PARLEY_HOME`);
  - `list()` — скачанные модели;
  - `download(id)` — `net.fetch` в `<файл>.part`, события прогресса, затем проверка sha256 и переименование в `<файл>`;
  - `cancel(id)` — прерывает скачивание и удаляет `.part`;
  - `remove(id)` — удаляет файл модели.
- **`transcribe.ts`** — распознавание:
  1. принимает `{ pcm, language, model }` и пишет `parley-voice-<random>.wav` в `os.tmpdir()` с правами `0600` — заголовок WAV PCM 16 бит, 16 кГц, моно;
  2. запускает движок — `whisper-cli -m <модель> -f <wav> -l <язык|auto> -nt -np --vad -vm <модель VAD>`; точные флаги сверяются в этапе 0;
  3. собирает stdout, обрезает пробелы и пропускает через фильтр результата (раздел 6.1);
  4. удаляет WAV в `finally` — и после успеха, и после ошибки;
  5. таймаут — 60 с плюс длина записи, по нему процесс убивается.
- **`engine.ts`** — путь к движку:
  - упакованная сборка: `process.resourcesPath/whisper/bin/whisper-cli` и `process.resourcesPath/whisper/ggml-silero-*.bin`;
  - dev без сборки: `whisper-cli` из PATH (`brew install whisper-cpp`) и модель VAD из `build/whisper/`. Так же устроен поиск node в `host-launcher.ts`;
  - нет движка — ошибка `engine_missing`.
- **`mic.ts`**:
  - `status()` — `systemPreferences.getMediaAccessStatus('microphone')`;
  - `request()` — `systemPreferences.askForMediaAccess('microphone')`;
  - `openSettings()` — `shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')`.
- **Уборка при старте.** Окно удаляет оставшиеся в `os.tmpdir()` файлы `parley-voice-*.wav`.
- **IPC** — по образцу остальных вызовов `ParleyBridge` (`shared/bridge.ts`, `main/ipc.ts`, `preload/index.ts`):
  - `voice.models.list`, `voice.models.download`, `voice.models.cancel`, `voice.models.remove`;
  - событие `voice.models.progress` (`{ id, receivedBytes, totalBytes }`);
  - `voice.transcribe` → `{ text } | { error: VoiceError }`;
  - `voice.mic.status`, `voice.mic.request`, `voice.mic.openSettings`.

Путь данных: микрофон → `recorder` (PCM) → IPC `voice.transcribe` → WAV → `whisper-cli` → текст → фильтр → IPC → вставка в поле или в PTY.

### 4.3 Сборка и релиз

- **`packages/desktop/scripts/fetch-whisper.mjs`** — по образцу `fetch-node.mjs`:
  1. скачивает исходник whisper.cpp на закреплённом теге и сверяет его sha256;
  2. собирает `whisper-cli` через cmake. Для arm64 — `-DCMAKE_OSX_ARCHITECTURES=arm64 -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON`. Для x64 — `-DCMAKE_OSX_ARCHITECTURES=x86_64 -DGGML_METAL=OFF` (CPU с Accelerate). В обоих случаях `-DBUILD_SHARED_LIBS=OFF`, чтобы бинарь был без внешних dylib;
  3. скачивает модель VAD Silero и сверяет её sha256;
  4. кладёт всё в `build/whisper/darwin-<arch>/`: `bin/whisper-cli`, `ggml-silero-*.bin`, `LICENSE` whisper.cpp и лицензию Silero.
- **`electron-builder.yml`:**
  - `extraResources` копирует `build/whisper/darwin-${arch}` в `whisper`, как встроенный node. Если каталога нет, сборка только предупреждает, а движок берётся из PATH;
  - `mac.extendInfo.NSMicrophoneUsageDescription`: «Parley uses the microphone for voice dictation. Audio is transcribed on this Mac and never leaves it.»
- **`.github/workflows/release.yml`** запускает `fetch-whisper` для обеих архитектур рядом с `fetch-node`.
- **`NOTICE`**: whisper.cpp и ggml (MIT), Silero VAD (MIT).
- **`scripts/release/verify-packaged-apps.sh`** проверяет, что `Contents/Resources/whisper/bin/whisper-cli` на месте и `--help` отвечает кодом 0.
- **README:** раздел о голосовом вводе — как включить, где лежат модели, что разрешение на микрофон может сброситься после обновления.

## 5. Рамка и приватность

- Распознавание локальное: в сеть уходят только скачивания моделей с Hugging Face, когда человек нажимает «Download».
- Запись живёт в памяти окна до стопа, потом во временном WAV до конца распознавания. Ни звук, ни расшифровка не сохраняются нигде, кроме поля, куда вставлен текст.
- В CLI агентов ничего не меняется: голос вводит текст так же, как клавиатура.

## 6. Ошибки и крайние случаи

### 6.1 Тишина и галлюцинации

1. **Порог в окне.** Если пик громкости за запись ниже порога, движок не вызывается, а человек видит toast «No speech detected». Порог подбирается в этапе 0.
2. **VAD в движке** вырезает куски без речи до распознавания.
3. **Фильтр результата** в `transcribe.ts` выдаёт «No speech detected», если результат пустой или после нормализации (регистр, пробелы, точки и многоточия) целиком состоит из:
   - служебных меток в квадратных или круглых скобках: `[BLANK_AUDIO]`, `[Музыка]`, `(музыка)`;
   - фразы из короткого списка известных галлюцинаций: «Продолжение следует», «Субтитры сделал DimaTorzok», «Субтитры создавал DimaTorzok», «Редактор субтитров А.Синецкая Корректор А.Егорова», «Thank you for watching», «Thanks for watching».

   Совпадение — только со всем результатом. Фраза, где эти слова — часть текста, проходит.

### 6.2 Модели

- Перед скачиванием `fs.statfs` проверяет место: нужно размер модели плюс 10 %. Если не хватает — «Not enough disk space (need N MB)».
- Обрыв сети, ответ не 200 или «Cancel» — `.part` удаляется. Сообщение «Download failed» (при отмене — без сообщения), «Download» снова активна. Докачки нет.
- sha256 не совпал — файл удаляется, «Download corrupted. Try again.»
- Удалили выбранную модель: выбор переходит на другую скачанную, если она есть, иначе `enabled = false`.
- Выбранного файла нет при распознавании (удалён вручную) — toast «Voice model is missing» с кнопкой «Open settings».

### 6.3 Микрофон

- `not-determined` — `voice.mic.request`. Отказ — как `denied`.
- `denied` или `restricted` — toast «Microphone access denied» с кнопкой «Open System Settings».
- `getUserMedia` упал (`NotFoundError`, `NotReadableError`) — «No microphone found».
- Сборка без подписи Apple может потерять разрешение после обновления. Тогда macOS спросит снова; это написано в README.

### 6.4 Распознавание

- Нет движка — «Voice engine not found».
- Ненулевой код выхода — «Transcription failed», stderr уходит в лог главного процесса.
- Таймаут — процесс убивается, сообщение то же, «Transcription failed».
- Пока идёт распознавание, новая запись не начинается ни в одной цели: кнопки недоступны. Распознавание длится 1–3 с, а одна очередь проще двух.

### 6.5 Цель исчезла

Поле или терминал закрылись, пока шло распознавание. Текст кладётся в буфер обмена (`navigator.clipboard.writeText`), и появляется toast «Transcript copied to clipboard». Цель считается исчезнувшей, если её `targetId` снят с регистрации в `dictation-store`.

## 7. Совместимость и откат

- Старый `ui.json` без раздела `voice` дополняется значениями по умолчанию (`enabled: false`), то есть голос выключен.
- Откат версии: раздел `voice` в `ui.json` старая версия просто не читает. Модели остаются в `~/.parley/desktop/voice/models/`, их можно удалить руками; путь указан в README.
- Протокол хоста не меняется: всё живёт в окне и главном процессе.

## 8. Проверка

**Модульные тесты (vitest), рядом с кодом:**
- `models`:
  - прогресс и переименование после верного sha256;
  - `.part` удалён после отмены и после обрыва;
  - ошибка при несовпадении sha256;
  - ошибка при нехватке места;
  - переход выбора после удаления модели.

  Всё на подменённом `fetch` и временной папке.
- `transcribe`:
  - байты WAV-заголовка;
  - аргументы движка для `auto` и `ru`;
  - фильтр: выкидывает метки и галлюцинации целиком, но не трогает фразу, где эти слова — часть текста;
  - таймаут и ненулевой код на подменённом `spawn`;
  - WAV удалён во всех исходах.
- `engine`: упакованный путь, PATH и `engine_missing`.
- `level`: RMS и порог тишины.
- `use-dictation` и `dictation-store`:
  - переходы состояний;
  - одна запись на окно, новая отменяет прежнюю;
  - Esc отменяет;
  - исчезнувшая цель отдаёт текст в буфер.
- `MicButton`: четыре состояния; тусклая кнопка открывает Settings → Voice.
- Вкладка Voice:
  - без скачанной модели переключатель недоступен;
  - прогресс и Cancel;
  - выбор только среди скачанных.
- `english-ui.test.ts` проходит с новыми строками.
- Реестр клавиш: у `voice.toggle` нет конфликта сочетаний.
- Релизные тесты:
  - `fetch-whisper.test.ts` (тег и sha256 закреплены, аргументы cmake по архитектурам);
  - `release-config.test.ts` (`extraResources`, `extendInfo`);
  - `notice.test.ts` (whisper.cpp, Silero);
  - `verify-packaged-apps.test.ts` (проверка `whisper-cli`).

**E2E (Playwright):**
- Микрофон подменяется флагом Chromium `--use-fake-device-for-media-stream` (тон вместо голоса) в аргументах запуска окна.
- Переключатель `PARLEY_VOICE=fake` (`test-switches.ts`, только в неупакованном окне) подменяет службы main: модели «скачиваются» сразу, доступ к микрофону есть, распознавание отдаёт `PARLEY_VOICE_TEXT`. Движок не нужен.
- Сценарии:
  1. голос выключен — клик по тусклой кнопке открывает вкладку Voice;
  2. запись в поле комнаты — после стопа текст стоит в поле и **не отправлен**;
  3. Esc во время записи — поле без изменений;
  4. ⌘⇧M в поле чата — то же, что клик.

**Проба на настоящем движке** (`voice-engine.live.test.ts`): пропускается, если нет `whisper-cli` или модели.
- Готовит фразы командой `say`: английскую и русскую (голос Milena), с переводом в 16 кГц моно.
- Проверяет, что в тексте есть ключевые слова, и пишет время распознавания на base и turbo.
- Запускается локально перед релизом.

**Упакованное приложение:** обе архитектуры. Сборку x64 запускаем на M4 Pro под Rosetta — это замер медленного пути без Metal.

**Живая проверка с пользователем:**
- настоящий микрофон, русская речь, все четыре места;
- окно 800×500 с длинными путями и названиями;
- системный запрос на микрофон при первой записи;
- задержка на turbo.

## 9. Этап 0: проверить до кода (первая задача плана)

1. Выбрать тег whisper.cpp и закрепить sha256 исходника. Собрать `whisper-cli` под arm64 с Metal и под x64 на этой машине, записать размер бинарей.
2. Сверить флаги `whisper-cli` в выбранной версии: язык, без таймстемпов, без служебного вывода, `--vad` и путь к модели VAD. Проверить, что stdout содержит только текст.
3. Скачать три модели и модель VAD, закрепить размеры и sha256 в каталоге.
4. Замерить задержку на фразах из `say` длиной 5, 15 и 60 с: base, small и turbo на arm64, small на x64 под Rosetta. Проверить русский на small и turbo.
5. Проверить в Electron окна Parley: `AudioContext({ sampleRate: 16000 })` и AudioWorklet при текущем CSP; системный запрос на микрофон от имени Parley в упакованной сборке.
6. Подобрать порог тишины по пику громкости: пустая запись против тихой речи.

Результаты — в план реализации и в эту спеку, если что-то из них меняет решения.

## 10. Критерии приёмки

1. Голос выключен по умолчанию. Пока он не включён, модели не скачиваются, macOS не спрашивает доступ к микрофону, а кнопка микрофона тусклая и ведёт в Settings → Voice.
2. В Settings → Voice скачиваются, отменяются и удаляются три модели, видны прогресс и проверка целостности. Включить голос без модели нельзя.
3. Во всех четырёх местах клик или ⌘⇧M начинает и заканчивает запись, Esc отменяет её. В терминале сессии без ленты работает ⌘⇧M. Текст встаёт в поле или в PTY и не отправляется.
4. Русская фраза в 10–15 с на turbo превращается в текст на M4 Pro не дольше чем за 3 с после стопа. Пустая запись даёт «No speech detected», а не галлюцинацию.
5. Все ошибки из раздела 6 выводятся toast'ом с текстом из раздела 6. Окно не падает.
6. Упакованные сборки arm64 и x64 содержат `whisper-cli`, и голос работает в обеих (x64 проверена под Rosetta).
7. Модульные тесты, E2E и релизные тесты зелёные. Проба на настоящем движке проходит локально.

## 11. Файлы

Новые:
- `packages/desktop/src/renderer/voice/`: `recorder.ts`, `level.ts`, `dictation-store.ts`, `use-dictation.ts`, `MicButton.tsx`, AudioWorklet-процессор и тесты;
- `packages/desktop/src/main/voice/`: `models.ts`, `transcribe.ts`, `engine.ts`, `mic.ts` и тесты;
- `packages/desktop/scripts/fetch-whisper.mjs` и `packages/desktop/src/fetch-whisper.test.ts`;
- `packages/desktop/e2e/` — сценарии голоса и фикстура WAV.

Меняются:
- `packages/desktop/src/shared/ui-types.ts` (`voice`, `normalizeUi`), `shared/strings.ts`, `shared/keybindings.ts`, `shared/bridge.ts`;
- `packages/desktop/src/main/ipc.ts`, `main/index.ts` (уборка WAV), `main/test-switches.ts`, `preload/index.ts`;
- `packages/desktop/src/renderer/components/settings/SettingsDialog.tsx` (вкладка Voice);
- `packages/desktop/src/renderer/components/rooms/Composer.tsx`, `chat/Composer.tsx`, `sidebar/NewWorkComposer.tsx`, `chat/ChatToolbar.tsx` (кнопка в виде Terminal), `layout/bodies/TerminalBody.tsx` (цель вставки для горячей клавиши);
- `packages/desktop/src/renderer/keys/handler.ts`, `palette/actions.ts`;
- `packages/desktop/electron-builder.yml`, `.github/workflows/release.yml`, `scripts/release/verify-packaged-apps.sh`;
- `NOTICE`, `README.md`, `TODOS.md` (пункт 17 → ссылка на эту спеку).

## 12. Вне подпроекта

- Потоковое распознавание с текстом по ходу речи и `whisper-server` с моделью в памяти. Это следующий шаг, если задержка из раздела 10 не выполнится.
- `/voice` Claude Code, API по ключу, «Transcription provider».
- Переназначение горячей клавиши, удержание (push-to-talk).
- Докачка моделей, свои модели, модели помимо трёх из каталога.
- Подсказки распознаванию: имя проекта, ветка, словарь.
- Linux и Windows.
