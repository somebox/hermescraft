#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/desk_w2_profile.sh"
desk_w2_init

NAME=overseer
desk_w2_create_profile "$NAME" "W2 overseer desk (REVIEW cards)"
desk_w2_write_config "$NAME"
desk_w2_write_env "$NAME"
desk_w2_install_skill "$NAME" "$SKILLS_SRC/kanban-worker.md" "devops/kanban-worker"
desk_w2_zero_memory "$NAME"
desk_w2_log "overseer ready"
