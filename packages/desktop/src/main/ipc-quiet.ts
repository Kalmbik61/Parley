import { decodeIpcError } from '../shared/ipc-error.js';

/**
 * Ожидаемые отказы каналов (fix-lane-post, п. 4): окно показывает по ним свой текст, это ответ,
 * а не сбой main — неверная регулярка поиска (`bad_request`), путь вне корней, гонка с агентом.
 * `failed`, `internal` и прочие коды — сбои, их stderr main по-прежнему показывает.
 */
const EXPECTED_CODES = new Set(['bad_request', 'not_found', 'conflict', 'files:denied', 'drops:too-large']);

/** Начало строки, которой Electron сам сообщает об отказе обработчика `ipcMain.handle`. */
const HANDLER_PREFIX = 'Error occurred in handler for ';

/** Аргументы console.error — это Electron сообщает об отказе обработчика с ожидаемым кодом `encodeIpcError`. */
export function isExpectedIpcRefusal(args: readonly unknown[]): boolean {
  const [head, error] = args;
  if (args.length !== 2 || typeof head !== 'string' || !head.startsWith(HANDLER_PREFIX)) return false;
  if (!(error instanceof Error)) return false;
  // Ошибка без метки `parley-error:` декодируется в `failed` — она печатается.
  return EXPECTED_CODES.has(decodeIpcError(error).code);
}

/**
 * Electron печатает в stderr main «Error occurred in handler for '…'» на любой отказ обработчика,
 * и это не настраивается: иначе как ответом-значением вместо броска (смена контракта окна) его не
 * обойти. Поэтому глушится сама строка — только ожидаемый отказ, распознанный по метке кода; если
 * Electron поменяет текст, строка просто снова начнёт печататься.
 */
export function quietExpectedIpcRefusals(target: { error: (...args: unknown[]) => void }): void {
  const original = target.error.bind(target);
  target.error = (...args: unknown[]): void => {
    if (!isExpectedIpcRefusal(args)) original(...args);
  };
}
