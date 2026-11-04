import { describe, expect, it } from 'vitest';
import { createAckTracker } from './ack.js';
import {
  CARD_AFTER_MS,
  createSpeechQueue,
  estimateTokens,
  HELD_CLARIFY_MS,
  INTERRUPT_WINDOW_MS,
  MAX_AUDIO_MS,
  TRANSCRIPT_GRACE_MS,
  overlaps,
  PAUSE_MS,
  PLAY_START_TIMEOUT_MS,
  RESULT_TOKEN_LIMIT,
  SEND_GAP_MS,
  shorten,
  type ResultInput,
} from './speech-queue.js';

const PHRASES = { detailsOnScreen: 'Details are on the screen.', clarifying: 'Say briefly that you are clarifying the request.' };

function setup(options: { sendOk?: boolean } = {}) {
  let now = 100_000;
  const sent: Array<{ delegationId: string | null; content: string }> = [];
  const acked: Array<[string, number]> = [];
  const cards: string[] = [];
  let sendOk = options.sendOk ?? true;
  const ack = createAckTracker({ now: () => now });
  const queue = createSpeechQueue({
    now: () => now,
    phrases: PHRASES,
    canAppend: (delegationId, purpose) => ack.canAppend(delegationId, purpose),
    effects: {
      send: (input) => {
        if (!sendOk) return false;
        sent.push(input);
        return true;
      },
      ack: (requestId, revision) => void acked.push([requestId, revision]),
      cardShown: (item) => void cards.push(item.requestId),
    },
  });
  const advance = (ms: number): void => {
    now += ms;
    queue.step();
  };
  const result = (patch: Partial<ResultInput> = {}): ResultInput => ({
    requestId: 'req-1',
    jobId: 'job-1',
    revision: 3,
    state: 'completed',
    text: 'Two rooms are waiting for you: Design review and Billing migration.',
    gate: 'open',
    heldSince: null,
    stale: false,
    delegationId: 'd1',
    deliveredLive: false,
    ...patch,
  });
  /** Модель отвечает на добавленный текст: звук включается, идёт транскрипт, звук гаснет. */
  const modelSpeaks = (text: string, ms = 2000): void => {
    queue.setModelPlaying(true);
    queue.outputText(text);
    advance(ms);
    queue.setModelPlaying(false);
  };
  return { queue, ack, sent, acked, cards, advance, result, modelSpeaks, setSendOk: (value: boolean) => void (sendOk = value), now: () => now };
}

describe('SpeechQueue — условия отправки', () => {
  it('VA-01: подтверждение, другой разговор, итог уходит в паузе', () => {
    const h = setup();
    h.ack.open('d1');
    h.ack.modelPlaying(true); // слышимое подтверждение
    h.queue.setModelPlaying(true);
    h.queue.observe([h.result()]);
    h.advance(500);
    expect(h.sent).toHaveLength(0); // модель говорит
    h.queue.setModelPlaying(false);
    h.ack.modelPlaying(false);
    h.queue.setHumanSpeaking(true); // другая тема
    h.advance(3000);
    expect(h.sent).toHaveLength(0);
    h.queue.setHumanSpeaking(false);
    h.advance(PAUSE_MS - 1);
    expect(h.sent).toHaveLength(0);
    h.advance(1);
    expect(h.sent).toEqual([{ delegationId: 'd1', content: expect.stringContaining('Two rooms are waiting') }]);
    expect(h.queue.items()[0]).toMatchObject({ speech: 'submitted', card: 'hidden' });
    expect(h.acked).toEqual([['req-1', 3]]);
  });

  it('не отправляет, пока открытая делегация ждёт подтверждения; через 2,5 с — отправляет (ack_audible = false)', () => {
    const h = setup();
    h.ack.open('d2');
    h.queue.observe([h.result()]);
    h.advance(PAUSE_MS + 100);
    expect(h.sent).toHaveLength(0);
    h.advance(2500);
    expect(h.sent).toHaveLength(1);
    expect(h.ack.result('d2')).toBe(false);
  });

  it('не отправляет, если Live не принял append, и повторяет позже', () => {
    const h = setup({ sendOk: false });
    h.queue.observe([h.result()]);
    h.advance(PAUSE_MS);
    h.advance(100);
    expect(h.sent).toHaveLength(0);
    expect(h.queue.items()[0]?.speech).toBe('queued');
    expect(h.acked).toEqual([]);
    h.setSendOk(true);
    h.advance(100);
    expect(h.sent).toHaveLength(1);
  });

  it('уже доставленный итог (deliveredLive) и незаконченный job в очередь не попадают', () => {
    const h = setup();
    h.queue.observe([h.result({ deliveredLive: true }), h.result({ requestId: 'req-2', state: 'running' }), h.result({ requestId: 'req-3', state: 'cancelled' })]);
    expect(h.queue.items()).toEqual([]);
  });

  it('итог без текста в очередь не попадает', () => {
    const h = setup();
    h.queue.observe([h.result({ text: '  [[calm]]  ' })]);
    expect(h.queue.items()).toEqual([]);
  });

  it('в Live уходит нормализованный текст: теги и ref-адреса не доходят', () => {
    const h = setup();
    h.queue.observe([h.result({ text: '[[joy]] Room r-22 and session:ab:w-1:s-2 are fine. [hum]' })]);
    h.advance(PAUSE_MS);
    expect(h.sent[0]?.content).toBe('Room комната and участник are fine.');
  });
});

