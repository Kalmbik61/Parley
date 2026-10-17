import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyAssistantError, parseClaudeLine, parseCodexLine, type AssistantStreamEvent } from './stream.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/assistant');
const events = (file: string, parse: (line: string) => AssistantStreamEvent[]): AssistantStreamEvent[] =>
  readFileSync(path.join(FIXTURES, file), 'utf8').split('\n').flatMap(parse);
const text = (list: AssistantStreamEvent[]): string =>
  list.flatMap((event) => (event.type === 'text' ? [event.delta] : [])).join('');

describe('parseClaudeLine', () => {
  it('ход с инструментом: id сессии, инструмент без префикса, текст, конец', () => {
    const list = events('claude-tool.jsonl', parseClaudeLine);
    expect(list[0]).toMatchObject({ type: 'session' });
    expect(list.some((event) => event.type === 'tool' && event.name === 'parley_overview')).toBe(true);
    expect(text(list)).toMatch(/^\s*\[\[calm\]\]/);
    expect(list.at(-1)).toEqual({ type: 'done' });
  });
  it('resume: тот же формат', () => {
    expect(events('claude-tool-resume.jsonl', parseClaudeLine).at(-1)).toEqual({ type: 'done' });
  });
  it('propose_message: аргументы инструмента доходят', () => {
    const tool = events('claude-propose-message.jsonl', parseClaudeLine).find(
      (event): event is Extract<AssistantStreamEvent, { type: 'tool' }> => event.type === 'tool' && event.name === 'propose_message',
    );
    expect(tool?.input).toMatchObject({ text: expect.any(String) });
  });
  it('неверный --resume — ошибка resume', () => {
    expect(events('claude-err-resume.jsonl', parseClaudeLine).at(-1)).toMatchObject({ type: 'error', kind: 'resume' });
  });
  it('неверная модель — ошибка, хотя subtype success', () => {
    expect(events('claude-err-model.jsonl', parseClaudeLine).at(-1)).toMatchObject({ type: 'error', kind: 'other' });
  });
  it('GLM: метка до инструмента отдельным блоком', () => {
    const list = events('glm-tool-preface-before-tool.jsonl', parseClaudeLine);
    const tool = list.findIndex((event) => event.type === 'tool');
    expect(tool).toBeGreaterThan(0);
    expect(text(list.slice(0, tool))).toContain('[[');
    expect(list.at(-1)).toEqual({ type: 'done' });
  });
  it('не JSON и чужие события — пусто', () => {
    expect(parseClaudeLine('Reading additional input from stdin...')).toEqual([]);
    expect(parseClaudeLine('{"type":"rate_limit_event"}')).toEqual([]);
  });
  it('429 — лимит', () => {
    expect(parseClaudeLine('{"type":"result","is_error":true,"api_error_status":429,"result":"x"}')).toEqual([
      { type: 'error', kind: 'limit', message: 'x' },
    ]);
  });
});

describe('parseCodexLine', () => {
  it('ход с инструментом: thread_id, инструмент, сообщение целиком, конец', () => {
    const list = events('codex-tool.jsonl', parseCodexLine);
    expect(list[0]).toMatchObject({ type: 'session' });
    expect(list.some((event) => event.type === 'tool' && event.name === 'parley_overview')).toBe(true);
    expect(text(list)).toContain('[[');
    expect(list.at(-1)).toEqual({ type: 'done' });
  });
  it('resume — тот же thread', () => {
    const first = events('codex-tool.jsonl', parseCodexLine)[0];
    expect(first?.type).toBe('session');
    expect(events('codex-tool-resume.jsonl', parseCodexLine).at(-1)).toEqual({ type: 'done' });
  });
  it('неверная модель — turn.failed', () => {
    expect(events('codex-err-model.jsonl', parseCodexLine).at(-1)).toMatchObject({ type: 'error' });
  });
});

describe('classifyAssistantError', () => {
  it('различает resume, лимит и прочее', () => {
    expect(classifyAssistantError('Error: thread/resume: no rollout found for thread id x')).toBe('resume');
    expect(classifyAssistantError('No conversation found with session ID: x')).toBe('resume');
    expect(classifyAssistantError("You've hit your usage limit")).toBe('limit');
    expect(classifyAssistantError('Something else')).toBe('other');
  });
});
