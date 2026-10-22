import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Согласие на папку проекта до старта приложения (спека 2026-10-21, 4.1): хост удерживает каждый запуск Codex в проекте
 * без записи в `<PARLEY_HOME>/trust.json` и ждёт человека на острове, поэтому спеки, где стартует сессия Codex, сеют
 * согласие сами, как это сделал бы диалог композера. Ключ записи — realpath папки (на macOS `/var` лежит за ссылкой
 * `/private/var`, а Codex и хост сравнивают именно realpath). Повторный вызов дописывает папку к уже посеянным.
 * Форма файла — `core/src/work/trust.ts` (`TrustFile`): версия 1, права 0600.
 */
export async function seedTrust(home: string, folder: string): Promise<void> {
  const file = path.join(home, 'trust.json');
  const key = await realpath(folder);
  let folders: Record<string, { grantedAt: string; by: 'window' }> = {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { folders?: typeof folders };
    folders = parsed.folders ?? {};
  } catch {
    // Файла ещё нет — первая папка этого дома.
  }
  folders[key] = { grantedAt: new Date().toISOString(), by: 'window' };
  await mkdir(home, { recursive: true });
  const tmp = `${file}.seed.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, folders }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}
