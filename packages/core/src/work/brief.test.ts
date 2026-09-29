import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBrief, writeBrief } from './brief.js';
import { addMessage, addSession } from './map.js';
import { addRoom } from './rooms.js';
import { createWork } from './store.js';
import type { WorkMap } from './types.js';

const AT = '2026-09-02T10:00:00.000Z';

function mapWithSessions(): WorkMap {
  const map: WorkMap = {
    schemaVersion: 2,
    work: {
      id: 'w-0042',
      title: 'Авторизация',
      goal: 'логин по e-mail, сессии, миграции',
      status: 'active',
      createdAt: AT,
      updatedAt: AT,
    },
    sessions: [],
    messages: [],
    rooms: [],
  };
  const plan = addSession(map, { provider: 'claude', label: 'план', task: 'Составить план' }, AT);
  plan.lifecycle = 'sleeping';
  plan.result = 'done';
  plan.summary = 'План готов: 5 шагов, миграции отдельно.';
  plan.summarySource = 'agent';
  plan.artifacts = [{ kind: 'plan', path: '.harnas/works/w-0042/artifacts/plan.md' }];
  addSession(
    map,
    {
      provider: 'codex',
      label: 'бэкенд',
      task: 'Реализовать шаги 1–3 плана',
      parent: 's-01',
      contextFrom: ['s-01'],
    },
    AT,
  );
  return map;
}

describe('бриф сессии', () => {
  it('несёт работу, роль, задачу, контекст и три правила', () => {
    const brief = buildBrief(mapWithSessions(), 's-02');

    // 1 — заголовок и цель работы.
    expect(brief).toContain('w-0042');
    expect(brief).toContain('Авторизация');
    expect(brief).toContain('логин по e-mail, сессии, миграции');
    // 2 — id и роль новой сессии.
    expect(brief).toContain('s-02');
    expect(brief).toContain('бэкенд');
    // 3 — задача.
    expect(brief).toContain('Реализовать шаги 1–3 плана');
    // 4 — резюме и пути артефактов сессий из contextFrom.
    expect(brief).toContain('s-01');
    expect(brief).toContain('План готов: 5 шагов, миграции отдельно.');
    expect(brief).toContain('.harnas/works/w-0042/artifacts/plan.md');
    // 5 — три правила.
    expect(brief).toContain('get_map');
    expect(brief).toContain('send_message');
    expect(brief).toContain('на `note` и `decision` не отвечай');
    expect(brief).toContain('report');
  });

  it('содержимое артефактов в бриф не попадает — только пути', () => {
    const map = mapWithSessions();
    const brief = buildBrief(map, 's-02');
    // Бриф нарочно короткий: план агент прочитает сам, если он ему нужен.
    expect(brief.split('\n').length).toBeLessThan(30);
  });

  it('без contextFrom раздела контекста нет', () => {
    const map = mapWithSessions();
    const brief = buildBrief(map, 's-01');
    expect(brief).not.toContain('Контекст');
    expect(brief).toContain('get_map');
  });

  it('сессия из contextFrom без резюме честно помечается', () => {
    const map = mapWithSessions();
    const plan = map.sessions[0];
    if (plan === undefined) throw new Error('нет сессии');
    plan.summary = null;
    plan.artifacts = [];
    const brief = buildBrief(map, 's-02');
    expect(brief).toContain('резюме: нет');
    expect(brief).not.toContain('Артефакты');
  });

  it('тихий старт: пустая задача не оставляет строку «Задача:», контекст на месте', () => {
    const map = mapWithSessions();
    const backend = map.sessions[1];
    if (backend === undefined) throw new Error('нет сессии');
    backend.task = '';

    const brief = buildBrief(map, 's-02');
    expect(brief).not.toContain('Задача:');
    // Контекст родителя и правила — ради них бриф тихой сессии и собирается.
    expect(brief).toContain('## Контекст');
    expect(brief).toContain('План готов: 5 шагов, миграции отдельно.');
    expect(brief).toContain('report');
  });

  it('пустая цель работы не оставляет пустую строку «Цель:»', () => {
    const map = mapWithSessions();
    map.work.goal = '';
    expect(buildBrief(map, 's-02')).not.toContain('Цель:');
  });

  it('неизвестная сессия — ошибка, а не пустой бриф', () => {
    const map = mapWithSessions();
    expect(() => buildBrief(map, 's-99')).toThrow(/s-99/);
  });

  it('битая ссылка в contextFrom — ошибка', () => {
    const map = mapWithSessions();
    const backend = map.sessions[1];
    if (backend === undefined) throw new Error('нет сессии');
    backend.contextFrom = ['s-77'];
    expect(() => buildBrief(map, 's-02')).toThrow(/s-77/);
  });
});

