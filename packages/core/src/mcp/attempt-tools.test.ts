import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttemptChannelRequest } from '../work/types.js';
import type { McpContext } from './context.js';
import { guideTopic } from '../work/guide.js';
import { ATTEMPT_TOOLS, sendAttemptRequest } from './attempt-tools.js';

afterEach(() => vi.unstubAllGlobals());

describe('host-local attempts channel', () => {
  const request: AttemptChannelRequest = { action: 'verify', attemptId: 'at-0001', sha: 'a'.repeat(40), criterion: 0, verdict: 'pass', note: 'Checked' };
  const context = (): McpContext => ({ projectPath: '/project', workId: 'w-01', workDir: '/project/.parley/works/w-01', sessionId: 's-01', channel: false });

  it('uses the internal channel without agent credentials or HTTP and forwards cancellation', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const result = { receipt: { id: 'rc-0001' } };
    const attempts = vi.fn(async () => ({ ok: true, result }));
    await expect(sendAttemptRequest({ ...context(), attempts }, request, signal)).resolves.toBe(result);
    expect(attempts).toHaveBeenCalledWith(request, signal);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('prefers the internal channel when an HTTP channel is also present', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const attempts = vi.fn(async () => ({ ok: true, result: { queued: true } }));
    await expect(sendAttemptRequest({ ...context(), agent: { url: 'http://127.0.0.1:12345/agent/browser', token: 'b'.repeat(64) }, attempts }, request)).resolves.toEqual({ queued: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('turns an internal refusal into the same coded rule error as HTTP', async () => {
    const attempts = async () => ({ ok: false, error: { code: 'attempt-fenced', message: 'The attempt ended.' } });
    await expect(sendAttemptRequest({ ...context(), attempts }, request)).rejects.toThrow('attempt-fenced: The attempt ended.');
  });

  it.each([null, [], {}, { ok: true, result: null }, { ok: true, result: [] }, { ok: false, error: { code: 1, message: 'Wrong code type' } }])('rejects a malformed internal result: %j', async body => {
    await expect(sendAttemptRequest({ ...context(), attempts: async () => body }, request)).rejects.toThrow('did not return a valid attempt result');
  });

  it('retains the HTTP path when no internal channel is supplied', async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true, result: { recorded: true } })); vi.stubGlobal('fetch', fetch);
    const agent = { url: 'http://127.0.0.1:12345/agent/browser', token: 'b'.repeat(64) };
    await expect(sendAttemptRequest({ ...context(), agent }, request)).resolves.toEqual({ recorded: true });
    expect(fetch).toHaveBeenCalledWith(new URL('/agent/attempts', agent.url), expect.objectContaining({
      method: 'POST', headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request), redirect: 'error',
    }));
  });
});

describe('attempt submission contract', () => {
  it('allows omitting both hashes while keeping explicit hashes constrained', () => {
    const tool = ATTEMPT_TOOLS.find(tool => tool.name === 'attempt_submit')!;
    expect(tool.inputSchema.required).toEqual(['attemptId', 'manifest']);
    const manifest = tool.inputSchema.properties!.manifest as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
    expect(manifest.required).not.toContain('hash');
    expect(manifest.properties.hash).toEqual({ type: 'string', pattern: '^[a-f0-9]{64}$' });
    expect(manifest.additionalProperties).toBe(false);
    expect(manifest.properties).not.toHaveProperty('sha');
  });

  it('documents host hashes, stable retries, assigned keys and lost responses consistently', () => {
    const tool = ATTEMPT_TOOLS.find(tool => tool.name === 'attempt_submit')!;
    for (const text of [tool.description!, guideTopic('plans')!]) {
      expect(text).toContain('The host computes manifest.hash and submissionKey');
      expect(text).toContain('retry with the same manifest');
      expect(text).toContain('Read attempt_status before retrying a lost response');
      expect(text).toContain('returns the assigned submissionKey');
    }
  });
});
