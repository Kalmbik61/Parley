#!/bin/sh
# Stand only: the containers have no systemd. The wizard asks `systemctl is-active <units>` to learn whether a web server
# on the host is a service; here a unit is «active» when a process of that name runs. Nothing else is supported.
case "$1" in
  is-active)
    shift
    rc=0
    for unit in "$@"; do
      if pgrep -x "$unit" >/dev/null 2>&1; then echo active; else echo inactive; rc=3; fi
    done
    exit "$rc"
    ;;
  *) echo "systemctl (stand): unsupported: $*" >&2; exit 1 ;;
esac
