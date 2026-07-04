# Peer Review Scoring Rubric

Detailed scoring criteria with severity calibration for consistent, fair evaluation.

## Overall Score (1-10 Scale)

### Score Anchors

| Score | Label | Criteria |
|-------|-------|----------|
| **10** | Outstanding | Exceptional contribution, flawless execution, field-changing potential |
| **9** | Strong Accept | Significant contribution, excellent methodology, high impact, minor polish needed |
| **8** | Accept | Solid contribution, rigorous execution, clear value to field |
| **7** | Accept | Good work with minor methodological or scope limitations, contribution clear |
| **6** | Weak Accept | Sound methodology, acknowledged limitations, narrow scope but valid |
| **5** | Borderline | Significant concerns but potentially salvageable with major revisions |
| **4** | Lean Reject | Multiple major issues affecting validity or interpretation |
| **3** | Reject | Fundamental methodological flaws or unsupported claims |
| **2** | Strong Reject | Serious scientific concerns, major rewrite needed |
| **1** | Clear Reject | Fatally flawed, ethical concerns, or not suitable for venue |

### Score Distribution Expectations

In a well-calibrated review process:
- **8-10**: ~10-15% of submissions (truly excellent work)
- **6-7**: ~40-50% of submissions (solid, publishable work)
- **5**: ~20-25% of submissions (borderline, needs work)
- **1-4**: ~15-20% of submissions (significant issues)

## Sub-Score Dimensions (1-4 Scale)

### Soundness

Technical correctness of methodology, analysis, and conclusions.

| Score | Description | Indicators |
|-------|-------------|------------|
| **4** | Excellent | Methods impeccable, statistics appropriate, conclusions fully supported |
| **3** | Good | Minor issues but core methodology sound, conclusions mostly supported |
| **2** | Fair | Notable methodological concerns affecting some conclusions |
| **1** | Poor | Fundamental flaws invalidating major claims |

**Soundness Red Flags:**
- Inappropriate statistical tests for data type
- Missing critical controls
- Circular analysis (same data for selection and testing)
- Pseudoreplication
- Overclaiming from correlational data

### Originality

Novelty of contribution relative to prior work.

| Score | Description | Indicators |
|-------|-------------|------------|
| **4** | Highly Novel | New problem, method, or insight advancing the field |
| **3** | Novel | Clear contribution beyond incremental improvement |
| **2** | Incremental | Extension of existing work with limited new insight |
| **1** | Derivative | Minimal novelty, replication without extension |

**Originality Considerations:**
- Novel problem formulation counts as originality
- Rigorous negative results can be original contributions
- Cross-domain application of known methods can be novel
- Scale or efficiency improvements require substantial gains for high novelty

### Clarity

Quality of writing, organization, and presentation.

| Score | Description | Indicators |
|-------|-------------|------------|
| **4** | Excellent | Clear, well-organized, accessible to broad audience |
| **3** | Good | Generally clear, minor organizational or writing issues |
| **2** | Fair | Significant clarity issues affecting comprehension |
| **1** | Poor | Difficult to follow, major organizational problems |

**Clarity Checklist:**
- Abstract accurately summarizes findings
- Introduction motivates and contextualizes work
- Methods reproducible from description
- Results presented logically
- Discussion distinguishes data from speculation
- Figures/tables clear and well-labeled

### Significance

Potential impact on the field.

| Score | Description | Indicators |
|-------|-------------|------------|
| **4** | High Impact | Likely to influence research direction or practice |
| **3** | Significant | Clear value to researchers in the area |
| **2** | Moderate | Useful but limited impact expected |
| **1** | Low | Minimal expected influence |

**Significance Factors:**
- Size and activity of affected research community
- Practical applications enabled
- Theoretical insights provided
- Reproducibility and extensibility of work

## Severity Calibration

### Issue Classification

| Severity | Definition | Score Impact | Frequency |
|----------|------------|--------------|-----------|
| **Critical** | Invalidates conclusions, requires fundamental revision | -3 to -4 | <5% of reviews |
| **Major** | Significantly affects interpretation, addressable with effort | -1 to -2 | 20-30% |
| **Moderate** | Notable limitation, acknowledged is acceptable | -0.5 to -1 | 40-50% |
| **Minor** | Polish issue, easy to fix | -0 to -0.5 | Common |

