import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_UI, type UiFile } from '../shared/ui-types.js';
import { createUiStore } from './ui-store.js';

describe('createUiStore', () => {
  let home: string;
  let file: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-ui-'));
    file = path.join(home, 'desktop', 'ui.json');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('файла нет → load отдаёт DEFAULT_UI (тест 1)', async () => {
    const store = createUiStore(file);
    await expect(store.load()).resolves.toEqual(DEFAULT_UI);
  });

  it('save({ appearance: "dark" }) → load отдаёт dark при остальных значениях по умолчанию (тест 2)', async () => {
    const store = createUiStore(file);
    await store.save({ appearance: 'dark' });

    await expect(store.load()).resolves.toEqual({ ...DEFAULT_UI, appearance: 'dark' });
  });

  it('сохраняет все варианты языка интерфейса и читает прежний файл с языками речи', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const voice = { ...DEFAULT_UI.voice, language: 'de' };
    const assistant = { ...DEFAULT_UI.assistant, language: 'en' };
    await writeFile(file, JSON.stringify({ version: 1, appearance: 'dark', voice, assistant }), 'utf8');
    const store = createUiStore(file, { systemLocale: 'ru-RU' });
    expect(await store.load()).toMatchObject({ locale: 'ru', appearance: 'dark', assistant, voice });

    for (const locale of ['ru', 'en'] as const) {
      await store.save({ locale });
      expect(await createUiStore(file).load()).toMatchObject({ locale, appearance: 'dark', assistant, voice });
    }
  });

  it('defaults a fresh profile to English even on a Russian system without creating a file', async () => {
    expect((await createUiStore(file, { systemLocale: 'ru-RU' }).load()).locale).toBe('en');
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    [undefined, 'ru-RU', 'ru'],
    [undefined, 'de-DE', 'en'],
    ['system', 'ru-RU', 'ru'],
    ['system', 'de-DE', 'en'],
  ])('migrates legacy %s once using %s, preserving the original preferences', async (locale, system, expected) => {
    await mkdir(path.dirname(file), { recursive: true });
    const original = {
      version: 1, locale, appearance: 'dark',
      voice: { language: 'de', futureOption: true },
      assistant: { language: 'ru' },
      leftSidebar: { width: 1 }, futurePreference: { enabled: true },
    };
    await writeFile(file, JSON.stringify(original), 'utf8');
    expect((await createUiStore(file, { systemLocale: system }).load()).locale).toBe(expected);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...original, locale: expected });
    const migrated = await readFile(file, 'utf8');
    expect((await createUiStore(file, { systemLocale: expected === 'ru' ? 'en-US' : 'ru-RU' }).load()).locale).toBe(expected);
    expect(await readFile(file, 'utf8')).toBe(migrated);
  });

  it.each(['en', 'ru'])('leaves an explicit %s choice and the original file untouched', async (locale) => {
    await mkdir(path.dirname(file), { recursive: true });
    const original = JSON.stringify({ version: 1, locale, futurePreference: true });
    await writeFile(file, original, 'utf8');
    expect((await createUiStore(file, { systemLocale: locale === 'ru' ? 'en-US' : 'ru-RU' }).load()).locale).toBe(locale);
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('serializes migration with saves and rechecks the current explicit choice', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"version":1,"locale":"system","appearance":"dark"}', 'utf8');
    let releaseRename: (() => void) | undefined;
    const store = createUiStore(file, {
      systemLocale: 'ru-RU',
      rename: (...args) => new Promise<void>((resolve, reject) => {
        releaseRename = () => { void rename(...args).then(resolve, reject); };
      }),
    });
    const migration = store.load();
    await vi.waitFor(() => expect(releaseRename).toBeTypeOf('function'));
    // Until the atomic rename, read-only readers still see the complete legacy file.
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, locale: 'system', appearance: 'dark' });
    const save = store.save({ appearance: 'light' });
    const releaseMigration = releaseRename!;
    releaseRename = undefined;
    releaseMigration();
    await migration;
    await vi.waitFor(() => expect(releaseRename).toBeTypeOf('function'));
    releaseRename!();
    await save;
    expect(await store.load()).toMatchObject({ locale: 'ru', appearance: 'light' });

    const reopened = createUiStore(file, { systemLocale: 'ru-RU' });
    await Promise.all([reopened.save({ locale: 'en' }), reopened.load()]);
    expect((await reopened.load()).locale).toBe('en');
  });

  it('opens a read-only legacy profile and persists its resolved language when a write succeeds', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const original = '{"locale":"system","appearance":"dark"}';
    await writeFile(file, original, 'utf8');
    const renameOnceWritable = vi.fn(rename).mockRejectedValueOnce(new Error('read-only'));
    const store = createUiStore(file, { systemLocale: 'ru-RU', rename: renameOnceWritable });
    await expect(store.load()).resolves.toMatchObject({ locale: 'ru', appearance: 'dark' });
    expect(await readFile(file, 'utf8')).toBe(original);
    await store.save({ appearance: 'light' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ locale: 'ru', appearance: 'light' });
  });

  it('битый JSON → DEFAULT_UI, следующий save пишет валидный файл (тест 2)', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ этот json нарочно битый', 'utf8');
    const store = createUiStore(file);

    await expect(store.load()).resolves.toEqual(DEFAULT_UI);

    await store.save({ appearance: 'light' });

    const raw = await readFile(file, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    await expect(store.load()).resolves.toEqual({ ...DEFAULT_UI, appearance: 'light' });
  });

  it('save сливает вложенный объект целиком, а не по полям (план, «ui.json»)', async () => {
    const store = createUiStore(file);
    await store.save({
      notifications: { needsYou: false, finished: false, mail: false, sound: false, finishedSound: true },
    });

    await expect(store.load()).resolves.toEqual({
      ...DEFAULT_UI,
      notifications: { needsYou: false, finished: false, mail: false, sound: false, finishedSound: true },
    });
  });

  // Спека застрявших 7.5: «Sound when an agent finishes» (`finishedSound`) по умолчанию выключен, переноса не нужно —
  // кто выключил `sound`, у того выключены оба, а `ui.json` без нового поля читается как `finishedSound: false`.
  it('ui.json без finishedSound → false; явный sound: false сохраняется (спека застрявших 7.5)', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const old = { needsYou: true, finished: true, mail: true };
    await writeFile(file, JSON.stringify({ version: 1, notifications: { ...old, sound: false } }), 'utf8');
    const store = createUiStore(file);
    expect((await store.load()).notifications).toEqual({ ...old, sound: false, finishedSound: false });

    await writeFile(file, JSON.stringify({ version: 1, notifications: { ...old, sound: true } }), 'utf8');
    expect((await createUiStore(file).load()).notifications).toEqual({ ...old, sound: true, finishedSound: false });
  });

  it('частичный патч finishedSound не трогает остальные уведомления', async () => {
    const store = createUiStore(file);
    await store.save({ notifications: { needsYou: false, finished: true, mail: false, sound: true, finishedSound: false } });
    await store.save({ notifications: { finishedSound: true } } as Partial<Omit<UiFile, 'version'>>);
    expect((await store.load()).notifications).toEqual({
      needsYou: false,
      finished: true,
      mail: false,
      sound: true,
      finishedSound: true,
    });
  });

  it('voice сохраняется и читается обратно; патч других полей его не трогает', async () => {
    const store = createUiStore(file);
    await store.save({ voice: { enabled: true, model: 'base', language: 'ru' } });
    await store.save({ appearance: 'dark' });
    expect((await store.load()).voice).toEqual({ enabled: true, model: 'base', language: 'ru' });
  });

  it('browser сохраняется и читается обратно; патч других полей его не трогает (спека 2026-10-07, 4.3)', async () => {
    const store = createUiStore(file);
    await store.save({ browser: { ...DEFAULT_UI.browser, devtoolsHeight: 260 } });
    await store.save({ appearance: 'dark' });
    expect((await store.load()).browser).toEqual({ devtoolsHeight: 260, agentsAllowed: true });
  });

  it('browser.agentsAllowed сохраняется и читается обратно; патч других полей его не трогает (этап B2)', async () => {
    const store = createUiStore(file);
    await store.save({ browser: { ...DEFAULT_UI.browser, agentsAllowed: false } });
    await store.save({ appearance: 'dark' });
    expect((await store.load()).browser).toEqual({ devtoolsHeight: null, agentsAllowed: false });
  });

  it('пустой патч browser не стирает сохранённую высоту панели: browser сливается по одному уровню (NESTED_KEYS)', async () => {
    const store = createUiStore(file);
    await store.save({ browser: { ...DEFAULT_UI.browser, devtoolsHeight: 260 } });
    await store.save({ browser: {} as typeof DEFAULT_UI.browser });
    expect((await store.load()).browser).toEqual({ devtoolsHeight: 260, agentsAllowed: true });
  });

  it('save сливает island на один уровень: место не стирает enabled', async () => {
    const store = createUiStore(file);
    await store.save({ island: { enabled: false, displayId: null, anchor: 'center' } });
    const saved = await store.save({ island: { displayId: 7, anchor: 'right' } } as Partial<Omit<UiFile, 'version'>>);
    expect(saved.island).toEqual({ ...DEFAULT_UI.island, enabled: false, displayId: 7, anchor: 'right' });
  });

  // Тест 12 раунда исправлений: частичный вложенный патч не должен откатывать
  // нетронутые подполя к DEFAULT_UI — раньше `{ sound: false }` поверх
  // «всё true, mail: false» возвращал needsYou/finished/mail к дефолтному true.
  it('частичный вложенный патч оставляет нетронутые подполя как было (тест 12)', async () => {
    const store = createUiStore(file);
    await store.save({
      notifications: { needsYou: true, finished: true, mail: false, sound: true, finishedSound: false },
    });

    await store.save({ notifications: { sound: false } });

    await expect(store.load()).resolves.toEqual({
      ...DEFAULT_UI,
      notifications: { needsYou: true, finished: true, mail: false, sound: false, finishedSound: false },
    });
  });

  it('частичный патч rightSidebar не теряет open/width, тронутые только tab (тест 12)', async () => {
    const store = createUiStore(file);
    await store.save({ rightSidebar: { open: false, width: 400, tab: 'changes' } });

    await store.save({ rightSidebar: { tab: 'files' } });

    await expect(store.load()).resolves.toEqual({
      ...DEFAULT_UI,
      rightSidebar: { open: false, width: 400, tab: 'files' },
    });
  });

  // Тест 8 раунда исправлений: до `atomic-file.ts` два save() без await между
  // ними падали ENOENT на общем `.tmp` (находка C3); после — очередь на файл
  // гарантирует, что оба патча читают друг друга по очереди, а не вслепую.
  it('два параллельных save разных ключей без await не теряют ни один (тест 8)', async () => {
    const store = createUiStore(file);
    const first = store.save({ appearance: 'dark' });
    const second = store.save({ pinnedWorks: ['k'] });

    await expect(Promise.all([first, second])).resolves.toBeDefined();

    await expect(store.load()).resolves.toEqual({
      ...DEFAULT_UI,
      appearance: 'dark',
      pinnedWorks: ['k'],
    });
  });

  // Тест 13 раунда исправлений: `ui.json`, указывающий на каталог, раньше
  // пробрасывал EISDIR наружу (находка I2) — старт окна падал бы до создания
  // BrowserWindow, потому что `main/index.ts` зовёт `load()` без try/catch.
  it('ui.json как каталог → load отдаёт DEFAULT_UI и не бросает (тест 13)', async () => {
    await mkdir(file, { recursive: true });
    const store = createUiStore(file);

    await expect(store.load()).resolves.toEqual(DEFAULT_UI);
  });

  // Проверка новой версии (V6 плана релиза 0.1.0): main читает переключатель из ui.json перед каждой проверкой, а окно
  // пишет в него закрытую версию — оба ключа верхнего уровня, слияние по ним обычное.
  it('проверка новой версии: файла нет — включена; выключили — читается выключенной; прочее не тронуто', async () => {
    const store = createUiStore(file);
    expect((await store.load()).checkForUpdates).toBe(true);

    await store.save({ appearance: 'dark' });
    await store.save({ checkForUpdates: false });

    await expect(store.load()).resolves.toEqual({ ...DEFAULT_UI, appearance: 'dark', checkForUpdates: false });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ checkForUpdates: false });
  });

  it('закрытая версия переживает перезапуск: новый стор на том же файле её читает, смена переключателя её не стирает', async () => {
    await createUiStore(file).save({ dismissedUpdate: '0.2.0' });

    const reopened = createUiStore(file);
    expect((await reopened.load()).dismissedUpdate).toBe('0.2.0');

    await reopened.save({ checkForUpdates: false });
    await expect(reopened.load()).resolves.toMatchObject({ dismissedUpdate: '0.2.0', checkForUpdates: false });
    // Более новая версия просто заменяет закрытую.
    await reopened.save({ dismissedUpdate: '0.3.0' });
    expect((await reopened.load()).dismissedUpdate).toBe('0.3.0');
  });

  it('ключи проверки чужого типа из патча отсекаются нормализацией: на диске валидный файл', async () => {
    const store = createUiStore(file);
    await store.save({ checkForUpdates: 'no', dismissedUpdate: 7 } as unknown as Parameters<typeof store.save>[0]);

    await expect(store.load()).resolves.toEqual(DEFAULT_UI);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ checkForUpdates: true, dismissedUpdate: null });
  });

  it('запись атомарна: во время записи ui.json всегда читается как валидный JSON (тест 3, как тест 5 куска 2.2 прошлого плана)', async () => {
    const store = createUiStore(file);
    await store.save({ appearance: 'dark' });

    // `vi.spyOn` не подменяет именованный экспорт `node:fs/promises`
    // («Cannot redefine property») — стор поэтому берёт `rename` как
    // подставляемую зависимость, как и `layout-store.ts`.
    let releaseRename: (() => void) | null = null;
    const delayedStore = createUiStore(file, {
      rename: (...args) =>
        new Promise<void>((resolve) => {
          releaseRename = () => {
            void rename(...args).then(resolve);
          };
        }),
    });

    const savePromise = delayedStore.save({ appearance: 'light' });
    await vi.waitFor(() => {
      if (releaseRename === null) throw new Error('rename ещё не позвали');
    });

    // Пока `rename` не отпущен — на диске всё ещё старое, но обязательно
    // валидное содержимое: запись идёт только в `.tmp`.
    const duringWrite = JSON.parse(await readFile(file, 'utf8')) as { appearance: string };
    expect(duringWrite.appearance).toBe('dark');

    releaseRename?.();
    await savePromise;

    const after = JSON.parse(await readFile(file, 'utf8')) as { appearance: string };
    expect(after.appearance).toBe('light');
  });
});
