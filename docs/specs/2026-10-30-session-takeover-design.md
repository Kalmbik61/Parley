# Продолжение сессии на другом провайдере — дизайн

Дата: 2026-10-30. Автор: s-99 (Opus, senior-архитектор). Статус: принята; решения человека — раздел 9, итог спайка
T0 — 5.4.1, правки — журнал (раздел 10). Реализация — ветка `feat/session-takeover`, комната r-15 (лид s-131).
Связано: `2026-10-21-subscriptions-design.md` (решения 5 и 6, раздел 4.4), `2026-10-12-stuck-sessions-design.md`,
`2026-10-17-custom-providers-design.md`. Код смотрел на `f7978af8` (ветка `feat/raise-default-limits`).

## 1. Итог

**Рекомендация — вариант B, «замена агента на месте»:** id, окно и все привязки остаются, меняется только провайдер
процесса. Контекст по умолчанию переносится **пакетом передачи** (бриф из карты, состояние, обязательства, рабочая
копия, хвост транскрипта файлом); работает при любой паре провайдеров. **Продолжение самого транскрипта** внутри
семейства (Claude → другой аккаунт Claude) — дополнительный режим, только после спайка T0. Вариант A как общий
механизм передачи **не делать**: точечная передача владения и лидерства уже есть у человека (3.1), и её хватает.

Почему: по коду к id сессии привязано почти всё (родитель, комнаты, владение, лидерство, пункты планов, письма,
ожидания, worktree), а к провайдеру — пять полей и токены запуска, которые и так выдаются заново на каждый запуск
(раздел 2). В B меняются эти пять полей. В A пришлось бы переписывать id во всех связях, адресах писем и чужих
транскриптах, и всё равно осталась бы старая сессия-«зомби», которую будит почта (раздел 4).

## 2. Что к чему привязано

| Что | Где | Привязано к | При B |
|---|---|---|---|
| Родитель / дети | `WorkSession.parent` — `core/src/work/types.ts:117`; права `close_session` — `isDescendant`, `rooms.ts:554` | id | без изменений |
| Владение комнатой | `Room.ownerId` — `types.ts:420` | id | без изменений |
| Состав и ведущий | `Room.members`, `Room.lead` — `types.ts:422,430`; `liveLead` — `rooms.ts:123` | id | без изменений |
| Решение в слоте | `Proposal.from`; ответ уходит `liveLead` | id | без изменений |
| Пункты планов, доставка | `PlanItemInput.owner` — `types.ts:205`, `PlanEffect.target` — `types.ts:367` | id | без изменений |
| Попытки autonomous | `PlanAttempt.worker/verifier` — `types.ts:264-265` | id + движок | **запрет**, см. 6.7 |
| Личный план | `WorkSession.agentPlan` — `types.ts:104` | id | без изменений, входит в пакет |
| Почта | таблицы писем, `Message.to/readBy` — `types.ts:485` | id | без изменений, непрочитанное ждёт нового агента |
| `wait_for` у других | `finishedState` — `core/src/mcp/tools.ts:115-121` | id + `lifecycle/stuck` | гонка, см. 6.2 |
| Worktree | `WorkSession.worktree` — `types.ts:157`; cwd — `launch.ts:238` | id (ветка `parley/<w>/<s>`) | без изменений, грязное состояние сохраняется |
| Бриф, слой | `buildBrief` — `brief.ts:76` (owned rooms `:142`), `buildSessionLayer` — `session-layer.ts:93` | id, пересобираются из карты на каждый запуск | сами покажут комнаты, роли и детей |
| Идентичность MCP | `PARLEY_SESSION_ID` → `mcp/context.ts:143` | id, env процесса | та же; **записи в карту не огорожены** (6.1) |
| Токен канала агента | `feed.agent.register(ref)` — `sessions-service.ts:749`; замена прежнего — `browser-endpoint.ts:199-206` | ref, на каждый запуск | выдаётся заново, старый гаснет |
| Токен хуков | `hooks.register(ref, providerSessionId, provider)` — `sessions-service.ts:854`, `hook-server.ts:312-324` | ref, на каждый запуск | выдаётся заново, старый гаснет |
| Провайдер | `WorkSession.provider` — `types.ts:105`; `entryOf` — `launch.ts:140` | провайдер | **меняется** |
| Разговор у провайдера | `providerSessionId` — `types.ts:138`, `codexThreadBinding` — `:139` | провайдер + его папка | **сбрасываются** (или копия транскрипта, 5.4) |
| Модель, effort | `model/effort` — `types.ts:167-168` | провайдер | **выбираются заново** |
| Роль | `role` — `types.ts:151` | `builtin` — любой; `claude`/`codex` — своё CLI | `builtin` остаётся; нативная чужого CLI → диагностика `role-missing` (`launch.ts`, `prepareSessionRole`) |
| Процесс | `pid`, `startedAtProcess` — `types.ts:133-134` | процесс | новый |
| Застревание | `stuck` — `types.ts:179`; эпизод лимита в будильнике — `wake-service.ts:757-770` | процесс | снимается, см. 6.4 |
| Расход токенов | ключ `family+nativeId+epoch` — `usage-ledger.ts:502` | разговор у провайдера | старый снимок → в историю агентов (5.1) |

## 3. Что уже есть

1. **Смена владельца и ведущего (это и есть «The human may change ownership», `guide.ts:259-260`).** Меню комнаты в
   сайдбаре «Change owner / Assign owner» (`desktop/src/renderer/sidebar/RoomRowMenu.tsx:135-150`) →
   `rooms.setOwner` (`protocol/src/methods.ts:233`) → `setHumanRoomOwner` (`host/src/rooms/rooms-service.ts:297`) →
   `setRoomOwner` (`core/src/work/rooms.ts:565`). Ни строки в ленте, ни письма новому владельцу нет: узнает при
   следующем запуске из брифа. «Make lead» — `rooms.setLead` → `setHumanRoomLead` (`rooms-service.ts:317`) →
   `setRoomLead` (`rooms.ts:340`), с письмами обоим. Агенту ни то ни другое недоступно.
