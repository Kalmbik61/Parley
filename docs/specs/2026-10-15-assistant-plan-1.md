# Помощник на острове — план этапа 1 (мозг и текст)

> **Для исполнителей:** обязательный навык — superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans; шаги — галочки `- [ ]`. Порядок работы пользователя: куски по 1–2 задачи, исполнители — Sonnet; исполнители тесты **пишут, но не запускают** (ни vitest, ни tsc, ни eslint); прогон — после группы, один процесс, только после проверки загрузки машины (`uptime`, `memory_pressure -Q`; load average за минуту ниже ~8 при 12 ядрах); дифф каждого куска читает контролёр. Коммит — после зелёного прогона группы. Субагентам прямо запрещены мутации вне задачи и переборы вариантов.

**Цель:** помощник отвечает на вопросы о работах, комнатах и сессиях и передаёт сообщения человека в комнату или агенту после подтверждения — вызов глобальным хоткеем, кликом или из палитры, ввод голосом (Whisper) или печатью, ответ текстом на острове; вместо роя — светящееся пятно.

**Архитектура:** ход помощника — отдельный процесс CLI выбранного провайдера без терминала (подход 2 спеки), его запускает новый `assistant-service` хоста; поток событий CLI разбирают чистые функции core. Инструменты помощника — режим `assistant` того же `parley-mcp`, который ходит в хост маршрутом `/assistant/*` hook-сервера с токеном разговора. Окно: настройки в `ui.json`, глобальный хоткей и клавиатура острова — в main, вид помощника — в renderer острова; письмо помощника несёт `via: 'assistant'`.

**Стек:** TypeScript (strict, `exactOptionalPropertyTypes`, импорты с `.js`), Node 20, `@modelcontextprotocol/sdk`, zod 4, Electron 44 + electron-vite, React 18, zustand, Tailwind v4, vitest (jsdom для renderer), Playwright (`_electron`) для E2E.

**Спека:** `docs/specs/2026-10-14-assistant-design.md` (разделы 6–8, 12–13 и приложение A) — читать вместе с планом. Эталон вида — `docs/specs/assets/2026-10-14-assistant/island-mockup.html`. Фикстуры потоков спайка — `.superpowers/spikes/2026-10-14-assistant/fixtures/` (каталог исключён из git; в задаче 2 они копируются в репозиторий с вычищенными путями).

## Общие ограничения

- В коде помощник — `assistant`; видимое имя — одна константа `ASSISTANT_NAME = 'Jarvis'` (`desktop/src/shared/assistant-name.ts`).
- Тексты окна и острова — только по-английски, в `desktop/src/shared/strings.ts` (страж — `src/english-ui.test.ts`). Комментарии, JSDoc, имена тестов — по-русски, плотно, как соседний код. Тексты для модели (промпт, описания инструментов, ответы инструментов) — по-английски.
- Рамка: прямых API провайдеров нет; в новом коде нет строк `secrets.json`, `ANTHROPIC_AUTH_TOKEN`, `--dangerously-*` (страж — `core/test/frame-scan.ts`); ключ GLM — только через `readSecret` и `providerLaunchEnv`.
- Пишем только в `<parleyHome()>/assistant/` (рабочая папка CLI, `mcp.json`, файлы промпта, `sent.jsonl`), права 0600 на файлы, 0700 на каталог.
- Помощник выключен по умолчанию (`ui.assistant.enabled: false`); хоткей по умолчанию `Alt+Space`; язык по умолчанию — язык системы (`ru*` → `ru`, иначе `en`).
- Модели по умолчанию: Claude — `haiku`, GLM — `glm-5.3-flash[1m]`, Codex — `gpt-6-luna`; порядок выбора провайдера, когда он не задан: `claude`, `glm`, `codex`.
- Минимальные версии CLI для помощника: `claude` 2.1.300, `codex` 0.162.0 (приложение A спеки). Версия неизвестна — не отказываем.
- Ход не дольше 60 с; разговор сбрасывается через 15 мин без активности.
- Метка эмоции: `[[calm]]`, `[[joy]]`, `[[sad]]`, `[[surprise]]`, `[[anger]]`; `error` ставит только хост.
- Слова подтверждения сверяет окно, а не модель; принимаются оба языка сразу (уточнение спеки 7.3, внесено этим планом).
- `exactOptionalPropertyTypes`: необязательное поле — только спредом `...(x === undefined ? {} : { x })`.
- Сообщения коммитов (в шагах «Коммит» даны первые строки) заканчиваются строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Новый вопрос (или хоткей) во время хода.** Человек перебивает — старый ход не должен дописать свой ответ поверх нового. Покрытие: задача 10, тест «старый ход после перебивания молчит».
2. **Карточку подтвердили, а сессия уже остановилась** (или комната ушла в архив). Ничего не отправляется, на карточке — причина, карточка остаётся. Покрытие: задача 10, тест `decide` с `send`, который бросает `session is not running`.
3. **Модель назвала цель именем, а не id** («S03», «Auth»), или имя неоднозначно. Однозначное имя находится, неоднозначное — ошибка со списком кандидатов, письмо не уходит не туда. Покрытие: задача 7, тесты `resolveTarget`.
4. **CLI нет, версия старая, у GLM нет ключа.** Помощник — `offline` с причиной, ход не запускается, остальной Parley работает. Покрытие: задача 10, тест `ask` с `ready`, вернувшим причину, и с `binary`, который бросает.
5. **Остров не отдаёт клавиатуру после закрытия режима.** Если панель останется фокусируемой, печать в других приложениях уйдёт в никуда. Покрытие: задача 11 (`setKeyboard(false)` делает `setFocusable(false)`, `hide`, `showInactive`), задача 14 (Esc и сворачивание зовут `api.keyboard(false)`), живая проверка.

---

### Задача 0: Ветка, зависимости, база

**Файлы:** нет.

- [ ] **Шаг 1: Ветка реализации.** В worktree `.claude/worktrees/jarvis` (ветка `docs/jarvis-spec`, в ней спека и этот план):
```bash
git switch -c feat/assistant
git fetch origin && git merge --ff-only origin/master || git merge origin/master
```
Expected: ветка `feat/assistant`, master v0.12.0 или новее внутри.

- [ ] **Шаг 2: Загрузка и зависимости.** `uptime; memory_pressure -Q | tail -1` — load average за минуту ниже ~8. Затем:
```bash
nice -n 10 pnpm install --frozen-lockfile
```
Expected: `Done`.

- [ ] **Шаг 3: База** (только при низкой загрузке):
```bash
nice -n 10 pnpm build && nice -n 10 pnpm typecheck
```
Expected: exit 0. Дальше красное — от наших правок.

---

## Группа A — core

### Задача 1: Чистые функции текста помощника

**Файлы:**
- Create: `packages/core/src/assistant/text.ts`
- Test: `packages/core/src/assistant/text.test.ts`
- Modify: `packages/core/src/index.ts` (реэкспорт), `packages/core/package.json` (`exports` — подпуть `./assistant`)

**Interfaces:**
- Produces: `type AssistantMood`, `type AssistantLanguage`, `MODEL_MOODS`, `interface MoodSplit`, `splitMood(buffer: string, final: boolean): MoodSplit | null`, `type ConfirmAnswer`, `normalizePhrase(phrase: string): string`, `matchConfirm(phrase: string): ConfirmAnswer | null`, `normalizeSentText(text: string): string`. Подпуть `@parley/core/assistant` — для окна (без node-зависимостей).

- [ ] **Шаг 1: Тест**

```ts
import { describe, expect, it } from 'vitest';
import { matchConfirm, normalizeSentText, splitMood } from './text.js';

describe('splitMood — метка эмоции в начале ответа', () => {
  it('срезает метку отдельной строкой', () => {
    expect(splitMood('[[joy]]\nКомната закончила.', false)).toEqual({ mood: 'joy', text: 'Комната закончила.' });
  });
  it('срезает метку в одной строке с ответом (GLM)', () => {
    expect(splitMood('[[calm]] Сейчас работают двое.', false)).toEqual({ mood: 'calm', text: 'Сейчас работают двое.' });
  });
  it('ждёт, пока метка не дописана', () => {
    expect(splitMood('', false)).toBeNull();
    expect(splitMood('[', false)).toBeNull();
    expect(splitMood('[[sur', false)).toBeNull();
  });
  it('без метки — calm и весь текст', () => {
    expect(splitMood('Сейчас тихо.', false)).toEqual({ mood: 'calm', text: 'Сейчас тихо.' });
    expect(splitMood('[1] пункт', false)).toEqual({ mood: 'calm', text: '[1] пункт' });
  });
  it('незнакомая метка и error от модели — calm', () => {
    expect(splitMood('[[happy]] Да.', false)).toEqual({ mood: 'calm', text: 'Да.' });
    expect(splitMood('[[error]] Нет.', false)).toEqual({ mood: 'calm', text: 'Нет.' });
  });
  it('незакрытая длинная метка — calm и текст как есть', () => {
    const text = '[[это не метка, а длинный текст';
    expect(splitMood(text, false)).toEqual({ mood: 'calm', text });
  });
  it('в конце хода решает и по неполному буферу', () => {
    expect(splitMood('[[jo', true)).toEqual({ mood: 'calm', text: '[[jo' });
    expect(splitMood('', true)).toEqual({ mood: 'calm', text: '' });
  });
});

describe('matchConfirm — слова подтверждения карточки', () => {
  it('«да» и «yes» — отправить', () => {
    for (const phrase of ['Да', 'да, отправляй!', 'Отправь.', 'yes', 'Send it', 'go ahead']) expect(matchConfirm(phrase)).toBe('send');
  });
  it('«нет» и «cancel» — отменить', () => {
    for (const phrase of ['Нет', 'не надо', 'Отмена', 'no', 'Cancel', "don't"]) expect(matchConfirm(phrase)).toBe('cancel');
  });
  it('длинная фраза — не подтверждение, а новый вопрос', () => {
    expect(matchConfirm('да, но поменяй текст на другой')).toBeNull();
    expect(matchConfirm('поменяй на «завтра»')).toBeNull();
    expect(matchConfirm('')).toBeNull();
  });
});

describe('normalizeSentText', () => {
  it('схлопывает пробелы и переводы строк', () => {
    expect(normalizeSentText('  Тесты\n\nна Safari   пропусти ')).toBe('Тесты на Safari пропусти');
  });
});
```

- [ ] **Шаг 2: Реализация**

```ts
/**
 * Чистые функции помощника (спека 2026-10-14, разделы 6.4 и 7.3): метка эмоции в начале ответа, слова
 * подтверждения карточки, нормализация текста для сверки отправленного. Без node-зависимостей — их берёт и окно
 * через подпуть `@parley/core/assistant`.
 */

export type AssistantMood = 'calm' | 'joy' | 'sad' | 'surprise' | 'anger' | 'error';
export type AssistantLanguage = 'en' | 'ru';

/** Эмоции, которые ставит модель; `error` ставит только хост при сбое хода. */
export const MODEL_MOODS: readonly AssistantMood[] = ['calm', 'joy', 'sad', 'surprise', 'anger'];

/** Дольше метки не ждём: `[[surprise]]` — 12 знаков, остальное — запас на пробелы внутри. */
const MOOD_TAG_LIMIT = 24;

export interface MoodSplit {
  mood: AssistantMood;
  /** Ответ без метки и без пробелов и перевода строки сразу после неё. */
  text: string;
}

/**
 * Срезает метку `[[mood]]` с начала первого текста хода. `null` — по буферу ещё нельзя решить (метка не дописана);
 * `final` — ход кончился, решать по тому, что есть. Нет метки или она незнакома — `calm` и текст как есть.
 */
export function splitMood(buffer: string, final: boolean): MoodSplit | null {
  const head = buffer.trimStart();
  if (head === '' || head === '[') return final ? { mood: 'calm', text: head } : null;
  if (!head.startsWith('[[')) return { mood: 'calm', text: buffer };
  const close = head.indexOf(']]');
  if (close === -1) return !final && head.length < MOOD_TAG_LIMIT ? null : { mood: 'calm', text: buffer };
  const tag = head.slice(2, close).trim().toLowerCase();
  const mood = (MODEL_MOODS as readonly string[]).includes(tag) ? (tag as AssistantMood) : 'calm';
  return { mood, text: head.slice(close + 2).trimStart() };
}

export type ConfirmAnswer = 'send' | 'cancel';

const SEND_PHRASES = new Set([
  'да', 'ага', 'давай', 'отправь', 'отправляй', 'да отправь', 'да отправляй', 'да давай',
  'yes', 'yep', 'yeah', 'send', 'send it', 'go ahead', 'yes send', 'yes send it',
]);
const CANCEL_PHRASES = new Set([
  'нет', 'не надо', 'отмена', 'отмени', 'не отправляй', 'нет не надо',
  'no', 'nope', 'cancel', 'dont', 'dont send', 'no cancel',
]);

/** Нижний регистр, `ё` → `е`, без знаков препинания и лишних пробелов. */
export function normalizePhrase(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Короткий ответ на карточку подтверждения (спека 7.3): не длиннее трёх слов и из списка — `send` или `cancel`;
 * иначе `null`, и фраза уходит модели обычным вопросом. Оба языка принимаются всегда.
 */
export function matchConfirm(phrase: string): ConfirmAnswer | null {
  const normalized = normalizePhrase(phrase);
  if (normalized === '' || normalized.split(' ').length > 3) return null;
  if (SEND_PHRASES.has(normalized)) return 'send';
  if (CANCEL_PHRASES.has(normalized)) return 'cancel';
  return null;
}

/** Текст для сверки «это сообщение отправил помощник» (спека 7.4): пробелы схлопнуты, края обрезаны. */
export function normalizeSentText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
```

- [ ] **Шаг 3: Реэкспорт и подпуть.** В `packages/core/src/index.ts` — отдельный блок рядом с другими:
```ts
export { MODEL_MOODS, matchConfirm, normalizePhrase, normalizeSentText, splitMood } from './assistant/text.js';
export type { AssistantLanguage, AssistantMood, ConfirmAnswer, MoodSplit } from './assistant/text.js';
```
В `packages/core/package.json` в `exports` добавить `"./assistant"` **точно по образцу** существующей записи `"./feed-turn"` (те же ключи `types`/`import`/`default`), указывая на `dist/assistant/text.(d.)ts|js`.

---

### Задача 2: Разбор потоков CLI

**Файлы:**
- Create: `packages/core/src/assistant/stream.ts`
- Create: `packages/core/test/fixtures/assistant/*.jsonl` (копии фикстур спайка с вычищенными путями)
- Test: `packages/core/src/assistant/stream.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `ASSISTANT_MCP_NAME = 'parley-assistant'`, `type AssistantErrorKind = 'limit' | 'resume' | 'other'`, `type AssistantStreamEvent`, `classifyAssistantError(text: string): AssistantErrorKind`, `parseClaudeLine(line: string): AssistantStreamEvent[]`, `parseCodexLine(line: string): AssistantStreamEvent[]`.

- [ ] **Шаг 1: Фикстуры.** Скопировать из стенда спайка с заменой путей пользователя:
```bash
SRC=.superpowers/spikes/2026-10-14-assistant/fixtures
DST=packages/core/test/fixtures/assistant
mkdir -p "$DST"
for f in claude-tool claude-tool-resume claude-propose-message claude-err-resume claude-err-model glm-tool glm-tool-preface-before-tool codex-tool codex-tool-resume codex-err-model; do
  sed -E 's#/Users/[^/"]+#/Users/user#g; s#/private/tmp/[^"]+#/tmp/x#g' "$SRC/$f.jsonl" > "$DST/$f.jsonl"
done
grep -l "kalmbik" "$DST"/* ; echo "exit=$?"
```
Expected: последняя строка `exit=1` (имени пользователя в фикстурах нет). Если в каком-то файле есть значение ключа или токена — остановиться и сообщить контролёру.

- [ ] **Шаг 2: Тест**

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyAssistantError, parseClaudeLine, parseCodexLine, type AssistantStreamEvent } from './stream.js';

const FIXTURES = path.resolve(import.meta.dirname, '../../test/fixtures/assistant');
const events = (file: string, parse: (line: string) => AssistantStreamEvent[]): AssistantStreamEvent[] =>
  readFileSync(path.join(FIXTURES, file), 'utf8').split('\n').flatMap(parse);
const text = (list: AssistantStreamEvent[]): string =>
  list.flatMap((event) => (event.type === 'text' ? [event.delta] : [])).join('');

describe('parseClaudeLine', () => {
  it('ход с инструментом: id сессии, инструмент без префикса, текст, конец', () => {
    const list = events('claude-tool.jsonl', parseClaudeLine);
    expect(list[0]).toMatchObject({ type: 'session' });
    expect(list.some((event) => event.type === 'tool' && event.name === 'parley_overview')).toBe(true);
    expect(text(list)).toMatch(/^\s*\[\[calm\]\]/);
    expect(list.at(-1)).toEqual({ type: 'done' });
  });
  it('resume: тот же формат', () => {
    expect(events('claude-tool-resume.jsonl', parseClaudeLine).at(-1)).toEqual({ type: 'done' });
  });
  it('propose_message: аргументы инструмента доходят', () => {
    const tool = events('claude-propose-message.jsonl', parseClaudeLine).find(
      (event): event is Extract<AssistantStreamEvent, { type: 'tool' }> => event.type === 'tool' && event.name === 'propose_message',
    );
    expect(tool?.input).toMatchObject({ text: expect.any(String) });
  });
  it('неверный --resume — ошибка resume', () => {
    expect(events('claude-err-resume.jsonl', parseClaudeLine).at(-1)).toMatchObject({ type: 'error', kind: 'resume' });
  });
  it('неверная модель — ошибка, хотя subtype success', () => {
    expect(events('claude-err-model.jsonl', parseClaudeLine).at(-1)).toMatchObject({ type: 'error', kind: 'other' });
  });
  it('GLM: метка до инструмента отдельным блоком', () => {
    const list = events('glm-tool-preface-before-tool.jsonl', parseClaudeLine);
    const tool = list.findIndex((event) => event.type === 'tool');
    expect(tool).toBeGreaterThan(0);
    expect(text(list.slice(0, tool))).toContain('[[');
    expect(list.at(-1)).toEqual({ type: 'done' });
  });
  it('не JSON и чужие события — пусто', () => {
    expect(parseClaudeLine('Reading additional input from stdin...')).toEqual([]);
    expect(parseClaudeLine('{"type":"rate_limit_event"}')).toEqual([]);
  });
  it('429 — лимит', () => {
    expect(parseClaudeLine('{"type":"result","is_error":true,"api_error_status":429,"result":"x"}')).toEqual([
      { type: 'error', kind: 'limit', message: 'x' },
    ]);
  });
});

describe('parseCodexLine', () => {
  it('ход с инструментом: thread_id, инструмент, сообщение целиком, конец', () => {
    const list = events('codex-tool.jsonl', parseCodexLine);
    expect(list[0]).toMatchObject({ type: 'session' });
    expect(list.some((event) => event.type === 'tool' && event.name === 'parley_overview')).toBe(true);
    expect(text(list)).toContain('[[');
    expect(list.at(-1)).toEqual({ type: 'done' });
  });
  it('resume — тот же thread', () => {
    const first = events('codex-tool.jsonl', parseCodexLine)[0];
    expect(first?.type).toBe('session');
    expect(events('codex-tool-resume.jsonl', parseCodexLine).at(-1)).toEqual({ type: 'done' });
  });
  it('неверная модель — turn.failed', () => {
    expect(events('codex-err-model.jsonl', parseCodexLine).at(-1)).toMatchObject({ type: 'error' });
  });
});

describe('classifyAssistantError', () => {
  it('различает resume, лимит и прочее', () => {
    expect(classifyAssistantError('Error: thread/resume: no rollout found for thread id x')).toBe('resume');
    expect(classifyAssistantError('No conversation found with session ID: x')).toBe('resume');
    expect(classifyAssistantError("You've hit your usage limit")).toBe('limit');
    expect(classifyAssistantError('Something else')).toBe('other');
  });
});
```

- [ ] **Шаг 3: Реализация**

```ts
/**
 * Разбор потоков CLI помощника (спека 2026-10-14, 6.3 и приложение A.3): строки `stream-json` Claude и GLM и
 * `exec --json` Codex — в общие события хода. Без состояния: строка → события.
 */

/** Имя MCP-сервера помощника: инструменты приходят от Claude как `mcp__parley-assistant__<имя>`. */
export const ASSISTANT_MCP_NAME = 'parley-assistant';
const TOOL_PREFIX = `mcp__${ASSISTANT_MCP_NAME}__`;

export type AssistantErrorKind = 'limit' | 'resume' | 'other';

export type AssistantStreamEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  | { type: 'done' }
  | { type: 'error'; kind: AssistantErrorKind; message: string };

export function classifyAssistantError(text: string): AssistantErrorKind {
  if (/no conversation found|no rollout found/i.test(text)) return 'resume';
  if (/usage limit|rate limit|limit reached|hit your limit|\b429\b/i.test(text)) return 'limit';
  return 'other';
}

type Json = Record<string, unknown>;

const record = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function parse(line: string): Json | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return record(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** Аргументы инструмента: объект, а у некоторых версий — JSON-строка. */
function args(value: unknown): Json {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value)) ?? {};
    } catch {
      return {};
    }
  }
  return record(value) ?? {};
}

export function parseClaudeLine(line: string): AssistantStreamEvent[] {
  const event = parse(line);
  if (event === null) return [];
  const type = event['type'];
  if (type === 'system' && event['subtype'] === 'init') {
    const id = str(event['session_id']);
    return id === null ? [] : [{ type: 'session', id }];
  }
  if (type === 'stream_event') {
    const inner = record(event['event']);
    const delta = record(inner?.['delta']);
    if (inner?.['type'] !== 'content_block_delta' || delta?.['type'] !== 'text_delta') return [];
    const text = str(delta['text']);
    return text === null || text === '' ? [] : [{ type: 'text', delta: text }];
  }
  if (type === 'assistant') {
    // Текст берём только из дельт (`--include-partial-messages`), отсюда — вызовы инструментов с полными аргументами.
    const raw = record(event['message'])?.['content'];
    const content = Array.isArray(raw) ? raw : [];
    return content.flatMap((block): AssistantStreamEvent[] => {
      const item = record(block);
      if (item?.['type'] !== 'tool_use') return [];
      const name = str(item['name']) ?? '';
      return [{ type: 'tool', name: name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name, input: args(item['input']) }];
    });
  }
  if (type === 'result') {
    // Неверная модель приходит с `subtype: "success"`, но `is_error: true` — смотреть на `is_error`.
    if (event['is_error'] !== true) return [{ type: 'done' }];
    const rawErrors = event['errors'];
    const errors = Array.isArray(rawErrors) ? rawErrors.filter((item): item is string => typeof item === 'string') : [];
    const message = [str(event['result']), ...errors].filter((part): part is string => part !== null && part !== '').join(' ');
    const text = message === '' ? 'the CLI reported an error' : message;
    return [{ type: 'error', kind: event['api_error_status'] === 429 ? 'limit' : classifyAssistantError(text), message: text }];
  }
  return [];
}

