# План, этап 1: облик

Дата: 2026-09-27. Индекс и общие правила — `2026-09-26-desktop-orca-ui-plan.md`. Спека —
`2026-09-26-desktop-orca-ui-design.md`, разделы 3.4, 4, 14.4.

**Итог этапа.** Нынешнее окно в облике Orca:
- токены, шрифт Geist, примитивы shadcn/ui, значки состояний;
- палитра терминала Ghostty Dark / Tango Light, тема по системе.

dockview ещё на месте: он уходит в этапе 2, его вкладки получают только цвета токенов.

**Перед стартом.** Сверить с кодом:
- `src/shared/bridge.ts` (`HarnasBridge.app`), `src/main/ipc.ts` (белый список);
- `renderer/App.tsx` (где сейчас `applyTheme`);
- `renderer/components/terminal/use-terminal.ts` (как задаётся тема xterm);
- `packages/core/src/config.ts` (значения по умолчанию `fontFamily`, `fontSize`).

**Источник токенов** — клон Orca из разбора:
`/private/tmp/claude-501/-Users-kalmbik61-Desktop-MY-my-harnas/715cdc09-afbf-4c94-870a-b04ada97fd61/scratchpad/orca-harnas/src/renderer/src/assets/main.css`,
коммит `acf8e679`. Если клона нет — `git clone https://github.com/Kalmbik61/orca-harnas`
и `git checkout acf8e679`.

---

## 1.1. Токены, шрифт, тема по системе, `ui.json`, рамочный тест

**Зачем.** Основа облика. Рамочный тест ставится первым, чтобы стеречь все
следующие этапы.
**Зависит от:** —. **Спека:** 3.4, 4.1, 4.3, 4.7, 4.8, 14.4.

**Файлы**
- Создать:
  - `packages/desktop/src/renderer/styles/tokens.css` — блоки `@theme inline`, `:root`,
    `.dark` из Orca `main.css` дословно, с переименованием `--worktree-sidebar*` →
    `--work-sidebar*` и `--tab-group-split-divider*` → `--split-divider*`; перед ними —
    строка `@custom-variant dark (&:is(.dark *));` (Orca `main.css:27`): без неё
    `dark:`-классы shadcn идут по media, а не по `.dark`; в шапке — ссылка на исходник
    и MIT;
  - `.../renderer/styles/base.css` — `body`: Geist, `letter-spacing: .01em`,
    `-webkit-font-smoothing: antialiased`, `background: var(--background)`,
    `color: var(--foreground)`; `@font-face` Geist Variable 100–900;
  - `.../renderer/styles/scrollbars.css` — `.scrollbar-sleek` из Orca;
  - `.../renderer/assets/fonts/Geist-Variable.woff2` (из клона Orca, `src/renderer/src/assets/fonts/`) и
    `.../renderer/assets/fonts/OFL.txt` (текст лицензии Geist из
    `docs/site/THIRD_PARTY_NOTICES.md` Orca);
  - `.../renderer/theme/appearance.ts` и тест;
  - `packages/desktop/src/shared/ui-types.ts` и тест;
  - `packages/desktop/src/main/atomic-file.ts` и тест — атомарная запись и очередь на
    файл, общие для `ui-store.ts` и `layout-store.ts` (с 2.2);
  - `packages/desktop/src/main/ui-store.ts` и тест;
  - `NOTICE` в корне репозитория;
  - `packages/core/test/frame-check.test.ts` и `packages/core/test/frame-scan.ts`.
- Изменить:
  - `.../renderer/styles.css` — импорты `tailwindcss`, `tw-animate-css`, `./styles/tokens.css`,
    `./styles/base.css`, `./styles/scrollbars.css`;
  - `src/shared/bridge.ts` — `app.loadUi`, `app.saveUi`, `app.setAppearance`,
    `app.onAppearance`;
  - `src/preload/index.ts`, `src/main/ipc.ts` и `ipc.test.ts` — каналы `app:load-ui`,
    `app:save-ui`, `app:set-appearance`, событие `app:appearance`;
  - `.../renderer/test-utils/fake-bridge.ts` — `loadUi`, `saveUi`, `setAppearance`,
    `onAppearance` и `emitAppearance`;
  - `src/main/index.ts` — хранилище `ui.json`, `nativeTheme.themeSource` до создания
    окна, `backgroundColor` окна по теме;
  - `.../renderer/store/ui.ts` — поле `dark` и действие `setDark`: единственный источник
    тёмности в рендерере, из него тему берут терминал (1.3) и Monaco (7.3);
  - `.../renderer/main.tsx` — `.dark` на `<html>` до первого кадра и подписка
    `watchSystemDark` → `setDark`;
  - `packages/desktop/package.json` — `tw-animate-css`.

