/**
 * Карточка ленты из вопроса Codex на экране терминала (план слоя 2, задача 2). Карточка того же вида, что у хука:
 * одобрение команды и правки — `permission`, вопрос с вариантами — `question`; отличает её поле `via: 'terminal'`.
 * Решение по ней хост вводит в терминал клавишей (`codexPromptKey`), хуков здесь нет.
 */

import { FeedDraft, limitInput } from '../reduce.js';
import type { FeedPermissionCard, FeedQuestionCard, FeedState, FeedUpdate } from '../types.js';
import type { CodexPrompt } from './terminal-prompt.js';

/** Инструмент вопроса Codex (`request_user_input`) — как его называет журнал Codex. */
const QUESTION_TOOL = 'request_user_input';

export function applyCodexTerminalPrompt(state: FeedState, prompt: CodexPrompt, at: string): FeedUpdate {
  const draft = new FeedDraft(state);
  if (prompt.kind === 'question') {
    const id = draft.nextId('question');
    const limited = limitInput({ question: prompt.question });
    const card: FeedQuestionCard = {
      id,
      at,
      kind: 'question',
      cardId: id,
      state: 'pending',
      toolUseId: null,
      toolName: QUESTION_TOOL,
      toolInput: limited.input,
      // Последний вариант Codex — «None of the above»: цифрой он отправляет ответ без текста, в карточку не входит.
      questions: [
        {
          question: prompt.question,
          header: null,
          options: prompt.options.slice(0, -1).map((option) => ({ label: option.label, description: option.description })),
          multiSelect: false,
        },
      ],
      via: 'terminal',
      ...(limited.truncated ? { truncated: true } : {}),
    };
    draft.put(card);
    return draft.done();
  }

  const id = draft.nextId('permission');
  const command = prompt.kind === 'command-approval';
  const toolName = command ? 'Bash' : 'apply_patch';
  const limited = limitInput(command ? { command: prompt.command, ...(prompt.reason === null ? {} : { description: prompt.reason }) } : { path: prompt.path });
  // «Allow and don't ask again» — вариант 2 Codex; кнопка окна строится из `suggestions` в виде `addRules`.
  const always = prompt.options[1];
  const card: FeedPermissionCard = {
    id,
    at,
    kind: 'permission',
    cardId: id,
    state: 'pending',
    toolUseId: null,
    toolName,
    toolInput: limited.input,
    suggestions: always === undefined ? [] : [{ type: 'addRules', rules: [{ toolName, ruleContent: always.label }] }],
    notified: false,
    via: 'terminal',
    ...(limited.truncated ? { truncated: true } : {}),
  };
  draft.put(card);
  return draft.done();
}
