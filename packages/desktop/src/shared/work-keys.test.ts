import { describe, expect, it } from 'vitest';
import { workKey as treeOrderWorkKey } from '../renderer/lib/tree-order.js';
import { rootKey, workKey } from './work-keys.js';

describe('work-keys (кусок 5.2, тест 16)', () => {
  it('workKey — прежний формат «путь пробел id»', () => {
    expect(workKey('/p/proj', 'w-1')).toBe('/p/proj w-1');
  });

  it('rootKey проекта и worktree разные и несут вид и sessionId', () => {
    const key = workKey('/p/proj', 'w-1');
    const project = rootKey({ workKey: key, spec: { kind: 'project' } });
    const worktree = rootKey({ workKey: key, spec: { kind: 'worktree', sessionId: 's-02' } });
    expect(project).toBe('/p/proj w-1 project');
    expect(worktree).toBe('/p/proj w-1 worktree s-02');
    expect(project).not.toBe(worktree);
  });

  it('lib/tree-order.ts#workKey — та же функция', () => {
    expect(treeOrderWorkKey).toBe(workKey);
  });
});
