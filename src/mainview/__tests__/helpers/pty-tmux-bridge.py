#!/usr/bin/env python3
"""PTY bridge for e2e testing of the terminal input pipeline.

Allocates a PTY pair via pty.fork(), runs the given command with the
PTY slave as its controlling terminal, then forwards bytes received on
stdin to the PTY master fd.  Output from the PTY master is forwarded
to stderr (for debugging only — it is not part of the test protocol).

The test writes raw escape sequences to this process's stdin; they
travel: test stdin -> PTY master -> tmux input parser -> inner pane.

Usage:
    pty-tmux-bridge.py -- <command> [args...]

Everything after '--' is the command to run inside the PTY (typically
a 'tmux new-session' invocation).
"""

import sys
import os
import pty
import select
import signal


def main() -> None:
    if "--" not in sys.argv:
        print(f"Usage: {sys.argv[0]} -- <command> [args...]", file=sys.stderr)
        sys.exit(1)

    sep = sys.argv.index("--")
    cmd = sys.argv[sep + 1:]
    if not cmd:
        print("Error: no command after --", file=sys.stderr)
        sys.exit(1)

    # pty.fork() forks and gives the child a controlling terminal (the PTY
    # slave).  The parent receives the master fd.
    pid, master_fd = pty.fork()

    if pid == 0:
        # Child: exec the command; PTY slave is already stdin/stdout/stderr
        # and is the controlling terminal.
        os.execvp(cmd[0], cmd)
        sys.exit(1)  # unreachable

    # Parent: multiplex  stdin -> master_fd  and  master_fd -> stderr
    stdin_fd = sys.stdin.fileno()

    try:
        while True:
            try:
                rlist, _, _ = select.select([stdin_fd, master_fd], [], [], 1.0)
            except (ValueError, OSError):
                break

            if not rlist:
                # Periodic timeout: check whether child has already exited.
                try:
                    wpid, _ = os.waitpid(pid, os.WNOHANG)
                    if wpid != 0:
                        break
                except OSError:
                    break
                continue

            if stdin_fd in rlist:
                try:
                    data = os.read(stdin_fd, 4096)
                except OSError:
                    data = b""
                if not data:
                    break  # stdin closed — caller is done
                try:
                    os.write(master_fd, data)
                except OSError:
                    break

            if master_fd in rlist:
                try:
                    data = os.read(master_fd, 4096)
                    try:
                        os.write(2, data)  # stderr (debug only)
                    except OSError:
                        pass
                except OSError:
                    break  # master closed (child exited)

    except (KeyboardInterrupt, BrokenPipeError):
        pass
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass


if __name__ == "__main__":
    main()
