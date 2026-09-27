/**
 * Ссылки терминала (кусок 5.3, спека 8.3): регулярки, ячейки буфера, разрешение путей,
 * кэш над `files.locate` и провайдер. Тесты 1–5 и 13 брифа.
 */

import { describe, expect, it } from 'vitest';
import type { ILink } from '@xterm/xterm';
import type { Located } from '../../shared/files-types.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession } from '../test-utils/work-fixtures.js';
import { FakeTerminal, lineFromText, xtermMock } from '../test-utils/xterm-mock.js';
import {
  createLinkProvider,
  createStatCache,
  findLinkCandidates,
  isHttpUrl,
  resolveCandidatePath,
  sessionCwd,
  type LinkCandidate,
  type TerminalLink,
} from './links.js';

function located(workKey: string, relPath: string): Located {
  return { root: { workKey, spec: { kind: 'project' } }, relPath, stat: { kind: 'file', size: 1, mtimeMs: 0 } };
}

describe('тест 1: findLinkCandidates', () => {
  it('src/app/main.ts:12:3 — один кандидат со строкой и колонкой, без /app/main.ts', () => {
    const line = 'Error at src/app/main.ts:12:3';
    expect(findLinkCandidates(line)).toEqual([
      { start: 9, end: line.length, kind: 'path', path: 'src/app/main.ts', line: 12, col: 3 },
    ]);
  });

  it('путь с кириллицей без точки в конце', () => {
    const [candidate, ...rest] = findLinkCandidates('см. ./docs/Отчёт.md.');
    expect(rest).toEqual([]);
    expect(candidate).toMatchObject({ kind: 'path', path: './docs/Отчёт.md' });
    expect('см. ./docs/Отчёт.md.'.slice(candidate?.start, candidate?.end)).toBe('./docs/Отчёт.md');
  });

  it('адрес с путём внутри — один url', () => {
    expect(findLinkCandidates('https://example.com/a/b.ts?x=1')).toEqual([
      { start: 0, end: 30, kind: 'url', url: 'https://example.com/a/b.ts?x=1' },
    ]);
  });

  it('(см. https://x.y/z). — адрес без ).', () => {
    const found = findLinkCandidates('(см. https://x.y/z).');
    expect(found.map((c) => c.url ?? c.path)).toEqual(['https://x.y/z']);
  });

  it('version 1.2.3 — ничего', () => {
    expect(findLinkCandidates('version 1.2.3')).toEqual([]);
  });

  it('~/x/y.txt — путь', () => {
    expect(findLinkCandidates('open ~/x/y.txt now')).toEqual([{ start: 5, end: 14, kind: 'path', path: '~/x/y.txt' }]);
  });

  it('два вызова подряд дают одно и то же (lastIndex не держится)', () => {
    const line = 'see https://a.b/c and ./x/y.ts:4';
    const first = findLinkCandidates(line);
    expect(first).toHaveLength(2);
    expect(findLinkCandidates(line)).toEqual(first);
  });
});

