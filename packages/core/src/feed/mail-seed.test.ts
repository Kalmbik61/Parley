/** M4: seed reconciliation of inline mail with the mail journal (spec 2026-11-12 §3.2a). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawRecord } from '../jsonl.js';
import { INLINE_MAIL_LINE } from '../mcp/tools.js';
import { feedFromTranscript } from './from-transcript.js';
import type { MailJournalEntry } from './mail-seed.js';
import type { FeedItem, FeedMail } from './types.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mail');
const records = (): RawRecord[] =>
  readFileSync(path.join(DIR, 'claude-inline.transcript.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as RawRecord);
const withoutAttachment = (): RawRecord[] => records().filter((r) => (r['attachment'] as { hookEvent?: string } | undefined)?.hookEvent !== 'UserPromptSubmit');

const letter = (id: string, text: string) => ({ id, from: 's-901', fromLabel: 'Reviewer', at: '2030-01-05T09:59:00.000Z', text, kind: 'note', room: null });
const journalLine = (id: string, at: string, text = 'journal text'): MailJournalEntry => ({
  at,
  text: `${INLINE_MAIL_LINE}\n${JSON.stringify({ messages: [letter(id, text)] })}`,
});
const label = (item: FeedItem): string => (item.kind === 'prompt' ? `prompt` : item.kind === 'mail' ? item.id : item.kind);
const mails = (items: readonly FeedItem[]): FeedMail[] => items.filter((i): i is FeedMail => i.kind === 'mail');

// The attachment of the fixture holds letters m-9001 and m-9002; its journal twin has the same first id.
const TWIN = journalLine('m-9001', '2030-01-05T10:00:00.040Z');

describe('transcript with the attachment', () => {
  it('without a journal: the item is parsed from the attachment, after the pointer prompt, at the record time', () => {
    const items = feedFromTranscript(records()).items;
    expect(items.map(label)).toEqual(['prompt', 'mail:m-9001']);
    expect(mails(items)[0]).toMatchObject({ via: 'pointer', toolUseId: null, at: '2030-01-05T10:00:00.050Z', remaining: 3 });
    expect(mails(items)[0]?.letters.map((l) => l.id)).toEqual(['m-9001', 'm-9002']);
  });

  it('with a journal line of the same id: content and at come from the journal, the place from the attachment', () => {
    const items = feedFromTranscript(records(), { mailJournal: [TWIN] }).items;
    expect(items.map(label)).toEqual(['prompt', 'mail:m-9001']);
    expect(mails(items)[0]).toMatchObject({ at: '2030-01-05T10:00:00.040Z' });
    expect(mails(items)[0]?.letters[0]?.text).toBe('journal text');
    expect(mails(items)).toHaveLength(1);
  });
});

describe('transcript without the attachment', () => {
  it('a journal line gives the same item after the pointer prompt', () => {
    const items = feedFromTranscript(withoutAttachment(), { mailJournal: [TWIN] }).items;
    expect(items.map(label)).toEqual(['prompt', 'mail:m-9001']);
    expect(mails(items)[0]).toEqual(mails(feedFromTranscript(records(), { mailJournal: [TWIN] }).items)[0]);
  });

  it('several deliveries after one prompt keep their time order; one after a later prompt goes there', () => {
    const later = (id: string, at: string) => journalLine(id, at);
    const base = withoutAttachment();
    const second = { ...base[1], uuid: 'a0000000-0000-4000-8000-000000000009', timestamp: '2030-01-05T10:05:00.000Z', parentUuid: null } as RawRecord;
    const items = feedFromTranscript([...base, second], {
      mailJournal: [later('m-b', '2030-01-05T10:00:02.000Z'), later('m-a', '2030-01-05T10:00:01.000Z'), later('m-c', '2030-01-05T10:05:01.000Z')],
    }).items;
    expect(items.map(label)).toEqual(['prompt', 'mail:m-a', 'mail:m-b', 'prompt', 'mail:m-c']);
  });

  it('no pointer prompt: time order, and a delivery older than the whole feed is dropped', () => {
    const typed = withoutAttachment().map((r) => (r['type'] === 'user' ? { ...r, message: { role: 'user', content: 'typed by hand' } } : r));
    const items = feedFromTranscript(typed, { mailJournal: [journalLine('m-new', '2030-01-05T10:30:00.000Z'), journalLine('m-old', '2030-01-05T08:00:00.000Z')] }).items;
    expect(items.map(label)).toEqual(['prompt', 'mail:m-new']);
  });

  it('broken, empty and duplicate journal lines are ignored', () => {
    const items = feedFromTranscript(withoutAttachment(), {
      mailJournal: [{ at: 'x', text: 'garbage' }, { at: 'x', text: `${INLINE_MAIL_LINE}\n{"messages":[]}` }, TWIN, TWIN],
    }).items;
    expect(mails(items)).toHaveLength(1);
  });
});

describe('child context', () => {
  it('reads no attachment and no journal', () => {
    expect(mails(feedFromTranscript(records(), { context: 'child', mailJournal: [TWIN] }).items)).toEqual([]);
    expect(mails(feedFromTranscript(withoutAttachment(), { context: 'child', mailJournal: [TWIN] }).items)).toEqual([]);
  });

  it('a SessionStart attachment never makes mail', () => {
    const start = records().filter((r) => (r['attachment'] as { hookEvent?: string } | undefined)?.hookEvent === 'SessionStart');
    expect(start).toHaveLength(1);
    expect(feedFromTranscript(start).items).toEqual([]);
  });
});
