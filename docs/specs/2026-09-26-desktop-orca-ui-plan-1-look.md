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
`<scratchpad>/orca-harnas/src/renderer/src/assets/main.css`, коммит `acf8e679`. Если
клона нет — `git clone https://github.com/Kalmbik61/orca-harnas` и `git checkout
acf8e679`.

---

## 1.1. Токены, шрифт, тема по системе, `ui.json`, рамочный тест

**Зачем.** Основа облика. Рамочный тест ставится первым, чтобы стеречь все
следующие этапы.
**Зависит от:** —. **Спека:** 3.4, 4.1, 4.3, 4.7, 4.8, 14.4.

**Файлы**
- Создать:
  - `packages/desktop/src/renderer/styles/tokens.css` — блоки `@theme inline`, `:root`,
    `.dark` из Orca `main.css` дословно, с переименованием `--worktree-sidebar*` →
    `--work-sidebar*` и `--tab-group-split-divider*` → `--split-divider*`; в шапке —
    ссылка на исходник и MIT;
  - `.../renderer/styles/base.css` — `body`: Geist, `letter-spacing: .01em`,
    `-webkit-font-smoothing: antialiased`, `background: var(--background)`,
    `color: var(--foreground)`; `@font-face` Geist Variable 100–900;
  - `.../renderer/styles/scrollbars.css` — `.scrollbar-sleek` из Orca;
  - `.../renderer/assets/fonts/Geist-Variable.woff2` (из клона Orca, `src/renderer/src/assets/fonts/`) и
    `.../renderer/assets/fonts/OFL.txt` (текст лицензии Geist из
    `docs/site/THIRD_PARTY_NOTICES.md` Orca);
  - `.../renderer/theme/appearance.ts` и тест;
  - `packages/desktop/src/shared/ui-types.ts`;
  - `packages/desktop/src/main/ui-store.ts` и тест;
  - `NOTICE` в корне репозитория;
  - `packages/core/test/frame-check.test.ts` и `packages/core/test/frame-scan.ts`.
- Изменить:
  - `.../renderer/styles.css` — импорты `tailwindcss`, `tw-animate-css`, `./styles/tokens.css`,
    `./styles/base.css`, `./styles/scrollbars.css`;
  - `src/shared/bridge.ts` — `app.loadUi`, `app.saveUi`, `app.setAppearance`,
    `app.onAppearance`;
  - `src/preload/index.ts`, `src/main/ipc.ts` — каналы `app:load-ui`, `app:save-ui`,
    `app:set-appearance`, событие `app:appearance`;
  - `src/main/index.ts` — хранилище `ui.json`, `nativeTheme.themeSource` до создания
    окна, `backgroundColor` окна по теме;
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
export const DEFAULT_UI: UiFile; // значения — спека 3.4
export const LEFT_SIDEBAR = { min: 220, max: 500, initial: 280 } as const;
export const RIGHT_SIDEBAR = { min: 220, initial: 350, reserveCenter: 320 } as const;
/** Приводит сырой JSON к UiFile: неизвестные ключи выкинуты, неверные значения — по умолчанию, ширины — в пределах. */
export function normalizeUi(raw: unknown): UiFile;

// src/main/ui-store.ts — ~/.harnas/desktop/ui.json, запись tmp + rename
export function desktopUiPath(home?: string): string;
export interface UiStore {
  load(): Promise<UiFile>;
  save(patch: Partial<Omit<UiFile, 'version'>>): Promise<UiFile>;  // слияние по ключам верхнего уровня
}
export function createUiStore(file: string): UiStore;

// renderer/theme/appearance.ts
/** Ставит или снимает `.dark` на <html>. */
export function applyDarkClass(dark: boolean, root?: HTMLElement): void;
/** Подписка на `prefers-color-scheme`; возвращает отписку. Главный процесс уже выставил themeSource. */
export function watchSystemDark(onChange: (dark: boolean) => void): () => void;

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
```

**Поведение**
- **Старт.** Main читает `ui.json`, ставит `nativeTheme.themeSource = appearance` и
  только потом создаёт окно с `backgroundColor` `#0a0a0a` или `#ffffff` по
  `nativeTheme.shouldUseDarkColors`. Так при старте нет белой вспышки в тёмной теме.
