# Застрявшие сессии — план

> **Для исполнителей-агентов:** навык superpowers:subagent-driven-development; задачи по одной; шаги — флажками (`- [ ]`).

**Цель:** сессия, которой нужно явное действие человека (одобрение, вопрос, лимит, слетевший вход, экран при
старте), получает состояние `need`. Человеку — уведомление с причиной и свой звук, ведущему — строка в комнате и
письмо Parley, агентам — поле `stuck` в MCP; во время лимита письма ждут, после сброса Parley возвращает сессию сам.

**Спека (обязательна к чтению):** `docs/specs/2026-10-12-stuck-sessions-design.md`. У каждой задачи указаны её разделы.

**Где работать:** ветка `feat/stuck-sessions`, worktree `.claude/worktrees/stuck-sessions` от `origin/master`
(ebdb1eb). Команды — из корня worktree. Один раз: `pnpm install && pnpm build`. Затем:
- тесты пакета — `pnpm --filter @parley/<core|protocol|host|desktop> test`;
- одиночный тест — `pnpm --filter @parley/<pkg> exec vitest run <путь>`;
- типы и линт — `pnpm typecheck`, `pnpm lint`;
- E2E — `pnpm --filter @parley/desktop build && pnpm --filter @parley/desktop exec playwright test <файл>`.

**Группы для исполнения.** После группы — один агент проверки: тесты затронутых пакетов строго по очереди,
`pnpm typecheck`, `pnpm lint`; затем контролёр сам читает диф.

| Группа | Задачи | Что даёт |
|---|---|---|
| A | 0 | ответ «почему не было звука» на текущем коде |
| B | 1, 2, 3 | core: разбор ошибок, события, `need` в свёртке |
| C | 4, 5 | хост: `need` в активности, письма ждут |
| D | 6, 7 | окно: метки, строка доставки, уведомления, звук, настройки |
| E | 8, 9 | карта, MCP, гид; служба «застрял» |
| F | 10 | возврат после сброса лимита |
| G | 11, 12 | E2E и документы |

Прикидка цены: порядка 10–15 % недельного лимита плана Max (13 задач на Sonnet, проверка по группам, ревью
контролёра). Перед каждой группой контролёр смотрит `get_usage`.

## Глобальные ограничения

- Тексты для агентов (строки ленты, письма, подсказки `wait_for`, предупреждения `send_message`, гид, бриф,
  заглушка навыка, описания инструментов) и строки окна — **английские**. Стражи: `english-text.test.ts` в core и
  host, `packages/desktop/src/english-ui.test.ts`. Комментарии, тесты, коммиты — по-русски.
- Числа — только константами:
  - core `work/stuck.ts`: `NEED_DETAIL_MAX = 200`, `STUCK_REPORT_MS = 120_000`, `LIMIT_RETURN_GRACE_MS = 120_000`,
    `LIMIT_RETRY_MS = 900_000`, `LIMIT_RETURNS_MAX = 2`;
  - окно: `NEED_SETTLE_MS = 1_000` (`attention/notify.ts`), `CHIME_MIN_GAP_MS = 2_000` (`attention/chime.ts`).
  Других чисел мимо констант нет.
- Протокол меняется только добавлением: `SessionActivity.need`, `MailWait` `'stuck'`, `NoticeKind`
  `'limit-return-blocked'`. Окно читает отсутствующее `need` как `null`.
- Журналы CLI только читаем. В `~/.claude`, `~/.codex`, `~/.agents` не пишем — только в каталоги Parley.
- Старые CLI (без `StopFailure`, без `quota_auto_resume_*`) — безопасная сторона: запасной путь через журнал
  сессии или поведение как раньше, без поломки запуска.
- Исполнитель задачи запускает только одиночные тесты своих файлов и `tsc` своего пакета. Полные прогоны — у
  агента проверки группы, **по одному процессу**: никаких параллельных прогонов; `pnpm -r test` — только с
  `--workspace-concurrency=1` или по пакетам подряд.
- Коммит: `git commit -m "<тип>(<область>): …" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"`. В
  коммит — только свои пути (не `.omc/`, не `.superpowers/`). Не пушить.
- Окно 800×500 и длинные имена работы, комнаты и сессий: метки и строки не вылезают за края, горизонтальной
  прокрутки нет.

## Фокус ревью

1. **Пачка коротких одобрений Codex** (три одобрения за две минуты, каждое закрыто за 30–90 с): ни записи `stuck`,
   ни строк ленты, ни писем; по уведомлению на эпизод. Тест — задача 9, «короткие эпизоды не копятся».
2. **Перезапуск хоста посреди эпизода лимита:** ни повторного письма «hit its limit», ни ложного «back». Тест —
   задача 9, сверка после старта.
3. **Человек сам написал в сессию Claude, пока та ждёт сброса:** эпизод снят («back»), продолжение Parley после
   этого не печатается. Тест — задача 10.
4. **Время сброса в чужом поясе и через полночь:** «resets 1am (Europe/Moscow)» при часах машины в другом поясе
   в 23:50 → ближайшее 01:00 по Москве, строго позже записи, не дальше 24 ч. Тест — задача 1, инварианты.
5. **Застрявший участник архивной комнаты, закрытая или спящая сессия:** без строк ленты и писем, без меток, без
   падения окна. Тесты — задачи 6 и 9.

---

## Задача 0. Проба: доходит ли уведомление «needs you» у Codex в комнате (код как есть)

Спека: 10, 10.1 п. 1 и 3.

**Файлы:** новый `packages/desktop/e2e/stuck-notify.spec.ts`. Образцы — `e2e/codex.spec.ts` (заглушка Codex,
`STUB_APPROVAL`) и `e2e/attention.spec.ts` (журнал уведомлений `__parleyNotifications`, `PARLEY_NOTIFICATIONS=log`).

**Сценарий:**
1. Работа с комнатой: ведущий — заглушка Claude (`stub-echo-agent.mjs`), участник — заглушка Codex
   (`stub-codex-agent.mjs`, `PARLEY_CODEX_BIN`). Активна вкладка комнаты: терминал Codex не виден.
2. В терминал Codex — `STUB_APPROVAL`.
3. Ждать в журнале уведомлений запись с заголовком, где есть ярлык сессии Codex и `needs you`.
4. В том же тесте: окно скрыто (`app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())`), в
   окне `new AudioContext().state` — записать значение.

- [ ] **Шаг 1.** Написать тест; ожидание — уведомление есть и `silent === false`.
- [ ] **Шаг 2.** `pnpm --filter @parley/desktop build`, прогнать только этот файл.
- [ ] **Шаг 3.** Итог — в спеку, 10.1 п. 1 и п. 3, одной-двумя строками:
  - **уведомление есть** — окно его шлёт, причина тишины в macOS; свой звук (задача 7) её закрывает;
  - **уведомления нет** — остановиться, записать, что именно не так (`onActivity` не звался, уровень не
    `needs-you`, `isTargetVisible` вернул `true`), и вернуть контролёру: дальше идём через
    superpowers:systematic-debugging, а не по плану;
  - `AudioContext.state` в скрытом окне — `running` или `suspended`. Если `suspended`, задача 7 зовёт
    `context.resume()` перед звуком (там это уже предусмотрено).
