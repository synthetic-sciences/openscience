# Modal Advanced Patterns

Advanced patterns for Modal including disconnect-safe training, multi-node training, distributed primitives, sandbox workflows, memory snapshots, and integration with openscience/other skills.

## Disconnect-Safe Training (CRITICAL)

**Problem:** When you launch training via `@app.local_entrypoint()` using `.spawn()` or `.remote()`, the training run is tied to your local process. If the local process dies — laptop battery, closed terminal, SSH disconnect, or coding agent crash — Modal tears down the app context and **kills the training function**, even if it was running in Modal's cloud.

**This is the #1 cause of lost training runs.** Always use the disconnect-safe pattern for any job that takes more than a few minutes.

### Anti-Pattern (DO NOT USE for long training)

```python
# BAD — training dies if local process dies
@app.local_entrypoint()
def main():
    train.spawn()  # DANGER: tied to this process
    # or: train.remote()  # DANGER: also tied
```

### Correct Pattern: Deploy + Lookup + Spawn

```python
# train.py — define training function (NO local_entrypoint needed)
import modal

app = modal.App("grpo-training")
vol = modal.Volume.from_name("training-checkpoints", create_if_missing=True)
image = modal.Image.debian_slim(python_version="3.11").uv_pip_install(
    "torch", "transformers", "trl", "datasets"
)

@app.function(gpu="H100:4", image=image, volumes={"/checkpoints": vol}, timeout=86400)
def train(config: dict = None):
    """Training function — runs entirely in Modal cloud, no local dependency."""
    config = config or {}
    # ... training code ...
    vol.commit()  # Save checkpoints
    return {"status": "complete", "checkpoints": "/checkpoints/final"}
```

```bash
# Step 1: Deploy the app (one-time, persists independently)
modal deploy train.py

# Step 2: Fire-and-forget launch (survives any local disconnect)
python -c "
import modal
fn = modal.Function.lookup('grpo-training', 'train')
handle = fn.spawn({'lr': 1e-5, 'epochs': 3})
print(f'Launched! Function call ID: {handle.object_id}')
"

# Step 3: Monitor from anywhere (different terminal, different machine)
modal app logs grpo-training

# Step 4: Check results later
python -c "
import modal
fn = modal.Function.lookup('grpo-training', 'train')
# Get result from a specific call if you saved the ID
# Or just check the Volume for checkpoints
"
```

### Quick Helper Script

For convenience, create a `launch.py` alongside your training script:

```python
# launch.py — fire-and-forget launcher
import modal, sys, json

app_name = sys.argv[1]  # e.g., "grpo-training"
fn_name = sys.argv[2]   # e.g., "train"
config = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}

fn = modal.Function.lookup(app_name, fn_name)
handle = fn.spawn(config)
print(f"Training launched! ID: {handle.object_id}")
print(f"Monitor: modal app logs {app_name}")
print("Safe to close this terminal — training runs independently.")
```

```bash
# Usage:
modal deploy train.py
python launch.py grpo-training train '{"lr": 1e-5}'
# Now safe to close everything
```

### When to Use Each Pattern

| Pattern | Safe to Disconnect? | Use For |
|---------|---------------------|---------|
| `modal run script.py` | NO | Quick tests (<5 min) |
| `local_entrypoint()` + `.remote()` | NO | Interactive dev, short jobs |
| `local_entrypoint()` + `.spawn()` | NO | **NEVER for training** |
| `modal deploy` + `Function.lookup().spawn()` | **YES** | Training, batch jobs, anything >5 min |
| `modal deploy` + REST API trigger | **YES** | CI/CD, automated pipelines |

## Multi-Node Training (Beta)

Modal's multi-node clusters enable distributed training across multiple machines with RDMA-enabled networking.

