"""Shared perception bundle + OpenRouter digest for mc advise and integration tests."""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tests._lib.bot import BotClient
from tests._lib.config import load_config
from tests._lib.openrouter import digest, resolve_openrouter_api_key

REPO_ROOT = Path(__file__).resolve().parents[2]


def resolve_api_url(config: dict | None = None) -> str:
    env = os.environ.get("MC_API_URL")
    if env:
        return str(env).rstrip("/")
    cfg = config or load_config()
    return str(cfg["bot"]["default_api_url"]).rstrip("/")


_BUNDLE_BY_KIND: dict[str, dict[str, bool]] = {
    # default ("advise" / unspecified) — full bundle
    "advise": {"include_nearby": True, "include_map": True},
    # close-range observations — skip the wide map view
    "scene":  {"include_nearby": True, "include_map": False},
    "find":   {"include_nearby": True, "include_map": False},
    "nearby": {"include_nearby": True, "include_map": False},
    # wide-area scan — keep map, drop nearby (redundant)
    "map":    {"include_nearby": False, "include_map": True},
}


def capture_perception_bundle(
    bot: BotClient,
    *,
    preserve_status: bool = True,
    include_nearby: bool | None = None,
    nearby_radius: int = 16,
    include_map: bool | None = None,
    map_radius: int = 24,
    scene_range: int = 32,
    include_chat: bool = False,
    chat_count: int = 10,
    kind: str = "advise",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """HTTP reads used by mc advise.

    Per-kind defaults trim the bundle for the caller's actual need
    (e.g. `mc find` doesn't need a wide map). Explicit `include_*=True/False`
    overrides the kind defaults.
    """
    defaults = _BUNDLE_BY_KIND.get(kind, _BUNDLE_BY_KIND["advise"])
    if include_nearby is None:
        include_nearby = defaults["include_nearby"]
    if include_map is None:
        include_map = defaults["include_map"]

    status_path = "/status?lean=false"
    if preserve_status:
        status_path += "&preserve=true"
    out: dict[str, Any] = {
        "observe": bot.get("/observe?lean=true"),
        "status": bot.get(status_path),
        "scene": bot.get(f"/scene?range={scene_range}&lean=true"),
    }
    if include_nearby:
        out["nearby"] = bot.get(f"/nearby?radius={nearby_radius}")
    if include_map:
        out["map"] = bot.get(f"/map?radius={map_radius}")
    if include_chat:
        try:
            out["chat"] = bot.get(f"/chat?count={chat_count}")
        except Exception:
            out["chat"] = None
    if extra:
        out.update(extra)
    return out


def perception_answer_v1(parsed: dict[str, Any]) -> dict[str, Any]:
    """Stable agent-facing slice (no raw bundle)."""
    return {
        "schema": "perception_answer_v1",
        "summary": parsed.get("summary") or "",
        "recommendations": parsed.get("recommendations") or [],
        "caveats": parsed.get("caveats") or [],
        "nothing_actionable": bool(parsed.get("nothing_actionable")),
    }


def append_advise_log(record: dict[str, Any]) -> None:
    log_dir = Path(os.environ.get("LOG_DIR", "/tmp/hermescraft"))
    path = log_dir / "mc-advise.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False)
    with path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def run_advise(
    reason: str,
    *,
    api_url: str | None = None,
    config: dict | None = None,
    dry_run: bool = False,
    model: str | None = None,
    include_bundle_in_response: bool = False,
    kind: str = "advise",
    include_chat: bool = True,
    target: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Run advise pipeline. Returns mc-style CLI envelope:
      { ok, command, data?, error?, ... }

    `kind` distinguishes the caller in mc-advise.jsonl (e.g. "advise",
    "scene", "status", "map", "find", "nearby") so we can tell explicit
    advise from auto-wrapped observation when MC_FORCE_REASON is on.
    """
    cmd = kind or "advise"
    reason = (reason or "").strip()
    if not reason:
        return {
            "ok": False,
            "command": cmd,
            "error": f'missing --reason (sub-goal or question for the {cmd} digest)',
            "error_type": "missing_argument",
        }

    cfg = config or load_config()
    base = api_url or resolve_api_url(cfg)
    bot = BotClient(cfg, base_url=base)

    t0 = time.perf_counter()
    try:
        bot.wait_until_ready(timeout=min(20.0, cfg["bot"]["health_poll_timeout_s"]))
    except TimeoutError as e:
        return {
            "ok": False,
            "command": cmd,
            "error": f"bot not ready at {base}: {e}",
            "error_type": "bot_unreachable",
        }

    http_t0 = time.perf_counter()
    try:
        bundle = capture_perception_bundle(bot, include_chat=include_chat, kind=cmd)
        # Task #6: when caller passed a --target, fetch route_preview from
        # the bot's /route_probe endpoint and attach it to the bundle so the
        # digest LLM has concrete terrain data along the bot→target line.
        # Failures here are non-fatal — advise still works without route_preview.
        if target and all(target.get(k) is not None for k in ("x", "y", "z")):
            try:
                tx, ty, tz = target["x"], target["y"], target["z"]
                probe = bot.get(f"/route_probe?to_x={tx}&to_y={ty}&to_z={tz}&samples=20")
                if probe and probe.get("ok"):
                    bundle["route_preview"] = probe.get("data")
            except Exception:
                pass
    except Exception as e:
        return {
            "ok": False,
            "command": cmd,
            "error": f"perception bundle failed: {e}",
            "error_type": "http_error",
        }
    http_ms = round((time.perf_counter() - http_t0) * 1000, 1)

    if dry_run:
        data = {
            "reason": reason,
            "kind": cmd,
            "dry_run": True,
            "api_url": base,
            "bundle_keys": list(bundle.keys()),
            "bundle_bytes": len(json.dumps(bundle).encode("utf-8")),
            "http_ms": http_ms,
        }
        append_advise_log(
            {
                "ts": datetime.now(timezone.utc).isoformat(),
                "kind": cmd,
                "reason": reason,
                "dry_run": True,
                "http_ms": http_ms,
                "api_url": base,
            }
        )
        return {"ok": True, "command": cmd, "data": data}

    if not resolve_openrouter_api_key():
        return {
            "ok": False,
            "command": cmd,
            "error": "OpenRouter API key not set (OPENROUTER_API_KEY or secrets.yaml openrouter_api_key)",
            "error_type": "missing_api_key",
        }

    digest_t0 = time.perf_counter()
    result = digest(
        bundle,
        reason,
        model=model or os.environ.get("DIGEST_MODEL"),
    )
    digest_ms = round((time.perf_counter() - digest_t0) * 1000, 1)
    total_ms = round((time.perf_counter() - t0) * 1000, 1)

    parsed = result.get("parsed")
    parsed_d = parsed or {}
    log_entry: dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "kind": cmd,
        "reason": reason,
        "api_url": base,
        "http_ms": http_ms,
        "digest_ms": digest_ms,
        "total_ms": total_ms,
        "model": result.get("model"),
        "usage": result.get("usage"),
        "ok": parsed is not None,
        "summary": parsed_d.get("summary") if parsed else None,
        "recommendations": parsed_d.get("recommendations") if parsed else None,
        "caveats": parsed_d.get("caveats") if parsed else None,
        "nothing_actionable": bool(parsed_d.get("nothing_actionable")) if parsed else None,
    }
    # On parse failure, preserve enough context to investigate later. The
    # raw_preview is the first 1000 chars of whatever the LLM actually sent
    # back; error is whatever digest() flagged. Without these the failure
    # is opaque in mc-advise.jsonl (we hit this exact gap debugging
    # circuit-v5's "route plan to W1" parse fail on 2026-05-21).
    if parsed is None:
        log_entry["error"] = result.get("error") or "parsed_none"
        log_entry["raw_preview"] = (result.get("raw") or "")[:1000]
    append_advise_log(log_entry)

    if parsed is None:
        # F14 (task #51): distinguish timeouts from parse failures so
        # the agent can react appropriately. Timeouts often resolve on
        # retry; parse failures don't.
        is_timeout = result.get("error_kind") == "timeout"
        return {
            "ok": False,
            "command": cmd,
            "error": result.get("error") or "digest did not return valid JSON",
            "error_type": "advise_timeout" if is_timeout else "digest_failed",
            "next_action_hint": (
                "mc advise --reason=\"<same>\" --target X,Y,Z  # retry; OpenRouter was slow"
                if is_timeout
                else "Skip mc advise for now — check mc map / mc scene directly."
            ),
            "data": {
                "reason": reason,
                "kind": cmd,
                "raw_preview": (result.get("raw") or "")[:500],
                "timing": {"http_ms": http_ms, "digest_ms": digest_ms, "total_ms": total_ms},
            },
        }

    answer = perception_answer_v1(parsed)
    data: dict[str, Any] = {
        "reason": reason,
        "kind": cmd,
        **answer,
        "timing": {
            "http_ms": http_ms,
            "digest_ms": digest_ms,
            "total_ms": total_ms,
            "model": result.get("model"),
        },
    }
    if include_bundle_in_response:
        data["perception_input"] = bundle

    return {"ok": True, "command": cmd, "data": data}
