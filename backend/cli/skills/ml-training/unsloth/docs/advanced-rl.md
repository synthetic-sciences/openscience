# Advanced Reinforcement Learning Documentation

Detailed guides on doing GRPO with Unsloth for Batching, Generation & Training Parameters:

## Training Parameters

* **`beta`** *(float, default 0.0)*: KL coefficient.
  * `0.0` ⇒ no reference model loaded (lower memory, faster).
  * Higher `beta` constrains the policy to stay closer to the ref policy.
* **`num_iterations`** *(int, default 1)*: PPO epochs per batch (μ in the algorithm).\
  Replays data within each gradient accumulation step; e.g., `2` = two forward passes per accumulation step.
* **`epsilon`** *(float, default 0.2)*: Clipping value for token-level log-prob ratios (typical ratio range ≈ \[-1.2, 1.2] with default ε).
* **`delta`** *(float, optional)*: Enables **upper** clipping bound for **two-sided GRPO** when set. If `None`, standard GRPO clipping is used. Recommended `> 1 + ε` when enabled (per INTELLECT-2 report).
* **`epsilon_high`** *(float, optional)*: Upper-bound epsilon; defaults to `epsilon` if unset. DAPO recommends **0* **`importance_sampling_level`** *(“token” | “sequence”, default "token")*:
  * `"token"`: raw per-token ratios (one weight per token).
  * `"sequence"`: average per-token ratios to a single sequence-level ratio.\
    GSPO shows sequence-level sampling often gives more stable training for sequence-level rewards.
* **`reward_weights`** *(list\[float], optional)*: One weight per reward. If `None`, all weights = 1.0.
* **`scale_rewards`** *(str|bool, default "group")*:
  * `True` or `"group"`: scale by **std within each group** (unit variance in group).
  * `"batch"`: scale by **std across the entire batch** (per PPO-Lite).
  * `False` or `"none"`: **no scaling**. Dr. GRPO recommends not scaling to avoid difficulty bias from std scaling.
* **`loss_type`** *(str, default "dapo")*:
  * `"grpo"`: normalizes over sequence length (length bias; not recommended).
  * `"dr_grpo"`: normalizes by a **global constant** (introduced in Dr. GRPO; removes length bias). Constant ≈ `max_completion_length`.
  * `"dapault)**: normalizes by **active tokens in the global accumulated batch** (introduced in DAPO; removes length bias).
  * `"bnpo"`: normalizes by **active tokens in the local batch** only (results can vary with local batch size; equals GRPO when `per_device_train_batch_size == 1`).
* **`mask_truncated_completions`** *(bool, default False)*:\
  When `True`, truncated completions are excluded from loss (recommended by DAPO for stability).\
  **Note**: There are some KL issues with this flag, so we recommend to disable it.

  ```python
  # If mask_truncated_completions is enabled, zero out truncated completions in completion_mask
  if self.mask_truncated_completions:
      truncated_completions = ~is_eos.any(dim=1)
      completion_mask = completion_mask * (~truncated_completions).unsqueeze(1).int()
  ```

  This can zero out all `completion_mask` entries when many completions are truncated, making `n_mask_per_reward = 0` and causing KL to become NaN. [See](https://github.com/unslothai/unsloth-zoo/blob/e705f7cb50aa3470a0b6e36052c61b7486a39133/unsloth_zoo/rl_replacements.py#L184)
* **`vllm_importance_sampling_correction`** *(bool, default True)*:\
  Applies **Truncated Importance Sampling (TIS)** to correct off-policy effects when generation (e.g., vLLM / fast\_inference) differs from training backend.\
  In Unsloth, this is **auto-set to True** if you’re using vLLM/fast\_inference; otherwise **False**.
* **`vllm_importance_sampling_cap`** *(float, default 2.0)*:\
  Truncation parameter **C** for TIS; sets an upper bound on the importance sampling ratio to improve stability.
* **`dtype`** when choosing float16 or bfloat16, see [fp16-vs-bf16-for-rl](https://unsloth.ai/docs/get-started/reinforcement-learning-rl-guide/fp16-vs-bf16-for-rl "mention")

## Generation Parameters

* `temperature (float, defaults to 1.0):`\
  Temperature for sampling. The higher the temperature, the more random the completions. Make sure you use a relatively high (1.0) temperature to have diversity in generations which helps learning.
* `t_p (float, optional, defaults to 1.0):`\
  Float that controls the cumulative probability of the top tokens to consider. Must be in (0, 1]. Set to 1.0 to consider all tokens.
* `top_k (int, optional):`\
  Number of highest probability vocabulary tokens to keep for top-k-filtering. If None, top-k-filtering is disabled and all tokens are considered.
* `min_p (float, optional):`\
  Minimum token probability, which will be scaled by the probability of the most likely token. It must be a value between 0.0 and 1.0. Typical values are in the 0.01-0.2 range.
* `repetition_penalty (float, optional, defaults to 1.0):`\
  Float that penalizes new tokens based on whether they appear in the prompt and the generated text so far. Values > 1.0 encourage the model to use new tokens, while values < 1.0 encourage the model to repeat tokens.
* `steps_per_generation: (int, optional):`\
  Number of steps per generation. If None, it defaults to `gradient_accumulation_steps`. Mutually exclusive with `generation_batch_size`.

{% hint style="info" %}
It is a bit confusing to mess with this parameter, it is recommended to edit `per_device_train_batch_size` and gradient accumulation for the batch sizes
{% endhint %}

## Batch & Throughput Parameters

### Parameters that control batches

* **`train_batch_size`**: Number of samples **per process** per step.\
  If this integer is **less than `num_generations`**, it will default to `num_generations`.
* **`steps_per_generation`**: Number of **microbatches** that contribute to **one generation’s** loss calculation (forward passes only).\
  A new batch of data is generated every `steps_per_generation` steps; backpropagation timing depends on `gradient_accumulation_steps`.
* **`num_processes`**: Number of distributed training processes (e.g., GPUs / workers).
* **`gradient_accumulation_steps`** (aka `gradient_accumulation`): Number of microbatches to accumulate **before** applying backpropagation and optimizer update.
* **Effective batch size**:

  ```
  effective_batch_size = steps_per_generion * num_processes * train_batch_size
  ```

  Total samples contributing to gradients before an update (across all processes and steps).
* **Optimizer steps per generation**:

  ```
  optimizer_steps_per_generation = steps_per_generation / gradient_accumulation_steps
  ```

  Example: `4 / 2 = 2`.
* **`num_generations`**: Number of generations produced **per prompt** (applied **after** computing `effective_batch_size`).\
  The number of **unique prompts** in a generation cycle is:

  ```
  unique_prompts = effective_batch_size / num_generations
  ```

  **Must be > 2** for GRPO to work.

### GRPO Batch Examples

The tables below illustrate how batches flow through steps, when optimizer updates occur, and how new batches are generated.

#### Example 1

```
num_gpus = 1
per_device_train_batch_size = 3
gradient_accumulation_steps = 2
steps_per_generation = 4

