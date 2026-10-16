import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_LEAN_ENV, CLAUDE_LEAN_FLAGS, codexLeanFlags, readCodexMcpServerIds, readUserPluginIds } from './lean.js';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-lean-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Записывает файл вместе с папками над ним. */
async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

/**
 * Размер, время изменения и текст файлов. Время изменения сначала отодвигается в прошлое, чтобы любая перезапись
 * (даже тем же текстом) сдвинула `mtimeMs` и была видна.
 */
async function fingerprint(files: string[]): Promise<Array<{ size: number; mtimeMs: number; text: string }>> {
  return Promise.all(files.map(async (file) => {
    const { size, mtimeMs } = await stat(file);
    return { size, mtimeMs, text: await readFile(file, 'utf8') };
  }));
}

/** Состарить файлы на сутки: возвращает их же. */
async function age(files: string[]): Promise<string[]> {
  const past = new Date(Date.now() - 24 * 3600 * 1000);
  for (const file of files) await utimes(file, past, past);
  return files;
}

describe('readUserPluginIds', () => {
  it('собирает ключи enabledPlugins из настроек пользователя, проекта и локальных настроек проекта', async () => {
    const configDir = path.join(root, 'config');
    const cwd = path.join(root, 'project');
    await put(path.join(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@official': true, 'figma@official': false } }));
    await put(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'omc@marketplace': true } }));
    await put(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'local-only@dir': true, 'omc@marketplace': true } }));
    expect(await readUserPluginIds(cwd, configDir)).toEqual(['figma@official', 'local-only@dir', 'omc@marketplace', 'superpowers@official']);
  });

  it('нет ни одного файла — пустой список без ошибки', async () => {
    expect(await readUserPluginIds(path.join(root, 'project'), path.join(root, 'config'))).toEqual([]);
  });

  it('файл без enabledPlugins, с мусором вместо JSON или с чужим типом поля даёт пустой вклад, соседние файлы читаются', async () => {
    const configDir = path.join(root, 'config');
    const cwd = path.join(root, 'project');
    await put(path.join(configDir, 'settings.json'), '{ не JSON');
    await put(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
    await put(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: ['a@b'] }));
    expect(await readUserPluginIds(cwd, configDir)).toEqual([]);
    await put(path.join(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'ok@dir': true } }));
    expect(await readUserPluginIds(cwd, configDir)).toEqual(['ok@dir']);
  });

  it('ничего не пишет: все три файла настроек остаются как были (текст, размер и время изменения)', async () => {
    const configDir = path.join(root, 'config');
    const cwd = path.join(root, 'project');
    const files = [
      path.join(configDir, 'settings.json'),
      path.join(cwd, '.claude', 'settings.json'),
      path.join(cwd, '.claude', 'settings.local.json'),
    ];
    for (const [i, file] of files.entries()) await put(file, JSON.stringify({ enabledPlugins: { [`plugin-${i}@dir`]: true } }));
    await age(files);
    const before = await fingerprint(files);
    expect(await readUserPluginIds(cwd, configDir)).toHaveLength(3);
    expect(await fingerprint(files)).toEqual(before);
    // Каталогов, которых не было, чтение тоже не создаёт.
    await expect(stat(path.join(root, 'other-project'))).rejects.toMatchObject({ code: 'ENOENT' });
    await readUserPluginIds(path.join(root, 'other-project'), path.join(root, 'other-config'));
    await expect(stat(path.join(root, 'other-project'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(root, 'other-config'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('readCodexMcpServerIds', () => {
  it('имена серверов из таблиц [mcp_servers.<id>] config.toml', async () => {
    const codexHome = path.join(root, 'codex');
    await put(path.join(codexHome, 'config.toml'), [
      'model = "gpt-5"',
      '',
      '[mcp_servers.chrome-devtools]',
      'command = "npx"',
      'args = ["chrome-devtools-mcp"]',
      '',
      '[mcp_servers.nx-mcp]',
      'url = "http://localhost:1/mcp"',
      '',
      '[mcp_servers.nx-mcp.env]',
      'A = "1"',
    ].join('\n'));
    expect(await readCodexMcpServerIds(codexHome)).toEqual(['chrome-devtools', 'nx-mcp']);
  });

  it('ничего не пишет: config.toml остаётся как был (текст, размер и время изменения), каталога без файла чтение не создаёт', async () => {
    const codexHome = path.join(root, 'codex');
    const file = path.join(codexHome, 'config.toml');
    await put(file, ['[mcp_servers.chrome-devtools]', 'command = "npx"'].join('\n'));
    await age([file]);
    const before = await fingerprint([file]);
    expect(await readCodexMcpServerIds(codexHome)).toEqual(['chrome-devtools']);
    expect(await fingerprint([file])).toEqual(before);
    const absent = path.join(root, 'no-codex');
    expect(await readCodexMcpServerIds(absent)).toEqual([]);
    await expect(stat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('нет файла, битый TOML или нет mcp_servers — пустой список', async () => {
    const codexHome = path.join(root, 'codex');
    expect(await readCodexMcpServerIds(codexHome)).toEqual([]);
    await put(path.join(codexHome, 'config.toml'), '[mcp_servers\nбитый');
    expect(await readCodexMcpServerIds(codexHome)).toEqual([]);
    await put(path.join(codexHome, 'config.toml'), 'model = "gpt-5"\n');
    expect(await readCodexMcpServerIds(codexHome)).toEqual([]);
  });
});

describe('флаги и окружение lean', () => {
  it('Claude: ровно --strict-mcp-config и автопамять выключена переменной', () => {
    expect(CLAUDE_LEAN_FLAGS).toEqual(['--strict-mcp-config']);
    expect(CLAUDE_LEAN_ENV).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });

  it('Codex: пара -c на каждый сервер, кроме parley', () => {
    expect(codexLeanFlags(['chrome-devtools', 'parley', 'nx-mcp'])).toEqual([
      '-c', 'mcp_servers.chrome-devtools.enabled=false',
      '-c', 'mcp_servers.nx-mcp.enabled=false',
    ]);
    expect(codexLeanFlags([])).toEqual([]);
  });

  it('Codex: id не из простых ключей TOML пропускается, сервер остаётся включённым', () => {
    expect(codexLeanFlags(['my.server', 'a b', 'ok_1-x'])).toEqual(['-c', 'mcp_servers.ok_1-x.enabled=false']);
  });
});
