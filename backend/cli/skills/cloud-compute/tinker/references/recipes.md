# Example Recipes

## sl_basic.py - Basic Supervised Learning

```python
import chz
import sys
import asyncio
from tinker_cookbook import cli_utils, model_info
from tinker_cookbook.recipes.chat_sl import chat_datasets
from tinker_cookbook.renderers import TrainOnWhat
from tinker_cookbook.supervised import train
from tinker_cookbook.supervised.data import FromConversationFileBuilder
from tinker_cookbook.supervised.types import ChatDatasetBuilderCommonConfig
from tinker_cookbook.hyperparam_utils import get_lr

def build_config_blueprint() -> chz.Blueprint[train.Config]:
    model_name = "meta-llama/Llama-3.1-8B"
    renderer_name = model_info.get_recommended_renderer_name(model_name)
    common_config = ChatDatasetBuilderCommonConfig(
        model_name_for_tokenizer=model_name,
        renderer_name=renderer_name,
        max_length=32768,
        batch_size=128,
        train_on_what=TrainOnWhat.ALL_ASSISTANT_MESSAGES,
    )
    dataset = chat_datasets.NoRobotsBuilder(common_config=common_config)

    # For custom dataset:
    # dataset = FromConversationFileBuilder(
    #     common_config=common_config,
    #     file_path="/path/to/dataset.jsonl"
    # )

    return chz.Blueprint(train.Config).apply({
        "log_path": "/tmp/tinker-examples/sl_basic",
        "model_name": model_name,
        "dataset_builder": dataset,
        "learning_rate": get_lr(model_name),
        "lr_schedule": "linear",
        "num_epochs": 1,
        "eval_every": 8,
    })

def main(config: train.Config):
    cli_utils.check_log_dir(config.log_path, behavior_if_exists="ask")
    asyncio.run(train.main(config))

if __name__ == "__main__":
    blueprint = build_config_blueprint()
    blueprint.make_from_argv(sys.argv[1:])
    main(blueprint.make())
```

## sl_loop.py - Manual Training Loop

```python
import chz
import datasets
import tinker
from tinker_cookbook import checkpoint_utils, model_info, renderers
from tinker_cookbook.supervised.common import compute_mean_nll
from tinker_cookbook.supervised.data import conversation_to_datum
from tinker_cookbook.tokenizer_utils import get_tokenizer
from tinker_cookbook.hyperparam_utils import get_lr

@chz.chz
class Config:
    log_path: str = "/tmp/tinker-examples/sl-loop"
    model_name: str = "meta-llama/Llama-3.1-8B"
    batch_size: int = 128
    learning_rate: float = get_lr("meta-llama/Llama-3.1-8B")  # ~2.8e-4
    max_length: int = 32768
    train_on_what: renderers.TrainOnWhat = renderers.TrainOnWhat.ALL_ASSISTANT_MESSAGES
    lora_rank: int = 32

def main(config: Config):
    tokenizer = get_tokenizer(config.model_name)
    renderer_name = model_info.get_recommended_renderer_name(config.model_name)
    renderer = renderers.get_renderer(renderer_name, tokenizer)

    dataset = datasets.load_dataset("HuggingFaceH4/no_robots")
    train_dataset = dataset["train"].shuffle(seed=0)
    n_batches = len(train_dataset) // config.batch_size

    service_client = tinker.ServiceClient()
    training_client = service_client.create_lora_training_client(
        base_model=config.model_name, rank=config.lora_rank
    )

    for batch_idx in range(n_batches):
        # Linear LR decay
        lr_mult = max(0.0, 1.0 - batch_idx / n_batches)
        adam_params = tinker.AdamParams(
            learning_rate=config.learning_rate * lr_mult
        )

        # Get batch
        start = batch_idx * config.batch_size
        end = (batch_idx + 1) * config.batch_size
        batch_rows = train_dataset.select(range(start, end))

        batch = [
            conversation_to_datum(row["messages"], renderer, config.max_length, config.train_on_what)
            for row in batch_rows
        ]

        # Training step
        fwd_bwd = training_client.forward_backward(batch, loss_fn="cross_entropy")
        optim = training_client.optim_step(adam_params)
        fwd_bwd_result = fwd_bwd.result()
        optim.result()

        # Compute metrics
        train_nll = compute_mean_nll(
            [x["logprobs"] for x in fwd_bwd_result.loss_fn_outputs],
            [d.loss_fn_inputs["weights"] for d in batch]
        )
        print(f"Step {batch_idx}, NLL: {train_nll:.4f}")

if __name__ == "__main__":
    chz.nested_entrypoint(main)
```

## rl_basic.py - Basic RL