2. **Перезапуск с другими флагами** — `setModel` (`host/src/sessions/sessions-service.ts:1201-1250`): замок
   `exclusive`, отказ при `launching`, проверки «у приглашения / нет фоновых задач / нет черновика», запись в
   карту, `stop` → `launch(ref, 'resume')`. Готовый образец для B. Смены **провайдера** у существующей сессии нет
   нигде; `setModel` прямо отказывает не-Claude (`:1212-1215`).
3. **Как Parley узнаёт про лимит.** Claude: хук `StopFailure` с `error: rate_limit` (запасной путь — запись журнала),
   `classifyClaudeFailure` (`core/src/work/stuck.ts:65`), свёртка — `core/src/work/activity.ts:350-376`. Codex:
   `usage_limit_exceeded` → `codexFailureError` (`stuck.ts:87`). Дальше `stuck-service` сразу пишет
   `session.stuck = {kind:'limit', resetsAt, window}` (`host/src/stuck/stuck-service.ts:222-231`), строку в ленту,
   письмо ведущему `limitLetter` с перечнем свободных аккаунтов того же CLI (`stuck.ts:620`), а `wait_for` отдаёт
   `{state:'stuck', hint}` (`mcp/tools.ts:884`). Будильник возвращает сессию после сброса
   (`wake-service.ts:757-830`). Плюс проценты 5h/week у провайдеров (`get_map {field:"providers"}.limits`).
   Значит, **предложить замену в момент лимита можно**: событие, время сброса и кандидаты уже есть.
4. **Транскрипт в текст** — `readTranscript(provider, providerSessionId)` (`core/src/work/summary.ts:120`): реплики
   человека и агента без инструментов, хвост 40 000 знаков; Claude-семейство и Codex. Корень по id провайдера —
   `claudeRootFor` (`core/src/discover.ts:76`) — работает и для удалённого аккаунта, пока цела папка.
   Дозаказ резюме через `claude -p` (`summary.ts:224`) есть, но для передачи не годится: глобальный Claude может
   сам быть в лимите.
5. **Карточки согласия** — `ConsentCard` (`protocol/src/consents.ts:19-28`), сейчас только `folder-trust`; решаются
   в окне, на острове и в Telegram. Удобный канал для «агент просит — человек разрешает».
6. **Удалённый провайдер (custom-claude-2).** Проверено: в `~/.parley/custom-providers.json` осталась только
   `custom-deepseek`, а папка `~/.parley/providers/custom-claude-2/` с транскриптами цела — аккаунт удалён без
   `removeFolder` (`host/src/methods/custom-providers.ts:142-171`: выход из аккаунта, запись убрана, папка
   оставлена). Реестр собирается из файла (`core/src/providers.ts:1182-1196`), поэтому провайдера нет в каталоге,
   и любой запуск или resume его сессий падает: `unknown provider` (`launch.ts:140-147`,
   `sessions-service.ts:559-561`) или `the provider was deleted` (`:811-812`). В w-0054 таких сессий 8 в
   `sleeping` и 9 закрытых: письмо любой из спящих поднимет будильник, и запуск упадёт. Окно об этом молчит:
   пометки «провайдер удалён» нет нигде.

## 4. A против B

| | A. Передача другой сессии | B. Замена агента на месте |
|---|---|---|
| Что меняется в карте | `parent` всех детей, `ownerId`, `members`/`lead`/`memberLog`, `owner` пунктов, `target` ждущих `PlanEffect`, `recipeLeadNotified`, `agentPlan`, право `close_session` | 5 полей сессии + история агентов |
| Почта | письма на старый id: переадресация переписывает историю (это запрещено: «переписку задним числом не переписывают», `map.ts` у `removeSession`) или нужен указатель «преемник» во всех путях доставки | ничего: непрочитанное ждёт тот же id |
| Чужие ссылки | коллеги помнят `@s11` в своих транскриптах и брифах и дальше пишут старой → будильник её поднимает → провайдер в лимите или удалён | ничего |
| Worktree | ветка `parley/<w>/s-11` принадлежит старой записи; перенос записи worktree — отдельная хрупкая операция | тот же каталог и ветка, грязное состояние на месте |
| `wait_for` у ждущих | ждут старый id вечно, нужен особый ответ «перешла к s-NN» | одно окно гонки на время остановки (6.2) |
| Контекст | новая сессия читает карту — тот же пакет передачи, что в B | пакет передачи или транскрипт |
| Объём | ~15 мест в core/host + переадресация почты | 1 оркестратор в host + 1 модуль в core + UI |
| Остаток | старая сессия-«зомби» с id и почтой | нет |

Вывод: A дороже и хрупче и всё равно требует того же переноса контекста. Остаётся сценарий «другая **уже
существующая** сессия должна вести эту комнату»; его закрывают существующие «Make lead» и «Change owner». Добавить
стоит одно: строку в ленте и письмо при смене владельца (T7).

## 5. Дизайн B

### 5.1 Модель данных (core, `types.ts`)

