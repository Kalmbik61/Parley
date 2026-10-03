/** Подключение провайдеров: секрет остаётся в поле, ошибки не отражают текст хоста. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Result } from '@parley/protocol';
import { encodeIpcError } from '../../../shared/ipc-error.js';
import { useHostStore } from '../../store/host.js';
import { useProvidersStore } from '../../store/providers.js';
import { REQUIRED_METHODS } from '../../lib/capabilities.js';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { ProviderCard } from './ProviderCard.js';

type Provider = Result<'providers.list'>['providers'][number];
const glm = (patch: Partial<Provider> = {}): Provider => ({
  id: 'glm',
  label: 'GLM',
  available: false,
  family: 'claude',
  needs: 'key',
  keyHint: null,
  version: '2.1.287',
  ...patch,
});
let bridge: ReturnType<typeof createFakeBridge>;
let copy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  bridge = createFakeBridge();
  window.parley = bridge;
  copy = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  useHostStore.setState({
    status: {
      state: 'connected',
      hostVersion: '0.4.0',
      methods: [...REQUIRED_METHODS, 'providers.setKey', 'providers.clearKey'],
    },
    connections: 1,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useHostStore.setState({ status: { state: 'connecting' } });
});

describe('ProviderCard', () => {
  it.each([
    [
      'claude',
      'Claude Code',
      'curl -fsSL https://claude.ai/install.sh | bash',
      'https://code.claude.com/docs/en/setup',
    ],
    [
      'codex',
      'Codex',
      'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      'https://learn.chatgpt.com/docs/codex/cli',
    ],
  ])(
    'отсутствующий %s: только официальная команда, ссылки, вход в терминале и Check again',
    async (id, label, command, docs) => {
      const reload = vi.fn(async () => {});
      render(
        <ProviderCard
          provider={{ id, label, available: false }}
          onReload={reload}
          onRestartHost={() => {}}
        />,
      );
      expect(screen.getByText(command)).toBeTruthy();
      expect(screen.getByText(/Sign-in happens in the agent's terminal/)).toBeTruthy();
      expect(screen.getByText(/Quit Parley/).textContent).toContain('PATH');
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      await waitFor(() => expect(copy).toHaveBeenCalledWith(command));
      fireEvent.click(screen.getByRole('button', { name: 'Installation guide' }));
      await waitFor(() => expect(bridge.externalOpened).toContain(docs));
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(bridge.calls).toEqual([]);
    },
  );

  it('GLM разрешает сохранить ключ до установки CLI и объясняет минимум версии и Coding Plan', async () => {
    bridge.setHandler('providers.setKey', () => ({ keyHint: '••••1234' }));
    const reload = vi.fn(async () => {});
    render(
      <ProviderCard
        provider={glm({ needs: 'cli', version: null })}
        onReload={reload}
        onRestartHost={() => {}}
      />,
    );
    expect(screen.getByText(/Requires an active GLM Coding Plan/)).toBeTruthy();
    expect(screen.getByText(/2\.1\.287/)).toBeTruthy();
    const input = screen.getByLabelText('Z.ai API key') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'fixture-key-1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(input.value).toBe('');
    expect(bridge.calls).toContainEqual({
      method: 'providers.setKey',
      params: { provider: 'glm', key: 'fixture-key-1234' },
    });
    expect(JSON.stringify(useProvidersStore.getState())).not.toContain('fixture-key');
    fireEvent.click(screen.getByRole('button', { name: 'Get a key' }));
    await waitFor(() =>
      expect(bridge.externalOpened).toContain('https://z.ai/manage-apikey/apikey-list'),
    );
  });

  it('hint не означает готовность: несовместимый runner остаётся Not connected, доступны Replace и Remove', async () => {
    bridge.setHandler('providers.clearKey', () => ({ ok: true }));
    const reload = vi.fn(async () => {});
    render(
      <ProviderCard
        provider={glm({ needs: null, keyHint: '••••1234' })}
        onReload={reload}
        onRestartHost={() => {}}
      />,
    );
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.getByText('Key ••••1234')).toBeTruthy();
    expect(screen.getByText(/shared local Claude Code sign-in/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(bridge.calls).toContainEqual({
      method: 'providers.clearKey',
      params: { provider: 'glm' },
    });
  });

  it('Replace сохраняет новый ключ; поле очищается после сохранения и закрытия, даже без размонтирования', async () => {
    bridge.setHandler('providers.setKey', () => ({ keyHint: '••••5678' }));
    const props = {
      provider: glm({ available: true, needs: null, keyHint: '••••1234' }),
      onReload: vi.fn(async () => {}),
      onRestartHost: () => {},
    };
    const { rerender, unmount } = render(<ProviderCard {...props} />);
    const field = () => screen.getByLabelText('Z.ai API key') as HTMLInputElement;
    fireEvent.change(field(), { target: { value: 'fixture-key-5678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(props.onReload).toHaveBeenCalledTimes(1));
    expect(field().value).toBe('');
    fireEvent.change(field(), { target: { value: 'unsaved-fixture' } });
    rerender(<ProviderCard {...props} open={false} />);
    rerender(<ProviderCard {...props} open />);
    expect(field().value).toBe('');
    fireEvent.change(field(), { target: { value: 'unmounted-fixture' } });
    unmount();
    render(<ProviderCard {...props} />);
    expect(field().value).toBe('');
  });

  it('ошибка сохранения безопасна и позволяет повторить запрос; сырой текст и ключ не отображаются', async () => {
    bridge.setHandler('providers.setKey', () => {
      throw encodeIpcError({ code: 'bad_request', message: 'fixture-secret in host text' });
    });
    const reload = vi.fn(async () => {});
    render(<ProviderCard provider={glm()} onReload={reload} onRestartHost={() => {}} />);
    const input = screen.getByLabelText('Z.ai API key') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'fixture-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('invalid request');
    expect(error.textContent).not.toContain('fixture-secret');
    expect(input.value).toBe('fixture-secret');
    expect(reload).not.toHaveBeenCalled();
    bridge.setHandler('providers.setKey', () => ({ keyHint: '••••cret' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('старый хост: Restart host вместо неизвестных key RPC, включая хост лишь с одним методом', () => {
    useHostStore.setState({
      status: {
        state: 'connected',
        hostVersion: '0.4.0',
        methods: ['providers.list', 'providers.setKey'],
      },
    });
    const restart = vi.fn();
    render(
      <form>
        <ProviderCard
          provider={glm({ keyHint: '••••1234' })}
          onReload={async () => {}}
          onRestartHost={restart}
        />
      </form>,
    );
    expect(screen.queryByLabelText('Z.ai API key')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restart host' }));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(bridge.calls).toEqual([]);
    for (const button of screen.getAllByRole('button'))
      expect(button.getAttribute('type')).toBe('button');
  });

  it('GLM не показывает лимиты Claude и не отражает немаскированный hint', () => {
    render(
      <ProviderCard
        provider={glm({
          available: true,
          keyHint: 'unexpected-plaintext',
          limits: {
            fiveHour: { usedPercent: 91, resetsAt: '2026-10-04T00:00:00Z' },
            week: null,
            at: '2026-10-03T00:00:00Z',
          },
        })}
        onReload={async () => {}}
        onRestartHost={() => {}}
      />,
    );
    expect(screen.queryByText(/91%/)).toBeNull();
    expect(screen.queryByText(/unexpected-plaintext/)).toBeNull();
    expect(screen.getByText('Key ••••')).toBeTruthy();
  });
});
