import { describe, expect, it } from 'vitest';
import type { SessionRef } from '@harnas/protocol';
import { panelId, specFromPanelId, workKey, type PanelSpec } from './panel-id.js';

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

describe('specFromPanelId', () => {
  it('обращает panelId для всех видов, включая путь с пробелом', () => {
    const ref = { projectPath: '/tmp/мой проект', workId: 'w-0001', sessionId: 's-03' };
    const key = workKey(ref.projectPath, ref.workId);
    const specs: PanelSpec[] = [
      { kind: 'terminal', ref, workKey: key },
      { kind: 'changes', ref, workKey: key },
      { kind: 'mail', workKey: key },
      { kind: 'room', workKey: key, roomId: 'r-02' },
    ];
    for (const spec of specs) expect(specFromPanelId(panelId(spec))).toEqual(spec);
  });

  it('чужой id — null', () => {
    expect(specFromPanelId('что-то')).toBeNull();
    expect(specFromPanelId('terminal:без-разделителей')).toBeNull();
  });
});