```ts
/** Прежний агент сессии: что был за провайдер и разговор, почему сменён (спека 2026-10-30, 5.1). */
export interface AgentBinding {
  provider: string;
  model: string | null;
  effort: string | null;
  providerSessionId: string | null;
  startedAt: string | null;         // первый старт этого агента
  endedAt: string;                  // момент замены
  reason: 'limit' | 'sign-in' | 'provider-missing' | 'manual' | 'model';  // 'model' — смена модели (5.9)
  requestedBy: string;              // 'human' или id сессии, чей запрос одобрен
  carried: 'handover' | 'transcript';
  usage?: FrozenUsage;              // расход этого отрезка (5.9), без расхода прежних отрезков
  costUsd?: number | null;          // стоимость отрезка по логу провайдера (5.9); null — лог её не сообщает
}

interface WorkSession {
  // …
  /** Прежние агенты (закрытые отрезки расхода, 5.9), новые в конце, не больше 20. Нет поля — сессию не переводили. */
  previousAgents?: AgentBinding[];
  /** Идёт замена агента: `wait_for` не считает сессию уснувшей, будильник её не поднимает. Снимает оркестратор. */
  switching?: { id: string; to: string; since: string } | null;
  /** Ревизия текущего запуска (= `NATIVE_CONTEXT_REVISION`): ограда записей MCP от прежнего процесса (6.1). */
  agentRevision?: string | null;
}
```

`parseMap` подставляет `undefined` / `null`, миграции нет. Чистая функция `applyAgentSwitch(map, sessionId,
target, binding)` в новом `core/src/work/agent-switch.ts`: дописывает `previousAgents`, ставит `provider`,
`model/effort` (через `resolveModelChoice`), обнуляет `providerSessionId`, `codexThreadBinding`, `stuck`, `pid`.
`parent`, комнаты, планы, `worktree` и `agentPlan` не трогает. Там же — проверка `switchBlockers(map, sessionId,
target)`.

### 5.2 Протокол

```ts
// protocol/src/methods.ts
'sessions.switchOptions': z.object({ ref: sessionRef }),
'sessions.switchAgent': z.object({
  ref: sessionRef, requestId: z.string().uuid(),
  provider: z.string().min(1),
  model: z.string().max(200).nullable().optional(),
  effort: z.string().regex(EFFORT_TOKEN_RE).nullable().optional(),
  carry: z.enum(['handover', 'transcript']).default('handover'),
  force: z.boolean().optional(),     // остановить агента, который не у приглашения
}),
// результаты
'sessions.switchOptions': {
  current: { provider: string; available: boolean; reason: 'limit' | 'sign-in' | 'provider-missing' | null };
  targets: Array<{ id: string; label: string; family: string | null; available: boolean;
                   needs: string | null; limits: ProviderLimits | null; transcript: boolean }>;
  suggested: string | null;          // 6.10
  keeps: { rooms: number; leads: string[]; owns: string[]; children: number; unread: number; worktree: string | null };
  blockers: string[];                // пусто — можно
};
'sessions.switchAgent': { outcome: 'started' | 'held'; carried: 'handover' | 'transcript' };
```

Этап 2: `ConsentCard.kind` += `'agent-switch'` с полями `{ ref, provider, model, reason, requestedBy }`;
`consents.decide` → `allow` вызывает тот же `switchAgent` от имени человека.

### 5.3 Последовательность `switchAgent` (host, рядом с `setModel`)

Всё под `exclusive(ref)` **и** ключом `launching` на весь срок (6.3):

1. Прочитать карту; `switchBlockers` (6.7–6.9). Проверить готовность **цели** `readyProvider(target)`
   (`sessions-service.ts:559`) — **до** любых изменений: отказ не трогает старого агента.
2. Живой процесс: если не у приглашения, идут фоновые задачи или в поле ввода черновик — `busy`, без `force`
   (те же проверки, что в `setModel`). Сессия с `stuck.kind === 'limit' | 'sign-in'` проходит без `force`.
3. Записать `switching = {id: requestId, to, since}`. Повтор с тем же `requestId` — тот же ответ.
4. Собрать пакет передачи (5.4), пока старый транскрипт и рабочая копия на месте.
5. `stop(ref)` и дождаться записи выхода (`finalizing`); проверить, что `pid` мёртв. Процесс не наш (`pid === null`,
   `launchedBy: 'cli'`) — только с `force` и предупреждением в UI.
6. `updateMap`: `applyAgentSwitch`, снимок расхода старого разговора в `AgentBinding.usage`, строка в ленту каждой
   комнаты сессии (6.5).
7. `launch(ref, carry === 'transcript' ? 'resume' : 'launch', {by, handover})`. `held` (согласие на папку Codex) —
   вернуть `held`, `switching` остаётся до решения.
8. После старта — `switching = null`, письма тем, кто ждал (6.5).
9. Отказ на шаге 7: карта уже с новым провайдером, сессия `sleeping`, `switching = null`, уведомление
   `launch-failed` с кнопками Retry и «Back to <прежний>» (обратная замена — тот же метод).

### 5.4 Перенос контекста

**Пакет передачи** (`buildHandover` в `core/src/work/agent-switch.ts`). Уходит первым сообщением режима `launch`
**вместе с брифом** — сейчас `launch` передаёт `options.prompt` только в `resume` (`launch.ts:558`), это правится
(T3). Бриф собирается как обычно (`buildBrief`) и уже содержит задачу, цель, комнаты, владение, роли, коллег,
`contextFrom` и решения. Пакет добавляет то, чего в брифе нет. Встроенная часть — не больше 12 КБ, потому что
промпт идёт в argv (`validateSpawnBudget`, `sessions-service.ts:867`):

1. **Заголовок** (≤ 1 КБ): «You continue session s-11 after its previous agent (Claude Code 2, opus) stopped at
   16:41: usage limit until 19:27. Same id, rooms, children, worktree and mail. The map and the files on disk are
   the truth; your predecessor's last words may be stale. Check before redoing anything.»
