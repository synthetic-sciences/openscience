---
name: tinker-fine-tuning
description: Provides guidance for fine-tuning LLMs using the Tinker cloud training API from Thinking Machines Lab. Use when running supervised fine-tuning, reinforcement learning (GRPO/PPO), or LoRA training on cloud GPUs via Tinker's managed infrastructure instead of local compute.
category: cloud-compute
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Fine-Tuning, Tinker, LoRA, Reinforcement Learning, Supervised Learning, DPO, RLHF, Cloud Training, Vision-Language Models]
dependencies: [tinker, tinker-cookbook, chz, transformers>=4.40.0, datasets, numpy]
---

# Tinker API - Cloud LLM Fine-Tuning

Expert guidance for fine-tuning large language models using Tinker's managed cloud training API. Tinker handles GPU allocation, model hosting, and distributed training — you write the training logic, Tinker runs it on cloud infrastructure.

## When to Use This Skill

**Use Tinker when you need to:**
- Fine-tune models up to 235B parameters without managing GPU infrastructure
- Run LoRA training on Qwen, Llama, DeepSeek, or GPT-OSS models
- Train vision-language models (Qwen3-VL)
- Implement custom RL loops (GRPO, PPO, importance sampling) on cloud GPUs
- Iterate quickly with a training API that handles hardware provisioning

**Do NOT use Tinker when:**
- You need full fine-tuning (not LoRA) — Tinker only supports LoRA
- You need to train custom architectures — Tinker supports specific model families
- You want to use your own GPUs — use Axolotl, Unsloth, or LLaMA-Factory instead
- You need offline/air-gapped training

**Tinker vs Alternatives:**

| Need | Use |
|------|-----|
| Managed cloud LoRA training | **Tinker** |
| Local GPU fine-tuning | Axolotl, Unsloth, LLaMA-Factory |
| Full parameter fine-tuning | DeepSpeed + Transformers |
| RLHF with TRL locally | TRL + GRPO skill |
| Quantized training | Unsloth, bitsandbytes |

## Quick Reference

| Topic | Reference |
|-------|-----------|
| Setup & Core Concepts | [Getting Started](references/getting-started.md) |
| API Classes & Types | [API Reference](references/api-reference.md) |
| Supervised Learning | [Supervised Learning](references/supervised-learning.md) |
| RL Training & Environments | [Reinforcement Learning](references/reinforcement-learning.md) |
| DPO, RLHF & Distillation | [DPO & Preference Learning](references/dpo-and-preference.md) |
| Loss Functions | [Loss Functions](references/loss-functions.md) |
| Chat Templates | [Rendering](references/rendering.md) |
| Models & LoRA | [Models & LoRA](references/models-and-lora.md) |
| Evaluations | [Evaluations](references/evaluations.md) |
| Example Scripts | [Recipes](references/recipes.md) |

## Installation

```bash
pip install tinker tinker-cookbook
# TINKER_API_KEY must be set — connect Tinker in the OpenScience dashboard to sync your API key.
# Verify: [ -n "$TINKER_API_KEY" ] && echo "set" || echo "not set"
```

---

## Workflow 1: Supervised Fine-Tuning (Cookbook)

Use this for standard SFT with JSONL or HuggingFace datasets.

### Checklist
- [ ] Prepare data in JSONL chat format (`{"messages": [...]}`)
- [ ] Choose base model (see model table below)
- [ ] Set hyperparameters (LR, batch size, epochs)
- [ ] Run training via Cookbook
- [ ] Monitor metrics (`train_mean_nll`, `test/nll`)
- [ ] Save and deploy weights

### Implementation

```python
import json
import chz
import asyncio
from tinker_cookbook.supervised import train
from tinker_cookbook.supervised.types import ChatDatasetBuilderCommonConfig
from tinker_cookbook.supervised.data import FromConversationFileBuilder
from tinker_cookbook.renderers import TrainOnWhat
from tinker_cookbook.model_info import get_recommended_renderer_name
from tinker_cookbook.hyperparam_utils import get_lr
from tinker_cookbook.tokenizer_utils import get_tokenizer

model_name = "Qwen/Qwen3-30B-A3B"
renderer_name = get_recommended_renderer_name(model_name)
num_epochs = 3
data_file = "training_data.jsonl"

common_config = ChatDatasetBuilderCommonConfig(
    model_name_for_tokenizer=model_name,
    renderer_name=renderer_name,
    max_length=2048,
    batch_size=128,
    train_on_what=TrainOnWhat.ALL_ASSISTANT_MESSAGES,
)

dataset_builder = FromConversationFileBuilder(
    common_config=common_config,
    file_path=data_file,
)

blueprint = chz.Blueprint(train.Config).apply({
    "log_path": "/tmp/sft-run",
    "model_name": model_name,
    "dataset_builder": dataset_builder,
    "learning_rate": get_lr(model_name),
    "lr_schedule": "linear",
    "num_epochs": num_epochs,
    "lora_rank": 32,
})

config = blueprint.make()
asyncio.run(train.main(config))

# --- Exact usage reporting (auto-captured by CLI) ---
tokenizer = get_tokenizer(model_name)
total_tokens = 0
with open(data_file) as f:
    for line in f:
        row = json.loads(line)
        text = " ".join(m.get("content", "") for m in row.get("messages", []))
        total_tokens += len(tokenizer.encode(text))
total_tokens *= num_epochs
print(f'\n[OPENSCIENCE_USAGE] {json.dumps({"service": "tinker", "event_type": "training", "model": model_name, "tokens_used": total_tokens})}')
```

