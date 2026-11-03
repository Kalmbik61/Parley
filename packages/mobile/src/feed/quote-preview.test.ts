import { describe, expect, it } from 'vitest';
import { QUOTE_PREVIEW_INPUT_MAX, quotePreview } from './quote-preview';

describe('quotePreview', () => {
  it('emphasis, code marks and links lose their syntax', () => {
    expect(quotePreview('The **lint** step failed because `eslint` found [three](https://x.dev) imports.')).toBe('The lint step failed because eslint found three imports.');
  });
  it('blocks keep their lines; list markers are dropped', () => {
    expect(quotePreview('## Title\n\n- a\n- b')).toBe('Title\na\nb');
  });
  it('a code block shows its code', () => {
    expect(quotePreview('```\npnpm lint\n```')).toBe('pnpm lint');
  });
  it('plain text stays; the input is capped', () => {
    expect(quotePreview('just words')).toBe('just words');
    expect(quotePreview('a'.repeat(QUOTE_PREVIEW_INPUT_MAX * 3)).length).toBe(QUOTE_PREVIEW_INPUT_MAX);
  });
});
