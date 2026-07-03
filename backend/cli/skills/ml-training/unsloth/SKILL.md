---
name: unsloth-fine-tuning
description: Fast LLM fine-tuning with Unsloth - 2-5x faster training, 50-80% less VRAM. Use for single-GPU LoRA/QLoRA SFT, GRPO/RL reasoning training, vision/TTS fine-tuning, and GGUF export to Ollama/vLLM/llama.cpp. Supports 300+ models including Llama, Qwen, Gemma, DeepSeek, Mistral, Phi, and gpt-oss.
category: ml-training
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Fine-Tuning, Unsloth, LoRA, QLoRA, GRPO, RL, Vision, TTS, GGUF, Ollama, vLLM, Fast Training, Memory-Efficient]
dependencies: [unsloth, torch>=2.1.0, transformers>=4.45.0, trl>=0.15.0, datasets, peft, xformers]
---

# Unsloth - Fast LLM Fine-Tuning

Fine-tune LLMs 2-5x faster with 50-80% less VRAM. Supports SFT, RL (GRPO), vision, TTS, and 300+ models with zero accuracy loss.

## When to Use Unsloth

**Use Unsloth when:**
- Fine-tuning on a single GPU with LoRA/QLoRA (consumer or datacenter)
- Training reasoning models with GRPO, Dr. GRPO, DAPO, BNPO, or GSPO
- Fine-tuning vision models (Qwen3-VL, Gemma 3, Llama 3.2 Vision)
- Fine-tuning TTS models (Orpheus, Sesame-CSM, Whisper)
- Exporting to GGUF for Ollama, llama.cpp, or LM Studio
- Need padding-free training and uncontaminated packing (automatic)
- Using FP8 precision for additional memory savings on Ampere+ GPUs

**Don't use Unsloth when:**
- Multi-node distributed training at scale (Unsloth DDP works but is single-node)
- Apple Silicon / MLX (not yet supported)
- Full fine-tuning of 70B+ models (use DeepSpeed + Transformers)
- Custom architectures not supported by `transformers`
- Cloud-managed training without GPU access (use Tinker instead)

**Unsloth vs Alternatives:**

| Need | Use |
|------|-----|
| Fast single-GPU LoRA/QLoRA | **Unsloth** |
| Managed cloud LoRA training | Tinker |
| Parameter-efficient methods (IA3, Prefix, etc.) | PEFT |
| Multi-node distributed training | DeepSpeed + Transformers |
| YAML-config-driven training | Axolotl |
| Full fine-tuning with FSDP | Transformers + Accelerate |

## Quick Reference

| Topic | Documentation |
|-------|---------------|
| Overview & Features | [docs/overview.md](docs/overview.md) |
| Installation (pip) | [docs/installation-pip.md](docs/installation-pip.md) |
| Installation (Docker) | [docs/installation-docker.md](docs/installation-docker.md) |
| Model Selection Guide | [docs/model-selection.md](docs/model-selection.md) |
| VRAM Requirements | [docs/requirements.md](docs/requirements.md) |
| Model Catalog (300+) | [docs/models.md](docs/models.md) |
| Datasets & Formatting | [docs/datasets.md](docs/datasets.md) |
| Chat Templates | [docs/chat-templates.md](docs/chat-templates.md) |
| LoRA Hyperparameters | [docs/lora-hyperparameters.md](docs/lora-hyperparameters.md) |
| GRPO RL Tutorial | [docs/tutorial-grpo.md](docs/tutorial-grpo.md) |
| Advanced RL Parameters | [docs/advanced-rl.md](docs/advanced-rl.md) |
| Memory-Efficient RL | [docs/memory-efficient-rl.md](docs/memory-efficient-rl.md) |
| Vision Fine-Tuning | [docs/vision-fine-tuning.md](docs/vision-fine-tuning.md) |
| Vision RL (VLM GRPO) | [docs/vision-rl.md](docs/vision-rl.md) |
| TTS Fine-Tuning | [docs/tts-fine-tuning.md](docs/tts-fine-tuning.md) |
| Saving to GGUF | [docs/saving-to-gguf.md](docs/saving-to-gguf.md) |
| Saving to Ollama | [docs/saving-to-ollama.md](docs/saving-to-ollama.md) |
| vLLM Deployment | [docs/vllm-guide.md](docs/vllm-guide.md) |
| FP8 Training | [docs/fp8-rl.md](docs/fp8-rl.md) |
| FP16 vs BF16 for RL | [docs/fp16-vs-bf16.md](docs/fp16-vs-bf16.md) |
| Multi-GPU DDP | [docs/multi-gpu-ddp.md](docs/multi-gpu-ddp.md) |
| Kernels & Packing | [docs/kernels-packing.md](docs/kernels-packing.md) |
| Inference | [docs/inference.md](docs/inference.md) |
| Troubleshooting | [docs/troubleshooting-faq.md](docs/troubleshooting-faq.md) |
| Troubleshooting Inference | [docs/troubleshooting-inference.md](docs/troubleshooting-inference.md) |

