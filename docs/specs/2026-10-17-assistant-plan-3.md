# Помощник на острове — план этапа 3: голос и лицо

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** помощник говорит ответы вслух голосом macOS `say` на языке настроек; когда ответ дописан, рой становится лицом с эмоцией из метки ответа и ртом, который двигается по реальной громкости, — ровно так, как в одобренном макете.

**Architecture:** синтез — в main окна (`main/assistant/tts.ts`: `say` → WAV во временный файл в `~/.parley/assistant/tts/`, чтение, удаление), остров получает байты по IPC и играет их через WebAudio (`renderer/island/assistant/speaker.ts`, `AnalyserNode` даёт громкость рта). Ответ режется на предложения по мере прихода (`speech-queue.ts`), первое звучит, пока модель пишет дальше. Речь — состояние ввода острова (`InputPhase` получает `speaking` и `settling`), протокол хоста не меняется: эмоция уже приходит в `AssistantState.mood`. Лицо, эмоции и всё поведение речи — из одобренного макета `island-mockup.html`: таблица `EMO`, `DUR`, функции `face`/`blink`/`flash` переносятся в Canvas 2D-движок (`swarm/engine.ts`) дословно, новая форма `face` в `swarm/spec.ts`; порядок состояний — по сценариям макета `finish`/`speak`/`decide`/`hotkey`/`esc`/`tuck`: ответ стримится сферой, **лицо говорит после ответа**, затем сфера «Done» 1 с.

**Tech Stack:** Electron 44 (main: `child_process`, `say`), WebAudio (`AudioContext`, `decodeAudioData`, `AnalyserNode`), `Intl.Segmenter`, React 18, zustand, vitest + jsdom, Playwright `_electron` со стабом `e2e/stub-assistant-agent.mjs` и подменой `PARLEY_TTS=fake`.

**Spec:** `docs/specs/2026-10-14-assistant-design.md` — разделы 6.1 (настройки `assistant.speak`, `assistant.voice`), 8.2 (виды и кадры), 9 (лицо: эмоции, тайминги, моргание, бюджет), 10 (голос), 12 (проверки). Эталон лица **и взаимодействия** — `docs/specs/assets/2026-10-14-assistant/island-mockup.html` (строки 246–257 таблица `EMO` и `DUR`, 280–350 `setSpec`/`face`/`blink`/`frame`, 376–386 `SPEC`/`specFor`/`LABEL`/`MINI`, 449–473 сценарии `speak`/`finish`/`decide`/`hotkey`/`esc`/`tuck`). Разведка кода — отчёт `recon-stage3` 2026-10-17; номера строк ниже — из него, по master после PR #71.

## Global Constraints

