# A1 — флаг конфигурации `assistantAutonomy`

- **Исполнитель:** junior. **Зависимости:** нет.
- **Сначала прочитать:** `00-common.md`; Спека §5.1 (первые два пункта); План §2, A1.

## Цель

В конфиге хоста появляется булев ключ `assistantAutonomy`, по умолчанию `false`. Больше ничего: ни хост, ни окно его
пока не читают.

## Шаги

Образец — ключ `remoteCreate` в `packages/core/src/config.ts`. Повтори каждое место, где он встречается:

1. поле в `interface ParleyConfig` с комментарием: что это переключатель автономного режима помощника, ссылка на
   спеку 2026-11-15;
2. `DEFAULT_CONFIG`: `assistantAutonomy: false`;
3. `ENV_NAMES`: `assistantAutonomy: 'ASSISTANT_AUTONOMY'`;
4. `fromFile`: `take('assistantAutonomy', …)` как у булевых ключей;
5. `fromEnv`: добавить ключ в объединение типа у `flag` и вызвать `flag('assistantAutonomy')`;
6. `BOOLEAN_KEYS`.

## Тесты

В `packages/core/src/config.test.ts`, рядом с тестами `remoteCreate`:

- умолчание `false`;
- `PARLEY_ASSISTANT_AUTONOMY=1` даёт `true` и ключ в списке заблокированных переменной;
- значение `true` из файла читается; значение `"yes please"` из файла — ошибка в том же виде, что у `remoteCreate`;
- `parseSetting('assistantAutonomy', 'true')` принимает значение, `'maybe'` — отвергает.

## Не делать

- Не трогать хост, протокол и окно.
- Не добавлять ключ в allowlist телефона и в какие-либо списки удалённого доступа.

## Проверка

```
pnpm --filter @parley/core exec vitest run src/config.test.ts
pnpm --filter @parley/core build
```

## Готово, когда

Тесты выше есть и проходят; остальные тесты `config.test.ts` не менялись; один коммит на ветке.
