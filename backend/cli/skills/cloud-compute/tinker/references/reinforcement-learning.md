# Reinforcement Learning

## Quick Start

```bash
python -m tinker_cookbook.recipes.rl_basic
```

Fine-tunes Llama-3.1-8B on GSM8K with reward:
```
1[answer correct] + 0.1 * (1[format correct] - 1)
```

Training takes ~1 min/iteration, reaches ~63% accuracy after 15 iterations.

## Basic RL Config

```python
import chz
import asyncio
from tinker_cookbook.rl import train
from tinker_cookbook import model_info
from tinker_cookbook.recipes.math_rl.math_env import Gsm8kDatasetBuilder

def build_config_blueprint() -> chz.Blueprint[train.Config]:
    model_name = "meta-llama/Llama-3.1-8B"
    renderer_name = model_info.get_recommended_renderer_name(model_name)

    builder = Gsm8kDatasetBuilder(
        batch_size=128,
        group_size=16,
        renderer_name=renderer_name,
        model_name_for_tokenizer=model_name,
    )

    return chz.Blueprint(train.Config).apply({
        "model_name": model_name,
        "log_path": "/tmp/rl_basic",
        "dataset_builder": builder,
        "learning_rate": 4e-5,
        "max_tokens": 256,
    })

if __name__ == "__main__":
    blueprint = build_config_blueprint()
    blueprint.make_from_argv(sys.argv[1:])
    asyncio.run(train.main(blueprint.make()))
```

## Key Metrics

- `ac_tokens_per_turn` - Tokens per completion
- `env/all/correct` - Accuracy
- `env/all/format` - Format compliance
- `env/all/reward/total` - Mean total reward
- `entropy` - Per-token entropy
- `kl_sample_train_v1/v2` - KL divergence (sampler vs learner)

## RL Environment Classes

Custom RL environments use three classes from `tinker_cookbook.rl.types`:

### Env

Stateful environment for a single agent episode. Discard after one episode.

```python
from tinker_cookbook.rl.types import Env, Observation, StopCondition, Action, StepResult

class MyEnv(Env):
    async def initial_observation(self) -> tuple[Observation, StopCondition]:
        # Return initial tokens and stop condition
        raise NotImplementedError

    async def step(self, action: Action) -> StepResult:
        # Process agent action, return next observation + reward
        raise NotImplementedError
```

Note: `Env` operates on tokens (not strings/messages) because the training code needs exact tokens and logprobs.

### EnvGroupBuilder

Creates groups of environments (enables multi-agent training or paired comparisons):

```python
from tinker_cookbook.rl.types import EnvGroupBuilder

class MyEnvGroupBuilder(EnvGroupBuilder):
    async def make_envs(self) -> list[Env]:
        return [MyEnv() for _ in range(group_size)]
```

### RLDataset

Dataset of `EnvGroupBuilder` objects:

```python
from tinker_cookbook.rl.types import RLDataset

class MyDataset(RLDataset):
    def get_batch(self, index: int) -> list[EnvGroupBuilder]:
        return [MyEnvGroupBuilder(problem) for problem in self.problems[index]]
```

### Multi-Step Environment Example

See `tinker_cookbook.recipes.twenty_questions` for a complete multi-step environment where a question-asking agent learns to guess hidden words:

```bash
python -m tinker_cookbook.recipes.twenty_questions.train
```

## Completers (Policy Abstractions)

Completers represent models/policies that can be sampled from.

### TokenCompleter (for RL training)

```python
from tinker_cookbook.rl.types import TokenCompleter, TokensWithLogprobs

class TokenCompleter:
    async def __call__(
        self, model_input: types.ModelInput, stop: StopCondition
    ) -> TokensWithLogprobs:
        ...
```

Used by RL algorithms because they work directly with tokens.

### MessageCompleter (for inference/judging)

```python
from tinker_cookbook.rl.types import MessageCompleter

class MessageCompleter:
    async def __call__(self, messages: list[renderers.Message]) -> renderers.Message:
        ...
```

Operates at message level — useful for judge models, multi-agent environments, and evaluation. Requires a renderer to convert messages to tokens for the sampling client.

Concrete implementations: `TinkerTokenCompleter` and `TinkerMessageCompleter` (wrappers around `tinker.SamplingClient`).

## Custom RL Loop

