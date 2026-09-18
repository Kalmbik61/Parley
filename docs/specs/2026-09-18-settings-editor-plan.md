# План реализации: редактор настроек в TUI (`prefix ,`)

Дата: 2026-09-18. Статус: черновик, ждёт ревью пользователя, затем Workflow.
Основание: запрос пользователя после появления `autoLaunch` («нужно дать
настройки пользователю из TUI»), дизайн `2026-09-05-tui-v2-design.md` (3.4
настройки, 2.4 оверлеи, макет 4.4 справка), `packages/core/src/config.ts`.

> **Для Claude:** выполнять по задачам, каждая — красный тест → минимальный
> код → зелёный → коммит. Порядок A → B → C → D: B и C опираются на экспорт из
> A, D — на готовое поведение C.

**Цель.** Оверлей `prefix ,` со всеми шестью настройками: `Enter` переключает
булевы и открывает ввод для остальных, значение пишется в
`~/.harnas/config.json` и применяется на лету, без перезапуска харнесса.

**Архитектура.** Core получает запись файла (`saveConfig`) и разбор одного
значения из строки (`parseSetting`), а `loadConfig` начинает сообщать, какие
ключи перекрыты окружением. TUI: чистая функция `settingsView` строит строки
оверлея, `useOverlays` получает вид `settings` с ходьбой, переключением и
вводом по образцу правки цели в деталях, `useConfig` отдаёт `update(patch)`.
Всё, что читает `config.*`, уже реактивно: новое значение доезжает обычным
рендером.

**Стек.** TypeScript, Ink, vitest, `ink-testing-library`; никаких новых
зависимостей.

---

## Решения

| Вопрос | Решение |
|---|---|
| Клавиша | `prefix ,` — свободна, привычна для «настроек». Строка в справке и README |
| Что редактируется | Все шесть полей `HarnasConfig`: `prefix`, `sidebarWidth`, `mouseCapture`, `ascii`, `silenceThresholdMs`, `autoLaunch`. Нового не добавляем |
| Булевы | `Enter` переключает и сразу пишет файл; без отдельного ввода |
| Строка и числа | `Enter` открывает ввод в той же строке с курсором (как `e` в деталях), `Enter` разбирает и пишет, `Esc` отменяет ввод. Битое значение — событие в строке статуса, ввод остаётся открытым |
| Перекрытие окружением | Строка тусклая, вместо описания `задано HARNAS_X`; `Enter` на ней — событие «задано окружением HARNAS_X, файл не поможет». Файл при этом всё равно можно менять из других строк |
| Запись файла | `saveConfig(patch, file?)`: читает файл, если он есть и это объект — сохраняет чужие ключи; пишет JSON с отступом 2 и переводом строки; каталог `HARNAS_HOME` создаёт. Битый файл перезаписывается целиком — это то, чего пользователь хочет, когда правит настройку |
| Применение | Сразу: `useConfig.update` пишет файл, затем `setConfig`. Смена `ascii` зовёт `applyGlyphsConfig`, как при загрузке. Ошибка записи — событие `⚑`, состояние не меняется |
| Смена `prefix` на лету | Разрешена: `prefixByte` и `prefixName` считаются от `config.prefix`. Проверяется E2E: после смены `q → w` справка открывается по `ctrl+w ?` |
| Ширина | `PICKER_WIDTH` (56): шесть строк, шапка с путём файла, линейка |
| Чего не делаем | Нет сброса к дефолтам, нет редактирования переменных окружения, нет отдельной кнопки «сохранить» — каждое изменение атомарно |

---

## A. Core: запись файла, разбор значения, ключи из окружения

### Файлы

- Изменить: `packages/core/src/config.ts`
- Изменить: `packages/core/src/index.ts:104-105` (экспорт)
- Тест: `packages/core/src/config.test.ts`

### Что появляется

