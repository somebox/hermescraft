#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GEN="$ROOT/procedural-arena/generate.py"
case "${1:-}" in
  -h|--help)
    exec python3 "$GEN" --help
    ;;
esac
exec python3 "$GEN" --regenerate --random-seed "$@"
