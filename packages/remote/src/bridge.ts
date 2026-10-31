import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parleyHome } from '@parley/core/home';
import { relayUrlFor } from '@parley/protocol/remote';
import { createAuditLog } from './audit.js';
import type { AuditLog } from './audit.js';
import { openRemoteAccess } from './access.js';
import type { RemoteAccess } from './access.js';
import { RemoteConfigError, loadRemoteConfig, saveRemoteConfig } from './config.js';
import { ControlError, createControlServer } from './control.js';
import { createSessionHandler } from './dispatch.js';
import { ensureDir } from './files.js';
import { createHostLink } from './host-link.js';
import type { HostLink } from './host-link.js';
import { createLog } from './log.js';
import type { BridgeLog } from './log.js';
import { BridgeAlreadyRunning, acquirePidLock, releasePidLock } from './pid-lock.js';
import { createPushNotifier } from './push.js';
import { createPushGatewayClient, resolvePushGatewayUrl } from './push-gateway-client.js';
import { remotePaths } from './paths.js';
import type { RemotePaths } from './paths.js';

export interface BridgeProcessOptions {
  /** Дом Parley (`~/.parley`); без него — `parleyHome()`. */
  home?: string;
  /** Имя Мака для окна и hello; без него — имя хоста ОС. */
  hostName?: string;
  /** Рычаги тестов. */
  host?: { socketPath: string; tokenPath: string; backoff?: { initialMs: number; maxMs: number } };
  relayBackoff?: { initialMs: number; maxMs: number };
  /** Только `PARLEY_REMOTE_DEV_LOOPBACK=1`: `127.0.0.1` и `localhost` идут по `ws://` (в релизе relay на петле не бывает). */
  allowLoopbackRelay?: boolean;
  fetch?: typeof fetch;
}

export interface RunningBridge {
  readonly paths: RemotePaths;
  /** Разрешается после полной остановки (сокет `stop`, SIGTERM, `stop()`). */
  readonly closed: Promise<void>;
  stop(): Promise<void>;
}

