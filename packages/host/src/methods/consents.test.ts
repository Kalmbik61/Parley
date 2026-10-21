import { mkdtemp, rm } from 'node:fs/promises';
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
