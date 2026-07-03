---
name: training-data-pipeline
description: Build training datasets for LLM specialization from production data, frontier model distillation, and synthetic bootstrapping. Use when formatting production logs into SFT data, distilling from frontier APIs, or preparing data for fine-tuning. Covers JSONL formatting, data quality validation, deduplication, and train/eval splitting.
category: ml-training
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Training Data, Data Pipeline, Fine-Tuning, Distillation, Synthetic Data, Production Data, JSONL, Data Quality]
dependencies: [datasets, transformers, openai]
---

# Training Data Pipeline

## When to Use This Skill

Use this skill when you need to:
- **Format production logs** into SFT training data (API logs, user corrections, accept/reject signals)
- **Distill from frontier models** using batch APIs (OpenAI, Anthropic) to label production inputs
- **Bootstrap synthetic data** when fewer than 1000 real examples exist
- **Validate data quality** before training (dedup, schema check, diversity metrics)
- **Split data** into train/eval sets with production data reserved for evaluation

### Three Data Paths

| Path | When to Use | Data Source | Cost |
|------|-------------|-------------|------|
| A) Production data | Have API logs or user feedback | Your own production systems | Free (already collected) |
| B) Frontier distillation | Have production inputs but no labels | OpenAI/Anthropic batch APIs | ~50% of real-time API cost |
| C) Synthetic bootstrap | < 1000 real examples | Frontier model generation | Varies by volume |

**Always prefer Path A** — production data is the moat competitors can't replicate.

## JSONL Chat Format

All training platforms (Tinker, Unsloth, TRL, Axolotl) accept this standard chat format:

```jsonl
{"messages": [{"role": "system", "content": "You are a helpful assistant."}, {"role": "user", "content": "What is 2+2?"}, {"role": "assistant", "content": "4"}]}
{"messages": [{"role": "user", "content": "Translate to French: Hello"}, {"role": "assistant", "content": "Bonjour"}]}
```

### Format Rules
- One JSON object per line, no trailing commas
- `messages` array with `role` and `content` fields
- Roles: `system` (optional, first only), `user`, `assistant` (alternating)
- Multi-turn: alternate user/assistant pairs within a single messages array
- UTF-8 encoding, no BOM
- `assistant` messages are the training targets — everything else is context

### Platform-Specific Notes

**Tinker**: Standard chat format above. Max 32K tokens per example. System message optional.

**Unsloth/TRL**: Same format. Also accepts `{"prompt": "...", "completion": "..."}` for simple pairs. Chat format preferred for multi-turn.

**Axolotl**: Supports multiple formats via config. Recommend `chat_template` type with standard JSONL.

## Path A: Production Data Collection

### From API Logs

If you log API requests/responses, convert them directly:

```python
import json

def api_log_to_training(log_entry):
    """Convert an API request/response log to training format."""
    messages = []

    # Add system prompt if present
    if log_entry.get("system_prompt"):
        messages.append({
            "role": "system",
            "content": log_entry["system_prompt"]
        })

    # Add the user's input
    messages.append({
        "role": "user",
        "content": log_entry["user_input"]
    })

    # Add the response (use corrected version if available)
    response = log_entry.get("corrected_response") or log_entry["api_response"]
    messages.append({
        "role": "assistant",
        "content": response
    })

    return {"messages": messages}

# Process logs
with open("api_logs.jsonl") as f, open("training_data.jsonl", "w") as out:
    for line in f:
        log = json.loads(line)
        example = api_log_to_training(log)
        out.write(json.dumps(example) + "\n")
```

### From User Corrections

User corrections (edits to model output) are the highest-quality training signal:

```python
def correction_to_training(original_input, corrected_output, system_prompt=None):
    """Convert a user correction into a training example.
    The corrected output becomes the training target."""
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": original_input})
    messages.append({"role": "assistant", "content": corrected_output})
    return {"messages": messages}
```

### From Accept/Reject Signals

If users accept or reject model outputs, use accepted outputs as positive examples:

```python
def filter_accepted(logs):
    """Keep only examples where user accepted the output."""
    accepted = []
    for log in logs:
        if log.get("user_action") == "accepted":
            accepted.append({
                "messages": [
                    {"role": "user", "content": log["input"]},
                    {"role": "assistant", "content": log["output"]}
                ]
            })
    return accepted
```

## Path B: Frontier Distillation

Use frontier models to label your production inputs. Best when you have real inputs but no gold labels.

### OpenAI Batch API (50% discount)

