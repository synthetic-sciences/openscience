# Physiologically based pharmacokinetics: when it earns its cost

PBPK divides the body into anatomical compartments with literature blood flows and volumes, and
represents the drug through physicochemical and in vitro properties. Nothing about the *system* is
fitted; the drug parameters are.

## When PBPK is the right tool

It earns its cost where the question requires extrapolating **outside** the observed data in a way
a population model cannot:

- **Drug interactions** — the most common regulatory use by a wide margin. Predicting an
  untested combination, an untested dose of a perpetrator, or a staggered dosing schedule. ICH M12
  points to PBPK when a basic model signals a possible interaction and a refined estimate is needed.
- **Paediatric first-dose selection**, where enzyme ontogeny and organ maturation are represented
  mechanistically instead of by an empirical maturation function.
- **Organ impairment** — predicting exposure in hepatic or renal impairment without a dedicated
  study.
- **Food effect and formulation**, using absorption models (ACAT, ADAM) that represent transit,
  dissolution and regional permeability.
- **Tissue concentrations** that cannot be measured — brain, tumour, lung.

It is the wrong tool when the question is "what is the exposure in the population I studied" — a
population PK model answers that better, with the variability estimated rather than assumed.

## Platforms

| Platform | Nature | Notes |
| --- | --- | --- |
| **Simcyp** | Commercial (Certara) | The de facto regulatory standard for DDI; extensive validated population libraries |
| **GastroPlus** | Commercial (Simulations Plus) | Strong oral absorption modelling (ACAT) |
| **PK-Sim / MoBi** | **Open source** (Open Systems Pharmacology Suite, v12) | Free, credible, scriptable. `ospsuite` R package requires .NET 8 and Windows or Ubuntu |
| **Certara PBPK / Phoenix** | Commercial | |

There is no mature open-source PBPK library in Python. PK-Sim/MoBi with the R toolchain is the
realistic open route; the Python ecosystem is limited to building the ODE system yourself.

## Structure

Perfusion-limited tissue (the default for most tissues and small molecules):

```
V_t * dC_t/dt = Q_t * (C_arterial - C_t / Kp_t)
```

Permeability-limited tissue splits into vascular and extravascular subcompartments and adds a
permeability-surface-area product. Use it for tissues with tight barriers (brain), for large
molecules, and for transporter-mediated distribution.

**Tissue-to-plasma partition coefficients (Kp)** are predicted from physicochemistry rather than
measured, most often via:

- **Rodgers & Rowland** — accounts for ionisation and binding to acidic phospholipids; the usual
  choice for bases
- **Poulin & Theil** — lipophilicity- and composition-based; better for neutrals and acids
- **Berezhkovskiy** — a correction to Poulin & Theil's volume terms
- **Schmitt**

Different methods can give Kp values differing several-fold, which propagates directly into Vss.
Choosing the method that reproduces the observed Vss is a legitimate calibration step, but it must
be reported as such.

## In vitro to in vivo extrapolation

Hepatic clearance is built up from intrinsic clearance measured in microsomes or hepatocytes:

```
CLint,in vivo = CLint,in vitro * MPPGL (or HPGL) * liver weight
CL_hepatic    = Q_h * fu_b * CLint / (Q_h + fu_b * CLint)      (well-stirred model)
```

Scaling factors: microsomal protein per gram of liver ≈ 40 mg/g; hepatocytes ≈ 99-120 × 10⁶ cells/g;
liver weight ≈ 1500-1800 g in an adult. The well-stirred model is standard; parallel-tube and
dispersion models give different answers for high-extraction drugs.

**IVIVE routinely under-predicts clearance**, often 2-5 fold, especially for low-clearance
compounds. Empirical scaling factors are widely applied and must be declared. This is the weakest
link in a PBPK model and the first place to look when predictions are off.

## Verification and credibility

A PBPK model used for a regulatory decision must be *verified* against observed clinical data
before being applied to the untested scenario, and the standard of verification scales with how
much the decision rests on it:

- **Predict the observed data first.** A model that cannot reproduce single-dose and multiple-dose
  plasma profiles in healthy adults should not be used to predict a DDI.
- **Verify the perpetrator model independently** using a known index substrate before predicting a
  novel victim, and vice versa.
- Acceptance is usually judged on predicted-to-observed AUC and Cmax ratios within 2-fold, with a
  tighter criterion where the decision is more consequential.
- **Sensitivity analysis** on the uncertain inputs — fu, fm, Ki, CLint, Kp method — is expected,
  not optional. Report the range of predictions, not a single number.
- Software version, model file, and every parameter with its source must be reportable. Regulators
  ask for the model files.

## Reporting

State: the platform and version, the population library used, every drug-specific parameter with
its source (measured, predicted, or optimised — and if optimised, against what), the Kp prediction
method, the absorption model, the verification datasets and their outcome, and the sensitivity
analysis. A PBPK prediction whose inputs are not individually traceable cannot be evaluated by
anyone else, and will not be accepted.
