# Остров одобрений — план реализации

> **Для исполнителей:** по шагам, галочки `- [ ]`. Порядок работы пользователя: куски по 1–2 задачи, исполнители — Sonnet; исполнители тесты **пишут, но не запускают** (ни vitest, ни tsc, ни eslint); прогон — после группы, один процесс, только после проверки загрузки машины (`uptime`, `memory_pressure -Q`; load average за минуту ниже ~8 при 12 ядрах); дифф каждого куска читает контролёр. Коммит — после зелёного прогона группы.

**Цель:** маленькое окно Parley у верхнего края экрана (в чёлке MacBook) — пилюля «N working · M waiting», список сессий и комнат в работе, карточка запроса агента с ответом в один клик, не активируя Parley.

**Архитектура:** вариант A спеки — второе окно Electron (`type: 'panel'`) со своим renderer (`island.html`) и минимальным preload; хост не меняется. Остров слушает работы и активность всех сессий, по переходу сессии в «ждёт» берёт её ждущие карточки разовым `feed.snapshot` и отвечает `feed.decide`. Main создаёт окно по настройке, держит место у верхнего края, пропускает от острова только белый список методов хоста.

**Стек:** Electron 44, electron-vite, React 18, zustand, Tailwind v4, vitest (jsdom для renderer), Playwright (`_electron`) для E2E.

**Спека:** `docs/specs/2026-10-12-island-design.md` — читать вместе с планом.

## Общие ограничения

- Реализация начинается после слияния `fix/notification-details` в master (задача 0): нужны `renderer/attention/ask-summary.ts`, `FocusTarget.cardId`, `openSessionCard`.
- Тексты окна — по-английски (`src/english-ui.test.ts`), в `src/shared/strings.ts`. Комментарии, JSDoc, имена тестов — по-русски, в плотном стиле соседнего кода.
- Codex вне острова: провайдер `'codex'` не попадает ни в пилюлю, ни в список, ни в запросы; его уведомления — системные, как сейчас.
- Остров **включён по умолчанию** (`ui.island.enabled: true`), подсказка при первом показе — «Drag me · × to hide · turn off in Settings».
- «В работе»: сессия — `sessionAttention` даёт `working` или `needs-you`; комната — хотя бы один её участник в работе; «finished, not seen» не считается.
- Окно острова: `type: 'panel'`, без рамки, прозрачное, `setAlwaysOnTop(true, 'screen-saver')` (без `setVisibleOnAllWorkspaces` — поправка ревью группы 1: Electron меняет на нём тип процесса и прячет значок в Dock; `panel` и так на всех рабочих столах), `acceptFirstMouse: true`, `enableLargerThanScreen: true` (без него macOS сдвигает видимое окно под строку меню), показ только `showInactive()`.
- Чёлка: встроенный дисплей (`internal`) и строка меню (`workArea.y - bounds.y`) ≥ 32 px → отступ содержимого сверху на высоту строки меню.
- Белый список методов хоста для острова: `works.list`, `feed.snapshot`, `feed.decide` (+ `host:activity-snapshot`).
- `PARLEY_ISLAND=off` (только неупакованное окно или `PARLEY_E2E=1`) — острова нет; `playwright.config.ts` ставит его по умолчанию.
- Остров всегда тёмный (класс `dark` один раз при старте).
- Повтор запроса карточки — через 500 мс (`ASK_RETRY_MS`), «Answered elsewhere» держится 1000 мс.

## Review Focus

1. **Клик по острову не должен поднимать Parley.** Человек в браузере жмёт Allow — главное окно не всплывает, фокус остаётся в браузере. Покрытие: тест параметров окна (задача 3: `type: 'panel'`, `acceptFirstMouse`, показ `showInactive`, нигде `show()`/`focus()`), живая проверка.
2. **Монитор отключили, пока остров на нём.** Остров не должен остаться за пределами экранов. Покрытие: `resolveDisplay` с пропавшим `displayId` (задача 2) и `relayout` по событиям `screen` (задача 3, тест «монитор пропал»).
3. **На запрос ответили в терминале, пока человек тянулся к острову.** Кнопка не должна зависнуть в «решается»: `applied: false` или `not_found` → «Answered elsewhere» и карточка уходит. Покрытие: задача 6, тесты `decide`.
4. **Хост перезапустился с открытыми карточками.** Старые карточки не должны остаться кнопками, которые никуда не ведут. Покрытие: задача 6 (`clear` по статусу) и задача 8 (статус не `connected` → `clear`).
5. **Сессия ждёт, а карточки нет** (экран доверия в терминале, уведомление без хука). Остров не рисует пустую карточку, в списке — «waiting in terminal», системное уведомление остаётся. Покрытие: задача 5 (`inTerminal`), задача 9 (`notify` без карточки шлёт).

---

### Задача 0: База ветки и окружение

**Файлы:** нет.

- [ ] **Шаг 1: Дождаться слияния `fix/notification-details`.** Проверить: `git -C <репо> fetch origin && git -C <репо> log --oneline origin/master | head -5` — в истории есть коммит «уведомление «needs you» называет запрос…».

- [ ] **Шаг 2: Перебазировать `feat/island` на свежий master.**

Run (в worktree `.claude/worktrees/island`):
```bash
git fetch origin && git rebase origin/master
```
Expected: `Successfully rebased`, в ветке один коммит спеки поверх master.

- [ ] **Шаг 3: Проверить загрузку и поставить зависимости.**

Run: `uptime; memory_pressure -Q | tail -1` — load average за минуту ниже ~8. Затем:
```bash
nice -n 10 pnpm install --frozen-lockfile
```
Expected: `Done`.

- [ ] **Шаг 4: Базовая сборка и типы** (тяжело — только при низкой загрузке):
```bash
nice -n 10 pnpm typecheck
```
Expected: exit 0. Это база: дальше красное — от наших правок.

---

### Задача 1: Настройка `island` в `UiFile`

**Файлы:**
- Modify: `packages/desktop/src/shared/ui-types.ts` (интерфейс `UiFile`, `DEFAULT_UI`, `normalizeUi`)
- Modify: `packages/desktop/src/main/ui-store.ts` (`NESTED_KEYS`, строки ~28–34)
- Test: `packages/desktop/src/shared/ui-types.test.ts`, `packages/desktop/src/main/ui-store.test.ts`

**Interfaces:**
- Produces: `export type IslandAnchor = 'left' | 'center' | 'right'`; `export interface IslandUi { enabled: boolean; displayId: number | null; anchor: IslandAnchor; hintShown: boolean }`; поле `UiFile.island: IslandUi`; `DEFAULT_UI.island = { enabled: true, displayId: null, anchor: 'center', hintShown: false }`.

- [ ] **Шаг 1: Тесты нормализации** — в `ui-types.test.ts`:

```ts
describe('normalizeUi: остров', () => {
  it('нет поля — умолчания: включён, по центру, монитор не выбран, подсказка не показана', () => {
    expect(normalizeUi({}).island).toEqual({ enabled: true, displayId: null, anchor: 'center', hintShown: false });
  });

  it('битые значения заменяются умолчаниями по одному, целые остаются', () => {
    expect(normalizeUi({ island: { enabled: false, displayId: 'x', anchor: 'top', hintShown: true } }).island).toEqual({
      enabled: false,
      displayId: null,
      anchor: 'center',
      hintShown: true,
    });
  });

  it('displayId — только целое число', () => {
    expect(normalizeUi({ island: { displayId: 3 } }).island.displayId).toBe(3);
    expect(normalizeUi({ island: { displayId: 2.5 } }).island.displayId).toBeNull();
  });
});
```

И в `ui-store.test.ts` (по образцу соседних тестов `save` для `notifications`):

```ts
it('save сливает island на один уровень: место не стирает enabled и hintShown', async () => {
  const store = createUiStore(file);
  await store.save({ island: { enabled: false, displayId: null, anchor: 'center', hintShown: true } });
  const saved = await store.save({ island: { displayId: 7, anchor: 'right' } } as Partial<Omit<UiFile, 'version'>>);
  expect(saved.island).toEqual({ enabled: false, displayId: 7, anchor: 'right', hintShown: true });
});
```

(`file` — временный путь, как в соседних тестах файла.)

- [ ] **Шаг 2: Реализация** — в `ui-types.ts` рядом с `VoiceUi`/`BrowserUi`:

```ts
/** Точка острова у верхнего края монитора (спека острова, раздел 4). */
export type IslandAnchor = 'left' | 'center' | 'right';

/**
 * Остров одобрений (спека 2026-10-12): включён ли (по умолчанию да — у всех, включая обновившихся), где стоит
 * (`displayId` — id монитора Electron, `null` — основной) и показана ли подсказка первого показа.
 */
export interface IslandUi {
  enabled: boolean;
  displayId: number | null;
  anchor: IslandAnchor;
  hintShown: boolean;
}
```

В `UiFile` — поле `island: IslandUi;` (после `browser`). В `DEFAULT_UI` — `island: { enabled: true, displayId: null, anchor: 'center', hintShown: false },`. Нормализатор рядом с `normalizeNotifications`:

```ts
const ISLAND_ANCHORS: readonly IslandAnchor[] = ['left', 'center', 'right'];

function normalizeIsland(value: unknown): IslandUi {
  const source = isRecord(value) ? value : {};
  const fallback = DEFAULT_UI.island;
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    displayId: Number.isInteger(source.displayId) ? (source.displayId as number) : fallback.displayId,
    anchor: ISLAND_ANCHORS.includes(source.anchor as IslandAnchor) ? (source.anchor as IslandAnchor) : fallback.anchor,
    hintShown: typeof source.hintShown === 'boolean' ? source.hintShown : fallback.hintShown,
  };
}
```

В `normalizeUi` — `island: normalizeIsland(source.island),`. В `main/ui-store.ts` в `NESTED_KEYS` добавить `'island'`.

- [ ] **Шаг 3: Коммит** (после зелёного прогона группы — см. задачу 4, шаг «Прогон группы»):
```bash
git add packages/desktop/src/shared/ui-types.ts packages/desktop/src/shared/ui-types.test.ts packages/desktop/src/main/ui-store.ts packages/desktop/src/main/ui-store.test.ts
git commit -m "feat(desktop): настройка острова в ui.json — включён по умолчанию, место и подсказка"
```

---

### Задача 2: Чистые функции места острова

**Файлы:**
- Create: `packages/desktop/src/main/island/placement.ts`
- Test: `packages/desktop/src/main/island/placement.test.ts`

**Interfaces:**
- Consumes: `IslandAnchor` (задача 1).
- Produces:
  - `interface Rect { x: number; y: number; width: number; height: number }`
  - `interface DisplayLike { id: number; bounds: Rect; workArea: Rect; internal: boolean }`
  - `interface IslandPlacement { displayId: number | null; anchor: IslandAnchor }`
  - `interface Size { width: number; height: number }`
  - `const ISLAND_MARGIN = 12`
  - `notchInset(display: DisplayLike): number`
  - `resolveDisplay(displays: readonly DisplayLike[], primaryId: number, displayId: number | null): DisplayLike`
  - `islandBounds(display: DisplayLike, anchor: IslandAnchor, size: Size): Rect`
  - `snapAnchor(display: DisplayLike, screenX: number): IslandAnchor`
  - `displayAt(displays: readonly DisplayLike[], x: number, y: number): DisplayLike`

- [ ] **Шаг 1: Тесты** (`placement.test.ts`). Мониторы — как у пользователя (спайк 2026-10-12):

```ts
import { describe, expect, it } from 'vitest';
import { displayAt, islandBounds, notchInset, resolveDisplay, snapAnchor, type DisplayLike } from './placement.js';

const EXTERNAL: DisplayLike = {
  id: 3,
  bounds: { x: 0, y: 0, width: 3440, height: 1440 },
  workArea: { x: 0, y: 25, width: 3440, height: 1415 },
  internal: false,
};
const MACBOOK: DisplayLike = {
  id: 1,
  bounds: { x: 0, y: 1440, width: 1512, height: 982 },
  workArea: { x: 0, y: 1478, width: 1512, height: 944 },
  internal: true,
};
const DISPLAYS = [EXTERNAL, MACBOOK];

describe('остров: место у верхнего края', () => {
  it('чёлка — встроенный экран со строкой меню 38 px; у внешнего 25 px отступа нет', () => {
    expect(notchInset(MACBOOK)).toBe(38);
    expect(notchInset(EXTERNAL)).toBe(0);
  });

  it('встроенный экран без чёлки (строка меню 24 px) — без отступа', () => {
    expect(notchInset({ ...MACBOOK, workArea: { ...MACBOOK.workArea, y: 1464 } })).toBe(0);
  });

  it('центр, левый и правый край — верхний край монитора, поля 12 px', () => {
    const size = { width: 380, height: 150 };
    expect(islandBounds(EXTERNAL, 'center', size)).toEqual({ x: 1530, y: 0, width: 380, height: 150 });
    expect(islandBounds(EXTERNAL, 'left', size)).toEqual({ x: 12, y: 0, width: 380, height: 150 });
    expect(islandBounds(EXTERNAL, 'right', size)).toEqual({ x: 3048, y: 0, width: 380, height: 150 });
    expect(islandBounds(MACBOOK, 'center', size)).toEqual({ x: 566, y: 1440, width: 380, height: 150 });
  });

  it('остров шире монитора — ширина режется по монитору', () => {
    expect(islandBounds(MACBOOK, 'center', { width: 4000, height: 40 }).width).toBe(1512);
  });

  it('прилипание по третям ширины монитора', () => {
    expect(snapAnchor(EXTERNAL, 100)).toBe('left');
    expect(snapAnchor(EXTERNAL, 1720)).toBe('center');
    expect(snapAnchor(EXTERNAL, 3400)).toBe('right');
    expect(snapAnchor(MACBOOK, 1400)).toBe('right');
  });

  it('сохранённый монитор пропал — основной; основного нет в списке — первый', () => {
    expect(resolveDisplay(DISPLAYS, 3, 1)).toBe(MACBOOK);
    expect(resolveDisplay(DISPLAYS, 3, 99)).toBe(EXTERNAL);
    expect(resolveDisplay(DISPLAYS, 3, null)).toBe(EXTERNAL);
    expect(resolveDisplay([MACBOOK], 3, 99)).toBe(MACBOOK);
  });

  it('монитор под курсором; курсор между мониторами — ближайший', () => {
    expect(displayAt(DISPLAYS, 700, 1500)).toBe(MACBOOK);
    expect(displayAt(DISPLAYS, 2000, 10)).toBe(EXTERNAL);
    expect(displayAt(DISPLAYS, 2000, 1600)).toBe(MACBOOK);
  });
});
```

- [ ] **Шаг 2: Реализация** (`placement.ts`):

```ts
/**
 * Место острова у верхнего края монитора (спека острова, разделы 3–5.1): чистые функции без Electron, в DIP.
 * Признак чёлки — встроенный дисплей со строкой меню не ниже `NOTCH_MENU_BAR_MIN` (у MacBook с вырезом 38 px,
 * у внешнего монитора 25 px): API безопасной зоны у Electron нет. Отступ — на всю высоту строки меню, чтобы
 * содержимое острова начиналось ниже физического выреза.
 */

import type { IslandAnchor } from '../../shared/ui-types.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** То, что острову нужно от `Electron.Display`. */
export interface DisplayLike {
  id: number;
  bounds: Rect;
  workArea: Rect;
  internal: boolean;
}

export interface IslandPlacement {
  displayId: number | null;
  anchor: IslandAnchor;
}

export interface Size {
  width: number;
  height: number;
}

/** Поле от бокового края монитора у левой и правой точки. */
export const ISLAND_MARGIN = 12;
const NOTCH_MENU_BAR_MIN = 32;

export function notchInset(display: DisplayLike): number {
  const menuBar = display.workArea.y - display.bounds.y;
  return display.internal && menuBar >= NOTCH_MENU_BAR_MIN ? menuBar : 0;
}

/** Сохранённый монитор; пропал — основной; нет и его — первый из списка. */
export function resolveDisplay(displays: readonly DisplayLike[], primaryId: number, displayId: number | null): DisplayLike {
  const found = displays.find((display) => display.id === displayId) ?? displays.find((display) => display.id === primaryId);
  const result = found ?? displays[0];
  if (result === undefined) throw new Error('no displays');
  return result;
}

export function islandBounds(display: DisplayLike, anchor: IslandAnchor, size: Size): Rect {
  const { bounds } = display;
  const width = Math.min(size.width, bounds.width);
  const x =
    anchor === 'left'
      ? bounds.x + ISLAND_MARGIN
      : anchor === 'right'
        ? bounds.x + bounds.width - width - ISLAND_MARGIN
        : Math.round(bounds.x + (bounds.width - width) / 2);
  return { x, y: bounds.y, width, height: size.height };
}

/** Точка по месту отпускания: трети ширины монитора. */
export function snapAnchor(display: DisplayLike, screenX: number): IslandAnchor {
  const relative = (screenX - display.bounds.x) / display.bounds.width;
  if (relative < 1 / 3) return 'left';
  if (relative > 2 / 3) return 'right';
  return 'center';
}

/** Монитор, в котором точка; вне всех — ближайший (как `screen.getDisplayNearestPoint`). */
export function displayAt(displays: readonly DisplayLike[], x: number, y: number): DisplayLike {
  let best: DisplayLike | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const display of displays) {
    const { bounds } = display;
    const nearestX = Math.min(Math.max(x, bounds.x), bounds.x + bounds.width - 1);
    const nearestY = Math.min(Math.max(y, bounds.y), bounds.y + bounds.height - 1);
    const distance = (x - nearestX) ** 2 + (y - nearestY) ** 2;
    if (distance < bestDistance) {
      best = display;
      bestDistance = distance;
    }
  }
  if (best === undefined) throw new Error('no displays');
  return best;
}
```