```python
import modal

app = modal.App("multi-node-training")
image = modal.Image.debian_slim(python_version="3.11").uv_pip_install(
    "torch", "transformers", "deepspeed", "accelerate"
)
volume = modal.Volume.from_name("training-checkpoints", create_if_missing=True)

# Multi-node: up to 64 H100 SXM GPUs, 50 Gbps IPv6, 3200 Gbps RDMA
@app.function(
    gpu="H100:8",
    image=image,
    volumes={"/checkpoints": volume},
    timeout=86400,  # 24 hours
    cluster_size=4,  # 4 nodes × 8 GPUs = 32 GPUs total
)
def train_distributed():
    import subprocess
    subprocess.run([
        "accelerate", "launch",
        "--num_machines", "4",
        "--num_processes", "32",
        "--use_deepspeed",
        "train.py"
    ])
    volume.commit()
```

**Multi-node specs:**
- Up to 64 H100 SXM GPUs per cluster
- RDMA-enabled inter-node networking (i6pn)
- 50 Gbps IPv6 private network + 3,200 Gbps RDMA scale-out
- At least 1 TB RAM and 4 TB NVMe SSD per node
- Gang scheduling ensures all nodes start together

**See Modal example `grpo_verl` for a production multi-node GRPO training implementation.**

## Single-Node Multi-GPU Training

### With Accelerate

```python
@app.function(gpu="H100:4", image=image, timeout=7200)
def train_multi_gpu():
    from accelerate import Accelerator
    accelerator = Accelerator()
    model, optimizer, dataloader = accelerator.prepare(model, optimizer, dataloader)
    for batch in dataloader:
        outputs = model(**batch)
        accelerator.backward(outputs.loss)
        optimizer.step()
```

### With DeepSpeed

```python
@app.function(gpu="A100:8", image=image, timeout=14400)
def deepspeed_train():
    from transformers import Trainer, TrainingArguments
    args = TrainingArguments(
        output_dir="/checkpoints",
        deepspeed="ds_config.json",
        bf16=True,
        per_device_train_batch_size=4,
        gradient_accumulation_steps=4,
    )
    trainer = Trainer(model=model, args=args, train_dataset=dataset)
    trainer.train()
```

### DDP Subprocess Pattern

Some frameworks (PyTorch Lightning, DDP) re-execute the entrypoint. Use subprocess:

```python
@app.function(gpu="H100:4")
def train_with_subprocess():
    import subprocess
    subprocess.run(["torchrun", "--nproc_per_node=4", "train.py"])
```

## Memory Snapshots (Near-Zero Cold Starts)

Pre-load models into memory and snapshot the container state for instant startup.

```python
image = modal.Image.debian_slim(python_version="3.11").uv_pip_install(
    "torch", "transformers", "accelerate"
)

@app.cls(
    gpu="L40S",
    image=image,
    enable_memory_snapshot=True,  # Enable snapshots
    container_idle_timeout=300,
)
class FastInference:
    @modal.enter(snap=True)  # Snapshot after this runs
    def load_model(self):
        from transformers import AutoModelForCausalLM, AutoTokenizer
        self.tokenizer = AutoTokenizer.from_pretrained("meta-llama/Llama-3.1-8B")
        self.model = AutoModelForCausalLM.from_pretrained(
            "meta-llama/Llama-3.1-8B", device_map="cuda", torch_dtype="auto"
        )

    @modal.method()
    def generate(self, prompt: str) -> str:
        inputs = self.tokenizer(prompt, return_tensors="pt").to("cuda")
        outputs = self.model.generate(**inputs, max_new_tokens=256)
        return self.tokenizer.decode(outputs[0], skip_special_tokens=True)
```

**See Modal example `ministral3_inference` for a full snapshot implementation.**

## Distributed Primitives

### modal.Dict — Distributed Key-Value Store

```python
results_dict = modal.Dict.from_name("job-results", create_if_missing=True)

@app.function()
def worker(job_id: str, data):
    result = process(data)
    results_dict[job_id] = result  # Write result

@app.function()
def collector(job_ids: list[str]):
    results = {jid: results_dict[jid] for jid in job_ids}
    return results
```

### modal.Queue — Distributed FIFO Queue

