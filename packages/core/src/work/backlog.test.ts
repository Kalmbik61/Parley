import * as fs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addBacklogItem, completeBacklogItem, parseBacklog, readBacklog, removeBacklogItem, takeBacklogItem, updateBacklogItem } from './backlog.js';
import { sharedProjectPaths } from './store.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let project = '';
beforeEach(async () => { project = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-backlog-'))); });
afterEach(async () => { vi.restoreAllMocks(); await rm(project, { recursive: true, force: true }); });
async function seed(source: string): Promise<string> {
  const folder = path.join(project, '.parley'); await mkdir(folder, { recursive: true });
  const file = path.join(folder, 'backlog.md'); await writeFile(file, source); return file;
}

describe('lossless project backlog', () => {
  it('creates the header and allocates public monotonic IDs without sharing local counters', async () => {
    expect((await addBacklogItem(project, { title: 'First', details: 'Detail', by: 's-03' })).id).toBe('b-001');
    await removeBacklogItem(project, 'b-001');
    expect((await addBacklogItem(project, { title: 'Second' })).id).toBe('b-002');
    const document = await readBacklog(project);
    expect(document.source).toBe('# Backlog\n- [ ] Second <!-- b-002 -->\n');
    expect(document.source).not.toContain('suggestionSeq');
  });
  it('assigns handwritten IDs on the next write, preserving foreign bytes, BOM, CRLF and unknown metadata', async () => {
    const original = '\uFEFF# Backlog\r\n\r\nA paragraph.\r\n| A | B |\r\n* another list\r\n## Ideas\r\n- [ ] Handwritten\r\n  Details\r\n- [x] Old <!-- b-007 · done: 2026-10-05 · custom: yes -->\r\n';
    await seed(original);
    const added = await addBacklogItem(project, { title: 'Next' });
    expect(added.id).toBe('b-009');
    expect(added.document.source).toBe(original.replace('Handwritten\r\n', 'Handwritten <!-- b-008 -->\r\n') + '- [ ] Next <!-- b-009 -->\r\n');
    await updateBacklogItem(project, 'b-007', { title: 'Edited' });
    expect((await readBacklog(project)).source).toContain('- [x] Edited <!-- b-007 · done: 2026-10-05 · custom: yes -->\r\n');
  });
  it('preserves fenced checkboxes/headings and appends at the actual section boundary', async () => {
    const original = '# Backlog\n## Ideas\n```md\n## False\n- [ ] Fake <!-- b-999 -->\n```\nForeign\n## Bugs\nOther';
    await seed(original);
    expect(parseBacklog(original)).toEqual([]);
    const added = await addBacklogItem(project, { title: 'Real', section: 'Ideas' });
    expect(added.id).toBe('b-001');
    expect(added.document.source).toBe(original.replace('## Bugs\n', '- [ ] Real <!-- b-001 -->\n## Bugs\n'));
  });
  it('preserves taken/by/done and foreign metadata while editing only the selected block', async () => {
    await seed('# Backlog\n- [ ] Task <!-- b-003 · by: s-02 · custom: kept -->\n  Old details\n\nForeign tail');
    await takeBacklogItem(project, 'b-003', 'w-0043/r-01');
    await completeBacklogItem(project, 'b-003', '2026-10-05');
    await updateBacklogItem(project, 'b-003', { details: 'New\nMore' });
    expect((await readBacklog(project)).source).toBe('# Backlog\n- [x] Task <!-- b-003 · by: s-02 · custom: kept · taken: w-0043/r-01 · done: 2026-10-05 -->\n  New\n  More\n\nForeign tail');
  });
  it('preserves BOM on an edited first-line item and separates new details after a missing final newline', async () => {
    await seed('\uFEFF- [ ] Task <!-- b-001 -->');
    await updateBacklogItem(project, 'b-001', { details: 'Detail' });
    expect((await readBacklog(project)).source).toBe('\uFEFF- [ ] Task <!-- b-001 -->\n  Detail\n');
  });
  it.each(['\u2028', '\u2029'])('roundtrips non-CommonMark Unicode separator %j in titles, headings, metadata and fence info', async separator => {
    const source = `# Backlog\n## Group${separator}name\n- [ ] Existing${separator}title <!-- b-007 · custom: before${separator}after -->\n` +
      `\n\`\`\`info${separator}type\n- [ ] Fenced <!-- b-999 -->\n\`\`\`\n`;
    await seed(source);
    expect((await readBacklog(project)).items).toMatchObject([{ id: 'b-007', title: `Existing${separator}title`, section: `Group${separator}name` }]);
    const added = await addBacklogItem(project, { title: `New${separator}title`, section: `Group${separator}name` });
    expect(added.id).toBe('b-008');
    expect(added.document.items.map(item => item.title)).toEqual([`Existing${separator}title`, `New${separator}title`]);
    expect(added.document.source).toContain(`custom: before${separator}after`);
    expect(parseBacklog(`\`\`\`js\n\`\`\`${separator}\n- [ ] Still fenced\n\`\`\`\n`)).toEqual([]);
  });
  it('refuses merge markers/duplicate IDs/unclosed append fences without modifying shared text', async () => {
    for (const source of ['<<<<<<< HEAD\n- [ ] A', '- [ ] A <!-- b-001 -->\n- [ ] B <!-- b-001 -->', '```\n- [ ] A']) {
      const file = await seed(source);
      await expect(addBacklogItem(project, { title: 'B' })).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(source);
      // A reserved append from the unclosed fence is deliberately not silently recovered.
      await rm(path.join(project, '.parley', 'backlog-suggestions.json'), { force: true });
    }
  });
  it('serializes simultaneous appends and ID allocation under the project lock', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => addBacklogItem(project, { title: `Task ${index}` })));
    expect(new Set(results.map(row => row.id)).size).toBe(8);
    expect((await readBacklog(project)).items).toHaveLength(8);
  });
  it('detects changed content even when an external editor restores the mtime, then rereads once', async () => {
    const file = await seed('# Backlog\n- [ ] Before <!-- b-001 -->\n');
    let changes = 0;
    const added = await addBacklogItem(project, { title: 'Appended' }, { beforeCommit: async () => {
      if (changes++) return;
      const before = await fs.stat(file);
      await writeFile(file, '# Backlog\n- [ ] Extern <!-- b-001 -->\n');
      await utimes(file, before.atime, before.mtime);
    } });
    expect(added.document.items.map(row => row.title)).toEqual(['Extern', 'Appended']);
    expect(changes).toBe(2);
  });
  it.each([false, true])('preserves an external edit between the preparation read and apply read (explicit version %s)', async explicit => {
    const file = await seed('# Backlog\n- [ ] Before <!-- b-001 -->\n');
    const version = (await readBacklog(project)).version;
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let reads = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      if (String(target) === file && typeof flags === 'number' && ++reads === 2)
        await actual.writeFile(file, '# Backlog\n- [ ] External <!-- b-001 -->\n');
      return actual.open(target, flags, mode);
    });
    if (explicit) {
      await expect(addBacklogItem(project, { title: 'Appended' }, { expectedVersion: version })).rejects.toMatchObject({ code: 'backlog-conflict' });
      expect((await readBacklog(project)).items.map(row => row.title)).toEqual(['External']);
    } else {
      const added = await addBacklogItem(project, { title: 'Appended' });
      expect(added.document.items.map(row => row.title)).toEqual(['External', 'Appended']);
    }
  });
  it('allocates intervening handwritten rows above the reserved append ID and persists both counters before commit', async () => {
    const file = await seed('# Backlog\n- [ ] Before <!-- b-001 -->\n');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'); let reads = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      if (String(target) === file && typeof flags === 'number' && ++reads === 2)
        await actual.writeFile(file, '# Backlog\n- [ ] Before <!-- b-001 -->\n- [ ] Handwritten\n');
      return actual.open(target, flags, mode);
    });
    const added = await addBacklogItem(project, { title: 'Appended' }, { beforeCommit: async () => {
      const local = JSON.parse(await readFile(path.join(project, '.parley', 'backlog-suggestions.json'), 'utf8')) as { backlogSeq: number; operations: { backlogId: string }[] };
      expect(local.backlogSeq).toBe(3); expect(local.operations[0]?.backlogId).toBe('b-002');
    } });
    expect(added.document.items.map(row => [row.id, row.title])).toEqual([['b-001', 'Before'], ['b-003', 'Handwritten'], ['b-002', 'Appended']]);
  });
  it('refuses a human ID collision between reads and allows a fresh explicit retry with a new ID', async () => {
    const file = await seed('# Backlog\n- [ ] Before <!-- b-001 -->\n');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'); let reads = 0;
    const human = '# Backlog\n- [ ] Before <!-- b-001 -->\n- [ ] Human <!-- b-002 -->\n';
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      if (String(target) === file && typeof flags === 'number' && ++reads === 2) await actual.writeFile(file, human);
      return actual.open(target, flags, mode);
    });
    await expect(addBacklogItem(project, { title: 'Appended' })).rejects.toMatchObject({ code: 'backlog-conflict' });
    expect(await readFile(file, 'utf8')).toBe(human);
    vi.restoreAllMocks(); const added = await addBacklogItem(project, { title: 'Appended' });
    expect(added.id).toBe('b-003'); expect(new Set(added.document.items.map(row => row.id)).size).toBe(3);
  });
  it('refuses stale human versions and returns bounded conflict after repeated external edits', async () => {
    const file = await seed('# Backlog\n- [ ] Before <!-- b-001 -->\n');
    const old = await readBacklog(project); await writeFile(file, old.source + 'Human\n');
    await expect(updateBacklogItem(project, 'b-001', { title: 'Stale' }, { expectedVersion: old.version })).rejects.toMatchObject({ code: 'backlog-conflict' });
    let calls = 0;
    await expect(addBacklogItem(project, { title: 'Never' }, { beforeCommit: async () => {
      calls++; await writeFile(file, (await readFile(file, 'utf8')) + 'External\n');
    } })).rejects.toMatchObject({ code: 'backlog-conflict' });
    expect(calls).toBe(3); expect((await readFile(file, 'utf8'))).not.toContain('Never');
  });
  it('recovers a reserved operation after Markdown succeeds but the local terminal update fails', async () => {
    const originalRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename; let failed = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!failed && String(to).endsWith('backlog-suggestions.json') && await fs.stat(path.join(project, '.parley', 'backlog.md')).then(() => true, () => false)) {
        failed = true; throw Object.assign(new Error('fixture'), { code: 'ENOSPC' });
      }
      return originalRename(from, to);
    });
    await expect(addBacklogItem(project, { title: 'Once' })).rejects.toMatchObject({ code: 'ENOSPC' });
    vi.restoreAllMocks(); await addBacklogItem(project, { title: 'Later' });
    expect((await readBacklog(project)).items.map(item => item.title)).toEqual(['Once', 'Later']);
    const local = JSON.parse(await readFile((await sharedProjectPaths(project)).suggestions, 'utf8')) as { operations: { status: string }[] };
    expect(local.operations.map(row => row.status)).toEqual(['applied', 'applied']);
  });
  it('retries an uncommitted reserved append with its original ID after atomic replacement fails', async () => {
    const originalRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
    let failed = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!failed && String(to).endsWith('backlog.md')) {
        failed = true; throw Object.assign(new Error('fixture'), { code: 'ENOSPC' });
      }
      return originalRename(from, to);
    });
    await expect(addBacklogItem(project, { title: 'Reserved' })).rejects.toMatchObject({ code: 'ENOSPC' });
    vi.restoreAllMocks(); expect((await addBacklogItem(project, { title: 'Later' })).id).toBe('b-002');
    expect((await readBacklog(project)).items.map(item => [item.id, item.title])).toEqual([['b-001', 'Reserved'], ['b-002', 'Later']]);
  });
  it('refuses ambiguous recovery after an external deletion rather than resurrecting the item', async () => {
    const originalRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename; let failed = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!failed && String(to).endsWith('backlog-suggestions.json') && await fs.stat(path.join(project, '.parley', 'backlog.md')).then(() => true, () => false)) {
        failed = true; throw Object.assign(new Error('fixture'), { code: 'ENOSPC' });
      }
      return originalRename(from, to);
    });
    await expect(addBacklogItem(project, { title: 'Deleted by human' })).rejects.toThrow();
    vi.restoreAllMocks(); const file = path.join(project, '.parley', 'backlog.md'); await writeFile(file, '# Backlog\nHuman\n');
    await expect(addBacklogItem(project, { title: 'Later' })).rejects.toMatchObject({ code: 'backlog-conflict' });
    expect(await readFile(file, 'utf8')).toBe('# Backlog\nHuman\n');
  });
});

