import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionProcess, SessionProcessesSnapshot, SessionRef } from '@parley/protocol';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { ChatToolbar } from './ChatToolbar.js';
import { SessionProcessesChip } from './SessionProcessesChip.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const OTHER: SessionRef = { ...REF, sessionId: 's-02' };

const proc = (pid: number, name = 'sleep', extra: Partial<SessionProcess> = {}): SessionProcess => ({
  pid, name, elapsed: '00:12', cpuPct: 1.5, memPct: 0.1, rssKb: 20480, ...extra,
});
const snap = (revision: number, processes: SessionProcess[], extra: Partial<SessionProcessesSnapshot> = {}, ref = REF): SessionProcessesSnapshot => ({
  ref, revision, available: true, approximate: false, processes, ...extra,
});

let bridge: FakeBridge;

const callsOf = (method: string): unknown[] => bridge.calls.filter((c) => c.method === method).map((c) => c.params);
const flush = (): Promise<void> => act(async () => { await Promise.resolve(); });
const emit = (data: SessionProcessesSnapshot): void => { act(() => bridge.emit('processes.changed', data)); };

function connect(methods: string[] = [...REQUIRED_METHODS, 'processes.subscribe', 'processes.unsubscribe']): void {
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.0.0-test', methods }, connections: 1 });
}

beforeEach(() => {
  bridge = createFakeBridge();
  bridge.setHandler('processes.subscribe', ({ ref }) => snap(1, [], { available: false }, ref));
  bridge.setHandler('processes.unsubscribe', () => ({ ok: true }));
  connect();
});

afterEach(() => {
  cleanup();
  useHostStore.setState({ status: { state: 'connecting' }, connections: 0 });
  vi.restoreAllMocks();
});

const renderChip = (active = true, ref: SessionRef = REF) =>
  render(<SessionProcessesChip bridge={bridge} sessionRef={ref} active={active} />);

describe('SessionProcessesChip — подписка', () => {
  it('подписывается на активной вкладке и отписывается при размонтировании', async () => {
    const view = renderChip();
    await flush();
    expect(callsOf('processes.subscribe')).toEqual([{ ref: REF }]);
    view.unmount();
    expect(callsOf('processes.unsubscribe')).toEqual([{ ref: REF }]);
  });

  it('вкладка неактивна — подписки нет; стала неактивной — отписка', async () => {
    const view = renderChip(false);
    await flush();
    expect(callsOf('processes.subscribe')).toEqual([]);
    view.rerender(<SessionProcessesChip bridge={bridge} sessionRef={REF} active />);
    await flush();
    expect(callsOf('processes.subscribe')).toHaveLength(1);
    view.rerender(<SessionProcessesChip bridge={bridge} sessionRef={REF} active={false} />);
    expect(callsOf('processes.unsubscribe')).toEqual([{ ref: REF }]);
  });

  it('смена сессии вкладки: отписка от старой и подписка на новую', async () => {
    const view = renderChip();
    await flush();
    view.rerender(<SessionProcessesChip bridge={bridge} sessionRef={OTHER} active />);
    await flush();
    expect(callsOf('processes.unsubscribe')).toEqual([{ ref: REF }]);
    expect(callsOf('processes.subscribe')).toEqual([{ ref: REF }, { ref: OTHER }]);
  });

  it('переподключение к хосту подписывает заново', async () => {
    renderChip();
    await flush();
    act(() => useHostStore.setState({ status: { state: 'disconnected' } }));
    act(() => connect());
    useHostStore.setState({ connections: 2 });
    await flush();
    expect(callsOf('processes.subscribe').length).toBeGreaterThanOrEqual(2);
  });

  it('снимок чужой сессии игнорируется', async () => {
    renderChip();
    await flush();
    emit(snap(5, [proc(1)], {}, OTHER));
    expect(screen.queryByTestId('chat-processes')).toBeNull();
  });
});

describe('SessionProcessesChip — ревизии', () => {
  it('устаревшая ревизия отбрасывается', async () => {
    renderChip();
    await flush();
    emit(snap(5, [proc(1), proc(2)]));
    emit(snap(4, [proc(1)]));
    expect(screen.getByTestId('chat-processes').textContent).toBe('2 shell');
    emit(snap(5, [proc(1)]));
    expect(screen.getByTestId('chat-processes').textContent).toBe('2 shell');
    emit(snap(6, [proc(1), proc(2), proc(3)]));
    expect(screen.getByTestId('chat-processes').textContent).toBe('3 shell');
  });

  it('новая подписка сбрасывает принятую ревизию: перезапущенный хост начинает счёт заново', async () => {
    const view = renderChip();
    await flush();
    emit(snap(500, [proc(1), proc(2)]));
    view.rerender(<SessionProcessesChip bridge={bridge} sessionRef={REF} active={false} />);
    bridge.setHandler('processes.subscribe', ({ ref }) => snap(1, [proc(9)], {}, ref));
    view.rerender(<SessionProcessesChip bridge={bridge} sessionRef={REF} active />);
    await flush();
    expect(screen.getByTestId('chat-processes').textContent).toBe('1 shell');
    emit(snap(2, [proc(9), proc(10)]));
    expect(screen.getByTestId('chat-processes').textContent).toBe('2 shell');
  });
});

