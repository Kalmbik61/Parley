import { describe, expect, it } from 'vitest';
import { BLOCK_BEGIN, BLOCK_BEGIN_NL, caddyBlockAppend, caddySiteFile, COMPOSE_NETWORK, managedFiles, proxySnippet, removeCaddyBlock, renderEnv } from './templates.js';

const IMAGE = 'ghcr.io/kalmbik61/parley-relay@sha256:' + 'a'.repeat(64);
const BASE = { domain: 'r.example.com', image: IMAGE, httpPort: 80, httpsPort: 443, proxyPort: 8787 } as const;

describe('renderEnv and managed files (spec 6.1)', () => {
  it('the old layouts keep their old .env', () => {
    expect(renderEnv({ ...BASE, mode: 'caddy' })).not.toMatch(/RELAY_WEB|RELAY_NETWORK|RELAY_ACME/);
  });
  it('caddy-site writes where the site went and the network', () => {
    const env = renderEnv({ ...BASE, mode: 'caddy-site', webRuntime: 'docker', webFile: '/opt/x/parley-relay.caddy', webEdit: 'file', network: 'course_default' });
    expect(env).toContain('RELAY_MODE=caddy-site\n');
    expect(env).toContain('RELAY_WEB_RUNTIME=docker\nRELAY_WEB_FILE=/opt/x/parley-relay.caddy\nRELAY_WEB_EDIT=file\nRELAY_NETWORK=course_default\n');
  });
  it('a relay in a network uses the network compose (service parley-relay, no aliases, no published ports); otherwise the loopback one', () => {
    const net = managedFiles({ ...BASE, mode: 'caddy-site', network: 'n' });
    expect(net.map((f) => f.name)).toEqual(['compose.yml', '.env']);
    expect(net[0]?.content).toBe(COMPOSE_NETWORK);
    expect(COMPOSE_NETWORK).toMatch(/^ {2}parley-relay:$/m);
    expect(COMPOSE_NETWORK).not.toMatch(/aliases|ports:|container_name/);
    expect(COMPOSE_NETWORK).toContain('name: ${RELAY_NETWORK:?set RELAY_NETWORK}');
    expect(managedFiles({ ...BASE, mode: 'caddy-site' })[0]?.content).toContain('127.0.0.1:${RELAY_PROXY_PORT');
  });
});

describe('texts of the edits (spec 5.1)', () => {
  it('the site file and the block', () => {
    expect(caddySiteFile('r.example.com', 'parley-relay:8787')).toBe(
      '# parley-relay: added by the Parley relay setup wizard. Remove it with the wizard (Remove relay).\nr.example.com {\n\treverse_proxy parley-relay:8787\n}\n',
    );
    expect(caddyBlockAppend('a {\n}\n', 'r.example.com', '127.0.0.1:8787')).toBe(`\n${BLOCK_BEGIN}\nr.example.com {\n\treverse_proxy 127.0.0.1:8787\n}\n# END parley-relay\n`);
    expect(caddyBlockAppend('a {\n}', 'r.example.com', 'x:1').startsWith(`\n\n${BLOCK_BEGIN_NL}\n`)).toBe(true);
  });
  it('removing a block that is not there, or is broken, gives null', () => {
    expect(removeCaddyBlock('a {\n}\n')).toBeNull();
    expect(removeCaddyBlock('# END parley-relay\n# BEGIN parley-relay x\n')).toBeNull();
  });
  it('the snippet can point at a name in a Docker network', () => {
    expect(proxySnippet('nginx', 8787, 'parley-relay:8787').snippet).toContain('proxy_pass http://parley-relay:8787;');
    expect(proxySnippet('nginx', 8787).snippet).toContain('proxy_pass http://127.0.0.1:8787;');
    expect(proxySnippet('apache', 8787, 'parley-relay:8787').snippet).toContain('ws://parley-relay:8787/v1/$1');
  });
});
