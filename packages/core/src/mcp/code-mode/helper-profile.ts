// Code Mode helper sandbox profile (plan T4a, accepted T2b r4). The template is a compiled-in constant, byte-identical to
// the reviewed r4 template and pinned by its sha256: there is no profile file on disk to swap, and no option, env or
// argument selects another one. Rendering substitutes real absolute paths and refuses anything it cannot quote safely.

import { createHash } from 'node:crypto';
import path from 'node:path';

/** The accepted T2b r4 template (scratch `pkg-r4/helper.sb.template`, s-292 CLEAR m-3883, accepted m-3889). */
export const PROFILE_TEMPLATE = `(version 1)
; T2b r4 helper profile template (pinned by sha256; the parent substitutes @...@ with quoted real paths).
(deny default)
; exec of the pinned Node binary only: sandbox-exec execs it once; no fork, no other binary.
(allow process-exec (literal "@NODE@"))
; dyld and system libraries; "/" itself (literal, not a subpath) is read by dyld at startup.
(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/System") (literal "@NODE@"))
; the helper file, its probe module and the three pinned QuickJS package directories.
(allow file-read* (literal "@HELPER@") (literal "@PROBES@") (subpath "@QJS_CORE@") (subpath "@QJS_SYNC@") (subpath "@QJS_FFI@"))
; stat (metadata only, no contents) of the ancestors of those paths, needed by module resolution (realpath).
(allow file-read-metadata @ANCESTORS@)
; no sysctl-read is granted (the helper runs without it: minimisation from all 2024 \`sysctl -aN\` names to none).
; process-info* is NOT covered by (deny default) on this macOS; deny it explicitly: it gates kinfo_proc and
; KERN_PROCARGS2 (argv) of other same-uid processes.
(deny process-info*)
; Node needs process info about ITSELF (a full deny crashes it with SIGTRAP); nothing about any other process.
(allow process-info* (target self))
`;

export const PROFILE_TEMPLATE_SHA256 = '79a0306288b24f3551b43bb525722d4eb83a996b00009ec701cc61b3e093cb21';

/** The two process-info lines; removing exactly these is the fixture-only positive control (never done in product code). */
export const PROCESS_INFO_LINES = Object.freeze(['(deny process-info*)', '(allow process-info* (target self))']);

export const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

/**
 * Real absolute paths for one helper. `probes` is the second module the helper loads (the guest runtime, `guest.js`);
 * the r4 template names it "probe module" because in T2b the network probes lived there. `metadata` are the paths whose
 * metadata module resolution may stat: ancestors of every granted path plus the pnpm `node_modules` lookup entries
 * (directories and symlinks) on the way from the helper to the QuickJS packages.
 */
export interface ProfilePaths {
  readonly node: string;
  readonly helper: string;
  readonly probes: string;
  readonly qjsCore: string;
  readonly qjsSync: string;
  readonly qjsFfi: string;
  readonly metadata: readonly string[];
}

const PLACEHOLDER = /@([A-Z_]+)@/g;

/**
 * A path the profile can carry: absolute, normalized, no quote/backslash/control character and nothing that looks like
 * a placeholder. `@` itself is allowed (pnpm store paths contain it); substitution is single-pass, so a value is never
 * re-scanned for placeholders.
 */
export function profilePath(p: unknown): string {
  if (typeof p !== 'string' || !path.isAbsolute(p) || path.normalize(p) !== p || (p !== '/' && p.endsWith('/')) || p.length > 1024) throw new ProfileError('profile path must be an absolute normalized path');
  // eslint-disable-next-line no-control-regex
  if (/["\\\u0000-\u001f\u007f]/.test(p)) throw new ProfileError('profile path contains a character the profile cannot carry');
  if (/@[A-Z_]+@/.test(p)) throw new ProfileError('profile path looks like a placeholder');
  return p;
}

function checkTemplate(): void {
  if (sha256(PROFILE_TEMPLATE) !== PROFILE_TEMPLATE_SHA256) throw new ProfileError('profile template hash mismatch');
}

/** The helper profile: the pinned template with every placeholder replaced; nothing unresolved may remain. */
export function renderHelperProfile(paths: ProfilePaths): string {
  checkTemplate();
  const subst: Record<string, string> = {
    NODE: profilePath(paths.node),
    HELPER: profilePath(paths.helper),
    PROBES: profilePath(paths.probes),
    QJS_CORE: profilePath(paths.qjsCore),
    QJS_SYNC: profilePath(paths.qjsSync),
    QJS_FFI: profilePath(paths.qjsFfi),
  };
  const metadata = [...new Set(paths.metadata.map(profilePath))].sort();
  if (metadata.length === 0) throw new ProfileError('no metadata paths');
  subst.ANCESTORS = metadata.map((m) => `(literal "${m}")`).join(' ');
  // One pass over the template: every placeholder must be known, and substituted values are not scanned again.
  return PROFILE_TEMPLATE.replace(PLACEHOLDER, (_all, key: string) => {
    const value = subst[key];
    if (value === undefined) throw new ProfileError(`unknown placeholder ${key}`);
    return value;
  });
}

/**
 * The launch-probe profile: the SAME rendered helper profile plus exactly two grants, exec and read of the probe
 * binary's own literal path. Nothing else differs, so the probe tests the profile the helper actually runs under.
 */
export function renderProbeProfile(paths: ProfilePaths, probe: string): string {
  const p = profilePath(probe);
  return `${renderHelperProfile(paths)}(allow process-exec (literal "${p}"))\n(allow file-read* (literal "${p}"))\n`;
}

/** Every directory above `p` (excluding `/`, which the template grants as a literal). */
export function ancestorsOf(p: string): string[] {
  const out: string[] = [];
  for (let d = path.dirname(p); d !== '/' && d !== path.dirname(d); d = path.dirname(d)) out.push(d);
  return out;
}
