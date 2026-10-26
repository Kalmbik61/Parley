/**
 * Пишущий процесс для теста параллельной записи в базу работ (спека хранилища 6.9, этап 2). Запускается тестом через
 * tsx: настоящий второй процесс со своим соединением к `parley.db`, а не эмуляция внутри vitest.
 *
 * Аргументы: <путь проекта> <work-id|"new-work"> <префикс|заголовок> <сколько сессий> [<момент старта, мс epoch>]
 * [<"letters">]. Момент старта нужен, чтобы писатели начали вместе и записи действительно чередовались. С "letters" вместо
 * сессий пишутся письма (`writeLetters`, спека хранилища 6.2): номера писем выдаёт база под блокировкой записи.
 */
import { writeLetters } from '../src/work/letter-store.js';
import { addSession } from '../src/work/map.js';
import { createWork, updateMap } from '../src/work/store.js';

const [projectPath = '', workId = '', prefix = '', countRaw = '0', startRaw = '0', mode = 'sessions'] =
  process.argv.slice(2);
const start = Number(startRaw);

const wait = start - Date.now() - 3;
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
while (Date.now() < start) {
  /* точная общая отметка старта */
}

if (workId === 'new-work') {
  await createWork(projectPath, { title: prefix }, { lockTimeoutMs: 30_000 });
} else if (mode === 'letters') {
  for (let i = 0; i < Number(countRaw); i += 1) {
    writeLetters(
      projectPath,
      workId,
      (letters) => letters.add({ roomId: null, from: 's-01', to: ['s-02'], text: `${prefix}-${i}`, kind: 'note' }),
      { lockTimeoutMs: 30_000 },
    );
  }
} else {
  for (let i = 0; i < Number(countRaw); i += 1) {
    await updateMap(
      projectPath,
      workId,
      (map) => {
        addSession(map, { provider: 'claude', label: `${prefix}-${i}`, task: 'работа' });
      },
      { lockTimeoutMs: 30_000 },
    );
  }
}
