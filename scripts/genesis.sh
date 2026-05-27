#!/usr/bin/env bash
# genesis.sh — repeatable fresh-world genesis (Core v1)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PY="${GENESIS_PYTHON:-python3}"
LIB="$SCRIPT_DIR/genesis_lib.py"

usage() {
  cat <<EOF
usage: $(basename "$0") <command> [options]

commands:
  new-run       --seed <int> [--anchor X,Y,Z] [--difficulty {peaceful|easy|normal|hard}] [--no-confirm]
  seed-cards    [--run-id <id>]
  render-templates --seed <int> --anchor X,Y,Z [--run-id <id>]
  check-phases  [--json] [--run-id <id>]
  snapshot      [--label <name>] [--run-id <id>]
  list
  current
  diff          <run_id_a> <run_id_b>
  note          <text>
  archive-rescue <path>

environment:
  MC_HOST_SSH, MC_DOCKER_NAME, GENESIS_COMPOSE_FILE, GENESIS_WORLD_DATA
  GENESIS_DRY_RUN=1  skip destructive ssh/rcon (local dev)

negative seeds: use --seed=-8675309 (equals form). Plain \"--seed -8675309\" also works in bash.
EOF
}

# True if argument looks like an integer seed (including negative).
_is_seed_token() {
  [[ "$1" =~ ^-?[0-9]+$ ]]
}

# Consume --seed or --seed=N from $@; prints value to stdout. Caller shifts as needed.
_parse_seed_option() {
  case "$1" in
    --seed=*)
      echo "${1#--seed=}"
      return 0
      ;;
    --seed)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --seed requires a value (use --seed=-8675309 for negative seeds)" >&2
        return 1
      fi
      case "$2" in
        --anchor|--difficulty|--no-confirm|--run-id|--json|--label)
          echo "ERROR: missing --seed value (use --seed=-8675309 for negative seeds)" >&2
          return 1
          ;;
      esac
      echo "$2"
      return 0
      ;;
  esac
  return 1
}

run_py() {
  "$PY" - "$@" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import genesis_lib as gl
# remainder dispatched by genesis.sh via GENESIS_CMD env
PY
}

cmd="${1:-}"
shift || true

