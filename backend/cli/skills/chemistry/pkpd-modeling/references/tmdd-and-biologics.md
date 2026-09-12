# Target-mediated drug disposition and biologics PK

## The full TMDD model

When a drug binds its target with high affinity and the target is present at a concentration
comparable to the drug's, binding is not just pharmacology — it is a clearance pathway.

```
dL/dt  = In - kel*L - kon*L*R + koff*RL          free drug
dR/dt  = ksyn - kdeg*R - kon*L*R + koff*RL       free target
dRL/dt = kon*L*R - (koff + kint)*RL              complex
```

The characteristic profile has four phases: a rapid initial drop as the target is bound, a slower
linear phase while the target is saturated, a steep terminal drop as drug falls below target
capacity and target-mediated clearance resumes, and a final linear phase. **Dose-normalised
profiles that do not superimpose, with the low dose disappearing faster, is the signature.**

The model is stiff by construction — `kon` is typically 10³ to 10⁶ times `kel` — which is why
`_models.simulate_tmdd()` uses LSODA rather than a fixed-step explicit method.

## Approximations, in order of increasing assumption

| Approximation | Assumes | Parameters |
| --- | --- | --- |
| Full | Nothing | `kon`, `koff`, `kint`, `ksyn`, `kdeg`, `kel`, `V` |
| Rapid binding (QE) | Binding at equilibrium: `Kd = koff/kon` | replaces `kon`, `koff` with `Kd` |
| Quasi-steady-state (QSS) | Complex at steady state: `Kss = (koff + kint)/kon` | replaces `kon`, `koff` with `Kss` |
| Michaelis-Menten | Target dynamics fast and target constant | `Vmax`, `Km` — loses all target information |
| Wagner / constant Rtot | Total target constant | |
| Irreversible binding (IB) | `koff` negligible | |

**QSS is the usual practical choice.** The full model is rarely identifiable from plasma drug
concentrations alone: `kon` and `koff` appear almost exclusively as their ratio, and estimating them
separately requires target or complex measurements. Pharmpy 2.1.1 exposes exactly this hierarchy —
`set_tmdd(model, type=...)` accepts `'full'`, `'ib'`, `'cr'`, `'crib'`, `'qss'`, `'wagner'` and
`'mmapp'`, with `dv_types` to map observations to drug, total drug, target, total target, or
complex.

**Which quantity was measured is a first-order question.** A ligand-binding assay typically reports
**total** drug (free + complex), while the model's natural state is free drug. Fitting a total-drug
observation to a free-drug prediction produces a badly wrong Kd, and nothing in the fit statistics
reveals it. `_models.simulate_tmdd()` returns free drug, free target, complex and total drug
separately for this reason.

## Monoclonal antibody pharmacokinetics

Typical IgG behaviour, useful as a sanity check on any fitted mAb model:

| Property | Typical value |
| --- | --- |
| Clearance | 0.1-0.5 L/day (linear component) |
| Central volume | ~3 L, close to plasma volume |
| Vss | 5-10 L; distribution is largely confined to plasma and interstitial fluid |
| Terminal half-life | 2-4 weeks for a typical IgG1 |
| Subcutaneous bioavailability | 50-80% |
| Time to SC Tmax | 2-8 days |

Mechanisms that matter:

- **FcRn recycling** is what gives IgG its long half-life. Antibodies engineered for higher FcRn
  affinity at endosomal pH (YTE, LS mutations) extend half-life several-fold.
- **Catabolism** is nonspecific proteolysis, not renal or hepatic clearance. Renal impairment does
  not meaningfully change mAb clearance; molecules below ~60 kDa are a different story.
- **Target-mediated clearance** dominates at low doses; the drug looks nonlinear until the target
  is saturated.
- **Subcutaneous absorption** is via the lymphatics, slow and incomplete, and produces flip-flop
  kinetics: the apparent terminal slope after SC dosing can reflect absorption.

Allometric exponents for mAbs are often closer to 0.85-0.9 for clearance and near 1.0 for volume
rather than the small-molecule 0.75.

## Immunogenicity

Anti-drug antibodies increase clearance, sometimes by an order of magnitude, and typically appear
after weeks. Handling in a model:

- Treat ADA status as a **time-varying** covariate, not a baseline one. A subject who seroconverts
  at week 8 has two different clearances in one profile.
- ADA-positive subjects often show a bimodal concentration distribution rather than a shifted one;
  a covariate on clearance may fit poorly where a mixture model fits well.
- Neutralising versus binding ADA, and titre, matter more than the binary status.
- Assay drug tolerance limits ADA detection when drug is present, so ADA-negative at trough is not
  the same as ADA-negative.

## Antibody-drug conjugates

An ADC needs at least three analytes modelled, and they answer different questions:

- **ADC** (conjugated antibody) — the dosed entity
- **Total antibody** (conjugated + unconjugated) — the deconjugation rate is the difference
- **Unconjugated payload** — usually drives systemic toxicity

Drug-to-antibody ratio changes over time as the conjugate deconjugates, so "the ADC" is a
distribution of species, not one molecule. Payload exposure is generally the safety-relevant
metric.

## Bispecifics and cell engagers

Ternary complex formation (drug + target + effector) is not captured by standard TMDD. The
concentration-effect relationship is typically **bell-shaped**: at high concentrations the drug
saturates both arms separately and forms fewer ternary complexes ("hook effect"). A monotone Emax
model fitted to such data will mislead about the optimal dose in exactly the region that matters.

## Practical guidance

- Do not fit a full TMDD model to plasma drug data alone. Start with QSS; move up only if target or
  complex measurements exist.
- Check dose-normalised profiles first. If they superimpose across the clinical dose range, TMDD is
  saturated throughout and a linear model is adequate for that range — but it will not extrapolate
  to lower doses.
- Baseline target concentration `R0 = ksyn/kdeg` is often measurable and should be fixed to the
  measurement rather than estimated.
- Report which analyte each observation is. This single piece of metadata resolves more confused
  biologics models than any structural change.
