# Действия с сообщениями в Chat и очередь отправки — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** в Chat — ↑/↓ по своим прошлым сообщениям, Copy под своим сообщением и под каждым куском ответа модели,
Send again под своим сообщением; в Chat и в комнате — видимая очередь отправки, уходящая строго по одному.

**Architecture:** одна чистая очередь `renderer/lib/outbox.ts` (zustand-стор и драйвер на уровне модуля) и две её
привязки: `chat/chat-outbox.ts` (попытка — `pty.send`, повтор `busy`/`blocked`) и `components/rooms/room-outbox.ts`
(попытка — `rooms.send`). Серые элементы рисуют лента Chat (`FeedList` → `PromptItem` с `state`) и лента комнаты
(`RoomPendingMessage`). Действия с сообщениями — компонент `chat/items/MessageActions.tsx`; история — чистая
`chat/history.ts` и обработка ↑/↓ в `chat/Composer.tsx`. Хост и протокол не меняются.

**Tech Stack:** React 18, zustand, TypeScript, Tailwind, lucide-react, vitest + @testing-library/react (jsdom).

**Spec:** `docs/specs/2026-10-16-message-actions-outbox-design.md` — исполнитель читает её вместе с планом.

## Global Constraints

- Подписи окна — по-английски: `Copy`, `Copied`, `Send again`, `Sending…`, `Waiting`, `Not sent`, `Retry`
  (`S.common.retry`), `Remove`. Комментарии, тесты и их названия — по-русски.
- Хост (`packages/host`), протокол (`packages/protocol`) и core не трогаются. Всё — в `packages/desktop/src/renderer`
  и `packages/desktop/src/shared/strings.ts`.
- Copy и Send again — только в Chat. В комнате — только очередь.
- Автоповтор — только в очереди Chat и только для `busy` и `blocked`. Прочие отправки окна (`sendWithToast`:
  бросок, вставка, тосты) остаются без повторов.
- `CHAT_RETRY_MS = 1000` — пауза перед повтором `busy` и наименьшая пауза перед повтором `blocked`.
- `COPIED_MS = 1500` — сколько держится галочка после Copy.
- `pending` × не убирает: убрать можно только `failed` (и `sent` — служебно, владельцем).
- Очередь живёт в памяти окна; драйвер — на уровне модуля, не в эффекте компонента.
- Тесты — только vitest. Без E2E и снимков Electron.
- **Исполнители тестов не запускают** (ни vitest, ни tsc, ни eslint). Прогон — шаг «Проверка группы» после каждой
  группы, строго по одному процессу за раз, никаких параллельных прогонов.
- Каждый коммит кончается строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Вызванное из истории сообщение начинается с `/` или содержит `@`** — попап подсказок не должен открыться и
   перехватить следующее ↑: человек ждёт, что ↑ идёт дальше по истории. Тест — Задача 6, шаг 1.
2. **Хост отвечает `blocked`, а окно ещё не видит `blocked`** (хост отказывает до первого хука сессии,
   `host/src/pty/send.ts:81`) — очередь не должна долбить хост без паузы: не чаще раза в `CHAT_RETRY_MS`. Тест —
   Задача 2, шаг 1.
3. **Вкладку переключили, пока сообщение ждёт ответа хоста** — очередь доходит до конца без смонтированного вида.
   Тест — Задача 3, шаг 1.
4. **`rooms.send` ответил, а `works.changed` ещё не пришёл** — серый «Sending…» держится; когда письмо пришло, оно не
   задваивается с серым. Тест — Задача 4, шаг 1.
5. **Два Enter подряд** в комнате и три в Chat — уходят строго по одному и в порядке набора. Тесты — Задача 3 и
   Задача 4, шаг 1.

---

## Группы исполнения

| Группа | Задачи | После группы |
|---|---|---|
| A | 0, 1, 2 | Проверка группы A |
| B | 3, 4 | Проверка группы B |
| C | 5, 6 | Проверка группы C (с typecheck и lint) |

Все пути ниже — от корня worktree `.claude/worktrees/chat-message-actions`.

---

### Задача 0: Подготовка worktree

**Files:** нет.

- [ ] **Шаг 1: Проверить загрузку машины**

Run: `uptime && memory_pressure | tail -1`
Expected: load average ниже числа ядер (`sysctl -n hw.ncpu`). Если выше — остановиться и сообщить контролёру.

- [ ] **Шаг 2: Поставить зависимости**

Run: `pnpm install --frozen-lockfile`
Expected: без ошибок; появился `node_modules`.

---

### Задача 1: Очередь отправки `lib/outbox.ts`

**Files:**
- Create: `packages/desktop/src/renderer/lib/outbox.ts`
- Test: `packages/desktop/src/renderer/lib/outbox.test.ts`

**Interfaces:**
- Produces:
  - `type OutboxStatus = 'pending' | 'failed' | 'sent'`
  - `interface OutboxItem<P> { id: string; payload: P; status: OutboxStatus; sentAs?: string }`
  - `type AttemptResult = { kind: 'sent'; keepAs?: string } | { kind: 'failed' } | { kind: 'retry'; wait: () => Promise<void> }`
  - `interface OutboxState<P> { byKey: Record<string, readonly OutboxItem<P>[]>; flying: Record<string, string> }`
  - `interface Outbox<P> { store; enqueue(key, payload): string; retry(key, id): void; remove(key, id): void; items(key): readonly OutboxItem<P>[]; resetForTests(): void }`
  - `createOutbox<P>(attempt: (key: string, item: OutboxItem<P>) => Promise<AttemptResult>): Outbox<P>`
  - `useOutboxItems<P>(outbox: Outbox<P>, key: string): readonly OutboxItem<P>[]`
  - `useOutboxFlying<P>(outbox: Outbox<P>, key: string): string | null`

- [ ] **Шаг 1: Написать тесты**

```ts
/**
 * Очередь отправки окна (спека 2026-10-16, 4.1): одна попытка за раз, порядок постановки, остановка на отказе,
 * Retry и ×, повтор того же элемента, ключи независимы.
 */

import { describe, expect, it } from 'vitest';
import { createOutbox, type AttemptResult, type OutboxItem } from './outbox.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Очередь, у которой каждая попытка ждёт ручного исхода: `started[i]` — i-я начатая попытка. */
function manual(): {
  outbox: ReturnType<typeof createOutbox<string>>;
  started: Array<{ id: string; text: string; done: Deferred<AttemptResult> }>;
} {
  const started: Array<{ id: string; text: string; done: Deferred<AttemptResult> }> = [];
  const outbox = createOutbox<string>((_key, item: OutboxItem<string>) => {
    const done = deferred<AttemptResult>();
    started.push({ id: item.id, text: item.payload, done });
    return done.promise;
  });
  return { outbox, started };
}

describe('outbox — очередь отправки', () => {
  it('попытка начинается синхронно в enqueue, если очередь свободна', () => {
    const { outbox, started } = manual();
    outbox.enqueue('k', 'a');
    expect(started.map((entry) => entry.text)).toEqual(['a']);
    expect(outbox.store.getState().flying.k).toBe(started[0]?.id);
  });

  it('одна попытка за раз и строго по порядку постановки — при любом числе элементов', async () => {
    for (let count = 1; count <= 12; count += 1) {
      const { outbox, started } = manual();
      const texts = Array.from({ length: count }, (_, index) => `m${index}`);
      for (const text of texts) outbox.enqueue('k', text);
      for (let index = 0; index < count; index += 1) {
        expect(started).toHaveLength(index + 1);
        started[index]?.done.resolve({ kind: 'sent' });
        await flush();
      }
      expect(started.map((entry) => entry.text)).toEqual(texts);
      expect(outbox.items('k')).toEqual([]);
      expect(outbox.store.getState().flying.k).toBeUndefined();
    }
  });

  it('failed останавливает очередь, новые встают за ним; Retry продолжает с него', async () => {
    const { outbox, started } = manual();
    const a = outbox.enqueue('k', 'a');
    started[0]?.done.resolve({ kind: 'failed' });
    await flush();
    expect(outbox.items('k').map((item) => item.status)).toEqual(['failed']);
    outbox.enqueue('k', 'b');
    await flush();
    expect(started).toHaveLength(1);
    expect(outbox.items('k').map((item) => [item.payload, item.status])).toEqual([
      ['a', 'failed'],
      ['b', 'pending'],
    ]);
    outbox.retry('k', a);
    expect(started.map((entry) => entry.text)).toEqual(['a', 'a']);
    started[1]?.done.resolve({ kind: 'sent' });
    await flush();
    expect(started.map((entry) => entry.text)).toEqual(['a', 'a', 'b']);
  });

  it('× убирает failed, и очередь идёт дальше; pending × не убирает', async () => {
    const { outbox, started } = manual();
    const a = outbox.enqueue('k', 'a');
    const b = outbox.enqueue('k', 'b');
    outbox.remove('k', a);
    expect(outbox.items('k')).toHaveLength(2);
    started[0]?.done.resolve({ kind: 'failed' });
    await flush();
    outbox.remove('k', b);
    expect(outbox.items('k')).toHaveLength(2);
    outbox.remove('k', a);
    expect(outbox.items('k').map((item) => item.payload)).toEqual(['b']);
    expect(started.map((entry) => entry.text)).toEqual(['a', 'b']);
  });

  it('Retry у не failed — ничего', async () => {
    const { outbox, started } = manual();
    const a = outbox.enqueue('k', 'a');
    outbox.retry('k', a);
    expect(started).toHaveLength(1);
  });

  it('keepAs: элемент остаётся sent с sentAs и не держит очередь; remove убирает его', async () => {
    const { outbox, started } = manual();
    const a = outbox.enqueue('k', 'a');
    outbox.enqueue('k', 'b');
    started[0]?.done.resolve({ kind: 'sent', keepAs: 'm-1' });
    await flush();
    expect(outbox.items('k')[0]).toMatchObject({ id: a, status: 'sent', sentAs: 'm-1' });
    expect(started.map((entry) => entry.text)).toEqual(['a', 'b']);
    outbox.remove('k', a);
    expect(outbox.items('k').map((item) => item.payload)).toEqual(['b']);
  });

  it('retry: ждёт wait и пробует тот же элемент, следующий не начинается', async () => {
    const { outbox, started } = manual();
    outbox.enqueue('k', 'a');
    outbox.enqueue('k', 'b');
    const wait = deferred<void>();
    started[0]?.done.resolve({ kind: 'retry', wait: () => wait.promise });
    await flush();
    expect(started).toHaveLength(1);
    expect(outbox.store.getState().flying.k).toBe(outbox.items('k')[0]?.id);
    wait.resolve();
    await flush();
    expect(started.map((entry) => entry.text)).toEqual(['a', 'a']);
  });

  it('wait отклонился — повтор всё равно идёт', async () => {
    const { outbox, started } = manual();
    outbox.enqueue('k', 'a');
    started[0]?.done.resolve({ kind: 'retry', wait: () => Promise.reject(new Error('stop')) });
    await flush();
    await flush();
    expect(started.map((entry) => entry.text)).toEqual(['a', 'a']);
  });

  it('попытка бросила или отклонилась — failed', async () => {
    const throwing = createOutbox<string>(() => {
      throw new Error('boom');
    });
    throwing.enqueue('k', 'a');
    await flush();
    expect(throwing.items('k')[0]?.status).toBe('failed');
    const rejecting = createOutbox<string>(() => Promise.reject(new Error('nope')));
    rejecting.enqueue('k', 'a');
    await flush();
    expect(rejecting.items('k')[0]?.status).toBe('failed');
  });

  it('ключи независимы: отказ в одном не держит другой', async () => {
    const { outbox, started } = manual();
    outbox.enqueue('one', 'a');
    outbox.enqueue('two', 'b');
    expect(started.map((entry) => entry.text)).toEqual(['a', 'b']);
    started[0]?.done.resolve({ kind: 'failed' });
    await flush();
    outbox.enqueue('two', 'c');
    started[1]?.done.resolve({ kind: 'sent' });
    await flush();
    expect(started.map((entry) => entry.text)).toEqual(['a', 'b', 'c']);
  });

  it('resetForTests гасит исход попытки, начатой до сброса', async () => {
    const { outbox, started } = manual();
    outbox.enqueue('k', 'a');
    outbox.resetForTests();
    started[0]?.done.resolve({ kind: 'failed' });
    await flush();
    expect(outbox.items('k')).toEqual([]);
    expect(outbox.store.getState().flying).toEqual({});
  });
});
```

