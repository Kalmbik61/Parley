import { spawn } from 'node:child_process';

export interface ShellEnvResult {
  env: NodeJS.ProcessEnv;
  fromShell: boolean;
  warning: string | null;
}

const MARKER = '__HARNAS_ENV__';

async function runShell(shell: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`shell did not respond within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`shell exited with code ${String(code)}`));
    });
  });
}

/** Оборачивает любой `run` (в том числе подставной, из теста) внешним таймаутом. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`shell did not respond within ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Electron наследует окружение системы запуска (Dock, Spotlight), а не
 * логин-шелла пользователя — PATH там короткий, без nvm/asdf/homebrew.
 * Печатаем маркер через интерактивный логин-шелл и разбираем `env -0` после
 * него: так агент находится тем же PATH, что и в терминале.
 */
export async function captureShellEnv(options?: {
  shell?: string;
  timeoutMs?: number;
  run?: (shell: string, args: string[], timeoutMs: number) => Promise<string>;
}): Promise<ShellEnvResult> {
  const shell = options?.shell ?? process.env.SHELL ?? '/bin/zsh';
  const timeoutMs = options?.timeoutMs ?? 5000;
  const run = options?.run ?? runShell;

  try {
    const output = await withTimeout(run(shell, ['-ilc', `printf '\\n${MARKER}\\n'; env -0`], timeoutMs), timeoutMs);
    const markerIndex = output.indexOf(MARKER);
    if (markerIndex === -1) {
      return { env: { ...process.env }, fromShell: false, warning: 'environment marker not found in shell output' };
    }
    const afterMarker = output.slice(markerIndex + MARKER.length);
    const newline = afterMarker.indexOf('\n');
    const envBlock = newline === -1 ? afterMarker : afterMarker.slice(newline + 1);

    const env: NodeJS.ProcessEnv = {};
    for (const entry of envBlock.split('\0')) {
      if (entry === '') continue;
      const eq = entry.indexOf('=');
      if (eq === -1) continue;
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return { env, fromShell: true, warning: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { env: { ...process.env }, fromShell: false, warning: message };
  }
}