export function parseCodexLine(line: string): AssistantStreamEvent[] {
  const event = parse(line);
  if (event === null) return [];
  const type = event['type'];
  if (type === 'thread.started') {
    const id = str(event['thread_id']);
    return id === null ? [] : [{ type: 'session', id }];
  }
  const item = record(event['item']);
  if (type === 'item.started' && item?.['type'] === 'mcp_tool_call') {
    return [{ type: 'tool', name: str(item['tool']) ?? '', input: args(item['arguments']) }];
  }
  if (type === 'item.completed' && item?.['type'] === 'agent_message') {
    const text = str(item['text']);
    return text === null || text === '' ? [] : [{ type: 'text', delta: text }];
  }
  if (type === 'turn.completed') return [{ type: 'done' }];
  if (type === 'turn.failed') {
    const message = str(record(event['error'])?.['message']) ?? 'the CLI reported an error';
    return [{ type: 'error', kind: classifyAssistantError(message), message }];
  }
  return [];
}
```

- [ ] **Шаг 4: Реэкспорт** в `packages/core/src/index.ts`:
```ts
export { ASSISTANT_MCP_NAME, classifyAssistantError, parseClaudeLine, parseCodexLine } from './assistant/stream.js';
export type { AssistantErrorKind, AssistantStreamEvent } from './assistant/stream.js';
```

---

### Задача 3: Запуск помощника — шаблоны провайдеров, конфиг MCP, промпт

**Файлы:**
- Modify: `packages/core/src/providers.ts` (`RunnerConfig`, `ProviderOverride`, `checkShape`, `applyOverride`, записи `claude`, `glm`, `codex`; новая `assistantCommand`)
- Create: `packages/core/src/assistant/launch.ts`
- Test: `packages/core/src/assistant/launch.test.ts`; дописать в `packages/core/src/providers.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `ASSISTANT_MCP_NAME` (задача 2), `AssistantLanguage` (задача 1), `MCP_SERVER_ENTRY` (`work/mcp-config.ts`), `substituteArgs`, `RunnerSubstitutions` (`providers.ts`).
- Produces: `RunnerConfig.assistantArgs?`, `RunnerConfig.assistantResumeArgs?`; `assistantCommand(entry: ProviderEntry, subs: RunnerSubstitutions, resume: boolean): { command: string; args: string[] } | null`; `ASSISTANT_DEFAULT_MODELS`, `ASSISTANT_PROVIDER_ORDER`, `ASSISTANT_MIN_VERSIONS`, `versionAtLeast(found: string, min: string): boolean`, `interface AssistantMcpParams`, `assistantMcpJson(params): string`, `assistantCodexMcp(params): string`, `codexInstructionsFile(file: string): string`, `assistantPrompt(language: AssistantLanguage): string`.

- [ ] **Шаг 1: Тесты.** В `providers.test.ts` (рядом с тестами `printCommand`, ~695):

```ts
describe('assistantCommand — ход помощника (спека 2026-10-14, 6.3)', () => {
  const subs = { prompt: 'кто работает?', model: 'haiku', mcpConfig: '/h/assistant/mcp.json', systemPrompt: 'SYS', developerInstructions: 'model_instructions_file="/h/p.md"' };
  it('claude: промпт сразу за -p, изоляция и только MCP помощника', () => {
    const command = assistantCommand(PROVIDERS.claude, subs, false);
    expect(command?.args.slice(0, 2)).toEqual(['-p', 'кто работает?']);
    expect(command?.args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--allowedTools', 'mcp__parley-assistant__*', '--setting-sources', '--disable-slash-commands']));
    expect(command?.args[command.args.indexOf('--tools') + 1]).toBe('');
    expect(command?.args).not.toContain('--resume');
  });
  it('claude со второго хода — --resume с id', () => {
    expect(assistantCommand(PROVIDERS.claude, { ...subs, providerSessionId: 'sid-1' }, true)?.args.slice(-2)).toEqual(['--resume', 'sid-1']);
  });
  it('glm — тот же набор, что у claude', () => {
    expect(assistantCommand(PROVIDERS.glm, subs, false)?.args).toEqual(assistantCommand(PROVIDERS.claude, subs, false)?.args);
  });
  it('codex: exec, песочница, конфиг MCP и промпт в конце; resume — thread и промпт в конце', () => {
    const codex = { ...subs, mcpConfig: 'mcp_servers.parley-assistant={}' };
    const first = assistantCommand(PROVIDERS.codex, codex, false);
    expect(first?.args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(first?.args).toEqual(expect.arrayContaining(['--sandbox', 'read-only', '--ignore-user-config', 'mcp_servers.parley-assistant={}']));
    expect(first?.args.at(-1)).toBe('кто работает?');
    const next = assistantCommand(PROVIDERS.codex, { ...codex, providerSessionId: 't-1' }, true);
    expect(next?.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(next?.args.slice(-2)).toEqual(['t-1', 'кто работает?']);
    expect(next?.args).not.toContain('--sandbox');
  });
  it('без модели флаг --model выпадает', () => {
    const { model: _model, ...rest } = subs;
    expect(assistantCommand(PROVIDERS.claude, rest, false)?.args).not.toContain('--model');
  });
  it('провайдер без шаблона — null', () => {
    const { assistantArgs: _a, assistantResumeArgs: _r, ...runner } = PROVIDERS.claude.runner;
    expect(assistantCommand({ ...PROVIDERS.claude, runner }, subs, false)).toBeNull();
  });
});
```
И рядом с тестом override `printArgs` (~880): `assistantArgs` из `providers.json` заменяет встроенный, а не-массив строк даёт `unexpected entry shape` — по образцу соседних тестов этого файла (тот же способ записи `providers.json` во временный дом).

`packages/core/src/assistant/launch.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { assistantCodexMcp, assistantMcpJson, assistantPrompt, codexInstructionsFile, versionAtLeast } from './launch.js';

const params = { url: 'http://127.0.0.1:5000/assistant', token: 'tok"en', command: '/usr/bin/node', args: ['/app/mcp/server.js'] };

describe('конфиг MCP помощника', () => {
  it('claude: один сервер parley-assistant с адресом и токеном в env', () => {
    const config = JSON.parse(assistantMcpJson(params)) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    expect(Object.keys(config.mcpServers)).toEqual(['parley-assistant']);
    expect(config.mcpServers['parley-assistant']).toMatchObject({ command: '/usr/bin/node', args: ['/app/mcp/server.js'], env: { PARLEY_ASSISTANT_URL: params.url, PARLEY_ASSISTANT_TOKEN: 'tok"en' } });
  });
  it('codex: строка -c с одобрением инструментов и экранированными значениями', () => {
    const value = assistantCodexMcp(params);
    expect(value.startsWith('mcp_servers.parley-assistant={')).toBe(true);
    expect(value).toContain('default_tools_approval_mode="approve"');
    expect(value).toContain('PARLEY_ASSISTANT_TOKEN="tok\\"en"');
  });
  it('codex: файл инструкций', () => {
    expect(codexInstructionsFile('/h/assistant/prompt-ru.md')).toBe('model_instructions_file="/h/assistant/prompt-ru.md"');
  });
});

describe('промпт и версии', () => {
  it('промпт называет язык ответа и метки эмоций', () => {
    expect(assistantPrompt('ru')).toContain('Reply in Russian');
    expect(assistantPrompt('en')).toContain('Reply in English');
    expect(assistantPrompt('ru')).toContain('[[calm]]');
  });
  it('versionAtLeast читает версию из вывода --version', () => {
    expect(versionAtLeast('2.1.300 (Claude Code)', '2.1.300')).toBe(true);
    expect(versionAtLeast('2.1.299 (Claude Code)', '2.1.300')).toBe(false);
    expect(versionAtLeast('codex-cli 0.170.1', '0.162.0')).toBe(true);
    expect(versionAtLeast('нет версии', '0.162.0')).toBe(true);
  });
});
```

- [ ] **Шаг 2: Поля реестра.** В `RunnerConfig` (после `printArgs`, ~72):
```ts
  /**
   * Ход помощника (спека 2026-10-14, 6.3): разовый запуск без терминала, инструменты — только MCP помощника.
   * Нет поля — провайдер помощнику не годится.
   */
  assistantArgs?: string[];
  /** То же со второго хода разговора: продолжение по `{providerSessionId}`. */
  assistantResumeArgs?: string[];
```
В `ProviderOverride` — те же два поля `string[]`. В `checkShape` рядом со строкой про `printArgs`:
```ts
    (patch['assistantArgs'] !== undefined && !isStrings(patch['assistantArgs'])) ||
    (patch['assistantResumeArgs'] !== undefined && !isStrings(patch['assistantResumeArgs'])) ||
```
В `applyOverride` рядом с `printArgs`:
```ts
  const assistantArgs = patch.assistantArgs ?? base?.runner.assistantArgs;
  const assistantResumeArgs = patch.assistantResumeArgs ?? base?.runner.assistantResumeArgs;
  if (assistantArgs !== undefined) runner.assistantArgs = assistantArgs;
  if (assistantResumeArgs !== undefined) runner.assistantResumeArgs = assistantResumeArgs;
```

- [ ] **Шаг 3: Встроенные шаблоны.** Над `PROVIDERS` (~170):
```ts
/**
 * Ход помощника (спека 2026-10-14, приложение A.2): только MCP помощника, без встроенных инструментов, без
 * настроек, хуков, плагинов и автопамяти человека. Промпт — сразу за `-p`: `--allowedTools`, `--tools` и
 * `--mcp-config` вариадические и «съели» бы его в конце.
 */
const CLAUDE_ASSISTANT_ARGS = [
  '-p', '{prompt}', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  '--model', '{model}', '--mcp-config', '{mcpConfig}', '--strict-mcp-config', '--system-prompt', '{systemPrompt}',
  '--allowedTools', 'mcp__parley-assistant__*', '--tools', '', '--setting-sources', '', '--disable-slash-commands',
  '--settings', '{"autoMemoryEnabled":false}',
];
const CLAUDE_ASSISTANT_RESUME_ARGS = [...CLAUDE_ASSISTANT_ARGS, '--resume', '{providerSessionId}'];
/** Codex 0.162.0: хуки и `notify` человека, shell и прочие встроенные возможности выключены (приложение A.2). */
const CODEX_ASSISTANT_DISABLE = [
  'hooks', 'shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'computer_use',
  'goals', 'image_generation', 'view_image', 'multi_agent', 'skill_search', 'tool_suggest', 'sleep_tool',
].flatMap((feature) => ['--disable', feature]);
const CODEX_ASSISTANT_CONFIG = [
  '-c', 'web_search="disabled"', '-c', 'skills.include_instructions=false', '-c', 'include_apps_instructions=false',
  '-c', 'include_collaboration_mode_instructions=false', '-c', 'model_reasoning_effort="low"',
  '-c', '{mcpConfig}', '-c', '{developerInstructions}',
];
const CODEX_ASSISTANT_ARGS = [
  'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules',
  ...CODEX_ASSISTANT_DISABLE, ...CODEX_ASSISTANT_CONFIG, '--model', '{model}', '{prompt}',
];
/** У `exec resume` нет `--sandbox` — песочница ключом конфига. */
const CODEX_ASSISTANT_RESUME_ARGS = [
  'exec', 'resume', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
  ...CODEX_ASSISTANT_DISABLE, ...CODEX_ASSISTANT_CONFIG, '-c', 'sandbox_mode="read-only"',
  '--model', '{model}', '{providerSessionId}', '{prompt}',
];
```
В `runner` записей: `claude` и `glm` — `assistantArgs: CLAUDE_ASSISTANT_ARGS, assistantResumeArgs: CLAUDE_ASSISTANT_RESUME_ARGS`; `codex` — `assistantArgs: CODEX_ASSISTANT_ARGS, assistantResumeArgs: CODEX_ASSISTANT_RESUME_ARGS`. Если `loadProviders` клонирует массивы `runner` поштучно — добавить клон и этих двух полей так же.

- [ ] **Шаг 4: `assistantCommand`** — рядом с `printCommand` (~528):
```ts
/** Команда хода помощника (спека 2026-10-14, 6.3); `null` — у провайдера нет шаблона, помощнику он не годится. */
export function assistantCommand(
  entry: ProviderEntry,
  subs: RunnerSubstitutions,
  resume: boolean,
): { command: string; args: string[] } | null {
  const template = resume ? entry.runner.assistantResumeArgs : entry.runner.assistantArgs;
  return template === undefined ? null : { command: entry.runner.command, args: substituteArgs(template, subs) };
}
```

- [ ] **Шаг 5: `launch.ts`**

```ts
/**
 * Запуск хода помощника (спека 2026-10-14, 6.1–6.4): модели по умолчанию, минимальные версии CLI, конфиг его MCP
 * для Claude (файл) и Codex (`-c`), системный промпт.
 */

import { MCP_SERVER_ENTRY } from '../work/mcp-config.js';
import { ASSISTANT_MCP_NAME } from './stream.js';
import type { AssistantLanguage } from './text.js';

/** Быстрые модели по умолчанию (спека 6.1). */
export const ASSISTANT_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  claude: 'haiku',
  glm: 'glm-5.3-flash[1m]',
  codex: 'gpt-6-luna',
};

/** Провайдер не выбран — первый готовый в этом порядке. */
export const ASSISTANT_PROVIDER_ORDER: readonly string[] = ['claude', 'glm', 'codex'];

/** Проверено спайком (приложение A); по имени команды CLI. */
export const ASSISTANT_MIN_VERSIONS: Readonly<Record<string, string>> = { claude: '2.1.300', codex: '0.162.0' };

/** `found` — вывод `--version`; версии в нём не нашлось — не отказываем. */
export function versionAtLeast(found: string, min: string): boolean {
  const have = /(\d+)\.(\d+)\.(\d+)/.exec(found);
  const need = /(\d+)\.(\d+)\.(\d+)/.exec(min);
  if (have === null || need === null) return true;
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(have[index]) - Number(need[index]);
    if (delta !== 0) return delta > 0;
  }
  return true;
}

export interface AssistantMcpParams {
  /** База маршрута хоста, например `http://127.0.0.1:5123/assistant`. */
  url: string;
  token: string;
  /** Для тестов; по умолчанию — node хоста и `mcp/server.js` из бандла, как у MCP сессий. */
  command?: string;
  args?: string[];
}

function launch(params: AssistantMcpParams): { command: string; args: string[] } {
  return { command: params.command ?? process.execPath, args: params.args ?? [MCP_SERVER_ENTRY] };
}

/** Файл `--mcp-config` для Claude и GLM. */
export function assistantMcpJson(params: AssistantMcpParams): string {
  const { command, args } = launch(params);
  const server = {
    type: 'stdio',
    command,
    args,
    env: { PARLEY_ASSISTANT_URL: params.url, PARLEY_ASSISTANT_TOKEN: params.token },
  };
  return `${JSON.stringify({ mcpServers: { [ASSISTANT_MCP_NAME]: server } }, null, 2)}\n`;
}

/** Значение `-c` для Codex: TOML-таблица в одну строку; JSON-экранирование строк годится TOML. */
export function assistantCodexMcp(params: AssistantMcpParams): string {
  const { command, args } = launch(params);
  const toml = (value: string): string => JSON.stringify(value);
  return (
    `mcp_servers.${ASSISTANT_MCP_NAME}={command=${toml(command)},args=[${args.map(toml).join(',')}],` +
    `env={PARLEY_ASSISTANT_URL=${toml(params.url)},PARLEY_ASSISTANT_TOKEN=${toml(params.token)}},` +
    `default_tools_approval_mode="approve",startup_timeout_sec=30,tool_timeout_sec=60}`
  );
}

/** Значение `-c` для Codex: базовый промпт заменён файлом помощника (приложение A.2 — ~10 тыс. токенов дешевле). */
export function codexInstructionsFile(file: string): string {
  return `model_instructions_file=${JSON.stringify(file)}`;
}

const LANGUAGE_NAMES: Readonly<Record<AssistantLanguage, string>> = { en: 'English', ru: 'Russian' };

/** Системный промпт помощника (спека 6.4). */
export function assistantPrompt(language: AssistantLanguage): string {
  return [
    'You are the Parley assistant: a navigator for one person who runs several AI coding agents in Parley.',
    'Parley groups agents into works inside projects; a work has sessions (agents) and rooms (group chats of agents).',
    'You answer the person about what their agents, works and rooms are doing, and you pass their messages on.',
    '',
    'Rules:',
    `- Reply in ${LANGUAGE_NAMES[language]}, even if the person wrote in another language.`,
    '- Your reply is read on a small panel and may be spoken aloud: 1-4 short spoken sentences. No markdown, lists, file paths, code or ids.',
    '- Start every reply with one mood tag: [[calm]] [[joy]] [[sad]] [[surprise]] [[anger]], matching the news. Then the reply.',
    '- For anything about the current state call parley_overview first, every time. For one room or session call parley_detail with an id from the overview. Never answer about state from memory and never guess; if the tools do not say, say you do not know.',
    '- To pass a message to a room or an agent, call propose_message with the target id and the exact text to send. You never send anything yourself: the person sees a card and confirms or cancels it. After proposing, say in one short sentence what you prepared; do not repeat the text.',
    '- If the person asks to start over or for a new conversation, call end_conversation and say so briefly.',
    '- Lines that start with [system: ...] come from Parley, not from the person.',
    '- You cannot approve agent requests, start or stop sessions, or create rooms. If asked, say that this is not available yet.',
  ].join('\n');
}
```

- [ ] **Шаг 6: Реэкспорт** в `index.ts`:
```ts
export { assistantCommand } from './providers.js'; // в блок providers, если он перечисляет имена
export {
  ASSISTANT_DEFAULT_MODELS, ASSISTANT_MIN_VERSIONS, ASSISTANT_PROVIDER_ORDER, assistantCodexMcp, assistantMcpJson,
  assistantPrompt, codexInstructionsFile, versionAtLeast,
} from './assistant/launch.js';
export type { AssistantMcpParams } from './assistant/launch.js';
```

---

### Задача 4: Режим помощника в `parley-mcp`

**Файлы:**
- Create: `packages/core/src/mcp/assistant.ts`
- Modify: `packages/core/src/mcp/server.ts` (ветка до `loadConfig`)
- Test: `packages/core/src/mcp/assistant.test.ts`

**Interfaces:**
- Consumes: `ASSISTANT_MCP_NAME` (задача 2).
- Produces: `ASSISTANT_TOOLS: Tool[]` (`parley_overview`, `parley_detail`, `propose_message`, `end_conversation`), `interface AssistantServerOptions { url: string; token: string; fetch?: typeof fetch }`, `createAssistantServer(options): Server`. Протокол с хостом: `POST <url>/<tool>`, `Authorization: Bearer <token>`, тело — аргументы инструмента JSON; ответ `200 {"text": string}` или не-200 `{"error": string}`.

- [ ] **Шаг 1: Тест** (образец пары транспорта — `mcp/server.test.ts`):

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createAssistantServer } from './assistant.js';

async function connect(fetch: typeof globalThis.fetch): Promise<Client> {
  const server = createAssistantServer({ url: 'http://127.0.0.1:1/assistant', token: 't0k', fetch });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return client;
}
const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('parley-mcp в режиме помощника', () => {
  it('отдаёт ровно четыре инструмента', async () => {
    const client = await connect(vi.fn());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['end_conversation', 'parley_detail', 'parley_overview', 'propose_message']);
  });
  it('вызов — POST в хост с токеном, ответ — текст', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, { text: 'Work "Parley": 2 working' }));
    const client = await connect(fetch);
    const result = await client.callTool({ name: 'parley_detail', arguments: { target: 'room:a:w:r' } });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:1/assistant/parley_detail', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer t0k' }),
      body: JSON.stringify({ target: 'room:a:w:r' }),
    }));
    expect(result.content).toEqual([{ type: 'text', text: 'Work "Parley": 2 working' }]);
    expect(result.isError).toBeFalsy();
  });
  it('отказ хоста — ошибка инструмента с его текстом', async () => {
    const client = await connect(vi.fn().mockResolvedValue(reply(404, { error: 'No room "Foo"' })));
    const result = await client.callTool({ name: 'propose_message', arguments: { target: 'Foo', text: 'x' } });
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'No room "Foo"' }] });
  });
  it('хост недоступен — ошибка, а не падение сервера', async () => {
    const client = await connect(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await client.callTool({ name: 'parley_overview', arguments: {} });
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Шаг 2: Реализация** `mcp/assistant.ts`:

```ts
/**
 * Режим помощника `parley-mcp` (спека 2026-10-14, 7.1): только четыре инструмента, каждый — POST в маршрут хоста
 * `/assistant/<имя>` с токеном разговора. Карту работ сервер сам не читает: всё знает хост.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { ASSISTANT_MCP_NAME } from '../assistant/stream.js';

const TARGET = {
  type: 'string',
  description: 'An id from parley_overview (room:… or session:…). An exact room or session name also works when it is unique.',
};

export const ASSISTANT_TOOLS: Tool[] = [
  {
    name: 'parley_overview',
    description: 'Current state of all open works in Parley: rooms (members, who works, plan progress, who needs the person) and sessions (state, task, summary, what they wait for). Call it before answering anything about the current state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'parley_detail',
    description: 'Details of one room (plan items and the last messages) or one session (its last reply and what it waits for).',
    inputSchema: { type: 'object', properties: { target: TARGET }, required: ['target'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'propose_message',
    description: 'Prepare a message from the person to a room or to an agent session. Nothing is sent: the person sees a card and confirms or cancels it.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        text: { type: 'string', description: 'The exact text to send, in the words the person asked for.' },
        kind: { type: 'string', enum: ['note', 'question', 'decision'], description: 'Only for rooms; note by default.' },
      },
      required: ['target', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'end_conversation',
    description: 'The person asked to start over: the conversation is forgotten after this reply.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export interface AssistantServerOptions {
  /** База маршрута хоста (`PARLEY_ASSISTANT_URL`), без завершающего `/`. */
  url: string;
  token: string;
  /** Для тестов. */
  fetch?: typeof fetch;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

