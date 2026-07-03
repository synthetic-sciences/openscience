---
name: together-ai-inference
description: Serverless inference, fine-tuning, embeddings, image generation, and batch processing on 200+ open-source models via an OpenAI-compatible API. Use when you need fast, cost-effective access to open-source LLMs without managing infrastructure.
category: cloud-compute
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Inference, Together AI, Fine-Tuning, Embeddings, Serverless, OpenAI-Compatible, Batch, Image Generation]
dependencies: [together, openai]
---

# Together AI — Serverless Inference & Fine-Tuning

Together AI is an AI cloud platform providing serverless inference on 200+ open-source models through an OpenAI-compatible API. It supports chat completions, embeddings, fine-tuning, image generation, and batch processing at `https://api.together.xyz/v1`.

## When to Use Together AI

**Use Together AI when:**
- You need fast serverless inference on open-source models (Llama, DeepSeek, Qwen, Mistral)
- You want an OpenAI-compatible API so you can swap providers with a single line change
- You need to fine-tune open-source models without managing GPU infrastructure
- You want cost-effective inference with pay-per-token pricing
- You need function calling, JSON mode, or structured outputs from open-source models
- You want batch processing at 50% lower cost for non-urgent workloads
- You need embeddings or image generation alongside chat completions

**Use alternatives instead:**

| Need | Use Instead |
|------|-------------|
| Managed LoRA fine-tuning with training platform | **Tinker** |
| Self-hosted inference with full control | **vLLM**, **TensorRT-LLM** |
| Dedicated GPU instances | **Lambda Labs**, **RunPod** |
| Serverless GPU with custom containers | **Modal** |
| Multi-cloud cost optimization | **SkyPilot** |
| Proprietary models (GPT-4o, Claude) | **OpenAI**, **Anthropic** directly |


## Credential Setup

Credentials are auto-injected by openscience when connected via the dashboard.

```bash
# Verify credentials
[ -n "$TOGETHER_API_KEY" ] && echo "TOGETHER_API_KEY set" || echo "NOT SET"
```

If not set: connect Together AI at https://app.syntheticsciences.ai -> Services, then restart openscience.

## Quick Start

### Install

```python
pip install together openai
```

### Set API Key

```python
import os
os.environ["TOGETHER_API_KEY"] = "your-api-key"

# Or export in shell:
# export TOGETHER_API_KEY="your-api-key"
```

Get your API key from https://api.together.xyz/settings/api-keys

### Basic Chat Completion

```python
from together import Together

client = Together()

response = client.chat.completions.create(
    model="meta-llama/Llama-3.3-70B-Instruct-Reference",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Explain gradient descent in one paragraph."},
    ],
    max_tokens=256,
    temperature=0.7,
)

print(response.choices[0].message.content)
```

## Inference

### Chat Completions

The primary endpoint for conversational AI. Supports system/user/assistant messages, temperature, top_p, top_k, repetition_penalty, and stop sequences.

```python
from together import Together

client = Together()

response = client.chat.completions.create(
    model="deepseek-ai/DeepSeek-V3",
    messages=[
        {"role": "system", "content": "You are an expert ML researcher."},
        {"role": "user", "content": "Compare LoRA vs full fine-tuning."},
    ],
    max_tokens=512,
    temperature=0.7,
    top_p=0.9,
    top_k=50,
    repetition_penalty=1.1,
    stop=["</s>"],
)

print(response.choices[0].message.content)
print(f"Tokens used: {response.usage.total_tokens}")
```

### Streaming

```python
from together import Together

client = Together()

stream = client.chat.completions.create(
    model="meta-llama/Llama-3.3-70B-Instruct-Reference",
    messages=[{"role": "user", "content": "Write a haiku about transformers."}],
    max_tokens=128,
    stream=True,
)

for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
print()
```

### Function Calling

Supported on select models including Llama, DeepSeek, Qwen, and Mistral variants.

