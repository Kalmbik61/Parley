#!/bin/sh
# Host keys are made at the first start and kept in the container; delete them and restart to «change the server key».
ssh-keygen -A >/dev/null
if command -v nginx >/dev/null 2>&1; then nginx; fi
# STAND_LISTEN=443 occupies that port with a foreign listener (the «busy 443» case).
if [ -n "$STAND_LISTEN" ]; then (nc -lk "$STAND_LISTEN" >/dev/null 2>&1 &); fi
if [ "$STAND_DIND" = "1" ]; then /stand-dockerd.sh & fi
exec /usr/sbin/sshd -D -e
