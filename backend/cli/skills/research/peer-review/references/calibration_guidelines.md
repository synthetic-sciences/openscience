# Peer Review Calibration Guidelines

Guidelines for calibrating AI-assisted peer review to match human reviewer standards, based on empirical comparison with actual peer reviews.

## Overview

AI peer review systems tend to be harsher than human reviewers. This document provides calibration principles to ensure fair, balanced reviews that align with community standards.

## Calibration Metrics

When validating AI reviews against human reviews:

| Metric | Target | Typical AI Uncalibrated |
|--------|--------|------------------------|
| Scientific critique alignment | 85-90% | 80-85% |
| Score calibration | 90%+ | 60-70% (too harsh) |
| Completeness (mechanics) | 90%+ | 75-80% (misses presentation issues) |

## Core Calibration Principles

### 1. Limitation Acknowledgment Bonus

**Principle:** Authors who honestly acknowledge limitations should not be heavily penalized for those same limitations.

**Calibration Rule:**
- If authors explicitly acknowledge a limitation → reduce penalty by 50%
- Never penalize more than 1 point for an acknowledged limitation
- Credit honest self-assessment in the summary

**Example:**
> **Paper states:** "A limitation of our work is the use of synthetic benchmarks only."
>
> **Uncalibrated response:** "Critical weakness: No real-world validation undermines all claims." [-3 points]
>
> **Calibrated response:** "As the authors acknowledge, the evaluation is limited to synthetic benchmarks. Real-world validation would strengthen the contribution but is not essential given the clear scope." [-0.5 points]

### 2. Reproducibility Credit

**Principle:** Papers that enable reproduction deserve credit even if scope is limited.

**Score Floor:** If a paper provides ALL of:
- Detailed methods description
- Random seeds and hyperparameters
- Code/data availability (or clear statement)
- Confidence intervals and effect sizes

→ Score cannot fall below 6 (Weak Accept)

**Rationale:** Reproducible research with acknowledged limitations is more valuable than opaque research with broader claims.

### 3. Scope vs. Quality

**Principle:** Narrow scope is not the same as low quality.

**Calibration:**
- A narrow-but-sound study = 6-7 (Weak Accept to Accept)
- A broad-but-flawed study = 4-5 (Reject to Borderline)
- Evaluate what the paper does, not what it doesn't attempt

**Example:**
> **Paper:** Rigorous study of one specific phenomenon on one dataset
>
> **Uncalibrated:** "Limited scope restricts significance. Score: 5/10"
>
> **Calibrated:** "Well-executed study within its stated scope. The focused investigation provides clear contribution to the subfield. Score: 6-7/10"

### 4. Synthetic Data Reality

**Principle:** Most ML/AI papers use synthetic or benchmark data; this alone is not a weakness.

**Calibration:**
- Standard benchmarks are accepted methodology in ML venues
- Only penalize if paper claims real-world applicability without real-world validation
- Synthetic data with thorough analysis > limited real data with poor analysis

## Tone Calibration

### Severity Language

| Situation | Calibrated Language | Avoid |
|-----------|---------------------|-------|
| Reporting gap | "needs clearer reporting" | "misleading" |
| Missing element | "would benefit from" | "fails to" |
| Scope limitation | "limited to [context]" | "fundamentally flawed" |
| Different interpretation | "alternative explanation" | "contradictory" |
| Unclear passage | "could be clarified" | "confusing" |

### Constructive Framing

**Uncalibrated (prosecutorial):**
> "The authors misleadingly omit critical baselines, making it impossible to evaluate the true contribution."

**Calibrated (constructive):**
> "The evaluation would be strengthened by comparison with [specific baseline]. This would help contextualize the reported 15% improvement."

### Severity Distribution

In a well-calibrated review:
- **Critical issues:** <5% of all issues flagged (reserve for true invalidity)
- **Major issues:** 20-30% of issues
- **Moderate issues:** 40-50% of issues
- **Minor issues:** 20-30% of issues

If your review has mostly "Critical" or "Major" issues, recalibrate.

## Common Over-Penalization Patterns

### Pattern 1: Penalizing Scope

**Trigger:** Paper addresses focused problem rather than general solution

**Uncalibrated:** -2 to -3 points for "limited applicability"

**Calibrated:** Scope affects Significance sub-score (2/4 instead of 3/4), not overall validity. If methodology is sound, floor is 6.

### Pattern 2: Penalizing Standard Practices

**Trigger:** Paper uses synthetic data, standard benchmarks, or common methodology

**Uncalibrated:** -2 for "no real-world validation"

**Calibrated:** These are field-standard practices. Only penalize if claims exceed what data supports.

### Pattern 3: Double-Penalizing Acknowledged Issues

**Trigger:** Paper explicitly discusses a limitation

**Uncalibrated:** Full penalty as if authors were unaware

**Calibrated:** Credit the acknowledgment, reduce penalty by 50%+

### Pattern 4: Catastrophizing Moderate Issues

**Trigger:** Missing some experiments or analysis

**Uncalibrated:** "This fundamentally undermines the validity of all claims"

**Calibrated:** "Additional experiments with [X] would strengthen the conclusions"

## Score Alignment Guide

### Mapping to Human Reviewer Outcomes

| AI Score | Expected Human Outcome |
|----------|----------------------|
| 8-10 | Strong Accept / Accept |
| 7 | Accept / Weak Accept |
| 6 | Weak Accept / Borderline Accept |
| 5 | Major Revision / Borderline |
| 3-4 | Reject |
| 1-2 | Strong Reject |

### Red Flags for Miscalibration

Your review may be miscalibrated if:
- Score is ≤5 but you can't identify a Critical flaw
- More than 3 issues marked as "Critical"
- Tone includes words like "misleading," "fundamentally flawed," "impossible to evaluate"
- Penalty for acknowledged limitations exceeds 1 point
- Paper with reproducibility details scores below 6

## Calibration Checklist

Before submitting a review, verify:

- [ ] Score aligns with severity of identified issues
- [ ] Acknowledged limitations receive reduced penalty
- [ ] No "Critical" severity for moderate issues
- [ ] Language is constructive, not prosecutorial
- [ ] Scope limitations affect Significance, not Soundness
- [ ] Reproducibility credit applied if applicable
- [ ] Tone matches calibration examples
- [ ] Would a human reviewer give similar score?

## Recalibration Process

If review seems too harsh:

1. **Review severity labels:** Downgrade Critical → Major → Moderate
2. **Check for acknowledgment bonus:** Reduce penalty for acknowledged issues
3. **Apply reproducibility floor:** Sound + reproducible = minimum 6
4. **Reframe language:** Replace harsh terms with constructive alternatives
5. **Reconsider scope penalty:** Narrow scope ≠ low quality
6. **Compare to examples:** Would similar papers receive similar scores?

## Empirical Basis

These guidelines are derived from comparison of AI reviews with actual human peer reviews at major venues (ACL, NeurIPS, ICML, etc.).

**Key Finding:** AI systems tend to score ~1.5 points lower than human consensus when uncalibrated. Primary causes:
1. Over-penalization of acknowledged limitations
2. Treating scope restrictions as fundamental flaws
3. Using prosecutorial language that implies misconduct
4. Missing positive contributions while focusing on gaps

**Post-Calibration:** Alignment with human scores improves from ~60-70% to ~85-90%.