2. **Состояние** (≤ 3 КБ): `summary` с источником, `result`, шаги `agentPlan` со статусами.
3. **Обязательства** (≤ 3 КБ, списки до 10 строк с указателем на `get_map`): дети — id, ярлык, `lifecycle/result/stuck`;
   комнаты, где сессия ведущий, со ждущим `proposal`; её пункты планов в `in_progress/returned/blocked`;
   непрочитанное по комнатам и неотвеченные `question` к ней (id, от кого, первые 200 знаков).
4. **Рабочая копия** (≤ 1.5 КБ): cwd, ветка, `git status --short` (до 30 строк), ahead/behind от `worktree.base`.
5. **Хвост разговора**: `readTranscript` (40 000 знаков) — в файл
   `.parley/works/<w>/handover/<s>-<n>.md`; встроены последние ~4 КБ и путь к файлу. Файл читается любым
   провайдером, в том числе Codex из worktree.

Если транскрипта нет (папка удалена, лог пуст), пакет собирается без пункта 5, с пометкой об этом.

**Продолжение транскрипта** (`carry: 'transcript'`). Только Anthropic-аккаунт → Anthropic-аккаунт (`claude` ↔
`custom-claude-*`, где `kind: 'claude-account'`) и только после **T0**. Свои провайдеры с адресом (GLM, DeepSeek) —
нет: подписи thinking-блоков и серверные ссылки в журнале (в транскриптах есть записи `api-request-blob`,
`requestRef`) чужим API не примутся. Codex-аккаунтов пока нет (`custom-providers.ts`, «stage 3»). Механика,
которую проверяет T0:

- скопировать `<старый корень>/<slug>/<uuid>.jsonl` и каталог `<uuid>/` в `<configDir цели>/projects/<slug>/`
  (`slug` — тот же, cwd не меняется);
- запустить `--resume <uuid>`, а лучше `--resume <uuid> --fork-session` (новый id, копия не дублирует старый файл в
  индексе логов);
- проверка «разговор есть» должна смотреть **корень цели**: `claudeConversationExists` (`launch.ts:189-208`) ищет
  во всех корнях сразу и для замены скажет «есть», хотя в папке цели файла нет → `No conversation found`;
- ограничение: окно контекста цели не меньше занятого (иначе — только пакет);
- **решение 5 спеки подписок («Истории не переносить», `2026-10-21-subscriptions-design.md:72`) этим
  пересматривается** — человек согласен (раздел 9, ответ 1), T0 — «да» (5.4.1).

#### 5.4.1 Итог спайка T0 (2026-10-30, s-131)

**Вывод: да, `carry: 'transcript'` между аккаунтами Claude работает. Вариант — копия + `--resume <uuid>
--fork-session`.**

Стенд: Claude Code 2.1.314. Источник — транскрипт s-42 из папки удалённого аккаунта `custom-claude-2` (другая
подписка, сейчас `loggedIn: false`): 1.6 МБ, `claude-opus-5-5`, ~138K токенов контекста, 42 thinking-блока с
подписью, записи `api-request-blob`/`requestRef`. Цель — глобальный аккаунт (`~/.claude`). Cwd — тот же worktree
s-42, слаг тот же. Запуск `claude -p --safe-mode --strict-mcp-config --tools ""` (без инструментов и MCP, чтобы
поднятый агент ничего не сделал от имени s-42).

| Вариант | Итог |
|---|---|
| V1: копия `<uuid>.jsonl` и `<uuid>/` в `~/.claude/projects/<slug>/` + `--resume <uuid> --fork-session` | `success`: агент назвал свою последнюю задачу и «мой id в Parley — s-42». API принял чужие подписанные thinking-блоки. Новый файл `<новый id>.jsonl` (423 записи, у всех `sessionId` = новый id), копия не тронута (sha тот же), `history.jsonl` не тронут |
| V2: та же копия + `--resume <uuid>` без форка | `success`, тот же id; ответ дописан в копию |

Ошибок не было ни в одном варианте. Что важно для T11:

1. **Форк, а не продолжение копии.** Без форка один `providerSessionId` живёт в двух корнях: `claudeRootFor` и
   `readTranscript` по id могут взять устаревший файл источника, а снимок расхода — спутать разговоры. С форком у
   нового агента свой id; копию в папке цели после появления файла форка удаляем (иначе `/resume` цели покажет два
   одинаковых разговора). Источник в папке старого аккаунта не трогаем никогда.
2. **Расход.** Форк несёт копии прежних `assistant`-записей с их `usage` и запись `cost-state` с итогами старого
   разговора (`modelUsage` ответа включал $3.28 прошлого расхода). Учёт расхода по новому id не должен считать их
   второй раз: старое уже заморожено в `AgentBinding.usage`, у нового — только записи после момента замены.
3. **Цена первого хода.** Кэш промптов у нового аккаунта пуст: первый ход заново записывает весь контекст в кэш
   (здесь ~90K токенов `cache_creation`). Окно подсказывает это в диалоге рядом с вариантом «Continue the
   conversation».
4. **Не переносится:** `file-history/<id>` (точки отката `/rewind` старых ходов) и записи служебных типов
   (`api-request`, `mode` и т. п. — Claude Code их не копирует в форк). На продолжение не влияет.
5. **Проверено в `-p`.** Интерактивный запуск под pty читает тот же формат; T11 подтверждает это тестом хоста на
   фейковом CLI и одним ручным прогоном.
6. Следы спайка (каталог слага в `~/.claude/projects/`) удалены.

### 5.5 Права

- **Человек из окна — всегда**: меню строки сессии, баннер в чате, уведомление о лимите.
- **Агент — только через согласие** (этап 2): новый инструмент MCP `request_agent_switch(session, provider, model?,
  reason)` создаёт карточку `agent-switch`; выполняет её только `allow` человека (окно, остров, Telegram).
  Просить могут: родитель цели, живой ведущий или владелец комнаты, где цель участник, и сама цель (заранее, пока
  её лимит близок). Движку autonomous инструмент не нужен.
