---
name: groq-inference
description: Ultra-fast LLM inference on custom LPU hardware. OpenAI-compatible API at api.groq.com. Lowest latency in the industry (500-1000+ tok/s). Supports chat completions, vision, audio (Whisper STT + TTS), tool calling, JSON mode, and streaming. Free tier available. Inference only — no training.
category: ml-inference
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Inference, Groq, LPU, Low-Latency, OpenAI-Compatible, Free-Tier]
dependencies: [groq, openai]
---

# Groq — Ultra-Fast LLM Inference

Groq runs open-weight LLMs on custom LPU (Language Processing Unit) hardware, delivering the lowest inference latency in the industry — up to 1000+ tokens/sec. OpenAI-compatible API, free tier, pay-per-token pricing. Inference only, no training.

## When to Use Groq

**Use when:**
- You need the fastest possible inference latency (real-time chat, agents, interactive apps)
- You want open-weight models (Llama, Qwen, DeepSeek) without managing GPUs
- You need an OpenAI-compatible drop-in replacement with open models
- You want free-tier access for prototyping
- You need fast Whisper transcription or vision with Llama 4

**Don't use when:**
- You need to fine-tune or train models (inference-only)
- You need proprietary models (GPT-4o, Claude, Gemini)
- You need embeddings or image generation APIs (not offered)

| Feature | Groq | Together AI | Fireworks | Replicate |
|---------|------|-------------|-----------|-----------|
| Hardware | Custom LPU | NVIDIA GPUs | NVIDIA GPUs | NVIDIA GPUs |
| Speed (Llama 70B) | ~280 tok/s | ~100 tok/s | ~100 tok/s | ~50 tok/s |
| Free tier | Yes | Yes | Yes | No |
| Training | No | Yes | Yes | Yes |


## Credential Setup

Credentials are auto-injected by openscience when connected via the dashboard.

```bash
# Verify credentials
[ -n "$GROQ_API_KEY" ] && echo "GROQ_API_KEY set" || echo "NOT SET"
```

If not set: connect Groq at https://app.syntheticsciences.ai -> Services, then restart openscience.

## Quick Start

```bash
pip install groq
export GROQ_API_KEY="gsk_..."   # https://console.groq.com/keys
```

```python
from groq import Groq

client = Groq()
response = client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Explain quantum computing in one paragraph."}
    ],
    temperature=0.7,
    max_completion_tokens=512,
)
print(response.choices[0].message.content)
```

## Chat Completions

### Streaming

```python
from groq import Groq

client = Groq()
stream = client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=[{"role": "user", "content": "Explain fast inference"}],
    stream=True,
)
for chunk in stream:
    content = chunk.choices[0].delta.content
    if content:
        print(content, end="")
```

### JSON Mode

```python
from groq import Groq
import json

client = Groq()
response = client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=[
        {"role": "system", "content": "Output valid JSON only."},
        {"role": "user", "content": "List 3 programming languages with their paradigms."}
    ],
    response_format={"type": "json_object"},
    temperature=0,
)
data = json.loads(response.choices[0].message.content)
```

### Tool / Function Calling

```python
from groq import Groq
import json

client = Groq()
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get weather for a location",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {"type": "string", "description": "City name"},
                "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
            },
            "required": ["location"],
            "additionalProperties": False
        }
    }
}]

response = client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=[{"role": "user", "content": "Weather in San Francisco?"}],
    tools=tools,
    tool_choice="auto",
)

message = response.choices[0].message
if message.tool_calls:
    call = message.tool_calls[0]
    args = json.loads(call.function.arguments)
    # Execute function, then send result back as role="tool" message
    result = {"temperature": 62, "condition": "foggy"}
    followup = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "user", "content": "Weather in San Francisco?"},
            message,
            {"role": "tool", "tool_call_id": call.id, "content": json.dumps(result)}
        ],
    )
    print(followup.choices[0].message.content)
```

## Vision

Llama 4 models support image input via URL or base64. Max image size: 20 MB.

```python
from groq import Groq

client = Groq()
response = client.chat.completions.create(
    model="meta-llama/llama-4-scout-17b-16e-instruct",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "Describe this image."},
            {"type": "image_url", "image_url": {"url": "https://example.com/photo.jpg"}}
        ]
    }],
    max_completion_tokens=1024,
)
print(response.choices[0].message.content)
```

