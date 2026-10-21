# Подписки, этап 1: доводка застрявших сессий — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ветка `feat/stuck-sessions` (группы A–C, голова 458e8ad3 от v0.12.0) слита с нынешним `origin/master`, группы D–G её плана доделаны с поправками спеки подписок, и Parley умеет: уведомить человека о застрявшем участнике с причиной, написать ведущему письмо (при лимите — с перечнем свободных аккаунтов того же CLI), вернуть сессию после сброса лимита.

**Architecture:** решения и устройство — спека застрявших (`docs/specs/2026-10-12-stuck-sessions-design.md`, приходит в ветку со слиянием) и её план (`docs/specs/2026-10-12-stuck-sessions-plan.md`, задачи 6–12). Этот план не повторяет их: он задаёт слияние, порядок и **поправки** (разделы 5.8 и 7 спеки подписок): имя аккаунта в текстах, абзац о свободных аккаунтах в письме ведущему, причина «needs you» на острове и в Telegram, слова состояния — из `session-state`.

**Tech Stack:** TypeScript, pnpm-монорепо (`@parley/core`, `@parley/host`, `@parley/protocol`, `@parley/desktop`), zod, vitest, React + zustand, Electron, Playwright (E2E).

**Spec:** `docs/specs/2026-10-21-subscriptions-design.md` (разделы 4.4, 5.8, 7, 9); спека застрявших — целиком; её план — задачи 6–12.

## Global Constraints