describe('SpeechQueue — ворота, stale, уточнение', () => {
  it('VA-03: итог ждёт, пока ворота held; stale → dropped, не озвучен и не показан', () => {
    const h = setup();
    h.queue.observe([h.result()]);
    h.queue.observe([h.result({ gate: 'held', heldSince: h.now() })]);
    h.advance(10_000);
    expect(h.sent).toHaveLength(0);
    expect(h.queue.items()[0]).toMatchObject({ speech: 'queued', gate: 'held', card: 'hidden' });
    h.queue.observe([h.result({ gate: 'open', stale: true })]);
    h.advance(CARD_AFTER_MS * 2);
    expect(h.queue.items()[0]).toMatchObject({ speech: 'dropped', card: 'hidden' });
    expect(h.sent).toHaveLength(0);
    expect(h.cards).toEqual([]);
    expect(h.acked).toEqual([]);
  });

  it('VA-03 (вариант): завершённый job уже в очереди, ворота закрылись как stale — не озвучен', () => {
    const h = setup();
    h.queue.observe([h.result({ gate: 'held', heldSince: h.now() - 100 })]);
    h.advance(500);
    h.queue.observe([h.result({ gate: 'held', stale: true, heldSince: h.now() })]);
    h.advance(PAUSE_MS * 2);
    expect(h.queue.items()[0]?.speech).toBe('dropped');
    expect(h.sent).toHaveLength(0);
  });

  it('после снятия ворот итог уходит в обычном порядке', () => {
    const h = setup();
    h.queue.observe([h.result({ gate: 'held', heldSince: h.now() })]);
    h.advance(2000);
    h.queue.observe([h.result({ gate: 'open' })]);
    h.advance(1);
    expect(h.sent).toHaveLength(1);
  });

  it('ворота держатся дольше 15 с: одна реплика «уточняю поручение», итог не выпускается', () => {
    const h = setup();
    const heldSince = h.now();
    h.queue.observe([h.result({ gate: 'held', heldSince })]);
    h.advance(HELD_CLARIFY_MS - 1);
    expect(h.sent).toHaveLength(0);
    h.advance(1);
    expect(h.sent).toEqual([{ delegationId: 'd1', content: PHRASES.clarifying }]);
    h.advance(20_000);
    expect(h.sent).toHaveLength(1);
    expect(h.queue.items()[0]).toMatchObject({ speech: 'queued', gate: 'held' });
    expect(h.acked).toEqual([]);
    // Новое удержание — новая реплика.
    h.queue.observe([h.result({ gate: 'held', heldSince: h.now() })]);
    h.advance(HELD_CLARIFY_MS + SEND_GAP_MS);
    expect(h.sent).toHaveLength(2);
  });

  it('реплика «уточняю» не перебивает человека', () => {
    const h = setup();
    h.queue.observe([h.result({ gate: 'held', heldSince: h.now() })]);
    h.queue.setHumanSpeaking(true);
    h.advance(HELD_CLARIFY_MS + 5000);
    expect(h.sent).toHaveLength(0);
    h.queue.setHumanSpeaking(false);
    h.advance(PAUSE_MS);
    expect(h.sent).toHaveLength(1);
  });
});

