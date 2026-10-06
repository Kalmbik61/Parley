# Нормалайзер модели и effort: настоящие уровни, запуск и смена из чата

Дата: 2026-10-06. Статус: реализовано в ветке `feat/model-effort-normalizer` по плану `docs/specs/2026-10-06-model-effort-normalizer-plan.md`, приёмка 2026-10-06 пройдена (раздел 13).

Связано:
- локальный план пользователя `.omx/plans/2026-10-04-provider-adapters-and-chat.md`. Здесь — его этапы 0–3; этапы 4–7 (чат Codex) — следующий подпроект;
- хотфикс 0.5.3, ветка `fix/glm-chat-model-menu`: у GLM в чате спрятано меню модели;
- спека провайдеров `docs/specs/2026-10-02-providers-connect-design.md`.

## 1. Зачем

Человек выбирает модель и effort у любого провайдера в одном формате Parley. Он видит настоящие уровни выбранной модели, а не три зашитых: у Claude это `low…max`, у моделей Codex свои наборы, вплоть до `ultra`.

Тот же выбор работает:
- при запуске из диалога;
- у агентов через MCP;
- в идущей сессии из чата.

При этом выбор никогда не переписывает глобальные настройки CLI человека.

## 2. Что сейчас (проверено 2026-10-06)

| # | Проблема | Где |
|---|---|---|
| 1 | Effort — три уровня, зашитых в пяти местах | `packages/core/src/providers.ts:344` (`EffortLevel`, `EFFORT_LEVELS`), `packages/protocol/src/methods.ts:84` (`sessions.create.effort`), `packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.tsx:89-96`, MCP `packages/core/src/mcp/tools.ts:308-313`, гид `packages/core/src/work/guide.ts:108` |
| 2 | Диалог всегда шлёт `effort: 'medium'`, пункта «Default» у effort нет. Поэтому сохранённые в CLI уровни (у пользователя Opus 5.5 → `xhigh`) в сессиях Parley не действуют | `NewSessionOrRoomDialog.tsx:117, 350, 402-403` |
| 3 | Выбор из диалога в карте не хранится, хранит только `spawn_session`. Повторный запуск и resume его теряют. Resume Claude не передаёт effort, а сам Claude Code его не восстанавливает | `packages/host/src/sessions/sessions-service.ts:387-395, 479-485`; `providers.ts:199-216` |
| 4 | Меню модели в чате шлёт текст `/model <id>`. Интерактивный Claude Code сохраняет такой выбор моделью по умолчанию в пользовательском `settings.json`. У GLM, с общим `~/.claude`, это ломало обычный Claude; хотфикс 0.5.3 спрятал меню GLM | `packages/desktop/src/renderer/chat/ChatView.tsx:226-230` |
| 5 | Каталог Codex зашит (4 модели), уровней по моделям нет | `packages/core/src/provider-models.ts:69-74` |
| 6 | Оверрайд `args` в `providers.json` без `{model}`/`{effort}` молча выключает выбор. Так у пользователя пропал выбор у Codex; запись убрана 2026-10-06 с его согласия | `providers.ts:478-487, 735-776` |
| 7 | Effort нигде не показывается, подпись модели в чате часто пустая | `packages/desktop/src/renderer/chat/ChatToolbar.tsx:156-188`, `packages/desktop/src/renderer/chat/feed-model.ts:26-36` |

## 3. Проверенные факты CLI (этап 0)

Проверки проведены 2026-10-06 на Claude Code 2.1.289 и Codex 0.160.0. Claude Code запускался против локальной заглушки Anthropic API, с временным `CLAUDE_CONFIG_DIR` и без ключей. GLM проверен один раз ключом пользователя, с его согласия.

**Claude Code**

1. `--effort` принимает `low, medium, high, xhigh, max`. Уровни по документации (code.claude.com/docs/en/model-config):
   - все пять: Fable 5.1 и 5, Opus 5.5, Sonnet 5.5, Opus 5, Sonnet 5, Opus 4.8, Opus 4.7;
   - без `xhigh`: Opus 4.6 и Sonnet 4.6;
   - effort нет: Haiku и более старые модели.

   Уровень выше поддерживаемого Claude Code опускает до ближайшего ниже.
