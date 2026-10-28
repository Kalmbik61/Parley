import { describe, expect, it } from 'vitest';
import {
  addMessage,
  addSession,
  canTransition,
  normalizeLegacyMap,
  normalizeMap,
  parseMap,
  parseMapText,
  removeSession,
  setResult,
  transitionSession,
} from './map.js';
import { defaultSessionName, NEW_LABEL } from './names.js';
import { roomLead } from './rooms.js';
import { memberState, swarmProgress, type WorkSwarm } from './swarms.js';
import { HUMAN, type Room, type SessionLifecycle, type WindowWorkMap, type WorkMap } from './types.js';
import { mapLetterTx } from './letter-store.js';
const lt = (map: Parameters<typeof mapLetterTx>[0]) => mapLetterTx(map).letters;

const emptyMap = (): WindowWorkMap => ({
  schemaVersion: 2,
  work: {
    id: 'w-0001',
    title: 'Авторизация',
    goal: 'цель',
    status: 'active',
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
  },
  sessions: [],
  messages: [],
  rooms: [],
});

/** Пустая карта v1 — как её писали до комнат. */
const emptyV1 = (): Record<string, unknown> => {
  const map: Record<string, unknown> = { ...emptyMap(), schemaVersion: 1 };
  delete map['rooms'];
  return map;
};

describe('private Codex thread binding normalization', () => {
  const proof = {
    launchRevision: '12345678-1234-1234-1234-123456789abc', pid: 42,
    startedAtProcess: '  exact process stamp  ', threadId: '019ce3d5-584a-7be2-922e-b8185a8d7c19' as string | null,
  };
  const normalize = (binding: unknown, provider = 'codex') => {
    const map = emptyMap();
    const session = addSession(map, { provider, label: '', task: '' });
    Object.assign(session, { codexThreadBinding: binding });
    return parseMap(JSON.stringify(map), 'map.json');
  };

  it('preserves exact valid proof and unverified launch identity without a schema bump', () => {
    for (const threadId of [null, proof.threadId]) {
      const map = normalize({ ...proof, threadId });
      expect(map.schemaVersion).toBe(2);
      expect(map.sessions[0]?.codexThreadBinding).toEqual({ ...proof, threadId });
      expect(parseMap(JSON.stringify(map), 'again.json')).toEqual(map);
    }
  });

  it.each([
    null, [], {}, { ...proof, extra: true }, { pid: 42, startedAtProcess: 'x', threadId: null },
    { ...proof, launchRevision: 'bad' }, { ...proof, launchRevision: proof.launchRevision.toUpperCase() },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY].map((pid) => ({ ...proof, pid })),
    ...['', 'x'.repeat(65), 'stamp\n', 'stamp\u0000', 'stamp\u007f', 'stamp\u0085'].map((startedAtProcess) => ({ ...proof, startedAtProcess })),
    { ...proof, threadId: 'bad' }, { ...proof, threadId: proof.threadId?.toUpperCase() },
  ])('drops malformed proof without rejecting the session: %j', (binding) => {
    const session = normalize(binding).sessions[0];
    expect(session?.provider).toBe('codex');
    expect(session).not.toHaveProperty('codexThreadBinding');
  });

  it('does not synthesize legacy trust or retain proof on a non-Codex session', () => {
    const map = emptyMap();
    addSession(map, { provider: 'codex', label: '', task: '' });
    expect(parseMap(JSON.stringify(map), 'legacy.json').sessions[0]).not.toHaveProperty('codexThreadBinding');
    expect(normalize(proof, 'claude').sessions[0]).not.toHaveProperty('codexThreadBinding');
    expect(normalize(proof, 'glm').sessions[0]).not.toHaveProperty('codexThreadBinding');
  });

  it('bounds process stamps in UTF-16 code units and accepts the safe positive PID boundary', () => {
    const boundary = { ...proof, pid: Number.MAX_SAFE_INTEGER, startedAtProcess: '🔒'.repeat(32) };
    expect(normalize(boundary).sessions[0]?.codexThreadBinding).toEqual(boundary);
    expect(normalize({ ...boundary, startedAtProcess: '🔒'.repeat(33) }).sessions[0]).not.toHaveProperty('codexThreadBinding');
  });
});

describe('addSession', () => {
  it('роль агента берётся из init, без неё — null', () => {
    const map = emptyMap();
    const plain = addSession(map, { provider: 'claude', label: 'план', task: 'план' });
    const roled = addSession(map, {
      provider: 'claude',
      label: 'ревью',
      task: 'проверить',
      agent: 'reviewer',
    });

    expect(plain.role).toBeNull();
    expect(Object.hasOwn(plain, 'agent')).toBe(false);
    expect(roled.role).toEqual({ source: 'claude', name: 'reviewer' });
    expect(Object.hasOwn(roled, 'agent')).toBe(false);
  });

  it('модель и усилие запуска (spawn_session) пишутся, когда заданы; без них ключей в записи нет', () => {
    const map = emptyMap();
    const plain = addSession(map, { provider: 'claude', label: 'план', task: 'план' });
    const chosen = addSession(map, {
      provider: 'claude',
      label: 'ревью',
      task: 'проверить',
      model: 'opus',
      effort: 'high',
    });

    expect('model' in plain).toBe(false);
    expect('effort' in plain).toBe(false);
    expect(chosen).toMatchObject({ model: 'opus', effort: 'high' });
    // Через JSON — как на диске: запись с выбором читается парсером карты без правок.
    const again = parseMap(JSON.stringify(map), 'map.json');
    expect(again.sessions[1]).toMatchObject({ model: 'opus', effort: 'high' });
    expect('model' in (again.sessions[0] ?? {})).toBe(false);
  });

  it('lean (облегчённый запуск) пишется, когда задан — и true, и явный false; без него ключа в записи нет', () => {
    const map = emptyMap();
    const plain = addSession(map, { provider: 'claude', label: 'план', task: 'план' });
    const lean = addSession(map, { provider: 'claude', label: 'ревью', task: 'проверить', lean: true });
    const notLean = addSession(map, { provider: 'claude', label: 'тесты', task: 'гонять', lean: false });

    expect('lean' in plain).toBe(false);
    expect(lean.lean).toBe(true);
    expect(notLean.lean).toBe(false);
    // Через JSON — как на диске: решение, принятое при создании, при чтении карты остаётся.
    const again = parseMap(JSON.stringify(map), 'map.json');
    expect('lean' in (again.sessions[0] ?? {})).toBe(false);
    expect(again.sessions[1]?.lean).toBe(true);
    expect(again.sessions[2]?.lean).toBe(false);
  });

  it('нумерует сессии s-NN по порядку и создаёт запись pending', () => {
    const map = emptyMap();
    const first = addSession(map, { provider: 'claude', label: 'план', task: 'составить план' });
    const second = fixtureSession(map, {
      provider: 'codex',
      label: 'бэкенд',
      task: 'шаги 1–3',
      parent: 's-01',
      contextFrom: ['s-01'],
    });

    expect(first.id).toBe('s-01');
    expect(second.id).toBe('s-02');
    expect(first.lifecycle).toBe('pending');
    expect(first.result).toBeNull();
    expect(first.resultAt).toBeNull();
    expect(first.closedAt).toBeNull();
    expect(first.history).toEqual([{ event: 'pending', at: first.history[0]?.at }]);
    expect(first.parent).toBeNull();
    expect(first.contextFrom).toEqual([]);
    expect(second.parent).toBe('s-01');
    expect(second.contextFrom).toEqual(['s-01']);
    expect(first.summary).toBeNull();
    expect(first.summarySource).toBeNull();
    expect(first.metrics).toBeNull();
    // Процесса ещё нет: поля запуска заполняет тот, кто его поднимет.
    expect(first.pid).toBeNull();
    expect(first.startedAtProcess).toBeNull();
    expect(first.launchedBy).toBeNull();
    expect(map.sessions).toHaveLength(2);
  });

  it('нумерация продолжается от максимального id в карте', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: 't' });
    addSession(map, { provider: 'claude', label: 'b', task: 't' });
    map.sessions.splice(0, 1);

    expect(addSession(map, { provider: 'claude', label: 'c', task: 't' }).id).toBe('s-03');
  });

  it('провайдер не ограничен встроенным реестром: providers.json его дополняет', () => {
    const map = emptyMap();

    expect(addSession(map, { provider: 'my-cli', label: 'своя', task: 't' }).provider).toBe(
      'my-cli',
    );
  });

  it('пустой (после обрезки) ярлык и NEW_LABEL — имя по умолчанию по номеру; заданный ярлык остаётся как есть', () => {
    const map = emptyMap();
    const labels = ['', '  \t ', NEW_LABEL, 'бэкенд', ' ревью '].map(
      (label) => addSession(map, { provider: 'claude', label, task: 't' }).label,
    );

    expect(labels).toEqual([
      defaultSessionName('s-01'),
      defaultSessionName('s-02'),
      defaultSessionName('s-03'),
      'бэкенд',
      ' ревью ',
    ]);
    expect(labels[0]).toBe('Ralph');
    // Имена в карте разные: в пределах работы сессии по имени различимы.
    expect(new Set(labels.slice(0, 3)).size).toBe(3);
  });

  it('имя по номеру зависит от id, а не от числа записей: после удаления сессии номер не переиспользуется', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: '', task: 't' });
    const second = addSession(map, { provider: 'claude', label: '', task: 't' });
    removeSession(map, lt(map), second.id);

    const third = addSession(map, { provider: 'claude', label: '', task: 't' });

    expect(third.id).toBe('s-03');
    expect(third.label).toBe(defaultSessionName('s-03'));
    expect(third.label).not.toBe(second.label);
  });

  it('NEW_LABEL на диске не переписывается: карта старой сборки читается как есть', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: '', task: 't' }).label = NEW_LABEL;

    const again = parseMap(JSON.stringify(map), 'map.json');

    expect(again.sessions[0]?.label).toBe(NEW_LABEL);
  });
});