describe('version-bound handwritten item actions', () => {
  it('selects the original row and assigns IDs inside the same edit transaction', async () => {
    const original = '# Backlog\r\n## Bugs\r\n- [ ] First\r\n  Detail\r\n- [ ] Second\r\nForeign tail';
    await seed(original);
    const before = await readBacklog(project);
    const result = await updateBacklogItem(project, 1, { title: 'Chosen', checked: true, done: '2026-10-04' }, { expectedVersion: before.version });
    expect(result.id).toBe('b-002');
    expect(result.document.items).toMatchObject([{ id: 'b-001', title: 'First', checked: false }, { id: 'b-002', title: 'Chosen', checked: true, done: '2026-10-04' }]);
    expect(result.document.source).toContain('Foreign tail');
    expect(result.document.source).toContain('\r\n');
  });
  it('refuses an index without an exact version and stale/reordered rows without modifying Markdown', async () => {
    const file = await seed('# Backlog\n- [ ] First\n- [ ] Second\n');
    const before = await readBacklog(project);
    await expect(updateBacklogItem(project, 0, { title: 'No proof' })).rejects.toMatchObject({ code: 'backlog-invalid' });
    const reordered = '# Backlog\n- [ ] Second\n- [ ] First\n'; await writeFile(file, reordered);
    await expect(updateBacklogItem(project, 0, { title: 'Wrong row' }, { expectedVersion: before.version })).rejects.toMatchObject({ code: 'backlog-conflict' });
    expect(await readFile(file, 'utf8')).toBe(reordered);
  });
  it('takes/removes a handwritten item by its confirmed position without reusing allocated IDs', async () => {
    await seed('# Backlog\n- [ ] First\n- [ ] Second\n');
    const before = await readBacklog(project);
    const taken = await takeBacklogItem(project, 1, 'w-01/r-01', { expectedVersion: before.version });
    expect(taken.document.items[1]).toMatchObject({ id: 'b-002', taken: 'w-01/r-01' });
    await seed('# Backlog\n- [ ] New handwritten\n');
    const fresh = await readBacklog(project);
    expect((await removeBacklogItem(project, 0, { expectedVersion: fresh.version })).id).toBe('b-003');
    expect((await addBacklogItem(project, { title: 'Next' })).id).toBe('b-004');
  });
  it('rejects invalid/out-of-range indexes and an external editor change during indexed commit', async () => {
    const file = await seed('# Backlog\n- [ ] First\n'); const before = await readBacklog(project);
    for (const index of [-1, 0.5, 1, Number.NaN]) await expect(updateBacklogItem(project, index, { checked: true }, { expectedVersion: before.version })).rejects.toMatchObject({ code: 'backlog-invalid' });
    await expect(updateBacklogItem(project, 0, { checked: true }, { expectedVersion: before.version,
      beforeCommit: async () => { await writeFile(file, '# Backlog\n- [ ] Human replacement\n'); } })).rejects.toMatchObject({ code: 'backlog-conflict' });
    expect(await readFile(file, 'utf8')).toContain('Human replacement');
  });
});

