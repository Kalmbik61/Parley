import { describe, expect, it, vi } from 'vitest';
import { createAssistantStore, HOST_IDLE, type AssistantDeps } from './store.js';

const CONFIG = { enabled: true, provider: null, model: null, language: 'ru' as const, hotkey: 'Alt+Space', voice: { enabled: true, model: 'small' as const } };
function setup(over: Partial<AssistantDeps> = {}) {
  const store = createAssistantStore();
  const deps: AssistantDeps = {
    call: vi.fn().mockResolvedValue({ ok: true, applied: true, error: null }),
    keyboard: vi.fn(),
    config: () => CONFIG,
    listen: vi.fn(() => null),
    ...over,
  };
  store.getState().configure(deps);
  return { store, deps };
}

describe('стор помощника', () => {
  it('openMode берёт клавиатуру; close отдаёт и отменяет ход', async () => {
    const { store, deps } = setup();
    store.getState().openMode({ listen: false });
    expect(store.getState().open).toBe(true);
    expect(deps.keyboard).toHaveBeenLastCalledWith(true);
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', turn: 1 });
    store.getState().close();
    expect(store.getState().open).toBe(false);
    expect(deps.keyboard).toHaveBeenLastCalledWith(false);
    expect(deps.call).toHaveBeenCalledWith('assistant.cancel', {});
  });
  it('submit — вопрос с настройками провайдера и языка', async () => {
    const { store, deps } = setup();
    await store.getState().submit('  кто работает?  ');
    expect(deps.call).toHaveBeenCalledWith('assistant.ask', { text: 'кто работает?', provider: null, model: null, language: 'ru', askId: expect.any(String) });
  });
  it('«да» при карточке — решение, а не вопрос', async () => {
    const { store, deps } = setup();
    store.getState().applyHost({ ...HOST_IDLE, phase: 'awaiting-confirm', proposal: { id: 'p1', target: 'Auth', where: 'Parley · x', kind: 'note', text: 't', wake: false }, turn: 1 });
    await store.getState().submit('Да, отправляй');
    expect(deps.call).toHaveBeenCalledWith('assistant.decide', { proposalId: 'p1', decision: 'send' });
    expect(deps.call).not.toHaveBeenCalledWith('assistant.ask', expect.anything());
  });
  it('ответ раскрывает свёрнутый вид', () => {
    const { store } = setup();
    store.getState().openMode({ listen: false });
    store.getState().collapse();
    store.getState().applyHost({ ...HOST_IDLE, phase: 'answering', answer: 'a', turn: 1 });
    expect(store.getState().collapsed).toBe(false);
  });
  it('голос выключен — подсказка, а не запись', () => {
    const { store } = setup();
    store.getState().openMode({ listen: true });
    expect(store.getState().input).toBe('idle');
    expect(store.getState().notice).toBe('Voice is off — Settings → Voice');
  });
  it('ошибка решения карточки — на карточке', async () => {
    const { store } = setup({ call: vi.fn().mockResolvedValue({ applied: false, error: 'S03 is not running' }) });
    store.getState().applyHost({ ...HOST_IDLE, proposal: { id: 'p1', target: 'S03', where: 'w', kind: null, text: 't', wake: false }, phase: 'awaiting-confirm', turn: 1 });
    await store.getState().decide('send');
    expect(store.getState().cardError).toBe('S03 is not running');
  });
  it('причина закрытия карточки хостом переживает публикацию без карточки; новая карточка её стирает', async () => {
    const { store } = setup({ call: vi.fn().mockResolvedValue({ applied: false, error: 'Already answered' }) });
    const proposal = { id: 'p1', target: 'S03', where: 'w', kind: null, text: 't', wake: false };
    store.getState().applyHost({ ...HOST_IDLE, proposal, phase: 'awaiting-confirm', turn: 1 });
    const deciding = store.getState().decide('send');
    store.getState().applyHost({ ...HOST_IDLE, proposal: null, outcome: 'cancelled', turn: 1 });
    await deciding;
    expect(store.getState().cardError).toBe('Already answered');
    store.getState().applyHost({ ...HOST_IDLE, proposal: null, outcome: 'cancelled', turn: 1 });
    expect(store.getState().cardError).toBe('Already answered');
    store.getState().applyHost({ ...HOST_IDLE, proposal: null, outcome: null, turn: 2 });
    expect(store.getState().cardError).toBeNull();
    store.getState().applyHost({ ...HOST_IDLE, proposal: { ...proposal, id: 'p2' }, phase: 'awaiting-confirm', turn: 2 });
    expect(store.getState().cardError).toBeNull();
  });
  it('ошибка на карточке переживает публикацию с тем же id карточки и стирается новым id', async () => {
    const { store } = setup({ call: vi.fn().mockResolvedValue({ applied: false, error: 'The agent is not ready for the answer yet — try again' }) });
    const proposal = { id: 'p1', target: 'S03', where: 'w', kind: null, text: 't', wake: false };
    store.getState().applyHost({ ...HOST_IDLE, proposal, phase: 'awaiting-confirm', turn: 1 });
    await store.getState().decide('send');
    store.getState().applyHost({ ...HOST_IDLE, proposal, phase: 'awaiting-confirm', turn: 2 });
    expect(store.getState().cardError).toBe('The agent is not ready for the answer yet — try again');
    store.getState().applyHost({ ...HOST_IDLE, proposal: { ...proposal, id: 'p2' }, phase: 'awaiting-confirm', turn: 3 });
    expect(store.getState().cardError).toBeNull();
  });
  it('микрофон кладёт распознанное в поле, не отправляя; таймер выставлен и сброшен', async () => {
    const result = Promise.resolve({ text: 'hello' });
    const { store, deps } = setup({ listen: vi.fn(() => ({ stop: vi.fn(), cancel: vi.fn(), result })) });
    store.getState().toggleListening();
    expect(store.getState().input).toBe('listening');
    expect(store.getState().listenStartedAt).not.toBeNull();
    await result;
    await Promise.resolve();
    expect(store.getState().draft).toBe('hello');
    expect(store.getState().listenStartedAt).toBeNull();
    expect(deps.call).not.toHaveBeenCalledWith('assistant.ask', expect.anything());
  });
  it('вопрос виден сразу (sending) и уходит с askId; снимается, когда хост вернёт этот askId', async () => {
    const { store, deps } = setup();
    store.getState().applyHost({ ...HOST_IDLE, turn: 4, askId: null, instance: 'h1' });
    await store.getState().submit('кто работает?');
    const sending = store.getState().sending!;
    expect(sending).toMatchObject({ text: 'кто работает?', turn: 4, instance: 'h1' });
    expect(deps.call).toHaveBeenCalledWith('assistant.ask', expect.objectContaining({ askId: sending.id }));
    store.getState().applyHost({ ...HOST_IDLE, outcome: 'sent', turn: 5, askId: 'other', instance: 'h1' });
    expect(store.getState().sending).not.toBeNull();
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', question: 'кто работает?', turn: 6, askId: sending.id, instance: 'h1' });
    expect(store.getState().sending).toBeNull();
  });
  it('старый хост askId не шлёт — принятие по смене номера хода', async () => {
    const { store } = setup();
    store.getState().applyHost({ ...HOST_IDLE, turn: 4 });
    await store.getState().submit('кто работает?');
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', turn: 5 });
    expect(store.getState().sending).toBeNull();
  });
  it('хост перезапустился, пока вопрос был в пути, — он и очередь в поле по порядку, подсказка, ничего не уходит само', async () => {
    const { store, deps } = setup();
    store.getState().applyHost({ ...HOST_IDLE, turn: 0, askId: null, instance: 'h1' });
    await store.getState().submit('первое');
    await store.getState().submit('второе');
    store.getState().applyHost({ ...HOST_IDLE, turn: 0, askId: null, instance: 'h2' });
    expect(store.getState()).toMatchObject({ sending: null, queue: [], draft: 'первое второе', notice: 'Not sent — press Enter to try again' });
    expect(deps.call).toHaveBeenCalledTimes(1);
  });
  it('id процесса хоста узнаётся с первым состоянием, если вопрос ушёл раньше', async () => {
    const { store } = setup();
    await store.getState().submit('кто работает?');
    store.getState().applyHost({ ...HOST_IDLE, askId: null, instance: 'h1' });
    expect(store.getState().sending).toMatchObject({ instance: 'h1' });
  });
  it('во время хода сообщения ждут в очереди и уходят одним ходом, когда он кончится; ход не перебивают', async () => {
    const { store, deps } = setup();
    store.getState().applyHost({ ...HOST_IDLE, phase: 'answering', turn: 1 });
    await store.getState().submit('первое');
    await store.getState().submit('второе');
    expect(deps.call).not.toHaveBeenCalled();
    expect(store.getState().queue.map((item) => item.text)).toEqual(['первое', 'второе']);
    store.getState().applyHost({ ...HOST_IDLE, turn: 1 });
    expect(deps.call).toHaveBeenCalledTimes(1);
    expect(deps.call).toHaveBeenCalledWith('assistant.ask', expect.objectContaining({ text: 'первое\n\nвторое' }));
    expect(store.getState().queue).toEqual([]);
  });
  it('пока вопрос в пути, следующий ждёт в очереди', async () => {
    const { store, deps } = setup();
    await store.getState().submit('первое');
    await store.getState().submit('второе');
    expect(deps.call).toHaveBeenCalledTimes(1);
    expect(store.getState().queue.map((item) => item.text)).toEqual(['второе']);
  });
  it('принятый вопрос уводит прошлый обмен в историю; не дошедший — нет; close её чистит', async () => {
    const { store } = setup({ call: vi.fn().mockRejectedValueOnce(new Error('not connected')).mockResolvedValue({ ok: true }) });
    store.getState().openMode({ listen: false });
    store.getState().applyHost({ ...HOST_IDLE, question: 'кто работает?', answer: 'Двое.', turn: 1, askId: 'a0', instance: 'h1' });
    await store.getState().submit('а комната?');
    await vi.waitFor(() => expect(store.getState().sending).toBeNull());
    expect(store.getState().history).toEqual([]);
    await store.getState().submit('а комната?');
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', question: 'а комната?', turn: 2, askId: store.getState().sending!.id, instance: 'h1' });
    expect(store.getState().history).toEqual([{ id: 1, question: 'кто работает?', answer: 'Двое.' }]);
    store.getState().close();
    expect(store.getState().history).toEqual([]);
  });
  it('не дошло — в поле и то, что ждало в очереди, по порядку', async () => {
    let reject: (error: Error) => void = () => {};
    const call = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
    const { store } = setup({ call: call as unknown as AssistantDeps['call'] });
    await store.getState().submit('первое');
    await store.getState().submit('второе');
    reject(new Error('not connected'));
    await vi.waitFor(() => expect(store.getState().sending).toBeNull());
    expect(store.getState()).toMatchObject({ queue: [], draft: 'первое второе' });
  });
  it('длиннее 4000 знаков — подсказка, текст остаётся в поле, ничего не уходит', async () => {
    const { store, deps } = setup();
    await store.getState().submit('x'.repeat(4001));
    expect(store.getState()).toMatchObject({ draft: 'x'.repeat(4001), notice: 'Too long — 4,000 characters at most', queue: [] });
    expect(deps.call).not.toHaveBeenCalled();
  });
  it('close с вопросом в пути отменяет его на хосте', async () => {
    const { store, deps } = setup();
    store.getState().openMode({ listen: false });
    await store.getState().submit('кто работает?');
    store.getState().close();
    expect(deps.call).toHaveBeenCalledWith('assistant.cancel', {});
  });
  it('кнопка микрофона во время хода его не перебивает', () => {
    const { store, deps } = setup({ listen: vi.fn(() => ({ stop: vi.fn(), cancel: vi.fn(), result: new Promise(() => {}) })) });
    store.getState().applyHost({ ...HOST_IDLE, phase: 'answering', turn: 1 });
    store.getState().toggleListening();
    expect(store.getState().input).toBe('listening');
    expect(deps.call).not.toHaveBeenCalledWith('assistant.cancel', {});
  });
  it('хоткей: сказанное уходит одним ходом с тем, что набрали во время хода', async () => {
    let finish: (value: { text: string }) => void = () => {};
    const result = new Promise<{ text: string }>((resolve) => { finish = resolve; });
    const { store, deps } = setup({ listen: vi.fn(() => ({ stop: vi.fn(), cancel: vi.fn(), result })) });
    store.getState().applyHost({ ...HOST_IDLE, phase: 'answering', turn: 1 });
    await store.getState().submit('набрал');
    store.getState().openMode({ listen: true });
    store.getState().applyHost({ ...HOST_IDLE, turn: 1 });
    expect(deps.call).not.toHaveBeenCalledWith('assistant.ask', expect.anything());
    finish({ text: 'сказал' });
    await result;
    await Promise.resolve();
    expect(deps.call).toHaveBeenCalledWith('assistant.ask', expect.objectContaining({ text: 'набрал\n\nсказал' }));
  });
  it('× убирает сообщение из очереди', async () => {
    const { store } = setup();
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', turn: 1 });
    await store.getState().submit('первое');
    await store.getState().submit('второе');
    store.getState().unqueue(store.getState().queue[0]!.id);
    expect(store.getState().queue.map((item) => item.text)).toEqual(['второе']);
  });
  it('очередь длиннее предела ask уходит частями', async () => {
    const { store, deps } = setup();
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', turn: 1 });
    await store.getState().submit('a'.repeat(3000));
    await store.getState().submit('b'.repeat(3000));
    store.getState().applyHost({ ...HOST_IDLE, turn: 1 });
    expect(deps.call).toHaveBeenLastCalledWith('assistant.ask', expect.objectContaining({ text: 'a'.repeat(3000) }));
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', turn: 2 });
    store.getState().applyHost({ ...HOST_IDLE, turn: 2 });
    expect(deps.call).toHaveBeenLastCalledWith('assistant.ask', expect.objectContaining({ text: 'b'.repeat(3000) }));
  });
  it('хост вопрос не принял — текст в поле, подсказка, очередь свободна', async () => {
    const { store } = setup({ call: vi.fn().mockRejectedValue(new Error('not connected')) });
    await store.getState().submit('кто работает?');
    await vi.waitFor(() => expect(store.getState().sending).toBeNull());
    expect(store.getState().draft).toBe('кто работает?');
    expect(store.getState().notice).toBe('Not sent — press Enter to try again');
  });
  it('close очищает очередь', async () => {
    const { store } = setup();
    store.getState().openMode({ listen: false });
    store.getState().applyHost({ ...HOST_IDLE, phase: 'thinking', turn: 1 });
    await store.getState().submit('первое');
    store.getState().close();
    expect(store.getState().queue).toEqual([]);
  });
  it('решение карточки в пути: deciding выставлен, повторное нажатие не шлёт второй раз', async () => {
    let finish: (value: unknown) => void = () => {};
    const call = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { store } = setup({ call: call as unknown as AssistantDeps['call'] });
    store.getState().applyHost({ ...HOST_IDLE, proposal: { id: 'p1', target: 'Auth', where: 'w', kind: 'note', text: 't', wake: false }, phase: 'awaiting-confirm', turn: 1 });
    const first = store.getState().decide('send');
    expect(store.getState().deciding).toBe('send');
    void store.getState().decide('send');
    expect(call).toHaveBeenCalledTimes(1);
    finish({ applied: true, error: null });
    await first;
    expect(store.getState().deciding).toBeNull();
  });
  it('хоткей отправляет распознанное сразу', async () => {
    const result = Promise.resolve({ text: 'hello' });
    const { store, deps } = setup({ listen: vi.fn(() => ({ stop: vi.fn(), cancel: vi.fn(), result })) });
    store.getState().openMode({ listen: true });
    await result;
    await Promise.resolve();
    expect(deps.call).toHaveBeenCalledWith('assistant.ask', expect.objectContaining({ text: 'hello' }));
    expect(store.getState().draft).toBe('');
  });

  it('ответ на напоминание открывает помощника без клавиатуры', () => {
    const { store, deps } = setup();
    store.getState().applyHost({ ...HOST_IDLE, origin: 'reminder', turn: 1, phase: 'answering', answer: 'Room is fine' });
    expect(store.getState().open).toBe(true);
    expect(store.getState().collapsed).toBe(false);
    expect(deps.keyboard).not.toHaveBeenCalled();
  });

  it('ход с origin island закрытого помощника не открывает', () => {
    const { store } = setup();
    store.getState().applyHost({ ...HOST_IDLE, origin: 'island', turn: 1, phase: 'answering', answer: 'Room is fine' });
    expect(store.getState().open).toBe(false);
  });

  it('повторное состояние того же хода после close() не открывает снова', () => {
    const { store } = setup();
    store.getState().applyHost({ ...HOST_IDLE, origin: 'reminder', turn: 1, phase: 'answering', answer: 'Room is fine' });
    store.getState().close();
    store.getState().applyHost({ ...HOST_IDLE, origin: 'reminder', turn: 1, phase: 'idle', answer: 'Room is fine' });
    expect(store.getState().open).toBe(false);
  });
});