- [ ] **Шаг 3: Коммит** (после прогона группы):
```bash
git add packages/desktop/src/main/island/placement.ts packages/desktop/src/main/island/placement.test.ts
git commit -m "feat(desktop): место острова у верхнего края — чёлка, прилипание, пропавший монитор"
```

---

### Задача 3: Контроллер окна острова

**Файлы:**
- Create: `packages/desktop/src/main/island/window.ts`
- Test: `packages/desktop/src/main/island/window.test.ts`

**Interfaces:**
- Consumes: всё из задачи 2.
- Produces:
  - `islandWindowOptions(preloadPath: string): BrowserWindowConstructorOptions`
  - `interface IslandPoint { screenX: number; screenY: number }` — экспорт из `src/shared/island.ts` (задача 4); здесь — импорт
  - `interface IslandWindowLike` (ниже)
  - `createIslandController<W extends IslandWindowLike>(deps: IslandControllerDeps<W>): IslandController<W>` с методами `open()`, `close()`, `current(): W | null`, `isIsland(sender: unknown): boolean`, `setSize(size: Size)`, `setVisible(visible: boolean)`, `dragStart(point)`, `dragMove(point)`, `dragEnd(point)`, `relayout()`, `topInset(): number`.

Задача 3 импортирует `IslandPoint` из `src/shared/island.ts`, который создаёт задача 4. Исполнитель задачи 3 создаёт этот файл с одной строкой-типом, задача 4 его дополняет:

```ts
/** Точка курсора на экране (DIP), из `PointerEvent.screenX/Y` острова. */
export interface IslandPoint {
  screenX: number;
  screenY: number;
}
```

- [ ] **Шаг 1: Тесты** (`window.test.ts`) — на подменном окне, без Electron (модуль `electron` не мокается: `window.ts` импортирует из него только тип):

```ts
import { describe, expect, it, vi } from 'vitest';
import type { DisplayLike, IslandPlacement, Rect } from './placement.js';
import { createIslandController, islandWindowOptions, type IslandWindowLike } from './window.js';

const EXTERNAL: DisplayLike = { id: 3, bounds: { x: 0, y: 0, width: 3440, height: 1440 }, workArea: { x: 0, y: 25, width: 3440, height: 1415 }, internal: false };
const MACBOOK: DisplayLike = { id: 1, bounds: { x: 0, y: 1440, width: 1512, height: 982 }, workArea: { x: 0, y: 1478, width: 1512, height: 944 }, internal: true };

class FakeWindow implements IslandWindowLike {
  bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  visible = false;
  destroyed = false;
  readonly calls: string[] = [];
  private readonly listeners = new Map<string, Array<() => void>>();
  readonly webContents = {
    on: (event: string, listener: () => void) => this.add(`wc:${event}`, listener),
    send: vi.fn(),
  };
  setBounds(rect: Rect): void { this.bounds = rect; }
  getBounds(): Rect { return this.bounds; }
  setAlwaysOnTop(flag: boolean, level: string): void { this.calls.push(`top:${flag}:${level}`); }
  setVisibleOnAllWorkspaces(flag: boolean, options: { visibleOnFullScreen: boolean }): void { this.calls.push(`spaces:${flag}:${options.visibleOnFullScreen}`); }
  showInactive(): void { this.visible = true; this.calls.push('showInactive'); }
  hide(): void { this.visible = false; this.calls.push('hide'); }
  isVisible(): boolean { return this.visible; }
  destroy(): void { this.destroyed = true; this.emit('closed'); }
  isDestroyed(): boolean { return this.destroyed; }
  on(event: 'closed', listener: () => void): void { this.add(event, listener); }
  emit(event: string): void { for (const listener of this.listeners.get(event) ?? []) listener(); }
  private add(event: string, listener: () => void): void { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
}

function setup(placement: IslandPlacement = { displayId: null, anchor: 'center' }) {
  const windows: FakeWindow[] = [];
  let saved = placement;
  let displays: DisplayLike[] = [EXTERNAL, MACBOOK];
  const log = vi.fn();
  const controller = createIslandController<FakeWindow>({
    createWindow: () => {
      const window = new FakeWindow();
      windows.push(window);
      return window;
    },
    displays: () => displays,
    primaryDisplayId: () => 3,
    placement: () => saved,
    savePlacement: (next) => { saved = next; },
    onCreated: vi.fn(),
    log,
  });
  return { controller, windows, log, setDisplays: (next: DisplayLike[]) => { displays = next; }, placement: () => saved };
}

describe('окно острова', () => {
  it('параметры спайка: panel, без рамки, прозрачное, без активации, выше экрана можно', () => {
    const options = islandWindowOptions('/x/preload/island.js');
    expect(options).toMatchObject({
      type: 'panel', frame: false, transparent: true, resizable: false, movable: false, hasShadow: false,
      alwaysOnTop: true, acceptFirstMouse: true, skipTaskbar: true, hiddenInMissionControl: true,
      enableLargerThanScreen: true, show: false,
    });
    expect(options.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, preload: '/x/preload/island.js' });
  });

  it('open: уровень поверх всего, все рабочие столы и полноэкранные приложения, место по центру основного', () => {
    const { controller, windows } = setup();
    controller.open();
    expect(windows[0]?.calls).toEqual(['top:true:screen-saver', 'spaces:true:true']);
    expect(windows[0]?.bounds.y).toBe(0);
    controller.open();
    expect(windows).toHaveLength(1);
  });

  it('показ — только showInactive; повторный показ видимого окна ничего не делает', () => {
    const { controller, windows } = setup();
    controller.open();
    controller.setVisible(true);
    controller.setVisible(true);
    controller.setVisible(false);
    expect(windows[0]?.calls.filter((call) => call === 'showInactive' || call === 'hide')).toEqual(['showInactive', 'hide']);
  });

  it('смена размера держит точку: правый край остаётся у правого поля', () => {
    const { controller, windows } = setup({ displayId: 3, anchor: 'right' });
    controller.open();
    controller.setSize({ width: 220, height: 40 });
    expect(windows[0]?.bounds).toEqual({ x: 3440 - 220 - 12, y: 0, width: 220, height: 40 });
    controller.setSize({ width: 380, height: 160 });
    expect(windows[0]?.bounds).toEqual({ x: 3440 - 380 - 12, y: 0, width: 380, height: 160 });
  });

  it('перетаскивание: вдоль верхнего края, на другой монитор, прилипание и запись места', () => {
    const { controller, windows, placement } = setup();
    controller.open();
    controller.setSize({ width: 380, height: 150 });
    controller.dragStart({ screenX: 1720, screenY: 10 });
    controller.dragMove({ screenX: 700, screenY: 1500 });
    expect(windows[0]?.bounds.y).toBe(1440);
    controller.dragEnd({ screenX: 700, screenY: 1500 });
    expect(placement()).toEqual({ displayId: 1, anchor: 'center' });
    expect(windows[0]?.bounds).toEqual({ x: 566, y: 1440, width: 380, height: 150 });
    expect(controller.topInset()).toBe(38);
  });

  it('монитор пропал — relayout переносит остров на основной', () => {
    const { controller, windows, setDisplays } = setup({ displayId: 1, anchor: 'center' });
    controller.open();
    controller.setSize({ width: 380, height: 150 });
    setDisplays([EXTERNAL]);
    controller.relayout();
    expect(windows[0]?.bounds).toEqual({ x: 1530, y: 0, width: 380, height: 150 });
  });

  it('isIsland — только webContents живого окна острова', () => {
    const { controller, windows } = setup();
    expect(controller.isIsland({})).toBe(false);
    controller.open();
    expect(controller.isIsland(windows[0]?.webContents)).toBe(true);
    expect(controller.isIsland({})).toBe(false);
    controller.close();
    expect(controller.isIsland(windows[0]?.webContents)).toBe(false);
  });

  it('renderer упал — одно пересоздание и запись в лог; второе падение — окна нет', () => {
    const { controller, windows, log } = setup();
    controller.open();
    windows[0]?.emit('wc:render-process-gone');
    expect(windows).toHaveLength(2);
    expect(controller.current()).toBe(windows[1]);
    windows[1]?.emit('wc:render-process-gone');
    expect(windows).toHaveLength(2);
    expect(controller.current()).toBeNull();
    expect(log).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Шаг 2: Реализация** (`window.ts`):

```ts
/**
 * Окно острова (спека 2026-10-12, разделы 3 и 5.1). Параметры — из спайка на Electron 44: `panel`
 * (`NSWindowStyleMaskNonactivatingPanel` — клик не поднимает Parley), уровень `screen-saver`, все рабочие столы и
 * полноэкранные приложения, `acceptFirstMouse` (первый клик по неактивному окну доходит до кнопки) и
 * `enableLargerThanScreen` — без него macOS сдвигает видимое окно под строку меню (y = 25 на внешнем мониторе,
 * под строку чёлки на MacBook). Показ — только `showInactive()`: `show()` и `focus()` активировали бы приложение.
 *
 * Контроллер не знает Electron: окно, мониторы и запись места приходят зависимостями — так его можно проверить на
 * подменах. Место держит верхний край и точку (`anchor`): смена размера и перетаскивание пересчитывают прямоугольник
 * через `placement.ts`. Упал renderer — одно пересоздание; второе падение — острова нет до перезапуска приложения:
 * зависшее прозрачное окно поверх всего хуже, чем его отсутствие.
 */

import type { BrowserWindowConstructorOptions } from 'electron';
import type { IslandPoint } from '../../shared/island.js';
import {
  displayAt,
  islandBounds,
  notchInset,
  resolveDisplay,
  snapAnchor,
  type DisplayLike,
  type IslandPlacement,
  type Rect,
  type Size,
} from './placement.js';

export function islandWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 220,
    height: 40,
    type: 'panel',
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    enableLargerThanScreen: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: preloadPath, webviewTag: false },
  };
}

/** То, что контроллеру нужно от `BrowserWindow`. */
export interface IslandWindowLike {
  readonly webContents: { on(event: 'render-process-gone', listener: () => void): unknown; send(channel: string, ...args: unknown[]): void };
  setBounds(rect: Rect): void;
  getBounds(): Rect;
  setAlwaysOnTop(flag: boolean, level: 'screen-saver'): void;
  setVisibleOnAllWorkspaces(flag: boolean, options: { visibleOnFullScreen: boolean }): void;
  showInactive(): void;
  hide(): void;
  isVisible(): boolean;
  destroy(): void;
  isDestroyed(): boolean;
  on(event: 'closed', listener: () => void): unknown;
}

export interface IslandControllerDeps<W extends IslandWindowLike> {
  createWindow(): W;
  displays(): readonly DisplayLike[];
  primaryDisplayId(): number;
  /** Текущее место из настроек (кеш main: запись в `ui.json` асинхронная). */
  placement(): IslandPlacement;
  savePlacement(placement: IslandPlacement): void;
  /** Окно создано: main вешает пересылку событий хоста и отдаёт настройки. */
  onCreated(window: W): void;
  log(message: string): void;
}

export interface IslandController<W extends IslandWindowLike> {
  open(): void;
  close(): void;
  current(): W | null;
  isIsland(sender: unknown): boolean;
  setSize(size: Size): void;
  setVisible(visible: boolean): void;
  dragStart(point: IslandPoint): void;
  dragMove(point: IslandPoint): void;
  dragEnd(point: IslandPoint): void;
  /** Мониторы изменились — место заново из сохранённой точки. */
  relayout(): void;
  /** Отступ содержимого под чёлку у текущего монитора острова. */
  topInset(): number;
}

const INITIAL_SIZE: Size = { width: 220, height: 40 };

export function createIslandController<W extends IslandWindowLike>(deps: IslandControllerDeps<W>): IslandController<W> {
  let window: W | null = null;
  let size: Size = INITIAL_SIZE;
  let crashes = 0;
  let dragging = false;
  let dragOffsetX = 0;

  const live = (): W | null => (window !== null && !window.isDestroyed() ? window : null);
  const display = (): DisplayLike => resolveDisplay(deps.displays(), deps.primaryDisplayId(), deps.placement().displayId);
  const place = (): void => {
    const current = live();
    if (current === null) return;
    current.setBounds(islandBounds(display(), deps.placement().anchor, size));
  };

  const open = (): void => {
    if (live() !== null) return;
    const created = deps.createWindow();
    created.setAlwaysOnTop(true, 'screen-saver');
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    created.on('closed', () => {
      if (window === created) window = null;
    });
    created.webContents.on('render-process-gone', () => {
      crashes += 1;
      deps.log(`island renderer gone (${crashes})`);
      if (window === created) window = null;
      if (!created.isDestroyed()) created.destroy();
      if (crashes === 1) open();
    });
    window = created;
    place();
    deps.onCreated(created);
  };

  return {
    open,
    close: () => {
      const current = live();
      window = null;
      current?.destroy();
    },
    current: live,
    isIsland: (sender) => {
      const current = live();
      return current !== null && sender === current.webContents;
    },
    setSize: (next) => {
      size = next;
      if (!dragging) place();
    },
    setVisible: (visible) => {
      const current = live();
      if (current === null) return;
      if (!visible) {
        if (current.isVisible()) current.hide();
        return;
      }
      if (current.isVisible()) return;
      place();
      current.showInactive();
    },
    dragStart: (point) => {
      const current = live();
      if (current === null) return;
      dragging = true;
      dragOffsetX = point.screenX - current.getBounds().x;
    },
    dragMove: (point) => {
      const current = live();
      if (current === null || !dragging) return;
      const under = displayAt(deps.displays(), point.screenX, point.screenY);
      current.setBounds({ x: Math.round(point.screenX - dragOffsetX), y: under.bounds.y, width: size.width, height: size.height });
    },
    dragEnd: (point) => {
      if (live() === null || !dragging) return;
      dragging = false;
      const under = displayAt(deps.displays(), point.screenX, point.screenY);
      deps.savePlacement({ displayId: under.id, anchor: snapAnchor(under, point.screenX) });
      place();
    },
    relayout: place,
    topInset: () => notchInset(display()),
  };
}
```

- [ ] **Шаг 3: Коммит** (после прогона группы):
```bash
git add packages/desktop/src/main/island/window.ts packages/desktop/src/main/island/window.test.ts packages/desktop/src/shared/island.ts
git commit -m "feat(desktop): контроллер окна острова — panel без активации, место, перетаскивание, пересоздание"
```

---

### Задача 4: Мост острова — общие типы, IPC в main, белый список, `islandActive`

**Файлы:**
- Modify/Create: `packages/desktop/src/shared/island.ts` (дополнить созданный в задаче 3)
- Create: `packages/desktop/src/main/island/ipc.ts`
- Modify: `packages/desktop/src/main/ipc.ts` (`RegisterIpcOptions`, обработчик `host:call` ~строки 318–326, экспорт `isFocusTarget` ~строка 117, новый канал `app:island-active`)
- Modify: `packages/desktop/src/shared/bridge.ts` (`app.islandActive(): boolean`)
- Modify: `packages/desktop/src/preload/index.ts` (`app.islandActive`)
- Test: `packages/desktop/src/main/island/ipc.test.ts`, `packages/desktop/src/main/ipc.test.ts`

**Interfaces:**
- Consumes: `IslandController` (задача 3), `withIpcError`, `isFocusTarget` (`main/ipc.ts`).
- Produces (`shared/island.ts`):
  - `IslandPoint` (задача 3)
  - `interface IslandConfig { sound: boolean; hintShown: boolean; topInset: number }`
  - `interface IslandApi { config(): Promise<IslandConfig>; onConfig(listener: (config: IslandConfig) => void): () => void; setSize(width: number, height: number): void; setVisible(visible: boolean): void; dragStart(point: IslandPoint): void; dragMove(point: IslandPoint): void; dragEnd(point: IslandPoint): void; open(target: FocusTarget): void; beep(): void; hintShown(): void }`
  - `type IslandBridge = Pick<ParleyBridge, 'call' | 'on' | 'onStatus' | 'activitySnapshot'> & { island: IslandApi }`
  - `const ISLAND_METHODS: ReadonlySet<string>` = `works.list`, `feed.snapshot`, `feed.decide`
  - `const ISLAND_EXCLUDED_PROVIDERS: ReadonlySet<string>` = `codex`
- Produces (`main/island/ipc.ts`): `registerIslandIpc(options: IslandIpcOptions): void`
- Produces (`main/ipc.ts`): `RegisterIpcOptions.isIslandSender?: (sender: unknown) => boolean`, `RegisterIpcOptions.islandActive?: () => boolean`; `export function isFocusTarget`.
- Produces (`bridge.ts`): `ParleyBridge['app']['islandActive']: () => boolean`.

- [ ] **Шаг 1: Тесты белого списка** — в `main/ipc.test.ts` (в `setup()` добавить опции `isIslandSender` и `islandActive` в `overrides` и в вызов `registerIpc`):

```ts
describe('host:call от острова', () => {
  const island = { id: 99 };
  const options = { isIslandSender: (sender: unknown) => sender === island };

  it('остров зовёт методы белого списка', async () => {
    const { ipcMain, connection } = setup(options);
    await ipcMain.invokeWithEvent('host:call', { sender: island }, 'feed.snapshot', { ref: REF });
    expect(connection.call).toHaveBeenCalledWith('feed.snapshot', { ref: REF });
  });

  it('прочие методы острову отказаны, хост их не видит', async () => {
    const { ipcMain, connection } = setup(options);
    await expect(ipcMain.invokeWithEvent('host:call', { sender: island }, 'host.shutdown', {})).rejects.toBeTruthy();
    expect(connection.call).not.toHaveBeenCalled();
  });

  it('главное окно зовёт что угодно, как раньше', async () => {
    const { ipcMain, connection } = setup(options);
    await ipcMain.invokeWithEvent('host:call', { sender: { id: 1 } }, 'host.shutdown', {});
    expect(connection.call).toHaveBeenCalledWith('host.shutdown', {});
  });

  it('app:island-active отвечает синхронно тем, что знает main', () => {
    const event: { returnValue?: unknown } = {};
    const { ipcMain } = setup({ islandActive: () => true });
    ipcMain.invokeWithEvent('app:island-active', event);
    expect(event.returnValue).toBe(true);
  });
});
```

(`REF` — константа ссылки на сессию, уже есть в файле; если нет — `{ projectPath: '/p', workId: 'w-1', sessionId: 's-01' }`.)

- [ ] **Шаг 2: Тесты IPC острова** (`main/island/ipc.test.ts`):

```ts
import { describe, expect, it, vi } from 'vitest';
import { registerIslandIpc } from './ipc.js';

