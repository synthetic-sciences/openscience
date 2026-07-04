# Getting Started with Tinker

## Creating Clients

```python
import tinker
service_client = tinker.ServiceClient()

# Check available models
for item in service_client.get_server_capabilities().supported_models:
    print("- " + item.model_name)

# Create training client
training_client = service_client.create_lora_training_client(
    base_model="Qwen/Qwen3-VL-30B-A3B-Instruct",
    rank=32,
)

# Get tokenizer
tokenizer = training_client.get_tokenizer()
```

## Preparing Training Data

```python
import numpy as np
from tinker import types

def process_example(example: dict, tokenizer) -> types.Datum:
    prompt = f"English: {example['input']}\nPig Latin:"
    prompt_tokens = tokenizer.encode(prompt, add_special_tokens=True)

    completion_tokens = tokenizer.encode(f" {example['output']}\n\n", add_special_tokens=False)
    tokens = prompt_tokens + completion_tokens
    weights = np.array(([0] * len(prompt_tokens)) + ([1] * len(completion_tokens)), dtype=np.float32)
    target_tokens = np.array(tokens[1:], dtype=np.int64)

    return types.Datum(
        model_input=types.ModelInput.from_ints(tokens=tokens[:-1]),
        loss_fn_inputs=dict(weights=weights[1:], target_tokens=target_tokens)
    )
```

## Vision Inputs

```python
import requests

image_data = requests.get("https://example.com/image.png").content
model_input = tinker.ModelInput(chunks=[
    types.EncodedTextChunk(tokens=tokenizer.encode("<|im_start|>user\n<|vision_start|>")),
    types.ImageChunk(data=image_data, format="png"),
    types.EncodedTextChunk(tokens=tokenizer.encode("<|vision_end|>What is this?<|im_end|>\n<|im_start|>assistant\n")),
])
```

## Training Loop

```python
import numpy as np

for _ in range(6):
    fwdbwd_future = training_client.forward_backward(processed_examples, "cross_entropy")
    optim_future = training_client.optim_step(types.AdamParams(learning_rate=2e-4))  # Use get_lr() for production

    fwdbwd_result = fwdbwd_future.result()
    optim_result = optim_future.result()

    # Compute loss
    logprobs = np.concatenate([out['logprobs'].tolist() for out in fwdbwd_result.loss_fn_outputs])
    weights = np.concatenate([ex.loss_fn_inputs['weights'].tolist() for ex in processed_examples])
    print(f"Loss per token: {-np.dot(logprobs, weights) / weights.sum():.4f}")
```

## Sampling

```python
# Create sampling client
sampling_client = training_client.save_weights_and_get_sampling_client(name='my-model')

# Sample
prompt = types.ModelInput.from_ints(tokens=tokenizer.encode("English: coffee break\nPig Latin:", add_special_tokens=True))
params = types.SamplingParams(max_tokens=20, temperature=0.0, stop=["\n"])
future = sampling_client.sample(prompt=prompt, sampling_params=params, num_samples=8)
result = future.result()

for i, seq in enumerate(result.sequences):
    print(f"{i}: {repr(tokenizer.decode(seq.tokens))}")
```

## Computing Logprobs

```python
# Get prompt logprobs
prompt = types.ModelInput.from_ints(tokens=tokenizer.encode("How many r's are in strawberry?", add_special_tokens=True))
sample_response = sampling_client.sample(
    prompt=prompt,
    num_samples=1,
    sampling_params=tinker.SamplingParams(max_tokens=1),
    include_prompt_logprobs=True,
).result()
print(sample_response.prompt_logprobs)  # [None, -9.5, -1.6, ...]

# Top-k logprobs
sample_response = sampling_client.sample(
    prompt=prompt,
    num_samples=1,
    sampling_params=tinker.SamplingParams(max_tokens=1),
    include_prompt_logprobs=True,
    topk_prompt_logprobs=5,
).result()
print(sample_response.topk_prompt_logprobs)  # [None, [(token_id, logprob), ...], ...]
```

## Async and Futures

Every method has sync and async versions:

| Sync | Async |
|------|-------|
| `create_lora_training_client()` | `create_lora_training_client_async()` |
| `forward()` | `forward_async()` |
| `sample()` | `sample_async()` |

```python
# Sync
future = client.forward_backward(data, loss_fn)
result = future.result()  # Blocks

# Async (double await)
future = await client.forward_backward_async(data, loss_fn)
result = await future
```

### Overlap Requests for Performance

```python
# Submit both before waiting - runs in same clock cycle
fwd_bwd_future = await client.forward_backward_async(batch, loss_fn)
optim_future = await client.optim_step_async(adam_params)

# Now retrieve results
fwd_bwd_result = await fwd_bwd_future
optim_result = await optim_future
```

## Saving and Loading

```python
# Save weights for sampling (fast, smaller)
sampling_path = training_client.save_weights_for_sampler(name="0000").result().path
sampling_client = service_client.create_sampling_client(model_path=sampling_path)

# Save full state for resuming training
resume_path = training_client.save_state(name="0010").result().path
training_client.load_state(resume_path)
```
