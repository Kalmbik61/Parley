import { homedir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '@parley/core';
import type { RequestInfo } from '../context.js';
import { createCapabilitiesList } from './capabilities.js';

const request = {} as RequestInfo;
const caps: Capabilities = {
  commands: [{ name: 'clear', description: 'x', terminal: false }],
  skills: [{ name: 's', description: null, source: 'user', path: '/p' }],
  agents: [],
};

describe('capabilities.list', () => {
  it('claude: сканер получает домашнюю папку и путь проекта', async () => {
    const scan = vi.fn().mockResolvedValue(caps);
    const result = await createCapabilitiesList(scan)({ projectPath: '/work/p', provider: 'claude' }, request);
    expect(result).toBe(caps);
    expect(scan).toHaveBeenCalledWith({ home: homedir(), projectPath: '/work/p' });
  });

  it('другой провайдер — пустые списки, сканер не зовётся', async () => {
    const scan = vi.fn();
    const result = await createCapabilitiesList(scan)({ projectPath: '/work/p', provider: 'codex' }, request);
    expect(result).toEqual({ commands: [], skills: [], agents: [] });
    expect(scan).not.toHaveBeenCalled();
  });

  it('GLM uses the Claude Code capabilities scanner', async () => {
    const scan = vi.fn().mockResolvedValue(caps);
    const result = await createCapabilitiesList(scan)({ projectPath: '/work/p', provider: 'glm' }, request);
    expect(result).toBe(caps);
    expect(scan).toHaveBeenCalledWith({ home: homedir(), projectPath: '/work/p' });
  });

  it('относительный projectPath — bad_request', async () => {
    const scan = vi.fn();
    await expect(createCapabilitiesList(scan)({ projectPath: 'rel/p', provider: 'claude' }, request)).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(scan).not.toHaveBeenCalled();
  });
});
