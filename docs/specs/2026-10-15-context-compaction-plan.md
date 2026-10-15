# Заполненность контекста и сжатие по теме — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** процент заполнения контекста у каждого агента — на карточке участника комнаты, в шапке комнаты (`Ctx`) и в тулбаре Chat — и сжатие `/compact` по клику с фокусом на теме комнаты или сессии; занятый агент сжимается после хода.

**Architecture:** ядро получает тип `ContextFill`: строка статуса Claude Code пишет его в `context/<сессия>.json`, разбор rollout-лога Codex берёт его из `token_count`. Хост перечитывает файлы запущенных сессий Claude/GLM раз в 5 секунд (`ContextService`) и кладёт значение в `LiveMetrics.context`; сервис сжатия (`CompactionService`) печатает `/compact` в PTY свободного агента под замком `sessions.exclusive`, держит ждущие просьбы и отдаёт фазу в `LiveMetrics.compaction`. Окно показывает чип на карточке участника, значок комнаты с `Compact all` и чип в тулбаре Chat.

**Tech Stack:** TypeScript, Node 20, vitest, zod (протокол), React + Radix Popover + Tailwind (окно), Playwright + Electron (E2E), pnpm workspace.

**Spec:** [`docs/specs/2026-10-15-context-compaction-design.md`](2026-10-15-context-compaction-design.md) — читать вместе с планом.

## Global Constraints

- Тексты окна — только английские, в `packages/desktop/src/shared/strings.ts` (раздел `S.context`); тексты для агента (инструкции `/compact` по умолчанию) — тоже английские, там же; комментарии, тесты и документы — по-русски.
- Сжатие — только по клику человека. Автопорога нет. Хост сам `/compact` не печатает.
- Пороги цвета: `< 60 %` — нейтральный, `60–84 %` — янтарный (`accent`), `≥ 85 %` — красный (`destructive`).
- Инструкция — одна строка, не длиннее 1000 знаков после очистки; пусто — голый `/compact`; у Codex — всегда голый `/compact`.
- Ждущая просьба — одна на сессию, новая заменяет текст прежней; живёт только в памяти хоста.
- Конец сжатия: `PostCompact` (Claude, GLM), запись `compacted` в rollout новее печати (Codex), выход процесса, или 5 минут без сигнала (`COMPACT_TIMEOUT_MS = 300_000`) — тогда уведомление `compact-failed`.
- Опрос файлов контекста — раз в 5 секунд (`CONTEXT_POLL_MS = 5_000`), только запущенные сессии не-Codex.
- Совместимость: новые поля `LiveMetrics.context` и `LiveMetrics.compaction` необязательные; без `sessions.compact` у хоста (`useHostSupports`) кнопок нет; без `context` в метриках чипа нет.
- Нативные id и пути логов в окно не уходят.
- Раскладка проверяется в окне 800×500 при масштабе 1 и 2, с длинным названием комнаты (120 знаков) и длинными именами.
- Хост и окно берут ядро и протокол собранными: после правок ядра или протокола перед их тестами — `pnpm --filter @parley/core build && pnpm --filter @parley/protocol build`.
- Перед тяжёлыми прогонами (полные наборы, E2E) — `uptime`; при загрузке не меньше числа ядер прогон отложить.
- Один коммит на задачу, сообщение по-русски в стиле репозитория (`feat(core): …`), последней строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Человек печатает в терминале агента, пока просьба ждёт, — хост не печатает поверх и сжимает после того, как поле опустело (задача 6, «черновик человека — ждёт»).
2. Агенту пришло письмо, пока просьба ждёт, — будильник не забирает свободный момент, сжатие идёт первым (задача 7, «будильник уступает сжатию»).
3. Сжатие не отчиталось (CLI завис, хук не дошёл) — через 5 минут замок снят, письма снова доставляются, человек видит уведомление (задача 6, «таймаут»).
4. В комнате вместе Codex и Claude, `Compact all` — Codex получает голый `/compact`, Claude — с фокусом, итог одним тостом (задача 6, «Codex — голый /compact»; задача 10, «Compact all»).
5. Агент уснул со старым процентом — чип не показывает устаревшее и кнопки нет; в списке комнаты он помечен `asleep` (задача 10, «спящий участник»).

---

### Task 1: Живая проба на настоящих CLI

Проба отвечает на вопросы спеки 7.3 до кода сервиса. Итоги — в новый раздел спеки. Ключи и пароли исполнитель не вводит: GLM проверяется в задаче 12 через сессию GLM в Parley у человека.

**Files:**
- Modify: `docs/specs/2026-10-15-context-compaction-design.md` (новый раздел `## 9. Итоги живой пробы`)

**Interfaces:**
- Consumes: —
- Produces: подтверждённые или исправленные факты для задач 2, 3, 6 (имена полей `context_window`, формула Codex, поведение `/compact` с текстом у Codex, вызов строки статуса после сжатия, длинный `/compact` одной записью).

- [ ] **Step 1: Подготовить каталог пробы и строку статуса-«диктофон»**

```bash
PROBE="$(mktemp -d)"; mkdir -p "$PROBE/proj" && git -C "$PROBE/proj" init -q
cat > "$PROBE/dump.sh" <<'SH'
#!/bin/sh
# Каждый вход строки статуса — одной строкой JSON в statusline.jsonl.
tr -d '\n' >> "$(dirname "$0")/statusline.jsonl"; echo >> "$(dirname "$0")/statusline.jsonl"; echo probe
SH
chmod +x "$PROBE/dump.sh"
printf '{"statusLine":{"type":"command","command":"%s"}}\n' "$PROBE/dump.sh" > "$PROBE/settings.json"
echo "$PROBE"
```

Запомнить путь `$PROBE` — дальше он нужен во всех шагах.

- [ ] **Step 2: Claude Code — поля `context_window` и сверка с `/context`**

```bash
tmux new-session -d -s probe-claude -x 200 -y 50 -c "$PROBE/proj" "claude --settings $PROBE/settings.json"
sleep 4; tmux capture-pane -p -t probe-claude | tail -15
```

Если на экране вопрос доверия к папке — `tmux send-keys -t probe-claude Enter`. Затем:

```bash
tmux send-keys -t probe-claude 'Reply with the single word ok' Enter; sleep 15
tail -1 "$PROBE/statusline.jsonl" | jq '.context_window'
tmux send-keys -t probe-claude '/context' Enter; sleep 4; tmux capture-pane -p -t probe-claude | tail -30
```

Записать: точные имена полей `context_window` (ожидаются `used_percentage`, `context_window_size`, `current_usage.{input_tokens,cache_creation_input_tokens,cache_read_input_tokens}`), совпадает ли `used_percentage` с процентом `/context`.

- [ ] **Step 3: Claude Code — длинный `/compact` одной записью и строка статуса после сжатия**

```bash
N_BEFORE=$(wc -l < "$PROBE/statusline.jsonl")
LONG="/compact $(python3 -c 'print(("Focus on room Probe: the task, decisions, open questions. " * 17)[:990])')"
tmux send-keys -t probe-claude -l "$LONG"; sleep 1; tmux send-keys -t probe-claude Enter; sleep 40
tmux capture-pane -p -t probe-claude | tail -20
echo "строк статуса до: $N_BEFORE, после: $(wc -l < "$PROBE/statusline.jsonl")"; tail -1 "$PROBE/statusline.jsonl" | jq '.context_window.used_percentage'
tmux kill-session -t probe-claude
```

Записать: выполнилась ли команда как сжатие (на экране «Compacted»/«Conversation compacted», а не ответ модели на сообщение), свернулась ли во вставку `[Pasted text …]`, позвалась ли строка статуса после сжатия и с каким процентом.

- [ ] **Step 4: Codex — формула процента и `/compact` с текстом**

```bash
tmux new-session -d -s probe-codex -x 200 -y 50 -c "$PROBE/proj" codex
sleep 5; tmux capture-pane -p -t probe-codex | tail -15
```

Вопрос доверия — `tmux send-keys -t probe-codex Enter`. Затем:

```bash
tmux send-keys -t probe-codex 'Reply with the single word ok' Enter; sleep 20
tmux capture-pane -p -t probe-codex | grep -i 'context left'
ROLL="$(ls -t ~/.codex/sessions/*/*/*/rollout-*.jsonl | head -1)"
jq -c 'select(.type=="event_msg" and .payload.type=="token_count") | .payload.info | {last_token_usage, model_context_window}' "$ROLL" | tail -1
```

Посчитать занятый процент по формуле задачи 2 (`codexContextFill`) и сверить с `100 − «% context left»` на экране. Потом:

```bash
T0="$(date -u +%Y-%m-%dT%H:%M:%S)"
tmux send-keys -t probe-codex -l '/compact focus on the probe only'; sleep 1; tmux send-keys -t probe-codex Enter; sleep 40
tmux capture-pane -p -t probe-codex | tail -20
jq -c 'select(.type=="compacted") | {timestamp}' "$ROLL" | tail -1
jq -c 'select(.timestamp > "'"$T0"'") | {timestamp, type, p: .payload.type}' "$ROLL" | tail -10
tmux kill-session -t probe-codex
```

Записать: принял ли Codex текст после `/compact` (сжатие с фокусом, сжатие без фокуса, или ушло сообщением); есть ли запись `type: "compacted"` и её время; пришёл ли `token_count` после сжатия.

- [ ] **Step 5: Записать итоги в спеку**

Добавить в конец `docs/specs/2026-10-15-context-compaction-design.md`:

```markdown
## 9. Итоги живой пробы (<дата>, Claude Code <версия>, Codex <версия>)

1. Codex `/compact <текст>`: <что произошло>. Вывод: <Codex без фокуса остаётся / меняется так-то>.
2. Процент: Claude `used_percentage` = `/context` <да/нет, цифры>; Codex по формуле `codexContextFill` = экран <да/нет, цифры>.
3. GLM — проверяется в приёмке (задача 12).
4. Строка статуса после `/compact`: <зовётся / не зовётся до следующего ответа>.
5. Поля `context_window`: <точный список>.
6. Длинный `/compact` одной записью: <команда / вставка / сообщение>.
```

Если ответ расходится с дизайном (например, Codex принимает текст, или длинный `/compact` сворачивается во вставку), поправить разделы спеки и затронутые шаги задач 2, 3 и 6 этого плана в том же коммите и сообщить человеку до задачи 2.

- [ ] **Step 6: Commit**

```bash
git add docs/specs/2026-10-15-context-compaction-design.md docs/specs/2026-10-15-context-compaction-plan.md
git commit -m "docs(specs): итоги живой пробы сжатия контекста

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Ядро — `ContextFill`, файл строки статуса и уборка

**Files:**
- Create: `packages/core/src/context-fill.ts`
- Create: `packages/core/src/context-fill.test.ts`
- Modify: `packages/core/src/work/statusline.ts` (шапка, импорт, `saveContext`, вызов в `runStatusline` ~строка 286)
- Modify: `packages/core/src/work/statusline.test.ts`
- Modify: `packages/core/src/work/store.ts:66-80` (`workPaths.context`, тип `WorkPaths`), `:187-200` (`deleteSessionFiles`)
- Modify: `packages/core/src/work/store.test.ts` (тест уборки)
- Modify: `packages/core/src/index.ts` (рядом со строками 52-54)

**Interfaces:**
- Consumes: `isFileSafeId` из `packages/core/src/limits.ts:43`.
- Produces:
  - `interface ContextFill { usedPercent: number; windowTokens: number | null; usedTokens: number | null; at: string }`
  - `CONTEXT_DIR = 'context'`; `contextFile(workDir: string, sessionId: string): string`
  - `claudeContextFill(contextWindow: unknown, at: string): ContextFill | null`
  - `codexContextFill(info: unknown, at: string): ContextFill | null`; `CODEX_BASELINE_TOKENS = 12_000`
  - `parseContextFill(raw: string): ContextFill | null`
  - `readContextFill(workDir: string, sessionId: string): Promise<ContextFill | null>`
  - `WorkPaths.context: string`
  - всё это экспортируется из `@parley/core`

- [ ] **Step 1: Write the failing tests**

`packages/core/src/context-fill.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeContextFill,
  codexContextFill,
  contextFile,
  parseContextFill,
  readContextFill,
} from './context-fill.js';

const AT = '2026-10-15T10:00:00.000Z';