```python
from together import Together
import json

client = Together()

tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather for a location",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "City and state, e.g. San Francisco, CA",
                    },
                    "unit": {
                        "type": "string",
                        "enum": ["celsius", "fahrenheit"],
                    },
                },
                "required": ["location"],
            },
        },
    }
]

response = client.chat.completions.create(
    model="meta-llama/Llama-3.3-70B-Instruct-Reference",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "What's the weather in San Francisco?"},
    ],
    tools=tools,
    tool_choice="auto",
)

tool_calls = response.choices[0].message.tool_calls
if tool_calls:
    call = tool_calls[0]
    print(f"Function: {call.function.name}")
    print(f"Arguments: {call.function.arguments}")
```

### JSON Mode (Structured Outputs)

Force the model to return valid JSON conforming to a schema.

```python
import json
from together import Together

client = Together()

schema = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "age": {"type": "integer"},
        "skills": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["name", "age", "skills"],
}

response = client.chat.completions.create(
    model="meta-llama/Llama-3.3-70B-Instruct-Reference",
    messages=[
        {
            "role": "system",
            "content": f"Respond only in JSON matching this schema: {json.dumps(schema)}",
        },
        {"role": "user", "content": "Create a profile for a senior ML engineer."},
    ],
    response_format={
        "type": "json_object",
        "schema": schema,
    },
)

data = json.loads(response.choices[0].message.content)
print(json.dumps(data, indent=2))
```

### Vision Models

```python
from together import Together

client = Together()

response = client.chat.completions.create(
    model="meta-llama/Llama-4-Scout-17B-16E-Instruct-VLM",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Describe this image in detail."},
                {
                    "type": "image_url",
                    "image_url": {"url": "https://example.com/image.jpg"},
                },
            ],
        }
    ],
    max_tokens=512,
)

print(response.choices[0].message.content)
```

## Fine-Tuning

Together AI supports both LoRA and full fine-tuning on a wide range of open-source models.

### Data Format

Training data must be in JSONL format with chat-style messages:

```jsonl
{"messages": [{"role": "system", "content": "You are a helpful assistant."}, {"role": "user", "content": "What is the capital of France?"}, {"role": "assistant", "content": "The capital of France is Paris."}]}
{"messages": [{"role": "user", "content": "Explain photosynthesis."}, {"role": "assistant", "content": "Photosynthesis is the process by which plants convert sunlight, water, and carbon dioxide into glucose and oxygen."}]}
```

Each line is one training example. The `system` role is optional. The model learns to generate the `assistant` responses.

### Upload Training Data

```python
from together import Together

client = Together()

# Upload training file
file = client.files.upload(file="training_data.jsonl")
print(f"File ID: {file.id}")
```

### Create Fine-Tuning Job

```python
from together import Together

client = Together()

# Create LoRA fine-tuning job
job = client.fine_tuning.create(
    training_file="file-abc123",
    model="meta-llama/Llama-3.3-70B-Instruct-Reference",
    n_epochs=3,
    learning_rate=1e-5,
    batch_size=4,
    lora=True,
    lora_r=16,
    lora_alpha=32,
    lora_dropout=0.05,
    suffix="my-custom-model",
)

print(f"Job ID: {job.id}")
print(f"Status: {job.status}")
```

### Monitor Fine-Tuning

```python
from together import Together

client = Together()

# Check job status
job = client.fine_tuning.retrieve(id="ft-abc123")
print(f"Status: {job.status}")

# List all jobs
jobs = client.fine_tuning.list()
for j in jobs:
    print(f"{j.id}: {j.status}")

# List events (training logs)
events = client.fine_tuning.list_events(id="ft-abc123")
for event in events:
    print(event)

# Cancel a job
client.fine_tuning.cancel(id="ft-abc123")
```

### CLI Fine-Tuning

```bash
# Install CLI
pip install --upgrade together

# Upload data
together files upload training_data.jsonl

# Create fine-tuning job
together fine-tuning create \
    --training-file file-abc123 \
    -m meta-llama/Meta-Llama-3.1-8B-Instruct-Reference

# Check status
together fine-tuning status ft-abc123

# List checkpoints
together fine-tuning list-checkpoints ft-abc123

# Download fine-tuned model
together fine-tuning download --ft-id ft-abc123
```

### Supported Fine-Tuning Models (Selection)

