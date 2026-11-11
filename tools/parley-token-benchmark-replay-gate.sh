#!/bin/sh
# T9a gate: build core and protocol (in that order) from THIS checkout, stop if either build fails, then run the replay explicitly and check that it judged goals.
#   PARLEY_REPLAY_GOALS=<the frozen goals file> PARLEY_REPLAY_SCRIPTS=tools/read-workflow-scripts.json sh tools/parley-token-benchmark-replay-gate.sh [report.json]
# The preflight in the run refuses a missing or foreign goals file by name; nothing here skips, excludes or retries a test.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
OUT="${1:-${TMPDIR:-/tmp}/parley-replay-report.json}"
STAMP="${TMPDIR:-/tmp}/parley-replay-build.$$.json"

# core first: @parley/protocol imports @parley/core (a project reference), so on a checkout without dist the protocol build needs core's declarations
pnpm --filter @parley/core build; CORE=$?
pnpm --filter @parley/protocol build; PROTOCOL=$?
RUN="$$-$(date +%s)"
printf '{"protocol":%s,"core":%s,"run":"%s"}\n' "$PROTOCOL" "$CORE" "$RUN" > "$STAMP"
if [ "$PROTOCOL" -ne 0 ] || [ "$CORE" -ne 0 ]; then
  echo "gate: a build failed (protocol $PROTOCOL, core $CORE); the replay does not run" >&2
  exit 1
fi

# the node:test file the vitest project excludes by name runs under its own runner; a failure stops the gate
node --test tools/bench/window-sync/observer.test.mjs || { echo "gate: observer.test.mjs failed under node --test" >&2; exit 1; }

# a report left by an earlier run must never be read as this one
rm -f "$OUT"
PARLEY_REPLAY_BUILD="$STAMP" PARLEY_REPLAY_REPORT="$OUT" pnpm exec vitest run --config tools/vitest.replay-run.config.ts --no-file-parallelism --maxWorkers=1 --minWorkers=1 --retry=0 || exit 1

node -e '
const fs = require("node:fs");
const crypto = require("node:crypto");
const [out, goalsPath, stampPath] = process.argv.slice(1);
const fail = (why) => { console.error("gate: " + why); process.exit(1); };
let r;
try { r = JSON.parse(fs.readFileSync(out, "utf8")); } catch { fail("there is no report at " + out + " (or it is not JSON)"); }
const goalsText = fs.readFileSync(goalsPath, "utf8");
const expected = JSON.parse(goalsText).goals.length;
if (r.goals !== expected) fail("the report judged " + r.goals + " goals, the frozen file has " + expected);
if (!(r.verdicts > 0)) fail("the report has no verdicts");
if (!(r.skips && r.skips.classic === 0 && r.skips.replacement === 0)) fail("the report counts skips: " + JSON.stringify(r.skips));
if (r.goalsSha !== crypto.createHash("sha256").update(goalsText).digest("hex")) fail("the report was made for another goals file (sha " + r.goalsSha + ")");
if (r.buildStamp !== fs.readFileSync(stampPath, "utf8")) fail("the report does not carry this run build stamp: it is not from this run");
if (r.passed !== true) fail("the report says passed=" + r.passed);
console.log("gate: " + r.goals + " goals, " + r.verdicts + " verdicts, passed");
' "$OUT" "$PARLEY_REPLAY_GOALS" "$STAMP"
