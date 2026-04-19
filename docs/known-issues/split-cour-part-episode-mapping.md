# Split-Cour Part Episode Mapping (Known Issue)

## 1) Problem Summary

The current resolution flow can select the correct **anime family** for split-cour titles, but it still assumes the parsed episode number (for example, `S03E12`) can be used directly against the selected provider entry.

That assumption breaks when a provider stores split-cour parts as separate entries with **part-local episode numbering** (for example, Part 2 episodes `1..11` instead of season-global `12..22`).

Result: the resolver may pick the right title family but still fail to fetch episode metadata because no episode-number remapping is applied.

## 2) Reproduction Context (Dr Stone S03E12 / New World Part 2)

- Input context reaching metadata resolution:
  - `series_title`: `Dr Stone`
  - `season`: `3`
  - `episode`: `12`
- Candidate shapes observed in this branch's test scenarios:
  - `Dr. Stone: New World` (season-family candidate)
  - `Dr. Stone: New World Part 2` (split-cour part candidate)
  - `Dr. Stone: Science Future ...` (sequel-family drift candidate)

When `Part 2` is modeled as an independent entry with ~11 episodes, the direct lookup for episode `12` is incompatible unless remapped to part-local numbering.

## 3) Why current behavior is partially correct

Current behavior is correct in cases where providers expose season-global numbering (or a single consolidated season entry):

- Split-cour family ranking keeps "New World" candidates ahead of unrelated sequel drift.
- Episode compatibility checks block clearly wrong entries (for example, specials with only 1 episode).
- Fallback provider flow still works when another provider exposes compatible numbering.

So the resolver is better at **selecting the right series family**, but it is not yet complete for **cross-part episode numbering translation**.

## 4) What has already been implemented in this branch to mitigate issues

This branch already added several safeguards around the same failure area:

- Episode-aware anime resolution and cache keys (`provider:title:season:episode`) to avoid stale cross-episode reuse.
- Split-cour season-family heuristic in `src/anime.ts` (family bonus, base-query anchor bonus, drift penalties).
- Season-query split-cour drift detection that can force provider fallback instead of accepting a bad top candidate.
- Episode-compatibility gates before episode-title lookup (prevents invalid requests against obviously incompatible entries).
- MPV parse-source/context improvements so parsed season/episode context is more reliable before metadata resolution.

These changes reduce wrong-series selection and stale-cache effects, but they do not remap episode numbers across split-cour parts.

## 5) Remaining gap / future work (episode-number remapping across split-cour parts)

Missing capability: a normalization step that converts season-global episode numbers into part-local numbers when the resolved entry is a split-cour part.

Example target behavior:

- Input context: `S03E12`
- Resolved entry: `New World Part 2` with 11 episodes
- Expected provider request: episode `1` (not `12`)

Without this mapping layer, valid part entries can be incorrectly treated as incompatible.

## 6) Proposed approaches (2-3 options with tradeoffs)

### Option A — Provider-driven dynamic remap

Infer per-part offsets at runtime from provider metadata (related titles, part ordinals, total episode counts).

- **Pros:** no manual catalog; adapts automatically when provider data is good.
- **Cons:** provider schemas differ; extra requests; inference can be brittle on inconsistent metadata.

### Option B — Explicit override map (curated rules)

Maintain a small internal mapping table (title/family + season + part -> offset).

- **Pros:** deterministic and easy to reason about.
- **Cons:** manual maintenance; coverage gaps for less common titles.

### Option C — Hybrid strategy (recommended)

Try dynamic inference first; fallback to explicit override when confidence is low.

- **Pros:** broad coverage with deterministic escape hatch for known hard cases.
- **Cons:** highest implementation complexity; requires confidence scoring and clear precedence rules.

## 7) Suggested acceptance criteria for future fix

1. For `Dr Stone S03E12`, when only `New World Part 2` is available with 11 episodes, episode lookup remaps to part-local episode `1` and returns the correct episode title.
2. For `Dr Stone S03E22`, remap resolves to part-local episode `11` under the same provider model.
3. If a provider already exposes season-global numbering (`total_episodes >= 22`), no remap is applied.
4. Existing protections remain intact:
   - do not regress split-cour family ranking,
   - do not select incompatible specials for high episode numbers,
   - keep provider fallback behavior working.
5. Add test coverage for both paths:
   - global-numbered season entry,
   - part-local numbered split-cour entry requiring remap.
