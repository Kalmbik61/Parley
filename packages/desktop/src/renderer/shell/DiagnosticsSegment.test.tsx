/**
 * Сегмент Diagnostics строки статуса (задача 12 плана диагностики хоста): поповер с двумя кнопками, отсчёт
 * профиля в тексте сегмента, блокировка кнопок до конца сборки, старый хост без `host.diagnostics`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { toast } from 'sonner';
import type { DiagnosticsSaveResult } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { DiagnosticsSegment } from './DiagnosticsSegment.js';
import { resetDiagnosticsFlowForTests } from './diagnostics-flow.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

let bridge: FakeBridge;

const withDiagnostics = [...REQUIRED_METHODS, 'host.diagnostics'];

function setHost(methods: string[]): void {
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.0.0-test', methods } });
}

/** Ответ `app.saveDiagnostics`, который тест завершает сам, — сборка архива «идёт», пока он не вызван. */
function deferredSave(): { finish(result?: DiagnosticsSaveResult): Promise<void> } {
  let resolve: (result: DiagnosticsSaveResult) => void = () => {};
  const pending = new Promise<DiagnosticsSaveResult>((done) => {
    resolve = done;
  });
  vi.spyOn(bridge.app, 'saveDiagnostics').mockImplementation(() => pending);
  return {
    finish: async (result = { file: '/Users/test/Downloads/d.zip', hostResponded: true }) => {
      await act(async () => {
        resolve(result);
        await pending;
      });
    },
  };
}

const trigger = (): HTMLElement => document.querySelector<HTMLElement>('[data-diagnostics-segment]') as HTMLElement;
const saveButton = (): HTMLButtonElement => screen.getByRole('button', { name: S.diagnostics.save }) as HTMLButtonElement;
const profileButton = (): HTMLButtonElement => screen.getByRole('button', { name: S.diagnostics.profile }) as HTMLButtonElement;

function openPopover(): void {
  fireEvent.click(trigger());
}

beforeEach(() => {
  bridge = createFakeBridge();
  window.parley = bridge;
  setHost(withDiagnostics);
});
afterEach(() => {
  cleanup();
  // Сборка, которую тест не довёл до конца, не должна «идти» в следующем тесте (одна сборка за раз на модуль).
  resetDiagnosticsFlowForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(toast).mockClear();
  useHostStore.setState({ status: { state: 'connecting' } });
});

