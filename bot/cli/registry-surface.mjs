/**
 * Agent surface tiers for RAW_COMMAND_DEFS (embodied-control two-layer model).
 * core / extended / microscope — absent on CmdDef means extended after apply.
 *
 * Tags informed by scripts/mc-call-survey.py (7d window) + May 2026 fleet stats;
 * re-tune when survey deltas justify it.
 */

/** Working set (~LOOK / GO / DO + common macros). Cap enforced in registry-guardrails.test.js */
export const SURFACE_CORE = new Set([
  'status',
  'observe',
  'inventory',
  'scene',
  'nearby',
  'map',
  'inspect',
  'terrain_top',
  'find',
  'find_blocks',
  'move',
  'goto',
  'goto_near',
  'stop',
  'escape',
  'retrace',
  'through',
  'dig',
  'place',
  'collect',
  'pillar_up',
  'pillar_down',
  'stair_up',
  'stair_down',
  'craft',
  'craft_plan',
  'recipes',
  'smelt',
  'deposit',
  'withdraw',
  'chest_search',
  'mark',
  'marks',
  'go_mark',
  'chat',
  'bg_collect',
  'bg_goto',
  'task',
  'task_context',
  'reachable',
]);

/** Long-tail / admin / advanced — terse lines in generated cheatsheet. */
export const SURFACE_MICROSCOPE = new Set([
  'shield',
  'shoot',
  'sprint_attack',
  'crit',
  'strafe',
  'combo',
  'bg_combo',
  'bg_strafe',
  'sneak',
  'combat_skill',
  'board',
  'disembark',
  'sail',
  'place_boat',
  'fish',
  'regions_reload',
  'regions_terrain',
  'region_update_intent',
  'complete_command',
  'acknowledge_command',
  'cancel_command',
  'construct',
  'blueprint_repair',
  'goals',
  'goal_add',
  'goal_set',
  'goal_remove',
  'goal_status',
  'goal_presets',
  'goal_load',
  'bg_fight',
  'bg_smelt',
  'playbook',
  'playbook_phase_set',
  'playbook_phase_clear',
  'remind',
  'reminders',
  'unremind',
  'screenshot_meta',
  'hunt',
  'lure',
  'breed',
  'shear',
  'milk_cow',
  'corridor_sample',
  'find_entities',
  'pickup',
  'safe_dig',
  'mode',
  'attack',
  'cmds',
  'checkpoint',
  'checkpoint_respond',
  'cancel',
  'bg',
  'task_start',
  'task_pause',
  'task_resume',
  'task_history',
]);

/** @param {{ name: string, surface?: string }[]} defs */
export function applyAgentSurfaceTiers(defs) {
  for (const cmd of defs) {
    if (SURFACE_CORE.has(cmd.name)) {
      cmd.surface = 'core';
    } else if (SURFACE_MICROSCOPE.has(cmd.name)) {
      cmd.surface = 'microscope';
    }
  }
}
