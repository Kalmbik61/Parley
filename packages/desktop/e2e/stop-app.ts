import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { ElectronApplication } from '@playwright/test';

/**
 * Под нагрузкой машины процесс Electron после `app.quit()` живёт ещё десятки секунд: JS main
 * доходит до `quit` за ~0,1 с (окно закрыто, сохранения сделаны), а разбор процессов Chromium
 * тянется 10–60 с (замеры в отчёте fix-tests). `app.close()` Playwright ждёт именно выхода
 * процесса — и тратил на этот хвост весь таймаут теста: afterEach не доходил до `stopHost`,
 * хост оставался жить.
 */

/** Процесс окна, пока он жив; после выхода Playwright освобождает объект, и `process()` бросает. */
function running(app: ElectronApplication): ChildProcess | null {
  try {
    const proc = app.process();
    return proc.exitCode === null && proc.signalCode === null ? proc : null;
  } catch {
    return null;
  }
}

async function kill(app: ElectronApplication): Promise<void> {
  const proc = running(app);
  if (proc === null) return;
  // Подписка до сигнала: `exit` приходит асинхронно, раньше неё не проскочит.
  const exited = once(proc, 'exit');
  proc.kill('SIGKILL');
  await exited;
}

/**
 * Уборка после теста: проверки уже прошли (или упали), штатный выход окна ничего не проверяет,
 * а дом теста сейчас удалится. Процесс гасится сразу, и после этого окно уже не поднимет хост
 * заново — `stopHost` за ним гасит последний.
 */
export async function stopApp(app: ElectronApplication | null): Promise<void> {
  if (app !== null) await kill(app);
}

const QUIT_MARK = 'parley-e2e: quit';

/**
 * Штатный выход посреди теста — перед перезапуском окна с тем же домом: `app.quit()`,
 * `beforeunload` рендерера и `quit` main отрабатывают как у человека. Затем хвост разбора
 * Chromium не ждётся: как только main сообщил о `quit`, процесс добивается — он держит лок
 * одного экземпляра, и новый запуск иначе ушёл бы в `second-instance`.
 */
export async function quitApp(app: ElectronApplication): Promise<void> {
  const proc = running(app);
  if (proc === null) return;
  const exited = once(proc, 'exit');
  const quit = new Promise<void>((resolve) => {
    let seen = '';
    const onData = (chunk: Buffer): void => {
      seen += chunk.toString();
      if (!seen.includes(QUIT_MARK)) return;
      proc.stdout?.off('data', onData);
      resolve();
    };
    proc.stdout?.on('data', onData);
  });
  await app
    .evaluate(({ app: electronApp }, mark) => {
      // `writeSync`: pipe stdout на macOS асинхронен, а цикл событий после `quit` уже не крутится.
      const fs = process.getBuiltinModule('node:fs');
      electronApp.once('quit', () => fs.writeSync(1, `${mark}\n`));
      // Ответ evaluate уходит раньше, чем начнётся выход.
      setImmediate(() => electronApp.quit());
    }, QUIT_MARK)
    // Связь с main могла оборваться на самом выходе — дальше решают метка и `exit`.
    .catch(() => {});
  await Promise.race([quit, exited]);
  await kill(app);
}
