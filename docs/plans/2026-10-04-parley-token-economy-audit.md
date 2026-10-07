# Parley: экономия токенов — включение аудита в реализацию

Дата: 2026-10-04. Это дополнение к единому плану по просьбе человека; прежние задачи и ID сохранены. Реализация продолжается в codex/parley-upgrade, исполнители и независимые проверяющие gpt-6.1-sol/high. Аудит добавляет P34–P38 перед итоговым P32/P33; с P39 для внутреннего навыка в очереди 40 задач.

## Источники и применимость

- [Полный аудит, раздел контекста C1–C6](../audits/2026-10-03/Parley-audit-full-2026-10-03.md#полезные-выводы).
- [План исправлений A11/A14/A21/A22 и F01–F05](../audits/2026-10-03/Parley-remediation-plan-RU-2026-10-03.md#f05-доказать-экономию-на-принятом-результате).

Оба исходных файла скопированы без изменения из указанного человеком каталога. Аудит выполнен на 72a87361d8073c011e60f31e5d254f1045ff086b — нашей исходной кодовой базе. Его номера строк исторические: перед изменением проверяется актуальная реализация. Другие security/UX/remediation задачи аудита автоматически в эту очередь не перенесены.

## Согласование с уже сделанным

| Источник | Состояние обновления | Действие |
|---|---|---|
| C4/A22/F01: неверный inventory/включённость/cwd | P05–P08/P13 приняты; общий resolver, native identity/policy и participant context | Продолжить native parity в P32; старый scanner повторно не внедрять |
| C5: 14 строк не ограничивают объём | P09 проверяет final serialized argv/env; role/PARLEY/playbook по 32768 bytes, полный обязательный аргумент 98304 | Сохранить эти guards; P34 ограничивает исходные guidance/brief и лишнее повторение до serialization |
| C1/A14: полные map/history и большие брифы | Финальный argv guard не ограничивает MCP/GUI ответы | P34/P35: отдельные бюджеты, компактные projections и cursor pages |
| C2/C3/A21/QA-V4: frozen metrics/cache не виден | Не закрыто текущими P00–P21 | P36: fresh valid binding/epoch, nullable cache counters, дедупликация и ledger |
| A11/A25: launches/fanout/ненужная стартовая сессия | Количество агентов влияет на общий расход принятой задачи | P37: persistent admission/reservations и прямой team start, без обещания hard monetary quota |
| F02: локальный поиск и overhead | BM25 без дополнительной модели; default false, full native lists | Ограничить повторные корректировки поиска; P38 измеряет lookup/load/no-match/повторы |
| F03: provenance и bounded retrieval | P27–P31 запланированы | Дополнить их критерии scope/revision/source, текущими фактами и bounded excerpts; P34 не копирует всю историю в bootstrap |
| F05: измерение на принятом результате | Размер listing и около 15 prompts — диагностический smoke | P38/P32: paired task/team benchmark, качество и cold/warm cache отдельно |

## Контракт сокращения контекста

Постоянная координационная политика стабильна и имеет собственный byte budget. Session identity и меняющиеся task/summary/decisions/memory отделены от неё; agent claims получают source/scope/revision и не становятся человеческими constraints. Native delivery/permissions и порядок слоя P09/P12 сохраняются. Новый формат bootstrap версионируется; resume/amendment не использует устаревшую ревизию как текущую.

Большое поручение не обрезается молча. Превышение лимита даёт диагностируемый отказ или content reference с hash/размером и явным признаком неполного excerpt. Сводка get_map содержит состояние, active revision и ссылки; тексты писем и архивы читаются страницами. Страницы имеют byte cap, cursor и completeness; query/body не отправляются снова всем участникам. Внутренняя JSON map остаётся первой ступенью storage: перенос журнала — только по измеренному узкому месту. Увеличение 8 MiB transport cap не заменяет bounded snapshots/resync.

Пределы страниц и admission — измеряемые настройки, не доказанные оптимальные числа. Человеческие правила/поручения и безопасные control actions не теряются ради меньшего payload. Бюджет 14 строк сохраняется как layout invariant рядом с проверкой bytes.

## Контракт измерений

Для живой сессии используется наиболее свежий валидный index того же vendor binding/launch epoch; закрытый период и fallback явно помечены. Поля input/output/cacheRead/cacheWrite проходят до UI с source/observedAt/completeness. Отсутствующее native поле остаётся unknown; Codex cacheWrite не считается наблюдаемым нулём из-за внутренней нормализации. Cumulative/delta/reset semantics описываются по адаптеру. Request/message identity или надёжный offset предотвращают двойной счёт partial records, одного thread в разных views и native descendants. Неполный итог команды обозначается.

Cache управляется native CLI; Parley сохраняет стабильность собственных вставок и измеряет результат. Точное совпадение prefix важно, но сохранение нашей части не доказывает hit: это следует из [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching) и [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). Токены, bytes, подписочный лимит и деньги показываются отдельными величинами; без vendor evidence не вычисляется стоимость подписки или процент экономии.

## Benchmark и итоговый gate

Единица сравнения — принятый результат всей задачи/команды, включая main/native subagents, retries и human corrections. Baseline — stock native skills внутри того же Parley; navigator отличается только своим режимом. Provider/model/effort, CLI/plugin/skill hashes, task/team/permissions и project state фиксированы. jev — отдельная ось. Cold/warm/TTL/compaction сценарии разделены; snapshot текущих условий сохраняется.

Фиксируются input/output/cache counters, tool-result bytes, lookup/no-match/reformulation/load/body bytes/дубли, messages/fanout, launches/resumes/retries, compactions, bootstrap bytes, время и качество. Набор покрывает no-skill, obvious/ambiguous/multilingual/multiple, mixed providers, DM/broadcast, amendment, stop/resume, disabled/unavailable, long skill и compaction. Paired differences, median/tails и completeness — часть отчёта. Около 15 prompts достаточно для smoke, процент экономии заранее не обещается.

P38 сначала даёт offline harness, fixtures и reviewable сценарии/бюджет. Платный native model A/B и человеческая разметка — отдельный явный шаг P32 после готовности артефактов; аудит сам не проводил эти прогоны. До доказанного результата navigator остаётся opt-in/default false, suppression OFF; experimental listing/jev выключение не становятся опорой корректности. Все непроверенные live/platform gates остаются отмеченными.

## Внутренний навык

[minimal-development](../../.agents/skills/minimal-development/SKILL.md) уже применяется в coding workflow и будет доставляться runtime через P39. Его критерий — наименьшее полное решение и проверенный результат. Body-on-demand, без постоянных hooks и дополнительных вызовов модели. В P38 сравнивать off/on навыка отдельной осью при одинаковом navigator/cache режиме; внешние проценты или короткий diff не подтверждают нашу экономию.