2. У Haiku `--effort` молча отбрасывается: в запросе нет `output_config`.
3. Без `--effort` действует уровень, сохранённый для модели в `settings.json` (`modelSettings.<id>.effortLevel`). Если его нет, берётся умолчание модели (у Opus 5.5 и Sonnet 5.5 — `medium`).
4. Интерактивные `/effort <level>` и `/model <id>` отвечают «saved as your default for new sessions» и пишут `modelSettings`/`model` в пользовательский `settings.json`. В режиме `-p` те же команды отвечают «this session only».
5. Ползунок `/effort` (без аргумента) управляется так:
   - `←/→` меняют уровень;
   - `s` применяет его «for this session only»;
   - `Enter` сохраняет его умолчанием;
   - `Esc` отменяет.

   `←` упирается в `low`, `→` — в `max`. После `s` подвал показывает уровень: `○ low · /effort`, `◐ medium · /effort`, `● high · /effort`, `◈ max · /effort`. `settings.json` при этом не меняется.
6. Resume:
   - `--resume <id>` без `--effort` идёт на умолчании: сессия, начатая с `low`, после resume ушла с `medium`;
   - `--resume <id> --model opus --effort xhigh` применяет оба флага;
   - без флага модели resume восстанавливает модель сам.
7. Транскрипт пишет `"effort"` в каждую запись ответа.

**GLM (Claude Code + Z.ai)**

8. Claude Code шлёт Z.ai `output_config.effort` любого уровня, вплоть до `max`. Для незнакомой модели он уровень не опускает.
9. Z.ai уровень учитывает. На одной задаче `low` дал 11 токенов вывода, `max` — 309 (glm-5.3, ответ верный в обоих случаях).
10. GLM-сессии делят `~/.claude` с обычным Claude. `/model glm-5.3-flash[1m]` пишет модель Z.ai в пользовательский `settings.json`, а флаговый `--settings settings-glm.json` остаётся нетронутым.

**Codex 0.160**

11. `codex debug models` примерно за 2 с печатает `{"models":[…]}` — каталог аккаунта. Сам Codex при этом скачивает каталог со своего сервера под входом пользователя и обновляет `~/.codex/models_cache.json`. Поля модели: `slug`, `display_name`, `description`, `default_reasoning_level`, `supported_reasoning_levels: [{effort, description}]`, `visibility: "list"|"hide"`, `priority`, `supports_reasoning_effort_updates`.
12. Видимые модели на 2026-10-06:
    - `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-5.6-sol`, `gpt-5.6-terra` — `low…max` и `ultra`;
    - `gpt-6-luna`, `gpt-5.6-luna` — `low…max`.

    Умолчание каталога — `medium`.
13. Rollout пишет `model` и `effort` в каждый `turn_context`.

**Добавление от 2026-10-06 (этап 0 плана).**

14. **Подвал `xhigh`** — `◉ xhigh · /effort`. В GLM-режиме, как его запускает Parley, ползунок `/effort` + `s` работает так же: после `● high · /effort` и последовательности `← ×6, → ×3, s` подвал показывает `◉ xhigh · /effort`. `settings.json` при этом не создаётся.
15. **Z.ai учитывает effort и у `glm-5.3-flash`.** На той же задаче `low` дал 17 токенов вывода, `max` — 265, ответ верный в обоих случаях. Пять уровней у Flash остаются.
16. **`codex debug models` без сети и без входа.** Без сети (прокси в никуда) команда завершается с кодом 0 за 3 с, без входа (пустой `CODEX_HOME`) — с кодом 0 сразу. В обоих случаях Codex отдаёт не каталог аккаунта, а вшитый в него: 11 моделей, около 659 КБ. В этом каталоге видим `gpt-5.5`, нет `gpt-reserve`, есть две скрытые служебные модели. Порядок основных моделей по `priority` тот же. Поэтому офлайн проба не падает: кэш хоста до следующей удачной пробы может стать вшитым каталогом.
17. **Codex с уровнем, которого у модели нет.** `gpt-6-luna` с `ultra` отработал без ошибки: код 0, ответ «OK», в шапке `reasoning effort: ultra`. Codex такие пары не отвергает, поэтому строгость resolver Parley нужна, чтобы не предлагать уровень, которого у модели нет.

## 4. Решения брейншторма