export function bridgeVersion(): string {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const version = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version.slice(0, 64) : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const hostNameOf = (override: string | undefined): string => (override ?? os.hostname()).replace(/\.local$/, '').slice(0, 256);

/**
 * Собирает мост в один процесс (план A22). Порядок старта: ключи и устройства с диска → сокет управления и обработчики
 * A7 → связь с хостом → связь с relay (приём сессий). Порядок остановки: перестать принимать сессии →
 * `session.closing shutdown` → закрыть relay → закрыть связь с хостом → закрыть сокет управления → `bridge.pid`.
 * Слушает только unix-сокет управления: TCP-портов у моста нет, к relay и шлюзу он только подключается.
 */
export async function startBridge(options: BridgeProcessOptions = {}): Promise<RunningBridge> {
  const paths = remotePaths(options.home ?? parleyHome());
  await ensureDir(paths.dir);
  const log: BridgeLog = createLog({ file: paths.log, archive: paths.logArchive });
  // Единственный экземпляр на дом: замок берётся раньше всего, остальные запуски отказывают.
  try {
    await acquirePidLock(paths.pid);
  } catch (error) {
    if (error instanceof BridgeAlreadyRunning) log.warn('bridge.already_running', { pid: error.pid });
    throw error;
  }
  const undo: Array<() => Promise<void> | void> = [];
  try {
    return await assemble(options, paths, log, undo);
  } catch (error) {
    // Запуск не удался: что успело подняться, закрываем в обратном порядке, замок отдаём.
    log.error('bridge.start-failed', { error });
    for (const step of undo.reverse()) await Promise.resolve(step()).catch(() => undefined);
    await releasePidLock(paths.pid);
    throw error;
  }
}

async function assemble(options: BridgeProcessOptions, paths: RemotePaths, log: BridgeLog, undo: Array<() => Promise<void> | void>): Promise<RunningBridge> {
  const audit: AuditLog = createAuditLog({ file: paths.audit, archive: paths.auditArchive });
  const version = bridgeVersion();
  const hostName = hostNameOf(options.hostName);
  const loopback = options.allowLoopbackRelay ?? false;
  const resolveRelayUrl = (relay: string): string =>
    loopback && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(relay) ? `ws://${relay}` : relayUrlFor(relay, { allowLocal: true });

  // 1. Настройки, ключи и устройства — с диска, до всего остального.
  let config: Awaited<ReturnType<typeof loadRemoteConfig>>;
  try {
    config = await loadRemoteConfig(paths.remoteJson);
  } catch (error) {
    // Неверный `remote.json` — отказ запуска с понятной строкой: какие поля, а не молчаливое отключение push.
    if (error instanceof RemoteConfigError) log.error('remote_json.invalid', { fields: error.fields.join(',') });
    throw error;
  }
  const homeDir = options.home ?? parleyHome();
  const hostPaths = options.host ?? { socketPath: path.join(homeDir, 'host', 'host.sock'), tokenPath: path.join(homeDir, 'host', 'host.token') };

  // Сокет управления создаётся раньше остальных (его `emit` нужен A7), а его обратные вызовы читают их позже: объявлены вперёд.
  /* eslint-disable prefer-const */
  let access!: RemoteAccess;
  let hostLink!: HostLink;
  let notifier!: ReturnType<typeof createPushNotifier>;
  /* eslint-enable prefer-const */
  let stopped: Promise<void> | null = null;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const control = createControlServer({
    socketPath: paths.controlSocket,
    tokenPath: paths.controlToken,
    audit,
    log,
    // Окно ушло — присутствия нет, push шлётся всегда (спека 9.3).
    onClientsChanged: (count) => {
      if (count === 0) notifier?.setPresence(null);
    },
    callbacks: {
      status: () => ({
        running: true,
        host: hostLink.status,
        relay: access.relayState === 'connected' ? 'connected' : access.relayState === 'connecting' ? 'connecting' : 'error',
        relayUrl: access.relay,
        devices: access.devices.list().filter((d) => d.state === 'active').length,
        version,
      }),
      async configure({ relayUrl }) {
        // Файл раньше памяти: перезапуск после сбоя не вернёт прежний адрес.
        await saveRemoteConfig(paths.remoteJson, { ...config, relay: relayUrl });
        config.relay = relayUrl;
        await access.setRelay(relayUrl);
        log.info('bridge.relay_configured');
      },
      presence: ({ state }) => notifier.setPresence(state),
      async pushTest({ deviceId }) {
        const result = await notifier.test(deviceId);
        if (result === 'no-token') throw new ControlError('no_token', 'the device has no push token');
        if (result === 'no-gateway') throw new ControlError('no_gateway', 'no push gateway is configured');
        if (result === 'failed') throw new ControlError('push_failed', 'the push gateway did not accept the request');
      },
      stop: () => void stop(),
    },
  });

  access = await openRemoteAccess({
    keysFile: paths.keysJson,
    devicesFile: paths.devicesJson,
    relay: config.relay,
    hostName,
    audit,
    log,
    emit: (event, data) => control.emit(event, data),
    resolveRelayUrl,
    ...(options.relayBackoff ? { relayBackoff: options.relayBackoff } : {}),
  });
  undo.push(() => access.stop());
  control.register(access.handlers);

  hostLink = createHostLink({
    socketPath: hostPaths.socketPath,
    tokenPath: hostPaths.tokenPath,
    log,
    ...(hostPaths.backoff ? { backoff: hostPaths.backoff } : {}),
  });
  access.setSessionHandler(
    createSessionHandler({
      host: hostLink,
      sessions: access.sessions,
      audit,
      log,
      info: {
        hostId: () => access.hostId,
        hostName,
        bridgeVersion: version,
        hostVersion: () => null,
        minClient: '1.0.0',
        relays: () => (access.relay === null ? [] : [access.relay]),
      },
      deviceName: (deviceId) => access.devices.get(deviceId)?.name ?? '',
    }),
  );
  undo.push(() => hostLink.stop());
  const gatewayUrl = resolvePushGatewayUrl(config.pushGatewayUrl);
  notifier = createPushNotifier({
    host: hostLink,
    devices: access.devices,
    gateway: gatewayUrl === null ? null : createPushGatewayClient({ url: gatewayUrl, log, ...(options.fetch ? { fetch: options.fetch } : {}) }),
    routeId: () => access.keys().routeId,
    log,
  });

  undo.push(() => notifier.stop());

  async function stop(): Promise<void> {
    stopped ??= (async () => {
      log.info('bridge.stopping');
      notifier.stop();
      try {
        // Перестать принимать, `session.closing shutdown`, закрыть relay, дописать устройства.
        await access.stop();
        await hostLink.stop();
      } catch (error) {
        log.error('bridge.stop-failed', { error });
      }
      try {
        await control.close();
      } catch (error) {
        log.error('bridge.control-close-failed', { error });
      }
      await releasePidLock(paths.pid);
      log.info('bridge.stopped');
      resolveClosed();
    })();
    return stopped;
  }

  // 2. Сокет управления (обработчики A7 уже зарегистрированы), затем хост и relay.
  await control.start();
  undo.push(() => control.close());
  log.info('bridge.started', { version });
  hostLink.start();
  access.start();

  return { paths, closed, stop };
}
