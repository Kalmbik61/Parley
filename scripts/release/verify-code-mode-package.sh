#!/bin/bash
# Code Mode in a packaged arm64 app (plan T9b-packaging, H3; proposal .parley/review/T9b-packaging-proposal.md with Delta 1):
# what the release check (verify-packaged-apps.sh) cannot do without a real run. Local only: it builds nothing, publishes
# nothing and installs nothing into /Applications. The app comes from `pnpm --filter @parley/desktop dist --dir --arm64`
# in a clean checkout at the hash under test; the checks read it and run it in place, then from copies.
#
# Usage: bash scripts/release/verify-code-mode-package.sh <path to Parley.app>
#
# Steps, each one fails the script:
#   static   exactly three @parley/core copies (host, remote, app.asar) with their hashes; the host probe's bytes, arch and
#            signature; mac.signIgnore matches every real probe path; codesign --deep --strict; no import route from
#            out/main or remote/dist/main.js to the helper, broker or guest (static and literal dynamic imports).
#   pin      the embedded node is the version fetch-node pins.
#   run      under the embedded node, from the host copy: mcpConfigJson's command and entry; the launch proof; a real
#            sandboxed helper run of `return 1`; server.js classic, replacement, a nested read through the T8h preload
#            broker, stdin close; then codesign again and the bundle's tree hash unchanged.
#   paths    the same run from copies of the app at "<scratch>/Parley Test" and "<scratch>/Парли Тест", and from a read-only disk
#            image when hdiutil can make one.
#   negative a byte changed in the host probe, the probe re-signed, and a bundle path the sandbox profile cannot carry: the
#            launch proof refuses and the helper does not spawn. A route to the helper added to the bridge (literal import(), a
#            createRequire loader, an aliased one) fails the walk, and so does a loader called with a variable.
#   window   the app starts with a temporary PARLEY_HOME, its main process loads from app.asar and starts the host there.
set -euo pipefail

app="${1:?usage: verify-code-mode-package.sh <Parley.app>}"
app="$(cd "$app" && pwd -P)"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
checks="$root/scripts/release/verify-code-mode-package.mjs"
yml="$root/packages/desktop/electron-builder.yml"
node_version="$(FETCH_NODE="$root/packages/desktop/scripts/fetch-node.mjs" node --input-type=module -e 'const { NODE_VERSION } = await import(process.env.FETCH_NODE); console.log(NODE_VERSION)')"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/parley-t9b-package.XXXXXX")"
extra_dirs=()
mounted=""

cleanup() {
  [ -z "$mounted" ] || hdiutil detach -quiet "$mounted" >/dev/null 2>&1 || true
  for d in "${extra_dirs[@]+"${extra_dirs[@]}"}"; do rm -rf "$d"; done
  rm -rf "$scratch"
}
trap cleanup EXIT

fail() {
  echo "::error::$*"
  exit 1
}

embedded() { echo "$1/Contents/Resources/node/bin/node"; }
mjs() { "$(embedded "$2")" "$checks" "$@"; }

# Static checks on one bundle; the host probe is the only copy whose bytes and signature must match its manifest.
static_checks() {
  local a="$1" core probe manifest
  [ "$(uname -m)" = arm64 ] || fail "this script runs the arm64 app on an arm64 machine"
  node "$checks" copies "$a"
  core="$(find "$a/Contents/Resources/host/node_modules/.pnpm" -maxdepth 4 -type d -path '*/node_modules/@parley/core' | head -n 1)"
  [ -n "$core" ] || fail "$a: no @parley/core in the host"
  probe="$core/native/darwin-arm64/procinfo-probe"
  manifest="$core/native/darwin-arm64/manifest.json"
  [ "$(lipo -archs "$probe")" = arm64 ] || fail "$a: the host probe is not arm64"
  [ "$(shasum -a 256 "$probe" | cut -d ' ' -f 1)" = "$(node -p 'require(process.argv[1]).binarySha256' "$manifest")" ] ||
    fail "$a: the host probe bytes differ from its manifest"
  codesign -v "$probe" || fail "$a: the host probe signature is not valid"
  node "$checks" sign-ignore "$a" "$yml"
  codesign --verify --deep --strict "$a" || fail "$a: codesign --deep --strict failed"
  node "$checks" walk "$a"
  echo "static: ok"
}

# Real runs from the host copy under the embedded node, then the bundle is unchanged.
run_checks() {
  local a="$1" label="$2" before after
  [ "$("$(embedded "$a")" --version)" = "v$node_version" ] || fail "$label: the embedded node is not v$node_version"
  before="$(node "$checks" tree "$a")"
  mjs config "$a"
  mjs proof "$a" ok
  mjs helper "$a" ok
  mjs server "$a"
  codesign --verify --deep --strict "$a" || fail "$label: codesign failed after the runs"
  after="$(node "$checks" tree "$a")"
  [ "$before" = "$after" ] || fail "$label: the bundle changed during the runs ($before -> $after)"
  echo "$label: run ok, bundle unchanged $after"
}

copy_app() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  extra_dirs+=("$dir")
  ditto "$app" "$dir/Parley.app"
}

host_probe() {
  find "$1/Contents/Resources/host/node_modules/.pnpm" -maxdepth 4 -type d -path '*/node_modules/@parley/core' | head -n 1 |
    sed 's|$|/native/darwin-arm64/procinfo-probe|'
}

