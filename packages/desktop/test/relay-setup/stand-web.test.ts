import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CADDYFILE, COMPOSE_CADDY, COMPOSE_PROXY } from '../../src/main/relay-setup/templates.js';
import { COURSE_DIR, docker, dockerAvailable, drive, exec, putFile, putTree, removeServer, removeTempDirs, saveImages, sha256Of, snapshot, startServer, tempDir, waitDockerReady, waitForSsh, type Server } from './stand.js';

/**
 * The person's own web server on the stand (spec 10): S1 a Caddy in Docker with read-only mounts and a `relay` service of
 * the person's own, S2 the manual layout of the course VPS, S3 nginx on the host. Servers have their own Docker and no
 * outbound DNS where an ACME request could go out (S1, S2). Needs `parley-relay:stand` and `caddy:2.11.7` on this Mac.
 */
const ENABLED = process.env.RELAY_SETUP_STAND === '1' && dockerAvailable() && process.env.RELAY_SETUP_FULL === '1';

const CADDY = 'course-platform-prod-caddy-1';
const RELAY = 'parley-relay-parley-relay-1';
const COURSE_CADDYFILE = '/opt/course-platform/deploy/Caddyfile';
const SITES = '/opt/evdev-site/caddy';
const OUR_FILE = `${SITES}/parley-relay.caddy`;
const servers: Server[] = [];
let imagesDir = '';

const local = (...parts: string[]): string => readFileSync(path.join(COURSE_DIR, ...parts), 'utf8');
/** The relay answers from the container of the person's Caddy by its name in the network. */
const viaCaddy = `docker exec ${CADDY} wget -qO- http://parley-relay:8787/v1/health`;
/** What a site of the person answers: through the Caddy of their project, by name, with the internal certificate. */
const vhost = (server: Server, host: string): string => exec(server.name, `curl -sk --resolve ${host}:443:127.0.0.1 https://${host}/`);
/** The addresses a name resolves to inside the person's network (busybox nslookup in the Caddy image), sorted. */
const addressesOf = (server: Server, name: string): string[] =>
  exec(server.name, `docker exec ${CADDY} nslookup ${name} 2>/dev/null | awk '/^Name:/ {on=1} on && /^Address/ {print $NF}' | sort`).split('\n').filter((a) => a !== '');
const containerIp = (server: Server, container: string, network: string): string => exec(server.name, `docker inspect -f '{{(index .NetworkSettings.Networks "${network}").IPAddress}}' ${container}`);
const NETWORK = 'course-platform-prod_default';
const adminConfig = (server: Server): string => exec(server.name, `docker exec ${CADDY} wget -qO- http://127.0.0.1:2019/config/`);

async function newServer(name: string, flavour: 'ubuntu24-docker' | 'nginx-docker', offline: boolean): Promise<Server> {
  const server = startServer(flavour, name, undefined, { imagesDir, offline });
  servers.push(server);
  await waitForSsh(server.port);
  waitDockerReady(server.name);
  return server;
}

/** The person's course project: its own Caddy on 80/443, Caddyfile and site directory mounted read-only. */
function startCourse(server: Server, extraService = '', manualSite = true): void {
  putTree(server.name, path.join(COURSE_DIR, 'course-platform'), '/opt/course-platform/deploy');
  putTree(server.name, path.join(COURSE_DIR, 'evdev-site'), SITES);
  if (!manualSite) exec(server.name, `rm -f ${OUR_FILE}`);
  if (extraService !== '') putFile(server.name, '/opt/course-platform/deploy/compose.yml', local('course-platform', 'compose.yml') + extraService);
  exec(server.name, 'cd /opt/course-platform/deploy && docker compose up -d');
}