/** Тред родителя: у s-02 появляется брат-ревью и решение от s-01 (спецификация 5.2). */
function mapWithThread(): WorkMap {
  const map = mapWithSessions();
  addSession(
    map,
    { provider: 'claude', label: 'ревью', task: 'Проверить шаги 1–3', parent: 's-01' },
    AT,
  );
  addMessage(
    map,
    { from: 's-01', to: ['s-02'], text: 'миграции отдельным PR', kind: 'decision' },
    '2026-09-02T12:42:00.000Z',
  );
  addMessage(map, { from: 's-01', to: ['s-02'], text: 'а где миграции?', kind: 'question' }, AT);
  return map;
}

describe('бриф: коллеги и решения треда', () => {
  it('знакомит с участниками треда и помечает родителя', () => {
    const brief = buildBrief(mapWithThread(), 's-02');

    expect(brief).toContain('## Коллеги');
    expect(brief).toContain('- s-01 — план (родитель): done');
    expect(brief).toContain('- s-03 — ревью: pending');
    // Сама сессия себе не коллега.
    expect(brief).not.toContain('- s-02 —');
  });

  it('роль коллеги называется рядом с пометкой родителя', () => {
    const map = mapWithThread();
    const plan = map.sessions[0];
    if (plan === undefined) throw new Error('нет сессии');
    plan.agent = 'planner';

    const brief = buildBrief(map, 's-02');
    expect(brief).toContain('- s-01 — план (родитель, агент planner): done');
    // Без роли скобок не появляется: обычная сессия ничем не помечена.
    expect(brief).toContain('- s-03 — ревью: pending');
  });

  it('несёт решения треда со временем и подписью, заметки и вопросы — нет', () => {
    const brief = buildBrief(mapWithThread(), 's-02');

    expect(brief).toContain('## Решения треда');
    expect(brief).toMatch(/- \d\d:\d\d план: «миграции отдельным PR»/);
    expect(brief).not.toContain('а где миграции?');
  });

  it('одинокая сессия: ни коллег, ни решений — разделов нет', () => {
    const map = mapWithSessions();
    map.sessions = map.sessions.slice(0, 1);
    map.messages = [];

    const brief = buildBrief(map, 's-01');
    expect(brief).not.toContain('## Коллеги');
    expect(brief).not.toContain('## Решения треда');
  });

  it('коллеги есть, решений нет — печатается только раздел коллег', () => {
    const brief = buildBrief(mapWithSessions(), 's-02');

    expect(brief).toContain('## Коллеги');
    expect(brief).not.toContain('## Решения треда');
  });
});

describe('бриф: комнаты', () => {
  it('перечисляет комнаты, где сессия участник, с составом', () => {
    const map = mapWithThread();
    addRoom(map, { title: 'Бэкенд', creator: 's-01', members: ['s-02'] });

    const brief = buildBrief(map, 's-02');
    expect(brief).toContain('## Коллеги');
    expect(brief).toContain('r-01 «Бэкенд»');
    // Создатель комнаты — коллега, себя в составе не повторяем.
    expect(brief).toContain('план');
    expect(brief).not.toMatch(/r-01 «Бэкенд»[^\n]*s-02/);
  });

  it('человек-участник комнаты назван «человек»', () => {
    const map = mapWithSessions();
    addRoom(map, { title: 'Штаб', creator: 'human', members: ['s-01', 's-02'] });

    const brief = buildBrief(map, 's-02');
    expect(brief).toContain('r-01 «Штаб»');
    expect(brief).toContain('человек');
  });

  it('нет ни треда, ни комнат — раздела «Коллеги» нет', () => {
    const map = mapWithSessions();
    map.sessions = map.sessions.slice(0, 1);
    map.messages = [];

    const brief = buildBrief(map, 's-01');
    expect(brief).not.toContain('## Коллеги');
  });

  it('комнат нет, но есть коллега по треду — раздел «Коллеги» есть, комнат в нём нет', () => {
    const brief = buildBrief(mapWithSessions(), 's-02');
    expect(brief).toContain('## Коллеги');
    expect(brief).not.toMatch(/r-\d\d/);
  });
});

