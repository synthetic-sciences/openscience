---
name: fireworks-ai-inference
description: Fast inference and fine-tuning platform with serverless and on-demand GPU deployments. OpenAI-compatible API for chat completions, embeddings, function calling, vision, and structured output. Supports SFT, DPO, and RL fine-tuning. SOC2 + HIPAA compliant.
category: cloud-compute
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Inference, Fireworks AI, Fine-Tuning, Serverless, On-Demand GPU, OpenAI-Compatible]
dependencies: [fireworks-ai, openai]
---

# Fireworks AI -- Fast Inference & Fine-Tuning

Fastest open-model inference platform with serverless and on-demand GPU deployments, OpenAI-compatible API, and built-in fine-tuning (SFT, DPO, RL).

## When to Use Fireworks AI

**Use Fireworks AI when:**
- Need fast serverless inference for open-source models (Llama, Qwen, DeepSeek, Mixtral)
- Want OpenAI SDK drop-in replacement with open models
- Need fine-tuning without managing infrastructure (SFT, DPO, RL)
- Require structured output / JSON mode / function calling with open models
- Need dedicated GPU deployments with predictable latency
- Require SOC2 or HIPAA compliance
- Want prompt caching and batch inference for cost savings

**Use alternatives instead:**

| Need | Use Instead |
|------|-------------|
| Self-hosted inference (full control) | **vLLM**, **TensorRT-LLM** |
| Cheapest serverless inference | **Groq** (free tier), **Together AI** |
| Managed LoRA fine-tuning (no infra) | **Tinker** |
| Closed-model APIs (GPT-4, Claude) | **OpenAI**, **Anthropic** direct |
| GPU instances with SSH access | **Lambda Labs**, **RunPod** |
| Multi-cloud orchestration | **SkyPilot** |


## Credential Setup

Credentials are auto-injected by openscience when connected via the dashboard.

```bash
# Verify credentials
[ -n "$FIREWORKS_API_KEY" ] && echo "FIREWORKS_API_KEY set" || echo "NOT SET"
```

If not set: connect Fireworks AI at https://app.syntheticsciences.ai -> Services, then restart openscience.

## Quick Start

### Install

```python
pip install fireworks-ai openai
```

### Set API key

```python
import os
os.environ["FIREWORKS_API_KEY"] = "fw_..."  # from https://fireworks.ai/api-keys
```

### Basic chat completion

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://api.fireworks.ai/inference/v1",
    api_key=os.environ["FIREWORKS_API_KEY"],
)

response = client.chat.completions.create(
    model="accounts/fireworks/models/llama-v3p3-70b-instruct",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Explain gradient descent in two sentences."},
    ],
    max_tokens=256,
    temperature=0.7,
)
print(response.choices[0].message.content)
```

## Inference

### Chat completions

**Endpoint:** `POST https://api.fireworks.ai/inference/v1/chat/completions`

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://api.fireworks.ai/inference/v1",
    api_key=os.environ["FIREWORKS_API_KEY"],
)

response = client.chat.completions.create(
    model="accounts/fireworks/models/llama-v3p3-70b-instruct",
    messages=[
        {"role": "user", "content": "Write a Python quicksort function."},
    ],
    max_tokens=512,
    temperature=0.0,
)
print(response.choices[0].message.content)
```

### Streaming

```python
stream = client.chat.completions.create(
    model="accounts/fireworks/models/llama-v3p3-70b-instruct",
    messages=[{"role": "user", "content": "Explain transformers."}],
    stream=True,
    max_tokens=512,
)
for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
```

### Function calling / tool use

```python
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get current weather for a location",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string", "description": "City name"},
                    "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]},
                },
                "required": ["location"],
            },
        },
    }
]

