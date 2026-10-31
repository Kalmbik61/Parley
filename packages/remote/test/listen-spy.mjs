// Предзагрузка для дочернего процесса моста: записывает первый аргумент каждого `net.Server.prototype.listen`.
import fs from 'node:fs';
import net from 'node:net';

const original = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const first = args[0];
  fs.appendFileSync(process.env.LISTEN_SPY_FILE, `${JSON.stringify({ type: typeof first, path: typeof first === 'string' ? first : null })}\n`);
  return original.apply(this, args);
};