**Интерфейсы**

```ts
// src/shared/ui-types.ts
export type Appearance = 'system' | 'dark' | 'light';
export interface UiFile {
  version: 1;
  appearance: Appearance;
  leftSidebar: { open: boolean; width: number };
  rightSidebar: { open: boolean; width: number; tab: 'files' | 'changes' };
  activeWorkKey: string | null;
  pinnedWorks: string[];
  collapsedProjects: string[];
  showDoneWorks: boolean;
  notifications: { needsYou: boolean; finished: boolean; mail: boolean; sound: boolean };
  diffView: 'inline' | 'split';
  filesShowIgnored: boolean;
  lastProvider: string | null;
}
// спека 3.4; про `open` и `tab` сайдбаров спека молчит — открыты оба, как у Orca
export const DEFAULT_UI: UiFile = {
  version: 1, appearance: 'system',
  leftSidebar: { open: true, width: 280 },
  rightSidebar: { open: true, width: 350, tab: 'files' },
  activeWorkKey: null, pinnedWorks: [], collapsedProjects: [], showDoneWorks: true,
  notifications: { needsYou: true, finished: true, mail: true, sound: true },
  diffView: 'split', filesShowIgnored: false, lastProvider: null,
};
export const LEFT_SIDEBAR = { min: 220, max: 500, initial: 280 } as const;
export const RIGHT_SIDEBAR = { min: 220, initial: 350, reserveCenter: 320 } as const;
/** Приводит сырой JSON к UiFile: неизвестные ключи выкинуты, неверные значения — по умолчанию, ширины — в пределах. */
export function normalizeUi(raw: unknown): UiFile;

// src/main/atomic-file.ts
/** Пишет через уникальный временный файл рядом (`<file>.<pid>.<n>.tmp`) и rename. */
export function writeAtomic(file: string, text: string, rename?: typeof fs.rename): Promise<void>;
/** Очередь на файл: следующая операция стартует после конца предыдущей, её ошибка очередь не рвёт. */
export function createFileQueue(): <T>(operation: () => Promise<T>) => Promise<T>;

// src/main/ui-store.ts — ~/.harnas/desktop/ui.json
export function desktopUiPath(home?: string): string;
export interface UiStore {
  load(): Promise<UiFile>;
  save(patch: Partial<Omit<UiFile, 'version'>>): Promise<UiFile>;  // слияние по ключам верхнего уровня
}
/** `rename` подставляется в тесте атомарности: `vi.spyOn` не подменяет экспорт `node:fs/promises`. */
export function createUiStore(file: string, options?: { rename?: typeof fs.rename }): UiStore;

// renderer/theme/appearance.ts
/** Ставит или снимает `.dark` на <html>. */
export function applyDarkClass(dark: boolean, root?: HTMLElement): void;
/** Подписка на `prefers-color-scheme`; возвращает отписку. Главный процесс уже выставил themeSource. */
export function watchSystemDark(onChange: (dark: boolean) => void): () => void;

// renderer/store/ui.ts, дополнение к UiState
dark: boolean;                  // начальное — matchMedia('(prefers-color-scheme: dark)').matches
setDark(dark: boolean): void;   // applyDarkClass(dark) и запись в стор

// bridge.ts, дополнение к app
loadUi(): Promise<UiFile>;
saveUi(patch: Partial<Omit<UiFile, 'version'>>): Promise<UiFile>;
setAppearance(mode: Appearance): Promise<void>;
onAppearance(listener: (dark: boolean) => void): () => void;

// packages/core/test/frame-scan.ts
export interface FrameHit { file: string; line: number; rule: string; text: string }
/** Проверяет исходник построчно; строки-комментарии пропускаются. */
export function scanSource(file: string, source: string): FrameHit[];
export const FRAME_RULES: ReadonlyArray<{ rule: string; pattern: RegExp }>;
export const SOURCE_EXTENSIONS: readonly string[];   // '.ts', '.tsx', '.js', '.mjs', '.cjs'
/** Исходники под dir для рамочного теста — правила обхода в «Поведении». */
export function collectSourceFiles(dir: string): Promise<string[]>;
```

