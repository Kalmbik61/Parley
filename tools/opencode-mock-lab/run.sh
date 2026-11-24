#!/bin/zsh
# Starts mock model + `opencode serve` (throwaway HOME/XDG) and optionally the TUI with --server.
# Usage: OPENCODE=<path to opencode> run.sh <work-dir> [serve|tui]    (serve is default; tui needs a terminal)
# EXTRA_CONFIG='{...}' is merged (top level) into the injected OPENCODE_CONFIG_CONTENT.
# Prints the server URL; the password is PW=lab-secret. Stop with: kill $(cat <work-dir>/*.pid)
set -e
OC=${OPENCODE:?set OPENCODE to the opencode binary}
LAB=${0:A:h}
W=$1; MODE=${2:-serve}; PW=${PW:-lab-secret}
mkdir -p $W
source ${0:A:h}/env.sh
if [ ! -f $W/mock.pid ]; then node $LAB/mock.mjs $W/mock.log > $W/mock.out 2>&1 & echo $! > $W/mock.pid; sleep 1; fi
MOCK_PORT=$(cat $W/mock.log.port)
export OPENCODE_CONFIG_CONTENT=$(node -e '
const [lab,port,w]=process.argv.slice(1);
const base={provider:{mock:{name:"Mock",npm:"@ai-sdk/openai-compatible",options:{baseURL:`http://127.0.0.1:${port}/v1`,apiKey:"x"},models:{"mock-1":{name:"Mock 1",reasoning:true}}}},
 model:"mock/mock-1",mcp:{parley:{type:"local",command:[process.execPath,`${lab}/mcp.mjs`],environment:{MCP_LOG:`${w}/mcp.log`}}}};
console.log(JSON.stringify({...base,...JSON.parse(process.env.EXTRA_CONFIG||"{}")}))' $LAB $MOCK_PORT $W)
cd $W/proj
if [ "$MODE" = serve ]; then
  $OC serve --hostname 127.0.0.1 --port ${PORT:-0} > $W/serve.out 2>&1 & echo $! > $W/serve.pid
  sleep 3; cat $W/serve.out
else
  exec $OC --server http://127.0.0.1:${PORT:?set PORT of the running serve} "${@:3}"
fi
