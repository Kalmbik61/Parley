/**
 * Пакет передачи контекста новому агенту сессии (спека 2026-10-30, 5.4): текст, который уходит первым сообщением
 * после брифа, и сборка его входа с диска. Встроенная часть — не больше 12 КБ (байты UTF-8): промпт идёт в argv.
 */

import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { unreadLetters } from './letter-store.js';
import { liveLead } from './rooms.js';
import { readMap, workPaths } from './store.js';
import { readTranscript } from './summary.js';
import type { WorkMap, WorkProvider } from './types.js';
import { NO_FSMONITOR } from './worktree.js';

const run = promisify(execFile);

export interface HandoverInput {
  map: WorkMap;
  sessionId: string;
  previous: {
    provider: string;
    providerLabel: string;
    model: string | null;
    reason: 'limit' | 'sign-in' | 'provider-missing' | 'manual';
    endedAt: string;
    resetsAt: string | null;
  };
  target: { providerLabel: string; model: string | null };
  unread: Array<{ id: string; from: string; roomId: string | null; kind: string; text: string; at: string }>;
  worktree: { cwd: string; branch: string | null; status: string[]; ahead: number | null; behind: number | null } | null;
  tail: { text: string; file: string } | null;
}

/** Бюджеты частей и итога, байты UTF-8. */
export const HANDOVER_BUDGET = {
  header: 1024,
  state: 3 * 1024,
  duties: 3 * 1024,
  worktree: 1536,
  tail: 4 * 1024,
  total: 12 * 1024,
} as const;

const LIST_LIMIT = 10;
const STATUS_LIMIT = 30;
const QUESTION_LIMIT = 200;
const LINE_LIMIT = 200;
const ELLIPSIS = '…';

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** Первые `max` байт: по границе строки, а без неё — по границе символа; обрезанное помечено `…`. */
function clipHead(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  const room = max - bytes(ELLIPSIS);
  if (room <= 0) return '';
  let cut = new TextDecoder().decode(Buffer.from(text, 'utf8').subarray(0, room)).replace(/�+$/u, '');
  const newline = cut.lastIndexOf('\n');
  if (newline > 0) cut = cut.slice(0, newline);
  return cut + ELLIPSIS;
}

/** Последние `max` байт: режется голова, начало — с целой строки или целого символа. */
function clipTail(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  const room = max - bytes(ELLIPSIS);
  if (room <= 0) return '';
  const raw = Buffer.from(text, 'utf8');
  let start = raw.length - room;
  while (start < raw.length && (raw[start]! & 0xc0) === 0x80) start += 1;
  let cut = raw.subarray(start).toString('utf8');
  const newline = cut.indexOf('\n');
  if (newline >= 0 && newline < cut.length - 1) cut = cut.slice(newline + 1);
  return ELLIPSIS + cut;
}