const failure = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export function createAssistantServer(options: AssistantServerOptions): Server {
  const call = options.fetch ?? fetch;
  const server = new Server({ name: ASSISTANT_MCP_NAME, version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ASSISTANT_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ToolResult> => {
    const name = request.params.name;
    if (!ASSISTANT_TOOLS.some((tool) => tool.name === name)) return failure(`unknown tool ${name}`);
    try {
      const response = await call(`${options.url}/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
        body: JSON.stringify(request.params.arguments ?? {}),
      });
      const body = (await response.json().catch(() => ({}))) as { text?: unknown; error?: unknown };
      if (response.ok && typeof body.text === 'string') return { content: [{ type: 'text', text: body.text }] };
      return failure(typeof body.error === 'string' ? body.error : `Parley answered ${response.status}`);
    } catch (error) {
      return failure(`Parley is not reachable: ${(error as Error).message}`);
    }
  });
  return server;
}
```

- [ ] **Шаг 3: Ветка в `server.ts`** — в `main()` до `loadConfig()` (у `contextFromEnv` без `PARLEY_WORK_DIR` исключение, поэтому раньше). `envValue` импортировать тем же путём, что `mcp/context.ts`:
```ts
    const assistantUrl = envValue(process.env, 'ASSISTANT_URL');
    if (assistantUrl !== undefined) {
      // Режим помощника (спека 2026-10-14, 7.1): своя пара инструментов, карта работ не нужна.
      server = createAssistantServer({ url: assistantUrl, token: envValue(process.env, 'ASSISTANT_TOKEN') ?? '' });
    } else {
      const { config } = await loadConfig();
      server = createParleyServer({ ...contextFromEnv(), messageRate: config.messageRate, worktreeRoot: config.worktreeRoot });
    }
```
(внутри существующего `try`).

---

### Задача 5: Поле `via` у письма

**Файлы:**
- Modify: `packages/core/src/work/types.ts` (`Message`, новый `MessageVia`), `packages/core/src/work/map.ts` (`NewMessage`, `addMessage`), `packages/core/src/mcp/tools.ts` (`messageView`), `packages/core/src/index.ts` (тип `MessageVia`)
- Test: дописать в `packages/core/src/work/map.test.ts` и в тесты `read_room`/`check_inbox` (`packages/core/src/mcp/server.test.ts` или где они лежат)

**Interfaces:**
- Produces: `type MessageVia = 'assistant'`, `Message.via?: MessageVia`, `NewMessage.via?: MessageVia`; `check_inbox`, `read_room` и страницы `get_map` отдают `via` полем рядом с `from`.

- [ ] **Шаг 1: Тесты.** В `map.test.ts`:
```ts
it('addMessage переносит via, а без него поля нет', () => {
  const map = emptyMap(); // тем же помощником, что соседние тесты addMessage
  const withVia = addMessage(map, { from: HUMAN, to: [], text: 'x', roomId: 'r-1', via: 'assistant' });
  const plain = addMessage(map, { from: HUMAN, to: [], text: 'y', roomId: 'r-1' });
  expect(withVia.via).toBe('assistant');
  expect('via' in plain).toBe(false);
});
```
В тестах `read_room` (по образцу соседних — тот же стенд карты с комнатой): письмо человека с `via: 'assistant'` приходит агенту с `via: 'assistant'`, письмо без поля — без `via`.

- [ ] **Шаг 2: Реализация.** В `types.ts` над `Message`:
```ts
/** Через кого человек отправил письмо (спека 2026-10-14, 7.4); нет поля — сам, в окне. */
export type MessageVia = 'assistant';
```
в `Message` после `replyTo`:
```ts
  /** Письмо человека, переданное помощником (спека 2026-10-14, 7.4). У старых карт поля нет. */
  via?: MessageVia;
```
В `map.ts`: `NewMessage` — `via?: MessageVia;`; в `addMessage` рядом со спредом `replyTo`:
```ts
    ...(init.via === undefined ? {} : { via: init.via }),
```
В `tools.ts` `messageView` после `replyTo`:
```ts
    ...(message.via === undefined ? {} : { via: message.via }),
```
В `index.ts` — `MessageVia` к типам из `./work/types.js`.

- [ ] **Шаг 3: Прогон группы A** (контролёр, после проверки загрузки):
```bash
cd packages/core && nice -n 10 pnpm vitest run src/assistant src/mcp src/work/map.test.ts src/providers.test.ts && nice -n 10 pnpm typecheck && nice -n 10 pnpm build
```
Expected: всё зелёное; `frame-check.test.ts` — тоже (`nice -n 10 pnpm vitest run test/frame-check.test.ts`). Коммит группы:
```bash
git add packages/core && git commit -m "feat(core): помощник — разбор потоков CLI, шаблоны хода, режим parley-mcp, via у письма"
```

---

## Группа B — протокол и хост

### Задача 6: Протокол помощника

**Файлы:**
- Create: `packages/protocol/src/assistant.ts`
- Modify: `packages/protocol/src/methods.ts` (спред схем в `METHODS`, `extends` в `Results`), `packages/protocol/src/events.ts` (`assistant.changed`), `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/assistant.test.ts`

**Interfaces:**
- Consumes: `AssistantMood`, `AssistantLanguage` из `@parley/core` (протокол уже зависит от core).
- Produces: схемы методов `assistant.ask`, `assistant.cancel`, `assistant.decide`, `assistant.reset`, `assistant.state`, `assistant.sent`; типы `AssistantPhase`, `AssistantDetail`, `AssistantProposal`, `AssistantState`, `AssistantMethodResults`; событие `'assistant.changed': AssistantState`.

- [ ] **Шаг 1: Тест**

```ts
import { describe, expect, it } from 'vitest';
import { METHODS } from './methods.js';

describe('схемы методов помощника', () => {
  it('assistant.ask: текст обязателен, провайдер и модель могут быть null', () => {
    expect(METHODS['assistant.ask'].safeParse({ text: 'кто работает?', provider: null, model: null, language: 'ru' }).success).toBe(true);
    expect(METHODS['assistant.ask'].safeParse({ text: '', provider: null, model: null, language: 'ru' }).success).toBe(false);
    expect(METHODS['assistant.ask'].safeParse({ text: 'x', provider: 'claude', model: 'haiku', language: 'de' }).success).toBe(false);
  });
  it('assistant.decide: только send и cancel', () => {
    expect(METHODS['assistant.decide'].safeParse({ proposalId: 'p1', decision: 'send' }).success).toBe(true);
    expect(METHODS['assistant.decide'].safeParse({ proposalId: 'p1', decision: 'maybe' }).success).toBe(false);
  });
  it('assistant.sent: ссылка на сессию', () => {
    expect(METHODS['assistant.sent'].safeParse({ ref: { projectPath: '/p', workId: 'w', sessionId: 's' } }).success).toBe(true);
  });
});
```

- [ ] **Шаг 2: Реализация** `assistant.ts` (образец подключения модуля — `journal.ts`):

```ts
/**
 * Протокол помощника (спека 2026-10-14, 6.5): методы хода, карточки и разговора и снимок его состояния, который
 * хост рассылает событием `assistant.changed`.
 */

import { z } from 'zod';
import type { AssistantMood } from '@parley/core';

export type AssistantPhase = 'idle' | 'thinking' | 'tool' | 'answering' | 'awaiting-confirm' | 'error' | 'offline';

/** Что помощник смотрит сейчас — подпись острова строит окно (`Checking rooms…`, `Reading Auth…`). */
export interface AssistantDetail {
  tool: 'overview' | 'detail' | 'propose' | 'other';
  /** Имя комнаты или сессии у `detail`. */
  target: string | null;
}

export interface AssistantProposal {
  id: string;
  /** Имя адресата: комната («Auth») или сессия («S03 Ruslan»). */
  target: string;
  /** Работа и проект: «Parley · my_harnas». */
  where: string;
  /** Вид письма комнаты; у сессии — `null`. */
  kind: 'note' | 'question' | 'decision' | null;
  text: string;
}

export interface AssistantState {
  phase: AssistantPhase;
  detail: AssistantDetail | null;
  /** Последний вопрос человека. */
  question: string | null;
  /** Ответ, растёт по ходу. */
  answer: string;
  mood: AssistantMood;
  proposal: AssistantProposal | null;
  /** Исход последней карточки — для «Sent ✓»; новый ход сбрасывает. */
  outcome: 'sent' | 'cancelled' | null;
  /** Причина `error` и `offline`, по-английски. */
  error: string | null;
  /** Номер хода: окно отличает новый ход от продолжения старого. */
  turn: number;
}

const sessionRef = z.object({ projectPath: z.string(), workId: z.string(), sessionId: z.string() });

export const assistantMethodSchemas = {
  'assistant.ask': z.object({
    text: z.string().min(1).max(4000),
    /** `null` — первый готовый провайдер (`claude`, `glm`, `codex`). */
    provider: z.string().min(1).nullable(),
    /** `null` — модель по умолчанию провайдера. */
    model: z.string().min(1).nullable(),
    language: z.enum(['en', 'ru']),
  }),
  'assistant.cancel': z.object({}),
  'assistant.decide': z.object({ proposalId: z.string().min(1), decision: z.enum(['send', 'cancel']) }),
  'assistant.reset': z.object({}),
  'assistant.state': z.object({}),
  'assistant.sent': z.object({ ref: sessionRef }),
} as const;

export interface AssistantMethodResults {
  'assistant.ask': { ok: true };
  'assistant.cancel': { ok: true };
  'assistant.decide': { applied: boolean; error: string | null };
  'assistant.reset': { ok: true };
  'assistant.state': AssistantState;
  /** Что помощник отправил этой сессии в Chat — окно помечает такие сообщения (спека 7.4). */
  'assistant.sent': { items: Array<{ text: string; at: string }> };
}
```

- [ ] **Шаг 3: Подключение.** `methods.ts`: импорт `assistantMethodSchemas` и `AssistantMethodResults`, `...assistantMethodSchemas` в начало `METHODS` рядом с `...journalMethodSchemas`, `AssistantMethodResults` в `extends` у `Results`. `events.ts`: в `Events` строка
```ts
  'assistant.changed': AssistantState;
```
`index.ts`: `export * from './assistant.js';` (или именованно — как экспортируется `journal.ts`).

---

### Задача 7: Снимок, подробности и цели помощника (чистые функции хоста)

**Файлы:**
- Create: `packages/host/src/assistant/overview.ts`
- Test: `packages/host/src/assistant/overview.test.ts`

**Interfaces:**
- Consumes: `WorkEntry`, `WorkMap`, `WorkSession`, `participantLabel`, `HUMAN` из `@parley/core`; `SessionRef` из `@parley/protocol`; `SessionLive` из `../activity/activity-service.js`.
- Produces: `type SessionState`, `type AssistantTarget`, `interface OverviewSource { entries: readonly WorkEntry[]; live(ref: SessionRef): SessionLive | undefined }`, `sessionState(session, live): SessionState`, `targetsOf(source): AssistantTarget[]`, `resolveTarget(targets, wanted): { target: AssistantTarget } | { error: string }`, `overviewText(source, maxChars?): string`, `detailText(source, target, lastReply: string | null): string`.

- [ ] **Шаг 1: Тест** (фабрики карты — `test/` хоста или core `work-writer`; если их нет, собрать `WorkMap` литералом с нужными полями и `as WorkMap`):

```ts
import { describe, expect, it } from 'vitest';
import type { WorkEntry, WorkMap } from '@parley/core';
import type { SessionLive } from '../activity/activity-service.js';
import { detailText, overviewText, resolveTarget, targetsOf, type OverviewSource } from './overview.js';

function session(id: string, label: string, extra: Record<string, unknown> = {}) {
  return { id, label, provider: 'claude', task: `task of ${label}`, summary: null, lifecycle: 'active', ...extra };
}
function entry(projectPath: string, workId: string, title: string, overrides: Partial<WorkMap> = {}): WorkEntry {
  return {
    projectPath,
    map: {
      schemaVersion: 2,
      work: { id: workId, title, goal: '', status: 'active' },
      sessions: [session('s-03', 'S03 Ruslan'), session('s-05', 'S05 Vera')],
      messages: [],
      rooms: [{ id: 'r-1', title: 'Auth', creator: 's-03', members: ['s-03', 's-05'], createdAt: '', lead: 's-03', proposal: null }],
      ...overrides,
    } as unknown as WorkMap,
  };
}
const live = (activity: string, waitingFor: string | null = null): SessionLive =>
  ({ activity: { activity, waitingFor, exited: false }, metrics: null }) as unknown as SessionLive;

function source(entries: WorkEntry[], states: Record<string, SessionLive>): OverviewSource {
  return { entries, live: (ref) => states[ref.sessionId] };
}

describe('targetsOf и resolveTarget', () => {
  const src = source([entry('/p/one', 'w-1', 'Parley')], { 's-03': live('working'), 's-05': live('idle') });
  it('id по проекту, работе и элементу', () => {
    const ids = targetsOf(src).map((target) => target.id);
    expect(ids).toHaveLength(3);
    expect(ids.every((id) => /^(room|session):[0-9a-f]{6}:w-1:/.test(id))).toBe(true);
  });
  it('находит по id, по имени и по первому слову имени', () => {
    const targets = targetsOf(src);
    const room = targets.find((target) => target.kind === 'room');
    expect(resolveTarget(targets, room?.id ?? '')).toEqual({ target: room });
    expect(resolveTarget(targets, 'auth')).toMatchObject({ target: { kind: 'room', name: 'Auth' } });
    expect(resolveTarget(targets, 'S03')).toMatchObject({ target: { kind: 'session', name: 'S03 Ruslan' } });
  });
  it('неоднозначное имя — ошибка со списком, неизвестное — подсказка', () => {
    const two = targetsOf(source([entry('/p/one', 'w-1', 'Parley'), entry('/p/two', 'w-2', 'Site')], {}));
    expect(resolveTarget(two, 'Auth')).toMatchObject({ error: expect.stringContaining('several') });
    expect(resolveTarget(two, 'Billing')).toMatchObject({ error: expect.stringContaining('parley_overview') });
  });
  it('архивная работа, архивная комната и закрытая сессия — не цели', () => {
    const archived = entry('/p/a', 'w-a', 'Old', { work: { id: 'w-a', title: 'Old', goal: '', status: 'archived' } } as Partial<WorkMap>);
    const roomArchived = entry('/p/b', 'w-b', 'B', {
      rooms: [{ id: 'r-9', title: 'Gone', creator: 's-03', members: [], createdAt: '', lead: null, proposal: null, archivedAt: '2026-10-01' }],
      sessions: [session('s-03', 'S03 Ruslan', { lifecycle: 'closed' })],
    } as unknown as Partial<WorkMap>);
    expect(targetsOf(source([archived, roomArchived], {}))).toEqual([]);
  });
  it('сессия без живого процесса — running: false', () => {
    const target = targetsOf(source([entry('/p/one', 'w-1', 'Parley')], {})).find((item) => item.kind === 'session');
    expect(target).toMatchObject({ running: false });
  });
});

describe('overviewText', () => {
  it('ждущие человека — первыми, с тем, чего ждут', () => {
    const text = overviewText(source([entry('/p/one', 'w-1', 'Parley')], { 's-03': live('working'), 's-05': live('blocked', 'Bash: rm -rf dist') }));
    expect(text).toContain('Work "Parley"');
    expect(text).toContain('Room "Auth"');
    expect(text.indexOf('S05 Vera')).toBeLessThan(text.indexOf('S03 Ruslan'));
    expect(text).toContain('waiting for: Bash: rm -rf dist');
  });
  it('пусто — так и говорит', () => {
    expect(overviewText(source([], {}))).toBe('No works are open in Parley right now.');
  });
  it('длинный снимок срезается по работам с пометкой', () => {
    const many = Array.from({ length: 60 }, (_, index) => entry(`/p/${index}`, `w-${index}`, `Work ${index}`));
    const text = overviewText(source(many, {}), 2000);
    expect(text.length).toBeLessThanOrEqual(2200);
    expect(text).toMatch(/more works not shown/);
  });
});

describe('detailText', () => {
  it('сессия — последний ответ', () => {
    const src = source([entry('/p/one', 'w-1', 'Parley')], { 's-03': live('idle') });
    const target = targetsOf(src).find((item) => item.kind === 'session' && item.name === 'S03 Ruslan');
    expect(detailText(src, target!, 'Тесты зелёные.')).toContain('Last reply: Тесты зелёные.');
  });
  it('комната — последние сообщения', () => {
    const map = entry('/p/one', 'w-1', 'Parley', {
      messages: [{ id: 'm1', roomId: 'r-1', from: 'human', to: [], at: '2026-10-15T10:00:00Z', text: 'Как дела?', kind: 'question', readBy: {} }],
    } as unknown as Partial<WorkMap>);
    const src = source([map], {});
    const room = targetsOf(src).find((item) => item.kind === 'room');
    expect(detailText(src, room!, null)).toContain('Как дела?');
  });
});
```

- [ ] **Шаг 2: Реализация**

```ts
/**
 * Что помощник знает о работах (спека 2026-10-14, 7.2): компактный снимок всех открытых работ, подробности одной
 * комнаты или сессии и разбор цели, которую назвала модель. Чистые функции: снимок работ и активность — на входе.
 */

import { createHash } from 'node:crypto';
import { participantLabel, type WorkEntry, type WorkMap, type WorkSession } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { SessionLive } from '../activity/activity-service.js';

export type SessionState = 'working' | 'needs-you' | 'unseen' | 'idle' | 'off';

export type AssistantTarget =
  | { kind: 'room'; id: string; projectPath: string; workId: string; roomId: string; name: string; where: string }
  | { kind: 'session'; id: string; ref: SessionRef; name: string; where: string; running: boolean };

export interface OverviewSource {
  entries: readonly WorkEntry[];
  live(ref: SessionRef): SessionLive | undefined;
}

const STATE_ORDER: Readonly<Record<SessionState, number>> = { 'needs-you': 0, working: 1, unseen: 2, idle: 3, off: 4 };
const ROOM_MESSAGES = 10;
const PLAN_ITEMS = 12;

const projectKey = (projectPath: string): string => createHash('sha1').update(projectPath).digest('hex').slice(0, 6);
const projectName = (projectPath: string): string => projectPath.split('/').filter(Boolean).pop() ?? projectPath;
const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const open = (entries: readonly WorkEntry[]): WorkEntry[] => entries.filter((entry) => entry.map.work.status !== 'archived');
const isArchived = (room: { archivedAt?: unknown }): boolean => typeof room.archivedAt === 'string';
const where = (entry: WorkEntry): string => `${entry.map.work.title} · ${projectName(entry.projectPath)}`;
const refOf = (entry: WorkEntry, session: WorkSession): SessionRef => ({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id });

export function sessionState(session: WorkSession, live: SessionLive | undefined): SessionState {
  if (session.lifecycle === 'closed' || live === undefined || live.activity.exited) return 'off';
  switch (live.activity.activity) {
    case 'blocked':
      return 'needs-you';
    case 'working':
      return 'working';
    case 'unseen':
      return 'unseen';
    default:
      return 'idle';
  }
}

export function targetsOf(source: OverviewSource): AssistantTarget[] {
  const targets: AssistantTarget[] = [];
  for (const entry of open(source.entries)) {
    const { map } = entry;
    const prefix = `${projectKey(entry.projectPath)}:${map.work.id}`;
    for (const room of map.rooms) {
      if (isArchived(room)) continue;
      targets.push({ kind: 'room', id: `room:${prefix}:${room.id}`, projectPath: entry.projectPath, workId: map.work.id, roomId: room.id, name: room.title, where: where(entry) });
    }
    for (const session of map.sessions) {
      if (session.lifecycle === 'closed') continue;
      const ref = refOf(entry, session);
      targets.push({
        kind: 'session',
        id: `session:${prefix}:${session.id}`,
        ref,
        name: participantLabel(map, session.id),
        where: where(entry),
        running: sessionState(session, source.live(ref)) !== 'off',
      });
    }
  }
  return targets;
}

/** Цель по id из снимка, а если модель назвала имя — по однозначному имени или его первому слову («S03»). */
export function resolveTarget(targets: readonly AssistantTarget[], wanted: string): { target: AssistantTarget } | { error: string } {
  const key = wanted.trim();
  const exact = targets.find((target) => target.id === key);
  if (exact !== undefined) return { target: exact };
  const name = key.toLowerCase();
  const matches = targets.filter((target) => {
    const own = target.name.toLowerCase();
    return name !== '' && (own === name || own.split(' ')[0] === name);
  });
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return { target: only };
  if (matches.length > 1) {
    return { error: `"${key}" matches several targets: ${matches.map((target) => `${target.id} (${target.name}, ${target.where})`).join('; ')}` };
  }
  return { error: `No room or session "${key}". Call parley_overview for the current ids.` };
}

function sessionLine(entry: WorkEntry, session: WorkSession, state: SessionState, live: SessionLive | undefined): string {
  const prefix = `${projectKey(entry.projectPath)}:${entry.map.work.id}`;
  const parts = [`  Session ${participantLabel(entry.map, session.id)} [session:${prefix}:${session.id}] ${session.provider}`, state];
  if (typeof session.task === 'string' && session.task.trim() !== '') parts.push(`task: ${oneLine(session.task, 160)}`);
  if (typeof session.summary === 'string' && session.summary.trim() !== '') parts.push(`summary: ${oneLine(session.summary, 200)}`);
  const waitingFor = live?.activity.waitingFor ?? null;
  if (state === 'needs-you' && waitingFor !== null) parts.push(`waiting for: ${oneLine(waitingFor, 120)}`);
  return parts.join(' · ');
}

function planOf(map: WorkMap, roomId: string) {
  return (map.plans ?? []).find((plan) => plan.roomId === roomId && plan.status !== 'cancelled' && plan.status !== 'completed');
}

/** Снимок всех открытых работ (спека 7.2.1); работы с ждущими человека — первыми; длиннее `maxChars` — срез по работам. */
export function overviewText(source: OverviewSource, maxChars = 8000): string {
  const blocks: Array<{ rank: number; text: string }> = [];
  for (const entry of open(source.entries)) {
    const { map } = entry;
    const prefix = `${projectKey(entry.projectPath)}:${map.work.id}`;
    const sessions = map.sessions
      .filter((session) => session.lifecycle !== 'closed')
      .map((session) => {
        const live = source.live(refOf(entry, session));
        return { session, live, state: sessionState(session, live) };
      })
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
    const lines = [`Work "${map.work.title}" (project ${projectName(entry.projectPath)})`];
    for (const room of map.rooms) {
      if (isArchived(room)) continue;
      const members = sessions.filter((item) => room.members.includes(item.session.id));
      const working = members.filter((item) => item.state === 'working').length;
      const waiting = members.filter((item) => item.state === 'needs-you').length;
      const plan = planOf(map, room.id);
      const done = plan?.items.filter((item) => item.status === 'done' || item.status === 'verified').length ?? 0;
      lines.push(
        `  Room "${room.title}" [room:${prefix}:${room.id}]: ${members.length} members, ${working} working` +
          (waiting > 0 ? `, ${waiting} need the person` : '') +
          (room.lead === null ? '' : `, lead ${participantLabel(map, room.lead)}`) +
          (plan === undefined ? '' : `, plan ${done}/${plan.items.length}: ${oneLine(plan.goal, 120)}`),
      );
    }
    for (const item of sessions) lines.push(sessionLine(entry, item.session, item.state, item.live));
    const rank = Math.min(...sessions.map((item) => STATE_ORDER[item.state]), STATE_ORDER.off);
    blocks.push({ rank, text: lines.join('\n') });
  }
  if (blocks.length === 0) return 'No works are open in Parley right now.';
  blocks.sort((a, b) => a.rank - b.rank);
  const shown: string[] = [];
  let size = 0;
  let skipped = 0;
  for (const block of blocks) {
    if (size + block.text.length > maxChars && shown.length > 0) {
      skipped += 1;
      continue;
    }
    shown.push(block.text);
    size += block.text.length + 2;
  }
  if (skipped > 0) shown.push(`…${skipped} more works not shown (less active).`);
  return shown.join('\n\n');
}

/** Подробности одной цели (спека 7.2.2). `lastReply` — последний ответ агента из ленты, только у сессии. */
export function detailText(source: OverviewSource, target: AssistantTarget, lastReply: string | null): string {
  const projectPath = target.kind === 'room' ? target.projectPath : target.ref.projectPath;
  const workId = target.kind === 'room' ? target.workId : target.ref.workId;
  const entry = source.entries.find((item) => item.projectPath === projectPath && item.map.work.id === workId);
  if (entry === undefined) return `${target.name} is no longer in Parley.`;
  const { map } = entry;
  if (target.kind === 'session') {
    const session = map.sessions.find((item) => item.id === target.ref.sessionId);
    if (session === undefined) return `${target.name} is no longer in Parley.`;
    const live = source.live(target.ref);
    const lines = [sessionLine(entry, session, sessionState(session, live), live).trim()];
    if (lastReply !== null) lines.push(`Last reply: ${oneLine(lastReply, 1500)}`);
    return lines.join('\n');
  }
  const room = map.rooms.find((item) => item.id === target.roomId);
  if (room === undefined) return `${target.name} is no longer in Parley.`;
  const lines = [`Room "${room.title}" in ${target.where}; members: ${room.members.map((id) => participantLabel(map, id)).join(', ') || 'none'}`];
  const plan = planOf(map, room.id);
  if (plan !== undefined) {
    lines.push(`Plan: ${oneLine(plan.goal, 200)}`);
    for (const item of plan.items.slice(0, PLAN_ITEMS)) lines.push(`  ${item.id}. ${oneLine(item.title, 120)} — ${item.status}`);
  }
  const messages = map.messages.filter((message) => message.roomId === room.id).slice(-ROOM_MESSAGES);
  if (messages.length > 0) lines.push('Last messages:');
  for (const message of messages) lines.push(`  ${participantLabel(map, message.from)} (${message.kind}): ${oneLine(message.text, 200)}`);
  return lines.join('\n');
}
```
Если `participantLabel` не реэкспортирован из `@parley/core` — добавить его в блок экспорта `./work/thread.js` в `core/src/index.ts`.

---

### Задача 8: Маршрут `/assistant/*` hook-сервера

**Файлы:**
- Modify: `packages/host/src/hooks/hook-server.ts`
- Test: дописать в `packages/host/src/hooks/hook-server.test.ts`

**Interfaces:**
- Produces: в `HookServerOptions` — `onAssistant?(tool: string, args: unknown): Promise<AssistantReply>`; `export interface AssistantReply { status: number; body: { text: string } | { error: string } }`; в `HookServer` — `baseUrl(): string | null` (адрес без `/hooks`) и `setAssistantToken(token: string | null): void`.

- [ ] **Шаг 1: Тест** (по образцу `boot()`/`post()` этого файла; `fetch` Node 20 достаточно):

```ts
describe('маршрут помощника /assistant/*', () => {
  it('верный токен — ответ обработчика; чужой или снятый — 401', async () => {
    const onAssistant = vi.fn().mockResolvedValue({ status: 200, body: { text: 'ok' } });
    const server = createHookServer({ log: silentLog, onHook: vi.fn(), onAssistant });
    await server.listen();
    try {
      const base = server.baseUrl();
      expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const post = (token: string): Promise<Response> =>
        fetch(`${base}/assistant/parley_overview`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"a":1}' });
      expect((await post('nope')).status).toBe(401);
      server.setAssistantToken('secret-1');
      const ok = await post('secret-1');
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ text: 'ok' });
      expect(onAssistant).toHaveBeenCalledWith('parley_overview', { a: 1 });
      expect((await post('secret-2')).status).toBe(401);
      server.setAssistantToken(null);
      expect((await post('secret-1')).status).toBe(401);
    } finally {
      await server.close(); // тем же способом, что соседние тесты останавливают сервер
    }
  });
  it('без обработчика маршрута нет', async () => {
    const server = createHookServer({ log: silentLog, onHook: vi.fn() });
    await server.listen();
    try {
      server.setAssistantToken('t');
      const response = await fetch(`${server.baseUrl()}/assistant/x`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: '{}' });
      expect(response.status).toBe(404);
    } finally {
      await server.close();
    }
  });
  it('битый JSON — 400', async () => {
    const server = createHookServer({ log: silentLog, onHook: vi.fn(), onAssistant: vi.fn() });
    await server.listen();
    try {
      server.setAssistantToken('t');
      const response = await fetch(`${server.baseUrl()}/assistant/x`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: '{' });
      expect(response.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
```

- [ ] **Шаг 2: Реализация.** Импорт `timingSafeEqual` из `node:crypto` (рядом с `randomBytes`), типы `IncomingMessage`, `ServerResponse` — как уже импортированы. Над `createHookServer`:
```ts
/** Ответ маршрута помощника (спека 2026-10-14, 7.1). */
export interface AssistantReply {
  status: number;
  body: { text: string } | { error: string };
}

const ASSISTANT_PREFIX = '/assistant/';
const ASSISTANT_BODY_LIMIT = 1024 * 1024;

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
```
В `HookServerOptions`:
```ts
  /** Вызов инструмента помощника (`/assistant/<tool>`); нет — маршрута нет. */
  onAssistant?(tool: string, args: unknown): Promise<AssistantReply>;
```
В `HookServer`:
```ts
  /** Адрес сервера без `/hooks`, `null` до `listen()`. */
  baseUrl(): string | null;
  /** Токен текущего разговора помощника; `null` — маршрут закрыт. */
  setAssistantToken(token: string | null): void;
```
В замыкании `createHookServer`:
```ts
  let assistantToken: Buffer | null = null;

  const assistantAllowed = (header: string | undefined): boolean => {
    if (assistantToken === null) return false;
    const given = Buffer.from(header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length).trim() : '');
    return given.length === assistantToken.length && timingSafeEqual(given, assistantToken);
  };

  const handleAssistant = async (req: IncomingMessage, res: ServerResponse, tool: string): Promise<void> => {
    const onAssistant = options.onAssistant;
    if (onAssistant === undefined) return reject(req, res, 404, 'route');
    if (!assistantAllowed(headerOf(req, 'authorization'))) return reject(req, res, 401, 'token');
    let args: unknown = {};
    try {
      const raw = await readBody(req, ASSISTANT_BODY_LIMIT);
      args = raw.trim() === '' ? {} : JSON.parse(raw);
    } catch {
      return reject(req, res, 400, 'body');
    }
    const reply = await onAssistant(tool, args).catch((error: unknown): AssistantReply => ({ status: 500, body: { error: (error as Error).message } }));
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  };
```
В `handle()` перед проверкой `HOOK_PATH`:
```ts
    if (req.method === 'POST' && pathname?.startsWith(ASSISTANT_PREFIX) === true) {
      void handleAssistant(req, res, pathname.slice(ASSISTANT_PREFIX.length));
      return;
    }
```
(если `reject` возвращает не `void` — писать `reject(...); return;` вместо `return reject(...)`). В возвращаемом объекте:
```ts
    baseUrl: () => (url === null ? null : url.slice(0, -HOOK_PATH.length)),
    setAssistantToken: (token) => {
      assistantToken = token === null ? null : Buffer.from(token);
    },
```
(`url` — кэш строки из `listen()`; имя переменной взять из кода `url()`.)

---

### Задача 9: Запуск хода CLI

**Файлы:**
- Create: `packages/host/src/assistant/turn.ts`
- Create: `packages/host/test/stub-assistant.mjs`
- Test: `packages/host/src/assistant/turn.test.ts`

**Interfaces:**
- Consumes: `AssistantStreamEvent`, `classifyAssistantError`, `parseClaudeLine` из `@parley/core`.
- Produces: `type TurnEnd = { ok: true } | { ok: false; kind: 'limit' | 'resume' | 'timeout' | 'cancelled' | 'start' | 'other'; message: string }`, `interface TurnSpec { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string; parse(line: string): AssistantStreamEvent[]; timeoutMs: number }`, `interface TurnHandle { cancel(): void; readonly done: Promise<TurnEnd> }`, `runTurn(spec, onEvent, spawn?): TurnHandle`, `KILL_GRACE_MS = 2000`.

- [ ] **Шаг 1: Заглушка CLI** `packages/host/test/stub-assistant.mjs`:
```js
#!/usr/bin/env node
// Заглушка CLI помощника для тестов хода: печатает строки из STUB_LINES (JSON-массив) с паузой STUB_DELAY_MS,
// STUB_STDERR — в stderr, STUB_EXIT — код выхода, STUB_HANG=1 — не выходит, пока не убьют.
const lines = JSON.parse(process.env.STUB_LINES ?? '[]');
const delay = Number(process.env.STUB_DELAY_MS ?? '5');
for (const line of lines) {
  process.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
  await new Promise((resolve) => setTimeout(resolve, delay));
}
if (process.env.STUB_STDERR) process.stderr.write(process.env.STUB_STDERR);
if (process.env.STUB_HANG === '1') setInterval(() => {}, 1000);
else process.exit(Number(process.env.STUB_EXIT ?? '0'));
```

- [ ] **Шаг 2: Тест**

```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeLine, type AssistantStreamEvent } from '@parley/core';
import { runTurn, type TurnSpec } from './turn.js';

const STUB = path.resolve(import.meta.dirname, '../../test/stub-assistant.mjs');
function spec(env: Record<string, string>, timeoutMs = 5000): TurnSpec {
  return { command: process.execPath, args: [STUB], env: { ...process.env, ...env }, cwd: process.cwd(), parse: parseClaudeLine, timeoutMs };
}
const INIT = { type: 'system', subtype: 'init', session_id: 'sid-1' };
const DELTA = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const RESULT = { type: 'result', subtype: 'success', is_error: false, result: 'x' };

describe('runTurn', () => {
  it('события по порядку и успешный конец', async () => {
    const seen: AssistantStreamEvent[] = [];
    const handle = runTurn(spec({ STUB_LINES: JSON.stringify([INIT, DELTA('[[calm]] '), DELTA('Тихо.'), RESULT]) }), (event) => seen.push(event));
    await expect(handle.done).resolves.toEqual({ ok: true });
    expect(seen.map((event) => event.type)).toEqual(['session', 'text', 'text', 'done']);
  });
  it('конец без result — ошибка по stderr', async () => {
    const handle = runTurn(spec({ STUB_LINES: '[]', STUB_STDERR: 'Error: thread/resume: no rollout found', STUB_EXIT: '1' }), () => {});
    await expect(handle.done).resolves.toMatchObject({ ok: false, kind: 'resume' });
  });
  it('зависший CLI — timeout', async () => {
    const handle = runTurn(spec({ STUB_LINES: JSON.stringify([INIT]), STUB_HANG: '1' }, 300), () => {});
    await expect(handle.done).resolves.toMatchObject({ ok: false, kind: 'timeout' });
  });
  it('отмена — cancelled, события после неё не приходят', async () => {
    const seen: AssistantStreamEvent[] = [];
    const handle = runTurn(spec({ STUB_LINES: JSON.stringify([INIT, DELTA('a'), DELTA('b'), RESULT]), STUB_DELAY_MS: '200' }), (event) => seen.push(event));
    await new Promise((resolve) => setTimeout(resolve, 50));
    handle.cancel();
    await expect(handle.done).resolves.toMatchObject({ ok: false, kind: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(seen.length).toBeLessThanOrEqual(1);
  });
  it('бинаря нет — start', async () => {
    const handle = runTurn({ ...spec({}), command: '/nonexistent/claude' }, () => {});
    await expect(handle.done).resolves.toMatchObject({ ok: false, kind: 'start' });
  });
});
```

- [ ] **Шаг 3: Реализация**

```ts
/**
 * Один ход помощника (спека 2026-10-14, 6.3): процесс CLI без терминала, строки stdout — в события через разборщик
 * провайдера. Конец — событие `done`/`error`, таймаут, отмена или выход без итога (тогда причина — по stderr).
 * Codex после `turn.completed` живёт ещё ~5 с — после итога процесс гасится, не дожидаясь (приложение A.2).
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { classifyAssistantError, type AssistantStreamEvent } from '@parley/core';

export type TurnEnd =
  | { ok: true }
  | { ok: false; kind: 'limit' | 'resume' | 'timeout' | 'cancelled' | 'start' | 'other'; message: string };

export interface TurnSpec {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  parse(line: string): AssistantStreamEvent[];
  timeoutMs: number;
}

export interface TurnHandle {
  cancel(): void;
  readonly done: Promise<TurnEnd>;
}

export const KILL_GRACE_MS = 2000;
const STDERR_TAIL = 4000;

export function runTurn(spec: TurnSpec, onEvent: (event: AssistantStreamEvent) => void, spawn: typeof nodeSpawn = nodeSpawn): TurnHandle {
  let settle: (end: TurnEnd) => void = () => {};
  const done = new Promise<TurnEnd>((resolve) => {
    settle = resolve;
  });
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  let child: ChildProcess | undefined;
  let stdout = '';
  let stderr = '';

  const alive = (): boolean => child !== undefined && child.exitCode === null && child.signalCode === null;
  const finish = (end: TurnEnd): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (alive()) {
      child?.kill('SIGTERM');
      setTimeout(() => {
        if (alive()) child?.kill('SIGKILL');
      }, KILL_GRACE_MS).unref();
    }
    settle(end);
  };

  try {
    child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    finish({ ok: false, kind: 'start', message: (error as Error).message });
    return { cancel: () => {}, done };
  }
  timer = setTimeout(() => finish({ ok: false, kind: 'timeout', message: `no answer in ${Math.round(spec.timeoutMs / 1000)} s` }), spec.timeoutMs);

  const feed = (line: string): void => {
    for (const event of spec.parse(line)) {
      if (finished) return;
      onEvent(event);
      if (event.type === 'done') finish({ ok: true });
      else if (event.type === 'error') finish({ ok: false, kind: event.kind, message: event.message });
    }
  };

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    let newline = stdout.indexOf('\n');
    while (newline !== -1) {
      feed(stdout.slice(0, newline));
      stdout = stdout.slice(newline + 1);
      newline = stdout.indexOf('\n');
    }
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  child.on('error', (error) => finish({ ok: false, kind: 'start', message: error.message }));
  child.on('close', (code) => {
    if (stdout.trim() !== '') feed(stdout);
    stdout = '';
    const message = stderr.trim() === '' ? `the CLI exited with code ${code ?? -1}` : stderr.trim();
    finish({ ok: false, kind: classifyAssistantError(message), message });
  });

  return { cancel: () => finish({ ok: false, kind: 'cancelled', message: 'cancelled' }), done };
}
```

---

### Задача 10: `assistant-service`, методы и проводка хоста

**Файлы:**
- Create: `packages/host/src/assistant/sent-log.ts`, `packages/host/src/assistant/assistant-service.ts`, `packages/host/src/methods/assistant.ts`
- Modify: `packages/host/src/rooms/rooms-service.ts` (`sendHumanLetter` — второй параметр), `packages/host/src/methods/pty.ts` (`send?` в зависимостях), `packages/host/src/methods/index.ts` (`MethodDeps.send?`, `MethodDeps.assistant?`, регистрация), `packages/host/src/host.ts` (общий отправитель, сервис, `onAssistant`)
- Test: `packages/host/src/assistant/assistant-service.test.ts`, `packages/host/src/assistant/sent-log.test.ts`, дописать в `packages/host/src/methods/index.test.ts` и в тест `sendHumanLetter`

**Interfaces:**
- Consumes: всё из задач 1–9; `createSender` (`pty/send.ts`), `sendHumanLetter`, `providerLaunchEnv`, `findRunnerBinary`, `loadProviders`, `providerReadiness`, `providerReadinessError`, `readSecret`, `parleyHome`.
- Produces: `interface AssistantService { ask; cancel; decide; reset; state; sent; tool; stop }`, `createAssistantService(deps: AssistantServiceDeps): AssistantService`, `ASSISTANT_IDLE_MS`, `ASSISTANT_TURN_MS`, `createAssistantHandlers(service)`, `appendSent(home, ref, text, at)`, `readSent(home, ref)`; `sendHumanLetter(input, options?: { via?: MessageVia })`.

- [ ] **Шаг 1: Журнал отправленного — тест и код.** `sent-log.test.ts`:
```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendSent, readSent } from './sent-log.js';

const ref = { projectPath: '/p', workId: 'w', sessionId: 's' };
let home = '';
beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'parley-sent-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('sent.jsonl', () => {
  it('пишет и читает по сессии', async () => {
    await appendSent(home, ref, 'Тесты можно пропустить', '2026-10-15T10:00:00.000Z');
    await appendSent(home, { ...ref, sessionId: 'other' }, 'чужое', '2026-10-15T10:01:00.000Z');
    expect(await readSent(home, ref)).toEqual([{ text: 'Тесты можно пропустить', at: '2026-10-15T10:00:00.000Z' }]);
  });
  it('нет файла — пусто', async () => {
    expect(await readSent(home, ref)).toEqual([]);
  });
  it('держит не больше 500 записей', async () => {
    for (let index = 0; index < 620; index += 1) await appendSent(home, ref, `m${index}`, '2026-10-15T10:00:00.000Z');
    const lines = (await readFile(path.join(home, 'assistant', 'sent.jsonl'), 'utf8')).trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(600);
  });
});
```
`sent-log.ts`:
```ts
/**
 * Что помощник отправил агентам в Chat (спека 2026-10-14, 7.4): `<parleyHome>/assistant/sent.jsonl`, строка — `{ ref,
 * text, at }`. Окно по нему помечает такие сообщения в ленте Chat («You (via Jarvis)»).
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { refKey, type SessionRef } from '@parley/protocol';

const KEEP = 500;
const SLACK = 100;
const RETURN = 50;

const fileOf = (home: string): string => path.join(home, 'assistant', 'sent.jsonl');

export async function appendSent(home: string, ref: SessionRef, text: string, at: string): Promise<void> {
  const file = fileOf(home);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify({ ref, text, at })}\n`, { encoding: 'utf8', mode: 0o600 });
  const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim() !== '');
  if (lines.length > KEEP + SLACK) await writeFile(file, `${lines.slice(-KEEP).join('\n')}\n`, { mode: 0o600 });
}

export async function readSent(home: string, ref: SessionRef): Promise<Array<{ text: string; at: string }>> {
  let raw: string;
  try {
    raw = await readFile(fileOf(home), 'utf8');
  } catch {
    return [];
  }
  const key = refKey(ref);
  const items: Array<{ text: string; at: string }> = [];
  for (const line of raw.split('\n')) {
    try {
      const entry = JSON.parse(line) as { ref?: SessionRef; text?: unknown; at?: unknown };
      if (entry.ref !== undefined && refKey(entry.ref) === key && typeof entry.text === 'string' && typeof entry.at === 'string') {
        items.push({ text: entry.text, at: entry.at });
      }
    } catch {
      // битая строка — пропустить
    }
  }
  return items.slice(-RETURN);
}
```
(`refKey` — там же, где `SessionRef`; если он не экспортирован из `@parley/protocol`, импортировать из места, где его берут `pty/methods`.)

- [ ] **Шаг 2: `via` в `sendHumanLetter`.** Тест (в файле тестов комнат хоста, по образцу соседнего теста `rooms.send`): `sendHumanLetter(input, { via: 'assistant' })` кладёт в карту письмо с `via: 'assistant'`, без второго параметра — без поля. Код:
```ts
export async function sendHumanLetter(input: Params<'rooms.send'>, options: { via?: MessageVia } = {}): Promise<string> {
  // …как было; в обоих addMessage добавить:
  //   ...(options.via === undefined ? {} : { via: options.via }),
}
```

- [ ] **Шаг 3: Тест сервиса** `assistant-service.test.ts` — сервис с фейками; ход — фейковый `run`, который отдаёт события по команде теста:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantStreamEvent, ProviderEntry, WorkEntry, WorkMap } from '@parley/core';
import type { AssistantState } from '@parley/protocol';
import { createAssistantService, type AssistantServiceDeps } from './assistant-service.js';
import type { TurnEnd, TurnSpec } from './turn.js';

interface FakeTurn { spec: TurnSpec; emit(event: AssistantStreamEvent): void; end(result: TurnEnd): void; cancelled: boolean }

const CLAUDE = { id: 'claude', label: 'Claude', runner: { command: 'claude', mcpConfig: 'json-file', assistantArgs: ['-p', '{prompt}'], assistantResumeArgs: ['-p', '{prompt}', '--resume', '{providerSessionId}'] } } as unknown as ProviderEntry;
const MAP = {
  schemaVersion: 2,
  work: { id: 'w-1', title: 'Parley', goal: '', status: 'active' },
  sessions: [{ id: 's-03', label: 'S03 Ruslan', provider: 'claude', task: 'tests', summary: null, lifecycle: 'active' }],
  messages: [],
  rooms: [{ id: 'r-1', title: 'Auth', creator: 's-03', members: ['s-03'], createdAt: '', lead: null, proposal: null }],
} as unknown as WorkMap;

let home = '';
let turns: FakeTurn[] = [];
let states: AssistantState[] = [];
let deps: AssistantServiceDeps;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-assistant-'));
  turns = [];
  states = [];
  let token: string | null = null;
  deps = {
    broadcast: (_event, data) => { states.push(data as AssistantState); },
    works: { snapshot: () => ({ entries: [{ projectPath: '/p', map: MAP }] as WorkEntry[], branches: {} }) },
    activity: { get: () => ({ activity: { activity: 'working', waitingFor: null, exited: false }, metrics: null }) as never },
    send: vi.fn().mockResolvedValue({ inserted: true, submitted: true, reason: null }),
    sendLetter: vi.fn().mockResolvedValue('m-1'),
    endpoint: { baseUrl: () => 'http://127.0.0.1:9', setAssistantToken: (value) => { token = value; } },
    providers: async () => ({ claude: CLAUDE }),
    ready: async () => null,
    launchEnv: async () => ({}),
    binary: async (command) => `/bin/${command}`,
    home,
    log: () => {},
    run: (spec, onEvent) => {
      let settle: (end: TurnEnd) => void = () => {};
      const turn: FakeTurn = { spec, emit: onEvent, end: (end) => settle(end), cancelled: false };
      turns.push(turn);
      return { cancel: () => { turn.cancelled = true; settle({ ok: false, kind: 'cancelled', message: 'cancelled' }); }, done: new Promise((resolve) => { settle = resolve; }) };
    },
  };
  void token;
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const last = (): AssistantState => states.at(-1)!;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const ASK = { text: 'кто работает?', provider: null, model: null, language: 'ru' as const };

describe('assistant-service: ход', () => {
  it('думает → ответ с эмоцией → свободен', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    expect(last()).toMatchObject({ phase: 'thinking', question: 'кто работает?' });
    expect(turns[0]?.spec.command).toBe('/bin/claude');
    expect(turns[0]?.spec.args).toEqual(['-p', 'кто работает?']);
    turns[0]?.emit({ type: 'session', id: 'sid-1' });
    turns[0]?.emit({ type: 'tool', name: 'parley_overview', input: {} });
    expect(last()).toMatchObject({ phase: 'tool', detail: { tool: 'overview', target: null } });
    turns[0]?.emit({ type: 'text', delta: '[[jo' });
    turns[0]?.emit({ type: 'text', delta: 'y]] Работает S03.' });
    expect(last()).toMatchObject({ phase: 'answering', mood: 'joy', answer: 'Работает S03.' });
    turns[0]?.end({ ok: true });
    await flush();
    expect(last()).toMatchObject({ phase: 'idle', answer: 'Работает S03.' });
  });
  it('второй вопрос — --resume с id сессии', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    turns[0]?.emit({ type: 'session', id: 'sid-1' });
    turns[0]?.end({ ok: true });
    await flush();
    await service.ask({ ...ASK, text: 'а комната?' });
    expect(turns[1]?.spec.args).toEqual(['-p', 'а комната?', '--resume', 'sid-1']);
  });
  it('перебивание: старый ход после нового вопроса молчит', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    await service.ask({ ...ASK, text: 'новый' });
    expect(turns[0]?.cancelled).toBe(true);
    turns[0]?.emit({ type: 'text', delta: '[[calm]] старое' });
    expect(last().answer).not.toContain('старое');
    expect(last().question).toBe('новый');
  });
  it('провайдер не готов — offline с причиной, хода нет', async () => {
    const service = createAssistantService({ ...deps, ready: async () => 'Claude CLI is not installed' });
    await service.ask(ASK);
    expect(last()).toMatchObject({ phase: 'offline', error: 'Claude CLI is not installed' });
    expect(turns).toHaveLength(0);
  });
  it('бинаря нет — offline', async () => {
    const service = createAssistantService({ ...deps, binary: async () => { throw new Error('not found'); } });
    await service.ask(ASK);
    expect(last().phase).toBe('offline');
  });
  it('лимит — error с эмоцией error', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    turns[0]?.end({ ok: false, kind: 'limit', message: "You've hit your limit · resets 3pm" });
    await flush();
    expect(last()).toMatchObject({ phase: 'error', mood: 'error' });
    expect(last().error).toContain('limit');
  });
  it('устаревший --resume — один повтор в новом разговоре', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    turns[0]?.emit({ type: 'session', id: 'old' });
    turns[0]?.end({ ok: true });
    await flush();
    await service.ask({ ...ASK, text: 'дальше' });
    turns[1]?.end({ ok: false, kind: 'resume', message: 'No conversation found' });
    await flush();
    expect(turns).toHaveLength(3);
    expect(turns[2]?.spec.args).toEqual(['-p', 'дальше']);
  });
});

describe('assistant-service: инструменты и карточка', () => {
  async function withProposal() {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    const reply = await service.tool('propose_message', { target: 'Auth', text: 'Пропусти Safari', kind: 'decision' });
    expect(reply.status).toBe(200);
    return service;
  }
  it('overview без разговора — 409, с разговором — текст', async () => {
    const service = createAssistantService(deps);
    expect((await service.tool('parley_overview', {})).status).toBe(409);
    await service.ask(ASK);
    const reply = await service.tool('parley_overview', {});
    expect(reply).toMatchObject({ status: 200, body: { text: expect.stringContaining('Room "Auth"') } });
  });
  it('propose → карточка; send → письмо в комнату с via', async () => {
    const service = await withProposal();
    const proposal = last().proposal;
    expect(proposal).toMatchObject({ target: 'Auth', kind: 'decision', text: 'Пропусти Safari' });
    turns[0]?.end({ ok: true });
    await flush();
    expect(last().phase).toBe('awaiting-confirm');
    await expect(service.decide(proposal!.id, 'send')).resolves.toEqual({ applied: true, error: null });
    expect(deps.sendLetter).toHaveBeenCalledWith({ projectPath: '/p', workId: 'w-1', roomId: 'r-1', to: [], text: 'Пропусти Safari', kind: 'decision' });
    expect(last()).toMatchObject({ proposal: null, outcome: 'sent', phase: 'idle' });
  });
  it('исход карточки уходит модели служебной строкой', async () => {
    const service = await withProposal();
    turns[0]?.end({ ok: true });
    await flush();
    await service.decide(last().proposal!.id, 'cancel');
    await service.ask({ ...ASK, text: 'ладно' });
    expect(turns[1]?.spec.args[1]).toMatch(/^\[system: proposal p1 was cancelled\]\nладно$/);
  });
  it('send сессии, которая уже остановилась — карточка остаётся, причина в ответе', async () => {
    const service = createAssistantService({ ...deps, send: vi.fn().mockRejectedValue(new Error('session is not running')) });
    await service.ask(ASK);
    await service.tool('propose_message', { target: 'S03', text: 'Привет' });
    const id = last().proposal!.id;
    await expect(service.decide(id, 'send')).resolves.toEqual({ applied: false, error: 'session is not running' });
    expect(last().proposal?.id).toBe(id);
  });
  it('устаревшая карточка не применяется', async () => {
    const service = await withProposal();
    await expect(service.decide('p99', 'send')).resolves.toMatchObject({ applied: false });
    expect(deps.sendLetter).not.toHaveBeenCalled();
  });
  it('цель не найдена — 404 и карточки нет', async () => {
    const service = createAssistantService(deps);
    await service.ask(ASK);
    expect((await service.tool('propose_message', { target: 'Billing', text: 'x' })).status).toBe(404);
    expect(last().proposal).toBeNull();
  });
  it('reset снимает карточку и токен', async () => {
    const service = await withProposal();
    service.reset();
    expect(last()).toMatchObject({ proposal: null, phase: 'idle', question: null });
    expect((await service.tool('parley_overview', {})).status).toBe(409);
  });
  it('после тишины (idleMs) разговор забывается', async () => {
    const service = createAssistantService({ ...deps, idleMs: 50 });
    await service.ask(ASK);
    turns[0]?.emit({ type: 'session', id: 'sid-1' });
    turns[0]?.end({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await service.tool('parley_overview', {})).status).toBe(409);
  });
});
```

- [ ] **Шаг 4: Сервис** `assistant-service.ts`:

```ts
/**
 * Помощник на хосте (спека 2026-10-14, разделы 6–7): один разговор на приложение, ход — процесс CLI выбранного
 * провайдера, инструменты — через маршрут `/assistant/*` hook-сервера с токеном разговора, карточка подтверждения
 * и отправка от имени человека. Состояние для окна — событием `assistant.changed`.
 */

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ASSISTANT_DEFAULT_MODELS,
  ASSISTANT_PROVIDER_ORDER,
  assistantCodexMcp,
  assistantCommand,
  assistantMcpJson,
  assistantPrompt,
  codexInstructionsFile,
  parseClaudeLine,
  parseCodexLine,
  splitMood,
  type AssistantLanguage,
  type ProviderEntry,
} from '@parley/core';
import type { AssistantDetail, AssistantProposal, AssistantState, EventData, EventName, Params, SendResult, SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { FeedService } from '../feed/feed-service.js';
import type { AssistantReply } from '../hooks/hook-server.js';
import type { WorksService } from '../works/works-service.js';
import { detailText, overviewText, resolveTarget, targetsOf, type AssistantTarget, type OverviewSource } from './overview.js';
import { appendSent, readSent } from './sent-log.js';
import { runTurn, type TurnEnd, type TurnHandle, type TurnSpec } from './turn.js';

export const ASSISTANT_IDLE_MS = 15 * 60_000;
export const ASSISTANT_TURN_MS = 60_000;
const MAX_TEXT = 4000;

export interface AssistantServiceDeps {
  broadcast<E extends EventName>(event: E, data: EventData<E>): void;
  works: Pick<WorksService, 'snapshot'>;
  activity: Pick<ActivityService, 'get'>;
  feed?: Pick<FeedService, 'snapshot'>;
  /** Общий отправитель хоста (`createSender`) — тот же, что у `pty.send`. */
  send(params: { ref: SessionRef; text: string; submit: boolean }): Promise<SendResult>;
  /** `sendHumanLetter` с `via: 'assistant'`. */
  sendLetter(input: Params<'rooms.send'>): Promise<string>;
  endpoint: { baseUrl(): string | null; setAssistantToken(token: string | null): void };
  providers(): Promise<Record<string, ProviderEntry>>;
  /** `null` — провайдер готов; иначе причина по-английски. */
  ready(entry: ProviderEntry): Promise<string | null>;
  launchEnv(entry: ProviderEntry): Promise<NodeJS.ProcessEnv>;
  binary(command: string): Promise<string>;
  home: string;
  log(line: string): void;
  run?(spec: TurnSpec, onEvent: Parameters<typeof runTurn>[1]): TurnHandle;
  now?(): number;
  idleMs?: number;
  turnTimeoutMs?: number;
}

export interface AssistantService {
  ask(params: Params<'assistant.ask'>): Promise<void>;
  cancel(): void;
  decide(proposalId: string, decision: 'send' | 'cancel'): Promise<{ applied: boolean; error: string | null }>;
  reset(): void;
  state(): AssistantState;
  sent(ref: SessionRef): Promise<Array<{ text: string; at: string }>>;
  tool(name: string, args: unknown): Promise<AssistantReply>;
  stop(): void;
}

interface Conversation {
  provider: string;
  model: string | null;
  language: AssistantLanguage;
  token: string;
  sessionId: string | null;
  endAfterTurn: boolean;
}

interface Pending {
  view: AssistantProposal;
  target: AssistantTarget;
}

const EMPTY: AssistantState = { phase: 'idle', detail: null, question: null, answer: '', mood: 'calm', proposal: null, outcome: null, error: null, turn: 0 };

const firstLine = (text: string): string => text.split('\n')[0]?.trim() ?? '';
const stringArg = (input: Record<string, unknown>, key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '');

function detailOf(name: string, input: Record<string, unknown>, targets: readonly AssistantTarget[]): AssistantDetail {
  if (name === 'parley_overview') return { tool: 'overview', target: null };
  if (name === 'propose_message') return { tool: 'propose', target: null };
  if (name === 'parley_detail') {
    const found = resolveTarget(targets, stringArg(input, 'target'));
    return { tool: 'detail', target: 'target' in found ? found.target.name : null };
  }
  return { tool: 'other', target: null };
}

export function createAssistantService(deps: AssistantServiceDeps): AssistantService {
  const run = deps.run ?? runTurn;
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? ASSISTANT_IDLE_MS;
  const dir = path.join(deps.home, 'assistant');

  let state: AssistantState = { ...EMPTY };
  let conversation: Conversation | null = null;
  let turn: TurnHandle | null = null;
  let pending: Pending | null = null;
  let outcomeNote: string | null = null;
  let proposals = 0;
  let idleTimer: NodeJS.Timeout | null = null;

  const publish = (patch: Partial<AssistantState>): void => {
    state = { ...state, ...patch };
    deps.broadcast('assistant.changed', state);
  };
  const source = (): OverviewSource => ({ entries: deps.works.snapshot().entries, live: (ref) => deps.activity.get(ref) });
  const restPhase = (): AssistantState['phase'] => (pending === null ? 'idle' : 'awaiting-confirm');

  function endConversation(): void {
    conversation = null;
    deps.endpoint.setAssistantToken(null);
    outcomeNote = null;
    if (pending !== null) {
      pending = null;
      publish({ proposal: null, phase: turn === null ? 'idle' : state.phase });
    }
  }

  function touch(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (turn === null) endConversation();
    }, idleMs);
    idleTimer.unref?.();
  }

  async function pick(wanted: string | null): Promise<{ entry: ProviderEntry } | { offline: string }> {
    const registry = await deps.providers();
    let reason = 'No connected provider can run the assistant — open Settings';
    for (const id of wanted === null ? ASSISTANT_PROVIDER_ORDER : [wanted]) {
      const entry = registry[id];
      if (entry === undefined || entry.runner.assistantArgs === undefined) {
        if (wanted !== null) reason = `${entry?.label ?? id} can't run the assistant`;
        continue;
      }
      const problem = await deps.ready(entry);
      if (problem === null) return { entry };
      if (wanted !== null) reason = problem;
    }
    return { offline: reason };
  }

  async function ensure(entry: ProviderEntry, model: string | null, language: AssistantLanguage): Promise<Conversation> {
    if (conversation !== null && (conversation.provider !== entry.id || conversation.model !== model || conversation.language !== language)) {
      endConversation();
    }
    if (conversation === null) {
      conversation = { provider: entry.id, model, language, token: randomBytes(32).toString('hex'), sessionId: null, endAfterTurn: false };
      deps.endpoint.setAssistantToken(conversation.token);
    }
    return conversation;
  }

  async function files(current: Conversation, url: string): Promise<{ mcpFile: string; promptFile: string }> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const mcpFile = path.join(dir, 'mcp.json');
    const promptFile = path.join(dir, `prompt-${current.language}.md`);
    await writeFile(mcpFile, assistantMcpJson({ url, token: current.token }), { mode: 0o600 });
    await chmod(mcpFile, 0o600);
    await writeFile(promptFile, assistantPrompt(current.language), { mode: 0o600 });
    return { mcpFile, promptFile };
  }

  function stopTurn(): void {
    const old = turn;
    turn = null;
    old?.cancel();
  }

  async function start(entry: ProviderEntry, model: string | null, language: AssistantLanguage, text: string, retried: boolean): Promise<void> {
    const current = await ensure(entry, model, language);
    const next = state.turn + 1;
    const base = deps.endpoint.baseUrl();
    if (base === null) {
      publish({ ...EMPTY, proposal: state.proposal, phase: 'error', mood: 'error', question: text, error: 'Parley is still starting — try again', turn: next });
      return;
    }
    const url = `${base}/assistant`;
    const { mcpFile, promptFile } = await files(current, url);
    const codex = entry.runner.mcpConfig === 'codex-override';
    const prompt = outcomeNote === null ? text : `${outcomeNote}\n${text}`;
    outcomeNote = null;
    const command = assistantCommand(
      entry,
      {
        prompt,
        mcpConfig: codex ? assistantCodexMcp({ url, token: current.token }) : mcpFile,
        systemPrompt: assistantPrompt(language),
        developerInstructions: codexInstructionsFile(promptFile),
        ...(model === null ? {} : { model }),
        ...(current.sessionId === null ? {} : { providerSessionId: current.sessionId }),
      },
      current.sessionId !== null,
    );
    if (command === null) {
      publish({ ...EMPTY, proposal: state.proposal, phase: 'offline', question: text, error: `${entry.label} can't run the assistant`, turn: next });
      return;
    }
    let binary: string;
    try {
      binary = await deps.binary(command.command);
    } catch {
      publish({ ...EMPTY, proposal: state.proposal, phase: 'offline', question: text, error: `${entry.label} CLI is not installed`, turn: next });
      return;
    }
    const env = await deps.launchEnv(entry);
    publish({ phase: 'thinking', detail: null, question: text, answer: '', mood: 'calm', outcome: null, error: null, turn: next });

    // Эмоцию решает первый текст после последнего инструмента: GLM ставит метку до инструмента отдельным блоком.
    let moodBuffer: string | null = '';
    const handle: TurnHandle = run(
      { command: binary, args: command.args, env, cwd: dir, parse: codex ? parseCodexLine : parseClaudeLine, timeoutMs: deps.turnTimeoutMs ?? ASSISTANT_TURN_MS },
      (event) => {
        if (turn !== handle) return;
        if (event.type === 'session') {
          current.sessionId = event.id;
        } else if (event.type === 'tool') {
          moodBuffer = '';
          publish({ phase: 'tool', detail: detailOf(event.name, event.input, targetsOf(source())), answer: '' });
        } else if (event.type === 'text') {
          if (moodBuffer === null) {
            publish({ phase: 'answering', detail: null, answer: state.answer + event.delta });
            return;
          }
          moodBuffer += event.delta;
          const split = splitMood(moodBuffer, false);
          if (split === null) return;
          moodBuffer = null;
          publish({ phase: 'answering', detail: null, mood: split.mood, answer: split.text });
        }
      },
    );
    turn = handle;
    const end = await handle.done;
    if (turn !== handle) return;
    turn = null;
    if (moodBuffer !== null && moodBuffer !== '') {
      const split = splitMood(moodBuffer, true);
      if (split !== null) publish({ mood: split.mood, answer: split.text });
    }
    await finish(end, entry, model, language, text, retried, current);
  }

  async function finish(end: TurnEnd, entry: ProviderEntry, model: string | null, language: AssistantLanguage, text: string, retried: boolean, current: Conversation): Promise<void> {
    if (end.ok) {
      if (current.endAfterTurn) endConversation();
      else touch();
      publish({ phase: restPhase(), detail: null });
      return;
    }
    if (end.kind === 'cancelled') {
      publish({ phase: restPhase(), detail: null });
      return;
    }
    if (end.kind === 'resume' && !retried && current.sessionId !== null) {
      endConversation();
      await start(entry, model, language, text, true);
      return;
    }
    deps.log(`assistant: turn failed (${end.kind}): ${firstLine(end.message)}`);
    const error =
      end.kind === 'limit'
        ? `${entry.label} limit reached — ${firstLine(end.message)}`
        : end.kind === 'timeout'
          ? 'No answer in 60 s'
          : end.kind === 'start'
            ? `${entry.label} CLI didn't start`
            : 'Something went wrong — try again';
    publish({ phase: 'error', mood: 'error', detail: null, error });
  }

  async function lastReply(ref: SessionRef): Promise<string | null> {
    if (deps.feed === undefined) return null;
    try {
      const { items } = await deps.feed.snapshot(ref);
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item?.kind === 'text' && !item.streaming && item.text.trim() !== '') return item.text;
      }
    } catch {
      // ленты у сессии нет — без последнего ответа
    }
    return null;
  }

  function propose(input: Record<string, unknown>, targets: readonly AssistantTarget[]): AssistantReply {
    const text = stringArg(input, 'text').trim();
    if (text === '') return { status: 400, body: { error: 'text is empty' } };
    if (text.length > MAX_TEXT) return { status: 400, body: { error: `text is longer than ${MAX_TEXT} characters` } };
    const found = resolveTarget(targets, stringArg(input, 'target'));
    if ('error' in found) return { status: 404, body: { error: found.error } };
    const target = found.target;
    if (target.kind === 'session' && !target.running) return { status: 409, body: { error: `${target.name} is not running` } };
    const kind = input['kind'];
    proposals += 1;
    pending = {
      view: {
        id: `p${proposals}`,
        target: target.name,
        where: target.where,
        kind: target.kind === 'room' ? (kind === 'question' || kind === 'decision' ? kind : 'note') : null,
        text,
      },
      target,
    };
    publish({ proposal: pending.view, outcome: null });
    return { status: 200, body: { text: 'Shown to the person as a card; they will confirm or cancel it. Tell them in one short sentence what you prepared.' } };
  }

  function settle(current: Pending, outcome: 'sent' | 'cancelled'): { applied: true; error: null } {
    pending = null;
    outcomeNote = `[system: proposal ${current.view.id} was ${outcome}]`;
    touch();
    publish({ proposal: null, outcome, phase: turn === null ? 'idle' : state.phase });
    return { applied: true, error: null };
  }

  return {
    async ask(params) {
      stopTurn();
      try {
        const picked = await pick(params.provider);
        if ('offline' in picked) {
          publish({ ...EMPTY, proposal: state.proposal, phase: 'offline', question: params.text, error: picked.offline, turn: state.turn + 1 });
          return;
        }
        const model = params.model ?? ASSISTANT_DEFAULT_MODELS[picked.entry.id] ?? null;
        await start(picked.entry, model, params.language, params.text, false);
      } catch (error) {
        deps.log(`assistant: ask failed: ${(error as Error).message}`);
        publish({ phase: 'error', mood: 'error', detail: null, error: 'Something went wrong — try again' });
      }
    },
    cancel() {
      if (turn === null) return;
      stopTurn();
      publish({ phase: restPhase(), detail: null });
    },
    async decide(proposalId, decision) {
      const current = pending;
      if (current === null || current.view.id !== proposalId) return { applied: false, error: 'This card is no longer current' };
      if (decision === 'cancel') return settle(current, 'cancelled');
      try {
        if (current.target.kind === 'room') {
          const { projectPath, workId, roomId } = current.target;
          await deps.sendLetter({ projectPath, workId, roomId, to: [], text: current.view.text, kind: current.view.kind ?? 'note' });
        } else {
          const result = await deps.send({ ref: current.target.ref, text: current.view.text, submit: true });
          if (!result.inserted) return { applied: false, error: `${current.target.name} can't take a message now (${result.reason ?? 'busy'})` };
          await appendSent(deps.home, current.target.ref, current.view.text, new Date(now()).toISOString());
        }
      } catch (error) {
        return { applied: false, error: (error as Error).message };
      }
      return settle(current, 'sent');
    },
    reset() {
      stopTurn();
      endConversation();
      pending = null;
      publish({ ...EMPTY, turn: state.turn });
    },
    state: () => state,
    sent: (ref) => readSent(deps.home, ref),
    async tool(name, args) {
      const current = conversation;
      if (current === null) return { status: 409, body: { error: 'No assistant conversation is active' } };
      const input = typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
      const src = source();
      const targets = targetsOf(src);
      switch (name) {
        case 'parley_overview':
          return { status: 200, body: { text: overviewText(src) } };
        case 'parley_detail': {
          const found = resolveTarget(targets, stringArg(input, 'target'));
          if ('error' in found) return { status: 404, body: { error: found.error } };
          const reply = found.target.kind === 'session' ? await lastReply(found.target.ref) : null;
          return { status: 200, body: { text: detailText(src, found.target, reply) } };
        }
        case 'propose_message':
          return propose(input, targets);
        case 'end_conversation':
          current.endAfterTurn = true;
          return { status: 200, body: { text: 'The conversation starts over after this reply.' } };
        default:
          return { status: 404, body: { error: `unknown tool ${name}` } };
      }
    },
    stop() {
      stopTurn();
      if (idleTimer !== null) clearTimeout(idleTimer);
      deps.endpoint.setAssistantToken(null);
    },
  };
}
```
Если `EventData`/`EventName` экспортируются не из `@parley/protocol` — взять оттуда, где их берёт `host/src/context.ts`.

- [ ] **Шаг 5: Методы** `methods/assistant.ts`:
```ts
/** Методы помощника (спека 2026-10-14, 6.5): ход идёт в фоне, исход — событием `assistant.changed`. */