- Тексты UI только по-английски и только в `packages/desktop/src/shared/strings.ts`; комментарии, тесты, документы — по-русски. Исключение этого плана: **озвучиваемые шаблонные фразы** («Sent» / «Отправил») лежат в `renderer/island/assistant/spoken.ts` на языках помощника — это речь помощника на языке человека, как и его ответы, а не интерфейс.
- Страж `english-text` в core: в `core/src/assistant/text.ts` русские буквы только в комментариях.
- Parley пишет только в свои каталоги: WAV и файл текста для `say` — в `~/.parley/assistant/tts/` (`assistantCwd()` из core), права 0600, удаление в `finally`, устаревшие файлы подчищаются при старте.
- Никаких `secrets.json`, `ANTHROPIC_AUTH_TOKEN`, `--dangerously-*`; `CLAUDECODE` не трогать; новых зависимостей нет.
- Кадры роя — только по таблице 8.2: большой вид 60 fps, мини при занятом помощнике 30 fps (`speaking` и `settling` — занятость), свободный 0. Лицо идёт на тех же 700 душах большого вида; в мини лица нет — сфера.
- Протокол хоста (`AssistantState`, `AssistantPhase`) не меняется; `speaking`/`settling` живут в острове.
- **Макет — источник эмоций и взаимодействия** (решение человека 2026-10-17). Числа таблицы `EMO`, `DUR`, тайминги моргания, вспышки, короны и переходов — из `island-mockup.html` без изменений; порядок состояний речи — из его сценариев. Где спека 10 расходится с макетом (перечислено в «Из макета»), действует макет. Отклонения от макета — только из списка «Решения» ниже.
- Один seed — один кадр: моргание и всё случайное в лице — из детерминированного генератора движка, не из `Math.random`.
- eslint: нет игнора `_x`, `prefer-const`, плагина react-hooks нет; `LC_ALL=C` для тестов; E2E 800×500 с длинными именами; собранное приложение локально не запускать.
- Коммит на задачу, сообщение по-русски, подпись `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; исполнители не запускают vitest/tsc/eslint/сборку и не коммитят.

## Из макета (не решения — так в одобренном прототипе; где спека 10 говорит иначе, действует макет)

- **Лицо после ответа** (`finish`, подпись переключателя макета — «answer ends in a face»): ответ стримится сферой с потоком (`answering`), и только когда он дописан, рой складывается в лицо и говорит весь ответ. Спека 10 («первое предложение звучит, пока модель пишет») уступает макету: предложения **синтезируются** по мере прихода, а **играют** после конца ответа — задержки нет, порядок как в макете. GLM и Codex отдают текст сразу целиком — у них тот же путь.
- **После речи** — `settle`: сфера `rot 0.3`, подпись «Done» (в мини тоже «Done»), 1000 мс, затем `idle` и обычный таймер 8 с.
- **Карточка** (`decide`): озвучивается только «Отправил» / «Sent» — лицом, через 900 мс после появления исхода (`if (A.spk && ok)`); отмена не озвучивается; текст предложения на карточке не озвучивается (`fProp` без `speak`). Спека 10 («Отменил / Cancelled») уступает макету.
- **Ошибки не озвучиваются**: `error` — коралловая сфера с глитчем и подпись, без лица и без речи. Спека 10 («ошибки из 6.6» голосом) уступает макету.
- **Хоткей и кнопка микрофона во время речи** (`hotkey` при `BUSY`; `#mic.onclick = hotkey`): ничего не обрывают и не пишут — только раскрывают свёрнутый остров. Спека 10 («хоткей обрывает речь и начинает слушать») уступает макету. Так микрофон никогда не пишет голос помощника.
- **Esc во время речи** (`esc`): речь обрывается, сразу `idle` (без `settle`), остров — в пилюлю.
- **Стрелка ⌃ во время речи** (`tuck`): остров сворачивается в мини, речь продолжается — мини-сфера 30 fps с подписью «Speaking».
- **Значок динамика** (`#spk`, `aria-pressed`): переключает тот же флаг, что и настройка «Speak answers» (в макете `#spk` и чекбокс панели — одно поле `A.spk`), а не «до конца разговора» — спека 10 уступает макету. Остров пишет `assistant.speak` в `ui.json` через main; Settings и остров показывают одно значение.
- **Мини-вид при речи** — сфера без эмоции (`specFor(isMini)`), палитра лица сохраняется (коралл при `anger`/`error`).
- **Палитра и приглушение лица**: `pal = anger | error ? coral : amber`, `dim = EMO[emo].dim` (у `sad` 0.78); ореол — по палитре (`haloFor` уже так).
- **Reduced motion**: статичный кадр лица текущей эмоции, рот `amp 0.3`, без моргания, переходов и вспышки.
- **Переходы**: `sphere → face 0.8`, `face → sphere 0.8`, `cloud → face 1.4`, `face → cloud 1.2`; смена эмоции внутри лица 0.6 с; вход в лицо — рот (роль 2) с задержкой 0.2 с; `surprise` — вспышка яркости ×(1 + 0.8·flash) со спадом 0.6 с; моргание раз в 2.4–4.4 с по 220 мс, в 20 % случаев двойное (+330 мс, 180 мс), закрытие 0.94; `surprise` и `error` не моргают.

## Решения, которых нет ни в спеке, ни в макете (мои, человек может поправить)

- **Источник случайности моргания** — второй поток `rng(seed ^ 0x9e3779b9)` вместо `Math.random` макета: числа те же, картинка та же, но кадр воспроизводим (ограничение «один seed — один кадр» и тесты).
- **Рот по реальной громкости**: вместо синтетической кривой `ampAt` макета (у макета нет звука) — `amp = clamp((rms − 0.02) / 0.25)` по `getFloatTimeDomainData` аналайзера, атака мгновенная, спад 0.08 с; `amp` идёт в ту же формулу `lerp(H0, H1, amp)`.
- **Выключение динамика посреди речи** (макет молчит: его речь — таймер) — речь обрывается, сразу `idle` как по Esc, остров остаётся открытым.
- **Эмоция `error`** в таблице есть дословно; хост даёт `mood: 'error'` только с фазой `error`, которая не озвучивается, — в продукте лицо `error` не появляется, таблица не режется.
- **Языки фраз.** «Отправил» / «Sent» — по-русски и по-английски; для прочих языков помощника — английская.
- **Нет голоса для языка** — `say` без `-v` (системный голос), речь не отключается. Если `say` вообще не отвечает (не macOS, сбой) — текст без звука, лица нет, молча.
- **Прогрев** — синтез короткой фразы при включении «Speak answers» и при старте острова с включённой речью.
- **Новинки `say`** (`Albert`, `Bad News`, `Bahh`, `Bells`, `Boing`, `Bubbles`, `Cellos`, `Good News`, `Jester`, `Organ`, `Superstar`, `Trinoids`, `Whisper`, `Wobble`, `Zarvox`) в список не попадают.
- **Предложение готово** для синтеза, когда за ним уже есть следующий текст, либо ответ закончен; сегментация — `Intl.Segmenter(language, { granularity: 'sentence' })`, минимум 2 знака.
- **Одна подпись на один флаг**: «Speak answers» и в Settings, и на значке острова (в макете значок подписан «Spoken replies»; спека 6.1 зовёт настройку «Speak answers»).

## Review Focus

