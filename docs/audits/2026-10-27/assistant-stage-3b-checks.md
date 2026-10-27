# Этап 3b: журнал проверок

План: `docs/plans/2026-10-27-assistant-stage-3b-plan.md` (p-20 rev 1, принят человеком, m-1405).
Интеграционная ветка `feat/assistant-stage-3b`, интегратор s-35. Полный набор (план §6):
`pnpm build && pnpm typecheck && pnpm lint && LC_ALL=C pnpm -r --workspace-concurrency=1 test`.

Тесты гоняются без переменных окружения сессии Parley (`PARLEY_*`, `HARNAS_*`): с ними два теста
`contextFromEnv` в `packages/core/src/mcp/server.test.ts` читают окружение агента и падают.

## Волна 0

### B00. База и замер «до»

- База: `feat/island-agents` @ `de8d134a4ca07471cfd0ff3b31e4930b97ffecd2` (решение s-21, m-1415; вместо `7c03432f`
  из §0 плана — та же ветка, плюс коммит B00d).
- B00d выполнена коммитом `de8d134a` («docs: describe the island's origins in neutral terms»), на базе.

Полный набор на базе, 2026-10-27:

| Шаг | Итог |
|---|---|
| `pnpm build` | зелёный |
| `pnpm typecheck` | зелёный |
| `pnpm lint` | 54 ошибки в 11 файлах — остаток базы (ниже) |
| core | 157 файлов, 4503 прошли, 1 пропущен |
| file-icons | 2 файла, 18 прошли |
| protocol | 22 файла, 348 прошли |
| host | 2 падения (остаток базы, ниже), остальное зелёное |
| desktop | 1 падение (остаток базы, ниже), 8104 прошли, 3 пропущены |

**Остаток базы — lint** (решение s-21, m-1424: вне объёма 3b, не чинится; критерий волны — нет новых ошибок
против этого списка):

| Ошибок | Файл |
|---|---|
| 1 | `packages/core/src/mcp/plan-tools.test.ts` |
| 6 | `packages/core/src/work/autonomous.test.ts` |
| 2 | `packages/core/src/work/autonomous.ts` |
| 5 | `packages/core/src/work/map.test.ts` |
| 4 | `packages/host/src/agent/attempts-endpoint.test.ts` |
| 2 | `packages/host/src/agent/attempts-endpoint.ts` |
| 3 | `packages/host/src/rooms/autonomous-cycle.test.ts` |
| 8 | `packages/host/src/rooms/autonomous-engine.test.ts` |
| 1 | `packages/host/src/rooms/autonomous-engine.ts` |
| 15 | `packages/host/src/rooms/check-runner.test.ts` |
| 7 | `packages/host/src/rooms/check-runner.ts` |

**Остаток базы — тесты**. Эти тесты падают на базе и при повторном одиночном прогоне:
- host `src/sessions/sessions-service.test.ts` › «lean: решение при создании и запуск по записи в карте (часть C,
  C2.2)» — 2 теста (resume lean-сессии);
- desktop `src/main/ui-store.test.ts` › «save сливает island на один уровень: место не стирает enabled» — 1 тест.

Под нагрузкой (параллельные сборки в соседних worktree) в host падали ещё 14 тестов: `context-pages`,
`autonomous-cycle`, `autonomous-engine`, `works-service.window`, `works-service.serial`. Без нагрузки все они
зелёные — это тайм-ауты, не дефект. Поэтому полный набор интегратор гоняет только при пустой машине.

Критерий волны: build и typecheck зелёные; новых ошибок lint нет; новых падений тестов против этого остатка нет.

**CPU «до»** (CPU окна острова в покое с пилюлей и при занятом мини-рое): без человека за Mac не снимается, переходит
в ручную проверку B26 (§7).