```python
task_queue = modal.Queue.from_name("tasks", create_if_missing=True)

@app.function()
def producer():
    for item in data:
        task_queue.put(item)

@app.function()
def consumer():
    while True:
        item = task_queue.get(block=True, timeout=60)
        if item is None:
            break
        process(item)
```

**See Modal example `dicts_and_queues` and `doc_ocr_jobs` for production queue patterns.**

## Advanced Container Images

### Prefer uv (10-50x faster)

```python
# ALWAYS prefer uv_pip_install over pip_install
image = modal.Image.debian_slim(python_version="3.11").uv_pip_install(
    "torch", "transformers", "accelerate", "vllm"
)
```

### Multi-Stage Builds

```python
# Stage 1: Heavy dependencies (cached)
base = modal.Image.debian_slim(python_version="3.11").uv_pip_install(
    "torch", "numpy", "scipy"
)
# Stage 2: ML libraries (cached separately)
ml = base.uv_pip_install("transformers", "datasets", "accelerate")
# Stage 3: Your code (rebuilt on changes)
final = ml.add_local_dir("./src", "/app/src").env({"PYTHONPATH": "/app"})
```

### From Dockerfile / Registry

```python
# Custom Dockerfile
image = modal.Image.from_dockerfile("./Dockerfile")

# Existing registry image
image = modal.Image.from_registry(
    "nvidia/cuda:12.4.0-cudnn9-devel-ubuntu22.04",
    add_python="3.11"
).uv_pip_install("torch", "transformers")

# From Git
image = modal.Image.debian_slim().uv_pip_install(
    "git+https://github.com/vllm-project/vllm.git@main"
)
```

### Setting Environment Variables

```python
image = modal.Image.debian_slim().env({
    "HF_HOME": "/models",
    "CUDA_VISIBLE_DEVICES": "0,1,2,3",
    "PYTHONUNBUFFERED": "1",
})
```

## Advanced Sandbox Patterns

### Sandbox with File Access

```python
sandbox = modal.Sandbox.create(
    app=app,
    image=image,
    gpu="T4",
    timeout=600,
    volumes={"/workspace": volume},
)

# Write files into sandbox
sandbox.open("/workspace/script.py", "w").write("print('hello')")

# Execute code
process = sandbox.exec("python", "/workspace/script.py")
stdout = process.stdout.read()

# Read files back
output = sandbox.open("/workspace/output.txt", "r").read()

sandbox.terminate()
```

### Sandbox Snapshots (Reusable State)

```python
# Create sandbox and install dependencies
sandbox = modal.Sandbox.create(app=app, image=image)
sandbox.exec("pip", "install", "pandas", "scikit-learn")

# Snapshot the state for reuse
snapshot = sandbox.snapshot()

# Create new sandbox from snapshot (instant startup with deps)
new_sandbox = modal.Sandbox.create(app=app, snapshot=snapshot)
```

**See Modal examples: `agent`, `safe_code_execution`, `simple_code_interpreter` for production sandbox patterns.**

## Advanced Class Patterns

### Lifecycle Hooks

```python
@app.cls(gpu="A10G")
class InferenceService:
    @modal.enter()
    def startup(self):
        """Called once when container starts — load models here"""
        self.model = load_model()
        self.tokenizer = load_tokenizer()

    @modal.exit()
    def shutdown(self):
        """Called when container shuts down — cleanup here"""
        cleanup_resources()

    @modal.method()
    def predict(self, text: str):
        return self.model(self.tokenizer(text))
```

### Parameterized Classes

```python
@app.cls(gpu="A100")
class ModelServer:
    model_name: str = modal.parameter()
    temperature: float = modal.parameter(default=0.7)

    @modal.enter()
    def load(self):
        self.model = load_model(self.model_name)

    @modal.method()
    def generate(self, prompt: str) -> str:
        return self.model.generate(prompt, temperature=self.temperature)

# Use with different params
server = ModelServer(model_name="llama-3.1-8b", temperature=0.5)
result = server.generate.remote("Hello")
```

### Input Concurrency vs Dynamic Batching

