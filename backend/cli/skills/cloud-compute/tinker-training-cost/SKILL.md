---
name: tinker-training-cost
description: Calculates training costs for Tinker fine-tuning jobs. Use when estimating costs for Tinker LLM training, counting tokens in datasets, or comparing Tinker model training prices. Tokenizes datasets using the correct model tokenizer and provides accurate cost estimates.
category: cloud-compute
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Tinker, Training Cost, Token Counting, Fine-Tuning, Pricing]
dependencies: [transformers>=4.40.0]
---

# Tinker Training Cost Calculator

Calculate training costs for Tinker fine-tuning jobs by tokenizing your dataset with the correct model tokenizer and applying current pricing.

## Quick Start

Use the bundled script to calculate training costs:

```bash
# List available models and pricing
python scripts/calculate_cost.py --list-models

# Calculate cost for a JSONL dataset
python scripts/calculate_cost.py training_data.jsonl --model Qwen3-8B --epochs 3

# Output as JSON
python scripts/calculate_cost.py training_data.jsonl --model Llama-3.1-70B --json
```

The script:
1. Loads the correct tokenizer for the selected model
2. Counts tokens in your JSONL file (supports chat, text, and instruction formats)
3. Calculates the estimated training cost

## Cost Formula

```
Training Cost = (total_tokens × epochs × train_price_per_million) / 1_000_000
```

Where:
- `total_tokens` = tokens in your training dataset (from tokenization)
- `epochs` = number of training passes (default: 3)
- `train_price_per_million` = model-specific training rate from pricing table

---

## Tinker Pricing

> **All prices as of January 5, 2026**
> Source: https://thinkingmachines.ai/tinker/

All prices are in **USD per million tokens**.

| Category | Description |
|----------|-------------|
| **Prefill** | Processing input context (inference) |
| **Sample** | Generating output tokens (inference) |
| **Train** | Training/fine-tuning tokens |

### Qwen Models

| Model | Prefill | Sample | Train |
|-------|---------|--------|-------|
| Qwen3-4B-Instruct-2507 | $0.07 | $0.22 | $0.22 |
| Qwen3-8B | $0.13 | $0.40 | $0.40 |
| Qwen3-30B-A3B | $0.12 | $0.30 | $0.36 |
| Qwen3-VL-30B-A3B-Instruct | $0.18 | $0.44 | $0.53 |
| Qwen3-32B | $0.49 | $1.47 | $1.47 |
| Qwen3-235B-Instruct-2507 | $0.68 | $1.70 | $2.04 |
| Qwen3-VL-235B-A22B-Instruct | $1.02 | $2.56 | $3.07 |

### Llama Models

| Model | Prefill | Sample | Train |
|-------|---------|--------|-------|
| Llama-3.2-1B | $0.03 | $0.09 | $0.09 |
| Llama-3.2-3B | $0.06 | $0.18 | $0.18 |
| Llama-3.1-8B | $0.13 | $0.40 | $0.40 |
| Llama-3.1-70B | $1.05 | $3.16 | $3.16 |

### DeepSeek Models

| Model | Prefill | Sample | Train |
|-------|---------|--------|-------|
| DeepSeek-V3.1 | $1.13 | $2.81 | $3.38 |

### GPT-OSS Models

| Model | Prefill | Sample | Train |
|-------|---------|--------|-------|
| GPT-OSS-120B | $0.18 | $0.44 | $0.52 |
| GPT-OSS-20B | $0.12 | $0.30 | $0.36 |

### Moonshot Models

| Model | Prefill | Sample | Train |
|-------|---------|--------|-------|
| Kimi-K2-Thinking | $0.98 | $2.44 | $2.93 |

---

## Model-to-Tokenizer Mapping

Use the correct HuggingFace tokenizer for accurate token counting:

| Model | HuggingFace Tokenizer |
|-------|----------------------|
| Qwen3-4B-Instruct-2507 | `Qwen/Qwen3-4B` |
| Qwen3-8B | `Qwen/Qwen3-8B` |
| Qwen3-30B-A3B | `Qwen/Qwen3-30B-A3B` |
| Qwen3-32B | `Qwen/Qwen3-32B` |
| Qwen3-235B-Instruct-2507 | `Qwen/Qwen3-235B-A22B-Instruct` |
| Qwen3-VL-* | `Qwen/Qwen2.5-VL-7B-Instruct` (shared VL tokenizer) |
| Llama-3.2-1B | `meta-llama/Llama-3.2-1B-Instruct` |
| Llama-3.2-3B | `meta-llama/Llama-3.2-3B-Instruct` |
| Llama-3.1-8B | `meta-llama/Llama-3.1-8B-Instruct` |
| Llama-3.1-70B | `meta-llama/Llama-3.1-70B-Instruct` |
| DeepSeek-V3.1 | `deepseek-ai/DeepSeek-V3` |
| GPT-OSS-* | `Qwen/Qwen3-8B` (compatible tokenizer) |
| Kimi-K2-Thinking | `moonshotai/Kimi-K2-Instruct` |

---

## Tokenization

The bundled `scripts/calculate_cost.py` handles tokenization automatically. For custom use:

```python
from transformers import AutoTokenizer

tokenizer = AutoTokenizer.from_pretrained("Qwen/Qwen3-8B", trust_remote_code=True)
token_count = len(tokenizer.encode("Your training text here"))
```

### Supported JSONL Formats

The script handles these training data formats:

**Chat format** (recommended):
```json
{"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
```

**Text format**:
```json
{"text": "Your training text here"}
```

**Instruction format** (Alpaca-style):
```json
{"instruction": "...", "input": "...", "output": "..."}
```

---

## Quick Cost Examples

### Example 1: Qwen3-8B on 1M tokens, 3 epochs
```
Dataset tokens: 1,000,000
Training tokens: 1,000,000 × 3 = 3,000,000
Cost: 3.0M × $0.40/M = $1.20
```

### Example 2: Llama-3.1-70B on 5M tokens, 2 epochs
```
Dataset tokens: 5,000,000
Training tokens: 5,000,000 × 2 = 10,000,000
Cost: 10.0M × $3.16/M = $31.60
```

### Example 3: Qwen3-235B on 2M tokens, 4 epochs
```
Dataset tokens: 2,000,000
Training tokens: 2,000,000 × 4 = 8,000,000
Cost: 8.0M × $2.04/M = $16.32
```

---

## Important Notes

1. **LoRA Fine-Tuning**: Tinker uses Low-Rank Adaptation (LoRA), not full fine-tuning
2. **Token Counting**: Always use the model's native tokenizer for accurate counts - different tokenizers produce different token counts for the same text
3. **Vision Models**: VL models have higher costs due to image processing overhead
4. **trust_remote_code**: Required for some tokenizers (Qwen, DeepSeek)
