import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConsentCard } from '@parley/protocol';
import type { RequestInfo } from '../context.js';
import type { ConsentsService } from '../consents/consents-service.js';
import { createConsentHandlers } from './consents.js';

let home = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-consent-methods-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const request = { client: {} } as unknown as RequestInfo;
type Call = (params: unknown, info: RequestInfo) => Promise<unknown>;

function build() {
  const card: ConsentCard = {
    id: 'c-01',
    kind: 'folder-trust',
    folder: '/real/p',
    projectPath: '/p',
    requestedBy: { source: 'agent' },
    at: '2026-10-21T10:00:00.000Z',
    state: 'pending',
  };
  const consents = {
    list: vi.fn(() => [card]),
    decide: vi.fn(async () => ({ applied: true, state: 'allowed' as const })),
  } as unknown as ConsentsService;
  const handlers = createConsentHandlers({ consents, home }) as unknown as Record<string, Call>;
  return { consents, handlers, card };
}

it('consents.list отдаёт ждущие карточки сервиса', async () => {
  const { handlers, card } = build();

  expect(await handlers['consents.list']?.({}, request)).toEqual({ items: [card] });
});

it('consents.decide: решение окна и острова пишет доверие от window', async () => {
  const { consents, handlers } = build();

  expect(await handlers['consents.decide']?.({ id: 'c-01', decision: 'allow' }, request)).toEqual({
    applied: true,
    state: 'allowed',
  });
  expect(consents.decide).toHaveBeenCalledWith('c-01', 'allow', 'window');
});

it('consents.decide от моста телефонов (роль remote) пишет доверие от phone — для обоих видов карточек', async () => {
  const { consents, handlers } = build();
  const remote = { client: { role: 'remote' } } as unknown as RequestInfo;

  expect(await handlers['consents.decide']?.({ id: 'c-01', decision: 'allow' }, remote)).toEqual({ applied: true, state: 'allowed' });
  expect(await handlers['consents.decide']?.({ id: 'c-02', decision: 'deny' }, remote)).toEqual({ applied: true, state: 'allowed' });
  expect(consents.decide).toHaveBeenNthCalledWith(1, 'c-01', 'allow', 'phone');
  expect(consents.decide).toHaveBeenNthCalledWith(2, 'c-02', 'deny', 'phone');
});

