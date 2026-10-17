/**
 * Процесс для теста гонки перехвата осиротевшей блокировки: в назначенный момент дописывает свой токен в `goal`.
 * Запускается тестом через tsx — настоящая параллельность.
 *
 * Аргументы: <путь проекта> <work-id> <токен> <момент старта, мс epoch>
 */
import { updateMap } from '../src/work/store.js';

const [projectPath = '', workId = '', token = '', startRaw = '0'] = process.argv.slice(2);
const start = Number(startRaw);

const wait = start - Date.now() - 3;
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
while (Date.now() < start) { /* точная общая отметка старта */ }

await updateMap(
  projectPath,
  workId,
  (map) => {
    map.work.goal += ` ${token}`;
  },
  { lockTimeoutMs: 10_000 },
);
