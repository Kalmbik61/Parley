// The human's Code Mode setting (plan T12a, §3): the reader table, ordered writes with a failure at every step, real processes killed between
// the steps, and the same-uid limit pinned by doing it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, ENV_NAMES, loadConfig, parseSetting, saveConfig } from '../config.js';
import {
  type CodeModeConfigValue,
  CodeModeNotSaved,
  type CodeModeStores,
  type TombstoneState,
  codeModeRequested,
  codeModeRequestedFrom,
  codeModeStateFrom,
  readCodeModeConfig,
  readTombstone,
  realStores,
  setCodeMode,
} from './code-mode-setting.js';
import { closeWorkDb, workDb } from './db.js';

const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

let home: string;
let file: string;
const was = process.env['PARLEY_HOME'];
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'parley-t12a-setting-'));
  process.env['PARLEY_HOME'] = home;
  file = path.join(home, 'config.json');
});
afterEach(() => {
  closeWorkDb();
  if (was === undefined) delete process.env['PARLEY_HOME']; else process.env['PARLEY_HOME'] = was;
  rmSync(home, { recursive: true, force: true });
});

describe('the reader table', () => {
  const rows: [CodeModeConfigValue, TombstoneState, boolean][] = [
    ['missing', 'clear', true],
    ['on', 'clear', true],
    ['off', 'clear', false],
    ['off', 'set', false],
    ['missing', 'set', false],
    ['on', 'set', false],
    ['unreadable', 'set', false],
    ['unreadable', 'clear', false],
    ['on', 'unreadable', false],
    ['missing', 'unreadable', false],
  ];
  it.each(rows)('config %s, row %s: requested %s', (config, row, requested) => { expect(codeModeRequestedFrom(config, row)).toBe(requested); });
});

describe('the state read back for the window (lead m-7289, R2)', () => {
  const states: [CodeModeConfigValue, TombstoneState, string][] = [
    ['missing', 'clear', 'on'],
    ['on', 'clear', 'on'],
    ['off', 'clear', 'off-not-durable'],
    ['unreadable', 'clear', 'off-not-durable'],
    ['off', 'set', 'off'],
    ['unreadable', 'set', 'off'],
    ['on', 'set', 'off-next-launch'],
    ['missing', 'set', 'off-next-launch'],
    ['on', 'unreadable', 'off-next-launch'],
    ['missing', 'unreadable', 'off-next-launch'],
    ['off', 'unreadable', 'off'],
    ['unreadable', 'unreadable', 'off'],
  ];
  it.each(states)('config %s, row %s: %s', (config, row, state) => { expect(codeModeStateFrom(config, row)).toBe(state); });
  it('on exactly when the launcher requests it, for every pair', () => {
    for (const config of ['on', 'off', 'missing', 'unreadable'] as const) for (const row of ['set', 'clear', 'unreadable'] as const) {
      expect(codeModeStateFrom(config, row) === 'on').toBe(codeModeRequestedFrom(config, row));
    }
  });
});

describe('config.json, kept apart from missing', () => {
  it.each([
    ['no file', null, 'missing'],
    ['no key', '{"agentSkills":true}', 'missing'],
    ['true', '{"codeMode":true}', 'on'],
    ['false', '{"codeMode":false}', 'off'],
    ['truncated', '{"codeMode":fal', 'unreadable'],
    ['empty', '', 'unreadable'],
    ['an array', '[]', 'unreadable'],
    ['a string value', '{"codeMode":"false"}', 'unreadable'],
    ['a number value', '{"codeMode":0}', 'unreadable'],
  ] as const)('%s: %s', async (_n, text, expected) => {
    if (text !== null) writeFileSync(file, text);
    expect(await readCodeModeConfig(file)).toBe(expected);
  });
  it('a directory at the path: unreadable', async () => { const dir = path.join(home, 'dir'); spawnSync('mkdir', [dir]); expect(await readCodeModeConfig(dir)).toBe('unreadable'); });
});

describe('the config key', () => {
  it('ON by default; boolean only; parsed like the other flags', async () => {
    expect(DEFAULT_CONFIG.codeMode).toBe(true);
    expect((await loadConfig(file, {})).config.codeMode).toBe(true);
    writeFileSync(file, '{"codeMode":false}');
    expect((await loadConfig(file, {})).config.codeMode).toBe(false);
    expect(parseSetting('codeMode', '0')).toEqual({ value: false });
    expect(parseSetting('codeMode', 'maybe')).toHaveProperty('error');
  });
  it('the environment cannot set it, under either prefix: an agent\'s environment must not turn it on', async () => {
    writeFileSync(file, '{"codeMode":false}');
    const loaded = await loadConfig(file, { PARLEY_CODE_MODE: '1', HARNAS_CODE_MODE: '1', PARLEY_CODEMODE: '1' });
    expect(loaded.config.codeMode).toBe(false);
    expect(loaded.fromEnv).not.toContain('codeMode' as never);
    expect(Object.keys(ENV_NAMES)).not.toContain('codeMode');
  });
});

