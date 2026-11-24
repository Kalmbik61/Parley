import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { qwenAuthHints, type QwenAuthDeps } from './auth-state.js';
import { qwenHome } from './home.js';

const HOME = '/h/.qwen';

function deps(files: Record<string, string>, present: string[] = []): QwenAuthDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async readFile(file) {
      reads.push(file);
      if (file.endsWith('oauth_creds.json')) throw new Error('credential file must not be read');
      const v = files[file];
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    async exists(file) {
      return present.includes(file);
    },
  };
}
const settings = path.join(HOME, 'settings.json');
const oauth = path.join(HOME, 'oauth_creds.json');
const env = { HOME: '/h' };

describe('qwenHome', () => {
  it('uses an absolute QWEN_HOME', () => expect(qwenHome({ QWEN_HOME: '/x/q', HOME: '/h' })).toBe('/x/q'));
  it('ignores a relative QWEN_HOME', () => expect(qwenHome({ QWEN_HOME: 'rel', HOME: '/h' })).toBe(HOME));
  it('defaults to HOME/.qwen', () => expect(qwenHome({ HOME: '/h' })).toBe(HOME));
});

describe('qwenAuthHints', () => {
  it('configured wins and reports the model', async () => {
    const d = deps({ [settings]: JSON.stringify({ security: { auth: { selectedType: 'openai' } }, model: { name: 'qwen3' } }) }, [oauth]);
    const r = await qwenAuthHints({ ...env, OPENAI_API_KEY: 'k' }, d);
    expect(r).toEqual({ selectedType: 'openai', model: 'qwen3', oauthFilePresent: true, envKeyPresent: true, hint: 'configured' });
  });
  it('qwen-account', async () => {
    expect((await qwenAuthHints({ ...env, OPENAI_API_KEY: 'k' }, deps({}, [oauth]))).hint).toBe('qwen-account');
  });
  it('env-key', async () => {
    expect((await qwenAuthHints({ ...env, OPENAI_API_KEY: 'k' }, deps({}))).hint).toBe('env-key');
  });
  it('not-detected with empty key', async () => {
    const r = await qwenAuthHints({ ...env, OPENAI_API_KEY: '' }, deps({}));
    expect(r).toEqual({ selectedType: null, model: null, oauthFilePresent: false, envKeyPresent: false, hint: 'not-detected' });
  });
  it('uses QWEN_HOME', async () => {
    const f = path.join('/x/q', 'settings.json');
    const r = await qwenAuthHints({ QWEN_HOME: '/x/q', HOME: '/h' }, deps({ [f]: '{"model":{"name":"m"}}' }));
    expect(r.model).toBe('m');
  });
  it('broken settings gives nulls', async () => {
    const r = await qwenAuthHints(env, deps({ [settings]: '{oops' }));
    expect(r.selectedType).toBeNull();
    expect(r.model).toBeNull();
  });
  it('non-string fields are ignored', async () => {
    const r = await qwenAuthHints(env, deps({ [settings]: '{"model":{"name":5},"security":{"auth":{"selectedType":{}}}}' }));
    expect(r.hint).toBe('not-detected');
  });
  it('never leaks secrets from settings', async () => {
    const secrets = ['SECRET-A', 'SECRET-B', 'SECRET-C', 'ENVKEY-D'];
    const body = JSON.stringify({
      security: { auth: { selectedType: 'openai', apiKey: secrets[0] } },
      env: { OPENAI_API_KEY: secrets[1] },
      modelProviders: [{ apiKey: secrets[2] }],
      model: { name: 'm' },
    });
    const r = await qwenAuthHints({ ...env, OPENAI_API_KEY: secrets[3] }, deps({ [settings]: body }));
    const out = JSON.stringify(r);
    for (const s of secrets) expect(out).not.toContain(s);
  });
  it('never opens oauth_creds.json', async () => {
    const d = deps({}, [oauth]);
    const r = await qwenAuthHints(env, d);
    expect(r.oauthFilePresent).toBe(true);
    expect(d.reads.some((f) => f.endsWith('oauth_creds.json'))).toBe(false);
  });
});
