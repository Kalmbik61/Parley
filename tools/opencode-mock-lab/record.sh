#!/bin/zsh
# Reproduces tools/opencode-mock-lab/recorded/ from a real opencode run against the mock model.
# Usage: OPENCODE=<opencode 2.2.7 binary> record.sh <empty work dir>
# Everything runs with a throwaway HOME/XDG and no keys; the only credential is a FAKE key typed into a pty.
set -e
LAB=${0:A:h}; W=${1:?work dir}; PW=lab-secret; OC=${OPENCODE:?set OPENCODE}
OUT=$LAB/recorded; RAW=$W/raw; mkdir -p $RAW $OUT
EXTRA_CONFIG='{"permissions":[{"action":"*","resource":"*","effect":"ask"},{"action":"parley_*","resource":"*","effect":"allow"}]}' $LAB/run.sh $W serve
PORT=$(sed 's/.*:\([0-9]*\)$/\1/' $W/serve.out)
node $LAB/record.mjs $W $PORT $RAW
# serve survives the death of the process that started it: start a second one under a parent that is killed with -9
source $LAB/env.sh
(cd $W/proj
 zsh -c "$OC serve --hostname 127.0.0.1 --port 0 > $RAW/serve-orphan.out 2>&1 & echo \$! > $RAW/serve-orphan.pid; sleep 600" & echo $! > $RAW/parent.pid)
sleep 3; OP=$(cat $RAW/serve-orphan.pid); PP=$(cat $RAW/parent.pid)
kill -9 $PP; sleep 2
{ echo "parent $PP alive after kill -9: $(kill -0 $PP 2>/dev/null && echo yes || echo no)"
  echo "serve $OP alive: $(kill -0 $OP 2>/dev/null && echo yes || echo no)"
  curl -s -u opencode:$PW http://127.0.0.1:$(sed 's/.*:\([0-9]*\)$/\1/' $RAW/serve-orphan.out)/api/info | head -c 120; echo; } > $RAW/orphan.txt
kill $OP 2>/dev/null || true
# stop the recording server, then the CLI items without a server (--standalone = private in-process server)
kill $(cat $W/serve.pid) $(cat $W/mock.pid); sleep 1
unset OPENCODE_SERVER_PASSWORD OPENCODE_PASSWORD OPENCODE_CONFIG_CONTENT
cd $W/proj
oc() { $OC "$@"; }
{ oc auth list --format json --standalone; } > $RAW/auth-list-signedout.json 2>&1
{ oc models --standalone; } > $RAW/models.txt 2>&1
{ oc models --verbose --standalone; } > $RAW/models-verbose.txt 2>&1 || true
{ oc session list --standalone; } > $RAW/session-list.txt 2>&1 || true
{ oc session export ses_labfull0001 --standalone; } > $RAW/session-export.json 2>&1 || true
{ oc debug config --standalone; } > $RAW/debug-config.txt 2>&1 || true
{ OPENCODE_CONFIG_CONTENT='{"mcp":{"parley":{"type":"local","command":["node","x.mjs"]}}}' oc debug config --standalone; } > $RAW/debug-config-injected.txt 2>&1 || true
mkdir -p $W/home/cfg/opencode; print -r -- '{"mcp":{"parley":{"type":"local","command":["node","user.mjs"]}}}' > $W/home/cfg/opencode/opencode.json
{ oc debug config --standalone; } > $RAW/debug-config-userfile.txt 2>&1 || true
rm $W/home/cfg/opencode/opencode.json
{ ANTHROPIC_API_KEY=sk-ant-FAKE-LABKEY-123456 oc auth list --format json --standalone; } > $RAW/auth-list-env.json 2>&1
SEND='sk-ant-FAKE-LABKEY-123456\r' python3 $LAB/ptyrun.py 15 $OC auth login anthropic --method key --standalone > $RAW/auth-login.txt 2>&1 || true
{ oc auth list --format json --standalone; } > $RAW/auth-list-stored.json 2>&1
{ oc models --standalone; } > $RAW/models-with-auth.txt 2>&1
node $LAB/sanitize.mjs $RAW $OUT $W
