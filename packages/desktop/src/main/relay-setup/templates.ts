import { createHash } from 'node:crypto';
import { isValidImageRef } from './image.js';

/**
 * Files the wizard writes to `/opt/parley-relay/`. `COMPOSE_CADDY` and `CADDYFILE` are copies of
 * `packages/relay/deploy/{compose.yml,Caddyfile}` (the same ones the README gives for a manual install);
 * `templates.test.ts` fails when they drift apart.
 */

export const COMPOSE_CADDY = `# Parley relay behind Caddy. Usage:
#   RELAY_DOMAIN=relay.example.com docker compose up -d
# The relay port is not published: only Caddy listens on the host (80 for the certificate, 443 for the app).
# RELAY_IMAGE, RELAY_HTTP_PORT and RELAY_HTTPS_PORT are optional; the setup wizard sets them in .env.
# The image is built from the repository root: docker build -f packages/relay/Dockerfile -t parley-relay .
services:
  relay:
    image: \${RELAY_IMAGE:-parley-relay}
    restart: unless-stopped
    environment:
      TRUST_PROXY: '1'
    volumes:
      - relay-data:/data
    expose:
      - '8787'
  caddy:
    image: caddy:2.11.7@sha256:36c24ad91a7ff7bc4c87fe22bfa8df3c4b18da0773d73fc12ee2c52b98c0bb7e
    restart: unless-stopped
    depends_on:
      - relay
    environment:
      RELAY_DOMAIN: \${RELAY_DOMAIN:?set RELAY_DOMAIN to the relay host name}
    ports:
      - '\${RELAY_HTTP_PORT:-80}:80'
      - '\${RELAY_HTTPS_PORT:-443}:443'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
volumes:
  relay-data:
  caddy-data:
  caddy-config:
`;

export const CADDYFILE = `# TLS on 443 with an automatic certificate; WebSocket upgrades pass through reverse_proxy as is.
# RELAY_DOMAIN comes from the environment (see compose.yml), for example relay.example.com.
{$RELAY_DOMAIN} {
\treverse_proxy relay:8787
}
`;

/** Port 80 is taken by a web server of the person's: the relay listens on loopback only, their server proxies to it. */
export const COMPOSE_PROXY = `# Parley relay behind your own web server: it listens on 127.0.0.1 only.
services:
  relay:
    image: \${RELAY_IMAGE:?set RELAY_IMAGE}
    restart: unless-stopped
    environment:
      TRUST_PROXY: '1'
    volumes:
      - relay-data:/data
    ports:
      - '127.0.0.1:\${RELAY_PROXY_PORT:-8787}:8787'
volumes:
  relay-data:
`;

/** Compose file for a relay that joins a Docker network of the person's web server (spec 6.1). The service is
 * `parley-relay`, not `relay`: compose makes the service name a DNS name in every network of the service. */
export const COMPOSE_NETWORK = `# Parley relay in the Docker network of your web server: no ports are published, your server proxies to parley-relay:8787.
services:
  parley-relay:
    image: \${RELAY_IMAGE:?set RELAY_IMAGE}
    restart: unless-stopped
    environment:
      TRUST_PROXY: '1'
    volumes:
      - relay-data:/data
    expose:
      - '8787'
    networks:
      - web
volumes:
  relay-data:
networks:
  web:
    name: \${RELAY_NETWORK:?set RELAY_NETWORK}
    external: true
`;

export type SetupMode = 'caddy' | 'caddy-site' | 'proxy';

export interface EnvValues {
  mode: SetupMode;
  domain: string;
  image: string;
  httpPort: number;
  httpsPort: number;
  proxyPort: number;
  /** `caddy-site`: where the site was added. */
  webRuntime?: 'docker' | 'host';
  webFile?: string;
  webEdit?: 'file' | 'block';
  /** Docker network of the person's web server the relay joins (`caddy-site` docker, `proxy` behind a container). */
  network?: string;
  acmePort?: number;
}

/** `.env` is also the wizard's memory of what it installed (read back by the next run's probe). */
export function renderEnv(values: EnvValues): string {
  if (!isValidImageRef(values.image)) throw new Error('invalid image reference');
  return [
    `RELAY_DOMAIN=${values.domain}`,
    `RELAY_IMAGE=${values.image}`,
    `RELAY_MODE=${values.mode}`,
    `RELAY_HTTP_PORT=${values.httpPort}`,
    `RELAY_HTTPS_PORT=${values.httpsPort}`,
    `RELAY_PROXY_PORT=${values.proxyPort}`,
    ...(values.webRuntime !== undefined ? [`RELAY_WEB_RUNTIME=${values.webRuntime}`] : []),
    ...(values.webFile !== undefined ? [`RELAY_WEB_FILE=${values.webFile}`] : []),
    ...(values.webEdit !== undefined ? [`RELAY_WEB_EDIT=${values.webEdit}`] : []),
    ...(values.network !== undefined ? [`RELAY_NETWORK=${values.network}`] : []),
    ...(values.acmePort !== undefined ? [`RELAY_ACME_PORT=${values.acmePort}`] : []),
    '',
  ].join('\n');
}

