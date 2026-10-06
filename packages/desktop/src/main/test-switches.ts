import { envValue } from '@parley/core';

/**
 * Тестовые переключатели окна (`PARLEY_DOWNLOADS/DIALOGS/NOTIFICATIONS/DROPS/SHELL/VOICE`) подменяют
 * системные действия журналом main; `PARLEY_LOGIN_SHELL=skip` не даёт окну звать оболочку человека
 * за окружением. В собранном приложении случайная переменная окружения иначе молча глушила бы
 * уведомления, ссылки, Finder и загрузки (ревью M5) — поэтому они слушаются только в неупакованном
 * окне (E2E, `pnpm dev`) или при явном `PARLEY_E2E=1` (проверки самой сборки). Имена читаются
 * как все переменные (`envValue`): прежние `HARNAS_*` тоже годятся. `PARLEY_APP_DATA=<каталог>` — не действие,
 * а место: откуда окно считает свой userData (`user-data.ts`), когда у теста нет своего дома.
 */

export interface TestSwitches {
  readonly downloads: boolean;
  readonly dialogs: boolean;
  readonly notifications: boolean;
  readonly drops: boolean;
  readonly shell: boolean;
  /** Окно не зовёт login-оболочку человека и её rc-файлы: окружение остаётся таким, с каким запущено окно. */
  readonly loginShell: boolean;
  /** Голосовой ввод на подменных службах (`main/voice/services.ts#createFakeVoiceServices`): E2E без движка и сети. */
  readonly voice: boolean;
  /**
   * Каталог данных приложений вместо `app.getPath('appData')` (`PARLEY_APP_DATA`): от него считается userData окна
   * (`user-data.ts`). Нужен E2E переноса данных — у них нет своего дома (перенос идёт, только когда дом не задан), а
   * настоящий `appData` дал бы userData человека и лок одного экземпляра с его запущенным окном. `undefined` — не задан.
   */
  readonly appData: string | undefined;
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
    voice: allowed && envValue(env, 'VOICE') === 'fake',
    appData: allowed ? envValue(env, 'APP_DATA') : undefined,
  };
}
