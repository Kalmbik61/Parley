/** Qwen Code feed (spec 2026-11-11, 3.5): the transcript owns the items; hooks feed state only. */

import { appendFile, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { turnActive, type FeedItem } from '@parley/core';
import { fakeFeedDeps, fakeClient, hookRequest, REF } from '../../test/feed-fakes.js';
import type { FakeFeedDeps } from '../../test/feed-fakes.js';
import { createLogIndex } from '../activity/log-index.js';
import { createFeedService } from './feed-service.js';
import type { FeedService } from './feed-service.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../core/src/feed/qwen/__fixtures__/session-main.jsonl');
const ID = '66666666-6666-4666-8666-666666666666';
const questionScreen = ['? AskUserQuestion Ask user 1 questions ←', ' ▸ Colour  Submit', '', ' Which colour?', '',
  '   ❯ 1. Blue', '     2. Green', '     3. Type something...',
  ' ↑/↓: Navigate | Enter: Select | Esc: Cancel', ' Waiting for user confirmation...'];
const feedback = ['', '\u25cf\ufe0e How is Qwen doing this session? (optional)', '', '1: Good 2: Bad 3: Fine 0: Dismiss'];

let fakes: FakeFeedDeps;
let service: FeedService;
let dir = '';
let file = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'feed-qwen-'));
  file = path.join(dir, `${ID}.jsonl`);
  await copyFile(FIXTURE, file);
  fakes = fakeFeedDeps([{ ref: REF, provider: 'qwen' }]);
  fakes.setLogFile(file);
  service = createFeedService(fakes.deps, {});
});
afterEach(async () => {
  await service.stop();
  await rm(dir, { recursive: true, force: true });
});

const kinds = (items: readonly FeedItem[], kind: FeedItem['kind']): FeedItem[] => items.filter((item) => item.kind === kind);

