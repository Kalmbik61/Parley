import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  QWEN_HOOK_COMMAND,
  QWEN_HOOK_EVENTS,
  QwenSettingsError,
  qwenSettings,
  qwenSystemSettingsPath,
  readQwenBase,
  writeQwenSettings,
} from './qwen-settings-file.js';
import { BROWSER_PERMISSIONS, CLOSE_SESSION_PERMISSION } from './settings-file.js';
import { createWork, workPaths } from './store.js';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-qwen-settings-'));
});
afterEach(async () => {
  await chmod(path.join(dir, 'locked.json'), 0o600).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const mcp = { workDir: '/w/.parley/works/w-0001', sessionId: 's-7' };
const build = (base: Record<string, unknown> | null, extra: { hookUrl?: string; allowBrowser?: boolean } = {}) =>
  qwenSettings(base, { mcp, ...extra });

describe('qwenSystemSettingsPath', () => {
  it('takes an inherited QWEN_CODE_SYSTEM_SETTINGS_PATH first', () => {
    expect(qwenSystemSettingsPath({ QWEN_CODE_SYSTEM_SETTINGS_PATH: '/admin/qwen.json' }, 'darwin')).toBe('/admin/qwen.json');
  });

  it('falls back to the platform default', () => {
    expect(qwenSystemSettingsPath({}, 'darwin')).toBe('/Library/Application Support/QwenCode/settings.json');
    expect(qwenSystemSettingsPath({}, 'linux')).toBe('/etc/qwen-code/settings.json');
    expect(qwenSystemSettingsPath({ QWEN_CODE_SYSTEM_SETTINGS_PATH: '' }, 'linux')).toBe('/etc/qwen-code/settings.json');
    expect(qwenSystemSettingsPath({}, 'win32')).toBe('C:\\ProgramData\\qwen-code\\settings.json');
  });
});

describe('readQwenBase', () => {
  it('absent file: no base', async () => {
    expect(await readQwenBase(path.join(dir, 'none.json'))).toBeNull();
  });

  it('reads a JSON object', async () => {
    const file = path.join(dir, 'base.json');
    await writeFile(file, '{"general":{"vimMode":true}}');
    expect(await readQwenBase(file)).toEqual({ general: { vimMode: true } });
  });

  it.each([
    ['invalid JSON', '{"general":', 'is not valid JSON'],
    ['a JSON array', '[]', 'is not a JSON object'],
  ])('%s: refused with the file named', async (_name, text, reason) => {
    const file = path.join(dir, 'base.json');
    await writeFile(file, text);
    await expect(readQwenBase(file)).rejects.toThrow(new QwenSettingsError(`Qwen system settings file ${file} ${reason}; Parley cannot start Qwen Code without dropping it.`));
  });

  it.skipIf(process.getuid?.() === 0)('unreadable (EACCES): refused', async () => {
    const file = path.join(dir, 'locked.json');
    await writeFile(file, '{}');
    await chmod(file, 0o000);
    await expect(readQwenBase(file)).rejects.toThrow(`${file} is unreadable (EACCES)`);
  });

  it('symlink: refused even when the target is valid', async () => {
    const target = path.join(dir, 'target.json');
    await writeFile(target, '{}');
    const file = path.join(dir, 'base.json');
    await symlink(target, file);
    await expect(readQwenBase(file)).rejects.toThrow(`${file} is a symbolic link`);
  });

  it('hard link: refused', async () => {
    const file = path.join(dir, 'base.json');
    await writeFile(file, '{}');
    await link(file, path.join(dir, 'other.json'));
    await expect(readQwenBase(file)).rejects.toThrow(`${file} is a hard link`);
  });

  it('not a regular file: refused', async () => {
    const file = path.join(dir, 'base.json');
    await mkdir(file);
    await expect(readQwenBase(file)).rejects.toThrow(`${file} is not a regular file`);
  });
});

describe('qwenSettings', () => {
  it('no base: the parley server, hooks for every event and every default', () => {
    const { settings, kept } = build(null);
    expect(kept).toEqual([]);
    const server = (settings['mcpServers'] as Record<string, Record<string, unknown>>)['parley']!;
    expect(server).not.toHaveProperty('type');
    expect(server['command']).toBe(process.execPath);
    expect(server['env']).toMatchObject({ PARLEY_WORK_DIR: mcp.workDir, PARLEY_SESSION_ID: 's-7', HARNAS_SESSION_ID: 's-7' });
    expect(server).not.toHaveProperty('trust');
    const hooks = settings['hooks'] as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    expect(Object.keys(hooks).sort()).toEqual([...QWEN_HOOK_EVENTS].sort());
    for (const event of QWEN_HOOK_EVENTS) {
      expect(hooks[event]).toEqual([{ hooks: [{ type: 'command', command: QWEN_HOOK_COMMAND, ...(event === 'SessionEnd' ? { timeout: 5 } : {}) }] }]);
    }
    expect(settings['general']).toEqual({ enableAutoUpdate: false });
    expect(settings['tools']).toEqual({ toolSearch: { enabled: false } });
    expect(settings['memory']).toEqual({ enableManagedAutoMemory: false, enableManagedAutoDream: false });
    expect(settings['ui']).toEqual({ enableFollowupSuggestions: false });
    expect(settings).not.toHaveProperty('permissions');
  });

  it('the journal command appends one newline-terminated line', () => {
    expect(QWEN_HOOK_COMMAND).toBe(`printf '%s\\n' "$(cat)" >> "\${PARLEY_WORK_DIR:-$HARNAS_WORK_DIR}/events/\${PARLEY_SESSION_ID:-$HARNAS_SESSION_ID}.jsonl" || true`);
  });

  it('hookUrl: the HTTP feed hook follows the command in each group', () => {
    const hooks = build(null, { hookUrl: 'http://127.0.0.1:4100/hooks' }).settings['hooks'] as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    for (const event of QWEN_HOOK_EVENTS) {
      const [command, http] = hooks[event]![0]!.hooks;
      expect(command!['type']).toBe('command');
      expect(http).toMatchObject({
        type: 'http',
        url: 'http://127.0.0.1:4100/hooks',
        headers: { Authorization: 'Bearer $PARLEY_HOOK_TOKEN', 'X-Parley-Session': '$PARLEY_SESSION_ID' },
        allowedEnvVars: ['PARLEY_HOOK_TOKEN', 'PARLEY_SESSION_ID'],
      });
    }
    expect(hooks['PreToolUse']![0]!.hooks[1]!['timeout']).toBe(3600);
  });

  it('D7: an agent channel pre-allows the browser tools and close_session, the same list as Claude', () => {
    const { settings } = build({ permissions: { allow: ['run_shell_command(git status)'], deny: ['mcp__parley__browser_evaluate'] } }, { allowBrowser: true });
    expect(settings['permissions']).toEqual({
      allow: ['run_shell_command(git status)', ...BROWSER_PERMISSIONS, CLOSE_SESSION_PERMISSION],
      deny: ['mcp__parley__browser_evaluate'],
    });
  });

  it.each([
    ['mcpServers.parley', { mcpServers: { parley: { command: 'x' } } }, 'is already defined'],
    ['mcp.allowed', { mcp: { allowed: ['github'] } }, 'does not include parley'],
    ['mcp.excluded', { mcp: { excluded: ['parley'] } }, 'includes parley'],
    ['disableAllHooks', { disableAllHooks: true }, 'turns hooks off'],
    ['hooks.Stop', { hooks: { Stop: { type: 'command' } } }, 'is not a list'],
  ])('administrator conflict on %s: refused with the key named', (key, base, reason) => {
    expect(() => build(base)).toThrow(new QwenSettingsError(`Qwen system settings key ${key} ${reason}; Parley cannot connect its MCP server or hooks.`));
  });

  it('security.allowedHttpHookUrls that leaves out the host hook URL refuses the launch; a match or an empty list passes', () => {
    const hookUrl = 'http://127.0.0.1:4100/hooks';
    const allowed = (list: unknown) => ({ security: { allowedHttpHookUrls: list } });
    expect(() => build(allowed(['https://hooks.example.com/*']), { hookUrl })).toThrow(new QwenSettingsError(
      `Qwen system settings key security.allowedHttpHookUrls does not allow the Parley hook URL ${hookUrl}; Parley cannot connect its MCP server or hooks.`,
    ));
    expect(() => build(allowed('http://*'), { hookUrl })).toThrow('security.allowedHttpHookUrls is not a list');
    for (const list of [[], ['http://127.0.0.1:*'], ['HTTP://127.0.0.1:4100/HOOKS'], ['http://127\\.0\\.0\\.1:\\d+/hooks'], ['https://x/*', 'http://127.0.0.1:4100/*']]) {
      expect(build(allowed(list), { hookUrl }).settings['security']).toEqual({ allowedHttpHookUrls: list });
    }
    // Without the HTTP route nothing is sent to it, so the list does not matter.
    expect(() => build(allowed(['https://hooks.example.com/*']))).not.toThrow();
  });

  it('mcp.allowed that lists parley is accepted and kept', () => {
    expect(build({ mcp: { allowed: ['github', 'parley'] } }).settings['mcp']).toEqual({ allowed: ['github', 'parley'] });
  });

  it('administrator values of defaults are kept and recorded', () => {
    const { settings, kept } = build({
      general: { enableAutoUpdate: true },
      tools: { toolSearch: { enabled: true } },
      memory: { enableManagedAutoMemory: false },
      ui: { enableFollowupSuggestions: true, theme: 'x' },
    });
    expect(kept).toEqual(['general.enableAutoUpdate', 'tools.toolSearch.enabled', 'memory.enableManagedAutoMemory', 'ui.enableFollowupSuggestions']);
    expect(settings['ui']).toEqual({ enableFollowupSuggestions: true, theme: 'x' });
    expect(settings['general']).toEqual({ enableAutoUpdate: true });
    expect(settings['tools']).toEqual({ toolSearch: { enabled: true } });
    expect(settings['memory']).toEqual({ enableManagedAutoMemory: false, enableManagedAutoDream: false });
  });

  it('a non-object parent of a default is the administrator\'s: kept, not replaced', () => {
    const { settings, kept } = build({ tools: { toolSearch: 'off' } });
    expect(kept).toEqual(['tools.toolSearch.enabled']);
    expect(settings['tools']).toEqual({ toolSearch: 'off' });
  });

  it('unrelated nested keys, other servers and existing hook groups are preserved', () => {
    const base = {
      $version: 4,
      general: { vimMode: true, checkpointing: { enabled: true } },
      tools: { sandbox: 'docker', toolSearch: { threshold: 10 } },
      mcp: { serverCommand: 'x' },
      mcpServers: { github: { command: 'gh-mcp', env: { A: '1' } } },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'audit' }] }], PreCompact: [{ hooks: [{ type: 'command', command: 'keep' }] }] },
      security: { allowedHttpHookUrls: ['http://127.0.0.1:*'] },
    };
    const snapshot = structuredClone(base);
    const { settings } = build(base);
    expect(base).toEqual(snapshot);
    expect(settings).toMatchObject({
      $version: 4,
      general: { vimMode: true, checkpointing: { enabled: true }, enableAutoUpdate: false },
      tools: { sandbox: 'docker', toolSearch: { threshold: 10, enabled: false } },
      mcp: { serverCommand: 'x' },
      security: { allowedHttpHookUrls: ['http://127.0.0.1:*'] },
    });
    expect(Object.keys(settings['mcpServers'] as object)).toEqual(['github', 'parley']);
    expect((settings['mcpServers'] as Record<string, unknown>)['github']).toEqual({ command: 'gh-mcp', env: { A: '1' } });
    const hooks = settings['hooks'] as Record<string, unknown[]>;
    expect(hooks['Stop']).toEqual([{ hooks: [{ type: 'command', command: 'audit' }] }, { hooks: [{ type: 'command', command: QWEN_HOOK_COMMAND }] }]);
    expect(hooks['PreCompact']).toEqual([{ hooks: [{ type: 'command', command: 'keep' }] }]);
  });
});