## Installation

```bash
# Recommended (pip)
pip install unsloth

# With vLLM (for GRPO fast inference)
pip install uv && uv pip install unsloth vllm

# Docker (all dependencies pre-installed)
docker run -d -e JUPYTER_PASSWORD="mypassword" \
  -p 8888:8888 --gpus all -v $(pwd)/work:/workspace/work \
  unsloth/unsloth
```

**Requirements:** Linux or Windows (WSL), NVIDIA GPU with CUDA Capability 7.0+ (V100, T4, RTX 20-50, A100, H100, L40). AMD and Intel GPUs also supported. Python 3.10-3.13.

---

## Workflow 1: SFT (Supervised Fine-Tuning)

Use this for standard instruction tuning, chat fine-tuning, or domain adaptation.

### Checklist
- [ ] Prepare dataset in ShareGPT, ChatML, or Alpaca format
- [ ] Choose base vs instruct model (see Model Selection below)
- [ ] Select QLoRA (4-bit) or LoRA (16-bit) based on VRAM
- [ ] Set hyperparameters (rank, alpha, LR, epochs)
- [ ] Run training with SFTTrainer
- [ ] Save and deploy (LoRA adapter, merged 16-bit, or GGUF)

### Implementation

```python
from unsloth import FastLanguageModel
from trl import SFTTrainer, SFTConfig
from datasets import load_dataset

# Step 1: Load model (QLoRA 4-bit)
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="unsloth/Qwen3-8B-bnb-4bit",  # or any HF model
    max_seq_length=2048,
    load_in_4bit=True,   # False for LoRA 16-bit
)

# Step 2: Add LoRA adapters
model = FastLanguageModel.get_peft_model(
    model,
    r=16,                              # Rank: 8-128 (16-32 recommended)
    lora_alpha=16,                     # Alpha: equal to r or 2*r
    lora_dropout=0,                    # 0 is default, use 0.05-0.1 for regularization
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                    "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth",  # 30% less VRAM
    use_rslora=False,                  # True for rank-stabilized LoRA
)

# Step 3: Prepare dataset
dataset = load_dataset("philschmid/dolly-15k-oai-style", split="train")

# Step 4: Train
trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset,
    args=SFTConfig(
        output_dir="./sft-output",
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,   # Effective batch = 2*4 = 8
        num_train_epochs=3,
        learning_rate=2e-4,
        fp16=True,                       # or bf16=True
        logging_steps=10,
        optim="adamw_8bit",
        max_seq_length=2048,
        packing=True,                    # Uncontaminated packing (2-5x faster)
    ),
)
trainer.train()

# Step 5: Save
model.save_pretrained("lora_adapter")          # LoRA only (~6MB)
tokenizer.save_pretrained("lora_adapter")
```

### Data Formats

| Format | Template | Use Case |
|--------|----------|----------|
| ShareGPT | `{"conversations": [{"from": "human", ...}]}` | Multi-turn chat, instruct models |
| ChatML / OpenAI | `{"messages": [{"role": "user", ...}]}` | OpenAI-compatible, instruct models |
| Alpaca | `{"instruction": ..., "input": ..., "output": ...}` | Single-turn tasks, base models |
| Raw text | Plain text corpus | Continued pretraining |

Use `get_chat_template(tokenizer, chat_template="chatml")` to apply templates. Use `standardize_sharegpt(dataset)` for ShareGPT-formatted data with non-standard keys.

### Training on Completions Only

Mask user inputs so loss is only computed on assistant responses:

```python
from unsloth.chat_templates import train_on_responses_only
trainer = train_on_responses_only(
    trainer,
    instruction_part="<|start_header_id|>user<|end_header_id|>\n\n",      # Llama 3.x
    response_part="<|start_header_id|>assistant<|end_header_id|>\n\n",
)
# For Gemma: instruction_part="<start_of_turn>user\n", response_part="<start_of_turn>model\n"
```

**Sources:** [docs/datasets.md](docs/datasets.md), [docs/chat-templates.md](docs/chat-templates.md), [docs/lora-hyperparameters.md](docs/lora-hyperparameters.md)

---

## Workflow 2: RL Training (GRPO)

Use this for training reasoning models with reward functions — math, code, format compliance, verifiable tasks.

### Checklist
- [ ] Define reward function(s) returning float scores
- [ ] Choose model and enable vLLM fast inference
- [ ] Enable Unsloth Standby for memory-efficient RL
- [ ] Configure GRPOConfig with num_generations, epsilon, loss_type
- [ ] Monitor reward curves and KL divergence
- [ ] Save and export model

### Implementation

```python
import os
os.environ["UNSLOTH_VLLM_STANDBY"] = "1"  # Memory-efficient RL

from unsloth import FastLanguageModel
import torch
import re

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="unsloth/Qwen3-8B",
    max_seq_length=2048,
    load_in_4bit=True,          # False for LoRA 16-bit
    fast_inference=True,         # Enable vLLM for fast generation
    max_lora_rank=32,
    gpu_memory_utilization=0.9,  # Reduce if OOM
)

model = FastLanguageModel.get_peft_model(
    model, r=32, lora_alpha=64,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                    "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth",
)

# Define reward functions
def correctness_reward(completions, answer, **kwargs):
    scores = []
    for completion in completions:
        match = re.search(r"<answer>(.*?)</answer>", completion, re.DOTALL)
        extracted = match.group(1).strip() if match else ""
        scores.append(1.0 if extracted == answer else 0.0)
    return scores

def format_reward(completions, **kwargs):
    pattern = r"<reasoning>.*?</reasoning>\s*<answer>.*?</answer>"
    return [1.0 if re.search(pattern, c, re.DOTALL) else 0.0 for c in completions]

# Train
from trl import GRPOConfig, GRPOTrainer

training_args = GRPOConfig(
    output_dir="./grpo-output",
    per_device_train_batch_size=2,
    gradient_accumulation_steps=4,
    learning_rate=5e-6,
    num_generations=8,          # Rollouts per prompt
    max_completion_length=512,
    max_prompt_length=512,
    max_steps=250,
    temperature=1.0,
    # RL algorithm variants
    loss_type="dapo",           # "grpo", "dr_grpo", "dapo", "bnpo"
    epsilon=0.2,
    epsilon_high=0.28,          # DAPO upper clipping
    scale_rewards="none",       # Dr. GRPO: no reward scaling
    optim="adamw_8bit",
    report_to="none",
)

trainer = GRPOTrainer(
    model=model,
    processing_class=tokenizer,
    args=training_args,
    train_dataset=dataset,
    reward_funcs=[correctness_reward, format_reward],
)
trainer.train()

# Save
model.save_lora("grpo_saved_lora")
```

### RL Algorithm Variants

| Algorithm | `loss_type` | Key Setting | Notes |
|-----------|-------------|-------------|-------|
| GRPO | `"grpo"` | Default | Standard group relative policy optimization |
| Dr. GRPO | `"dr_grpo"` | `scale_rewards="none"` | No reward normalization, more stable |
| DAPO | `"dapo"` | `epsilon_high=0.28` | Two-sided clipping, recommended default |
| BNPO | `"bnpo"` | — | Bounded negative policy optimization |
| GSPO | any | `importance_sampling_level="sequence"` | Sequence-level importance weighting (Qwen team) |

### Unsloth Standby (Memory-Efficient RL)

Set `os.environ["UNSLOTH_VLLM_STANDBY"] = "1"` before imports. This shares vLLM's weight space with training and repurposes KV cache memory during training — saving up to 60% VRAM. On H100 80GB: 16GB shared weights + 64GB multi-purpose space.

**Sources:** [docs/tutorial-grpo.md](docs/tutorial-grpo.md), [docs/advanced-rl.md](docs/advanced-rl.md), [docs/memory-efficient-rl.md](docs/memory-efficient-rl.md)

---

## Workflow 3: Vision Fine-Tuning

Use this for training vision-language models on image+text tasks.

