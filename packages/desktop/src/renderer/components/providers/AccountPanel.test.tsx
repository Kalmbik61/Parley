/**
 * Форма аккаунта подписки (спека подписок 4.1, 5.5, 10): имя, «Bring from Claude Code», папка, состояние входа,
 * Save / Sign in / Cancel / Sign out / Delete и терминал входа под кнопками. xterm подменён общим фейком.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { encodeIpcError } from '../../../shared/ipc-error.js';
import { S } from '../../../shared/strings.js';
import { REQUIRED_METHODS } from '../../lib/capabilities.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { xtermMock } from '../../test-utils/xterm-mock.js';
import { useHostStore } from '../../store/host.js';
import { useProvidersStore, type ProviderInfo } from '../../store/providers.js';
import { useUiStore } from '../../store/ui.js';
import { AccountPanel } from './AccountPanel.js';

vi.mock('@xterm/xterm', async () => (await import('../../test-utils/xterm-mock.js')).xtermModule);
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const METHODS = [...REQUIRED_METHODS, 'providers.saveCustom', 'providers.deleteCustom', 'providers.authStatus', 'providers.signIn'];
const account = (id = 'custom-claude-2', custom: Record<string, unknown> = {}, patch: Partial<ProviderInfo> = {}): ProviderInfo =>
  ({
    id, label: 'Claude Code 2', available: false, family: 'claude', needs: 'sign-in', version: '2.1.306', limits: null,
    custom: { kind: 'claude-account', link: true, folder: `/Users/me/.parley/providers/${id}`, signedIn: false, signingIn: false, ...custom },
    ...patch,
  }) as ProviderInfo;

let bridge: FakeBridge;
const field = (): HTMLInputElement => screen.getByLabelText(S.accounts.nameField) as HTMLInputElement;
const state = (): HTMLElement => document.querySelector<HTMLElement>('[data-account-state]')!;
const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;

/** Панель, подключённая к стору так же, как её подключает `CustomProviderPanel`. */
function Bound({ id, onSaved = vi.fn(), onDeleted = vi.fn() }: { id: string | null; onSaved?: (id: string) => void; onDeleted?: () => void }): JSX.Element {
  const provider = useProvidersStore((s) => s.providers.find((item) => item.id === id) ?? null);
  return <AccountPanel provider={provider} onSaved={onSaved} onDeleted={onDeleted} />;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  xtermMock.reset();
  bridge = createFakeBridge();
  window.parley = bridge;
  bridge.setHandler('providers.list', () => ({ providers: useProvidersStore.getState().providers }) as never);
  bridge.setHandler('providers.signInResize', () => ({ ok: true }));
  bridge.setHandler('providers.signInInput', () => ({ ok: true }));
  useProvidersStore.setState({ providers: [], signInOutput: {}, signInResult: {}, reload: vi.fn(async () => {}) } as never);
  useUiStore.setState({ settingsProvider: null, settingsSignIn: false });
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.4.0', methods: METHODS }, connections: 1 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useHostStore.setState({ status: { state: 'connecting' } });
});