- [ ] **Шаг 4.** Коммит `test(desktop): E2E — уведомление needs you у Codex в комнате; итог пробы в спеке`.

Тест остаётся в наборе. Задача 7 меняет его ожидания (`silent: true`, свой звук, текст причины).

---

## Задача 1. Core: разбор ошибок и времени сброса — `work/stuck.ts`

Спека: 3.1, 3.2 (таблицы), 3.4, 10.1 п. 2 и 5.

**Файлы:** новый `packages/core/src/work/stuck.ts`, новый `packages/core/src/work/stuck.test.ts`, экспорт в
`packages/core/src/index.ts` (рядом с экспортом `work/activity.js`).

**Интерфейсы:**

```ts
export type NeedKind = 'approval' | 'question' | 'limit' | 'sign-in' | 'startup';
export interface SessionNeed {
  kind: NeedKind;
  since: string;                         // ISO, начало эпизода
  detail: string | null;                 // clampDetail
  resetsAt: string | null;               // только limit
  window: 'session' | 'week' | null;     // только limit
  account: 'auth' | 'account' | null;    // только sign-in
}
export const NEED_DETAIL_MAX = 200;
export const STUCK_REPORT_MS = 120_000;
export const LIMIT_RETURN_GRACE_MS = 120_000;
export const LIMIT_RETRY_MS = 900_000;
export const LIMIT_RETURNS_MAX = 2;

/** Строка без переводов строк и лишних пробелов, не длиннее NEED_DETAIL_MAX (с `…`); пустая → null. */
export function clampDetail(text: string | null | undefined): string | null;

export interface ApiFailure { kind: 'limit' | 'sign-in'; account: 'auth' | 'account' | null }
/** `error` хука StopFailure или записи журнала Claude: rate_limit → limit; authentication_failed,
 *  oauth_org_not_allowed → sign-in/auth; account_on_hold, billing_error → sign-in/account; прочее → null. */
export function classifyClaudeFailure(error: string | null): ApiFailure | null;
/** `codex_error_info` из task_complete.error (строка или объект с одним ключом): usage_limit_exceeded →
 *  'rate_limit'; unauthorized → 'authentication_failed'; прочее → null. Возвращает словарь Claude, чтобы
 *  свёртка разбирала обе стороны одним classifyClaudeFailure. */
export function codexFailureError(info: unknown): 'rate_limit' | 'authentication_failed' | null;

export interface ResetGuess { resetsAt: string | null; window: 'session' | 'week' | null }
/**
 * Время сброса и окно из текста ошибки. Форматы:
 * - Claude: «resets 2:50pm (Europe/Moscow)», «resets 7pm (Europe/Moscow)», «resets Sep 22 at 4pm (Europe/Moscow)»;
 *   пояс — из скобок, без скобок — localZone;
 * - Codex: «try again at 7:27 PM», «try again at Oct 14th, 2026 7:27 PM» — localZone.
 * Время без даты — ближайшее строго после `at`; дата без года — в году `at`, а если она уже прошла — в следующем.
 * window: «session limit» → 'session', «weekly limit» → 'week', иначе null. Непонятное, несуществующий пояс → resetsAt null.
 */
export function parseResetText(text: string, at: Date, localZone?: string): ResetGuess;
/** Момент по часам пояса: два прохода по смещению Intl.DateTimeFormat; несуществующее время (перевод часов
 *  вперёд) сдвигается на величину скачка. null — пояс неизвестен. */
export function zonedInstant(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date | null;

/**
 * Окончательное время сброса (спека 3.4): окно провайдера, названное `guess.window`, а без него — окно с
 * usedPercent ≥ 100 (оба — более позднее), если его сброс позже `now`; иначе `guess.resetsAt`.
 * Данные провайдера новее `since` и все окна < 100 % — лимит уже сброшен: resetsAt = now.
 */
export function pickResetsAt(
  guess: ResetGuess,
  limits: ProviderLimits | null,
  since: string,
  now: number,
): ResetGuess;
```

`localZone` по умолчанию — `Intl.DateTimeFormat().resolvedOptions().timeZone`.

- [ ] **Шаг 1.** Падающие тесты `stuck.test.ts`:
  - `clampDetail`: перевод строки → пробел, 300 знаков → 200 с `…`, `''` и `undefined` → `null`;
  - `classifyClaudeFailure` и `codexFailureError` — каждое значение из докстрингов, `null`, неизвестное,
    объект `{ http_connection_failed: { http_status_code: 502 } }` → `null`;
  - `parseResetText`, Claude: «You've hit your session limit · resets 2:50pm (Europe/Moscow)» →
    `window: 'session'`, время по Москве 14:50; «You've hit your weekly limit · resets Sep 22 at 4pm
    (Europe/Moscow)» → `'week'`, 22 сентября 16:00 по Москве; «(Mars/Base)» → `resetsAt: null`;
  - `parseResetText`, Codex: «try again at 7:27 PM» при `at` в 19:30 того же пояса → завтра 19:27; «try again at
    Oct 14th, 2026 7:27 PM» → точно; «try again later» → `null`;
  - **инварианты** (фокус ревью 4): для каждого часа 0–23 суток `at` и поясов `Europe/Moscow`,
    `America/New_York`, `Asia/Kolkata` «resets 1am (<пояс>)» даёт момент строго позже `at`, не дальше 24 ч, а
    стенные часы пояса в этот момент — 01:00; дата «Jan 2 at 4pm» при `at` = 31 декабря → следующий год;
  - `zonedInstant` в день перевода часов `America/New_York` (2:30 весной) → не `null`, 03:30 по стенным часам;
  - `pickResetsAt`: окно провайдера в будущем бьёт текст; окно в прошлом — текст; `window: 'week'` берёт `week`;
    оба окна по 100 % — позднее; данные новее `since` и все < 100 % → `resetsAt` = `now`; `limits: null` — текст.
- [ ] **Шаг 2.** Реализация; экспорт из `index.ts`.
- [ ] **Шаг 3.** `pnpm --filter @parley/core exec vitest run src/work/stuck.test.ts`, `pnpm --filter @parley/core exec tsc --noEmit`.
- [ ] **Шаг 4.** Коммит `feat(core): разбор ошибок лимита и входа, время сброса по тексту и данным провайдера`.

## Задача 2. Core: поля событий, хук `StopFailure`, ошибки в индексах журналов

Спека: 3.2, 4.1, 4.2.

