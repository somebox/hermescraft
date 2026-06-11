"""`roadplan` CLI (§6).

Subcommands:
  ingest             Append mc JSON envelope(s) to the ledger.
  solve  --start --end
                     Run the K2 solver; write state.json.
  render [--solve --start --end]
                     ASCII overlay (K2's debugging eye, §8).

Ingest loud-failure contract (§8.0.3):
  Success prints exactly one line `ingested <N> cells` and exits 0.
  ALL OTHER cases — empty stdin, error envelope, malformed/partial JSON,
  no recognized cell payload — exit non-zero with diagnostic on stderr
  and NO `ingested` line. The contract is "exit ≠0 and no ingest line ⇒
  failure"; callers must rely on both signals.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from .ledger import (
    append_samples, read_state, samples_for_solver, write_state,
)
from .preflight import cmd_preflight
from .solver import Route, render_ascii, solve
from .spec import load_spec


class IngestError(Exception):
    pass


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z")


def _xz(s):
    parts = s.split(",")
    if len(parts) != 2:
        raise argparse.ArgumentTypeError(f"expected X,Z (got {s!r})")
    return (int(parts[0]), int(parts[1]))


def _parse_input(raw):
    """Accept one JSON object, a JSON array of envelopes, or JSONL.
    Raise IngestError on garbage/partial JSON."""
    raw = raw.strip()
    if not raw:
        raise IngestError("no envelope on stdin")
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as e_first:
        envs = []
        for i, line in enumerate(raw.splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            try:
                envs.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise IngestError(
                    f"malformed JSON (line {i}: {e.msg}; "
                    f"or single-object parse: {e_first.msg})") from e
        if not envs:
            raise IngestError("no parseable JSON found")
        return envs
    return obj if isinstance(obj, list) else [obj]


def _normalize_envelope(env):
    """(src, bot, cells[]) from one mc envelope. cells are
    [x, z, y, block_tag]. Raises IngestError on malformed shapes."""
    if not isinstance(env, dict):
        raise IngestError("envelope is not a JSON object")
    if env.get("ok") is False:
        err = env.get("error") or {}
        raise IngestError(
            f"error envelope: {err.get('code', '?')}: "
            f"{err.get('message', '<no message>')}")
    if env.get("ok") is not True:
        raise IngestError("envelope missing `ok: true`")
    data = env.get("data") or {}
    bot = env.get("bot") or data.get("bot")
    if isinstance(data.get("samples"), list):
        cells = []
        for s in data["samples"]:
            x, z = s.get("x"), s.get("z")
            y = s.get("surface_y")
            if y is None:
                y = s.get("block_y")
            if x is None or z is None:
                raise IngestError(f"sample missing x/z: {s!r}")
            cells.append([x, z, y, s.get("block_name")])
        return ("corridor_sample", bot, cells)
    raise IngestError(
        "envelope has no recognized cell payload "
        "(need corridor_sample with full=true samples[])")


def cmd_ingest(args):
    raw = (Path(args.file).read_text() if args.file else sys.stdin.read())
    try:
        envs = _parse_input(raw)
    except IngestError as e:
        print(f"ingest: {e}", file=sys.stderr)
        return 2
    total = 0
    for env in envs:
        try:
            src, bot, cells = _normalize_envelope(env)
        except IngestError as e:
            print(f"ingest: {e}", file=sys.stderr)
            return 2
        total += append_samples(args.ledger, src, bot, cells)
    print(f"ingested {total} cells")
    return 0


def _make_route_for_render(state):
    routes = (state or {}).get("routes") or []
    if not routes:
        return None
    r = routes[-1]
    return Route(
        waypoints=[tuple(w) for w in r.get("waypoints", [])],
        cells=[tuple(c) for c in r.get("cells", [])],
        cost=r.get("cost", 0.0),
        est_edits=r.get("est_edits", 0),
        construction=r.get("construction", []),
        natural_path=r.get("natural_path"),
        route_class=r.get("route_class", "natural"),
    )


def cmd_solve(args):
    spec = load_spec()
    samples = samples_for_solver(args.ledger)
    if not samples:
        print("solve: no samples in ledger", file=sys.stderr)
        return 2
    incumbent = None
    state = read_state(args.ledger)
    if state and state.get("routes"):
        incumbent = [tuple(c) for c in state["routes"][-1].get("cells", [])]
    route = solve(samples, args.start, args.end, spec, incumbent=incumbent)
    if route is None:
        print("solve: no route found", file=sys.stderr)
        return 2
    state = state or {"project": args.project or "unnamed", "spec_version": 1}
    state["endpoints"] = {"start": list(args.start), "end": list(args.end)}
    state.setdefault("routes", []).append({
        "solved_at": _now(),
        "waypoints": [list(w) for w in route.waypoints],
        "cells": [list(c) for c in route.cells],
        "cost": route.cost,
        "est_edits": route.est_edits,
        "construction": route.construction,
        "natural_path": route.natural_path,
        "route_class": route.route_class,
    })
    write_state(args.ledger, state)
    natural = "none" if route.natural_path is None \
        else f"{route.natural_path:.1f}"
    print(f"solve: {route.route_class} route, cost {route.cost:.1f}, "
          f"{route.est_edits} edits, natural={natural}, "
          f"{len(route.waypoints)} waypoints")
    return 0


def cmd_render(args):
    samples = samples_for_solver(args.ledger)
    if not samples:
        print("render: no samples in ledger", file=sys.stderr)
        return 2
    route = None
    if args.solve:
        if args.start is None or args.end is None:
            print("render: --solve requires --start X,Z and --end X,Z",
                  file=sys.stderr)
            return 2
        route = solve(samples, args.start, args.end, load_spec())
        if route is None:
            print("render: no route found", file=sys.stderr)
            return 2
    else:
        route = _make_route_for_render(read_state(args.ledger))
    sys.stdout.write(render_ascii(samples, route) + "\n")
    return 0


def build_parser():
    p = argparse.ArgumentParser(prog="roadplan")
    p.add_argument("--ledger", default="data/runtime/roadplan",
                   type=Path,
                   help="Directory holding samples.jsonl and state.json")
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("ingest",
                        help="Append mc JSON envelopes from stdin (or --file)")
    pi.add_argument("--file", help="Read envelope(s) from FILE instead of stdin")
    pi.set_defaults(func=cmd_ingest)

    ps = sub.add_parser("solve", help="Run the K2 solver, write state.json")
    ps.add_argument("--start", type=_xz, required=True, help="X,Z")
    ps.add_argument("--end", type=_xz, required=True, help="X,Z")
    ps.add_argument("--project", help="Project name (first solve only)")
    ps.set_defaults(func=cmd_solve)

    pr = sub.add_parser("render", help="ASCII terrain + route overlay")
    pr.add_argument("--solve", action="store_true",
                    help="Solve fresh from samples (needs --start/--end)")
    pr.add_argument("--start", type=_xz)
    pr.add_argument("--end", type=_xz)
    pr.set_defaults(func=cmd_render)

    pf = sub.add_parser("preflight",
                        help="Toolchain readiness check (S4: bin wrapper, "
                             "Python imports, spec file, ledger writability, "
                             "worker env_passthrough)")
    pf.add_argument("--repo-root", help="Override repo root (default: auto)")
    pf.add_argument("--json", action="store_true",
                    help="Emit structured JSON instead of human lines")
    pf.set_defaults(func=cmd_preflight)

    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