- Ветка `feat/subscriptions` от `origin/master` (ad5ecbf8 или новее на момент старта). Все три этапа идут в неё; PR на этап. Локальный `master` отстаёт — код сверять с `origin/master`.
- Коммиты и PR — **по-английски** (`AGENTS.md`): `feat(core): …`, в конце `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Правило плана застрявших о русских коммитах не действует.
- Тесты — только затронутых файлов: `pnpm --filter @parley/<pkg> exec vitest run <path>`. Полный `vitest run`/`pnpm -r test` запрещён. Параллельных исполнителей — не больше двух, по непересекающимся файлам; исполнители — Sonnet. Перед волной — `get_usage`.
- Хост импортирует `@parley/core` и `@parley/protocol` из `dist/`: после правки ядра или протокола — `pnpm --filter @parley/core build` / `pnpm --filter @parley/protocol build` до тестов хоста; окно — `pnpm --filter @parley/desktop typecheck`.
- Тексты окна, писем, гида — английские; комментарии — по-русски со ссылкой на раздел спеки.
- Статусы и слова состояния — только из `packages/core/src/work/session-state.ts` (правило 2026-10-17): свой расчёт в окне, помощнике, Telegram или брифе — дефект.
- `packages/core/test/frame-scan.ts`: новая строка под правило — явное исключение в `FRAME_EXCEPTIONS` с причиной «спека подписок N.M» или «спека застрявших N.M»; проверка `pnpm --filter @parley/core exec vitest run test/frame-check.test.ts`.
- Облегчённый режим проверок ([[sdd-review-budget]]): без мутационных прогонов и переборов у исполнителей и рецензентов; мелкие правки рецензирует контролёр по диффу.

## Review Focus

1. **Эпизод `limit` у сессии, чей провайдер — единственный своего CLI.** Письмо ведущему без абзаца о других аккаунтах и без варианта «replacement»; тест — задача 4 (`stuck.test.ts`, `limitLetter` с `alternatives: []`).
2. **Остров включён, запрос с карточкой у Claude.** Звук «нужно действие» играет на переходе в `needs-you`, а не внутри `send()` (журнал SDD, заметка к задаче 7); тест — задача 3 (`notify.test.ts`: `islandOn: true`, карточка есть → `chime.ring()` вызван, системного уведомления нет).
3. **Telegram выключен (`telegramNeedsYou !== true`).** Причина `need` никуда не уходит, старые тесты Telegram проходят без правок ожиданий; тест — задача 3 (`telegram/service.test.ts`).
4. **Старый хост после слияния.** Окно с полем `stuck` в карте от старого хоста (поля нет) рисует участника как раньше; тест — задача 2 (`feed-model.test.ts`/`ParticipantStrip.test.tsx` с сессией без `stuck`).
5. **Сессия аккаунта (этап 2) ещё не существует.** `account` в `SessionNeed` остаётся как в спеке застрявших (`'auth' | 'account' | null`), а имя провайдера в текстах берётся из реестра по `session.provider` — тексты не ломаются, когда `label` реестра совпадает с id; тест — задача 4 (`stuck.test.ts`, `providerLabel({ id: 'codex', label: 'Codex' })`).

---

### Task 0: Ветка и слияние `feat/stuck-sessions`

**Files:**
- Create: ветка `feat/subscriptions` (от `origin/master`), merge-коммит.
- Modify (конфликты, по `git merge-tree` 2026-10-21): `packages/core/src/codex/index-session.ts`, `packages/core/src/index.ts`, `packages/core/src/session-index.ts`, `packages/core/src/work/activity.ts`, `packages/core/src/work/activity.test.ts`, `packages/core/src/work/events.ts`, `packages/host/src/activity/activity-service.ts`, `packages/host/src/activity/activity-service.test.ts`.

**Interfaces:**
- Produces: ветка с кодом групп A–C (`core/src/work/stuck.ts`, `need` в `activityOf`, `need` в `activity-service`, `MailWait` `stuck`) поверх нынешнего master; спека и план застрявших в `docs/specs/`.

- [ ] **Step 1: Создать ветку и начать слияние**

```bash
git fetch origin && git switch -c feat/subscriptions origin/master
git merge --no-ff feat/stuck-sessions
```
Expected: конфликты ровно в восьми файлах выше (новые — добавить в список ниже в коммите слияния).

- [ ] **Step 2: Разрешить конфликты по правилам**

- `core/src/work/activity.ts` и его тест: свёртка `need` ветки (одобрение, вопрос, лимит, вход, старт) встаёт в нынешнюю свёртку master; слова состояния и `Activity` master не трогаются; `need` — отдельная ось, не новый статус.
- `core/src/work/events.ts`: поля ошибок и инструмента в событиях хуков (`StopFailure`) добавляются к нынешним событиям master.
- `core/src/codex/index-session.ts`, `core/src/session-index.ts`: ошибки API в индексах (ветка) + поля master.
- `core/src/index.ts`: экспорт обоих наборов.
- `host/src/activity/activity-service.ts` и тест: `need` и граница нового процесса (журнал SDD, Ruling 18) поверх нынешней службы; логи времени хоста (0.13.1) остаются.

- [ ] **Step 3: Собрать и прогнать тесты конфликтных файлов**

Run: `pnpm --filter @parley/protocol build && pnpm --filter @parley/core build && pnpm --filter @parley/core exec vitest run src/work/activity.test.ts src/work/stuck.test.ts src/codex/index-session.test.ts src/session-index.test.ts src/work/delivery.test.ts && pnpm --filter @parley/host exec vitest run src/activity/activity-service.test.ts src/activity/activity-terminal.test.ts src/wake/wake-service.test.ts src/feed/feed-service.test.ts && pnpm --filter @parley/desktop typecheck`
Expected: PASS везде; `typecheck` без ошибок.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "merge: feat/stuck-sessions (groups A-C, 458e8ad3) into feat/subscriptions" -m "Conflicts resolved in: <list>" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 1: Группы A–C снова зелёные целиком

**Files:**
- Modify: любые файлы из `git diff --name-only 1ee84163..458e8ad3` (37 файлов ветки), только там, где тест после слияния красный.
- Test: те же `*.test.ts(x)` ветки + `packages/desktop/e2e/stuck-notify.spec.ts`.

- [ ] **Step 1: Прогнать тесты всех 37 файлов ветки**

Run: `git diff --name-only 1ee84163..458e8ad3 | grep '\.test\.tsx\?$'` → список; по пакетам `pnpm --filter @parley/<pkg> exec vitest run <files>`.
Expected: PASS; красные — чинить в коде ветки, не в ожиданиях master.

- [ ] **Step 2: E2E пробы задачи 0 плана застрявших**

Run: `pnpm --filter @parley/desktop build && pnpm --filter @parley/desktop exec playwright test e2e/stuck-notify.spec.ts`
Expected: PASS (уведомление «needs you» у Codex в комнате).

- [ ] **Step 3: Commit** `fix: re-green stuck-sessions groups A-C after the merge`.

### Task 2: Окно — метки и строки (задача 6 плана застрявших) + слова из `session-state`

**Files:**
- Modify: `packages/core/src/work/session-state.ts` — `needWord`; `packages/core/src/index.ts`.
- Файлы задачи 6 плана застрявших (`attention/derive.ts`, `ParticipantStrip.tsx`, `SessionRow.tsx`, `RoomRow.tsx`, `layout/tab-meta.ts`, `rooms/feed-model.ts`, `rooms/RoomMessage.tsx`, `shared/strings.ts`), **без** нового `renderer/lib/need-label.ts`.
- Test: `packages/core/src/work/session-state.test.ts`, тесты рядом с файлами задачи 6.

**Interfaces:**
- Produces (core, `session-state.ts`): `export function needWord(kind: NeedKind): string` — `approval` → `'approval'`, `question` → `'question'`, `limit` → `'limit'`, `'sign-in'` → `'sign-in'`, `startup` → `'starting'`; `export const NEED_WORDS: Readonly<Record<NeedKind, string>>` с теми же значениями. Окно, Telegram, остров и бриф берут слово только отсюда.

- [ ] **Step 1: Падающий тест `session-state.test.ts`**

```ts
it('needWord: одно слово на вид need (спека подписок 7, правило 2026-10-17)', () => {
  expect(needWord('limit')).toBe('limit');
  expect(needWord('startup')).toBe('starting');
  expect(Object.keys(NEED_WORDS)).toEqual(['approval', 'question', 'limit', 'sign-in', 'startup']);
});
```
Run: `pnpm --filter @parley/core exec vitest run src/work/session-state.test.ts` → FAIL (нет экспорта).

- [ ] **Step 2: Реализовать `needWord`/`NEED_WORDS`; `pnpm --filter @parley/core build`.**
- [ ] **Step 3: Выполнить задачу 6 плана застрявших** по её шагам, с заменой: метки `need` в полосе участников, строках сайдбара и `tab-meta` берут `needWord(kind)` из `@parley/core`; группа `S.need` в `strings.ts` хранит только обрамление (`Waiting for approval: ${detail}` и т.п.), не слова видов.
- [ ] **Step 4: Тесты задачи 6 + `pnpm --filter @parley/desktop typecheck` → PASS.**
- [ ] **Step 5: Commit** `feat(desktop): stuck reason in participant labels, rows and delivery line`.

### Task 3: Окно — уведомления, звук, настройки (задача 7) + остров и Telegram (К16)

**Files:**
- Файлы задачи 7 плана застрявших (`attention/notify.ts`, новый `attention/chime.ts`, `shared/ui-types.ts`, `main/ui-store.ts`, `settings/SettingsDialog.tsx`, `shared/strings.ts`, `protocol/src/types.ts` — `NoticeKind` `'limit-return-blocked'`, `e2e/stuck-notify.spec.ts`).
- Modify: `packages/core/src/work/stuck.ts` — `needReason`; `packages/desktop/src/renderer/island/requests.ts:150-158` — причина вместо `S.island.codexTerminalAction`, когда у сессии есть `need`; `packages/host/src/telegram/service.ts:697-712` (`watchBlocked`) и `:736-741` — текст `T.needsYou(name, where)` получает хвост с причиной.
- Test: тесты задачи 7; `island/requests.test.ts`; `host/src/telegram/service.test.ts`; `core/src/work/stuck.test.ts`.

**Interfaces:**
- Produces (core, `stuck.ts`): `export function needReason(need: SessionNeed, now: Date, provider: string): string` — одна английская строка для уведомления, острова и Telegram: `approval` → `Waiting for your approval: <detail>`; `question` → `Asked you a question in its terminal`; `limit` → `Hit its <provider> usage limit; resets at <localClock>` или `…; the reset time is unknown`; `sign-in` → `Signed out of <provider>: <detail>`; `startup` → `Waiting in its terminal since launch (sign-in, folder trust or another startup screen)`. `provider` — имя провайдера для человека (`providerLabel`, задача 4).
- Consumes: `needWord` (задача 2).

- [ ] **Step 1: Падающие тесты**

`stuck.test.ts`:
```ts
it('needReason: limit называет провайдера и время сброса (спека подписок 4.4, 5.8)', () => {
  const need: SessionNeed = { kind: 'limit', since: '2026-10-21T10:00:00Z', detail: null, resetsAt: '2026-10-21T16:27:00+03:00', window: 'session', account: null };
  expect(needReason(need, new Date('2026-10-21T13:00:00+03:00'), 'Claude Code 2')).toBe('Hit its Claude Code 2 usage limit; resets at 16:27');
});
```
`telegram/service.test.ts`: при `telegramNeedsYou: true` и сессии с `need` вида `limit` сообщение содержит `Hit its Codex usage limit`; при `telegramNeedsYou` не `true` — сообщений нет (старые ожидания без правок).
`island/requests.test.ts`: сессия Codex с `need` `approval` → `summary` = `Waiting for your approval: ls -la`; без `need` → прежний `S.island.codexTerminalAction`.
Run: соответствующие `vitest run` → FAIL.

- [ ] **Step 2: Реализовать `needReason`; выполнить задачу 7 плана застрявших** (её шаги; звук — на переходе уровня в `needs-you`, не в `send()`; с островом системное уведомление у Claude с карточкой не шлётся, как сейчас); остров и Telegram — по интерфейсу выше. `pnpm --filter @parley/core build && pnpm --filter @parley/protocol build`.
- [ ] **Step 3: Тесты шага 1 + тесты задачи 7 + `pnpm --filter @parley/desktop typecheck` → PASS.**
- [ ] **Step 4: Commit** `feat(desktop,host): notification with the stuck reason, chime, island and Telegram share one reason text`.

### Task 4: Ядро — поле `stuck`, тексты писем, MCP, гид (задача 8) + свободные аккаунты в письме

**Files:**
- Файлы задачи 8 плана застрявших (`work/types.ts`, `work/stuck.ts`, `work/rooms.ts`, `work/context-pages.ts`, `mcp/tools.ts`, `work/guide.ts`, `work/brief.ts`, `work/skill.ts`).
- Modify: `packages/core/src/work/stuck.ts` — `limitLetter` с `alternatives`, `providerLabel`.
- Test: `stuck.test.ts`, `guide.test.ts`, `brief.test.ts`, `english-text.test.ts`, тесты MCP задачи 8.

**Interfaces:**
- Produces (core, `stuck.ts`):
  - `export interface LimitAlternative { id: string; label: string; limits: ProviderLimits | null }` — другой **вошедший** провайдер того же семейства.
  - `export function limitLetter(input: { mention: string; provider: string; resetsAt: string | null; now: Date; alternatives: readonly LimitAlternative[] }): string` — текст письма из спеки застрявших 5.2 (`limit`), где `Codex` заменён на `provider`; при `alternatives.length > 0` перед последним предложением добавляется абзац:
    `Other <provider> accounts in Parley right now: <label> (weekly <n> % used, resets <agentClock>); <label2> — no limits known. A replacement can be started on a free one with create_session (provider: "<id>") — but only after @human agrees.` и в вариантах для `@human` — `start a replacement on <label> and hand it <mention>'s part`.
  - `export function providerLabel(entry: Pick<ProviderEntry, 'id' | 'label'>): string` — `claude` → `Claude Code`, `codex` → `Codex`, `glm` → `GLM`, иначе `entry.label || entry.id` (зеркало `providerName` окна; одно место в ядре, окно переходит на него в этапе 2).