**Поведение**
- **Старт.** Main читает `ui.json`, ставит `nativeTheme.themeSource = appearance` и
  только потом создаёт окно с `backgroundColor` `#0a0a0a` или `#ffffff` по
  `nativeTheme.shouldUseDarkColors`. Так при старте нет белой вспышки в тёмной теме.
- **Смена темы.** `app:set-appearance` сперва пишет `ui.json`, потом меняет
  `themeSource`: если запись упала, тема не меняется и окно получает ошибку — диск и
  окно не расходятся. `nativeTheme.on('updated')` шлёт окну `app:appearance` с текущей
  тёмностью.
  Рендерер ставит `.dark` по `matchMedia('(prefers-color-scheme: dark)')` — Electron
  синхронизирует его с `themeSource`.
- **`ui.json`:**
  - битый или отсутствующий файл → `DEFAULT_UI`; любая другая ошибка чтения (`EISDIR`,
    `EACCES`) — тоже `DEFAULT_UI` и предупреждение в лог main: старт окна из-за
    `ui.json` не падает;
  - `save` сливает ключи верхнего уровня, а вложенные объекты (`leftSidebar`,
    `rightSidebar`, `notifications`) — на один уровень: текущее ⊕ патч, потом
    `normalizeUi`. Частичный `{ notifications: { sound: false } }` не откатывает
    остальные флаги к значениям по умолчанию;
  - ширины приводятся к пределам; нечисло, `NaN` и `±Infinity` → начальная ширина;
  - `app:save-ui` отвергает не-объекты, `null` и массивы;
  - запись атомарна: уникальный временный файл и `rename` (`atomic-file.ts`);
  - записи идут очередью на файл (`createFileQueue`): `save` читает файл после конца
    предыдущей записи. Параллельные IPC-вызовы — `setAppearance` и `saveUi`, ресайз
    сайдбара и `activeWorkKey` — не теряют ключи друг друга и не падают `ENOENT` на
    втором `rename`.
- **Рамочный тест:**
  - обходит `packages/*/src` и `tools/`, только файлы `.ts`, `.tsx`, `.js`, `.mjs`,
    `.cjs`;
  - пропускает `*.test.*`, каталоги `node_modules`, `dist`, `out`, любые каталоги с
    точкой в начале имени и собственные файлы. В `.omc/` хуки кладут JSON с выводом
    упавших команд, там бывают запрещённые строки;
  - правила — спека 14.4. «Запись в каталоги агентов» срабатывает на сам путь, при
    чтении тоже: чтение этих путей рамка 15.1 не предполагает;
  - комментарии распознаются с состоянием: `//`-строка и всё внутри `/* … */` —
    комментарий, строка, начатая с `*`, — только внутри блока. Код вроде
    `*gen() {…}` или перенос `* 2` проверяется;
  - совпадение валит тест со списком `файл:строка — правило`.
- **`NOTICE`:**
  - Orca: MIT, «Copyright (c) 2026 Lovecast Inc.», полный текст MIT, список
    скопированных файлов;
  - Geist: OFL 1.1, ссылка на `packages/desktop/src/renderer/assets/fonts/OFL.txt`.

**Тесты**
1. `normalizeUi`:
   - пустой объект → `DEFAULT_UI`;
   - `leftSidebar.width: 9999` → 500, `: 10` → 220;
   - неизвестный `appearance: 'blue'` → `'system'`;
   - лишний ключ выкинут.
2. `createUiStore`:
   - файла нет → `DEFAULT_UI`;
   - `save({ appearance: 'dark' })` → `load()` отдаёт `dark` при остальных значениях по
     умолчанию;
   - битый JSON → `DEFAULT_UI`, следующий `save` пишет валидный файл.