case "$cmd" in
  new-run)
    SEED=""
    ANCHOR=""
    DIFF=""
    NO_CONFIRM=""
    KEEP_WORLD=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --seed|--seed=*)
          v=$(_parse_seed_option "$@") || exit 1
          SEED="$v"
          case "$1" in
            --seed=*) shift ;;
            --seed) shift 2 ;;
          esac
          ;;
        --anchor) ANCHOR="$2"; shift 2 ;;
        --difficulty) DIFF="$2"; shift 2 ;;
        --no-confirm) NO_CONFIRM=1; shift ;;
        --keep-world) KEEP_WORLD=1; shift ;;
        *)
          if [[ -z "$SEED" ]] && _is_seed_token "$1"; then
            SEED="$1"
            shift
          else
            echo "unknown flag: $1" >&2
            exit 1
          fi
          ;;
      esac
    done
    # When --keep-world is set, the seed is unused at runtime (no world regen).
    # We still require a seed for the run config so cross-run benchmarks
    # remain comparable; reuse the prior run's seed if not supplied.
    if [[ -z "$SEED" && -n "$KEEP_WORLD" ]]; then
      # Delegate to last_completed_run_id_before() — Python helper that
      # iterates from newest backward, skipping dirs without config.json,
      # and filters to dated run-ids only (g-YYYY-MM-DD-N).
      PREV=$("$PY" -c "
import sys; sys.path.insert(0, '$SCRIPT_DIR')
import genesis_lib as gl
prev = gl.last_completed_run_id_before('zzz')  # sentinel: lex-max
print(prev or '')
" 2>/dev/null)
      if [[ -n "$PREV" ]]; then
        SEED=$("$PY" -c "import json; print(json.load(open('$REPO_ROOT/data/genesis-runs/$PREV/config.json'))['seed'])")
        echo "[genesis] --keep-world: reusing prior seed $SEED from $PREV"
      fi
    fi
    [[ -n "$SEED" ]] || { echo "--seed <int> required (negative: --seed=-8675309). Or use --keep-world after a prior run." >&2; exit 1; }
    export GENESIS_SEED="$SEED"
    export GENESIS_KEEP_WORLD="${KEEP_WORLD:-}"
    exec "$PY" -c "
import os
import sys
sys.path.insert(0, '$SCRIPT_DIR')
import genesis_lib as gl

seed = int(os.environ['GENESIS_SEED'])
anchor_s = '$ANCHOR'
diff = '$DIFF' or None
if diff:
    diff = gl.validate_difficulty(diff)

gl.finalize_previous_run()
run_id = gl.next_run_id()
if not '$NO_CONFIRM':
    print(f'DESTRUCTIVE: new genesis run {run_id} seed={seed}')
    r = input('Type run id to confirm: ').strip()
    if r != run_id:
        print('aborted')
        sys.exit(1)

gl.acquire_run_lock(run_id)
try:
    gl.validate_templates()
    with gl.log_step(run_id, 'landfolk_stop'):
        gl.landfolk_stop()
    with gl.log_step(run_id, 'archive'):
        gl.ensure_run_layout(run_id)
        gl.archive_run_state(run_id)
    keep_world = bool(os.environ.get('GENESIS_KEEP_WORLD'))
    if keep_world:
        with gl.log_step(run_id, 'reset_world_skipped'):
            pass
    else:
        with gl.log_step(run_id, 'reset_world'):
            gl.reset_world(seed)
    with gl.log_step(run_id, 'reinit_kanban'):
        gl.reinit_kanban_board()
    if anchor_s:
        anchor = gl.parse_anchor(anchor_s)
        with gl.log_step(run_id, 'probe_skip'):
            pass
    elif keep_world:
        # Reuse the prior run's anchor — the world is unchanged so re-probing
        # would return the same coords anyway, and reusing is deterministic
        # for benchmarking.
        with gl.log_step(run_id, 'reuse_prior_anchor'):
            prior = gl.last_completed_run_id_before(run_id)
            if not prior:
                raise RuntimeError('keep-world flag set but no prior run with config.json was found')
            prior_cfg = gl.load_config(prior)
            anchor = prior_cfg['base_anchor']
            print('[genesis] reusing anchor', anchor, 'from', prior)
    else:
        with gl.log_step(run_id, 'probe'):
            anchor = gl.probe_base_anchor()
    with gl.log_step(run_id, 'render'):
        cfg = gl.render_templates(run_id=run_id, seed=seed, anchor=anchor, difficulty=diff)
    # Pin worldspawn to the genesis anchor — runs every new-run, including
    # --keep-world (which skips the probe). Without this, dead/respawning
    # bots can drift to whatever spawn the world had pre-genesis.
    with gl.log_step(run_id, 'apply_worldspawn'):
        gl.apply_worldspawn(anchor)
    # Lay the cobblestone pad first so the chests + future shelter sit on
    # a clean, solid floor instead of grass/dirt. The pad is the genesis
    # foundation; everything Phase 1 builds rests on it.
    with gl.log_step(run_id, 'seed_base_pad'):
        gl.seed_base_pad(cfg)
    # Place the chest blocks on top of the pad (rcon-only, idempotent).
    with gl.log_step(run_id, 'system_chest_place'):
        gl.seed_system_chest_place(cfg)
    ctx = gl.build_context(run_id=run_id, seed=seed, anchor=anchor, started_at=cfg['started_at'])
    with gl.log_step(run_id, 'seed_cards'):
        gl.seed_starter_cards(run_id, ctx)
    pin = diff or 'peaceful'
    with gl.log_step(run_id, 'difficulty_initial'):
        if not cfg.get('difficulty'):
            gl.rcon(f'difficulty {pin}', quiet=True)
    # Start bots BEFORE filling the chest — fill uses Steward as the service
    # bot to TP + /give + mc deposit, so Steward must be online.
    with gl.log_step(run_id, 'landfolk_start'):
        gl.landfolk_start()
    with gl.log_step(run_id, 'system_chest_fill'):
        gl.seed_system_chest_fill(cfg)
    # Snapshot AFTER fill so the start snapshot reflects the populated chest
    # state, not the empty placeholder.
    with gl.log_step(run_id, 'snapshot_start'):
        gl.capture_snapshot('start', run_id)
    with gl.log_step(run_id, 'poller'):
        gl.start_phase_poller(run_id)
    print(f'genesis run {run_id} started at anchor {anchor}')
finally:
    gl.release_run_lock()
"
    ;;
  seed-cards)
    RUN_ID=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --run-id) RUN_ID="$2"; shift 2 ;;
        *) exit 1 ;;
      esac
    done
    exec "$PY" -c "