```python
# Input concurrency: many requests processed in parallel (good for I/O-bound)
@app.function(allow_concurrent_inputs=10)
async def fetch_data(url: str):
    async with aiohttp.ClientSession() as session:
        return await session.get(url)

# Dynamic batching: requests accumulated into batches (good for GPU)
@app.function(gpu="A100")
@modal.batched(max_batch_size=32, wait_ms=100)
async def batch_embed(texts: list[str]) -> list[list[float]]:
    return model.encode(texts)

# @modal.concurrent: explicit concurrency control per container
@app.function(gpu="A100")
@modal.concurrent(max_inputs=5)
async def concurrent_inference(prompt: str) -> str:
    return await model.generate(prompt)
```

## Function Composition & Orchestration

### Pipeline Pattern

```python
@app.function()
def preprocess(data):
    return clean(data)

@app.function(gpu="A100")
def inference(data):
    return model.predict(data)

@app.function()
def postprocess(predictions):
    return format_results(predictions)

@app.local_entrypoint()
def pipeline(raw_data):
    cleaned = preprocess.remote(raw_data)
    predictions = inference.remote(cleaned)
    return postprocess.remote(predictions)
```

### Parallel Fan-Out with `.map()` and `.starmap()`

```python
@app.function(gpu="T4")
def embed_chunk(text: str) -> list[float]:
    return model.encode(text)

@app.local_entrypoint()
def embed_dataset():
    texts = load_texts()  # 1M documents
    # Fan out to 100+ parallel GPUs
    embeddings = list(embed_chunk.map(texts))

# Multiple arguments with starmap
@app.function(gpu="A100")
def train_variant(lr: float, batch_size: int, epochs: int):
    return train(lr=lr, batch_size=batch_size, epochs=epochs)

@app.local_entrypoint()
def hp_sweep():
    configs = [(0.001, 32, 10), (0.0001, 64, 20), (0.01, 16, 5)]
    results = list(train_variant.starmap(configs))
```

### Invoking Deployed Functions

```python
# From any Python script
import modal
f = modal.Function.lookup("my-app", "my_function")
result = f.remote(arg1, arg2)
```

```bash
# Via REST API
curl -X POST https://your-workspace--my-app-predict.modal.run \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world"}'
```

## Advanced Web Endpoints

### Streaming Responses

```python
@app.function(gpu="A100")
def generate_stream(prompt: str):
    for token in model.generate_stream(prompt):
        yield token

@web_app.get("/stream")
async def stream(prompt: str):
    from fastapi.responses import StreamingResponse
    return StreamingResponse(
        generate_stream.remote_gen(prompt),
        media_type="text/event-stream"
    )
```

### WebSocket Support

```python
from fastapi import FastAPI, WebSocket
web_app = FastAPI()

@web_app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    while True:
        data = await websocket.receive_text()
        result = await inference.remote.aio(data)
        await websocket.send_text(result)

@app.function()
@modal.asgi_app()
def ws_app():
    return web_app
```

### Authentication

```python
from fastapi import Depends, HTTPException, Header

async def verify_token(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401)
    token = authorization.split(" ")[1]
    if not verify_jwt(token):
        raise HTTPException(status_code=403)

@web_app.post("/predict")
async def predict(data: dict, _=Depends(verify_token)):
    return model.predict(data)
```

## Cloud Storage

### Volumes (High-Performance Distributed Filesystem)

```python
volume = modal.Volume.from_name("my-vol", create_if_missing=True)

@app.function(volumes={"/data": volume})
def writer():
    with open("/data/output.json", "w") as f:
        json.dump(results, f)
    volume.commit()  # MUST commit to persist

@app.function(volumes={"/data": volume})
def reader():
    volume.reload()  # MUST reload to see external changes
    with open("/data/output.json") as f:
        return json.load(f)
```

### Cloud Bucket Mounts (S3/GCS)

```python
bucket = modal.CloudBucketMount(
    bucket_name="my-training-data",
    secret=modal.Secret.from_name("aws-credentials"),
    read_only=True,
)

@app.function(gpu="A100", volumes={"/s3": bucket})
def train_from_s3():
    dataset = load_dataset("/s3/data/train.parquet")
    # S3 data accessed as local filesystem
```

