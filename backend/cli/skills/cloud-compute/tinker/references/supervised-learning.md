# Supervised Learning

## Quick Start with Cookbook

```bash
python -m tinker_cookbook.recipes.sl_basic
```

## Blueprint Pattern (Recommended)

```python
import chz
import sys
import asyncio
from tinker_cookbook.supervised import train
from tinker_cookbook.supervised.types import ChatDatasetBuilderCommonConfig
from tinker_cookbook.supervised.data import FromConversationFileBuilder
from tinker_cookbook.renderers import TrainOnWhat
from tinker_cookbook.model_info import get_recommended_renderer_name
from tinker_cookbook.hyperparam_utils import get_lr

def build_config_blueprint() -> chz.Blueprint[train.Config]:
    model_name = "meta-llama/Llama-3.1-8B"
    renderer_name = get_recommended_renderer_name(model_name)

    common_config = ChatDatasetBuilderCommonConfig(
        model_name_for_tokenizer=model_name,
        renderer_name=renderer_name,
        max_length=2048,
        batch_size=128,
        train_on_what=TrainOnWhat.ALL_ASSISTANT_MESSAGES,
    )

    dataset_builder = FromConversationFileBuilder(
        common_config=common_config,
        file_path="data.jsonl",
    )

    return chz.Blueprint(train.Config).apply({
        "log_path": "/tmp/training",
        "model_name": model_name,
        "dataset_builder": dataset_builder,
        "learning_rate": get_lr(model_name),
        "lr_schedule": "linear",
        "num_epochs": 3,
        "lora_rank": 32,
    })

if __name__ == "__main__":
    blueprint = build_config_blueprint()
    blueprint.make_from_argv(sys.argv[1:])
    asyncio.run(train.main(blueprint.make()))
```

## HuggingFace Dataset Builder

```python
from tinker_cookbook.supervised.types import ChatDatasetBuilder
from tinker_cookbook.supervised.data import SupervisedDatasetFromHFDataset, conversation_to_datum
import datasets

@chz.chz
class MyDatasetBuilder(ChatDatasetBuilder):
    common_config: ChatDatasetBuilderCommonConfig

    def __call__(self):
        hf_dataset = datasets.load_dataset("HuggingFaceH4/no_robots", split="train")
        split = hf_dataset.train_test_split(test_size=0.1, seed=42)

        def map_fn(row):
            messages = [
                {"role": "user", "content": row["prompt"]},
                {"role": "assistant", "content": row["completion"]},
            ]
            return conversation_to_datum(
                messages=messages,
                renderer=self.renderer,
                max_length=self.common_config.max_length,
                train_on_what=self.common_config.train_on_what,
            )

        train_dataset = SupervisedDatasetFromHFDataset(
            hf_dataset=split["train"],
            batch_size=self.common_config.batch_size,
            map_fn=map_fn,
        )
        test_dataset = SupervisedDatasetFromHFDataset(
            hf_dataset=split["test"],
            batch_size=self.common_config.batch_size,
            map_fn=map_fn,
        )
        return train_dataset, test_dataset
```

## Streaming Large Datasets

For datasets >1M examples:

```python
from tinker_cookbook.supervised.data import StreamingSupervisedDatasetFromHFDataset

@chz.chz
class StreamingDatasetBuilder(ChatDatasetBuilder):
    common_config: ChatDatasetBuilderCommonConfig
    max_prompts: int = 100000

    def __call__(self):
        ds = datasets.load_dataset(
            "open-thoughts/OpenThoughts3-1.2M",
            split="train",
            streaming=True,  # Important!
        )

        def map_fn(row):
            messages = [
                {"role": "user", "content": row["question"]},
                {"role": "assistant", "content": row["response"]},
            ]
            return conversation_to_datum(
                messages=messages,
                renderer=self.renderer,
                max_length=self.common_config.max_length,
                train_on_what=self.common_config.train_on_what,
            )

        train_dataset = StreamingSupervisedDatasetFromHFDataset(
            hf_dataset=ds,
            batch_size=self.common_config.batch_size,
            length=self.max_prompts,  # Required
            map_fn=map_fn,
            buffer_size=10000,
        )
        return train_dataset, train_dataset.take(1000)
```

