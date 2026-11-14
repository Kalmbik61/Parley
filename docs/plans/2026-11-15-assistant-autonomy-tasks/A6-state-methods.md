# A6 — состояние и методы: `autonomous`, `assistant.stopPlan`, `assistant.journal`

- **Исполнитель:** junior. **Зависимости:** A4.
- **Сначала прочитать:** `00-common.md`; Спека §5.6, §5.7, §10 (AU-14, AU-19, AU-20); План §2, A6; отчёт A3
  (обратный вызов остановки плана).

## Цель

Хост сообщает окну, включён ли режим, даёт остановить идущий план и отдаёт журнал решённых карточек.

## Шаги

1. **`AssistantState.autonomous`** (`packages/protocol/src/assistant.ts`): необязательное булево поле. Сервис
   публикует его в `assistant.changed`: при старте и при каждой смене флага.
2. **Смена флага без перезапуска.** В `host.ts` есть обёртка `settings.set` для `remoteCreate` (`:1277-1291`). Рядом:
   если в результате изменился `assistantAutonomy`, позвать у сервиса помощника метод, который перечитает флаг и
   переиздаст состояние.
3. **`assistant.stopPlan { proposalId }`.** Схема и результат — в `protocol/src/assistant.ts` рядом с
   `assistant.decide`; обработчик — `host/src/methods/assistant.ts`; регистрация — `methods/index.ts`. Сервис
   останавливает план с этим id через обратный вызов из A3; плана с таким id нет или он уже кончился —
   `{ stopped: false }`. Причина остановки в отчёте плана — «Stopped by the person».
4. **`CardStore.recent(limit)`** (`cards.ts`): решённые карточки (`state = 'decided'`, исход записан), новые первыми.
5. **`assistant.journal { limit }`** → `{ items: Array<{ id, kind, lines, decidedAt, via, outcome }> }`, `limit` от 1
   до 100, по умолчанию 30. `lines`: у карточки `actions` — строки шагов из `view.steps`; у остальных — цель
   (`view.target`) и первые 200 знаков текста.
6. **Роль `remote`.** Оба метода не входят в список методов телефона (`host/src/server.ts`, allowlist в
   `protocol/src/remote/`). Проверь и закрепи тестом; заодно — что `settings.set` роли `remote` недоступен.

## Тесты

- `assistant-service.test.ts`: `autonomous` в состоянии равен флагу; после смены флага уходит `assistant.changed` с
  новым значением; `stopPlan` во время плана из трёх шагов — идущий шаг доведён, третий `skipped`, причина «Stopped
  by the person»; `stopPlan` с чужим id — `stopped: false`, план идёт дальше.
- `cards.test.ts`: `recent` возвращает только решённые с исходом, новые первыми, не больше `limit`.
- тест метода `assistant.journal`: пометка `via: 'auto'` у автоматических; `lines` для плана и для письма.
- `server.test.ts`: клиент роли `remote` получает `unknown_method` на `assistant.stopPlan`, `assistant.journal` и
  `settings.set`.

## Не делать

- Окно и остров — A7 и A8.
- Не добавлять методы в `ISLAND_METHODS` — это делает A8.

## Проверка

```
pnpm --filter @parley/host exec vitest run src/assistant src/methods src/server.test.ts
pnpm --filter @parley/protocol build && pnpm --filter @parley/host build
```

## Готово, когда

Тесты проходят; в отчёте — точные имена методов, схемы параметров и результатов: их использует окно.