| Model | LoRA | Full |
|-------|------|------|
| meta-llama/Meta-Llama-3.1-8B-Instruct-Reference | Yes | Yes |
| meta-llama/Llama-3.3-70B-Instruct-Reference | Yes | Yes |
| meta-llama/Llama-4-Scout-17B-16E-Instruct | Yes | No |
| deepseek-ai/DeepSeek-V3 | Yes | No |
| deepseek-ai/DeepSeek-R1 | Yes | No |
| Qwen/Qwen3-8B | Yes | Yes |
| Qwen/Qwen3-32B | Yes | Yes |
| Qwen/Qwen3-235B-A22B | Yes | No |
| google/gemma-3-27b-it | Yes | Yes |
| google/gemma-3-4b-it | Yes | Yes |

See the full list at https://docs.together.ai/docs/fine-tuning-models

## Embeddings

### Generate Embeddings

```python
from together import Together

client = Together()

response = client.embeddings.create(
    model="BAAI/bge-large-en-v1.5",
    input="What is the meaning of life?",
)

embedding = response.data[0].embedding
print(f"Dimensions: {len(embedding)}")
print(f"First 5 values: {embedding[:5]}")
```

### Batch Embeddings

```python
from together import Together

client = Together()

texts = [
    "Machine learning is a subset of AI.",
    "Deep learning uses neural networks.",
    "Transformers revolutionized NLP.",
]

response = client.embeddings.create(
    model="BAAI/bge-large-en-v1.5",
    input=texts,
)

for i, item in enumerate(response.data):
    print(f"Text {i}: {len(item.embedding)} dimensions")
```

### Available Embedding Models

| Model ID | Dimensions | Best For |
|----------|-----------|----------|
| `BAAI/bge-large-en-v1.5` | 1024 | General-purpose English retrieval |
| `BAAI/bge-base-en-v1.5` | 768 | Balanced performance and cost |
| `WhereIsAI/UAE-Large-V1` | 1024 | High-accuracy retrieval |
| `togethercomputer/m2-bert-80M-8k-retrieval` | 768 | Long-context (8k tokens) retrieval |

## Image Generation

Together AI hosts FLUX models from Black Forest Labs for high-quality image generation.

### Generate Images

```python
from together import Together

client = Together()

response = client.images.generate(
    model="black-forest-labs/FLUX.1-schnell",
    prompt="A photorealistic mountain landscape at sunset with a lake reflection",
    steps=4,
    n=1,
    width=1024,
    height=1024,
)

# Response contains URL or base64 image data
print(response.data[0].url)
```

### Available Image Models

| Model ID | Type | Notes |
|----------|------|-------|
| `black-forest-labs/FLUX.1-schnell` | Fast generation | Fastest, lower step count (4 steps) |
| `black-forest-labs/FLUX.1-dev` | Development | LoRA support for custom styles |
| `black-forest-labs/FLUX.1.1-pro` | Premium | Highest quality, best prompt adherence |

### Image with OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["TOGETHER_API_KEY"],
    base_url="https://api.together.xyz/v1",
)

response = client.images.generate(
    model="black-forest-labs/FLUX.1-schnell",
    prompt="A cyberpunk cityscape at night",
    n=1,
)

print(response.data[0].url)
```

## Batch Inference

Batch API processes large volumes of requests asynchronously at 50% lower cost with a 24-hour turnaround.

### Input File Format

Create a JSONL file where each line is a request:

```jsonl
{"custom_id": "request-1", "body": {"model": "deepseek-ai/DeepSeek-V3", "messages": [{"role": "user", "content": "What is machine learning?"}], "max_tokens": 200}}
{"custom_id": "request-2", "body": {"model": "deepseek-ai/DeepSeek-V3", "messages": [{"role": "user", "content": "Explain gradient descent."}], "max_tokens": 200}}
{"custom_id": "request-3", "body": {"model": "deepseek-ai/DeepSeek-V3", "messages": [{"role": "user", "content": "What are transformers?"}], "max_tokens": 200}}
```

### Submit Batch Job

```python
from together import Together

client = Together()

# 1. Upload the batch file
batch_file = client.files.upload(
    file="batch_requests.jsonl",
    purpose="batch-api",
)
print(f"File ID: {batch_file.id}")

# 2. Create the batch job
batch = client.batches.create_batch(
    file_id=batch_file.id,
    endpoint="/v1/chat/completions",
)
print(f"Batch ID: {batch.id}")