import type { AnyHandler, Handler } from '../context.js';
import type { AssistantService } from '../assistant/assistant-service.js';

export function createAssistantHandlers(service: AssistantService): Record<string, AnyHandler> {
  const ask: Handler<'assistant.ask'> = async (params) => {
    void service.ask(params);
    return { ok: true };
  };
  const cancel: Handler<'assistant.cancel'> = async () => {
    service.cancel();
    return { ok: true };
  };
  const decide: Handler<'assistant.decide'> = (params) => service.decide(params.proposalId, params.decision);
  const reset: Handler<'assistant.reset'> = async () => {
    service.reset();
    return { ok: true };
  };
  const state: Handler<'assistant.state'> = async () => service.state();
  const sent: Handler<'assistant.sent'> = async (params) => ({ items: await service.sent(params.ref) });
  return {
    'assistant.ask': ask as AnyHandler,
    'assistant.cancel': cancel as AnyHandler,
    'assistant.decide': decide as AnyHandler,
    'assistant.reset': reset as AnyHandler,
    'assistant.state': state as AnyHandler,
    'assistant.sent': sent as AnyHandler,
  };
}
```
В `methods/index.ts`: в `MethodDeps` — `assistant?: AssistantService;` и `send?: (params: { ref: SessionRef; text: string; submit: boolean }) => Promise<SendResult>;`; в `methods` — `...(deps.assistant === undefined ? {} : createAssistantHandlers(deps.assistant))`; `send` передать в `createPtyHandlers`. В `methods/pty.ts`: в `PtyMethodDeps` — `send?` того же типа; строку создания отправителя заменить на
```ts
  const send =
    deps.send ??
    createSender({
      ...deps,
      ...(sessions === undefined ? {} : { switching: (ref: SessionRef) => sessions.exclusive.held(ref) }),
    });
