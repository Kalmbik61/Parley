import { envValue } from '@parley/core';

/**
 * Тестовые переключатели окна (`PARLEY_DOWNLOADS/DIALOGS/NOTIFICATIONS/DROPS/SHELL`) подменяют
 * системные действия журналом main; `PARLEY_LOGIN_SHELL=skip` не даёт окну звать оболочку человека
 * за окружением. В собранном приложении случайная переменная окружения иначе молча глушила бы
 * уведомления, ссылки, Finder и загрузки (ревью M5) — поэтому они слушаются только в неупакованном
 * окне (E2E, `pnpm dev`) или при явном `PARLEY_E2E=1` (проверки самой сборки). Имена читаются
 * как все переменные (`envValue`): прежние `HARNAS_*` тоже годятся.
 */

export interface TestSwitches {
  readonly downloads: boolean;
  readonly dialogs: boolean;
  readonly notifications: boolean;
  readonly drops: boolean;
  readonly shell: boolean;
  /** Окно не зовёт login-оболочку человека и её rc-файлы: окружение остаётся таким, с каким запущено окно. */
  readonly loginShell: boolean;
}

export function testSwitches(env: Readonly<Record<string, string | undefined>>, isPackaged: boolean): TestSwitches {
  const allowed = !isPackaged || envValue(env, 'E2E') === '1';
  return {
    downloads: allowed && envValue(env, 'DOWNLOADS') === 'log',
    dialogs: allowed && envValue(env, 'DIALOGS') === 'log',
    notifications: allowed && envValue(env, 'NOTIFICATIONS') === 'log',
    drops: allowed && envValue(env, 'DROPS') === 'fake',
    shell: allowed && envValue(env, 'SHELL') === 'log',
    loginShell: allowed && envValue(env, 'LOGIN_SHELL') === 'skip',
  };
}
