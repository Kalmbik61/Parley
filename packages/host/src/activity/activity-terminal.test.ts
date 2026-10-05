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
const ACTION: CodexSignal = { kind: 'needs-you', reason: 'action-required' };
const APPROVAL: CodexSignal = { kind: 'needs-you', reason: 'approval-requested' };

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
    // Время события — mtime журнала, а `working` держится до mtime + порог по часам сервиса. С настоящими часами
    // и коротким порогом задержка чтения под нагрузкой могла перекрыть порог, и `working` было уже не застать.
    // Поэтому порог большой, а часы сервиса идут по-настоящему, но со смещением: сначала застаём `working`,
    // потом двигаем часы почти к порогу — дальше состояние меняет настоящий таймер тишины сервиса.
    const { workId, ref } = await codexSession({ eventsDir: true });
    const w = await works();
    const silenceThresholdMs = 30_000;
    let offset = 0;
    const a = activity(w, { silenceThresholdMs, now: () => Date.now() + offset });
    await a.start();
    const journal = path.join(workPaths(project, workId).events, `${ref.sessionId}.jsonl`);
    await appendFile(journal, `${JSON.stringify({ hook_event_name: 'UserPromptSubmit' })}\n`);

    // Событие дописано один раз: если fs-наблюдатель его потерял (он включается не мгновенно), журнал
    // перечитывается по записи карты.
    const until = async (check: () => boolean, redo: () => Promise<void>, everyMs: number): Promise<void> => {
      const started = Date.now();
      for (;;) {
        if (check()) return;
        if (Date.now() - started > 30_000) throw new Error('не дождались условия');
        await redo();
        await settle(everyMs);
      }
    };
    await until(
      () => a.get(ref)?.activity.activity === 'working',
      () => updateMap(project, workId, () => undefined),
      100,
    );

    // Часы — за 1,5 с до порога. Запись карты пересчитывает сессию и взводит таймер на оставшиеся 1,5 с;
    // дальше карту не трогаем дольше этого срока, и `unseen` ставит именно таймер тишины.
    const eventAt = (await stat(journal)).mtimeMs;
    offset = eventAt + silenceThresholdMs - 1500 - Date.now();
    await until(
      () => a.get(ref)?.activity.activity === 'unseen',
      () => updateMap(project, workId, () => undefined),
      4000,
    );
  }, 90_000);

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