```ts
/** Имя переменной окружения для каждого ключа — один источник для загрузчика и оверлея. */
export const ENV_NAMES: Readonly<Record<keyof HarnasConfig, string>> = {
  prefix: 'HARNAS_PREFIX',
  sidebarWidth: 'HARNAS_SIDEBAR_WIDTH',
  mouseCapture: 'HARNAS_MOUSE',
  ascii: 'HARNAS_ASCII',
  silenceThresholdMs: 'HARNAS_SILENCE_MS',
  autoLaunch: 'HARNAS_AUTO_LAUNCH',
};

export interface LoadedConfig {
  config: HarnasConfig;
  warning: string | null;
  /** Ключи, чьё значение пришло из окружения: файл их не перекроет. */
  fromEnv: ReadonlyArray<keyof HarnasConfig>;
}

/** Ключи, значение которых вводится текстом; булевы переключаются без ввода. */
export type TypedSettingKey = 'prefix' | 'sidebarWidth' | 'silenceThresholdMs';

/** Разбор введённого значения теми же правилами, что и у файла. */
export function parseSetting<K extends TypedSettingKey>(
  key: K,
  text: string,
): { value: HarnasConfig[K] } | { error: string };

/** Пишет часть настроек в файл, сохраняя чужие ключи. Каталог создаёт. */
export async function saveConfig(
  patch: Partial<HarnasConfig>,
  file: string = configPath(),
): Promise<void>;
```

`fromEnv` собирается внутри `fromEnv()`-разборщика: каждый успешно принятый
ключ добавляется в список. `fromEnv` использует `ENV_NAMES` вместо строковых
литералов — так имя переменной живёт в одном месте. Тексты ошибок
`parseSetting` те же, что у `complain`: `ожидается один знак`, `ожидается целое
больше нуля`.

### Тесты (пишутся первыми, красные)

В `config.test.ts`, `describe('loadConfig')` дополняется, добавляются
`describe('parseSetting')` и `describe('saveConfig')`:

```ts
it('сообщает, какие ключи пришли из окружения', async () => {
  await write({ prefix: 'w' });
  const loaded = await loadConfig(file(), { HARNAS_MOUSE: '0', HARNAS_ASCII: 'мимо' });
  // Битая переменная ключ не перекрывает — и в список не попадает.
  expect(loaded.fromEnv).toEqual(['mouseCapture']);
});

it('без окружения список пуст', async () => {
  expect((await loadConfig(file(), {})).fromEnv).toEqual([]);
});

describe('parseSetting', () => {
  it('prefix — один знак', () => {
    expect(parseSetting('prefix', 'w')).toEqual({ value: 'w' });
    expect(parseSetting('prefix', 'ww')).toEqual({ error: 'prefix: ожидается один знак' });
  });
  it('числа — целое больше нуля', () => {
    expect(parseSetting('sidebarWidth', '30')).toEqual({ value: 30 });
    expect(parseSetting('silenceThresholdMs', '0')).toEqual({
      error: 'silenceThresholdMs: ожидается целое больше нуля',
    });
    expect(parseSetting('sidebarWidth', '2.5')).toMatchObject({ error: expect.any(String) });
  });
});

describe('saveConfig', () => {
  it('файла нет — создаёт каталог и файл с одним ключом', async () => {
    const nested = path.join(home, 'глубже', 'config.json');
    await saveConfig({ autoLaunch: false }, nested);
    expect(JSON.parse(await readFile(nested, 'utf8'))).toEqual({ autoLaunch: false });
    expect((await readFile(nested, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('сохраняет чужие ключи и перекрывает свой', async () => {
    await write({ prefix: 'w', comment: 'моё' });
    await saveConfig({ prefix: 'a' }, file());
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ prefix: 'a', comment: 'моё' });
  });

  it('битый файл перезаписывается целиком', async () => {
    await write('{ не json');
    await saveConfig({ ascii: true }, file());
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ ascii: true });
  });
});
```

Существующие `toEqual` по `loaded.config` не трогаются: `fromEnv` лежит рядом с
`config`, а не внутри.

### Шаги

1. Дописать тесты выше → `pnpm --filter @harnas/core test -- config.test.ts` →
   падают на «нет экспорта `parseSetting`/`saveConfig`» и на `fromEnv`.
2. Реализовать `ENV_NAMES`, `fromEnv` в `LoadedConfig`, `parseSetting`,
   `saveConfig` (импорт `mkdir`, `writeFile` из `node:fs/promises`).
3. Экспорт в `index.ts`: `ENV_NAMES, parseSetting, saveConfig`, тип
   `TypedSettingKey`.
4. `pnpm --filter @harnas/core test -- config.test.ts` → зелёный; `pnpm build`,
   `pnpm lint`.
5. Коммит: `feat(core): saveConfig, parseSetting and fromEnv in loadConfig for the settings overlay`.

---

## B. TUI: чистый вид оверлея настроек и строка в справке

### Файлы