describe('addMessage', () => {
  it('нумерует сообщения m-NN и кладёт их непрочитанными', () => {
    const map = emptyMap();
    const message = addMessage(map, { from: 's-02', to: ['s-01'], text: 'жду миграции' });

    expect(message.id).toBe('m-01');
    expect(message.readBy).toEqual({});
    expect(message.roomId).toBeNull();
    expect(message.to).toEqual(['s-01']);
    expect(addMessage(map, { from: 's-01', to: ['s-02'], text: 'ок' }).id).toBe('m-02');
  });

  it('kind по умолчанию note, явный kind сохраняется', () => {
    const map = emptyMap();
    const plain = addMessage(map, { from: 's-01', to: ['s-02'], text: 'a' });
    const question = addMessage(map, {
      from: 's-01',
      to: ['s-02'],
      text: 'b',
      kind: 'question',
    });

    expect(plain.kind).toBe('note');
    expect(question.kind).toBe('question');
  });

  it('replyTo (Parley 0.3.0) пишется, когда задан; без него ключа в письме нет', () => {
    const map = emptyMap();
    const plain = addMessage(map, { from: 's-01', to: [], text: 'вопрос', roomId: 'r-01' });
    const reply = addMessage(map, {
      from: 's-02',
      to: [],
      text: 'ответ',
      roomId: 'r-01',
      replyTo: plain.id,
    });

    expect('replyTo' in plain).toBe(false);
    expect(reply.replyTo).toBe('m-01');
    // Через JSON — как на диске: `parseMap` поле не теряет, а у обычного письма ключа не появляется.
    const again = parseMap(JSON.stringify(map), 'map.json');
    expect(again.messages[1]?.replyTo).toBe('m-01');
    expect('replyTo' in (again.messages[0] ?? {})).toBe(false);
  });

  it('addMessage переносит via, а без него поля нет', () => {
    const map = emptyMap();
    const withVia = addMessage(map, { from: HUMAN, to: [], text: 'x', roomId: 'r-1', via: 'assistant' });
    const plain = addMessage(map, { from: HUMAN, to: [], text: 'y', roomId: 'r-1' });
    expect(withVia.via).toBe('assistant');
    expect('via' in plain).toBe(false);
  });
});

describe('transitionSession', () => {
  const withLifecycle = (lifecycle: SessionLifecycle): WorkMap => {
    const map = emptyMap();
    const session = addSession(map, { provider: 'claude', label: 'план', task: 't' });
    session.lifecycle = lifecycle;
    return map;
  };

  const LIFECYCLES: readonly SessionLifecycle[] = ['pending', 'active', 'sleeping', 'closed'];
  const ALLOWED = new Set([
    'pending→active',
    'pending→closed',
    'active→sleeping',
    'active→closed',
    'sleeping→active',
    'sleeping→closed',
  ]);
  const pairs = LIFECYCLES.flatMap((from) => LIFECYCLES.map((to) => [from, to] as const));

  it('переходы — инвариантом по всем 16 парам', () => {
    expect(pairs).toHaveLength(16);
    for (const [from, to] of pairs) {
      const map = withLifecycle(from);
      const allowed = ALLOWED.has(`${from}→${to}`);
      expect(canTransition(from, to), `${from} → ${to}`).toBe(allowed);
      if (allowed) {
        const session = transitionSession(map, 's-01', to, { at: '2026-09-02T11:00:00.000Z' });
        expect(session.lifecycle).toBe(to);
        expect(session.history.at(-1)).toEqual({ event: to, at: '2026-09-02T11:00:00.000Z' });
      } else {
        expect(() => transitionSession(map, 's-01', to), `${from} → ${to}`).toThrow(
          /invalid transition/,
        );
        expect(map.sessions[0]?.lifecycle).toBe(from);
        expect(map.sessions[0]?.history).toHaveLength(1);
      }
    }
  });

  it('closed ставит closedAt', () => {
    const map = withLifecycle('sleeping');
    const session = transitionSession(map, 's-01', 'closed', { at: '2026-09-02T11:00:00.000Z' });

    expect(session.closedAt).toBe('2026-09-02T11:00:00.000Z');
  });

  it('итог ставится из любого состояния, кроме closed, и процесс не меняет', () => {
    for (const lifecycle of ['pending', 'active', 'sleeping'] as const) {
      const map = withLifecycle(lifecycle);
      const session = setResult(map, 's-01', 'done', '2026-09-02T11:00:00.000Z');
      expect(session.lifecycle).toBe(lifecycle);
      expect(session.result).toBe('done');
      expect(session.resultAt).toBe('2026-09-02T11:00:00.000Z');
      expect(session.history.at(-1)).toEqual({ event: 'done', at: '2026-09-02T11:00:00.000Z' });
    }

    const closed = withLifecycle('closed');
    expect(() => setResult(closed, 's-01', 'failed')).toThrow(/is closed/);
    expect(closed.sessions[0]?.result).toBeNull();
    expect(closed.sessions[0]?.history).toHaveLength(1);
  });

  it('код выхода пишется в последнюю запись history', () => {
    const map = withLifecycle('active');
    const session = transitionSession(map, 's-01', 'sleeping', {
      at: '2026-09-02T11:00:00.000Z',
      exitCode: 1,
    });

    expect(session.history.at(-1)).toEqual({
      event: 'sleeping',
      at: '2026-09-02T11:00:00.000Z',
      exitCode: 1,
    });
    expect(session.endedAt).toBe('2026-09-02T11:00:00.000Z');
  });

  it('сигнал завершения пишется рядом с кодом выхода', () => {
    const map = withLifecycle('active');
    const session = transitionSession(map, 's-01', 'sleeping', {
      at: '2026-09-02T11:00:00.000Z',
      exitCode: 137,
      signal: 9,
    });

    expect(session.history.at(-1)).toEqual({
      event: 'sleeping',
      at: '2026-09-02T11:00:00.000Z',
      exitCode: 137,
      signal: 9,
    });
  });

  it('startedAt ставится при первом переходе в active, endedAt снимается при возобновлении', () => {
    const map = withLifecycle('pending');
    transitionSession(map, 's-01', 'active', { at: '2026-09-02T11:00:00.000Z' });
    transitionSession(map, 's-01', 'sleeping', { at: '2026-09-02T11:30:00.000Z' });
    const resumed = transitionSession(map, 's-01', 'active', { at: '2026-09-02T12:00:00.000Z' });

    expect(resumed.startedAt).toBe('2026-09-02T11:00:00.000Z');
    expect(resumed.endedAt).toBeNull();
  });

  it('неизвестный id сессии — ошибка', () => {
    expect(() => transitionSession(emptyMap(), 's-99', 'active')).toThrow(/s-99/);
  });
});