it('trust.grant → trust.list → trust.revoke: запись в trust.json выбранного дома', async () => {
  const { handlers } = build();
  const folder = await mkdtemp(path.join(tmpdir(), 'parley-consent-folder-'));
  try {
    const granted = (await handlers['trust.grant']?.({ folder, by: 'window' }, request)) as { folder: { folder: string; by: string } };
    expect(granted.folder.by).toBe('window');

    const listed = (await handlers['trust.list']?.({}, request)) as { folders: Array<{ folder: string }> };
    expect(listed.folders.map((item) => item.folder)).toEqual([granted.folder.folder]);

    expect(await handlers['trust.revoke']?.({ folder }, request)).toEqual({ removed: true });
    expect(await handlers['trust.revoke']?.({ folder }, request)).toEqual({ removed: false });
    expect(await handlers['trust.list']?.({}, request)).toEqual({ folders: [] });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it('trust.check: доверена ли папка — по realpath, путь через символическую ссылку та же папка', async () => {
  const { handlers } = build();
  const folder = await mkdtemp(path.join(tmpdir(), 'parley-consent-check-'));
  const link = path.join(home, 'link-to-folder');
  try {
    await symlink(folder, link);
    expect(await handlers['trust.check']?.({ folder }, request)).toEqual({ trusted: false });
    expect(await handlers['trust.check']?.({ folder: link }, request)).toEqual({ trusted: false });

    await handlers['trust.grant']?.({ folder, by: 'window' }, request);
    expect(await handlers['trust.check']?.({ folder }, request)).toEqual({ trusted: true });
    // Хост хранит realpath: путь через ссылку и путь по realpath не различаются.
    expect(await handlers['trust.check']?.({ folder: link }, request)).toEqual({ trusted: true });
    expect(await handlers['trust.check']?.({ folder: await realpath(folder) }, request)).toEqual({ trusted: true });
    expect(await handlers['trust.check']?.({ folder: path.join(folder, 'other') }, request)).toEqual({ trusted: false });

    await handlers['trust.revoke']?.({ folder: link }, request);
    expect(await handlers['trust.check']?.({ folder }, request)).toEqual({ trusted: false });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it('consents.decide с телефона на настоящем сервисе: доверие к папке пишется с by: phone, смена провайдера доходит до switchAgent', async () => {
  const { createConsentsService } = await import('../consents/consents-service.js');
  const { grantTrust, listTrust } = await import('@parley/core');
  const switchAgent = vi.fn(async () => ({ outcome: 'started' }));
  const continueLaunch = vi.fn(async () => {});
  const service = createConsentsService({
    home,
    host: { broadcast: () => {}, log: { info: () => {}, warn: () => {}, error: () => {} } },
    trust: { grant: (folder, by) => grantTrust(folder, by, home) },
    continueLaunch,
    refuseLaunch: async () => {},
    isLive: async () => false,
    switchAgent,
    tellRequester: async () => {},
    noticeFailure: () => {},
  });
  const folder = await mkdtemp(path.join(tmpdir(), 'parley-consent-phone-'));
  try {
    const remote = { client: { role: 'remote' } } as unknown as RequestInfo;
    const handlers = createConsentHandlers({ consents: service, home }) as unknown as Record<string, Call>;
    const hold = { ref: { projectPath: folder, workId: 'w-01', sessionId: 's-02' }, mode: 'launch' as const, by: 'human' };
    const trustCard = service.request({ projectPath: folder, folder: await realpath(folder), requestedBy: { source: 'launch' } }, hold);
    expect(await handlers['consents.decide']?.({ id: trustCard.id, decision: 'allow' }, remote)).toEqual({ applied: true, state: 'allowed' });
    expect(await listTrust(home)).toEqual([expect.objectContaining({ folder: await realpath(folder), by: 'phone' })]);
    await vi.waitFor(() => expect(continueLaunch).toHaveBeenCalledWith(hold));

    const target = { projectPath: '/p', workId: 'w-01', sessionId: 's-03' };
    const switchCard = service.requestSwitch({
      ref: target, provider: 'codex', providerLabel: 'Codex', model: null, reason: 'limit',
      requestedBy: { sessionId: 's-01', label: 'Lead' },
    });
    expect(await handlers['consents.decide']?.({ id: switchCard.id, decision: 'allow' }, remote)).toEqual({ applied: true, state: 'allowed' });
    await vi.waitFor(() => expect(switchAgent).toHaveBeenCalledWith(target, { requestId: switchCard.id, provider: 'codex', force: true, by: 's-01' }));
  } finally {
    service.stop();
    await rm(folder, { recursive: true, force: true });
  }
});

it('A36a: consents.decide project-mcp с телефона: пары доходят до сервиса, решение пишется с by: phone; несовпавшая пара — bad_request', async () => {
  const { createConsentsService } = await import('../consents/consents-service.js');
  const record = vi.fn();
  const continueLaunch = vi.fn(async () => {});
  const service = createConsentsService({
    home,
    host: { broadcast: () => {}, log: { info: () => {}, warn: () => {}, error: () => {} } },
    trust: { grant: async () => undefined },
    projectMcp: { record },
    continueLaunch,
    refuseLaunch: async () => {},
    isLive: async () => false,
    switchAgent: vi.fn(async () => ({ outcome: 'started' })),
    tellRequester: async () => {},
    noticeFailure: () => {},
  });
  try {
    const remote = { client: { role: 'remote' } } as unknown as RequestInfo;
    const handlers = createConsentHandlers({ consents: service, home }) as unknown as Record<string, Call>;
    const fpA = 'a'.repeat(64);
    const fpB = 'b'.repeat(64);
    const hold = { ref: { projectPath: '/repo', workId: 'w-01', sessionId: 's-02' }, mode: 'launch' as const, by: 'human' };
    const card = service.requestProjectMcp(
      {
        projectPath: '/repo',
        repo: '/repo',
        servers: [{ name: 'github', fingerprint: fpA, command: 'npx gh' }, { name: 'files', fingerprint: fpB, command: 'node f' }],
        requestedBy: { source: 'launch' },
      },
      hold,
    );
    await expect(handlers['consents.decide']?.({ id: card.id, decision: 'allow', enabled: [{ name: 'github', fingerprint: fpB }] }, remote)).rejects.toMatchObject({ code: 'bad_request' });
    expect(record).not.toHaveBeenCalled();
    expect(await handlers['consents.decide']?.({ id: card.id, decision: 'allow', enabled: [{ name: 'github', fingerprint: fpA }] }, remote)).toEqual({ applied: true, state: 'allowed' });
    expect(record).toHaveBeenCalledWith('/repo', [
      { name: 'github', fingerprint: fpA, enabled: true },
      { name: 'files', fingerprint: fpB, enabled: false },
    ], 'phone');
    await vi.waitFor(() => expect(continueLaunch).toHaveBeenCalledWith(hold));
  } finally {
    service.stop();
  }
});

it('consents.decide: allow карточки agent-switch из окна доходит до сервиса, который вызывает switchAgent', async () => {
  const { createConsentsService } = await import('../consents/consents-service.js');
  const switchAgent = vi.fn(async () => ({ outcome: 'started' }));
  const service = createConsentsService({
    home,
    host: { broadcast: () => {}, log: { info: () => {}, warn: () => {}, error: () => {} } },
    trust: { grant: async () => undefined },
    continueLaunch: async () => {},
    refuseLaunch: async () => {},
    isLive: async () => false,
    switchAgent,
    tellRequester: async () => {},
    noticeFailure: () => {},
  });
  try {
    const target = { projectPath: '/p', workId: 'w-01', sessionId: 's-03' };
    const card = service.requestSwitch({
      ref: target, provider: 'codex', providerLabel: 'Codex', model: null, reason: 'limit',
      requestedBy: { sessionId: 's-01', label: 'Lead' },
    });
    const handlers = createConsentHandlers({ consents: service, home }) as unknown as Record<string, Call>;
    expect(switchAgent).not.toHaveBeenCalled();
    expect(await handlers['consents.decide']?.({ id: card.id, decision: 'allow' }, request)).toEqual({ applied: true, state: 'allowed' });
    await vi.waitFor(() => expect(switchAgent).toHaveBeenCalledWith(target, { requestId: card.id, provider: 'codex', force: true, by: 's-01' }));
  } finally {
    service.stop();
  }
});
