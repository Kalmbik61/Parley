import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { demoRoute } from './demo';
import { HUMAN_TABLE, LONG_PATH, MD_CASES } from './md-demo';

it('the demo text is the human fixture, verbatim', () => {
  expect(HUMAN_TABLE).toBe(readFileSync('src/markdown/fixtures/human-table.md', 'utf8').trimEnd());
  expect(LONG_PATH).toBe(readFileSync('src/markdown/fixtures/long-path.md', 'utf8').trimEnd());
});

it('every md-* route label opens its own case', () => {
  for (const key of Object.keys(MD_CASES)) expect(demoRoute(`md-${key}`)).toBe(`/md?case=${key}`);
  expect(demoRoute('md-table-scrolled')).toBe('/md?case=table&scrollX=240');
  expect(demoRoute('md-feed')).toMatch(/^\/session\//);
});
