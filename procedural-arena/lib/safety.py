"""World name guards — never touch production or pytest arenas."""

from __future__ import annotations

FORBIDDEN_WORLDS = frozenset({"world", "world_nether", "world_the_end", "landfolk-test", "testflat"})


def assert_safe_world_name(world: str, *, allow_unsafe: bool = False) -> None:
    if allow_unsafe:
        return
    if world in FORBIDDEN_WORLDS:
        raise ValueError(f"refusing to operate on forbidden world {world!r}")
    if not world.startswith("proc-"):
        raise ValueError(
            f"world name {world!r} must start with 'proc-' "
            "(pass --i-know-what-im-doing to override)"
        )
