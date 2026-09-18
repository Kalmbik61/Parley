import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Роль сессии — агент Claude Code: файл `.claude/agents/<name>.md` проекта или
 * `~/.claude/agents/<name>.md` пользователя (спецификация 2026-09-08, 5.1).
 * Харнесс только смотрит, что такой файл есть: содержимое не читается, а в
 * `~/.claude` он не пишет никогда — каталог пользователя чужой.
 */

/** Каталоги определений: сначала проектный, потом пользовательский. */
export function agentDirs(
  projectPath: string,
  claudeHome = path.join(homedir(), '.claude'),
): string[] {
  return [path.join(projectPath, '.claude', 'agents'), path.join(claudeHome, 'agents')];
}

/** Имена агентов из обоих каталогов: без расширения, без повторов, по алфавиту. */
export async function listAgents(dirs: readonly string[]): Promise<string[]> {
  const names = new Set<string>();
  for (const dir of dirs) {
    // Каталога может не быть вовсе — это не ошибка, а «ролей тут не заводили».
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const entry of entries) if (entry.endsWith('.md')) names.add(entry.slice(0, -3));
  }
  return [...names].sort();
}

/**
 * Проверяет роль перед записью в карту: имени без определения быть не должно,
 * иначе `claude --agent` упадёт уже после того, как запись `pending` появилась
 * (спецификация 2026-09-08, раздел 7). Ошибка перечисляет найденные имена —
 * чаще всего это опечатка.
 */
export async function assertAgent(name: string, dirs: readonly string[]): Promise<void> {
  // Имя идёт в путь файла: пробелы и `..` отсекаем до похода на диск.
  if (!/^[\w.-]+$/.test(name)) {
    throw new Error(`агент ${name}: имя — буквы, цифры, точка, дефис, подчёркивание`);
  }
  for (const dir of dirs) {
    const ok = await stat(path.join(dir, `${name}.md`))
      .then((info) => info.isFile())
      .catch(() => false);
    if (ok) return;
  }

  const known = await listAgents(dirs);
  throw new Error(
    known.length === 0
      ? `агента ${name} нет: ни в .claude/agents/ проекта, ни в ~/.claude/agents/`
      : `агента ${name} нет; найдены: ${known.join(', ')}`,
  );
}
