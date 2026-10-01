/**
 * Будильник для codex (спека комнат Organic, 3.6, «Ввод»): указатель на письма уходит вставкой
 * (bracketed paste), через десятки миллисекунд — клавиша: Enter у приглашения, Tab занятому агенту
 * (очередь на следующий ход, а не вмешательство в ход). Настоящий codex не запускается: заглушка
 * печатает заголовки окна и то, какая клавиша до неё дошла (`enter:` / `tab:`).
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addMessage,
  addSession,
  createWork,
  transitionSession,
  updateMap,
  workPaths,
} from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import { linkTerminalActivity } from '../activity/terminal-link.js';
import { createActivityService } from '../activity/activity-service.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import { createPtyManager } from '../pty/pty-manager.js';
import type { PtyManager } from '../pty/pty-manager.js';
import { createWorksService } from '../works/works-service.js';
import { createWakeService } from './wake-service.js';
import type { WakeService, WakeServiceOptions } from './wake-service.js';

const CODEX_STUB = fileURLToPath(new URL('../../test/stub-codex.mjs', import.meta.url));

const POINTER = 'New messages (1). Call check_inbox.';

let home = '';
let project = '';
let claudeRoot = '';
let codexRoot = '';
let broadcasts: Array<{ event: EventName; data: unknown }>;
let stoppers: Array<() => Promise<void> | void> = [];

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
  for (const stop of stoppers) await stop();
  stoppers = [];
  delete process.env['PARLEY_HOME'];
  await Promise.all(
    [home, project, claudeRoot, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const waitFor = async (check: () => boolean, timeoutMs = 8000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались условия');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Первый `Ready` заглушки — агент у приглашения (не конец хода): состояние тусклое, но хост «в курсе»
 * (`lastEventAt`), и указатель можно печатать.
 */
const known = (activity: ActivityService, ref: SessionRef): boolean =>
  activity.get(ref)?.activity.lastEventAt != null;

interface Rig {
  ref: SessionRef;
  workId: string;
  pty: PtyManager;
  activity: ActivityService;
  wake: WakeService;
  /** Всё, что процесс напечатал в терминал. */
  stream: () => string;
  letter: (text?: string) => Promise<void>;
  notices: (kind: string) => number;
}

/** Работа с активной сессией codex, реальный PTY с заглушкой, активность по терминалу и будильник. */
async function rig(
  launchEnv: NodeJS.ProcessEnv = {},
  wakeOptions: WakeServiceOptions = {},
): Promise<Rig> {
  const map = await createWork(project, { title: 'Работа' });
  let sessionId = '';
  await updateMap(project, map.work.id, (current) => {
    const created = addSession(current, { provider: 'codex', label: 'кодекс', task: 'сделать' });
    sessionId = created.id;
    created.launchedBy = 'host';
    transitionSession(current, created.id, 'active');
  });
  const ref: SessionRef = { projectPath: project, workId: map.work.id, sessionId };
  await mkdir(workPaths(project, map.work.id).events, { recursive: true });

  const host = fakeHost();
  const works = createWorksService(host, { debounceMs: 20 });
  const activity = createActivityService(host, works, {
    silenceThresholdMs: 30_000,
    startupWaitMs: 60_000,
    claudeRoot,
    codexRoot,
  });
  const pty = createPtyManager(host);
  const unlink = linkTerminalActivity(pty, activity);
  const wake = createWakeService(
    host,
    works,
    activity,
    pty,
    { launch: async () => {} },
    {
      enterDelayMs: 500,
      pointerTimeoutMs: 700,
      ...wakeOptions,
    },
  );
  await works.start();
  await activity.start();
  wake.start();

  let stream = '';
  pty.on('output', (_ref, data) => {
    stream += data;
  });
  pty.start(ref, {
    command: process.execPath,
    args: [CODEX_STUB],
    cwd: project,
    env: {
      ...process.env,
      PARLEY_WORK_DIR: path.join(project, '.parley', 'works', map.work.id),
      PARLEY_SESSION_ID: sessionId,
      ...launchEnv,
    },
    provider: 'codex',
  });
  stoppers.push(async () => {
    unlink();
    await pty.stop(ref, { graceMs: 200 }).catch(() => {});
    wake.stop();
    await activity.stop();
    await works.stop();
  });
  await waitFor(() => stream.includes('stub-codex готов'));

  return {
    ref,
    workId: map.work.id,
    pty,
    activity,
    wake,
    stream: () => stream,
    letter: (text = 'тело письма — секрет') =>
      updateMap(project, map.work.id, (current) => {
        addMessage(current, { from: 's-00', to: [sessionId], text });
      }).then(() => undefined),
    notices: (kind) =>
      broadcasts.filter(
        (entry) => entry.event === 'host.notice' && (entry.data as { kind: string }).kind === kind,
      ).length,
  };
}

