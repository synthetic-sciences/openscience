---
name: neural-operator
description: Train neural operators (FNO, DeepONet) to learn solution maps for parametric PDE families. Once trained, solve new PDE instances in milliseconds. Use when you need to solve many instances of the same PDE with different parameters/ICs/BCs.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Neural Operator, FNO, DeepONet, PDE, Surrogate Model, Deep Learning]
dependencies: ["neuraloperator>=0.3.0", "torch>=2.1.0", "numpy>=1.24.0", "matplotlib>=3.7.0"]
---

# Neural Operators (FNO / DeepONet)

## Overview

Neural operators learn mappings between function spaces — given an input function (initial condition, forcing, boundary), they predict the output function (PDE solution). Once trained on a dataset of PDE solutions, they solve new instances in milliseconds.

## When to Use

- You need to solve the SAME PDE many times with different parameters
- Real-time predictions needed (design optimization, control)
- Building a surrogate model for expensive simulations
- The PDE family is known but expensive to solve numerically

## Do NOT Use When

- Solving a single PDE instance (use `pde-solver` — faster)
- You don't have training data (solve the PDE a few hundred times first)
- You need high accuracy (< 0.1% error is hard for neural operators)
- The PDE changes fundamentally between instances (different physics)

## Installation

```bash
pip install neuraloperator torch
```

## Core Workflows

### 1. Fourier Neural Operator (FNO) — 1D Burgers Equation

```python
import torch
import numpy as np
from neuraloperator.models import FNO1d
from neuraloperator.datasets import load_darcy_flow_small
import matplotlib.pyplot as plt

# Generate training data: Burgers equation solutions
# u_t + u*u_x = nu*u_xx, x in [0, 2pi], periodic BC
from scipy.integrate import solve_ivp
from scipy.fft import fft, ifft, fftfreq

def solve_burgers(u0, nu=0.01, T=1.0, N=256, dt=0.001):
    """Solve Burgers equation using pseudospectral method."""
    dx = 2*np.pi / N
    x = np.linspace(0, 2*np.pi, N, endpoint=False)
    k = fftfreq(N, d=dx) * 2*np.pi

    def rhs(t, u_hat):
        u = np.real(ifft(u_hat))
        u_x = np.real(ifft(1j * k * u_hat))
        return -fft(u * u_x) - nu * k**2 * u_hat

    u0_hat = fft(u0)
    sol = solve_ivp(rhs, (0, T), u0_hat, method='RK45',
                    rtol=1e-8, atol=1e-10)
    return np.real(ifft(sol.y[:, -1]))

# Generate dataset
N = 256
n_train = 500
n_test = 100
x = np.linspace(0, 2*np.pi, N, endpoint=False)

# Random initial conditions (sum of random Fourier modes)
np.random.seed(42)
inputs = []
outputs = []
for i in range(n_train + n_test):
    # Random IC: sum of low-frequency modes
    u0 = np.zeros(N)
    for k in range(1, 8):
        u0 += np.random.randn() * np.sin(k*x) + np.random.randn() * np.cos(k*x)
    u0 *= 0.5
    u_final = solve_burgers(u0)
    inputs.append(u0)
    outputs.append(u_final)

inputs = np.array(inputs)
outputs = np.array(outputs)

# Convert to PyTorch tensors
x_train = torch.tensor(inputs[:n_train], dtype=torch.float32).unsqueeze(-1)
y_train = torch.tensor(outputs[:n_train], dtype=torch.float32).unsqueeze(-1)
x_test = torch.tensor(inputs[n_train:], dtype=torch.float32).unsqueeze(-1)
y_test = torch.tensor(outputs[n_train:], dtype=torch.float32).unsqueeze(-1)

print(f"Training data: {x_train.shape} → {y_train.shape}")
print(f"Test data: {x_test.shape} → {y_test.shape}")
```

### 2. Training the FNO

```python
# Define FNO model
model = FNO1d(
    n_modes_height=16,        # Fourier modes to keep
    hidden_channels=64,       # channel width
    in_channels=1,            # input function dimension
    out_channels=1,           # output function dimension
    n_layers=4,               # number of FNO layers
)

optimizer = torch.optim.Adam(model.parameters(), lr=1e-3, weight_decay=1e-5)
scheduler = torch.optim.lr_scheduler.StepLR(optimizer, step_size=100, gamma=0.5)

# Training loop
n_epochs = 500
batch_size = 32

for epoch in range(n_epochs):
    model.train()
    perm = torch.randperm(n_train)
    total_loss = 0
    n_batches = 0

    for i in range(0, n_train, batch_size):
        idx = perm[i:i+batch_size]
        x_batch = x_train[idx]
        y_batch = y_train[idx]

        pred = model(x_batch)
        loss = torch.nn.functional.mse_loss(pred, y_batch)

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

        total_loss += loss.item()
        n_batches += 1

    scheduler.step()

    if (epoch + 1) % 50 == 0:
        # Test error
        model.eval()
        with torch.no_grad():
            pred_test = model(x_test)
            test_loss = torch.nn.functional.mse_loss(pred_test, y_test)
            # Relative L2 error
            rel_err = torch.mean(
                torch.norm(pred_test - y_test, dim=1) / torch.norm(y_test, dim=1)
            )
        print(f"Epoch {epoch+1}: train_loss={total_loss/n_batches:.4e}, "
              f"test_loss={test_loss:.4e}, rel_L2={rel_err:.4f}")
```