3. `ui.json` атомарен: подставной `rename` (`createUiStore(file, { rename })`) видит
   готовый временный файл, как тест 5 куска 2.2 прошлого плана.
4. `applyDarkClass(true)` ставит `.dark`, `false` снимает. `watchSystemDark` зовёт
   колбэк на событие `change` подставного `matchMedia`, отписка снимает слушатель.
5. `scanSource`:
   - строка `readFile(home + '/.claude/.credentials.json')` → находка;
   - та же строка после `//` или в блоке ` * ` → пусто;
   - `'--dangerously-skip-permissions'` в коде → находка;
   - `writeFile(path.join(home, '.claude.json'), text)` → находка «запись в каталоги
     агентов»;
   - `readFile(home + '/.codex/config.toml')` → та же находка: правило срабатывает на
     путь и при чтении.
6. Рамочный тест на всём репозитории зелёный. Нынешних совпадений пять, все в
   комментариях и пропущены: `core/src/providers.ts:13` и `:149`,
   `core/src/codex/discover.ts:8` и `:9`, `core/src/work/mcp-config.ts:89`.
7. `useUiStore.getState().setDark(true)` ставит `.dark` на `<html>` и `dark: true` в
   сторе; `setDark(false)` снимает то и другое.
8. Два параллельных `save` разных ключей — `save({ appearance: 'dark' })` и
   `save({ pinnedWorks: ['k'] })` без `await` между ними: оба значения на диске, ошибок
   нет.
9. `atomic-file`:
   - `createFileQueue` запускает вторую операцию после конца первой; ошибка первой
     вторую не отменяет;
   - два параллельных `writeAtomic` в один файл не падают `ENOENT`, на диске — один из
     текстов целиком.
10. `collectSourceFiles` во временном каталоге: `a.ts` — в списке; `a.test.ts`,
    `a.json`, `.omc/state/x.ts` и `node_modules/x.ts` — нет.
11. Инвариант ширин: для `leftSidebar.width` из диапазона −1e9…1e9 с шагом и для
    `NaN`, `±Infinity`, `'300'`, `null` результат `normalizeUi` — конечное число в
    220–500; то же для правого (≥ 220).
12. Частичный вложенный патч: после `save({ notifications: { …все true, mail: false } })`
    вызов `save({ notifications: { sound: false } })` оставляет `mail: false`.
13. `ui.json` — каталог: `load()` отдаёт `DEFAULT_UI` и не бросает.
14. IPC: `app:save-ui` с `[]`, `null`, `'x'` отвергается; `app:set-appearance`, когда
    подставной `save` падает, — промис отвергнут, `themeSource` прежний.
15. `scanSource` с состоянием блока: метод-генератор `*gen() { return '.credentials.json' }`
    → находка; строка внутри `/* … */` без ведущей `*` с тем же текстом → пусто.

**Приёмка**
- [ ] Все тесты зелёные, `pnpm lint` чистый.
- [ ] `pnpm dev:desktop`: интерфейс в Geist. Переключение темы macOS ставит и снимает
      `.dark` на `<html>` без перезапуска (DevTools, ручная проверка). Фон окна ещё на
      `--h-base` корня `App`, его проверяет 1.3.
- [ ] `NOTICE` на месте, у `tokens.css` и `scrollbars.css` в шапке — ссылка на
      исходник Orca.

---

## 1.2. Примитивы shadcn/ui, значки состояний и агентов

**Зачем.** Готовые кирпичи для всех экранов вместо самодельных кнопок и меню.
**Зависит от:** 1.1. **Спека:** 4.2, 4.5, 4.6, 4.8.

