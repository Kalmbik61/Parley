/**
 * Карточки разрешения, вопроса и плана с кнопками (план 2026-10-01, Task 4, решения 4 и 7, кусок 4a):
 * три состояния каждой карточки, длинные команда и путь, «Allow and don't ask again» только с `addRules`,
 * второй клик не шлёт второй `feed.decide`, отказ с текстом и без, вопрос из двух вопросов (Next, Submit,
 * multiSelect, «Other»), план (auto-accept, manual, терминал без решения) и черновик, переживший
 * размонтирование строки. Мост подставной; решение уходит через настоящий `useFeedStore.decide`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FeedPermissionCard, FeedPlanCard, FeedQuestionCard } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { openTab, emptyLayout, groups } from '../../layout/tree.js';
import { useLayoutStore } from '../../layout/store.js';
import { REQUIRED_METHODS } from '../../lib/capabilities.js';
import { useHostStore } from '../../store/host.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { ChatEnvContext } from '../chat-env.js';
import { CardItem } from '../items/CardItem.js';
import { resetFeedStoreForTests, useFeedStore } from '../store.js';
import { cardKey, resetChatUiStoreForTests, useChatUiStore } from '../ui-store.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const AT = '2026-10-01T00:00:00.000Z';
const WORK = '/tmp/p w-01';
const TAB = 'terminal:s-01';

let bridge: FakeBridge;

function permission(patch: Partial<FeedPermissionCard> = {}): FeedPermissionCard {
  return {
    id: 'c1',
    at: AT,
    kind: 'permission',
    cardId: 'c1',
    state: 'pending',
    toolUseId: null,
    toolName: 'Bash',
    toolInput: { command: 'npm test', description: 'Run the tests' },
    suggestions: [],
    notified: false,
    ...patch,
  };
}

function question(patch: Partial<FeedQuestionCard> = {}): FeedQuestionCard {
  return {
    id: 'q1',
    at: AT,
    kind: 'question',
    cardId: 'q1',
    state: 'pending',
    toolUseId: null,
    toolName: 'AskUserQuestion',
    toolInput: {},
    questions: [
      {
        question: 'Which fruit?',
        header: 'Fruit',
        options: [
          { label: 'Apple', description: 'Red' },
          { label: 'Pear', description: null },
        ],
        multiSelect: false,
      },
      {
        question: 'Which toppings?',
        header: null,
        options: [
          { label: 'Nuts', description: null },
          { label: 'Cream', description: null },
        ],
        multiSelect: true,
      },
    ],
    ...patch,
  };
}

function plan(patch: Partial<FeedPlanCard> = {}): FeedPlanCard {
  return {
    id: 'p1',
    at: AT,
    kind: 'plan',
    cardId: 'p1',
    state: 'pending',
    toolUseId: null,
    toolName: 'ExitPlanMode',
    toolInput: {},
    plan: '# Plan\n\nDo the thing',
    planFilePath: null,
    ...patch,
  };
}

function Card({ item }: { item: FeedPermissionCard | FeedQuestionCard | FeedPlanCard }): JSX.Element {
  return (
    <ChatEnvContext.Provider value={{ bridge, sessionRef: REF, workKey: WORK, tabId: TAB }}>
      <CardItem item={item} />
    </ChatEnvContext.Provider>
  );
}

const decideCalls = (): Array<{ method: string; params: unknown }> => bridge.calls.filter((call) => call.method === 'feed.decide');
const lastDecision = (): unknown => (decideCalls().at(-1)?.params as { decision: unknown }).decision;
const option = (label: string): HTMLInputElement =>
  screen.getAllByTestId('card-option').find((node) => node.getAttribute('data-option-label') === label) as HTMLInputElement;

beforeEach(() => {
  resetFeedStoreForTests();
  resetChatUiStoreForTests();
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.3.0', methods: [...REQUIRED_METHODS, 'feed.decide'] } });
  bridge = createFakeBridge();
  bridge.setHandler('feed.decide', () => ({ applied: true, state: 'allowed' as const }));
  useFeedStore.getState().init(bridge);
});

afterEach(() => {
  cleanup();
  resetFeedStoreForTests();
  resetChatUiStoreForTests();
  useLayoutStore.getState().drop(WORK);
  useHostStore.setState({ status: { state: 'connecting' } });
});

describe('PermissionCard', () => {
  it('ждёт — команда, описание и три действия; нажатие «Allow» шлёт allow', async () => {
    render(<Card item={permission()} />);
    const card = screen.getByTestId('chat-card');
    expect(card.getAttribute('data-card-state')).toBe('pending');
    expect(screen.getByTestId('card-command').textContent).toBe('npm test');
    expect(card.textContent).toContain('Run the tests');
    fireEvent.click(screen.getByTestId('card-allow'));
    await waitFor(() => expect(decideCalls()).toHaveLength(1));
    expect(decideCalls()[0]!.params).toEqual({ ref: REF, cardId: 'c1', decision: { kind: 'permission', behavior: 'allow' } });
  });

  it('разрешено, отказано с текстом и отвечено в другом месте — прежние строки состояния', () => {
    const { rerender } = render(<Card item={permission({ state: 'allowed' })} />);
    expect(screen.getByTestId('chat-card').textContent).toContain(S.chat.cardState.allowed);
    expect(screen.queryByTestId('card-allow')).toBeNull();
    rerender(<Card item={permission({ state: 'allowed', always: true })} />);
    expect(screen.getByTestId('chat-card').textContent).toContain(S.chat.card.allowedAlways);
    rerender(<Card item={permission({ state: 'denied', message: 'use pnpm' })} />);
    expect(screen.getByTestId('chat-card').textContent).toContain(S.chat.card.deniedWith('use pnpm'));
    rerender(<Card item={permission({ state: 'elsewhere' })} />);
    expect(screen.getByTestId('chat-card').textContent).toContain(S.chat.cardState.elsewhere);
    rerender(<Card item={permission({ state: 'stale' })} />);
    expect(screen.getByTestId('chat-card').textContent).toContain(S.chat.cardState.stale);
  });

  it('хост без feed.decide — одна строка «ждёт в терминале», без кнопок', () => {
    useHostStore.setState({ status: { state: 'connected', hostVersion: '0.3.0', methods: [...REQUIRED_METHODS] } });
    render(<Card item={permission()} />);
    expect(screen.getByTestId('chat-card').textContent).toContain(S.chat.waiting);
    expect(within(screen.getByTestId('chat-card')).queryByRole('button')).toBeNull();
  });

  it('длинная команда и длинный путь переносятся и прокручиваются внутри карточки', () => {
    const command = `echo ${'x'.repeat(5_000)}`;
    const { rerender } = render(<Card item={permission({ toolInput: { command } })} />);
    const pre = screen.getByTestId('card-command');
    expect(pre.textContent).toBe(command);
    expect(pre.className).toContain('whitespace-pre-wrap');
    expect(pre.className).toContain('overflow-auto');
    const path = `/very/long/${'dir/'.repeat(80)}file.ts`;
    rerender(<Card item={permission({ toolName: 'Edit', toolInput: { file_path: path, old_string: 'a', new_string: 'b' } })} />);
    expect(screen.getByTestId('chat-card').textContent).toContain(path);
    expect(screen.getByTestId('card-before').textContent).toBe('a');
    expect(screen.getByTestId('card-after').textContent).toBe('b');
  });

  it('Write — содержимое свёрнуто до «Show content»; MCP и прочее — аргументы JSON свёрнуты', () => {
    const { rerender } = render(<Card item={permission({ toolName: 'Write', toolInput: { file_path: '/tmp/a.txt', content: 'hello file' } })} />);
    expect(screen.queryByTestId('card-content')).toBeNull();
    fireEvent.click(screen.getByText(S.chat.card.showContent));
    expect(screen.getByTestId('card-content').textContent).toBe('hello file');
    rerender(<Card item={permission({ toolName: 'mcp__srv__do', toolInput: { a: 1 } })} />);
    expect(screen.getByTestId('chat-card').textContent).toContain('srv · do');
    expect(screen.queryByTestId('card-arguments')).toBeNull();
    fireEvent.click(screen.getByText(S.chat.card.showArguments));
    expect(screen.getByTestId('card-arguments').textContent).toContain('"a": 1');
  });

  it('обрезанный вход — строка inputTruncated', () => {
    render(<Card item={permission({ truncated: true })} />);
    expect(screen.getByTestId('chat-card').textContent).toContain(S.chat.inputTruncated);
  });

  it('«Allow and don\'t ask again» — только если в suggestions есть addRules; подсказка называет правила', async () => {
    const { rerender } = render(<Card item={permission({ suggestions: [{ type: 'setMode', mode: 'acceptEdits' }] })} />);
    expect(screen.queryByTestId('card-allow-always')).toBeNull();
    rerender(
      <Card
        item={permission({
          suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }],
        })}
      />,
    );
    const always = screen.getByTestId('card-allow-always');
    expect(always.getAttribute('title')).toContain('Bash(npm test)');
    fireEvent.click(always);
    await waitFor(() => expect(decideCalls()).toHaveLength(1));
    expect(lastDecision()).toEqual({ kind: 'permission', behavior: 'allow', always: true });
  });

  it('второй клик, пока запрос в пути, второго feed.decide не шлёт; кнопки выключены', async () => {
    bridge.setHandler('feed.decide', () => new Promise(() => undefined));
    render(<Card item={permission()} />);
    fireEvent.click(screen.getByTestId('card-allow'));
    await waitFor(() => expect((screen.getByTestId('card-allow') as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByTestId('card-allow'));
    fireEvent.click(screen.getByTestId('card-deny'));
    expect(decideCalls()).toHaveLength(1);
  });

  it('«Deny» с текстом шлёт message, с пустым полем — без message', async () => {
    const { unmount } = render(<Card item={permission()} />);
    fireEvent.change(screen.getByTestId('card-deny-message'), { target: { value: '  use pnpm instead ' } });
    fireEvent.click(screen.getByTestId('card-deny'));
    await waitFor(() => expect(decideCalls()).toHaveLength(1));
    expect(lastDecision()).toEqual({ kind: 'permission', behavior: 'deny', message: 'use pnpm instead' });
    unmount();
    resetFeedStoreForTests();
    resetChatUiStoreForTests();
    useFeedStore.getState().init(bridge);
    render(<Card item={permission()} />);
    fireEvent.click(screen.getByTestId('card-deny'));
    await waitFor(() => expect(decideCalls()).toHaveLength(2));
    expect(lastDecision()).toEqual({ kind: 'permission', behavior: 'deny' });
  });

  it('хук ещё не удержан (applied false, pending) — строка «Not applied yet», кнопки снова доступны', async () => {
    bridge.setHandler('feed.decide', () => ({ applied: false, state: 'pending' as const }));
    render(<Card item={permission()} />);
    fireEvent.click(screen.getByTestId('card-allow'));
    await waitFor(() => expect(screen.getByTestId('card-note').textContent).toBe(S.chat.card.notApplied));
    expect((screen.getByTestId('card-allow') as HTMLButtonElement).disabled).toBe(false);
  });

  it('ошибка моста — строка «Couldn\'t send»', async () => {
    bridge.setHandler('feed.decide', () => {
      throw new Error('boom');
    });
    render(<Card item={permission()} />);
    fireEvent.click(screen.getByTestId('card-allow'));
    await waitFor(() => expect(screen.getByTestId('card-note').textContent).toBe(S.chat.card.failed));
  });

  it('черновик текста отказа переживает размонтирование карточки', () => {
    const first = render(<Card item={permission()} />);
    fireEvent.change(screen.getByTestId('card-deny-message'), { target: { value: 'not now' } });
    first.unmount();
    render(<Card item={permission()} />);
    expect((screen.getByTestId('card-deny-message') as HTMLInputElement).value).toBe('not now');
    expect(useChatUiStore.getState().cardDrafts[cardKey(refKey(REF), 'c1')]?.message).toBe('not now');
  });
});

describe('QuestionCard', () => {
  it('два вопроса — по одному: Next, затем Submit шлёт оба ответа; multiSelect — подписи через «, »', async () => {
    render(<Card item={question()} />);
    expect(screen.queryByTestId('card-submit')).toBeNull();
    expect((screen.getByTestId('card-next') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(option('Pear'));
    fireEvent.click(screen.getByTestId('card-next'));
    expect(screen.getByTestId('chat-card').textContent).toContain('Which toppings?');
    expect((screen.getByTestId('card-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(option('Nuts'));
    fireEvent.click(option('Cream'));
    fireEvent.click(screen.getByTestId('card-submit'));
    await waitFor(() => expect(decideCalls()).toHaveLength(1));
    expect(lastDecision()).toEqual({ kind: 'question', answers: { 'Which fruit?': 'Pear', 'Which toppings?': 'Nuts, Cream' } });
  });

  it('«Other» — свободный текст как ответ; одиночный выбор снимает вариант', async () => {
    render(<Card item={question({ questions: [question().questions[0]!] })} />);
    fireEvent.click(option('Apple'));
    fireEvent.click(screen.getByTestId('card-other'));
    expect(option('Apple').checked).toBe(false);
    expect((screen.getByTestId('card-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('card-other-text'), { target: { value: 'Mango' } });
    fireEvent.click(screen.getByTestId('card-submit'));
    await waitFor(() => expect(decideCalls()).toHaveLength(1));
    expect(lastDecision()).toEqual({ kind: 'question', answers: { 'Which fruit?': 'Mango' } });
  });

  it('multiSelect — «Other» добавляется к выбранным подписям', async () => {
    render(<Card item={question({ questions: [question().questions[1]!] })} />);
    fireEvent.click(option('Nuts'));
    fireEvent.click(screen.getByTestId('card-other'));
    fireEvent.change(screen.getByTestId('card-other-text'), { target: { value: 'Honey' } });
    fireEvent.click(screen.getByTestId('card-submit'));
    await waitFor(() => expect(decideCalls()).toHaveLength(1));
    expect(lastDecision()).toEqual({ kind: 'question', answers: { 'Which toppings?': 'Nuts, Honey' } });
  });

  it('выбор и шаг переживают размонтирование карточки', () => {
    const first = render(<Card item={question()} />);
    fireEvent.click(option('Apple'));
    fireEvent.click(screen.getByTestId('card-next'));
    first.unmount();
    render(<Card item={question()} />);
    expect(screen.getByTestId('chat-card').textContent).toContain('Which toppings?');
    expect(useChatUiStore.getState().cardDrafts[cardKey(refKey(REF), 'q1')]?.picked[0]).toEqual(['Apple']);
  });

  it('отвечено — ответы списком «вопрос — ответ»; elsewhere и stale — прежние строки', () => {
    const { rerender } = render(<Card item={question({ state: 'answered', answers: { 'Which fruit?': 'Pear' } })} />);
    expect(screen.getByTestId('card-answers').textContent).toBe('Which fruit? — Pear');
    expect(screen.getByTestId('chat-card').textContent).toContain(S.chat.cardState.answered);
    rerender(<Card item={question({ state: 'elsewhere' })} />);
    expect(screen.getByTestId('chat-card').textContent).toContain(S.chat.cardState.elsewhere);
    rerender(<Card item={question({ state: 'stale' })} />);
    expect(screen.getByTestId('chat-card').textContent).toContain(S.chat.cardState.stale);
  });
});

describe('PlanCard', () => {
  it('план Markdown-ом; «auto-accept» и «manual» шлют выбор', async () => {
    const { unmount } = render(<Card item={plan()} />);
    expect(within(screen.getByTestId('card-plan')).getByText('Do the thing')).toBeTruthy();
    fireEvent.click(screen.getByTestId('card-approve-auto'));
    await waitFor(() => expect(decideCalls()).toHaveLength(1));
    expect(lastDecision()).toEqual({ kind: 'plan', choice: 'auto-accept' });
    unmount();
    resetFeedStoreForTests();
    useFeedStore.getState().init(bridge);
    render(<Card item={plan()} />);
    fireEvent.click(screen.getByTestId('card-approve-manual'));
    await waitFor(() => expect(decideCalls()).toHaveLength(2));
    expect(lastDecision()).toEqual({ kind: 'plan', choice: 'manual' });
  });

  it('«Change the plan in the terminal» решения не шлёт — вкладка уходит в вид terminal', () => {
    useLayoutStore.getState().hydrate(WORK, openTab(emptyLayout(), { kind: 'terminal', id: TAB, sessionId: 's-01', view: 'chat' }));
    render(<Card item={plan()} />);
    fireEvent.click(screen.getByTestId('card-open-terminal'));
    expect(decideCalls()).toHaveLength(0);
    const tab = groups(useLayoutStore.getState().layouts[WORK]!).flatMap((group) => group.tabs).find((entry) => entry.id === TAB);
    expect(tab).toMatchObject({ kind: 'terminal', view: 'terminal' });
  });

  it('обрезанный план — строка inputTruncated; решённый — подпись выбора', () => {
    const { rerender } = render(<Card item={plan({ truncated: true })} />);
    expect(screen.getByTestId('chat-card').textContent).toContain(S.chat.inputTruncated);
    rerender(<Card item={plan({ state: 'allowed', choice: 'auto-accept' })} />);
    expect(screen.getByTestId('chat-card').textContent).toContain(S.chat.card.planApproved['auto-accept']);
    rerender(<Card item={plan({ state: 'allowed', choice: 'manual' })} />);
    expect(screen.getByTestId('chat-card').textContent).toContain(S.chat.card.planApproved.manual);
    rerender(<Card item={plan({ state: 'elsewhere' })} />);
    expect(screen.getByTestId('chat-card').textContent).toContain(S.chat.cardState.elsewhere);
    rerender(<Card item={plan({ state: 'stale' })} />);
    expect(screen.getByTestId('chat-card').textContent).toContain(S.chat.cardState.stale);
  });
});
