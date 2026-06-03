"""P0-5a: hook and bot-server share config/orchestrator-mc-allowlist.json."""

import json
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ALLOWLIST = REPO / "config" / "orchestrator-mc-allowlist.json"
HOOK = REPO / "scripts" / "hermes-hooks" / "orchestrator-deny.sh"
BOT_GATE = REPO / "bot" / "lib" / "server" / "middleware" / "orchestrator-mc-allowlist.js"


class TestOrchestratorAllowlistSync(unittest.TestCase):
    def test_bot_module_loads_shared_json(self):
        text = BOT_GATE.read_text()
        self.assertIn("orchestrator-mc-allowlist.json", text)
        doc = json.loads(ALLOWLIST.read_text())
        self.assertGreaterEqual(len(doc.get("allowed_verbs") or []), 10)

    def test_hook_allows_every_json_verb(self):
        if not HOOK.is_file():
            self.skipTest("hook missing")
        doc = json.loads(ALLOWLIST.read_text())
        for verb in doc["allowed_verbs"]:
            payload = json.dumps(
                {
                    "hook_event_name": "pre_tool_call",
                    "tool_name": "terminal",
                    "tool_input": {"command": f"mc {verb}"},
                }
            )
            proc = subprocess.run(
                [str(HOOK)],
                input=payload,
                capture_output=True,
                text=True,
                check=False,
            )
            out = json.loads(proc.stdout or "{}")
            self.assertNotEqual(
                out.get("decision"),
                "block",
                f"mc {verb} should be allowed; got {out}",
            )

    def test_hook_blocks_run8_field_verbs_not_in_allowlist(self):
        if not HOOK.is_file():
            self.skipTest("hook missing")
        denied = [
            "tunnel",
            "level",
            "dig",
            "collect",
            "move",
            "goto_near",
            "pillar_up",
        ]
        for verb in denied:
            payload = json.dumps(
                {
                    "hook_event_name": "pre_tool_call",
                    "tool_name": "terminal",
                    "tool_input": {"command": f"mc {verb}"},
                }
            )
            proc = subprocess.run(
                [str(HOOK)],
                input=payload,
                capture_output=True,
                text=True,
                check=False,
            )
            out = json.loads(proc.stdout or "{}")
            self.assertEqual(
                out.get("decision"),
                "block",
                f"mc {verb} must be blocked; got {out}",
            )


if __name__ == "__main__":
    unittest.main()
