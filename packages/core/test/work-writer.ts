/**
 * Пишущий процесс для теста параллельной записи карты. Запускается тестом через
 * tsx: настоящий второй процесс, а не эмуляция внутри vitest.
 *
 * Аргументы: <путь проекта> <work-id|"new-work"> <префикс|заголовок> <сколько сессий>
 */
import { addSession } from '../src/work/map.js';
import { createWork, updateMap } from '../src/work/store.js';

const [projectPath = '', workId = '', prefix = '', countRaw = '0'] = process.argv.slice(2);

if (workId === 'new-work') {
  await createWork(projectPath, { title: prefix }, { lockTimeoutMs: 30_000 });
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
