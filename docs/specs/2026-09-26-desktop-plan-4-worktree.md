# План, этап 4: worktree

Дата: 2026-09-26. Индекс и общие правила — `2026-09-26-desktop-plan.md`. Спека —
`2026-09-26-desktop-design.md`, разделы 8, 10, 14.

**Итог этапа:** две сессии правят один файл в своих worktree, результат одной влит,
вторая отброшена.

**Решение открытого вопроса спеки 14:** стиль слияния — merge-коммит
(`git merge --no-ff`). Squash — после v1. В 4.4 это записывается в спеку.

**Перед стартом:** сверить `SessionsService`, `plan*` в `core/work/launch.ts`,
`panel-registry` и `NewSessionDialog` с кодом этапов 1–3.

---

## 4.1. core: worktree

**Зачем.** Всё, что касается git worktree, — чистые функции ядра поверх git CLI.
**Зависит от:** этап 3. **Спека:** 8.1, 8.2.

**Файлы**
- Создать `packages/core/src/work/worktree.ts` и тест на настоящем git во временных
  каталогах.
- Изменить в `packages/core/src/`:
  - `work/types.ts` — `WorktreeInfo`, поле `worktree` у сессии;
  - `work/map.ts` — по умолчанию `worktree: null`;
  - `work/launch.ts` — `cwd` берётся из `worktree.path`;
  - `mcp/tools.ts` — `spawn_session.worktree`;
  - `config.ts` — `worktreeRoot`;
  - `index.ts`.

**Интерфейсы**

```ts
// work/types.ts
export interface WorktreeInfo { path: string; branch: string; base: string; createdAt: string | null } // null — ещё не создан
export interface WorkSession { /* … */ worktree: WorktreeInfo | null }

// config.ts: worktreeRoot — строка, по умолчанию '~/harnas/worktrees' (тильда раскрывается), переменная HARNAS_WORKTREE_ROOT

// work/worktree.ts
/** Путь <root>/<basename(project)>-<sha1(project)[0..6]>/<workId>-<S03>, ветка harnas/<workId>/<s03>. */
export function plannedWorktree(projectPath: string, workId: string, sessionId: string, base: string, root: string): WorktreeInfo;
export async function isGitRepo(projectPath: string): Promise<boolean>;
/** Ветка checkout; при detached HEAD — SHA коммита. */
export async function baseBranchOf(checkoutPath: string): Promise<string>;
export async function createWorktree(projectPath: string, info: WorktreeInfo): Promise<void>; // git worktree add <path> -b <branch> <base>
export interface WorktreeDiff {
  patch: string;                                                     // merge-base..branch плюс незакоммиченное в worktree
  files: Array<{ path: string; status: 'A' | 'M' | 'D' | 'R' }>;
  uncommitted: boolean;
  baseCheckout: string | null;                                       // где выгружена ветка base
  baseDirty: boolean;
}
export async function worktreeDiff(projectPath: string, info: WorktreeInfo): Promise<WorktreeDiff>;
export async function commitWorktree(info: WorktreeInfo, message: string): Promise<string>; // git add -A && git commit → sha
export type MergeResult =
  | { ok: true; commit: string }
  | { ok: false; reason: 'base_not_checked_out' | 'base_dirty' | 'uncommitted' | 'conflict'; files: string[] };
export async function mergeWorktree(projectPath: string, info: WorktreeInfo, message: string): Promise<MergeResult>;
export class DirtyWorktreeError extends Error {}
export async function discardWorktree(projectPath: string, info: WorktreeInfo, options?: { force?: boolean }): Promise<void>;
```

**Правила**
- **Команды git:** только через `execFile` с массивом аргументов, без `shell: true`.
  Пути с пробелами работают.
- **`mergeWorktree`:**
  - checkout с веткой `base` ищется в `git worktree list --porcelain` — это может
    быть основной каталог или worktree родителя; не найден →
    `base_not_checked_out`;
  - этот checkout грязный → `base_dirty`;
  - в worktree сессии есть незакоммиченное → `uncommitted`;
  - иначе `git -C <baseCheckout> merge --no-ff <branch> -m <message>`;
  - конфликт → список из `git diff --name-only --diff-filter=U`, затем
    `git merge --abort`, и база остаётся чистой.