/** The manual layout of the course VPS (spec 6.5): our relay by hand, runs 1 and 2 of the wizard left their files. */
function startManualRelay(server: Server): void {
  putTree(server.name, path.join(COURSE_DIR, 'parley-relay'), '/opt/parley-relay');
  putFile(server.name, '/opt/parley-relay/compose.yml.wizard-caddy', COMPOSE_CADDY);
  putFile(server.name, '/opt/parley-relay/Caddyfile.wizard-caddy', CADDYFILE);
  putFile(server.name, '/opt/parley-relay/previous/compose.yml', COMPOSE_PROXY);
  exec(server.name, 'chmod 600 /opt/parley-relay/.env /opt/parley-relay/previous/.env');
  exec(server.name, 'cd /opt/parley-relay && docker compose up -d');
  exec(server.name, "docker exec parley-relay-relay-1 sh -c 'echo route > /data/marker'");
  for (const volume of ['caddy-data', 'caddy-config']) {
    exec(server.name, `docker volume create --label com.docker.compose.project=parley-relay --label com.docker.compose.volume=${volume} parley-relay_${volume}`);
  }
  // Run 2 left a container of its own Caddy that never started (ports 80/443 were taken): created by compose, so it carries
  // the project's labels, holds a volume of the project, and its service is not in any compose file of the project now.
  putFile(server.name, '/root/run2-caddy.yml', 'services:\n  caddy:\n    image: caddy:2.11.7\n    volumes:\n      - caddy-data:/data\nvolumes:\n  caddy-data:\n');
  exec(server.name, 'docker compose -p parley-relay -f /root/run2-caddy.yml create caddy');
}

const names = (server: Server): string[] => exec(server.name, 'docker ps -a --format {{.Names}}').split('\n').filter((n) => n !== '').sort();

