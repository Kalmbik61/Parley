import { pathToFileURL } from 'node:url';

interface HookLaunch { url: URL; token: string; sessionId: string }

export function kimiHookLaunch(env: NodeJS.ProcessEnv): HookLaunch | undefined {
  const token = env['PARLEY_HOOK_TOKEN'];
  const sessionId = env['PARLEY_SESSION_ID'];
  const text = env['PARLEY_HOOK_URL'];
  if (env['PARLEY_KIMI_NATIVE'] !== '1' || !token || !/^[a-f0-9]{64}$/.test(token) ||
      !sessionId || !/^s-[0-9]+$/.test(sessionId) || !text) return;
  let url: URL;
  try { url = new URL(text); } catch { return; }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/hooks' || !url.port ||
      url.username || url.password || url.search || url.hash) return;
  return { url, token, sessionId };
}

async function main(): Promise<void> {
  const launch = kimiHookLaunch(process.env);
  // Ordinary Kimi may start the globally registered bridge. It does not even read stdin without a launch.
  if (launch === undefined) return;
  let body = '';
  let size = 0;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk as string);
    if (size > 256 * 1024) return;
    body += chunk;
  }
  try {
    const response = await fetch(launch.url, {
      method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(2500),
      headers: { Authorization: `Bearer ${launch.token}`, 'X-Parley-Session': launch.sessionId, 'Content-Type': 'application/json' },
    });
    if (!response.ok) return;
    const json = await response.json() as { hookSpecificOutput?: { additionalContext?: unknown } };
    const context = json.hookSpecificOutput?.additionalContext;
    if (typeof context === 'string' && context !== '') process.stdout.write(context.slice(0, 128 * 1024));
  } catch {
    // A nonresponsive host must not block Kimi or inject unauthenticated instructions.
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
