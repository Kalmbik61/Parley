# Spec: раннеры Codex и GLM (v2)

Цель v2: в списке сессий появляются сессии других провайдеров, а в правой панели через
тот же PTY-менеджер можно запустить `codex` или GLM-CLI. Бейджи моделей едины.

## Статус знаний

- **Codex**: **формат подтверждён 2026-09-02** на 97 реальных rollout-логах
  (77 897 записей, 127 МБ). Разбор ниже, снимок — `docs/schema/codex-schema-report.json`.
- **GLM**: расположение и формат логов зависят от харнесса; см. раздел «GLM».

## Codex: подтверждённый формат

### Раскладка

```
~/.codex/sessions/<год>/<месяц>/<день>/rollout-<ISO-время>-<uuid>.jsonl
```

Один файл = одна сессия, 1:1. Вложенности субагентов нет: подсессий у Codex не бывает.

🚫 Рядом лежит `~/.codex/auth.json` с учётными данными — **не читать никогда**,
ровно как `~/.claude/.credentials.json`. Каталог `~/.codex` только для чтения.

### Запись

Каждая строка: `{ timestamp, type, payload }`. Тип определяется полем `type`,
подтип — вложенным `payload.type`.

| type | шт. | назначение |
|---|---:|---|
| `event_msg` | 33 450 | события: `token_count`, `agent_reasoning`, `user_message`, `agent_message`, `turn_aborted`, `context_compacted` |
| `response_item` | 33 424 | элементы диалога: `reasoning`, `function_call`, `function_call_output`, `message`, `custom_tool_call`, `ghost_snapshot` |
| `turn_context` | 10 886 | контекст хода: `model`, `cwd`, `effort`, политики песочницы |
| `session_meta` | 97 | ровно одна на файл, вся мета сессии |
| `compacted` | 40 | сжатие истории |

### Откуда что брать

- **id** — `session_meta.payload.id` (uuid); совпадает с uuid в имени файла.
- **cwd** — `session_meta.payload.cwd`, дублируется в каждом `turn_context`.
- **gitBranch** — `session_meta.payload.git.branch` (есть у 98%); там же
  `commit_hash` и `repository_url`.
- **version** — `session_meta.payload.cli_version` (наблюдались `0.73.0`, `0.77.0`).
- **Длительность** — min/max `timestamp` записей; таймстемп есть у 100% строк,
  в отличие от Claude Code.
- **Модель** — `turn_context.payload.model`. Наблюдались `gpt-5.2-codex`,
  `gpt-5.1-codex-max`, `gpt-5.2`, `gpt-5.1-codex-mini`.
- **Инструменты** — `response_item` с `payload.type === 'function_call'`, имя в
  `payload.name` (`shell_command`, `exec_command`, `update_plan`, `mcp__*`).
- **Роли** — `payload.role` у `response_item.payload.type === 'message'`:
  `user`, `assistant`, `developer`.
- **Заголовок** — отдельной записи нет. Берётся первый `event_msg` с
  `payload.type === 'user_message'` и его `payload.message` (простая строка).
  Fallback — первый текстовый блок `response_item.message.content[]`
  (`{type: 'input_text', text}`).
- **Подсессии** — отсутствуют как явление, `subsessionCount` всегда 0.

### Чем отличается от Claude Code

| | Claude Code | Codex |
|---|---|---|
| раскладка | `<project-slug>/<id>.jsonl` | `<Y>/<M>/<D>/rollout-<ts>-<uuid>.jsonl` |
| проект | слаг каталога | только `cwd` внутри записей |
| заголовок | `custom-title` / `ai-title` | нет, берётся первая реплика |
| мета | размазана по всем записям | одна запись `session_meta` |
| подсессии | отдельные файлы в `subagents/` | нет |
| таймстемпы | не у всех записей | у всех |

## GLM: проверено 2026-09-02, история отсутствует

Что искали и чего не нашли:

- каталогов `~/.glm`, `~/.zhipu`, `~/.zai`, `~/.chatglm`, `~/.config/glm`,
  `~/.local/share/glm` — нет;
- поиск по имени (`*glm*`, `*zhipu*`, `*z.ai*`, `*bigmodel*`) на три уровня в HOME —
  ни одного совпадения;
- упоминаний GLM в конфигах установленных агентских CLI — нет;
- бинарей `glm`, `zai`, `chatglm` в PATH — нет (`codex` при этом установлен).

**Решение: GLM — runner-only.** Своего формата сессий у GLM нет: он работает через
OpenAI-совместимый эндпоинт внутри чужих харнессов, и история остаётся в формате
того харнесса. Значит:

- адаптер истории для GLM не пишем — нечего адаптировать;
- в списке сессий GLM не появляется;
- запуск в правой панели через общий PTY-менеджер поддерживается, команда берётся
  из реестра раннеров.

Если позже найдётся харнесс со своим журналом — заводится отдельный адаптер,
а эта запись обновляется.

## Архитектура

- Каждый провайдер — **адаптер в packages/core** с единым выходом `SessionIndex` /
  `SessionTree` (поле `provider: "claude" | "codex" | "glm"`). UI не знает о различиях
  форматов.
- Раннер — конфиг для общего PTY-менеджера (specs/pty.md): команда, аргументы resume
  (если поддерживается), cwd. Никакой отдельной терминальной логики на провайдера.
- Watcher расширяется на каталоги других провайдеров (`~/.codex/sessions`).

## Единые бейджи моделей

Таблица нормализации подтверждена реальными данными обоих провайдеров:

| Сырое значение          | Бейдж   |
|-------------------------|---------|
| claude-opus-*           | Opus    |
| claude-sonnet-*         | Sonnet  |
| claude-haiku-*          | Haiku   |
| claude-fable-*          | Fable   |
| gpt-*-codex, gpt-*-codex-max, gpt-*-codex-mini | Codex |
| gpt-*                   | GPT     |
| glm-*                   | GLM     |
| `<synthetic>`           | не модель, в бейдж не идёт |
| неизвестное             | сырое значение, усечённое |

Нормализация живёт в core (одна функция + таблица), UI получает уже бейдж.

## Вне объёма (v3 — НЕ реализовывать сейчас)

Оркестрация нескольких провайдеров: процессы-адаптеры с контрактом task in /
structured JSON out (`claude -p --output-format stream-json` + `--resume`,
`codex exec`, GLM через OpenAI-совместимый эндпоинт), роутер по капабилити/стоимости,
общий журнал задач (не прямой чат агентов), общий слой инструментов через MCP.
Зафиксировано здесь только чтобы адаптеры v2 не проектировались вразрез с этим.
