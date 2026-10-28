# Руки помощника, план 2: одна карточка действий — создать, разбудить, остановить, усыпить, закрыть

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** помощник готовит по просьбе человека одну карточку с планом из шагов. Шаги — создать работу, агентов (с ролью, провайдером, моделью) и комнаты, разбудить, прервать, усыпить, закрыть, добавить в комнату, написать. План выполняется только по клику на кнопку карточки, на острове или в Telegram.

**Architecture:** вся логика — в хосте, в `packages/host/src/assistant/`. Модули:
- `new-agent.ts` выбирает проект, роль, провайдер и модель;
- `actions.ts` разбирает и проверяет план целиком, строит строки карточки;
- `run-plan.ts` выполняет шаги по очереди через функции хоста и перед каждым шагом сверяет состояние заново.

Сервис помощника держит карточку `action: 'actions'` и её отчёт `AssistantState.report`. Остров и Telegram только рисуют их и шлют `assistant.decide` с `action: 'actions'`; без этого поля хост план не выполнит.

**Tech Stack:** TypeScript, Node ≥ 22.16, zod, vitest, Electron + React (zustand), @testing-library/react (jsdom), Playwright.

**Spec:** `docs/specs/2026-10-28-assistant-hands-design.md` (утверждена 2026-10-28). Ссылки «спека N.M» ведут на неё. Этот план — её разделы 5.4, 6, 7 (руки), 9 и 10. Строится поверх плана 1 (`2026-10-28-assistant-hands-plan-1-eyes.md`): нужны `resolveTarget(…, { hidden })`, `targetsOf(…, { hidden })`, `projectLabel`, `projectName`.

## Global Constraints

- Всё из раздела Global Constraints плана 1 — ветка, языки, строка `Co-Authored-By`, `cyrillic-ok`, нагрузка, команды тестов.
- Состояние меняется только через карточку и клик человека. Карточка `actions` подтверждается **только кнопкой**: не Enter, не набранным и не надиктованным «да». Отмену голосом и словом («нет») оставить, как у писем.
- Числа из спеки:
  - не больше 20 шагов;
  - текст под шагом — 1500 знаков у карточки из одного шага и 300 у каждого шага, если их несколько;
  - тексты шагов — до 4000;
  - названия — 1…80;
  - сообщение Telegram — ≤ 4096 знаков.
- Признак клиента — `ASSISTANT_ACTIONS_FEATURE = 'assistant-actions'` в `hello.features`. Сейчас окно шлёт 17 признаков, предел схемы — 32.
- Отката нет: упавший шаг останавливает план, сделанные шаги остаются. Карточка плана, который начал выполняться, не возвращается.
- Новые агенты помощника облегчённые: `lean = config.leanAgents`. `model` в `sessions.create` передаётся **только** когда модель названа: явный `null` стирает умолчание роли.
- Поле `action` в `assistant.decide` и `defaultProvider` в `assistant.configure` старый хост молча отбросит: схемы — обычный `z.object`, без `.strict()`.

## Review Focus

1. **Двойное подтверждение** — клик на острове и кнопка Telegram, или двойной клик. План выполняется один раз, второй `decide` получает `This card is no longer current`. Тест — в задаче 6.
2. **Второй план, пока идёт первый.** `propose_actions` отвечает 409 `A plan is still running; wait until it ends`. Подтверждение другой карточки `actions` даёт `Another plan is still running`, и карточка остаётся. Тест — в задаче 6.
3. **Точное имя роли побеждает подстроку**: «Reviewer» при ролях `Reviewer` и `Code Reviewer` — без ошибки неоднозначности. Тест — в задаче 3.
4. **Модель названа подписью** («Opus 4.6»), а не значением (`opus`). Принимается и уходит значением. Тест — в задаче 3.
5. **«да» пришло текстом из Telegram, пока ждёт карточка `actions`.** Ход получает `[system: a card with actions is waiting; it is confirmed only by its button]`, план не выполняется. Тест — в задаче 6.

---

### Task 1: Протокол — карточка `actions`, отчёт, поля `decide` и `configure`

**Files:**
- Modify: `packages/protocol/src/assistant.ts` (`AssistantProposal`, `AssistantState`, `assistantMethodSchemas`)
- Modify: `packages/protocol/src/index.ts` (ре-экспорт типов и констант помощника)
- Test: `packages/protocol/src/assistant.test.ts` (создать, если нет)

**Interfaces:**
- Consumes: —
- Produces:

```ts
export const ASSISTANT_ACTIONS_FEATURE = 'assistant-actions';
export type ActionVerb = 'create_work' | 'create_session' | 'wake' | 'interrupt' | 'sleep' | 'close' | 'create_room' | 'add_to_room' | 'message';
export interface ActionStepView { verb: ActionVerb; line: string; text: string | null; danger: boolean }
// новый вид AssistantProposal:
// | (ProposalBase & { action: 'actions'; steps: ActionStepView[] })
export interface ActionsReport {
  proposalId: string;
  status: 'running' | 'done' | 'stopped';
  steps: Array<{ line: string; status: 'waiting' | 'running' | 'done' | 'failed' | 'skipped' }>;
  /** Номер упавшего шага с 1; у running и done — null. */
  failedStep: number | null;
  reason: string | null;
  /** Пометки сделанных шагов: «Alice waits for you to trust the folder». */
  notes: string[];
}
// AssistantState.report?: ActionsReport | null  — старый хост не шлёт
export function reportLine(report: ActionsReport): string;
// 'assistant.decide': + action: z.literal('actions').optional()
// 'assistant.configure': + defaultProvider: z.string().min(1).nullable().optional()
```

`reportLine` выдаёт:
- `running` — `Running step <k> of <n>`, где k — первый шаг со статусом `running`, а если такого нет — первый `waiting`;
- `done` — `Done`;
- `stopped` — `Stopped at step <failedStep> of <n>: <reason>`.

- [ ] **Step 1: Write the failing test**

```ts
describe('протокол карточки действий', () => {
  it('decide принимает action: actions, без поля — тоже; чужое значение — нет', () => {
    const decide = assistantMethodSchemas['assistant.decide'];
    expect(decide.parse({ proposalId: 'p1', decision: 'send', action: 'actions' })).toEqual({ proposalId: 'p1', decision: 'send', action: 'actions' });
    expect(decide.parse({ proposalId: 'p1', decision: 'send' })).toEqual({ proposalId: 'p1', decision: 'send' });
    expect(decide.safeParse({ proposalId: 'p1', decision: 'send', action: 'room' }).success).toBe(false);
  });
  it('configure: defaultProvider необязателен и может быть null', () => {
    const base = { enabled: true, provider: null, model: null, language: 'ru', voiceModel: null };
    expect(assistantMethodSchemas['assistant.configure'].parse({ ...base, defaultProvider: null })).toMatchObject({ defaultProvider: null });
    expect(assistantMethodSchemas['assistant.configure'].parse(base)).not.toHaveProperty('defaultProvider');
  });
  it('reportLine: ход, итог и остановка', () => {
    const steps = [{ line: 'a', status: 'done' }, { line: 'b', status: 'failed' }, { line: 'c', status: 'skipped' }] as const;
    expect(reportLine({ proposalId: 'p1', status: 'stopped', steps: [...steps], failedStep: 2, reason: 'S05 Vera is already asleep', notes: [] })).toBe('Stopped at step 2 of 3: S05 Vera is already asleep');
    expect(reportLine({ proposalId: 'p1', status: 'running', steps: [{ line: 'a', status: 'done' }, { line: 'b', status: 'running' }], failedStep: null, reason: null, notes: [] })).toBe('Running step 2 of 2');
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @parley/protocol exec vitest run src/assistant.test.ts`
Expected: FAIL — `reportLine` не экспортирован, `action` вырезается схемой.

