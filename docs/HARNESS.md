# Scientific benchmark harness

OpenScience has a benchmark-facing control plane for scientific agents. It binds an immutable run protocol before execution, routes the session through a domain-appropriate method, accepts results only from the bound evaluator, and keeps optimization, evidence, reusable memory, claims, and cost reporting attached to that protocol.

This is a **state-of-the-art-oriented harness architecture**, not a claim of state-of-the-art benchmark performance. A score becomes a SOTA claim only after an official, reproducible run beats the relevant public baseline under a comparable protocol. The harness is designed to make that test difficult to game and easy to audit.

## Design invariants

1. **The task is frozen before the agent runs.** Benchmark identity, version, task, split, evaluator, metric, direction, model, tools, skills, budgets, seed, intervention policy, and contamination policy are hashed into an immutable contract.
2. **The evaluator is outside the agent loop.** The orchestrator holds a bearer capability. OpenScience stores only its SHA-256 digest and never returns the token in the contract.
3. **Self-report is not evidence.** Agent observations cannot promote candidates, support scientific claims, enter verified memory, or qualify learned skills.
4. **Search has lineage and a hard budget.** Every candidate binds its parent(s), branch, proposal, and content-addressed artifact. Only final, externally evaluated passing candidates can become parents.
5. **Cheap screens cannot become final scores.** Optional fidelity stages execute in order. Only the last stage can promote a candidate, enter verified memory, appear as report quality, or qualify a skill.
6. **Scientific validity is domain-specific.** Benchmark adapters select blocking verification packs for statistics, biology, physics, PDEs, chemistry, ML, and forecasting.
7. **Learning is quarantined.** A trajectory can propose a skill, but cannot activate it. Promotion requires paired held-out candidate/control evidence across multiple tasks and an unchanged content hash.
8. **Quality is reported with cost.** Comparable reports include score, pass state, model and intervention metadata, total tokens, wall time, cost, candidate count, and search state.
9. **Coordination must earn its cost.** The contract can pin a topology, or a deterministic policy can choose direct, centralized, fork/join, tournament, or evolutionary execution from bounded task traits. Tool-heavy sequential work is not automatically expanded into a multi-agent swarm.
10. **Evaluation actively looks for blind spots.** An optional evaluator-owned audit uses committed opaque probes, uncertainty reduction, failure UCB, diversity, and stratum coverage. Its estimate must abstain while uncertainty remains above the contract threshold and cannot promote itself into benchmark evidence.
11. **Numerical validation is authenticated and recomputed.** A simulation claim pins the engine, effective problem, reference, convergence order, residual/invariant tolerances, and stress tests. A final pass must cite a passing evaluator receipt for the exact artifact.
12. **Feature attribution is predeclared and paired.** Harness architecture claims require at least three evaluator-authenticated, same-seed baseline/arm pairs frozen before any result exists. Exactly one declared contract factor may differ.
13. **The evaluator must earn trust.** An optional independent auditor capability scores the bound evaluator on a committed hidden suite of clean and realistically faulty outputs. Final passes require a content-addressed qualification receipt whose discrimination, calibration, and per-fault recall clear the frozen thresholds.
14. **Overthinking must earn another round.** Adaptive evolution advances only after a sequential, evaluator-authenticated utility checkpoint. Uncertain measurements cannot stop search, and a target hit or exhausted marginal gain preserves investigation and independent verification instead of declaring success.
15. **A benchmark name is not a runnable integration.** Held-out and release runs must pin an official runner revision, environment, dataset manifest, task manifest, evaluator artifact, and replayable baseline. Search and orchestration remain blocked until the external evaluator proves the complete launch suite and records a content-addressed readiness receipt.
16. **Official means source-identical.** Every named open benchmark adapter records its official repository at an exact commit and, when published separately, its dataset source. A launch using a fork, replacement runner, or replacement dataset is rejected rather than reported under the official benchmark name. Methodology families are labeled as such, and public reproduction subsets cannot be bound as hidden or release runs.
17. **A clean score requires a clean execution trace.** A strict runtime-integrity protocol commits its validator, trace schema, assigned model, forbidden model artifacts, independent contamination/API/lookup auditors, and hidden canaries before execution. Final success requires a content-addressed receipt for the exact run or candidate; OpenScience derives the six gates and rejects missing, failed, substituted, post-hoc, or cross-subject receipts.
18. **Native interfaces stay native.** A source-verified execution recipe records the official environment, entrypoint, ordered stages, typed bindings, produced artifacts, score selectors, and known limitations. CLI benchmarks remain argv contracts and Python libraries remain Python API contracts. Held-out or release runs for a verified recipe must bind its exact recipe and launch-driver digests; an unrelated generic command cannot pose as the official benchmark.

## System boundary

```mermaid
flowchart LR
    O["Benchmark orchestrator\nsecret evaluator capability + hidden tests"]
    L["Official benchmark launcher\npinned runner + data + baseline"]
    N["Source-verified native recipe\ntyped bindings + artifacts + metric"]
    C["Immutable run contract"]
    A["OpenScience agent session\nprofile + domain packs"]
    Q["Conditional scientific coalition\npersisted role DAG + bounded workers"]
    G["Candidate graph\nindependent roots + lineage"]
    E["External evaluator\nstaged checks + score + usage"]
    V["Independent evaluator auditor\ncommitted clean + fault suite"]
    W["Evaluator qualification\nbackend-recomputed metrics"]
    U["Active audit\nopaque committed probes + GP posterior"]
    I["Evaluator-owned runtime monitor\ntrace + model lineage + hidden canaries"]
    X["Runtime integrity receipt\nbackend-derived six-gate outcome"]
    J["Immutable evaluation journal"]
    M["Verified hindsight memory"]
    K["Scientific claim ledger"]
    S["Quarantined skill lifecycle"]
    R["Quality-cost report"]

    O -->|bind| C
    O -->|authenticated launch checks| L
    O -->|materialize exact native interface| N
    N -->|recipe + driver commitments| L
    L -->|readiness receipt| C
    C --> A
    A --> Q
    Q --> G
    G -->|artifact| E
    O --> E
    V -->|separate capability| W
    E -->|hidden-suite decisions| W
    W -->|qualification receipt| E
    E --> U
    U --> E
    A -->|sandbox, network, and model events| I
    O --> I
    I -->|authenticated evidence| X
    X -->|required receipt| E
    E -->|authenticated result| J
    J --> G
    J --> M
    J --> K
    J --> S
    J --> R
```

