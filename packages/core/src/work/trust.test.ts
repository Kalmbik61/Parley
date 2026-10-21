import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grantTrust, isTrusted, listTrust, readTrust, revokeTrust, trustFilePath, trustKey } from './trust.js';
import type { TrustFile } from './trust.js';

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-trust-'));
  home = path.join(root, 'home');
  project = path.join(root, 'project');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('trust.json: согласие на папку проекта', () => {
  it('на пустом доме папка не доверенная, а список пуст', async () => {
    expect(await isTrusted(project, home)).toBe(false);
    expect(await listTrust(home)).toEqual([]);
    expect(await readTrust(home)).toEqual({ version: 1, folders: {} });
  });

  it('grantTrust записывает папку: isTrusted истинно, файл version 1 с правами 0600', async () => {
    const record = await grantTrust(project, 'window', home);
    expect(await isTrusted(project, home)).toBe(true);
    expect(record.by).toBe('window');
    expect(record.folder).toBe(await trustKey(project));
    expect(Number.isNaN(Date.parse(record.grantedAt))).toBe(false);

    const file = trustFilePath(home);
    expect(file).toBe(path.join(home, 'trust.json'));
    const parsed = JSON.parse(await readFile(file, 'utf8')) as TrustFile;
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.folders)).toEqual([record.folder]);
    expect(parsed.folders[record.folder]).toEqual({ grantedAt: record.grantedAt, by: 'window' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('символическая ссылка на папку — тот же ключ и то же согласие', async () => {
    const link = path.join(root, 'link-to-project');
    await symlink(project, link);
    expect(await trustKey(link)).toBe(await trustKey(project));

    await grantTrust(project, 'island', home);
    expect(await isTrusted(link, home)).toBe(true);

    // и наоборот: согласие, выданное по ссылке, действует на настоящий путь
    await revokeTrust(project, home);
    await grantTrust(link, 'telegram', home);
    expect(await isTrusted(project, home)).toBe(true);
    expect(Object.keys((await readTrust(home)).folders)).toEqual([await trustKey(project)]);
  });

  it('папки, которой нет на диске, ключом служит разрешённый абсолютный путь', async () => {
    const missing = path.join(root, 'nope', '..', 'missing');
    expect(await trustKey(missing)).toBe(path.resolve(missing));
    await grantTrust(missing, 'window', home);
    expect(await isTrusted(missing, home)).toBe(true);
  });

  it('revokeTrust удаляет запись и возвращает true; второй раз — false', async () => {
    await grantTrust(project, 'window', home);
    expect(await revokeTrust(project, home)).toBe(true);
    expect(await isTrusted(project, home)).toBe(false);
    expect(await revokeTrust(project, home)).toBe(false);
  });

  it('listTrust отдаёт записи с полем folder', async () => {
    const other = path.join(root, 'other');
    await mkdir(other);
    await grantTrust(project, 'window', home);
    await grantTrust(other, 'telegram', home);

    const list = await listTrust(home);
    expect(list.map((entry) => entry.folder).sort()).toEqual([await trustKey(project), await trustKey(other)].sort());
    const byFolder = new Map(list.map((entry) => [entry.folder, entry]));
    expect(byFolder.get(await trustKey(other))?.by).toBe('telegram');
    expect(byFolder.get(await trustKey(project))?.by).toBe('window');
  });

  it('повторная выдача обновляет запись, а не плодит вторую', async () => {
    await grantTrust(project, 'window', home);
    await grantTrust(project, 'island', home);
    const list = await listTrust(home);
    expect(list).toHaveLength(1);
    expect(list[0]?.by).toBe('island');
  });

  it('повреждённый JSON читается как пустой файл и не бросает', async () => {
    await writeFile(trustFilePath(home), '{ not json', 'utf8');
    expect(await readTrust(home)).toEqual({ version: 1, folders: {} });
    expect(await isTrusted(project, home)).toBe(false);
    expect(await listTrust(home)).toEqual([]);

    // и новая выдача поверх битого файла чинит его
    await grantTrust(project, 'window', home);
    expect(await isTrusted(project, home)).toBe(true);
  });

  it('JSON чужой формы тоже читается как пустой файл', async () => {
    await writeFile(trustFilePath(home), JSON.stringify({ version: 2, folders: [] }), 'utf8');
    expect(await readTrust(home)).toEqual({ version: 1, folders: {} });
  });

  it('без явного дома пишет в parleyHome() тестового процесса', async () => {
    await grantTrust(project, 'window');
    expect(await isTrusted(project)).toBe(true);
    expect(await revokeTrust(project)).toBe(true);
  });
});
