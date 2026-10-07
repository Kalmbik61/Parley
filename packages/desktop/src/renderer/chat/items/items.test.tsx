/**
 * Элементы ленты вида «Chat» (план 2026-10-01, Task 3, п. 2) на настоящих фикстурах core: события хуков
 * проб разведки (`*.events.jsonl`) прогоняются через `applyHookEvent`, журналы — через
 * `feedFromTranscript` (модуль ленты core — по пути исходников, см. импорт). Плюс крайние случаи Review Focus 2: длинная команда и путь, результат 64 КБ,
 * дифф на 5 000 строк, агент с длинным описанием и 50 вложенными вызовами.
 */

import { useState } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FeedAgent, FeedItem, FeedState, FeedTool } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { ChatEnvContext } from '../chat-env.js';
import { FeedList } from '../FeedList.js';
import { resetThumbnailCacheForTests } from '../use-thumbnail.js';
import { AgentItem, type Transcript } from './AgentItem.js';
import { PromptItem } from './PromptItem.js';
import { ToolItem } from './ToolItem.js';
// Редьюсер и разбор журнала — прямо из исходников ленты core, а не из `@parley/core`: корневой модуль
// тянет `work/mcp-config.ts`, а тот на загрузке строит путь из `import.meta.url`, которого под jsdom нет.
import { applyHookEvent, emptyFeedState, feedFromTranscript } from '../../../../../core/src/feed/index.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../core/src/feed/fixtures');
const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const AT = '2026-10-01T00:00:00.000Z';

function jsonl(name: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Поток событий пробы через редьюсер core — как его соберёт хост из HTTP-хуков. */
function replay(probe: string): FeedState {
  let state = emptyFeedState();
  for (const line of jsonl(`${probe}.events.jsonl`)) {
    if (line['ev'] === undefined) continue;
    state = applyHookEvent(state, line['ev'], new Date(line['t'] as number).toISOString()).state;
  }
  return state;
}

const transcript = (name: string): FeedState => feedFromTranscript(jsonl(`${name}.jsonl`));

let bridge: FakeBridge;

function renderWithEnv(node: JSX.Element): ReturnType<typeof render> {
  bridge = createFakeBridge();
  return render(<ChatEnvContext.Provider value={{ bridge, sessionRef: REF }}>{node}</ChatEnvContext.Provider>);
}

function renderFeed(items: readonly FeedItem[]): ReturnType<typeof render> {
  return renderWithEnv(
    <div style={{ height: 600 }}>
      <FeedList items={items} queued={[]} note={null} />
    </div>,
  );
}

function tool(patch: Partial<FeedTool> = {}): FeedTool {
  return { id: 't1', at: AT, kind: 'tool', toolUseId: 'tu1', name: 'Bash', input: { command: 'ls' }, status: 'done', ...patch };
}

function agent(patch: Partial<FeedAgent> = {}): FeedAgent {
  return {
    id: 'a1',
    at: AT,
    kind: 'agent',
    toolUseId: 'tu-a',
    agentId: 'ag1',
    agentType: 'Explore',
    description: 'List project files',
    prompt: 'List files',
    model: 'haiku',
    background: true,
    status: 'running',
    toolCount: 0,
    children: [],
    ...patch,
  };
}

/**
 * virtual-core мерит прокрутчик `offsetHeight` (в jsdom — 0, и список был бы пуст): у прокрутчиков ленты
 * и диффа — 600 px, у прочего — 0, поэтому элементы ленты «нулевой высоты» видны все.
 */
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
beforeEach(() => {
  resetThumbnailCacheForTests();
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      const id = this.getAttribute('data-testid');
      return id === 'chat-feed' || id === 'chat-diff' ? 600 : 0;
    },
  });
});