- [ ] **Шаг 2: Написать реализацию**

```ts
/**
 * Очередь отправки окна (спека 2026-10-16, 4.1): одна на Chat (по сессии) и на комнату (по комнате). Отправленное
 * сразу видно серым и уходит строго по одному в порядке постановки. Окончательный отказ (`failed`) останавливает
 * очередь, пока человек не нажмёт у этого элемента Retry или ×; новые встают за ним. Что значит «отправить» и как
 * разобрать исход — у владельца (`attempt`): ушло, не ушло или «подожди и попробуй тот же элемент снова».
 *
 * Драйвер живёт на уровне модуля, а не в эффекте компонента: вид Chat и вкладка комнаты размонтируются при смене
 * вкладки, а очередь от этого вставать не должна. Хранится в памяти окна; закрытие окна её теряет, как черновик.
 * Свободная очередь начинает попытку синхронно в `enqueue`: вызов моста уходит в том же такте, что и Enter.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';

export type OutboxStatus = 'pending' | 'failed' | 'sent';

export interface OutboxItem<P> {
  id: string;
  payload: P;
  /** `pending` — ждёт или в полёте; `failed` — не ушло, очередь стоит; `sent` — ушло, владелец держит до появления в ленте. */
  status: OutboxStatus;
  /** Чем ушло (`sent`): у комнаты — `messageId` письма. */
  sentAs?: string;
}

/** Исход одной попытки. `retry` — подождать `wait()` и попробовать тот же элемент снова. */
export type AttemptResult =
  | { kind: 'sent'; keepAs?: string }
  | { kind: 'failed' }
  | { kind: 'retry'; wait: () => Promise<void> };

export interface OutboxState<P> {
  byKey: Record<string, readonly OutboxItem<P>[]>;
  /** Id элемента в полёте по ключу; нет ключа — очередь свободна. */
  flying: Record<string, string>;
}

export interface Outbox<P> {
  store: UseBoundStore<StoreApi<OutboxState<P>>>;
  /** Поставить в конец; возвращает id. */
  enqueue(key: string, payload: P): string;
  /** `failed` → `pending`, и очередь снова идёт. У прочих статусов — ничего. */
  retry(key: string, id: string): void;
  /** Убрать `failed` или `sent`; `pending` не убирается (спека, 5). */
  remove(key: string, id: string): void;
  items(key: string): readonly OutboxItem<P>[];
  /** Только для тестов: пустая очередь, исходы начатых попыток гасятся. */
  resetForTests(): void;
}

const NONE: readonly never[] = [];

export function createOutbox<P>(attempt: (key: string, item: OutboxItem<P>) => Promise<AttemptResult>): Outbox<P> {
  const store = create<OutboxState<P>>(() => ({ byKey: {}, flying: {} }));
  let nextId = 0;
  /** Поколение: `resetForTests` гасит попытки, начатые до сброса. */
  let epoch = 0;

  const items = (key: string): readonly OutboxItem<P>[] => store.getState().byKey[key] ?? NONE;
  const setItems = (key: string, update: (was: readonly OutboxItem<P>[]) => readonly OutboxItem<P>[]): void =>
    store.setState((state) => ({ byKey: { ...state.byKey, [key]: update(state.byKey[key] ?? NONE) } }));
  const patch = (key: string, id: string, next: Partial<OutboxItem<P>> | null): void =>
    setItems(key, (was) =>
      next === null ? was.filter((item) => item.id !== id) : was.map((item) => (item.id === id ? { ...item, ...next } : item)),
    );
  const setFlying = (key: string, id: string | null): void =>
    store.setState((state) => {
      const flying = { ...state.flying };
      if (id === null) delete flying[key];
      else flying[key] = id;
      return { flying };
    });

  const settle = (key: string, id: string, outcome: AttemptResult): void => {
    if (outcome.kind === 'failed') patch(key, id, { status: 'failed' });
    else if (outcome.kind === 'sent') patch(key, id, outcome.keepAs === undefined ? null : { status: 'sent', sentAs: outcome.keepAs });
    setFlying(key, null);
    pump(key);
  };

  const run = (key: string, id: string, started: number): void => {
    const item = items(key).find((entry) => entry.id === id);
    if (item === undefined) {
      setFlying(key, null);
      pump(key);
      return;
    }
    let result: Promise<AttemptResult>;
    try {
      result = attempt(key, item);
    } catch {
      result = Promise.resolve({ kind: 'failed' });
    }
    void result
      .catch((): AttemptResult => ({ kind: 'failed' }))
      .then(async (outcome) => {
        if (started !== epoch) return;
        if (outcome.kind !== 'retry') {
          settle(key, id, outcome);
          return;
        }
        await outcome.wait().catch(() => undefined);
        if (started === epoch) run(key, id, started);
      });
  };

  function pump(key: string): void {
    if (store.getState().flying[key] !== undefined) return;
    const next = items(key).find((item) => item.status !== 'sent');
    if (next === undefined || next.status === 'failed') return;
    setFlying(key, next.id);
    run(key, next.id, epoch);
  }

  return {
    store,
    enqueue(key, payload) {
      nextId += 1;
      const id = `o${nextId}`;
      setItems(key, (was) => [...was, { id, payload, status: 'pending' }]);
      pump(key);
      return id;
    },
    retry(key, id) {
      if (items(key).find((item) => item.id === id)?.status !== 'failed') return;
      patch(key, id, { status: 'pending' });
      pump(key);
    },
    remove(key, id) {
      const item = items(key).find((entry) => entry.id === id);
      if (item === undefined || item.status === 'pending') return;
      patch(key, id, null);
      pump(key);
    },
    items,
    resetForTests() {
      epoch += 1;
      store.setState({ byKey: {}, flying: {} });
    },
  };
}

/** Элементы очереди по ключу для React; пустая — один и тот же массив. */
export function useOutboxItems<P>(outbox: Outbox<P>, key: string): readonly OutboxItem<P>[] {
  return outbox.store((state) => state.byKey[key] ?? NONE);
}

/** Id элемента в полёте по ключу; `null` — очередь свободна. */
export function useOutboxFlying<P>(outbox: Outbox<P>, key: string): string | null {
  return outbox.store((state) => state.flying[key] ?? null);
}
```

- [ ] **Шаг 3: Закоммитить**

