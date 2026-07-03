---
name: bayesian-inference
description: Bayesian parameter estimation with MCMC (emcee) and probabilistic programming (PyMC). Posterior distributions, corner plots, model evidence, convergence diagnostics. Use when you need full posterior distributions, not just point estimates.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Bayesian, MCMC, Posterior, emcee, PyMC, Inference, Uncertainty, Physics]
dependencies: ["emcee>=3.1.0", "corner>=2.2.0", "scipy>=1.11.0", "numpy>=1.24.0", "matplotlib>=3.7.0"]
---

# Bayesian Inference

## Overview

Full Bayesian parameter estimation using MCMC sampling. Get posterior distributions (not just best-fit values), compute credible intervals, compare models via Bayes factors, and diagnose sampler convergence.

## When to Use

- You need full posterior distributions (not just point estimates)
- Parameters are correlated and you want the joint posterior
- You want to compare models using Bayesian evidence
- Prior information is available and should be incorporated
- Error bars from least-squares seem unreliable

## Do NOT Use When

- A simple `curve_fit` with error bars is sufficient (use `physics-fitting`)
- You have > 20 parameters (consider variational inference instead)
- Likelihood is cheap and you want speed (least-squares is faster)

## Core Workflows

### 1. MCMC with emcee (Ensemble Sampler)

```python
import numpy as np
import emcee
import corner
import matplotlib.pyplot as plt

# Model and data
def model(t, A, gamma, omega):
    return A * np.exp(-gamma * t) * np.cos(omega * t)

t_data = np.linspace(0, 10, 50)
y_true = model(t_data, 2.0, 0.3, 1.5)
y_err = 0.1 * np.ones_like(t_data)
y_data = y_true + y_err * np.random.randn(len(t_data))

# Log-probability = log-prior + log-likelihood
def log_prior(theta):
    A, gamma, omega = theta
    if A < 0 or gamma < 0 or omega < 0:
        return -np.inf
    if A > 10 or gamma > 5 or omega > 10:
        return -np.inf
    return 0.0  # uniform prior within bounds

def log_likelihood(theta, t, y, yerr):
    A, gamma, omega = theta
    y_model = model(t, A, gamma, omega)
    chi2 = np.sum(((y - y_model) / yerr)**2)
    return -0.5 * chi2 - np.sum(np.log(yerr)) - 0.5 * len(y) * np.log(2*np.pi)

def log_probability(theta, t, y, yerr):
    lp = log_prior(theta)
    if not np.isfinite(lp):
        return -np.inf
    return lp + log_likelihood(theta, t, y, yerr)

# Initialize walkers
ndim = 3
nwalkers = 32
p0 = np.array([2.0, 0.3, 1.5]) + 0.01 * np.random.randn(nwalkers, ndim)

# Run sampler
sampler = emcee.EnsembleSampler(nwalkers, ndim, log_probability,
                                 args=(t_data, y_data, y_err))
sampler.run_mcmc(p0, 5000, progress=True)

# Discard burn-in and thin
flat_samples = sampler.get_chain(discard=1000, thin=15, flat=True)
print(f"Effective samples: {flat_samples.shape[0]}")
```

### 2. Corner Plot (Joint Posterior)

```python
labels = [r"$A$", r"$\gamma$", r"$\omega$"]
truths = [2.0, 0.3, 1.5]

fig = corner.corner(flat_samples, labels=labels, truths=truths,
                     quantiles=[0.16, 0.5, 0.84],
                     show_titles=True, title_kwargs={"fontsize": 12})
fig.savefig('corner_plot.png', dpi=150, bbox_inches='tight')

# Print parameter estimates
for i, label in enumerate(labels):
    mcmc = np.percentile(flat_samples[:, i], [16, 50, 84])
    q = np.diff(mcmc)
    print(f"{label} = {mcmc[1]:.4f} (+{q[1]:.4f} / -{q[0]:.4f})")
```

### 3. Convergence Diagnostics

