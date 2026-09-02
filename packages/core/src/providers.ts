import type { Provider } from './session-index.js';

export interface RunnerConfig {
  /**
   * Имя бинаря в PATH. Запускается только то, что уже стоит у пользователя,
   * и только немодифицированным — юридическая граница проекта.
   */
  command: string;
  /**
   * Аргументы для возобновления конкретной сессии. undefined — провайдер
   * не умеет открывать сессию по идентификатору, запускаем без аргументов.
   */
  resumeArgs?: (sessionId: string) => string[];
}

export interface ProviderInfo {
  id: Provider;
  /** Короткая подпись для бейджа провайдера в списке. */
  label: string;
  /** Двухсимвольный маркер для узкой колонки: первой буквы не хватает — Claude и Codex совпали бы. */
  mark: string;
  /** Умеем ли читать историю сессий этого провайдера. */
  hasHistory: boolean;
  runner: RunnerConfig;
}

/**
 * Реестр провайдеров: где брать историю и чем запускать.
 *
 * GLM здесь runner-only: своей истории у него нет (проверено, см.
 * specs/runners.md), поэтому в списке сессий он не появляется, но запустить
 * его в правой панели можно тем же PTY-менеджером.
 */
export const PROVIDERS: Readonly<Record<Provider, ProviderInfo>> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    mark: 'Cl',
    hasHistory: true,
    runner: {
      command: 'claude',
      resumeArgs: (sessionId) => ['--resume', sessionId],
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    mark: 'Cx',
    hasHistory: true,
    runner: {
      // `codex resume <SESSION_ID>` — id или имя сессии, см. CLI самого Codex.
      command: 'codex',
      resumeArgs: (sessionId) => ['resume', sessionId],
    },
  },
  glm: {
    id: 'glm',
    label: 'GLM',
    mark: 'GL',
    hasHistory: false,
    runner: { command: 'glm' },
  },
};

/** Провайдеры, чьи сессии попадают в список. */
export function providersWithHistory(): ProviderInfo[] {
  return Object.values(PROVIDERS).filter((provider) => provider.hasHistory);
}

/** Команда и аргументы для запуска сессии провайдера в PTY. */
export function runnerCommand(
  provider: Provider,
  sessionId?: string,
): { command: string; args: string[] } {
  const { runner } = PROVIDERS[provider];
  const args =
    sessionId === undefined || runner.resumeArgs === undefined ? [] : runner.resumeArgs(sessionId);
  return { command: runner.command, args };
}
