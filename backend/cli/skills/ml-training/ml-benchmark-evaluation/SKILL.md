---
name: ml-benchmark-evaluation
description: Rigorous methodology for evaluating ML models on established benchmarks. Covers proper train/val/test splits, baseline verification from original papers, exact metric formula discrepancies, data-leak detection checklist, multi-seed robustness, and honest reporting templates. Use when claiming to beat published baselines, writing methods papers, or auditing existing results.
category: ml-training
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [Evaluation, Benchmark, Validation, Train-Val-Test, Metrics, Data Leak, Reproducibility]
dependencies: ["torch", "numpy"]
---

# ML Benchmark Evaluation — Rigorous Methodology

## When to Use
- Claiming to beat published baselines on any ML benchmark
- Writing a methods paper that compares against prior work
- Any ML evaluation where the reported number matters for publication
- Auditing existing results for overfitting or data leakage

## The Golden Rule

**Your evaluation protocol must be AT LEAST as rigorous as the baseline you claim to beat. Ideally, stricter.**

## 1. Train/Val/Test Split

### The Wrong Way (common but weak):
```python
train = data[:9000]   # 90%
test = data[9000:]    # 10% — used for BOTH model selection AND final metric
# Problem: model selection on test set inflates reported performance
```

### The Right Way:
```python
N_TRAIN, N_VAL, N_TEST = 8000, 1000, 1000
train = data[:N_TRAIN]                          # Gradient updates
val = data[N_TRAIN:N_TRAIN+N_VAL]               # Model selection (checkpoints)
test = data[N_TRAIN+N_VAL:N_TRAIN+N_VAL+N_TEST] # Final metric (ONCE)

# During training:
if epoch % 50 == 0:
    val_metric = evaluate(model, val_loader)  # NOT test_loader
    if val_metric < best_val_metric:
        save_checkpoint(model)

# After training (ONCE):
model = load_best_checkpoint()
final_metric = evaluate(model, test_loader)  # This is the reported number
```

### When the Benchmark Doesn't Use Val Split:
Many benchmarks (PDEBench, some Kaggle, older CV benchmarks) don't use validation splits. When claiming to beat them:
1. Report results using **their protocol** for fair comparison
2. ALSO report results using **proper val split** for scientific rigor
3. Be transparent about both numbers in the paper

## 2. Verify Published Baselines (NEVER Trust Task Descriptions)

Published numbers can be wrong in secondary sources. Always verify from the original paper.

```bash
# Download and parse the original paper
wget -O paper.pdf "https://arxiv.org/pdf/XXXX.XXXXX"
npm i -g @llamaindex/liteparse
liteparse parse paper.pdf -o paper_parsed.md
grep "nRMSE\|accuracy\|F1" paper_parsed.md
```

**Common discrepancies found in practice:**
- Task specification says 5.9e-3 but paper says 9.7e-3 (wrong table, wrong metric)
- Baseline from a different parameter setting or model configuration
- RMSE vs nRMSE vs MSE confusion
- Different train/test split than claimed

## 3. Data Leak Detection Checklist

Run these 6 checks before reporting any result:

```python
# Check 1: IC window preserved exactly (for time-series / PDE problems)
assert np.allclose(preds[:,:,:INIT_STEP], targets[:,:,:INIT_STEP], atol=1e-10)

# Check 2: Predictions differ from targets in predicted window
assert not np.allclose(preds[:,:,INIT_STEP:], targets[:,:,INIT_STEP:], atol=1e-6)

# Check 3: No duplicate samples between train and test
train_hashes = set(hash(x.tobytes()) for x in train_data)
test_hashes = set(hash(x.tobytes()) for x in test_data)
assert len(train_hashes & test_hashes) == 0

# Check 4: Test set never used for gradients
# Verify by code inspection: test_loader only in torch.no_grad() blocks

# Check 5: No NaN/Inf in predictions
assert not np.isnan(preds).any() and not np.isinf(preds).any()

# Check 6: Error distribution is realistic
# If min error is near-zero for many samples, suspicious
assert (per_sample_error < 1e-6).mean() < 0.01  # <1% near-perfect
```

## 4. Metric Computation (Get It Exactly Right)

Different benchmarks use different metrics. Verify the EXACT formula from the benchmark code.

