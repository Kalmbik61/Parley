import { describe, expect, it } from 'vitest';
import { METHODS } from '../methods.js';
import {
  REMOTE_EVENTS,
  REMOTE_FORBIDDEN,
  REMOTE_METHODS,
  REMOTE_PARAM_RULES,
  REMOTE_TEXT_LIMIT_BYTES,
  checkRemoteParams,
  isRemoteForbidden,
  projectJobResult,
  projectPhoneJob,
} from './index.js';

const NEW_METHODS = ['jobs.submit', 'jobs.get', 'jobs.cancel', 'jobs.ackInline', 'cards.decide', 'voice.session.prepare', 'voice.session.close', 'voice.usage.get'];
const voiceCorrelation = { voiceSessionId: 'sess_1', delegationId: 'd-1', turnId: 't-1' };

describe('голос и jobs: списки', () => {
  it('новые методы и события в белом списке, каждый метод известен схемам хоста', () => {
    for (const method of NEW_METHODS) {
      expect(REMOTE_METHODS, method).toContain(method);
      expect(Object.keys(METHODS), method).toContain(method);
      expect(Object.keys(REMOTE_PARAM_RULES), method).toContain(method);
    }
    expect(REMOTE_EVENTS).toEqual(expect.arrayContaining(['jobs.changed', 'voice.session.closed']));
  });

  it('isRemoteForbidden не задевает новые имена', () => {
    for (const name of [...NEW_METHODS, 'jobs.changed', 'voice.session.closed']) expect(isRemoteForbidden(name), name).toBe(false);
    // запретный список не получил общих записей `voice.*` и `jobs.*`: лишние методы закрыты белым списком.
    // Исключение — `voice.telemetry.*` (T6): локальные методы острова названы явно и не задевают методы телефона.
    expect(REMOTE_FORBIDDEN.filter((entry) => (entry.startsWith('voice.') || entry.startsWith('jobs.')) && entry !== 'voice.telemetry.*')).toEqual([]);
    expect(isRemoteForbidden('voice.telemetry.record')).toBe(true);
    expect(isRemoteForbidden('voice.session.prepare')).toBe(false);
  });

  it('VO-14: метод вне белого списка под voice.* и jobs.* не пройдёт', () => {
    for (const name of ['voice.settings.set', 'voice.session.list', 'voice.key.set', 'jobs.list', 'jobs.delete', 'jobs.retry', 'assistant.job.changed']) {
      expect((REMOTE_METHODS as readonly string[]).includes(name), name).toBe(false);
      expect((REMOTE_EVENTS as readonly string[]).includes(name), name).toBe(false);
    }
  });
});

