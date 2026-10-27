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

### B01. Спайк `speech worker` (s-29)

Отчёт: `rea-lab/voice-tts/b01/RESULTS.md` (вне репозитория). Сборка из исходников: speech.cpp `49f022a4` (v0.9.0) +
ggml `cbdeccfd`, флаги релиза upstream (`Release`, `GGML_METAL_EMBED_LIBRARY=ON`, `GGML_NATIVE=OFF`), 102 с, бинарь
19 МБ, ссылается только на системные фреймворки.

- Протокол на живом процессе: 20/20 проверок.
- 80 синтезов (5 голосов × ru/en × 4 фразы × 2 seed), мс:

| Замер | p50 | p90 | максимум |
|---|---|---|---|
| первый кусок | 34,6 | 38,3 | 65,5 |
| первый слышимый отсчёт без срезки | 302 | 478 | 954 |
| **первый слышимый после срезки (Р4а)** | **195,8** | **295,0** | **509,5** |

- **Порог B01 пройден** (p50 ≤ 200 мс, p90 ≤ 1 с). Запас по p50 мал: медиана ryan ≈ 270 мс на worker, без доставки
  до острова.
- Ведущая тишина: p50 0,26 / p90 0,44 / максимум 0,92 с. RTF p50 0,230 / максимум 0,277.
- Отмена → `cancelled`: 19,6–21,0 мс. Закрытие stdin: выход 0 за 0,13 с в покое, с запросом в полёте — после его
  `end` (1,26 с).
- `ready`: холодный 15,0 с (компиляция Metal после каждой новой сборки), тёплый 1,26–1,65 с. RSS до 1,34 ГБ.
- Страж длины `max(3, 0,1·символы)·2`: 1 срабатывание на 80 (vivian en-1 seed 2, 10,8 с против ≈ 3,5 с).
- `gain` (Р4): serena 1,592; ryan 1,250; aiden 0,693; vivian 0,847; ono_anna 2,419. Лимитер работает у ryan и
  ono_anna.

### B02. Спайк промпта (s-28)

Отчёт: `rea-lab/assistant-prompt-b02/RESULT.md` (вне репозитория). Вариант F проходит на обеих моделях:

| Модель | Метки (48 ответов) | Род ж / м / ср (согласован / без формы / нарушен) |
|---|---|---|
| Haiku | 157/159 = 98,7 % | 8/2/0, 10/0/0, 10/0 |
| glm-5.3-flash | 154/160 = 96,3 % (97,5 % с `[[mood]` + пробел) | 9/1/0, 8/2/0, 10/0 |

Codex — отложен (лимит подписки до ≈ 2 ноября). Текст B06 (вариант A) порог меток не проходит: 80,3 % и 88,6 %.
Выбор между F (кириллица в образцах, `// cyrillic-ok:` на 3 строках) и E (транслит) — за человеком через s-21.
