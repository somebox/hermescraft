from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mapcatalog.server_config import ServerConfig


@dataclass(frozen=True)
class Pass1Options:
    """Pass 1 tuning from job `pass1:` block or server defaults."""

    verify_live: bool = False
    verify_live_samples: int = 10
    # ``always`` — sparse live biome check after materialize for every cubiomes accept.
    # ``borderline`` — only when cubiomes fraction is within margin above the gate minimum.
    verify_live_when: str = "always"
    verify_live_margin: float = 0.15


def cubiomes_configured(server_raw: dict | None, cfg: ServerConfig | None = None) -> bool:
    binary: str | None = None
    if cfg and cfg.cubiomes_binary:
        binary = cfg.cubiomes_binary
    elif server_raw:
        cub = server_raw.get("cubiomes") or {}
        if cub.get("binary"):
            binary = str(cub["binary"])
    if not binary:
        return False
    return Path(binary).is_file()


def parse_pass1_options(
    raw: dict | None,
    server_raw: dict | None = None,
    cfg: ServerConfig | None = None,
) -> Pass1Options:
    server_pass1 = dict((server_raw or {}).get("pass1") or {})
    req_pass1 = dict((raw or {}).get("pass1") or {})
    merged = {**server_pass1, **req_pass1}
    explicit_verify = "verify_live" in server_pass1 or "verify_live" in req_pass1

    when = str(merged.get("verify_live_when", "always")).lower()
    if when not in ("always", "borderline", "off"):
        when = "borderline"

    verify = bool(merged.get("verify_live", False))
    if when == "off":
        verify = False
    elif not explicit_verify and cubiomes_configured(server_raw, cfg):
        verify = True

    return Pass1Options(
        verify_live=verify,
        verify_live_samples=int(merged.get("verify_live_samples", 10)),
        verify_live_when=when,
        verify_live_margin=float(merged.get("verify_live_margin", 0.15)),
    )
