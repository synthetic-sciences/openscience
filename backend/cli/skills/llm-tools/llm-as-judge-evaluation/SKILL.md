---
name: llm-as-judge-evaluation
description: Evaluate LLM outputs using frontier models as judges. Use for pairwise model comparison, quality scoring with custom rubrics, and automated evaluation pipelines. Covers position bias mitigation, statistical significance, and generating preference data for DPO/RLHF.
category: llm-tools
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Evaluation, LLM-as-Judge, Pairwise Comparison, Quality Assessment, Rubric Design, Model Comparison, Automated Evaluation]
dependencies: [openai, anthropic, datasets, numpy]
---

# LLM-as-Judge Evaluation

## When to Use This Skill

Use LLM-as-Judge evaluation when you need to:
- **Compare a fine-tuned model vs frontier** — Does the student beat the teacher on your task?
- **Quality gates before deployment** — Automated go/no-go on model releases
- **Continuous evaluation** — Monitor production model quality over time
- **Generate preference data** — Create (chosen, rejected) pairs for DPO/RLHF training
- **Evaluate without ground truth** — When exact answers don't exist (creative, open-ended tasks)

### When NOT to Use
- Tasks with verifiable answers (math, code execution) — use exact match or unit tests
- Extremely simple classification — use accuracy/F1 directly
- Safety evaluation — use dedicated safety benchmarks, not general judges

## Pairwise Comparison

The most reliable LLM-as-judge method. Show a judge two outputs (A and B) and ask which is better.

### Basic Implementation

```python
import openai
import json
import random

client = openai.OpenAI()

PAIRWISE_PROMPT = """You are an expert evaluator. Compare two responses to the same prompt.

## Task Context
{task_description}

## User Input
{user_input}

## Response A
{response_a}

## Response B
{response_b}

## Evaluation Criteria
{criteria}

Which response is better? Consider all criteria above.
Return JSON: {{"winner": "A" or "B" or "tie", "reasoning": "brief explanation"}}"""


def pairwise_compare(user_input, response_a, response_b, task_description, criteria,
                     model="gpt-4o", swap_positions=True):
    """Compare two responses with position bias mitigation."""
    results = []

    # First comparison: A=position1, B=position2
    prompt = PAIRWISE_PROMPT.format(
        task_description=task_description,
        user_input=user_input,
        response_a=response_a,
        response_b=response_b,
        criteria=criteria,
    )
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        temperature=0,
    )
    result1 = json.loads(resp.choices[0].message.content)
    results.append(result1["winner"])

    if swap_positions:
        # Second comparison: swap positions to detect position bias
        prompt_swapped = PAIRWISE_PROMPT.format(
            task_description=task_description,
            user_input=user_input,
            response_a=response_b,  # Swapped
            response_b=response_a,  # Swapped
            criteria=criteria,
        )
        resp2 = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt_swapped}],
            response_format={"type": "json_object"},
            temperature=0,
        )
        result2 = json.loads(resp2.choices[0].message.content)
        # Reverse the swapped result
        swapped_winner = {"A": "B", "B": "A", "tie": "tie"}[result2["winner"]]
        results.append(swapped_winner)

    # Aggregate: both must agree, otherwise tie
    if len(set(results)) == 1:
        return results[0]
    return "tie"
```

### Running a Full Evaluation

```python
def evaluate_model_pair(eval_set, model_a_fn, model_b_fn, task_description, criteria,
                        judge_model="gpt-4o"):
    """Run pairwise evaluation across an entire eval set.

    Args:
        eval_set: List of {"input": str, "reference": str (optional)}
        model_a_fn: Function(input) -> str (e.g., frontier model)
        model_b_fn: Function(input) -> str (e.g., fine-tuned model)
        task_description: What the models are supposed to do
        criteria: Evaluation criteria string
        judge_model: Which model to use as judge
    """
    results = {"A": 0, "B": 0, "tie": 0}
    details = []

    for i, example in enumerate(eval_set):
        # Generate responses
        response_a = model_a_fn(example["input"])
        response_b = model_b_fn(example["input"])

        # Random assignment to positions (reduces systematic bias)
        if random.random() < 0.5:
            winner = pairwise_compare(
                example["input"], response_a, response_b,
                task_description, criteria, judge_model
            )
        else:
            raw = pairwise_compare(
                example["input"], response_b, response_a,
                task_description, criteria, judge_model
            )
            winner = {"A": "B", "B": "A", "tie": "tie"}[raw]

        results[winner] += 1
        details.append({
            "input": example["input"],
            "response_a": response_a,
            "response_b": response_b,
            "winner": winner,
        })

        if (i + 1) % 20 == 0:
            print(f"Progress: {i+1}/{len(eval_set)} — A:{results['A']} B:{results['B']} Tie:{results['tie']}")

    total = sum(results.values())
    report = {
        "total_comparisons": total,
        "model_a_wins": results["A"],
        "model_b_wins": results["B"],
        "ties": results["tie"],
        "model_a_win_rate": results["A"] / total,
        "model_b_win_rate": results["B"] / total,
        "tie_rate": results["tie"] / total,
    }
    return report, details
```

## Likert Scoring (1-5 Scale)

For absolute quality assessment rather than comparison:

```python
LIKERT_PROMPT = """You are an expert evaluator. Rate this response on a 1-5 scale.

## Task Context
{task_description}

## User Input
{user_input}

## Response
{response}

## Scoring Rubric
{rubric}

Rate the response on each dimension. Then provide an overall score.
Return JSON: {{"scores": {{"dimension_name": score, ...}}, "overall": score, "reasoning": "..."}}"""


def likert_score(user_input, response, task_description, rubric, model="gpt-4o"):
    """Score a single response on a 1-5 Likert scale."""
    prompt = LIKERT_PROMPT.format(
        task_description=task_description,
        user_input=user_input,
        response=response,
        rubric=rubric,
    )
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        temperature=0,
    )
    return json.loads(resp.choices[0].message.content)
```