The bearer capability and hidden tests must live in a separate process, container, VM, or account that the agent cannot inspect. Application-level hashing prevents accidental drift and API forgery; it is not an operating-system sandbox. OpenScience's ordinary agent runtime can execute local code, so a same-user process with unrestricted filesystem access is outside this threat model.

## Run lifecycle

### 1. Bind

The orchestrator calls `POST /harness/runs` before the model sees the task. The request selects a version-agnostic adapter and supplies the exact benchmark version and evaluator protocol.

```json
{
  "schemaVersion": 1,
  "runID": "mle-2026-08-task-17-seed-3",
  "sessionID": "session-id",
  "benchmark": "mle",
  "version": "official-release-sha-or-version",
  "taskID": "competition-id",
  "split": "held_out",
  "evaluator": {
    "name": "official-evaluator",
    "version": "evaluator-sha",
    "source": "benchmark",
    "token": "out-of-band-secret-with-at-least-32-characters"
  },
  "objective": "Maximize the official held-out score",
  "orchestration": {
    "topology": "evolution",
    "maxWorkers": 2,
    "maxRounds": 3,
    "minIndependentVerifiers": 2,
    "adaptive": {
      "protocolVersion": "marginal-utility-v1",
      "minRounds": 2,
      "patience": 1,
      "minUtilityGain": 0.02,
      "maxUncertainty": 0.05,
      "targetUtility": 0.95
    }
  },
  "audit": {
    "mode": "hybrid",
    "budget": 50,
    "minSamples": 10,
    "tolerance": 0.02,
    "maxUncertainty": 0.05,
    "targetFailures": 8
  },
  "launch": {
    "protocolVersion": "benchmark-launch-v1",
    "runner": {
      "repository": "https://github.com/openai/mle-bench",
      "revision": "507f92e1138bb6e40dac5c6ee7a6758e6424bf97",
      "entrypoint": "mlebench/cli.py",
      "commandSHA256": "1111111111111111111111111111111111111111111111111111111111111111",
      "environmentSHA256": "2222222222222222222222222222222222222222222222222222222222222222",
      "recipeSHA256": "abababababababababababababababababababababababababababababababab",
      "driverSHA256": "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
    },
    "dataset": {
      "name": "official-held-out-data",
      "source": "https://example.org/official-dataset",
      "revision": "release-2026-08",
      "manifestSHA256": "3333333333333333333333333333333333333333333333333333333333333333"
    },
    "taskManifestSHA256": "4444444444444444444444444444444444444444444444444444444444444444",
    "evaluatorSHA256": "5555555555555555555555555555555555555555555555555555555555555555",
    "validatorSHA256": "7777777777777777777777777777777777777777777777777777777777777777",
    "baseline": {
      "name": "official-reference-baseline",
      "artifactSHA256": "6666666666666666666666666666666666666666666666666666666666666666",
      "expectedScore": 0.5,
      "tolerance": 1e-9
    }
  },
  "recipe": {
    "recipeID": "mlebench-official-v2",
    "bindings": {
      "competitionList": "manifests/competitions.txt",
      "dataDir": "datasets/mlebench",
      "submissionManifest": "submissions/run.jsonl",
      "outputDir": "results/grading"
    }
  },
  "integrity": {
    "protocolVersion": "benchmark-integrity-v1",
    "validatorSHA256": "8888888888888888888888888888888888888888888888888888888888888888",
    "traceSchemaSHA256": "9999999999999999999999999999999999999999999999999999999999999999",
    "minEvents": 100,
    "minCoverage": 0.99,
    "assignedModel": {
      "name": "assigned-base-model",
      "baseArtifactSHA256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "configSHA256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    "forbiddenModelArtifacts": ["cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"],
    "policy": {
      "testItemDerivation": "forbidden",
      "unapprovedExternalModels": "forbidden",
      "benchmarkLookup": "forbidden"
    },
    "auditors": [
      {
        "kind": "test_item_contamination",
        "name": "contamination-auditor",
        "version": "1",
        "promptSHA256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      },
      {
        "kind": "external_model_use",
        "name": "api-auditor",
        "version": "1",
        "promptSHA256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
      },
      {
        "kind": "benchmark_lookup",
        "name": "lookup-auditor",
        "version": "1",
        "promptSHA256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      }
    ],
    "hiddenCanaryManifestSHA256": "1212121212121212121212121212121212121212121212121212121212121212",
    "minHiddenCanaries": 8
  },
  "simulation": {
    "kind": "pde",
    "engine": {
      "name": "reference-solver",
      "version": "1.2.3",
      "commandSHA256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "configSHA256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    "problemSHA256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "reference": {
      "kind": "manufactured",
      "identity": "manufactured-solution-v1",
      "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    },
    "validation": {
      "errorNorm": "relative L2",
      "minLevels": 3,
      "maxLevels": 6,
      "expectedOrder": 2,
      "orderTolerance": 0.2,
      "maxResidual": 1e-8,
      "invariantTolerances": { "mass_drift": 1e-6 },
      "requiredStressTests": ["solver_tolerance_sensitivity", "reference_replay"]
    }
  },
  "metric": { "name": "score", "direction": "maximize" },
  "fidelities": [
    { "id": "smoke", "final": false, "maxWallTimeMs": 300000 },
    { "id": "official", "final": true, "maxWallTimeMs": 43200000 }
  ],
  "model": { "provider": "provider", "name": "model", "effort": "high" },
  "tools": ["read", "bash", "edit"],
  "skills": [],
  "budget": { "steps": 200, "candidates": 30, "tokens": 1000000, "costUSD": 100 },
  "seed": 3,
  "intervention": "autonomous",
  "contamination": {
    "policy": "Hidden tests and outputs stay outside the agent process",
    "hiddenTestsAccessible": false,
    "publicDataCutoff": "2026-08-01"
  },
  "createdAt": 1785859200000
}
```

