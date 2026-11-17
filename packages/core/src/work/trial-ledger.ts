/**
 * Список назначений опыта с пакетом состояния (план опыта 2026-11-17, Э-1б): `<дом>/trials/<имя опыта>.jsonl`, права 0600,
 * только дозапись, каждая строка сбрасывается на диск до продолжения. Это единственное, что переживает удаление рабочей
 * области вместе с картой: по списку подсчёт видит назначение, которого в картах уже нет.
 *
 * Протокол записи сессии с назначением (`withTrialAssignment`):
 * 1. намерение — до записи карты, создающей сессию; не записалось — сессия создаётся без плеча;
 * 2. ошибка записи карты сама ничего не доказывает (хранилище фиксирует запись и может бросить уже после): карта
 *    перечитывается и ищется метка. Метка в живой записи или в следе удалённой сессии — подтверждение. Отмена — только
 *    если всё сразу: номер создания работы тот же, что до записи, карта прочитана, метки нет ни в записях, ни в следах,
 *    и в работе нет повреждённых назначений и следов (`workHasTrialDamage`). Во всех остальных случаях (работа создаётся этой же операцией и её номера до записи нет;
 *    пересоздана; карта не читается) ничего не пишется, намерение остаётся без пары и читается как потерянная сессия;
 * 3. запись карты состоялась — подтверждение: метка, путь проекта, работа, её `incarnation`, сессия; не записалось —
 *    предупреждение, сессия остаётся в опыте.
 * Сверка идёт только по метке назначения (`SessionTrial.tag`), не по номерам работы и сессии.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { parleyHome } from '../home.js';
import { readMap, workIdentity } from './store.js';
import { workHasTrialDamage } from './trial-trace.js';
import { isTrialName, isTrialTag, TRIAL_ARMS, type SessionTrial, type TrialArm, type WorkMap } from './types.js';

/** Намерение: назначение собираются записать в карту. */
export interface TrialIntentLine { kind: 'intent'; tag: string; name: string; arm: TrialArm; at: string }
/** Отмена: запись карты не состоялась, сессии с этой меткой нет. */
export interface TrialCancelLine { kind: 'cancel'; tag: string; at: string }
/** Подтверждение: запись карты состоялась; `incarnation` — номер создания работы (`workIdentity`). */
export interface TrialConfirmLine {
  kind: 'confirm';
  tag: string;
  projectPath: string;
  workId: string;
  incarnation: number;
  sessionId: string;
  at: string;
}
export type TrialLedgerLine = TrialIntentLine | TrialCancelLine | TrialConfirmLine;

/** Файл списка назначений опыта; имя опыта проверяется как в настройке, чужое имя пути не строит. */
export function trialLedgerFile(name: string, home: string = parleyHome()): string {
  if (!isTrialName(name)) throw new Error(`invalid trial name: ${JSON.stringify(name)}`);
  return path.join(home, 'trials', `${name}.jsonl`);
}

/** Операции дозаписи; тест подменяет их, чтобы вызвать нулевую и частичную запись или сбой сброса каталога. */
export interface TrialLedgerIo {
  /** Записывает не больше `buffer.length - offset` байт с `offset`, возвращает число записанных. */
  write: (fd: number, buffer: Buffer, offset: number) => number;
  /** Сбрасывает каталог на диск; ошибка — ошибка записи. */
  syncDirectory: (dir: string) => void;
}