## Custom Rubric Design

### Template

```python
RUBRIC_TEMPLATE = """
Score 1 (Poor): {poor_description}
Score 2 (Below Average): {below_avg_description}
Score 3 (Average): {avg_description}
Score 4 (Good): {good_description}
Score 5 (Excellent): {excellent_description}
"""

# Example: Code generation rubric
CODE_RUBRIC = """
Dimensions:
1. Correctness (weight: 0.4)
   1: Code has critical bugs, won't run
   2: Runs but produces wrong output in common cases
   3: Correct for common cases, fails on edge cases
   4: Correct for all cases, minor style issues
   5: Correct, clean, handles all edge cases

2. Efficiency (weight: 0.2)
   1: Exponential or worse complexity
   2: Unnecessarily slow, obvious optimization missed
   3: Acceptable performance for typical inputs
   4: Well-optimized, good algorithmic choices
   5: Optimal or near-optimal solution

3. Readability (weight: 0.2)
   1: Incomprehensible, no structure
   2: Hard to follow, poor naming
   3: Readable with effort, some unclear parts
   4: Clean code, good naming and structure
   5: Exemplary clarity, well-documented

4. Completeness (weight: 0.2)
   1: Missing major requirements
   2: Partial implementation
   3: Implements core requirements
   4: Complete with good error handling
   5: Complete with tests, docs, error handling
"""
```

## Position Bias Mitigation

LLM judges tend to prefer whichever response appears first. Always mitigate this:

```python
def mitigated_pairwise(user_input, response_a, response_b, **kwargs):
    """Run comparison twice with swapped positions."""
    # Round 1: A first, B second
    r1 = pairwise_compare(user_input, response_a, response_b, swap_positions=False, **kwargs)

    # Round 2: B first, A second
    r2_raw = pairwise_compare(user_input, response_b, response_a, swap_positions=False, **kwargs)
    r2 = {"A": "B", "B": "A", "tie": "tie"}[r2_raw]

    # Agreement check
    if r1 == r2:
        return r1  # Both rounds agree
    return "tie"  # Disagreement = inconclusive
```

## Statistical Significance

### Bootstrap Confidence Intervals

```python
import numpy as np

def bootstrap_win_rate(wins, total, n_bootstrap=10000, ci=0.95):
    """Calculate bootstrap confidence interval for win rate."""
    win_rate = wins / total
    samples = np.random.binomial(total, win_rate, n_bootstrap) / total

    alpha = (1 - ci) / 2
    lower = np.percentile(samples, alpha * 100)
    upper = np.percentile(samples, (1 - alpha) * 100)

    return {
        "win_rate": win_rate,
        "ci_lower": lower,
        "ci_upper": upper,
        "significant": lower > 0.5 or upper < 0.5,  # Significantly different from 50%
    }
```

### Minimum Sample Size

| Desired precision | Minimum samples | Notes |
|-------------------|-----------------|-------|
| Directional (which is better) | 50-100 | Rough signal |
| Reliable estimate (+-5%) | 200-400 | Standard evaluation |
| High confidence (+-2%) | 500-1000 | Production decisions |
| Publication quality | 1000+ | Statistical rigor |

**Rule of thumb**: Use at least 100 examples for deployment decisions, 200+ for reliable win rates.

## Generating Preference Data for DPO

Convert judge outputs to (chosen, rejected) pairs:

```python
def generate_dpo_pairs(eval_set, model_a_fn, model_b_fn, task_description, criteria,
                       judge_model="gpt-4o"):
    """Generate DPO training pairs from pairwise evaluation."""
    pairs = []

    for example in eval_set:
        response_a = model_a_fn(example["input"])
        response_b = model_b_fn(example["input"])

        winner = pairwise_compare(
            example["input"], response_a, response_b,
            task_description, criteria, judge_model
        )

        if winner == "tie":
            continue  # Skip ties for DPO

        chosen = response_a if winner == "A" else response_b
        rejected = response_b if winner == "A" else response_a

        pairs.append({
            "prompt": example["input"],
            "chosen": chosen,
            "rejected": rejected,
        })

    print(f"Generated {len(pairs)} DPO pairs from {len(eval_set)} examples "
          f"({len(eval_set) - len(pairs)} ties skipped)")
    return pairs
```

## Multi-Judge Ensemble

Use multiple judge models for higher reliability:

```python
def multi_judge_compare(user_input, response_a, response_b, task_description, criteria,
                        judges=None):
    """Use multiple judge models and take majority vote."""
    judges = judges or ["gpt-4o", "claude-sonnet-4-5-20250929"]
    votes = []

    for judge in judges:
        winner = pairwise_compare(
            user_input, response_a, response_b,
            task_description, criteria, model=judge
        )
        votes.append(winner)

    # Majority vote
    from collections import Counter
    vote_counts = Counter(votes)
    majority = vote_counts.most_common(1)[0]

    return {
        "winner": majority[0],
        "confidence": majority[1] / len(votes),
        "votes": dict(vote_counts),
        "judge_details": list(zip(judges, votes)),
    }
```

## Quick Start Checklist

1. **Define criteria**: Write a rubric specific to your task
2. **Prepare eval set**: 100+ held-out examples with production inputs
3. **Generate responses**: Run both models on the eval set
4. **Run pairwise comparison**: With position bias mitigation
5. **Check significance**: Bootstrap CI on win rate
6. **Decision gate**: Student wins > 50% -> proceed to deploy
7. **Save preference data**: Use ties and wins for DPO training
