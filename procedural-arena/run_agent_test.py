#!/usr/bin/env python3
"""Resolve procedural_env in agent-test specs and optional generate step."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARENA = ROOT / "procedural-arena"
sys.path.insert(0, str(ARENA))

from lib.procedural_env import cleanup_commands_from_report, resolve_procedural_env  # noqa: E402


def apply_procedural_env(spec: dict) -> dict:
    if not spec.get("procedural_env"):
        return spec
    resolved = resolve_procedural_env(spec, ARENA)
    spec = dict(spec)
    spec["world"] = resolved["world"]
    spec["_procedural_fingerprint"] = resolved["fingerprint"]
    spec["_procedural_report"] = resolved.get("report")

    spawn = resolved.get("spawn_feet") or {"x": 0, "y": 65, "z": 0}
    world = resolved["world"]
    sx, sy, sz = int(spawn["x"]), int(spawn["y"]), int(spawn["z"])
    prep = list(spec.get("prep") or [])
    prep.extend(
        [
            f"mvtp Flint {world}",
            f"execute in {world} run tp Flint {sx} {sy} {sz}",
            "execute in {world} run effect give Flint minecraft:saturation 600 1".format(
                world=world
            ),
        ]
    )
    spec["prep"] = prep

    if spec.get("cleanup") == "auto" and resolved.get("report"):
        spec["cleanup"] = cleanup_commands_from_report(resolved["report"])
    return spec


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: run_agent_test.py <agent-test.yaml> [-- generate first]", file=sys.stderr)
        return 2
    spec_path = Path(sys.argv[1])
    import yaml

    spec = yaml.safe_load(spec_path.read_text()) or {}
    pe = spec.get("procedural_env") or {}
    if pe.get("seed_mode") == "variety" and "--generate" in sys.argv:
        fixture = pe.get("fixture_id", "flat_sparse_iron_plains")
        n = (pe.get("variety") or {}).get("candidates", 5)
        subprocess.check_call(
            [
                sys.executable,
                str(ARENA / "generate.py"),
                "--fixture",
                fixture,
                "--candidates",
                str(n),
                "--regenerate",
                "--random-seed",
            ]
        )
    spec = apply_procedural_env(spec)
    out = ROOT / "data" / "agent-tests" / "runs" / f"_procedural_resolved_{spec_path.stem}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"spec_keys": list(spec.keys()), "fingerprint": spec.get("_procedural_fingerprint")}, indent=2))
    agent_test = ROOT / "scripts" / "agent-test.py"
    return subprocess.call([sys.executable, str(agent_test), str(spec_path)] + sys.argv[2:])


if __name__ == "__main__":
    sys.exit(main())
