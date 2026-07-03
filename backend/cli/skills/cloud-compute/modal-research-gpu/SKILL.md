---
name: modal-research-gpu
description: GPU-accelerated scientific research on Modal — simulations, numerical methods, Monte Carlo, molecular dynamics, large-scale data processing. NOT for ML training or inference (use gpu-training or modal skills instead).
category: cloud-compute
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [GPU, Scientific Computing, Simulations, Modal, Research, HPC, Numerical Methods]
dependencies: [modal>=0.73.0]
---

# Modal Research GPU

Run GPU-accelerated scientific research workloads on Modal. This skill covers simulations, numerical computation, Monte Carlo methods, molecular dynamics, large-scale data processing, and batch scientific computing.

**NOT for ML training/inference** — use `gpu-training` (Tinker/Modal training) or `modal` (inference serving) instead.

## When to Use This Skill

| Workload | Example |
|----------|---------|
| Monte Carlo simulations | Drug binding free energy, financial risk modeling, particle physics |
| Molecular dynamics | GROMACS, OpenMM, LAMMPS on GPU |
| Numerical PDE solvers | Fluid dynamics (CFD), heat transfer, electromagnetics |
| Large-scale data processing | Genomics pipelines, image processing, signal analysis |
| GPU-accelerated linear algebra | CuPy/RAPIDS matrix operations, eigenvalue problems |
| Parallel parameter sweeps | Sensitivity analysis, hyperspace exploration |
| Scientific visualization | Volume rendering, 3D reconstruction |

## Credential Setup

```bash
# Verify Modal credentials (auto-injected by openscience)
[ -n "$MODAL_TOKEN_ID" ] && echo "MODAL_TOKEN_ID set" || echo "NOT SET"
[ -n "$MODAL_TOKEN_SECRET" ] && echo "MODAL_TOKEN_SECRET set" || echo "NOT SET"
```

If not set: connect Modal at https://app.syntheticsciences.ai -> Services, then restart openscience.

## GPU Selection Guide

| GPU | VRAM | Best For | Cost/hr (approx) |
|-----|------|----------|-------------------|
| T4 | 16 GB | Light numerical work, small simulations | $0.59 |
| L4 | 24 GB | Medium simulations, data processing | $0.80 |
| A10G | 24 GB | General scientific computing | $1.10 |
| A100 40GB | 40 GB | Large simulations, molecular dynamics | $3.40 |
| A100 80GB | 80 GB | Very large state spaces, multi-physics | $4.58 |
| H100 | 80 GB | Maximum throughput, large-scale Monte Carlo | $6.98 |

**Rule of thumb:** Start with A10G. Move to A100 only if VRAM or throughput is insufficient.

## Scientific Python Stack

```python
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        # Core scientific
        "numpy>=2.0", "scipy>=1.14", "pandas>=2.2",
        # Visualization (needed for figure generation in research pipelines)
        "matplotlib>=3.9", "seaborn>=0.13",
        # Bioinformatics (needed for DNA/protein visualization pipelines)
        "biopython>=1.84",
        # GPU-accelerated
        "cupy-cuda12x>=13.0",  # GPU arrays (drop-in NumPy replacement)
        "jax[cuda12]>=0.4.30",  # Differentiable computing
        # Domain-specific (add as needed)
        # "openmm>=8.1",       # Molecular dynamics
        # "pycuda>=2024.1",    # Raw CUDA kernels
        # "rapids-cudf>=24.0", # GPU DataFrames
    )
)
```

## Pattern: Basic GPU Computation

```python
import modal

app = modal.App("research-compute")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("numpy", "scipy", "cupy-cuda12x")
)

@app.function(image=image, gpu="A10G", timeout=3600)
def gpu_compute(params: dict):
    import cupy as cp
    import numpy as np

    # CuPy — NumPy API on GPU
    matrix = cp.random.randn(params["size"], params["size"], dtype=cp.float64)
    eigenvalues = cp.linalg.eigvalsh(matrix @ matrix.T)
    return cp.asnumpy(eigenvalues)
```

## Pattern: Monte Carlo Simulation (Parallel)

