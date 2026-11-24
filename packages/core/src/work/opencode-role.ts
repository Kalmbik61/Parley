/**
 * What a role means for an OpenCode session at launch (spec 2026-11-12, 4.8 and 4.10, DO3/DO4). OpenCode has no role flags:
 * a read-only role becomes deny rules in the per-session config, and a writable one starts the TUI with `--auto`. The launch
 * (O5) calls `opencodeRoleLaunch` once and feeds the result to `buildOpencodeConfig` and to the `{autoFlag}` slot.
 */

import { opencodePermissions, type OpencodePermission } from './opencode-config.js';

/** The TUI flag of the start mode: everything not explicitly denied is approved (spec 4.10). */
export const OPENCODE_AUTO_FLAG = '--auto';

export interface OpencodeRoleLaunch {
  /** For `buildOpencodeConfig({ readOnly })`. */
  readOnly: boolean;
  /** The rules that config will carry (also for display and tests). */
  permissions: OpencodePermission[];
  /** `{autoFlag}`: `--auto` for a writable session, `undefined` (the slot drops) for a read-only one. */
  autoFlag: string | undefined;
}

export function opencodeRoleLaunch(choice: { readOnly: boolean }): OpencodeRoleLaunch {
  return {
    readOnly: choice.readOnly,
    permissions: opencodePermissions(choice.readOnly),
    autoFlag: choice.readOnly ? undefined : OPENCODE_AUTO_FLAG,
  };
}