describe('будильник и codex', () => {
  it('у приглашения: указатель вставкой, через десятки мс — Enter (не Tab, не 500 мс)', async () => {
    const { ref, activity, stream, letter } = await rig();
    await waitFor(() => known(activity, ref));

    const sent = Date.now();
    await letter();
    await waitFor(() => stream().includes(`paste: ${POINTER}`), 5000);
    await waitFor(() => stream().includes(`enter: ${POINTER}`), 5000);

    expect(stream()).not.toContain(`tab: ${POINTER}`);
    // Тело письма не течёт в терминал: только указатель.
    expect(stream()).not.toContain('секрет');
    // Пауза десятки мс, а не полсекунды будильника: от письма до Enter укладывается в разумные полсекунды
    // с запасом на поиск карты и запуск заглушки.
    expect(Date.now() - sent).toBeLessThan(4000);
  }, 30_000);

  it('пауза между вставкой и Enter — CODEX_SUBMIT_DELAY_MS, а не enterDelayMs будильника', async () => {
    // enterDelayMs будильника — 5 секунд: если бы codex ждал его, Enter в срок теста не пришёл бы.
    const { ref, activity, stream, letter } = await rig({}, { enterDelayMs: 5000 });
    await waitFor(() => known(activity, ref));

    await letter();
    await waitFor(() => stream().includes(`enter: ${POINTER}`), 3000);
  }, 30_000);

  it('агент работает — указатель уходит в очередь Tab, ход не прерывается и ждать конца хода не нужно', async () => {
    const { ref, pty, activity, stream, letter, notices } = await rig();
    await waitFor(() => known(activity, ref));
    pty.input(ref, 'STUB_WORK\r');
    await waitFor(() => activity.get(ref)?.activity.activity === 'working');

    await letter();
    await waitFor(() => stream().includes(`tab: ${POINTER}`), 5000);
    expect(stream()).not.toContain(`enter: ${POINTER}`);

    // Указатель ушёл в очередь, а не в ход: предохранитель «ход не начался» не срабатывает.
    await settle(1200);
    expect(notices('pointer-timeout')).toBe(0);
    // Письма помечены указанными: второго указателя нет.
    expect(stream().split(`tab: ${POINTER}`).length - 1).toBe(1);
    // Агент всё это время работал.
    expect(activity.get(ref)?.activity.activity).toBe('working');
  }, 30_000);

  it('режима вставки ещё нет — указатель не печатается, а с появлением режима уходит сам', async () => {
    // Заголовок Ready уже есть (хост «в курсе»), а bracketed paste заглушка включает позже: без режима
    // вставки маркеры ушли бы в поле ввода знаками. Отказа, как у pty.send, будильнику вернуть некому —
    // пересчёт повторяется сам, пока режим не появится.
    // Режим появляется через 1,8 с — раньше конца бюджета повторов (15 × 200 мс), но с запасом над проверкой ниже.
    const { ref, activity, stream, letter } = await rig({ STUB_CODEX_PASTE_MS: '1800' });
    await waitFor(() => known(activity, ref));

    await letter();
    await settle(600);
    expect(stream()).not.toContain('paste:');

    await waitFor(() => stream().includes(`paste: ${POINTER}`), 5000);
    await waitFor(() => stream().includes(`enter: ${POINTER}`), 5000);
    // Один указатель, а не по одному на каждый повтор.
    expect(stream().split(`paste: ${POINTER}`).length - 1).toBe(1);
  }, 30_000);

  it('режима вставки нет вовсе — ничего не печатается, повторы не бесконечны', async () => {
    const { ref, activity, stream, letter } = await rig({ STUB_CODEX_NO_PASTE: '1' });
    await waitFor(() => known(activity, ref));

    await letter();
    await settle(1500);
    expect(stream()).not.toContain('paste:');
    expect(stream()).not.toContain('enter:');
    expect(stream()).not.toContain('tab:');
  }, 30_000);

  it('вопрос человеку (Action Required) — не печатает ничего: ни вставки, ни Tab', async () => {
    const { ref, pty, activity, stream, letter } = await rig();
    await waitFor(() => known(activity, ref));
    pty.input(ref, 'STUB_APPROVAL\r');
    await waitFor(() => activity.get(ref)?.activity.activity === 'blocked');

    await letter();
    await settle(1000);
    expect(stream()).not.toContain('paste:');
    expect(stream()).not.toContain(`tab: ${POINTER}`);
    expect(stream()).not.toContain(`enter: ${POINTER}`);
  }, 30_000);

  it('экран старта (ни одного заголовка) — ничего не печатает: Enter подтвердил бы доверие к папке', async () => {
    const { letter, stream } = await rig({ STUB_CODEX_NO_TITLE: '1' });
    await letter();
    await settle(1200);
    expect(stream()).not.toContain('paste:');
    expect(stream()).not.toContain('enter:');
    expect(stream()).not.toContain('tab:');
  }, 30_000);

  it('после хода письмо доходит как обычно: работа → Ready → письмо → Enter', async () => {
    const { ref, pty, activity, stream, letter } = await rig();
    await waitFor(() => known(activity, ref));
    pty.input(ref, 'STUB_WORK\r');
    await waitFor(() => activity.get(ref)?.activity.activity === 'working');
    pty.input(ref, 'STUB_READY\r');
    await waitFor(() => activity.get(ref)?.activity.activity === 'unseen');

    await letter();
    await waitFor(() => stream().includes(`enter: ${POINTER}`), 5000);
    expect(stream()).not.toContain(`tab: ${POINTER}`);
  }, 30_000);

  it('черновик человека — ничего не печатается поверх', async () => {
    const { ref, pty, activity, stream, letter } = await rig();
    await waitFor(() => known(activity, ref));
    pty.input(ref, 'набираю сам');
    await letter();
    await settle(1000);
    expect(stream()).not.toContain('paste:');
  }, 30_000);

  it('указатель в комнате: название с токеном на конце не мешает — текст кончается словом', async () => {
    const { ref, activity, stream, workId } = await rig();
    await waitFor(() => known(activity, ref));
    await updateMap(project, workId, (current) => {
      current.rooms.push({
        id: 'r-01',
        title: 'Ревью @файл',
        creator: 's-00',
        members: [ref.sessionId],
        createdAt: new Date().toISOString(),
        lead: null,
        proposal: null,
      });
      addMessage(current, { from: 's-00', to: [ref.sessionId], text: 'x', roomId: 'r-01' });
    });
    await waitFor(() => stream().includes('enter: New messages (1) in r-01'), 5000);
  }, 30_000);
});