**Файлы**
- Создать в `packages/desktop/src/renderer/`:
  - `lib/cn.ts`;
  - `ui/button.tsx`, `ui/badge.tsx`, `ui/input.tsx`, `ui/textarea.tsx`, `ui/select.tsx`,
    `ui/checkbox.tsx`, `ui/switch.tsx`, `ui/separator.tsx`, `ui/scroll-area.tsx`,
    `ui/tooltip.tsx`, `ui/hover-card.tsx`, `ui/popover.tsx`, `ui/dropdown-menu.tsx`,
    `ui/context-menu.tsx`, `ui/dialog.tsx`, `ui/command.tsx`, `ui/tabs.tsx`,
    `ui/toggle.tsx`, `ui/toggle-group.tsx`, `ui/sonner.tsx`;
  - `components/AgentStateDot.tsx`, `components/AgentWorkingSpinner.tsx` — адаптация
    Orca, в шапке ссылка на исходник и MIT;
  - `styles/agent-spinner.css` — `.agent-working-spinner` и `@keyframes
    agent-spinner-rotate` из Orca `main.css:1590–1604`, с правилом
    `prefers-reduced-motion`; в шапке ссылка на исходник и MIT;
  - `components/AgentIcon.tsx`;
  - тесты: `ui/ui.test.tsx`, `components/AgentStateDot.test.tsx`, `components/AgentIcon.test.tsx`.
- Изменить:
  - `packages/desktop/package.json` — `cmdk`, `sonner`, `lucide-react`,
    `class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/react-dropdown-menu`,
    `@radix-ui/react-popover`, `@radix-ui/react-tooltip`, `@radix-ui/react-hover-card`,
    `@radix-ui/react-scroll-area`, `@radix-ui/react-checkbox`, `@radix-ui/react-switch`,
    `@radix-ui/react-separator`, `@radix-ui/react-tabs`, `@radix-ui/react-toggle`,
    `@radix-ui/react-toggle-group`, `@radix-ui/react-slot`;
  - `renderer/styles.css` — импорт `./styles/agent-spinner.css`;
  - `renderer/lib/dot-state.ts` и тест — `stateWord`; прежние `STATE_WORDS` и
    `dotColorVar` живут до 1.3;
  - `NOTICE` — в список скопированных файлов Orca: `agent-spinner.css`,
    `AgentStateDot.tsx`, `AgentWorkingSpinner.tsx`.

**Интерфейсы**

```ts
// lib/cn.ts
export function cn(...inputs: ClassValue[]): string;   // clsx + tailwind-merge

// components/AgentStateDot.tsx — таблица спеки 4.2
export interface AgentStateDotProps {
  state: DotState;                         // lib/dot-state.ts
  lifecycle?: SessionLifecycle;            // различает «спит» и «закрыта» у exited
  size?: 'sm' | 'md';                      // 10 и 12 px
  className?: string;
}
export function AgentStateDot(props: AgentStateDotProps): JSX.Element;

// components/AgentWorkingSpinner.tsx
/** Задержка анимации от общего нуля: все спиннеры вращаются в одной фазе. */
export function spinnerDelayMs(nowMs: number, periodMs: number): number; // = -(nowMs % periodMs)

// components/AgentIcon.tsx
export function AgentIcon(props: { provider: string; size?: number }): JSX.Element;

// lib/dot-state.ts — слово состояния, столбец таблицы спеки 4.2 (используют 1.3 и 3.3)
export function stateWord(state: DotState, lifecycle: SessionLifecycle): string;
```

**Поведение**
- **Примитивы** — shadcn/ui `new-york`, базовый цвет `neutral`, в варианте для React 18
  (`React.forwardRef`), на токенах 1.1.
- **Облик Orca поверх примитивов**, спека 4.5:
  - меню «стеклом»: `rgba(255,255,255,.82)` / `rgba(0,0,0,.72)`, `backdrop-blur-2xl`,
    рамка black/14 или white/14, отступ 4px, пункты 12/17 с весом 450, радиус 11px;
  - тултип инвертирован, задержка 400 мс;
  - `sonner` — справа внизу, отступ снизу 2.5rem, ширина `min(26rem, calc(100vw - 32px))`;
  - тени — таблица 4.4 спеки.
- **Зависимости эталонных shadcn-файлов:**
  - `ui/sonner.tsx` без `next-themes`: тема `Toaster` — `dark ? 'dark' : 'light'` из
    `useUiStore(s => s.dark)` (1.1);
  - `ui/toggle-group.tsx` берёт `toggleVariants` из `ui/toggle.tsx` на
    `@radix-ui/react-toggle`.