describe('SessionProcessesChip — когда чипа нет и ошибок нет', () => {
  it('not_found при подписке: чипа нет, в консоль ничего не выводится', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.setHandler('processes.subscribe', () => { throw new Error('not_found: no live PTY for session s-01'); });
    renderChip();
    await flush();
    expect(screen.queryByTestId('chat-processes')).toBeNull();
    expect(document.body.textContent).not.toContain('not_found');
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('старый хост без processes.subscribe: ни вызовов, ни чипа', async () => {
    connect([...REQUIRED_METHODS]);
    renderChip();
    await flush();
    expect(callsOf('processes.subscribe')).toEqual([]);
    expect(screen.queryByTestId('chat-processes')).toBeNull();
  });

  it('available: false и ноль процессов — чипа нет', async () => {
    renderChip();
    await flush();
    emit(snap(2, [], { available: false }));
    expect(screen.queryByTestId('chat-processes')).toBeNull();
    emit(snap(3, []));
    expect(screen.queryByTestId('chat-processes')).toBeNull();
  });
});

describe('SessionProcessesChip — список', () => {
  async function opened(processes: SessionProcess[], extra: Partial<SessionProcessesSnapshot> = {}): Promise<void> {
    renderChip();
    await flush();
    emit(snap(2, processes, extra));
    fireEvent.click(screen.getByTestId('chat-processes'));
  }

  it('в строке имя, время и метрики; число в чипе — длина списка', async () => {
    await opened([proc(1, 'sleep'), proc(2, 'docker', { cpuPct: null, rssKb: null })]);
    const rows = screen.getAllByTestId('processes-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toBe('sleep00:121.5% CPU20 MB');
    expect(rows[1]?.textContent).toBe('docker00:12');
    expect(screen.getByTestId('chat-processes').textContent).toBe('2 shell');
    expect(screen.queryByTestId('processes-approximate')).toBeNull();
  });

  it('Codex: список помечен приблизительным', async () => {
    await opened([proc(1)], { approximate: true });
    expect(screen.getByTestId('processes-approximate').textContent).toBe('Approximate list: it may include Codex helper processes and miss some commands.');
  });

  it('ни title, ни подсказок: ничего, кроме безопасных полей', async () => {
    await opened([proc(1, 'a-very-long-process-name')]);
    expect(document.querySelectorAll('[title]')).toHaveLength(0);
    expect(screen.getByTestId('chat-processes').getAttribute('title')).toBeNull();
    const popover = screen.getByTestId('processes-popover');
    expect(popover.textContent).not.toMatch(/--|\/|token|SECRET/i);
  });

  it('пока список раскрыт, чип не исчезает: пустое и недоступное состояния', async () => {
    await opened([proc(1)]);
    emit(snap(3, []));
    expect(screen.getByTestId('chat-processes').textContent).toBe('0 shell');
    expect(screen.getByTestId('processes-empty').textContent).toBe('No running processes');
    emit(snap(4, [], { available: false }));
    expect(screen.getByTestId('processes-unavailable').textContent).toBe('Process list unavailable');
    expect(screen.getByTestId('chat-processes')).toBeTruthy();
  });

  it('доступность: роль и подпись у кнопки и списка, список прокручивается', async () => {
    await opened([proc(1)]);
    const chip = screen.getByTestId('chat-processes');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.getAttribute('aria-label')).toBe('1 running process in this session');
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('list', { name: 'Running processes' });
    expect(list.className).toContain('overflow-y-auto');
  });

  it('после закрытия списка с нулём процессов чип исчезает', async () => {
    await opened([proc(1)]);
    emit(snap(3, []));
    fireEvent.click(screen.getByTestId('chat-processes'));
    expect(screen.queryByTestId('chat-processes')).toBeNull();
  });
});

describe('ChatToolbar — чип процессов', () => {
  it('чип стоит в тулбаре, когда передан processes и есть процессы; без пропа — нет', async () => {
    const view = render(<ChatToolbar workKey="k" tabId="t" view="terminal" available provider="claude" processes={{ bridge, sessionRef: REF, active: true }} />);
    await flush();
    emit(snap(2, [proc(1)]));
    expect(screen.getByTestId('chat-processes').textContent).toBe('1 shell');
    view.rerender(<ChatToolbar workKey="k" tabId="t" view="terminal" available provider="claude" />);
    expect(screen.queryByTestId('chat-processes')).toBeNull();
  });
});
