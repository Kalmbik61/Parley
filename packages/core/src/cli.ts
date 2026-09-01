#!/usr/bin/env node
// Контракт ядра с любым фронтендом: команды печатают в stdout ТОЛЬКО JSON.
// Диагностика идёт в stderr, код возврата ненулевой при ошибке.

import { defaultRoot, discoverSessions } from './discover.js';
import { buildIndex, buildSessionTree } from './session-tree.js';

const USAGE = `harnas-core — индекс сессий Claude Code в JSON

  harnas-core index [--root <путь>]         список сессий, свежие первыми
  harnas-core session <id> [--root <путь>]  сессия с подсессиями

  --json   формат по умолчанию и единственный, принимается для совместимости
  --root   корень истории (по умолчанию ~/.claude/projects, только чтение)`;

function optionValue(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const root = optionValue(argv, '--root') ?? defaultRoot();

  if (command === undefined || command === '--help' || command === '-h') {
    process.stderr.write(`${USAGE}\n`);
    return command === undefined ? 1 : 0;
  }

  if (command === 'index') {
    print(await buildIndex(root));
    return 0;
  }

  if (command === 'session') {
    const id = rest.find((arg) => !arg.startsWith('--'));
    if (id === undefined) {
      process.stderr.write('Нужен id сессии: harnas-core session <id>\n');
      return 1;
    }

    const sessions = await discoverSessions(root);
    // Сессию ищем и по sessionId из записей, и по имени файла — в UI встречаются оба.
    const found =
      sessions.find((session) => session.id === id) ??
      (await (async () => {
        for (const session of sessions) {
          const tree = await buildSessionTree(session, root);
          if (tree.session.id === id) return session;
        }
        return undefined;
      })());

    if (found === undefined) {
      process.stderr.write(`Сессия ${id} не найдена в ${root}\n`);
      return 1;
    }

    print(await buildSessionTree(found, root));
    return 0;
  }

  process.stderr.write(`Неизвестная команда: ${command}\n${USAGE}\n`);
  return 1;
}

process.exitCode = await main(process.argv.slice(2));
