import { describe, expect, it } from 'vitest';
import { assistantCodexMcp, assistantMcpJson, assistantPrompt, codexInstructionsFile, versionAtLeast } from './launch.js';

const params = { url: 'http://127.0.0.1:5000/assistant', token: 'tok"en', command: '/usr/bin/node', args: ['/app/mcp/server.js'] };

describe('конфиг MCP помощника', () => {
  it('claude: один сервер parley-assistant с адресом и токеном в env', () => {
    const config = JSON.parse(assistantMcpJson(params)) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    expect(Object.keys(config.mcpServers)).toEqual(['parley-assistant']);
    expect(config.mcpServers['parley-assistant']).toMatchObject({ command: '/usr/bin/node', args: ['/app/mcp/server.js'], env: { PARLEY_ASSISTANT_URL: params.url, PARLEY_ASSISTANT_TOKEN: 'tok"en' } });
  });
  it('codex: строка -c с одобрением инструментов и экранированными значениями', () => {
    const value = assistantCodexMcp(params);
    expect(value.startsWith('mcp_servers.parley-assistant={')).toBe(true);
    expect(value).toContain('default_tools_approval_mode="approve"');
    expect(value).toContain('PARLEY_ASSISTANT_TOKEN="tok\\"en"');
  });
  it('codex: файл инструкций', () => {
    expect(codexInstructionsFile('/h/assistant/prompt-ru.md')).toBe('model_instructions_file="/h/assistant/prompt-ru.md"');
  });
});

describe('промпт и версии', () => {
  it('промпт называет язык ответа и метки эмоций', () => {
    expect(assistantPrompt('ru')).toContain('Reply in Russian');
    expect(assistantPrompt('en')).toContain('Reply in English');
    expect(assistantPrompt('ru')).toContain('[[calm]]');
  });
  it('versionAtLeast читает версию из вывода --version', () => {
    expect(versionAtLeast('2.1.300 (Claude Code)', '2.1.300')).toBe(true);
    expect(versionAtLeast('2.1.299 (Claude Code)', '2.1.300')).toBe(false);
    expect(versionAtLeast('codex-cli 0.170.1', '0.162.0')).toBe(true);
    expect(versionAtLeast('нет версии', '0.162.0')).toBe(true);
  });
});
