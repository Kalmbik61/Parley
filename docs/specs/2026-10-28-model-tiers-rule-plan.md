# Правило уровней моделей в самом Parley — план

**Дата:** 2026-10-28. **Статус:** план к реализации по слову человека (сессия s-62 «IMPACT»): правило из `PARLEY.md` этого проекта (раздел Roles) должно стать правилом самого Parley, которое получает каждый агент в любом проекте. Исполнитель — модель стандартного уровня, проверка — s-62.

**Основа:** словарь уровней уже есть в продукте: встроенные роли несут `tier` strong / standard / light, `modelForTier` (`packages/core/src/roles/builtin.ts`) переводит его в Opus / Sonnet / Haiku и gpt-6-astra / gpt-6.1-sol / gpt-6-luna; таблица уровней — спека ролей `2026-10-02-agent-roles-design.md`. Рецепт «Plan & build» уже делит работу так: Planner (strong, ведущий), Critic (strong), Executor (standard, worktree), Reviewer (strong).

## 1. Цель и граница

Каждый агент, которого Parley запускает в любом проекте, получает правило: реализацию делают модели стандартного уровня, подготовку, ведение и проверку — сильные; сильная модель пишет код только по названной причине; реализация начинается с готового плана с задачами. Правило — текст Parley в местах, где агент выбирает модель или раздаёт части: системная вставка, `read_guide`, бриф ведущего, промпты встроенных ролей, шаблон `PARLEY.md`. Новых сущностей, инструментов и принуждения в хосте нет; `PARLEY.md` проекта может правило изменить.

## 2. Канонический текст (английский, продукт)

Полная форма — тема `tools` гида, абзац после `create_session`:

> Pick the model by the work, not by habit. Built-in roles carry a tier: strong (Planner, Architect, Critic, Reviewer, Feature Lead, Debugger) prepares, leads and reviews; standard (Executor, Verifier) implements and checks; light (Researcher) reads. Implementation starts from a prepared plan: tasks with scope, files and acceptance criteria. It runs on the standard tier: pass `role: "builtin:executor"` or a standard model (Sonnet, gpt-6.1-sol), one task per session. A strong model writes code only when the human asks for it, a standard attempt failed twice on the same task, the plan marks the task strong-only (concurrency, recovery, security, the write boundary), or the Debugger repairs a failure it reproduced; name the reason in the room before the hand-off. A project's PARLEY.md may change this split.

Короткие формы — в задачах ниже. Везде английский; слова «senior / junior» не использовать: в продукте уровни называются strong / standard / light.

## 3. Задачи