```bash
git add packages/desktop/src/renderer/lib/outbox.ts packages/desktop/src/renderer/lib/outbox.test.ts
git commit -m "feat(desktop): очередь отправки окна — одна попытка за раз, остановка на отказе, Retry и ×

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Задача 2: Попытка Chat `chat/chat-outbox.ts` и тост без отправки

**Files:**
- Create: `packages/desktop/src/renderer/chat/chat-outbox.ts`
- Test: `packages/desktop/src/renderer/chat/chat-outbox.test.ts`
- Modify: `packages/desktop/src/renderer/terminal/send.ts` — вынести показ тоста из `sendWithToast` в `showSendToast`

**Interfaces:**
- Consumes: `createOutbox`, `AttemptResult`, `OutboxItem` (Задача 1).
- Produces:
  - `showSendToast(deps: SendWithToastDeps, ref: SessionRef, text: string, submit: boolean, outcome: SendOutcome, sendOptions?: SendWithToastOptions): void` в `terminal/send.ts`
  - `interface ChatOutboxPayload { ref: SessionRef; text: string; deps: SendWithToastDeps }`
  - `CHAT_RETRY_MS = 1000`
  - `promptCount(items: readonly FeedItem[], text: string): number` (переезжает из `ChatView.tsx`)
  - `attemptChatSend(key: string, item: OutboxItem<ChatOutboxPayload>): Promise<AttemptResult>`
  - `chatOutbox: Outbox<ChatOutboxPayload>` — ключ `refKey` сессии

- [ ] **Шаг 1: Написать тесты `chat-outbox.test.ts`**

```ts
/**
 * Попытка очереди Chat (спека 2026-10-16, 4.3): исход `pty.send` → ушло / повторить / не ушло; тосты — только на
 * окончательных исходах; ушедшее во время хода переходит в серые «Queued».
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { FeedItem } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import type { OutboxItem } from '../lib/outbox.js';
import { useActivityStore } from '../store/activity.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { activityMap, makeActivity } from '../test-utils/work-fixtures.js';
import { attemptChatSend, CHAT_RETRY_MS, type ChatOutboxPayload } from './chat-outbox.js';
import { resetFeedStoreForTests, useFeedStore } from './store.js';
import { resetChatUiStoreForTests, useChatUiStore } from './ui-store.js';

vi.mock('sonner', () => {
  const fn = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast: fn };
});

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const KEY = refKey(REF);
const AT = '2026-10-16T10:00:00.000Z';

let bridge: FakeBridge;
let deps: SendWithToastDeps;

const prompt = (id: string, text: string): FeedItem => ({ id, at: AT, kind: 'prompt', text, images: 0 });
const turn = (id: string): FeedItem => ({ id, at: AT, kind: 'turn', durationMs: 1000 });

function setFeed(items: FeedItem[]): void {
  useFeedStore.setState({ feeds: { [KEY]: { items, revision: 1, mode: null, decisions: null, status: 'ready' } } });
}

const item = (text: string): OutboxItem<ChatOutboxPayload> => ({ id: 'o1', status: 'pending', payload: { ref: REF, text, deps } });

beforeEach(() => {
  bridge = createFakeBridge();
  deps = { bridge, session: () => null, openSession: () => undefined };
  resetFeedStoreForTests();
  resetChatUiStoreForTests();
  useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'idle')]), loaded: true });
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  useActivityStore.setState({ byRef: {}, loaded: false });
});

describe('attemptChatSend', () => {
  it('ушло без хода — sent, серых «Queued» нет, тоста нет', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    setFeed([prompt('p1', 'go'), turn('u1')]);
    expect(await attemptChatSend(KEY, item('next'))).toEqual({ kind: 'sent' });
    expect(useChatUiStore.getState().queued[KEY] ?? []).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('ушло во время хода — sent и серый «Queued» с тем же id и счётом промптов до отправки', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    setFeed([prompt('p0', 'next'), turn('u0'), prompt('p1', 'go')]);
    expect(await attemptChatSend(KEY, item('next'))).toEqual({ kind: 'sent' });
    expect(useChatUiStore.getState().queued[KEY]).toEqual([{ id: 'o1', text: 'next', seen: 1 }]);
  });

  it('busy — retry без тоста; wait — ровно CHAT_RETRY_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'busy' }));
    const result = await attemptChatSend(KEY, item('later'));
    expect(result.kind).toBe('retry');
    expect(toast.error).not.toHaveBeenCalled();
    let done = false;
    if (result.kind === 'retry') void result.wait().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(CHAT_RETRY_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('blocked — retry без тоста; wait не раньше CHAT_RETRY_MS и пока сессия blocked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'blocked')]), loaded: true });
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'blocked' }));
    const result = await attemptChatSend(KEY, item('later'));
    expect(result.kind).toBe('retry');
    expect(toast.error).not.toHaveBeenCalled();
    let done = false;
    if (result.kind === 'retry') void result.wait().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(CHAT_RETRY_MS * 5);
    expect(done).toBe(false);
    useActivityStore.setState({ byRef: activityMap([makeActivity(REF, 'idle')]), loaded: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it('blocked, а окно ещё не видит blocked — всё равно не чаще раза в CHAT_RETRY_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'blocked' }));
    const result = await attemptChatSend(KEY, item('later'));
    let done = false;
    if (result.kind === 'retry') void result.wait().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(CHAT_RETRY_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('вставлено без Enter (draft) — sent и прежний тост', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: false, reason: 'draft' }));
    expect(await attemptChatSend(KEY, item('later'))).toEqual({ kind: 'sent' });
    expect(vi.mocked(toast).mock.calls.map((call) => call[0])).toEqual([S.send.insertedDraft('S01')]);
  });

  it('сессии нет (not_found) — failed и тост «не запущена»', async () => {
    bridge.setHandler('pty.send', () => {
      throw Object.assign(new Error('нет'), { code: 'not_found', message: 'нет' });
    });
    expect(await attemptChatSend(KEY, item('later'))).toEqual({ kind: 'failed' });
    expect(vi.mocked(toast.error).mock.calls.map((call) => call[0])).toEqual([S.send.notRunning('S01')]);
  });

  it('no-paste-mode — failed и прежний тост', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'no-paste-mode' }));
    expect(await attemptChatSend(KEY, item('later'))).toEqual({ kind: 'failed' });
    expect(vi.mocked(toast.error).mock.calls.map((call) => call[0])).toEqual([S.send.noPasteMode('S01')]);
  });
});
```

- [ ] **Шаг 2: Вынести тост в `showSendToast` (`terminal/send.ts`)**

Заменить тело `sendWithToast` (от `const outcome = await sendToAgent(...)` до `return outcome;`) так, чтобы показ тоста
жил в новой экспортируемой функции. Поведение `sendWithToast` не меняется.

```ts
/**
 * Тост исхода `outcome` по таблице 8.6 и его кнопки — без отправки. `sendWithToast` зовёт его после своей попытки,
 * очередь Chat (`chat/chat-outbox.ts`) — только на окончательных исходах.
 */
export function showSendToast(
  deps: SendWithToastDeps,
  ref: SessionRef,
  text: string,
  submit: boolean,
  outcome: SendOutcome,
  sendOptions: SendWithToastOptions = {},
): void {
  const label = sessionTag(ref.sessionId);
  const session = deps.session(ref);
  const shown = sendToast(outcome, label, session !== null && canResume(session));
  if (shown === null) return;
  if (sendOptions.silentSuccess === true && !('error' in outcome) && outcome.reason === null) return;

  const buttons: Record<SendToast['actions'][number], ToastButton> = {
    copy: {
      label: S.common.copy,
      onClick: () => {
        navigator.clipboard.writeText(text).catch((error: unknown) => console.warn('[parley] clipboard', error));
      },
    },
    open: { label: S.send.openSession(label), onClick: () => deps.openSession(ref) },
    // Повтор — тем же путём и с теми же deps: его исход тоже уходит в onOutcome.
    retry: { label: S.common.retry, onClick: () => (deps.retry === undefined ? void sendWithToast(deps, ref, text, submit, sendOptions) : deps.retry()) },
    resume: {
      label: S.sidebar.sessionMenu.resume,
      onClick: () => {
        deps.bridge.call('sessions.resume', { ref }).catch((error: unknown) => console.warn('[parley] sessions.resume', error));
      },
    },
  };
  // У sonner две кнопки: `action` и `cancel` — таблице 8.6 больше двух не нужно.
  const [first, second] = shown.actions.map((action) => buttons[action]);
  const options = {
    ...(deps.toastId === undefined ? {} : { id: deps.toastId }),
    ...(first === undefined ? {} : { action: first }),
    ...(second === undefined ? {} : { cancel: second }),
  };
  if (shown.error) toast.error(shown.text, options);
  else toast(shown.text, options);
}

/**
 * Одна отправка окна на 5.4, 8.x и 9.x: sendToAgent, тост sendToast через sonner (ярлык — sessionTag) и его
 * кнопки: Copy — исходный текст в буфер, Open — openSession, Retry — тот же вызов, Resume — sessions.resume.
 * Возвращает исход первой попытки; исходы всех попыток, включая Retry, — в deps.onOutcome.
 */
export async function sendWithToast(
  deps: SendWithToastDeps,
  ref: SessionRef,
  text: string,
  submit: boolean,
  sendOptions: SendWithToastOptions = {},
): Promise<SendOutcome> {
  const outcome = await sendToAgent(deps.bridge, ref, text, submit);
  deps.onOutcome?.(outcome);
  showSendToast(deps, ref, text, submit, outcome, sendOptions);
  return outcome;
}
```

В шапке файла после «никаких автоповторов» дописать одно предложение:
`Исключение — очередь Chat (chat/chat-outbox.ts): она сама повторяет busy и blocked для того, что человек уже отправил.`

- [ ] **Шаг 3: Написать `chat/chat-outbox.ts`**

```ts
/**
 * Очередь отправки Chat (спека 2026-10-16, 4.3) поверх `lib/outbox.ts`: ключ — `refKey` сессии, элемент — уже
 * собранный текст промпта. Попытка — `pty.send` с Enter (`sendToAgent`).
 *
 * Сама очередь повторяет только `busy` (через `CHAT_RETRY_MS`) и `blocked` (не раньше чем через `CHAT_RETRY_MS` и когда
 * сессия выйдет из `blocked`). Это сознательное исключение из правила «никаких автоповторов» `terminal/send.ts`:
 * повторяется только то, что человек уже отправил. Пауза у `blocked` нужна и тогда, когда окно `blocked` не видит:
 * хост отказывает так и до первого хука сессии. Тостов у повторов нет — состояние видно на сером элементе; на
 * окончательных исходах тост прежний (`showSendToast`).
 *
 * Ушло во время хода — элемент переходит в серые «Queued» (`ui-store.ts`, тот же `id`), пока не придёт промпт с тем же
 * текстом. Ушло без хода — элемент просто уходит: промпт придёт в ленту хуком.
 */

import type { FeedItem } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { createOutbox, type AttemptResult, type OutboxItem } from '../lib/outbox.js';
import { activityFor, useActivityStore } from '../store/activity.js';
import { sendToAgent, showSendToast, type SendWithToastDeps } from '../terminal/send.js';
import { turnActive } from './feed-model.js';
import { useFeedStore } from './store.js';
import { useChatUiStore } from './ui-store.js';

export interface ChatOutboxPayload {
  ref: SessionRef;
  /** Собранный текст: с упоминаниями вложений (`composePrompt`) или списком путей у Codex (`composeRoomMessage`). */
  text: string;
  deps: SendWithToastDeps;
}

/** Пауза перед повтором `busy` и наименьшая пауза перед повтором `blocked`. */
export const CHAT_RETRY_MS = 1000;

/** Сколько промптов с этим текстом уже в ленте — по нему серый «Queued» узнаёт свой настоящий промпт. */
export function promptCount(items: readonly FeedItem[], text: string): number {
  const wanted = text.trim();
  return items.filter((item) => item.kind === 'prompt' && item.text.trim() === wanted).length;
}

const NO_ITEMS: readonly FeedItem[] = [];

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Ждать, пока сессия не `blocked`; уже не `blocked` (или активности нет) — сразу. */
function untilNotBlocked(ref: SessionRef): Promise<void> {
  const blocked = (): boolean => activityFor(useActivityStore.getState().byRef, ref)?.activity.activity === 'blocked';
  if (!blocked()) return Promise.resolve();
  return new Promise((resolve) => {
    const off = useActivityStore.subscribe(() => {
      if (blocked()) return;
      off();
      resolve();
    });
  });
}

export async function attemptChatSend(key: string, item: OutboxItem<ChatOutboxPayload>): Promise<AttemptResult> {
  const { ref, text, deps } = item.payload;
  const before = useFeedStore.getState().feeds[key]?.items ?? NO_ITEMS;
  const active = turnActive(before);
  const seen = promptCount(before, text);
  const outcome = await sendToAgent(deps.bridge, ref, text, true);
  deps.onOutcome?.(outcome);
  if (!('error' in outcome)) {
    if (outcome.reason === 'busy') return { kind: 'retry', wait: () => delay(CHAT_RETRY_MS) };
    if (outcome.reason === 'blocked') {
      return {
        kind: 'retry',
        wait: async () => {
          await delay(CHAT_RETRY_MS);
          await untilNotBlocked(ref);
        },
      };
    }
    if (outcome.submitted) {
      if (active) useChatUiStore.getState().updateQueued(key, (was) => [...was, { id: item.id, text, seen }]);
      return { kind: 'sent' };
    }
    // Вставлено без Enter (`draft`, `input`, `restarted`, `blocked-before-enter`): текст уже в поле терминала.
    if (outcome.inserted) {
      showSendToast(deps, ref, text, true, outcome);
      return { kind: 'sent' };
    }
  }
  showSendToast(deps, ref, text, true, outcome);
  return { kind: 'failed' };
}

