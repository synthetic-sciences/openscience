---
name: modal-serverless-gpu
description: Serverless GPU cloud platform for ML workloads — inference serving, batch processing, training, web endpoints, sandboxes, and scheduled jobs. Use when you need on-demand GPUs without infrastructure management, deploying models as auto-scaling APIs, running batch jobs, or executing untrusted code in sandboxes.
category: cloud-compute
version: 2.0.0
author: Synthetic Sciences
license: MIT
tags: [Infrastructure, Serverless, GPU, Cloud, Deployment, Modal, Inference, Training, Sandboxes, Web Endpoints]
dependencies: [modal>=0.73.0]
---

# Modal Serverless GPU

Modal is a serverless GPU cloud platform. Everything is Python code — no YAML, no Docker, no Kubernetes. Pay per second, scale to zero, scale to hundreds of GPUs instantly.

This skill provides the decision framework, GPU guide, API reference, and a catalog of 50+ production-ready examples from Modal's official library. For detailed implementations, refer to the example catalog and reference docs below.

## When to Use Modal

**Modal is the RIGHT choice for:**

| Workload | Why Modal |
|----------|-----------|
| **Inference serving** | Auto-scaling endpoints, zero-downtime deploys, sub-second cold starts |
| **Batch processing** | Fan out to 100+ GPUs with `.map()`, pay only for compute time |
| **Web endpoints / APIs** | FastAPI/ASGI/WSGI support, custom domains, streaming |
| **Sandbox execution** | Run untrusted code safely, build coding agents, code interpreters |
| **Scheduled jobs** | Cron/periodic with `modal.Cron` and `modal.Period` |
| **Full-parameter training** | Multi-GPU (up to 8), multi-node clusters (beta) |
| **Custom architectures** | Full control over container images, any framework |
| **Data pipelines** | Parallel processing, S3 mounts, Volume storage |

**Use alternatives instead:**

| Need | Use Instead |
|------|-------------|
| Managed LoRA fine-tuning (no infra) | **Tinker** |
| Hosted RL / agentic post-training | **Prime Intellect Lab** |
| Reserved dedicated instances | **Lambda Labs** |
| Multi-cloud cost optimization | **SkyPilot** |
| Long-running persistent pods | **RunPod** |
| Scientific GPU computing (simulations, MD, Monte Carlo) | **modal-research-gpu** |

## Credential Setup (openscience)

Credentials are auto-injected via OpenScience. Verify before running Modal workloads:

```bash
# Check credentials are set (NEVER echo the actual values)
[ -n "$MODAL_TOKEN_ID" ] && echo "MODAL_TOKEN_ID set" || echo "NOT SET"
[ -n "$MODAL_TOKEN_SECRET" ] && echo "MODAL_TOKEN_SECRET set" || echo "NOT SET"
```

**IMPORTANT**: Always rely on `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` env vars. Do NOT read from `~/.modal.toml`.

If Modal CLI isn't installed: `pip install modal` (no `modal setup` needed — env vars handle auth).

## Quick Reference

| Topic | Reference |
|-------|-----------|
| Example Catalog (50+ examples) | [Examples Catalog](references/examples-catalog.md) |
| Advanced Patterns & openscience Integration | [Advanced Patterns](references/advanced-patterns.md) |
| Troubleshooting | [Troubleshooting](references/troubleshooting.md) |

## Execution Modes

| Command | When to Use |
|---------|-------------|
| `modal run script.py` | Quick jobs that complete in minutes |
| `modal serve script.py` | Development: live reload on code changes, test endpoints locally |
| `modal deploy script.py` | Production: persistent endpoints, scheduled jobs, always-on services |
| `modal deploy` + `Function.lookup().spawn()` | **Long-running training (disconnect-safe)** |

### CRITICAL: Long-Running Training Must Be Disconnect-Safe

**NEVER use `.spawn()` or `.remote()` from `@app.local_entrypoint()` for training runs that take more than a few minutes.** If the local process dies (laptop battery, closed terminal, SSH disconnect), Modal tears down the app context and kills the spawned function.

**The disconnect-safe pattern:**