describe('claudeContextFill (спека 4.1)', () => {
  it('процент, окно и занятые токены — вход, запись и чтение кэша', () => {
    expect(
      claudeContextFill(
        {
          used_percentage: 82.4,
          context_window_size: 200_000,
          current_usage: { input_tokens: 800, cache_creation_input_tokens: 4_000, cache_read_input_tokens: 160_000, output_tokens: 900 },
        },
        AT,
      ),
    ).toEqual({ usedPercent: 82.4, windowTokens: 200_000, usedTokens: 164_800, at: AT });
  });

  it('без current_usage и размера окна — только процент', () => {
    expect(claudeContextFill({ used_percentage: 8 }, AT)).toEqual({ usedPercent: 8, windowTokens: null, usedTokens: null, at: AT });
  });

  it('нет числового used_percentage — null', () => {
    expect(claudeContextFill({ used_percentage: '8' }, AT)).toBeNull();
    expect(claudeContextFill({ used_percentage: Number.NaN }, AT)).toBeNull();
    expect(claudeContextFill(null, AT)).toBeNull();
    expect(claudeContextFill(undefined, AT)).toBeNull();
  });

  it('процент за пределами 0–100 обрезается', () => {
    expect(claudeContextFill({ used_percentage: 130 }, AT)?.usedPercent).toBe(100);
    expect(claudeContextFill({ used_percentage: -5 }, AT)?.usedPercent).toBe(0);
  });

  it('ровно 0 — нет наблюдения: так строка статуса приходит сразу после /compact (спека 9, п. 4)', () => {
    expect(
      claudeContextFill(
        { used_percentage: 0, current_usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        AT,
      ),
    ).toBeNull();
    expect(claudeContextFill({ used_percentage: 0 }, AT)).toBeNull();
  });
});

describe('codexContextFill (спека 4.2, формула Codex TUI)', () => {
  it('базовые 12 000 токенов не считаются: окно 272 000, занято 142 000 → 50 %', () => {
    expect(codexContextFill({ model_context_window: 272_000, last_token_usage: { total_tokens: 142_000 } }, AT)).toEqual({
      usedPercent: 50,
      windowTokens: 272_000,
      usedTokens: 142_000,
      at: AT,
    });
  });

  it('total_tokens нет — вход + выход', () => {
    expect(
      codexContextFill({ model_context_window: 272_000, last_token_usage: { input_tokens: 130_000, output_tokens: 12_000 } }, AT)?.usedTokens,
    ).toBe(142_000);
  });

  it('меньше базы — 0 %', () => {
    expect(codexContextFill({ model_context_window: 272_000, last_token_usage: { total_tokens: 5_000 } }, AT)?.usedPercent).toBe(0);
  });

  it('нет окна или last_token_usage — null', () => {
    expect(codexContextFill({ last_token_usage: { total_tokens: 1 } }, AT)).toBeNull();
    expect(codexContextFill({ model_context_window: 272_000 }, AT)).toBeNull();
    expect(codexContextFill(null, AT)).toBeNull();
  });
});

describe('parseContextFill / readContextFill', () => {
  let workDir = '';
  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'parley-context-'));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('файл строки статуса читается как есть', async () => {
    const fill = { usedPercent: 41.5, windowTokens: 200_000, usedTokens: 83_000, at: AT };
    await mkdir(path.join(workDir, 'context'));
    await writeFile(contextFile(workDir, 's-01'), `${JSON.stringify(fill)}\n`);
    expect(await readContextFill(workDir, 's-01')).toEqual(fill);
  });

  it('нет файла, битый JSON, не та форма, плохой id — null', async () => {
    expect(await readContextFill(workDir, 's-01')).toBeNull();
    expect(parseContextFill('{')).toBeNull();
    expect(parseContextFill(JSON.stringify({ usedPercent: '1', at: AT }))).toBeNull();
    expect(parseContextFill(JSON.stringify({ usedPercent: 1, at: 'вчера' }))).toBeNull();
    expect(await readContextFill(workDir, '../s-01')).toBeNull();
  });
});
```

В `packages/core/src/work/statusline.test.ts` рядом с тестом «rate_limits во входе → limits/<сессия>.json» (~строка 148) добавить:

```ts
  describe('заполненность контекста (спека 2026-10-15, 4.1)', () => {
    const contextRel = path.join('context', 's-01.json');

    it('context_window во входе → context/<сессия>.json', async () => {
      await run(
        input({
          context_window: {
            used_percentage: 41.5,
            context_window_size: 200_000,
            current_usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 83_000 },
          },
        }),
      );
      expect(JSON.parse(await readFile(path.join(workDir, contextRel), 'utf8'))).toEqual({
        usedPercent: 41.5,
        windowTokens: 200_000,
        usedTokens: 83_030,
        at: '2026-09-29T12:00:00.000Z',
      });
    });

    it('без rate_limits контекст всё равно пишется', async () => {
      await run(input({ rate_limits: undefined }));
      expect(JSON.parse(await readFile(path.join(workDir, contextRel), 'utf8'))).toMatchObject({ usedPercent: 8.4 });
    });

    it('нет context_window — файла нет, строка терминала та же', async () => {
      const line = await run(input({ context_window: undefined }));
      await expect(readFile(path.join(workDir, contextRel), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(line).toBe('Opus\n');
    });

    it('id сессии вне isFileSafeId — файла нет', async () => {
      env = { ...env, PARLEY_SESSION_ID: '../s-01' };
      await run(input());
      await expect(readFile(path.join(workDir, contextRel), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
```

В `packages/core/src/work/store.test.ts` добавить (импортировать `deleteSessionFiles`, `workPaths` из `./store.js`, `contextFile` из `../context-fill.js`, `mkdir`, `writeFile`, `stat` из `node:fs/promises`, если их ещё нет; временный проект завести так же, как соседние тесты файла):

```ts
it('deleteSessionFiles убирает и context/<сессия>.json (спека 2026-10-15)', async () => {
  const paths = workPaths(project, 'w-01');
  await mkdir(paths.context, { recursive: true });
  const file = contextFile(paths.dir, 's-01');
  await writeFile(file, '{}');
  await deleteSessionFiles(project, 'w-01', 's-01');
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @parley/core exec vitest run src/context-fill.test.ts src/work/statusline.test.ts src/work/store.test.ts`
Expected: FAIL — `Cannot find module './context-fill.js'`, а в `store.test.ts` — `paths.context` равен `undefined`.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/context-fill.ts`:

```ts
/**
 * Заполненность контекста сессии (спека 2026-10-15, 4): сколько окна модели занято сейчас. Лист: из пакета тянет
 * только `limits.js` (`isFileSafeId`) — его импортирует скрипт строки статуса, а тот зовётся часто и должен быть быстрым.
 *
 * Claude Code и GLM: скрипт строки статуса кладёт `context/<сессия>.json` из `context_window` своего входа
 * (`claudeContextFill`). Codex: разбор rollout-лога берёт последнюю запись `token_count` (`codexContextFill`).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isFileSafeId } from './limits.js';

export const CONTEXT_DIR = 'context';

export interface ContextFill {
  /** Занято, 0–100. */
  usedPercent: number;
  /** Размер окна модели в токенах; `null` — CLI не сообщил. */
  windowTokens: number | null;
  /** Занято токенов; `null` — CLI не сообщил. */
  usedTokens: number | null;
  /** ISO-время наблюдения. */
  at: string;
}

export const contextFile = (workDir: string, sessionId: string): string =>
  path.join(workDir, CONTEXT_DIR, `${sessionId}.json`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/** `context_window` входа строки статуса Claude Code → наблюдение; нет числового `used_percentage` — `null`. */
export function claudeContextFill(contextWindow: unknown, at: string): ContextFill | null {
  if (!isRecord(contextWindow)) return null;
  const used = contextWindow['used_percentage'];
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  // Сразу после `/compact` Claude Code зовёт строку статуса с нулями (спека 9, п. 4) — это не наблюдение: прежний
  // файл остаётся, и окно показывает `compacted` до первой настоящей цифры. Живая сессия ровно 0 % не занимает.
  if (used === 0) return null;
  const current = isRecord(contextWindow['current_usage']) ? contextWindow['current_usage'] : null;
  const parts =
    current === null
      ? []
      : [count(current['input_tokens']), count(current['cache_creation_input_tokens']), count(current['cache_read_input_tokens'])];
  const usedTokens = parts.every((part) => part === null) ? null : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
  return { usedPercent: clampPercent(used), windowTokens: count(contextWindow['context_window_size']), usedTokens, at };
}

/** Базовые токены окна, которые Codex TUI не считает занятыми (`percent_of_context_window_remaining`). */
export const CODEX_BASELINE_TOKENS = 12_000;

/** `info` записи `token_count` Codex → наблюдение; нет окна или `last_token_usage` — `null`. */
export function codexContextFill(info: unknown, at: string): ContextFill | null {
  if (!isRecord(info)) return null;
  const windowTokens = count(info['model_context_window']);
  const last = isRecord(info['last_token_usage']) ? info['last_token_usage'] : null;
  if (windowTokens === null || last === null) return null;
  const input = count(last['input_tokens']);
  const output = count(last['output_tokens']);
  const usedTokens = count(last['total_tokens']) ?? (input === null && output === null ? null : (input ?? 0) + (output ?? 0));
  if (usedTokens === null) return null;
  if (windowTokens <= CODEX_BASELINE_TOKENS) return { usedPercent: 100, windowTokens, usedTokens, at };
  const effective = windowTokens - CODEX_BASELINE_TOKENS;
  const used = Math.max(0, usedTokens - CODEX_BASELINE_TOKENS);
  const remaining = Math.round(clampPercent((Math.max(0, effective - used) / effective) * 100));
  return { usedPercent: 100 - remaining, windowTokens, usedTokens, at };
}

/** Текст файла `context/<сессия>.json` → наблюдение; битый JSON или не та форма — `null`. */
export function parseContextFill(raw: string): ContextFill | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const usedPercent = data['usedPercent'];
  const at = data['at'];
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return null;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  return { usedPercent: clampPercent(usedPercent), windowTokens: count(data['windowTokens']), usedTokens: count(data['usedTokens']), at };
}

/** Файл сессии в каталоге работы; нет файла или плохой id — `null`. */
export async function readContextFill(workDir: string, sessionId: string): Promise<ContextFill | null> {
  if (!isFileSafeId(sessionId)) return null;
  try {
    return parseContextFill(await readFile(contextFile(workDir, sessionId), 'utf8'));
  } catch {
    return null;
  }
}
```

В `packages/core/src/work/statusline.ts`:

1. В шапке «Скрипт делает две вещи» → «три вещи» и после пункта 1 добавить пункт:
   ` * 2. Если во входе есть `context_window` с числовым `used_percentage`, так же атомарно пишет заполненность контекста`
   ` *    в `context/<сессия>.json` (спека 2026-10-15, 4.1). Нет — файла нет.`
   Прежний пункт 2 стал 3.
2. Импорт рядом со строкой 31: `import { claudeContextFill, CONTEXT_DIR, contextFile } from '../context-fill.js';`
3. Общую часть записи вынести из `saveLimits` в помощника и добавить `saveContext`. Заменить `saveLimits` (строки 114-141) на:

```ts
/**
 * Атомарная запись файла сессии в подкаталог работы (`limits/`, `context/`): временный файл и `rename`. Каталог
 * работы не создаётся (`mkdir` без recursive): удалённую под живым агентом работу скрипт не воскрешает.
 */
async function writeSessionFile(
  env: NodeJS.ProcessEnv,
  dirName: string,
  fileOf: (workDir: string, sessionId: string) => string,
  body: unknown,
): Promise<void> {
  const workDir = envValue(env, 'WORK_DIR');
  const sessionId = envValue(env, 'SESSION_ID');
  if (workDir === undefined || !path.isAbsolute(workDir)) return;
  if (sessionId === undefined || !isFileSafeId(sessionId)) return;

  try {
    await mkdir(path.join(workDir, dirName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return;
  }
  const file = fileOf(workDir, sessionId);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(body)}\n`, 'utf8');
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function saveLimits(
  input: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv,
  now: () => number,
): Promise<void> {
  const at = new Date(now()).toISOString();
  const rateLimits = input?.['rate_limits'];
  // Окон подписки во входе нет (шлюз, API-ключ, первый ход) — хранить нечего.
  if (claudeLimits(rateLimits, at) === null) return;
  await writeSessionFile(env, LIMITS_DIR, limitsFile, { at, rateLimits });
}

/** Заполненность контекста (спека 2026-10-15, 4.1): `context/<сессия>.json`; нет `context_window` — файла нет. */
async function saveContext(
  input: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv,
  now: () => number,
): Promise<void> {
  const fill = claudeContextFill(input?.['context_window'], new Date(now()).toISOString());
  if (fill === null) return;
  await writeSessionFile(env, CONTEXT_DIR, contextFile, fill);
}
```

4. В `runStatusline` после строки `await saveLimits(input, env, options.now ?? Date.now).catch(() => undefined);` добавить:

```ts
  await saveContext(input, env, options.now ?? Date.now).catch(() => undefined);
```

В `packages/core/src/work/store.ts`: импорт `import { CONTEXT_DIR, contextFile } from '../context-fill.js';`; в интерфейс `WorkPaths` — поле `context: string;` с комментарием `/** Заполненность контекста сессий от строки статуса (спека 2026-10-15). */`; в `workPaths` после `limits: …` — `context: path.join(dir, CONTEXT_DIR),`; в массив `files` функции `deleteSessionFiles` после `limitsFile(paths.dir, sessionId),` — `contextFile(paths.dir, sessionId),`.

В `packages/core/src/index.ts` после строки 54:

```ts
export {
  claudeContextFill,
  codexContextFill,
  CODEX_BASELINE_TOKENS,
  CONTEXT_DIR,
  contextFile,
  parseContextFill,
  readContextFill,
} from './context-fill.js';
export type { ContextFill } from './context-fill.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/core exec vitest run src/context-fill.test.ts src/work/statusline.test.ts src/work/store.test.ts`
Expected: PASS. Если существующий тест сверяет содержимое каталога работы целиком (например, ждёт только `limits`), добавить в ожидание `context` — других правок в старых тестах быть не должно.

Затем весь пакет: `pnpm --filter @parley/core test` — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/context-fill.ts packages/core/src/context-fill.test.ts packages/core/src/work/statusline.ts packages/core/src/work/statusline.test.ts packages/core/src/work/store.ts packages/core/src/work/store.test.ts packages/core/src/index.ts
git commit -m "feat(core): заполненность контекста — тип ContextFill и файл строки статуса

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Ядро — контекст и момент сжатия из rollout-лога Codex

**Files:**
- Modify: `packages/core/src/session-index.ts:17-78` (интерфейс `SessionIndex`)
- Modify: `packages/core/src/codex/index-session.ts` (разбор `token_count` ~строка 177, новая ветка `compacted`, объект результата ~строка 215)
- Test: `packages/core/src/codex/codex.test.ts`

**Interfaces:**
- Consumes: `codexContextFill`, `ContextFill` (задача 2).
- Produces: `SessionIndex.context?: ContextFill | null` (у Codex — из последнего `token_count` с окном; у Claude поля нет); `SessionIndex.compactedAt?: string | null` (у Codex — время последней записи `type: 'compacted'`).

- [ ] **Step 1: Write the failing tests**

В `packages/core/src/codex/codex.test.ts` рядом с тестом «токены берутся из последней записи token_count» (~строка 216) добавить:

```ts
  describe('контекст и сжатие (спека 2026-10-15, 4.2 и 5.5)', () => {
    const tokenCount = (last: Record<string, number>, at: string, window = 272_000) =>
      line({
        timestamp: at,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 1_000, cached_input_tokens: 0, output_tokens: 10, total_tokens: 1_010 },
            last_token_usage: last,
            model_context_window: window,
          },
        },
      });

    it('context — из последнего token_count по формуле Codex', async () => {
      const file = await writeRollout(
        '2026-03-12',
        '019ce3d5-584a-7be2-922e-b8185a8d7c19',
        meta() +
          tokenCount({ total_tokens: 20_000 }, '2026-03-12T10:01:00.000Z') +
          tokenCount({ total_tokens: 142_000 }, '2026-03-12T10:02:00.000Z'),
      );
      const index = await indexCodexSession(file);
      expect(index.context).toEqual({ usedPercent: 50, windowTokens: 272_000, usedTokens: 142_000, at: '2026-03-12T10:02:00.000Z' });
    });

    it('token_count без last_token_usage не стирает прежнее наблюдение; без единого — null', async () => {
      const bare = line({
        timestamp: '2026-03-12T10:03:00.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: null },
      });
      const file = await writeRollout(
        '2026-03-12',
        '019ce3d5-584a-7be2-922e-b8185a8d7c19',
        meta() + tokenCount({ total_tokens: 142_000 }, '2026-03-12T10:02:00.000Z') + bare,
      );
      expect((await indexCodexSession(file)).context?.usedPercent).toBe(50);

      const empty = await writeRollout('2026-03-13', '019ce3d5-584a-7be2-922e-b8185a8d7c20', meta());
      expect((await indexCodexSession(empty)).context ?? null).toBeNull();
    });

    it('compactedAt — время последней записи compacted', async () => {
      const compacted = (at: string) => line({ timestamp: at, type: 'compacted', payload: { message: 'summary' } });
      const file = await writeRollout(
        '2026-03-12',
        '019ce3d5-584a-7be2-922e-b8185a8d7c19',
        meta() + compacted('2026-03-12T10:05:00.000Z') + compacted('2026-03-12T10:09:00.000Z'),
      );
      expect((await indexCodexSession(file)).compactedAt).toBe('2026-03-12T10:09:00.000Z');
      const none = await writeRollout('2026-03-13', '019ce3d5-584a-7be2-922e-b8185a8d7c20', meta());
      expect((await indexCodexSession(none)).compactedAt ?? null).toBeNull();
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @parley/core exec vitest run src/codex/codex.test.ts`
Expected: FAIL — `index.context` и `index.compactedAt` равны `undefined`.

- [ ] **Step 3: Write minimal implementation**

В `packages/core/src/session-index.ts` импорт `import type { ContextFill } from './context-fill.js';` и в интерфейс `SessionIndex` рядом с `usage?: UsageSummary` (строка 75):

```ts
  /**
   * Заполненность контекста сейчас (спека 2026-10-15, 4.2): у Codex — из последнего `token_count` с окном модели.
   * У Claude поля нет: процент приходит файлом строки статуса.
   */
  context?: ContextFill | null;
  /** Время последней записи `compacted` в rollout-логе Codex (спека 2026-10-15, 5.5); у Claude поля нет. */
  compactedAt?: string | null;
```

В `packages/core/src/codex/index-session.ts`:

1. Импорт: `import { codexContextFill, type ContextFill } from '../context-fill.js';`
2. Рядом с объявлением `let lastCounters …` завести:

```ts
  let context: ContextFill | null = null;
  let compactedAt: string | null = null;
```

3. В ветке `if (kind === 'token_count') {` после блока `if (counters !== null) { … }`:

```ts
          // Последнее наблюдение с окном модели; запись без `last_token_usage` прежнее не стирает.
          if (at !== null) context = codexContextFill(asRecord(payload['info']), at) ?? context;
```

4. В `switch` по `record.type` перед `default:` добавить:

```ts
      case 'compacted': {
        // Сжатие разговора (ручное `/compact` или автосжатие) — конец сжатия для хоста (спека 5.5).
        if (at !== null) compactedAt = at;
        break;
      }
```

5. В объект `SessionIndex`, который возвращает `indexCodexSession` (~строка 215), добавить поля `context,` и `compactedAt,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/core exec vitest run src/codex/codex.test.ts && pnpm --filter @parley/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session-index.ts packages/core/src/codex/index-session.ts packages/core/src/codex/codex.test.ts
git commit -m "feat(core): контекст и момент сжатия из rollout-лога Codex

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Протокол и хост — `LiveMetrics.context` и `LiveMetrics.compaction`

**Files:**
- Modify: `packages/protocol/src/types.ts:128-157` (`LiveMetrics`), новый тип `CompactionPhase`
- Create: `packages/host/src/compaction/context-view.ts`
- Create: `packages/host/src/compaction/context-view.test.ts`
- Modify: `packages/host/src/activity/activity-service.ts` (интерфейс ~97-139, карты ~295, `metricsFor` 524-555, уборка ~854, методы рядом с `mailWaiting` ~920)
- Test: `packages/host/src/activity/activity-service.test.ts`

**Interfaces:**
- Consumes: `ContextFill` (задача 2), `SessionIndex.context` (задача 3).
- Produces:
  - `type CompactionPhase = 'pending' | 'running' | 'compacted'` (`@parley/protocol`)
  - `LiveMetrics.context?: ContextFill | null`, `LiveMetrics.compaction?: CompactionPhase | null`
  - `interface CompactionTrack { phase: 'pending' | 'running' | null; finishedAt: string | null }` (`host/src/compaction/context-view.ts`)
  - `contextView(fill: ContextFill | null, track: CompactionTrack | undefined): { context: ContextFill | null; compaction: CompactionPhase | null }`
  - `ActivityService.setContext(ref: SessionRef, fill: ContextFill | null): void`
  - `ActivityService.setCompaction(ref: SessionRef, track: CompactionTrack): void`
  - `ActivityService.codexCompactedAt(ref: SessionRef): string | null`

- [ ] **Step 1: Write the failing tests**

`packages/host/src/compaction/context-view.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { contextView } from './context-view.js';

const fill = { usedPercent: 82, windowTokens: 200_000, usedTokens: 164_000, at: '2026-10-15T10:00:00.000Z' };

describe('contextView (спека 4.4, 5.6)', () => {
  it('нет сжатия — наблюдение как есть', () => {
    expect(contextView(fill, undefined)).toEqual({ context: fill, compaction: null });
    expect(contextView(null, undefined)).toEqual({ context: null, compaction: null });
  });

  it('ждёт или идёт — фаза и прежнее наблюдение', () => {
    expect(contextView(fill, { phase: 'pending', finishedAt: null })).toEqual({ context: fill, compaction: 'pending' });
    expect(contextView(fill, { phase: 'running', finishedAt: '2026-10-15T11:00:00.000Z' })).toEqual({ context: fill, compaction: 'running' });
  });

  it('наблюдение старше конца сжатия — процента нет, compacted', () => {
    expect(contextView(fill, { phase: null, finishedAt: '2026-10-15T10:05:00.000Z' })).toEqual({ context: null, compaction: 'compacted' });
    expect(contextView(null, { phase: null, finishedAt: '2026-10-15T10:05:00.000Z' })).toEqual({ context: null, compaction: 'compacted' });
  });

  it('наблюдение новее конца сжатия — снова процент', () => {
    const fresh = { ...fill, usedPercent: 12, at: '2026-10-15T10:06:00.000Z' };
    expect(contextView(fresh, { phase: null, finishedAt: '2026-10-15T10:05:00.000Z' })).toEqual({ context: fresh, compaction: null });
  });
});
```

В `packages/host/src/activity/activity-service.test.ts` после теста «2б: mailWaiting …» (~строка 237) добавить:

```ts
  it('2в: контекст — setContext уходит в метрики, setCompaction прячет старый процент до свежего наблюдения', async () => {
    const { ref } = await activeSession();
    const w = await works();
    const a = activity(w);
    await a.start();
    await settle();
    expect(a.get(ref)?.metrics?.context ?? null).toBeNull();

    const fill = { usedPercent: 82, windowTokens: 200_000, usedTokens: 164_000, at: '2026-10-15T10:00:00.000Z' };
    a.setContext(ref, fill);
    expect(a.get(ref)?.metrics).toMatchObject({ context: fill, compaction: null });
    const sent = activityChanges(ref).length;
    // То же значение — ни пересчёта, ни рассылки.
    a.setContext(ref, { ...fill });
    expect(activityChanges(ref)).toHaveLength(sent);

    a.setCompaction(ref, { phase: 'pending', finishedAt: null });
    expect(a.get(ref)?.metrics).toMatchObject({ context: fill, compaction: 'pending' });
    a.setCompaction(ref, { phase: null, finishedAt: '2026-10-15T10:05:00.000Z' });
    expect(a.get(ref)?.metrics).toMatchObject({ context: null, compaction: 'compacted' });
    a.setContext(ref, { ...fill, usedPercent: 12, at: '2026-10-15T10:06:00.000Z' });
    expect(a.get(ref)?.metrics).toMatchObject({ context: { usedPercent: 12 }, compaction: null });
  });

  it('2г: codexCompactedAt у сессии Claude — null', async () => {
    const { ref } = await activeSession();
    const w = await works();
    const a = activity(w);
    await a.start();
    await settle();
    expect(a.codexCompactedAt(ref)).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @parley/host exec vitest run src/compaction/context-view.test.ts src/activity/activity-service.test.ts`
Expected: FAIL — нет модуля `./context-view.js`, у `ActivityService` нет `setContext`.

- [ ] **Step 3: Write minimal implementation**

`packages/protocol/src/types.ts`: в импорт из `@parley/core` (строка 1) добавить `ContextFill`; перед `export interface LiveMetrics` добавить:

```ts
/**
 * Сжатие контекста сессии (спека 2026-10-15, 5.6): просьба ждёт, пока агент освободится; идёт; закончено, а новой
 * цифры заполненности ещё нет.
 */
export type CompactionPhase = 'pending' | 'running' | 'compacted';
```

и в `LiveMetrics` после `mailWaiting?: MailWait | null;`:

```ts
  /**
   * Заполненность контекста сейчас (спека 2026-10-15, 4.3); `null` — неизвестно. Поля нет у хоста более ранней
   * версии: окно чипа не показывает.
   */
  context?: ContextFill | null;
  /** Сжатие контекста (спека 5.6); `null` — ничего. Поля нет у хоста более ранней версии. */
  compaction?: CompactionPhase | null;
```

`packages/protocol/src/index.ts` экспортирует типы списком (`export type { … } from './types.js'`) — добавить в список `CompactionPhase`.

`packages/host/src/compaction/context-view.ts`:

```ts
/**
 * Что окно видит о контексте сессии (спека 2026-10-15, 4.4 и 5.6): пока сжатие ждёт или идёт — фаза и прежняя цифра;
 * после конца сжатия прежняя цифра не показывается, пока не придёт наблюдение новее (`compacted`) — иначе человек
 * увидел бы те же «92 %» и решил бы, что сжатие не сработало.
 */

import type { ContextFill } from '@parley/core';
import type { CompactionPhase } from '@parley/protocol';

/** Что хост знает о сжатии сессии: фаза просьбы и ISO-время конца последнего сжатия. */
export interface CompactionTrack {
  phase: 'pending' | 'running' | null;
  finishedAt: string | null;
}

export function contextView(
  fill: ContextFill | null,
  track: CompactionTrack | undefined,
): { context: ContextFill | null; compaction: CompactionPhase | null } {
  if (track?.phase === 'pending' || track?.phase === 'running') return { context: fill, compaction: track.phase };
  const finished = track?.finishedAt == null ? Number.NaN : Date.parse(track.finishedAt);
  if (!Number.isNaN(finished) && (fill === null || Date.parse(fill.at) < finished)) {
    return { context: null, compaction: 'compacted' };
  }
  return { context: fill, compaction: null };
}
```

`packages/host/src/activity/activity-service.ts`:

1. Импорты: `ContextFill` — в импорт типов из `@parley/core`; `import { contextView, type CompactionTrack } from '../compaction/context-view.js';`
2. В интерфейс `ActivityService` после `mailWaiting(…)`:

```ts
  /** Заполненность контекста Claude/GLM из файла строки статуса (`ContextService`); `null` — файла нет. */
  setContext(ref: SessionRef, fill: ContextFill | null): void;
  /** Сжатие сессии (`CompactionService`): фаза просьбы и конец последнего сжатия. */
  setCompaction(ref: SessionRef, track: CompactionTrack): void;
  /** Время последней записи `compacted` в rollout-логе Codex; не Codex или записи нет — `null`. */
  codexCompactedAt(ref: SessionRef): string | null;
```

3. Рядом с `const mailWaits = new Map<string, MailWait>();` (~строка 295):

```ts
  const contexts = new Map<string, ContextFill>();
  const compactions = new Map<string, CompactionTrack>();
```

4. В `metricsFor` перед `return {` добавить, а в возвращаемый объект после `mailWaiting: …` — два поля:

```ts
    // Codex — из индекса лога; Claude и GLM — из файла строки статуса (`ContextService`).
    const fill = session.provider === 'codex' ? (indexed?.context ?? null) : (contexts.get(key) ?? null);
    const view = contextView(fill, compactions.get(key));
```

```ts
      context: view.context,
      compaction: view.compaction,
```

5. В уборке ключей удалённых сессий (рядом с циклом по `mailWaits.keys()` ~строка 854) добавить такие же циклы для `contexts` и `compactions`:

```ts
    for (const key of Array.from(contexts.keys())) {
      if (!validSessions.has(key)) contexts.delete(key);
    }
    for (const key of Array.from(compactions.keys())) {
      if (!validSessions.has(key)) compactions.delete(key);
    }
```

6. В объект сервиса рядом с `mailWaiting(ref, reason) { … }`:

```ts
    setContext(ref, fill) {
      const key = refKey(ref);
      if (JSON.stringify(contexts.get(key) ?? null) === JSON.stringify(fill)) return;
      if (fill === null) contexts.delete(key);
      else contexts.set(key, fill);
      recompute(ref);
    },
    setCompaction(ref, track) {
      const key = refKey(ref);
      if (JSON.stringify(compactions.get(key) ?? null) === JSON.stringify(track)) return;
      if (track.phase === null && track.finishedAt === null) compactions.delete(key);
      else compactions.set(key, track);
      recompute(ref);
    },
    codexCompactedAt(ref) {
      const session = works.entry(ref.projectPath, ref.workId)?.map.sessions.find((item) => item.id === ref.sessionId);
      if (session === undefined || session.provider !== 'codex') return null;
      return logIndex.index(session)?.compactedAt ?? null;
    },
```

Имя переменной сервиса работ внутри `createActivityService` сверить с тем, что использует `recompute` (строка 678, `works.entry(...)`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/core build && pnpm --filter @parley/protocol build && pnpm --filter @parley/host exec vitest run src/compaction/context-view.test.ts src/activity/activity-service.test.ts`
Expected: PASS. Затем `pnpm --filter @parley/host test` — PASS (поддельные `ActivityService` в чужих тестах, объявленные через `as unknown as ActivityService`, новых методов не требуют; объявленные полным литералом — дополнить заглушками `setContext: () => undefined, setCompaction: () => undefined, codexCompactedAt: () => null`).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/types.ts packages/protocol/src/index.ts packages/host/src/compaction/context-view.ts packages/host/src/compaction/context-view.test.ts packages/host/src/activity/activity-service.ts packages/host/src/activity/activity-service.test.ts
git commit -m "feat(host): заполненность контекста и фаза сжатия в живых метриках

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Хост — опрос файлов контекста (`ContextService`)

**Files:**
- Create: `packages/host/src/context/context-service.ts`
- Create: `packages/host/src/context/context-service.test.ts`
- Modify: `packages/host/src/host.ts` (после создания `wakeService`, ~строка 296)

**Interfaces:**
- Consumes: `readContextFill`, `workPaths` (`@parley/core`); `ActivityService.setContext` (задача 4); `PtyManager.list()` (`PtyHandle.ref`, `PtyHandle.provider`).
- Produces: `createContextService(deps): ContextService`, `ContextService { start(): void; stop(): void; tick(): Promise<void> }`, `CONTEXT_POLL_MS = 5_000`.

- [ ] **Step 1: Write the failing test**

`packages/host/src/context/context-service.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextFile, workPaths } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { PtyHandle } from '../pty/pty-manager.js';
import { CONTEXT_POLL_MS, createContextService } from './context-service.js';

const FILL = { usedPercent: 41.5, windowTokens: 200_000, usedTokens: 83_000, at: '2026-10-15T10:00:00.000Z' };

describe('createContextService (спека 4.3)', () => {
  let project = '';
  let claude: SessionRef;
  let codex: SessionRef;

  beforeEach(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'parley-context-service-'));
    claude = { projectPath: project, workId: 'w-01', sessionId: 's-01' };
    codex = { projectPath: project, workId: 'w-01', sessionId: 's-02' };
    await mkdir(workPaths(project, 'w-01').context, { recursive: true });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(project, { recursive: true, force: true });
  });

  const handles = (): PtyHandle[] =>
    [
      { ref: claude, provider: 'claude' },
      { ref: codex, provider: 'codex' },
    ] as unknown as PtyHandle[];

  it('файл запущенной сессии не-Codex — в setContext; Codex не читается', async () => {
    await writeFile(contextFile(workPaths(project, 'w-01').dir, 's-01'), JSON.stringify(FILL));
    const setContext = vi.fn();
    await createContextService({ pty: { list: handles }, activity: { setContext } }).tick();
    expect(setContext).toHaveBeenCalledTimes(1);
    expect(setContext).toHaveBeenCalledWith(claude, FILL);
  });

  it('файла нет — setContext(ref, null)', async () => {
    const setContext = vi.fn();
    await createContextService({ pty: { list: handles }, activity: { setContext } }).tick();
    expect(setContext).toHaveBeenCalledWith(claude, null);
  });

  it('start опрашивает раз в CONTEXT_POLL_MS, stop прекращает', async () => {
    vi.useFakeTimers();
    const setContext = vi.fn();
    const read = vi.fn(async () => FILL);
    const service = createContextService({ pty: { list: handles }, activity: { setContext }, read });
    service.start();
    await vi.advanceTimersByTimeAsync(CONTEXT_POLL_MS);
    expect(read).toHaveBeenCalledTimes(1);
    service.stop();
    await vi.advanceTimersByTimeAsync(CONTEXT_POLL_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @parley/host exec vitest run src/context/context-service.test.ts`
Expected: FAIL — нет модуля `./context-service.js`.

- [ ] **Step 3: Write minimal implementation**

`packages/host/src/context/context-service.ts`:

```ts
/**
 * Опрос заполненности контекста (спека 2026-10-15, 4.3): раз в 5 секунд хост перечитывает `context/<сессия>.json`
 * каждой запущенной сессии не-Codex (Claude Code, GLM) и отдаёт значение `ActivityService.setContext` — тот
 * пересчитывает метрики только при изменении. Файл пишет строка статуса, а не хук: без опроса значение после
 * последнего ответа могло бы ждать следующего события. У Codex процент — из индекса лога, здесь он не читается.
 */

import { readContextFill, workPaths, type ContextFill } from '@parley/core';
import type { ActivityService } from '../activity/activity-service.js';
import type { PtyManager } from '../pty/pty-manager.js';

export const CONTEXT_POLL_MS = 5_000;

export interface ContextService {
  start(): void;
  stop(): void;
  /** Один проход опроса; тестам и первому чтению. */
  tick(): Promise<void>;
}

export function createContextService(deps: {
  pty: Pick<PtyManager, 'list'>;
  activity: Pick<ActivityService, 'setContext'>;
  read?: (workDir: string, sessionId: string) => Promise<ContextFill | null>;
  intervalMs?: number;
}): ContextService {
  const read = deps.read ?? readContextFill;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    const handles = deps.pty.list().filter((handle) => handle.provider !== 'codex');
    await Promise.all(
      handles.map(async ({ ref }) => {
        deps.activity.setContext(ref, await read(workPaths(ref.projectPath, ref.workId).dir, ref.sessionId));
      }),
    );
  };

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        // Медленный диск: следующий проход не начинается поверх незаконченного.
        if (inFlight) return;
        inFlight = true;
        void tick()
          .catch(() => undefined)
          .finally(() => {
            inFlight = false;
          });
      }, deps.intervalMs ?? CONTEXT_POLL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
```

В `packages/host/src/host.ts`: импорт `import { createContextService } from './context/context-service.js';`; после `handle.context.onShutdown(async () => wakeService.stop());` добавить:

```ts
  // Заполненность контекста Claude/GLM (спека 2026-10-15, 4.3): опрос файлов строки статуса раз в 5 секунд.
  const contextService = createContextService({ pty: ptyManager, activity: activityService });
  contextService.start();
  handle.context.onShutdown(async () => contextService.stop());
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/host exec vitest run src/context/context-service.test.ts && pnpm --filter @parley/host test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/context/context-service.ts packages/host/src/context/context-service.test.ts packages/host/src/host.ts
git commit -m "feat(host): опрос файлов заполненности контекста Claude и GLM

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Хост — сервис сжатия (`CompactionService`)

**Files:**
- Create: `packages/host/src/compaction/compaction-service.ts`
- Create: `packages/host/src/compaction/compaction-service.test.ts`
- Modify: `packages/host/test/fake-pty.ts` (события `exit` и `emitExit`)
- Modify: `packages/protocol/src/types.ts` (`CompactResult`; `NoticeKind` += `'compact-cancelled' | 'compact-failed'`, ~строка 160-183)
- Modify: `packages/desktop/src/shared/strings.ts` (`NOTICE_DETAIL`, ~строка 2055)
- Modify: `packages/desktop/src/shared/strings.test.ts` (`NOTICE_KINDS`, ~строка 18)

**Interfaces:**
- Consumes: `ActivityService.get/onChange/onLogChange/setCompaction/codexCompactedAt` (задача 4), `CompactionTrack` (задача 4), `SwitchLock` (`host/src/sessions/sessions-service.ts:202`), `typeAndSubmit` (`host/src/pty/type-and-submit.ts:39`), `choiceInProgress` (`host/src/pty/effort-switch.ts:78`), `stripEscapes` (`host/src/pty/draft.ts:31`), `CODEX_SUBMIT_DELAY_MS`, `KEY_ENTER` (`host/src/pty/codex-input.ts`), `hookedSince` (`@parley/core`).
- Produces:
  - `type CompactResult = { state: 'started' | 'pending' } | { state: 'refused'; reason: 'unknown-screen' | 'asleep' }` (`@parley/protocol`)
  - `compactCommand(provider: string | null, instructions: string | null): string`; `MAX_INSTRUCTIONS = 1000`; `COMPACT_TIMEOUT_MS = 300_000`
  - `createCompactionService(deps: CompactionDeps): CompactionService`
  - `CompactionService { compact(ref, instructions: string | null): CompactResult; cancel(ref): boolean; holds(ref): boolean; onHook(ref, body: Record<string, unknown>): void; start(): void; stop(): void }`

- [ ] **Step 1: Расширить поддельный PTY**

В `packages/host/test/fake-pty.ts`: в интерфейс `FakePty` добавить `emitExit(ref: SessionRef): void;`; рядом с `draftListeners` завести `const exitListeners = new Set<(ref: SessionRef, exit: ExitInfo) => void>();` (тип `ExitInfo` импортировать из `../src/pty/pty-process.js`); в объект состояния:

```ts
    emitExit(ref) {
      state.live = false;
      for (const listener of exitListeners) listener(ref, { exitCode: 0, signal: null });
    },
```

и в `on(...)` перед строкой `if (event !== 'draft') return () => {};`:

```ts
      if (event === 'exit') {
        const typed = listener as (ref: SessionRef, exit: ExitInfo) => void;
        exitListeners.add(typed);
        return () => exitListeners.delete(typed);
      }
```

- [ ] **Step 2: Write the failing tests**

`packages/host/src/compaction/compaction-service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import { fakePty, type FakePty } from '../../test/fake-pty.js';
import { HostError } from '../errors.js';
import type { SwitchLock } from '../sessions/sessions-service.js';
import { compactCommand, createCompactionService, type CompactionDeps } from './compaction-service.js';
import type { CompactionTrack } from './context-view.js';

const ref: SessionRef = { projectPath: '/tmp/project', workId: 'w-01', sessionId: 's-01' };

describe('compactCommand (спека 5.3)', () => {
  it('фокус — одна строка без управляющих символов', () => {
    expect(compactCommand('claude', 'a\n\tb\x1b[31m c ')).toBe('/compact a b c');
  });
  it('пусто или null — голый /compact', () => {
    expect(compactCommand('claude', '   ')).toBe('/compact');
    expect(compactCommand('claude', null)).toBe('/compact');
  });
  it('Codex — всегда голый /compact', () => {
    expect(compactCommand('codex', 'focus')).toBe('/compact');
  });
  it('длиннее 1000 знаков — bad_request', () => {
    expect(compactCommand('claude', 'я'.repeat(1000))).toBe(`/compact ${'я'.repeat(1000)}`);
    expect(() => compactCommand('claude', 'я'.repeat(1001))).toThrow(HostError);
  });
});

describe('createCompactionService (спека 5.2–5.5)', () => {
  let pty: FakePty;
  let state: string;
  let lastEventAt: string | null;
  let held: boolean;
  let inFlight: boolean;
  let codexCompactedAt: string | null;
  let activityListeners: Array<(target: SessionRef) => void>;
  let logListeners: Array<() => void>;
  let tracks: CompactionTrack[];
  let notices: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    pty = fakePty();
    state = 'idle';
    lastEventAt = new Date(1000).toISOString();
    held = false;
    inFlight = false;
    codexCompactedAt = null;
    activityListeners = [];
    logListeners = [];
    tracks = [];
    notices = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function service() {
    const lock = Object.assign(
      <T,>(_target: SessionRef, run: () => Promise<T>): Promise<T> => {
        held = true;
        return run().finally(() => {
          held = false;
        });
      },
      { held: () => held },
    ) as unknown as SwitchLock;
    const deps: CompactionDeps = {
      host: {
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        broadcast: ((_event: string, data: { kind: string }) => {
          notices.push(data.kind);
        }) as unknown as CompactionDeps['host']['broadcast'],
      },
      pty: pty.manager,
      activity: {
        get: () => ({ activity: { activity: state, lastEventAt }, metrics: null }),
        onChange: (listener: (target: SessionRef) => void) => {
          activityListeners.push(listener);
          return () => undefined;
        },
        onLogChange: (listener: () => void) => {
          logListeners.push(listener);
          return () => undefined;
        },
        setCompaction: (_target: SessionRef, track: CompactionTrack) => {
          tracks.push(track);
        },
        codexCompactedAt: () => codexCompactedAt,
      } as unknown as CompactionDeps['activity'],
      exclusive: lock,
      wake: { inFlight: () => inFlight, enterDelayMs: 500 },
      timeoutMs: 60_000,
    };
    const created = createCompactionService(deps);
    created.start();
    return created;
  }
  const poke = (): void => {
    for (const listener of activityListeners) listener(ref);
  };
  const phase = () => tracks.at(-1)?.phase ?? null;

  it('свободный агент — печать `/compact <фокус>` и Enter, started, фаза running, замок взят', async () => {
    const s = service();
    expect(s.compact(ref, 'Focus on room "Auth"')).toEqual({ state: 'started' });
    expect(phase()).toBe('running');
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).toEqual(['/compact Focus on room "Auth"', '\r']);
    expect(s.holds(ref)).toBe(true);
    expect(held).toBe(true);
  });

  it('PostCompact — замок снят, конец сжатия записан', async () => {
    const s = service();
    s.compact(ref, null);
    await vi.advanceTimersByTimeAsync(500);
    s.onHook(ref, { hook_event_name: 'PostCompact', trigger: 'manual' });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.holds(ref)).toBe(false);
    expect(held).toBe(false);
    expect(tracks.at(-1)).toEqual({ phase: null, finishedAt: expect.any(String) });
  });

  it('PostCompact без просьбы (автосжатие CLI) — конец сжатия записан, фазы нет', () => {
    const s = service();
    s.onHook(ref, { hook_event_name: 'PostCompact', trigger: 'auto' });
    expect(tracks.at(-1)).toEqual({ phase: null, finishedAt: expect.any(String) });
    s.onHook(ref, { hook_event_name: 'Stop' });
    expect(tracks).toHaveLength(1);
  });

  it('занятый агент — pending; печать на первом idle', async () => {
    state = 'working';
    const s = service();
    expect(s.compact(ref, 'x')).toEqual({ state: 'pending' });
    expect(phase()).toBe('pending');
    expect(s.holds(ref)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pty.writes).toEqual([]);
    state = 'idle';
    poke();
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).toEqual(['/compact x', '\r']);
  });

  it.each([
    ['диалог на экране (blocked)', () => { state = 'blocked'; }, () => { state = 'idle'; }],
    ['черновик человека', () => { pty.humanDraft = true; }, () => { pty.humanDraft = false; }],
    ['смена модели или effort', () => { held = true; }, () => { held = false; }],
    ['указатель письма в полёте', () => { inFlight = true; }, () => { inFlight = false; }],
  ])('%s — ждёт и уходит, когда помеха снята', async (_name, set, clear) => {
    set();
    const s = service();
    expect(s.compact(ref, 'x').state).toBe('pending');
    poke();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pty.writes).toEqual([]);
    clear();
    poke();
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).toEqual(['/compact x', '\r']);
  });

  it('ни одного хука с запуска — refused unknown-screen; процесса нет — asleep', () => {
    lastEventAt = null;
    expect(service().compact(ref, 'x')).toEqual({ state: 'refused', reason: 'unknown-screen' });
    pty.live = false;
    expect(service().compact(ref, 'x')).toEqual({ state: 'refused', reason: 'asleep' });
  });

  it('Cancel снимает ждущую просьбу; без просьбы — false', async () => {
    state = 'working';
    const s = service();
    s.compact(ref, 'x');
    expect(s.cancel(ref)).toBe(true);
    expect(phase()).toBeNull();
    expect(s.holds(ref)).toBe(false);
    state = 'idle';
    poke();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pty.writes).toEqual([]);
    expect(s.cancel(ref)).toBe(false);
  });

  it('вторая просьба заменяет текст ждущей', async () => {
    state = 'working';
    const s = service();
    s.compact(ref, 'a');
    s.compact(ref, 'b');
    state = 'idle';
    poke();
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).toEqual(['/compact b', '\r']);
  });

  it('Codex — голый /compact и Enter через 60 мс', async () => {
    pty.provider = 'codex';
    const s = service();
    s.compact(ref, 'Focus');
    await vi.advanceTimersByTimeAsync(60);
    expect(pty.writes).toEqual(['/compact', '\r']);
  });

  it('Codex — конец по записи compacted новее печати; старая запись — не конец', async () => {
    pty.provider = 'codex';
    const s = service();
    s.compact(ref, null);
    await vi.advanceTimersByTimeAsync(60);
    codexCompactedAt = new Date(Date.now() - 60_000).toISOString();
    for (const listener of logListeners) listener();
    expect(s.holds(ref)).toBe(true);
    codexCompactedAt = new Date(Date.now() + 1_000).toISOString();
    for (const listener of logListeners) listener();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.holds(ref)).toBe(false);
    expect(tracks.at(-1)).toEqual({ phase: null, finishedAt: codexCompactedAt });
  });

  it('нет отчёта до таймаута — compact-failed, замок снят', async () => {
    const s = service();
    s.compact(ref, null);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.holds(ref)).toBe(false);
    expect(held).toBe(false);
    expect(notices).toEqual(['compact-failed']);
  });

  it('человек начал печатать в паузе перед Enter — compact-failed, Enter не ушёл', async () => {
    const s = service();
    s.compact(ref, null);
    pty.emitDraft(ref);
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).toEqual(['/compact']);
    expect(notices).toEqual(['compact-failed']);
    expect(s.holds(ref)).toBe(false);
  });

  it('процесс вышел, пока просьба ждала — compact-cancelled', () => {
    state = 'working';
    const s = service();
    s.compact(ref, 'x');
    pty.emitExit(ref);
    expect(notices).toEqual(['compact-cancelled']);
    expect(s.holds(ref)).toBe(false);
    expect(phase()).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @parley/host exec vitest run src/compaction/compaction-service.test.ts`
Expected: FAIL — нет модуля `./compaction-service.js`.

- [ ] **Step 4: Write minimal implementation**

`packages/protocol/src/types.ts`: в `NoticeKind` добавить `| 'compact-cancelled' | 'compact-failed'`; рядом с `SendResult` (~строка 209):

```ts
/**
 * Ответ `sessions.compact` (спека 2026-10-15, 5.1): напечатано сейчас; ждёт, пока агент освободится; отказ —
 * экран неизвестен (ни одного хука с запуска) или процесса нет.
 */
export type CompactResult =
  | { state: 'started' | 'pending' }
  | { state: 'refused'; reason: 'unknown-screen' | 'asleep' };
```

`packages/protocol/src/index.ts` — в список `export type { … } from './types.js'` добавить `CompactResult`.

`packages/desktop/src/shared/strings.ts`, в `NOTICE_DETAIL` после `'recipe-playbook-truncated': …`:

```ts
  'compact-cancelled': 'compaction cancelled — the agent stopped',
  'compact-failed': "compaction didn't go through — check the agent's terminal",
```

`packages/desktop/src/shared/strings.test.ts`, в конец массива `NOTICE_KINDS`: `'compact-cancelled', 'compact-failed',`.

`packages/host/src/compaction/compaction-service.ts`:

```ts
/**
 * Сжатие контекста по клику человека (спека 2026-10-15, 5): хост печатает агенту `/compact <фокус>`, когда тот
 * свободен, а до того держит просьбу (`pending`, одна на сессию). Сам хост сжатие не начинает. С печати и до конца
 * сжатия держит `sessions.exclusive` этой сессии — `pty.send`, будильник и смена модели/effort ему уступают;
 * ждущую просьбу будильник видит через `holds`. Конец сжатия — `PostCompact` (Claude, GLM), запись `compacted`
 * новее печати (Codex), выход процесса или таймаут.
 */

import { hookedSince } from '@parley/core';
import { refKey } from '@parley/protocol';
import type { CompactResult, NoticeKind, SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import { HostError } from '../errors.js';
import { CODEX_SUBMIT_DELAY_MS, KEY_ENTER } from '../pty/codex-input.js';
import { stripEscapes } from '../pty/draft.js';
import { choiceInProgress } from '../pty/effort-switch.js';
import type { PtyHandle, PtyManager } from '../pty/pty-manager.js';
import { typeAndSubmit } from '../pty/type-and-submit.js';
import type { SwitchLock } from '../sessions/sessions-service.js';
import type { WakeService } from '../wake/wake-service.js';
import type { CompactionTrack } from './context-view.js';

/** Сколько ждать отчёта о конце сжатия (спека 5.5). */
export const COMPACT_TIMEOUT_MS = 5 * 60_000;
/** Предел инструкции после очистки (спека 5.3). */
export const MAX_INSTRUCTIONS = 1000;

// Управляющие байты и DEL — в пробел: инструкция уходит одной строкой.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]+/g;

/** Строка команды: Codex — голый `/compact` (спека 2.7); фокус — одна строка до 1000 знаков, пусто — без фокуса. */
export function compactCommand(provider: string | null, instructions: string | null): string {
  if (provider === 'codex' || instructions === null) return '/compact';
  const line = stripEscapes(instructions).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (line.length > MAX_INSTRUCTIONS) throw new HostError('bad_request', 'instructions are longer than 1000 characters');
  return line === '' ? '/compact' : `/compact ${line}`;
}

export interface CompactionService {
  compact(ref: SessionRef, instructions: string | null): CompactResult;
  /** Снять ждущую просьбу; `false` — её нет или сжатие уже идёт. */
  cancel(ref: SessionRef): boolean;
  /** Просьба ждёт или сжатие идёт: будильник указатель этой сессии не печатает. */
  holds(ref: SessionRef): boolean;
  /** HTTP-хук сессии (тот же, что у ленты): `PostCompact` — конец сжатия. */
  onHook(ref: SessionRef, body: Record<string, unknown>): void;
  start(): void;
  stop(): void;
}

export interface CompactionDeps {
  host: Pick<HostContext, 'log' | 'broadcast'>;
  pty: PtyManager;
  activity: Pick<ActivityService, 'get' | 'onChange' | 'onLogChange' | 'setCompaction' | 'codexCompactedAt'>;
  exclusive: SwitchLock;
  wake: Pick<WakeService, 'inFlight' | 'enterDelayMs'>;
  timeoutMs?: number;
}

interface Running {
  ref: SessionRef;
  codex: boolean;
  /** Когда ушёл Enter; до этого запись `compacted` Codex — не наша. */
  submittedAt: number | null;
  done(): void;
}

export function createCompactionService(deps: CompactionDeps): CompactionService {
  const timeoutMs = deps.timeoutMs ?? COMPACT_TIMEOUT_MS;
  const pending = new Map<string, { ref: SessionRef; text: string }>();
  const running = new Map<string, Running>();
  /** Конец последнего сжатия сессии (ISO): окно прячет прежнюю цифру до наблюдения новее. */
  const finished = new Map<string, string>();
  const unsubscribe: Array<() => void> = [];

  const publish = (ref: SessionRef, phase: CompactionTrack['phase']): void =>
    deps.activity.setCompaction(ref, { phase, finishedAt: finished.get(refKey(ref)) ?? null });

  function notice(kind: NoticeKind, ref: SessionRef, text: string): void {
    deps.host.log.info('сжатие: уведомление', { kind, ref });
    deps.host.broadcast('host.notice', { kind, ref, text, at: new Date().toISOString() });
  }

  /** Свободен, без диалога и ползунка, без смены модели, поле ввода пусто, указатель письма не в полёте. */
  function ready(ref: SessionRef, handle: PtyHandle): boolean {
    const state = deps.activity.get(ref)?.activity.activity;
    if (state !== 'idle' && state !== 'unseen') return false;
    if (choiceInProgress(ref, { pty: deps.pty, switching: (target) => deps.exclusive.held(target) })) return false;
    if (handle.hasDraft()) return false;
    return !deps.wake.inFlight(ref);
  }

  function finish(ref: SessionRef, at: string | null): void {
    const key = refKey(ref);
    if (at !== null) finished.set(key, at);
    const entry = running.get(key);
    if (entry !== undefined) entry.done();
    else publish(ref, pending.has(key) ? 'pending' : null);
  }

  function begin(ref: SessionRef, handle: PtyHandle, text: string): void {
    const key = refKey(ref);
    let release: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entry: Running = { ref, codex: handle.provider === 'codex', submittedAt: null, done: () => release() };
    running.set(key, entry);
    publish(ref, 'running');

    const run = async (): Promise<void> => {
      const attempt = typeAndSubmit({ pty: deps.pty, enterDelayMs: deps.wake.enterDelayMs }, ref, text, true, {
        hostDraft: true,
        beforeEnter: () => deps.activity.get(ref)?.activity.activity !== 'blocked',
        ...(entry.codex ? { delayMs: CODEX_SUBMIT_DELAY_MS, submitKey: () => KEY_ENTER } : {}),
      });
      const outcome = await attempt.done;
      if (outcome !== 'submitted') {
        notice('compact-failed', ref, `compaction of ${ref.sessionId} was not sent (${outcome})`);
        return;
      }
      entry.submittedAt = Date.now();
      const timer = setTimeout(() => {
        notice('compact-failed', ref, `compaction of ${ref.sessionId} did not report back`);
        release();
      }, timeoutMs);
      try {
        await settled;
      } finally {
        clearTimeout(timer);
      }
    };

    let job: Promise<void>;
    try {
      job = deps.exclusive(ref, run);
    } catch (error) {
      job = Promise.reject(error);
    }
    void job
      .catch((error: unknown) => deps.host.log.warn('сжатие: сбой', { ref, error: String(error) }))
      .finally(() => {
        running.delete(key);
        publish(ref, pending.has(key) ? 'pending' : null);
      });
  }

  /** Ждущая просьба: процесса нет — снять с уведомлением; агент свободен — печатать. */
  function tryStart(ref: SessionRef): boolean {
    const key = refKey(ref);
    const request = pending.get(key);
    if (request === undefined || running.has(key)) return false;
    const handle = deps.pty.get(ref);
    if (handle === undefined) {
      pending.delete(key);
      publish(ref, null);
      notice('compact-cancelled', ref, `${ref.sessionId} stopped — compaction cancelled`);
      return false;
    }
    if (!ready(ref, handle)) return false;
    pending.delete(key);
    begin(ref, handle, request.text);
    return true;
  }

  return {
    compact(ref, instructions) {
      const handle = deps.pty.get(ref);
      if (handle === undefined) return { state: 'refused', reason: 'asleep' };
      const text = compactCommand(handle.provider, instructions);
      // Ни одного хука с запуска — что на экране, неизвестно (вопрос доверия к папке): как `pty.send`.
      if (!hookedSince(deps.activity.get(ref)?.activity, handle.startedAt)) return { state: 'refused', reason: 'unknown-screen' };
      const key = refKey(ref);
      if (running.has(key)) return { state: 'started' };
      pending.set(key, { ref, text });
      if (tryStart(ref)) return { state: 'started' };
      publish(ref, 'pending');
      return { state: 'pending' };
    },
    cancel(ref) {
      if (!pending.delete(refKey(ref))) return false;
      publish(ref, null);
      return true;
    },
    holds: (ref) => pending.has(refKey(ref)) || running.has(refKey(ref)),
    onHook(ref, body) {
      if (body['hook_event_name'] === 'PostCompact') finish(ref, new Date().toISOString());
    },
    start() {
      unsubscribe.push(
        deps.activity.onChange((ref) => {
          tryStart(ref);
        }),
        deps.pty.on('draft', (ref) => {
          tryStart(ref);
        }),
        deps.pty.on('host-draft', (ref) => {
          tryStart(ref);
        }),
        deps.pty.on('exit', (ref) => {
          const key = refKey(ref);
          if (pending.delete(key)) {
            publish(ref, null);
            notice('compact-cancelled', ref, `${ref.sessionId} stopped — compaction cancelled`);
          }
          running.get(key)?.done();
        }),
        deps.activity.onLogChange(() => {
          for (const entry of running.values()) {
            if (!entry.codex || entry.submittedAt === null) continue;
            const at = deps.activity.codexCompactedAt(entry.ref);
            if (at !== null && Date.parse(at) >= entry.submittedAt) finish(entry.ref, at);
          }
        }),
      );
    },
    stop() {
      for (const off of unsubscribe.splice(0)) off();
      for (const entry of running.values()) entry.done();
      pending.clear();
    },
  };
}
```

Сверить по месту: `KEY_ENTER` и `CODEX_SUBMIT_DELAY_MS` экспортируются из `codex-input.ts` (строки 20, 27); `choiceInProgress` принимает `{ pty, switching }` (`effort-switch.ts:78`); `HostContext.broadcast('host.notice', …)` — как в `sessions-service.ts:301`. Если `onChange` слушателя `ActivityService` получает `(ref, value)`, лишний аргумент не мешает.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @parley/protocol build && pnpm --filter @parley/host exec vitest run src/compaction/compaction-service.test.ts src/pty/send.test.ts && pnpm --filter @parley/desktop exec vitest run src/shared/strings.test.ts`
Expected: PASS (`send.test.ts` — что расширение `fake-pty` его не задело).

- [ ] **Step 6: Commit**

```bash
git add packages/host/src/compaction/compaction-service.ts packages/host/src/compaction/compaction-service.test.ts packages/host/test/fake-pty.ts packages/protocol/src/types.ts packages/protocol/src/index.ts packages/desktop/src/shared/strings.ts packages/desktop/src/shared/strings.test.ts
git commit -m "feat(host): сервис сжатия контекста — печать /compact, ожидание, замок и конец сжатия

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Хост — методы `sessions.compact`/`sessions.cancelCompact`, хуки и будильник

**Files:**
- Modify: `packages/protocol/src/methods.ts` (`METHODS` рядом со строкой 153, `Results` рядом со строкой 375)
- Create: `packages/host/src/compaction/compaction-methods.ts`
- Create: `packages/host/src/compaction/compaction-methods.test.ts`
- Modify: `packages/host/src/methods/index.ts` (`MethodDeps` ~56, `WORKS_GATED_METHODS` ~91-122, регистрация рядом со строкой 185)
- Modify: `packages/host/src/wake/wake-service.ts` (`WakeServiceOptions`, `choiceNow` ~259-262)
- Modify: `packages/host/src/wake/wake-service.test.ts`
- Modify: `packages/host/src/host.ts` (хук-сервер ~239, будильник ~289-296, обработчики ~326)

**Interfaces:**
- Consumes: `CompactionService` (задача 6), `CompactResult` (задача 6).
- Produces:
  - методы `sessions.compact({ ref, instructions: string | null }) → CompactResult` и `sessions.cancelCompact({ ref }) → { cancelled: boolean }`
  - `createCompactionMethods(compaction): { compact: Handler<'sessions.compact'>; cancel: Handler<'sessions.cancelCompact'> }`
  - `MethodDeps.compaction?: CompactionService`
  - `WakeServiceOptions.compacting?: (ref: SessionRef) => boolean`

- [ ] **Step 1: Write the failing tests**

`packages/host/src/compaction/compaction-methods.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import type { CompactionService } from './compaction-service.js';
import { createCompactionMethods } from './compaction-methods.js';

const ref: SessionRef = { projectPath: '/p', workId: 'w-01', sessionId: 's-01' };

describe('createCompactionMethods (спека 5.1)', () => {
  it('compact отдаёт ответ сервиса, cancelCompact — { cancelled }', async () => {
    const compaction = {
      compact: vi.fn(() => ({ state: 'pending' as const })),
      cancel: vi.fn(() => true),
    } as unknown as CompactionService;
    const methods = createCompactionMethods(compaction);
    await expect(Promise.resolve(methods.compact({ ref, instructions: 'x' }, undefined as never))).resolves.toEqual({ state: 'pending' });
    expect(compaction.compact).toHaveBeenCalledWith(ref, 'x');
    await expect(Promise.resolve(methods.cancel({ ref }, undefined as never))).resolves.toEqual({ cancelled: true });
  });
});
```

`Handler<M>` — `(params, request: RequestInfo) => Promise<Result<M>>` (`host/src/context.ts:27`), поэтому в тесте второй аргумент — `undefined as never`.

В `packages/host/src/wake/wake-service.test.ts` после теста «замок смены взят — указатель не печатается …» (~строка 372):

```ts
  it('сжатие держит сессию (спека 2026-10-15, 5.4) — указатель не печатается; отпустило — уходит сам', async () => {
    const { workId, sessionId } = await activeSession();
    let compacting = true;
    const { stream, pty } = await rig(sessionId, workId, {}, { compacting: () => compacting });
    const writes = spyWrites(pty);

    await sendLetter(workId, sessionId);
    await settle(400);
    expect(writes).toEqual([]);
    expect(stream()).not.toContain(pointer(1));

    compacting = false;
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
    expect(writes).toEqual([pointer(1), '\r']);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @parley/host exec vitest run src/compaction/compaction-methods.test.ts src/wake/wake-service.test.ts`
Expected: FAIL — нет модуля `./compaction-methods.js`; опции `compacting` у будильника нет (указатель уходит сразу).

- [ ] **Step 3: Write minimal implementation**

`packages/protocol/src/methods.ts`: в `METHODS` рядом с `'sessions.setEffort'`:

```ts
  'sessions.compact': z.object({ ref: sessionRef, instructions: z.string().max(8_000).nullable() }),
  'sessions.cancelCompact': z.object({ ref: sessionRef }),
```

в `interface Results` рядом с `'sessions.setEffort'` (импорт типа `CompactResult` из `./types.js` добавить к соседним):

```ts
  'sessions.compact': CompactResult;
  'sessions.cancelCompact': { cancelled: boolean };
```

`packages/host/src/compaction/compaction-methods.ts`:

```ts
/** Методы сжатия (спека 2026-10-15, 5.1): тонкая обёртка над `CompactionService`; зовёт только окно по клику человека. */

import type { Handler } from '../context.js';
import type { CompactionService } from './compaction-service.js';

export function createCompactionMethods(compaction: Pick<CompactionService, 'compact' | 'cancel'>): {
  compact: Handler<'sessions.compact'>;
  cancel: Handler<'sessions.cancelCompact'>;
} {
  return {
    compact: async ({ ref, instructions }) => compaction.compact(ref, instructions),
    cancel: async ({ ref }) => ({ cancelled: compaction.cancel(ref) }),
  };
}
```

`packages/host/src/methods/index.ts`:
1. Импорты: `import type { CompactionService } from '../compaction/compaction-service.js';` и `import { createCompactionMethods } from '../compaction/compaction-methods.js';`
2. В `MethodDeps` после `limits?: LimitsService;`:

```ts
  /** Сжатие контекста по клику человека (спека 2026-10-15); без него методов сжатия у хоста нет. */
  compaction?: CompactionService;
```

3. В `WORKS_GATED_METHODS` рядом с `'sessions.setEffort'`: `'sessions.compact', 'sessions.cancelCompact',`
4. Перед объектом обработчиков: `const compaction = deps.compaction === undefined ? null : createCompactionMethods(deps.compaction);` и в объект рядом с `'sessions.setEffort': …`:

```ts
    ...(compaction === null
      ? {}
      : {
          'sessions.compact': compaction.compact as AnyHandler,
          'sessions.cancelCompact': compaction.cancel as AnyHandler,
        }),
```

Если объект обработчиков — не литерал, куда можно вставить spread, а `Record`, заполняемый присваиваниями, добавить так же условно двумя присваиваниями.

`packages/host/src/wake/wake-service.ts`: в `WakeServiceOptions`:

```ts
  /** Сжатие контекста ждёт или идёт (`CompactionService.holds`, спека 2026-10-15, 5.4): указатель не печатается. */
  compacting?: (ref: SessionRef) => boolean;
```

и `choiceNow` (строки 259-262):

```ts
  /** Идёт смена модели или effort, открыт ползунок `/effort` (общая проверка с `pty.send`) или сжатие держит сессию. */
  const choiceNow = (ref: SessionRef): boolean =>
    options.compacting?.(ref) === true ||
    choiceInProgress(ref, { pty, switching: (target) => sessions.exclusive?.held(target) === true });
```

`packages/host/src/host.ts`:
1. Импорт `import { createCompactionService, type CompactionService } from './compaction/compaction-service.js';`
2. Перед `const hookServer = …` (строка 239):

```ts
  // Сжатие контекста (спека 2026-10-15, 5): создаётся после будильника, но хук-сервер и будильник видят его уже сейчас.
  let compactionService: CompactionService | undefined;
```

и сам хук-сервер:

```ts
  const hookServer = createHookServer({
    log,
    onHook: (request) => {
      compactionService?.onHook(request.ref, request.body);
      feedService.onHook(request);
    },
  });
```

3. Будильник — шестым аргументом опции:

```ts
  const wakeService = createWakeService(
    handle.context,
    worksService,
    activityService,
    ptyManager,
    sessionsService,
    { compacting: (ref) => compactionService?.holds(ref) === true },
  );
  handle.context.onShutdown(async () => wakeService.stop());

  compactionService = createCompactionService({
    host: handle.context,
    pty: ptyManager,
    activity: activityService,
    exclusive: sessionsService.exclusive,
    wake: wakeService,
  });
  compactionService.start();
  handle.context.onShutdown(async () => compactionService?.stop());
```

4. В `createHostHandlers({ … })` добавить `compaction: compactionService,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/protocol build && pnpm --filter @parley/host exec vitest run src/compaction src/wake/wake-service.test.ts && pnpm --filter @parley/host test && pnpm --filter @parley/protocol test`
Expected: PASS. Если тест протокола или хоста сверяет полный список методов (`supportedMethods`, снимок `METHODS`), добавить в ожидание `sessions.compact` и `sessions.cancelCompact`.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/methods.ts packages/host/src/compaction/compaction-methods.ts packages/host/src/compaction/compaction-methods.test.ts packages/host/src/methods/index.ts packages/host/src/wake/wake-service.ts packages/host/src/wake/wake-service.test.ts packages/host/src/host.ts
git commit -m "feat(host): методы sessions.compact и cancelCompact, PostCompact и будильник уступает сжатию

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Окно — тексты `S.context` и формат чипа

**Files:**
- Modify: `packages/desktop/src/shared/strings.ts` (новый раздел `context:` после `usage:`, ~строка 266)
- Create: `packages/desktop/src/renderer/lib/context-format.ts`
- Create: `packages/desktop/src/renderer/lib/context-format.test.ts`

**Interfaces:**
- Consumes: `ContextFill` (`@parley/core`), `CompactionPhase` (`@parley/protocol`), `knownTokens` (`renderer/lib/usage-format.ts:14`).
- Produces:
  - `S.context` (см. код ниже; ключи используются в задачах 9–11)
  - `CONTEXT_WARN_PERCENT = 60`, `CONTEXT_CRITICAL_PERCENT = 85`, `COMPACT_MAX_INSTRUCTIONS = 1000`
  - `type ContextLevel = 'normal' | 'warn' | 'critical'`; `contextLevel(percent: number): ContextLevel`
  - `LEVEL_CLASS: Record<ContextLevel, string>`, `BAR_CLASS: Record<ContextLevel, string>`
  - `percentText(percent: number): string`
  - `contextChipText(context: ContextFill | null, compaction: CompactionPhase | null): string`
  - `contextTooltip(context: ContextFill | null, compaction: CompactionPhase | null): string`
  - `contextNumbers(context: ContextFill | null): string`
  - `maxContext(contexts: ReadonlyArray<ContextFill | null | undefined>): number | null`

- [ ] **Step 1: Write the failing test**

`packages/desktop/src/renderer/lib/context-format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { S } from '../../shared/strings.js';
import {
  contextChipText,
  contextLevel,
  contextNumbers,
  contextTooltip,
  maxContext,
  percentText,
} from './context-format.js';
import { knownTokens } from './usage-format.js';

const FILL = { usedPercent: 82.4, windowTokens: 200_000, usedTokens: 164_800, at: '2026-10-15T10:00:00.000Z' };

describe('context-format (спека 3.1–3.3)', () => {
  it('пороги по округлённому проценту: < 60 нейтральный, 60–84 янтарный, ≥ 85 красный', () => {
    expect(contextLevel(59.4)).toBe('normal');
    expect(contextLevel(59.6)).toBe('warn');
    expect(contextLevel(84.4)).toBe('warn');
    expect(contextLevel(84.6)).toBe('critical');
    expect(contextLevel(100)).toBe('critical');
  });

  it('текст чипа: процент, нет данных, фазы сжатия', () => {
    expect(percentText(82.4)).toBe('82%');
    expect(contextChipText(FILL, null)).toBe('82%');
    expect(contextChipText(null, null)).toBe('—');
    expect(contextChipText(FILL, 'pending')).toBe('⏳');
    expect(contextChipText(FILL, 'running')).toBe('…');
    expect(contextChipText(null, 'compacted')).toBe('compacted');
  });

  it('тултип и числа поповера', () => {
    expect(contextTooltip(FILL, null)).toBe(`Context: ${knownTokens(164_800)} of ${knownTokens(200_000)} tokens`);
    expect(contextTooltip({ ...FILL, usedTokens: null }, null)).toBe('Context: 82% used');
    expect(contextTooltip(null, null)).toBe('No context data yet');
    expect(contextTooltip(FILL, 'pending')).toBe('Compaction queued — runs when the agent is free');
    expect(contextNumbers(FILL)).toBe(`${knownTokens(164_800)} of ${knownTokens(200_000)} tokens · 82%`);
    expect(contextNumbers(null)).toBe('—');
  });

  it('значок комнаты — наибольший известный процент', () => {
    expect(maxContext([FILL, { ...FILL, usedPercent: 41 }, null, undefined])).toBe(82.4);
    expect(maxContext([null, undefined])).toBeNull();
  });

  it('инструкции по умолчанию — с названием комнаты и сессии', () => {
    expect(S.context.roomDefault('Auth refactor')).toBe(
      'Focus on room "Auth refactor": the human\'s task, decisions made, open questions, who owns what, and files touched. Drop details unrelated to this room.',
    );
    expect(S.context.sessionDefault('S01 backend')).toBe(
      'Focus on "S01 backend": the current task, decisions made, open questions, and files touched. Drop unrelated details.',
    );
    expect(S.context.allResult(3, 1, 1)).toBe('Compacting 3 agents · 1 queued · 1 skipped');
    expect(S.context.allResult(1, 0, 0)).toBe('Compacting 1 agent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @parley/core build && pnpm --filter @parley/protocol build && pnpm --filter @parley/desktop exec vitest run src/renderer/lib/context-format.test.ts`
Expected: FAIL — нет модуля `./context-format.js`.

- [ ] **Step 3: Write minimal implementation**

`packages/desktop/src/shared/strings.ts`, после закрывающей скобки раздела `usage: { … },`:

```ts
  /** Заполненность контекста и сжатие (спека 2026-10-15, 3). Инструкции по умолчанию — текст для агента. */
  context: {
    marks: { unknown: '—', pending: '⏳', running: '…', compacted: 'compacted', asleep: 'asleep' },
    tooltip: {
      tokens: (used: string, window: string): string => `Context: ${used} of ${window} tokens`,
      percent: (percent: string): string => `Context: ${percent} used`,
      unknown: 'No context data yet',
      pending: 'Compaction queued — runs when the agent is free',
      running: 'Compacting…',
      compacted: 'Compacted — waiting for the next update',
    },
    title: (label: string): string => `Context · ${label}`,
    roomTitle: 'Context',
    roomChip: (value: string): string => `Ctx ${value}`,
    numbers: (used: string, window: string, percent: string): string => `${used} of ${window} tokens · ${percent}`,
    instructionsLabel: 'Focus instructions',
    codexNoFocus: 'Codex compacts without focus',
    compact: 'Compact',
    compactAll: 'Compact all',
    cancel: 'Cancel',
    compacting: 'Compacting…',
    compactAction: 'compact the context',
    cancelAction: 'cancel the compaction',
    refusedAsleep: (label: string): string => `${label} is asleep — nothing to compact`,
    refusedUnknownScreen: (label: string): string =>
      `Can't compact ${label} yet — it hasn't reported since launch. Check its terminal.`,
    allResult: (started: number, queued: number, skipped: number): string =>
      [
        `Compacting ${started} ${started === 1 ? 'agent' : 'agents'}`,
        ...(queued > 0 ? [`${queued} queued`] : []),
        ...(skipped > 0 ? [`${skipped} skipped`] : []),
      ].join(' · '),
    roomDefault: (title: string): string =>
      `Focus on room "${title}": the human's task, decisions made, open questions, who owns what, and files touched. Drop details unrelated to this room.`,
    sessionDefault: (name: string): string =>
      `Focus on "${name}": the current task, decisions made, open questions, and files touched. Drop unrelated details.`,
  },
```

`packages/desktop/src/renderer/lib/context-format.ts`:

```ts
/**
 * Формат заполненности контекста (спека 2026-10-15, 3.1–3.3): пороги цвета, текст чипа, тултип, числа поповера и
 * максимум для значка комнаты. Уровень считается по округлённому проценту: чип «60%» не бывает нейтральным.
 */

import type { ContextFill } from '@parley/core';
import type { CompactionPhase } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { knownTokens } from './usage-format.js';

const C = S.context;

export const CONTEXT_WARN_PERCENT = 60;
export const CONTEXT_CRITICAL_PERCENT = 85;
/** Предел инструкции — как у хоста (`MAX_INSTRUCTIONS`). */
export const COMPACT_MAX_INSTRUCTIONS = 1000;

export type ContextLevel = 'normal' | 'warn' | 'critical';

export function contextLevel(percent: number): ContextLevel {
  const rounded = Math.round(percent);
  if (rounded >= CONTEXT_CRITICAL_PERCENT) return 'critical';
  return rounded >= CONTEXT_WARN_PERCENT ? 'warn' : 'normal';
}

/** Чип: янтарный — `accent`, красный — `destructive`; нейтральный — как соседние чипы. */
export const LEVEL_CLASS: Record<ContextLevel, string> = {
  normal: '',
  warn: 'border-accent bg-accent-200 text-accent-800',
  critical: 'border-destructive text-destructive',
};

/** Полоса заполнения в списке комнаты. */
export const BAR_CLASS: Record<ContextLevel, string> = {
  normal: 'bg-[color-mix(in_srgb,currentColor_45%,transparent)]',
  warn: 'bg-accent',
  critical: 'bg-destructive',
};

export const percentText = (percent: number): string => `${Math.round(percent)}%`;

export function contextChipText(context: ContextFill | null, compaction: CompactionPhase | null): string {
  if (compaction !== null) return C.marks[compaction];
  return context === null ? C.marks.unknown : percentText(context.usedPercent);
}

const tokensKnown = (context: ContextFill): context is ContextFill & { usedTokens: number; windowTokens: number } =>
  context.usedTokens !== null && context.windowTokens !== null;

export function contextTooltip(context: ContextFill | null, compaction: CompactionPhase | null): string {
  if (compaction !== null) return C.tooltip[compaction];
  if (context === null) return C.tooltip.unknown;
  return tokensKnown(context)
    ? C.tooltip.tokens(knownTokens(context.usedTokens), knownTokens(context.windowTokens))
    : C.tooltip.percent(percentText(context.usedPercent));
}

export function contextNumbers(context: ContextFill | null): string {
  if (context === null) return C.marks.unknown;
  return tokensKnown(context)
    ? C.numbers(knownTokens(context.usedTokens), knownTokens(context.windowTokens), percentText(context.usedPercent))
    : percentText(context.usedPercent);
}

/** Значок комнаты: наибольший известный процент; никого — `null`. */
export function maxContext(contexts: ReadonlyArray<ContextFill | null | undefined>): number | null {
  const known = contexts.filter((context): context is ContextFill => context != null).map((context) => context.usedPercent);
  return known.length === 0 ? null : Math.max(...known);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @parley/desktop exec vitest run src/renderer/lib/context-format.test.ts src/shared/strings.test.ts`
Expected: PASS (страж английских текстов в `strings.test.ts` — тоже).

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/shared/strings.ts packages/desktop/src/renderer/lib/context-format.ts packages/desktop/src/renderer/lib/context-format.test.ts
git commit -m "feat(desktop): тексты и формат чипа заполненности контекста

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Окно — чип сессии с поповером сжатия (`ContextChip`)

**Files:**
- Create: `packages/desktop/src/renderer/components/context/compact-actions.ts`
- Create: `packages/desktop/src/renderer/components/context/CompactForm.tsx`
- Create: `packages/desktop/src/renderer/components/context/ContextChip.tsx`
- Create: `packages/desktop/src/renderer/components/context/ContextChip.test.tsx`

**Interfaces:**
- Consumes: `S.context`, `context-format` (задача 8); методы `sessions.compact`, `sessions.cancelCompact` (задача 7); `useHostSupports` (`renderer/lib/capabilities.ts:114`); `decodeIpcError` (`src/shared/ipc-error.ts`), `errorText` (`src/shared/strings.ts`); `Popover*`, `Button`, `Textarea` из `renderer/ui`.
- Produces:
  - `compactSession(bridge, ref, label, instructions, options?: { quiet?: boolean }): Promise<CompactResult | null>`; `cancelCompaction(bridge, ref): Promise<void>`
  - `CompactForm(props: { provider: string; defaultText: string; phase: CompactionPhase | null; onCompact(instructions: string | null): void; onCancel(): void })`
  - `ContextChip(props: ContextChipProps)`, `ContextChipProps { bridge; sessionRef; provider; label; running: boolean; context: ContextFill | null | undefined; compaction: CompactionPhase | null | undefined; defaultInstructions: string; testId: string; className?: string }`

- [ ] **Step 1: Write the failing test**

`packages/desktop/src/renderer/components/context/ContextChip.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { SessionRef } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { useHostStore } from '../../store/host.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { ContextChip, type ContextChipProps } from './ContextChip.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const ref: SessionRef = { projectPath: '/p', workId: 'w-01', sessionId: 's-01' };
const FILL = { usedPercent: 82.4, windowTokens: 200_000, usedTokens: 164_800, at: '2026-10-15T10:00:00.000Z' };
const DEFAULT = 'Focus on room "Auth": keep decisions.';
let bridge: FakeBridge;

beforeEach(() => {
  bridge = createFakeBridge();
  bridge.setHandler('sessions.compact', () => ({ state: 'started' }));
  bridge.setHandler('sessions.cancelCompact', () => ({ cancelled: true }));
  useHostStore.setState({
    status: { state: 'connected', hostVersion: 'fixture', methods: ['sessions.compact', 'sessions.cancelCompact'] },
    connections: 1,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const props = (patch: Partial<ContextChipProps> = {}): ContextChipProps => ({
  bridge,
  sessionRef: ref,
  provider: 'claude',
  label: 'S01 backend',
  running: true,
  context: FILL,
  compaction: null,
  defaultInstructions: DEFAULT,
  testId: 'ctx',
  ...patch,
});
const compactCalls = () => bridge.calls.filter((call) => call.method === 'sessions.compact');

describe('ContextChip (спека 3.2, 3.4)', () => {
  it('процент и уровень по порогам', () => {
    const { rerender } = render(<ContextChip {...props()} />);
    expect(screen.getByTestId('ctx').textContent).toBe('82%');
    expect(screen.getByTestId('ctx').dataset.level).toBe('warn');
    rerender(<ContextChip {...props({ context: { ...FILL, usedPercent: 85 } })} />);
    expect(screen.getByTestId('ctx').dataset.level).toBe('critical');
    rerender(<ContextChip {...props({ context: { ...FILL, usedPercent: 59.4 } })} />);
    expect(screen.getByTestId('ctx').dataset.level).toBe('normal');
  });

  it('состояния сжатия и «нет данных»', () => {
    const { rerender } = render(<ContextChip {...props({ compaction: 'pending' })} />);
    expect(screen.getByTestId('ctx').textContent).toBe('⏳');
    rerender(<ContextChip {...props({ compaction: 'running' })} />);
    expect(screen.getByTestId('ctx').textContent).toBe('…');
    rerender(<ContextChip {...props({ context: null, compaction: 'compacted' })} />);
    expect(screen.getByTestId('ctx').textContent).toBe('compacted');
    rerender(<ContextChip {...props({ context: null })} />);
    expect(screen.getByTestId('ctx').textContent).toBe('—');
  });

  it('спящая сессия или хост без поля context — чипа нет', () => {
    const { rerender } = render(<ContextChip {...props({ running: false })} />);
    expect(screen.queryByTestId('ctx')).toBeNull();
    rerender(<ContextChip {...props({ context: undefined, compaction: undefined })} />);
    expect(screen.queryByTestId('ctx')).toBeNull();
  });

  it('Compact — sessions.compact с правленой инструкцией', async () => {
    render(<ContextChip {...props()} />);
    fireEvent.click(screen.getByTestId('ctx'));
    const field = screen.getByTestId('compact-instructions') as HTMLTextAreaElement;
    expect(field.value).toBe(DEFAULT);
    expect(field.maxLength).toBe(1000);
    fireEvent.change(field, { target: { value: 'Keep the API decisions' } });
    fireEvent.click(screen.getByTestId('compact-submit'));
    await waitFor(() =>
      expect(compactCalls()).toEqual([{ method: 'sessions.compact', params: { ref, instructions: 'Keep the API decisions' } }]),
    );
  });

  it('пустое поле — instructions: null; Codex — поле неактивно и null', async () => {
    const { unmount } = render(<ContextChip {...props()} />);
    fireEvent.click(screen.getByTestId('ctx'));
    fireEvent.change(screen.getByTestId('compact-instructions'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('compact-submit'));
    await waitFor(() => expect(compactCalls().at(-1)?.params).toEqual({ ref, instructions: null }));
    unmount();

    render(<ContextChip {...props({ provider: 'codex' })} />);
    fireEvent.click(screen.getByTestId('ctx'));
    expect((screen.getByTestId('compact-instructions') as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText(S.context.codexNoFocus)).toBeTruthy();
    fireEvent.click(screen.getByTestId('compact-submit'));
    await waitFor(() => expect(compactCalls().at(-1)?.params).toEqual({ ref, instructions: null }));
  });

  it('ждёт — Cancel зовёт cancelCompact; идёт — кнопка неактивна', async () => {
    const { unmount } = render(<ContextChip {...props({ compaction: 'pending' })} />);
    fireEvent.click(screen.getByTestId('ctx'));
    fireEvent.click(screen.getByTestId('compact-cancel'));
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'sessions.cancelCompact')).toBe(true));
    unmount();

    render(<ContextChip {...props({ compaction: 'running' })} />);
    fireEvent.click(screen.getByTestId('ctx'));
    expect((screen.getByTestId('compact-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('хост без sessions.compact — числа есть, формы нет', () => {
    useHostStore.setState({ status: { state: 'connected', hostVersion: 'fixture', methods: [] }, connections: 1 });
    render(<ContextChip {...props()} />);
    fireEvent.click(screen.getByTestId('ctx'));
    expect(screen.getByTestId('ctx-popover').textContent).toContain('82%');
    expect(screen.queryByTestId('compact-submit')).toBeNull();
  });

  it('отказ unknown-screen — тост с причиной', async () => {
    bridge.setHandler('sessions.compact', () => ({ state: 'refused', reason: 'unknown-screen' }));
    render(<ContextChip {...props()} />);
    fireEvent.click(screen.getByTestId('ctx'));
    fireEvent.click(screen.getByTestId('compact-submit'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(S.context.refusedUnknownScreen('S01 backend')));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @parley/desktop exec vitest run src/renderer/components/context/ContextChip.test.tsx`
Expected: FAIL — нет модуля `./ContextChip.js`.

- [ ] **Step 3: Write minimal implementation**

`packages/desktop/src/renderer/components/context/compact-actions.ts`:

```ts
/**
 * Вызовы сжатия из окна (спека 2026-10-15, 5.1): только по клику человека. Отказ хоста и ошибка — тост; `quiet`
 * гасит тосты отказов, когда итог показывает `Compact all` одним тостом.
 */

import { toast } from 'sonner';
import type { CompactResult, SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';

export async function compactSession(
  bridge: ParleyBridge,
  ref: SessionRef,
  label: string,
  instructions: string | null,
  options: { quiet?: boolean } = {},
): Promise<CompactResult | null> {
  try {
    const result = await bridge.call('sessions.compact', { ref, instructions });
    if (result.state === 'refused' && options.quiet !== true) {
      toast(result.reason === 'asleep' ? S.context.refusedAsleep(label) : S.context.refusedUnknownScreen(label));
    }
    return result;
  } catch (error) {
    toast(errorText(decodeIpcError(error).code, S.context.compactAction));
    return null;
  }
}

export async function cancelCompaction(bridge: ParleyBridge, ref: SessionRef): Promise<void> {
  try {
    await bridge.call('sessions.cancelCompact', { ref });
  } catch (error) {
    toast(errorText(decodeIpcError(error).code, S.context.cancelAction));
  }
}
```

(`errorText` — экспорт `strings.ts`, строка ~2038; если он объявлен в другом модуле, импортировать оттуда, как в `RoomPanel.tsx`.)

`packages/desktop/src/renderer/components/context/CompactForm.tsx`:

```tsx
/**
 * Форма сжатия одной сессии (спека 2026-10-15, 3.2): поле с готовой инструкцией, Compact / Cancel. Текст живёт, пока
 * открыт поповер: форма монтируется заново при каждом открытии. У Codex поле неактивно — его `/compact` без фокуса.
 */

import { useState } from 'react';
import type { CompactionPhase } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { COMPACT_MAX_INSTRUCTIONS } from '../../lib/context-format.js';
import { Button } from '../../ui/button.js';
import { Textarea } from '../../ui/textarea.js';

const C = S.context;

export interface CompactFormProps {
  provider: string;
  defaultText: string;
  phase: CompactionPhase | null;
  onCompact: (instructions: string | null) => void;
  onCancel: () => void;
}

export function CompactForm({ provider, defaultText, phase, onCompact, onCancel }: CompactFormProps): JSX.Element {
  const codex = provider === 'codex';
  const [text, setText] = useState(defaultText);
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">{C.instructionsLabel}</span>
        <Textarea
          data-testid="compact-instructions"
          value={codex ? '' : text}
          disabled={codex}
          maxLength={COMPACT_MAX_INSTRUCTIONS}
          rows={4}
          onChange={(event) => setText(event.target.value)}
          className="resize-none text-xs"
        />
      </label>
      {codex ? <p className="m-0 text-muted-foreground">{C.codexNoFocus}</p> : null}
      <div className="flex justify-end">
        {phase === 'pending' ? (
          <Button type="button" size="xs" variant="outline" data-testid="compact-cancel" onClick={onCancel}>
            {C.cancel}
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            data-testid="compact-submit"
            disabled={phase === 'running'}
            onClick={() => onCompact(codex || text.trim() === '' ? null : text)}
          >
            {phase === 'running' ? C.compacting : C.compact}
          </Button>
        )}
      </div>
    </div>
  );
}
```

`packages/desktop/src/renderer/components/context/ContextChip.tsx`:

```tsx
/**
 * Чип заполненности контекста одной сессии (спека 2026-10-15, 3.2 и 3.4): процент с цветом по порогу, состояние
 * сжатия, по клику — поповер с числами и формой сжатия. Спящая сессия и хост без поля `context` — чипа нет; хост без
 * `sessions.compact` — поповер без формы. Используется на карточке участника комнаты и в тулбаре Chat.
 */

import type { ContextFill } from '@parley/core';
import type { CompactionPhase, SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { useHostSupports } from '../../lib/capabilities.js';
import { cn } from '../../lib/cn.js';
import { contextChipText, contextLevel, contextNumbers, contextTooltip, LEVEL_CLASS } from '../../lib/context-format.js';
import { Button } from '../../ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover.js';
import { cancelCompaction, compactSession } from './compact-actions.js';
import { CompactForm } from './CompactForm.js';

export interface ContextChipProps {
  bridge: ParleyBridge;
  sessionRef: SessionRef;
  provider: string;
  /** Подпись в поповере и тостах: `S01 backend`. */
  label: string;
  /** Процесс запущен (`lifecycle === 'active'`). */
  running: boolean;
  /** `undefined` — хост не сообщает заполненность (старее). */
  context: ContextFill | null | undefined;
  compaction: CompactionPhase | null | undefined;
  defaultInstructions: string;
  testId: string;
  className?: string;
}

export function ContextChip({
  bridge,
  sessionRef,
  provider,
  label,
  running,
  context,
  compaction,
  defaultInstructions,
  testId,
  className,
}: ContextChipProps): JSX.Element | null {
  const supported = useHostSupports('sessions.compact');
  if (!running || (context === undefined && compaction === undefined)) return null;
  const fill = context ?? null;
  const phase = compaction ?? null;
  const level = fill === null || phase !== null ? 'normal' : contextLevel(fill.usedPercent);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid={testId}
          data-level={level}
          title={contextTooltip(fill, phase)}
          className={cn('shrink-0 font-mono tabular-nums', LEVEL_CLASS[level], className)}
        >
          {contextChipText(fill, phase)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" data-testid={`${testId}-popover`} className="w-[min(360px,calc(100vw-32px))] p-3 text-xs">
        <p className="m-0 mb-1 truncate font-medium" title={label}>
          {S.context.title(label)}
        </p>
        <p className="m-0 mb-2 text-muted-foreground">{contextNumbers(fill)}</p>
        {supported ? (
          <CompactForm
            provider={provider}
            defaultText={defaultInstructions}
            phase={phase}
            onCompact={(instructions) => void compactSession(bridge, sessionRef, label, instructions)}
            onCancel={() => void cancelCompaction(bridge, sessionRef)}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
```

Хук `useHostSupports` стоит до раннего `return null` — правило хуков соблюдено.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @parley/desktop exec vitest run src/renderer/components/context/ContextChip.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/components/context
git commit -m "feat(desktop): чип контекста сессии с поповером сжатия

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Окно — комната: чип на карточке и значок `Ctx` с `Compact all`

**Files:**
- Modify: `packages/desktop/src/renderer/components/rooms/feed-model.ts:52-91` (`ParticipantModel`), участники ~262-295
- Modify: `packages/desktop/src/renderer/components/rooms/feed-model.test.ts`
- Modify: `packages/desktop/src/renderer/components/rooms/ParticipantStrip.tsx`
- Modify: `packages/desktop/src/renderer/components/rooms/ParticipantStrip.test.tsx`
- Create: `packages/desktop/src/renderer/components/rooms/RoomContextChip.tsx`
- Create: `packages/desktop/src/renderer/components/rooms/RoomContextChip.test.tsx`
- Modify: `packages/desktop/src/renderer/components/rooms/RoomHeader.tsx`
- Modify: `packages/desktop/src/renderer/components/rooms/RoomPanel.tsx:435`

**Interfaces:**
- Consumes: `ContextChip`, `compactSession`, `cancelCompaction` (задача 9); `S.context`, `context-format` (задача 8).
- Produces:
  - `ParticipantModel.context?: ContextFill | null` (`undefined` — хост не сообщает), `ParticipantModel.compaction?: CompactionPhase | null`
  - `ParticipantStripProps.contextChip?: (participant: ParticipantModel) => ReactNode`
  - `RoomHeaderProps.contextChip?: ReactNode`, `RoomHeaderProps.participantContext?: (participant: ParticipantModel) => ReactNode`
  - `RoomContextChip(props: { bridge: ParleyBridge; roomTitle: string; participants: readonly ParticipantModel[] })`

- [ ] **Step 1: Write the failing tests**

В `packages/desktop/src/renderer/components/rooms/feed-model.test.ts` (импортировать `makeActivity`, `activityMap` из `../../test-utils/work-fixtures.js`, если их там ещё нет):

```ts
describe('контекст участника (спека 2026-10-15, 3.2)', () => {
  const FILL = { usedPercent: 82, windowTokens: 200_000, usedTokens: 164_000, at: '2026-10-15T10:00:00.000Z' };
  const metrics = { tokensIn: 1, tokensOut: 1, durationMs: null, unread: 0, subagents: 0, model: null, context: FILL, compaction: 'pending' as const };
  const refOf = (sessionId: string) => ({ projectPath: PROJECT, workId: 'w-01', sessionId });

  it('у живого — из метрик; у спящего — null', () => {
    const list = sessions();
    list[1] = { ...list[1]!, lifecycle: 'sleeping' };
    const model = build(
      entryOf({ sessions: list }),
      activityMap(makeActivity(refOf('s-01'), 'idle', { metrics }), makeActivity(refOf('s-02'), 'idle', { metrics })),
    );
    const byId = Object.fromEntries(model.participants.map((p) => [p.id, p]));
    expect(byId['s-01']).toMatchObject({ context: FILL, compaction: 'pending' });
    expect(byId['s-02']).toMatchObject({ context: null, compaction: null });
  });

  it('метрик без поля context (старый хост) — context undefined', () => {
    const { context: _drop, compaction: _drop2, ...old } = metrics;
    const model = build(entryOf(), activityMap(makeActivity(refOf('s-01'), 'idle', { metrics: old })));
    expect(model.participants.find((p) => p.id === 's-01')?.context).toBeUndefined();
  });
});
```

Сигнатуру `activityMap` сверить с `test-utils/work-fixtures.ts` (принимает записи списком или массивом) и подогнать вызов.

В `packages/desktop/src/renderer/components/rooms/ParticipantStrip.test.tsx`:

```tsx
describe('чип контекста (спека 2026-10-15, 3.2)', () => {
  it('чип во второй строке вне кнопки открытия; клик по «чем занят» открывает сессию', () => {
    const onOpen = vi.fn();
    render(
      <ParticipantStrip
        participants={[participant({ doing: 'Пишет миграции' })]}
        onOpenSession={onOpen}
        contextChip={() => <span data-testid="ctx">82%</span>}
      />,
    );
    expect(screen.getByTestId('ctx').closest('button')).toBeNull();
    fireEvent.click(screen.getByText('Пишет миграции'));
    expect(onOpen.mock.calls[0]?.[0]).toBe('s-01');
  });

  it('без contextChip или с null — прежняя разметка: одна кнопка на обе строки', () => {
    const { unmount } = render(<ParticipantStrip participants={[participant()]} onOpenSession={vi.fn()} />);
    expect(document.querySelectorAll('[data-participant="s-01"] button')).toHaveLength(1);
    unmount();
    render(<ParticipantStrip participants={[participant()]} onOpenSession={vi.fn()} contextChip={() => null} />);
    expect(document.querySelectorAll('[data-participant="s-01"] button')).toHaveLength(1);
  });
});
```

`packages/desktop/src/renderer/components/rooms/RoomContextChip.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { CompactResult, SessionRef } from '@parley/protocol';
import { useHostStore } from '../../store/host.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import type { ParticipantModel } from './feed-model.js';
import { RoomContextChip } from './RoomContextChip.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const FILL = { usedPercent: 82, windowTokens: 200_000, usedTokens: 164_000, at: '2026-10-15T10:00:00.000Z' };
const refOf = (sessionId: string): SessionRef => ({ projectPath: '/p', workId: 'w-01', sessionId });

function participant(patch: Partial<ParticipantModel>): ParticipantModel {
  return {
    id: 's-01',
    label: 'S01 backend',
    rawLabel: 'backend',
    provider: 'claude',
    providerName: 'Claude Code',
    model: null,
    state: 'working',
    lifecycle: 'active',
    word: 'working',
    attention: 'working',
    task: '',
    doing: null,
    doingDetail: null,
    agents: [],
    lead: false,
    closed: false,
    ...patch,
  } as ParticipantModel;
}

const MEMBERS = [
  participant({ id: 's-01', label: 'S01 backend', sessionRef: refOf('s-01'), context: FILL, compaction: null }),
  participant({ id: 's-02', label: 'S02 review', provider: 'codex', sessionRef: refOf('s-02'), context: { ...FILL, usedPercent: 41 }, compaction: 'pending' }),
  participant({ id: 's-03', label: 'S03 docs', lifecycle: 'sleeping', sessionRef: refOf('s-03'), context: null, compaction: null }),
];

let bridge: FakeBridge;
beforeEach(() => {
  bridge = createFakeBridge();
  const answers: Record<string, CompactResult> = { 's-01': { state: 'started' }, 's-02': { state: 'pending' } };
  bridge.setHandler('sessions.compact', ({ ref }) => answers[ref.sessionId] ?? { state: 'refused', reason: 'asleep' });
  bridge.setHandler('sessions.cancelCompact', () => ({ cancelled: true }));
  useHostStore.setState({
    status: { state: 'connected', hostVersion: 'fixture', methods: ['sessions.compact', 'sessions.cancelCompact'] },
    connections: 1,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RoomContextChip (спека 3.3)', () => {
  it('значок — максимум по живым и ⏳ при ждущей просьбе', () => {
    render(<RoomContextChip bridge={bridge} roomTitle="Auth" participants={MEMBERS} />);
    expect(screen.getByTestId('room-context-chip').textContent).toBe('Ctx 82% ⏳');
  });

  it('список: процент, Cancel у ждущего, asleep у спящего; Codex — подсказка', () => {
    render(<RoomContextChip bridge={bridge} roomTitle="Auth" participants={MEMBERS} />);
    fireEvent.click(screen.getByTestId('room-context-chip'));
    const row = (id: string) => within(document.querySelector(`[data-context-row="${id}"]`) as HTMLElement);
    expect(row('s-01').getByText('82%')).toBeTruthy();
    expect(row('s-02').getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(row('s-03').getByText('asleep')).toBeTruthy();
    expect(row('s-03').queryByRole('button')).toBeNull();
    expect(screen.getByText('Codex compacts without focus')).toBeTruthy();
  });

  it('Compact all — каждому живому с общим текстом, итог одним тостом', async () => {
    render(<RoomContextChip bridge={bridge} roomTitle="Auth" participants={MEMBERS} />);
    fireEvent.click(screen.getByTestId('room-context-chip'));
    fireEvent.change(screen.getByTestId('room-compact-instructions'), { target: { value: 'Keep API decisions' } });
    fireEvent.click(screen.getByTestId('room-compact-all'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Compacting 1 agent · 1 queued · 1 skipped'));
    expect(bridge.calls.filter((call) => call.method === 'sessions.compact').map((call) => call.params)).toEqual([
      { ref: refOf('s-01'), instructions: 'Keep API decisions' },
      { ref: refOf('s-02'), instructions: 'Keep API decisions' },
    ]);
  });

  it('Compact в строке — одна сессия с общим текстом по умолчанию', async () => {
    render(<RoomContextChip bridge={bridge} roomTitle="Auth" participants={MEMBERS} />);
    fireEvent.click(screen.getByTestId('room-context-chip'));
    fireEvent.click(within(document.querySelector('[data-context-row="s-01"]') as HTMLElement).getByRole('button', { name: 'Compact' }));
    await waitFor(() =>
      expect(bridge.calls.find((call) => call.method === 'sessions.compact')?.params).toMatchObject({
        ref: refOf('s-01'),
        instructions: expect.stringContaining('Focus on room "Auth"'),
      }),
    );
  });

  it('старый хост: ни у кого из живых нет поля context — значка нет', () => {
    const old = MEMBERS.map(({ context: _c, compaction: _p, ...rest }) => rest as ParticipantModel);
    render(<RoomContextChip bridge={bridge} roomTitle="Auth" participants={old} />);
    expect(screen.queryByTestId('room-context-chip')).toBeNull();
  });

  it('хост без sessions.compact — список без кнопок', () => {
    useHostStore.setState({ status: { state: 'connected', hostVersion: 'fixture', methods: [] }, connections: 1 });
    render(<RoomContextChip bridge={bridge} roomTitle="Auth" participants={MEMBERS} />);
    fireEvent.click(screen.getByTestId('room-context-chip'));
    expect(screen.queryByTestId('room-compact-all')).toBeNull();
    expect(document.querySelectorAll('[data-context-row] button')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @parley/desktop exec vitest run src/renderer/components/rooms/feed-model.test.ts src/renderer/components/rooms/ParticipantStrip.test.tsx src/renderer/components/rooms/RoomContextChip.test.tsx`
Expected: FAIL — нет `context` у участника, нет пропа `contextChip`, нет модуля `./RoomContextChip.js`.

- [ ] **Step 3: Write minimal implementation**

`feed-model.ts`: импорты `import type { ContextFill } from '@parley/core';` и `CompactionPhase` — к импорту типов из `@parley/protocol`. В `ParticipantModel` после `closed: boolean;`:

```ts
  /**
   * Заполненность контекста (спека 2026-10-15, 3.2): у живого — из метрик; у спящего — `null` (старое не
   * показывается); `undefined` — хост поле не сообщает.
   */
  context?: ContextFill | null;
  /** Сжатие контекста; у спящего — `null`. */
  compaction?: CompactionPhase | null;
```

В `participants.push({ … })` (≈276-295) добавить, используя уже вычисленный `liveEntry` и `session`:

```ts
      context: session.lifecycle === 'active' ? liveEntry?.metrics?.context : null,
      compaction: session.lifecycle === 'active' ? (liveEntry?.metrics?.compaction ?? null) : null,
```

Если проект собран с `exactOptionalPropertyTypes` и значение `undefined` нельзя присвоить необязательному полю — добавлять поле условно: `...(context === undefined ? {} : { context })`.

`ParticipantStrip.tsx`: импорт `import type { ReactNode } from 'react';`; в `ParticipantStripProps`:

```ts
  /** Чип контекста участника (спека 2026-10-15, 3.2): во второй строке справа, вне кнопки открытия. */
  contextChip?: (participant: ParticipantModel) => ReactNode;
```

В разборе пропов добавить `contextChip`; внутри `.map` перед `return (` — `const chip = contextChip?.(participant) ?? null;`. Внутри обёртки карточки (строки 81-104) первой веткой поставить раскладку с чипом, а две прежние ветки оставить как есть:

```tsx
          {chip !== null ? (
            <>
              <button type="button" onClick={open} className="flex w-full flex-col rounded-t-[14px] px-3 pt-[9px] text-left">
                {header}
              </button>
              <div className="mx-3 mb-[9px] mt-1 flex min-w-0 items-center gap-2">
                {participant.agents.length > 0 && participant.doing !== null ? (
                  <AgentsBadge
                    tasks={participant.agents}
                    label={participant.doing}
                    {...(participant.doingDetail === null ? {} : { title: participant.doingDetail })}
                    onOpen={(task) => onOpenSession(participant.id, task.id)}
                    className="min-h-4 min-w-0 flex-1 truncate text-left text-xs text-muted-foreground hover:text-foreground hover:underline"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={open}
                    title={participant.doing === null ? undefined : (participant.doingDetail ?? undefined)}
                    className="min-h-4 min-w-0 flex-1 truncate text-left text-xs text-muted-foreground"
                  >
                    {participant.doing ?? participant.task}
                  </button>
                )}
                {chip}
              </div>
            </>
          ) : participant.agents.length > 0 && participant.doing !== null ? (
```

Пропы `AgentsBadge` скопировать из существующей ветки (строки 86-91) один в один, меняя только `className` (без `mx-3 mb-[9px] mt-1`, с `min-w-0 flex-1`). Дописать в шапку файла абзац: «Чип контекста (спека 2026-10-15, 3.2) — справа во второй строке; с ним кнопка открытия — только первая строка, а «чем занят» — отдельная кнопка рядом с чипом».

`RoomContextChip.tsx`:

```tsx
/**
 * Значок контекста в шапке комнаты (спека 2026-10-15, 3.3): `Ctx 82%` — наибольший процент среди живых участников,
 * `⏳` — есть ждущие просьбы. Поповер: участники с полосой и процентом, Compact / Cancel в строке, спящие — `asleep`
 * без кнопки; одно общее поле инструкции для строк и `Compact all`. Старый хост без поля `context` — значка нет.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { useHostSupports } from '../../lib/capabilities.js';
import { cn } from '../../lib/cn.js';
import {
  BAR_CLASS,
  COMPACT_MAX_INSTRUCTIONS,
  contextChipText,
  contextLevel,
  LEVEL_CLASS,
  maxContext,
  percentText,
} from '../../lib/context-format.js';
import { Button } from '../../ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover.js';
import { Textarea } from '../../ui/textarea.js';
import { cancelCompaction, compactSession } from '../context/compact-actions.js';
import type { ParticipantModel } from './feed-model.js';

const C = S.context;

export interface RoomContextChipProps {
  bridge: ParleyBridge;
  roomTitle: string;
  participants: readonly ParticipantModel[];
}

export function RoomContextChip({ bridge, roomTitle, participants }: RoomContextChipProps): JSX.Element | null {
  const supported = useHostSupports('sessions.compact');
  const members = participants.filter((participant) => !participant.closed && participant.sessionRef !== undefined);
  const live = members.filter((participant) => participant.lifecycle === 'active');
  if (!live.some((participant) => participant.context !== undefined)) return null;
  const max = maxContext(live.map((participant) => participant.context));
  const level = max === null ? 'normal' : contextLevel(max);
  const queued = live.some((participant) => participant.compaction === 'pending');
  const text = `${C.roomChip(max === null ? C.marks.unknown : percentText(max))}${queued ? ` ${C.marks.pending}` : ''}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid="room-context-chip"
          data-level={level}
          className={cn('shrink-0 font-mono tabular-nums', LEVEL_CLASS[level])}
        >
          {text}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" data-testid="room-context-popover" className="w-[min(360px,calc(100vw-32px))] p-3 text-xs">
        <RoomContextBody bridge={bridge} roomTitle={roomTitle} members={members} supported={supported} />
      </PopoverContent>
    </Popover>
  );
}

/** Тело поповера: монтируется при открытии, поэтому поле каждый раз начинается с текста по умолчанию. */
function RoomContextBody({
  bridge,
  roomTitle,
  members,
  supported,
}: {
  bridge: ParleyBridge;
  roomTitle: string;
  members: readonly ParticipantModel[];
  supported: boolean;
}): JSX.Element {
  const [text, setText] = useState(C.roomDefault(roomTitle));
  const instructions = text.trim() === '' ? null : text;
  const hasCodex = members.some((participant) => participant.provider === 'codex');

  const compactAll = async (): Promise<void> => {
    const targets = members.filter((participant) => participant.lifecycle === 'active');
    const results = await Promise.all(
      targets.map((participant) => compactSession(bridge, participant.sessionRef!, participant.label, instructions, { quiet: true })),
    );
    const started = results.filter((result) => result?.state === 'started').length;
    const queued = results.filter((result) => result?.state === 'pending').length;
    toast(C.allResult(started, queued, members.length - started - queued));
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 font-medium">{C.roomTitle}</p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {members.map((participant) => {
          const fill = participant.context ?? null;
          const phase = participant.compaction ?? null;
          const rowLevel = fill === null ? 'normal' : contextLevel(fill.usedPercent);
          return (
            <li key={participant.id} data-context-row={participant.id} className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={participant.label}>
                {participant.label}
              </span>
              {participant.lifecycle === 'active' ? (
                <>
                  <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-[color-mix(in_srgb,currentColor_12%,transparent)]">
                    <span className={cn('block h-full', BAR_CLASS[rowLevel])} style={{ width: `${fill?.usedPercent ?? 0}%` }} />
                  </span>
                  <span className="w-[4.5rem] shrink-0 text-right font-mono tabular-nums">{contextChipText(fill, phase)}</span>
                  {!supported ? null : phase === 'pending' ? (
                    <Button type="button" size="xs" variant="outline" onClick={() => void cancelCompaction(bridge, participant.sessionRef!)}>
                      {C.cancel}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={phase === 'running'}
                      onClick={() => void compactSession(bridge, participant.sessionRef!, participant.label, instructions)}
                    >
                      {C.compact}
                    </Button>
                  )}
                </>
              ) : (
                <span className="shrink-0 text-muted-foreground">{C.marks.asleep}</span>
              )}
            </li>
          );
        })}
      </ul>
      {supported ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{C.instructionsLabel}</span>
            <Textarea
              data-testid="room-compact-instructions"
              value={text}
              maxLength={COMPACT_MAX_INSTRUCTIONS}
              rows={4}
              onChange={(event) => setText(event.target.value)}
              className="resize-none text-xs"
            />
          </label>
          {hasCodex ? <p className="m-0 text-muted-foreground">{C.codexNoFocus}</p> : null}
          <div className="flex justify-end">
            <Button type="button" size="xs" data-testid="room-compact-all" onClick={() => void compactAll()}>
              {C.compactAll}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
```

`RoomHeader.tsx`: в `RoomHeaderProps` после `usageChip?: ReactNode;`:

```ts
  /** Значок контекста комнаты (`RoomContextChip`, спека 2026-10-15, 3.3) рядом с расходом. */
  contextChip?: ReactNode;
  /** Чип контекста участника на карточке (`ContextChip`, спека 3.2). */
  participantContext?: (participant: ParticipantModel) => ReactNode;
```

Добавить их в разбор пропов; строку 52 привести к виду

```tsx
        {recipeChip === undefined && usageChip === undefined && contextChip === undefined ? modeControl : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">{modeControl}{recipeChip}{usageChip}{contextChip}</div>
        )}
```

и ленту участников:

```tsx
      <ParticipantStrip
        participants={participants}
        onOpenSession={onOpenSession}
        {...(participantContext === undefined ? {} : { contextChip: participantContext })}
      />
```

`RoomPanel.tsx`: импорты `ContextChip` (`../context/ContextChip.js`), `RoomContextChip` (`./RoomContextChip.js`), тип `ParticipantModel` (`./feed-model.js`), если его нет. В вызов `<RoomHeader … />` (строка 435) добавить два пропа:

```tsx
contextChip={<RoomContextChip bridge={bridge} roomTitle={model.title} participants={model.participants} />}
participantContext={(participant: ParticipantModel) =>
  participant.sessionRef === undefined ? null : (
    <ContextChip
      bridge={bridge}
      sessionRef={participant.sessionRef}
      provider={participant.provider}
      label={participant.label}
      running={participant.lifecycle === 'active'}
      context={participant.context}
      compaction={participant.compaction}
      defaultInstructions={S.context.roomDefault(model.title)}
      testId="participant-context-chip"
      className="h-5 px-1.5 text-[11px]"
    />
  )
}
```

`model.title` — название комнаты (его же получает `RoomHeader` в `title`); если там стоит иное (например, с номером), брать название из `entry.map.rooms.find((room) => room.id === roomId)?.title`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/desktop exec vitest run src/renderer/components/rooms && pnpm --filter @parley/desktop typecheck`
Expected: PASS; прежние тесты `ParticipantStrip`, `RoomPanel`, `RoomHeader` — без правок (без `contextChip` разметка прежняя).

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/components/rooms
git commit -m "feat(desktop): контекст участников комнаты — чип на карточке и значок Ctx с Compact all

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Окно — чип контекста в тулбаре Chat

**Files:**
- Modify: `packages/desktop/src/renderer/chat/ChatToolbar.tsx` (`ChatToolbarProps` ~80-117, разбор пропов ~208, рендер ~246)
- Modify: `packages/desktop/src/renderer/chat/ChatToolbar.test.tsx`
- Modify: `packages/desktop/src/renderer/chat/ChatView.tsx` (~191 и вызов `<ChatToolbar` ~396-402)

**Interfaces:**
- Consumes: `ContextChip` (задача 9), `S.context.sessionDefault` (задача 8), `sessionRowLabel` (`renderer/lib/participant.ts`).
- Produces: `ChatToolbarProps.contextChip?: ReactNode`.

- [ ] **Step 1: Write the failing test**

В `packages/desktop/src/renderer/chat/ChatToolbar.test.tsx` в блок «ChatToolbar — расход токенов сессии»:

```tsx
  it('contextChip — рядом со значком расхода (спека 2026-10-15, 3.4)', () => {
    const metrics = { tokensIn: 10, tokensOut: 2, durationMs: null, unread: 0, subagents: 0, model: null };
    render(
      <ChatToolbar workKey="k" tabId="t" view="chat" available provider="claude" metrics={metrics} contextChip={<span data-testid="ctx">62%</span>} />,
    );
    const usage = screen.getByTestId('chat-usage-chip');
    const chip = screen.getByTestId('ctx');
    expect(usage.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @parley/desktop exec vitest run src/renderer/chat/ChatToolbar.test.tsx`
Expected: FAIL — `ctx` не найден.

- [ ] **Step 3: Write minimal implementation**

`ChatToolbar.tsx`: импорт `import type { ReactNode } from 'react';` (если его нет); в `ChatToolbarProps` после `metrics?: LiveMetrics | null;`:

```ts
  /** Чип контекста сессии (`ContextChip`, спека 2026-10-15, 3.4) — рядом со значком расхода. */
  contextChip?: ReactNode;
```

в разбор пропов — `contextChip`; после `{metrics === null ? null : <SessionUsageChip metrics={metrics} />}` — `{contextChip}`.

`ChatView.tsx`: импорты `ContextChip` (`../components/context/ContextChip.js`), `sessionRowLabel` (`../lib/participant.js`), `S` (если нет), `useWorksStore` (`../store/works.js`, если нет). Рядом с `const metrics = …` (строка 191):

```tsx
  const session = useWorksStore((state) =>
    state.entries
      .find((item) => item.projectPath === sessionRef.projectPath && item.map.work.id === sessionRef.workId)
      ?.map.sessions.find((item) => item.id === sessionRef.sessionId),
  );
  const sessionName = session === undefined ? null : sessionRowLabel(session.id, session.label);
```

и в `<ChatToolbar … metrics={metrics} />` добавить:

```tsx
          contextChip={
            metrics === null || session === undefined || sessionName === null ? undefined : (
              <ContextChip
                bridge={bridge}
                sessionRef={sessionRef}
                provider={session.provider}
                label={sessionName}
                running={session.lifecycle === 'active'}
                context={metrics.context}
                compaction={metrics.compaction}
                defaultInstructions={S.context.sessionDefault(sessionName)}
                testId="chat-context-chip"
              />
            )
          }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @parley/desktop exec vitest run src/renderer/chat && pnpm --filter @parley/desktop typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/chat/ChatToolbar.tsx packages/desktop/src/renderer/chat/ChatToolbar.test.tsx packages/desktop/src/renderer/chat/ChatView.tsx
git commit -m "feat(desktop): чип контекста сессии в тулбаре Chat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: E2E 800×500, CHANGELOG и приёмка

**Files:**
- Create: `packages/desktop/e2e/room-context.spec.ts`
- Modify: `CHANGELOG.md` (раздел `## Unreleased`)

**Interfaces:**
- Consumes: всё из задач 2–11; стаб `packages/desktop/e2e/stub-echo-agent.mjs` (эхо ввода `echo: …`, строка `STUB_HOOK <json>` шлёт хук на хост).
- Produces: —

- [ ] **Step 1: Write the E2E test**

`packages/desktop/e2e/room-context.spec.ts`:

```ts
/**
 * Заполненность контекста и сжатие в комнате (спека 2026-10-15, 3.2–3.3, 5, 7.2): `claude` играет стаб
 * `stub-echo-agent.mjs`, файл `context/<сессия>.json` пишет сам тест (как строка статуса), хуки — строки
 * `STUB_HOOK <json>` через `pty.input`. Окно 800×500 с длинными названиями; `dpr` 1 и 2. Снимки —
 * в `test-results/room-context/` (не коммитятся).
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const shots = path.resolve(dirname, '../test-results/room-context');
const LONG_LABEL = 'backend-refactor-of-the-payments-ledger-and-invoices';
const LONG_TITLE = `Payments ledger refactor with invoices, refunds, reconciliation, reporting and audit trail ${'x'.repeat(30)}`.slice(0, 120);
type Ref = { projectPath: string; workId: string; sessionId: string };
let project = '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

async function hook(window: Page, ref: Ref, event: string, fields: Record<string, unknown> = {}): Promise<void> {
  const body = JSON.stringify({ hook_event_name: event, ...fields });
  await window.evaluate(
    ({ target, data }) =>
      (globalThis as unknown as { parley: { notify: (m: string, p: unknown) => void } }).parley.notify('pty.input', { ref: target, data }),
    { target: ref, data: `STUB_HOOK ${body}\r` },
  );
}

async function writeContext(ref: Ref, usedPercent: number): Promise<void> {
  const dir = path.join(ref.projectPath, '.parley', 'works', ref.workId, 'context');
  await mkdir(dir, { recursive: true });
  const fill = { usedPercent, windowTokens: 200_000, usedTokens: usedPercent * 2_000, at: new Date().toISOString() };
  await writeFile(path.join(dir, `${ref.sessionId}.json`), `${JSON.stringify(fill)}\n`);
}

async function screenText(window: Page): Promise<string> {
  return window.locator('.xterm-rows').first().evaluate((rows) => Array.from(rows.children, (row) => row.textContent ?? '').join(''));
}

test.describe('контекст и сжатие в комнате (800×500)', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('room-context');
    project = await makeTempProject('room-context');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  for (const dpr of [1, 2]) {
    test(`чипы, поповер в границах окна, сжатие свободного и занятого агента (масштаб ${dpr})`, async () => {
      test.setTimeout(120_000);
      const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
      const electronApp = await electron.launch({ args: [mainEntry, `--force-device-scale-factor=${dpr}`], env });
      app = electronApp;
      const window = await electronApp.firstWindow();
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
      await expect(window.getByTestId('landing')).toBeVisible();

      const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-room-context', goal: '' });
      const refs: Ref[] = [];
      for (let index = 0; index < 2; index += 1) {
        const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
          projectPath: project,
          workId,
          provider: 'claude',
          label: `${LONG_LABEL}-${index}`,
          task: '',
          parent: null,
        });
        refs.push({ projectPath: project, workId, sessionId: ref.sessionId });
      }
      const [idle, busy] = refs as [Ref, Ref];
      const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
        projectPath: project,
        workId,
        title: LONG_TITLE,
        members: refs.map((ref) => ref.sessionId),
        lead: idle.sessionId,
        quiet: true,
      });
      await expect(window.getByTestId('app-shell')).toBeVisible();
      await window.locator(`[data-room-row="${roomId}"]`).locator('> div').first().click();

      await writeContext(idle, 82);
      await writeContext(busy, 41);
      const idleChip = window.locator(`[data-participant="${idle.sessionId}"] [data-testid="participant-context-chip"]`);
      const busyChip = window.locator(`[data-participant="${busy.sessionId}"] [data-testid="participant-context-chip"]`);
      await expect(idleChip).toHaveText('82%', { timeout: 15_000 });
      await expect(busyChip).toHaveText('41%', { timeout: 15_000 });
      await expect(window.getByTestId('room-context-chip')).toHaveText('Ctx 82%');

      // Узкое окно: значок и поповер комнаты — в границах.
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
      await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(800);
      await window.getByTestId('room-context-chip').click();
      const popover = window.getByTestId('room-context-popover');
      await expect(popover).toBeVisible();
      const box = await popover.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(-0.5);
      expect(box!.x + box!.width).toBeLessThanOrEqual(800.5);
      expect(box!.y + box!.height).toBeLessThanOrEqual(500.5);
      await mkdir(shots, { recursive: true });
      await window.screenshot({ path: path.join(shots, `room-context-popover-dpr${dpr}.png`) });
      await window.keyboard.press('Escape');
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));

      // Занятый агент: просьба ждёт конца хода.
      await hook(window, busy, 'UserPromptSubmit', { prompt: 'work' });
      await busyChip.click();
      await window.getByTestId('compact-submit').click();
      await expect(busyChip).toHaveText('⏳');
      await window.keyboard.press('Escape');

      // Свободный агент: печать сразу, затем PostCompact и свежая цифра. Stop — чтобы стаб точно считался свободным.
      await hook(window, idle, 'Stop');
      await idleChip.click();
      await expect(window.getByTestId('compact-instructions')).toHaveValue(new RegExp(`^Focus on room "${LONG_TITLE.slice(0, 20)}`));
      await window.getByTestId('compact-submit').click();
      await expect(idleChip).toHaveText('…');
      await window.keyboard.press('Escape');
      await hook(window, idle, 'PostCompact', { trigger: 'manual' });
      await expect(idleChip).toHaveText('compacted', { timeout: 10_000 });
      await writeContext(idle, 12);
      await expect(idleChip).toHaveText('12%', { timeout: 15_000 });

      await hook(window, busy, 'Stop');
      await expect(busyChip).toHaveText('…', { timeout: 10_000 });

      // В терминале занятого — команда с фокусом комнаты.
      await window.locator(`[data-participant="${busy.sessionId}"] button`).first().click();
      await expect.poll(() => screenText(window), { timeout: 10_000 }).toContain('echo: /compact Focus on room');
    });
  }
});
```

Если `toHaveValue` с длинным названием, содержащим символы регулярных выражений, падает — экранировать префикс (`LONG_TITLE` выше их не содержит).

- [ ] **Step 2: Build and run E2E**

```bash
uptime
pnpm --filter @parley/core build && pnpm --filter @parley/protocol build && pnpm --filter @parley/host build && pnpm --filter @parley/desktop build
pnpm --filter @parley/desktop e2e -- room-context.spec.ts
```

Expected: PASS для `dpr` 1 и 2. Снимки `test-results/room-context/*.png` открыть и посмотреть глазами: чип не налезает на имя, поповер не обрезан. Затем соседи, которых задела задача: `pnpm --filter @parley/desktop e2e -- room-usage.spec.ts terminal-send.spec.ts room-actions.spec.ts` — PASS.

- [ ] **Step 3: CHANGELOG**

В `CHANGELOG.md` под `## Unreleased` добавить раздел (если `### Added` уже есть — дописать в него):

```markdown
### Added

- **See how full each agent's context is, and compact it on your terms.** Every room participant card shows
  how much of the model's context window the agent has used (amber from 60 %, red from 85 %), and the room
  header shows the fullest one as **Ctx 82%**. Click a chip to compact that agent with focus instructions
  prefilled from the room's title — edit them if you like — or use **Compact all** for the whole room. An agent
  that is busy compacts as soon as its turn ends (⏳); Parley holds room messages for it until compaction is
  done. Chat shows the same chip for its session. Codex compacts without focus instructions.
```

- [ ] **Step 4: Полные наборы**

```bash
uptime
pnpm test && pnpm lint && pnpm typecheck
```

Expected: PASS. Флейки tui/E2E под нагрузкой сверять с прогоном на `origin/master`, а не чинить вслепую.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/e2e/room-context.spec.ts CHANGELOG.md
git commit -m "test(desktop): E2E контекста и сжатия в комнате 800×500; CHANGELOG

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Живая приёмка (с человеком)**

Dev-окно с отдельным домом (`PARLEY_HOME=~/.parley-context pnpm dev`), не собранное приложение. Человек проверяет:

1. Комната с настоящими Claude Code и Codex: проценты на карточках совпадают с `/context` (Claude) и «% context left» (Codex) с точностью до процента.
2. `Compact` у свободного Claude — в его терминале `/compact Focus on room "…"`, после сжатия чип `compacted`, затем новая цифра.
3. `Compact` у занятого — `⏳`, сжатие после хода; письмо, пришедшее в это время, доставляется после сжатия.
4. Сессия GLM (ключ Z.ai вводит человек): в `<проект>/.parley/works/<работа>/context/<сессия>.json` — верный `windowTokens` для модели GLM. Неверный — завести задачу: у GLM показывать токены без процента (спека 7.3, п. 3).
5. Итоги записать в раздел 9 спеки и закоммитить.

---
