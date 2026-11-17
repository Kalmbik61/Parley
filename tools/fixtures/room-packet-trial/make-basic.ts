/**
 * Regenerates the committed `basic/` fixture (synthetic transcripts and hook journals) from the builder:
 * `pnpm exec tsx tools/fixtures/room-packet-trial/make-basic.ts`. The expected numbers live in the test, worked out by hand.
 * Sessions: A (packet, in a room all along), B (control, in a room), C (packet, joins the room after its first compaction),
 * D (control, never in a room). The clock of every transcript starts at 2026-11-20T10:00:00Z.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscriptBuilder } from './builder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const start = '2026-11-20T10:00:00.000Z';
const transcripts = path.join(here, 'basic', 'claude', '-fixture-project');
const events = path.join(here, 'basic', 'events');
mkdirSync(transcripts, { recursive: true });
mkdirSync(events, { recursive: true });
const getMapPacket = { name: 'mcp__parley__get_map', input: { field: 'packet' } };

// A: window 1 = 6 calls (ok, error, ok, ok, no result, get_map packet); window 2 = 3 calls (ok, ok, plain text with a listed phrase, no is_error),
// the third call has no usage data, one extra text-only model message; window 3 has no calls and no packet.
const a = new TranscriptBuilder('claude-a', start)
  .prompt()
  .at(60).boundary().packet(900)
  .call().call({ result: 'error' }).call().call().call({ result: 'none' }).call(getMapPacket)
  .at(600).boundary().packet(1200)
  .call().call().call({ result: 'plain', usage: false }).model()
  .at(1200).boundary();
// B: window 1 = 3 calls (ok, is_error with an unlisted text, plain listed phrase without is_error): no call error;
// window 2 = 2 calls (error, ok).
const b = new TranscriptBuilder('claude-b', start)
  .prompt()
  .at(60).boundary()
  .call().call({ result: 'other-error' }).call({ result: 'plain' })
  .at(600).boundary()
  .call({ result: 'error' }).call();
// C: first compaction at 10:01 (before the room, no packet), second at 10:40 (in the room, packet 800 bytes).
const c = new TranscriptBuilder('claude-c', start)
  .prompt()
  .at(60).boundary().calls(2)
  .at(2400).boundary().packet(800).calls(2);
// D: never in a room: one compaction, one call error.
const d = new TranscriptBuilder('claude-d', start).prompt().at(60).boundary().call({ result: 'error' }).call();

for (const [id, builder] of [['claude-a', a], ['claude-b', b], ['claude-c', c], ['claude-d', d]] as const) {
  writeFileSync(path.join(transcripts, `${id}.jsonl`), builder.text());
}
const lines = (rows: Array<Record<string, unknown>>): string => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
const compact = { hook_event_name: 'SessionStart', source: 'compact' };
writeFileSync(path.join(events, 's-01.jsonl'), lines([
  { hook_event_name: 'UserPromptSubmit' },
  compact, { hook_event_name: 'ParleyRoomPacket', revision: 'aaaaaaaaaaaa', bytes: 900, reason: 'sent' }, { hook_event_name: 'ParleyRoomPacketBridge', outcome: 'printed', requestMs: 20 },
  compact, { hook_event_name: 'ParleyRoomPacket', revision: 'bbbbbbbbbbbb', bytes: 1200, reason: 'sent' }, { hook_event_name: 'ParleyRoomPacketBridge', outcome: 'printed', requestMs: 25 },
  compact, { hook_event_name: 'ParleyRoomPacket', revision: null, bytes: 0, reason: 'no-packet' }, { hook_event_name: 'ParleyRoomPacketBridge', outcome: 'empty', requestMs: 30 },
]));
writeFileSync(path.join(events, 's-02.jsonl'), lines([{ hook_event_name: 'UserPromptSubmit' }, compact, compact]));
writeFileSync(path.join(events, 's-03.jsonl'), lines([
  compact, { hook_event_name: 'ParleyRoomPacketBridge', outcome: 'unreachable', requestMs: 3 },
  compact, { hook_event_name: 'ParleyRoomPacket', revision: 'cccccccccccc', bytes: 800, reason: 'sent' }, { hook_event_name: 'ParleyRoomPacketBridge', outcome: 'printed', requestMs: 22 },
]));
