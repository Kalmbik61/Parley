import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { HUMAN_TABLE } from './md-demo';

it('the demo text is the human fixture, verbatim', () => {
  expect(HUMAN_TABLE).toBe(readFileSync('src/markdown/fixtures/human-table.md', 'utf8').trimEnd());
});
