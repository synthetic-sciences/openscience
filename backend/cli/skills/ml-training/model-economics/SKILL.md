---
name: model-economics
description: Cost modeling and ROI analysis for specialized LLM development. Use when deciding whether to train a custom model, estimating total cost, or calculating break-even vs frontier APIs. Covers training costs, inference costs, and time-to-ROI projections.
category: ml-training
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Economics, Cost Analysis, ROI, Break-Even, Training Cost, Inference Cost, Model Flywheel, Business Case]
dependencies: []
---

# Model Economics: Cost Analysis for LLM Specialization

## When to Use This Skill

Use this skill as the **first step** of any model-specialization assessment to determine:
- Is it worth training a specialized model?
- What will the total investment be?
- When will the specialized model break even vs frontier APIs?
- What's the ongoing cost comparison?

## Frontier API Cost Model

**Important**: Use `websearch` to get current pricing — these change frequently. Reference tiers as of early 2026:

### Premium Tier ($5-25/M output tokens)
| Model | Input ($/M) | Output ($/M) | Notes |
|-------|-------------|--------------|-------|
| Claude Opus 4.6 | $5.00 | $25.00 | Highest capability |
| GPT-5.2 Pro | $21.00 | $168.00 | Reasoning-heavy |

**Savings potential**: Highest. A specialized 8B model costs ~$0.05-0.15/M tokens to serve = 100-500x cheaper.

### Standard Tier ($1.75-14/M output tokens)
| Model | Input ($/M) | Output ($/M) | Notes |
|-------|-------------|--------------|-------|
| GPT-5.2 Chat | $1.75 | $14.00 | Most popular |
| Claude Sonnet 4.5 | $3.00 | $15.00 | Good balance |
| Qwen3 Max | $1.20 | $6.00 | Cost-effective |

**Savings potential**: Strong at volume. Break-even is achievable with moderate traffic.

### Budget Tier ($0.10-3/M output tokens)
| Model | Input ($/M) | Output ($/M) | Notes |
|-------|-------------|--------------|-------|
| Gemini 3 Flash | $0.50 | $3.00 | Fast, cheap |
| GLM 4.7 | $0.40 | $1.50 | Very cost-effective |
| Mistral Small | $0.10 | $0.30 | Cheapest commercial |

**Savings potential**: Harder to beat on cost alone. Specialize for quality, not cost.

### Free / Near-Free
Many open-weight models available on OpenRouter at $0. If you only need basic capability, self-hosting these is essentially free beyond GPU cost.

## Training Cost Estimation

### Tinker (Managed LoRA)
Cheapest option for supported models. No GPU management.

| Model Size | Method | Cost/1K examples | Duration |
|------------|--------|-------------------|----------|
| 8B | LoRA | ~$2-5 | 15-30 min |
| 14B | LoRA | ~$5-10 | 30-60 min |
| 32B | LoRA | ~$10-25 | 1-3 hours |
| 70B | LoRA | ~$25-60 | 3-8 hours |

Load `tinker-training-cost` skill for exact per-token rates.

### Modal (Serverless GPU)

| GPU | Cost/Hour | Best For |
|-----|-----------|----------|
| A100-40GB | ~$1.10 | 7-14B LoRA, 7B full |
| A100-80GB | ~$1.60 | 14-32B LoRA, 14B full |
| H100-80GB | ~$3.25 | 32-70B LoRA, large batches |

**Typical training runs**:
- 8B LoRA, 5K examples, 3 epochs: ~1-2 hours on A100 = $1-3
- 14B LoRA, 10K examples, 3 epochs: ~3-5 hours on A100-80GB = $5-8
- 70B LoRA, 10K examples, 2 epochs: ~8-12 hours on H100 = $26-39

### TensorPool (Dedicated GPU)

| GPU | Cost/Hour | Best For |
|-----|-----------|----------|
| A100-80GB | ~$1.50 | Standard training |
| H200-141GB | ~$3.00 | Large models, fast training |
| B200-192GB | ~$4.50 | Cutting-edge, maximum throughput |

Best for: Multi-day training, large-scale RL, dedicated inference.

## Inference Cost Comparison

The key calculation: what does it cost to serve the specialized model vs the frontier API?

### Self-Hosted Inference Cost

```python
def inference_cost_per_million_tokens(gpu_cost_per_hour, tokens_per_second):
    """Calculate cost per million tokens for self-hosted inference.

    Args:
        gpu_cost_per_hour: GPU rental cost (e.g., $3.25 for H100)
        tokens_per_second: Model throughput (varies by model size and batch)
    """
    tokens_per_hour = tokens_per_second * 3600
    cost_per_token = gpu_cost_per_hour / tokens_per_hour
    cost_per_million = cost_per_token * 1_000_000
    return cost_per_million
```

### Reference Throughput (vLLM, single GPU)

