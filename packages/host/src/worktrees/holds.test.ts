import { describe, expect, it } from 'vitest';
import { refKey, WORKTREE_HOLDS_FEATURE } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import type { Client, ClientRole } from '../client.js';
import { createWorktreeHolds } from './holds.js';

function client(features: string[] = [], role?: ClientRole): Client {
  return {
    id: 'c',
    name: 'c',
    features: new Set(features),
    ...(role === undefined ? {} : { role }),
    send: () => true,
    writableLength: () => 0,
    close: () => {},
  };
}

const a: SessionRef = { projectPath: '/p', workId: 'W01', sessionId: 'S01' };
const b: SessionRef = { projectPath: '/p', workId: 'W01', sessionId: 'S02' };

describe('удержание копий окном', () => {
  it('объединяет удержания двух клиентов', () => {
    const first = client([WORKTREE_HOLDS_FEATURE]);
    const second = client([WORKTREE_HOLDS_FEATURE]);
    const holds = createWorktreeHolds(() => [first, second]);
    holds.set(first, [a]);
    holds.set(second, [b]);
    expect(holds.held()).toEqual(new Set([refKey(a), refKey(b)]));
  });

  it('ушедший клиент больше не держит', () => {
    const first = client([WORKTREE_HOLDS_FEATURE]);
    const second = client([WORKTREE_HOLDS_FEATURE]);
    let connected = [first, second];
    const holds = createWorktreeHolds(() => connected);
    holds.set(first, [a]);
    holds.set(second, [b]);
    connected = [second];
    expect(holds.held()).toEqual(new Set([refKey(b)]));
  });

  it('windowPresent без признака — false', () => {
    const plain = client();
    const holds = createWorktreeHolds(() => [plain]);
    expect(holds.windowPresent()).toBe(false);
  });

  it('клиент с признаком без set — окна нет', () => {
    const window = client([WORKTREE_HOLDS_FEATURE]);
    const holds = createWorktreeHolds(() => [window]);
    expect(holds.windowPresent()).toBe(false);
    holds.set(window, []);
    expect(holds.windowPresent()).toBe(true);
  });

  it('windowPresent не считает телефон с признаком', () => {
    const phone = client([WORKTREE_HOLDS_FEATURE], 'remote');
    const holds = createWorktreeHolds(() => [phone]);
    expect(holds.windowPresent()).toBe(false);
  });
});
