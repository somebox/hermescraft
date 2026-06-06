from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from mapcatalog.lint import lint_requirements
from mapcatalog.scenario_registry import load_registry, resolve_find_limits, variant_by_id


def cmd_list(args: argparse.Namespace) -> int:
    reg = load_registry(Path(args.registry) if args.registry else None)
    cur_topic = ""
    for v in reg.variants:
        if v.topic != cur_topic:
            cur_topic = v.topic
            print(f"[{cur_topic}]")
        tags = f"  tags={','.join(v.tags)}" if v.tags else ""
        leg = f"  legacy={v.legacy_id}" if v.legacy_id else ""
        print(f"  {v.id}{tags}{leg}")
        print(f"    req={v.requirements_path.name}  catalog={v.catalog_dir}")
    return 0


def cmd_lint(args: argparse.Namespace) -> int:
    reg = load_registry(Path(args.registry) if args.registry else None)
    failed = 0
    for v in reg.variants:
        if args.only and v.id not in args.only and v.topic not in args.only:
            if not v.legacy_id or v.legacy_id not in args.only:
                continue
        report = lint_requirements(v.requirements_path)
        status = "ok" if report.ok else "FAIL"
        print(f"{status} {v.id}")
        if not report.ok:
            failed += 1
            for e in report.errors:
                print(f"  error: {e}")
    return 1 if failed else 0


def cmd_refresh(args: argparse.Namespace) -> int:
    from mapcatalog.find_run import find_from_paths

    reg = load_registry(Path(args.registry) if args.registry else None)
    server = Path(args.server) if args.server else reg.defaults_server
    if not server.is_file():
        print(f"server config missing: {server}", file=sys.stderr)
        return 1

    any_fail = 0
    for v in reg.variants:
        if args.only and v.id not in args.only and v.topic not in args.only:
            if not v.legacy_id or v.legacy_id not in args.only:
                continue
        if args.smoke_only and "smoke" not in v.tags:
            continue
        sol, mx = resolve_find_limits(v, reg)
        if args.dry_run:
            print(f"would find {v.id} solutions={sol} max_seeds={mx} -> {v.catalog_dir}")
            continue
        print(f"find {v.id} (solutions={sol} max_seeds={mx}) …", file=sys.stderr)
        report = find_from_paths(
            v.requirements_path,
            server,
            v.catalog_dir,
            max_seeds=mx if args.max_seeds is None else args.max_seeds,
            solutions=sol if args.solutions is None else args.solutions,
            quiet=args.quiet,
            json_lines=False,
        )
        payload = {
            "variant": v.id,
            "topic": v.topic,
            "terrain": v.terrain,
            "setting": v.setting,
            "ok": report.ok,
            "accepts": report.stats.accepts,
            "seeds_tried": report.stats.seeds_tried,
            "lint_actual": report.lint_actual,
            "catalog_files": report.paths,
        }
        if args.json:
            print(json.dumps(payload))
        else:
            print(
                f"  {v.id}: ok={report.ok} accepts={report.stats.accepts} "
                f"tried={report.stats.seeds_tried} -> {v.catalog_dir}"
            )
        if not report.ok and not args.allow_partial:
            any_fail += 1
    return any_fail


def cmd_card(args: argparse.Namespace) -> int:
    """Print one catalog card JSON for agent-test wiring (random or --seed)."""
    import random

    reg = load_registry(Path(args.registry) if args.registry else None)
    v = variant_by_id(reg, args.variant)
    if not v:
        print(json.dumps({"ok": False, "reasons": [f"unknown variant {args.variant!r}"]}))
        return 1
    cat = v.catalog_dir
    if args.seed:
        path = cat / f"{v.id}__{args.seed}.json"
        if not path.is_file():
            path = next(cat.glob(f"*__{args.seed}.json"), None)
        if not path or not path.is_file():
            print(json.dumps({"ok": False, "reasons": [f"no card for seed {args.seed}"]}))
            return 1
    else:
        files = sorted(cat.glob("*.json"))
        files = [f for f in files if f.name != ".find_state.json"]
        if not files:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "reasons": [f"empty catalog {cat}; run scenario refresh"],
                    }
                )
            )
            return 1
        path = random.choice(files)
    meta = {
        "variant": v.id,
        "topic": v.topic,
        "terrain": v.terrain,
        "setting": v.setting,
        "requirements": str(v.requirements_path),
        "catalog_path": str(path),
        "agent_test_ref": v.agent_test_ref,
    }
    if args.meta_only:
        print(json.dumps(meta, indent=2))
        return 0
    card = json.loads(path.read_text(encoding="utf-8"))
    card["_scenario"] = meta
    print(json.dumps(card, indent=2))
    return 0


def build_scenario_parser(sub: argparse._SubParsersAction) -> None:
    sp = sub.add_parser("scenario", help="Scenario registry lint / pool refresh / pick card")
    sp.add_argument("--registry", help="Path to registry.yaml (default data/scenarios/registry.yaml)")
    sub2 = sp.add_subparsers(dest="scenario_cmd", required=True)

    list_p = sub2.add_parser("list", help="List registered variants")
    list_p.set_defaults(func=cmd_list)

    lint_p = sub2.add_parser("lint", help="Lint all registered requirements")
    lint_p.add_argument("--only", nargs="+", help="Variant id or setting name filter")
    lint_p.set_defaults(func=cmd_lint)

    ref_p = sub2.add_parser("refresh", help="Run mapcatalog find for registry variants (live server)")
    ref_p.add_argument("-s", "--server", help="server.local.yaml path")
    ref_p.add_argument("--only", nargs="+", help="Variant id or setting (resource, homestead, worksite)")
    ref_p.add_argument("--smoke-only", action="store_true", help="Only variants tagged smoke")
    ref_p.add_argument("--dry-run", action="store_true")
    ref_p.add_argument("--allow-partial", action="store_true", help="Exit 0 even if a pool misses target accepts")
    ref_p.add_argument("--solutions", type=int)
    ref_p.add_argument("--max-seeds", type=int)
    ref_p.add_argument("--quiet", action="store_true")
    ref_p.add_argument("--json", action="store_true")
    ref_p.set_defaults(func=cmd_refresh)

    card_p = sub2.add_parser("card", help="Emit one catalog map JSON (seed + placements)")
    card_p.add_argument("variant", help="Topic.terrain id, smoke, or legacy_variant_id")
    card_p.add_argument("--seed")
    card_p.add_argument("--meta-only", action="store_true", help="Paths only, no card body")
    card_p.set_defaults(func=cmd_card)
