// Native queued/read byte counters: no per-frame encoding, copying or write wrapper.
import { Server, Socket } from 'node:net';
const sockets = new Set(), baselines = new WeakMap();
let closedTx = 0, closedRx = 0, registrations = 0;
function remember(socket) {
  if (sockets.has(socket)) return;
  registrations += 1; sockets.add(socket); baselines.set(socket, { tx: 0, rx: 0 });
  socket.once('close', () => {
    const start = baselines.get(socket);
    closedTx += socket.bytesWritten - start.tx; closedRx += socket.bytesRead - start.rx; sockets.delete(socket);
  });
}
const emit = Server.prototype.emit;
Server.prototype.emit = function (event, ...args) { if (event === 'connection' && args[0] instanceof Socket) remember(args[0]); return Reflect.apply(emit, this, [event, ...args]); };
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) { remember(this); return Reflect.apply(connect, this, args); };
export const wireMeter = {
  reset() { closedTx = 0; closedRx = 0; registrations = 0; for (const socket of sockets) baselines.set(socket, { tx: socket.bytesWritten, rx: socket.bytesRead }); },
  read() {
    let tx = closedTx, rx = closedRx;
    for (const socket of sockets) { const start = baselines.get(socket); tx += socket.bytesWritten - start.tx; rx += socket.bytesRead - start.rx; }
    return { tx, rx, open: sockets.size, newConnections: registrations, semantics: 'native Socket bytesWritten(queued)/bytesRead; no per-frame instrumentation' };
  },
};