describe('parseMap', () => {
  const planMap = (mode: 'verified' | 'autonomous') => ({
    ...emptyMap(),
    swarms: [],
    rooms: [{
      id: 'r-01', title: 'Комната', creator: HUMAN, ownerId: null, members: [],
      lead: null, mode, proposal: null, recipe: null, archivedAt: null,
      createdAt: '2026-10-24T00:00:00.000Z',
    }],
    plans: [{
      id: 'pl-01', roomId: 'r-01', mode, status: 'active', rev: 1,
      goal: 'Прочитать карту', backlog: [],
      items: [{
        id: 1, title: 'Типы', owner: 's-01', scope: 'Ядро', after: [],
        criteria: ['Карта читается'], verifier: HUMAN, status: 'ready',
        evidence: null, note: null, log: [],
      }],
      acceptedAt: '2026-10-24T00:00:00.000Z', completedAt: null, cancelledAt: null,
      completionSummary: null,
    }],
  });
  const autonomousMap = () => {
    const map = planMap('autonomous');
    const at = '2026-10-24T00:00:00.000Z';
    return { ...map, plans: [{ ...map.plans[0]!, autonomous: {
      budget: {
        limits: { attemptsPerItem: 3, repairWaves: 2, minutesPerAttempt: 10, sessions: 5, concurrent: 1 },
        spent: { attempts: 1, repairWaves: 0, sessions: 1, verifiers: 0, minutes: 0, launches: 1 },
        reservations: [{ key: 'op-0001', kind: 'session', attemptId: 'at-0001', at }],
      },
      checks: [{
        id: 'ck-spec-01', item: 1, argv: ['pnpm', 'test'], cwd: '.', env: { CI: '1' },
        inputs: [{ path: 'package.json', blob: 'base-blob' }], timeoutMs: 1000, frozenAt: at,
      }],
      coverage: { 1: { 0: ['ck-spec-01', 'verifier'] } },
      criteriaVersion: { 1: 1 },
      integration: {
        branch: 'integration', baseSha: 'base', verifiedHead: 'base', candidateHead: 'capture',
        queue: ['at-0001'], suspended: { reason: 'Проверка', attemptId: 'at-0001', at },
      },
      attempts: [{
        id: 'at-0001', item: 1, n: 1, planRev: 1, criteriaVersion: 1,
        worker: 's-01', verifier: null, branch: 'attempt', baseSha: 'base', sha: 'capture',
        tree: 'tree', submissionKey: 'submission', status: 'submitted',
        manifest: {
          version: 1, sha: 'capture', criteriaVersion: 1, dependsOn: [], coverage: 'covered',
          scope: 'Ядро', facts: ['Карта читается'], hypotheses: [], notFound: [], gaps: [],
          text: 'Готово', artifacts: [{ path: 'result.txt', sha256: 'hash', storedAs: 'attempts/result.txt' }],
          hash: 'manifest-hash', submittedAt: at,
        },
        receipt: {
          id: 'rc-0001', attemptId: 'at-0001', manifestHash: 'manifest-hash', sha: 'capture',
          criteriaVersion: 1, valid: true, reason: null, at,
        },
        checks: ['ck-0001'], failureSignature: null, startedAt: at, endedAt: null,
        log: [{ at, by: 'engine', status: 'submitted', note: null, op: 'op-0001' }],
      }],
      ops: [{
        key: 'op-0001', kind: 'create-session', attemptId: 'at-0001', payload: { sessionId: 's-01' },
        state: 'intended', at, settledAt: null, result: null,
      }],
      halted: { reason: 'restart', at, detail: 'Хост перезапущен' },
      seq: { attempt: 1, receipt: 1, check: 1, op: 1 },
    } }] };
  };

  it('старый план verified читается без изменений и без поля autonomous', () => {
    const map = planMap('verified');
    const parsed = parseMap(JSON.stringify(map), 'map.json');
    expect(parsed).toEqual(map);
    expect(parsed.plans?.[0]).not.toHaveProperty('autonomous');
  });

  it('читает автономный план с попытками, операциями и резервами без потерь', () => {
    const map = autonomousMap();
    const parsed = parseMap(JSON.stringify(map), 'map.json');
    expect(parsed).toEqual(map);
    expect(parsed.plans?.[0]?.autonomous?.coverage[1]?.[0]).toEqual(['ck-spec-01', 'verifier']);
    expect(parsed.plans?.[0]?.autonomous?.criteriaVersion[1]).toBe(1);
  });

  it('допускает пустую карту текущих версий критериев', () => {
    const map = autonomousMap();
    Object.assign(map.plans[0]!.autonomous, { criteriaVersion: {} });
    expect(parseMap(JSON.stringify(map), 'map.json')).toEqual(map);
  });

  it.each([
    { '01': { '0': ['ck-spec-01'] } },
    { '1': { '00': ['ck-spec-01'] } },
    { '1': { '0': ['ck-spec-01'] }, '01': { '0': ['verifier'] } },
    { '1': { '0': ['ck-spec-01'], '00': ['verifier'] } },
    { '0': { '0': ['ck-spec-01'] } },
  ])('отклоняет неканонические ключи coverage без нормализации: %j', (coverage) => {
    const map = autonomousMap();
    map.plans[0]!.autonomous.coverage = coverage as typeof map.plans[0]['autonomous']['coverage'];
    expect(() => parseMap(JSON.stringify(map), 'map.json')).toThrow(/invalid autonomous plan/);
  });

  it('отклоняет автономный план без поля autonomous', () => {
    expect(() => parseMap(JSON.stringify(planMap('autonomous')), 'map.json')).toThrow(/invalid autonomous plan/);
  });

  it('отклоняет поле autonomous у плана verified', () => {
    const map = autonomousMap();
    map.plans[0]!.mode = 'verified';
    map.rooms[0]!.mode = 'verified';
    expect(() => parseMap(JSON.stringify(map), 'map.json')).toThrow(/invalid autonomous plan/);
  });

  it('подставляет только безопасные пустые поля автономного плана', () => {
    const map = autonomousMap();
    const autonomous = map.plans[0]!.autonomous;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- ключ вырезается из копии через rest
    const { attempts, ops, halted, seq, budget, ...required } = autonomous;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- ключ вырезается из копии через rest
    const { reservations, ...requiredBudget } = budget;
    map.plans[0]!.autonomous = { ...required, budget: requiredBudget } as typeof autonomous;
    const parsed = parseMap(JSON.stringify(map), 'map.json').plans?.[0]?.autonomous;
    expect(parsed).toEqual({
      ...required, budget: { ...requiredBudget, reservations: [] },
      attempts: [], ops: [], halted: null, seq: { attempt: 0, receipt: 0, check: 0, op: 0 },
    });
    expect(parseMap(JSON.stringify(parseMap(JSON.stringify(map), 'map.json')), 'map.json').plans?.[0]?.autonomous).toEqual(parsed);
  });

  it('сохраняет null в необязательных записях автономного плана', () => {
    const map = autonomousMap();
    const autonomous = map.plans[0]!.autonomous;
    Object.assign(autonomous.attempts[0]!, {
      worker: null, sha: null, tree: null, submissionKey: null, manifest: null, receipt: null,
    });
    Object.assign(autonomous.integration, { candidateHead: null, suspended: null });
    Object.assign(autonomous.ops[0]!, { attemptId: null, settledAt: '2026-10-24T00:01:00.000Z', result: {} });
    Object.assign(autonomous, { halted: null });
    expect(parseMap(JSON.stringify(map), 'map.json')).toEqual(map);
  });

  it('сохраняет null вместо SHA в манифесте до захвата', () => {
    const map = autonomousMap();
    Object.assign(map.plans[0]!.autonomous.attempts[0]!.manifest, { sha: null });
    expect(parseMap(JSON.stringify(map), 'map.json')).toEqual(map);
  });

  it('отклоняет попытку с неизвестным статусом', () => {
    const map = autonomousMap();
    map.plans[0]!.autonomous.attempts[0]!.status = 'unknown';
    expect(() => parseMap(JSON.stringify(map), 'map.json')).toThrow(/invalid autonomous plan/);
  });

  it.each(['kind', 'state'] as const)('отклоняет операцию с неизвестным %s', (field) => {
    const map = autonomousMap();
    map.plans[0]!.autonomous.ops[0]![field] = 'unknown';
    expect(() => parseMap(JSON.stringify(map), 'map.json')).toThrow(/invalid autonomous plan/);
  });

  it.each([
    ['budget.limits', undefined],
    ['budget.spent', undefined],
    ['checks', undefined],
    ['coverage', undefined],
    ['criteriaVersion', undefined],
    ['criteriaVersion', null],
    ['criteriaVersion', []],
    ['criteriaVersion.01', 1],
    ['criteriaVersion.0', 1],
    ['criteriaVersion.9007199254740992', 1],
    ['criteriaVersion.1', 0],
    ['criteriaVersion.1', 1.5],
    ['criteriaVersion.1', Number.MAX_SAFE_INTEGER + 1],
    ['criteriaVersion.1', '1'],
    ['integration', undefined],
    ['budget', null],
    ['budget.limits.sessions', 1.5],
    ['budget.spent.minutes', Number.MAX_SAFE_INTEGER + 1],
    ['budget.reservations', null],
    ['budget.reservations.0.kind', 'unknown'],
    ['budget.reservations.0.attemptId', 1],
    ['checks', null],
    ['checks.0.argv', ['pnpm', 1]],
    ['checks.0.env.CI', true],
    ['checks.0.inputs.0.blob', null],
    ['checks.0.timeoutMs', 0.5],
    ['coverage.1.0', [1]],
    ['coverage.unknown', {}],
    ['integration.verifiedHead', 1],
    ['integration.branch', ''],
    ['integration.baseSha', ''],
    ['integration.verifiedHead', ''],
    ['integration.candidateHead', ''],
    ['integration.queue', [null]],
    ['integration.suspended.at', false],
    ['attempts', null],
    ['attempts.0', null],
    ['attempts.0.planRev', Number.MAX_SAFE_INTEGER + 1],
    ['attempts.0.worker', 1],
    ['attempts.0.sha', 1],
    ['attempts.0.branch', ''],
    ['attempts.0.baseSha', ''],
    ['attempts.0.sha', ''],
    ['attempts.0.tree', ''],
    ['attempts.0.receipt.sha', ''],
    ['attempts.0.receipt.manifestHash', ''],
    ['attempts.0.manifest.sha', ''],
    ['attempts.0.manifest.artifacts.0.sha256', ''],
    ['attempts.0.manifest.version', 2],
    ['attempts.0.manifest.coverage', 'unknown'],
    ['attempts.0.manifest.artifacts.0.sha256', 1],
    ['attempts.0.receipt.valid', 'yes'],
    ['attempts.0.checks', [1]],
    ['attempts.0.log.0.status', 'unknown'],
    ['ops', null],
    ['ops.0', null],
    ['ops.0.payload', []],
    ['ops.0.result', 1],
    ['halted.reason', 'unknown'],
    ['seq.attempt', -1],
    ['seq.op', 0.5],
  ])('отклоняет битое поле автономного плана %s', (path, value) => {
    const map = autonomousMap();
    const keys = (path as string).split('.');
    let record = map.plans[0]!.autonomous as unknown as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) record = record[key] as Record<string, unknown>;
    record[keys.at(-1)!] = value;
    expect(() => parseMap(JSON.stringify(map), 'map.json')).toThrow(/invalid autonomous plan/);
  });

  it('читает карту нужной формы', () => {
    const map = emptyMap();
    expect(parseMap(JSON.stringify(map), 'map.json')).toEqual({ ...map, plans: [], swarms: [] });
  });

  it('карта v1 поднимается до v2 поле в поле (три сессии и пять писем, как в w-0010)', () => {
    const v1 = {
      ...emptyV1(),
      work: { ...emptyMap().work, id: 'w-0010', sessionSeq: 3 },
      sessions: [
        {
          id: 's-01',
          provider: 'claude',
          label: 'план',
          task: 'составить план',
          parent: null,
          contextFrom: [],
          status: 'done',
          history: [
            { status: 'pending', at: '2026-09-20T10:00:00.000Z' },
            { status: 'active', at: '2026-09-20T10:01:00.000Z' },
            { status: 'done', at: '2026-09-20T10:30:00.000Z' },
            { status: 'active', at: '2026-09-20T11:00:00.000Z' },
            { status: 'done', at: '2026-09-20T11:40:00.000Z' },
          ],
          startedAt: '2026-09-20T10:01:00.000Z',
          endedAt: '2026-09-20T11:40:00.000Z',
          pid: 4242,
          startedAtProcess: '2026-09-20T10:01:00.000Z',
          launchedBy: 'tui',
          providerSessionId: 'uuid-1',
          metrics: null,
          summary: 'план готов',
          summarySource: 'agent',
          artifacts: [{ kind: 'plan', path: 'docs/plan.md' }],
          agent: null,
        },
        {
          id: 's-02',
          provider: 'codex',
          label: 'бэкенд',
          task: 'шаги 1–3',
          parent: 's-01',
          contextFrom: ['s-01'],
          status: 'exited',
          history: [
            { status: 'pending', at: '2026-09-20T10:05:00.000Z' },
            { status: 'active', at: '2026-09-20T10:06:00.000Z' },
            { status: 'exited', at: '2026-09-20T10:50:00.000Z', exitCode: 0 },
          ],
          startedAt: '2026-09-20T10:06:00.000Z',
          endedAt: '2026-09-20T10:50:00.000Z',
          pid: null,
          startedAtProcess: null,
          launchedBy: 'tui',
          providerSessionId: null,
          metrics: null,
          summary: null,
          summarySource: null,
          artifacts: [],
          agent: null,
        },
        {
          id: 's-03',
          provider: 'claude',
          label: 'ревью',
          task: 'проверить',
          parent: 's-01',
          contextFrom: [],
          status: 'active',
          history: [
            { status: 'pending', at: '2026-09-20T10:10:00.000Z' },
            { status: 'active', at: '2026-09-20T10:11:00.000Z' },
          ],
          startedAt: '2026-09-20T10:11:00.000Z',
          endedAt: null,
          pid: 777,
          startedAtProcess: '2026-09-20T10:11:00.000Z',
          launchedBy: 'host',
          providerSessionId: 'uuid-3',
          metrics: null,
          summary: null,
          summarySource: null,
          artifacts: [],
          agent: 'reviewer',
        },
      ],
      messages: [
        {
          id: 'm-01',
          from: 's-01',
          to: 's-02',
          at: '2026-09-20T10:07:00.000Z',
          text: 'начни с миграции',
          kind: 'note',
          readAt: '2026-09-20T10:08:00.000Z',
        },
        {
          id: 'm-02',
          from: 's-02',
          to: 's-01',
          at: '2026-09-20T10:20:00.000Z',
          text: 'схема ок?',
          kind: 'question',
          readAt: '2026-09-20T10:21:00.000Z',
        },
        {
          id: 'm-03',
          from: 's-01',
          to: 's-02',
          at: '2026-09-20T10:22:00.000Z',
          text: 'да',
          kind: 'decision',
          readAt: null,
        },
        {
          id: 'm-04',
          from: 's-03',
          to: 's-01',
          at: '2026-09-20T10:40:00.000Z',
          text: 'замечания',
          readAt: null,
        },
        {
          id: 'm-05',
          from: 's-01',
          to: 's-03',
          at: '2026-09-20T10:45:00.000Z',
          text: 'поправил',
          kind: 'note',
          readAt: null,
          deleted: true,
        },
      ],
    };

    const parsed = parseMap(JSON.stringify(v1), 'map.json');

    const [s1, s2, s3] = v1.sessions as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    // Поля v1, которых в v2 нет: статус и история прежней формы.
    const strip = (session: Record<string, unknown>): Record<string, unknown> => {
      const rest = { ...session };
      delete rest['status'];
      delete rest['history'];
      rest['role'] = typeof rest['agent'] === 'string' ? { source: 'claude', name: rest['agent'] } : null;
      delete rest['agent'];
      return rest;
    };
    expect(parsed).toEqual({
      schemaVersion: 2,
      work: v1.work,
      rooms: [],
      plans: [],
      swarms: [],
      sessions: [
        {
          ...strip(s1),
          lifecycle: 'sleeping',
          result: 'done',
          resultAt: '2026-09-20T11:40:00.000Z',
          closedAt: null,
          worktree: null,
          history: [
            { event: 'pending', at: '2026-09-20T10:00:00.000Z' },
            { event: 'active', at: '2026-09-20T10:01:00.000Z' },
            { event: 'done', at: '2026-09-20T10:30:00.000Z' },
            { event: 'active', at: '2026-09-20T11:00:00.000Z' },
            { event: 'done', at: '2026-09-20T11:40:00.000Z' },
          ],
        },
        {
          ...strip(s2),
          lifecycle: 'sleeping',
          result: null,
          resultAt: null,
          closedAt: null,
          worktree: null,
          history: [
            { event: 'pending', at: '2026-09-20T10:05:00.000Z' },
            { event: 'active', at: '2026-09-20T10:06:00.000Z' },
            { event: 'sleeping', at: '2026-09-20T10:50:00.000Z', exitCode: 0 },
          ],
        },
        {
          ...strip(s3),
          lifecycle: 'active',
          result: null,
          resultAt: null,
          closedAt: null,
          worktree: null,
          history: [
            { event: 'pending', at: '2026-09-20T10:10:00.000Z' },
            { event: 'active', at: '2026-09-20T10:11:00.000Z' },
          ],
        },
      ],
      messages: [
        {
          id: 'm-01',
          roomId: null,
          from: 's-01',
          to: ['s-02'],
          at: '2026-09-20T10:07:00.000Z',
          text: 'начни с миграции',
          kind: 'note',
          readBy: { 's-02': '2026-09-20T10:08:00.000Z' },
        },
        {
          id: 'm-02',
          roomId: null,
          from: 's-02',
          to: ['s-01'],
          at: '2026-09-20T10:20:00.000Z',
          text: 'схема ок?',
          kind: 'question',
          readBy: { 's-01': '2026-09-20T10:21:00.000Z' },
        },
        {
          id: 'm-03',
          roomId: null,
          from: 's-01',
          to: ['s-02'],
          at: '2026-09-20T10:22:00.000Z',
          text: 'да',
          kind: 'decision',
          readBy: {},
        },
        {
          id: 'm-04',
          roomId: null,
          from: 's-03',
          to: ['s-01'],
          at: '2026-09-20T10:40:00.000Z',
          text: 'замечания',
          kind: 'note',
          readBy: {},
        },
        {
          id: 'm-05',
          roomId: null,
          from: 's-01',
          to: ['s-03'],
          at: '2026-09-20T10:45:00.000Z',
          text: 'поправил',
          kind: 'note',
          readBy: {},
          deleted: true,
        },
      ],
    });
  });

  it('разобранная v1 пишется как v2 и читается обратно без потерь', () => {
    const v1 = {
      ...emptyV1(),
      sessions: [
        {
          id: 's-01',
          status: 'failed',
          history: [{ status: 'failed', at: '2026-09-02T11:00:00.000Z' }],
        },
      ],
      messages: [{ id: 'm-01', from: 's-01', to: 's-02', at: '2026-09-02T11:00:00.000Z', text: 't', readAt: null }],
    };
    const once = parseMap(JSON.stringify(v1), 'map.json');
    const twice = parseMap(JSON.stringify(once), 'map.json');

    expect(once.schemaVersion).toBe(2);
    expect(JSON.parse(JSON.stringify(once))).toMatchObject({ schemaVersion: 2, rooms: [] });
    expect(twice).toEqual(once);
  });

  it('карта v1 со статусом idle читается как active — и в history тоже', () => {
    const legacy = {
      ...emptyV1(),
      sessions: [
        {
          id: 's-01',
          status: 'idle',
          history: [
            { status: 'pending', at: '2026-09-02T10:00:00.000Z' },
            { status: 'idle', at: '2026-09-02T11:00:00.000Z' },
          ],
        },
      ],
    };

    const parsed = parseMap(JSON.stringify(legacy), 'map.json');
    expect(parsed.sessions[0]?.lifecycle).toBe('active');
    expect(parsed.sessions[0]?.history.map((entry) => entry.event)).toEqual(['pending', 'active']);
  });

  it('в старой карте без полей процесса они читаются как null', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'план', task: 't' });
    const legacy = JSON.parse(JSON.stringify(map)) as { sessions: Record<string, unknown>[] };
    delete legacy.sessions[0]?.['pid'];
    delete legacy.sessions[0]?.['startedAtProcess'];
    delete legacy.sessions[0]?.['launchedBy'];

    const parsed = parseMap(JSON.stringify(legacy), 'map.json');
    expect(parsed.sessions[0]?.pid).toBeNull();
    expect(parsed.sessions[0]?.startedAtProcess).toBeNull();
    expect(parsed.sessions[0]?.launchedBy).toBeNull();
  });

  it('испорченный effort читается как «нет выбора»: ключа нет, сессия и модель на месте', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'план', task: 't', model: 'opus', effort: 'xhigh' });
    const raw = JSON.parse(JSON.stringify(map)) as { sessions: Record<string, unknown>[] };
    for (const effort of ['hi gh', 'x"', '"x', 'HIGH', '', 'a'.repeat(33), 3, ['low']]) {
      raw.sessions[0]!['effort'] = effort;

      const parsed = parseMap(JSON.stringify(raw), 'map.json');
      expect(parsed.sessions, JSON.stringify(effort)).toHaveLength(1);
      expect('effort' in (parsed.sessions[0] ?? {}), JSON.stringify(effort)).toBe(false);
      expect(parsed.sessions[0]?.model).toBe('opus');
    }
  });

  it('effort: null — явный «Default» (снимает умолчание роли): при чтении карты остаётся', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'план', task: 't', model: 'opus', effort: 'xhigh' });
    const raw = JSON.parse(JSON.stringify(map)) as { sessions: Record<string, unknown>[] };
    raw.sessions[0]!['effort'] = null;

    const parsed = parseMap(JSON.stringify(raw), 'map.json');
    expect(parsed.sessions[0]?.effort).toBeNull();
    expect(parsed.sessions[0]?.model).toBe('opus');
  });

  it('lean: старая карта читается без поля и без миграции, записанное значение при чтении остаётся', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'план', task: 't' });
    const raw = JSON.parse(JSON.stringify(map)) as { sessions: Record<string, unknown>[] };

    const old = parseMap(JSON.stringify(raw), 'map.json');
    expect('lean' in (old.sessions[0] ?? {})).toBe(false);
    expect(old.sessions[0]?.lean).toBeUndefined();

    raw.sessions[0]!['lean'] = true;
    expect(parseMap(JSON.stringify(raw), 'map.json').sessions[0]?.lean).toBe(true);
  });

  it('уровни каталогов в карте читаются как есть: xhigh, max, ultra', () => {
    const map = emptyMap();
    for (const effort of ['xhigh', 'max', 'ultra']) {
      addSession(map, { provider: 'codex', label: effort, task: 't', effort });
    }

    expect(parseMap(JSON.stringify(map), 'map.json').sessions.map((session) => session.effort)).toEqual([
      'xhigh',
      'max',
      'ultra',
    ]);
  });

  it('35: карта без kind у письма читается как note, остальные поля не тронуты', () => {
    const raw = JSON.stringify({
      ...emptyV1(),
      messages: [
        {
          id: 'm-01',
          from: 's-01',
          to: 's-02',
          at: '2026-09-08T10:00:00.000Z',
          text: 'x',
          readAt: null,
        },
      ],
    });

    const map = parseMap(raw, 'map.json');
    expect(map.messages[0]).toMatchObject({
      id: 'm-01',
      from: 's-01',
      to: ['s-02'],
      at: '2026-09-08T10:00:00.000Z',
      text: 'x',
      kind: 'note',
      readBy: {},
    });
  });

  describe('ведущий и решение комнаты (дизайн комнат, 3.1)', () => {
    /** Комната как её писали до 2026-09-29: без `lead` и `proposal`. */
    const oldRoom = {
      id: 'r-01',
      title: 'Возвраты',
      creator: 'human',
      members: ['s-02', 's-03'],
      createdAt: '2026-09-20T10:00:00.000Z',
    };
    const withRooms = (rooms: unknown[]): string =>
      JSON.stringify({ ...emptyMap(), rooms, work: { ...emptyMap().work, roomSeq: rooms.length } });

    it('в старой карте lead и proposal читаются как null, остальное не тронуто', () => {
      const parsed = parseMap(withRooms([oldRoom]), 'map.json');

      expect(parsed.rooms[0]).toEqual({ ...oldRoom, ownerId: null, lead: null, proposal: null, mode: 'free', recipe: null, archivedAt: null });
    });

    it('ведущий старой комнаты — первый из members (lead: null не переписывается в id)', () => {
      const parsed = parseMap(withRooms([oldRoom]), 'map.json');

      expect(parsed.rooms[0]?.lead).toBeNull();
      expect(roomLead(parsed.rooms[0] as Room)).toBe('s-02');
    });

    it('карта v1 без комнат по-прежнему даёт пустой список', () => {
      expect(parseMap(JSON.stringify(emptyV1()), 'map.json').rooms).toEqual([]);
    });

    it('явные lead и proposal читаются как записаны и переживают круг запись → чтение', () => {
      const proposal = { id: 'p-01', from: 's-03', text: 'решение @s02', rev: 2, at: '2026-09-29T12:00:00.000Z' };
      const written = { ...oldRoom, lead: 's-03', proposal };

      const parsed = parseMap(withRooms([written]), 'map.json');
      expect(parsed.rooms[0]).toEqual({ ...written, ownerId: null, mode: 'free', recipe: null, archivedAt: null, proposal: { ...proposal, kind: 'decision' } });
      expect(parseMap(JSON.stringify(parsed), 'map.json')).toEqual(parsed);
    });

    it('archivedAt: старая комната читается открытой, записанное время переживает круг запись → чтение (архив комнат, 3.1)', () => {
      const archivedAt = '2026-10-08T12:00:00.000Z';
      const parsed = parseMap(withRooms([oldRoom, { ...oldRoom, id: 'r-02', archivedAt }]), 'map.json');

      expect(parsed.rooms.map((room) => room.archivedAt)).toEqual([null, archivedAt]);
      expect(parseMap(JSON.stringify(parsed), 'map.json')).toEqual(parsed);
    });

    it('запись комнаты не объект — как и раньше, читается без TypeError на миграции', () => {
      expect(() => parseMap(withRooms([null]), 'map.json')).not.toThrow();
    });
  });

  it('битый json — ошибка', () => {
    expect(() => parseMap('{ сломано', 'map.json')).toThrow(/^map map\.json cannot be parsed: /);
  });

  it('чужая форма или другая версия схемы — ошибка', () => {
    expect(() =>
      parseMap('{"schemaVersion":2,"work":{},"sessions":[],"messages":[],"rooms":[]}', 'map.json'),
    ).toThrow(/cannot be parsed: unexpected shape/);
    expect(() =>
      parseMap(
        '{"schemaVersion":3,"work":{"id":"w-0001"},"sessions":[],"messages":[],"rooms":[]}',
        'map.json',
      ),
    ).toThrow(/cannot be parsed: unexpected shape/);
    // v2 без комнат — не наша карта: v2 пишется только с ними.
    expect(() =>
      parseMap(
        '{"schemaVersion":2,"work":{"id":"w-0001"},"sessions":[],"messages":[]}',
        'map.json',
      ),
    ).toThrow(/cannot be parsed: unexpected shape/);
    expect(() => parseMap('{"schemaVersion":1,"sessions":[]}', 'map.json')).toThrow(/cannot be parsed: unexpected shape/);
    expect(() => parseMap('[]', 'map.json')).toThrow(/cannot be parsed: unexpected shape/);
  });

  it('чужая форма записи внутри массивов — ошибка, а не TypeError при мутации', () => {
    const withSessions = (sessions: string): string =>
      `{"schemaVersion":1,"work":{"id":"w-0001"},"sessions":${sessions},"messages":[]}`;

    expect(() => parseMap(withSessions('[null]'), 'map.json')).toThrow(/cannot be parsed: unexpected shape/);
    expect(() =>
      parseMap(withSessions('[{"id":"s-01","status":"запущена","history":[]}]'), 'map.json'),
    ).toThrow(/cannot be parsed: unexpected shape/);
    expect(() => parseMap(withSessions('[{"id":"s-01","status":"active"}]'), 'map.json')).toThrow(
      /cannot be parsed: unexpected shape/,
    );
    expect(() =>
      parseMap(
        '{"schemaVersion":1,"work":{"id":"w-0001"},"sessions":[],"messages":[null]}',
        'map.json',
      ),
    ).toThrow(/cannot be parsed: unexpected shape/);
    // v2: статус v1 вместо оси процесса и один адресат строкой — чужая форма.
    const v2 = (sessions: string, messages: string): string =>
      `{"schemaVersion":2,"work":{"id":"w-0001"},"sessions":${sessions},"messages":${messages},"rooms":[]}`;
    expect(() =>
      parseMap(v2('[{"id":"s-01","status":"active","history":[]}]', '[]'), 'map.json'),
    ).toThrow(/cannot be parsed: unexpected shape/);
    expect(() => parseMap(v2('[]', '[{"id":"m-01","to":"s-01"}]'), 'map.json')).toThrow(
      /cannot be parsed: unexpected shape/,
    );
  });
});