- Без вопроса — никогда (анти-цель спеки подписок, раздел 2). Настройки «ведущему можно без спроса» нет: любой
  запрос агента — карточка согласия (раздел 9, ответ 3).

### 5.6 Тексты агентам

- `limitLetter` (`stuck.ts:620`): вариант «start a replacement … create_session» заменяется на «ask @human to
  continue @s03 on <account> (Continue on another provider); its rooms, children and mail stay with it». Вариант с
  `create_session` остаётся только для «отдать часть другому участнику».
- Гид, тема `stuck` (`guide.ts`): то же правило и `request_agent_switch` (этап 2).
- Строка ведущего `stuckLine` (`stuck.ts:564`): к подсказке «make another participant the lead» добавляется
  «or continue it on another provider».

### 5.7 UX окна (тексты окна — английские)

- **Меню строки сессии** (`SessionRowMenu.tsx`, рядом с Resume/Stop): «Continue on another provider…». Есть у
  незакрытых сессий, кроме сессий движка autonomous. Подсвечен, когда сессия в `limit`/`sign-in` или провайдер удалён.
- **Баннер в чате** над полем ввода, по образцу `WaitingBanner` (`chat/WaitingBanner.tsx`, место —
  `ChatView.tsx:481`): «Out of Claude Code 2 usage until 19:27 · [Continue on another provider…]»;
  «Claude Code 2 was removed from Parley · [Continue on another provider…]».
- **Уведомление о лимите** (`attention/notify.ts:429-452`): действие «Continue on…» открывает диалог.
- **Диалог** (новый `SwitchAgentDialog`, переиспользует пилюли провайдеров и выбор модели из
  `NewSessionOrRoomDialog`):
  - цели со значком CLI, лимитами и причиной недоступности; предвыбран `suggested`;
  - модель и effort;
  - «Carry: Handover summary (any provider) / Continue the conversation (same Claude account family)» — второе
    видно, только когда `targets[].transcript`;
  - блок «Keeps: s-11 · lead of r-02 · owner of r-11 · 4 child sessions · worktree parley/w-0054/s-11 · 3 unread»;
  - живой агент не у приглашения — предупреждение и кнопка «Stop and continue» (`force`).
- **Лента чата и комнаты**: разделитель «Continued on Codex · gpt-6.1-sol · 16:41 (Claude Code 2: usage limit)».
  Старый разговор в окне — по ссылке «Previous conversation» (только чтение, по `previousAgents[].providerSessionId`);
  в первой версии допустимо без неё.
- **Сайдбар**: у сессии с удалённым провайдером — значок предупреждения и подсказка «Provider removed».

### 5.8 Удалённый провайдер

- Окно сравнивает `session.provider` с `providers.list`; нет в списке — пометка (5.7) и `current.reason =
  'provider-missing'` в `switchOptions`.
- `providers.deleteCustom` при живых или спящих сессиях аккаунта показывает их число и ссылку «Continue them on…»
  (T13). Удаление не блокирует.
- Пакет передачи берёт хвост из оставшейся папки (`claudeRootFor` работает по id). Папка удалена — без хвоста.
- **Спящие сессии удалённого провайдера ждут безопасно** (раздел 9, ответ 5; T14). Сейчас будильник при письме такой
  сессии молча ставит `resumeUnavailable` (`wake-service.ts`, `resumeSession`: у провайдера нет `resumeArgs`) и
  показывает `sleeping`, а ручной Resume падает `unknown provider`. Нужно: будильник не пытается поднимать сессию,
  у которой провайдера нет в реестре, и показывает ожидание писем `provider-missing` (новое значение `MailWait`);
  `launch` такой сессии отказывает понятным текстом «<provider> is not in Parley: continue the session on another
  provider»; окно вместо Resume предлагает «Continue on another provider…». Ни писем отправителям «did not resume»,
  ни уведомлений `resume-failed`. После замены письма доставляются обычным путём (`resumeUnavailable` снимается
  при старте процесса).

### 5.9 Расход по отрезкам (решение человека 2026-10-30)

Расход сессии делится на **отрезки** — по каждой замене агента: смена провайдера, аккаунта (`switchAgent`) или
модели (`setModel`). Отрезок: провайдер/аккаунт, модель, время начала и конца, свои токены и стоимость. Итог сессии
— сумма отрезков **без двойного счёта** прежнего расхода, который форк (5.4.1, п. 2) или продолжение того же
разговора после `setModel` несут в своём логе.

- **Хранение.** Закрытые отрезки — `previousAgents[]` (`startedAt`/`endedAt`, `usage`, `costUsd`); текущий — сама
  сессия с началом в `previousAgents.at(-1).endedAt` (нет привязок — с начала сессии). `setModel` тоже дописывает
  привязку: `reason: 'model'`, `carried: 'transcript'`, тот же `providerSessionId`. Предел 20: при переполнении два
  самых старых отрезка **сливаются** в один «earlier» (сумма), а не отбрасываются — итог не теряет расход.
- **Счёт.** Отрезок считает только записи лога внутри своего окна времени `[начало, конец)` — механизм окон
  `UsageLedgerOptions.windows` (`usage-ledger.ts`) уже есть. Скопированные в форк записи прежних ходов в окно нового
  отрезка не попадают; если их время в форке переписано, дубли снимаются по id ответа API (`message.id`), которые
  форк сохраняет. Это проверяет T11 на реальном форке.
- **Стоимость.** Только то, что сообщает лог провайдера: у Claude Code — записи `cost-state` (накопитель
  `totalCostUSD` по разговору, растёт через resume и форк; цена по прайсу, не счёт подписки; своего `timestamp` у
  записи нет — время берётся у ближайшей предыдущей записи файла; `hasUnknownModelCost: true` — стоимость `null`);
  у остальных — `null`. Своей таблицы цен Parley не заводит. Окно показывает «≈ $N (list price)» или «—».
