#!/bin/sh
# Stand only: waits for the wizard's apt install to finish, then starts dockerd and loads the images from /stand.
while ! { [ -x /usr/bin/dockerd ] && dpkg -s docker-ce docker-compose-plugin containerd.io 2>/dev/null | grep -c '^Status: install ok installed' | grep -q '^3$'; }; do sleep 0.3; done
dockerd >/var/log/dockerd.log 2>&1 &
until /usr/bin/docker info >/dev/null 2>&1; do sleep 0.5; done
for tarball in /stand/*.tar; do /usr/bin/docker load -i "$tarball" >/dev/null; done
touch /run/stand-ready
