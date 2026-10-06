# Голосовой ввод: план реализации

> **Для исполнителей-агентов:** обязательный навык — superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans; задачи выполняются по одной. Шаги отмечены флажками (`- [ ]`).

**Цель:** кнопка микрофона и ⌘⇧M в полях окна Parley: речь распознаёт локальный whisper.cpp, текст встаёт в поле и сам не отправляется.

**Устройство:**
- окно записывает PCM 16 кГц через AudioWorklet и отдаёт его главному процессу по IPC;
- главный процесс пишет временный WAV и запускает `whisper-cli` из `Contents/Resources/whisper`;
- модели (base, small, large-v3-turbo q5) человек скачивает в Settings → Voice, в `~/.parley/desktop/voice/models`;
- общий store диктовки держит одну запись на окно и раздаёт текст целям: полю комнаты, полю чата, первому промпту «New workspace», терминалу сессии.

**Стек:** Electron 3x + React + zustand (окно), Node 22 (main), vitest + jsdom, Playwright; whisper.cpp v1.9.4 (cmake, Metal на arm64), Silero VAD v6.2.0.

**Спека:** `docs/specs/2026-10-06-voice-input-design.md`. План опирается на неё. Исполнитель читает оба файла.

**Где работать:** worktree `.claude/worktrees/voice-input`, ветка `feat/voice-input`. После свежего `pnpm install` — сначала `pnpm build`: без сборки `@parley/core` тесты `protocol` и окна не находят пакет. Исходный прогон 2026-10-06: core 1777, protocol 88, host 839/840 (флейк `works-service` под нагрузкой, отдельно 8/8), desktop 4616.

## Глобальные ограничения

- Голос выключен по умолчанию: `ui.json` → `voice: { enabled: false, model: null, language: 'auto' }`.
- Все видимые строки окна — по-английски, в `packages/desktop/src/shared/strings.ts`. Тест `english-ui.test.ts` ловит кириллицу в литералах исходников окна: строки с русскими галлюцинациями Whisper помечаются `// cyrillic-ok: <почему>` на той же строке.
- Комментарии в коде, названия тестов и описания коммитов — по-русски, как во всём репозитории. Коммиты — `feat(desktop): …`, `test(desktop): …`, `build(desktop): …`, `docs(…): …` и строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Текст расшифровки никогда не отправляется сам: в поле — на место курсора, в PTY — `sendToAgent(…, submit: false)`.
- Одна запись на окно. Пока идёт распознавание, новая запись не начинается ни в одной цели.
- Предел записи — 2 минуты (`MAX_RECORDING_MS = 120_000`). Таймаут движка — 60 с плюс длина записи.
- whisper.cpp: тег `v1.9.4`, sha256 архива `57e280cee375ab02425b806ad5146b99f6eb9357e3c2b31357c8a6af2e2e44ae`.
- Модель VAD: `ggml-silero-v6.2.0.bin`, 885 098 байт, sha256 `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987`, из `https://huggingface.co/ggml-org/whisper-vad/resolve/main/`.
- Модели (API Hugging Face, 2026-10-06):

  | id | файл | байт | sha256 |
  |---|---|---|---|
  | `base` | `ggml-base.bin` | 147951465 | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` |
  | `small` | `ggml-small.bin` | 487601967 | `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` |
  | `large-v3-turbo-q5_0` | `ggml-large-v3-turbo-q5_0.bin` | 574041195 | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` |

- Аргументы движка (сверены по `examples/cli/cli.cpp` v1.9.4): `-m <модель> -f <wav> -l <язык|auto> -nt -np -sns --vad -vm <модель VAD>`. Текст сегментов печатается в stdout и с `-np`: этот флаг глушит только журнал.
- Горячая клавиша — `CmdOrCtrl+Shift+M`, подпись — «⌘⇧M».
- Папка моделей — `path.join(parleyHome(), 'desktop', 'voice', 'models')`.
- Тестовый переключатель `PARLEY_VOICE=fake` работает только в неупакованном окне или при `PARLEY_E2E=1`, как остальные в `main/test-switches.ts`.

## Фокус ревью

Пять случаев, которые спека подразумевает, а прямые тесты задач легко пропустят. Под каждый добавлен тест в задаче-владельце:

1. **Каретка в середине многострочного текста.** Расшифровка встаёт ровно на место курсора, с одним пробелом слева, если перед курсором нет пробела. Текст справа от курсора не теряется. Тест — задача 10, `insert.test.ts`.
2. **Двойной клик по микрофону, пока идёт проверка доступа.** Начинается одна запись, а не две. Тест — задача 8, «два toggle подряд до старта».
3. **Двойной «Download» одной модели.** Скачивание одно; второй вызов получает тот же результат. Тест — задача 5.
4. **Цель исчезла во время распознавания** (вкладку закрыли). Текст уходит в буфер обмена, появляется тост. Тест — задача 8.
5. **Выбранную модель удалили руками.** Распознавание отвечает `model_missing`, тост ведёт в настройки, движок не запускается. Тесты — задачи 4 и 8.

---

## Задача 0. Этап 0: сборка движка и замеры (проба, без кода продукта)

Сверить на машине то, на что опираются задачи 4 и 12: сборку whisper.cpp под обе архитектуры, флаги, вывод, VAD и задержку. Итог — отчёт. Код продукта эта задача не трогает.

Из раздела 9 спеки сюда не входят два пункта: запись 16 кГц в Electron и системный запрос микрофона (пункт 5), порог тишины (пункт 6). Для них нужно окно и живой микрофон, поэтому они проверяются в задаче 7 (сборка worklet) и в задаче 14 (живая проверка).

**Файлы:**
- Создать: `docs/research/2026-10-06-voice-input-stage0.md`
- Рабочие файлы — только в scratchpad сессии, не в репозитории.

- [ ] **Шаг 1. Проверить cmake.**

  Выполнить `cmake --version`. Если команды нет — спросить пользователя и только с его согласия выполнить `brew install cmake`. Без cmake задача останавливается.

- [ ] **Шаг 2. Скачать исходник и сверить sha256.**

```bash
S="$SCRATCH/whisper-stage0"; mkdir -p "$S" && cd "$S"
curl -sL -o whisper.tar.gz https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.4.tar.gz
shasum -a 256 whisper.tar.gz   # ждём 57e280cee375ab02425b806ad5146b99f6eb9357e3c2b31357c8a6af2e2e44ae
tar -xzf whisper.tar.gz
```

- [ ] **Шаг 3. Собрать arm64 и x64 теми же флагами, что задача 12.**

```bash
SRC="$S/whisper.cpp-1.9.4"
COMMON="-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_SDL2=OFF -DGGML_NATIVE=OFF -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0"
cmake -S "$SRC" -B "$S/build-arm64" $COMMON -DCMAKE_OSX_ARCHITECTURES=arm64 -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON
cmake --build "$S/build-arm64" --config Release --target whisper-cli -j
cmake -S "$SRC" -B "$S/build-x64" $COMMON -DCMAKE_OSX_ARCHITECTURES=x86_64 -DGGML_METAL=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON
cmake --build "$S/build-x64" --config Release --target whisper-cli -j
ls -la "$S"/build-*/bin/whisper-cli; lipo -archs "$S"/build-arm64/bin/whisper-cli "$S"/build-x64/bin/whisper-cli
otool -L "$S"/build-arm64/bin/whisper-cli   # только системные библиотеки и фреймворки, без dylib из сборки
```

  Ожидание: два бинаря, `arm64` и `x86_64`, без зависимостей на `libwhisper*.dylib` и `libggml*.dylib`. Записать размеры.

- [ ] **Шаг 4. Скачать модели и VAD, сверить sha256** — с таблицей из «Глобальных ограничений».

```bash
cd "$S"
for f in ggml-base.bin ggml-small.bin ggml-large-v3-turbo-q5_0.bin; do curl -sL -o "$f" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$f"; done
curl -sL -o ggml-silero-v6.2.0.bin https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin
shasum -a 256 ggml-*.bin
```

- [ ] **Шаг 5. Подготовить фразы.**

  Взять русский голос: `say -v '?' | grep ru_RU` — первый из списка, например Milena.

```bash
say -v Samantha -o en.aiff "Refactor the authentication middleware to use the new token validation helper"
say -v Milena -o ru.aiff "Перепиши модуль авторизации, чтобы он использовал новый помощник проверки токенов"
for n in en ru; do afconvert -f WAVE -d LEI16@16000 -c 1 $n.aiff $n.wav; done
python3 - <<'EOF'
import wave
for name, seconds in (('silence', 5),):
    with wave.open(f'{name}.wav', 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b'\0\0' * 16000 * seconds)
src = wave.open('ru.wav', 'rb'); frames = src.readframes(src.getnframes()); src.close()
with wave.open('ru60.wav', 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(frames * max(1, int(60 * 16000 * 2 / len(frames))))
EOF
```

- [ ] **Шаг 6. Прогнать флаги и замерить.**

```bash
B="$S/build-arm64/bin/whisper-cli"; V="$S/ggml-silero-v6.2.0.bin"
for m in base small large-v3-turbo-q5_0; do for w in en ru ru60 silence; do
  /usr/bin/time -p "$B" -m "$S/ggml-$m.bin" -f "$S/$w.wav" -l auto -nt -np -sns --vad -vm "$V" > "out-$m-$w.txt" 2> "err-$m-$w.txt"
  echo "$m $w exit=$? $(grep real "err-$m-$w.txt")"; cat "out-$m-$w.txt"
done; done
arch -x86_64 "$S/build-x64/bin/whisper-cli" -m "$S/ggml-small.bin" -f "$S/ru.wav" -l ru -nt -np -sns --vad -vm "$V"
```

  Проверить:
  - stdout — только текст, без журнала и таймстемпов;
  - на `silence.wav` — пусто или служебная метка;
  - `-l ru` против `-l auto` на короткой русской фразе;
  - время на всех трёх моделях;
  - x64 под Rosetta работает.

- [ ] **Шаг 7. Записать отчёт** `docs/research/2026-10-06-voice-input-stage0.md`: размеры бинарей, вывод, таблица времени (модель × фраза), качество русского, поведение на тишине. Если флаги или вывод расходятся с планом, поправить задачи 4 и 12 до их начала. Если turbo на 15-секундной фразе дольше 3 с, сообщить пользователю: это критерий 4 спеки.

- [ ] **Шаг 8. Закоммитить.**

```bash
git add docs/research/2026-10-06-voice-input-stage0.md
git commit -m "docs(research): голосовой ввод — этап 0: сборка whisper.cpp и замеры"
```

---

## Задача 1. Общие типы и каталог моделей

**Файлы:**
- Создать: `packages/desktop/src/shared/voice-types.ts`
- Тест: `packages/desktop/src/shared/voice-types.test.ts`

**Интерфейсы:**
- Отдаёт: `VoiceModelId`, `VoiceModel`, `VOICE_MODELS`, `VOICE_MODEL_BASE_URL`, `voiceModel(id)`, `voiceModelUrl(model)`, `isVoiceModelId(v)`, `VoiceLanguage`, `WHISPER_LANGUAGES`, `isVoiceLanguage(v)`, `TranscribeError`, `TranscribeResult`, `TranscribeRequest`, `DownloadResult`, `DownloadProgress`, `MicStatus`, `VoiceApi`.

- [ ] **Шаг 1. Написать падающий тест.**

```ts
// packages/desktop/src/shared/voice-types.test.ts
import { describe, expect, it } from 'vitest';
import { isVoiceLanguage, isVoiceModelId, VOICE_MODELS, voiceModel, voiceModelUrl, WHISPER_LANGUAGES } from './voice-types.js';

describe('каталог моделей голоса (спека 3.1)', () => {
  it('три модели в порядке вкладки Voice', () => {
    expect(VOICE_MODELS.map((model) => model.id)).toEqual(['base', 'small', 'large-v3-turbo-q5_0']);
  });

  it('sha256 — 64 hex, размер больше 100 МБ, файл ggml-*.bin', () => {
    for (const model of VOICE_MODELS) {
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.bytes).toBeGreaterThan(100_000_000);
      expect(model.file).toMatch(/^ggml-[a-z0-9._-]+\.bin$/);
    }
  });

  it('адрес — Hugging Face ggerganov/whisper.cpp', () => {
    expect(voiceModelUrl(voiceModel('small'))).toBe('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin');
  });

  it('isVoiceModelId пускает только ids каталога', () => {
    expect(isVoiceModelId('base')).toBe(true);
    expect(isVoiceModelId('large')).toBe(false);
    expect(isVoiceModelId(42)).toBe(false);
  });
});

describe('языки Whisper', () => {
  it('100 языков, коды уникальны, есть en и ru', () => {
    const codes = WHISPER_LANGUAGES.map((language) => language.code);
    expect(codes).toHaveLength(100);
    expect(new Set(codes).size).toBe(100);
    expect(codes).toEqual(expect.arrayContaining(['en', 'ru']));
  });

  it('isVoiceLanguage: auto и коды списка — да, прочее — нет', () => {
    expect(isVoiceLanguage('auto')).toBe(true);
    expect(isVoiceLanguage('ru')).toBe(true);
    expect(isVoiceLanguage('xx')).toBe(false);
    expect(isVoiceLanguage('ru --model x')).toBe(false);
    expect(isVoiceLanguage(null)).toBe(false);
  });
});
```

- [ ] **Шаг 2. Запустить — падает** (модуля нет).

  `pnpm --filter @parley/desktop exec vitest run src/shared/voice-types.test.ts` → FAIL: `Failed to resolve import "./voice-types.js"`.

- [ ] **Шаг 3. Реализовать.**

```ts
// packages/desktop/src/shared/voice-types.ts
/**
 * Голосовой ввод (спека 2026-10-06-voice-input-design.md): каталог моделей Whisper, языки, ответы движка и мост
 * `ParleyBridge.voice`. Лежит в `shared/`: каталог читают и main (скачивание и проверка), и окно (вкладка Voice).
 */

export type VoiceModelId = 'base' | 'small' | 'large-v3-turbo-q5_0';

export interface VoiceModel {
  id: VoiceModelId;
  /** Имя файла на Hugging Face и на диске. */
  file: string;
  /** Точный размер в байтах: прогресс, проверка места и целостности. */
  bytes: number;
  /** sha256 файла (LFS oid Hugging Face) — сверяется после скачивания. */
  sha256: string;
}

export const VOICE_MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/** Порядок — порядок строк вкладки Voice. Размеры и sha256 — API Hugging Face на 2026-10-06. */
export const VOICE_MODELS: readonly VoiceModel[] = [
  { id: 'base', file: 'ggml-base.bin', bytes: 147_951_465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' },
  { id: 'small', file: 'ggml-small.bin', bytes: 487_601_967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' },
  {
    id: 'large-v3-turbo-q5_0',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    bytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
  },
];

export function isVoiceModelId(value: unknown): value is VoiceModelId {
  return VOICE_MODELS.some((model) => model.id === value);
}

export function voiceModel(id: VoiceModelId): VoiceModel {
  const found = VOICE_MODELS.find((model) => model.id === id);
  if (found === undefined) throw new Error(`unknown voice model: ${id}`);
  return found;
}

export function voiceModelUrl(model: VoiceModel): string {
  return `${VOICE_MODEL_BASE_URL}/${model.file}`;
}

export interface VoiceLanguage {
  code: string;
  name: string;
}

/** Языки Whisper — таблица `g_lang` из `src/whisper.cpp` v1.9.4, по алфавиту английских имён. */
export const WHISPER_LANGUAGES: readonly VoiceLanguage[] = [
  ['af', 'Afrikaans'], ['sq', 'Albanian'], ['am', 'Amharic'], ['ar', 'Arabic'], ['hy', 'Armenian'], ['as', 'Assamese'],
  ['az', 'Azerbaijani'], ['ba', 'Bashkir'], ['eu', 'Basque'], ['be', 'Belarusian'], ['bn', 'Bengali'], ['bs', 'Bosnian'],
  ['br', 'Breton'], ['bg', 'Bulgarian'], ['yue', 'Cantonese'], ['ca', 'Catalan'], ['zh', 'Chinese'], ['hr', 'Croatian'],
  ['cs', 'Czech'], ['da', 'Danish'], ['nl', 'Dutch'], ['en', 'English'], ['et', 'Estonian'], ['fo', 'Faroese'],
  ['fi', 'Finnish'], ['fr', 'French'], ['gl', 'Galician'], ['ka', 'Georgian'], ['de', 'German'], ['el', 'Greek'],
  ['gu', 'Gujarati'], ['ht', 'Haitian Creole'], ['ha', 'Hausa'], ['haw', 'Hawaiian'], ['he', 'Hebrew'], ['hi', 'Hindi'],
  ['hu', 'Hungarian'], ['is', 'Icelandic'], ['id', 'Indonesian'], ['it', 'Italian'], ['ja', 'Japanese'], ['jw', 'Javanese'],
  ['kn', 'Kannada'], ['kk', 'Kazakh'], ['km', 'Khmer'], ['ko', 'Korean'], ['lo', 'Lao'], ['la', 'Latin'],
  ['lv', 'Latvian'], ['ln', 'Lingala'], ['lt', 'Lithuanian'], ['lb', 'Luxembourgish'], ['mk', 'Macedonian'], ['mg', 'Malagasy'],
  ['ms', 'Malay'], ['ml', 'Malayalam'], ['mt', 'Maltese'], ['mi', 'Maori'], ['mr', 'Marathi'], ['mn', 'Mongolian'],
  ['my', 'Myanmar'], ['ne', 'Nepali'], ['no', 'Norwegian'], ['nn', 'Nynorsk'], ['oc', 'Occitan'], ['ps', 'Pashto'],
  ['fa', 'Persian'], ['pl', 'Polish'], ['pt', 'Portuguese'], ['pa', 'Punjabi'], ['ro', 'Romanian'], ['ru', 'Russian'],
  ['sa', 'Sanskrit'], ['sr', 'Serbian'], ['sn', 'Shona'], ['sd', 'Sindhi'], ['si', 'Sinhala'], ['sk', 'Slovak'],
  ['sl', 'Slovenian'], ['so', 'Somali'], ['es', 'Spanish'], ['su', 'Sundanese'], ['sw', 'Swahili'], ['sv', 'Swedish'],
  ['tl', 'Tagalog'], ['tg', 'Tajik'], ['ta', 'Tamil'], ['tt', 'Tatar'], ['te', 'Telugu'], ['th', 'Thai'],
  ['bo', 'Tibetan'], ['tr', 'Turkish'], ['tk', 'Turkmen'], ['uk', 'Ukrainian'], ['ur', 'Urdu'], ['uz', 'Uzbek'],
  ['vi', 'Vietnamese'], ['cy', 'Welsh'], ['yi', 'Yiddish'], ['yo', 'Yoruba'],
].map(([code, name]) => ({ code: code as string, name: name as string }));

/** `auto` или код из `WHISPER_LANGUAGES`: в argv движка уходит только такое значение. */
export function isVoiceLanguage(value: unknown): value is string {
  return value === 'auto' || WHISPER_LANGUAGES.some((language) => language.code === value);
}

/** `no_speech` — пусто, тишина или галлюцинация (спека 6.1). */
export type TranscribeError = 'no_speech' | 'engine_missing' | 'model_missing' | 'failed';
export type TranscribeResult = { text: string } | { error: TranscribeError };

/** PCM — Int16 little-endian, моно, 16 кГц (`renderer/voice/recorder.ts`). */
export interface TranscribeRequest {
  pcm: ArrayBuffer;
  language: string;
  model: VoiceModelId;
}

export type DownloadResult =
  | { ok: true }
  | { error: 'disk_full'; needBytes: number }
  | { error: 'network' | 'corrupted' | 'cancelled' };

export interface DownloadProgress {
  id: VoiceModelId;
  receivedBytes: number;
  totalBytes: number;
}

export type MicStatus = 'granted' | 'denied' | 'restricted' | 'not-determined';

/** Мост `ParleyBridge.voice`: каналы `voice:*` (`main/voice/ipc.ts`). */
export interface VoiceApi {
  /** Скачанные модели целиком: файл на месте и нужного размера. */
  listModels(): Promise<VoiceModelId[]>;
  /** Повторный вызов для той же модели, пока она качается, отдаёт тот же результат. */
  downloadModel(id: VoiceModelId): Promise<DownloadResult>;
  cancelDownload(id: VoiceModelId): Promise<void>;
  removeModel(id: VoiceModelId): Promise<void>;
  onProgress(listener: (progress: DownloadProgress) => void): () => void;
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
  micStatus(): Promise<MicStatus>;
  /** Системный запрос доступа к микрофону; `true` — доступ есть. */
  requestMic(): Promise<boolean>;
  /** System Settings → Privacy & Security → Microphone. */
  openMicSettings(): Promise<void>;
}
```

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS (6 тестов).

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/shared/voice-types.ts packages/desktop/src/shared/voice-types.test.ts
git commit -m "feat(desktop): каталог моделей Whisper и типы голосового ввода"
```

---

## Задача 2. Настройки голоса в `ui.json`

**Файлы:**
- Изменить: `packages/desktop/src/shared/ui-types.ts` (`UiFile`, `DEFAULT_UI`, `normalizeUi`)
- Изменить: `packages/desktop/src/main/ui-store.ts` (`NESTED_KEYS`)
- Тесты: `packages/desktop/src/shared/ui-types.test.ts`, `packages/desktop/src/main/ui-store.test.ts`

**Интерфейсы:**
- Берёт: `isVoiceModelId`, `isVoiceLanguage`, `VoiceModelId` (задача 1).
- Отдаёт: `VoiceUi` (`{ enabled: boolean; model: VoiceModelId | null; language: string }`), `UiFile.voice`, `DEFAULT_UI.voice`.

- [ ] **Шаг 1. Написать падающие тесты.** В `ui-types.test.ts`:

```ts
describe('раздел voice (спека 4.1)', () => {
  it('по умолчанию выключен, модели нет, язык auto', () => {
    expect(normalizeUi({}).voice).toEqual({ enabled: false, model: null, language: 'auto' });
  });

  it('верные значения сохраняются', () => {
    expect(normalizeUi({ voice: { enabled: true, model: 'small', language: 'ru' } }).voice).toEqual({
      enabled: true,
      model: 'small',
      language: 'ru',
    });
  });

  it('чужая модель и язык — по умолчанию; включённый голос без модели — выключен', () => {
    expect(normalizeUi({ voice: { enabled: true, model: 'huge', language: 'xx' } }).voice).toEqual({
      enabled: false,
      model: null,
      language: 'auto',
    });
  });
});
```

  В `ui-store.test.ts` (рядом с тестом 2, тем же `createUiStore(file)`):

```ts
it('voice сохраняется и читается обратно; патч других полей его не трогает', async () => {
  const store = createUiStore(file);
  await store.save({ voice: { enabled: true, model: 'base', language: 'ru' } });
  await store.save({ appearance: 'dark' });
  expect((await store.load()).voice).toEqual({ enabled: true, model: 'base', language: 'ru' });
});
```

- [ ] **Шаг 2. Запустить — падает.**

  `pnpm --filter @parley/desktop exec vitest run src/shared/ui-types.test.ts src/main/ui-store.test.ts` → FAIL: `voice` is undefined.

- [ ] **Шаг 3. Реализовать.** В `ui-types.ts`:

```ts
import { isVoiceLanguage, isVoiceModelId, type VoiceModelId } from './voice-types.js';

