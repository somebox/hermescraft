# Establish seed shortlist (operator-curated)

Seeds the operator has vetted as interesting for proc-lab establishment
runs. Use one of these via `--fresh-disc <SEED>` when you don't want
mapcatalog's randomly-picked seed, OR add to the YAML `seed_candidates`
list so they're tried first.

Each row notes distinct biomes within a 64-block radius (cubiomes pass1
output) so the mapping mission can pick high-variety discs and explore
can pick mountainous ones. Biome counts are at `--step 8` on
`MC_1_21` — re-probe with:

```bash
tools/cubiome_scan/proc_biome_scan --seed <SEED> --center 0,0 --radius 64 --step 8 --mc MC_1_21 \
  | jq '[.cells[].biome] | unique'
```

## Mapping-friendly seeds (≥2 distinct biomes at r=64)

| Seed | Distinct biomes | Notes |
|------|----------------:|-------|
| `-266683266992121625`  | 5 | Best of the first batch — high variety (Phase D dry-run — rejected at neighborhood-land check; cliff at spawn) |
| `-32456789431833`      | 4 | Snowy taiga + variants — Phase E run-1 (this seed, 2026-06-04) |
| `300886438233796193`   | 3 (r=32) | **Phase E run-2 (2026-06-04)** — beach + forest + river; warm temperate; flat (Y delta 18) |
| `-2488795730217298217` | 2 | Borderline; meets relaxed `>= 2` gate |

## Saved for later

Not yet probed:

- `300886438233796193`
- `-263062081397200621`
- `-3499551869066673626`
- `8050980546340757092`
- `3184118740466671661`

Probe with `tools/cubiome_scan/proc_biome_scan` before committing to a
run; promote into the first table once vetted.
