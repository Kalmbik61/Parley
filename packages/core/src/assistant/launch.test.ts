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
  it('метка эмоции — в начале каждого предложения (L3, вариант F спайка B02)', () => {
    const prompt = assistantPrompt('ru');
    expect(prompt).toContain('Begin each sentence with its own mood tag');
    expect(prompt).toContain('A sentence without a tag is a mistake.');
    expect(prompt).toContain('Example: [[joy]] One agent finished. [[calm]] Two are still working.');
    expect(prompt).not.toContain('Start every reply with one mood tag');
  });
  it('спокойствие по умолчанию: пустое и тихое — [[calm]], грусть и злость — только для настоящего сбоя, без извинений (B26 F-B26-2)', () => {
    const prompt = assistantPrompt('ru');
    expect(prompt).toContain('[[calm]] is the default and fits any plain fact.');
    expect(prompt).toContain('Nothing running, nobody waiting, no works or rooms, nothing to report, something you cannot do or do not know: that is normal, say it in [[calm]].');
    expect(prompt).toContain('[[joy]] only for a real success');
    expect(prompt).toContain('[[sad]], or rarely [[anger]], only for a real failure: an error, a failed or blocked agent;');
    expect(prompt).toContain('If unsure, use [[calm]].');
    expect(prompt).toContain('Never apologize, never sound guilty or gloomy about the state of the agents');
    // Пример больше не начинается с радости приветствия: спокойный тон — по умолчанию.
    expect(prompt).not.toContain('[[joy]] Hi!');
  });
  it('строка рода по голосу для трёх родов (G1), по умолчанию — женский', () => {
    const female = '- You speak as a female assistant; in languages with grammatical gender use feminine forms for yourself (in Russian: «я проверила», «подготовила», never «я проверил»).';
    const male = '- You speak as a male assistant; in languages with grammatical gender use masculine forms for yourself (in Russian: «я проверил», «подготовил»).';
    expect(assistantPrompt('ru', 'female')).toContain(female);
    expect(assistantPrompt('ru')).toContain(female);
    expect(assistantPrompt('ru', 'male')).toContain(male);
    expect(assistantPrompt('ru', 'male')).not.toContain('feminine');
    const neutral = assistantPrompt('ru', 'neutral');
    expect(neutral).toContain('- Your voice has no grammatical gender.');
    expect(neutral).toContain('Do not mention this rule.');
    expect(neutral).not.toContain('feminine forms for yourself');
    expect(neutral).not.toContain('masculine');
  });
  it('промпт называет любой язык Whisper по-английски, незнакомый код не роняет', () => {
    expect(assistantPrompt('uk')).toContain('Reply in Ukrainian');
    expect(assistantPrompt('zh')).toContain('Reply in Chinese');
    expect(assistantPrompt('zz')).toContain('Reply in zz');
  });
  it('промпт называет инструменты карточек и напоминаний и не отказывает в одобрении и комнатах', () => {
    const prompt = assistantPrompt('ru');
    for (const name of ['propose_decision', 'propose_room', 'propose_room_decision', 'schedule_check', '[reminder']) expect(prompt).toContain(name);
    expect(prompt).toContain('both choices approve');
    expect(prompt).not.toContain('cannot approve agent requests');
    expect(prompt).not.toContain('create rooms');
  });
  it('versionAtLeast читает версию из вывода --version', () => {
    expect(versionAtLeast('2.1.300 (Claude Code)', '2.1.300')).toBe(true);
    expect(versionAtLeast('2.1.299 (Claude Code)', '2.1.300')).toBe(false);
    expect(versionAtLeast('codex-cli 0.170.1', '0.162.0')).toBe(true);
    expect(versionAtLeast('нет версии', '0.162.0')).toBe(true);
  });
});
