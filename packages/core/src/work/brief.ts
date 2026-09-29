import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMember, liveLead } from './rooms.js';
import { displayStatus } from './status-view.js';
import { workPaths } from './store.js';
import { decisionsOf, participantLabel, sessionMention, threadOf } from './thread.js';
import { HUMAN, type WorkMap, type WorkSession } from './types.js';

/**
 * Три правила, без которых агент не узнает про карту (спецификация, раздел 5).
 * Текст один и тот же для порождённых агентом и созданных руками сессий.
 */
const RULES = [
  'В начале работы вызови `get_map` — получишь карту работы и список провайдеров.',
  'Письма коллег приходят сами; на `question` отвечай тому, кто спросил, через `send_message`, и не заканчивай ход с неотвеченным вопросом; на `note` и `decision` не отвечай; договорённость помечай одним письмом `kind: decision`.',
  'Перед завершением обязательно вызови `report` — иначе результат никуда не попадёт.',
];

/**
 * Роль в комнате (дизайн комнат, 3.3): ведущему — собрать позиции, предложить решение и не начинать
 * работу до принятия; участнику — высказаться, ждать свою часть и отчитаться ведущему. Здесь только
 * суть, подробности — в гиде: бриф нарочно короткий.
 */
const LEAD_ROLE =
  'ты ведущий. Человек ставит в комнате задачу всем — собери позиции участников (каждый отвечает в комнате одним сообщением), предложи решение через `propose_decision` и до принятия работу не начинай. Принято — раздай части упоминаниями вида `@s07`, возврат — переделай и предложи снова.';

/** Участнику нужен его токен: по нему в раздаче частей он находит своё. */
const memberRole = (mention: string): string =>
  `Человек ставит в комнате задачу всем — выскажись одним сообщением в комнату, работу не начинай, пока ведущий не назвал твою часть (он раздаёт части упоминаниями, твоё — \`${mention}\`), сделав — отчитайся в комнате ведущему.`;

/**
 * Время решения — местное и короткое: бриф читают рядом с человеком, которому
 * UTC из карты ни о чём не говорит (спецификация 2026-09-08, 5.2).
 */
const clock = (at: string): string =>
  new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

function sessionOf(map: WorkMap, sessionId: string): WorkSession {
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new Error(`сессии ${sessionId} нет в карте`);
  return session;
}

/**
 * Стартовый промпт сессии. Нарочно короткий: содержимое артефактов сюда не
 * копируется, только пути — план агент прочитает сам, если он ему нужен.
 */
export function buildBrief(map: WorkMap, sessionId: string): string {
  const session = sessionOf(map, sessionId);
  const lines: string[] = [`# Работа ${map.work.id} — ${map.work.title}`, ''];

  if (map.work.goal !== '') lines.push(`Цель: ${map.work.goal}`, '');
  lines.push(`## Твоя сессия: ${session.id} — ${session.label}`, '');
  // Тихий старт: задачи нет, и пустая строка «Задача:» только сбивала бы с
  // толку — её напишет пользователь первым сообщением (раздел B плана).
  if (session.task !== '') lines.push(`Задача: ${session.task}`, '');
  // Без этой строки агент в worktree не знает, на какой он ветке и во что её
  // вольют, а правила (не переключать ветку, не пушить) лежат только в гиде.
  // Путь в плане есть всегда: `createdAt: null` значит лишь, что хост создаст
  // папку перед запуском, — к чтению брифа агентом она уже на месте.
  if (session.worktree !== null) {
    const { branch, base, path: folder } = session.worktree;
    lines.push(
      `Worktree: ветка \`${branch}\` от базы \`${base}\`, папка \`${folder}\`.`,
      'Правила работы в worktree — в `read_guide`, раздел «Окно человека».',
      '',
    );
  }

  if (session.contextFrom.length > 0) {
    lines.push('## Контекст', '');
    for (const id of session.contextFrom) {
      const source = sessionOf(map, id);
      lines.push(`### ${source.id} — ${source.label}`, '');
      lines.push(source.summary === null ? 'резюме: нет' : `Резюме: ${source.summary}`);
      if (source.artifacts.length > 0) {
        lines.push('Артефакты:');
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
    lines.push('## Коллеги', '');
    for (const id of colleagues) {
      const mate = sessionOf(map, id);
      // Пометки в одних скобках: «(родитель, агент planner)» (спецификация 5.2).
      // Роль коллеги видна сразу — с планировщиком и с ревьюером говорят
      // по-разному, а лезть за этим в карту незачем.
      const marks = [
        ...(id === session.parent ? ['родитель'] : []),
        ...(mate.agent === null ? [] : [`агент ${mate.agent}`]),
      ];
      const mark = marks.length === 0 ? '' : ` (${marks.join(', ')})`;
      lines.push(`- ${mate.id} — ${mate.label}${mark}: ${displayStatus(mate)}`);
    }
    for (const room of rooms) {
      // Создатель в `members` не пишется (спецификация 6.1), поэтому состав
      // собираем из него и списка участников; себя в составе не повторяем.
      const participants = [room.creator, ...room.members]
        .filter((id, at, all) => all.indexOf(id) === at && id !== session.id)
        .map((id) => (id === HUMAN ? 'человек' : participantLabel(map, id)));
      const composition = participants.length === 0 ? '' : `: ${participants.join(', ')}`;
      lines.push(`- ${room.id} «${room.title}»${composition}`);
    }
    lines.push('');
  }

  // Роль в комнате: состав выше говорит, кто рядом, но не кто собирает решение. Ведущий — `liveLead`, тот
  // же, кому `setProposal` разрешит `propose_decision`: назначенный, пока жив, иначе первый живой участник.
  // Закрытая комната (ведущего нет) роли не получает.
  const roles = rooms.flatMap((room) => {
    const lead = liveLead(map, room);
    if (lead === null) return [];
    const head = `- ${room.id} «${room.title}»: `;
    if (lead === session.id) return [`${head}${LEAD_ROLE}`];
    const name = `${lead} (${participantLabel(map, lead)})`;
    return [`${head}ведущий — ${name}. ${memberRole(sessionMention(session.id))}`];
  });
  if (roles.length > 0) {
    lines.push(
      '## Роль в комнате',
      '',
      ...roles,
      '',
      'Подробности — в `read_guide`, раздел «Комнаты».',
      '',
    );
  }

  const decisions = decisionsOf(thread);
  if (decisions.length > 0) {
    lines.push('## Решения треда', '');
    for (const decision of decisions) {
      const who = participantLabel(map, decision.from);
      lines.push(`- ${clock(decision.at)} ${who}: «${decision.text}»`);
    }
    lines.push('');
  }

  lines.push('## Правила', '');
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
  await mkdir(paths.briefs, { recursive: true });
  await writeFile(file, text, 'utf8');
  return file;
}