```
Тест в `methods/index.test.ts` (по образцу соседних): с `assistant` в `fakeDeps` у `createHostHandlers(deps).methods['assistant.ask']` — функция; без — `undefined`.

- [ ] **Шаг 6: Проводка в `host.ts`.** Перед `createHookServer`: `let assistantService: AssistantService | undefined;`; в опции хук-сервера:
```ts
    onAssistant: (tool, args) =>
      assistantService === undefined
        ? Promise.resolve({ status: 503, body: { error: 'the assistant is not ready' } })
        : assistantService.tool(tool, args),
```
После `wakeService` и `sessionsService`, до `createHostHandlers`:
```ts
  // Один отправитель на хост: окно (`pty.send`) и помощник делят «свой Enter в полёте» по сессии.
  const send = createSender({
    pty: ptyManager,
    activity: activityService,
    wake: wakeService,
    switching: (ref: SessionRef) => sessionsService.exclusive.held(ref),
  });
  const secretOf = (entry: ProviderEntry): Promise<string | null> =>
    entry.runner.secret === undefined ? Promise.resolve(null) : readSecret(entry.runner.secret);
  assistantService = createAssistantService({
    broadcast: (event, data) => handle.context.broadcast(event, data),
    works: worksService,
    activity: activityService,
    feed: feedService,
    send,
    sendLetter: (input) => sendHumanLetter(input, { via: 'assistant' }),
    endpoint: hookServer,
    providers: () => loadProviders(),
    ready: async (entry) => {
      await providerVersions.ready;
      const key = await secretOf(entry);
      const readiness = await providerReadiness(entry, { keyPresent: key !== null, probeVersion: (command) => providerVersions.fresh(command) });
      if (readiness.needs !== null || readiness.error !== null) return providerReadinessError(entry, readiness) ?? `${entry.label} is not ready`;
      const min = ASSISTANT_MIN_VERSIONS[entry.runner.command];
      const version = providerVersions.get(entry.runner.command);
      return min !== undefined && version !== null && !versionAtLeast(version, min)
        ? `Update the ${entry.label} CLI to ${min} or newer to use the assistant`
        : null;
    },
    launchEnv: async (entry) => providerLaunchEnv(entry, process.env, {}, await secretOf(entry)),
    binary: (command) => findRunnerBinary(command, process.env),
    home: parleyHome(),
    log: (line) => log(line),
  });
  handle.context.onShutdown(async () => assistantService?.stop());