export const chatOutbox = createOutbox<ChatOutboxPayload>(attemptChatSend);
```

- [ ] **Шаг 4: Закоммитить**

```bash
git add packages/desktop/src/renderer/chat/chat-outbox.ts packages/desktop/src/renderer/chat/chat-outbox.test.ts packages/desktop/src/renderer/terminal/send.ts
git commit -m "feat(desktop): очередь Chat — повтор busy и blocked без тостов, тост без отправки вынесен

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Проверка группы A

- [ ] Run (один процесс): `pnpm --filter @parley/desktop exec vitest run src/renderer/lib/outbox.test.ts src/renderer/chat/chat-outbox.test.ts src/renderer/terminal`
  Expected: все зелёные. Красные — исправить в той задаче, где код, и перезапустить ту же команду.

---

### Задача 3: Очередь в ленте Chat

**Files:**
- Modify: `packages/desktop/src/shared/strings.ts` — группа `S.outbox`
- Modify: `packages/desktop/src/renderer/chat/items/PromptItem.tsx` — проп `state` вместо `queued`, Retry и ×
- Modify: `packages/desktop/src/renderer/chat/FeedList.tsx` — строки очереди окна
- Modify: `packages/desktop/src/renderer/chat/ChatView.tsx` — отправка через `chatOutbox`
- Test: `packages/desktop/src/renderer/chat/ChatView.test.tsx`, `packages/desktop/src/renderer/chat/items/items.test.tsx`

**Interfaces:**
- Consumes: `chatOutbox`, `promptCount` (Задача 2); `useOutboxItems` (Задача 1).
- Produces:
  - `S.outbox = { sending: 'Sending…', waiting: 'Waiting', notSent: 'Not sent', remove: 'Remove' }`
  - `PromptItemProps.state?: 'queued' | 'waiting' | 'failed'`, `onRetry?: () => void`, `onRemove?: () => void`;
    серый элемент — `data-testid="chat-queued"` с `data-state`.
  - `export interface OutboxPrompt { id: string; text: string; failed: boolean }` в `FeedList.tsx`;
    `FeedListProps.outbox?`, `onRetryOutbox?(id)`, `onRemoveOutbox?(id)`.

- [ ] **Шаг 1: Поправить и дописать тесты**

В `ChatView.test.tsx`:

1. Импорт: `import { chatOutbox } from './chat-outbox.js';`. В `beforeEach` и `afterEach` — `chatOutbox.resetForTests();`.
2. В тесте `'Enter — pty.send с submit: true, поле пустеет; Shift+Enter — не отправляет'` заменить строки

```ts
    expect(field().value).toBe('');
    // Без хода — без серого элемента: промпт придёт хуком сразу.
    expect(screen.queryByTestId('chat-queued')).toBeNull();
```

на

```ts
    expect(field().value).toBe('');
    // До ответа хоста — серый «Waiting»; ушло без хода — он уходит: промпт придёт хуком сам.
    expect(screen.getByTestId('chat-queued').getAttribute('data-state')).toBe('waiting');
    await act(async () => {});
    expect(screen.queryByTestId('chat-queued')).toBeNull();
```

3. Тест `'отказ отправки (busy) — серый элемент уходит'` заменить на:

```ts
  it('busy — серый «Waiting» остаётся без тоста, через секунду повтор; удачный — уходит', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let busy = true;
      bridge.setHandler('pty.send', () =>
        busy ? { inserted: false, submitted: false, reason: 'busy' as const } : { inserted: true, submitted: true, reason: null },
      );
      renderBody(makeSession('s-01', 'S01'));
      setFeed([prompt('p1', 'go'), turn('u1')]);
      type('later');
      fireEvent.keyDown(field(), { key: 'Enter' });
      await act(async () => {});
      expect(screen.getByTestId('chat-queued').getAttribute('data-state')).toBe('waiting');
      expect(toast.error).not.toHaveBeenCalled();
      busy = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(sends()).toHaveLength(2);
      expect(screen.queryByTestId('chat-queued')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
```

4. Тест `'успешная отправка — без тоста «Sent to»; отказ busy — тост с Retry'` переименовать в
   `'успешная отправка — без тоста «Sent to»; окончательный отказ — прежний тост'` и заменить его вторую половину
   (от `bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'busy' }));` до конца) на:

```ts
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'no-paste-mode' }));
    type('loud');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await act(async () => {});
    expect(vi.mocked(toast.error).mock.calls.map((call) => call[0])).toEqual([S.send.noPasteMode('S01')]);
```

5. `describe('ChatView — отказ отправки не теряет набранное', ...)` удалить целиком (поле больше не возвращает текст:
   не ушедшее стоит в ленте «Not sent») и на его место вставить:

```ts
describe('ChatView — очередь отправки', () => {
  const field = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: S.chat.composer.label }) as HTMLTextAreaElement;
  const type = (value: string): void => {
    fireEvent.change(field(), { target: { value } });
  };
  const sentTexts = (): string[] =>
    bridge.calls.filter((call) => call.method === 'pty.send').map((call) => (call.params as { text: string }).text);
  const states = (): Array<string | null> => screen.queryAllByTestId('chat-queued').map((node) => node.getAttribute('data-state'));

  it('окончательный отказ — поле пустое, серый «Not sent» с Retry и ×; Retry шлёт снова', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'no-paste-mode' }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    type('важное');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await act(async () => {});
    expect(field().value).toBe('');
    const grey = screen.getByTestId('chat-queued');
    expect(grey.getAttribute('data-state')).toBe('failed');
    expect(grey.textContent).toContain(S.outbox.notSent);
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    fireEvent.click(within(grey).getByRole('button', { name: S.common.retry }));
    await act(async () => {});
    expect(sentTexts()).toEqual(['важное', 'важное']);
    expect(screen.queryByTestId('chat-queued')).toBeNull();
  });

  it('пока «Not sent» стоит, новые ждут за ним; × убирает его, и очередь идёт дальше', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: false, submitted: false, reason: 'no-paste-mode' }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    type('first');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await act(async () => {});
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    type('second');
    fireEvent.keyDown(field(), { key: 'Enter' });
    await act(async () => {});
    expect(sentTexts()).toEqual(['first']);
    expect(states()).toEqual(['failed', 'waiting']);
    fireEvent.click(screen.getByRole('button', { name: S.outbox.remove }));
    await act(async () => {});
    expect(sentTexts()).toEqual(['first', 'second']);
    expect(states()).toEqual([]);
  });

  it('три сообщения подряд — pty.send строго по одному и по порядку; кнопка — Queue, пока очередь не пуста', async () => {
    const answers: Array<(result: SendResult) => void> = [];
    bridge.setHandler('pty.send', () => new Promise<SendResult>((resolve) => answers.push(resolve)));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    for (const text of ['one', 'two', 'three']) {
      type(text);
      fireEvent.keyDown(field(), { key: 'Enter' });
    }
    expect(sentTexts()).toEqual(['one']);
    expect(screen.getAllByRole('button', { name: S.chat.composer.queue })).toHaveLength(1);
    for (let index = 0; index < 3; index += 1) {
      await act(async () => answers[index]?.({ inserted: true, submitted: true, reason: null }));
    }
    expect(sentTexts()).toEqual(['one', 'two', 'three']);
    expect(screen.getAllByRole('button', { name: S.chat.composer.send })).toHaveLength(1);
  });

  it('вид размонтирован до ответа хоста — очередь всё равно доходит', async () => {
    let answer: (result: SendResult) => void = () => undefined;
    bridge.setHandler('pty.send', () => new Promise<SendResult>((resolve) => (answer = resolve)));
    const view = renderBody(makeSession('s-01', 'S01'));
    setFeed([]);
    type('one');
    fireEvent.keyDown(field(), { key: 'Enter' });
    type('two');
    fireEvent.keyDown(field(), { key: 'Enter' });
    view.unmount();
    await act(async () => answer({ inserted: true, submitted: true, reason: null }));
    expect(sentTexts()).toEqual(['one', 'two']);
    await act(async () => answer({ inserted: true, submitted: true, reason: null }));
    renderBody(makeSession('s-01', 'S01'));
    expect(states()).toEqual([]);
  });
});
```

Прочие тесты `ChatView.test.tsx` не трогать. Если какой-то из них проверял возврат текста в поле после отказа или тост
`busy` — он относится к удалённому поведению: удалить его и назвать в отчёте.

В `items.test.tsx` в тесте `'серый элемент очереди — те же чипы, подпись «Queued» и текст без путей'` заменить
`<PromptItem text={'next @"/a/notes.txt" '} queued />` на `<PromptItem text={'next @"/a/notes.txt" '} state="queued" />`
и дописать рядом:

```ts
  it('не ушедший элемент — «Not sent», Retry и × зовут свои колбэки; ждущий — «Waiting» без кнопок', () => {
    const onRetry = vi.fn();
    const onRemove = vi.fn();
    const view = renderPrompt(<PromptItem text="later" state="failed" onRetry={onRetry} onRemove={onRemove} />);
    const grey = screen.getByTestId('chat-queued');
    expect(grey.getAttribute('data-state')).toBe('failed');
    expect(grey.textContent).toContain(S.outbox.notSent);
    fireEvent.click(within(grey).getByRole('button', { name: S.common.retry }));
    fireEvent.click(within(grey).getByRole('button', { name: S.outbox.remove }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
    view.unmount();
    renderPrompt(<PromptItem text="later" state="waiting" />);
    expect(screen.getByTestId('chat-queued').textContent).toContain(S.outbox.waiting);
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
```

(`vi` добавить в импорт из `vitest`, если его там нет; `renderPrompt` — существующий помощник файла.)

- [ ] **Шаг 2: Строки `S.outbox`**

В `shared/strings.ts` сразу после группы `common: { ... },` вставить:

```ts
  /** Очередь отправки окна (спека 2026-10-16, 4): серые элементы Chat и комнаты. */
  outbox: {
    sending: 'Sending…',
    waiting: 'Waiting',
    notSent: 'Not sent',
    remove: 'Remove',
  },
```

- [ ] **Шаг 3: `PromptItem` — состояние серого элемента**

Шапку файла оставить как есть и дописать в её конец (перед `*/`) абзац:

```
 *
 * Очередь окна (спека 2026-10-16, 4.3): серый элемент бывает трёх видов — `queued` (уже в очереди CLI во время хода),
 * `waiting` (ждёт отправки окном) и `failed` («Not sent» с Retry и ×). У всех `data-testid="chat-queued"` и `data-state`.
```

