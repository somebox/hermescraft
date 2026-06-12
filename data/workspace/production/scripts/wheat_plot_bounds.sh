#!/usr/bin/env bash
# wheat_plot_bounds.sh — read wheat plot bounds from mc marks, emit JSON.
#
# Output: {"plot":{"x":<int>,"y":<int>,"z":<int>},"corners":[[<x1>,<z1>],[<x2>,<z2>]]}
#
# The wheat plot is a 9x9 area centered on the wheat_plot mark.
# Corners are the NW and SE extents (±4 blocks from center in x and z).

REPO_ROOT="${HERMESCRAFT_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"

CX=""
CY=""
CZ=""

# Strategy 1: mc inspect --mark wheat_plot (structured JSON output)
if command -v mc >/dev/null 2>&1; then
  INSPECT_OUTPUT=$(mc inspect --mark wheat_plot 2>/dev/null || true)
  if [ "${INSPECT_OUTPUT#{}" != "$INSPECT_OUTPUT" ] || [ "${INSPECT_OUTPUT#[}" != "$INSPECT_OUTPUT" ]; then
    COORDS_JSON=$(echo "$INSPECT_OUTPUT" | grep -oE '"coords"[[:space:]]*:[[:space:]]*\[[^]]+\]' | head -1)
    if [ -n "$COORDS_JSON" ]; then
      CX=$(echo "$COORDS_JSON" | grep -oE '[-]?[0-9]+' | sed -n '1p')
      CY=$(echo "$COORDS_JSON" | grep -oE '[-]?[0-9]+' | sed -n '2p')
      CZ=$(echo "$COORDS_JSON" | grep -oE '[-]?[0-9]+' | sed -n '3p')
    fi
  fi
fi

# Strategy 2: mc marks output (text-based)
if [ -z "$CX" ] || [ -z "$CY" ] || [ -z "$CZ" ]; then
  if command -v mc >/dev/null 2>&1; then
    MARKS_OUTPUT=$(mc marks 2>/dev/null || true)
    if [ -n "$MARKS_OUTPUT" ]; then
      MARK_LINE=$(echo "$MARKS_OUTPUT" | grep -i "wheat_plot" | head -1)
      if [ -n "$MARK_LINE" ]; then
        COORDS=$(echo "$MARK_LINE" | grep -oE '[-]?[0-9]+' | head -3)
        read -r CX CY CZ <<-EOF
$COORDS
EOF
      fi
    fi
  fi
fi

# Strategy 3: canonical.yaml fallback
if [ -z "$CX" ] || [ -z "$CY" ] || [ -z "$CZ" ]; then
  MARKS_FILE="$REPO_ROOT/data/marks/canonical.yaml"
  if [ -f "$MARKS_FILE" ]; then
    COORD_LINE=$(awk '
      /^wheat_plot:/ { found=1; next }
      found && /^[[:space:]]+coords:[[:space:]]*[[]/ {
        gsub(/.*[[]/, ""); gsub(/[]].*/, "");
        split($0, a, /[[:space:]]*,[[:space:]]*/);
        print a[1], a[2], a[3];
        exit;
      }
      found && /^[^[:space:]]/ { found=0 }
    ' "$MARKS_FILE")
    read -r CX CY CZ <<-EOF
$COORD_LINE
EOF
  fi
fi

# If we still don't have coords, error out
if [ -z "$CX" ] || [ -z "$CY" ] || [ -z "$CZ" ]; then
  echo "ERROR: could not locate wheat_plot mark via mc marks or canonical.yaml" >&2
  exit 1
fi

# The wheat plot is 9x9, so corners are ±4 blocks from center
X1=$((CX - 4))
Z1=$((CZ - 4))
X2=$((CX + 4))
Z2=$((CZ + 4))

# Emit JSON
printf '{"plot":{"x":%s,"y":%s,"z":%s},"corners":[[%s,%s],[%s,%s]]}\n' "$CX" "$CY" "$CZ" "$X1" "$Z1" "$X2" "$Z2"