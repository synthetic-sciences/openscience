# Available Models & LoRA

## Model Selection Guide

- **Use MoE models** - More cost effective than dense
- **Base models** - For LoRA-based post-training research (no built-in chat format)
- **Instruction models** - Fast inference, no chain-of-thought
- **Hybrid/Reasoning models** - Long chain-of-thought for quality

## Model Lineup

| Model | Type | Architecture |
|-------|------|--------------|
| **Qwen/Qwen3-VL-235B-A22B-Instruct** | Vision | MoE Large |
| **Qwen/Qwen3-VL-30B-A3B-Instruct** | Vision | MoE Medium |
| Qwen/Qwen3-235B-A22B-Instruct-2507 | Instruction | MoE Large |
| Qwen/Qwen3-30B-A3B-Instruct-2507 | Instruction | MoE Medium |
| **Qwen/Qwen3-30B-A3B** | Hybrid | MoE Medium |
| Qwen/Qwen3-30B-A3B-Base | Base | MoE Medium |
| Qwen/Qwen3-32B | Hybrid | Dense Medium |
| Qwen/Qwen3-8B | Hybrid | Dense Small |
| Qwen/Qwen3-8B-Base | Base | Dense Small |
| Qwen/Qwen3-4B-Instruct-2507 | Instruction | Dense Compact |
| openai/gpt-oss-120b | Reasoning | MoE Medium |
| openai/gpt-oss-20b | Reasoning | MoE Small |
| deepseek-ai/DeepSeek-V3.1 | Hybrid | MoE Large |
| deepseek-ai/DeepSeek-V3.1-Base | Base | MoE Large |
| **meta-llama/Llama-3.1-8B** | Base | Dense Small |
| meta-llama/Llama-3.1-8B-Instruct | Instruction | Dense Small |
| meta-llama/Llama-3.3-70B-Instruct | Instruction | Dense Large |
| meta-llama/Llama-3.1-70B | Base | Dense Large |
| meta-llama/Llama-3.2-3B | Base | Dense Compact |
| meta-llama/Llama-3.2-1B | Base | Dense Compact |
| moonshotai/Kimi-K2-Thinking | Reasoning | MoE Large |

**Sizes:** Compact (1-4B), Small (8B), Medium (30-32B), Large (70B+)

**Types:**
- **Base**: Pretrained, no chat formatting — use for LoRA post-training research
- **Instruction**: Chat-tuned, fast inference
- **Hybrid**: Thinking + non-thinking modes
- **Reasoning**: Always uses chain-of-thought
- **Vision**: VLMs with image processing

## LoRA Primer

LoRA (Low-Rank Adaptation) fine-tunes small parameter subset instead of all weights.

### When LoRA Works Well

- SL on small-medium instruction datasets: **Same as full fine-tuning**
- RL: **Equivalent to full fine-tuning even with small ranks**
- Large datasets: May underperform (increase rank)
- LoRA performs better when applied to **all weight matrices** (attention + MLP + MoE). Attention-only LoRA underperforms even with matched parameter counts

### LoRA Limitations

- **Large batch sizes**: LoRA is less tolerant of large batch sizes than full FT — pays a larger loss penalty as batch size increases beyond some point. This penalty is NOT mitigated by increasing rank; it's a property of the product-of-matrices parametrization
- **Large SL datasets**: When dataset exceeds LoRA capacity, results in worse training efficiency (not a distinct floor)

### LoRA Learning Rate

**Critical:** LoRA needs 20-100x higher LR than full fine-tuning!

```python
from tinker_cookbook.hyperparam_utils import get_lora_lr_over_full_finetune_lr

model_name = "meta-llama/Llama-3.1-8B"
factor = get_lora_lr_over_full_finetune_lr(model_name)
# Factor varies by model size:
#   Llama-3.2-1B  → 32
#   Llama-3.1-8B  → ~50
#   Llama-3.1-70B → 128
```

### Recommended Learning Rate

```python
from tinker_cookbook.hyperparam_utils import get_lr

recommended_lr = get_lr("meta-llama/Llama-3.1-8B")
```

### LoRA Rank

Default rank: 32

```python
from tinker_cookbook.hyperparam_utils import get_lora_param_count

# Check parameter count
param_count = get_lora_param_count("meta-llama/Llama-3.1-8B", lora_rank=32)
```

**Rule of thumb:** LoRA params ≥ completion tokens for good SL results.

For RL: Small ranks work fine.

**Optimal LR does NOT depend on rank** - same LR works across ranks.

### LoRA Configuration

```python
training_client = service_client.create_lora_training_client(
    base_model="meta-llama/Llama-3.1-8B",
    rank=32,
    train_attn=True,   # Attention layers (default)
    train_mlp=True,    # MLP layers (default)
    train_unembed=False,  # Output embedding (optional)
    seed=42,  # For reproducibility
)
```

**Best practice:** Train all layers (attention + MLP), not just attention.

### Mathematical Definition

Original weight: W (n×n)
LoRA: W' = W + BA

- B: n×r matrix
- A: r×n matrix
- r: rank (default 32)

Think of LoRA as efficient random projection of parameter space.

## Model Selection Tips

1. **For cost efficiency:** Use MoE models (Qwen3-VL, Qwen3-30B-A3B)
2. **For experimentation:** Start with 8B models
3. **For vision tasks:** Qwen3-VL-30B-A3B-Instruct (cost-effective)
4. **For reasoning:** Hybrid or Reasoning models with CoT
5. **For latency:** Instruction models without CoT

## Creating Training Client

```python
# Get available models
service_client = tinker.ServiceClient()
for model in service_client.get_server_capabilities().supported_models:
    print(model.model_name)

# Create training client
training_client = service_client.create_lora_training_client(
    base_model="Qwen/Qwen3-30B-A3B",
    rank=32,
)
```
