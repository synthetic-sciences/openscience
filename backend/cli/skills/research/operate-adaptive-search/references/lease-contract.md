# Adaptive lease contract

An `adaptive-search-v1` lease is evaluator-derived and content-addressed. Its controller snapshot is replayed from final verified candidate events at the lease revision.

## Controller fields

- `eventCount`: verified final events visible when the lease was issued.
- `selectedIsland`: island selected by minimum-visit warmup or decayed-reward UCB.
- `targetIsland`: island authorized for this candidate. Portfolio leases may target a different valid island than the serial selection.
- `visits`: verified final evaluations attributed to the target island.
- `accumulatedImprovement`: EMA of squared, direction-aware, locally normalized positive gains. It decays on every non-improvement and failed evaluation.
- `rewardMean`: decayed globally normalized gain divided by decayed visits. It routes budget; it is not fitness.
- `intensity`: exploration probability derived inversely from accumulated improvement.
- `draw`: deterministic content-derived draw. `explore` must equal `draw < intensity`.
- `globalStagnation`: true only after the patience window and when every active island signal is below the frozen threshold.
- `policySHA256`: commitment to the server-standardized controller policy.

The primary score and declared secondary objectives remain the only fitness. Migration does not receive reward until its newly evaluated artifact earns an improvement.

## Modes

- `single-pass`: independent seed construction.
- `diff`: focused modification of a verified parent.
- `stepwise`: plan, implement, test, diagnose, and revise; use for fusion, migration, exploration, and meta-guided divergence.

The lease ID commits revision, strategy, mode, sorted lineage, target island, context, and controller snapshot. The candidate ID additionally commits branch, proposal, artifact, and reservation provenance.
