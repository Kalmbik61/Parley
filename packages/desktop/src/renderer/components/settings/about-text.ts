/**
 * Текст для «Copy info» в Settings → About. Домашний каталог в путях main уже заменил на `~`;
 * отсутствующее (нет git, не из `.app`, хост не подключён) опускается.
 */

import type { AboutInfo } from '../../../shared/bridge.js';

export function aboutText(info: AboutInfo, hostVersion: string | null): string {
  const lines: string[] = [];
  lines.push(`Parley ${info.version ?? '(development build)'} (${info.arch})`);
  if (info.commit !== null) {
    lines.push(['Build ' + info.commit, info.commitDate, info.dirty ? 'modified' : null].filter((part) => part !== null).join(', '));
  } else if (info.dirty) {
    lines.push('Build modified');
  }
  if (hostVersion !== null) lines.push(`Host ${hostVersion}`);
  lines.push(`Electron ${info.electron}, Chromium ${info.chrome}, Node ${info.node}`);
  lines.push(info.os);
  if (info.appPath !== null) lines.push(`App ${info.appPath}`);
  lines.push(`Data ${info.dataDir}`);
  return lines.join('\n');
}
