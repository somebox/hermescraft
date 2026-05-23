"""BotClient — HTTP wrapper for the bot's API.

Extracted from the http_get / http_post / wait_for_bot pattern that's
duplicated across the 44 scripts/test-*.py files. Config-driven base URL.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Callable


class BotClient:
    """Talk to the bot HTTP API. Base URL comes from config.bot.default_api_url."""

    def __init__(self, config: dict, base_url: str | None = None):
        self.base = (base_url or config["bot"]["default_api_url"]).rstrip("/")
        self.health_poll_interval = config["bot"]["health_poll_interval_s"]
        self.health_poll_timeout = config["bot"]["health_poll_timeout_s"]

    def get(self, path: str, timeout: float = 10.0) -> dict[str, Any]:
        url = f"{self.base}{path}"
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode())

    def post(self, path: str, body: dict | None = None, timeout: float = 30.0) -> dict[str, Any]:
        url = f"{self.base}{path}"
        data = json.dumps(body or {}).encode()
        req = urllib.request.Request(
            url, data=data, method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            # Bot returns JSON envelopes even on 4xx — surface them.
            try:
                return json.loads(e.read().decode())
            except Exception:
                raise

    def wait_until_ready(self, timeout: float | None = None) -> dict[str, Any]:
        """Poll GET /health until the bot reports connected=true. Returns the
        final health response. Raises TimeoutError on deadline."""
        deadline = time.time() + (timeout if timeout is not None else self.health_poll_timeout)
        last: dict[str, Any] = {}
        while time.time() < deadline:
            try:
                last = self.get("/health", timeout=5.0)
                if last.get("connected"):
                    return last
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                pass
            time.sleep(self.health_poll_interval)
        raise TimeoutError(f"bot not connected within {timeout or self.health_poll_timeout}s; last: {last}")

    def ensure_connected(self, reconnect_timeout: float = 12.0) -> dict[str, Any]:
        """Fast path when the bot is healthy; short poll only after disconnect."""
        try:
            health = self.get("/health", timeout=2.0)
            if health.get("connected"):
                return health
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError):
            pass
        return self.wait_until_ready(timeout=reconnect_timeout)

    def observe(self) -> dict[str, Any]:
        """Fetch the /observe snapshot. Used by predicates for end-of-test state."""
        try:
            return self.get("/observe", timeout=10.0)
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
            return {}

    # ── State convenience accessors ──────────────────────────────────────
    # Wrap the /status?lean=true endpoint that every legacy test queries
    # for position/inventory. Read-only; consult fresh state on each call.

    def status_lean(self) -> dict[str, Any]:
        """GET /status?lean=true → response.data (the bot's lean status block).

        Uses ?preserve=true so test-side polling (wait_until_stationary,
        verify_tester_ready, etc.) doesn't trip the agent-facing F51.2/F58
        reset of lastMoveFailed / recentEscapes / recentStuckCells — that
        reset is reserved for the agent's explicit `mc status` calls.
        """
        resp = self.get("/status?lean=true&preserve=true", timeout=5.0)
        return resp.get("data") or {}

    def position(self) -> dict[str, float]:
        """Bot's current world position {x, y, z}. Empty dict on read failure."""
        return self.status_lean().get("position") or {}

    def inventory(self) -> dict[str, int]:
        """Bot inventory flattened to {item_name: count}.

        The /status endpoint returns a list of {name, count, ...} items;
        most legacy tests iterate it looking for a specific item. Returning
        a dict is the canonical form.
        """
        items = self.status_lean().get("inventory") or []
        out: dict[str, int] = {}
        for it in items:
            name = it.get("name")
            if not name:
                continue
            try:
                out[name] = out.get(name, 0) + int(it.get("count") or 0)
            except (TypeError, ValueError):
                continue
        return out

    def inventory_delta(
        self,
        item: str,
        timeout: float = 2.0,
        baseline: int | None = None,
        fallback_pickup: bool = True,
    ) -> int:
        """Poll inventory until `item`'s count exceeds `baseline` (default: current).

        Replaces the magnet-wait pattern used in dig-then-collect tests:
        after a dig, the dropped item enters auto-pickup range but the
        physics tick that moves it into inventory has variable latency.
        Tests that read inventory immediately after a dig sometimes see 0.

        If the magnet hasn't fired by `timeout`, optionally call
        `/action/pickup` once to force an explicit sweep — both paths
        populate the bot's recentPickups cache that F72's mc-collect
        short-circuit reads from.

        Returns the final count (which may equal baseline if nothing
        arrived even after the pickup fallback).
        """
        if baseline is None:
            baseline = self.inventory().get(item, 0)
        deadline = time.time() + max(0.0, timeout)
        while time.time() < deadline:
            cur = self.inventory().get(item, 0)
            if cur > baseline:
                return cur
            time.sleep(0.2)
        if fallback_pickup:
            try:
                self.post("/action/pickup", {}, timeout=5.0)
            except Exception:
                pass
            time.sleep(0.3)
            return self.inventory().get(item, 0)
        return self.inventory().get(item, 0)

    def wait_for_condition(
        self,
        predicate: Callable[[], bool],
        timeout: float = 10.0,
        interval: float = 0.2,
    ) -> bool:
        """Poll `predicate()` until it returns truthy or `timeout` expires.

        Generic physics wait loop. Default interval 0.2s matches the legacy
        norm — anything tighter risks thrashing /status. Tests that pass a
        predicate calling /status N times per check should still budget
        with timeout, not raise interval below 0.1.

        Returns True if the predicate succeeded, False on timeout. Does
        NOT raise — callers `assert` on the return when the deadline is
        a contract.
        """
        deadline = time.time() + max(0.0, timeout)
        while time.time() < deadline:
            try:
                if predicate():
                    return True
            except Exception:
                pass
            time.sleep(interval)
        return False
