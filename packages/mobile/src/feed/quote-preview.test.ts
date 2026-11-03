import { describe, expect, it } from 'vitest';
import { plainOf, promptLabel, QUOTE_PREVIEW_INPUT_MAX, quotePreview, replyExtras } from './quote-preview';

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

describe('plainOf (the VoiceOver label of a reply)', () => {
  it('no 1000-character cut: the tail of a long reply is read', () => {
    const long = `${'word '.repeat(600)}\n\nThe final answer is **42**.`;
    expect(plainOf(long).endsWith('The final answer is 42.')).toBe(true);
    expect(plainOf(long).length).toBeGreaterThan(QUOTE_PREVIEW_INPUT_MAX);
  });
});

describe('replyExtras (links and code blocks become actions of the reply)', () => {
  it('openable links with their host, once each; unsafe ones are not actions', () => {
    const md = 'See [docs](https://example.com/a) and [again](https://example.com/a), [mail](mailto:a@b.c), [x][r].\n\n[r]: https://other.dev/x';
    expect(replyExtras(md).links).toEqual([
      { url: 'https://example.com/a', host: 'example.com' },
      { url: 'https://other.dev/x', host: 'other.dev' },
    ]);
  });
  it('code blocks in order', () => {
    expect(replyExtras('```\npnpm lint\n```\n\ntext\n\n```\npnpm test\n```').codes).toEqual(['pnpm lint', 'pnpm test']);
  });
  it('no extras in plain text', () => {
    expect(replyExtras('just words')).toEqual({ links: [], codes: [] });
  });
});

describe('promptLabel', () => {
  it('"You: <text>", with "Quote: …" for a quoted prompt', () => {
    expect(promptLabel(null, 'run it')).toBe('You: run it');
    expect(promptLabel('The **lint** failed', 'why?')).toBe('You: Quote: The lint failed. why?');
  });
});
