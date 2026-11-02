import { describe, expect, it } from 'vitest';
import { GUIDE, GUIDE_TOPICS, guide, guideTopic } from './guide.js';

/** Тексты тем без завершающего перевода строки — так они лежат в гиде между пустыми строками. */
const bodies = (): string[] => GUIDE_TOPICS.map((item) => (guideTopic(item.topic) ?? '').trimEnd());

describe('темы гида', () => {
  it('объясняет частичный обзор и продолжение списков/точной ревизии плана', () => {
    const tools = guideTopic('tools');
    expect(tools).toContain('48 KiB MCP-result ceiling');
    expect(tools).toContain('collections[field]');
    expect(tools).toContain('"sessions" | "rooms" | "plans" | "deletedSessions" | "unreadRooms"');
    expect(tools).toContain('{field: "plan", id: "pl-01", rev: 0}');
    expect(tools).toContain('stale cursor requires restarting without cursor');
  });
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
    expect(text).toContain('end your turn or `wait_for("inbox", 1500)`');
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
    expect(text).toContain('hand a part of the stuck participant\'s work to a new session there');
    expect(text).toContain('request_agent_switch');
    // Ответ человека обязателен до `create_session`.
    expect(text).toContain('Never start such a session on your own: ask `@human` first and wait for the answer.');
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

  it('темы tools и lifecycle: wait_for отвечает asleep на цель, которую усыпил Parley, — письмо её будит', () => {
    const tools = (guideTopic('tools') ?? '').replace(/\s+/g, ' ');
    expect(tools).toContain(
      'The answer `state: "asleep"` means Parley put the session to sleep: mail wakes it, so write to it or wait for mail via `"inbox"`.',
    );
    const lifecycle = (guideTopic('lifecycle') ?? '').replace(/\s+/g, ' ');
    expect(lifecycle).toContain('A session Parley put to sleep is `sleeping` too: `wait_for` on it answers `asleep`, and mail wakes it.');
  });

  it('тема lifecycle: при closeFinished не ждать «wrap up», report первым, close_session последним (sg-12)', () => {
    const lifecycle = (guideTopic('lifecycle') ?? '').replace(/\s+/g, ' ');
    expect(lifecycle).toContain(
      'If the human lets agents close finished sessions (`get_map` shows `closeFinished: true` in `work`), that is the human\'s explicit consent: do not wait for "wrap up". Close yourself once your part is accepted — by the room lead, or by the session that created you — with `report` first and `close_session` as your last call. A room lead also closes the members of its room whose `result` is `done` once it has accepted their parts, and closes itself after the human accepts the room\'s completion and it has handed in its own report. Sessions the human started directly, without a room or a creator, still wait for "wrap up".',
    );
  });

  it('тема rules: исключение для лида комнаты при closeFinished', () => {
    const rules = (guideTopic('rules') ?? '').replace(/\s+/g, ' ');
    expect(rules).toContain(
      "only after the human's explicit consent. The workspace switch `closeFinished` (topic `lifecycle`) is that consent: then close yourself once your part is accepted.",
    );
    expect(rules).toContain(
      'owning a room gives no right to close them. The one exception: when `get_map` shows `closeFinished` in `work`, the live lead of a room closes its finished members (topic `lifecycle`).',
    );
  });

  it('тема lifecycle: сессия, ждущая слота машины, — queued: стартует сама, wait_for ждёт её как работающую', () => {
    const lifecycle = (guideTopic('lifecycle') ?? '').replace(/\s+/g, ' ');
    expect(lifecycle).toContain('`queued`');
    expect(lifecycle).toContain(
      'A session that waits for a free agent slot on this machine is `queued`: it starts by itself, and `wait_for` waits for it as for a running session.',
    );
    // Предложение про сон осталось на месте, а новое идёт в тот же абзац сразу за ним.
    expect(lifecycle).toContain('and mail wakes it. A session that waits for a free agent slot');
  });

  it('тема tools: wait_for("inbox") отдаёт письма прочитанными, ждать одним вызовом на 1500 с, check_inbox после него не нужен', () => {
    const text = (guideTopic('tools') ?? '').replace(/\s+/g, ' ');

    expect(text).toContain('`wait_for("inbox")` returns the mail itself, already marked read: do not call `check_inbox` after it');
    expect(text).toContain('`check_inbox` is for when you are not waiting');
    expect(text).toContain('Wait with one call `wait_for("inbox", 1500)`, with no text before or after it');
    expect(text).toContain('for `"inbox"` call it once more, then end the turn (without `report`: you are not done)');
    // По id ждут, пока running (как и в вставке): повтор-и-конец — только для «inbox».
    expect(text).toContain('for a session id keep calling while it is `running`');
    // Ждать письма велено с таймаутом, как и везде (L1).
    expect(text).toContain('Wait with `wait_for("inbox", 1500)`: it will wake on the session\'s reply message.');
    expect(text).not.toContain('1800');
  });

  it('тема letters: не подтверждать и не объявлять начало, одно длинное ожидание, на running один повтор', () => {
    const text = (guideTopic('letters') ?? '').replace(/\s+/g, ' ');

    expect(text).toContain('do not acknowledge a message and do not announce that you are starting');
    expect(text).toContain('silence means received');
    // Участник обязан высказаться по задаче человека, а застрявший — назвать блокер: молчание их не запрещено.
    expect(text).toContain('Write only a result, a position, a question, a decision or a blocker.');
    expect(text).toContain('Wait with one call `wait_for("inbox", 1500)`: no text before or after it, no `Monitor`, `sleep` or polling loops');
    expect(text).toContain('On `{"state":"running"}` call it once more, then end the turn without `report` (you are not done)');
    // По id ждут сдавшего только report: письма не будет, будить некому — ждать дальше, пока running.
    expect(text).toContain('A session that only calls `report` sends no message: wait for it by id and call `wait_for` again while it is `running`.');
    expect(text).toContain('wait via `"inbox"`');
  });

  it('тема letters: заметка всем без упоминания приходит пачкой после 30 с тишины, остальное будит сразу', () => {
    const text = (guideTopic('letters') ?? '').replace(/\s+/g, ' ');

    // Что будит сразу: человек, адресное, question/decision, упоминание (обе записи).
    expect(text).toContain(
      'At once: a letter from the human, a letter addressed with `to`, a `question`, a `decision`, and any letter that mentions the colleague (`@s02`; `@s-02` works too).',
    );
    // Что идёт пачкой: простая заметка всем ждёт 30 с тишины (потолок 120 с) и приходит одним указателем.
    expect(text).toContain('a plain broadcast `note` without a mention waits until the room has been quiet for 30 seconds');
    expect(text).toContain('at most 120 seconds after the oldest');
    expect(text).toContain('arrives in one pointer together with the rest');
    // wait_for("inbox") по тому же правилу и на своём таймауте отдаёт накопленные заметки вместо running.
    expect(text).toContain('`wait_for("inbox")` follows the same rule: at its timeout it returns the pending notes instead of `running`');
    // Практический вывод: срочное — адресовать или упомянуть.
    expect(text).toContain(
      'if a colleague must act on your room message now, address it (`to`) or mention them (`@sNN`); a plain broadcast note is read in the next batch.',
    );
    // Правило окна — для оконных сессий; у сессий `parley-core` с `channelPush` каждое письмо объявляется сразу.
    expect(text).toContain('When an idle colleague in a window session is woken.');
    expect(text).toContain('Sessions started by the `parley-core` CLI with `channelPush` have no batch: every letter is announced to them at once.');
    // Голый ярлык без `@` упоминанием не считается.
    expect(text).toContain('A bare label like `S02` without the `@` is not a mention: write `@s02`.');
  });

  it('тема tools: модель выбирают по работе — реализация на стандартном уровне, сильная пишет код по названной причине', () => {
    const text = (guideTopic('tools') ?? '').replace(/\s+/g, ' ');

    expect(text).toContain('Pick the model by the work, not by habit.');
    expect(text).toContain('pass `role: "builtin:executor"` or a standard model (Sonnet, gpt-6.1-sol), one task per session.');
    expect(text).toContain('name the reason in the room before the hand-off.');
    expect(text).toContain("A project's PARLEY.md may change this split.");
  });

  it('тема lead, шаг 5: части реализации — сессиям стандартного уровня, код сильной модели — по названной причине', () => {
    const text = (guideTopic('lead') ?? '').replace(/\s+/g, ' ');

    expect(text).toContain('Implementation parts go to standard-tier sessions (Executor)');
    expect(text).toContain('take code only for a named reason (topic `tools`, `create_session`).');
  });

  it('тема lead, шаг 5: перед раздачей параллельных частей лид смотрит get_capacity', () => {
    const text = (guideTopic('lead') ?? '').replace(/\s+/g, ' ');

    expect(text).toContain(
      'Before handing out parts to run in parallel, call `get_capacity`: it tells how many sessions can start now and which limit stops the rest.',
    );
  });

  it('тема lead: ждать позиции одним wait_for("inbox", 1500), не писать «plan accepted, handing out»', () => {
    const text = (guideTopic('lead') ?? '').replace(/\s+/g, ' ');

    expect(text).toContain('Wait for them with one `wait_for("inbox", 1500)`, not with a `wait_for` per participant id');
    expect(text).toContain('Do not post "plan accepted, handing out" first: the hand-out message itself is the news.');
    // Развилка (M2): running при уже собранных позициях — предложить решение, а не закончить ход.
    expect(text).toContain(
      'If someone stays silent for long (for example `wait_for("inbox", 1500)` answers `running` while you already hold some positions), do not wait forever or end the turn: propose a decision on the positions you have; it can be replaced by a repeated call.',
    );
  });

  it('тема member: раздачу частей не подтверждать, ждать одним wait_for("inbox", 1500)', () => {
    const text = (guideTopic('member') ?? '').replace(/\s+/g, ' ');

    expect(text).toContain('wait with one `wait_for("inbox", 1500)`');
    expect(text).toContain('Do not acknowledge the lead\'s assignment of parts ("got it", "starting"): the next message to the lead is the result.');
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

  it('«Комнаты» называют ответ на прямое письмо человека: send_message(to: "human") вне комнаты, в комнате — по-прежнему ошибка', () => {
    const rooms = flat('rooms');
    expect(rooms).toContain(
      'The human is not a session: in a room, answer the human without `to` and with `replyTo` (`to: "human"` is an error there). Outside a room, answer a direct letter from the human with `send_message(to: "human")`.',
    );
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

describe('the plans topic: assignments, checkpoints and amendments', () => {
  const plans = (): string => (guideTopic('plans') ?? '').replace(/\s+/g, ' ');

  it('plan_tasks lists your assignments and what each waits for; reading a letter does not finish one', () => {
    expect(plans()).toContain('plan_tasks');
    expect(plans()).toContain('your assignments');
    expect(plans()).toContain('what each one waits for');
    expect(plans()).toContain('Reading a letter does not finish an assignment');
  });

  it('plan_progress saves the latest checkpoint per item and role, before a turn ends without submit or verify, and changes nothing else', () => {
    const text = plans();
    expect(text).toContain('plan_progress(planId, rev, item, done, next, artifacts?, blocker?)');
    expect(text).toContain('latest checkpoint per item and role');
    expect(text).toContain('before ending a turn without plan_submit or plan_verify');
    expect(text).toContain('does not change the status and does not verify');
  });

  it('personal publish_agent_plan steps stay separate from plan checkpoints', () => {
    const text = plans();
    expect(text).toContain('publish_agent_plan is for your personal steps');
    expect(text).toContain('does not replace plan_progress');
  });

  it('an amendment text lists the remaining work and what changes; the human sees unfinished items only', () => {
    const text = plans();
    expect(text).toContain('the decision text lists the remaining work and what changes');
    expect(text).toContain('do not restate completed items');
    expect(text).toContain('the human sees only unfinished items');
  });

  it('a revision conflict sends checklist and verified to plan_tasks and autonomous to get_map', () => {
    expect(plans()).toContain('call plan_tasks and use the current revision; in autonomous, refresh with get_map');
  });
});