Всё ниже шапки (импорты, интерфейс пропсов, компонент) заменить на:

```tsx
import { useContext } from 'react';
import { ImageIcon, X } from 'lucide-react';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { Button } from '../../ui/button.js';
import { AttachmentChip } from '../AttachmentChip.js';
import { splitAttachments } from '../attachments.js';
import { ChatEnvContext } from '../chat-env.js';
import { pairContextAttachments } from '../context-attachments.js';

export interface PromptItemProps {
  text: string;
  images?: number;
  /** Серый элемент: `queued` — в очереди CLI, `waiting` — ждёт отправки окном, `failed` — не ушло. Нет — настоящий промпт. */
  state?: 'queued' | 'waiting' | 'failed';
  /** `failed`: Retry. */
  onRetry?: () => void;
  /** `failed`: × — убрать не ушедшее. */
  onRemove?: () => void;
}

export function PromptItem({ text, images = 0, state, onRetry, onRemove }: PromptItemProps): JSX.Element {
  // Мост — только для миниатюр: `useChatEnv()` вне окружения бросает, а промпт без него рисуется (чипы без картинок).
  const bridge = useContext(ChatEnvContext)?.bridge ?? null;
  // Вставка в CLI оставляет в промпте пустые строки по краям — в пузыре они только место.
  const { text: body, attachments } = splitAttachments(text);
  const shown = pairContextAttachments(attachments);
  const grey = state !== undefined;
  return (
    <div
      data-testid={grey ? 'chat-queued' : 'chat-prompt'}
      {...(grey ? { 'data-state': state } : {})}
      className="flex min-w-0 justify-end"
    >
      <div
        className={cn(
          'flex min-w-0 max-w-[85%] flex-col gap-1 rounded-md px-3 py-2 text-sm',
          grey ? 'border border-dashed border-border text-muted-foreground' : 'bg-secondary text-secondary-foreground',
        )}
      >
        {shown.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {shown.map((path, index) => (
              <AttachmentChip key={`${index}:${path}`} path={path} bridge={bridge} size="feed" />
            ))}
          </div>
        ) : null}
        {body === '' ? null : <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{body}</span>}
        {images > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ImageIcon className="size-3.5" aria-hidden="true" />
            {S.chat.images(images)}
          </span>
        ) : null}
        {state === 'queued' ? <span className="text-xs">{S.chat.queued}</span> : null}
        {state === 'waiting' ? <span className="text-xs">{S.outbox.waiting}</span> : null}
        {state === 'failed' ? (
          <span className="flex items-center gap-2 text-xs">
            <span className="text-[var(--status-warning-text)]">{S.outbox.notSent}</span>
            <Button type="button" size="xs" variant="outline" onClick={onRetry}>
              {S.common.retry}
            </Button>
            <Button type="button" size="icon-xs" variant="ghost" aria-label={S.outbox.remove} title={S.outbox.remove} onClick={onRemove}>
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Шаг 4: `FeedList` — строки очереди окна**

1. Рядом с `QueuedPrompt` добавить:

```ts
/** Сообщение в очереди окна (`chat-outbox.ts`): ждёт отправки или не ушло. */
export interface OutboxPrompt {
  id: string;
  text: string;
  failed: boolean;
}

const NO_OUTBOX: readonly OutboxPrompt[] = [];
```

2. `type Row` заменить на
   `type Row = { key: string; item: FeedItem } | { key: string; queued: QueuedPrompt } | { key: string; outbox: OutboxPrompt };`
3. В `FeedListProps` после `queued` добавить:

```ts
  /** Очередь окна — после «Queued»: ждёт отправки (`waiting`) или не ушло (`failed`, с Retry и ×). */
  outbox?: readonly OutboxPrompt[];
  onRetryOutbox?: (id: string) => void;
  onRemoveOutbox?: (id: string) => void;