```python
@app.function(image=image, gpu="A10G", timeout=7200)
def monte_carlo_batch(seed: int, n_samples: int, params: dict):
    import cupy as cp

    rng = cp.random.default_rng(seed)
    # Run simulation on GPU
    samples = rng.standard_normal((n_samples, params["dim"]))
    results = run_simulation_kernel(samples, params)
    return cp.asnumpy(results)

@app.local_entrypoint()
def main():
    # Fan out to 100 GPUs in parallel
    seeds = list(range(100))
    results = list(monte_carlo_batch.map(
        seeds,
        kwargs={"n_samples": 1_000_000, "params": {"dim": 3}},
    ))
    aggregate(results)
```

## Pattern: Molecular Dynamics

```python
image_md = (
    modal.Image.from_registry("nvcr.io/hpc/openmm:8.1.1")
    .pip_install("mdtraj", "parmed")
)

@app.function(image=image_md, gpu="A100", timeout=14400)
def run_md_simulation(pdb_path: str, steps: int = 1_000_000):
    import openmm
    import openmm.app as app

    pdb = app.PDBFile(pdb_path)
    forcefield = app.ForceField("amber14-all.xml", "amber14/tip3pfb.xml")
    system = forcefield.createSystem(
        pdb.topology,
        nonbondedMethod=app.PME,
        nonbondedCutoff=1.0,
        constraints=app.HBonds,
    )
    integrator = openmm.LangevinMiddleIntegrator(300, 1.0, 0.004)
    platform = openmm.Platform.getPlatformByName("CUDA")
    simulation = app.Simulation(pdb.topology, system, integrator, platform)
    simulation.context.setPositions(pdb.positions)
    simulation.minimizeEnergy()
    simulation.step(steps)
```

## Pattern: Parameter Sweep with Volume Storage

```python
vol = modal.Volume.from_name("research-results", create_if_missing=True)

@app.function(image=image, gpu="T4", volumes={"/results": vol}, timeout=3600)
def sweep_point(param_set: dict):
    import numpy as np
    result = run_experiment(param_set)
    path = f"/results/sweep_{param_set['id']}.npz"
    np.savez(path, **result)
    vol.commit()
    return {"id": param_set["id"], "metric": result["metric"]}

@app.local_entrypoint()
def sweep():
    param_grid = [{"id": i, "alpha": a, "beta": b}
                  for i, (a, b) in enumerate(grid)]
    results = list(sweep_point.map(param_grid))
```

## Pattern: JAX on GPU (Differentiable Scientific Computing)

```python
image_jax = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("jax[cuda12]", "jaxlib", "diffrax", "equinox")
)

@app.function(image=image_jax, gpu="A100", timeout=7200)
def solve_pde(params: dict):
    import jax
    import jax.numpy as jnp
    import diffrax

    # Solve ODE/PDE system with automatic differentiation
    def vector_field(t, y, args):
        return -args["k"] * y + jnp.sin(t)

    sol = diffrax.diffeqsolve(
        diffrax.ODETerm(vector_field),
        diffrax.Tsit5(),
        t0=0, t1=params["t_final"], dt0=0.01,
        y0=jnp.array(params["y0"]),
        args=params,
    )
    return {"t": sol.ts.tolist(), "y": sol.ys.tolist()}
```

## Cost Management

1. **Estimate before running**: Calculate GPU-hours = (estimated_time × n_parallel_jobs) / 3600 × hourly_rate
2. **Start small**: Test with T4/L4 and small problem sizes before scaling to A100/H100
3. **Use timeouts**: Always set `timeout` to prevent runaway costs
4. **Spot-check results**: Run a small batch first, verify correctness, then scale
5. **Volume cleanup**: Delete old volumes when done: `modal volume rm <name>`

## CRITICAL: Cost Approval

Before launching ANY GPU job:
1. Present estimated cost, GPU type, duration, and number of parallel jobs
2. Wait for explicit user approval
3. If declined, suggest smaller scale or cheaper GPU tier

## Multi-GPU (Single Node)

```python
@app.function(image=image, gpu="A100:4", timeout=14400)
def multi_gpu_compute():
    import jax
    devices = jax.devices()  # 4 GPUs available
    # Use jax.pmap or sharded arrays for multi-GPU
```

## Retrieving Results

```python
# Mount a Volume for persistent storage
vol = modal.Volume.from_name("my-research", create_if_missing=True)

@app.function(volumes={"/data": vol}, gpu="A10G")
def compute_and_save():
    # ... compute ...
    np.save("/data/results.npy", results)
    vol.commit()

# Later, download from another function or locally
@app.local_entrypoint()
def download():
    vol = modal.Volume.from_name("my-research")
    # Use modal volume get my-research /results.npy ./local_results.npy
```
