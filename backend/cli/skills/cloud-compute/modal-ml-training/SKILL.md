---
name: modal-ml-training
description: Disconnect-safe patterns for long-running ML training on Modal serverless GPU. Covers the deploy+spawn pattern (survives laptop shutdown/SSH disconnect), checkpoint-resume for preemption recovery, PyTorch/CUDA version pinning, volume reload/commit discipline, and batch parameter sweeps. Use for any training job >30 min where losing progress is expensive. Complements the broader `modal-serverless-gpu` skill.
category: cloud-compute
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Modal, GPU, Training, Checkpoint, Preemption, Deploy, Serverless, ML]
dependencies: ["modal>=0.73.0", "torch"]
---

# Modal GPU — Long-Running Training Patterns

## When to Use
- Training jobs that take >30 minutes on GPU
- Jobs that must survive laptop shutdown, SSH disconnect, or network loss
- Training on preemptible GPU instances (Modal can move containers)
- Any iterative training where losing progress is expensive

For general Modal usage (inference, sandboxes, web endpoints, batch), see the `modal-serverless-gpu` skill. This skill focuses specifically on the disconnect-safe long-training flow.

## The Deploy + Spawn Pattern (Disconnect-Safe)

NEVER use `modal run --detach` for long jobs with chained operations. The local process can die and subsequent calls won't execute.

```python
# Step 1: Write a SINGLE self-contained function
# train_script.py
import modal
app = modal.App("my-training")
volume = modal.Volume.from_name("my-results", create_if_missing=True)
image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "torch==2.4.1",  # PIN versions!
    "numpy==1.26.4", "h5py", "matplotlib",
)

@app.function(gpu="A10G", image=image, volumes={"/results": volume}, timeout=86400)
def train():
    # Everything happens here: download, train, evaluate, save, plot
    # ...
    volume.commit()
    return results
```

```bash
# Step 2: Deploy (one-time, persists on Modal)
modal deploy train_script.py

# Step 3: Trigger (fire-and-forget, instant return)
python -c "import modal; modal.Function.from_name('my-training', 'train').spawn()"
# Your terminal can now close — training continues on Modal
```

### API Note (Modal ≥0.68)
```python
# OLD (removed): modal.Function.lookup("app", "fn")
# NEW:           modal.Function.from_name("app", "fn")
```

## Checkpoint-Resume for Preemption

Modal can preempt workers and restart them on different machines. Save state periodically:

```python
CKPT_PATH = f"{OUT}/resume_checkpoint.pt"

# On startup: check for existing checkpoint
volume.reload()  # Get fresh view of volume
if os.path.exists(CKPT_PATH):
    ckpt = torch.load(CKPT_PATH, weights_only=False, map_location=DEVICE)
    model.load_state_dict(ckpt["model"])
    optimizer.load_state_dict(ckpt["optimizer"])
    scheduler.load_state_dict(ckpt["scheduler"])
    start_epoch = ckpt["epoch"] + 1
    train_losses = ckpt["train_losses"]
    best_metric = ckpt["best_metric"]
    print(f"Resumed at epoch {start_epoch}")
else:
    start_epoch = 1

# During training: save every N epochs
for epoch in range(start_epoch, EPOCHS + 1):
    # ... training loop ...

    if epoch % 10 == 0:  # Every 10 epochs
        torch.save({
            "epoch": epoch,
            "model": model.state_dict(),
            "optimizer": optimizer.state_dict(),
            "scheduler": scheduler.state_dict(),
            "train_losses": train_losses,
            "best_metric": best_metric,
        }, CKPT_PATH)
        volume.commit()  # Persist to Modal volume
```

**Max lost progress = checkpoint interval.** For 10-epoch interval at ~30s/epoch = ~5 min lost.

## PyTorch Version Pinning (CRITICAL)

Modal's GPU nodes can have different CUDA driver versions. Unpinned PyTorch grabs the latest, which may require a newer driver than available.

```python
# WRONG: Installs latest (e.g., torch 2.11 needing CUDA 13)
image = modal.Image.debian_slim().pip_install("torch")

# RIGHT: Pin to known-compatible version
image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "torch==2.4.1",        # Works with CUDA 12.x drivers
    "torchvision==0.19.1",
    "numpy==1.26.4",       # Pin numpy too (2.0 breaks some code)
)
```