```python
# train.py — Step 1: Define your training function
import modal

app = modal.App("my-training")
volume = modal.Volume.from_name("training-data", create_if_missing=True)
image = modal.Image.debian_slim(python_version="3.11").uv_pip_install("torch", "transformers")

@app.function(gpu="H100", image=image, volumes={"/data": volume}, timeout=86400)
def train():
    # Your training code here — runs entirely in Modal's cloud
    ...
    volume.commit()  # Save checkpoints
```

```bash
# Step 2: Deploy the app (persists independently of your machine)
modal deploy train.py

# Step 3: Trigger training (fire-and-forget, survives local disconnect)
python -c "import modal; modal.Function.lookup('my-training', 'train').spawn()"

# Step 4: Monitor from anywhere (even a different machine)
modal app logs my-training
```

This pattern ensures training runs are completely decoupled from your local machine. The function runs on Modal's infrastructure and persists even if you close your laptop, lose internet, or reboot.

## GPU Selection Guide

| GPU | VRAM | $/hr (approx) | Best For |
|-----|------|----------------|----------|
| `T4` | 16GB | ~$0.59 | Budget inference, small models (<7B quantized) |
| `L4` | 24GB | ~$0.73 | Inference, Ada Lovelace architecture |
| `A10G` | 24GB | ~$1.10 | Training/inference, 3.3x faster than T4 |
| `L40S` | 48GB | ~$1.65 | **Best cost/perf for inference** (7B-13B FP16) |
| `A100-40GB` | 40GB | ~$3.15 | Large model training |
| `A100-80GB` | 80GB | ~$4.05 | Very large models, DeepSpeed |
| `H100` | 80GB | ~$4.25 | Fastest training, FP8 + Transformer Engine |
| `H200` | 141GB | ~$4.95 | Largest VRAM, 4.8TB/s bandwidth |
| `B200` | 192GB | Latest | Blackwell architecture, newest |

**GPU specification patterns:**
```python
@app.function(gpu="A100")           # Single GPU
@app.function(gpu="A100-80GB")      # Specific memory variant
@app.function(gpu="H100:4")         # Multi-GPU (up to 8)
@app.function(gpu=["H100", "A100"]) # Fallback chain (try in order)
@app.function(gpu="any")            # Any available GPU
```

**Recommendations by task:**

| Task | GPU | Config |
|------|-----|--------|
| Serve 7B model (FP16) | `L40S` or `A10G` | Single GPU |
| Serve 70B model (AWQ/GPTQ) | `A100-80GB` or `H100` | Single GPU |
| Serve 70B model (FP16) | `H100:4` or `A100-80GB:4` | Multi-GPU |
| LoRA fine-tune 7B | `A100-40GB` | Single GPU |
| Full fine-tune 7B | `A100-80GB:4` | Multi-GPU |
| Full fine-tune 70B | `H100:8` or multi-node | Multi-GPU/node |
| Batch inference | `L40S` or `A100` | `.map()` fan-out |
| Embedding generation | `T4` or `L4` | `.map()` fan-out |

## Core API Quick Reference

### Key Classes

| Class | Purpose | Key Methods |
|-------|---------|-------------|
| `modal.App` | Container for functions/resources | `.function()`, `.cls()`, `.local_entrypoint()` |
| `modal.Image` | Container image definition | `.debian_slim()`, `.uv_pip_install()`, `.pip_install()`, `.from_registry()`, `.add_local_dir()`, `.run_commands()`, `.env()` |
| `modal.Volume` | Persistent distributed filesystem (2.5 GB/s) | `.from_name()`, `.commit()`, `.reload()` |
| `modal.Secret` | Secure credential injection | `.from_name()`, `.from_dict()`, `.from_dotenv()` |
| `modal.Dict` | Distributed key-value store | `.from_name()`, `.put()`, `.get()`, `.pop()` |
| `modal.Queue` | Distributed FIFO queue | `.from_name()`, `.put()`, `.get()` |
| `modal.Sandbox` | Isolated code execution container | `.create()`, `.exec()`, `.terminate()`, snapshot support |
| `modal.Cls` | Class-based serverless functions | Used via `@app.cls()` decorator |
| `modal.Function` | Serverless function handle | `.remote()`, `.local()`, `.map()`, `.starmap()`, `.lookup()` |
| `modal.CloudBucketMount` | Mount S3/GCS buckets as filesystem | Direct bucket access |
| `modal.Tunnel` | Network tunnel to containers | SSH, HTTP access |
| `modal.Proxy` | Network proxy (beta) | Custom networking |

