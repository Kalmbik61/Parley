import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stopHost } from './stop-host.js';
import { RUN_HOMES_ENV } from './tmp.js';

/**
 * Список домов этого прогона (`makeTempHome`) и уборка по нему в конце: воркер, снятый по
 * таймауту, не выполняет afterEach, и хост его теста иначе жил бы дальше. Воркеры наследуют
 * окружение, заданное здесь.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const dir = await mkdtemp(path.join(tmpdir(), 'harnas-e2e-run-'));
  const list = path.join(dir, 'homes');
  process.env[RUN_HOMES_ENV] = list;

  return async () => {
    const homes = (await readFile(list, 'utf8').catch(() => ''))
      .split('\n')
      .filter((home) => home !== '' && existsSync(home));
    for (const home of homes) {
      // Дом на месте — значит, afterEach его теста не дошёл до конца.
      console.warn(`[e2e] уборка прогона: дом ${home} остался после теста — гашу его хост`);
      await stopHost(home);
      await rm(home, { recursive: true, force: true });
    }
    await rm(dir, { recursive: true, force: true });
  };
}
