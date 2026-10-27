# Помощник: этап 3b — нейроголос и лицо, звуки и движение острова. План реализации

Дата: 2026-10-27. Только план, кода нет. Комната r-08, ведущий s-35, владелец s-21. Автор спеки #9 — s-28, ведущий
исследования TTS — s-29.

## 0. Условия старта и база

- Код начинается только после того, как человек принял этот план.
- Ручную проверку T11 острова человек отложил до выпуска, ветка острова пока не влита (s-21, m-1360).
- **База — ветка `feat/island-agents` на `7c03432f`.** Интеграционная ветка `feat/assistant-stage-3b`
  ответвляется от неё. Исполнители работают в своих worktree от интеграционной ветки, интегратор вливает их задачи по
  волнам (§4).
- **Ветка острова сдвинулась** (исправления T11):
  - интегратор перебазирует `feat/assistant-stage-3b` на её новый HEAD **между волнами**, не посреди волны;
  - конфликты в своих строках решает задача, которая их правила; общие файлы (§4) — интегратор;
  - после перебазирования — полный прогон (§6). Сдвиг шва `IslandPresentationOutcome` или `present()` — повод
    остановиться и спросить s-21.
- **Ветку острова влили в `master` раньше 3b** — 3b перебазируется на `master` тем же порядком.
- **Ветка 3b не вливается раньше ветки острова.**
- **К выпуску** ручной чек-лист T11 острова (`rea-lab/island-t11-demo/`, готовит r-07) проходится вместе с ручными
  проверками 3b (§7, п. 11).
- Ветку `docs/island-stage3-plans` (план 3) никто не правит. Этот план её заменяет; что из плана 3 остаётся, что
  меняется и что снято — §3.
- Рабочее дерево `master` с незакоммиченными правками человека (в том числе `NOTICE`) не трогается. Правка `NOTICE`
  делается в ветке этапа (B03), конфликт с правкой человека снимается при влитии (§8, О-5).
- Коммиты, PR, `CHANGELOG.md` — по-английски (AGENTS.md; это отменяет русские коммиты плана 3). Тексты UI — только
  по-английски и только в `shared/strings.ts`. Комментарии, тесты и документы `docs/` — по-русски.

## 1. Цель