class FakeIpcMain {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
  handle(channel: string, fn: (...args: unknown[]) => unknown): void { this.handlers.set(channel, fn); }
  on(channel: string, fn: (...args: unknown[]) => unknown): void { this.handlers.set(channel, fn); }
  emit(channel: string, event: unknown, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error(`нет обработчика для ${channel}`);
    return handler(event, ...args);
  }
}

const island = { id: 99 };
const stranger = { id: 1 };

function setup() {
  const ipcMain = new FakeIpcMain();
  const controller = {
    isIsland: (sender: unknown) => sender === island,
    setSize: vi.fn(), setVisible: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(),
  };
  const options = {
    ipcMain,
    controller,
    config: vi.fn().mockResolvedValue({ sound: true, hintShown: false, topInset: 38 }),
    pushConfig: vi.fn(),
    openTarget: vi.fn(),
    beep: vi.fn(),
    markHintShown: vi.fn(),
  };
  registerIslandIpc(options);
  return { ipcMain, ...options };
}

describe('IPC острова', () => {
  it('размер, видимость и перетаскивание — только от окна острова и только целые данные', () => {
    const { ipcMain, controller, pushConfig } = setup();
    ipcMain.emit('island:size', { sender: island }, 380, 150);
    ipcMain.emit('island:size', { sender: stranger }, 10, 10);
    ipcMain.emit('island:size', { sender: island }, -1, 'x');
    expect(controller.setSize.mock.calls).toEqual([[{ width: 380, height: 150 }]]);
    ipcMain.emit('island:visible', { sender: island }, true);
    expect(controller.setVisible).toHaveBeenCalledWith(true);
    ipcMain.emit('island:drag-end', { sender: island }, { screenX: 10, screenY: 20 });
    expect(controller.dragEnd).toHaveBeenCalledWith({ screenX: 10, screenY: 20 });
    expect(pushConfig).toHaveBeenCalledTimes(1);
  });

  it('config — острову; чужому окну — отказ', async () => {
    const { ipcMain } = setup();
    await expect(ipcMain.emit('island:config', { sender: island })).resolves.toEqual({ sound: true, hintShown: false, topInset: 38 });
    await expect(ipcMain.emit('island:config', { sender: stranger })).rejects.toBeTruthy();
  });

  it('open ведёт в главное окно только целой целью', () => {
    const { ipcMain, openTarget } = setup();
    const target = { kind: 'session', ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-01' }, cardId: 'c-1' };
    ipcMain.emit('island:open', { sender: island }, target);
    ipcMain.emit('island:open', { sender: island }, { kind: 'session' });
    expect(openTarget.mock.calls).toEqual([[target]]);
  });

  it('звук и подсказка', () => {
    const { ipcMain, beep, markHintShown } = setup();
    ipcMain.emit('island:beep', { sender: island });
    ipcMain.emit('island:hint-shown', { sender: island });
    ipcMain.emit('island:beep', { sender: stranger });
    expect(beep).toHaveBeenCalledTimes(1);
    expect(markHintShown).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Шаг 3: Реализация `shared/island.ts`** (дополнить):

```ts
/**
 * Остров одобрений (спека 2026-10-12): общие типы main, preload острова и его renderer. Мост острова — узкий:
 * вызовы и события хоста, статус, снимок активности и свои каналы `island:*`; общий preload окна (файлы, диалоги,
 * браузер, голос, отложенная цель клика) острову не даётся.
 */

import type { FocusTarget, ParleyBridge } from './bridge.js';

export interface IslandPoint {
  screenX: number;
  screenY: number;
}

/** Что острову нужно из настроек и места: звук по Sound, показана ли подсказка, отступ под чёлку. */
export interface IslandConfig {
  sound: boolean;
  hintShown: boolean;
  topInset: number;
}

export interface IslandApi {
  config(): Promise<IslandConfig>;
  onConfig(listener: (config: IslandConfig) => void): () => void;
  setSize(width: number, height: number): void;
  setVisible(visible: boolean): void;
  dragStart(point: IslandPoint): void;
  dragMove(point: IslandPoint): void;
  dragEnd(point: IslandPoint): void;
  /** Показать главное окно (создать, если закрыто) и открыть в нём цель. */
  open(target: FocusTarget): void;
  beep(): void;
  hintShown(): void;
}

export type IslandBridge = Pick<ParleyBridge, 'call' | 'on' | 'onStatus' | 'activitySnapshot'> & { island: IslandApi };

/** Методы хоста, которые main пропускает от острова (`host:call` по отправителю). */
export const ISLAND_METHODS: ReadonlySet<string> = new Set(['works.list', 'feed.snapshot', 'feed.decide']);

/** Провайдеры вне острова (решение 2026-10-12): Codex — системными уведомлениями, как раньше. */
export const ISLAND_EXCLUDED_PROVIDERS: ReadonlySet<string> = new Set(['codex']);
```

- [ ] **Шаг 4: Реализация `main/island/ipc.ts`:**

```ts
/**
 * Каналы острова в main (спека 2026-10-12, 5.1). Каждый слушает только окно острова (`controller.isIsland`):
 * чужое окно с тем же именем канала ничего не двигает. Данные проверяются по форме: размер — положительные
 * конечные числа, точка — два числа, цель — `isFocusTarget`, как у уведомлений.
 */

import type { IpcMain } from 'electron';
import type { FocusTarget } from '../../shared/bridge.js';
import type { IslandConfig, IslandPoint } from '../../shared/island.js';
import { isFocusTarget, withIpcError } from '../ipc.js';
import type { IslandController, IslandWindowLike } from './window.js';

export interface IslandIpcOptions {
  ipcMain: Pick<IpcMain, 'on' | 'handle'>;
  controller: Pick<IslandController<IslandWindowLike>, 'isIsland' | 'setSize' | 'setVisible' | 'dragStart' | 'dragMove' | 'dragEnd'>;
  config(): Promise<IslandConfig>;
  /** Место могло смениться (другой монитор — другой отступ под чёлку): отдать острову настройки заново. */
  pushConfig(): void;
  openTarget(target: FocusTarget): void;
  beep(): void;
  markHintShown(): void;
}

const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

function isPoint(value: unknown): value is IslandPoint {
  if (typeof value !== 'object' || value === null) return false;
  const { screenX, screenY } = value as Record<string, unknown>;
  return typeof screenX === 'number' && Number.isFinite(screenX) && typeof screenY === 'number' && Number.isFinite(screenY);
}

export function registerIslandIpc(options: IslandIpcOptions): void {
  const { ipcMain, controller } = options;
  const fromIsland = (event: unknown): boolean => controller.isIsland((event as { sender?: unknown }).sender);

  ipcMain.handle(
    'island:config',
    withIpcError(async (event) => {
      if (!fromIsland(event)) throw new Error('island:config is for the island window only');
      return options.config();
    }),
  );
  ipcMain.on('island:size', (event, width: unknown, height: unknown) => {
    if (fromIsland(event) && isSize(width) && isSize(height)) controller.setSize({ width: Math.ceil(width), height: Math.ceil(height) });
  });
  ipcMain.on('island:visible', (event, visible: unknown) => {
    if (fromIsland(event) && typeof visible === 'boolean') controller.setVisible(visible);
  });
  ipcMain.on('island:drag-start', (event, point: unknown) => {
    if (fromIsland(event) && isPoint(point)) controller.dragStart(point);
  });
  ipcMain.on('island:drag-move', (event, point: unknown) => {
    if (fromIsland(event) && isPoint(point)) controller.dragMove(point);
  });
  ipcMain.on('island:drag-end', (event, point: unknown) => {
    if (!fromIsland(event) || !isPoint(point)) return;
    controller.dragEnd(point);
    options.pushConfig();
  });
  ipcMain.on('island:open', (event, target: unknown) => {
    if (fromIsland(event) && isFocusTarget(target)) options.openTarget(target);
  });
  ipcMain.on('island:beep', (event) => {
    if (fromIsland(event)) options.beep();
  });
  ipcMain.on('island:hint-shown', (event) => {
    if (fromIsland(event)) options.markHintShown();
  });
}
```

- [ ] **Шаг 5: Белый список и `islandActive` в `main/ipc.ts`.** Сделать `isFocusTarget` экспортом (`export function isFocusTarget`). В `RegisterIpcOptions` добавить:

```ts
  /** Окно острова (спека 2026-10-12): от него `host:call` пропускает только `ISLAND_METHODS`. */
  isIslandSender?: (sender: unknown) => boolean;
  /** Есть ли живое окно острова — для `notify.ts` главного окна (`app:island-active`). */
  islandActive?: () => boolean;
```

Обработчик `host:call` — проверка перед вызовом хоста:

```ts
  ipcMain.handle(
    'host:call',
    withIpcError(async (event, method: unknown, params: unknown) => {
      if (typeof method !== 'string' || !isMethodName(method)) {
        throw new Error(`unknown method: ${String(method)}`);
      }
      // Остров — узкий клиент: остальное ему не нужно, а `host.shutdown` из прозрачного окна поверх всего — тем более.
      if (isIslandSender?.((event as { sender?: unknown }).sender) === true && !ISLAND_METHODS.has(method)) {
        throw new Error(`method not allowed for the island: ${method}`);
      }
      return connection.call(method, params);
    }),
  );
```

Рядом с `host:activity-snapshot`:

```ts
  ipcMain.on('app:island-active', (event) => {
    (event as { returnValue: unknown }).returnValue = islandActive?.() === true;
  });
```

(`isIslandSender`, `islandActive` — достать из `options` деструктуризацией, как остальные ключи; импорт `ISLAND_METHODS` из `../shared/island.js`.)

- [ ] **Шаг 6: `app.islandActive` в мосте главного окна.** В `shared/bridge.ts`, в `app`:

```ts
    /** Есть ли окно острова (спека 2026-10-12): пока есть, уведомление о запросе с карточкой не шлётся. */
    islandActive(): boolean;
```

В `preload/index.ts`, в объекте `app` рядом с `isDark`:

```ts
    islandActive: () => ipcRenderer.sendSync('app:island-active') === true,
```

В `preload/index.test.ts` в мок `ipcRenderer` добавить `sendSync: vi.fn()`, если его там нет, и тест:

```ts
it('islandActive — синхронный вопрос main', async () => {
  const bridge = await loadPreload();
  const { ipcRenderer } = await import('electron');
  vi.mocked(ipcRenderer.sendSync).mockReturnValueOnce(true);
  expect(bridge.app.islandActive()).toBe(true);
  expect(ipcRenderer.sendSync).toHaveBeenCalledWith('app:island-active');
});
```

И `FakeBridge` (`renderer/test-utils/fake-bridge.ts`) — иначе его объект перестанет соответствовать `ParleyBridge`: поле `let islandActive = false;`, в объект `app` — `islandActive: () => islandActive,`, в интерфейс `FakeBridge` и в объект — `setIslandActive(value: boolean): void` (`islandActive = value`). Добавить файл в коммит задачи 4.

- [ ] **Шаг 7: Прогон группы 1 (задачи 1–4).** Проверить загрузку (`uptime`, `memory_pressure -Q`), затем по одному:

```bash
nice -n 10 pnpm --filter @parley/desktop exec vitest run src/shared/ui-types.test.ts src/main/ui-store.test.ts src/main/island src/main/ipc.test.ts src/preload/index.test.ts
nice -n 10 pnpm --filter @parley/desktop typecheck
```
Expected: всё зелёное. Красное — чинить в своём куске, не трогая чужие тесты.

- [ ] **Шаг 8: Коммит задач 1–4** (отдельными коммитами по задачам, как в их шагах «Коммит»; задача 4):
```bash
git add packages/desktop/src/shared/island.ts packages/desktop/src/main/island/ipc.ts packages/desktop/src/main/island/ipc.test.ts packages/desktop/src/main/ipc.ts packages/desktop/src/main/ipc.test.ts packages/desktop/src/shared/bridge.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/index.test.ts packages/desktop/src/renderer/test-utils/fake-bridge.ts
git commit -m "feat(desktop): каналы острова в main, белый список методов хоста, app.islandActive"
```

---

### Задача 5: Preload острова

**Файлы:**
- Create: `packages/desktop/src/preload/island.ts`
- Test: `packages/desktop/src/preload/island.test.ts`
- Modify: `packages/desktop/electron.vite.config.ts` (секция `preload`, строки ~58–72)

**Interfaces:**
- Consumes: `IslandBridge`, `IslandConfig` (задача 4); `HostStatus` (`shared/bridge.ts`); `EventMessage`, `EventName`, `MethodName` — те же импорты, что в `preload/index.ts`.
- Produces: `window.parley` в окне острова — объект ровно с ключами `call`, `on`, `onStatus`, `activitySnapshot`, `island`; сборка кладёт его в `out/preload/island.js`.

- [ ] **Шаг 1: Тест** (`preload/island.test.ts`, мок `electron` — как в `preload/index.test.ts`):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostStatus } from '../shared/bridge.js';
import type { IslandBridge, IslandConfig } from '../shared/island.js';

type Handler = (event: unknown, ...args: unknown[]) => void;

const handlers = new Map<string, Handler>();
let exposed: IslandBridge | null = null;
const send = vi.fn();
const invoke = vi.fn();

vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
    send,
    invoke,
  },
  contextBridge: {
    exposeInMainWorld: (_key: string, api: unknown) => {
      exposed = api as IslandBridge;
    },
  },
}));

async function loadPreload(): Promise<IslandBridge> {
  handlers.clear();
  exposed = null;
  vi.resetModules();
  await import('./island.js');
  if (exposed === null) throw new Error('preload острова не выставил мост');
  return exposed;
}

const emit = (channel: string, ...args: unknown[]): void => handlers.get(channel)?.({}, ...args);