- **`AgentStateDot`** рисует строго по таблице 4.2: кольцо yellow-500 для `working`,
  `MessageCircleQuestion` цвета `--agent-question` для `blocked`, и так далее.
  `exited` + `lifecycle: 'sleeping'` → `Moon`, `exited` + `closed` → тире. Кольцо
  `working` вращает класс `.agent-working-spinner`.
- **`stateWord`** — слова таблицы 4.2: «работает», «ждёт тебя», «закончил · не
  просмотрено», «простаивает», «ожидает запуска», «готово», «сбой». У `exited` слово
  зависит от `lifecycle`: `closed` — «закрыта», иначе — «спит».
- **`AgentIcon`.** Пока без логотипов: буква провайдера на `bg-muted`, `rounded-[4px]`:
  `C` — `claude`, `X` — `codex`, у остальных — первая буква id провайдера в верхнем
  регистре. Логотипы решаются в 3.3 (спека 18, вопрос 1).

**Тесты**
1. `cn('px-2', 'px-4')` → `'px-4'`.
2. `AgentStateDot` для каждой из девяти строк таблицы 4.2 даёт свой значок и класс
   цвета, по `data-state` и `data-testid`.
3. `spinnerDelayMs(1234, 1000)` → `-234`. Два спиннера, смонтированные в разное
   время, получают задержки с одинаковым остатком по модулю периода.
4. `ui/dialog`: открывается по триггеру, Esc закрывает, фокус возвращается на
   триггер. `ui/dropdown-menu`: стрелки ходят по пунктам, Enter выбирает.
   `ui/command`: ввод фильтрует пункты.
5. `AgentIcon`: `claude` → `C`, `codex` → `X`, неизвестный провайдер `gemini` → `G`.
6. `stateWord` для всех девяти строк таблицы 4.2: `blocked` → «ждёт тебя», `unseen` →
   «закончил · не просмотрено», `pending` → «ожидает запуска», `exited` + `sleeping` →
   «спит», `exited` + `closed` → «закрыта», `failed` → «сбой» и так далее.
7. `ui/sonner`: при `dark: true` в сторе `Toaster` рисуется с темой `dark`, при
   `false` — `light`.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] Новые зависимости — только из списка «Файлы», версии зафиксированы в
      `pnpm-lock.yaml`; `next-themes` среди них нет.

---

## 1.3. Сайдбар, строка статуса и терминал в новом облике

**Зачем.** Главные экраны читаются как Orca уже до нового каркаса.
**Зависит от:** 1.2. **Спека:** 4.2, 4.3, 4.4, 4.7.

**Файлы**
- Создать:
  - `packages/desktop/src/renderer/components/terminal/xterm-themes.ts` и тест;
  - `packages/desktop/src/renderer/styles/dockview.css` — временно, до 2.7: переменные
    `--dv-*` на классе `.dockview-theme-harnas` из токенов.
- Изменить в `packages/desktop/src/renderer/`:
  - `components/sidebar/Sidebar.tsx`, `WorkList.tsx`, `SessionTree.tsx`,
    `MetricsLine.tsx`, `SessionMenu.tsx`: фон `--work-sidebar`, строки 24px, кегли по
    шкале 4.3, меню на `ui/context-menu`; в `SessionTree.tsx` слово состояния —
    `stateWord(state, session.lifecycle)` из 1.2;
  - `components/sidebar/StatusDot.tsx` — обёртка над `AgentStateDot` (сам файл удаляет
    3.5 вместе со старым сайдбаром);
  - `components/StatusBar.tsx` — 24px, `bg-card`, `text-xs`;
  - `components/InterruptedBanner.tsx` — на `ui/button`;
  - `components/terminal/use-terminal.ts` и тест — тема из `xterm-themes.ts`, смена на
    лету через `term.options.theme`, шрифт и опции 4.3 и 4.7; `theme` из
    `UseTerminalOptions` уходит;
  - `components/terminal/TerminalPanel.tsx` и тест — без пропа `theme`;
  - `components/layout/panel-registry.tsx` — без `theme` в `PanelHostContext`;
  - `components/layout/Workspace.tsx` и тест — без пропа `theme`; тема dockview — своя
    `{ name: 'harnas', className: 'dockview-theme-harnas' }` вместо
    `themeCatppuccinMocha`; `../../styles/dockview.css` импортируется сразу после
    `dockview-react/dist/styles/dockview.css`;
  - `lib/dot-state.ts` и тест — без `STATE_WORDS` и `dotColorVar`: их заменили
    `stateWord` и `AgentStateDot`;
  - `App.tsx` — фон `bg-background`, у `Workspace` нет `theme`. Запасные `fontFamily` и
    `fontSize` до ответа `settings.get` — `"'SF Mono', Menlo, monospace"` и 14: копия
    значений `core`, его рантайм в рендерер не собирается.
