import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { alivePids, descendantPids } from './descendants.js';

/** Вывод `ps -axo pid=,ppid=`: у настоящего `ps` колонки выровнены пробелами. Дерево 1 → 2 → 3 и 1 → 4, чужой 5 и init 0. */
const PS = ['    1     0', '    2     1', '    3     2', '    4     1', '    5     0', ''].join('\n');

describe('descendantPids', () => {
  it('потомки корня транзитивно по одному снимку; корень и чужое дерево не попадают', async () => {
    expect(await descendantPids(1, async () => PS)).toEqual([2, 3, 4]);
  });

  it('порядок строк снимка на результат не влияет', async () => {
    const shuffled = ['    4     1', '    3     2', '    5     0', '    2     1', '    1     0'].join('\n');

    expect(await descendantPids(1, async () => shuffled)).toEqual([2, 3, 4]);
  });

  it('у листа и у процесса, которого нет в снимке, потомков нет', async () => {
    expect(await descendantPids(3, async () => PS)).toEqual([]);
    expect(await descendantPids(999, async () => PS)).toEqual([]);
  });

  it('замкнутое родство не зацикливает обход, и корень в потомках не оказывается', async () => {
    const cycle = ['    1     3', '    2     1', '    3     2'].join('\n');

    expect(await descendantPids(1, async () => cycle)).toEqual([2, 3]);
  });

  it('строки не из двух чисел пропускаются', async () => {
    const noisy = ['  PID  PPID', '    2     1', 'ps: что-то', '    3     2 лишнее', '    4     1', ''].join('\n');

    expect(await descendantPids(1, async () => noisy)).toEqual([2, 4]);
  });

  it('сбой ps — пустой список, а не ошибка', async () => {
    const failing = async (): Promise<string> => {
      throw new Error('ps: не запустился');
    };

    expect(await descendantPids(1, failing)).toEqual([]);
  });

  // Единственная проверка настоящего `ps`: вывод подделки выше он не подтверждает, а при неверных ключах сон молча
  // остался бы без данных (сбой ps — пустой список).
  it('настоящий ps: порождённый тестом процесс найден среди потомков', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      expect(child.pid).toBeDefined();
      expect(await descendantPids(process.pid)).toContain(child.pid);
    } finally {
      child.kill();
    }
  });
});

describe('alivePids', () => {
  it('оставляет только живых, порядок сохраняется', () => {
    expect(alivePids([2, 3, 4], (pid) => pid !== 3)).toEqual([2, 4]);
    expect(alivePids([2, 3, 4], () => false)).toEqual([]);
    expect(alivePids([], () => true)).toEqual([]);
  });

  it('по умолчанию проверяет настоящие процессы: свой жив, несуществующего нет', () => {
    expect(alivePids([process.pid, 2_147_483_646])).toEqual([process.pid]);
  });
});
