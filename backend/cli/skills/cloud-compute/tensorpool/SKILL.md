---
name: tensorpool-gpu-cloud
description: On-demand GPU clusters and training jobs with git-style interface. Use when you need multi-node GPU clusters (B200, H200, H100), persistent NFS storage, or batch training jobs with the TensorPool CLI.
category: cloud-compute
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Infrastructure, GPU Cloud, Training, Clusters, Jobs, TensorPool, Multi-Node, Distributed Training, NFS Storage]
dependencies: [tensorpool]
---

# TensorPool GPU Cloud

On-demand GPU clusters and git-style training jobs via the `tp` CLI. TensorPool provides multi-node GPU clusters with high-speed interconnects, persistent storage, and SLURM for distributed training.

## When to Use TensorPool

**Use TensorPool when:**
- Need on-demand GPU clusters with SSH access (single or multi-node)
- Running distributed training across multiple nodes (SLURM pre-installed)
- Want git-style job interface: `tp job push` to submit, `tp job pull` to get results
- Need persistent NFS storage shared across cluster nodes
- Require B200, B300, H200, H100, L40S, or MI300X GPUs
- Want pay-per-second billing with no egress fees

**Key features:**
- **GPU variety**: B300, B200, H200, H100, L40S, MI300X, CPU instances
- **Multi-node clusters**: 8xB200 and 8xH200 with SLURM + InfiniBand
- **Jobs**: Git-style `tp job push/pull/listen` for batch experiments
- **Persistent storage**: Shared NFS volumes (300 GB/s aggregate) or S3-compatible object storage
- **Simple pricing**: Per-second billing, H100 at $1.99/hr, H200 at $2.99/hr, B200 at $4.99/hr

**Use alternatives instead:**
- **Tinker**: For managed SFT/fine-tuning (no infrastructure management)
- **Prime Intellect Lab**: For hosted RL training with environments
- **Modal**: For serverless, auto-scaling GPU workloads
- **Lambda Labs**: For dedicated instances with persistent filesystems
- **SkyPilot**: For multi-cloud orchestration and cost optimization

### Decision Matrix

| Task | Platform |
|------|----------|
| SFT / LoRA fine-tuning | Tinker (default) |
| Hosted RL with environments | Prime Intellect Lab |
| On-demand GPU clusters with SSH | **TensorPool** |
| Batch training jobs (git-style) | **TensorPool** |
| Multi-node distributed training | **TensorPool** or Lambda (1-Click Clusters) |
| Serverless auto-scaling | Modal |
| Multi-cloud cost optimization | SkyPilot |

---


## Credential Setup

Credentials are auto-injected by openscience when connected via the dashboard.

```bash
# Verify credentials
[ -n "$TENSORPOOL_KEY" ] && echo "TENSORPOOL_KEY set" || echo "NOT SET"
```

If not set: connect TensorPool at https://app.syntheticsciences.ai -> Services, then restart openscience.

## Quick Start

### Installation

```bash
pip install tensorpool
```

### Authentication

```bash
# Set API key (synced automatically via OpenScience dashboard)
export TENSORPOOL_KEY="your_api_key_here"

# Verify
[ -n "$TENSORPOOL_KEY" ] && echo "set" || echo "not set"
```

If connected via the Synthetic Sciences dashboard, `TENSORPOOL_KEY` is injected automatically.

### Create Your First Cluster

```bash
# Single H100
tp cluster create -i ~/.ssh/id_ed25519.pub -t 1xH100

# Check status
tp cluster info <cluster_id>

# SSH in
tp ssh <instance_id>

# Destroy when done
tp cluster destroy <cluster_id>
```

### Submit a Training Job

```bash
# Initialize job config
tp job init

# Edit tp.config.toml, then push
tp job push tp.config.toml

# Stream logs
tp job listen <job_id>

# Download results
tp job pull <job_id>
```

---

## Instance Types

