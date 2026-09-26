import { describe, expect, it } from 'vitest';
import type { SessionRef } from '@harnas/protocol';
import { panelId, workKey } from './panel-id.js';

const ref: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-01' };

describe('panelId', () => {
  it('детерминирован: одна и та же сессия даёт один и тот же id', () => {
    const a = panelId({ kind: 'terminal', ref, workKey: workKey(ref.projectPath, ref.workId) });
    const b = panelId({ kind: 'terminal', ref: { ...ref }, workKey: workKey(ref.projectPath, ref.workId) });
    expect(a).toBe(b);
  });

  it('разные виды панели одной и той же работы не пересекаются', () => {
    const key = workKey(ref.projectPath, ref.workId);
    const terminal = panelId({ kind: 'terminal', ref, workKey: key });
    const changes = panelId({ kind: 'changes', ref, workKey: key });
    const mail = panelId({ kind: 'mail', workKey: key });
    const room = panelId({ kind: 'room', workKey: key, roomId: 'r-01' });
    expect(new Set([terminal, changes, mail, room]).size).toBe(4);
  });

  it('terminal/changes без ref — ошибка, room без roomId — ошибка', () => {
    const key = workKey(ref.projectPath, ref.workId);
    expect(() => panelId({ kind: 'terminal', workKey: key })).toThrow();
    expect(() => panelId({ kind: 'changes', workKey: key })).toThrow();
    expect(() => panelId({ kind: 'room', workKey: key })).toThrow();
  });
});