### Key Decorators

| Decorator | Purpose |
|-----------|---------|
| `@app.function()` | Define a serverless function |
| `@app.cls()` | Define a serverless class |
| `@modal.method()` | Mark class method as remotely callable |
| `@modal.enter()` | Run once at container startup (model loading) |
| `@modal.exit()` | Run at container shutdown (cleanup) |
| `@modal.parameter()` | Typed class parameter |
| `@modal.fastapi_endpoint()` | Expose function as FastAPI endpoint |
| `@modal.asgi_app()` | Expose full ASGI app (FastAPI/Starlette) |
| `@modal.wsgi_app()` | Expose WSGI app (Django/Flask) |
| `@modal.web_server(port)` | Expose arbitrary HTTP server |
| `@modal.batched()` | Dynamic input batching |
| `@modal.concurrent()` | Input concurrency control |

### Scheduling

| Type | Syntax |
|------|--------|
| Cron | `schedule=modal.Cron("0 0 * * *")` (always UTC) |
| Periodic | `schedule=modal.Period(hours=1)` |

## Essential Patterns

### Pattern 1: Model Inference Service

```python
import modal

app = modal.App("inference")
image = modal.Image.debian_slim(python_version="3.11").uv_pip_install(
    "torch", "transformers", "accelerate"
)
volume = modal.Volume.from_name("model-cache", create_if_missing=True)

@app.cls(gpu="L40S", image=image, volumes={"/models": volume},
         container_idle_timeout=300)
class InferenceService:
    @modal.enter()
    def load(self):
        from transformers import pipeline
        self.pipe = pipeline("text-generation", model="/models/my-model", device=0)

    @modal.method()
    def generate(self, prompt: str) -> str:
        return self.pipe(prompt, max_length=512)[0]["generated_text"]
```

### Pattern 2: vLLM Deployment (see Modal example: `llm_inference`)

```python
import modal

app = modal.App("vllm-server")
image = modal.Image.debian_slim(python_version="3.11").uv_pip_install("vllm")
volume = modal.Volume.from_name("model-weights", create_if_missing=True)

@app.function(gpu="H100", image=image, volumes={"/models": volume},
              container_idle_timeout=600, timeout=3600)
@modal.asgi_app()
def serve():
    # See Modal example `llm_inference` for the full implementation
    ...
```

### Pattern 3: Batch Processing with Fan-Out

```python
@app.function(gpu="T4")
def process_item(item):
    return expensive_computation(item)

@app.local_entrypoint()
def main():
    items = list(range(10000))
    results = list(process_item.map(items))  # Fan out to parallel GPUs
```

### Pattern 4: Container Image (use uv for speed)

```python
# Prefer uv_pip_install — 10-50x faster than pip_install
image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install("torch", "transformers", "accelerate", "vllm")
    .add_local_dir("./src", "/app/src")  # Add local code
    .env({"HF_HOME": "/models"})          # Set env vars
)
```

### Pattern 5: Sandbox (Code Execution)

```python
sandbox = modal.Sandbox.create(app=app, image=image, gpu="T4", timeout=300)
process = sandbox.exec("python", "-c", "print('Hello from sandbox')")
print(process.stdout.read())
sandbox.terminate()
```

## Example Catalog (Quick Lookup)

Modal's official example library contains production-ready implementations. Find the right example for your task below, then refer to [Examples Catalog](references/examples-catalog.md) for expanded descriptions and implementation notes.

### LLM Inference & Serving