```
и в вызов `createHostHandlers({ … })` — `send, assistant: assistantService`. Сигнатуры `readSecret`, `providerReadinessError` и имя логгера (`log`) сверить по коду; `hookServer` удовлетворяет `endpoint` после задачи 8.

- [ ] **Шаг 7: Прогон группы B** (контролёр, после проверки загрузки):
```bash
nice -n 10 pnpm --filter @parley/protocol test && nice -n 10 pnpm --filter @parley/host exec vitest run src/assistant src/hooks src/methods src/rooms && nice -n 10 pnpm typecheck && nice -n 10 pnpm build
```
Expected: зелёное. Коммит:
```bash
git add packages/protocol packages/host packages/core && git commit -m "feat(host): помощник — сервис хода, инструменты, карточка и отправка с via"
```

---

## Группа C — окно: настройки, хоткей, мост острова

### Задача 11: Настройки `ui.assistant`, глобальный хоткей, клавиатура и мост острова, палитра

**Файлы:**
- Create: `packages/desktop/src/shared/assistant-name.ts`, `packages/desktop/src/main/assistant/shortcut.ts`
- Modify: `packages/desktop/src/shared/ui-types.ts` (`AssistantUi`, `DEFAULT_UI`, `normalizeAssistant`), `packages/desktop/src/main/ui-store.ts` (`NESTED_KEYS`), `packages/desktop/src/shared/island.ts` (`IslandConfig`, `IslandApi`, белые списки), `packages/desktop/src/main/island/window.ts` (`setKeyboard`), `packages/desktop/src/main/island/ipc.ts` (`island:keyboard`), `packages/desktop/src/preload/island.ts`, `packages/desktop/src/main/index.ts`, `packages/desktop/src/main/ipc.ts` (`app:assistant-open`, `app:assistant-shortcut`), `packages/desktop/src/preload/index.ts`, `packages/desktop/src/shared/bridge.ts`, `packages/desktop/src/shared/keybindings.ts`, `packages/desktop/src/renderer/palette/actions.ts`, `packages/desktop/src/shared/strings.ts` (`S.actions.askAssistant`, `S.assistant`), `packages/desktop/src/renderer/test-utils/fake-bridge.ts`, фабрики `api()` в `IslandView.test.tsx` и `IslandApp.test.tsx`, `setup()` в `main/island/ipc.test.ts`, `FakeWindow` в `main/island/window.test.ts`
- Test: `packages/desktop/src/main/assistant/shortcut.test.ts`; дописать в `window.test.ts`, `ipc.test.ts` (острова), тест `normalizeUi`

**Interfaces:**
- Consumes: `AssistantLanguage` из `@parley/core/assistant`; `VoiceApi`, `VoiceModelId` из `shared/voice-types.ts`.
- Produces: `ASSISTANT_NAME`; `AssistantUi { enabled; provider: string | null; model: string | null; hotkey: string; language: AssistantLanguage | null }`; `IslandAssistantConfig { enabled; provider; model; language: AssistantLanguage; hotkey: string; voice: { enabled: boolean; model: VoiceModelId | null } }`; `IslandConfig.islandEnabled`, `IslandConfig.assistant`; `AssistantOpenRequest { listen: boolean }`; `IslandApi.keyboard(on)`, `IslandApi.onAssistantOpen(listener)`, `IslandApi.voice`; `createAssistantShortcut(deps)` → `{ sync(enabled, accelerator): AssistantShortcutStatus; status(): AssistantShortcutStatus }`; `IslandController.setKeyboard(on)`; `window.parley.app.openAssistant()`, `window.parley.app.assistantShortcut(): Promise<AssistantShortcutStatus>`; `ActionId 'assistant.open'`.

- [ ] **Шаг 1: Имя и строки.** `shared/assistant-name.ts`:
```ts
/**
 * Видимое имя помощника (спека 2026-10-14, раздел 15): рабочее — до выбора своего имени перед выпуском. В коде,
 * протоколе и данных помощник — `assistant`; переименование — эта строка.
 */
export const ASSISTANT_NAME = 'Jarvis';
```
В `strings.ts` (импорт `ASSISTANT_NAME`): в `S.actions` — `askAssistant: \`Ask ${ASSISTANT_NAME}\``; в `S.participants` — `viaAssistant: (name: string): string => \`${name} (via ${ASSISTANT_NAME})\``; в `S.chat` — `viaAssistant: \`via ${ASSISTANT_NAME}\``; в `S.settings.sections` — `assistant: 'Assistant'`; новый блок:
```ts
  assistant: {
    ask: `Ask ${ASSISTANT_NAME}`,
    placeholder: `Ask ${ASSISTANT_NAME}…`,
    ready: 'Ask about your agents, or tell a room something',
    escToClose: 'Esc to close',
    hotkeyToTalk: (keys: string): string => `${keys} to talk`,
    mic: 'Talk',
    stopMic: 'Stop listening',
    listening: 'Listening…',
    transcribing: 'Recognizing…',
    thinking: 'Thinking…',
    checking: 'Checking rooms…',
    reading: (name: string | null): string => (name === null ? 'Reading…' : `Reading ${name}…`),
    preparing: 'Preparing a message…',
    working: 'Working…',
    answering: 'Answering',
    confirm: 'Waiting for your confirmation',
    miniListening: 'Listening·',
    miniThinking: 'Thinking·',
    miniWorking: 'Working·',
    miniConfirm: 'Confirm send',
    to: 'To',
    send: 'Send',
    cancel: 'Cancel',
    enterToSend: 'Enter to send',
    sent: 'Sent ✓',
    cancelled: 'Cancelled',
    needsYou: (name: string, total: number): string => `${name} needs you · 1 of ${total}`,
    voiceOff: 'Voice is off — Settings → Voice',
    micDenied: 'Microphone access is off — System Settings → Privacy & Security',
    noSpeech: "Didn't catch that — try again",
    voiceFailed: "Couldn't recognize speech — type instead",
    newConversation: 'New conversation',
    settings: {
      enabled: `Turn on ${ASSISTANT_NAME}`,
      enabledHint: "Answers about your agents and passes your messages on. Runs on the selected provider's subscription.",
      provider: 'Provider',
      providerAuto: 'First connected',
      model: 'Model',
      modelDefault: 'Fast default',
      language: 'Language',
      languageSystem: 'System',
      languageEnglish: 'English',
      languageRussian: 'Russian',
      shortcut: 'Shortcut',
      shortcutHint: 'Works from any app. Electron format, e.g. Alt+Space.',
      shortcutTaken: 'This shortcut is taken by another app — choose another.',
      glmSlow: 'GLM answers in about 13 seconds.',
    },
  },
```

- [ ] **Шаг 2: Тесты main.** `main/assistant/shortcut.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { createAssistantShortcut } from './shortcut.js';

function registry(taken: string[] = []) {
  return { register: vi.fn((accelerator: string) => !taken.includes(accelerator)), unregister: vi.fn() };
}

describe('глобальный хоткей помощника', () => {
  it('включён — регистрирует; выключен — снимает', () => {
    const fake = registry();
    const shortcut = createAssistantShortcut({ registry: fake, onTrigger: vi.fn(), log: vi.fn() });
    expect(shortcut.sync(true, 'Alt+Space')).toEqual({ accelerator: 'Alt+Space', ok: true });
    expect(fake.register).toHaveBeenCalledTimes(1);
    shortcut.sync(true, 'Alt+Space');
    expect(fake.register).toHaveBeenCalledTimes(1);
    expect(shortcut.sync(false, 'Alt+Space')).toEqual({ accelerator: null, ok: true });
    expect(fake.unregister).toHaveBeenCalledWith('Alt+Space');
  });
  it('смена сочетания — снять старое, взять новое', () => {
    const fake = registry();
    const shortcut = createAssistantShortcut({ registry: fake, onTrigger: vi.fn(), log: vi.fn() });
    shortcut.sync(true, 'Alt+Space');
    shortcut.sync(true, 'Control+Alt+J');
    expect(fake.unregister).toHaveBeenCalledWith('Alt+Space');
    expect(fake.register).toHaveBeenLastCalledWith('Control+Alt+J', expect.any(Function));
  });
  it('занято — ok: false, и снимать нечего', () => {
    const fake = registry(['Alt+Space']);
    const shortcut = createAssistantShortcut({ registry: fake, onTrigger: vi.fn(), log: vi.fn() });
    expect(shortcut.sync(true, 'Alt+Space')).toEqual({ accelerator: 'Alt+Space', ok: false });
    shortcut.sync(false, 'Alt+Space');
    expect(fake.unregister).not.toHaveBeenCalled();
  });
  it('битое сочетание — ok: false, без исключения', () => {
    const fake = { register: vi.fn(() => { throw new Error('bad accelerator'); }), unregister: vi.fn() };
    const shortcut = createAssistantShortcut({ registry: fake, onTrigger: vi.fn(), log: vi.fn() });
    expect(shortcut.sync(true, 'Hyper+Q')).toEqual({ accelerator: 'Hyper+Q', ok: false });
  });
  it('нажатие зовёт onTrigger', () => {
    const fake = registry();
    const onTrigger = vi.fn();
    createAssistantShortcut({ registry: fake, onTrigger, log: vi.fn() }).sync(true, 'Alt+Space');
    (fake.register.mock.calls[0]?.[1] as () => void)();
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });
});
```
В `window.test.ts` (у `FakeWindow` добавить `setFocusable`, `focus` как шпионов): `setKeyboard(true)` → `setFocusable(true)` и `focus()`; `setKeyboard(false)` у видимого окна → `setFocusable(false)`, затем `hide()` и `showInactive()`; у скрытого — только `setFocusable(false)`. В `ipc.test.ts` острова: `island:keyboard` с `true` от острова зовёт `options.keyboard(true)`, от чужого отправителя и с не-boolean — нет.

- [ ] **Шаг 3: Хоткей** `main/assistant/shortcut.ts`:
```ts
/**
 * Глобальное сочетание помощника (спека 2026-10-14, 8.1) — первое в Parley: работает из любого приложения.
 * `register` возвращает `false`, если сочетание держит другое приложение; тогда помощник доступен кликом и палитрой.
 */

export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface AssistantShortcutStatus {
  /** Сочетание, которое помощник хочет держать; `null` — помощник выключен. */
  accelerator: string | null;
  ok: boolean;
}

export function createAssistantShortcut(deps: { registry: ShortcutRegistry; onTrigger(): void; log(line: string): void }): {
  sync(enabled: boolean, accelerator: string): AssistantShortcutStatus;
  status(): AssistantShortcutStatus;
} {
  let current: string | null = null;
  let ok = true;
  return {
    sync(enabled, accelerator) {
      const wanted = enabled ? accelerator : null;
      if (wanted === current && (wanted === null || ok)) return { accelerator: current, ok };
      if (current !== null && ok) deps.registry.unregister(current);
      current = wanted;
      ok = true;
      if (wanted !== null) {
        try {
          ok = deps.registry.register(wanted, deps.onTrigger);
        } catch (error) {
          ok = false;
          deps.log(`assistant: bad shortcut ${wanted}: ${(error as Error).message}`);
        }
        if (!ok) deps.log(`assistant: shortcut ${wanted} is not available`);
      }
      return { accelerator: current, ok };
    },
    status: () => ({ accelerator: current, ok }),
  };
}
```

- [ ] **Шаг 4: Настройки в `ui.json`.** `ui-types.ts`:
```ts
/** Помощник на острове (спека 2026-10-14, 6.1). Выключен по умолчанию: тратит лимит провайдера. */
export interface AssistantUi {
  enabled: boolean;
  /** `null` — первый готовый: Claude, GLM, Codex. */
  provider: string | null;
  /** `null` — быстрая модель провайдера по умолчанию. */
  model: string | null;
  /** Глобальное сочетание в формате Electron accelerator. */
  hotkey: string;
  /** `null` — язык системы. */
  language: AssistantLanguage | null;
}
```
`UiFile.assistant: AssistantUi`; `DEFAULT_UI.assistant = { enabled: false, provider: null, model: null, hotkey: 'Alt+Space', language: null }`; в `normalizeUi` — `assistant: normalizeAssistant(source.assistant)`:
```ts
function normalizeAssistant(value: unknown): AssistantUi {
  const source = isRecord(value) ? value : {};
  const fallback = DEFAULT_UI.assistant;
  const text = (item: unknown): string | null => (typeof item === 'string' && item.trim() !== '' ? item : null);
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    provider: text(source.provider),
    model: text(source.model),
    hotkey: text(source.hotkey) ?? fallback.hotkey,
    language: source.language === 'en' || source.language === 'ru' ? source.language : null,
  };
}
```
`ui-store.ts`: `'assistant'` в `NESTED_KEYS`. Тест `normalizeUi` (по образцу `island`): нет ключа — умолчание; мусор — умолчание; `language: 'de'` — `null`.

- [ ] **Шаг 5: Мост острова.** `shared/island.ts`:
```ts
export interface IslandAssistantConfig {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  /** Уже разрешённый язык (`null` из настроек → язык системы). */
  language: AssistantLanguage;
  /** Сочетание из настроек — для подсказки «⌥Space to talk». */
  hotkey: string;
  /** Голосовой ввод из настроек Voice: без модели помощник слушать не может. */
  voice: { enabled: boolean; model: VoiceModelId | null };
}
export interface AssistantOpenRequest {
  /** Хоткей — сразу слушать; палитра и клик — печать. */
  listen: boolean;
}
```
В `IslandConfig` — `islandEnabled: boolean;` (остров выключен, а помощник включён — окно показывается только в режиме помощника) и `assistant: IslandAssistantConfig;`. В `IslandApi`:
```ts
  /** Режим помощника: панель берёт клавиатуру (`true`) или отдаёт её прежнему приложению (`false`). */
  keyboard(on: boolean): void;
  /** Хоткей или палитра открыли помощника. */
  onAssistantOpen(listener: (request: AssistantOpenRequest) => void): () => void;
  /** Голос для помощника — те же каналы `voice:*`, что у окна. */
  voice: Pick<VoiceApi, 'transcribe' | 'micStatus' | 'requestMic'>;
```
`ISLAND_METHODS` — добавить `'assistant.ask'`, `'assistant.cancel'`, `'assistant.decide'`, `'assistant.reset'`, `'assistant.state'`; `ISLAND_EVENTS` — `'assistant.changed'`. Фабрики `api()` в тестах острова — добавить `keyboard: vi.fn()`, `onAssistantOpen: vi.fn(() => () => {})`, `voice: { transcribe: vi.fn(), micStatus: vi.fn(), requestMic: vi.fn() }`.

`preload/island.ts` (в объект `island`, по образцу соседних подписок на `Set`):
```ts
      keyboard: (on) => ipcRenderer.send('island:keyboard', on),
      onAssistantOpen: (listener) => subscribe(assistantOpenListeners, listener), // по образцу onConfig/onHover
      voice: {
        transcribe: (request) => ipcRenderer.invoke('voice:transcribe', request) as Promise<TranscribeResult>,
        micStatus: () => ipcRenderer.invoke('voice:mic-status') as Promise<MicStatus>,
        requestMic: () => ipcRenderer.invoke('voice:request-mic') as Promise<boolean>,
      },
```
и `ipcRenderer.on('island:assistant-open', (_event, request) => { for (const listener of assistantOpenListeners) listener(request as AssistantOpenRequest); })`.

`main/island/window.ts`: в `IslandWindowLike` — `setFocusable(focusable: boolean): void; focus(): void;`; в `IslandController` — `setKeyboard(on: boolean): void;`; реализация в `createIslandController`:
```ts
    setKeyboard(on) {
      const current = window; // переменная окна контроллера
      if (current === null || current.isDestroyed()) return;
      if (on) {
        current.setFocusable(true);
        current.focus();
        return;
      }
      current.setFocusable(false);
      // Снять с панели ключевое окно: иначе печать в других приложениях шла бы в никуда. Проба 2026-10-15: hide и
      // showInactive возвращают ввод прежнему приложению, не трогая передний план.
      if (current.isVisible()) {
        current.hide();
        current.showInactive();
        current.setIgnoreMouseEvents(!hovered, { forward: false });
      }
    },
```
`main/island/ipc.ts`: в `IslandIpcOptions` — `keyboard(on: boolean): void;` и
```ts
  ipcMain.on('island:keyboard', (event, on: unknown) => {
    if (fromIsland(event) && typeof on === 'boolean') options.keyboard(on);
  });
```

- [ ] **Шаг 6: Main.** В `main/index.ts` (импорты `globalShortcut` из `electron`, `createAssistantShortcut`):
```ts
  const assistantShortcut = createAssistantShortcut({
    registry: globalShortcut,
    onTrigger: () => openAssistant({ listen: true }),
    log: (line) => log(line), // логгер main, как у соседей
  });
  function openAssistant(request: AssistantOpenRequest): void {
    const window = island.current();
    if (window === null || window.isDestroyed()) return;
    window.webContents.send('island:assistant-open', request);
  }
  const assistantLanguage = (current: UiFile): AssistantLanguage =>
    current.assistant.language ?? (app.getLocale().toLowerCase().startsWith('ru') ? 'ru' : 'en');
```
`islandConfig()` дополнить:
```ts
      islandEnabled: current.island.enabled,
      assistant: {
        enabled: current.assistant.enabled,
        provider: current.assistant.provider,
        model: current.assistant.model,
        language: assistantLanguage(current),
        hotkey: current.assistant.hotkey,
        voice: { enabled: current.voice.enabled, model: current.voice.model },
      },
```
`syncIsland(current)`: окно острова нужно, если включён остров **или** помощник:
```ts
    if ((current.island.enabled || current.assistant.enabled) && !switches.islandOff) island.open();
    else island.close();
    assistantShortcut.sync(current.assistant.enabled && !switches.islandOff, current.assistant.hotkey);
    pushIslandConfig();
```
`registerIslandIpc({ …, keyboard: (on) => island.setKeyboard(on) })`; `app.on('will-quit', () => globalShortcut.unregisterAll())`. В `registerIpc` — опции `openAssistant: () => openAssistant({ listen: false })` и `assistantShortcut: () => assistantShortcut.status()`; в `main/ipc.ts`:
```ts
  ipcMain.on('app:assistant-open', () => options.openAssistant?.());
  ipcMain.handle('app:assistant-shortcut', () => options.assistantShortcut?.() ?? { accelerator: null, ok: true });
```
`preload/index.ts` (в `app`): `openAssistant: () => ipcRenderer.send('app:assistant-open')`, `assistantShortcut: () => ipcRenderer.invoke('app:assistant-shortcut') as Promise<AssistantShortcutStatus>`; типы — в `shared/bridge.ts`; в `fake-bridge.ts` — `openAssistant: vi.fn()`, `assistantShortcut: vi.fn().mockResolvedValue({ accelerator: null, ok: true })`. Тип `AssistantShortcutStatus` перенести в `shared/` (например в `shared/island.ts`), чтобы его видели preload и renderer.

- [ ] **Шаг 7: Палитра.** `keybindings.ts`: `'assistant.open'` в `ActionId`; в `ACTIONS`:
```ts
  { id: 'assistant.open', title: S.actions.askAssistant, keywords: ['assistant', 'jarvis', 'ask', 'voice'], keys: null, menu: null, when: 'always', inPalette: true },
```
`palette/actions.ts` в `runAction`:
```ts
    case 'assistant.open':
      ctx.bridge.app.openAssistant();
      return;
```
Тест палитры (по образцу `voice.toggle`): действие зовёт `bridge.app.openAssistant`.

---

### Задача 12: Раздел Settings → Assistant

**Файлы:**
- Create: `packages/desktop/src/renderer/components/settings/AssistantSettings.tsx`
- Modify: `packages/desktop/src/renderer/store/ui.ts` (`SettingsSection` + `'assistant'`), `packages/desktop/src/renderer/components/settings/SettingsDialog.tsx` (`SECTION_LABELS`, `SECTION_ORDER`, `TabsContent`)
- Test: `packages/desktop/src/renderer/components/settings/AssistantSettings.test.tsx`

**Interfaces:**
- Consumes: `useUiStore` (`ui.assistant`, `patchUi`), `providers.list`, `window.parley.app.assistantShortcut()`.
- Produces: раздел настроек «Assistant».

- [ ] **Шаг 1: Тест** (по образцу тестов `VoiceSettings`; мост — `createFakeBridge()`):
- переключатель «Turn on Jarvis» зовёт `patchUi({ assistant: { enabled: true } })`;
- список провайдеров — только `available: true`, первым пункт «First connected» (`provider: null`);
- выбор провайдера сбрасывает модель (`patchUi({ assistant: { provider: 'codex', model: null } })`);
- список моделей — из `models` выбранного провайдера, первым «Fast default»;
- язык — `System` / `English` / `Russian` → `null` / `'en'` / `'ru'`;
- `assistantShortcut()` с `ok: false` показывает `S.assistant.settings.shortcutTaken`;
- у GLM видна подсказка `glmSlow`.

- [ ] **Шаг 2: Компонент** — по образцу `VoiceSettings.tsx` (тот же способ получить мост, те же `Switch`, `Select`, `ToggleGroup`, `Input`, локальные строки-поля):
```tsx
/**
 * Settings → Assistant (спека 2026-10-14, 6.1): включение, провайдер и модель из подключённых, язык, глобальное
 * сочетание. Всё — в `ui.json` (`patchUi`); main по сохранению перерегистрирует хоткей и шлёт острову конфиг.
 */
export function AssistantSettings(): JSX.Element {
  const assistant = useUiStore((state) => state.ui.assistant);
  const patchUi = useUiStore((state) => state.patchUi);
  const bridge = /* как в VoiceSettings */;
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [shortcut, setShortcut] = useState<AssistantShortcutStatus | null>(null);
  const [hotkey, setHotkey] = useState(assistant.hotkey);

  useEffect(() => {
    let alive = true;
    void bridge.call('providers.list', {}).then((result) => {
      if (alive) setProviders(result.providers.filter((provider) => provider.available));
    });
    return () => { alive = false; };
  }, [bridge]);
  useEffect(() => {
    void bridge.app.assistantShortcut().then(setShortcut);
  }, [bridge, assistant.enabled, assistant.hotkey]);

  const patch = (next: Partial<AssistantUi>): void =>
    patchUi({ assistant: next } as unknown as Partial<Omit<UiFile, 'version' | 'activeWorkKey'>>);
  const selected = providers.find((provider) => provider.id === assistant.provider) ?? null;
  // …разметка: Switch enabled + enabledHint; Select provider (`__auto` → null) с подсказкой glmSlow для 'glm';
  // Select model (`__default` → null; пункты selected?.models ?? []); ToggleGroup language;
  // Input hotkey (onBlur → patch({ hotkey }) при непустом значении) и строка shortcutTaken при shortcut?.ok === false.
}
```
`ProviderRow` — тип элемента `Result<'providers.list'>['providers']`. Разметку строк — как у соседних полей Settings.

- [ ] **Шаг 3: Прогон группы C** (контролёр, после проверки загрузки):
```bash
cd packages/desktop && nice -n 10 pnpm vitest run src/main src/shared src/renderer/components/settings src/renderer/palette src/english-ui.test.ts && nice -n 10 pnpm typecheck
```
Expected: зелёное. Коммит:
```bash
git add packages/desktop && git commit -m "feat(desktop): помощник — настройки, глобальный хоткей, клавиатура и мост острова"
```

---

## Группа D — остров в режиме помощника

### Задача 13: Стор помощника и голосовой ввод острова

**Файлы:**
- Create: `packages/desktop/src/renderer/island/assistant/listen.ts`, `packages/desktop/src/renderer/island/assistant/store.ts`
- Test: `packages/desktop/src/renderer/island/assistant/listen.test.ts`, `packages/desktop/src/renderer/island/assistant/store.test.ts`