Rebinding the session with any changed field or evaluator capability fails.

#### Prove launch readiness before execution

Every catalog manifest reports `execution: external_runner_required`: the adapter supplies scientific methodology and routing, not a bundled official runner. A held-out or release bind is rejected unless it includes `benchmark-launch-v1`. The external evaluator must then submit all eight checks to `POST /harness/launches/receipts`:

Catalog entries distinguish three source states:

- `official_open` pins the official repository commit, integration-critical paths, and published dataset source;
- `official_subset` identifies a public reproduction subset, its exact scope, and its integrity files; and
- `methodology_only` makes explicit that the adapter is a reusable scientific method, not an official benchmark integration.

They separately distinguish recipe readiness: `source_verified` means the native driver, environment anchors, artifacts, and metric selectors have been inspected at the pinned revision; `pending_source_verification` means the source is pinned but the executable contract is not yet trusted; `blocked_upstream` cites a pinned source path containing a concrete blocker that prevents an unchanged official launch; and `not_applicable` is reserved for methodology families without one official runner. OpenScience currently publishes source-verified recipes for BixBench, Biomni-Eval1, PDEBench, ChemBench, MatSciBench, MLE-bench, ALE-Bench, ResearchClawBench, PaperBench grading, and SciCode. PostTrainBench is upstream-blocked on its HTCondor-only launcher, and WeatherBench2 is upstream-blocked because its current script marks an undeclared flag as required. These statuses are deliberately narrower than “runnable”: real data, credentials, evaluator isolation, replay artifacts, and baseline evidence still have to pass launch readiness.

Materialize a verified recipe with `POST /harness/benchmarks/:benchmark/recipe`. Recipe v2 bindings are typed as confined relative paths, identifiers, integers, or closed choices; stage inputs, outputs, and file artifacts are checkout-relative, while a driver may explicitly document a path relative to its confined working directory. Python stages name prior-stage receivers, evaluator-supplied values bind to named parameters, and integer bindings materialize as numbers rather than stringly typed kwargs. Return artifacts identify the exact produced value; file artifacts enforce match cardinality; metric extraction uses typed JSON-path, CSV-column, pickle-tuple, or text-ratio selectors. The materializer rejects missing or undeclared keys, dangling or forward value references, duplicate values, ambiguous artifacts, absolute and escaping paths, invalid identifiers, out-of-range integers, substituted choices, and recipe/benchmark mismatch. Its output preserves the official interface rather than flattening it: BixBench and MLE-bench use argv stages; ChemBench and Biomni use their Python APIs; PDEBench preserves its exact one-dimensional advection FNO Hydra overrides, derived checkpoint/result names, and six evaluator metrics; MatSciBench fixes a model registry entry to preserve credential and filename semantics; ALE-Bench preserves its official 15-sample/16-refinement launcher; PaperBench preserves rubric-tree grading; SciCode preserves executable numeric tests; and ResearchClawBench preserves its batch CLI plus built-in workspace scoring.

Use `run-benchmark-pilot` to preflight and execute a materialized v2 recipe in the evaluator-owned environment before constructing a held-out launch protocol. Its runner verifies clean Git/source state, commitments, anchors, environment files, runtime adapters, secrets by name, stage inputs/outputs, and initially absent artifacts; it executes argv without a shell, preserves named Python object flow, hashes logs and artifacts, enforces cardinality, extracts typed metrics, and returns a content-addressed pilot receipt. A pilot proves integration conformance, not an official score: promote it only after `verify-benchmark-launch` binds deterministic replay, hidden isolation, artifact round-trip, and baseline evidence.

For a named official adapter, the bound runner repository and commit must match the catalog pin, and a separately published dataset must match its catalog source. OpenScience deliberately rejects source-substituted launches. GeneBench-Pro is currently cataloged as the 10-case public package out of 129 total cases, so it can support validation and reproduction but cannot be labeled as a hidden or release benchmark run.

Use the bundled `audit-benchmark-sources` skill to maintain those records. Its executable auditor fetches every pinned commit without blobs, verifies the catalog-declared runner/evaluator paths at that commit, resolves the current default head, probes separately published dataset endpoints, validates public-subset cardinality, and emits a content-addressed report. An unreachable pin, missing required path, unresolved head, unavailable dataset, or future-dated check fails the audit. A newer upstream head or an old check date creates a review item but never moves a trusted pin automatically. Updating a pin requires inspecting upstream changes and rerunning `verify-benchmark-launch` against the proposed revision.

- clean checkout at the exact 40- or 64-character source revision;
- locked environment replay;
- exact task-manifest load;
- exact evaluator load;
- hidden-data boundary isolation;
- deterministic replay;
- artifact round-trip; and
- pinned baseline replay.

Use the bundled `verify-benchmark-launch` skill from the evaluator-owned launcher to inspect the real Git checkout, environment locks, dataset and task bytes, evaluator bytes, hidden-mount canaries, replay outputs, serialization round trip, and public baseline. For a source-verified adapter, give the validator the exact materialized recipe artifact; it independently verifies the artifact bytes, native launch-stage driver digest, recipe commitment, and entrypoint. Bind the report's `protocol` before agent execution, then submit its `validator`, `checks`, `baselineScore`, and evidence. The contract pins the validator script SHA-256; the receipt is rejected if its exact executable does not match.