| Example | Description | Key Features |
|---------|-------------|--------------|
| `llm_inference` | Deploy OpenAI-compatible LLM service | vLLM, H100, streaming, OpenAI API |
| `very_large_models` | Deploy really big LLMs (DeepSeek V3, Kimi-K2) | SGLang, multi-GPU (H200:4-8), 100B+ params |
| `ministral3_inference` | 10x cold start reduction with snapshots | Memory snapshots, fast startup |
| `vllm_throughput` | Optimize tokens/sec batch processing | vLLM, ~30K input tok/s per H100 |
| `sglang_low_latency` | Low-latency inference with SGLang | SGLang, speculative decoding, EAGLE-3 |
| `llama_cpp` | Run GGUF models with llama.cpp | CPU/GPU inference, quantized models |
| `trtllm_latency` | Low-latency with TensorRT-LLM | TensorRT optimization |
| `trtllm_throughput` | High-throughput with TensorRT-LLM | Batch TensorRT inference |

### Training & Fine-Tuning

| Example | Description | Key Features |
|---------|-------------|--------------|
| `grpo_verl` | GRPO math training with verl | RL training, math reasoning |
| `grpo_trl` | GRPO coding training with TRL | RL training, code generation |
| `unsloth_finetune` | Efficient fine-tuning with Unsloth | LoRA, 2x speed, memory efficient |
| `hp_sweep_gpt` | Train SLM with hyperparameter search | Grid search, early stopping |
| `long-training` | Long, resumable training jobs | Checkpointing, Volume, resume |
| `llm-finetuning` | Full LLM fine-tuning pipeline | End-to-end training |
| `flan_t5_finetune` | Fine-tune Flan-T5 | Seq2seq fine-tuning |
| `diffusers_lora_finetune` | Fine-tune Flux with LoRA | Image generation LoRA |

### Multimodal & Vision

| Example | Description | Key Features |
|---------|-------------|--------------|
| `flux` | Serve diffusion models with torch.compile | Image generation, compilation |
| `text_to_image` | Stable Diffusion CLI/API/UI | Text-to-image, Gradio |
| `image_to_image` | Edit images with Flux Kontext | Image-to-image |
| `image_to_video` | Bring images to life with LTX-Video | Video generation |
| `ltx` | Generate video with LTX-Video | Text-to-video |
| `finetune_yolo` | Fine-tune & serve YOLO | Object detection |
| `segment_anything` | Segment Anything Model | Image segmentation |
| `comfyapp` | Run Flux on ComfyUI as API | ComfyUI, workflow API |
| `blender_video` | 3D render farm with Blender | 3D rendering, parallelism |

### Audio & Speech

| Example | Description | Key Features |
|---------|-------------|--------------|
| `llm-voice-chat` | Voice chat with LLMs | Real-time voice, WebSocket |
| `streaming_kyutai_stt` | Transcribe speech with Kyutai STT | Streaming STT, low latency |
| `music-video-gen` | Star in custom music videos | Multi-model pipeline |
| `generate_music` | Make music with ACE-Step | Music generation |
| `chatterbox_tts` | Generate speech with Chatterbox | TTS |
| `batched_whisper` | High-throughput Whisper transcription | Batch ASR, Whisper |
| `fine_tune_asr` | Fine-tune Whisper for new words | ASR fine-tuning |

### Sandboxes & Code Execution

| Example | Description | Key Features |
|---------|-------------|--------------|
| `agent` | Sandbox a LangGraph agent's code | LangGraph, secure GPU sandbox |
| `coding_agent` | Run a background coding agent | Coding agent, sandbox |
| `modal-vibe` | Deploy vibe coding at scale | React + LLM + Sandboxes |
| `safe_code_execution` | Run Node.js, Ruby, and more in sandbox | Multi-language, sandbox |
| `simple_code_interpreter` | Stateful code interpreter | Jupyter-like, sandbox |
| `jupyter_sandbox` | Sandboxed Jupyter notebook | Jupyter, sandbox |
| `anthropic_computer_use` | Control computer with LLM | Computer use, sandbox |

### RAG & Embeddings

| Example | Description | Key Features |
|---------|-------------|--------------|
| `chat_with_pdf_vision` | RAG Chat with PDFs | PDF Q&A, vision |
| `amazon_embeddings` | Embed millions of docs with TEI | High-throughput embeddings |
| `mongodb-search` | Satellite images to vectors + MongoDB | Image embeddings, geo search |
| `potus_speech_qanda` | RAG Q&A chatbot with OpenAI | RAG, OpenAI |