### Data Format

JSONL with chat messages (one per line):
```json
{"messages": [{"role": "user", "content": "Translate to French: hello"}, {"role": "assistant", "content": "bonjour"}]}
```

### TrainOnWhat Options

| Option | When to Use |
|--------|-------------|
| `ALL_ASSISTANT_MESSAGES` | Standard SFT, multi-turn conversations |
| `LAST_ASSISTANT_MESSAGE` | Classification, chain-of-thought where only final answer matters |

---

## Workflow 2: Reinforcement Learning (GRPO-style)

Use this for training with reward functions — math reasoning, format compliance, verifiable tasks.

### Checklist
- [ ] Define reward function(s) that return float scores
- [ ] Choose group size (16 recommended)
- [ ] Set up sampling → reward → training loop
- [ ] Monitor `correct`, `format`, `reward/total`, KL divergence
- [ ] Keep KL below 0.01 for stable training

### Implementation (Cookbook)

```python
import json
import asyncio
import chz
from tinker_cookbook.rl import train
from tinker_cookbook.recipes.math_rl.math_env import Gsm8kDatasetBuilder
from tinker_cookbook import model_info

model_name = "meta-llama/Llama-3.1-8B"
renderer_name = model_info.get_recommended_renderer_name(model_name)
batch_size = 128
group_size = 16
max_tokens = 256

builder = Gsm8kDatasetBuilder(
    batch_size=batch_size,
    group_size=group_size,
    renderer_name=renderer_name,
    model_name_for_tokenizer=model_name,
)

blueprint = chz.Blueprint(train.Config).apply({
    "model_name": model_name,
    "log_path": "/tmp/rl-run",
    "dataset_builder": builder,
    "learning_rate": 4e-5,
    "max_tokens": max_tokens,
})

config = blueprint.make()
asyncio.run(train.main(config))

# --- Exact usage reporting (auto-captured by CLI) ---
# For RL: estimate from batch_size × group_size × max_tokens × num_batches
# The exact count comes from the training loop — check /tmp/rl-run for logs
import glob, os
log_files = sorted(glob.glob("/tmp/rl-run/metrics*.json"))
total_tokens = 0
for lf in log_files:
    with open(lf) as f:
        for line in f:
            m = json.loads(line)
            total_tokens += m.get("num_tokens", 0)
if total_tokens == 0:
    # Fallback estimate: batch_size × group_size × max_tokens × num_batches
    total_tokens = batch_size * group_size * max_tokens * 100
print(f'\n[OPENSCIENCE_USAGE] {json.dumps({"service": "tinker", "event_type": "training", "model": model_name, "tokens_used": total_tokens})}')
```

### Custom RL with Low-Level API

For full control over sampling, reward computation, and advantage centering:

```python
import json
import tinker
from tinker import types
from tinker.types.tensor_data import TensorData
import torch

model_name = "meta-llama/Llama-3.1-8B"
service_client = tinker.ServiceClient()
training_client = service_client.create_lora_training_client(
    base_model=model_name, rank=32
)

total_tokens = 0  # Track exact tokens for billing

for batch_idx, batch_rows in enumerate(dataset):
    path = training_client.save_weights_for_sampler(name=f"{batch_idx:06d}").result().path
    sampling_client = service_client.create_sampling_client(model_path=path)

    datums = []
    for question, answer in batch_rows:
        prompt = renderer.build_generation_prompt([{"role": "user", "content": question}])
        prompt_tokens = prompt.to_ints()
        result = sampling_client.sample(
            prompt=prompt, num_samples=16,
            sampling_params=types.SamplingParams(max_tokens=256, stop=renderer.get_stop_sequences()),
        ).result()

        rewards = [compute_reward(seq, answer) for seq in result.sequences]
        mean_reward = sum(rewards) / len(rewards)
        advantages = [r - mean_reward for r in rewards]
        if all(a == 0 for a in advantages):
            continue

        for seq, advantage in zip(result.sequences, advantages):
            tokens = prompt_tokens + seq.tokens
            ob_len = len(prompt_tokens) - 1
            datum = types.Datum(
                model_input=types.ModelInput.from_ints(tokens=tokens[:-1]),
                loss_fn_inputs={
                    "target_tokens": TensorData.from_torch(torch.tensor(tokens[1:])),
                    "logprobs": TensorData.from_torch(torch.tensor([0.0]*ob_len + list(seq.logprobs))),
                    "advantages": TensorData.from_torch(torch.tensor([0.0]*ob_len + [advantage]*(len(tokens)-1-ob_len))),
                },
            )
            datums.append(datum)

    # Track exact token count from datums
    total_tokens += sum(d.model_input.length() for d in datums)

    fwd_bwd = training_client.forward_backward(datums, loss_fn="importance_sampling")
    optim = training_client.optim_step(types.AdamParams(learning_rate=4e-5))
    fwd_bwd.result(); optim.result()

# --- Exact usage reporting (auto-captured by CLI) ---
print(f'\n[OPENSCIENCE_USAGE] {json.dumps({"service": "tinker", "event_type": "training", "model": model_name, "tokens_used": total_tokens})}')
```

### Available RL Loss Functions

| Loss | Use Case |
|------|----------|
| `importance_sampling` | Standard policy gradient with off-policy correction |
| `ppo` | Clipped surrogate objective (PPO) |
| `cispo` | Clipped importance sampling PO |
| `dro` | Direct reward optimization with quadratic penalty |

---

## Available Models

| Model | Type | Architecture | Train $/M tokens |
|-------|------|-------------|------------------|
| Qwen3-4B-Instruct-2507 | Instruction | Dense Compact | $0.22 |
| Qwen3-8B | Hybrid | Dense Small | $0.40 |
| Qwen3-30B-A3B | Hybrid | MoE Medium | $0.36 |
| Qwen3-32B | Hybrid | Dense Medium | $1.47 |
| Qwen3-VL-30B-A3B-Instruct | Vision | MoE Medium | $0.53 |
| Llama-3.2-1B | Base | Dense Compact | $0.09 |
| Llama-3.1-8B | Base | Dense Small | $0.40 |
| Llama-3.1-70B | Base | Dense Large | $3.16 |
| DeepSeek-V3.1 | Hybrid | MoE Large | $3.38 |
| GPT-OSS-120B | Reasoning | MoE Medium | $0.52 |

**Model Selection Tips:**
- **Cost efficiency**: MoE models (Qwen3-30B-A3B at $0.36/M)
- **Experimentation**: Start with 8B models
- **Vision tasks**: Qwen3-VL-30B-A3B-Instruct
- **Reasoning**: Hybrid or Reasoning models with chain-of-thought

## LoRA Configuration

Tinker exclusively uses LoRA. Default rank: 32.

```python
training_client = service_client.create_lora_training_client(
    base_model="Qwen/Qwen3-30B-A3B",
    rank=32,
    train_attn=True,
    train_mlp=True,
    seed=42,
)
```

**Critical**: LoRA needs 20-100x higher LR than full fine-tuning. Use `tinker_cookbook.hyperparam_utils.get_lr()` for recommended values.

## Hyperparameter Guide

| Parameter | SFT Default | RL Default | Notes |
|-----------|-------------|------------|-------|
| `learning_rate` | `get_lr(model)` | 4e-5 | Model-dependent; ~5e-4 for Qwen3-30B, ~2.8e-4 for Llama-8B |
| `batch_size` | 128 | 128 | Smaller generally better for fine-tuning |
| `lora_rank` | 32 | 32 | Higher rank = more capacity |
| `group_size` | N/A | 16 | Rollouts per problem for RL |
| `max_length` | 2048-32768 | N/A | Sequence length for SFT |
| `max_tokens` | N/A | 256 | Max generation length for RL |
| `num_epochs` | 1-3 | N/A | Training passes |
| `lr_schedule` | linear | N/A | Only `linear` and `constant` supported |

## Workflow 3: DPO (Preference Learning)

Use this for aligning models with human preferences without a separate reward model.

### Quick Start

```bash
python -m tinker_cookbook.recipes.preference.train \
    log_path=/tmp/dpo-experiment \
    model_name=meta-llama/Llama-3.2-1B \
    dataset=hhh \
    renderer_name=role_colon \
    learning_rate=1e-5 \
    dpo_beta=0.1
```

