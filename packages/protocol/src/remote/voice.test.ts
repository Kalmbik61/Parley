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
  projectCardsResult,
  projectJobResult,
  projectPhoneCard,
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

describe('карточки помощника на телефоне (T4a)', () => {
  const row = {
    cardId: 'p3',
    revision: 2,
    kind: 'actions',
    state: 'needs_confirmation',
    expiresAt: 99,
    view: {
      action: 'actions',
      id: 'p3',
      target: 'S05 Vera',
      where: 'Parley · my_harnas',
      text: 'Close S05',
      steps: [{ verb: 'wake', line: 'Wake S05', text: null, danger: false }, { verb: 'close', line: 'Close S05', text: null, danger: true }],
    },
    payload: { token: 'SECRET', path: '/Users/x/secret', argv: ['rm'] },
    decidedVia: 'island',
    argv: ['x'],
  };

  it('cards.list и cards.changed в белых списках, assistant.* по-прежнему закрыт', () => {
    expect(REMOTE_METHODS).toContain('cards.list');
    expect(REMOTE_EVENTS).toContain('cards.changed');
    expect(Object.keys(METHODS)).toContain('cards.list');
    expect(isRemoteForbidden('cards.list')).toBe(false);
    expect(isRemoteForbidden('cards.changed')).toBe(false);
    for (const name of ['assistant.card.changed', 'assistant.decide', 'assistant.state', 'assistant.ask']) {
      expect(isRemoteForbidden(name), name).toBe(true);
      expect(REMOTE_METHODS).not.toContain(name);
      expect(REMOTE_EVENTS).not.toContain(name);
    }
  });

  it('cards.list: параметры строгие, лишний ключ — bad_request', () => {
    expect(checkRemoteParams('cards.list', {})).toBe(true);
    expect(checkRemoteParams('cards.list', { all: true })).toBe(false);
    expect(checkRemoteParams('cards.list', null)).toBe(false);
  });

  it('проекция: лишние поля отброшены, dangerous по шагам, jobId только когда он есть', () => {
    const card = projectPhoneCard({ ...row, jobId: 'job-7' });
    expect(card).toEqual({ cardId: 'p3', revision: 2, kind: 'actions', state: 'needs_confirmation', title: 'S05 Vera · Parley · my_harnas', text: 'Close S05', dangerous: true, expiresAt: 99, jobId: 'job-7' });
    const json = JSON.stringify(card);
    for (const leak of ['SECRET', '/Users/x', 'argv', 'decidedVia', 'payload']) expect(json).not.toContain(leak);
    expect(projectPhoneCard(row)).not.toHaveProperty('jobId');
    expect(projectPhoneCard({ ...row, view: { ...row.view, steps: [{ danger: false }] } })).toMatchObject({ dangerous: false });
    expect(projectPhoneCard({ ...row, view: { target: 'A', where: 'B', text: 'письмо' } })).toMatchObject({ dangerous: false });
  });

  it('проекция: title ≤ 120 и text ≤ 280 знаков с «…»; не карточка и неизвестное состояние — null', () => {
    const long = projectPhoneCard({ ...row, view: { target: 'т'.repeat(200), where: 'w', text: 'я'.repeat(500) } });
    expect(Array.from(long?.title ?? '')).toHaveLength(120);
    expect(long?.title.endsWith('…')).toBe(true);
    expect(Array.from(long?.text ?? '')).toHaveLength(280);
    expect(long?.text.endsWith('…')).toBe(true);
    expect(projectPhoneCard(null)).toBeNull();
    expect(projectPhoneCard({ ...row, state: 'active' })).toBeNull();
  });

  it('projectCardsResult срезает лишнее и выбрасывает негодные карточки', () => {
    const good = projectPhoneCard(row)!;
    expect(projectCardsResult({ cards: [{ ...good, payload: { token: 'T' } }, { nope: 1 }] })).toEqual({ cards: [good] });
    expect(projectCardsResult(null)).toEqual({ cards: [] });
  });
});
