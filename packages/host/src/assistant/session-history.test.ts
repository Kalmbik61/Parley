import { describe, expect, it } from 'vitest';
import type { FeedItem, FeedTool, FeedToolStatus } from '@parley/core';
import { PAGE_BUDGET } from './room-page.js';
import { historyText, toolLine } from './session-history.js';

const AT = '2026-10-28T11:00:00.000Z';

function tool(
  name: string,
  input: Record<string, unknown>,
  status: FeedToolStatus = 'done',
  id = `tool:${name}:${Math.random()}`,
): FeedTool {
  return { kind: 'tool', id, at: AT, toolUseId: id, name, input, status };
}
function prompt(text: string, id = `prompt:${text}`): FeedItem {
  return { kind: 'prompt', id, at: AT, text, images: 0 };
}
function reply(text: string, id = `text:${text}`, streaming = false): FeedItem {
  return { kind: 'text', id, at: AT, messageId: null, text, streaming };
}

// 30 пар «вопрос — ответ», после каждого ответа один вызов Bash: 60 записей и 30 инструментов
const items30: FeedItem[] = Array.from({ length: 30 }, (_, i) => {
  const n = i + 1;
  return [
    prompt(`ask ${n}`, `prompt:#${n}`),
    reply(`reply ${n}`, `text:#${n}`),
    tool('Bash', { command: 'pnpm test' }, 'done', `tool:#${n}`),
  ];
}).flat();

describe('toolLine', () => {
  it('команда, правка, прочие', () => {
    expect(toolLine(tool('Bash', { command: 'pnpm test' }))).toBe('ran: pnpm test');
    expect(toolLine(tool('Edit', { file_path: 'src/a.ts' }, 'failed'))).toBe(
      'edited: src/a.ts (failed)',
    );
    expect(toolLine(tool('mcp__x__y', { query: 'abc' }))).toBe('mcp__x__y abc');
  });
  it('чтение, поиск, загрузка и отклонённый вызов', () => {
    expect(toolLine(tool('Read', { file_path: 'a.md' }))).toBe('read: a.md');
    expect(toolLine(tool('Grep', { pattern: 'foo' }))).toBe('searched: foo');
    expect(toolLine(tool('Glob', { pattern: '**/*.ts' }))).toBe('searched: **/*.ts');
    expect(toolLine(tool('WebFetch', { url: 'https://x.dev' }))).toBe('fetched: https://x.dev');
    expect(toolLine(tool('Write', { file_path: 'b.ts' }, 'rejected'))).toBe(
      'edited: b.ts (rejected)',
    );
  });
  it('без подходящего поля — имя; без строк во входе — только имя', () => {
    expect(toolLine(tool('Bash', { timeout: 5 }))).toBe('Bash');
    expect(toolLine(tool('TaskList', {}))).toBe('TaskList');
  });
  it('одна строка до 160 знаков, статус не теряется', () => {
    const long = toolLine(tool('Bash', { command: `echo a\n${'b'.repeat(400)}` }, 'failed'));
    expect(long).not.toContain('\n');
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.startsWith('ran: echo a bbbb')).toBe(true);
    expect(long.endsWith('… (failed)')).toBe(true);
  });
});

