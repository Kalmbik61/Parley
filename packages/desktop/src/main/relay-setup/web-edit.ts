import { shQuote } from './input.js';
import { sha256 } from './templates.js';

/**
 * The transaction on the person's web server (spec 5.2): one fixed shell script per edit, `set -eu`, values only
 * through `shQuote`. The script contains no backslash (the login shell of the remote user may be fish), and the
 * plan sends it as base64 piped to `sh`. The page shows the summary, not the script.
 */

export const BACKUP_DIR = '/var/backups/parley-relay';

export type EditAction = 'add' | 'replace' | 'append' | 'remove' | 'remove-block';

export interface EditScript {
  action: EditAction;
  /** Path on the host. */
  target: string;
  /** sha256 of the target as the probe saw it; `null` — there was no file. */
  beforeSha: string | null;
  /** `add`/`replace`/`remove-block`: the whole new file; `append`: the text appended; `remove`: unused. */
  content: string;
  /** sha256 the target must have after the write (`remove`: the file must be gone). */
  afterSha: string | null;
  /** Check command run after the write; `null` — the reload does the checking (Caddy under systemd). */
  check: string | null;
  reload: string;
  /** Docker: the container the commands go to; it must still be running before anything is written. */
  containerId?: string | null;
  backupDir?: string;
}

/** Exit codes of the script: the step fails with the text on stderr. */
export const EDIT_EXIT = { changed: 3, space: 4, backup: 5, write: 6, check: 7, reload: 8, restore: 9, container: 10 } as const;

export const CONTAINER_CHANGED = 'the web server container changed since the survey; run the wizard again';

export const FILE_CHANGED = 'the file changed since the server was inspected: run the wizard again';

/** Expected sha256 of the target after the edit, computed on this machine from what the probe read. */
export function afterShaOf(action: EditAction, content: string, existing: string | null): string | null {
  if (action === 'remove') return null;
  if (action === 'append') return sha256((existing ?? '') + content);
  return sha256(content);
}

export function buildEditScript(edit: EditScript): string {
  const target = shQuote(edit.target);
  const dir = shQuote(edit.backupDir ?? BACKUP_DIR);
  const body = Buffer.from(edit.content, 'utf8').toString('base64');
  const write =
    edit.action === 'remove'
      ? 'rm -f "$T"'
      : `printf %s ${shQuote(body)} | base64 -d ${edit.action === 'append' ? '>>' : '>'} "$T"`;
  const verify =
    edit.afterSha === null
      ? '[ ! -e "$T" ]'
      : `[ "$(sha256sum "$T" | cut -d' ' -f1)" = ${shQuote(edit.afterSha)} ]`;
  return [
    'set -eu',
    `T=${target}`,
    `B=${dir}`,
    'cur=none',
    'if [ -e "$T" ]; then cur=$(sha256sum "$T" | cut -d" " -f1); fi',
    `[ "$cur" = ${shQuote(edit.beforeSha ?? 'none')} ] || { echo ${shQuote(FILE_CHANGED)} >&2; exit ${EDIT_EXIT.changed}; }`,
    ...(edit.containerId == null
      ? []
      : [`[ "$(docker inspect -f '{{.State.Running}}' ${shQuote(edit.containerId)} 2>/dev/null)" = true ] || { echo ${shQuote(CONTAINER_CHANGED)} >&2; exit ${EDIT_EXIT.container}; }`]),
    `free=$(df -Pk "$(dirname "$T")" | awk 'NR==2 {print $4}')`,
    '[ "$free" -ge 1024 ] || { echo "not enough free space next to the file" >&2; exit ' + EDIT_EXIT.space + '; }',
    'BK=',
    'if [ -e "$T" ]; then',
    '  mkdir -p "$B" && chmod 700 "$B" && BK="$B/$(date +%Y%m%d-%H%M%S)-$(basename "$T")" && cp -p "$T" "$BK" || { echo "backup failed: nothing was changed" >&2; exit ' + EDIT_EXIT.backup + '; }',
    'fi',
    'restore() { if [ -n "$BK" ]; then cp -p "$BK" "$T"; else rm -f "$T"; fi; }',
    // A restore that fails must not end silently: the person has to know where the original is.
    `undo() { restore || { echo "RESTORE FAILED: the original is in $BK" >&2; exit ${EDIT_EXIT.restore}; }; echo "$1" >&2; exit "$2"; }`,
    `${write} || undo "write failed: the file was restored" ${EDIT_EXIT.write}`,
    `${verify} || undo "write check failed: the file was restored" ${EDIT_EXIT.write}`,
    ...(edit.check === null ? [] : [`{ ${edit.check}; } || undo "check failed: the file was restored" ${EDIT_EXIT.check}`]),
    `${edit.reload} || undo "reload failed: the file was restored" ${EDIT_EXIT.reload}`,
    'echo "done: backup $BK"',
    '',
  ].join('\n');
}

