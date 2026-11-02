/** Строка обновления CLI в Settings → Providers (спека 2026-11-02, P1): есть обновление / нет / идёт / итог / пропуск. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { encodeIpcError } from '../../../shared/ipc-error.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import type { ProviderInfo } from '../../store/providers.js';
import { ProviderUpdateRow } from './ProviderUpdateRow.js';

const codex = (patch: Partial<ProviderInfo> = {}): ProviderInfo =>
  ({
    id: 'codex', label: 'Codex', available: true, family: null, needs: null, version: '0.162.0', limits: null,
    update: { latest: '0.166.0', method: 'standalone', checkedAt: '2026-11-02T00:00:00.000Z' },
    ...patch,
  }) as ProviderInfo;

let bridge: FakeBridge;
let reload: ReturnType<typeof vi.fn>;
beforeEach(() => {
  bridge = createFakeBridge();
  window.parley = bridge;
  reload = vi.fn(async () => {});
});
afterEach(cleanup);

const done = { state: 'done', ok: true, from: '0.162.0', to: '0.166.0', output: '', runningSessions: 0 } as const;

describe('ProviderUpdateRow', () => {
  it('без update ничего не рисуется', () => {
    const { container } = render(<ProviderUpdateRow provider={codex({ update: null })} onReload={reload} />);
    expect(container.firstChild).toBeNull();
    const old = render(<ProviderUpdateRow provider={{ ...codex(), update: undefined }} onReload={reload} />);
    expect(old.container.firstChild).toBeNull();
  });

  it('есть обновление: «Codex 0.162.0 → 0.166.0 · standalone», кнопка Update и Skip this version', () => {
    const { container } = render(<ProviderUpdateRow provider={codex()} onReload={reload} />);
    const row = container.querySelector('[data-provider-update="codex"]')!;
    expect(row.textContent).toContain('Codex 0.162.0 → 0.166.0');
    expect(row.textContent).toContain('· standalone');
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip this version' })).toBeTruthy();
  });

  it('способ unknown не показывается', () => {
    const { container } = render(
      <ProviderUpdateRow provider={codex({ update: { latest: '0.166.0', method: 'unknown', checkedAt: '2026-11-02T00:00:00.000Z' } })} onReload={reload} />,
    );
    expect(container.textContent).not.toContain('unknown');
  });

  it('идёт: кнопки недоступны, индикатор, повторный щелчок не зовёт хост', async () => {
    let finish!: () => void;
    bridge.setHandler('providers.update', () => new Promise((resolve) => (finish = () => resolve(done))));
    render(<ProviderUpdateRow provider={codex()} onReload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    const updating = await screen.findByRole('button', { name: 'Updating…' });
    expect((updating as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Skip this version' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(updating);
    expect(bridge.calls.filter((call) => call.method === 'providers.update')).toHaveLength(1);
    finish();
    await screen.findByText('Updated to 0.166.0');
  });

  it('успех: «Updated to 0.166.0», список перечитан; провайдер ушёл в хост по id', async () => {
    bridge.setHandler('providers.update', () => done);
    render(<ProviderUpdateRow provider={codex()} onReload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(await screen.findByText('Updated to 0.166.0')).toBeTruthy();
    expect(bridge.calls.find((call) => call.method === 'providers.update')?.params).toEqual({ provider: 'codex' });
    expect(reload).toHaveBeenCalled();
  });

  it('итог остаётся на месте, даже когда хост уже убрал update из списка', async () => {
    bridge.setHandler('providers.update', () => done);
    const { rerender } = render(<ProviderUpdateRow provider={codex()} onReload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await screen.findByText('Updated to 0.166.0');
    rerender(<ProviderUpdateRow provider={codex({ update: null, version: '0.166.0' })} onReload={reload} />);
    expect(screen.getByText('Updated to 0.166.0')).toBeTruthy();
  });

  it('работающие сессии: «N Codex sessions will stay on 0.162.0 until restarted»', async () => {
    bridge.setHandler('providers.update', () => ({ ...done, runningSessions: 2 }));
    render(<ProviderUpdateRow provider={codex()} onReload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(await screen.findByText('2 Codex sessions will stay on 0.162.0 until restarted')).toBeTruthy();
  });

  it('одна сессия — в единственном числе', async () => {
    bridge.setHandler('providers.update', () => ({ ...done, runningSessions: 1 }));
    render(<ProviderUpdateRow provider={codex()} onReload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(await screen.findByText('1 Codex session will stay on 0.162.0 until restarted')).toBeTruthy();
  });

  it('ошибка обновления: вывод и команда для ручного запуска', async () => {
    bridge.setHandler('providers.update', () => ({
      state: 'done', ok: false, from: '0.162.0', to: '0.162.0', output: 'EACCES: permission denied', runningSessions: 0,
      manualCommand: '/usr/local/bin/codex update',
    }));
    const { container } = render(<ProviderUpdateRow provider={codex()} onReload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(await screen.findByText('Update failed')).toBeTruthy();
    expect(container.querySelector('[data-update-result="failed"]')).not.toBeNull();
    expect(screen.getByText('EACCES: permission denied')).toBeTruthy();
    expect(screen.getByText('/usr/local/bin/codex update')).toBeTruthy();
  });

  it('проба Codex отвергла флаги Parley — предупреждение, хотя обновление удалось', async () => {
    bridge.setHandler('providers.update', () => ({ ...done, smoke: { ok: false, output: 'unexpected argument' } }));
    render(<ProviderUpdateRow provider={codex()} onReload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(await screen.findByText('Updated to 0.166.0')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain("rejected Parley's launch flags");
  });

  it('хост ответил busy', async () => {
    bridge.setHandler('providers.update', () => ({ state: 'busy' }));
    render(<ProviderUpdateRow provider={codex()} onReload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(await screen.findByText('An update of this CLI is already running.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Update' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('отказ хоста — понятная строка по коду, без сырого текста', async () => {
    bridge.setHandler('providers.update', () => {
      throw new Error(encodeIpcError('internal', '/private/path leaked'));
    });
    const { container } = render(<ProviderUpdateRow provider={codex()} onReload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't update the provider CLI");
    expect(container.textContent).not.toContain('/private/path');
  });

  it('пропуск: providers.skipUpdate и перечитанный список', async () => {
    bridge.setHandler('providers.skipUpdate', () => ({ ok: true }));
    render(<ProviderUpdateRow provider={codex()} onReload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip this version' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(bridge.calls.find((call) => call.method === 'providers.skipUpdate')?.params).toEqual({ provider: 'codex' });
  });
});