describe('SpeechQueue — воспроизведение и карточка', () => {
  it('played: звук на треке и пересечение с выходным транскриптом', () => {
    const h = setup();
    h.queue.observe([h.result()]);
    h.advance(PAUSE_MS);
    expect(h.queue.items()[0]?.speech).toBe('submitted');
    h.modelSpeaks('Two rooms are waiting: Design review [h');
    h.queue.outputText('um] and Billing migration.');
    h.advance(INTERRUPT_WINDOW_MS - 1);
    expect(h.queue.items()[0]?.speech).toBe('submitted');
    h.advance(1);
    expect(h.queue.items()[0]).toMatchObject({ speech: 'played', card: 'hidden' });
  });

  it('VA-02: человек перебил озвучку → unknown, итог остаётся карточкой', () => {
    const h = setup();
    h.queue.observe([h.result()]);
    h.advance(PAUSE_MS);
    h.queue.setModelPlaying(true);
    h.queue.outputText('Two rooms');
    h.advance(800);
    h.queue.setHumanSpeaking(true);
    expect(h.queue.items()[0]).toMatchObject({ speech: 'unknown', card: 'shown' });
    expect(h.cards).toEqual(['req-1']);
    // Перебитый итог не возвращается в очередь.
    h.queue.setModelPlaying(false);
    h.queue.setHumanSpeaking(false);
    h.advance(10_000);
    expect(h.sent).toHaveLength(1);
  });

  it('звук погас раньше сигнала речи человека (в пределах окна) — тоже перебивание', () => {
    const h = setup();
    h.queue.observe([h.result()]);
    h.advance(PAUSE_MS);
    h.queue.setModelPlaying(true);
    h.queue.outputText('Two rooms are waiting');
    h.advance(500);
    h.queue.setModelPlaying(false);
    h.advance(300);
    h.queue.setHumanSpeaking(true);
    expect(h.queue.items()[0]?.speech).toBe('unknown');
  });

  it('звук → пауза 600 мс → звук → конец: played только после последнего конца', () => {
    const h = setup();
    h.queue.observe([h.result()]);
    h.advance(PAUSE_MS);
    h.queue.setModelPlaying(true);
    h.queue.outputText('Two rooms are waiting: Design review');
    h.advance(1500);
    h.queue.setModelPlaying(false);
    h.advance(600);
    h.queue.setModelPlaying(true); // возобновилось: старый конец недействителен
    h.queue.outputText(' and Billing migration.');
    h.advance(INTERRUPT_WINDOW_MS + 500); // по старому концу уже прошла бы 1 с
    expect(h.queue.items()[0]?.speech).toBe('submitted');
    h.queue.setModelPlaying(false);
    h.advance(INTERRUPT_WINDOW_MS - 1);
    expect(h.queue.items()[0]?.speech).toBe('submitted');
    h.advance(1);
    expect(h.queue.items()[0]).toMatchObject({ speech: 'played', card: 'hidden' });
  });

  it('тот же сценарий без пересечения транскрипта: unknown через 3 с после последнего конца, не раньше', () => {
    const h = setup();
    h.queue.observe([h.result()]);
    h.advance(PAUSE_MS);
    h.queue.setModelPlaying(true);
    h.queue.outputText('Sure, anything else?');
    h.advance(1500);
    h.queue.setModelPlaying(false);
    h.advance(600);
    h.queue.setModelPlaying(true);
    h.advance(TRANSCRIPT_GRACE_MS + 1000); // от старого конца давно прошло 3 с, но звук идёт
    expect(h.queue.items()[0]?.speech).toBe('submitted');
    h.queue.setModelPlaying(false);
    h.advance(TRANSCRIPT_GRACE_MS - 1);
    expect(h.queue.items()[0]?.speech).toBe('submitted');
    h.advance(1);
    expect(h.queue.items()[0]).toMatchObject({ speech: 'unknown', card: 'shown' });
  });

  it('человек перебил возобновившийся звук → unknown и карточка (VA-02)', () => {
    const h = setup();
    h.queue.observe([h.result()]);
    h.advance(PAUSE_MS);
    h.queue.setModelPlaying(true);
    h.advance(800);
    h.queue.setModelPlaying(false);
    h.advance(600);
    h.queue.setModelPlaying(true);
    h.queue.outputText('Two rooms are waiting');
    h.advance(300);
    h.queue.setHumanSpeaking(true);
    expect(h.queue.items()[0]).toMatchObject({ speech: 'unknown', card: 'shown' });
  });

  it('непрерывный звук дольше MAX_AUDIO_MS: итог остаётся карточкой (unknown)', () => {
    const h = setup();
    h.queue.observe([h.result()]);
    h.advance(PAUSE_MS);
    h.queue.setModelPlaying(true);
    h.advance(MAX_AUDIO_MS - 250);
    expect(h.queue.items()[0]?.speech).toBe('submitted');
    h.advance(250);
    expect(h.queue.items()[0]).toMatchObject({ speech: 'unknown', card: 'shown' });
  });

  it('звук не начался за PLAY_START_TIMEOUT_MS → unknown + карточка', () => {
    const h = setup();
    h.queue.observe([h.result()]);
    h.advance(PAUSE_MS);
    h.advance(PLAY_START_TIMEOUT_MS - 1);
    expect(h.queue.items()[0]?.speech).toBe('submitted');
    h.advance(1);
    expect(h.queue.items()[0]).toMatchObject({ speech: 'unknown', card: 'shown' });
  });

  it('звук был, но транскрипт не совпал → unknown после грации', () => {
    const h = setup();
    h.queue.observe([h.result()]);
    h.advance(PAUSE_MS);
    h.modelSpeaks('Sure, anything else about the weather?');
    expect(h.queue.items()[0]?.speech).toBe('submitted');
    h.advance(3000);
    expect(h.queue.items()[0]).toMatchObject({ speech: 'unknown', card: 'shown' });
  });

  it('мягкая политика: через 30 с карточка, голос всё ещё ждёт паузу', () => {
    const h = setup();
    h.queue.observe([h.result()]);
    h.queue.setHumanSpeaking(true);
    h.advance(CARD_AFTER_MS - 1);
    expect(h.queue.items()[0]?.card).toBe('hidden');
    h.advance(1);
    expect(h.queue.items()[0]).toMatchObject({ card: 'shown', speech: 'queued' });
    expect(h.sent).toHaveLength(0);
    h.queue.setHumanSpeaking(false);
    h.advance(PAUSE_MS);
    expect(h.sent).toHaveLength(1);
    expect(h.cards).toEqual(['req-1']);
  });

  it('длинный итог: коротко + «подробности на экране», карточка показана', () => {
    const h = setup();
    const long = Array.from({ length: 80 }, (_, index) => `Room number ${index} is waiting for your decision.`).join(' ');
    expect(estimateTokens(long)).toBeGreaterThan(RESULT_TOKEN_LIMIT);
    h.queue.observe([h.result({ text: long })]);
    h.advance(PAUSE_MS);
    const content = h.sent[0]?.content ?? '';
    expect(content.endsWith(PHRASES.detailsOnScreen)).toBe(true);
    expect(estimateTokens(content)).toBeLessThanOrEqual(500);
    expect(content.startsWith('Room number 0 is waiting')).toBe(true);
    expect(h.queue.items()[0]).toMatchObject({ truncated: true, card: 'shown', text: long });
  });

  it('короткий итог не получает приписки', () => {
    const h = setup();
    h.queue.observe([h.result({ text: 'All quiet.' })]);
    h.advance(PAUSE_MS);
    expect(h.sent[0]?.content).toBe('All quiet.');
  });
});

