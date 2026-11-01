import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });

describe('no LayoutAnimation', () => {
  // With Fabric (New Architecture) LayoutAnimation crashes in RCTComponentViewRegistry when a view is removed while the
  // animation runs (seen on the iPhone right after a navigation). Do not bring it back.
  it('no source file uses LayoutAnimation', () => {
    const self = path.resolve(__dirname, 'no-layout-animation.test.ts');
    const bad = files(__dirname).filter((f) => path.resolve(f) !== self && readFileSync(f, 'utf8').includes('LayoutAnimation'));
    expect(bad).toEqual([]);
  });
});