| Instance Type | Multi-Node Support |
|---------------|-------------------|
| `1xB300` / `2xB300` / `4xB300` / `8xB300` | No |
| `1xB200` / `2xB200` / `4xB200` / `8xB200` | **Yes** (8xB200) |
| `1xH200` / `2xH200` / `4xH200` / `8xH200` | **Yes** (8xH200) |
| `1xH100` / `2xH100` / `4xH100` / `8xH100` | No |
| `1xL40S` | No |
| `32xCPU` / `64xCPU` | No |

### Pricing (per GPU/hour)

| GPU | Price |
|-----|-------|
| B300 SXM | $5.49/hr |
| B200 SXM | $4.99/hr |
| H200 SXM | $2.99/hr |
| H100 SXM | $1.99/hr |
| L40S | $1.49/hr |
| CPU | $0.015/hr |

All charges prorated to the second.

---

## Clusters

### Single-Node Clusters

```bash
# Various GPU configs
tp cluster create -i ~/.ssh/id_ed25519.pub -t 1xH100
tp cluster create -i ~/.ssh/id_ed25519.pub -t 8xH200
tp cluster create -i ~/.ssh/id_ed25519.pub -t 8xB200
tp cluster create -i ~/.ssh/id_ed25519.pub -t 1xL40S

# With custom name
tp cluster create -i ~/.ssh/id_ed25519.pub -t 1xH100 --name my-cluster
```

### Multi-Node Clusters

Multi-node clusters come with **SLURM preinstalled**. Only `8xH200` and `8xB200` support multi-node.

```bash
# 2-node cluster (16 GPUs total)
tp cluster create -i ~/.ssh/id_ed25519.pub -t 8xH200 -n 2

# 4-node cluster (32 GPUs total)
tp cluster create -i ~/.ssh/id_ed25519.pub -t 8xB200 -n 4
```

**Multi-node architecture:**
- **Jumphost**: `{cluster_id}-jumphost` — SLURM login/controller, public IP
- **Worker nodes**: `{cluster_id}-0`, `{cluster_id}-1`, etc. — private IPs only

```bash
# SSH into jumphost first
tp ssh <jumphost-instance-id>

# From jumphost, access workers
ssh <cluster_id>-0
ssh <cluster_id>-1
```

### Cluster Management

```bash
tp cluster list                    # List all clusters
tp cluster list --org              # List organization clusters
tp cluster info <cluster_id>       # Detailed cluster info
tp cluster edit <cluster_id> --name "new-name"
tp cluster edit <cluster_id> --deletion-protection true
tp cluster destroy <cluster_id>    # Terminate cluster
```

### Cluster Statuses

`PENDING` → `PROVISIONING` → `CONFIGURING` → `RUNNING` → `DESTROYING` → `DESTROYED`

If any instance fails, cluster shows as `FAILED`.

---

## Jobs

Git-style interface for running training experiments on GPUs. Pay only for the time your job runs.

### Job Configuration (tp.config.toml)

```toml
commands = [
    "pip install -r requirements.txt",
    "python train.py --epochs 100",
]

instance_type = "1xH100"

outputs = [
    "checkpoints/",
    "model.pth",
    "results.json",
]

ignore = [
    ".venv",
    "venv/",
    "__pycache__/",
    ".git",
    "*.pyc",
]
```

### Job Commands

```bash
tp job init                        # Create tp.config.toml
tp job push tp.config.toml         # Submit job
tp job list                        # List your jobs
tp job list --org                  # List org jobs
tp job info <job_id>               # Job details
tp job listen <job_id>             # Stream real-time logs
tp job pull <job_id>               # Download output files
tp job pull <job_id> --force       # Overwrite existing files
tp job cancel <job_id>             # Cancel running job
tp job cancel <job_id> --no-input  # Skip confirmation
```

### Job Statuses

`Pending` → `Running` → `Completed` / `Error` / `Failed` / `Canceled`

- **Error**: User-level (non-zero exit code) — check logs
- **Failed**: System-level (node/GPU failure) — TensorPool investigates

### Multiple Experiments

```bash
# Create multiple configs
tp job init  # → tp.config.toml (rename to tp.baseline.toml)
tp job init  # → tp.config1.toml (rename to tp.experiment.toml)

# Run different experiments
tp job push tp.baseline.toml
tp job push tp.experiment.toml
```

