import { describe, expect, it } from 'vitest';
import { afterSend, carriesQuote, composeMessage, isSlashCommand, REPLY_QUOTE_MAX, replyQuote, splitQuote, typedPart, withQuote, type AfterSendFacts } from './reply';

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

describe('carriesQuote and typedPart', () => {
  const quote = 'The lint';
  it('the block is a prefix only before an empty line or alone; a longer quote does not match a shorter plate', () => {
    expect(carriesQuote(withQuote(quote, 'why?'), quote)).toBe(true);
    expect(carriesQuote(withQuote(quote, ''), quote)).toBe(true);
    expect(carriesQuote(withQuote('The lint step failed', 'x'), 'The')).toBe(false);
    expect(carriesQuote('why?', quote)).toBe(false);
    expect(carriesQuote('why?', null)).toBe(false);
  });
  it('typedPart strips the block; text without it is as it is', () => {
    expect(typedPart(withQuote(quote, 'why?'), quote)).toBe('why?');
    expect(typedPart(withQuote(quote, ''), quote)).toBe('');
    expect(typedPart('/compact', quote)).toBe('/compact');
  });
});

describe('afterSend', () => {
  const plate = 'the claim';
  const base: AfterSendFacts = { accepted: false, textBack: false, sent: withQuote(plate, 'why?'), plate, carriesPlate: true, fromDraft: true, draftFree: true };
  it('an accepted send that carried the plate clears it and the field', () => {
    expect(afterSend({ ...base, accepted: true })).toEqual({ draft: '', clearPlate: true, giveBack: false });
  });
  it('a lost call or a refusal without text back: the plate stays, the field is cleared (the bubble keeps the text)', () => {
    expect(afterSend(base)).toEqual({ draft: '', clearPlate: false, giveBack: false });
  });
  it('a refusal with text back (not_found, blocked): only what was typed returns, the plate stays — no double quote', () => {
    const r = afterSend({ ...base, textBack: true });
    expect(r).toEqual({ draft: 'why?', clearPlate: false, giveBack: true });
    // The next send composes the quote once.
    expect(composeMessage(r.draft as string, plate)).toBe(withQuote(plate, 'why?'));
  });
  it('a failed wake-up (from the field, the field is free): the same, typed part only', () => {
    expect(afterSend({ ...base, fromDraft: false, textBack: true, draftFree: true })).toMatchObject({ draft: 'why?', giveBack: true });
  });
  it('Send again: a refusal never overwrites a draft; with a free field the text returns as it is', () => {
    const again = { ...base, carriesPlate: false, fromDraft: false, sent: 'run the linter', textBack: true };
    expect(afterSend({ ...again, draftFree: false })).toEqual({ draft: null, clearPlate: false, giveBack: false });
    expect(afterSend({ ...again, draftFree: true })).toEqual({ draft: 'run the linter', clearPlate: false, giveBack: true });
  });
  it('Send again does not clear the plate even when its text starts with the same quote', () => {
    expect(afterSend({ ...base, carriesPlate: false, fromDraft: false, accepted: true })).toMatchObject({ clearPlate: false, draft: null });
  });
  it('a slash command carried no quote: the plate stays even when accepted', () => {
    expect(afterSend({ ...base, sent: '/compact', accepted: true })).toMatchObject({ clearPlate: false });
  });
});
