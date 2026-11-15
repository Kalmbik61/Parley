import type { UpdateResult, UpdateResultFailure } from '../shared/bridge.js';

/**
 * Самообновление: сценарий замены приложения и формат файла итога (спека self-update §5.5). Сценарий — обычный
 * POSIX sh для `/bin/sh` macOS; main пишет его в каталог подготовки и запускает после выхода окна (U6).
 *
 * Пути приложения и версия в текст сценария не попадают: он получает их аргументами (раскрытие в двойных кавычках,
 * никогда не в разборе текста). В текст идут только константы: время ожидания и пути утилит.
 */

/** Предел ожидания конца окна и чужих процессов приложения (спека §5.5). */
export const HELPER_WAIT_MS = 60_000;
/** Шаг опроса сценария: `sleep 0.1`. */
export const HELPER_POLL_MS = 100;

/** Пути утилит по умолчанию (спека §5.5). */
export const HELPER_TOOLS = {
  mv: '/bin/mv',
  rm: '/bin/rm',
  lockf: '/usr/bin/lockf',
  open: '/usr/bin/open',
  ps: '/bin/ps',
} as const;

export interface HelperOptions {
  /** Предел ожидания, мс: отдельно для конца окна и для чужих процессов приложения. */
  waitMs?: number;
  mv?: string;
  rm?: string;
  lockf?: string;
  open?: string;
  ps?: string;
}