/** The command the plan sends: the script as base64, decoded into `sh -c` (not piped to its stdin, where a command that reads stdin would eat the rest). */
export const editCommand = (script: string): string => `sh -c "$(printf %s ${shQuote(Buffer.from(script, 'utf8').toString('base64'))} | base64 -d)"`;

export interface CaddyTarget {
  runtime: 'docker' | 'host';
  /** Docker: the container id (passed the id pattern). */
  containerId: string | null;
  /** Docker: the Caddyfile path inside the container. */
  containerFile: string | null;
  /** `host:port` of the admin endpoint. */
  admin: string;
}

/** Check and reload of a Caddy edit (spec 5.2). Caddy under systemd has no separate check: the reload is atomic. */
export function caddyCommands(target: CaddyTarget): { check: string | null; reload: string } {
  if (target.runtime === 'host' || target.containerId === null || target.containerFile === null) {
    return { check: null, reload: 'systemctl reload caddy' };
  }
  const id = shQuote(target.containerId);
  const file = shQuote(target.containerFile);
  return {
    check: `docker exec ${id} caddy validate --config ${file} --adapter caddyfile`,
    reload: `docker exec ${id} caddy reload --config ${file} --adapter caddyfile --address ${shQuote(target.admin)}`,
  };
}

/** «Already done» for the `web` step: the target has the expected sha256 and the running server knows the site. */
export function webStepCheck(target: string, expectedSha: string, caddy: CaddyTarget, name: string): string {
  const same = `[ "$(sha256sum ${shQuote(target)} | cut -d' ' -f1)" = ${shQuote(expectedSha)} ]`;
  const url = `http://${caddy.admin}/config/`;
  const fetch = caddy.runtime === 'docker' && caddy.containerId !== null ? `docker exec ${shQuote(caddy.containerId)} wget -qO- ${shQuote(url)}` : `curl -s ${shQuote(url)}`;
  return `${same} && ${fetch} | grep -qF ${shQuote(name)}`;
}

export interface NginxTarget {
  runtime: 'docker' | 'host';
  containerId: string | null;
  /** The host name of our server block (it must not conflict with another one). */
  name: string;
  /** Our file as nginx sees it (inside the container for Docker). */
  file: string;
}

const nginxIn = (target: NginxTarget, command: string): string => (target.runtime === 'docker' && target.containerId !== null ? `docker exec ${shQuote(target.containerId)} ${command}` : command);

/**
 * Check and reload of an nginx edit (spec 5.2): `nginx -t` passes without «conflicting server name» for our name (nginx
 * would silently ignore such a block), and `nginx -T` lists our file. The reload does not report its own failure.
 */
export function nginxCommands(target: NginxTarget, removing = false): { check: string; reload: string } {
  const conflict = shQuote(`conflicting server name "${target.name}"`);
  const listed = shQuote(`# configuration file ${target.file}:`);
  // Removing our file: `nginx -t` passes and `nginx -T` no longer lists it.
  // The output of `nginx -t` is printed when it fails, so the person sees why in the window.
  const test = `out=$(${nginxIn(target, 'nginx -t')} 2>&1); rc=$?; [ $rc -eq 0 ] || echo "$out" >&2; [ $rc -eq 0 ]`;
  const check = removing
    ? `${test} && ! ${nginxIn(target, 'nginx -T')} 2>/dev/null | grep -qF ${listed}`
    : `${test} && { ! echo "$out" | grep -qF ${conflict} || { echo "$out" >&2; false; }; } && ${nginxIn(target, 'nginx -T')} 2>/dev/null | grep -qF ${listed}`;
  return {
    check,
    reload: nginxIn(target, 'nginx -s reload'),
  };
}

/** «Already done» for the `web` step of nginx: the sha256 is right and the running nginx lists our file. */
export function nginxStepCheck(hostFile: string, expectedSha: string, target: NginxTarget): string {
  const same = `[ "$(sha256sum ${shQuote(hostFile)} | cut -d' ' -f1)" = ${shQuote(expectedSha)} ]`;
  return `${same} && ${nginxIn(target, 'nginx -T')} 2>/dev/null | grep -qF ${shQuote(`# configuration file ${target.file}:`)}`;
}
