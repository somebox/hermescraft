import pytest

from mapcatalog.proc_state import read_state, seed_matches_loaded, state_path, write_state


@pytest.mark.unit
def test_proc_state_roundtrip(tmp_path, monkeypatch):
    import mapcatalog.proc_state as ps

    monkeypatch.setattr(ps, "state_path", lambda: tmp_path / "state.json")
    write_state(world_name="proc-lab", seed="800", requirements_id="smoke")
    assert seed_matches_loaded("proc-lab", "800")
    assert not seed_matches_loaded("proc-lab", "801")
    st = read_state()
    assert st["seed"] == "800"
