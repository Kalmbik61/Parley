import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { addSession } from '../work/map.js';
import { unreadLetters } from '../work/letter-store.js';
import { createWork, readStoredMap, updateMap, workPaths } from '../work/store.js';
import { HUMAN } from '../work/types.js';
import { CHANNEL_INSTRUCTIONS, TOOLS, createToolRunner, type ToolRunner } from './tools.js';

/** Потолок почты: `check_inbox` и `wait_for("inbox")` отдают страницы не больше 32 КиБ и 50 писем. */

let home = '';
let project = '';
let workId = '';
let runner: ToolRunner;

const textOf = (result: Awaited<ReturnType<ToolRunner['call']>>): string => (result.content[0] as { text: string }).text;
const body = (result: Awaited<ReturnType<ToolRunner['call']>>): Record<string, unknown> => JSON.parse(textOf(result)) as Record<string, unknown>;
const textsOf = (answer: Record<string, unknown>): string[] => ((answer['messages'] ?? []) as { text: string }[]).map((item) => item.text);
/** Давнее письмо: окно тишины давно вышло, `wait_for` отдаёт его сразу. */
const OLD = '2026-01-01T00:00:00.000Z';
const label = (index: number): string => `L${String(index).padStart(3, '0')}-`;
const letterText = (index: number): string => label(index) + 'x'.repeat(1024 - label(index).length);
const addLetters = async (texts: string[], from = 's-02'): Promise<void> => {
  await updateMap(project, workId, (_map, letters) => {
    for (const text of texts) letters.add({ roomId: null, kind: 'note', from, to: ['s-01'], text, at: OLD });
  });
};
const unreadCount = (): number => unreadLetters(project, workId, 's-01').length;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  workId = (await createWork(project, { title: 'Работа', goal: '' })).work.id;
  await updateMap(project, workId, (map) => {
    addSession(map, { provider: 'claude', label: 'план', task: 'составить план' });
    addSession(map, { provider: 'claude', label: 'бэк', task: 'делать' });
  });
  await mkdir(workPaths(project, workId).events, { recursive: true });
  runner = createToolRunner({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, messageRate: DEFAULT_CONFIG.messageRate, pollMs: 40 });
});

afterEach(async () => {
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('почта страницами', () => {
  it('120 писем по 1 КиБ: страницы до конца, каждая в потолке, письма по порядку и по одному разу', async () => {
    const all = Array.from({ length: 120 }, (_, index) => letterText(index + 1));
    await addLetters(all);

    const seen: string[] = [];
    let pages = 0;
    for (; pages < 30; pages += 1) {
      const text = textOf(await runner.call('check_inbox', {}, undefined));
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32768);
      const answer = JSON.parse(text) as Record<string, unknown>;
      const texts = textsOf(answer);
      if (texts.length === 0) break;
      if (pages === 1) expect(texts[0]).toBe(all[seen.length]);
      seen.push(...texts);
      const left = unreadCount();
      expect(answer['remaining']).toBe(left > 0 ? left : undefined);
      expect(left).toBe(all.length - seen.length);
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(all);
  });

  it('wait_for("inbox") отдаёт ту же страницу с state: message', async () => {
    await addLetters(Array.from({ length: 120 }, (_, index) => letterText(index + 1)));
    const answer = body(await runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined));
    const texts = textsOf(answer);
    expect(answer['state']).toBe('message');
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.length).toBeLessThan(120);
    expect(texts[0]).toBe(letterText(1));
    expect(answer['remaining']).toBe(120 - texts.length);
    expect(unreadCount()).toBe(120 - texts.length);
  });

  it('письмо человека в 200 000 знаков отдаётся урезанным, помечено прочитанным, get_map читает его целиком', async () => {
    const full = 'я'.repeat(200_000);
    await addLetters([full], HUMAN);
    const id = readStoredMap(project, workId).messages[0]?.id as string;

    const answer = body(await runner.call('check_inbox', {}, undefined));
    const [only] = answer['messages'] as { text: string; textBytes: number }[];
    expect(only?.text.endsWith('bytes in full]')).toBe(true);
    expect(only?.textBytes).toBe(400_000);
    expect(answer['hint']).toContain(`Message ${id} is cut`);
    expect(unreadCount()).toBe(0);

    let text = '';
    let cursor: string | undefined;
    for (let guard = 0; guard < 30; guard += 1) {
      const page = body(await runner.call('get_map', { field: 'message', id, maxBytes: 32768, ...(cursor === undefined ? {} : { cursor }) }, undefined));
      text += page['text'] as string;
      if (page['complete'] === true) break;
      cursor = page['next'] as string;
    }
    expect(text).toBe(full);
  });

  it('описания и инструкции без старого правила «всё сразу»', () => {
    const description = (name: string): string => TOOLS.find((tool) => tool.name === name)?.description ?? '';
    expect(description('check_inbox')).toContain('a page');
    expect(description('wait_for')).not.toContain('no check_inbox needed');
    expect(CHANNEL_INSTRUCTIONS).not.toContain('at once');
  });
});
