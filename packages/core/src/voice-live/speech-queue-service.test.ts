import { describe, expect, it } from 'vitest';
import { createSpeechQueue, INTERRUPT_WINDOW_MS, type ResultInput } from './speech-queue.js';

const PHRASES = { detailsOnScreen: 'Details are on the screen.', clarifying: 'Say briefly that you are clarifying the request.' };
const TEXT = 'Session Design review finished: the migration is ready for your check.';

function setup(live = false) {
  let now = 100_000;
  let liveActive = live;
  const sent: string[] = [];
  const acked: Array<[string, number]> = [];
  const shown: string[] = [];
  const queue = createSpeechQueue({
    now: () => now,
    phrases: PHRASES,
    canAppend: () => true,
    liveActive: () => liveActive,
    effects: {
      send: ({ content }) => {
        sent.push(content);
        return true;
      },
      ack: (requestId, revision) => void acked.push([requestId, revision]),
      cardShown: () => {},
      shown: (item) => void shown.push(item.text),
    },
  });
  const advance = (ms: number): void => {
    now += ms;
    queue.step();
  };
  const result = (patch: Partial<ResultInput> = {}): ResultInput => ({
    requestId: 'sys-1',
    jobId: 'job-1',
    revision: 2,
    state: 'completed',
    text: TEXT,
    gate: 'open',
    heldSince: null,
    stale: false,
    delegationId: null,
    deliveredLive: false,
    origin: 'system',
    ...patch,
  });
  const play = (): void => {
    queue.setModelPlaying(true);
    queue.outputText(sent[sent.length - 1] ?? '');
    advance(2000);
    queue.setModelPlaying(false);
    advance(INTERRUPT_WINDOW_MS + 100);
  };
  return { queue, sent, acked, shown, advance, result, play, setLive: (value: boolean) => void (liveActive = value), item: () => queue.items()[0] };
}

describe('SpeechQueue — служебный итог', () => {
  it('RW-03: Live не активен → shown сразу: карточка, один вызов обычной озвучки, одна отметка доставки, в Live ничего', () => {
    const h = setup(false);
    h.queue.observe([h.result()]);
    h.advance(0);
    expect(h.item()).toMatchObject({ speech: 'shown', card: 'shown', origin: 'system' });
    expect(h.shown).toEqual([TEXT]);
    expect(h.acked).toEqual([['sys-1', 2]]);
    h.advance(60_000);
    expect(h.sent).toEqual([]);
    expect(h.shown).toHaveLength(1);
    expect(h.acked).toHaveLength(1);
  });

  it('Live активен: итог уходит в Live, отметка доставки только после played', () => {
    const h = setup(true);
    h.queue.observe([h.result()]);
    h.advance(1000);
    expect(h.item()?.speech).toBe('submitted');
    expect(h.sent).toHaveLength(1);
    expect(h.acked).toEqual([]);
    h.play();
    expect(h.item()?.speech).toBe('played');
    expect(h.acked).toEqual([['sys-1', 2]]);
    expect(h.shown).toEqual([]);
  });

  it('RW-14/RW-23: Live закрылся в submitted до played → обратно в queued, второй путь один раз, отметка одна', () => {
    const h = setup(true);
    h.queue.observe([h.result()]);
    h.advance(1000);
    expect(h.item()?.speech).toBe('submitted');
    h.setLive(false);
    h.queue.sessionEnded();
    expect(h.item()?.speech).toBe('queued');
    expect(h.acked).toEqual([]);
    h.advance(250);
    expect(h.item()?.speech).toBe('shown');
    expect(h.shown).toEqual([TEXT]);
    expect(h.acked).toEqual([['sys-1', 2]]);
    expect(h.sent).toHaveLength(1);
    h.advance(60_000);
    expect(h.shown).toHaveLength(1);
    expect(h.acked).toHaveLength(1);
  });

  it('Live открылся, пока итог в queued → первый путь, второго нет', () => {
    const h = setup(false);
    h.queue.observe([h.result({ state: 'running' })]);
    h.setLive(true);
    h.queue.observe([h.result()]);
    h.advance(1000);
    expect(h.item()?.speech).toBe('submitted');
    h.play();
    expect(h.shown).toEqual([]);
    expect(h.acked).toHaveLength(1);
  });

  it('shown: следующий старт Live итог не озвучивает', () => {
    const h = setup(false);
    h.queue.observe([h.result()]);
    h.advance(0);
    h.setLive(true);
    h.queue.observe([h.result()]);
    h.advance(10_000);
    expect(h.sent).toEqual([]);
    expect(h.acked).toHaveLength(1);
  });

  it('человеческий итог при неактивном Live ведёт себя как раньше: ждёт, shown не бывает', () => {
    const h = setup(false);
    h.queue.observe([h.result({ origin: 'island' })]);
    h.advance(1000);
    expect(h.item()?.speech).toBe('submitted');
    expect(h.shown).toEqual([]);
    expect(h.acked).toHaveLength(1);
  });

  it('старый хост (нет origin) — как human', () => {
    const h = setup(false);
    const legacy = h.result();
    delete legacy.origin;
    h.queue.observe([legacy]);
    h.advance(1000);
    expect(h.item()).toMatchObject({ origin: 'island', speech: 'submitted' });
    expect(h.shown).toEqual([]);
  });

  it('служебный итог, перебитый человеком при активном Live, остаётся карточкой и отмечается один раз', () => {
    const h = setup(true);
    h.queue.observe([h.result()]);
    h.advance(1000);
    h.queue.setModelPlaying(true);
    h.queue.outputText('Session Design');
    h.advance(500);
    h.queue.setHumanSpeaking(true);
    expect(h.item()).toMatchObject({ speech: 'unknown', card: 'shown' });
    expect(h.acked).toEqual([['sys-1', 2]]);
  });

  it('таблица: порядок событий Live → путь доставки; всегда ровно одна доставка', () => {
    type Order = { name: string; run: (h: ReturnType<typeof setup>) => void; path: 'live' | 'card' };
    const orders: Order[] = [
      { name: 'Live не открывался', path: 'card', run: (h) => h.advance(500) },
      {
        name: 'Live активен весь срок',
        path: 'live',
        run: (h) => {
          h.advance(1000);
          h.play();
        },
      },
      {
        name: 'Live закрылся до отправки (в queued)',
        path: 'card',
        run: (h) => {
          h.setLive(false);
          h.queue.sessionEnded();
          h.advance(500);
        },
      },
      {
        name: 'Live закрылся после отправки до played',
        path: 'card',
        run: (h) => {
          h.advance(1000);
          h.setLive(false);
          h.queue.sessionEnded();
          h.advance(500);
        },
      },
      {
        name: 'Live закрылся, снова открылся — итог уже shown',
        path: 'card',
        run: (h) => {
          h.advance(1000);
          h.setLive(false);
          h.queue.sessionEnded();
          h.advance(250);
          h.setLive(true);
          h.advance(10_000);
        },
      },
    ];
    for (const order of orders) {
      const h = setup(order.name !== 'Live не открывался');
      if (order.name === 'Live не открывался') h.setLive(false);
      h.queue.observe([h.result()]);
      order.run(h);
      const delivered = (h.item()?.speech === 'played' ? 1 : 0) + h.shown.length;
      expect(delivered, order.name).toBe(1);
      expect(h.acked, order.name).toHaveLength(1);
      expect(h.shown.length === 1, order.name).toBe(order.path === 'card');
    }
  });
});
