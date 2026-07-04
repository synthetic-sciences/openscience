# API Reference

## ServiceClient

Main entry point for Tinker API.

```python
client = tinker.ServiceClient()
```

**Methods:**
- `get_server_capabilities()` - Query supported models
- `create_lora_training_client(base_model, rank=32, seed=None, train_mlp=True, train_attn=True, train_unembed=True)` - Create LoRA training client
- `create_training_client_from_state(path)` - Resume from checkpoint (weights only)
- `create_training_client_from_state_with_optimizer(path)` - Resume from checkpoint (weights + optimizer)
- `create_sampling_client(model_path=None, base_model=None)` - Create inference client
- `create_rest_client()` - Create REST API client

## TrainingClient

Client for training with forward/backward passes.

**Methods:**
- `forward(data, loss_fn, loss_fn_config=None)` - Forward pass without gradients
- `forward_backward(data, loss_fn, loss_fn_config=None)` - Compute gradients
- `forward_backward_custom(data, loss_fn)` - Custom loss function (1.5x FLOPs)
- `optim_step(adam_params)` - Update parameters
- `save_state(name)` - Save weights + optimizer state
- `load_state(path)` - Load weights only
- `load_state_with_optimizer(path)` - Load weights + optimizer
- `save_weights_for_sampler(name)` - Save for inference
- `save_weights_and_get_sampling_client(name)` - Save and get sampler
- `get_info()` - Get model info
- `get_tokenizer()` - Get tokenizer

## SamplingClient

Client for text generation.

**Methods:**
- `sample(prompt, num_samples, sampling_params, include_prompt_logprobs=False, topk_prompt_logprobs=None)` - Generate completions
- `compute_logprobs(prompt)` - Get prompt logprobs

## Core Types

### Datum
```python
types.Datum(
    model_input=ModelInput,
    loss_fn_inputs={"target_tokens": ..., "weights": ...}
)
```

### ModelInput
```python
types.ModelInput.from_ints(tokens=[1, 2, 3])  # From token list
types.ModelInput(chunks=[EncodedTextChunk, ImageChunk, ...])  # Multi-modal
model_input.to_ints()  # Convert to token list
model_input.length()   # Total context length
```

### AdamParams
```python
types.AdamParams(
    learning_rate=1e-4,
    beta1=0.9,
    beta2=0.95,
    eps=1e-8,
    weight_decay=0.0,
    grad_clip_norm=0.0,  # 0 = no clipping
)
```

### SamplingParams
```python
types.SamplingParams(
    max_tokens=100,
    temperature=0.7,
    top_p=0.9,
    top_k=-1,  # -1 = no limit
    stop=["<|endoftext|>"],
    seed=42,
)
```

### TensorData
```python
types.TensorData.from_numpy(np.array([...]))
types.TensorData.from_torch(torch.tensor([...]))
tensor_data.to_numpy()
tensor_data.to_torch()
```

### ImageChunk
```python
types.ImageChunk(
    data=image_bytes,
    format="png",  # or "jpeg"
    expected_tokens=None,  # Optional advisory
)
```

### EncodedTextChunk
```python
types.EncodedTextChunk(tokens=[1, 2, 3])
```

### LoraConfig
```python
types.LoraConfig(
    rank=32,
    seed=42,
    train_unembed=False,
    train_mlp=True,
    train_attn=True,
)
```

## Response Types

### ForwardBackwardOutput
```python
result = fwdbwd_future.result()
result.loss_fn_outputs  # List of dicts with "logprobs"
result.metrics  # Training metrics
```

### SampleResponse
```python
result = sample_future.result()
result.sequences  # List of SampledSequence
result.prompt_logprobs  # If requested
result.topk_prompt_logprobs  # If requested
```

### SampledSequence
```python
seq = result.sequences[0]
seq.tokens  # Generated token IDs
seq.logprobs  # Per-token logprobs
seq.stop_reason  # Why generation stopped
```

### SaveWeightsResponse
```python
response = training_client.save_state(name).result()
response.path  # "tinker://<model_id>/<name>"
```

## Checkpoint Types

### Checkpoint
```python
checkpoint.checkpoint_id
checkpoint.checkpoint_type  # "training" or "sampler"
checkpoint.time
checkpoint.tinker_path
checkpoint.size_bytes
checkpoint.public
```

### ParsedCheckpointTinkerPath
```python
parsed = ParsedCheckpointTinkerPath.from_tinker_path("tinker://...")
parsed.training_run_id
parsed.checkpoint_type
parsed.checkpoint_id
```
