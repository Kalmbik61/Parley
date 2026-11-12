import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const FORBIDDEN = /\/Users\/|\/private\/|\/tmp\/|\/var\/folders\/|\/home\/|[A-Za-z]:\\\\|@privaterelay|password/i;

describe('opencode fixtures', () => {
  it('has the files and a README with the re-check list', () => {
    expect(readdirSync(dir).sort()).toEqual(['README.md', 'events-more.jsonl', 'events-turn.jsonl', 'lab-events.sse.txt', 'lab-execute-error.json', 'lab-model-error.json', 'lab-turn.json', 'messages-mail.json', 'messages-main.json']);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('To re-check against a runnable 2.2.7');
  });
  for (const file of readdirSync(dir).filter((f) => f !== 'README.md')) {
    it(`${file}: valid JSON without paths or user data`, () => {
      const text = readFileSync(join(dir, file), 'utf8');
      if (file.endsWith('.jsonl')) for (const line of text.split('\n').filter(Boolean)) JSON.parse(line);
      else if (file.endsWith('.txt')) for (const line of text.split('\n').filter((l) => l.startsWith('data: '))) JSON.parse(line.slice(6));
      else JSON.parse(text);
      expect(FORBIDDEN.exec(text)?.[0] ?? null).toBeNull();
    });
  }
});
