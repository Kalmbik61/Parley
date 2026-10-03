import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseMarkdownFrontmatter } from '../skills/frontmatter.js';
import { MINIMAL_DEVELOPMENT_NAME, MINIMAL_DEVELOPMENT_SKILL_MD, MINIMAL_DEVELOPMENT_LICENSE } from './minimal-development.js';

describe('fixed minimal-development native asset', () => {
  it('ships the approved body and MIT notice byte for byte', async () => {
    expect(MINIMAL_DEVELOPMENT_SKILL_MD).toBe(await readFile(new URL('../../../../.agents/skills/minimal-development/SKILL.md', import.meta.url), 'utf8'));
    expect(MINIMAL_DEVELOPMENT_LICENSE).toBe(await readFile(new URL('../../../../.agents/skills/minimal-development/LICENSE', import.meta.url), 'utf8'));
  });
  it('advertises native metadata without adding the body to metadata or changing provider policy', () => {
    const metadata = parseMarkdownFrontmatter(MINIMAL_DEVELOPMENT_SKILL_MD);
    expect(metadata.status).toBe('valid');
    if (metadata.status !== 'valid') throw new Error('invalid-builtin-metadata');
    expect(metadata.data).toEqual({ name: MINIMAL_DEVELOPMENT_NAME, description: expect.any(String), license: 'MIT' });
    expect(JSON.stringify(metadata)).not.toContain('## Understand before changing');
  });
});