**Key differences from SFT**: Use lower LR (1e-5 to 1e-6), base model should be in-distribution with preference data.

**Available datasets**: `hhh` (Anthropic), `helpsteer3` (NVIDIA), `ultrafeedback`

**Full RLHF pipeline**: See [DPO & Preference Learning](references/dpo-and-preference.md) for the three-step SL → preference model → RL pipeline.

---

## Evaluations

### Inline (During Training)

Add `evaluator_builders` to config for periodic evaluation:

```python
blueprint = chz.Blueprint(train.Config).apply({
    ...
    "evaluator_builders": [my_evaluator],
    "eval_every": 8,
})
```

### Offline (After Training)

```bash
MODEL_PATH=tinker://YOUR_MODEL_PATH_HERE
python -m tinker_cookbook.eval.run_inspect_evals \
    model_path=$MODEL_PATH \
    model_name=MODEL_NAME \
    tasks=inspect_evals/ifeval,inspect_evals/mmlu_0_shot
```

See [Evaluations](references/evaluations.md) for custom evaluators and LLM-as-judge.

---

## Cost Estimation & Usage Tracking

### Pre-Training Cost Estimation

**ALWAYS estimate cost before starting Tinker training.** Load the `tinker-training-cost` skill and use its pricing tables or calculate manually:

```
Training Cost = (total_tokens × epochs × train_price_per_million) / 1,000,000
```

Present the cost estimate to the user for approval before starting training.

### Automatic Usage Reporting (Ground Truth)

**CRITICAL**: All training scripts MUST print a `[OPENSCIENCE_USAGE]` line at the end. The CLI automatically captures this and reports exact billing to the dashboard.

```python
# Add this at the END of every training script:
import json
print(f'\n[OPENSCIENCE_USAGE] {json.dumps({"service": "tinker", "event_type": "training", "model": model_name, "tokens_used": total_tokens})}')
```

How token counting works per workflow:
- **Cookbook SFT**: Tokenize dataset with `get_tokenizer(model_name)`, multiply by `num_epochs`
- **Cookbook RL**: Parse training logs for `num_tokens`, or estimate from `batch_size × group_size × max_tokens × batches`
- **Low-level API**: Sum `datum.model_input.length()` across all `forward_backward()` calls

The CLI bash tool scans output for `[OPENSCIENCE_USAGE]` markers and auto-reports to the dashboard — no manual reporting needed.

## Common Issues

| Problem | Solution |
|---------|----------|
| `TINKER_API_KEY` not set | `export TINKER_API_KEY=your_key` or check OpenScience credential sync |
| KL divergence > 0.01 | Reduce learning rate, check group size |
| OOM on dataset loading | Use `StreamingSupervisedDatasetFromHFDataset` for large datasets |
| Reward stuck at 0 | Debug reward function independently, check answer extraction |
| All advantages = 0 | Increase group size, ensure reward variance across completions |
| Wrong tokenizer | Use model-specific tokenizer (see Models & LoRA reference) |
| `Unknown learning rate schedule` | Only `"linear"` and `"constant"` are supported; `"cosine"` does NOT work |
| Python 3.14 pydantic errors | Tinker requires Python 3.10-3.13; pydantic v1 is incompatible with 3.14+ |
| Only 1 step per epoch | `batch_size` too large for dataset size; aim for 100+ steps per epoch |

## Saving and Resuming

```python
sampling_path = training_client.save_weights_for_sampler(name="final").result().path
sampling_client = service_client.create_sampling_client(model_path=sampling_path)

resume_path = training_client.save_state(name="checkpoint").result().path
training_client.load_state(resume_path)
```

## Common Imports

```python
import tinker
from tinker import types
from tinker.types import Datum, ModelInput, TensorData, AdamParams, SamplingParams

import chz
import asyncio
from tinker_cookbook.supervised import train
from tinker_cookbook.supervised.types import ChatDatasetBuilder, ChatDatasetBuilderCommonConfig
from tinker_cookbook.supervised.data import (
    SupervisedDatasetFromHFDataset,
    StreamingSupervisedDatasetFromHFDataset,
    FromConversationFileBuilder,
    conversation_to_datum,
)
from tinker_cookbook.renderers import get_renderer, TrainOnWhat
from tinker_cookbook.model_info import get_recommended_renderer_name
from tinker_cookbook.tokenizer_utils import get_tokenizer
```

## External Resources

- Documentation: https://tinker-docs.thinkingmachines.ai/
- Cookbook Repo: https://github.com/thinking-machines-lab/tinker-cookbook
- Console: https://tinker-console.thinkingmachines.ai