describe('preload острова', () => {
  beforeEach(() => {
    send.mockClear();
    invoke.mockClear();
  });

  it('в мосте только узкий набор: ни app, ни files, ни browser, ни voice, ни notify', async () => {
    const bridge = await loadPreload();
    expect(Object.keys(bridge).sort()).toEqual(['activitySnapshot', 'call', 'island', 'on', 'onStatus']);
    expect(Object.keys(bridge.island).sort()).toEqual(
      ['beep', 'config', 'dragEnd', 'dragMove', 'dragStart', 'hintShown', 'onConfig', 'open', 'setSize', 'setVisible'].sort(),
    );
  });

  it('события хоста раскладываются по подписчикам, статус отдаётся и опоздавшему', async () => {
    const bridge = await loadPreload();
    const seen: unknown[] = [];
    bridge.on('works.changed', (data) => seen.push(data));
    emit('host:event', { event: 'works.changed', data: { x: 1 } });
    emit('host:status', { state: 'connecting' } satisfies HostStatus);
    const statuses: HostStatus[] = [];
    bridge.onStatus((status) => statuses.push(status));
    expect(seen).toEqual([{ x: 1 }]);
    expect(statuses).toEqual([{ state: 'connecting' }]);
  });

  it('настройки острова приходят событием island:config', async () => {
    const bridge = await loadPreload();
    const configs: IslandConfig[] = [];
    bridge.island.onConfig((config) => configs.push(config));
    emit('island:config', { sound: false, hintShown: true, topInset: 38 });
    expect(configs).toEqual([{ sound: false, hintShown: true, topInset: 38 }]);
  });

  it('каналы острова — island:*', async () => {
    const bridge = await loadPreload();
    bridge.island.setSize(380, 150);
    bridge.island.setVisible(true);
    bridge.island.dragEnd({ screenX: 1, screenY: 2 });
    bridge.island.beep();
    expect(send.mock.calls).toEqual([
      ['island:size', 380, 150],
      ['island:visible', true],
      ['island:drag-end', { screenX: 1, screenY: 2 }],
      ['island:beep'],
    ]);
    void bridge.island.config();
    expect(invoke).toHaveBeenCalledWith('island:config');
  });
});
```

- [ ] **Шаг 2: Реализация** (`preload/island.ts`):

```ts
/**
 * Preload окна острова (спека 2026-10-12, 5.2): узкий мост вместо общего `preload/index.ts`. Острову не нужны файлы,
 * диалоги, браузер и голос, а подписка `app.onFocusTarget` общего моста забрала бы у главного окна отложенную цель
 * клика по уведомлению (`app:take-focus-target`). Белый список методов хоста держит ещё и main (`host:call` по
 * отправителю) — на случай ошибки здесь.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { EventMessage, EventName, MethodName } from '@parley/protocol';
import type { HostStatus } from '../shared/bridge.js';
import type { IslandBridge, IslandConfig, IslandPoint } from '../shared/island.js';

const eventListeners = new Map<EventName, Set<(data: unknown) => void>>();
const statusListeners = new Set<(status: HostStatus) => void>();
const configListeners = new Set<(config: IslandConfig) => void>();
/** Последний статус: подписчик, пришедший позже события, получает его сразу (как в общем preload). */
let lastStatus: HostStatus | null = null;

ipcRenderer.on('host:event', (_event, message: EventMessage) => {
  for (const listener of eventListeners.get(message.event) ?? []) listener(message.data);
});
ipcRenderer.on('host:status', (_event, status: HostStatus) => {
  lastStatus = status;
  for (const listener of statusListeners) listener(status);
});
ipcRenderer.on('island:config', (_event, config: IslandConfig) => {
  for (const listener of configListeners) listener(config);
});

const bridge = {
  call: (method: MethodName, params: unknown) => ipcRenderer.invoke('host:call', method, params),
  on: (event: EventName, listener: (data: unknown) => void) => {
    let set = eventListeners.get(event);
    if (set === undefined) {
      set = new Set();
      eventListeners.set(event, set);
    }
    set.add(listener);
    return () => {
      eventListeners.get(event)?.delete(listener);
    };
  },
  onStatus: (listener: (status: HostStatus) => void) => {
    statusListeners.add(listener);
    if (lastStatus !== null) listener(lastStatus);
    return () => {
      statusListeners.delete(listener);
    };
  },
  activitySnapshot: () => ipcRenderer.invoke('host:activity-snapshot'),
  island: {
    config: () => ipcRenderer.invoke('island:config') as Promise<IslandConfig>,
    onConfig: (listener: (config: IslandConfig) => void) => {
      configListeners.add(listener);
      return () => {
        configListeners.delete(listener);
      };
    },
    setSize: (width: number, height: number) => ipcRenderer.send('island:size', width, height),
    setVisible: (visible: boolean) => ipcRenderer.send('island:visible', visible),
    dragStart: (point: IslandPoint) => ipcRenderer.send('island:drag-start', point),
    dragMove: (point: IslandPoint) => ipcRenderer.send('island:drag-move', point),
    dragEnd: (point: IslandPoint) => ipcRenderer.send('island:drag-end', point),
    open: (target: unknown) => ipcRenderer.send('island:open', target),
    beep: () => ipcRenderer.send('island:beep'),
    hintShown: () => ipcRenderer.send('island:hint-shown'),
  },
};

contextBridge.exposeInMainWorld('parley', bridge as unknown as IslandBridge);
```

(Если `EventMessage` в `@parley/protocol` называется иначе — взять ровно тот импорт, что в `preload/index.ts`.)

- [ ] **Шаг 3: Второй вход preload в `electron.vite.config.ts`:**

```ts
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Второй вход — узкий preload острова (спека 2026-10-12, 5.2); оба кладутся рядом: out/preload/<имя>.js.
        input: { index: resolve(dirname, 'src/preload/index.ts'), island: resolve(dirname, 'src/preload/island.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
```

- [ ] **Шаг 4: Коммит** (после прогона группы 2 — задача 6, шаг «Прогон»):
```bash
git add packages/desktop/src/preload/island.ts packages/desktop/src/preload/island.test.ts packages/desktop/electron.vite.config.ts
git commit -m "feat(desktop): узкий preload острова — хост, статус, активность и каналы island:*"
```

---

### Задача 6: Остров в main — создание по настройке, переключатель E2E, Dock

**Файлы:**
- Modify: `packages/desktop/src/main/test-switches.ts` (+ поле `islandOff`)
- Modify: `packages/desktop/src/main/test-switches.test.ts`
- Modify: `packages/desktop/src/main/index.ts` (после создания главного окна и `notifier`, ~строки 350–373; `registerIpc` ~437; `activate` ~556)
- Modify: `packages/desktop/playwright.config.ts`

**Interfaces:**
- Consumes: `createIslandController`, `islandWindowOptions` (задача 3), `registerIslandIpc` (задача 4), `guardNavigation`, `forwardHostToPages` (существующие).
- Produces: `TestSwitches.islandOff: boolean` (`PARLEY_ISLAND=off`).

- [ ] **Шаг 1: Тест переключателя** (`test-switches.test.ts`, по образцу соседних):

```ts
it('PARLEY_ISLAND=off выключает остров в неупакованном окне, в сборке без PARLEY_E2E — нет', () => {
  expect(testSwitches({ PARLEY_ISLAND: 'off' }, false).islandOff).toBe(true);
  expect(testSwitches({ PARLEY_ISLAND: 'on' }, false).islandOff).toBe(false);
  expect(testSwitches({ PARLEY_ISLAND: 'off' }, true).islandOff).toBe(false);
  expect(testSwitches({ PARLEY_ISLAND: 'off', PARLEY_E2E: '1' }, true).islandOff).toBe(true);
});
```

Тест `const all = { downloads: true, … }` (строка ~70) дополнить `islandOff: true` в ожидаемом наборе, если он сверяет все поля.

- [ ] **Шаг 2: Переключатель** — в `TestSwitches`:

```ts
  /** Острова нет (`PARLEY_ISLAND=off`): E2E берут первое окно и считают окна — остров им мешал бы (спека 2026-10-12, 5.1). */
  readonly islandOff: boolean;
```

в `testSwitches(...)` — `islandOff: allowed && envValue(env, 'ISLAND') === 'off',`. В шапку модуля — `PARLEY_ISLAND=off` в перечень.

- [ ] **Шаг 3: `playwright.config.ts`** — рядом с прочими:

```ts
// Острова нет: 93 места в e2e берут первое окно, smoke и browser считают окна. Спека острова снимает переменную сама.
process.env.PARLEY_ISLAND = 'off';
```

- [ ] **Шаг 4: Подключение в `main/index.ts`.** Импорты: `screen`, `shell` из `electron` (добавить к существующему импорту), `createIslandController`, `islandWindowOptions` из `./island/window.js`, `registerIslandIpc` из `./island/ipc.js`, тип `IslandPlacement` из `./island/placement.js`, тип `FocusTarget` из `../shared/bridge.js`.

Пути — рядом с `preloadPath`/`indexHtmlPath` (~строка 224):

```ts
  const islandPreloadPath = path.join(dirname, '../preload/island.js');
  const islandHtmlPath = path.join(dirname, '../renderer/island.html');
```

Отправку цели вынести из `createNotifier` в константу (тот же код, что сейчас в `sendFocusTarget` нотификатора) и отдать её и нотификатору, и острову:

```ts
  /** Цель клика (уведомление, остров): окну, если оно загружено, иначе — в отложенные. */
  const sendFocusTarget = (target: FocusTarget): void => {
    const window = mainWindow;
    if (window !== null && !window.isDestroyed() && loadedWindows.has(window)) {
      window.webContents.send('app:focus-target', target);
    } else {
      pendingFocusTarget.put(target);
    }
  };
```

В `createNotifier({...})` — `sendFocusTarget,` вместо прежней лямбды.

Сразу после `notifier` — остров:

```ts
  // Остров одобрений (спека 2026-10-12): окно по настройке «Island»; место — кеш из ui.json, запись асинхронная.
  let islandPlacement: IslandPlacement = { displayId: ui.island.displayId, anchor: ui.island.anchor };
  const island = createIslandController<BrowserWindow>({
    createWindow: () => {
      const window = new BrowserWindow(islandWindowOptions(islandPreloadPath));
      guardNavigation(window.webContents, `file://${islandHtmlPath}`);
      void window.loadFile(islandHtmlPath);
      return window;
    },
    displays: () => screen.getAllDisplays(),
    primaryDisplayId: () => screen.getPrimaryDisplay().id,
    placement: () => islandPlacement,
    savePlacement: (placement) => {
      islandPlacement = placement;
      void uiStore.save({ island: { ...placement } } as Partial<Omit<UiFile, 'version'>>).catch(() => undefined);
    },
    onCreated: (window) => {
      forwardHostToPages(connection, window);
      window.webContents.on('did-finish-load', () => pushIslandConfig());
    },
    log: (message) => console.warn('[parley]', message),
  });
  const islandConfig = async (): Promise<IslandConfig> => {
    const current = await uiStore.load();
    return { sound: current.notifications.sound, hintShown: current.island.hintShown, topInset: island.topInset() };
  };
  const pushIslandConfig = (): void => {
    void islandConfig().then((config) => {
      const window = island.current();
      if (window !== null) window.webContents.send('island:config', config);
    });
  };
  /** Настройка решает, есть ли окно; `PARLEY_ISLAND=off` (E2E) — острова нет в любом случае. */
  const syncIsland = (current: UiFile): void => {
    islandPlacement = { displayId: current.island.displayId, anchor: current.island.anchor };
    if (current.island.enabled && !switches.islandOff) island.open();
    else island.close();
    pushIslandConfig();
  };
  syncIsland(ui);
  // Мониторы подключили, отключили, сменили разрешение — место заново из сохранённой точки, отступ под чёлку заново.
  const relayoutIsland = (): void => {
    island.relayout();
    pushIslandConfig();
  };
  screen.on('display-added', relayoutIsland);
  screen.on('display-removed', relayoutIsland);
  screen.on('display-metrics-changed', relayoutIsland);
  registerIslandIpc({
    ipcMain,
    controller: island,
    config: islandConfig,
    pushConfig: pushIslandConfig,
    openTarget: (target) => {
      focusMainWindow();
      sendFocusTarget(target);
    },
    beep: () => shell.beep(),
    markHintShown: () => {
      void uiStore.save({ island: { hintShown: true } } as Partial<Omit<UiFile, 'version'>>).then(() => pushIslandConfig());
    },
  });
```

(`ui` — уже прочитанный при старте `await uiStore.load()`, ~строка 221; `UiFile`, `IslandConfig` — импорты типов из `../shared/ui-types.js` и `../shared/island.js`. Если `uiStore.save` в типе не принимает частичный вложенный объект — оставить приведение, как выше: `save` сливает `island` на один уровень, задача 1.)

В `registerIpc({...})`:

```ts
    onUiSaved: () => {
      void updates.settingsChanged();
      // Окна об изменениях ui.json не узнают — main перечитывает файл сам (спека 2026-10-12, 5.1).
      void uiStore.load().then(syncIsland);
    },
    isIslandSender: (sender) => island.isIsland(sender),
    islandActive: () => island.current() !== null,
```

`activate` — по главному окну, а не по числу окон:

```ts
  app.on('activate', () => {
    // Остров — тоже окно: «окон нет совсем» больше не значит «главного окна нет».
    if (mainWindow === null || mainWindow.isDestroyed()) {
      focusMainWindow();
    }
  });
```

- [ ] **Шаг 5: Прогон группы 2 (задачи 5–6)** — проверить загрузку, затем по одному:

```bash
nice -n 10 pnpm --filter @parley/desktop exec vitest run src/preload src/main/test-switches.test.ts src/main/island
nice -n 10 pnpm --filter @parley/desktop typecheck
nice -n 10 pnpm --filter @parley/desktop build
```
Expected: зелёное; в `out/preload/` два файла — `index.js` и `island.js`.

- [ ] **Шаг 6: Коммиты** задачи 5 (её шаг 4) и задачи 6:
```bash
git add packages/desktop/src/main/test-switches.ts packages/desktop/src/main/test-switches.test.ts packages/desktop/src/main/index.ts packages/desktop/playwright.config.ts
git commit -m "feat(desktop): остров в main — окно по настройке, PARLEY_ISLAND=off для E2E, Dock по главному окну"
```

---

### Задача 7: Модель острова — пилюля и список «в работе»

**Файлы:**
- Create: `packages/desktop/src/renderer/lib/project-name.ts`
- Create: `packages/desktop/src/renderer/island/model.ts`
- Test: `packages/desktop/src/renderer/island/model.test.ts`

**Interfaces:**
- Consumes: `sessionAttention` (`attention/derive.ts`), `sessionRowLabel`, `workTitleText` (`lib/participant.ts`), `workKey` (`lib/tree-order.ts`), `ActivityEntry` (`store/activity.ts`), `ISLAND_EXCLUDED_PROVIDERS` (задача 4).
- Produces:
  - `projectName(projectPath: string): string` (`lib/project-name.ts`)
  - `type IslandRow = { kind: 'session'; key: string; ref: SessionRef; label: string; provider: string; state: 'working' | 'needs-you'; inTerminal: boolean } | { kind: 'room'; key: string; projectPath: string; workId: string; roomId: string; title: string; busy: number }`
  - `interface IslandGroup { key: string; title: string; project: string; rows: IslandRow[] }`
  - `interface IslandModel { working: number; waiting: number; providers: string[]; groups: IslandGroup[]; active: boolean }`
  - `islandModel(entries: readonly WorkEntry[], byRef: Readonly<Record<string, ActivityEntry>>, withCard: ReadonlySet<string>): IslandModel` — `withCard` — `refKey` сессий, у которых в очереди острова есть карточка.

- [ ] **Шаг 1: Тесты** (`model.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { refKey } from '@parley/protocol';
import { activityMap, makeActivity, makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { islandModel } from './model.js';

const PROJECT = '/Users/me/Desktop/Доки ВК';
const ref = (sessionId: string, workId = 'w-1') => ({ projectPath: PROJECT, workId, sessionId });

function work() {
  const room = { ...makeRoom('r-1', 'Refunds'), members: ['s-02', 's-03'] };
  return makeWork('w-1', {
    projectPath: PROJECT,
    title: 'Backend',
    sessions: [
      makeSession('s-01', 'lead'),
      makeSession('s-02', 'api'),
      makeSession('s-03', 'review', { provider: 'glm' }),
      makeSession('s-04', 'codex', { provider: 'codex' }),
      makeSession('s-05', 'done'),
    ],
    rooms: [room],
  });
}

describe('модель острова', () => {
  it('работает и ждёт — в пилюле; Codex, простаивающие и «finished» — нет', () => {
    const byRef = activityMap([
      makeActivity(ref('s-01'), 'working'),
      makeActivity(ref('s-02'), 'blocked'),
      makeActivity(ref('s-03'), 'working'),
      makeActivity(ref('s-04'), 'blocked'),
      makeActivity(ref('s-05'), 'unseen'),
    ]);
    const model = islandModel([work()], byRef, new Set([refKey(ref('s-02'))]));
    expect(model).toMatchObject({ working: 2, waiting: 1, providers: ['claude', 'glm'], active: true });
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]).toMatchObject({ title: 'Backend', project: 'Доки ВК' });
    const sessions = model.groups[0]?.rows.filter((row) => row.kind === 'session') ?? [];
    expect(sessions.map((row) => row.kind === 'session' && row.ref.sessionId)).toEqual(['s-01', 's-02', 's-03']);
  });

  it('комната в работе, если в работе хоть один её участник', () => {
    const byRef = activityMap([makeActivity(ref('s-03'), 'working')]);
    const rows = islandModel([work()], byRef, new Set()).groups[0]?.rows ?? [];
    expect(rows.find((row) => row.kind === 'room')).toMatchObject({ kind: 'room', roomId: 'r-1', title: 'Refunds', busy: 1 });
  });

  it('ждёт без карточки острова — «в терминале»', () => {
    const byRef = activityMap([makeActivity(ref('s-02'), 'blocked')]);
    const row = islandModel([work()], byRef, new Set()).groups[0]?.rows[0];
    expect(row).toMatchObject({ kind: 'session', state: 'needs-you', inTerminal: true });
  });

  it('никто не работает и не ждёт — остров неактивен, групп нет', () => {
    expect(islandModel([work()], {}, new Set())).toEqual({ working: 0, waiting: 0, providers: [], groups: [], active: false });
  });

  it('работы не active (done, archived) не считаются', () => {
    const done = makeWork('w-2', { projectPath: PROJECT, status: 'done', sessions: [makeSession('s-01', 'x')] });
    const byRef = activityMap([makeActivity(ref('s-01', 'w-2'), 'working')]);
    expect(islandModel([done], byRef, new Set()).active).toBe(false);
  });
});
```

- [ ] **Шаг 2: `lib/project-name.ts`:**

```ts
/** Имя проекта для подписей — последний сегмент пути (хвостовые слеши не считаются). */
export function projectName(projectPath: string): string {
  return projectPath.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) ?? projectPath;
}
```

- [ ] **Шаг 3: `island/model.ts`:**

```ts
/**
 * Что показывает остров в покое (спека 2026-10-12, раздел 4): счётчики пилюли и список «в работе» по работам.
 * Чистая функция: работы окна, активность и множество сессий, у которых в очереди острова есть карточка
 * (без неё ждущая сессия — «waiting in terminal»). «В работе»: сессия — `sessionAttention` даёт `working` или
 * `needs-you`; комната — в работе хотя бы один её участник; «finished, not seen» не считается. Codex вне острова.
 */