export interface ManagedFile {
  name: 'compose.yml' | 'Caddyfile' | '.env';
  content: string;
  mode: '0644' | '0600';
  /** The screen shows the content; `.env` is listed by name only. */
  showContent: boolean;
}

export function managedFiles(values: EnvValues): ManagedFile[] {
  const env: ManagedFile = { name: '.env', content: renderEnv(values), mode: '0600', showContent: false };
  if (values.mode !== 'caddy') {
    const compose = values.network !== undefined ? COMPOSE_NETWORK : COMPOSE_PROXY;
    return [{ name: 'compose.yml', content: compose, mode: '0644', showContent: true }, env];
  }
  return [
    { name: 'compose.yml', content: COMPOSE_CADDY, mode: '0644', showContent: true },
    { name: 'Caddyfile', content: CADDYFILE, mode: '0644', showContent: true },
    env,
  ];
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export type ProxyServer = 'nginx' | 'apache' | 'other';

/** Reverse-proxy snippet for the web server found on port 80. Only validated values are put into it. */
export function proxySnippet(server: ProxyServer, port: number, upstream = `127.0.0.1:${port}`): { snippet: string; certificateHint: string } {
  if (server === 'apache') {
    return {
      snippet: [
        '# a2enmod proxy proxy_http proxy_wstunnel rewrite headers',
        'RewriteEngine On',
        'RewriteCond %{HTTP:Upgrade} =websocket [NC]',
        `RewriteRule ^/v1/(.*)$ ws://${upstream}/v1/$1 [P,L]`,
        `ProxyPass /v1/ http://${upstream}/v1/`,
        `ProxyPassReverse /v1/ http://${upstream}/v1/`,
        'ProxyTimeout 120',
        'RequestHeader set X-Forwarded-For "%{REMOTE_ADDR}s"',
      ].join('\n'),
      certificateHint: 'Get a certificate with your own tooling, for example: certbot --apache -d <your host name>',
    };
  }
  return {
    snippet: [
      'location /v1/ {',
      `    proxy_pass http://${upstream};`,
      '    proxy_http_version 1.1;',
      '    proxy_set_header Upgrade $http_upgrade;',
      '    proxy_set_header Connection "upgrade";',
      '    proxy_set_header Host $host;',
      '    proxy_set_header X-Forwarded-For $remote_addr;',
      '    proxy_read_timeout 120s;',
      '    proxy_send_timeout 120s;',
      '}',
    ].join('\n'),
    certificateHint:
      server === 'nginx'
        ? 'Get a certificate with your own tooling, for example: certbot --nginx -d <your host name>'
        : 'Terminate TLS in your web server with a valid certificate; the snippet above is written for nginx syntax.',
  };
}

/** Caddy site for the person's own Caddy (spec 5.1): to the relay by its network name, or on loopback for a Caddy on the host. */
export function caddySiteBlock(name: string, upstream: string): string {
  return `${name} {\n\treverse_proxy ${upstream}\n}\n`;
}

const FILE_NOTE = '# parley-relay: added by the Parley relay setup wizard. Remove it with the wizard (Remove relay).';
export const BLOCK_BEGIN = '# BEGIN parley-relay (added by the Parley relay setup wizard; remove it with the wizard)';
export const BLOCK_BEGIN_NL = '# BEGIN parley-relay (added by the Parley relay setup wizard; remove it with the wizard; newline-added)';
export const BLOCK_END = '# END parley-relay';

/** The whole file `parley-relay<suffix>` in the directory Caddy imports. */
export const caddySiteFile = (name: string, upstream: string): string => `${FILE_NOTE}\n${caddySiteBlock(name, upstream)}`;

/**
 * The text appended to a Caddyfile: an empty line, the marker, the site, the end marker. A file without a final
 * newline gets one first, and the marker says so, so that removing the block restores the file byte for byte.
 */
export function caddyBlockAppend(existing: string, name: string, upstream: string): string {
  const needsNewline = existing !== '' && !existing.endsWith('\n');
  return `${needsNewline ? '\n' : ''}\n${needsNewline ? BLOCK_BEGIN_NL : BLOCK_BEGIN}\n${caddySiteBlock(name, upstream)}${BLOCK_END}\n`;
}

/** The Caddyfile without our block, the empty line before it and (by the marker) the newline the wizard added; `null` — no block. */
export function removeCaddyBlock(text: string): string | null {
  const begin = /^# BEGIN parley-relay\b.*$/m.exec(text);
  const end = /^# END parley-relay[ \t]*(?:\r?\n|$)/m.exec(text);
  if (begin === null || end === null || end.index < begin.index) return null;
  let before = text.slice(0, begin.index);
  for (let i = begin[0].endsWith('; newline-added)') ? 2 : 1; i > 0 && before.endsWith('\n'); i--) before = before.slice(0, -1);
  return before + text.slice(end.index + end[0].length);
}
