// Stub of the bridge process for the Remote access E2E (mobile plan A10): the control socket of spec 5.3 under
// <PARLEY_HOME>/remote — token file, `hello`, a few methods and events. The real bridge is A22.
// Triggers: files <home>/remote/trigger-{request,wrong-code,done} appear → the matching event is emitted.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { clearInterval, setInterval, setTimeout } from 'node:timers';

const home = process.env.PARLEY_HOME;
const dir = path.join(home, 'remote');
mkdirSync(dir, { recursive: true });
const sock = path.join(dir, 'control.sock');
rmSync(sock, { force: true });
writeFileSync(path.join(dir, 'control.token'), 'stub-token');
writeFileSync(path.join(dir, 'bridge.pid'), String(process.pid));

const sockets = new Set();
let devices = [];
let relayUrl = '192.168.1.10:8787';
let reqNo = 0;
const log = [{ at: new Date().toISOString(), deviceId: '', deviceName: '', kind: 'connect', outcome: 'bridge started' }];
const reply = (socket, id, result) => socket.write(`${JSON.stringify({ id, result })}\n`);
const emit = (event, data) => { for (const s of sockets) s.write(`${JSON.stringify({ event, data })}\n`); };

const server = net.createServer((socket) => {
  let buf = '';
  let authed = false;
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
  socket.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (!authed) {
        if (msg.method === 'hello' && msg.params?.token === 'stub-token') { authed = true; sockets.add(socket); reply(socket, msg.id, { ok: true }); }
        else socket.end();
        continue;
      }
      switch (msg.method) {
        case 'status': reply(socket, msg.id, { running: true, host: 'online', relay: 'connected', relayUrl, devices: devices.length, version: 'stub' }); break;
        case 'configure': relayUrl = msg.params.relayUrl; reply(socket, msg.id, { ok: true }); break;
        case 'pair.start': reply(socket, msg.id, { qr: `parley://pair?stub=${++reqNo}`, expiresAt: Date.now() + 120000 }); break;
        case 'devices.list': reply(socket, msg.id, { devices }); break;
        case 'audit.tail': reply(socket, msg.id, { records: log }); break;
        case 'devices.revoke': devices = devices.filter((d) => d.deviceId !== msg.params.deviceId); reply(socket, msg.id, { ok: true }); break;
        case 'reset': devices = []; reply(socket, msg.id, { ok: true }); break;
        case 'pair.answer':
          if (msg.params.allow) {
            devices = [...devices, { deviceId: 'dev1', name: 'Anna’s iPhone', platform: 'ios', pairedAt: Date.now(), lastSeen: null }];
            log.push({ at: new Date().toISOString(), deviceId: 'dev1', deviceName: 'Anna’s iPhone', kind: 'pair', outcome: 'paired' });
            emit('pair.done', { requestId: msg.params.requestId, deviceId: 'dev1' });
          }
          reply(socket, msg.id, { ok: true });
          break;
        case 'stop': reply(socket, msg.id, { ok: true }); setTimeout(shutdown, 20); break;
        default: reply(socket, msg.id, { ok: true });
      }
    }
  });
});
server.listen(sock);

const triggers = setInterval(() => {
  const t = (name) => { const f = path.join(dir, `trigger-${name}`); if (!existsSync(f)) return false; rmSync(f); return true; };
  if (t('request')) emit('pair.request', { requestId: `req-${++reqNo}`, name: 'Anna’s iPhone', platform: 'ios', sas: '482 913'.replace(' ', ''), fingerprint: 'ab12', expiresAt: Date.now() + 60000 });
  if (t('wrong-code')) emit('pair.offerClosed', { reason: 'bad-psk' });
}, 100);

function shutdown() {
  clearInterval(triggers);
  server.close();
  for (const s of sockets) s.destroy();
  rmSync(sock, { force: true });
  rmSync(path.join(dir, 'control.token'), { force: true });
  rmSync(path.join(dir, 'bridge.pid'), { force: true });
  process.exit(0);
}
process.on('SIGTERM', shutdown);