describe('parseMap — письма прежней карты под таблицу писем', () => {
  const AT = '2026-09-20T10:45:00.000Z';
  const letter = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'm-05',
    roomId: null,
    from: 's-01',
    to: ['s-02'],
    at: AT,
    text: 'письмо',
    kind: 'note',
    readBy: {},
    ...patch,
  });
  const parse = (messages: unknown[], version = 2): WindowWorkMap => {
    const base = version === 2 ? emptyMap() : emptyV1();
    return parseMap(JSON.stringify({ ...base, messages }), 'map.json');
  };

  it.each([
    ['readBy', { readBy: null }],
    ['readBy', { readBy: ['s-02'] }],
    ['readBy', { readBy: { 's-02': 5 } }],
    ['readBy', { readBy: undefined }],
    ['roomId', { roomId: 7 }],
    ['roomId', { roomId: undefined }],
    ['at', { at: 'вчера' }],
    ['at', { at: 5 }],
    ['at', { at: undefined }],
    ['from', { from: undefined }],
    ['text', { text: 5 }],
    ['kind', { kind: 5 }],
    ['deleted', { deleted: 'yes' }],
    ['to', { to: ['s-02', 7] }],
  ])('письмо с неверным полем %s отвергается причиной с номером письма, а не сырой ошибкой', (field, patch) => {
    expect(() => parse([letter(patch)])).toThrow(
      new RegExp(`^map map\\.json cannot be parsed: unexpected shape \\(letter m-05 has an invalid ${field}\\)`),
    );
  });

  it('письмо v1 с нечитаемым временем отвергается, а readBy и roomId у v1 не требуются: их ставит миграция', () => {
    const v1 = (patch: Record<string, unknown>) => ({ id: 'm-01', from: 's-01', to: 's-02', at: AT, text: 't', ...patch });

    expect(() => parse([v1({ at: 'вчера' })], 1)).toThrow(/letter m-01 has an invalid at/);
    expect(parse([v1({ readAt: AT })], 1).messages[0]).toMatchObject({ roomId: null, to: ['s-02'], readBy: { 's-02': AT } });
  });

  it('время письма приводится к каноническому ISO-моменту (тот же момент), а deleted: false убирается', () => {
    const [plain, offset, gone, kept] = parse([
      letter({ id: 'm-01', at: '2026-09-20T10:45:00Z' }),
      letter({ id: 'm-02', at: '2026-09-20T13:45:00+03:00' }),
      letter({ id: 'm-03', deleted: false }),
      letter({ id: 'm-04', deleted: true }),
    ]).messages;

    expect(plain!.at).toBe('2026-09-20T10:45:00.000Z');
    expect(offset!.at).toBe('2026-09-20T10:45:00.000Z');
    expect(Object.hasOwn(gone!, 'deleted')).toBe(false);
    expect(kept!.deleted).toBe(true);
  });

  it('незнакомые ключи письма разбор не трогает: их переносит переезд', () => {
    expect(parse([letter({ pinned: { by: 'human' } })]).messages[0]).toMatchObject({ pinned: { by: 'human' } });
  });
});