1. **Объём:**
   - запуск: диалог новой сессии или комнаты и MCP `spawn_session`;
   - смена модели и effort в идущей сессии Claude/GLM из чата.

   Смена у идущего Codex делается вместе с его чатом (следующий подпроект) на том же устройстве.
2. **Каталог Codex** берётся из `codex debug models`, при сбое — встроенный список.
3. **По умолчанию в диалоге** и у модели, и у effort стоит «Default»: флаги не передаются, CLI берёт своё.
4. **У GLM** — пять уровней Claude Code (п. 9 раздела 3).
5. **Смена в идущей сессии — гибрид:**
   - effort — ползунком `/effort` + `s` с проверкой по подвалу;
   - модель — перезапуском через resume с `--model`/`--effort`, когда агент свободен.

## 5. Устройство

### 5.1 Каталог моделей

Каталог — это данные. Тип живёт в `packages/core/src/provider-models.ts`, протокол его переэкспортирует:

```ts
export interface EffortOption {
  /** Значение флага: `--effort <id>` / `model_reasoning_effort="<id>"`. */
  id: string;
  label: string;
  description?: string;
}

export interface ModelOption {
  id: string;
  label: string;
  /**
   * Уровни этой модели по порядку. `null` — у модели effort нет (Haiku).
   * Поля нет — каталог не знает (свой список в providers.json): действует правило провайдера.
   */
  efforts?: EffortOption[] | null;
}
```

Подписи уровней: `low` — Low, `medium` — Medium, `high` — High, `xhigh` — Extra high, `max` — Max, `ultra` — Ultra, `minimal` — Minimal, `none` — None. Незнакомый id пишется с заглавной буквы.

- **Claude** (`CLAUDE_MODELS`): у `best`, `fable`, `sonnet`, `opus`, `sonnet[1m]`, `opus[1m]`, `opusplan`, `opusplan[1m]` — пять уровней `low…max`, у `haiku` — `null`. Описаний у уровней нет.
- **GLM** (`GLM_MODELS`): у `glm-5.3[1m]` и `glm-5.3-flash[1m]` — пять уровней Claude Code.
- **Codex.** Встроенный запасной список (`CODEX_MODELS`) — это видимые модели из п. 12 раздела 3 с уровнями и описаниями из каталога 2026-10-06, в порядке `priority`. Живой каталог описан в п. 5.2.

Уровни модели «Default» — общие для всех моделей провайдера с непустым `efforts`, в порядке первой из них. Сегодня у Claude, GLM и Codex это `low…max`.

### 5.2 Каталог Codex от самого CLI

Новый модуль `packages/host/src/providers/codex-catalog.ts`, по образцу `versions.ts`.

- **Запуск пробы.** При старте хоста вызывается `codex debug models`: команда из записи реестра `codex`, с подменой `PARLEY_CODEX_BIN`. Таймаут 15 с, предел вывода 4 МБ.
- **Разбор:**
  - берутся модели с `visibility: "list"`, по порядку `priority`;
  - `id = slug`, `label = display_name`;
  - `efforts = supported_reasoning_levels`: `effort` становится `id`, описание — `description`;
  - если уровень не проходит токен из п. 5.3, модель выбрасывается из каталога с предупреждением.
- **Сбой.** Ненулевой выход, таймаут, вывод не JSON или пустой список дают `null` и предупреждение в лог. Тогда действует встроенный список.
- **Обновление.** Когда зовут `providers.list`, а кэш старше 6 часов, проба повторяется в фоне. Если каталог изменился, уходит событие `providers.changed`.
- **Приоритет списков.** `providers.list` отдаёт для `codex` живой каталог, если он есть, иначе встроенный. Оверрайд `models` в `providers.json` важнее обоих.
- **Общий для окна и MCP.** MCP-сервер агента — отдельный процесс, памяти хоста он не видит. Поэтому хост после удачной пробы атомарно пишет каталог в файл Parley `codex-models.json` в доме (`parleyHome()`), в форме `{ "fetchedAt": "<ISO>", "models": ModelOption[] }`. `loadProviders` в core подставляет его модели в запись `codex`, а после этого применяет `providers.json`. Испорченный или пустой файл молча игнорируется: это кэш Parley, а не настройка человека. Так окно, хост и MCP (`get_map`, `spawn_session`) видят один и тот же список (решение при планировании 2026-10-06).