- Consumes: `agentClock` (задача 8 плана застрявших), `ProviderLimits` (`core/src/limits.ts`).

- [ ] **Step 1: Падающие тесты `stuck.test.ts`**

```ts
it('limitLetter без альтернатив — текст спеки застрявших 5.2', () => {
  const text = limitLetter({ mention: '@s03', provider: 'Codex', resetsAt: '2026-10-21T19:27:00+03:00', now, alternatives: [] });
  expect(text).toContain('@s03 hit its Codex usage limit; it resets at 19:27 local time');
  expect(text).not.toContain('Other Codex accounts');
});
it('limitLetter с альтернативами — абзац о свободных аккаунтах и вариант replacement (спека подписок 5.8)', () => {
  const text = limitLetter({ mention: '@s03', provider: 'Claude Code 2', resetsAt: null, now, alternatives: [{ id: 'claude', label: 'Claude Code', limits: { fiveHour: null, week: { usedPercent: 31, resetsAt: '2026-10-27T10:00:00+03:00' }, at: now.toISOString() } }] });
  expect(text).toContain('Other Claude Code 2 accounts in Parley right now: Claude Code (weekly 31 % used, resets');
  expect(text).toContain('create_session (provider: "claude")');
  expect(text).toContain('only after @human agrees');
  expect(text).toContain("start a replacement on Claude Code and hand it @s03's part");
});
it('providerLabel: встроенные имена и label своих', () => {
  expect(providerLabel({ id: 'codex', label: 'Codex' })).toBe('Codex');
  expect(providerLabel({ id: 'custom-claude-2', label: 'Claude Code 2' })).toBe('Claude Code 2');
});
```
Run: `pnpm --filter @parley/core exec vitest run src/work/stuck.test.ts` → FAIL.