describe('saveConfig is atomic', () => {
  it('keeps the other keys, leaves no temp, and a reader during many writes never sees a torn file', async () => {
    writeFileSync(file, '{"agentSkills":false,"foreign":"kept"}');
    const torn: string[] = [];
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        try { const t = readFileSync(file, 'utf8'); JSON.parse(t); } catch (e) { torn.push(String(e)); }
        await new Promise((r) => setImmediate(r));
      }
    })();
    for (let i = 0; i < 200; i++) await saveConfig({ codeMode: i % 2 === 0, messageRate: i + 1 }, file);
    stop = true;
    await reader;
    expect(torn).toEqual([]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ agentSkills: false, foreign: 'kept', codeMode: false, messageRate: 200 });
    expect(spawnSync('ls', ['-A', home], { encoding: 'utf8' }).stdout.split('\n').filter((n) => n.includes('.tmp'))).toEqual([]);
  });
  it('a write that fails leaves the previous file and no temp', async () => {
    writeFileSync(file, '{"codeMode":true}');
    await expect(saveConfig({ codeMode: false }, path.join(file, 'not-a-dir', 'config.json'))).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{"codeMode":true}');
  });
});

describe('setCodeMode: ordered, every partial failure errs towards OFF', () => {
  type Step = 'writeTombstone' | 'clearTombstone' | 'writeConfig';
  /** In-memory stores that log their order and fail on demand; `reads` answers like the real reader. */
  const fake = (fail: Step[] = [], start: { config: CodeModeConfigValue; row: TombstoneState } = { config: 'missing', row: 'clear' }) => {
    const state = { ...start, log: [] as string[] };
    const stores: CodeModeStores = {
      writeTombstone: () => { state.log.push('row+'); if (fail.includes('writeTombstone')) throw new Error('x'); state.row = 'set'; },
      clearTombstone: () => { state.log.push('row-'); if (fail.includes('clearTombstone')) throw new Error('x'); state.row = 'clear'; },
      writeConfig: async (on) => { state.log.push(on ? 'config+' : 'config-'); if (fail.includes('writeConfig')) throw new Error('x'); state.config = on ? 'on' : 'off'; },
      current: async () => codeModeRequestedFrom(state.config, state.row),
    };
    return { state, stores, requested: () => codeModeRequestedFrom(state.config, state.row) };
  };
  it('off: row first, then config; both done: off, durable', async () => {
    const f = fake();
    expect(await setCodeMode(false, f.stores)).toBe('off');
    expect(f.state.log).toEqual(['row+', 'config-']);
    expect(f.requested()).toBe(false);
  });
  it('off, row fails: config still written, off-not-durable; off holds while config says so', async () => {
    const f = fake(['writeTombstone']);
    expect(await setCodeMode(false, f.stores)).toBe('off-not-durable');
    expect(f.state.log).toEqual(['row+', 'config-']);
    expect(f.requested()).toBe(false);
  });
  it('off, row done, config fails: off-next-launch: new launches are off, a running session reading config.json is not stopped', async () => {
    const f = fake(['writeConfig'], { config: 'on', row: 'clear' });
    expect(await setCodeMode(false, f.stores)).toBe('off-next-launch');
    expect(f.requested()).toBe(false);
    expect(f.state.config).toBe('on');
  });
  it('off, both fail: not saved, the prior state stands, and the error says which', async () => {
    const f = fake(['writeTombstone', 'writeConfig'], { config: 'on', row: 'clear' });
    await expect(setCodeMode(false, f.stores)).rejects.toEqual(new CodeModeNotSaved('on'));
    expect(f.requested()).toBe(true);
  });
  it('on: config first, row cleared last; both done: on', async () => {
    const f = fake([], { config: 'off', row: 'set' });
    expect(await setCodeMode(true, f.stores)).toBe('on');
    expect(f.state.log).toEqual(['config+', 'row-']);
    expect(f.requested()).toBe(true);
  });
  it('on, config fails: still off, the row untouched, not saved', async () => {
    const f = fake(['writeConfig'], { config: 'off', row: 'set' });
    await expect(setCodeMode(true, f.stores)).rejects.toEqual(new CodeModeNotSaved('off'));
    expect(f.state.log).toEqual(['config+']);
    expect(f.requested()).toBe(false);
  });
  it('on while already on, the config write fails: not saved, and the error says still on (s-296 m-7139)', async () => {
    const f = fake(['writeConfig'], { config: 'on', row: 'clear' });
    await expect(setCodeMode(true, f.stores)).rejects.toEqual(new CodeModeNotSaved('on'));
    expect(f.requested()).toBe(true);
  });
  it('on, the clear fails: still off, because the row wins; not saved', async () => {
    const f = fake(['clearTombstone'], { config: 'off', row: 'set' });
    await expect(setCodeMode(true, f.stores)).rejects.toEqual(new CodeModeNotSaved('off'));
    expect(f.requested()).toBe(false);
  });
});

