/**
 * Автономная комната с планом и рабочими папками сессий для тестов хранилища (спека хранилища 6.2, 6.6): план режима
 * `autonomous` с попыткой, замороженной проверкой и операцией движка, сессия-исполнитель с клоном и сессия-проверяющий
 * с папкой материалов. Один вид данных на оба пути в базу — запись через `updateMap` и переезд прежнего `map.json`.
 */
import { addSession } from '../src/work/map.js';
import { addRoom } from '../src/work/rooms.js';
import { ENGINE, HUMAN } from '../src/work/types.js';
import type { RoomPlan, WorkMap } from '../src/work/types.js';

const AT = '2026-10-25T08:00:00.000Z';
const SHA = 'a'.repeat(40);

/** Автономный план: пункт, заморожённая проверка, попытка с ответом проверяющего и операция «клон» движка. */
export function autonomousPlan(roomId = 'r-01'): RoomPlan {
  return {
    id: 'pl-01',
    roomId,
    mode: 'autonomous',
    status: 'active',
    rev: 1,
    goal: 'Engine-owned change',
    items: [
      {
        id: 1,
        title: 'Implement',
        owner: ENGINE,
        scope: 'src/a.ts',
        after: [],
        criteria: ['Works', 'Reviewed'],
        verifier: ENGINE,
        status: 'in_progress',
        evidence: null,
        note: null,
        log: [],
      },
    ],
    backlog: [],
    acceptedAt: AT,
    completedAt: null,
    cancelledAt: null,
    completionSummary: null,
    autonomous: {
      budget: {
        limits: { attemptsPerItem: 3, repairWaves: 2, minutesPerAttempt: 30, sessions: 6, concurrent: 2 },
        spent: { attempts: 1, repairWaves: 0, sessions: 2, verifiers: 1, minutes: 0, launches: 2 },
        reservations: [{ key: 'op-0002', kind: 'launch', attemptId: 'at-0001', at: AT }],
      },
      checks: [
        {
          id: 'ck-spec-01',
          item: 1,
          argv: ['node', 'test.js'],
          cwd: '.',
          env: { LC_ALL: 'C' },
          inputs: [{ path: 'test.js', blob: 'b'.repeat(40) }],
          timeoutMs: 1000,
          frozenAt: AT,
        },
      ],
      coverage: { 1: { 0: ['ck-spec-01'], 1: ['verifier'] } },
      criteriaVersion: { 1: 1 },
      integration: {
        branch: 'parley/w-0001/integration/pl-01',
        baseSha: SHA,
        verifiedHead: SHA,
        candidateHead: null,
        queue: [],
        suspended: null,
      },
      attempts: [
        {
          id: 'at-0001',
          item: 1,
          n: 1,
          planRev: 1,
          criteriaVersion: 1,
          worker: 's-02',
          verifier: 's-03',
          branch: 'attempts/at-0001',
          baseSha: SHA,
          sha: 'c'.repeat(40),
          tree: 'd'.repeat(40),
          submissionKey: 'e'.repeat(64),
          status: 'checking',
          manifest: {
            version: 1,
            sha: 'c'.repeat(40),
            criteriaVersion: 1,
            dependsOn: [],
            coverage: 'covered',
            scope: 'src/a.ts',
            facts: ['Works'],
            hypotheses: [],
            notFound: [],
            gaps: [],
            text: 'Done',
            artifacts: [{ path: 'evidence.txt', sha256: 'f'.repeat(64), storedAs: 'artifacts/0-evidence.txt' }],
            hash: '1'.repeat(64),
            submittedAt: AT,
          },
          receipt: {
            id: 'rc-0001',
            attemptId: 'at-0001',
            manifestHash: '1'.repeat(64),
            sha: 'c'.repeat(40),
            criteriaVersion: 1,
            valid: true,
            reason: null,
            at: AT,
          },
          checks: [],
          failureSignature: null,
          startedAt: AT,
          endedAt: null,
          log: [{ at: AT, by: ENGINE, status: 'running', note: null, op: 'op-0001' }],
        },
      ],
      ops: [
        {
          key: 'op-0001',
          kind: 'clone',
          attemptId: 'at-0001',
          payload: { purpose: 'attempt', dir: '/tmp/clone/at-0001' },
          state: 'done',
          at: AT,
          settledAt: AT,
          result: { path: '/tmp/clone/at-0001' },
        },
      ],
      halted: null,
      seq: { attempt: 1, receipt: 1, check: 0, op: 2 },
    },
  };
}

/**
 * Кладёт в карту три сессии (ведущий, исполнитель с клоном, проверяющий с папкой материалов), автономную комнату и её
 * план. Время везде одно, поэтому две карты, собранные подряд, равны.
 */
export function addAutonomousRoom(map: WorkMap): void {
  addSession(map, { provider: 'codex', label: 'Lead', task: 'Propose the plan' }, AT);
  addSession(
    map,
    {
      provider: 'codex',
      label: 'Worker',
      task: 'Change',
      workspace: { kind: 'clone', path: '/tmp/clone/at-0001', branch: 'attempts/at-0001', sha: SHA },
    },
    AT,
  );
  addSession(
    map,
    {
      provider: 'codex',
      label: 'Review',
      task: 'Review',
      workspace: { kind: 'artifacts', path: '/tmp/engine/review/op-0003' },
    },
    AT,
  );
  addRoom(map, { title: 'Autonomous', creator: HUMAN, members: ['s-01', 's-02', 's-03'], lead: 's-01', mode: 'autonomous' }, AT);
  map.plans = [autonomousPlan()];
}

/**
 * Карта работы без писем: письма в хранимой карте не живут (спека хранилища 6.2), поэтому `messages` нет; прежний
 * `map.json` получает их пустым списком от вызывающего.
 */
export function autonomousMap(id = 'w-0001'): WorkMap {
  const map: WorkMap = {
    schemaVersion: 2,
    work: { id, title: 'Autonomous room', goal: '', status: 'active', createdAt: AT, updatedAt: AT },
    sessions: [],
    rooms: [],
  };
  addAutonomousRoom(map);
  return map;
}
