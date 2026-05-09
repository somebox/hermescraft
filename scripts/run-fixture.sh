#!/usr/bin/env bash
# run-fixture.sh — apply a Phase-2 capability-test world fixture
#
# Usage:
#   scripts/run-fixture.sh prep <fixture.yaml>
#   scripts/run-fixture.sh cleanup <fixture.yaml>
#   scripts/run-fixture.sh both <fixture.yaml>     # prep then cleanup (smoke test only)
#
# Reads a YAML fixture file with:
#   world: <multiverse-world-name>
#   prep:    [list of /mc commands to run via rcon]
#   cleanup: [list of /mc commands to run via rcon]
#
# Sends each command through ssh -> docker exec -> rcon-cli.
# Stops on first failure (set -e).

set -euo pipefail

MODE="${1:-}"
FIXTURE="${2:-}"

if [ -z "$MODE" ] || [ -z "$FIXTURE" ]; then
    cat >&2 <<EOF
usage: $(basename "$0") <prep|cleanup|both> <fixture.yaml>

Phase-2 fixture runner. Reads a YAML fixture and runs its prep/cleanup
rcon commands against the Minecraft server.

Examples:
  $(basename "$0") prep    data/test-fixtures/L0/L0.1_health_connected.yaml
  $(basename "$0") cleanup data/test-fixtures/L0/L0.1_health_connected.yaml
  $(basename "$0") both    data/test-fixtures/L0/L0.1_health_connected.yaml

Environment:
  MC_HOST_SSH       SSH alias for the Minecraft host (default: ubuntu-host)
  MC_DOCKER_NAME    Docker container name on host (default: minecraft)
  RCON_QUIET        If set, suppress per-command output
EOF
    exit 1
fi

case "$MODE" in
    prep|cleanup|both) ;;
    *) echo "ERROR: mode must be prep|cleanup|both" >&2; exit 1 ;;
esac

if [ ! -f "$FIXTURE" ]; then
    echo "ERROR: fixture file not found: $FIXTURE" >&2
    exit 1
fi

MC_HOST_SSH="${MC_HOST_SSH:-ubuntu-host}"
MC_DOCKER_NAME="${MC_DOCKER_NAME:-minecraft}"
QUIET="${RCON_QUIET:-}"

# Use python3 to extract the YAML lists as one-command-per-line.
# Avoids requiring yq/yaml CLI tools on the runner host.
extract_section() {
    local section="$1"
    python3 - "$FIXTURE" "$section" <<'PYEOF'
import sys, re
path, section = sys.argv[1], sys.argv[2]
with open(path) as f:
    lines = f.read().splitlines()

# Naive YAML list parser: find the "section:" key, then read sibling list items.
# Lists must be in the form `- "command"` or `- command`. No nested lists.
in_section = False
section_indent = None
out = []
for line in lines:
    if not in_section:
        m = re.match(r'^(\s*)' + re.escape(section) + r'\s*:\s*$', line)
        if m:
            in_section = True
            section_indent = len(m.group(1))
            continue
    else:
        stripped = line.lstrip()
        if not stripped or stripped.startswith('#'):
            continue
        cur_indent = len(line) - len(stripped)
        if cur_indent <= section_indent and not stripped.startswith('-'):
            break  # left the section
        if stripped.startswith('-'):
            cmd = stripped[1:].strip()
            # If the value is wrapped in quotes, take only what's inside the
            # quotes — discards inline `# comment` trailers correctly.
            # Otherwise (unquoted scalar), strip an inline `# comment` if any
            # whitespace precedes the hash.
            if cmd.startswith('"'):
                end = cmd.find('"', 1)
                if end > 0:
                    cmd = cmd[1:end]
            elif cmd.startswith("'"):
                end = cmd.find("'", 1)
                if end > 0:
                    cmd = cmd[1:end]
            else:
                # naive inline-comment strip on unquoted scalar
                m2 = re.search(r'\s+#', cmd)
                if m2:
                    cmd = cmd[:m2.start()].rstrip()
            out.append(cmd)

for c in out:
    print(c)
PYEOF
}

run_rcon_lines() {
    local section="$1"
    local cmds
    cmds=$(extract_section "$section")
    if [ -z "$cmds" ]; then
        [ -z "$QUIET" ] && echo "[$section] (no commands)"
        return 0
    fi
    [ -z "$QUIET" ] && echo "=== $section ==="
    while IFS= read -r cmd; do
        [ -z "$cmd" ] && continue
        local result
        # `local:` prefix runs the command on the test host (this Mac), not via rcon.
        # Useful for harness ops like backing up locations files, sleeps, or
        # killing/connecting bot processes. Shell-quoted; runs under bash -c.
        if [[ "$cmd" == local:* ]]; then
            local shell_cmd="${cmd#local:}"
            shell_cmd="${shell_cmd# }"  # strip one leading space
            result=$(bash -c "$shell_cmd" 2>&1 | tail -2)
            if [ -z "$QUIET" ]; then
                printf '  %s\n' "$cmd"
                printf '    -> %s\n' "$result"
            fi
            continue
        fi
        # Escape single quotes in command (since we're wrapping in single quotes for ssh)
        local safe_cmd
        safe_cmd=$(printf '%s' "$cmd" | sed "s/'/'\"'\"'/g")
        # -n: do not read stdin (would otherwise consume the rest of the herestring)
        result=$(ssh -n "$MC_HOST_SSH" "sudo docker exec $MC_DOCKER_NAME rcon-cli '$safe_cmd'" 2>&1 | tail -2 | tr -d '\033' | sed 's/\[[0-9;]*m//g')
        if [ -n "$QUIET" ]; then
            : # silent
        else
            printf '  %s\n' "$cmd"
            printf '    -> %s\n' "$result"
        fi
    done <<< "$cmds"
}

WORLD=$(grep -E '^world:' "$FIXTURE" | head -1 | sed -E 's/^world:\s*//; s/[[:space:]]*$//')
[ -z "$QUIET" ] && echo "fixture: $FIXTURE  (world: ${WORLD:-?})"

case "$MODE" in
    prep)    run_rcon_lines prep ;;
    cleanup) run_rcon_lines cleanup ;;
    both)    run_rcon_lines prep; run_rcon_lines cleanup ;;
esac

[ -z "$QUIET" ] && echo "done."
