# A8 — остров: значок, ход и стоп

- **Исполнитель:** junior. **Зависимости:** A6; `strings.ts` — после A7.
- **Сначала прочитать:** `00-common.md`; Спека §5.6, §10 (AU-14, AU-18); План §2, A8; отчёт A6.

## Цель

На острове видно, что автономный режим включён; ход плана и кнопка «Stop» видны всегда, в том числе в компактном
виде при активном Live.

## Что есть сейчас

- `AssistantView.tsx`: строка статуса — `:396-405`; ход плана `PlanReport` — `:148-176`, рисуется в `:432`;
  компактный вид (`compact`, `:362`) скрывает весь блок `:409-439`, вместе с ходом плана и исходами.
- Состояние хоста острову приходит событием `assistant.changed` (`store.ts`, `applyHost`).
- Остров может звать только методы из `ISLAND_METHODS` (`packages/desktop/src/shared/island.ts:237-264`).
- Пропсы вида собирает `IslandApp.tsx:845-882`.

## Шаги

1. **Значок.** `store.ts` берёт `autonomous` из состояния хоста. `AssistantView.tsx`: в строке статуса, пока
   `autonomous === true`, значок `data-testid="assistant-auto"` с текстом `S.assistant.autoBadge` («Auto»),
   предупреждающим цветом; подсказка `S.assistant.autoBadgeHint` («Autonomous mode: actions run without
   confirmation»). В компактном виде значок тоже виден.
2. **Ход плана в компактном виде.** Когда `compact` и есть `report`: одна строка `reportLine(report)` и кнопка
   «Stop». Полный `PlanReport` в компактном виде не показывать.
3. **Кнопка «Stop».** В `PlanReport` и в компактной строке, пока `report.status === 'running'`:
   `data-testid="assistant-stop-plan"`, зовёт `props.onStopPlan(report.proposalId)`. После нажатия, пока план не
   кончился, вместо кнопки — `S.assistant.stopping` («Stopping after the current step»). Кнопки нет, если
   `onStopPlan` не передан.
4. **Проводка.** `island.ts`: `assistant.stopPlan` в `ISLAND_METHODS`. `store.ts`: действие `stopPlan(id)` зовёт
   метод. `IslandApp.tsx`: передаёт `onStopPlan`, только если метод есть в `hello.methods` хоста.
5. **Строки** в `strings.ts`, раздел `assistant`: `autoBadge`, `autoBadgeHint`, `stopPlan` («Stop»), `stopping`.

## Тесты

`AssistantView.test.tsx`, `store.test.ts`:

- значок есть при `autonomous: true`, в обычном и компактном виде; нет при `false` и при отсутствии поля;
- компактный вид с идущим планом показывает строку хода и кнопку «Stop»;
- клик зовёт `onStopPlan` с id плана; после клика — «Stopping after the current step»;
- без `onStopPlan` кнопки нет;
- `store.stopPlan` зовёт `assistant.stopPlan`.

`packages/desktop/e2e/assistant.spec.ts`: остров 800×500, состояния «режим включён» и «режим выключен», обычный и
компактный вид; идущий план с кнопкой «Stop». Если e2e в рабочей копии не запускается — напиши в отчёте, что именно
помешало; тест всё равно добавь.

## Не делать

- Не менять поведение карточки с кнопками и подтверждения.
- Доставка служебных итогов и `watchNote` — W4.

## Проверка

```
pnpm --filter @parley/desktop exec vitest run src/renderer/island/assistant
pnpm typecheck
```

## Готово, когда

Тесты проходят; в отчёте — что показано в каждом из четырёх состояний (режим × вид) и запускался ли e2e.
