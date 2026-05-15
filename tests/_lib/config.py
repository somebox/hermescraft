"""Loader for config/hermescraft.yaml.

The YAML at the repo root holds cross-cutting settings (MC server, rcon
access, bot defaults, models, logging). Env vars are the final override
channel — anything in the environment that the bot server's
bot/lib/config/index.js reads still wins over this file.

Resolution order for the $overrides block:
    1. $HERMESCRAFT_PROFILE if set
    2. socket.gethostname() (the OS hostname)
"""

from __future__ import annotations

import os
import socket
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO_ROOT / "config" / "hermescraft.yaml"


def _deep_merge(base: dict, overlay: dict) -> dict:
    """Recursive merge — overlay values win, nested dicts merged."""
    out = dict(base)
    for k, v in overlay.items():
        if k in out and isinstance(out[k], dict) and isinstance(v, dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config(path: Path | None = None, profile: str | None = None) -> dict[str, Any]:
    """Read config/hermescraft.yaml and apply $overrides for the active profile.

    Args:
        path: Override the default config path. Used by tests.
        profile: Override the resolved profile. Default is $HERMESCRAFT_PROFILE,
                 falling back to the OS hostname.

    Returns:
        Fully resolved config dict with $overrides applied and the
        $overrides key stripped from the result.
    """
    config_path = path or CONFIG_PATH
    if not config_path.exists():
        raise FileNotFoundError(
            f"Config not found at {config_path}. "
            "This file is the source of truth for cross-cutting test settings."
        )

    with open(config_path) as f:
        raw = yaml.safe_load(f) or {}

    overrides = raw.pop("$overrides", None) or {}

    resolved_profile = profile or os.environ.get("HERMESCRAFT_PROFILE") or socket.gethostname()
    if resolved_profile in overrides:
        raw = _deep_merge(raw, overrides[resolved_profile])

    return raw
