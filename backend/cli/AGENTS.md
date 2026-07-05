# OpenScience - ML Workflow Defaults

This file provides default instructions for the OpenScience when working in ML/AI research projects.

## Skill Loading Guide

Load skills proactively based on the task at hand:

### Training & Post-Training

- **RLHF/GRPO/DPO** → `grpo-rl-training`, `trl-fine-tuning`, `openrlhf`, `simpo`
- **Fine-tuning** → `axolotl`, `unsloth`, `llama-factory`, `torchtune`
- **Distributed** → `deepspeed-training`, `fsdp`, `megatron-core`, `accelerate`

### Inference & Serving

- **High-throughput** → `vllm-inference`, `sglang`, `tensorrt-llm`
- **Local/Edge** → `llama-cpp`, `gguf-quantization`
- **Optimization** → `flash-attention`, `gptq`, `awq`, `bitsandbytes`

### Evaluation & Analysis

- **Benchmarking** → `lm-eval-harness`, `bigcode-eval`, `nemo-evaluator`
- **Interpretability** → `transformer-lens`, `saelens`, `nnsight`, `pyvene`

### RAG & Retrieval

- **Vector stores** → `chroma`, `faiss`, `pinecone`, `qdrant`
- **Embeddings** → `sentence-transformers`
- **Orchestration** → `langchain`, `llamaindex`

### Agents & Structured Output

- **Agent frameworks** → `langchain`, `llamaindex`, `crewai`
- **Structured output** → `dspy`, `instructor`, `guidance`, `outlines`

### Multimodal

- **Vision** → `clip`, `llava`, `segment-anything`, `stable-diffusion`
- **Audio** → `whisper`, `audiocraft`
- **Document** → `blip-2`

### Data & Infrastructure

- **Data processing** → `ray-data`, `nemo-curator`
- **Cloud compute** → `modal`, `skypilot`, `lambda-labs`
- **Experiment tracking** → `weights-and-biases`, `mlflow`, `tensorboard`

### Emerging Techniques

- **Scaling** → `moe-training`, `speculative-decoding`, `long-context`
- **Compression** → `knowledge-distillation`, `model-pruning`, `model-merging`

## ML Workflow Standards

### Before Training

- [ ] Check GPU availability: `nvidia-smi` or `torch.cuda.is_available()`
- [ ] Verify CUDA version compatibility with frameworks
- [ ] Estimate memory requirements for model + optimizer + gradients
- [ ] Set up experiment tracking (W&B or MLflow)
- [ ] Validate dataset format and tokenization

### Training Best Practices

- Use bf16 on Ampere+ GPUs (A100, H100, RTX 30xx+), fp16 otherwise
- Enable gradient checkpointing for memory-constrained setups
- Save checkpoints every N steps (N = training_time_hours \* 2)
- Log learning rate, loss, and gradient norms
- Set random seeds for reproducibility: `torch.manual_seed(42)`

### Memory Optimization Priority

1. Gradient checkpointing (free, ~30% memory reduction)
2. Mixed precision training (free, ~50% memory reduction)
3. Gradient accumulation (free, enables larger effective batch)
4. DeepSpeed ZeRO Stage 2 (minimal overhead)
5. Model sharding / FSDP (for multi-GPU)

### OOM Error Handling

When encountering CUDA OOM:

1. Reduce batch size by 50%
2. Enable gradient checkpointing
3. Switch to 8-bit optimizer (bitsandbytes)
4. Try DeepSpeed ZeRO offloading
5. Consider model parallelism for very large models

## Code Style Guidelines

### Preferred Patterns

- Use HuggingFace Transformers for model loading
- Use `accelerate` for device management
- Use `datasets` library for data loading
- Use `peft` for parameter-efficient fine-tuning

### Example Setup

```python
import torch
from accelerate import Accelerator
from transformers import AutoModelForCausalLM, AutoTokenizer

accelerator = Accelerator(mixed_precision="bf16")
model = AutoModelForCausalLM.from_pretrained(
    "model-name",
    torch_dtype=torch.bfloat16,
    device_map="auto",
)
```

## Environment Variables

Key environment variables for ML workflows:

- `CUDA_VISIBLE_DEVICES` - GPU selection
- `WANDB_PROJECT` - W&B project name
- `HF_TOKEN` - HuggingFace API token
- `TRANSFORMERS_CACHE` - Model cache directory
