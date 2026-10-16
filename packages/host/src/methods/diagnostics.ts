import { release } from 'node:os';
import type { SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { Handler } from '../context.js';
import { PROFILE_DEFAULT_SECONDS } from '../diagnostics/profiler.js';
import type { Profiler } from '../diagnostics/profiler.js';
import type { HealthService } from '../health/health-service.js';
import type { PtyManager } from '../pty/pty-manager.js';

/**
 * Методы диагностики хоста (спека 2026-10-16, A2 и A5): мгновенный снимок для архива окна и CPU-профиль
 * по запросу. Окно вызывает их по клику человека; без них (старый хост) архив собирается из файлов и `ps`.
 */
export function createDiagnosticsHandlers(deps: {
  health: HealthService;
  profiler: Profiler;
  pty: Pick<PtyManager, 'list'>;
  activity: Pick<ActivityService, 'get'>;
  isAttached: (ref: SessionRef) => boolean;
}): {
  hostDiagnostics: Handler<'host.diagnostics'>;
  profileStart: Handler<'host.profile.start'>;
  profileStatus: Handler<'host.profile.status'>;
} {
  return {
    hostDiagnostics: async (_params, { host }) => ({
      hostVersion: host.version,
      node: process.version,
      platform: process.platform,
      release: release(),
      arch: process.arch,
      pid: process.pid,
      startedAt: host.startedAt,
      uptimeSec: Math.round(process.uptime()),
      health: deps.health.sample(),
      sessions: deps.pty.list().map((handle) => ({
        ref: handle.ref,
        provider: handle.provider,
        activity: deps.activity.get(handle.ref)?.activity.activity ?? null,
        pid: handle.pid,
        startedAt: new Date(handle.startedAt).toISOString(),
        attached: deps.isAttached(handle.ref),
      })),
      // Список профилей необязателен: ответ `host.diagnostics` важнее ошибки чтения каталога.
      profiles: await deps.profiler.files().catch(() => []),
      profile: deps.profiler.status(),
    }),

    profileStart: async ({ seconds }) => deps.profiler.start(seconds ?? PROFILE_DEFAULT_SECONDS),

    profileStatus: async () => deps.profiler.status(),
  };
}
