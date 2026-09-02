# Fix Plan - my-harnas

Приоритеты соответствуют фазам: High = v0 (просмотрщик), Medium = v1 (PTY),
Low = v2 (раннеры Codex/GLM) + polish. **Low ≠ optional**: объём задачи — v0+v1+v2,
EXIT_SIGNAL: true только когда отмечены ВСЕ чекбоксы.

## High Priority

- [x] Run `node tools/claude-export.mjs --full` against the real `~/.claude/projects` (no `--limit` — summary stitching needs all files); copy the resulting `schema-report.json` and `index.json` into `docs/schema/`, scrubbing any sensitive strings from samples. Touch nothing else under `~/.claude`
- [x] Reconcile the observed schema with the assumptions in specs/data-layer.md (`isSidechain`, `parentUuid`, `leafUuid`, `message.model`, `type:"summary"` records); update specs/data-layer.md with confirmed findings BEFORE writing parser code
- [x] Initialize pnpm workspaces monorepo: `packages/core`, `packages/tui`; TypeScript 5 strict, vitest, eslint + prettier, build via tsc; root scripts `build`, `test`, `dev`
- [x] packages/core: streaming .jsonl reader tolerant of malformed/truncated lines (port the logic of tools/claude-export.mjs into typed modules; a truncated last line of a live session is normal, never an error)
- [x] packages/core: versioned schema adapter (`adapter-v1` for the observed schema) mapping raw records to typed SessionRecord per specs/data-layer.md; unknown fields preserved, nothing assumed mandatory
- [x] packages/core: session indexer — meta (sessionId, cwd, gitBranch, version), duration from first/last timestamps, model/tool/role counters, primaryModel per specs/data-layer.md
- [x] packages/core: session title — last `custom-title` / `ai-title` record wins, fallback `last-prompt` → first user text; `titleSource` in the index (per specs/data-layer.md; глобальная сшивка по leafUuid отменена находками)
- [x] packages/core: subsessions from disk layout — enumerate `<session-id>/subagents/**/agent-*.jsonl`, read the sibling `.meta.json` (agentType/name/description/toolUseId), task = `description` or first text for workflow agents, model badges from message.model; `journal.jsonl` is not a subsession (per specs/data-layer.md)
- [x] packages/core: vitest suite on fixtures — 2-3 real anonymized session files plus synthetic edge cases (truncated last line, summary in a neighbor file, orphan sidechain, missing timestamps)
- [x] packages/core: fs watcher over `~/.claude/projects` with debounce; incremental re-parse of only the changed file; emits typed change events
- [x] packages/core: CLI entry — `harnas-core index --json` and `harnas-core session <id> --json`, JSON to stdout only (this IS the core/UI contract)
- [x] packages/tui: Ink app skeleton with the three-pane layout per specs/ui.md (sessions top-left, subsessions bottom-left, right pane placeholder)
- [x] packages/tui: sessions list — summary/name, relative time + duration, primaryModel badge, sorted by recency, per specs/ui.md
- [x] packages/tui: subsessions panel for the selected session — task, model badge, duration
- [x] packages/tui: keyboard navigation (arrows + j/k, Tab between panes) and selection state per specs/ui.md
- [x] packages/tui: live refresh — re-render lists on core watcher events (event-driven redraw, no polling loops)
- [x] v0 perf sanity check on the largest real session file; if startup is slow, switch to lazy parse (index meta at startup, full tree on selection) per specs/ui.md

## Medium Priority

- [x] packages/tui: PTY manager — spawn the unmodified `claude` from PATH via node-pty per specs/pty.md; verify binary presence at startup with a clear error if missing
- [x] packages/tui: @xterm/headless as the VT state machine; render its buffer into the right pane on each PTY data batch per specs/pty.md
- [x] Enter on a session opens `claude --resume <sessionId>` in the right pane, with cwd set to the session's cwd
- [x] Focus routing: when the right pane is focused, forward ALL input to the PTY; a dedicated escape hatch (default Ctrl+Q, configurable) returns focus to the lists and must not collide with Claude Code keybindings, per specs/pty.md
- [x] PTY resize: on terminal resize recompute right-pane cols/rows and propagate to both node-pty and the xterm buffer
- [x] Alt-screen and mouse: pass mouse-reporting sequences through when the PTY requests them; verify claude's own UI (menus, scrolling) works embedded, per specs/pty.md
- [x] PTY lifecycle hardening: process exit/crash detection, restart action, one active PTY per session; warn (do not block) when several sessions run in parallel — subscription limits, per specs/pty.md
- [x] v1 integration test: scripted PTY session against a stub binary (NOT real claude) validating spawn / write / resize / teardown

