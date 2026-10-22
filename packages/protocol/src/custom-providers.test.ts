import { describe, expect, expectTypeOf, it } from 'vitest';
import { CODEX_ACCOUNT_PREFIX, isCodexAccountId, isCustomProviderId, isManagedProviderId } from './custom-providers.js';
import type { CustomProviderSaveParams } from './custom-providers.js';
import { METHODS } from './methods.js';
import type { Params } from './methods.js';

const valid = {
  kind: 'endpoint',
  id: 'custom-kimi',
  label: 'Kimi',
  preset: 'kimi',
  baseUrl: 'https://api.moonshot.ai/anthropic',
  auth: 'bearer',
  models: { opus: 'kimi-k3[1m]', sonnet: 'kimi-k3[1m]', haiku: 'kimi-k2.7-code', subagent: 'kimi-k3[1m]' },
  contextWindow: 1000000,
  linkClaude: true,
};

describe('схемы методов своих провайдеров (спека 5, 7)', () => {
  it('saveCustom: принимает запись и id null для нового', () => {
    expect(METHODS['providers.saveCustom'].safeParse(valid).success).toBe(true);
    expect(METHODS['providers.saveCustom'].safeParse({ ...valid, id: null }).success).toBe(true);
  });
  it('saveCustom: отвергает пустой слот, пробел в модели, имя длиннее 40, неизвестный auth', () => {
    for (const bad of [
      { ...valid, models: { ...valid.models, haiku: '' } },
      { ...valid, models: { ...valid.models, opus: 'kimi k3' } },
      { ...valid, label: 'x'.repeat(41) },
      { ...valid, auth: 'basic' },
    ]) expect(METHODS['providers.saveCustom'].safeParse(bad).success).toBe(false);
  });
  it('saveCustom/deleteCustom: отвергает id с выходом из папки и пробелы в адресе', () => {
    expect(METHODS['providers.saveCustom'].safeParse({ ...valid, id: 'custom-/../../../.claude' }).success).toBe(false);
    expect(METHODS['providers.deleteCustom'].safeParse({ id: 'custom-/../x', removeFolder: true }).success).toBe(false);
    expect(METHODS['providers.saveCustom'].safeParse({ ...valid, baseUrl: ' https://a.com ' }).success).toBe(true);
  });
  it('deleteCustom: id и removeFolder', () => {
    expect(METHODS['providers.deleteCustom'].safeParse({ id: 'custom-kimi', removeFolder: false }).success).toBe(true);
    expect(METHODS['providers.deleteCustom'].safeParse({ id: 'custom-kimi' }).success).toBe(false);
  });
  it('isCustomProviderId', () => {
    expect(isCustomProviderId('custom-kimi')).toBe(true);
    expect(isCustomProviderId('glm')).toBe(false);
  });
});

// Подписки (спека подписок 5.1): запись получает вид `kind`, аккаунт — отдельная форма без адреса и ключа.
describe('вид записи своих провайдеров (спека подписок 5.1)', () => {
  const account = { kind: 'claude-account', id: null, label: '', link: true };

  it('saveCustom: запись с адресом принимается и с kind endpoint, и без kind (читается как endpoint)', () => {
    expect(METHODS['providers.saveCustom'].safeParse(valid).success).toBe(true);
    const withoutKind: Record<string, unknown> = { ...valid };
    delete withoutKind.kind;
    const parsed = METHODS['providers.saveCustom'].safeParse(withoutKind);
    expect(parsed.success).toBe(true);
    // Не аккаунт: поля адреса и ключа на месте, вида нет или он endpoint.
    expect(parsed.data).toMatchObject({ id: 'custom-kimi', baseUrl: valid.baseUrl, linkClaude: true });
    expect(parsed.data && 'kind' in parsed.data ? parsed.data.kind : 'endpoint').toBe('endpoint');
    // Без kind нужны поля адреса: форма аккаунта без вида не проходит как endpoint.
    expect(METHODS['providers.saveCustom'].safeParse({ id: null, label: 'Work', link: true }).success).toBe(false);
    expect(METHODS['providers.saveCustom'].safeParse({ ...valid, kind: 'claude-account' }).success).toBe(false);
  });

  it('saveCustom: у формы аккаунта kind обязателен и закрыт', () => {
    const withoutKind: Record<string, unknown> = { ...account };
    delete withoutKind.kind;
    expect(METHODS['providers.saveCustom'].safeParse(withoutKind).success).toBe(false);
    expect(METHODS['providers.saveCustom'].safeParse({ ...withoutKind, id: 'codex-two', label: 'Personal' }).success).toBe(false);
    expect(METHODS['providers.saveCustom'].safeParse({ ...account, kind: undefined }).success).toBe(false);
  });

  it('Params<saveCustom> — честный союз записи с адресом и аккаунта, без приведения (решение 4)', () => {
    expectTypeOf<Params<'providers.saveCustom'>>().toEqualTypeOf<CustomProviderSaveParams>();
  });
  it('saveCustom: принимает аккаунт Claude и Codex, новый (id null) и существующий, с пустым именем', () => {
    expect(METHODS['providers.saveCustom'].safeParse(account).success).toBe(true);
    expect(METHODS['providers.saveCustom'].safeParse({ ...account, id: 'custom-claude-2', label: 'Work', link: false }).success).toBe(true);
    expect(METHODS['providers.saveCustom'].safeParse({ kind: 'codex-account', id: 'codex-two', label: 'Personal', link: true }).success).toBe(true);
  });

  it('saveCustom: аккаунт — имя не длиннее 40 и без управляющих символов, link обязателен, вид закрыт', () => {
    for (const bad of [
      { ...account, label: 'x'.repeat(41) },
      { ...account, label: 'a\nb' },
      { ...account, label: 'a\u0000b' },
      { kind: 'claude-account', id: null, label: '' },
      { ...account, link: 'yes' },
      { ...account, kind: 'gemini-account' },
      { ...account, id: 'custom-/../../x' },
      { ...account, id: 'codex-/../x' },
    ]) expect(METHODS['providers.saveCustom'].safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(METHODS['providers.saveCustom'].safeParse({ ...account, label: 'x'.repeat(40) }).success).toBe(true);
  });

  it('deleteCustom: принимает id аккаунта Codex', () => {
    expect(METHODS['providers.deleteCustom'].safeParse({ id: 'codex-two', removeFolder: true }).success).toBe(true);
    expect(METHODS['providers.deleteCustom'].safeParse({ id: 'codex-/../x', removeFolder: true }).success).toBe(false);
    expect(METHODS['providers.deleteCustom'].safeParse({ id: 'glm', removeFolder: true }).success).toBe(false);
  });

  it('префиксы: codex- не custom-, управляемый id — любой из двух', () => {
    expect(CODEX_ACCOUNT_PREFIX).toBe('codex-');
    expect(isCodexAccountId('codex-two')).toBe(true);
    expect(isCodexAccountId('custom-kimi')).toBe(false);
    expect(isCodexAccountId('codex')).toBe(false);
    expect(isCustomProviderId('codex-two')).toBe(false);
    expect(isManagedProviderId('codex-two')).toBe(true);
    expect(isManagedProviderId('custom-kimi')).toBe(true);
    expect(isManagedProviderId('codex')).toBe(false);
    expect(isManagedProviderId('glm')).toBe(false);
  });
});
