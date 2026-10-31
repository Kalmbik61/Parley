#!/bin/sh
# Stand only. A real server starts dockerd inside the package postinst (systemd) before apt returns; this container
# has no systemd, so `stand-dockerd.sh` starts it in the background. This shim makes every docker command wait for it
# (version queries excepted), which is the same thing as far as the wizard can tell.
[ -x /usr/bin/docker ] || { echo "docker: command not found" >&2; exit 127; }
case "$1" in --version|-v) exec /usr/bin/docker "$@" ;; esac
if [ "$1" = "compose" ] && [ "$2" = "version" ]; then exec /usr/bin/docker "$@"; fi
i=0
while [ ! -e /run/stand-ready ] && [ "$i" -lt 600 ]; do sleep 0.5; i=$((i + 1)); done
exec /usr/bin/docker "$@"