```python
import json

def create_batch_file(inputs, system_prompt, model="gpt-4o"):
    """Create a batch file for OpenAI Batch API."""
    requests = []
    for i, user_input in enumerate(inputs):
        requests.append({
            "custom_id": f"request-{i}",
            "method": "POST",
            "url": "/v1/chat/completions",
            "body": {
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_input}
                ],
                "max_tokens": 4096
            }
        })

    with open("batch_input.jsonl", "w") as f:
        for req in requests:
            f.write(json.dumps(req) + "\n")
    return "batch_input.jsonl"

# Submit batch
# openai api batches create -i batch_input.jsonl -e /v1/chat/completions -c 24h
```

### Anthropic Batch API

```python
import anthropic

client = anthropic.Anthropic()

def create_anthropic_batch(inputs, system_prompt, model="claude-sonnet-4-5-20250929"):
    """Create batch request for Anthropic Message Batches API."""
    requests = []
    for i, user_input in enumerate(inputs):
        requests.append({
            "custom_id": f"request-{i}",
            "params": {
                "model": model,
                "max_tokens": 4096,
                "system": system_prompt,
                "messages": [
                    {"role": "user", "content": user_input}
                ]
            }
        })

    batch = client.messages.batches.create(requests=requests)
    return batch.id
```

### Processing Batch Results

```python
def batch_results_to_training(results_file, inputs, system_prompt=None):
    """Convert batch API results into training JSONL."""
    training = []
    with open(results_file) as f:
        for line in f:
            result = json.loads(line)
            idx = int(result["custom_id"].split("-")[1])
            messages = []
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            messages.append({"role": "user", "content": inputs[idx]})
            # Extract assistant response from batch result
            content = result["response"]["body"]["choices"][0]["message"]["content"]
            messages.append({"role": "assistant", "content": content})
            training.append({"messages": messages})

    with open("distilled_training.jsonl", "w") as f:
        for example in training:
            f.write(json.dumps(example) + "\n")
    return len(training)
```

## Path C: Synthetic Bootstrapping

Generate training data from scratch when you have < 1000 real examples. Use as a starting point, then replace with production data as it accumulates.

### Seed Prompt Strategy

```python
import openai

client = openai.OpenAI()

def generate_synthetic_examples(task_description, seed_examples, n=500, model="gpt-4o"):
    """Generate diverse synthetic training examples from seed examples."""

    meta_prompt = f"""You are generating training data for an LLM that will be fine-tuned for:
{task_description}

Here are {len(seed_examples)} real examples of the desired behavior:
{json.dumps(seed_examples[:5], indent=2)}

Generate a NEW, diverse example. The input should cover a different scenario than
the seeds. The output should match the quality and style of the examples above.

Return JSON: {{"input": "...", "output": "..."}}"""

    examples = []
    for i in range(n):
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": meta_prompt}],
            response_format={"type": "json_object"},
            temperature=0.9,  # High temp for diversity
        )
        example = json.loads(response.choices[0].message.content)
        examples.append({
            "messages": [
                {"role": "user", "content": example["input"]},
                {"role": "assistant", "content": example["output"]}
            ]
        })
    return examples
```

### Diversity Strategies
- Vary temperature (0.7-1.0) across generation batches
- Use different frontier models (GPT-4o, Claude, Gemini) to reduce model-specific bias
- Seed with representative prompts from different categories/difficulty levels
- Include edge cases and adversarial examples explicitly in seed prompts

## Data Quality Validation

### Schema Validation

```python
def validate_jsonl(filepath):
    """Validate JSONL training file format."""
    errors = []
    valid = 0
    with open(filepath) as f:
        for i, line in enumerate(f, 1):
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                errors.append(f"Line {i}: Invalid JSON — {e}")
                continue

            if "messages" not in obj:
                errors.append(f"Line {i}: Missing 'messages' key")
                continue

            msgs = obj["messages"]
            if not isinstance(msgs, list) or len(msgs) < 2:
                errors.append(f"Line {i}: 'messages' must be a list with >= 2 entries")
                continue

            # Check roles
            has_user = any(m.get("role") == "user" for m in msgs)
            has_assistant = any(m.get("role") == "assistant" for m in msgs)
            if not has_user or not has_assistant:
                errors.append(f"Line {i}: Must have at least one user and one assistant message")
                continue

            for j, msg in enumerate(msgs):
                if "role" not in msg or "content" not in msg:
                    errors.append(f"Line {i}, message {j}: Missing 'role' or 'content'")
                elif msg["role"] not in ("system", "user", "assistant"):
                    errors.append(f"Line {i}, message {j}: Invalid role '{msg['role']}'")

            valid += 1

    return {"valid": valid, "errors": errors, "total": valid + len(errors)}
```