- [ ] **Step 2: Выполнить задачу 8 плана застрявших** по её шагам; тема гида `stuck` получает правило: при `limit` ведущий пишет одно сообщение `@human` с вариантами, включая замену на названном свободном аккаунте, **и ждёт ответа**; после «да» — `create_session` на этом провайдере, `add_to_room`, задача и указатель на карту новой сессии, письмо застрявшему о передаче; сам замену не заводит.
- [ ] **Step 3: Тесты шага 1 + тесты задачи 8 + `english-text.test.ts` → PASS; `pnpm --filter @parley/core build`.**
- [ ] **Step 4: Commit** `feat(core): stuck field, Parley letters with free accounts, wait_for and send_message, guide topic stuck`.

### Task 5: Хост — служба «застрял» (задача 9) + источник альтернатив

**Files:**
- Файлы задачи 9 плана застрявших (новый `packages/host/src/stuck/stuck-service.ts` и тест, `host.ts`).
- Test: `stuck-service.test.ts`.

**Interfaces:**
- Produces: `createStuckService(host, works, activity, options)` как в задаче 9, плюс в `options`: `alternatives?: (provider: string) => Promise<readonly LimitAlternative[]>` — по умолчанию функция хоста `limitAlternatives(provider)`:
  `export async function limitAlternatives(provider: string, deps: { limits: Pick<LimitsService, 'get'>; signedIn: (id: string) => boolean | null }): Promise<LimitAlternative[]>` — все записи `loadProviders()` того же `family`, что у `provider`, кроме него самого, у которых `providerReadiness` даёт `available` (на этом этапе `signedIn` всегда `null`, а аккаунтов нет, поэтому список пуст; этап 2 подставляет службу входа).
