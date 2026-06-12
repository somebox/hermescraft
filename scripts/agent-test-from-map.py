#!/usr/bin/env python3
"""Build a runnable agent-test YAML from a mapcatalog map JSON + anchor template."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SPEC = ROOT / "data/agent-tests/topics/smoke/map-anchor.yaml"


def _resolve_req(req: str) -> Path:
    req_path = Path(req)
    if not req_path.is_file():
        req_path = ROOT / req
    if not req_path.is_file():
        raise SystemExit(f"requirements not found: {req}")
    return req_path


def _anchor_xyz(card: dict, name: str) -> list[int]:
    placements = card.get("placements") or {}
    if name in placements:
        raw = placements[name]
    elif name in card:
        raw = card[name]
    else:
        raise KeyError(f"map JSON missing anchor {name!r} (placements or top-level)")
    if not isinstance(raw, (list, tuple)) or len(raw) < 3:
        raise ValueError(f"anchor {name!r} must be [x,y,z], got {raw!r}")
    return [int(raw[0]), int(raw[1]), int(raw[2])]


_PLACEHOLDER_RE = re.compile(r"\{\{([A-Z0-9_]+)_(X|Y|Z)\}\}")


def _anchor_from_token_prefix(prefix: str) -> str:
    """BUILD_PAD -> build_pad, SPAWN -> spawn."""
    return prefix.lower()


def placeholders_in_template(template: str) -> list[tuple[str, str]]:
    """Return (token, axis) pairs e.g. ('BUILD_PAD', 'X') for each {{BUILD_PAD_X}}."""
    seen: set[tuple[str, str]] = set()
    out: list[tuple[str, str]] = []
    for prefix, axis in _PLACEHOLDER_RE.findall(template):
        key = (prefix, axis)
        if key not in seen:
            seen.add(key)
            out.append(key)
    return out


_STATIC_PLACEHOLDER_RE = re.compile(r"\{\{([A-Z][A-Z0-9_]*)\}\}")


def _static_placeholders() -> dict[str, str]:
    """Non-coordinate template tokens (proc-nav harness defaults)."""
    return {
        "{{BOT_USERNAME}}": os.environ.get("MC_USERNAME", "Mox"),
        "{{PROC_WORLD}}": os.environ.get("PROC_WORLD", "proc-nav"),
    }


def substitution_map(card: dict, template: str) -> dict[str, str]:
    out: dict[str, str] = dict(_static_placeholders())
    for prefix, axis in placeholders_in_template(template):
        anchor = _anchor_from_token_prefix(prefix)
        xyz = _anchor_xyz(card, anchor)
        idx = {"X": 0, "Y": 1, "Z": 2}[axis]
        out[f"{{{{{prefix}_{axis}}}}}"] = str(xyz[idx])
    return out


def render_spec(template: str, card: dict) -> str:
    text = template
    for token, value in substitution_map(card, template).items():
        text = text.replace(token, value)
    leftover = _STATIC_PLACEHOLDER_RE.findall(text)
    leftover = [f"{{{{{k}}}}}" for k in leftover]
    if leftover:
        raise ValueError(f"unresolved placeholders: {sorted(set(leftover))}")
    return text


def load_card(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("ok") is False:
        reasons = data.get("reasons") or ["unknown"]
        raise SystemExit(f"map JSON not ok: {'; '.join(reasons)}")
    return data


def run_try(*, req_path: Path, server: Path, seed: str, reuse_world: bool = False) -> dict:
    cmd = [
        sys.executable,
        "-m",
        "mapcatalog",
        "try",
        "-r",
        str(req_path),
        "-s",
        str(server),
        "--seed",
        str(seed),
        "--json-full",
    ]
    if reuse_world:
        cmd.append("--reuse-world")
    print(" ".join(cmd), file=sys.stderr)
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        print(proc.stdout or proc.stderr, file=sys.stderr)
        raise SystemExit(proc.returncode or 1)
    card = json.loads(proc.stdout)
    if not card.get("ok"):
        reasons = card.get("reasons") or ["try failed"]
        raise SystemExit(f"mapcatalog try seed={seed}: {'; '.join(reasons)}")
    return card


def materialize(card: dict, server: Path) -> None:
    meta = card.get("_scenario") or {}
    req = meta.get("requirements")
    seed = card.get("seed")
    if not req or not seed:
        raise SystemExit("map JSON missing _scenario.requirements or seed (use scenario card output)")
    run_try(
        req_path=_resolve_req(str(req)),
        server=server,
        seed=str(seed),
        reuse_world=os.environ.get("PROC_LAB_REUSE", "1") != "0",
    )


def card_from_try_seed(variant: str, seed: str, server: Path) -> dict:
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from mapcatalog.scenario_registry import load_registry, variant_by_id

    reg = load_registry()
    v = variant_by_id(reg, variant)
    if not v:
        raise SystemExit(f"unknown variant {variant!r}")
    card = run_try(req_path=v.requirements_path, server=server, seed=seed, reuse_world=False)
    card["_scenario"] = {
        "variant": v.id,
        "topic": v.topic,
        "terrain": v.terrain,
        "requirements": str(v.requirements_path),
        "catalog_path": None,
        "agent_test_ref": v.agent_test_ref,
    }
    return card


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--map", type=Path, help="Catalog map JSON (from scenario-pools.sh map)")
    ap.add_argument(
        "--try-seed",
        help="Skip catalog: mapcatalog try this seed for --variant (materializes proc-lab)",
    )
    ap.add_argument("--variant", default="smoke", help="Registry variant when picking map or --try-seed")
    ap.add_argument("--spec", type=Path, default=DEFAULT_SPEC, help="Template YAML with {{PLACEHOLDERS}}")
    ap.add_argument(
        "--materialize",
        action="store_true",
        help="Run mapcatalog try before agent-test (no-op if --try-seed already ran try)",
    )
    ap.add_argument("-s", "--server", type=Path, default=ROOT / "server.local.yaml")
    ap.add_argument("--dry-run", action="store_true", help="Print resolved YAML path only")
    ap.add_argument("agent_test_args", nargs=argparse.REMAINDER, help="Passed to scripts/agent-test.py")
    args = ap.parse_args()

    tried = False
    if args.try_seed:
        card = card_from_try_seed(args.variant, str(args.try_seed), args.server)
        tried = True
    elif args.map:
        card = load_card(args.map)
    else:
        proc = subprocess.run(
            [str(ROOT / "scripts/scenario-pools.sh"), "map", args.variant],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            print(proc.stdout or proc.stderr, file=sys.stderr)
            return proc.returncode or 1
        card = json.loads(proc.stdout)

    if args.materialize and not tried:
        materialize(card, args.server)

    template = args.spec.read_text(encoding="utf-8")
    rendered = render_spec(template, card)
    seed = card.get("seed", "unknown")
    import yaml

    spec_meta = yaml.safe_load(rendered) or {}
    test_id = spec_meta.get("agent_test_id") or args.spec.stem
    out_dir = ROOT / "data/agent-tests/runs/.generated"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{test_id}-seed-{seed}.yaml"
    out_path.write_text(rendered, encoding="utf-8")
    print(f"resolved spec: {out_path}", file=sys.stderr)
    anchors = sorted({ _anchor_from_token_prefix(p) for p, _ in placeholders_in_template(template) })
    print(f"seed={seed} anchors={anchors}", file=sys.stderr)

    if args.dry_run:
        print(out_path)
        return 0

    return subprocess.run(
        merge_agent_test_argv(out_path, list(args.agent_test_args)), cwd=ROOT
    ).returncode


def merge_agent_test_argv(spec_path: Path, extra: list[str]) -> list[str]:
    """Build agent-test.py argv with defaults; user flags after `--` override."""
    if extra and extra[0] == "--":
        extra = extra[1:]
    user = {}
    rest: list[str] = []
    i = 0
    while i < len(extra):
        tok = extra[i]
        if tok in ("--bot-url", "--model", "--max-turns") and i + 1 < len(extra):
            user[tok] = extra[i + 1]
            i += 2
            continue
        rest.append(tok)
        i += 1
    bot = user.get("--bot-url") or os.environ.get("BOT_URL", "http://localhost:3001")
    model = user.get("--model") or os.environ.get(
        "AGENT_TEST_MODEL", "deepseek/deepseek-v4-flash:exacto"
    )
    cmd = [sys.executable, str(ROOT / "scripts/agent-test.py"), str(spec_path)]
    if "--bot-url" in user:
        cmd.extend(["--bot-url", user["--bot-url"]])
    else:
        cmd.extend(["--bot-url", bot])
    if "--model" in user:
        cmd.extend(["--model", user["--model"]])
    else:
        cmd.extend(["--model", model])
    if "--max-turns" in user:
        cmd.extend(["--max-turns", user["--max-turns"]])
    cmd.extend(rest)
    return cmd




if __name__ == "__main__":
    raise SystemExit(main())