- **Протокол.** `LiveMetrics.usageSegments?: Array<{ provider; providerLabel; model; from; to; usage; costUsd }>`
  (текущий отрезок — `to: null`); `LiveMetrics.usage` остаётся итогом сессии = сумма отрезков. Старый хост без
  поля — окно показывает одну цифру, как сейчас.
- **Окно.** Поповер значка расхода сессии (`chat/SessionUsageChip.tsx`) показывает отрезки по порядку, например
  «Claude · Opus · 14:02–16:41 — 1.2M, ≈ $3.28» / «Claude Code 2 · Opus · 16:41– — 340K», и строку итога. Расход
  комнаты суммирует отрезки всех сессий (`room-usage.ts`).
- **Chat /model** внутри CLI карта не видит (выбор не сохраняется, 5.1 `LaunchOptions.model`): такой отрезок не
  выделяется — известное ограничение.

## 6. Крайние случаи

1. **Старый агент жив.** Шаг 5 гасит процесс и ждёт выхода. Токены канала агента и хуков старого запуска гаснут
   сами: новая регистрация заменяет прежнюю (`hook-server.ts:312-324`, `browser-endpoint.ts:199-206`). Но MCP-сервер
   Parley пишет в хранилище **напрямую** (12 вызовов `updateMap`/`writeLetters` в `mcp/tools.ts`), его
   идентичность — env (`context.ts:143`). Осиротевший MCP-процесс или процесс не от хоста могут писать от имени
   s-11. Ограда: `agentRevision` в карте при старте (из `NATIVE_CONTEXT_REVISION`, `launch.ts:585`); пишущие
   инструменты сверяют её с env и отвечают «this session continues with another agent; stop» (T4, senior-only).
2. **`wait_for` у ждущих.** Между `stop` и новым стартом сессия `sleeping`, и `finishedState` (`tools.ts:115-121`)
   вернёт ждущим `sleeping`, будто сессия кончила. При `switching !== null` `finishedState` даёт `null` (T4).
3. **Будильник.** Путь resume будильника не смотрит на `exclusive`: `choiceNow` проверяется только перед печатью
   указателя (`wake-service.ts:1025`), а `resumeSession` (`:534`, вызов `:952`) идёт мимо. Если между `stop` и
   `launch` придёт письмо, будильник поднимет сессию сам — со старым или полусменённым провайдером. Поэтому
   оркестратор держит ключ `launching` весь срок (`launch()` тогда возвращает `started`, `sessions-service.ts:606`),
   а будильник пропускает сессии с `switching` (T5, senior-only).
4. **Эпизод лимита.** После выхода процесса будильник эпизод бросает (`wake-service.ts:763-768`), а `stuck-service`
   снимает `stuck` молча, только если сессия не `active` (`stuck-service.ts:248-262`). Если новый агент успеет
   стать `active` раньше, в комнату уйдёт ложное «@s11 is back (the usage limit has reset)». Оркестратор сам
   завершает эпизод вызовом `stuck.endBySwitch(ref)`: молча, со своей строкой и письмами (T5).
5. **Кому сообщить.** Строка в ленте каждой комнаты сессии; письмо `parley` тем же получателям, что у письма о
   лимите (ведущий и ждущие ответа): «@s11 continues on Codex (gpt-6.1-sol) after Claude Code 2 hit its usage
   limit. Messages that waited are being delivered.» Детям — ничего: их родитель тот же.
6. **Worktree.** Без изменений; грязные файлы — в пакете (5.4 п. 4). Codex в worktree: доступ на запись
   пересчитывается каждым запуском (`gitWriteGrants`). Codex впервые в проекте — согласие на папку, исход `held`.
7. **autonomous.** Исполнители и проверяющие движка (`session.workspace !== null`) — отказ: движок сам гасит
   застрявших и останавливает план с причиной `stuck` (`autonomous-engine.ts:1024-1040`), провайдеры движка
   зашиты (`host.ts:397`), а изоляция пускает только `codex`/`claude` со встроенными аргументами (`launch.ts:242-248`).
   Ведущий autonomous-комнаты кода не пишет — его заменять можно; ключи его предложений идут по id сессии.
8. **Незавершённые попытки** (autonomous) остаются за движком. Пункты `checklist`/`verified` за сессией не
   меняются, ждущие `PlanEffect` доставятся новому агенту.
9. **Отказы:** сессия `closed`; работа в архиве; цель недоступна (`needs`); цель = текущий провайдер без смены
   аккаунта (тогда это `setModel`); идёт сжатие (`compaction` держит `exclusive`) или запуск — `busy`.
10. **Подсказка цели (`suggested`):** вошедший аккаунт того же семейства с наибольшим запасом по `limits`
    (как `limitAlternatives`, `host/src/stuck/limit-alternatives.ts`), иначе другое семейство, иначе `null`.
    Автоматической замены нет.
11. **Роль и модель.** `builtin` переезжает как есть, нативная роль чужого CLI становится текстом с диагностикой
    `role-missing`. Модель и effort цели — из диалога, без выбора — умолчание роли.
12. **Тихая сессия** (`task === ''`): бриф остаётся в системном слое, пакет уходит первым сообщением.
13. **Двойной клик, два окна, остров и Telegram одновременно:** `requestId` и `exclusive`; второй запрос получает
    `busy` или тот же ответ.
14. **Расход.** По отрезкам — 5.9: закрытый отрезок замораживается в `AgentBinding.usage`/`costUsd` (T5), счёт по окнам,
    без двойного счёта форка, и показ в окне — T11, T15.

## 7. Тесты