## Cost Optimization

### GPU Right-Sizing

| Use Case | Recommended GPU | Why |
|----------|----------------|-----|
| Inference ≤13B | `L40S` ($1.65/hr) | Best cost/perf ratio |
| Inference 13-70B quantized | `A100-80GB` ($4.05/hr) | Enough VRAM for AWQ/GPTQ |
| Inference 70B FP16 | `H100:4` | Need multi-GPU for VRAM |
| LoRA training ≤13B | `A100-40GB` ($3.15/hr) | Good balance |
| Full training ≤13B | `A100-80GB:4` | Need VRAM + speed |
| Embedding (batch) | `T4` ($0.59/hr) | Cheapest GPU, use `.map()` |

### Key Cost Strategies

1. **Scale to zero** (default) — no idle costs
2. **GPU fallbacks** — `gpu=["H100", "A100", "L40S"]` for availability + cost
3. **Right-size GPUs** — don't use H100 for embedding
4. **Batch with `.map()`** — fan out to many cheap GPUs vs one expensive GPU
5. **`keep_warm=1`** only for user-facing low-latency endpoints (costs money)

## openscience Integration

### Credential Handling

Modal credentials are injected via OpenScience. The Modal CLI reads `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` from environment automatically.

```bash
# Verify before any Modal workload
[ -n "$MODAL_TOKEN_ID" ] && echo "set" || echo "NOT SET"

# Install Modal if needed (no modal setup required with env vars)
pip install modal

# Run a script
modal run train.py

# Deploy a service
modal deploy serve.py
```

### Usage Reporting

After any Modal job completes, report usage:

```typescript
// In the CLI agent, after Modal job finishes
await OpenScience.reportUsage({
    service: "modal",
    model: "meta-llama/Llama-3.1-8B",  // or whatever was used
    tokens: estimatedTokens,
    gpu: "H100",
    duration: durationSeconds,
})
```

### Integration with Other Skills

**Modal + vLLM skill**: Deploy vLLM on Modal for production inference
- Load `vllm` skill for vLLM-specific configuration
- Load `modal-serverless-gpu` skill for Modal deployment patterns
- Refer to Modal example `vllm_inference`

**Modal + DeepSpeed skill**: Distributed training on Modal
- Load `deepspeed` skill for DeepSpeed configuration
- Use multi-GPU (`gpu="H100:8"`) or multi-node patterns
- Refer to Modal example `grpo_verl` for multi-node training

**Modal + Accelerate skill**: Multi-GPU training on Modal
- Load `accelerate` skill for Accelerate configuration
- Use `gpu="H100:4"` or similar multi-GPU spec

**Modal + Whisper skill**: Batch transcription on Modal
- Load `whisper` skill for Whisper-specific configuration
- Refer to Modal example `batched_whisper` for batch pattern

## Production Deployment

### Environment Separation

```python
import os
env = os.environ.get("MODAL_ENVIRONMENT", "dev")
app = modal.App(f"my-service-{env}")

gpu = "A100" if env == "prod" else "T4"
timeout = 3600 if env == "prod" else 300
```

### Zero-Downtime Deployments

`modal deploy` automatically handles zero-downtime:
1. New containers built and started
2. Traffic gradually shifts to new version
3. Old containers drain existing requests
4. Old containers terminated

### Health Checks

```python
@app.function()
@modal.fastapi_endpoint()
def health():
    return {"status": "healthy", "gpu": torch.cuda.is_available()}
```

### Monitoring

```python
@app.function(gpu="A100")
def monitored_inference(inputs):
    import time
    start = time.time()
    results = model.predict(inputs)
    latency = time.time() - start
    # Visible in Modal dashboard logs
    print(f"METRIC latency={latency:.3f}s batch_size={len(inputs)}")
    return results
```

Use `modal app logs <app-name>` to stream logs from deployed apps.