```

4. Сигнатуру взять с новыми пропсами: `FeedList({ items, queued, outbox = NO_OUTBOX, onRetryOutbox, onRemoveOutbox, note, onRetry, working, reveal, onRevealed })`,
   в `rows` после строк `queued` добавить `...outbox.map((entry) => ({ key: \`outbox:${entry.id}\`, outbox: entry })),`.
5. В отрисовке строки заменить

```tsx
                  ) : (
                    <PromptItem text={row.queued.text} queued />
                  )}
```

на

```tsx
                  ) : 'queued' in row ? (
                    <PromptItem text={row.queued.text} state="queued" />
                  ) : (
                    <PromptItem
                      text={row.outbox.text}
                      state={row.outbox.failed ? 'failed' : 'waiting'}
                      onRetry={() => onRetryOutbox?.(row.outbox.id)}
                      onRemove={() => onRemoveOutbox?.(row.outbox.id)}
                    />
                  )}
```

6. В шапке файла фразу «В конце — серые сообщения из очереди (`queued`, решение 8)» дополнить: «…, за ними — очередь окна
   (`outbox`, спека 2026-10-16)».

- [ ] **Шаг 5: `ChatView` — отправка через очередь**

1. Импорты: добавить `import { chatOutbox, promptCount } from './chat-outbox.js';` и
   `import { useOutboxItems } from '../lib/outbox.js';`. Удалить `let nextQueuedId = 0;` и локальную функцию
   `promptCount` (теперь из `chat-outbox.ts`). Импорт `sendWithToast` убрать, если он больше нигде в файле не нужен
   (`resumeSession` и `type SendWithToastDeps` остаются).
2. После строки `const queued = useChatUiStore(...)` добавить:

```ts
  const outboxItems = useOutboxItems(chatOutbox, sessionKey);
  const outbox = useMemo(
    () => outboxItems.map((item) => ({ id: item.id, text: item.payload.text, failed: item.status === 'failed' })),
    [outboxItems],
  );
```

3. Функцию `submit` заменить целиком:

```ts
  // Поле и вложения очищаются сразу; сообщение — в очередь окна (`chat-outbox.ts`): серым сразу, уходит строго по одному.
  const submit = (typed: string, paths: readonly string[]): void => {
    const { setDraft, setAttachments } = useChatUiStore.getState();
    const text = codex ? composeRoomMessage(typed, paths) : composePrompt(typed, paths);
    setDraft(sessionKey, '');
    if (paths.length > 0) setAttachments(sessionKey, []);
    chatOutbox.enqueue(sessionKey, { ref: sessionRef, text, deps: sendDeps });
  };
```

4. В `<FeedList ...>` после `queued={queued}` добавить:

```tsx
            outbox={outbox}
            onRetryOutbox={(id) => chatOutbox.retry(sessionKey, id)}
            onRemoveOutbox={(id) => chatOutbox.remove(sessionKey, id)}
```

5. В `<Composer ...>` заменить `busy={active}` на `busy={active || outboxItems.length > 0}`.
6. В шапке файла абзац «Ввод (решение 8): …» заменить на:

```
 * Ввод (решение 8, очередь — спека 2026-10-16, 4.3): поле и вложения очищаются сразу, а сообщение встаёт в очередь
 * окна (`chat-outbox.ts`) — серым «Waiting» в конце ленты — и уходит `pty.send` с Enter строго по одному. Очередь сама
 * повторяет `busy` и `blocked`; окончательный отказ — «Not sent» с Retry и ×, тост прежний (`showSendToast`). Ушедшее
 * во время хода — серый «Queued», пока не придёт промпт с тем же текстом. Поле больше не возвращает набранное: не
 * ушедшее видно в ленте. Очередь живёт вне вида, поэтому переживает смену вида и вкладки.
```

и из абзаца убрать прежние фразы про возврат набранного в поле и про вставку без Enter.

- [ ] **Шаг 6: Закоммитить**

```bash
git add packages/desktop/src/shared/strings.ts packages/desktop/src/renderer/chat
git commit -m "feat(desktop): Chat — очередь отправки в ленте: Waiting, Not sent с Retry и ×

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Задача 4: Очередь в комнате

**Files:**
- Create: `packages/desktop/src/renderer/components/rooms/room-outbox.ts`
- Create: `packages/desktop/src/renderer/components/rooms/RoomPendingMessage.tsx`
- Modify: `packages/desktop/src/renderer/components/rooms/RoomPanel.tsx`
- Modify: `packages/desktop/src/renderer/components/rooms/Composer.tsx`
- Test: `packages/desktop/src/renderer/components/rooms/RoomPanel.test.tsx`, `packages/desktop/src/renderer/components/rooms/Composer.test.tsx`

**Interfaces:**
- Consumes: `createOutbox`, `useOutboxItems`, `useOutboxFlying`, `AttemptResult`, `OutboxItem` (Задача 1); `S.outbox` (Задача 3).
- Produces:
  - `interface RoomOutboxPayload { bridge: ParleyBridge; projectPath: string; workId: string; roomId: string; to: string[]; text: string }`
  - `attemptRoomSend(key, item): Promise<AttemptResult>`, `roomOutbox: Outbox<RoomOutboxPayload>` — ключ `draftKey` комнаты
  - `RoomPendingMessage({ text, state: 'sending' | 'waiting' | 'failed', labelOf, onOpenExternal, onRetry, onRemove })`,
    `data-testid="room-pending"` с `data-state`
  - `ComposerProps.onSend: (submission: ComposerSubmission) => void`

- [ ] **Шаг 1: Поправить и дописать тесты**

В `RoomPanel.test.tsx`:

1. Импорт `import { roomOutbox } from './room-outbox.js';`, в `beforeEach` — `roomOutbox.resetForTests();`. Если в
   файле нет импорта `S` (`../../../shared/strings.js`), `act` и `within` (`@testing-library/react`) — добавить.
2. Тест `'не ушло: тост с причиной, текст возвращается в поле'` заменить на четыре:

```ts
  const sentTexts = (): string[] =>
    bridge.calls.filter((call) => call.method === 'rooms.send').map((call) => (call.params as { text: string }).text);
  const pendingStates = (): Array<string | null> =>
    screen.queryAllByTestId('room-pending').map((node) => node.getAttribute('data-state'));

  it('не ушло: тост с причиной, серый «Not sent» с Retry и ×, поле пустое; Retry шлёт снова', async () => {
    bridge.setHandler('rooms.send', () => {
      throw Object.assign(new Error('нет'), { code: 'not_found', message: 'нет' });
    });
    renderPanel(entryOf());
    typeAndSend('Важное');
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't send the message: not found."));
    expect(editor().textContent).toBe('');
    await waitFor(() => expect(pendingStates()).toEqual(['failed']));
    bridge.setHandler('rooms.send', () => ({ messageId: 'm-new' }));
    fireEvent.click(within(screen.getByTestId('room-pending')).getByRole('button', { name: S.common.retry }));
    await waitFor(() => expect(sentTexts()).toEqual(['Важное', 'Важное']));
    await waitFor(() => expect(pendingStates()).toEqual(['sending']));
  });

  it('ушло: серый «Sending…» держится, пока письмо с этим messageId не пришло, и не задваивается', async () => {
    const { update } = renderPanel(entryOf());
    typeAndSend('Важное');
    expect(pendingStates()).toEqual(['sending']);
    await act(async () => {});
    expect(pendingStates()).toEqual(['sending']);
    update(entryOf({ messages: [message('m-new', { text: 'Важное' })] }));
    await waitFor(() => expect(pendingStates()).toEqual([]));
    expect(screen.getAllByText('Важное')).toHaveLength(1);
  });

  it('два Enter подряд — второй rooms.send только после ответа на первый, по порядку', async () => {
    const answers: Array<(value: { messageId: string }) => void> = [];
    bridge.setHandler('rooms.send', () => new Promise<{ messageId: string }>((resolve) => answers.push(resolve)));
    renderPanel(entryOf());
    typeAndSend('one');
    typeAndSend('two');
    expect(sentTexts()).toEqual(['one']);
    expect(pendingStates()).toEqual(['sending', 'waiting']);
    await act(async () => answers[0]?.({ messageId: 'm-1' }));
    expect(sentTexts()).toEqual(['one', 'two']);
  });

  it('× убирает «Not sent», и следующее письмо уходит', async () => {
    bridge.setHandler('rooms.send', () => {
      throw Object.assign(new Error('нет'), { code: 'not_found', message: 'нет' });
    });
    renderPanel(entryOf());
    typeAndSend('first');
    await waitFor(() => expect(pendingStates()).toEqual(['failed']));
    bridge.setHandler('rooms.send', () => ({ messageId: 'm-2' }));
    typeAndSend('second');
    await act(async () => {});
    expect(sentTexts()).toEqual(['first']);
    expect(pendingStates()).toEqual(['failed', 'waiting']);
    fireEvent.click(screen.getByRole('button', { name: S.outbox.remove }));
    await waitFor(() => expect(sentTexts()).toEqual(['first', 'second']));
  });
```

В `Composer.test.tsx` удалить `describe('Composer — отказ отправки', ...)` целиком и тест
`'отказ отправки возвращает и текст, и вложения'` (поле больше не возвращает набранное — не ушедшее видно в ленте
комнаты, это проверяет `RoomPanel.test.tsx`).

- [ ] **Шаг 2: `room-outbox.ts`**

```ts
/**
 * Очередь отправки комнаты (спека 2026-10-16, 4.2) поверх `lib/outbox.ts`: ключ — `draftKey` комнаты, элемент — письмо
 * человека с адресатами из чипов на момент Enter. Попытка — `rooms.send`; ушло — элемент держится как `sent` с
 * `messageId`, пока письмо не придёт в ленту (`RoomPanel`). Сама комната не повторяет: отказ — «Not sent» и прежний тост.
 */

import { toast } from 'sonner';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { createOutbox, type AttemptResult, type OutboxItem } from '../../lib/outbox.js';

export interface RoomOutboxPayload {
  bridge: ParleyBridge;
  projectPath: string;
  workId: string;
  roomId: string;
  /** Упомянутые сессии; пусто — всем участникам. */
  to: string[];
  text: string;
}

export async function attemptRoomSend(_key: string, item: OutboxItem<RoomOutboxPayload>): Promise<AttemptResult> {
  const { bridge, projectPath, workId, roomId, to, text } = item.payload;
  try {
    const { messageId } = await bridge.call('rooms.send', { projectPath, workId, roomId, to, text, kind: 'note' });
    return { kind: 'sent', keepAs: messageId };
  } catch (error) {
    // Не ушло (не участник, комната в архиве, тайм-аут `map.lock`, хост недоступен): человек узнаёт об этом тостом.
    toast(errorText(decodeIpcError(error).code, S.rooms.sendAction));
    return { kind: 'failed' };
  }
}

export const roomOutbox = createOutbox<RoomOutboxPayload>(attemptRoomSend);
```

- [ ] **Шаг 3: `RoomPendingMessage.tsx`**

```tsx
/**
 * Серое письмо человека в ленте комнаты (спека 2026-10-16, 4.2): справа, как сообщения человека (`RoomMessage`), но
 * с пунктирной рамкой. `sending` — в полёте или ушло и ждёт появления в ленте, `waiting` — ждёт за другим, `failed` —
 * «Not sent» с Retry и ×. Текст — тем же `RoomMarkdown`, что у отправленных: упоминания — чипами.
 */

import { X } from 'lucide-react';
import { S } from '../../../shared/strings.js';
import { Button } from '../../ui/button.js';
import { RoomMarkdown } from './RoomMarkdown.js';

export interface RoomPendingMessageProps {
  text: string;
  state: 'sending' | 'waiting' | 'failed';
  labelOf: (sessionId: string) => string | null;
  onOpenExternal: (url: string) => void;
  onRetry: () => void;
  onRemove: () => void;
}

export function RoomPendingMessage({ text, state, labelOf, onOpenExternal, onRetry, onRemove }: RoomPendingMessageProps): JSX.Element {
  const caption = state === 'failed' ? S.outbox.notSent : state === 'sending' ? S.outbox.sending : S.outbox.waiting;
  return (
    <div data-testid="room-pending" data-state={state} className="flex max-w-[680px] flex-col items-end gap-1 self-end">
      <div className="max-w-full break-words rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
        <RoomMarkdown text={text} labelOf={labelOf} onOpenExternal={onOpenExternal} humanChips={false} />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span role="status" className={state === 'failed' ? 'text-[var(--status-warning-text)]' : undefined}>
          {caption}
        </span>
        {state === 'failed' ? (
          <>
            <Button type="button" size="xs" variant="outline" onClick={onRetry}>
              {S.common.retry}
            </Button>
            <Button type="button" size="icon-xs" variant="ghost" aria-label={S.outbox.remove} title={S.outbox.remove} onClick={onRemove}>
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Шаг 4: `RoomPanel` — отправка через очередь и серые письма**

1. Импорты: `import { useOutboxFlying, useOutboxItems } from '../../lib/outbox.js';`,
   `import { roomOutbox } from './room-outbox.js';`, `import { RoomPendingMessage } from './RoomPendingMessage.js';`.
2. Строку `const draftKey = roomKey(workKey(entry.projectPath, entry.map.work.id), roomId);` перенести выше раннего
   возврата `if (model === null) { ... }` — она нужна хукам ниже. Сразу после `useLayoutEffect(keepAtBottom, [keepAtBottom, liveKey]);`
   (до `if (model === null)`) вставить:

```ts
  // Очередь писем человека (`room-outbox.ts`): серые — в конце ленты, пока письмо с тем же `messageId` не пришло в карту.
  const pending = useOutboxItems(roomOutbox, draftKey);
  const flying = useOutboxFlying(roomOutbox, draftKey);
  const landedIds = useMemo(() => new Set((model?.messages ?? []).map((message) => message.id)), [model?.messages]);
  // Ушло и уже пришло в карту — серый не рисуется сразу (без кадра с двумя письмами) и убирается из очереди эффектом.
  const shownPending = pending.filter((item) => !(item.status === 'sent' && item.sentAs !== undefined && landedIds.has(item.sentAs)));
  useEffect(() => {
    for (const item of pending) {
      if (item.status === 'sent' && item.sentAs !== undefined && landedIds.has(item.sentAs)) roomOutbox.remove(draftKey, item.id);
    }
  }, [pending, landedIds, draftKey]);
  // Серое письмо выросло или ушло — у низа лента остаётся у низа.
  useLayoutEffect(keepAtBottom, [keepAtBottom, shownPending.length]);
```

   (`useMemo` и `useEffect` добавить в импорт из `react`, если их там нет.)
3. `handleSend` заменить целиком:

```ts
  // Письмо — в очередь комнаты (`room-outbox.ts`): серым сразу, уходит строго по одному; отказ — «Not sent» с Retry и ×.
  const handleSend = (submission: ComposerSubmission): void => {
    roomOutbox.enqueue(draftKey, {
      bridge,
      projectPath: entry.projectPath,
      workId: entry.map.work.id,
      roomId,
      to: submission.to,
      text: submission.text,
    });
  };
```

   Если после замены `toast`, `decodeIpcError` или `errorText` в файле больше не используются — убрать их из импортов.
4. Сразу после `{model.messages.map((message) => ( <RoomMessage ... /> ))}` вставить:

```tsx
          {shownPending.map((item) => (
            <RoomPendingMessage
              key={item.id}
              text={item.payload.text}
              state={item.status === 'failed' ? 'failed' : item.status === 'sent' || item.id === flying ? 'sending' : 'waiting'}
              labelOf={labelOf}
              onOpenExternal={onOpenExternal}
              onRetry={() => roomOutbox.retry(draftKey, item.id)}
              onRemove={() => roomOutbox.remove(draftKey, item.id)}
            />
          ))}
```

5. В шапку файла дописать абзац:

```
 * Отправка (спека 2026-10-16, 4.2): письмо встаёт в очередь комнаты (`room-outbox.ts`) и сразу видно серым в конце
 * ленты (`RoomPendingMessage`); `rooms.send` идут строго по одному. Ушедшее держится серым «Sending…», пока письмо с
 * его `messageId` не придёт в карту, — так оно не пропадает и не задваивается; отказ — «Not sent» с Retry и ×.
```

- [ ] **Шаг 5: `Composer` комнаты — отправка без ожидания**

1. В `ComposerProps` заменить `onSend: (submission: ComposerSubmission) => Promise<void> | void;` на

```ts
  /** Письмо уходит в очередь комнаты (`room-outbox.ts`); поле его больше не ждёт и не возвращает. */
  onSend: (submission: ComposerSubmission) => void;
```

2. В `submit` заменить вызов с `.catch(...)` (от `void Promise.resolve(onSend(...))` до закрывающей `});`) на

```ts
    onSend({ to: content.to, text: composeRoomMessage(trimmed, sent) });
```

3. Убрать из импортов то, что после этого не используется (проверить `fillEditor`, `isBlank`, `useUiStore`, `chipLabel` —
   удалять только реально осиротевшее).
4. В шапке файла добавить фразу: «Отправка не ждёт хоста: письмо уходит в очередь комнаты, а не ушедшее видно в ленте
   «Not sent» (спека 2026-10-16, 4.2) — поле его не возвращает.»

- [ ] **Шаг 6: Закоммитить**

```bash
git add packages/desktop/src/renderer/components/rooms
git commit -m "feat(desktop): комната — очередь писем: серые Sending/Waiting, Not sent с Retry и ×, строго по одному

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Проверка группы B

- [ ] Run (по одному, подряд):
  1. `pnpm --filter @parley/desktop exec vitest run src/renderer/chat src/renderer/components/rooms src/renderer/lib/outbox.test.ts src/renderer/terminal`
  Expected: все зелёные. Красные — исправить в задаче, где код, перезапустить ту же команду.

---

### Задача 5: Copy и Send again под сообщениями Chat

**Files:**
- Modify: `packages/desktop/src/shared/strings.ts` — `S.chat.actions`
- Create: `packages/desktop/src/renderer/chat/items/MessageActions.tsx`
- Modify: `packages/desktop/src/renderer/chat/items/PromptItem.tsx`, `packages/desktop/src/renderer/chat/items/TextItem.tsx`
- Modify: `packages/desktop/src/renderer/chat/chat-env.ts` — `resend`
- Modify: `packages/desktop/src/renderer/chat/ChatView.tsx` — `resend` в окружении
- Test: `packages/desktop/src/renderer/chat/items/items.test.tsx`, `packages/desktop/src/renderer/chat/ChatView.test.tsx`

**Interfaces:**
- Consumes: `chatOutbox` (Задача 2); `PromptItemProps.state` (Задача 3).
- Produces:
  - `S.chat.actions = { copy: 'Copy', copied: 'Copied', sendAgain: 'Send again' }`
  - `COPIED_MS = 1500`; `MessageActions({ copyText: string; onSendAgain?: () => void; align: 'start' | 'end' })`,
    `data-testid="chat-message-actions"`
  - `ChatEnv.resend?: (text: string) => void`

- [ ] **Шаг 1: Написать тесты**

В `items.test.tsx` (добавить `vi` в импорт из `vitest`, если нет; `TextItem` — в импорты) новый блок:

```ts
describe('действия под сообщениями (спека 2026-10-16, 3.1)', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  function renderInEnv(node: JSX.Element, resend?: (text: string) => void): ReturnType<typeof render> {
    const bridge = createFakeBridge();
    const sessionRef: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
    return render(
      <ChatEnvContext.Provider value={{ bridge, sessionRef, ...(resend === undefined ? {} : { resend }) }}>{node}</ChatEnvContext.Provider>,
    );
  }

  it('Copy под своим сообщением кладёт текст как ушёл — с упоминаниями, без пустых краёв; галочка на COPIED_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderInEnv(<PromptItem text={'\nsee @"/a/b.txt" \n'} />);
    fireEvent.click(screen.getByRole('button', { name: S.chat.actions.copy }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith('see @"/a/b.txt"');
    expect(screen.getAllByRole('button', { name: S.chat.actions.copied })).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getAllByRole('button', { name: S.chat.actions.copy })).toHaveLength(1);
  });

  it('буфер отказал — галочки нет, без исключения', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    renderInEnv(<PromptItem text="hello" />);
    fireEvent.click(screen.getByRole('button', { name: S.chat.actions.copy }));
    await act(async () => {});
    expect(screen.queryByRole('button', { name: S.chat.actions.copied })).toBeNull();
  });

  it('Send again зовёт resend с текстом промпта как есть; без resend в окружении кнопки нет', () => {
    const resend = vi.fn();
    const view = renderInEnv(<PromptItem text={'again @"/a/b.txt" '} />, resend);
    fireEvent.click(screen.getByRole('button', { name: S.chat.actions.sendAgain }));
    expect(resend).toHaveBeenCalledWith('again @"/a/b.txt" ');
    view.unmount();
    renderInEnv(<PromptItem text="again" />);
    expect(screen.queryByRole('button', { name: S.chat.actions.sendAgain })).toBeNull();
  });

  it('у серых элементов строки действий нет', () => {
    renderInEnv(<PromptItem text="later" state="queued" />, vi.fn());
    expect(screen.queryByTestId('chat-message-actions')).toBeNull();
  });

  it('кусок ответа модели: пока пишется — без строки; дописан — Copy кладёт исходный Markdown', async () => {
    const item = { id: 't', at: AT, kind: 'text' as const, text: '**bold** and `code`', streaming: true };
    const view = renderInEnv(<TextItem item={item} />);
    expect(screen.queryByTestId('chat-message-actions')).toBeNull();
    view.unmount();
    renderInEnv(<TextItem item={{ ...item, streaming: false }} />);
    expect(screen.queryByRole('button', { name: S.chat.actions.sendAgain })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: S.chat.actions.copy }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith('**bold** and `code`');
  });
});
```

(Если у `FeedText` есть ещё обязательные поля — взять их из `core/src/feed/types.ts`; `AT` — существующая константа
файла.)

В `ChatView.test.tsx`, в `describe('ChatView — очередь отправки', ...)` из Задачи 3, дописать:

```ts
  it('Send again под своим сообщением — тот же текст уходит через очередь', async () => {
    bridge.setHandler('pty.send', () => ({ inserted: true, submitted: true, reason: null }));
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'again @"/a/b.txt" '), turn('u1')]);
    fireEvent.click(within(screen.getByTestId('chat-prompt')).getByRole('button', { name: S.chat.actions.sendAgain }));
    await act(async () => {});
    expect(sentTexts()).toEqual(['again @"/a/b.txt" ']);
  });
```

- [ ] **Шаг 2: Строки**

В `shared/strings.ts` в группе `chat:` рядом с `queued:` добавить:

```ts
    /** Строка действий под сообщением (спека 2026-10-16, 3.1). */
    actions: { copy: 'Copy', copied: 'Copied', sendAgain: 'Send again' },
```

- [ ] **Шаг 3: `MessageActions.tsx`**

```tsx
/**
 * Строка действий под сообщением Chat (спека 2026-10-16, 3.1): Copy у своего сообщения и у куска ответа модели,
 * Send again — у своего. Видна при наведении и при фокусе внутри сообщения (родитель с классом `group`); место под
 * неё есть всегда, скрыта она прозрачностью — лента виртуализирована, и высота строки не должна меняться от наведения.
 * После Copy на `COPIED_MS` вместо значка — галочка с подписью «Copied»; отказ буфера — только в консоль.
 */

import { useEffect, useState } from 'react';
import { Check, Copy, RotateCcw } from 'lucide-react';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { Button } from '../../ui/button.js';

/** Сколько держится галочка после Copy. */
export const COPIED_MS = 1500;

export interface MessageActionsProps {
  /** Что кладёт Copy в буфер. */
  copyText: string;
  /** Есть — кнопка Send again. */
  onSendAgain?: () => void;
  align: 'start' | 'end';
}

export function MessageActions({ copyText, onSendAgain, align }: MessageActionsProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = (): void => {
    navigator.clipboard.writeText(copyText).then(
      () => setCopied(true),
      (error: unknown) => console.warn('[parley] clipboard', error),
    );
  };
  const copyLabel = copied ? S.chat.actions.copied : S.chat.actions.copy;
  return (
    <div
      data-testid="chat-message-actions"
      className={cn(
        'flex h-6 items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none',
        align === 'end' ? 'justify-end' : 'justify-start',
      )}
    >
      <Button type="button" size="icon-xs" variant="ghost" aria-label={copyLabel} title={copyLabel} onClick={copy}>
        {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      </Button>
      {onSendAgain === undefined ? null : (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={S.chat.actions.sendAgain}
          title={S.chat.actions.sendAgain}
          onClick={onSendAgain}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Шаг 4: `chat-env.ts` — `resend`**

В `ChatEnv` после `tabId?: string;` добавить:

```ts
  /** Send again под своим сообщением: тот же текст — в очередь отправки Chat (`chat-outbox.ts`). Нет — кнопки нет. */
  resend?: (text: string) => void;
```

и в шапку: «…и Send again под своим сообщением (`resend`)».

- [ ] **Шаг 5: `PromptItem` и `TextItem` — строка действий**

`PromptItem.tsx`: импорт `import { MessageActions } from './MessageActions.js';`. Строку моста заменить на две:

```tsx
  const env = useContext(ChatEnvContext);
  // Мост — только для миниатюр: вне окружения ленты промпт рисуется без них (чипы без картинок).
  const bridge = env?.bridge ?? null;
  const resend = env?.resend;
```

У внешнего `div` из Задачи 3 поменять только `className` — `'flex min-w-0 justify-end'` на
`cn('flex min-w-0 flex-col items-end', !grey && 'group gap-0.5')`: пузырь по-прежнему справа, строка действий — под
ним. Внутренний `div` пузыря (его классы и содержимое) не трогать. Сразу после закрывающего `</div>` пузыря, перед
закрывающим `</div>` внешнего, вставить:

```tsx
      {grey ? null : (
        <MessageActions copyText={text.trim()} align="end" {...(resend === undefined ? {} : { onSendAgain: () => resend(text) })} />
      )}
```
В шапку: «Под настоящим промптом — Copy и Send again (`MessageActions`, спека 2026-10-16, 3.1): Copy кладёт текст как
ушёл, с упоминаниями `@"путь"`, без пустых краёв; Send again ставит его как есть в очередь отправки.»

`TextItem.tsx`: импорт `MessageActions`; корневой `div` получает класс `group`, после пометки `truncated` добавить
`{item.streaming ? null : <MessageActions copyText={item.text} align="start" />}`. В шапку: «Дописанный кусок — с Copy
(исходный Markdown, спека 2026-10-16, 3.1); пока пишется — без строки действий.»

- [ ] **Шаг 6: `ChatView` — `resend` в окружении**

Заменить строку `const env = useMemo<ChatEnv>(...)` на:

```ts
  const env = useMemo<ChatEnv>(
    () => ({
      bridge,
      sessionRef,
      workKey,
      tabId: tab.id,
      resend: (text: string) => {
        chatOutbox.enqueue(sessionKey, { ref: sessionRef, text, deps: sendDeps });
      },
    }),
    [bridge, sessionKey, workKey, tab.id, sendDeps],
  );
```

- [ ] **Шаг 7: Закоммитить**

```bash
git add packages/desktop/src/shared/strings.ts packages/desktop/src/renderer/chat
git commit -m "feat(desktop): Chat — Copy под сообщениями и ответом модели, Send again под своим

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Задача 6: ↑/↓ — история своих сообщений в поле Chat

**Files:**
- Create: `packages/desktop/src/renderer/chat/history.ts`
- Test: `packages/desktop/src/renderer/chat/history.test.ts`
- Modify: `packages/desktop/src/renderer/chat/Composer.tsx`
- Modify: `packages/desktop/src/renderer/chat/ChatView.tsx`
- Test: `packages/desktop/src/renderer/chat/ChatView.test.tsx`

**Interfaces:**
- Consumes: `splitAttachments` (`chat/attachments.ts`); `outboxItems` и `queued` в `ChatView` (Задача 3).
- Produces:
  - `promptHistory(items: readonly FeedItem[], later: readonly string[]): string[]` — новые первыми
  - `ComposerProps.history?: readonly string[]`

- [ ] **Шаг 1: Написать тесты**

`history.test.ts`:

```ts
/** История поля Chat (спека 2026-10-16, 3.2): новые первыми, одинаковые подряд — одно, края обрезаны, пустых нет. */

import { describe, expect, it } from 'vitest';
import type { FeedItem } from '@parley/core';
import { promptHistory } from './history.js';

const AT = '2026-10-16T10:00:00.000Z';
const prompt = (id: string, text: string): FeedItem => ({ id, at: AT, kind: 'prompt', text, images: 0 });
const turn = (id: string): FeedItem => ({ id, at: AT, kind: 'turn', durationMs: 1 });

describe('promptHistory', () => {
  it('промпты ленты и ждущие — новые первыми, ждущие новее ленты', () => {
    expect(promptHistory([prompt('a', 'one'), turn('t'), prompt('b', 'two')], ['three'])).toEqual(['three', 'two', 'one']);
  });

  it('одинаковые подряд схлопываются, не подряд — остаются', () => {
    expect(promptHistory([prompt('a', 'x'), prompt('b', 'x'), prompt('c', 'y'), prompt('d', 'x')], [])).toEqual(['x', 'y', 'x']);
  });

  it('края обрезаны, пустые пропущены', () => {
    expect(promptHistory([prompt('a', '\n  hi \n'), prompt('b', '   ')], [''])).toEqual(['hi']);
  });
});
```

В `ChatView.test.tsx` новый блок (помощники `field`, `type` — как в соседних блоках):

```ts
describe('ChatView — история ↑/↓ (спека 2026-10-16, 3.2)', () => {
  const field = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: S.chat.composer.label }) as HTMLTextAreaElement;
  const type = (value: string): void => {
    fireEvent.change(field(), { target: { value } });
  };
  const key = (name: 'ArrowUp' | 'ArrowDown'): void => {
    fireEvent.keyDown(field(), { key: name });
  };
  const chips = (): string[] => screen.queryAllByTestId('chat-attachment').map((chip) => chip.getAttribute('data-path') ?? '');

  it('↑ в пустом поле — прошлые сообщения от новых к старым, ↓ — обратно, после самого нового — пусто', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'one'), turn('u1'), prompt('p2', 'two'), turn('u2')]);
    key('ArrowUp');
    expect(field().value).toBe('two');
    key('ArrowUp');
    expect(field().value).toBe('one');
    key('ArrowUp');
    expect(field().value).toBe('one');
    key('ArrowDown');
    expect(field().value).toBe('two');
    key('ArrowDown');
    expect(field().value).toBe('');
  });

  it('при любой длине истории n раз ↑ проходят её всю по порядку, n+1-й остаётся на самом старом', () => {
    for (let count = 1; count <= 6; count += 1) {
      const view = renderBody(makeSession('s-01', 'S01'));
      const texts = Array.from({ length: count }, (_, index) => `m${index}`);
      setFeed(texts.flatMap((text, index) => [prompt(`p${index}`, text), turn(`u${index}`)]));
      const seen: string[] = [];
      for (let index = 0; index <= count; index += 1) {
        key('ArrowUp');
        seen.push(field().value);
      }
      expect(seen).toEqual([...[...texts].reverse(), texts[0]]);
      view.unmount();
      useChatUiStore.getState().setDraft(refKey(REF), '');
    }
  });

  it('вызванное начали править — ↑ больше не листает историю', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'one'), turn('u1'), prompt('p2', 'two'), turn('u2')]);
    key('ArrowUp');
    type('two!');
    key('ArrowUp');
    expect(field().value).toBe('two!');
  });

  it('непустой черновик — ↑ его не трогает', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'one'), turn('u1')]);
    type('draft');
    key('ArrowUp');
    expect(field().value).toBe('draft');
  });

  it('открытые подсказки — ↑ их, а не история', async () => {
    withCommands(['clear', 'compact']);
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'one'), turn('u1')]);
    type('/');
    await screen.findByRole('listbox');
    key('ArrowUp');
    expect(field().value).toBe('/');
  });

  it('вызванная команда «/compact» не открывает подсказки: следующее ↑ идёт дальше по истории', async () => {
    withCommands(['clear', 'compact']);
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'one'), turn('u1'), prompt('p2', '/compact'), turn('u2')]);
    // Подсказки команд на деле приходят: без них проверка «попап не открылся» прошла бы впустую.
    type('/comp');
    await screen.findByRole('listbox');
    type('');
    key('ArrowUp');
    expect(field().value).toBe('/compact');
    expect(screen.queryByRole('listbox')).toBeNull();
    key('ArrowUp');
    expect(field().value).toBe('one');
  });

  it('вложения вызванного сообщения встают чипами, текст — без путей', () => {
    renderBody(makeSession('s-01', 'S01'));
    setFeed([prompt('p1', 'see @"/a/b.txt" '), turn('u1')]);
    key('ArrowUp');
    expect(field().value).toBe('see');
    expect(chips()).toEqual(['/a/b.txt']);
    key('ArrowDown');
    expect(field().value).toBe('');
    expect(chips()).toEqual([]);
  });
});
```

`withCommands(names)` — помощник блока: наполняет подсказки команд тем же способом, что и существующий тест
`'Enter при открытом попапе вставляет «/clear »…'` этого файла (стор `useCapabilitiesStore` или обработчик моста —
как там). Свой способ не изобретать: найти тот тест, вынести его подготовку в `withCommands` и звать её в обоих
тестах. `refKey` добавить в импорты, если его нет. Роль попапа — та, что у `SuggestionList` (`listbox`); если она
другая — взять её из `SuggestionList.tsx`.

- [ ] **Шаг 2: `history.ts`**

```ts
/**
 * История поля ввода Chat (спека 2026-10-16, 3.2): свои сообщения сессии, новые первыми, одинаковые подряд — одно.
 * Источник — промпты ленты (переживают перезапуск: лента приходит из журнала), за ними — ещё не пришедшие в ленту
 * (серые «Queued» и очередь окна). Отдельно ничего не хранится.
 */