- Удалить: `components/terminal/xterm-theme.ts` и `xterm-theme.test.ts`.
- Изменить `packages/core/src/config.ts` и его тест: `fontFamily` по умолчанию
  `"'SF Mono', Menlo, monospace"`, `fontSize` 14.

**Интерфейсы**

```ts
// components/terminal/xterm-themes.ts — спека 4.7, значения дословно
import type { ITheme } from '@xterm/xterm';
export const XTERM_DARK: ITheme;   // Ghostty Default Style Dark
export const XTERM_LIGHT: ITheme;  // Builtin Tango Light
export function xtermTheme(dark: boolean): ITheme;
export const XTERM_OPTIONS: {
  lineHeight: 1; fontWeight: 500; fontWeightBold: 700; scrollback: 5000;
  cursorStyle: 'block'; cursorBlink: true; cursorInactiveStyle: 'outline';
};
/** В светлой теме — 4.5, в тёмной — 1 (по умолчанию xterm). */
export function minimumContrastRatio(dark: boolean): number;

// components/terminal/use-terminal.ts — `theme` уходит, тёмность хук берёт сам
export interface UseTerminalOptions {
  bridge: HarnasBridge; ref: SessionRef; container: HTMLDivElement | null;
  fontFamily: string; fontSize: number; visible?: boolean;
}
```

**Поведение**
- **Терминал.**
  - Тема и `minimumContrastRatio` меняются при смене `.dark` без пересоздания
    терминала: `term.options.theme = xtermTheme(dark)`. Тёмность — из
    `useUiStore(s => s.dark)` (1.1) внутри хука. Проп `theme` снимается со всей
    цепочки `App` → `Workspace` → `PanelHostContext` → `TerminalPanel`.
  - Шрифт — `config.fontFamily` и `config.fontSize` (новые значения по умолчанию из
    `core`).
  - Внутренний отступ 4px — CSS контейнера.
- **Сайдбар.** Строки сессий 24px. Состояние рисует `AgentStateDot`, слово состояния —
  справа muted 11px. Меню сессии на `ui/context-menu` с теми же пунктами, что сейчас.
- **dockview.** Фон вкладок `--card`, активная `color-mix(in srgb, var(--foreground)
  6%, var(--card))` с нижней полосой 2px, разделители `--border`, подсветка броска
  `rgba(59,130,246,.2)`. Файл удаляется в 2.7.

**Тесты**
1. `XTERM_DARK.background === '#282c34'`, `XTERM_LIGHT.background === '#ffffff'`. 16
   ANSI-цветов каждой темы совпадают с таблицей спеки 4.7.
2. `use-terminal` на подставном `Terminal`: `useUiStore.getState().setDark(…)` меняет
   `options.theme` и `options.minimumContrastRatio`; `dispose` и новый `Terminal` не
   зовутся.
3. `core` `DEFAULT_CONFIG.fontFamily` и `fontSize` — новые значения. Явные значения из
   `config.json` по-прежнему перекрывают их (прежний тест config).
4. Нынешние тесты сайдбара и строки статуса зелёные. Проверки классов обновлены под
   токены, проверки поведения не тронуты.
5. `SessionTree`: слово состояния из `stateWord` — у `blocked` «ждёт тебя», у закрытой
   сессии «закрыта».

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] `pnpm dev:desktop`: фон окна — `--background`; переключение темы macOS меняет окно
      и терминал без перезапуска (ручная проверка).
- [ ] В обеих темах сайдбар, терминал и строка статуса читаются, контраст текста не
      ниже WCAG AA (ручная проверка по скриншоту).

---

