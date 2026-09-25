import type { Handler } from '../context.js';

export const hostInfo: Handler<'host.info'> = async (_params, { host }) => ({
  hostVersion: host.version,
  pid: process.pid,
  startedAt: host.startedAt,
  clients: host.clients().length,
  liveSessions: host.liveSessions(),
});

/** Отвечает сразу, останавливает хост чуть позже — чтобы ответ успел уйти клиенту. */
export const hostShutdown: Handler<'host.shutdown'> = async (_params, { host }) => {
  setTimeout(() => {
    host.shutdown('host.shutdown').catch((error: unknown) => {
      host.log.error('остановка по host.shutdown не удалась', { error: String(error) });
    });
  }, 50);
  return { ok: true };
};
