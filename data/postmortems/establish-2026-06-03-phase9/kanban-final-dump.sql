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
INSERT INTO tasks VALUES('t_001b963c','[EPIC] [ESTABLISH:BASE] Establish home base',replace('**Epic — exploration-first base on proc-lab.** You decompose/track worker cards; do not mine or place.\n\nSpawn: 4,96,24\nMuster: 4,96,24\nStarter chest: 5,95,24\n\nMission: fleet explores the disc (unknown terrain), you pick a defensible flat site, Mason builds a 9×9 cobble pad.\n\n**First cycle:** run `scripts/reconcile-marks.py --auto`, then `scripts/kanban board`. If explore cards are not yet `ready`, file them from `data/establish/templates/establish-explore-cards.yaml` (four sectors, `--for` this epic only — never `--after` this epic).\n\n**Decide:** when explore cards complete, comment on this epic with `base_anchor: X,Y,Z` + rationale; pin `base_anchor` mark; `scripts/kanban add` `[CONSTRUCT] Pad 9x9 cobble` for mason with `--at` and coords **in the card body**.\n\nMark vocabulary:\n  lt_<resource>_<dir>     resources (lt_wood_ne, …)\n  candidate_pad_<name>    candidate flats (note defense + biome)\n  base_anchor             final site (Steward pins after decide)\n\ndone_when:\n  - >=4 [EXPLORE] cards done\n  - >=2 candidate_pad_* marks OR comment "coverage sufficient, sparse"\n  - base_anchor pinned (shared after reconcile)\n  - [CONSTRUCT] cobble pad card done\n  - 9×9 cobble pad at base_anchor (>=80 cells)\n\nCriteria for base site: flat/level, defensible (height/choke), central to lt_* resources found.\n','\n',char(10)),'orchestrator-tracker','ready',0,'user',1780469956,NULL,NULL,'scratch',NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO tasks VALUES('t_2ae214c1','[EXPLORE] NE quadrant from muster',replace('World: proc-lab. Hub: muster (4,96,24).\nPatrol **NE** from muster (~bearing 045°), max radius **30** blocks, budget **8 min**, surface only.\n\nLoop: `mc move` / bearing steps → `mc look` → `mc scene` → mark discoveries.\nMark `lt_*` for wood/stone/water/animals; `candidate_pad_<name>` on flats worth a base (note defense + biome in mark body).\nChat status every ~5 min with position + scene cues.\nComplete summary: `mc marks` lines for lt_* and candidate_pad_*; SITE_SCORE 1-5 for best pad found.\n\n\n---\nepic: t_001b963c','\n',char(10)),'flint','archived',0,'user',1780469956,1780470042,NULL,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_2ae214c1',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'["minecraft-navigation"]',NULL,NULL,NULL,NULL,'M');
INSERT INTO tasks VALUES('t_9859b51e','[EXPLORE] NW quadrant from muster',replace('World: proc-lab. Hub: muster (4,96,24).\nPatrol **NW** (~315°), max radius **30**, budget **8 min**, surface only.\nSame mark/report protocol as NE explore card.\n\n\n---\nepic: t_001b963c','\n',char(10)),'mason','done',0,'user',1780469957,1780470042,1780470898,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_9859b51e',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'["minecraft-navigation", "minecraft-mining"]',NULL,NULL,NULL,NULL,'M');
INSERT INTO tasks VALUES('t_6269dd47','[EXPLORE] SE quadrant from muster',replace('World: proc-lab. Hub: muster (4,96,24).\nPatrol **SE** (~135°), max radius **30**, budget **8 min**, surface only.\nSame mark/report protocol as NE explore card.\n\n\n---\nepic: t_001b963c','\n',char(10)),'gatherer','done',0,'user',1780469957,1780470042,1780470969,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_6269dd47',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'["minecraft-navigation", "minecraft-building"]',NULL,NULL,NULL,NULL,'M');
INSERT INTO tasks VALUES('t_f9619d00','[EXPLORE] SW quadrant from muster',replace('World: proc-lab. Hub: muster (4,96,24).\nPatrol **SW** (~225°), max radius **30**, budget **8 min**, surface only.\nSame mark/report protocol as NE explore card.\n\n\n---\nepic: t_001b963c','\n',char(10)),'gatherer','done',0,'user',1780469957,1780470643,1780471214,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_f9619d00',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'["minecraft-navigation"]',NULL,NULL,NULL,NULL,'M');
INSERT INTO tasks VALUES('t_7265d6b1','[SCOUT] Scout candidate pad sites in NE quadrant',replace('World: proc-lab. Hub: muster (4,96,24). Surface at Y=100-105.\n\nCURRENT POSITION: (14,102,8). You are already on the surface at Y=102.\n\nROUTE: From (14,102,8), mc goto 30 102 100 — move east along Y=102 surface. Then mc goto 60 102 100. Then mc goto 100 102 100.\n\nMark every flat 9x9+ area along the way: mc mark candidate_pad_ne_1, ne_2, etc.\n\nIf you can''t reach 100 blocks, mark the best flat site between X=60-100 and return. Report coords + flatness note in chat.','\n',char(10)),'flint','ready',0,'user',1780470898,1780470916,NULL,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_7265d6b1',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'M');
INSERT INTO tasks VALUES('t_a368968c','[SCOUT] Scout candidate pad sites in NW quadrant',replace('World: proc-lab. Hub: muster (4,96,24). Scout the NW quadrant for flat/defensible sites large enough for a 9x9 cobble pad. Priority: level terrain near resources found by NW explore (copper, coal, iron at (-26,92,4)). Mark each candidate with ''candidate_pad_<name>'' so Steward can select base_anchor.\n\n---\nepic: t_001b963c','\n',char(10)),'mason','done',0,'user',1780471002,1780471004,1780472137,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_a368968c',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'M');
INSERT INTO tasks VALUES('t_78f7f904','[SCOUT] Scout candidate pad sites in SE quadrant',replace('World: proc-lab. Hub: muster (4,96,24). Scout the SE quadrant for flat/defensible sites large enough for a 9x9 pad. Mark candidate_pad_se_N with mc mark. Then return to (4,96,24).\n\n---\nepic: t_001b963c','\n',char(10)),'gatherer','done',0,'user',1780471378,1780471402,1780472371,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_78f7f904',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'M');
INSERT INTO tasks VALUES('t_59254ccc','[SCOUT] Scout candidate pad sites in SW quadrant',replace('World: proc-lab. Hub: muster (4,96,24). Scout the SW quadrant for flat/defensible sites large enough for a 9x9 pad. Mark candidate_pad_sw_N with mc mark. Then return to (4,96,24).\n\n---\nepic: t_001b963c','\n',char(10)),'gatherer','done',0,'user',1780471381,NULL,1780472061,'scratch',NULL,NULL,NULL,NULL,'SW quad scouted by gatherer — candidate_pad_sw_1 marked at (-3,88,46). Open grassland, copper vein, water pond. No hazards.',NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'M');
INSERT INTO tasks VALUES('t_cefd4f35','[SURVEY] Evaluate top pad candidates for base_anchor',replace('Survey the best candidate pads across SE, NW, and SW quadrants. Visit each candidate_pad mark and evaluate:\n\n1. Flatness: can a 9x9 cobble pad sit level?\n2. Defensibility: open sightlines, no cliff overhangs, no water/lava within 8 blocks\n3. Resource proximity: how far to nearest lt_* resource marks (coal, iron, copper)\n4. Space: room to expand to 20x20 later\n\nStart with candidate_pad_se_2 (31,99,56 — ''very flat core'') then se_1 (20,99,44), then sw_1 (-3,88,46), then nw_1 (-39,92,10) and nw_3 (-26,92,-3).\n\nReport which site you recommend as base_anchor and why.\n\n---\nepic: t_001b963c','\n',char(10)),'mason','ready',50,'user',1780472650,1780472679,NULL,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_cefd4f35',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'S');
INSERT INTO tasks VALUES('t_1d175784','[SCOUT] Verify resource availability near top pad candidates',replace('Visit candidate_pad_se_1 (20,99,44) and candidate_pad_se_2 (31,99,56). Within 40 blocks of each, check:\n\n1. How many oak trees visible? Estimate total logs.\n2. Any exposed stone/cobblestone?\n3. Any water source?\n4. Any hazards (lava, cliffs, mob spawners)?\n\nAlso visit candidate_pad_sw_1 (-3,88,46) and check nearby tree/stone count.\n\nReport findings in chat. This data feeds base_anchor decision and initial supply planning.\n\n---\nepic: t_001b963c','\n',char(10)),'gatherer','ready',50,'user',1780472663,1780472679,NULL,'scratch','/Users/foz/.hermes/kanban/boards/landfolk-ops/workspaces/t_1d175784',NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'S');
CREATE TABLE task_links (
    parent_id  TEXT NOT NULL,
    child_id   TEXT NOT NULL,
    PRIMARY KEY (parent_id, child_id)
);
CREATE TABLE task_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
INSERT INTO task_comments VALUES(1,'t_7265d6b1','default','flint PHYSICALLY_STUCK — pos (14,102,8) unchanged 27min, pillar_up fail at (5,98,21), 0 NE pads marked. Reclaiming for fresh worker spawn with updated nav spec.',1780472597);
CREATE TABLE task_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    run_id     INTEGER,
    kind       TEXT NOT NULL,
    payload    TEXT,
    created_at INTEGER NOT NULL
);
INSERT INTO task_events VALUES(1,'t_001b963c',NULL,'created','{"assignee": "steward", "status": "ready", "parents": [], "tenant": null, "skills": null}',1780469956);
INSERT INTO task_events VALUES(2,'t_001b963c',NULL,'assigned','{"assignee": "orchestrator-tracker"}',1780469956);
INSERT INTO task_events VALUES(3,'t_2ae214c1',NULL,'created','{"assignee": "orchestrator-tracker", "status": "ready", "parents": [], "tenant": null, "skills": ["minecraft-navigation"]}',1780469956);
INSERT INTO task_events VALUES(4,'t_9859b51e',NULL,'created','{"assignee": "orchestrator-tracker", "status": "ready", "parents": [], "tenant": null, "skills": ["minecraft-navigation", "minecraft-mining"]}',1780469957);
INSERT INTO task_events VALUES(5,'t_6269dd47',NULL,'created','{"assignee": "orchestrator-tracker", "status": "ready", "parents": [], "tenant": null, "skills": ["minecraft-navigation", "minecraft-building"]}',1780469957);
INSERT INTO task_events VALUES(6,'t_f9619d00',NULL,'created','{"assignee": "orchestrator-tracker", "status": "ready", "parents": [], "tenant": null, "skills": ["minecraft-navigation"]}',1780469957);
INSERT INTO task_events VALUES(7,'t_2ae214c1',NULL,'assigned','{"assignee": "flint"}',1780470010);
INSERT INTO task_events VALUES(8,'t_9859b51e',NULL,'assigned','{"assignee": "mason"}',1780470012);
INSERT INTO task_events VALUES(9,'t_6269dd47',NULL,'assigned','{"assignee": "gatherer"}',1780470013);
INSERT INTO task_events VALUES(10,'t_f9619d00',NULL,'assigned','{"assignee": "flint"}',1780470015);
INSERT INTO task_events VALUES(11,'t_2ae214c1',1,'claimed','{"lock": "macstudio.local:41529", "expires": 1780470942, "run_id": 1}',1780470042);
INSERT INTO task_events VALUES(12,'t_2ae214c1',1,'spawned','{"pid": 46409}',1780470042);
INSERT INTO task_events VALUES(13,'t_9859b51e',2,'claimed','{"lock": "macstudio.local:41529", "expires": 1780470942, "run_id": 2}',1780470042);
INSERT INTO task_events VALUES(14,'t_9859b51e',2,'spawned','{"pid": 46411}',1780470042);
INSERT INTO task_events VALUES(15,'t_6269dd47',3,'claimed','{"lock": "macstudio.local:41529", "expires": 1780470942, "run_id": 3}',1780470042);
INSERT INTO task_events VALUES(16,'t_6269dd47',3,'spawned','{"pid": 46412}',1780470042);
INSERT INTO task_events VALUES(17,'t_2ae214c1',1,'archived',NULL,1780470616);
INSERT INTO task_events VALUES(18,'t_f9619d00',NULL,'assigned','{"assignee": "gatherer"}',1780470618);
INSERT INTO task_events VALUES(19,'t_f9619d00',4,'claimed','{"lock": "macstudio.local:41529", "expires": 1780471543, "run_id": 4}',1780470643);
INSERT INTO task_events VALUES(20,'t_f9619d00',4,'spawned','{"pid": 64952}',1780470643);
INSERT INTO task_events VALUES(21,'t_9859b51e',2,'completed','{"result_len": 0, "summary": "NW quadrant patrolled from muster (4,96,24) radius 30, surface only on proc-lab. Open rolling grassland Y90-92. Marked 3 resource pockets: nw_iron_vein (-16,86,-7) ~4 ore, nw_coal_pocket (-18,86,3) ~37 ore, nw_copper_pocket (-19,85,-3) ~6 ore. No hazards, no surface structures, no water/lava. Returned to muster."}',1780470898);
INSERT INTO task_events VALUES(22,'t_7265d6b1',NULL,'created','{"assignee": "flint", "status": "ready", "parents": [], "tenant": null, "skills": null}',1780470898);
INSERT INTO task_events VALUES(23,'t_7265d6b1',5,'claimed','{"lock": "macstudio.local:73347", "expires": 1780471816, "run_id": 5}',1780470916);
INSERT INTO task_events VALUES(24,'t_7265d6b1',5,'spawned','{"pid": 73380}',1780470916);
INSERT INTO task_events VALUES(25,'t_6269dd47',3,'claim_extended','{"reason": "pid_alive", "worker_pid": 46412, "claim_lock": "macstudio.local:41529", "claim_expires_was": 1780470942, "claim_expires_now": 1780471844, "last_heartbeat_at": null}',1780470944);
INSERT INTO task_events VALUES(26,'t_6269dd47',3,'completed','{"result_len": 0, "summary": "SE quadrant patrolled ~30b radius from muster (4,96,24) in proc-lab world. Found cobble/oak shelter with oak_door at (16,102,54), coal ~102 blocks, iron ~19 blocks, copper ~17 blocks. Terrain: open grassland gentle slope Y96-103 plateau. Marks set: se_patrol_far, lt_coal_se, lt_iron_se, lt_copper_se, candidate_pad_se_1."}',1780470969);
INSERT INTO task_events VALUES(27,'t_a368968c',NULL,'created','{"assignee": "mason", "status": "ready", "parents": [], "tenant": null, "skills": null}',1780471002);
INSERT INTO task_events VALUES(28,'t_a368968c',6,'claimed','{"lock": "macstudio.local:41529", "expires": 1780471904, "run_id": 6}',1780471004);
INSERT INTO task_events VALUES(29,'t_a368968c',6,'spawned','{"pid": 76066}',1780471004);
INSERT INTO task_events VALUES(30,'t_f9619d00',4,'completed','{"result_len": 0, "summary": "SW quadrant patrol complete from muster (4,96,24) — patrolled ~28 block radius SW (~225°). Resources: ~103 coal_ore dense at (-31,83,50), ~17 copper_ore at (-25,82,58), water pond ~9 blocks at (-29,81,42). Terrain: open grassland gentle slope Y86-88, no trees, no structures. Candidate pad site at (-1,88,45). All marks registered: sw_patrol_far, lt_coal_sw, lt_copper_sw, candidate_pad_sw_1. SITE_SC"}',1780471214);
INSERT INTO task_events VALUES(31,'t_78f7f904',NULL,'created','{"assignee": "gatherer", "status": "ready", "parents": [], "tenant": null, "skills": null}',1780471378);
INSERT INTO task_events VALUES(32,'t_59254ccc',NULL,'created','{"assignee": "gatherer", "status": "ready", "parents": [], "tenant": null, "skills": null}',1780471381);
INSERT INTO task_events VALUES(33,'t_59254ccc',NULL,'mutex_parked','{"by": "landfolk-orchestrator", "reason": "per_assignee_mutex", "lock": "mutex_park:gatherer"}',1780471402);
INSERT INTO task_events VALUES(34,'t_78f7f904',7,'claimed','{"lock": "macstudio.local:88453", "expires": 1780472302, "run_id": 7}',1780471402);
INSERT INTO task_events VALUES(35,'t_78f7f904',7,'spawned','{"pid": 88463}',1780471402);
INSERT INTO task_events VALUES(36,'t_7265d6b1',5,'claim_extended','{"reason": "pid_alive", "worker_pid": 73380, "claim_lock": "macstudio.local:73347", "claim_expires_was": 1780471816, "claim_expires_now": 1780472728, "last_heartbeat_at": null}',1780471828);
INSERT INTO task_events VALUES(37,'t_a368968c',6,'claim_extended','{"reason": "pid_alive", "worker_pid": 76066, "claim_lock": "macstudio.local:41529", "claim_expires_was": 1780471904, "claim_expires_now": 1780472806, "last_heartbeat_at": null}',1780471906);
INSERT INTO task_events VALUES(38,'t_59254ccc',8,'completed','{"result_len": 123, "summary": "SW quad scouted by gatherer — candidate_pad_sw_1 marked at (-3,88,46). Open grassland, copper vein, water pond. No hazards."}',1780472061);
INSERT INTO task_events VALUES(39,'t_a368968c',6,'completed','{"result_len": 0, "summary": "NW quadrant pad site survey complete on proc-lab world. Found and marked 3 candidate 9x9 pad sites: candidate_pad_nw_1 at (-39,92,10) — best site, flat 9x9 (-44,5)-(-36,13) Y=91, open grassland, no hazards; candidate_pad_nw_2 at (-39,91,15) — backup 9x9 (-44,11)-(-36,19) Y=91; candidate_pad_nw_3 at (-26,92,-3) — near resources 9x9 (-26,-4)-(-18,4) Y=92. All sites hazard-free (no water/lava/mobs). "}',1780472137);
INSERT INTO task_events VALUES(40,'t_78f7f904',7,'claim_extended','{"reason": "pid_alive", "worker_pid": 88463, "claim_lock": "macstudio.local:88453", "claim_expires_was": 1780472302, "claim_expires_now": 1780473215, "last_heartbeat_at": null}',1780472315);
INSERT INTO task_events VALUES(41,'t_78f7f904',7,'completed','{"result_len": 0, "summary": "Scouted SE quadrant (proc-lab, muster at 4,96,24) for 9×9 pad sites. Found 2 candidates: (1) candidate_pad_se_1 at (19,99,43) — Y99-104 open grassland, 15b from muster, slopes north; (2) candidate_pad_se_2 at (32,98,58) — Y98 very flat open grassland core Z=55-60, 30b from muster. Both marked. SE terrain is open grassland plateau Y96-107, no water. Returned to muster."}',1780472371);
INSERT INTO task_events VALUES(42,'t_7265d6b1',NULL,'commented','{"author": "default", "len": 160}',1780472597);
INSERT INTO task_events VALUES(43,'t_7265d6b1',5,'reclaimed','{"manual": true, "reason": null, "prev_lock": "macstudio.local:73347", "prev_pid": 73380, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}',1780472603);
INSERT INTO task_events VALUES(44,'t_7265d6b1',9,'claimed','{"lock": "macstudio.local:28716", "expires": 1780473518, "run_id": 9}',1780472618);
INSERT INTO task_events VALUES(45,'t_7265d6b1',9,'spawned','{"pid": 28724}',1780472618);
INSERT INTO task_events VALUES(46,'t_7265d6b1',NULL,'edited','{"fields": ["body"]}',1780472623);
INSERT INTO task_events VALUES(47,'t_cefd4f35',NULL,'created','{"assignee": "mason", "status": "ready", "parents": [], "tenant": null, "skills": null}',1780472650);
INSERT INTO task_events VALUES(48,'t_1d175784',NULL,'created','{"assignee": "gatherer", "status": "ready", "parents": [], "tenant": null, "skills": null}',1780472663);
INSERT INTO task_events VALUES(49,'t_cefd4f35',10,'claimed','{"lock": "macstudio.local:30524", "expires": 1780473579, "run_id": 10}',1780472679);
INSERT INTO task_events VALUES(50,'t_cefd4f35',10,'spawned','{"pid": 30538}',1780472679);
INSERT INTO task_events VALUES(51,'t_1d175784',11,'claimed','{"lock": "macstudio.local:30524", "expires": 1780473579, "run_id": 11}',1780472679);
INSERT INTO task_events VALUES(52,'t_1d175784',11,'spawned','{"pid": 30539}',1780472679);
INSERT INTO task_events VALUES(53,'t_1d175784',11,'crashed','{"pid": 30539, "claimer": "macstudio.local:30524"}',1780472862);
INSERT INTO task_events VALUES(54,'t_1d175784',12,'claimed','{"lock": "macstudio.local:35938", "expires": 1780473762, "run_id": 12}',1780472862);
INSERT INTO task_events VALUES(55,'t_1d175784',12,'spawned','{"pid": 35948}',1780472862);
INSERT INTO task_events VALUES(56,'t_1d175784',12,'crashed','{"pid": 35948, "claimer": "macstudio.local:35938"}',1780472983);
INSERT INTO task_events VALUES(57,'t_1d175784',NULL,'gave_up','{"failures": 2, "effective_limit": 2, "limit_source": "dispatcher", "error": "pid 35948 not alive", "trigger_outcome": "crashed", "pid": 35948, "claimer": "macstudio.local:35938"}',1780472983);
INSERT INTO task_events VALUES(58,'t_1d175784',NULL,'retried','{"from_failures": 2, "from_status": "blocked", "to_status": "ready", "reason": "Steward retry: failure_limit cleared, gatherer has fresh spawn available"}',1780473070);
INSERT INTO task_events VALUES(59,'t_1d175784',13,'claimed','{"lock": "macstudio.local:43722", "expires": 1780474005, "run_id": 13}',1780473105);
INSERT INTO task_events VALUES(60,'t_1d175784',13,'spawned','{"pid": 43725}',1780473105);
INSERT INTO task_events VALUES(61,'t_7265d6b1',NULL,'edited','{"fields": ["body"]}',1780473144);
INSERT INTO task_events VALUES(62,'t_7265d6b1',9,'reclaimed','{"manual": true, "reason": "landfolk stop flint", "prev_lock": "macstudio.local:28716", "prev_pid": 28724, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}',1780473216);
INSERT INTO task_events VALUES(63,'t_7265d6b1',14,'claimed','{"lock": "macstudio.local:47686", "expires": 1780474126, "run_id": 14}',1780473226);
INSERT INTO task_events VALUES(64,'t_7265d6b1',14,'spawned','{"pid": 47693}',1780473226);
INSERT INTO task_events VALUES(65,'t_cefd4f35',10,'reclaimed','{"manual": true, "reason": "landfolk stop mason", "prev_lock": "macstudio.local:30524", "prev_pid": 30538, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}',1780473299);
INSERT INTO task_events VALUES(66,'t_1d175784',13,'crashed','{"pid": 43725, "claimer": "macstudio.local:43722"}',1780473348);
INSERT INTO task_events VALUES(67,'t_cefd4f35',15,'claimed','{"lock": "macstudio.local:51302", "expires": 1780474248, "run_id": 15}',1780473348);
INSERT INTO task_events VALUES(68,'t_cefd4f35',15,'spawned','{"pid": 51305}',1780473348);
INSERT INTO task_events VALUES(69,'t_1d175784',16,'claimed','{"lock": "macstudio.local:51302", "expires": 1780474248, "run_id": 16}',1780473348);
INSERT INTO task_events VALUES(70,'t_1d175784',16,'spawned','{"pid": 51306}',1780473348);
INSERT INTO task_events VALUES(71,'t_cefd4f35',15,'reclaimed','{"manual": true, "reason": "landfolk stop", "prev_lock": "macstudio.local:51302", "prev_pid": 51305, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}',1780473417);
INSERT INTO task_events VALUES(72,'t_1d175784',16,'reclaimed','{"manual": true, "reason": "landfolk stop", "prev_lock": "macstudio.local:51302", "prev_pid": 51306, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}',1780473420);
INSERT INTO task_events VALUES(73,'t_7265d6b1',14,'reclaimed','{"manual": true, "reason": "landfolk stop", "prev_lock": "macstudio.local:47686", "prev_pid": 47693, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}',1780473423);
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
INSERT INTO task_runs VALUES(1,'t_2ae214c1','flint',NULL,'reclaimed',NULL,NULL,NULL,NULL,NULL,1780470042,1780470616,'reclaimed','task archived with run still active',NULL,NULL);
INSERT INTO task_runs VALUES(2,'t_9859b51e','mason',NULL,'done',NULL,NULL,NULL,NULL,NULL,1780470042,1780470898,'completed','NW quadrant patrolled from muster (4,96,24) radius 30, surface only on proc-lab. Open rolling grassland Y90-92. Marked 3 resource pockets: nw_iron_vein (-16,86,-7) ~4 ore, nw_coal_pocket (-18,86,3) ~37 ore, nw_copper_pocket (-19,85,-3) ~6 ore. No hazards, no surface structures, no water/lava. Returned to muster.','{"marks_placed": ["nw_iron_vein", "nw_coal_pocket", "nw_copper_pocket"], "resources_found": {"iron_ore": {"coords": [-16, 86, -7], "count": 4}, "coal_ore": {"coords": [-18, 86, 3], "count": 37}, "copper_ore": {"coords": [-19, 85, -3], "count": 6}}, "terrain": "open_grassland", "surface_y_range": [90, 92], "hazards": "none", "structures": "none", "radius_covered": 30, "world": "proc-lab", "quadrant": "NW"}',NULL);
INSERT INTO task_runs VALUES(3,'t_6269dd47','gatherer',NULL,'done',NULL,NULL,NULL,NULL,NULL,1780470042,1780470969,'completed','SE quadrant patrolled ~30b radius from muster (4,96,24) in proc-lab world. Found cobble/oak shelter with oak_door at (16,102,54), coal ~102 blocks, iron ~19 blocks, copper ~17 blocks. Terrain: open grassland gentle slope Y96-103 plateau. Marks set: se_patrol_far, lt_coal_se, lt_iron_se, lt_copper_se, candidate_pad_se_1.','{"patrol_quadrant": "SE", "radius_patrolled": 30, "surface_y_range": "96-103", "resources_found": {"coal_ore": "~102 blocks at (25-31,97-98,35-47) and (17,98,34-36)", "iron_ore": "~19 blocks at (30-35,99-103,42-48)", "copper_ore": "~17 blocks at (21-23,96-97,41-42)"}, "structures": [{"type": "shelter", "material": "cobble/oak", "pos": [16, 102, 54], "features": ["oak_door"]}], "marks_created": ["se_patrol_far", "lt_coal_se", "lt_iron_se", "lt_copper_se", "candidate_pad_se_1"], "terrain": "open grassland, gentle slope, no water", "site_score": 2}',NULL);
INSERT INTO task_runs VALUES(4,'t_f9619d00','gatherer',NULL,'done',NULL,NULL,NULL,NULL,NULL,1780470643,1780471214,'completed','SW quadrant patrol complete from muster (4,96,24) — patrolled ~28 block radius SW (~225°). Resources: ~103 coal_ore dense at (-31,83,50), ~17 copper_ore at (-25,82,58), water pond ~9 blocks at (-29,81,42). Terrain: open grassland gentle slope Y86-88, no trees, no structures. Candidate pad site at (-1,88,45). All marks registered: sw_patrol_far, lt_coal_sw, lt_copper_sw, candidate_pad_sw_1. SITE_SCORE 2 (lower elevation than base at Y=88).','{"patrol_direction": "SW (~225°)", "patrol_radius": 28, "surface_elevation": "Y86-88", "terrain": "open grassland, gentle slope", "resources": {"coal_ore": {"count": 103, "location": "(-31,83,50)", "status": "dense"}, "copper_ore": {"count": 17, "location": "(-25,82,58)"}}, "hazards": {"water_pond": {"coords": "(-29,81,42)", "blocks": 9}}, "marks_created": ["sw_patrol_far@(-25,86,49)", "lt_coal_sw@(-30,86,51)", "lt_copper_sw@(-30,86,51)", "candidate_pad_sw_1@(-3,88,46)"], "candidate_pad": "(-1,88,45)", "site_score": 2, "no_structures_found": true}',NULL);
INSERT INTO task_runs VALUES(5,'t_7265d6b1','flint',NULL,'reclaimed',NULL,NULL,NULL,NULL,NULL,1780470916,1780472603,'reclaimed',NULL,'{"prev_pid": 73380, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}','manual_reclaim lock=macstudio.local:73347');
INSERT INTO task_runs VALUES(6,'t_a368968c','mason',NULL,'done',NULL,NULL,NULL,NULL,NULL,1780471004,1780472137,'completed','NW quadrant pad site survey complete on proc-lab world. Found and marked 3 candidate 9x9 pad sites: candidate_pad_nw_1 at (-39,92,10) — best site, flat 9x9 (-44,5)-(-36,13) Y=91, open grassland, no hazards; candidate_pad_nw_2 at (-39,91,15) — backup 9x9 (-44,11)-(-36,19) Y=91; candidate_pad_nw_3 at (-26,92,-3) — near resources 9x9 (-26,-4)-(-18,4) Y=92. All sites hazard-free (no water/lava/mobs). Steward directed exploration to ~(-40,100,30) area during work.','{"marks_created": ["candidate_pad_nw_1", "candidate_pad_nw_2", "candidate_pad_nw_3"], "sites": {"nw_pad_1": {"coords": [-40, 10], "bbox": {"tl": [-44, 5], "br": [-36, 13]}, "y_level": 91, "flatness": "FLAT", "spread": 1, "hazards": "none"}, "nw_pad_2": {"coords": [-40, 15], "bbox": {"tl": [-44, 11], "br": [-36, 19]}, "y_level": 91, "flatness": "NEAR_FLAT", "spread": 2, "hazards": "none"}, "nw_pad_3": {"coords": [-22, 0], "bbox": {"tl": [-26, -4], "br": [-18, 4]}, "y_level": 92, "flatness": "FLAT", "spread": 1, "hazards": "none"}}, "quadrant_area_scanned": "X=-45 to -18, Z=-5 to 20", "world": "proc-lab"}',NULL);
INSERT INTO task_runs VALUES(7,'t_78f7f904','gatherer',NULL,'done',NULL,NULL,NULL,NULL,NULL,1780471402,1780472371,'completed','Scouted SE quadrant (proc-lab, muster at 4,96,24) for 9×9 pad sites. Found 2 candidates: (1) candidate_pad_se_1 at (19,99,43) — Y99-104 open grassland, 15b from muster, slopes north; (2) candidate_pad_se_2 at (32,98,58) — Y98 very flat open grassland core Z=55-60, 30b from muster. Both marked. SE terrain is open grassland plateau Y96-107, no water. Returned to muster.','{"candidates": [{"name": "candidate_pad_se_1", "center": [19, 99, 43], "bbox": {"x": [15, 23], "z": [39, 47]}, "terrain_y_range": [98, 104], "notes": "Slopes north to Y104, southern edge flat at Y99-100, ~15b from muster"}, {"name": "candidate_pad_se_2", "center": [32, 98, 58], "bbox": {"x": [28, 36], "z": [54, 62]}, "terrain_y_range": [98, 100], "notes": "Very flat core Z=55-60 at Y98-99, open grassland, ~30b from muster"}], "marks_created": ["candidate_pad_se_1", "candidate_pad_se_2"], "world": "proc-lab", "hub": [4, 96, 24], "terrain_type": "open grassland plateau", "terrain_y_range": [96, 107], "structures": ["cobble/oak shelter with oak_door at (16,102,54)"], "water": false}',NULL);
INSERT INTO task_runs VALUES(8,'t_59254ccc','gatherer',NULL,'completed',NULL,NULL,NULL,NULL,NULL,1780472061,1780472061,'completed','SW quad scouted by gatherer — candidate_pad_sw_1 marked at (-3,88,46). Open grassland, copper vein, water pond. No hazards.',NULL,NULL);
INSERT INTO task_runs VALUES(9,'t_7265d6b1','flint',NULL,'reclaimed',NULL,NULL,NULL,NULL,NULL,1780472618,1780473216,'reclaimed',NULL,'{"prev_pid": 28724, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}','manual_reclaim: landfolk stop flint');
INSERT INTO task_runs VALUES(10,'t_cefd4f35','mason',NULL,'reclaimed',NULL,NULL,NULL,NULL,NULL,1780472679,1780473299,'reclaimed',NULL,'{"prev_pid": 30538, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}','manual_reclaim: landfolk stop mason');
INSERT INTO task_runs VALUES(11,'t_1d175784','gatherer',NULL,'crashed',NULL,NULL,NULL,NULL,NULL,1780472679,1780472862,'crashed',NULL,'{"pid": 30539, "claimer": "macstudio.local:30524"}','pid 30539 not alive');
INSERT INTO task_runs VALUES(12,'t_1d175784','gatherer',NULL,'crashed',NULL,NULL,NULL,NULL,NULL,1780472862,1780472983,'crashed',NULL,'{"pid": 35948, "claimer": "macstudio.local:35938"}','pid 35948 not alive');
INSERT INTO task_runs VALUES(13,'t_1d175784','gatherer',NULL,'crashed',NULL,NULL,NULL,NULL,NULL,1780473105,1780473348,'crashed',NULL,'{"pid": 43725, "claimer": "macstudio.local:43722"}','pid 43725 not alive');
INSERT INTO task_runs VALUES(14,'t_7265d6b1','flint',NULL,'reclaimed',NULL,NULL,NULL,NULL,NULL,1780473226,1780473423,'reclaimed',NULL,'{"prev_pid": 47693, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}','manual_reclaim: landfolk stop');
INSERT INTO task_runs VALUES(15,'t_cefd4f35','mason',NULL,'reclaimed',NULL,NULL,NULL,NULL,NULL,1780473348,1780473417,'reclaimed',NULL,'{"prev_pid": 51305, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}','manual_reclaim: landfolk stop');
INSERT INTO task_runs VALUES(16,'t_1d175784','gatherer',NULL,'reclaimed',NULL,NULL,NULL,NULL,NULL,1780473348,1780473420,'reclaimed',NULL,'{"prev_pid": 51306, "host_local": true, "termination_attempted": true, "terminated": true, "sigkill": false}','manual_reclaim: landfolk stop');
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
INSERT INTO sqlite_sequence VALUES('task_events',73);
INSERT INTO sqlite_sequence VALUES('task_runs',16);
INSERT INTO sqlite_sequence VALUES('task_comments',1);
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
