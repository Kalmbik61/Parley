import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ConsentCard, TrustRecord } from './consents.js';
import { consentMethodSchemas } from './consents.js';
import type { EventData } from './events.js';
import { METHODS } from './methods.js';
import type { Result } from './methods.js';

describe('согласия и доверие к папке: методы окна', () => {
  it('все шесть методов входят в общую таблицу протокола', () => {
    for (const name of Object.keys(consentMethodSchemas)) expect(Object.keys(METHODS)).toContain(name);
    expect(Object.keys(consentMethodSchemas).sort()).toEqual(['consents.decide', 'consents.list', 'trust.check', 'trust.grant', 'trust.list', 'trust.revoke']);
  });

  it('consents.decide принимает allow и deny, отвергает прочее и пустой id', () => {
    const schema = METHODS['consents.decide'];
    expect(schema.safeParse({ id: 'c-01', decision: 'allow' }).success).toBe(true);
    expect(schema.safeParse({ id: 'c-01', decision: 'deny' }).success).toBe(true);
    expect(schema.safeParse({ id: 'c-01', decision: 'maybe' }).success).toBe(false);
    expect(schema.safeParse({ id: '', decision: 'allow' }).success).toBe(false);
  });

  it('trust.grant требует папку и источник из закрытого списка; trust.revoke — папку', () => {
    expect(METHODS['trust.grant'].safeParse({ folder: '/p', by: 'telegram' }).success).toBe(true);
    expect(METHODS['trust.grant'].safeParse({ folder: '/p', by: 'agent' }).success).toBe(false);
    expect(METHODS['trust.grant'].safeParse({ folder: '', by: 'window' }).success).toBe(false);
    expect(METHODS['trust.check'].safeParse({ folder: '/p' }).success).toBe(true);
    expect(METHODS['trust.check'].safeParse({ folder: '' }).success).toBe(false);
    expect(METHODS['trust.check'].safeParse({}).success).toBe(false);
    expect(METHODS['trust.revoke'].safeParse({ folder: '/p' }).success).toBe(true);
    expect(METHODS['trust.revoke'].safeParse({}).success).toBe(false);
    expect(METHODS['consents.list'].safeParse({}).success).toBe(true);
    expect(METHODS['trust.list'].safeParse({}).success).toBe(true);
  });

  it('результаты и событие описаны типами', () => {
    expectTypeOf<Result<'consents.list'>>().toEqualTypeOf<{ items: ConsentCard[] }>();
    expectTypeOf<Result<'consents.decide'>>().toEqualTypeOf<{ applied: boolean; state: ConsentCard['state'] }>();
    expectTypeOf<Result<'trust.list'>>().toEqualTypeOf<{ folders: TrustRecord[] }>();
    expectTypeOf<Result<'trust.check'>>().toEqualTypeOf<{ trusted: boolean }>();
    expectTypeOf<Result<'trust.grant'>>().toEqualTypeOf<{ folder: TrustRecord }>();
    expectTypeOf<Result<'trust.revoke'>>().toEqualTypeOf<{ removed: boolean }>();
    expectTypeOf<EventData<'consents.changed'>>().toEqualTypeOf<{ upsert: ConsentCard[]; removed: string[] }>();
  });
});