const oneLine = (text: string, max = LINE_LIMIT): string => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}${ELLIPSIS}` : flat;
};

/** До `LIST_LIMIT` строк; остаток — строка-указатель на `get_map`. */
function list(lines: string[], more: string): string[] {
  if (lines.length <= LIST_LIMIT) return lines;
  return [...lines.slice(0, LIST_LIMIT), `${ELLIPSIS} ${lines.length - LIST_LIMIT} more: ${more}`];
}

function moment(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

function who(label: string, model: string | null): string {
  return model === null ? label : `${label}, ${model}`;
}

function headerPart(input: HandoverInput): string {
  const { previous, target, sessionId } = input;
  const why =
    previous.reason === 'limit'
      ? `usage limit${previous.resetsAt === null ? '' : ` until ${moment(previous.resetsAt)}`}`
      : previous.reason === 'sign-in'
        ? 'its account needs a sign-in'
        : previous.reason === 'provider-missing'
          ? 'its provider was removed'
          : 'the human switched the agent';
  return clipHead(
    `You continue session ${sessionId} after its previous agent (${who(previous.providerLabel, previous.model)}) ` +
      `stopped at ${moment(previous.endedAt)}: ${why}. You now run on ${who(target.providerLabel, target.model)}. ` +
      'Same id, rooms, children, worktree and mail. The map and the files on disk are the truth; your predecessor\'s ' +
      'last words may be stale. Check before redoing anything.',
    HANDOVER_BUDGET.header,
  );
}

function statePart(input: HandoverInput): string {
  const session = input.map.sessions.find((s) => s.id === input.sessionId);
  const lines = ['## State'];
  if (session === undefined) {
    lines.push('The session is not in the map.');
    return clipHead(lines.join('\n'), HANDOVER_BUDGET.state);
  }
  lines.push(
    session.summary === null
      ? 'Summary: none.'
      : `Summary (${session.summarySource === 'agent' ? 'written by the agent' : 'auto-generated'}): ${session.summary}`,
  );
  lines.push(`Result: ${session.result ?? 'none yet'}.`);
  const plan = session.agentPlan;
  if (plan === undefined || plan.items.length === 0) lines.push('Your plan: none published.');
  else {
    lines.push('Your plan:');
    for (const item of plan.items) lines.push(`- [${item.status}] ${oneLine(item.subject)}`);
  }
  return clipHead(lines.join('\n'), HANDOVER_BUDGET.state);
}

function dutiesPart(input: HandoverInput): string {
  const { map, sessionId, unread } = input;
  const out = ['## Obligations'];

  const children = map.sessions
    .filter((s) => s.parent === sessionId || s.createdBy === sessionId)
    .map((s) => {
      const state = [s.lifecycle, s.result, s.stuck ? `stuck:${s.stuck.kind}` : null].filter((x) => x != null).join('/');
      return `- ${s.id} "${oneLine(s.label, 60)}" ${state}`;
    });
  out.push(children.length === 0 ? 'Children: none.' : 'Children:', ...list(children, 'get_map {sessions}'));

  const proposals = map.rooms
    .filter((r) => r.proposal !== null && liveLead(map, r) === sessionId)
    .map((r) => `- ${r.id} "${oneLine(r.title, 60)}": proposal ${r.proposal!.id} (rev ${r.proposal!.rev}) waits for the human`);
  out.push(...(proposals.length === 0 ? [] : ['Rooms you lead with a waiting proposal:', ...list(proposals, 'get_map {rooms}')]));

  const items = (map.plans ?? []).flatMap((plan) =>
    plan.items
      .filter((i) => i.owner === sessionId && ['in_progress', 'returned', 'blocked'].includes(i.status))
      .map((i) => `- ${plan.roomId} plan ${plan.id} item ${i.id} "${oneLine(i.title, 80)}": ${i.status}`),
  );
  out.push(...(items.length === 0 ? [] : ['Your plan items in progress, returned or blocked:', ...list(items, 'get_map {rooms}')]));

  const byRoom = new Map<string, number>();
  for (const letter of unread) byRoom.set(letter.roomId ?? 'direct', (byRoom.get(letter.roomId ?? 'direct') ?? 0) + 1);
  const rooms = [...byRoom].map(([room, count]) => `- ${room}: ${count} unread`);
  out.push(...(rooms.length === 0 ? ['Unread mail: none.'] : ['Unread mail:', ...list(rooms, 'get_map {room}')]));

  const questions = unread
    .filter((l) => l.kind === 'question')
    .map((l) => `- ${l.id} from ${l.from}${l.roomId === null ? '' : ` in ${l.roomId}`}: ${oneLine(l.text, QUESTION_LIMIT)}`);
  out.push(...(questions.length === 0 ? [] : ['Unanswered questions:', ...list(questions, 'get_map {room}')]));

  return clipHead(out.join('\n'), HANDOVER_BUDGET.duties);
}

function worktreePart(input: HandoverInput): string {
  const tree = input.worktree;
  if (tree === null) return '## Working copy\nUnavailable: git could not be read.';
  const lines = ['## Working copy', `cwd: ${tree.cwd}`, `branch: ${tree.branch ?? 'unknown'}`];
  if (tree.ahead !== null && tree.behind !== null) lines.push(`ahead ${tree.ahead}, behind ${tree.behind} of the base`);
  if (tree.status.length === 0) lines.push('git status --short: clean');
  else {
    lines.push('git status --short:');
    for (const row of tree.status.slice(0, STATUS_LIMIT)) lines.push(oneLine(row, 120));
    if (tree.status.length > STATUS_LIMIT) lines.push(`${ELLIPSIS} ${tree.status.length - STATUS_LIMIT} more files`);
  }
  return clipHead(lines.join('\n'), HANDOVER_BUDGET.worktree);
}

/** Пакет передачи: английский текст до 12 КБ. Чистая функция. */
export function formatHandover(input: HandoverInput): string {
  const parts = [headerPart(input), statePart(input), dutiesPart(input), worktreePart(input)];
  if (input.tail === null) {
    parts.push('## Conversation tail\nNo transcript of the previous agent is available.');
    return clipHead(parts.join('\n\n'), HANDOVER_BUDGET.total);
  }
  const head = parts.join('\n\n');
  const footer = `Full tail of the conversation: ${input.tail.file}`;
  const title = '## Conversation tail (latest part)';
  const overhead = bytes(`\n\n${title}\n\n\n${footer}`);
  const room = Math.min(HANDOVER_BUDGET.tail, HANDOVER_BUDGET.total - bytes(head) - overhead);
  const tail = room > 0 ? clipTail(input.tail.text, room) : '';
  return clipHead(`${head}\n\n${title}\n${tail}\n\n${footer}`, HANDOVER_BUDGET.total);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', [...NO_FSMONITOR, '-C', cwd, ...args], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function readWorktree(
  cwd: string,
  base: string | null,
): Promise<HandoverInput['worktree']> {
  try {
    const branch = (await git(cwd, ['branch', '--show-current'])).trim();
    const status = (await git(cwd, ['status', '--short'])).split('\n').filter((row) => row !== '');
    let ahead: number | null = null;
    let behind: number | null = null;
    if (base !== null) {
      try {
        const [left, right] = (await git(cwd, ['rev-list', '--left-right', '--count', `${base}...HEAD`])).trim().split(/\s+/u);
        behind = Number(left);
        ahead = Number(right);
        if (Number.isNaN(ahead) || Number.isNaN(behind)) ahead = behind = null;
      } catch {
        // base исчез или не ветка: без счётчиков
      }
    }
    return { cwd, branch: branch === '' ? null : branch, status, ahead, behind };
  } catch {
    return null;
  }
}

/** Файл хвоста `.parley/works/<w>/handover/<s>-<n>.md`, n — следующий свободный номер. */
async function writeTail(projectPath: string, workId: string, sessionId: string, text: string): Promise<string> {
  const dir = path.join(workPaths(projectPath, workId).dir, 'handover');
  await mkdir(dir, { recursive: true });
  const pattern = new RegExp(`^${sessionId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}-(\\d+)\\.md$`, 'u');
  const taken = (await readdir(dir)).map((name) => Number(pattern.exec(name)?.[1] ?? 0));
  for (let n = Math.max(0, ...taken) + 1; ; n += 1) {
    const file = path.join(dir, `${sessionId}-${n}.md`);
    try {
      await writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

/** Собирает пакет с диска: карта, непрочитанное, git, хвост разговора. Сбой git или транскрипта часть пропускает. */
export async function collectHandover(
  projectPath: string,
  workId: string,
  sessionId: string,
  previous: HandoverInput['previous'],
  target: HandoverInput['target'],
): Promise<{ text: string; tailFile: string | null }> {
  const map = await readMap(projectPath, workId);
  const session = map.sessions.find((s) => s.id === sessionId);
  const unread = unreadLetters(projectPath, workId, sessionId, { map }).map((m) => ({
    id: m.id, from: m.from, roomId: m.roomId, kind: m.kind, text: m.text, at: m.at,
  }));
  const worktree = await readWorktree(session?.worktree?.path ?? projectPath, session?.worktree?.base ?? null);

  let tail: HandoverInput['tail'] = null;
  const providerSessionId = session?.providerSessionId ?? null;
  if (providerSessionId !== null) {
    try {
      const transcript = await readTranscript(previous.provider as WorkProvider, providerSessionId);
      if (transcript !== null && transcript.trim() !== '') {
        tail = { text: transcript, file: await writeTail(projectPath, workId, sessionId, transcript) };
      }
    } catch {
      // без хвоста: пакет скажет, что транскрипта нет
    }
  }
  return { text: formatHandover({ map, sessionId, previous, target, unread, worktree, tail }), tailFile: tail?.file ?? null };
}
