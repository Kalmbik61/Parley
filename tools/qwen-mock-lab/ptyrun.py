#!/usr/bin/env python3
"""pty driver: run a command in a 120x40 pty, type lines at fixed times, print the cleaned screen text.

usage: SEND='first prompt\\r|second turn\\r' [TAIL=2500] python3 ptyrun.py <seconds> <cmd> [args...]
SEND items are separated by '|'; the first goes in after 6 s, then one every 3 s ('\\r' = Enter).
"""
import fcntl, os, pty, re, select, signal, struct, sys, termios, time

secs = float(sys.argv[1])
args = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(args[0], args, dict(os.environ))
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
buf = b''
t = time.time()
sent = 0
sends = [x for x in os.environ.get('SEND', '').split('|') if x]
while time.time() - t < secs:
    if sends and time.time() - t > 6 + 3 * sent:
        os.write(fd, sends.pop(0).replace('\\r', '\r').encode())
        sent += 1
    r, _, _ = select.select([fd], [], [], 0.3)
    if r:
        try:
            d = os.read(fd, 65536)
        except OSError:
            break
        if not d:
            break
        buf += d
try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
txt = re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]', b' ', buf).decode('utf8', 'replace')
txt = re.sub(r'[ \t]+', ' ', txt)
txt = re.sub(r'\n\s*\n+', '\n', txt)
print(txt[-int(os.environ.get('TAIL', '2500')):])
