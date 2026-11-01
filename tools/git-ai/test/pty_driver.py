"""Test-only PTY driver: give git-ai and its fake editor a real terminal."""
import errno
import os
import pty
import subprocess
import sys

master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
try:
    while True:
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not data:
            break
        sys.stdout.buffer.write(data)
finally:
    os.close(master)
sys.exit(child.wait())
