import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopHost } from './stop-host.js';
import { RUN_HOMES_ENV } from './tmp.js';

/**
 * Список домов этого прогона (`makeTempHome`) и уборка по нему в конце: воркер, снятый по
 * таймауту, не выполняет afterEach, и хост его теста иначе жил бы дальше. Воркеры наследуют
 * окружение, заданное здесь.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  // Без собранного хоста окну нечего поднимать: раньше каждый спек молча пропускался по
  // test.skip, и прогон выглядел зелёным из одних пропусков (ревью M10). Теперь — отказ сразу.
  const hostEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../host/dist/main.js');
  if (!existsSync(hostEntry)) {
    throw new Error(`E2E окна: не собран хост ${hostEntry} — сначала pnpm --filter @parley/host build`);
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'parley-e2e-run-'));
  const list = path.join(dir, 'homes');
  process.env[RUN_HOMES_ENV] = list;
  // Хост каждого теста строит индекс истории агентов (раунд lane-r3, п. 1): пустые корни
  // прогона вместо `~/.claude/projects` и `~/.codex/sessions` — тесты не читают историю
  // человека, и хост не занят её гигабайтами в первые секунды теста.
  const claudeHistory = path.join(dir, 'claude-projects');
  const codexHistory = path.join(dir, 'codex-sessions');
  await mkdir(claudeHistory);
  await mkdir(codexHistory);
  process.env.HARNAS_CLAUDE_PROJECTS_DIR = claudeHistory;
  process.env.HARNAS_CODEX_SESSIONS_DIR = codexHistory;
  // Хост на старте спрашивает версию CLI (`<команда> --version`). В E2E настоящие claude и codex
  // запускать нельзя, а подменён у спеков только claude (и не у всех): пробу отключаем целиком.
  process.env.HARNAS_SKIP_VERSION_PROBE = '1';

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