Помощник говорит ответы нейроголосом Qwen3-TTS 0.6B CustomVoice через speech.cpp. Пока он говорит, рой становится
лицом из одобренного макета: рот идёт по настоящему голосу (L1), лицо реагирует на интонацию (L2), эмоция меняется по
предложениям (L3). Остров получает свои звуки (три палитры) и плавные реакции роя на события агентов, а форма
острова — пружинный рост и мягкое сжатие. На дисплее с вырезом убранный остров живёт в вырезе: уши с роем и
статусом, выдвижение вниз (требование #10). Объём — ровно спеки, ничего сверх них.

## 2. Источники

| Документ | Что берём |
|---|---|
| `docs/specs/2026-10-26-island-motion-sound-design.md` (#9 с дополнением §12 о вырезе, после чистки 2026-10-27, sha256 `ddaf1830…a385ca1f`) | §3–§5 звуки, реакции, настройки; §6 голос и лицо; §9 приёмка S/V/F/G/M/P/L; §10 T1–T14; §11 решения; §12 остров в вырезе (#10): N1–N11, T15–T17, Н-1…Н-3 |
| План 3: `git show docs/island-stage3-plans:docs/specs/2026-10-17-assistant-plan-3.md` | Task 1–10, «Из макета», «Решения», Review Focus |
| `docs/specs/2026-10-14-assistant-design.md` | §6.1 настройки, §6.4 промпт, §8.2 кадры, §9 лицо, §10 голос, §12 проверки |
| `docs/specs/assets/2026-10-14-assistant/island-mockup.html` | `EMO`, `DUR`, `face()`, `blink()`, сценарии |
| `docs/research/2026-10-26-neural-tts-research.md` (sha256 `3ebd0272…d7d8`) | §6.3–§6.5 поставка, протокол worker, страж длины; §7 риски; §8 решения |
| `packages/desktop/prototype/island-motion-sound/index.html` (sha256 `b4717d6b…e9d3`) | `createVoiceAnalysis` (с строки 561), `Swarm.face()` (366–390, рот 375–388), `EMO` (273–279), `DUR` (269), `MOUTH_STROKE` (280), `forceBlink`/`blink` (391–397), рот входит на 0,2 с позже (422). Строки — на файл после чистки 2026-10-27; опора — имена |
| `docs/specs/2026-10-26-island-agent-features-design.md` §9, план r-04 (`docs/plans/2026-10-26-island-agent-features-plan.md`) | шов `IslandPresentationOutcome` |
| Стенд `rea-lab/voice-tts` (`results.md`, `MATRIX.md`, `speechcpp/bin`, Q8_0 GGUF) | только как доказательство и для разработки |

**Сверка имён с кодом** (подтвердил s-28, m-1347):

- `IslandCue` спеки #9 — это `IslandPresentationOutcome` (`shared/island.ts:128` ветки острова). Он приходит в
  `present()` в `IslandApp.tsx:361–366`; проп `onPresentation` остаётся швом для тестов.
- «`core/src/assistant/prompt.ts`» спеки — на деле `assistantPrompt()` в `core/src/assistant/launch.ts:86–95`.
  «`mood.ts`» — `splitMood()` и `MOOD_TAG_LIMIT` в `core/src/assistant/text.ts`, вызов — в
  `host/src/assistant/assistant-service.ts:366–397`.

## 3. Решения

### 3.1 Решения человека (обязательны)

Источник — бриф владельца s-21, раздел «Human decisions (binding)». Он записывает и пункты исследования §8, которые
в самом документе остались открытыми (набор голосов, uk/kk/be, Intel, Telegram, свой GGUF, выгрузка). Цель ≤ 300 мс
пришла из спеки #9 (s-28) и вошла в бриф как решение по шву. Цель человека в r-06 была мягче: ≤ 1 с до первого
звука на тёплом движке и RTF ≤ 0,5 (m-914, через s-29).

1. Движок — Qwen3-TTS 0.6B CustomVoice (Apache-2.0) на speech.cpp (MIT), sidecar `speech worker`. Веса по умолчанию —
   GGUF **Q8_0** (1 213 534 464 байт), скачиваются по запросу. 4-битных нет.
2. Шов — **поток** `island:tts-chunk`, первый звук ≤ 300 мс на прогретом движке, плюс `island:tts-cancel` и
   `island:tts-state`.
3. Голоса — пять: serena (по умолчанию, ж), ryan и aiden (м), vivian и ono_anna (ж). Голос выбирает пользователь,
   род речи помощника о себе — по голосу (G1–G4).
4. Озвучка только для ru и en. uk/kk/be пока только текстом. Intel Mac — только текст. Голос в Telegram — позже.
5. Веса — GGUF из каталога speech.cpp (`sakasegawa/Qwen3-TTS-12Hz-0.6B-CustomVoice-GGUF`, ревизия `fd9df936…`,
   sha256 `f606ea39…`) и для разработки, и для релиза. Сами не конвертируем (ответ человека на О-1, m-1381).
6. Модель выгружается после 15 мин простоя. Страж длины против срыва (около 1 прогона из 16–32).
7. Лицо — из макета; L1–L3; пороги рта F5.
8. Звуки: палитры (мягкая по умолчанию и ещё две). Done привязан к «Sound when an agent finishes». Звуки интерфейса
   выключены по умолчанию. «Думает» и шаги инструмента молчат всегда, тихий Done — тоже.
9. Голосовой диалог (без рук, живая расшифровка, перебивание голосом, реплики во время раздумий) — **следующий этап,
   здесь не строится**. Но 3b держит отмену быстрой и путь звука потоковым: §5, E3.
10. **Остров в вырезе (#10, через s-21, m-1374).** На дисплее с вырезом убранный остров — чёрная форма, продолжающая
    вырез:
    - уши: слева мини-рой, справа главный статус;
    - наведение и события выдвигают форму вниз;
    - дисплеи без выреза оставляют сегодняшнюю полосу;
    - переход между дисплеями меняет форму;
    - чужих ассетов нет: только наш рой и наш стиль.

    Спека — #9 §12. Открытые решения Н-1…Н-3 — §8.

### 3.2 Решения этого плана (их проверяют критик и человек)

- **Р1. Worker — дочерний процесс main, без `utilityProcess`.** Спека #9 §6.2 говорит про `utilityProcess`, а
  исследование §6.5 п. 1 допускает и дочерний процесс. `speech` — нативный бинарь, поэтому обёртка `utilityProcess`
  была бы лишним слоем: границу падений уже даёт отдельный процесс. main только читает JSON Lines, декодирует base64
  PCM16 в `Float32Array` и передаёт его по `MessagePort`. `MessagePortMain.postMessage` не передаёт `ArrayBuffer`,
  поэтому PCM копируется структурным клонированием. Цена ничтожна: 24 кГц × 4 байта ≈ 96 КБ на секунду звука.
- **Р2. Метки эмоций снимает хост** (предложение s-28, m-1347). Сейчас хост срезает только первую метку: остальные
  попали бы на экран, в историю и в Telegram. Поэтому хост срезает **все** `[[mood]]` из `answer` и публикует
  `AssistantState.moods?: { at: number; mood: AssistantMood }[]` — позиции в очищенном тексте. `mood` остаётся меткой
  первой фразы. Поле необязательное: старое окно его не читает. Это **единственное** изменение протокола хоста.
  Ограничение плана 3 «протокол не меняется» снимается только этим полем и полем `voiceGender` в настройках
  `assistant.configure` (Р3).
- **Р3. Род голоса уходит в хост через зеркало настроек** `assistant.configure` (`AssistantSettings.voiceGender?:
  'female' | 'male' | 'neutral'`). Его шлёт main (`main/assistant-mirror.ts`) при подключении и при каждом сохранении
  `ui.json`. Не через `assistant.ask`: разговор в хосте один, его делят остров, Telegram (`assistant-bridge.ts`) и
  напоминания (`lastAsk`/`mirror`). Параметр вопроса острова переключал бы род на вопросах из Telegram.
  - Без поля род `female`, как у serena по умолчанию.
  - Хост запоминает род, с которым шёл разговор. Если род в зеркале сменился, а разговор жив, следующий ход **любого
    происхождения** предваряется строкой `[system: voice changed — speak as {gender}]` (#9 §6.8).
  - Новый разговор не начинается.
- **Р4. Громкость с потоком.** Нормировать предложение целиком нельзя: первый кусок играет раньше, чем готово всё
  предложение. Поэтому у каждого голоса в каталоге есть постоянное усиление `gain`, снятое на фразах стенда (цель:
  RMS около 0,1, пик ≤ −1 dBFS; RMS считается только по кадрам речи, без ведущей тишины). Поверх стоит ограничитель
  пика −1 dBFS **без клиппинга**: огибающая усиления с мгновенной атакой и спадом около 50 мс. Огибающая переходит из
  куска в кусок внутри `utteranceId`, поэтому уровень на стыках не прыгает. Компрессора нет, формула рта прежняя.
  Согласовано с s-29 (m-1348, п. 5).
- **Р4а. Ведущая тишина срезается.** У 0.6B речь часто начинается с тишины: медиана 0,24–0,48 с по голосу, бывает
  до 1,9 с (документация speech.cpp, m-1348). Первый кусок приходит через ~30 мс, но голос может начаться позже.
  `TtsService` не отправляет на остров куски тише порога, пока не начнётся голос. E1 меряется до первого **слышимого**
  отсчёта.
- **Р5. Выгрузка после простоя — завершение процесса.** Команды выгрузки в протоколе нет (m-1348). Через 15 мин без
  синтеза `TtsService` закрывает stdin worker: тот доделывает запросы и выходит с кодом 0. `SIGKILL` — только если
  процесс завис. При следующей нужде worker запускается снова: около 1,3–1,5 с, это прячет фаза ответа. Компиляция
  шейдеров (13,6 с) замерена один раз, при самом первом запуске (см. Р7). Дополнительный прогрев запускается, когда
  открывается режим помощника, — и только если включено «Speak answers» и веса скачаны. Иначе каждое открытие зря
  грузило бы 1,2 ГБ. Этого прогрева нет в спеке: он прячет повторную загрузку после выгрузки.
- **Р6. Один файл весов на пять голосов.** Каталог — одна запись модели (GGUF) и пять голосов со ссылкой на неё.
  «Download» качает GGUF один раз, после этого все пять голосов скачаны.
- **Р7. «Готовлю голос…» в UI — по-английски:** `Preparing voice…` (правило строк). Показывается в Settings, пока
  worker не прислал `ready`: после скачивания и при любом холодном старте дольше ~2 с. Постоянный кэш шейдеров Metal
  у speech.cpp не задокументирован, поэтому медленный `ready` может вернуться после обновления macOS.
- **Р8. Нет голоса для языка** (язык помощника не ru и не en) **или нет движка** (x64, worker не стартовал, чужой
  протокол) — ответ текстом без речи и без лица, как G3. Parley ничего не скачивает сам.
- **Р9. Seed не фиксируем.** Страж длины делает один повтор с новым seed. Фиксированный seed — открытый вопрос
  исследования, вне плана.
- **Р10. Путь от голоса к лицу** — интерфейсы между задачами.
  - **B14, `speaker`:**
    - `read(time: Float32Array, freq: Float32Array): boolean` — читает `AnalyserNode` (fftSize 2048); `false`, когда
      голос не звучит;
    - `onStart((utteranceId) => void)` — началось предложение.
  - **B17/B21, `voice-features.ts`:**
    - `type VoiceFrame = { amp; visemes: { a, i, u, m }; pulse; eyesUp; blink }`;
    - `createVoiceAnalysis().step(time, freq, dt, now, ask: boolean): VoiceFrame`; при reduced motion — нейтральный
      кадр с `amp 0,3`;
    - движок и `<Swarm>` получают `voice: () => VoiceFrame | null` вместо `mouth` из B09;
    - B17 вводит поля L1, B21 — поля L2;
    - внутренний флаг движка `voiceMode: 'loudness' | 'full'` нужен только тестам F1, в UI его нет (#9 §11.10).
  - **B22, стор:**
    - держит `sentence: { utteranceId, emo, text } | null`: обновляет по `speaker.onStart`, берёт из очереди B16;
    - `voiceFrame()` читает `speaker.read` и вызывает `step`; `ask = /\?\s*$/.test(sentence.text)`;
    - в `swarm/spec.ts` меняет `swarmSpecFor(host, input, mini, sentenceMood?)`: эмоция лица — `sentenceMood ?? host.mood`.
  - **B24, виды:** передают `voice={voiceFrame}` и `sentence?.emo` в `swarmSpecFor` и `<Swarm>` (`AssistantView`,
    `IslandView`, `IslandApp`).

### 3.2а Критерии движка E1–E7

Своих ID у них в спеках нет. Они выведены из решений человека (§3.1) и исследования §6.5, §7.4.

- **E1.** Первый звук на прогретом движке: **p50 ≤ 300 мс и p90 ≤ 1 с** (решение человека по О-6, m-1381).
  **Точка замера:** от `island:tts-speak` до первого слышимого куска, который **получил остров** (после срезки тишины
  Р4а). Ожидание конца ответа сюда не входит: предложения играют только после него (§6.1). Срезка тишины не убирает
  время её синтеза (при RTF ~0,2 это 50–100 мс, в хвосте до ~0,4 с) — поэтому порог задан по перцентилям.
- **E2.** Страж длины: `max_seconds` на каждом запросе; срыв — один повтор с новым seed, затем предложение
  пропускается без звука, а текст остаётся.
- **E3.** Быстрая отмена. Esc, выключение динамика и сброс очереди глушат звук в тот же такт и шлют `cancel` в
  worker. После `cancelled` кусков нет. Это задел для перебивания голосом на следующем этапе.
- **E4.** Модель выгружается через 15 мин простоя; следующий ответ звучит без действий человека.
- **E5.** Веса качаются только по кнопке; sha256 сверяется; после скачивания идёт прогрев с `Preparing voice…` до
  `ready`.
- **E6.** Чужой `protocol`, `fatal`, x64 или нет бинаря — голос недоступен, ответы текстом, без падений.
- **E7.** Поставка: speech.cpp собран из исходников на закреплённых коммитах только для arm64, лежит в бандле и
  подписан вместе с приложением; в `NOTICE` есть атрибуция speech.cpp, ggml и Qwen3-TTS.

### 3.3 План 3: что остаётся, меняется, снято

| Задача плана 3 | В 3b | Задача 3b |
|---|---|---|
| 1. `speakable` | **остаётся**; добавлена защитная срезка всех `[[…]]` | B06 |
| 2. `tts.ts` через `say` → WAV | **меняется**: `TtsService` над `speech worker`, поток кусков f32, каталог, страж длины, выгрузка, fake. Временные WAV, `~/.parley/assistant/tts/`, `removeStaleTts`, `parseVoices`/`voicesFor`/`defaultVoice` — **сняты** | B05, B10 |
| 3. Настройки и мост | **меняется**: `assistant.voice` — id голоса каталога; вместо `island:tts` invoke → WAV — поток кусков через `MessagePort` (`island:tts-speak`, `-chunk`, `-cancel`, `-state`); `app:assistant-voices` отдаёт каталог; скачивание голоса; `island:tts-warmup` и `island:assistant-speak` — как в плане | B15 |
| 4. Settings → Assistant | **меняется**: голоса каталога с родом, языками, лицензией; «Download (N MB)» с прогрессом; `Preparing voice…`; подсказка про голоса macOS **снята** | B20 |
| 5. `speaker.ts` | **меняется**: `enqueue(chunk)` строит `AudioBuffer` из f32 без `decodeAudioData`; контекст и выход — общий граф острова B07; `AnalyserNode` fftSize 2048, рот по последним 512 отсчётам | B14 |
| 6. `speech-queue.ts`, `spoken.ts` | **остаётся** + эмоция предложения из `moods` (L3) + фразы по роду (G2) | B16 |
| 7. Стор острова | **остаётся** + куски по `utteranceId`, отмена в worker, нескачанный голос (G3), смена эмоции по предложению, `speaking()` для политики сигналов | B22 |
| 8. Лицо в движке роя | **остаётся** (порт макета), идёт до реакций #9 | B09 |
| 9. Виды | **остаётся** | B24 |
| 10. E2E и документы | **остаётся** + V1–V3, S1–S6, замеры P1/F4/E1 | B25 |
| Решение «нет голоса → `say` без `-v`» | **снято**: Р8 | — |
| Решение «прогрев при включении Speak answers» | **остаётся** + прогрев при открытии режима помощника (Р5) | B22 |
| Подпись коммитов по-русски, «исполнители не запускают тесты» | **снято**: коммиты по-английски; исполнитель гоняет тесты своей задачи (§6) | — |

## 4. Волны и владение файлами

Правило: в одной волне у задач нет общих файлов, включая тестовые фикстуры. Следующая волна стартует, когда
интегратор влил все задачи прошлой и прогнал `pnpm typecheck`. Задачи волны идут параллельно.

| Волна | Задачи |
|---|---|
| 0 | B00 база и замер «до»; B00d чистка документов от имени референсного приложения; B01 спайк worker; B02 спайк промпта |
| 1 | B03 поставка speech.cpp; B04 каталог и хранилище; B05 клиент worker; B06 core; B07 движок звука; B08 политика сигналов; B09 лицо |
| 2 | B06p текст промпта по B02; B10 `TtsService`; B11 хост и протокол; B12 настройки звука и движения; B13 реакции роя; B14 проигрыватель |
| 3 | B15 мост голоса; B16 очередь и фразы; B17 L1 формы рта |
| 4 | B18 движение формы; B20 Settings → Assistant; B21 L2 интонация; B27 датчик выреза |
| 5 | B19 проводка сигналов и снятие `beep`; B23 «место» в карточке |
| 6 | B22 стор острова: речь |
| 7 | B24 виды |
| 8 | B28 форма выреза в renderer |
| 9 | B25 E2E, замеры, документы → B26 ручные проверки человека |

B27 (датчик выреза и место окна) идёт в волне 4: его файлы main и shared не пересекаются с B18, B20, B21.

Пути ниже — от `packages/desktop/src/`, если не указано иначе.

| Задача | Файлы (владеет) | Зависит от |
|---|---|---|
| B03 | `packages/desktop/scripts/fetch-speech.mjs`, `fetch-speech.test.ts`, `src/main/assistant/licenses/Qwen3-TTS-LICENSE.txt` (новые); `electron-builder.yml`; `packages/desktop/package.json`; `.github/workflows/release.yml`; `release-config.test.ts`; `NOTICE` | B01 |
| B04 | `shared/tts-types.ts` + тест (новые); `main/voice/models.ts` + тест | B01 |
| B05 | `main/assistant/speech-worker.ts` + тест, `main/assistant/fixtures/speech-worker-*.jsonl` (новые) | B01 |
| B06 | `packages/core/src/assistant/text.ts`, `launch.ts` + тесты | — |
| B06p | `packages/core/src/assistant/launch.ts` + тест (только текст промпта) | B02, B06 |
| B07 | `renderer/island/sound/synth.ts`, `palettes.ts`, `graph.ts` + тесты (новые); `main/island/window.ts` + тест (только при необходимости `autoplayPolicy`) | — |
| B08 | `renderer/island/sound/cues.ts` + тест (новые) | — |
| B09 | `renderer/island/swarm/spec.ts`, `engine.ts`, `Swarm.tsx` + тесты | — |
| B10 | `main/assistant/tts.ts` + тест (новые); `main/test-switches.ts` + тест | B04, B05 |
| B11 | `packages/protocol/src/assistant.ts`; `packages/host/src/assistant/assistant-service.ts` + тест; `packages/host/src/methods/assistant.ts` + тест | B06 |
| B12 | `shared/ui-types.ts`, `shared/island.ts`, `main/index.ts`, `renderer/components/settings/SettingsDialog.tsx`, `shared/strings.ts` + тесты; `renderer/island/IslandApp.tsx` (одна строка `config.sound` в `present`, :365–366); фикстуры `IslandConfig` (`IslandApp.test.tsx`, `AssistantView.test.tsx`, `store.test.ts`, `test-utils/fake-bridge.ts`) | B07 |
| B13 | `renderer/island/swarm/*` | B09 |
| B14 | `renderer/island/assistant/speaker.ts` + тест (новые) | B07 |
| B15 | `shared/ui-types.ts`, `shared/island.ts`, `shared/bridge.ts`, `preload/island.ts`, `preload/index.ts`, `main/island/ipc.ts`, `main/ipc.ts`, `main/index.ts`, `main/assistant-mirror.ts` + тесты; те же фикстуры, что у B12 | B10, B11, B12 |
| B16 | `renderer/island/assistant/speech-queue.ts`, `spoken.ts` + тесты (новые) | B06, B11 |
| B17 | `renderer/island/assistant/voice-features.ts` + тест (новые); `renderer/island/swarm/engine.ts`, `Swarm.tsx` + тесты | B13, B14 |
| B18 | `renderer/island/island.css`, `IslandView.tsx` (класс перехода), `IslandApp.tsx` (`RETRACT_MORPH_MS`) + тесты | B12 |
| B19 | `renderer/island/useIslandCues.ts` + тест (новые); `IslandApp.tsx` (`present`); `main/island/ipc.ts`, `preload/island.ts`, `shared/island.ts`, `main/index.ts` (снятие `beep`); `renderer/attention/notify.ts` + тесты | B07, B08, B12, B15 |
| B20 | `renderer/components/settings/AssistantSettings.tsx` + тест; `shared/strings.ts` | B15 |
| B21 | `renderer/island/assistant/voice-features.ts`, `swarm/engine.ts` + тесты | B17 |
| B22 | `renderer/island/assistant/store.ts`, `labels.ts`, `IslandApp.tsx`, `shared/strings.ts`, `renderer/island/swarm/spec.ts` (`sentenceMood`) + тесты | B14, B15, B16, B19, B21 |
| B23 | `renderer/island/IslandView.tsx` (Card) + тест | B13, B18 |
| B24 | `renderer/island/assistant/AssistantView.tsx`, `IslandView.tsx`, `IslandApp.tsx` + тесты | B22, B23 |
| B27 | `main/island/notch-probe.ts` + тест (новые); `main/island/placement.ts`, `main/island/window.ts`, `main/index.ts`, `main/test-switches.ts`, `shared/island.ts` + тесты | B12, B15, B10 |
| B28 | `renderer/island/NotchEars.tsx` + тест, `renderer/island/IslandTab.test.tsx` (новые); `renderer/island/IslandView.tsx`, `IslandTab.tsx`, `IslandApp.tsx`, `island.css`, `shared/strings.ts` + тесты | B27, B13, B18, B23, B24 |
| B25 | `e2e/assistant.spec.ts`, `e2e/island-sound.spec.ts` (новый), `e2e/island.spec.ts`, `e2e/stub-assistant-agent.mjs`; `README.md`, `CHANGELOG.md`, `docs/specs/2026-10-14-assistant-design.md`, `TODOS.md`; журнал проверки | все |

Журнал проверки `docs/audits/<дата>/assistant-stage-3b-checks.md` ведёт интегратор. Исполнители присылают ему цифры.

## 5. Задачи

Формат: что сделать → приёмка (ID спек; E* — критерии движка из решений человека, §3.1) → команда проверки.
`vitest` desktop: `pnpm --dir packages/desktop exec vitest run <файлы>`; core и host — `pnpm --dir packages/<pkg>
exec vitest run <файлы>`. Все команды тестов запускаются с `LC_ALL=C` (ограничение плана 3), здесь это не
повторяется. В каждой задаче `tsc` чистый: `pnpm typecheck`.

### Волна 0

**B00. База и замер «до».** Интегратор. Создаёт `feat/assistant-stage-3b` от `feat/island-agents` (`7c03432f`), гоняет
полный набор (§6). На M1 снимает CPU процесса окна острова в покое с пилюлей и при занятом мини-рое (30 к/с) — база
для P1 и для CPU голоса.
Приёмка: журнал содержит sha базы, зелёный полный прогон и цифры «до».

**B00d. Чистка отслеживаемых документов** (решение человека m-1381). Интегратор, в ветке 3b, один коммит документов.
На базе `7c03432f` имя референсного приложения и ссылка на его репозиторий есть в двух отслеживаемых файлах:
- `TODOS.md`: раздел 22 — заголовок, пункт «что взять», источник;
- `docs/specs/2026-10-12-island-design.md`: источники (строки 6 и 8) и пункт «вне объёма» (строка 171).

Формулировки — нейтральные («референсные приложения», «исследование рынка»), смысл сохраняется. Других файлов задача
не трогает.

Приёмка — проверка L1/N11 (B25) на ветке находит 0 совпадений.

**B01. Спайк `speech worker` на закреплённой сборке.** Вне репозитория, в `rea-lab/voice-tts`. Собрать speech.cpp
из исходников так, как это сделает B03:
- speech.cpp v0.9.0, коммит `49f022a48bc1c7e797aa64dd08d2d9655baf299e`;
- подмодуль ggml — форк `nyosegawa/ggml` @ `cbdeccfd49ec9c702c175c273d36c47520cf4710`.

Запустить `speech worker <Q8_0.gguf> --threads 4`.

Протокол из исходника тега (m-1348):
- `ready {protocol: 3, version, defaults, model}`;
- `synthesize {id, text, voice, language, seed?, max_seconds?}`; незнакомые поля отклоняются (`invalid_argument`);
- `end {seed, samples, stop: complete|max_seconds|model_limit}`;
- `cancel {id}` без своего ответа: запрос кончается `cancelled {id}` на следующем куске;
- ровно одно завершающее сообщение на запрос (`end`, `error` или `cancelled`).

B01 проверяет это на живом процессе.

Замерить на ru/en для пяти голосов:
- первый кусок **и первый слышимый отсчёт** (до и после срезки ведущей тишины, Р4а);
- RTF, тёплый `ready`, первый холодный `ready` (компиляция шейдеров Metal), RSS;
- задержку отмены до `cancelled`;
- выход по закрытию stdin (Р5);
- RMS и пик каждого голоса по кадрам речи — это `gain` для Р4. Источник:
  `rea-lab/voice-tts/samples/speechcpp-Q8_0_<voice>/{ru,en}-{1..4}.wav`, по 8 фраз на голос. Они сделаны через
  `speech serve`, но PCM у них тот же. Прочие папки стенда не нужны: человек их удаляет.

Результат:
- цифры в журнал;
- записанные потоки JSON Lines — фикстуры для B05: обычный ответ, отмена, срыв (`stop: max_seconds`), `error`,
  `invalid_argument`, не-JSON строка.

Приёмка: протокол и цифры записаны (p50, p90 и максимум). B01 останавливает волну 1 и выносит вопрос человеку
(E1 под угрозой), если первый слышимый отсчёт через worker, без доставки до острова:
- p50 > 200 мс;
- или p90 > 1 с.

Отдельные замеры выше 300 мс при хорошем p50 волну не останавливают: E1 задан по перцентилям.

**B02. Спайк промпта.** Вне репозитория, по образцу спайка §6.4 спеки помощника. Новый текст `assistantPrompt`:
- метка `[[mood]]` в начале **каждого** предложения;
- строка рода для `female`, `male` и `neutral`.

Проверка — три модели помощника (Haiku, `glm-5.3-flash`, лёгкая Codex):
- 48 ответов на модель: доля предложений с меткой и что получается при пропуске;
- 10 вопросов по-русски на каждый род: согласован ли род.

Приёмка (вход для B06p):
- метка в ≥ 95 % предложений у каждой модели;
- род согласован в ≥ 9/10 ответов (порог G1).

Не прошло — B02 приносит человеку альтернативный текст, B06p ждёт. Волны 1–2 B02 не держит: B06 пишет текст из
#9 §6.8 и спеки помощника, B06p лишь правит формулировку.

### Волна 1

**B03. Поставка speech.cpp.**
- `scripts/fetch-speech.mjs` по образцу `fetch-whisper.mjs`:
  - константы `SPEECH_VERSION = '0.9.0'`, `SPEECH_COMMIT = '49f022a4…'`, `GGML_COMMIT = 'cbdeccfd…'` (полные значения —
    B01, m-1348);
  - архив тега не содержит подмодуль ggml, а побайтовой стабильности архивов GitHub не обещает. Поэтому исходник
    берётся `git clone` и `submodule update` на закреплённых коммитах, и оба коммита сверяются. Для справки — sha256
    архивов: speech.cpp `0064e868…7f37`, ggml `03f75173…0b50`;
  - сборка cmake только для arm64: Metal, встроенная библиотека шейдеров, статически, без `-march=native`;
  - вывод в `build/speech/darwin-arm64/` (`bin/speech`, `libspeech`, `LICENSE`, лицензии сторонних частей);
  - отпечаток флагов; повторный запуск — без сборки.
  - Для x64 скрипт ничего не собирает (решение человека: Intel — только текст).
- `package.json`: скрипт `fetch-speech`.
- `release.yml`: шаг `fetch-speech arm64` после `fetch-whisper`.
- `electron-builder.yml`: `extraResources` `build/speech/darwin-${arch}` → `speech`. На x64 каталога нет, и
  electron-builder только предупреждает, как с whisper.
- `NOTICE`:
  - speech.cpp (MIT), ggml (MIT), сторонние части из сборки;
  - Qwen3-TTS — Apache-2.0, «Qwen Team, Alibaba Cloud»;
  - текст Apache-2.0 Qwen3-TTS — файл `src/main/assistant/licenses/Qwen3-TTS-LICENSE.txt`, взятый из `LICENSE`
    официального репозитория `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` на закреплённом коммите (вместе с `NOTICE`, если
    он там есть); в `electron-builder.yml` — запись `from: src/main/assistant/licenses/Qwen3-TTS-LICENSE.txt`,
    `to: licenses/Qwen3-TTS-LICENSE.txt`, как у шрифтов.

Приёмка E7:
- `fetch-speech.test.ts` (по образцу `fetch-whisper.test.ts`): константы, проверка sha256, отпечаток, x64 пропускается;
- `release-config.test.ts`: шаг релиза, `extraResources` движка и файла лицензии Qwen3-TTS.

Команды:
- `pnpm --dir packages/desktop exec vitest run src/fetch-speech.test.ts src/release-config.test.ts`;
- живьём один раз: `pnpm --filter @parley/desktop fetch-speech arm64`.

**B04. Каталог голосов и хранилище весов.**
- `shared/tts-types.ts`:
  - модель `qwen3-tts-0.6b-q8_0`: файл, байты, sha256, URL, закреплённый на коммит HF;
  - для разработки — `sakasegawa/Qwen3-TTS-12Hz-0.6B-CustomVoice-GGUF`, коммит
    `fd9df9364613a92a86b4137074bc281204823033`, 1 213 534 464 байт, sha256 `f606ea39…8cc6`. Это собственный каталог
    speech.cpp (`tools/catalog/catalog.json` v0.9.0, m-1348). Этот же файл — и для релиза (О-1 решён, m-1381).
  - `AssistantVoice` из #9 §6.8:
    - `id` `qwen3-0.6b/<speaker>`, `name`, `engine`, `gender`;
    - `languages: ['ru', 'en']`, `licence: 'Apache-2.0'`;
    - `downloaded`, `sizeMb`, а также `modelId` и `gain` (Р4, Р6);
  - пять голосов, `DEFAULT_VOICE = 'qwen3-0.6b/serena'`.
- `main/voice/models.ts`: обобщить тип каталога `createModelStore`, чтобы он брал модель TTS. Поведение Whisper не
  меняется. Каталог TTS лежит в `~/.parley/desktop/voice/tts/`.

Приёмка G4 (данные):
- у всех голосов есть род, языки и лицензия;
- голосов без лицензии на распространение нет;
- serena — по умолчанию.

E5 (часть):
- скачивание идёт в `.part`, sha256 сверяется, проверяется место, отмена работает — тесты `models.test.ts` на модели TTS;
- тесты Whisper не меняются и остаются зелёными.

Команда: `vitest run src/shared/tts-types.test.ts src/main/voice/models.test.ts`.

**B05. Клиент `speech worker`** (`main/assistant/speech-worker.ts`).
- Запуск: зависимость `spawn` (по образцу `runEngine`). Путь к бинарю: `resolveSpeech` — `Resources/speech/bin/speech`
  в собранном приложении, `build/speech/darwin-arm64/bin/speech` в разработке, иначе `null`.
- Протокол: stdout — только JSON Lines, stderr — в журнал. Ожидание `ready`: чужой `protocol` или `fatal` — состояние
  `unavailable` с причиной.
- `synthesize({ id, text, voice, language, seed?, max_seconds })` → `AsyncIterable<Float32Array>`: PCM16 LE в
  base64 → `x / 32768`. Поток кончается ровно одним из `end`, `error` или `cancelled`.
- `cancel(id)`: своего ответа нет, ждём `cancelled`.
- `close()`: закрыть stdin и дождаться выхода с кодом 0; не вышел за 5 с — `SIGKILL` (Р5).
- Страж длины (исследование §6.5 п. 8):
  - лимит — `max(3 с, 0,1 с × символы) × 2`;
  - срыв → `cancel` и один повтор с новым seed; снова срыв — предложение пропускается.
- Тайм-ауты:
  - 20 с на предложение → `cancel`, затем `SIGKILL` и перезапуск;
  - строка stdout не JSON → перезапуск.
- `stop()` — `SIGKILL` (before-quit).

Приёмка:
- **E2** — фикстура срыва: повтор с новым seed, затем пропуск;
- **E3** — `cancel` уходит сразу, после `cancelled` кусков нет;
- **E6** — чужой протокол или `fatal`: `unavailable`, синтеза нет;
- не-JSON и тайм-аут → перезапуск;
- куски декодированы точно (заданные отсчёты).

Тесты — на фикстурах B01 с поддельным процессом. Команда: `vitest run src/main/assistant/speech-worker.test.ts`.

**B06. Core: `speakable`, метки по предложениям, промпт.** План 3, Task 1; #9 T11 (core), T13 (промпт). B02 не
ждёт.
- `text.ts`:
  - `speakable(text)` — как Task 1 плана 3, плюс срезка любых `[[…]]`;
  - `createMoodStripper()` — потоковый: принимает дельты и отдаёт `{ text, marks: { at, mood }[] }`. Метка, разрезанная
    между дельтами, держится в буфере до `MOOD_TAG_LIMIT`. Незнакомая метка срезается, но не даёт отметки.
- `launch.ts`: сигнатура `assistantPrompt(language, gender = 'female')`, строка «метка в начале каждого
  предложения» (#9 §6.7 L3) и строка рода дословно из #9 §6.8. Точную формулировку после спайка правит B06p.

Приёмка:
- **F3** (`speakable` срезает метки; разбор `[[joy]] … [[sad]] … ?` даёт две отметки на верных позициях; незнакомая
  метка не даёт отметки);
- **G1** (тест промпта на строку рода для трёх родов);
- тесты Task 1 плана 3;
- страж `english-text`: русские буквы — только в комментариях.

Команда: `pnpm --dir packages/core exec vitest run src/assistant/text.test.ts src/assistant/launch.test.ts`.

**B07. Движок звука и аудиограф острова** (#9 T1, §3.2–§3.4, §6.4).
- `sound/graph.ts` — один ленивый `AudioContext` окна острова:
  - шина сигналов → общая громкость (v²) → компрессор (−14 дБ, 4:1) → выход;
  - шина голоса → `AnalyserNode` (fftSize 2048) → та же общая громкость. Анализатор стоит только на голосе;
  - `duckVoice(0.3, 0.7 с)`, `setVolume` через `setTargetAtTime`.
- `synth.ts` — рецепты §3.1, до 6 осцилляторов на сигнал, `stop` по огибающей.
- `palettes.ts` — `soft`, `crystal`, `warm`.
- Сбой — одно `console.warn` на окно.
- Если E2E B25 (S6) покажет, что контекст не `running` без жеста, — `autoplayPolicy: 'no-user-gesture-required'` в
  `main/island/window.ts`. Решение принимается здесь: короткая проверка в dev-окне.

Приёмка (юнит, поддельный `AudioContext`):
- **S4** — 0 % и «выкл» не создают узлов; включение играет тихий `unmute`; громкость меняется через
  `setTargetAtTime`, без скачков значения (без щелчков);
- **S5** — палитры дают разные тоники и тембры;
- **V1** (граф) — анализатор подключён только к шине голоса;
- огибающие по времени; узлы останавливаются.

Команда: `vitest run src/renderer/island/sound/`.

**B08. Политика сигналов** (#9 T2, §3.5, §6.4). `sound/cues.ts` — чистая функция:
- ключи, остывание и слияние по виду, зазор 90/400 мс, бюджет Done 3/10 с, приоритет;
- правила под речью: интерфейс молчит, работа −10 дБ, внимание в полную силу + `duck`;
- счётчик `__parleyIslandCues`.

Приёмка **S3** (поддельные часы: 5 Done за 300 мс → 1 звук; разрешение через 340 мс звучит; 4-й Done за 10 с молчит),
повтор ключа молчит, приоритеты, **V2** (политика). Команда: `vitest run src/renderer/island/sound/cues.test.ts`.

**B09. Лицо в движке роя** (план 3, Task 8, без изменений). Порт макета:
- `face`, `EMO`, `DUR`, `blink` на втором потоке rng, `flash`, роли душ;
- `<Swarm mouth>` (B17 заменит его на `voice`, Р10), `data-emo`.

Приёмка — тесты Task 8 плана 3 и Review Focus 5. Детерминизм облака и сферы по seed сохранён. Команда: `vitest run
src/renderer/island/swarm/`.

### Волна 2

**B06p. Текст промпта по итогам B02.** Только `launch.ts` и его тест: формулировки строк «метка в каждом предложении»
и строки рода — те, что прошли B02. Если B02 прошёл на тексте B06, задача пустая и закрывается без коммита.
Приёмка — **G1** (тест промпта), пороги B02. Команда: `pnpm --dir packages/core exec vitest run
src/assistant/launch.test.ts`.

**B10. `TtsService`** (`main/assistant/tts.ts`; план 3, Task 2 — изменён).
- `speak({ utteranceId, text, voice, language }, sink)`: предложения синтезируются по очереди. Куски уходят в
  `sink(chunk)` как `{ utteranceId, seq, sampleRate: 24000, channels: 1, format: 'f32', pcm, final }`; к ним
  применяются `gain` голоса и ограничитель пика (Р4). Ведущая тишина срезается (Р4а).
- `cancel(utteranceId)`, `cancelAll()`.
- `state()`: `unavailable(reason)`, `not-downloaded`, `warming`, `ready`, `speaking`.
- `warmup()`; `voices()` — каталог B04 с флагом `downloaded`.
- Выгрузка через 15 мин простоя (Р5), зависимость `now`/таймер.
- Нет голоса для языка, x64 или `unavailable` → `speak` сразу отдаёт `final` без звука и состояние (Р8).
- `createFakeTtsService()` при `PARLEY_TTS=fake`: два куска тишины f32 по 0,2 с; `test-switches.ts` получает `tts`.

Приёмка:
- **E4** — выгрузка через 15 мин на поддельных часах; следующий `speak` снова запускает worker;
- **E5** — `warming` → `ready` после скачивания;
- **E1** (юнит) — первый кусок уходит в `sink` до конца синтеза предложения; куски ведущей тишины ниже порога не
  уходят, первый отправленный кусок слышим;
- **E3** — `cancel` останавливает поток;
- ограничитель: пик ≤ −1 dBFS на заданном буфере;
- fake отдаёт куски.

Команда: `vitest run src/main/assistant/tts.test.ts src/main/test-switches.test.ts`.

**B11. Хост и протокол: метки по предложениям и род** (Р2, Р3; #9 T11 хост, T13).
- `protocol/src/assistant.ts`: `AssistantState.moods?`; в схеме `assistant.configure` (`AssistantSettings`) —
  `voiceGender?: 'female' | 'male' | 'neutral'` (Р3). `assistant.ask` не меняется.
- `assistant-service.ts`: `createMoodStripper` вместо одной `splitMood`.
  - `answer` без меток, `moods` растёт; `mood` — первая метка, как раньше.
  - Сброс на `tool` (`answer: ''`) сбрасывает и `moods`.
  - Род берётся из зеркала `configure()` (без поля — `female`) и передаётся в `assistantPrompt`. Хост помнит род,
    с которым шёл разговор. Если он сменился, а разговор жив, следующий ход **любого происхождения** (остров,
    Telegram, напоминание) получает строку `[system: voice changed — speak as …]`.
- Telegram получает чистый `answer` без правок своего кода.

Приёмка:
- **F3** (хост: в `answer` нет `[[`, `moods` на позициях предложений; метка, разрезанная между дельтами, срезана);
- **G1** (тест строки `[system: voice changed …]` только при смене рода; вопрос из Telegram при `voiceGender: 'male'`
  в зеркале не переключает род и не даёт лишней строки);
- тесты сброса разговора не меняются.

Команда: `pnpm --dir packages/host exec vitest run src/assistant/assistant-service.test.ts src/methods/assistant.test.ts`.

**B12. Настройки звука и движения** (#9 T3, §5). Поля `ui.json` и их нормализация:
- `island.sound.palette`, `island.sound.volume`, `island.sound.ui`, `island.motion`.

`IslandConfig.islandSound = { needs, finished, palette, volume, ui }` и `motion` (#9 §5): `sound` заменяется на
`islandSound.needs`, а `finished` берётся из `notifications.finishedSound` — по нему B19 решает про звук Done (S2).
Остальное:
- main шлёт их в `island:config`;
- блок «Island» в Settings → Notifications: палитра с примером, ползунок громкости, «Interface sounds», «Reduce
  motion»;
- строки UI;
- `IslandApp.tsx`: одна строка в `present()` (:365–366) — `config.sound` → `config.islandSound.needs`, чтобы `tsc`
  остался зелёным. Саму ветку `beep` снимает B19.
- Пример палитры играет в главном окне: Settings живёт там, а графа острова там нет. Звучит `synth.ts` и
  `palettes.ts` (B07) на собственном ленивом `AudioContext` окна — тот же приём, что у `renderer/attention/chime.ts`.

Приёмка — тесты нормализации (чужие значения → умолчания), диалога, **S5** (выбор сохраняется и играет пример).
Ветка `beep` в `present()` теперь читает `islandSound.needs` (тест `IslandApp.test`).
Команда: `vitest run src/shared/ui-types.test.ts src/renderer/components/settings/SettingsDialog.test.tsx
src/renderer/island/IslandApp.test.tsx`.

**B13. Реакции роя** (#9 T5, §4.1–§4.3, §7). Работает поверх лица B09:
- `pulse`; `breathe`, `glint`, `hop`, `nod`, `spin`, `shake`, `lean`;
- в малом рое и в лице — только вспышка (V3).

Приёмка: **M1**, **V3**, **P1** (покой: 0 кадров; `needsFrame()` = false после реакции), детерминизм по seed. Тест
центровки (§4.2): после каждой реакции центр роя остаётся в `cx`/`cy`, души сдвигаются только относительно него.
Команда:
`vitest run src/renderer/island/swarm/`.

**B14. Проигрыватель речи** (`assistant/speaker.ts`; план 3, Task 5 — изменён).
- Интерфейс `enqueue(chunk)`, `stop`, `mouth`, `speaking`, `onIdle`, плюс для лица (Р10)
  `read(time, freq): boolean` и `onStart(cb(utteranceId))`.
- Куски одного `utteranceId` встают встык по `currentTime`.
- `AudioBuffer` строится с `sampleRate` куска; выход — шина голоса B07.
- `stop()` глушит в тот же такт.

Приёмка:
- тесты Task 5 плана 3 на кусках;
- **E1** (стык: второй кусок начинается ровно в конце первого);
- **E3** (после `stop` нет новых источников);
- **V1** (сигнал на шине сигналов не меняет `mouth()` и данные `read`);
- `onStart` зовётся один раз на первом куске каждого `utteranceId`; `read` даёт `false`, когда голос молчит.

Команда: `vitest run src/renderer/island/assistant/speaker.test.ts`.

### Волна 3

**B15. Мост голоса** (план 3, Task 3 — изменён; #9 T12, main).
- `ui-types`: `assistant.speak` (выкл), `assistant.voice` — id каталога или `null` (= `DEFAULT_VOICE`).
- `IslandConfig.assistant.speech = { enabled, voice, gender, available }`.
- Поток:
  - main создаёт `MessageChannelMain` на каждое окно острова и отдаёт порт только ему (`fromIsland`);
  - `preload/island.ts` пересылает порт в главный мир через `window.postMessage(…, [port])` — песочница
    `contextIsolation` не даёт отдать порт через `contextBridge`.
- Каналы:
  - `island:tts-speak` (invoke: `{ utteranceId, text ≤ 2000, voice, language }`), `island:tts-cancel`,
    `island:tts-warmup`, `island:assistant-speak`;
  - `island:tts-chunk` и `island:tts-state` — через порт;
  - `app:assistant-voices`, `app:assistant-voice-download` с прогрессом, `app:assistant-voice-state`.
- `main/index.ts`: служба (fake или настоящая), `stop()` в before-quit.
- `main/assistant-mirror.ts`: зеркало `assistant.configure` получает `voiceGender` из выбранного голоса каталога (Р3)
  и уходит при каждом сохранении `ui.json`.

Приёмка:
- тесты плана 3, Task 3, на новых каналах: не от острова → `forbidden`, 2001 знак → `bad_request`;
- порт отдаётся только окну острова;
- `island:assistant-speak` пишет `ui.json`;
- **G4** (на чистой установке голос = serena);
- **G3** (нескачанный: `available: false`, ничего не качается само);
- **G1** (зеркало): смена `assistant.voice` на ryan шлёт `configure` с `voiceGender: 'male'`.

Команда: `vitest run src/shared/ui-types.test.ts src/main/island/ipc.test.ts src/main/ipc.test.ts
src/preload/island.test.ts src/main/assistant-mirror.test.ts`.

**B16. Очередь предложений и фразы** (план 3, Task 6; #9 T11 — остров, T14).
- `createSentenceFeed`: как в плане 3, плюс у каждого предложения есть эмоция. Последняя отметка `moods` ≤ начала
  предложения, затем откат:
  - нет отметки — эмоция прошлого предложения, у первого — `calm`;
  - не больше одной смены на предложение;
  - предложение короче 1,2 с (оценка по длине текста) эмоцию не меняет.
- `spokenPhrase('sent', language, gender)`.

Приёмка:
- **F3** (откат и порог 1,2 с);
- **G2** («Отправила.», «Отправил.», «Отправлено.», «Sent.»);
- тесты плана 3, Task 6, включая Review Focus 1.

Команда: `vitest run src/renderer/island/assistant/speech-queue.test.ts src/renderer/island/assistant/spoken.test.ts`.

**B17. L1 — формы рта и пороги** (#9 T9, §6.7).
- `voice-features.ts` — чистые функции по `createVoiceAnalysis` прототипа (с строки 561): полосы, самонормировка,
  веса и сглаживание; анализатор читается только пока звучит голос. Тип `VoiceFrame` и `step(...)` — по Р10.
- `engine.ts` и `Swarm.tsx`: проп `voice: () => VoiceFrame | null` вместо `mouth` из B09; смешивание формы с высотой
  в `face()` и пороги F5 по `Swarm.face()` прототипа (строки 366–390).
- `voiceMode: 'loudness' | 'full'` — внутренний флаг движка для теста F1 («только громкость» = v1 плана 3), без UI:
  переключатель есть только в прототипе (#9 §11.10).

Приёмка:
- **F1** — заданные буферы «а», «и», «у» и пауза; за 50 мс вес меняется ≤ 0,6; режим громкости = v1;
- **F5** — 6 эмоций × формы, длина и толщина по перцентилям;
- **F4** — бюджет ≤ 0,5 мс на кадр, замер в тесте на заданном буфере; итог на M1 — в B26;
- **F4, reduced motion** — L1 выключен: лицо статично, рот `amp 0,3`, без моргания и вспышки (юнит-тест).

Команда: `vitest run src/renderer/island/assistant/voice-features.test.ts src/renderer/island/swarm/`.

### Волна 4

**B18. Движение формы** (#9 T6, §4.4–§4.5).
- Кривые роста и сжатия, `RETRACT_MORPH_MS` 300, класс по площади.
- `motion: 'reduce'` = системный reduced motion.

Приёмка **M2** (тест выбора класса, hit-rect после `transitionend`), **M3**. Команда: `vitest run
src/renderer/island/IslandView.test.tsx src/renderer/island/IslandApp.test.tsx`.

**B20. Settings → Assistant: голос** (план 3, Task 4 — изменён; #9 T12, UI).
- «Speak answers»; список голосов языка с родом, языками и лицензией.
- «Download (1214 MB)» с прогрессом, затем `Preparing voice…` до `ready` (Р7).
- Атрибуция Qwen3-TTS.
- На x64 или для языка без голоса — строка о том, что голос недоступен.

Приёмка:
- **G4** (UI);
- **G3** — без загрузки нет авто-скачивания;
- **E5** — прогресс и состояния;
- E2E `dialogs-layout.spec.ts` — секция помещается в 800×500.

Команда: `vitest run src/renderer/components/settings/AssistantSettings.test.tsx`.

**B21. L2 — интонация** (#9 T10). F0, ударный импульс, яркость по громкости, моргание в паузе, вопрос по тону и по «?».
Поля L2 в `VoiceFrame` (`pulse`, `eyesUp`, `blink`); вопрос по тексту — вход `ask: boolean` у `step` (его считает
B22 по тексту предложения), поэтому от B16 задача не зависит.

Приёмка: **F2** (все четыре пункта), **F4**. При reduced motion L2 выключен: нет импульса, моргания в паузе и
подъёма глаз (юнит-тест). Команда: `vitest run src/renderer/island/assistant/voice-features.test.ts
src/renderer/island/swarm/`.

### Волна 5

**B19. Проводка сигналов и снятие `beep`** (#9 T4, §3.6–§3.7).
- `useIslandCues`:
  - подписка на `IslandPresentationOutcome` из `present()`: ветка `else if (config.sound …) beep()` заменяется вызовом
    хука, проп `onPresentation` остаётся;
  - свои фронты: начало работы, наведение, открыть/закрыть, фазы помощника, `decide`;
  - вход `speaking()` — пока `() => false`, подключает B22.
- Done звучит, только если `expand === true` и включено «Sound when an agent finishes». `soundEligible` запросов не
  переопределяется.
- `island:beep` снимается: renderer, preload, shared, main.
- `notify.ts`: баннер Done без звука, если Done сыграл остров.

Приёмка:
- **S1** — ключ звучит один раз, `shell.beep` не вызывается;
- **S2** — тихий Done молчит; баннер без звука;
- тесты хука и `IslandApp.test`.

Команда: `vitest run src/renderer/island/useIslandCues.test.ts src/renderer/island/IslandApp.test.tsx
src/renderer/attention/notify.test.ts src/main/island/ipc.test.ts src/preload/island.test.ts`.

**B23. «Место» в карточке** (#9 T7, О3). Рой 30 px в шапке карточки: подскок или кивок и кольцо, пока карточка
открыта; в покое 0 к/с.

Приёмка — тест разметки, 0 кадров в покое. Команда: `vitest run src/renderer/island/IslandView.test.tsx`.

### Волна 6

**B22. Стор острова: речь** (план 3, Task 7 — изменён; #9 T11, стор; G3, V2).
Поведение — по сценариям макета, как в Task 7 плана 3. Отличия:
- **Синтез и куски:**
  - предложения уходят в `island:tts-speak` по мере ответа;
  - куски копятся по `utteranceId` и играют после конца ответа, в порядке предложений.
- **Отмена** (Esc, сброс очереди, выключение динамика) → `speaker.stop()` и `island:tts-cancel` всех `utteranceId`
  хода.
- **Путь к лицу (Р10):** `sentence = { utteranceId, emo, text }` обновляется по `speaker.onStart` из данных очереди
  B16; `voiceFrame()` читает `speaker.read` и зовёт `step(…, ask)`, где `ask` — текст кончается на «?».
- **Эмоция по предложению (L3):** `swarm/spec.ts` — `swarmSpecFor(host, input, mini, sentenceMood?)`, эмоция лица —
  `sentenceMood ?? host.mood`; лицо меняет эмоцию на старте предложения.
- **Голос недоступен:** `available: false` или `state` ≠ `ready` после тайм-аута → текст без лица. В режиме помощника
  один раз за сессию показывается строка `Voice "Serena" isn't downloaded — open Settings` (G3). Когда голос готов,
  следующий ответ звучит.
- **Прогрев:** `island:tts-warmup` при включении речи и при открытии режима помощника — только если речь включена и
  веса скачаны (Р5).
- **Сигналы:** в `useIslandCues` подключается `speaker.speaking()` (§6.4).

Приёмка:
- тесты Task 7 плана 3 и Review Focus 2–4;
- **F3** — `sentence.emo` меняется на `onStart` второго предложения; `swarmSpecFor` с `sentenceMood: 'sad'` даёт
  лицо `sad` при `host.mood: 'joy'`; смена — за 0,6 с; при reduced motion — без перехода (юнит-тесты);
- **F2** (путь) — для предложения на «?» `step` получает `ask: true`;
- **G3**;
- **V2** — при речи разрешение звучит и вызывает `duckVoice`;
- **E3** — Esc отменяет и в worker, и локально.

Команда: `vitest run src/renderer/island/assistant/store.test.ts src/renderer/island/assistant/labels.test.ts
src/renderer/island/IslandApp.test.tsx src/renderer/island/swarm/spec.test.ts`.

### Волна 7

**B24. Виды** (план 3, Task 9). Как в плане 3, плюс:
- `pulse` в `MiniSwarm` и рое помощника;
- путь к лицу (Р10): `AssistantView` передаёт `voice={store.voiceFrame}` в `<Swarm>` и `sentence?.emo` в
  `swarmSpecFor`; `IslandApp` пробрасывает их.

Приёмка — тесты Task 9 плана 3; `data-emo` на canvas меняется вслед за `sentence.emo`; геттер `voice` зовётся в кадре
(фейковый rAF); снимки `shots-assistant.mjs` в журнал. Команда: `vitest run
src/renderer/island/assistant/AssistantView.test.tsx src/renderer/island/IslandView.test.tsx
src/renderer/island/IslandApp.test.tsx`.

### Остров в вырезе (#10)

**B27. Датчик выреза и место окна** (#9 T15, §12.2–§12.4; волна 4).
- `notch-probe.ts`:
  - JXA через `execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT])`, `execFile` — зависимость, вне
    потока main, тайм-аут 2 с;
  - из `NSScreen.screens` берутся `NSScreenNumber`, `frame`, `safeAreaInsets.top`, `auxiliaryTopLeftArea` и
    `auxiliaryTopRightArea`;
  - вырез: `nw = frame.width − left − right`, `nh = top`, центр `left + nw/2`; проверка `0 < nw < frame.width`,
    `0 < nh ≤ 64`;
  - дисплей Electron сопоставляется по `NSScreenNumber`, иначе по размеру;
  - кеш по дисплею; ошибка, тайм-аут или мусор → `null` и одно `console.warn` за сессию.
  - Источник геометрии — по ответу на Н-1. До ответа берётся рекомендация спеки: JXA.
- `placement.ts`: тип `NotchGeometry`; `islandBounds` центрирует кадр по центру выреза; `notchInset` берёт высоту
  выреза из геометрии, без неё — как сейчас.
- `window.ts`: контроллер хранит геометрию дисплея, `notch()`; `relayout()` после нового замера.
- `main/index.ts`: замер при старте, на `display-added` и `display-removed`, а на `display-metrics-changed` — только
  если `changedMetrics` содержит `bounds` или `scaleFactor` (разрешение, «Больше места»). Изменение одного `workArea`
  бывает при каждом показе Dock или строки меню и при каждом входе в полный экран — оно замера не запускает. Замеры
  схлопываются с задержкой 250 мс. `notch` уходит в `island:config`, только если точка `center` (Н-3).
- `test-switches.ts`: `PARLEY_NOTCH=185x32` — подменная геометрия для E2E.
- `shared/island.ts`: `IslandConfig.notch?: { width; height; centerX } | null`. Отсутствие поля = `null`. Поле
  необязательное, чтобы B27 не правил фикстуры `IslandConfig`: `IslandApp.test.tsx` в волне 4 принадлежит B18. Спека
  §12.7 пишет обязательное поле — отличие только в типе.

Приёмка (юнит с подменным `execFile`):
- **N1** (разбор, проверка чисел, сопоставление дисплея, тайм-аут, `null` при мусоре);
- **N2** — без геометрии полоса и прежний отступ;
- **N6** (main) — кадр у верхнего края, центр по вырезу;
- **N7** (юнит) — геометрия не зависит от `workArea`;
- **N8** (main) — замер на `display-added`/`removed` и на `display-metrics-changed` с `bounds` или `scaleFactor`; с одним
  `workArea` — без замера; серия событий даёт один замер (юнит);
- **N9** — `left` и `right` дают `notch: null`.

Команда: `vitest run src/main/island/notch-probe.test.ts src/main/island/placement.test.ts
src/main/island/window.test.ts src/main/test-switches.test.ts`.

**B28. Форма выреза в renderer** (#9 T16, §12.1, §12.3, §12.5; волна 8).
- `NotchEars.tsx`:
  - левое ухо — мини-рой 24 px по правилам `mini` (только вспышка, 0 к/с в покое);
  - правое ухо — один статус по приоритету: ошибка → ждёт N → работает N → `✅ N`;
  - уши одной ширины: `ear = max(h + 4, ширина статуса + 18)`.
- `IslandView.tsx`:
  - виды «уши» и «голый вырез»;
  - выдвинутые виды начинают содержимое ниже выреза, `min-width = nw + 2·ear`.
- `IslandTab.tsx` (тест `IslandTab.test.tsx` — новый): зона убранного острова — прямоугольник выреза или уши.
- Смена `config.notch` (другой дисплей, новый замер) применяет новый размер **без класса перехода** — форма меняется
  мгновенно (N8, §12.4).
- `IslandApp.tsx`: наведение выдвигает форму, уход курсора возвращает уши; область под мышь — по форме.
- `island.css`: вогнутые плечи 6 px; скругления 10 px у ушей и 22 px у выдвинутых видов; уменьшенное движение.
- `strings.ts`: подписи ушей для чтения с экрана.
- Высота формы — по ответу на Н-2. До ответа берётся рекомендация спеки: высота выреза.

Приёмка:
- **N3** — ширина и равенство ушей, центр ±0,5 pt, высота `nh`, голый вырез;
- **N4** — рой и приоритет статуса, 0 к/с в покое;
- **N5** — выдвижение по кривым §4.4 и возврат ушей;
- **N6** (renderer) — уши ловят мышь только в своём прямоугольнике;
- **N10** — уменьшенное движение по §12.5;
- **N8** (renderer) — смена `notch` с выреза на `null` и обратно даёт новый размер без класса перехода (юнит).

Команда: `vitest run src/renderer/island/NotchEars.test.tsx src/renderer/island/IslandView.test.tsx
src/renderer/island/IslandTab.test.tsx src/renderer/island/IslandApp.test.tsx`.

### Волна 9

**B25. E2E, замеры, документы** (план 3, Task 10; #9 T8, T17).
- **E2E `assistant.spec.ts`** с `PARLEY_TTS=fake`, `PARLEY_VOICE=fake`, стабом агента с метками в каждом предложении:
  - сценарии Task 10 плана 3;
  - эмоция меняется между предложениями (`data-emo`);
  - в тексте острова нет `[[`;
  - нескачанный голос → текст и строка-подсказка (G3);
  - **G1**: смена голоса на мужской посреди разговора — стаб агента получает вопрос со строкой
    `[system: voice changed — speak as male]`.
- **E2E `island-sound.spec.ts`:**
  - **S6** — `AudioContext` острова в состоянии `running` без жеста;
  - **S1–S3** по `__parleyIslandCues`;
  - **V1–V3**.
- **E2E `island.spec.ts` с `PARLEY_NOTCH=185x32`** (#9 T17): N3–N5 — уши, выдвижение, возврат; без переменной —
  полоса (N2). N8 в E2E нет: Playwright не меняет дисплеи, а `PARLEY_NOTCH` задаётся при запуске. N8 покрывают
  юниты B27/B28 и ручная проверка §7 п. 11.
- **Документы:**
  - README — раздел помощника: голос, скачивание, звуки острова;
  - `CHANGELOG.md` — по-английски;
  - спека помощника: отметки «сделано», расхождения 3b;
  - `TODOS.md`: голосовой диалог, Telegram-голос, uk/kk/be, Intel;
  - README — остров в вырезе.
- **L1 и N11 (лицензия, решение человека m-1381):**
  - в репозитории нет файлов звуков и чужих ассетов;
  - ничто в отслеживаемых файлах не указывает на референсные приложения: ни имён, ни путей, ни ссылок;
  - проверка запускается **снаружи репозитория**: список имён из решения человека (m-1381) лежит вне репозитория
    (`rea-lab/island-scrub-names.txt`), команда — `git grep -n -i -f <список>` по всей ветке (`packages`, `docs`,
    `TODOS.md`, `NOTICE`, `README.md`, `CHANGELOG.md`). Тест внутри репозитория со списком имён нарушил бы само
    правило;
  - код референсных приложений **не переносится дословно**: берутся только приёмы (тайминги, кривые, правила тишины),
    а реализация — своя. Поэтому строки атрибуции в `NOTICE` нет. Дословный перенос запрещён: B07, B13 и B18
    пишут формулы сами.

Команды:
- `pnpm build && pnpm typecheck && pnpm lint && LC_ALL=C pnpm -r --workspace-concurrency=1 test`;
- `pnpm --dir packages/desktop exec playwright test e2e/assistant.spec.ts e2e/island-sound.spec.ts e2e/island.spec.ts
  e2e/dialogs-layout.spec.ts` — три зелёных прогона подряд.

**B26. Ручные проверки человека** — §7.

### Покрытие приёмки

| ID | Задачи |
|---|---|
| S1, S2 | B19, B25 |
| S3 | B08, B25 |
| S4, S5 | B07, B12 |
| S6 | B07, B25 |
| V1 | B07, B14, B25 |
| V2 | B08, B22, B25 |
| V3 | B13, B25 |
| F1, F5 | B17, B26 |
| F2 | B21, B22 (путь «?»), B24 |
| F3 | B06, B06p, B11, B16, B22, B24, B02 (спайк), B25 |
| F4 | B17, B21, B26 |
| G1 | B06, B06p, B11, B15, B02, B25 (E2E со стабом), B26 |
| G2 | B16 |
| G3 | B15, B20, B22, B25 |
| G4 | B04, B15, B20 |
| M1 | B13 |
| M2, M3 | B18 (форма); M3 и reduced motion лица — B17, B21, B22 |
| P1 | B13, B00, B26 |
| L1 | B25 |
| E1 | B01, B10, B14, B26 |
| E2 | B05 |
| E3 | B05, B10, B14, B22, B26 |
| E4 | B10, B26 |
| E5 | B04, B10, B20, B26 |
| E6 | B05, B10 |
| E7 | B03 |
| N1, N2, N9 | B27 |
| N3, N4, N5, N10 | B28, B25 (N3–N5) |
| N6 | B27, B28, B26 |
| N7 | B27, B26 |
| N8 | B27, B28, B26 |
| N11 | B00d, B25 |
| План 3, Review Focus 1–5 | B16 (1), B22 (2–4), B09 (5) |

## 6. Проверки по задачам и общий прогон

- Исполнитель гоняет тесты своей задачи (команда в задаче) и `pnpm typecheck` и присылает вывод интегратору.
- Интегратор после каждой волны: `pnpm build && pnpm typecheck && pnpm lint && LC_ALL=C pnpm -r
  --workspace-concurrency=1 test`.
- E2E на fake TTS не требует ни движка, ни сети, ни весов: CI остаётся без speech.cpp и GGUF.
- Живой тест движка — `main/assistant/speech-worker.live.test.ts` по образцу `voice-engine.live.test.ts`. Он
  пропускается без `build/speech` и GGUF; человек запускает его в B26.

## 7. Ручные проверки (B26, человек на Mac, dev-окно)

1. **Голос:** скачать Q8_0 из Settings. Видны прогресс и `Preparing voice…`. Первый ответ звучит без перезапуска.
2. **Прослушивание** — динамики и наушники, ru и en:
   - пять голосов; serena — по умолчанию;
   - числа и время («18:30», «4 минуты 12 секунд»);
   - длинный ответ — срыва нет, или страж его ловит;
   - акцент на длинном ответе (риск 7.4 п. 5).
3. **E1** — первый звук на прогретом движке: от `island:tts-speak` до первого слышимого куска, полученного островом
   (точка из §3.2а). 20 фраз ru и en; p50 ≤ 300 мс, p90 ≤ 1 с; p50, p90 и максимум — в журнал.
4. **Род** — G1 вживую: три модели, по 10 вопросов на род, ≥ 9/10. Шаблон «Отправила» у serena и «Отправил» у ryan.
5. **Лицо:** эмоции меняются по предложениям; рот читается всегда (F5); вопрос поднимает глаза. Reduced motion —
   статично.
6. **Палитры:** «Мягкая», «Хрусталь», «Тёплая» — на динамиках и в наушниках. Громкость без щелчков. Под речью
   разрешение слышно и приглушает голос.
7. **Движение:** рост с перелётом, сжатие без него; реакции на пачку «5 Done».
8. **Выгрузка:** через 15 мин простоя RSS worker уходит. Следующий ответ звучит, задержку прячет ответ.
9. **CPU на M1** (P1, F4): покой с пилюлей — как «до» (допуск 0,5 п. п.); «5 Done» — не выше занятого мини-роя;
   лицо с L1–L2 — в журнал.
10. **Esc** во время речи — звук обрывается сразу (E3). Хоткей во время речи только раскрывает остров.
11. **Остров в вырезе** (#9 T17, ручные):
    - N1 на MacBook Pro 14″: датчик даёт 185 × 32 ± 1, внешний монитор — `null`;
    - N1 на 16″ (числа не мерили): записать, что вернул датчик, проверить правдоподобие (`0 < nw < frame.width`,
      `nh ≤ 64`) и что уши стоят вровень с настоящим вырезом;
    - приложение на весь экран (N7);
    - закрытая крышка, внешний монитор, «Больше места» (N8);
    - клики мимо формы доходят до строки меню и приложений (N6).
12. **Чек-лист T11 острова** (`rea-lab/island-t11-demo/`), отложенный человеком до выпуска (m-1360), — в том же
    сеансе, на сборке 3b. Его итог — условие влития обеих веток.

## 8. Риски и открытые вопросы

**Риски.**

1. **Зрелость speech.cpp:** молодой проект, один автор. Закреплённый тег, сборка из исходников, протокол
   сверяется (E6). Режим worker на стенде не мерили — это B01 до волны 1.
2. **Холодный `ready`** — около 14 с на компиляцию шейдеров Metal (один замер, первый запуск). Кэш шейдеров не
   задокументирован: долгий старт может повториться, например после обновления macOS. Его прячут прогрев и
   `Preparing voice…` при любом `ready` дольше ~2 с (Р7).
3. **Память:** около 1,2–1,4 ГБ RSS, пока worker жив. Выгрузка через 15 мин (Р5).
4. **Срыв длины:** страж с одним повтором (E2). Остаточный риск — пропущенное предложение: текст на острове
   остаётся.
5. **Модели не ставят метку в каждом предложении или не держат род** — B02 идёт в волне 0, его итог правит
   B06p. Откат L3 безопасен: при пропуске метки остаётся прошлая эмоция.
6. **`MessagePort` через изолированный preload** — `window.postMessage` с передачей порта. Если не выйдет,
   запасной путь — `webContents.postMessage` с `Float32Array` через IPC (копирование, без смены шва). Решает B15.
7. **Длинная цепочка правок `IslandApp.tsx` и `IslandView.tsx`** (B18 → B19 → B22 → B24) — поэтому волны идут
   последовательно.

**Ответы человека (m-1381, через s-21).**

- **О-1.** Веса — GGUF из каталога speech.cpp (`sakasegawa`, ревизия `fd9df936…`, sha256 `f606ea39…`). Сами не
  конвертируем, релиз этим не блокируется.
- **О-2.** Метка эмоции в каждом предложении — согласовано.
- **О-3.** Два необязательных поля протокола хоста (`AssistantState.moods`, `AssistantSettings.voiceGender` в
  `assistant.configure`) — согласовано.
- **О-4.** Worker — дочерний процесс main, а не `utilityProcess` — согласовано.
- **О-5.** Остаётся как написано: человек сливает или коммитит свою правку `NOTICE` в `master` до влития 3b; правка
  B03 приходит через ветку.
- **О-6.** E1 = p50 ≤ 300 мс и p90 ≤ 1 с (§3.2а).
- Ветка острова переименована в `feat/island-agents` (тот же `7c03432f`, прежнее имя удалено).
- Ничто в репозитории не указывает на референсные приложения (B00d, L1 и N11 в B25).
- **Решение за человеком — история `master`.** Коммит `9a6a5cf0` в опубликованной истории `master` называет
  референсное приложение в сообщении. Чистка файлов этого не убирает: нужна перезапись истории `master`
  (force-push). План этого не делает и не обещает. Остаток принимается как есть, пока человек не решит иначе.

**Открытые вопросы к человеку** (код до ответа не блокируют):

- **Н-1…Н-3 (#9 §12.8, остров в вырезе).** До ответа B27/B28 следуют рекомендациям спеки.
  - Н-1 — источник геометрии: датчик `osascript` (рекомендация), свой нативный помощник или таблица моделей.
  - Н-2 — высота ушей: по вырезу (рекомендация) или по строке меню.
  - Н-3 — остров у левого или правого края на дисплее с вырезом: полоса (рекомендация) или всегда вырез.
