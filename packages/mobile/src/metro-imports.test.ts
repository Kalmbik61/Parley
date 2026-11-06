import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });

// import/export ... from './x.js' (possibly multi-line) and bare import './x.js'
const RELATIVE_JS = /\b(import|export)(\s+type)?\b[^;'"]*?(?:\bfrom\s*)?['"](\.{1,2}\/[^'"]*\.js)['"]/g;

describe('Metro-safe relative imports', () => {
  // Vitest resolves './x.js' to './x.ts', Metro does not ("Unable to resolve module" in the iOS Release build).
  // Runtime relative imports must be extensionless; only `import type` (erased) may keep `.js`.
  it('no runtime relative import ends in .js', () => {
    const bad: string[] = [];
    for (const f of files(__dirname)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(RELATIVE_JS)) {
        if (!m[2]) bad.push(`${path.relative(__dirname, f)}: ${m[3]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
