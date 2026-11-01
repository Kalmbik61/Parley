// Журнал relay: только закрытый набор событий и числа/коды. Идентификаторы маршрутов и устройств,
// секреты, токены, хэши и IP сюда не попадают — тип поля не даёт передать произвольную строку.
export type LogEvent =
  | 'listening'
  | 'route_created'
  | 'routes_gc'
  | 'host_online'
  | 'host_offline'
  | 'pipe_open'
  | 'pipe_close'
  | 'rejected'
  | 'store_error'
  | 'stopped';

export type LogFields = Partial<Record<'code' | 'reason' | 'mode' | 'bytes' | 'removed', string | number>>;
export type Logger = (event: LogEvent, fields?: LogFields) => void;

export function createLogger(sink: (line: string) => void = (l) => console.log(l)): Logger {
  return (event, fields) => {
    sink(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
  };
}
