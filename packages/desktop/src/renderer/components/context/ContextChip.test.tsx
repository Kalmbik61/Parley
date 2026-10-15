import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { SessionRef } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { useHostStore } from '../../store/host.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { ContextChip, type ContextChipProps } from './ContextChip.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const ref: SessionRef = { projectPath: '/p', workId: 'w-01', sessionId: 's-01' };
const FILL = { usedPercent: 82.4, windowTokens: 200_000, usedTokens: 164_800, at: '2026-10-15T10:00:00.000Z' };
const DEFAULT = 'Focus on room "Auth": keep decisions.';
let bridge: FakeBridge;

beforeEach(() => {
  bridge = createFakeBridge();
  bridge.setHandler('sessions.compact', () => ({ state: 'started' }));
  bridge.setHandler('sessions.cancelCompact', () => ({ cancelled: true }));
  useHostStore.setState({
    status: { state: 'connected', hostVersion: 'fixture', methods: ['sessions.compact', 'sessions.cancelCompact'] },
    connections: 1,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const props = (patch: Partial<ContextChipProps> = {}): ContextChipProps => ({
  bridge,
  sessionRef: ref,
  provider: 'claude',
  label: 'S01 backend',
  running: true,
  context: FILL,
  compaction: null,
  defaultInstructions: DEFAULT,
  testId: 'ctx',
  ...patch,
});
const compactCalls = () => bridge.calls.filter((call) => call.method === 'sessions.compact');

describe('ContextChip (спека 3.2, 3.4)', () => {
  it('процент и уровень по порогам', () => {
    const { rerender } = render(<ContextChip {...props()} />);
    expect(screen.getByTestId('ctx').textContent).toBe('82%');
    expect(screen.getByTestId('ctx').dataset.level).toBe('warn');
    rerender(<ContextChip {...props({ context: { ...FILL, usedPercent: 85 } })} />);
    expect(screen.getByTestId('ctx').dataset.level).toBe('critical');
    rerender(<ContextChip {...props({ context: { ...FILL, usedPercent: 59.4 } })} />);
    expect(screen.getByTestId('ctx').dataset.level).toBe('normal');
  });

  it('состояния сжатия и «нет данных»', () => {
    const { rerender } = render(<ContextChip {...props({ compaction: 'pending' })} />);
    expect(screen.getByTestId('ctx').textContent).toBe('⏳');
    rerender(<ContextChip {...props({ compaction: 'running' })} />);
    expect(screen.getByTestId('ctx').textContent).toBe('…');
    rerender(<ContextChip {...props({ context: null, compaction: 'compacted' })} />);
    expect(screen.getByTestId('ctx').textContent).toBe('compacted');
    rerender(<ContextChip {...props({ context: null })} />);
    expect(screen.getByTestId('ctx').textContent).toBe('—');
  });

  it('спящая сессия или хост без поля context — чипа нет', () => {
    const { rerender } = render(<ContextChip {...props({ running: false })} />);
    expect(screen.queryByTestId('ctx')).toBeNull();
    rerender(<ContextChip {...props({ context: undefined, compaction: undefined })} />);
    expect(screen.queryByTestId('ctx')).toBeNull();
  });

  it('Compact — sessions.compact с правленой инструкцией', async () => {
    render(<ContextChip {...props()} />);
    fireEvent.click(screen.getByTestId('ctx'));
    const field = screen.getByTestId('compact-instructions') as HTMLTextAreaElement;
    expect(field.value).toBe(DEFAULT);
    expect(field.maxLength).toBe(350);
    fireEvent.change(field, { target: { value: 'Keep the API decisions' } });
    fireEvent.click(screen.getByTestId('compact-submit'));
    await waitFor(() =>
      expect(compactCalls()).toEqual([{ method: 'sessions.compact', params: { ref, instructions: 'Keep the API decisions' } }]),
    );
  });

  it('пустое поле — instructions: null; Codex — поле неактивно и null', async () => {
    const { unmount } = render(<ContextChip {...props()} />);
    fireEvent.click(screen.getByTestId('ctx'));
    fireEvent.change(screen.getByTestId('compact-instructions'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('compact-submit'));
    await waitFor(() => expect(compactCalls().at(-1)?.params).toEqual({ ref, instructions: null }));
    unmount();

    render(<ContextChip {...props({ provider: 'codex' })} />);
    fireEvent.click(screen.getByTestId('ctx'));
    expect((screen.getByTestId('compact-instructions') as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText(S.context.codexNoFocus)).toBeTruthy();
    fireEvent.click(screen.getByTestId('compact-submit'));
    await waitFor(() => expect(compactCalls().at(-1)?.params).toEqual({ ref, instructions: null }));
  });

  it('ждёт — Cancel зовёт cancelCompact; идёт — кнопка неактивна', async () => {
    const { unmount } = render(<ContextChip {...props({ compaction: 'pending' })} />);
    fireEvent.click(screen.getByTestId('ctx'));
    fireEvent.click(screen.getByTestId('compact-cancel'));
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'sessions.cancelCompact')).toBe(true));
    unmount();

    render(<ContextChip {...props({ compaction: 'running' })} />);
    fireEvent.click(screen.getByTestId('ctx'));
    expect((screen.getByTestId('compact-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('хост без sessions.compact — числа есть, формы нет', () => {
    useHostStore.setState({ status: { state: 'connected', hostVersion: 'fixture', methods: [] }, connections: 1 });
    render(<ContextChip {...props()} />);
    fireEvent.click(screen.getByTestId('ctx'));
    expect(screen.getByTestId('ctx-popover').textContent).toContain('82%');
    expect(screen.queryByTestId('compact-submit')).toBeNull();
  });

  it('отказ unknown-screen — тост с причиной', async () => {
    bridge.setHandler('sessions.compact', () => ({ state: 'refused', reason: 'unknown-screen' }));
    render(<ContextChip {...props()} />);
    fireEvent.click(screen.getByTestId('ctx'));
    fireEvent.click(screen.getByTestId('compact-submit'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(S.context.refusedUnknownScreen('S01 backend')));
  });
});
