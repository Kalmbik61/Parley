import { describe, expect, it } from 'vitest';
import type { FileRootSpec } from '../../shared/layout-types.js';
import { nodeId, tabId } from './ids.js';

/** Подставной `random`: считает от 0, каждый вызов — следующий hex-разряд (тест 15). */
function stubRandom(): () => number {
  let i = 0;
  return () => {
    const value = i / 16;
    i += 1;
    return value;
  };
}

describe('tabId', () => {
  it('terminal детерминирован по sessionId', () => {
    expect(tabId.terminal('s-01')).toBe('terminal:s-01');
    expect(tabId.terminal('s-01')).toBe(tabId.terminal('s-01'));
  });

  it('mail — фиксированный id', () => {
    expect(tabId.mail()).toBe('mail');
  });

  it('room детерминирован по roomId', () => {
    expect(tabId.room('r-01')).toBe('room:r-01');
  });

  it('diff: null — все изменения ветки, иначе один коммит', () => {
    expect(tabId.diff('s-01', null)).toBe('diff:s-01');
    expect(tabId.diff('s-01', 'abc1234')).toBe('diff:s-01:abc1234');
  });

  it('file: корень проекта и worktree дают разный префикс', () => {
    const project: FileRootSpec = { kind: 'project' };
    const worktree: FileRootSpec = { kind: 'worktree', sessionId: 's-01' };
    expect(tabId.file(project, 'src/a.ts')).toBe('file:p:src/a.ts');
    expect(tabId.file(worktree, 'src/a.ts')).toBe('file:w:s-01:src/a.ts');
  });

  it('browser с подставным random детерминирован и не пересекается с другим random', () => {
    expect(tabId.browser(stubRandom())).toBe('browser:012345');
    // другая последовательность — другой id, но тот же формат.
    expect(tabId.browser(() => 0.999999)).toMatch(/^browser:[0-9a-f]{6}$/);
  });
});

describe('nodeId', () => {
  it('с подставным random даёт ожидаемую строку g-xxxxxx', () => {
    expect(nodeId('g', stubRandom())).toBe('g-012345');
  });

  it('с подставным random даёт ожидаемую строку s-xxxxxx', () => {
    expect(nodeId('s', stubRandom())).toBe('s-012345');
  });

  it('без random всё равно даёт форму prefix-6hex (реальный Math.random)', () => {
    expect(nodeId('g')).toMatch(/^g-[0-9a-f]{6}$/);
  });
});