# 3. Monitor status
status = client.batches.get_batch(batch.id)
print(f"Status: {status.status}")

# 4. Download results when completed
if status.status == "COMPLETED":
    results = client.files.retrieve_content(
        id=status.output_file_id,
    )
    print(results)
```

### List Batches

```python
from together import Together

client = Together()

batches = client.batches.list_batches()
for b in batches:
    print(f"{b.id}: {b.status}")
```

## Model Selection

### Chat / Instruct Models

| Model ID | Params | Input $/M | Output $/M | Context | Best For |
|----------|--------|-----------|------------|---------|----------|
| `meta-llama/Meta-Llama-3.1-8B-Instruct-Reference` | 8B | $0.18 | $0.18 | 131k | Fast, cheap general tasks |
| `meta-llama/Llama-3.3-70B-Instruct-Reference` | 70B | $0.88 | $0.88 | 131k | High-quality general purpose |
| `meta-llama/Llama-4-Maverick-17B-128E-Instruct` | 400B MoE | $0.27 | $0.85 | 1M | Cost-effective large model |
| `deepseek-ai/DeepSeek-V3` | 671B MoE | $1.25 | $1.25 | 128k | Top-tier reasoning and code |
| `deepseek-ai/DeepSeek-R1` | 671B MoE | $3.00 | $7.00 | 128k | Complex reasoning with CoT |
| `Qwen/Qwen3-Next-80B-A3B-Instruct` | 80B MoE | $0.15 | $1.50 | 128k | Ultra-cheap MoE inference |
| `Qwen/Qwen3-235B-A22B` | 235B MoE | $0.50 | $1.50 | 128k | Powerful open-weight MoE |
| `mistralai/Mixtral-8x7B-Instruct-v0.1` | 46B MoE | $0.60 | $0.60 | 32k | Balanced MoE model |
| `Qwen/Qwen3-Coder-480B-A35B-Instruct` | 480B MoE | $0.60 | $1.80 | 256k | Code generation and review |
| `google/gemma-3-27b-it` | 27B | $0.30 | $0.30 | 128k | Google's efficient model |

### Reasoning Models

| Model ID | Input $/M | Output $/M | Notes |
|----------|-----------|------------|-------|
| `deepseek-ai/DeepSeek-R1` | $3.00 | $7.00 | Chain-of-thought reasoning |
| `deepseek-ai/DeepSeek-R1-0528` | $3.00 | $7.00 | Updated R1 variant |
| `Qwen/Qwen3-Next-80B-A3B-Thinking` | $0.15 | $1.50 | MoE reasoning, very cheap |

### Code Models

| Model ID | Input $/M | Output $/M | Notes |
|----------|-----------|------------|-------|
| `Qwen/Qwen3-Coder-30B-A3B-Instruct` | $0.15 | $1.50 | Fast code MoE |
| `Qwen/Qwen3-Coder-480B-A35B-Instruct` | $0.60 | $1.80 | Largest code model |

Pricing is approximate and subject to change. Check https://www.together.ai/pricing for current rates.

## OpenAI Compatibility

Together AI is fully compatible with the OpenAI Python SDK. Change two lines to switch from OpenAI to Together AI.

### Using OpenAI SDK

```python
from openai import OpenAI
import os

# Just change the API key and base_url
client = OpenAI(
    api_key=os.environ["TOGETHER_API_KEY"],
    base_url="https://api.together.xyz/v1",
)

# Everything else is identical to OpenAI usage
response = client.chat.completions.create(
    model="meta-llama/Llama-3.3-70B-Instruct-Reference",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"},
    ],
    max_tokens=256,
)

print(response.choices[0].message.content)
```

### What Works with OpenAI SDK

| Feature | Supported |
|---------|-----------|
| `chat.completions.create` | Yes |
| Streaming responses | Yes |
| Function calling / tools | Yes |
| JSON mode / structured outputs | Yes |
| Vision (multimodal) | Yes |
| `embeddings.create` | Yes |
| `images.generate` | Yes |
| `fine_tuning.jobs.create` | Yes |
| `models.list` | Yes |
| Async client | Yes |
| `.with_raw_response` | Yes |
| `.with_streaming_response` | Yes |

### LangChain Integration

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="meta-llama/Llama-3.3-70B-Instruct-Reference",
    openai_api_key=os.environ["TOGETHER_API_KEY"],
    openai_api_base="https://api.together.xyz/v1",
)

response = llm.invoke("What is the meaning of life?")
print(response.content)
```