describe('AccountPanel: новый аккаунт', () => {
  it('имя необязательное: плейсхолдер — стандартное имя, считает окно (первый свободный номер среди custom-claude-N)', () => {
    const { unmount } = render(<AccountPanel provider={null} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    expect(field().value).toBe('');
    expect(field().placeholder).toBe('Claude Code 2');
    unmount();
    useProvidersStore.setState({ providers: [account('custom-claude-2'), account('custom-claude-3', {}, { label: 'Work' })] });
    render(<AccountPanel provider={null} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    expect(field().placeholder).toBe('Claude Code 4');
  });

  it('решение 7: после удалений плейсхолдер следует за slug, который выдаст хост, а не за числом аккаунтов', () => {
    // Живёт один аккаунт — «3»: счёт «число + 2» дал бы тоже «3», а хост выдаст custom-claude-2.
    useProvidersStore.setState({ providers: [account('custom-claude-3')] });
    const { unmount } = render(<AccountPanel provider={null} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    expect(field().placeholder).toBe('Claude Code 2');
    unmount();
    // Живут 2 и 4: свободна тройка.
    useProvidersStore.setState({ providers: [account('custom-claude-2'), account('custom-claude-4')] });
    render(<AccountPanel provider={null} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    expect(field().placeholder).toBe('Claude Code 3');
  });

  it('аккаунт другого вида и свои провайдеры в счёт не входят', () => {
    useProvidersStore.setState({
      providers: [
        account('codex-two', { kind: 'codex-account' }),
        { id: 'custom-kimi', label: 'Kimi', available: true, custom: { preset: null, baseUrl: 'https://a.example.com', auth: 'bearer', models: {}, contextWindow: null, linkClaude: true, folder: '/x' } } as never,
      ],
    });
    render(<AccountPanel provider={null} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    expect(field().placeholder).toBe('Claude Code 2');
  });

  it('галочка «Bring from Claude Code» включена, под ней — подпись про ссылки; подпись про другой аккаунт; папка-заглушка', () => {
    render(<AccountPanel provider={null} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    const bring = screen.getByRole('checkbox', { name: 'Bring from Claude Code' });
    expect(bring.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(S.customProviders.linkClaudeNote)).toBeTruthy();
    expect(screen.getByText('Sign in with a different account than your regular Claude Code; the same account twice gives no extra limit.')).toBeTruthy();
    expect(screen.getByText(/Own Claude Code settings: ~\/\.parley\/providers\/<id>\/ — sign-in, history and memory separate from your regular Claude Code\./)).toBeTruthy();
  });

  it('до сохранения есть только Save: ни Sign in, ни Sign out, ни Delete', () => {
    render(<AccountPanel provider={null} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    expect(button('Save')).toBeTruthy();
    for (const name of ['Sign in', 'Sign out', 'Delete', 'Cancel']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(document.querySelector('[data-account-form="new"]')).toBeTruthy();
    expect(document.querySelector('[data-sign-in-terminal]')).toBeNull();
  });

  it('Save: saveCustom {kind, id: null, label, link}, список перечитывается, onSaved(id)', async () => {
    bridge.setHandler('providers.saveCustom', () => ({ id: 'custom-claude-2' }));
    const reload = vi.fn(async () => {});
    useProvidersStore.setState({ reload } as never);
    const onSaved = vi.fn();
    render(<AccountPanel provider={null} onSaved={onSaved} onDeleted={vi.fn()} />);
    fireEvent.change(field(), { target: { value: '  Work  ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bring from Claude Code' }));
    fireEvent.click(button('Save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('custom-claude-2'));
    expect(bridge.calls).toEqual([{ method: 'providers.saveCustom', params: { kind: 'claude-account', id: null, label: 'Work', link: false } }]);
    expect(reload).toHaveBeenCalled();
  });

  it('пустое имя уходит пустым: стандартное имя выдаёт хост', async () => {
    bridge.setHandler('providers.saveCustom', () => ({ id: 'custom-claude-2' }));
    render(<AccountPanel provider={null} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(button('Save'));
    await waitFor(() => expect(bridge.calls).toHaveLength(1));
    expect(bridge.calls[0]!.params).toMatchObject({ kind: 'claude-account', id: null, label: '' });
  });

  it('отказ хоста — только код ошибки, без текста хоста', async () => {
    bridge.setHandler('providers.saveCustom', () => {
      throw encodeIpcError({ code: 'bad_request', message: 'leak /Users/me/secret' });
    });
    render(<AccountPanel provider={null} onSaved={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(button('Save'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(S.accounts.saveFailed);
    expect(document.body.textContent).not.toContain('secret');
  });
});

describe('AccountPanel: сохранённый аккаунт', () => {
  it('имя — значение поля, не плейсхолдер; папка в строке под полями; форма помечена id', () => {
    useProvidersStore.setState({ providers: [account()] });
    render(<Bound id="custom-claude-2" />);
    expect(field().value).toBe('Claude Code 2');
    expect(screen.getByText('Own Claude Code settings: /Users/me/.parley/providers/custom-claude-2 — sign-in, history and memory separate from your regular Claude Code.')).toBeTruthy();
    expect(document.querySelector('[data-account-form="custom-claude-2"]')).toBeTruthy();
  });

  it('Save шлёт id и прежний link', async () => {
    bridge.setHandler('providers.saveCustom', () => ({ id: 'custom-claude-2' }));
    useProvidersStore.setState({ providers: [account('custom-claude-2', { link: false })] });
    render(<Bound id="custom-claude-2" />);
    expect(screen.getByRole('checkbox', { name: 'Bring from Claude Code' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.change(field(), { target: { value: 'Work' } });
    fireEvent.click(button('Save'));
    await waitFor(() => expect(bridge.calls).toHaveLength(1));
    expect(bridge.calls[0]!.params).toEqual({ kind: 'claude-account', id: 'custom-claude-2', label: 'Work', link: false });
  });

  it('не вошёл: Not signed in, кнопки Sign in и Delete, Sign out нет', () => {
    useProvidersStore.setState({ providers: [account()] });
    render(<Bound id="custom-claude-2" />);
    expect(state().textContent).toBe('Not signed in');
    expect(state().getAttribute('data-account-state')).toBe('not-signed-in');
    expect(button('Sign in')).toBeTruthy();
    expect(button('Delete')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('вход ещё не проверен (null): состояние «Checking…», войти можно', () => {
    useProvidersStore.setState({ providers: [account('custom-claude-2', { signedIn: null })] });
    render(<Bound id="custom-claude-2" />);
    expect(state().textContent).toBe('Checking…');
    expect(state().getAttribute('data-account-state')).toBe('unknown');
    expect(button('Sign in')).toBeTruthy();
  });

  it('CLI старше минимума (needs: cli): форма называет требование, а не «Checking…»; Sign in и Sign out нет', () => {
    useProvidersStore.setState({ providers: [account('custom-claude-2', { signedIn: null }, { needs: 'cli', version: '2.1.302' })] });
    render(<Bound id="custom-claude-2" />);
    expect(state().textContent).toBe('Claude Code 2 requires Claude Code 2.1.304 or newer');
    expect(state().getAttribute('data-account-state')).toBe('needs-cli');
    expect(document.body.textContent).not.toContain('Checking…');
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    // Имя, ссылки и удаление доступны и без CLI.
    expect(button('Save')).toBeTruthy();
    expect(button('Delete')).toBeTruthy();
  });

  it('needs: cli и settingsSignIn: вход не начинается', () => {
    useProvidersStore.setState({ providers: [account('custom-claude-2', {}, { needs: 'cli', version: null })] });
    useUiStore.setState({ settingsProvider: 'custom-claude-2', settingsSignIn: true });
    render(<Bound id="custom-claude-2" />);
    expect(bridge.calls.filter((call) => call.method === 'providers.signIn')).toHaveLength(0);
    expect(document.querySelector('[data-sign-in-terminal]')).toBeNull();
  });

  it('вошёл: Signed in, подпись из providers.authStatus (почта и план), кнопка Sign out вместо Sign in', async () => {
    bridge.setHandler('providers.authStatus', () => ({ signedIn: true, detail: 'me@example.test · max' }));
    useProvidersStore.setState({ providers: [account('custom-claude-2', { signedIn: true }, { available: true, needs: null })] });
    render(<Bound id="custom-claude-2" />);
    expect(state().textContent).toBe('Signed in');
    expect(state().getAttribute('data-account-state')).toBe('signed-in');
    expect(await screen.findByText('me@example.test · max')).toBeTruthy();
    expect(bridge.calls[0]).toEqual({ method: 'providers.authStatus', params: { provider: 'custom-claude-2' } });
    expect(button('Sign out')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('не вошёл: providers.authStatus не зовётся', () => {
    useProvidersStore.setState({ providers: [account()] });
    render(<Bound id="custom-claude-2" />);
    expect(bridge.calls.filter((call) => call.method === 'providers.authStatus')).toHaveLength(0);
  });

  it('Sign out зовёт providers.signOut и перечитывает список', async () => {
    bridge.setHandler('providers.authStatus', () => ({ signedIn: true, detail: null }));
    bridge.setHandler('providers.signOut', () => ({ ok: true }));
    const reload = vi.fn(async () => {});
    useProvidersStore.setState({ providers: [account('custom-claude-2', { signedIn: true })], reload } as never);
    render(<Bound id="custom-claude-2" />);
    fireEvent.click(button('Sign out'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(bridge.calls.map((call) => call.method)).toContain('providers.signOut');
    expect(bridge.calls.find((call) => call.method === 'providers.signOut')!.params).toEqual({ provider: 'custom-claude-2' });
  });
});

describe('AccountPanel: вход', () => {
  it('Sign in зовёт providers.signIn, показывает терминал, а кнопка становится Cancel', async () => {
    bridge.setHandler('providers.signIn', () => ({ ok: true }));
    useProvidersStore.setState({ providers: [account()] });
    render(<Bound id="custom-claude-2" />);
    expect(document.querySelector('[data-sign-in-terminal]')).toBeNull();
    fireEvent.click(button('Sign in'));
    expect(document.querySelector('[data-sign-in-terminal]')).toBeTruthy();
    expect(xtermMock.terminals).toHaveLength(1);
    expect(button('Cancel')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'providers.signIn')).toBe(true));
    expect(bridge.calls.find((call) => call.method === 'providers.signIn')!.params).toEqual({ provider: 'custom-claude-2' });
    expect(state().textContent).toBe('Signing in…');
  });

  it('вывод входа попадает в терминал; повторный Sign in начинает терминал заново', async () => {
    bridge.setHandler('providers.signIn', () => ({ ok: true }));
    useProvidersStore.setState({ providers: [account()] });
    const dispose = useProvidersStore.getState().init(bridge);
    useProvidersStore.setState({ providers: [account()] });
    render(<Bound id="custom-claude-2" />);
    fireEvent.click(button('Sign in'));
    act(() => bridge.emit('providers.signInOutput', { provider: 'custom-claude-2', data: 'Open https://example.test\r\n' }));
    expect(xtermMock.terminals[0]!.writes).toContain('Open https://example.test\r\n');
    act(() => bridge.emit('providers.signInExit', { provider: 'custom-claude-2', exitCode: 129, signedIn: false }));
    await waitFor(() => expect(button('Sign in')).toBeTruthy());
    fireEvent.click(button('Sign in'));
    expect(xtermMock.terminals).toHaveLength(2);
    expect(xtermMock.terminals[1]!.writes).toEqual([]);
    dispose();
  });

  it('вход идёт при открытии (Settings закрыли и открыли): терминал сразу, с накопленным выводом, и Cancel', () => {
    useProvidersStore.setState({
      providers: [account('custom-claude-2', { signingIn: true })],
      signInOutput: { 'custom-claude-2': 'Open https://example.test/login\r\n' },
    });
    render(<Bound id="custom-claude-2" />);
    expect(document.querySelector('[data-sign-in-terminal]')).toBeTruthy();
    expect(xtermMock.terminals[0]!.writes).toEqual(['Open https://example.test/login\r\n']);
    expect(button('Cancel')).toBeTruthy();
    expect(bridge.calls.filter((call) => call.method === 'providers.signIn')).toHaveLength(0);
  });

  it('Cancel зовёт providers.cancelSignIn', async () => {
    bridge.setHandler('providers.cancelSignIn', () => ({ ok: true }));
    useProvidersStore.setState({ providers: [account('custom-claude-2', { signingIn: true })] });
    render(<Bound id="custom-claude-2" />);
    fireEvent.click(button('Cancel'));
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'providers.cancelSignIn')).toBe(true));
    expect(bridge.calls.find((call) => call.method === 'providers.cancelSignIn')!.params).toEqual({ provider: 'custom-claude-2' });
  });

  it('выход процесса: терминал остаётся, под ним итог входа; список перечитывается', async () => {
    useProvidersStore.setState({ providers: [account('custom-claude-2', { signingIn: true })] });
    const dispose = useProvidersStore.getState().init(bridge);
    bridge.setHandler('providers.list', () => ({ providers: [account('custom-claude-2', { signedIn: true }, { available: true, needs: null })] }) as never);
    bridge.setHandler('providers.authStatus', () => ({ signedIn: true, detail: null }));
    render(<Bound id="custom-claude-2" />);
    act(() => bridge.emit('providers.signInExit', { provider: 'custom-claude-2', exitCode: 0, signedIn: true }));
    const result = await waitFor(() => {
      const found = document.querySelector('[data-sign-in-result]');
      if (found === null) throw new Error('нет итога');
      return found;
    });
    expect(result.textContent).toBe(S.accounts.signInDone);
    expect(document.querySelector('[data-sign-in-terminal]')).toBeTruthy();
    await waitFor(() => expect(state().textContent).toBe('Signed in'));
    dispose();
  });

  it('вход не удался: итог «не завершён»', async () => {
    useProvidersStore.setState({ providers: [account('custom-claude-2', { signingIn: true })] });
    const dispose = useProvidersStore.getState().init(bridge);
    render(<Bound id="custom-claude-2" />);
    act(() => bridge.emit('providers.signInExit', { provider: 'custom-claude-2', exitCode: 129, signedIn: false }));
    expect((await screen.findByText(S.accounts.signInFailed)).getAttribute('data-sign-in-result')).not.toBeNull();
    dispose();
  });

  it('отказ providers.signIn — код ошибки под формой и список перечитывается', async () => {
    bridge.setHandler('providers.signIn', () => {
      throw encodeIpcError({ code: 'internal', message: 'leak /Users/me/secret' });
    });
    const reload = vi.fn(async () => {});
    useProvidersStore.setState({ providers: [account()], reload } as never);
    render(<Bound id="custom-claude-2" />);
    fireEvent.click(button('Sign in'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(S.accounts.signInStartFailed);
    expect(alert.textContent).toContain('host error');
    expect(document.body.textContent).not.toContain('secret');
    expect(reload).toHaveBeenCalled();
  });

  it('второй Sign in при входе другого аккаунта (conflict): понятный текст вместо «conflicting state»', async () => {
    bridge.setHandler('providers.signIn', () => {
      throw encodeIpcError({ code: 'conflict', message: 'another sign-in is running' });
    });
    useProvidersStore.setState({ providers: [account()] });
    render(<Bound id="custom-claude-2" />);
    fireEvent.click(button('Sign in'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Another account is signing in — finish or cancel it first.');
    expect(alert.textContent).toBe(S.accounts.signInBusy);
  });

  it('терминал входа выводится на виду: scrollIntoView при появлении (800×500)', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      bridge.setHandler('providers.signIn', () => ({ ok: true }));
      useProvidersStore.setState({ providers: [account()] });
      render(<Bound id="custom-claude-2" />);
      expect(scroll).not.toHaveBeenCalled();
      fireEvent.click(button('Sign in'));
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
      // Прокручивается рамка терминала целиком, а не только его внутренняя область: иначе нижний край рамки остаётся обрезан.
      expect((scroll.mock.contexts[0] as HTMLElement).hasAttribute('data-sign-in-terminal')).toBe(true);
    } finally {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('Sign in из карточки (settingsSignIn): вход начинается сам, один раз, флаг снимается', async () => {
    bridge.setHandler('providers.signIn', () => ({ ok: true }));
    useProvidersStore.setState({ providers: [account()] });
    useUiStore.setState({ settingsProvider: 'custom-claude-2', settingsSignIn: true });
    render(<Bound id="custom-claude-2" />);
    await waitFor(() => expect(bridge.calls.filter((call) => call.method === 'providers.signIn')).toHaveLength(1));
    expect(useUiStore.getState().settingsSignIn).toBe(false);
    expect(document.querySelector('[data-sign-in-terminal]')).toBeTruthy();
  });

  it('settingsSignIn чужого провайдера или у вошедшего аккаунта вход не запускает', () => {
    useProvidersStore.setState({ providers: [account('custom-claude-2', { signedIn: true })] });
    bridge.setHandler('providers.authStatus', () => ({ signedIn: true, detail: null }));
    useUiStore.setState({ settingsProvider: 'custom-claude-2', settingsSignIn: true });
    const { unmount } = render(<Bound id="custom-claude-2" />);
    unmount();
    useProvidersStore.setState({ providers: [account('custom-claude-3')] });
    useUiStore.setState({ settingsProvider: 'custom-claude-2', settingsSignIn: true });
    render(<Bound id="custom-claude-3" />);
    expect(bridge.calls.filter((call) => call.method === 'providers.signIn')).toHaveLength(0);
  });
});

describe('AccountPanel: удаление', () => {
  it('Delete спрашивает подтверждение; «Also delete its folder» выключена по умолчанию', async () => {
    bridge.setHandler('providers.deleteCustom', () => ({ ok: true }));
    const onDeleted = vi.fn();
    useProvidersStore.setState({ providers: [account()] });
    render(<Bound id="custom-claude-2" onDeleted={onDeleted} />);
    fireEvent.click(button('Delete'));
    expect(bridge.calls).toHaveLength(0);
    expect(screen.getByRole('checkbox', { name: 'Also delete its folder' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Also delete its folder' }));
    fireEvent.click(button(S.customProviders.deleteConfirmButton));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(bridge.calls[0]).toEqual({ method: 'providers.deleteCustom', params: { id: 'custom-claude-2', removeFolder: true } });
  });

  it('папка с живыми сессиями (conflict): текст про сессии вместо «conflicting state», форма остаётся', async () => {
    bridge.setHandler('providers.deleteCustom', () => {
      throw encodeIpcError({ code: 'conflict', message: 'Claude Code 2 has running sessions: stop them before deleting its folder' });
    });
    const onDeleted = vi.fn();
    useProvidersStore.setState({ providers: [account()] });
    render(<Bound id="custom-claude-2" onDeleted={onDeleted} />);
    fireEvent.click(button('Delete'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Also delete its folder' }));
    fireEvent.click(button(S.customProviders.deleteConfirmButton));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('This account has running sessions — stop them before deleting its folder.');
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe('AccountPanel: правки ревью задачи 8', () => {
  const inputs = (): unknown[] => bridge.calls.filter((call) => call.method === 'providers.signInInput').map((call) => call.params);

  it('после выхода процесса набранное в терминале на хост не уходит', async () => {
    useProvidersStore.setState({ providers: [account('custom-claude-2', { signingIn: true })] });
    const dispose = useProvidersStore.getState().init(bridge);
    render(<Bound id="custom-claude-2" />);
    act(() => xtermMock.terminals[0]!.onDataHandler?.('code\r'));
    expect(inputs()).toEqual([{ provider: 'custom-claude-2', data: 'code\r' }]);
    act(() => bridge.emit('providers.signInExit', { provider: 'custom-claude-2', exitCode: 0, signedIn: true }));
    await screen.findByText(S.accounts.signInDone);
    act(() => xtermMock.terminals[0]!.onDataHandler?.('late\r'));
    expect(inputs()).toHaveLength(1);
    dispose();
  });

  it('Sign out после входа убирает и терминал, и итог входа: «Signed in.» не остаётся рядом с Not signed in', async () => {
    bridge.setHandler('providers.signOut', () => ({ ok: true }));
    bridge.setHandler('providers.authStatus', () => ({ signedIn: true, detail: null }));
    const signedOut = account('custom-claude-2', { signedIn: false });
    const reload = vi.fn(async () => {
      useProvidersStore.setState({ providers: [signedOut] });
    });
    useProvidersStore.setState({ providers: [account('custom-claude-2', { signingIn: true })], reload } as never);
    const dispose = useProvidersStore.getState().init(bridge);
    bridge.setHandler('providers.list', () => ({ providers: [account('custom-claude-2', { signedIn: true }, { available: true, needs: null })] }) as never);
    render(<Bound id="custom-claude-2" />);
    act(() => bridge.emit('providers.signInOutput', { provider: 'custom-claude-2', data: 'Open https://example.test\r\n' }));
    act(() => bridge.emit('providers.signInExit', { provider: 'custom-claude-2', exitCode: 0, signedIn: true }));
    await screen.findByText(S.accounts.signInDone);
    await waitFor(() => expect(state().textContent).toBe('Signed in'));
    fireEvent.click(button('Sign out'));
    await waitFor(() => expect(state().textContent).toBe('Not signed in'));
    expect(document.querySelector('[data-sign-in-result]')).toBeNull();
    expect(document.querySelector('[data-sign-in-terminal]')).toBeNull();
    expect(useProvidersStore.getState().signInOutput['custom-claude-2']).toBeUndefined();
    dispose();
  });

  it('удаление аккаунта стирает его накопленный вывод входа', async () => {
    bridge.setHandler('providers.deleteCustom', () => ({ ok: true }));
    useProvidersStore.setState({ providers: [account()], signInOutput: { 'custom-claude-2': 'old output' } });
    render(<Bound id="custom-claude-2" />);
    fireEvent.click(button('Delete'));
    fireEvent.click(button(S.customProviders.deleteConfirmButton));
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'providers.deleteCustom')).toBe(true));
    await waitFor(() => expect(useProvidersStore.getState().signInOutput['custom-claude-2']).toBeUndefined());
  });

  it('новый аккаунт: сохранён, а список не перечитался — повторный Save правит его, а не создаёт второй', async () => {
    bridge.setHandler('providers.saveCustom', () => ({ id: 'custom-claude-2' }));
    const reload = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('список не пришёл'))
      .mockResolvedValue(undefined);
    useProvidersStore.setState({ reload } as never);
    const onSaved = vi.fn();
    render(<AccountPanel provider={null} onSaved={onSaved} onDeleted={vi.fn()} />);
    fireEvent.click(button('Save'));
    await screen.findByRole('alert');
    fireEvent.click(button('Save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('custom-claude-2'));
    const saves = bridge.calls.filter((call) => call.method === 'providers.saveCustom');
    expect(saves.map((call) => (call.params as { id: string | null }).id)).toEqual([null, 'custom-claude-2']);
  });

  it('вид записи берётся у сохранённого аккаунта, а не зашит в форме', async () => {
    bridge.setHandler('providers.saveCustom', () => ({ id: 'codex-two' }));
    useProvidersStore.setState({ providers: [account('codex-two', { kind: 'codex-account' })] });
    render(<Bound id="codex-two" />);
    fireEvent.click(button('Save'));
    await waitFor(() => expect(bridge.calls).toHaveLength(1));
    expect(bridge.calls[0]!.params).toMatchObject({ kind: 'codex-account', id: 'codex-two' });
  });

  it('вход начался — фокус в терминале', () => {
    bridge.setHandler('providers.signIn', () => ({ ok: true }));
    useProvidersStore.setState({ providers: [account()] });
    render(<Bound id="custom-claude-2" />);
    fireEvent.click(button('Sign in'));
    expect(xtermMock.callsOf('focus')).toHaveLength(1);
  });
});
