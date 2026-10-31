import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createApnsClient } from './apns.js';
import { createJwtProvider } from './jwt.js';
import { Limiter } from './limits.js';
import { createGatewayServer } from './server.js';

export interface Config {
  keyPem: string;
  keyId: string;
  teamId: string;
  topic: string;
  port: number;
  host: string;
  trustProxy: boolean;
}

/** Ключ, Key ID, Team ID и тема — из окружения; без любого из них сервис не стартует. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  let keyPem = env.APNS_KEY?.replace(/\\n/g, '\n').trim();
  if (!keyPem) {
    const path = env.APNS_KEY_PATH?.trim();
    if (!path) throw new Error('APNS_KEY or APNS_KEY_PATH is required');
    try {
      keyPem = readFileSync(path, 'utf8');
    } catch {
      throw new Error('APNS_KEY_PATH is not readable');
    }
  }
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT is invalid');
  return {
    keyPem,
    keyId: need('APNS_KEY_ID'),
    teamId: need('APNS_TEAM_ID'),
    topic: need('APNS_TOPIC'),
    port,
    host: env.HOST?.trim() || '0.0.0.0',
    trustProxy: env.TRUST_PROXY === '1',
  };
}

function main(): void {
  let cfg: Config;
  let jwt: () => string;
  try {
    cfg = loadConfig(process.env);
    jwt = createJwtProvider({ keyPem: cfg.keyPem, keyId: cfg.keyId, teamId: cfg.teamId });
  } catch (e) {
    console.error(`push-gateway: ${e instanceof Error ? e.message : 'bad configuration'}`);
    process.exit(1);
  }
  const apns = createApnsClient({ topic: cfg.topic, jwt });
  const server = createGatewayServer({
    apns,
    limiter: new Limiter(),
    trustProxy: cfg.trustProxy,
    log: (line) => console.log(line),
  });
  server.listen(cfg.port, cfg.host, () => console.log('push-gateway: listening'));
  const stop = () => {
    apns.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
