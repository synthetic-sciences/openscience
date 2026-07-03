---
name: hdf5-pde-data-loading
description: Patterns for loading PDE simulation datasets (PDEBench, PhiFlow, JAX-CFD) from HDF5 files. Handles layout detection (single tensor vs separate variables), spatial/temporal downsampling, multi-variable systems, HuggingFace and DaRUS data sources, and efficient PyTorch DataLoader creation. Use when preparing PDE data for neural operator training.
category: data-engineering
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [HDF5, Data Loading, PDE, PyTorch, DataLoader, Downsampling, PDEBench]
dependencies: ["h5py", "numpy", "torch", "huggingface-hub"]
---

# HDF5 PDE Data Loading

## When to Use
- Loading PDE simulation datasets stored in HDF5 format
- PDEBench, PhiFlow, JAX-CFD, or custom simulation outputs
- Multi-variable systems (density, velocity, pressure, etc.)
- Need to downsample spatial/temporal dimensions for memory

## HDF5 Layout Detection

PDE datasets come in two common layouts:

### Layout 1: Single "tensor" dataset
```python
with h5py.File(path, "r") as f:
    if "tensor" in f:
        ds = f["tensor"]  # shape: [N, T, X, C] or [N, T, X]
```

### Layout 2: Separate variable datasets
```python
with h5py.File(path, "r") as f:
    # Keys like: "density", "Vx", "pressure", or "t", "x", "u"
    rho = f["density"][:]  # [N, T, X]
    vel = f["Vx"][:]
    prs = f["pressure"][:]
    data = np.stack([rho, vel, prs], axis=-1)  # [N, T, X, 3]
```

### Robust loading (handles both):
```python
def load_pde_hdf5(path, res_x=1, res_t=1):
    """Load PDE data from HDF5, handling multiple layouts."""
    with h5py.File(path, "r") as f:
        print(f"Keys: {list(f.keys())}")

        if "tensor" in f:
            ds = f["tensor"]
            raw_shape = ds.shape
            if len(raw_shape) == 4:
                N, T, X, C = raw_shape
            else:
                N, T, X = raw_shape; C = 1

            X_ds = X // res_x
            T_ds = T // res_t if res_t > 1 else T
            data = np.empty((N, X_ds, T_ds, C if len(raw_shape)==4 else 1), dtype=np.float32)

            for s in range(0, N, 500):  # Chunk to avoid OOM
                e = min(s + 500, N)
                chunk = ds[s:e, ::res_t, ::res_x]
                if len(chunk.shape) == 3:
                    data[s:e, :, :, 0] = np.transpose(chunk, (0, 2, 1))
                else:
                    data[s:e] = np.transpose(chunk, (0, 2, 1, 3))
        else:
            # Separate variables — find and stack them
            var_keys = []
            for k in sorted(f.keys()):
                if isinstance(f[k], h5py.Dataset) and len(f[k].shape) >= 3:
                    var_keys.append(k)

            arrays = [f[k][:, ::res_t, ::res_x] for k in var_keys]
            raw = np.stack(arrays, axis=-1)  # [N, T, X, C]
            data = np.transpose(raw, (0, 2, 1, 3)).astype(np.float32)

        # Load grid coordinates
        for grid_key in ["x-coordinate", "x", "X"]:
            if grid_key in f:
                grid = np.array(f[grid_key], dtype=np.float32)[::res_x]
                break
        else:
            grid = np.linspace(0, 1, data.shape[1], dtype=np.float32)

    return data, grid  # data: [N, X, T, C], grid: [X]
```

## Data Sources

### HuggingFace Hub (fast CDN, preferred):
```python
from huggingface_hub import hf_hub_download
path = hf_hub_download(
    repo_id="pdebench/Advection",           # or pdebench/Burgers
    filename="1D_Advection_Sols_beta1.0.hdf5",
    repo_type="dataset",
    cache_dir="/tmp/hf_cache",
)
```

**Known HF repos:** `pdebench/Advection`, `pdebench/Burgers`, `pdebench/PDEBench`
**NOT on HF:** ReacDiff, 1D CFD — use DaRUS instead.

### DaRUS (Stuttgart data repository):
```python
import subprocess
url = f"https://darus.uni-stuttgart.de/api/access/datafile/{file_id}"
subprocess.run([
    "aria2c", "-x", "16", "-s", "16",
    "--max-connection-per-server=16",
    "--min-split-size=10M", "--timeout=600", "--max-tries=5",
    "-d", "/tmp", "-o", filename, url
], check=True, timeout=3600)
```

Install aria2: `apt install aria2` (in Modal: `.apt_install("aria2")`)

### Finding DaRUS file IDs:
```python
import urllib.request
csv_url = "https://raw.githubusercontent.com/pdebench/PDEBench/main/pdebench/data_download/pdebench_data_urls.csv"
data = urllib.request.urlopen(csv_url).read().decode()
for line in data.split('\n'):
    if 'your_dataset' in line:
        print(line)  # filename, URL, path, md5
```

## PyTorch DataLoader Setup

```python
class PDEDS(Dataset):
    def __init__(self, data, grid, init_step=10):
        self.data = data      # [N, X, T, C]
        self.grid = grid      # [X, 1]
        self.init_step = init_step

    def __len__(self):
        return self.data.shape[0]

    def __getitem__(self, i):
        x = self.data[i, :, :self.init_step, :]  # Input window
        y = self.data[i]                           # Full trajectory (for AR loss)
        return x, y, self.grid

train_loader = DataLoader(
    PDEDS(data[:N_TRAIN], grid, INIT_STEP),
    batch_size=32, shuffle=True, num_workers=2, pin_memory=True
)
```

## Downsampling Guidelines

| Original | Downsampled | Factor | Use When |
|---|---|---|---|
| 1024 spatial | 256 | 4× | Smooth problems, standard benchmarks |
| 1024 spatial | 512 | 2× | Moderate shocks, multi-variable |
| 1024 spatial | 1024 | 1× | Sharp shocks (ν≤0.001), needs A100 |
| 200 temporal | 40 | 5× | Standard (10 input + 30 rollout) |
| 100 temporal | 20 | 5× | Short series (10 input + 10 rollout) |

**Warning:** Downsampling shocks can destroy them entirely. At 256 points, a shock of width 0.001 spans <1 grid cell.

## Common Pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Wrong transpose order | Model diverges | Always: [N,T,X,C] → [N,X,T,C] |
| Not chunking large reads | OOM during loading | Read in batches of 500 |
| HF repo doesn't exist | FileNotFoundError | Fall back to DaRUS with aria2c |
| x-coordinate key missing | Wrong grid spacing | Fall back to linspace |
| File truncated (partial download) | HDF5 read error | Check file size, re-download |
| dtype mismatch (float64 vs float32) | Slow training, high memory | Cast to float32 explicitly |
