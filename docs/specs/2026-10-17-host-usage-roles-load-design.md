# Дешёвые `rooms.usage` и `roles.list` — дизайн

Дата: 2026-10-17. Статус: черновик на утверждение. Продолжение `2026-10-16-host-diagnostics-and-load-design.md` (раздел «Baseline 2026-10-17»): по профилю хоста 0.15.0 два метода съедают главный поток, терминалы ни при чём.

## Зачем

При открытой комнате с семью живыми агентами хост держит 60–97 % CPU и лаг цикла событий до 1,3 с; без комнаты — 4–10 % при тех же 17 PTY. Причины две, обе — повторная тяжёлая работа на каждый запрос окна:

1. **`rooms.usage`.** Чип расхода токенов в шапке комнаты переспрашивает хост при любом изменении токенов участника, не чаще раза в 10 с. Хост считает срез участника по окнам участия из его лога, кэшируя результат по (окна, размер и mtime файлов). У работающего агента лог растёт постоянно, кэш не попадает, и `usageIn` перечитывает лог целиком через readline (`indexSessionFile` / `indexCodexSession`), плюс логи подагентов и порождённых тредов. Логи участников Room 1 — 21–120 МБ, ≈370 МБ суммарно; по профилю половина занятого времени хоста — это чтение JSONL. Старая спека расхода (6.2) этот путь предвидела: «если дорого — дочитывание хвоста с сохранённым состоянием учёта».
2. **`roles.list`.** На каждый вызов хост читает карту работы с диска (`readMap`, 1,1–1,5 МБ JSON), сканирует роли Claude по каталогам и запускает процесс `codex app-server --stdio`, чтобы прочитать его контекст (`readCodexRoleContext`, таймаут 8 с). Окно зовёт метод из каждого чипа роли: строка сайдбара, полоска участников, тулбар Chat, панель плана, панель проекта — по одному вызову на чип, 306 вызовов за 42 минуты, по 12 одинаковых в одну секунду при перерисовке сайдбара.

## Цели

1. При открытой Room 1 с семью живыми участниками `host: состояние` показывает cpuPct < 20, а `rooms.usage` после прогрева отвечает < 500 мс.
2. `roles.list` не читает карту с диска и запускает codex не чаще раза в минуту на рабочий каталог; на перерисовку сайдбара с 12 сессиями — не больше одного RPC на рабочий каталог.
3. Цифры расхода не меняются: срез по окнам даёт тот же `UsageSummary`, что и полный перечит (тест эквивалентности на фикстурах).
4. Старое окно с новым хостом и новое окно со старым хостом работают как раньше: протокол не меняется.

## Не-цели

- Переписывать подсчёт токенов (`createUsageLedger`, окна, потомки) — только способ доставки наблюдений в него.
- Хранить шкалу расхода на диске между запусками хоста: только в памяти, после рестарта первый запрос читает лог целиком один раз.
- Следить за файлами ролей и сбрасывать кэш по событию: хватает TTL.
- `handleLogChange`, который пересчитывает активность всех сессий всех работ на любое изменение лога (`recompute` 0,5 с в профиле), и вес карты работы — отдельные правки.

## Анти-цели

- Чип показывает устаревшие цифры без пометки: у поповера остаётся «Updated HH:MM», появляется кнопка обновления.
- Срез из шкалы расходится с полным перечитом хоть в одном поле (`input`, `output`, `cacheRead`, `cacheWrite`, `completeness`, `stale`, `observedAt`).
- Усечённый или подменённый лог (другой файл под тем же именем) даёт сумму старой шкалы и нового хвоста.

## Ограничения

- Хост — один поток, как и раньше; дочитывание хвоста идёт потоком кусками, без чтения файла целиком в память.
- Память шкал ограничена: не больше 256 файлов в кэше (LRU), у 120-МБ лога шкала — тысячи наблюдений, сотни килобайт.
- Текущие константы: `ROOM_USAGE_MIN_INTERVAL_MS` 10 000 → 60 000; новые `ROLE_CATALOG_TTL_MS = 60_000`, `SUBAGENT_DISCOVERY_TTL_MS = 30_000`, `USAGE_TIMELINE_CACHE_SIZE = 256`.
- Тексты окна по-английски в `strings.ts`; комментарии, тесты, документы по-русски; без мутационных прогонов.