import type { WorkEntry } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import { ISLAND_EXCLUDED_PROVIDERS } from '../../shared/island.js';
import { sessionAttention } from '../attention/derive.js';
import { sessionRowLabel, workTitleText } from '../lib/participant.js';
import { projectName } from '../lib/project-name.js';
import { workKey } from '../lib/tree-order.js';
import type { ActivityEntry } from '../store/activity.js';

export type IslandRow =
  | { kind: 'session'; key: string; ref: SessionRef; label: string; provider: string; state: 'working' | 'needs-you'; inTerminal: boolean }
  | { kind: 'room'; key: string; projectPath: string; workId: string; roomId: string; title: string; busy: number };

export interface IslandGroup {
  key: string;
  title: string;
  project: string;
  rows: IslandRow[];
}

export interface IslandModel {
  working: number;
  waiting: number;
  providers: string[];
  groups: IslandGroup[];
  active: boolean;
}

export function islandModel(
  entries: readonly WorkEntry[],
  byRef: Readonly<Record<string, ActivityEntry>>,
  withCard: ReadonlySet<string>,
): IslandModel {
  let working = 0;
  let waiting = 0;
  const providers = new Set<string>();
  const groups: IslandGroup[] = [];
  for (const entry of entries) {
    const { work } = entry.map;
    if (work.status !== 'active') continue;
    const rows: IslandRow[] = [];
    const busy = new Set<string>();
    for (const session of entry.map.sessions) {
      if (ISLAND_EXCLUDED_PROVIDERS.has(session.provider)) continue;
      const ref = { projectPath: entry.projectPath, workId: work.id, sessionId: session.id };
      const key = refKey(ref);
      const state = sessionAttention(session, byRef[key]?.activity ?? null);
      if (state !== 'working' && state !== 'needs-you') continue;
      busy.add(session.id);
      providers.add(session.provider);
      if (state === 'working') working += 1;
      else waiting += 1;
      rows.push({
        kind: 'session',
        key,
        ref,
        label: sessionRowLabel(session.id, session.label),
        provider: session.provider,
        state,
        inTerminal: state === 'needs-you' && !withCard.has(key),
      });
    }
    const groupKey = workKey(entry.projectPath, work.id);
    for (const room of entry.map.rooms) {
      if (room.archivedAt != null) continue;
      const count = room.members.filter((id) => busy.has(id)).length;
      if (count === 0) continue;
      rows.push({ kind: 'room', key: `${groupKey}\u0000room\u0000${room.id}`, projectPath: entry.projectPath, workId: work.id, roomId: room.id, title: room.title, busy: count });
    }
    if (rows.length > 0) groups.push({ key: groupKey, title: workTitleText(work.title), project: projectName(entry.projectPath), rows });
  }
  return { working, waiting, providers: [...providers].sort(), groups, active: working + waiting > 0 };
}
```

- [ ] **Шаг 4: Коммит** (после прогона группы 3 — задача 8):
```bash
git add packages/desktop/src/renderer/lib/project-name.ts packages/desktop/src/renderer/island/model.ts packages/desktop/src/renderer/island/model.test.ts
git commit -m "feat(desktop): модель острова — пилюля и список сессий и комнат в работе, без Codex"
```

---

### Задача 8: Очередь запросов острова

**Файлы:**
- Modify: `packages/desktop/src/renderer/attention/ask-summary.ts` (+ экспорт `pendingCards`)
- Create: `packages/desktop/src/renderer/island/requests.ts`
- Test: `packages/desktop/src/renderer/island/requests.test.ts`, `packages/desktop/src/renderer/attention/ask-summary.test.ts`

**Interfaces:**
- Consumes: `askSummary` (ask-summary.ts), `sessionAttention`, `ActivityEntry`, `ISLAND_EXCLUDED_PROVIDERS`, `IslandBridge['call']`, `decodeIpcError` (`shared/ipc-error.ts`).
- Produces:
  - `pendingCards(items: readonly FeedItem[]): FeedCard[]` — все ждущие карточки по порядку ленты (`pendingAskOf` берёт последнюю из них).
  - `ASK_RETRY_MS = 500`, `ELSEWHERE_MS = 1000`
  - `interface IslandRequest { key: string; ref: SessionRef; card: FeedCard; summary: string; inWindow: boolean; since: number; deciding: boolean; note: 'elsewhere' | 'failed' | null }`
  - `useIslandRequests` (zustand): `items: IslandRequest[]`, `index: number`, `waitingSince: Record<string, number>`, `bind(call: IslandBridge['call'] | null): void`, `select(index: number): void`, `sync(entries: readonly WorkEntry[], byRef: Readonly<Record<string, ActivityEntry>>): void`, `decide(key: string, decision: FeedDecision): Promise<void>`, `clear(): void`.

- [ ] **Шаг 1: `pendingCards`** — тест в `ask-summary.test.ts`:

```ts
it('pendingCards — все ждущие карточки по порядку ленты, ответившие не в счёт', () => {
  const items = [permission('c-1', 'pending'), permission('c-2', 'allowed'), question('c-3', 'pending')];
  expect(pendingCards(items).map((card) => card.cardId)).toEqual(['c-1', 'c-3']);
});
```

(`permission`/`question` — фабрики, уже объявленные в этом тестовом файле задачей уведомлений; если имена другие — взять их.) Реализация, а `pendingAskOf` переписать через неё:

```ts
/** Все карточки, ждущие ответа, по порядку ленты. */
export function pendingCards(items: readonly FeedItem[]): FeedCard[] {
  return items.filter((item): item is FeedCard => isCard(item) && item.state === 'pending');
}
```

и в `pendingAskOf`: `const card = pendingCards(snapshot.items).at(-1);`.

- [ ] **Шаг 2: Тесты очереди** (`requests.test.ts`):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedCard } from '@parley/core';
import { refKey } from '@parley/protocol';
import { activityMap, makeActivity, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { ASK_RETRY_MS, ELSEWHERE_MS, useIslandRequests } from './requests.js';

const PROJECT = '/tmp/proj';
const ref = (sessionId: string) => ({ projectPath: PROJECT, workId: 'w-1', sessionId });
const entries = [makeWork('w-1', { projectPath: PROJECT, sessions: [makeSession('s-01', 'a'), makeSession('s-02', 'b'), makeSession('s-03', 'c', { provider: 'codex' })] })];

function permission(cardId: string, command = 'rm -rf build'): FeedCard {
  return {
    id: cardId, at: '2026-10-12T10:00:00.000Z', kind: 'permission', cardId, state: 'pending', toolUseId: null,
    toolName: 'Bash', toolInput: { command }, suggestions: [], notified: false,
  } as FeedCard;
}

/** Мост: `feed.snapshot` отдаёт карточки по сессии из таблицы, `feed.decide` — по сценарию теста. */
function bridge(cards: Record<string, FeedCard[]>, decide = vi.fn().mockResolvedValue({ applied: true, state: 'allowed' })) {
  const snapshot = vi.fn(async ({ ref: target }: { ref: { sessionId: string } }) => ({
    items: cards[target.sessionId] ?? [], revision: 1, mode: null, decisions: 'window' as const,
  }));
  const call = vi.fn((method: string, params: never) => (method === 'feed.snapshot' ? snapshot(params) : decide(params)));
  return { call, snapshot, decide };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('очередь запросов острова', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useIslandRequests.getState().clear();
  });
  afterEach(() => {
    useIslandRequests.getState().bind(null);
    vi.useRealTimers();
  });

  it('сессия начала ждать — в очередь все её ждущие карточки; Codex не спрашивается', async () => {
    const { call, snapshot } = bridge({ 's-01': [permission('c-1'), permission('c-2', 'ls')] });
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked'), makeActivity(ref('s-03'), 'blocked')]));
    await flush();
    expect(useIslandRequests.getState().items.map((item) => [item.card.cardId, item.summary])).toEqual([
      ['c-1', 'Run: rm -rf build'],
      ['c-2', 'Run: ls'],
    ]);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('карточки ещё нет — один повтор через 500 мс', async () => {
    const cards: Record<string, FeedCard[]> = {};
    const { call, snapshot } = bridge(cards);
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    expect(useIslandRequests.getState().items).toEqual([]);
    cards['s-01'] = [permission('c-1')];
    await vi.advanceTimersByTimeAsync(ASK_RETRY_MS);
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(useIslandRequests.getState().items).toHaveLength(1);
  });

  it('сессия перестала ждать — её карточки уходят', async () => {
    const { call } = bridge({ 's-01': [permission('c-1')] });
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'working')]));
    expect(useIslandRequests.getState().items).toEqual([]);
  });

  it('порядок — по времени, когда сессия начала ждать', async () => {
    const { call } = bridge({ 's-01': [permission('c-1')], 's-02': [permission('c-2')] });
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-02'), 'blocked')]));
    await vi.advanceTimersByTimeAsync(10);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-02'), 'blocked'), makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    expect(useIslandRequests.getState().items.map((item) => item.card.cardId)).toEqual(['c-2', 'c-1']);
  });

  it('applied: true — карточка уходит; решение уходит хосту с cardId', async () => {
    const { call, decide } = bridge({ 's-01': [permission('c-1')] });
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    const [item] = useIslandRequests.getState().items;
    await useIslandRequests.getState().decide(item!.key, { kind: 'permission', behavior: 'allow' });
    expect(decide).toHaveBeenCalledWith({ ref: ref('s-01'), cardId: 'c-1', decision: { kind: 'permission', behavior: 'allow' } });
    expect(useIslandRequests.getState().items).toEqual([]);
  });

  it('applied: false или not_found — «Answered elsewhere», через секунду уходит; кнопки не висят', async () => {
    const decide = vi.fn().mockResolvedValueOnce({ applied: false, state: 'elsewhere' });
    const { call } = bridge({ 's-01': [permission('c-1')] }, decide);
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    const key = useIslandRequests.getState().items[0]!.key;
    await useIslandRequests.getState().decide(key, { kind: 'permission', behavior: 'deny' });
    expect(useIslandRequests.getState().items[0]).toMatchObject({ deciding: false, note: 'elsewhere' });
    await vi.advanceTimersByTimeAsync(ELSEWHERE_MS);
    expect(useIslandRequests.getState().items).toEqual([]);
  });

  it('ошибка сети — «failed», карточка остаётся, кнопки снова доступны', async () => {
    const decide = vi.fn().mockRejectedValueOnce(new Error('socket closed'));
    const { call } = bridge({ 's-01': [permission('c-1')] }, decide);
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    const key = useIslandRequests.getState().items[0]!.key;
    await useIslandRequests.getState().decide(key, { kind: 'permission', behavior: 'allow' });
    expect(useIslandRequests.getState().items[0]).toMatchObject({ deciding: false, note: 'failed' });
  });

  it('clear — очередь и ожидания пусты (хост отключился)', async () => {
    const { call } = bridge({ 's-01': [permission('c-1')] });
    useIslandRequests.getState().bind(call as never);
    useIslandRequests.getState().sync(entries, activityMap([makeActivity(ref('s-01'), 'blocked')]));
    await flush();
    useIslandRequests.getState().clear();
    expect(useIslandRequests.getState()).toMatchObject({ items: [], index: 0, waitingSince: {} });
    expect(refKey(ref('s-01')) in useIslandRequests.getState().waitingSince).toBe(false);
  });
});
```

- [ ] **Шаг 3: Реализация** (`island/requests.ts`):