**Файлы:**
- `packages/core/src/work/events.ts` — `EventRecord`, `bareEvent`, `eventRecordOf`;
- `packages/core/src/work/settings-file.ts` — `HOOK_EVENTS`;
- `packages/core/src/session-index.ts` — `SessionIndex`, разбор записей;
- `packages/core/src/codex/index-session.ts` — `lastTurnEvent`;
- `packages/core/src/work/activity.ts` — тип `ActivityLog`;
- `packages/host/src/activity/log-index.ts` — `log(session)`.

Тесты — их тест-файлы (`events.test.ts`, `settings-file.test.ts`, `session-index.test.ts`, тест
`index-session`, тест `log-index.test.ts`).

**Интерфейсы:**
- `EventRecord` получает (все `string | null`, у `bareEvent` — `null`):
  - `error` — `data.error` строкой;
  - `errorDetails` — `data.error_details`;
  - `lastAssistantMessage` — `data.last_assistant_message`;
  - `message` — `data.message` (у `Notification`);
  - `toolName` — `data.tool_name`;
  - `toolDetail` — `clampDetail` от `tool_input.command` (Bash), `tool_input.file_path` (Edit, Write,
    MultiEdit), `tool_input.notebook_path` (NotebookEdit), иначе `null`.
- `HOOK_EVENTS` — плюс `'StopFailure'` (сразу после `'Stop'`).
- `SessionIndex.lastApiError?: { at: string; error: string | null; text: string }` — самая поздняя запись
  ассистента с `isApiErrorMessage: true` (сырое поле записи в `onRecord(raw, …)`): `error` — `raw.error`, `text` —
  текст блоков `message.content`.
- `SessionIndex.lastTurnEvent.error?: { info: unknown; message: string }` — у `task_complete` с объектом `error`
  (`codex_error_info`, `message`).
- `ActivityLog.lastApiError?: { at: string; error: string | null; text: string } | null`; `log-index.log(session)`
  кладёт его из индекса.

