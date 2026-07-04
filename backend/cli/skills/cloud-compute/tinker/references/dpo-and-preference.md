# DPO & Preference Learning

## Direct Preference Optimization (DPO)

DPO trains models to prefer chosen responses over rejected ones using a classification loss, without needing a separate reward model.

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

### Key Parameters

| Parameter | Description | Recommended |
|-----------|-------------|-------------|
| `model_name` | Base model (also used as reference policy) | Start with 1B-8B |
| `dataset` | Preference dataset name | `hhh`, `helpsteer3`, `ultrafeedback` |
| `renderer_name` | Chat format renderer | Match model family |
| `learning_rate` | LR for optimization | 1e-5 to 1e-6 (lower than SFT) |
| `dpo_beta` | Preference strength | Start with 0.1 |
| `log_path` | Output directory | Required |

### Available Datasets

| Dataset | Source | Description |
|---------|--------|-------------|
| `hhh` | Anthropic | Helpful-Harmless-Honest pairwise comparisons |
| `helpsteer3` | NVIDIA | HelpSteer3 preference dataset |
| `ultrafeedback` | UltraFeedback | Binarized preferences |

Custom datasets: implement `DPODatasetBuilder` from `tinker_cookbook.preference.preference_datasets`.

### Training Metrics

| Metric | Description | Watch For |
|--------|-------------|-----------|
| `dpo_loss` | DPO classification loss | Should decrease |
| `accuracy` | Implicit reward model accuracy | Should increase |
| `margin` | Chosen - rejected reward gap | Should increase |
| `chosen_reward` | Average reward for chosen responses | Higher is better |
| `rejected_reward` | Average reward for rejected responses | Lower is better |

### Tips

- **Beta parameter**: Start with `dpo_beta=0.1`, adjust based on dataset
- **Learning rate**: Use lower LR than SFT (1e-5 to 1e-6)
- **Base model**: Should already be in-distribution with the preference data. Either start with a light SFT phase or collect on-policy preferences. Sharp distribution mismatch creates strange behaviors
- **Evaluation**: Use Inspect AI to evaluate after training (see [Evaluations](evaluations.md))

### Evaluating DPO Models

```bash
MODEL_PATH=tinker://YOUR_MODEL_PATH_HERE
python -m tinker_cookbook.eval.run_inspect_evals \
    model_path=$MODEL_PATH \
    model_name=meta-llama/Llama-3.2-1B \
    tasks=inspect_evals/ifeval,inspect_evals/mmlu_0_shot
```

## RLHF Pipeline

Full pipeline: SL → Preference Model → RL, implemented in `recipes/preference/rlhf/rlhf_pipeline.py`.

```bash
python -m recipes.preference.rlhf.rlhf_pipeline
```

### Step 1: Train Initial Policy (SL)

Train on instruction-following data (e.g., no_robots from HuggingFace) to match InstructGPT methodology.

### Step 2: Train Preference Model (SL)

Train on pairwise comparison data (e.g., HHH dataset from Anthropic). Model sees completions A and B, outputs which is preferred.

### Step 3: Train Policy via RL

Use preference model as reward signal. For each prompt:
1. Sample multiple completions from the policy
2. Use preference model to grade all pairs
3. Give reward based on win fraction (self-play)

## Prompt Distillation

Train a model to behave as if given a long prompt, without needing that prompt at inference time.

### How It Works

1. **Teacher generates data**: Long, detailed teacher prompt + queries → responses
2. **Student trains on data**: Student model fine-tunes on (query, response) pairs without the teacher prompt

### Example: Language Classification

```bash
# Step 1: Generate training data with teacher model
python -m tinker_cookbook.recipes.prompt_distillation.create_data \
    output_file=/tmp/tinker-datasets/prompt_distillation_lang.jsonl

# Step 2: Train student model on distilled data
python -m tinker_cookbook.recipes.prompt_distillation.train

# Step 3: Test distilled model
# Sample from trained model to verify performance
```

### When to Use

- System prompt grows impractically long and model starts ignoring instructions
- Need fast inference without long context overhead
- Want to specialize a model for a narrow task distribution
- Teacher and student can be the same model (self-distillation)

### Advanced Configuration

- **Teacher model selection**: Choose based on quality requirements
- **Sampling strategies**: Adjust temperature and generation parameters
- **Data volume**: Scale generated examples based on task complexity
- **Training hyperparameters**: Follow standard SL hyperparameter guidance

## LR Sweep Methodology

For finding task-specific optimal LR:

### Setup

```python
from tinker_cookbook.hyperparam_utils import get_lr
default_lr = get_lr("meta-llama/Llama-3.1-8B")  # ~2.8e-4
```

### Sweep Range

Sweep one order of magnitude above and below default:

```bash
# Launch in parallel (separate terminals)
python -m tinker_cookbook.recipes.sl_loop learning_rate=0.003 log_path=/tmp/sweep/lr-0.003
python -m tinker_cookbook.recipes.sl_loop learning_rate=0.001 log_path=/tmp/sweep/lr-0.001
python -m tinker_cookbook.recipes.sl_loop learning_rate=0.0003 log_path=/tmp/sweep/lr-0.0003
python -m tinker_cookbook.recipes.sl_loop learning_rate=0.0001 log_path=/tmp/sweep/lr-0.0001
python -m tinker_cookbook.recipes.sl_loop learning_rate=0.00003 log_path=/tmp/sweep/lr-0.00003
python -m tinker_cookbook.recipes.sl_loop learning_rate=0.00001 log_path=/tmp/sweep/lr-0.00001
```

### Collect and Visualize

```python
from glob import glob
import pandas, json, os

data = []
for fname in sorted(glob("/tmp/sweep/*/metrics.jsonl")):
    df = pandas.read_json(fname, lines=True)
    if len(df) == 0 or df["progress"].iloc[-1] < 0.98:
        continue
    config = json.load(open(fname.replace("metrics.jsonl", "config.json")))
    data.append({
        "learning_rate": config["learning_rate"],
        "final_loss": df["train_mean_nll"].iloc[-1].item()
    })

df = pandas.DataFrame(data)
optimal_lr = df["learning_rate"][df["final_loss"].idxmin()]
print(f"Optimal LR: {optimal_lr:.2e}")
```

Expected result: U-shaped curve with optimal LR near the `get_lr()` default.
