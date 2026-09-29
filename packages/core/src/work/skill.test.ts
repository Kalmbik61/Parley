import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createHarnasServer } from '../mcp/tools.js';
import { GUIDE_TOPICS } from './guide.js';
import { SKILL_MD, SKILL_NAME, skillStub } from './skill.js';

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

describe('заглушка скилла harnas: frontmatter по спецификации Agent Skills', () => {
  const { front, body } = parts(SKILL_MD);

  it('name — harnas: строчные латиница, цифры и дефис, до 64 знаков, как имя каталога', () => {
    expect(field(front, 'name')).toBe('harnas');
    expect(SKILL_NAME).toBe('harnas');
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

  it('description отвечает «когда подключаться» и «когда нет»: сервер harnas, инструменты, без сервера не нужен', () => {
    const description = JSON.parse(field(front, 'description')) as string;

    expect(description).toMatch(/MCP-сервер harnas/);
    for (const word of ['карта работы', 'комнаты', 'ведущий', 'решения', 'письма', 'отчёты']) {
      expect(description, word).toContain(word);
    }
    expect(description).toMatch(/Без сервера harnas навык не нужен/);
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
});

describe('заглушка скилла harnas: тело', () => {
  const { body } = parts(SKILL_MD);

  it('отсылает к read_guide и не пересказывает гид', () => {
    expect(body).toContain('`read_guide`');
    expect(body).toMatch(/Не пересказывай гид по памяти/);
  });

  it('правила-ворота: не выдумывать инструменты, решение только через ведущего, add_to_room, отчёт', () => {
    expect(body).toMatch(/Не выдумывай инструменты и параметры по памяти: сначала `read_guide`/);
    expect(body).toMatch(
      /Решение человеку приносит только ведущий комнаты — через `propose_decision`/,
    );
    expect(body).toMatch(/до принятия работу не начинай/);
    expect(body).toMatch(/Ввести в комнату ещё одну сессию может только ведущий — `add_to_room`/);
    expect(body).toMatch(/`close_session` — только после явного согласия человека/);
    expect(body).toMatch(/Перед завершением вызови `report`/);
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

  it('раздел «Как загрузить гид» перечисляет темы подряд: чужих тем между ними нет', () => {
    const section = body.split('## Как загрузить гид')[1]?.split('\n## ')[0] ?? '';
    const names = section
      .split('\n')
      .map((line) => /^- `([a-z]+)`/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);

    expect(names).toEqual(GUIDE_TOPICS.map((item) => item.topic));
  });

  it('каждый инструмент, названный в заглушке, существует на MCP-сервере: выдуманного она не советует', async () => {
    const server = createHarnasServer({
      projectPath: '/нет/такого/проекта',
      workId: 'w-0001',
      workDir: '/нет/такого/проекта/.harnas/works/w-0001',
      sessionId: null,
      channel: false,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const tools = new Set((await client.listTools()).tools.map((tool) => tool.name));
      // Слова в кавычках, которые не инструменты: аргумент, виды писем, имя сервера и темы гида.
      const notTools = new Set([
        'topic',
        'question',
        'note',
        'decision',
        'harnas',
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