describe('бриф: роль в комнате', () => {
  /** Тред с s-01 (план), s-02 (бэкенд), s-03 (ревью); комната создана s-01, ведущий — s-02. */
  function mapWithRoom(lead: string | null = 's-02'): WorkMap {
    const map = mapWithThread();
    addRoom(map, { title: 'Бэкенд', creator: 's-01', members: ['s-02', 's-03'], lead });
    return map;
  }

  it('ведущему: собрать позиции, propose_decision, до принятия не начинать, части — упоминаниями', () => {
    const brief = buildBrief(mapWithRoom(), 's-02');

    expect(brief).toContain('## Роль в комнате');
    expect(brief).toContain('- r-01 «Бэкенд»: ты ведущий.');
    expect(brief).toMatch(
      /собери позиции участников \(каждый отвечает в комнате одним сообщением\)/,
    );
    expect(brief).toContain('`propose_decision`');
    expect(brief).toContain('до принятия работу не начинай');
    expect(brief).toMatch(
      /Принято — раздай части упоминаниями[^\n]*возврат — переделай и предложи снова/,
    );
    // Про ведущего другого в его брифе речи нет.
    expect(brief).not.toContain('ведущий —');
  });

  it('участнику: высказаться одним сообщением, ждать свою часть, отчитаться ведущему; ведущий назван', () => {
    const brief = buildBrief(mapWithRoom(), 's-03');

    expect(brief).toContain('## Роль в комнате');
    expect(brief).toContain('- r-01 «Бэкенд»: ведущий — s-02 (бэкенд).');
    expect(brief).toMatch(/выскажись одним сообщением в комнату/);
    expect(brief).toContain('работу не начинай, пока ведущий не назвал твою часть');
    // Свой токен упоминания — по нему участник узнаёт свою часть.
    expect(brief).toContain('твоё — `@s03`');
    expect(brief).toMatch(/отчитайся в комнате ведущему/);
    expect(brief).not.toContain('ты ведущий');
  });

  it('ведущему: пока решение ждёт, новое сообщение человека всем цикл не перезапускает', () => {
    const brief = buildBrief(mapWithRoom(), 's-02');

    // Спека 2.4: пока решение ждёт, новое письмо человека всем — не новая задача. Клауза стоит в той же
    // строке роли, между «до принятия не начинай» и раздачей частей: раздел не вырос лишней строкой.
    const line = brief
      .split('\n')
      .find((candidate) => candidate.startsWith('- r-01 «Бэкенд»: ты ведущий.'));
    expect(line).toMatch(
      /до принятия работу не начинай\. Пока решение ждёт \(у комнаты в `get_map` `proposal` не `null`\), новое сообщение человека всем — не новая задача: позиции заново не собирай\.[^\n]* Принято — раздай части/,
    );
  });

  it('ведущему: такое сообщение — поправка к ждущему решению; меняет суть — повторный propose_decision, иначе ничего', () => {
    const brief = buildBrief(mapWithRoom(), 's-02');

    // Решение контролёра: письмо человека всем при ждущем решении — поправка к нему, а не новая задача.
    // Клауза стоит в той же строке роли сразу за «позиции заново не собирай» и перед раздачей частей.
    const line = brief
      .split('\n')
      .find((candidate) => candidate.startsWith('- r-01 «Бэкенд»: ты ведущий.'));
    expect(line).toMatch(
      /позиции заново не собирай\. Такое сообщение — поправка к ждущему решению: если оно меняет суть, учти его и замени текст повторным `propose_decision`, иначе ничего не делай\. Принято — раздай части/,
    );
  });

  it('участнику: пока решение ждёт, новое сообщение человека всем — позиции заново не писать', () => {
    const brief = buildBrief(mapWithRoom(), 's-03');

    const line = brief
      .split('\n')
      .find((candidate) => candidate.startsWith('- r-01 «Бэкенд»: ведущий —'));
    expect(line).toMatch(
      /Пока решение ждёт \(у комнаты в `get_map` `proposal` не `null`\), новое сообщение человека всем — не новая задача: позиции заново не пиши\./,
    );
  });

  it('участнику: задача человека требует ответа, даже если письмо — note', () => {
    const brief = buildBrief(mapWithRoom(), 's-03');

    // Правило брифа «на `note` не отвечай» — про реплики коллег; задачу человека оно не отменяет.
    expect(brief).toContain('на `note` и `decision` не отвечай');
    expect(brief).toMatch(
      /выскажись одним сообщением в комнату \(отвечай, даже если его письмо — `note`\)/,
    );
  });

  it('создатель-сессия, не назначенный ведущим, — тоже участник', () => {
    const brief = buildBrief(mapWithRoom(), 's-01');

    expect(brief).toContain('- r-01 «Бэкенд»: ведущий — s-02 (бэкенд).');
    expect(brief).not.toContain('ты ведущий');
  });

  it('карта до 2026-09-29 (lead: null): ведущий — первый из участников', () => {
    const map = mapWithRoom(null);

    expect(buildBrief(map, 's-02')).toContain('- r-01 «Бэкенд»: ты ведущий.');
    expect(buildBrief(map, 's-03')).toContain('ведущий — s-02 (бэкенд)');
  });

  it('назначенный ведущий закрыт — ведёт первый живой участник, в брифе он и назван', () => {
    const map = mapWithRoom('s-02');
    const closed = map.sessions.find((candidate) => candidate.id === 's-02');
    if (closed === undefined) throw new Error('нет s-02');
    closed.lifecycle = 'closed';

    // Сам он — «ты ведущий», остальным его называет бриф.
    expect(buildBrief(map, 's-03')).toContain('- r-01 «Бэкенд»: ты ведущий.');
    expect(buildBrief(map, 's-01')).toContain('- r-01 «Бэкенд»: ведущий — s-03 (ревью).');
  });

  it('роль отсылает к разделу «Комнаты» гида один раз, сколько бы комнат ни было', () => {
    const map = mapWithRoom();
    addRoom(map, { title: 'Ревью', creator: 'human', members: ['s-02', 's-03'], lead: 's-03' });

    const brief = buildBrief(map, 's-02');
    expect(brief.match(/раздел «Комнаты»/g)).toHaveLength(1);
    expect(brief).toContain('- r-01 «Бэкенд»: ты ведущий.');
    expect(brief).toContain('- r-02 «Ревью»: ведущий — s-03 (ревью).');
  });

  it('без комнат раздела роли нет, бриф остался коротким', () => {
    const brief = buildBrief(mapWithThread(), 's-02');

    expect(brief).not.toContain('## Роль в комнате');
    expect(brief).not.toContain('propose_decision');
    expect(brief.split('\n').length).toBeLessThan(40);
  });

  it('состав комнаты в «Коллегах» на месте, роль идёт следом', () => {
    const brief = buildBrief(mapWithRoom(), 's-03');

    expect(brief).toContain('- r-01 «Бэкенд»: план, бэкенд');
    expect(brief.indexOf('## Коллеги')).toBeLessThan(brief.indexOf('## Роль в комнате'));
    expect(brief.indexOf('## Роль в комнате')).toBeLessThan(brief.indexOf('## Правила'));
  });
});

