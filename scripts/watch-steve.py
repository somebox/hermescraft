#!/usr/bin/env python3
"""Backward-compatible alias: watch Steve's session (see watch-agent.py)."""
import runpy
import sys
from pathlib import Path

if __name__ == "__main__":
    argv = sys.argv[1:]
    if "--agent" not in argv and "--home" not in argv:
        argv = ["--agent", "steve", *argv]
    sys.argv = [sys.argv[0], *argv]
    runpy.run_path(str(Path(__file__).resolve().parent / "watch-agent.py"), run_name="__main__")