describe('parseMapText и normalizeMap', () => {
  it('parseMap равна normalizeLegacyMap(parseMapText(...)): и для v2, и для v1, и для отказов', () => {
    const v2 = JSON.stringify(emptyMap());
    const v1 = JSON.stringify({
      ...emptyV1(),
      sessions: [{ id: 's-01', status: 'failed', history: [{ status: 'failed', at: '2026-09-02T11:00:00.000Z' }] }],
      messages: [{ id: 'm-01', from: 's-01', to: 's-02', at: '2026-09-02T11:00:00.000Z', text: 't', readAt: null }],
    });

    for (const raw of [v2, v1]) {
      expect(parseMap(raw, 'map.json')).toEqual(normalizeLegacyMap(parseMapText(raw, 'map.json'), 'map.json'));
    }
    // Письма v1 разбор прежнего файла переводит сам: адресат — список, отметка — `readBy`.
    expect(parseMap(v1, 'map.json').messages).toEqual([
      { id: 'm-01', roomId: null, from: 's-01', to: ['s-02'], at: '2026-09-02T11:00:00.000Z', text: 't', kind: 'note', readBy: {} },
    ]);
    const failure = (run: () => unknown): string => {
      try {
        run();
      } catch (error) {
        return (error as Error).message;
      }
      return 'no error';
    };
    for (const raw of ['{', JSON.stringify({ schemaVersion: 3 })]) {
      const viaParse = failure(() => parseMap(raw, 'map.json'));
      expect(viaParse).toMatch(/^map map\.json cannot be parsed: /);
      expect(failure(() => normalizeMap(parseMapText(raw, 'map.json'), 'map.json'))).toBe(viaParse);
    }
  });

  it('normalizeMap принимает хранимую карту без писем и их не проверяет; письма проверяет разбор прежнего файла', () => {
    const stored: Partial<WindowWorkMap> = emptyMap();
    delete stored.messages;
    expect(() => normalizeMap(structuredClone(stored), 'map.json')).not.toThrow();

    const broken = { ...emptyMap(), messages: [{ id: 'm-01', to: 's-02' }] };
    expect(() => parseMap(JSON.stringify(broken), 'map.json')).toThrow(/^map map\.json cannot be parsed: unexpected shape/);
    expect(() => normalizeMap(structuredClone(broken), 'map.json')).not.toThrow();
    const noLetters = { ...stored };
    expect(() => parseMap(JSON.stringify(noLetters), 'map.json')).toThrow(/unexpected shape/);
  });

  it('parseMapText отдаёт сырой объект без разбора формы, а имя источника попадает в текст отказа', () => {
    expect(parseMapText('{"schemaVersion":99}', 'x')).toEqual({ schemaVersion: 99 });
    expect(() => parseMapText('not json', 'works/w-0001')).toThrow(/^map works\/w-0001 cannot be parsed: /);
  });

  it('normalizeMap идемпотентна: повторный разбор уже разобранной карты ничего не меняет', () => {
    const v1 = {
      ...emptyV1(),
      sessions: [{ id: 's-01', status: 'idle', history: [{ status: 'idle', at: '2026-09-02T11:00:00.000Z' }] }],
      messages: [{ id: 'm-01', from: 's-01', to: 's-02', at: '2026-09-02T11:00:00.000Z', text: 't', readAt: null }],
    };
    const once = normalizeMap(v1, 'map.json');
    const snapshot = structuredClone(once);
    const twice = normalizeMap(once, 'map.json');

    expect(twice).toEqual(snapshot);
    expect(normalizeMap(structuredClone(snapshot), 'map.json')).toEqual(snapshot);
  });
});

