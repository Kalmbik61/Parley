# A7 — окно: переключатель и журнал

- **Исполнитель:** junior. **Зависимости:** A1, A6.
- **Сначала прочитать:** `00-common.md`; Спека §5.1 (окно), §5.7, §9; План §2, A7; отчёт A6 (имена методов и схемы).

## Цель

В Settings → Assistant появляются переключатель автономного режима и список последних действий помощника.

## Что есть сейчас

- `AssistantSettings.tsx` работает только с `ui.json` (`useUiStore`), настроек хоста не знает.
- Настройки хоста читает и пишет `SettingsDialog.tsx` (`settings.get` → `config`, `locked`; `save(key, value)`) и
  передаёт их вкладкам. Образец вкладки с флагом хоста — `RemoteSettings.tsx:281-293`, образец переключателя во
  вкладке Agents — `SettingsDialog.tsx:434-452` (`leanAgents`).

## Шаги

1. `SettingsDialog.tsx`: передать `AssistantSettings` пропсы `bridge`, `config`, `locked`, `save` и ошибку ключа
   `assistantAutonomy`, как у `RemoteSettings` (`:737-739`).
2. `AssistantSettings.tsx`: блок «Autonomous mode» с `Switch`:
   - показывается, только если `config?.assistantAutonomy !== undefined`;
   - `disabled`, пока `config === null` или ключ есть в `locked`; при блокировке — подпись `S.settings.lockedBy(...)`;
   - переключение — `save('assistantAutonomy', checked ? 'true' : 'false')`;
   - под ним подсказка и строка ошибки сохранения.
3. Новый `AssistantJournal.tsx`: список «Recent actions». Зовёт `assistant.journal { limit: 30 }`, только если метод
   есть в `hello.methods` (как окно проверяет другие новые методы — найди образец по `hello.methods` в
   `packages/desktop/src`). Строка: время, строки действия, исход, пометка `auto` у автоматических. Пустой список —
   одна строка «No actions yet». Обновляется при открытии вкладки.
4. `strings.ts`, раздел `assistant.settings`: `autonomy`, `autonomyHint`, `journalTitle`, `journalEmpty`,
   `journalAuto`. Тексты:
   - `autonomy`: «Autonomous mode»;
   - `autonomyHint`: «The assistant does what you ask at once, without confirmation cards. Works from the island on
     this Mac only; Telegram and the phone still ask.»;
   - `journalTitle`: «Recent actions»; `journalEmpty`: «No actions yet»; `journalAuto`: «auto».

## Тесты

`AssistantSettings.test.tsx`, `AssistantJournal.test.tsx`:

- переключателя нет, когда ключа нет в `config`;
- переключатель выключен для правки и показывает подпись, когда ключ в `locked`;
- клик зовёт `save('assistantAutonomy', 'true')`;
- журнал не зовёт метод, когда его нет в `hello.methods`;
- 30 строк, пометка `auto`, пустое состояние;
- длинные значения: название работы и текст письма по 300 знаков — строка обрезается, вёрстка не уезжает.

## Не делать

- Остров — A8.
- Не переносить настройки помощника из `ui.json` в конфиг хоста.

## Проверка

```
pnpm --filter @parley/desktop exec vitest run src/renderer/components/settings
pnpm typecheck
```

## Готово, когда

Тесты проходят; в отчёте — снимки или описание двух состояний вкладки (режим выключен, включён) и состояния
блокировки переменной.