**Interfaces:**
- Consumes: `startRecording`, `Recording` (`renderer/voice/recorder.ts`), `browserRecorderDeps` (`renderer/voice/browser-recorder.ts`), `TranscribeRequest`, `TranscribeResult`, `MicStatus`, `VoiceModelId` (`shared/voice-types.ts`), `matchConfirm` (`@parley/core/assistant`), `AssistantState` (`@parley/protocol`), `IslandAssistantConfig`, `AssistantOpenRequest` (задача 11).
- Produces: `SPEECH_LEVEL`, `SILENCE_MS`, `NO_SPEECH_MS`, `MAX_LISTEN_MS`, `silenceGate(now)`, `type ListenResult`, `interface ListenDeps`, `interface Listening`, `listen(deps): Listening`; `HOST_IDLE`, `type InputPhase`, `assistantBusy(state)`, `interface AssistantDeps`, `useAssistantStore` (zustand) с полями `host, open, collapsed, byHover, input, level, draft, notice, cardError, openedTurn` и действиями `configure, applyHost, openMode, close, collapse, expand, setDraft, submit, toggleListening, decide, reset`.

- [ ] **Шаг 1: Тесты.** `listen.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { listen, silenceGate, SILENCE_MS, NO_SPEECH_MS, type ListenDeps } from './listen.js';

describe('silenceGate', () => {
  it('стоп после SILENCE_MS тишины, когда речь уже была', () => {
    let t = 0;
    const gate = silenceGate(() => t);
    expect(gate(0.3)).toBe(false);
    t = 500;
    expect(gate(0.001)).toBe(false);
    t = 500 + SILENCE_MS;
    expect(gate(0.001)).toBe(true);
  });
  it('без речи — стоп через NO_SPEECH_MS', () => {
    let t = 0;
    const gate = silenceGate(() => t);
    t = NO_SPEECH_MS - 1;
    expect(gate(0)).toBe(false);
    t = NO_SPEECH_MS;
    expect(gate(0)).toBe(true);
  });
});

function deps(over: Partial<ListenDeps> = {}): ListenDeps {
  const recording = { stop: vi.fn().mockResolvedValue({ pcm: new ArrayBuffer(4), durationMs: 900, peak: 0.4 }), cancel: vi.fn() };
  return {
    record: vi.fn().mockResolvedValue(recording),
    transcribe: vi.fn().mockResolvedValue({ text: ' Кто работает? ' }),
    micStatus: vi.fn().mockResolvedValue('granted'),
    requestMic: vi.fn().mockResolvedValue(true),
    now: () => 0,
    model: 'small',
    language: 'ru',
    onLevel: vi.fn(),
    onTranscribing: vi.fn(),
    ...over,
  } as ListenDeps;
}

describe('listen', () => {
  it('стоп → распознавание → текст', async () => {
    const session = listen(deps());
    await Promise.resolve();
    session.stop();
    await expect(session.result).resolves.toEqual({ text: 'Кто работает?' });
  });
  it('нет доступа к микрофону — mic', async () => {
    const session = listen(deps({ micStatus: vi.fn().mockResolvedValue('denied') }));
    await expect(session.result).resolves.toEqual({ error: 'mic' });
  });
  it('отмена — cancelled, без распознавания', async () => {
    const d = deps();
    const session = listen(d);
    session.cancel();
    await expect(session.result).resolves.toEqual({ error: 'cancelled' });
    expect(d.transcribe).not.toHaveBeenCalled();
  });
  it('пустой текст — no_speech', async () => {
    const session = listen(deps({ transcribe: vi.fn().mockResolvedValue({ text: '  ' }) }));
    session.stop();
    await expect(session.result).resolves.toEqual({ error: 'no_speech' });
  });
});
```
`store.test.ts` (стор — фабрика, чтобы тесты не делили состояние; экспорт `createAssistantStore()` и `useAssistantStore = createAssistantStore()`):
```ts
import { describe, expect, it, vi } from 'vitest';
import { createAssistantStore, HOST_IDLE, type AssistantDeps } from './store.js';

const CONFIG = { enabled: true, provider: null, model: null, language: 'ru' as const, hotkey: 'Alt+Space', voice: { enabled: true, model: 'small' as const } };
function setup(over: Partial<AssistantDeps> = {}) {
  const store = createAssistantStore();
  const deps: AssistantDeps = {
    call: vi.fn().mockResolvedValue({ ok: true, applied: true, error: null }),
    keyboard: vi.fn(),
    config: () => CONFIG,
    listen: vi.fn(() => null),
    ...over,
  };
  store.getState().configure(deps);
  return { store, deps };
}

describe('стор помощника', () => {
  it('openMode берёт клавиатуру; close отдаёт и отменяет ход', async () => {
    const { store, deps } = setup();
    store.getState().openMode({ listen: false });
    expect(store.getState().open).toBe(true);
    expect(deps.keyboard).toHaveBeenLastCalledWith(true);
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', turn: 1 });
    store.getState().close();
    expect(store.getState().open).toBe(false);
    expect(deps.keyboard).toHaveBeenLastCalledWith(false);
    expect(deps.call).toHaveBeenCalledWith('assistant.cancel', {});
  });
  it('submit — вопрос с настройками провайдера и языка', async () => {
    const { store, deps } = setup();
    await store.getState().submit('  кто работает?  ');
    expect(deps.call).toHaveBeenCalledWith('assistant.ask', { text: 'кто работает?', provider: null, model: null, language: 'ru' });
  });
  it('«да» при карточке — решение, а не вопрос', async () => {
    const { store, deps } = setup();
    store.getState().applyHost({ ...HOST_IDLE, phase: 'awaiting-confirm', proposal: { id: 'p1', target: 'Auth', where: 'Parley · x', kind: 'note', text: 't' }, turn: 1 });
    await store.getState().submit('Да, отправляй');
    expect(deps.call).toHaveBeenCalledWith('assistant.decide', { proposalId: 'p1', decision: 'send' });
    expect(deps.call).not.toHaveBeenCalledWith('assistant.ask', expect.anything());
  });
  it('ответ раскрывает свёрнутый вид', () => {
    const { store } = setup();
    store.getState().openMode({ listen: false });
    store.getState().collapse();
    store.getState().applyHost({ ...HOST_IDLE, phase: 'answering', answer: 'a', turn: 1 });
    expect(store.getState().collapsed).toBe(false);
  });
  it('голос выключен — подсказка, а не запись', () => {
    const { store } = setup();
    store.getState().openMode({ listen: true });
    expect(store.getState().input).toBe('idle');
    expect(store.getState().notice).toBe('Voice is off — Settings → Voice');
  });
  it('ошибка решения карточки — на карточке', async () => {
    const { store } = setup({ call: vi.fn().mockResolvedValue({ applied: false, error: 'S03 is not running' }) });
    store.getState().applyHost({ ...HOST_IDLE, proposal: { id: 'p1', target: 'S03', where: 'w', kind: null, text: 't' }, phase: 'awaiting-confirm', turn: 1 });
    await store.getState().decide('send');
    expect(store.getState().cardError).toBe('S03 is not running');
  });
});
```

- [ ] **Шаг 2: `listen.ts`**
```ts
/**
 * Голосовой ввод помощника на острове (спека 2026-10-14, 8.4): запись тем же рекордером, что диктовка окна, конец —
 * 1,2 с тишины после речи (или повторный хоткей), затем локальный Whisper с подсказкой языка помощника.
 */

import type { MicStatus, TranscribeRequest, TranscribeResult, VoiceModelId } from '../../../shared/voice-types.js';
import type { Recording } from '../../voice/recorder.js';

/** Громкость кадра (RMS), выше которой — речь. */
export const SPEECH_LEVEL = 0.02;
export const SILENCE_MS = 1200;
/** Так и не заговорили — перестать слушать. */
export const NO_SPEECH_MS = 8000;
export const MAX_LISTEN_MS = 60_000;

/** Возвращает функцию «пора остановиться?» для каждого кадра громкости. */
export function silenceGate(now: () => number): (level: number) => boolean {
  const started = now();
  let heard = false;
  let quietSince: number | null = null;
  return (level) => {
    const at = now();
    if (at - started >= MAX_LISTEN_MS) return true;
    if (level >= SPEECH_LEVEL) {
      heard = true;
      quietSince = null;
      return false;
    }
    if (!heard) return at - started >= NO_SPEECH_MS;
    quietSince ??= at;
    return at - quietSince >= SILENCE_MS;
  };
}

export type ListenResult = { text: string } | { error: 'mic' | 'no_speech' | 'voice' | 'cancelled' };

export interface ListenDeps {
  record(onLevel: (level: number) => void): Promise<Recording>;
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
  micStatus(): Promise<MicStatus>;
  requestMic(): Promise<boolean>;
  now(): number;
  model: VoiceModelId;
  language: string;
  onLevel(level: number): void;
  onTranscribing(): void;
}

export interface Listening {
  stop(): void;
  cancel(): void;
  readonly result: Promise<ListenResult>;
}

export function listen(deps: ListenDeps): Listening {
  let stopRequested = false;
  let cancelled = false;
  let wake: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const stop = (): void => {
    stopRequested = true;
    wake();
  };
  const result = (async (): Promise<ListenResult> => {
    const status = await deps.micStatus();
    const allowed = status === 'granted' || (status === 'not-determined' && (await deps.requestMic()));
    if (!allowed) return { error: 'mic' };
    if (cancelled) return { error: 'cancelled' };
    const gate = silenceGate(deps.now);
    let recording: Recording;
    try {
      recording = await deps.record((level) => {
        deps.onLevel(level);
        if (gate(level)) stop();
      });
    } catch {
      return { error: 'mic' };
    }
    if (!stopRequested) await stopped;
    if (cancelled) {
      recording.cancel();
      return { error: 'cancelled' };
    }
    const audio = await recording.stop();
    deps.onTranscribing();
    const answer = await deps.transcribe({ pcm: audio.pcm, language: deps.language, model: deps.model });
    if ('text' in answer) return answer.text.trim() === '' ? { error: 'no_speech' } : { text: answer.text.trim() };
    return { error: answer.error === 'no_speech' ? 'no_speech' : 'voice' };
  })();
  return {
    stop,
    cancel: () => {
      cancelled = true;
      stop();
    },
    result,
  };
}
```

- [ ] **Шаг 3: `store.ts`**
```ts
/**
 * Состояние помощника на острове (спека 2026-10-14, раздел 8): зеркало `assistant.changed` хоста и своё — открыт ли
 * режим, свёрнут ли он в мини-вид, идёт ли запись. Действия ходят в хост через белый список острова.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { matchConfirm } from '@parley/core/assistant';
import type { AssistantState } from '@parley/protocol';
import type { IslandAssistantConfig, IslandBridge } from '../../../shared/island.js';
import { S } from '../../../shared/strings.js';
import type { Listening } from './listen.js';

export type InputPhase = 'idle' | 'listening' | 'transcribing';

export const HOST_IDLE: AssistantState = { phase: 'idle', detail: null, question: null, answer: '', mood: 'calm', proposal: null, outcome: null, error: null, turn: 0 };

const TURN_PHASES: ReadonlySet<AssistantState['phase']> = new Set(['thinking', 'tool', 'answering']);
const BUSY_PHASES: ReadonlySet<AssistantState['phase']> = new Set(['thinking', 'tool', 'answering', 'awaiting-confirm']);

export function assistantBusy(state: { host: AssistantState; input: InputPhase }): boolean {
  return state.input !== 'idle' || BUSY_PHASES.has(state.host.phase);
}

export interface AssistantDeps {
  call: IslandBridge['call'];
  keyboard(on: boolean): void;
  config(): IslandAssistantConfig;
  /** `null` — голос выключен или модель Whisper не скачана. */
  listen(hooks: { onLevel(level: number): void; onTranscribing(): void }): Listening | null;
}

export interface AssistantStoreState {
  host: AssistantState;
  open: boolean;
  collapsed: boolean;
  /** Раскрыт наведением — уход курсора сворачивает обратно. */
  byHover: boolean;
  input: InputPhase;
  level: number;
  draft: string;
  notice: string | null;
  cardError: string | null;
  /** Номер хода на момент открытия: ответ после него — повод свернуться через 8 с. */
  openedTurn: number;
  configure(deps: AssistantDeps): void;
  applyHost(state: AssistantState): void;
  openMode(request: { listen: boolean }): void;
  close(): void;
  collapse(): void;
  expand(byHover: boolean): void;
  setDraft(text: string): void;
  submit(text: string): Promise<void>;
  toggleListening(): void;
  decide(decision: 'send' | 'cancel'): Promise<void>;
  reset(): Promise<void>;
}

export function createAssistantStore(): UseBoundStore<StoreApi<AssistantStoreState>> {
  let deps: AssistantDeps | null = null;
  let listening: Listening | null = null;
  return create<AssistantStoreState>((set, get) => {
    const stopTurn = (): void => {
      if (TURN_PHASES.has(get().host.phase)) void deps?.call('assistant.cancel', {});
    };
    const startListening = (): void => {
      if (deps === null) return;
      const session = deps.listen({
        onLevel: (level) => set({ level }),
        onTranscribing: () => set({ input: 'transcribing', level: 0 }),
      });
      if (session === null) {
        set({ notice: S.assistant.voiceOff });
        return;
      }
      listening = session;
      set({ input: 'listening', notice: null });
      void session.result.then((result) => {
        if (listening === session) listening = null;
        set({ input: 'idle', level: 0 });
        if ('text' in result) void get().submit(result.text);
        else if (result.error === 'mic') set({ notice: S.assistant.micDenied });
        else if (result.error === 'no_speech') set({ notice: S.assistant.noSpeech });
        else if (result.error === 'voice') set({ notice: S.assistant.voiceFailed });
      });
    };
    return {
      host: HOST_IDLE,
      open: false,
      collapsed: false,
      byHover: false,
      input: 'idle',
      level: 0,
      draft: '',
      notice: null,
      cardError: null,
      openedTurn: 0,
      configure: (next) => {
        deps = next;
      },
      applyHost: (host) => {
        const state = get();
        const reveal = host.phase === 'answering' && state.open && state.collapsed;
        set({ host, ...(reveal ? { collapsed: false, byHover: false } : {}), ...(host.proposal === null ? { cardError: null } : {}) });
      },
      openMode: (request) => {
        const state = get();
        if (state.open && state.input === 'listening') {
          listening?.stop();
          return;
        }
        set({ open: true, collapsed: false, byHover: false, notice: null, openedTurn: state.open ? state.openedTurn : state.host.turn });
        deps?.keyboard(true);
        if (request.listen) {
          stopTurn();
          startListening();
        }
      },
      close: () => {
        listening?.cancel();
        listening = null;
        stopTurn();
        set({ open: false, collapsed: false, byHover: false, input: 'idle', level: 0, notice: null });
        deps?.keyboard(false);
      },
      collapse: () => {
        set({ collapsed: true, byHover: false });
        deps?.keyboard(false);
      },
      expand: (byHover) => set({ collapsed: false, byHover }),
      setDraft: (draft) => set({ draft }),
      submit: async (raw) => {
        const text = raw.trim();
        if (text === '' || deps === null) return;
        set({ draft: '', notice: null });
        const { proposal } = get().host;
        const answer = proposal === null ? null : matchConfirm(text);
        if (answer !== null) {
          await get().decide(answer);
          return;
        }
        const config = deps.config();
        await deps.call('assistant.ask', { text, provider: config.provider, model: config.model, language: config.language });
      },
      toggleListening: () => {
        if (get().input === 'listening') listening?.stop();
        else if (get().input === 'idle') {
          stopTurn();
          startListening();
        }
      },
      decide: async (decision) => {
        const proposal = get().host.proposal;
        if (proposal === null || deps === null) return;
        const result = await deps.call('assistant.decide', { proposalId: proposal.id, decision });
        set({ cardError: result.error });
      },
      reset: async () => {
        await deps?.call('assistant.reset', {});
      },
    };
  });
}

export const useAssistantStore = createAssistantStore();
```

---

### Задача 14: Вид помощника на острове и проводка

**Файлы:**
- Create: `packages/desktop/src/renderer/components/AssistantMark.tsx`, `packages/desktop/src/renderer/island/assistant/AssistantView.tsx`, `packages/desktop/src/renderer/island/assistant/labels.ts`
- Modify: `packages/desktop/src/renderer/island/IslandView.tsx` (проп `assistant`, ветка большого вида, мини-вид в `Pill`), `packages/desktop/src/renderer/island/IslandApp.tsx` (привязка стора, видимость, удержание, Esc, наведение, стрелка), `packages/desktop/src/renderer/island/island.css` (`assistant-pulse`)
- Test: `packages/desktop/src/renderer/island/assistant/labels.test.ts`, `packages/desktop/src/renderer/island/assistant/AssistantView.test.tsx`, дописать в `IslandView.test.tsx`, `IslandApp.test.tsx`

**Interfaces:**
- Consumes: стор и `assistantBusy` (задача 13), `IslandApi` (задача 11), `S.assistant` (задача 11).
- Produces: `AssistantMark({ size?, busy? })` (общий для острова, комнаты и Chat), `statusLabel(host, input): string`, `miniLabel(host, input): string | null`, `hotkeyLabel(accelerator): string`, `AssistantView(props)`, проп `IslandViewProps.assistant: IslandAssistantProps | null`, `ANSWER_HOLD_MS = 8000`.

- [ ] **Шаг 1: Тесты.** `labels.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { HOST_IDLE } from './store.js';
import { hotkeyLabel, miniLabel, statusLabel } from './labels.js';

describe('подписи помощника', () => {
  it('состояние хода → подпись', () => {
    expect(statusLabel({ ...HOST_IDLE, phase: 'thinking' }, 'idle')).toBe('Thinking…');
    expect(statusLabel({ ...HOST_IDLE, phase: 'tool', detail: { tool: 'overview', target: null } }, 'idle')).toBe('Checking rooms…');
    expect(statusLabel({ ...HOST_IDLE, phase: 'tool', detail: { tool: 'detail', target: 'Auth' } }, 'idle')).toBe('Reading Auth…');
    expect(statusLabel({ ...HOST_IDLE, phase: 'awaiting-confirm' }, 'idle')).toBe('Waiting for your confirmation');
    expect(statusLabel({ ...HOST_IDLE, phase: 'offline', error: 'Claude is not connected — open Settings' }, 'idle')).toBe('Claude is not connected — open Settings');
    expect(statusLabel(HOST_IDLE, 'listening')).toBe('Listening…');
  });
  it('мини-вид: подпись только пока занят', () => {
    expect(miniLabel({ ...HOST_IDLE, phase: 'thinking' }, 'idle')).toBe('Thinking·');
    expect(miniLabel({ ...HOST_IDLE, phase: 'answering' }, 'idle')).toBe('Working·');
    expect(miniLabel({ ...HOST_IDLE, phase: 'awaiting-confirm' }, 'idle')).toBe('Confirm send');
    expect(miniLabel(HOST_IDLE, 'idle')).toBeNull();
  });
  it('сочетание — значками macOS', () => {
    expect(hotkeyLabel('Alt+Space')).toBe('⌥Space');
    expect(hotkeyLabel('CmdOrCtrl+Shift+J')).toBe('⌘⇧J');
    expect(hotkeyLabel('Control+Alt+K')).toBe('⌃⌥K');
  });
});
```
`AssistantView.test.tsx` (`render`, `screen`, `fireEvent`):
- ответ и вопрос видны (`assistant-answer`), подпись — из `statusLabel`;
- карточка: `To`, имя адресата, текст; **Send** выключена первые 500 мс (`vi.useFakeTimers`, `advanceTimersByTime(500)`), потом зовёт `onDecide('send')`; Enter в пустом поле при карточке — тоже `onDecide('send')`;
- Enter в поле с текстом зовёт `onSubmit(текст)`;
- `cardError` показывается на карточке;
- строка ожидающих запросов (`assistant-pending`) по клику зовёт `onShowRequests`.

В `IslandView.test.tsx`: при `assistant.open && !assistant.collapsed` — виден `assistant-view`, пилюли нет; при `collapsed && busy` — пилюля с `assistant-mini` и подписью `miniLabel`; при включённом помощнике в пилюле есть `assistant-dot`, клик — `onOpen`. В `IslandApp.test.tsx`: событие `onAssistantOpen({ listen: false })` показывает вид помощника и зовёт `api.keyboard(true)`; Esc закрывает и зовёт `api.keyboard(false)`; остров с `islandEnabled: false` вызывает `setVisible(false)`, а после `onAssistantOpen` — `setVisible(true)`.

- [ ] **Шаг 2: `AssistantMark.tsx`**
```tsx
/**
 * Знак помощника (спека 2026-10-14): тёплое светящееся пятно — мини-рой без отдельных душ. На этапе 1 — и облик
 * помощника на острове; в комнате и Chat — значок письма, отправленного через помощника.
 */
export function AssistantMark({ size = 16, busy = false }: { size?: number; busy?: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      data-assistant-mark=""
      className={`inline-block shrink-0 rounded-full ${busy ? 'assistant-pulse' : ''}`}
      style={{
        width: size,
        height: size,
        background: 'radial-gradient(circle, #F0DDA5 0%, #EFB05C 36%, rgba(239, 176, 92, 0.35) 58%, rgba(239, 176, 92, 0) 72%)',
      }}
    />
  );
}
```
`island.css`:
```css
/* Пятно помощника «дышит», пока он занят (спека 2026-10-14, этап 1 — вместо роя). */
@keyframes assistant-pulse {
  0%, 100% { transform: scale(1); opacity: 0.85; }
  50% { transform: scale(1.12); opacity: 1; }
}
.assistant-pulse { animation: assistant-pulse 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .assistant-pulse { animation: none; }
}
```

- [ ] **Шаг 3: `labels.ts`**
```ts
import type { AssistantState } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import type { InputPhase } from './store.js';

export function statusLabel(host: AssistantState, input: InputPhase): string {
  if (input === 'listening') return S.assistant.listening;
  if (input === 'transcribing') return S.assistant.transcribing;
  switch (host.phase) {
    case 'thinking':
      return S.assistant.thinking;
    case 'tool':
      if (host.detail?.tool === 'overview') return S.assistant.checking;
      if (host.detail?.tool === 'detail') return S.assistant.reading(host.detail.target);
      if (host.detail?.tool === 'propose') return S.assistant.preparing;
      return S.assistant.working;
    case 'answering':
      return S.assistant.answering;
    case 'awaiting-confirm':
      return S.assistant.confirm;
    case 'error':
    case 'offline':
      return host.error ?? S.assistant.working;
    default:
      return S.assistant.ready;
  }
}

export function miniLabel(host: AssistantState, input: InputPhase): string | null {
  if (input !== 'idle') return S.assistant.miniListening;
  switch (host.phase) {
    case 'thinking':
      return S.assistant.miniThinking;
    case 'tool':
    case 'answering':
      return S.assistant.miniWorking;
    case 'awaiting-confirm':
      return S.assistant.miniConfirm;
    default:
      return null;
  }
}

const KEY_MARKS: ReadonlyArray<[RegExp, string]> = [
  [/^(CmdOrCtrl|CommandOrControl|Command|Cmd|Meta|Super)$/i, '⌘'],
  [/^(Control|Ctrl)$/i, '⌃'],
  [/^(Alt|Option)$/i, '⌥'],
  [/^Shift$/i, '⇧'],
];

export function hotkeyLabel(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => KEY_MARKS.find(([pattern]) => pattern.test(part))?.[1] ?? part)
    .join('');
}
```

