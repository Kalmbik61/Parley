/**
 * Запускатель хука Codex (спека 2026-10-07, 5.6): `PARLEY_HOME/bin/parley-codex-hook` — постоянный путь, на который ссылается
 * определение хука. Содержимое (путь к node и к мосту в сборке хоста) хост переписывает при старте, если оно другое; путь и
 * текст хука не меняются, поэтому одобрение человека в `/hooks` переживает обновления Parley.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CODEX_HOOK_LAUNCHER = 'parley-codex-hook';

const shellQuote = (value: string): string => `"${value.replace(/(["\\$`])/g, '\\$1')}"`;

export async function ensureCodexHookLauncher(parleyHome: string, nodePath: string, bridgePath: string): Promise<string> {
  const dir = path.join(parleyHome, 'bin');
  const file = path.join(dir, CODEX_HOOK_LAUNCHER);
  const body = `#!/bin/sh\n# Хук Codex от Parley: путь постоянный, содержимое переписывает хост при старте.\nexec ${shellQuote(nodePath)} ${shellQuote(bridgePath)} "$@"\n`;
  await mkdir(dir, { recursive: true });
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current !== body) await writeFile(file, body, 'utf8');
  await chmod(file, 0o755);
  return file;
}
