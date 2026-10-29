"""Frozen `aipster-tray` entry (windowed: no console). All behavior is the
aipster_tray package; control/query CLI also lives in the console launcher
(`aipster-worker tray ...`) for visible terminal output."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aipster_tray.controller import main

if __name__ == "__main__":
    raise SystemExit(main())
