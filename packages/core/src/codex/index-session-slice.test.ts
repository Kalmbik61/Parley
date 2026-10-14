import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexCodexSession } from './index-session.js';

describe('indexCodexSession со срезом по окнам (спека расхода токенов, 5.3)', () => {
  it('накопитель режется окном: наибольшее в окне минус значение до него; запись в кэш остаётся неизвестной', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'parley-codex-slice-'));
    try {
      const file = path.join(dir, 'rollout-2026-10-14T09-00-00-t1.jsonl');
      const count = (at: string, input: number) => ({
        type: 'event_msg',
        timestamp: at,
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1 } } },
      });
      await writeFile(
        file,
        [
          { type: 'session_meta', timestamp: '2026-10-14T09:00:00.000Z', payload: { id: 't1', cwd: '/codex', source: 'cli' } },
          count('2026-10-14T09:10:00.000Z', 100),
          count('2026-10-14T11:00:00.000Z', 160),
        ]
          .map((line) => JSON.stringify(line))
          .join('\n'),
      );
      const whole = await indexCodexSession(file);
      expect(whole.usage).toMatchObject({ input: 160 });
      const sliced = await indexCodexSession(file, undefined, { usageWindows: [{ from: '2026-10-14T10:00:00.000Z', to: null }] });
      expect(sliced.usage).toMatchObject({ input: 60, cacheWrite: null, completeness: 'complete' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