import type { FeedItem } from '@parley/core';

export function promptHistory(items: readonly FeedItem[], later: readonly string[]): string[] {
  const all = [...items.flatMap((item) => (item.kind === 'prompt' ? [item.text] : [])), ...later]
    .map((text) => text.trim())
    .filter((text) => text !== '');
  const newestFirst: string[] = [];
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const text = all[index] as string;
    if (newestFirst.at(-1) !== text) newestFirst.push(text);
  }
  return newestFirst;
}
```

- [ ] **Шаг 3: `Composer` — ↑/↓ по истории**

1. Импорт: `import { splitAttachments } from './attachments.js';` (рядом с `addAttachments`).
2. В `ComposerProps` добавить:

```ts
  /** Свои прошлые сообщения сессии, новые первыми (`history.ts`): ↑/↓ в пустом поле листают их. */
  history?: readonly string[];
```

   и `history = NO_HISTORY` в деструктуризации, где `const NO_HISTORY: readonly string[] = [];` — на уровне модуля.
3. После строки `const accept = (item: SuggestionItem): void => { ... };` добавить:

```ts
  // История (спека 2026-10-16, 3.2): `historyAt` — индекс вызванного сообщения. Листание идёт, пока в поле ровно оно;
  // правка выключает историю, пустое поле начинает её с самого нового.
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const recalled = historyAt === null ? null : splitAttachments(history[historyAt] ?? '').text;
  const browsing = recalled !== null && text === recalled;
  const empty = text === '' && attachments.length === 0;
  const recall = (index: number | null): void => {
    setHistoryAt(index);
    const entry = index === null ? { text: '', attachments: [] as string[] } : splitAttachments(history[index] ?? '');
    onAttachmentsChange(entry.attachments);
    // Вызванное «/compact» или «@…» не должно открыть подсказки: они перехватили бы следующее ↑.
    setClosedFor(entry.text);
    replaceText({ text: entry.text, caret: entry.text.length });
  };