- **Смена темы.** `app:set-appearance` меняет `themeSource` и пишет `ui.json`.
  `nativeTheme.on('updated')` шлёт окну `app:appearance` с текущей тёмностью.
  Рендерер ставит `.dark` по `matchMedia('(prefers-color-scheme: dark)')` — Electron
  синхронизирует его с `themeSource`.
- **`ui.json`:**
  - битый или отсутствующий файл → `DEFAULT_UI`;
  - `save` сливает ключи верхнего уровня: вложенные объекты сливаются целиком,
    например весь `notifications`;
  - ширины приводятся к пределам;
  - запись атомарна, как в `main/layout-store.ts`.
- **Рамочный тест** обходит `packages/*/src` и `tools/`, кроме `*.test.*`, `node_modules`,
  `dist`, `out` и собственных файлов. Правила — спека 14.4. Совпадение валит тест со
  списком `файл:строка — правило`.
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
3. `ui.json` атомарен: подставной `rename` видит готовый временный файл, как тест 5
   куска 2.2 прошлого плана.
4. `applyDarkClass(true)` ставит `.dark`, `false` снимает. `watchSystemDark` зовёт
   колбэк на событие `change` подставного `matchMedia`, отписка снимает слушатель.
5. `scanSource`:
   - строка `readFile(home + '/.claude/.credentials.json')` → находка;
   - та же строка после `//` или в блоке ` * ` → пусто;
   - `'--dangerously-skip-permissions'` в коде → находка.
6. Рамочный тест на всём репозитории зелёный. Единственное нынешнее совпадение,
   `core/src/codex/discover.ts:8`, — комментарий, и он пропущен.

**Приёмка**
- [ ] Все тесты зелёные, `pnpm lint` чистый.
- [ ] `pnpm dev:desktop`: интерфейс в Geist, фон `--background`. Переключение темы macOS
      меняет окно без перезапуска (ручная проверка).
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
    `ui/toggle-group.tsx`, `ui/sonner.tsx`;
  - `components/AgentStateDot.tsx`, `components/AgentWorkingSpinner.tsx` — адаптация
    Orca, в шапке ссылка на исходник и MIT;
  - `components/AgentIcon.tsx`;
  - тесты: `ui/ui.test.tsx`, `components/AgentStateDot.test.tsx`, `components/AgentIcon.test.tsx`.
- Изменить: `packages/desktop/package.json` — `cmdk`, `sonner`, `lucide-react`,
  `class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/react-dropdown-menu`,
  `@radix-ui/react-popover`, `@radix-ui/react-tooltip`, `@radix-ui/react-hover-card`,
  `@radix-ui/react-scroll-area`, `@radix-ui/react-checkbox`, `@radix-ui/react-switch`,
  `@radix-ui/react-separator`, `@radix-ui/react-tabs`, `@radix-ui/react-toggle-group`,
  `@radix-ui/react-slot`.

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
export function AgentIcon(props: { provider: string; label?: string; size?: number }): JSX.Element;
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
- **`AgentStateDot`** рисует строго по таблице 4.2: кольцо yellow-500 для `working`,
  `MessageCircleQuestion` цвета `--agent-question` для `blocked`, и так далее.
  `exited` + `lifecycle: 'sleeping'` → `Moon`, `exited` + `closed` → тире.
- **`AgentIcon`.** Пока без логотипов: буква провайдера (`C` — claude, `X` — codex,
  иначе первая буква `label`) на `bg-muted`, `rounded-[4px]`. Логотипы решаются в 3.3
  (спека 18, вопрос 1).

**Тесты**
1. `cn('px-2', 'px-4')` → `'px-4'`.
2. `AgentStateDot` для каждой из девяти строк таблицы 4.2 даёт свой значок и класс
   цвета, по `data-state` и `data-testid`.
3. `spinnerDelayMs(1234, 1000)` → `-234`. Два спиннера, смонтированные в разное
   время, получают задержки с одинаковым остатком по модулю периода.
4. `ui/dialog`: открывается по триггеру, Esc закрывает, фокус возвращается на
   триггер. `ui/dropdown-menu`: стрелки ходят по пунктам, Enter выбирает.
   `ui/command`: ввод фильтрует пункты.
5. `AgentIcon`: `claude` → `C`, неизвестный провайдер с `label: 'gemini'` → `G`.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] Новые зависимости — только из списка «Файлы», версии зафиксированы в
      `pnpm-lock.yaml`.