negative() {
  local label="$1" dir="$2" a
  a="$dir/Parley.app"
  mjs proof "$a" refused
  mjs helper "$a" refused
  echo "negative $label: refused"
}

window_start() {
  local home pid log up="" alive=0 host_pid="" host_cmd=""
  home="$(mktemp -d "${TMPDIR:-/tmp}/parley-t9b-home.XXXXXX")"
  log="$scratch/window.log"
  env -u HARNAS_HOME PARLEY_HOME="$home" "$app/Contents/MacOS/Parley" >"$log" 2>&1 &
  pid=$!
  # The host writes its pid file after its socket; both while the window is up.
  for _ in $(seq 1 120); do
    kill -0 "$pid" 2>/dev/null || break
    if [ -S "$home/host/host.sock" ]; then up=1; fi
    host_pid="$(head -n 1 "$home/host/host.pid" 2>/dev/null || true)"
    [ -n "$up" ] && [ -n "$host_pid" ] && break
    sleep 0.5
  done
  [ -z "$host_pid" ] || host_cmd="$(ps -o command= -p "$host_pid" || true)"
  kill -0 "$pid" 2>/dev/null && alive=1
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  case "$host_cmd" in
    *"$app/Contents/Resources/host/"*) kill "$host_pid" 2>/dev/null || true ;;
  esac
  rm -rf "$home"
  [ -n "$up" ] && [ "$alive" = 1 ] || fail "window: the app did not stay up and start its host with a temporary home (log: $(tail -c 600 "$log"))"
  case "$host_cmd" in
    "$app/Contents/Resources/node/bin/node "*"$app/Contents/Resources/host/"*) ;;
    *) fail "window: the host is not the packaged one under the embedded node: '$host_cmd' (pid '$host_pid')" ;;
  esac
  if grep -E "Cannot find module|ERR_MODULE_NOT_FOUND|ERR_REQUIRE|Uncaught" "$log"; then fail "window: a load error in the main process"; fi
  echo "window: main process up from app.asar; host: $host_cmd"
}

echo "app: $app"
echo "version: $(plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist")"
static_checks "$app"
run_checks "$app" "in place"

for dir in "$scratch/Parley Test" "$scratch/Парли Тест"; do
  copy_app "$dir"
  run_checks "$dir/Parley.app" "$dir"
done

if hdiutil create -quiet -srcfolder "$app" -volname "Parley T9b" -format UDRO "$scratch/parley.dmg" &&
  mounted="$(mktemp -d "${TMPDIR:-/tmp}/parley-t9b-mount.XXXXXX")" &&
  hdiutil attach -quiet -readonly -nobrowse -mountpoint "$mounted" "$scratch/parley.dmg"; then
  run_checks "$mounted/Parley.app" "read-only image"
  hdiutil detach -quiet "$mounted"
  mounted=""
else
  echo "::warning::read-only image: hdiutil could not make or mount one, not run"
fi

dir="$scratch/negative-byte"
copy_app "$dir"
probe="$(host_probe "$dir/Parley.app")"
chmod u+w "$probe"
node -e 'const fs = require("node:fs"); const f = process.argv[1]; const b = fs.readFileSync(f); b[4096] ^= 0xff; fs.writeFileSync(f, b);' "$probe"
negative "probe byte changed" "$dir"

dir="$scratch/negative-resign"
copy_app "$dir"
probe="$(host_probe "$dir/Parley.app")"
chmod u+w "$probe"
codesign -f -s - -i dev.parley.procinfo-probe.other "$probe" 2>/dev/null
negative "probe re-signed" "$dir"

dir="$scratch/negative \"quote"
copy_app "$dir"
negative "profile path with a quote" "$dir"

# The walk's own controls: a route to the helper added to the bridge's entry must fail it, whether by a literal import(), by a loader bound to
# createRequire (as bundlers name it, require$1), or by one made from an aliased createRequire; a loader called with a variable fails it too.
walk_control() {
  local label="$1" code="$2" expect="$3" dir
  dir="$scratch/negative-walk-$label"
  copy_app "$dir"
  printf '\n%s\n' "$code" >>"$dir/Parley.app/Contents/Resources/remote/dist/main.js"
  if node "$checks" walk "$dir/Parley.app" >/dev/null 2>"$scratch/walk-$label.err"; then fail "negative walk $label: not found"; fi
  grep -q "$expect" "$scratch/walk-$label.err" || fail "negative walk $label: $(cat "$scratch/walk-$label.err")"
  rm -rf "$dir"
  echo "negative walk $label: found"
}
walk_control import "await import('../node_modules/@parley/core/dist/mcp/code-mode/helper.js');" "remote: reaches .*mcp/code-mode/helper.js"
walk_control create-require "const require\$9 = createRequire(import.meta.url); require\$9('../node_modules/@parley/core/dist/mcp/code-mode/helper.js');" "remote: reaches .*mcp/code-mode/helper.js"
walk_control aliased "import { createRequire as mk9 } from 'node:module'; const load9 = mk9(import.meta.url); load9('../node_modules/@parley/core/dist/mcp/code-mode/broker.js');" "remote: reaches .*mcp/code-mode/broker.js"
walk_control variable "const require\$8 = createRequire(import.meta.url); require\$8(process.env.X);" "not a literal .*require\\\$8(process.env.X)"

window_start
echo "verify-code-mode-package: all checks passed"
