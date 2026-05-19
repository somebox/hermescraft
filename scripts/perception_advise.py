#!/usr/bin/env python3
"""Hermes / plugin entry: same pipeline as `mc advise` (import or subprocess).

Example:
    from scripts.perception_advise import perception_advise
    env = perception_advise("find oak wood", api_url="http://localhost:3001")
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests._lib.perception_advise import run_advise  # noqa: E402


def perception_advise(reason: str, **kwargs):
    """Run advise; returns mc-style envelope with perception_answer_v1 in data."""
    return run_advise(reason, **kwargs)


if __name__ == "__main__":
    import argparse
    import json

    ap = argparse.ArgumentParser()
    ap.add_argument("reason", nargs="?", default="")
    ap.add_argument("--reason", dest="reason_flag", default="")
    ap.add_argument("--api-url", default="")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    reason = (args.reason_flag or args.reason or "").strip()
    env = perception_advise(
        reason,
        api_url=args.api_url or None,
        dry_run=args.dry_run,
    )
    print(json.dumps(env, ensure_ascii=False))
    raise SystemExit(0 if env.get("ok") else 1)
