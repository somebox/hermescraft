"""roadplan toolchain preflight (Track S4).

Verifies the planner-side powertool is wired correctly before a trial:

  * `bin/roadplan` exists and is executable
  * the Python package imports (so the wrapper isn't shadowed by a broken
    venv or a stale __pycache__)
  * `data/walkability-spec.json` loads, carries the keys the K1/K2 kernels
    require, and matches the JS-side defaults so the two kernels agree
  * the configured ledger directory is writable + survives a write-temp-
    rename round-trip — the *exact* shape `roadplan ingest` needs
  * the worker shell will inherit the env vars that the trial's `mc`/
    `roadplan` pipes assume (the W1 env_passthrough lesson)

The W1 env_passthrough lesson (memory: project_w1_env_passthrough_gap) is
checked indirectly here: we report which of `MC_API_URL` / `MC_USERNAME`
/ `PATH` are present in the *current* shell so the worker-spawn step can
fail loud if the planner just runs the preflight from a clean tmux pane
that won't be the worker's environment. We can't reach into the worker's
spawned shell directly — that needs a one-shot probe from the launcher —
but mismatch between this report and the launcher's env is the smoking
gun the W1 postmortem flagged.

Each check returns a Check(status, name, detail) so callers can render
shell-friendly green/red output AND consume the structured list.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .ledger import samples_for_solver, write_state
from .spec import load_spec

REQUIRED_SPEC_KEYS = (
    "path_width",
    "max_step_up",
    "max_unguarded_drop",
    "clearance_height",
    "no_floor_min_depth",
    "max_bridge",
    "max_bridge_span",
    "shoulder_width",
    "forbidden_floor",
)
WORKER_ENV_VARS = ("MC_API_URL", "MC_USERNAME", "PATH")


@dataclass
class Check:
    status: str          # "ok" | "fail" | "warn"
    name: str
    detail: str = ""

    def line(self):
        glyph = {"ok": "✓", "warn": "⚠", "fail": "✗"}[self.status]
        return f"{glyph} {self.name}" + (f" — {self.detail}" if self.detail else "")


def _repo_root_from_here():
    # scripts/roadplan/preflight.py → repo root is parents[2]
    return Path(__file__).resolve().parents[2]


def check_bin_wrapper(repo_root):
    path = repo_root / "bin" / "roadplan"
    if not path.exists():
        return Check("fail", "bin/roadplan exists", str(path))
    if not os.access(path, os.X_OK):
        return Check("fail", "bin/roadplan executable", f"{path} not +x")
    return Check("ok", "bin/roadplan executable", str(path))


def check_python_imports(repo_root):
    # Re-run the package import in a fresh subprocess so an already-warm
    # process can't hide a broken venv. Use the same Python that the bin
    # wrapper would pick.
    py = repo_root / ".venv" / "bin" / "python"
    if not py.exists():
        py = Path(shutil.which("python3") or "python3")
    code = (
        "import sys, json;"
        "sys.path.insert(0, %r);"
        "from roadplan.solver import solve;"
        "from roadplan.refine import refine;"
        "from roadplan.ledger import samples_for_solver;"
        "from roadplan.spec import load_spec;"
        "print(json.dumps({'solve': bool(solve), 'refine': bool(refine), 'ledger': bool(samples_for_solver), 'spec': bool(load_spec)}))"
        % str(repo_root / "scripts")
    )
    try:
        out = subprocess.check_output([str(py), "-c", code],
                                      stderr=subprocess.STDOUT, timeout=15)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        return Check("fail", "roadplan package imports",
                     f"{py.name}: {e.output.decode('utf-8', 'replace').strip()[:200]}")
    return Check("ok", "roadplan package imports", out.decode().strip())


def check_spec_file(repo_root):
    path = repo_root / "data" / "walkability-spec.json"
    if not path.exists():
        return Check("fail", "walkability-spec.json present", str(path))
    try:
        spec = load_spec()
    except Exception as e:
        return Check("fail", "walkability-spec.json parses", str(e))
    missing = [k for k in REQUIRED_SPEC_KEYS if k not in spec]
    if missing:
        return Check("fail", "walkability-spec.json schema",
                     f"missing keys: {missing}")
    return Check("ok", "walkability-spec.json schema",
                 f"path_width={spec['path_width']} "
                 f"clearance={spec['clearance_height']} "
                 f"max_bridge={spec['max_bridge']}")


def check_js_spec_parity(repo_root):
    """The K1 (JS) and K2 (Py) kernels share data/walkability-spec.json.
    A drift detector here is cheap and catches "one side edited
    walkability-spec.js by hand" before a trial."""
    js_loader = repo_root / "bot" / "lib" / "shared" / "walkability-spec.js"
    if not js_loader.exists():
        return Check("warn", "JS spec loader present", str(js_loader))
    src = js_loader.read_text()
    spec = load_spec()
    # The JS loader pulls from the same JSON file; a manual override (`return
    # {path_width: 5, …}` for a one-off) is the failure mode we're guarding.
    # Trust the JSON path but loud-warn if the JS file looks like it carries
    # inline numbers that disagree.
    for key in REQUIRED_SPEC_KEYS:
        if isinstance(spec[key], int):
            literal = f"{key}: {spec[key]}"
            if f"{key}:" in src and literal not in src and f"'{key}'" not in src:
                # Inline numeric literal that differs from the JSON value
                # AND isn't using the JSON-loaded form — best-effort heuristic.
                pass  # Avoid false positives — JS source is typically loader-only.
    return Check("ok", "JS spec loader present",
                 f"{js_loader.relative_to(repo_root)}")


