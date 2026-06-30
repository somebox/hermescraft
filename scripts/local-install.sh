#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Install local HermesCraft dependencies (idempotent). Covers everything except
# the Paper server (server/local-setup.sh) and sqlite3 (needs root):
#
#   bot node deps (+ mineflayer patches)   → bot/node_modules
#   python venv + test/world-gen deps      → .venv
#   cubiomes seed scanner                  → tools/cubiome_scan/proc_biome_scan
#   hermes-agent CLI (one-off, legacy)     → ~/.local/bin/hermes
#   OpenRouter key bridge                  → secrets.yaml + ~/.hermes/.env
#
# Usage: scripts/local-install.sh [--check]
# ═══════════════════════════════════════════════════════════════
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
CHECK_ONLY=false; [ "${1:-}" = "--check" ] && CHECK_ONLY=true

ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*"; }
err()  { printf '  ✗ %s\n' "$*"; }

echo "── toolchain ──"
miss=0
need() { command -v "$1" >/dev/null 2>&1 && ok "$1 ($($1 --version 2>&1 | head -1))" || { err "$1 missing — $2"; miss=1; }; }
need java "install OpenJDK 21 (JRE) for Paper"
need node "install Node.js 18+ (22 recommended)"
need uv   "install uv (https://docs.astral.sh/uv/) — or adapt to pip/venv"
need gcc  "apt install build-essential (for cubiomes)"
need make "apt install build-essential"
need git  "apt install git"
if command -v sqlite3 >/dev/null 2>&1; then ok "sqlite3"; else
  warn "sqlite3 missing — needed by bot-lease registry + genesis-v2."
  warn "  Install (needs root):  sudo apt-get install -y sqlite3"
fi
[ "$miss" = 1 ] && { echo; err "fix missing toolchain above, then re-run"; exit 1; }
$CHECK_ONLY && { echo; ok "check complete"; exit 0; }

echo "── bot node deps (applies mineflayer patches) ──"
( cd bot && npm install --no-audit --no-fund >/dev/null 2>&1 ) && ok "bot/node_modules + patch-package"

echo "── python venv + deps ──"
[ -d .venv ] || uv venv .venv >/dev/null 2>&1
uv pip install --python .venv -r requirements-dev.txt >/dev/null 2>&1 && ok ".venv: pytest, pyyaml, mcrcon"

echo "── cubiomes seed scanner ──"
if [ -x tools/cubiome_scan/proc_biome_scan ]; then ok "proc_biome_scan present"; else
  [ -d tools/cubiome_scan/cubiomes ] || git clone --depth 1 https://github.com/Cubitect/cubiomes.git tools/cubiome_scan/cubiomes >/dev/null 2>&1
  make -C tools/cubiome_scan >/dev/null 2>&1 && ok "built proc_biome_scan"
fi

echo "── hermes (one-off, legacy; see migration note in local-dev-setup.md) ──"
if command -v hermes >/dev/null 2>&1; then ok "hermes ($(hermes --version 2>&1 | head -1))"; else
  uv tool install hermes-agent >/dev/null 2>&1 && ok "installed hermes-agent → ~/.local/bin/hermes"
fi

echo "── OpenRouter key bridge ──"
.venv/bin/python - <<'PY' || warn "no OpenRouter key found in secrets.yaml — context-test grading + hermes need one"
import pathlib, re, os
s = pathlib.Path("secrets.yaml")
if not s.exists():
    raise SystemExit("no secrets.yaml")
m = re.search(r'(?:OPENROUTER_API_KEY|openrouter_api_key)\s*[:=]\s*(\S+)', s.read_text())
if not m or not m.group(1).startswith("sk-or-"):
    raise SystemExit("no openrouter key")
key = m.group(1).strip().strip('"\'')
s.write_text(f"openrouter_api_key: {key}\n"); os.chmod(s, 0o600)            # YAML form for context-tuner/benchmark
h = pathlib.Path.home()/".hermes"; h.mkdir(parents=True, exist_ok=True)
env = h/".env"
lines = [l for l in (env.read_text().splitlines() if env.exists() else []) if not l.startswith("OPENROUTER_API_KEY=")]
lines.append(f"OPENROUTER_API_KEY={key}"); env.write_text("\n".join(lines)+"\n"); os.chmod(env, 0o600)  # env form for hermes/bot
print(f"  ✓ key bridged → secrets.yaml + {env}")
PY

mkdir -p scripts/context-tests/runs   # context-tuner doctor: runs/ writable

echo
ok "dependencies installed."
echo "    Next:  server/local-setup.sh    (download Paper + Multiverse, create worlds)"
echo "    Then:  scripts/local-up.sh       (server + Tester bot)"
echo "    Docs:  docs/guides/local-dev-setup.md"
