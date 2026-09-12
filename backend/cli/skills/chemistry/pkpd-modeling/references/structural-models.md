# Structural PK models: solutions, parameterisations, and the ADVAN map

## Always parameterise in clearance and volume

Micro-constants (`k10`, `k12`, `k21`) and macro-constants (`A`, `alpha`, `B`, `beta`) are outputs,
not parameters to estimate. Clearance and volume are the parameters that:

- have physiological meaning and known covariate relationships (CL scales with weight^0.75,
  V with weight^1.0, CL with renal function);
- are comparable across studies, formulations and populations;
- keep their meaning when a compartment is added — `k10` changes when you add a peripheral
  compartment, `CL` does not.

`_models.py` accepts only `cl, v1, q, vp`. `micro_constants()` converts for reporting.

## Linear mammillary disposition

Any linear model with a central compartment and *n* peripheral compartments has a unit-bolus
impulse response that is a sum of *n+1* exponentials:

```
C(t) = (D) * sum_i  coef_i * exp(lambda_i * t)
```

`_models.disposition()` gets `lambda_i` and `coef_i` by eigendecomposition of the rate matrix
rather than from the textbook quadratic/cubic root formulas. Same answer, no special cases, works
for any number of compartments.

Given that impulse response, every input is a convolution with a closed form:

| Input | Solution |
| --- | --- |
| IV bolus, dose D | `D * sum coef_i exp(lambda_i t)` |
| Infusion, rate R over T | `R * sum (coef_i / -lambda_i)(1 - exp(lambda_i min(t,T))) exp(lambda_i (t - min(t,T)))` |
| First-order absorption, ka | `F*D*ka * sum coef_i (exp(lambda_i t) - exp(-ka t)) / (ka + lambda_i)` |

**The absorption term has a removable singularity at `ka = -lambda_i`.** The limit is
`coef_i * t * exp(lambda_i t)`. This is not an edge case: it is precisely the flip-flop boundary,
and an optimiser walking through it returns `inf` or `nan` without the branch. `_models.py` handles
it; a hand-written Bateman function usually does not.

Useful identities that hold for every linear model, and make good unit tests:

```
AUC(0-inf) after an IV bolus = D / CL          (independent of the number of compartments)
Vss = V1 + sum(Vp)
MRT after an IV bolus = Vss / CL
```

## Flip-flop kinetics

When absorption is slower than elimination (`ka < lambda_z`), the terminal slope of an oral profile
reflects **absorption**, not elimination. The two exponentials are mathematically interchangeable:
the fit is identical if you swap `ka` and `k`. Consequences:

- t½ from an oral profile is the absorption half-life, and Vz/F is meaningless;
- which root the optimiser lands on is a starting-value accident;
- **the assignment cannot be resolved from extravascular data alone.** It needs IV data, or a
  formulation with faster absorption, or an external argument.

`fit_compartmental.py` reports `flip_flop_suspected` and raises a finding. Depot formulations,
extended-release products and subcutaneous biologics are routinely flip-flop.

## Absorption models

| Model | Parameters | Use when |
| --- | --- | --- |
| First-order | `ka` | Default; adequate for most immediate-release oral data |
| First-order with lag | `ka`, `tlag` | A genuine delay before any drug appears; a discontinuous derivative that some estimation methods dislike |
| Zero-order into central | `duration` | Absorption that looks constant-rate; often fits an IR tablet better than expected |
| Sequential zero- then first-order | `duration`, `ka` | Delayed then first-order |
| Transit compartments (Savic) | `MTT`, `n` | Smooth delay; `n` is estimated as a continuous parameter, `ktr = (n+1)/MTT` |
| Weibull | scale, shape | Empirical, flexible, no mechanistic reading |

The transit model must be evaluated with `lgamma`, not a literal factorial: fitted `n` routinely
exceeds 20 and the direct form overflows. `_models.conc_transit()` does this.

A lag time and a transit chain describe the same phenomenon differently. The transit model is
continuous and usually estimates better; the lag is easier to explain. Do not fit both.

## Nonlinear elimination

Michaelis-Menten: `dA/dt = -Vmax * C / (Km + C)`, with `C = A/V1`.

- Below `Km`, clearance is approximately `Vmax/Km` and the drug looks linear;
- above `Km`, clearance falls and exposure rises faster than the dose;
- **superposition is invalid**, so multiple-dose behaviour cannot be derived from a single dose,
  and the accumulation ratio is dose-dependent.

Phenytoin is the classic example: within the therapeutic range a 10% dose increase can produce a
much larger exposure increase. If a dose-proportionality analysis shows AUC rising faster than
dose, MM elimination is one explanation; saturable first-pass metabolism and solubility-limited
absorption (which produce *less* than proportional increases) are others.

## Combining PK with a delayed effect

| Structure | Distinguishing feature |
| --- | --- |
| Direct effect | Effect tracks concentration with no hysteresis |
| Effect compartment | Counter-clockwise hysteresis; one parameter `ke0`; the effect site is a modelling construct with no mass |
| Indirect response | Delay arises from turnover of the response; return to baseline is governed by `kout` |
| Transit/signal transduction | A chain of compartments producing a smooth, longer delay |

An effect compartment and an indirect response model can both fit a hysteresis loop. They differ in
what happens when the drug is stopped, and in how the delay scales with dose — an indirect response
model's onset is dose-dependent while `ke0` is not. See `pd-and-exposure-response.md`.

## NONMEM ADVAN/TRANS map

For translating a model built here into a control stream:

| ADVAN | Model | Common TRANS |
| --- | --- | --- |
| ADVAN1 | One compartment, IV | TRANS2 → `CL`, `V` |
| ADVAN2 | One compartment with depot | TRANS2 → `CL`, `V`, `KA` |
| ADVAN3 | Two compartment, IV | TRANS4 → `CL`, `V1`, `Q`, `V2` |
| ADVAN4 | Two compartment with depot | TRANS4 → `CL`, `V2`, `Q`, `V3`, `KA` |
| ADVAN11 | Three compartment, IV | TRANS4 → `CL`, `V1`, `Q2`, `V2`, `Q3`, `V3` |
| ADVAN12 | Three compartment with depot | TRANS4 |
| ADVAN13 | General nonlinear ODE | user-written `$DES` |
| ADVAN6, ADVAN8, ADVAN9 | General ODE (non-stiff, stiff, equilibrium) | user-written `$DES` |
| ADVAN15 | General with equilibrium compartments | |
| ADVAN16, ADVAN17 | **New in NONMEM 7.6**: stiff delay differential equations (RADAR5) and stiff delay differential-algebraic equations | |

Watch the compartment numbering: in ADVAN4 the central compartment is 2 and `V2` is the central
volume, whereas in ADVAN3 the central compartment is 1 and `V1` is central. Mixing the two
conventions when converting a model is a standard source of a silently wrong volume.

Analytical ADVANs are far faster and more numerically stable than `$DES` and should be used
whenever the model is linear. Reach for ADVAN13 only when the structure genuinely is not.

## Choosing the number of compartments

Use, in order: the residual pattern (runs of the same sign mean the shape is wrong), the F test for
nested models, BIC, and the parameter precision. Do not use AIC alone — its fixed penalty of 2 per
parameter frequently selects an extra compartment whose intercompartmental clearance has an RSE
above 50%. `fit_compartmental.py --compare` prints all four side by side.

Adding a compartment is justified when it changes the *conclusions* — Vss, the terminal half-life,
the accumulation ratio, the predicted trough — not merely when it improves the objective function.
