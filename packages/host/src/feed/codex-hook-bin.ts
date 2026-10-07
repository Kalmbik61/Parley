/**
 * Мост хука Codex (спека 2026-10-07, 5.6): JSON хука из stdin — в приёмник хуков хоста (`PARLEY_HOOK_URL`, токен сессии
 * `PARLEY_HOOK_TOKEN`, `x-parley-session` = `PARLEY_SESSION_ID`), ответ — в stdout. Любая ошибка — пустой вывод и код 0:
 * Codex тогда показывает своё окно одобрения в TUI (безопасная сторона). `PermissionRequest` ждёт решения окна до 590 с —
 * меньше предела Codex 600 с.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PERMISSION_WAIT_MS = 590_000;
const OTHER_WAIT_MS = 10_000;

export async function runCodexHook(input: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = env['PARLEY_HOOK_URL'];
  const token = env['PARLEY_HOOK_TOKEN'];
  const session = env['PARLEY_SESSION_ID'];
  if (!url || !token || !session) return '';
  const permission = input.includes('"PermissionRequest"');
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-parley-session': session, 'content-type': 'application/json' },
      body: input,
      signal: AbortSignal.timeout(permission ? PERMISSION_WAIT_MS : OTHER_WAIT_MS),
    });
    if (response.status !== 200) return '';
    const parsed: unknown = JSON.parse(await response.text());
    return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0 ? JSON.stringify(parsed) : '';
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const out = await runCodexHook(Buffer.concat(chunks).toString('utf8'), process.env);
  if (out !== '') process.stdout.write(out);
}

// Запускается как файл (`node codex-hook-bin.js`); при импорте из теста ничего не делает. Сравнение — по realpath:
// путь к файлу может идти через ссылку.
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) void main();
