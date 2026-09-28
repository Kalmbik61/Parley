/**
 * Тестовые переключатели окна (`HARNAS_DOWNLOADS/DIALOGS/NOTIFICATIONS/DROPS/SHELL`) подменяют
 * системные действия журналом main. В собранном приложении случайная переменная окружения иначе
 * молча глушила бы уведомления, ссылки, Finder и загрузки (ревью M5) — поэтому они слушаются только
 * в неупакованном окне (E2E, `pnpm dev`) или при явном `HARNAS_E2E=1` (проверки самой сборки).
 */

export interface TestSwitches {
  readonly downloads: boolean;
  readonly dialogs: boolean;
  readonly notifications: boolean;
  readonly drops: boolean;
  readonly shell: boolean;
}

export function testSwitches(env: Readonly<Record<string, string | undefined>>, isPackaged: boolean): TestSwitches {
  const allowed = !isPackaged || env.HARNAS_E2E === '1';
  return {
    downloads: allowed && env.HARNAS_DOWNLOADS === 'log',
    dialogs: allowed && env.HARNAS_DIALOGS === 'log',
    notifications: allowed && env.HARNAS_NOTIFICATIONS === 'log',
    drops: allowed && env.HARNAS_DROPS === 'fake',
    shell: allowed && env.HARNAS_SHELL === 'log',
  };
}