/** Голосовой ввод (спека 2026-10-06-voice-input-design.md, 3.1): включён только при выбранной модели. */
export interface VoiceUi {
  enabled: boolean;
  model: VoiceModelId | null;
  /** `auto` или код Whisper (`WHISPER_LANGUAGES`). */
  language: string;
}
```

  Добавить в `UiFile` поле `voice: VoiceUi;` с JSDoc «Голосовой ввод (спека 2026-10-06, 3.1)». В `DEFAULT_UI` добавить `voice: { enabled: false, model: null, language: 'auto' },`. Рядом с `normalizeNotifications` положить:

```ts
function normalizeVoice(value: unknown): VoiceUi {
  const source = isRecord(value) ? value : {};
  const model = isVoiceModelId(source.model) ? source.model : null;
  return {
    // Включённый голос без модели нечем распознавать: это «выключен».
    enabled: source.enabled === true && model !== null,
    model,
    language: isVoiceLanguage(source.language) ? source.language : DEFAULT_UI.voice.language,
  };
}
```

  В `normalizeUi` после `dismissedUpdate` добавить `voice: normalizeVoice(source.voice),`. В `main/ui-store.ts` дописать `'voice'` в `NESTED_KEYS`.

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS. Затем `pnpm --filter @parley/desktop typecheck` → без ошибок. Если где-то в тестах объект `UiFile` собирается целиком без spread `DEFAULT_UI`, добавить ему `voice: DEFAULT_UI.voice`.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/shared/ui-types.ts packages/desktop/src/shared/ui-types.test.ts packages/desktop/src/main/ui-store.ts packages/desktop/src/main/ui-store.test.ts
git commit -m "feat(desktop): раздел voice в ui.json — выключен по умолчанию"
```

---

## Задача 3. WAV и фильтр результата (main)

**Файлы:**
- Создать: `packages/desktop/src/main/voice/wav.ts`, `packages/desktop/src/main/voice/result-filter.ts`
- Тесты: `packages/desktop/src/main/voice/wav.test.ts`, `packages/desktop/src/main/voice/result-filter.test.ts`

**Интерфейсы:**
- Отдаёт: `SAMPLE_RATE = 16_000`, `pcm16ToWav(pcm: Buffer, sampleRate?: number): Buffer`, `cleanTranscript(stdout: string): string | null` (`null` — речи нет).

- [ ] **Шаг 1. Написать падающие тесты.**

```ts
// packages/desktop/src/main/voice/wav.test.ts
import { describe, expect, it } from 'vitest';
import { pcm16ToWav } from './wav.js';

describe('pcm16ToWav', () => {
  it('заголовок RIFF/WAVE PCM 16 бит моно 16 кГц, данные следом', () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
    const wav = pcm16ToWav(pcm);
    expect(wav.length).toBe(44 + 6);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + 6);
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(wav.readUInt32LE(16)).toBe(16); // размер fmt
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // моно
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000); // байт в секунду
    expect(wav.readUInt16LE(32)).toBe(2); // выравнивание блока
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(6);
    expect([...wav.subarray(44)]).toEqual([1, 0, 2, 0, 3, 0]);
  });
});
```

```ts
// packages/desktop/src/main/voice/result-filter.test.ts
import { describe, expect, it } from 'vitest';
import { cleanTranscript } from './result-filter.js';

describe('cleanTranscript (спека 6.1)', () => {
  it('строки сегментов склеиваются через пробел, края обрезаются', () => {
    expect(cleanTranscript('  Refactor the middleware.\n Use the new helper.\n')).toBe('Refactor the middleware. Use the new helper.');
  });

  it('пусто и пробелы — речи нет', () => {
    expect(cleanTranscript('')).toBeNull();
    expect(cleanTranscript(' \n \n')).toBeNull();
  });

  it('только служебные метки в скобках — речи нет', () => {
    expect(cleanTranscript('[BLANK_AUDIO]')).toBeNull();
    expect(cleanTranscript(' (музыка) \n[Музыка]')).toBeNull();
  });

  it('известная галлюцинация целиком — речи нет, без учёта регистра и точек', () => {
    expect(cleanTranscript('Продолжение следует...')).toBeNull();
    expect(cleanTranscript('Субтитры сделал DimaTorzok')).toBeNull();
    expect(cleanTranscript('Thank you for watching!')).toBeNull();
  });

  it('фраза, где те же слова — часть текста, проходит', () => {
    expect(cleanTranscript('Продолжение следует после ревью API')).toBe('Продолжение следует после ревью API');
    expect(cleanTranscript('Say thank you for watching to the user')).toBe('Say thank you for watching to the user');
  });

  it('метка рядом с речью остаётся частью текста', () => {
    expect(cleanTranscript('Fix the build [BLANK_AUDIO]')).toBe('Fix the build [BLANK_AUDIO]');
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/main/voice/` → FAIL (модулей нет).

- [ ] **Шаг 3. Реализовать.**

```ts
// packages/desktop/src/main/voice/wav.ts
/** WAV для `whisper-cli` (спека 4.2): PCM Int16 little-endian, моно. Частота — как у записи окна. */

export const SAMPLE_RATE = 16_000;

export function pcm16ToWav(pcm: Buffer, sampleRate: number = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
```

```ts
// packages/desktop/src/main/voice/result-filter.ts
/**
 * Фильтр ответа `whisper-cli` (спека 6.1, третий заслон): Whisper на тишине и шуме выдаёт служебные метки и
 * «субтитровые» фразы из обучающих данных. Выбрасывается только результат, который целиком из них состоит:
 * фраза, где эти слова — часть текста, остаётся.
 */

/** Нормализованные (нижний регистр, без точек, многоточий, ! и ?, с одиночными пробелами) галлюцинации целиком. */
const HALLUCINATIONS: ReadonlySet<string> = new Set([
  'продолжение следует', // cyrillic-ok: известная галлюцинация Whisper на тишине
  'субтитры сделал dimatorzok', // cyrillic-ok: известная галлюцинация Whisper на тишине
  'субтитры создавал dimatorzok', // cyrillic-ok: известная галлюцинация Whisper на тишине
  'редактор субтитров асинецкая корректор аегорова', // cyrillic-ok: известная галлюцинация Whisper на тишине
  'thank you for watching',
  'thanks for watching',
]);

/** Только метки в квадратных или круглых скобках: `[BLANK_AUDIO]`, `(music)` и такие же по-русски. */
const ONLY_TAGS = /^(\s*(\[[^\]]*\]|\([^)]*\))\s*)+$/;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.…!?«»"',]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Текст сегментов одной строкой; `null` — речи нет. */
export function cleanTranscript(stdout: string): string | null {
  const text = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');
  if (text === '' || ONLY_TAGS.test(text)) return null;
  if (HALLUCINATIONS.has(normalize(text))) return null;
  return text;
}
```

- [ ] **Шаг 4. Запустить — проходит.** Затем `pnpm --filter @parley/desktop exec vitest run src/english-ui.test.ts` → PASS: кириллица помечена `cyrillic-ok`.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/main/voice/wav.ts packages/desktop/src/main/voice/wav.test.ts packages/desktop/src/main/voice/result-filter.ts packages/desktop/src/main/voice/result-filter.test.ts
git commit -m "feat(desktop): WAV для whisper-cli и фильтр галлюцинаций"
```

---

## Задача 4. Движок и распознавание (main)

**Файлы:**
- Создать: `packages/desktop/src/main/voice/engine.ts`, `packages/desktop/src/main/voice/transcribe.ts`
- Тесты: `packages/desktop/src/main/voice/engine.test.ts`, `packages/desktop/src/main/voice/transcribe.test.ts`

**Интерфейсы:**
- Берёт: `pcm16ToWav`, `SAMPLE_RATE` (задача 3), `cleanTranscript` (задача 3), `TranscribeRequest`, `TranscribeResult`, `VoiceModelId` (задача 1).
- Отдаёт:
  - `VAD_MODEL_FILE = 'ggml-silero-v6.2.0.bin'`;
  - `interface Engine { bin: string; vadModel: string }`;
  - `interface EngineLocation { isPackaged: boolean; resourcesPath: string; devDir: string; pathEnv: string | undefined; isFile(path: string): boolean }`;
  - `resolveEngine(location): Engine | null`, `isFileSync(path): boolean`;
  - `WAV_PREFIX = 'parley-voice-'`;
  - `whisperArgs(engine, { model, wav, language }): string[]`, `transcribeTimeoutMs(durationMs): number`;
  - `interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }`;
  - `type RunEngine = (bin: string, args: string[], timeoutMs: number) => Promise<RunResult>`, `runEngine: RunEngine`;
  - `interface TranscriberDeps`, `createTranscriber(deps): (request: TranscribeRequest) => Promise<TranscribeResult>`;
  - `removeStaleRecordings(dir: string): Promise<void>`.

- [ ] **Шаг 1. Написать падающие тесты.**

```ts
// packages/desktop/src/main/voice/engine.test.ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveEngine, VAD_MODEL_FILE } from './engine.js';

const files = (list: string[]) => (candidate: string): boolean => list.includes(candidate);

describe('resolveEngine (спека 4.2)', () => {
  it('упакованное окно: Resources/whisper/bin/whisper-cli и модель VAD рядом', () => {
    const resources = '/Applications/Parley.app/Contents/Resources';
    const bin = path.join(resources, 'whisper', 'bin', 'whisper-cli');
    const vad = path.join(resources, 'whisper', VAD_MODEL_FILE);
    expect(resolveEngine({ isPackaged: true, resourcesPath: resources, devDir: '/x', pathEnv: '/opt/homebrew/bin', isFile: files([bin, vad]) })).toEqual({ bin, vadModel: vad });
  });

  it('упакованное окно без движка — null, PATH не смотрится', () => {
    expect(resolveEngine({ isPackaged: true, resourcesPath: '/r', devDir: '/x', pathEnv: '/opt/homebrew/bin', isFile: files(['/opt/homebrew/bin/whisper-cli']) })).toBeNull();
  });

  it('разработка: сначала build/whisper, потом PATH; VAD — из build/whisper', () => {
    const vad = path.join('/dev/whisper', VAD_MODEL_FILE);
    const local = path.join('/dev/whisper', 'bin', 'whisper-cli');
    expect(resolveEngine({ isPackaged: false, resourcesPath: '/r', devDir: '/dev/whisper', pathEnv: '/opt/homebrew/bin', isFile: files([vad, local, '/opt/homebrew/bin/whisper-cli']) })).toEqual({ bin: local, vadModel: vad });
    expect(resolveEngine({ isPackaged: false, resourcesPath: '/r', devDir: '/dev/whisper', pathEnv: '/usr/bin:/opt/homebrew/bin', isFile: files([vad, '/opt/homebrew/bin/whisper-cli']) })).toEqual({ bin: '/opt/homebrew/bin/whisper-cli', vadModel: vad });
  });

  it('разработка без модели VAD — null', () => {
    expect(resolveEngine({ isPackaged: false, resourcesPath: '/r', devDir: '/dev/whisper', pathEnv: '/opt/homebrew/bin', isFile: files(['/opt/homebrew/bin/whisper-cli']) })).toBeNull();
  });
});
```

```ts
// packages/desktop/src/main/voice/transcribe.test.ts
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscribeRequest } from '../../shared/voice-types.js';
import { createTranscriber, removeStaleRecordings, transcribeTimeoutMs, whisperArgs, WAV_PREFIX, type RunEngine, type TranscriberDeps } from './transcribe.js';

const ENGINE = { bin: '/e/whisper-cli', vadModel: '/e/vad.bin' };
let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-voice-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Секунда тишины: 16 000 сэмплов Int16. */
const request = (overrides: Partial<TranscribeRequest> = {}): TranscribeRequest => ({
  pcm: new ArrayBuffer(32_000),
  language: 'ru',
  model: 'small',
  ...overrides,
});

function deps(run: RunEngine, overrides: Partial<TranscriberDeps> = {}): TranscriberDeps {
  return {
    engine: () => ENGINE,
    modelPath: (id) => `/models/ggml-${id}.bin`,
    exists: async () => true,
    run,
    tmpDir: dir,
    log: vi.fn(),
    ...overrides,
  };
}

describe('whisperArgs', () => {
  it('модель, файл, язык, без таймстемпов и журнала, VAD', () => {
    expect(whisperArgs(ENGINE, { model: '/m.bin', wav: '/t.wav', language: 'auto' })).toEqual([
      '-m', '/m.bin', '-f', '/t.wav', '-l', 'auto', '-nt', '-np', '-sns', '--vad', '-vm', '/e/vad.bin',
    ]);
  });

  it('таймаут — 60 с плюс длина записи', () => {
    expect(transcribeTimeoutMs(15_000)).toBe(75_000);
  });
});