1. Ответ с инструментом посередине: хост сбрасывает `answer` в `''` на `tool` и публикует новый текст — очередь должна забыть недоговорённое и не склеивать старое с новым (Задача 6: тест «answer стал короче отданного префикса → очередь сброшена, speaker.stop()»).
2. Хоткей и микрофон во время речи: по макету не пишут и не обрывают — иначе микрофон записал бы голос помощника (Задача 7: тест «openMode({listen:true}) и toggleListening() при speaking → record не вызван, stop не вызван, остров раскрыт»).
3. `say` зависает или бинарь отсутствует: ход не должен висеть — тайм-аут 20 с на предложение, результат без звука, остров возвращается к сфере (Задача 2: тест «run не завершился за timeout → SIGKILL, пустой результат»; Задача 7: тест «synthesize бросает → input idle, notice нет»).
4. Выключение «Speak answers» посреди речи (значок острова или Settings): речь обрывается, лицо складывается в сферу, остров открыт (Задача 7: тест «config.speech.enabled → false при speaking → stop, input idle»).
5. Смена эмоции в той же форме (`joy` → `sad` при двух предложениях разной метки невозможна внутри хода, но возможна между ходами и при ошибке): переход 0,6 с без глитча, палитра янтарь → коралл за 0,3 с (Задача 8: тест «face joy → face anger: dur 0.6, pal coral»).

---

### Task 1: `speakable` — текст для озвучки

**Files:**
- Modify: `packages/core/src/assistant/text.ts` (рядом со `splitMood`; подпуть `@parley/core/assistant` уже экспортирует этот файл)
- Test: `packages/core/src/assistant/text.test.ts`

