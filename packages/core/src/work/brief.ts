import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMember, liveLead } from './rooms.js';
import { ensureStateDir } from './state-dir.js';
import { displayStatus } from './status-view.js';
import { workPaths } from './store.js';
import { decisionsOf, participantLabel, sessionMention, threadOf } from './thread.js';
import { HUMAN, type WorkMap, type WorkSession } from './types.js';

/**
 * Три правила, без которых агент не узнает про карту (спецификация, раздел 5).
 * Текст один и тот же для порождённых агентом и созданных руками сессий.
 */
const RULES = [
  'At the start, call `get_map` — you get the workspace map and the list of providers.',
  "Colleagues' messages arrive by themselves; answer a `question` to whoever asked, with `send_message`, and do not end a turn with an unanswered question; do not answer a `note` or a `decision`; mark an agreement with one `kind: decision` message.",
  'Before finishing you must call `report` — otherwise the result will not go anywhere.',
];

/**
 * Роль в комнате (дизайн комнат, 2.4 и 3.3): ведущему — собрать позиции, предложить решение и не
 * начинать работу до принятия; участнику — высказаться, ждать свою часть и отчитаться ведущему. Пока
 * решение ждёт, новое сообщение человека всем цикл не перезапускает: ни позиции заново, ни сбор заново;
 * ведущий читает его как поправку к решению (меняет суть — повторный `propose_decision`, иначе ничего).
 * Здесь только суть, подробности — в гиде: бриф нарочно короткий.
 */
const LEAD_ROLE =
  "you are the lead. The human sets a task for everyone in the room — collect the participants' positions (each answers in the room with one message), propose a decision with `propose_decision` and do not start the work before acceptance. While a decision waits (the room's `proposal` in `get_map` is not `null`), a new human message to everyone is not a new task: do not collect positions again. Such a message is a correction to the waiting decision: if it changes the substance, take it into account and replace the text with a repeated `propose_decision`, otherwise do nothing. Accepted — hand out the parts with mentions like `@s07`; returned — redo it and propose again.";

/**
 * Участнику нужен его токен: по нему в раздаче частей он находит своё. Задача человека — не реплика
 * коллеги: ответ нужен и на письмо вида `note`, иначе правило брифа «do not answer a `note`» с ней спорит.
 */
const memberRole = (mention: string): string =>
  `The human sets a task for everyone in the room — speak up in one message to the room (answer even if the human's message is a \`note\`), do not start the work until the lead names your part (the lead hands out parts with mentions, yours is \`${mention}\`), and when done report to the lead in the room. While a decision waits (the room's \`proposal\` in \`get_map\` is not \`null\`), a new human message to everyone is not a new task: do not write positions again.`;

/**
 * Время решения — местное и короткое: бриф читают рядом с человеком, которому
 * UTC из карты ни о чём не говорит (спецификация 2026-09-08, 5.2).
 */
const clock = (at: string): string =>
  new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

function sessionOf(map: WorkMap, sessionId: string): WorkSession {
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new Error(`session ${sessionId} is not in the map`);
  return session;
}

/**
 * Стартовый промпт сессии. Нарочно короткий: содержимое артефактов сюда не
 * копируется, только пути — план агент прочитает сам, если он ему нужен.
 */