describe('бриф сессии: worktree', () => {
  it('сессия со своим worktree: бриф называет ветку, базу, путь и отсылает к read_guide', () => {
    const map = mapWithSessions();
    const session = map.sessions.find((candidate) => candidate.id === 's-02');
    if (session === undefined) throw new Error('нет s-02');
    session.worktree = {
      path: '/tmp/worktrees/proj-a1b2c3/w-0042-s-02',
      branch: 'harnas/w-0042/s-02',
      base: 'master',
      createdAt: null,
    };

    const brief = buildBrief(map, 's-02');
    expect(brief).toContain('Worktree: ветка `harnas/w-0042/s-02` от базы `master`, папка `/tmp/worktrees/proj-a1b2c3/w-0042-s-02`.');
    expect(brief).toContain('Правила работы в worktree — в `read_guide`, раздел «Окно человека».');
    // Строка стоит в разделе своей сессии, до контекста и правил.
    expect(brief.indexOf('Worktree:')).toBeLessThan(brief.indexOf('## Контекст'));
  });

  it('сессия без worktree: бриф о worktree молчит', () => {
    const brief = buildBrief(mapWithSessions(), 's-02');
    expect(brief).not.toContain('Worktree');
    expect(brief).not.toContain('Окно человека');
  });
});

describe('writeBrief', () => {
  let home = '';
  let project = '';

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
    project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
    process.env.HARNAS_HOME = home;
  });

  afterEach(async () => {
    delete process.env.HARNAS_HOME;
    await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('сохраняет бриф в briefs/<session-id>.md', async () => {
    const map = await createWork(project, { title: 'Авторизация', goal: 'логин' });
    addSession(map, { provider: 'claude', label: 'план', task: 'Составить план' }, AT);

    const file = await writeBrief(project, map, 's-01');
    expect(file).toBe(path.join(project, '.harnas', 'works', 'w-0001', 'briefs', 's-01.md'));
    expect(await readFile(file, 'utf8')).toBe(buildBrief(map, 's-01'));
  });
});
