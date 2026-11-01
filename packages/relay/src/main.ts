import { networkInterfaces } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createLogger } from './log.js';
import { createRelay } from './server.js';
import { Store } from './store.js';

export interface Config {
  port: number;
  host: string;
  dataFile: string | null;
  trustProxy: boolean;
  dev: boolean;
}

/** Первый частный IPv4 Мака: en0 раньше остальных интерфейсов. */
export function lanAddress(ifaces = networkInterfaces()): string | null {
  const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;
  const names = Object.keys(ifaces).sort((a, b) => Number(b === 'en0') - Number(a === 'en0'));
  for (const name of names) {
    for (const i of ifaces[name] ?? []) {
      if (i.family === 'IPv4' && !i.internal && priv.test(i.address)) return i.address;
    }
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: string[], ifaces = networkInterfaces()): Config {
  const dev = argv.includes('--dev');
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT is invalid');
  let host = env.HOST?.trim() || '127.0.0.1';
  if (dev && !env.HOST) {
    const lan = lanAddress(ifaces);
    if (!lan) throw new Error('dev: no private LAN address found; set HOST');
    host = lan;
  }
  // Dev-relay держит состояние в памяти: мост сам шлёт hello и devices после перезапуска.
  const dataFile = env.DATA_FILE?.trim() || (dev ? null : './data/relay.json');
  return { port, host, dataFile, trustProxy: env.TRUST_PROXY === '1', dev };
}

function main(): void {
  let cfg: Config;
  try {
    cfg = loadConfig(process.env, process.argv.slice(2));
  } catch (e) {
    console.error(`relay: ${e instanceof Error ? e.message : 'bad configuration'}`);
    process.exit(1);
  }
  const log = createLogger();
  const store = new Store(cfg.dataFile, Date.now, (code) => log('store_error', { code }));
  const relay = createRelay({ store, log, trustProxy: cfg.trustProxy });
  relay.server.listen(cfg.port, cfg.host, () => {
    const addr = relay.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
    log('listening', { mode: cfg.dev ? 'dev' : 'prod' });
    if (cfg.dev) console.log(`relay (dev, no TLS): ws://${cfg.host}:${port}`);
  });
  const stop = (): void => {
    log('stopped');
    void relay.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