describe('DiagnosticsSegment', () => {
  it('в строке — кнопка data-diagnostics-segment с подписью Diagnostics; поповер открывается над строкой с подсказкой', () => {
    render(<DiagnosticsSegment />);
    expect(trigger().textContent).toBe(S.diagnostics.segment);
    expect(screen.queryByRole('dialog')).toBeNull();

    openPopover();

    expect(screen.getByRole('dialog', { name: S.diagnostics.segment })).toBeTruthy();
    expect(screen.getByText(S.diagnostics.hint)).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
    expect(profileButton().disabled).toBe(false);
  });

  it('подпись скрыта на узком окне: только иконка, подпись — span hidden min-[960px]:inline', () => {
    render(<DiagnosticsSegment />);
    const label = screen.getByText(S.diagnostics.segment);
    expect(label.className).toContain('hidden');
    expect(label.className).toContain('min-[960px]:inline');
    expect(trigger().querySelector('svg')).not.toBeNull();
  });

  it('Save diagnostics зовёт saveDiagnostics({profile:false}) и после ответа возвращает кнопки', async () => {
    render(<DiagnosticsSegment />);
    openPopover();
    const save = deferredSave();

    fireEvent.click(saveButton());

    expect(bridge.app.saveDiagnostics).toHaveBeenCalledTimes(1);
    expect(bridge.app.saveDiagnostics).toHaveBeenCalledWith({ profile: false });
    expect(trigger().textContent).toBe(S.diagnostics.saving);
    expect(saveButton().disabled).toBe(true);
    expect(profileButton().disabled).toBe(true);

    await save.finish();

    expect(trigger().textContent).toBe(S.diagnostics.segment);
    expect(saveButton().disabled).toBe(false);
    expect(profileButton().disabled).toBe(false);
  });

  it('Record profile показывает Profiling 20 s… и через 1 с Profiling 19 s…, кнопки заблокированы', async () => {
    render(<DiagnosticsSegment />);
    openPopover();
    const save = deferredSave();
    vi.useFakeTimers();

    fireEvent.click(profileButton());

    expect(bridge.app.saveDiagnostics).toHaveBeenCalledWith({ profile: true });
    expect(trigger().textContent).toBe('Profiling 20 s…');
    expect(saveButton().disabled).toBe(true);
    expect(profileButton().disabled).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(trigger().textContent).toBe('Profiling 19 s…');
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(trigger().textContent).toBe('Profiling 15 s…');
    // Повторные клики во время записи ничего не запускают.
    fireEvent.click(profileButton());
    fireEvent.click(saveButton());
    expect(bridge.app.saveDiagnostics).toHaveBeenCalledTimes(1);

    await save.finish();

    expect(trigger().textContent).toBe(S.diagnostics.segment);
    expect(profileButton().disabled).toBe(false);
  });

  it('отсчёт дошёл до нуля, а архив ещё собирается — в сегменте Saving…, а не Profiling 0 s…', async () => {
    render(<DiagnosticsSegment />);
    openPopover();
    const save = deferredSave();
    vi.useFakeTimers();

    fireEvent.click(profileButton());
    act(() => {
      vi.advanceTimersByTime(20_000);
    });

    expect(trigger().textContent).toBe(S.diagnostics.saving);
    expect(profileButton().disabled).toBe(true);

    await save.finish();
    expect(trigger().textContent).toBe(S.diagnostics.segment);
  });

  it('таймер отсчёта снимается при размонтировании', () => {
    const { unmount } = render(<DiagnosticsSegment />);
    openPopover();
    deferredSave();
    vi.useFakeTimers();
    const set = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');

    fireEvent.click(profileButton());
    expect(set).toHaveBeenCalledTimes(1);
    const id = set.mock.results[0]?.value as ReturnType<typeof setInterval>;

    unmount();

    expect(clear).toHaveBeenCalledWith(id);
  });

  it('прогресс виден и в поповере (на узком окне подписи сегмента нет): Saving… и Profiling N s…, в idle строки нет', async () => {
    render(<DiagnosticsSegment />);
    openPopover();
    const dialog = screen.getByRole('dialog', { name: S.diagnostics.segment });
    expect(within(dialog).queryByRole('status')).toBeNull();

    const saving = deferredSave();
    fireEvent.click(saveButton());
    expect(within(dialog).getByRole('status').textContent).toBe(S.diagnostics.saving);
    await saving.finish();
    expect(within(dialog).queryByRole('status')).toBeNull();

    const profiling = deferredSave();
    vi.useFakeTimers();
    fireEvent.click(profileButton());
    expect(within(dialog).getByRole('status').textContent).toBe('Profiling 20 s…');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(within(dialog).getByRole('status').textContent).toBe('Profiling 19 s…');
    await profiling.finish();
    expect(within(dialog).queryByRole('status')).toBeNull();
  });

  it('старый хост: кнопка профиля disabled, подсказка hostOutdated видна, Save работает', () => {
    setHost([...REQUIRED_METHODS]);
    render(<DiagnosticsSegment />);
    openPopover();

    expect(profileButton().disabled).toBe(true);
    expect(screen.getByText(S.diagnostics.hostOutdated)).toBeTruthy();
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());
    expect(bridge.saveDiagnosticsCalls).toEqual([{ profile: false }]);
  });

  it('хост отключён: подсказки hostOutdated нет, профиль disabled, Save зовёт saveDiagnostics', () => {
    useHostStore.setState({ status: { state: 'disconnected', reason: 'host gone' } });
    render(<DiagnosticsSegment />);
    openPopover();

    expect(screen.queryByText(S.diagnostics.hostOutdated)).toBeNull();
    expect(profileButton().disabled).toBe(true);
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());
    expect(bridge.saveDiagnosticsCalls).toEqual([{ profile: false }]);
  });

  it('новый хост: подсказки про устаревший хост нет, профиль доступен', () => {
    render(<DiagnosticsSegment />);
    openPopover();
    expect(screen.queryByText(S.diagnostics.hostOutdated)).toBeNull();
    expect(profileButton().disabled).toBe(false);
  });
});