describe('historyText', () => {
  it('20 последних записей, инструменты — строкой под записью', () => {
    const { text } = historyText('Session S03 …', items30, {}) as { text: string };
    expect(text).toContain('Agent: reply 30');
    expect(text).not.toContain('Agent: reply 10\n');
    expect(text).toContain('  · ran: pnpm test');
    expect(text).toMatch(/Older: call parley_session with before=\S+$/);
  });
  it('шапка первой строкой, записи — от старых к новым', () => {
    const { text } = historyText('Session S03 …', items30, {}) as { text: string };
    expect(text.startsWith('Session S03 …\n')).toBe(true);
    expect(text.indexOf('Asked: ask 21')).toBeLessThan(text.indexOf('Agent: reply 30'));
    expect(text).not.toContain('Asked: ask 20\n');
  });
  it('больше 8 инструментов подряд — хвост', () => {
    const items = [
      prompt('go'),
      ...Array.from({ length: 12 }, (_, i) => tool('Read', { file_path: `f${i}` })),
    ];
    const { text } = historyText('h', items, {}) as { text: string };
    expect(text).toContain('  · read: f7');
    expect(text).not.toContain('  · read: f8');
    expect(text).toContain('  · …and 4 more tool calls');
  });
  it('ответ из одних пробелов не запись «Agent:»', () => {
    const { text } = historyText('h', [prompt('go'), reply('  \n\t '), reply('done', 'text:done')], {}) as { text: string };
    expect(text).toContain('Asked: go');
    expect(text).toContain('Agent: done');
    expect(text.match(/Agent:/g)).toHaveLength(1);
  });
  it('курсор назад до начала: 60 записей — три страницы', () => {
    let page = historyText('h', items30, {}) as { text: string };
    let pages = 1;
    for (
      let match = /before=(\S+)$/.exec(page.text);
      match !== null;
      match = /before=(\S+)$/.exec(page.text)
    ) {
      page = historyText('h', items30, { before: match[1] }) as { text: string };
      pages += 1;
    }
    expect(pages).toBe(3);
    expect(page.text).toMatch(/This is the beginning of the session history\.$/);
    expect(page.text).toContain('Asked: ask 1\n');
  });
  it('курсор — id самой старой показанной записи, старше него ничего не показано', () => {
    const { text } = historyText('h', items30, {}) as { text: string };
    expect(text).toMatch(/before=prompt:#21$/);
    const older = historyText('h', items30, { before: 'prompt:#21' }) as { text: string };
    expect(older.text).toContain('Agent: reply 20');
    expect(older.text).not.toContain('Asked: ask 21\n');
  });
  it('курсора нет в ленте — ошибка с советом', () => {
    expect(historyText('h', items30, { before: 'text:#999999' })).toEqual({
      error: expect.stringContaining('without before'),
    });
  });
  it('пустая лента — шапка и «нет истории»', () => {
    expect(historyText('Session S09 …', [], {})).toEqual({
      text: 'Session S09 …\nNo history for this session yet.',
    });
  });
  it('limit зажат в 1…50', () => {
    const one = historyText('h', items30, { limit: 0 }) as { text: string };
    expect(one.text).toContain('Agent: reply 30');
    expect(one.text).not.toContain('Asked: ask 30');
    const many = historyText('h', items30, { limit: 500 }) as { text: string };
    expect(many.text).toContain('Agent: reply 30');
    expect(many.text).toContain('Asked: ask 6\n');
    expect(many.text).not.toContain('Asked: ask 5\n');
  });
  it('ошибка, субагент, прерванный ход и недописанный ответ; прочее пропущено', () => {
    const items: FeedItem[] = [
      {
        kind: 'error',
        id: 'e1',
        at: AT,
        error: 'overloaded',
        message: 'API overloaded',
        retry: undefined,
      },
      { kind: 'error', id: 'e2', at: AT, error: 'rate_limit', message: null },
      {
        kind: 'agent',
        id: 'a1',
        at: AT,
        toolUseId: 'tu1',
        agentId: null,
        agentType: 'explore',
        description: null,
        prompt: null,
        model: null,
        background: false,
        status: 'done',
        toolCount: 0,
        children: [],
      },
      { kind: 'turn', id: 't1', at: AT, durationMs: 100 },
      { kind: 'turn', id: 't2', at: AT, durationMs: null, interrupted: true },
      { kind: 'notice', id: 'n1', at: AT, notice: { type: 'session-end', reason: null } },
      reply('', 'text:empty'),
      reply('working on it', 'text:live', true),
    ];
    const { text } = historyText('h', items, {}) as { text: string };
    expect(text.split('\n').slice(2)).toEqual([
      'Error: API overloaded',
      'Error: rate_limit',
      'Subagent: explore',
      '(turn interrupted)',
      'Agent: working on it (still writing)',
      'This is the beginning of the session history.',
    ]);
  });
  it('запись длиннее 4000 знаков — с многоточием', () => {
    const { text } = historyText('h', [reply('x'.repeat(5000))], {}) as { text: string };
    expect(text).toContain(`Agent: ${'x'.repeat(3999)}…\n`);
  });
  it('бюджет страницы держится: остальное — по курсору', () => {
    const big = Array.from({ length: 20 }, (_, i) => reply('y'.repeat(4000), `text:big${i}`));
    const { text } = historyText('h', big, {}) as { text: string };
    expect(text.length).toBeLessThanOrEqual(PAGE_BUDGET + 2000);
    expect(text).toMatch(/before=text:big\d+$/);
  });
});
