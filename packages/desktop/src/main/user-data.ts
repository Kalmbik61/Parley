import path from 'node:path';
import { isDirectorySync } from '@parley/core';

/**
 * Каталог userData окна Electron (R7). Electron считает его от `name` из `package.json`, а имя пакета сменилось
 * вместе с переименованием продукта: без закрепления окно открыло бы пустой `<appData>/@parley/desktop`, а раскладка,
 * настройки, куки встроенного браузера (раздел `persist:harnas-browser`) и разрешение уведомлений остались бы в
 * `<appData>/@harnas/desktop`. Поэтому прежний каталог главнее: есть он — окно живёт в нём, нет — в новом. Каталог
 * не переносится и не копируется: переезд данных Chromium (кэши, разделы, лок одного экземпляра) на лету не нужен,
 * а смена appId и раздела стоила бы человеку разрешений (R7).
 *
 * `appData` — `app.getPath('appData')` (у E2E переноса данных — подмена); `isDir` подменяет тест.
 */
export function userDataDir(appData: string, isDir: (dir: string) => boolean = isDirectorySync): string {
  const legacy = path.join(appData, '@harnas', 'desktop');
  return isDir(legacy) ? legacy : path.join(appData, '@parley', 'desktop');
}
