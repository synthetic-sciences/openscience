# Data Quality Reference

## Overview

Data quality directly determines model quality. This reference covers validation,
filtering, and quality metrics for training data.

## Quality Dimensions

| Dimension | What It Measures | Target |
|-----------|-----------------|--------|
| Correctness | Are responses factually accurate? | Manual review sample |
| Consistency | Do similar inputs produce similar outputs? | Low variance on paraphrases |
| Completeness | Are responses thorough? | Task-dependent length targets |
| Format compliance | Do responses match required format? | 100% schema validation pass |
| Diversity | Does the dataset cover the input space? | distinct-2 > 0.5 |
| Deduplication | Are near-duplicates removed? | < 5% duplicate rate |

## Automated Quality Checks

### Token Length Distribution

```python
from transformers import AutoTokenizer

def token_length_analysis(examples, model_name="meta-llama/Llama-3.1-8B"):
    """Analyze token lengths to catch outliers and set training params."""
    tokenizer = AutoTokenizer.from_pretrained(model_name)

    lengths = []
    for ex in examples:
        text = tokenizer.apply_chat_template(ex["messages"], tokenize=False)
        tokens = tokenizer.encode(text)
        lengths.append(len(tokens))

    import numpy as np
    lengths = np.array(lengths)
    return {
        "count": len(lengths),
        "mean": float(np.mean(lengths)),
        "median": float(np.median(lengths)),
        "p95": float(np.percentile(lengths, 95)),
        "p99": float(np.percentile(lengths, 99)),
        "max": int(np.max(lengths)),
        "recommended_max_seq_length": int(np.percentile(lengths, 99) * 1.1),
    }
```

### Response Quality Scoring

Use an LLM judge to score training examples:

```python
def score_example_quality(example, criteria, model="gpt-4o-mini"):
    """Score a training example on 1-5 scale using LLM judge."""
    user_msg = next(m["content"] for m in example["messages"] if m["role"] == "user")
    assistant_msg = next(m["content"] for m in example["messages"] if m["role"] == "assistant")

    prompt = f"""Rate this response on a 1-5 scale for each criterion.

Input: {user_msg}
Response: {assistant_msg}

Criteria:
{criteria}

Return JSON: {{"scores": {{"criterion_name": score, ...}}, "overall": score, "reasoning": "..."}}"""

    # Call LLM and parse response
    # Filter examples below threshold (e.g., overall < 3)
```

## PII Detection and Redaction

```python
import re

PII_PATTERNS = {
    "email": r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b',
    "phone": r'\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b',
    "ssn": r'\b\d{3}-\d{2}-\d{4}\b',
    "credit_card": r'\b(?:\d{4}[-\s]?){3}\d{4}\b',
    "ip_address": r'\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b',
}

def redact_pii(text, patterns=PII_PATTERNS):
    """Replace PII patterns with placeholder tokens."""
    for name, pattern in patterns.items():
        text = re.sub(pattern, f"[{name.upper()}_REDACTED]", text)
    return text
```

## Dataset Health Report

```python
def dataset_health_report(filepath):
    """Generate a comprehensive health report for a training dataset."""
    import json

    examples = []
    with open(filepath) as f:
        for line in f:
            examples.append(json.loads(line))

    # Basic stats
    report = {
        "total_examples": len(examples),
        "avg_turns_per_example": sum(
            len(ex["messages"]) for ex in examples
        ) / len(examples),
    }

    # Role distribution
    roles = {}
    for ex in examples:
        for msg in ex["messages"]:
            roles[msg["role"]] = roles.get(msg["role"], 0) + 1
    report["role_distribution"] = roles

    # Length stats
    response_lengths = [
        len(ex["messages"][-1]["content"].split())
        for ex in examples
    ]
    report["response_word_count"] = {
        "min": min(response_lengths),
        "max": max(response_lengths),
        "mean": sum(response_lengths) / len(response_lengths),
    }

    # Empty/short responses
    short = sum(1 for l in response_lengths if l < 10)
    report["short_responses"] = f"{short} ({short/len(examples)*100:.1f}%)"

    return report
```
