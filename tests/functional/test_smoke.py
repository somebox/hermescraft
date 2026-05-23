"""Placeholder for the functional tier. Real tests land here in Round 3.

The marker on the test below ensures pytest's `-m functional` collection works.
The test is skipped by default (no live bot expected during foundation work).
"""

import pytest


@pytest.mark.functional
@pytest.mark.skip(reason="placeholder — real functional tests land in Round 3")
def test_functional_marker_works(bot):
    """Sanity check that the `bot` fixture is reachable. Skipped by default."""
    bot.ensure_connected(reconnect_timeout=5)