### Deduplication (MinHash)

```python
from datasketch import MinHash, MinHashLSH

def deduplicate_dataset(examples, threshold=0.8):
    """Remove near-duplicate examples using MinHash LSH."""
    lsh = MinHashLSH(threshold=threshold, num_perm=128)
    unique = []

    for i, ex in enumerate(examples):
        # Hash the assistant's response (training target)
        text = ex["messages"][-1]["content"]
        m = MinHash(num_perm=128)
        for word in text.lower().split():
            m.update(word.encode("utf-8"))

        key = f"doc-{i}"
        if not lsh.query(m):
            lsh.insert(key, m)
            unique.append(ex)

    removed = len(examples) - len(unique)
    print(f"Removed {removed} duplicates ({removed/len(examples)*100:.1f}%)")
    return unique
```

### Diversity Metrics

```python
from collections import Counter

def distinct_n(texts, n=2):
    """Calculate distinct-n metric (ratio of unique n-grams to total n-grams)."""
    total_ngrams = Counter()
    for text in texts:
        words = text.lower().split()
        ngrams = [tuple(words[i:i+n]) for i in range(len(words)-n+1)]
        total_ngrams.update(ngrams)
    if sum(total_ngrams.values()) == 0:
        return 0
    return len(total_ngrams) / sum(total_ngrams.values())

def dataset_diversity_report(examples):
    """Generate diversity metrics for a training dataset."""
    responses = [ex["messages"][-1]["content"] for ex in examples]
    inputs = [m["content"] for ex in examples for m in ex["messages"] if m["role"] == "user"]

    report = {
        "total_examples": len(examples),
        "avg_response_length": sum(len(r.split()) for r in responses) / len(responses),
        "avg_input_length": sum(len(i.split()) for i in inputs) / len(inputs),
        "distinct_1": distinct_n(responses, 1),
        "distinct_2": distinct_n(responses, 2),
        "distinct_3": distinct_n(responses, 3),
    }
    return report
```

## Train/Eval Split

```python
import random

def split_dataset(examples, eval_ratio=0.1, production_indices=None):
    """Split dataset into train/eval, keeping production data in eval for ground truth.

    Args:
        examples: List of training examples
        eval_ratio: Fraction of data for evaluation (default 10%)
        production_indices: Indices of real production examples (always go to eval)
    """
    production_indices = set(production_indices or [])
    synthetic = [ex for i, ex in enumerate(examples) if i not in production_indices]
    production = [ex for i, ex in enumerate(examples) if i in production_indices]

    # Production data goes to eval (ground truth)
    eval_set = list(production)

    # Fill remaining eval budget from synthetic
    remaining_eval = max(0, int(len(examples) * eval_ratio) - len(eval_set))
    random.shuffle(synthetic)
    eval_set.extend(synthetic[:remaining_eval])
    train_set = synthetic[remaining_eval:]

    print(f"Train: {len(train_set)}, Eval: {len(eval_set)} "
          f"({len(production)} production + {len(eval_set)-len(production)} synthetic)")
    return train_set, eval_set
```

## Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| `JSONDecodeError` | Trailing commas or malformed JSON | Run `validate_jsonl()` and fix flagged lines |
| Tokenizer mismatch | Data tokenized for wrong model | Always use target model's tokenizer for length checks |
| Training loss doesn't decrease | Data too noisy or contradictory | Filter low-quality examples, check for duplicates |
| Model repeats training data | Overfitting on small dataset | Add more diverse examples, reduce epochs |
| Data leakage | Eval examples appear in training | Use `split_dataset()` with `production_indices` |
| Encoding errors | Non-UTF-8 characters | `text.encode('utf-8', errors='replace').decode('utf-8')` |
| Examples too long | Exceeds model context | Truncate or split long conversations, check tokenizer limits |

## Quick Start Checklist

1. **Identify data source**: Production logs (A), frontier distillation (B), or synthetic (C)
2. **Format to JSONL**: Standard chat format with messages array
3. **Validate**: Run `validate_jsonl()` on the output file
4. **Deduplicate**: Run MinHash dedup with 0.8 threshold
5. **Check diversity**: Run `dataset_diversity_report()`, aim for distinct-2 > 0.5
6. **Split**: 90/10 train/eval, production data in eval set
7. **Count tokens**: Verify no examples exceed model's context window
8. **Proceed to training**: Load `tinker` or `unsloth` skill for next step
