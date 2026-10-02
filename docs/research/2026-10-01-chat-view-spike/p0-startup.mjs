// P0: что видно сразу после запуска, до любого ввода. Ничего не нажимаем.
import { Session, describeEvents } from './lib.mjs';
const s = new Session('p0-startup');
try {
  await s.quiet(2000, 25000);
  console.log('--- команда ---\n' + s.cmdline.replace(/\/private\/tmp\/[^ ]+chat-probe/g, '<probe>'));
  console.log('--- экран после старта ---');
  console.log(await s.snap('startup'));
  console.log('--- события хуков ---');
  console.log(describeEvents(s).join('\n') || '(нет)');
  console.log('--- строка статуса: вызовов', s.status.length, '| записей журнала', s.logs.length);
} finally {
  await s.close({ graceful: false });
}
