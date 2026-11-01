import { envValue } from '@parley/core';

/**
 * Тестовые переключатели окна (`PARLEY_DOWNLOADS/DIALOGS/NOTIFICATIONS/DROPS/SHELL/VOICE/TTS`) подменяют
 * системные действия журналом main; `PARLEY_ISLAND=off` убирает остров одобрений; `PARLEY_LOGIN_SHELL=skip`
 * не даёт окну звать оболочку человека за окружением; `PARLEY_NOTCH=185x32` — подменный вырез вместо датчика. В собранном приложении случайная переменная окружения иначе молча глушила бы
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
  /** Нейроголос помощника на подмене (`main/assistant/tts.ts#createFakeTtsService`): E2E без движка и весов. */
  readonly tts: boolean;
  /** Острова нет (`PARLEY_ISLAND=off`): E2E берут первое окно и считают окна — остров им мешал бы (спека 2026-10-12, 5.1). */
  readonly islandOff: boolean;
  /**
   * Каталог данных приложений вместо `app.getPath('appData')` (`PARLEY_APP_DATA`): от него считается userData окна
   * (`user-data.ts`). Нужен E2E переноса данных — у них нет своего дома (перенос идёт, только когда дом не задан), а
   * настоящий `appData` дал бы userData человека и лок одного экземпляра с его запущенным окном. `undefined` — не задан.
   */
  readonly appData: string | undefined;
  /**
   * Подменный вырез (`PARLEY_NOTCH=<ширина>x<высота>`, pt) вместо датчика `osascript`: E2E острова в вырезе (#9 T17) на
   * любом мониторе, вырез — посередине каждого дисплея. `undefined` — не задан или задан не по форме.
   */
  readonly notch: { width: number; height: number } | undefined;
  /** Entry of a stub bridge process (`PARLEY_BRIDGE_ENTRY`): E2E of Settings → Remote access without the real bridge. */
  readonly bridgeEntry: string | undefined;
}

function parseNotch(value: string | undefined): { width: number; height: number } | undefined {
  const match = value === undefined ? null : /^(\d+)x(\d+)$/.exec(value);
  if (match === null) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : undefined;
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
    tts: allowed && envValue(env, 'TTS') === 'fake',
    islandOff: allowed && envValue(env, 'ISLAND') === 'off',
    appData: allowed ? envValue(env, 'APP_DATA') : undefined,
    notch: allowed ? parseNotch(envValue(env, 'NOTCH')) : undefined,
    bridgeEntry: allowed ? envValue(env, 'BRIDGE_ENTRY') : undefined,
  };
}