Vision models: `meta-llama/llama-4-scout-17b-16e-instruct`, `meta-llama/llama-4-maverick-17b-128e-instruct`.

## Audio / Speech-to-Text

Whisper on LPU for near-instant transcription. Formats: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm. Max: 25 MB free / 100 MB developer tier.

```python
from groq import Groq

client = Groq()

# Transcription
with open("audio.mp3", "rb") as f:
    result = client.audio.transcriptions.create(
        file=("audio.mp3", f),
        model="whisper-large-v3-turbo",
        language="en",
        response_format="verbose_json",
    )
print(result.text)

# Translation (any language -> English)
with open("french.mp3", "rb") as f:
    result = client.audio.translations.create(
        file=("french.mp3", f), model="whisper-large-v3",
    )
print(result.text)
```

### Text-to-Speech

```python
from groq import Groq
from pathlib import Path

client = Groq()
speech = client.audio.speech.create(
    model="playai-tts",
    voice="Arista-PlayAI",
    input="Hello from Groq!",
)
Path("output.mp3").write_bytes(speech.content)
```

## Model Selection

### Production Models

| Model | Model ID | Speed | Context | Max Output | Input $/1M | Output $/1M |
|-------|----------|-------|---------|------------|------------|-------------|
| Llama 3.1 8B | `llama-3.1-8b-instant` | 560 t/s | 131,072 | 131,072 | $0.05 | $0.08 |
| Llama 3.3 70B | `llama-3.3-70b-versatile` | 280 t/s | 131,072 | 32,768 | $0.59 | $0.79 |
| GPT-OSS 120B | `openai/gpt-oss-120b` | 500 t/s | 131,072 | 65,536 | $0.15 | $0.60 |
| GPT-OSS 20B | `openai/gpt-oss-20b` | 1000 t/s | 131,072 | 65,536 | $0.075 | $0.30 |
| Whisper V3 | `whisper-large-v3` | - | - | - | $0.111/hr | - |
| Whisper V3 Turbo | `whisper-large-v3-turbo` | - | - | - | $0.04/hr | - |

### Preview Models

| Model | Model ID | Speed | Context | Input $/1M | Output $/1M |
|-------|----------|-------|---------|------------|-------------|
| Llama 4 Scout | `meta-llama/llama-4-scout-17b-16e-instruct` | 750 t/s | 131,072 | $0.11 | $0.34 |
| Llama 4 Maverick | `meta-llama/llama-4-maverick-17b-128e-instruct` | 600 t/s | 131,072 | $0.20 | $0.60 |
| Qwen3 32B | `qwen/qwen3-32b` | 400 t/s | 131,072 | $0.29 | $0.59 |
| Kimi K2 | `moonshotai/kimi-k2-instruct-0905` | 200 t/s | 262,144 | $1.00 | $3.00 |
| Safety GPT-OSS 20B | `openai/gpt-oss-safeguard-20b` | 1000 t/s | 131,072 | $0.075 | $0.30 |
| Llama Guard 4 12B | `meta-llama/llama-guard-4-12b` | - | 131,072 | $0.20 | $0.20 |

### Systems & TTS

| Model | Model ID | Notes |
|-------|----------|-------|
| Compound | `groq/compound` | Agentic: web search + code exec |
| Compound Mini | `groq/compound-mini` | Lighter agentic system |
| PlayAI TTS | `playai-tts` | $22/1M chars |
| Orpheus English | `canopylabs/orpheus-v1-english` | $22/1M chars |

### Selection Guide

- **Fastest + cheapest**: `llama-3.1-8b-instant` — classification, extraction, simple tasks
- **Best quality**: `llama-3.3-70b-versatile` — complex reasoning, coding, chat
- **Best value**: `openai/gpt-oss-120b` — strong quality, 500 t/s, $0.15 input
- **Vision**: `meta-llama/llama-4-scout-17b-16e-instruct` — 750 t/s, cheapest multimodal
- **Long context**: `moonshotai/kimi-k2-instruct-0905` — 262K context window
- **Safety**: `meta-llama/llama-guard-4-12b` or `openai/gpt-oss-safeguard-20b`

