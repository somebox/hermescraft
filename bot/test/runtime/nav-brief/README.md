# nav-brief test slices

`nav-brief-*.test.js` files in the parent `runtime/` directory each lock one rendering or enrichment behavior (confined space, stale dig hints, route hints, copy-paste blocks, etc.). They share conventions with `observation-nav-payload.test.js` but intentionally keep local fixtures to avoid a large shared harness.

When adding a case, prefer extending the file that already covers the same payload field rather than growing `nav-brief.test.js` without cause.