describe('SpeechQueue — несколько Request и сессии', () => {
  it('VA-04: два независимых Request оба доставлены, по одному за паузу', () => {
    const h = setup();
    h.queue.observe([
      h.result({ requestId: 'req-1', delegationId: 'd1', text: 'Rooms are quiet.' }),
      h.result({ requestId: 'req-2', jobId: 'job-2', delegationId: 'd2', text: 'Builds are green.' }),
    ]);
    h.advance(PAUSE_MS);
    expect(h.sent.map((entry) => entry.delegationId)).toEqual(['d1']);
    h.advance(SEND_GAP_MS + 100);
    expect(h.sent).toHaveLength(1); // первый ещё не отзвучал
    h.modelSpeaks('Rooms are quiet.');
    h.advance(INTERRUPT_WINDOW_MS);
    expect(h.queue.items()[0]?.speech).toBe('played');
    h.advance(SEND_GAP_MS);
    expect(h.sent.map((entry) => entry.delegationId)).toEqual(['d1', 'd2']);
    expect(h.acked).toEqual([['req-1', 3], ['req-2', 3]]);
  });

  it('held-Request не задерживает независимый следующий', () => {
    const h = setup();
    h.queue.observe([
      h.result({ requestId: 'req-1', gate: 'held', heldSince: h.now() }),
      h.result({ requestId: 'req-2', jobId: 'job-2', delegationId: 'd2', text: 'Builds are green.' }),
    ]);
    h.advance(PAUSE_MS);
    expect(h.sent.map((entry) => entry.delegationId)).toEqual(['d2']);
  });

  it('VA-07: восстановление — итог без делегации уходит с delegation_id = null', () => {
    const h = setup();
    h.queue.observe([h.result({ delegationId: null })]);
    h.advance(PAUSE_MS);
    expect(h.sent[0]?.delegationId).toBeNull();
  });

  it('закрытие сессии: отправленное без доказательства → unknown + карточка; ожидающие теряют делегацию', () => {
    const h = setup();
    h.queue.observe([h.result(), h.result({ requestId: 'req-2', jobId: 'job-2', delegationId: 'd2', text: 'Another one.' })]);
    h.advance(PAUSE_MS);
    h.queue.sessionEnded();
    const items = h.queue.items();
    expect(items[0]).toMatchObject({ speech: 'unknown', card: 'shown' });
    expect(items[1]).toMatchObject({ speech: 'queued', delegationId: null });
  });

  it('привязка к делегации дописывается, если вид пришёл раньше моста', () => {
    const h = setup();
    h.queue.observe([h.result({ delegationId: null })]);
    h.queue.observe([h.result({ delegationId: 'd1' })]);
    h.advance(PAUSE_MS);
    expect(h.sent[0]?.delegationId).toBe('d1');
  });

  it('обновление ревизии ожидающего итога подменяет текст и ревизию', () => {
    const h = setup();
    h.queue.observe([h.result({ revision: 3, text: 'Old answer.' })]);
    h.queue.observe([h.result({ revision: 5, text: 'Fresh answer.' })]);
    h.advance(PAUSE_MS);
    expect(h.sent[0]?.content).toBe('Fresh answer.');
    expect(h.acked).toEqual([['req-1', 5]]);
  });
});

describe('helpers', () => {
  it('shorten режет по границе предложения', () => {
    const text = Array.from({ length: 100 }, (_, index) => `Sentence ${index} is here.`).join(' ');
    const out = shorten(text, 50) ?? '';
    expect(out.endsWith('here.')).toBe(true);
    expect(estimateTokens(out)).toBeLessThanOrEqual(50);
    expect(shorten('Short.', 50)).toBeNull();
  });

  it('shorten режет одно длинное предложение по знакам', () => {
    const out = shorten('word '.repeat(2000), 40) ?? '';
    expect(out.length).toBeGreaterThan(0);
    expect(estimateTokens(out)).toBeLessThanOrEqual(40);
  });

  it('overlaps: сокращённый пересказ проходит, посторонняя речь — нет', () => {
    const spoken = 'Two rooms are waiting for you: Design review and Billing migration.';
    expect(overlaps(spoken, 'Two rooms waiting, Design review first')).toBe(true);
    expect(overlaps(spoken, 'Sure, anything else about the weather?')).toBe(false);
    expect(overlaps(spoken, '')).toBe(false);
  });
});
