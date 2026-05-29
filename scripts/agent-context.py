#!/usr/bin/env python3
"""Live per-bot context-length + token usage measurement.

Why this exists
---------------
Long-running kanban workers + Steward's continuous loop accumulate messages
inside a single Hermes session. Today's session (2026-05-27) showed Flint
at 234 messages / ~154K-token context after ~30 minutes of activity, and
no operator-facing way to see that. Without this, you only notice context
bloat when calls start failing or thinking-out-loud goes off the rails.

This is a read-only snapshot. It writes nothing, never restarts a session,
and never touches Hermes internals.

What it measures
----------------
Per bot, finds the active session by looking at the most-recently-modified
`session_*.json` in the bot's HERMES_HOME. Reports:

  msgs           = len(messages_array) in the JSON file
  ctx_tok        = ~chars(messages) / chars_per_token (default 3.5)
                   This is approximately what the next LLM call will send
                   (system prompt + skills aren't included in this number —
                   use --breakdown for the full picture)
  in_tok / out_tok / cache_r / cache_w
                 = cumulative across all calls in this session, from the
                   sessions table of the bot's state.db. Updates mid-session.
  cost $         = estimated total spend on this session at the configured
                   model pricing (deepseek-v4-flash:exacto default, override
                   with --price-in/--price-out/--price-cache)

Two HERMES_HOME paths the script knows about:
  ~/.hermes/profiles/<bot>/         — kanban workers (hermes -p <bot> ...)
  ~/.hermes-landfolk-<bot>/         — continuous loops (Steward today)

Usage
-----
    scripts/agent-context.py                       # table for all known bots
    scripts/agent-context.py --json                # machine-readable
    scripts/agent-context.py --bot flint           # one bot
    scripts/agent-context.py --breakdown flint     # per-message-type stats
    scripts/agent-context.py --chars-per-token 3.0 # tighter ratio for JSON-heavy sessions

Pricing defaults: deepseek/deepseek-v4-flash:exacto on OpenRouter
  $0.10 / 1M input  (uncached)
  $0.01 / 1M input  (cache hit; OpenRouter's "input_cache_read")
  $0.20 / 1M output
Override with --price-in / --price-cache / --price-out (units: $ per 1M).
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from collections import Counter
from pathlib import Path

HOME = Path.home()
BOTS_DEFAULT = ['flint', 'mason', 'steward', 'gatherer', 'barley']

# OpenRouter / deepseek-v4-flash:exacto defaults (May 2026)
PRICE_IN_PER_M_DEFAULT = 0.10
PRICE_CACHE_PER_M_DEFAULT = 0.01
PRICE_OUT_PER_M_DEFAULT = 0.20

# Tool-heavy JSON content is dense; English is ~4 chars/token. 3.5 is a
# decent compromise for mixed agent transcripts (reasoning + tool I/O).
CHARS_PER_TOKEN_DEFAULT = 3.5


def candidate_homes(bot: str) -> list[Path]:
    """HERMES_HOME locations a bot might use.

    A given bot can have *both*:
      ~/.hermes-landfolk-<bot>/   — set via HERMES_HOME env (continuous loop)
      ~/.hermes/profiles/<bot>/   — selected via `hermes -p <bot>` (kanban worker)
    We pick whichever has the most recent session activity (see resolve_home).
    """
    return [h for h in (
        HOME / f'.hermes-landfolk-{bot}',
        HOME / '.hermes' / 'profiles' / bot,
    ) if h.exists()]


def latest_session_file(home: Path) -> Path | None:
    """Most-recently-modified session JSON under a HERMES_HOME, if any."""
    files: list[Path] = []
    files.extend(home.glob('sessions/session_*.json'))
    files.extend(home.glob('profiles/*/sessions/session_*.json'))
    if not files:
        return None
    return max(files, key=lambda p: p.stat().st_mtime)


def resolve_home(bot: str) -> Path | None:
    """Pick the HERMES_HOME with the freshest session file (the bot's active one)."""
    homes = candidate_homes(bot)
    if not homes:
        return None
    if len(homes) == 1:
        return homes[0]
    best = None
    best_mtime = -1.0
    for h in homes:
        f = latest_session_file(h)
        if f:
            t = f.stat().st_mtime
            if t > best_mtime:
                best, best_mtime = h, t
    return best or homes[0]


def state_db(home: Path) -> Path | None:
    """state.db location inside a HERMES_HOME."""
    direct = home / 'state.db'
    if direct.exists():
        return direct
    nested = list(home.glob('profiles/*/state.db'))
    return nested[0] if nested else None


def latest_session_row(db_path: Path) -> dict | None:
    """Most-recent session row by started_at, regardless of ended_at."""
    if not db_path.exists():
        return None
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            """
            SELECT id, started_at, ended_at, message_count, tool_call_count,
                   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
              FROM sessions
             ORDER BY started_at DESC
             LIMIT 1
            """
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return {
        'id': row[0],
        'started_at': row[1],
        'ended_at': row[2],
        'message_count': row[3] or 0,
        'tool_call_count': row[4] or 0,
        'input_tokens': row[5] or 0,
        'output_tokens': row[6] or 0,
        'cache_read_tokens': row[7] or 0,
        'cache_write_tokens': row[8] or 0,
    }


def estimate_tokens(messages: list[dict], chars_per_token: float) -> int:
    """Char-count → token estimate. ~3.5 chars/token is a reasonable proxy
    for mixed text+JSON content; pass a smaller ratio for tool-heavy sessions."""
    chars = sum(len(json.dumps(m, ensure_ascii=False)) for m in messages)
    return int(chars / chars_per_token)


def session_payload(path: Path) -> dict | None:
    """Read the session JSON; returns None on any error."""
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return None


def estimate_cost(usage: dict, price_in: float, price_cache: float, price_out: float) -> float:
    """Cost in dollars from cumulative token counts at the given per-1M prices."""
    cache = usage.get('cache_read_tokens', 0)
    inp = max(0, usage.get('input_tokens', 0) - cache)  # uncached input
    out = usage.get('output_tokens', 0)
    return (inp * price_in + cache * price_cache + out * price_out) / 1_000_000


def fmt_tokens(n: int) -> str:
    if n is None:
        return '-'
    if n >= 1_000_000:
        return f'{n / 1_000_000:.2f}M'
    if n >= 1_000:
        return f'{n / 1_000:.1f}K'
    return str(n)


def gather_bot(bot: str, chars_per_token: float, prices: tuple[float, float, float]) -> dict:
    """Build the snapshot record for one bot."""
    rec: dict = {'bot': bot, 'home': None, 'session_id': None, 'msgs': 0,
                 'ctx_tokens_est': 0, 'session_file_kb': 0, 'session_active': False}
    rec.update({'input_tokens': 0, 'output_tokens': 0,
                'cache_read_tokens': 0, 'cache_write_tokens': 0,
                'session_db_msgs': 0, 'session_db_tools': 0, 'cost_usd': 0.0})

    home = resolve_home(bot)
    if home is None:
        rec['error'] = 'no HERMES_HOME found'
        return rec
    rec['home'] = str(home)

    f = latest_session_file(home)
    if f:
        rec['session_file'] = str(f)
        rec['session_file_kb'] = f.stat().st_size // 1024
        payload = session_payload(f)
        if payload:
            msgs = payload.get('messages', [])
            rec['msgs'] = len(msgs)
            rec['ctx_tokens_est'] = estimate_tokens(msgs, chars_per_token)

    db = state_db(home)
    if db:
        row = latest_session_row(db)
        if row:
            rec['session_id'] = row['id']
            rec['session_active'] = row['ended_at'] is None
            rec['session_db_msgs'] = row['message_count']
            rec['session_db_tools'] = row['tool_call_count']
            for k in ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'):
                rec[k] = row[k]
            rec['cost_usd'] = estimate_cost(row, *prices)
    return rec


def print_table(rows: list[dict], chars_per_token: float, prices: tuple[float, float, float]) -> None:
    print(f"  ctx_tokens column = estimated from session JSON char count (÷{chars_per_token} chars/token)")
    print(f"  in/out/cache columns = cumulative from state.db (sessions table)")
    print(f"  cost = (in − cache_r)·${prices[0]} + cache_r·${prices[1]} + out·${prices[2]} per 1M")
    print()
    header = f"{'bot':<9} {'msgs':>4} {'ctx_tok':>8} {'in_tok':>8} {'out_tok':>8} {'cache_r':>8} {'cache_w':>8} {'cost $':>7} {'file_kb':>7} {'session id':<28}"
    print(header)
    print('-' * len(header))
    for r in rows:
        if r.get('error'):
            print(f"{r['bot']:<9} ({r['error']})")
            continue
        active = '*' if r['session_active'] else ' '
        print(
            f"{r['bot']:<9} {r['msgs']:>4} "
            f"{fmt_tokens(r['ctx_tokens_est']):>8} "
            f"{fmt_tokens(r['input_tokens']):>8} "
            f"{fmt_tokens(r['output_tokens']):>8} "
            f"{fmt_tokens(r['cache_read_tokens']):>8} "
            f"{fmt_tokens(r['cache_write_tokens']):>8} "
            f"{r['cost_usd']:>7.4f} "
            f"{r['session_file_kb']:>7} "
            f"{(r.get('session_id') or '-'):<28}{active}"
        )
    print()
    print('* = session still active (ended_at IS NULL in state.db)')


def print_breakdown(bot: str, chars_per_token: float) -> None:
    home = resolve_home(bot)
    if not home:
        print(f"no HERMES_HOME for {bot}")
        return
    f = latest_session_file(home)
    if not f:
        print(f"no session file under {home}")
        return
    payload = session_payload(f)
    if not payload:
        print(f"could not read {f}")
        return
    msgs = payload.get('messages', [])
    if not msgs:
        print(f"empty messages array in {f}")
        return

    print(f"bot: {bot}")
    print(f"session: {f.name}")
    print(f"messages: {len(msgs)}")
    print()

    # Per-role token distribution
    role_chars: Counter = Counter()
    role_msgs: Counter = Counter()
    for m in msgs:
        role = m.get('role', '?')
        role_msgs[role] += 1
        role_chars[role] += len(json.dumps(m, ensure_ascii=False))
    print(f"{'role':<12} {'count':>6} {'chars':>10} {'est_tok':>9} {'%':>5}")
    total = sum(role_chars.values())
    for role in sorted(role_chars, key=role_chars.get, reverse=True):
        c = role_chars[role]
        n = role_msgs[role]
        pct = 100 * c / total if total else 0
        print(f"{role:<12} {n:>6} {c:>10,} {int(c/chars_per_token):>9,} {pct:>4.1f}%")
    print()

    # Top 5 fattest individual messages — useful for finding tool-output bloat
    print("top 5 largest individual messages:")
    sized = sorted(
        ((i, len(json.dumps(m, ensure_ascii=False)), m.get('role', '?'),
          (m.get('content') if isinstance(m.get('content'), str) else '')[:60])
         for i, m in enumerate(msgs)),
        key=lambda t: t[1], reverse=True,
    )[:5]
    for idx, sz, role, preview in sized:
        print(f"  msg[{idx:>3}] {role:<10} {sz:>8,} chars (~{int(sz/chars_per_token):,} tok)  {preview!r}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--bot', action='append',
                    help='Limit to one or more bots (repeatable). Default: all known.')
    ap.add_argument('--json', action='store_true', help='Machine-readable output.')
    ap.add_argument('--breakdown', metavar='BOT',
                    help='Show per-message-role breakdown + top-5 fattest messages for one bot.')
    ap.add_argument('--chars-per-token', type=float, default=CHARS_PER_TOKEN_DEFAULT,
                    help=f'Char→token ratio for ctx_tok estimate (default {CHARS_PER_TOKEN_DEFAULT})')
    ap.add_argument('--price-in', type=float, default=PRICE_IN_PER_M_DEFAULT,
                    help=f'$ per 1M uncached input tokens (default {PRICE_IN_PER_M_DEFAULT})')
    ap.add_argument('--price-cache', type=float, default=PRICE_CACHE_PER_M_DEFAULT,
                    help=f'$ per 1M cached input tokens (default {PRICE_CACHE_PER_M_DEFAULT})')
    ap.add_argument('--price-out', type=float, default=PRICE_OUT_PER_M_DEFAULT,
                    help=f'$ per 1M output tokens (default {PRICE_OUT_PER_M_DEFAULT})')
    args = ap.parse_args()

    prices = (args.price_in, args.price_cache, args.price_out)

    if args.breakdown:
        print_breakdown(args.breakdown, args.chars_per_token)
        return 0

    bots = args.bot or BOTS_DEFAULT
    rows = [gather_bot(b, args.chars_per_token, prices) for b in bots]
    # Drop bots with no HERMES_HOME unless explicitly named
    if not args.bot:
        rows = [r for r in rows if not r.get('error')]

    if args.json:
        out = {
            'measured_at': __import__('datetime').datetime.now().isoformat(timespec='seconds'),
            'chars_per_token': args.chars_per_token,
            'prices_per_1m': {'in': args.price_in, 'cache': args.price_cache, 'out': args.price_out},
            'bots': rows,
        }
        print(json.dumps(out, indent=2))
    else:
        print_table(rows, args.chars_per_token, prices)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
