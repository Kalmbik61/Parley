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
- [Ralph заполняет по мере обнаружения]

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