---

## Storage

### Shared Storage Volumes (NFS)

High-performance NFS for multi-node clusters. Up to 300 GB/s aggregate read throughput.

```bash
# Create 500GB shared volume
tp storage create -t shared -s 500 --name training-data

# Attach to cluster
tp cluster attach <cluster_id> <storage_id>

# Access on cluster at /mnt/shared-<storage_id>

# Detach
tp cluster detach <cluster_id> <storage_id>

# Destroy
tp storage destroy <storage_id>
```

**Shared storage**: Multi-node only (2+ nodes), $100/TB/month, POSIX compliant.

### Object Storage (S3-compatible)

```bash
# Create object storage bucket
tp storage create -t object --name models

# Attach to any cluster type
tp cluster attach <cluster_id> <storage_id>

# Mount at /mnt/object-<storage_id> (FUSE)
# Prefer boto3/rclone over FUSE mount for performance
```

**Object storage**: All cluster types, $20/TB/month, globally replicated, no ingress/egress fees. Not POSIX compliant.

### Storage Commands

```bash
tp storage create -t <type> [-s <size>] [--name <name>]
tp storage list
tp storage info <storage_id>
tp storage edit <storage_id> --name "new-name"
tp storage edit <storage_id> --deletion-protection true
tp storage destroy <storage_id>
```

---

## SSH Keys

```bash
# Generate if needed
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519

# Use when creating clusters
tp cluster create -i ~/.ssh/id_ed25519.pub -t 1xH100

# Connect to cluster
tp ssh <instance_id>
```

---

## Common Workflows

### Workflow 1: Single-Node Training Job

```bash
# 1. Create job config
tp job init

# 2. Configure tp.config.toml
# commands = ["pip install -r requirements.txt", "python train.py"]
# instance_type = "1xH100"
# outputs = ["checkpoints/", "model.pth"]

# 3. Submit
tp job push tp.config.toml

# 4. Monitor
tp job listen <job_id>

# 5. Get results
tp job pull <job_id>
```

### Workflow 2: Multi-Node Distributed Training

```bash
# 1. Create 4-node cluster with storage
tp cluster create -i ~/.ssh/id_ed25519.pub -t 8xH200 -n 4
tp storage create -t shared -s 1000 --name dataset
tp cluster attach <cluster_id> <storage_id>

# 2. SSH into jumphost
tp ssh <jumphost-instance-id>

# 3. Upload data to shared storage
cd /mnt/shared-<storage_id>
# rsync, wget, or HF download your dataset here

# 4. Submit SLURM job
srun --nodes=4 --ntasks-per-node=8 --gpus-per-node=8 \
  torchrun --nnodes=4 --nproc_per_node=8 \
  --rdzv_backend=c10d --rdzv_endpoint=$MASTER_ADDR:29500 \
  train.py

# 5. Clean up
tp cluster detach <cluster_id> <storage_id>
tp cluster destroy <cluster_id>
```

### Workflow 3: Interactive Development

```bash
# 1. Create single-node cluster
tp cluster create -i ~/.ssh/id_ed25519.pub -t 1xH100 --name dev-box

# 2. SSH in and iterate
tp ssh <instance_id>
git clone <repo>
pip install -r requirements.txt
python train.py

# 3. Destroy when done
tp cluster destroy <cluster_id>
```

---

## Troubleshooting

### Common Issues

**1. `TENSORPOOL_KEY` not set**
```bash
[ -n "$TENSORPOOL_KEY" ] && echo "set" || echo "not set"
# If not set, connect via OpenScience dashboard or export manually
```

**2. Cluster stuck in PENDING/PROVISIONING**
```bash
# Check cluster status
tp cluster info <cluster_id>
# Try a different instance type or wait for capacity
```

**3. Can't SSH into cluster**
- Wait for status to reach `RUNNING` (can take a few minutes)
- Verify SSH key was provided at cluster creation
- For multi-node: SSH into jumphost first, then access workers