response = client.chat.completions.create(
    model="accounts/fireworks/models/llama-v3p3-70b-instruct",
    messages=[{"role": "user", "content": "What is the weather in San Francisco?"}],
    tools=tools,
    tool_choice="auto",
)
tool_call = response.choices[0].message.tool_calls[0]
print(tool_call.function.name, tool_call.function.arguments)
```

### Structured output / JSON mode

```python
response = client.chat.completions.create(
    model="accounts/fireworks/models/llama-v3p3-70b-instruct",
    messages=[{"role": "user", "content": "List 3 planets with mass and diameter."}],
    response_format={"type": "json_object"},
    max_tokens=512,
)
import json
data = json.loads(response.choices[0].message.content)
```

For strict schema enforcement, use `response_format` with a JSON schema:

```python
response = client.chat.completions.create(
    model="accounts/fireworks/models/llama-v3p3-70b-instruct",
    messages=[{"role": "user", "content": "Extract name and age from: John is 30."}],
    response_format={
        "type": "json_object",
        "schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "age": {"type": "integer"},
            },
            "required": ["name", "age"],
        },
    },
)
```

### Vision (multimodal)

```python
response = client.chat.completions.create(
    model="accounts/fireworks/models/llama-v3p2-11b-vision-instruct",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Describe this image."},
                {
                    "type": "image_url",
                    "image_url": {"url": "https://example.com/photo.jpg"},
                },
            ],
        }
    ],
    max_tokens=256,
)
print(response.choices[0].message.content)
```

## Fine-Tuning

Fireworks supports three fine-tuning methods: Supervised Fine-Tuning (SFT), Direct Preference Optimization (DPO), and Reinforcement Fine-Tuning (RL). All use LoRA adapters by default.

### SFT -- Supervised Fine-Tuning

**Data format (JSONL):** Each line is a conversation with `messages` array:

```json
{"messages": [{"role": "system", "content": "You are a coding assistant."}, {"role": "user", "content": "Write a Python hello world."}, {"role": "assistant", "content": "print('Hello, world!')"}]}
{"messages": [{"role": "user", "content": "What is 2+2?"}, {"role": "assistant", "content": "4"}]}
```

**Create SFT job via API:**

```python
import requests

url = "https://api.fireworks.ai/v1/accounts/{account_id}/supervisedFineTuningJobs"
headers = {
    "Authorization": f"Bearer {os.environ['FIREWORKS_API_KEY']}",
    "Content-Type": "application/json",
}
payload = {
    "displayName": "my-sft-job",
    "model": "accounts/fireworks/models/llama-v3p3-70b-instruct",
    "dataset": "accounts/{account_id}/datasets/{dataset_id}",
    "hyperparameters": {
        "epochs": 3,
        "learning_rate": 1e-4,
        "batch_size": 8,
        "lora_rank": 16,
    },
}
response = requests.post(url, headers=headers, json=payload)
job = response.json()
print(f"Job ID: {job['name']}")
```

**Monitor job:**

```python
job_url = f"https://api.fireworks.ai/v1/{job['name']}"
status = requests.get(job_url, headers=headers).json()
print(f"State: {status['state']}, Progress: {status.get('progress', 'N/A')}")
```

### DPO -- Direct Preference Optimization

**Data format (JSONL):** Each line has `chosen` and `rejected` conversations:

```json
{"chosen": [{"role": "user", "content": "Explain ML"}, {"role": "assistant", "content": "Machine learning is..."}], "rejected": [{"role": "user", "content": "Explain ML"}, {"role": "assistant", "content": "ML is complicated..."}]}
```

**Create DPO job:**

```python
url = "https://api.fireworks.ai/v1/accounts/{account_id}/dpoFineTuningJobs"
payload = {
    "displayName": "my-dpo-job",
    "model": "accounts/fireworks/models/llama-v3p3-70b-instruct",
    "dataset": "accounts/{account_id}/datasets/{dataset_id}",
    "hyperparameters": {
        "epochs": 2,
        "learning_rate": 5e-5,
        "beta": 0.1,
    },
}
response = requests.post(url, headers=headers, json=payload)
```

### RL -- Reinforcement Fine-Tuning

Reinforcement fine-tuning uses a reward model or reward function to optimize the base model. Jobs run on on-demand GPUs and are billed at GPU-hour rates.

**Create RL job:**

```python
url = "https://api.fireworks.ai/v1/accounts/{account_id}/reinforcementFineTuningJobs"
payload = {
    "displayName": "my-rl-job",
    "baseModel": "accounts/fireworks/models/llama-v3p3-70b-instruct",
    "rewardModel": "accounts/{account_id}/models/{reward_model_id}",
    "dataset": "accounts/{account_id}/datasets/{dataset_id}",
}
response = requests.post(url, headers=headers, json=payload)
```

### Fine-tuning pricing

| Model Size | SFT ($/hr) | DPO ($/hr) |
|------------|------------|------------|
| Up to 16B  | $0.50      | $1.00      |
| 16B - 80B  | $3.00      | $6.00      |
| 80B - 300B | $6.00      | $12.00     |
| 300B+      | $10.00     | $20.00     |

RL fine-tuning is billed at on-demand GPU rates.

## On-Demand GPU Deployments

Dedicated GPU deployments provide predictable latency, no rate limits, and support for custom/fine-tuned models. Billed per GPU-second.

### Create deployment

```python
import requests

