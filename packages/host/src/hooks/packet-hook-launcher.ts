/**
 * Запускатель моста пакета: `PARLEY_HOME/bin/parley-packet-hook` — постоянный путь, на который ссылается команда хука в файле
 * настроек сессии. Содержимое (путь к node и к мосту в сборке хоста) хост переписывает при старте, если оно другое.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PACKET_HOOK_LAUNCHER = 'parley-packet-hook';

const shellQuote = (value: string): string => `"${value.replace(/(["\\$`])/g, '\\$1')}"`;

export async function ensurePacketHookLauncher(parleyHome: string, nodePath: string, bridgePath: string): Promise<string> {
  const dir = path.join(parleyHome, 'bin');
  const file = path.join(dir, PACKET_HOOK_LAUNCHER);
  const body = `#!/bin/sh\n# Parley room packet hook: the path is stable, the host rewrites the content on start.\nexec ${shellQuote(nodePath)} ${shellQuote(bridgePath)} "$@"\n`;
  await mkdir(dir, { recursive: true });
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current !== body) await writeFile(file, body, 'utf8');
  await chmod(file, 0o755);
  return file;
}