| № | Файл | Что сделать |
|---|---|---|
| T1 | `packages/core/src/work/guidance.ts`, строка `create_session` в `stableGuidance` | Дописать в конец строки: ` Implementation on standard-tier models (Executor); strong models prepare, lead and review.` Бюджет: `STABLE_POLICY_MAX_BYTES` 4 096 — сейчас 3 922 байт, с навигатором скиллов 3 988; строк остаётся 14. Не влезло — укорачивать эту фразу, не соседние строки; константу не поднимать. |
| T2 | `packages/core/src/work/guide.ts`, тема `tools` | После абзаца `create_session(...)` (он кончается словами «separately from these Parley sessions.») вставить канонический абзац из §2 отдельным абзацем. |
| T3 | `packages/core/src/work/guide.ts`, тема `lead`, шаг 5 | После «the hand-out message itself is the news.» добавить: `Implementation parts go to standard-tier sessions (Executor); strong models keep the plan, the critique and the review, and take code only for a named reason (topic \`tools\`, \`create_session\`).` |
| T4 | `packages/core/src/work/brief.ts`, `LEAD_ROLE` | Перед последним предложением («If Parley reports a participant as stuck…») вставить: `Hand implementation to standard-tier sessions (Executor); strong models prepare, lead and review, and take code only for a named reason.` Тест `brief.test.ts:406` требует, чтобы `LEAD_ROLE` по-прежнему кончался «follow topic \`stuck\` of \`read_guide\`.». Тот же текст уходит подсказкой `roomTask` в `check_inbox` (`mcp/tools.ts:280`) — это ожидаемо. |
| T5 | `packages/core/src/roles/builtin.ts` | Feature Lead: «Delegate implementation to responsible sessions, existing ones or peers you create.» → «Delegate implementation to responsible sessions, existing ones or peers you create, on the standard tier (Executor); a strong model takes code only for a named reason.» Planner: после «Keep steps small enough to review and assign.» добавить «Assign implementation steps to standard-tier executors; mark a step strong-only with its reason (concurrency, recovery, security, the write boundary).» Уровни ролей не менять. |
| T6 | `packages/core/src/work/parley-md.ts`, строка 190 (шаблон) | Комментарий раздела Roles: `<!-- Who leads rooms by default; which provider or model takes which kind of work. Parley's default: strong models plan, lead and review, standard models implement; write here only what differs. -->` |
| T7 | `README.md` после абзаца **Approvals.** (около строки 154); `CHANGELOG.md`, Unreleased → Changed | README, один абзац: `**Models by tier.** Built-in roles carry a tier: strong models (Opus, GPT-6-Astra) plan, lead, critique and review; standard models (Sonnet, GPT-6.1-Sol) implement and verify; light ones (Haiku, GPT-6-Luna) research. Parley tells agents to keep implementation on the standard tier and to name the reason when a strong model writes code; a project's \`PARLEY.md\` can change the split.` CHANGELOG, один пункт в Changed: `Agents are told to keep implementation on standard-tier models (Executor) and to leave preparation, leading and review to strong ones; a strong model takes code only for a named reason. The rule is in the system insert, \`read_guide\` (topics \`tools\` and \`lead\`), the lead's brief, the Planner and Feature Lead prompts and the \`PARLEY.md\` template; a project's \`PARLEY.md\` can change it.` |
| T8 | Тесты рядом с каждым файлом | `guidance.test.ts`: строка `create_session` содержит «standard-tier models (Executor)»; бюджетные тесты (14 строк, байты) остаются. `guide.test.ts`: тема `tools` содержит «Pick the model by the work, not by habit.» и «A project's PARLEY.md may change this split.»; тема `lead` содержит «Implementation parts go to standard-tier sessions (Executor)». `brief.test.ts`: `LEAD_ROLE` содержит «Hand implementation to standard-tier sessions (Executor)» и по-прежнему кончается темой `stuck`. `roles/builtin.test.ts` и тесты `parley-md` — обновить, если они закрепляют изменённый текст. Новые тесты — по одному `it` на место, в стиле соседних (русские заголовки `it`). |

## 4. Приёмка

- `pnpm --filter @parley/core test` зелёный; отдельно названы прогоны `guidance`, `guide`, `brief`, `tools`, `tools-size`, `roles`, `parley-md`.
- `pnpm --filter @parley/core build` и `pnpm lint` для `packages/core`: новых ошибок нет (остаток базы по lint перечислен в `docs/audits/2026-10-27/assistant-stage-3b-checks.md`, B00).
- Отчёт содержит числа: байты `stableGuidance()` для `{}`, `{skillNavigator: true, skillList: 'names'}` и `{toolProfile: 'short'}` после правки; байты описаний инструментов — без изменений (5 580).
- Весь продуктовый текст по-английски; «senior / junior» не встречается; `tier` ролей и `modelForTier` не тронуты; новых инструментов и проверок в хосте нет.

## 5. Вне объёма

Модель по умолчанию в диалоге окна без роли; родные роли Codex человека (`~/.codex`, все на gpt-6-astra); принуждение в хосте (отказ создавать исполнителя на сильной модели); смена уровня у Debugger — он остаётся strong, его починка названа допустимым случаем.