- Consumes: `limitLetter`, `providerLabel` (задача 4); `LimitsService.get`.

- [ ] **Step 1: Падающие тесты** задачи 9 + `limitAlternatives`: реестр с `claude` и `custom-x` семейства `claude` (фикстура `custom-providers.json` во временном доме), `signedIn: () => true` → `[{ id: 'custom-x', … }]`; с `signedIn: () => null` → `[]`.
- [ ] **Step 2: Реализовать по задаче 9**; письмо `limit` — `limitLetter({ …, provider: providerLabel(entry), alternatives: await options.alternatives(session.provider) })`.
- [ ] **Step 3: Тесты → PASS; `pnpm --filter @parley/host exec vitest run src/stuck/stuck-service.test.ts`.**
- [ ] **Step 4: Commit** `feat(host): stuck service with thresholds, map field, room line and letters`.

### Task 6: Будильник — возврат после сброса лимита (задача 10)

Выполнить задачу 10 плана застрявших как есть (`delivery.ts`, новый `wake/limit-return.ts`, `wake-service.ts`, `host.ts`). Тесты задачи; коммит `feat(host): return after the usage limit resets`.

### Task 7: E2E комнаты с застрявшими (задача 11)

Выполнить задачу 11 плана застрявших; в сценарии 2 добавить проверку текста письма ведущему через `STUB_MCP check_inbox {}`: без аккаунтов письмо **не** содержит `Other Claude Code accounts`. Прогон при DPR 1 и 2. Коммит `test(desktop): e2e for stuck room participants`.

### Task 8: Документы этапа

**Files:** `README.md`, `CHANGELOG.md` (раздел `## Unreleased`), `docs/specs/2026-10-12-stuck-sessions-design.md` (статус: влито, отличия по спеке подписок 7), `TODOS.md`.

- [ ] **Step 1:** Правки по задаче 12 плана застрявших; в CHANGELOG — одна запись «Stuck participants» (уведомление с причиной, звук, письмо ведущему, возврат после сброса).
- [ ] **Step 2:** `pnpm --filter @parley/desktop exec vitest run src/release-docs.test.ts` → PASS.
- [ ] **Step 3: Commit** `docs: stuck sessions — README, CHANGELOG, TODOS`.

### Task 9: Ревью ветки и PR этапа

- [ ] **Step 1:** Полное ревью диффа `origin/master..feat/subscriptions` свежим рецензентом (Opus), по спеке застрявших и разделам 4.4/5.8/7 спеки подписок.
- [ ] **Step 2:** Проверка по `superpowers:verification-before-completion`: тесты затронутых пакетов по файлам, `typecheck`, `lint`.
- [ ] **Step 3:** `git push -u origin feat/subscriptions`; PR «Stuck participants: reason, chime, lead letter, return after reset» открывает человек (ссылка compare с заголовком и телом по-английски, [[gh-cli-missing]]).
