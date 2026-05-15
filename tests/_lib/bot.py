"""BotClient — HTTP wrapper for the bot's API.

Extracted from the http_get / http_post / wait_for_bot pattern that's
duplicated across the 44 scripts/test-*.py files. Config-driven base URL.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any


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

    def observe(self) -> dict[str, Any]:
        """Fetch the /observe snapshot. Used by predicates for end-of-test state."""
        try:
            return self.get("/observe", timeout=10.0)
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
            return {}