OpenScience derives the pass state. It rejects a partial or substituted check set, a substituted validator, and recomputes baseline error against the frozen tolerance. Failed attempts remain in the append-only journal. Receipts bind the full contract fingerprint, evaluator identity, protocol, validator and manifest identity, evidence, evaluator timestamp, and server-owned record time into their SHA-256 identity; edited storage fails validation. A separate content-derived submission ID preserves retry idempotence without trusting the submitter's clock. The bearer capability never enters the receipt.

Search and scientific orchestration will not initialize until a passing receipt exists. Every final passing evaluation must cite the exact receipt and must occur after it. This separates four states that older catalog-only integrations conflated: supported methodology, bound official protocol, launch-ready runner, and externally verified result.

#### Prove runtime integrity before accepting a score

Launch readiness proves that the official substrate loaded correctly; it does not prove that the candidate avoided test-specific training-data derivation, an unauthorized model API, model substitution, benchmark lookup, or trace omission while optimizing. A run can therefore bind `benchmark-integrity-v1`. The contract freezes:

- the exact validator and normalized trace-schema SHA-256;
- minimum event count and coverage;
- assigned base-model weights/config and known forbidden model artifacts;
- the strict test-item derivation, unapproved external-model, and benchmark-lookup policy;
- three distinct audit identities and prompt commitments; and
- the hidden-canary manifest and minimum coverage.

Use the evaluator-owned `verify-benchmark-integrity` skill to inspect a real JSONL trace captured outside the candidate sandbox. Its executable validator rejects sequence gaps and time reversal, hashes the trace, counts explicit dropped events, unapproved model calls, benchmark lookups, unique hidden canaries, and violations, checks measured model-lineage fields, and preserves independent `clean`, `flagged`, or `abstain` auditor decisions. It emits a token-free submission so the evaluator capability is injected only in memory at the authenticated API boundary.

`POST /harness/integrity/receipts` rejects a changed protocol, validator, auditor identity, pre-contract trace, future or pre-trace timestamp, nonexistent candidate, or artifact mismatch. The backend then derives exactly six checks: trace completeness, model identity, test-item contamination, external-model use, benchmark lookup, and hidden canaries. It stores the full evidence as a content-addressed, append-only receipt and re-derives its outcome whenever the journal is read. A final pass must reference a passing receipt recorded earlier for the same run or candidate; failed receipts remain durable evidence.

This is intentionally not a claim that one script can infer semantic contamination. Observable calls and canaries are derived programmatically; contamination classification remains a precommitted independent audit. The trace producer, model measurement, auditors, hidden tests, and capability must therefore remain beyond the candidate's operating-system boundary.

### 2. Execute through a profile

The contract overrides heuristic routing. Unbound interactive sessions use a conservative `react` default and select a specialized profile only from strong task signals.

| Profile     | Intended work                                       | Required discipline                                                |
| ----------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| `react`     | Direct tool-using tasks                             | Smallest reliable execution path                                   |
| `optimize`  | MLE, algorithm, or score optimization               | Candidate lineage, external scores, bounded exploration            |
| `reproduce` | Papers, published analyses, and benchmark artifacts | Claim extraction, protocol replay, clean verification              |
| `theory`    | Analytical physics and mathematical derivation      | Assumptions, dimensions, limits, independent route                 |
| `numerical` | PDEs and simulation                                 | Equation/BC/IC pinning, stability, convergence, reference solution |
| `training`  | Fine-tuning and post-training                       | Data/model identity, checkpoints, held-out evaluation, compute     |
| `forecast`  | Weather and spatiotemporal prediction               | Lead-time portfolio, calibration, leakage, baseline, compute       |

### 3. Orchestrate only when justified

`POST /harness/runs/:sessionID/orchestration` freezes a deterministic role graph beside the immutable contract. Its selector considers decomposability, sequentiality, tool intensity, uncertainty, verification risk, novelty, cross-domain structure, and available coordination budget.

| Topology      | Use case                                               | Role structure                                                          |
| ------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `solo`        | Small-budget, sequential, or low-coordination work     | One direct generation unit                                              |
| `centralized` | Tool-heavy or high-risk work with limited parallelism  | Generate → reflect → independently verify                               |
| `fork_join`   | Decomposable analytical and computational work         | Generate ∥ simulate → synthesize → independently verify                 |
| `tournament`  | Uncertain, verification-sensitive hypothesis selection | Independent generation → cluster → reflect → pairwise rank → verify     |
| `evolution`   | Novel, open-ended search                               | Generate → cluster → reflect → rank → evolve/diverge, repeated by round |

Every work unit has a content-derived identity, ordered dependencies, a role-specific agent, and a proportional allocation from the contract budget. A role can settle only from a fresh child session after all dependencies complete. Failure cancels transitive descendants without erasing independent roots. Restarts reload the exact graph rather than re-planning it.

Upstream communication is deliberately bounded to summaries plus artifact and evidence references. Verifiers run in distinct child sessions, cannot see each other's verdicts, and must return `support`, `reject`, or `abstain` with calibrated confidence and evidence-backed checks. The harness aggregates only after the whole panel settles: one verdict is `insufficient`, unanimous support/rejection is preserved, and any split or abstaining panel is `disputed`. Internal reflection, ranking, verification, and consensus remain provisional; only the evaluator-authenticated journal can establish benchmark performance or scientific support.

Evolution may additionally bind `adaptive.protocolVersion = marginal-utility-v1`, a minimum round count, patience, minimum normalized utility gain, maximum uncertainty, and optional target utility. Every round then ends in `awaiting_checkpoint`: the next round remains locked until the out-of-band evaluator submits an evidence-backed checkpoint with its bearer capability. Checkpoints are sequential, immutable, server-timestamped, and cannot predate the completed work they assess. High-uncertainty measurements cannot trigger early stopping. A qualified target hit or a predeclared sequence of low marginal gains cancels unused future search, then dynamically reconnects the latest two candidates to failure investigation and the full blinded verification panel. The agent-facing tool cannot submit these checkpoints or award itself more budget.

