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
- [ ] packages/core: session title — last `custom-title` / `ai-title` record wins, fallback `last-prompt` → first user text; `titleSource` in the index (per specs/data-layer.md; глобальная сшивка по leafUuid отменена находками)
- [ ] packages/core: subsessions from disk layout — enumerate `<session-id>/subagents/**/agent-*.jsonl`, read the sibling `.meta.json` (agentType/name/description/toolUseId), task = `description` or first text for workflow agents, model badges from message.model; `journal.jsonl` is not a subsession (per specs/data-layer.md)
- [ ] packages/core: vitest suite on fixtures — 2-3 real anonymized session files plus synthetic edge cases (truncated last line, summary in a neighbor file, orphan sidechain, missing timestamps)
- [ ] packages/core: fs watcher over `~/.claude/projects` with debounce; incremental re-parse of only the changed file; emits typed change events
- [ ] packages/core: CLI entry — `harnas-core index --json` and `harnas-core session <id> --json`, JSON to stdout only (this IS the core/UI contract)
- [ ] packages/tui: Ink app skeleton with the three-pane layout per specs/ui.md (sessions top-left, subsessions bottom-left, right pane placeholder)
- [ ] packages/tui: sessions list — summary/name, relative time + duration, primaryModel badge, sorted by recency, per specs/ui.md
- [ ] packages/tui: subsessions panel for the selected session — task, model badge, duration
- [ ] packages/tui: keyboard navigation (arrows + j/k, Tab between panes) and selection state per specs/ui.md
- [ ] packages/tui: live refresh — re-render lists on core watcher events (event-driven redraw, no polling loops)
- [ ] v0 perf sanity check on the largest real session file; if startup is slow, switch to lazy parse (index meta at startup, full tree on selection) per specs/ui.md

## Medium Priority

- [ ] packages/tui: PTY manager — spawn the unmodified `claude` from PATH via node-pty per specs/pty.md; verify binary presence at startup with a clear error if missing
- [ ] packages/tui: @xterm/headless as the VT state machine; render its buffer into the right pane on each PTY data batch per specs/pty.md
- [ ] Enter on a session opens `claude --resume <sessionId>` in the right pane, with cwd set to the session's cwd
- [ ] Focus routing: when the right pane is focused, forward ALL input to the PTY; a dedicated escape hatch (default Ctrl+Q, configurable) returns focus to the lists and must not collide with Claude Code keybindings, per specs/pty.md
- [ ] PTY resize: on terminal resize recompute right-pane cols/rows and propagate to both node-pty and the xterm buffer
- [ ] Alt-screen and mouse: pass mouse-reporting sequences through when the PTY requests them; verify claude's own UI (menus, scrolling) works embedded, per specs/pty.md
- [ ] PTY lifecycle hardening: process exit/crash detection, restart action, one active PTY per session; warn (do not block) when several sessions run in parallel — subscription limits, per specs/pty.md
- [ ] v1 integration test: scripted PTY session against a stub binary (NOT real claude) validating spawn / write / resize / teardown

## Low Priority

- [ ] Research: run schema observation over `~/.codex/sessions` rollout logs; document the real format in specs/runners.md and commit a schema report to docs/schema/ (discovery task)
- [ ] packages/core: Codex session adapter mapping rollout logs into the same SessionIndex model per specs/runners.md
- [ ] Research: locate GLM harness session logs and document the format in specs/runners.md; if none exist, record the decision that GLM is runner-only (no history) — see specs/runners.md
- [ ] packages/core: GLM session adapter, or runner-only stub per the research outcome
- [ ] packages/tui: runner abstraction — spawn `codex` (and the GLM CLI) in the right pane through the same PTY manager per specs/runners.md
- [ ] Unified model badges: normalization map (claude-* → Opus/Sonnet/Haiku, gpt-*/codex → Codex, glm-* → GLM) per specs/runners.md; provider badge in the sessions list
- [ ] Multi-provider merge: one recency-sorted session list across providers with a provider filter
- [ ] README.md: install, run, keybindings, the legal note (unmodified binary only, ~/.claude read-only)
- [ ] Final pass: lint clean, tests green, manual smoke checklist from specs/ui.md walked through

## Discovered
- [ ] packages/core: watcher invalidation — изменение `agent-*.jsonl` должно
      инвалидировать и родительскую сессию (подсессии живут в отдельных файлах)
- [ ] packages/core: `observe()` схлопывает мапы с динамическими ключами
      (`snapshot.trackedFileBackups.<путь>`), иначе отчёт раздувается и тащит пути
- [x] packages/core: исключить `<synthetic>` из подсчёта `primaryModel`
- [ ] specs/runners.md: дополнить таблицу бейджей — в реальных данных есть
      `claude-fable-5` и `claude-opus-4-8`, текущая таблица их не покрывает
- [ ] packages/tui: показывать `workflowName`/`status` из `<sid>/workflows/wf_<id>.json`
      как группировку подсессий (опционально, данные есть)
- [ ] Решить, что делать со старым кэшем `sessions-index.json` (3 шт., формат v1,
      данные января) — сейчас предполагается игнорировать

## Completed
- [x] Project documentation prepared (.ralph structure, specs, handoff imported)

## Notes

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