```python
import tinker
from tinker import types
from tinker.types.tensor_data import TensorData
import torch
from tinker_cookbook import model_info, renderers
from tinker_cookbook.tokenizer_utils import get_tokenizer

@chz.chz
class Config:
    model_name: str = "meta-llama/Llama-3.1-8B"
    batch_size: int = 128
    group_size: int = 16
    learning_rate: float = 4e-5
    max_tokens: int = 256

def main(config: Config):
    service_client = tinker.ServiceClient()
    training_client = service_client.create_lora_training_client(
        base_model=config.model_name, rank=32
    )
    tokenizer = training_client.get_tokenizer()
    renderer = renderers.get_renderer(
        model_info.get_recommended_renderer_name(config.model_name),
        tokenizer
    )

    sampling_params = types.SamplingParams(
        max_tokens=config.max_tokens,
        stop=renderer.get_stop_sequences(),
    )
    adam_params = types.AdamParams(learning_rate=config.learning_rate)

    for batch_idx, batch_rows in enumerate(dataset):
        # Save weights for sampling
        sampling_path = training_client.save_weights_for_sampler(name=f"{batch_idx:06d}").result().path
        sampling_client = service_client.create_sampling_client(model_path=sampling_path)

        datums = []
        for question, answer in batch_rows:
            convo = [{"role": "user", "content": question}]
            model_input = renderer.build_generation_prompt(convo)
            prompt_tokens = model_input.to_ints()

            # Sample group_size responses
            result = sampling_client.sample(
                prompt=model_input,
                num_samples=config.group_size,
                sampling_params=sampling_params,
            ).result()

            rewards = []
            for seq in result.sequences:
                parsed, _ = renderer.parse_response(seq.tokens)
                reward = compute_reward(parsed["content"], answer)
                rewards.append(reward)

            # GRPO-style advantage centering
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

        # Training step
        fwd_bwd = training_client.forward_backward(datums, loss_fn="importance_sampling")
        optim = training_client.optim_step(adam_params)
        fwd_bwd.result()
        optim.result()
```

## Hyperparameters

### Learning Rate

Same guidance as SL — use `get_lr(model_name)` as starting point. The rl_basic recipe uses `4e-5` for Llama-3.1-8B.

### Batch and Group Sizes

- `batch_size`: Number of unique problems per iteration
- `group_size`: Rollouts per problem (for variance reduction)

Scale LR proportionally: `LR ∝ √batch_size`

If you have limited problems, increase `group_size` to generate more training data.

### Multiple Updates (num_substeps)

```python
# Default: 1 update per batch
num_substeps = 1

# Multiple updates: split batch into mini-batches
num_substeps = 4  # Batch must be divisible by num_substeps
```

Use with PPO objective. Start with 2-4. Higher values risk out-of-distribution updates.

### Streaming Minibatch Training

Overlaps sampling and training for throughput (on-policy, pipeline efficiency only):

```python
StreamMinibatchConfig(
    groups_per_batch=128,
    num_minibatches=8,
)
```

### Async Off-Policy Training

For long rollouts (CoT, tool use, agentic workflows):

```python
AsyncConfig(
    max_steps_off_policy=3,  # Max age of trajectories before discard
    groups_per_batch=64,
)
```

Start with `max_steps_off_policy < 5`. Monitor KL divergence carefully.

## Sequence Extension Property

Critical for multi-turn RL efficiency. When consecutive timesteps satisfy the extension property (each observation is a prefix extension of the previous), compute scales O(T) instead of O(T²).

### When Extension Holds

With `Qwen3Renderer(strip_thinking_from_history=False)`, thinking blocks are preserved:

```
Timestep 1: [User: Q1] [A: <think>...</think> A1] [User:]
Timestep 2: [User: Q1] [A: <think>...</think> A1] [User: Q2] [A: <think>...</think> A2] [User:]
```

Timestep 2 contains timestep 1 as a prefix → single Datum, KV-cache reuse.

### When Extension Breaks

With default `strip_thinking_from_history=True`, `<think>` blocks are stripped from history:

```
Timestep 1: [User: Q1] [A: <think>...</think> A1] [User:]
Timestep 2: [User: Q1] [A: A1] [User: Q2] [A: <think>...</think> A2] [User:]
```

Prefix doesn't match → separate Datums per timestep, O(T²) compute.

### Check Programmatically

```python
renderer.has_extension_property  # True or False
```

For `Qwen3Renderer`:
- `strip_thinking_from_history=False` → `has_extension_property=True`
- `strip_thinking_from_history=True` (default) → `has_extension_property=False`

### Periodic Compaction (Hybrid)

Keep thinking visible most of the time, periodically strip old thinking blocks:

- Turns 1-N: keep thinking visible (extension holds, single datum)
- Turn N+1: strip thinking from turns 1-N (extension breaks once)
- Turns N+1 to 2N: keep thinking visible again
- Repeat every N turns

This amortizes recomputation cost over N turns with bounded context growth.

## Monitoring

### KL Divergence

Monitor `kl_sample_train_v1/v2`:
- Should stay below 0.01 for stable training
- Even on-policy training shows non-zero KL (implementation detail)
- KL crossing threshold indicates numerical instability

### Reward Curves

```python
import pandas
df = pandas.read_json("/tmp/rl-loop/metrics.jsonl", lines=True)
plt.plot(df["reward/total"])
```

## Loss Functions for RL

| Loss | Description |
|------|-------------|
| `importance_sampling` | Policy gradient with importance weighting |
| `ppo` | Proximal Policy Optimization with clipping |
| `cispo` | Clipped Importance Sampling PO |
| `dro` | Direct Reward Optimization |

See [Loss Functions](loss-functions.md) for details.