- [ ] **Шаг 1.** Падающие тесты:
  - `eventRecordOf` на stdin `StopFailure` из документации (`error: "rate_limit"`, `error_details: "429 Too Many
    Requests"`, `last_assistant_message: "API Error: Rate limit reached"`) и на `PermissionRequest` Bash с
    `tool_input.command` → поля заполнены; на `Stop` — `null`;
  - `HOOK_EVENTS` содержит `StopFailure`, собранный файл настроек несёт хук `StopFailure` с той же командой;
  - индекс Claude на фикстуре из трёх записей (человек → ассистент `isApiErrorMessage`, `error: "rate_limit"`,
    текст «You've hit your session limit · resets 2:50pm (Europe/Moscow)») → `lastApiError` с этим текстом;
  - индекс Codex на rollout с `task_complete`, где `error: { message: "You've hit your usage limit. … try again
    at 7:27 PM.", codex_error_info: "usage_limit_exceeded" }` → `lastTurnEvent.error`;
  - `log-index.log` отдаёт `lastApiError`.
- [ ] **Шаг 2.** Реализация.
- [ ] **Шаг 3.** Одиночные тесты этих файлов; `tsc` core и host.
- [ ] **Шаг 4.** Коммит `feat(core): поля ошибки и инструмента в событиях хуков, StopFailure в журнале, ошибки API в индексах`.

## Задача 3. Core: `need` в свёртке `activityOf`

Спека: 3.1–3.3, 3.5 (только «конкретнее — сильнее»).

**Файлы:** `packages/core/src/work/activity.ts`, `activity.test.ts`; экспорт `SessionNeed`, `NeedKind` (уже из
задачи 1).

**Интерфейсы:**
- `SessionActivity.need: SessionNeed | null`.
- Внутренний тип уведомления хоста: `export const PARLEY_STARTUP_NOTIFICATION = 'parley_startup'` (в `events.ts`) —
  хост пишет его в свёртку, когда сессия молчит со старта (задача 4); входит в `BLOCKING`.
- Правила свёртки (порядок событий — порядок файла, как сейчас):
  - `PermissionRequest` → `blocked`, `need` `approval`, `detail` = `toolDetail ?? toolName`;
  - `Notification` `permission_prompt` → `approval`, `detail` = `message`;
  - `Notification` `agent_needs_input`, `elicitation_dialog`, `elicitation_url_dialog` → `question`, `detail` =
    `message`;
  - `Notification` `parley_startup` → `startup`;
  - **конкретнее — сильнее:** в идущем эпизоде `approval` не заменяется `question`, а `question` повышается до
    `approval`; `since` — начало эпизода;
  - `StopFailure` → `end(at)`. Если `classifyClaudeFailure(error)` не `null` — `need` вида `limit` или `sign-in`:
    `detail` = `clampDetail(lastAssistantMessage ?? errorDetails)`, `resetsAt` и `window` — `parseResetText`
    от того же текста и `at` (только для `limit`), `account` — из классификации;
  - запасной путь: `log.lastApiError` новее последнего события и последней записи человека, и ход не `blocked` →
    то же, что `StopFailure` в момент `lastApiError.at` (`error` и `text` из записи), и ход окончен в этот момент,
    а не по тишине;
  - снятие: `start()` (`UserPromptSubmit`, кадр спиннера Codex, `elicitation_complete`/`elicitation_response`),
    `Notification` `quota_auto_resume_fired` (ход начался), `auth_success` (снимает только `sign-in`), запуск
    процесса (`SessionStart` с источником запуска), более свежая запись человека в логе. `Stop`, `idle_prompt` и
    сигнал `Ready` после `StopFailure` `need` вида `limit`/`sign-in` **не** снимают: ход и так окончен;
  - `need` не `null` только если: `activity === 'blocked'` и вид `approval`/`question`/`startup`, или ход окончен
    (`unseen`/`idle`) и вид `limit`/`sign-in`. Иначе — `null`.
- Lifecycle свёртка не видит: `null` у спящей и закрытой ставит хост (задача 4).

- [ ] **Шаг 1.** Падающие тесты — таблицей случаев: каждый источник из правил → вид, `detail`, `since`;
  «конкретнее — сильнее» в обе стороны; `StopFailure` с `rate_limit` и текстом с «resets» → `resetsAt` не `null`,
  ход окончен (`unseen`); запасной путь по `lastApiError` без событий; снятие каждым событием; **инвариант**: для
  всех случаев таблицы `need !== null` ⇒ (`blocked` и вид из тройки) или (`unseen`/`idle` и вид из пары);
  `quota_auto_resume_fired` после лимита → `working`, `need` `null`; `auth_success` снимает `sign-in`, но не
  `limit`.
- [ ] **Шаг 2.** Реализация.
- [ ] **Шаг 3.** `pnpm --filter @parley/core exec vitest run src/work/activity.test.ts`, `tsc` core.
- [ ] **Шаг 4.** Коммит `feat(core): потребность сессии need в свёртке активности — одобрение, вопрос, лимит, вход, старт`.

## Задача 4. Хост: `need` в `activity-service`

Спека: 3.2 (Codex, `startup`), 3.4, 4.3.

**Файлы:**
- `packages/host/src/pty/codex-terminal.ts` — `classifyNotification` отдаёт `detail`;
- `packages/host/src/activity/activity-service.ts`;
- `packages/host/src/feed/feed-service.ts` — `questionHeld` с текстом;
- `packages/host/src/host.ts` — `limitsService` создаётся до `activityService` и передаётся ему.

Тесты — `codex-terminal.test.ts`, `activity-terminal.test.ts`, `activity-service.test.ts`, `feed-service.test.ts`.

**Интерфейсы:**
- `CodexSignal` `needs-you` получает `detail: string | null`:
  - «Approval requested: ls -la» → `ls -la`;
  - «Codex wants to edit src/a.ts» → `edit src/a.ts`;
  - заголовок — `null`.
- `eventNameOf` заменяется на `eventOfSignal(signal, turnSeen, at): EventRecord | null`:
  - `needs-you`/`approval-requested` → `Notification` с `notificationType: 'permission_prompt'` и `message: detail`;
  - `needs-you`/`action-required` → `Notification` с `notificationType: 'agent_needs_input'`;
  - остальное — как сейчас.
- `startupExpired` (Codex) записывает `Notification` `parley_startup` вместо `PermissionRequest`.
- **Лимит и вход у Codex:** `eventsFor` превращает `lastTurnEvent` вида `task_complete` с `error` в событие
  `StopFailure` (`error` = `codexFailureError(error.info)`, `lastAssistantMessage` = `error.message`), если
  `codexFailureError` не `null`. Такое событие встаёт в свёртку по своему времени **всегда**, а не только когда
  оно новее сигнала терминала: Codex после ошибки пишет заголовок `Ready`, и правило «старый конец хода не
  перекрывает новый сигнал» иначе потеряло бы ошибку.
- **Старт у Claude и GLM:** сессия запущена хостом (`launchedBy === 'host'`), `lifecycle: 'active'`, за
  `trustWaitMs` после `startedAt` в журнале ни одного события. Тогда в `eventsFor` добавляется синтетическое
  `Notification` `parley_startup` с временем истечения срока; первое событие журнала его снимает. Уведомление
  `trust-wait` — как сейчас (только сессии в worktree).
- `FeedServiceDeps['activity'].questionHeld(ref, held, detail?: string | null)` — служба ленты передаёт текст
  первого вопроса AskUserQuestion. Опубликованное `blocked` от удержания несёт `need` `question` с этим
  `detail`, `since` — момент удержания.
- `createActivityService(…, options)` получает `limits?: Pick<LimitsService, 'get' | 'refresh'>`. После свёртки,
  если `need?.kind === 'limit'`: `need = { ...need, ...pickResetsAt(need, limits.get(session.provider), need.since, now) }`.
  У GLM без `resetsAt` из данных провайдера — `limits.refresh(true)` **один раз на эпизод** (ключ — сессия +
  `since`), по готовности — `recompute(ref)`.
- У сессии с `lifecycle !== 'active'` публикуется `need: null`.

- [ ] **Шаг 1.** Падающие тесты:
  - `classifyNotification` — `detail` для обеих строк;
  - Codex: `STUB_APPROVAL`-поток (OSC 9 + заголовок) → `need` `approval`, `detail` `ls -la`; один заголовок →
    `question`; заголовок, затем OSC 9 → `approval` с прежним `since`; старт без сигналов 20 с → `startup`;
  - Claude, сессия хоста без worktree, 20 с без событий → `blocked` и `startup`; первое событие снимает;
  - журнал со `StopFailure` `rate_limit` → `need` `limit`, `resetsAt` по тексту; `limits.get` с окном 100 % в
    будущем → `resetsAt` окна; GLM без окна → `refresh(true)` ровно один раз за эпизод;
  - Codex: rollout с `task_complete` и `usage_limit_exceeded`, а следом сигнал `Ready` → `need` `limit` с временем
    из «try again at …»; `unauthorized` → `sign-in`/`auth`;
  - `questionHeld(ref, true, 'Which DB?')` → `need` `question` с этим `detail`;
  - спящая сессия с ошибкой лимита в журнале → `need: null`.
- [ ] **Шаг 2.** Реализация.
- [ ] **Шаг 3.** Одиночные тесты этих файлов; `tsc` host.
- [ ] **Шаг 4.** Коммит `feat(host): need в активности — причины Codex, старт у Claude, вопрос из ленты, время сброса от службы лимитов`.

## Задача 5. Письма ждут застрявшего: `MailWait` `stuck`

Спека: 6.1.

**Файлы:**
- `packages/core/src/work/delivery.ts` — `deliveryAction`, тип причины;
- `packages/protocol/src/types.ts` — `MailWait`;
- `packages/host/src/wake/wake-service.ts` — `waitingOf`, `LOGGED_REASONS`;
- `packages/desktop/src/shared/strings.ts` — `S.rooms.mailWait.stuck: 'waiting'` (точный текст по `need` даёт
  задача 6).

Тесты — `delivery.test.ts`, `wake-service.test.ts`.

**Интерфейсы:**
- `DeliveryAction` `none` получает причину `'stuck'`.
- В `deliveryAction` у живой сессии сразу после `not-live`: `activity?.need != null` → `{ kind: 'none', reason:
  'stuck' }`. Это раньше `no-hooks` и `busy`: у `startup` причина «застрял» точнее.
- `MailWait` получает `'stuck'` (докстринг: «сессия ждёт человека или сброса лимита — причина в `need` её
  активности»), `waitingOf` → `'stuck'`, `LOGGED_REASONS` — плюс `'stuck'`.

- [ ] **Шаг 1.** Падающие тесты:
  - `deliveryAction`: `unseen` с `need` `limit` и непрочитанным письмом → `none`/`stuck`; без `need` — указатель;
    у спящей с `need` (пришёл старый снимок) — по-прежнему `resume`;
  - будильник: живая сессия с `need` `limit` и письмом → `mailWaiting: 'stuck'`, в PTY ничего не напечатано.
- [ ] **Шаг 2.** Реализация. **Шаг 3.** Одиночные тесты; `tsc` core, host, desktop.
- [ ] **Шаг 4.** Коммит `feat(host): письма ждут застрявшую сессию — причина stuck`.

## Задача 6. Окно: внимание, метки, подсветка комнаты, строка доставки

Спека: 7.3.

**Файлы:**
- `packages/desktop/src/renderer/attention/derive.ts` — `sessionAttention`;
- новый `packages/desktop/src/renderer/lib/need-label.ts`;
- новый `packages/desktop/src/renderer/lib/use-now.ts` — если в окне уже есть хук тика времени (поискать
  `useNow`, `setInterval` в `renderer/lib`), использовать его;
- `packages/desktop/src/renderer/components/rooms/ParticipantStrip.tsx`;
- `packages/desktop/src/renderer/sidebar/SessionRow.tsx`;
- `packages/desktop/src/renderer/sidebar/RoomRow.tsx`;
- `packages/desktop/src/renderer/layout/tab-meta.ts`;
- `packages/desktop/src/renderer/components/rooms/feed-model.ts`;
- `packages/desktop/src/renderer/components/rooms/RoomMessage.tsx`;
- `packages/desktop/src/shared/strings.ts` — группа `S.need`.

Тесты — рядом с каждым файлом (`*.test.ts(x)`).

**Интерфейсы:**
- `sessionAttention(session, live)`: живая сессия с `live?.need != null` → `'needs-you'` (до разбора
  `activity`). Спящая и закрытая — как сейчас.
- `need-label.ts`:
  - `needWord(need: SessionNeed, now: number): string`:
    - `approval` → `approval`, `question` → `question`, `startup` → `startup`;
    - `limit` → `limit · 19:27`; не сегодня — `limit · Oct 14, 19:27`; после сброса — `limit · reset`; без времени —
      `limit`;
    - `sign-in` → `signed out` (`account: 'auth'`) или `account` (`account: 'account'`).
  - `needTooltip(need): string | null` — `detail`.
  - `mailWaitText(reason: MailWait | null, need: SessionNeed | null): string | null`:
    - `stuck` + `approval` → `waiting for your approval`;
    - `stuck` + `question` → `asked you a question`;
    - `stuck` + `limit` → `usage limit until 19:27`, после сброса `usage limit has reset`, без времени `usage
      limit`;
    - `stuck` + `sign-in` → `signed out`;
    - `stuck` + `startup` → `waiting at startup`;
    - иначе `S.rooms.mailWait[reason]`, незнакомая причина — `waiting`, `null` → `null`.
  - Время — `HH:mm` по часам машины (`Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })`),
    дата — `Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })`.
- `use-now.ts`: `useNow(active: boolean, everyMs = 30_000): number` — тикает, только пока `active`.
- `ParticipantStrip` и `SessionRow`: при `need` слово — `needWord`, подсказка — `needTooltip`; тик — `useNow(need?.kind === 'limit')`.
- `RoomRow`: ждущее решение — по-прежнему `decision`; иначе, если у любого участника живой сессии есть `need`,
  — слово `S.states.blocked` (`needs you`) той же подсветкой. `tab-meta` (вкладка комнаты): `tint: 'accent'` и при
  застрявшем участнике.
- `feed-model`: `waiting` получает `need: SessionNeed | null` из живой активности участника. `RoomMessage`
  пишет причину через `mailWaitText`.

- [ ] **Шаг 1.** Падающие тесты:
  - `derive`: `need` → `needs-you`; спящая с `need` → `idle`;
  - `need-label`: каждый вид, лимит сегодня, завтра и после сброса, `account`, незнакомая причина;
  - `ParticipantStrip` и `SessionRow`: слово и подсказка;
  - `RoomRow` и `tab-meta`: подсветка при застрявшем участнике, а у архивной комнаты и закрытого участника — нет;
  - `RoomMessage`: «Not picked up yet by S03 (usage limit until 19:27)»;
  - **800×500**: строка сессии с ярлыком в 80 знаков и словом `limit · Oct 14, 19:27` — слово не вылезает (в тесте
    компонента — `truncate`/`min-w-0` у контейнера, как у соседних слов состояния).
- [ ] **Шаг 2.** Реализация. **Шаг 3.** Одиночные тесты; `tsc` desktop.
- [ ] **Шаг 4.** Коммит `feat(desktop): причина «застрял» в метках участника и строки, подсветка комнаты, текст доставки`.

## Задача 7. Окно: уведомления с причиной, свой звук, настройки

Спека: 7.1, 7.2, 7.4, 7.5, 4.5.

**Файлы:**
- `packages/desktop/src/renderer/attention/notify.ts`;
- новый `packages/desktop/src/renderer/attention/chime.ts`;
- `packages/desktop/src/shared/ui-types.ts` — `notifications.finishedSound`;
- `packages/desktop/src/main/ui-store.ts` — разбор и слияние нового поля;
- `packages/desktop/src/renderer/components/settings/SettingsDialog.tsx`;
- `packages/desktop/src/shared/strings.ts`;
- `packages/protocol/src/types.ts` — `NoticeKind` `'limit-return-blocked'`;
- `packages/desktop/e2e/stuck-notify.spec.ts` — новые ожидания.

Тесты — `notify.test.ts`, новый `chime.test.ts`, `ui-store.test.ts`, тест `SettingsDialog`.

**Интерфейсы:**
- `chime.ts`:
  - `export const CHIME_MIN_GAP_MS = 2_000`;
  - `createChime(deps: { now(): number; play(): void }): { ring(): void }` — не чаще раза в `CHIME_MIN_GAP_MS`;
  - `playChimeTone(): void` — WebAudio, один `AudioContext` на окно, `resume()`, если `suspended`. Два синуса,
    880 и 1320 Гц, по 0,12 с; огибающая: атака 0,02 с, спад 0,1 с; громкость 0,2. Ошибка — один `console.warn`,
    без исключения;
  - на каждый `ring()` — `globalThis.__parleyChimes = (… ?? 0) + 1` (E2E читает счётчик).
- `NotifyDeps.chime(): void`. Внутри `send(note, kind: 'action' | 'finished')`:
  - цель видна → ничего;
  - `action` → `notify({ …note, silent: true })` и `chime()`, если `prefs().sound`;
  - `finished` → `notify({ …note, silent: !prefs().finishedSound })`.
- **Действие (`action`):** вход в `needs-you`, письма и упоминания человека, решения (и карточка в окне тоже звенит),
  `launch-failed`, `resume-failed`, `limit-return-blocked`.
- `onActivity`: вход в `needs-you` — таймер `NEED_SETTLE_MS = 1_000`; по нему, если сессия ещё `needs-you`:
  - заголовок прежний (`sessionTitle(…, needsYou)`);
  - текст — `S.need.body(need)` (таблица спеки 7.4; без `need` — прежняя задача сессии) + `· room <имя>` для
    сессии в комнате;
  - клик: `limit` → комната сессии, иначе — сессия;
  - `limit`: тег `limit:<провайдер>`, заголовок `S.need.limitTitle(провайдер)` (`Codex usage limit reached`),
    текст — `S01, S03 wait until 19:27` по всем живым сессиям этого провайдера с `need` `limit`.
- `NOTICE_EVENT`: без `'trust-wait'` (его заменяет `need` `startup`), плюс `'limit-return-blocked'` →
  `S.notifications.limitReturnBlocked` (`limit has reset`).
- Настройки: `notifications: { needsYou; finished; mail; sound; finishedSound }`, по умолчанию `finishedSound:
  false`. Подписи: `sound` — `Sound when you're needed`, `finishedSound` — `Sound when an agent finishes`. В
  `ui.json` без поля — `false`.

- [ ] **Шаг 1.** Падающие тесты:
  - `chime`: два звонка за 1 с — один `play`;
  - `notify` (фальшивые таймеры):
    - `approval` → через 1 с одно уведомление с текстом `Waiting for your approval: ls -la`, `silent: true`,
      `chime` один раз;
    - `needs-you` и обратно за 0,5 с → ничего;
    - цель видна → ни уведомления, ни звука;
    - `finished` → `silent: true` по умолчанию и `false` при `finishedSound`;
    - письмо человеку → `chime`;
    - `trust-wait` → без уведомления;
    - два лимита Codex → один тег, текст с обоими ярлыками;
  - `ui-store`: старый `ui.json` без `finishedSound` → `false`, явный `sound: false` сохраняется;
  - `SettingsDialog`: два переключателя с подписями.
- [ ] **Шаг 2.** Реализация; E2E `stuck-notify.spec.ts` — ожидания `silent: true`, текст причины,
  `__parleyChimes` ≥ 1.
- [ ] **Шаг 3.** Одиночные тесты; `tsc` desktop и protocol.
- [ ] **Шаг 4.** Коммит `feat(desktop): уведомление с причиной и свой звук «нужно действие», finished без звука по умолчанию`.

## Задача 8. Core: поле `stuck`, тексты, MCP, гид

Спека: 5.1–5.4.

**Файлы:**
- `packages/core/src/work/types.ts` — `WorkSession.stuck?: SessionNeed | null`;
- `packages/core/src/work/stuck.ts` — тексты;
- `packages/core/src/work/rooms.ts` — экспорт `parleyNote`;
- `packages/core/src/work/context-pages.ts` — `SessionTopology.stuck`;
- `packages/core/src/mcp/tools.ts` — `finishedState`, `waitFor`, `sendMessage`, описания `wait_for` и
  `send_message`;
- `packages/core/src/work/guide.ts` — тема `stuck`, шаг 1 темы `lead`;
- `packages/core/src/work/brief.ts` — `LEAD_ROLE`, `memberRole`;
- `packages/core/src/work/skill.ts` — правило в «Gate rules».

Тесты — `stuck.test.ts`, `context-pages.test.ts`, тесты MCP (`mcp/server.test.ts` или где тестируются
`wait_for`/`send_message`), `guide.test.ts`, `brief.test.ts`, `skill.test.ts`, `english-text.test.ts`.

**Интерфейсы (тексты — дословно; `@s03` — `sessionMention(id)`):**
- `localClock(iso, now): string` — `19:27` или `Oct 14, 19:27`; `agentClock(iso, now): string` — `19:27 local
  time (UTC+03:00), in 2 h 10 min` (`in 3 d 4 h` дальше суток; смещение пояса — на тот момент).
- `type StuckWho = { id: string; provider: string }` — сессия и её провайдер (из `WorkSession`); первый аргумент
  всех текстов ниже, кроме `backLine`/`backLetter`.
- `stuckLine(who, need, now, isLead: boolean): string` — строка ленты:
  - `approval`: `@s03 is waiting for your approval in its terminal: <detail>` (без `detail` — без двоеточия и хвоста);
  - `question`: `@s03 asked you a question in its terminal`;
  - `limit`: `@s03 hit its <Provider> usage limit; it resets at <localClock>` / `…; the reset time is unknown`;
  - `sign-in`: `@s03 is signed out of <CLI>: <detail>` (`account` — `@s03 has an account problem in <CLI>: <detail>`);
  - `startup`: `@s03 has been waiting in its terminal since launch (sign-in, folder trust or another startup screen)`;
  - `isLead` и вид `limit`/`sign-in` — плюс ` @s03 leads this room: you can make another participant the lead.`
- `backLine(sessionId, kind): string` — `@s03 is back` / `@s03 is back (the usage limit has reset)` / `@s03 is
  back (signed in)`.
- `stuckLetter(who, need, now): string` — письма спеки 5.2 дословно (три вида: `approval`/`question`/`startup`;
  `limit`; `sign-in`), в скобках вид и `detail`: `(approval: npm install)`; время — `agentClock`.
- `backLetter(sessionId, kind): string` — `@s03 is back (the usage limit has reset). Messages that waited are
  being delivered.` (у `sign-in` — `(signed in)`, у `startup` — `(started)`).
- `stuckHint(who, need, now): string` — `@s03 waits for the human (<причина>). Do not wait_for it again: end
  your turn or wait_for("inbox") — Parley writes to you when it is back.`
- `stuckWarning(who, need, now): string` — `@s03 is stuck (<причина>): it reads this when it is back`.
- `<причина>` — `stuckReason(need, now)`: `waiting for approval`, `asked a question`, `usage limit until 19:27
  local time`, `usage limit, reset time unknown`, `signed out`, `account problem`, `waiting at startup`.
- `<Provider>` и `<CLI>`: `codex` → `Codex`, `glm` → `GLM`, иначе `Claude Code`.
- MCP:
  - `finishedState(session)`: `session.stuck` не `null` и итога нет → `'stuck'`;
  - ответ `wait_for` по `stuck`: `{ state: 'stuck', sessionId, stuck, hint }`;
  - `send_message`: адресаты (явные или рассылка комнаты, через `recipientsOf`) со `stuck` → `warning` из
    `stuckWarning`, соединённых `; ` вместе с прежним `unknownParamsWarning`;
  - описание `wait_for` — плюс фраза `{"state":"stuck"} means the session waits for the human or for its usage
    limit: do not wait for it again — Parley writes to you when it is back.`
- `get_map`: `SessionTopology.stuck: SessionNeed | null` (нет поля в карте → `null`).
- Тема гида `stuck` (summary: `a participant waits for the human or its usage limit: what to do and what not to do`),
  текст дословно:

```md
### When a participant is stuck

Parley tells you when a participant cannot go on without the human, and tells you again when it is back. Such a
participant is not "silent". The reason comes in Parley's message and in `stuck` of `get_map`:

- `approval`, `question`, `startup` — the participant waits for the human in its terminal: a permission request,
  a question, a sign-in or folder-trust screen. The human has already been notified. Do not hand its part to anyone
  and do not decide without it: do only what does not depend on it, or end your turn. Do not write `@human` about
  it again.
- `limit`, `sign-in` — the participant hit its usage limit or is signed out. Do not hand its part to anyone on your
  own. If you lead the room, write one message to `@human`: who is out, why, until when, what waits on it, and the
  options — wait for the reset (Parley brings the participant back by itself), give its part to another participant
  (name who), or continue without it. Then wait for the answer and do only what does not depend on the participant.
- If the human gives the part to another participant, tell the stuck one in a message too: it reads it when it is
  back.
- If you are not the lead, do not call the human about it: the lead does.
- `wait_for` on a stuck participant returns `{"state":"stuck"}` at once: do not call it again for that participant;
  end your turn or `wait_for("inbox")`.
```

- Тема `lead`, шаг 1: после «…propose a decision on the positions you have; it can be replaced by a repeated
  call.» добавить `A participant Parley reported as stuck is not silent: see topic \`stuck\`.`
- `LEAD_ROLE` — в конец: ` If Parley reports a participant as stuck, do not hand its part to others on your own:
  follow topic \`stuck\` of \`read_guide\`.`; `memberRole` — в конец: ` If Parley reports a participant as stuck,
  do not call the human about it: the lead does.`
- Заглушка навыка, «Gate rules», после правила про `propose_decision`: `- A participant Parley reports as stuck
  (waiting for the human or for its usage limit) is not silent: do not hand its part to others on your own —
  \`read_guide\` topic \`stuck\`.`

- [ ] **Шаг 1.** Падающие тесты:
  - тексты: каждый вид, без `detail`, `account`, ведущий, неизвестное время;
  - `agentClock`: «in 2 h 10 min», «in 3 d 4 h», смещение пояса;
  - `get_map` со `stuck` и без поля;
  - `wait_for` на сессию со `stuck` → сразу `state: 'stuck'` с `hint`; итог важнее (`result` есть → прежний ответ);
  - `send_message` в комнату с застрявшим → `warning` и письмо записано; с незнакомым полем — оба предупреждения;
  - гид: тема `stuck` в `GUIDE_TOPICS`, ссылка из `lead`; бриф ведущего и участника; заглушка навыка;
    `english-text`.
- [ ] **Шаг 2.** Реализация. **Шаг 3.** Одиночные тесты; `tsc` core.
- [ ] **Шаг 4.** Коммит `feat(core): поле stuck в карте, тексты Parley о застрявшем, wait_for и send_message, тема гида stuck`.

## Задача 9. Хост: служба «застрял»

Спека: 3.5, 4.4, 5.2, 8 (п. 1–3, 7, 8).

**Файлы:** новый `packages/host/src/stuck/stuck-service.ts`, новый `stuck-service.test.ts`;
`packages/host/src/host.ts` — создание после `activityService`, `start`/`stop` рядом с будильником.

**Интерфейсы:**

```ts
export interface StuckServiceOptions {
  reportMs?: number;        // по умолчанию STUCK_REPORT_MS
  now?: () => number;
}
/** Рычаг E2E: PARLEY_STUCK_REPORT_MS (100 мс … 10 мин), по образцу startupWaitFromEnv. */
export function stuckReportFromEnv(env: NodeJS.ProcessEnv): number | undefined;
export function createStuckService(
  host: HostContext,
  works: WorksService,
  activity: ActivityService,
  options?: StuckServiceOptions,
): { start(): void; stop(): void };
```

**Поведение:**
- Эпизод — по ключу сессии: `{ need, reported, timer }`. Новый эпизод — `need` появилась или сменился `since`.
- **Порог:** `limit`, `sign-in`, `startup` → доклад сразу; `approval`, `question` → таймер `reportMs`, по нему — доклад,
  если эпизод тот же.
- **Доклад** (одна `updateMap`):
  1. `session.stuck = need`;
  2. комната сессии (открытая, не архивная) → `addSystemMessage(map, room.id, stuckLine({ id, provider }, need,
     now, isLead))`, где `isLead` — сессия и есть `liveLead` комнаты;
  3. получатели письма — живой ведущий (`liveLead`) и отправители непрочитанных писем к сессии (`unreadFor(map,
     session.id)` → `from`), без самой сессии, `human`, `system`, `parley`, без закрытых и удалённых;
  4. в комнате — `parleyNote(map, room.id, to, stuckLetter(…), at)`; без комнаты — `addMessage(map, { from: PARLEY,
     to: [to], text })` только отправителям; архивная комната — ни строки, ни писем.
- **Смена внутри эпизода** после доклада (например, появился `resetsAt`) → обновить `session.stuck`, писем нет.
- **Конец эпизода:**
  - не докладывали → только снять таймер;
  - сессия живая → `session.stuck = null`, `backLine` в комнату; для `limit`, `sign-in`, `startup` — ещё и
    `backLetter` тем же получателям;
  - сессия спит или закрыта → `session.stuck = null` молча.
- **Сверка после старта** — по первому `onChange` каждой сессии:
  - в карте `stuck` есть, а `need` нет → как конец эпизода;
  - есть оба с тем же `since` → эпизод принят как доложенный, писем нет;
  - `need` есть, а `stuck` нет → новый эпизод.
- Сбой `updateMap` — строка `host.log.error`, без исключения наружу.

- [ ] **Шаг 1.** Падающие тесты (фальшивые таймеры, фальшивые `works`/`activity`, настоящая карта во временном
  каталоге — как в `wake-service.test.ts`):
  - одобрение 90 с → в карте ничего; 130 с → `stuck`, строка, письмо ведущему;
  - **короткие эпизоды не копятся** (фокус 1): три эпизода по 60 с с паузами → ни `stuck`, ни сообщений;
  - лимит → сразу; конец → `backLine` и `backLetter`; одобрение после доклада → только `backLine`;
  - застрял ведущий → письма только отправителям, строка с хвостом про «Make lead»;
  - нет комнаты → письма отправителям без комнаты; архивная комната → `stuck` записан, сообщений нет;
  - **сверка** (фокус 2): карта со `stuck` и та же `need` → ни одного нового сообщения; `stuck` есть, `need` нет у
    живой → «back»; у спящей → молча;
  - `stuckReportFromEnv`: число, мусор, края.
- [ ] **Шаг 2.** Реализация; в `host.ts` — `reportMs: stuckReportFromEnv(process.env)`.
- [ ] **Шаг 3.** Одиночные тесты; `tsc` host.
- [ ] **Шаг 4.** Коммит `feat(host): служба «застрял» — пороги, поле stuck, строка в комнате и письмо ведущему, back, сверка после старта`.

## Задача 10. Будильник: возврат после сброса лимита

Спека: 6.3, 6.4, 8 (п. 4–6, 11).

**Файлы:**
- `packages/core/src/work/delivery.ts` — `limitReturnText`, `isPointerText`;
- новый `packages/host/src/wake/limit-return.ts` — сроки, условия, счётчик;
- `packages/host/src/wake/wake-service.ts`;
- `packages/host/src/host.ts` — рычаги.

Тесты — `delivery.test.ts`, новый `limit-return.test.ts`, `wake-service.test.ts`.

**Интерфейсы:**
- `export const LIMIT_RETURN_TEXT = 'Your usage limit has reset. Read your inbox first, then continue the task the
  limit interrupted.'`
- `limitReturnText(letters, rooms): string` — `LIMIT_RETURN_TEXT`, а если письма есть — через пробел
  `pointerText(letters, rooms)`. `isPointerText` распознаёт и его (иначе автозаголовок взял бы его за реплику
  человека).
- `limit-return.ts`:
  - `export const LIMIT_MENU_TEXT = 'Wait here, then continue automatically'`;
  - `export function limitReturnDue(need: SessionNeed, graceMs: number, retryMs: number): number` — `resetsAt +
    graceMs` или `since + retryMs`;
  - `export type ReturnBlock = 'draft' | 'menu' | 'repeated'`;
  - `export function returnBlock(input: { hasDraft: boolean; screen: readonly string[] | undefined; returns: number
    }): ReturnBlock | null`;
  - `export function limitReturnFromEnv(env): { graceMs?: number; retryMs?: number }` — `PARLEY_LIMIT_RETURN_GRACE_MS`
    и `PARLEY_LIMIT_RETRY_MS`, 100 мс … 1 ч.
- **Будильник:** при пересчёте живой сессии с `need.kind === 'limit'` — один таймер на ключ + `since` на
  `limitReturnDue`. По таймеру:
  - эпизод ещё тот же, процесс жив, активность `unseen`/`idle`, будильник не на паузе (иначе — ждать, повтор на
    следующем пересчёте после `resume()`);
  - `returnBlock` (`hasDraft`, `pty.screenText(ref)`, счётчик) → `notice('limit-return-blocked', ref, …)` с
    причиной: `unsent text in its terminal`, `a menu is open in its terminal`, `it hit the limit again twice`;
  - иначе — `beginAttempt(ref, state, { text: limitReturnText(unread, rooms), letterIds: unread.map(id) },
    codex)`, счётчик +1.
- **Счётчик** — у сессии. Сбрасывается, когда ход кончился без `need` или начался не от будильника.
- Эпизод снят до срока (Claude продолжил сам, человек написал) → таймер снять, ничего не печатать.

- [ ] **Шаг 1.** Падающие тесты:
  - `limitReturnText` с письмами и без; `isPointerText` на нём;
  - `limitReturnDue`, `returnBlock` — все ветки;
  - будильник (фальшивые таймеры):
    - сброс + 2 мин → в PTY текст возврата и Enter;
    - `need` снята раньше — ничего (фокус 3);
    - черновик → уведомление, не печать;
    - на экране `LIMIT_MENU_TEXT` → уведомление;
    - пауза → после `resume()` возврат;
    - третий подряд → уведомление;
    - `resetsAt: null` → через `retryMs`;
  - `limitReturnFromEnv`: края.
- [ ] **Шаг 2.** Реализация. **Шаг 3.** Одиночные тесты; `tsc` core, host.
- [ ] **Шаг 4.** Коммит `feat(host): возврат после сброса лимита — продолжение с указателем, предохранители, уведомление при отказе`.

## Задача 11. E2E: комната с застрявшими участниками

Спека: 9 (E2E), 8.

**Файлы:**
- новый `packages/desktop/e2e/stuck-sessions.spec.ts`;
- `packages/desktop/e2e/stub-codex-agent.mjs` — команда `STUB_LIMIT [текст]`: запись `task_complete` с `error: {
  message, codex_error_info: 'usage_limit_exceeded' }` в rollout треда и заголовок `Ready`.

Рычаги: `PARLEY_STUCK_REPORT_MS=1000`, `PARLEY_LIMIT_RETRY_MS=2000`, `PARLEY_LIMIT_RETURN_GRACE_MS=500`,
`PARLEY_NOTIFICATIONS=log`.

**Сценарии** (работа: ведущий S01 — заглушка Claude, S02 — заглушка Codex, S03 — заглушка Claude; длинные
названия работы, комнаты и ярлыки сессий; окно 800×500):
1. **Одобрение.** `STUB_APPROVAL` в S02 → метка `approval` у участника; уведомление с текстом `Waiting for your
   approval: ls -la`; через рычаг — строка ленты, а в S01 `STUB_MCP check_inbox {}` возвращает письмо Parley,
   `STUB_MCP get_map {}` — `stuck` у `s-02`, `STUB_MCP wait_for {"target":"s-02"}` — `state: "stuck"`.
2. **Лимит без времени.** В S03 `STUB_HOOK {"hook_event_name":"StopFailure","error":"rate_limit","last_assistant_message":"You've hit your session limit"}`
   → метка `limit`; человек пишет в комнату `@s03 …` → под сообщением `Not picked up yet by S03 (usage limit)`;
   через `PARLEY_LIMIT_RETRY_MS` + `PARLEY_LIMIT_RETURN_GRACE_MS` в терминале S03 эхо `Your usage limit has reset.
   Read your inbox first…`; строка ленты `… is back (the usage limit has reset)`.
3. **Лимит Codex.** `STUB_LIMIT` в S02 → метка `limit`; уведомление с тегом лимита Codex.
4. **Вид 800×500.** Метки `limit` и `approval` в полосе участников и строках сайдбара не выходят за правый край
   контейнера (`boundingBox`); прогон и с `--force-device-scale-factor=2`, как у прочих визуальных E2E.

- [ ] **Шаг 1.** Заглушка; тест. **Шаг 2.** `pnpm --filter @parley/desktop build`, прогон файла — при DPR 1 и 2.
- [ ] **Шаг 3.** Коммит `test(desktop): E2E застрявших участников комнаты — одобрение, лимит, возврат, 800×500`.

## Задача 12. Документы

Спека: 11, п. 5.

**Файлы:** `README.md` (по-английски), `CHANGELOG.md`, `TODOS.md`.
- **README:**
  - «Agent state: hooks and liveness» — `need` и пять видов;
  - «Rooms» — строки и письма Parley о застрявшем, `stuck` в `get_map`/`wait_for`;
  - про уведомления — два переключателя звука;
  - возврат после сброса лимита (Claude на подписке продолжает сам).
- **CHANGELOG**, раздел «Unreleased»: Added (причина в уведомлениях, свой звук, письмо ведущему, `stuck` в MCP,
  возврат после лимита), Changed (`finished` без звука по умолчанию, `trust-wait` без отдельного уведомления).
- **TODOS:**
  - раздел 19 — пункт «ожидание сброса лимита подписки: парковать сессии на лимите и поднимать после сброса» снять;
  - раздел 2 — живые проверки: одобрение настоящего Codex в комнате (звук, строка через 2 минуты, ведущий
    ждёт), естественный лимит, собственное ожидание Claude Code на подписке, код и время сброса у GLM (спека 10.1
    п. 4).

- [ ] **Шаг 1.** Правки. **Шаг 2.** `pnpm --filter @parley/desktop exec vitest run src/release-docs.test.ts` — страж
  README и CHANGELOG: обещания документов сверяются со строками окна.
- [ ] **Шаг 3.** Коммит `docs: застрявшие сессии — README, CHANGELOG, TODOS`.
