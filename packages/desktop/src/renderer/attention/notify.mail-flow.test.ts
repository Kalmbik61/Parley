/**
 * Письма событием `rooms.mail` от начала до уведомления на настоящих сторах (спека rooms.mail 6.5, 6.9): настоящий
 * стор работ и настоящий уведомитель (`wireAttentionNotifications`) на подставном мосте. Снимок без писем (версия 2),
 * событие с разрывом версии, страницы починки `context.messages` — и ровно одно уведомление. Звенья цепочки по
 * отдельности держат `works.test.ts` (стор на фикстурах версии 1) и `notify.test.ts` (уведомитель на подставном
 * `entries`), а цепочку целиком, где `withMail` ведёт карту версии 2 к уведомителю, закрывает этот файл.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, WindowWorkEntry } from '@parley/core';
import { ROOMS_MAIL_FEATURE, type WorksSnapshot } from '@parley/protocol';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { AudioContextStub } from '../test-utils/audio.js';
import { makeCompactMail, makeRoomNumbers, withCompactMail } from '../test-utils/compact-mail-fixtures.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeLetter, makeMailEvent, makeMailRoom, makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { openRoom, useRoomPagesStore } from '../store/room-pages.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { wireAttentionNotifications } from './notify.js';

const PROJECT = '/tmp/proj';
const WORK = 'w-01';
const ROOM = 'r-01';

/** Упоминание человека в комнате `r-01`: письмо от `s-02`. */
const mention = (id: string, text: string): Message => makeLetter(id, { roomId: ROOM, from: 's-02', to: [], text, readBy: {} });

/** Работа окна со снимком без писем: комната `r-01` с `top` и версия хоста; писем в карте окна нет. */
function snapshotWork(top: number, version: number): WindowWorkEntry {
  const base = makeWork(WORK, { projectPath: PROJECT, sessions: [makeSession('s-02', 'executor')], rooms: [makeRoom(ROOM, 'Mobile APP')] });
  const compact = makeCompactMail({
    rooms: { '': makeRoomNumbers(), [ROOM]: makeRoomNumbers({ total: top, top, lastAt: '2026-09-27T09:00:00.000Z' }) },
  });
  return { ...withCompactMail(base, compact), version };
}

const worksSnapshot = (revision: number, entry: WindowWorkEntry): WorksSnapshot => ({ entries: [entry], branches: {}, revision });

const page = (messages: Message[]) => ({ messages, page: { total: messages.length, returned: messages.length, complete: true, next: null, bytes: 1, cut: 0 } });

