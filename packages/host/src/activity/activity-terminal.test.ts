/**
 * Состояние сессии codex по терминалу (спека комнат Organic, 3.6): хуков Codex харнесс не включает,
 * сигналы заголовка и уведомлений (`pty/codex-terminal.ts`) идут в тот же сервис активности, что и
 * хуки Claude Code, и дальше — тем же путём: `activity.changed`, внимание окна, уведомления macOS.
 */

import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addSession,
  createWork,
  hookedSince,
  transitionSession,
  updateMap,
  workPaths,
} from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import { refKey } from '@parley/protocol';
import type { HostContext } from '../context.js';
import type { CodexSignal } from '../pty/codex-terminal.js';
import { createWorksService } from '../works/works-service.js';
import type { WorksService } from '../works/works-service.js';
import { createActivityService, startupWaitFromEnv } from './activity-service.js';
import type { ActivityService, ActivityServiceOptions } from './activity-service.js';

let home = '';
let project = '';
let claudeRoot = '';
let codexRoot = '';
let broadcasts: Array<{ event: EventName; data: unknown }>;
let services: Array<{ stop: () => Promise<void> }> = [];

function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: (event, data) => broadcasts.push({ event, data: data as EventData<EventName> }),
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'parley-claude-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'parley-codex-'));
  process.env['PARLEY_HOME'] = home;
  broadcasts = [];
});

