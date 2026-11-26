import { describe, expect, it } from 'vitest';
import { recogniseKimiFolderTrust, recogniseQwenFolderTrust } from './folder-trust.js';

const qwen = [
  'Welcome back!', '   ╭────────────────────────────────────────────', '   │',
  '   │ Do you trust this folder?', '   │ Trusting a folder allows Qwen Code to execute commands it suggests. This is a security',
  '   │ feature to prevent accidental execution in untrusted directories.', '   │',
  '   │ › 1. Trust folder (project)', '   │   2. Trust parent folder (work)', "   │   3. Don't trust (esc)", '   │',
  '   ╰────────────────────────────────────────────',
];
const kimi = [
  ' ─────────────────────────', '  Trust this folder?', '  ↑↓ navigate · Enter select · Esc exit', '', '  /work/project', '',
  '  Load project instructions', '    Check: AGENTS.md', '',
  '  Trust is remembered for this folder, including future project config changes.', '  Tool approvals follow your permission settings.', '',
  '   ❯ Trust and continue', '     Exit', ' ─────────────────────────',
];
describe('native folder trust menus', () => {
  it('reads the three scopes from a complete Qwen permission dialog', () => {
    const menu = recogniseQwenFolderTrust(qwen);
    expect(menu?.options).toEqual(['Trust folder (project)', 'Trust parent folder (work)', "Don't trust (esc)"]);
    expect(menu?.detail).toContain('accidental execution');
    expect(recogniseQwenFolderTrust(qwen.filter(line => !line.includes('parent folder')))).toBeUndefined();
    expect(recogniseQwenFolderTrust([...qwen, 'a later prompt'])).toBeUndefined();
  });

  it('reads the original folder and all project instructions before a Kimi trust decision', () => {
    const menu = recogniseKimiFolderTrust(kimi, '/work/project');
    expect(menu?.detail).toContain('Check: AGENTS.md');
    expect(menu?.options).toEqual(['Trust and continue', 'Exit']);
    expect(recogniseKimiFolderTrust(kimi, '/other')).toBeUndefined();
    expect(recogniseKimiFolderTrust(kimi.slice(3), '/work/project')).toBeUndefined();
    expect(recogniseKimiFolderTrust([...kimi, 'later'], '/work/project')).toBeUndefined();
  });
});
