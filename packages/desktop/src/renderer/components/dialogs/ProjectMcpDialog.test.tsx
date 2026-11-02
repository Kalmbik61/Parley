/** Карточка серверов MCP в окне (спека 2026-11-02, 7): все выключены, «Enable selected» шлёт пары, «Reject all» — deny. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentCard, ProjectMcpCard } from '@parley/protocol';
import { encodeIpcError } from '../../../shared/ipc-error.js';
import { useConsentsStore } from '../../store/consents.js';
import { useUiStore } from '../../store/ui.js';
import { useWorksStore } from '../../store/works.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { ConsentPrompt } from './ConsentPrompt.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const card = (patch: Partial<ProjectMcpCard> = {}): ProjectMcpCard => ({
  id: 'c-07',
  kind: 'project-mcp',
  version: 1, revision: 4,
  repo: '/Users/me/work/my_harnas',
  servers: [
    { name: 'a', fingerprint: 'fa', command: 'node a.js --flag' },
    { name: 'b', fingerprint: 'fb', command: 'https://b.example/mcp' },
  ],
  projectPath: '/Users/me/work/my_harnas',
  requestedBy: { source: 'agent', sessionId: 's-03', workId: 'w-01', label: 'Ruslan' },
  at: '2026-11-02T10:00:00.000Z',
  state: 'pending',
  ...patch,
});

let bridge: FakeBridge;
let dispose: () => void;
const decideCalls = (): Array<Record<string, unknown>> =>
  bridge.calls.filter((call) => call.method === 'consents.decide').map((call) => call.params as Record<string, unknown>);

async function open(c: ConsentCard = card()): Promise<HTMLElement> {
  render(<ConsentPrompt />);
  act(() => bridge.emit('consents.changed', { upsert: [c], removed: [] }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  bridge = createFakeBridge();
  useConsentsStore.setState({ cards: [], asking: null });
  useUiStore.setState({ windowFocused: true, documentVisible: true });
  useWorksStore.setState({ entries: [] });
  dispose = useConsentsStore.getState().init(bridge);
});
afterEach(() => {
  dispose();
  cleanup();
  vi.mocked(toast.error).mockClear();
  useWorksStore.setState(useWorksStore.getInitialState(), true);
});

const toggle = (name: string): HTMLElement => screen.getByRole('switch', { name: `Enable ${name}` });

describe('ProjectMcpDialog', () => {
  it('заголовок с именем репозитория, путь мелко, строка на сервер с описанием моноширинным; всё выключено', async () => {
    const dialog = await open();
    expect(screen.getByText('Enable MCP servers for my_harnas?')).toBeTruthy();
    expect(screen.getByTestId('project-mcp-repo').getAttribute('title')).toBe('/Users/me/work/my_harnas');
    expect(screen.getByText('node a.js --flag').className).toContain('font-mono');
    expect(screen.getByText('node a.js --flag').getAttribute('title')).toBe('node a.js --flag');
    expect(dialog.querySelectorAll('[role="switch"]')).toHaveLength(2);
    expect(toggle('a').getAttribute('aria-checked')).toBe('false');
    expect(toggle('b').getAttribute('aria-checked')).toBe('false');
  });

  it('«Enable selected» шлёт allow с включёнными парами {name, fingerprint}', async () => {
    await open();
    fireEvent.click(toggle('b'));
    fireEvent.click(screen.getByRole('button', { name: 'Enable selected' }));
    await waitFor(() => expect(decideCalls()).toEqual([{ id: 'c-07', decision: 'allow', enabled: [{ name: 'b', fingerprint: 'fb' }], revision: 4 }]));
  });

  it('ничего не включено → allow с пустым списком (сессия стартует без серверов)', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Enable selected' }));
    await waitFor(() => expect(decideCalls()).toEqual([{ id: 'c-07', decision: 'allow', enabled: [], revision: 4 }]));
  });

  it('«Reject all» шлёт deny без списка, даже если что-то включено', async () => {
    await open();
    fireEvent.click(toggle('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Reject all' }));
    await waitFor(() => expect(decideCalls()).toEqual([{ id: 'c-07', decision: 'deny', revision: 4 }]));
  });

  it('хост отказал как устаревшему (bad_request): строка «The server list changed — review again», диалог и карточка остаются', async () => {
    bridge.setHandler('consents.decide', () => {
      throw encodeIpcError({ code: 'bad_request', message: 'Unknown or changed MCP server in the decision' });
    });
    await open();
    fireEvent.click(toggle('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Enable selected' }));
    expect((await screen.findByTestId('project-mcp-stale')).textContent).toBe('The server list changed — review again');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(useConsentsStore.getState().cards).toHaveLength(1);
    expect(useConsentsStore.getState().asking).toBe('c-07');
    expect(toast.error).not.toHaveBeenCalled();
    // Выбор человека сохранён: тот же сервер всё ещё включён.
    expect(toggle('a').getAttribute('aria-checked')).toBe('true');
  });

  it('прочий сбой хоста — тост, без строки про устаревший список', async () => {
    bridge.setHandler('consents.decide', () => {
      throw encodeIpcError({ code: 'internal', message: 'boom' });
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Enable selected' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByTestId('project-mcp-stale')).toBeNull();
  });

  it('карточка обновилась с изменённым сервером: его переключатель снова выключен, остальные не тронуты', async () => {
    await open();
    fireEvent.click(toggle('a'));
    fireEvent.click(toggle('b'));
    act(() => bridge.emit('consents.changed', {
      upsert: [card({ servers: [{ name: 'a', fingerprint: 'fa-NEW', command: 'node a2.js' }, { name: 'b', fingerprint: 'fb', command: 'https://b.example/mcp' }] })],
      removed: [],
    }));
    await waitFor(() => expect(screen.getByText('node a2.js')).toBeTruthy());
    expect(toggle('a').getAttribute('aria-checked')).toBe('false');
    expect(toggle('b').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Enable selected' }));
    await waitFor(() => expect(decideCalls()).toEqual([{ id: 'c-07', decision: 'allow', enabled: [{ name: 'b', fingerprint: 'fb' }], revision: 4 }]));
  });

  it('решение уходит с revision нынешней карточки: после обновления списка — с новой', async () => {
    await open();
    act(() => bridge.emit('consents.changed', {
      upsert: [card({ revision: 5, servers: [...card().servers, { name: 'c', fingerprint: 'fc', command: 'node c.js' }] })],
      removed: [],
    }));
    await waitFor(() => expect(screen.getByText('node c.js')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Reject all' }));
    await waitFor(() => expect(decideCalls()).toEqual([{ id: 'c-07', decision: 'deny', revision: 5 }]));
  });

  it('«Cancel» закрывает диалог, карточка остаётся для острова', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useConsentsStore.getState().cards).toHaveLength(1);
    expect(decideCalls()).toEqual([]);
  });
});