describe('removeSession', () => {
  /** Работа с деревом `s-01 → s-02 → s-03` и перепиской между ними. */
  const tree = (): WorkMap => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'план', task: 't' });
    fixtureSession(map, { provider: 'claude', label: 'бэкенд', task: 't', parent: 's-01' });
    fixtureSession(map, {
      provider: 'claude',
      label: 'ревью',
      task: 't',
      parent: 's-02',
      contextFrom: ['s-01', 's-02'],
    });
    return map;
  };

  it('20: дети поднимаются к родителю удалённой, contextFrom вычищен', () => {
    const map = tree();
    const removed = removeSession(map, lt(map), 's-02');

    expect(removed.id).toBe('s-02');
    expect(map.sessions.map((session) => session.id)).toEqual(['s-01', 's-03']);
    expect(map.sessions[1]?.parent).toBe('s-01');
    expect(map.sessions[1]?.contextFrom).toEqual(['s-01']);
  });

  it('20: у детей сессии верхнего уровня родитель становится null', () => {
    const map = tree();
    removeSession(map, lt(map), 's-01');

    expect(map.sessions[0]?.parent).toBeNull();
  });

  it('21: сообщения удалённой остаются в карте с пометкой deleted', () => {
    const map = tree();
    addMessage(map, { from: 's-02', to: ['s-01'], text: 'жду миграции' });
    addMessage(map, { from: 's-01', to: ['s-03'], text: 'не про неё' });
    addMessage(map, { from: 's-01', to: ['s-03', 's-02'], text: 'обоим' });
    removeSession(map, lt(map), 's-02');

    expect(map.messages).toHaveLength(3);
    expect(map.messages[0]?.deleted).toBe(true);
    expect(map.messages[0]?.text).toBe('жду миграции');
    expect(map.messages[1]?.deleted).toBeUndefined();
    // Удалённая — один из адресатов: `to.includes`, а не сравнение строки с массивом.
    expect(map.messages[2]?.deleted).toBe(true);
  });

  it('22: id не переиспользуется — счётчик sessionSeq переживает удаление', () => {
    const map = tree();
    removeSession(map, lt(map), 's-03');

    expect(map.work.sessionSeq).toBe(3);
    expect(addSession(map, { provider: 'claude', label: 'тесты', task: 't' }).id).toBe('s-04');
    expect(map.work.deletedSessions).toEqual(['s-03']);
    // След удаления — только id: данных сессии в карте не остаётся.
    expect(JSON.stringify(map)).not.toContain('ревью');
  });

  it('22: удаление всех сессий работы не начинает нумерацию заново', () => {
    const map = tree();
    for (const id of ['s-01', 's-02', 's-03']) removeSession(map, lt(map), id);

    expect(map.sessions).toEqual([]);
    expect(map.work.deletedSessions).toEqual(['s-01', 's-02', 's-03']);
    expect(addSession(map, { provider: 'claude', label: 'ещё', task: 't' }).id).toBe('s-04');
  });

  it('23: карта без sessionSeq читается по максимуму списка', () => {
    const map = tree();
    const legacy = JSON.parse(JSON.stringify(map)) as WorkMap & {
      work: Record<string, unknown>;
    };
    delete legacy.work['sessionSeq'];

    const parsed = parseMap(JSON.stringify(legacy), 'map.json');
    expect(parsed.work.sessionSeq).toBeUndefined();
    expect(addSession(parsed, { provider: 'claude', label: 'ещё', task: 't' }).id).toBe('s-04');
  });

  it('createdBy пишется только при создании агентом и ничего не наследует; удаление создателя ставит null', () => {
    const map = emptyMap();
    const lead = addSession(map, { provider: 'claude', label: 'лид', task: 't' });
    const peer = addSession(map, { provider: 'claude', label: 'исполнитель', task: 't', createdBy: lead.id });

    expect(lead).not.toHaveProperty('createdBy');
    expect(peer).toMatchObject({ createdBy: lead.id, parent: null, contextFrom: [] });
    expect(parseMap(JSON.stringify(map), 'map.json').sessions[1]?.createdBy).toBe(lead.id);

    removeSession(map, lt(map), lead.id);
    expect(map.sessions[0]?.createdBy).toBeNull();
  });

  it('карта без createdBy читается как раньше, битое значение отбрасывается', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'старая', task: 't' });
    addSession(map, { provider: 'claude', label: 'битая', task: 't' });
    const raw = JSON.parse(JSON.stringify(map)) as { sessions: Array<Record<string, unknown>> };
    raw.sessions[1]!['createdBy'] = 42;

    const parsed = parseMap(JSON.stringify(raw), 'map.json');
    expect(parsed.sessions.map((session) => session.createdBy ?? null)).toEqual([null, null]);
    expect(parsed.sessions[1]).not.toHaveProperty('createdBy');
  });

  it('24: удаление несуществующего id — ошибка, карта не меняется', () => {
    const map = tree();

    expect(() => removeSession(map, lt(map), 's-99')).toThrow(/s-99/);
    expect(map.sessions).toHaveLength(3);
    expect(map.work.deletedSessions).toBeUndefined();
  });
});

