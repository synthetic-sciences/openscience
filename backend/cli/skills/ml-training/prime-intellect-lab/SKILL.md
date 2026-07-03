---
name: prime-intellect-lab
description: Expert guidance for hosted RL post-training with Prime Intellect Lab — environments, verifiers, GEPA prompt optimization, and agentic training
category: ml-training
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Post-Training, Reinforcement Learning, Prime Intellect, Lab, Hosted Training, Environments, Verifiers, LoRA, Agentic RL, GEPA]
dependencies: [prime, verifiers]
---

# Prime Intellect Lab — Hosted RL Post-Training

Expert-level guidance for running reinforcement learning post-training on Prime Intellect's hosted platform. Prime Intellect Lab handles GPU infrastructure, orchestration, and evaluation — you focus on environments, reward signals, and model selection.

**Note:** Hosted Training is currently in **Private Beta**. Apply for access at [primeintellect.ai](https://www.primeintellect.ai) if needed.

## When to Use This Skill

**Use Prime Intellect Lab when you need to:**
- Run hosted GRPO/RL training with managed GPU infrastructure
- Train with **environments** (dataset + harness + rubric) for verifiable rewards
- Do **agentic multi-turn training** (tool-use, code execution, web browsing)
- Apply LoRA on open-weight models (Qwen3, Llama, INTELLECT-3)
- Use pre-built environments from the Environments Hub (math, code, reasoning, agentic)
- Run **GEPA prompt optimization** — automatic system prompt refinement without gradient training
- Use **bundled agent skills** (brainstorm, create, browse, review, eval, train)

**Do NOT use Prime Intellect Lab for:**
- Supervised fine-tuning (SFT) — use **Tinker** instead
- Local GPU training — use Axolotl, Unsloth, or TRL directly
- Custom model architectures not in Prime Intellect's supported list
- Inference serving or deployment — use vLLM, SGLang, etc.

### Decision Matrix

| Task | Platform |
|------|----------|
| SFT / LoRA fine-tuning | Tinker (default) |
| Hosted RL with environments | **Prime Intellect Lab** |
| Agentic multi-turn RL | **Prime Intellect Lab** |
| GEPA prompt optimization | **Prime Intellect Lab** |
| Local RL with custom rewards | GRPO skill + TRL |
| On-demand GPU clusters | TensorPool |
| Custom compute (serverless) | Modal / Lambda |

---

## Core Concepts

### 1. Environments

An **environment** in Prime Intellect Lab combines:
- **Dataset**: The prompts/problems to train on
- **Harness**: Execution sandbox (code runner, tool-use framework, etc.)
- **Rubric**: Reward function that scores model outputs (0.0 to 1.0)

Environments are the fundamental unit of training. Each environment defines what the model practices and how it's evaluated. Environments are identified as `owner/name` (e.g., `primeintellect/alphabet-sort`).

### 2. Hosted Training Architecture

Prime Intellect's `prime rl run` orchestrates three components:
- **Trainer**: Runs the RL optimization (GRPO) with LoRA adapters
- **Inference**: Generates rollouts (model completions) at scale
- **Orchestrator**: Coordinates data flow between trainer and inference

You don't manage these directly — `prime rl run` handles everything.

### 3. Environments Hub

Pre-built environments available on the platform:
- **Math**: GSM8K, MATH, competition math
- **Code**: HumanEval, MBPP, SWE-bench subsets
- **Reasoning**: ARC, logic puzzles, alphabet-sort, reverse-text, wordle
- **Agentic**: Tool-use, wiki-search, multi-step tasks

Browse and install environments with `prime env list` and `prime env install`.

### 4. Verifiers Library

The `verifiers` Python library provides building blocks for custom environments:
- Rubric functions (exact match, code execution, LLM-as-judge)
- Harness wrappers (sandboxed code execution, tool-use)
- Dataset adapters (HuggingFace datasets, custom formats)
- Install with `pip install verifiers`

### 5. GEPA — Prompt Optimization

**GEPA** (Genetic-Pareto prompt optimization) is a gradient-free method for refining environment system prompts:
- Uses a teacher LLM to reflect on evaluation results
- Iteratively evolves the system prompt for better scores
- No training required — pure prompt-level optimization
- Run via `prime gepa run configs/gepa/base.toml`

### 6. Lab Agent Skills

When you run `prime lab setup`, bundled workflow skills are installed at `.prime/skills/`:

| Skill | Purpose |
|-------|---------|
| **brainstorm** | Ideation and planning for training experiments |
| **create** | Create new custom environments |
| **browse** | Browse existing environments and resources |
| **review** | Review environment code and configurations |
| **eval** | Run evaluations and benchmark models |
| **train** | Launch and manage training runs |
| **GEPA** | Automatic prompt optimization workflows |

These skills provide agent-friendly workflows that the `openscience` CLI can invoke.

---

## Setup

### Installation

```bash
# Install uv (if not already installed)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install the Prime CLI
uv tool install prime

# Authenticate
prime login

# Or manually set API key
prime config set-api-key

# Configure SSH key for pod access (optional)
prime config set-ssh-key-path

# Verify setup
prime config view
```

### Workspace Setup

```bash
# Create and enter a workspace directory
mkdir ~/dev/my-lab && cd ~/dev/my-lab

# Initialize the full Lab workspace
prime lab setup
```

This creates:
```
configs/
    endpoints.toml          # OpenAI-compatible API endpoint config
    rl/                     # Example RL training configs
        alphabet-sort.toml
        gsm8k.toml
        math-python.toml
        reverse-text.toml
        wiki-search.toml
        wordle.toml
    eval/                   # Example eval configs
        minimal.toml
        multi-env.toml
    gepa/                   # GEPA prompt optimization configs
        base.toml
        wordle.toml
environments/
    AGENTS.md               # Documentation for AI coding agents
.prime/
    skills/                 # Bundled workflow skills (brainstorm, create, etc.)
AGENTS.md                   # Top-level agent documentation
CLAUDE.md                   # Claude-specific pointer to AGENTS.md
```

### For self-hosted training with prime-rl:

```bash
prime lab setup --prime-rl
```

This additionally clones the `prime-rl` trainer and sets up dependencies.

### Verify Credentials

```bash
# Check if PRIME_API_KEY is set
[ -n "$PRIME_API_KEY" ] && echo "set" || echo "not set"
```

If connected via the Synthetic Sciences dashboard, `PRIME_API_KEY` is injected automatically.

---

## Training Workflow

### Step 1: Install an Environment

```bash
# List available environments
prime env list

# Install an environment into your workspace
prime env install primeintellect/alphabet-sort
```

### Step 2: Run Baseline Evaluation

Before training, establish a baseline:

```bash
prime eval run primeintellect/alphabet-sort \
  -m Qwen/Qwen3-4B-Instruct-2507 \
  -n 20 \
  -r 1
```

### Step 3: Configure Training

Example `configs/rl/alphabet-sort.toml`:

```toml
model = "Qwen/Qwen3-30B-A3B-Instruct-2507"
max_steps = 500
batch_size = 256
rollouts_per_example = 8

[sampling]
max_tokens = 512

[[env]]
id = "primeintellect/alphabet-sort"
args = { min_turns = 3, max_turns = 5, power_per_turn = false }

[wandb]
project = "alphabet-sort"
name = "qwen3-30b-i-alphabet-sort"
```

### Step 4: Launch Training

```bash
# Hosted Training (managed infrastructure)
prime rl run configs/rl/alphabet-sort.toml

# Or self-hosted with prime-rl (on your own GPUs)
uv run prime-rl configs/prime-rl/wiki-search.toml
```

### Step 5: Monitor Progress

```bash
# Check run status
prime rl status

# Stream logs
prime rl logs --follow

# View on W&B dashboard (if enabled)
```

### Step 6: Review Results

```bash
# List completed runs
prime rl list

# Download LoRA adapter
prime rl download <run-id> --output ./lora-adapter

# Run post-training evaluation
prime eval run primeintellect/alphabet-sort \
  -m Qwen/Qwen3-30B-A3B-Instruct-2507 \
  --adapter ./lora-adapter \
  -n 100
```

---

## Configuration Reference

Full `.toml` config fields:

```toml
# Top-level fields
model = "Qwen/Qwen3-4B-Instruct-2507"   # Model from supported list (required)
max_steps = 200                           # Total training steps
batch_size = 16                           # Prompts per batch
rollouts_per_example = 8                  # Completions per prompt (GRPO group size)

[sampling]
max_tokens = 2048                         # Max output tokens per rollout
temperature = 0.7                         # Sampling temperature for rollouts
top_p = 0.95                              # Nucleus sampling

# Environments — use [[env]] (double bracket) for array of environments
[[env]]
id = "primeintellect/alphabet-sort"       # Environment ID (required)
args = { min_turns = 3, max_turns = 5 }   # Environment-specific arguments

# For multi-environment training, add more [[env]] blocks:
# [[env]]
# id = "primeintellect/gsm8k"
# weight = 0.3

[wandb]
project = "my-project"                    # W&B project name
name = "run-name"                         # W&B run name
enabled = true                            # Enable W&B logging

[eval]
interval = 50                             # Eval every N steps
n_samples = 100                           # Samples per eval
```

**Important:** Use `[[env]]` (double brackets) for environment config — this is TOML array-of-tables syntax.

---

## Available Models

| Model | Type | Recommended Use |
|-------|------|-----------------|
| `Qwen/Qwen3-4B-Instruct-2507` | Instruct | Quick iteration, prototyping |
| `Qwen/Qwen3-4B-Thinking-2507` | Thinking | Reasoning-focused training |
| `Qwen/Qwen3-30B-Instruct-2507` | Instruct (MoE) | Strong general purpose |
| `Qwen/Qwen3-30B-Thinking-2507` | Thinking (MoE) | Reasoning at scale |
| `Qwen/Qwen3-235B-Instruct-2507` | Instruct (MoE) | Frontier-level, agentic tasks |
| `Qwen/Qwen3-235B-Thinking-2507` | Thinking (MoE) | Frontier reasoning |
| `PrimeIntellect/INTELLECT-3` | — | Prime Intellect's own model |

Check the latest supported models:
```bash
prime models list
```

---

## GEPA Prompt Optimization

GEPA (Genetic-Pareto prompt optimization) refines your environment's system prompt without gradient-based training:

```bash
# Run GEPA optimization
prime gepa run configs/gepa/base.toml
```

Example GEPA config:
```toml
environment = "primeintellect/wordle"
model = "Qwen/Qwen3-30B-Instruct-2507"
teacher_model = "Qwen/Qwen3-235B-Instruct-2507"
generations = 10
population_size = 8
n_eval_samples = 50
```

**How it works:**
1. Evaluates current system prompt against the environment
2. Teacher LLM reflects on failures and proposes improved prompts
3. Genetic algorithm evolves a population of prompt variants
4. Pareto-optimal prompts are selected across multiple objectives
5. Best prompt is saved after N generations

---

## Environment Development

### Building Custom Environments with `verifiers`

```bash
pip install verifiers
```

### Example: Custom Environment

```python
# environments/my_math_env.py
from verifiers import Environment, Rubric

class MyMathEnv(Environment):
    name = "my-org/math-problems"

    def get_dataset(self):
        from datasets import load_dataset
        ds = load_dataset("openai/gsm8k", "main", split="train")
        return [{"prompt": ex["question"], "reference": ex["answer"]} for ex in ds]

    def get_rubric(self):
        def score(output: str, reference: str) -> float:
            try:
                pred = float(output.strip().split("####")[-1].strip())
                gold = float(reference.strip().split("####")[-1].strip())
                return 1.0 if abs(pred - gold) < 1e-6 else 0.0
            except (ValueError, IndexError):
                return 0.0
        return Rubric(score_fn=score)
```

### Register and Use

```bash
# Install custom environment
prime env install ./environments/my_math_env.py

# Use in training config
# [[env]]
# id = "my-org/math-problems"
```

---

## Multi-Environment Training

Train on multiple environments by adding multiple `[[env]]` blocks:

```toml
model = "Qwen/Qwen3-30B-Instruct-2507"
max_steps = 500
batch_size = 256
rollouts_per_example = 8

[[env]]
id = "primeintellect/gsm8k"
weight = 0.5

[[env]]
id = "primeintellect/alphabet-sort"
weight = 0.3

[[env]]
id = "primeintellect/reverse-text"
weight = 0.2

[sampling]
max_tokens = 512
```

---

## Compute API (GPU Pods)

Prime Intellect also provides direct GPU provisioning via the Compute API:

```bash
# Check GPU availability
prime compute availability

# Provision a GPU pod
prime compute provision --gpu H100 --count 8

# List running pods
prime compute list

# SSH into a pod
prime compute ssh <pod-id>

# Delete a pod
prime compute delete <pod-id>
```

API endpoints (Bearer token auth via `PRIME_API_KEY`):
- `GET /api/v1/availability/gpus` — Check availability
- `POST /api/v1/provision-gpu` — Provision instances
- `GET /api/v1/managing-pods` — List pods
- `DELETE /api/v1/managing-pods/{pod_id}` — Delete pod
- `POST /api/v1/sandbox/create-sandbox-endpoint` — Create sandbox

---

## Troubleshooting

### Common Issues

**1. `ModuleNotFoundError: No module named 'prime'`**
```bash
# Install via uv (recommended)
uv tool install prime
# Or in current environment
pip install prime
```

**2. Authentication failed**
```bash
# Re-authenticate
prime login
# Or manually set key
prime config set-api-key
```

**3. Reward stuck at 0.0**
- Test rubric independently: `prime eval run <env> -m <model> -n 10`
- Verify the model can produce valid outputs for the task
- Try increasing `sampling.temperature`
- Check environment `args` are correct

**4. Reward stuck at 1.0**
- Task is too easy — use a harder environment or add more constraints
- Check rubric isn't always returning 1.0

**5. `pydantic` version errors**
```bash
# Prime uses pydantic v2 — create a clean environment
python3.12 -m venv ~/prime-env && source ~/prime-env/bin/activate
pip install prime verifiers
```

**6. Model not available**
```bash
# Check supported models
prime models list
```

**7. Training OOM (Out of Memory)**
- Reduce `batch_size` or `rollouts_per_example`
- Reduce `sampling.max_tokens`
- Use a smaller model for initial experiments

**8. Run stuck in "pending" state**
```bash
prime rl status --verbose
prime rl cancel <run-id>
```

**9. Environment args not taking effect**
- Ensure you use `[[env]]` (double brackets), not `[env]`
- Args must match the environment's expected parameters

---

## Agent Usage Instructions

When the `openscience` agent loads this skill for a user task:

1. **Check credentials**: Verify `PRIME_API_KEY` is set
2. **Set up workspace**: `prime lab setup` if not already initialized
3. **Select environment**: Use `prime env list` to find matching environments, install with `prime env install`
4. **Always run baseline eval**: Before training, establish performance with `prime eval run`
5. **Start small**: Use `Qwen/Qwen3-4B-Instruct-2507` with `max_steps=50` first
6. **Estimate cost**: Check `prime rl estimate --config <config.toml>` before launching
7. **Wait for approval**: Present cost estimate and get explicit user approval
8. **Monitor training**: Use `prime rl logs --follow` to track progress
9. **Report usage**: After completion, report via `OpenScience.reportUsage()` with `service="primeintellect"`

### Example Agent Workflow

```
User: "Train a model to solve math problems using RL"

Agent steps:
1. Load skills: prime-intellect-lab, grpo-rl-training
2. Check PRIME_API_KEY is set
3. Set up workspace: mkdir ~/dev/math-rl && cd ~/dev/math-rl && prime lab setup
4. Install env: prime env install primeintellect/gsm8k
5. Baseline eval: prime eval run primeintellect/gsm8k -m Qwen/Qwen3-4B-Instruct-2507 -n 20 -r 1
6. Create config TOML with [[env]] for gsm8k
7. Estimate cost: prime rl estimate --config configs/rl/gsm8k.toml
8. Present estimate to user, wait for approval
9. Launch: prime rl run configs/rl/gsm8k.toml
10. Monitor: prime rl logs --follow
11. Download adapter and run final eval
12. Report usage to OpenScience
```

### Using the Brainstorm Skill

For exploratory tasks, use the brainstorm agent skill:
```
User: "Help me figure out the best approach for RL training on code tasks"

Agent steps:
1. Load prime-intellect-lab skill
2. Set up workspace with prime lab setup
3. The brainstorm skill in .prime/skills/ provides structured ideation
4. Browse available code environments: prime env list
5. Propose experiment plan with environment selection, model choice, config
6. Run small-scale experiments to validate approach
```

---

## Quick Reference

| Command | Description |
|---------|-------------|
| `prime login` | Authenticate with Prime Intellect |
| `prime config view` | Show current configuration |
| `prime config set-api-key` | Manually set API key |
| `prime models list` | List supported models |
| `prime env list` | List available environments |
| `prime env install <id>` | Install environment to workspace |
| `prime eval run <env> -m <model>` | Run evaluation |
| `prime rl run <config.toml>` | Launch hosted RL training |
| `prime rl status` | Check run status |
| `prime rl logs --follow` | Stream training logs |
| `prime rl list` | List completed runs |
| `prime rl download <id>` | Download LoRA adapter |
| `prime rl cancel <id>` | Cancel a run |
| `prime gepa run <config.toml>` | Run GEPA prompt optimization |
| `prime lab setup` | Initialize Lab workspace |
| `prime lab setup --prime-rl` | Set up self-hosted prime-rl |
| `prime compute availability` | Check GPU availability |
| `prime compute provision` | Provision GPU pods |