describe('the real stores', () => {
  it('off survives the deletion, truncation or replacement of config.json', async () => {
    expect(await setCodeMode(false, realStores(file))).toBe('off');
    for (const attack of [() => rmSync(file), () => writeFileSync(file, ''), () => writeFileSync(file, '{"codeMode":true}'), () => writeFileSync(file, '{}')]) {
      attack();
      expect(await codeModeRequested(file)).toBe(false);
    }
  });
  it('on through the method clears it; a missing initial setting requests on', async () => {
    expect(await codeModeRequested(file)).toBe(true);
    await setCodeMode(false, realStores(file));
    expect(await setCodeMode(true, realStores(file))).toBe('on');
    expect(await codeModeRequested(file)).toBe(true);
    expect(readTombstone(workDb())).toBe('clear');
  });
  it('a store without the table, or that cannot be opened: off', async () => {
    const db: DatabaseSync = new Database(':memory:');
    expect(readTombstone(db)).toBe('unreadable');
    expect(await codeModeRequested(file, db)).toBe(false);
    db.close();
  });
  it('the same-uid limit, pinned by doing it: a process of this user that rewrites both stores DOES turn it back on', async () => {
    await setCodeMode(false, realStores(file));
    workDb().prepare('DELETE FROM code_mode_preference').run();
    writeFileSync(file, '{"codeMode":true}');
    expect(await codeModeRequested(file)).toBe(true);
  });
});

describe('a real process killed between the steps', () => {
  const coreDir = fileURLToPath(new URL('../../', import.meta.url));
  /** A child that runs the real ordered writes and kills itself right after the given store call returns. */
  const killAfter = (on: boolean, after: 'writeTombstone' | 'writeConfig' | 'clearTombstone'): void => {
    const script = `
      const S = await import(${JSON.stringify(path.join(coreDir, 'dist/work/code-mode-setting.js'))});
      const real = S.realStores(${JSON.stringify(file)});
      const die = (name, f) => async (...a) => { const r = await f(...a); if (name === ${JSON.stringify(after)}) process.kill(process.pid, 'SIGKILL'); return r; };
      await S.setCodeMode(${on}, { writeTombstone: die('writeTombstone', real.writeTombstone), clearTombstone: die('clearTombstone', real.clearTombstone), writeConfig: die('writeConfig', real.writeConfig), current: real.current });`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PARLEY_HOME: home }, encoding: 'utf8' });
    expect(r.signal, r.stderr).toBe('SIGKILL');
  };
  it('off, killed after the row: off', async () => { killAfter(false, 'writeTombstone'); closeWorkDb(); expect(await codeModeRequested(file)).toBe(false); });
  it('on from off, killed after the config: still off', async () => {
    await setCodeMode(false, realStores(file)); closeWorkDb();
    killAfter(true, 'writeConfig'); closeWorkDb();
    expect(JSON.parse(readFileSync(file, 'utf8')).codeMode).toBe(true);
    expect(await codeModeRequested(file)).toBe(false);
  });
  it('on from off, killed after the clear: on, both steps finished', async () => {
    await setCodeMode(false, realStores(file)); closeWorkDb();
    killAfter(true, 'clearTombstone'); closeWorkDb();
    expect(await codeModeRequested(file)).toBe(true);
  });
});

