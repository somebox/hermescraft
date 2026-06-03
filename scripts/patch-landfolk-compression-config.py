#!/usr/bin/env python3
"""Idempotent Hermes config.yaml patches for landfolk agents.

deepseek-v4-flash reports ~1M context via OpenRouter; we cap model.context_length
so compression runs on a bounded budget. threshold/target_ratio give the agent
headroom between compressions. Aux compression model lives in
data/agent-models.json (auxiliary.compression).

Usage:
  patch-landfolk-compression-config.py PATH/to/config.yaml
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# Budget Hermes uses for compression math (not the provider's 1M advert).
# threshold must exceed target_ratio so each compression buys real working room.
# At threshold==target_ratio, post-compress context sits AT the threshold and the
# next message trips another compress — observed run-12 as 40+ compresses in 11min
# per worker on noisy mc-scene/mc-map streams.
CONTEXT_LENGTH = 250_000
COMPRESSION_THRESHOLD = 0.7
COMPRESSION_TARGET_RATIO = 0.3
COMPRESSION_PROTECT_LAST_N = 20
COMPRESSION_PROTECT_FIRST_N = 3

# Aux compression model + provider sourced from data/agent-models.json so all
# model decisions live in one file. Fallback defaults guard against a missing
# or malformed JSON.
_DEFAULT_AUX_COMPRESSION_PROVIDER = "openrouter"
_DEFAULT_AUX_COMPRESSION_MODEL = "google/gemini-2.5-flash-lite-preview-09-2025"


def _load_aux_compression() -> tuple[str, str]:
    cfg_path = Path(__file__).resolve().parents[1] / "data" / "agent-models.json"
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _DEFAULT_AUX_COMPRESSION_PROVIDER, _DEFAULT_AUX_COMPRESSION_MODEL
    aux = (cfg.get("auxiliary") or {}).get("compression") or {}
    provider = aux.get("provider") or _DEFAULT_AUX_COMPRESSION_PROVIDER
    model = aux.get("model") or _DEFAULT_AUX_COMPRESSION_MODEL
    return provider, model


AUX_COMPRESSION_PROVIDER, AUX_COMPRESSION_MODEL = _load_aux_compression()


def _patch_model_context_length(text: str) -> str:
    pat = re.compile(
        r"^(model:\s*\n(?:  [^\n]*\n)*?  context_length:\s*)\d+",
        re.M,
    )
    if pat.search(text):
        return pat.sub(rf"\g<1>{CONTEXT_LENGTH}", text, count=1)
    return re.sub(
        r"^(model:\s*\n)",
        rf"\1  context_length: {CONTEXT_LENGTH}\n",
        text,
        count=1,
        flags=re.M,
    )


def _patch_compression_section(text: str) -> str:
    """Top-level compression: block only (agent-init reads this; not voice.compression)."""
    m = re.search(r"^compression:\n((?:  [^\n]+\n)*)", text, re.M)
    if not m:
        block = f"""compression:
  enabled: true
  threshold: {COMPRESSION_THRESHOLD}
  target_ratio: {COMPRESSION_TARGET_RATIO}
  protect_last_n: {COMPRESSION_PROTECT_LAST_N}
  protect_first_n: {COMPRESSION_PROTECT_FIRST_N}
  abort_on_summary_failure: false
"""
        for anchor in ("prompt_caching:", "bedrock:", "auxiliary:"):
            if re.search(rf"^{re.escape(anchor)}", text, re.M):
                return re.sub(
                    rf"^({re.escape(anchor)})",
                    block + r"\1",
                    text,
                    count=1,
                    flags=re.M,
                )
        return text.rstrip() + "\n" + block

    inner = m.group(1)
    lines: dict[str, str] = {}
    for line in inner.splitlines():
        if not line.startswith("  ") or ":" not in line:
            continue
        key, val = line.strip().split(":", 1)
        lines[key.strip()] = val.strip()

    lines["enabled"] = "true"
    lines["threshold"] = str(COMPRESSION_THRESHOLD)
    lines["target_ratio"] = str(COMPRESSION_TARGET_RATIO)
    lines["protect_last_n"] = str(COMPRESSION_PROTECT_LAST_N)
    lines.setdefault("protect_first_n", str(COMPRESSION_PROTECT_FIRST_N))
    lines.setdefault("abort_on_summary_failure", "false")

    priority = (
        "enabled",
        "threshold",
        "target_ratio",
        "protect_last_n",
        "protect_first_n",
        "hygiene_hard_message_limit",
        "abort_on_summary_failure",
    )
    ordered: list[tuple[str, str]] = []
    seen: set[str] = set()
    for key in priority:
        if key in lines:
            ordered.append((key, lines[key]))
            seen.add(key)
    for key, val in lines.items():
        if key not in seen:
            ordered.append((key, val))

    new_inner = "".join(f"  {k}: {v}\n" for k, v in ordered)
    new_block = "compression:\n" + new_inner
    return text[: m.start()] + new_block + text[m.end() :]


def _patch_auxiliary_compression(text: str) -> str:
    """First top-level auxiliary.compression block (Hermes agent-init reads this)."""
    m = re.search(r"^auxiliary:\n((?:  [^\n]+\n)*)", text, re.M)
    if not m:
        return text.rstrip() + (
            f"\nauxiliary:\n  compression:\n"
            f'    provider: "{AUX_COMPRESSION_PROVIDER}"\n'
            f'    model: "{AUX_COMPRESSION_MODEL}"\n'
        )
    inner = m.group(1)
    comp_m = re.search(r"^  compression:\n((?:    [^\n]+\n)*)", inner, re.M)
    if not comp_m:
        inner = inner.rstrip() + (
            f"\n  compression:\n"
            f'    provider: "{AUX_COMPRESSION_PROVIDER}"\n'
            f'    model: "{AUX_COMPRESSION_MODEL}"\n'
        )
        return text[: m.start()] + "auxiliary:\n" + inner + text[m.end() :]

    comp_inner = comp_m.group(1)
    lines: dict[str, str] = {}
    for line in comp_inner.splitlines():
        if not line.startswith("    ") or ":" not in line:
            continue
        key, val = line.strip().split(":", 1)
        lines[key.strip()] = val.strip().strip('"').strip("'")
    lines["provider"] = AUX_COMPRESSION_PROVIDER
    lines["model"] = AUX_COMPRESSION_MODEL
    comp_lines = []
    for key in ("provider", "model", "base_url", "api_key", "timeout", "extra_body"):
        if key in lines:
            v = lines[key]
            if key in ("provider", "model") and v:
                comp_lines.append(f'    {key}: "{v}"\n')
            else:
                comp_lines.append(f"    {key}: {v or ''}\n")
    for key, val in lines.items():
        if key not in ("provider", "model", "base_url", "api_key", "timeout", "extra_body"):
            comp_lines.append(f"    {key}: {val}\n")
    new_comp = "  compression:\n" + "".join(comp_lines)
    new_inner = inner[: comp_m.start()] + new_comp + inner[comp_m.end() :]
    return text[: m.start()] + "auxiliary:\n" + new_inner + text[m.end() :]


def patch_config(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    new = _patch_model_context_length(text)
    new = _patch_compression_section(new)
    new = _patch_auxiliary_compression(new)
    if new != text:
        path.write_text(new, encoding="utf-8")
        return True
    return False


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"missing: {path}", file=sys.stderr)
        return 1
    changed = patch_config(path)
    print(f"{'patched' if changed else 'unchanged'}: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