```python
# Example: PDEBench nRMSE
def calc_nrmse(preds, targets, init_step):
    """PDEBench nRMSE: per-timestep spatial RMSE, normalized, averaged."""
    p = preds[:,:,init_step:,:].permute(0,3,1,2)   # [N, C, X, T]
    tg = targets[:,:,init_step:,:].permute(0,3,1,2)
    err = torch.sqrt(torch.mean((p-tg)**2, dim=2))  # spatial RMSE: [N, C, T]
    nrm = torch.sqrt(torch.mean(tg**2, dim=2)) + 1e-20
    return torch.mean(err / nrm).item()

# ALWAYS cross-check against benchmark's own metrics code
# e.g., pdebench/models/metrics.py
```

### CRITICAL: Metric Formula Discrepancies

The SAME metric name (e.g., "nRMSE") can have multiple valid definitions that give different numbers (up to 5-10% difference):

```python
# Formula A: Per-timestep, then average (common in code implementations)
err_per_t = sqrt(mean_spatial((pred-target)^2))  # [N, C, T]
nrm_per_t = sqrt(mean_spatial(target^2))
nrmse_A = mean(err_per_t / nrm_per_t)  # average over N, C, T

# Formula B: Frobenius norm ratio per sample (canonical PDEBench definition)
nrmse_B = mean_over_N(||pred_i - target_i||_F / ||target_i||_F)

# Formula C: Global RMSE / global RMS
nrmse_C = sqrt(mean_all((pred-target)^2)) / sqrt(mean_all(target^2))
```

**These are NOT equivalent.** For a single benchmark comparison, the difference can be 1-10%. Always:
1. Read the benchmark's actual metrics.py code (not just the paper)
2. Compute your metric using the EXACT same formula
3. If in doubt, report BOTH formulas and show you beat under both
4. Document which formula you used in results.json

## 5. Multi-Seed Robustness

Single-seed results can be lucky. For strong claims:
```python
seeds = [42, 123, 7, 2024, 31415]
results = []
for seed in seeds:
    torch.manual_seed(seed)
    model = train(seed)
    results.append(evaluate(model))

mean = np.mean(results)
std = np.std(results)
print(f"nRMSE = {mean:.4e} ± {std:.4e} (n={len(seeds)} seeds)")
```

**Minimum for publication:** 3 seeds for key results, report mean ± std.

## 6. Honest Reporting Template

```markdown
## Results

| Test | Our nRMSE | Published | Improvement | Seeds | Val Split |
|------|-----------|-----------|-------------|-------|-----------|
| A    | X.Xe-Y ± Z.Ze-Y | P.Pe-Q | N.N× | 3 | Yes (8K/1K/1K) |

### Comparison Fairness Notes:
- Our model uses [more modes / higher resolution / ...] than the baseline
- These confounding factors are documented in Table X
- Ablation study (Table Y) isolates the contribution of each change

### Limitations:
- [List every weakness honestly]
```

## 7. Physics-Informed Validation (for PDE/Scientific ML)

Beyond standard ML metrics, verify physical consistency:

| Check | What to Compute | Pass Criterion |
|---|---|---|
| Conservation laws | Mass/momentum/energy integral over time | Drift < 5% of baseline |
| Physical bounds | Density ≥ 0, Temperature ≥ 0, etc. | Zero violations |
| Symmetry | If PDE has symmetry, solution must respect it | Error < 1% |
| Known limits | Analytical solution exists for special case | Match to <1% |
| Error vs time | nRMSE at each rollout step | No exponential blowup |
| Spectral content | FFT of prediction vs truth | No spurious high-freq |

## Common Pitfalls

| Pitfall | Why It's Wrong | Fix |
|---|---|---|
| Model selection on test set | Optimistic bias (1-10%) | Use validation split |
| Single seed | Could be lucky | Report 3+ seeds with std |
| Trusting secondary baseline numbers | Often wrong | Parse original paper |
| Comparing against wrong metric | RMSE ≠ nRMSE ≠ MSE | Read benchmark code |
| Not reporting confounding factors | Unfair comparison | Table of ALL differences |
| Cherry-picking best epoch | Not reproducible | Report final epoch OR val-selected |
| Hiding failure cases | Dishonest | Show worst-case sample explicitly |
