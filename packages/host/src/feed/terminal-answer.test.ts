import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { recogniseCodexPrompt } from '@parley/core';
import type { CodexPrompt } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { ANSWER_POLL_MS, ANSWER_STEP_MAX_MS, cleanAnswer, typeOwnAnswer } from './terminal-answer.js';

const PROMPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../core/src/feed/codex/__fixtures__/prompts');
const screenOf = (name: string): string[] => readFileSync(path.join(PROMPTS, `${name}.txt`), 'utf8').split('\n');
const REF: SessionRef = { projectPath: '/proj', workId: 'w-1', sessionId: 's-01' };
const DOWN = '\u001b[B';
const TEXT = 'purple please';

/** Экран вопроса с меткой › на варианте `at`: номера и подписи прежние, сдвигается только метка. */
function withSelected(lines: readonly string[], at: number): string[] {
  return lines.map((line) => {
    const match = /^\s*›?\s*(\d)\. (.*)$/.exec(line);
    if (match === null) return line;
    return `  ${Number(match[1]) - 1 === at ? '› ' : '  '}${match[1]}. ${match[2]}`;
  });
}

type Stuck = 'arrow' | 'tab' | 'text' | 'enter';

/** Сценарный экран Codex: вопрос → поле заметок → текст → ответ; `stuck` — шаг, который Codex не принял. */
function scenario(options: { selected?: number; stuck?: Stuck; screen?: string[] } = {}) {
  type State = 'prompt' | 'notes' | 'typed' | 'answered';
  let state: State = 'prompt';
  let selected = options.selected ?? 0;
  const base = screenOf('question-options-80x24');
  const writes: string[] = [];
  const view = (): string[] =>
    options.screen ??
    (state === 'prompt'
      ? withSelected(base, selected)
      : state === 'notes'
        ? screenOf('question-notes-open-80x24')
        : state === 'typed'
          ? screenOf('question-notes-typed-80x24')
          : screenOf('question-answered-80x24'));
  const pty = {
    screenText: (): string[] => view(),
    write: (_ref: SessionRef, data: string): void => {
      writes.push(data);
      if (state === 'prompt') {
        if (data === DOWN && options.stuck !== 'arrow') selected += 1;
        else if (data === '\t' && selected === 3 && options.stuck !== 'tab') state = 'notes';
      } else if (state === 'notes') {
        if (data !== '\r' && options.stuck !== 'text') state = 'typed';
      } else if (state === 'typed') {
        if (data === '\r' && options.stuck !== 'enter') state = 'answered';
      }
    },
  };
  return { pty, writes };
}

function promptOf(lines: readonly string[]): CodexPrompt & { kind: 'question' } {
  const found = recogniseCodexPrompt(lines);
  if (found === null || found.kind !== 'question') throw new Error('вопрос не узнан');
  return found;
}

const run = (setup: ReturnType<typeof scenario>, text = TEXT, prompt = promptOf(screenOf('question-options-80x24')), cancelled?: () => boolean) => {
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
  const outcome = typeOwnAnswer({ pty: setup.pty, sleep, ...(cancelled === undefined ? {} : { cancelled }) }, REF, prompt, text);
  return { outcome, sleep };
};

describe('typeOwnAnswer', () => {
  it('полный путь: стрелка вниз три раза, Tab, текст, Enter — done', async () => {
    const setup = scenario();
    const { outcome } = run(setup);
    await expect(outcome).resolves.toBe('done');
    expect(setup.writes).toEqual([DOWN, DOWN, DOWN, '\t', TEXT, '\r']);
  });

  it('метка уже на последнем варианте — стрелок нет', async () => {
    const setup = scenario({ selected: 3 });
    await expect(run(setup).outcome).resolves.toBe('done');
    expect(setup.writes).toEqual(['\t', TEXT, '\r']);
  });

  it('экран не тот на первом шаге — записей нет, screen-changed', async () => {
    const setup = scenario({ screen: screenOf('patch-approval-80x24') });
    await expect(run(setup).outcome).resolves.toBe('screen-changed');
    expect(setup.writes).toEqual([]);
  });

  it('вопрос другой (отпечаток не совпал) — записей нет', async () => {
    const setup = scenario({ screen: screenOf('question-two-second-80x24') });
    await expect(run(setup).outcome).resolves.toBe('screen-changed');
    expect(setup.writes).toEqual([]);
  });

  it('стрелка не сдвинула метку — после неё записей нет, timeout за 1,5 с ожидания', async () => {
    const setup = scenario({ stuck: 'arrow' });
    const { outcome, sleep } = run(setup);
    await expect(outcome).resolves.toBe('timeout');
    expect(setup.writes).toEqual([DOWN]);
    expect(sleep).toHaveBeenCalledTimes(ANSWER_STEP_MAX_MS / ANSWER_POLL_MS);
    expect(sleep).toHaveBeenCalledWith(ANSWER_POLL_MS);
  });

  it('поле заметок не открылось — после Tab записей нет, timeout', async () => {
    const setup = scenario({ stuck: 'tab' });
    await expect(run(setup).outcome).resolves.toBe('timeout');
    expect(setup.writes).toEqual([DOWN, DOWN, DOWN, '\t']);
  });

  it('текст не появился на экране — Enter не нажимается, timeout', async () => {
    const setup = scenario({ stuck: 'text' });
    await expect(run(setup).outcome).resolves.toBe('timeout');
    expect(setup.writes).toEqual([DOWN, DOWN, DOWN, '\t', TEXT]);
  });

  it('вопрос не ушёл после Enter — timeout', async () => {
    const setup = scenario({ stuck: 'enter' });
    await expect(run(setup).outcome).resolves.toBe('timeout');
    expect(setup.writes).toEqual([DOWN, DOWN, DOWN, '\t', TEXT, '\r']);
  });

  it('хост останавливается — клавиш нет', async () => {
    const setup = scenario();
    await expect(run(setup, TEXT, undefined, () => true).outcome).resolves.toBe('screen-changed');
    expect(setup.writes).toEqual([]);
  });

  it('управляющие знаки в тексте не доходят до терминала: Enter внутри ответа не отправил бы вопрос раньше времени', async () => {
    const setup = scenario();
    await run(setup, 'one\r\ntwo\u001b[A').outcome;
    expect(setup.writes.slice(0, 4)).toEqual([DOWN, DOWN, DOWN, '\t']);
    const typed = setup.writes[4];
    expect(typed).toBe('one two [A');
    for (const control of ['\r', '\n', '\u001b']) expect(typed?.includes(control)).toBe(false);
  });

  it('пустой ответ — ничего не печатается', async () => {
    const setup = scenario();
    await expect(run(setup, ' \r\n ').outcome).resolves.toBe('timeout');
    expect(setup.writes).toEqual([]);
  });
});

describe('cleanAnswer', () => {
  it('подряд идущие управляющие знаки — один пробел, края без пробелов', () => {
    expect(cleanAnswer('a\r\n\tb')).toBe('a b');
    expect(cleanAnswer('\u0007 x ')).toBe('x');
    expect(cleanAnswer('plain text')).toBe('plain text');
  });
});
