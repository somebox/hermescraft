"""Load data/scenarios/registry.yaml and drive pool lint/refresh."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


def repo_root() -> Path:
    here = Path(__file__).resolve()
    for p in [here.parent, *here.parents]:
        if (p / "data" / "scenarios" / "registry.yaml").is_file():
            return p
    return here.parent.parent


@dataclass
class ScenarioVariant:
    id: str
    requirements_path: Path
    catalog_dir: Path
    solutions: int | None = None
    max_seeds: int | None = None
    topic: str = ""
    terrain: str = ""
    tags: list[str] = field(default_factory=list)
    legacy_id: str | None = None
    agent_test_ref: str | None = None

    @property
    def setting(self) -> str:
        """Legacy v1 registry field; v2 uses topic."""
        return self.topic


@dataclass
class ScenarioRegistry:
    path: Path
    defaults_server: Path
    default_solutions: int
    default_max_seeds: int
    variants: list[ScenarioVariant]
    version: int = 2


def _append_variant(
    variants: list[ScenarioVariant],
    root: Path,
    *,
    vid: str,
    topic: str,
    terrain: str,
    entry: dict[str, Any],
    defaults_find: dict[str, Any],
) -> None:
    req = Path(str(entry["requirements"]))
    if not req.is_absolute():
        req = (root / req).resolve()
    cat = Path(str(entry["catalog"]))
    if not cat.is_absolute():
        cat = (root / cat).resolve()
    find = entry.get("find") or {}
    tags = [str(t) for t in entry.get("tags") or []]
    variants.append(
        ScenarioVariant(
            id=vid,
            requirements_path=req,
            catalog_dir=cat,
            solutions=int(find["solutions"]) if "solutions" in find else None,
            max_seeds=int(find["max_seeds"]) if "max_seeds" in find else None,
            topic=topic,
            terrain=terrain,
            tags=tags,
            legacy_id=entry.get("legacy_variant_id"),
            agent_test_ref=entry.get("agent_test_ref"),
        )
    )


def load_registry(path: Path | None = None) -> ScenarioRegistry:
    root = repo_root()
    reg_path = path or (root / "data" / "scenarios" / "registry.yaml")
    with reg_path.open(encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    defaults = raw.get("defaults") or {}
    find_def = defaults.get("find") or {}
    server = Path(str(defaults.get("server", "./server.local.yaml")))
    if not server.is_absolute():
        server = (root / server).resolve()

    version = int(raw.get("version", 1))
    variants: list[ScenarioVariant] = []

    if version >= 2 and raw.get("topics"):
        smoke = raw.get("smoke") or {}
        if smoke.get("requirements"):
            _append_variant(
                variants,
                root,
                vid=str(smoke.get("id", "smoke")),
                topic="smoke",
                terrain="map_engine",
                entry=smoke,
                defaults_find=find_def,
            )
        for topic_name, topic in (raw.get("topics") or {}).items():
            for t in topic.get("terrains") or []:
                tid = str(t["id"])
                vid = f"{topic_name}.{tid}"
                _append_variant(
                    variants,
                    root,
                    vid=vid,
                    topic=str(topic_name),
                    terrain=tid,
                    entry=t,
                    defaults_find=find_def,
                )
    else:
        for setting_name, setting in (raw.get("settings") or {}).items():
            for v in setting.get("variants") or []:
                req = Path(str(v["requirements"]))
                if not req.is_absolute():
                    req = (root / req).resolve()
                cat = Path(str(v["catalog"]))
                if not cat.is_absolute():
                    cat = (root / cat).resolve()
                find = v.get("find") or {}
                variants.append(
                    ScenarioVariant(
                        id=str(v["id"]),
                        requirements_path=req,
                        catalog_dir=cat,
                        solutions=int(find["solutions"]) if "solutions" in find else None,
                        max_seeds=int(find["max_seeds"]) if "max_seeds" in find else None,
                        topic=str(setting_name),
                        terrain="",
                        tags=[str(x) for x in v.get("tags") or []],
                        legacy_id=v.get("legacy_id"),
                        agent_test_ref=v.get("agent_test_ref"),
                    )
                )

    return ScenarioRegistry(
        path=reg_path,
        defaults_server=server,
        default_solutions=int(find_def.get("solutions", 3)),
        default_max_seeds=int(find_def.get("max_seeds", 80)),
        variants=variants,
        version=version,
    )


def variant_by_id(reg: ScenarioRegistry, variant_id: str) -> ScenarioVariant | None:
    for v in reg.variants:
        if v.id == variant_id:
            return v
        if v.legacy_id and v.legacy_id == variant_id:
            return v
    return None


def resolve_find_limits(v: ScenarioVariant, reg: ScenarioRegistry) -> tuple[int, int]:
    from mapcatalog.load import load_requirements

    req = load_requirements(v.requirements_path)
    sol = v.solutions if v.solutions is not None else req.find.solutions
    mx = v.max_seeds if v.max_seeds is not None else req.find.max_seeds
    return sol, mx
