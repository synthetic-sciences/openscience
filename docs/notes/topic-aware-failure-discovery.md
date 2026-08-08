# Topic-aware adversarial failure discovery

This note records the research and adversarial design boundary for
`topic-aware-failure-v1`. It distinguishes mechanisms supported by ProEval from
the receipt, capability, and contamination controls added by OpenScience.

## Primary sources inspected

- Huang, Zeng, Kumaresan, and Wang, [ProEval: Proactive Failure Discovery and
  Efficient Performance Estimation for Generative AI
  Evaluation](https://arxiv.org/html/2604.23099v2), arXiv v2, 1 June 2026.
- Google DeepMind, [ProEval source
  repository](https://github.com/google-deepmind/proeval), inspected at commit
  `8c0422db6a5b6d655712bae63e852e90219f7ddc` (16 June 2026).
- DeepMind, [Conjecture Machines and the validation bottleneck in
  science](https://deepmind.google/public-policy/conjecture-machines-ai-agents-and-the-new-validation-bottleneck-in-science/).

## Directly supported mechanisms

ProEval separates population performance estimation from failure discovery.
For generated discovery, SS-Gen selects likely-failure anchors using the
superlevel-set acquisition and asks an LLM to create a harder case with a
similar failure pattern. TSS addresses semantic collapse by separating the
failure pattern from a target topic. Topics come from BERTopic or a predefined
set; UCB1 treats topics as arms; topic choice is explicitly independent of the
anchors; and the generator transposes the anchor pattern into the selected
topic.

The paper measures cumulative failures, failure rate, samples to first failure,
normalized topic entropy, and embedding log-determinant diversity. It reports
that topic-aware/anchored synthesis can find substantially more and more diverse
failures than random generation under fixed budgets. These are empirical
results on the evaluated datasets and models, not a universal SOTA guarantee.

The paper also calls out generator validity as a limitation: a synthesized hard
question may itself be wrong. Its experiment controls the generator and
temperature across methods, which supports relative comparisons but does not
authenticate an individual generated case in a hostile benchmark setting.

## Reference-code audit

The inspected repository is useful executable research, but its generator loop
is not a receipt protocol. In the inspected commit:

- `generate()` increments a topic's total count;
- the experiment calls `generator.update(score)` after target evaluation;
- `update(score)` updates the GP posterior but not the topic failure count; and
- the separate deprecated `update_stats()` is not called by that experiment and
  increments failures when `score == 0.0`, while the experiment documents
  `1.0` as an error/failure.

Consequently, copying that path verbatim would not establish that UCB rewards
track observed failures. OpenScience recomputes arm pulls and rewards from the
stored attempt journal instead of trusting mutable generator state.

## OpenScience engineering extrapolations

The following controls are OpenScience additions, not claims made by ProEval:

1. A bound contract freezes the source-audit pool, sorted opaque topics whose
   hidden definitions use private salted commitments,
   topic-model/generator/validator/embedding identities, budget, UCB constant,
   threshold, and anchor count before generation. Generator/validator
   separation uses prompt/config commitment pairs rather than relabelable names.
2. A stream can start only from a valid terminal active-audit receipt for the
   exact subject. Anchors are derived from authenticated observed failures.
3. Every topic is forced once before UCB1 exploitation or target-based
   termination. Later choices and ties are deterministic and replayed from
   immutable observations; concurrent selection retries receive the same
   server lease.
4. Every attempt consumes budget. Only an independently correctness-, topic-,
   and novelty-valid case with a threshold-consistent target failure earns
   reward. Exact duplicates cannot pass novelty.
5. The backend derives topic entropy and dimension-bounded embedding log-det
   from frozen-model embeddings. It never receives hidden case bytes.
6. A content-addressed terminal receipt transitively revalidates its source
   audit and derives journal semantics again, so recomputing a hash cannot turn
   a threshold-inconsistent label or caller-authored reward into evidence. It
   is robustness evidence only and cannot affect the official score or
   population estimate.

## Acceptance tests

- A caller cannot choose a topic, substitute anchors, or spend a selection
  twice.
- Every topic is selected once before reward-dependent allocation.
- Invalid, failed, inconclusive, duplicate, or threshold-inconsistent cases do
  not earn reward; invalid attempts still consume budget.
- Validator order cannot change the attempt identity, and generator/validator
  identities must be distinct.
- State, receipt, or source-audit tampering invalidates the terminal receipt.
- Adding a failure-discovery receipt leaves the active-audit state and official
  score byte-for-byte unchanged.

The receipt proves that this protocol ran. Credible SOTA claims still require
held-out benchmark execution, declared baselines, repeated runs, uncertainty,
cost reporting, and independent reproduction.
