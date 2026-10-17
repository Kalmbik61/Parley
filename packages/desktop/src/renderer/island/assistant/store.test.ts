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
    expect(deps.call).toHaveBeenCalledWith('assistant.ask', { text: 'кто работает?', provider: null, model: null, language: 'ru' });
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
  it('хоткей отправляет распознанное сразу', async () => {
    const result = Promise.resolve({ text: 'hello' });
    const { store, deps } = setup({ listen: vi.fn(() => ({ stop: vi.fn(), cancel: vi.fn(), result })) });
    store.getState().openMode({ listen: true });
    await result;
    await Promise.resolve();
    expect(deps.call).toHaveBeenCalledWith('assistant.ask', expect.objectContaining({ text: 'hello' }));
    expect(store.getState().draft).toBe('');
  });
});