### 3. DeepONet (Branch-Trunk Architecture)

```python
# DeepONet: separate networks for input function (branch) and query location (trunk)

class DeepONet(torch.nn.Module):
    def __init__(self, branch_input_dim, trunk_input_dim, hidden_dim=128, p=64):
        super().__init__()
        # Branch net: processes input function (sampled at fixed sensors)
        self.branch = torch.nn.Sequential(
            torch.nn.Linear(branch_input_dim, hidden_dim),
            torch.nn.Tanh(),
            torch.nn.Linear(hidden_dim, hidden_dim),
            torch.nn.Tanh(),
            torch.nn.Linear(hidden_dim, p),
        )
        # Trunk net: processes query location
        self.trunk = torch.nn.Sequential(
            torch.nn.Linear(trunk_input_dim, hidden_dim),
            torch.nn.Tanh(),
            torch.nn.Linear(hidden_dim, hidden_dim),
            torch.nn.Tanh(),
            torch.nn.Linear(hidden_dim, p),
        )
        self.bias = torch.nn.Parameter(torch.zeros(1))

    def forward(self, u_input, x_query):
        """
        u_input: (batch, n_sensors) — input function values at sensor locations
        x_query: (batch, n_query, dim) — query locations
        Returns: (batch, n_query) — predicted output function values
        """
        b = self.branch(u_input)  # (batch, p)
        t = self.trunk(x_query)   # (batch, n_query, p)
        # Dot product + bias
        out = torch.einsum('bp,bqp->bq', b, t) + self.bias
        return out

# Usage:
# n_sensors = 100 (fixed sensor locations for input function)
# model = DeepONet(branch_input_dim=100, trunk_input_dim=1)
# pred = model(u_sensors, x_query)  # u_sensors: (B, 100), x_query: (B, N, 1)
```

### 4. Evaluation and Visualization

```python
model.eval()
with torch.no_grad():
    pred = model(x_test)

# Plot 3 random test examples
fig, axes = plt.subplots(1, 3, figsize=(15, 4))
for i, ax in enumerate(axes):
    idx = np.random.randint(n_test)
    ax.plot(x, x_test[idx, :, 0].numpy(), 'b-', label='Input IC')
    ax.plot(x, y_test[idx, :, 0].numpy(), 'k-', linewidth=2, label='True')
    ax.plot(x, pred[idx, :, 0].numpy(), 'r--', linewidth=2, label='FNO')
    ax.set_xlabel('x')
    ax.set_ylabel('u')
    ax.legend(fontsize=9)
    ax.grid(True, alpha=0.3)
    rel = torch.norm(pred[idx] - y_test[idx]) / torch.norm(y_test[idx])
    ax.set_title(f'Test {idx}: rel. error = {rel:.3f}')

plt.suptitle('FNO: Burgers Equation', fontsize=14)
plt.tight_layout()
plt.savefig('fno_predictions.png', dpi=150, bbox_inches='tight')
```

## Architecture Selection Guide

| Architecture | Best For | Input | Limitations |
|---|---|---|---|
| **FNO** | Regular grids, periodic BCs | Full field on grid | Fixed resolution, periodic |
| **DeepONet** | Irregular data, different resolutions | Function at sensors + query points | Needs sensor placement |
| **GNO** (Graph NO) | Unstructured meshes, complex geometry | Graph-structured data | More complex implementation |

## Key Hyperparameters (FNO)

| Parameter | Typical Range | Effect |
|---|---|---|
| `n_modes` | 8-32 | Fourier modes kept (frequency resolution) |
| `hidden_channels` | 32-128 | Network width |
| `n_layers` | 4-6 | Network depth |
| Learning rate | 1e-3 to 1e-4 | Standard Adam |
| Batch size | 16-64 | Larger is more stable |
| Training samples | 500-5000 | More data = better generalization |

## Tips

1. **Generate training data** using traditional solvers (finite differences, spectral, FEM)
2. **Normalize inputs and outputs** to zero mean, unit variance
3. **Start with FNO** for regular grids — it's the simplest and most robust
4. **Use relative L2 error** as the metric, not MSE (scale-invariant)
5. **Test on out-of-distribution inputs** to check generalization limits

## Troubleshooting

| Symptom | Fix |
|---|---|
| Training loss doesn't decrease | Reduce LR, increase network size, check data loading |
| Good train, bad test error | Overfitting — add weight decay, reduce model size, get more data |
| Predictions are smooth but wrong | Too few Fourier modes — increase `n_modes` |
| GPU out of memory | Reduce batch size or `hidden_channels` |
| Resolution mismatch train/test | FNO supports different resolutions if trained properly |
