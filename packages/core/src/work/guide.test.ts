import { describe, expect, it } from 'vitest';
import { GUIDE, GUIDE_TOPICS, guide, guideTopic } from './guide.js';

/** Тексты тем без завершающего перевода строки — так они лежат в гиде между пустыми строками. */
const bodies = (): string[] => GUIDE_TOPICS.map((item) => (guideTopic(item.topic) ?? '').trimEnd());

describe('темы гида', () => {
  it('имя темы — латиница строчными, без повторов; у каждой есть строка «что внутри»', () => {
    const names = GUIDE_TOPICS.map((item) => item.topic);

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^[a-z]+$/);
    expect(new Set(names).size).toBe(names.length);
    for (const item of GUIDE_TOPICS) expect(item.summary.trim(), item.topic).not.toBe('');
  });

  it('темы гида — комнаты, ведущий, участник, письма, worktree и окно среди них', () => {
    const names = GUIDE_TOPICS.map((item) => item.topic);

    for (const needed of ['rooms', 'lead', 'member', 'letters', 'worktrees', 'window']) {
      expect(names).toContain(needed);
    }
  });

  it('раздел темы не пуст и начинается своим заголовком', () => {
    for (const text of bodies()) expect(text).toMatch(/^#{2,3} \S/);
  });

  it('темы по порядку склеиваются в весь гид: ничего не потеряно и не задвоено', () => {
    const title = GUIDE.split('\n')[0];

    expect(`${title}\n\n${bodies().join('\n\n')}\n`).toBe(GUIDE);
  });

  it('тема с текстом заканчивается переводом строки, как и весь гид', () => {
    for (const item of GUIDE_TOPICS)
      expect(guideTopic(item.topic)?.endsWith('\n'), item.topic).toBe(true);
    expect(GUIDE.endsWith('\n')).toBe(true);
  });

  it('заголовки подтем: ведущий, участник и worktree — темы сами по себе, а не куски чужих', () => {
    expect(guideTopic('lead')).toMatch(/^### The lead and the decision\n/);
    expect(guideTopic('member')).toMatch(/^### Room participant\n/);
    expect(guideTopic('worktrees')).toMatch(/^### Session worktree\n/);
    // Комнаты — до ролей, окно — до worktree: роли и worktree не дублируются в родительских темах.
    expect(guideTopic('rooms')).not.toContain('### The lead and the decision');
    expect(guideTopic('window')).not.toContain('### Session worktree');
  });

  it('темы lead и member говорят, как задача человека всем приходит в письме: toEveryone и roomTask', () => {
    for (const topic of ['lead', 'member']) {
      const text = (guideTopic(topic) ?? '').replace(/\s+/g, ' ');
      expect(text, topic).toContain('`check_inbox`');
      expect(text, topic).toContain('`toEveryone: true`');
      expect(text, topic).toContain('`roomTask` field — your `role`, the `lead`, `proposalWaiting` and a `hint` with what to do');
    }
  });

  it('указатель check_inbox лежит в теме про письма', () => {
    expect(guideTopic('letters')).toContain('## The pointer');
    expect(guideTopic('letters')).toContain('New messages (N). Call check_inbox.');
  });

  it('неизвестная тема — null; сверка точная, без учёта регистра не гадает', () => {
    expect(guideTopic('нет-такой')).toBeNull();
    expect(guideTopic('')).toBeNull();
    expect(guideTopic('Rooms')).toBeNull();
  });
});

describe('ссылки между темами гида', () => {
  const names = GUIDE_TOPICS.map((item) => item.topic);

  /** Заголовки (`##`, `###`) всех разделов гида вместе с темой, в которой заголовок стоит. */
  const headings = (): { topic: string; heading: string }[] =>
    GUIDE_TOPICS.flatMap(({ topic }) =>
      (guideTopic(topic) ?? '').split('\n').flatMap((line) => {
        const heading = /^#{2,3} (.+)$/.exec(line)?.[1];
        return heading === undefined ? [] : [{ topic, heading }];
      }),
    );

  it('отсылка «topic `x`» называет существующую тему: в read_guide уйдёт то, что написано', () => {
    for (const { topic } of GUIDE_TOPICS) {
      for (const match of (guideTopic(topic) ?? '').matchAll(/topics? `([a-z]+)`/g)) {
        expect(names, `${topic}: ${match[0]}`).toContain(match[1]);
      }
    }
  });

  it('заголовки чужих разделов в кавычках не цитируются: по заголовку read_guide темы не найдёт', () => {
    for (const { topic } of GUIDE_TOPICS) {
      const text = guideTopic(topic) ?? '';
      for (const other of headings().filter((item) => item.topic !== topic)) {
        expect(text, `${topic} → "${other.heading}"`).not.toContain(`"${other.heading}"`);
      }
    }
  });

  /** Текст темы с пробелами, схлопнутыми в один: гид набран в столбик, переносы строк проверкам не важны. */
  const flat = (topic: string): string => (guideTopic(topic) ?? '').replace(/\s+/g, ' ');

  it('«Инструменты» отсылают за этикетом писем к теме `letters`, «Комнаты» — к ведущему в теме `lead`', () => {
    expect(flat('tools')).toContain(
      'the etiquette and the kinds of messages are in topic `letters`.',
    );
    expect(flat('rooms')).toContain('`add_to_room(room, session)` (topic `lead`).');
  });

  it('«Инструменты» отсылают за правилами worktree к теме `worktrees`, а та лежит отдельно от `window`', () => {
    expect(flat('tools')).toContain('The rules for working in it are in topic `worktrees`.');
    expect(guideTopic('worktrees')).toContain('do not switch the branch');
    expect(guideTopic('window')).not.toContain('do not switch the branch');
  });
});

describe('язык гида', () => {
  it('гид и подписи его тем — по-английски: кириллицы в тексте для агента нет', () => {
    expect(GUIDE).not.toMatch(/[А-Яа-яЁё]/);
    for (const item of GUIDE_TOPICS) expect(item.summary, item.topic).not.toMatch(/[А-Яа-яЁё]/);
  });
});

describe('optional navigator guide', () => {
  it('preserves the off guide and only extends tools and lead topics', () => {
    expect(guide()).toBe(GUIDE);
    expect(guide(false)).toBe(GUIDE);
    expect(GUIDE).not.toContain('find_skill');
    for (const { topic } of GUIDE_TOPICS) {
      if (topic === 'tools' || topic === 'lead') expect(guideTopic(topic, true)).toContain('find_skill');
      else expect(guideTopic(topic, true)).toBe(guideTopic(topic));
    }
    expect(guideTopic('tools', true)).toContain('unverified loading route');
    expect(guideTopic('tools', true)).toContain('full native CLI list');
    expect(guideTopic('lead', true)).toContain('query and for (a participant session id');
    expect(guideTopic('lead', true)).toContain('This is optional');
    expect(guide(true)).not.toMatch(/[А-Яа-яЁё]/);
  });
});

it('the unconditional plans topic never names a disabled skill tool; enabled full guide retains its conditional navigator hint', () => {
  expect(guideTopic('plans', false)).not.toContain('find_skill');
  expect(guide(false)).not.toContain('find_skill');
  expect(guide(true)).toContain('find_skill');
});
