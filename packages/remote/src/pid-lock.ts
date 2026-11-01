import { readFile, rm, writeFile } from 'node:fs/promises';

/** Другой мост этого дома уже работает (живой pid в `bridge.pid`). */
export class BridgeAlreadyRunning extends Error {
  constructor(readonly pid: number) {
    super(`another bridge is running (pid ${pid})`);
    this.name = 'BridgeAlreadyRunning';
  }
}

/** Жив ли процесс: `ESRCH` — нет; `EPERM` — есть, но чужой. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Единственный экземпляр моста на дом (критик волны 4, m1): `bridge.pid` создаётся исключительно (`wx`), поэтому из двух
 * одновременных запусков файл получает ровно один. Файл с мёртвым pid или мусором — след упавшего моста: его убирают и
 * пробуют снова, убирая только то, что прочитали. Сокет управления (`isLive`) остаётся вторым рубежом.
 */
export async function acquirePidLock(file: string, pid: number = process.pid, alive: (pid: number) => boolean = pidAlive): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await writeFile(file, String(pid), { flag: 'wx', mode: 0o600 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) continue; // файл успели убрать: пробуем снова
    const owner = Number.parseInt(text.trim(), 10);
    if (Number.isInteger(owner) && owner > 0 && alive(owner)) throw new BridgeAlreadyRunning(owner);
    // Мёртвый владелец: убираем, только если за это время никто не занял файл заново.
    if ((await readFile(file, 'utf8').catch(() => null)) === text) await rm(file, { force: true });
  }
  throw new Error('could not take bridge.pid');
}

/** Освобождает замок, только если он наш. */
export async function releasePidLock(file: string, pid: number = process.pid): Promise<void> {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text !== null && Number.parseInt(text.trim(), 10) === pid) await rm(file, { force: true });
}
