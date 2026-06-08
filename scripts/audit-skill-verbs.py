#!/usr/bin/env python3
"""Cross-check agent-bundle verb tables against bot/cli/registry.mjs.

Parses ``skills/agent-*.md`` for backtick ``mc <verb>`` tokens in §3 verb
tables and reports verbs not registered in the CLI. Exit 0 when clean; 1 when
any bundle names an unknown verb.

Usage:
  python scripts/audit-skill-verbs.py
  python scripts/audit-skill-verbs.py --bundles navigator,crafter,miner
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SKILLS_DIR = REPO_ROOT / "skills"
REGISTRY = REPO_ROOT / "bot" / "cli" / "registry.mjs"

# Aliases map to a registered primary name (registry g() first arg).
KNOWN_ALIASES = {
    "list_container": "chest",
    "cs": "chest_search",
    "find_in_chests": "chest_search",
    "pl": "place",
    "sm": "smelt",
    "p": "pickup",
    "near": "goto_near",
}


def load_registry_verbs() -> set[str]:
    text = REGISTRY.read_text(encoding="utf-8")
    # g('verb', ...) and g("verb", ...)
    found = set(re.findall(r"""g\(\s*['"]([a-z][a-z0-9_]*)['"]""", text))
    found.update(KNOWN_ALIASES.keys())
    return found


def verbs_in_bundle(path: Path) -> list[tuple[str, int]]:
    """Return (verb, line_no) for mc verbs in the file's §3 table area."""
    lines = path.read_text(encoding="utf-8").splitlines()
    hits: list[tuple[str, int]] = []
    in_section = False
    for i, line in enumerate(lines, start=1):
        if line.startswith("## 3."):
            in_section = True
            continue
        if in_section and line.startswith("## ") and not line.startswith("## 3."):
            break
        if not in_section:
            continue
        for m in re.finditer(r"`mc ([a-z][a-z0-9_]*)", line):
            hits.append((m.group(1), i))
    return hits


def resolve(verb: str, registered: set[str]) -> str | None:
    if verb in registered:
        return None
    if verb in KNOWN_ALIASES and KNOWN_ALIASES[verb] in registered:
        return None
    return verb


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bundles",
        default="navigator,builder,crafter,miner,farmer",
        help="Comma-separated agent-* bundle stems (default: all five)",
    )
    args = parser.parse_args()
    stems = [s.strip() for s in args.bundles.split(",") if s.strip()]
    registered = load_registry_verbs()
    fail = False

    for stem in stems:
        path = SKILLS_DIR / f"agent-{stem}.md"
        if not path.is_file():
            print(f"MISSING bundle file: {path}", file=sys.stderr)
            fail = True
            continue
        unknown: dict[str, list[int]] = {}
        for verb, line_no in verbs_in_bundle(path):
            bad = resolve(verb, registered)
            if bad:
                unknown.setdefault(bad, []).append(line_no)
        if unknown:
            fail = True
            print(f"\n{path.name}:")
            for verb, lines in sorted(unknown.items()):
                print(f"  mc {verb}  (lines {', '.join(map(str, lines))})")
        else:
            print(f"OK  {path.name}")

    if fail:
        print("\nFix verb tables or registry; see `mc help <verb>`.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