const realIo: TrialLedgerIo = {
  write: (fd, buffer, offset) => writeSync(fd, buffer, offset, buffer.length - offset),
  syncDirectory: (dir) => {
    // Windows не открывает каталог для `fsync`: там сброса каталога нет, это не ошибка.
    if (process.platform === 'win32') return;
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
};

/**
 * Дописывает строку и сбрасывает её на диск до возврата. Каталог и файл создаются при первой строке (файл — 0600);
 * опыт без назначений каталога `trials` не создаёт. Строка записана целиком либо это ошибка: ноль записанных байт —
 * ошибка, частичная запись дописывается до конца. Каталог `trials` и его родитель сбрасываются на диск при каждой
 * дозаписи — повтор после сбоя не пропускает сброс, потому что файл уже есть; сбой сброса — ошибка, назначение не
 * состоялось. Исключение решает вызывающий.
 */
export function appendTrialLedger(name: string, line: TrialLedgerLine, home: string = parleyHome(), io: TrialLedgerIo = realIo): void {
  const file = trialLedgerFile(name, home);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const buffer = Buffer.from(`${JSON.stringify(line)}\n`);
  const fd = openSync(file, 'a', 0o600);
  try {
    let written = 0;
    while (written < buffer.length) {
      const count = io.write(fd, buffer, written);
      if (!(count > 0)) throw new Error(`trial ledger ${file}: wrote ${written} of ${buffer.length} bytes`);
      written += count;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  io.syncDirectory(dir);
  io.syncDirectory(path.dirname(dir));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Одна строка списка; `undefined` — строка неверной формы. */
function parseLine(value: unknown): TrialLedgerLine | undefined {
  if (!isRecord(value) || !isTrialTag(value['tag']) || !isTime(value['at'])) return undefined;
  const { tag, at } = value;
  if (value['kind'] === 'cancel') return { kind: 'cancel', tag, at };
  if (value['kind'] === 'intent') {
    if (!isTrialName(value['name']) || !TRIAL_ARMS.includes(value['arm'] as TrialArm)) return undefined;
    return { kind: 'intent', tag, name: value['name'], arm: value['arm'] as TrialArm, at };
  }
  if (value['kind'] === 'confirm') {
    const { projectPath, workId, incarnation, sessionId } = value;
    if (typeof projectPath !== 'string' || typeof workId !== 'string' || typeof sessionId !== 'string' ||
      typeof incarnation !== 'number' || !Number.isInteger(incarnation)) return undefined;
    return { kind: 'confirm', tag, projectPath, workId, incarnation, sessionId, at };
  }
  return undefined;
}

export interface TrialLedger {
  lines: TrialLedgerLine[];
  /** Номера (с единицы) строк, которые не разобрались: потерю по такому файлу заметить нельзя. */
  unreadable: number[];
}

/**
 * Разбор текста списка назначений: так его читает подсчёт (`tools/room-packet-trial.ts`), без своего разбора. Пустые
 * строки пропускаются; строка неверной формы не пропадает молча, а попадает в `unreadable`.
 */
export function parseTrialLedger(text: string): TrialLedger {
  const lines: TrialLedgerLine[] = [];
  const unreadable: number[] = [];
  text.split('\n').forEach((raw, index) => {
    if (raw.trim() === '') return;
    let parsed: TrialLedgerLine | undefined;
    try {
      parsed = parseLine(JSON.parse(raw));
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) unreadable.push(index + 1);
    else lines.push(parsed);
  });
  return { lines, unreadable };
}

/**
 * Читает список назначений опыта (только чтение) прямым чтением; `undefined` — файла нет (`ENOENT`). Любая другая ошибка,
 * в том числе недоступный родительский каталог, — исключение: нечитаемый файл не равен отсутствующему.
 */
export function readTrialLedger(name: string, home: string = parleyHome()): TrialLedger | undefined {
  const file = trialLedgerFile(name, home);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    // «Файла нет» — только подтверждённое отсутствие. Недоступный или не каталог родитель, права, сбой диска — наружу.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return parseTrialLedger(text);
}

export interface UnresolvedIntent {
  intent: TrialIntentLine;
  /** Строка подтверждения, если она есть: по ней называются работа и сессия. */
  confirm?: TrialConfirmLine;
}

/** Намерения без отмены. Подсчёт сверяет их метки с картами и следами: не найденная ни там, ни там — потерянная сессия. */
export function unresolvedIntents(lines: readonly TrialLedgerLine[]): UnresolvedIntent[] {
  const cancelled = new Set(lines.filter((line) => line.kind === 'cancel').map((line) => line.tag));
  const confirms = new Map(lines.filter((line): line is TrialConfirmLine => line.kind === 'confirm').map((line) => [line.tag, line]));
  return lines
    .filter((line): line is TrialIntentLine => line.kind === 'intent' && !cancelled.has(line.tag))
    .map((intent) => {
      const confirm = confirms.get(intent.tag);
      return confirm === undefined ? { intent } : { intent, confirm };
    });
}

/** Работа, в карту которой пишется сессия: по ней строка подтверждения и перечитывание карты после сбоя. */
export interface TrialTarget { projectPath: string; workId: string }

export interface TrialProtocolOptions {
  /** Перечитывание карты после сбоя записи; по умолчанию — `readMap`. Тест подменяет, чтобы карту нельзя было прочитать. */
  readMap?: (projectPath: string, workId: string) => Promise<WorkMap>;
  /** Предупреждение хоста: сбой записи намерения, отмены или подтверждения. */
  warn?: (message: string) => void;
  /** Дом Parley; по умолчанию — `parleyHome()`. */
  home?: string;
  /** Дозапись в список; тест подменяет, чтобы вызвать сбой отдельной строки. */
  append?: (name: string, line: TrialLedgerLine, home: string) => void;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Запись сессии с назначением по протоколу списка (см. шапку модуля). `commit` получает назначение или `undefined`, если
 * намерение не записалось, и должен делать ровно запись карты: сбой того, что идёт после неё (бриф и прочее), отменой
 * не считается. Без назначения — просто `commit(undefined)`: ни файла, ни каталога `trials`.
 */
export async function withTrialAssignment<T>(
  trial: SessionTrial | undefined,
  target: TrialTarget,
  commit: (trial: SessionTrial | undefined) => Promise<T>,
  sessionOf: (result: T) => string,
  options: TrialProtocolOptions = {},
): Promise<T> {
  if (trial === undefined) return commit(undefined);
  const home = options.home ?? parleyHome();
  const append = options.append ?? appendTrialLedger;
  const warn = options.warn ?? ((): void => undefined);
  const confirm = (sessionId: string): void => {
    try {
      const identity = workIdentity(target.projectPath, target.workId);
      if (identity === undefined) throw new Error(`workspace ${target.workId} has no identity`);
      append(trial.name, {
        kind: 'confirm',
        tag: trial.tag,
        projectPath: target.projectPath,
        workId: target.workId,
        incarnation: identity.incarnation,
        sessionId,
        at: new Date().toISOString(),
      }, home);
    } catch (error) {
      warn(`trial assignment ${trial.tag} stays in the experiment, the confirm line was not written: ${describe(error)}`);
    }
  };
  try {
    append(trial.name, { kind: 'intent', tag: trial.tag, name: trial.name, arm: trial.arm, at: trial.at }, home);
  } catch (error) {
    warn(`trial assignment skipped, the intent line was not written: ${describe(error)}`);
    return commit(undefined);
  }
  // Номер создания работы до записи: без него (работы ещё нет) отмену ничто не доказывает.
  const incarnationBefore = workIdentity(target.projectPath, target.workId)?.incarnation;
  let result: T;
  try {
    result = await commit(trial);
  } catch (error) {
    // Сама ошибка записи ничего не доказывает: хранилище фиксирует запись и может бросить уже после. Решает карта.
    // Метка в живой записи или в следе удалённой сессии — подтверждение. Отмена — только если всё сразу: номер создания
    // работы прежний, карта прочитана, метки нет ни в записях, ни в следах, и следы не повреждены. Иначе ничего не
    // пишется, намерение остаётся без пары и читается как потерянная сессия.
    try {
      const map = await (options.readMap ?? readMap)(target.projectPath, target.workId);
      const live = map.sessions.find((session) => session.trial !== undefined && 'tag' in session.trial && session.trial.tag === trial.tag)?.id;
      const traced = (map.work.trialTrace?.sessions ?? []).find((entry) => !('damaged' in entry) && 'tag' in entry.trial && entry.trial.tag === trial.tag);
      const found = live ?? (traced !== undefined && !('damaged' in traced) ? traced.session : undefined);
      if (found !== undefined) confirm(found);
      else {
        const sameWork = incarnationBefore !== undefined && workIdentity(target.projectPath, target.workId)?.incarnation === incarnationBefore;
        if (sameWork && !workHasTrialDamage(map)) {
          try {
            append(trial.name, { kind: 'cancel', tag: trial.tag, at: new Date().toISOString() }, home);
          } catch (cancelError) {
            warn(`trial assignment ${trial.tag} stays open, the cancel line was not written: ${describe(cancelError)}`);
          }
        } else {
          warn(`trial assignment ${trial.tag} stays open: the absence of its record could not be proven`);
        }
      }
    } catch (readError) {
      warn(`trial assignment ${trial.tag} stays open, the workspace could not be read after the failed write: ${describe(readError)}`);
    }
    throw error;
  }
  confirm(sessionOf(result));
  return result;
}