effective_batch_size = 4 * 3 * 1 = 12
num_generations = 3
```

**Generation cycle A**

| Step | Batch    | Notes                                  |
| ---: | -------- | -------------------------------------- |
|    0 | \[0,0,0] |                                        |
|    1 | \[1,1,1] | → optimizer update (accum = 2 reached) |
|    2 | \[2,2,2] |                                        |
|    3 | \[3,3,3] | optimizer update                       |

**Generation cycle B**

| Step | Batch    | Notes                                  |
| ---: | -------- | -------------------------------------- |
|    0 | \[4,4,4] |                                        |
|    1 | \[5,5,5] | → optimizer update (accum = 2 reached) |
|    2 | \[6,6,6] |                                        |
|    3 | \[7,7,7] | optimizer update                       |

#### Example 2

```
num_gpus = 1
per_device_train_batch_size = 3
steps_per_generation = gradient_accumulation_steps = 4

effective_batch_size = 4 * 3 * 1 = 12
num_generations = 3
```

**Generation cycle A**

| Step | Batch    | Notes                                |
| ---: | -------- | ------------------------------------    0 | \[0,0,0] |                                      |
|    1 | \[1,1,1] |                                      |
|    2 | \[2,2,2] |                                      |
|    3 | \[3,3,3] | optimizer update (accum = 4 reached) |

**Generation cycle B**

| Step | Batch    | Notes                                |
| ---: | -------- | ------------------------------------ |
|    0 | \[4,4,4] |                                      |
|    1 | \[5,5,5] |                                      |
|    2 | \[6,6,6] |                                      |
|    3 | \[7,7,7] | optimizer update (accum = 4 reached) |

#### Example 3

```
num_gpus = 1
per_device_train_batch_size = 3
steps_per_generation = gradient_accumulation_steps = 4

effective_batch_size = 4 * 3 * 1 = 12
num_generations = 4
unique_prompts = effective_batch_size / num_generations = 3
```

**Generation cycle A**

| Step | Batch    | Notes                                |
| ---: | -------- | ------------------------------------ |
|    0 | \[0,0,0] |                                      |
|    1 | \[0,1,1] |                                      |
|    2 | \[1,1,3] |                                      |
|    3 | \[3,3,3] | optimizer update (accum = 4 reached) |

**Generation cycle B**

| Step | Batch    | Notes                                |
| ---: | -------- | ------------------------------------ |
|    0 | \[4,4,4] |                                      |
|    1 | \[4,5,5] |                                      |
|    2 | \[5,5,6] |                                      |
|    3 | \[6,6,6] | optimizer update (accum = 4 reached) |

#### Example 4

```
num_gpus = 1
per_device_train_batch_size = 6
steps_per_generation = gradient_accumulation_steps = 2

effective_batch_size = 2 * 6 * 1 = 12
num_generations = 3
unique_prompts = 4
```

**Generation cycle A**

| Step | Batch           | Notes                                |
| ---: | --------------- | ------------------------------------ |
|    0 | \[0,0,0, 1,1,1] |                                      |
|    1 | \[2,2,2, 3,3,3] | optimizer update (accum = 2 reached) |

**Generation cycle B**

| Step | Batch           | Notes                                |
| ---: | --------------- | ------------------------------------ |
|    0 | \[4,4,4, 5,5,5] |                                      |
|    1 | \[6,6,6, 7,7,7] | optimizer update (accum = 2 reached) |

### Quick Formula Reference

```
effective_batch_size = steps_per_generation * num_processes * train_batch_size
optimizer_steps_per_generation = steps_per_generation / gradient_accumulation_steps
unique_prompts = effective_batch_size / num_generations   # must be > 2