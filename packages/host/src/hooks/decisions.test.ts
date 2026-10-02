/**
 * Ответы удержанным хукам — формы, проверенные на стенде (`evidence/p2b-hook-decisions`,
 * `p4-questions-plan`), и решения контролёра В.
 */

import { describe, expect, it } from 'vitest';
import { EMPTY_HOOK_RESPONSE, hookDecisionResponse } from './decisions.js';
import type { HeldHookContext } from './decisions.js';

const SUGGESTIONS = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], destination: 'session' },
];

const permission: HeldHookContext = {
  hookEvent: 'PermissionRequest',
  rawToolInput: { command: 'ls' },
  suggestions: SUGGESTIONS,
};

describe('hookDecisionResponse', () => {
  it('разрешение allow — как на стенде p2b', () => {
    expect(hookDecisionResponse(permission, { kind: 'permission', behavior: 'allow' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  it('allow с always уносит permission_suggestions карточки как есть', () => {
    const response = hookDecisionResponse(permission, {
      kind: 'permission',
      behavior: 'allow',
      always: true,
    });
    expect(response).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedPermissions: SUGGESTIONS },
      },
    });
  });

  it('deny с текстом для модели и без него', () => {
    expect(
      hookDecisionResponse(permission, {
        kind: 'permission',
        behavior: 'deny',
        message: 'Do not retry.',
      }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Do not retry.' },
      },
    });
    expect(hookDecisionResponse(permission, { kind: 'permission', behavior: 'deny' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
    });
  });

  it('вопрос: PreToolUse allow, updatedInput — весь tool_input тела хука плюс answers', () => {
    const long = 'q'.repeat(40_000);
    const held: HeldHookContext = {
      hookEvent: 'PreToolUse',
      rawToolInput: {
        questions: [
          {
            question: 'Which fruit?',
            header: 'Fruit',
            options: [{ label: 'Pear' }],
            multiSelect: false,
          },
        ],
        extra: long,
      },
      suggestions: [],
    };
    const response = hookDecisionResponse(held, {
      kind: 'question',
      answers: { 'Which fruit?': 'Pear' },
    });
    expect(response).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...held.rawToolInput, answers: { 'Which fruit?': 'Pear' } },
      },
    });
    // Длинная строка входа не усечена: CLI получает свой вход обратно целиком.
    const output = response['hookSpecificOutput'] as { updatedInput: { extra: string } };
    expect(output.updatedInput.extra).toHaveLength(40_000);
  });

  it('план auto-accept — allow и setMode acceptEdits на сессию; manual — allow без режима', () => {
    const plan: HeldHookContext = {
      hookEvent: 'PermissionRequest',
      rawToolInput: { plan: '# Plan' },
      suggestions: [],
    };
    expect(hookDecisionResponse(plan, { kind: 'plan', choice: 'auto-accept' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        },
      },
    });
    expect(hookDecisionResponse(plan, { kind: 'plan', choice: 'manual' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  it('решение не того вида, что удержанный хук, — пустой ответ', () => {
    expect(hookDecisionResponse(permission, { kind: 'question', answers: {} })).toEqual({});
    expect(
      hookDecisionResponse(
        { hookEvent: 'PreToolUse', rawToolInput: {}, suggestions: [] },
        { kind: 'permission', behavior: 'allow' },
      ),
    ).toBe(EMPTY_HOOK_RESPONSE);
    expect(
      hookDecisionResponse(
        { hookEvent: 'PreToolUse', rawToolInput: {}, suggestions: [] },
        { kind: 'plan', choice: 'auto-accept' },
      ),
    ).toEqual({});
  });
});