describe('role-only normalized records', () => {
  it('rejects agent plus role before mutation and never persists computed defaults', () => {
    const map = emptyMap();
    expect(() => addSession(map, { provider: 'claude', label: '', task: '', agent: 'legacy', role: null })).toThrow('agent-and-role-conflict');
    expect(map.sessions).toHaveLength(0);
    const session = addSession(map, { provider: 'codex', label: '', task: '', role: { source: 'builtin', name: 'planner' } });
    expect(session).toMatchObject({ role: { source: 'builtin', name: 'planner' } });
    expect(Object.hasOwn(session, 'model')).toBe(false); expect(Object.hasOwn(session, 'effort')).toBe(false);
  });
  it('migrates exact legacy identity once and removes agent on read', () => {
    const map = emptyMap();
    const session = addSession(map, { provider: 'claude', label: '', task: '' });
    delete session.role; session.agent = 'two words';
    const migrated = parseMap(JSON.stringify(map), 'map.json');
    expect(migrated.sessions[0]?.role).toEqual({ source: 'claude', name: 'two words' });
    expect(JSON.stringify(migrated)).not.toContain('"agent"');
  });
});

/** Исторические parent-связи задаются фикстурой, новый конструктор их не создаёт. */
function fixtureSession(map: WorkMap, init: Parameters<typeof addSession>[1], at?: string) {
  const session = addSession(map, { ...init, parent: null }, at);
  session.parent = init.parent ?? null;
  return session;
}

describe('room ownership migration', () => {
  it('materializes legacy creator without reordering lead or touching history and is idempotent', () => {
    const map = emptyMap();
    const creator = addSession(map, { provider: 'claude', label: 'owner', task: '' });
    const member = addSession(map, { provider: 'codex', label: 'lead', task: '' });
    transitionSession(map, creator.id, 'closed');
    const legacy = { id: 'r-01', title: 'old', creator: creator.id, members: [member.id], createdAt: map.work.createdAt,
      archivedAt: '2026-10-01T00:00:00Z', memberLog: [{ session: creator.id, from: map.work.createdAt, to: null }] };
    const message = addMessage(map, { from: member.id, to: [], text: 'history', roomId: legacy.id });
    message.readBy[creator.id] = map.work.createdAt;
    const parsed = parseMap(JSON.stringify({ ...map, rooms: [legacy] }), 'map.json');
    expect(parsed.rooms[0]).toMatchObject({ ownerId: creator.id, creator: creator.id, members: [member.id, creator.id], memberLog: legacy.memberLog, archivedAt: legacy.archivedAt });
    expect(roomLead(parsed.rooms[0]!)).toBe(member.id);
    expect(parsed.messages).toEqual(map.messages);
    expect(parsed.sessions).toEqual(map.sessions);
    expect(parseMap(JSON.stringify(parsed), 'map.json')).toEqual(parsed);
  });

  it('human and missing creators migrate owner to null; explicit owner null prevents legacy membership', () => {
    const map = emptyMap();
    const base = { title: 'old', members: [], createdAt: map.work.createdAt };
    const parsed = parseMap(JSON.stringify({ ...map, rooms: [
      { ...base, id: 'r-01', creator: HUMAN },
      { ...base, id: 'r-02', creator: 's-99' },
      { ...base, id: 'r-03', creator: 's-99', ownerId: null },
    ] }), 'map.json');
    expect(parsed.rooms.map((room) => room.ownerId)).toEqual([null, null, null]);
    expect(parsed.rooms[0]?.members).toEqual([]);
    expect(parsed.rooms[2]?.members).toEqual([]);
  });

  it('new non-null parent fails before any map mutation', () => {
    const map = emptyMap();
    const before = structuredClone(map);
    expect(() => addSession(map, { provider: 'claude', label: '', task: '', parent: 's-01' })).toThrow(/parent/);
    expect(map).toEqual(before);
  });
});