import sys
sys.path.insert(0, '$SCRIPT_DIR')
import genesis_lib as gl
rid = '$RUN_ID' or gl.active_run_id()
cfg = gl.load_config(rid)
ctx = gl.build_context(run_id=rid, seed=cfg['seed'], anchor=cfg['base_anchor'], started_at=cfg['started_at'])
print(gl.seed_starter_cards(rid, ctx))
"
    ;;
  render-templates)
    SEED=""; ANCHOR=""; RUN_ID=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --seed|--seed=*)
          v=$(_parse_seed_option "$@") || exit 1
          SEED="$v"
          case "$1" in
            --seed=*) shift ;;
            --seed) shift 2 ;;
          esac
          ;;
        --anchor) ANCHOR="$2"; shift 2 ;;
        --run-id) RUN_ID="$2"; shift 2 ;;
        *)
          if [[ -z "$SEED" ]] && _is_seed_token "$1"; then
            SEED="$1"
            shift
          else
            echo "unknown flag: $1" >&2
            exit 1
          fi
          ;;
      esac
    done
    export GENESIS_SEED="$SEED"
    exec "$PY" -c "
import os
import sys
sys.path.insert(0, '$SCRIPT_DIR')
import genesis_lib as gl
rid = '$RUN_ID' or gl.next_run_id()
cfg = gl.render_templates(run_id=rid, seed=int(os.environ['GENESIS_SEED']), anchor=gl.parse_anchor('$ANCHOR'), difficulty=None)
import json
print(json.dumps(cfg, indent=2))
"
    ;;
  check-phases)
    JSON=""
    RUN_ID=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --json) JSON=1; shift ;;
        --run-id) RUN_ID="$2"; shift 2 ;;
        *) exit 1 ;;
      esac
    done
    exec "$PY" -c "
import sys, json
sys.path.insert(0, '$SCRIPT_DIR')
import genesis_lib as gl
cfg = gl.load_config('$RUN_ID' or None)
r = gl.check_phases(cfg)
print(json.dumps(r, indent=2) if '$JSON' else '\n'.join(f\"{k}: {'PASS' if v['pass'] else 'FAIL'} {v.get('failures')}\" for k,v in r.items()))
"
    ;;
  snapshot)
    LABEL="manual"
    RUN_ID=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --label) LABEL="$2"; shift 2 ;;
        --run-id) RUN_ID="$2"; shift 2 ;;
        *) exit 1 ;;
      esac
    done
    exec "$PY" -c "
import sys
sys.path.insert(0, '$SCRIPT_DIR')
import genesis_lib as gl
gl.validate_label('$LABEL')
p = gl.capture_snapshot('$LABEL', '$RUN_ID' or None)
print(p)
"
    ;;
  list)
    exec "$PY" -c "
import sys
from pathlib import Path
sys.path.insert(0, '$SCRIPT_DIR')
import genesis_lib as gl
for p in sorted(gl.runs_root().iterdir()):
    if p.is_dir() and p.name.startswith('g-'):
        cfg = p / 'config.json'
        started = cfg.exists() and __import__('json').loads(cfg.read_text()).get('started_at','?')
        print(f'{p.name}\t{started}')
"
    ;;
  current)
    exec "$PY" -c "
import sys
sys.path.insert(0, '$SCRIPT_DIR')
import genesis_lib as gl
rid = gl.active_run_id()
print(rid or 'no active run')
if rid:
    cfg = gl.load_config(rid)
    print('seed', cfg.get('seed'), 'anchor', cfg.get('base_anchor'))
"
    ;;
  diff)
    A="${1:-}"; B="${2:-}"
    [[ -n "$A" && -n "$B" ]] || { echo "usage: genesis.sh diff <run_a> <run_b>" >&2; exit 1; }
    exec "$PY" "$SCRIPT_DIR/genesis-diff.py" "$A" "$B"
    ;;
  note)
    TEXT="${*:-}"
    exec "$PY" -c "
import sys
sys.path.insert(0, '$SCRIPT_DIR')
import genesis_lib as gl
gl.append_note('''$TEXT''')
"
    ;;
  archive-rescue)
    SRC="${1:-}"
    [[ -n "$SRC" ]] || exit 1
    exec "$PY" -c "
import sys
from pathlib import Path
sys.path.insert(0, '$SCRIPT_DIR')
import genesis_lib as gl
print(gl.archive_rescue(Path('$SRC')))
"
    ;;
  ""|-h|--help|help) usage ;;
  *) usage; exit 1 ;;
esac
