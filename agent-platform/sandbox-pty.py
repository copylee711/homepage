"""Interactive PTY helper, run INSIDE the disposable terminal container.

stdin carries framed control messages from the broker; stdout carries the raw
bytes of the pseudo-terminal. The shell therefore sees a real tty: line editing,
job control, colours and full-screen programs all work.

Frame format (stdin): 1 byte kind, 4 bytes big-endian length, then the payload.
  i  write the payload to the terminal (keystrokes, paste)
  r  resize: payload is "cols,rows"
Anything the program writes goes to stdout unchanged.
"""
import errno
import fcntl
import os
import pty
import select
import struct
import sys
import termios


def env():
    base = os.environ.copy()
    for key in ('IRIS_PTY_PROGRAM',):
        base.pop(key, None)
    project = base.get('IRIS_PROJECT') or 'default'
    paths = [f'/workspace/{project}/.venv/bin', f'/workspace/{project}/.tools/bin',
             f'/workspace/{project}/node_modules/.bin', '/workspace/.tools/bin',
             '/workspace/.tools/node_modules/.bin', '/usr/local/bin', '/usr/bin', '/bin']
    base.update({
        'PATH': ':'.join(paths),
        'HOME': '/tmp',
        'SHELL': '/bin/bash',
        'TERM': base.get('TERM') or 'xterm-256color',
        'LANG': 'C.UTF-8',
        'TMPDIR': '/tmp',
        'COREPACK_HOME': f'/workspace/{project}/.cache/corepack',
        'PNPM_HOME': f'/workspace/{project}/.tools/bin',
        'npm_config_prefix': f'/workspace/{project}/.tools',
        'npm_config_cache': f'/workspace/{project}/.cache/npm',
        'PIP_CACHE_DIR': f'/workspace/{project}/.cache/pip',
        'PIP_DISABLE_PIP_VERSION_CHECK': '1',
        'npm_config_update_notifier': 'false',
    })
    return base


def main():
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvpe('/bin/bash', ['/bin/bash'], env())
        finally:
            os._exit(127)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
    stdin_fd = sys.stdin.fileno()
    out = sys.stdout.buffer
    pending = b''
    while True:
        try:
            ready, _, _ = select.select([fd, stdin_fd], [], [])
        except OSError as error:
            if error.errno == errno.EINTR:
                continue
            break
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b''
            if not data:
                break
            try:
                out.write(data)
                out.flush()
            except (BrokenPipeError, OSError):
                break
        if stdin_fd in ready:
            chunk = os.read(stdin_fd, 65536)
            if not chunk:  # broker gone; do not leave an orphan shell
                break
            pending += chunk
            while len(pending) >= 5:
                kind = pending[0:1]
                length = struct.unpack('>I', pending[1:5])[0]
                if len(pending) < 5 + length:
                    break
                payload = pending[5:5 + length]
                pending = pending[5 + length:]
                try:
                    if kind == b'i':
                        os.write(fd, payload)
                    elif kind == b'r':
                        cols, rows = (int(part) for part in payload.decode().split(','))
                        cols, rows = max(20, min(cols, 500)), max(5, min(rows, 300))
                        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                except (OSError, ValueError):
                    pass
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass


if __name__ == '__main__':
    main()
