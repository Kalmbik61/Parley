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

  describe('состояния строки `cli` (спека 2026-11-11, §4.4)', () => {
    const AT = '2026-11-11T14:05:00.000Z';
    const clock = new Date(AT).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const withCli = (cli: Partial<NonNullable<ProviderInfo['cli']>>, patch: Partial<ProviderInfo> = {}): ProviderInfo =>
      codex({
        update: null,
        cli: { installed: '0.162.0', latest: '0.162.0', method: 'standalone', checkedAt: AT, state: 'up-to-date', lastError: null, ...cli },
        ...patch,
      });
    const rowOf = (container: HTMLElement): Element => container.querySelector('[data-provider-update="codex"]')!;

    it('up-to-date: версия, «Up to date», время проверки и Check now; Update нет', () => {
      const { container } = render(<ProviderUpdateRow provider={withCli({})} onReload={reload} />);
      expect(rowOf(container).textContent).toContain('Codex 0.162.0');
      expect(rowOf(container).textContent).toContain('Up to date');
      expect(rowOf(container).textContent).toContain(`checked ${clock}`);
      expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
    });

    it('available: стрелка, способ, Update, Skip this version и Check now', () => {
      const { container } = render(
        <ProviderUpdateRow provider={withCli({ state: 'available', latest: '0.166.0' })} onReload={reload} />,
      );
      expect(rowOf(container).textContent).toContain('Codex 0.162.0 → 0.166.0');
      expect(rowOf(container).textContent).toContain('· standalone');
      expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Skip this version' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
    });

    it('skipped: «skipped» и Update anyway вместо Skip; Update anyway зовёт providers.update', async () => {
      bridge.setHandler('providers.update', () => done);
      const { container } = render(
        <ProviderUpdateRow provider={withCli({ state: 'skipped', latest: '0.166.0' })} onReload={reload} />,
      );
      expect(rowOf(container).textContent).toContain('skipped');
      expect(screen.queryByRole('button', { name: 'Skip this version' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Update anyway' }));
      expect(await screen.findByText('Updated to 0.166.0')).toBeTruthy();
      expect(bridge.calls.find((call) => call.method === 'providers.update')?.params).toEqual({ provider: 'codex' });
    });

    it('unknown: «Could not check (offline)», время проверки и Check now', () => {
      const { container } = render(
        <ProviderUpdateRow provider={withCli({ state: 'unknown', latest: null, lastError: 'offline' })} onReload={reload} />,
      );
      expect(rowOf(container).textContent).toContain('Could not check (offline)');
      expect(rowOf(container).textContent).toContain(`checked ${clock}`);
      expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
    });

    it('brew у Qwen: команда и Copy, без Update и Skip', async () => {
      const copy = vi.fn(async () => {});
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
      const qwen = {
        id: 'qwen', label: 'Qwen Code', available: true, version: '0.27.2', limits: null,
        cli: { installed: '0.27.2', latest: '0.28.0', method: 'brew', checkedAt: AT, state: 'available', lastError: null },
      } as unknown as ProviderInfo;
      const { container } = render(<ProviderUpdateRow provider={qwen} onReload={reload} />);
      expect(container.textContent).toContain('Qwen Code 0.27.2 → 0.28.0');
      expect(container.textContent).toContain('update with:');
      expect(screen.getByText('brew upgrade qwen-code')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Skip this version' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      await waitFor(() => expect(copy).toHaveBeenCalledWith('brew upgrade qwen-code'));
      expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
    });

    it('отсутствующий CLI строку не рисует (это дело карточки)', () => {
      const { container } = render(
        <ProviderUpdateRow
          provider={withCli({ state: 'missing', installed: null, latest: '0.166.0', method: null }, { available: false, version: null })}
          onReload={reload}
        />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('Check now: идёт проверка (кнопка занята), providers.checkUpdates и перечитанный список', async () => {
      let finish!: () => void;
      bridge.setHandler('providers.checkUpdates', () => new Promise((resolve) => (finish = () => resolve({ cli: {} }))));
      render(<ProviderUpdateRow provider={withCli({})} onReload={reload} />);
      fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
      const busy = await screen.findByRole('button', { name: 'Checking…' });
      expect((busy as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(busy);
      expect(bridge.calls.filter((call) => call.method === 'providers.checkUpdates')).toHaveLength(1);
      expect(bridge.calls.find((call) => call.method === 'providers.checkUpdates')?.params).toEqual({ provider: 'codex' });
      finish();
      await screen.findByRole('button', { name: 'Check now' });
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('Check now: отказ хоста — строка по коду, без сырого текста', async () => {
      bridge.setHandler('providers.checkUpdates', () => {
        throw new Error(encodeIpcError('internal', '/private/path leaked'));
      });
      const { container } = render(<ProviderUpdateRow provider={withCli({})} onReload={reload} />);
      fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain("Couldn't check for updates");
      expect(container.textContent).not.toContain('/private/path');
    });
  });
});
