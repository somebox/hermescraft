# Dashboard nav trails (Phase E partial)

**Shipped:** volatile in-session crumbs only.

- Bot: `GET /nav-trail` returns `navTrailCrumbsNewestFirst` from `bot/lib/runtime/nav-trail.js` (cleared on teleport, respawn, reconnect).
- Dashboard: `GET /api/agent/<name>/trail` proxies the bot; Ops map **trails** toggle draws polylines per online agent.

**Not shipped:** persisting crumbs to disk or cross-cycle trail replay. See [route-precompute-context.md](../nav/route-precompute-context.md).
