/** Черновик формы своего провайдера (спека своих провайдеров, 4.3). */
import { describe, expect, it } from 'vitest';
import { CUSTOM_PRESETS } from './custom-presets.js';
import { draftError, draftFromPreset, draftFromProvider, saveParams } from './custom-provider-draft.js';

const kimi = CUSTOM_PRESETS[0]!;
const filled = () => ({ ...draftFromPreset(kimi, kimi.endpoints[0]!), key: 'sk-test' });

describe('custom-presets', () => {
  it('идут в порядке kimi, minimax, qwen, deepseek, openrouter и все на Bearer', () => {
    expect(CUSTOM_PRESETS.map((preset) => preset.id)).toEqual(['kimi', 'minimax', 'qwen', 'deepseek', 'openrouter']);
    for (const preset of CUSTOM_PRESETS) for (const endpoint of preset.endpoints) expect(endpoint.auth).toBe('bearer');
  });
});

describe('draftFromPreset', () => {
  it('подставляет адрес, модели, имя и включает «Bring from Claude Code» (К4)', () => {
    expect(draftFromPreset(kimi, kimi.endpoints[0]!)).toMatchObject({
      id: null, label: 'Kimi', preset: 'kimi', baseUrl: 'https://api.moonshot.ai/anthropic', linkClaude: true, key: '',
    });
  });
  it('«Own address» — пустые поля, preset null, linkClaude включён', () => {
    expect(draftFromPreset(null, null)).toMatchObject({
      id: null, label: '', preset: null, baseUrl: '', auth: 'bearer', linkClaude: true,
      models: { opus: '', sonnet: '', haiku: '', subagent: '' },
    });
  });
});

describe('draftError', () => {
  it('пустое имя', () => {
    expect(draftError({ ...filled(), label: '  ' }, false)).toMatch(/name/i);
  });
  it('http на удалённый адрес — ошибка, на loopback — нет', () => {
    expect(draftError({ ...filled(), baseUrl: 'http://api.example.com/x' }, false)).toMatch(/https/);
    expect(draftError({ ...filled(), baseUrl: 'http://localhost:4000', key: '' }, false)).toBeNull();
  });
  it('незаполненное {WorkspaceId} в адресе — ошибка', () => {
    expect(draftError({ ...filled(), baseUrl: 'https://{WorkspaceId}.x.com/apps/anthropic' }, false)).toMatch(/\{/);
  });
  it('пустой слот без oneModel — ошибка; с oneModel хватает Sonnet', () => {
    const own = { ...draftFromPreset(null, null), label: 'X', baseUrl: 'https://a.example.com', key: 'k' };
    expect(draftError(own, false)).toMatch(/model/i);
    expect(draftError({ ...own, oneModel: true, models: { ...own.models, sonnet: 'm1' } }, false)).toBeNull();
    expect(draftError({ ...own, oneModel: true }, false)).toMatch(/model/i);
  });
  it('новый провайдер без ключа — ошибка, кроме loopback; с сохранённым ключом — нет', () => {
    expect(draftError({ ...filled(), key: '' }, false)).toMatch(/key/i);
    expect(draftError({ ...filled(), key: '' }, true)).toBeNull();
    expect(draftError({ ...filled(), id: 'custom-kimi', key: '' }, false)).toBeNull();
  });
  it('готовый черновик — без ошибки', () => {
    expect(draftError(filled(), false)).toBeNull();
  });
});

describe('saveParams', () => {
  it('oneModel → четыре одинаковых слота; id null у нового', () => {
    const draft = { ...filled(), oneModel: true, models: { opus: 'a', sonnet: 'm', haiku: 'b', subagent: 'c' } };
    expect(saveParams(draft)).toEqual({
      id: null, label: 'Kimi', preset: 'kimi', baseUrl: 'https://api.moonshot.ai/anthropic', auth: 'bearer',
      models: { opus: 'm', sonnet: 'm', haiku: 'm', subagent: 'm' }, contextWindow: 1_000_000, linkClaude: true,
    });
  });
  it('ключ в параметры не попадает; пробелы по краям срезаются', () => {
    const params = saveParams({ ...filled(), label: ' Kimi ', baseUrl: ' https://a.example.com ' });
    expect(JSON.stringify(params)).not.toContain('sk-test');
    expect(params).toMatchObject({ label: 'Kimi', baseUrl: 'https://a.example.com' });
  });
});

describe('draftFromProvider', () => {
  it('читает запись; все слоты равны → oneModel', () => {
    const draft = draftFromProvider({
      id: 'custom-kimi', label: 'Kimi',
      custom: {
        preset: 'kimi', baseUrl: 'https://api.moonshot.ai/anthropic', auth: 'bearer',
        models: { opus: 'm', sonnet: 'm', haiku: 'm', subagent: 'm' }, contextWindow: null, linkClaude: false, folder: '/h/.parley/providers/custom-kimi',
      },
    });
    expect(draft).toMatchObject({ id: 'custom-kimi', preset: 'kimi', oneModel: true, linkClaude: false, key: '' });
  });
});