- [ ] **Step 3: Implement** типы, схемы и `reportLine` в `protocol/src/assistant.ts`. Ре-экспорт — в `protocol/src/index.ts`, рядом с `AssistantProposal`.

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm --filter @parley/protocol exec vitest run && pnpm --filter @parley/core exec vitest run src/english-text.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src
git commit -m "feat(protocol): add the assistant actions card, its report and the decide action field"
```

### Task 2: Правило провайдера и модели роли — в core, окно зовёт его

**Files:**
- Modify: `packages/core/src/work/agents.ts` (рядом с `RoleSummary`, строка 207), `packages/core/src/index.ts:663` (экспорт)
- Modify: `packages/desktop/src/renderer/components/dialogs/agent-rows.ts:82–85` (`providerIdOf`)
- Modify: `packages/desktop/src/renderer/components/dialogs/AgentRowsEditor.tsx:125` (`roleModel`)
- Test: `packages/core/src/work/agents.test.ts`

**Interfaces:**
- Consumes: `RoleSummary`.
- Produces:
  - `export function roleProvider(role: Pick<RoleSummary, 'source' | 'provider'> | undefined, chosen: string | null, fallback: string | null): string | null`:
    - не встроенная роль — `role.provider`;
    - иначе `chosen ?? role?.provider ?? fallback`.
  - `export function roleModel(role: Pick<RoleSummary, 'source' | 'model' | 'models'> | undefined, provider: string | null): string | null`:
    - встроенная роль — `provider === 'codex' ? role.models?.codex : role.models?.claude` (нет — `null`);
    - иначе `role?.model ?? null`.

- [ ] **Step 1: Write the failing test**

```ts
describe('roleProvider и roleModel', () => {
  const builtin = { source: 'builtin', provider: 'claude', model: null, models: { claude: 'opus', codex: 'gpt-5.5' } } as const;
  const codexRole = { source: 'codex', provider: 'codex', model: 'gpt-5.5', models: undefined } as const;
  it('не встроенная роль навязывает провайдера', () => {
    expect(roleProvider(codexRole, 'claude', 'glm')).toBe('codex');
  });
  it('встроенная: выбранный, потом свой, потом умолчание', () => {
    expect(roleProvider(builtin, 'codex', 'glm')).toBe('codex');
    expect(roleProvider(builtin, null, 'glm')).toBe('claude');
    expect(roleProvider(undefined, null, 'glm')).toBe('glm');
  });
  it('модель роли по провайдеру', () => {
    expect(roleModel(builtin, 'codex')).toBe('gpt-5.5');
    expect(roleModel(builtin, 'glm')).toBe('opus');
    expect(roleModel(codexRole, 'codex')).toBe('gpt-5.5');
    expect(roleModel(undefined, 'claude')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @parley/core exec vitest run src/work/agents.test.ts`
Expected: FAIL — функций нет.

- [ ] **Step 3: Implement** обе функции в core. `providerIdOf` становится `roleProvider(roleOf(env, row), row.provider, env.defaultId)`. Строка 125 `AgentRowsEditor.tsx` становится `const roleModel = roleModelOf(role, providerIdOf(env, row));` — импорт `roleModel as roleModelOf`, потому что локальное имя `roleModel` в файле уже занято.

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm --filter @parley/core exec vitest run src/work/agents.test.ts && pnpm typecheck && pnpm --filter @parley/desktop exec vitest run src/renderer/components/dialogs`
Expected: PASS, typecheck без ошибок.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/work/agents.ts packages/core/src/work/agents.test.ts packages/core/src/index.ts packages/desktop/src/renderer/components/dialogs
git commit -m "refactor(core): share the role provider and model rule between the window and the host"
```

### Task 3: Новый агент и новая работа — проект, роль, провайдер, модель

**Files:**
- Create: `packages/host/src/assistant/new-agent.ts`
- Test: `packages/host/src/assistant/new-agent.test.ts`

**Interfaces:**
- Consumes:
  - `targetsOf(source, { hidden: true })`, `projectName`, `projectLabel` (план 1);
  - `roleProvider`, `roleModel` (задача 2);
  - `ProviderEntry` (`models?: readonly ModelOption[] | null`, у `ModelOption` есть `value` и `label`), `providerLabel`, `ASSISTANT_PROVIDER_ORDER`, `RoleSummary` из `@parley/core`.
- Produces:
  - `export function resolveProject(source: OverviewSource, wanted: string): { projectPath: string; label: string } | { error: string }`. Проект — это `projectPath` любой записи снимка, в том числе архивных работ. Ищется так:
    1. `wanted` равен `projectPath`;
    2. `wanted` — id `work:…` любой работы (через `targetsOf(source, { hidden: true })`), берётся её проект;
    3. имя папки без учёта регистра.

    Ошибки:
    - два проекта с одним именем — `"scanum" matches several projects: scanum in ~/Desktop (work:…), scanum in ~/work (work:…). Name one by a work id.`;
    - ничего — `"<wanted>" is not a Parley project; add it in Parley first.`
  - `export function resolveRole(roles: readonly RoleSummary[], wanted: string): { role: RoleSummary } | { error: string }`. Порядок:
    1. точное имя без учёта регистра;
    2. если точного нет — подстрока.

    Одно совпадение — берётся. Несколько — `"<w>" matches several roles: <name> (<source>), …. Say which one.` Ни одного — `No role "<w>". Roles: <имена через ", ">.`
  - `export interface NewAgentChoice { provider: ProviderEntry; model: string | null; shownModel: string | null }`. `model` — что уйдёт в `sessions.create` (`null` — не передавать), `shownModel` — что показать на карточке.
  - `export async function chooseProvider(input: { role: RoleSummary | null; provider: string | null; model: string | null; fallback: string | null; registry: Readonly<Record<string, ProviderEntry>>; ready(entry: ProviderEntry): Promise<string | null> }): Promise<{ choice: NewAgentChoice } | { error: string }>`.

Правила `chooseProvider` (спека 6.2):
- Названный провайдер сверяется с `id` и `label` реестра без учёта регистра. Неизвестный — `No provider "<p>". Providers: <id через ", ">.`
- Не встроенная роль с другим названным провайдером — `Role <name> runs on <label>; leave the provider out or pick another role.`
- Иначе id — `roleProvider(role, названный id, null)`, если это не `null`. Такой провайдер должен быть готов, иначе `<label> is not ready: <причина>`.
- Иначе — умолчание: `fallback`, если он есть в реестре и готов; иначе первый готовый по `ASSISTANT_PROVIDER_ORDER`, затем остальные id реестра по порядку. Готового нет — `No provider is ready to start an agent — open Settings.`
- Названная модель сверяется с `entry.models` по `value` или `label` без учёта регистра и уходит значением. Не нашлась — `<label> has no model "<m>". Models: <values через ", ">.` Если `models` нет (`null` или поле отсутствует), модель принимается как есть.
- Модель не названа — `model: null`, `shownModel: roleModel(role ?? undefined, entry.id)`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('resolveProject', () => {
  it('по имени папки, по id работы, архивные тоже', () => { /* … toEqual({ projectPath: '/u/scanum', label: 'scanum' }) */ });
  it('два проекта с одним именем — отказ с id работ и родительскими папками', () => {
    expect(resolveProject(dupSrc, 'scanum')).toEqual({ error: expect.stringMatching(/matches several projects: scanum in ~\/Desktop \(work:[^)]+\), scanum in ~\/work/) });
  });
  it('незнакомая папка — not a Parley project', () => {
    expect(resolveProject(src, 'nowhere')).toEqual({ error: '"nowhere" is not a Parley project; add it in Parley first.' });
  });
});
describe('resolveRole', () => {
  const roles = [role('Reviewer', 'builtin'), role('Code Reviewer', 'claude'), role('Planner', 'builtin')];
  it('точное имя побеждает подстроку', () => expect(resolveRole(roles, 'reviewer')).toMatchObject({ role: { name: 'Reviewer' } }));
  it('подстрока — одна', () => expect(resolveRole(roles, 'plan')).toMatchObject({ role: { name: 'Planner' } }));
  it('неоднозначно — список', () => expect(resolveRole(roles, 'view')).toEqual({ error: expect.stringContaining('Reviewer (builtin), Code Reviewer (claude)') }));
  it('нет — список ролей', () => expect(resolveRole(roles, 'chef')).toEqual({ error: expect.stringMatching(/^No role "chef"\. Roles: Reviewer, Code Reviewer, Planner\.$/) }));
});
describe('chooseProvider', () => {
  it('роль Codex и названный claude — отказ', async () => { /* error: 'Role X runs on Codex; …' */ });
  it('умолчание из окна; без него — первый готовый по порядку claude, glm, codex', async () => {
    expect(await chooseProvider({ ...base, fallback: 'codex' })).toMatchObject({ choice: { provider: { id: 'codex' } } });
    expect(await chooseProvider({ ...base, fallback: null, ready: async (e) => (e.id === 'claude' ? 'not signed in' : null) })).toMatchObject({ choice: { provider: { id: 'glm' } } });
  });
  it('модель подписью — уходит значением', async () => {
    expect(await chooseProvider({ ...base, provider: 'claude', model: 'Opus 4.6' })).toMatchObject({ choice: { model: 'opus', shownModel: 'opus' } });
  });
  it('незнакомая модель — отказ со списком; без списка у провайдера — как есть', async () => { /* … */ });
  it('модель не названа — не передаётся, показывается модель роли', async () => {
    expect(await chooseProvider({ ...base, role: builtinReviewer, fallback: 'claude' })).toMatchObject({ choice: { model: null, shownModel: 'opus' } });
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @parley/host exec vitest run src/assistant/new-agent.test.ts`
Expected: FAIL — модуля нет.

- [ ] **Step 3: Implement** три функции в `new-agent.ts`.

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm --filter @parley/host exec vitest run src/assistant/new-agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/assistant/new-agent.ts packages/host/src/assistant/new-agent.test.ts
git commit -m "feat(host): pick the project, role, provider and model of an agent the assistant creates"
```

### Task 4: Разбор и проверка плана, строки карточки

**Files:**
- Create: `packages/host/src/assistant/actions.ts`
- Test: `packages/host/src/assistant/actions.test.ts`

**Interfaces:**
- Consumes:
  - `targetsOf`, `resolveTarget(…, { hidden })`, `projectLabel` (план 1);
  - `resolveProject`, `resolveRole`, `chooseProvider` (задача 3);
  - `ActionStepView`, `ActionVerb` (задача 1);
  - `participantLabel`, `sessionDotStateWithNeed`, `roleFromId`, `providerLabel` из `@parley/core`, `sessionNeed` из `@parley/core/attention`.
- Produces:

```ts
export const MAX_STEPS = 20;
export type WorkRef = { step: number } | { projectPath: string; workId: string; title: string };
export type RoomRef = { step: number } | { projectPath: string; workId: string; roomId: string; title: string };
export type SessionPick = { step: number; name: string } | { ref: SessionRef; name: string };
export type PreparedStep =
  | { do: 'create_work'; projectPath: string; title: string; goal: string }
  | { do: 'create_session'; work: WorkRef; label: string; role: SessionRole | null; provider: string; model: string | null; task: string }
  | { do: 'wake'; session: SessionPick; text: string | null }
  | { do: 'interrupt' | 'sleep' | 'close'; session: SessionPick }
  | { do: 'create_room'; work: WorkRef; title: string; members: SessionPick[]; lead: SessionPick; task: string | null }
  | { do: 'add_to_room'; room: RoomRef; session: SessionPick }
  | { do: 'message'; room: RoomRef | null; session: SessionPick | null; text: string; kind: 'note' | 'question' | 'decision' | null; to: SessionPick[] };
export interface PreparedPlan { steps: PreparedStep[]; view: ActionStepView[]; target: string; where: string; text: string }
export interface PlanContext {
  source: OverviewSource;
  roles(projectPath: string): Promise<readonly RoleSummary[]>;
  registry: Readonly<Record<string, ProviderEntry>>;
  ready(entry: ProviderEntry): Promise<string | null>;
  fallbackProvider: string | null;
}
export async function preparePlan(input: unknown, ctx: PlanContext): Promise<{ plan: PreparedPlan } | { error: string }>;
/** Почему с этой сессией нельзя сделать `verb` сейчас; `null` — можно. Общая для проверки при предложении и перед шагом. */
export function stateRefusal(verb: 'wake' | 'interrupt' | 'sleep' | 'close' | 'message', name: string, session: WorkSession | undefined, live: SessionLive | undefined): string | null;
```

**Вход.** `{ steps: Array<{ do: ActionVerb, … }> }`, поля шагов — по таблице спеки 6.1:
- `create_work { project, title, goal? }`;
- `create_session { work, name?, role?, provider?, model?, task? }`;
- `wake { session, text? }`;
- `interrupt | sleep | close { session }`;
- `create_room { work, title, members, lead?, task? }`;
- `add_to_room { room, session }`;
- `message { target, text, kind?, mention? }`.

Разбор — zod внутри модуля. Строки обрезаются по краям. Ошибки:
- форма не та — `Step <N>: <что не так>`;
- `steps` пуст или длиннее 20 — `A plan has 1 to 20 steps.`

Каждая ошибка начинается с `Step <N>: `.

**Ссылки.**
- `"$N"` — шаг N этого плана, считая с 1. N должен быть меньше номера текущего шага, иначе `"$4" points to a later step`.
- Вид должен подходить: `create_work` → работа, `create_session` → сессия, `create_room` → комната. Иначе `"$1" is a work, not a session`.
- Прочее резолвит `resolveTarget(open, wanted, { hidden })`:
  - скрытая цель — `<name> is closed; reopen it in Parley first` (или `is archived`);
  - не тот вид — `<name> is a room, not a session`.
- Участники `create_room`, сессия `add_to_room` и `mention` ищутся среди сессий работы этой комнаты. Это правило нынешнего `memberOf` в `assistant-service.ts:582`: перенести функцию сюда и экспортировать, сервис будет звать её отсюда.
- Сессия `$N` годится, только если её `create_session.work` указывает на ту же работу.

**Проверки состояния** (`stateRefusal`, по `lifecycle` и `sessionDotStateWithNeed`):

| verb | Можно | Отказ |
|---|---|---|
| `wake` | `sleeping` | `active` — `<name> is already awake`; `pending` — `<name> has not started yet`; `closed` или нет — `<name> is closed` |
| `interrupt` | `active` и точка `working` или `blocked` | `active` иначе — `<name> is not doing anything right now`; `sleeping` — `<name> is asleep`; прочее — как у `wake` |
| `sleep` | `active` | `sleeping` — `<name> is already asleep`; `pending`, `closed` — как у `wake` |
| `close` | всё, кроме `closed` | `<name> is closed` |
| `message` | `active`, `sleeping` | как нынешний `unreachable` |

Шаги про сессию `$N`:
- `wake`, `interrupt`, `sleep`, `close` — `the agent from step <N> is created by this plan`;
- `message` к сессии `$N` — `give the agent from step <N> its first turn as task`. Письмо в комнату `$N` можно.

Прочие отказы:
- участник дважды — `<name> is listed twice in members`;
- `lead` не из участников — `lead <name> is not among members`;
- `add_to_room` сессии, что уже состоит в этой комнате (сейчас или по шагу `create_room` / `add_to_room` этого плана), — `<name> is already in room "<title>"`;
- `mention` не участника — как в нынешнем `mentionsOf`;
- `mention` у сессии — `mention is only for rooms`.

`create_session`:
- работа — известная или `$N`. Проект `$N` — из шага `create_work`;
- роль — `resolveRole(await ctx.roles(projectPath), role)`, только если роль названа, а `SessionRole` для создания — `roleFromId(role.id)`;
- провайдер и модель — `chooseProvider({ role, provider, model, fallback: ctx.fallbackProvider, registry, ready })`;
- `label` — `name` или `''`.

**Строки карточки** (`view[i].line`; имя сессии `$N` — `agent "<name>" from step <N>` или `the agent from step <N>`, работа и комната `$N` — их `title` из шага):
- `create_work` — `Create work "<title>" in project <projectLabel>`
- `create_session` — `Create an agent "<name>" in "<work>" · role <Role> · <provider label> · <shownModel>`. Части без значения опускаются: нет имени — `Create an agent in "<work>" · …`.
- `wake` — `Wake <name>`
- `interrupt` — `Stop what <name> is doing`
- `sleep` — `Put <name> to sleep`
- `close` — `Close <name> for good`, `danger: true`
- `create_room` — `Create room "<title>" in "<work>" with <имена через ", "> (lead <name>)`
- `add_to_room` — `Add <name> to room "<title>"`, а если известная сессия сейчас в другой неархивной комнате этой работы — ещё ` (leaves room "<other>")`
- `message` в комнату — `Message room "<title>"`, с упомянутыми — ` for <имена>`; в сессию — `Message <name>`, спящей — ` (wakes it)`

`view[i].text`:
- это `task`, `wake.text`, `message.text` или `create_room.task`, иначе `null`;
- обрезается до 1500 знаков (один шаг) или 300 (несколько), длиннее — `slice(0, max - 1) + '…'`;
- в `PreparedStep` текст остаётся полным.

Общие поля:
- `target` — у одного шага `view[0].line`, у нескольких — `` `${n} steps` ``;
- `where` — `<work title> · <projectLabel>` работы первого шага, у которого работа известна, иначе `Parley`;
- `text` — `Update Parley to confirm this card.` и строки `1. <line>` через `\n`.

- [ ] **Step 1: Write the failing tests** (`actions.test.ts`). Снимок — как `MAP` в `assistant-service.test.ts`:
- работа `w-1` «Parley» в `/p`;
- s-03 «S03 Ruslan» — active, `working`; s-02 «S02 Anna» — active, `idle`; s-04 «S04 Nik» — `sleeping`; s-09 «S09 Old» — `closed`;
- комнаты r-1 «Auth» (участник s-03) и r-2 «Gate» (s-03, s-02).

`closedId` — id s-09 из `targetsOf(src, { hidden: true })`. Контекст `ctx`:
- `roles` — встроенная `Reviewer` с `models: { claude: 'opus', codex: 'gpt-5.5' }` и `provider: 'claude'`, плюс `Code Reviewer` (claude);
- реестр — `claude` («Claude») и `codex` («Codex»), оба готовы;
- `fallbackProvider: 'claude'`.

```ts
it('работа → три агента с ролями → комната из них → задача — один план', async () => {
  const result = await preparePlan({ steps: [
    { do: 'create_work', project: 'p', title: 'Auth refactor' },
    { do: 'create_session', work: '$1', role: 'reviewer' },
    { do: 'create_session', work: '$1', name: 'Vera', provider: 'codex' },
    { do: 'create_session', work: '$1' },
    { do: 'create_room', work: '$1', title: 'QA', members: ['$2', '$3', '$4'], task: 'Start with tests.' },
  ] }, ctx);
  const { plan } = result as { plan: PreparedPlan };
  expect(plan.view.map((step) => step.line)).toEqual([
    'Create work "Auth refactor" in project p',
    'Create an agent in "Auth refactor" · role Reviewer · Claude · opus',
    'Create an agent "Vera" in "Auth refactor" · Codex',
    'Create an agent in "Auth refactor" · Claude',
    'Create room "QA" in "Auth refactor" with the agent from step 2, agent "Vera" from step 3, the agent from step 4 (lead the agent from step 2)',
  ]);
  expect(plan.text.startsWith('Update Parley to confirm this card.\n1. Create work')).toBe(true);
});
it.each([
  [{ do: 'create_room', work: 'Parley', title: 'X', members: ['$2'] }, 'Step 1: "$2" points to a later step'],
  [{ do: 'sleep', session: 'S04' }, 'Step 1: S04 Nik is already asleep'],
  [{ do: 'wake', session: 'S03' }, 'Step 1: S03 Ruslan is already awake'],
  [{ do: 'interrupt', session: 'S02' }, 'Step 1: S02 Anna is not doing anything right now'],
  [{ do: 'close', session: closedId }, 'Step 1: S09 Old is closed; reopen it in Parley first'],
  [{ do: 'add_to_room', room: 'Auth', session: 'S03' }, 'Step 1: S03 Ruslan is already in room "Auth"'],
])('отказ целиком: %j', async (step, error) => {
  expect(await preparePlan({ steps: [step] }, ctx)).toEqual({ error });
});
it('ссылка не того вида', async () => {
  expect(await preparePlan({ steps: [{ do: 'create_work', project: 'p', title: 'W' }, { do: 'sleep', session: '$1' }] }, ctx)).toEqual({ error: 'Step 2: "$1" is a work, not a session' });
});
it('21 шаг — отказ', async () => {
  expect(await preparePlan({ steps: Array.from({ length: 21 }, () => ({ do: 'sleep', session: 'S03' })) }, ctx)).toEqual({ error: 'A plan has 1 to 20 steps.' });
});
it('неоднозначная роль — отказ с перечнем от resolveRole', async () => { /* role: 'view' при Reviewer и Code Reviewer */ });
it('close — danger, текст под шагом режется до 300 у нескольких шагов', async () => {
  const { plan } = (await preparePlan({ steps: [{ do: 'close', session: 'S02' }, { do: 'message', target: 'Auth', text: 'x'.repeat(1000) }] }, ctx)) as { plan: PreparedPlan };
  expect(plan.view[0]).toMatchObject({ verb: 'close', danger: true, line: 'Close S02 Anna for good' });
  expect(plan.view[1]?.text).toHaveLength(300);
  expect(plan.steps[1]).toMatchObject({ text: 'x'.repeat(1000) });
});
it('add_to_room из другой комнаты — пометка «leaves room»', async () => { /* s-02 в r-2 Gate → 'Add S02 Anna to room "Auth" (leaves room "Gate")' */ });
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @parley/host exec vitest run src/assistant/actions.test.ts`
Expected: FAIL — модуля нет.

- [ ] **Step 3: Implement** `preparePlan`, `stateRefusal` и перенос `memberOf` в `actions.ts`. В `assistant-service.ts` поменять только импорт `memberOf`.

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm --filter @parley/host exec vitest run src/assistant/actions.test.ts src/assistant/assistant-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/assistant/actions.ts packages/host/src/assistant/actions.test.ts packages/host/src/assistant/assistant-service.ts
git commit -m "feat(host): parse and check an assistant plan of actions before it reaches the person"
```

### Task 5: Выполнение плана по шагам

**Files:**
- Create: `packages/host/src/assistant/run-plan.ts`
- Test: `packages/host/src/assistant/run-plan.test.ts`

**Interfaces:**
- Consumes: `PreparedPlan`, `PreparedStep`, `stateRefusal` (задача 4), `ActionsReport` (задача 1), `OverviewSource`.
- Produces:

```ts
export interface PlanExecutors {
  /** Свежий снимок для сверки перед шагом. */
  source(): OverviewSource;
  createWork(input: { projectPath: string; title: string; goal: string }): Promise<string>; // workId
  createSession(input: { projectPath: string; workId: string; provider: string; label: string; task: string; role: SessionRole | null; model: string | null; lean: boolean }): Promise<{ ref: SessionRef; held: boolean }>;
  resume(ref: SessionRef, prompt: string | null): Promise<'started' | 'held'>;
  interrupt(ref: SessionRef): Promise<void>;
  sleep(ref: SessionRef): Promise<void>;
  close(ref: SessionRef): Promise<void>;
  createRoom(input: { projectPath: string; workId: string; title: string; members: string[]; lead: string }): Promise<string>; // roomId
  addMember(input: { projectPath: string; workId: string; roomId: string; sessionId: string }): Promise<void>;
  /** Письмо в комнату с упоминаниями (`withMentions` — у сервиса). */
  roomMessage(input: { projectPath: string; workId: string; roomId: string; to: string[]; text: string; kind: 'note' | 'question' | 'decision' }): Promise<void>;
  /** Письмо сессии: живой — `send`, спящей — подъём этим текстом. `string` — отказ, `null` — ушло. */
  sessionMessage(ref: SessionRef, name: string, text: string): Promise<string | null>;
  lean(): Promise<boolean>;
}
export async function runPlan(proposalId: string, plan: PreparedPlan, exec: PlanExecutors, onProgress: (report: ActionsReport) => void, stop: () => boolean): Promise<ActionsReport>;
```

Как идёт выполнение (спека 6.1):
1. Отчёт — все шаги `waiting`, `status: 'running'`. `onProgress` зовётся после каждой смены статуса шага.
2. Перед шагом `i`:
   - если `stop()`, выполнение останавливается с причиной `Parley is stopping`;
   - известные цели этого шага сверяются в `exec.source()`: `stateRefusal(verb, …)` для сессий, существование и неархивность для работы и комнаты;
   - ссылки `$N` берутся из итогов сделанных шагов. Сессии `$N` в состоянии `pending` годятся, как и у `createHumanRoom`.
3. Итоги шагов:
   - `create_work` — `{ projectPath, workId, title }`;
   - `create_session` — `{ ref, name }`, где `name = participantLabel(map, ref.sessionId)` из свежего снимка;
   - `create_room` — `{ projectPath, workId, roomId, title }`.
4. `create_session`:
   - `lean: await exec.lean()`;
   - `held: true` — шаг сделан, в `notes` пишется `<name> waits for you to trust the folder`;
   - бросило исключение — шаг упал. Если в свежем снимке появилась сессия, которой не было до шага, причина `<message>; <name> was created but did not start; it is in Parley as pending`.
5. `wake`: `exec.resume(ref, text)`; `'held'` — шаг сделан, в `notes` та же пометка.
6. `create_room`: `exec.createRoom`, затем, если есть `task`, `exec.roomMessage({ …, to: [], text: task, kind: 'note' })`. Сбой письма — шаг упал с причиной `room "<title>" was created, but its task was not sent: <message>`.
7. Шаг упал: статус `failed`, у остальных `skipped`, итог `status: 'stopped'`, `failedStep: i + 1`, `reason`. Иначе `status: 'done'`.

- [ ] **Step 1: Write the failing tests.** `exec` — фейки на `vi.fn()`, `source()` отдаёт снимок из массива, который тест меняет:
- `createWork` → `'w-2'`;
- `createSession` по очереди добавляет в снимок работы `w-2` сессии s-01 «Alice» и s-02 «Bob» (`lifecycle: 'pending'`) и отдаёт их ref с `held: false`;
- `lean` → `true`;
- в снимке работы `w-1` s-03 «S03 Ruslan» — active, `working`.

```ts
it('все шаги по порядку; $N подставляется итогом', async () => {
  const report = await runPlan('p1', planWorkSessionsRoom, exec, onProgress, () => false);
  expect(report).toMatchObject({ status: 'done', failedStep: null });
  expect(exec.createRoom).toHaveBeenCalledWith(expect.objectContaining({ workId: 'w-2', members: ['s-01', 's-02'], lead: 's-01' }));
  expect(exec.createSession).toHaveBeenCalledWith(expect.objectContaining({ lean: true, model: null }));
});
it('падение на шаге 3: 4 и 5 не идут, отчёт называет шаг', async () => {
  exec.sleep.mockRejectedValueOnce(new Error('pty is gone'));
  const report = await runPlan('p1', fiveSteps, exec, onProgress, () => false);
  expect(report.steps.map((step) => step.status)).toEqual(['done', 'done', 'failed', 'skipped', 'skipped']);
  expect(report).toMatchObject({ status: 'stopped', failedStep: 3, reason: 'pty is gone' });
  expect(exec.close).not.toHaveBeenCalled();
});
it('сверка перед шагом: сессию усыпили руками между предложением и кликом', async () => {
  snapshot.sessions[0].lifecycle = 'sleeping';
  expect(await runPlan('p1', sleepS03, exec, onProgress, () => false)).toMatchObject({ status: 'stopped', reason: 'S03 Ruslan is already asleep' });
});
it('held у Codex — шаг сделан с пометкой, план идёт дальше', async () => {
  exec.createSession.mockResolvedValueOnce({ ref, held: true });
  const report = await runPlan('p1', sessionThenRoom, exec, onProgress, () => false);
  expect(report).toMatchObject({ status: 'done', notes: ['Alice waits for you to trust the folder'] });
});
it('упавший запуск — остановка с пометкой о записи pending', async () => {
  exec.createSession.mockImplementationOnce(async () => { snapshot.sessions.push(pendingAlice); throw new Error('claude did not start'); });
  expect(await runPlan('p1', sessionThenRoom, exec, onProgress, () => false)).toMatchObject({ reason: 'claude did not start; Alice was created but did not start; it is in Parley as pending' });
});
it('ход виден: onProgress получает running у текущего шага', async () => {
  await runPlan('p1', twoSteps, exec, onProgress, () => false);
  expect(onProgress.mock.calls.map(([report]) => report.steps.map((step) => step.status).join(','))).toContain('running,waiting');
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @parley/host exec vitest run src/assistant/run-plan.test.ts`
Expected: FAIL — модуля нет.

- [ ] **Step 3: Implement** `runPlan` в `run-plan.ts`.

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm --filter @parley/host exec vitest run src/assistant/run-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/assistant/run-plan.ts packages/host/src/assistant/run-plan.test.ts
git commit -m "feat(host): run an assistant plan step by step and stop at the first failure"
```

### Task 6: Сервис помощника — `propose_actions`, подтверждение, отчёт, промпт

**Files:**
- Modify: `packages/host/src/assistant/assistant-service.ts`:
  - `AssistantServiceDeps`, `AssistantService.decide`, `Pending`;
  - `start()`, `decide`, `tool()`, `detailOf`, `stop()`;
  - нынешние `propose*` — отказ по скрытым целям;
  - session-ветка `applyMessage` выносится в общую функцию.
- Modify: `packages/host/src/assistant/assistant-endpoint.ts` (`ASSISTANT_TOOL_NAMES`: `propose_actions` после `propose_room_decision`)
- Modify: `packages/core/src/mcp/assistant.ts` (`propose_actions` после `propose_room_decision`), `packages/core/src/mcp/assistant.test.ts`
- Modify: `packages/core/src/assistant/launch.ts` (`assistantPrompt`), `packages/core/src/assistant/launch.test.ts`
- Test: `packages/host/src/assistant/assistant-service.test.ts`

**Interfaces:**
- Consumes: `preparePlan`, `PlanContext` (задача 4), `runPlan`, `PlanExecutors` (задача 5), `ActionsReport`, `reportLine` (задача 1), `matchConfirm` из `@parley/core/assistant`.
- Produces:
  - `AssistantService.decide(proposalId: string, decision: 'send' | 'cancel', action?: 'actions'): Promise<{ applied: boolean; error: string | null }>`.
  - Новые обязательные поля `AssistantServiceDeps` (их провязывает задача 7):

```ts
createWork(input: Params<'works.create'>): Promise<string>;
createSession(input: Params<'sessions.create'>): Promise<SessionRef & { held?: 'folder-trust' }>;
resume(ref: SessionRef, prompt: string | null): Promise<'started' | 'held'>;
interrupt(ref: SessionRef): void;
stopSession(ref: SessionRef): Promise<void>;
closeSession(ref: SessionRef): Promise<void>;
addRoomMember(input: Params<'rooms.addMember'>): Promise<string>;
roles(projectPath: string): Promise<readonly RoleSummary[]>;
leanAgents(): Promise<boolean>;
/** Готовность провайдера к запуску агента, без проверки версии для помощника. */
providerReady(entry: ProviderEntry): Promise<string | null>;
/** Карточку `actions` есть кому показать: окно с `assistant-actions` или привязанный Telegram. */
actionsShown(): boolean;
```

Поведение:
- `Pending` получает вид `{ kind: 'actions'; view: Extract<AssistantProposal, { action: 'actions' }>; plan: PreparedPlan }`. В сервисе живёт `let running: string | null`.
- `tool('propose_actions')` отказывает так:
  - `running !== null` — 409 `A plan is still running; wait until it ends`;
  - `!deps.actionsShown()` — 409 `No Parley window can show this card; ask the person to open or update Parley`;
  - ошибка `preparePlan` — 400.

  `fallbackProvider` — это `mirror?.defaultProvider ?? null`, `registry` — `await deps.providers()`, `ready` — `deps.providerReady`. Если всё в порядке, сервис ставит `pending` и публикует карточку. Ответ модели — `Shown to the person as a card with the plan; they confirm it with its button only. Tell them in one short sentence what you prepared.`
- `decide` для `pending.kind === 'actions'`:
  - `cancel` — как сейчас, `settle(…, 'cancelled')`;
  - `send` без `action === 'actions'` — `{ applied: false, error: 'Update Parley to confirm this card' }`, `pending` не трогается;
  - `send` при `running !== null` — `{ applied: false, error: 'Another plan is still running' }`, `pending` не трогается;
  - иначе — `pending = null` до первого `await`, `running = id`, `publish({ proposal: null, outcome: null, report: <все waiting> })`. Дальше `void runPlan(…)`, и сразу `{ applied: true, error: null }`: план идёт в фоне, вызов окна не ждёт его конца.

  Каждый шаг публикует `report`. В конце:
  - `running = null`, `touch()`;
  - `publish({ report: final, outcome: 'done', phase: turn === null ? restPhase() : state.phase })`;
  - заметка модели, если разговор тот же: `[system: proposal <id> was done]` (и ` (<notes через "; ">)`, если они есть) или `[system: proposal <id> stopped at step <k> of <n>: <reason>; steps 1–<k-1> done]`. Если сделан один шаг — `step 1 done`, если ни одного — `no steps done`.

  Исполнители `runPlan`:
  - `deps.*` из списка выше. `createSession` собирает вход `sessions.create` так: `{ projectPath, workId, provider, label, task, parent: null, lean, ...(role === null ? {} : { role }), ...(model === null ? {} : { model }) }`. `requestedBy` не передаётся: помощник действует от имени человека, и лимиты агентов на него не распространяются, как у окна;
  - `roomMessage` — `deps.sendLetter` с `withMentions`;
  - `sessionMessage` — общая функция из session-ветки `applyMessage` (`unreachable`, `launch` спящей, `send`, `appendSent`);
  - `stop` — `() => stopped`.
- `report` в `EMPTY` не добавлять: `publish({ ...EMPTY, … })` при ошибках хода тогда не стирает отчёт идущего плана. `reset()` публикует `report: running === null ? null : state.report`.
- `start()`:
  - в `publish` начала хода добавляется `report: null`, если `state.report?.status !== 'running'`;
  - если `pending?.kind === 'actions'` и `matchConfirm(text) === 'send'`, в `prompt` перед текстом ставится строка `[system: a card with actions is waiting; it is confirmed only by its button]`.
- `propose_message`, `propose_room`, `propose_room_decision` и `propose_decision` резолвят с `{ hidden }`. Скрытая цель — 409 `<name> is <closed|archived>; reopen it in Parley first`.
- `detailOf`: `propose_actions` → `{ tool: 'propose', target: null }`.

MCP `propose_actions` (не `readOnlyHint`):
- Описание: `Prepare one card with a plan of actions; the person confirms it with the card's button. Steps: create works and agents (with a role, provider or model only if the person named them), wake, stop (interrupt: the agent stays alive), put to sleep (sleep: it can be woken), close (for good), create rooms, add agents to rooms, send messages. One request of the person is one plan; a single action is a plan of one step. A field that takes a work, room or session accepts an id from parley_overview, an exact name, or "$N" for what step N of this plan creates. Nothing happens until the person clicks.`
- Схема: `steps: { type: 'array', minItems: 1, maxItems: 20, items: { oneOf: [ … ] } }`. Ветки `oneOf` различаются `do` с одним значением `enum`; у `interrupt`, `sleep`, `close` ветка общая, `enum: ['interrupt', 'sleep', 'close']`. Поля и `required` — по таблице разбора из задачи 4. `additionalProperties: false`.

Промпт (спека 7):
- убрать строку `- You cannot start or stop sessions. If asked, say that this is not available.`;
- добавить:

```
- To start, wake, stop, put to sleep or close agents, to create works, agents or rooms, or to add agents to a room, call propose_actions with one plan for the whole request of the person; refer to what an earlier step creates as "$N". "Stop" means interrupt (the agent stays alive), "put to sleep" means sleep (it can be woken later), "close" means close for good; never mix them up. Name a role, provider or model only if the person did. After proposing, say in one short sentence what you prepared. Such a card is confirmed only by its button: if the person answers "yes" in words, ask them to press it.
- [system: proposal … stopped at step N …] means the steps after N did not run: tell the person what was done and what was not.
```

- [ ] **Step 1: Write the failing tests** (`describe('assistant-service: план действий')`; в `deps` из `beforeEach` добавить новые поля с `vi.fn()`, `actionsShown: () => true`, `roles: async () => []`, `leanAgents: async () => true`, `providerReady: async () => null`)

```ts
it('propose_actions → карточка actions с шагами; Send старого окна — отказ, карточка остаётся', async () => {
  const service = await asked();
  expect((await service.tool('propose_actions', { steps: [{ do: 'interrupt', session: 'S03' }] })).status).toBe(200);
  expect(last().proposal).toMatchObject({ action: 'actions', steps: [{ verb: 'interrupt', line: 'Stop what S03 Ruslan is doing', danger: false }] });
  expect(await service.decide('p1', 'send')).toEqual({ applied: false, error: 'Update Parley to confirm this card' });
  expect(service.state().proposal).not.toBeNull();
});
it('клик с action: actions — шаги идут, отчёт и заметка модели', async () => {
  const service = await asked();
  await service.tool('propose_actions', { steps: [{ do: 'interrupt', session: 'S03' }, { do: 'sleep', session: 'S03' }] });
  expect(await service.decide('p1', 'send', 'actions')).toEqual({ applied: true, error: null });
  await vi.waitFor(() => expect(last().report).toMatchObject({ status: 'done' }));
  expect(deps.interrupt).toHaveBeenCalledBefore(deps.stopSession as never);
  await service.ask({ ...ASK, text: 'дальше' });
  expect(turns.at(-1)?.spec.args[1]).toMatch(/^\[system: proposal p1 was done\]/);
});
it('двойное подтверждение — план выполняется один раз', async () => {
  const service = await asked();
  await service.tool('propose_actions', { steps: [{ do: 'sleep', session: 'S03' }] });
  const [first, second] = await Promise.all([service.decide('p1', 'send', 'actions'), service.decide('p1', 'send', 'actions')]);
  expect([first.applied, second.applied].sort()).toEqual([false, true]);
  await vi.waitFor(() => expect(last().report?.status).toBe('done'));
  expect(deps.stopSession).toHaveBeenCalledTimes(1);
});
it('второй план, пока идёт первый, — 409', async () => {
  (deps.stopSession as Mock).mockImplementation(() => new Promise(() => {})); // первый план висит
  const service = await asked();
  await service.tool('propose_actions', { steps: [{ do: 'sleep', session: 'S03' }] });
  await service.decide('p1', 'send', 'actions');
  expect(await service.tool('propose_actions', { steps: [{ do: 'interrupt', session: 'S03' }] })).toEqual({ status: 409, body: { error: 'A plan is still running; wait until it ends' } });
});
it('нет окна с признаком и нет Telegram — ошибка модели, карточки нет', async () => {
  const service = await asked({ actionsShown: () => false });
  expect(await service.tool('propose_actions', { steps: [{ do: 'sleep', session: 'S03' }] })).toMatchObject({ status: 409 });
  expect(last().proposal).toBeNull();
});
it('«да» словами при карточке actions — системная строка в ходе, не выполнение', async () => {
  const service = await asked();
  await service.tool('propose_actions', { steps: [{ do: 'sleep', session: 'S03' }] });
  turns[0]?.end({ ok: true });
  await flush();
  await service.ask({ ...ASK, text: 'Да' }, 'telegram');
  expect(turns.at(-1)?.spec.args[1]).toContain('[system: a card with actions is waiting; it is confirmed only by its button]');
  expect(deps.stopSession).not.toHaveBeenCalled();
});
it('падение шага: заметка stopped at step', async () => { /* stopSession бросает → [system: proposal p1 stopped at step 2 of 2: …; step 1 done] */ });
it('провайдер по умолчанию — из зеркала окна', async () => {
  const service = await asked();
  service.configure({ enabled: true, provider: null, model: null, language: 'ru', voiceModel: null, defaultProvider: 'codex' });
  await service.tool('propose_actions', { steps: [{ do: 'create_session', work: 'Parley' }] });
  expect(last().proposal).toMatchObject({ steps: [{ line: expect.stringContaining('· Codex') }] });
});
it('закрытая цель старой карточки — «reopen it in Parley first»', async () => {
  const service = await asked();
  expect(await service.tool('propose_message', { target: closedS09Id, text: 'hi' })).toEqual({ status: 409, body: { error: 'S09 Old is closed; reopen it in Parley first' } });
});
```

`asked(over?)` — новый помощник файла: `createAssistantService({ ...deps, ...over })` и `await service.ask(ASK)`. В фейковый реестр `providers` добавить `codex` с `label: 'Codex'`. Порядок вызовов проверяется через `mock.invocationCallOrder`, если в проекте нет матчера `toHaveBeenCalledBefore`.

В `core/src/mcp/assistant.test.ts` список инструментов получает `propose_actions` после `propose_room_decision`, тест называется `четырнадцать` (вместе с планом 1). Ещё одна проверка:

```ts
const items = (byName('propose_actions').inputSchema.properties as { steps: { items: { oneOf: Array<{ properties: { do: { enum: string[] } } }> } } }).steps.items.oneOf;
expect(items.flatMap((branch) => branch.properties.do.enum)).toEqual(['create_work', 'create_session', 'wake', 'interrupt', 'sleep', 'close', 'create_room', 'add_to_room', 'message']);
```

В `launch.test.ts`: промпт не содержит `You cannot start or stop sessions`, содержит `call propose_actions with one plan for the whole request` и `confirmed only by its button`.

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @parley/core exec vitest run src/mcp/assistant.test.ts src/assistant/launch.test.ts && pnpm --filter @parley/host exec vitest run src/assistant/assistant-service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** в сервисе, MCP, endpoint и промпте.

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm --filter @parley/core exec vitest run src/mcp src/assistant src/english-text.test.ts && pnpm --filter @parley/host exec vitest run src/assistant`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/assistant packages/core/src/mcp packages/core/src/assistant
git commit -m "feat(assistant): propose a plan of actions on one card and run it on the person's click"
```

### Task 7: Проводка в хосте

**Files:**
- Modify: `packages/host/src/host.ts:577–616` (зависимости `createAssistantService`)
- Modify: `packages/host/src/methods/assistant.ts:15` (`decide` передаёт `params.action`)
- Test: `packages/host/src/methods/assistant.test.ts` (создать, если нет)

**Interfaces:**
- Consumes: новые поля `AssistantServiceDeps` (задача 6), `ASSISTANT_ACTIONS_FEATURE` (задача 1).
- Produces: рабочий хост. Новых экспортов нет.

Провязка зависимостей:

| Поле | Чем провязать |
|---|---|
| `createWork` | `async (input) => (await createWork(input.projectPath, { title: input.title, goal: input.goal })).work.id`, как `worksCreate` (`methods/works.ts:46`) |
| `createSession` | `(input) => sessionsService.create(input)` |
| `resume` | `(ref, prompt) => sessionsService.launch(ref, 'resume', { by: 'human', ...(prompt === null ? {} : { prompt }) })` |
| `interrupt` | `(ref) => feedService.interrupt(ref)` |
| `stopSession`, `closeSession` | `sessionsService.stop`, `sessionsService.close` |
| `addRoomMember` | `addRoomMember` из `rooms/rooms-service.ts:215` |
| `roles` | `async (projectPath) => roleSummaries(await roleCatalog(projectPath, { codex: true })).roles` — общий кеш `roleCatalog` (`host.ts:415`) |
| `leanAgents` | `async () => (await loadConfig()).config.leanAgents` |
| `providerReady` | нынешнее тело `ready` до проверки `ASSISTANT_MIN_VERSIONS` вынести в функцию `sessionReady(entry)`; `ready` зовёт её и потом проверяет версию |
| `actionsShown` | `() => handle.context.clients().some((client) => client.features.has(ASSISTANT_ACTIONS_FEATURE)) \|\| (telegram.status().enabled && telegram.status().owner !== null)` — `telegram` создаётся ниже, но зовётся уже после запуска, как `onReminderWhileOff` |

- [ ] **Step 1: Write the failing test** — `decide` передаёт поле:

```ts
it('assistant.decide передаёт action сервису', async () => {
  const decide = vi.fn().mockResolvedValue({ applied: true, error: null });
  const handlers = createAssistantHandlers({ decide } as unknown as AssistantService);
  await handlers['assistant.decide']!({ proposalId: 'p1', decision: 'send', action: 'actions' }, context);
  expect(decide).toHaveBeenCalledWith('p1', 'send', 'actions');
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @parley/host exec vitest run src/methods/assistant.test.ts`
Expected: FAIL — третий аргумент не передаётся.

- [ ] **Step 3: Implement** правку `methods/assistant.ts` и провязку в `host.ts`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @parley/host exec vitest run src/methods src/assistant src/telegram && pnpm --filter "@parley/host^..." build && pnpm --filter @parley/host exec tsc --noEmit -p tsconfig.json`
Expected: PASS, без ошибок типов.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/host.ts packages/host/src/methods/assistant.ts packages/host/src/methods/assistant.test.ts
git commit -m "feat(host): wire the assistant plan to works, sessions, rooms and roles"
```

### Task 8: Остров и окно — карточка шагов, кнопка, отчёт, признак и умолчание провайдера

**Files:**
- Modify: `packages/desktop/src/renderer/island/assistant/AssistantView.tsx`:
  - `confirmLabel` (81–97), `cardBody` (111–197), `submit` (235–238);
  - подсказка под кнопками (321) и блок исхода (300–308).
- Modify: `packages/desktop/src/renderer/island/assistant/store.ts` (`submit` 509–526, `decide` 533–547)
- Modify: `packages/desktop/src/shared/strings.ts` (блок `assistant`, с 2445)
- Modify: `packages/desktop/src/main/host-connection.ts:394` (`features` + `ASSISTANT_ACTIONS_FEATURE`)
- Modify: `packages/desktop/src/main/assistant-mirror.ts:11–25` (`defaultProvider: ui.lastProvider`)
- Test: `AssistantView.test.tsx`, `store.test.ts` (оба в `packages/desktop/src/renderer/island/assistant/`), `packages/desktop/src/main/assistant-mirror.test.ts`

**Interfaces:**
- Consumes: `ActionStepView`, `ActionsReport`, `reportLine`, `ASSISTANT_ACTIONS_FEATURE` (задача 1).
- Produces: —

Строки (`S.assistant.card`):
- `stop: 'Stop'`, `putToSleep: 'Put to sleep'`, `close: 'Close'`, `wake: 'Wake'`, `add: 'Add'`;
- `doAll: (n: number) => \`Do all (${n})\``;
- `closesForGood: 'closes for good'`;
- `confirmByButton: 'Confirm with the button'`.

Создать — нынешний `S.assistant.card.create`, письмо — `S.assistant.send`.

Карточка `actions`:
- **Кнопка.** У одного шага глагол по `verb`: `create_*` — Create, `wake` — Wake, `interrupt` — Stop, `sleep` — Put to sleep, `close` — Close, `add_to_room` — Add, `message` — Send. У нескольких — `doAll(n)`.
- **Тело.** `<ol data-testid="assistant-steps">`, в нём `<li data-testid="assistant-step">` на шаг: номер, `line`, под ней `text` (если не `null`) в той же рамке с акцентной полосой, что у письма. У `danger` строка в цвете destructive-кнопок окна и дописка `closes for good`. Длинные значения переносятся (`[overflow-wrap:anywhere]`).
- **Подтверждение.** Enter в пустом поле карточку `actions` не подтверждает. Подсказка вместо `enterToSend` — `confirmByButton`.
- **Отчёт.** Если `host.report != null` и карточки нет (`proposal === null`), вместо `assistant-done` рисуется `<div data-testid="assistant-report">`:
  - строки шагов со значком статуса: `✓` done, `✗` failed, `…` running, `–` skipped, тусклый waiting;
  - строка `reportLine(report)`;
  - под ней `notes`.

Стор:
- `submit`: при `answer === 'send'` и `proposal.action === 'actions'` текст уходит вопросом в очередь, как любой другой, а не в `decide`. `cancel` по-прежнему решает.
- `decide`: `deps.call('assistant.decide', { proposalId, decision, ...(proposal.action === 'actions' ? { action: 'actions' } : {}) })`.

- [ ] **Step 1: Write the failing tests**

`AssistantView.test.tsx`, `describe('карточки по action')`:

```ts
const ACTIONS = { action: 'actions', id: 'p7', target: '2 steps', where: 'Parley · my_harnas', text: 'Update Parley…', steps: [
  { verb: 'sleep', line: 'Put S03 Ruslan to sleep', text: null, danger: false },
  { verb: 'close', line: 'Close S05 Vera for good', text: null, danger: true },
] } as const;
it('карточка шагов: строки, предупреждение у close, «Do all (2)»', () => {
  render(<AssistantView {...props({}, { phase: 'awaiting-confirm', proposal: ACTIONS })} />);
  expect(screen.getAllByTestId('assistant-step').map((el) => el.textContent)).toEqual([expect.stringContaining('Put S03 Ruslan to sleep'), expect.stringContaining('closes for good')]);
  expect(screen.getByTestId('assistant-send').textContent).toContain('Do all (2)');
});
it('один шаг — глагол шага на кнопке', () => { /* steps: [sleep] → 'Put to sleep' */ });
it('Enter в пустом поле не подтверждает карточку actions', () => {
  const onDecide = vi.fn();
  render(<AssistantView {...props({ onDecide }, { phase: 'awaiting-confirm', proposal: ACTIONS })} />);
  act(() => { vi.advanceTimersByTime(500); });
  submitForm();
  expect(onDecide).not.toHaveBeenCalled();
});
it('отчёт: остановка на шаге и пометки', () => {
  render(<AssistantView {...props({}, { report: { proposalId: 'p7', status: 'stopped', steps: [{ line: 'a', status: 'done' }, { line: 'b', status: 'failed' }], failedStep: 2, reason: 'S05 Vera is already asleep', notes: ['Alice waits for you to trust the folder'] } })} />);
  expect(screen.getByTestId('assistant-report').textContent).toContain('Stopped at step 2 of 2: S05 Vera is already asleep');
  expect(screen.getByTestId('assistant-report').textContent).toContain('Alice waits for you to trust the folder');
});
```

`store.test.ts`:

```ts
it('«да» при карточке actions — вопрос, а не решение', async () => {
  const { store, deps } = setup();
  store.getState().applyHost({ ...HOST_IDLE, phase: 'awaiting-confirm', proposal: ACTIONS });
  await store.getState().submit('да');
  expect(deps.call).not.toHaveBeenCalledWith('assistant.decide', expect.anything());
  expect(deps.call).toHaveBeenCalledWith('assistant.ask', expect.objectContaining({ text: 'да' }));
});
it('решение по карточке actions — с action: actions', async () => {
  /* decide('send') → deps.call('assistant.decide', { proposalId: 'p7', decision: 'send', action: 'actions' }) */
});
```

`assistant-mirror.test.ts`: `assistantSettingsOf(ui с lastProvider: 'codex', …)` даёт `defaultProvider: 'codex'`; `lastProvider: null` — `defaultProvider: null`.

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @parley/desktop exec vitest run src/renderer/island/assistant src/main/assistant-mirror.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** вид, стор, строки, признак и зеркало.

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm --filter @parley/desktop exec vitest run src/renderer/island src/main src/english-ui.test.ts && pnpm typecheck`
Expected: PASS, typecheck без ошибок.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src
git commit -m "feat(desktop): show the assistant plan card on the island and confirm it by click only"
```

### Task 9: Telegram — карточка шагов, итог плана в квитанции

**Files:**
- Modify: `packages/host/src/telegram/cards.ts` (`confirmLabel` 104–118, `assistantBody` 120–149)
- Modify: `packages/host/src/telegram/texts.ts` (`B`, `T`, `ReceiptKind`)
- Modify: `packages/host/src/telegram/assistant-bridge.ts` (`onState` 69–96, `onCallback` 123–126, тип `closeCard`)
- Modify: `packages/host/src/telegram/service.ts:855` (`closeAssistantCard`) и `:1230` (передача `closeCard`)
- Test: `packages/host/src/telegram/cards.test.ts`, `packages/host/src/telegram/assistant-bridge.test.ts`

**Interfaces:**
- Consumes: `ActionsReport`, `reportLine` (задача 1), `decide(…, action?)` (задача 6).
- Produces:
  - `export const ASSISTANT_CARD_MAX = 4000` — запас до 4096 под квитанцию;
  - `closeCard(proposalId: string, receipt: 'sent' | 'done' | 'stopped' | 'cancelled' | 'current', extra?: string): Promise<void>` в зависимостях моста;
  - `closeAssistantCard(proposalId, receipt, extra?)` — `extra` экранируется `escapeHtml` и идёт под строкой квитанции через `\n`.

Тексты:
- `B.stop = 'Stop'`, `B.putToSleep = 'Put to sleep'`, `B.close = 'Close'`, `B.wake = 'Wake'`, `B.add = 'Add'`;
- `B.doAll = (n: number) => \`Do all (${n})\``;
- `T.assistantPlan = (where: string) => \`Plan in ${where}\``;
- `T.closesForGood = 'closes for good'`;
- `ReceiptKind` + `'stopped'` → `'Stopped'`.

Карточка `actions`:
- Кнопка — как на острове (задача 8).
- Тело: `T.assistantPlan(where)`, затем строки `<b>N.</b> <line>`. У `danger` после строки ` — closes for good`, под строкой `pre(text)`, если текст есть.
- Целиком больше `ASSISTANT_CARD_MAX` — тексты шагов режутся до 100 знаков; всё ещё больше — тексты убираются; всё ещё больше — строки режутся до 120 знаков.

Мост:
- `onCallback(proposalId, code)`:
  - зовёт `deps.assistant.decide(proposalId, code, current?.id === proposalId && current.action === 'actions' ? 'actions' : undefined)`, где `current = deps.assistant.state().proposal`;
  - возвращает `result.applied ? (result.error ?? '') : (result.error ?? T.noLongerCurrent)`.
- `onState`:
  - карточка ушла из `proposal`, а `state.report?.proposalId === lastProposal` и `status === 'running'` — её id запоминается в `runningPlan` и не закрывается. Это делается до строки `lastProposal = …` и только если id был в `cards`, то есть карточка ушла в чат;
  - потом `report` того же id с `status` `done` или `stopped` — `closeCard(id, status === 'done' ? 'done' : 'stopped', [status === 'stopped' ? reportLine(report) : null, ...report.notes].filter(Boolean).join('\n') || undefined)`.

- [ ] **Step 1: Write the failing tests**

`cards.test.ts`:

```ts
it('карточка плана: шаги, close с предупреждением, «Do all (2)»', () => {
  const { text, keyboard } = assistantCardMessage(ACTIONS);
  expect(text).toContain('Plan in Parley · my_harnas');
  expect(text).toContain('<b>2.</b> Close S05 Vera for good — closes for good');
  expect(keyboard[0]?.[0]).toEqual({ text: 'Do all (2)', callback_data: 'pa1:p7:send' });
});
it('20 шагов с текстами по 300 знаков влезают в 4096', () => {
  const steps = Array.from({ length: 20 }, (_, i) => ({ verb: 'message', line: `Message room "Room with a very long name number ${i}"`, text: 'x'.repeat(300), danger: false }));
  expect(assistantCardMessage({ ...ACTIONS, steps }).text.length).toBeLessThanOrEqual(4000);
});
```

`assistant-bridge.test.ts`:

```ts
it('кнопка карточки actions — decide с action: actions; ошибка — в тосте', async () => {
  assistant.state.mockReturnValue({ ...STATE, proposal: ACTIONS });
  assistant.decide.mockResolvedValue({ applied: false, error: 'Another plan is still running' });
  expect(await bridge.onCallback('p7', 'send')).toBe('Another plan is still running');
  expect(assistant.decide).toHaveBeenCalledWith('p7', 'send', 'actions');
});
it('план остановился — квитанция «Stopped» с шагом и причиной', async () => {
  emit({ ...STATE, proposal: ACTIONS });
  emit({ ...STATE, proposal: null, outcome: null, report: { ...REPORT, status: 'running' } });
  expect(closeCard).not.toHaveBeenCalled();
  emit({ ...STATE, proposal: null, outcome: 'done', report: { ...REPORT, status: 'stopped', failedStep: 2, reason: 'S05 Vera is already asleep' } });
  expect(closeCard).toHaveBeenCalledWith('p7', 'stopped', 'Stopped at step 2 of 2: S05 Vera is already asleep');
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @parley/host exec vitest run src/telegram/cards.test.ts src/telegram/assistant-bridge.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** в четырёх файлах.

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm --filter @parley/host exec vitest run src/telegram`
Expected: PASS, весь каталог Telegram.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/telegram
git commit -m "feat(telegram): show the assistant plan card and report where the plan stopped"
```

### Task 10: E2E — карточка из шести шагов в 800×500 и план из одного шага кликом

**Files:**
- Modify: `packages/desktop/e2e/stub-assistant-agent.mjs` (ветки по началу вопроса, рядом с `create room`, строка 48)
- Modify: `packages/desktop/e2e/assistant.spec.ts`
- Test: тот же spec

**Interfaces:**
- Consumes: всё выше. Для заглушки — `(project <имя>)` и id из ответа `parley_overview`, как сейчас берутся `work` и `session` (строки 40–41 заглушки).
- Produces: —

Ветки заглушки:
- **`plan six`** — `propose_actions` с шестью шагами:
  1. `create_work` в проекте из обзора с названием в 90 знаков (`A very long work title that checks how the plan card wraps inside a narrow island`);
  2. `create_session { work: '$1', name: 'Reviewer with a rather long display name', role: <самая длинная из встроенных ролей, сейчас 'Feature Lead'>, task: <500 знаков> }`;
  3. `create_session { work: '$1' }`;
  4. `create_room { work: '$1', title: <80 знаков>, members: ['$2', '$3'], task: <500 знаков> }`;
  5. `message { target: '$4', text: <500 знаков> }`;
  6. `create_session { work: '$1', name: 'Third' }`.

  Ответ — `[[calm]] Prepared a plan card.`
- **`plan one`** — `propose_actions` с одним шагом `create_work { project, title: 'E2E plan work' }`.

Тесты в `assistant.spec.ts` (как соседние: `launchWithAssistant`, `resizeMain(app, 800, 500)`, `openAssistant`, `ask`):

```ts
test('карточка плана из шести шагов: всё в кадре 800×500, Enter не подтверждает, Cancel', async () => {
  // ask(island, 'plan six')
  await expect(island.getByTestId('assistant-step')).toHaveCount(6);
  await expect(island.getByTestId('assistant-send')).toHaveText(/Do all \(6\)/);
  // кнопка и поле в кадре острова — тем же способом, что шаг 7 первого теста (строки 279–295)
  await island.waitForTimeout(600);
  await island.getByRole('textbox').press('Enter');
  await expect(island.getByTestId('assistant-card')).toBeVisible();
  await island.screenshot({ path: test.info().outputPath('plan-six.png') });
  await island.getByTestId('assistant-cancel').click();
  await expect(island.getByText('Cancelled')).toBeVisible();
});
test('план из одного шага выполняется кликом', async () => {
  // ask(island, 'plan one'); кнопка — 'Create'; ждать 600 мс взвода; клик
  await expect(island.getByTestId('assistant-report')).toContainText('Done');
});
```

- [ ] **Step 1: Write the tests and the stub branches** (выше)
- [ ] **Step 2: Run E2E**

Сначала `uptime`; при load ≥ числа ядер — подождать.

Run: `pnpm --filter "@parley/desktop^..." build && pnpm --filter @parley/desktop build && pnpm --filter @parley/desktop exec playwright test e2e/assistant.spec.ts`
Expected: PASS, весь `assistant.spec.ts`, в том числе прежние тесты карточек.

- [ ] **Step 3: Посмотреть снимок `plan-six.png` глазами** (исполнитель отдаёт путь). Длинные строки переносятся, не вылезают за остров, кнопки видны.
- [ ] **Step 4: Commit**

```bash
git add packages/desktop/e2e/stub-assistant-agent.mjs packages/desktop/e2e/assistant.spec.ts
git commit -m "test(desktop): cover the assistant plan card at 800x500 and a one-step plan run"
```

---

## Порядок и волны

Задачи 1–7 идут по очереди: каждая опирается на интерфейсы предыдущей. Задачи 8 (окно) и 9 (Telegram в хосте) не пересекаются по файлам и идут одной волной после 7. Задача 10 — последней.

## После плана

Нужны полный `pnpm lint`, `pnpm test` и `pnpm typecheck`. Живую приёмку (спека 10, последний пункт) делает автор на собранном окне. Ветку пушит исполнитель после итогового ревью, PR открывает автор по ссылке compare (`gh` не установлен).
