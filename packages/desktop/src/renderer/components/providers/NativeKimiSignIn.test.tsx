import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { useProvidersStore } from '../../store/providers.js';
import { S } from '../../../shared/strings.js';
import { NativeKimiSignIn } from './NativeKimiSignIn.js';
vi.mock('./SignInTerminal.js', () => ({
  SignInTerminal: ({ running }: { running: boolean }) => <div data-running={running} />,
}));
afterEach(cleanup);
it('starts Kimi login, shares running state, cancels and allows retry after exit', async () => {
  const bridge = createFakeBridge();
  window.parley = bridge;
  bridge.setHandler('providers.list', () => ({
    providers: useProvidersStore.getState().providers,
  }));
  bridge.setHandler('providers.signIn', () => ({ ok: true }));
  bridge.setHandler('providers.cancelSignIn', () => ({ ok: true }));
  useProvidersStore.setState({
    providers: [
      {
        id: 'kimi',
        label: 'Kimi',
        available: false,
        needs: 'sign-in',
        version: null,
        limits: null,
        kimiAuth: { signingIn: false },
      },
    ],
    signInResult: {},
    signInOutput: {},
  });
  const stop = useProvidersStore.getState().init(bridge);
  const { container } = render(<NativeKimiSignIn running={false} onReload={async () => {}} />);
  await useProvidersStore.getState().reload();
  fireEvent.click(screen.getByText('kimi.com'));
  await waitFor(() =>
    expect(bridge.calls.some((c) => c.method === 'providers.signIn' && c.params.region === 'mainland-cn')).toBe(true),
  );
  await waitFor(() => expect(container.querySelector('[data-running="true"]')).toBeTruthy());
  fireEvent.click(screen.getByText(S.accounts.cancel));
  await waitFor(() =>
    expect(bridge.calls.some((c) => c.method === 'providers.cancelSignIn')).toBe(true),
  );
  bridge.emit('providers.signInExit', { provider: 'kimi', exitCode: 129, signedIn: false });
  await waitFor(() => expect(screen.getByText(S.accounts.signInFailed)).toBeTruthy());
  fireEvent.click(screen.getByText('kimi.ai'));
  await waitFor(() =>
    expect(bridge.calls.some((c) => c.method === 'providers.signIn' && c.params.region === 'global')).toBe(true),
  );
  stop();
});

it('allows retry after the login process fails to start', async () => {
  const bridge = createFakeBridge();
  window.parley = bridge;
  bridge.setHandler('providers.signIn', () => {
    throw new Error('fixture failure');
  });
  useProvidersStore.setState({
    providers: [
      {
        id: 'kimi',
        label: 'Kimi',
        available: false,
        needs: 'sign-in',
        version: null,
        limits: null,
        kimiAuth: { signingIn: false },
      },
    ],
    signInOutput: {},
    signInResult: {},
  });
  render(<NativeKimiSignIn running={false} onReload={async () => {}} />);
  fireEvent.click(screen.getByText('kimi.ai'));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  fireEvent.click(screen.getByText('kimi.ai'));
  await waitFor(() =>
    expect(bridge.calls.filter((c) => c.method === 'providers.signIn')).toHaveLength(2),
  );
});
