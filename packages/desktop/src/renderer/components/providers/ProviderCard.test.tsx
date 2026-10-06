/** Подключение провайдеров: секрет остаётся в поле, ошибки не отражают текст хоста. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProviderCheck, Result } from '@parley/protocol';
import { encodeIpcError } from '../../../shared/ipc-error.js';
import { S } from '../../../shared/strings.js';
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
const AT = '2026-10-05T09:30:00.000Z';
beforeEach(() => {
  bridge = createFakeBridge();
  window.parley = bridge;
  // Хост отвечает «провайдер не готов» — тесты, которым важен исход, ставят свой.
  bridge.setHandler('providers.check', () => ({ check: null }));
  copy = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  useHostStore.setState({
    status: {
      state: 'connected',
      hostVersion: '0.4.0',
      methods: [...REQUIRED_METHODS, 'providers.setKey', 'providers.clearKey', 'providers.check'],
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
    // Сохранение и сразу проверка ключа: два перечитывания, тестовое сообщение между ними.
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    expect(input.value).toBe('');
    expect(bridge.calls.map((call) => call.method)).toEqual(['providers.setKey', 'providers.check']);
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
    // Замена тоже запускает проверку: ждём её конца, иначе поле ещё занято спиннером.
    await waitFor(() => expect(props.onReload).toHaveBeenCalledTimes(2));
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


describe('ProviderCard: проверка ключа GLM тестовым сообщением', () => {
  const ready = (patch: Partial<Provider> = {}): Provider =>
    glm({ available: true, needs: null, keyHint: '••••1234', ...patch });

  it('Check again: видимая проверка, затем Connected и время — даже если снимок списка ещё старый', async () => {
    let answer: (value: { check: ProviderCheck | null }) => void = () => {};
    bridge.setHandler('providers.check', () => new Promise((resolve) => { answer = resolve; }));
    const reload = vi.fn(async () => {});
    render(<ProviderCard provider={ready()} onReload={reload} onRestartHost={() => {}} />);
    expect(screen.getByText('Not verified')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true'));
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Checking…');
    expect(button.querySelector('svg.animate-spin')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Sending a test request to Z.ai');
    expect(screen.queryByText('Connected')).toBeNull();
    answer({ check: { state: 'ok', at: AT } });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('false'));
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Test request OK · checked');
    expect(bridge.calls).toEqual([{ method: 'providers.check', params: { provider: 'glm' } }]);
  });

  it.each([
    ['authentication', 401, '1000', 'Key rejected', 'Z.ai rejected the saved key'],
    ['plan_expired', 429, '1309', 'Plan expired', 'GLM Coding Plan has expired'],
    ['no_plan', 429, '1113', 'No active plan', 'no active GLM Coding Plan'],
    ['limit_reached', 429, '1308', 'Limit reached', '5-hour or weekly limit'],
    ['model_unavailable', 429, '1311', 'Model not in plan', "doesn't include GLM-5.3"],
    ['key_restricted', 403, '1220', 'Key restricted', 'restricts this key'],
    ['rate_limited', 429, '1302', 'Z.ai busy', 'Try again in a minute'],
    ['server_error', 500, undefined, 'Z.ai error', 'server error'],
    ['unsupported_response', 200, undefined, 'Unexpected answer', 'unexpected format'],
  ] as const)('исход %s из снимка: подпись в шапке, подсказка и HTTP · code', (reason, httpStatus, code, label, hint) => {
    const check: ProviderCheck = { state: 'failed', reason, httpStatus, ...(code === undefined ? {} : { code }), at: AT };
    render(<ProviderCard provider={ready({ check })} onReload={async () => {}} onRestartHost={() => {}} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText('Connected')).toBeNull();
    const line = screen.getByRole('status').textContent ?? '';
    expect(line).toContain(hint);
    expect(line).toContain(code === undefined ? `HTTP ${httpStatus} · checked` : `HTTP ${httpStatus} · code ${code} · checked`);
  });

  it.each([
    ['timeout', 'No answer', "didn't answer in time"],
    ['network', 'No connection', 'VPN or proxy'],
  ] as const)('без ответа Z.ai (%s): подпись и подсказка, без HTTP', (reason, label, hint) => {
    render(<ProviderCard provider={ready({ check: { state: 'failed', reason, at: AT } })} onReload={async () => {}} onRestartHost={() => {}} />);
    expect(screen.getByText(label)).toBeTruthy();
    const line = screen.getByRole('status').textContent ?? '';
    expect(line).toContain(hint);
    expect(line).not.toContain('HTTP');
  });

  it('незнакомая окну причина (хост новее окна) читается как «незнакомый ответ», а не пустая строка', () => {
    const check = { state: 'failed', reason: 'future_reason', at: AT } as unknown as ProviderCheck;
    render(<ProviderCard provider={ready({ check })} onReload={async () => {}} onRestartHost={() => {}} />);
    expect(screen.getByText('Unexpected answer')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('unexpected format');
  });

  it('вчерашняя проверка показывает дату, сегодняшняя — только время', () => {
    const today = new Date();
    today.setHours(9, 30, 0, 0);
    // Календарный день назад, а не 24 часа: в день перехода на летнее время часы сдвинулись бы.
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const { rerender } = render(
      <ProviderCard provider={ready({ check: { state: 'ok', at: today.toISOString() } })} onReload={async () => {}} onRestartHost={() => {}} />,
    );
    expect(screen.getByRole('status').textContent).toBe('Test request OK · checked 9:30 AM');
    rerender(
      <ProviderCard provider={ready({ check: { state: 'ok', at: yesterday.toISOString() } })} onReload={async () => {}} onRestartHost={() => {}} />,
    );
    const month = yesterday.toLocaleString('en-US', { month: 'short' });
    expect(screen.getByRole('status').textContent).toBe(`Test request OK · checked ${month} ${yesterday.getDate()}, 9:30 AM`);
  });

  it('новый ключ требует своей проверки: прежний ответ этой карточки не показывается', async () => {
    bridge.setHandler('providers.check', () => ({ check: { state: 'ok', at: AT } }));
    const reload = vi.fn(async () => {});
    const { rerender } = render(<ProviderCard provider={ready()} onReload={reload} onRestartHost={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy());
    rerender(<ProviderCard provider={ready({ keyHint: '••••5678' })} onReload={reload} onRestartHost={() => {}} />);
    expect(screen.queryByText('Connected')).toBeNull();
    expect(screen.getByText('Not verified')).toBeTruthy();
  });

  it('снимок новее ответа карточки (проверило другое окно) — побеждает снимок', async () => {
    bridge.setHandler('providers.check', () => ({ check: { state: 'ok', at: AT } }));
    const reload = vi.fn(async () => {});
    const { rerender } = render(<ProviderCard provider={ready()} onReload={reload} onRestartHost={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy());
    const later: ProviderCheck = { state: 'failed', reason: 'limit_reached', httpStatus: 429, code: '1308', at: '2026-10-05T09:40:00.000Z' };
    rerender(<ProviderCard provider={ready({ check: later })} onReload={reload} onRestartHost={() => {}} />);
    expect(screen.getByText('Limit reached')).toBeTruthy();
  });

  it('провайдер не готов локально: хост отвечает null, строки проверки нет, шапка Not connected', async () => {
    const reload = vi.fn(async () => {});
    render(<ProviderCard provider={glm({ needs: 'cli', version: null, keyHint: '••••1234' })} onReload={reload} onRestartHost={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('отказ хоста: безопасный текст по коду, без сырого сообщения; повтор возможен', async () => {
    bridge.setHandler('providers.check', () => {
      throw encodeIpcError({ code: 'internal', message: 'fixture-secret in host text' });
    });
    const reload = vi.fn(async () => {});
    render(<ProviderCard provider={ready()} onReload={reload} onRestartHost={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain("Couldn't check the GLM key");
    expect(error.textContent).not.toContain('fixture-secret');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('Check again с набранным ключом: сохраняет его, как Save, и сразу проверяет', async () => {
    bridge.setHandler('providers.setKey', () => ({ keyHint: '••••9999' }));
    bridge.setHandler('providers.check', () => ({
      check: { state: 'failed', reason: 'authentication', httpStatus: 401, code: '1000', at: AT },
    }));
    const reload = vi.fn(async () => {});
    render(<ProviderCard provider={glm()} onReload={reload} onRestartHost={() => {}} />);
    const field = screen.getByLabelText('Z.ai API key') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'fake-key-9999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    expect(bridge.calls).toEqual([
      { method: 'providers.setKey', params: { provider: 'glm', key: 'fake-key-9999' } },
      { method: 'providers.check', params: { provider: 'glm' } },
    ]);
    expect(field.value).toBe('');
  });

  it('Check again с полем из одних пробелов ключ не сохраняет — только проверка', async () => {
    const reload = vi.fn(async () => {});
    render(<ProviderCard provider={ready()} onReload={reload} onRestartHost={() => {}} />);
    fireEvent.change(screen.getByLabelText('Z.ai API key'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(bridge.calls).toEqual([{ method: 'providers.check', params: { provider: 'glm' } }]);
  });

  it('ключ не сохранён: карточка говорит об этом прямо, а не только Not connected', () => {
    const { rerender } = render(<ProviderCard provider={glm()} onReload={async () => {}} onRestartHost={() => {}} />);
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.getByText(/No key saved/)).toBeTruthy();
    rerender(<ProviderCard provider={ready()} onReload={async () => {}} onRestartHost={() => {}} />);
    expect(screen.queryByText(/No key saved/)).toBeNull();
  });

  it('старый хост без providers.check: прежний локальный перечит, шапка по готовности', async () => {
    useHostStore.setState({
      status: { state: 'connected', hostVersion: '0.5.1', methods: [...REQUIRED_METHODS, 'providers.setKey', 'providers.clearKey'] },
    });
    const reload = vi.fn(async () => {});
    render(<ProviderCard provider={ready()} onReload={reload} onRestartHost={() => {}} />);
    expect(screen.getByText('Connected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(bridge.calls).toEqual([]);
  });
});

it('GLM показывает подтверждённую квоту Z.ai в существующей карточке', () => {
  render(<ProviderCard provider={glm({ available: true, limits: {
    source: 'zai', fiveHour: { usedPercent: 42.9, resetsAt: null }, week: null, at: '2026-10-03T00:00:00Z',
  } })} onReload={async () => {}} onRestartHost={() => {}} />);
  expect(screen.getByText('42% 5h')).toBeTruthy();
});

describe('ProviderCard: аргументы запуска из providers.json (нормалайзер модели и effort 2026-10-06, 5.9)', () => {
  const codex = (patch: Partial<Provider> = {}): Provider => ({ id: 'codex', label: 'Codex', available: true, version: 'codex-cli 0.160.0', ...patch });
  const renderCard = (provider: Provider): void => {
    render(<ProviderCard provider={provider} onReload={async () => {}} onRestartHost={() => {}} />);
  };

  it('args заменены и в них нет {model} и {effort} — строка про providers.json и почему выбора нет', () => {
    renderCard(codex({ argsOverridden: true, models: null, effort: false }));
    expect(screen.getByText('Launch arguments come from providers.json.')).toBeTruthy();
    expect(screen.getByText('No model choice: it needs {model} in these arguments and a models list.')).toBeTruthy();
    expect(screen.getByText('No effort choice: these arguments have no {effort}.')).toBeTruthy();
  });

  it('в args {model} может быть, но списка моделей нет (models null) — причина про список, а не про отсутствие {model}', () => {
    renderCard(codex({ argsOverridden: true, models: null, effort: true }));
    expect(screen.getByText('No model choice: it needs {model} in these arguments and a models list.')).toBeTruthy();
    expect(screen.queryByText('No model choice: these arguments have no {model}.')).toBeNull();
    expect(screen.queryByText(S.providerCard.noEffortChoice)).toBeNull();
  });

  it('args заменены, выбор есть — только строка про providers.json', () => {
    renderCard(codex({ argsOverridden: true, models: [{ id: 'gpt-6-luna', label: 'GPT-6-Luna' }], effort: true }));
    expect(screen.getByText(S.providerCard.argsOverridden)).toBeTruthy();
    expect(screen.queryByText(S.providerCard.noModelChoice)).toBeNull();
    expect(screen.queryByText(S.providerCard.noEffortChoice)).toBeNull();
  });

  it('модель есть, effort нет — объяснение только про effort', () => {
    renderCard(codex({ argsOverridden: true, models: [{ id: 'gpt-6-luna', label: 'GPT-6-Luna' }], effort: false }));
    expect(screen.queryByText(S.providerCard.noModelChoice)).toBeNull();
    expect(screen.getByText(S.providerCard.noEffortChoice)).toBeTruthy();
  });

  it('встроенные args (поля нет — и у старого хоста) — ни строки, ни объяснений, даже без выбора', () => {
    renderCard(codex({ models: null, effort: false }));
    expect(screen.queryByTestId('provider-args')).toBeNull();
    expect(screen.queryByText(S.providerCard.noModelChoice)).toBeNull();
    expect(screen.queryByText(S.providerCard.noEffortChoice)).toBeNull();
  });
});
