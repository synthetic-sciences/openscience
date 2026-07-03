---
name: shock-capturing-neural-operators
description: Architectures and techniques for neural operators on discontinuous PDE solutions (shocks, contact discontinuities, steep gradients). Covers local-global spectral design (ShockFNO), reflection padding for non-periodic BCs, resolution scaling for shock width, and frequency-band error diagnostics. Use for low-viscosity Burgers, compressible Euler, Riemann problems, or any PDE where standard FNO produces Gibbs oscillations.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Neural Operator, FNO, Shocks, Gibbs, Discontinuity, Boundary Conditions, Spectral]
dependencies: ["torch>=2.1.0", "numpy>=1.24.0"]
---

# Shock-Capturing Neural Operators

## When to Use
- PDE solutions with shocks, contact discontinuities, or steep gradients
- Low-viscosity Burgers, compressible Euler, Riemann problems
- Non-periodic boundary conditions (outgoing, transmissive, Dirichlet)
- Any problem where standard FNO produces Gibbs-like oscillations

## The Fundamental Problem: Gibbs Phenomenon in FNO

Standard FNO uses FFT → truncate modes → iFFT. For discontinuous functions, Fourier coefficients decay as O(1/k), producing oscillatory artifacts near discontinuities regardless of mode count. This is the Gibbs phenomenon — a mathematical limitation, not a training problem.

**Impact:** FNO nRMSE degrades 10× going from smooth to shock problems (e.g., Burgers ν=0.1: 2.9e-3 vs ν=0.001: 2.9e-2).

## Solution 1: Local-Global Architecture (ShockFNO)

Add a parallel local convolution branch alongside the spectral path. Local conv captures sharp features without spectral artifacts.

```python
class FNOBlock(nn.Module):
    """Gated local-global spectral block."""
    def __init__(self, width, modes, local_kernel=7):
        super().__init__()
        self.spectral = SpectralConv1d(width, width, modes)  # Global (FFT)
        self.pointwise = nn.Conv1d(width, width, 1)           # Bias path
        self.local_conv = nn.Conv1d(width, width, local_kernel,
                                     padding=local_kernel//2)  # Local (shock-scale)
        self.gate = nn.Parameter(torch.tensor(0.3))            # Learned balance

    def forward(self, x):
        global_out = self.spectral(x) + self.pointwise(x)
        local_out = self.local_conv(x)
        alpha = torch.sigmoid(self.gate)
        return (1 - alpha) * global_out + alpha * local_out
```

**Design choices:**
- `local_kernel=7`: Covers ~7 grid cells. For 1024-pt grid with shock width ~1 cell, this captures the shock + immediate neighborhood.
- `gate` initialized at 0.3 (sigmoid → ~0.57): starts slightly favoring global, learns to balance per-layer.
- In trained models, gate values converge to 0.3-0.6 across layers — both branches contribute.

**Inspired by:** LOGLO-FNO (arXiv:2504.04260), but simplified: standard Conv1d instead of local spectral convolutions, scalar gate instead of spatial attention.

## Solution 2: Reflection Padding for Non-Periodic BCs

Standard FNO uses FFT which assumes periodicity. For outgoing/transmissive BCs, waves that exit the domain re-enter from the opposite side in Fourier space.

```python
class ShockTubeFNO1d(nn.Module):
    def __init__(self, ..., pad_size=32):
        self.pad_size = pad_size
        # ... standard FNO layers ...

    def forward(self, x, grid):
        x = self.fc0(x).permute(0, 2, 1)  # [B, W, X]

        # REFLECTION PADDING before spectral layers
        x = F.pad(x, [self.pad_size, self.pad_size], mode='reflect')

        for block in self.blocks:
            x = block(x)

        # Remove padding after spectral layers
        x = x[:, :, self.pad_size:-self.pad_size]

        return self.projection(x)
```

**Why reflection padding works:**
- Creates a smooth continuation at boundaries (unlike zero-padding which introduces a jump)
- Reduces spectral leakage from boundary discontinuities
- `pad_size=32` on 256-point grid = ~12.5% extension — substantial

**Comparison:**
- Standard FNO: 2-point zero padding (0.2% extension) — nearly useless
- Our approach: 32-point reflection (12.5%) — meaningful improvement
- Optimal: Fourier Continuation (FC-PINO, arXiv:2211.15960) — polynomial continuation to periodic domain

## Solution 3: Resolution Scaling

For shocks, resolution is the single biggest factor. Shock width ≈ ν/U for viscous problems.

| Viscosity ν | Shock Width | Min Grid Points | Recommendation |
|---|---|---|---|
| 0.1 | ~0.1 | ~100 | 256 is fine |
| 0.01 | ~0.01 | ~1000 | 512 minimum, 1024 better |
| 0.001 | ~0.001 | ~10000 | 1024 (full native), needs A100 |
| inviscid | 0 (true discontinuity) | ∞ | As high as possible; 256-1024 |

**Memory scaling:** Doubling resolution roughly doubles memory and compute per epoch.

## Frequency-Band Error Analysis

Diagnostic tool: decompose prediction error by wavenumber to identify where FNO fails.

```python
def frequency_band_errors(pred, target, bands={"low": (0, 5), "mid": (5, 13), "high": (13, None)}):
    """Compute relative spectral error per frequency band."""
    pred_ft = torch.fft.rfft(pred, dim=1)
    tgt_ft = torch.fft.rfft(target, dim=1)
    n_modes = pred_ft.shape[1]

    errors = {}
    for name, (lo, hi) in bands.items():
        hi = hi or n_modes
        err = torch.abs(pred_ft[:, lo:hi] - tgt_ft[:, lo:hi]).mean().item()
        nrm = torch.abs(tgt_ft[:, lo:hi]).mean().item() + 1e-20
        errors[name] = {"abs": err, "rel": err / nrm}
    return errors
```

**Typical results for shock problems:**
- Low band (k=0-4): rel error ~0.1% — excellent (large-scale structure captured)
- Mid band (k=5-12): rel error ~5-10% — moderate (shock-scale features)
- High band (k≥13): rel error ~30% — worst (Gibbs-dominated)

This analysis reveals the fundamental spectral limit and motivates wavelet-based approaches.

## Architecture Selection for Different Shock Problems

| Problem | Architecture | Key Features |
|---|---|---|
| Moderate viscosity (ν=0.01-0.1) | Enhanced FNO | More modes (32), H1 loss, noise injection |
| Low viscosity (ν≤0.001) | ShockFNO | Local conv branch, freq loss, full resolution |
| Multi-variable shocks (Euler, NS) | MultiFNO + ShockFNO | Per-channel normalization + local conv |
| Non-periodic BCs (outgoing) | ShockTubeFNO | Reflection padding + boundary loss |
| Riemann problems (shock tube) | ShockTubeFNO | All of the above |

## Future Directions (from literature)

| Approach | Reference | Promise |
|---|---|---|
| Wavelet Neural Operator (WNO) | — | Wavelets naturally represent discontinuities |
| Fourier Continuation (FC-PINO) | arXiv:2211.15960 | Principled non-periodic extension |
| Convolutional Neural Operator (CNO) | NeurIPS 2023 | No spectral assumption at all |
| Godunov loss functions | arXiv:2405.11674 | Entropy-satisfying shock capture |
| DCT/DST replacement for FFT | arXiv:2507.21757 | Non-periodic spectral methods |
