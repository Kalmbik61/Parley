import { describe, expect, it } from 'vitest';
import { composeMessage, isSlashCommand, plateCleared, REPLY_QUOTE_MAX, replyQuote, splitQuote, withQuote } from './reply';

describe('replyQuote', () => {
  it(`without a selection — the whole text up to ${REPLY_QUOTE_MAX} characters, else the start and "…"`, () => {
    expect(REPLY_QUOTE_MAX).toBe(300);
    expect(replyQuote('  a short reply\n', '')).toBe('a short reply');
    const exact = 'я'.repeat(REPLY_QUOTE_MAX);
    expect(replyQuote(exact, '')).toBe(exact);
    const long = `${'a'.repeat(REPLY_QUOTE_MAX - 1)} ${'b'.repeat(50)}`;
    expect(replyQuote(long, '')).toBe(`${'a'.repeat(REPLY_QUOTE_MAX - 1)}…`);
    // An emoji (a surrogate pair) is not cut in half.
    expect(replyQuote('😀'.repeat(REPLY_QUOTE_MAX + 1), '')).toBe(`${'😀'.repeat(REPLY_QUOTE_MAX)}…`);
  });
  it('a selected fragment goes whole, whatever its length', () => {
    const fragment = 'x'.repeat(REPLY_QUOTE_MAX * 2);
    expect(replyQuote('the whole reply', `  ${fragment} `)).toBe(fragment);
  });
});

describe('withQuote and splitQuote', () => {
  it('the quote is a "> …" block before the text (an empty quote line is ">"); splitQuote brings it back', () => {
    const sent = withQuote('line 1\n\nline 3', 'my question');
    expect(sent).toBe('> line 1\n>\n> line 3\n\nmy question');
    expect(splitQuote(sent)).toEqual({ quote: 'line 1\n\nline 3', text: 'my question' });
    expect(withQuote('only a quote', '')).toBe('> only a quote');
  });
  it('a text without a quote at the start is as it is', () => {
    expect(splitQuote('hello\n> not a quote')).toEqual({ quote: null, text: 'hello\n> not a quote' });
  });
});

describe('isSlashCommand', () => {
  it('a CLI command — yes; an absolute path at the start and plain text — no', () => {
    for (const text of ['/compact', '  /model opus', '/mcp__server:tool x']) expect(isSlashCommand(text), text).toBe(true);
    for (const text of ['/Users/me/x.ts why does it fail?', 'text /compact', '//x']) expect(isSlashCommand(text), text).toBe(false);
  });
});

describe('composeMessage (the session field)', () => {
  it('with a quote: the block and the text; without: the text as it is', () => {
    expect(composeMessage('why?', 'the claim')).toBe('> the claim\n\nwhy?');
    expect(composeMessage('why?', null)).toBe('why?');
  });
  it('a slash command goes without the quote', () => {
    expect(composeMessage('/compact', 'the claim')).toBe('/compact');
    expect(composeMessage('/Users/me/a.ts is wrong', 'the claim')).toBe('> the claim\n\n/Users/me/a.ts is wrong');
  });
});

describe('plateCleared', () => {
  const quote = 'the claim';
  const sent = composeMessage('why?', quote);
  it('only a send that carried the quote and was accepted clears the plate', () => {
    expect(plateCleared(quote, sent, true)).toBe(true);
    // A refusal or a lost call: the plate stays.
    expect(plateCleared(quote, sent, false)).toBe(false);
    // A slash command did not carry it: the plate stays even when accepted.
    expect(plateCleared(quote, '/compact', true)).toBe(false);
    // No plate: nothing to clear.
    expect(plateCleared(null, 'hello', true)).toBe(false);
  });
});