describe('тест 13: isHttpUrl', () => {
  it('http и https — да, file и javascript — нет', () => {
    expect(isHttpUrl('https://example.com')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('тест 3: resolveCandidatePath и sessionCwd', () => {
  const candidate = (path: string): LinkCandidate => ({ start: 0, end: path.length, kind: 'path', path });

  it('относительный — от worktree; ../x/./y.ts от /p/w → /p/x/y.ts; ~ как есть', () => {
    expect(resolveCandidatePath(candidate('src/a.ts'), '/p/wt/s1')).toBe('/p/wt/s1/src/a.ts');
    expect(resolveCandidatePath(candidate('../x/./y.ts'), '/p/w')).toBe('/p/x/y.ts');
    expect(resolveCandidatePath(candidate('~/x'), '/p/w')).toBe('~/x');
    expect(resolveCandidatePath(candidate('../../../../a'), '/p/w')).toBe('/a');
    expect(resolveCandidatePath(candidate('/abs/./b/../c.ts'), '/p/w')).toBe('/abs/c.ts');
  });

  it('sessionCwd: worktree создан — его путь; createdAt: null — projectPath', () => {
    const planned = makeSession('s1', 'a', { worktree: { path: '/wt/s1', branch: 'b', base: 'main', createdAt: null } });
    const created = makeSession('s1', 'a', { worktree: { path: '/wt/s1', branch: 'b', base: 'main', createdAt: '2026-09-27T00:00:00Z' } });
    expect(sessionCwd(planned, '/proj')).toBe('/proj');
    expect(sessionCwd(created, '/proj')).toBe('/wt/s1');
    expect(sessionCwd(makeSession('s2', 'b'), '/proj')).toBe('/proj');
  });
});

describe('тест 4: createStatCache', () => {
  function setup() {
    let clock = 1_000;
    const calls: Array<{ workKey: string; absPaths: string[] }> = [];
    const cache = createStatCache(
      async (workKey, absPaths) => {
        calls.push({ workKey, absPaths: [...absPaths] });
        return absPaths.map((p) => (p.endsWith('.ts') ? located(workKey, p.slice(1)) : null));
      },
      { now: () => clock },
    );
    return { cache, calls, advance: (ms: number) => (clock += ms) };
  }

  it('повтор в течение 10 с не зовёт locate, и для null тоже; через 10 с — зовёт', async () => {
    const { cache, calls, advance } = setup();
    const first = await cache.lookup('w', ['/a.ts', '/missing']);
    expect(first[0]).not.toBeNull();
    expect(first[1]).toBeNull();
    advance(9_999);
    await cache.lookup('w', ['/a.ts', '/missing']);
    expect(calls).toHaveLength(1);
    advance(1);
    await cache.lookup('w', ['/a.ts', '/missing']);
    expect(calls).toHaveLength(2);
  });

  it('501-й путь вытесняет самый старый', async () => {
    const { cache, calls } = setup();
    const paths = Array.from({ length: 501 }, (_, i) => `/f${i}`);
    for (let i = 0; i < 501; i += 100) await cache.lookup('w', paths.slice(i, i + 100));
    const before = calls.length;
    await cache.lookup('w', ['/f1']);
    expect(calls).toHaveLength(before);
    await cache.lookup('w', ['/f0']);
    expect(calls).toHaveLength(before + 1);
    expect(calls.at(-1)).toEqual({ workKey: 'w', absPaths: ['/f0'] });
  });

  it('тот же путь с другим workKey — отдельный вызов', async () => {
    const { cache, calls } = setup();
    await cache.lookup('w1', ['/a.ts']);
    await cache.lookup('w2', ['/a.ts']);
    expect(calls.map((c) => c.workKey)).toEqual(['w1', 'w2']);
  });
});

function provide(term: FakeTerminal, deps: Parameters<typeof createLinkProvider>[1], y: number): Promise<ILink[] | undefined> {
  const provider = createLinkProvider(term, deps);
  return new Promise((resolve) => provider.provideLinks(y, resolve));
}

describe('тест 2: ячейки буфера', () => {
  it('эмодзи и CJK перед путём — start и end в ячейках', async () => {
    xtermMock.reset();
    const term = new FakeTerminal();
    term.setLines([lineFromText('😀漢 ./a.ts')]);
    const bridge = createFakeBridge();
    bridge.setLocated('w', '/p/a.ts', located('w', 'a.ts'));
    const links = await provide(term, { workKey: () => 'w', cwd: () => '/p', cache: createStatCache(bridge.files.locate), onLink: () => {} }, 1);
    // 😀 — ячейки 1–2, 漢 — 3–4, пробел — 5, `./a.ts` — 6–11 (1-based, включительно).
    expect(links?.map((l) => l.range)).toEqual([{ start: { x: 6, y: 1 }, end: { x: 11, y: 1 } }]);
  });

  it('путь, перенесённый на вторую строку (isWrapped), — одна ссылка на обе строки', async () => {
    xtermMock.reset();
    const term = new FakeTerminal();
    term.cols = 10;
    term.setLines([lineFromText('xx ./dir/l'), lineFromText('ong.ts', true)]);
    const bridge = createFakeBridge();
    bridge.setLocated('w', '/p/dir/long.ts', located('w', 'dir/long.ts'));
    const deps = { workKey: () => 'w', cwd: () => '/p', cache: createStatCache(bridge.files.locate), onLink: () => {} };
    const fromSecond = await provide(term, deps, 2);
    expect(fromSecond?.map((l) => [l.text, l.range])).toEqual([['./dir/long.ts', { start: { x: 4, y: 1 }, end: { x: 6, y: 2 } }]]);
    const fromFirst = await provide(term, deps, 1);
    expect(fromFirst?.map((l) => l.range)).toEqual(fromSecond?.map((l) => l.range));
  });
});

describe('тест 5: провайдер', () => {
  it('lookup получает workKey своего терминала; null и чужой корень ссылками не становятся', async () => {
    xtermMock.reset();
    const term = new FakeTerminal();
    term.setLines([lineFromText('a.ts b.ts c.ts https://x.y/z file:///etc/passwd')]);
    const bridge = createFakeBridge();
    bridge.setLocated('mine', '/p/a.ts', located('mine', 'a.ts'));
    bridge.setLocated('mine', '/p/c.ts', located('other', 'c.ts'));
    const clicked: TerminalLink[] = [];
    const links = await provide(
      term,
      { workKey: () => 'mine', cwd: () => '/p', cache: createStatCache(bridge.files.locate), onLink: (link) => clicked.push(link) },
      1,
    );
    expect(bridge.locateCalls).toEqual([{ workKey: 'mine', absPaths: ['/p/a.ts', '/p/b.ts', '/p/c.ts'] }]);
    expect(links?.map((l) => l.text)).toEqual(['a.ts', 'https://x.y/z']);
    links?.[0]?.activate(new MouseEvent('click'), 'a.ts');
    links?.[1]?.activate(new MouseEvent('click'), 'https://x.y/z');
    expect(clicked).toEqual([
      { kind: 'path', absPath: '/p/a.ts', located: located('mine', 'a.ts') },
      { kind: 'url', url: 'https://x.y/z' },
    ]);
  });
});