describe('createTranscriber (спека 4.2, 6.4)', () => {
  it('успех: WAV во временной папке, текст через фильтр, WAV удалён', async () => {
    let seenArgs: string[] = [];
    const run: RunEngine = async (_bin, args) => {
      seenArgs = args;
      const wav = args[args.indexOf('-f') + 1] as string;
      expect(path.basename(wav).startsWith(WAV_PREFIX)).toBe(true);
      expect((await readdir(dir)).length).toBe(1);
      return { code: 0, stdout: ' Привет, мир\n', stderr: '', timedOut: false };
    };
    const transcribe = createTranscriber(deps(run));
    await expect(transcribe(request())).resolves.toEqual({ text: 'Привет, мир' });
    expect(seenArgs).toContain('/models/ggml-small.bin');
    expect(seenArgs.slice(seenArgs.indexOf('-l'), seenArgs.indexOf('-l') + 2)).toEqual(['-l', 'ru']);
    expect(await readdir(dir)).toEqual([]);
  });

  it('нет движка — engine_missing, ничего не запускается', async () => {
    const run = vi.fn<RunEngine>();
    await expect(createTranscriber(deps(run, { engine: () => null }))(request())).resolves.toEqual({ error: 'engine_missing' });
    expect(run).not.toHaveBeenCalled();
  });

  it('файла модели нет (удалён руками) — model_missing, движок не запускается', async () => {
    const run = vi.fn<RunEngine>();
    await expect(createTranscriber(deps(run, { exists: async () => false }))(request())).resolves.toEqual({ error: 'model_missing' });
    expect(run).not.toHaveBeenCalled();
  });

  it('ненулевой код — failed, stderr в журнал, WAV удалён', async () => {
    const log = vi.fn();
    const run: RunEngine = async () => ({ code: 3, stdout: '', stderr: 'boom', timedOut: false });
    await expect(createTranscriber(deps(run, { log }))(request())).resolves.toEqual({ error: 'failed' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(await readdir(dir)).toEqual([]);
  });

  it('таймаут — failed; таймаут считается от длины записи', async () => {
    let timeout = 0;
    const run: RunEngine = async (_bin, _args, ms) => {
      timeout = ms;
      return { code: null, stdout: '', stderr: '', timedOut: true };
    };
    await expect(createTranscriber(deps(run))(request())).resolves.toEqual({ error: 'failed' });
    expect(timeout).toBe(61_000);
  });

  it('тишина и галлюцинация — no_speech', async () => {
    const run: RunEngine = async () => ({ code: 0, stdout: 'Продолжение следует...\n', stderr: '', timedOut: false });
    await expect(createTranscriber(deps(run))(request())).resolves.toEqual({ error: 'no_speech' });
  });

  it('запуск бросил — failed, WAV удалён', async () => {
    const run: RunEngine = async () => {
      throw new Error('spawn ENOENT');
    };
    await expect(createTranscriber(deps(run))(request())).resolves.toEqual({ error: 'failed' });
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('removeStaleRecordings', () => {
  it('удаляет только parley-voice-*.wav', async () => {
    await writeFile(path.join(dir, `${WAV_PREFIX}old.wav`), '');
    await writeFile(path.join(dir, 'other.wav'), '');
    await removeStaleRecordings(dir);
    expect(await readdir(dir)).toEqual(['other.wav']);
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/main/voice/engine.test.ts src/main/voice/transcribe.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.**

```ts
// packages/desktop/src/main/voice/engine.ts
/**
 * Где движок голосового ввода (спека 4.2): у собранного окна — `Contents/Resources/whisper` (кладёт
 * `scripts/fetch-whisper.mjs`, задача 12 плана); в разработке — `build/whisper/darwin-<arch>`, а без него
 * `whisper-cli` из PATH (`brew install whisper-cpp`) с моделью VAD из того же `build/whisper`. Так же ищется node
 * для хоста (`host-launcher.ts`).
 */
import { statSync } from 'node:fs';
import path from 'node:path';

/** Модель VAD Silero — та, что кладёт `fetch-whisper.mjs` (сверяет `fetch-whisper.test.ts`). */
export const VAD_MODEL_FILE = 'ggml-silero-v6.2.0.bin';

export interface Engine {
  bin: string;
  vadModel: string;
}

export interface EngineLocation {
  isPackaged: boolean;
  resourcesPath: string;
  /** `build/whisper/darwin-<arch>` пакета окна. */
  devDir: string;
  /** PATH login-оболочки человека (`shell-env.ts`). */
  pathEnv: string | undefined;
  isFile(candidate: string): boolean;
}

export function isFileSync(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function resolveEngine(location: EngineLocation): Engine | null {
  if (location.isPackaged) {
    const dir = path.join(location.resourcesPath, 'whisper');
    const bin = path.join(dir, 'bin', 'whisper-cli');
    const vadModel = path.join(dir, VAD_MODEL_FILE);
    return location.isFile(bin) && location.isFile(vadModel) ? { bin, vadModel } : null;
  }
  const vadModel = path.join(location.devDir, VAD_MODEL_FILE);
  if (!location.isFile(vadModel)) return null;
  const local = path.join(location.devDir, 'bin', 'whisper-cli');
  if (location.isFile(local)) return { bin: local, vadModel };
  for (const dir of (location.pathEnv ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, 'whisper-cli');
    if (location.isFile(candidate)) return { bin: candidate, vadModel };
  }
  return null;
}
```

```ts
// packages/desktop/src/main/voice/transcribe.ts
/**
 * Распознавание записи (спека 4.2, 6.4): PCM окна → временный WAV (0600) → `whisper-cli` → текст через фильтр
 * галлюцинаций. WAV удаляется в `finally` при любом исходе; оставшиеся после падения окна подчищает
 * `removeStaleRecordings` при старте.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TranscribeRequest, TranscribeResult, VoiceModelId } from '../../shared/voice-types.js';
import type { Engine } from './engine.js';
import { cleanTranscript } from './result-filter.js';
import { pcm16ToWav, SAMPLE_RATE } from './wav.js';

export const WAV_PREFIX = 'parley-voice-';

export function whisperArgs(engine: Engine, input: { model: string; wav: string; language: string }): string[] {
  return ['-m', input.model, '-f', input.wav, '-l', input.language, '-nt', '-np', '-sns', '--vad', '-vm', engine.vadModel];
}

/** 60 с на загрузку модели и разгон плюс длина самой записи (спека 4.2). */
export function transcribeTimeoutMs(durationMs: number): number {
  return 60_000 + Math.ceil(durationMs);
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type RunEngine = (bin: string, args: string[], timeoutMs: number) => Promise<RunResult>;

/** stderr — только хвост: журнал движка на длинной записи большой, а нужен он лишь для диагностики. */
const MAX_STDERR = 64_000;

export const runEngine: RunEngine = (bin, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${String(error)}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

export interface TranscriberDeps {
  engine(): Engine | null;
  modelPath(id: VoiceModelId): string;
  exists(file: string): Promise<boolean>;
  run: RunEngine;
  tmpDir: string;
  log(message: string): void;
}

export function createTranscriber(deps: TranscriberDeps): (request: TranscribeRequest) => Promise<TranscribeResult> {
  return async (request) => {
    const engine = deps.engine();
    if (engine === null) return { error: 'engine_missing' };
    const model = deps.modelPath(request.model);
    if (!(await deps.exists(model))) return { error: 'model_missing' };
    const pcm = Buffer.from(request.pcm);
    const durationMs = (pcm.length / 2 / SAMPLE_RATE) * 1000;
    const wav = path.join(deps.tmpDir, `${WAV_PREFIX}${randomUUID()}.wav`);
    try {
      await writeFile(wav, pcm16ToWav(pcm), { mode: 0o600 });
      const result = await deps.run(engine.bin, whisperArgs(engine, { model, wav, language: request.language }), transcribeTimeoutMs(durationMs));
      if (result.timedOut || result.code !== 0) {
        deps.log(`whisper-cli ${result.timedOut ? 'timed out' : `exited with ${String(result.code)}`}: ${result.stderr}`);
        return { error: 'failed' };
      }
      const text = cleanTranscript(result.stdout);
      return text === null ? { error: 'no_speech' } : { text };
    } catch (error) {
      deps.log(`whisper-cli failed: ${error instanceof Error ? error.message : String(error)}`);
      return { error: 'failed' };
    } finally {
      await rm(wav, { force: true }).catch(() => undefined);
    }
  };
}

/** Записи, оставшиеся после падения окна посреди распознавания (спека 4.2, «Уборка при старте»). */
export async function removeStaleRecordings(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => name.startsWith(WAV_PREFIX) && name.endsWith('.wav'))
      .map((name) => rm(path.join(dir, name), { force: true }).catch(() => undefined)),
  );
}
```

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/main/voice/engine.ts packages/desktop/src/main/voice/engine.test.ts packages/desktop/src/main/voice/transcribe.ts packages/desktop/src/main/voice/transcribe.test.ts
git commit -m "feat(desktop): запуск whisper-cli — поиск движка, WAV, таймаут, ошибки"
```

---

## Задача 5. Модели: скачивание, проверка, удаление (main)

**Файлы:**
- Создать: `packages/desktop/src/main/voice/models.ts`
- Тест: `packages/desktop/src/main/voice/models.test.ts`

**Интерфейсы:**
- Берёт: `VOICE_MODELS`, `VoiceModel`, `voiceModelUrl`, `DownloadResult`, `DownloadProgress`, `VoiceModelId` (задача 1).
- Отдаёт:
  - `voiceModelsDir(home?: string): string`;
  - `freeBytes(dir: string): Promise<number>`;
  - `interface ModelStoreDeps { dir: string; fetch(url: string, init: { signal: AbortSignal }): Promise<Response>; freeBytes(dir: string): Promise<number>; catalog?: readonly VoiceModel[] }`;
  - `interface ModelStore { list(): Promise<VoiceModelId[]>; path(id): string; download(id, onProgress): Promise<DownloadResult>; cancel(id): void; remove(id): Promise<void> }`;
  - `createModelStore(deps): ModelStore`.

- [ ] **Шаг 1. Написать падающий тест.**

```ts
// packages/desktop/src/main/voice/models.test.ts
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceModel } from '../../shared/voice-types.js';
import { createModelStore, voiceModelsDir, type ModelStoreDeps } from './models.js';

const CONTENT = Buffer.from('fake whisper model bytes');
const CATALOG: readonly VoiceModel[] = [
  { id: 'base', file: 'ggml-base.bin', bytes: CONTENT.length, sha256: createHash('sha256').update(CONTENT).digest('hex') },
  { id: 'small', file: 'ggml-small.bin', bytes: 4, sha256: '0'.repeat(64) },
];
let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-models-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ok = (body: Uint8Array): Promise<Response> => Promise.resolve(new Response(body));

function store(overrides: Partial<ModelStoreDeps> = {}) {
  return createModelStore({ dir, catalog: CATALOG, fetch: () => ok(CONTENT), freeBytes: async () => 10 ** 12, ...overrides });
}

describe('voiceModelsDir', () => {
  it('~/.parley/desktop/voice/models от дома Parley', () => {
    expect(voiceModelsDir('/home/p')).toBe(path.join('/home/p', 'desktop', 'voice', 'models'));
  });
});

describe('createModelStore (спека 4.2, 6.2)', () => {
  it('скачивание: прогресс, проверка sha256, файл на месте, .part нет, модель в списке', async () => {
    const progress = vi.fn();
    const models = store();
    await expect(models.download('base', progress)).resolves.toEqual({ ok: true });
    expect(progress).toHaveBeenLastCalledWith({ id: 'base', receivedBytes: CONTENT.length, totalBytes: CONTENT.length });
    expect(await readdir(dir)).toEqual(['ggml-base.bin']);
    await expect(models.list()).resolves.toEqual(['base']);
  });

  it('sha256 не совпал — corrupted, ничего не осталось', async () => {
    const models = store({ fetch: () => ok(Buffer.from('evil')) });
    await expect(models.download('small', vi.fn())).resolves.toEqual({ error: 'corrupted' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('ответ не 200 — network', async () => {
    const models = store({ fetch: () => Promise.resolve(new Response('no', { status: 404 })) });
    await expect(models.download('base', vi.fn())).resolves.toEqual({ error: 'network' });
  });

  it('обрыв посреди потока — network, .part удалён', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(CONTENT.subarray(0, 4));
        controller.error(new Error('ECONNRESET'));
      },
    });
    const models = store({ fetch: () => Promise.resolve(new Response(body)) });
    await expect(models.download('base', vi.fn())).resolves.toEqual({ error: 'network' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('места меньше размера + 10 % — disk_full с нужным числом байт, fetch не зовётся', async () => {
    const fetch = vi.fn();
    const models = store({ fetch, freeBytes: async () => 1 });
    await expect(models.download('base', vi.fn())).resolves.toEqual({ error: 'disk_full', needBytes: Math.ceil(CONTENT.length * 1.1) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancel — cancelled, .part удалён', async () => {
    let started = false;
    const fetch: ModelStoreDeps['fetch'] = (_url, init) =>
      new Promise((_resolve, reject) => {
        started = true;
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const models = store({ fetch });
    const pending = models.download('base', vi.fn());
    // Отмена — когда запрос уже ушёл: до fetch идут mkdir и проверка места.
    await vi.waitFor(() => expect(started).toBe(true));
    models.cancel('base');
    await expect(pending).resolves.toEqual({ error: 'cancelled' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('повторный download той же модели — тот же промис, fetch один раз (Фокус ревью, 3)', async () => {
    const fetch = vi.fn(() => ok(CONTENT));
    const models = store({ fetch });
    const [first, second] = await Promise.all([models.download('base', vi.fn()), models.download('base', vi.fn())]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('list не видит .part и файлы чужого размера; remove удаляет файл', async () => {
    await writeFile(path.join(dir, 'ggml-base.bin.part'), 'x');
    await writeFile(path.join(dir, 'ggml-small.bin'), 'too long for small');
    const models = store();
    await expect(models.list()).resolves.toEqual([]);
    await models.download('base', vi.fn());
    await models.remove('base');
    await expect(models.list()).resolves.toEqual([]);
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/main/voice/models.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.**

```ts
// packages/desktop/src/main/voice/models.ts
/**
 * Модели Whisper на диске (спека 4.2, 6.2): `~/.parley/desktop/voice/models` рядом с `ui.json`. Скачивание —
 * `net.fetch` main (системный прокси, переадресации Hugging Face на CDN) в `<файл>.part`, sha256 по ходу потока,
 * затем переименование. Обрыв, отмена и чужой sha256 удаляют `.part`; докачки нет. Одна модель качается один раз:
 * повторный вызов получает тот же промис.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { parleyHome } from '@parley/core';
import {
  VOICE_MODELS,
  voiceModelUrl,
  type DownloadProgress,
  type DownloadResult,
  type VoiceModel,
  type VoiceModelId,
} from '../../shared/voice-types.js';

export function voiceModelsDir(home: string = parleyHome()): string {
  return path.join(home, 'desktop', 'voice', 'models');
}

export async function freeBytes(dir: string): Promise<number> {
  const info = await statfs(dir);
  return info.bavail * info.bsize;
}

export interface ModelStoreDeps {
  dir: string;
  fetch(url: string, init: { signal: AbortSignal }): Promise<Response>;
  freeBytes(dir: string): Promise<number>;
  /** Подмена каталога в тестах; по умолчанию `VOICE_MODELS`. */
  catalog?: readonly VoiceModel[];
}

export interface ModelStore {
  list(): Promise<VoiceModelId[]>;
  path(id: VoiceModelId): string;
  download(id: VoiceModelId, onProgress: (progress: DownloadProgress) => void): Promise<DownloadResult>;
  cancel(id: VoiceModelId): void;
  remove(id: VoiceModelId): Promise<void>;
}

/** Прогресс — не чаще раза на мегабайт: окну не нужны тысячи событий на модель в полгигабайта. */
const PROGRESS_STEP = 1024 * 1024;
/** Запас места сверх размера модели (спека 6.2). */
const DISK_MARGIN = 1.1;

export function createModelStore(deps: ModelStoreDeps): ModelStore {
  const catalog = deps.catalog ?? VOICE_MODELS;
  const inflight = new Map<VoiceModelId, { controller: AbortController; promise: Promise<DownloadResult> }>();

  const modelOf = (id: VoiceModelId): VoiceModel => {
    const found = catalog.find((model) => model.id === id);
    if (found === undefined) throw new Error(`unknown voice model: ${id}`);
    return found;
  };
  const filePath = (id: VoiceModelId): string => path.join(deps.dir, modelOf(id).file);

  const fetchModel = async (model: VoiceModel, controller: AbortController, onProgress: (p: DownloadProgress) => void): Promise<DownloadResult> => {
    await mkdir(deps.dir, { recursive: true });
    const needBytes = Math.ceil(model.bytes * DISK_MARGIN);
    if ((await deps.freeBytes(deps.dir)) < needBytes) return { error: 'disk_full', needBytes };
    const final = path.join(deps.dir, model.file);
    const part = `${final}.part`;
    try {
      const response = await deps.fetch(voiceModelUrl(model), { signal: controller.signal });
      if (!response.ok || response.body === null) return { error: 'network' };
      const hash = createHash('sha256');
      let received = 0;
      let reported = 0;
      const out = await open(part, 'w', 0o600);
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          await out.write(chunk);
          hash.update(chunk);
          received += chunk.length;
          if (received - reported >= PROGRESS_STEP) {
            reported = received;
            onProgress({ id: model.id, receivedBytes: received, totalBytes: model.bytes });
          }
        }
      } finally {
        await out.close();
      }
      onProgress({ id: model.id, receivedBytes: received, totalBytes: model.bytes });
      if (received !== model.bytes || hash.digest('hex') !== model.sha256) {
        await rm(part, { force: true });
        return { error: 'corrupted' };
      }
      await rename(part, final);
      return { ok: true };
    } catch {
      await rm(part, { force: true });
      return { error: controller.signal.aborted ? 'cancelled' : 'network' };
    }
  };

  return {
    async list() {
      const present: VoiceModelId[] = [];
      for (const model of catalog) {
        const info = await stat(path.join(deps.dir, model.file)).catch(() => null);
        if (info !== null && info.isFile() && info.size === model.bytes) present.push(model.id);
      }
      return present;
    },
    path: filePath,
    download(id, onProgress) {
      const running = inflight.get(id);
      if (running !== undefined) return running.promise;
      const controller = new AbortController();
      const promise = fetchModel(modelOf(id), controller, onProgress).finally(() => inflight.delete(id));
      inflight.set(id, { controller, promise });
      return promise;
    },
    cancel(id) {
      inflight.get(id)?.controller.abort();
    },
    async remove(id) {
      await rm(filePath(id), { force: true });
    },
  };
}
```

- [ ] **Шаг 4. Запустить — проходит.** Та же команда → PASS (9 тестов). Если тест отмены зависает, проверить: подменённый `fetch` должен отклоняться на `abort`.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/main/voice/models.ts packages/desktop/src/main/voice/models.test.ts
git commit -m "feat(desktop): скачивание моделей Whisper — прогресс, sha256, место, отмена"
```

---

## Задача 6. Микрофон, IPC, мост и подмена для E2E

**Файлы:**
- Создать: `packages/desktop/src/main/voice/mic.ts`, `packages/desktop/src/main/voice/services.ts`, `packages/desktop/src/main/voice/ipc.ts`
- Изменить: `packages/desktop/src/main/test-switches.ts`, `packages/desktop/src/main/index.ts`, `packages/desktop/src/preload/index.ts`, `packages/desktop/src/shared/bridge.ts`, `packages/desktop/src/renderer/test-utils/fake-bridge.ts`
- Тесты: `packages/desktop/src/main/voice/mic.test.ts`, `packages/desktop/src/main/voice/services.test.ts`, `packages/desktop/src/main/voice/ipc.test.ts`, `packages/desktop/src/main/test-switches.test.ts`, `packages/desktop/src/preload/index.test.ts`

**Интерфейсы:**
- Берёт: `ModelStore`, `createModelStore`, `voiceModelsDir`, `freeBytes` (задача 5); `createTranscriber`, `runEngine`, `removeStaleRecordings` (задача 4); `resolveEngine`, `isFileSync`, `Engine` (задача 4); `VoiceApi` и другие типы (задача 1).
- Отдаёт:
  - `normalizeMicStatus(raw: string): MicStatus`, `MIC_SETTINGS_URL`;
  - `interface VoiceServices { listModels(); download(id, onProgress); cancel(id); remove(id); transcribe(request); micStatus(): MicStatus; requestMic(): Promise<boolean>; openMicSettings(): Promise<void> }`;
  - `createVoiceServices(deps)`, `createFakeVoiceServices(text)`;
  - `MAX_PCM_BYTES`, `toArrayBuffer(value): ArrayBuffer | null`, `registerVoiceIpc({ ipcMain, services })`;
  - `TestSwitches.voice: boolean`;
  - `ParleyBridge.voice: VoiceApi`, `FakeBridge.voiceCalls`, `FakeBridge.setVoiceModels`, `FakeBridge.setTranscribeResult`, `FakeBridge.emitVoiceProgress`.

- [ ] **Шаг 1. Написать падающие тесты.**

```ts
// packages/desktop/src/main/voice/mic.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeMicStatus } from './mic.js';

describe('normalizeMicStatus', () => {
  it('статусы macOS как есть, unknown и прочее — not-determined', () => {
    expect(normalizeMicStatus('granted')).toBe('granted');
    expect(normalizeMicStatus('denied')).toBe('denied');
    expect(normalizeMicStatus('restricted')).toBe('restricted');
    expect(normalizeMicStatus('not-determined')).toBe('not-determined');
    expect(normalizeMicStatus('unknown')).toBe('not-determined');
  });
});
```

```ts
// packages/desktop/src/main/voice/services.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createFakeVoiceServices } from './services.js';

describe('createFakeVoiceServices (E2E, PARLEY_VOICE=fake)', () => {
  it('моделей нет, «скачивание» сразу с прогрессом, после — в списке; remove убирает', async () => {
    const voice = createFakeVoiceServices('hello from voice');
    await expect(voice.listModels()).resolves.toEqual([]);
    const progress = vi.fn();
    await expect(voice.download('base', progress)).resolves.toEqual({ ok: true });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ id: 'base' }));
    await expect(voice.listModels()).resolves.toEqual(['base']);
    await voice.remove('base');
    await expect(voice.listModels()).resolves.toEqual([]);
  });

  it('микрофон есть, распознавание отдаёт заданный текст', async () => {
    const voice = createFakeVoiceServices('hello from voice');
    expect(voice.micStatus()).toBe('granted');
    await expect(voice.requestMic()).resolves.toBe(true);
    await expect(voice.transcribe({ pcm: new ArrayBuffer(2), language: 'auto', model: 'base' })).resolves.toEqual({ text: 'hello from voice' });
  });
});
```

```ts
// packages/desktop/src/main/voice/ipc.test.ts
import { describe, expect, it, vi } from 'vitest';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { createFakeVoiceServices } from './services.js';
import { MAX_PCM_BYTES, registerVoiceIpc, toArrayBuffer } from './ipc.js';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function setup() {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) };
  const services = createFakeVoiceServices('ok');
  registerVoiceIpc({ ipcMain: ipcMain as never, services });
  const sent: Array<[string, unknown]> = [];
  const event = { sender: { isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push([channel, payload]) } };
  const invoke = (channel: string, ...args: unknown[]) => (handlers.get(channel) as Handler)(event, ...args);
  return { invoke, sent, services };
}

describe('toArrayBuffer', () => {
  it('ArrayBuffer и Uint8Array — да, нечётная длина, пусто, больше предела и прочее — нет', () => {
    expect(toArrayBuffer(new ArrayBuffer(4))?.byteLength).toBe(4);
    expect(toArrayBuffer(new Uint8Array([1, 2]))?.byteLength).toBe(2);
    expect(toArrayBuffer(new ArrayBuffer(3))).toBeNull();
    expect(toArrayBuffer(new ArrayBuffer(0))).toBeNull();
    expect(toArrayBuffer(new ArrayBuffer(MAX_PCM_BYTES + 2))).toBeNull();
    expect(toArrayBuffer('pcm')).toBeNull();
  });
});

describe('registerVoiceIpc', () => {
  it('download шлёт прогресс отправителю каналом voice:progress', async () => {
    const { invoke, sent } = setup();
    await expect(invoke('voice:download-model', 'base')).resolves.toEqual({ ok: true });
    expect(sent.map(([channel]) => channel)).toContain('voice:progress');
  });

  it('чужой id модели и чужой язык — bad_request до служб', async () => {
    const { invoke } = setup();
    await expect(invoke('voice:download-model', '../../etc')).rejects.toSatisfy((error: unknown) => decodeIpcError(error).code === 'bad_request');
    await expect(invoke('voice:transcribe', { pcm: new ArrayBuffer(2), language: 'ru -m x', model: 'base' })).rejects.toSatisfy(
      (error: unknown) => decodeIpcError(error).code === 'bad_request',
    );
  });

  it('transcribe, mic-status, request-mic отвечают службами', async () => {
    const { invoke } = setup();
    await expect(invoke('voice:transcribe', { pcm: new ArrayBuffer(2), language: 'ru', model: 'base' })).resolves.toEqual({ text: 'ok' });
    await expect(invoke('voice:mic-status')).resolves.toBe('granted');
    await expect(invoke('voice:request-mic')).resolves.toBe(true);
  });
});
```

  В `test-switches.test.ts` по образцу соседних:

```ts
it('voice: fake — только в неупакованном окне или с PARLEY_E2E=1', () => {
  expect(testSwitches({ PARLEY_VOICE: 'fake' }, false).voice).toBe(true);
  expect(testSwitches({ PARLEY_VOICE: 'fake' }, true).voice).toBe(false);
  expect(testSwitches({ PARLEY_VOICE: 'fake', PARLEY_E2E: '1' }, true).voice).toBe(true);
  expect(testSwitches({}, false).voice).toBe(false);
});
```

  В `preload/index.test.ts` после тестов темы:

```ts
it('voice: прогресс скачивания приходит подписчику, отписка снимает его', async () => {
  const bridge = await loadPreload();
  const listener = vi.fn();
  const off = bridge.voice.onProgress(listener);
  emit('voice:progress', { id: 'base', receivedBytes: 1, totalBytes: 2 });
  off();
  emit('voice:progress', { id: 'base', receivedBytes: 2, totalBytes: 2 });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledWith({ id: 'base', receivedBytes: 1, totalBytes: 2 });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/main/voice src/main/test-switches.test.ts src/preload/index.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать main.**

```ts
// packages/desktop/src/main/voice/mic.ts
/** Доступ к микрофону macOS (спека 4.2, 6.3): `systemPreferences` и раздел Privacy → Microphone. */
import type { MicStatus } from '../../shared/voice-types.js';

export const MIC_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

/** `getMediaAccessStatus` отдаёт ещё `unknown` (не macOS): для окна это «ещё не спрашивали». */
export function normalizeMicStatus(raw: string): MicStatus {
  return raw === 'granted' || raw === 'denied' || raw === 'restricted' ? raw : 'not-determined';
}
```

```ts
// packages/desktop/src/main/voice/services.ts
/**
 * Службы голосового ввода main (спека 4.2): модели, распознавание, микрофон — за одним интерфейсом, чтобы IPC не знал,
 * настоящие они или подменные. Подмена (`PARLEY_VOICE=fake`, только E2E) «скачивает» сразу, микрофон даёт и
 * распознаёт в заданный текст — движок и сеть E2E не нужны.
 */
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  VOICE_MODELS,
  voiceModel,
  type DownloadProgress,
  type DownloadResult,
  type MicStatus,
  type TranscribeRequest,
  type TranscribeResult,
  type VoiceModelId,
} from '../../shared/voice-types.js';
import type { Engine } from './engine.js';
import type { ModelStore } from './models.js';
import { createTranscriber, runEngine, type RunEngine } from './transcribe.js';

export interface VoiceServices {
  listModels(): Promise<VoiceModelId[]>;
  download(id: VoiceModelId, onProgress: (progress: DownloadProgress) => void): Promise<DownloadResult>;
  cancel(id: VoiceModelId): void;
  remove(id: VoiceModelId): Promise<void>;
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
  micStatus(): MicStatus;
  requestMic(): Promise<boolean>;
  openMicSettings(): Promise<void>;
}

export interface VoiceServiceDeps {
  models: ModelStore;
  engine(): Engine | null;
  mic: { status(): MicStatus; request(): Promise<boolean>; openSettings(): Promise<void> };
  log(message: string): void;
  run?: RunEngine;
  tmpDir?: string;
}

export function createVoiceServices(deps: VoiceServiceDeps): VoiceServices {
  const transcribe = createTranscriber({
    engine: deps.engine,
    modelPath: (id) => deps.models.path(id),
    exists: (file) => access(file).then(() => true, () => false),
    run: deps.run ?? runEngine,
    tmpDir: deps.tmpDir ?? tmpdir(),
    log: deps.log,
  });
  return {
    listModels: () => deps.models.list(),
    download: (id, onProgress) => deps.models.download(id, onProgress),
    cancel: (id) => deps.models.cancel(id),
    remove: (id) => deps.models.remove(id),
    transcribe,
    micStatus: () => deps.mic.status(),
    requestMic: () => deps.mic.request(),
    openMicSettings: () => deps.mic.openSettings(),
  };
}

export function createFakeVoiceServices(text: string): VoiceServices {
  const downloaded = new Set<VoiceModelId>();
  return {
    listModels: async () => VOICE_MODELS.filter((model) => downloaded.has(model.id)).map((model) => model.id),
    download: async (id, onProgress) => {
      const { bytes } = voiceModel(id);
      onProgress({ id, receivedBytes: bytes, totalBytes: bytes });
      downloaded.add(id);
      return { ok: true };
    },
    cancel: () => undefined,
    remove: async (id) => {
      downloaded.delete(id);
    },
    transcribe: async () => ({ text }),
    micStatus: () => 'granted',
    requestMic: async () => true,
    openMicSettings: async () => undefined,
  };
}
```

```ts
// packages/desktop/src/main/voice/ipc.ts
/**
 * Каналы `voice:*` (спека 4.2). Аргументы проверяются до служб: id модели — из каталога, язык — из списка Whisper
 * (он уходит в argv движка), PCM — чётной длины и не больше двух минут с запасом. Прогресс скачивания уходит
 * отправителю каналом `voice:progress`.
 */
import type { IpcMain } from 'electron';
import { isVoiceLanguage, isVoiceModelId, type VoiceModelId } from '../../shared/voice-types.js';
import { HostError } from '../host-connection.js';
import { withIpcError } from '../ipc.js';
import type { VoiceServices } from './services.js';

/** 2 минуты 5 секунд Int16 моно 16 кГц: предел записи окна (2 мин) с запасом. */
export const MAX_PCM_BYTES = 16_000 * 2 * 125;

export function toArrayBuffer(value: unknown): ArrayBuffer | null {
  let buffer: ArrayBuffer | null = null;
  if (value instanceof ArrayBuffer) buffer = value;
  else if (ArrayBuffer.isView(value)) buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  if (buffer === null || buffer.byteLength === 0 || buffer.byteLength % 2 !== 0 || buffer.byteLength > MAX_PCM_BYTES) return null;
  return buffer;
}

function modelId(value: unknown): VoiceModelId {
  if (!isVoiceModelId(value)) throw new HostError('bad_request', `unknown voice model: ${String(value)}`);
  return value;
}

interface Sender {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

export function registerVoiceIpc({ ipcMain, services }: { ipcMain: Pick<IpcMain, 'handle'>; services: VoiceServices }): void {
  ipcMain.handle('voice:list-models', withIpcError(() => services.listModels()));
  ipcMain.handle(
    'voice:download-model',
    withIpcError((event, id) => {
      const sender = (event as { sender: Sender }).sender;
      return services.download(modelId(id), (progress) => {
        if (!sender.isDestroyed()) sender.send('voice:progress', progress);
      });
    }),
  );
  ipcMain.handle('voice:cancel-download', withIpcError((_event, id) => services.cancel(modelId(id))));
  ipcMain.handle('voice:remove-model', withIpcError((_event, id) => services.remove(modelId(id))));
  ipcMain.handle(
    'voice:transcribe',
    withIpcError((_event, request) => {
      const source = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>;
      const pcm = toArrayBuffer(source.pcm);
      if (pcm === null || !isVoiceLanguage(source.language)) throw new HostError('bad_request', 'bad transcribe request');
      return services.transcribe({ pcm, language: source.language, model: modelId(source.model) });
    }),
  );
  ipcMain.handle('voice:mic-status', withIpcError(() => services.micStatus()));
  ipcMain.handle('voice:request-mic', withIpcError(() => services.requestMic()));
  ipcMain.handle('voice:open-mic-settings', withIpcError(() => services.openMicSettings()));
}
```

  Если `new HostError(code, message)` в `host-connection.ts` принимает другие аргументы, взять форму, которой уже пользуется `main/ipc.ts#browserGuest`.

  **`test-switches.ts`:** в `TestSwitches` добавить `readonly voice: boolean;` с JSDoc «Голосовой ввод на подменных службах (`main/voice/services.ts#createFakeVoiceServices`): E2E без движка и сети». В `testSwitches` добавить `voice: allowed && envValue(env, 'VOICE') === 'fake',`. В шапку файла дописать `VOICE` в список переключателей.

  **`main/index.ts`:** импорты:

```ts
import { tmpdir } from 'node:os';
import { envValue } from '@parley/core';
import { isFileSync, resolveEngine } from './voice/engine.js';
import { registerVoiceIpc } from './voice/ipc.js';
import { MIC_SETTINGS_URL, normalizeMicStatus } from './voice/mic.js';
import { createModelStore, freeBytes, voiceModelsDir } from './voice/models.js';
import { createFakeVoiceServices, createVoiceServices } from './voice/services.js';
import { removeStaleRecordings } from './voice/transcribe.js';
```

  Если `envValue` уже импортирован из `@parley/core`, второй импорт не нужен. Сразу после `registerFilesIpc({...});` вставить:

```ts
    // Голосовой ввод (спека 2026-10-06-voice-input-design.md, 4.2): модели в ~/.parley/desktop/voice/models, движок —
    // Resources/whisper или build/whisper (dev). PARLEY_VOICE=fake (E2E) — подменные службы без движка и сети.
    const voiceServices = switches.voice
      ? createFakeVoiceServices(envValue(process.env, 'VOICE_TEXT') ?? 'hello from voice')
      : createVoiceServices({
          models: createModelStore({ dir: voiceModelsDir(), fetch: (url, init) => net.fetch(url, init), freeBytes }),
          engine: () =>
            resolveEngine({
              isPackaged: app.isPackaged,
              resourcesPath: process.resourcesPath,
              devDir: path.resolve(dirname, '../../build/whisper', `darwin-${process.arch}`),
              pathEnv: shellEnv.env.PATH,
              isFile: isFileSync,
            }),
          mic: {
            status: () => normalizeMicStatus(systemPreferences.getMediaAccessStatus('microphone')),
            request: () => systemPreferences.askForMediaAccess('microphone'),
            openSettings: async () => {
              if (logShell) shellLog.push({ action: 'openExternal', url: MIC_SETTINGS_URL });
              else await shell.openExternal(MIC_SETTINGS_URL);
            },
          },
          log: (message) => console.warn('[parley] voice', message),
        });
    registerVoiceIpc({ ipcMain, services: voiceServices });
    void removeStaleRecordings(tmpdir());
```

  Если `shellEnv` в этой области недоступен, взять переменную, в которую сохранён результат `captureShellEnv` (строка около 149). Если тип записи `shellLog` не принимает `{ action: 'openExternal', url }`, использовать ту же форму, что у `openExternal` в `registerIpc`.

- [ ] **Шаг 4. Реализовать мост.**

  В `shared/bridge.ts` добавить импорт `import type { VoiceApi } from './voice-types.js';` и после `browser: BrowserApi;` поле:

```ts
  /** Голосовой ввод (спека 2026-10-06-voice-input-design.md, 4.2): модели, распознавание, микрофон. */
  voice: VoiceApi;
```

  В `preload/index.ts` добавить импорт типов из `../shared/voice-types.js` (`DownloadProgress`, `DownloadResult`, `MicStatus`, `TranscribeRequest`, `TranscribeResult`, `VoiceModelId`). Рядом с наборами `browser*Listeners` положить:

```ts
const voiceProgressListeners = new Set<(progress: DownloadProgress) => void>();
ipcRenderer.on('voice:progress', (_event, progress: DownloadProgress) => {
  for (const listener of voiceProgressListeners) listener(progress);
});
```

  В объект моста после `browser: { … },` добавить:

```ts
  voice: {
    listModels: () => ipcRenderer.invoke('voice:list-models') as Promise<VoiceModelId[]>,
    downloadModel: (id: VoiceModelId) => ipcRenderer.invoke('voice:download-model', id) as Promise<DownloadResult>,
    cancelDownload: (id: VoiceModelId) => ipcRenderer.invoke('voice:cancel-download', id) as Promise<void>,
    removeModel: (id: VoiceModelId) => ipcRenderer.invoke('voice:remove-model', id) as Promise<void>,
    onProgress: (listener: (progress: DownloadProgress) => void) => {
      voiceProgressListeners.add(listener);
      return () => {
        voiceProgressListeners.delete(listener);
      };
    },
    transcribe: (request: TranscribeRequest) => ipcRenderer.invoke('voice:transcribe', request) as Promise<TranscribeResult>,
    micStatus: () => ipcRenderer.invoke('voice:mic-status') as Promise<MicStatus>,
    requestMic: () => ipcRenderer.invoke('voice:request-mic') as Promise<boolean>,
    openMicSettings: () => ipcRenderer.invoke('voice:open-mic-settings') as Promise<void>,
  },
```

  В `renderer/test-utils/fake-bridge.ts`:
  - в `FakeBridge` добавить:
    - `voiceCalls: Array<{ method: string; args: unknown[] }>`;
    - `setVoiceModels(ids: VoiceModelId[]): void`;
    - `setTranscribeResult(result: TranscribeResult): void`;
    - `emitVoiceProgress(progress: DownloadProgress): void`;
  - в фабрике завести `let voiceModels: VoiceModelId[] = []`, `let transcribeResult: TranscribeResult = { text: 'dictated text' }`, `const voiceCalls = []`, `const voiceProgressListeners = new Set<…>()`;
  - объект `voice`:

```ts
    voice: {
      listModels: async () => {
        voiceCalls.push({ method: 'listModels', args: [] });
        return [...voiceModels];
      },
      downloadModel: async (id) => {
        voiceCalls.push({ method: 'downloadModel', args: [id] });
        if (!voiceModels.includes(id)) voiceModels = [...voiceModels, id];
        return { ok: true };
      },
      cancelDownload: async (id) => {
        voiceCalls.push({ method: 'cancelDownload', args: [id] });
      },
      removeModel: async (id) => {
        voiceCalls.push({ method: 'removeModel', args: [id] });
        voiceModels = voiceModels.filter((model) => model !== id);
      },
      onProgress: (listener) => {
        voiceProgressListeners.add(listener);
        return () => {
          voiceProgressListeners.delete(listener);
        };
      },
      transcribe: async (request) => {
        voiceCalls.push({ method: 'transcribe', args: [request] });
        return transcribeResult;
      },
      micStatus: async () => 'granted',
      requestMic: async () => true,
      openMicSettings: async () => {
        voiceCalls.push({ method: 'openMicSettings', args: [] });
      },
    },
    voiceCalls,
    setVoiceModels: (ids) => {
      voiceModels = [...ids];
    },
    setTranscribeResult: (result) => {
      transcribeResult = result;
    },
    emitVoiceProgress: (progress) => {
      for (const listener of voiceProgressListeners) listener(progress);
    },
```

- [ ] **Шаг 5. Запустить — проходит.**
  - `pnpm --filter @parley/desktop exec vitest run src/main/voice src/main/test-switches.test.ts src/preload/index.test.ts src/renderer/test-utils` → PASS.
  - `pnpm --filter @parley/desktop typecheck` → без ошибок.
  - `pnpm --filter @parley/desktop test` → зелёный, ни один прежний тест не сломан.

- [ ] **Шаг 6. Закоммитить.**

```bash
git add packages/desktop/src/main/voice packages/desktop/src/main/test-switches.ts packages/desktop/src/main/test-switches.test.ts packages/desktop/src/main/index.ts packages/desktop/src/preload packages/desktop/src/shared/bridge.ts packages/desktop/src/renderer/test-utils/fake-bridge.ts
git commit -m "feat(desktop): каналы voice:* — модели, распознавание, микрофон; подмена PARLEY_VOICE=fake"
```

---

## Задача 7. Запись звука в окне

**Файлы:**
- Создать: `packages/desktop/src/renderer/voice/level.ts`, `packages/desktop/src/renderer/voice/pcm.ts`, `packages/desktop/src/renderer/voice/pcm-capture.worklet.ts`, `packages/desktop/src/renderer/voice/recorder.ts`, `packages/desktop/src/renderer/voice/browser-recorder.ts`
- Тесты: `packages/desktop/src/renderer/voice/level.test.ts`, `packages/desktop/src/renderer/voice/pcm.test.ts`, `packages/desktop/src/renderer/voice/recorder.test.ts`

**Интерфейсы:**
- Отдаёт:
  - `rms(frame: Float32Array): number`, `peakOf(frame: Float32Array): number`, `SILENCE_PEAK = 0.02`, `isSilent(peak: number): boolean`, `levelWidth(level: number): number` (0…1 для полоски);
  - `floatTo16(frame: Float32Array): Int16Array`, `joinChunks(chunks: readonly Int16Array[]): Int16Array`;
  - `RECORDING_SAMPLE_RATE = 16_000`;
  - `class MicError extends Error { readonly kind: 'denied' | 'not_found' }`;
  - `interface RecordedAudio { pcm: ArrayBuffer; durationMs: number; peak: number }`;
  - `interface Recording { stop(): Promise<RecordedAudio>; cancel(): void }`;
  - `interface RecorderDeps` (с `workletUrl(): Promise<string>`), `CaptureContext`, `CaptureNode`;
  - `startRecording(onLevel: (level: number) => void, deps: RecorderDeps): Promise<Recording>`;
  - `browserRecorderDeps(): RecorderDeps` в `browser-recorder.ts` — единственный модуль с импортом worklet.

- [ ] **Шаг 1. Написать падающие тесты.**

```ts
// packages/desktop/src/renderer/voice/level.test.ts
import { describe, expect, it } from 'vitest';
import { isSilent, levelWidth, peakOf, rms, SILENCE_PEAK } from './level.js';

describe('громкость записи', () => {
  it('rms и пик кадра', () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array([]))).toBe(0);
    expect(peakOf(new Float32Array([0.1, -0.7, 0.3]))).toBeCloseTo(0.7);
  });

  it('тишина — пик ниже порога (спека 6.1, первый заслон)', () => {
    expect(isSilent(SILENCE_PEAK / 2)).toBe(true);
    expect(isSilent(SILENCE_PEAK * 2)).toBe(false);
  });

  it('ширина полоски 0…1: тихая речь заметна, громкая не выходит за край', () => {
    expect(levelWidth(0)).toBe(0);
    expect(levelWidth(0.05)).toBeCloseTo(0.4);
    expect(levelWidth(1)).toBe(1);
  });
});
```

```ts
// packages/desktop/src/renderer/voice/pcm.test.ts
import { describe, expect, it } from 'vitest';
import { floatTo16, joinChunks } from './pcm.js';

describe('PCM Int16', () => {
  it('float -1…1 → Int16 с насыщением', () => {
    expect([...floatTo16(new Float32Array([0, 1, -1, 2, -2, 0.5]))]).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });

  it('куски склеиваются по порядку', () => {
    expect([...joinChunks([new Int16Array([1, 2]), new Int16Array([]), new Int16Array([3])])]).toEqual([1, 2, 3]);
  });
});
```

```ts
// packages/desktop/src/renderer/voice/recorder.test.ts
import { describe, expect, it, vi } from 'vitest';
import { MicError, startRecording, type CaptureContext, type CaptureNode, type RecorderDeps } from './recorder.js';

function fakeDeps(overrides: Partial<RecorderDeps> = {}) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const node: CaptureNode = { port: { onmessage: null }, connect: vi.fn(), disconnect: vi.fn() };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const context: CaptureContext = {
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createMediaStreamSource: vi.fn(() => source),
    destination: {},
    close: vi.fn(async () => undefined),
  };
  const deps: RecorderDeps = {
    getUserMedia: vi.fn(async () => stream),
    createContext: () => context,
    createNode: () => node,
    workletUrl: async () => 'worklet.js',
    ...overrides,
  };
  const frame = (samples: number[]) => node.port.onmessage?.({ data: new Float32Array(samples) } as MessageEvent<Float32Array>);
  return { deps, track, context, node, frame };
}

describe('startRecording', () => {
  it('кадры копятся в PCM Int16, громкость — наружу; stop закрывает микрофон и контекст', async () => {
    const { deps, track, context, frame } = fakeDeps();
    const levels: number[] = [];
    const recording = await startRecording((level) => levels.push(level), deps);
    frame([0.5, -0.5]);
    frame([0.25]);
    const audio = await recording.stop();
    expect([...new Int16Array(audio.pcm)]).toEqual([16383, -16384, 8191]);
    expect(audio.peak).toBeCloseTo(0.5);
    expect(audio.durationMs).toBeCloseTo((3 / 16_000) * 1000);
    expect(levels).toHaveLength(2);
    expect(track.stop).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
  });

  it('cancel закрывает всё и ничего не отдаёт', async () => {
    const { deps, track } = fakeDeps();
    const recording = await startRecording(() => undefined, deps);
    recording.cancel();
    await vi.waitFor(() => expect(track.stop).toHaveBeenCalled());
  });

  it('NotAllowedError — MicError denied, NotFoundError — not_found', async () => {
    const denied = fakeDeps({ getUserMedia: async () => Promise.reject(new DOMException('no', 'NotAllowedError')) });
    await expect(startRecording(() => undefined, denied.deps)).rejects.toMatchObject({ kind: 'denied' });
    const missing = fakeDeps({ getUserMedia: async () => Promise.reject(new DOMException('no', 'NotFoundError')) });
    await expect(startRecording(() => undefined, missing.deps)).rejects.toBeInstanceOf(MicError);
  });
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/renderer/voice` → FAIL.

- [ ] **Шаг 3. Реализовать.**

```ts
// packages/desktop/src/renderer/voice/level.ts
/** Громкость записи (спека 3.2, 6.1): полоска у кнопки и порог тишины до вызова движка. */

/** Пик ниже этого — тишина: движок не зовётся (≈ −34 dBFS). Подбирается на живой проверке (задача 14 плана). */
export const SILENCE_PEAK = 0.02;

export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / frame.length);
}

export function peakOf(frame: Float32Array): number {
  let peak = 0;
  for (const sample of frame) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

export function isSilent(peak: number): boolean {
  return peak < SILENCE_PEAK;
}

/** Речь у микрофона — rms 0.02…0.2: ×8 делает тихую речь заметной, а громкую упирает в край. */
export function levelWidth(level: number): number {
  return Math.min(1, Math.max(0, level * 8));
}
```

```ts
// packages/desktop/src/renderer/voice/pcm.ts
/** Float32 AudioWorklet → PCM Int16 little-endian, который ждёт `main/voice/wav.ts`. */

export function floatTo16(frame: Float32Array): Int16Array {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, frame[i] ?? 0));
    out[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.floor(sample * 0x7fff);
  }
  return out;
}

export function joinChunks(chunks: readonly Int16Array[]): Int16Array {
  const out = new Int16Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
```

```ts
// packages/desktop/src/renderer/voice/pcm-capture.worklet.ts
/**
 * Процессор AudioWorklet записи (спека 4.1): каждый кадр первого канала уходит в окно копией — буфер кадра
 * движок звука переиспользует. Выход не пишется: узел подключён к destination только чтобы граф его тянул.
 */
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

class PcmCapture extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel !== undefined) this.port.postMessage(channel.slice(0));
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
```

```ts
// packages/desktop/src/renderer/voice/recorder.ts
/**
 * Запись с микрофона (спека 4.1): `getUserMedia` моно с шумоподавлением → `AudioContext` 16 кГц (ресемплинг —
 * Chromium) → AudioWorklet `pcm-capture` → PCM Int16 в памяти. Громкость каждого кадра уходит наружу для полоски,
 * пик — для порога тишины. Зависимости браузера подменяемы: jsdom их не знает. Настоящие — в `browser-recorder.ts`:
 * там импорт worklet, и этот модуль (его тянут store, кнопка и поля) от сборщика worklet не зависит.
 */
import { joinChunks, floatTo16 } from './pcm.js';
import { peakOf, rms } from './level.js';

export const RECORDING_SAMPLE_RATE = 16_000;

export class MicError extends Error {
  constructor(readonly kind: 'denied' | 'not_found') {
    super(`microphone ${kind}`);
  }
}

export interface RecordedAudio {
  pcm: ArrayBuffer;
  durationMs: number;
  peak: number;
}

export interface Recording {
  stop(): Promise<RecordedAudio>;
  cancel(): void;
}

/** Часть `AudioContext`, которая нужна записи. */
export interface CaptureContext {
  audioWorklet: { addModule(url: string): Promise<void> };
  createMediaStreamSource(stream: MediaStream): { connect(node: unknown): void; disconnect(): void };
  destination: unknown;
  close(): Promise<void>;
}

export interface CaptureNode {
  port: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null };
  connect(destination: unknown): void;
  disconnect(): void;
}

export interface RecorderDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createContext(): CaptureContext;
  createNode(context: CaptureContext): CaptureNode;
  /** Адрес модуля worklet; у настоящих зависимостей — ленивый импорт. */
  workletUrl(): Promise<string>;
}

export async function startRecording(onLevel: (level: number) => void, deps: RecorderDeps): Promise<Recording> {
  let stream: MediaStream;
  try {
    stream = await deps.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    throw new MicError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'not_found');
  }
  const context = deps.createContext();
  await context.audioWorklet.addModule(await deps.workletUrl());
  const source = context.createMediaStreamSource(stream);
  const node = deps.createNode(context);
  const chunks: Int16Array[] = [];
  let samples = 0;
  let peak = 0;
  node.port.onmessage = (event) => {
    const frame = event.data;
    chunks.push(floatTo16(frame));
    samples += frame.length;
    peak = Math.max(peak, peakOf(frame));
    onLevel(rms(frame));
  };
  source.connect(node);
  node.connect(context.destination);

  let closed: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      for (const track of stream.getTracks()) track.stop();
      await context.close();
    })();
    return closed;
  };

  return {
    async stop() {
      await close();
      const pcm = joinChunks(chunks);
      return { pcm: pcm.buffer as ArrayBuffer, durationMs: (samples / RECORDING_SAMPLE_RATE) * 1000, peak };
    },
    cancel() {
      void close();
    },
  };
}
```

```ts
// packages/desktop/src/renderer/voice/browser-recorder.ts
/**
 * Настоящие зависимости записи (спека 4.1): микрофон Chromium, `AudioContext` 16 кГц и worklet `pcm-capture`. Модуль
 * worklet грузится лениво — только когда запись действительно начинается; тесты сюда не заходят.
 */
import { RECORDING_SAMPLE_RATE, type CaptureContext, type CaptureNode, type RecorderDeps } from './recorder.js';

export function browserRecorderDeps(): RecorderDeps {
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createContext: () => new AudioContext({ sampleRate: RECORDING_SAMPLE_RATE }) as unknown as CaptureContext,
    createNode: (context) => new AudioWorkletNode(context as unknown as AudioContext, 'pcm-capture') as unknown as CaptureNode,
    workletUrl: () => import('./pcm-capture.worklet.ts?worker&url').then((module) => module.default),
  };
}
```

- [ ] **Шаг 4. Запустить — проходит.**
  - `pnpm --filter @parley/desktop exec vitest run src/renderer/voice` → PASS.
  - `pnpm --filter @parley/desktop typecheck` → без ошибок.
  - `pnpm --filter @parley/desktop build` → в `out/renderer/assets` появился отдельный файл worklet.

  Если electron-vite не собрал worklet по `?worker&url`, переименовать процессор в `pcm-capture.worklet.js` (без `declare`) и импортировать его в `browser-recorder.ts` как `?url`.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src/renderer/voice
git commit -m "feat(desktop): запись микрофона в PCM 16 кГц через AudioWorklet"
```

---

## Задача 8. Store диктовки и строки

**Файлы:**
- Создать: `packages/desktop/src/renderer/voice/dictation-store.ts`, `packages/desktop/src/renderer/voice/wire.ts`
- Изменить: `packages/desktop/src/shared/strings.ts` (раздел `voice`, `settings.sections.voice`, `actions.toggleDictation`), `packages/desktop/src/renderer/App.tsx`
- Тест: `packages/desktop/src/renderer/voice/dictation-store.test.ts`

**Интерфейсы:**
- Берёт: `VoiceApi`, `TranscribeError` (задача 1), `VoiceUi` (задача 2), `Recording`, `MicError`, `startRecording`, `browserRecorderDeps`, `isSilent` (задача 7).
- Отдаёт:
  - `type DictationPhase = 'idle' | 'recording' | 'transcribing'`;
  - `interface DictationTarget { id: string; element(): HTMLElement | null; remember?(): void; insert(text: string): void }`;
  - `interface DictationDeps`, `MAX_RECORDING_MS = 120_000`;
  - `createDictationStore()`, `useDictationStore`;
  - состояние: `phase`, `targetId`, `level`, `startedAt`;
  - действия: `configure(deps): () => void`, `register(target): () => void`, `toggle(id): Promise<void>`, `cancel(): void`, `toggleFocused(): boolean`, `canToggleFocused(): boolean`, `isConfigured(): boolean`;
  - `wireDictation(bridge: ParleyBridge): () => void`.
  - Строки `S.voice.*`:
    - `setUp`, `dictate`, `stop`, `transcribing`;
    - `noSpeech`, `micDenied`, `openSystemSettings`, `noMicrophone`, `engineMissing`, `modelMissing`, `openSettings`, `failed`, `copied`;
    - `diskFull(mb)`, `downloadFailed`, `downloadCorrupted`;
    - `settings.{enable, downloadFirst, model, language, auto, shortcut, shortcutKeys, download, cancel, remove, sizeMb(mb), progress(received, total), hint}`;
    - `models[id].{name, hint}`.

- [ ] **Шаг 1. Добавить строки.** В `shared/strings.ts`:
  - в `settings.sections` дописать `voice: 'Voice',`;
  - в `actions` дописать `toggleDictation: 'Toggle dictation',`;
  - новым разделом верхнего уровня:

```ts
  /** Голосовой ввод (спека 2026-10-06-voice-input-design.md, раздел 3). */
  voice: {
    setUp: 'Set up voice input',
    dictate: 'Dictate (⌘⇧M)',
    stop: 'Stop dictation (⌘⇧M)',
    transcribing: 'Transcribing…',
    noSpeech: 'No speech detected',
    micDenied: 'Microphone access denied',
    openSystemSettings: 'Open System Settings',
    noMicrophone: 'No microphone found',
    engineMissing: 'Voice engine not found',
    modelMissing: 'Voice model is missing',
    openSettings: 'Open settings',
    failed: 'Transcription failed',
    copied: 'Transcript copied to clipboard',
    diskFull: (mb: number): string => `Not enough disk space (need ${mb} MB)`,
    downloadFailed: 'Download failed',
    downloadCorrupted: 'Download corrupted. Try again.',
    settings: {
      enable: 'Voice input',
      downloadFirst: 'Download a model first',
      model: 'Model',
      language: 'Language',
      auto: 'Auto',
      shortcut: 'Shortcut',
      shortcutKeys: '⌘⇧M',
      download: 'Download',
      cancel: 'Cancel',
      remove: 'Delete',
      sizeMb: (mb: number): string => `${mb} MB`,
      progress: (received: number, total: number): string =>
        `${Math.floor((received / total) * 100)}% · ${Math.round(received / 1_000_000)} of ${Math.round(total / 1_000_000)} MB`,
      hint: 'Audio is transcribed on this Mac and never leaves it.',
    },
    models: {
      base: { name: 'Base', hint: 'Fastest. Weak for Russian.' },
      small: { name: 'Small', hint: 'Good balance.' },
      'large-v3-turbo-q5_0': { name: 'Large v3 Turbo (Q5)', hint: 'Best quality. Recommended on Apple Silicon.' },
    },
  },
```

- [ ] **Шаг 2. Написать падающий тест.**

```ts
// packages/desktop/src/renderer/voice/dictation-store.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../shared/strings.js';
import type { VoiceUi } from '../../shared/ui-types.js';
import type { TranscribeResult } from '../../shared/voice-types.js';
import { createDictationStore, MAX_RECORDING_MS, type DictationDeps, type DictationTarget } from './dictation-store.js';
import { MicError, type RecordedAudio, type Recording } from './recorder.js';

const LOUD: RecordedAudio = { pcm: new ArrayBuffer(4), durationMs: 1000, peak: 0.5 };

function harness(options: { voice?: VoiceUi; result?: TranscribeResult; mic?: 'granted' | 'denied' | 'not-determined'; audio?: RecordedAudio } = {}) {
  const store = createDictationStore();
  const recording: Recording & { stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } = {
    stop: vi.fn(async () => options.audio ?? LOUD),
    cancel: vi.fn(),
  };
  let cap: (() => void) | null = null;
  const deps: DictationDeps = {
    voice: {
      transcribe: vi.fn(async () => options.result ?? { text: 'hello world' }),
      micStatus: vi.fn(async () => options.mic ?? 'granted'),
      requestMic: vi.fn(async () => true),
      openMicSettings: vi.fn(async () => undefined),
    },
    settings: () => options.voice ?? { enabled: true, model: 'small', language: 'ru' },
    record: vi.fn(async () => recording),
    toast: vi.fn(),
    openVoiceSettings: vi.fn(),
    copy: vi.fn(async () => undefined),
    setTimeout: (fn) => {
      cap = fn;
      return 1;
    },
    clearTimeout: () => {
      cap = null;
    },
    now: () => 1000,
  };
  const dispose = store.getState().configure(deps);
  const element = document.createElement('div');
  document.body.append(element);
  const target: DictationTarget & { insert: ReturnType<typeof vi.fn>; remember: ReturnType<typeof vi.fn> } = {
    id: 'room',
    element: () => element,
    remember: vi.fn(),
    insert: vi.fn(),
  };
  const unregister = store.getState().register(target);
  return { store, deps, recording, target, element, unregister, dispose, fireCap: () => cap?.() };
}

let cleanup: Array<() => void> = [];
beforeEach(() => {
  cleanup = [];
});
afterEach(() => {
  for (const fn of cleanup) fn();
  document.body.replaceChildren();
});

describe('dictation-store (спека 3.2–3.4, 6)', () => {
  it('голос не настроен — toggle открывает Settings → Voice, запись не начинается', async () => {
    const h = harness({ voice: { enabled: false, model: null, language: 'auto' } });
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    expect(h.deps.openVoiceSettings).toHaveBeenCalled();
    expect(h.deps.record).not.toHaveBeenCalled();
  });

  it('старт → стоп: каретка запомнена, текст вставлен в цель, язык и модель — из настроек', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    expect(h.store.getState()).toMatchObject({ phase: 'recording', targetId: 'room', startedAt: 1000 });
    expect(h.target.remember).toHaveBeenCalled();
    await h.store.getState().toggle('room');
    expect(h.deps.voice.transcribe).toHaveBeenCalledWith({ pcm: LOUD.pcm, language: 'ru', model: 'small' });
    expect(h.target.insert).toHaveBeenCalledWith('hello world');
    expect(h.store.getState()).toMatchObject({ phase: 'idle', targetId: null });
  });

  it('Esc во время записи — отмена, движок не зовётся, событие погашено', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(h.recording.cancel).toHaveBeenCalled();
    expect(h.deps.voice.transcribe).not.toHaveBeenCalled();
    expect(h.store.getState().phase).toBe('idle');
  });

  it('запись в другой цели отменяет прежнюю и начинает новую', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    const other = { id: 'chat', element: () => null, insert: vi.fn() };
    cleanup.push(h.store.getState().register(other));
    await h.store.getState().toggle('room');
    await h.store.getState().toggle('chat');
    expect(h.recording.cancel).toHaveBeenCalledTimes(1);
    expect(h.store.getState()).toMatchObject({ phase: 'recording', targetId: 'chat' });
  });

  it('тишина — «No speech detected», движок не зовётся', async () => {
    const h = harness({ audio: { pcm: new ArrayBuffer(4), durationMs: 1000, peak: 0.001 } });
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    await h.store.getState().toggle('room');
    expect(h.deps.voice.transcribe).not.toHaveBeenCalled();
    expect(h.deps.toast).toHaveBeenCalledWith(S.voice.noSpeech);
  });

  it('ошибки движка — свои тосты; model_missing ведёт в настройки (Фокус ревью, 5)', async () => {
    const h = harness({ result: { error: 'model_missing' } });
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    await h.store.getState().toggle('room');
    expect(h.deps.toast).toHaveBeenCalledWith(S.voice.modelMissing, expect.objectContaining({ label: S.voice.openSettings }));
    const action = vi.mocked(h.deps.toast).mock.calls[0]?.[1];
    action?.onClick();
    expect(h.deps.openVoiceSettings).toHaveBeenCalled();
    expect(h.target.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['engine_missing', S.voice.engineMissing],
    ['failed', S.voice.failed],
    ['no_speech', S.voice.noSpeech],
  ] as const)('%s → «%s»', async (error, text) => {
    const h = harness({ result: { error } });
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    await h.store.getState().toggle('room');
    expect(h.deps.toast).toHaveBeenCalledWith(text);
  });

  it('цель исчезла во время распознавания — текст в буфер и тост (Фокус ревью, 4)', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    h.unregister();
    await h.store.getState().toggle('room');
    // Цели нет — toggle('room') не начинает новую запись, а останавливает текущую по targetId.
    expect(h.deps.copy).toHaveBeenCalledWith('hello world');
    expect(h.deps.toast).toHaveBeenCalledWith(S.voice.copied);
  });

  it('микрофон запрещён — тост с «Open System Settings», запись не начинается', async () => {
    const h = harness({ mic: 'denied' });
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    expect(h.deps.record).not.toHaveBeenCalled();
    expect(h.deps.toast).toHaveBeenCalledWith(S.voice.micDenied, expect.objectContaining({ label: S.voice.openSystemSettings }));
  });

  it('доступ ещё не спрашивали — запрос, потом запись', async () => {
    const h = harness({ mic: 'not-determined' });
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    expect(h.deps.voice.requestMic).toHaveBeenCalled();
    expect(h.store.getState().phase).toBe('recording');
  });

  it('микрофона нет — «No microphone found»', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    vi.mocked(h.deps.record).mockRejectedValueOnce(new MicError('not_found'));
    await h.store.getState().toggle('room');
    expect(h.deps.toast).toHaveBeenCalledWith(S.voice.noMicrophone);
    expect(h.store.getState().phase).toBe('idle');
  });

  it('предел 2 минуты останавливает запись и распознаёт', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    await h.store.getState().toggle('room');
    expect(MAX_RECORDING_MS).toBe(120_000);
    h.fireCap();
    await vi.waitFor(() => expect(h.target.insert).toHaveBeenCalledWith('hello world'));
  });

  it('два toggle подряд до старта — одна запись (Фокус ревью, 2)', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    await Promise.all([h.store.getState().toggle('room'), h.store.getState().toggle('room')]);
    expect(h.deps.record).toHaveBeenCalledTimes(1);
    expect(h.store.getState().phase).toBe('recording');
  });

  it('во время распознавания toggle ничего не начинает', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    let finish: (result: TranscribeResult) => void = () => undefined;
    vi.mocked(h.deps.voice.transcribe).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await h.store.getState().toggle('room');
    const stopping = h.store.getState().toggle('room');
    await vi.waitFor(() => expect(h.store.getState().phase).toBe('transcribing'));
    await h.store.getState().toggle('room');
    expect(h.deps.record).toHaveBeenCalledTimes(1);
    finish({ text: 'done' });
    await stopping;
  });

  it('toggleFocused: цель с фокусом; идёт запись — её стоп; нет цели — false', async () => {
    const h = harness();
    cleanup.push(h.dispose);
    const input = document.createElement('textarea');
    h.element.append(input);
    expect(h.store.getState().toggleFocused()).toBe(false);
    input.focus();
    expect(h.store.getState().canToggleFocused()).toBe(true);
    expect(h.store.getState().toggleFocused()).toBe(true);
    await vi.waitFor(() => expect(h.store.getState().phase).toBe('recording'));
    input.blur();
    expect(h.store.getState().toggleFocused()).toBe(true);
    await vi.waitFor(() => expect(h.target.insert).toHaveBeenCalled());
  });
});
```

- [ ] **Шаг 3. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/renderer/voice/dictation-store.test.ts` → FAIL.

- [ ] **Шаг 4. Реализовать.**

```ts
// packages/desktop/src/renderer/voice/dictation-store.ts
/**
 * Диктовка окна (спека 3.2–3.4, 6): одна запись на окно, одна очередь распознавания. Цели — поле комнаты, поле чата,
 * первый промпт «New workspace», терминал сессии — регистрируются сами и умеют вставить текст. Store решает, когда
 * писать, куда отдавать результат и что показать при ошибке. Зависимости окна (мост, запись, тосты, таймеры) —
 * через `configure`: тесты подставляют свои.
 */
import { create } from 'zustand';
import { S } from '../../shared/strings.js';
import type { VoiceUi } from '../../shared/ui-types.js';
import type { TranscribeError, VoiceApi } from '../../shared/voice-types.js';
import { isSilent } from './level.js';
import { MicError, type Recording } from './recorder.js';

export type DictationPhase = 'idle' | 'recording' | 'transcribing';

export interface DictationTarget {
  id: string;
  /** Фокус внутри элемента — горячая клавиша про эту цель. */
  element(): HTMLElement | null;
  /** Начало записи: поле запоминает каретку, куда встанет текст. */
  remember?(): void;
  insert(text: string): void;
}

export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface DictationDeps {
  voice: Pick<VoiceApi, 'transcribe' | 'micStatus' | 'requestMic' | 'openMicSettings'>;
  settings(): VoiceUi;
  record(onLevel: (level: number) => void): Promise<Recording>;
  toast(text: string, action?: ToastAction): void;
  openVoiceSettings(): void;
  copy(text: string): Promise<void>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const MAX_RECORDING_MS = 120_000;

export interface DictationState {
  phase: DictationPhase;
  targetId: string | null;
  level: number;
  startedAt: number | null;
  configure(deps: DictationDeps): () => void;
  register(target: DictationTarget): () => void;
  isConfigured(): boolean;
  toggle(targetId: string): Promise<void>;
  cancel(): void;
  toggleFocused(): boolean;
  canToggleFocused(): boolean;
}

const IDLE = { phase: 'idle' as const, targetId: null, level: 0, startedAt: null };

export function createDictationStore() {
  let deps: DictationDeps | null = null;
  const targets = new Map<string, DictationTarget>();
  let recording: Recording | null = null;
  let capTimer: unknown = null;
  let starting = false;
  /** Номер попытки: отмена во время старта или стопа делает результат прежней попытки чужим. */
  let session = 0;
  let lastFocusedId: string | null = null;

  return create<DictationState>((set, get) => {
    const configured = (): boolean => {
      if (deps === null) return false;
      const voice = deps.settings();
      return voice.enabled && voice.model !== null;
    };

    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // Раньше диалога и поля: Esc записи не закрывает «New workspace» и не уходит агенту.
      event.preventDefault();
      event.stopPropagation();
      get().cancel();
    };

    const stopListening = (): void => {
      window.removeEventListener('keydown', onEscape, true);
      if (capTimer !== null) deps?.clearTimeout(capTimer);
      capTimer = null;
    };

    const micDenied = (d: DictationDeps): void =>
      d.toast(S.voice.micDenied, { label: S.voice.openSystemSettings, onClick: () => void d.voice.openMicSettings() });

    const showError = (d: DictationDeps, error: TranscribeError): void => {
      if (error === 'model_missing') {
        d.toast(S.voice.modelMissing, { label: S.voice.openSettings, onClick: () => d.openVoiceSettings() });
        return;
      }
      d.toast(error === 'no_speech' ? S.voice.noSpeech : error === 'engine_missing' ? S.voice.engineMissing : S.voice.failed);
    };

    const begin = async (d: DictationDeps, id: string): Promise<void> => {
      const target = targets.get(id);
      if (target === undefined) return;
      starting = true;
      const attempt = ++session;
      try {
        const status = await d.voice.micStatus();
        const allowed = status === 'granted' || (status === 'not-determined' && (await d.voice.requestMic()));
        if (attempt !== session) return;
        if (!allowed) {
          micDenied(d);
          return;
        }
        target.remember?.();
        let started: Recording;
        try {
          started = await d.record((level) => {
            if (attempt === session) set({ level });
          });
        } catch (error) {
          if (error instanceof MicError && error.kind === 'denied') micDenied(d);
          else d.toast(S.voice.noMicrophone);
          return;
        }
        if (attempt !== session) {
          started.cancel();
          return;
        }
        recording = started;
        set({ phase: 'recording', targetId: id, level: 0, startedAt: d.now() });
        capTimer = d.setTimeout(() => void finish(), MAX_RECORDING_MS);
        window.addEventListener('keydown', onEscape, true);
      } finally {
        starting = false;
      }
    };

    const finish = async (): Promise<void> => {
      const d = deps;
      const current = recording;
      const id = get().targetId;
      if (d === null || current === null || id === null) return;
      recording = null;
      stopListening();
      set({ phase: 'transcribing', level: 0 });
      const attempt = session;
      try {
        const audio = await current.stop();
        const voice = d.settings();
        if (isSilent(audio.peak) || voice.model === null) {
          d.toast(S.voice.noSpeech);
          return;
        }
        const result = await d.voice.transcribe({ pcm: audio.pcm, language: voice.language, model: voice.model });
        if ('error' in result) {
          showError(d, result.error);
          return;
        }
        const target = targets.get(id);
        if (target !== undefined) {
          target.insert(result.text);
          return;
        }
        await d.copy(result.text);
        d.toast(S.voice.copied);
      } catch (error) {
        console.warn('[parley] voice', error);
        d.toast(S.voice.failed);
      } finally {
        if (attempt === session) set(IDLE);
      }
    };

    const resolveFocused = (): string | null => {
      const active = document.activeElement;
      if (active !== null) {
        for (const target of targets.values()) if (target.element()?.contains(active) === true) return target.id;
      }
      return lastFocusedId !== null && targets.has(lastFocusedId) ? lastFocusedId : null;
    };

    return {
      ...IDLE,

      configure(next) {
        deps = next;
        const onFocusIn = (event: FocusEvent): void => {
          for (const target of targets.values()) {
            if (target.element()?.contains(event.target as Node | null) === true) {
              lastFocusedId = target.id;
              return;
            }
          }
        };
        window.addEventListener('focusin', onFocusIn);
        return () => {
          window.removeEventListener('focusin', onFocusIn);
          get().cancel();
          if (deps === next) deps = null;
        };
      },

      register(target) {
        targets.set(target.id, target);
        return () => {
          if (targets.get(target.id) === target) targets.delete(target.id);
        };
      },

      isConfigured: configured,

      async toggle(targetId) {
        const d = deps;
        if (d === null) return;
        if (!configured()) {
          d.openVoiceSettings();
          return;
        }
        const { phase, targetId: active } = get();
        if (phase === 'transcribing' || starting) return;
        if (phase === 'recording') {
          if (active === targetId) {
            await finish();
            return;
          }
          get().cancel();
        }
        await begin(d, targetId);
      },

      cancel() {
        session += 1;
        if (get().phase === 'transcribing') return;
        const current = recording;
        recording = null;
        stopListening();
        current?.cancel();
        set(IDLE);
      },

      toggleFocused() {
        if (!configured()) return false;
        const { phase, targetId } = get();
        if (phase === 'recording' && targetId !== null) {
          void get().toggle(targetId);
          return true;
        }
        const id = resolveFocused();
        if (id === null) return false;
        void get().toggle(id);
        return true;
      },

      canToggleFocused() {
        return configured() && (get().phase === 'recording' || resolveFocused() !== null);
      },
    };
  });
}

export const useDictationStore = createDictationStore();
```

  Деталь, которую проверяет тест «цель исчезла»: если запись идёт, а цель с этим id уже снята, `toggle(id)` всё равно попадает в ветку `active === targetId` и останавливает запись. Новая запись при этом не начинается.

```ts
// packages/desktop/src/renderer/voice/wire.ts
/** Подключение диктовки к окну (спека 4.1): мост, `ui.json`, запись, тосты sonner, буфер обмена. */
import { toast } from 'sonner';
import type { ParleyBridge } from '../../shared/bridge.js';
import { useUiStore } from '../store/ui.js';
import { browserRecorderDeps } from './browser-recorder.js';
import { useDictationStore } from './dictation-store.js';
import { startRecording } from './recorder.js';

export function wireDictation(bridge: ParleyBridge): () => void {
  return useDictationStore.getState().configure({
    voice: bridge.voice,
    settings: () => useUiStore.getState().ui.voice,
    record: (onLevel) => startRecording(onLevel, browserRecorderDeps()),
    toast: (text, action) => {
      if (action === undefined) toast(text);
      else toast(text, { action: { label: action.label, onClick: () => action.onClick() } });
    },
    openVoiceSettings: () => useUiStore.getState().openSettingsDialog('voice'),
    copy: (text) => navigator.clipboard.writeText(text),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    now: () => Date.now(),
  });
}
```

  `openSettingsDialog('voice')` появится в задаче 9. До неё вызывать `openSettingsDialog()` без аргумента; задача 9 заменит вызов.

  В `App.tsx` рядом с `useEffect(() => wireHostBuildNotice(), []);` добавить:

```tsx
  // Диктовка (спека 2026-10-06-voice-input-design.md): от связи с хостом не зависит — мост, запись и тосты свои.
  useEffect(() => wireDictation(bridge), []);
```

  и импорт `import { wireDictation } from './voice/wire.js';`.

- [ ] **Шаг 5. Запустить — проходит.**
  - `pnpm --filter @parley/desktop exec vitest run src/renderer/voice src/english-ui.test.ts` → PASS.
  - `pnpm --filter @parley/desktop typecheck` → без ошибок.

- [ ] **Шаг 6. Закоммитить.**

```bash
git add packages/desktop/src/renderer/voice packages/desktop/src/shared/strings.ts packages/desktop/src/renderer/App.tsx
git commit -m "feat(desktop): store диктовки — одна запись на окно, ошибки, Esc, предел 2 минуты"
```

---

## Задача 9. Кнопка микрофона и вкладка Voice

**Файлы:**
- Создать: `packages/desktop/src/renderer/voice/MicButton.tsx`, `packages/desktop/src/renderer/voice/VoiceSettings.tsx`
- Изменить: `packages/desktop/src/renderer/store/ui.ts` (`SettingsSection`, `settingsSection`, `openSettingsDialog(section?)`), `packages/desktop/src/renderer/components/settings/SettingsDialog.tsx`, `packages/desktop/src/renderer/voice/wire.ts`
- Тесты: `packages/desktop/src/renderer/voice/MicButton.test.tsx`, `packages/desktop/src/renderer/voice/VoiceSettings.test.tsx`, `packages/desktop/src/renderer/components/settings/SettingsDialog.test.tsx`

**Интерфейсы:**
- Берёт: `useDictationStore` (задача 8), `useUiStore`, `VOICE_MODELS`, `WHISPER_LANGUAGES`, `VoiceApi` (задача 1), `levelWidth` (задача 7), `S.voice` (задача 8).
- Отдаёт:
  - `MicButton({ targetId, size }: { targetId: string; size?: 'default' | 'sm' })`, `formatElapsed(ms): string`;
  - `VoiceSettings({ voice }: { voice: VoiceApi })`;
  - `type SettingsSection = 'appearance' | 'terminal' | 'agents' | 'notifications' | 'browser' | 'voice'`;
  - `UiState.settingsSection`, `UiState.openSettingsDialog(section?: SettingsSection)`.

- [ ] **Шаг 1. Написать падающие тесты.**

```tsx
// packages/desktop/src/renderer/voice/MicButton.test.tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../shared/strings.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { useUiStore } from '../store/ui.js';
import { useDictationStore } from './dictation-store.js';
import { formatElapsed, MicButton } from './MicButton.js';

const toggle = vi.fn(async () => undefined);

function setVoice(enabled: boolean): void {
  useUiStore.setState({ ui: { ...DEFAULT_UI, voice: { enabled, model: enabled ? 'small' : null, language: 'auto' } } });
}

beforeEach(() => {
  toggle.mockClear();
  useDictationStore.setState({ phase: 'idle', targetId: null, level: 0, startedAt: null, toggle });
});
afterEach(cleanup);

describe('MicButton (спека 3.2)', () => {
  it('голос не настроен — тусклая, «Set up voice input», клик идёт в toggle (он откроет настройки)', () => {
    setVoice(false);
    render(<MicButton targetId="room" />);
    const button = screen.getByRole('button', { name: S.voice.setUp });
    expect(screen.getByTestId('mic').dataset.state).toBe('setup');
    fireEvent.click(button);
    expect(toggle).toHaveBeenCalledWith('room');
  });

  it('готово — «Dictate (⌘⇧M)»; mousedown не уводит фокус из поля', () => {
    setVoice(true);
    render(<MicButton targetId="room" />);
    const button = screen.getByRole('button', { name: S.voice.dictate });
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it('запись своей цели — «Stop dictation», полоска громкости и таймер', () => {
    setVoice(true);
    useDictationStore.setState({ phase: 'recording', targetId: 'room', level: 0.05, startedAt: Date.now() - 7_000 });
    render(<MicButton targetId="room" />);
    expect(screen.getByRole('button', { name: S.voice.stop })).toBeTruthy();
    expect(screen.getByTestId('mic').dataset.state).toBe('recording');
    expect(screen.getByTestId('mic-elapsed').textContent).toBe('0:07');
  });

  it('запись чужой цели — своя кнопка готова; распознавание — все кнопки недоступны', () => {
    setVoice(true);
    useDictationStore.setState({ phase: 'recording', targetId: 'chat', startedAt: Date.now() });
    const { rerender } = render(<MicButton targetId="room" />);
    expect(screen.getByTestId('mic').dataset.state).toBe('ready');
    useDictationStore.setState({ phase: 'transcribing', targetId: 'chat' });
    rerender(<MicButton targetId="room" />);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('распознавание своей цели — спиннер и «Transcribing…»', () => {
    setVoice(true);
    useDictationStore.setState({ phase: 'transcribing', targetId: 'room' });
    render(<MicButton targetId="room" />);
    expect(screen.getByTestId('mic').dataset.state).toBe('transcribing');
    expect(screen.getByText(S.voice.transcribing)).toBeTruthy();
  });

  it('formatElapsed', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_400)).toBe('1:05');
  });
});
```

```tsx
// packages/desktop/src/renderer/voice/VoiceSettings.test.tsx
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { S } from '../../shared/strings.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { useUiStore } from '../store/ui.js';
import { VoiceSettings } from './VoiceSettings.js';

let bridge: FakeBridge;
const saved: unknown[] = [];

beforeEach(() => {
  bridge = createFakeBridge();
  saved.length = 0;
  useUiStore.setState({
    ui: { ...DEFAULT_UI },
    uiLoaded: true,
    patchUi: (patch) => {
      saved.push(patch);
      useUiStore.setState((state) => ({ ui: { ...state.ui, ...patch } }));
    },
  });
});
afterEach(cleanup);

/** Строка модели: название и размер стоят в одном узле, поэтому ищем по `data-voice-model`, а не по тексту. */
const row = (id: string): HTMLElement => document.querySelector(`[data-voice-model="${id}"]`) as HTMLElement;

describe('VoiceSettings (спека 3.1, 6.2)', () => {
  it('без модели переключатель недоступен и есть подсказка', async () => {
    render(<VoiceSettings voice={bridge.voice} />);
    await waitFor(() => expect(screen.getByText(S.voice.settings.downloadFirst)).toBeTruthy());
    expect((screen.getByRole('switch', { name: S.voice.settings.enable }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Download → модель в списке, выбрана; переключатель включается', async () => {
    render(<VoiceSettings voice={bridge.voice} />);
    fireEvent.click(within(row('base')).getByRole('button', { name: S.voice.settings.download }));
    await waitFor(() => expect(within(row('base')).getByRole('button', { name: S.voice.settings.remove })).toBeTruthy());
    expect(useUiStore.getState().ui.voice.model).toBe('base');
    const toggle = screen.getByRole('switch', { name: S.voice.settings.enable }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    expect(useUiStore.getState().ui.voice.enabled).toBe(true);
  });

  it('Delete выбранной модели — выбор на другую скачанную; последней — голос выключен', async () => {
    bridge.setVoiceModels(['base', 'small']);
    useUiStore.setState({ ui: { ...DEFAULT_UI, voice: { enabled: true, model: 'base', language: 'auto' } } });
    render(<VoiceSettings voice={bridge.voice} />);
    await waitFor(() => expect(within(row('base')).getByRole('button', { name: S.voice.settings.remove })).toBeTruthy());
    fireEvent.click(within(row('base')).getByRole('button', { name: S.voice.settings.remove }));
    await waitFor(() => expect(useUiStore.getState().ui.voice).toMatchObject({ model: 'small', enabled: true }));
    fireEvent.click(within(row('small')).getByRole('button', { name: S.voice.settings.remove }));
    await waitFor(() => expect(useUiStore.getState().ui.voice).toMatchObject({ model: null, enabled: false }));
  });

  it('прогресс скачивания виден в строке модели', async () => {
    render(<VoiceSettings voice={bridge.voice} />);
    bridge.emitVoiceProgress({ id: 'small', receivedBytes: 243_800_983, totalBytes: 487_601_967 });
    await waitFor(() => expect(within(row('small')).getByText(/^50% · 244 of 488 MB$/)).toBeTruthy());
  });
});
```

  В `SettingsDialog.test.tsx` — помощником файла `openSettings(bridge)`:

```tsx
it('openSettingsDialog("voice") — диалог открывается на вкладке Voice', async () => {
  const bridge = createFakeBridge();
  useUiStore.getState().openSettingsDialog('voice');
  openSettings(bridge);
  expect(await screen.findByRole('switch', { name: S.voice.settings.enable })).toBeTruthy();
});
```

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/renderer/voice src/renderer/components/settings` → FAIL.

- [ ] **Шаг 3. Реализовать store/ui.ts.**
  - Объявить `export type SettingsSection = 'appearance' | 'terminal' | 'agents' | 'notifications' | 'browser' | 'voice';`.
  - В `UiState` добавить поле `settingsSection: SettingsSection;` с JSDoc «вкладка, с которой откроются настройки (`openSettingsDialog(section)`)».
  - Сигнатуру заменить на `openSettingsDialog: (section?: SettingsSection) => void;`.
  - В начальное состояние добавить `settingsSection: 'appearance',`.
  - Реализация: `openSettingsDialog: (section) => set((state) => ({ dialogs: { ...state.dialogs, settings: true }, settingsSection: section ?? 'appearance' })),`.
  - В `voice/wire.ts` заменить вызов на `openSettingsDialog('voice')`.

- [ ] **Шаг 4. Реализовать MicButton.**

```tsx
// packages/desktop/src/renderer/voice/MicButton.tsx
/**
 * Кнопка микрофона (спека 3.2): одна для всех целей. Голос не настроен — тусклая, клик открывает Settings → Voice
 * (это делает `toggle` store). Запись своей цели — красная точка, полоска громкости и таймер; распознавание —
 * спиннер, и недоступны все кнопки окна (одна очередь). `mousedown` гасится: фокус и каретка остаются в поле.
 */
import { Loader2, Mic } from 'lucide-react';
import { useEffect, useState } from 'react';
import { S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { useUiStore } from '../store/ui.js';
import { Button } from '../ui/button.js';
import { useDictationStore } from './dictation-store.js';
import { levelWidth } from './level.js';

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

export interface MicButtonProps {
  targetId: string;
  /** `sm` — в тулбаре вкладки (высота 24). */
  size?: 'default' | 'sm';
}

export function MicButton({ targetId, size = 'default' }: MicButtonProps): JSX.Element {
  const configured = useUiStore((state) => state.ui.voice.enabled && state.ui.voice.model !== null);
  const phase = useDictationStore((state) => state.phase);
  const own = useDictationStore((state) => state.targetId === targetId);
  const level = useDictationStore((state) => (state.targetId === targetId ? state.level : 0));
  const startedAt = useDictationStore((state) => (state.targetId === targetId ? state.startedAt : null));
  const elapsed = useElapsed(phase === 'recording' && own ? startedAt : null);

  const state = !configured ? 'setup' : phase === 'recording' && own ? 'recording' : phase === 'transcribing' && own ? 'transcribing' : 'ready';
  const title =
    state === 'setup' ? S.voice.setUp : state === 'recording' ? S.voice.stop : state === 'transcribing' ? S.voice.transcribing : S.voice.dictate;

  return (
    <span data-testid="mic" data-target={targetId} data-state={state} className="inline-flex shrink-0 items-center gap-1.5">
      {state === 'recording' ? (
        <>
          <span aria-hidden="true" className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
            <span className="block h-full bg-destructive transition-[width]" style={{ width: `${Math.round(levelWidth(level) * 100)}%` }} />
          </span>
          <span data-testid="mic-elapsed" className="text-xs tabular-nums text-muted-foreground">
            {formatElapsed(elapsed)}
          </span>
        </>
      ) : null}
      {state === 'transcribing' ? <span className="text-xs text-muted-foreground">{S.voice.transcribing}</span> : null}
      <Button
        type="button"
        variant="outline"
        title={title}
        aria-label={title}
        disabled={phase === 'transcribing'}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void useDictationStore.getState().toggle(targetId)}
        className={cn(size === 'sm' ? 'size-6 px-0' : 'size-[38px] rounded-full px-0', state === 'setup' && 'opacity-50')}
      >
        {state === 'recording' ? (
          <span aria-hidden="true" className="size-2.5 rounded-full bg-destructive" />
        ) : state === 'transcribing' ? (
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        ) : (
          <Mic aria-hidden="true" className="size-4" />
        )}
      </Button>
    </span>
  );
}
```

- [ ] **Шаг 5. Реализовать VoiceSettings.**

```tsx
// packages/desktop/src/renderer/voice/VoiceSettings.tsx
/**
 * Вкладка Settings → Voice (спека 3.1, 6.2): переключатель (только при скачанной модели), три модели с
 * Download / Cancel / Delete и прогрессом, язык, горячая клавиша. Выбор пишет `ui.json` через `patchUi`; список
 * скачанного и прогресс — у main (`bridge.voice`).
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { S } from '../../shared/strings.js';
import { VOICE_MODELS, WHISPER_LANGUAGES, type DownloadResult, type VoiceApi, type VoiceModelId } from '../../shared/voice-types.js';
import { useUiStore } from '../store/ui.js';
import { Button } from '../ui/button.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js';
import { Switch } from '../ui/switch.js';

/** Список языков: Auto, English, Russian, затем остальные по алфавиту (спека 3.1). */
const LANGUAGE_OPTIONS = [
  { code: 'auto', name: S.voice.settings.auto },
  ...WHISPER_LANGUAGES.filter((language) => language.code === 'en' || language.code === 'ru').sort((a, b) => a.name.localeCompare(b.name)),
  ...WHISPER_LANGUAGES.filter((language) => language.code !== 'en' && language.code !== 'ru'),
];

export function VoiceSettings({ voice }: { voice: VoiceApi }): JSX.Element {
  const settings = useUiStore((state) => state.ui.voice);
  const patchUi = useUiStore((state) => state.patchUi);
  const [downloaded, setDownloaded] = useState<readonly VoiceModelId[]>([]);
  const [progress, setProgress] = useState<Partial<Record<VoiceModelId, number>>>({});
  const [busy, setBusy] = useState<Partial<Record<VoiceModelId, true>>>({});

  const refresh = useCallback(async (): Promise<readonly VoiceModelId[]> => {
    const list = await voice.listModels().catch(() => [] as VoiceModelId[]);
    setDownloaded(list);
    return list;
  }, [voice]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => voice.onProgress((next) => setProgress((prev) => ({ ...prev, [next.id]: next.receivedBytes }))), [voice]);

  const patchVoice = (patch: Partial<typeof settings>): void => {
    patchUi({ voice: { ...useUiStore.getState().ui.voice, ...patch } });
  };

  const download = async (id: VoiceModelId): Promise<void> => {
    setBusy((prev) => ({ ...prev, [id]: true }));
    const result: DownloadResult = await voice.downloadModel(id).catch(() => ({ error: 'network' }) as const);
    setBusy(({ [id]: _done, ...rest }) => rest);
    setProgress(({ [id]: _done, ...rest }) => rest);
    if ('ok' in result) {
      await refresh();
      if (useUiStore.getState().ui.voice.model === null) patchVoice({ model: id });
      return;
    }
    if (result.error === 'disk_full') toast(S.voice.diskFull(Math.ceil(result.needBytes / 1_000_000)));
    else if (result.error === 'corrupted') toast(S.voice.downloadCorrupted);
    else if (result.error === 'network') toast(S.voice.downloadFailed);
  };

  const remove = async (id: VoiceModelId): Promise<void> => {
    await voice.removeModel(id).catch(() => undefined);
    const list = await refresh();
    const current = useUiStore.getState().ui.voice;
    if (current.model !== id) return;
    const next = list[0] ?? null;
    patchVoice({ model: next, enabled: next !== null && current.enabled });
  };

  const hasModel = downloaded.length > 0;

  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex items-center justify-between gap-2">
        <span>{S.voice.settings.enable}</span>
        <Switch
          aria-label={S.voice.settings.enable}
          checked={settings.enabled && hasModel}
          disabled={!hasModel}
          onCheckedChange={(checked) => patchVoice({ enabled: checked })}
        />
      </label>
      {hasModel ? null : <p className="text-xs text-muted-foreground">{S.voice.settings.downloadFirst}</p>}

      <div className="flex flex-col gap-2">
        <span>{S.voice.settings.model}</span>
        {VOICE_MODELS.map((model) => {
          const text = S.voice.models[model.id];
          const isDownloaded = downloaded.includes(model.id);
          const received = progress[model.id];
          return (
            <div key={model.id} data-voice-model={model.id} className="flex min-w-0 items-center gap-2">
              <input
                type="radio"
                name="voice-model"
                aria-label={text.name}
                checked={settings.model === model.id}
                disabled={!isDownloaded}
                onChange={() => patchVoice({ model: model.id })}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">
                  {text.name} · {S.voice.settings.sizeMb(Math.round(model.bytes / 1_000_000))}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {received !== undefined ? S.voice.settings.progress(received, model.bytes) : text.hint}
                </span>
              </span>
              {busy[model.id] === true ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void voice.cancelDownload(model.id)}>
                  {S.voice.settings.cancel}
                </Button>
              ) : isDownloaded ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void remove(model.id)}>
                  {S.voice.settings.remove}
                </Button>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={() => void download(model.id)}>
                  {S.voice.settings.download}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <label className="flex flex-col gap-1">
        <span>{S.voice.settings.language}</span>
        <Select value={settings.language} onValueChange={(language) => patchVoice({ language })}>
          <SelectTrigger aria-label={S.voice.settings.language}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {LANGUAGE_OPTIONS.map((language) => (
              <SelectItem key={language.code} value={language.code}>
                {language.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <div className="flex items-center justify-between">
        <span>{S.voice.settings.shortcut}</span>
        <kbd className="text-xs text-muted-foreground">{S.voice.settings.shortcutKeys}</kbd>
      </div>
      <p className="text-xs text-muted-foreground">{S.voice.settings.hint}</p>
    </div>
  );
}
```

  Если у `Button` нет размера `sm`, взять тот, которым пользуются соседние кнопки настроек (`variant="outline"` и класс `h-7 px-2 text-xs`). Строку прогресса обновляет `onProgress`; при отмене main отвечает `cancelled`, и строка возвращается к подсказке.

- [ ] **Шаг 6. Подключить в SettingsDialog.**
  - Удалить локальный `type SettingsSection` и импортировать его из `../../store/ui.js`.
  - В `SECTION_LABELS` добавить `voice: S.settings.sections.voice`, в `SECTION_ORDER` дописать `'voice'` последним.
  - Читать раздел: `const settingsSection = useUiStore((state) => state.settingsSection);`, затем `useEffect(() => { if (open) setSection(settingsSection); }, [open, settingsSection]);`.
  - Ширину диалога поднять с `w-[28rem] max-w-[28rem]` до `w-[32rem] max-w-[32rem]` (шесть вкладок) и обновить комментарий.
  - После `TabsContent value="browser"` добавить:

```tsx
          <TabsContent value="voice">
            {uiLoaded ? <VoiceSettings voice={bridge.voice} /> : null}
          </TabsContent>
```

  и импорт `import { VoiceSettings } from '../../voice/VoiceSettings.js';`.

- [ ] **Шаг 7. Запустить — проходит.**
  - `pnpm --filter @parley/desktop exec vitest run src/renderer/voice src/renderer/components/settings src/renderer/store src/english-ui.test.ts` → PASS.
  - `pnpm --filter @parley/desktop typecheck` → без ошибок.

- [ ] **Шаг 8. Закоммитить.**

```bash
git add packages/desktop/src/renderer/voice packages/desktop/src/renderer/store/ui.ts packages/desktop/src/renderer/components/settings
git commit -m "feat(desktop): кнопка микрофона и вкладка Settings → Voice"
```

---

## Задача 10. Кнопка в полях: комната, чат, New workspace

**Файлы:**
- Создать: `packages/desktop/src/renderer/voice/insert.ts`, `packages/desktop/src/renderer/voice/targets.ts`
- Изменить: `packages/desktop/src/renderer/components/rooms/Composer.tsx`, `packages/desktop/src/renderer/chat/Composer.tsx`, `packages/desktop/src/renderer/chat/ChatView.tsx`, `packages/desktop/src/renderer/sidebar/NewWorkComposer.tsx`
- Тесты: `packages/desktop/src/renderer/voice/insert.test.ts`, `packages/desktop/src/renderer/components/rooms/Composer.test.tsx`, `packages/desktop/src/renderer/chat/ChatView.test.tsx`, `packages/desktop/src/renderer/sidebar/NewWorkComposer.test.tsx`

**Интерфейсы:**
- Берёт: `useDictationStore`, `DictationTarget` (задача 8), `MicButton` (задача 9), `insertPlainText` (`components/rooms/mention-editor.ts`), `matchesAccelerator` (`shared/keybindings.ts`).
- Отдаёт:
  - `joinTranscript(before: string, transcript: string): string`;
  - `spliceTranscript(value: string, caret: number, transcript: string): { value: string; caret: number }`;
  - `useTextareaDictation(id: string, field: RefObject<HTMLTextAreaElement | null>, apply: (value: string) => void): void`;
  - `useEditableDictation(id: string, editor: RefObject<HTMLElement | null>, onChange: () => void): void`;
  - `VOICE_ACCELERATOR = 'CmdOrCtrl+Shift+M'`, `isVoiceShortcut(event: KeyLike): boolean`;
  - ids целей: `room:<draftKey>`, `chat:<refKey>`, `new-workspace`.

- [ ] **Шаг 1. Написать падающие тесты.**

```ts
// packages/desktop/src/renderer/voice/insert.test.ts
import { describe, expect, it } from 'vitest';
import { joinTranscript, spliceTranscript } from './insert.js';

describe('вставка расшифровки (спека 3.3, Фокус ревью 1)', () => {
  it('пробел слева — только если перед кареткой не пусто и нет пробела', () => {
    expect(joinTranscript('', 'hello')).toBe('hello');
    expect(joinTranscript('fix ', 'hello')).toBe('hello');
    expect(joinTranscript('fix\n', 'hello')).toBe('hello');
    expect(joinTranscript('fix', 'hello')).toBe(' hello');
  });

  it('середина многострочного текста: правая часть цела, каретка — в конце вставки', () => {
    const value = 'line one\nline two tail';
    const caret = 'line one\nline two'.length;
    expect(spliceTranscript(value, caret, 'inserted')).toEqual({ value: 'line one\nline two inserted tail', caret: caret + ' inserted'.length });
  });

  it('каретка за пределами — в конец', () => {
    expect(spliceTranscript('abc', 99, 'x')).toEqual({ value: 'abc x', caret: 5 });
  });
});
```

  В `components/rooms/Composer.test.tsx` (там `execCommand` уже подменён в `beforeEach`):

```tsx
describe('диктовка в поле комнаты (спека 3.2)', () => {
  let dispose: () => void = () => undefined;
  afterEach(() => dispose());

  it('кнопка микрофона есть; стоп — текст встал в поле, письмо не ушло', async () => {
    useUiStore.setState({ ui: { ...useUiStore.getState().ui, voice: { enabled: true, model: 'small', language: 'auto' } } });
    dispose = useDictationStore.getState().configure(fakeDictationDeps('hello from voice'));
    const { onSend } = renderComposer();
    const mic = screen.getByTestId('mic');
    fireEvent.click(within(mic).getByRole('button'));
    await waitFor(() => expect(mic.dataset.state).toBe('recording'));
    fireEvent.click(within(mic).getByRole('button'));
    await waitFor(() => expect(screen.getByRole('textbox').textContent).toBe('hello from voice'));
    expect(onSend).not.toHaveBeenCalled();
  });
});
```

  Помощник `fakeDictationDeps` положить в `renderer/test-utils/dictation.ts`: его зовут все тесты задач 10 и 11.

```ts
// packages/desktop/src/renderer/test-utils/dictation.ts
import { vi } from 'vitest';
import type { DictationDeps } from '../voice/dictation-store.js';

/** Подставные зависимости диктовки: микрофон есть, запись громкая, распознавание отдаёт `text`. */
export function fakeDictationDeps(text: string): DictationDeps {
  return {
    voice: {
      transcribe: vi.fn(async () => ({ text })),
      micStatus: vi.fn(async () => 'granted' as const),
      requestMic: vi.fn(async () => true),
      openMicSettings: vi.fn(async () => undefined),
    },
    settings: () => ({ enabled: true, model: 'small', language: 'auto' }),
    record: vi.fn(async () => ({ stop: async () => ({ pcm: new ArrayBuffer(4), durationMs: 1000, peak: 0.5 }), cancel: vi.fn() })),
    toast: vi.fn(),
    openVoiceSettings: vi.fn(),
    copy: vi.fn(async () => undefined),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    now: () => Date.now(),
  };
}
```

  В `chat/ChatView.test.tsx`, внутри `describe('ChatView — поле ввода и тулбар')` — там уже есть помощники `field()` и `sends()`:

```tsx
it('диктовка в поле чата: текст в поле, pty.send не звался', async () => {
  useUiStore.setState({ ui: { ...useUiStore.getState().ui, voice: { enabled: true, model: 'small', language: 'auto' } } });
  const dispose = useDictationStore.getState().configure(fakeDictationDeps('hello from voice'));
  renderBody(makeSession('s-01', 'S01'));
  setFeed([]);
  const mic = screen.getByTestId('mic');
  fireEvent.click(within(mic).getByRole('button'));
  await waitFor(() => expect(mic.dataset.state).toBe('recording'));
  fireEvent.click(within(mic).getByRole('button'));
  await waitFor(() => expect(field().value).toBe('hello from voice'));
  expect(sends()).toEqual([]);
  dispose();
});
```

  В `sidebar/NewWorkComposer.test.tsx` — помощниками файла `renderComposer()` и `promptField()`:

```tsx
it('⌘⇧M в поле первого промпта внутри диалога — диктовка; Esc записи не закрывает диалог', async () => {
  useUiStore.setState({ ui: { ...useUiStore.getState().ui, voice: { enabled: true, model: 'small', language: 'auto' } } });
  const dispose = useDictationStore.getState().configure(fakeDictationDeps('hello from voice'));
  await renderComposer();
  const prompt = promptField();
  prompt.focus();
  fireEvent.keyDown(prompt, { key: 'M', code: 'KeyM', metaKey: true, shiftKey: true });
  await waitFor(() => expect(screen.getByTestId('mic').dataset.state).toBe('recording'));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.keyDown(prompt, { key: 'M', code: 'KeyM', metaKey: true, shiftKey: true });
  await waitFor(() => expect(screen.getByTestId('mic').dataset.state).toBe('recording'));
  fireEvent.keyDown(prompt, { key: 'M', code: 'KeyM', metaKey: true, shiftKey: true });
  await waitFor(() => expect(prompt.value).toBe('hello from voice'));
  dispose();
});
```

  Импорты в тестах задачи: `within` из `@testing-library/react`, `useDictationStore` из `voice/dictation-store.js`, `fakeDictationDeps` из `test-utils/dictation.js`, а где нет — `useUiStore` и `S`. Поле промпта ищется по началу подписи (`/^First prompt/`): ошибка поля стоит под ним и в подпись больше не входит.

- [ ] **Шаг 2. Запустить — падает.**

  `pnpm --filter @parley/desktop exec vitest run src/renderer/voice/insert.test.ts src/renderer/components/rooms/Composer.test.tsx src/renderer/chat/ChatView.test.tsx src/renderer/sidebar/NewWorkComposer.test.tsx` → FAIL.

- [ ] **Шаг 3. Реализовать вставку и цели.**

```ts
// packages/desktop/src/renderer/voice/insert.ts
/** Расшифровка встаёт на место каретки (спека 3.3): один пробел слева, если перед кареткой текст без пробела. */

export function joinTranscript(before: string, transcript: string): string {
  return before === '' || /\s$/.test(before) ? transcript : ` ${transcript}`;
}

export function spliceTranscript(value: string, caret: number, transcript: string): { value: string; caret: number } {
  const at = Math.max(0, Math.min(caret, value.length));
  const piece = joinTranscript(value.slice(0, at), transcript);
  return { value: value.slice(0, at) + piece + value.slice(at), caret: at + piece.length };
}
```

```ts
// packages/desktop/src/renderer/voice/targets.ts
/**
 * Цели диктовки для полей (спека 3.2–3.4): `textarea` (чат, первый промпт) и contentEditable (комната). Каретка
 * запоминается в начале записи, только если фокус в поле; иначе текст встаёт в конец. Последние `apply` и `onChange`
 * берутся из ref: цель регистрируется один раз на id.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { matchesAccelerator, type KeyLike } from '../../shared/keybindings.js';
import { insertPlainText } from '../components/rooms/mention-editor.js';
import { useDictationStore } from './dictation-store.js';
import { joinTranscript, spliceTranscript } from './insert.js';

export const VOICE_ACCELERATOR = 'CmdOrCtrl+Shift+M';

export function isVoiceShortcut(event: KeyLike): boolean {
  return matchesAccelerator(VOICE_ACCELERATOR, event);
}

export function useTextareaDictation(id: string, field: RefObject<HTMLTextAreaElement | null>, apply: (value: string) => void): void {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    let caret: number | null = null;
    return useDictationStore.getState().register({
      id,
      element: () => field.current,
      remember: () => {
        const el = field.current;
        caret = el !== null && el.ownerDocument.activeElement === el ? el.selectionStart : null;
      },
      insert: (text) => {
        const el = field.current;
        const value = el?.value ?? '';
        const next = spliceTranscript(value, caret ?? value.length, text);
        applyRef.current(next.value);
        if (el !== null) {
          requestAnimationFrame(() => {
            el.focus();
            el.setSelectionRange(next.caret, next.caret);
          });
        }
      },
    });
  }, [id, field]);
}

export function useEditableDictation(id: string, editor: RefObject<HTMLElement | null>, onChange: () => void): void {
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  useEffect(() => {
    let saved: Range | null = null;
    return useDictationStore.getState().register({
      id,
      element: () => editor.current,
      remember: () => {
        const el = editor.current;
        const selection = el?.ownerDocument.getSelection();
        const range = selection !== null && selection !== undefined && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
        saved = el !== null && range !== null && el.contains(range.startContainer) ? range.cloneRange() : null;
      },
      insert: (text) => {
        const el = editor.current;
        if (el === null) return;
        const doc = el.ownerDocument;
        el.focus();
        let range = saved !== null && el.contains(saved.startContainer) ? saved : null;
        if (range === null) {
          range = doc.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
        }
        const selection = doc.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        const before = doc.createRange();
        before.selectNodeContents(el);
        before.setEnd(range.startContainer, range.startOffset);
        insertPlainText(doc, joinTranscript(before.toString(), text));
        changeRef.current();
      },
    });
  }, [id, editor]);
}
```

- [ ] **Шаг 4. Встроить в поля.**
  - **Комната** (`components/rooms/Composer.tsx`):
    - добавить `useEditableDictation(\`room:${draftKey}\`, editorRef, refresh);` после объявления `refresh`;
    - в строке `<div className="flex items-end gap-2">` перед `<Button type="button" onClick={submit}>` вставить `<MicButton targetId={\`room:${draftKey}\`} />`;
    - импорты `MicButton` из `../../voice/MicButton.js` и `useEditableDictation` из `../../voice/targets.js`.
  - **Чат** (`chat/Composer.tsx`):
    - в `ComposerProps` добавить `/** Id цели диктовки (`chat:<refKey>`, спека 3.2). */ dictationId: string;`;
    - в функции: `useTextareaDictation(dictationId, field, (value) => { onTextChange(value); setCaretAt(value.length); });`;
    - после кнопки скрепки (`data-testid="chat-attach"`) вставить `<MicButton targetId={dictationId} />`.
  - **ChatView** (`chat/ChatView.tsx`): передать `<Composer … dictationId={\`chat:${sessionKey}\`} />`.
  - **New workspace** (`sidebar/NewWorkComposer.tsx`):
    - `const promptRef = useRef<HTMLTextAreaElement>(null);` и `useTextareaDictation('new-workspace', promptRef, setPrompt);`;
    - метку и поле переделать так, чтобы кнопка не стала «контролом» `<label>`:

```tsx
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="new-work-prompt">{text.promptField}</label>
              <MicButton targetId="new-workspace" size="sm" />
            </div>
            <Textarea
              id="new-work-prompt"
              ref={promptRef}
              value={prompt}
              placeholder={text.promptPlaceholder}
              className="min-h-[96px] rounded-2xl"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                // В диалоге обработчик клавиш окна молчит (`keys/handler.ts`, контекст dialog): ⌘⇧M ловит само поле.
                if (!isVoiceShortcut(event)) return;
                event.preventDefault();
                void useDictationStore.getState().toggle('new-workspace');
              }}
            />
            {fieldError('prompt')}
          </div>
```

    - импорты `useRef`, `MicButton`, `useTextareaDictation`, `isVoiceShortcut`, `useDictationStore`;
    - если в файле уже есть обработчик `onKeyDown` поля промпта (например ⌘Enter), объединить: сначала проверка `isVoiceShortcut`, потом прежняя логика.

- [ ] **Шаг 5. Запустить — проходит.**
  - Та же команда, что в шаге 2 → PASS.
  - `pnpm --filter @parley/desktop test` → весь пакет зелёный: прежние тесты полей не сломаны.
  - `pnpm --filter @parley/desktop typecheck` → без ошибок.

- [ ] **Шаг 6. Закоммитить.**

```bash
git add packages/desktop/src/renderer/voice packages/desktop/src/renderer/test-utils/dictation.ts packages/desktop/src/renderer/components/rooms packages/desktop/src/renderer/chat packages/desktop/src/renderer/sidebar/NewWorkComposer.tsx packages/desktop/src/renderer/sidebar/NewWorkComposer.test.tsx
git commit -m "feat(desktop): диктовка в полях комнаты, чата и первого промпта"
```

---

## Задача 11. Терминал и горячая клавиша

**Файлы:**
- Изменить:
  - `packages/desktop/src/renderer/terminal/TerminalSurface.tsx` (цель терминала);
  - `packages/desktop/src/renderer/chat/ChatToolbar.tsx` (`micTargetId`);
  - `packages/desktop/src/renderer/layout/bodies/TerminalBody.tsx`;
  - `packages/desktop/src/shared/keybindings.ts` (`voice.toggle`);
  - `packages/desktop/src/renderer/keys/handler.ts` (`IMPLEMENTED_ACTIONS`);
  - `packages/desktop/src/renderer/palette/actions.ts` (`ActionContext.voice`, `case 'voice.toggle'`);
  - `packages/desktop/src/renderer/shell/AppShell.tsx` (`available`, `actionContext`).
- Тесты: `packages/desktop/src/renderer/terminal/TerminalSurface.test.tsx`, `packages/desktop/src/renderer/chat/ChatToolbar.test.tsx` (создать, если нет), `packages/desktop/src/shared/keybindings.test.ts`, `packages/desktop/src/renderer/keys/handler.test.ts`, `packages/desktop/src/renderer/palette/actions.test.ts`

**Интерфейсы:**
- Берёт: `useDictationStore` (задача 8), `MicButton` (задача 9), `sendWithToast` (`terminal/send.ts`), `refKey` (`@parley/protocol`).
- Отдаёт:
  - id цели терминала `terminal:<refKey>`;
  - `ChatToolbarProps.micTargetId?: string`;
  - `ActionId` `'voice.toggle'`;
  - `ActionContext.voice: { toggle(): void }`.

- [ ] **Шаг 1. Написать падающие тесты.**

  В `TerminalSurface.test.tsx`:

```tsx
it('диктовка в терминал: текст уходит вставкой без Enter (pty.send submit: false)', async () => {
  useUiStore.setState({ ui: { ...useUiStore.getState().ui, voice: { enabled: true, model: 'small', language: 'auto' } } });
  const dispose = useDictationStore.getState().configure(fakeDictationDeps('hello from voice'));
  const sent: unknown[] = [];
  bridge.setHandler('pty.send', (params) => {
    sent.push(params);
    return { inserted: true, submitted: false, reason: null };
  });
  renderSurface();
  const id = `terminal:${refKey(ref)}`;
  await useDictationStore.getState().toggle(id);
  await useDictationStore.getState().toggle(id);
  await waitFor(() => expect(sent).toEqual([{ ref, text: 'hello from voice', submit: false }]));
  dispose();
});
```

  Импорты в тесте: `useUiStore` (`../store/ui.js`), `useDictationStore` (`../voice/dictation-store.js`), `fakeDictationDeps` (`../test-utils/dictation.js`).

  Создать `chat/ChatToolbar.test.tsx`:

```tsx
// packages/desktop/src/renderer/chat/ChatToolbar.test.tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatToolbar } from './ChatToolbar.js';

afterEach(cleanup);

describe('ChatToolbar — кнопка микрофона вида Terminal (спека 3.2)', () => {
  it('micTargetId — кнопка микрофона в тулбаре; без него — нет', () => {
    const { rerender } = render(<ChatToolbar workKey="k" tabId="t" view="terminal" available micTargetId="terminal:x" />);
    expect(screen.getByTestId('mic').dataset.target).toBe('terminal:x');
    rerender(<ChatToolbar workKey="k" tabId="t" view="terminal" available />);
    expect(screen.queryByTestId('mic')).toBeNull();
  });
});
```

  В `keybindings.test.ts`:

```ts
it('voice.toggle — ⌘⇧M, меню Edit, везде, в палитре; сочетание ни с чем не совпадает', () => {
  const action = ACTIONS.find((candidate) => candidate.id === 'voice.toggle');
  expect(action).toMatchObject({ keys: 'CmdOrCtrl+Shift+M', menu: 'edit', when: 'always', inPalette: true });
  expect(ACTIONS.filter((candidate) => candidate.keys === 'CmdOrCtrl+Shift+M')).toHaveLength(1);
});
```

  В `handler.test.ts`:

```ts
it('⌘⇧M: в поле, в терминале и вне полей — voice.toggle; в диалоге — полю', () => {
  const event = { key: 'M', code: 'KeyM', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, isComposing: false, repeat: false };
  expect(resolveAction(event, 'input', false)).toBe('voice.toggle');
  expect(resolveAction(event, 'terminal', false)).toBe('voice.toggle');
  expect(resolveAction(event, 'other', false)).toBe('voice.toggle');
  expect(resolveAction(event, 'dialog', false)).toBeNull();
});
```

  Форму `KeyLike` взять ту, что в соседних тестах `handler.test.ts`.

  В `palette/actions.test.ts`: в `makeContext` добавить `voice: { toggle: vi.fn() }` и вернуть его среди шпионов:

```ts
it('voice.toggle зовёт ctx.voice.toggle', () => {
  const { ctx } = makeContext();
  runAction('voice.toggle', ctx);
  expect(ctx.voice.toggle).toHaveBeenCalled();
});
```

- [ ] **Шаг 2. Запустить — падает.**

  `pnpm --filter @parley/desktop exec vitest run src/renderer/terminal/TerminalSurface.test.tsx src/renderer/chat/ChatToolbar.test.tsx src/shared/keybindings.test.ts src/renderer/keys/handler.test.ts src/renderer/palette/actions.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать.**
  - **`TerminalSurface.tsx`**, в компоненте, где объявлен `sendDeps` (около строки 334):
    - завести `const wrapperRef = useRef<HTMLDivElement | null>(null);`;
    - повесить `ref={wrapperRef}` на корневой `<div className="relative flex h-full min-w-0 flex-col" …>`, который этот компонент возвращает;
    - после эффекта `terminalSurfaces.set(...)` добавить:

```tsx
  // Диктовка в терминал (спека 3.3): текст уходит вставкой без Enter — отправляет человек.
  const sendDepsRef = useRef(sendDeps);
  sendDepsRef.current = sendDeps;
  const sessionRefRef = useRef(sessionRef);
  sessionRefRef.current = sessionRef;
  useEffect(
    () =>
      useDictationStore.getState().register({
        id: `terminal:${sessionKey}`,
        element: () => wrapperRef.current,
        insert: (text) => void sendWithToast(sendDepsRef.current, sessionRefRef.current, text, false),
      }),
    [sessionKey],
  );
```

    - и импорт `import { useDictationStore } from '../voice/dictation-store.js';`.
  - **`ChatToolbar.tsx`**:
    - в `ChatToolbarProps` добавить `/** Цель диктовки вида Terminal (`terminal:<refKey>`, спека 3.2); нет — кнопки нет. */ micTargetId?: string;`;
    - принять в деструктуризации;
    - последним ребёнком корневого `<div data-testid="chat-toolbar">` вставить `{micTargetId === undefined ? null : <span className="ml-auto"><MicButton targetId={micTargetId} size="sm" /></span>}`.
  - **`TerminalBody.tsx`**: передать `micTargetId={\`terminal:${refKey(sessionRef)}\`}` в `ChatToolbar` вида `terminal` и импортировать `refKey` из `@parley/protocol`.
  - **`keybindings.ts`**:
    - в `ActionId` дописать `| 'voice.toggle'`;
    - в `ACTIONS` сразу после строки `find` добавить:

```ts
  // Диктовка (спека 2026-10-06-voice-input-design.md, 3.4): поле или терминал с фокусом; идёт запись — её стоп.
  { id: 'voice.toggle', title: S.actions.toggleDictation, keywords: ['voice', 'dictation', 'microphone', 'speech'], keys: 'CmdOrCtrl+Shift+M', menu: 'edit', when: 'always', inPalette: true },
```

  - **`keys/handler.ts`**: дописать `'voice.toggle',` в `IMPLEMENTED_ACTIONS`.
  - **`palette/actions.ts`**:
    - в `ActionContext` добавить `/** Диктовка (спека 3.4): цель с фокусом или последняя, идёт запись — её стоп. */ voice: { toggle(): void };`;
    - в `runAction` добавить ветку `case 'voice.toggle': ctx.voice.toggle(); return;`.
  - **`AppShell.tsx`**:
    - в `available(id)` первой строкой: `if (id === 'voice.toggle' && !useDictationStore.getState().canToggleFocused()) return false;`. Так ⌘⇧M вне полей и без настроенного голоса не гасится;
    - в объект контекста действий (рядом с `ui: {…}`) добавить `voice: { toggle: () => { useDictationStore.getState().toggleFocused(); } },`;
    - импорт `useDictationStore`.

- [ ] **Шаг 4. Запустить — проходит.**
  - Команда из шага 2 → PASS.
  - Затем `pnpm --filter @parley/desktop test` и `pnpm --filter @parley/desktop typecheck` → зелёные.
  - Если `menu.test.ts` или `guest-shortcuts.test.ts` пересчитывают пункты меню Edit или пересылаемые сочетания, обновить ожидания: в них появилось `voice.toggle`.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/src
git commit -m "feat(desktop): диктовка в терминал сессии и горячая клавиша ⌘⇧M"
```

---

## Задача 12. Сборка движка и релиз

**Файлы:**
- Создать: `packages/desktop/scripts/fetch-whisper.mjs`, `packages/desktop/src/fetch-whisper.test.ts`
- Изменить:
  - `packages/desktop/package.json` (скрипт `fetch-whisper`);
  - `.gitignore` (`packages/desktop/build/whisper/`);
  - `packages/desktop/electron-builder.yml` (`extraResources`, `mac.extendInfo`);
  - `.github/workflows/release.yml`;
  - `scripts/release/verify-packaged-apps.sh`;
  - `NOTICE`.
- Тесты: `packages/desktop/src/fetch-whisper.test.ts`, `packages/desktop/src/release-config.test.ts`, `packages/desktop/src/notice.test.ts`, `packages/desktop/src/verify-packaged-apps.test.ts`

**Интерфейсы:**
- Берёт из `fetch-node.mjs`: `sha256`, `machOArch`, `parseArchs`, `ARCHS`. Из `main/voice/engine.ts`: `VAD_MODEL_FILE` — сверка в тесте.
- Отдаёт: `WHISPER_VERSION`, `WHISPER_SOURCE_SHA256`, `WHISPER_SOURCE_URL`, `VAD_MODEL`, `DEFAULT_OUT_ROOT`, `cmakeArgs(arch, sourceDir, buildDir): string[]`, `isUpToDate(stamp, expected): boolean`, `main(args)`.

- [ ] **Шаг 1. Написать падающие тесты.**

```ts
// packages/desktop/src/fetch-whisper.test.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cmakeArgs, isUpToDate, VAD_MODEL, WHISPER_SOURCE_SHA256, WHISPER_SOURCE_URL, WHISPER_VERSION } from '../scripts/fetch-whisper.mjs';
import { VAD_MODEL_FILE } from './main/voice/engine.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('fetch-whisper (спека 4.3)', () => {
  it('версия и sha256 закреплены', () => {
    expect(WHISPER_VERSION).toBe('1.9.4');
    expect(WHISPER_SOURCE_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(WHISPER_SOURCE_URL).toBe('https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.4.tar.gz');
  });

  it('модель VAD — та, что ищет окно', () => {
    expect(VAD_MODEL.file).toBe(VAD_MODEL_FILE);
    expect(VAD_MODEL.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('arm64 — Metal со встроенной библиотекой; x64 — без Metal, с AVX2; оба статические и без -march=native', () => {
    const arm = cmakeArgs('arm64', '/src', '/b');
    expect(arm).toEqual(expect.arrayContaining(['-DCMAKE_OSX_ARCHITECTURES=arm64', '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF']));
    const x64 = cmakeArgs('x64', '/src', '/b');
    expect(x64).toEqual(expect.arrayContaining(['-DCMAKE_OSX_ARCHITECTURES=x86_64', '-DGGML_METAL=OFF', '-DGGML_AVX2=ON', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF']));
    expect(x64).not.toContain('-DGGML_METAL=ON');
  });

  it('повторный запуск ничего не собирает, пока версия и sha256 VAD те же', () => {
    const expected = { version: '1.9.4', vadSha256: VAD_MODEL.sha256 };
    expect(isUpToDate({ version: '1.9.4', vadSha256: VAD_MODEL.sha256 }, expected)).toBe(true);
    expect(isUpToDate({ version: '1.9.3', vadSha256: VAD_MODEL.sha256 }, expected)).toBe(false);
    expect(isUpToDate(null, expected)).toBe(false);
  });

  it('build/whisper скрыт от git', () => {
    expect(readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')).toMatch(/^packages\/desktop\/build\/whisper\/$/m);
  });
});
```

  В `release-config.test.ts`:

```ts
it('движок голоса: build/whisper/darwin-${arch} → Resources/whisper; текст запроса микрофона', () => {
  expect(builder).toMatch(/- from: build\/whisper\/darwin-\$\{arch\}\n\s+to: whisper\n/);
  expect(builder).toMatch(/NSMicrophoneUsageDescription: Parley uses the microphone for voice dictation\. Audio is transcribed on this Mac and never leaves it\./);
});

it('релиз собирает движок обеих архитектур до упаковки', () => {
  const release = readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  expect(release.indexOf('fetch-whisper arm64 x64')).toBeGreaterThan(-1);
  expect(release.indexOf('fetch-whisper arm64 x64')).toBeLessThan(release.indexOf('Package for macOS'));
});
```

  Если переменные `builder` и `repoRoot` в этом файле называются иначе, взять их имена.

  В `notice.test.ts`:

```ts
it('NOTICE называет whisper.cpp и Silero VAD с их MIT', () => {
  expect(notice).toContain('whisper.cpp');
  expect(notice).toContain('Copyright (c) 2023-2026 The ggml authors');
  expect(notice).toContain('Silero VAD');
  expect(notice).toContain('Copyright (c) 2020-present Silero Team');
});
```

  В `verify-packaged-apps.test.ts`:
  - в `makeApp` положить движок:

```ts
  put(path.join(resources, 'whisper', 'bin', 'whisper-cli'), `#!/bin/sh\n${marker}[ "$1" = "--help" ] && exit 0\nexit 1\n`, 0o755);
  put(path.join(resources, 'whisper', 'ggml-silero-v6.2.0.bin'), 'vad\n');
  put(path.join(resources, 'whisper', 'LICENSE'), 'MIT\n');
```

  - и добавить тест по образцу соседних «нет node»:

```ts
it('без whisper-cli — отказ с понятной причиной', () => {
  const resources = makeApp('arm64');
  makeApp('x64');
  rmSync(path.join(resources, 'whisper', 'bin', 'whisper-cli'));
  const result = runScript();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('whisper-cli');
});
```

  Помощник запуска взять тот, что у соседних тестов файла.

- [ ] **Шаг 2. Запустить — падает.** `pnpm --filter @parley/desktop exec vitest run src/fetch-whisper.test.ts src/release-config.test.ts src/notice.test.ts src/verify-packaged-apps.test.ts` → FAIL.

- [ ] **Шаг 3. Реализовать скрипт.**

```js
#!/usr/bin/env node
// packages/desktop/scripts/fetch-whisper.mjs
// Движок голосового ввода для собранного окна (спека 2026-10-06-voice-input-design.md, 4.3): `whisper-cli` из
// whisper.cpp и модель VAD Silero. Для каждой архитектуры скачивает исходник на закреплённом теге, сверяет sha256,
// собирает cmake (arm64 — Metal со встроенной библиотекой шейдеров, x64 — CPU с Accelerate и AVX2; оба статические,
// без -march=native) и кладёт в `build/whisper/darwin-<arch>/`: `bin/whisper-cli`, `ggml-silero-v6.2.0.bin`,
// `LICENSE`. electron-builder (`extraResources`) кладёт каталог в `Contents/Resources/whisper`.
//
// Использование: `node scripts/fetch-whisper.mjs [arm64] [x64]` — без аргументов архитектура этой машины. Повторный
// запуск ничего не собирает, пока запись `build/whisper/darwin-<arch>.json` совпадает с версией и sha256 VAD.
// Нужен cmake: в релизе он есть на раннере macOS, локально — `brew install cmake`.

/* global fetch, AbortSignal */

import { execFile } from 'node:child_process';
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Buffer } from 'node:buffer';
import { machOArch, parseArchs, sha256 } from './fetch-node.mjs';

const run = promisify(execFile);

/** Закреплённая версия: последний релиз на 2026-10-06. Новая версия — осознанная правка трёх строк ниже. */
export const WHISPER_VERSION = '1.9.4';
export const WHISPER_SOURCE_SHA256 = '57e280cee375ab02425b806ad5146b99f6eb9357e3c2b31357c8a6af2e2e44ae';
export const WHISPER_SOURCE_URL = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_VERSION}.tar.gz`;

export const VAD_MODEL = {
  file: 'ggml-silero-v6.2.0.bin',
  bytes: 885_098,
  sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
};

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT_ROOT = path.join(desktopRoot, 'build', 'whisper');

export function cmakeArgs(arch, sourceDir, buildDir) {
  const common = [
    '-S', sourceDir, '-B', buildDir,
    '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_EXAMPLES=ON', '-DWHISPER_SDL2=OFF', '-DGGML_NATIVE=OFF', '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0',
  ];
  return arch === 'arm64'
    ? [...common, '-DCMAKE_OSX_ARCHITECTURES=arm64', '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON']
    : [...common, '-DCMAKE_OSX_ARCHITECTURES=x86_64', '-DGGML_METAL=OFF', '-DGGML_AVX=ON', '-DGGML_AVX2=ON', '-DGGML_FMA=ON', '-DGGML_F16C=ON'];
}

export function isUpToDate(stamp, expected) {
  return stamp !== null && stamp.version === expected.version && stamp.vadSha256 === expected.vadSha256;
}

async function download(url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt >= 3) throw error;
      console.warn(`fetch-whisper: ${String(error)} — retry ${attempt + 1} of 3`);
    }
  }
}

async function readStamp(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function buildArch(arch, outRoot) {
  const outDir = path.join(outRoot, `darwin-${arch}`);
  const stampFile = path.join(outRoot, `darwin-${arch}.json`);
  const expected = { version: WHISPER_VERSION, vadSha256: VAD_MODEL.sha256 };
  if (isUpToDate(await readStamp(stampFile), expected)) {
    console.log(`fetch-whisper: darwin-${arch} is up to date`);
    return;
  }
  const work = await mkdtemp(path.join(tmpdir(), 'fetch-whisper-'));
  try {
    const tarball = await download(WHISPER_SOURCE_URL);
    if (sha256(tarball) !== WHISPER_SOURCE_SHA256) throw new Error('whisper.cpp source sha256 mismatch');
    const tarPath = path.join(work, 'whisper.tar.gz');
    await writeFile(tarPath, tarball);
    await run('tar', ['-xzf', tarPath, '-C', work]);
    const sourceDir = path.join(work, `whisper.cpp-${WHISPER_VERSION}`);
    const buildDir = path.join(work, `build-${arch}`);
    await run('cmake', cmakeArgs(arch, sourceDir, buildDir), { maxBuffer: 64 * 1024 * 1024 });
    await run('cmake', ['--build', buildDir, '--config', 'Release', '--target', 'whisper-cli', '-j'], { maxBuffer: 256 * 1024 * 1024 });
    const built = path.join(buildDir, 'bin', 'whisper-cli');
    if (machOArch(await readFile(built)) !== arch) throw new Error(`whisper-cli is not a ${arch} binary`);

    const vad = await download(VAD_MODEL.url);
    if (vad.length !== VAD_MODEL.bytes || sha256(vad) !== VAD_MODEL.sha256) throw new Error('VAD model sha256 mismatch');

    await rm(outDir, { recursive: true, force: true });
    await mkdir(path.join(outDir, 'bin'), { recursive: true });
    await copyFile(built, path.join(outDir, 'bin', 'whisper-cli'));
    await chmod(path.join(outDir, 'bin', 'whisper-cli'), 0o755);
    await writeFile(path.join(outDir, VAD_MODEL.file), vad);
    await copyFile(path.join(sourceDir, 'LICENSE'), path.join(outDir, 'LICENSE'));
    await writeFile(stampFile, `${JSON.stringify(expected)}\n`);
    console.log(`fetch-whisper: darwin-${arch} ready (${outDir})`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2), outRoot = DEFAULT_OUT_ROOT) {
  for (const arch of parseArchs(args)) await buildArch(arch, outRoot);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`fetch-whisper: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
```

  Если `fetch-node.mjs` не экспортирует `parseArchs` или `machOArch` под этими именами, взять имена из его `export`. Строки выше — из его шапки на 2026-10-06.

- [ ] **Шаг 4. Конфигурация и проверки сборки.**
  - **`packages/desktop/package.json`**: в `scripts` добавить `"fetch-whisper": "node scripts/fetch-whisper.mjs",`.
  - **`.gitignore`**: рядом с `packages/desktop/build/node/` добавить строку `packages/desktop/build/whisper/`.
  - **`electron-builder.yml`**: после записи встроенного node в `extraResources`:

```yaml
  # Движок голосового ввода (спека 2026-10-06-voice-input-design.md, 4.3): `scripts/fetch-whisper.mjs` кладёт `whisper-cli`,
  # модель VAD Silero и LICENSE whisper.cpp в build/whisper/darwin-<arch>. Нет каталога — electron-builder предупреждает,
  # голосовой ввод в такой сборке скажет «Voice engine not found».
  - from: build/whisper/darwin-${arch}
    to: whisper
```

    и в секцию `mac:`:

```yaml
  # Текст системного запроса доступа к микрофону (голосовой ввод): без него macOS показала бы заглушку Electron.
  extendInfo:
    NSMicrophoneUsageDescription: Parley uses the microphone for voice dictation. Audio is transcribed on this Mac and never leaves it.
```

  - **`release.yml`**: после шага «Fetch the embedded Node»:

```yaml
      # Движок голосового ввода обеих архитектур: sha256 исходника whisper.cpp и модели VAD закреплены в скрипте.
      - name: Build the voice engine
        run: pnpm --filter @parley/desktop fetch-whisper arm64 x64
```

  - **`verify-packaged-apps.sh`**: в `check_app` после проверки `node/LICENSE`:

```bash
  # Движок голосового ввода своей архитектуры, модель VAD и LICENSE whisper.cpp (fetch-whisper).
  [ -x "$resources/whisper/bin/whisper-cli" ] ||
    fail "$app has no voice engine (Contents/Resources/whisper/bin/whisper-cli): fetch-whisper must run before electron-builder"
  [ "$(lipo -archs "$resources/whisper/bin/whisper-cli")" = "$lipo_arch" ] ||
    fail "$app: whisper-cli is not a $lipo_arch binary"
  [ -s "$resources/whisper/ggml-silero-v6.2.0.bin" ] || fail "$app has no VAD model (Contents/Resources/whisper/ggml-silero-v6.2.0.bin)"
  [ -s "$resources/whisper/LICENSE" ] || fail "$app has no Contents/Resources/whisper/LICENSE"
```

    и в `run_app` после строки про node-pty:

```bash
  "$@" "$resources/whisper/bin/whisper-cli" --help >/dev/null 2>&1 || fail "$out: whisper-cli does not start"
```

  - **`NOTICE`**: в конец добавить два раздела в формате файла:
    - `whisper.cpp` — источник `https://github.com/ggml-org/whisper.cpp`, тег v1.9.4, полный текст MIT из `LICENSE` архива с «Copyright (c) 2023-2026 The ggml authors»; пометка «едет как Contents/Resources/whisper/bin/whisper-cli»;
    - `Silero VAD` — источник `https://github.com/snakers4/silero-vad`, модель `ggml-silero-v6.2.0.bin` из `ggml-org/whisper-vad`, полный текст MIT с «Copyright (c) 2020-present Silero Team».

- [ ] **Шаг 5. Запустить — проходит.**
  - `pnpm --filter @parley/desktop exec vitest run src/fetch-whisper.test.ts src/release-config.test.ts src/notice.test.ts src/verify-packaged-apps.test.ts` → PASS.
  - Затем собрать вживую (нужен cmake из задачи 0): `pnpm --filter @parley/desktop fetch-whisper` → `build/whisper/darwin-arm64/bin/whisper-cli`. Повторный запуск пишет «is up to date».

- [ ] **Шаг 6. Закоммитить.**

```bash
git add packages/desktop/scripts/fetch-whisper.mjs packages/desktop/src/fetch-whisper.test.ts packages/desktop/package.json .gitignore packages/desktop/electron-builder.yml .github/workflows/release.yml scripts/release/verify-packaged-apps.sh NOTICE packages/desktop/src/release-config.test.ts packages/desktop/src/notice.test.ts packages/desktop/src/verify-packaged-apps.test.ts
git commit -m "build(desktop): whisper-cli и модель VAD в сборке, проверка упакованного приложения"
```

---

## Задача 13. E2E и проба на настоящем движке

**Файлы:**
- Создать: `packages/desktop/e2e/voice.spec.ts`, `packages/desktop/src/main/voice/voice-engine.live.test.ts`

**Интерфейсы:**
- Берёт: всё предыдущее; `PARLEY_VOICE=fake`, `PARLEY_VOICE_TEXT` (задача 6).

- [ ] **Шаг 1. Написать E2E.**

```ts
// packages/desktop/e2e/voice.spec.ts
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Голосовой ввод (спека 2026-10-06-voice-input-design.md, 8): микрофон — фейк Chromium (тон), службы main —
 * PARLEY_VOICE=fake. Путь целиком: тусклая кнопка → Settings → Voice → «скачать» модель → включить → запись в
 * поле комнаты → текст в поле и не отправлен; Esc отменяет; ⌘⇧M в поле — то же, что клик.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const VOICE_TEXT = 'hello from voice';
let project = '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

async function createSession(window: Page, workId: string, label: string): Promise<string> {
  const result = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
    projectPath: project,
    workId,
    provider: 'claude',
    label,
    task: '',
    parent: null,
  });
  return result.ref.sessionId;
}

async function sendFocusTarget(app: ElectronApplication, target: unknown): Promise<void> {
  await app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('app:focus-target', value);
  }, target);
}

test.describe('голосовой ввод', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('voice');
    project = await makeTempProject('voice');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('тусклая кнопка → Voice → модель → запись в поле комнаты; Esc отменяет; ⌘⇧M', async () => {
    test.setTimeout(120_000);
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom', PARLEY_VOICE: 'fake', PARLEY_VOICE_TEXT: VOICE_TEXT };
    const electronApp = await electron.launch({ args: [mainEntry, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));

    await expect(window.getByTestId('landing')).toBeVisible();
    await call(window, 'wake.pause', {});
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-voice', goal: '' });
    const lead = await createSession(window, workId, 'lead');
    const second = await createSession(window, workId, 'second');
    const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', { projectPath: project, workId, title: 'e2e-room', members: [lead, second], lead, quiet: true });
    await sendFocusTarget(electronApp, { kind: 'room', projectPath: project, workId, roomId });

    const editor = window.locator('[data-room-editor]');
    const mic = window.locator(`[data-testid="mic"][data-target^="room:"]`);
    await expect(mic).toHaveAttribute('data-state', 'setup');

    // 1. Тусклая кнопка ведёт в Settings → Voice; «скачать» Base и включить.
    await mic.getByRole('button').click();
    const base = window.locator('[data-voice-model="base"]');
    await base.getByRole('button', { name: 'Download' }).click();
    await expect(base.getByRole('button', { name: 'Delete' })).toBeVisible();
    await window.getByRole('switch', { name: 'Voice input' }).click();
    await window.keyboard.press('Escape');
    await expect(mic).toHaveAttribute('data-state', 'ready');

    // 2. Клик — запись, клик — текст в поле, письма нет.
    await mic.getByRole('button').click();
    await expect(mic).toHaveAttribute('data-state', 'recording');
    await window.waitForTimeout(500);
    await mic.getByRole('button').click();
    await expect(editor).toHaveText(VOICE_TEXT);
    await expect(window.locator('[data-room-feed] [data-room-message]')).toHaveCount(0);

    // 3. Esc во время записи — отмена, поле прежнее.
    await mic.getByRole('button').click();
    await expect(mic).toHaveAttribute('data-state', 'recording');
    await window.keyboard.press('Escape');
    await expect(mic).toHaveAttribute('data-state', 'ready');
    await expect(editor).toHaveText(VOICE_TEXT);

    // 4. ⌘⇧M в поле — запись и стоп; текст дописан через пробел.
    await editor.click();
    await window.keyboard.press('End');
    await window.keyboard.press('Meta+Shift+M');
    await expect(mic).toHaveAttribute('data-state', 'recording');
    await window.waitForTimeout(500);
    await window.keyboard.press('Meta+Shift+M');
    await expect(editor).toHaveText(`${VOICE_TEXT} ${VOICE_TEXT}`);
  });
});
```

  Селектор письма ленты комнаты (`[data-room-message]`) взять из `room-decision.spec.ts` или `RoomMessage.tsx`, если он называется иначе.

- [ ] **Шаг 2. Запустить E2E.**

  `pnpm --filter @parley/desktop build && pnpm --filter @parley/desktop exec playwright test e2e/voice.spec.ts` → PASS.

  Если фейковое устройство Chromium не пускает `getUserMedia`, сначала проверить, что аргументы `--use-fake-*` дошли до Electron: `app.commandLine.hasSwitch` в `electronApp.evaluate`. Только потом менять тест.

- [ ] **Шаг 3. Написать пробу на настоящем движке.**

```ts
// packages/desktop/src/main/voice/voice-engine.live.test.ts
/**
 * Проба на настоящем whisper-cli (спека 8): пропускается, пока нет движка (`fetch-whisper` или brew) и модели base
 * в ~/.parley/desktop/voice/models. Фразы делает `say`, перевод в 16 кГц — `afconvert`. Запускать локально перед
 * релизом: `pnpm --filter @parley/desktop exec vitest run src/main/voice/voice-engine.live.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isFileSync, resolveEngine } from './engine.js';
import { voiceModelsDir } from './models.js';
import { createTranscriber, runEngine } from './transcribe.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const engine = resolveEngine({
  isPackaged: false,
  resourcesPath: '',
  devDir: path.resolve(dirname, '../../../build/whisper', `darwin-${process.arch}`),
  pathEnv: process.env.PATH,
  isFile: isFileSync,
});
const model = path.join(voiceModelsDir(), 'ggml-base.bin');
const ready = process.platform === 'darwin' && engine !== null && existsSync(model);

function phrase(voice: string, text: string): ArrayBuffer {
  const dir = mkdtempSync(path.join(tmpdir(), 'parley-live-'));
  try {
    execFileSync('say', ['-v', voice, '-o', path.join(dir, 'p.aiff'), text]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', path.join(dir, 'p.aiff'), path.join(dir, 'p.wav')]);
    const wav = readFileSync(path.join(dir, 'p.wav'));
    const data = wav.indexOf('data');
    return wav.subarray(data + 8).buffer.slice(wav.byteOffset + data + 8) as ArrayBuffer;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!ready)('настоящий whisper-cli (base)', () => {
  const transcribe = createTranscriber({
    engine: () => engine,
    modelPath: () => model,
    exists: async (file) => existsSync(file),
    run: runEngine,
    tmpDir: tmpdir(),
    log: (message) => console.warn(message),
  });

  it('английская фраза — ключевые слова на месте', async () => {
    const started = Date.now();
    const result = await transcribe({ pcm: phrase('Samantha', 'Refactor the authentication middleware'), language: 'en', model: 'base' });
    console.log(`base en: ${Date.now() - started} ms`, result);
    expect('text' in result && /middleware/i.test(result.text)).toBe(true);
  }, 120_000);

  it('тишина — no_speech', async () => {
    await expect(transcribe({ pcm: new ArrayBuffer(16_000 * 2 * 3), language: 'auto', model: 'base' })).resolves.toEqual({ error: 'no_speech' });
  }, 120_000);
});
```

  В `afconvert` WAV после `data` может идти чанк `FLLR`: `indexOf('data')` находит именно чанк данных, а не `FLLR`, поэтому смещение верное.

- [ ] **Шаг 4. Запустить пробу.**

  `pnpm --filter @parley/desktop exec vitest run src/main/voice/voice-engine.live.test.ts`:
  - без движка — SKIPPED;
  - с `build/whisper` и скачанной base — PASS, в выводе время в мс.

  В CI проба пропускается сама.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add packages/desktop/e2e/voice.spec.ts packages/desktop/src/main/voice/voice-engine.live.test.ts
git commit -m "test(desktop): E2E голосового ввода и проба на настоящем whisper-cli"
```

---

## Задача 14. README, TODOS и живая проверка

**Файлы:**
- Изменить: `README.md` (раздел о голосовом вводе), `TODOS.md` (пункт 17)
- Возможно: `packages/desktop/src/renderer/voice/level.ts` (`SILENCE_PEAK` по живой проверке)

- [ ] **Шаг 1. README.** Короткий раздел «Voice input» по-английски, рядом с разделом о настройках:
  - включение — Settings → Voice, выбор и скачивание модели, переключатель;
  - где кнопка и ⌘⇧M; текст не отправляется сам; Esc отменяет;
  - модели лежат в `~/.parley/desktop/voice/models`, их можно удалить в настройках или руками;
  - звук не покидает Mac;
  - без подписи Apple разрешение на микрофон может сброситься после обновления — macOS спросит снова.

- [ ] **Шаг 2. TODOS.md.** Пункт 17 заменить короткой записью: «сделано локальным Whisper — спека `docs/specs/2026-10-06-voice-input-design.md`, план `docs/specs/2026-10-06-voice-input-plan.md`». Остаются открытыми: потоковое распознавание и `whisper-server`, если задержка не уложится; переназначение клавиши; Linux и Windows.

- [ ] **Шаг 3. Полный прогон.**
  - `pnpm build && pnpm -r --no-bail test`;
  - `pnpm lint`;
  - `pnpm --filter @parley/desktop typecheck`;
  - `pnpm --filter @parley/desktop exec playwright test e2e/voice.spec.ts`.

  Флейки сравнивать с исходным прогоном из шапки плана.

- [ ] **Шаг 4. Живая проверка с пользователем.**
  1. Собрать: `pnpm --filter @parley/desktop fetch-whisper && pnpm --filter @parley/desktop dist --dir`.
  2. Запустить `dist/mac-arm64/Parley.app`.
  3. Пользователь:
     - скачивает turbo;
     - включает голос;
     - первая запись — системный запрос с текстом Parley;
     - диктует по-русски во все четыре места: комната, чат, New workspace, терминал (в Codex — ⌘⇧M).
  4. Окно 800×500 с длинным путём проекта и названием комнаты: вкладка Voice (шесть вкладок в 32rem) и кнопка в тулбаре не вылезают за края.
  5. Замер: 10–15-секундная русская фраза на turbo, время от стопа до текста — критерий 4 спеки, не больше 3 с.
  6. Порог тишины: пустая запись и тихая речь. Если тихую речь режет «No speech detected», снизить `SILENCE_PEAK` и закоммитить отдельно.
  7. x64-сборку (`dist/mac/Parley.app`) запустить под Rosetta, распознать фразу на small.

- [ ] **Шаг 5. Закоммитить.**

```bash
git add README.md TODOS.md
git commit -m "docs: голосовой ввод в README, пункт 17 TODOS закрыт"
```
