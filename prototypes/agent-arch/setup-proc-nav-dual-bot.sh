#!/usr/bin/env bash
# Proc-scout-road: four execute profiles → two bots (Mox :3007, Pip :3005).
#
#   navigator      / builder       — default W1 roles (re-bound here)
#   navigator-pip  / builder-mox   — second bot lanes for mutex parallelism
#
# Run after setup-role-profiles.sh. Idempotent.
#
# Usage:
#   KANBAN_BOARD=proc-nav-lab prototypes/agent-arch/setup-proc-nav-dual-bot.sh

set -euo pipefail

export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
KANBAN_BOARD="${KANBAN_BOARD:-proc-nav-lab}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SKILLS_SRC="$REPO_ROOT/skills"
PROFILES_DIR="$HERMES_HOME/profiles"
TEMPLATE="$SCRIPT_DIR/profiles_role.env.template"

log() { printf '[setup-dual-bot] %s\n' "$*"; }
die() { printf '[setup-dual-bot] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -d "$HERMES_HOME" ]] || die "HERMES_HOME missing: $HERMES_HOME"
[[ -f "$TEMPLATE" ]] || die "missing $TEMPLATE"

OPENROUTER_KEY=""
if [[ -f "$HOME/.hermes/profiles/flint/.env" ]]; then
  OPENROUTER_KEY="$(grep -E '^OPENROUTER_API_KEY=' "$HOME/.hermes/profiles/flint/.env" | head -1 | sed 's/^OPENROUTER_API_KEY=//' || true)"
fi
[[ -n "$OPENROUTER_KEY" ]] || OPENROUTER_KEY="__SET_ME__"

MOX_YAML="$REPO_ROOT/data/bots/mox.yaml"
PIP_YAML="$REPO_ROOT/data/bots/pip.yaml"

write_config_yaml() {
  local name="$1"
  local path="$PROFILES_DIR/$name/config.yaml"
  local src="$PROFILES_DIR/navigator/config.yaml"
  # Skip self-copy (when re-binding the navigator profile to its own config).
  if [[ -f "$src" && "$src" != "$path" ]]; then
    cp "$src" "$path"
  fi
  log "config $name"
}

write_env_for_bot() {
  local role="$1" bot_yaml="$2"
  local path="$PROFILES_DIR/$role/.env"
  [[ -f "$bot_yaml" ]] || die "missing bot yaml: $bot_yaml"
  local api_port user
  api_port=$(awk '/^api_port:/ {print $2}' "$bot_yaml")
  user=$(awk '/^username:/ {print $2}' "$bot_yaml")
  {
    sed "s|__OPENROUTER_API_KEY__|$OPENROUTER_KEY|" "$TEMPLATE"
    echo "MC_API_URL=http://127.0.0.1:${api_port}"
    echo "MC_USERNAME=${user}"
    echo "_MC_API_URL_LOCKED=http://127.0.0.1:${api_port}"
    echo "HERMESCRAFT_REPO=$REPO_ROOT"
    echo "HERMES_KANBAN_BOARD=$KANBAN_BOARD"
  } > "$path"
  chmod 600 "$path"
  log "role=$role → ${user} :${api_port}"
}

install_mc_for_bot() {
  local role="$1" bot_yaml="$2"
  local api_port user
  api_port=$(awk '/^api_port:/ {print $2}' "$bot_yaml")
  user=$(awk '/^username:/ {print $2}' "$bot_yaml")
  local bindir="$PROFILES_DIR/$role/bin"
  mkdir -p "$bindir"
  cat > "$bindir/mc" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export MC_API_URL="\${MC_API_URL:-http://127.0.0.1:${api_port}}"
export MC_USERNAME="\${MC_USERNAME:-${user}}"
exec "${REPO_ROOT}/bin/mc" "\$@"
EOF
  chmod +x "$bindir/mc"
}

install_skill_file() {
  local role="$1" src="$2" dest_rel="$3"
  mkdir -p "$PROFILES_DIR/$role/skills/$dest_rel"
  cp "$src" "$PROFILES_DIR/$role/skills/$dest_rel/SKILL.md"
}

ensure_profile_dir() {
  local name="$1"
  mkdir -p "$PROFILES_DIR/$name/memories" "$PROFILES_DIR/$name/skills"
  : > "$PROFILES_DIR/$name/memories/MEMORY.md"
  if command -v hermes >/dev/null 2>&1; then
    if ! hermes profile list 2>/dev/null | grep -qE "^\s*${name}\b"; then
      hermes profile create "$name" --no-skills --no-alias \
        --description "proc-nav dual-bot $name" >/dev/null 2>&1 || true
    fi
  fi
}

copy_soul_from() {
  local dest="$1" src="$2" bot_label="$3"
  [[ -f "$PROFILES_DIR/$src/SOUL.md" ]] || return 0
  sed "s/board \*\*[^*]*\*\*/board **${KANBAN_BOARD}**/" \
    "$PROFILES_DIR/$src/SOUL.md" > "$PROFILES_DIR/$dest/SOUL.md" || \
    cp "$PROFILES_DIR/$src/SOUL.md" "$PROFILES_DIR/$dest/SOUL.md"
  echo "" >> "$PROFILES_DIR/$dest/SOUL.md"
  echo "In-world bot for this profile: **${bot_label}** (\`MC_USERNAME\` from .env)." >> "$PROFILES_DIR/$dest/SOUL.md"
}

bind_role() {
  local role="$1" bot_yaml="$2" soul_src="$3" bot_label="$4"
  ensure_profile_dir "$role"
  write_config_yaml "$role"
  write_env_for_bot "$role" "$bot_yaml"
  install_mc_for_bot "$role" "$bot_yaml"
  copy_soul_from "$role" "$soul_src" "$bot_label"
}

for base in navigator builder; do
  [[ -d "$PROFILES_DIR/$base" ]] || die "profile $base missing — run setup-role-profiles.sh first"
done

bind_role navigator "$MOX_YAML" navigator "Mox"
bind_role builder-mox "$MOX_YAML" builder "Mox"
bind_role navigator-pip "$PIP_YAML" navigator "Pip"
bind_role builder "$PIP_YAML" builder "Pip"

# Road clear cards need agent-builder doctrine + building grammar + dig/terrain
# verbs on both builders. agent-builder also covers the kanban-worker turn-1
# pattern; without it, the card body declares "Unknown skill(s): agent-builder"
# and blocks at dispatch.
for role in builder builder-mox; do
  install_skill_file "$role" "$SKILLS_SRC/agent-builder.md" "gaming/agent-builder"
  install_skill_file "$role" "$SKILLS_SRC/minecraft-building.md" "gaming/minecraft-building"
  install_skill_file "$role" "$SKILLS_SRC/minecraft-mining.md" "gaming/minecraft-mining"
  install_skill_file "$role" "$SKILLS_SRC/minecraft-roadbuilding.md" "gaming/minecraft-roadbuilding"
done
for role in navigator navigator-pip; do
  install_skill_file "$role" "$SKILLS_SRC/agent-navigator.md" "gaming/agent-navigator"
  install_skill_file "$role" "$SKILLS_SRC/minecraft-navigation.md" "gaming/minecraft-navigation"
  install_skill_file "$role" "$SKILLS_SRC/minecraft-observe.md" "gaming/minecraft-observe"
  install_skill_file "$role" "$SKILLS_SRC/kanban-worker.md" "devops/kanban-worker"
  install_skill_file "$role" "$SKILLS_SRC/minecraft-survival.md" "gaming/minecraft-survival"
  # Navigators emit target_y on scout/measure cards. Without the roadbuilding
  # skill they fall back to the catalog overlook Y (e.g. y=67) which leaks
  # downstream into builder cards that try to dig 11+ blocks of trench.
  # See data/postmortems/proc-nav-lab/proc-nav-1780970837/postmortem.md (R2).
  install_skill_file "$role" "$SKILLS_SRC/minecraft-roadbuilding.md" "gaming/minecraft-roadbuilding"
done

log "done — Mox: navigator + builder-mox; Pip: navigator-pip + builder"