**Рамка.** `codex debug models` — команда самого CLI, как проба `--version`. Parley не читает ни ключей, ни файлов входа и сам в API не ходит. Исключение рамки не нужно.

### 5.3 Один resolver

В `packages/core/src/providers.ts`:

```ts
/** Токен уровня: безопасен и в argv, и в кавычках TOML (`-c model_reasoning_effort="…"`). */
export const EFFORT_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;

export interface ModelEffortChoice { model?: string; effort?: string }

/** Уровни выбора для модели (`undefined` — «Default»); `null` — effort у провайдера или модели нет. */
export function effortsFor(entry: ProviderEntry, model: string | undefined): EffortOption[] | null;

/** Проверка пары для окна и MCP; ошибка — текст причины со списком допустимого. */
export function resolveModelEffort(entry: ProviderEntry, choice: ModelEffortChoice): ModelEffortChoice | { error: string };
```

Правила:
1. Пустая строка и отсутствие поля означают «Default».
2. Модель проверяется как сейчас в `modelChoiceError`: вид id и принадлежность списку, если список есть.
3. Effort:
   - должен проходить `EFFORT_TOKEN`;
   - у провайдера без `{effort}` в шаблоне значение отбрасывается, как сейчас;
   - у модели с `efforts: null` — ошибка «<model> has no effort levels; omit effort»;
   - уровень не из `effortsFor` — ошибка «<effort> is not a level of <model>; allowed: …».
4. У модели без поля `efforts` (свой список) при `{effort}` в шаблоне остаются прежние `low|medium|high`.

Хост (`packages/host/src/sessions/model-choice.ts`) и MCP (`packages/core/src/mcp/tools.ts`) вызывают resolver до записи в карту. Ошибка уходит как `bad_request` или как ошибка инструмента.

`EffortLevel` перестаёт быть закрытым набором, `RunnerSubstitutions.effort` становится `string`. `substituteArgs` проверяет значение по `EFFORT_TOKEN` перед любой подстановкой, в том числе в строку `model_reasoning_effort="{effort}"`, и бросает исключение при несоответствии.

### 5.4 Шаблоны запуска и resume

- `claude.resumeArgs`: добавить `--model {model} --effort {effort}` перед `--agent`.
- `glm.resumeArgs`: добавить `--effort {effort}` после `--model {model}`.
- `codex.resumeArgs`: без изменений, тред помнит модель и effort.
- `packages/core/src/work/launch.ts`, `plan()`: в ветке resume `subs.model` и `subs.effort` берутся так же, как при новом запуске: `options.* ?? session.*`. Пустое значение, как сейчас, убирает флаг целиком, и Claude восстановит модель сам.

### 5.5 Хранение

- `sessions.create` пишет разрешённые `model` и `effort` в карту, как это делает `spawn_session` (`WorkSession.model?`, `effort?`). «Default» означает, что поля нет.
- `WorkSession.effort` становится `string`. `parseMap` читает значение, не проходящее `EFFORT_TOKEN`, как «нет выбора». Делает это молча: логгера у core нет, а при следующей записи карта исправится сама.
- `sessions.setEffort` и `sessions.setModel` обновляют карту (п. 5.7, 5.8).

### 5.6 Протокол (`PROTOCOL_VERSION` остаётся 1)

- `ModelOption.efforts?` и `EffortOption` добавляются в `types.ts` и `index.ts`.
- `sessions.create.effort`: `z.string().regex(EFFORT_TOKEN).optional()`. Старые значения остаются валидными.
- Новые методы:

```ts
// methods.ts — параметры
'sessions.setEffort': z.object({ ref: sessionRef, effort: z.string().regex(EFFORT_TOKEN) }),
'sessions.setModel': z.object({ ref: sessionRef, model: z.string().max(200).regex(/^[^\s-]\S*$/) }),
// результаты
'sessions.setEffort': { effort: string | null; verified: boolean };
'sessions.setModel': { model: string; effort: string | null; restarted: boolean };
```