describe('rooms.mail на настоящих сторах работ и уведомлений (спека rooms.mail 6.5, 6.9)', () => {
  let bridge: FakeBridge;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    // Настоящий сигнал окна звонит и здесь; без подставного AudioContext jsdom печатал бы `chime failed`.
    vi.stubGlobal('AudioContext', AudioContextStub);
    bridge = createFakeBridge();
    useUiStore.setState({ ui: DEFAULT_UI, windowFocused: true, documentVisible: true });
    useWorksStore.setState({ entries: [], branches: {}, loading: true, ready: false, error: null });
    useRoomPagesStore.setState({ chains: {}, loading: {}, opened: {}, pending: {}, quotes: {} });
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    vi.unstubAllGlobals();
  });

  const heldIds = (): string[] => useWorksStore.getState().entries[0]!.map.messages.map((message) => message.id);
  const pageCalls = (): unknown[] => bridge.calls.filter((call) => call.method === 'context.messages').map((call) => call.params);

  /**
   * Окно подключено к хосту с признаком и получило снимок версии 5 (комната `r-01`, `top` 8). Уведомитель подписан до
   * снимка, как в `App`: первый снимок для него база. Комната `r-01` открыта: страница открытия кладёт в карту окна письма
   * m-07 и m-08 (`openRoom`, как у панели комнаты) — события держит только открытая комната.
   */
  async function started(): Promise<void> {
    bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: null, features: [ROOMS_MAIL_FEATURE] });
    bridge.setHandler('works.list', () => worksSnapshot(1, snapshotWork(8, 5)));
    cleanups.push(
      wireAttentionNotifications(bridge, {
        prefs: () => DEFAULT_UI.notifications,
        isTargetVisible: () => false,
        entries: () => useWorksStore.getState().entries,
      }),
    );
    cleanups.push(useWorksStore.getState().init(bridge));
    await vi.waitFor(() => expect(useWorksStore.getState().entries).toHaveLength(1));
    bridge.setHandler('context.messages', () => page([mention('m-07', 'old ping for @human'), mention('m-08', 'old ping for @human')]));
    await openRoom(bridge, useWorksStore.getState().entries[0]!, ROOM);
    expect(heldIds()).toEqual(['m-07', 'm-08']);
    // Первый снимок и письма, что окно уже держит, — база: ни одного уведомления.
    expect(bridge.appNotified).toEqual([]);
  }

  it('событие с разрывом версии: письмо события уведомляет сразу, страницы починки приносят пропущенное письмо молча — одно уведомление', async () => {
    await started();
    const opened = pageCalls().length;
    // Починка читает держимую комнату от вершины: m-09 пропущено (событие с версией 6-7 потеряно), m-10 пришло событием.
    bridge.setHandler('context.messages', () =>
      page([
        mention('m-07', 'old ping for @human'),
        mention('m-08', 'old ping for @human'),
        mention('m-09', 'missed ping for @human'),
        mention('m-10', 'newest ping for @human'),
      ]),
    );
    const arrive = makeMailEvent({
      projectPath: PROJECT,
      version: 8,
      prevVersion: 7,
      rooms: [makeMailRoom(ROOM, { prevTop: 9, top: 10, total: 10, lastAt: '2026-09-27T10:00:00.000Z', letters: [mention('m-10', 'newest ping for @human')] })],
      unread: { letters: 1, rooms: { '': 0, [ROOM]: 1 } },
    });

    bridge.emit('rooms.mail', arrive);
    // Событие применено и уведомило синхронно, починка ещё в пути.
    expect(bridge.appNotified).toHaveLength(1);
    await vi.waitFor(() => expect(heldIds()).toEqual(['m-07', 'm-08', 'm-09', 'm-10']));
    expect(pageCalls()).toHaveLength(opened + 1);

    // Письмо, пришедшее страницей, новее базы не стало: m-09 старше последнего применённого события — молчание.
    expect(bridge.appNotified).toHaveLength(1);
    expect(bridge.appNotified[0]).toMatchObject({
      title: 'S02 mentioned you in Mobile APP',
      body: 'newest ping for @you',
      tag: `mention:${PROJECT} ${WORK}:${ROOM}`,
      target: { kind: 'room', projectPath: PROJECT, workId: WORK, roomId: ROOM },
    });
    // Числа события стоят на карте окна.
    expect(useWorksStore.getState().entries[0]!.map.compact).toMatchObject({ version: 2, rooms: { [ROOM]: { total: 10, top: 10, unread: 1 } } });

    // Повтор того же события и следующий за починкой снимок письмо не уведомляют второй раз.
    bridge.emit('rooms.mail', arrive);
    bridge.emit('works.changed', worksSnapshot(2, snapshotWork(10, 9)));
    await vi.waitFor(() => expect(useWorksStore.getState().entries[0]!.version).toBe(9));
    expect(bridge.appNotified).toHaveLength(1);
    expect(pageCalls()).toHaveLength(opened + 1);

    // Починка уведомления не заглушила: следующее письмо по цепочке версий уведомляет, и страниц больше не просит.
    bridge.emit(
      'rooms.mail',
      makeMailEvent({
        projectPath: PROJECT,
        version: 10,
        prevVersion: 9,
        rooms: [makeMailRoom(ROOM, { prevTop: 10, top: 11, total: 11, letters: [mention('m-11', 'next ping for @human')] })],
        unread: { letters: 2, rooms: { '': 0, [ROOM]: 2 } },
      }),
    );
    expect(bridge.appNotified.map((note) => note.body)).toEqual(['newest ping for @you', 'next ping for @you']);
    expect(heldIds()).toEqual(['m-07', 'm-08', 'm-09', 'm-10', 'm-11']);
    expect(pageCalls()).toHaveLength(opened + 1);
  });
});