afterEach(() => {
  cleanup();
  if (originalOffsetHeight !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
});

describe('лента на фикстурах core', () => {
  it('p1: промпт, текст ответа Markdown и черта конца хода', () => {
    const { items } = replay('p1-stream');
    renderFeed(items);
    // Число строк каждого вида — столько же, сколько элементов этого вида в ленте пробы.
    const count = (kind: FeedItem['kind']): number => items.filter((item) => item.kind === kind).length;
    expect(count('prompt')).toBeGreaterThan(0);
    expect(screen.getAllByTestId('chat-prompt')).toHaveLength(count('prompt'));
    expect(screen.getAllByTestId('chat-text')).toHaveLength(count('text'));
    expect(screen.getAllByTestId('chat-turn')).toHaveLength(count('turn'));
    const firstPrompt = items.find((item) => item.kind === 'prompt');
    expect(screen.getAllByTestId('chat-prompt')[0]!.textContent).toBe(firstPrompt?.kind === 'prompt' ? firstPrompt.text.trim() : null);
    expect(screen.queryByTestId('chat-streaming')).toBeNull();
  });

  it('p2: вызов Bash и снятая карточка разрешения — «Answered in the terminal», без кнопок решения', () => {
    const { items } = replay('p2-permissions');
    renderFeed(items);
    // Лента виртуальная: сверяем строки, что в DOM, с их элементами по `data-feed-id`.
    const rendered = new Set([...document.querySelectorAll('[data-feed-id]')].map((row) => row.getAttribute('data-feed-id')));
    const inDom = (kind: FeedItem['kind']): number => items.filter((item) => item.kind === kind && rendered.has(item.id)).length;
    const tools = screen.getAllByTestId('chat-tool');
    expect(tools).toHaveLength(inDom('tool'));
    expect(tools[0]!.querySelector('[data-tool-name]')?.textContent).toBe('Bash');
    const cards = screen.getAllByTestId('chat-card');
    expect(cards).toHaveLength(inDom('permission'));
    expect(cards.some((card) => card.getAttribute('data-card-state') === 'elsewhere')).toBe(true);
    expect(screen.getAllByText(S.chat.cardState.elsewhere).length).toBeGreaterThan(0);
    // Решение контролёра И: ни одной кнопки Allow/Deny.
    expect(screen.queryByRole('button', { name: /allow|deny/i })).toBeNull();
  });

  it('p4: карточки вопроса и плана — вид и сводка (вопрос)', () => {
    const { items } = replay('p4-questions-plan');
    renderFeed(items);
    const kinds = screen.getAllByTestId('chat-card').map((card) => card.getAttribute('data-card-kind'));
    expect(kinds).toContain('question');
    expect(kinds).toContain('plan');
  });

  it('p5b журнал: вызов Edit с диффом -beta/+gamma, номера строк и цвета ревью', () => {
    const { items } = transcript('transcript-p5b-write');
    renderFeed(items);
    const edits = screen.getAllByTestId('chat-tool').filter((row) => row.querySelector('[data-tool-name]')?.textContent === 'Edit');
    expect(edits).toHaveLength(1);
    const edit = edits[0]!;
    fireEvent.click(within(edit).getByRole('button'));
    const diff = within(edit).getByTestId('chat-diff');
    const added = diff.querySelector('[data-diff-row="added"]')!;
    const removed = diff.querySelector('[data-diff-row="removed"]')!;
    expect(added.textContent).toContain('gamma');
    expect(added.className).toContain('--diff-added-ground');
    expect(removed.textContent).toContain('beta');
    expect(removed.className).toContain('--diff-removed-ground');
    // Номера: «-beta» — вторая строка старого файла, «+gamma» — вторая нового.
    expect(removed.textContent).toMatch(/^2/);
    expect(added.textContent).toMatch(/^2/);
  });

  it('p6b: карточка агента Explore, «agent reported» — служебная строка, а не промпт', () => {
    const { items } = replay('p6b-subagents');
    renderFeed(items);
    const card = screen.getByTestId('chat-agent');
    expect(card.textContent).toContain('List project files');
    expect(card.getAttribute('data-agent-status')).toBe('done');
    expect(screen.getAllByTestId('chat-notice').some((row) => row.getAttribute('data-notice') === 'agent-reported')).toBe(true);
  });

  it('streaming — курсор за текстом, пока текст пишется', () => {
    renderFeed([{ id: 'x', at: AT, kind: 'text', messageId: 'm', text: 'Hello', streaming: true }]);
    expect(screen.getByTestId('chat-streaming').getAttribute('aria-label')).toBe(S.chat.streaming);
  });

  it('прерванный ход — черта «Interrupted · 12s» с предупреждающим цветом и меткой (живая проверка 2026-10-02)', () => {
    renderFeed([{ id: 'u', at: AT, kind: 'turn', durationMs: 12_000, interrupted: true }]);
    const line = screen.getByTestId('chat-turn');
    expect(line.textContent).toBe('Interrupted · 12s');
    expect(line.hasAttribute('data-turn-interrupted')).toBe(true);
    expect(line.className).toContain('--status-warning-text');
  });

  it('прерванный ход без длительности — «Interrupted»; обычный конец хода метки не имеет', () => {
    renderFeed([{ id: 'u', at: AT, kind: 'turn', durationMs: null, interrupted: true }]);
    expect(screen.getByTestId('chat-turn').textContent).toBe('Interrupted');
    cleanup();
    renderFeed([{ id: 'u', at: AT, kind: 'turn', durationMs: 5000 }]);
    expect(screen.getByTestId('chat-turn').hasAttribute('data-turn-interrupted')).toBe(false);
  });

  it('усечённый текст — пометка', () => {
    renderFeed([{ id: 'x', at: AT, kind: 'text', messageId: 'm', text: 'Hello', streaming: false, truncated: true }]);
    expect(screen.getByTestId('chat-text').textContent).toBe(`Hello${S.chat.textTruncated}`);
  });

  it('промпт с картинками — их число; notice, error и turn — свои строки', () => {
    renderFeed([
      { id: 'p', at: AT, kind: 'prompt', text: 'look', images: 2 },
      { id: 'n', at: AT, kind: 'notice', notice: { type: 'session-start', source: 'startup', model: 'claude-opus-5-5' } },
      { id: 'n2', at: AT, kind: 'notice', notice: { type: 'compact', phase: 'post', trigger: 'auto' } },
      { id: 'n3', at: AT, kind: 'notice', notice: { type: 'model-switch', from: 'a', to: 'b', source: 'user' } },
      { id: 'n4', at: AT, kind: 'notice', notice: { type: 'session-end', reason: 'exit' } },
      { id: 'e', at: AT, kind: 'error', error: 'rate_limit', message: 'Too many requests' },
      { id: 'u', at: AT, kind: 'turn', durationMs: 4648 },
    ]);
    expect(screen.getByTestId('chat-prompt').textContent).toBe(`look${S.chat.images(2)}`);
    expect(screen.getAllByTestId('chat-notice').map((row) => row.textContent)).toEqual([
      'Session started · claude-opus-5-5',
      'Conversation compacted',
      'Model: a → b',
      'Session ended · exit',
    ]);
    expect(screen.getByRole('alert').textContent).toContain('Too many requests');
    expect(screen.getByTestId('chat-turn').textContent).toBe('Turn finished · 5s');
  });

  it('codex-history-in-terminal — строка окна и кнопка «Open terminal»', () => {
    renderFeed([{ id: 'e', at: AT, kind: 'error', error: 'codex-history-in-terminal', message: null }]);
    expect(screen.getByTestId('chat-error').textContent).toContain(S.chat.codexHistoryInTerminal);
    expect(screen.getByRole('button', { name: S.chat.openTerminal })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ожидающая карточка — «ждёт ответа в терминале» с командой, без кнопок', () => {
    renderFeed([
      {
        id: 'c',
        at: AT,
        kind: 'permission',
        cardId: 'c',
        state: 'pending',
        toolUseId: null,
        toolName: 'Bash',
        toolInput: { command: 'rm -rf build' },
        suggestions: [],
        notified: false,
      },
    ]);
    const card = screen.getByTestId('chat-card');
    expect(card.textContent).toContain('rm -rf build');
    expect(card.textContent).toContain(S.chat.waiting);
    expect(within(card).queryByRole('button')).toBeNull();
  });
});

describe('PromptItem — вложения: хвостовые упоминания @"путь" чипами', () => {
  const PNG = 'data:image/png;base64,AAAA';
  const paths = (): Array<string | null> => screen.getAllByTestId('chat-attachment').map((chip) => chip.getAttribute('data-path'));

  /** Элемент в окружении ленты с заданным мостом: миниатюры берутся у него. */
  function renderPrompt(node: JSX.Element, fake: FakeBridge = createFakeBridge()): ReturnType<typeof render> {
    return render(<ChatEnvContext.Provider value={{ bridge: fake, sessionRef: REF }}>{node}</ChatEnvContext.Provider>);
  }

  it('текст и упоминания: чипы над текстом по порядку, самих путей в пузыре нет', () => {
    renderPrompt(<PromptItem text={'what is this? @"/a/notes.txt" @"/a/b c.pdf" '} />);
    expect(paths()).toEqual(['/a/notes.txt', '/a/b c.pdf']);
    const bubble = screen.getByTestId('chat-prompt');
    expect(bubble.textContent).not.toContain('@');
    expect(bubble.textContent).not.toContain('/a/');
    const text = screen.getByText('what is this?');
    const firstChip = screen.getAllByTestId('chat-attachment')[0]!;
    expect(firstChip.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('только упоминания — текста нет, в пузыре одни чипы', () => {
    renderPrompt(<PromptItem text={'@"/a/notes.txt" '} />);
    expect(paths()).toEqual(['/a/notes.txt']);
    expect(screen.getByTestId('chat-prompt').textContent).toBe('notes.txt');
  });

  it('картинка — миниатюра из моста (без подписи пути), файл — чип с именем; без миниатюры картинка тоже чип', async () => {
    const fake = createFakeBridge();
    fake.setThumbnail('/h/drops/a.png', PNG);
    renderPrompt(<PromptItem text={'look @"/h/drops/a.png" @"/a/doc.pdf" @"/h/drops/gone.png"'} />, fake);
    await waitFor(() => expect(screen.getByRole('img', { name: 'a.png' }).getAttribute('src')).toBe(PNG));
    const [shot, doc, gone] = screen.getAllByTestId('chat-attachment');
    expect(shot!.hasAttribute('data-thumbnail')).toBe(true);
    expect(screen.getByRole('img', { name: 'a.png' }).getAttribute('title')).toBe('/h/drops/a.png');
    expect(doc!.textContent).toBe('doc.pdf');
    expect(doc!.getAttribute('title')).toBe('/a/doc.pdf');
    expect(gone!.textContent).toBe('gone.png');
    expect(gone!.querySelector('img')).toBeNull();
    expect(screen.getByTestId('chat-prompt').textContent).toBe('doc.pdfgone.pnglook');
    // Миниатюру просят только у картинок, и по разу на путь.
    expect([...fake.thumbnailCalls].sort()).toEqual(['/h/drops/a.png', '/h/drops/gone.png']);
  });

  it('вне окружения ленты (моста нет) промпт рисуется: чип без миниатюры, без исключения', () => {
    render(<PromptItem text={'@"/h/drops/a.png" '} />);
    expect(screen.getByTestId('chat-attachment').textContent).toBe('a.png');
    expect(screen.queryByRole('img', { name: 'a.png' })).toBeNull();
  });

  it('упоминание посреди текста, относительные и shell-кавычки остаются текстом, чипов нет', () => {
    renderPrompt(<PromptItem text={`see @"/a.png" and @src/a.ts or '/h/a #1.png' `} />);
    expect(screen.queryByTestId('chat-attachment')).toBeNull();
    expect(screen.getByTestId('chat-prompt').textContent).toBe(`see @"/a.png" and @src/a.ts or '/h/a #1.png'`);
  });

  it('серый элемент очереди — те же чипы, подпись «Queued» и текст без путей', () => {
    renderPrompt(<PromptItem text={'next @"/a/notes.txt" '} queued />);
    const grey = screen.getByTestId('chat-queued');
    expect(within(grey).getByTestId('chat-attachment').getAttribute('data-path')).toBe('/a/notes.txt');
    expect(grey.textContent).toBe(`notes.txtnext${S.chat.queued}`);
  });

  it('лента: промпт и серый элемент очереди рисуют упоминания чипами', () => {
    renderWithEnv(
      <div style={{ height: 600 }}>
        <FeedList
          items={[{ id: 'p', at: AT, kind: 'prompt', text: 'one @"/x/y.txt" ', images: 0 }]}
          queued={[{ id: 'q1', text: 'two @"/x/z.txt" ' }]}
          note={null}
        />
      </div>,
    );
    expect(within(screen.getByTestId('chat-prompt')).getByTestId('chat-attachment').getAttribute('data-path')).toBe('/x/y.txt');
    expect(within(screen.getByTestId('chat-queued')).getByTestId('chat-attachment').getAttribute('data-path')).toBe('/x/z.txt');
    expect(screen.getByTestId('chat-feed').textContent).not.toContain('/x/');
  });

  it('промпт без вложений — прежний вид: один текст; пустой текст с картинками — только подпись числа', () => {
    renderPrompt(<PromptItem text={'  plain words\n'} />);
    expect(screen.getByTestId('chat-prompt').textContent).toBe('plain words');
    expect(screen.queryByTestId('chat-attachment')).toBeNull();
    cleanup();
    renderPrompt(<PromptItem text="" images={1} />);
    expect(screen.getByTestId('chat-prompt').textContent).toBe(S.chat.images(1));
  });
});

describe('ToolItem', () => {
  const renderTool = (item: FeedTool): ReturnType<typeof render> => renderWithEnv(<ToolItem item={item} />);

  it('строка: Bash — команда, Edit — путь, MCP — сервер и инструмент, прочее — имя', () => {
    renderTool(tool({ id: 'a', input: { command: 'pnpm test' } }));
    renderTool(tool({ id: 'b', name: 'Edit', input: { file_path: '/src/a.ts' } }));
    renderTool(tool({ id: 'c', name: 'mcp__parley__send_message', input: {} }));
    renderTool(tool({ id: 'd', name: 'Glob', input: { pattern: '*.ts' } }));
    const rows = screen.getAllByTestId('chat-tool').map((row) => [
      row.querySelector('[data-tool-name]')?.textContent,
      row.querySelector('[data-tool-summary]')?.textContent ?? null,
    ]);
    expect(rows).toEqual([
      ['Bash', 'pnpm test'],
      ['Edit', '/src/a.ts'],
      ['parley · send_message', null],
      ['Glob', null],
    ]);
  });

  it('статусы: running — спиннер, failed и rejected — словом', () => {
    renderTool(tool({ id: 'a', status: 'running' }));
    renderTool(tool({ id: 'b', status: 'failed' }));
    renderTool(tool({ id: 'c', status: 'rejected' }));
    expect(document.querySelector('[data-status="running"]')?.getAttribute('class')).toContain('animate-spin');
    const [running, failed, rejected] = screen.getAllByTestId('chat-tool');
    expect(running!.querySelector('button')?.textContent).toBe('Bashls');
    expect(failed!.querySelector('button')?.textContent).toBe(`Bashls${S.chat.toolStatus.failed}`);
    expect(rejected!.querySelector('button')?.textContent).toBe(`Bashls${S.chat.toolStatus.rejected}`);
    expect(failed!.querySelector('[data-status="failed"]')?.getAttribute('aria-label')).toBe('Failed');
  });

  it('длинная команда (2 000 символов) и путь (300) обрезаются многоточием, а не раздвигают строку', () => {
    const command = 'x'.repeat(2_000);
    const file = `/${'dir/'.repeat(74)}file.ts`;
    renderTool(tool({ id: 'a', input: { command } }));
    renderTool(tool({ id: 'b', name: 'Write', input: { file_path: file } }));
    const summaries = [...document.querySelectorAll('[data-tool-summary]')];
    expect(summaries.map((node) => node.textContent?.length)).toEqual([2_000, file.length]);
    for (const node of summaries) {
      expect(node.className).toContain('truncate');
      expect(node.className).toContain('min-w-0');
    }
    for (const row of screen.getAllByRole('button')) expect(row.className).toContain('min-w-0');
  });

  it('раскрытие: аргументы JSON и результат; усечённый 64 КБ результат — пометка открыть терминал', () => {
    const text = 'y'.repeat(64 * 1024);
    renderTool(tool({ response: { text, size: 2 * 1024 * 1024, truncated: true } }));
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('chat-tool-details').querySelector('pre')?.textContent).toBe('{\n  "command": "ls"\n}');
    const result = screen.getByTestId('chat-tool-result');
    expect(result.textContent).toHaveLength(64 * 1024);
    expect(result.className).toContain('max-h-60');
    expect(result.className).toContain('overflow-auto');
    expect(result.nextElementSibling?.textContent).toBe(S.chat.resultTruncated);
  });

  it('дифф на 5 000 строк рисуется виртуально: в DOM строк меньше, чем в данных; прокрутка — другие строки', () => {
    const lines = Array.from({ length: 5_000 }, (_, at) => `+line ${at}`);
    renderTool(tool({ name: 'Write', patch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 5_000, lines }], patchTruncated: true }));
    fireEvent.click(screen.getByRole('button'));
    const diff = screen.getByTestId('chat-diff');
    /** Номера новой строки в DOM (вторая колонка), без заголовка хунка. */
    const numbers = (): number[] =>
      [...diff.querySelectorAll('[data-diff-row="added"]')].map((row) => Number(row.children[1]!.textContent));
    const top = numbers();
    expect(diff.querySelectorAll('[data-diff-row]').length).toBeLessThan(200);
    expect(top[0]).toBe(1);
    expect(top).not.toContain(4_000);
    // Прокрутка к 4 000-й строке (18 px на строку): в DOM — строки около неё, первых больше нет.
    act(() => {
      diff.scrollTop = 4_000 * 18;
      fireEvent.scroll(diff);
    });
    const scrolled = numbers();
    expect(scrolled).toContain(4_000);
    expect(scrolled).not.toContain(1);
    expect(diff.querySelectorAll('[data-diff-row]').length).toBeLessThan(200);
    expect(diff.nextElementSibling?.textContent).toBe(S.chat.patchTruncated);
  });
});

/** Карточка агента с состоянием транскрипта рядом — как его держит лента. */
function AgentHarness({ item, expanded }: { item: FeedAgent; expanded: boolean }): JSX.Element {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  return <AgentItem item={item} expanded={expanded} onToggle={() => undefined} transcript={transcript} onTranscript={setTranscript} />;
}

describe('AgentItem', () => {
  const renderAgent = (item: FeedAgent, expanded = false): ReturnType<typeof render> =>
    renderWithEnv(<AgentHarness item={item} expanded={expanded} />);

  it('running — спиннер и «Running»; done — длительность и число вызовов; failed — «Failed»', () => {
    renderAgent(agent({ id: 'r' }));
    renderAgent(agent({ id: 'd', status: 'done', durationMs: 65_000, toolCount: 3, endedAt: AT }));
    renderAgent(agent({ id: 'f', status: 'failed', toolCount: 1 }));
    const [running, done, failed] = screen.getAllByTestId('chat-agent');
    expect(running!.querySelector('.animate-spin')).not.toBeNull();
    expect(running!.textContent).toContain(S.chat.agent.status.running);
    expect(done!.textContent).toContain('1m');
    expect(done!.textContent).toContain(S.chat.agent.toolCalls(3));
    expect(done!.querySelector('.animate-spin')).toBeNull();
    expect(failed!.textContent).toContain(S.chat.agent.status.failed);
    expect(failed!.textContent).toContain(S.chat.agent.toolCalls(1));
  });

  it('длинное описание (300 символов) — одной обрезанной строкой', () => {
    const description = 'd'.repeat(300);
    renderAgent(agent({ description }));
    const title = document.querySelector('[data-agent-title]')!;
    expect(title.textContent).toBe(description);
    expect(title.className).toContain('truncate');
  });

  it('развёрнуто: 50 вложенных вызовов сжатыми строками и итоговый текст', () => {
    const children = Array.from({ length: 50 }, (_, at) => tool({ id: `c${at}`, toolUseId: `cu${at}`, agentId: 'ag1', input: { command: `echo ${at}` } }));
    renderAgent(agent({ status: 'done', toolCount: 50, children, result: 'All **done**' }), true);
    expect(within(screen.getByTestId('chat-agent-children')).getAllByTestId('chat-tool')).toHaveLength(50);
    expect(screen.getByText('done').tagName).toBe('STRONG');
  });

  it('«Show transcript» зовёт feed.snapshot с agentId и рисует ленту субагента; второе нажатие сворачивает', async () => {
    renderAgent(agent({ status: 'done' }), true);
    const sub = transcript('transcript-p6b-agent-ad2fe21e96ffde3ba');
    bridge.setHandler('feed.snapshot', () => ({ items: [...sub.items], revision: 0, schemaVersion: 1 }));
    fireEvent.click(screen.getByRole('button', { name: S.chat.showTranscript }));
    expect(bridge.calls).toContainEqual({ method: 'feed.snapshot', params: { ref: REF, agentId: 'ag1' } });
    const area = await screen.findByTestId('chat-agent-transcript');
    expect(within(area).getAllByTestId('chat-tool').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: S.chat.hideTranscript }));
    expect(screen.queryByTestId('chat-agent-transcript')).toBeNull();
  });

  it('ошибка снимка субагента — подсказка открыть терминал', async () => {
    renderAgent(agent({ status: 'done' }), true);
    fireEvent.click(screen.getByRole('button', { name: S.chat.showTranscript }));
    await waitFor(() =>
      expect(screen.getByTestId('chat-agent-details').lastElementChild?.textContent).toBe(S.chat.agent.transcriptFailed),
    );
  });

  it('в ленте два агента подряд — стопкой (меньший отступ у второго)', () => {
    renderFeed([agent({ id: 'a1' }), agent({ id: 'a2', agentId: 'ag2' })]);
    const rows = [...document.querySelectorAll('[data-feed-id]')];
    expect(rows[0]!.className).toContain('pt-3');
    expect(rows[1]!.className).toContain('pt-1');
  });
});
