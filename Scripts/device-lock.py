#!/usr/bin/env python3
"""Runs a command while holding the shared test-iPhone lock.

Several agents and scripts drive the same phone; `devicectl ... --terminate-existing` from one
kills the other's test page. Wrap every on-device launch:

    Scripts/device-lock.py xcrun devicectl device process launch ...

Scripts/regression.py takes the same lock for its whole device stage.
"""
from __future__ import annotations

import fcntl
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

LOCK = Path("/tmp/holoweb-test-device.lock")


@contextmanager
def device_lock(wait_note: bool = True):
    with LOCK.open("w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if wait_note:
                print("[device-lock] phone busy, waiting…", file=sys.stderr, flush=True)
            start = time.monotonic()
            fcntl.flock(handle, fcntl.LOCK_EX)
            if wait_note:
                print(f"[device-lock] acquired after {time.monotonic() - start:.0f}s", file=sys.stderr, flush=True)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    with device_lock():
        sys.exit(subprocess.call(sys.argv[1:]))