## Volume Management

```python
volume = modal.Volume.from_name("my-results", create_if_missing=True)

# Mount in function:
@app.function(volumes={"/results": volume})
def train():
    volume.reload()   # BEFORE reading: get latest data from volume
    # ... training ...
    volume.commit()   # AFTER writing: persist changes to volume

# Read from local machine:
vol = modal.Volume.from_name("my-results")
for entry in vol.listdir("/"):
    print(entry.path, entry.size)

# Download file:
with open("local_file.pt", "wb") as f:
    for chunk in vol.read_file("remote/path/model.pt"):
        f.write(chunk)
```

**Race condition warning:** If multiple tasks write to the same volume directory, `volume.commit()` calls are serialized but interleaving is possible. Use separate subdirectories per task.

## GPU Selection Guide

| GPU | VRAM | $/hr | Use When |
|---|---|---|---|
| T4 | 16 GB | ~$0.59 | Small models, inference, testing |
| A10G | 24 GB | ~$1.10 | Standard training (256-512 spatial) |
| A100-40GB | 40 GB | ~$3.15 | Large models, high resolution |
| A100-80GB | 80 GB | ~$4.05 | Full resolution (1024+ spatial), multi-channel |
| H100 | 80 GB | ~$4.25 | Fastest training, large batch sizes |

**Rule of thumb for PDE solvers:**
- 256 spatial × 1 channel → A10G
- 512 spatial × 3 channels → A10G (tight) or A100
- 1024 spatial × 1 channel → A100-80GB
- 1024 spatial × 3+ channels → A100-80GB or H100

## Cost Estimation Template

```
Cost = (epochs × seconds_per_epoch / 3600) × $/hr

Example: 500 epochs × 30s/epoch = 15,000s = 4.2 hrs
On A10G: 4.2 × $1.10 = $4.62
On A100: 4.2 × $4.05 = $17.01
```

## Batch Parameter Sweeps (Multiple Runs, One App)

For running the same model with different parameters (e.g., different datasets, hyperparameters):

```python
# Single app with parameterized function
@app.function(gpu="A10G", image=image, volumes={"/results": volume}, timeout=86400)
def train(param_value: str):
    OUT = f"/results/run_{param_value}"
    os.makedirs(OUT, exist_ok=True)
    # ... training code using param_value ...
    volume.commit()
    return results
```

```python
# Spawn multiple runs in parallel (fire-and-forget)
import modal
fn = modal.Function.from_name("my-sweep-app", "train")
for param in ["0.1", "0.4", "1.0", "4.0"]:
    call = fn.spawn(param)
    print(f"Spawned param={param}: {call.object_id}")
```

**Key design rules:**
- Each run writes to a SEPARATE subdirectory (`/results/run_{param}`)
- All runs share one deployed app but execute as independent GPU instances
- Each run has its own checkpoint-resume (separate checkpoint files)
- Use `modal app list` to verify task count matches expected parallelism
- Monitor via `modal app logs app-name` (logs interleave from all tasks)

**Cost awareness:** N parallel runs on A10G = N × $1.10/hr. 4 parallel A10G runs for 3 hrs = $13.20 total.

## Monitoring Running Jobs

```bash
# List all apps
modal app list

# Stream logs (real-time)
modal app logs my-training-app

# Stop an app
modal app stop <app-id>
```

## Common Pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| `modal run --detach` with chained `.remote()` | Second call never executes | Use deploy + spawn |
| Unpinned PyTorch | `CUDA driver too old` error | Pin `torch==2.4.1` |
| No `volume.reload()` before reading | Stale/missing checkpoint | Always reload before reading |
| No `volume.commit()` after writing | Changes lost on preemption | Commit after every checkpoint |
| Multiple tasks, same volume path | Race conditions | Use separate subdirectories |
| Timeout too short | Job killed mid-training | Set `timeout=86400` (24h max) |
| No checkpoint-resume | Lose all progress on preemption | Save every 10 epochs |
| Multiple spawns of same function | Duplicate jobs running | Check `modal app list` first |