```python
# Trace plots (check mixing)
fig, axes = plt.subplots(ndim, 1, figsize=(10, 7), sharex=True)
chain = sampler.get_chain()
for i in range(ndim):
    axes[i].plot(chain[:, :, i], alpha=0.3, linewidth=0.5)
    axes[i].set_ylabel(labels[i])
    axes[i].axvline(1000, color='red', linestyle='--', label='Burn-in')
axes[-1].set_xlabel('Step')
axes[0].legend(loc='upper right')
plt.savefig('trace_plots.png', dpi=150, bbox_inches='tight')

# Autocorrelation time (convergence diagnostic)
try:
    tau = sampler.get_autocorr_time()
    print(f"Autocorrelation times: {tau}")
    print(f"Chain length / tau: {sampler.iteration / tau}")
    print(f"  (Should be > 50 for reliable results)")
except emcee.autocorr.AutocorrError:
    print("Warning: chain too short for autocorrelation estimate")

# Gelman-Rubin diagnostic (R-hat)
chain_split = sampler.get_chain(discard=1000)  # (steps, walkers, ndim)
n_steps, n_walkers, n_dim = chain_split.shape
# Between-chain variance
chain_means = chain_split.mean(axis=0)  # (walkers, ndim)
B = n_steps * np.var(chain_means, axis=0, ddof=1)
# Within-chain variance
W = np.mean(np.var(chain_split, axis=0, ddof=1), axis=0)
# R-hat
var_est = (1 - 1/n_steps) * W + B / n_steps
R_hat = np.sqrt(var_est / W)
print(f"R-hat: {R_hat}")
print(f"  (Should be < 1.01 for convergence)")
```

### 4. Posterior Predictive Check

```python
# Sample model predictions from the posterior
t_pred = np.linspace(0, 12, 200)
n_samples = 100
idx = np.random.randint(len(flat_samples), size=n_samples)

fig, ax = plt.subplots(figsize=(10, 6))
for i in idx:
    y_pred = model(t_pred, *flat_samples[i])
    ax.plot(t_pred, y_pred, 'r-', alpha=0.05)

ax.errorbar(t_data, y_data, yerr=y_err, fmt='ko', capsize=3, label='Data')
ax.plot(t_pred, model(t_pred, 2.0, 0.3, 1.5), 'b-', linewidth=2, label='True')
ax.set_xlabel('Time [s]')
ax.set_ylabel('y')
ax.set_title('Posterior Predictive Check')
ax.legend()
ax.grid(True, alpha=0.3)
plt.savefig('posterior_predictive.png', dpi=150, bbox_inches='tight')
```

### 5. Model Comparison (Bayes Factor via Harmonic Mean)

```python
# WARNING: Harmonic mean estimator is unreliable for high dimensions.
# For serious model comparison, use nested sampling (dynesty).

# Simple approach: compare max log-likelihood
log_likes_1 = sampler.get_log_prob(discard=1000, flat=True)
print(f"Model 1: max log(L) = {np.max(log_likes_1):.2f}")
print(f"         mean log(L) = {np.mean(log_likes_1):.2f}")

# For proper Bayes factors, use dynesty:
# pip install dynesty
# from dynesty import NestedSampler
# sampler = NestedSampler(log_likelihood, prior_transform, ndim)
# sampler.run_nested()
# results = sampler.results
# print(f"log(Z) = {results.logz[-1]:.2f} ± {results.logzerr[-1]:.2f}")
```

## emcee Tips

1. **nwalkers ≥ 2 × ndim** — minimum, but 4× is better
2. **Burn-in**: Run for 10-20 autocorrelation times, then discard
3. **Thinning**: Thin by ~half the autocorrelation time
4. **Initialization**: Start walkers near the MAP estimate (from curve_fit)
5. **Check convergence**: Trace plots + autocorrelation time + R-hat

## Troubleshooting

| Symptom | Fix |
|---|---|
| Walkers stuck (low acceptance) | Prior too restrictive or likelihood too peaked — reparameterize |
| Very long autocorrelation | Correlated parameters — reparameterize (e.g., log-space) |
| Multimodal posterior | Use parallel tempering or nested sampling |
| Corner plot shows hard edges | Prior bounds too tight — widen them |
| Trace plots show drift | Not converged — run longer or improve initialization |