## Low Priority

- [x] Research: run schema observation over `~/.codex/sessions` rollout logs; document the real format in specs/runners.md and commit a schema report to docs/schema/ (discovery task)
- [x] packages/core: Codex session adapter mapping rollout logs into the same SessionIndex model per specs/runners.md
- [x] Research: locate GLM harness session logs and document the format in specs/runners.md; if none exist, record the decision that GLM is runner-only (no history) — see specs/runners.md
- [x] packages/core: GLM session adapter, or runner-only stub per the research outcome
- [x] packages/tui: runner abstraction — spawn `codex` (and the GLM CLI) in the right pane through the same PTY manager per specs/runners.md
- [x] Unified model badges: normalization map (claude-* → Opus/Sonnet/Haiku, gpt-*/codex → Codex, glm-* → GLM) per specs/runners.md; provider badge in the sessions list
- [x] Multi-provider merge: one recency-sorted session list across providers with a provider filter
- [x] README.md: install, run, keybindings, the legal note (unmodified binary only, ~/.claude read-only)
- [x] Final pass: lint clean, tests green, manual smoke checklist from specs/ui.md walked through

## Discovered
- [x] packages/core: watcher invalidation — изменение `agent-*.jsonl` должно
      инвалидировать и родительскую сессию (подсессии живут в отдельных файлах)
- [x] packages/core: `observe()` схлопывает мапы с динамическими ключами
      (`snapshot.trackedFileBackups.<путь>`), иначе отчёт раздувается и тащит пути
- [x] packages/core: исключить `<synthetic>` из подсчёта `primaryModel`
- [x] specs/runners.md: дополнить таблицу бейджей — в реальных данных есть
      `claude-fable-5` и `claude-opus-4-8`, текущая таблица их не покрывает
- [ ] packages/tui: показывать `workflowName`/`status` из `<sid>/workflows/wf_<id>.json`
      как группировку подсессий (опционально, данные есть)
- [x] packages/core: у workflow-агентов первая реплика — общий префикс промпта, из-за
      чего задачи 240 подсессий выглядят одинаково («Ты — придирчивый техредактор…»).
      Нужен лучший ярлык: первая реплика ПОСЛЕ префикса либо `wf_<id>.json` / journal
- [ ] Ручная проверка встроенного `claude`: меню, прокрутка, мышь и alt-screen внутри
      правой панели. Автотестами не покрывается принципиально (реальный бинарь в
      тестах не запускаем), поэтому идёт в финальный smoke-чеклист v2
- [x] Мышь: поддерживается только SGR-кодирование (?1006). Древние X10 (?1005) и
      urxvt (?1015) не пробрасываются — записать ограничение в README
- [ ] UI-точка входа для запуска раннера без истории: GLM и «новая сессия» сейчас
      запускаются только программно (runnerCommand), клавиши в TUI для них нет
- [ ] Решить, что делать со старым кэшем `sessions-index.json` (3 шт., формат v1,
      данные января) — сейчас предполагается игнорировать

## Completed
- [x] Project documentation prepared (.ralph structure, specs, handoff imported)

## Notes

### Smoke-чеклист specs/ui.md, пройден 2026-09-02
1. **Пустой каталог** — «Сессий не найдено. Смотрим ~/.claude/projects и ~/.codex/sessions»,
   краша нет.
2. **Реальные данные** — 49 сессий Claude, ровно столько же файлов `<project>/<id>.jsonl`
   на диске. Единственное расхождение с вчерашним `claude-export/index.json` —
   сессия, файл которой с тех пор удалён.
3. **Новая сессия без рестарта** — появляется в списке по событию watcher.
   Проверялось на временном корне: писать в `~/.claude` нельзя, он read-only.
4. **Подсессии выбранной сессии** — показываются с бейджами моделей (проверено на
   сессии с 36 подсессиями).
5. **Разные ширины** (18/30/45/90) — за край не выходит ничего, заголовок и хвост
   разделены зазором, мета отбрасывает части по приоритету.

