# A5 — голосовой промпт

- **Исполнитель:** junior. **Зависимости:** нет.
- **Сначала прочитать:** `00-common.md`; Спека §5.5; План §2, A5.

## Цель

Инструкции GPT-Live задаются один раз на сессию, поэтому две строки о действиях становятся нейтральными к режиму:
голос говорит «сделано» или «подтвердите на экране» по тому, что сказал итог.

## Шаги

В `packages/host/src/voice/voice-prompt.ts`, массив `VOICE_PROMPT`, заменить ровно две строки.

Строка о помощнике (сейчас «…and can prepare actions for the user to confirm on screen.»):

> - Parley assistant: knows the state of Parley rooms, sessions, background jobs, works and builds, and can change things in Parley for the user: it either does the action at once or prepares a card for the user to confirm on screen. The result says which of the two happened.

Строка об итоге действия (сейчас «When the result says an action was prepared, say that you prepared a card… Never say
an action was done before the user confirms.»):

> When the result says an action was done, say what was done. When the result says a card was prepared, say that you prepared a card and the user should confirm it on the screen. Never say an action was done unless the result says so.

Комментарий над `VOICE_PROMPT` поправить: вместо «о действиях — „подготовил карточку, подтвердите на экране“» — что
голос повторяет исход из итога.

## Тесты

В тесте `voice-prompt` (рядом с файлом; если теста текста нет — добавить):

- обе новые строки присутствуют;
- строки «Never say an action was done before the user confirms» нет;
- `liveSessionConfig()` по-прежнему отдаёт `instructions`, `delegation: { type: 'client' }` и триггер эмоции.

Существующее ожидание старого текста, если оно есть, меняется на новое — это разрешено.

## Не делать

- Не менять остальные строки промпта, триггер эмоции и конфиг сессии.

## Проверка

```
pnpm --filter @parley/host exec vitest run src/voice
pnpm --filter @parley/host build
```

## Готово, когда

Тесты проходят; изменены две строки промпта и комментарий; один коммит.