### 4. Search without erasing failures

The optimizer is an open candidate graph rather than a single mutable working file.

- Candidate IDs hash parents, branch, proposal, artifact URI, and artifact SHA-256.
- The graph admits multiple independent roots early, bounded by `min(4, max(2, ceil(sqrt(candidate budget))))`.
- A root must use a distinct branch while another live root with that branch exists.
- Descendants require final, evaluator-verified passing parents. A cheap screening pass is insufficient.
- Early selection opens independent roots and then applies branch-level UCB-style exploration with minimum-visit protection.
- After half the candidate budget, selection exploits the strongest verified branch.
- At the configured stall threshold it fuses two strong, distinct branches. At twice that threshold it recommends a strategy-level mutation while preserving the best parent.
- Self-reported observations remain visible for debugging but cannot enter elite state or lineage.
- Passing, failing, and inconclusive final evaluations are immutable and retained as hindsight.

This combines breadth, exploitation, fusion, and escape from strategy stagnation without allowing the model to award itself fitness.

### 5. Cascade evaluation

Fidelity plans contain two to eight unique stages and exactly one final stage, which must be last. The journal enforces stage order per run or candidate. Every prior stage must pass all blocking checks before the next result can be recorded.

If a stage declares a wall-time or cost cap, the evaluator must report the corresponding usage and the result is rejected when it exceeds the cap. Screening evaluations can cull candidates and attach feedback, but cannot:

- become the search best;
- create descendants;
- satisfy final domain packs;
- enter verified retrospective memory;
- become the quality score in a report; or
- qualify a learned skill.

### 6. Actively audit performance and failure regions

An active audit is part of the external evaluator boundary. The run contract freezes its mode, budget, minimum sample count, kernel/noise settings, confidence multiplier, failure threshold, precision and abstention thresholds, objective weights, and optional failure target.

The evaluator initializes an audit with an immutable subject artifact plus two to 2,000 probe records. Each probe contains only:

- an opaque ID;
- a SHA-256 commitment to the hidden case bytes;
- a bounded numeric feature vector;
- a stratum label;
- an evaluation weight; and
- a prior loss estimate.

The hidden prompt, target, and expected output never enter OpenScience. Numeric features are standardized inside the audit before applying an RBF Gaussian-process surrogate.

At each round, the audit selects exactly one probe. Performance mode maximizes the reduction in weighted integral variance. Failure mode combines posterior loss UCB with distance from already-discovered failures and under-covered strata. Hybrid mode combines both acquisitions using the contract weight. Selection is deterministic, persisted, and restart-idempotent.

Only the bound evaluator capability can initialize, select, read, or submit outcomes. An observation must cite evidence, cannot be changed later, and must label failure consistently with the frozen loss threshold. The audit stops on its sample budget, pool exhaustion, requested failure count, or—outside pure failure mode—sufficient posterior precision after the minimum sample count.

The report carries posterior mean loss, standard deviation, a clipped 95% interval, failure count, stratum coverage, and an explicit abstention bit. This is an audit estimate, not an official result. The external evaluator must attach its receipt to an ordinary authenticated evaluation before it can affect benchmark state.

### 7. Authenticate numerical simulation claims

An optional simulation contract freezes the physical and numerical protocol before execution: simulation kind; engine name/version; hashes of the effective command, configuration, and complete problem statement; reference kind/identity/hash; error norm; refinement range; expected order; residual and invariant tolerances; and mandatory stress tests.

The bound evaluator submits level measurements and evidence to `POST /harness/simulations/receipts`. OpenScience does not accept a producer-supplied pass flag. It recomputes decreasing resolution/error, requires every local observed convergence order to meet the frozen threshold, and checks residual bounds, every declared invariant, and the exact stress-test set. Both passing and failed receipts remain append-only and content-addressed.

A candidate receipt must name the candidate's exact artifact URI and SHA-256 from the search graph. A run receipt binds its output artifact to the run. A final passing evaluation under a simulation contract must cite a passing receipt for the same run or candidate; a missing, failed, wrong-contract, or wrong-artifact receipt blocks promotion. The capability and hidden reference outputs remain outside the agent process.

### 8. Verify with domain packs

Final passing results must contain evidence-backed receipts for every blocking check selected by the adapter.

| Pack       | Representative blocking checks                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------- |
| Statistics | estimand, assumptions, effect size, uncertainty, multiplicity, exact replay                        |
| Biology    | identifiers, design, QC, batch structure, covariates, multiplicity, biological validity            |
| Physics    | assumptions, units, conventions, limiting cases, conservation, independent derivation              |
| PDE        | equation, domain, BC/IC, discretization, convergence, stability, invariants, reference, error norm |
| Chemistry  | identity, standardization, valence, stereochemistry, conditions, split leakage, physical validity  |
| ML         | data/model identity, held-out split, leakage, baseline, metric, seed variance, compute             |
| Forecast   | dataset/init/grid/leads, full metric portfolio, mode, calibration, temporal leakage, compute       |

An adapter can require no universal pack when the benchmark spans incompatible task types; the orchestrator may add task-specific packs at bind time. Pack selection is frozen in the contract and comparison key.

### 9. Reuse only verified hindsight

Retrospective entries are scoped by benchmark name, version, task, and evaluator. They contain the exact candidate artifact reference, branch, generation, external outcome, score, metrics, evidence references, evaluator feedback, and evaluation usage.

Retrieval combines query overlap, task affinity, and workflow stage. It deliberately returns a relevant contrasting failure beside a success when possible. Retrieved text is escaped, length-bounded, and explicitly labeled as precedent data rather than instructions.

### 10. Keep claims separate from execution reports