```ts
/**
 * Очередь запросов острова (спека 2026-10-12, раздел 6). Сессия Claude или GLM перешла в «ждёт» — разовый
 * `feed.snapshot` и в очередь все её ждущие карточки; карточки ещё нет (хук ложится позже активности) — один повтор
 * через `ASK_RETRY_MS` и новый снимок при каждом следующем изменении активности этой сессии, пока она ждёт.
 * Сессия перестала ждать — её карточки уходят. Порядок — по времени перехода в «ждёт», внутри сессии — по ленте.
 *
 * На ленты остров не подписывается: подписки на хосте общие на клиента-main, и отписка острова оборвала бы ленту
 * главного окна. Поэтому и решение — свой `feed.decide`, а не `useFeedStore.decide`: тот держит «решается» до дельты
 * ленты, которой у острова нет. `applied: false` и `not_found` — на карточку уже ответили в другом месте: пометка на
 * `ELSEWHERE_MS` и уход; прочая ошибка — пометка «failed», кнопки снова доступны.
 */

import { create } from 'zustand';
import type { FeedCard, FeedDecision, WorkEntry } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import { ISLAND_EXCLUDED_PROVIDERS, type IslandBridge } from '../../shared/island.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { askSummary, pendingCards } from '../attention/ask-summary.js';
import { sessionAttention } from '../attention/derive.js';
import type { ActivityEntry } from '../store/activity.js';

export const ASK_RETRY_MS = 500;
export const ELSEWHERE_MS = 1000;

export interface IslandRequest {
  /** `refKey` сессии и `cardId` через `\0`. */
  key: string;
  ref: SessionRef;
  card: FeedCard;
  summary: string;
  /** Ответить можно из Parley (Codex с одобрениями в терминале — нет). */
  inWindow: boolean;
  since: number;
  deciding: boolean;
  note: 'elsewhere' | 'failed' | null;
}

interface IslandRequestsState {
  items: IslandRequest[];
  index: number;
  waitingSince: Record<string, number>;
  bind(call: IslandBridge['call'] | null): void;
  select(index: number): void;
  sync(entries: readonly WorkEntry[], byRef: Readonly<Record<string, ActivityEntry>>): void;
  decide(key: string, decision: FeedDecision): Promise<void>;
  clear(): void;
}

let call: IslandBridge['call'] | null = null;
/** Последняя запись активности ждущей сессии: новая — повод снять снимок заново. */
const lastSeen = new Map<string, ActivityEntry | undefined>();

const clampIndex = (index: number, length: number): number => (length === 0 ? 0 : Math.min(Math.max(index, 0), length - 1));

export const useIslandRequests = create<IslandRequestsState>((set, get) => {
  const patch = (key: string, change: Partial<IslandRequest>): void =>
    set((state) => ({ items: state.items.map((item) => (item.key === key ? { ...item, ...change } : item)) }));
  const remove = (key: string): void =>
    set((state) => {
      const items = state.items.filter((item) => item.key !== key);
      return { items, index: clampIndex(state.index, items.length) };
    });

  const fetchCards = async (ref: SessionRef, retry: boolean): Promise<void> => {
    const current = call;
    if (current === null) return;
    const sessionKey = refKey(ref);
    let snapshot: Awaited<ReturnType<IslandBridge['call']>> | null = null;
    try {
      snapshot = (await current('feed.snapshot', { ref })) as never;
    } catch {
      snapshot = null;
    }
    const since = get().waitingSince[sessionKey];
    if (since === undefined) return;
    const result = snapshot as { items: never[]; decisions?: string | null } | null;
    const cards = result === null ? [] : pendingCards(result.items);
    if (cards.length === 0) {
      if (retry) setTimeout(() => void fetchCards(ref, false), ASK_RETRY_MS);
      return;
    }
    const inWindow = result?.decisions !== 'terminal';
    set((state) => {
      const known = new Map(state.items.map((item) => [item.key, item]));
      const mine = cards.map((card): IslandRequest => {
        const key = `${sessionKey}\u0000${card.cardId}`;
        return known.get(key) ?? { key, ref, card, summary: askSummary(card, ref.projectPath), inWindow, since, deciding: false, note: null };
      });
      const items = [...state.items.filter((item) => refKey(item.ref) !== sessionKey), ...mine].sort((a, b) => a.since - b.since);
      return { items, index: clampIndex(state.index, items.length) };
    });
  };

  return {
    items: [],
    index: 0,
    waitingSince: {},
    bind: (next) => {
      call = next;
    },
    select: (index) => set((state) => ({ index: clampIndex(index, state.items.length) })),
    sync: (entries, byRef) => {
      const now = Date.now();
      const before = get().waitingSince;
      const waitingSince: Record<string, number> = {};
      const toFetch: SessionRef[] = [];
      for (const entry of entries) {
        for (const session of entry.map.sessions) {
          if (ISLAND_EXCLUDED_PROVIDERS.has(session.provider)) continue;
          const ref = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
          const key = refKey(ref);
          if (sessionAttention(session, byRef[key]?.activity ?? null) !== 'needs-you') continue;
          waitingSince[key] = before[key] ?? now;
          if (before[key] === undefined || lastSeen.get(key) !== byRef[key]) toFetch.push(ref);
          lastSeen.set(key, byRef[key]);
        }
      }
      for (const key of [...lastSeen.keys()]) if (waitingSince[key] === undefined) lastSeen.delete(key);
      set((state) => {
        const items = state.items.filter((item) => waitingSince[refKey(item.ref)] !== undefined);
        return { waitingSince, items, index: clampIndex(state.index, items.length) };
      });
      for (const ref of toFetch) void fetchCards(ref, true);
    },
    decide: async (key, decision) => {
      const item = get().items.find((candidate) => candidate.key === key);
      const current = call;
      if (item === undefined || current === null || item.deciding) return;
      patch(key, { deciding: true, note: null });
      try {
        const result = (await current('feed.decide', { ref: item.ref, cardId: item.card.cardId, decision })) as { applied: boolean };
        if (result.applied) {
          remove(key);
          return;
        }
        patch(key, { deciding: false, note: 'elsewhere' });
      } catch (error: unknown) {
        if (decodeIpcError(error).code !== 'not_found') {
          patch(key, { deciding: false, note: 'failed' });
          return;
        }
        patch(key, { deciding: false, note: 'elsewhere' });
      }
      setTimeout(() => remove(key), ELSEWHERE_MS);
    },
    clear: () => {
      lastSeen.clear();
      set({ items: [], index: 0, waitingSince: {} });
    },
  };
});
```

Типы ответа `feed.snapshot`/`feed.decide`: если `IslandBridge['call']` типизирован по методу (`call<M>(method: M, params: Params<M>): Promise<Result<M>>`), убрать приведения `as never`/`as { … }` и взять `Result<'feed.snapshot'>`, `Result<'feed.decide'>` из `@parley/protocol` — tsc подскажет; поведение то же.

- [ ] **Шаг 4: Прогон группы 3 (задачи 7–8)** — проверить загрузку, затем:
```bash
nice -n 10 pnpm --filter @parley/desktop exec vitest run src/renderer/island src/renderer/attention/ask-summary.test.ts src/renderer/attention/notify.test.ts
nice -n 10 pnpm --filter @parley/desktop typecheck
```
Expected: зелёное.

- [ ] **Шаг 5: Коммиты** задачи 7 (её шаг 4) и задачи 8:
```bash
git add packages/desktop/src/renderer/attention/ask-summary.ts packages/desktop/src/renderer/attention/ask-summary.test.ts packages/desktop/src/renderer/island/requests.ts packages/desktop/src/renderer/island/requests.test.ts
git commit -m "feat(desktop): очередь запросов острова — снимок по переходу, повтор, свой feed.decide"
```

---

### Задача 9: Интерфейс острова — пилюля, список, карточка, вход `island.html`

**Файлы:**
- Create: `packages/desktop/src/renderer/chat/cards/always-rules.ts` (перенос `alwaysRules` из `PermissionCard.tsx`; `PermissionCard.tsx` импортирует его оттуда)
- Create: `packages/desktop/src/renderer/island/simple-question.ts`, `island/DragHandle.tsx`, `island/IslandView.tsx`, `island/IslandApp.tsx`, `island/bridge.ts`, `island/main.tsx`, `island/island.css`
- Create: `packages/desktop/src/renderer/island.html`
- Modify: `packages/desktop/src/renderer/island/model.ts` (+ `sessionLabels`)
- Modify: `packages/desktop/src/renderer/store/works.ts`, `store/activity.ts` (тип параметра `init` — сужение моста)
- Modify: `packages/desktop/src/shared/strings.ts` (`S.island`)
- Modify: `packages/desktop/electron.vite.config.ts` (вход renderer)
- Test: `island/simple-question.test.ts`, `island/IslandView.test.tsx`, `island/model.test.ts` (+ `sessionLabels`), `renderer/csp.test.ts` (+ `island.html`)

**Interfaces:**
- Consumes: `IslandModel`, `islandModel` (задача 7), `useIslandRequests`, `IslandRequest` (задача 8), `IslandBridge`, `IslandApi`, `IslandConfig` (задача 4).
- Produces:
  - `alwaysRules(suggestions: readonly unknown[]): string[] | null` — из нового модуля.
  - `simpleChoices(card: FeedCard): { question: string; options: string[] } | null`
  - `sessionLabels(entries: readonly WorkEntry[]): Map<string, { session: string; work: string; project: string }>` (ключ — `refKey`)
  - `IslandView` (чистый вид), `IslandApp` (проводка сторов и моста), `getIslandBridge(): IslandBridge`.

- [ ] **Шаг 1: Перенос `alwaysRules`.** Создать `chat/cards/always-rules.ts` с функцией целиком из `PermissionCard.tsx` (строки ~30–48) и комментарием над ней:

```ts
/**
 * Правила «Allow and don't ask again» из `permission_suggestions` хука: `addRules` → `Tool(content)`. `null` — правил
 * нет, кнопку не показывать. Отдельным модулем: им пользуются карточка ленты и остров, а модуль карточки тянет за
 * собой окружение ленты (`chat-env`).
 */
export function alwaysRules(suggestions: readonly unknown[]): string[] | null {
  // тело — без изменений из PermissionCard.tsx
}
```

В `PermissionCard.tsx` — `import { alwaysRules } from './always-rules.js';` и `export { alwaysRules } from './always-rules.js';` (если на `alwaysRules` из `PermissionCard` ссылаются тесты — `grep -rn "alwaysRules" src`).

- [ ] **Шаг 2: Простой вопрос — тест** (`simple-question.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import type { FeedCard } from '@parley/core';
import { simpleChoices } from './simple-question.js';

const question = (questions: unknown[]): FeedCard =>
  ({ id: 'c-1', at: '', kind: 'question', cardId: 'c-1', state: 'pending', toolUseId: null, toolName: 'AskUserQuestion', toolInput: {}, questions }) as unknown as FeedCard;
const option = (label: string) => ({ label, description: null });

describe('простой вопрос для острова', () => {
  it('один вопрос, один выбор, до четырёх вариантов — кнопки', () => {
    expect(simpleChoices(question([{ question: 'Which DB?', header: null, multiSelect: false, options: [option('Postgres'), option('SQLite')] }]))).toEqual({
      question: 'Which DB?',
      options: ['Postgres', 'SQLite'],
    });
  });

  it('мультивыбор, пять вариантов, два вопроса, не вопрос — null', () => {
    expect(simpleChoices(question([{ question: 'Q', header: null, multiSelect: true, options: [option('a')] }]))).toBeNull();
    expect(simpleChoices(question([{ question: 'Q', header: null, multiSelect: false, options: ['a', 'b', 'c', 'd', 'e'].map(option) }]))).toBeNull();
    expect(simpleChoices(question([
      { question: 'Q1', header: null, multiSelect: false, options: [option('a')] },
      { question: 'Q2', header: null, multiSelect: false, options: [option('b')] },
    ]))).toBeNull();
    expect(simpleChoices({ kind: 'plan' } as unknown as FeedCard)).toBeNull();
  });
});
```

Реализация (`simple-question.ts`):

```ts
/**
 * Вопрос агента, на который остров отвечает кнопками (спека 2026-10-12, раздел 4): один вопрос, один выбор, от одного
 * до четырёх вариантов. Остальное (несколько вопросов, мультивыбор, свой ответ) — «Open in Parley». Ответ — как у
 * карточки ленты: `answers` по тексту вопроса, значение — подпись варианта.
 */

import type { FeedCard } from '@parley/core';

const MAX_OPTIONS = 4;

export function simpleChoices(card: FeedCard): { question: string; options: string[] } | null {
  if (card.kind !== 'question' || card.questions.length !== 1) return null;
  const [only] = card.questions;
  if (only === undefined || only.multiSelect || only.options.length === 0 || only.options.length > MAX_OPTIONS) return null;
  return { question: only.question, options: only.options.map((option) => option.label) };
}
```

- [ ] **Шаг 3: `sessionLabels` — тест** (в `model.test.ts`):

```ts
it('sessionLabels — подписи сессий для шапки карточки', () => {
  const labels = sessionLabels([work()]);
  expect(labels.get(refKey(ref('s-02')))).toEqual({ session: 'S02 api', work: 'Backend', project: 'Доки ВК' });
});
```

Реализация (в `model.ts`):

```ts
/** Шапка карточки запроса: сессия, работа и проект по `refKey`. */
export function sessionLabels(entries: readonly WorkEntry[]): Map<string, { session: string; work: string; project: string }> {
  const labels = new Map<string, { session: string; work: string; project: string }>();
  for (const entry of entries) {
    const work = workTitleText(entry.map.work.title);
    const project = projectName(entry.projectPath);
    for (const session of entry.map.sessions) {
      const key = refKey({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id });
      labels.set(key, { session: sessionRowLabel(session.id, session.label), work, project });
    }
  }
  return labels;
}
```

(Ожидание `'S02 api'` — формат `sessionRowLabel`: «тег + подпись»; если формат иной — ожидание по нему.)

- [ ] **Шаг 4: Строки** — в `shared/strings.ts` новый раздел (рядом с `notifications`) и строка настроек:

```ts
  /** Остров одобрений (спека 2026-10-12). */
  island: {
    pill: (working: number, waiting: number): string =>
      [working > 0 ? `${working} working` : null, waiting > 0 ? `${waiting} waiting` : null].filter((part) => part !== null).join(' · '),
    waitingInTerminal: 'waiting in terminal',
    roomBusy: (count: number): string => `${count} in work`,
    of: (index: number, total: number): string => `${index} of ${total}`,
    previous: 'Previous request',
    next: 'Next request',
    allow: 'Allow',
    always: 'Always',
    deny: 'Deny',
    openInParley: 'Open in Parley',
    answeredElsewhere: 'Answered elsewhere',
    failed: "Couldn't send — try again",
    hide: 'Hide until the next request',
    drag: 'Drag along the top edge',
    hint: 'Drag me · × to hide · turn off in Settings',
    gotIt: 'Got it',
  },
```

и в `S.settings`: `notifyIsland: 'island with requests at the top of the screen',`.

- [ ] **Шаг 5: Тест вида** (`IslandView.test.tsx`; окружение jsdom — по `vitest.config.ts`):

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FeedCard } from '@parley/core';
import type { IslandApi } from '../../shared/island.js';
import type { IslandModel } from './model.js';
import type { IslandRequest } from './requests.js';
import { IslandView, type IslandViewProps } from './IslandView.js';

const REF = { projectPath: '/tmp/proj', workId: 'w-1', sessionId: 's-02' };
const LABELS = new Map([['k', { session: 'S02 api', work: 'Backend', project: 'proj' }]]);

function api(): IslandApi {
  return {
    config: vi.fn(), onConfig: vi.fn(), setSize: vi.fn(), setVisible: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(),
    dragEnd: vi.fn(), open: vi.fn(), beep: vi.fn(), hintShown: vi.fn(),
  };
}

function permissionItem(patch: Partial<IslandRequest> = {}, suggestions: unknown[] = []): IslandRequest {
  const card = { id: 'c-1', at: '', kind: 'permission', cardId: 'c-1', state: 'pending', toolUseId: null, toolName: 'Bash', toolInput: { command: 'rm -rf build' }, suggestions, notified: false } as unknown as FeedCard;
  return { key: 'k\u0000c-1', ref: REF, card, summary: 'Run: rm -rf build', inWindow: true, since: 1, deciding: false, note: null, ...patch };
}

const MODEL: IslandModel = {
  working: 2, waiting: 1, providers: ['claude'], active: true,
  groups: [{ key: 'g', title: 'Backend', project: 'proj', rows: [
    { kind: 'session', key: 'k', ref: REF, label: 'S02 api', provider: 'claude', state: 'needs-you', inTerminal: true },
    { kind: 'room', key: 'r', projectPath: '/tmp/proj', workId: 'w-1', roomId: 'r-1', title: 'Refunds', busy: 1 },
  ] }],
};

function view(patch: Partial<IslandViewProps> = {}) {
  const props: IslandViewProps = {
    model: MODEL, items: [], index: 0, config: { sound: true, hintShown: true, topInset: 0 }, listOpen: false,
    labels: new Map([[ 'k', LABELS.get('k')! ]]), api: api(),
    onToggleList: vi.fn(), onHide: vi.fn(), onSelect: vi.fn(), onDecide: vi.fn(), onHintDone: vi.fn(),
    ...patch,
  };
  render(<IslandView {...props} />);
  return props;
}

describe('вид острова', () => {
  it('пилюля: счётчики и «×»', () => {
    const props = view();
    expect(screen.getByTestId('island-pill').textContent).toContain('2 working · 1 waiting');
    fireEvent.click(screen.getByRole('button', { name: 'Hide until the next request' }));
    expect(props.onHide).toHaveBeenCalled();
  });

  it('список: ждущая без карточки — «waiting in terminal», клик по строке открывает её в Parley', () => {
    const props = view({ listOpen: true });
    expect(screen.getByText('waiting in terminal')).toBeTruthy();
    fireEvent.click(screen.getByText('S02 api'));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'session', ref: REF });
    fireEvent.click(screen.getByText('Refunds'));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'room', projectPath: '/tmp/proj', workId: 'w-1', roomId: 'r-1' });
  });

  it('карточка разрешения: шапка, суть, Allow и Deny; без правил — без Always', () => {
    const props = view({ items: [permissionItem()] });
    expect(screen.getByTestId('island-card').textContent).toContain('S02 api · Backend');
    expect(screen.getByTitle('Run: rm -rf build')).toBeTruthy();
    expect(screen.queryByTestId('island-always')).toBeNull();
    fireEvent.click(screen.getByTestId('island-allow'));
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-1', { kind: 'permission', behavior: 'allow' });
    fireEvent.click(screen.getByTestId('island-deny'));
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-1', { kind: 'permission', behavior: 'deny' });
  });

  it('правила есть — Always с подсказкой правил', () => {
    const props = view({ items: [permissionItem({}, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build' }] }])] });
    fireEvent.click(screen.getByTestId('island-always'));
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-1', { kind: 'permission', behavior: 'allow', always: true });
  });

  it('несколько запросов — «1 of 2» и стрелки', () => {
    const props = view({ items: [permissionItem(), permissionItem({ key: 'k\u0000c-2' })], index: 0 });
    expect(screen.getByText('1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next request' }));
    expect(props.onSelect).toHaveBeenCalledWith(1);
  });

  it('ответить из окна нельзя (Codex в терминале) или план — только Open in Parley с целью карточки', () => {
    const props = view({ items: [permissionItem({ inWindow: false })] });
    expect(screen.queryByTestId('island-allow')).toBeNull();
    fireEvent.click(screen.getByTestId('island-open'));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'session', ref: REF });
  });

  it('решается — кнопки выключены; ответили в другом месте — пометка', () => {
    view({ items: [permissionItem({ deciding: true })] });
    expect((screen.getByTestId('island-allow') as HTMLButtonElement).disabled).toBe(true);
  });

  it('пометка «Answered elsewhere»', () => {
    view({ items: [permissionItem({ note: 'elsewhere' })] });
    expect(screen.getByText('Answered elsewhere')).toBeTruthy();
  });

  it('подсказка первого показа и отступ под чёлку', () => {
    const props = view({ config: { sound: true, hintShown: false, topInset: 38 } });
    expect(screen.getByText('Drag me · × to hide · turn off in Settings')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(props.onHintDone).toHaveBeenCalled();
    expect((screen.getByTestId('island') as HTMLElement).style.paddingTop).toBe('38px');
  });
});
```

- [ ] **Шаг 6: `DragHandle.tsx`:**

```tsx
/**
 * Ручка перетаскивания острова (спайк 2026-10-12): точку курсора на экране шлёт main, тот двигает окно вдоль верхнего
 * края монитора под курсором и при отпускании прилепляет. Захват указателя держит события, когда курсор уходит за
 * пределы маленького окна.
 */

