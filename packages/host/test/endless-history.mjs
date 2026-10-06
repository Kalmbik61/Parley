// Предзагрузка процесса хоста в тестах (`node --import`): журналы истории под каталогом из
// `PARLEY_TEST_ENDLESS_HISTORY` читаются без конца — по строке раз в 20 мс. Так воспроизводится
// история в гигабайты, которую индекс логов (`buildAllSessions`) читает минутами, но без гигабайтов
// на диске: пока чтение не прервано, его таймер держит цикл событий процесса живым.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { clearTimeout, setTimeout } from 'node:timers';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const root = process.env.PARLEY_TEST_ENDLESS_HISTORY;
const original = fs.createReadStream;
const LINE = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'ещё' } })}\n`;

fs.createReadStream = function createReadStream(file, options) {
  if (root === undefined || typeof file !== 'string' || !file.startsWith(`${root}${path.sep}`)) {
    return original.call(this, file, options);
  }
  let timer;
  return new Readable({
    encoding: 'utf8',
    read() {
      timer = setTimeout(() => this.push(LINE), 20);
    },
    destroy(error, callback) {
      clearTimeout(timer);
      callback(error);
    },
  });
};
// Модули ESM (core) берут `createReadStream` именованным импортом — привязку надо обновить.
syncBuiltinESMExports();