- **`discardWorktree`** — `git worktree remove [--force] <path>`, затем
  `git branch -D <branch>`. Без `force` на грязном worktree —
  `DirtyWorktreeError`.
- **`spawn_session { …, worktree: true }`:**
  - проект не git → ошибка «в проекте нет git»;
  - база — ветка worktree родителя, если он в worktree, иначе
    `baseBranchOf(projectPath)`;
  - в карту пишется `plannedWorktree(…)` с `createdAt: null`. Сам worktree создаёт
    хост при запуске (4.2).
- **План запуска.** Если у сессии `worktree` задан, `cwd` = `worktree.path` во всех
  трёх режимах, включая `resume`. `claude --resume` ищет транскрипт по каталогу.

**Тесты** (временные репозитории, git из PATH)
1. `plannedWorktree`: формат пути и ветки; хеш устойчив; путь проекта с пробелом.
2. `createWorktree` → каталог и ветка есть.
3. `worktreeDiff` видит и коммит в ветке, и незакоммиченный файл; `uncommitted: true`.
4. `mergeWorktree`:
   - чистая база → merge-коммит с двумя родителями;
   - грязная база → `base_dirty`;
   - база нигде не выгружена → `base_not_checked_out`;
   - незакоммиченное в worktree → `uncommitted`;
   - конфликт → `conflict` со списком файлов, база после этого чиста.
5. `discardWorktree`: грязный без `force` → `DirtyWorktreeError`; с `force` — каталога
   и ветки нет.
6. `baseBranchOf` при detached HEAD даёт SHA.
7. `spawn_session(worktree: true)`:
   - в не-git проекте → ошибка;
   - у ребёнка сессии в worktree база — ветка родителя.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] В коде нет `shell: true` и склейки команд строкой.

---

## 4.2. Хост: worktree в запуске и методы

**Зачем.** Хост создаёт worktree перед запуском, отдаёт окну дифф и выполняет
«влить», «закоммитить» и «отбросить».
**Зависит от:** 4.1. **Спека:** 8.1–8.3, 10.

**Файлы**
- Создать `packages/host/src/worktrees/worktrees-service.ts`, `methods/worktrees.ts` и
  тесты.
- Изменить:
  - `packages/host/src/sessions/sessions-service.ts` — создание worktree перед
    `launch`, удаление вместе с сессией;
  - `packages/host/src/activity/activity-service.ts` — `trust-wait`;
  - протокол.

**Интерфейсы**

```ts
// host/sessions/sessions-service.ts — расширение из 1.7
export interface CreateSessionInput { /* …из 1.7… */ worktree?: boolean }

// протокол
'sessions.create': /* +*/ worktree: z.boolean().optional()
'sessions.delete': /* +*/ force: z.boolean().optional()
'worktrees.available': z.object({ projectPath: z.string() })                     // → { available: boolean } — isGitRepo
'worktrees.diff': z.object({ ref: sessionRef })                                   // → WorktreeDiff
'worktrees.commit': z.object({ ref: sessionRef, message: z.string().min(1) })     // → { commit: string }
'worktrees.merge': z.object({ ref: sessionRef })                                  // → MergeResult
'worktrees.discard': z.object({ ref: sessionRef, force: z.boolean() })            // → { ok: true }
// NoticeKind += 'trust-wait'
```

**Поведение**
- **Перед запуском.** Сессия с `worktree.createdAt === null` → `createWorktree`, затем
  `createdAt` в карту. Ошибка git:
  - `launch-failed`;
  - письмо от `system` родителю «worktree для S05 не создан: <текст git>»;
  - сессия остаётся `pending`.
- **`sessions.create { worktree: true }`** — `plannedWorktree`, как у
  `spawn_session`.
- **Доверие к папке.** Сессия в worktree запущена, но за `trustWaitMs` (20 000) не
  пришло ни одного хука → `host.notice { kind: 'trust-wait', text: 'S05 не отвечает с
  запуска — возможно, ждёт доверия к папке' }`.
- **Слияние.** `worktrees.merge` вызывает `mergeWorktree` с сообщением
  `harnas: влить S03 (<ярлык>) из <branch>`.
- **Отбросить.** `worktrees.discard` останавливает PTY, делает `discardWorktree` и
  переводит сессию в `lifecycle: 'closed'`.