describe('writeQwenSettings', () => {
  it('writes the session file with mode 0600 from the base the env names', async () => {
    const project = path.join(dir, 'project');
    await mkdir(project);
    const work = await createWork(project, { title: 't', goal: '' });
    const base = path.join(dir, 'admin.json');
    await writeFile(base, JSON.stringify({ tools: { toolSearch: { enabled: true } }, ui: { theme: 'x' } }));
    const { file, kept } = await writeQwenSettings(project, work.work.id, 's-3', {
      mcp: { workDir: workPaths(project, work.work.id).dir, sessionId: 's-3' },
      env: { QWEN_CODE_SYSTEM_SETTINGS_PATH: base },
    });
    expect(file).toBe(path.join(workPaths(project, work.work.id).dir, 'settings', 's-3-qwen.json'));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(kept).toEqual(['tools.toolSearch.enabled']);
    const written = JSON.parse(await readFile(file, 'utf8'));
    expect(written.ui).toEqual({ theme: 'x', enableFollowupSuggestions: false });
    expect(written.mcpServers.parley.env.PARLEY_SESSION_ID).toBe('s-3');
    expect((await stat(workPaths(project, work.work.id).events)).isDirectory()).toBe(true);
  });

  it('a refused base writes nothing', async () => {
    const project = path.join(dir, 'project');
    await mkdir(project);
    const work = await createWork(project, { title: 't', goal: '' });
    const base = path.join(dir, 'admin.json');
    await writeFile(base, '{"disableAllHooks": true}');
    await expect(writeQwenSettings(project, work.work.id, 's-3', {
      mcp: { workDir: workPaths(project, work.work.id).dir, sessionId: 's-3' },
      env: { QWEN_CODE_SYSTEM_SETTINGS_PATH: base },
    })).rejects.toThrow('disableAllHooks');
    await expect(stat(path.join(workPaths(project, work.work.id).dir, 'settings', 's-3-qwen.json'))).rejects.toThrow();
  });

  it('rejects an invalid session id', async () => {
    await expect(writeQwenSettings(dir, 'w-0001', '../x', { mcp, env: {} })).rejects.toThrow('invalid-session-id');
  });
});
