import { describe, expect, it } from 'vitest';
import type { WorkMap, WorkSession } from '@harnas/core';
import { participantTag } from './participant-tag.js';

function session(id: string, provider: string): WorkSession {
  return {
    id,
    provider,
    label: '',
    task: '',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: 'host',
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
  };
}

function mapWith(sessions: WorkSession[], deletedSessions: string[] = []): WorkMap {
  return {
    schemaVersion: 2,
    rooms: [],
    work: {
      id: 'w-01',
      title: 'Работа',
      goal: '',
      status: 'active',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      deletedSessions,
    },
    sessions,
    messages: [],
  };
}

const providers = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];

describe('participantTag', () => {
  it('известная сессия с моделью — тег и версия семейства', () => {
    const map = mapWith([session('s-01', 'claude')]);
    expect(participantTag(map, 's-01', 'claude-opus-4-20251001', providers)).toBe('S01 (Opus 4)');
  });

  it('codex по подстроке модели независимо от префикса gpt', () => {
    const map = mapWith([session('s-03', 'codex')]);
    expect(participantTag(map, 's-03', 'gpt-5.2-codex', providers)).toBe('S03 (Codex)');
  });

  it('модель ещё неизвестна — подпись провайдера из реестра', () => {
    const map = mapWith([session('s-02', 'codex')]);
    expect(participantTag(map, 's-02', null, providers)).toBe('S02 (Codex)');
  });

  it('провайдера и в реестре нет — его сырой id', () => {
    const map = mapWith([session('s-05', 'glm')]);
    expect(participantTag(map, 's-05', null, providers)).toBe('S05 (glm)');
  });

  it('удалённая сессия', () => {
    const map = mapWith([], ['s-09']);
    expect(participantTag(map, 's-09', null, providers)).toBe('S09 (deleted)');
  });

  it('чужой id — как есть', () => {
    const map = mapWith([]);
    expect(participantTag(map, 'manual-1', null, providers)).toBe('manual-1');
  });

  it('человек — «You», системное письмо — «System»', () => {
    const map = mapWith([]);
    expect(participantTag(map, 'human', null, providers)).toBe('You');
    expect(participantTag(map, 'system', null, providers)).toBe('Parley');
  });
});
