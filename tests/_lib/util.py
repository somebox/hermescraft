"""Small helpers shared across the pytest harness.

Currently houses the error-envelope extractor that ~15 legacy scripts
each reimplemented inline. Add more cross-cutting helpers here as the
migration surfaces them — keep modules focused (rcon/bot/arena own their
domain; util.py is the catch-all for stateless utilities).
"""

from __future__ import annotations

from typing import Any


def extract_error(response: dict) -> tuple[str, str, dict]:
    """Normalize the bot's error envelope into (code, message, observed_state).

    The bot returns errors in two shapes depending on the path:
      - dict:   {"error": {"code": "X", "message": "...", "observed_state": {...}}}
      - string: {"error": "free-text message"}

    Both forms are valid in production; this helper flattens to a single
    tuple so tests can assert on each field without re-implementing the
    type narrowing.

    Returns ("", "", {}) if there is no error or the shape is unrecognized
    (e.g. a successful response). Tests should check `response["ok"]`
    separately rather than treating empty values as success.
    """
    err: Any = response.get("error")
    if isinstance(err, dict):
        return (
            err.get("code") or "",
            err.get("message") or "",
            err.get("observed_state") or {},
        )
    if isinstance(err, str):
        return ("", err, {})
    return ("", "", {})