## File-Based Dataset

JSONL format:
```json
{"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
```

```python
from tinker_cookbook.supervised.data import FromConversationFileBuilder

dataset_builder = FromConversationFileBuilder(
    common_config=common_config,
    file_path="/path/to/data.jsonl",
)
```

## TrainOnWhat Enum

```python
from tinker_cookbook.renderers import TrainOnWhat

TrainOnWhat.ALL_ASSISTANT_MESSAGES  # Train on all assistant turns
TrainOnWhat.LAST_ASSISTANT_MESSAGE  # Train only on final response
```

Use `LAST_ASSISTANT_MESSAGE` for:
- Classification (only final answer matters)
- Chain-of-thought where intermediate steps shouldn't be trained
- Preference learning

## Custom Dataset

```python
from tinker_cookbook.supervised.types import SupervisedDataset
from tinker.types import Datum, ModelInput, TensorData
import numpy as np

class CustomDataset(SupervisedDataset):
    def __init__(self, config):
        self.config = config
        self.tokenizer = get_tokenizer(config.model_name)
        self.renderer = get_renderer(config.renderer_name, self.tokenizer)
        self.data = self._load_data()

    def __len__(self):
        return len(self.data) // self.config.batch_size

    def __iter__(self):
        for item in self.data:
            messages = self._preprocess(item)
            # build_supervised_example returns (model_input, weights) tuple
            model_input, weights = self.renderer.build_supervised_example(
                messages=messages,
                train_on_what=TrainOnWhat.ALL_ASSISTANT_MESSAGES,
            )
            tokens = model_input.to_ints()
            yield Datum(
                model_input=ModelInput.from_ints(tokens=tokens[:-1]),
                loss_fn_inputs={
                    "target_tokens": TensorData.from_numpy(np.array(tokens[1:], dtype=np.int64)),
                    "weights": TensorData.from_numpy(np.array(weights[1:], dtype=np.float32)),
                },
            )
```

**Note:** `build_supervised_example` returns a tuple `(model_input, weights)`. The `model_input` is a `ModelInput` (token sequence), and `weights` is a list of per-token floats (0.0 for prompt tokens, 1.0 for completion tokens). When constructing `Datum` manually, shift by one position: input is `tokens[:-1]`, targets are `tokens[1:]`, weights are `weights[1:]`.

## Hyperparameters

### Learning Rate

```python
from tinker_cookbook.hyperparam_utils import get_lr

model_name = "meta-llama/Llama-3.2-1B"
recommended_lr = get_lr(model_name)
```

Formula: `LR = lr_base * M_LoRA * (2000/H_m)^P_m`
- `lr_base = 5e-5`
- `M_LoRA = 10` (multiplier for LoRA)
- `P_m = 0.0775` (Qwen) or `0.781` (Llama)

### Batch Size

- Smaller batch sizes (128) generally better for fine-tuning
- Scale LR with `LR ∝ √batch_size`
- Aim for at least 100 steps of training (1000+ steps for best results)

## Checkpoints

Two types of saved weights:

| Method | Path Contains | Use Case |
|--------|--------------|----------|
| `save_weights_for_sampler()` | `/sampler_weights/` | Sampling/inference only (lightweight) |
| `save_state()` | `/weights/` | Full optimizer state for resuming training |

```python
# Save for sampling
path = training_client.save_weights_for_sampler(name="final").result().path
sampling_client = service_client.create_sampling_client(model_path=path)

# Save full state for resuming
state_path = training_client.save_state(name="checkpoint").result().path
training_client.load_state(state_path)  # Resume later
```

## Output Files

After training, check `log_path` for:
- `metrics.jsonl` - Training metrics
- `checkpoints.jsonl` - Saved checkpoints
- `config.json` - Training configuration

```python
import pandas
df = pandas.read_json("/tmp/training/metrics.jsonl", lines=True)
plt.plot(df['train_mean_nll'], label='train_loss')
plt.plot(df['test/nll'].dropna(), label='test_loss')
```