import { S } from '../../shared/strings.js';
import type { IslandApi } from '../../shared/island.js';

export function DragHandle({ api }: { api: Pick<IslandApi, 'dragStart' | 'dragMove' | 'dragEnd'> }): JSX.Element {
  return (
    <span
      data-testid="island-drag"
      title={S.island.drag}
      aria-label={S.island.drag}
      role="separator"
      className="cursor-grab select-none px-1 text-neutral-400 active:cursor-grabbing"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        api.dragStart({ screenX: event.screenX, screenY: event.screenY });
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId) === true) api.dragMove({ screenX: event.screenX, screenY: event.screenY });
      }}
      onPointerUp={(event) => api.dragEnd({ screenX: event.screenX, screenY: event.screenY })}
    >
      ⠿
    </span>
  );
}
```

- [ ] **Шаг 7: `IslandView.tsx`:**

```tsx
/**
 * Вид острова (спека 2026-10-12, раздел 4): пилюля, список «в работе» или карточка запроса. Чистый вид: всё
 * приходит пропсами, решения и переходы — колбэками. Остров всегда тёмный (чёрный, как чёлка).
 */

import type { FeedDecision } from '@parley/core';
import { S } from '../../shared/strings.js';
import type { FocusTarget } from '../../shared/bridge.js';
import type { IslandApi, IslandConfig } from '../../shared/island.js';
import { alwaysRules } from '../chat/cards/always-rules.js';
import { AgentIcon } from '../components/AgentIcon.js';
import { Button } from '../ui/button.js';
import { DragHandle } from './DragHandle.js';
import type { IslandModel, IslandRow } from './model.js';
import type { IslandRequest } from './requests.js';
import { simpleChoices } from './simple-question.js';

export interface IslandViewProps {
  model: IslandModel;
  items: readonly IslandRequest[];
  index: number;
  config: IslandConfig;
  listOpen: boolean;
  labels: ReadonlyMap<string, { session: string; work: string; project: string }>;
  api: IslandApi;
  onToggleList(open: boolean): void;
  onHide(): void;
  onSelect(index: number): void;
  onDecide(key: string, decision: FeedDecision): void;
  onHintDone(): void;
}

const sessionKeyOf = (item: IslandRequest): string => item.key.slice(0, item.key.lastIndexOf('\u0000'));

function rowTarget(row: IslandRow): FocusTarget {
  return row.kind === 'session'
    ? { kind: 'session', ref: row.ref }
    : { kind: 'room', projectPath: row.projectPath, workId: row.workId, roomId: row.roomId };
}

function HideButton({ onHide }: { onHide(): void }): JSX.Element {
  return (
    <button type="button" aria-label={S.island.hide} title={S.island.hide} onClick={onHide} className="px-1 text-neutral-400 hover:text-neutral-100">
      ×
    </button>
  );
}

function Pill(props: IslandViewProps): JSX.Element {
  const { model, api, onToggleList, onHide, listOpen } = props;
  return (
    // Список — по наведению или клику (спека, раздел 4); уход курсора с острова закрывает его (`IslandApp`).
    <div data-testid="island-pill" className="flex items-center gap-2 px-3 py-1.5 text-xs" onMouseEnter={() => onToggleList(true)}>
      <DragHandle api={api} />
      <button type="button" className="flex items-center gap-1.5" onClick={() => onToggleList(!listOpen)}>
        {model.providers.map((provider) => (
          <AgentIcon key={provider} provider={provider} size={14} />
        ))}
        <span>{S.island.pill(model.working, model.waiting)}</span>
      </button>
      <HideButton onHide={onHide} />
    </div>
  );
}