```

   (Блок должен стоять после объявления `closedFor`/`setClosedFor` и `replaceText`.)
4. В `onKeyDown` после блока `if (open) { ... }` и до строки `// Enter во время набора иероглифов…` вставить:

```ts
    const plainArrow = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
    if (plainArrow && event.key === 'ArrowUp' && (browsing || empty)) {
      const next = browsing ? (historyAt as number) + 1 : 0;
      if (next < history.length) {
        event.preventDefault();
        recall(next);
        return;
      }
      if (browsing) {
        // На самом старом: остаёмся на нём.
        event.preventDefault();
        return;
      }
    }
    if (plainArrow && event.key === 'ArrowDown' && browsing) {
      event.preventDefault();
      recall(historyAt === 0 ? null : (historyAt as number) - 1);
      return;
    }
```

5. В шапку файла добавить абзац: «История (спека 2026-10-16, 3.2): ↑ в пустом поле подставляет прошлое своё сообщение,
   повторное ↑ — более раннее, ↓ — более новое, после самого нового поле снова пустое. Листание идёт, пока в поле
   неизменённое вызванное сообщение; правка выключает его. Подсказки имеют приоритет; у вызванного они закрыты.
   Хвостовые упоминания `@"путь"` встают обратно чипами.»

- [ ] **Шаг 4: `ChatView` — история в поле**

1. Импорт `import { promptHistory } from './history.js';`.
2. После объявления `outbox` (Задача 3) добавить:

```ts
  const history = useMemo(
    () => promptHistory(items, [...queued.map((entry) => entry.text), ...outboxItems.map((item) => item.payload.text)]),
    [items, queued, outboxItems],
  );
```

3. В `<Composer ...>` добавить `history={history}`.

- [ ] **Шаг 5: Закоммитить**

```bash
git add packages/desktop/src/renderer/chat
git commit -m "feat(desktop): Chat — ↑/↓ в пустом поле листают свои прошлые сообщения

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Проверка группы C

- [ ] Run (строго по одному, подряд):
  1. `pnpm --filter @parley/desktop exec vitest run src/renderer/chat src/renderer/components/rooms src/renderer/lib src/renderer/terminal src/english-ui.test.ts`
  2. `pnpm typecheck`
  3. `pnpm exec eslint packages/desktop/src`
  Expected: все зелёные, ошибок типов и линта нет. Красное — исправить в задаче, где код, перезапустить ту же команду.

---

## Живая проверка (человек, после всех групп)

В dev-окне (рецепт — в памяти «Окно без терминала: гибрид»):

1. В комнате добавить агентов и сразу отправить два письма: оба видны серыми («Sending…», «Waiting»), уходят по
   порядку, серые исчезают, когда письма появились в ленте.
2. В Chat во время хода отправить три сообщения подряд: «Waiting» → «Queued», уходят по порядку.
3. В Chat отправить во время запроса разрешения: «Waiting», после ответа на запрос — уходит.
4. Copy под своим сообщением и под ответом модели; Send again; ↑/↓ в пустом поле, в том числе на сообщении с вложением
   и на `/compact`.