### Web Apps & Endpoints

| Example | Description | Key Features |
|---------|-------------|--------------|
| `basic_web` | Serving web endpoints | FastAPI, ASGI |
| `serve_streamlit` | Deploy Streamlit apps | Streamlit |
| `mcp_server_stateless` | Deploy stateless MCP with FastMCP | MCP, tool serving |
| `webrtc_yolo` | Serverless WebRTC with YOLO | WebRTC, real-time |
| `fastrtc_flip_webcam` | WebRTC quickstart with FastRTC | FastRTC |
| `webscraper` | Simple web scraper | Scraping, parallelism |

### Data & Infrastructure

| Example | Description | Key Features |
|---------|-------------|--------------|
| `s3_bucket_mount` | Parallel Parquet processing on S3 | CloudBucketMount, S3 |
| `cloud_bucket_mount_loras` | LoRA playground with S3 + Gradio | LoRA management, S3 |
| `dbt_duckdb` | Data warehouse with DuckDB + DBT | Analytics, data warehouse |
| `doc_ocr_jobs` | Document OCR job queue | Job queue, OCR |
| `doc_ocr_webapp` | Document OCR web app | Web app, OCR |
| `hackernews_alerts` | Hacker News Slackbot | Scheduled jobs, Slack |
| `discord_bot` | Deploy a Discord bot | Discord, bot |
| `db_to_sheet` | Sync DB to Google Sheets | Google Sheets, ETL |
| `cron_datasette` | Publish data with SQLite + Datasette | Data exploration |
| `algolia_indexer` | Build docsearch with Algolia | Documentation search |

### Computational Biology

| Example | Description | Key Features |
|---------|-------------|--------------|
| `chai1` | Fold proteins with Chai-1 | Protein folding |
| `boltz_predict` | Fold proteins with Boltz-2 | Protein structure |
| `esm3` | ESM3 protein model | Protein language model |

## Common Configuration Reference

```python
@app.function(
    gpu="A100",                        # GPU type (see selection guide)
    memory=32768,                      # RAM in MB
    cpu=4,                             # CPU cores
    timeout=3600,                      # Max execution time (seconds)
    container_idle_timeout=120,        # Keep container warm (seconds)
    retries=modal.Retries(max_retries=3, backoff_coefficient=2.0),
    concurrency_limit=10,              # Max concurrent containers
    allow_concurrent_inputs=20,        # Requests per container
    keep_warm=1,                       # Min warm containers (costs money)
    volumes={"/data": volume},         # Mount volumes
    secrets=[modal.Secret.from_name("my-secret")],
    image=image,                       # Custom container image
    schedule=modal.Cron("0 0 * * *"), # Cron schedule (UTC)
)
def my_function():
    pass
```

## Common Issues Quick-Fix

| Issue | Fix |
|-------|-----|
| **Training dies when laptop closes** | **NEVER use `.spawn()`/`.remote()` from `local_entrypoint()` for long jobs. Use `modal deploy` + `Function.lookup().spawn()` pattern (see Execution Modes above)** |
| Cold start slow | Use `@modal.enter()` for model loading, increase `container_idle_timeout`, use memory snapshots |
| GPU OOM | Use larger GPU, enable gradient checkpointing, use mixed precision (bf16) |
| Image build fails | Pin versions, use `uv_pip_install`, use multi-stage builds |
| Timeout errors | Increase `timeout`, add checkpointing for long jobs |
| Volume changes lost | Call `volume.commit()` after writes |
| Stale volume data | Call `volume.reload()` before reads |
| Cron not firing | Cron is always UTC, must `modal deploy` (not `modal run`) |
| 502 on endpoint | Increase timeout, check memory, use streaming for long responses |
| Credentials fail | Verify `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` env vars are set |

## Implementation Workflow

When implementing a Modal workload:
1. Check the example catalog above to find the closest matching example
2. Load the [Examples Catalog](references/examples-catalog.md) for expanded implementation notes
3. Refer to Modal's docs at https://modal.com/docs/examples for full source code
4. Adapt for your use case using openscience credentials (`MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`)
5. After job completes, report usage via `OpenScience.reportUsage()` with `service="modal"`
