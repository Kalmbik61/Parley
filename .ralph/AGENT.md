# Agent Build Instructions

## Project Setup
```bash
# Node.js >= 20, pnpm >= 9
pnpm install
```

## Running Tests
```bash
pnpm -r test                     # все пакеты (vitest)
pnpm --filter @harnas/core test  # только core
pnpm --filter @harnas/tui test   # только tui
```

## Build Commands
```bash
pnpm -r build                    # tsc build всех пакетов
```

## Development Server
```bash
pnpm --filter @harnas/tui dev    # запуск TUI (tsx watch)
node tools/claude-export.mjs --full   # standalone-экспортёр (прототип парсера)
```

## Key Learnings
- Реальная схема .jsonl (Claude Code 2.1.247) сильно расходится с исходными
  гипотезами — разбор в specs/data-layer.md, снимок в docs/schema/.
  Записей `type:"summary"` нет; подсессии — отдельные файлы в
  `<session-id>/subagents/`, а не `isSidechain`-записи внутри файла сессии.
- Перф v0: `buildIndex` по 47 реальным сессиям (315 МБ) — 753 мс, heap 51 МБ;
  самый большой файл 52.4 МБ читается за 91 мс. Ленивый разбор дерева обязателен
  и уже сделан; кэш по mtime не нужен.
- `exactOptionalPropertyTypes` в tsconfig не даёт передавать `undefined` в пропсы
  Ink — вместо `color={x ? 'cyan' : undefined}` нужен условный спред.
- `useStdout()` в не-TTY (пайп, тесты) отдаёт `rows: undefined` — без фолбэка
  весь макет схлопывается. Проверено тестом.
- Прогонять `pnpm exec prettier --write packages` перед коммитом: prettier
  намеренно не трогает `.ralph/`, `docs/` и прототип `tools/claude-export.mjs`.

## Feature Development Quality Standards

### Testing Requirements
- Minimum Coverage: 85% (packages/core); packages/tui — покрытие логики,
  рендер-снапшоты по возможности
- Test Pass Rate: 100%
- Test Types: Unit + Integration; PTY-интеграция только против stub-бинаря,
  НИКОГДА против реального `claude`
- Фикстуры: реальные анонимизированные jsonl + синтетические edge-cases

### Git Workflow
- Conventional commits: feat(core): message, feat(tui): message
- Feature branches: feature/<name>, fix/<name>
- All changes committed before marking complete

### Completion Checklist
- [ ] All tests pass
- [ ] Coverage >= 85% (core)
- [ ] Conventional commit messages
- [ ] fix_plan.md updated
- [ ] Documentation updated
