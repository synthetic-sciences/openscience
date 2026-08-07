# Proactive evaluation: research basis and harness boundary

This note records the research basis for `proactive-audit-v2`. It deliberately
separates mechanisms supported by ProEval from controls added by OpenScience.
The latter are security and provenance requirements for an adversarial benchmark
harness, not claims made by the paper.

## Primary sources

- DeepMind, [ProEval: Proactive Failure Discovery and Efficient Performance
  Estimation for Generative AI Evaluation](https://deepmind.google/research/publications/238239/)
- Hiranandani et al., [ProEval, arXiv:2604.23099v2](https://arxiv.org/html/2604.23099v2)
- Google DeepMind, [ProEval reference implementation](https://github.com/google-deepmind/proeval)
- DeepMind, [Conjecture Machines and the validation bottleneck in
  science](https://deepmind.google/public-policy/conjecture-machines-ai-agents-and-the-new-validation-bottleneck-in-science/)

## Directly supported by ProEval

ProEval models per-example scores with a Gaussian process. Historical source
model score profiles can define a score-feature prior: the target prior mean is
the source-model mean and the prior covariance between two examples is their
empirical covariance across source models. Performance estimation is Bayesian
quadrature over the evaluation population, with acquisition based on reduction
in posterior integral variance. Because that acquisition does not depend on the
observed target scores, a batch can be selected before its outcomes are known.

Failure discovery uses a probabilistic superlevel-set acquisition: prioritize
points whose upper confidence bound crosses a predeclared failure threshold and
whose posterior uncertainty remains high. ProEval also describes source-profile
selection with dimensionality reduction and mixture clustering to reduce
negative transfer. Its implementation abstains from transfer when too few
source models are available in the selected cluster. Generated failure cases
are a separate mechanism: seeded generation anchors likely failures, while
topic-aware generation separates failure patterns from topics and uses a bandit
to allocate generation effort.

These mechanisms support four design invariants:

1. A score-history prior is derived from a frozen matrix; it is not a caller-
   authored mean plus arbitrary features.
2. Population estimation and targeted failure discovery are different
   acquisitions over the same committed static pool.
3. Generated/adversarial cases are useful for discovery but are not samples
   from the benchmark population and cannot enter its quadrature estimate.
4. Transfer requires qualified source profiles; insufficient or mismatched
   sources require abstention or a cold-start path.

## OpenScience engineering extrapolations

The paper does not define a hostile multi-tenant receipt protocol. OpenScience
therefore adds the following controls:

- The contract freezes the exact committed probe pool, source-model identities,
  source-score manifest, source-selection artifact, selection method,
  calibration size, and rejection threshold before target observations exist.
- The evaluator sends only committed probe metadata and source loss vectors.
  OpenScience derives the mean and covariance features and never receives hidden
  probe bytes.
- Initial calibration probes are selected by an outcome-independent digest
  order. If their mean absolute prior error exceeds the frozen threshold,
  transfer is rejected, acquisition falls back to an outcome-independent order,
  and the population estimate permanently abstains.
- A completed audit is promoted only through a content-addressed receipt bound
  to the contract, exact subject artifact, committed pool, terminal revision,
  derived estimate, and timestamps. A passing final evaluation may cite that
  receipt only when the contract explicitly requires it and the receipt is
  completed, transfer-qualified, and non-abstaining.
- Synthetic failure-generation streams, when implemented, must use separate
  commitments, budgets, observations, and receipts. They may create robustness
  evidence but cannot change the official population score estimate.

The calibration rule is a conservative harness guard, not a proof that accepted
transfer is statistically correct. The receipt proves protocol completion and
provenance, not state of the art. Benchmark claims still require held-out runs,
baselines, uncertainty reporting, and independent reproduction.

## Acceptance tests

- Changing a source loss changes the pool commitment and audit identity.
- A v2 caller cannot provide or override derived prior means or covariance
  features.
- Calibration order is unchanged when observed target losses change.
- High calibration error produces `rejected` transfer and a permanently
  abstaining estimate.
- A terminal receipt fails after any content mutation and cannot be replayed
  across contracts, subjects, pools, or timestamps.
- A passing final evaluation cannot omit a required audit receipt or cite a
  rejected, incomplete, abstaining, future, or mismatched receipt.
- `active-audit-v1` remains backward compatible.
