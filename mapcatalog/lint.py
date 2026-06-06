from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

from mapcatalog.gates import gate_label
from mapcatalog.load import load_requirements
from mapcatalog.models import Arena, FindSpec, Requirements
from mapcatalog.sampling import estimate_pass2_materializations, summarize_sampling


@dataclass
class LintReport:
    requirements: Requirements
    errors: list[str]
    warnings: list[str]

    @property
    def ok(self) -> bool:
        return not self.errors


def lint_requirements(path: Path) -> LintReport:
    errors: list[str] = []
    warnings: list[str] = []
    try:
        req = load_requirements(path)
    except Exception as e:
        return LintReport(
            requirements=Requirements(
                id=path.stem,
                path=str(path),
                arena=Arena((0, 0), 64),
                gates=[],
                placements=[],
                find=FindSpec(),
            ),
            errors=[str(e)],
            warnings=[],
        )

    if not req.gates:
        warnings.append("no gates declared — every seed would pass")

    names = {p.name for p in req.placements}
    if "spawn" not in names:
        errors.append("placements must include spawn")
    if "muster" not in names:
        warnings.append("muster not defined — consumers may expect it")

    has_flat = any(g.__class__.__name__ == "FlatPatchGate" for g in req.gates)
    for p in req.placements:
        if p.method == "flat_patch_center" and not has_flat:
            errors.append("flat_patch_center requires a flat patch gate")

    server_default = Path("./server.local.yaml")
    server_path = Path(req.server_path) if req.server_path else server_default
    if not server_path.is_file():
        warnings.append(f"server config missing ({server_path}) — try/find need -s")

    cubiomes = Path("tools/cubiome_scan/proc_biome_scan")
    if not cubiomes.is_file():
        warnings.append(
            "cubiomes binary missing (tools/cubiome_scan/proc_biome_scan) — Pass 1 will be slow or skipped"
        )

    return LintReport(requirements=req, errors=errors, warnings=warnings)


def print_lint_report(report: LintReport, out: TextIO | None = None) -> None:
    import sys

    stream = out or sys.stdout
    req = report.requirements
    stream.write(f"requirements: {req.id}\n")
    stream.write(f"  path: {req.path}\n")
    stream.write(f"  arena: center={req.arena.center} radius={req.arena.radius}\n")
    stream.write(f"  find: {req.find.solutions} solutions, max {req.find.max_seeds} seeds\n")
    stream.write(
        "  find CLI: --solutions overrides catalog goal; --max-seeds caps tries "
        "(whichever limit hits first). Progress on stderr; see .find_state.json in -o dir.\n"
    )
    stream.write(f"  gates: {len(req.gates)}\n")
    for label, pass_num, cells in summarize_sampling(req.gates, req.arena):
        stream.write(f"    pass{pass_num}  {label}  (~{cells} sampled cells)\n")
    stream.write("  placements (resolve order):\n")
    for p in req.placements:
        stream.write(f"    - {p.name}: {p.method}\n")
    est = estimate_pass2_materializations(req.find.max_seeds)
    stream.write(f"  estimate: up to ~{est} Pass 2 materializations (assuming ~5% Pass 1 yield)\n")
    stream.write("  note: run `find` to record lint_actual pass1_yield / pass2_yield on your server\n")
    p1 = (req.source_lines or {}).get("pass1") or {}
    if p1.get("verify_live"):
        stream.write(f"  pass1.verify_live: enabled ({p1.get('verify_live_when', 'always')})\n")
    elif p1.get("verify_live_when") == "off":
        stream.write("  pass1.verify_live: disabled (verify_live_when: off)\n")
    else:
        stream.write(
            "  pass1.verify_live: defaults on when server cubiomes.binary exists (override in job pass1:)\n"
        )
    for w in report.warnings:
        stream.write(f"  warning: {w}\n")
    for e in report.errors:
        stream.write(f"  error: {e}\n")
    if report.ok:
        stream.write("lint: ok\n")
    else:
        stream.write("lint: failed\n")