- Оба метода регистрируются в `hello.methods` (`packages/host/src/methods/index.ts`).
- `providers.list` сохраняет прежнюю форму, у моделей появляется `efforts`. `effort: boolean` остаётся для старых окон. Новое необязательное `argsOverridden?: boolean` означает, что `args` провайдера заменены из `providers.json`.
- MCP:
  - `get_map` отдаёт `efforts` у моделей;
  - `spawn_session.effort` — строка без `enum` с описанием «one of the model's efforts in get_map; with the default model — the levels shared by its provider's models»;
  - текст гида `packages/core/src/work/guide.ts` говорит то же.

### 5.7 Смена effort в идущей сессии (Claude, GLM)

Новый модуль `packages/host/src/pty/effort-switch.ts`, по образцу `mode-switch.ts` (`pty.write`, `pty.screenText`, ожидание тишины).

1. Условия:
   - PTY жив;
   - семейство `claude`;
   - активность сессии `idle`, иначе `HostError('busy')`;
   - уровень проходит resolver для сохранённой модели (или для «Default»).
2. Хост печатает `/effort` и Enter, затем до 3 с ждёт на экране `s for this session only`. Не дождался — Esc и `verified: false`.
3. Нажимает `←` столько раз, сколько у модели уровней, плюс один (упор в `low`). Затем `→` до индекса цели, затем `s`.
4. До 2 с ждёт подвал `/(?:^|\s)([a-z]+)\s*·\s*\/effort\b/`.
   - Уровень совпал: карта обновляется, ответ `{ effort, verified: true }`.
   - Не совпал или подвал не появился: Esc, если ползунок ещё открыт, ответ `{ effort: <что видно>|null, verified: false }`, карта не меняется.
5. «Default» в идущей сессии не предлагается: `/effort auto` стирает сохранённый уровень человека.

### 5.8 Смена модели в идущей сессии (Claude, GLM)

`sessions.setModel` в `sessions-service.ts`:

1. Модель проверяется resolver. Сохранённый effort остаётся, если он есть в `effortsFor(новая модель)`, иначе сбрасывается в «Default».
2. Сессия спит, закрыта или ещё ждёт запуска (`pending`): только запись в карту, ответ `restarted: false`. Следующий запуск или resume возьмёт новую модель.
3. Живая сессия: нужны активность `idle` и отсутствие `LiveTask` с `background: true`. Иначе `HostError('busy')`.
4. Порядок: запись в карту, `stop(ref)`, `launch(ref, 'resume')` с флагами из карты (п. 5.4), ответ `restarted: true`. Если resume не поднялся, ошибка уходит окну. Карта уже с новой моделью, и кнопка Resume повторит запуск.
5. Лента штатно покажет SessionStart (`source: resume`) с новой моделью. Сброс effort окно сообщает тостом.

### 5.9 Окно

**Диалог новой сессии или комнаты** (`NewSessionOrRoomDialog.tsx`, `store/providers.ts`):
- модель: «Default» и каталог;
- effort: выпадающий список «Default» и `effortsFor(модели)`, описание уровня — второй строкой пункта. Поле скрыто, если уровней нет (`null`) или провайдер не принимает effort;
- при смене модели недопустимый уровень сбрасывается в «Default», при смене провайдера в «Default» сбрасываются оба поля;
- отправляются только явно выбранные значения.

**Чат** (`ChatToolbar.tsx`, `ChatView.tsx`):
- **Кнопка** «<модель> · <effort>». Модель берётся из ленты (последний session-start или model-switch), а если в ленте её нет — из карты. Effort берётся из карты. Если данных нет, показывается «Default».
- **Меню** из двух разделов:
  - модели (радио, выбор вызывает `sessions.setModel`);
  - уровни сохранённой в карте модели, `effortsFor`; если модели в карте нет — уровни «Default». Радио без пункта «Default», выбор вызывает `sessions.setEffort`. Это тот же список, по которому хост проверяет уровень.
- **Неактивные пункты** объясняют причину: сессия не живая (effort), агент работает, идут фоновые задачи (модель).
- **Старый хост** без `sessions.setModel`/`setEffort`: меню нет, текст `/model` не отправляется.
- **GLM.** Меню возвращается и у GLM, это снимает хотфикс 0.5.3.
- **Подсказки `/model <id>`** в поле ввода убираются у всех: меню делает то же без записи в глобальные настройки. Команда `/model` остаётся в списке команд CLI.

**Карточка провайдера** (`ProviderCard.tsx`): при `argsOverridden: true` показывает строку «Launch arguments come from providers.json». Если из-за этого выбор модели или effort выключен, карточка объясняет почему.