/** Строка в одинарных кавычках для sh; путь с `'`, пробелом, `$` или `*` остаётся одним словом без раскрытия. */
function shellQuote(value: string, what: string): string {
  if (value === '' || value.includes('\0'))
    throw new Error(`bad ${what}: ${JSON.stringify(value)}`);
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Текст сценария. Аргументы запуска: pid окна, путь приложения, путь подготовленного приложения, версия, путь итога.
 * Все шаги, исходы и состояние диска — таблица спеки §5.5; код выхода сценария main не читает (кроме 64 для тестов:
 * аргументы не прошли проверку, на диске ничего не тронуто).
 */
export function helperScript(options: HelperOptions = {}): string {
  const waitMs = options.waitMs ?? HELPER_WAIT_MS;
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error(`bad waitMs: ${waitMs}`);
  const ticks = Math.ceil(waitMs / HELPER_POLL_MS);
  const tool = (key: keyof typeof HELPER_TOOLS): string =>
    shellQuote(options[key] ?? HELPER_TOOLS[key], key);

  // Внимание: это обычный шаблон JS. `\${` даёт `${` оболочки, `\\n` даёт `\n` в printf.
  return `#!/bin/sh
# Replace Parley with the prepared version (spec self-update §5.5).
# Run: /bin/sh helper.sh <window pid> <app> <prepared app> <version> <result file>
# Paths and version arrive only as arguments and are always expanded inside double quotes.

MV=${tool('mv')}
RM=${tool('rm')}
LOCKF=${tool('lockf')}
OPEN=${tool('open')}
PS=${tool('ps')}
SLEEP='/bin/sleep'
TICKS=${ticks}

PID=
APP=
STAGED=
VERSION=
RESULT=
APPDIR=
APPBASE=
STAGEDIR=
OLD=
LOCK=

# Version of the form X.Y.Z: digits only and two dots.
is_version() {
  case $1 in ''|*[!0-9.]*|*.) return 1 ;; esac
  _old_ifs=$IFS
  IFS=.
  set -- $1
  IFS=$_old_ifs
  [ "$#" -eq 3 ] && [ -n "$1" ] && [ -n "$2" ] && [ -n "$3" ]
}

# Argument check before any action: a broken call touches nothing.
check_args() {
  [ "$#" -eq 5 ] || return 1
  case $1 in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -gt 0 ] || return 1
  is_version "$4" || return 1
  case $2 in /*) ;; *) return 1 ;; esac
  case $3 in /*) ;; *) return 1 ;; esac
  case $5 in /*) ;; *) return 1 ;; esac
  APPDIR=\${2%/*}
  APPBASE=\${2##*/}
  case $APPBASE in ?*.app) ;; *) return 1 ;; esac
  case \${3##*/} in ?*) ;; *) return 1 ;; esac
  STAGEDIR=\${3%/*}
  # The staging directory sits next to the app and has the name from the spec: the script removes it whole.
  [ "\${STAGEDIR%/*}" = "$APPDIR" ] || return 1
  case \${STAGEDIR##*/} in ".$APPBASE.update-"?*) ;; *) return 1 ;; esac
  PID=$1
  APP=$2
  STAGED=$3
  VERSION=$4
  RESULT=$5
  OLD="$APPDIR/.$APPBASE.old"
  LOCK="$APPDIR/.$APPBASE.swap"
  return 0
}

exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

# Tree removal: only a non-empty absolute path, not made of slashes alone.
rm_tree() {
  case $1 in /*[!/]*) ;; *) return 1 ;; esac
  "$RM" -rf -- "$1"
}

write_result() {
  { printf '%s\\n' "$1" > "$RESULT"; } 2>/dev/null || :
}

remove_staging() {
  if [ -d "$STAGEDIR" ]; then
    rm_tree "$STAGEDIR" || :
  fi
  return 0
}

# Step 1: wait for the window process to end.
wait_window() {
  _n=0
  while kill -0 "$PID" 2>/dev/null; do
    [ "$_n" -lt "$TICKS" ] || return 1
    "$SLEEP" 0.1
    _n=$((_n + 1))
  done
  return 0
}

# Step 1a: swap lock, a kernel lock on a file next to the app, without waiting. The kernel releases it when the
# last process holding the descriptor ends. The lock file is never removed and holds nothing.
# A failed open under \`||\` does not end the shell (checked on macOS /bin/sh); \`command exec\` does not work: bash 3.2 crashes.
take_lock() {
  exec 9>"$LOCK" || return 1
  "$LOCKF" -s -t 0 9
}

# Step 2: is there a process whose executable lies in <app>/Contents/MacOS/ (exact start of the string).
# If the list could not be obtained, assume a process exists.
others_running() {
  _out=$("$PS" -axo comm= 2>/dev/null) || return 0
  _prefix="$APP/Contents/MacOS/"
  printf '%s\\n' "$_out" | {
    while IFS= read -r _line; do
      case $_line in "$_prefix"*) exit 0 ;; esac
    done
    exit 1
  }
}

wait_others() {
  _n=0
  while others_running; do
    [ "$_n" -lt "$TICKS" ] || return 1
    "$SLEEP" 0.1
    _n=$((_n + 1))
  done
  return 0
}

# Steps 2-6 refused: write the result; if the app is in place, remove the staging directory and open the old app.
fail() {
  write_result "failed $VERSION $1"
  if [ -d "$APP" ]; then
    remove_staging
    "$OPEN" "$APP" 9>&- || :
  fi
  return 0
}

# Put the old app back in place: if that failed (including when the place is taken), there is no app.
put_back() {
  exists "$APP" && return 1
  "$MV" "$OLD" "$APP"
}

main() {
  check_args "$@" || return 64

  # quit_timeout: nothing touched, no result.
  wait_window || return 0

  # busy: remove own staging directory, open the app; no result.
  if ! take_lock; then
    remove_staging
    "$OPEN" "$APP" 9>&- || :
    return 0
  fi

  if ! wait_others; then
    fail still_running
    return 0
  fi

  if [ ! -d "$APP" ] || [ ! -d "$STAGED" ]; then
    fail no_app
    return 0
  fi

  # Step 4: leftover of a previous swap; the app is in place, so this is not the only copy.
  if exists "$OLD"; then
    if ! rm_tree "$OLD"; then
      fail swap_failed
      return 0
    fi
  fi

  # Step 5: before each mv the destination must not exist: mv onto an existing directory puts the source inside.
  if exists "$OLD" || ! "$MV" "$APP" "$OLD"; then
    fail swap_failed
    return 0
  fi

  # Step 6: prepared app into place; if that failed, put the old one back.
  if exists "$APP" || ! "$MV" "$STAGED" "$APP"; then
    if put_back; then
      fail swap_failed
    else
      write_result "failed $VERSION restore_failed"
    fi
    return 0
  fi

  # Step 7: result, then open the new app with the lock descriptor closed.
  write_result "swapped $VERSION"
  if ! "$OPEN" "$APP" 9>&-; then
    write_result "failed $VERSION launch_failed"
  fi

  # Step 8: staging directory.
  remove_staging
  return 0
}

main "$@"
`;
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const RESULT_FAILURES: readonly UpdateResultFailure[] = [
  'still_running',
  'no_app',
  'swap_failed',
  'restore_failed',
  'launch_failed',
  'helper',
];

/** Строка итога: `swapped X.Y.Z` либо `failed X.Y.Z <код>`; без перевода строки. */
export function formatResult(result: UpdateResult): string {
  if (!VERSION_RE.test(result.version)) throw new Error(`bad version: ${result.version}`);
  if (result.kind === 'updated') return `swapped ${result.version}`;
  if (!RESULT_FAILURES.includes(result.reason))
    throw new Error(`bad reason: ${String(result.reason)}`);
  return `failed ${result.version} ${result.reason}`;
}

/** Разбор файла итога (допустим один завершающий перевод строки); чужая форма — `null`. */
export function parseResult(text: string): UpdateResult | null {
  const line = text.endsWith('\n') ? text.slice(0, -1) : text;
  const m = /^(swapped) (\d+\.\d+\.\d+)$|^(failed) (\d+\.\d+\.\d+) ([a-z_]+)$/.exec(line);
  if (!m) return null;
  if (m[1]) return { kind: 'updated', version: m[2]! };
  const reason = RESULT_FAILURES.find((r) => r === m[5]);
  return reason ? { kind: 'failed', version: m[4]!, reason } : null;
}
