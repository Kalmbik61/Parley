/**
 * Оверлей basic-auth: поля, Enter, Esc, строка ошибки при повторе, прокси-пометка.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BrowserAuthRequest } from '../../shared/basic-auth.js';
import { AUTH_FIELD_LIMIT, AuthPrompt } from './AuthPrompt.js';

afterEach(cleanup);

const REQUEST: BrowserAuthRequest = { requestId: 'r1', webContentsId: 7, host: '127.0.0.1:8080', realm: 'Stand', isProxy: false, retry: false };

describe('AuthPrompt', () => {
  it('показывает хост и realm, фокус на логине; Sign in отдаёт логин и пароль', () => {
    const onSubmit = vi.fn();
    render(<AuthPrompt request={REQUEST} onSubmit={onSubmit} />);
    expect(screen.getByTestId('browser-auth-host').textContent).toContain('127.0.0.1:8080');
    expect(screen.getByText('Realm: Stand')).toBeTruthy();
    const user = screen.getByLabelText('Username') as HTMLInputElement;
    expect(document.activeElement).toBe(user);
    fireEvent.change(user, { target: { value: 'admin' } });
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    expect(password.type).toBe('password');
    fireEvent.change(password, { target: { value: 'pw' } });
    fireEvent.submit(screen.getByRole('dialog'));
    expect(onSubmit).toHaveBeenCalledWith({ username: 'admin', password: 'pw' });
  });

  it('Esc и Cancel — отмена (null)', () => {
    const onSubmit = vi.fn();
    render(<AuthPrompt request={REQUEST} onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByLabelText('Username'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSubmit).toHaveBeenNthCalledWith(1, null);
    expect(onSubmit).toHaveBeenNthCalledWith(2, null);
  });

  it('повтор показывает ошибку и очищает пароль; прокси помечен', () => {
    const { rerender } = render(<AuthPrompt request={REQUEST} onSubmit={vi.fn()} />);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'bad' } });
    rerender(<AuthPrompt request={{ ...REQUEST, requestId: 'r2', retry: true, isProxy: true }} onSubmit={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toBe('Wrong username or password. Try again.');
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('Proxy')).toBeTruthy();
  });

  it('поля ограничены теми же 1024 знаками, что и ответ в main', () => {
    render(<AuthPrompt request={REQUEST} onSubmit={vi.fn()} />);
    expect(AUTH_FIELD_LIMIT).toBe(1024);
    expect(screen.getByLabelText('Username').getAttribute('maxlength')).toBe('1024');
    expect(screen.getByLabelText('Password').getAttribute('maxlength')).toBe('1024');
  });

  it('failed — строка «Couldn\'t send the credentials», вместо строки неверного пароля', () => {
    render(<AuthPrompt request={{ ...REQUEST, retry: true }} failed onSubmit={vi.fn()} />);
    const alerts = screen.getAllByRole('alert').map((node) => node.textContent);
    expect(alerts).toEqual(["Couldn't send the credentials. Try again or cancel."]);
  });
});