Тексты окна — по-английски, в `packages/desktop/src/shared/strings.ts`.

### 5.10 `providers.json`

- Элемент `models` может нести `efforts: string[]` (токены без повторов) или `null`. Подписи выводятся по п. 5.1, проверка — в `checkShape`.
- `args` без `{model}`/`{effort}` по-прежнему выключают выбор. Автоматической миграции нет.

## 6. Ошибки и крайние случаи

| Ситуация | Поведение |
|---|---|
| Пара не из каталога (окно, MCP) | `bad_request` или ошибка инструмента с причиной и списком допустимого; карта не меняется, процесс не запускается |
| `codex debug models` недоступен | встроенный список, предупреждение в лог; `providers.list` работает |
| Codex: модель «Default» и уровень, которого нет у модели из `config.toml` | поведение Codex проверить на этапе 0 (раздел 9, п. 4). Уровни «Default» — пересечение, поэтому для видимых моделей случай не возникает |
| `setEffort`, агент работает | `busy`: «Wait until the agent is idle» |
| Ползунок не открылся или подвал показывает другой уровень (например, из-за `maxEffortLevel` администратора) | Esc, `verified: false` с увиденным уровнем; карта не меняется |
| `setModel`, агент занят или идут фоновые задачи | `busy`; пункт меню неактивен |
| `setModel`, resume не поднялся | ошибка уходит окну; в карте новая модель; Resume повторит |
| В карте испорченный effort | читается как «нет выбора», молча; при следующей записи карта исправится |
| Старое окно с новым хостом | шлёт `low|medium|high`, они валидны. Исключение — модель без effort (Haiku): старое окно и для неё шлёт `medium`, и хост отвечает `bad_request`. Случай редкий, решение финального ревью — принять его |
| Новое окно со старым хостом | нет `efforts` — прежние три уровня; нет методов — нет меню смены |

## 7. Совместимость и откат

Протокол меняется только добавлениями. Значения в картах остаются строками: старый хост прочитает `effort: "xhigh"` и подставит его как есть. Claude такое значение примет, а в TOML токен безопасен. Откат — revert PR.

## 8. Проверка

| Слой | Что | Тестов |
|---|---|---|
| core | каталог Claude/GLM; `effortsFor` (пересечение для «Default», `null` у Haiku); `resolveModelEffort` (все ветки п. 5.3); `EFFORT_TOKEN` в `substituteArgs`, в том числе попытки с `"` и пробелом; resume-шаблоны claude/glm; `plan()` resume с выбором из карты; `parseMap` с плохим effort; `checkShape` для `efforts`; гид | ~25 |
| core MCP | `get_map` с `efforts`; `spawn_session`: пара даёт ту же карту и тот же argv, что и окно; ошибки | ~8 |
| protocol | схемы `sessions.create.effort`, `setEffort`, `setModel`, `ModelOption.efforts` | ~6 |
| host | `codex-catalog` на стабе: урезанный настоящий вывод `codex debug models`, ненулевой выход, таймаут, не JSON, скрытые модели, перепроба по возрасту и `providers.changed`; `sessions.create` пишет выбор; `setEffort` на записанных экранах (ползунок открылся, не открылся, подвал другой, busy); `setModel`: сессия спит — только карта, живая — stop и resume с флагами, busy, сброс effort | ~25 |
| desktop | диалог: уровни по модели, сброс, «Default», скрытие у Haiku, старый хост; меню чата: разделы, вызовы, неактивные пункты, GLM, старый хост; нет подсказок `/model <id>`; карточка с `argsOverridden` | ~20 |
| E2E | диалог Codex со стабом каталога; меню чата на стабе Claude Code (вызовы методов) | +2 |

Живая приёмка на настоящих CLI описана в разделе 9 и в критериях 7–8.

## 9. Этап 0: что ещё проверить вживую (первая задача плана)

1. Как выглядит подвал для `xhigh` (знак и подпись) и как ведёт себя ползунок в GLM-сессии Parley.
2. Учитывает ли Z.ai effort у `glm-5.3-flash[1m]`.
3. Что делает `codex debug models` без сети и без входа: код выхода, вывод, время.
4. Что делает Codex с моделью «Default» и уровнем, которого у модели из `config.toml` нет: ошибка или опускание до ближайшего.