- **core**: `applyAgentSwitch` не трогает `parent`, `ownerId`, `members/lead`, `owner` пунктов, `agentPlan`,
  `worktree`; сбрасывает пять полей; дописывает `previousAgents` (предел 20); `switchBlockers` по 6.7–6.9.
  `buildHandover`: бюджеты частей, отсечение хвоста с головы, без транскрипта, списки с указателями `get_map`.
  `finishedState` при `switching` → `null`. Ограда `agentRevision`: чужая ревизия → ошибка для `report`,
  `send_message`, `close_session`, `publish_agent_plan`; чтение не ограждено. `plan('launch')` с пакетом:
  бриф и пакет в первом сообщении, новый `providerSessionId`. Проверка транскрипта по корню цели.
- **host** (фейковый pty): готовность цели проверяется до `stop`; порядок `switching → stop → apply → launch →
  clear`; env нового процесса — `CLAUDE_CONFIG_DIR` цели; старые токены хуков и канала отвергаются; письмо во
  время замены не поднимает сессию; ложного «is back» нет; `held` для Codex; отказ запуска → `sleeping` с новым
  провайдером и уведомлением; повтор `requestId` идемпотентен; удалённый провайдер → замена проходит.
- **desktop**: пункт меню (видимость, подсветка), диалог (цели, `transcript` только при `targets[].transcript`,
  `force`), баннер в чате, действие в уведомлении, пометка «Provider removed», разделитель в ленте.
- **E2E**: имитация лимита (`PARLEY_STUCK_REPORT_MS`, фейковый `StopFailure rate_limit`) → баннер → замена на
  другой провайдер → новый агент получает пакет, `get_map` показывает те же комнаты и детей, письмо ведущему ушло.
- **T0 вручную** — раздел 8.

## 8. План задач

Правило PARLEY.md: реализация — junior-сессии по одной задаче; senior-only помечены причиной.

| № | Задача | Файлы | Приёмка | Кто |
|---|---|---|---|---|
| T0 | Спайк: продолжение транскрипта между двумя аккаунтами Claude (копия + `--resume`, копия + `--resume --fork-session`), с thinking-блоками и большим контекстом; что ломается | заметка в этой спеке, 5.4 | **Сделано: «да», вариант `--fork-session` (5.4.1)** | senior — без прототипа задачу не описать |
| T1 | Модель данных: `AgentBinding`, `previousAgents`, `switching`, `agentRevision`; `parseMap`; `applyAgentSwitch`, `switchBlockers` | `core/src/work/types.ts`, `map.ts`, новый `agent-switch.ts` | Юнит-тесты 7/core (первая группа); старые карты читаются без миграции | junior |
| T2 | `buildHandover` и файл хвоста | `core/src/work/agent-switch.ts`, `summary.ts` (экспорт) | Тесты бюджетов; встроенная часть ≤ 12 КБ на фикстуре с 50 письмами и 30 детьми | junior |
| T3 | Запуск с пакетом: `options.handover` в режиме `launch`, сброс `providerSessionId`, проверка транскрипта по корню цели | `core/src/work/launch.ts` | Тесты `plan('launch')` и корня цели; прежние тесты запуска зелёные | junior |
| T4 | Ограда: `finishedState` при `switching`; `agentRevision` при старте и проверка в пишущих инструментах MCP | `core/src/mcp/tools.ts`, `launch.ts`, `startSession` | Тесты 7/core (ограда, `wait_for`) | **senior-only**: граница записи и конкуренция |
| T5 | Оркестратор `switchAgent` и `switchOptions`; `launching` на весь срок; будильник пропускает `switching`; `stuck.endBySwitch`; строки, письма, расход | `host/src/sessions/sessions-service.ts`, `wake/wake-service.ts`, `stuck/stuck-service.ts`, `methods/index.ts` | Тесты 7/host полностью | **senior-only**: конкуренция и восстановление |
| T6 | Протокол: схемы и результаты, список методов | `protocol/src/methods.ts` | Сборка protocol/host/desktop; старый хост → окно прячет пункт (`useHostSupports`) | junior |
| T7 | Тексты: `limitLetter`, `stuckLine`, гид `stuck`, строка и письмо при смене владельца комнаты | `core/src/work/stuck.ts`, `guide.ts`, `rooms.ts`, `host/src/rooms/rooms-service.ts` | Снимки текстов в тестах обновлены; новый владелец получает письмо | junior |
| T8 | Меню строки сессии и `SwitchAgentDialog` | `desktop/src/renderer/sidebar/SessionRowMenu.tsx`, новый `components/dialogs/SwitchAgentDialog.tsx`, `shared/strings.ts` | Тесты 7/desktop (меню, диалог) | junior |
| T9 | Баннер в чате, действие в уведомлении, пометка «Provider removed», разделитель в ленте | `chat/ChatView.tsx`, новый `chat/SwitchBanner.tsx`, `attention/notify.ts`, `sidebar/SessionRow.tsx`, `chat/feed-model.ts` | Тесты 7/desktop (остальное) | junior |
| T10 | Этап 2: карточка `agent-switch`, инструмент `request_agent_switch`, остров и Telegram | `protocol/src/consents.ts`, `host/src/consents/*`, `core/src/mcp/tools.ts`, `island/requests.ts`, `host/src/telegram/*` | Агент без `allow` ничего не меняет; `allow` из любого канала вызывает `switchAgent` | junior, ревью senior (права) |
| T11 | Режим `carry: 'transcript'` (T0 — «да»): копия в папку цели, `--resume <uuid> --fork-session`, связывание нового id, удаление копии после появления форка (5.4.1). **Расход по отрезкам (5.9)**: `reason: 'model'` и привязка в `setModel`, счёт по окнам и id ответов, стоимость из `cost-state`, слияние отрезков при пределе 20, `LiveMetrics.usageSegments`, сумма по комнате | `core/src/work/agent-switch.ts`, `launch.ts`, `usage-ledger.ts`, `host/src/sessions/sessions-service.ts`, `room-usage.ts`, `protocol/src/types.ts` | Сессия продолжает разговор на другом аккаунте; источник не тронут; в папке цели один разговор. **Тест: сессия с двумя заменами** (Claude·Opus → `custom-claude-*`·Opus с форком → смена модели на Sonnet): три отрезка с провайдером, моделью, началом/концом, своими токенами и стоимостью; итог = сумма отрезков, прежний расход из форка не посчитан второй раз | **senior-only**: запись в чужую папку конфигурации, восстановление |
| T12 | E2E и документация: CHANGELOG, гид окна | `packages/desktop/e2e/*`, `CHANGELOG.md` | E2E из 7 зелёный | junior |
| T13 | `deleteCustom`: число сессий аккаунта и ссылка «Continue them on…» | `host/src/methods/custom-providers.ts`, `components/providers/CustomProviderPanel.tsx` | Удаление показывает 8 сессий на фикстуре w-0054 | junior |
| T14 | Удалённый провайдер безопасно (5.8, ответ 5): будильник не поднимает сессию без провайдера в реестре, ожидание писем `provider-missing`; понятный отказ `launch`; без писем «did not resume» и `resume-failed` | `protocol/src/types.ts` (`MailWait`), `host/src/wake/wake-service.ts`, `host/src/sessions/sessions-service.ts`, desktop — подпись ожидания | Тест хоста: письмо спящей сессии удалённого провайдера — ни запуска, ни `resume-failed`, ожидание `provider-missing`; ручной Resume — новый текст | junior |
| T15 | Окно: расход по отрезкам в поповере значка расхода сессии и в расходе комнаты (5.9) | `chat/SessionUsageChip.tsx`, `lib/usage-format.ts`, `components/rooms/RoomUsageChip.tsx`, `shared/strings.ts` | Тест desktop: две замены → три строки отрезков и итог; без `usageSegments` — прежний вид | junior |

