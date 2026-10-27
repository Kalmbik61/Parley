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

  it('темы гида — комнаты, ведущий, участник, застрявший, письма, worktree и окно среди них', () => {
    const names = GUIDE_TOPICS.map((item) => item.topic);

    for (const needed of ['rooms', 'lead', 'member', 'stuck', 'letters', 'worktrees', 'window']) {
      expect(names).toContain(needed);
    }
  });

  it('тема stuck: заголовок, строка «что внутри» и правила для ведущего и участника (спека застрявших 5.4)', () => {
    expect(guideTopic('stuck')).toMatch(/^### When a participant is stuck\n/);
    expect(GUIDE_TOPICS.find((item) => item.topic === 'stuck')?.summary).toBe(
      'a participant waits for the human or its usage limit: what to do and what not to do',
    );
    const text = (guideTopic('stuck') ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('`stuck` of `get_map`');
    expect(text).toContain('Do not write `@human` about it again.');
    expect(text).toContain('If you are not the lead, do not call the human about it: the lead does.');
    expect(text).toContain('`wait_for` on a stuck participant returns `{"state":"stuck"}` at once');
  });

  it('тема lead, шаг 1: застрявший участник, о котором написал Parley, не молчит — отсылка к теме stuck', () => {
    const text = (guideTopic('lead') ?? '').replace(/\s+/g, ' ');

    expect(text).toContain(
      'it can be replaced by a repeated call. A participant Parley reported as stuck is not silent: see topic `stuck`.',
    );
  });

  it('тема stuck: при limit ведущий пишет @human и ждёт ответа, замену на свободном аккаунте не заводит сам (решение 6 спеки подписок)', () => {
    const text = (guideTopic('stuck') ?? '').replace(/\s+/g, ' ');
    // Одно сообщение с вариантами, включая замену на названном свободном аккаунте.
    expect(text).toContain('write one message to `@human`');
    expect(text).toContain('start a replacement on the named account');
    // Ответ человека обязателен до `create_session`.
    expect(text).toContain('Never start a replacement on your own: ask `@human` first and wait for the answer.');
    // После «да»: create_session (task обязателен — с указателем на поля застрявшего в карте), потом add_to_room,
    // потом письмо застрявшему (решение 10 итогового ревью).
    expect(text).toContain(
      "After a yes: `create_session` with that `provider` and a `task` that points at the stuck participant's fields in `get_map`",
    );
    expect(text.indexOf('`create_session` with that `provider`')).toBeLessThan(text.indexOf('then `add_to_room` for the new session'));
    expect(text.indexOf('then `add_to_room` for the new session')).toBeLessThan(
      text.indexOf('tell the stuck participant in a message that its part was taken over'),
    );
    expect(text.indexOf('ask `@human` first')).toBeLessThan(text.indexOf('After a yes'));
  });

  it('тема tools: wait_for кончается и состоянием stuck, со ссылкой на тему stuck', () => {
    const text = (guideTopic('tools') ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('The answer `state: "stuck"` means the session waits for the human');
    expect(text).toContain('do not call `wait_for` for it again, see topic `stuck`');
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

  it('тема window называет скилл parley-browser в подразделе про встроенный браузер', () => {
    const text = guideTopic('window') ?? '';
    expect(text).toContain('### The built-in browser');
    expect(text).toContain('parley-browser');
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

describe('правила переписки', () => {
  it('тема letters задаёт предел письма, файл с путём и replyTo', () => {
    const text = guideTopic('letters') ?? '';

    expect(text).toContain('1200');
    expect(text).toContain('path');
    expect(text).toContain('replyTo');
  });

  it('карта — память работы у Parley: читать её только через get_map, read_room и check_inbox, файл map.json не упомянут', () => {
    expect(guideTopic('rules')).toMatch(/Read the workspace map only through `get_map`, `read_room` and `check_inbox`/);
    expect(guideTopic('overview')).toMatch(/kept by Parley/);
    expect(GUIDE).not.toContain('map.json');
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

describe('профиль short в гиде', () => {
  it('guide({ toolProfile: "short" }) не знает о памяти; полный гид знает', () => {
    for (const name of ['remember', 'memory_read', 'search_history']) {
      expect(guide(), name).toContain(name);
      expect(guide({ toolProfile: 'short' }), name).not.toContain(name);
      expect(guideTopic('tools', { toolProfile: 'short' }) ?? '', name).not.toContain(name);
    }
    expect(guideTopic('tools', { toolProfile: 'short' })).toContain('backlog_suggest');
    expect(guideTopic('tools', { toolProfile: 'short' })).toContain('report(status, summary, artifacts)');
  });

  it('short убирает только абзац о памяти: остальные темы и объект без профиля совпадают с прежним гидом', () => {
    expect(guide({})).toBe(GUIDE);
    expect(guide({ skillNavigator: false })).toBe(GUIDE);
    for (const { topic } of GUIDE_TOPICS) {
      if (topic !== 'tools') expect(guideTopic(topic, { toolProfile: 'short' }), topic).toBe(guideTopic(topic));
    }
    const full = guideTopic('tools') ?? '';
    const short = guideTopic('tools', { toolProfile: 'short' }) ?? '';
    expect(short.length).toBeLessThan(full.length);
    expect(short).not.toMatch(/\n\n\n/);
    expect(guide({ skillNavigator: true, toolProfile: 'short' })).toContain('find_skill');
    expect(guide({ skillNavigator: true, toolProfile: 'short' })).not.toContain('memory_read');
  });
});