## 10. Критерии приёмки

1. Диалог Codex показывает видимые модели из `codex debug models` в порядке Codex. У `gpt-6.1-sol` уровни Default, Low, Medium, High, Extra high, Max, Ultra; у `gpt-6-luna` нет Ultra.
2. Диалог Claude: у Opus, Sonnet, Fable и Best — Default и пять уровней, у Haiku поля effort нет. Диалог GLM: обе модели, у каждой Default и пять уровней.
3. «Default» + «Default» → в argv:
   - у Claude нет `--model`/`--effort`;
   - у GLM нет `--effort`, а `--model` несёт настроенную модель `glm-5.3[1m]`, как и до этой работы;
   - у Codex нет `--model`/`model_reasoning_effort`.
4. Выбранная пара → в argv ровно одна пара флагов. Тот же выбор через MCP `spawn_session` даёт тот же argv и те же поля карты.
5. Пара не из каталога → `bad_request` со списком допустимого; нет ни записи в карте, ни процесса.
6. Сессия Claude, начатая с `low`: после Resume запрос к API несёт `effort: low` (проверка на заглушке).
7. Чат Claude и GLM, смена effort: уровень подтверждён подвалом не дольше 5 с, карта обновлена, `~/.claude/settings.json` до и после совпадает байт в байт (живая приёмка).
8. Чат Claude и GLM, смена модели: процесс перезапускается (`--resume <id> --model X`), следующий ответ помнит разговор, `settings.json` не изменился. Пока агент работает или идут фоновые задачи, пункт неактивен.
9. Сбой `codex debug models` (выход 1, таймаут, не JSON) → встроенный список, предупреждение в логе, `providers.list` отвечает.
10. Старое окно с новым хостом запускает сессии со своими тремя уровнями, кроме Haiku (раздел 6). Новое окно со старым хостом показывает три уровня, меню смены нет, текст `/model` не отправляется.
11. `providers.json` с `args` без `{effort}` → поля effort нет, карточка объясняет почему.
12. Тесты всех пакетов, typecheck, lint и рамочные тесты зелёные.

## 11. Файлы

| Файл | Что меняется |
|---|---|
| `packages/core/src/provider-models.ts` | `EffortOption`, `ModelOption.efforts`, уровни Claude/GLM, запасной список Codex |
| `packages/core/src/providers.ts` | `EFFORT_TOKEN`, `effortsFor`, `resolveModelEffort`, токен в `substituteArgs`, resume-шаблоны claude/glm, `efforts` в `checkShape`/`applyOverride`, модели `codex` из `codex-models.json` в `loadProviders` |
| `packages/core/src/work/launch.ts` | выбор из карты в ветке resume |
| `packages/core/src/work/map.ts`, `packages/core/src/work/types.ts` | `effort: string`, проверка в `parseMap` |
| `packages/core/src/mcp/tools.ts`, `packages/core/src/work/guide.ts` | схема и описание `effort`, `get_map` с `efforts`, resolver |
| `packages/protocol/src/methods.ts`, `types.ts`, `index.ts` | `sessions.create.effort`, `setEffort`, `setModel`, `efforts`, `argsOverridden` |
| `packages/host/src/providers/codex-catalog.ts` (новый), `packages/host/src/host.ts`, `packages/host/src/main.ts` | проба каталога Codex |
| `packages/host/src/methods/providers.ts` | живой каталог Codex, `argsOverridden` |
| `packages/host/src/methods/sessions.ts`, `packages/host/src/methods/index.ts` | обработчики и регистрация `setEffort`/`setModel` |
| `packages/host/src/sessions/model-choice.ts`, `packages/host/src/sessions/sessions-service.ts` | resolver, запись выбора, `setModel` |
| `packages/host/src/pty/effort-switch.ts` (новый) | ползунок `/effort` + `s` |
| `packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.tsx` | список уровней модели |
| `packages/desktop/src/renderer/chat/ChatToolbar.tsx`, `ChatView.tsx` | меню «модель · effort» |
| `packages/desktop/src/renderer/chat/use-suggestions.ts`, `suggestions.ts` | без подсказок `/model <id>` |
| `packages/desktop/src/renderer/store/providers.ts` | `efforts`, `argsOverridden` |
| `packages/desktop/src/renderer/components/providers/ProviderCard.tsx` | строка про `providers.json` |
| `packages/desktop/src/shared/strings.ts` | подписи уровней и подсказки |
| `README.md`, `CHANGELOG.md`, `TODOS.md` | диалог, чат, GLM, MCP; закрыть пункт TODOS из 0.5.3 |

