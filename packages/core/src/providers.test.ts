import { describe, expect, it } from 'vitest';
import { PROVIDERS, providersWithHistory, runnerCommand } from './providers.js';

describe('реестр провайдеров', () => {
  it('claude возобновляет сессию через --resume', () => {
    expect(runnerCommand('claude', 'сессия-1')).toEqual({
      command: 'claude',
      args: ['--resume', 'сессия-1'],
    });
  });

  it('codex возобновляет сессию подкомандой resume', () => {
    expect(runnerCommand('codex', 'uuid-1')).toEqual({
      command: 'codex',
      args: ['resume', 'uuid-1'],
    });
  });

  it('GLM запускается без аргументов: истории у него нет', () => {
    expect(runnerCommand('glm', 'что-угодно')).toEqual({ command: 'glm', args: [] });
    expect(PROVIDERS.glm.hasHistory).toBe(false);
  });

  it('без id запускается чистая сессия', () => {
    expect(runnerCommand('claude')).toEqual({ command: 'claude', args: [] });
    expect(runnerCommand('codex')).toEqual({ command: 'codex', args: [] });
  });

  it('в списке сессий участвуют только провайдеры с историей', () => {
    expect(
      providersWithHistory()
        .map((p) => p.id)
        .sort(),
    ).toEqual(['claude', 'codex']);
  });

  it('у каждого провайдера есть подпись и команда', () => {
    for (const provider of Object.values(PROVIDERS)) {
      expect(provider.label).not.toBe('');
      expect(provider.runner.command).not.toBe('');
    }
  });
});
