import { it, expect } from 'vitest';
import { createProviderScheduler } from './scheduler.js';
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
it('serializes different action kinds and projects while allowing the other provider to progress', async () => {
  const scheduler = createProviderScheduler(); const gate = deferred(); const order: string[] = [];
  const mcp = scheduler.run('claude', async () => { order.push('MCP project A'); await gate.promise; return 1; });
  const plugin = scheduler.run('claude', async () => { order.push('plugin project B'); return 2; });
  expect(await scheduler.run('codex', async () => { order.push('Codex'); return 3; })).toBe(3);
  expect(order).toEqual(['MCP project A', 'Codex']);
  gate.release(); expect(await mcp).toBe(1); expect(await plugin).toBe(2);
  expect(order).toEqual(['MCP project A', 'Codex', 'plugin project B']); scheduler.dispose();
});
it('cancels active and queued work immediately and suppresses late completion', async () => {
  const scheduler = createProviderScheduler(); const gate = deferred(); let signal!: AbortSignal; let queuedRan = false;
  const running = scheduler.run('claude', async value => { signal = value; await gate.promise; return 'late'; });
  const queued = scheduler.run('claude', async () => { queuedRan = true; return 'queued'; });
  const first = expect(running).rejects.toMatchObject({ code: 'shutdown', message: 'shutdown' });
  const second = expect(queued).rejects.toMatchObject({ code: 'shutdown', message: 'shutdown' });
  scheduler.dispose(); await Promise.all([first, second]); expect(signal.aborted).toBe(true);
  gate.release(); await Promise.resolve(); expect(queuedRan).toBe(false);
  await expect(scheduler.run('codex', async () => 'never')).rejects.toMatchObject({ code: 'shutdown' });
});
it('does not propagate arbitrary thrown secrets and continues the queue after failure', async () => {
  const scheduler = createProviderScheduler();
  const error = await scheduler.run('claude', async () => { throw new Error('SECRET_FIXTURE'); }).catch((value: unknown) => value);
  expect(error).toMatchObject({ message: 'operation-failed', code: 'operation-failed' });
  expect(String(error)).not.toContain('SECRET_FIXTURE');
  expect(await scheduler.run('claude', async () => 'next')).toBe('next'); scheduler.dispose();
});