The claim ledger supports descriptive, statistical, causal, mechanistic, theoretical, and performance claims. Status is derived from verified evidence, never assigned by the agent.

- Observations can make a claim provisional, but not supported.
- A refuting verified source wins over supporting sources.
- Support requires the claim's blocking checks and enough distinct independence keys.
- Headline performance claims must bind an immutable artifact SHA-256.
- Clean replay, independent implementation, and independent derivation require a separate verifier session, fresh process, clean workspace, and exact source hash.
- Independent implementation/derivation additionally withhold the producer's output and require independent code or reasoning.

### 11. Promote skills only after held-out qualification

`/learn` and RSI distillation write inert proposals under `learned-skill-proposals`; skill discovery reads only promoted content under `learned-skills`.

Before a proposal exists, OpenScience checks its frontmatter, runtime-risk patterns, prompt-injection patterns, and suspicious content. The proposal is then immutable by content hash. Promotion requires:

- otherwise-identical candidate and control contracts;
- the candidate contract pinned to the exact proposed skill SHA-256;
- evaluator capabilities for both runs;
- held-out or release splits;
- at least three distinct benchmark tasks;
- at least two strict score improvements;
- no candidate failure and no regression;
- a held-out skill-trigger set with at least 20 examples; and
- trigger precision and recall of at least 0.8 for every attestation.

If later evidence introduces a regression before promotion, qualification returns to pending. Promoted content cannot accept more evidence; changes require a new versioned proposal.

### 12. Execute benchmark-native protocol skills

The bundled skill catalog includes executable protocols for work that is otherwise easy to describe but hard to audit:

| Skill                        | Executable contract                                                                                                                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active-failure-audit`       | Converts evaluator-private JSONL cases into a public manifest of opaque IDs and SHA-256 commitments without copying hidden case content.                                                                          |
| `simulator-validation`       | Rejects refinement studies that miss decreasing resolution/error, expected convergence order, residual bounds, or declared invariants.                                                                            |
| `scientific-ablation-design` | Rejects attribution plans without exactly one budget-, seed-, split-, and evaluator-matched isolation arm for every predeclared mechanism.                                                                        |
| `verify-benchmark-launch`    | Inspects an exact Git checkout, locks, task/data/evaluator bytes, hidden boundary, deterministic replay, artifact round trip, and pinned baseline before official execution.                                      |
| `run-benchmark-pilot`        | Preflights and executes a source-pinned recipe v2 outside the candidate session, preserving native argv/Python value flow and emitting hashed stage, artifact, and typed-metric evidence.                         |
| `audit-benchmark-sources`    | Fetches every official pin, verifies required paths and datasets, checks subset cardinality, and reports upstream drift without silently changing trusted revisions.                                              |
| `verify-benchmark-integrity` | Validates evaluator-owned trace structure, derives observable model/lookup/canary counts, verifies committed auditor identities, and builds the token-free input for a backend-derived runtime-integrity receipt. |

Their scripts return machine-readable JSON and nonzero failure codes, so an orchestrator can use them as blocking gates instead of relying on prompt compliance. They validate the protocol and reported measurements; they do not manufacture hidden data, run an unavailable simulator, or turn an internal result into official benchmark evidence.

### 13. Attribute gains with matched ablations

`POST /harness/ablations` freezes a server-timestamped study before any paired evaluation exists. A study supports `profile`, `orchestration`, active `audit`, `simulation`, `evaluator_audit`, `fidelities`, and named `skill` or `tool` factors. It requires at least three distinct seeds on a held-out or release split. Within each seed, baseline and arm must have identical objectives, benchmark/evaluator protocol, packs, model, remaining tools/skills, budget, intervention, contamination policy, and seed after removing exactly the declared factor. Across pairs, every non-seed field and both factor values must remain identical.

The plan stores contract fingerprints plus hashes of the baseline value, arm value, and matched context; evaluator capabilities are never persisted. Initialization fails if any paired session already has an evaluation. Every accepted evaluation receives a server-owned receipt time, and assessment rejects receipts older than the plan, closing concurrent initialization races without trusting evaluator-supplied clocks.

After all runs settle, `POST /harness/ablations/:planID/assessment` reauthenticates every session, checks the frozen contract fingerprints, selects the final evaluator-verified run or best candidate outcome, and computes direction-aware paired effects. It reports the mean, sample standard deviation, standard error, a 95% paired Student interval, practical-effect threshold, and pair-level regressions. Support requires the interval's lower bound to exceed the predeclared minimum effect and no pair to violate the regression tolerance. Missing/failed pairs or a forbidden regression reject the attribution; an interval overlapping the threshold remains inconclusive.

The resulting content-addressed receipt establishes matched evidence for one declared harness mechanism. It does not by itself establish benchmark SOTA, generalize beyond the bound task, or rescue an incompatible official comparison.

### 14. Qualify the evaluator before trusting a pass

Authentication proves who submitted an evaluation; it does not prove that evaluator is competent. A run can therefore bind an `evaluatorAudit` protocol with an auditor identity and bearer capability distinct from the evaluator, a hidden-suite commitment, minimum clean and per-fault case counts, required fault classes, and thresholds for sensitivity, specificity, balanced accuracy, Brier score, and recall for every required fault.

The suite commitment is the SHA-256 returned by `HarnessJudge.commitment` over the case ID, content commitment, clean/fault label, and fault class sorted by ID; evaluator decisions are deliberately excluded. The independent auditor then submits those opaque fields plus the evaluator's accept/reject/abstain decision, failure probability, and evidence references to `POST /harness/evaluators/qualifications`. Substituting even one hidden case or label fails the frozen commitment. OpenScience recomputes the confusion matrix, calibration loss, aggregate rates, and per-class recall. Abstentions do not silently count as correct. The resulting receipt is immutable and content-addressed; neither bearer capability is stored.

A passing final evaluation under this protocol must cite a passing receipt recorded before the evaluation. The receipt must match the exact evaluator name, version, source, audit protocol, suite commitment, and independent auditor. Failed evaluations can still be retained without qualification, so this gate cannot erase negative evidence. Qualifications may be reused across runs only when the entire evaluator/audit identity is identical.

This mechanism does not claim that a finite meta-evaluation suite makes a judge infallible. It prevents an authenticated but untested judge from silently becoming ground truth and makes evaluator quality a versioned, ablatable part of the benchmark protocol.

### 15. Compare only compatible runs

Reports choose only a final evaluation. Their comparison key hashes benchmark, version, task, split, evaluator identity/source, fidelity, launch, runtime-integrity, simulation, and evaluator-audit protocols, metric, direction, target, domain packs, and contamination policy. Cross-task or cross-protocol comparisons fail instead of normalizing unlike scores. Reports surface the launch, integrity, simulation, and evaluator-audit receipts used by the selected final evaluation.

Cost and wall time include both the agent trace and evaluator-reported stage usage. Direction-aware score deltas and the Pareto frontier are available through `POST /harness/compare`.

## Adapter catalog

An adapter manifest is a methodology and routing map, not an embedded copy of a benchmark runner and not evidence that the benchmark currently executes. Every manifest therefore declares `external_runner_required`. The official launcher owns workspace construction, hidden data, evaluator code, and task-specific score semantics; a concrete run pins those facts in its launch protocol and proves them with a readiness receipt before the harness executes.

| Family                    | Adapters                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| Data/statistics           | Statistical methodology, DiscoveryBench                                                                 |
| Biology                   | BixBench, LifeSciBench/life-science tasks, GeneBench/GeneBench-Pro, BioMni, LABBench2                   |
| Physics                   | Pure/agentic physics, PDE tasks, CritPt                                                                 |
| Chemistry/materials       | ChemBench, MatSciBench                                                                                  |
| ML                        | MLE-bench, post-training, ALE, weather, PaperBench                                                      |
| General scientific agents | ResearchClawBench, reproducibility CORE-Bench, ScienceAgentBench, SciCode, SciAgentArena, AInsteinBench |

Every adapter is version-agnostic. A development/validation run must still bind an exact benchmark version, evaluator version, task ID, split, metric, budget, seed, and contamination policy. A held-out/release run additionally requires an exact official launch protocol and passing readiness receipt. Catalog presence alone must never be reported as runnable benchmark coverage.

## HTTP API

| Method | Route                                                | Purpose                                                       |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------- |
| `GET`  | `/harness/benchmarks`                                | List adapter manifests                                        |
| `POST` | `/harness/benchmarks/:benchmark/recipe`              | Materialize a typed source-verified native execution recipe   |
| `POST` | `/harness/runs`                                      | Bind the immutable run and hashed evaluator capability        |
| `POST` | `/harness/runs/:sessionID/orchestration`             | Select and initialize a persisted scientific role DAG         |
| `GET`  | `/harness/runs/:sessionID/orchestration`             | Resume the current orchestration state                        |
| `POST` | `/harness/runs/:sessionID/orchestration/checkpoints` | Gate evolution using evaluator-authenticated marginal utility |
| `POST` | `/harness/audits`                                    | Commit an evaluator-owned opaque active-audit pool            |
| `POST` | `/harness/audits/:auditID/status`                    | Read capability-protected posterior and stopping state        |
| `POST` | `/harness/audits/:auditID/selection`                 | Select the next opaque probe commitment                       |
| `POST` | `/harness/audits/:auditID/observations`              | Record an immutable evaluator-authenticated probe outcome     |
| `POST` | `/harness/ablations`                                 | Freeze a same-seed, one-factor matched ablation               |
| `POST` | `/harness/ablations/:planID/assessment`              | Derive an immutable paired-effect assessment                  |
| `POST` | `/harness/evaluators/qualifications`                 | Audit a judge on a committed hidden fault suite               |
| `POST` | `/harness/evaluators/qualifications/:id`             | Read a qualification with the independent auditor capability  |
| `POST` | `/harness/launches/receipts`                         | Recompute and record official benchmark launch readiness      |
| `POST` | `/harness/launches/receipts/:id`                     | Read a capability-protected launch readiness receipt          |
| `POST` | `/harness/integrity/receipts`                        | Derive and record runtime-integrity gates                     |
| `POST` | `/harness/integrity/receipts/:id`                    | Read a capability-protected runtime-integrity receipt         |
| `POST` | `/harness/simulations/receipts`                      | Recompute and record a simulator validation receipt           |
| `POST` | `/harness/simulations/receipts/:id`                  | Read a capability-protected simulator validation receipt      |
| `POST` | `/harness/evaluations`                               | Record a staged evaluator-authenticated result                |
| `GET`  | `/harness/runs/:sessionID/contract`                  | Inspect the bound protocol                                    |
| `GET`  | `/harness/runs/:sessionID/evaluations`               | Inspect the immutable evaluation journal                      |
| `GET`  | `/harness/runs/:sessionID/report`                    | Build a quality-cost report                                   |
| `POST` | `/harness/compare`                                   | Compare compatible reports and identify Pareto-efficient runs |
| `GET`  | `/harness/skills`                                    | List quarantined skill proposals and qualification state      |
| `POST` | `/harness/skills`                                    | Create an inert, content-addressed proposal                   |
| `POST` | `/harness/skills/evidence`                           | Add paired evaluator-authenticated held-out evidence          |
| `POST` | `/harness/skills/:name/promotion`                    | Promote only a currently qualified, unchanged proposal        |

The generated JavaScript SDK exposes the same API.

## Research basis

The implementation borrows principles, not source code, from the following primary systems and papers:

| Source                                                                                                                     | Principle reflected here                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AlphaEvolve](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)   | Programs compete through objective external evaluators and remain in an evolutionary database.                                                                         |
| [Google DeepMind Co-Scientist](https://deepmind.google/blog/co-scientist-a-multi-agent-ai-partner-to-accelerate-research/) | Generate diverse hypotheses, critique/rank them, combine strong ideas, and spend substantial compute on verification.                                                  |
| [ProEval](https://deepmind.google/research/publications/238239/)                                                           | Actively discover failure regions and estimate capability from a small, strategically chosen evaluation subset.                                                        |
| [TRACE: Towards Structural Understanding of LLM Overthinking](https://deepmind.google/research/publications/203490/)       | Detect verification and exploration that continue after their marginal utility has collapsed; stop against a predeclared control rule.                                 |
| [Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296)                                             | Add agents conditionally: coordination can hurt sequential and tool-heavy work, while centralized structures control error amplification.                              |
| [Gram](https://deepmind.google/research/publications/252981/)                                                              | Audit autonomous agents for sabotage, overeagerness, and hidden side effects with an investigator distinct from the producer.                                          |
| [Realistic honeypot evaluations](https://deepmind.google/research/publications/253391/)                                    | Include evaluation-awareness and realistic deployment-context failures instead of relying only on artificial judge tests.                                              |
| [PostTrainBench v1.1](https://posttrainbench.com/) and its [paper](https://arxiv.org/abs/2603.08640)                       | Treat test-derived data, unauthorized API/model use, model substitution, and benchmark lookup as separately audited integrity failures rather than score improvements. |
| [Solipsistic superintelligence is unlikely to be cooperative](https://deepmind.google/research/publications/231466/)       | Treat evaluation as an external, adaptive institutional boundary rather than a stationary feedback object controlled by the optimizing agent.                          |
| [RubricEval](https://arxiv.org/abs/2603.25133) and [Who Validates the Validators?](https://arxiv.org/abs/2404.12272)       | Meta-evaluate judges on realistic failures and version criteria rather than treating an LLM judge as ground truth by default.                                          |
| [MLEvolve](https://github.com/InternScience/MLEvolve) and its [paper](https://arxiv.org/abs/2606.06473)                    | Progressive multi-branch search, success/failure hindsight, adaptive exploration, and branch fusion for MLE.                                                           |
| [CORAL](https://arxiv.org/abs/2604.01658)                                                                                  | Persist coordination state and heartbeat-like progress across asynchronous research workers rather than relying on chat memory.                                        |
| [AI Scientist v2](https://github.com/SakanaAI/AI-Scientist-v2) and its [paper](https://arxiv.org/abs/2504.08066)           | Multiple independent experimental roots and agentic tree search rather than a single linear attempt.                                                                   |
| [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954)                                                                   | Preserve an open-ended archive with lineage; do not collapse self-improvement into one incumbent.                                                                      |
| [SkyDiscover](https://github.com/skydiscover-ai/skydiscover)                                                               | Island-style diversity, UCB selection, migration/fusion, staged evaluation, and strategy mutation after stagnation.                                                    |
| [GEPA](https://arxiv.org/abs/2507.19457)                                                                                   | Feed detailed evaluator feedback into reflective search rather than optimizing from a scalar alone.                                                                    |
| [EvoScientist](https://github.com/EvoScientist/EvoScientist) and its [paper](https://arxiv.org/abs/2603.08127)             | Turn repeated observations into proposed reusable skills; OpenScience adds stricter quarantine and held-out promotion.                                                 |
| [ResearchHarness](https://github.com/InternScience/ResearchHarness)                                                        | Keep the benchmark substrate explicit, inspectable, tool-bounded, and traceable while isolating agent workspaces from evaluator state.                                 |
| [PhysicsIntern](https://github.com/huggingface/physics-intern-skills)                                                      | Use durable research state, fresh verification contexts, independent derivations/computations, and adversarial critique.                                               |
| [ResearchClawBench](https://arxiv.org/abs/2606.07591)                                                                      | Evaluate end-to-end research against hidden target work and make protocol mismatch, evidence mismatch, and missing scientific core visible.                            |
| [Towards Self-Evolving Benchmarks](https://arxiv.org/abs/2510.00415)                                                       | Require validate-by-reproduce trajectories and multi-level validation before dynamically evolved tasks can enter benchmark evidence.                                   |

The expanded evaluation frontier is grounded in [PaperBench](https://openai.com/index/paperbench/), [computational reproducibility CORE-Bench](https://arxiv.org/abs/2409.11363), [ScienceAgentBench](https://arxiv.org/abs/2410.05080), [DiscoveryBench](https://arxiv.org/abs/2407.01725), [SciCode](https://arxiv.org/abs/2407.13168), [LABBench2](https://arxiv.org/abs/2604.09554), [SciAgentArena](https://arxiv.org/abs/2606.12736), and [AInsteinBench](https://arxiv.org/abs/2512.21373).

## What remains before a SOTA claim

The harness is ready for benchmark integration, but architecture alone does not establish performance. For each target benchmark:

1. Pin an official repository/evaluator commit, dataset revision and manifest, task manifest, environment, invocation, baseline artifact/score, split, hardware class, model, tools, budget, seed policy, and intervention policy; pass the complete launch-readiness suite.
2. For strict hidden or post-training runs, capture an evaluator-owned execution trace and pass a contract-bound runtime-integrity receipt for the exact final artifact.
3. Qualify any learned or hybrid evaluator against a separately controlled, committed meta-evaluation suite; retain official deterministic runners as the preferred ground truth where available.
4. Reproduce the strongest public baseline under exactly that contract.
5. Run ablations for profile routing, multi-root search, UCB exploration, fidelity screening, hindsight, fusion, strategy divergence, domain packs, runtime integrity, evaluator qualification, and learned skills.
6. Use multiple seeds or the benchmark's prescribed repeat protocol.
7. Publish every final run, failed run, cost report, artifact hash, evaluator receipt, and contamination statement.
8. Call a result SOTA only when the official metric improves under a comparison the benchmark owners would accept.