### Implementation

```python
from unsloth import FastVisionModel
from trl import SFTTrainer, SFTConfig
from unsloth.trainer import UnslothVisionDataCollator

model, tokenizer = FastVisionModel.from_pretrained(
    "unsloth/Qwen2.5-VL-7B-Instruct-bnb-4bit",
    max_seq_length=2048,
    load_in_4bit=True,
)

model = FastVisionModel.get_peft_model(
    model,
    finetune_vision_layers=True,       # Toggle vision encoder training
    finetune_language_layers=True,
    finetune_attention_modules=True,
    finetune_mlp_modules=True,
    r=16, lora_alpha=16,
    target_modules="all-linear",
    use_gradient_checkpointing="unsloth",
)

# Dataset format: user content has text + image
def convert_to_conversation(sample):
    return {"messages": [
        {"role": "user", "content": [
            {"type": "text", "text": "Describe this image."},
            {"type": "image", "image": sample["image"]}]},
        {"role": "assistant", "content": [
            {"type": "text", "text": sample["caption"]}]},
    ]}

dataset = [convert_to_conversation(s) for s in raw_dataset]  # Use list, not .map()

trainer = SFTTrainer(
    model=model, tokenizer=tokenizer,
    data_collator=UnslothVisionDataCollator(model, tokenizer),
    train_dataset=dataset,
    args=SFTConfig(output_dir="./vision-output", max_seq_length=2048,
                   per_device_train_batch_size=1, gradient_accumulation_steps=4),
)
trainer.train()
```

### Vision RL (GRPO with Images)

For VLM RL with vLLM, set `fast_inference=True` but `finetune_vision_layers=False` (vLLM limitation). Enable Standby for memory savings.

### Supported Vision Models

| Model | Sizes | Notes |
|-------|-------|-------|
| Qwen3-VL | 2B-235B | Best vLLM VLM support |
| Qwen2.5-VL | 3B-72B | Stable, well-tested |
| Gemma 3 | 4B-27B | Requires L4+ GPU (BF16 only in vLLM) |
| Llama 3.2 Vision | 11B, 90B | No vLLM LoRA support; use Unsloth inference |
| Pixtral | 12B | Mistral vision model |

**Sources:** [docs/vision-fine-tuning.md](docs/vision-fine-tuning.md), [docs/vision-rl.md](docs/vision-rl.md)

---

## Workflow 4: TTS Fine-Tuning

Use this for voice cloning, style adaptation, or speech-to-text fine-tuning.

```python
from unsloth import FastModel
from datasets import load_dataset, Audio

model, tokenizer = FastModel.from_pretrained(
    "unsloth/orpheus-3b-0.1-ft",
    max_seq_length=2048,
    load_in_4bit=False,  # 16-bit recommended for TTS
)

dataset = load_dataset("MrDragonFox/Elise", split="train")
dataset = dataset.cast_column("audio", Audio(sampling_rate=24000))  # 24kHz required
```

Orpheus supports emotional tags: `<laugh>`, `<sigh>`, `<cough>`, `<gasp>`, `<yawn>`, etc.

### TTS Models

| Model | Size | Type | Notes |
|-------|------|------|-------|
| Orpheus-TTS | 3B | Speech generation | Emotional cues, llama.cpp compatible |
| Sesame-CSM | 1B | Speech generation | Requires audio context per speaker |
| Spark-TTS | 0.5B | Speech generation | Smallest, fastest inference |
| Whisper Large V3 | ~1.5B | Speech-to-text | STT fine-tuning |
| Llasa-TTS | 1B | Speech generation | — |
| Oute-TTS | 1B | Speech generation | — |

**Sources:** [docs/tts-fine-tuning.md](docs/tts-fine-tuning.md)

---

## Workflow 5: Colab Fine-Tuning (Remote GPU)

Use this to run any Unsloth workflow on a Google Colab GPU directly from openscience — no local GPU required.

### Setup
1. Generate the bridge notebook: `colab_notebook workflow=bridge`
2. Upload to Google Colab, select GPU runtime, run all cells
3. Copy the WebSocket URL → `colab_connect connection_url="wss://..."`

### Run Training Remotely
```
colab_finetune workflow=sft model="unsloth/Qwen3-4B-unsloth-bnb-4bit" dataset="mlabonne/FineTome-100k"
```