## 1. Шкала расхода (core + host)

### 1.1 Наблюдения

Сейчас `indexSessionFile` (Claude) и `indexCodexSession` (Codex) по ходу чтения зовут `ledger.observe(...)`: Claude — `{ kind: 'delta', id, counters, at }` для записей `role === 'assistant'` с `usage` (подагенты — с `child: true`), Codex — `{ kind: 'cumulative', stream: 'rollout', counters, at }` по `event_msg` / `token_count` и сбросы. Правило «запись → наблюдение» выносится в чистые функции ядра:

```ts
// core/src/work/usage-observations.ts
export type UsageObservation = Parameters<UsageLedger['observe']>[0];
export function claudeUsageObservation(record: SessionRecord, file: string, lineNo: number): UsageObservation | null;
export function codexUsageObservation(raw: RawRecord): UsageObservation | null;
```

Оба индексатора переходят на эти функции (поведение не меняется — тесты индекса остаются зелёными).

### 1.2 Шкала файла

```ts
// core/src/work/usage-timeline.ts
export interface UsageTimeline {
  file: string;
  family: 'claude' | 'codex';
  /** Байт лога, разобранных целиком (до последнего `\n`); хвост без перевода строки не считается. */
  offset: number;
  /** Размер и ino файла при последнем чтении: усечение или подмена → шкала строится заново. */
  size: number; ino: number;
  observations: UsageObservation[];
  lineNo: number;
}
export async function extendUsageTimeline(timeline: UsageTimeline | null, file: string, family): Promise<UsageTimeline>;
export function sliceUsageTimeline(timelines: readonly UsageTimeline[], windows: readonly UsageWindow[]): UsageSummary | undefined;
```

`extendUsageTimeline`: `stat(file)`; если шкалы нет, `ino` другой или `size < offset` — читать с нуля; иначе читать `createReadStream(file, { start: offset })` кусками, резать по `\n`, последний неполный кусок не разбирать (он войдёт в следующий вызов), каждую полную строку `JSON.parse` → наблюдение через функции 1.1, `offset` сдвигать на конец последней полной строки. Битая строка пропускается, как в `forEachJsonlRecord`. Файла нет — шкала пустая с `size: 0`.

`sliceUsageTimeline`: новый `createUsageLedger({ windows })`, в который по порядку проигрываются наблюдения главного лога, затем потомков (с `child: true`, как сейчас), итог — `ledger.summary()` с теми же `coverage` и `attribution`, что даёт `withDescendants`. Эквивалентность полному перечиту — тест на фикстурах обоих провайдеров с окнами, потомками и сбросом Codex.

### 1.3 `LogIndex.usageIn`

Вместо `signature` + `slices`: кэш шкал `Map<file, UsageTimeline>` (LRU 256). На запрос: главный файл и файлы потомков (у Claude — `discoverSession`, результат кэшируется по главному файлу на `SUBAGENT_DISCOVERY_TTL_MS`; у Codex — `descendantIndexes` из памяти) → для каждого `extendUsageTimeline` → `sliceUsageTimeline`. Кэш срезов `slices` остаётся как есть (попадания при неизменных файлах по-прежнему бесплатны), но промах теперь стоит чтения хвоста, а не файла.

`reindex`, `start`, наблюдатель `watchSessions` и `handleLogChange` не меняются.

### 1.4 Чип и запрос

`RoomUsageChip`: интервал `ROOM_USAGE_MIN_INTERVAL_MS = 60_000`; из зависимостей эффекта уходит `signal` (токены участников) — поводы спросить: активация, смена `composition`, таймер раз в 60 с пока `active`. В поповере — кнопка **Refresh** (`S.roomUsage.refresh`), которая спрашивает сразу (не чаще раза в 5 с). «Updated HH:MM» остаётся. Старая спека расхода, раздел 6.3, считается заменённой этим пунктом.

