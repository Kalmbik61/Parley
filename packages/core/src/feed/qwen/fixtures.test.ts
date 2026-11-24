import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));

// Fixtures are committed: no machine paths and no memory text may leak into them.
const FORBIDDEN: Array<[string, RegExp]> = [
  ['absolute user or temp path', /\/Users\/|\/private\/|\/tmp\/|\/var\/folders\/|\/home\/(?!\.)|[A-Za-z]:\\\\/],
  ['memory snapshot text', /MEMORY\.md|memory catalog|auto-memory catalog|<system-reminder>/i],
];

describe('qwen fixtures', () => {
  it('has the fixture files', () => {
    expect(files.sort()).toEqual(['hook-payloads.jsonl', 'session-main.jsonl', 'session-resume.jsonl']);
  });

  for (const file of files) {
    it(`${file}: valid JSONL without paths or memory text`, () => {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const line of text.split('\n').filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
      for (const [what, re] of FORBIDDEN) expect({ file, what, hit: re.exec(text)?.[0] ?? null }).toEqual({ file, what, hit: null });
    });
  }

  it('keeps the memory snapshot record with placeholder text', () => {
    const recs = readFileSync(join(dir, 'session-main.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const snap = recs.find((r) => r.subtype === 'memory_catalog_snapshot');
    expect(snap.message.parts[0].text).toBe('[memory snapshot omitted]');
  });
});
