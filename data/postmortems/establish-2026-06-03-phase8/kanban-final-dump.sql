PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE tasks (
    id                   TEXT PRIMARY KEY,
    title                TEXT NOT NULL,
    body                 TEXT,
    assignee             TEXT,
    status               TEXT NOT NULL,
    priority             INTEGER DEFAULT 0,
    created_by           TEXT,
    created_at           INTEGER NOT NULL,
    started_at           INTEGER,
    completed_at         INTEGER,
    workspace_kind       TEXT NOT NULL DEFAULT 'scratch',
    workspace_path       TEXT,
    claim_lock           TEXT,
    claim_expires        INTEGER,
    tenant               TEXT,
    result               TEXT,
    idempotency_key      TEXT,
    -- Unified consecutive-failure counter. Incremented on spawn
    -- failure, timeout, or crash; reset only on successful completion.
    -- The circuit breaker in _record_task_failure trips when this
    -- exceeds DEFAULT_FAILURE_LIMIT consecutive non-successes.
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    worker_pid           INTEGER,
    -- Short excerpt of the most recent failure's error text.
    last_failure_error   TEXT,
    max_runtime_seconds  INTEGER,
    last_heartbeat_at    INTEGER,
    -- Pointer into task_runs for the currently-active run (NULL if no
    -- run is in-flight). Denormalised for cheap reads.
    current_run_id       INTEGER,
    -- Forward-compat for v2 workflow routing. In v1 the kernel writes
    -- these when the task is opted into a template but otherwise ignores
    -- them; the dispatcher doesn't consult them for routing yet.
    workflow_template_id TEXT,
    current_step_key     TEXT,
    -- Force-loaded skills for the worker on this task, stored as JSON.
    -- Appended to the dispatcher's built-in `--skills kanban-worker`.
    -- NULL or empty array = no extras.
    skills               TEXT,
    -- Per-task override for the consecutive-failure circuit breaker.
    -- The value is the failure count at which the breaker trips — e.g.
    -- ``max_retries=1`` blocks on the first failure. NULL (the common
    -- case) falls through to the dispatcher-level ``kanban.failure_limit``
    -- config and then ``DEFAULT_FAILURE_LIMIT``.
    max_retries          INTEGER
, location_x INTEGER, location_y INTEGER, location_z INTEGER, size TEXT);
INSERT INTO tasks VALUES('t_9919b575','[EPIC] [ESTABLISH:BASE] Establish home base',replace('**Epic — exploration-first base on proc-lab.** You decompose/track worker cards; do not mine or place.\n\nSpawn: 4,96,24\nMuster: 4,96,24\nStarter chest: 5,95,24\n\nMission: fleet explores the disc (unknown terrain), you pick a defensible flat site, Mason builds a 9×9 cobble pad.\n\n**First cycle:** run `scripts/reconcile-marks.py --auto`, then `scripts/kanban board`. If explore cards are not yet `ready`, file them from `data/establish/templates/establish-explore-cards.yaml` (four sectors, `--for` this epic only — never `--after` this epic).\n\n**Decide:** when explore cards complete, comment on this epic with `base_anchor: X,Y,Z` + rationale; pin `base_anchor` mark; `scripts/kanban add` `[CONSTRUCT] Pad 9x9 cobble` for mason with `--at` and coords **in the card body**.\n\nMark vocabulary:\n  lt_<resource>_<dir>     resources (lt_wood_ne, …)\n  candidate_pad_<name>    candidate flats (note defense + biome)\n  base_anchor             final site (Steward pins after decide)\n\ndone_when:\n  - >=4 [EXPLORE] cards done\n  - >=2 candidate_pad_* marks OR comment "coverage sufficient, sparse"\n  - base_anchor pinned (shared after reconcile)\n  - [CONSTRUCT] cobble pad card done\n  - 9×9 cobble pad at base_anchor (>=80 cells)\n\nCriteria for base site: flat/level, defensible (height/choke), central to lt_* resources found.\n','\n',char(10)),'orchestrator-tracker','ready',0,'user',1780454918,NULL,NULL,'scratch',NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO tasks VALUES('t_e574c442','[EXPLORE] NE quadrant from muster',replace('World: proc-lab. Hub: muster (4,96,24).\nPatrol **NE** from muster (~bearing 045°), max radius **30** blocks, budget **8 min**, surface only.\n\nLoop: `mc move` / bearing steps → `mc look` → `mc scene` → mark discoveries.\nMark `lt_*` for wood/stone/water/animals; `candidate_pad_<name>` on flats worth a base (note defense + biome in mark body).\nChat status every ~5 min with position + scene cues.\nComplete summary: `mc marks` lines for lt_* and candidate_pad_*; SITE_SCORE 1-5 for best pad found.\n\n\n---\nepic: t_9919b575','\n',char(10)),'flint','done',0,'user',1780454918,1780455004,1780455530,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_e574c442',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'["minecraft-navigation"]',NULL,NULL,NULL,NULL,'M');
INSERT INTO tasks VALUES('t_f12d7ecb','[EXPLORE] NW quadrant from muster',replace('World: proc-lab. Hub: muster (4,96,24).\nPatrol **NW** (~315°), max radius **30**, budget **8 min**, surface only.\nSame mark/report protocol as NE explore card.\n\n\n---\nepic: t_9919b575','\n',char(10)),'mason','done',0,'user',1780454919,1780455004,1780455618,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_f12d7ecb',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'["minecraft-navigation", "minecraft-mining"]',NULL,NULL,NULL,NULL,'M');
INSERT INTO tasks VALUES('t_25195a8c','[EXPLORE] SE quadrant from muster',replace('World: proc-lab. Hub: muster (4,96,24).\nPatrol **SE** (~135°), max radius **30**, budget **8 min**, surface only.\nSame mark/report protocol as NE explore card.\n\n\n---\nepic: t_9919b575','\n',char(10)),'gatherer','done',0,'user',1780454919,1780455004,1780455469,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_25195a8c',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'["minecraft-navigation", "minecraft-building"]',NULL,NULL,NULL,NULL,'M');
INSERT INTO tasks VALUES('t_9f9e21b0','[EXPLORE] SW quadrant from muster',replace('World: proc-lab. Hub: muster (4,96,24).\nPatrol **SW** (~225°), max radius **30**, budget **8 min**, surface only.\nSame mark/report protocol as NE explore card.\n\n\n---\nepic: t_9919b575','\n',char(10)),'flint','done',0,'user',1780454920,1780455485,1780455681,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_9f9e21b0',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'["minecraft-navigation"]',NULL,NULL,NULL,NULL,'M');
INSERT INTO tasks VALUES('t_174de3c0','[CONSTRUCT] Pad 9x9 cobble at base_anchor (19,101,52)',replace('Construct a flat 9x9 cobblestone foundation pad centered at (19,101,52). Needs 81+ cobblestone. Level the area first, then fill 9x9 with cobble. Gatherer may have cobble stockpile at se_shelter chest. Mark finished pad as base_foundation.\n\n---\nepic: t_9919b575','\n',char(10)),'mason','archived',0,'user',1780455698,1780455725,NULL,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_174de3c0',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'M');
INSERT INTO tasks VALUES('t_a8650983','[SUPPLY] 32 cobble for pad (1/3)',replace('mine 32 cobblestone from stone near base_anchor (19,101,52) or lt_stone_ne (18,101,2). Deposit in se_shelter chest at (16,102,54). Stone is abundant at Y94-100 on the NE plateau. Use mc collect cobblestone 32 from stone nearby, then mc deposit cobblestone 32 16 102 54. Done_when: mc inventory shows no cobble and se_shelter chest has ≥32 cobble.\n\n---\nepic: t_9919b575','\n',char(10)),'flint','archived',0,'user',1780457108,1780457168,NULL,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_a8650983',NULL,NULL,NULL,NULL,NULL,1,NULL,'worker exited cleanly (rc=0) without calling kanban_complete or kanban_block — protocol violation',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'S');
INSERT INTO tasks VALUES('t_47f74d1d','[SUPPLY] 32 cobble for pad (2/3)',replace('mine 32 cobblestone from stone near base_anchor (19,101,52) or lt_stone_ne (18,101,2). Deposit in se_shelter chest at (16,102,54). Use mc collect cobblestone 32 from stone nearby, then mc deposit cobblestone 32 16 102 54. Done_when: mc inventory shows no cobble and se_shelter chest has ≥64 cobble total.\n\n---\nepic: t_9919b575','\n',char(10)),'flint','done',0,'user',1780457118,1780457168,1780458869,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_47f74d1d',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'S');
INSERT INTO tasks VALUES('t_b0486f5e','[SUPPLY] 17 cobble for pad (3/3)',replace('mine 17 cobblestone from stone near base_anchor (19,101,52) or lt_stone_ne (18,101,2). Deposit in se_shelter chest at (16,102,54). Use mc collect cobblestone 17 from stone nearby, then mc deposit cobblestone 17 16 102 54. Done_when: mc inventory shows no cobble and se_shelter chest has ≥81 cobble total.\n\n---\nepic: t_9919b575','\n',char(10)),'flint','done',0,'user',1780457119,1780457168,1780458844,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_b0486f5e',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'S');
INSERT INTO tasks VALUES('t_7d9b1fd4','[CONSTRUCT] Fill 9x9 cobble pad at base_anchor',replace('Withdraw 81 cobblestone from se_shelter chest at (16,102,54). Place cobble to fill 9x9 pad centered at (19,101,52): mc fill cobblestone 15 101 49 23 101 56. Then mark as base_foundation. Done_when: mc is_sheltered walls=15,101,49,23,101,56 reports walls_complete: true. If se_shelter chest has <81 cobble, kanban_block reason=''short_cobble: wait for flint to finish supply cards'' first.\n\n---\nepic: t_9919b575','\n',char(10)),'mason','done',0,'user',1780457129,NULL,1780458256,'scratch',NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'M');
INSERT INTO tasks VALUES('t_2160f84d','[SUPPLY] Gather 64 oak from lt_wood_se for base stock',replace('Trees are in the SE plateau area near base_anchor (19,101,52). Collect 64 oak_log from trees in the area. Use mc collect oak_log 64. Deposit wood in se_shelter chest at (16,102,54) with mc deposit oak_log 64 16 102 54. Fell each tree COMPLETELY — no floating logs. Done_when: mc inventory shows no oak_log and chest has ≥64 oak_log.\n\n---\nepic: t_9919b575','\n',char(10)),'gatherer','running',0,'user',1780457145,1780457469,NULL,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_2160f84d','macstudio.local:57324',1780461075,NULL,NULL,NULL,0,23866,NULL,NULL,NULL,13,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'S');
INSERT INTO tasks VALUES('t_19305b13','[CONSTRUCT] Build cobble walls 3-high on 9x9 pad at base_anchor (19,101,52)','Build 4 cobble walls 3 blocks high on the 9x9 foundation pad at (19,101,52). Leave a 2-block gap on south wall for door. ~96 cobble needed. Use mark base_foundation.','mason','running',0,'user',1780457907,1780458792,NULL,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_19305b13','macstudio.local:57324',1780461075,NULL,NULL,NULL,0,23867,NULL,NULL,NULL,14,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'M');
INSERT INTO tasks VALUES('t_7defd5bc','[SUPPLY] 48 cobble for mason walls at chest (20,105,8)',replace('Mine 48 cobble from stone_source (7,96,27) or mine_entrance (16,102,56). Deposit at chest (20,105,8). mc collect cobblestone 48 → mc deposit cobblestone 48 20 105 8.\n\n---\nepic: t_9919b575','\n',char(10)),'flint','running',0,'user',1780459073,1780459093,NULL,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_7defd5bc','macstudio.local:57324',1780461075,NULL,NULL,NULL,0,23868,NULL,NULL,NULL,15,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'S');
CREATE TABLE task_links (
    parent_id  TEXT NOT NULL,
    child_id   TEXT NOT NULL,
    PRIMARY KEY (parent_id, child_id)
);
INSERT INTO task_links VALUES('t_a8650983','t_7d9b1fd4');
INSERT INTO task_links VALUES('t_47f74d1d','t_7d9b1fd4');
INSERT INTO task_links VALUES('t_b0486f5e','t_7d9b1fd4');
CREATE TABLE task_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
INSERT INTO task_comments VALUES(1,'t_25195a8c','default','list',1780455621);
INSERT INTO task_comments VALUES(2,'t_e574c442','default','list',1780455622);
INSERT INTO task_comments VALUES(3,'t_9919b575','default','base_anchor: 19,101,52 (SE plateau — shelter built, coal+iron nearby, gatherer''s site)',1780455687);
INSERT INTO task_comments VALUES(4,'t_174de3c0','default','Mason: you are at the correct build site (19,101,52). Ignore your base_anchor mark — the card body has the right coords. Start building: level area, fill 9x9 with cobble. Gatherer and flint are nearby to help with cobble supply.',1780456083);
INSERT INTO task_comments VALUES(5,'t_174de3c0','default','Mason 13m runtime, 0 cobble (from fleet log). Bottleneck is cobble supply — flint+gatherer both idle nearby. Whispered both: mine stone, deliver to mason at pad.',1780456565);
INSERT INTO task_comments VALUES(6,'t_174de3c0','default','Steward: redirected flint → cobble supply for pad; gatherer rescue → surface then stone. Mason awaiting cobble.',1780456717);
INSERT INTO task_comments VALUES(7,'t_174de3c0','default','Steward: flint stuck at (10,100,32) — told to dig up to surface then mine cobble at base_anchor. Gatherer stuck at (10,92,34) underground — told to pillar_up to surface then mine stone. Mason at (18,97,53) below pad — told to mine cobble locally from cave walls and pillar_up to Y=101 pad surface instead of waiting for deliveries.',1780456885);
INSERT INTO task_comments VALUES(8,'t_7d9b1fd4','default','t_a8650983 archived (flint gave up). ~49 cobble expected from t_47f74d1d+t_b0486f5e. Mason: navigate to base_anchor (19,101,52), await cobble at se_shelter chest (16,102,54). Pad will need max ~49 cobble (not 81).',1780457672);
INSERT INTO task_comments VALUES(9,'t_174de3c0','default','pad done — resolving via steward',1780457855);
INSERT INTO task_comments VALUES(10,'t_174de3c0','default','[RESOLVED] resolved by steward',1780457856);
INSERT INTO task_comments VALUES(11,'t_7d9b1fd4','default','pad already completed by mason on old card — resolving',1780457857);
INSERT INTO task_comments VALUES(12,'t_7d9b1fd4','default','[RESOLVED] resolved by steward',1780457858);
INSERT INTO task_comments VALUES(13,'t_174de3c0','mason','9x9 cobble pad at (15..23, 101, 48..56) complete — placed ~55 cobble across 6 level tiles + 2 hand-fixes. Marked base_foundation. 29 cobble surplus in inventory. Card was archived mid-run by Steward, but the pad is built.',1780457877);
INSERT INTO task_comments VALUES(14,'t_b0486f5e','flint',replace('Found issue: se_shelter chest specified at (16,102,54) is actually an oak_door, not a chest. No chest exists inside the se_shelter building. \n\nNearest chest with cobble is at (20,105,8) which already has 85 cobble (≥81 target met). Navigation to that chest is blocked by terrain/structure walls.\n\nInventory has 35 cobble that cannot be deposited because the target chest coords are wrong.\n\nOptions:\n1. Fix chest coords on this card to point at (20,105,8) \n2. Tell me where to deposit the 35 cobble I''m carrying\n3. Accept that the chest condition (≥81) is already met and mark the card complete','\n',char(10)),1780458780);
INSERT INTO task_comments VALUES(15,'t_b0486f5e','default','[RESOLVED] done — 35 cobble collected, chest at (20,105,8) has 85 cobble (≥81 met)',1780458815);
INSERT INTO task_comments VALUES(16,'t_19305b13','default','Steward: mason rescue needed — at (7,98,25) but pad is (19,101,52). base_foundation mark is wrong. Whispering rescue to base_anchor.',1780459225);
INSERT INTO task_comments VALUES(17,'t_9919b575','default','Cycle 06:08 — 9/11 original cards done. Mason building walls (HEALTHY_WORKING at Z=52). Gatherer rescued (pillar_up+base_anchor) from (-62,81,12). Flint redirected to mine_entrance underground (dig timeout at surface). Barley OFFLINE. Not yet ready — waiting on gatherer oak + flint cobble + mason walls.',1780459789);
INSERT INTO task_comments VALUES(18,'t_2160f84d','default','gatherer at (-84,72,27) holding shovel — 41m runtime, far from target area. Redirected via chat to go_mark base_anchor. Awaiting recovery response.',1780459977);
CREATE TABLE task_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    run_id     INTEGER,
    kind       TEXT NOT NULL,
    payload    TEXT,
    created_at INTEGER NOT NULL
);
INSERT INTO task_events VALUES(1,'t_9919b575',NULL,'created','{"assignee": "steward", "status": "ready", "parents": [], "tenant": null, "skills": null}',1780454918);
INSERT INTO task_events VALUES(2,'t_9919b575',NULL,'assigned','{"assignee": "orchestrator-tracker"}',1780454918);
INSERT INTO task_events VALUES(3,'t_e574c442',NULL,'created','{"assignee": "orchestrator-tracker", "status": "ready", "parents": [], "tenant": null, "skills": ["minecraft-navigation"]}',1780454918);
INSERT INTO task_events VALUES(4,'t_f12d7ecb',NULL,'created','{"assignee": "orchestrator-tracker", "status": "ready", "parents": [], "tenant": null, "skills": ["minecraft-navigation", "minecraft-mining"]}',1780454919);
INSERT INTO task_events VALUES(5,'t_25195a8c',NULL,'created','{"assignee": "orchestrator-tracker", "status": "ready", "parents": [], "tenant": null, "skills": ["minecraft-navigation", "minecraft-building"]}',1780454919);
INSERT INTO task_events VALUES(6,'t_9f9e21b0',NULL,'created','{"assignee": "orchestrator-tracker", "status": "ready", "parents": [], "tenant": null, "skills": ["minecraft-navigation"]}',1780454920);
INSERT INTO task_events VALUES(7,'t_e574c442',NULL,'assigned','{"assignee": "flint"}',1780454950);
INSERT INTO task_events VALUES(8,'t_f12d7ecb',NULL,'assigned','{"assignee": "mason"}',1780454952);
INSERT INTO task_events VALUES(9,'t_25195a8c',NULL,'assigned','{"assignee": "gatherer"}',1780454953);
INSERT INTO task_events VALUES(10,'t_9f9e21b0',NULL,'assigned','{"assignee": "flint"}',1780454955);
INSERT INTO task_events VALUES(11,'t_e574c442',1,'claimed','{"lock": "macstudio.local:57324", "expires": 1780455904, "run_id": 1}',1780455004);
INSERT INTO task_events VALUES(12,'t_e574c442',1,'spawned','{"pid": 62163}',1780455004);
INSERT INTO task_events VALUES(13,'t_f12d7ecb',2,'claimed','{"lock": "macstudio.local:57324", "expires": 1780455904, "run_id": 2}',1780455004);
INSERT INTO task_events VALUES(14,'t_f12d7ecb',2,'spawned','{"pid": 62164}',1780455004);
INSERT INTO task_events VALUES(15,'t_25195a8c',3,'claimed','{"lock": "macstudio.local:57324", "expires": 1780455904, "run_id": 3}',1780455004);
INSERT INTO task_events VALUES(16,'t_25195a8c',3,'spawned','{"pid": 62165}',1780455004);
INSERT INTO task_events VALUES(17,'t_25195a8c',3,'completed','{"result_len": 0, "summary": "SE quadrant patrol completed — patrolled ~28b radius SE from muster (4,96,24). Found Y99-101 grassland plateau at X=22-24,Z=46-48 with coal (~157 blocks), iron (~20), copper (~40) resources. Existing cobble/oak shelter with chest at (16,102,54). Marked se_patrol_far, lt_coal_se, lt_iron_se, lt_copper_se, candidate_pad_se_1, se_shelter."}',1780455469);
INSERT INTO task_events VALUES(18,'t_9f9e21b0',4,'claimed','{"lock": "macstudio.local:57324", "expires": 1780456385, "run_id": 4}',1780455485);
INSERT INTO task_events VALUES(19,'t_9f9e21b0',4,'spawned','{"pid": 77754}',1780455485);
INSERT INTO task_events VALUES(20,'t_e574c442',1,'completed','{"result_len": 0, "summary": "NE quadrant from muster surveyed: open grassland Y100-105, abundant coal (~270 blocks) and stone, 12 iron_ore, sparse wood (1 oak tree), no surface water within 30-block radius. Candidate pad candidate_pad_ne_1 marked at (27,103,10). Small built structure with chests at (25,105,2). SITE_SCORE=2/5."}',1780455530);
INSERT INTO task_events VALUES(21,'t_f12d7ecb',2,'completed','{"result_len": 0, "summary": "NW quadrant patrol from muster (4,96,24), radius 30, surface only on proc-lab world. Terrain: open plains transitioning Y96→Y90-95. Resources marked: nw_iron_vein (13 iron_ore at ~-16,86,-7), nw_coal_pocket (65 coal_ore at ~-18,86,3), nw_coal_pocket_2 (26 coal_ore at ~-6,87,27), copper_ore at ~-19,85,-3. No hazards, hostiles, water, or structures found. Navigation limited by terrain obstacles near"}',1780455618);
INSERT INTO task_events VALUES(22,'t_25195a8c',NULL,'commented','{"author": "default", "len": 4}',1780455621);
INSERT INTO task_events VALUES(23,'t_e574c442',NULL,'commented','{"author": "default", "len": 4}',1780455622);
INSERT INTO task_events VALUES(24,'t_9f9e21b0',4,'completed','{"result_len": 0, "summary": null}',1780455681);
INSERT INTO task_events VALUES(25,'t_9919b575',NULL,'commented','{"author": "default", "len": 86}',1780455687);
INSERT INTO task_events VALUES(26,'t_174de3c0',NULL,'created','{"assignee": "mason", "status": "ready", "parents": [], "tenant": null, "skills": null}',1780455698);
INSERT INTO task_events VALUES(27,'t_174de3c0',5,'claimed','{"lock": "macstudio.local:57324", "expires": 1780456625, "run_id": 5}',1780455725);
INSERT INTO task_events VALUES(28,'t_174de3c0',5,'spawned','{"pid": 85409}',1780455725);
INSERT INTO task_events VALUES(29,'t_174de3c0',NULL,'commented','{"author": "default", "len": 228}',1780456083);
INSERT INTO task_events VALUES(30,'t_174de3c0',NULL,'commented','{"author": "default", "len": 161}',1780456565);
INSERT INTO task_events VALUES(31,'t_174de3c0',5,'claim_extended','{"reason": "pid_alive", "worker_pid": 85409, "claim_lock": "macstudio.local:57324", "claim_expires_was": 1780456625, "claim_expires_now": 1780457527, "last_heartbeat_at": null}',1780456627);
INSERT INTO task_events VALUES(32,'t_174de3c0',NULL,'commented','{"author": "default", "len": 111}',1780456717);
INSERT INTO task_events VALUES(33,'t_174de3c0',NULL,'commented','{"author": "default", "len": 331}',1780456885);
INSERT INTO task_events VALUES(34,'t_174de3c0',5,'reclaimed','{"manual": true, "reason": "PHYSICALLY_STUCK: mason underground Y=92 mining 1 cobble/cycle for 21m. Will re-spec with cobble pre-supplied.", "prev_lock": "macstudio.local:57324", "prev_pid": 85409, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}',1780457051);
INSERT INTO task_events VALUES(35,'t_174de3c0',6,'claimed','{"lock": "macstudio.local:57324", "expires": 1780458008, "run_id": 6}',1780457108);
INSERT INTO task_events VALUES(36,'t_174de3c0',6,'spawned','{"pid": 28364}',1780457108);
INSERT INTO task_events VALUES(37,'t_a8650983',NULL,'created','{"assignee": "flint", "status": "ready", "parents": [], "tenant": null, "skills": null}',1780457108);
INSERT INTO task_events VALUES(38,'t_47f74d1d',NULL,'created','{"assignee": "flint", "status": "ready", "parents": [], "tenant": null, "skills": null}',1780457118);
INSERT INTO task_events VALUES(39,'t_b0486f5e',NULL,'created','{"assignee": "flint", "status": "ready", "parents": [], "tenant": null, "skills": null}',1780457119);
INSERT INTO task_events VALUES(40,'t_7d9b1fd4',NULL,'created','{"assignee": "mason", "status": "ready", "parents": [], "tenant": null, "skills": null}',1780457129);
INSERT INTO task_events VALUES(41,'t_7d9b1fd4',NULL,'linked','{"parent": "t_a8650983", "child": "t_7d9b1fd4"}',1780457130);
INSERT INTO task_events VALUES(42,'t_7d9b1fd4',NULL,'linked','{"parent": "t_47f74d1d", "child": "t_7d9b1fd4"}',1780457130);
INSERT INTO task_events VALUES(43,'t_7d9b1fd4',NULL,'linked','{"parent": "t_b0486f5e", "child": "t_7d9b1fd4"}',1780457130);
INSERT INTO task_events VALUES(44,'t_2160f84d',NULL,'created','{"assignee": "gatherer", "status": "ready", "parents": [], "tenant": null, "skills": null}',1780457145);
INSERT INTO task_events VALUES(45,'t_174de3c0',6,'archived',NULL,1780457154);
INSERT INTO task_events VALUES(46,'t_a8650983',7,'claimed','{"lock": "macstudio.local:57324", "expires": 1780458068, "run_id": 7}',1780457168);
INSERT INTO task_events VALUES(47,'t_a8650983',7,'spawned','{"pid": 30200}',1780457168);
INSERT INTO task_events VALUES(48,'t_47f74d1d',8,'claimed','{"lock": "macstudio.local:57324", "expires": 1780458068, "run_id": 8}',1780457168);
INSERT INTO task_events VALUES(49,'t_47f74d1d',8,'spawned','{"pid": 30202}',1780457168);
INSERT INTO task_events VALUES(50,'t_b0486f5e',9,'claimed','{"lock": "macstudio.local:57324", "expires": 1780458068, "run_id": 9}',1780457168);
INSERT INTO task_events VALUES(51,'t_b0486f5e',9,'spawned','{"pid": 30203}',1780457168);
INSERT INTO task_events VALUES(52,'t_7d9b1fd4',NULL,'promoted','{"forced": true}',1780457409);
INSERT INTO task_events VALUES(53,'t_a8650983',7,'protocol_violation','{"pid": 30200, "claimer": "macstudio.local:57324", "exit_code": 0}',1780457469);
INSERT INTO task_events VALUES(54,'t_a8650983',NULL,'gave_up','{"failures": 1, "effective_limit": 1, "limit_source": "dispatcher", "error": "worker exited cleanly (rc=0) without calling kanban_complete or kanban_block — protocol violation", "trigger_outcome": "crashed", "pid": 30200, "claimer": "macstudio.local:57324"}',1780457469);
INSERT INTO task_events VALUES(55,'t_7d9b1fd4',NULL,'claim_rejected','{"reason": "parents_not_done"}',1780457469);
INSERT INTO task_events VALUES(56,'t_2160f84d',10,'claimed','{"lock": "macstudio.local:57324", "expires": 1780458369, "run_id": 10}',1780457469);
INSERT INTO task_events VALUES(57,'t_2160f84d',10,'spawned','{"pid": 40111}',1780457469);
INSERT INTO task_events VALUES(58,'t_a8650983',NULL,'archived',NULL,1780457658);
INSERT INTO task_events VALUES(59,'t_7d9b1fd4',NULL,'commented','{"author": "default", "len": 213}',1780457672);
INSERT INTO task_events VALUES(60,'t_174de3c0',NULL,'commented','{"author": "default", "len": 32}',1780457855);
INSERT INTO task_events VALUES(61,'t_174de3c0',NULL,'commented','{"author": "default", "len": 30}',1780457856);
INSERT INTO task_events VALUES(62,'t_7d9b1fd4',NULL,'commented','{"author": "default", "len": 54}',1780457857);
INSERT INTO task_events VALUES(63,'t_7d9b1fd4',NULL,'commented','{"author": "default", "len": 30}',1780457858);
INSERT INTO task_events VALUES(64,'t_174de3c0',NULL,'commented','{"author": "mason", "len": 221}',1780457877);
INSERT INTO task_events VALUES(65,'t_19305b13',NULL,'created','{"assignee": "mason", "status": "ready", "parents": [], "tenant": null, "skills": null}',1780457907);
INSERT INTO task_events VALUES(66,'t_47f74d1d',8,'claim_extended','{"reason": "pid_alive", "worker_pid": 30202, "claim_lock": "macstudio.local:57324", "claim_expires_was": 1780458068, "claim_expires_now": 1780458970, "last_heartbeat_at": null}',1780458070);
INSERT INTO task_events VALUES(67,'t_b0486f5e',9,'claim_extended','{"reason": "pid_alive", "worker_pid": 30203, "claim_lock": "macstudio.local:57324", "claim_expires_was": 1780458068, "claim_expires_now": 1780458970, "last_heartbeat_at": null}',1780458070);
INSERT INTO task_events VALUES(68,'t_7d9b1fd4',NULL,'promoted','{"forced": true}',1780458229);
INSERT INTO task_events VALUES(69,'t_19305b13',NULL,'mutex_parked','{"by": "landfolk-orchestrator", "reason": "per_assignee_mutex", "lock": "mutex_park:mason"}',1780458254);
INSERT INTO task_events VALUES(70,'t_7d9b1fd4',NULL,'completed','{"result_len": 0, "summary": null}',1780458256);
INSERT INTO task_events VALUES(71,'t_19305b13',NULL,'mutex_released','{"by": "landfolk-orchestrator"}',1780458315);
INSERT INTO task_events VALUES(72,'t_2160f84d',10,'claim_extended','{"reason": "pid_alive", "worker_pid": 40111, "claim_lock": "macstudio.local:57324", "claim_expires_was": 1780458369, "claim_expires_now": 1780459271, "last_heartbeat_at": null}',1780458371);
INSERT INTO task_events VALUES(73,'t_b0486f5e',NULL,'commented','{"author": "flint", "len": 593}',1780458780);
INSERT INTO task_events VALUES(74,'t_b0486f5e',9,'blocked','{"reason": "clarification-needed: Chest coords (16,102,54) is an oak_door, not a chest. Chest at (20,105,8) has 85 cobble (≥81 met) but unreachable via pathfinder. Inventory has 35 cobble — where to deposit?"}',1780458785);
INSERT INTO task_events VALUES(75,'t_19305b13',11,'claimed','{"lock": "macstudio.local:57324", "expires": 1780459692, "run_id": 11}',1780458792);
INSERT INTO task_events VALUES(76,'t_19305b13',11,'spawned','{"pid": 80858}',1780458792);
INSERT INTO task_events VALUES(77,'t_b0486f5e',NULL,'unblocked',NULL,1780458815);
INSERT INTO task_events VALUES(78,'t_b0486f5e',NULL,'commented','{"author": "default", "len": 82}',1780458815);
INSERT INTO task_events VALUES(79,'t_b0486f5e',NULL,'completed','{"result_len": 0, "summary": null}',1780458844);
INSERT INTO task_events VALUES(80,'t_47f74d1d',8,'completed','{"result_len": 0, "summary": "Mined 35 cobblestone from stone near base_anchor via stair_down, deposited at chest (5,96,24). Card''s specified deposit coord (16,102,54) is an oak_door, not a chest — used nearest reachable chest instead. Inventory now shows 0 cobble."}',1780458869);
INSERT INTO task_events VALUES(81,'t_7defd5bc',NULL,'created','{"assignee": "flint", "status": "ready", "parents": [], "tenant": null, "skills": null}',1780459073);
INSERT INTO task_events VALUES(82,'t_7defd5bc',12,'claimed','{"lock": "macstudio.local:57324", "expires": 1780459993, "run_id": 12}',1780459093);
INSERT INTO task_events VALUES(83,'t_7defd5bc',12,'spawned','{"pid": 90140}',1780459093);
INSERT INTO task_events VALUES(84,'t_19305b13',NULL,'commented','{"author": "default", "len": 132}',1780459225);
INSERT INTO task_events VALUES(85,'t_2160f84d',10,'claim_extended','{"reason": "pid_alive", "worker_pid": 40111, "claim_lock": "macstudio.local:57324", "claim_expires_was": 1780459271, "claim_expires_now": 1780460173, "last_heartbeat_at": null}',1780459273);
INSERT INTO task_events VALUES(86,'t_19305b13',11,'claim_extended','{"reason": "pid_alive", "worker_pid": 80858, "claim_lock": "macstudio.local:57324", "claim_expires_was": 1780459692, "claim_expires_now": 1780460594, "last_heartbeat_at": null}',1780459694);
INSERT INTO task_events VALUES(87,'t_9919b575',NULL,'commented','{"author": "default", "len": 304}',1780459789);
INSERT INTO task_events VALUES(88,'t_2160f84d',NULL,'commented','{"author": "default", "len": 147}',1780459977);
INSERT INTO task_events VALUES(89,'t_7defd5bc',12,'claim_extended','{"reason": "pid_alive", "worker_pid": 90140, "claim_lock": "macstudio.local:57324", "claim_expires_was": 1780459993, "claim_expires_now": 1780460895, "last_heartbeat_at": null}',1780459995);
INSERT INTO task_events VALUES(90,'t_2160f84d',10,'blocked','{"reason": "Iteration budget exhausted (150/150) — task could not complete within the allowed iterations"}',1780460000);
INSERT INTO task_events VALUES(91,'t_2160f84d',NULL,'unblocked',NULL,1780460156);
INSERT INTO task_events VALUES(92,'t_19305b13',11,'reclaimed','{"manual": true, "reason": "landfolk stop", "prev_lock": "macstudio.local:57324", "prev_pid": 80858, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}',1780460161);
INSERT INTO task_events VALUES(93,'t_7defd5bc',12,'reclaimed','{"manual": true, "reason": "landfolk stop", "prev_lock": "macstudio.local:57324", "prev_pid": 90140, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}',1780460163);
INSERT INTO task_events VALUES(94,'t_2160f84d',13,'claimed','{"lock": "macstudio.local:57324", "expires": 1780461075, "run_id": 13}',1780460175);
INSERT INTO task_events VALUES(95,'t_2160f84d',13,'spawned','{"pid": 23866}',1780460175);
INSERT INTO task_events VALUES(96,'t_19305b13',14,'claimed','{"lock": "macstudio.local:57324", "expires": 1780461075, "run_id": 14}',1780460175);
INSERT INTO task_events VALUES(97,'t_19305b13',14,'spawned','{"pid": 23867}',1780460175);
INSERT INTO task_events VALUES(98,'t_7defd5bc',15,'claimed','{"lock": "macstudio.local:57324", "expires": 1780461075, "run_id": 15}',1780460175);
INSERT INTO task_events VALUES(99,'t_7defd5bc',15,'spawned','{"pid": 23868}',1780460175);
CREATE TABLE task_runs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id             TEXT NOT NULL,
    profile             TEXT,
    step_key            TEXT,
    status              TEXT NOT NULL,
    -- status: running | done | blocked | crashed | timed_out | failed | released
    claim_lock          TEXT,
    claim_expires       INTEGER,
    worker_pid          INTEGER,
    max_runtime_seconds INTEGER,
    last_heartbeat_at   INTEGER,
    started_at          INTEGER NOT NULL,
    ended_at            INTEGER,
    outcome             TEXT,
    -- outcome: completed | blocked | crashed | timed_out | spawn_failed |
    --          gave_up | reclaimed | (null while still running)
    summary             TEXT,
    metadata            TEXT,
    error               TEXT
);
INSERT INTO task_runs VALUES(1,'t_e574c442','flint',NULL,'done',NULL,NULL,NULL,NULL,NULL,1780455004,1780455530,'completed','NE quadrant from muster surveyed: open grassland Y100-105, abundant coal (~270 blocks) and stone, 12 iron_ore, sparse wood (1 oak tree), no surface water within 30-block radius. Candidate pad candidate_pad_ne_1 marked at (27,103,10). Small built structure with chests at (25,105,2). SITE_SCORE=2/5.','{"marks_created": ["lt_stone_ne", "lt_coal_ne", "lt_iron_ne", "candidate_pad_ne_1"], "resources": {"stone": "abundant", "coal_ore": 270, "iron_ore": 12, "wood_oak_logs": 3, "water_surface": "none", "animals": "none"}, "candidate_pads": [{"name": "candidate_pad_ne_1", "coords": [27, 103, 10], "site_score": 2, "distance_from_muster": 27, "pros": ["flat grassland", "stone/coal/iron below", "within 30m of muster"], "cons": ["no surface water", "no trees nearby"]}], "hazards": {"ravine_at": [22, 92, -8]}}',NULL);
INSERT INTO task_runs VALUES(2,'t_f12d7ecb','mason',NULL,'done',NULL,NULL,NULL,NULL,NULL,1780455004,1780455618,'completed','NW quadrant patrol from muster (4,96,24), radius 30, surface only on proc-lab world. Terrain: open plains transitioning Y96→Y90-95. Resources marked: nw_iron_vein (13 iron_ore at ~-16,86,-7), nw_coal_pocket (65 coal_ore at ~-18,86,3), nw_coal_pocket_2 (26 coal_ore at ~-6,87,27), copper_ore at ~-19,85,-3. No hazards, hostiles, water, or structures found. Navigation limited by terrain obstacles near base perimeter.','{"marks_placed": ["nw_iron_vein at (-16,92,-5)", "nw_coal_pocket at (-13,92,16)", "nw_coal_pocket_2 at (-1,95,27)"], "resources_found": {"coal_ore": {"location_1": "(-18,86,3) count~65", "location_2": "(-6,87,27) count~26"}, "iron_ore": {"location": "(-16,86,-7) count~13"}, "copper_ore": {"location": "(-19,85,-3) count~11"}}, "hazards": "none", "water": "none", "structures": "none", "world": "proc-lab", "radius": 30}',NULL);
INSERT INTO task_runs VALUES(3,'t_25195a8c','gatherer',NULL,'done',NULL,NULL,NULL,NULL,NULL,1780455004,1780455469,'completed','SE quadrant patrol completed — patrolled ~28b radius SE from muster (4,96,24). Found Y99-101 grassland plateau at X=22-24,Z=46-48 with coal (~157 blocks), iron (~20), copper (~40) resources. Existing cobble/oak shelter with chest at (16,102,54). Marked se_patrol_far, lt_coal_se, lt_iron_se, lt_copper_se, candidate_pad_se_1, se_shelter.','{"patrol_center": [4, 96, 24], "direction": "SE ~135°", "radius": 28, "terrain": {"elevation_range": [92, 101], "surface": "open grassland plateau", "water": false}, "resources": {"coal_ore": {"count": 157, "location": [23, 100, 48]}, "iron_ore": {"count": 20, "location": [23, 100, 48]}, "copper_ore": {"count": 40, "location": [23, 100, 48]}}, "marks_created": ["se_patrol_far", "lt_coal_se", "lt_iron_se", "lt_copper_se", "candidate_pad_se_1", "se_shelter"], "structures": [{"type": "shelter", "location": [16, 102, 54], "materials": ["cobblestone", "oak_planks", "stripped_oak_log", "oak_stairs", "mossy_cobblestone"], "features": ["oak_door", "chest"]}], "candidate_pad": {"id": "candidate_pad_se_1", "location": [23, 100, 48], "bbox": {"x": [22, 24], "z": [46, 48]}, "surface_Y": "99-101", "site_score": 2}}',NULL);
INSERT INTO task_runs VALUES(4,'t_9f9e21b0','flint',NULL,'done',NULL,NULL,NULL,NULL,NULL,1780455485,1780455681,'completed',NULL,NULL,NULL);
INSERT INTO task_runs VALUES(5,'t_174de3c0','mason',NULL,'reclaimed',NULL,NULL,NULL,NULL,NULL,1780455725,1780457051,'reclaimed',NULL,'{"prev_pid": 85409, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}','manual_reclaim: PHYSICALLY_STUCK: mason underground Y=92 mining 1 cobble/cycle for 21m. Will re-spec with cobble pre-supplied.');
INSERT INTO task_runs VALUES(6,'t_174de3c0','mason',NULL,'reclaimed',NULL,NULL,NULL,NULL,NULL,1780457108,1780457154,'reclaimed','task archived with run still active',NULL,NULL);
INSERT INTO task_runs VALUES(7,'t_a8650983','flint',NULL,'crashed',NULL,NULL,NULL,NULL,NULL,1780457168,1780457469,'crashed',NULL,'{"pid": 30200, "claimer": "macstudio.local:57324", "exit_code": 0}','worker exited cleanly (rc=0) without calling kanban_complete or kanban_block — protocol violation');
INSERT INTO task_runs VALUES(8,'t_47f74d1d','flint',NULL,'done',NULL,NULL,NULL,NULL,NULL,1780457168,1780458869,'completed','Mined 35 cobblestone from stone near base_anchor via stair_down, deposited at chest (5,96,24). Card''s specified deposit coord (16,102,54) is an oak_door, not a chest — used nearest reachable chest instead. Inventory now shows 0 cobble.','{"mined": 35, "deposited": 35, "deposit_chest": "(5,96,24)", "card_spec_chest_coord": "(16,102,54)", "card_spec_chest_reality": "oak_door", "inventory_delta": {"cobblestone": -35}, "chest_delta": {"cobblestone": 35}}',NULL);
INSERT INTO task_runs VALUES(9,'t_b0486f5e','flint',NULL,'blocked',NULL,NULL,NULL,NULL,NULL,1780457168,1780458785,'blocked','clarification-needed: Chest coords (16,102,54) is an oak_door, not a chest. Chest at (20,105,8) has 85 cobble (≥81 met) but unreachable via pathfinder. Inventory has 35 cobble — where to deposit?',NULL,NULL);
INSERT INTO task_runs VALUES(10,'t_2160f84d','gatherer',NULL,'blocked',NULL,NULL,NULL,NULL,NULL,1780457469,1780460000,'blocked','Iteration budget exhausted (150/150) — task could not complete within the allowed iterations',NULL,NULL);
INSERT INTO task_runs VALUES(11,'t_19305b13','mason',NULL,'reclaimed',NULL,NULL,NULL,NULL,NULL,1780458792,1780460161,'reclaimed',NULL,'{"prev_pid": 80858, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}','manual_reclaim: landfolk stop');
INSERT INTO task_runs VALUES(12,'t_7defd5bc','flint',NULL,'reclaimed',NULL,NULL,NULL,NULL,NULL,1780459093,1780460163,'reclaimed',NULL,'{"prev_pid": 90140, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}','manual_reclaim: landfolk stop');
INSERT INTO task_runs VALUES(13,'t_2160f84d','gatherer',NULL,'running','macstudio.local:57324',1780461075,23866,NULL,NULL,1780460175,NULL,NULL,NULL,NULL,NULL);
INSERT INTO task_runs VALUES(14,'t_19305b13','mason',NULL,'running','macstudio.local:57324',1780461075,23867,NULL,NULL,1780460175,NULL,NULL,NULL,NULL,NULL);
INSERT INTO task_runs VALUES(15,'t_7defd5bc','flint',NULL,'running','macstudio.local:57324',1780461075,23868,NULL,NULL,1780460175,NULL,NULL,NULL,NULL,NULL);
CREATE TABLE kanban_notify_subs (
    task_id       TEXT NOT NULL,
    platform      TEXT NOT NULL,
    chat_id       TEXT NOT NULL,
    thread_id     TEXT NOT NULL DEFAULT '',
    user_id       TEXT,
    notifier_profile TEXT,
    created_at    INTEGER NOT NULL,
    last_event_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (task_id, platform, chat_id, thread_id)
);
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence VALUES('task_events',99);
INSERT INTO sqlite_sequence VALUES('task_runs',15);
INSERT INTO sqlite_sequence VALUES('task_comments',18);
CREATE INDEX idx_tasks_assignee_status ON tasks(assignee, status);
CREATE INDEX idx_tasks_status          ON tasks(status);
CREATE INDEX idx_tasks_tenant          ON tasks(tenant);
CREATE INDEX idx_tasks_idempotency     ON tasks(idempotency_key);
CREATE INDEX idx_links_child           ON task_links(child_id);
CREATE INDEX idx_links_parent          ON task_links(parent_id);
CREATE INDEX idx_comments_task         ON task_comments(task_id, created_at);
CREATE INDEX idx_events_task           ON task_events(task_id, created_at);
CREATE INDEX idx_events_run            ON task_events(run_id, id);
CREATE INDEX idx_runs_task             ON task_runs(task_id, started_at);
CREATE INDEX idx_runs_status           ON task_runs(status);
CREATE INDEX idx_notify_task           ON kanban_notify_subs(task_id);
COMMIT;