- Изменить: `packages/tui/src/overlays.ts` (новая `settingsView`, строка `,` в
  `BINDINGS`)
- Тест: `packages/tui/src/overlays.test.ts`
- Изменить: `docs/specs/2026-09-05-tui-v2-mockups.md` (макет 4.4 — строка `,`;
  новый макет 4.13)

### Вид

```ts
export interface SettingsOptions {
  config: HarnasConfig;
  fromEnv: ReadonlyArray<keyof HarnasConfig>;
  /** Выбранная строка (индекс в SETTINGS). */
  at: number;
  /** Открытый ввод: текст с курсором вместо значения выбранной строки. */
  editing: string | null;
  configFile: string;
  g: Glyphs;
}

/** Порядок строк — порядок полей в файле из дизайна 3.4. */
export const SETTINGS: ReadonlyArray<{ key: keyof HarnasConfig; hint: string }> = [
  { key: 'prefix', hint: 'буква префикса, ctrl+<буква>' },
  { key: 'sidebarWidth', hint: 'ширина сайдбара, колонок' },
  { key: 'mouseCapture', hint: 'харнесс ловит мышь сам' },
  { key: 'ascii', hint: 'ASCII-глифы вместо Unicode' },
  { key: 'silenceThresholdMs', hint: 'порог молчания лога, мс' },
  { key: 'autoLaunch', hint: 'pending от агента стартует сама' },
];

export function settingsView(options: SettingsOptions): OverlayView;
```

Макет 4.13 (56 колонок, строки тела 54):

```text
┌ настройки ───────────────────────────────────────────┐
│ ~/.harnas/config.json                                │
│──────────────────────────────────────────────────────│
│ prefix              q      буква префикса, ctrl+<б…  │
│ sidebarWidth        26     ширина сайдбара, колонок  │
│ mouseCapture        да     задано HARNAS_MOUSE       │
│ ascii               нет    ASCII-глифы вместо Unicode│
│ silenceThresholdMs  30000  порог молчания лога, мс   │
│ autoLaunch          да     pending от агента старту… │
└ Enter — изменить · Esc — закрыть ────────────────────┘
```

Правила строки: ключ `padEnd(20)`, значение `padEnd(7)` (булевы — `да`/`нет`),
дальше подсказка, усечённая по `bodyWidth` с `g.ellipsis`. Выбранная —
`selected: true`. Перекрытая окружением — `dim: true`, подсказка заменена на
`задано ${ENV_NAMES[key]}`. При `editing !== null` у выбранной строки вместо
значения `${editing}${cursor(g)}` (как в деталях), подвал
` Enter — сохранить · Esc — отмена`. Заголовок `настройки`, `desired: PICKER_WIDTH`.

В `BINDINGS` перед `['?', 'эта справка']` — `[',', 'настройки']`.

### Тесты

```ts
describe('settingsView', () => {
  const base = { fromEnv: [], at: 0, editing: null, configFile: '/h/.harnas/config.json', g };

  it('шесть строк в порядке файла, выбранная подсвечена', () => {
    const view = settingsView({ ...base, config: DEFAULT_CONFIG, at: 5 });
    const rows = view.lines.slice(2);
    expect(rows.map((line) => line.text.trim().split(/\s+/)[0])).toEqual([
      'prefix', 'sidebarWidth', 'mouseCapture', 'ascii', 'silenceThresholdMs', 'autoLaunch',
    ]);
    expect(rows[5]?.selected).toBe(true);
    expect(rows[5]?.text).toContain('да');
    expect(view.lines[0]?.text).toContain('~/.harnas/config.json');
  });

  it('перекрытая окружением строка тусклая и называет переменную', () => {
    const view = settingsView({ ...base, config: DEFAULT_CONFIG, fromEnv: ['mouseCapture'] });
    const row = view.lines.find((line) => line.text.includes('mouseCapture'));
    expect(row?.dim).toBe(true);
    expect(row?.text).toContain('задано HARNAS_MOUSE');
  });

  it('ввод показывает набранное с курсором и меняет подвал', () => {
    const view = settingsView({ ...base, config: DEFAULT_CONFIG, at: 1, editing: '3' });
    expect(view.lines[3]?.text).toMatch(/sidebarWidth\s+3▌/);
    expect(view.footer).toContain('сохранить');
  });
});

it('в справке есть строка про настройки', () => {
  const all = helpView('ctrl+q', '', '/c.json', g).lines.map((l) => l.text).join('\n');
  expect(all).toContain(',        настройки');
});
```

