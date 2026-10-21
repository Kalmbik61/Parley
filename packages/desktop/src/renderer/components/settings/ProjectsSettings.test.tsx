/**
 * Settings → Projects (спека 2026-10-21, 4.1): список папок с согласием из `trust.list`, кнопка Revoke зовёт
 * `trust.revoke` с этой папкой и перечитывает список.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { S } from '../../../shared/strings.js';
import { ProjectsSettings } from './ProjectsSettings.js';

afterEach(cleanup);

const FOLDERS = [
  { folder: '/Users/me/Desktop/alpha', grantedAt: '2026-10-21T12:00:00.000Z', by: 'window' as const },
  { folder: '/Users/me/Desktop/beta', grantedAt: '2026-10-20T08:30:00.000Z', by: 'telegram' as const },
];

describe('ProjectsSettings', () => {
  it('рисует две папки: путь, дату и откуда выдано согласие', async () => {
    const bridge = createFakeBridge();
    bridge.setTrustFolders(FOLDERS);
    render(<ProjectsSettings bridge={bridge} />);

    const alpha = await screen.findByText('/Users/me/Desktop/alpha');
    const row = alpha.closest('li') as HTMLElement;
    expect(within(row).getByText(/Oct 21, 2026/)).toBeTruthy();
    expect(within(row).getByText(/window/)).toBeTruthy();
    expect(screen.getByText('/Users/me/Desktop/beta')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Revoke/ })).toHaveLength(2);
    expect(screen.getByText(S.settings.projectsHint)).toBeTruthy();
    expect(screen.queryByText(S.settings.projectsEmpty)).toBeNull();
  });

  it('Revoke зовёт trust.revoke с этой папкой, перечитывает список и убирает строку', async () => {
    const bridge = createFakeBridge();
    bridge.setTrustFolders(FOLDERS);
    render(<ProjectsSettings bridge={bridge} />);

    const row = (await screen.findByText('/Users/me/Desktop/alpha')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Revoke/ }));

    await waitFor(() => expect(screen.queryByText('/Users/me/Desktop/alpha')).toBeNull());
    expect(bridge.calls).toContainEqual({ method: 'trust.revoke', params: { folder: '/Users/me/Desktop/alpha' } });
    expect(screen.getByText('/Users/me/Desktop/beta')).toBeTruthy();
    // После отзыва список перечитан у хоста, а не вычеркнут локально: trust.list зван дважды.
    expect(bridge.calls.filter((call) => call.method === 'trust.list')).toHaveLength(2);
  });

  it('пусто — «No trusted folders yet», объяснение остаётся', async () => {
    const bridge = createFakeBridge();
    render(<ProjectsSettings bridge={bridge} />);

    expect(await screen.findByText('No trusted folders yet')).toBeTruthy();
    expect(screen.getByText(/revoking applies to the next launch/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Revoke/ })).toBeNull();
  });

  it('длинный путь сокращается в середине, полный путь — в подсказке', async () => {
    const long = '/Users/me/Desktop/clients/a-very-long-customer-name/projects/the-monorepo-with-a-really-long-directory-name';
    const bridge = createFakeBridge();
    bridge.setTrustFolders([{ folder: long, grantedAt: '2026-10-21T12:00:00.000Z', by: 'island' }]);
    render(<ProjectsSettings bridge={bridge} />);

    const path = await screen.findByTitle(long);
    expect(path.textContent).toContain('…');
    expect(path.textContent?.startsWith('/Users/me')).toBe(true);
    expect(path.textContent?.endsWith('long-directory-name')).toBe(true);
    expect(path.textContent?.length).toBeLessThan(long.length);
  });

  it('отказ хоста при Revoke — сообщение, строка остаётся', async () => {
    const bridge = createFakeBridge();
    bridge.setTrustFolders(FOLDERS);
    bridge.setHandler('trust.revoke', () => {
      throw new Error('boom /private/path');
    });
    render(<ProjectsSettings bridge={bridge} />);

    const row = (await screen.findByText('/Users/me/Desktop/alpha')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Revoke/ }));

    await screen.findByText(/Couldn't revoke trust/);
    expect(screen.getByText('/Users/me/Desktop/alpha')).toBeTruthy();
    expect(document.body.textContent).not.toContain('/private/path');
  });
});
