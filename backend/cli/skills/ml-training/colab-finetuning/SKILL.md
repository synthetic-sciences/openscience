---
name: colab-finetuning
description: Fine-tune LLMs on Google Colab GPUs directly from openscience. Connects to Colab runtimes via WebSocket bridge for remote training with Unsloth. Supports SFT, GRPO, DPO, vision, and TTS workflows on free T4 to Pro A100 GPUs.
category: ml-training
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Fine-Tuning, Google Colab, GPU, Remote Training, Unsloth, LoRA, GRPO, Cloud GPU]
dependencies: [unsloth, torch, transformers, trl, datasets]
---

# Google Colab Fine-Tuning

Fine-tune LLMs using Google Colab GPUs directly from the openscience CLI. Connect to free or paid Colab runtimes and run Unsloth training workflows remotely.

## When to Use Colab Fine-Tuning

**Use Colab when:**
- You don't have a local GPU but need to fine-tune a model
- You want free GPU access (T4 with 15GB VRAM on Colab Free)
- Training models up to ~14B parameters (4-bit QLoRA)
- Quick experiments and prototyping before scaling to cloud
- Colab Pro/Pro+ for A100 (40-80GB) access

**Don't use Colab when:**
- You need persistent long-running jobs (>12h) — use Tinker or cloud providers
- Training 70B+ models — use Lambda, RunPod, or multi-GPU cloud
- You need guaranteed uptime — Colab may disconnect idle sessions
- Production training pipelines — use managed services

**Colab vs Alternatives:**

| Need | Use |
|------|-----|
| Free GPU, quick experiments | **Google Colab** |
| Managed cloud training (any size) | Tinker |
| Persistent multi-GPU training | Lambda / RunPod |
| Local GPU available | Unsloth directly |
| Enterprise with SLA | Colab Enterprise (Vertex AI) |

## Quick Start

### Step 1: Generate Bridge Notebook

```
Use colab_notebook tool with workflow="bridge"
```

This creates a `openscience-bridge.ipynb` file that establishes a WebSocket tunnel between openscience and the Colab GPU.

### Step 2: Open in Colab

1. Go to [colab.research.google.com](https://colab.research.google.com)
2. Upload the bridge notebook (File → Upload notebook)
3. Select GPU runtime (Runtime → Change runtime type → T4 GPU)
4. Run all cells
5. Copy the WebSocket URL that appears

### Step 3: Connect from openscience

```
Use colab_connect tool with connection_url="wss://..."
```

### Step 4: Run Training

```
Use colab_finetune tool with:
  workflow: "sft"
  model: "unsloth/Qwen3-4B-unsloth-bnb-4bit"
  dataset: "mlabonne/FineTome-100k"
```

Or execute individual cells:
```
Use colab_execute tool with code="import torch; print(torch.cuda.get_device_name(0))"
```

## GPU Tiers

| Tier | GPU | VRAM | Max Model (QLoRA) | Session Limit |
|------|-----|------|-------------------|---------------|
| Free | T4 | 15 GB | ~14B | 12h, may disconnect |
| Pro ($10/mo) | T4/V100/A100 | 16-40 GB | ~32B | 24h, priority |
| Pro+ ($50/mo) | A100 (80GB) | 80 GB | ~72B | 24h, guaranteed |
| Enterprise | Configurable | Any | Any | No limit |

See [references/gpu-tiers.md](references/gpu-tiers.md) for detailed VRAM requirements.

## Available Tools

| Tool | Purpose |
|------|---------|
| `colab_connect` | Connect to a Colab runtime (standard bridge or enterprise) |
| `colab_execute` | Run arbitrary Python code on the connected GPU |
| `colab_status` | Check GPU, memory, disk, connection status |
| `colab_finetune` | Run complete Unsloth training workflow (SFT/GRPO/DPO/vision/TTS) |
| `colab_notebook` | Generate .ipynb notebooks for Colab |

## Training Workflows

### SFT (Supervised Fine-Tuning)
Standard instruction tuning. Best for: chat models, domain adaptation, format learning.

```
colab_finetune workflow=sft model="unsloth/Qwen3-4B-unsloth-bnb-4bit" dataset="mlabonne/FineTome-100k"
```

### GRPO (Reinforcement Learning)
Train reasoning models with reward functions. Best for: math, coding, structured output.

```
colab_finetune workflow=grpo model="unsloth/Qwen3-4B-unsloth-bnb-4bit" dataset="your-dataset"
```

### DPO (Direct Preference Optimization)
Align models with human preferences. Requires chosen/rejected pairs.

```
colab_finetune workflow=dpo model="unsloth/Llama-3.1-8B-unsloth-bnb-4bit" dataset="HuggingFaceH4/ultrafeedback_binarized"
```

### Vision Fine-Tuning
Fine-tune vision-language models (Qwen3-VL, Gemma 3, Llama 3.2 Vision).

```
colab_finetune workflow=vision model="unsloth/Qwen3-VL-2B-unsloth-bnb-4bit" dataset="your-vision-dataset"
```

### TTS Fine-Tuning
Fine-tune text-to-speech models (Orpheus, Sesame-CSM).

```
colab_finetune workflow=tts model="unsloth/orpheus-3b-0.1-ft-unsloth-bnb-4bit" dataset="your-tts-dataset"
```

## Troubleshooting

### Connection Issues
- **"WebSocket connection failed"**: Ensure the bridge notebook is still running in Colab. Re-run the tunnel cell if the URL expired.
- **"Execution timeout"**: Colab may have disconnected due to inactivity. Run the keep-alive cell.
- **"Connection closed during execution"**: Colab Free disconnects after idle time. Upgrade to Pro for more stability.

### Training Issues
- **CUDA OOM**: Reduce batch_size, max_seq_length, or lora_rank. Use 4-bit quantization.
- **Slow training**: Ensure GPU runtime is selected. Check with `colab_status detail=gpu`.
- **Package not found**: Unsloth is installed automatically by `colab_finetune`. For custom packages, use `colab_execute` with pip install.

### Colab Enterprise
- Requires GCP project with Vertex AI API enabled
- Use `colab_connect mode=enterprise project_id="your-project"`
- GPU quotas apply — check GCP console for availability

See [references/troubleshooting.md](references/troubleshooting.md) for more solutions.