describe('one writer: config.json is written only by the host process (lead m-7152, s-290 m-7151)', () => {
  // saveConfig's queue orders writes inside one process only. That covers every writer because the only production callers sit in the host,
  // and the host is one process per Parley home (`host.pid`, HostAlreadyRunning: host-lock.test.ts). This walk fails the day a writer appears
  // anywhere else, in any package or entry point; then the stale-merge clamp or a cross-process lock is needed (m-7152, step 3).
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const sources = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) && !/\.(test|spec)\.[a-z]+$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full);
      }
    };
    for (const dir of ['packages', 'tools', 'scripts']) { try { walk(path.join(root, dir)); } catch { /* absent */ } }
    return out;
  };
  const callers = (pattern: RegExp): string[] => sources()
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .sort();
  it('saveConfig is called from the host settings method and the Code Mode stores only', () => {
    expect(callers(/\bsaveConfig\s*\(/)).toEqual([
      'packages/core/src/config.ts',
      'packages/core/src/work/code-mode-setting.ts',
      'packages/host/src/methods/settings.ts',
    ]);
  });
  it('the Code Mode writes run from the host settings method only', () => {
    expect(callers(/\b(setCodeMode|realStores)\s*\(/)).toEqual([
      'packages/core/src/work/code-mode-setting.ts',
      'packages/host/src/methods/settings.ts',
    ]);
  });
  it('no other source builds a path to config.json: only configPath() does (the home move renames the whole directory and never opens it)', () => {
    // String literals only: comments name the file in backticks.
    expect(callers(/['"]config\.json['"]/)).toEqual(['packages/core/src/config.ts']);
  });
  /**
   * Import-aware (lead m-7170, s-290 WATCH m-7168): every import, re-export, namespace import and dynamic import of config.ts,
   * code-mode-setting.ts or the core barrel that names one of the four, aliased or not. A namespace import of those modules counts as all four.
   */
  const WRITE_NAMES = new Set(['saveConfig', 'configPath', 'setCodeMode', 'realStores']);
  const importsOf = (): Record<string, string[]> => {
    const hits: Record<string, Set<string>> = {};
    const isTarget = (spec: string, from: string): boolean => {
      if (spec === '@parley/core' || spec.startsWith('@parley/core/')) return true;
      if (!spec.startsWith('.')) return false;
      const abs = path.resolve(path.dirname(from), spec).replace(/\.(js|ts|mjs|cjs)$/, '').split(path.sep).join('/');
      return /packages\/core\/src\/(config|work\/code-mode-setting|index)$/.test(abs);
    };
    for (const file of sources()) {
      const text = readFileSync(file, 'utf8');
      const rel = path.relative(root, file).split(path.sep).join('/');
      const add = (entry: string): void => { (hits[rel] ??= new Set()).add(entry); };
      const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier) && isTarget(node.moduleSpecifier.text, file)) {
          const exporting = ts.isExportDeclaration(node);
          const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
          if (exporting && bindings === undefined) add('* (export star)');
          if (bindings !== undefined && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
            for (const el of bindings.elements) {
              const name = (el.propertyName ?? el.name).text;
              if (WRITE_NAMES.has(name)) add(exporting ? `${name} (re-export)` : name);
            }
          }
          if (bindings !== undefined && (ts.isNamespaceImport(bindings) || ts.isNamespaceExport(bindings))) add('* (namespace)');
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const spec = node.arguments[0];
          if (spec !== undefined && ts.isStringLiteral(spec) && isTarget(spec.text, file)) for (const name of WRITE_NAMES) if (text.includes(name)) add(`${name} (dynamic)`);
        }
        ts.forEachChild(node, visit);
      };
      visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
    }
    return Object.fromEntries(Object.entries(hits).sort(([a], [b]) => a.localeCompare(b)).map(([file, names]) => [file, [...names].sort()]));
  };
  it('import-aware: only these files import or re-export saveConfig, configPath, setCodeMode or realStores, under any alias', () => {
    expect(importsOf()).toEqual({
      // The package barrel: re-exports for the host.
      'packages/core/src/index.ts': ['configPath (re-export)', 'saveConfig (re-export)', 'setCodeMode (re-export)'],
      'packages/core/src/mcp/code-mode-tools.ts': ['configPath (dynamic)'],
      'packages/core/src/work/code-mode-setting.ts': ['configPath', 'saveConfig'],
      // Reads only: `loadConfig(configPath(), …)` for the worktree root (checked below).
      'packages/desktop/src/main/index.ts': ['configPath'],
      'packages/host/src/methods/settings.ts': ['saveConfig', 'setCodeMode'],
    });
  });
  it('the desktop main process uses configPath() only as the argument of loadConfig: it reads, never writes', () => {
    const text = readFileSync(path.join(root, 'packages/desktop/src/main/index.ts'), 'utf8');
    const uses = text.match(/configPath\(\)/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    expect(text.match(/loadConfig\(configPath\(\)/g)).toHaveLength(uses.length);
  });
  it('the session process\'s live backend only reads: it passes configPath() to the detector and names no writer (T12a slice C, lead m-7195)', () => {
    const text = readFileSync(path.join(root, 'packages/core/src/mcp/code-mode-tools.ts'), 'utf8');
    expect(text).not.toMatch(/\b(saveConfig|setCodeMode|realStores|writeFile|writeFileSync|rename|renameSync|appendFile|truncate)\b/);
    expect(text.match(/configPath\(\)/g)).toEqual(['configPath()']);
    expect(text).toContain('configFile: configPath()');
  });
  it('the walk is real: it reads the host and desktop sources', () => {
    const all = sources().map((file) => path.relative(root, file).split(path.sep).join('/'));
    expect(all).toContain('packages/host/src/methods/settings.ts');
    expect(all.some((file) => file.startsWith('packages/desktop/src/main/'))).toBe(true);
    expect(all.length).toBeGreaterThan(500);
  });
});