Порядок (пересмотрен 2026-10-30, решения 1, 4, 5): T0 — сделан. Волна 1: T1 ∥ T6 ∥ T7 ∥ T14. Волна 2: T2, T3
(после T1), T4 (после T1). Волна 3: T5 (после T3, T4, T6), T8, T13 (после T6). Волна 4: T9, T10, T11 (после T5).
T15 — после T11.
Последним — T12. **Этап 1** (замена из окна, оба режима переноса) = T1–T9, T11, T13–T15; **этап 2** (агент
просит через карточку согласия) = T10. Оба входят в первую версию.

## 9. Вопросы человеку и ответы (2026-10-30)

1. **Транскрипт.** Пересматриваем решение 5 спеки подписок («Истории не переносить») для аккаунтов Claude, если T0
   покажет, что это работает? Или только пакет передачи?
   **Ответ: переносить.** В Parley основная работа и память, перенос должен быть максимально полным. T0 — «да»
   (5.4.1), T11 входит в первую версию.
2. **Название и место кнопки.** «Continue on another provider…» в меню сессии и баннере — подходит?
   **Ответ: да.**
3. **Агент без спроса.** Нужна ли настройка «ведущий может продолжить застрявшую сессию на другом аккаунте без
   вопроса» или всегда карточка согласия (по умолчанию — всегда карточка)?
   **Ответ: всегда карточка согласия человека; настройки «без вопроса» нет.**
4. **Этап 2 сразу?** Делать карточку для агентов (T10) в первой версии или после?
   **Ответ: в первой версии.**
5. **Восемь спящих сессий `custom-claude-2` в w-0054** — продолжить их на другом провайдере после T5 или закрыть?
   **Ответ: не трогать и не закрывать.** Пусть спят; человек продолжит их новой кнопкой. Отсюда T14: отсутствующий
   провайдер обрабатывается безопасно (5.8).

## 10. Журнал правок

- 2026-10-30, s-131: внесены ответы человека (раздел 9). Итог спайка T0 — 5.4.1 («да», `--fork-session`). 5.5 —
  настройки «без вопроса» нет. 5.8 — безопасное ожидание сессий удалённого провайдера. Раздел 8: T0 сделан, T11
  уточнён по итогам T0, новая T14, порядок волн и состав этапов; T10 и T11 входят в первую версию.
- 2026-10-30, s-131: решение человека об учёте расхода — новый раздел 5.9 (отрезки по каждой замене провайдера,
  аккаунта или модели; итог — сумма без двойного счёта форка; показ по отрезкам в окне). `AgentBinding.reason` +=
  `'model'`, поле `costUsd`; 6.14 переписан; приёмка T11 — тест на сессию с двумя заменами; новая T15 (окно).
- 2026-10-30, s-131: 5.9 «Стоимость» уточнена по реальной записи `cost-state` (нет `timestamp` и `costBasis`).
  Лимит пространства на новые сессии агентов (100) исчерпан — волна 4 идёт на переиспользованных исполнителях.
- 2026-10-31, s-131: реализовано в `feat/session-takeover` — T0–T15 (T11 разделён на T11a «перенос транскрипта» и
  T11b «расход по отрезкам»). Решение лида по ревью (находка 6): «Allow» на карточке `agent-switch` — согласие
  остановить работающего агента (`force`), текст карточки это говорит. Ревью Opus-критика —
  `docs/audits/2026-10-30/session-takeover-review.md`: 13 находок, все закрыты, второй проход без blocker/major.
  Известное ограничение: кнопок Retry/Back в уведомлении `launch-failed` нет (у `HostNotice` нет действий) — текст
  уведомления подсказывает Resume или обратную замену.
