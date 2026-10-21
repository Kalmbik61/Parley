/**
 * Диалог доверия к папке (спека 2026-10-21, 4.2 п. 1): заголовок «Trust <папка> for agents?» с сокращением середины
 * длинного пути, текст про `.codex/`, `workspace-write` и отзыв в Settings → Projects, кнопки Trust / Cancel.
 * «Trust» зовёт `onTrust` и не зовёт `onCancel`, закрытие любым другим способом — только `onCancel`.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../../shared/strings.js';
import { TrustFolderDialog } from './TrustFolderDialog.js';

afterEach(cleanup);

const FOLDER = '/Users/me/Desktop/proj';

function mount(patch: Partial<Parameters<typeof TrustFolderDialog>[0]> = {}): { onTrust: () => void; onCancel: () => void } {
  const onTrust = vi.fn();
  const onCancel = vi.fn();
  render(<TrustFolderDialog open folder={FOLDER} onTrust={onTrust} onCancel={onCancel} {...patch} />);
  return { onTrust, onCancel };
}

describe('TrustFolderDialog', () => {
  it('заголовок с папкой, текст про .codex/, workspace-write и Settings → Projects', () => {
    mount();
    const dialog = screen.getByRole('dialog');
    expect(screen.getByText(`Trust ${FOLDER} for agents?`)).toBeTruthy();
    expect(dialog.textContent).toContain('.codex/');
    expect(dialog.textContent).toContain('workspace-write');
    expect(dialog.textContent).toContain('Settings → Projects');
    expect(dialog.textContent).toContain('Claude Code');
  });

  it('длинный путь в заголовке сокращается по середине, полный — в title', () => {
    const long = `/Users/me/Desktop/${'very-long-directory-name/'.repeat(6)}project`;
    mount({ folder: long });
    const title = screen.getByRole('heading');
    expect(title.textContent).toContain('…');
    expect(title.textContent).not.toContain(long);
    expect(title.getAttribute('title')).toBe(long);
  });

  it('кто просил — строка в начале текста; без requestedBy её нет', () => {
    mount({ requestedBy: 'S03 Ruslan · create_session' });
    expect(screen.getByRole('dialog').textContent).toContain('Requested by S03 Ruslan · create_session.');
    cleanup();
    mount();
    expect(screen.getByRole('dialog').textContent).not.toContain('Requested by');
  });

  it('Trust — onTrust, и закрытие после него не считается отменой', () => {
    const { onTrust, onCancel } = mount();
    fireEvent.click(screen.getByRole('button', { name: S.dialogs.trustFolder.confirm }));
    expect(onTrust).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Cancel — onCancel, onTrust не зовётся', () => {
    const { onTrust, onCancel } = mount();
    fireEvent.click(screen.getByRole('button', { name: S.common.cancel }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onTrust).not.toHaveBeenCalled();
  });

  it('Esc — тоже отмена', () => {
    const { onTrust, onCancel } = mount();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onTrust).not.toHaveBeenCalled();
  });

  it('закрытый диалог ничего не рисует', () => {
    mount({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
