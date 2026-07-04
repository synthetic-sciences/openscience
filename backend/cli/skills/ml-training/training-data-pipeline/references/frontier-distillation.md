# Frontier Distillation Reference

## Overview

Frontier distillation uses a large teacher model (GPT-4o, Claude, Gemini) to generate
high-quality labels for your production inputs. The student model learns to replicate
the teacher's behavior on your specific task at a fraction of the inference cost.

## When to Use

- You have production inputs but no gold-standard labels
- You want to match frontier quality on a specific task
- Volume justifies the one-time labeling cost (labels are reusable)
- Your task is narrow enough that a smaller model can learn it

## Batch API Comparison

| Provider | API | Discount | Turnaround | Max Batch |
|----------|-----|----------|------------|-----------|
| OpenAI | Batch API | 50% off | Up to 24h | 50,000 requests |
| Anthropic | Message Batches | 50% off | Up to 24h | 100,000 requests |
| Google | Batch Predict | Varies | Hours | Large |

## Distillation Prompt Design

The quality of distilled data depends on the prompt. Be explicit about format, style, and constraints.

```python
DISTILLATION_SYSTEM_PROMPT = """You are generating training data for a specialized model.

Task: {task_description}

Requirements:
- Output format: {format_spec}
- Tone: {tone}
- Length: {length_constraint}
- Must include: {required_elements}
- Must NOT include: {forbidden_elements}

Produce the highest quality response possible. This will be used as a training
target for a smaller model."""
```

### Key Principles

1. **Be explicit** — The teacher model should know exactly what format you need
2. **Include constraints** — Length, format, required sections, forbidden content
3. **Match production conditions** — Use the same system prompt you use in production
4. **Verify quality** — Sample and manually review 50-100 examples before using all

## Quality Filtering

Not all teacher outputs are good training data. Filter before training:

```python
def filter_distilled_data(examples, min_length=50, max_length=4000):
    """Filter distilled examples by quality heuristics."""
    filtered = []
    for ex in examples:
        response = ex["messages"][-1]["content"]

        # Length check
        if len(response) < min_length or len(response) > max_length:
            continue

        # Refusal detection
        refusal_phrases = [
            "I cannot", "I'm unable to", "I don't have access",
            "As an AI", "I'm not able to"
        ]
        if any(phrase.lower() in response.lower() for phrase in refusal_phrases):
            continue

        # Format compliance (customize per task)
        # if not response.startswith("{"):  # e.g., JSON output expected
        #     continue

        filtered.append(ex)

    print(f"Kept {len(filtered)}/{len(examples)} ({len(filtered)/len(examples)*100:.1f}%)")
    return filtered
```

## Cost Estimation

```python
def estimate_distillation_cost(num_examples, avg_input_tokens, avg_output_tokens, model="gpt-4o"):
    """Estimate batch distillation cost."""
    # Batch API prices (50% of real-time)
    prices = {
        "gpt-4o": {"input": 1.25, "output": 5.00},        # per 1M tokens, batch
        "gpt-4o-mini": {"input": 0.075, "output": 0.30},   # per 1M tokens, batch
        "claude-sonnet": {"input": 1.50, "output": 7.50},  # per 1M tokens, batch
    }
    p = prices.get(model, prices["gpt-4o"])

    input_cost = (num_examples * avg_input_tokens / 1_000_000) * p["input"]
    output_cost = (num_examples * avg_output_tokens / 1_000_000) * p["output"]
    total = input_cost + output_cost

    return {
        "model": model,
        "examples": num_examples,
        "input_cost": f"${input_cost:.2f}",
        "output_cost": f"${output_cost:.2f}",
        "total_cost": f"${total:.2f}",
    }
```

## Multi-Model Distillation

Using multiple teacher models reduces single-model bias:

```python
def multi_teacher_distillation(inputs, system_prompt, models=None):
    """Generate labels from multiple teachers and take majority or best."""
    models = models or ["gpt-4o", "claude-sonnet-4-5-20250929"]

    # Generate labels from each teacher
    all_labels = {model: generate_labels(inputs, system_prompt, model) for model in models}

    # Strategy 1: Use best model as primary, others for validation
    primary = all_labels[models[0]]

    # Strategy 2: Use agreement as quality signal
    # Keep examples where all teachers agree (highest confidence)

    return primary  # Or implement agreement filtering
```
