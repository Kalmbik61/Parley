#!/usr/bin/env python3
"""Runs a command in a pty, types the lines in SEND (separated by '|', '\\r' = Enter) after a pause, prints the screen text.
Usage: SEND='sk-ant-FAKE\\r' python3 ptyrun.py <seconds> cmd args..."""
import os, pty, select, sys, time

secs = float(sys.argv[1]); cmd = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
out = b''; t0 = time.time(); sent = False
lines = [l.encode().decode('unicode_escape').encode() for l in os.environ.get('SEND', '').split('|') if l]
while time.time() - t0 < secs:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        out += d
    if lines and time.time() - t0 > 3 and (not sent or time.time() - t0 > 3 + 1.5 * sent):
        os.write(fd, lines.pop(0)); sent = (sent or 0) + 1
try: os.kill(pid, 15)
except OSError: pass
sys.stdout.write(out.decode(errors='replace'))