```python
import asyncio
import chz
import sys
from tinker_cookbook import cli_utils, model_info
from tinker_cookbook.recipes.math_rl.math_env import Gsm8kDatasetBuilder
from tinker_cookbook.rl import train

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
        "log_path": "/tmp/tinker-examples/rl_basic",
        "dataset_builder": builder,
        "learning_rate": 4e-5,
        "max_tokens": 256,
        "eval_every": 0,
    })

def main(config: train.Config):
    cli_utils.check_log_dir(config.log_path, behavior_if_exists="ask")
    asyncio.run(train.main(config))

if __name__ == "__main__":
    blueprint = build_config_blueprint()
    blueprint.make_from_argv(sys.argv[1:])
    main(blueprint.make())
```

## rl_loop.py - Manual RL Loop

```python
import chz
import datasets
import tinker
from tinker import types
from tinker.types.tensor_data import TensorData
import torch
from tinker_cookbook import model_info, renderers
from tinker_cookbook.recipes.math_rl.math_grading import extract_boxed, grade_answer
from tinker_cookbook.tokenizer_utils import get_tokenizer

@chz.chz
class Config:
    model_name: str = "meta-llama/Llama-3.1-8B"
    batch_size: int = 128
    group_size: int = 16
    learning_rate: float = 4e-5
    max_tokens: int = 256

def get_reward(response: str, answer: str) -> float:
    try:
        given = extract_boxed(response)
        return 1.0 if grade_answer(given, answer) else 0.0
    except ValueError:
        return 0.0

def main(config: Config):
    tokenizer = get_tokenizer(config.model_name)
    renderer = renderers.get_renderer(
        model_info.get_recommended_renderer_name(config.model_name),
        tokenizer
    )

    dataset = datasets.load_dataset("openai/gsm8k", "main")["train"]

    service_client = tinker.ServiceClient()
    training_client = service_client.create_lora_training_client(
        base_model=config.model_name, rank=32
    )

    sampling_params = types.SamplingParams(
        max_tokens=config.max_tokens,
        stop=renderer.get_stop_sequences(),
    )
    adam_params = types.AdamParams(learning_rate=config.learning_rate)

    for batch_idx in range(len(dataset) // config.batch_size):
        # Save weights for sampling
        path = training_client.save_weights_for_sampler(name=f"{batch_idx:06d}").result().path
        sampling_client = service_client.create_sampling_client(model_path=path)

        batch_start = batch_idx * config.batch_size
        batch_rows = dataset.select(range(batch_start, batch_start + config.batch_size))

        datums = []
        for question, answer in zip(batch_rows["question"], batch_rows["answer"]):
            convo = [{"role": "user", "content": question}]
            prompt = renderer.build_generation_prompt(convo)
            prompt_tokens = prompt.to_ints()

            result = sampling_client.sample(
                prompt=prompt,
                num_samples=config.group_size,
                sampling_params=sampling_params,
            ).result()

            rewards = [get_reward(renderers.get_text_content(renderer.parse_response(s.tokens)[0]), answer)
                      for s in result.sequences]
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

        fwd_bwd = training_client.forward_backward(datums, loss_fn="importance_sampling")
        optim = training_client.optim_step(adam_params)
        fwd_bwd.result()
        optim.result()

if __name__ == "__main__":
    chz.nested_entrypoint(main)
```

## DPO / Preference Learning

```bash
python -m tinker_cookbook.recipes.preference.train \
    log_path=/tmp/dpo-experiment \
    model_name=meta-llama/Llama-3.2-1B \
    dataset=hhh \
    renderer_name=role_colon \
    learning_rate=1e-5 \
    dpo_beta=0.1
```

Available datasets: `hhh` (Anthropic), `helpsteer3` (NVIDIA), `ultrafeedback`

See [DPO & Preference Learning](dpo-and-preference.md) for full RLHF pipeline and parameters.

## Prompt Distillation

```bash
# Step 1: Generate training data with teacher model
python -m tinker_cookbook.recipes.prompt_distillation.create_data \
    output_file=/tmp/tinker-datasets/prompt_distillation_lang.jsonl

# Step 2: Train student model on distilled data
python -m tinker_cookbook.recipes.prompt_distillation.train
```

## Multi-Step RL (Twenty Questions)

```bash
python -m tinker_cookbook.recipes.twenty_questions.train
```

Complete multi-step environment where a question-asking agent learns to guess hidden words. Good reference for building custom multi-turn RL environments.

## Running Recipes

```bash
# Basic SL
python -m tinker_cookbook.recipes.sl_basic

# Manual SL loop
python -m tinker_cookbook.recipes.sl_loop

# Basic RL
python -m tinker_cookbook.recipes.rl_basic

# Manual RL loop
python -m tinker_cookbook.recipes.rl_loop

# DPO
python -m tinker_cookbook.recipes.preference.train

# Prompt distillation
python -m tinker_cookbook.recipes.prompt_distillation.train

# Multi-step RL
python -m tinker_cookbook.recipes.twenty_questions.train
```

## CLI Overrides

```bash
python -m tinker_cookbook.recipes.sl_basic --learning_rate 1e-4 --batch_size 64
```