## CLI Reference

The `together` CLI provides direct access from the terminal.

```bash
# Install
pip install --upgrade together

# Set API key
export TOGETHER_API_KEY="your-api-key"

# Chat completion
together chat.completions \
    --message "system" "You are helpful." \
    --message "user" "What is PyTorch?" \
    --model meta-llama/Llama-3.3-70B-Instruct-Reference

# List models
together models list

# Image generation
together images generate \
    "A futuristic city at sunset" \
    --model black-forest-labs/FLUX.1-schnell \
    --n 1

# File operations
together files upload training_data.jsonl
together files list
together files retrieve file-abc123
together files delete file-abc123

# Fine-tuning
together fine-tuning create \
    --training-file file-abc123 \
    -m meta-llama/Meta-Llama-3.1-8B-Instruct-Reference
together fine-tuning list
together fine-tuning status ft-abc123
together fine-tuning list-events ft-abc123
together fine-tuning list-checkpoints ft-abc123
together fine-tuning download --ft-id ft-abc123
together fine-tuning cancel ft-abc123
```

## Cost Optimization

### 1. Use MoE Models

Mixture-of-Experts models activate only a fraction of parameters per token, offering better price-to-performance:

| Model | Active Params | Price |
|-------|--------------|-------|
| Qwen3-Next-80B-A3B | 3B active of 80B | $0.15/M input |
| Llama-4-Maverick | 17B active of 400B | $0.27/M input |
| DeepSeek-V3 | ~37B active of 671B | $1.25/M input |

### 2. Use Batch API

Submit non-urgent workloads via the batch API for 50% cost reduction. Ideal for evaluations, dataset generation, and bulk classification.

### 3. Use JSON Mode for Structured Output

Avoid post-processing errors and retry loops by constraining output format upfront.

### 4. Right-Size Your Model

- **Simple classification/extraction**: 8B models ($0.18/M)
- **General chat/instruction**: 70B models ($0.88/M)
- **Complex reasoning/code**: DeepSeek-V3 ($1.25/M) or R1 ($3.00/M)
- **Cost-sensitive high volume**: MoE models like Qwen3-Next ($0.15/M)

### 5. Minimize Max Tokens

Set `max_tokens` to the minimum needed. You pay for output tokens generated, not the max_tokens budget.

### 6. Use Streaming for Long Outputs

Streaming does not cost more but gives faster time-to-first-token and lets you abort early if the output goes off track.

## Common Issues

| Problem | Solution |
|---------|----------|
| `401 Unauthorized` | Check `TOGETHER_API_KEY` is set and valid |
| `429 Rate Limited` | Implement exponential backoff; upgrade plan for higher limits |
| `Model not found` | Verify model ID at https://docs.together.ai/docs/serverless-models |
| JSON mode returns invalid JSON | Include the schema in the system prompt alongside `response_format` |
| Function calling not working | Use supported models (Llama 3.x, DeepSeek, Qwen3, Mistral) |
| Fine-tuning job stuck | Check data format (must be valid JSONL with `messages` array) |
| Batch job failed | Verify JSONL format has `custom_id` and `body` fields per line |
| Slow response times | Try Turbo/Lite model variants or reduce `max_tokens` |
| Embedding dimensions mismatch | Different models produce different dimensions (768 or 1024) |
| Image generation timeout | Reduce `steps` parameter; use FLUX.1-schnell for fastest results |

## Resources

- **Documentation**: https://docs.together.ai
- **API Reference**: https://docs.together.ai/reference
- **Pricing**: https://www.together.ai/pricing
- **Dashboard**: https://api.together.xyz
- **Model Catalog**: https://docs.together.ai/docs/serverless-models
- **Fine-Tuning Guide**: https://docs.together.ai/docs/fine-tuning-quickstart
- **Python SDK**: https://github.com/togethercomputer/together-python
- **TypeScript SDK**: https://github.com/togethercomputer/together-typescript
- **Cookbook (Examples)**: https://github.com/togethercomputer/together-cookbook
- **Status Page**: https://status.together.ai
