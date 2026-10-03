import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProjectPreferences, setBacklogRule } from './project-preferences.js';

let project = '';
beforeEach(async () => { project = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-preferences-'))); });
afterEach(async () => { await rm(project, { recursive: true, force: true }); });
describe('local backlog preferences', () => {
  it('defaults to problems without creating a file on read', async () => {
    expect(await readProjectPreferences(project)).toEqual({ backlogRule: 'problems' });
    await expect(readFile(path.join(project, '.parley', 'preferences.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('writes each explicit choice and preserves unrelated versioned preference fields', async () => {
    const file = path.join(project, '.parley', 'preferences.json'); await mkdir(path.dirname(file));
    await writeFile(file, JSON.stringify({ version: 1, unrelated: { keep: true }, backlogRule: 'ask' }));
    for (const rule of ['everything', 'ask', 'problems'] as const) {
      expect(await setBacklogRule(project, rule)).toEqual({ backlogRule: rule });
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, unrelated: { keep: true }, backlogRule: rule });
    }
  });
  it('refuses malformed/unknown saved choices rather than falling back to problems', async () => {
    const file = path.join(project, '.parley', 'preferences.json'); await mkdir(path.dirname(file));
    for (const text of ['{', 'null', '{"version":2,"backlogRule":"ask"}', '{"version":1,"backlogRule":"unknown"}']) {
      await writeFile(file, text);
      await expect(readProjectPreferences(project)).rejects.toMatchObject({ code: 'preferences-invalid' });
      await expect(setBacklogRule(project, 'everything')).rejects.toMatchObject({ code: 'preferences-invalid' });
      expect(await readFile(file, 'utf8')).toBe(text);
    }
  });
});