url = "https://api.fireworks.ai/v1/accounts/{account_id}/deployments"
headers = {
    "Authorization": f"Bearer {os.environ['FIREWORKS_API_KEY']}",
    "Content-Type": "application/json",
}
payload = {
    "displayName": "my-llama-deployment",
    "model": "accounts/fireworks/models/llama-v3p3-70b-instruct",
    "deploymentShape": "fast",  # Options: fast, throughput, minimal
    "minReplicaCount": 1,
    "maxReplicaCount": 4,
}
response = requests.post(url, headers=headers, json=payload)
deployment = response.json()
```

### Deployment shapes

| Shape | Optimized For | Use Case |
|-------|---------------|----------|
| `fast` | Lowest latency | Real-time chat, interactive apps |
| `throughput` | Maximum tokens/sec | Batch processing, high volume |
| `minimal` | Lowest cost | Development, testing |

### GPU options and pricing

| GPU | VRAM | Price/GPU/hr |
|-----|------|--------------|
| A100 80GB | 80 GB | $2.90 |
| H100 80GB | 80 GB | $4.00 |
| H200 141GB | 141 GB | $6.00 |
| B200 180GB | 180 GB | $9.00 |

### Manage deployments

```python
# List deployments
deployments = requests.get(
    f"https://api.fireworks.ai/v1/accounts/{{account_id}}/deployments",
    headers=headers,
).json()

# Scale deployment
requests.patch(
    f"https://api.fireworks.ai/v1/{deployment['name']}",
    headers=headers,
    json={"minReplicaCount": 2, "maxReplicaCount": 8},
)