- [ ] **Шаг 4: `AssistantView.tsx`** — по эталону макета (большой вид):
```tsx
/**
 * Большой вид помощника на острове (спека 2026-10-14, 8.2; эталон — island-mockup.html): знак, подпись состояния,
 * последний вопрос и ответ, карточка подтверждения, строка ввода.
 */

import { useEffect, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import type { AssistantState } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { AssistantMark } from '../../components/AssistantMark.js';
import { Button } from '../../ui/button.js';
import { hotkeyLabel, statusLabel } from './labels.js';
import { assistantBusy, type InputPhase } from './store.js';

export interface AssistantViewProps {
  host: AssistantState;
  input: InputPhase;
  draft: string;
  notice: string | null;
  cardError: string | null;
  hotkey: string;
  /** Ждущие запросы одобрения: первая сессия и сколько всего. */
  pending: { name: string; total: number } | null;
  onDraft(text: string): void;
  onSubmit(text: string): void;
  onMic(): void;
  onDecide(decision: 'send' | 'cancel'): void;
  onShowRequests(): void;
}

/** Как `CARD_ARM_MS` острова: кнопки карточки взводятся не сразу — случайный клик у края экрана не отправит. */
const ARM_MS = 500;

function useArmed(key: string | null): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    if (key === null) return;
    const timer = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(timer);
  }, [key]);
  return armed;
}

export function AssistantView(props: AssistantViewProps): JSX.Element {
  const { host, input, draft, pending } = props;
  const proposal = host.proposal;
  const armed = useArmed(proposal?.id ?? null);
  const busy = assistantBusy({ host, input });
  const submit = (): void => {
    if (draft.trim() === '' && proposal !== null && armed) props.onDecide('send');
    else props.onSubmit(draft);
  };
  return (
    <div data-testid="assistant-view" className="island-reveal flex w-[420px] flex-col gap-2 px-3 pb-3 pt-1.5 text-sm">
      {pending === null ? null : (
        <button type="button" data-testid="assistant-pending" className="flex cursor-pointer items-center gap-2 self-start rounded px-1 text-[13px] text-foreground/80 hover:bg-white/10" onClick={props.onShowRequests}>
          <span className="size-[7px] rounded-full bg-[var(--color-accent)]" />
          {S.assistant.needsYou(pending.name, pending.total)}
        </button>
      )}
      <div className="flex justify-center py-1">
        <AssistantMark size={88} busy={busy} />
      </div>
      <div data-testid="assistant-status" className="text-center text-[13px] text-muted-foreground">
        {statusLabel(host, input)}
      </div>
      {host.question === null ? null : <div className="text-[13px] text-muted-foreground">{host.question}</div>}
      {host.answer === '' ? null : (
        <div data-testid="assistant-answer" className="whitespace-pre-wrap">
          {host.answer}
        </div>
      )}
      {host.outcome === 'sent' ? <div data-testid="assistant-sent" className="text-[13px] text-[var(--color-accent)]">{S.assistant.sent}</div> : null}
      {host.outcome === 'cancelled' ? <div className="text-[13px] text-muted-foreground">{S.assistant.cancelled}</div> : null}
      {proposal === null ? null : (
        <div data-testid="assistant-card" className="flex flex-col gap-2 rounded-md bg-white/5 p-2.5">
          <div className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
            <AssistantMark size={12} />
            <span className="min-w-0 truncate">
              {S.assistant.to} <span className="font-semibold text-foreground">{proposal.target}</span> · {proposal.where}
            </span>
          </div>
          <div className="whitespace-pre-wrap border-l-2 border-[var(--color-accent)] pl-2">{proposal.text}</div>
          {props.cardError === null ? null : <div className="text-[13px] text-[var(--status-warning-text)]">{props.cardError}</div>}
          <div className="flex items-center gap-2">
            <Button data-testid="assistant-send" size="default" className="cursor-pointer text-sm" disabled={!armed} onClick={() => props.onDecide('send')}>
              {S.assistant.send}
            </Button>
            <Button data-testid="assistant-cancel" size="default" variant="outline" className="cursor-pointer text-sm" onClick={() => props.onDecide('cancel')}>
              {S.assistant.cancel}
            </Button>
            <span className="ml-auto text-[12px] text-muted-foreground">{S.assistant.enterToSend}</span>
          </div>
        </div>
      )}
      {props.notice === null ? null : <div className="text-[13px] text-muted-foreground">{props.notice}</div>}
      <form
        className="flex items-center gap-2 rounded-md bg-white/5 px-2 py-1"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          data-testid="assistant-input"
          autoFocus
          value={draft}
          placeholder={S.assistant.placeholder}
          className="min-w-0 flex-1 bg-transparent py-1 outline-none placeholder:text-muted-foreground"
          onChange={(event) => props.onDraft(event.target.value)}
        />
        <button type="button" data-testid="assistant-mic" aria-label={input === 'listening' ? S.assistant.stopMic : S.assistant.mic} className="cursor-pointer text-muted-foreground hover:text-foreground" onClick={props.onMic}>
          {input === 'listening' ? <MicOff size={16} className="text-[var(--color-accent)]" /> : <Mic size={16} />}
        </button>
      </form>
      <div className="flex justify-between text-[12px] text-muted-foreground">
        <span>{S.assistant.escToClose}</span>
        <span>{S.assistant.hotkeyToTalk(hotkeyLabel(props.hotkey))}</span>
      </div>
    </div>
  );
}
```
`hotkey` в виде — `config.assistant.hotkey` (задача 11).

- [ ] **Шаг 5: `IslandView`.** Новые пропы:
```ts
export interface IslandAssistantProps {
  view: AssistantViewProps;
  open: boolean;
  collapsed: boolean;
  busy: boolean;
  mini: string | null;
  onOpen(): void;
}
// в IslandViewProps:
  /** Помощник (спека 2026-10-14, раздел 8); `null` — выключен в настройках. */
  assistant: IslandAssistantProps | null;
```
Ветка содержимого:
```tsx
const assistantBig = assistant !== null && assistant.open && !assistant.collapsed;
// …
{assistantBig ? (
  <AssistantView {...assistant.view} />
) : items.length > 0 ? (
  <Card /* как было */ />
) : (
  <>
    <Pill {...props} />
    {listOpen && model.groups.length > 0 ? <List /* как было */ /> : null}
  </>
)}
```
В `Pill` первым ребёнком:
```tsx
      {props.assistant === null ? null : (
        <button type="button" data-testid="assistant-dot" aria-label={S.assistant.ask} className="flex cursor-pointer items-center" onClick={props.assistant.onOpen}>
          <AssistantMark size={18} busy={props.assistant.busy} />
        </button>
      )}
      {props.assistant?.collapsed === true && props.assistant.mini !== null ? (
        <span data-testid="assistant-mini">{props.assistant.mini}</span>
      ) : /* прежние счётчики или idle — как было */}
```

- [ ] **Шаг 6: `IslandApp`.** Константа `ANSWER_HOLD_MS = 8000`; в `INITIAL_CONFIG` — `islandEnabled: true` и `assistant: { enabled: false, provider: null, model: null, language: 'en', hotkey: 'Alt+Space', voice: { enabled: false, model: null } }`. Проводка (рядом с привязкой других сторов, при `connected`):
```ts
  const configRef = useRef(config);
  configRef.current = config;
  const assistant = useAssistantStore();
  const busy = assistantBusy(assistant);

  useEffect(() => {
    if (!connected) return;
    useAssistantStore.getState().configure({
      call: bridge.call,
      keyboard: (on) => bridge.island.keyboard(on),
      config: () => configRef.current.assistant,
      listen: (hooks) => {
        const settings = configRef.current.assistant;
        if (!settings.voice.enabled || settings.voice.model === null) return null;
        return listen({
          record: (onLevel) => startRecording(onLevel, browserRecorderDeps()),
          transcribe: (request) => bridge.island.voice.transcribe(request),
          micStatus: () => bridge.island.voice.micStatus(),
          requestMic: () => bridge.island.voice.requestMic(),
          now: Date.now,
          model: settings.voice.model,
          language: settings.language,
          ...hooks,
        });
      },
    });
    void bridge.call('assistant.state', {}).then((state) => useAssistantStore.getState().applyHost(state)).catch(() => {});
    const off = bridge.on('assistant.changed', (state) => useAssistantStore.getState().applyHost(state));
    const offOpen = bridge.island.onAssistantOpen((request) => useAssistantStore.getState().openMode(request));
    return () => {
      off();
      offOpen();
    };
  }, [connected, bridge]);
```
Видимость окна:
```ts
  useEffect(
    () => bridge.island.setVisible(connected && (config.islandEnabled || assistant.open || busy)),
    [connected, bridge, config.islandEnabled, assistant.open, busy],
  );
```
`idle` дополнить: `&& !assistant.open && !busy`. Наведение (в слушателе `onHover`): `if (over && assistant.open && assistant.collapsed) store.expand(true); if (!over && store.byHover) store.collapse();` — через `useAssistantStore.getState()`. Удержание после ответа:
```ts
  useEffect(() => {
    const s = assistant;
    if (!s.open || s.collapsed || hovered || busy || s.draft !== '' || s.host.proposal !== null || s.host.turn <= s.openedTurn) return;
    const timer = setTimeout(() => useAssistantStore.getState().close(), ANSWER_HOLD_MS);
    return () => clearTimeout(timer);
  }, [assistant, hovered, busy]);
```
Esc:
```ts
  useEffect(() => {
    if (!assistant.open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') useAssistantStore.getState().close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [assistant.open]);
```
Стрелка ⌃ и смахивание (`onHide`): `if (assistant.open) { if (busy) store.collapse(); else store.close(); return; } retract();`. Проп `assistant` для `IslandView`:
```ts
  const assistantProps: IslandAssistantProps | null = !config.assistant.enabled
    ? null
    : {
        open: assistant.open,
        collapsed: assistant.collapsed,
        busy,
        mini: miniLabel(assistant.host, assistant.input),
        onOpen: () => useAssistantStore.getState().openMode({ listen: false }),
        view: {
          host: assistant.host,
          input: assistant.input,
          draft: assistant.draft,
          notice: assistant.notice,
          cardError: assistant.cardError,
          hotkey: config.assistant.hotkey,
          pending: items.length === 0 ? null : { name: labels.get(sessionKeyOf(items[0]!))?.session ?? '', total: items.length },
          onDraft: (text) => useAssistantStore.getState().setDraft(text),
          onSubmit: (text) => void useAssistantStore.getState().submit(text),
          onMic: () => useAssistantStore.getState().toggleListening(),
          onDecide: (decision) => void useAssistantStore.getState().decide(decision),
          onShowRequests: () => useAssistantStore.getState().close(),
        },
      };
```
(`sessionKeyOf` сейчас в `IslandView.tsx` — экспортировать его оттуда или посчитать имя так же, как карточка.)

- [ ] **Шаг 7: Прогон группы D** (контролёр, после проверки загрузки):
```bash
cd packages/desktop && nice -n 10 pnpm vitest run src/renderer/island src/english-ui.test.ts && nice -n 10 pnpm typecheck && nice -n 10 pnpm build
```
Expected: зелёное. Коммит:
```bash
git add packages/desktop && git commit -m "feat(desktop): помощник на острове — вид, мини-вид, голос и карточка подтверждения"
```

---

## Группа E — пометка «via», E2E, документы

### Задача 15: «You (via Jarvis)» в комнате и в Chat

**Файлы:**
- Create: `packages/desktop/src/renderer/chat/assistant-sent.ts`
- Modify: `packages/desktop/src/renderer/components/rooms/feed-model.ts` (`MessageModel.via`, подпись), `packages/desktop/src/renderer/components/rooms/SenderAvatar.tsx` (знак помощника), `packages/desktop/src/renderer/components/rooms/RoomMessage.tsx` (проп `via`), `packages/desktop/src/renderer/chat/items/PromptItem.tsx` (проп `via`), место, где `FeedList` рисует `PromptItem`, и `ChatView.tsx` (загрузка списка)
- Test: `packages/desktop/src/renderer/chat/assistant-sent.test.ts`; дописать в тесты `feed-model`, `RoomMessage`, `PromptItem`

**Interfaces:**
- Consumes: `Message.via` (задача 5), метод `assistant.sent` (задачи 6, 10), `normalizeSentText` (задача 1), `AssistantMark` (задача 14), `S.participants.viaAssistant`, `S.chat.viaAssistant` (задача 11).
- Produces: `MessageModel.via: 'assistant' | null`; `SenderAvatar` с `via`; `viaAssistantIds(items, sent): Set<string>`, `useAssistantSent(bridge, ref, supported)`; `PromptItem({ …, via?: boolean })`.

- [ ] **Шаг 1: Тесты.** `assistant-sent.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { FeedItem } from '@parley/core';
import { viaAssistantIds } from './assistant-sent.js';

const prompt = (id: string, text: string, at: string): FeedItem => ({ id, at, kind: 'prompt', text, images: 0 }) as FeedItem;

describe('viaAssistantIds — какие сообщения Chat отправил помощник', () => {
  const sent = [{ text: 'Тесты на Safari\nпропусти', at: '2026-10-15T10:00:00.000Z' }];
  it('совпали текст (без учёта пробелов) и время в пределах двух минут', () => {
    const ids = viaAssistantIds([prompt('a', 'Тесты на Safari пропусти', '2026-10-15T10:00:03.000Z')], sent);
    expect([...ids]).toEqual(['a']);
  });
  it('тот же текст позже двух минут — сам человек', () => {
    expect(viaAssistantIds([prompt('a', 'Тесты на Safari пропусти', '2026-10-15T10:05:00.000Z')], sent).size).toBe(0);
  });
  it('одна запись помечает одно сообщение', () => {
    const items = [prompt('a', 'Тесты на Safari пропусти', '2026-10-15T10:00:01.000Z'), prompt('b', 'Тесты на Safari пропусти', '2026-10-15T10:00:30.000Z')];
    expect([...viaAssistantIds(items, sent)]).toEqual(['a']);
  });
});
```
`feed-model`: письмо `from: human, via: 'assistant'` → `from: 'You (via Jarvis)'`, `via: 'assistant'`; без `via` — `You`, `via: null`. `RoomMessage`: у такого письма вместо значка человека — `[data-assistant-mark]`. `PromptItem` с `via` показывает `via Jarvis` и знак.

- [ ] **Шаг 2: Комната.** `feed-model.ts`: в `MessageModel`:
```ts
  /** Письмо человека через помощника (спека 2026-10-14, 7.4): подпись «You (via Jarvis)» и знак помощника. */
  via: 'assistant' | null;
```
в отображении письма:
```ts
        from: message.from === HUMAN && message.via === 'assistant' ? S.participants.viaAssistant(S.participants.human) : labelOf(map, message.from),
        // …
        via: message.via ?? null,
```
`SenderAvatar.tsx`: проп `via?: 'assistant' | null`; первой строкой рендера `if (kind === 'human' && via === 'assistant') return <AssistantMark size={size} />;`. `RoomMessage.tsx`: `<SenderAvatar kind={message.sender.kind} provider={message.sender.provider} via={message.via} />`.

- [ ] **Шаг 3: Chat.** `assistant-sent.ts`:
```ts
/**
 * Пометка «You (via Jarvis)» в Chat (спека 2026-10-14, 7.4): агенту текст уходит как есть, а хост помнит, что
 * отправил помощник (`assistant.sent`). Сообщение человека в ленте — от помощника, если совпал текст без учёта
 * пробелов и время — от 5 с до записи до 2 мин после.
 */

import { useEffect, useState } from 'react';
import { normalizeSentText } from '@parley/core/assistant';
import type { FeedItem } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';

export const VIA_WINDOW_MS = 2 * 60_000;
const SKEW_MS = 5000;

export function viaAssistantIds(items: readonly FeedItem[], sent: ReadonlyArray<{ text: string; at: string }>): Set<string> {
  const ids = new Set<string>();
  const entries = sent.map((entry) => ({ text: normalizeSentText(entry.text), at: Date.parse(entry.at), used: false }));
  for (const item of items) {
    if (item.kind !== 'prompt') continue;
    const text = normalizeSentText(item.text);
    const at = Date.parse(item.at);
    const match = entries.find((entry) => !entry.used && entry.text === text && at >= entry.at - SKEW_MS && at - entry.at <= VIA_WINDOW_MS);
    if (match === undefined) continue;
    match.used = true;
    ids.add(item.id);
  }
  return ids;
}

export function useAssistantSent(bridge: ParleyBridge, ref: SessionRef | null, supported: boolean): Array<{ text: string; at: string }> {
  const [sent, setSent] = useState<Array<{ text: string; at: string }>>([]);
  const key = ref === null ? null : `${ref.projectPath}\u0000${ref.workId}\u0000${ref.sessionId}`;
  useEffect(() => {
    if (ref === null || !supported) return;
    let alive = true;
    const load = (): void => {
      void bridge.call('assistant.sent', { ref }).then((result) => {
        if (alive) setSent(result.items);
      }, () => {});
    };
    load();
    const off = bridge.on('assistant.changed', (state) => {
      if (state.outcome === 'sent') load();
    });
    return () => {
      alive = false;
      off();
    };
    // ref сравнивается по ключу: объект пересоздаётся на каждом рендере.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, key, supported]);
  return sent;
}
```
В `ChatView.tsx`: `const sent = useAssistantSent(bridge, ref, useHostSupports('assistant.sent'));`, `const viaIds = useMemo(() => viaAssistantIds(items, sent), [items, sent]);` и передать `viaIds` в `FeedList`, а там — `via={viaIds.has(item.id)}` в `PromptItem`. `PromptItem`: проп `via?: boolean`; при `via` над пузырём, по правому краю:
```tsx
      {via === true ? (
        <div className="flex items-center justify-end gap-1 text-[12px] text-muted-foreground">
          <AssistantMark size={12} />
          {S.chat.viaAssistant}
        </div>
      ) : null}
```
(корень `PromptItem` обернуть в колонку `flex flex-col items-end gap-1`, не меняя ширину пузыря.)

---

### Задача 16: E2E, документы, правки спеки

**Файлы:**
- Create: `packages/desktop/e2e/stub-assistant-agent.mjs`, `packages/desktop/e2e/assistant.spec.ts`
- Modify: `README.md` (раздел «Assistant»), `CHANGELOG.md` (Unreleased), `docs/specs/2026-10-14-assistant-design.md` (6.1, 6.5, 7.3, 7.4 — по этому плану)

- [ ] **Шаг 1: Заглушка CLI** `e2e/stub-assistant-agent.mjs`: в режиме помощника (есть `--strict-mcp-config`) — ход по-настоящему через маршрут хоста, иначе — передать всё обычной заглушке агента:
```js
#!/usr/bin/env node
// Заглушка `claude` для E2E помощника: ход помощника (`--strict-mcp-config`) зовёт инструменты через маршрут хоста
// и печатает stream-json; любой другой запуск (сессии работы, --version) уходит в stub-echo-agent.mjs.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (!args.includes('--strict-mcp-config')) {
  const echo = fileURLToPath(new URL('./stub-echo-agent.mjs', import.meta.url));
  const child = spawn(process.execPath, [echo, ...args], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  const prompt = (args[args.indexOf('-p') + 1] ?? '').replace(/^\[system:[^\]]*\]\n/, '');
  const config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
  const { PARLEY_ASSISTANT_URL: url, PARLEY_ASSISTANT_TOKEN: token } = Object.values(config.mcpServers)[0].env;
  const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const call = async (tool, body) => {
    const response = await fetch(`${url}/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return response.json();
  };
  out({ type: 'system', subtype: 'init', session_id: 'stub-assistant-1' });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__parley-assistant__parley_overview', input: {} }] } });
  const overview = await call('parley_overview', {});
  const room = /\[(room:[^\]]+)\]/.exec(overview.text ?? '')?.[1];
  let answer = '[[calm]] Nothing is open right now.';
  if (/^tell /i.test(prompt) && room !== undefined) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__parley-assistant__propose_message', input: { target: room, text: 'Skip the Safari tests.' } }] } });
    await call('propose_message', { target: room, text: 'Skip the Safari tests.' });
    answer = '[[calm]] I prepared a message for the room.';
  } else if (room !== undefined) {
    answer = '[[joy]] The room is working.';
  }
  for (const word of answer.split(/(?<= )/)) out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: 'stub-assistant-1' });
}
```

- [ ] **Шаг 2: E2E** `e2e/assistant.spec.ts` — запуск по образцу `island.spec.ts` (`PARLEY_HOME` во временном каталоге, `PARLEY_ISLAND: ''`, `PARLEY_CLAUDE_BIN` — заглушка из шага 1, главное окно 800×500 через `setBounds`, длинные имена работы и комнаты — правило визуальных проверок):
1. Включить помощника: `window.evaluate(() => window.parley.app.saveUi({ assistant: { enabled: true, provider: 'claude' } }))`.
2. Создать работу с длинным названием и комнату с длинным названием и одной сессией — шагами из `room-actions.spec.ts`.
3. Палитра ⌘J → «Ask Jarvis» → на странице острова виден `assistant-view`.
4. В `assistant-input` ввести `tell the room to skip Safari tests`, Enter → `assistant-card` с текстом `Skip the Safari tests.` → подождать 600 мс (арм кнопки) → `assistant-send` → `assistant-sent`.
5. В главном окне открыть комнату: последнее письмо — `Skip the Safari tests.`, в его шапке — `You (via Jarvis)`, вместо значка человека — `[data-assistant-mark]`.
6. Вопрос `what is going on?` → `assistant-answer` содержит `The room is working.`; Esc → `assistant-view` пропал.

- [ ] **Шаг 3: Документы.** README — раздел «Assistant» (по-английски): что это (навигатор на острове, отвечает о работах, передаёт сообщения после подтверждения), как включить (Settings → Assistant, провайдер и модель, язык, ⌥Space), голос — через Settings → Voice, что он не умеет (одобрения, запуск сессий — потом), что каждый вопрос — короткий ход CLI на подписке выбранного провайдера, где данные (`~/.parley/assistant/`). CHANGELOG, Unreleased: «Assistant on the island (stage 1): ask about your agents by hotkey, voice or text; pass messages to rooms and agents after confirmation; messages show “You (via Jarvis)”». Спека: 6.1 — настройки в `ui.json` (`ui.assistant`), не `settings.set`; 6.5 — `provider` и `model` в `assistant.ask` могут быть `null`, `detail` — структура `{ tool, target }`, метод `assistant.sent`; 7.3 — подтверждение принимает оба языка; 7.4 — Chat помечается окном по `assistant.sent`, а не хостом в ленте.

- [ ] **Шаг 4: Прогон группы E и всего** (контролёр, после проверки загрузки):
```bash
nice -n 10 pnpm build && nice -n 10 pnpm typecheck && nice -n 10 pnpm lint && nice -n 10 pnpm test
cd packages/desktop && nice -n 10 pnpm exec playwright test e2e/assistant.spec.ts e2e/island.spec.ts
```
Expected: зелёное (известные капризы E2E — сравнить с базовым прогоном master). Коммит:
```bash
git add -A packages README.md CHANGELOG.md docs/specs/2026-10-14-assistant-design.md && git commit -m "feat: помощник на острове, этап 1 — E2E, README, CHANGELOG"
```

### Живая проверка (с человеком, после задачи 16)

Dev-окно с отдельным домом (рецепт из памяти: `PARLEY_HOME`, `PARLEY_APP_DATA` — свои каталоги), настоящий `claude`:
1. Settings → Assistant: включить, провайдер Claude, язык Русский; ⌥Space из браузера — остров раскрылся и слушает, Parley на передний план не вышел.
2. Голосом: «Кто сейчас работает?» — ответ по-русски за ~4 с, подписи «Thinking…» → «Checking rooms…» → ответ.
3. «Скажи комнате X, что …» — карточка, «да» голосом — письмо в комнате с «You (via Jarvis)».
4. Esc — печать в прежнем приложении идёт туда же (клавиатура вернулась).
5. Во время хода стрелка ⌃ — мини-вид «Thinking·»; ответ раскрывает остров сам; через 8 с без курсора — обычная пилюля.
6. То же на GLM и Codex (по одному вопросу); на Codex — живьём проверить `default_tools_approval_mode` в одной строке `-c` (TOML-таблица).
7. Остров выключен в настройках, помощник включён: ⌥Space показывает только помощника, после закрытия остров прячется.
