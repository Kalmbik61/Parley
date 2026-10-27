import { describe, expect, it } from 'vitest';
import { addMessage, addSession, removeSession } from './map.js';
import { recipientsOf } from './letters.js';
import { addRoom, archiveRoom, canReadRoom } from './rooms.js';
import { agentDecisions, agentLetterVisible, agentThreadOf, decisionsOf, participantLabel, recentDecisions, sessionTag, threadMembersOf, threadOf } from './thread.js';
import { HUMAN, type Message, type MessageKind, type WorkMap } from './types.js';
import { mapLetterTx } from './letter-store.js';
const lt = (map: Parameters<typeof mapLetterTx>[0]) => mapLetterTx(map).letters;

const emptyMap = (): WorkMap => ({
  schemaVersion: 2,
  work: {
    id: 'w-0001',
    title: 'Авторизация',
    goal: 'цель',
    status: 'active',
    createdAt: '2026-09-08T09:00:00.000Z',
    updatedAt: '2026-09-08T09:00:00.000Z',
  },
  sessions: [],
  messages: [],
  rooms: [],
});

const at = (clock: string): string => `2026-09-08T${clock}:00.000Z`;

const letter = (
  map: WorkMap,
  from: string,
  to: string,
  clock: string,
  kind: MessageKind,
): Message => addMessage(map, { from, to: [to], text: `${from} → ${to}`, kind }, at(clock));

const ids = (messages: readonly Message[]): string[] => messages.map((message) => message.id);

/** Две группы в одной работе: `s-01 → (s-02 → s-03, s-04)` и `s-05 → s-06`. */
const forest = (): WorkMap => {
  const map = emptyMap();
  addSession(map, { provider: 'claude', label: 'план', task: 't' });
  addSession(map, { provider: 'claude', label: 'бэкенд', task: 't', parent: null }).parent = 's-01';
  addSession(map, { provider: 'claude', label: 'тесты', task: 't', parent: null }).parent = 's-02';
  addSession(map, { provider: 'claude', label: 'ревью', task: 't', parent: null }).parent = 's-01';
  addSession(map, { provider: 'claude', label: 'релиз', task: 't' });
  addSession(map, { provider: 'claude', label: 'доки', task: 't', parent: null }).parent = 's-05';
  letter(map, 's-01', 's-02', '10:00', 'note');
  letter(map, 's-02', 's-01', '10:05', 'question');
  letter(map, 's-03', 's-04', '10:10', 'decision');
  letter(map, 's-05', 's-06', '10:15', 'note');
  letter(map, 's-02', 's-06', '10:20', 'note');
  return map;
};

describe('threadOf', () => {
  it('у сессии с родителем — поддерево родителя: родитель, братья, она, потомки', () => {
    const thread = threadOf(forest(), 's-02');

    expect(thread.owner).toBe('s-01');
    expect([...thread.members].sort()).toEqual(['s-01', 's-02', 's-03', 's-04']);
    expect(ids(thread.messages)).toEqual(['m-01', 'm-02', 'm-03']);
  });

  it('корень с детьми — собственное поддерево, письма чужого корня не попадают', () => {
    const thread = threadOf(forest(), 's-01');

    expect(thread.owner).toBe('s-01');
    expect([...thread.members].sort()).toEqual(['s-01', 's-02', 's-03', 's-04']);
    expect(ids(thread.messages)).toEqual(['m-01', 'm-02', 'm-03']);
  });

  it('одинокий корень — вся работа: owner null, все сессии, все письма', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'план', task: 't' });
    addSession(map, { provider: 'codex', label: 'ревью', task: 't' });
    letter(map, 's-01', 's-02', '10:00', 'note');
    letter(map, 's-02', 's-01', '10:05', 'decision');

    const thread = threadOf(map, 's-01');

    expect(thread.owner).toBeNull();
    expect(thread.members).toEqual(['s-01', 's-02']);
    expect(ids(thread.messages)).toEqual(['m-01', 'm-02']);
  });

  it('письмо между двумя поддеревьями не попадает ни в один тред', () => {
    const map = forest();

    expect(ids(threadOf(map, 's-02').messages)).not.toContain('m-05');
    expect(ids(threadOf(map, 's-06').messages)).toEqual(['m-04']);
  });

  it('удалённая сессия не участник, её письма остаются', () => {
    const map = forest();
    removeSession(map, lt(map), 's-03');

    const thread = threadOf(map, 's-02');

    expect(thread.members).not.toContain('s-03');
    expect([...thread.members].sort()).toEqual(['s-01', 's-02', 's-04']);
    expect(ids(thread.messages)).toEqual(['m-01', 'm-02', 'm-03']);
  });
});

