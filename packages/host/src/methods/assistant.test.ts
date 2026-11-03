import { describe, expect, it, vi } from 'vitest';
import { METHODS } from '@parley/protocol';
import type { Jobs } from '../assistant/jobs.js';
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
    expect(decide).toHaveBeenCalledWith('p1', 'send', 'actions', 'island');
  });

  it('assistant.decide без action: третий аргумент не задан', async () => {
    const decide = vi.fn().mockResolvedValue({ applied: true, error: null });
    const handlers = createAssistantHandlers({ decide } as unknown as AssistantService);
    await call(handlers, 'assistant.decide', METHODS['assistant.decide'].parse({ proposalId: 'p1', decision: 'cancel' }));
    expect(decide).toHaveBeenCalledWith('p1', 'cancel', undefined, 'island');
  });

  it('assistant.reissue передаёт id сервису и возвращает новый', async () => {
    const reissue = vi.fn().mockReturnValue({ applied: true, error: null, proposalId: 'p9' });
    const handlers = createAssistantHandlers({ reissue } as unknown as AssistantService);
    expect(await call(handlers, 'assistant.reissue', METHODS['assistant.reissue'].parse({ proposalId: 'p1' }))).toEqual({ applied: true, error: null, proposalId: 'p9' });
    expect(reissue).toHaveBeenCalledWith('p1');
  });

  it('assistant.ask не меняется: рода в параметрах вопроса нет', () => {
    const parsed = METHODS['assistant.ask'].parse({ text: 'x', provider: null, model: null, language: 'ru', voiceGender: 'male' });
    expect(parsed).not.toHaveProperty('voiceGender');
  });

  it('cards.decide: решение с телефона идёт в ядро с via mobile', async () => {
    const decideCard = vi.fn().mockResolvedValue({ applied: true, error: null, reason: 'applied' });
    const handlers = createAssistantHandlers({ decideCard } as unknown as AssistantService);
    const params = METHODS['cards.decide'].parse({ cardId: 'p1', revision: 2, choice: 'send' });
    expect(await call(handlers, 'cards.decide', params)).toEqual({ applied: true, error: null, reason: 'applied' });
    expect(decideCard).toHaveBeenCalledWith({ cardId: 'p1', revision: 2, choice: 'send' }, 'mobile');
  });

  it('jobs.ackInline: передаёт jobs; без jobs - not_found', async () => {
    const ackInline = vi.fn().mockReturnValue({ ok: true, deliveredInline: true, reason: 'acked' });
    const params = METHODS['jobs.ackInline'].parse({ jobId: 'job-1', revision: 4 });
    const withJobs = createAssistantHandlers({} as unknown as AssistantService, { ackInline } as unknown as Jobs);
    expect(await call(withJobs, 'jobs.ackInline', params)).toEqual({ ok: true, deliveredInline: true, reason: 'acked' });
    expect(ackInline).toHaveBeenCalledWith('job-1', 4);
    const without = createAssistantHandlers({} as unknown as AssistantService);
    expect(await call(without, 'jobs.ackInline', params)).toEqual({ ok: false, deliveredInline: false, reason: 'not_found' });
  });
});
