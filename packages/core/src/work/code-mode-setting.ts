// The human's Code Mode setting (plan T12a, §3; human m-4838: requested ON by default). A request, never a grant: a launch still runs classic
// until its provider passes its gates. Turning it off is kept twice, in `config.json` and as a row in the store, so that deleting, truncating or
// replacing the config file does not silently turn it back on.
//
// **This is no boundary against a process of the same user.** An agent runs as the human: it can edit both stores. The row guards against an
// accident or a careless script, not a determined one. Re-enabling grants nothing new: a nested call has the same token and host authority as the
// direct tool. The setting is the human's preference, honoured by Parley's launcher.
//
// Who reads what: the launcher reads both (`codeModeRequested`). A session's MCP process reads only `config.json` (mid-session off is
// that file's `false`, which every off writes unless both writes fail); it never opens the store.

import { readFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { configPath, saveConfig } from '../config.js';
import { storeDb } from './store.js';

/** What `config.json` says about Code Mode, keeping missing apart from unreadable: a corrupt file reads as off. */
export type CodeModeConfigValue = 'on' | 'off' | 'missing' | 'unreadable';

export async function readCodeModeConfig(file: string = configPath()): Promise<CodeModeConfigValue> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return 'unreadable'; }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'unreadable';
  const value = (data as Record<string, unknown>)['codeMode'];
  if (value === undefined) return 'missing';
  return value === true ? 'on' : value === false ? 'off' : 'unreadable';
}

export type TombstoneState = 'set' | 'clear' | 'unreadable';

export function readTombstone(db: DatabaseSync = storeDb()): TombstoneState {
  try {
    const row = db.prepare('SELECT off FROM code_mode_preference WHERE singleton = 1').get() as { off: number } | undefined;
    return row === undefined ? 'clear' : row.off === 1 ? 'set' : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/**
 * The launcher's reading, in one pure function. A missing initial setting requests ON (the default); a recorded off survives the config's
 * deletion, truncation or replacement; anything unreadable reads as OFF.
 */
export function codeModeRequestedFrom(config: CodeModeConfigValue, tombstone: TombstoneState): boolean {
  if (tombstone !== 'clear') return false;
  return config === 'on' || config === 'missing';
}

export async function codeModeRequested(file: string = configPath(), db?: DatabaseSync): Promise<boolean> {
  let tombstone: TombstoneState;
  try { tombstone = readTombstone(db ?? storeDb()); } catch { tombstone = 'unreadable'; }
  return codeModeRequestedFrom(await readCodeModeConfig(file), tombstone);
}

/**
 * What the window is told:
 * - `off`: off for new launches and, through config.json, for running sessions at their next check;
 * - `off-not-durable`: off now through config.json, but the row was not written, so deleting that file would undo it;
 * - `off-next-launch`: the row was written and config.json was not: off for new launches only. A running session reads config.json alone, so it
 *   is not stopped by this (lead m-7117).
 */
export type CodeModeSetResult = 'on' | 'off' | 'off-not-durable' | 'off-next-launch';

/**
 * The same four states read back from disk, for the window on open (lead m-7289, R2): a partial off must stay visible after the window is
 * reopened, not only in the reply to the write. `on` exactly when the launcher requests it (`codeModeRequestedFrom`).
 * - row recorded (or unreadable, which the launcher reads as off) and config.json still on or missing: `off-next-launch`;
 * - row recorded and config.json off or unreadable: `off`;
 * - no row and config.json off or unreadable: `off-not-durable`, since deleting the file would turn it back on;
 * - no row and config.json on or missing: `on`.
 */
export function codeModeStateFrom(config: CodeModeConfigValue, tombstone: TombstoneState): CodeModeSetResult {
  const configOn = config === 'on' || config === 'missing';
  if (tombstone !== 'clear') return configOn ? 'off-next-launch' : 'off';
  return configOn ? 'on' : 'off-not-durable';
}

export async function codeModeState(file: string = configPath(), db?: DatabaseSync): Promise<CodeModeSetResult> {
  let tombstone: TombstoneState;
  try { tombstone = readTombstone(db ?? storeDb()); } catch { tombstone = 'unreadable'; }
  return codeModeStateFrom(await readCodeModeConfig(file), tombstone);
}

export class CodeModeNotSaved extends Error {
  constructor(readonly previous: 'on' | 'off') {
    super(`Code Mode setting was not saved; it is still ${previous}`);
    this.name = 'CodeModeNotSaved';
  }
}

export interface CodeModeStores {
  writeTombstone(): void;
  clearTombstone(): void;
  writeConfig(on: boolean): Promise<void>;
  /** For the not-saved message only. */
  current(): Promise<boolean>;
}

export function realStores(file: string = configPath(), db?: DatabaseSync): CodeModeStores {
  const store = (): DatabaseSync => db ?? storeDb();
  return {
    writeTombstone: () => { store().prepare('INSERT INTO code_mode_preference (singleton, off, at) VALUES (1, 1, ?) ON CONFLICT(singleton) DO UPDATE SET at = excluded.at').run(new Date().toISOString()); },
    clearTombstone: () => { store().prepare('DELETE FROM code_mode_preference WHERE singleton = 1').run(); },
    writeConfig: (on) => saveConfig({ codeMode: on }, file),
    current: () => codeModeRequested(file, db),
  };
}

/**
 * The only way to change it. Ordered so that every partial failure errs towards OFF:
 * - off: the row first, then `config.json` false. Row fails: config still tried, `off-not-durable`. Config fails: `off-next-launch`. Both fail:
 *   `CodeModeNotSaved`.
 * - on: `config.json` true first, then the row cleared, last. Config fails or the clear fails: `CodeModeNotSaved` with what the launcher
 *   reads now (still off after an off; still on when it was on already, s-296 m-7139).
 *   So nothing reads ON after a human's off unless both steps of an explicit on finished.
 * A crash between the steps leaves off in both directions. Durability: SQLite's commit (WAL, synchronous NORMAL: survives a process crash,
 * not stated for power loss) and an atomic rename of the config.
 */
export async function setCodeMode(on: boolean, stores: CodeModeStores = realStores()): Promise<CodeModeSetResult> {
  const notSaved = async (): Promise<CodeModeNotSaved> => new CodeModeNotSaved((await stores.current().catch(() => false)) ? 'on' : 'off');
  if (!on) {
    let durable = true;
    try { stores.writeTombstone(); } catch { durable = false; }
    let configWritten = true;
    try { await stores.writeConfig(false); } catch { configWritten = false; }
    if (durable && configWritten) return 'off';
    if (durable) return 'off-next-launch';
    if (configWritten) return 'off-not-durable';
    throw await notSaved();
  }
  try { await stores.writeConfig(true); } catch { throw await notSaved(); }
  try { stores.clearTombstone(); } catch { throw await notSaved(); }
  return 'on';
}
