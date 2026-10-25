import { describe, expect, it } from 'vitest';
import { guideTopic } from '../work/guide.js';
import { ATTEMPT_TOOLS } from './attempt-tools.js';

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