## 12. Вне подпроекта

- Смена модели и effort у идущего Codex — вместе с чатом Codex.
- Чтение фактического effort из транскрипта Claude и rollout Codex.
- Миграция старых `providers.json`.
- Показ того, во что превращается «Default»: рамка запрещает читать `settings.json` Claude и `config.toml` Codex.
- Свои умолчания провайдера в Parley (profile defaults из плана Codex).

## 13. Приёмка (2026-10-06)

**Полный прогон, как в CI**, на ветке после слияния master с Kalmbik61/Parley#18 и Kalmbik61/Parley#19: install, build, typecheck и lint зелёные.

| Пакет | Тесты |
|---|---|
| core | 1837 |
| protocol | 96 |
| host | 926 |
| desktop | 4776, ещё 3 пропущены (вместе с голосовым вводом из master) |

**E2E: 103 из 108.**
- `codex.spec` и `second-instance.spec` в общем прогоне падают от нагрузки, по отдельности проходят.
- `host-disconnect.spec:165` и `restart-host.spec:54` так же падали на чистом master `cec7dcb`, то есть не от этой работы. Их починил Kalmbik61/Parley#19. После слияния master в ветку оба проходят: 11 из 11 в наборе `model-effort`, чат, голосовой ввод, провайдеры, `host-disconnect`, `restart-host`.
- `providers-connect` «800×500» был красным и до этой работы.

**Живая проверка в dev-окне.** Окно запущено с изолированным домом `~/.parley-chatview`, сценарий проходил пользователь, проверял контроллер.

| Критерий | Итог |
|---|---|
| 1 | Прошло. Проба `codex debug models` при старте хоста записала каталог (7 видимых моделей в порядке Codex). В диалоге уровни `gpt-6.1-sol` до Ultra. У `gpt-6-luna` Ultra нет, при смене модели уровень вернулся в Default. |
| 2 | Прошло. У Claude Opus Default и пять уровней, у Haiku поля нет. У обеих моделей GLM Default и пять уровней. |
| 3 | По тестам задач 2, 4, 9, 12. У GLM `--model` настроенной модели есть всегда, см. уточнение критерия. |
| 4 | Прошло для окна. Сессия Codex запущена ровно с `--model gpt-6.1-sol -c model_reasoning_effort="medium"`, тот же выбор лежит в карте. Для MCP — по тестам задач 7 и 9. |
| 5 | По тестам задач 2, 7, 9. |
| 6 | Прошло. После перезапуска у процесса Claude `--resume … --model opus --effort high`, следующий ход в транскрипте идёт с `effort=high`. |
| 7 | Прошло у Claude и GLM. `/effort` применился «this session only», кнопка и подвал показали уровень. |
| 8 | Прошло у Claude и GLM. После смены модели перезапуском Opus вспомнил «walnut». Пока агент отвечает, пункты неактивны. |
| 9 | По тестам задачи 8 и по факту 16. |
| 10 | По тестам задач 6, 12, 13. Исключение для Haiku описано в разделе 6. |
| 11 | По тестам задач 3, 8, 14. |
| 12 | Прошло, см. «Полный прогон, как в CI» выше. |

**Главное обещание выполнено.** `~/.claude/settings.json` после всех смен модели и effort у Claude и GLM совпал байт в байт со снимком, сделанным до приёмки.

**Найдено при приёмке и исправлено.** После перезапуска (смена модели, ручной Resume) статус сессии оставался working примерно минуту, до `idle_prompt`. Причина: хук `SessionStart` открывал ход. Теперь его открывает только `UserPromptSubmit`: после `startup`, `resume` и `clear` сессия стоит у приглашения, `compact` состояние не меняет.

Первый хук годится как признак готовности поля ввода. Проба на заглушке API показала, что `SessionStart` приходит через 0,2–0,35 с после запуска, а текст, набранный в этот момент, не теряется. После исправления проверено вживую: статус idle сразу после перезапуска.
