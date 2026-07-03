# Prime Intellect Lab Skill

**Hosted RL post-training with environments, verifiers, GEPA prompt optimization, and agentic training**

## Skill Structure

```
prime-intellect-lab/
├── SKILL.md                              # Main skill documentation (READ THIS FIRST)
├── README.md                             # This file
└── templates/
    └── basic_rl_training.toml            # Production-ready training config template
```

## Quick Start

1. **Read SKILL.md** — Comprehensive guide with all concepts and workflows
2. **Set up workspace** — `prime lab setup` creates configs, environments, and agent skills
3. **Browse environments** — `prime env list` to find training environments
4. **Copy template** — `cp templates/basic_rl_training.toml configs/rl/my-run.toml`
5. **Launch training** — `prime rl run configs/rl/my-run.toml`

## What's Inside

### SKILL.md (Main Documentation)
- When to use Prime Intellect vs Tinker vs local training
- Core concepts: environments, hosted training, verifiers, GEPA, Lab agent skills
- Setup and authentication (`prime login` or `PRIME_API_KEY`)
- Complete training workflow (env install, baseline eval, config, train, monitor)
- Full configuration reference (`.toml` fields with `[[env]]` syntax)
- Available models table (Qwen3, INTELLECT-3 with exact IDs)
- GEPA prompt optimization (gradient-free system prompt refinement)
- Custom environment development with `verifiers` library
- Multi-environment training with weighted `[[env]]` blocks
- Compute API for direct GPU provisioning
- Troubleshooting guide (9 common issues)
- Agent usage instructions including brainstorm skill workflow

### Templates
- **basic_rl_training.toml**: Production-ready training config
  - Small / medium / large run presets
  - Correct `[[env]]` syntax with `id` and `args` fields
  - All key fields documented with comments

## When to Use

| Task | Use This? |
|------|-----------|
| Hosted RL training with environments | Yes |
| Agentic multi-turn RL | Yes |
| LoRA on open-weight models via RL | Yes |
| GEPA prompt optimization | Yes |
| SFT / supervised fine-tuning | No — use Tinker |
| Local GPU training | No — use Axolotl/Unsloth |
| Custom architectures | No — use Modal/Lambda |
| On-demand GPU clusters | No — use TensorPool |

## Version

**v1.0.0** — Initial release (February 2026)

## Maintained By

Synthetic Sciences
https://syntheticsciences.ai

---

**License:** MIT
