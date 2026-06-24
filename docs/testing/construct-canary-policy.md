# Construct arena canary policy

[`tests/functional/building/test_construct_scoped.py`](../../tests/functional/building/test_construct_scoped.py)
remains on the **fast functional** profile until construct HTTP+world canary is
retired (see [`docs/architecture/construct-canary.md`](../architecture/construct-canary.md)).

Node mirrors (`bot/test/runtime/construct-*.test.js`, `construct-handler-filter.test.js`,
`construct-contract.test.js`, `http-app.test.js`) cover gates, handler filters, begin
error envelopes, and task-context lifecycle HTTP. They do **not** replace death/reconnect
(F2), wet-site prep after RCON, or the full scenario A place/end gate path in-world.

Track D2 parity audit: [`construct-node-arena-parity.md`](construct-node-arena-parity.md).

Do not delete the arena module without explicit product sign-off.

Run spot checks with construct env flags documented in construct-canary.md and Gate 2
(`pytest tests/functional/building/test_construct_scoped.py -x` after `restart-tester.sh`).
