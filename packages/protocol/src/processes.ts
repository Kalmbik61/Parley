import type { SessionRef } from './types.js';

/**
 * Процесс сессии для тулбара (план `docs/plans/2026-11-09-session-shell-processes-plan.md`).
 * Только безопасные поля: имя исполняемого файла и наблюдаемые метрики `ps`. Аргументов, окружения,
 * cwd и полного пути в схеме нет и быть не должно (b-030).
 */
export interface SessionProcess {
  pid: number;
  /** `ucomm` процесса без хвостовых пробелов (macOS: до 16 символов); не `comm` и не argv. */
  name: string;
  /** `etime` как выдал `ps` (`01:02:03`, `2-03:04:05`). */
  elapsed: string;
  cpuPct: number | null;
  memPct: number | null;
  rssKb: number | null;
}

/**
 * Полный заменяющий снимок процессов сессии. `revision` растёт по хосту монотонно: окно отбрасывает
 * снимок со ревизией не больше уже принятой. `available: false` — данных нет (PTY вышел, `ps` ещё не
 * ответил); `processes` тогда пуст. `approximate` — классификация неполна (Codex).
 */
export interface SessionProcessesSnapshot {
  ref: SessionRef;
  revision: number;
  available: boolean;
  approximate: boolean;
  processes: SessionProcess[];
}
