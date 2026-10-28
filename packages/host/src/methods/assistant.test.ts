import { describe, expect, it, vi } from 'vitest';
import { METHODS } from '@parley/protocol';
import type { AssistantService } from '../assistant/assistant-service.js';
import type { RequestInfo } from '../context.js';
import { createAssistantHandlers } from './assistant.js';

const request = {} as RequestInfo;
const call = (handlers: ReturnType<typeof createAssistantHandlers>, name: string, params: unknown = {}): Promise<unknown> =>
  (handlers[name] as unknown as (params: unknown, request: RequestInfo) => Promise<unknown>)(params, request);

describe('createAssistantHandlers', () => {
  it('assistant.configure: род голоса из зеркала доходит до сервиса', async () => {
    const configure = vi.fn();
    const handlers = createAssistantHandlers({ configure } as unknown as AssistantService);
    const params = METHODS['assistant.configure'].parse({ enabled: true, provider: null, model: null, language: 'ru', voiceModel: null, voiceGender: 'male' });
    expect(await call(handlers, 'assistant.configure', params)).toEqual({ ok: true });
    expect(configure).toHaveBeenCalledWith({ enabled: true, provider: null, model: null, language: 'ru', voiceModel: null, voiceGender: 'male' });
  });

  it('assistant.decide передаёт action сервису', async () => {
    const decide = vi.fn().mockResolvedValue({ applied: true, error: null });
    const handlers = createAssistantHandlers({ decide } as unknown as AssistantService);
    const params = METHODS['assistant.decide'].parse({ proposalId: 'p1', decision: 'send', action: 'actions' });
    expect(await call(handlers, 'assistant.decide', params)).toEqual({ applied: true, error: null });
    expect(decide).toHaveBeenCalledWith('p1', 'send', 'actions');
  });

  it('assistant.decide без action: третий аргумент не задан', async () => {
    const decide = vi.fn().mockResolvedValue({ applied: true, error: null });
    const handlers = createAssistantHandlers({ decide } as unknown as AssistantService);
    await call(handlers, 'assistant.decide', METHODS['assistant.decide'].parse({ proposalId: 'p1', decision: 'cancel' }));
    expect(decide).toHaveBeenCalledWith('p1', 'cancel', undefined);
  });

  it('assistant.ask не меняется: рода в параметрах вопроса нет', () => {
    const parsed = METHODS['assistant.ask'].parse({ text: 'x', provider: null, model: null, language: 'ru', voiceGender: 'male' });
    expect(parsed).not.toHaveProperty('voiceGender');
  });
});
