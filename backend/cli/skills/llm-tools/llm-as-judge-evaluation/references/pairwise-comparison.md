# Pairwise Comparison Reference

## Overview

Pairwise comparison is the most reliable LLM-as-judge method. Instead of asking
"how good is this response?", you ask "which of these two responses is better?" —
a much easier judgment task that produces more consistent results.

## Why Pairwise > Likert

| Aspect | Pairwise | Likert (1-5) |
|--------|----------|--------------|
| Inter-annotator agreement | High | Low-moderate |
| Calibration needed | No | Yes (what does "4" mean?) |
| Position bias | Mitigatable (swap) | N/A (single response) |
| Sensitivity | High (detects small differences) | Low (coarse scale) |
| Cost per comparison | 2x (need swap) | 1x |
| Best for | A/B testing, model selection | Monitoring, thresholds |

## Advanced: Chain-of-Thought Judging

Better results when the judge explains its reasoning before deciding:

```python
COT_PAIRWISE_PROMPT = """You are an expert evaluator comparing two responses.

## Task: {task_description}

## Input: {user_input}

## Response A
{response_a}

## Response B
{response_b}

## Evaluation Criteria
{criteria}

Think step by step:
1. Analyze Response A's strengths and weaknesses
2. Analyze Response B's strengths and weaknesses
3. Compare on each criterion
4. Make your final judgment

Return JSON:
{{
    "analysis_a": "strengths and weaknesses of A",
    "analysis_b": "strengths and weaknesses of B",
    "comparison": "criterion-by-criterion comparison",
    "winner": "A" or "B" or "tie",
    "confidence": "high" or "medium" or "low"
}}"""
```

## Handling Ties

Tie rates inform evaluation quality:

| Tie Rate | Interpretation | Action |
|----------|---------------|--------|
| < 10% | Clear quality difference | Good signal |
| 10-30% | Models are close | Normal, increase sample size |
| 30-50% | Very similar quality | May need finer-grained criteria |
| > 50% | Criteria too vague | Rewrite rubric with specific anchors |

## Reference-Based Comparison

When you have a ground-truth reference, include it for more accurate judging:

```python
REFERENCE_PAIRWISE_PROMPT = """Compare two responses against a known correct reference.

## Input: {user_input}

## Reference (ground truth)
{reference}

## Response A
{response_a}

## Response B
{response_b}

Which response is more faithful to the reference while remaining helpful?
Return JSON: {{"winner": "A" or "B" or "tie", "reasoning": "..."}}"""
```

## Common Pitfalls

1. **Length bias**: Judges prefer longer responses. Add "conciseness" to criteria.
2. **Format bias**: Judges prefer markdown/structured responses. Normalize formatting.
3. **Sycophancy**: Judges prefer responses that agree with the user. Use neutral criteria.
4. **Self-preference**: GPT-4 may prefer GPT-4 style. Use Claude as judge for GPT outputs and vice versa.
5. **Instruction following vs quality**: Separate these in your rubric.
