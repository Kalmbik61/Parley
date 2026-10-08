import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createParleyServer } from '../mcp/tools.js';
import { LEGACY_SKILL_NAME, MCP_SERVER_NAME, SKILL_NAME } from '../names.js';
import { GUIDE_TOPICS } from './guide.js';
import { SKILL_MD, skillStub } from './skill.js';

/** Frontmatter и тело `SKILL.md`: между первой и второй строкой `---`. */
function parts(text: string): { front: string[]; body: string } {
  const lines = text.split('\n');
  expect(lines[0]).toBe('---');
  const end = lines.indexOf('---', 1);
  expect(end).toBeGreaterThan(1);
  return { front: lines.slice(1, end), body: lines.slice(end + 1).join('\n') };
}

/** Значение поля frontmatter; `description` идёт строкой в двойных кавычках — JSON-строкой. */
function field(front: string[], name: string): string {
  const line = front.find((candidate) => candidate.startsWith(`${name}: `));
  if (line === undefined) throw new Error(`в frontmatter нет поля ${name}`);
  return line.slice(name.length + 2);
}

describe('заглушка скилла parley: frontmatter по спецификации Agent Skills', () => {
  const { front, body } = parts(SKILL_MD);

  it('name — parley: строчные латиница, цифры и дефис, до 64 знаков, как имя каталога', () => {
    expect(field(front, 'name')).toBe('parley');
    expect(SKILL_NAME).toBe('parley');
    expect(SKILL_NAME).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(SKILL_NAME.length).toBeLessThanOrEqual(64);
  });

  it('description — валидная YAML-строка в кавычках, не пуста и короче пределов обоих CLI', () => {
    const description = JSON.parse(field(front, 'description')) as string;

    expect(description.trim()).not.toBe('');
    // Спецификация: до 1024 знаков. Claude Code режет описание в списке навыков по 1536, Codex —
    // по доле контекста на весь список: чем короче, тем целее.
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description.length).toBeLessThanOrEqual(1536);
  });

  it('description отвечает «когда подключаться» и «когда нет»: сервер parley, инструменты, без сервера не нужен', () => {
    const description = JSON.parse(field(front, 'description')) as string;

    expect(description).toContain(`${MCP_SERVER_NAME} MCP server`);
    expect(description).toMatch(/parley MCP server/);
    for (const word of ['workspace map', 'rooms', 'lead', 'decisions', 'messages', 'reports']) {
      expect(description, word).toContain(word);
    }
    expect(description).toMatch(/Without the parley server the skill is not needed/);
  });

  it('в frontmatter только name и description: лишних полей Codex и Claude Code не ждут', () => {
    expect(front.map((line) => line.split(':')[0])).toEqual(['name', 'description']);
  });

  it('тело короткое: спецификация рекомендует до 500 строк, заглушка — одна экранная страница', () => {
    expect(body.split('\n').length).toBeLessThan(60);
    expect(SKILL_MD.endsWith('\n')).toBe(true);
  });

  it('заглушка одна и та же при каждом вызове', () => {
    expect(skillStub()).toBe(SKILL_MD);
  });

  it('текст заглушки — по-английски: кириллицы в нём нет', () => {
    expect(SKILL_MD).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('прежнего имени в заглушке нет: ни сервера, ни тега, ни продукта (R8)', () => {
    expect(SKILL_MD.toLowerCase()).not.toContain(LEGACY_SKILL_NAME);
  });
});

describe('заглушка скилла parley: тело', () => {
  const { body } = parts(SKILL_MD);

  it('отсылает к read_guide и не пересказывает гид', () => {
    expect(body).toContain('`read_guide`');
    expect(body).toMatch(/Do not retell the guide from memory/);
  });

  it('правила-ворота: не выдумывать инструменты, решение только через ведущего, add_to_room, отчёт', () => {
    expect(body).toMatch(/Do not invent tools and parameters from memory: call `read_guide` first/);
    expect(body).toMatch(
      /Only a room's lead brings the human a decision — with `propose_decision`/,
    );
    expect(body).toMatch(/do not start the work before acceptance/);
    expect(body).toMatch(/Only the lead can bring one more session into a room — `add_to_room`/);
    expect(body).toMatch(/`close_session` — only after the human's explicit consent/);
    expect(body).toMatch(/Before finishing, call `report`/);
  });

  it('правило про письма: коллегам — только на question, но задача человека в комнате требует ответа, даже если письмо — note', () => {
    // Заглушку агент читает первой: исключение, которое есть в гиде (тема `member`) и в системной вставке,
    // должно быть и здесь, иначе «на `note` не отвечай» перекроет задачу человека.
    expect(body).toMatch(
      /answer only a `question`, do not answer a `note` or a `decision`\. A human's message is not a colleague's reply: answer the human's task in a room whatever the kind of message \(even `note`\)\./,
    );
  });

  it('правило про задачу человека всем: письмо приходит с roomTask — роль, ведущий, подсказка', () => {
    expect(body).toMatch(
      /The human's task for everyone in a room arrives from `check_inbox` marked `toEveryone: true` with `roomTask` \(your role, the lead, a hint\): follow it\./,
    );
  });

  it('правило про ответы в комнате (Parley 0.3.0): replyTo с id сообщения, человеку — без to, @human — простым текстом и по делу', () => {
    // Агент, который не открыл тему `rooms`, всё равно должен ответить с цитатой и не звать человека через `to`.
    expect(body).toMatch(
      /Answering a particular message in a room — above all the human's question — pass `replyTo` with its id: the window shows a quote of it above your answer\./,
    );
    expect(body).toMatch(/The human is not a session: answer the human in the room without `to`\./);
    expect(body).toMatch(
      /Write `@human` as plain text, and only when you need the human's answer or attention: it notifies the human\./,
    );
    // Тема `rooms` в списке называет и ответы, и `@human`: по подписи агент поймёт, что открыть.
    expect(body).toContain(
      '- `rooms` — rooms: create_room, messages to a room, replies (replyTo), @human, read_room',
    );
  });
});

describe('заглушка скилла parley: как приходят письма', () => {
  const { body } = parts(SKILL_MD);

  it('в окне письма объявляет указатель после хода, тег channel — только у сессий CLI parley-core', () => {
    // Заглушку агент читает первой, и обещать ему тег канала как обычный путь нельзя: хост окна запускает
    // сессии без канала и печатает указатель после хода (`delivery.ts`), тег бывает лишь у CLI.
    expect(body).toMatch(
      /In window sessions messages arrive as the pointer "New messages \(N\)… Call check_inbox\." after your turn — call `check_inbox`\./,
    );
    expect(body).toMatch(
      /The `<channel source="parley">` tag exists only in sessions started by the `parley-core` CLI\./,
    );
  });

  it('тег channel упомянут только вместе с CLI parley-core: как обычный способ он не обещан', () => {
    const mentions = body.split('\n').filter((text) => text.includes('<channel'));

    expect(mentions).not.toHaveLength(0);
    for (const line of mentions) expect(line).toContain('parley-core');
  });
});

describe('заглушка и гид согласованы', () => {
  const { body } = parts(SKILL_MD);

  /** Строки списка тем в заглушке: «- `тема` — что внутри». */
  const listed = (): { topic: string; summary: string }[] =>
    body
      .split('\n')
      .map((line) => /^- `([a-z]+)` — (.+)$/.exec(line))
      .flatMap((match) =>
        match?.[1] === undefined ? [] : [{ topic: match[1], summary: match[2] ?? '' }],
      )
      .filter((item) => GUIDE_TOPICS.some((topic) => topic.topic === item.topic));

  it('в заглушке ровно те темы, что отдаёт read_guide, в том же порядке и с теми же подписями', () => {
    expect(listed()).toEqual(GUIDE_TOPICS.map(({ topic, summary }) => ({ topic, summary })));
  });

  it('раздел «How to load the guide» перечисляет темы подряд: чужих тем между ними нет', () => {
    const section = body.split('## How to load the guide')[1]?.split('\n## ')[0] ?? '';
    const names = section
      .split('\n')
      .map((line) => /^- `([a-z]+)`/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);

    expect(names).toEqual(GUIDE_TOPICS.map((item) => item.topic));
  });

  it('каждый инструмент, названный в заглушке, существует на MCP-сервере: выдуманного она не советует', async () => {
    const server = createParleyServer({
      projectPath: '/нет/такого/проекта',
      workId: 'w-0001',
      workDir: '/нет/такого/проекта/.parley/works/w-0001',
      sessionId: null,
      channel: false,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const tools = new Set((await client.listTools()).tools.map((tool) => tool.name));
      // Слова в кавычках, которые не инструменты: аргументы (`topic` у read_guide, `to` у send_message), виды писем,
      // имя сервера и темы гида.
      const notTools = new Set([
        'topic',
        'to',
        'question',
        'note',
        'decision',
        'parley',
        ...GUIDE_TOPICS.map((item) => item.topic),
      ]);
      const named = [...SKILL_MD.matchAll(/`([a-z]+(?:_[a-z]+)*)`/g)]
        .map((match) => match[1] ?? '')
        .filter((word) => !notTools.has(word));

      expect(named.length).toBeGreaterThan(5);
      for (const word of new Set(named)) expect(tools.has(word), word).toBe(true);
      // И главное: сами инструменты, без которых заглушка бессмысленна, на месте.
      for (const needed of ['read_guide', 'get_map', 'propose_decision', 'add_to_room']) {
        expect(tools.has(needed), needed).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