### Шаги

1. Тесты → `pnpm --filter @harnas/tui test -- overlays.test.ts` → красные.
2. `settingsView` и строка в `BINDINGS`.
3. Зелёный, `pnpm lint`.
4. Макеты: строка `,` в 4.4, новый раздел 4.13 с макетом выше.
5. Коммит: `feat(tui): settingsView and the , binding in help`.

---

## C. TUI: оверлей в работе, запись и применение на лету

### Файлы

- Изменить: `packages/tui/src/use-config.ts` — возвращает `{ config, fromEnv, update }`
- Изменить: `packages/tui/src/use-overlays.ts` — вид `settings`
- Изменить: `packages/tui/src/use-actions.ts:27-38` — `',': 'settings'`
- Изменить: `packages/tui/src/app.tsx:66-68` и вызов `useOverlays`
- Тест: `packages/tui/src/use-config.test.tsx` (новый)
- Тест: `packages/tui/src/overlays.app.test.tsx` (E2E-сценарии ниже)

### `useConfig`

```ts
export interface ConfigState {
  config: HarnasConfig;
  fromEnv: ReadonlyArray<keyof HarnasConfig>;
  /** Пишет в файл и применяет; ошибка записи уезжает событием, состояние не меняется. */
  update: (patch: Partial<HarnasConfig>) => void;
}
```

`update`: `saveConfig(patch).then(() => { if ('ascii' in patch) applyGlyphsConfig(patch.ascii); setConfig(prev => ({...prev, ...patch})); }).catch(err => notify.current([{ text: `${withHome(configPath())} не записался`, hint: message }]))`.

В `app.tsx`: `const { config, fromEnv, update: updateConfig } = useConfig(push);`
и в `useOverlays` два новых поля `config`, `fromEnv`, `updateConfig`.

### `useOverlays`

- `OverlayKind` и `OverlayAction` получают `'settings'`; `open('settings')`
  сбрасывает `at`, `scroll`, `editing` и ставит `kind`.
- Клавиши при `kind === 'settings'`:
  - `editing !== null`: `Enter` → `parseSetting(key, editing)`; ошибка →
    `push([{ text: error }])`, ввод остаётся; успех → `updateConfig({[key]: value})`,
    `setEditing(null)`. `Backspace` режет, печатные символы добавляются,
    `Esc` закрывает ввод (общая ветка `escape` уже так делает).
  - иначе: `↓/j`, `↑/k` двигают `at` в пределах `SETTINGS.length`; `Enter`:
    ключ из `fromEnv` → `push([{ text: `${key} задано окружением ${ENV_NAMES[key]} — файл его не перекроет` }])`;
    булев → `updateConfig({ [key]: !config[key] })`; иначе →
    `setEditing(String(config[key]))`.
- `view`: `settingsView({ config, fromEnv, at, editing, configFile: configPath(), g })`.
- `desired` для `settings` — `PICKER`; `focus` — `at + 2` (шапка и линейка).
- `useInput` активен для `settings` как для остальных списков.

Ветка деталей (`kind === 'details'`) остаётся как есть: ввод в настройках —
своя ветка выше общей прокрутки, иначе `j`/`k` при вводе уезжали бы в скролл.

### Тесты

`use-config.test.tsx` (хук в пробе, `HARNAS_HOME` во временном каталоге):

```ts
it('update пишет файл и применяет значение без перезапуска', async () => {
  // Проба рендерит config.autoLaunch и по кнопке зовёт update({ autoLaunch: false }).
  // Ожидание: кадр показывает false, а в HARNAS_HOME/config.json лежит {"autoLaunch": false}.
});

it('ошибка записи — событие, значение прежнее', async () => {
  // HARNAS_HOME указывает на файл, а не каталог: mkdir падает.
  // Ожидание: push получил событие с «не записался», кадр по-прежнему true.
});
```

`overlays.app.test.tsx`, новый `describe('настройки (макет 4.13)')`, по образцу
соседних сценариев (App со stub-бинарём, `PREFIX + ','`):

1. **Открытие и переключение.** `prefix ,` → кадр содержит `настройки` и
   `autoLaunch`; `↓`×5, `Enter` → в `home/config.json` `{"autoLaunch": false}`,
   кадр показывает `нет`; ещё `Enter` → `да` и файл `true`.