---

## 1.3. Сайдбар, строка статуса и терминал в новом облике

**Зачем.** Главные экраны читаются как Orca уже до нового каркаса.
**Зависит от:** 1.2. **Спека:** 4.2, 4.3, 4.4, 4.7.

**Файлы**
- Создать:
  - `packages/desktop/src/renderer/components/terminal/xterm-themes.ts` и тест;
  - `packages/desktop/src/renderer/styles/dockview.css` — временно, до 2.7: переменные
    dockview на токенах.
- Изменить в `packages/desktop/src/renderer/`:
  - `components/sidebar/Sidebar.tsx`, `WorkList.tsx`, `SessionTree.tsx`,
    `MetricsLine.tsx`, `SessionMenu.tsx`: фон `--work-sidebar`, строки 24px, кегли по
    шкале 4.3, меню на `ui/context-menu`;
  - `components/sidebar/StatusDot.tsx` — обёртка над `AgentStateDot` (сам файл уходит в 3.3);
  - `components/StatusBar.tsx` — 24px, `bg-card`, `text-xs`;
  - `components/InterruptedBanner.tsx` — на `ui/button`;
  - `components/terminal/use-terminal.ts` — тема из `xterm-themes.ts`, смена на лету
    через `term.options.theme`, шрифт и опции 4.3 и 4.7;
  - `components/terminal/TerminalPanel.tsx`;
  - `App.tsx` — фон `bg-background`.
- Удалить: `components/terminal/xterm-theme.ts`.
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
```

**Поведение**
- **Терминал.**
  - Тема и `minimumContrastRatio` меняются при смене `.dark` без пересоздания
    терминала: `term.options.theme = xtermTheme(dark)`.
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
2. `use-terminal` на подставном `Terminal`: смена тёмности меняет `options.theme` и
   `options.minimumContrastRatio`; `dispose` и новый `Terminal` не зовутся.
3. `core` `DEFAULT_CONFIG.fontFamily` и `fontSize` — новые значения. Явные значения из
   `config.json` по-прежнему перекрывают их (прежний тест config).
4. Нынешние тесты сайдбара и строки статуса зелёные. Проверки классов обновлены под
   токены, проверки поведения не тронуты.

**Приёмка**
- [ ] Все тесты зелёные.
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
  - `components/settings/SettingsDialog.tsx` — четыре секции спеки 4.10;
  - `App.tsx` — без `applyTheme` и без пропа `theme`, `Toaster` из `ui/sonner`.
- Удалить: `renderer/theme/palettes.ts`, `renderer/theme/apply-theme.ts` и их тесты.
- Создать: `packages/desktop/e2e/theme.spec.ts`.
- Документы: `README.md`, раздел «Окно» — облик и тема по системе, одним абзацем.

**Интерфейсы**

```ts
// SettingsDialog: секции и источники
type SettingsSection = 'appearance' | 'terminal' | 'agents' | 'notifications';
// appearance, notifications — app.saveUi / app.setAppearance
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
1. В `SettingsDialog` нет поля темы TUI. «Тёмная» зовёт `app.setAppearance('dark')` и
   `app.saveUi({ appearance: 'dark' })`. Переключатель «звук» зовёт
   `app.saveUi({ notifications: { …, sound: false } })`. «Размер шрифта» зовёт
   `settings.set`.
2. Прежние тесты диалогов, почты и комнат зелёные: поведение то же, обновлены только
   селекторы.
3. **E2E `theme.spec.ts`.** `electron.launch` с эмуляцией `colorScheme: 'dark'`:
   вычисленный `background-color` у `body` — `rgb(10, 10, 10)`. С `'light'` —
   `rgb(255, 255, 255)`. Хост гасится в `afterEach`.

**Приёмка**
- [ ] Все тесты зелёные, E2E 6/6 (пять прежних и `theme.spec.ts`).
- [ ] Поиск `--h-` по `packages/desktop/src` пуст.

**Приёмка этапа 1** (человек, на пересобранном `harnas.app`)
- [ ] Окно в обеих темах и переключается вслед за macOS без перезапуска.
- [ ] Все диалоги, почта, комнаты, настройки и терминал читаются в обеих темах.
- [ ] `README.md` обновлён.
