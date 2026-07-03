---
name: autoregressive-neural-pde-solver
description: Training patterns for autoregressive neural PDE solvers (FNO, DeepONet, CNO). Covers rollout training, noise injection for stability, multi-component loss functions (H1, frequency-sensitive, boundary-aware), per-channel normalization for coupled multi-variable systems, and the PDEBench nRMSE metric. Use when training any neural operator that predicts time-dependent PDE solutions.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Neural Operator, Autoregressive, PDE, Rollout, FNO, Loss Function, Normalization]
dependencies: ["torch>=2.1.0", "numpy>=1.24.0"]
---

# Autoregressive Neural PDE Solvers — Training Patterns

## When to Use
- Training any neural operator (FNO, DeepONet, CNO, etc.) to predict time-dependent PDE solutions
- The model predicts one (or few) timesteps ahead, then feeds predictions back as input
- Multi-variable PDE systems (compressible NS, MHD, multi-species reaction, etc.)
- Problems where single-step accuracy is insufficient — rollout stability matters

## Core Principle: Train How You Infer

The single biggest mistake in neural PDE solving is training on single-step predictions but inferring with multi-step rollout. The model never learns to handle its own errors.

```python
# WRONG: Teacher forcing (single-step)
for t in range(T):
    pred = model(ground_truth[:, :, t])  # Always sees perfect input
    loss += mse(pred, ground_truth[:, :, t+1])
# At inference, errors compound exponentially because model never saw noisy inputs

# RIGHT: Autoregressive rollout training
inp = initial_condition  # shape: [B, X, init_steps, C]
for t in range(init_steps, T_total):
    pred = model(inp)  # Sees its OWN previous predictions
    loss += mse(pred, ground_truth[:, :, t:t+1, :])
    inp = torch.cat([inp[:, :, 1:, :], pred], dim=-2)  # Shift window, append prediction
# Model learns to be robust to its own prediction errors
```

## Data Layout Convention

For spectral operators (FNO), use spatial-first layout:
```python
# Standard: [N_samples, X_spatial, T_timesteps, C_channels]
# NOT: [N_samples, T_timesteps, X_spatial, C_channels]

# When loading from [N, T, X] or [N, T, X, C]:
data = np.transpose(raw[:, ::stride_t, ::stride_x], (0, 2, 1))       # 3D
data = np.transpose(raw[:, ::stride_t, ::stride_x, :], (0, 2, 1, 3)) # 4D
```

## Noise Injection for Rollout Stability

During autoregressive training, add small noise to predictions before feeding back. This prevents the model from relying on artificially clean inputs.

```python
NOISE_STD = 1e-3  # Smooth problems
NOISE_STD = 5e-3  # Shock/discontinuity problems

# During training only:
if model.training and NOISE_STD > 0:
    noisy_pred = pred + NOISE_STD * torch.randn_like(pred)
    inp = torch.cat([inp[:, :, 1:, :], noisy_pred], dim=-2)
else:
    inp = torch.cat([inp[:, :, 1:, :], pred], dim=-2)
```

**Guidance for noise level:**
- σ = 0 for very smooth, well-resolved problems
- σ = 1e-3 for moderately complex dynamics
- σ = 5e-3 for shock-dominated or chaotic problems
- Too much noise smears sharp features; too little doesn't help stability

## Multi-Component Loss Functions

### Sobolev H1 Loss (Spatial Gradient Penalty)
Penalizes errors in spatial derivatives — critical for steep gradients, reaction fronts, shocks.

```python
def h1_loss(pred, target):
    """Penalize spatial gradient errors."""
    grad_pred = pred[:, 1:, :] - pred[:, :-1, :]
    grad_tgt = target[:, 1:, :] - target[:, :-1, :]
    return F.mse_loss(grad_pred, grad_tgt)

# Usage: loss = mse_loss + 0.05 * h1_loss(pred, target)
```

### Frequency-Sensitive Loss
Partition Fourier spectrum into bands with increasing weights — upweights high-frequency content.

```python
def frequency_loss(pred, target, weights=[1.0, 2.0, 4.0]):
    """Higher weight on high-frequency errors."""
    pred_ft = torch.fft.rfft(pred, dim=1)
    tgt_ft = torch.fft.rfft(target, dim=1)
    n = pred_ft.shape[1]
    bin_size = n // len(weights)
    loss = 0.0
    for i, w in enumerate(weights):
        s, e = i * bin_size, (i+1) * bin_size if i < len(weights)-1 else n
        loss += w * torch.abs(pred_ft[:, s:e] - tgt_ft[:, s:e]).mean()
    return loss

# Usage: loss = mse_loss + 0.1 * frequency_loss(pred, target)
```

