# Construct arena canary policy

[`tests/functional/building/test_construct_scoped.py`](../../tests/functional/building/test_construct_scoped.py)
remains on the **fast functional** profile until construct HTTP+world canary is
retired (see [`docs/architecture/construct-canary.md`](../architecture/construct-canary.md)).

Node mirrors (`bot/test/runtime/construct-*.test.js`, `construct-handler-filter.test.js`)
cover gates and workset filtering; they do **not** replace death/session teardown or
live scoping in-world. Do not delete the arena module without explicit product sign-off.

Run spot checks with construct env flags documented in construct-canary.md and Gate 2
(`pytest tests/functional/building/test_construct_scoped.py -x` after `restart-tester.sh`).