describe('prepare handwritten take without rewriting human content', () => {
  it('empty patch preserves a long identified title and foreign metadata/spacing byte for byte', async () => {
    const source = `\uFEFF# Backlog\r\n- [ ] ${'x'.repeat(4097)}  <!-- b-007   · custom: kept  spacing -->\r\n  Details\r\nForeign`;
    await seed(source); const before = await readBacklog(project);
    const prepared = await updateBacklogItem(project, 'b-007', {}, { expectedVersion: before.version });
    expect(prepared.id).toBe('b-007'); expect(prepared.document.source).toBe(source);
  });
  it('empty patch allocates a long handwritten title and refuses a concurrent external edit', async () => {
    const file = await seed(`# Backlog\n- [ ] ${'x'.repeat(4097)}\nForeign`);
    const before = await readBacklog(project);
    const prepared = await updateBacklogItem(project, 0, {}, { expectedVersion: before.version });
    expect(prepared.id).toBe('b-001'); expect(prepared.document.items[0]!.title).toHaveLength(4097);
    await expect(updateBacklogItem(project, prepared.id, {}, { expectedVersion: prepared.document.version,
      beforeCommit: async () => { await writeFile(file, '# Backlog\n- [ ] Human replacement\n'); } })).rejects.toMatchObject({ code: 'backlog-conflict' });
    expect(await readFile(file, 'utf8')).toContain('Human replacement');
  });
});