**4. Multi-node workers not accessible**
```bash
# Workers have private IPs only — must go through jumphost
tp ssh <jumphost-instance-id>
ssh <cluster_id>-0  # from jumphost
```

**5. Storage attachment fails**
- Shared storage: only multi-node clusters (2+ nodes)
- Object storage: works on all cluster types
- Check storage status is `READY` before attaching

**6. Job stuck in Pending**
```bash
tp job info <job_id>
# Check instance type availability
tp job cancel <job_id>  # Cancel and retry if needed
```

**7. Job Error (non-zero exit code)**
```bash
# Stream logs to see what failed
tp job listen <job_id>
# Fix script, re-push
tp job push tp.config.toml
```

**8. Object storage slow for small files**
- Object storage has per-request overhead (HTTP calls)
- Use `boto3` or `rclone` instead of FUSE mount
- Don't set up Python venvs on object storage (thousands of small files)

---

## Agent Usage Instructions

When the `openscience` agent loads this skill for a user task:

1. **Check credentials first**: Verify `TENSORPOOL_KEY` is set
2. **Determine cluster vs job**: Jobs for batch experiments, clusters for interactive work
3. **Select instance type**: Match GPU to workload (H100 for training, L40S for inference, B200 for largest models)
4. **ALWAYS get user approval before creating resources**: Present instance type, estimated cost/hour, and expected duration. TensorPool bills per-second — user manages their own billing. Wait for explicit approval.
5. **For jobs**: Create `tp.config.toml`, show it to user, get approval, then `tp job push`
6. **For clusters**: Show the `tp cluster create` command with instance type and cost, get approval first
7. **Monitor**: Use `tp job listen` or `tp ssh` to track progress
8. **Clean up**: Always destroy clusters and detach storage when done

### Cost Awareness

TensorPool charges per GPU/hour, prorated to the second:
- B200: $4.99/GPU/hr → 8xB200 = ~$40/hr per node
- H200: $2.99/GPU/hr → 8xH200 = ~$24/hr per node
- H100: $1.99/GPU/hr → 8xH100 = ~$16/hr per node
- L40S: $1.49/GPU/hr
- Storage: Shared $100/TB/month, Object $20/TB/month

**ALWAYS present estimated cost before creating any resource.**

### Example Agent Workflow

```
User: "Set up a 2-node H200 cluster for distributed training"

Agent steps:
1. Load skill: tensorpool-gpu-cloud
2. Check TENSORPOOL_KEY is set
3. Present cost estimate: 2x 8xH200 = $47.84/hr ($0.80/min)
4. Wait for explicit user approval
5. tp cluster create -i ~/.ssh/id_ed25519.pub -t 8xH200 -n 2
6. Wait for RUNNING status
7. tp ssh <jumphost-instance-id>
8. Help user with training setup
9. Remind user to destroy cluster when done
```

---

## Quick Reference

| Command | Description |
|---------|-------------|
| `tp cluster create -t <type> [-n <nodes>]` | Create GPU cluster |
| `tp cluster list` | List clusters |
| `tp cluster info <id>` | Cluster details |
| `tp cluster destroy <id>` | Terminate cluster |
| `tp cluster attach <cluster_id> <storage_id>` | Attach storage |
| `tp cluster detach <cluster_id> <storage_id>` | Detach storage |
| `tp job init` | Create job config |
| `tp job push <config>` | Submit training job |
| `tp job list` | List jobs |
| `tp job info <id>` | Job details |
| `tp job listen <id>` | Stream job logs |
| `tp job pull <id>` | Download outputs |
| `tp job cancel <id>` | Cancel job |
| `tp storage create -t <type> [-s <size>]` | Create storage |
| `tp storage list` | List storage |
| `tp storage destroy <id>` | Delete storage |
| `tp ssh <instance_id>` | SSH to instance |
| `tp me` | Account info |

## Resources

- **Documentation**: https://docs.tensorpool.dev
- **Dashboard**: https://dashboard.tensorpool.dev
- **Pricing**: https://tensorpool.dev/pricing
- **Community**: https://tensorpool.dev/slack
- **Support**: team@tensorpool.dev