describe('decisionsOf', () => {
  it('только kind decision, по времени at', () => {
    const map = forest();
    letter(map, 's-01', 's-04', '09:50', 'decision');

    expect(ids(decisionsOf(threadOf(map, 's-01')))).toEqual(['m-06', 'm-03']);
  });
});

describe('participantLabel', () => {
  it('живая — ярлык, удалённая — «s-03 (удалена)», чужой id — как есть', () => {
    const map = forest();

    expect(participantLabel(map, 's-01')).toBe('план');
    removeSession(map, lt(map), 's-03');
    // Ярлыка удалённой в карте не остаётся — только id в `deletedSessions`.
    expect(participantLabel(map, 's-03')).toBe('s-03 (deleted)');
    expect(participantLabel(map, 's-99')).toBe('s-99');
  });
});

describe('sessionTag', () => {
  it.each([
    ['s-01', 'S01'],
    ['s-12', 'S12'],
    ['s-1', 'S1'],
    ['S01', 'S01'],
    ['s01', 's01'],
    ['session-1', 'session-1'],
    ['w-0010', 'w-0010'],
    ['s-', 's-'],
    ['', ''],
  ])('%s → %s', (id, expected) => {
    expect(sessionTag(id)).toBe(expected);
  });
});

describe('recentDecisions', () => {
  it('последние решения по порядку и общее число; заметки и вопросы не в счёте', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'план', task: 't' });
    for (const [clock, kind] of [['10:00', 'decision'], ['10:01', 'note'], ['10:02', 'decision'], ['10:03', 'question'], ['10:04', 'decision']] as const) {
      addMessage(map, { from: 'human', to: ['s-01'], text: clock, kind }, at(clock));
    }
    const thread = threadOf(map, 's-01');
    const { shown, total } = recentDecisions(thread, 2);
    expect(total).toBe(3);
    expect(shown.map((message) => message.text)).toEqual(['10:02', '10:04']);
    expect(recentDecisions(thread, 10).shown).toEqual(decisionsOf(thread));
  });
});

describe('agentThreadOf', () => {
  it('preserves historical family mail and the human workspace thread', () => {
    const map = forest();
    expect(ids(agentThreadOf(map, 's-01').messages)).toEqual(ids(threadOf(map, 's-01').messages));
    addSession(map, { provider: 'claude', label: 'owner', task: 'coordinate' });
    expect(threadOf(map, 's-07').messages).toHaveLength(5);
    expect(agentThreadOf(map, 's-07').messages).toEqual([]);
    const own = letter(map, 's-02', 's-07', '10:25', 'note');
    expect(ids(agentThreadOf(map, 's-07').messages)).toEqual([own.id]);
  });
});