## 1.4. Диалоги, почта, комнаты, настройки; уборка; приёмка этапа 1

**Зачем.** Облик единый во всех экранах; старые палитры уходят.
**Зависит от:** 1.3. **Спека:** 4.5, 4.9, 4.10.

**Файлы**
- Изменить в `packages/desktop/src/renderer/`:
  - `components/dialogs/NewWorkDialog.tsx`, `NewSessionDialog.tsx`, `ConfirmDialog.tsx` —
    на `ui/dialog`, `ui/input`, `ui/textarea`, `ui/select`, `ui/switch`, `ui/button`;
  - `components/rooms/CreateRoomDialog.tsx`, `RoomPanel.tsx`, `RoomHeader.tsx`,
    `Composer.tsx` — токены и примитивы;
  - `components/mail/MailPanel.tsx`, `Letter.tsx`, `Decisions.tsx` — токены, кегли 4.3;
  - `components/changes/ChangesPanel.tsx`, `changes/DiffView.tsx`,
    `components/palette/CommandPalette.tsx`, `palette/SessionPicker.tsx`,
    `components/layout/panel-registry.tsx` — `--h-*` → токены; без них поиск `--h-` не
    опустеет;
  - `components/settings/SettingsDialog.tsx` — четыре секции спеки 4.10;
  - `App.tsx` — без `applyTheme` (проп `theme` снят в 1.3), `Toaster` из `ui/sonner`.
- Удалить: `renderer/theme/palettes.ts`, `renderer/theme/apply-theme.ts` и их тесты.
- Создать: `packages/desktop/e2e/theme.spec.ts`.
- Документы: `README.md`, раздел «Окно» — облик и тема по системе, одним абзацем.

**Интерфейсы**

```ts
// SettingsDialog: секции и источники
type SettingsSection = 'appearance' | 'terminal' | 'agents' | 'notifications';
// appearance — app.setAppearance: ui.json пишет сам main (1.1); notifications — app.saveUi
// terminal (fontFamily, fontSize), agents (silenceThresholdMs, messageRate,
// resumeRate, autoLaunch, worktreeRoot) — settings.set, как сейчас
```

**Поведение**
- **Настройки.**
  - «Вид» — `ui/toggle-group`: «Система», «Тёмная», «Светлая».
  - «Уведомления» — четыре `ui/switch`. До этапа 4 ключи только сохраняются.
  - «Терминал» и «Агенты» — прежние поля и прежняя запись через `settings.set`.
  - Поле `theme` окно больше не показывает.
- **Диалоги.** Все на `ui/dialog`: заголовок 14px 600, тени по таблице 4.4, кнопки
  справа («Отмена» — `variant="ghost"`, действие — `default`, удаление —
  `destructive`).
- **Почта и комнаты.** Тело письма и сообщения 14px, заголовок письма 12px muted.
  Markdown без сырого HTML — прежнее правило. Композер — `ui/textarea` и `ui/button`.

**Тесты**
1. В `SettingsDialog` нет поля темы TUI. «Тёмная» зовёт `app.setAppearance('dark')`,
   отдельного `saveUi` для вида нет. Переключатель «звук» зовёт
   `app.saveUi({ notifications: { …, sound: false } })`. «Размер шрифта» зовёт
   `settings.set`.
2. Прежние тесты диалогов, почты, комнат, изменений и палитры зелёные: поведение то же,
   обновлены только селекторы.
3. **E2E `theme.spec.ts`.** `electron.launch` с эмуляцией `colorScheme: 'dark'`:
   вычисленный `background-color` у `body` — `rgb(10, 10, 10)`. С `'light'` —
   `rgb(255, 255, 255)`. Хост гасится в `afterEach`.

**Приёмка**
- [ ] Все тесты зелёные, все E2E зелёные: прежние и оба сценария `theme.spec.ts`.
- [ ] Поиск `--h-` по `packages/desktop/src` пуст.

**Приёмка этапа 1** (человек, на пересобранном `harnas.app`)
- [ ] Окно в обеих темах и переключается вслед за macOS без перезапуска.
- [ ] Все диалоги, почта, комнаты, настройки и терминал читаются в обеих темах.
- [ ] `README.md` обновлён.