All SFT/GRPO/DPO/vision/TTS workflows work identically on Colab. The plugin handles:
- Unsloth installation on the Colab VM
- Model loading, LoRA setup, dataset preparation
- Training execution with streaming output
- Model saving and optional HuggingFace Hub push

### GPU Recommendations

| Colab Tier | GPU | VRAM | Max Model (QLoRA) |
|-----------|-----|------|-------------------|
| Free | T4 | 15 GB | ~14B |
| Pro | A100 | 40 GB | ~32B |
| Pro+ | A100 80GB | 80 GB | ~72B |

### Key Differences from Local Training
- Files are ephemeral — save to HuggingFace Hub with `push_to_hub` parameter
- Session may disconnect — use keep-alive cell in bridge notebook
- Package installation happens on each new session

See the **colab-finetuning** skill for detailed Colab-specific guidance.

---

## Model Selection

### Instruct vs Base Model

| Dataset Size | Recommendation |
|-------------|----------------|
| 1,000+ rows | Base model (more customizable) |
| 300-1,000 rows | Either base or instruct |
| < 300 rows | Instruct model (preserves built-in capabilities) |

### Model Name Conventions

| Suffix | Meaning |
|--------|---------|
| `unsloth-bnb-4bit` | Unsloth dynamic 4-bit quants (higher accuracy, slightly more VRAM) |
| `bnb-4bit` | Standard BitsAndBytes 4-bit quantization |
| No suffix | Original 16-bit or 8-bit format |

### VRAM Requirements

| Parameters | QLoRA (4-bit) | LoRA (16-bit) |
|-----------|---------------|---------------|
| 3B | 3.5 GB | 8 GB |
| 7-8B | 5-6 GB | 19-22 GB |
| 14B | 8.5 GB | 33 GB |
| 27B | 22 GB | 64 GB |
| 32B | 26 GB | 76 GB |
| 70B | 41 GB | 164 GB |
| 90B | 53 GB | 212 GB |

Common OOM fix: reduce `per_device_train_batch_size` to 1 or 2.

**Sources:** [docs/model-selection.md](docs/model-selection.md), [docs/requirements.md](docs/requirements.md)

---

## Key Hyperparameters

| Parameter | Default | Range | Notes |
|-----------|---------|-------|-------|
| `r` (rank) | 16 | 8-128 | Higher = more capacity, more VRAM. Start with 16-32 |
| `lora_alpha` | r | r to 2*r | Scaling factor. `W_hat = W + (alpha/r) * AB` |
| `lora_dropout` | 0 | 0-0.1 | Regularization. 0 is recommended default |
| `target_modules` | attention | `"all-linear"` or list | QLoRA-All gives best quality |
| `use_gradient_checkpointing` | — | `"unsloth"` | 30% less memory than standard checkpointing |
| `use_rslora` | False | True/False | Rank-stabilized LoRA: scales by `sqrt(r)` instead of `r` |
| `learning_rate` | 2e-4 | 1e-4 to 5e-4 | For LoRA/QLoRA SFT. Use 5e-6 for RL |
| `num_train_epochs` | 3 | 1-5 | More than 5 risks overfitting |
| `per_device_train_batch_size` | 2 | 1-8 | Reduce to 1 if OOM |
| `gradient_accumulation_steps` | 4 | 1-16 | Effective batch = batch_size * accumulation |

### Batch Size Equivalence

Unsloth's gradient accumulation fix makes all configurations equivalent:

```
Effective Batch Size = per_device_train_batch_size × gradient_accumulation_steps
# batch_size=2, accum=4 ≡ batch_size=1, accum=8 ≡ batch_size=8, accum=1
```

**Sources:** [docs/lora-hyperparameters.md](docs/lora-hyperparameters.md)

---

## Saving and Deployment

### Save Methods

```python
# LoRA adapter only (~6MB)
model.save_pretrained("lora_adapter")

# Merged 16-bit (for vLLM deployment)
model.save_pretrained_merged("model_16bit", tokenizer, save_method="merged_16bit")

# GGUF (for Ollama, llama.cpp, LM Studio)
model.save_pretrained_gguf("model_gguf", tokenizer, quantization_method="q4_k_m")

# Push to Hugging Face Hub
model.push_to_hub_merged("username/model", tokenizer, save_method="merged_16bit", token="...")
model.push_to_hub_gguf("username/model", tokenizer, quantization_method="q4_k_m", token="...")
```

