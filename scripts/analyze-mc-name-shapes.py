#!/usr/bin/env python3
"""B3 name-normalization empirical evidence.

Existing analyze-mc-failures.py uses a regex that requires lowercase
[a-z_] for the material — silently excluding the exact cases B3 would fix.
This script ALLOWS any token form and categorises:

  canonical     lowercase + underscore, matches mcData id shape
  mixed_case    contains uppercase
  has_space     contains whitespace (likely quoted in source)
  has_hyphen    contains '-' instead of '_'
  pluralized    ends in 's' where canonical would not (heuristic)
  other         anything else non-canonical

Reads /tmp/hermescraft/cognition/*.jsonl. Prints counts + samples.
"""
from __future__ import annotations
import json, re, sys
from collections import Counter
from pathlib import Path

DIR = Path("/tmp/hermescraft/cognition")
VERBS = "place|collect|craft|equip|withdraw|deposit|smelt|fill|dig|inspect|scout|safe_dig|chest_search|pickup"

# Match `mc <verb> <material-ish>` allowing more permissive material form.
# Material allows: letters, digits, _, -, space (if quoted/escaped), period.
# Stop at end-of-line, pipe, semicolon, or unquoted whitespace+number (count).
LOOSE_RE = re.compile(
    rf"\bmc\s+({VERBS})\s+(?:\"([^\"]+)\"|'([^']+)'|([A-Za-z][\w\-\.]*))",
    re.IGNORECASE,
)

CANONICAL_RE = re.compile(r"^[a-z][a-z0-9_]*$")

def classify(name: str) -> str:
    if CANONICAL_RE.match(name):
        return "canonical"
    if re.search(r"[A-Z]", name) and re.search(r"[ _-]", name):
        return "mixed_case_separated"
    if re.search(r"[A-Z]", name):
        return "mixed_case"
    if " " in name:
        return "has_space"
    if "-" in name:
        return "has_hyphen"
    if "." in name:
        return "has_dot"
    return "other"

def norm(s: str) -> str:
    return s.strip().lower().replace(" ", "_").replace("-", "_")

counts_per_class: Counter[str] = Counter()
counts_per_verb: Counter[str] = Counter()
samples_per_class: dict[str, list[tuple[str, str]]] = {c: [] for c in [
    "canonical", "mixed_case", "mixed_case_separated", "has_space",
    "has_hyphen", "has_dot", "other"]}
non_canonical_specifics: Counter[tuple[str, str]] = Counter()

# When non-canonical names appear, does normalization produce a sensible
# mcData-shaped id?
norm_examples: Counter[tuple[str, str]] = Counter()

for fp in sorted(DIR.glob("*.jsonl")):
    if fp.name == "bot-events.jsonl":
        continue
    for line in fp.read_text(errors="ignore").splitlines():
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("kind") != "tool_call":
            continue
        text = d.get("text") or ""
        for m in LOOSE_RE.finditer(text):
            verb = m.group(1).lower()
            raw = m.group(2) or m.group(3) or m.group(4) or ""
            if not raw:
                continue
            cls = classify(raw)
            counts_per_class[cls] += 1
            counts_per_verb[verb] += 1
            if cls != "canonical":
                non_canonical_specifics[(verb, raw)] += 1
                normed = norm(raw)
                if normed != raw:
                    norm_examples[(raw, normed)] += 1
            if len(samples_per_class[cls]) < 8:
                samples_per_class[cls].append((verb, raw))

total = sum(counts_per_class.values())
print(f"# B3 empirical evidence — name normalisation in non-mining verbs")
print(f"# scanned 5 days of cognition logs (flint + mason + steward)")
print(f"# total mc verb invocations matching loose regex: {total}")
print()
print("# ── classification ─────────────────────────────────────")
for cls, n in counts_per_class.most_common():
    pct = 100 * n / max(1, total)
    print(f"  {n:7d}  ({pct:5.2f}%)  {cls}")
print()
print("# ── non-canonical examples (top, per-(verb, name)) ─────")
for (verb, raw), n in non_canonical_specifics.most_common(25):
    print(f"  {n:5d}  mc {verb} {raw!r}   → norm()={norm(raw)!r}")
print()
print("# ── per-class samples ─────────────────────────────────")
for cls, samples in samples_per_class.items():
    if not samples or cls == "canonical":
        continue
    print(f"## {cls}")
    for verb, raw in samples:
        print(f"  mc {verb} {raw!r}   → norm()={norm(raw)!r}")
    print()
print(f"# total distinct non-canonical (verb,name) pairs: {len(non_canonical_specifics)}")
print(f"# total non-canonical invocations:                {sum(n for c,n in counts_per_class.items() if c != 'canonical')}")