- **Удаление сессии с worktree.** Грязный worktree без `force` → `conflict`. С `force`
  — `discardWorktree({ force: true })` и `deleteSession`.

**Тесты** (настоящий git и stub)
1. `sessions.create { worktree: true }` → `cwd` stub (из `STUB_ARGS_FILE`) — путь
   worktree; в карте `createdAt`.
2. Сессия от `spawn_session(worktree: true)` поднята autoLaunch → worktree создан до
   запуска.
3. Ошибка git (ветка уже существует) → `launch-failed` и письмо от `system` родителю.
4. Stub без хуков, `trustWaitMs: 200` → `trust-wait`.
5. `diff` → `commit` → `merge` проходят по цепочке; `merge` при грязной базе →
   `base_dirty`.
6. `discard` → процесса нет, каталога нет, сессия `closed`.
7. Удаление грязной сессии без `force` → `conflict`; с `force` — всё убрано.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 4.3. Окно: флажок, «Изменения», влить и отбросить

**Зачем.** Изоляцию включают мышью, а результат видно и забирают из окна.
**Зависит от:** 4.2. **Спека:** 5.1, 8.2, 8.3.

**Файлы**
- Создать в `packages/desktop/src/renderer/`:
  - `components/changes/ChangesPanel.tsx`, `DiffView.tsx`;
  - `lib/diff.ts`;
  - тесты рядом.
- Изменить:
  - `components/dialogs/NewSessionDialog.tsx` — флажок «в своём worktree»;
  - `components/sidebar/SessionMenu.tsx` — пункт «Изменения»;
  - `components/settings/SettingsDialog.tsx` — поле `worktreeRoot`;
  - `components/layout/panel-registry.ts` — `changes`;
  - `package.json` desktop — `react-diff-view` и `gitdiff-parser`. HTML-строк и
    `dangerouslySetInnerHTML` нет.

**Поведение**
- **Флажок.** Неактивен, если `worktrees.available` вернул `false` для проекта.
  `branches` для этого не годится: при detached HEAD ветки нет и у git-проекта.
- **Настройки.** Поле `worktreeRoot` в `SettingsDialog.tsx`.
- **Панель «Изменения»** (`worktrees.diff`): список файлов со статусами и дифф по
  файлам.
- **Кнопки:**
  - «Закоммитить всё» — при `uncommitted`; поле сообщения → `worktrees.commit`;
  - «Влить в `<base>`» — неактивна при `baseDirty` или `uncommitted`, с подсказкой
    почему;
  - «Отбросить» — подтверждение. Если worktree грязный — второе подтверждение
    «Незакоммиченные изменения будут потеряны», затем `force: true`.
- **Конфликт** → список файлов и кнопка «Поручить агенту». Она отправляет
  `rooms.send` этой сессии: `kind: 'question'`, текст «Слияние S03 упёрлось в
  конфликт: <файлы>. Разреши и закоммить».
- **`trust-wait`** — пометка в строке сессии и уведомление macOS.

**Тесты**
1. Флажок неактивен для не-git проекта и активен для git-проекта с detached HEAD.
2. Дифф: файлы и ханки отрисованы; бинарный файл — строкой «двоичный файл».
3. «Влить» неактивна при `baseDirty` и при `uncommitted`; подсказка называет причину.
4. «Поручить агенту» шлёт письмо с именами файлов.
5. «Отбросить» грязного worktree требует двух подтверждений и шлёт `force: true`.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 4.4. Документы и живая приёмка этапа 4

**Файлы**
- `README.md` — worktree: флажок, «Изменения», влить и отбросить, где лежат копии.
- `TODOS.md` — хвосты этапа и v1 целиком.
- Спека:
  - §8.3 и §12, допущение 2 — итог проверки доверия;
  - §14 — стиль слияния решён: `--no-ff`.

**Живая приёмка** (человек, настоящий `claude`)
- [ ] Две сессии в своих worktree правят один файл.
- [ ] Результат одной влит (merge-коммит в базе), вторая отброшена (нет ни каталога,
      ни ветки).
- [ ] Доверие к `worktreeRoot` проверено (допущение 2), итог записан в спеку. Если
      доверие не наследуется — пришло уведомление, и клик в панели запустил сессию.
- [ ] Сессия в worktree поднимается письмом, `--resume` идёт из каталога worktree.
