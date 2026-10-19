import { describe, expect, it } from 'vitest';
import { isCustomProviderId } from './custom-providers.js';
import { METHODS } from './methods.js';

const valid = {
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
