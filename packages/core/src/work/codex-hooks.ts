/**
 * Хуки Codex от Parley (спека 2026-10-07, 5.6): `-c hooks.<Event>=[…]` по событию — подключ, а не вся таблица `hooks`,
 * чтобы не заслонить хуки и доверие человека. Команда — постоянный запускатель `PARLEY_HOME/bin/parley-codex-hook`, поэтому
 * текст определения побайтно одинаков между запусками и обновлениями Parley, и одобрение в `/hooks` не слетает.
 */

import { CODEX_HOOK_EVENTS } from '../feed/codex/apply-codex-hook.js';
import { tomlString } from './mcp-config.js';

export function codexHookFlags(command: string): string[] {
  return CODEX_HOOK_EVENTS.flatMap((event) => [
    '-c',
    `hooks.${event}=[{hooks=[{type="command",command=${tomlString(command)},timeout=${event === 'PermissionRequest' ? 600 : 30}}]}]`,
  ]);
}