# Delete deployment
requests.delete(
    f"https://api.fireworks.ai/v1/{deployment['name']}",
    headers=headers,
)
```

### Query your deployment

Once deployed, query using the same OpenAI-compatible API but with your deployment's model ID:

```python
response = client.chat.completions.create(
    model="accounts/{account_id}/deployments/{deployment_id}",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

## Embeddings

**Endpoint:** `POST https://api.fireworks.ai/inference/v1/embeddings`

### Supported embedding models

| Model ID | Dimensions |
|----------|------------|
| `nomic-ai/nomic-embed-text-v1.5` | 768 |
| `nomic-ai/nomic-embed-text-v1` | 768 |
| `thenlper/gte-large` | 1024 |
| `WhereIsAI/UAE-Large-V1` | 1024 |

### Generate embeddings

```python
response = client.embeddings.create(
    model="nomic-ai/nomic-embed-text-v1.5",
    input=["Machine learning is a subset of AI.", "Deep learning uses neural networks."],
)
for i, emb in enumerate(response.data):
    print(f"Embedding {i}: {len(emb.embedding)} dimensions")
```

## Model Selection

### Popular serverless models

| Model | Model ID | Params | Context | Tier |
|-------|----------|--------|---------|------|
| Llama 3.3 70B Instruct | `accounts/fireworks/models/llama-v3p3-70b-instruct` | 70B | 131K | >16B |
| Llama 3.2 11B Vision | `accounts/fireworks/models/llama-v3p2-11b-vision-instruct` | 11B | 128K | 4-16B |
| Llama 3.2 3B Instruct | `accounts/fireworks/models/llama-v3p2-3b-instruct` | 3B | 128K | <4B |
| Qwen 2.5 72B Instruct | `accounts/fireworks/models/qwen2p5-72b-instruct` | 72B | 32K | >16B |
| Qwen3 Coder 480B A35B | `accounts/fireworks/models/qwen3-coder-480b-a35b-instruct` | 480B (35B active) | 262K | MoE |
| DeepSeek V3 | `accounts/fireworks/models/deepseek-v3-0324` | 671B (37B active) | 164K | MoE |
| Mixtral 8x7B Instruct | `accounts/fireworks/models/mixtral-8x7b-instruct` | 46B (12B active) | 32K | MoE 0-56B |
| Mixtral 8x22B Instruct | `accounts/fireworks/models/mixtral-8x22b-instruct` | 141B (39B active) | 65K | MoE 56-176B |

### Serverless pricing by tier

| Tier | Price per 1M tokens |
|------|---------------------|
| < 4B params | $0.10 |
| 4B - 16B params | $0.20 |
| > 16B params | $0.90 |
| MoE 0 - 56B params | $0.50 |
| MoE 56B - 176B params | $1.20 |

### Model selection guide

| Use Case | Recommended Model |
|----------|-------------------|
| General chat / instruction following | `llama-v3p3-70b-instruct` |
| Code generation | `qwen3-coder-480b-a35b-instruct` |
| Vision / multimodal | `llama-v3p2-11b-vision-instruct` |
| Cost-sensitive workloads | `llama-v3p2-3b-instruct` |
| Reasoning / complex tasks | `deepseek-v3-0324` |
| Fast MoE inference | `mixtral-8x7b-instruct` |

## CLI (firectl)

### Installation

```bash
# macOS / Linux (Homebrew)
brew tap fw-ai/firectl && brew install firectl

# Install script
curl -sSL https://cli.fireworks.ai/install.sh | bash

# Windows (Chocolatey)
choco install firectl

# Verify
firectl version

# Upgrade
firectl upgrade
```

### Authentication

```bash
firectl signin      # Interactive login
firectl whoami      # Show current account
```

### Model management

```bash
# Upload a custom model
firectl model create my-model /path/to/model/weights

# List models
firectl model list

# Get model details
firectl model get accounts/{account_id}/models/my-model

# Delete model
firectl model delete accounts/{account_id}/models/my-model
```

### Deployment management

```bash
# Create on-demand deployment
firectl deployment create accounts/fireworks/models/llama-v3p3-70b-instruct \
    --display-name "prod-llama"

# List deployments
firectl deployment list

# Scale deployment
firectl deployment scale {deployment_id} \
    --min-replica-count 2 --max-replica-count 8

# Delete deployment
firectl deployment delete {deployment_id}
```

### Fine-tuning via CLI

```bash
# Create SFT job
firectl supervised-fine-tuning-job create my-sft-job \
    --model accounts/fireworks/models/llama-v3p3-70b-instruct \
    --dataset accounts/{account_id}/datasets/my-dataset

# Create RL fine-tuning job
firectl reinforcement-fine-tuning-job create my-rl-job \
    --base-model accounts/fireworks/models/llama-v3p3-70b-instruct \
    --reward-model accounts/{account_id}/models/my-reward-model

# Monitor jobs
firectl fine-tuning-job list
firectl fine-tuning-job get my-sft-job

# Stop / resume
firectl fine-tuning-job stop my-sft-job
firectl fine-tuning-job resume my-sft-job
```

## OpenAI Compatibility

Fireworks AI is a drop-in replacement for the OpenAI Python SDK. Change `base_url` and `api_key` -- all existing code works unchanged.

### Using the OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://api.fireworks.ai/inference/v1",
    api_key=os.environ["FIREWORKS_API_KEY"],
)

# Chat completions -- same API as OpenAI
response = client.chat.completions.create(
    model="accounts/fireworks/models/llama-v3p3-70b-instruct",
    messages=[{"role": "user", "content": "Hello!"}],
)

# Streaming -- same API
stream = client.chat.completions.create(
    model="accounts/fireworks/models/llama-v3p3-70b-instruct",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)