describe.skipIf(!ENABLED)('relay setup stand: the web server of the person', () => {
  beforeAll(() => {
    imagesDir = path.join(tempDir('relay-stand-web-'), 'images');
    saveImages(imagesDir);
  }, 300_000);

  afterAll(() => {
    for (const server of servers) removeServer(server.name);
    removeTempDirs();
  });

  it('S1: a Caddy of the person with :ro mounts and a relay service of their own → caddy-site; their Caddyfile is not changed', async () => {
    const server = await newServer('parley-stand-web-s1', 'ubuntu24-docker', true);
    putFile(server.name, `${SITES}/other.caddy`, 'other.localhost {\n\trespond "other-site"\n}\n');
    startCourse(server, '  relay:\n    image: caddy:2.11.7\n    command: caddy respond --listen :8787 "person-relay"\n', false);
    // The state of run 2: an old .env of a `proxy` install, nothing running.
    putFile(server.name, '/opt/parley-relay/.env', 'RELAY_DOMAIN=203-0-113-7.sslip.io\nRELAY_IMAGE=parley-relay:stand\nRELAY_MODE=proxy\nRELAY_HTTP_PORT=80\nRELAY_HTTPS_PORT=443\nRELAY_PROXY_PORT=8787\n', '0600');
    const before = sha256Of(server.name, COURSE_CADDYFILE);
    const otherSha = sha256Of(server.name, `${SITES}/other.caddy`);
    const options = { ip: '203.0.113.7', healthCommand: viaCaddy };
    const sitesAnswer = (): void => {
      expect(vhost(server, 'course.localhost')).toBe('course-platform');
      expect(vhost(server, 'other.localhost')).toBe('other-site');
    };
    sitesAnswer();
    // «Offline» is a promise of this stand: no name outside resolves from inside.
    expect(() => exec(server.name, `docker exec ${CADDY} nslookup acme-v02.api.letsencrypt.org`)).toThrow();

    const first = await drive(server, 'install', options);
    expect(first.plan).toMatchObject({ phase: 'plan', plan: { blocked: null } });
    if (first.plan.phase === 'plan') {
      expect(first.plan.plan.steps.map((s) => s.id)).toEqual(['docker', 'dir', 'files', 'image', 'start', 'web']);
      expect(first.plan.plan.web?.edits[0]).toMatchObject({ action: 'add', file: `${SITES}/parley-relay.caddy` });
    }
    expect(first.phase).toMatchObject({ phase: 'done', address: '203-0-113-7.sslip.io' });
    expect(sha256Of(server.name, COURSE_CADDYFILE)).toBe(before);
    const config = adminConfig(server);
    expect(config).toContain('other.localhost');
    expect(config).toContain('203-0-113-7.sslip.io');
    expect(exec(server.name, viaCaddy)).not.toBe('');
    // `relay` in the network leads to the person's service and nothing else; `parley-relay` to ours alone (the whole set of addresses, not one request).
    expect(addressesOf(server, 'relay')).toEqual([containerIp(server, 'course-platform-prod-relay-1', NETWORK)]);
    expect(addressesOf(server, 'parley-relay')).toEqual([containerIp(server, RELAY, NETWORK)]);
    sitesAnswer();
    expect(exec(server.name, 'cat /opt/parley-relay/.env')).toContain('RELAY_MODE=caddy-site');

    // A repeat changes nothing.
    const again = await drive(server, 'install', options);
    expect(again.phase).toMatchObject({ phase: 'done' });
    expect(again.done).toEqual([]);
    sitesAnswer();

    // The person's project goes down and up with our relay attached to its network: what happens is recorded.
    let downCode = 0;
    try {
      exec(server.name, 'cd /opt/course-platform/deploy && docker compose down 2>&1');
    } catch (error) {
      downCode = (error as { status?: number }).status ?? 1;
    }
    exec(server.name, 'cd /opt/course-platform/deploy && docker compose up -d');
    console.info(`S1: docker compose down of the person's project with our relay attached exited ${downCode}`);
    let answers = false;
    for (let attempt = 0; attempt < 20 && !answers; attempt += 1) {
      try {
        exec(server.name, viaCaddy);
        answers = true;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    expect(answers).toBe(true);
    sitesAnswer();

    const removed = await drive(server, 'remove', options);
    expect(removed.phase).toEqual({ phase: 'removed', docker: 'kept' });
    expect(exec(server.name, `ls ${SITES}`)).toBe('other.caddy');
    expect(sha256Of(server.name, COURSE_CADDYFILE)).toBe(before);
    expect(adminConfig(server)).not.toContain('203-0-113-7.sslip.io');
    expect(names(server).filter((n) => n.startsWith('parley-relay'))).toEqual([]);
    sitesAnswer();
    expect(sha256Of(server.name, `${SITES}/other.caddy`)).toBe(otherSha);
  }, 1_200_000);

  it('S2: the manual layout of the course VPS → repeat, second repeat, removal after them', async () => {
    const server = await newServer('parley-stand-web-s2', 'ubuntu24-docker', true);
    startCourse(server);
    startManualRelay(server);
    const caddyfile = sha256Of(server.name, COURSE_CADDYFILE);
    const manualSite = sha256Of(server.name, OUR_FILE);
    const manualCompose = sha256Of(server.name, '/opt/parley-relay/compose.yml');
    const options = { ip: '82.146.37.224', healthCommand: viaCaddy };
    expect(vhost(server, 'course.localhost')).toBe('course-platform');

    const first = await drive(server, 'install', options);
    expect(first.phase).toMatchObject({ phase: 'done', address: '82-146-37-224.sslip.io' });
    expect(first.done).toEqual(expect.arrayContaining(['files', 'start', 'web']));
    expect(sha256Of(server.name, COURSE_CADDYFILE)).toBe(caddyfile);
    expect(sha256Of(server.name, OUR_FILE)).not.toBe(manualSite);
    expect(exec(server.name, `cat ${OUR_FILE}`)).toBe(
      "# parley-relay: added by the Parley relay setup wizard. Remove it with the wizard (Remove relay).\n82-146-37-224.sslip.io {\n\treverse_proxy parley-relay:8787\n}",
    );
    expect(exec(server.name, 'cat /opt/parley-relay/.env')).toContain('RELAY_MODE=caddy-site');
    expect(sha256Of(server.name, '/opt/parley-relay/previous/compose.yml')).toBe(manualCompose);
    expect(exec(server.name, 'ls /var/backups/parley-relay')).toMatch(/parley-relay\.caddy$/);
    // The copy is the manual file, byte for byte.
    expect(exec(server.name, "sha256sum /var/backups/parley-relay/* | cut -d' ' -f1")).toBe(manualSite);
    // The manual relay service is replaced by the one of the wizard; the data volume is the same.
    expect(names(server)).toEqual([CADDY, 'course-platform-prod-web-1', RELAY].sort());
    expect(exec(server.name, `docker exec ${RELAY} cat /data/marker`)).toBe('route');
    expect(adminConfig(server)).toContain('82-146-37-224.sslip.io');
    expect(vhost(server, 'course.localhost')).toBe('course-platform');
    expect(addressesOf(server, 'parley-relay')).toEqual([containerIp(server, RELAY, NETWORK)]);

    const second = await drive(server, 'install', options);
    expect(second.phase).toMatchObject({ phase: 'done' });
    expect(second.done).toEqual([]);

    // Right after a repeat there is no earlier version in this layout.
    const back = await drive(server, 'rollback', { ...options, execute: false });
    expect(back.plan).toMatchObject({ phase: 'plan', plan: { blocked: expect.stringMatching(/different layout/) } });

    const removed = await drive(server, 'remove', { ...options, removeData: true });
    expect(removed.phase).toEqual({ phase: 'removed', docker: 'kept' });
    expect(exec(server.name, `ls ${SITES}`)).toBe('');
    expect(sha256Of(server.name, COURSE_CADDYFILE)).toBe(caddyfile);
    expect(names(server)).toEqual([CADDY, 'course-platform-prod-web-1'].sort());
    expect(docker(['exec', server.name, 'docker', 'volume', 'ls', '-q'])).not.toMatch(/parley-relay_/);
    expect(vhost(server, 'course.localhost')).toBe('course-platform');
    expect(exec(server.name, 'ls /var/backups/parley-relay')).toMatch(/parley-relay\.caddy$/);
  }, 1_200_000);

  it('S2b: removal on the manual layout at once, without a repeat', async () => {
    const server = await newServer('parley-stand-web-s2b', 'ubuntu24-docker', true);
    startCourse(server);
    startManualRelay(server);
    const caddyfile = sha256Of(server.name, COURSE_CADDYFILE);
    expect(vhost(server, 'course.localhost')).toBe('course-platform');
    const removed = await drive(server, 'remove', { ip: '82.146.37.224', healthCommand: viaCaddy, removeData: true });
    expect(removed.plan).toMatchObject({ phase: 'plan', plan: { steps: expect.arrayContaining([expect.objectContaining({ id: 'web-undo' })]) } });
    expect(removed.phase).toEqual({ phase: 'removed', docker: 'kept' });
    expect(exec(server.name, `ls ${SITES}`)).toBe('');
    expect(sha256Of(server.name, COURSE_CADDYFILE)).toBe(caddyfile);
    expect(names(server)).toEqual([CADDY, 'course-platform-prod-web-1'].sort());
    expect(docker(['exec', server.name, 'docker', 'volume', 'ls', '-q'])).not.toMatch(/parley-relay_/);
    expect(vhost(server, 'course.localhost')).toBe('course-platform');
  }, 1_200_000);

  it('S3: nginx on the host → nginx-acme; nginx -t passes, its default site still answers, our name reaches our Caddy; removal restores nginx', async () => {
    const server = await newServer('parley-stand-web-s3', 'nginx-docker', false);
    const before = snapshot(server.name, ['/etc/nginx']);
    const options = { ip: '203.0.113.7', healthCommand: `docker exec ${RELAY} node -e "fetch('http://127.0.0.1:8787/v1/health').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"` };

    const first = await drive(server, 'install', options);
    expect(first.plan).toMatchObject({ phase: 'plan', plan: { blocked: null } });
    if (first.plan.phase === 'plan') {
      expect(first.plan.plan.steps.map((s) => s.id)).toEqual(['docker', 'dir', 'files', 'image', 'web', 'start']);
      expect(first.plan.plan.web?.edits[0]).toMatchObject({ action: 'add', file: '/etc/nginx/conf.d/parley-relay.conf', server: 'nginx (systemd)' });
    }
    expect(first.phase).toMatchObject({ phase: 'done', address: '203-0-113-7.sslip.io:8443' });
    exec(server.name, 'nginx -t');
    expect(exec(server.name, 'curl -s http://127.0.0.1/')).toContain('Welcome to nginx');
    // The request with our name goes through nginx to our Caddy, whatever it answers; Caddy needs a moment after the start.
    let headers = '';
    for (let attempt = 0; attempt < 30 && !/^HTTP\/1\.1 308/.test(headers); attempt += 1) {
      headers = exec(server.name, "curl -sI -H 'Host: 203-0-113-7.sslip.io' http://127.0.0.1/");
      if (!/^HTTP\/1\.1 308/.test(headers)) await new Promise((r) => setTimeout(r, 1000));
    }
    // nginx's own default site would answer 200; the 308 to the relay's port is what Caddy answers to an HTTP request for its name.
    expect(headers).toMatch(/^HTTP\/1\.1 308 [\s\S]*Location: https:\/\/203-0-113-7\.sslip\.io:8443\//i);

    const removed = await drive(server, 'remove', options);
    expect(removed.phase).toEqual({ phase: 'removed', docker: 'kept' });
    exec(server.name, 'nginx -t');
    expect(snapshot(server.name, ['/etc/nginx'])).toBe(before);
    expect(exec(server.name, 'curl -s http://127.0.0.1/')).toContain('Welcome to nginx');
  }, 1_200_000);
});