2. **Ввод числа.** `↓`, `Enter`, `Backspace`×2, `4`, `0`, `Enter` → файл
   `{"sidebarWidth": 40}`; кадр без курсора; подвал снова «изменить».
3. **Битый ввод.** `Enter` на `prefix`, набрать `ww`, `Enter` → строка статуса
   `prefix: ожидается один знак`, ввод открыт (курсор виден), файла нет.
4. **Перекрытие окружением.** `process.env.HARNAS_MOUSE = '0'` до рендера →
   строка `mouseCapture` содержит `задано HARNAS_MOUSE`; `Enter` на ней →
   событие «задано окружением», файл не создан.
5. **Смена префикса на лету.** `Enter` на `prefix`, `Backspace`, `w`, `Enter`,
   `Esc`; затем `ctrl+w ?` → кадр `привязки · префикс ctrl+w`; `ctrl+q` теперь
   уходит гостю (кадр справки не открывается).
6. **Esc.** В открытом вводе `Esc` закрывает ввод, но не оверлей; второй `Esc`
   закрывает оверлей; файл не тронут.

### Шаги

1. `use-config.test.tsx` → красный (нет `update`). Реализовать `ConfigState`,
   поправить `app.tsx`. Зелёный.
2. E2E-сценарии 1–6 → красные (`,` ничего не открывает). Реализовать
   `use-actions.ts`, `use-overlays.ts`. Зелёные по одному.
3. `pnpm test`, `pnpm build`, `pnpm lint`.
4. Коммит: `feat(tui): settings overlay on prefix , writes config.json and applies live`.

---

## D. Документация

### Файлы

- `README.md`: строка `| ctrl+q , | настройки: Enter переключает или правит, пишется в config.json |`
  в таблицу привязок после `ctrl+q R`; в разделе «Настройки» первый абзац:
  «Все поля правятся и из TUI: `ctrl+q ,`. Значение, заданное переменной
  окружения, показано тусклым — файл его не перекроет».
- `docs/specs/2026-09-05-tui-v2-design.md`: в 2.4 (оверлеи) — пункт
  «настройки (`prefix ,`, макет 4.13)»; в 3.4 — абзац про редактор и
  `saveConfig`, пометка «добавлено 2026-09-18».
- `docs/specs/2026-09-05-tui-v2-mockups.md`: сделано в B.

Коммит: `docs: settings overlay in README and TUI v2 design`.

---

## Чек-лист приёмки

1. `loadConfig` отдаёт `fromEnv` только для принятых переменных.
2. `parseSetting` повторяет правила файла: один знак, целое больше нуля.
3. `saveConfig` создаёт каталог, сохраняет чужие ключи, перезаписывает битый файл.
4. `settingsView`: шесть строк в порядке файла, выбранная подсвечена, путь в шапке.
5. Перекрытая окружением строка тусклая с именем переменной.
6. Ввод показывает курсор и меняет подвал.
7. Справка содержит `,  настройки`; макет 4.4 обновлён, 4.13 добавлен.
8. `useConfig.update` пишет файл и применяет; ошибка записи — событие без смены состояния.
9. `prefix ,` открывает оверлей; `Enter` на булевом переключает и пишет файл.
10. Ввод числа сохраняется; битый ввод — событие, ввод остаётся открытым.
11. `Enter` на строке из окружения — событие, файл не тронут.
12. Смена `prefix` действует сразу: справка по новому префиксу, старый уходит гостю.
13. `Esc` закрывает ввод, второй — оверлей.
14. `ascii` из оверлея переключает глифы без перезапуска (визуально в E2E:
    рамка `+---+` вместо `┌───┐` в следующем кадре).
15. `pnpm test`, `pnpm build`, `pnpm lint` чистые; README и дизайн обновлены.

## Риски и оговорки

- **`glyphs()` без мемоизации.** Смена `ascii` видна после следующего рендера;
  `setConfig` его вызывает. Если какой-то компонент кэширует `Glyphs` в
  `useMemo` без зависимости от конфига, он останется со старым набором — при
  реализации проверить `grep -n "glyphs()" packages/tui/src` и E2E-пункт 14.
- **Прочтение файла при старте vs запись.** `update` не перечитывает файл, а
  накладывает патч на состояние; если файл параллельно правили руками, чужие
  правки увидит только следующий запуск. Приемлемо: TUI один, файл маленький.
- **Ширина 56.** Подсказки усечены с `…`; полный текст — в README. Без
  горизонтальной прокрутки.
