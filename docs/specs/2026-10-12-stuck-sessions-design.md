# Застрявшие сессии: звук человеку, письмо ведущему, возврат после лимита — дизайн

Дата: 2026-10-12. Статус: согласовано в диалоге по частям (вариант A: состояние «застрял» + письмо
ведущему; «застрял» — всё, что требует явного действия человека; свой звук «нужно действие»,
`finished` без звука; после сброса лимита Parley возвращает сессию сам). Основание: код `origin/master`
ebdb1eb (v0.11.0 + PR #44, #45); формы записей из журналов автора (Claude Code 2.1.296, Codex 0.162);
документация Claude Code — хуки (`StopFailure`, `Notification`) и раздел «Wait for a usage limit to
reset» (`code.claude.com/docs/en/hooks`, `…/interactive-mode`), сверено 2026-10-11.

---

## 1. Зачем

Агент в комнате упирается в то, что может решить только человек, и молча выпадает из работы.

1. **Человек не слышит.** Запрос одобрения у Codex Parley распознаёт: у сессии метка «needs you».
   Но звука нет: со слов автора, метка была, а звука — нет. Уведомление macOS «needs you» несёт в
   тексте задачу сессии, а не то, что нужно, и звучит тем же системным звуком, что «finished».
   А «finished» приходит на конце каждого хода каждого агента.
2. **Ведущий не знает.** Состояния участников через MCP не видны: `get_map` даёт lifecycle и итог,
   но не activity. `wait_for(sNN)` кончается только на итоге, сне или закрытии и по умолчанию ждёт до
   10 минут.
   Гид велит ведущему «do not wait forever: propose a decision on the positions you have»
   (`core/work/guide.ts`, тема `lead`). Поэтому ведущий решает без застрявшего и раздаёт его часть.
3. **Лимит не распознаётся вовсе.** Проценты лимитов Parley читает по провайдеру для строки статуса
   (`core/limits.ts`, `host/limits/limits-service.ts`). Что лимит кончился у конкретной сессии, никто
   не замечает. Последствия:
   - ход, оборванный лимитом, выглядит как законченный (`unseen`), и человеку приходит «finished»;
   - будильник вбивает в такую сессию указатели на письма, и каждый снова упирается в лимит;
   - у Claude Code на подписке это ещё и отменяет его собственное ожидание сброса: с версии 2.1.234
     он ждёт сброса и продолжает сам, а введённый промпт это ожидание отменяет.

Формы записей (проверено на журналах автора):

| Что | Claude Code и GLM | Codex |
|---|---|---|
| Лимит | запись ассистента `isApiErrorMessage: true`, `error: "rate_limit"`, `apiErrorStatus: 429`, текст «You've hit your session limit · resets 2:50pm (Europe/Moscow)», «You've hit your weekly limit · resets Sep 22 at 4pm (Europe/Moscow)»; хук `StopFailure` с `error: "rate_limit"` | `event_msg` `task_complete` с `error: { codex_error_info: "usage_limit_exceeded", message: "You've hit your usage limit. … try again at 7:27 PM." }` |
| Вход и аккаунт | `error`: `authentication_failed` («Not logged in · Please run /login», «token expired»), `account_on_hold`, `billing_error`, `oauth_org_not_allowed` | `task_complete` с `error.codex_error_info: "unauthorized"` и текстом вроде «Your access token could not be refreshed… Please log out and sign in again.» (10.1) |
| Одобрение | хук `PermissionRequest`; `Notification` `permission_prompt` | OSC 9 «Approval requested: …», «Codex wants to edit …»; заголовок `[ ! ] Action Required` (`host/pty/codex-terminal.ts`) |

## 2. Решения

1. **«Застрял» — всё, что требует явного действия человека.** Пять видов: `approval` (одобрение),
   `question` (вопрос агента в терминале), `limit` (лимит подписки или провайдера), `sign-in` (слетел
   вход или проблема аккаунта), `startup` (экран при старте: вход, доверие к папке и прочее).
2. **Человек узнаёт сразу.** Уведомление с причиной вместо задачи сессии. Свой отдельный звук «нужно
   действие» играет само окно, независимо от звука уведомлений macOS, в том числе когда окно в фокусе.
   «Finished» по умолчанию без звука.
3. **Ведущий узнаёт из комнаты.** Системная строка в ленте (её видит человек) и письмо Parley
   ведущему и тем, кто ждёт ответа застрявшего. Для `limit`, `sign-in` и `startup` — сразу; для
   `approval` и `question` — если ожидание длится дольше 2 минут.
4. **Ведущий не раздаёт работу застрявшего.** При `approval`, `question`, `startup` он ждёт: человек
   уже знает. При `limit` и `sign-in` он пишет человеку `@human` с вариантами и ждёт ответа.
5. **Состояние видно в MCP.** `get_map` — поле `stuck` у сессии; `wait_for(sNN)` кончается на
   `stuck`; `send_message` застрявшему — с предупреждением.
6. **Во время лимита письма ждут, после сброса Parley возвращает сессию.** Claude Code на подписке
   продолжает сам, и Parley ему не мешает. Остальным (Codex, GLM, Claude без своего ожидания) Parley
   после сброса печатает просьбу продолжить и указатель на письма.
7. **Слетевший вход:** письма ждут, автопродолжения нет — человек и так у терминала.
8. **Отвергнуто:** «только по запросу» (состояние в MCP без писем) — ведущий, закончивший ход в
   ожидании почты, ничего не узнает; «только человеку» — ведущий остаётся слепым, всё держится на
   пересказе человека.

## 3. Модель: потребность сессии (core)

### 3.1 Тип

```ts
// core/work/activity.ts
export type NeedKind = 'approval' | 'question' | 'limit' | 'sign-in' | 'startup';

export interface SessionNeed {
  kind: NeedKind;
  /** Начало эпизода (ISO). */
  since: string;
  /** Команда, файл, текст вопроса или ошибки — до 200 знаков; null — нечего показать. */
  detail: string | null;
  /** Только `limit`: время сброса (ISO); null — неизвестно (3.4). */
  resetsAt: string | null;
  /** Только `limit`: окно, если известно из текста или данных провайдера. */
  window: 'session' | 'week' | null;
  /** Только `sign-in`: `account` — аккаунт или оплата (on hold, billing), `auth` — вход. */
  account: 'auth' | 'account' | null;
}

export interface SessionActivity {
  // …прежние поля…
  /** Чего сессия ждёт от человека; null — ничего. */
  need: SessionNeed | null;
}
```

`activity` своих значений не меняет. `approval` и `question` дают `blocked`, как сейчас. `startup` —
тоже `blocked`: у Codex так уже есть (`startupExpired`), у Claude и GLM это новое (сейчас их
`trust-wait` оставляет сессию `idle`). `limit` и `sign-in` оставляют ход законченным (`unseen` или
`idle`): процесс стоит у приглашения, и старый код, который смотрит на `blocked` (очередь Codex, таймер
тишины), их не касается. Окно и доставка читают новое поле `need`. Протокол меняется только
добавлением: `activity.changed` несёт `SessionActivity` из core (`protocol/events.ts`).

`need` бывает только у живой сессии (`lifecycle: 'active'`). У спящей и закрытой — `null`: процесса
нет, ждать человека в терминале некому (что эпизод при этом кончается — 6.3).

### 3.2 Источники

Claude Code и GLM (GLM — тот же `claude` с базой Z.ai):

| Вид | Источник | `detail` |
|---|---|---|
| `approval` | хук `PermissionRequest`; `Notification` с `permission_prompt` | `tool_input.command` у Bash, `tool_input.file_path` у правок, иначе `tool_name`; у `Notification` — `message` |
| `question` | `Notification` с `agent_needs_input`, `elicitation_dialog`, `elicitation_url_dialog`; удержанный AskUserQuestion (`questionHeld` службы ленты) | текст первого вопроса AskUserQuestion |
| `limit` | хук `StopFailure` с `error: "rate_limit"`; запасной путь — запись журнала `isApiErrorMessage: true` с `error: "rate_limit"` | `last_assistant_message` хука или текст записи |
| `sign-in` | то же с `error` `authentication_failed`, `oauth_org_not_allowed` (`auth`); `account_on_hold`, `billing_error` (`account`) | текст ошибки |
| `startup` | процесс запущен хостом, а за 20 с не пришло ни одного хука (сейчас так ловится только `trust-wait` у сессий в worktree, `host/activity/activity-service.ts#maybeTrustWait`) | — |

Запасной путь через журнал нужен сессиям, запущенным до этой версии: их `--settings` ещё без
`StopFailure`. Финальная ошибка API заканчивает ход: свёртка (`activityOf`) считает ход оконченным
на такой записи, а не через 30 с тишины. Ретраи (`system/api_error` с `retryInMs`) ход не кончают и
`need` не дают.

Codex:

| Вид | Источник | `detail` |
|---|---|---|
| `approval` | OSC 9 «Approval requested: <команда>», «Codex wants to edit <файл>» | хвост строки |
| `question` | заголовок `Action Required` без OSC 9 об одобрении в этом эпизоде | — |
| `limit` | rollout `task_complete` с `error.codex_error_info: "usage_limit_exceeded"` | `error.message` |
| `sign-in` | rollout `task_complete` с `error.codex_error_info: "unauthorized"` → `auth` (своего кода «аккаунт» у Codex нет, 10.1) | `error.message` |
| `startup` | существующий срок `startup-wait`: 20 с без `Ready` и `Working` (`startupExpired`) | — |

`rate_limit_exceeded` у Codex (короткий 429 с повтором) `need` не даёт: Codex повторяет сам.

**Конкретнее — сильнее.** Внутри эпизода более точный вид не заменяется менее точным: у Codex OSC 9
об одобрении и заголовок `Action Required` приходят вместе, и `approval` не превращается в `question`.
Заголовок без OSC 9 сразу даёт `question`, а OSC 9 об одобрении, пришедшее следом, повышает вид до
`approval` (`since` прежний). Чтобы человек не получил «Asked you a question» на обычное одобрение,
окно шлёт уведомление «нужно действие» через 1 с после входа сессии в `needs-you` (`NEED_SETTLE_MS`) — с
последним `need`; ушла из `needs-you` за эту секунду — уведомления нет (7.1).

### 3.3 Когда снимается

- `approval`, `question`, `startup` — как `blocked` сейчас: новый промпт, более свежая запись
  человека в журнале, сигнал работы терминала, ответ на форму (`elicitation_complete`).
- `limit`, `sign-in` — с началом нового хода: `UserPromptSubmit`, `Notification`
  `quota_auto_resume_fired` (Claude продолжил сам), `task_started` у Codex, более свежая запись
  человека в журнале. `sign-in` снимает ещё и `Notification` `auth_success`.
- Любой вид — когда сессия уснула или закрылась (3.1).

После сброса лимита `need` не снимается по часам: его снимает начало хода, а начать ход после
сброса помогает возврат (6.3). Момент сброса окно отмечает само, по `resetsAt` и своим часам: метка
меняется с «limit · 19:27» на «limit · reset» (7.3). Хосту для этого пересчитывать нечего.

### 3.4 Время сброса

Порядок:
1. **Данные провайдера** — из службы лимитов хоста (`LimitsService.get(провайдер)`, `host/limits/`):
   у Claude это строки статуса сессий, у Codex — `token_count` свежих rollout, у GLM — квота Z.ai.
   Берётся окно, названное текстом («session limit» → `fiveHour`, «weekly limit» → `week`), а без
   слова — окно с `usedPercent` ≥ 100 (оба — более позднее), если его сброс в будущем. У GLM при
   ударе без такого окна служба лимитов один раз за эпизод перечитывает квоту (`refresh(true)`).
   Данные провайдера новее удара, и все окна ниже 100 % — лимит уже сброшен: `resetsAt` — сейчас.
2. **Текст ошибки:**
   - Claude: «resets 2:50pm (Europe/Moscow)», «resets 7pm (Europe/Moscow)», «resets Sep 22 at 4pm
     (Europe/Moscow)». Пояс — из скобок; время без даты — ближайшее после записи;
   - Codex: «try again at 7:27 PM» (тот же день) или «try again at Oct 14th, 2026 7:27 PM» (другой
     день, суффикс `st`/`nd`/`rd`/`th`) — пояс машины хоста; время без даты — ближайшее после записи
     (10.1);
   - GLM: если в тексте ответа Z.ai есть время сброса — оно; формат не подтверждён, опора — квота
     (п. 1).
3. Иначе `null`.

Разбор — чистые функции в core с тестами-инвариантами по диапазону (полночь, переход на летнее
время, дата в следующем году). Непонятный текст даёт `null`, а не ошибку.

### 3.5 Эпизод и пороги

Эпизод — от появления `need` до его снятия. Смена вида внутри эпизода (например, `question` →
`approval`) эпизод не открывает заново.

| Кому | `approval`, `question` | `limit`, `sign-in`, `startup` |
|---|---|---|
| Человеку (уведомление, звук, метка) | сразу | сразу |
| Карта, строка в комнате, письмо ведущему | через 2 мин (`STUCK_REPORT_MS = 120_000`), если эпизод ещё идёт | сразу (`startup` — по своему сроку 20 с) |

## 4. Хост

### 4.1 Журнал событий

- `HOOK_EVENTS` (`core/work/settings-file.ts`) получает `StopFailure`. Действует для новых запусков
  и подъёмов: `--settings` собирается при каждом запуске.
- `EventRecord` (`core/work/events.ts`) берёт из stdin хука `error`, `error_details`,
  `last_assistant_message`, `message`, `tool_name` и короткую выжимку `tool_input` (команда или путь
  файла, до 200 знаков).

### 4.2 Индексы журналов

- `core/session-index.ts` (Claude): `lastApiError: { at, error, status, text } | null` — самая
  свежая запись ассистента с `isApiErrorMessage: true`, если она новее последней записи человека.
- `core/codex/index-session.ts`: у `task_complete` — `error: { info, message } | null`.

### 4.3 `activity-service`

- `eventNameOf` больше не сплющивает сигналы Codex в `PermissionRequest`: причина
  (`approval-requested` или `action-required`) доходит до свёртки и даёт `approval` или `question`.
- `startup` для Claude и GLM — по сроку, как `trust-wait`, но для всех сессий, запущенных хостом.
  Уведомление `trust-wait` остаётся как есть.
- Удержанный вопрос AskUserQuestion: `questionHeld(ref, held)` службы ленты передаёт и текст
  первого вопроса — из него `detail` вида `question`.
- `need` у спящей и закрытой сессии — `null` (3.1).

### 4.4 Служба «застрял» (новая, `host/src/stuck/stuck-service.ts`)

Слушает `activity.onChange` и ведёт эпизоды:
- **пороги** (3.5): таймер на 2 минуты у `approval` и `question`;
- **карта**: записывает и снимает `session.stuck` (5.1) через `updateMap`;
- **комната**: строка в ленте и письма Parley (5.2);
- **возврат после лимита** — вместе с будильником (6.3);
- **сверка после старта хоста**: эпизоды заново выводятся из журналов. Есть `stuck` в карте, а
  `need` нет: сессия жива → снять и написать «back»; спит или закрыта → снять молча (6.3). Есть оба →
  оставить без повторных писем (сверка по `since`). Есть `need`, а `stuck` нет → по порогам, как новый
  эпизод.

### 4.5 Уведомления хоста

Новый вид `HostNotice` — `limit-return-blocked`: «лимит сброшен, но Parley не смог продолжить»
(6.3). Остальные виды не меняются.

## 5. Карта, комната, MCP, гид (core)

### 5.1 Поле карты

`WorkSession.stuck?: { kind, since, detail, resetsAt, window, account } | null` — та же форма, что
`SessionNeed`. Пишет только хост и только при пороге (3.5). Поле необязательное, как `model` и
`effort`: нет поля — то же, что `null`, миграции карты не нужно.

### 5.2 Строка в комнате и письма Parley

По образцу смены ведущего (`setRoomLead`, `core/work/rooms.ts`): строка `addSystemMessage` — для
человека, письмо Parley (`from: parley`, вид `note`, в комнате сессии) — агентам.

**Кому письмо:** ведущему комнаты (`liveLead`) и отправителям непрочитанных писем к застрявшему.
Самому застрявшему, человеку и системе — нет. Застрял сам ведущий — письмо только тем, кто ждёт его
ответа. Сессия не в комнате — письмо без комнаты тем, кто ждёт её ответа, как «did not resume»
(`wake-service.ts#resumeFailed`). Архивная комната строк и писем не получает. В лимиты сообщений
агентов (`assertMessageBudget`) эти письма не идут.

**Строки ленты** (время — местное время машины, `HH:mm`, дата — если не сегодня):

| Вид | Строка |
|---|---|
| `approval` | `@s03 is waiting for your approval in its terminal: npm install` |
| `question` | `@s03 asked you a question in its terminal` |
| `limit` | `@s03 hit its Codex usage limit; it resets at 19:27` / `…; the reset time is unknown` |
| `sign-in` | `@s03 is signed out of Claude Code: Not logged in · Please run /login` |
| `startup` | `@s03 has been waiting in its terminal since launch (sign-in, folder trust or another startup screen)` |
| снято | `@s03 is back` / `@s03 is back (the usage limit has reset)` / `@s03 is back (signed in)` |

Застрял ведущий, вид `limit` или `sign-in` — к строке добавляется
`@s03 leads this room: you can make another participant the lead.`

**Письма** — только на вход в эпизод, а для `limit`, `sign-in`, `startup` ещё и «back». Для
`approval` и `question` выход виден строкой ленты, а ответ участника придёт сам. Время для агентов —
местное с поясом и через сколько: `19:27 local time (UTC+03:00), in 2 h 10 min`.

- `approval`, `question`, `startup`:
  `@s03 is waiting for the human in its terminal (approval: npm install) since 14:02. It cannot read
  messages until the human acts; the human has been notified. Do not hand its part to anyone and do
  not decide without it: do only what does not depend on it, or end your turn. Its reply comes as
  usual once it continues (read_guide topic: stuck).`
- `limit`:
  `@s03 hit its Codex usage limit; it resets at 19:27 local time (UTC+03:00), in 2 h 10 min.
  Messages to @s03 wait; after the reset Parley delivers them and asks @s03 to continue. Do not hand
  its part to anyone on your own. If you lead this room, write one message to @human: who is out,
  until when, what waits on it, and the options — wait for the reset, give its part to another
  participant (name who), or continue without it. Then wait for the answer (read_guide topic: stuck).`
- `sign-in`:
  `@s03 is signed out of Claude Code (Not logged in · Please run /login) and cannot work until the
  human signs in. Messages to @s03 wait. Do not hand its part to anyone on your own. If you lead this
  room, tell @human what waits on @s03 and ask whether to wait or give its part to another
  participant; then wait for the answer (read_guide topic: stuck).`
- back:
  `@s03 is back (the usage limit has reset). Messages that waited are being delivered.`

Тексты — в `core/work/stuck.ts` вместе с разбором (3.2–3.4), английские, под тестами
`english-text.test.ts`.

### 5.3 Инструменты MCP

- `get_map`: у сессии (`SessionTopology`, `core/work/context-pages.ts`) — `stuck` из карты.
- `wait_for(sNN)`: `finishedState` (`core/mcp/tools.ts`) кончается и на `stuck`. Ответ:
  `{ "state": "stuck", "stuck": { … }, "hint": "…" }`, где `hint`: `@s03 waits for the human (usage
  limit until 19:27 local time). Do not wait_for it again: end your turn or wait_for("inbox") —
  Parley writes to you when it is back.` Описание инструмента говорит то же.
- `send_message`: письмо уходит как обычно. Если адресат (явный или по рассылке комнаты) застрял, в
  ответе — `warning`: `@s03 is stuck (usage limit until 19:27 local time): it reads this when it is
  back`. Несколько предупреждений соединяются `; ` — с прежним о незнакомых полях тоже.
- `check_inbox`: письма Parley приходят как обычные.

### 5.4 Гид

- Новая тема `stuck` («When a participant is stuck») в `core/work/guide.ts`:
  - Parley пишет, когда участник ждёт человека, и пишет «back», когда тот вернулся. Такой участник
    не «молчит»;
  - `approval`, `question`, `startup`: человек уже знает. Не отдавать часть застрявшего, не решать
    без него; делать то, что от него не зависит, или закончить ход. `@human` не повторять;
  - `limit`, `sign-in`: ничего не перераспределять самому. Ведущий пишет одно сообщение `@human`:
    кто, почему, до какого времени, что от него зависит, варианты (ждать сброса; отдать часть
    конкретному участнику; продолжать без него). Потом ждёт ответа и делает только независимое;
  - человек решил отдать часть — ведущий пишет об этом и застрявшему: тот прочтёт по возвращении;
  - не ведущий человека не зовёт — это делает ведущий;
  - `wait_for` на застрявшего не повторять.
- Тема `lead`, шаг 1: «If someone stays silent for long…» уточняется: участник, о котором Parley
  написал «stuck», не молчит — для него тема `stuck`.
- Роль ведущего (`LEAD_ROLE`, `core/work/brief.ts`) и заглушка навыка `parley` (`core/work/skill.ts`)
  получают по строке со ссылкой на тему `stuck`.

## 6. Письма во время эпизода и возврат после сброса (хост)

### 6.1 Удержание

`deliveryAction` (`core/work/delivery.ts`) получает `need` сессии. Есть `need` — `{ kind: 'none',
reason: 'stuck' }` раньше проверки занятости. Новое значение `MailWait` — `stuck`. Окно пишет под
сообщением причину из `need` участника (7.3), например «Not picked up yet by S03 (usage limit until
19:27)».

### 6.2 Отметка — у сессии, а не у аккаунта

Лимит отмечается у той сессии, что в него упёрлась. Другие сессии того же аккаунта отметятся сами
на своём ходу: у них может быть другая модель с другим лимитом (у Claude Code — отдельные недельные
лимиты Opus и Sonnet).

### 6.3 Возврат после сброса лимита

- **Claude Code на подписке**, сброс ближе 24 ч: CLI ждёт сам и продолжает в момент сброса. Parley в
  эпизоде ничего не печатает (письма удержаны). Начало хода снимает `need`, служба пишет «back»,
  письма доставляются после этого хода как обычно.
- **Остальные** (Codex; GLM — ключ API, своего ожидания у Claude Code нет; Claude без своего
  ожидания — недельный лимит дальше 24 ч, выключенный `autoContinueAtUsageLimit`):
  - срок: `resetsAt` + 2 мин (`LIMIT_RETURN_GRACE_MS`); при `resetsAt: null` — 15 мин после удара
    (`LIMIT_RETRY_MS`). Запас в 2 минуты нужен, чтобы не столкнуться с Claude, который продолжает
    сам: если ход за это время начался, печатать нечего;
  - условия: эпизод `limit` ещё идёт, процесс жив, сессия у приглашения, черновика нет
    (`pty.hasDraft`), будильник не на паузе, на экране нет меню или диалога (6.4);
  - печать — тем же путём, что указатель (`type-pointer`): `Your usage limit has reset. Read your
    inbox first, then continue the task the limit interrupted.` и, если письма ждут, текст указателя
    (`pointerText`). «Read your inbox first» — защита: если человек отдал часть другому, ведущий уже
    написал об этом;
  - не больше двух автовозвратов подряд. Возврат начинает ход, эпизод кончается («back»); если ход
    снова упёрся в лимит — это новый эпизод, но счётчик возвратов живёт у сессии и сбрасывается
    только ходом без ошибки лимита или промптом человека. После двух подряд — не печатать, а слать
    человеку `limit-return-blocked`;
  - не вышло по условиям (черновик, меню) — уведомление `limit-return-blocked` с причиной, эпизод
    остаётся;
  - время сброса неизвестно, а данные провайдера показывают, что окно снова свободно (`used` < 100 %
    со временем новее удара), — возврат сразу, не дожидаясь 15 минут.
- **Сессия уснула посреди эпизода** (процесс вышел: человек остановил её, сбой, перезапуск): эпизод
  кончается без «back» — `stuck` в карте снимается молча, она ведь не вернулась. Спящую Parley сам не
  поднимает: её мог остановить человек. Письма поднимут её обычным путём (подъём и его лимиты в час —
  как сейчас); упрётся в ещё не сброшенный лимит — откроется новый эпизод с новым письмом ведущему.

### 6.4 Меню на экране

Перед печатью возврата хост смотрит экран сессии (`host/pty/screen.ts`). Видна строка меню лимита
Claude Code «Wait here, then continue automatically» (в 2.1.296 — с хвостами « at …», « shortly»,
« when the limit resets», 10.1) — не печатать, а слать человеку `limit-return-blocked` с причиной
«a menu is open in its terminal». Строку «Don't continue automatically» как признак не берём: в
бинаре 2.1.296 её нет простым текстом.

### 6.5 Вход

`sign-in`: письма удержаны. Снимает эпизод начало хода (человек вошёл и написал) или `Notification`
`auth_success` у Claude; после этого письма доставляются как обычно. Автопродолжения нет.

## 7. Окно

### 7.1 Уведомления (`renderer/attention/notify.ts`)

- Заголовок прежний — `S.notifications.sessionTitle(работа, сессия, 'needs you')`. Текст — причина
  (7.4), а не задача сессии. Сессия в комнате — в конце `· room <имя>`.
- Уровень внимания `needs-you` даёт и `need`, а не только `blocked` (`attention/derive.ts`).
- Уведомление «нужно действие» уходит через `NEED_SETTLE_MS` = 1 с после входа в `needs-you`, с
  последним `need`; вышла из `needs-you` раньше — уведомления нет (3.2).
- Клик: `limit` → комната сессии (решение принимается там), без комнаты — терминал; остальные виды →
  терминал сессии (действовать там).
- Лимит у нескольких сессий одного провайдера — одно уведомление на провайдера (тег
  `limit:<провайдер>`, следующее заменяет прежнее): заголовок `Codex usage limit reached`, текст
  `S01, S03 wait until 19:27`.
- `trust-wait` и `startup-wait` больше не дают своих уведомлений macOS: их заменяет уведомление
  `need` вида `startup` (иначе два уведомления на один экран).
- `limit-return-blocked` — уведомление с тем же звуком.
- Повторных напоминаний нет.

### 7.2 Звук

- **«Нужно действие»** — свой короткий сигнал (два тона, ~0,35 с, WebAudio, без файла:
  `renderer/attention/chime.ts`). Играет окно, поэтому звук не зависит от настройки «Play sound for
  notifications» у Parley в macOS. Поводы: `need` любого вида, `limit-return-blocked`, ждущее решение
  комнаты, `@human` и письма человеку. Баннер macOS при этом идёт с `silent: true`, чтобы звук не
  был двойным. Не чаще раза в 2 с: пачка событий — один сигнал.
- **«Finished»** — баннер с системным звуком, только если включено «Sound when an agent finishes»
  (по умолчанию выключено).
- **Когда молчит**: терминал этой сессии виден в окне в фокусе — нет ни баннера, ни звука, как
  сейчас (`isTargetVisible`). Окно в фокусе, но открыто другое — звук есть.

### 7.3 Метки

- Слово причины вместо общего «needs you» — у участника в полосе комнаты
  (`components/rooms/ParticipantStrip.tsx`) и в строке сессии (`sidebar/SessionRow.tsx`, через
  `lib/dot-state.ts`): `approval`, `question`, `limit · 19:27` (после сброса — `limit · reset`),
  `signed out` (`auth`) или `account` (`account`), `startup`. В подсказке — `detail`.
- Комната в сайдбаре (`sidebar/RoomRow.tsx`) и её вкладка (`layout/tab-meta.ts`) подсвечиваются,
  если у любого участника есть `need`. Сейчас — только при ждущем решении.
- «Next session that needs you» (`attention/next.ts`) обходит и сессии с `need` — через уровень
  внимания.
- Строка доставки (`components/rooms/feed-model.ts`): у `MailWait` `stuck` текст берётся из `need`
  участника: `waiting for your approval`, `asked you a question`, `usage limit until 19:27`,
  `signed out`, `waiting at startup`. Незнакомая окну причина — общий текст `waiting`, а не пусто.

### 7.4 Тексты уведомлений

| Вид | Текст |
|---|---|
| `approval` | `Waiting for your approval: npm install` / `Waiting for your approval in its terminal` |
| `question` | `Asked you a question: <вопрос>` / `Asked you a question in its terminal` |
| `limit` | `Codex usage limit reached · resets 19:27` / `… · reset time unknown` |
| `sign-in` | `Signed out · Not logged in · Please run /login` / `Account problem · <текст>` |
| `startup` | `Waiting at startup: sign in or trust the folder in its terminal` |
| `limit-return-blocked` | `The limit has reset, but S03 could not continue: a menu is open in its terminal` (также `unsent text in its terminal`, `it hit the limit again twice`) |

### 7.5 Настройки

Settings → Notifications (`components/settings/SettingsDialog.tsx`): прежний ключ `sound`
(`shared/ui-types.ts`) теперь значит «Sound when you're needed» (по умолчанию включён). Новый ключ
`finishedSound` — «Sound when an agent finishes», по умолчанию выключен. Переноса не нужно: кто
выключил `sound`, у того оба выключены; у остальных звук «нужно действие» есть, у «finished» — нет.

## 8. Граничные случаи

1. **Короткие одобрения** (меньше 2 минут) — только уведомление человеку; карта, лента и ведущий не
   трогаются.
2. **Застрял ведущий** — человек получает уведомление, строка в ленте подсказывает «Make lead»,
   письма — только тем, кто ждёт его ответа.
3. **Перезапуск хоста посреди эпизода** — сверка (4.4): без повторных писем, «back» только если
   эпизод на самом деле кончился.
4. **Человек сам написал в застрявшую сессию** — начался ход, эпизод снят, «back».
5. **Человек отдал часть другому, а застрявший вернулся** — просьба продолжить начинается с «Read
   your inbox first», письмо ведущего о передаче он прочтёт первым.
6. **Лимит повторяется** (время сброса неверное, короткий 429 по ключу API) — не больше двух
   автовозвратов подряд, потом уведомление человеку.
7. **Сессия уснула, закрыта или удалена** — эпизод снимается без писем; `stuck` в карте — `null`
   (6.3).
8. **Архивная комната** — строк и писем нет (запись в архивную отказывает); уведомление человеку
   остаётся.
9. **`wait_for` по кругу** — сразу возвращает `stuck`; тема `stuck` и подсказка ответа велят его не
   повторять. Отдельного запрета нет: повтор дешёвый.
10. **Новое окно со старым хостом** (хост не перезапущен после обновления) — в activity нет `need`:
    окно считает его `null` и показывает всё как раньше; `MailWait` `stuck` старый хост не шлёт.
    Обратного сочетания (старое окно, новый хост) не бывает: хост запускается из того же бандла.
    Незнакомую причину `MailWait` новое окно показывает общим текстом — на будущее.
11. **Неразобранное время сброса** — `resetsAt: null`, возврат через 15 минут.
12. **Сессия без хуков** (`hooksMissing`, хуки выключены у человека) — `startup` по сроку — ложная
    тревога стоит одного взгляда в терминал; письма и так ждут (`no-hooks`).

## 9. Тесты

- **core**: разбор ошибок Claude и Codex → вид и `detail`; время сброса по тексту с поясом —
  инвариантами по диапазону (полночь, переход на летнее время, смена года); `activityOf` с `need` для
  каждого вида, снятие, «конкретнее — сильнее»; `deliveryAction` → `stuck`; карта без поля `stuck`;
  `get_map`, `wait_for`, `send_message` с застрявшим; тексты строк и писем; тема `stuck`.
- **host**: `activity-service` — `StopFailure`, запасной путь через журнал, сигналы Codex с причиной,
  `startup` у Claude; `stuck-service` — пороги, карта, строки и письма, «back», сверка после
  перезапуска; будильник — удержание, возврат после сброса, запас 2 минуты, два автовозврата, пауза,
  черновик, меню на экране, спящая сессия.
- **desktop**: `notify` — тексты, клик, одно уведомление на провайдера, видимость, звук и
  `silent`; `chime`; `derive`; метки; строка доставки; настройки.
- **E2E** (заглушки агентов, рычаги часов): комната из ведущего и двух агентов — одобрение дольше
  порога (журнал уведомлений, строка, письмо ведущему), лимит со сбросом через минуту (удержание
  писем, строка «back», текст возврата в терминале заглушки). Окно 800×500 с длинными именами
  работы, комнаты и сессий, при DPR 1 и 2.

## 10. Этап 0 — пробы до кода

1. **Пропавший звук у Codex.** Dev-окно, заглушка Codex шлёт OSC 9 «Approval requested», журнал
   уведомлений (`PARLEY_NOTIFICATIONS=log`). Ответ: звало ли окно `notify` и не съело ли его
   `isTargetVisible`. Звало — причина в macOS (Focus, звук уведомлений Parley), её закрывает свой звук.
2. **Codex 0.162 по исходникам:** все значения `codex_error_info` в `task_complete.error` (вход,
   аккаунт), формат «try again at …» с датой, заголовок при вопросе агента и при одобрении.
3. **Свой звук:** WebAudio в окне без фокуса и в свёрнутом окне без жеста пользователя
   (`autoplayPolicy` Electron).
4. **GLM:** какой `error` пишет Claude Code на 429 Z.ai (ожидаем `rate_limit`) и есть ли в тексте
   время сброса; иначе — квота Z.ai.
5. **Claude Code:** точные строки меню лимита (`/rate-limit-options`) и строк ожидания — для 6.4.

Итоги этапа 0 правят эту спеку до плана.

### 10.1 Итоги этапа 0 (2026-10-12, без установки зависимостей)

1. **Пропавший звук у Codex — не закрыт.** Журнал доставленных уведомлений macOS
   (`group.com.apple.usernoted/db2`) без Full Disk Access не читается. Проба в dev-окне с заглушкой
   Codex и `PARLEY_NOTIFICATIONS=log` — первая задача плана: зависимости в worktree ставятся только
   после одобрения плана. Настройки у автора: `notifications` в `ui.json` — все `true`, звук
   включён. Проба 2026-10-12 (задача 0): E2E `packages/desktop/e2e/stuck-notify.spec.ts` (заглушка
   Codex в комнате, `STUB_APPROVAL`, вкладка терминала Codex не открыта; `focus` в тесте — событие
   DOM, не фокус ОС) находит в журнале ровно одну запись `… · S02 codex — needs you` с
   `silent: false`: окно уведомление шлёт, `isTargetVisible` его не съедает. Что сигнал доходит до
   окна и на живом Codex, видно по метке «нужен ты» (автор 2026-10-11: «метка есть, звука нет»).
   В режиме `PARLEY_NOTIFICATIONS=log` настоящего уведомления macOS нет (`main/index.ts` пишет
   запись журнала вместо `Notification`), поэтому показ и звук баннера проба не проверяла: тишина —
   в этом последнем звене (настройки уведомлений macOS, Focus, показ уведомлений Electron). Его
   закрывает свой сигнал, который играет окно (задача 7); живая приёмка проверит это заново.
2. **Codex** (бинарь 0.162 и `codex-rs/protocol/src/protocol.rs`):
   - `task_complete` несёт `error: { message, codex_error_info }` (`ErrorEvent`); в rollout
     `codex_error_info` — строка snake_case, например `"usage_limit_exceeded"`;
   - значения `CodexErrorInfo`: `context_window_exceeded`, `session_budget_exceeded`,
     `usage_limit_exceeded`, `rate_limit_exceeded`, `flex_unavailable`, `server_overloaded`,
     `cyber_policy`, `bio_policy`, `misalignment_policy_violation`, `too_many_denials`,
     `internal_server_error`, `unauthorized`, `bad_request`, `invalid_prompt`, `sandbox_error`,
     `other` и варианты с полями (`http_connection_failed` и др.). `need` дают только
     `usage_limit_exceeded` (`limit`) и `unauthorized` (`sign-in`, `auth`);
   - формат времени: `%-I:%M %p` в тот же день, `%b %-d<st|nd|rd|th>, %Y %-I:%M %p` в другой; есть
     и вариант текста «You've hit your usage limit for …».
3. **Свой звук:** Electron 44.4.5, окно Parley `autoplayPolicy` не задаёт — по документации Electron
   умолчание `no-user-gesture-required`, WebAudio играет без жеста пользователя. Проверка в окне без
   фокуса и в свёрнутом — в той же первой задаче плана. Проба 2026-10-12 (задача 0): `AudioContext`
   оставался `running` (и после `resume()`) в трёх проверенных состояниях — окно показано без
   фокуса, после `BrowserWindow.hide()`, окно свёрнуто. `hide()` проверен в E2E и одноразовым
   запуском Electron 44.4.5 вне Playwright, остальные два состояния — только им; скрипт в
   репозитории не хранится. У свёрнутого окна `visibilityState` — `hidden`, после `hide()` остаётся
   `visible`. `context.resume()` перед звуком (задача 7) остаётся страховкой.
4. **GLM:** по сторонним разборам код Z.ai 1308 — лимит пяти часов, 1310 — недели или месяца; точный
   текст и поле времени сброса не подтверждены. Время сброса — из квоты Z.ai (3.4, п. 1), разбор
   текста — только если формат подтвердится на живом ответе.
5. **Claude Code 2.1.296** (строки бинаря): «Usage limit reached», «Usage limit reached again»,
   «Usage limit has reset», «Wait here, then continue automatically» (с хвостами « at », « shortly»,
   « when the limit resets»), «Automatic continue stopped after repeated usage-limit hits»,
   «Automatic continue cancelled». Признак меню для 6.4 — «Wait here, then continue automatically».

## 11. Порядок

1. Хост: распознавание `need` (журнал событий, индексы, `activity-service`), протокол.
2. Окно: уведомления, звук, метки, настройки.
3. Карта, комната, MCP, гид: `stuck`, `stuck-service`, строки и письма, инструменты, тема `stuck`.
4. Будильник: удержание и возврат после сброса.
5. E2E, README («Agent state: hooks and liveness», «Rooms»), CHANGELOG, TODOS: пункт «ожидание
   сброса лимита подписки: парковать сессии на лимите и поднимать после сброса» (раздел 19)
   закрывается.

**Живая приёмка** — то, чего заглушки не покажут: одобрение у настоящего Codex в комнате (звук,
строка через 2 минуты, ведущий ждёт); настоящий лимит — при первом естественном случае, заранее его не
вызвать; собственное ожидание Claude Code на подписке.

## 12. Вне объёма

- Отскок значка в Dock, меню Dock со списком «нужен ты» (TODOS, раздел 12).
- Пуш на телефон — вместе с удалённым доступом (TODOS, раздел 19).
- Отметка лимита у всех сессий аккаунта заранее (6.2).
- Смена модели или провайдера на лимите автоматически.
- Повторные напоминания и настраиваемые пороги.
- Звук на Linux и Windows проверяется вместе с этими платформами.