describe('clone workspace', () => {
  it('preserves valid clone metadata and accepts old maps', () => {
    const map = emptyMap();
    const session = addSession(map, { provider: 'codex', label: 'worker', task: 'work' });
    expect(parseMap(JSON.stringify(map)).sessions[0]?.workspace).toBeUndefined();
    Object.assign(session, { workspace: { kind: 'clone', path: '/tmp/clone', branch: 'attempts/at-0001', sha: 'abc' } });
    expect(parseMap(JSON.stringify(map)).sessions[0]?.workspace).toEqual(session.workspace);
  });
  it.each([{ kind: 'worktree', path: '/tmp/c', branch: 'a', sha: 'abc' }, { kind: 'clone', path: '', branch: 'a', sha: 'abc' }, { kind: 'clone', path: '/tmp/c', branch: 'a' }])('rejects malformed clone metadata %j', workspace => {
    const map = emptyMap();
    Object.assign(addSession(map, { provider: 'codex', label: 'worker', task: 'work' }), { workspace });
    expect(() => parseMap(JSON.stringify(map))).toThrow();
  });
});


it('parses engine artifact workspaces without clone branch metadata', () => {
  const map = emptyMap();
  Object.assign(addSession(map, { provider: 'codex', label: 'Review', task: 'Review' }), { workspace: { kind: 'artifacts', path: '/engine/review/op-01' } });
  expect(parseMap(JSON.stringify(map)).sessions[0]?.workspace).toEqual({ kind: 'artifacts', path: '/engine/review/op-01' });
});

describe('рои в карте (спека роя v1, 2.1–2.2)', () => {
  const AT = '2026-10-28T10:00:00.000Z';
  const swarmOf = (patch: Partial<WorkSwarm> = {}): WorkSwarm => ({
    id: 'sw-01', tag: 'Research', creator: { kind: 'human' }, objective: 'Audit', queen: 's-01',
    members: [
      { sessionId: 's-01', role: 'queen', n: 1, addedAt: AT, handedAt: null },
      { sessionId: 's-02', role: 'drone', n: 1, addedAt: AT, handedAt: null },
    ],
    status: 'running', createdAt: AT, endedAt: null, result: null, failure: null, seenAt: null, expiredAt: null,
    ...patch,
  });
  /** Карта с тремя сессиями, комнатой r-01 и роем в сыром виде, как он лежит в файле. */
  const withSwarms = (...swarms: unknown[]): WindowWorkMap => {
    const map = emptyMap();
    for (const label of ['королева', 'трутень', 'создатель']) addSession(map, { provider: 'claude', label, task: 't' });
    map.rooms.push({
      id: 'r-01', title: 'Комната', creator: HUMAN, ownerId: null, members: [], lead: null, mode: 'free', proposal: null,
      recipe: null, archivedAt: null, createdAt: AT,
    } as Room);
    (map as unknown as Record<string, unknown>)['swarms'] = swarms;
    return map;
  };
  const read = (map: WindowWorkMap): WorkMap => parseMap(JSON.stringify(map), 'map.json');

  it('карта без swarms читается: поле становится []', () => {
    const map = emptyMap();
    expect('swarms' in map).toBe(false);
    expect(read(map).swarms).toEqual([]);
  });

  it('карта с роем читается без изменений, повторный разбор идемпотентен', () => {
    const map = withSwarms(swarmOf({ creator: { kind: 'session', sessionId: 's-03' } }), swarmOf({ id: 'sw-02', creator: { kind: 'room', roomId: 'r-01' } }));
    const parsed = read(map);
    expect(parsed.swarms).toEqual(map.swarms);
    expect(parseMap(JSON.stringify(parsed), 'again.json')).toEqual(parsed);
  });

  it.each([
    ['не объект', 42],
    ['без id', { ...swarmOf(), id: undefined }],
    ['статус вне списка', { ...swarmOf(), status: 'paused' }],
    ['без королевы среди участников', swarmOf({ queen: 's-09' })],
    ['королева с неизвестной ролью', swarmOf({ members: [{ sessionId: 's-01', role: 'boss', n: 1, addedAt: AT, handedAt: null } as never] })],
    ['участники не массив', { ...swarmOf(), members: 'x' }],
    ['тег длиннее 24 знаков', swarmOf({ tag: 'x'.repeat(25) })],
    ['тег с переводом строки', swarmOf({ tag: 'a\nb' })],
  ])('битая запись роя (%s) убирается, карта и соседний рой читаются', (_name, broken) => {
    const parsed = read(withSwarms(broken, swarmOf({ id: 'sw-02' })));
    expect(parsed.swarms?.map((swarm) => swarm.id)).toEqual(['sw-02']);
  });

  it('swarms не массив читается как []', () => {
    const map = withSwarms();
    (map as unknown as Record<string, unknown>)['swarms'] = 'x';
    expect(read(map).swarms).toEqual([]);
  });

  it('migrateSwarm: участник с неизвестной ролью отбрасывается, остальные остаются', () => {
    const odd = { sessionId: 's-05', role: 'scout', n: 1, addedAt: AT, handedAt: null };
    const parsed = read(withSwarms(swarmOf({ members: [...swarmOf().members, odd as never] })));
    expect(parsed.swarms?.[0]?.members.map((m) => m.sessionId)).toEqual(['s-01', 's-02']);
  });

  it('migrateSwarm: создатель-сессия или комната, которых нет в карте, становится human; существующие остаются', () => {
    const parsed = read(withSwarms(
      swarmOf({ id: 'sw-01', creator: { kind: 'session', sessionId: 's-77' } }),
      swarmOf({ id: 'sw-02', creator: { kind: 'room', roomId: 'r-77' } }),
      { ...swarmOf({ id: 'sw-03' }), creator: undefined },
      swarmOf({ id: 'sw-04', creator: { kind: 'session', sessionId: 's-03' } }),
      swarmOf({ id: 'sw-05', creator: { kind: 'room', roomId: 'r-01' } }),
    ));
    expect(parsed.swarms?.map((swarm) => swarm.creator)).toEqual([
      { kind: 'human' }, { kind: 'human' }, { kind: 'human' },
      { kind: 'session', sessionId: 's-03' }, { kind: 'room', roomId: 'r-01' },
    ]);
  });

  it('migrateSwarm: недостающие необязательные поля получают null', () => {
    const raw = swarmOf() as unknown as Record<string, unknown>;
    for (const key of ['endedAt', 'result', 'failure', 'seenAt', 'expiredAt']) delete raw[key];
    const parsed = read(withSwarms(raw));
    expect(parsed.swarms?.[0]).toMatchObject({ endedAt: null, result: null, failure: null, seenAt: null, expiredAt: null });
  });

  describe('removeSession', () => {
    const NOW = '2026-10-28T12:00:00.000Z';

    it('(а) создатель-сессия удалена: рой переходит к человеку и продолжает идти', () => {
      const map = read(withSwarms(swarmOf({ creator: { kind: 'session', sessionId: 's-03' } })));
      removeSession(map, lt(map), 's-03', NOW);
      expect(map.swarms?.[0]).toMatchObject({ creator: { kind: 'human' }, status: 'running', endedAt: null });
    });

    it('(б) участник удалён: запись остаётся, счётчик не прыгает; состояние — failed, а у сдавшего — handed', () => {
      const map = read(withSwarms(swarmOf({
        members: [
          { sessionId: 's-01', role: 'queen', n: 1, addedAt: AT, handedAt: null },
          { sessionId: 's-02', role: 'drone', n: 1, addedAt: AT, handedAt: AT },
          { sessionId: 's-03', role: 'drone', n: 2, addedAt: AT, handedAt: null },
        ],
      })));
      removeSession(map, lt(map), 's-02', NOW);
      removeSession(map, lt(map), 's-03', NOW);
      const swarm = map.swarms![0]!;
      expect(swarm.members.map((m) => m.sessionId)).toEqual(['s-01', 's-02', 's-03']);
      expect(swarmProgress(swarm)).toEqual({ handed: 1, total: 2 });
      expect(memberState(swarm, swarm.members[1]!, undefined)).toBe('handed');
      expect(memberState(swarm, swarm.members[2]!, undefined)).toBe('failed');
      expect(swarm.status).toBe('running');
    });

    it('(в) королева удалена, рой идёт: cancelled, причина «queen deleted», endedAt ставится', () => {
      for (const status of ['running', 'collecting'] as const) {
        const map = read(withSwarms(swarmOf({ status })));
        removeSession(map, lt(map), 's-01', NOW);
        expect(map.swarms?.[0]).toMatchObject({ status: 'cancelled', failure: 'queen deleted', endedAt: NOW });
      }
    });

    it('(в) королева удалена, рой уже закончился: итог и причина не перезаписываются', () => {
      const done = swarmOf({ status: 'done', endedAt: AT, result: { summary: 'итог', at: AT, deliveredAt: null } });
      const failed = swarmOf({ id: 'sw-02', status: 'failed', endedAt: AT, failure: 'budget' });
      const map = read(withSwarms(done, failed));
      removeSession(map, lt(map), 's-01', NOW);
      expect(map.swarms).toEqual([done, failed]);
    });

    it('сессия вне роёв ничего в роях не меняет', () => {
      const map = read(withSwarms(swarmOf()));
      removeSession(map, lt(map), 's-03', NOW);
      expect(map.swarms).toEqual([swarmOf()]);
    });
  });
});