describe('голос и jobs: правила параметров', () => {
  it('jobs.submit: текст, ключ и связь', () => {
    const ok = { text: 'run tests', idempotencyKey: 'k-1', correlation: { mode: 'text' } };
    expect(checkRemoteParams('jobs.submit', ok)).toBe(true);
    expect(checkRemoteParams('jobs.submit', { ...ok, correlation: voiceCorrelation })).toBe(true);
    expect(checkRemoteParams('jobs.submit', { ...ok, extra: 1 })).toBe(false);
    // источник поручения телефон не выбирает
    expect(checkRemoteParams('jobs.submit', { ...ok, origin: 'island' })).toBe(false);
    expect(checkRemoteParams('jobs.submit', { ...ok, text: '' })).toBe(false);
    expect(checkRemoteParams('jobs.submit', { ...ok, text: 'я'.repeat(REMOTE_TEXT_LIMIT_BYTES / 2) })).toBe(true);
    expect(checkRemoteParams('jobs.submit', { ...ok, text: 'я'.repeat(REMOTE_TEXT_LIMIT_BYTES / 2 + 1) })).toBe(false);
    expect(checkRemoteParams('jobs.submit', { ...ok, idempotencyKey: 'a b' })).toBe(false);
    expect(checkRemoteParams('jobs.submit', { ...ok, idempotencyKey: 'a'.repeat(65) })).toBe(false);
    expect(checkRemoteParams('jobs.submit', { ...ok, idempotencyKey: 'a'.repeat(64) })).toBe(true);
  });

  it('correlation: строго одна из двух форм', () => {
    const base = { text: 't', idempotencyKey: 'k' };
    expect(checkRemoteParams('jobs.submit', { ...base, correlation: { mode: 'text', delegationId: 'd-1' } })).toBe(false);
    expect(checkRemoteParams('jobs.submit', { ...base, correlation: { delegationId: 'd-1', turnId: 't-1' } })).toBe(false);
    expect(checkRemoteParams('jobs.submit', { ...base, correlation: { ...voiceCorrelation, extra: 1 } })).toBe(false);
    expect(checkRemoteParams('jobs.submit', { ...base, correlation: { ...voiceCorrelation, delegationId: 'bad id!' } })).toBe(false);
    expect(checkRemoteParams('jobs.submit', { ...base })).toBe(false);
  });

  it('jobId и cardId: шаблон идентификатора, лишний ключ — отказ', () => {
    expect(checkRemoteParams('jobs.get', { jobId: 'j-1' })).toBe(true);
    expect(checkRemoteParams('jobs.get', { jobId: 'j 1' })).toBe(false);
    expect(checkRemoteParams('jobs.cancel', { jobId: 'j-1', force: true })).toBe(false);
    expect(checkRemoteParams('jobs.ackInline', { jobId: 'j-1', revision: 3 })).toBe(true);
    expect(checkRemoteParams('jobs.ackInline', { jobId: 'j-1', revision: -1 })).toBe(false);
    expect(checkRemoteParams('cards.decide', { cardId: 'p12', revision: 2, choice: 'send' })).toBe(true);
    expect(checkRemoteParams('cards.decide', { cardId: 'p12', revision: 2, choice: 'maybe' })).toBe(false);
    expect(checkRemoteParams('cards.decide', { cardId: 'p12', revision: 2, choice: 'send', decidedVia: 'island' })).toBe(false);
    expect(checkRemoteParams('cards.decide', { cardId: '', revision: 2, choice: 'send' })).toBe(false);
  });

  it('sdp ≤ 32 КиБ, voice.session.close и voice.usage.get', () => {
    expect(checkRemoteParams('voice.session.prepare', { sdp: 'v=0' })).toBe(true);
    expect(checkRemoteParams('voice.session.prepare', { sdp: 'x'.repeat(32 * 1024) })).toBe(true);
    expect(checkRemoteParams('voice.session.prepare', { sdp: 'x'.repeat(32 * 1024 + 1) })).toBe(false);
    expect(checkRemoteParams('voice.session.prepare', { sdp: 'v=0', key: 'sk-1' })).toBe(false);
    expect(checkRemoteParams('voice.session.prepare', {})).toBe(false);
    expect(checkRemoteParams('voice.session.close', { voiceSessionId: 'sess_1' })).toBe(true);
    expect(checkRemoteParams('voice.session.close', { voiceSessionId: 'sess_1', x: 1 })).toBe(false);
    expect(checkRemoteParams('voice.usage.get', {})).toBe(true);
    expect(checkRemoteParams('voice.usage.get', { day: 'x' })).toBe(false);
  });
});

describe('голос и jobs: проекция job для телефона', () => {
  const job = {
    jobId: 'j-1', idempotencyKey: 'k', origin: 'mobile', correlation: { mode: 'text' }, state: 'running', revision: 2,
    requestText: 'do it', resultSummary: null, provider: 'claude', createdAt: 1, updatedAt: 2, deliveredInline: false,
    argv: ['claude', '--secret'], log: 'LOG LINE', env: { TOKEN: 'x' },
  };

  it('берёт поля по списку: ни argv, ни логов, ни env', () => {
    const projected = projectPhoneJob(job);
    expect(projected).toEqual({
      jobId: 'j-1', origin: 'mobile', state: 'running', revision: 2, requestText: 'do it', resultSummary: null, provider: 'claude',
      createdAt: 1, updatedAt: 2, deliveredInline: false, correlation: { mode: 'text' },
    });
    expect(JSON.stringify(projected)).not.toMatch(/argv|LOG LINE|TOKEN|idempotencyKey/);
  });

  it('не job — null; projectJobResult страхует ответ хоста', () => {
    expect(projectPhoneJob(null)).toBeNull();
    expect(projectPhoneJob({ jobId: 'j' })).toBeNull();
    expect(projectJobResult({ job })).toEqual({ job: projectPhoneJob(job) });
    expect(JSON.stringify(projectJobResult({ job }))).not.toContain('argv');
    expect(projectJobResult(null)).toEqual({ job: null });
  });
});