function List({ model, api }: IslandViewProps): JSX.Element {
  return (
    <div data-testid="island-list" className="flex max-h-80 w-[360px] flex-col gap-2 overflow-y-auto px-3 pb-3 text-xs">
      {model.groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-1">
          <div className="text-neutral-400">
            {group.title} <span className="text-neutral-500">· {group.project}</span>
          </div>
          {group.rows.map((row) => (
            <button key={row.key} type="button" className="flex items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/10" onClick={() => api.open(rowTarget(row))}>
              <span className={row.kind === 'session' && row.state === 'needs-you' ? 'size-2 rounded-full bg-state-blocked' : 'size-2 rounded-full bg-state-working'} />
              <span className="min-w-0 flex-1 truncate">{row.kind === 'session' ? row.label : row.title}</span>
              {row.kind === 'session' && row.inTerminal ? <span className="text-neutral-400">{S.island.waitingInTerminal}</span> : null}
              {row.kind === 'room' ? <span className="text-neutral-400">{S.island.roomBusy(row.busy)}</span> : null}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function Actions({ item, api, onDecide }: { item: IslandRequest; api: IslandApi; onDecide: IslandViewProps['onDecide'] }): JSX.Element {
  const { card } = item;
  const open = (): void => api.open(item.inWindow ? { kind: 'session', ref: item.ref, cardId: card.cardId } : { kind: 'session', ref: item.ref });
  const disabled = item.deciding;
  const openButton = (
    <Button data-testid="island-open" size="sm" variant="outline" onClick={open}>
      {S.island.openInParley}
    </Button>
  );
  if (!item.inWindow) return openButton;
  if (card.kind === 'permission') {
    const rules = alwaysRules(card.suggestions);
    return (
      <>
        <Button data-testid="island-allow" size="sm" disabled={disabled} onClick={() => onDecide(item.key, { kind: 'permission', behavior: 'allow' })}>
          {S.island.allow}
        </Button>
        {rules !== null ? (
          <Button data-testid="island-always" size="sm" variant="outline" title={rules.join(', ')} disabled={disabled} onClick={() => onDecide(item.key, { kind: 'permission', behavior: 'allow', always: true })}>
            {S.island.always}
          </Button>
        ) : null}
        <Button data-testid="island-deny" size="sm" variant="outline" disabled={disabled} onClick={() => onDecide(item.key, { kind: 'permission', behavior: 'deny' })}>
          {S.island.deny}
        </Button>
      </>
    );
  }
  const simple = simpleChoices(card);
  if (simple !== null) {
    return (
      <>
        {simple.options.map((label) => (
          <Button key={label} data-testid="island-option" size="sm" variant="outline" disabled={disabled} onClick={() => onDecide(item.key, { kind: 'question', answers: { [simple.question]: label } })}>
            {label}
          </Button>
        ))}
      </>
    );
  }
  return openButton;
}

function Card(props: IslandViewProps): JSX.Element | null {
  const { items, index, labels, api, onSelect, onDecide, onHide } = props;
  const item = items[index] ?? items[0];
  if (item === undefined) return null;
  const label = labels.get(sessionKeyOf(item));
  return (
    <div data-testid="island-card" className="flex w-[380px] flex-col gap-2 px-3 pb-3 pt-1.5 text-xs">
      <div className="flex items-center gap-2">
        <DragHandle api={api} />
        <span className="min-w-0 flex-1 truncate">
          {label === undefined ? null : `${label.session} · ${label.work}`}
          {label === undefined ? null : <span className="text-neutral-500"> · {label.project}</span>}
        </span>
        {items.length > 1 ? (
          <span className="flex items-center gap-1 text-neutral-400">
            <button type="button" aria-label={S.island.previous} onClick={() => onSelect(index - 1)} disabled={index === 0}>
              ‹
            </button>
            <span>{S.island.of(index + 1, items.length)}</span>
            <button type="button" aria-label={S.island.next} onClick={() => onSelect(index + 1)} disabled={index >= items.length - 1}>
              ›
            </button>
          </span>
        ) : null}
        <HideButton onHide={onHide} />
      </div>
      <div title={item.summary} className="truncate font-mono text-[12px]">
        {item.summary}
      </div>
      {item.note === 'elsewhere' ? <div className="text-neutral-400">{S.island.answeredElsewhere}</div> : null}
      {item.note === 'failed' ? <div className="text-[var(--status-warning-text)]">{S.island.failed}</div> : null}
      <div className="flex flex-wrap gap-2">
        <Actions item={item} api={api} onDecide={onDecide} />
      </div>
    </div>
  );
}

export function IslandView(props: IslandViewProps): JSX.Element {
  const { items, listOpen, config, onHintDone } = props;
  return (
    <div data-testid="island" className="rounded-b-[18px] bg-black text-neutral-100 shadow-lg" style={{ paddingTop: config.topInset }}>
      {!config.hintShown ? (
        <div className="flex items-center gap-2 px-3 pt-1.5 text-[11px] text-neutral-300">
          <span>{S.island.hint}</span>
          <button type="button" className="underline" onClick={onHintDone}>
            {S.island.gotIt}
          </button>
        </div>
      ) : null}
      {items.length > 0 ? <Card {...props} /> : (
        <>
          <Pill {...props} />
          {listOpen ? <List {...props} /> : null}
        </>
      )}
    </div>
  );
}
```

(Классы цвета точек — `bg-state-blocked`/`bg-state-working`: взять ровно те токены состояния, что у точек сайдбара, — `grep -rn "bg-state-" src/renderer/components/AgentStateDot.tsx`.)

- [ ] **Шаг 8: `bridge.ts`, `IslandApp.tsx`, `main.tsx`, `island.css`, `island.html`.**

`island/bridge.ts`:

```ts
import type { IslandBridge } from '../../shared/island.js';

/** Мост окна острова: preload острова кладёт его в `window.parley` (тип глобала — мост главного окна). */
export function getIslandBridge(): IslandBridge {
  return (window as unknown as { parley: IslandBridge }).parley;
}
```

`island/IslandApp.tsx`:

```tsx
/**
 * Проводка острова (спека 2026-10-12, раздел 6): статус хоста, сторы работ и активности, очередь запросов, настройки,
 * видимость и размер окна. Хост не подключён — очередь пуста (удержанные хуки хост снимает сам), сторы не
 * поднимаются. Новый запрос снимает «×» и звучит (`beep` у main, если включён Sound). Размер содержимого уходит в main:
 * окно острова прозрачное и ровно по содержимому.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { refKey } from '@parley/protocol';
import type { IslandBridge, IslandConfig } from '../../shared/island.js';
import { useActivityStore } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { IslandView } from './IslandView.js';
import { islandModel, sessionLabels } from './model.js';
import { useIslandRequests } from './requests.js';

const INITIAL_CONFIG: IslandConfig = { sound: false, hintShown: true, topInset: 0 };

export function IslandApp({ bridge }: { bridge: IslandBridge }): JSX.Element {
  const [connected, setConnected] = useState(false);
  const [config, setConfig] = useState<IslandConfig>(INITIAL_CONFIG);
  const [hidden, setHidden] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const entries = useWorksStore((state) => state.entries);
  const byRef = useActivityStore((state) => state.byRef);
  const items = useIslandRequests((state) => state.items);
  const index = useIslandRequests((state) => state.index);

  useEffect(
    () =>
      bridge.onStatus((status) => {
        const ok = status.state === 'connected';
        setConnected(ok);
        if (!ok) useIslandRequests.getState().clear();
      }),
    [bridge],
  );
  useEffect(() => {
    if (!connected) return undefined;
    useIslandRequests.getState().bind(bridge.call);
    const disposers = [useWorksStore.getState().init(bridge), useActivityStore.getState().init(bridge)];
    return () => {
      useIslandRequests.getState().bind(null);
      for (const dispose of disposers) dispose();
    };
  }, [connected, bridge]);
  useEffect(() => {
    void bridge.island.config().then(setConfig, () => undefined);
    return bridge.island.onConfig(setConfig);
  }, [bridge]);
  useEffect(() => {
    if (connected) useIslandRequests.getState().sync(entries, byRef);
  }, [connected, entries, byRef]);

  const withCard = useMemo(() => new Set(items.map((item) => refKey(item.ref))), [items]);
  const model = useMemo(() => islandModel(entries, byRef, withCard), [entries, byRef, withCard]);
  const labels = useMemo(() => sessionLabels(entries), [entries]);

  const seen = useRef(new Set<string>());
  useEffect(() => {
    let fresh = false;
    for (const item of items) {
      if (seen.current.has(item.key)) continue;
      seen.current.add(item.key);
      fresh = true;
    }
    if (!fresh) return;
    setHidden(false);
    if (config.sound) bridge.island.beep();
  }, [items, config.sound, bridge]);

  const visible = !hidden && (model.active || items.length > 0);
  useEffect(() => bridge.island.setVisible(visible), [visible, bridge]);

  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (element === null) return undefined;
    const report = (): void => bridge.island.setSize(Math.max(1, Math.ceil(element.offsetWidth)), Math.max(1, Math.ceil(element.offsetHeight)));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [bridge]);

  return (
    <div ref={rootRef} className="inline-block" onMouseLeave={() => setListOpen(false)}>
      <IslandView
        model={model}
        items={items}
        index={index}
        config={config}
        listOpen={listOpen}
        labels={labels}
        api={bridge.island}
        onToggleList={setListOpen}
        onHide={() => {
          setHidden(true);
          setListOpen(false);
        }}
        onSelect={(next) => useIslandRequests.getState().select(next)}
        onDecide={(key, decision) => void useIslandRequests.getState().decide(key, decision)}
        onHintDone={() => {
          bridge.island.hintShown();
          setConfig((current) => ({ ...current, hintShown: true }));
        }}
      />
    </div>
  );
}
```

Для этого `init` сторов принимает сужение моста — в `store/works.ts`: `init: (bridge: Pick<ParleyBridge, 'call' | 'on'>) => () => void;`, в `store/activity.ts`: `init: (bridge: Pick<ParleyBridge, 'on' | 'activitySnapshot'>) => () => void;` (сигнатура в интерфейсе стора и в реализации; вызовы `App.tsx` с полным мостом остаются как есть).

`island/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useUiStore } from '../store/ui.js';
import { getIslandBridge } from './bridge.js';
import { IslandApp } from './IslandApp.js';
import '../styles.css';
import './island.css';

// Остров всегда тёмный (спека 2026-10-12, 5.2): класс `dark` и тёмные значки провайдеров.
useUiStore.getState().setDark(true);

const container = document.getElementById('root');
if (container === null) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <IslandApp bridge={getIslandBridge()} />
  </StrictMode>,
);
```

`island/island.css`:

```css
/* Окно острова прозрачное: видно только содержимое (спека 2026-10-12, раздел 3). */
html,
body,
#root {
  margin: 0;
  overflow: hidden;
  background: transparent !important;
}

body {
  user-select: none;
  -webkit-user-select: none;
}
```

`src/renderer/island.html` — та же политика CSP, что в `index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self'; font-src 'self'; connect-src 'self'"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Parley Island</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./island/main.tsx"></script>
  </body>
</html>
```

Вход renderer в `electron.vite.config.ts`:

```ts
      build: {
        rollupOptions: {
          // Второй вход — окно острова (спека 2026-10-12, 5.2).
          input: { index: resolve(dirname, 'src/renderer/index.html'), island: resolve(dirname, 'src/renderer/island.html') },
        },
      },
```

В `renderer/csp.test.ts` — тест рядом с тестом `index.html`:

```ts
  it('island.html — та же политика, что index.html', () => {
    const policy = (file: string): string | undefined => /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(read(file))?.[1];
    expect(policy('./island.html')).toBeDefined();
    expect(directives(policy('./island.html') ?? '')).toEqual(directives(policy('./index.html') ?? ''));
  });
```

- [ ] **Шаг 9: Коммит** (после прогона группы 4 — задача 10):
```bash
git add packages/desktop/src/renderer/chat/cards packages/desktop/src/renderer/island packages/desktop/src/renderer/island.html packages/desktop/src/renderer/store/works.ts packages/desktop/src/renderer/store/activity.ts packages/desktop/src/shared/strings.ts packages/desktop/electron.vite.config.ts packages/desktop/src/renderer/csp.test.ts
git commit -m "feat(desktop): интерфейс острова — пилюля, список, карточка запроса, вход island.html"
```

---

### Задача 10: Главное окно — без двойного уведомления, переключатель «Island»

**Файлы:**
- Modify: `packages/desktop/src/renderer/attention/notify.ts` (`NotifyDeps`, `notifyNeedsYou`, `wireAttentionNotifications`, локальный `projectName` → `lib/project-name.ts`)
- Modify: `packages/desktop/src/renderer/attention/notify.test.ts`
- Modify: `packages/desktop/src/renderer/components/settings/SettingsDialog.tsx` (вкладка уведомлений, ~строки 385–410)
- Test: `packages/desktop/src/renderer/components/settings/SettingsDialog.test.tsx` (если есть; иначе — тест в ближайшем файле тестов настроек)

**Interfaces:**
- Consumes: `ISLAND_EXCLUDED_PROVIDERS` (задача 4), `bridge.app.islandActive()` (задача 4), `projectName` (задача 7).
- Produces: `NotifyDeps.islandOn(): boolean`.

- [ ] **Шаг 1: Тесты `notify`** (в `describe` для `onActivity`, по образцу соседних случаев с `pendingAsk`):

```ts
it('остров жив и карточка найдена — уведомления о запросе нет', async () => {
  const h = harness([entry()], { islandOn: () => true, asks: [ASK] });
  h.notifier.onActivity(REF, live('working'));
  h.notifier.onActivity(REF, live('blocked'));
  await settle();
  expect(h.notes).toEqual([]);
});

it('остров жив, но карточки нет (ждёт в терминале) — уведомление есть', async () => {
  const h = harness([entry()], { islandOn: () => true, asks: [null] });
  h.notifier.onActivity(REF, live('working'));
  h.notifier.onActivity(REF, live('blocked'));
  await settle();
  expect(h.notes).toHaveLength(1);
});

it('остров жив, сессия Codex — уведомление есть', async () => {
  const h = harness([entry({ provider: 'codex' })], { islandOn: () => true, asks: [ASK] });
  h.notifier.onActivity(REF, live('working'));
  h.notifier.onActivity(REF, live('blocked'));
  await settle();
  expect(h.notes).toHaveLength(1);
});
```

(`harness`, `entry`, `live`, `settle`, `ASK`, `REF` — помощники файла после задачи уведомлений; `harness` получает опцию `islandOn` с умолчанием `() => false`, `entry` — патч сессии. Если сигнатуры другие — подогнать вызовы, смысл случаев тот же.)

- [ ] **Шаг 2: Реализация в `notify.ts`.** В `NotifyDeps`:

```ts
  /**
   * Живо ли окно острова (спека 2026-10-12): пока живо, запрос с найденной карточкой показывает остров, а не
   * уведомление macOS. Codex и «ждёт без карточки» — уведомлением, как раньше.
   */
  islandOn(): boolean;
```

В `notifyNeedsYou` после поиска карточки и проверки `levels`/`current`:

```ts
    if (found !== null && deps.islandOn() && !ISLAND_EXCLUDED_PROVIDERS.has(session.provider)) return;
```

Локальную `projectName` удалить, импортировать из `../lib/project-name.js`. В `wireAttentionNotifications`: в `Omit<…>` добавить `'islandOn'`, в объект нотификатора — `islandOn: () => bridge.app.islandActive(),`. В шапку модуля — фраза про остров.

- [ ] **Шаг 3: Переключатель в настройках** — тест (по образцу соседних тестов вкладки уведомлений):

```tsx
it('переключатель Island пишет ui.island.enabled', async () => {
  const { bridge } = renderSettings({ tab: 'notifications' });
  fireEvent.click(screen.getByRole('switch', { name: 'island with requests at the top of the screen' }));
  await waitFor(() => expect(bridge.savedUi.at(-1)).toMatchObject({ island: { enabled: false } }));
});
```

(`renderSettings`/`savedUi` — как в существующих тестах `SettingsDialog`; если помощник называется иначе — по нему.) Реализация — строка после строки звука:

```tsx
            <NotificationRow
              label={S.settings.notifyIsland}
              checked={ui.island.enabled}
              onCheckedChange={(checked) => patchUi({ island: { ...ui.island, enabled: checked } })}
            />
```

- [ ] **Шаг 4: Прогон группы 4 (задачи 9–10)** — проверить загрузку, затем:
```bash
nice -n 10 pnpm --filter @parley/desktop exec vitest run src/renderer/island src/renderer/chat/cards src/renderer/attention src/renderer/components/settings src/renderer/csp.test.ts src/english-ui.test.ts src/shared
nice -n 10 pnpm --filter @parley/desktop typecheck
nice -n 10 pnpm --filter @parley/desktop build
```
Expected: зелёное; в `out/renderer/` есть `island.html`.

- [ ] **Шаг 5: Коммиты** задачи 9 (её шаг 9) и задачи 10:
```bash
git add packages/desktop/src/renderer/attention packages/desktop/src/renderer/components/settings
git commit -m "feat(desktop): запрос с карточкой — на острове, а не в уведомлении; переключатель Island"
```

---

### Задача 11: E2E острова

**Файлы:**
- Create: `packages/desktop/e2e/island.spec.ts`

**Interfaces:**
- Consumes: стаб `e2e/stub-echo-agent.mjs` (`STUB_HOOK <json>` в терминал → POST на хост, ответ в `STUB_HOOK_LOG`), помощники `e2e/tmp.ts` (`makeTempHome`, `makeTempProject`), `e2e/stop-app.ts`; класс `Hooks` — скопировать из `e2e/chat-hooks.spec.ts` (`hold`, `fire`, `lines`, `answer`) в этот файл без изменений, если он не вынесен в общий модуль.

- [ ] **Шаг 1: Спек** — по каркасу `open()` из `chat-hooks.spec.ts` (те же `env`, создание работы и сессии через `parley.call`), с отличием `PARLEY_ISLAND: ''` (остров есть):

```ts
test.describe('остров одобрений', () => {
  test('разрешение: остров с карточкой → Allow на острове → стаб получает allow', async () => {
    const { app, window, hooks } = await open({ PARLEY_ISLAND: '' });
    await hooks.fire('SessionStart', { source: 'startup', model: MODEL, permission_mode: 'default', cwd: project });
    await hooks.hold('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'touch /tmp/island-e2e' }, permission_mode: 'default', permission_suggestions: [] });

    await expect.poll(() => app.windows().some((page) => page.url().endsWith('/island.html'))).toBe(true);
    const island = app.windows().find((page) => page.url().endsWith('/island.html'))!;
    await expect(island.getByTestId('island-card')).toContainText('Run: touch /tmp/island-e2e');
    await clickUntil(island.getByTestId('island-allow'), async () => (await hooks.lines('PermissionRequest')).length >= 1);
    const allowed = await hooks.answer('PermissionRequest', 0);
    expect(allowed.response).toMatchObject({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    await expect(island.getByTestId('island-card')).toHaveCount(0);
    await stopApp(app);
  });

  test('«×» прячет до следующего запроса', async () => {
    const { app, hooks } = await open({ PARLEY_ISLAND: '' });
    await hooks.fire('SessionStart', { source: 'startup', model: MODEL, permission_mode: 'default', cwd: project });
    await hooks.hold('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'default', permission_suggestions: [] });
    const islandVisible = () =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/island.html'))?.isVisible() ?? false);
    await expect.poll(islandVisible).toBe(true);
    const island = app.windows().find((page) => page.url().endsWith('/island.html'))!;
    await island.getByRole('button', { name: 'Hide until the next request' }).click();
    await expect.poll(islandVisible).toBe(false);
    await hooks.hold('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'pwd' }, permission_mode: 'default', permission_suggestions: [] });
    await expect.poll(islandVisible).toBe(true);
    await stopApp(app);
  });

  test('остров выключен в настройках — окна нет, запрос приходит уведомлением', async () => {
    const { app, window, hooks } = await open({ PARLEY_ISLAND: '' });
    await window.evaluate(() => (globalThis as unknown as { parley: { app: { saveUi(patch: unknown): Promise<unknown> } } }).parley.app.saveUi({ island: { enabled: false } }));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await hooks.fire('SessionStart', { source: 'startup', model: MODEL, permission_mode: 'default', cwd: project });
    await hooks.hold('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'default', permission_suggestions: [] });
    await expect.poll(() => loggedNotes(app), { timeout: 10_000 }).toContainEqual(expect.objectContaining({ body: expect.stringContaining('Run: ls') }));
    await stopApp(app);
  });
});
```

(`open(extraEnv)` — копия `open()` из `chat-hooks.spec.ts` с параметром для env; `MODEL`, `project`, `clickUntil`, `loggedNotes` — из `chat-hooks.spec.ts`/`attention.spec.ts`. Если `hold` у стаба не даёт активности `blocked` (её считает файловый журнал событий), дополнительно `hooks.fire('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })` — проверить по первому прогону.)

- [ ] **Шаг 2: Прогон** — только при низкой загрузке, один процесс:
```bash
nice -n 10 pnpm --filter @parley/desktop build
nice -n 10 pnpm --filter @parley/desktop exec playwright test e2e/island.spec.ts e2e/smoke.spec.ts e2e/attention.spec.ts e2e/chat-hooks.spec.ts --workers=1
```
Expected: зелёное; `smoke` и `attention` — без острова (`PARLEY_ISLAND=off` из конфига), как раньше.

- [ ] **Шаг 3: Коммит:**
```bash
git add packages/desktop/e2e/island.spec.ts
git commit -m "test(desktop): E2E острова — Allow с острова, «×», выключение в настройках"
```

---

### Задача 12: Документы и выпуск

**Файлы:**
- Modify: `README.md` (по-английски), `CHANGELOG.md`, `TODOS.md`

- [ ] **Шаг 1: README** — раздел рядом с «Chat view»/уведомлениями:

```md
### Island

A small black island at the top of the screen (in the notch on a MacBook) shows how many agents are working and waiting.
When an agent asks for permission, asks a question with a few options, or brings a plan, the island opens a card:
Allow, Always (when the agent offers rules), Deny or the answer — one click, without switching to Parley.
Plans and complex questions open in Parley. Drag the island along the top edge; × hides it until the next request.
Codex sessions are not shown on the island yet. Turn it off in Settings → Notifications.
```

- [ ] **Шаг 2: CHANGELOG** — в раздел следующей версии (`## Unreleased` или ближайшая неизданная, по образцу файла):

```md
- Island: a black panel at the top of the screen (in the notch on a MacBook) with working/waiting agents and one-click answers to permission requests, simple questions and plans (Claude and GLM). On by default; Settings → Notifications → Island.
```

- [ ] **Шаг 3: TODOS** — пункты в раздел 22 или новый раздел «Остров»: Codex на острове; общий поток «ждущие запросы» на хосте (вариант C спеки острова) — для телефона и для уведомлений при закрытом главном окне; остров поверх полноэкранных приложений и вид под вырезом — подтвердить живой проверкой.

- [ ] **Шаг 4: Полный прогон перед PR** — при низкой загрузке, по одному:
```bash
nice -n 10 pnpm --filter @parley/desktop exec vitest run --minWorkers=1 --maxWorkers=3
nice -n 10 pnpm lint
```
Expected: зелёное (флейки из TODOS раздел 6 — сравнить с базовым прогоном).

- [ ] **Шаг 5: Коммит:**
```bash
git add README.md CHANGELOG.md TODOS.md
git commit -m "docs: остров одобрений — README, CHANGELOG, TODOS"
```

---

### Живая проверка (с человеком, после задачи 12)

Dev-окно (рецепт — память `terminal-less-hybrid-idea`): `cd packages/desktop && PARLEY_LOGIN_SHELL=skip PARLEY_HOME=~/.parley-chatview PARLEY_WORKTREE_ROOT=~/.parley-chatview/worktrees npx electron out/main/index.js`. Остров — окно, запрет macOS на уведомления dev-Electron его не касается.

1. Сессия Claude в ручном режиме (у человека `defaultMode: auto` и `Bash(echo:*)`): «Выполни в Bash: `touch /tmp/island-live`» → остров раскрывается в карточку на внешнем мониторе; Allow — Parley не всплывает, фокус остаётся в текущем приложении.
2. Перетащить остров на экран MacBook → садится в чёлку, текст ниже выреза; обратно — на внешний, слева/по центру/справа.
3. Развернуть какое-нибудь приложение на весь экран → остров виден поверх.
4. Закрыть главное окно → остров живёт; «Open in Parley» в списке — окно создаётся и открывает сессию.
5. Settings → Notifications → Island выкл. → острова нет; запрос — системным уведомлением (в dev-окне — только в журнале).

---

## Итерации живой проверки (2026-10-12/13)

Задачи 0–12 выше — первая версия острова, она закончена на c224ade. Дальше человек гонял остров в dev-окне, и каждое замечание стало коммитом поверх. Тексты задач выше **не переписаны**: где они говорят про «×», подсказку первого показа, `island:size`, `island:interactive`, ручку ⠿, «язычок» или пилюлю без Done, верно то, что сказано здесь и в разделах 4–8 и 11 спеки. Коммиты `c224ade..08aa6a2` (по порядку):

1. `2b16d9a` — цвета острова: токены темы (`text-foreground`, `text-muted-foreground`) вместо палитры `neutral-*`, перевёрнутой в тёмной теме.
2. `7bcfc77` — окно постоянного размера (прозрачный кадр 480×520), сквозное для мыши, вместо подгонки размера; ловит клики только над фигурой (`island:interactive`, позже заменён); точка прилипания уходит острову в настройках (`anchor`).
3. `a79870a` — чёрная фигура плавно меняет размер (CSS 250 мс, без анимации при reduce motion), список и карточка проявляются, текст 14 px, карточка 440, список 400.
4. `e54918b` — перетаскивание за любое место (порог 4 px, `drag.ts`), без ручки ⠿; без активности остров убирается в язычок (4 с покоя) и вытягивается кликом или потяжкой вниз; название работы жирным, комнаты подзаголовком.
5. `c89840c` — убранный вид без тени, язычок чёрный с белой каёмкой: виден на любом фоне.
6. `f043878` — наведение по настоящему курсору из main: `island:hit-rect` (область из renderer) и опрос `screen.getCursorScreenPoint()` раз в 100 мс, `island:hover` обратно; `mouseleave` в сквозном окне не приходил.
7. `69036ec` — Done: закончивший ход агент (`unseen`) остаётся строкой с временем и последним ответом (`replies.ts`, один `feed.snapshot` и один повтор через 1,5 с), пилюля «N done», «Clear», выдвижение по новому концу хода без звука, удержание 20 с.
8. `2c52f85` — показанная строка Done держится до конца показа (`held`): окно Parley отмечало сессию просмотренной через ~1 с, и строка пропадала; в пилюле ✅.
9. `eea16e6` — убранный остров с непросмотренными Done выглядывает «✅ N» вместо зелёного язычка; очистка `held` — после сжатия формы.
10. `b93dbef` — подсказки первого показа и «×» нет (удалены `hintShown`, `island:hint-shown`, тексты `hint` / `gotIt`); убрать остров — стрелка ⌃ внизу формы или смахивание вверх.
11. `4172a8a` — остров не уезжает за кадр, а сжимается в брусок 40×5 на месте (или в «✅ N»), как Dynamic Island; `IslandTab` — прозрачная зона нажатия поверх убранной формы.
12. `08aa6a2` — брусок со скруглением 3 px вместо `rounded-full`: угол переходит плавно.

**Тесты, что отстали от кода.** E2E `packages/desktop/e2e/island.spec.ts`, тест «"×" прячет остров до следующего запроса» (кнопка `Hide until the next request`), **устарел**: кнопки нет, текст `S.island.hide` удалён, и окно после уборки остаётся показанным (проверка `islandVisible` на «спрятан» не сработает — убранность видна по `data-retracted` формы `island`). Тест переписывается на стрелку ⌃ (`island-tuck`, при наведении) или смахивание вверх при следующем прогоне E2E; код и `e2e/` этими коммитами документов не менялись. Юнит-тесты острова в коммитах выше обновлены вместе с кодом.
