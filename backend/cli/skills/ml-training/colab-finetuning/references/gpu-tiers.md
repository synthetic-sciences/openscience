# GPU Tiers & VRAM Requirements

## Colab GPU Options

### Free Tier
- **T4**: 15 GB VRAM, Compute Capability 7.5
- **P100**: 16 GB VRAM, Compute Capability 6.0 (less common)
- Session limit: ~12 hours, may disconnect during idle

### Pro Tier ($10/month)
- **T4**: 15 GB VRAM (priority access)
- **V100**: 16 GB VRAM, Compute Capability 7.0
- **L4**: 24 GB VRAM, Compute Capability 8.9
- **A100**: 40 GB VRAM, Compute Capability 8.0
- Session limit: ~24 hours, priority GPU allocation

### Pro+ Tier ($50/month)
- **A100 (80GB)**: 80 GB VRAM
- Session limit: ~24 hours, guaranteed GPU access
- Background execution available

### Enterprise (Vertex AI)
- Any GPU type configured in GCP
- No session limits
- Full API control
- Requires GCP project and billing

## Model VRAM Requirements (4-bit QLoRA)

| Model Size | VRAM Required | Fits on |
|-----------|---------------|---------|
| 1B | ~3 GB | T4 (free) |
| 3B | ~5 GB | T4 (free) |
| 4B | ~6 GB | T4 (free) |
| 7-8B | ~9 GB | T4 (free) |
| 13-14B | ~15 GB | T4 (free, tight) |
| 32B | ~22 GB | L4, A100 (Pro) |
| 70-72B | ~44 GB | A100 80GB (Pro+) |

## Recommended Configurations

### Free Tier (T4, 15 GB)
- **SFT**: Qwen3-4B, Llama-3.2-3B, Gemma-3-4B — batch_size=2, max_seq=2048
- **GRPO**: Qwen3-4B — batch_size=1, max_seq=1024, num_generations=4
- **Vision**: Qwen3-VL-2B — batch_size=1

### Pro Tier (A100, 40 GB)
- **SFT**: Qwen3-14B, Llama-3.1-8B — batch_size=4, max_seq=4096
- **GRPO**: 8B models — batch_size=2, num_generations=8
- **DPO**: 8B models — batch_size=4

### Pro+ Tier (A100 80GB)
- **SFT**: Qwen3-32B, Llama-3.3-70B (tight) — batch_size=1-2
- **GRPO**: 32B models — batch_size=1
