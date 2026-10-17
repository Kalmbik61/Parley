/**
 * Отказ операции агента с кодом протокола; текст читает агент. Вынесено из `agent-ops.ts`, чтобы модули реестра, очереди,
 * чтений и снимка не зависели друг от друга ради одного класса.
 */
import type { BrowserAgentErrorCode } from '@parley/protocol';

export class AgentOpError extends Error {
  readonly code: BrowserAgentErrorCode;

  constructor(code: BrowserAgentErrorCode, message: string) {
    super(message);
    this.name = 'AgentOpError';
    this.code = code;
  }
}
