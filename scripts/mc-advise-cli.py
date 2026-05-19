#!/usr/bin/env python3
"""Entry point for `mc advise` (invoked from bot/cli/index.mjs)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests._lib.perception_advise import run_advise  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="HermesCraft mc advise backend")
    ap.add_argument("--reason", required=True, help="Sub-goal or locate question for the digest")
    ap.add_argument("--api-url", default="", help="Bot HTTP base (default MC_API_URL or config)")
    ap.add_argument("--dry-run", action="store_true", help="Fetch bundle only, no LLM")
    ap.add_argument("--include-bundle", action="store_true", help="Include raw perception_input in JSON")
    ap.add_argument("--model", default="", help="Override DIGEST_MODEL / default")
    ap.add_argument("--kind", default="advise", help="Caller tag for logging (advise|scene|status|map|find|nearby)")
    args = ap.parse_args()

    env = run_advise(
        args.reason,
        api_url=args.api_url or None,
        dry_run=args.dry_run,
        model=args.model or None,
        include_bundle_in_response=args.include_bundle,
        kind=args.kind or "advise",
    )
    print(json.dumps(env, ensure_ascii=False))
    return 0 if env.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