### Boundary-Aware Loss (for non-periodic BCs)
Upweight loss near domain boundaries where spectral methods struggle.

```python
spatial_dim = pred.shape[1]
bw = int(0.1 * spatial_dim)  # 10% boundary region
weight = torch.ones(spatial_dim, device=pred.device)
weight[:bw] = 2.0; weight[-bw:] = 2.0
weight = weight / weight.mean()  # Normalize

# Use element-wise: loss = (weight * (pred - target)**2).mean()
```

### Recommended Combinations

| Problem Type | MSE | H1 (weight) | Freq (weight) | Noise σ | Boundary |
|---|---|---|---|---|---|
| Smooth (advection, diffusion) | ✓ | — | — | — | — |
| Reaction-diffusion | ✓ | 0.1 | — | 1e-3 | — |
| Shocks (Burgers, Euler) | ✓ | 0.05 | 0.1 | 5e-3 | — |
| Non-periodic BCs | ✓ | 0.05 | — | 1e-3 | 2× at edges |
| Multi-variable coupled | ✓ | 0.05 | — | 1e-3 | — |

## Per-Channel Normalization for Multi-Variable Systems

When PDE variables have different scales (e.g., density ~O(6), velocity ~O(0.5), pressure ~O(59)), the loss is dominated by the largest-scale variable.

```python
# Compute from TRAINING set only
ch_mean = train_data.mean(dim=(0, 1, 2))  # [C]
ch_std = train_data.std(dim=(0, 1, 2)) + 1e-8  # [C]

# Normalize all data
data_normalized = (data - ch_mean) / ch_std

# Denormalize for evaluation (handles CPU/GPU mismatch)
def denormalize(x):
    return x * ch_std.to(x.device) + ch_mean.to(x.device)

# IMPORTANT: Compute nRMSE in ORIGINAL scale, not normalized
preds_orig = denormalize(preds)
targets_orig = denormalize(targets)
```

## nRMSE Metric (Standard PDE Benchmark Definition)

**WARNING:** Multiple valid nRMSE formulas exist and can differ by up to 5-10%. Always compute BOTH and verify you beat baselines under both.

```python
def calc_nrmse_pertimestep(preds, targets, init_step=10):
    """Per-timestep RMSE/RMS, averaged over (N, C, T). Common in code implementations."""
    p = preds[:, :, init_step:, :].permute(0, 3, 1, 2)   # [N, C, X, T]
    tg = targets[:, :, init_step:, :].permute(0, 3, 1, 2)
    err = torch.sqrt(torch.mean((p - tg)**2, dim=2))  # RMSE per (sample, channel, time)
    nrm = torch.sqrt(torch.mean(tg**2, dim=2)) + 1e-20
    return torch.mean(err / nrm).item()

def calc_nrmse_frobenius(preds, targets, init_step=10):
    """Per-sample Frobenius norm ratio. Canonical PDEBench definition."""
    p = preds[:, :, init_step:, :]
    tg = targets[:, :, init_step:, :]
    per_sample = torch.sqrt(((p - tg)**2).sum(dim=(1,2,3))) / \
                 (torch.sqrt((tg**2).sum(dim=(1,2,3))) + 1e-20)
    return per_sample.mean().item()

# Report BOTH in results.json:
# {"nrmse_pertimestep": X, "nrmse_frobenius": Y, "metric_note": "Both beat baseline"}
```

## Train/Val/Test Split (Critical for Methods Papers)

```python
N_TRAIN, N_VAL, N_TEST = 8000, 1000, 1000
train_data = data[:N_TRAIN]
val_data = data[N_TRAIN:N_TRAIN+N_VAL]      # Checkpoint selection
test_data = data[N_TRAIN+N_VAL:]              # Final metric (evaluated ONCE)

# During training: evaluate on val_loader for model selection
# After training: evaluate on test_loader ONCE for final reported number
```

## Common Pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Teacher forcing during training | Good train loss, terrible rollout | Use autoregressive training |
| Data layout [N,T,X] not [N,X,T] | Model doesn't converge | Transpose before creating DataLoader |
| No per-channel normalization | One variable dominates loss | Normalize each channel independently |
| Missing noise injection | Rollout diverges after ~10 steps | Add σ=1e-3 noise during training |
| Model selection on test set | Optimistic reported metrics | Use separate validation split |
| Accumulating loss with retain_graph | GPU OOM | loss.backward() once after full rollout |
