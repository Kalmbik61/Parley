import { describe, expect, it } from 'vitest';
import { captureShellEnv } from './shell-env.js';

describe('captureShellEnv', () => {
  it('разбирает A=1\\0B=два\\0 после маркера', async () => {
    const run = (): Promise<string> => Promise.resolve('шум rc-файла\n__HARNAS_ENV__\nA=1\0B=два\0');
    const result = await captureShellEnv({ run });
    expect(result.fromShell).toBe(true);
    expect(result.warning).toBeNull();
    expect(result.env.A).toBe('1');
    expect(result.env.B).toBe('два');
  });

  it('игнорирует шум до маркера', async () => {
    const noisyPrefix = 'export FOO=bar\n'.repeat(20);
    const run = (): Promise<string> => Promise.resolve(`${noisyPrefix}__HARNAS_ENV__\nPATH=/usr/bin\0`);
    const result = await captureShellEnv({ run });
    expect(result.env.PATH).toBe('/usr/bin');
    expect(result.env.FOO).toBeUndefined();
  });

  it('при таймауте отдаёт process.env и предупреждение', async () => {
    const run = (): Promise<string> => new Promise<string>(() => {});
    const result = await captureShellEnv({ run, timeoutMs: 20 });
    expect(result.fromShell).toBe(false);
    expect(result.warning).not.toBeNull();
    expect(result.env).toEqual(process.env);
  });
});