export function buildBrief(map: WorkMap, sessionId: string): string {
  const session = sessionOf(map, sessionId);
  const lines: string[] = [`# Workspace ${map.work.id} — ${map.work.title}`, ''];

  if (map.work.goal !== '') lines.push(`Goal: ${map.work.goal}`, '');
  lines.push(`## Your session: ${session.id} — ${session.label}`, '');
  // Тихий старт: задачи нет, и пустая строка «Task:» только сбивала бы с
  // толку — её напишет пользователь первым сообщением (раздел B плана).
  if (session.task !== '') lines.push(`Task: ${session.task}`, '');
  // Без этой строки агент в worktree не знает, на какой он ветке и во что её
  // вольют, а правила (не переключать ветку, не пушить) лежат только в гиде.
  // Путь в плане есть всегда: `createdAt: null` значит лишь, что хост создаст
  // папку перед запуском, — к чтению брифа агентом она уже на месте.
  // Указатель на гид — по имени темы (`topic` у `read_guide`), а не по заголовку раздела:
  // заголовок агент в `read_guide` передать не может, а тема и раздел не совпадают.
  if (session.worktree !== null) {
    const { branch, base, path: folder } = session.worktree;
    lines.push(
      `Worktree: branch \`${branch}\` off base \`${base}\`, folder \`${folder}\`.`,
      'The rules for working in a worktree are in `read_guide`, topic `worktrees`.',
      '',
    );
  }

  if (session.contextFrom.length > 0) {
    lines.push('## Context', '');
    for (const id of session.contextFrom) {
      const source = sessionOf(map, id);
      lines.push(`### ${source.id} — ${source.label}`, '');
      lines.push(source.summary === null ? 'summary: none' : `Summary: ${source.summary}`);
      if (source.artifacts.length > 0) {
        lines.push('Artifacts:');
        for (const artifact of source.artifacts) {
          lines.push(`- ${artifact.kind} — ${artifact.path}`);
        }
      }
      lines.push('');
    }
  }

  // Знакомство с коллегами и уже принятыми решениями треда (спецификация 5.2):
  // без них сессия не знает, кому писать, и переспрашивает то, о чём в её
  // группе договорились до неё. Пустые разделы не печатаются.
  const thread = threadOf(map, session.id);
  const colleagues = thread.members.filter((id) => id !== session.id);
  // Комнаты, где сессия участник (этап 3, раздел 6.3): без них сессия узнаёт
  // о своих комнатах только из ответа `create_room`, а на резюме сессии в
  // брифе комната появляется у всех остальных участников.
  const rooms = map.rooms.filter((room) => isMember(room, session.id));
  if (colleagues.length > 0 || rooms.length > 0) {
    lines.push('## Colleagues', '');
    for (const id of colleagues) {
      const mate = sessionOf(map, id);
      // Пометки в одних скобках: «(parent, agent planner)» (спецификация 5.2).
      // Роль коллеги видна сразу — с планировщиком и с ревьюером говорят
      // по-разному, а лезть за этим в карту незачем.
      const marks = [
        ...(id === session.parent ? ['parent'] : []),
        ...(mate.agent === null ? [] : [`agent ${mate.agent}`]),
      ];
      const mark = marks.length === 0 ? '' : ` (${marks.join(', ')})`;
      lines.push(`- ${mate.id} — ${mate.label}${mark}: ${displayStatus(mate)}`);
    }
    for (const room of rooms) {
      // Создатель в `members` не пишется (спецификация 6.1), поэтому состав
      // собираем из него и списка участников; себя в составе не повторяем.
      const participants = [room.creator, ...room.members]
        .filter((id, at, all) => all.indexOf(id) === at && id !== session.id)
        .map((id) => (id === HUMAN ? 'human' : participantLabel(map, id)));
      const composition = participants.length === 0 ? '' : `: ${participants.join(', ')}`;
      lines.push(`- ${room.id} "${room.title}"${composition}`);
    }
    lines.push('');
  }

  // Роль в комнате: состав выше говорит, кто рядом, но не кто собирает решение. Ведущий — `liveLead`, тот
  // же, кому `setProposal` разрешит `propose_decision`: назначенный, пока жив, иначе первый живой участник.
  // Закрытая комната (ведущего нет) роли не получает.
  const roles = rooms.flatMap((room) => {
    const lead = liveLead(map, room);
    if (lead === null) return [];
    const head = `- ${room.id} "${room.title}": `;
    if (lead === session.id) return [`${head}${LEAD_ROLE}`];
    const name = `${lead} (${participantLabel(map, lead)})`;
    return [`${head}the lead is ${name}. ${memberRole(sessionMention(session.id))}`];
  });
  if (roles.length > 0) {
    lines.push(
      '## Role in the room',
      '',
      ...roles,
      '',
      'Details are in `read_guide`, topics `lead` and `member`.',
      '',
    );
  }

  const decisions = decisionsOf(thread);
  if (decisions.length > 0) {
    lines.push('## Thread decisions', '');
    for (const decision of decisions) {
      const who = participantLabel(map, decision.from);
      lines.push(`- ${clock(decision.at)} ${who}: "${decision.text}"`);
    }
    lines.push('');
  }

  lines.push('## Rules', '');
  RULES.forEach((rule, at) => lines.push(`${at + 1}. ${rule}`));
  lines.push('');
  return lines.join('\n');
}

/**
 * Сохраняет бриф в `briefs/<session-id>.md`. Файл можно прочитать и поправить
 * до запуска: `planLaunch` перечитывает его с диска, когда `pending` запускают.
 */
export async function writeBrief(
  projectPath: string,
  map: WorkMap,
  sessionId: string,
): Promise<string> {
  const text = buildBrief(map, sessionId);
  const paths = workPaths(projectPath, map.work.id);
  const file = path.join(paths.briefs, `${sessionId}.md`);
  // Каталог состояния заводит `ensureStateDir`: новый `.parley` получает свой `.gitignore` (R5), даже если
  // его стёрли вместе с работой, а бриф пишут заново.
  await ensureStateDir(projectPath);
  await mkdir(paths.briefs, { recursive: true });
  await writeFile(file, text, 'utf8');
  return file;
}