# Embeddings -- same API
embeddings = client.embeddings.create(
    model="nomic-ai/nomic-embed-text-v1.5",
    input=["text to embed"],
)
```

### Environment variable approach

```bash
export OPENAI_API_BASE="https://api.fireworks.ai/inference/v1"
export OPENAI_API_KEY="fw_..."
```

Then use the OpenAI SDK without any code changes.

### Fireworks-specific parameters

Fireworks adds `context_length_exceeded_behavior` to control what happens when `prompt + max_tokens` exceeds the model's context window:

```python
response = client.chat.completions.create(
    model="accounts/fireworks/models/llama-v3p3-70b-instruct",
    messages=[{"role": "user", "content": "..."}],
    max_tokens=512,
    extra_body={"context_length_exceeded_behavior": "truncate"},  # or "error"
)
```

### Using the native Fireworks SDK

```python
import fireworks.client

fireworks.client.api_key = os.environ["FIREWORKS_API_KEY"]

response = fireworks.client.ChatCompletion.create(
    model="accounts/fireworks/models/llama-v3p3-70b-instruct",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

## Cost Optimization

### Prompt caching

Fireworks automatically caches repeated prompt prefixes. No configuration needed -- identical prefixes across requests reuse cached KV states, reducing both latency and cost.

Best practices for prompt caching:
- Place static system prompts at the beginning of messages
- Keep dynamic content at the end
- Use consistent system prompts across requests

### Batch inference

Batch API provides up to 50% cost savings for non-latency-sensitive workloads:

```python
# Prepare batch file (JSONL)
# Each line: {"custom_id": "req-1", "method": "POST", "url": "/v1/chat/completions", "body": {...}}

# Upload batch file
batch_file = client.files.create(
    file=open("batch_requests.jsonl", "rb"),
    purpose="batch",
)

# Create batch job
batch = client.batches.create(
    input_file_id=batch_file.id,
    endpoint="/v1/chat/completions",
    completion_window="24h",
)
print(f"Batch ID: {batch.id}, Status: {batch.status}")

# Check status
batch_status = client.batches.retrieve(batch.id)
print(f"Status: {batch_status.status}")
```

### Cost reduction strategies

| Strategy | Savings | How |
|----------|---------|-----|
| Use smaller models | 50-90% | `llama-v3p2-3b-instruct` at $0.10/M tokens vs 70B at $0.90/M |
| Batch API | ~50% | Async processing for non-real-time workloads |
| Prompt caching | 20-40% | Consistent system prompts, static prefixes |
| MoE models | 30-50% | Mixtral/DeepSeek: large capacity, smaller active params |
| On-demand deployments | Variable | Predictable pricing at scale, no per-token markup |
| Reduce max_tokens | 10-30% | Set realistic output limits |

## Common Issues

| Problem | Solution |
|---------|----------|
| `401 Unauthorized` | Check `FIREWORKS_API_KEY` is set and valid. Get key from https://fireworks.ai/api-keys |
| `Model not found` | Use full model ID: `accounts/fireworks/models/{model_name}` |
| `Context length exceeded` | Reduce input or set `context_length_exceeded_behavior: "truncate"` |
| Rate limited (serverless) | Switch to on-demand deployment for no rate limits |
| Slow cold start on deployment | Set `minReplicaCount >= 1` to keep replicas warm |
| Fine-tuning job stuck | Check dataset format matches expected JSONL schema. Use `firectl fine-tuning-job get` |
| Tool calls not working | Use models that support function calling (Llama 3.3, Qwen, DeepSeek V3) |
| JSON mode returns invalid JSON | Use `response_format` with explicit schema for strict enforcement |
| Streaming usage stats missing | Upgrade `openai` SDK to >= 1.6.1. Usage is in the final stream chunk |
| Deployment not scaling | Check `maxReplicaCount` is set high enough. Review deployment shape |

## Resources

- **Documentation**: https://docs.fireworks.ai
- **API Reference**: https://docs.fireworks.ai/api-reference/introduction
- **Dashboard**: https://fireworks.ai/dashboard
- **Model Catalog**: https://fireworks.ai/models
- **Pricing**: https://fireworks.ai/pricing
- **firectl CLI**: https://docs.fireworks.ai/tools-sdks/firectl/firectl
- **OpenAI Compatibility**: https://docs.fireworks.ai/tools-sdks/openai-compatibility
- **Fine-Tuning Guide**: https://docs.fireworks.ai/fine-tuning/fine-tuning-models
- **Cookbook (GitHub)**: https://github.com/fw-ai/cookbook
- **Status Page**: https://status.fireworks.ai
