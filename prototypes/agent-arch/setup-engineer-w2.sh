#!/usr/bin/env bash
set -euo pipefail
# W2 engineer desk — after smoke-script gate passes.
source "$(dirname "$0")/lib/desk_w2_profile.sh"
desk_w2_init

NAME=engineer
desk_w2_create_profile "$NAME" "W2 engineer desk (IMPROVE cards)"
desk_w2_write_config "$NAME"
desk_w2_write_env "$NAME"
desk_w2_install_skill "$NAME" "$SKILLS_SRC/kanban-worker.md" "devops/kanban-worker"
desk_w2_install_skill "$NAME" "$SKILLS_SRC/agent-engineer-desk.md" "gaming/agent-engineer-desk"
desk_w2_zero_memory "$NAME"
desk_w2_log "engineer ready"