### GGUF Quantization Options

| Method | Bits | Quality | Speed | Size | Notes |
|--------|------|---------|-------|------|-------|
| `f16` | 16 | Best | Slow | Large | 100% accuracy, no quantization |
| `q8_0` | 8 | Very High | Good | Medium | Generally acceptable |
| `q5_k_m` | 5 | High | Fast | Small | Good balance |
| `q4_k_m` | 4 | Good | Fast | Small | **Recommended** for most use cases |
| `q3_k_m` | 3 | OK | Fastest | Smallest | For very limited VRAM |
| `q2_k` | 2 | Lower | Fastest | Tiny | Maximum compression |

### Deployment Targets

| Platform | Save Method | Command |
|----------|-------------|---------|
| Ollama | `save_pretrained_gguf` | Auto-creates Modelfile, then `ollama create` |
| vLLM | `save_pretrained_merged("...", save_method="merged_16bit")` | `vllm serve ./model` |
| llama.cpp | `save_pretrained_gguf` or manual GGUF | `./llama-cli -m model.gguf` |
| LM Studio | `save_pretrained_gguf` | Import GGUF file |
| Hugging Face | `push_to_hub_merged` or `push_to_hub_gguf` | Online inference |

### Inference with Unsloth (2x faster)

```python
from unsloth import FastLanguageModel
model, tokenizer = FastLanguageModel.from_pretrained("lora_adapter", max_seq_length=2048, load_in_4bit=True)
FastLanguageModel.for_inference(model)  # Enable 2x faster inference

inputs = tokenizer("What is machine learning?", return_tensors="pt").to("cuda")
output = model.generate(**inputs, max_new_tokens=256)
print(tokenizer.decode(output[0], skip_special_tokens=True))
```

**Sources:** [docs/saving-to-gguf.md](docs/saving-to-gguf.md), [docs/saving-to-ollama.md](docs/saving-to-ollama.md), [docs/vllm-guide.md](docs/vllm-guide.md), [docs/inference.md](docs/inference.md)

---

## Common Issues

| Problem | Solution |
|---------|----------|
| CUDA OOM during training | Reduce `per_device_train_batch_size` to 1. Enable `use_gradient_checkpointing="unsloth"`. Use QLoRA (`load_in_4bit=True`). |
| Poor results after GGUF/Ollama export | Use the SAME chat template for training and inference. Check `eos_token`. Use conversational notebooks to force template. |
| GGUF/vLLM 16-bit save crashes | Reduce `maximum_memory_usage` to 0.5: `model.save_pretrained(..., maximum_memory_usage=0.5)` |
| Overfitting (val loss increases) | Reduce epochs/LR, increase weight_decay/lora_dropout, add more data, use early stopping |
| Underfitting (loss stays high) | Increase rank, alpha, epochs, or LR. Decrease batch size to 1. Use domain-relevant data. |
| All labels are -100 | `train_on_responses_only` has wrong instruction/response parts for your model. Check template. |
| RL OOM with vLLM | Enable Standby: `os.environ["UNSLOTH_VLLM_STANDBY"] = "1"`. Reduce `gpu_memory_utilization`. |
| `add_new_tokens` breaks LoRA | Must call `add_new_tokens(model, tokenizer, ...)` BEFORE `get_peft_model()` |
| CUDA device-side assert | Set `os.environ["UNSLOTH_COMPILE_DISABLE"] = "1"` and `os.environ["UNSLOTH_DISABLE_FAST_GENERATION"] = "1"` |
| New model not supported | Set `trust_remote_code=True` and `unsloth_force_compile=True` — works with any `transformers`-compatible model |
| Downloads stuck at 90-95% | Set `os.environ["UNSLOTH_STABLE_DOWNLOADS"] = "1"` before imports |
| torch.compile slow startup | Normal — takes ~5 minutes to warm up. Measure throughput after warmup. Disable with `UNSLOTH_COMPILE_DISABLE=1`. |

**Sources:** [docs/troubleshooting-faq.md](docs/troubleshooting-faq.md), [docs/troubleshooting-inference.md](docs/troubleshooting-inference.md)

---

## Best Practices

