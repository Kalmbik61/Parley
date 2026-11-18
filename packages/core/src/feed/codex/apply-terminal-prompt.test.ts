import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emptyFeedState } from '../reduce.js';
import type { FeedPermissionCard, FeedQuestionCard } from '../types.js';
import { applyCodexHookEvent } from './apply-codex-hook.js';
import { applyCodexTerminalPrompt } from './apply-terminal-prompt.js';
import { recogniseCodexPrompt, type CodexPrompt } from './terminal-prompt.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'prompts');
const AT = '2026-11-18T12:00:00.000Z';
const prompt = (name: string): CodexPrompt => {
  const found = recogniseCodexPrompt(readFileSync(path.join(DIR, `${name}.txt`), 'utf8').split('\n'));
  if (found === null) throw new Error(`не узнан: ${name}`);
  return found;
};

describe('applyCodexTerminalPrompt', () => {
  it('одобрение команды → permission/Bash с командой и причиной, via terminal, кнопка «не спрашивать» из варианта 2', () => {
    const { state, changes } = applyCodexTerminalPrompt(emptyFeedState(), prompt('command-approval-80x24'), AT);
    expect(changes).toHaveLength(1);
    const card = state.items[0] as FeedPermissionCard;
    expect(card).toEqual({
      id: card.id,
      at: AT,
      kind: 'permission',
      cardId: card.id,
      state: 'pending',
      toolUseId: null,
      toolName: 'Bash',
      toolInput: { command: 'touch created.txt', description: 'Allow `touch created.txt` to write in the read-only workspace?' },
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: "Yes, and don't ask again for commands that start with `touch created.txt`" }],
        },
      ],
      notified: false,
      via: 'terminal',
    });
    expect(card.cardId).toBe(card.id);
  });

  it('одобрение правки → permission/apply_patch с путём', () => {
    const card = applyCodexTerminalPrompt(emptyFeedState(), prompt('patch-approval-80x24'), AT).state.items[0] as FeedPermissionCard;
    expect(card).toMatchObject({
      kind: 'permission',
      state: 'pending',
      toolName: 'apply_patch',
      toolInput: { path: '/work/project/hello.txt' },
      via: 'terminal',
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'apply_patch', ruleContent: "Yes, and don't ask again for these files" }] }],
    });
  });

  it('без причины у команды description не пишется', () => {
    const base = prompt('command-approval-80x24');
    if (base.kind !== 'command-approval') throw new Error('ожидалось одобрение команды');
    const card = applyCodexTerminalPrompt(emptyFeedState(), { ...base, reason: null }, AT).state.items[0] as FeedPermissionCard;
    expect(card.toolInput).toEqual({ command: 'touch created.txt' });
  });

  it('вопрос с вариантами → question с одним вопросом, без последнего «None of the above»', () => {
    const { state } = applyCodexTerminalPrompt(emptyFeedState(), prompt('question-options-120x40'), AT);
    const card = state.items[0] as FeedQuestionCard;
    expect(card).toEqual({
      id: card.id,
      at: AT,
      kind: 'question',
      cardId: card.id,
      state: 'pending',
      toolUseId: null,
      toolName: 'request_user_input',
      toolInput: { question: 'Which color do you prefer?' },
      questions: [
        {
          question: 'Which color do you prefer?',
          header: null,
          options: [
            { label: 'Red (Recommended)', description: 'Choose red.' },
            { label: 'Green', description: 'Choose green.' },
            { label: 'Blue', description: 'Choose blue.' },
          ],
          multiSelect: false,
        },
      ],
      via: 'terminal',
    });
  });

  it('идентификатор — следующий по счётчику ленты, как у карточки хука; две карточки подряд — разные', () => {
    const first = applyCodexTerminalPrompt(emptyFeedState(), prompt('question-two-first-80x24'), AT);
    const second = applyCodexTerminalPrompt(first.state, prompt('question-two-second-80x24'), AT);
    const ids = second.state.items.map((item) => item.id);
    expect(ids).toEqual(['question:#1', 'question:#2']);
    const hook = applyCodexHookEvent(emptyFeedState(), { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }, AT);
    expect(hook.state.items[0]?.id).toBe('permission:#1');
    expect(applyCodexTerminalPrompt(emptyFeedState(), prompt('command-approval-80x24'), AT).state.items[0]?.id).toBe('permission:#1');
  });

  it('у карточки хука поля via нет', () => {
    const hook = applyCodexHookEvent(emptyFeedState(), { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }, AT);
    expect('via' in (hook.state.items[0] as FeedPermissionCard)).toBe(false);
  });

  it('форма suggestions — как её читает always-rules окна и телефона: { type: addRules, rules: [{ toolName, ruleContent }] }', () => {
    // `alwaysRules` (окно и телефон) идёт по записям с `type === 'addRules'`, берёт `rules[].toolName` и `ruleContent`:
    // `Tool(content)`, а пустого списка правил (`[]`) для кнопки мало. Форма закреплена дословно.
    const card = applyCodexTerminalPrompt(emptyFeedState(), prompt('command-approval-80x24'), AT).state.items[0] as FeedPermissionCard;
    const entry = card.suggestions[0] as { type: string; rules: Array<{ toolName: string; ruleContent: string }> };
    expect(card.suggestions).toHaveLength(1);
    expect(entry.type).toBe('addRules');
    expect(entry.rules).toHaveLength(1);
    expect(typeof entry.rules[0]?.toolName).toBe('string');
    expect(entry.rules[0]?.ruleContent).not.toBe('');
  });

  it('исходное состояние не меняется', () => {
    const before = emptyFeedState();
    applyCodexTerminalPrompt(before, prompt('command-approval-80x24'), AT);
    expect(before.items).toEqual([]);
  });
});
