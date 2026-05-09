#!/usr/bin/env python3
"""
Central model routing for HermesCraft. Configuration: data/agent-models.json

Schema: top-level ``defaults`` { model, provider }, optional ``landfolk`` { base_api_port? },
and ``agents`` { Name: { model?, provider?, role?, api_port? } }.
Per-agent ``api_port`` (integer) is the Mineflayer HTTP API TCP port; if omitted, port is
``landfolk.base_api_port`` or env ``BASE_API_PORT`` or 3001, plus the agent's zero-based index
in ``agents`` key order.

Commands:
  resolve-agent-model.py <AgentName> model|provider [config-path]
      MODEL_<SUFFIX> env → agents.<Name> → defaults → HERMES_MODEL/MODEL.

  resolve-agent-model.py defaults model|provider [config-path]
      HERMES_MODEL/MODEL → defaults.*.

  resolve-agent-model.py entrypoint <key> model|provider [config-path]
      Optional legacy entrypoints.<key>; if absent, same as defaults.

  resolve-agent-model.py roster-lines [config-path]
      Lines \"name:role:model\" for start-landfolk.sh: each agents.* entry with non-empty
      ``role`` (JSON key order). Legacy landfolk_roster array still supported if present.

  resolve-agent-model.py agent-names [config-path]
      One agent name per line (``agents`` key order).

  resolve-agent-model.py api-port <AgentName> [config-path]
      Mineflayer HTTP API TCP port (optional per-agent ``api_port``; else base + index).

  resolve-agent-model.py example <key> [config-path]
      Optional examples.<key>; omitted in minimal configs.

Nothing in this file hard-codes model IDs; set defaults in the JSON file.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def env_suffix(canonical_name: str) -> str:
    """e.g. Gatherer → MODEL_GATHERER suffix GATHERER."""
    return ''.join(c.upper() for c in canonical_name if c.isalnum())


def load_config(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        with path.open(encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, OSError):
        pass
    return {}


def _string(d: dict, key: str) -> str:
    v = d.get(key)
    if isinstance(v, str) and v.strip():
        return v.strip()
    return ''


def resolve_agent(name: str, field: str, config_path: Path) -> str:
    """Per canonical landfolk bot name."""
    if field not in ('model', 'provider'):
        raise ValueError(field)
    d = load_config(config_path)
    defaults = d.get('defaults') or {}
    if not isinstance(defaults, dict):
        defaults = {}
    agents = d.get('agents') or {}
    if not isinstance(agents, dict):
        agents = {}
    agent_over = agents.get(name) or {}
    if not isinstance(agent_over, dict):
        agent_over = {}

    suffix = env_suffix(name)
    if field == 'model':
        v = os.environ.get(f'MODEL_{suffix}')
        if v and str(v).strip():
            return v.strip()
        v = _string(agent_over, 'model')
        if v:
            return v
        v = _string(defaults, 'model')
        if v:
            return v
        return (os.environ.get('HERMES_MODEL') or os.environ.get('MODEL') or '').strip()
    v = os.environ.get(f'PROVIDER_{suffix}')
    if v and str(v).strip():
        return v.strip()
    v = _string(agent_over, 'provider')
    if v:
        return v
    v = _string(defaults, 'provider')
    if v:
        return v
    return (os.environ.get('HERMES_PROVIDER') or os.environ.get('PROVIDER') or '').strip()


def resolve_defaults(field: str, config_path: Path) -> str:
    """Hermes-style global default row (YAML default: / provider:)."""
    if field not in ('model', 'provider'):
        raise ValueError(field)
    d = load_config(config_path)
    defaults = d.get('defaults') or {}
    if not isinstance(defaults, dict):
        defaults = {}
    if field == 'model':
        v = (os.environ.get('HERMES_MODEL') or os.environ.get('MODEL') or '').strip()
        if v:
            return v
        return _string(defaults, 'model')
    v = (os.environ.get('HERMES_PROVIDER') or os.environ.get('PROVIDER') or '').strip()
    if v:
        return v
    return _string(defaults, 'provider')


def resolve_entrypoint(key: str, field: str, config_path: Path) -> str:
    """start-*.sh helpers; optional entrypoints.<key> else defaults."""
    if field not in ('model', 'provider'):
        raise ValueError(field)
    d = load_config(config_path)
    eps = d.get('entrypoints') or {}
    if not isinstance(eps, dict):
        eps = {}
    block = eps.get(key) or {}
    if not isinstance(block, dict):
        block = {}
    got = _string(block, field)
    if got:
        return got
    return resolve_defaults(field, config_path)


def _base_api_port(d: dict) -> int:
    """First TCP port for sequential assignment; env BASE_API_PORT overrides JSON."""
    v = os.environ.get('BASE_API_PORT', '').strip()
    if v.isdigit():
        return int(v)
    lf = d.get('landfolk') or {}
    if isinstance(lf, dict):
        bp = lf.get('base_api_port')
        if isinstance(bp, int) and bp > 0:
            return bp
        if isinstance(bp, float) and bp > 0:
            return int(bp)
        if isinstance(bp, str) and bp.strip().isdigit():
            return int(bp.strip())
    return 3001


def _canonical_agent_key(raw_name: str, config_path: Path) -> str | None:
    want = raw_name.strip().lower()
    if not want:
        return None
    for n in agent_names(config_path):
        if n.lower() == want:
            return n
    return None


def resolve_api_port(name: str, config_path: Path) -> int | None:
    """HTTP API port for Mineflayer listener for this agent."""
    d = load_config(config_path)
    agents = d.get('agents') or {}
    if not isinstance(agents, dict):
        return None
    key = _canonical_agent_key(name, config_path)
    if not key:
        return None
    row = agents.get(key)
    if not isinstance(row, dict):
        row = {}
    ap = row.get('api_port')
    if isinstance(ap, int) and ap > 0:
        return ap
    if isinstance(ap, float) and ap > 0:
        return int(ap)
    if isinstance(ap, str) and ap.strip().isdigit():
        return int(ap.strip())
    names = agent_names(config_path)
    try:
        idx = names.index(key)
    except ValueError:
        return None
    return _base_api_port(d) + idx


def agent_names(config_path: Path) -> list[str]:
    """Canonical landfolk bot names from ``agents`` keys (insertion order)."""
    d = load_config(config_path)
    agents = d.get('agents') or {}
    if not isinstance(agents, dict):
        return []
    out: list[str] = []
    for name in agents:
        if isinstance(name, str) and name.strip():
            out.append(name.strip())
    return out


def roster_lines(config_path: Path) -> list[str]:
    """start-landfolk.sh: name:role:model per agents.* that define ``role`` (dict key order)."""
    d = load_config(config_path)
    roster = d.get('landfolk_roster')
    if isinstance(roster, list) and roster:
        lines: list[str] = []
        for row in roster:
            if not isinstance(row, dict):
                continue
            n = row.get('name')
            r = row.get('role')
            m = row.get('model')
            if (
                isinstance(n, str)
                and n.strip()
                and isinstance(r, str)
                and r.strip()
                and isinstance(m, str)
                and m.strip()
            ):
                lines.append(f"{n.strip()}:{r.strip()}:{m.strip()}")
        return lines

    defaults = d.get('defaults') or {}
    if not isinstance(defaults, dict):
        defaults = {}
    default_model = _string(defaults, 'model')
    agents = d.get('agents') or {}
    if not isinstance(agents, dict):
        return []
    out: list[str] = []
    for name, row in agents.items():
        if not isinstance(name, str) or not name.strip():
            continue
        if not isinstance(row, dict):
            continue
        role = _string(row, 'role')
        if not role:
            continue
        model = _string(row, 'model') or default_model
        if not model:
            continue
        out.append(f"{name.strip()}:{role}:{model}")
    return out


def default_config_path() -> Path:
    here = Path(__file__).resolve()
    repo_root = here.parent.parent
    return repo_root / 'data' / 'agent-models.json'


def _config_path(argv_tail: list[str]) -> Path:
    cfg_arg = argv_tail[0] if argv_tail else os.environ.get('AGENT_MODELS_JSON', '')
    if cfg_arg:
        return Path(cfg_arg).expanduser()
    return default_config_path()


def usage() -> None:
    sys.stderr.write(
        'Usage:\n'
        '  resolve-agent-model.py <AgentName> model|provider [config-path]\n'
        '  resolve-agent-model.py defaults model|provider [config-path]\n'
        '  resolve-agent-model.py entrypoint <key> model|provider [config-path]\n'
        '  resolve-agent-model.py roster-lines [config-path]\n'
        '  resolve-agent-model.py agent-names [config-path]\n'
        '  resolve-agent-model.py api-port <AgentName> [config-path]\n'
        '  resolve-agent-model.py example <key> [config-path]\n',
    )


def main() -> None:
    argv = sys.argv[1:]
    if not argv:
        usage()
        sys.exit(2)

    if argv[0] == 'agent-names':
        path = _config_path(argv[1:2])
        names = agent_names(path)
        if not names:
            sys.stderr.write(
                'resolve-agent-model: agent-names empty — add an "agents" object with '
                'at least one entry in '
                + str(path)
                + '\n',
            )
            sys.exit(3)
        print('\n'.join(names))
        return

    if argv[0] == 'api-port':
        if len(argv) < 2:
            usage()
            sys.exit(2)
        path = _config_path(argv[2:3])
        port = resolve_api_port(argv[1], path)
        if port is None:
            sys.stderr.write(
                'resolve-agent-model: unknown agent '
                + repr(argv[1])
                + ' in '
                + str(path)
                + '\n',
            )
            sys.exit(3)
        print(port, end='')
        return

    if argv[0] == 'roster-lines':
        path = _config_path(argv[1:2])
        lines = roster_lines(path)
        if not lines:
            sys.stderr.write(
                'resolve-agent-model: roster-lines empty — add agents with a '
                '"role" field, or legacy landfolk_roster, in '
                + str(path)
                + '\n',
            )
            sys.exit(3)
        print('\n'.join(lines))
        return

    if len(argv) < 2:
        usage()
        sys.exit(2)

    if argv[0] == 'example':
        if len(argv) < 2:
            usage()
            sys.exit(2)
        path = _config_path(argv[2:3])
        d = load_config(path)
        ex = d.get('examples') or {}
        if not isinstance(ex, dict):
            ex = {}
        key = argv[1]
        v = ex.get(key)
        if not isinstance(v, str) or not v.strip():
            sys.stderr.write(
                f'resolve-agent-model: missing examples.{key!r} in {path}\n',
            )
            sys.exit(3)
        print(v.strip(), end='')
        return

    if argv[0] == 'defaults':
        field = argv[1]
        path = _config_path(argv[2:3])
        out = resolve_defaults(field, path)
        if not out:
            sys.stderr.write(
                f'resolve-agent-model: missing defaults.{field} in {path} '
                '(and no HERMES_MODEL/MODEL/HERMES_PROVIDER/PROVIDER)\n',
            )
            sys.exit(3)
        print(out, end='')
        return

    if argv[0] == 'entrypoint':
        if len(argv) < 3:
            usage()
            sys.exit(2)
        key = argv[1]
        field = argv[2]
        path = _config_path(argv[3:4])
        out = resolve_entrypoint(key, field, path)
        if not out:
            sys.stderr.write(
                f'resolve-agent-model: missing defaults.{field} in {path} '
                f'(entrypoints.{key} optional)\n',
            )
            sys.exit(3)
        print(out, end='')
        return

    name = argv[0]
    field = argv[1]
    path = _config_path(argv[2:3])
    out = resolve_agent(name, field, path)
    if not out:
        sys.stderr.write(
            f'resolve-agent-model: unresolved {field} for agent {name!r} ({path})\n',
        )
        sys.exit(3)
    print(out, end='')


if __name__ == '__main__':
    main()
