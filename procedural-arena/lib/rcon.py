"""Batched rcon over ssh+docker — one round-trip per batch."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Iterable

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def _load_hermes_config() -> dict:
    import importlib.util

    cfg_path = REPO_ROOT / "tests" / "_lib" / "config.py"
    spec = importlib.util.spec_from_file_location("hermes_config", cfg_path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod.load_config()


class ProceduralRcon:
    """Config-driven batched rcon (mirrors tests/_lib/rcon.py batch semantics)."""

    def __init__(self, config: dict | None = None, *, dry_run: bool = False):
        self.config = config or _load_hermes_config()
        self.dry_run = dry_run
        rcon = self.config["rcon"]
        if rcon.get("mode", "ssh") != "ssh":
            raise NotImplementedError(f"rcon.mode={rcon.get('mode')!r} not supported")
        self.ssh_host = rcon["ssh_host"]
        self.container = rcon["docker_container"]
        self.cli = rcon["cli"]
        self.command_timeout = float(rcon.get("command_timeout_s", 20))
        self.batch_timeout = float(rcon.get("batch_timeout_s", 60))
        self.ssh_multiplex = bool(rcon.get("ssh_multiplex", True))
        self._cm_path = f"/tmp/hermes-rcon-cm-{os.getuid()}-%h-%p-%r"
        self.planned_commands: list[str] = []

    def _argv(self) -> list[str]:
        base = ["ssh"]
        if self.ssh_multiplex:
            base += [
                "-o",
                "ControlMaster=auto",
                "-o",
                f"ControlPath={self._cm_path}",
                "-o",
                "ControlPersist=30m",
                "-o",
                "ServerAliveInterval=60",
            ]
        return base + [self.ssh_host, "sudo", "docker", "exec", "-i", self.container, self.cli]

    def run(self, cmd: str) -> str:
        if self.dry_run:
            self.planned_commands.append(cmd)
            return f"[dry-run] {cmd}"
        result = subprocess.run(
            self._argv(),
            input=cmd + "\n",
            capture_output=True,
            text=True,
            timeout=self.command_timeout,
        )
        return (result.stdout or "") + (result.stderr or "")

    def run_batch(
        self,
        cmds: Iterable[str],
        *,
        timeout_s: float | None = None,
        chunk_size: int = 800,
    ) -> str:
        """Run commands in one or more stdin batches (chunked for stability)."""
        cmds = list(cmds)
        if not cmds:
            return ""
        if self.dry_run:
            self.planned_commands.extend(cmds)
            return "\n".join(f"[dry-run] {c}" for c in cmds)

        if timeout_s is None:
            timeout_s = max(self.batch_timeout, min(600.0, len(cmds) * 0.15))

        combined: list[str] = []
        for i in range(0, len(cmds), chunk_size):
            chunk = cmds[i : i + chunk_size]
            payload = "\n".join(chunk) + "\n"
            result = subprocess.run(
                self._argv(),
                input=payload,
                capture_output=True,
                text=True,
                timeout=timeout_s,
            )
            combined.append(result.stdout or "")
            if result.returncode != 0 and os.environ.get("PROC_ARENA_RCON_STRICT"):
                raise RuntimeError(
                    f"rcon batch failed rc={result.returncode}: {(result.stderr or '')[:500]}"
                )
        return "\n".join(combined)

    def strip_ansi(self, text: str) -> str:
        return _ANSI_RE.sub("", text)

    def remove_world_data_dir(self, world: str) -> None:
        """Remove /data/<world> in the MC container (proc-* arenas only)."""
        if not world.startswith("proc-"):
            raise ValueError(f"refusing to rm data dir for {world!r}")
        if self.dry_run:
            self.planned_commands.append(f"[rm-data] /data/{world}")
            return
        subprocess.run(
            [
                "ssh",
                *(
                    [
                        "-o",
                        "ControlMaster=auto",
                        "-o",
                        f"ControlPath={self._cm_path}",
                        "-o",
                        "ControlPersist=30m",
                    ]
                    if self.ssh_multiplex
                    else []
                ),
                self.ssh_host,
                "sudo",
                "docker",
                "exec",
                self.container,
                "rm",
                "-rf",
                f"/data/{world}",
            ],
            capture_output=True,
            text=True,
            timeout=self.command_timeout,
            check=True,
        )
