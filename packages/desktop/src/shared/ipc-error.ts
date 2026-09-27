/**
 * Код ошибки через IPC (кусок E.1; тот же интерфейс план 5.2 расширит, а не
 * заведёт заново). `ipcMain.handle` в Electron отдаёт рендереру только
 * `message` брошенного `Error` — остальные поля стираются на границе
 * контекстов (`contextBridge`), поэтому код ошибки протокола (`not_found`,
 * `conflict`, …) едет внутри самого `message` JSON-строкой с меткой
 * `harnas-error:`, а не отдельным полем.
 */

export interface IpcErrorInfo {
  code: string;
  message: string;
}

const MARKER = 'harnas-error:';

/** Main: заворачивает код и сообщение в `Error`, чей `message` несёт метку — этот `Error` и бросает `ipcMain.handle`. */
export function encodeIpcError(info: IpcErrorInfo): Error {
  return new Error(`${MARKER}${JSON.stringify(info)}`);
}

function isIpcErrorInfo(value: unknown): value is IpcErrorInfo {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

/**
 * Рендерер: читает код и сообщение из чего угодно, что могло прилететь как
 * ошибка `bridge.call`/`ipcRenderer.invoke`:
 * 1. Поле `code` прямо на объекте — так отвечает подставной мост
 *    (`test-utils/fake-bridge.ts`), минуя настоящий Electron;
 * 2. Метка `harnas-error:` в тексте сообщения — так приходит настоящая
 *    ошибка: `ipcMain.handle` отдаёт только `message`, а Electron сам
 *    оборачивает его в `Error invoking remote method '…': Error: <message>»,
 *    поэтому метку ищем подстрокой, а не с начала строки;
 * 3. Иначе — чужая ошибка (не наша `encodeIpcError`): общий код `'failed'` с
 *    её же текстом, только в консоль (`console.warn` у вызывающей стороны).
 */
export function decodeIpcError(error: unknown): IpcErrorInfo {
  if (isIpcErrorInfo(error)) return error;

  const raw = error instanceof Error ? error.message : String(error);
  const markerIndex = raw.indexOf(MARKER);
  if (markerIndex !== -1) {
    try {
      const parsed: unknown = JSON.parse(raw.slice(markerIndex + MARKER.length));
      if (isIpcErrorInfo(parsed)) return parsed;
    } catch {
      // Не наш JSON после метки — падаем в общий разбор ниже.
    }
  }

  return { code: 'failed', message: raw };
}