## OpenAI Compatibility

Drop-in replacement — change `base_url` and `api_key`:

```python
from openai import OpenAI
import os

client = OpenAI(
    base_url="https://api.groq.com/openai/v1",
    api_key=os.environ.get("GROQ_API_KEY"),
)
response = client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=[{"role": "user", "content": "Hello from OpenAI SDK!"}],
)
print(response.choices[0].message.content)
```

| Endpoint | Supported | Notes |
|----------|-----------|-------|
| `POST /chat/completions` | Yes | Streaming, tools, JSON mode |
| `POST /audio/transcriptions` | Yes | Whisper |
| `POST /audio/translations` | Yes | Whisper |
| `POST /audio/speech` | Yes | TTS |
| `GET /models` | Yes | List models |
| `POST /embeddings` | No | Not available |
| `POST /images/generations` | No | Not available |

**Unsupported fields** (400 error): `logprobs`, `logit_bias`, `top_logprobs`, `messages[].name`, `n` (must be 1).

## Rate Limits

| Tier | Price | RPM | TPM | TPD |
|------|-------|-----|-----|-----|
| Free | $0 | 30 | 6,000 | 500,000 |
| Developer | Pay-per-token | Up to 1,000 | Up to 300,000 | Unlimited |

Rate limit headers returned with every response: `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`.

```python
import time
from groq import Groq, RateLimitError

client = Groq()

def call_with_retry(messages, model="llama-3.3-70b-versatile", max_retries=3):
    for attempt in range(max_retries):
        try:
            return client.chat.completions.create(model=model, messages=messages)
        except RateLimitError:
            if attempt == max_retries - 1:
                raise
            time.sleep(2 ** attempt)
```

## Cost Optimization

1. **Use the smallest model that works.** `llama-3.1-8b-instant` is 10x cheaper than the 70B for simple tasks.
2. **Cap output with `max_completion_tokens`.** Output tokens cost more than input.
3. **Try `openai/gpt-oss-20b`** — best price/performance at $0.075 input and 1000 t/s.
4. **Cache at `temperature=0`.** Deterministic output means identical prompts yield identical results.
5. **Use Whisper Turbo.** `whisper-large-v3-turbo` is 64% cheaper than v3 with minimal quality loss.
6. **Preprocess audio** to 16KHz mono WAV to reduce upload size.

## Common Issues

| Problem | Solution |
|---------|----------|
| `401 Unauthorized` | Check `GROQ_API_KEY`. Get key at https://console.groq.com/keys |
| `400 Bad Request` | Remove unsupported fields: `logprobs`, `logit_bias`, `top_logprobs` |
| `429 Rate Limited` | Exponential backoff. Upgrade to developer tier for 10x limits |
| Empty stream chunks | Check `chunk.choices[0].delta.content` for `None` |
| Invalid JSON output | Add "Output valid JSON only" to system prompt, set `temperature=0` |
| Tool calls missing | Not all models support tools. Use Llama 3.3 70B or GPT-OSS |
| Audio too large | Free: 25 MB max. Use `url` param or upgrade to dev tier (100 MB) |
| Vision fails | Only Llama 4 models support vision. Max 20 MB |
| `n` param error | Groq only supports `n=1` |
| `max_tokens` warning | Use `max_completion_tokens` instead |

## Resources

- **API Docs**: https://console.groq.com/docs/overview
- **Models**: https://console.groq.com/docs/models
- **API Keys**: https://console.groq.com/keys
- **Pricing**: https://groq.com/pricing
- **Rate Limits**: https://console.groq.com/docs/rate-limits
- **OpenAI Compat**: https://console.groq.com/docs/openai
- **Tool Use**: https://console.groq.com/docs/tool-use/local-tool-calling
- **Vision**: https://console.groq.com/docs/vision
- **Speech-to-Text**: https://console.groq.com/docs/speech-to-text
- **Structured Outputs**: https://console.groq.com/docs/structured-outputs
- **Python SDK**: https://github.com/groq/groq-python (`pip install groq`)
- **Status**: https://status.groq.com
- **LPU Architecture**: https://groq.com/blog/inside-the-lpu-deconstructing-groq-speed