## 2. `roles.list` (host + окно)

### 2.1 Хост

`createRolesList(deps)` получает `works: Pick<WorksService, 'entry'>` и берёт сессию из `works.entry(projectPath, workId)?.map` (снимок в памяти хоста), а не из `readMap` с диска; работы нет в снимке — прежний `not_found`. Рабочий каталог — `session.worktree?.path ?? projectPath`, как сейчас.

Кэш каталога: `Map<cwd, { at: number; value: Promise<RoleList> }>` с `ROLE_CATALOG_TTL_MS = 60_000`; одновременные вызовы одного `cwd` делят один промис; промис, отклонённый ошибкой, из кэша убирается. Спавн codex внутри `sessionRoleCatalog` тем самым идёт не чаще раза в минуту на каталог. Протокол `roles.list` не меняется.

### 2.2 Окно

Новый стор `renderer/store/roles.ts` по образцу `chat/capabilities-store.ts`: `byCwd: Record<cwd, { status; roles: RoleSummary[]; at }>`, `load(bridge, { projectPath, ref, cwd })` с TTL 60 с и дедупом в полёте; `cwd` = `session.worktree?.path ?? projectPath`. `useRoleSummary(bridge, sessionRef, role, revision, cwd?)` читает роль из стора по `cwd`; смена `revision` (pid, старт процесса, lifecycle, worktree) делает `load` с `force: true` — один RPC на каталог, не на чип. Вызовы `RoleChip` в `SessionRow`, `ChatToolbar`, `ParticipantStrip` (через `feed-model`), `PlanPanel` передают `cwd` из сессии; `ProjectPanel` (автор бэклога без worktree) и диалог новой сессии остаются на `projectPath`.

## 3. Тесты

- core: `usage-observations` — те же наблюдения, что раньше давали индексаторы (снимок на фикстурах); `usage-timeline` — дочитывание хвоста (второй вызов читает только новые байты: подменённый `createReadStream` фиксирует `start`), неполная последняя строка, усечение и подмена файла (`ino`), эквивалентность полному перечиту по окнам с потомками и сбросом Codex.
- host `log-index.test.ts`: существующий «повторный срез без новых записей берётся из кэша, дописанный лог — пересчитывается» дополняется проверкой, что дописанный лог читается с прежнего `offset`; `room-usage.test.ts` без изменений.
- host `methods/roles.test.ts`: карта берётся из `works.entry`, не с диска; 12 одновременных вызовов одного `cwd` — один вызов каталога; по истечении TTL — новый; ошибка каталога не кэшируется.
- окно: `RoomUsageChip.test.tsx` — интервал 60 с, рост токенов сам по себе запрос не рождает, Refresh спрашивает сразу; `role-summary.test.tsx` — 12 чипов одного `cwd` → один `roles.list`, смена revision → ещё один; `roles-store.test.ts` — TTL и дедуп.
- Приёмка на машине автора: архив Diagnostics при открытой Room 1 с семью живыми агентами: `host: состояние` cpuPct < 20, `rooms.usage` в кольце окна < 500 мс, `roles.list` ≤ 1 на каталог в минуту.

## 4. Порядок

Ветка `feat/host-usage-roles-load` от origin/master. Сначала часть 1 (ядро → хост → чип), затем часть 2 (хост → окно); между частями — архив «после» на машине автора. B1 (`feat/host-scrollback-1000`, `feat/pty-batch-cap`) сливаются независимо.

## Мои выборы, не обсуждавшиеся явно

- Шкала только в памяти, LRU 256 файлов; первый запрос после рестарта хоста читает лог целиком.
- Подмена и усечение файла определяются по `ino` и `size < offset`, без контрольных сумм.
- Чип: таймер 60 с вместо реакции на токены; Refresh в поповере с порогом 5 с.
- Кэш каталога ролей — по `cwd` на 60 с, без наблюдения за файлами ролей; тот же TTL в окне.
- `roles.list` берёт сессию из снимка работ хоста; протокол не меняется.