Не покрывается автоматикой принципиально: поведение живого `claude` внутри панели
(меню, прокрутка, мышь) — настоящий бинарь в тестах не запускается. Осталось в
Discovered как ручная проверка.


### node-pty на macOS + pnpm
pnpm распаковывает `prebuilds/*/spawn-helper` без бита исполнения, и любой spawn
падает с невнятным `posix_spawnp failed`. Чинится `scripts/fix-node-pty-perms.mjs`,
подключённым как корневой `postinstall` (идемпотентен, переживает переустановку).
Сам PTY в системе при этом рабочий — проверялось `pty.fork` из python.

### Перф v0, замер 2026-09-01 (M-серия, 47 сессий / 315 МБ)
| что | сколько |
|---|---|
| обход каталогов | 20 мс (47 сессий, 253 подсессии) |
| `buildIndex` — старт TUI | 753 мс, heap 51 МБ |
| индексация самого большого файла (52.4 МБ) | 91 мс |
| дерево сессии со 147 подсессиями | 324 мс |
| heap после работы | 22 МБ |

Вывод: ленивый разбор УЖЕ такой, как предписывает specs/ui.md — при старте только
индекс, дерево по выбору строки. Стриминговое чтение держит heap в десятках МБ
даже на 52-мегабайтном файле. Кэш распарсенного по mtime не нужен: перечитывание
одного файла стоит ~100 мс и происходит только по событию watcher.

### Сверка схемы 2026-09-01 (Claude Code 2.1.247, 335 файлов / 111 196 записей)
Снимок: `docs/schema/` (+ `tools/scrub-export.mjs` для очистки перед коммитом).
Полный разбор — в specs/data-layer.md, раздел «Что разошлось с прежними гипотезами».
Кратко, что сломало исходную модель данных:
- записей `type:"summary"` НЕТ вовсе; заголовок сессии — `custom-title` / `ai-title`,
  покрытие 47/47, сшивка по чужим файлам не нужна;
- `leafUuid` существует, но у записей `last-prompt` (последняя реплика), не у заголовка;
- подсессии — ОТДЕЛЬНЫЕ файлы `<session-id>/subagents/**/agent-<agentId>.jsonl`;
  `isSidechain:true` встречается только в них (100%) и никогда в главном файле;
- `sessionId` не уникален: 335 файлов = 47 сессий + 253 субагента + 35 журналов
  workflow; файлы субагентов несут `sessionId` родителя;
- задача подсессии берётся из соседнего `.meta.json`, но у 240 workflow-агентов там
  только `{agentType, spawnDepth}` — им нужен fallback на первую реплику;
- прототип `tools/claude-export.mjs` считает каждый файл сессией, поэтому его
  `index.json` даёт 335 «сессий» — это артефакт, а не данные;
- по итогам сверки переписаны две задачи High Priority (заголовок вместо сшивки
  summary; обход каталога вместо подъёма по parentUuid).

- Порядок в High Priority важен: сверка схемы (первые 2 задачи) идёт ДО кода парсера —
  модель данных фиксируется только по schema-report с реальных файлов.
- v3 (оркестрация нескольких провайдеров) — ВНЕ объёма этого плана. Не реализовывать.
- Допущения, принятые при подготовке плана: pnpm workspaces; vitest; названия пакетов
  `@harnas/core` и `@harnas/tui`; escape hatch Ctrl+Q. Менять можно — зафиксировать здесь.
- Открытые вопросы из хендоффа: реальная jsonl-схема не проверена; гипотеза сшивки
  summary через leafUuid не подтверждена; форматы Codex/GLM не изучены; перф Ink на
  длинных транскриптах не измерялся. Первые задачи каждого блока закрывают именно их.
- Политика Anthropic по сторонним харнессам менялась четырежды за 2026 год — перед
  началом v1 перечитать `code.claude.com/docs/en/legal-and-compliance`.
  **Перечитано 2026-09-02, архитектура v1 остаётся легальной.** Дословно:
  «The Claude Code binary must not be modified»; «Nor does it prevent an end user from
  signing in to the unmodified Claude Code binary with their own Claude subscription»;
  «developers may not collect, store, or intermediate Claude.ai credentials or session
  tokens». То есть спавн стокового `claude` из PATH под логином самого пользователя —
  ровно разрешённый сценарий, а `.credentials.json` не трогаем ни при каких условиях.
