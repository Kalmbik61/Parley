import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPendingSession, createWork, readStoredMap, SYSTEM, transitionSession, updateMap } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { createHeldLaunchActions } from './held-launches.js';
import type { HeldLaunchDeps } from './held-launches.js';
import type { HeldLaunch } from './consents-service.js';

let project = '';

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'parley-held-launches-'));
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Работа с сессией-автором (Claude) и сессией Codex в `pending`, чей запуск удержан. */
async function heldPeer(by?: string): Promise<{ workId: string; caller: string; ref: SessionRef; hold: HeldLaunch }> {
  const work = await createWork(project, { title: 'Работа', goal: '' });
  const caller = await createPendingSession(project, work.work.id, {
    provider: 'claude', label: 'Caller', task: 'Coordinate', parent: null, contextFrom: [],
  });
  const peer = await createPendingSession(project, work.work.id, {
    provider: 'codex', label: 'Peer', task: 'Implement', parent: null, contextFrom: [],
  });
  const ref = { projectPath: project, workId: work.work.id, sessionId: peer };
  return { workId: work.work.id, caller, ref, hold: { ref, mode: 'launch', by: by ?? caller } };
}

function build() {
  const deps = {
    launch: vi.fn<HeldLaunchDeps['launch']>(async () => 'started'),
    // Закрытие — настоящий переход карты, как у `SessionsService.close`.
    close: vi.fn<HeldLaunchDeps['close']>(async (ref) => {
      await updateMap(ref.projectPath, ref.workId, (map) => {
        transitionSession(map, ref.sessionId, 'closed');
      });
    }),
    retry: vi.fn<HeldLaunchDeps['retry']>(),
  };
  return { deps, ...createHeldLaunchActions(deps) };
}

describe('continueLaunch', () => {
  it('новая сессия — обычный запуск от имени того же актёра', async () => {
    const { deps, continueLaunch } = build();
    const { hold } = await heldPeer('s-01');

    await continueLaunch(hold);

    expect(deps.launch).toHaveBeenCalledWith(hold.ref, 'launch', { by: 's-01' });
    expect(deps.retry).not.toHaveBeenCalled();
  });

  it('подъём письмом — через будильник: его письма так и лежат непрочитанными', async () => {
    const { deps, continueLaunch } = build();
    const { ref } = await heldPeer();

    await continueLaunch({ ref, mode: 'resume', by: 'wake' });

    expect(deps.retry).toHaveBeenCalledWith(ref);
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('ручной resume и прерванные после падения хоста — сразу, resume от имени человека', async () => {
    const { deps, continueLaunch } = build();
    const { ref } = await heldPeer();

    await continueLaunch({ ref, mode: 'resume', by: 'human' });

    expect(deps.launch).toHaveBeenCalledWith(ref, 'resume', { by: 'human' });
    expect(deps.retry).not.toHaveBeenCalled();
  });
});

describe('refuseLaunch', () => {
  it('новая сессия агента: итог failed, закрыта, создателю — системное письмо с причиной', async () => {
    const { deps, refuseLaunch } = build();
    const { workId, caller, ref, hold } = await heldPeer();

    await refuseLaunch(hold);

    const map = readStoredMap(project, workId);
    const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
    expect(session).toMatchObject({ lifecycle: 'closed', result: 'failed' });
    const letters = map.messages.filter((message) => message.from === SYSTEM);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ to: [caller], kind: 'note' });
    expect(letters[0]?.text).toContain('launch refused: folder not trusted');
    expect(deps.close).toHaveBeenCalledWith(ref);
  });

  it('запуск человека: сессия закрыта с итогом failed, письма никому нет', async () => {
    const { refuseLaunch } = build();
    const { workId, ref, hold } = await heldPeer('human');

    await refuseLaunch(hold);

    const map = readStoredMap(project, workId);
    expect(map.sessions.find((candidate) => candidate.id === ref.sessionId)).toMatchObject({ lifecycle: 'closed', result: 'failed' });
    expect(map.messages.filter((message) => message.from === SYSTEM)).toEqual([]);
  });

  it('создатель уже закрыт — письма нет, отказ не падает', async () => {
    const { refuseLaunch } = build();
    const { workId, caller, hold } = await heldPeer();
    await updateMap(project, workId, (map) => {
      transitionSession(map, caller, 'closed');
    });

    await refuseLaunch(hold);

    expect((readStoredMap(project, workId)).messages.filter((message) => message.from === SYSTEM)).toEqual([]);
  });

  it('подъём спящей: ничего не делает — письма ждут', async () => {
    const { deps, refuseLaunch } = build();
    const { workId, ref } = await heldPeer();

    await refuseLaunch({ ref, mode: 'resume', by: 'wake' });

    const map = readStoredMap(project, workId);
    expect(map.sessions.find((candidate) => candidate.id === ref.sessionId)?.lifecycle).toBe('pending');
    expect(deps.close).not.toHaveBeenCalled();
  });

  it('сессия уже закрыта или исчезла — без ошибки и без закрытия', async () => {
    const { deps, refuseLaunch } = build();
    const { workId, ref, hold } = await heldPeer();
    await updateMap(project, workId, (map) => {
      transitionSession(map, ref.sessionId, 'closed');
    });

    await refuseLaunch(hold);
    await refuseLaunch({ ...hold, ref: { ...ref, sessionId: 's-99' } });

    expect(deps.close).not.toHaveBeenCalled();
  });
});