describe('agentLetterVisible', () => {
  /**
   * Лес из `forest()` плюс одинокий корень s-07, удалённая s-03 и комнаты: r-01 (участники s-02 и s-05, хозяин s-04),
   * r-02 (архивная, участник s-01) и письма комнаты, которой нет. Прямые письма: внутри семьи, между семьями, человеку,
   * от человека, от удалённой и к одинокому корню.
   */
  const crowded = (): WorkMap => {
    const map = forest();
    addSession(map, { provider: 'claude', label: 'одинокий', task: 't' });
    addRoom(map, { title: 'общая', creator: HUMAN, ownerId: 's-04', members: ['s-02', 's-05'] }, at('11:00'));
    addRoom(map, { title: 'старая', creator: HUMAN, members: ['s-01'] }, at('11:01'));
    addMessage(map, { from: 's-02', to: [], text: 'всем', kind: 'note', roomId: 'r-01' }, at('11:05'));
    addMessage(map, { from: 's-05', to: ['s-02'], text: 'адресно', kind: 'question', roomId: 'r-01' }, at('11:06'));
    addMessage(map, { from: 's-01', to: [], text: 'в старую', kind: 'note', roomId: 'r-02' }, at('11:07'));
    addMessage(map, { from: 's-06', to: [], text: 'в никуда', kind: 'note', roomId: 'r-09' }, at('11:08'));
    addMessage(map, { from: HUMAN, to: ['s-04'], text: 'человек → s-04', kind: 'note' }, at('11:09'));
    addMessage(map, { from: 's-04', to: [HUMAN], text: 's-04 → человеку', kind: 'question' }, at('11:10'));
    addMessage(map, { from: 's-03', to: ['s-04'], text: 'от удалённой', kind: 'note' }, at('11:11'));
    addMessage(map, { from: 's-06', to: ['s-07'], text: 'одинокому корню', kind: 'note' }, at('11:12'));
    addMessage(map, { from: 's-07', to: ['s-01'], text: 'от одинокого', kind: 'decision' }, at('11:13'));
    archiveRoom(map, lt(map), 'r-02', at('11:20'));
    removeSession(map, lt(map), 's-03');
    return map;
  };

  /**
   * Образец — `agentThreadOf` в прежнем виде, до предиката на одно письмо: тред семьи по поддереву владельца, письма
   * комнат читателю комнаты, прямые — своим и историческим. Копия логики, а не вызов: предикат и `agentThreadOf` теперь
   * делят код, и сверять их друг с другом значило бы сверять код с самим собой.
   */
  const referenceVisible = (map: WorkMap, caller: string): Set<string> => {
    const session = map.sessions.find((candidate) => candidate.id === caller);
    if (session === undefined) throw new Error(`session ${caller} is not in the map`);
    const childrenOf = (id: string) => map.sessions.filter((candidate) => candidate.parent === id);
    const owner = session.parent !== null ? session.parent : childrenOf(caller).length > 0 ? caller : null;
    let historical = new Set<string>();
    if (owner !== null) {
      const members: string[] = [];
      const queue = [owner];
      while (queue.length > 0) {
        const id = queue.shift() as string;
        members.push(id);
        for (const child of childrenOf(id)) queue.push(child.id);
      }
      const inside = new Set(members);
      const gone = new Set(map.work.deletedSessions ?? []);
      const here = (id: string): boolean => inside.has(id) || gone.has(id);
      historical = new Set(
        map.messages
          .filter((message) => {
            const to = recipientsOf(message, map);
            return here(message.from) && to.every(here) && (inside.has(message.from) || to.some((id) => inside.has(id)));
          })
          .map((message) => message.id),
      );
    }
    return new Set(
      map.messages
        .filter((message) => {
          if (message.roomId !== null) {
            const room = map.rooms.find((candidate) => candidate.id === message.roomId);
            return room !== undefined && canReadRoom(room, caller);
          }
          return historical.has(message.id) || message.from === caller || message.to.includes(caller);
        })
        .map((message) => message.id),
    );
  };

  it('на каждом письме и у каждой сессии отвечает так же, как прежний agentThreadOf', () => {
    const map = crowded();
    const seen = new Set<boolean>();
    const verdicts = new Set<string>();

    for (const session of map.sessions) {
      const visible = agentLetterVisible(map, session.id);
      const reference = referenceVisible(map, session.id);
      const answers: boolean[] = [];
      for (const message of map.messages) {
        expect(visible(message), `${session.id} видит ${message.id}`).toBe(reference.has(message.id));
        seen.add(visible(message));
        answers.push(visible(message));
      }
      expect(new Set(ids(agentThreadOf(map, session.id).messages))).toEqual(reference);
      verdicts.add(answers.join());
    }

    // Фикстура различает сессии и даёт оба ответа: иначе совпадение ничего бы не доказывало.
    expect(seen).toEqual(new Set([true, false]));
    expect(verdicts.size).toBeGreaterThan(3);
  });

  it('неизвестная сессия — та же ошибка, что у agentThreadOf', () => {
    const map = crowded();

    expect(() => agentLetterVisible(map, 's-99')).toThrow(/s-99/);
    expect(() => agentThreadOf(map, 's-99')).toThrow(/s-99/);
  });

  it('agentDecisions берёт решения запросом и совпадает с решениями треда', () => {
    const map = crowded();
    const letters = lt(map);

    for (const session of map.sessions) {
      expect(ids(agentDecisions(map, letters, session.id))).toEqual(ids(decisionsOf(agentThreadOf(map, session.id))));
    }
    expect(threadMembersOf(map, 's-02')).toEqual(threadOf(map, 's-02').members);
  });
});
