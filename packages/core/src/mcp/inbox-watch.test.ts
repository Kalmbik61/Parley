import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMessage, addSession } from '../work/map.js';
import { createWork, readMap, updateMap, workPaths } from '../work/store.js';
import type { MessageKind } from '../work/types.js';
import { watchInbox, type Ring } from './inbox-watch.js';

/**
 * Крючок на чтение карты: работу сносят живьём (префикс `D`), и `readMap`
 * бросает прямо посреди захода сторожа. Подмена ставит этот случай без гонки с
 * файловой системой — бросаем на первом чтении, которое видит письмо.
 */
const hooks = vi.hoisted(() => ({ breakOnce: false }));

vi.mock('../work/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../work/store.js')>();
  return {
    ...actual,
    readMap: async (projectPath: string, id: string) => {
      const map = await actual.readMap(projectPath, id);
      if (!hooks.breakOnce) return map;
      if (
        !map.messages.some(
          (message) => message.to.includes('s-02') && message.readBy['s-02'] === undefined,
        )
      ) {
        return map;
      }
      hooks.breakOnce = false;
      throw new Error('карта исчезла');
    },
  };
});

let project = '';
let workId = '';

/** Сторожа афтерхук гасит сам: иначе он пережил бы тест вместе с картой. */
const stops: (() => void)[] = [];

const contextFor = (sessionId: string) => ({
  projectPath: project,
  workId,
  workDir: workPaths(project, workId).dir,
  sessionId,
  channel: true,
});

function start(sessionId: string, notify: (ring: Ring) => Promise<void>): () => void {
  const stop = watchInbox(contextFor(sessionId), { notify, pollMs: 20, waitMs: 500 });
  stops.push(stop);
  return stop;
}

async function letter(to: string, text: string, kind: MessageKind = 'note'): Promise<void> {
  await updateMap(project, workId, (map) => {
    addMessage(map, { from: 's-01', to: [to], text, kind });
  });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const settle = (check: () => void): Promise<void> =>
  vi.waitFor(check, { timeout: 2000, interval: 10 });

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  const map = await createWork(project, { title: 'Авторизация', goal: 'логин по паролю' });
  workId = map.work.id;
  await updateMap(project, workId, (current) => {
    addSession(current, { provider: 'claude', label: 'план', task: 'составить план' });
    addSession(current, { provider: 'claude', label: 'бэк', task: 'делать' });
  });
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  hooks.breakOnce = false;
  await rm(project, { recursive: true, force: true });
});

describe('watchInbox', () => {
  it('звонит один раз про непрочитанное письмо и карту не трогает', async () => {
    const rings: Ring[] = [];
    start('s-02', async (ring) => {
      rings.push(ring);
    });
    await letter('s-02', 'где лежит миграция users?', 'question');

    await settle(() => expect(rings).toHaveLength(1));
    const ring = rings[0] as Ring;
    // Звонок — не доставка: текста письма в нём нет, есть отправитель и вид.
    expect(ring.content).not.toContain('миграция');
    expect(ring.content).toContain('план');
    expect(ring.content).toContain('check_inbox');
    expect(ring.meta).toEqual({
      message_id: 'm-01',
      from: 's-01',
      from_label: 'план',
      kind: 'question',
      unread: '1',
    });

    // Письмо забирает агент, а не сторож: `readBy` остаётся пустым, второго
    // звонка про то же письмо нет.
    expect((await readMap(project, workId)).messages[0]?.readBy).toEqual({});
    await delay(150);
    expect(rings).toHaveLength(1);
  });

  it('письмо, лежавшее в карте до старта, звонит', async () => {
    await letter('s-02', 'привет');
    const rings: Ring[] = [];
    start('s-02', async (ring) => {
      rings.push(ring);
    });

    await settle(() => expect(rings).toHaveLength(1));
    expect(rings[0]?.meta['kind']).toBe('note');
  });

  it('звонок говорит, сколько писем заберёт один check_inbox', async () => {
    await updateMap(project, workId, (map) => {
      addMessage(map, { from: 's-01', to: ['s-02'], text: 'раз' });
      addMessage(map, { from: 's-01', to: ['s-02'], text: 'два' });
    });
    const rings: Ring[] = [];
    start('s-02', async (ring) => {
      rings.push(ring);
    });

    await settle(() => expect(rings).toHaveLength(2));
    expect(rings.map((ring) => ring.meta['unread'])).toEqual(['2', '2']);
  });

  it('сорвавшийся звонок повторяется на следующем проходе', async () => {
    const rings: Ring[] = [];
    let broken = true;
    start('s-02', async (ring) => {
      if (broken) {
        broken = false;
        throw new Error('транспорт закрыт');
      }
      rings.push(ring);
    });
    await letter('s-02', 'привет');

    await settle(() => expect(rings).toHaveLength(1));
    expect(rings[0]?.meta['message_id']).toBe('m-01');
    // Вторая половина пункта 8.31: карту сторож не трогал ни разу — ни на
    // сорвавшемся звонке, ни на удавшемся.
    const map = await readMap(project, workId);
    expect(map.messages).toHaveLength(1);
    expect(map.messages[0]?.readBy).toEqual({});
  });

  it('карта не прочиталась на заходе: сторож переживает и звонит позже', async () => {
    // Работу сносят живьём (префикс `D`), и `readMap` бросает: необработанный
    // отказ убил бы цикл молча, а с ним и все инструменты харнесса у агента.
    hooks.breakOnce = true;
    const rings: Ring[] = [];
    start('s-02', async (ring) => {
      rings.push(ring);
    });
    await letter('s-02', 'привет');

    await settle(() => expect(rings).toHaveLength(1));
    expect(hooks.breakOnce).toBe(false);
    expect(rings[0]?.meta['message_id']).toBe('m-01');
  });

  it('чужое письмо и собственное не звонят', async () => {
    const rings: Ring[] = [];
    start('s-02', async (ring) => {
      rings.push(ring);
    });
    await updateMap(project, workId, (map) => {
      addMessage(map, { from: 's-02', to: ['s-01'], text: 'от меня' });
    });

    await delay(200);
    expect(rings).toHaveLength(0);
  });

  it('остановленный сторож молчит', async () => {
    const rings: Ring[] = [];
    const stop = start('s-02', async (ring) => {
      rings.push(ring);
    });
    stop();
    await letter('s-02', 'привет');

    await delay(200);
    expect(rings).toHaveLength(0);
  });
});