afterEach(async () => {
  await Promise.all(services.map((service) => service.stop()));
  services = [];
  delete process.env['PARLEY_HOME'];
  await Promise.all(
    [home, project, claudeRoot, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function works(): Promise<WorksService> {
  const service = createWorksService(fakeHost());
  services.push(service);
  await service.start();
  return service;
}

function activity(
  worksService: WorksService,
  options: ActivityServiceOptions = {},
): ActivityService {
  const service = createActivityService(fakeHost(), worksService, {
    silenceThresholdMs: 30_000,
    startupWaitMs: 60_000,
    claudeRoot,
    codexRoot,
    ...options,
  });
  services.push(service);
  return service;
}

const settle = (ms = 250): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (check: () => boolean, timeoutMs = 5000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались условия');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** Заводит активную сессию codex `s-01`; журнала `events/` нет: его заводит запуск или notify. */
async function codexSession(
  over: { provider?: string; providerSessionId?: string | null; eventsDir?: boolean } = {},
): Promise<{ workId: string; ref: SessionRef }> {
  const map = await createWork(project, { title: 'Работа' });
  let sessionId = '';
  await updateMap(project, map.work.id, (current) => {
    const created = addSession(current, {
      provider: over.provider ?? 'codex',
      label: 'кодекс',
      task: 'сделать',
    });
    sessionId = created.id;
    created.launchedBy = 'host';
    if (over.providerSessionId !== undefined) created.providerSessionId = over.providerSessionId;
    transitionSession(current, created.id, 'active');
  });
  if (over.eventsDir === true) {
    await mkdir(workPaths(project, map.work.id).events, { recursive: true });
  }
  return { workId: map.work.id, ref: { projectPath: project, workId: map.work.id, sessionId } };
}

const WORKING: CodexSignal = { kind: 'working' };
const READY: CodexSignal = { kind: 'ready' };
const ACTION: CodexSignal = { kind: 'needs-you', reason: 'action-required', detail: null };
/** OSC 9 «Approval requested: ls -la» — то, что печатает `STUB_APPROVAL` перед заголовком Action Required. */
const APPROVAL: CodexSignal = { kind: 'needs-you', reason: 'approval-requested', detail: 'ls -la' };

function changes(ref: SessionRef): string[] {
  return broadcasts
    .filter((entry) => entry.event === 'activity.changed')
    .map((entry) => entry.data as { ref: SessionRef; activity: { activity: string } })
    .filter((entry) => refKey(entry.ref) === refKey(ref))
    .map((entry) => entry.activity.activity);
}

const notices = (kind: string): Array<Record<string, unknown>> =>
  broadcasts
    .filter((entry) => entry.event === 'host.notice')
    .map((entry) => entry.data as Record<string, unknown>)
    .filter((notice) => notice['kind'] === kind);

/** Сервис с запущенной сессией codex: процесс «под хостом» уже стартовал. */
async function started(options: ActivityServiceOptions = {}, over = {}) {
  const { workId, ref } = await codexSession(over);
  const w = await works();
  const a = activity(w, options);
  await a.start();
  a.terminalStarted(ref);
  await settle(100);
  return { a, w, workId, ref };
}

describe('сигналы терминала codex → активность', () => {
  it.each(['task_complete', 'turn_aborted'])(
    '%s в rollout завершает ход без Ready и notify, следующий ход снова работает',
    async (type) => {
      const { a, ref } = await started({}, { providerSessionId: 'rollout-state' });
      const dir = path.join(codexRoot, '2026', '10', '05');
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, 'rollout-2026-10-05T10-00-00-rollout-state.jsonl');
      const record = (type: string, timestamp: string) =>
        `${JSON.stringify({ timestamp, type: 'event_msg', payload: { type } })}\n`;
      a.terminalSignal(ref, WORKING);
      await settle(40);
      const endedAt = new Date().toISOString();
      await writeFile(
        file,
        `${JSON.stringify({ timestamp: endedAt, type: 'session_meta', payload: { id: 'rollout-state', cwd: project, source: 'cli' } })}\n` +
          record(type, endedAt),
      );
      await waitFor(() => a.get(ref)?.activity.activity === 'unseen');
      expect(a.get(ref)?.activity.turnEndedAt).toBe(endedAt);
      a.markSeen(ref);
      expect(a.get(ref)?.activity.activity).toBe('idle');

      // Служебные записи после ответа не означают новый ход.
      await appendFile(file, record('token_count', new Date().toISOString()));
      await settle(300);
      expect(a.get(ref)?.activity.activity).toBe('idle');

      await appendFile(file, record('task_started', new Date().toISOString()));
      await waitFor(() => a.get(ref)?.activity.activity === 'working');
      a.terminalSignal(ref, ACTION);
      expect(a.get(ref)?.activity.activity).toBe('blocked');
      await appendFile(file, record('token_count', new Date().toISOString()));
      await settle(300);
      expect(a.get(ref)?.activity.activity).toBe('blocked');
    },
    15_000,
  );

  it('без строк notify в журнале событий конец хода и «хуки приходили» берутся из терминала и rollout', async () => {
    // Журнала `events/` нет вовсе: ни одной строки Stop от notify.
    const startedAtMs = Date.now();
    const { a, ref } = await started({}, { providerSessionId: 'rollout-no-notify' });
    const dir = path.join(codexRoot, '2026', '10', '07');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'rollout-2026-10-07T10-00-00-rollout-no-notify.jsonl');
    const record = (type: string, timestamp: string) =>
      `${JSON.stringify({ timestamp, type: 'event_msg', payload: { type } })}\n`;
    a.terminalSignal(ref, WORKING);
    await settle(40);
    a.terminalSignal(ref, { kind: 'turn-complete' });
    await settle(40);
    const at = new Date().toISOString();
    await writeFile(
      file,
      `${JSON.stringify({ timestamp: at, type: 'session_meta', payload: { id: 'rollout-no-notify', cwd: project, source: 'cli' } })}\n` +
        record('task_started', at) +
        record('task_complete', new Date(Date.now() + 10).toISOString()),
    );
    await settle(600);
    const live = a.get(ref);
    expect(live?.activity.turnEndedAt).not.toBeNull();
    expect(hookedSince(live?.activity, startedAtMs)).toBe(true);
    expect(live?.activity.activity).not.toBe('working');
  }, 20_000);

  it('working → working; ready → unseen; markSeen → idle', async () => {
    const { a, ref } = await started();

    a.terminalSignal(ref, WORKING);
    expect(a.get(ref)?.activity.activity).toBe('working');

    a.terminalSignal(ref, READY);
    expect(a.get(ref)?.activity.activity).toBe('unseen');

    a.markSeen(ref);
    await settle(50);
    expect(a.get(ref)?.activity.activity).toBe('idle');
  });

  it('заголовок Action Required и уведомление об одобрении — blocked («нужен ты»)', async () => {
    const { a, ref } = await started();
    a.terminalSignal(ref, WORKING);

    a.terminalSignal(ref, ACTION);
    expect(a.get(ref)?.activity.activity).toBe('blocked');

    // Ответили — спиннер снова: blocked снимает работа.
    a.terminalSignal(ref, WORKING);
    expect(a.get(ref)?.activity.activity).toBe('working');

    a.terminalSignal(ref, APPROVAL);
    expect(a.get(ref)?.activity.activity).toBe('blocked');
  });

  it('turn-complete — конец хода, как ready', async () => {
    const { a, ref } = await started();
    a.terminalSignal(ref, WORKING);
    a.terminalSignal(ref, { kind: 'turn-complete' });
    expect(a.get(ref)?.activity.activity).toBe('unseen');
  });

  it('неизвестное состояния не меняет: ни «работает», ни сброса, ни рассылки', async () => {
    const { a, ref } = await started();
    a.terminalSignal(ref, WORKING);
    a.terminalSignal(ref, READY);
    const before = changes(ref).length;

    a.terminalSignal(ref, { kind: 'unknown', source: 'title' });
    a.terminalSignal(ref, { kind: 'unknown', source: 'notification' });
    expect(a.get(ref)?.activity.activity).toBe('unseen');
    expect(changes(ref).length).toBe(before);
  });

  it('до первого известного сигнала состояние тусклое (idle), а не «работает»', async () => {
    const { a, ref } = await started();
    a.terminalSignal(ref, { kind: 'unknown', source: 'title' });
    expect(a.get(ref)?.activity.activity).toBe('idle');
    expect(a.get(ref)?.activity.lastEventAt).toBeNull();
  });

  it('Waiting у Codex: кадры спиннера новее ParleyWaitStart ожидания не снимают, конец хода — снимает', async () => {
    const { a, ref, workId } = await started({}, { eventsDir: true });
    const journal = path.join(workPaths(project, workId).events, `${ref.sessionId}.jsonl`);
    const line = (extra: Record<string, unknown>): string =>
      `${JSON.stringify({ hook_event_name: 'ParleyWaitStart', ...extra })}\n`;

    a.terminalSignal(ref, WORKING);
    // MCP-сервер сессии записал начало ожидания: wait_for внутри хода.
    await appendFile(journal, line({ parley_wait_target: 's-02', parley_wait_id: 'w1' }));
    await waitFor(() => a.get(ref)?.activity.waitingFor === 's-02');

    // Спиннер крутится дальше: время сигнала обновляется на каждом кадре и новее строки ожидания.
    await settle(30);
    for (let frame = 0; frame < 5; frame += 1) a.terminalSignal(ref, WORKING);
    // Пересчёт от постороннего события (запись журнала): прежде синтетический UserPromptSubmit снимал ожидание.
    await appendFile(journal, `${JSON.stringify({ hook_event_name: 'StubReady' })}\n`);
    await settle(400);
    expect(a.get(ref)?.activity.activity).toBe('working');
    expect(a.get(ref)?.activity.waitingFor).toBe('s-02');
    expect(a.get(ref)?.metrics?.waitingFor).toBe('s-02');

    // Ход кончился: ожидание не переживает его.
    a.terminalSignal(ref, READY);
    expect(a.get(ref)?.activity.activity).toBe('unseen');
    expect(a.get(ref)?.activity.waitingFor).toBeNull();
  }, 20_000);

  it('повторные сигналы того же состояния (кадры спиннера) не рассылают activity.changed', async () => {
    const { a, ref } = await started();
    a.terminalSignal(ref, WORKING);
    const count = changes(ref).length;
    for (let frame = 0; frame < 20; frame += 1) a.terminalSignal(ref, WORKING);
    expect(changes(ref).length).toBe(count);
  });

  it('под хостом порог тишины ход не кончает: ни кадров, ни сигналов дольше порога — сессия работает', async () => {
    // Codex с личным `tui.animations=false` или долгий инструмент не пишут заголовок весь ход; процесс под
    // хостом жив (его выход — `terminalStopped`), а конец хода — `Ready`, OSC 9 или `Stop` от notify.
    const { a, ref } = await started({ silenceThresholdMs: 400 });
    a.terminalSignal(ref, WORKING);

    await settle(1000);
    expect(a.get(ref)?.activity.activity).toBe('working');

    // Кадры вернулись после паузы — всё ещё «работает», и рассылка на них не идёт.
    const count = changes(ref).length;
    for (let frame = 0; frame < 6; frame += 1) a.terminalSignal(ref, WORKING);
    expect(a.get(ref)?.activity.activity).toBe('working');
    expect(changes(ref).length).toBe(count);

    // Конец хода приходит сигналом, а не тишиной.
    a.terminalSignal(ref, READY);
    expect(a.get(ref)?.activity.activity).toBe('unseen');
  }, 20_000);

  it('порог тишины по-прежнему роняет `working` сессии codex, чей процесс не под хостом', async () => {
    // Сессия записана в карте как codex, но запущена не окном (например, CLI): терминала у хоста нет,
    // состояние — по журналу, как у всякой, и порог тишины действует.
    const { workId, ref } = await codexSession({ eventsDir: true });
    // Строка — до старта: её приносит первое чтение журнала, а не уведомление fs.watch. Старт заводит
    // наблюдателей (журналы, индекс логов), на macOS каждый новый пересоздаёт общий для процесса поток
    // FSEvents, и запись в этот миг не доходила ни до одного из них: `working` не наступало вовсе.
    const journal = path.join(workPaths(project, workId).events, `${ref.sessionId}.jsonl`);
    await appendFile(journal, `${JSON.stringify({ hook_event_name: 'UserPromptSubmit' })}\n`);
    // Часы сервиса стоят на времени строки (событие журнала получает mtime файла): порог не истечёт,
    // как бы ни запоздало чтение, пока часы не сдвинуты.
    const at = (await stat(journal)).mtime.getTime();
    let now = at;
    const w = await works();
    const a = activity(w, { silenceThresholdMs: 1500, now: () => now });
    await a.start();
    await waitFor(() => a.get(ref)?.activity.activity === 'working');

    // Порог позади: сессию пересчитывает таймер тишины, и ход окончен.
    now = at + 1501;
    await waitFor(() => a.get(ref)?.activity.activity === 'unseen', 6000);
  }, 20_000);

  it('Stop от notify новее сигнала работы завершает ход, но следующий кадр спиннера возвращает `working`', async () => {
    // Журнал даёт событию время файла на момент чтения; `Stop`, который скрипт notify дописал позже
    // последнего кадра, перекрывает сигнал терминала. Ход при этом идёт (следующий ход из очереди Tab
    // начинается сразу после конца предыдущего), и повторный кадр того же вида обязан это исправить.
    const { a, ref, workId } = await started();
    a.terminalSignal(ref, WORKING);
    await settle(30);

    const dir = workPaths(project, workId).events;
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, `${ref.sessionId}.jsonl`), `${JSON.stringify({ hook_event_name: 'Stop' })}\n`);
    await updateMap(project, workId, () => undefined);
    await waitFor(() => a.get(ref)?.activity.activity === 'unseen');

    await settle(30);
    a.terminalSignal(ref, WORKING);
    expect(a.get(ref)?.activity.activity).toBe('working');
    // И держится: пересчёт от чужого события порядок не ломает.
    await updateMap(project, workId, () => undefined);
    await settle(200);
    expect(a.get(ref)?.activity.activity).toBe('working');
  }, 20_000);

  it('Stop от notify во время Action Required не снимает «нужен ты»: следующее мигание заголовка возвращает blocked', async () => {
    const { a, ref, workId } = await started();
    a.terminalSignal(ref, WORKING);
    a.terminalSignal(ref, ACTION);
    expect(a.get(ref)?.activity.activity).toBe('blocked');
    await settle(30);

    const dir = workPaths(project, workId).events;
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, `${ref.sessionId}.jsonl`), `${JSON.stringify({ hook_event_name: 'Stop' })}\n`);
    await updateMap(project, workId, () => undefined);
    await waitFor(() => a.get(ref)?.activity.activity === 'unseen');

    // Заголовок Action Required мигает, пока Codex ждёт человека: следующее мигание — тот же вид сигнала.
    await settle(30);
    a.terminalSignal(ref, ACTION);
    expect(a.get(ref)?.activity.activity).toBe('blocked');
  }, 20_000);

  it('повторный сигнал, с которым состояние согласно, пересчёта не заводит', async () => {
    const { a, ref } = await started();
    a.terminalSignal(ref, WORKING);
    a.terminalSignal(ref, WORKING);
    const count = changes(ref).length;
    for (let frame = 0; frame < 30; frame += 1) a.terminalSignal(ref, WORKING);
    a.terminalSignal(ref, READY);
    for (let frame = 0; frame < 5; frame += 1) a.terminalSignal(ref, READY);
    expect(changes(ref).length).toBe(count + 1);
  });

  it('первый Ready с запуска — агент у приглашения, а не конец хода: не unseen и без «finished»', async () => {
    const before = Date.now();
    const { a, ref } = await started();
    a.terminalSignal(ref, READY);

    // Тусклое состояние, как у свежей сессии Claude, но хост «в курсе»: по сигналу можно отправлять и будить.
    expect(a.get(ref)?.activity.activity).toBe('idle');
    expect(a.get(ref)?.activity.turnEndedAt).toBeNull();
    expect(hookedSince(a.get(ref)?.activity, before)).toBe(true);

    // Повторные Ready (заголовок переписывается при смене ветки или модели) ничего не меняют.
    for (let repeat = 0; repeat < 3; repeat += 1) a.terminalSignal(ref, READY);
    expect(a.get(ref)?.activity.activity).toBe('idle');
    expect(changes(ref)).not.toContain('unseen');
  });

  it('Ready после хода — конец хода; следующий за ним Ready ничего не меняет', async () => {
    const { a, ref } = await started();
    a.terminalSignal(ref, READY);
    a.terminalSignal(ref, WORKING);
    a.terminalSignal(ref, READY);
    expect(a.get(ref)?.activity.activity).toBe('unseen');
    a.terminalSignal(ref, READY);
    expect(a.get(ref)?.activity.activity).toBe('unseen');
  });

  it('agent-turn-complete до всякого заголовка работы — конец хода, а не приглашение', async () => {
    const { a, ref } = await started();
    a.terminalSignal(ref, { kind: 'turn-complete' });
    expect(a.get(ref)?.activity.activity).toBe('unseen');
    a.terminalSignal(ref, READY);
    expect(a.get(ref)?.activity.activity).toBe('unseen');
  });

  it('конец хода от notify (Stop в журнале) после сигнала работы завершает ход', async () => {
    const { a, ref, workId } = await started();
    a.terminalSignal(ref, WORKING);
    await settle(30);

    const dir = workPaths(project, workId).events;
    await mkdir(dir, { recursive: true });
    await appendFile(
      path.join(dir, `${ref.sessionId}.jsonl`),
      `${JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'Готово.' })}\n`,
    );
    // Журнал заведён после старта: наблюдатель подхватит его по следующему изменению карты.
    await updateMap(project, workId, () => undefined);
    await waitFor(() => a.get(ref)?.activity.activity === 'unseen');
  }, 20_000);

  it('Stop, записанный до последнего сигнала работы, следующий ход не перекрывает', async () => {
    const { a, ref, workId } = await started();
    const dir = workPaths(project, workId).events;
    await mkdir(dir, { recursive: true });
    await appendFile(
      path.join(dir, `${ref.sessionId}.jsonl`),
      `${JSON.stringify({ hook_event_name: 'Stop' })}\n`,
    );
    await updateMap(project, workId, () => undefined);
    await waitFor(() => a.get(ref)?.activity.activity === 'unseen');

    await settle(60);
    a.terminalSignal(ref, WORKING);
    expect(a.get(ref)?.activity.activity).toBe('working');
    // Пересчёт от чужого события (карта) порядок не ломает: Stop старше сигнала.
    await updateMap(project, workId, () => undefined);
    await settle(200);
    expect(a.get(ref)?.activity.activity).toBe('working');
  }, 20_000);

  it('лог rollout не возвращает working после конца хода: под хостом состояние ведёт терминал', async () => {
    const started1 = new Date().toISOString();
    const { a, ref } = await started({}, { providerSessionId: 'нить-лога' });
    // Запись лога новее сигнала конца хода — как `task_complete` и `token_count` после хода.
    const dir = path.join(codexRoot, '2026', '09', '29');
    await mkdir(dir, { recursive: true });
    a.terminalSignal(ref, WORKING);
    await settle(40);
    a.terminalSignal(ref, READY);
    await settle(40);
    await writeFile(
      path.join(dir, 'rollout-2026-09-29T10-00-00-нить-лога.jsonl'),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'session_meta',
        payload: { id: 'нить-лога', timestamp: started1, cwd: project, source: 'cli' },
      })}\n${JSON.stringify({
        timestamp: new Date(Date.now() + 5000).toISOString(),
        type: 'event_msg',
        payload: { type: 'task_complete' },
      })}\n`,
    );
    await settle(600);
    expect(a.get(ref)?.activity.activity).toBe('unseen');
  }, 20_000);

  it('сигнал для сессии, чей процесс хостом не запускался, ничего не меняет', async () => {
    const { ref } = await codexSession();
    const w = await works();
    const a = activity(w);
    await a.start();
    await settle(100);

    a.terminalSignal(ref, WORKING);
    expect(a.get(ref)?.activity.activity).not.toBe('working');
  });

  it('незапущенный процесс (terminalStopped) забывает состояние: сессия читается по журналу', async () => {
    const { a, ref } = await started();
    a.terminalSignal(ref, WORKING);
    expect(a.get(ref)?.activity.activity).toBe('working');

    a.terminalStopped(ref);
    // Процесс вышел без Stop: терминал больше не «работает», журнал пуст — тусклое состояние.
    expect(a.get(ref)?.activity.activity).toBe('idle');
    // И поздний сигнал прошлого процесса уже ничего не меняет.
    a.terminalSignal(ref, WORKING);
    expect(a.get(ref)?.activity.activity).toBe('idle');
  });

  it('новый процесс той же сессии (resume) начинает с чистого состояния', async () => {
    const { a, ref } = await started();
    a.terminalSignal(ref, ACTION);
    expect(a.get(ref)?.activity.activity).toBe('blocked');

    a.terminalStarted(ref);
    expect(a.get(ref)?.activity.activity).toBe('idle');
    expect(a.get(ref)?.activity.lastEventAt).toBeNull();
  });

  it('у нового процесса (resume) первый Ready снова приглашение, хотя у прошлого были ходы', async () => {
    const { a, ref } = await started();
    a.terminalSignal(ref, WORKING);
    a.terminalSignal(ref, READY);
    expect(a.get(ref)?.activity.activity).toBe('unseen');

    a.terminalStarted(ref);
    a.terminalSignal(ref, READY);
    expect(a.get(ref)?.activity.activity).toBe('idle');
    expect(a.get(ref)?.activity.lastEventAt).not.toBeNull();
  });

  it('lastEventAt — момент известного сигнала: по нему pty.send и будильник знают, что хост «в курсе»', async () => {
    const before = Date.now();
    const { a, ref } = await started();
    expect(hookedSince(a.get(ref)?.activity, before)).toBe(false);

    a.terminalSignal(ref, READY);
    expect(hookedSince(a.get(ref)?.activity, before)).toBe(true);
  });

  it('сигнал claude-сессии терминалом не считается: ссылка на сессию без состояния — пусто', async () => {
    const { ref } = await codexSession({ provider: 'claude' });
    const w = await works();
    const a = activity(w);
    await a.start();
    await settle(100);
    a.terminalSignal(ref, WORKING);
    expect(a.get(ref)?.activity.activity).toBe('idle');
  });
});

describe('экраны старта codex — «нужен ты» с причиной', () => {
  it('нет ни Ready, ни Working за срок — blocked и одно уведомление startup-wait', async () => {
    const { a, ref } = await started({ startupWaitMs: 150 });
    expect(a.get(ref)?.activity.activity).toBe('idle');

    await waitFor(() => a.get(ref)?.activity.activity === 'blocked');
    expect(a.get(ref)?.activity.need).toMatchObject({ kind: 'startup', detail: null });
    expect(notices('startup-wait')).toHaveLength(1);
    expect(notices('startup-wait')[0]).toMatchObject({ kind: 'startup-wait', ref });
    expect(String(notices('startup-wait')[0]?.['text'])).toMatch(
      /^S\d+ has not shown a status since launch — it may be waiting for sign-in or folder trust in the Codex terminal$/,
    );

    // Повторных уведомлений нет.
    await settle(400);
    expect(notices('startup-wait')).toHaveLength(1);
  }, 20_000);

  it('Ready пришёл в срок — ни blocked, ни уведомления', async () => {
    const { a, ref } = await started({ startupWaitMs: 300 });
    a.terminalSignal(ref, READY);
    await settle(600);
    expect(a.get(ref)?.activity.activity).toBe('idle');
    expect(a.get(ref)?.activity.lastEventAt).not.toBeNull();
    expect(notices('startup-wait')).toHaveLength(0);
  }, 20_000);

  it('Working в срок — тоже снимает ожидание', async () => {
    const { a, ref } = await started({ startupWaitMs: 200 });
    a.terminalSignal(ref, WORKING);
    await settle(500);
    expect(a.get(ref)?.activity.activity).toBe('working');
    expect(notices('startup-wait')).toHaveLength(0);
  }, 20_000);

  it('после экрана старта человек прошёл доверие — Ready снимает blocked: агент у приглашения, ход не кончался', async () => {
    const { a, ref } = await started({ startupWaitMs: 100 });
    await waitFor(() => a.get(ref)?.activity.activity === 'blocked');

    a.terminalSignal(ref, READY);
    expect(a.get(ref)?.activity.activity).toBe('idle');
    expect(a.get(ref)?.activity.need).toBeNull();
    expect(changes(ref)).not.toContain('unseen');
  }, 20_000);

  it('незнакомые заголовки срок не снимают: их «неизвестно» — это и есть экран, которого не узнали', async () => {
    const { a, ref } = await started({ startupWaitMs: 150 });
    a.terminalSignal(ref, { kind: 'unknown', source: 'title' });
    await waitFor(() => a.get(ref)?.activity.activity === 'blocked');
  }, 20_000);

  it('процесс вышел до срока — таймер снят, уведомления нет', async () => {
    const { a, ref } = await started({ startupWaitMs: 150 });
    a.terminalStopped(ref);
    await settle(400);
    expect(notices('startup-wait')).toHaveLength(0);
    expect(a.get(ref)?.activity.activity).toBe('idle');
  }, 20_000);

  it('перезапуск процесса заводит срок заново', async () => {
    const { a, ref } = await started({ startupWaitMs: 500 });
    await settle(300);
    a.terminalStarted(ref);
    await settle(300);
    // С первого запуска прошло больше срока (около 700 мс при 500), со второго — 300: срок не вышел.
    expect(notices('startup-wait')).toHaveLength(0);
    await waitFor(() => notices('startup-wait').length === 1);
  }, 20_000);

  it('остановка сервиса снимает таймеры срока', async () => {
    const { a, ref } = await started({ startupWaitMs: 150 });
    await a.stop();
    await settle(400);
    expect(notices('startup-wait')).toHaveLength(0);
    void ref;
  }, 20_000);
});

describe('need у codex: причина ожидания человека (спека «Застрявшие сессии», 3.2)', () => {
  it('поток STUB_APPROVAL (OSC 9, затем заголовок) — approval с командой; мигание заголовка вид не понижает', async () => {
    const { a, ref } = await started();
    a.terminalSignal(ref, WORKING);
    a.terminalSignal(ref, APPROVAL);
    a.terminalSignal(ref, ACTION);

    expect(a.get(ref)?.activity.activity).toBe('blocked');
    const need = a.get(ref)?.activity.need;
    expect(need).toMatchObject({
      kind: 'approval',
      detail: 'ls -la',
      resetsAt: null,
      window: null,
      account: null,
    });

    // Заголовок мигает, пока Codex ждёт человека: ни вид, ни начало эпизода не меняются.
    await settle(30);
    a.terminalSignal(ref, ACTION);
    expect(a.get(ref)?.activity.need).toEqual(need);

    // Ответили: кадр спиннера снимает ожидание.
    a.terminalSignal(ref, WORKING);
    expect(a.get(ref)?.activity.need).toBeNull();
  });

  it('один заголовок Action Required — question без текста', async () => {
    const { a, ref } = await started();
    a.terminalSignal(ref, WORKING);
    a.terminalSignal(ref, ACTION);

    expect(a.get(ref)?.activity.activity).toBe('blocked');
    expect(a.get(ref)?.activity.need).toMatchObject({ kind: 'question', detail: null });
  });

  it('заголовок, затем OSC 9 об одобрении — approval с прежним since', async () => {
    const { a, ref } = await started();
    a.terminalSignal(ref, WORKING);
    a.terminalSignal(ref, ACTION);
    const question = a.get(ref)?.activity.need;
    expect(question?.kind).toBe('question');

    await settle(30);
    a.terminalSignal(ref, APPROVAL);
    expect(a.get(ref)?.activity.need).toMatchObject({
      kind: 'approval',
      detail: 'ls -la',
      since: question?.since,
    });
  });
});

describe('need у codex: лимит и вход из rollout (спека «Застрявшие сессии», 3.2)', () => {
  // Настоящая форма записи: `error` лежит в самом `task_complete` (core/codex/codex.test.ts).
  const LIMIT_TEXT =
    "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at Jan 5th, 2031 7:27 PM.";
  const AUTH_TEXT = 'Your access token could not be refreshed. Please log out and sign in again.';

  /** Rollout сессии `thread`, ход которой кончился ошибкой Codex в момент `at`. */
  async function failedRollout(
    thread: string,
    at: string,
    error: { message: string; codex_error_info: unknown },
  ): Promise<void> {
    const dir = path.join(codexRoot, '2026', '10', '13');
    await mkdir(dir, { recursive: true });
    const line = (timestamp: string, type: string, payload: Record<string, unknown>): string =>
      `${JSON.stringify({ timestamp, type, payload })}\n`;
    await writeFile(
      path.join(dir, `rollout-2026-10-13T10-00-00-${thread}.jsonl`),
      line(at, 'session_meta', { id: thread, cwd: project, source: 'cli' }) +
        line(at, 'event_msg', { type: 'task_started', turn_id: 't1' }) +
        line(at, 'event_msg', {
          type: 'task_complete',
          turn_id: 't1',
          last_agent_message: null,
          error,
        }),
    );
  }

  it('usage_limit_exceeded, а следом Ready — limit с временем из «try again at»; новый ход его снимает', async () => {
    const { a, ref } = await started({}, { providerSessionId: 'rollout-limit' });
    a.terminalSignal(ref, WORKING);
    await settle(40);
    const at = new Date().toISOString();
    await failedRollout('rollout-limit', at, {
      message: LIMIT_TEXT,
      codex_error_info: 'usage_limit_exceeded',
    });
    await waitFor(() => a.get(ref)?.activity.need?.kind === 'limit');

    // Codex пишет заголовок Ready сразу за ошибкой: конец хода от терминала новее ошибки и её не теряет.
    await settle(30);
    a.terminalSignal(ref, READY);
    expect(a.get(ref)?.activity.activity).toBe('unseen');
    expect(a.get(ref)?.activity.need).toEqual({
      kind: 'limit',
      since: at,
      detail: LIMIT_TEXT,
      // Пояс — машины хоста: время без привязки к поясу тест строит от него же.
      resetsAt: new Date(2031, 0, 5, 19, 27).toISOString(),
      window: null,
      account: null,
    });

    // Ход кончен и просмотрен — лимит остаётся: ждёт он человека, а не просмотра.
    a.markSeen(ref);
    expect(a.get(ref)?.activity.activity).toBe('idle');
    expect(a.get(ref)?.activity.need?.kind).toBe('limit');

    a.terminalSignal(ref, WORKING);
    expect(a.get(ref)?.activity.need).toBeNull();
  }, 20_000);

  it('unauthorized — sign-in (вход)', async () => {
    const { a, ref } = await started({}, { providerSessionId: 'rollout-auth' });
    a.terminalSignal(ref, WORKING);
    await settle(40);
    await failedRollout('rollout-auth', new Date().toISOString(), {
      message: AUTH_TEXT,
      codex_error_info: 'unauthorized',
    });
    await waitFor(() => a.get(ref)?.activity.need?.kind === 'sign-in');

    await settle(30);
    a.terminalSignal(ref, READY);
    expect(a.get(ref)?.activity.need).toMatchObject({
      kind: 'sign-in',
      account: 'auth',
      detail: AUTH_TEXT,
      resetsAt: null,
    });
  }, 20_000);

  it('ошибка, которую Codex повторяет сам (rate_limit_exceeded), need не даёт', async () => {
    const { a, ref } = await started({}, { providerSessionId: 'rollout-retry' });
    a.terminalSignal(ref, WORKING);
    await settle(40);
    await failedRollout('rollout-retry', new Date().toISOString(), {
      message: 'Rate limit reached, retrying',
      codex_error_info: 'rate_limit_exceeded',
    });
    // Конец хода по rollout виден как `Stop`: сессия не работает, а need нет.
    await waitFor(() => a.get(ref)?.activity.activity === 'unseen');
    expect(a.get(ref)?.activity.need).toBeNull();
  }, 20_000);

  it('новый процесс (resume) ошибку прошлого не наследует', async () => {
    const { a, ref } = await started({}, { providerSessionId: 'rollout-resume' });
    a.terminalSignal(ref, WORKING);
    await settle(40);
    await failedRollout('rollout-resume', new Date().toISOString(), {
      message: LIMIT_TEXT,
      codex_error_info: 'usage_limit_exceeded',
    });
    await waitFor(() => a.get(ref)?.activity.need?.kind === 'limit');

    await settle(30);
    a.terminalStarted(ref);
    a.terminalSignal(ref, READY);
    expect(a.get(ref)?.activity.activity).toBe('idle');
    expect(a.get(ref)?.activity.need).toBeNull();
  }, 20_000);
});

describe('у codex нет хуков — предупреждений о них нет', () => {
  it('hooks-missing и trust-wait для сессии codex не приходят, хотя журнала нет', async () => {
    const { ref } = await codexSession();
    const w = await works();
    const a = activity(w, { trustWaitMs: 100 });
    await a.start();
    a.terminalStarted(ref);
    a.terminalSignal(ref, READY);
    await settle(500);

    expect(notices('hooks-missing')).toHaveLength(0);
    expect(notices('trust-wait')).toHaveLength(0);
  }, 20_000);

  it('и без процесса под хостом (запущена не им) — сессия codex без журнала не «сломанные хуки»', async () => {
    await codexSession();
    const w = await works();
    const a = activity(w);
    await a.start();
    await settle(300);
    expect(notices('hooks-missing')).toHaveLength(0);
  }, 20_000);
});

describe('startupWaitFromEnv — рычаг E2E', () => {
  it('целое от 100 мс до десяти минут принимается', () => {
    expect(startupWaitFromEnv({ PARLEY_CODEX_STARTUP_MS: '1500' })).toBe(1500);
    expect(startupWaitFromEnv({ PARLEY_CODEX_STARTUP_MS: ' 100 ' })).toBe(100);
    expect(startupWaitFromEnv({ PARLEY_CODEX_STARTUP_MS: '600000' })).toBe(600_000);
  });

  it('прежнее имя HARNAS_CODEX_STARTUP_MS читается как запасное; PARLEY_* главнее; пустое новое не перекрывает', () => {
    expect(startupWaitFromEnv({ HARNAS_CODEX_STARTUP_MS: '1500' })).toBe(1500);
    expect(startupWaitFromEnv({ PARLEY_CODEX_STARTUP_MS: '200', HARNAS_CODEX_STARTUP_MS: '1500' })).toBe(200);
    expect(startupWaitFromEnv({ PARLEY_CODEX_STARTUP_MS: '', HARNAS_CODEX_STARTUP_MS: '1500' })).toBe(1500);
  });

  it('нет переменной, пустая, не число, дробная, слишком малая или большая — игнорируется', () => {
    for (const value of [undefined, '', ' ', 'много', '1.5', '99', '600001', '-5']) {
      expect(
        startupWaitFromEnv(value === undefined ? {} : { PARLEY_CODEX_STARTUP_MS: value }),
        String(value),
      ).toBeUndefined();
    }
  });
});

/**
 * Сторож Codex (разбор 2026-10-16): в code mode все инструменты, и чтение карты Parley тоже, идут через `exec`/`wait`.
 * Обычно такой вызов отвечает в пределах своего ожидания (`yield_time_ms`, по умолчанию около 30 с). Если в сессии
 * висит неотвеченный запрос к человеку (одобрение команды или MCP-инструмента), Codex держит вывод без срока, а
 * заголовок терминала показывает спиннер — сессия часами «работает». Вызов без вывода дольше ожидания и запаса —
 * «нужен ты» с причиной.
 */
describe('сторож Codex: вызов code mode без вывода — «нужен ты»', () => {
  const row = (record: unknown) => `${JSON.stringify(record)}\n`;
  const exec = (at: string, input: string, callId = 'call_exec') =>
    row({ timestamp: at, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input } });
  const execOutput = (at: string, callId = 'call_exec') =>
    row({ timestamp: at, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output: 'Script completed' } });
  const fn = (at: string, name: string, args: string, callId: string) =>
    row({ timestamp: at, type: 'response_item', payload: { type: 'function_call', name, call_id: callId, arguments: args } });
  const now = () => new Date().toISOString();

  async function rollout(id: string, body: string, at = now()): Promise<string> {
    const dir = path.join(codexRoot, '2026', '10', '16');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-10-16T10-00-00-${id}.jsonl`);
    await writeFile(
      file,
      row({ timestamp: at, type: 'session_meta', payload: { id, cwd: project, source: 'cli' } }) +
        row({ timestamp: at, type: 'event_msg', payload: { type: 'task_started' } }) +
        body,
    );
    return file;
  }

  const STUCK_TEXT =
    /^S\d+ has not returned from a Codex tool call\. Check pending approvals; if already answered, stop the stuck operation and verify its effects before retrying\.$/;

  it('s21: a completed turn with a yielded cell needs attention until the cell finishes', async () => {
    const { a, ref } = await started({ codexCallGraceMs: 150 }, { providerSessionId: 'yielded-cell' });
    a.terminalSignal(ref, WORKING);
    const stamp = now();
    const file = await rollout('yielded-cell', exec(stamp, 'text(await tools.exec_command({cmd:"git fetch"}));') +
      row({ timestamp: stamp, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_exec', output: 'Script running with cell ID 58\nOutput:\n' } }) +
      row({ timestamp: stamp, type: 'event_msg', payload: { type: 'task_complete' } }));
    await waitFor(() => a.get(ref)?.activity.activity === 'blocked');
    expect(notices('codex-call-wait')).toHaveLength(1);
    expect(String(notices('codex-call-wait')[0]?.['text'])).toContain('finished its turn with an unfinished tool operation');
    await settle(400);
    expect(notices('codex-call-wait')).toHaveLength(1);
    await appendFile(file, fn(now(), 'wait', '{"cell_id":"58"}', 'finish') +
      row({ timestamp: now(), type: 'response_item', payload: { type: 'function_call_output', call_id: 'finish', output: 'Script completed\nOutput:\n' } }));
    await waitFor(() => a.get(ref)?.activity.activity !== 'blocked');
  }, 15_000);

  it('a yielded cell in an active turn does not trigger the finished-turn alert', async () => {
    const { a, ref } = await started({ codexCallGraceMs: 150 }, { providerSessionId: 'active-cell' });
    a.terminalSignal(ref, WORKING);
    const stamp = now();
    await rollout('active-cell', exec(stamp, 'text(await tools.exec_command({cmd:"pnpm test"}));') +
      row({ timestamp: stamp, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_exec', output: 'Script running with cell ID 58\nOutput:\n' } }));
    await settle(700);
    expect(a.get(ref)?.activity.activity).toBe('working');
    expect(notices('codex-call-wait')).toHaveLength(0);
  }, 15_000);

  it('exec без вывода дольше ожидания и запаса — blocked и одно уведомление codex-call-wait; вывод возвращает working', async () => {
    const { a, ref } = await started({ codexCallGraceMs: 150 }, { providerSessionId: 'stuck-exec' });
    a.terminalSignal(ref, WORKING);
    const file = await rollout(
      'stuck-exec',
      exec(now(), '// @exec: {"yield_time_ms": 1}\ntext(await tools.mcp__parley__check_inbox({}));'),
    );

    await waitFor(() => a.get(ref)?.activity.activity === 'blocked');
    expect(notices('codex-call-wait')).toHaveLength(1);
    expect(notices('codex-call-wait')[0]).toMatchObject({ kind: 'codex-call-wait', ref });
    expect(String(notices('codex-call-wait')[0]?.['text'])).toMatch(STUCK_TEXT);

    // Повторных уведомлений о том же вызове нет.
    await settle(400);
    expect(notices('codex-call-wait')).toHaveLength(1);
    expect(a.get(ref)?.activity.activity).toBe('blocked');

    // Человек ответил в терминале — вывод пришёл, ход снова идёт.
    await appendFile(file, execOutput(now()));
    await waitFor(() => a.get(ref)?.activity.activity === 'working');
    expect(notices('codex-call-wait')).toHaveLength(1);
  }, 15_000);

  it('до срока — working без уведомления; явное ожидание ячейки срок продлевает', async () => {
    const { a, ref } = await started({ codexCallGraceMs: 150 }, { providerSessionId: 'long-yield' });
    a.terminalSignal(ref, WORKING);
    await rollout('long-yield', exec(now(), '// @exec: {"yield_time_ms": 60000}\ntext(await tools.exec_command({cmd:"pnpm test"}));'));
    await settle(700);
    expect(a.get(ref)?.activity.activity).toBe('working');
    expect(notices('codex-call-wait')).toHaveLength(0);
  }, 15_000);

  it('без прагмы ожидание по умолчанию — 30 с: за полсекунды сторож не срабатывает', async () => {
    const { a, ref } = await started({ codexCallGraceMs: 150 }, { providerSessionId: 'default-yield' });
    a.terminalSignal(ref, WORKING);
    await rollout('default-yield', exec(now(), 'text(await tools.mcp__parley__get_map({}));'));
    await settle(700);
    expect(a.get(ref)?.activity.activity).toBe('working');
    expect(notices('codex-call-wait')).toHaveLength(0);
  }, 15_000);

  it('wait (function_call) без вывода сторожится так же', async () => {
    const { a, ref } = await started({ codexCallGraceMs: 150 }, { providerSessionId: 'stuck-wait' });
    a.terminalSignal(ref, WORKING);
    await rollout('stuck-wait', fn(now(), 'wait', '{"cell_id":"41","yield_time_ms":1}', 'call_wait'));
    await waitFor(() => a.get(ref)?.activity.activity === 'blocked');
    expect(notices('codex-call-wait')).toHaveLength(1);
  }, 15_000);

  it('прочие вызовы без вывода не сторожатся: MCP напрямую (wait_for ждёт до получаса), shell', async () => {
    const { a, ref } = await started({ codexCallGraceMs: 150 }, { providerSessionId: 'not-code-mode' });
    a.terminalSignal(ref, WORKING);
    await rollout(
      'not-code-mode',
      fn(now(), 'mcp__parley__wait_for', '{"target":"inbox"}', 'c1') + fn(now(), 'shell_command', '{}', 'c2'),
    );
    await settle(700);
    expect(a.get(ref)?.activity.activity).toBe('working');
    expect(notices('codex-call-wait')).toHaveLength(0);
  }, 15_000);

  it('«нужен ты» от терминала не дублируется уведомлением сторожа, пока терминал сам говорит Action Required', async () => {
    const { a, ref } = await started({ codexCallGraceMs: 150 }, { providerSessionId: 'action-required' });
    // Ход и вызов в rollout — раньше окна одобрения в терминале, как в жизни: `task_started` не старше сигнала (в ту же
    // миллисекунду тоже) `eventsFor` считает новым ходом и вернул бы working.
    const before = new Date(Date.now() - 1000).toISOString();
    await rollout(
      'action-required',
      exec(before, '// @exec: {"yield_time_ms": 1}\ntext(await tools.mcp__parley__check_inbox({}));'),
      before,
    );
    a.terminalSignal(ref, ACTION);
    await settle(700);
    expect(a.get(ref)?.activity.activity).toBe('blocked');
    expect(notices('codex-call-wait')).toHaveLength(0);
  }, 15_000);

  // Служебная запись в rollout после конца хода: пересчёт сессии без новых событий хода.
  const tokenCount = () => row({ timestamp: now(), type: 'event_msg', payload: { type: 'token_count' } });

  it('a stuck call yields an approval need: since is the call time and does not move on recompute, detail is neutral', async () => {
    const { a, ref } = await started({ codexCallGraceMs: 150 }, { providerSessionId: 'stuck-need' });
    a.terminalSignal(ref, WORKING);
    const callAt = now();
    const file = await rollout(
      'stuck-need',
      exec(callAt, '// @exec: {"yield_time_ms": 1}\ntext(await tools.mcp__parley__check_inbox({}));'),
      callAt,
    );

    await waitFor(() => a.get(ref)?.activity.activity === 'blocked');
    // Инструкция («Check pending approvals…») — только в уведомлении хоста; в `detail` она попала бы в строку комнаты и
    // письмо ведущему, и агент мог бы принять её за свою (итоговое ревью, находка 6).
    expect(String(notices('codex-call-wait')[0]?.['text'])).toMatch(STUCK_TEXT);
    expect(a.get(ref)?.activity.need).toEqual({
      kind: 'approval',
      since: callAt,
      detail: 'a Codex tool call has not returned',
      resetsAt: null,
      window: null,
      account: null,
    });

    // Пересчёт позже: начало эпизода остаётся временем вызова.
    await appendFile(file, tokenCount());
    await settle(400);
    expect(a.get(ref)?.activity.need?.since).toBe(callAt);

    // Вывод пришёл — ход идёт, ожидания нет.
    await appendFile(file, execOutput(now()));
    await waitFor(() => a.get(ref)?.activity.activity === 'working');
    expect(a.get(ref)?.activity.need).toBeNull();
  }, 15_000);

  it('a finished turn with an unfinished cell yields an approval need with the cell time, not the time of each recompute', async () => {
    const { a, ref } = await started({ codexCallGraceMs: 150 }, { providerSessionId: 'cell-need' });
    a.terminalSignal(ref, WORKING);
    const stamp = now();
    const file = await rollout(
      'cell-need',
      exec(stamp, 'text(await tools.exec_command({cmd:"git fetch"}));') +
        row({ timestamp: stamp, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_exec', output: 'Script running with cell ID 58\nOutput:\n' } }) +
        row({ timestamp: stamp, type: 'event_msg', payload: { type: 'task_complete' } }),
      stamp,
    );

    await waitFor(() => a.get(ref)?.activity.activity === 'blocked');
    expect(String(notices('codex-call-wait')[0]?.['text'])).toContain('Check pending approvals; if already answered');
    expect(a.get(ref)?.activity.need).toEqual({
      kind: 'approval',
      since: stamp,
      detail: 'its turn finished with an unfinished tool operation',
      resetsAt: null,
      window: null,
      account: null,
    });

    // В этой ветке срок сторожа — «сейчас»: каждый пересчёт видит его заново, а начало эпизода не уезжает.
    await settle(300);
    await appendFile(file, tokenCount());
    await settle(300);
    expect(a.get(ref)?.activity.activity).toBe('blocked');
    expect(a.get(ref)?.activity.need?.since).toBe(stamp);
  }, 15_000);

  it('a stuck cell while the fold holds a limit need: the limit need stays, the watcher adds no approval', async () => {
    const limitText =
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at Jan 5th, 2031 7:27 PM.";
    const { a, ref } = await started({ codexCallGraceMs: 150 }, { providerSessionId: 'cell-limit' });
    a.terminalSignal(ref, WORKING);
    const stamp = now();
    await rollout(
      'cell-limit',
      exec(stamp, 'text(await tools.exec_command({cmd:"git fetch"}));') +
        row({ timestamp: stamp, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_exec', output: 'Script running with cell ID 58\nOutput:\n' } }) +
        row({
          timestamp: stamp,
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            last_agent_message: null,
            error: { message: limitText, codex_error_info: 'usage_limit_exceeded' },
          },
        }),
      stamp,
    );

    // Сторож сработал на том же пересчёте, что увидел ошибку лимита.
    await waitFor(() => notices('codex-call-wait').length === 1);
    await waitFor(() => a.get(ref)?.activity.need?.kind === 'limit');
    expect(a.get(ref)?.activity.need).toMatchObject({ kind: 'limit', since: stamp, detail: limitText });
    expect(a.get(ref)?.activity.activity).not.toBe('blocked');
    await settle(300);
    expect(a.get(ref)?.activity.need?.kind).toBe('limit');
  }, 15_000);
});