describe('feed of a Qwen Code session', () => {
  it('recovers the first complete dialog on redraw before the next recovery poll', async () => {
    vi.useFakeTimers();
    try {
      await service.snapshot(REF);
      fakes.setScreen([]);
      fakes.emitStatus(REF, { state: 'blocked', kind: 'question', msg: null });
      await vi.advanceTimersByTimeAsync(100);
      fakes.setScreen(questionScreen.slice(0, -1));
      fakes.emitOutput(REF);
      expect((await service.snapshot(REF)).items.some(item => item.kind === 'question')).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      fakes.setScreen([...questionScreen, ...feedback]);
      fakes.emitOutput(REF);
      const first = (await service.snapshot(REF)).items.find(item => item.kind === 'question')!;
      expect(first).toMatchObject({ state: 'pending', questions: [{ question: 'Which colour?' }] });
      // A second dialog can repaint without a new OSC status.
      fakes.setScreen(questionScreen.map(line => line.replace('Which colour?', 'Which shape?')));
      fakes.emitOutput(REF);
      const snapshot = await service.snapshot(REF);
      expect(snapshot.items.find(item => item.id === first.id)).toMatchObject({ state: 'elsewhere' });
      expect(snapshot.items.find(item => item.kind === 'question' && item.state === 'pending')).toMatchObject({ questions: [{ question: 'Which shape?' }] });
      expect(fakes.writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['idle', 'exit', 'start', 'pid', 'drop', 'stop'])('ignores late redraw after %s invalidates a native wait', async lifecycle => {
    await service.snapshot(REF);
    fakes.setScreen([]);
    fakes.emitStatus(REF, { state: 'blocked', kind: 'question', msg: null });
    if (lifecycle === 'idle') fakes.emitStatus(REF, { state: 'idle', kind: null, msg: null });
    if (lifecycle === 'exit') fakes.emitExit(REF);
    if (lifecycle === 'start') fakes.emitStart(REF);
    if (lifecycle === 'pid') fakes.setProcess({ pid: 2 });
    if (lifecycle === 'drop') fakes.setSessions([]);
    if (lifecycle === 'stop') await service.stop();
    const read = vi.spyOn(fakes.deps.pty, 'screenText');
    fakes.setScreen(questionScreen);
    fakes.emitOutput(REF);
    expect(read).not.toHaveBeenCalled();
    if (lifecycle !== 'drop' && lifecycle !== 'stop') {
      expect((await service.snapshot(REF)).items.some(item => item.kind === 'question')).toBe(false);
    }
    expect(fakes.writes).toEqual([]);
  });

  it('keeps incomplete feedback, unknown overlays and rating-only screens in the terminal', async () => {
    for (const lines of [[...questionScreen, ...feedback.slice(0, -1)], [...questionScreen, ...feedback, 'Unknown overlay'], feedback]) {
      fakes.setScreen(lines);
      fakes.emitStatus(REF, { state: 'blocked', kind: 'question', msg: null });
      const snapshot = await service.snapshot(REF);
      expect(snapshot.decisions).toBe('terminal');
      expect(snapshot.items.some(item => item.kind === 'question')).toBe(false);
    }
    expect(fakes.writes).toEqual([]);
  });

  it('offers the live question above feedback and waits for dismissal before applying the answer', async () => {
    fakes.setScreen([...questionScreen, ...feedback]);
    fakes.emitStatus(REF, { state: 'blocked', kind: 'question', msg: null });
    const snapshot = await service.snapshot(REF);
    const card = snapshot.items.find(item => item.kind === 'question')!;
    expect(snapshot.decisions).toBe('window');
    expect(card.questions[0]).toMatchObject({ question: 'Which colour?', options: [{ label: 'Blue' }, { label: 'Green' }] });
    const decision = { kind: 'question', answers: { 'Which colour?': 'Green' } } as const;
    expect(await service.decide(REF, card.id, { kind: 'question', answers: {} })).toMatchObject({ applied: false });
    expect(fakes.writes).toEqual([]);
    const result = service.decide(REF, card.id, decision);
    expect(fakes.writes).toEqual(['0']);
    expect(await service.decide(REF, card.id, decision)).toMatchObject({ applied: false });
    fakes.setScreen(questionScreen);
    expect(await result).toEqual({ applied: true, state: 'answered' });
    expect(fakes.writes).toEqual(['0', '2']);
    expect((await service.snapshot(REF)).items.find(item => item.id === card.id)).toMatchObject({ state: 'answered', answers: decision.answers });
  });

  it('dismisses feedback before writing a custom answer through the feed', async () => {
    fakes.setScreen([...questionScreen, ...feedback]);
    fakes.emitStatus(REF, { state: 'blocked', kind: 'question', msg: null });
    const card = (await service.snapshot(REF)).items.find(item => item.kind === 'question')!;
    const editor = questionScreen.map(line => line.replace('❯ 1.', '  1.').replace('     3. Type something...', '   ❯ 3. > Type something...'));
    const write = fakes.deps.pty.write;
    vi.spyOn(fakes.deps.pty, 'write').mockImplementation((ref, keys) => {
      write(ref, keys);
      if (keys === '0') fakes.setScreen(questionScreen);
      if (keys === '3') fakes.setScreen(editor);
      if (keys === 'Orange') fakes.setScreen(editor.map(line => line.replace('> Type something...', '> Orange')));
    });
    expect(await service.decide(REF, card.id, { kind: 'question', answers: { 'Which colour?': 'Orange' } })).toEqual({ applied: true, state: 'answered' });
    expect(fakes.writes).toEqual(['0', '3', 'Orange', '\r']);
  });

  it.each(['question', 'editor', 'pid', 'redraw', 'overlay'])('sends no answer if %s changes while dismissing feedback', async change => {
    fakes.setScreen([...questionScreen, ...feedback]);
    fakes.emitStatus(REF, { state: 'blocked', kind: 'question', msg: null });
    const card = (await service.snapshot(REF)).items.find(item => item.kind === 'question')!;
    const result = service.decide(REF, card.id, { kind: 'question', answers: { 'Which colour?': 'Green' } });
    expect(fakes.writes).toEqual(['0']);
    if (change === 'question') fakes.setScreen(questionScreen.map(line => line.replace('Which colour?', 'Which shape?')));
    if (change === 'editor') fakes.setScreen(questionScreen.map(line => line.replace('❯ 1.', '  1.').replace('     3. Type something...', '   ❯ 3. > Type something...')));
    if (change === 'pid') fakes.setProcess({ pid: 999 });
    if (change === 'redraw') fakes.setScreen(questionScreen.slice(1));
    if (change === 'overlay') fakes.setScreen([...questionScreen, 'Unknown overlay']);
    expect(await result).toMatchObject({ applied: false });
    expect(fakes.writes).toEqual(['0']);
  });

  it('yields to a terminal keystroke before its effect is visible on the question', async () => {
    let inputRevision = 0;
    const process = fakes.deps.pty.get(REF)!;
    vi.spyOn(fakes.deps.pty, 'get').mockReturnValue({ ...process, rawInputRevision: () => inputRevision });
    fakes.setScreen([...questionScreen, ...feedback]);
    fakes.emitStatus(REF, { state: 'blocked', kind: 'question', msg: null });
    const card = (await service.snapshot(REF)).items.find(item => item.kind === 'question')!;
    const result = service.decide(REF, card.id, { kind: 'question', answers: { 'Which colour?': 'Green' } });
    expect(fakes.writes).toEqual(['0']);
    inputRevision++;
    fakes.setScreen(questionScreen);
    expect(await result).toMatchObject({ applied: false });
    expect(fakes.writes).toEqual(['0']);
  });

  it('keeps the question unanswered when feedback does not redraw', async () => {
    fakes.setScreen([...questionScreen, ...feedback]);
    fakes.emitStatus(REF, { state: 'blocked', kind: 'question', msg: null });
    const card = (await service.snapshot(REF)).items.find(item => item.kind === 'question')!;
    expect(await service.decide(REF, card.id, { kind: 'question', answers: { 'Which colour?': 'Green' } })).toMatchObject({ applied: false });
    expect(fakes.writes).toEqual(['0']);
    expect((await service.snapshot(REF)).items.find(item => item.id === card.id)).toMatchObject({ state: 'pending' });
  });

  it('confirms the native review only after feedback has disappeared', async () => {
    const review = [questionScreen[0]!, ' Colour ✓  ▸ Submit', '', ' Your answers:', '   Colour: Green', '',
      ' Ready to submit your answers?', '', '   ❯ 1. Submit answers', '     2. Cancel', ...questionScreen.slice(-2)];
    fakes.setScreen([...review, ...feedback]);
    fakes.emitStatus(REF, { state: 'blocked', kind: 'question', msg: null });
    const card = (await service.snapshot(REF)).items.find(item => item.kind === 'question')!;
    expect(await service.decide(REF, card.id, { kind: 'question', answers: {}, values: { answer: 'Unknown' } })).toMatchObject({ applied: false });
    expect(fakes.writes).toEqual([]);
    const result = service.decide(REF, card.id, { kind: 'question', answers: {}, values: { answer: 'Submit answers' } });
    expect(fakes.writes).toEqual(['0']);
    fakes.setScreen(review);
    expect(await result).toEqual({ applied: true, state: 'answered' });
    expect(fakes.writes).toEqual(['0', '1', '\r']);
    expect((await service.snapshot(REF)).items.find(item => item.id === card.id)).toMatchObject({ answers: { 'Ready to submit your answers?': 'Submit answers' } });
  });

  it('the snapshot is built from the transcript: prompts, text, tools with the inner MCP name and a failed call', async () => {
    const snapshot = await service.snapshot(REF);
    expect(kinds(snapshot.items, 'prompt').map((i) => (i.kind === 'prompt' ? i.text : ''))).toEqual(['mcpflow', 'shellflow']);
    const tools = snapshot.items.filter((i) => i.kind === 'tool');
    expect(tools.find((t) => t.kind === 'tool' && t.toolUseId === 'call_1')).toMatchObject({ name: 'mcp__parley__echo', status: 'done' });
    expect(tools.find((t) => t.kind === 'tool' && t.toolUseId === 'call_e1')).toMatchObject({ status: 'failed' });
    expect(snapshot.decisions).toBe('terminal');
  });

  const permission = [
    '? WriteFile Writing to a.txt ←', '  Apply this change?', '  › 1. Yes, allow once',
    '    2. No, suggest changes (esc)', ' Waiting for user confirmation...',
  ];
  const blocked = { state: 'blocked', kind: 'permission', msg: null };

  it('keeps a live permission through a cold snapshot and accepts one explicit decision', async () => {
    fakes.setScreen(permission);
    fakes.emitStatus(REF, blocked);
    const card = (await service.snapshot(REF)).items.find(item => item.kind === 'permission')!;
    expect(card).toMatchObject({ state: 'pending', permissionOptions: [{ kind: 'allow_once' }, { kind: 'reject_once' }] });
    const allow = { kind: 'permission', behavior: 'allow', optionId: '1' } as const;
    expect(await service.decide(REF, card.id, { ...allow, optionId: '2' })).toMatchObject({ applied: false });
    expect(await service.decide(REF, card.id, allow)).toMatchObject({ applied: true });
    expect(await service.decide(REF, card.id, allow)).toMatchObject({ applied: false });
    expect(fakes.writes).toEqual(['1']);
  });

  it('requires an explicit matching scope for the startup trust card', async () => {
    const screen = ['╭────', '│ Do you trust this folder?',
      '│ Trusting a folder allows Qwen Code to execute commands it suggests. This is a security feature to prevent accidental execution in untrusted directories.',
      '│ › 1. Trust folder (project)', '│   2. Trust parent folder (work)', "│   3. Don't trust (esc)", '╰────'];
    fakes.setScreen(screen);
    fakes.emitStatus(REF, blocked);
    const card = (await service.snapshot(REF)).items.find(item => item.kind === 'question')!;
    const decide = (answer: string) => service.decide(REF, card.id, { kind: 'question', answers: {}, values: { answer } });
    expect(await decide('yes')).toMatchObject({ applied: false });
    fakes.setScreen(screen.map(line => line.replace('(project)', '(another)')));
    expect(await decide('Trust folder (project)')).toMatchObject({ applied: false });
    expect(fakes.writes).toEqual([]);
    fakes.setScreen(screen);
    expect(await decide("Don't trust (esc)")).toEqual({ applied: true, state: 'answered' });
    expect(fakes.writes).toEqual(['\x1b']);
    expect((await service.snapshot(REF)).items.find(item => item.id === card.id)).toMatchObject({
      answers: { [card.questions[0]!.question]: "Don't trust (esc)" },
    });
  });

  it('rejects a late click after a screen or process change and retires the card on exit', async () => {
    await service.snapshot(REF);
    fakes.setScreen(permission);
    fakes.emitStatus(REF, blocked);
    const card = (await service.snapshot(REF)).items.find(item => item.kind === 'permission')!;
    const deny = { kind: 'permission', behavior: 'deny', optionId: '2' } as const;
    fakes.setScreen(permission.map(line => line.replace('a.txt', 'b.txt')));
    expect(await service.decide(REF, card.id, deny)).toMatchObject({ applied: false });
    fakes.setScreen(permission);
    fakes.setProcess({ pid: 9 });
    expect(await service.decide(REF, card.id, deny)).toMatchObject({ applied: false });
    fakes.emitExit(REF);
    expect(await service.decide(REF, card.id, deny)).toMatchObject({ applied: false, state: 'stale' });
    expect(fakes.writes).toEqual([]);
  });

  it('requires both a native wait and a complete matching menu, and follows a terminal answer', async () => {
    fakes.setScreen(permission);
    expect((await service.snapshot(REF)).items.some(item => item.kind === 'permission')).toBe(false);
    fakes.setScreen(permission.slice(1));
    fakes.emitStatus(REF, blocked);
    expect((await service.snapshot(REF)).decisions).toBe('terminal');
    fakes.emitStatus(REF, { state: 'idle', kind: null, msg: null });
    fakes.setScreen(permission);
    fakes.emitStatus(REF, blocked);
    const card = (await service.snapshot(REF)).items.find(item => item.kind === 'permission')!;
    fakes.emitStatus(REF, { state: 'working', kind: null, msg: null });
    expect((await service.snapshot(REF)).items.find(i => i.id === card.id)).toMatchObject({ state: 'elsewhere' });
    expect(fakes.writes).toEqual([]);
  });

  it('offers the native shell confirmation with scoped always-allow rows and applies the chosen row', async () => {
    // Live qwen 0.27.2 exec dialog; auto mode asks the same when the classifier blocks a command.
    const shell = [
      '? Shell touch /tmp/probe/file (Create an empty file as requested.) ←',
      '   touch /tmp/probe/file',
      " Allow execution of: 'touch'?",
      ' › 1. Yes, allow once',
      "   2. Always allow run 'touch *' commands in this project",
      "   3. Always allow run 'touch *' commands for this user",
      '   4. No, suggest changes (esc)',
      ' Waiting for user confirmation...',
    ];
    fakes.setScreen(shell);
    fakes.emitStatus(REF, blocked);
    const card = (await service.snapshot(REF)).items.find(item => item.kind === 'permission')!;
    expect(card).toMatchObject({ state: 'pending', permissionOptions: [
      { kind: 'allow_once' }, { kind: 'allow_always' }, { kind: 'allow_always' }, { kind: 'reject_once' },
    ] });
    expect(await service.decide(REF, card.id, { kind: 'permission', behavior: 'allow', optionId: '2' }))
      .toEqual({ applied: true, state: 'allowed' });
    expect(fakes.writes).toEqual(['2']);
  });

  it('applies a joined multiselect answer sent by the chat without values', async () => {
    const labels = ['Nuts', 'Cream', 'Honey'];
    let selected = 1;
    const checked = new Set<number>();
    const render = (): string[] => [
      '? AskUserQuestion Ask user 1 question ←', ' Toppings', '', ' Which toppings?', '',
      ...labels.map((label, i) => `${selected === i + 1 ? '   ❯ ' : '     '}${checked.has(i + 1) ? '[✓]' : '[ ]'} ${i + 1}. ${label}`),
      '     [ ] 4. Type something...',
      ' ↑/↓: Navigate | Space: Toggle | Enter: Confirm | Esc: Cancel',
      ' Waiting for user confirmation...',
    ];
    fakes.setScreen(render());
    fakes.emitStatus(REF, { state: 'blocked', kind: 'question', msg: null });
    const card = (await service.snapshot(REF)).items.find(item => item.kind === 'question')!;
    expect(card.questions[0]).toMatchObject({ question: 'Which toppings?', multiSelect: true });
    const write = fakes.deps.pty.write.bind(fakes.deps.pty);
    const spy = vi.spyOn(fakes.deps.pty, 'write').mockImplementation((ref, data) => {
      write(ref, data);
      if (/^[1-9]$/.test(data)) selected = Number(data);
      else if (data === ' ' && selected <= labels.length) {
        if (checked.has(selected)) checked.delete(selected);
        else checked.add(selected);
      }
      fakes.setScreen(render());
    });
    try {
      expect(await service.decide(REF, card.id, { kind: 'question', answers: { 'Which toppings?': 'Nuts, Honey' } }))
        .toEqual({ applied: true, state: 'answered' });
      expect(fakes.writes).toEqual(['1', ' ', '3', ' ', '\r']);
    } finally {
      spy.mockRestore();
    }
  });

  it('an appended transcript record reaches subscribers after a hook prompts the read', async () => {
    const client = fakeClient();
    service.subscribe(REF, client);
    await service.snapshot(REF);
    const line = `${JSON.stringify({ uuid: 'zz1', sessionId: ID, timestamp: '2026-11-11T14:00:00.000Z', type: 'assistant', model: 'm', message: { parts: [{ text: 'appended answer' }] } })}\n`;
    await appendFile(file, line);
    service.onHook(hookRequest({ hook_event_name: 'Stop', session_id: ID }));
    await vi.waitFor(async () => {
      const snapshot = await service.snapshot(REF);
      expect(kinds(snapshot.items, 'text').some((i) => i.kind === 'text' && i.text === 'appended answer')).toBe(true);
    });
  });

  it('hooks create no items and no permission cards, and are answered at once', async () => {
    await service.snapshot(REF);
    const before = (await service.snapshot(REF)).items.length;
    const prompt = hookRequest({ hook_event_name: 'UserPromptSubmit', session_id: ID, prompt: 'SECRET-HOOK-PROMPT' });
    const permission = hookRequest({ hook_event_name: 'PermissionRequest', session_id: ID, tool_name: 'run_shell_command', tool_input: { command: 'rm -rf /' } });
    const pre = hookRequest({ hook_event_name: 'PreToolUse', session_id: ID, tool_name: 'run_shell_command', tool_input: { command: 'ls' }, tool_use_id: 't1' });
    for (const request of [prompt, permission, pre]) service.onHook(request);
    const after = await service.snapshot(REF);
    expect(after.items.length).toBe(before);
    expect(JSON.stringify(after.items)).not.toContain('SECRET-HOOK-PROMPT');
    expect(after.items.some((i) => i.kind === 'permission')).toBe(false);
    for (const request of [prompt, permission, pre]) expect(request.responses).toEqual([{}]);
  });

  it('a transcript replayed after the same records were applied gives no duplicates', async () => {
    const first = (await service.snapshot(REF)).items.filter((i) => i.kind !== 'turn').length;
    service.onHook(hookRequest({ hook_event_name: 'Stop', session_id: ID }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The transcript items are not duplicated; only the closing turn item is added by the Stop.
    expect((await service.snapshot(REF)).items.filter((i) => i.kind !== 'turn').length).toBe(first);
  });

  it('after sleep and resume the feed continues the same transcript with no duplicates', async () => {
    const client = fakeClient();
    service.subscribe(REF, client);
    const before = await service.snapshot(REF);
    const ids = new Set(before.items.map((item) => item.id));
    // The process exits (sleep), then `qwen --resume <id>` starts: the same file is appended to.
    fakes.emitExit(REF);
    fakes.emitStart(REF);
    const line = (n: number, type: string, parts: unknown[]): string =>
      `${JSON.stringify({ uuid: `r${n}`, sessionId: ID, timestamp: `2026-11-11T15:00:0${n}.000Z`, type, provenance: type === 'user' ? 'real_user' : 'assistant_output', model: 'm', message: { parts } })}\n`;
    await appendFile(file, line(1, 'user', [{ text: 'after resume' }]) + line(2, 'assistant', [{ text: 'resumed answer' }]));
    service.onHook(hookRequest({ hook_event_name: 'SessionStart', session_id: ID, source: 'resume' }));
    await vi.waitFor(async () => {
      const snapshot = await service.snapshot(REF);
      expect(snapshot.items.some((i) => i.kind === 'text' && i.text === 'resumed answer')).toBe(true);
    });
    const after = await service.snapshot(REF);
    // Everything from before is still there once, and only the two new records were added (plus the closed turn).
    for (const id of ids) expect(after.items.filter((item) => item.id === id)).toHaveLength(1);
    expect(after.items.filter((i) => i.kind === 'prompt')).toHaveLength(3);
    expect(new Set(after.items.map((item) => item.id)).size).toBe(after.items.length);
    expect(after.items.filter((i) => i.kind === 'text' && i.text === 'resumed answer')).toHaveLength(1);
  });

  it('the Stop hook closes the open turn, and it stays closed on a reseed and a later poll', async () => {
    expect(turnActive((await service.snapshot(REF)).items)).toBe(true);
    service.onHook(hookRequest({ hook_event_name: 'Stop', session_id: ID, timestamp: '2026-11-11T13:30:00.000Z' }));
    await vi.waitFor(async () => {
      expect(turnActive((await service.snapshot(REF)).items)).toBe(false);
    });
    const turns = kinds((await service.snapshot(REF)).items, 'turn');
    expect(turns.at(-1)).toMatchObject({ durationMs: expect.any(Number) });
    // A poll with no new records (reconnect) keeps it closed.
    service.onHook(hookRequest({ hook_event_name: 'Notification', session_id: ID }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(turnActive((await service.snapshot(REF)).items)).toBe(false);
  });

  it('a new prompt after the Stop opens a new turn', async () => {
    await service.snapshot(REF);
    service.onHook(hookRequest({ hook_event_name: 'Stop', session_id: ID, timestamp: '2026-11-11T13:30:00.000Z' }));
    await vi.waitFor(async () => expect(turnActive((await service.snapshot(REF)).items)).toBe(false));
    const user = `${JSON.stringify({ uuid: 'np1', sessionId: ID, timestamp: '2026-11-11T14:00:00.000Z', type: 'user', provenance: 'real_user', message: { parts: [{ text: 'again' }] } })}\n`;
    await appendFile(file, user);
    service.onHook(hookRequest({ hook_event_name: 'UserPromptSubmit', session_id: ID }));
    await vi.waitFor(async () => expect(turnActive((await service.snapshot(REF)).items)).toBe(true));
  });

  it('has no subagent transcripts and never reads the Claude layout', async () => {
    await expect(service.snapshot(REF, 'agent-1')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('feed of a Qwen Code session through the real log index and binding', () => {
  it('the transcript the index trusts (binding: path, sessionId, cwd) feeds the snapshot RPC', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'feed-qwen-root-'));
    const bound = path.join(root, '-work-project', 'chats', `${ID}.jsonl`);
    await mkdir(path.dirname(bound), { recursive: true });
    await copyFile(FIXTURE, bound);
    const index = createLogIndex({ claudeRoot: path.join(root, 'none-c'), codexRoot: path.join(root, 'none-x'), qwenRoot: root }, { cache: null });
    try {
      await index.start();
      const session = { id: 's-01', provider: 'qwen', providerSessionId: ID, qwenTranscript: { path: bound, cwd: '/work/project' } } as never;
      const wrong = { id: 's-01', provider: 'qwen', providerSessionId: ID, qwenTranscript: { path: bound, cwd: '/other' } } as never;
      expect(index.index(wrong)).toBeUndefined();
      await service.stop();
      const deps = fakeFeedDeps([{ ref: REF, provider: 'qwen' }]);
      (deps.deps.activity as { logFile: unknown }).logFile = () => index.index(session)?.file ?? null;
      service = createFeedService(deps.deps, {});
      const snapshot = await service.snapshot(REF);
      expect(snapshot.items.map((i) => i.kind)).toContain('tool');
      expect(snapshot.items.filter((i) => i.kind === 'prompt')).toHaveLength(2);
      expect(snapshot.decisions).toBe('terminal');
    } finally {
      index.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