### Critical Issues (Reserve for True Invalidity)

Only use "Critical" severity for:
- Statistical tests fundamentally inappropriate (e.g., t-test on non-independent data)
- Missing controls that prevent any valid interpretation
- Fabrication or falsification concerns
- Undisclosed conflicts of interest affecting conclusions
- Ethical violations (missing IRB for human subjects)

### What Is NOT Critical

These are Major or Moderate, not Critical:
- Missing some baselines (if primary comparison valid)
- Synthetic data only (standard in many fields)
- Limited generalization (scope issue)
- Acknowledged limitations
- Reproducibility details missing (fixable)

## Score Adjustment Rules

### Limitation Acknowledgment Bonus

If authors explicitly acknowledge a limitation:
- Reduce penalty by 50% (e.g., -2 → -1)
- Never penalize >1 point for acknowledged issues
- Credit honest self-assessment in summary

### Reproducibility Credit

If the paper provides:
- Detailed methods section
- Random seeds and hyperparameters
- Code/data availability statement
- Confidence intervals and effect sizes

→ Apply score floor of 6 (cannot go below Weak Accept)

### Scope Adjustment

A narrow-but-sound study on an interesting problem:
- Should score 6-7 (Weak Accept to Accept)
- Should NOT score 5 or below unless methodology flawed
- Evaluate on what it does, not what it doesn't attempt

## Calibration Examples

### Example A: Narrow-but-Sound ML Paper

**Paper Profile:**
- Novel method for specific NLP task
- Synthetic benchmark data only
- Thorough ablations and error analysis
- Authors acknowledge limited real-world validation
- Code and data available

**Calibrated Score: 6-7 (Weak Accept)**
- Soundness: 3/4 (methodology rigorous within scope)
- Originality: 3/4 (clear contribution)
- Clarity: 3/4 (well-written)
- Significance: 2/4 (limited by scope)

**Reasoning:** Sound methodology + acknowledged limitations + reproducibility = floor of 6

### Example B: Overstated Claims

**Paper Profile:**
- Interesting research question
- Appropriate methods
- But: Conclusions significantly overstate findings
- Claims causation from correlational data
- Generalizes beyond data support

**Calibrated Score: 5 (Borderline)**
- Soundness: 2/4 (overclaiming)
- Originality: 3/4 (good question)
- Clarity: 3/4 (well-written)
- Significance: 2/4 (limited by overclaiming)

**Reasoning:** Overclaiming is a Major issue (-2), methodology otherwise sound

### Example C: Strong Work with Minor Issues

**Paper Profile:**
- Significant contribution
- Rigorous methodology
- Comprehensive experiments
- Minor: Some figure labels small
- Minor: A few citations missing

**Calibrated Score: 8 (Accept)**
- Soundness: 4/4
- Originality: 3/4
- Clarity: 3/4 (minor presentation issues)
- Significance: 4/4

**Reasoning:** Minor issues don't affect validity or interpretation

## Common Calibration Errors

### Over-Penalization Patterns

| Error | Correct Approach |
|-------|------------------|
| -2 for synthetic data alone | Synthetic data is standard; only penalize if claimed to be real-world |
| -2 for narrow scope | Scope affects Significance sub-score, not Soundness |
| -2 for acknowledged limitations | -0.5 to -1 max for acknowledged issues |
| Critical for missing baselines | Major at most; Critical only if no valid comparisons exist |

### Under-Penalization Patterns

| Error | Correct Approach |
|-------|------------------|
| Ignoring statistical issues | Inappropriate tests can invalidate conclusions |
| Overlooking pseudoreplication | This is often a Critical issue |
| Accepting overclaiming | Major issue even if methods are sound |
| Missing ethics concerns | Should be flagged regardless of other quality |

## Final Scoring Algorithm

1. Start at 7 (default for competent submission)
2. Add +1 to +3 for exceptional elements (novelty, rigor, impact)
3. Subtract for issues based on severity
4. Apply limitation acknowledgment bonus
5. Apply reproducibility credit floor
6. Verify score matches calibration examples
7. Ensure sub-scores are consistent with overall