| Model Size | GPU | Tokens/sec (batch) | Cost/M tokens |
|------------|-----|-------------------|---------------|
| 8B | A100-80GB | ~3,000-5,000 | $0.09-0.15 |
| 8B | H100-80GB | ~5,000-8,000 | $0.11-0.18 |
| 14B | A100-80GB | ~1,500-3,000 | $0.15-0.30 |
| 14B | H100-80GB | ~3,000-5,000 | $0.18-0.30 |
| 32B | H100-80GB | ~800-1,500 | $0.60-1.10 |
| 70B | 2xH100 | ~500-1,000 | $1.80-3.60 |

**Key insight**: A specialized 8B model on Modal/TensorPool costs **$0.05-0.15/M tokens** vs **$5-25/M** for premium frontier = **50-500x cheaper per request**.

## Break-Even Calculator

```python
def break_even_analysis(
    monthly_api_spend: float,
    training_cost: float,
    monthly_inference_cost: float,
    setup_hours: float = 40,
    hourly_rate: float = 100,
):
    """Calculate break-even timeline for model specialization.

    Args:
        monthly_api_spend: Current monthly frontier API cost
        training_cost: One-time training cost (GPU + data prep)
        monthly_inference_cost: Monthly cost to serve specialized model
        setup_hours: Engineering time to set up pipeline
        hourly_rate: Engineering cost per hour
    """
    engineering_cost = setup_hours * hourly_rate
    total_upfront = training_cost + engineering_cost
    monthly_savings = monthly_api_spend - monthly_inference_cost

    if monthly_savings <= 0:
        return {
            "viable": False,
            "reason": "Specialized model costs more to serve than frontier API",
            "monthly_savings": monthly_savings,
        }

    months_to_break_even = total_upfront / monthly_savings

    return {
        "viable": True,
        "total_upfront_cost": total_upfront,
        "training_cost": training_cost,
        "engineering_cost": engineering_cost,
        "monthly_api_spend": monthly_api_spend,
        "monthly_inference_cost": monthly_inference_cost,
        "monthly_savings": monthly_savings,
        "months_to_break_even": round(months_to_break_even, 1),
        "annual_savings": monthly_savings * 12 - total_upfront,
        "year_2_savings": monthly_savings * 12,  # Fully amortized
    }


# Example: Replace GPT-4o for a specific task
result = break_even_analysis(
    monthly_api_spend=5000,       # $5K/month on GPT-4o
    training_cost=500,            # $500 for LoRA fine-tune + data prep
    monthly_inference_cost=200,   # $200/month on Modal (8B model)
    setup_hours=40,               # 1 week of engineering
    hourly_rate=100,              # $100/hr engineer
)
# Result: Break-even in ~1.1 months, $52K annual savings after year 1
```

## ROI Timeline Template

| Month | Frontier Cost | Specialized Cost | Cumulative Savings | Notes |
|-------|--------------|-----------------|-------------------|-------|
| 0 | — | $4,500 upfront | -$4,500 | Training + engineering |
| 1 | $5,000 | $200 | $300 | First month live |
| 2 | $5,000 | $200 | $5,100 | Break-even |
| 3 | $5,000 | $200 | $9,900 | |
| 6 | $5,000 | $200 | $24,300 | |
| 12 | $5,000 | $300 | $52,200 | Includes retrain cost |

## Decision Framework

### Strong Case for Specialization
- Monthly API spend > $1,000
- Constrained task (classification, extraction, formatting, domain Q&A)
- Production data available (logs, corrections, accept/reject signals)
- Quality requirements are well-defined and measurable
- Task doesn't change frequently

### Weak Case for Specialization
- Monthly API spend < $500
- Diverse, open-ended tasks (general assistant)
- No production data to train on
- Rapid model improvement expected (new frontier models releasing soon)
- Task requires reasoning at the frontier level
- Small team with no ML engineering capacity

### Hybrid Approach
Route easy requests to specialized model, hard ones to frontier:
- **90% of requests** → Specialized 8B (cheap, fast)
- **10% of requests** → Frontier fallback (complex, novel)
- **Result**: 80-90% cost reduction while maintaining quality on hard cases

## Quick Assessment Questions

Ask the user these to determine viability:

1. **What's your monthly frontier API spend?**
   - < $500: Probably not worth it (low ROI)
   - $500-2K: Worth investigating
   - $2K+: Strong candidate
   - $10K+: Almost certainly worth it

2. **How constrained is the task?**
   - Single task (classification, extraction): Great fit
   - Few related tasks: Good fit
   - Many diverse tasks: Harder to specialize

3. **What production data do you have?**
   - API logs with user feedback: Excellent
   - API logs without feedback: Good (can distill)
   - No production data: Need synthetic bootstrap

4. **What's your quality bar?**
   - Must match frontier exactly: Harder, may need bigger model
   - 90% of frontier quality is fine: 8B LoRA likely sufficient
   - Task-specific metrics (accuracy, format): Easiest to optimize