**Interfaces:**
- Produces: `speakable(text: string): string` — убирает метку настроения `[[…]]`, разметку Markdown (`*`, `_`, `` ` ``, `#`, маркеры списков), блоки кода целиком, URL, абсолютные пути (`/…/…`), составные id (`session:…`, `room:…`, `w-0003`, `s-01` внутри скобок), сворачивает пробелы; пустая строка, если ничего не осталось.

- [ ] **Step 1: Падающие тесты** — `speakable('[[joy]] The room **Redesign** is working.')` → `'The room Redesign is working.'`; текст с блоком ``` → без него; `'See /Users/x/a.ts and [session:ab12:w-0003:s-01]'` → `'See and'` → после сворачивания `'See and'` допустимо, но лучше ожидать `'See'`? — зафиксировать: id и путь удаляются вместе с окружающими скобками, двойные пробелы сворачиваются → `'See and'`; `'[[calm]]'` → `''`; русский текст с «S01 needs you» сохраняет `S01`.
- [ ] **Step 2: Запустить, убедиться, что падают.**
- [ ] **Step 3: Реализация** `speakable` в `text.ts` (чистые regex, порядок: блоки кода → метка → URL/пути → id → разметка → пробелы).
- [ ] **Step 4: PASS** — `pnpm --dir packages/core exec vitest run src/assistant/text.test.ts`.
- [ ] **Step 5: Коммит** — `feat(core): speakable — текст ответа помощника для озвучки`.

---

### Task 2: Синтез речи в main — `main/assistant/tts.ts` и подмена для E2E

**Files:**
- Create: `packages/desktop/src/main/assistant/tts.ts`, `tts.test.ts`
- Modify: `packages/desktop/src/main/test-switches.ts:13–46` (+ `test-switches.test.ts:62–64`)

**Interfaces:**
- Produces:
  ```ts
  export interface SayVoice { name: string; locale: string; enhanced: boolean }   // name — как в `say -v`, включая скобки
  export function parseVoices(listing: string): SayVoice[]                       // разбор `say -v '?'`, без новинок (NOVELTY)
  export function voicesFor(voices: SayVoice[], language: string): SayVoice[]    // префикс локали ↔ код Whisper (исключения: yue→zh_HK, he→he/iw, no→nb/nn, jw→jv)
  export function defaultVoice(voices: SayVoice[], language: string): string | null // enhanced/premium языка, иначе первый, иначе null
  export interface TtsService {
    voices(): Promise<SayVoice[]>                                                 // кэш списка, один вызов `say -v '?'` на процесс
    synthesize(input: { text: string; voice: string | null; language: string }): Promise<Uint8Array | null> // WAV 22 050 Гц моно; null — сбой/тайм-аут
    warmup(language: string, voice: string | null): Promise<void>
    stop(): void                                                                  // SIGKILL живым `say` (before-quit)
  }
  export function createTtsService(deps: { run: RunEngine; dir: string; log(line: string): void; timeoutMs?: number }): TtsService
  export function createFakeTtsService(): TtsService                               // один голос `Fake (en_US)`, WAV 0,4 с тишины через pcm16ToWav(…, 22050)
  export function removeStaleTts(dir: string): Promise<void>
  ```
- Consumes: `RunEngine`/`runEngine` из `main/voice/transcribe.ts:47–74` (реестр процессов, SIGKILL по тайм-ауту), `pcm16ToWav` из `main/voice/wav.ts:5`, `assistantCwd()` из core (`~/.parley/assistant`); `switches.tts` = `PARLEY_TTS=fake`.
- Команда: `say -v <voice> -f <text.txt> -o <out.wav> --file-format=WAVE --data-format=LEI16@22050` (без `-v`, если `voice === null` и `defaultVoice` пуст); текст — файлом рядом (stdin у `runEngine` закрыт); оба файла 0600, удаление в `finally`. Тайм-аут 20 с.

- [ ] **Step 1: Падающие тесты** — `parseVoices` на фикстуре из 6 строк (`Milena              ru_RU    # Здравствуйте!`, `Yuri (Enhanced)     ru_RU`, `Eddy (Английский (США)) en_US # …`, `Zarvox              en_US # …`, `Samantha            en_US`, `Alex (Premium) en_US`) → 5 голосов, `Zarvox` отброшен, `enhanced` у Yuri и Alex; `voicesFor(…, 'ru')` → Milena, Yuri; `defaultVoice(…, 'ru')` → `'Yuri (Enhanced)'`; `defaultVoice(…, 'zz')` → `null`; `synthesize` с фейковым `run`: аргументы содержат `-v`, `-f`, `-o`, `--data-format=LEI16@22050`, файлы созданы с 0600 и удалены после; `run` вернул `code 1` → `null`; `timedOut` → `null` (Review Focus 3); `createFakeTtsService().synthesize(...)` → WAV с заголовком `RIFF`.
- [ ] **Step 2: Запустить, убедиться, что падают.**
- [ ] **Step 3: Реализация** по интерфейсам; `test-switches.ts`: поле `tts: boolean` (`allowed && envValue(env, 'TTS') === 'fake'`), тест по образцу `voice`.
- [ ] **Step 4: PASS** по `tts.test.ts` и `test-switches.test.ts`.
- [ ] **Step 5: Коммит** — `feat(desktop): синтез речи помощника через say в main, подмена PARLEY_TTS=fake`.

---

### Task 3: Настройки и мост — `speak`, `voice`, каналы синтеза

**Files:**
- Modify: `packages/desktop/src/shared/ui-types.ts:43–53, 115, 269–279` (`AssistantUi.speak: boolean`, `voice: string | null`), `shared/island.ts:63–97` (`IslandAssistantConfig.speech: { enabled: boolean; voice: string | null }`, `IslandApi.speech`), `shared/bridge.ts:134–139` (`app.assistantVoices(language)`), `preload/island.ts:65–106`, `preload/index.ts:231–232`, `main/island/ipc.ts:61–106`, `main/ipc.ts:239–243, 416–421`, `main/index.ts:498–513` (конфиг), `:832–853` (служба `switches.tts ? createFakeTtsService() : createTtsService(...)`), `before-quit` (`tts.stop()`), старт (`removeStaleTts`)
- Test: `shared/ui-types.test.ts`, `main/island/ipc.test.ts`, `main/ipc.test.ts`, `preload/island.test.ts`; фикстуры `IslandApp.test.tsx:67,125`, `AssistantView.test.tsx:23`, `store.test.ts:4`, `test-utils/fake-bridge.ts`

**Interfaces:**
- Produces:
  - `island:tts` — `invoke({ text: string; voice: string | null; language: string }) → Uint8Array | null`; только от окна острова (`fromIsland`), `text` до 2000 знаков, иначе `HostError('bad_request')`.
  - `island:tts-warmup` — `invoke({ language, voice }) → void`.
  - `island:assistant-speak` — `invoke(on: boolean) → void`; только от окна острова; main делает `uiStore.save({ assistant: { speak: on } })` и зовёт `onUiSaved` — конфиг острова и зеркало настроек обновляются тем же путём, что из диалога Settings (значок динамика макета и настройка — один флаг).
  - `app:assistant-voices` — `invoke(language: string) → SayVoice[]` для главного окна.
  - `bridge.island.speech = { synthesize(input), warmup(input), setSpeak(on) }`; `bridge.app.assistantVoices(language)`.
  - `normalizeAssistant`: `speak` по умолчанию `false`, `voice` — строка или `null`; старые `ui.json` без полей — умолчания.
  - `islandConfig().assistant.speech = { enabled: current.assistant.speak, voice: current.assistant.voice }`.

- [ ] **Step 1: Падающие тесты** — `ui-types.test.ts`: `normalizeAssistant({})` даёт `speak: false, voice: null`; `{ speak: 'yes' }` → `false`; `main/island/ipc.test.ts`: `island:tts` отдаёт байты фейка, не от острова → `HostError('forbidden')` как у соседей, текст 2001 знак → `bad_request`; `main/ipc.test.ts`: `app:assistant-voices('ru')` отдаёт список службы; `preload/island.test.ts`: `speech.synthesize` зовёт `invoke('island:tts', …)`; `main/island/ipc.test.ts`: `island:assistant-speak(true)` → `uiStore.save` с `{ assistant: { speak: true } }` и `onUiSaved`, не от острова → `forbidden`.
- [ ] **Step 2: Запустить, убедиться, что падают.**
- [ ] **Step 3: Реализация** по интерфейсам; байты через IPC — `Uint8Array` (в renderer `slice(byteOffset, byteOffset+byteLength)` до `ArrayBuffer`, как `voice/ipc.ts:15–21` в обратную сторону).
- [ ] **Step 4: PASS** по пяти файлам тестов + `tsc` desktop (фикстуры с новым полем `speech`).
- [ ] **Step 5: Коммит** — `feat(desktop): настройки речи помощника и каналы синтеза для острова`.

---

### Task 4: Settings → Assistant — «Speak answers» и голос

**Files:**
- Modify: `packages/desktop/src/renderer/components/settings/AssistantSettings.tsx:52–56, 99–117`, `shared/strings.ts` (блок `assistant.settings`)
- Test: `AssistantSettings.test.tsx`

**Interfaces:**
- Consumes: `bridge.app.assistantVoices(language)`, `patch({ speak })`, `patch({ voice })`.
- Строки: `speak: 'Speak answers'`, `speakHint: 'Uses the macOS voices from System Settings → Accessibility → Spoken Content. Enhanced voices sound better.'`, `voice: 'Voice'`, `voiceDefault: (name: string | null) => name === null ? 'System voice' : \`Default (${name})\``, `voiceNone: 'No voices for this language — the system voice is used'`, `voiceEnhanced: ' · enhanced'`.
- Список голосов перезапрашивается при смене `assistant.language`; выбранный `voice`, которого нет в списке языка, показывается как есть с пометкой `(not installed)`.

- [ ] **Step 1: Падающие тесты** — переключатель «Speak answers» пишет `{ assistant: { speak: true } }`; Select голоса показывает `Default (Yuri (Enhanced))` первым и `Milena`; выбор Milena пишет `{ assistant: { voice: 'Milena' } }`; язык без голосов → подпись `voiceNone` и Select с одним пунктом `System voice`.
- [ ] **Step 2: Запустить, убедиться, что падают.**
- [ ] **Step 3: Реализация** — Switch и Select по образцу языка (`SYSTEM_LANGUAGE` :22), прогрев: при включении `speak` → `bridge.island`? (у главного окна моста острова нет) → прогрев делает остров при получении `config.speech.enabled` (Задача 7), здесь ничего.
- [ ] **Step 4: PASS**; E2E `dialogs-layout.spec.ts` — секция Assistant помещается в 800×500 с двумя новыми полями.
- [ ] **Step 5: Коммит** — `feat(desktop): Settings → Assistant — Speak answers и выбор голоса`.

---

### Task 5: Проигрыватель острова — `speaker.ts`

**Files:**
- Create: `packages/desktop/src/renderer/island/assistant/speaker.ts`, `speaker.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SpeakerDeps { createContext(): AudioContextLike; now(): number }
  export interface Speaker {
    enqueue(wav: ArrayBuffer): void          // декодирует и ставит в хвост; первый элемент начинает играть сразу
    stop(): void                             // обрывает текущий источник, чистит очередь
    mouth(): number                          // 0..1 по аналайзеру с атакой 0 и спадом 0,08 с; 0, когда тихо
    speaking(): boolean
    onIdle(cb: () => void): () => void       // очередь опустела и последний источник доиграл
  }
  export function createSpeaker(deps: SpeakerDeps): Speaker
  ```
- `AudioContextLike` — подмножество `AudioContext` (`decodeAudioData`, `createBufferSource`, `createAnalyser`, `destination`, `currentTime`, `resume`), чтобы тест шёл в jsdom с фейком. Один `AnalyserNode` (`fftSize 512`), источники подключаются через него; `amp = clamp((rms − 0.02) / 0.25)`.

- [ ] **Step 1: Падающие тесты** (фейковый контекст с ручным `ended`) — два `enqueue` → второй источник стартует после `ended` первого; `stop()` → `source.stop()` и очередь пуста, `speaking() === false`; `onIdle` зовётся один раз после последнего `ended`; `mouth()`: данные аналайзера с rms 0,27 → 1, rms 0,02 → 0, спад за 80 мс до 0 (`now` подменён); `decodeAudioData` отклонил → элемент пропущен, следующий играет.
- [ ] **Step 2: Запустить, убедиться, что падают.**
- [ ] **Step 3: Реализация**; контекст создаётся лениво при первом `enqueue` (`backgroundThrottling: false` у окна острова, жест не нужен — A.5).
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Коммит** — `feat(island): проигрыватель речи помощника с громкостью рта`.

---

### Task 6: Очередь предложений и шаблонные фразы — `speech-queue.ts`, `spoken.ts`

**Files:**
- Create: `packages/desktop/src/renderer/island/assistant/speech-queue.ts`, `speech-queue.test.ts`, `spoken.ts`, `spoken.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function createSentenceFeed(language: string): {
    push(turn: number, answer: string, settled: boolean): string[]  // новые готовые предложения; смена turn или укорочение answer — сброс (возвращает [] и ставит флаг reset)
    reset(): void
    wasReset(): boolean                                             // и снимает флаг
  }
  export function spokenPhrase(kind: 'sent', language: string): string
  ```
- `spoken.ts`: таблица `{ en: { sent: 'Sent.' }, ru: { sent: 'Отправил.' } }`, прочие языки → `en`. Только эта фраза: по макету (`decide`) отмена и ошибки не озвучиваются.
- Сегментация через `Intl.Segmenter`; готово = есть текст после границы, либо `settled === true` (фаза хоста вышла из `thinking`/`tool`/`answering`); каждое предложение проходит `speakable` (Задача 1) и отбрасывается, если короче 2 знаков. Очередь только **режет и отдаёт на синтез**; когда играть — решает стор (Задача 7: после конца ответа, как `finish` макета).

- [ ] **Step 1: Падающие тесты** — потоковый ввод `'The room is working.'` → `[]`, затем `'The room is working. Two agents'` → `['The room is working.']`, затем `settled` → `['Two agents']`; `push(2, …)` после `push(1, …)` → сброс; `answer` короче префикса → сброс (Review Focus 1); русский текст с «т. е.» не режется внутри сокращения (Segmenter `ru`); `spokenPhrase('sent','uk')` → `'Sent.'`.
- [ ] **Step 2: Запустить, убедиться, что падают.**
- [ ] **Step 3: Реализация.**
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Коммит** — `feat(island): очередь предложений и шаблонные фразы речи помощника`.

---

### Task 7: Стор острова — речь по сценариям макета, Esc, значок динамика

**Files:**
- Modify: `packages/desktop/src/renderer/island/assistant/store.ts:13, 20–22, 84–93, 111–135, 155`, `labels.ts:6–7, 29`, `IslandApp.tsx:71, 97–104, 189–215, 307–319` (configure: `speech` deps; прогрев при `config.speech.enabled`), `shared/strings.ts` (`assistant.speaking: 'Speaking'`, `done: 'Done'`, `miniSpeaking: 'Speaking'`, `miniDone: 'Done'`)
- Test: `store.test.ts`, `labels.test.ts`, `IslandApp.test.tsx`

**Interfaces:**
- Produces: `InputPhase = 'idle' | 'listening' | 'transcribing' | 'speaking' | 'settling'`; стор получает `toggleSpeak()`, `mouth(): number` (прокси к speaker), `speechEnabled` из конфига.
- `AssistantDeps.speech = { synthesize(text): Promise<ArrayBuffer | null>; speaker: Speaker; feed: ReturnType<typeof createSentenceFeed>; setSpeak(on: boolean): Promise<void> }`.
- Поведение — по сценариям макета (`finish`, `speak`, `decide`, `hotkey`, `esc`, `tuck`):
  - `applyHost` при включённой речи: пока хост в `answering` — `feed.push(host.turn, host.answer, settled)`, каждое предложение сразу уходит в `synthesize`, результаты лежат в `pending` **по порядку** (массив промисов) и в `speaker` пока не идут; `feed.wasReset()` → `pending` очищен, `speaker.stop()`.
  - **Ответ дописан без карточки** (фаза хоста ушла из `answering` в `idle`, исхода нет) → `settled` отдаёт хвост → `pending` по очереди (`await` последовательно) → `speaker.enqueue`; первый `enqueue` ставит `input: 'speaking'`; `speaker.onIdle` → `input: 'settling'` на 1000 мс → `'idle'` (`finish` → `speak` → `settle`).
  - **Ход с карточкой** (`awaiting-confirm`): ничего не озвучивается; `host.outcome` стал `sent` → через 900 мс `synthesize(spokenPhrase('sent', language))` → лицо говорит → `settling` → `idle` (`decide`); `cancelled` и `error` → молча.
  - `openMode({ listen: true })` и `toggleListening()` при `speaking`/`settling` → записи нет, речь не обрывается, остров только раскрывается (`hotkey` при `BUSY`; Review Focus 2).
  - `close()` (Esc) → `speaker.stop()`, `pending` очищен, сразу `idle` без `settling` (`esc`).
  - `toggleSpeak()` → `deps.speech.setSpeak(!speechEnabled)`; пришедший конфиг `speech.enabled === false` при речи → `stop()`, `idle` (Review Focus 4). `synthesize` вернул `null` или бросил → предложение пропущено, без notice (Review Focus 3).
  - `assistantBusy` считает `speaking`/`settling` занятостью (таймер `ANSWER_HOLD_MS` не закрывает остров посреди речи); `hideAssistant()` (⌃) при речи сворачивает в мини, речь продолжается (`tuck`).
  - `labels.statusLabel`: `speaking` → `S.assistant.speaking` («Speaking»), `settling` → `S.assistant.done` («Done»); `miniLabel`: `speaking` → `miniSpeaking` («Speaking»), `settling` → `miniDone` («Done») (сейчас любой input даёт `miniListening`, :29) — таблицы `LABEL`/`MINI` макета.

- [ ] **Step 1: Падающие тесты** — по каждому пункту поведения выше по одному тесту с фейковыми `speaker`/`synthesize`/`feed` (vi.fn, fake timers для 1000 мс).
- [ ] **Step 2: Запустить, убедиться, что падают.**
- [ ] **Step 3: Реализация**; `IslandApp` собирает `speaker` и `feed` на `connected` и язык из конфига; прогрев `bridge.island.speech.warmup` при `config.speech.enabled` (один раз на включение).
- [ ] **Step 4: PASS** по трём файлам.
- [ ] **Step 5: Коммит** — `feat(island): речь помощника после ответа — состояние, Esc, значок динамика`.

---

### Task 8: Лицо в движке роя — порт макета

**Files:**
- Modify: `packages/desktop/src/renderer/island/swarm/spec.ts:11–28, 52–54, 57–85`, `engine.ts:21–29, 56–95, 150, 181–246, 252–278, 281–350, 352–433`, `Swarm.tsx:12–27, 63–92`
- Test: `swarm/spec.test.ts`, `swarm/engine.test.ts`, `swarm/Swarm.test.tsx`

**Interfaces:**
- Produces:
  - `SwarmShape = 'dot' | 'cloud' | 'sphere' | 'face'`; `SwarmEmotion = 'calm' | 'joy' | 'sad' | 'surprise' | 'anger' | 'error'` (= `AssistantMood`); `SwarmSpec.emo: SwarmEmotion | null` (`BASE.emo = null`).
  - `DUR` расширить: `sphereface: 0.8, facesphere: 0.8, cloudface: 1.4, facecloud: 1.2`; смена эмоции в той же форме — 0,6 с; вход в лицо — рот с задержкой `extra = 0.2` с.
  - `EMO: Record<SwarmEmotion, FaceSpec>` — дословно таблица макета (строки 249–255), в `spec.ts`.
  - `swarmSpecFor(host, input, mini)`: `input === 'speaking'` → `{ shape: 'face', emo: host.mood, pal: anger|error ? 'coral' : 'amber', dim: EMO[emo].dim ?? 1 }`; `input === 'settling'` → сфера `rot 0.3`; в мини `face` → `sphere`, `emo: null`. Приоритет: `offline` хоста выше речи; `listening`/`transcribing` — как сейчас.
  - `SwarmEngine.frame(now, ctx, reducedMotion, mic, mouth = 0)`; ключ спеки `${shape}|${fx}|${emo}`; `Soul.role: 0 | 1 | 2` по порогам 0,24 / 0,48 из уже существующего вызова `R()` (engine.ts:223 — порядок генератора не меняется, рой по seed совпадает с макетом); `shapeClass` → `'cloud' | 'sphere' | 'face'`; `tg(s, t, amp, bl)` с веткой `face(s, F, amp, bl, t)` — порт строк 308–325 макета (корона-пыль, ×1,2, `sm 1.15`, `z 0.35`); `blink(now, F)` — порт 326–333 на **втором потоке rng** (`rng(seed ^ 0x9e3779b9)`), не на `Math.random`; `flash` для `surprise` (яркость ×(1+0,8·flash), спад 0,6 с); в `frame` — `p` с вычетом 0,2 с для `role === 2` при входе в лицо, `trans = el < dur + extra`; reduced motion: `amp 0.3`, `bl 1`, без вспышки.
  - `<Swarm mouth={() => number}>` — геттер, читается в rAF (как `live.current.mic`), без ререндера; `data-emo` на canvas при `face`.
  - **Все числа лица — из макета без правок**: пороги ролей 0.24 / 0.48, `ex = 0.41·sx`, `ey` из таблицы, глаз `F.a·X`, `F.b·Y·bl`, веко `cut` через `clamp(cut[0] + cut[1]·sx·X, −1, 0.8)`, `dome` → `−|Y|`, `x`-глаз через `len`, рот `H = lerp(H0, H1, amp)`, `mo` по степени 0.8 с `(0.92 + 0.16·amp)`, `curl`, `wave 0.035·sin(q·3.4π)`, `pw`, корона `gx·0.045 + 0.012·sin(t/1000·0.8 + tw)`, `m 0.7`, масштаб ×1.2, `sm 1.15`, `z 0.35`. Отличий от макета два — источник случайности моргания и `amp` (раздел «Решения»); новых параметров не вводить.

- [ ] **Step 1: Падающие тесты** — `spec.test.ts`: `speaking` + `mood joy` → `face/joy/amber`; `mood anger` → `coral`; `settling` → `sphere rot 0.3`; mini + speaking → `sphere`; (поправить `toEqual` на :36 под новое поле `emo`). `engine.test.ts`: после перехода в `face calm` души `role 0` лежат внутри эллипса глаза (`|x/1.2 + 0.41| ≤ 0.095 + 0.06`, `|y/1.2 + 0.28| ≤ 0.13 + 0.06`), `role 2` — в полосе рта (`|x/1.2| ≤ 0.39 + 0.06`, `|y/1.2 − 0.25| ≤ 0.25`); `mouth 1` против `mouth 0` — высота рта больше; два движка с одним seed и одинаковыми `now` → одинаковые `souls` в лице через 5 с (моргание детерминировано); `face joy → face anger` → `dur 0.6`, палитра `coral` (Review Focus 5); `surprise` вход → яркость первого кадра выше (проверить через `dim`-множитель, если он читается; иначе через внутренний `flash` в тестовом геттере). `Swarm.test.tsx`: `data-shape="face"`, `data-emo="joy"`.
- [ ] **Step 2: Запустить, убедиться, что падают.**
- [ ] **Step 3: Реализация** — порт строк макета 246–257, 280–350 (функции `tg` ветка face, `face`, `blink`, `flash`, `extra`, `toFace`), тип `FaceSpec` с полями `a b ey mw H0 H1 pw curl? cut? dome? mo? x? len? wave? nb? dim?`.
- [ ] **Step 4: PASS** по трём файлам; `engine.test.ts` детерминизм по seed для облака и сферы должен остаться зелёным (порядок rng не менялся).
- [ ] **Step 5: Коммит** — `feat(island): лицо роя с шестью эмоциями — порт одобренного макета`.

---

### Task 9: Виды — лицо на острове, значок динамика, мини «Speaking»

**Files:**
- Modify: `packages/desktop/src/renderer/island/assistant/AssistantView.tsx:19–37, 61, 82, 127–169`, `IslandView.tsx:110–114`, `IslandApp.tsx` (пропсы `mouth`, `speakOn`, `onToggleSpeak`)
- Test: `AssistantView.test.tsx`, `IslandView.test.tsx`, `IslandApp.test.tsx`

**Interfaces:**
- Consumes: `swarmSpecFor(host, input, mini)` с `host.mood` в зависимостях `useMemo` (:61 и IslandView :112), `store.mouth`, `config.speech.enabled`, `store.toggleSpeak`.
- Produces: кнопка динамика рядом с микрофоном, как `#spk` макета (`data-testid="assistant-speak"`, `aria-label` = `S.assistant.settings.speak`, `aria-pressed` = `config.speech.enabled`, иконка `Volume2`/`VolumeX` из lucide), видна всегда; подписи «Speaking» и «Done» (Задача 7); мини-пилюля: `fps 30` при `speaking`/`settling` (через `assistantBusy`), подписи `miniSpeaking`/`miniDone`.

- [ ] **Step 1: Падающие тесты** — `AssistantView`: при `input speaking` и `mood sad` canvas имеет `data-shape="face" data-emo="sad"`, подпись «Speaking»; при `settling` — `data-shape="sphere"` и «Done»; кнопка `assistant-speak` с `aria-pressed="true"` при `speech.enabled`, `"false"` без неё; клик → `onToggleSpeak`. `IslandView`: мини при `speaking` → `data-shape="sphere"`, подпись «Speaking». `IslandApp`: `mouth` пробрасывается в `<Swarm>` (геттер зовётся в кадре с фейковым rAF).
- [ ] **Step 2: Запустить, убедиться, что падают.**
- [ ] **Step 3: Реализация.**
- [ ] **Step 4: PASS**; снимки состояний стендом `shots-assistant.mjs` (speaking calm/joy/anger, settling, мини) — приложить к журналу.
- [ ] **Step 5: Коммит** — `feat(island): лицо во время речи, значок динамика, мини «Speaking»`.

---

### Task 10: E2E, документы, приёмка

**Files:**
- Modify: `packages/desktop/e2e/assistant.spec.ts` (новый сценарий), при необходимости `e2e/stub-assistant-agent.mjs:30–38` (метки уже есть: `[[joy]]`)
- Modify: `README.md` (раздел помощника: Speak answers, голос, значок динамика), `CHANGELOG.md` (Unreleased → Added «The assistant speaks»), `docs/specs/2026-10-14-assistant-design.md` (отметки «сделано» в 9–10, расхождения: Canvas 2D вместо WebGL2, `settling`, решения этого плана), `TODOS.md` (этап 4 и шесть отложенных эмоций)

- [ ] **Step 1: E2E** — запуск с `PARLEY_TTS=fake` и `PARLEY_VOICE=fake`; `saveUi({ assistant: { enabled: true, provider: 'claude', speak: true } })`; вопрос текстом; пока ответ идёт — `data-shape="sphere"`; после конца ответа — `data-shape="face"` и `data-emo="joy"` на `[data-testid=swarm]`, подпись «Speaking»; затем `data-shape="sphere"` с подписью «Done» и `cloud`; второй сценарий: хоткей во время лица не даёт «Listening…» и оставляет `face`; Esc во время речи закрывает остров, `data-shape` не `face` при повторном открытии. Длинные имена работ и комнат, окно 800×500.
- [ ] **Step 2: Прогнать** `pnpm --dir packages/desktop exec playwright test e2e/assistant.spec.ts` — PASS трижды.
- [ ] **Step 3: Документы** по списку файлов.
- [ ] **Step 4: Полный прогон** — `pnpm build && pnpm typecheck && pnpm lint && LC_ALL=C pnpm -r --workspace-concurrency=1 test`; E2E `assistant.spec.ts`, `island.spec.ts`, `dialogs-layout.spec.ts`.
- [ ] **Step 5: Коммит** — `feat(assistant): этап 3 — E2E речи и лица, README, CHANGELOG, спека`.
- [ ] **Step 6: Живая проверка (человек, dev-окно `~/.parley-voice`)** — голос ru и en (Milena/Yuri, Samantha/Alex), включение «Speak answers» и прогрев (первое предложение без задержки больше 1 с после второго запуска), хоткей во время речи (только раскрывает, не пишет), Esc, значок динамика (переключает «Speak answers» и в Settings), карточка → «Отправил» лицом, отмена — молча, эмоции joy/sad/anger на реальных ответах, reduced motion в System Settings, CPU острова при лице (замер из плана острова, Задача 4).

---

## Порядок и зависимости

1 → 2 → 3 → 4 (независимо от 5–9 после 3) → 5 → 6 → 7 → 8 → 9 → 10. Задачи 5, 6 и 8 не пересекаются по файлам и могут идти параллельными исполнителями после 3; Задача 7 ждёт 5 и 6; Задача 9 ждёт 7 и 8.

## Вне плана

- Слово-пробуждение (этап 4) — свой спайк.
- Шесть отложенных эмоций (`02-swarm-emotions.jpg`: смех, сонно и др.) — после живой проверки шести первых.
- Нейроголос (Piper/sherpa-onnx) — решение по лицензиям отдельно; этот план только `say`.
- Тёплый старт CLI помощника — отдельная задача.
