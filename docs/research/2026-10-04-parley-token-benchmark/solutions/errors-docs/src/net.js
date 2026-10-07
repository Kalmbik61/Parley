import { BenchError } from './errors.js';

export function parseHost(text) {
  return String(text).trim().toLowerCase();
}

/**
 * Разбирает номер порта из текста.
 * @since 1.2.0
 * @throws {E-NET-001} если текст не целое число от 1 до 65535
 */
export function parsePort(text) {
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BenchError('E-NET-001', `bad port: ${text}`);
  }
  return port;
}