1. **Start with QLoRA 4-bit** (`load_in_4bit=True`) — fits most models on consumer GPUs with minimal accuracy loss
2. **Use `unsloth-bnb-4bit` model variants** for higher accuracy than standard 4-bit quants
3. **Set `use_gradient_checkpointing="unsloth"`** — 30% less VRAM than standard gradient checkpointing
4. **Use `target_modules="all-linear"`** for best quality, or specify attention+MLP modules
5. **Start with rank 16-32**, increase only if quality is insufficient
6. **Set `lora_alpha = r` or `2*r`** — higher alpha increases effective learning rate
7. **Enable packing** (`packing=True` in SFTConfig) for 2-5x faster training with proper attention masking
8. **Use `train_on_responses_only`** to avoid training on user prompts
9. **For RL, enable Standby** (`UNSLOTH_VLLM_STANDBY=1`) and `fast_inference=True`
10. **Use DAPO loss** (`loss_type="dapo"`) as the default RL algorithm — most stable
11. **Always use the same chat template** for training and inference to avoid gibberish output
12. **Consider FP8** (`load_in_fp8=True`) on Ampere+ GPUs for 60% less VRAM with ~equal accuracy
13. **Split dataset** into train/test and enable `eval_strategy="steps"` for monitoring
14. **Save adapters frequently** — they're tiny (~6MB) and easy to rollback

## References

### Core Training
- [docs/overview.md](docs/overview.md) — Features and capabilities overview
- [docs/datasets.md](docs/datasets.md) — Dataset formatting and preparation
- [docs/chat-templates.md](docs/chat-templates.md) — Chat template configuration
- [docs/lora-hyperparameters.md](docs/lora-hyperparameters.md) — LoRA parameter tuning guide
- [docs/kernels-packing.md](docs/kernels-packing.md) — Custom kernels and packing optimizations

### Reinforcement Learning
- [docs/tutorial-grpo.md](docs/tutorial-grpo.md) — Step-by-step GRPO tutorial
- [docs/advanced-rl.md](docs/advanced-rl.md) — Advanced RL parameters and batching
- [docs/memory-efficient-rl.md](docs/memory-efficient-rl.md) — Standby and memory optimizations
- [docs/fp8-rl.md](docs/fp8-rl.md) — FP8 precision RL training
- [docs/fp16-vs-bf16.md](docs/fp16-vs-bf16.md) — Precision comparison for RL stability
- [docs/reward-hacking.md](docs/reward-hacking.md) — Counter-measures for reward hacking

### Specialized Models
- [docs/vision-fine-tuning.md](docs/vision-fine-tuning.md) — Vision-language model training
- [docs/vision-rl.md](docs/vision-rl.md) — VLM RL with GRPO/GSPO
- [docs/tts-fine-tuning.md](docs/tts-fine-tuning.md) — Text-to-speech fine-tuning
- [docs/tool-calling.md](docs/tool-calling.md) — Tool/function calling training

### Deployment & Inference
- [docs/saving-to-gguf.md](docs/saving-to-gguf.md) — GGUF export and quantization
- [docs/saving-to-ollama.md](docs/saving-to-ollama.md) — Ollama integration
- [docs/vllm-guide.md](docs/vllm-guide.md) — vLLM deployment
- [docs/inference.md](docs/inference.md) — 2x faster native inference
- [docs/lora-hot-swapping.md](docs/lora-hot-swapping.md) — Runtime adapter switching

### Infrastructure
- [docs/requirements.md](docs/requirements.md) — System and VRAM requirements
- [docs/model-selection.md](docs/model-selection.md) — Choosing the right model
- [docs/models.md](docs/models.md) — Full model catalog (300+ models)
- [docs/multi-gpu-ddp.md](docs/multi-gpu-ddp.md) — Multi-GPU distributed training
- [docs/installation-pip.md](docs/installation-pip.md) — pip installation guide
- [docs/installation-docker.md](docs/installation-docker.md) — Docker setup


## Known Conflicts

- **Do not install alongside `flash-attention`** in the same environment. Unsloth bundles xformers which may conflict with flash-attn on attention kernels. Use separate environments.

## Resources

- **GitHub**: https://github.com/unslothai/unsloth
- **Documentation**: https://docs.unsloth.ai
- **Hugging Face**: https://huggingface.co/unsloth
- **Docker Hub**: https://hub.docker.com/r/unsloth/unsloth
- **Notebooks**: https://github.com/unslothai/notebooks
- **Discord**: https://discord.gg/unsloth
