---
name: pinn-training
description: Train Physics-Informed Neural Networks (PINNs) using DeepXDE. Solve forward and inverse PDE problems by embedding physics equations into the neural network loss function. Supports 1D/2D/3D, time-dependent, and parametric PDEs.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [PINN, DeepXDE, Neural Network, PDE, Inverse Problem, Physics-Informed]
dependencies: ["deepxde>=1.12.0", "numpy>=1.24.0", "matplotlib>=3.7.0"]
---

# PINN Training (DeepXDE)

## Overview

Solve PDEs using Physics-Informed Neural Networks. A neural network approximates the solution u(x,t), trained by minimizing the PDE residual + boundary/initial condition losses. Works for forward problems (solve PDE) and inverse problems (discover parameters from data).

## When to Use

- Complex geometries where meshing is difficult
- Inverse problems (discovering PDE parameters from data)
- Noisy or sparse data with known governing equations
- Multi-physics problems with coupled PDEs
- When you need a differentiable surrogate of the PDE solution

## Do NOT Use When

- Simple 1D/2D problems on regular grids (use finite differences — faster)
- You need guaranteed error bounds (PINNs don't provide rigorous bounds)
- Very high accuracy is needed (< 1e-6 relative error is hard for PINNs)

## Installation

```bash
pip install deepxde
# DeepXDE auto-detects backend: TensorFlow, PyTorch, or JAX
# Set backend: export DDE_BACKEND=pytorch
```

## Core Workflows

### 1. Forward Problem: 1D Heat Equation

$$\frac{\partial u}{\partial t} = \alpha \frac{\partial^2 u}{\partial x^2}$$

```python
import deepxde as dde
import numpy as np

alpha = 0.01  # thermal diffusivity

def pde(x, u):
    """Heat equation residual: u_t - alpha * u_xx = 0"""
    du_t = dde.grad.jacobian(u, x, i=0, j=1)   # du/dt
    du_xx = dde.grad.hessian(u, x, i=0, j=0)    # d²u/dx²
    return du_t - alpha * du_xx

# Domain: x in [0, 1], t in [0, 1]
geom = dde.geometry.Interval(0, 1)
timedomain = dde.geometry.TimeDomain(0, 1)
geomtime = dde.geometry.GeometryXTime(geom, timedomain)

# Boundary conditions: u(0,t) = u(1,t) = 0
bc = dde.icbc.DirichletBC(geomtime, lambda x: 0,
                           lambda x, on_boundary: on_boundary)

# Initial condition: u(x,0) = sin(pi*x)
ic = dde.icbc.IC(geomtime, lambda x: np.sin(np.pi * x[:, 0:1]),
                  lambda x, on_initial: on_initial)

# Collocation points
data = dde.data.TimePDE(geomtime, pde, [bc, ic],
                         num_domain=2000, num_boundary=100,
                         num_initial=100, num_test=500)

# Neural network: 2 inputs (x,t) → 1 output (u)
net = dde.nn.FNN([2] + [64]*3 + [1], "tanh", "Glorot uniform")

model = dde.Model(data, net)

# Train: Adam first, then L-BFGS for fine-tuning
model.compile("adam", lr=1e-3)
losshistory, train_state = model.train(epochs=10000, display_every=2000)

model.compile("L-BFGS")
losshistory, train_state = model.train()

# Evaluate
x_test = np.linspace(0, 1, 100)
t_test = np.array([0.1, 0.3, 0.5, 0.8])
for t_val in t_test:
    X = np.column_stack([x_test, np.full_like(x_test, t_val)])
    u_pred = model.predict(X)
    u_exact = np.sin(np.pi * x_test) * np.exp(-alpha * np.pi**2 * t_val)
    error = np.max(np.abs(u_pred.flatten() - u_exact))
    print(f"t={t_val:.1f}: max error = {error:.4e}")
```

### 2. Inverse Problem: Discover Diffusion Coefficient

```python
# Given noisy measurements of u(x,t), find alpha
alpha_var = dde.Variable(0.05)  # initial guess, will be optimized

def pde_inverse(x, u):
    du_t = dde.grad.jacobian(u, x, i=0, j=1)
    du_xx = dde.grad.hessian(u, x, i=0, j=0)
    return du_t - alpha_var * du_xx

# Add observation data
def generate_data(n_obs=50):
    x_obs = np.random.rand(n_obs, 1)
    t_obs = np.random.rand(n_obs, 1) * 0.5
    u_obs = np.sin(np.pi * x_obs) * np.exp(-0.01 * np.pi**2 * t_obs)
    u_obs += 0.01 * np.random.randn(n_obs, 1)  # noise
    return np.hstack([x_obs, t_obs]), u_obs

observe_x, observe_u = generate_data()
observe_bc = dde.icbc.PointSetBC(observe_x, observe_u)

data = dde.data.TimePDE(geomtime, pde_inverse, [bc, ic, observe_bc],
                         num_domain=2000, num_boundary=100,
                         num_initial=100)

net = dde.nn.FNN([2] + [64]*3 + [1], "tanh", "Glorot uniform")
model = dde.Model(data, net)
model.compile("adam", lr=1e-3, external_trainable_variables=[alpha_var])
model.train(epochs=20000, display_every=5000)
model.compile("L-BFGS", external_trainable_variables=[alpha_var])
model.train()

print(f"Discovered alpha = {alpha_var.numpy():.6f} (true: 0.01)")
```

### 3. 2D Poisson Equation

```python
def pde_poisson(x, u):
    du_xx = dde.grad.hessian(u, x, i=0, j=0)
    du_yy = dde.grad.hessian(u, x, i=1, j=1)
    # Source term: -2pi^2 sin(pi*x)*sin(pi*y)
    f = -2 * np.pi**2 * np.sin(np.pi * x[:, 0:1]) * np.sin(np.pi * x[:, 1:2])
    return du_xx + du_yy - f

geom = dde.geometry.Rectangle([0, 0], [1, 1])
bc = dde.icbc.DirichletBC(geom, lambda x: 0, lambda x, on_boundary: on_boundary)

data = dde.data.PDE(geom, pde_poisson, [bc], num_domain=2000, num_boundary=200)
net = dde.nn.FNN([2] + [64]*4 + [1], "tanh", "Glorot uniform")
model = dde.Model(data, net)
model.compile("adam", lr=1e-3)
model.train(epochs=15000)
model.compile("L-BFGS")
model.train()
```

## Training Strategy

| Phase | Optimizer | Epochs | Learning Rate | Purpose |
|---|---|---|---|---|
| 1 | Adam | 10,000-30,000 | 1e-3 | Get near the minimum |
| 2 | L-BFGS | until convergence | auto | Fine-tune to high accuracy |

## Network Architecture Guide

| PDE Complexity | Architecture | Activation |
|---|---|---|
| Simple 1D/2D | `[2] + [32]*3 + [1]` | tanh |
| Moderate 2D | `[2] + [64]*4 + [1]` | tanh |
| Complex / 3D | `[3] + [128]*5 + [1]` | tanh or sin |
| Time-dependent | `[2] + [64]*4 + [1]` with causal training | tanh |

## Common Pitfalls

| Pitfall | Fix |
|---|---|
| Loss doesn't decrease | Reduce learning rate, increase network size |
| BC/IC loss much larger than PDE loss | Use loss weights: `model.compile(..., loss_weights=[1, 100, 100])` |
| Solution is flat/constant | Check PDE implementation (sign errors common) |
| Training unstable | Use `tanh` activation (not ReLU), reduce LR |
| Inverse problem doesn't converge | Need more observation data, better initial guess |
| Slow training | Use GPU: `export DDE_BACKEND=pytorch` + CUDA |
