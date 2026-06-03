"""Tests for scripts/patch-landfolk-compression-config.py."""

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PATCH = REPO / "scripts" / "patch-landfolk-compression-config.py"


def _load():
    spec = importlib.util.spec_from_file_location("patch_lfc", PATCH)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


class TestPatchLandfolkCompression(unittest.TestCase):
    def test_landfolk_runtime_layout(self):
        mod = _load()
        sample = """model:
  default: deepseek/deepseek-v4-flash
  provider: openrouter
compression:
  enabled: true
  threshold: 0.5
  target_ratio: 0.2
  protect_last_n: 20
auxiliary:
  compression:
    provider: auto
    model: ''
"""
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "config.yaml"
            path.write_text(sample)
            self.assertTrue(mod.patch_config(path))
            text = path.read_text()
            self.assertIn("context_length: 250000", text)
            self.assertIn("threshold: 0.7", text)
            self.assertIn("target_ratio: 0.3", text)
            # Aux model comes from data/agent-models.json — follow the module
            # constant so this stays green when the JSON model is updated.
            self.assertIn(f'model: "{mod.AUX_COMPRESSION_MODEL}"', text)
            aux = text.split("auxiliary:", 1)[1]
            self.assertRegex(aux, r'provider:\s*"?openrouter"?')


if __name__ == "__main__":
    unittest.main()
