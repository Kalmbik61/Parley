import { describe, expect, it } from 'vitest';
import { CODEX_AUTO_MIN_VERSION, codexPolicyArgs, trustArgs } from './codex-policy.js';

describe('codexPolicyArgs', () => {
  it('read-only role → never, no reviewer', () => {
    expect(codexPolicyArgs({ readOnly: true }, 'auto')).toEqual(['-c', 'approval_policy="never"']);
    // Режим пишущих ролей на роль только для чтения не влияет.
    expect(codexPolicyArgs({ readOnly: true }, 'parley')).toEqual(['-c', 'approval_policy="never"']);
    expect(codexPolicyArgs({ readOnly: true }, 'terminal')).toEqual(['-c', 'approval_policy="never"']);
  });

  it('writing role: on-request; auto adds the reviewer', () => {
    expect(codexPolicyArgs({ readOnly: false }, 'auto')).toEqual([
      '-c',
      'approval_policy="on-request"',
      '-c',
      'approvals_reviewer="auto_review"',
    ]);
    expect(codexPolicyArgs({ readOnly: false }, 'parley')).toEqual(['-c', 'approval_policy="on-request"']);
    expect(codexPolicyArgs({ readOnly: false }, 'terminal')).toEqual(['-c', 'approval_policy="on-request"']);
  });

  it('нижняя граница для auto — версия спайка 0', () => {
    expect(CODEX_AUTO_MIN_VERSION).toBe('0.162.0');
  });
});

describe('trustArgs', () => {
  it('one key when cwd is the project, two otherwise, quotes escaped', () => {
    expect(trustArgs({ project: '/p', cwd: '/p' })).toEqual(['-c', 'projects={"/p"={trust_level="trusted"}}']);
    expect(trustArgs({ project: '/p', cwd: '/p/.claude/worktrees/wt' })).toEqual([
      '-c',
      'projects={"/p"={trust_level="trusted"},"/p/.claude/worktrees/wt"={trust_level="trusted"}}',
    ]);
    expect(trustArgs({ project: '/a "q" x', cwd: '/a "q" x' })[1]).toBe(
      'projects={"/a \\"q\\" x"={trust_level="trusted"}}',
    );
  });
});