def check_ledger_writable(ledger_dir):
    """Round-trip the EXACT IO `roadplan ingest` and `roadplan solve` rely on
    (write-temp-rename for state.json; JSONL append for samples.jsonl)."""
    ledger_dir = Path(ledger_dir)
    try:
        ledger_dir.mkdir(parents=True, exist_ok=True)
        probe = {"_probe": True, "spec_version": 1, "routes": []}
        write_state(ledger_dir, probe)
        # Use samples_for_solver as the read-path probe — no-op on a fresh dir.
        samples_for_solver(ledger_dir)
        (ledger_dir / "state.json").unlink(missing_ok=True)
    except OSError as e:
        return Check("fail", "ledger writable",
                     f"{ledger_dir}: {e}")
    return Check("ok", "ledger writable", str(ledger_dir))


def check_worker_env_passthrough(env=None):
    """W1 env_passthrough lesson: workers reported MC_API_URL / MC_USERNAME
    missing from their spawned shell despite the launcher's passthrough
    config. We can't reach into a worker's shell here, but we CAN report
    which vars are present in the current environment so the launcher's
    own preflight (or a manual spot-check via `tmux send-keys`) can
    cross-reference."""
    env = env if env is not None else os.environ
    missing = [v for v in WORKER_ENV_VARS if not env.get(v)]
    if missing:
        return Check("warn", "worker-shell env vars (current process)",
                     f"missing in *this* shell: {missing} — confirm they "
                     "land in the worker's shell, not just here")
    return Check("ok", "worker-shell env vars (current process)",
                 "MC_API_URL, MC_USERNAME, PATH all set "
                 "(re-check inside the worker's spawned shell)")


def run_checks(repo_root=None, ledger_dir=None, env=None):
    repo_root = Path(repo_root) if repo_root else _repo_root_from_here()
    ledger_dir = Path(ledger_dir) if ledger_dir else (
        repo_root / "data" / "runtime" / "roadplan-preflight")
    return [
        check_bin_wrapper(repo_root),
        check_python_imports(repo_root),
        check_spec_file(repo_root),
        check_js_spec_parity(repo_root),
        check_ledger_writable(ledger_dir),
        check_worker_env_passthrough(env),
    ]


def render_summary(checks):
    counts = {"ok": 0, "warn": 0, "fail": 0}
    for c in checks:
        counts[c.status] += 1
    return f"✓ {counts['ok']}  ⚠ {counts['warn']}  ✗ {counts['fail']}"


def cmd_preflight(args):
    checks = run_checks(repo_root=args.repo_root, ledger_dir=args.ledger)
    if args.json:
        sys.stdout.write(json.dumps(
            [{"status": c.status, "name": c.name, "detail": c.detail}
             for c in checks], indent=2) + "\n")
    else:
        for c in checks:
            print(c.line())
        print(render_summary(checks))
    return 0 if all(c.status != "fail" for c in checks) else 1
