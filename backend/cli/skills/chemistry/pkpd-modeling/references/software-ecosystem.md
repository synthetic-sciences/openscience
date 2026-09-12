# The PK/PD software ecosystem

Versions verified 2026-07-27 against PyPI, CRAN, vendor documentation and a live install; see
`source-ledger.md`. Check again before relying on a version-specific claim.

## The honest summary for Python users

**Python has no mature, regulatory-standing NCA or NLME package.** Pharmacometrics remains an
R, NONMEM and commercial-tool field. Python's role is orchestration, data preparation, simulation
and analysis around those tools — which is what Pharmpy does well. This is why this skill ships its
own validated NCA and compartmental-fitting implementations instead of wrapping a package.

## Nonlinear mixed-effects estimation

| Tool | Licence | Notes |
| --- | --- | --- |
| **NONMEM 7.6** | Commercial (ICON) | The regulatory default. Fortran control streams. New in 7.6: **ADVAN16** (RADAR5 implicit Runge-Kutta for stiff delay differential equations), **ADVAN17** (stiff delay differential-algebraic), NUTS Bayesian sampling, SAEM storage of individual parameter samples, and optimal-design evaluation. User guides dated November 2025 |
| **Monolix** (Lixoft/Simulations Plus) | Commercial | SAEM-based, strong GUI, good diagnostics |
| **nlmixr2** | Open source (R, CRAN) | The credible open alternative. Requires **rxode2 ≥ 5.0.0**. FOCEi, SAEM, and more. `babelmixr2` and `monolix2rx` translate models to and from NONMEM and Monolix |
| **Pumas** | Commercial (Julia) | Fast; growing regulatory use |
| **Phoenix NLME** (Certara) | Commercial | Paired with WinNonlin |
| **Stan / Torsten** | Open source | Full Bayesian; Torsten adds PK/PD event handling to Stan |
| **saemix** | Open source (R) | SAEM in R |

## Pharmpy — the Python entry point

`pharmpy-core`, from the Uppsala Pharmacometrics group. Model-agnostic: it reads and writes NONMEM,
nlmixr2 and rxode2 models and runs tools against whichever estimation engine is installed.

**Current version 2.1.1 (2026-05-19), requires Python ≥ 3.11.** Two recent breaking changes:

- **2.0.0 (2026-02-12): dataset row indices now start at 1, not 0.** Any code indexing into a
  model's dataset by row breaks silently, off by one.
- **2.1.0 (2026-05-08): `modeling.add_placebo_model` renamed to `modeling.set_placebo_model`**;
  numpy ≥ 2 now required; `modeling.get_observations` now includes all DVIDs by default. Also added
  `convert_unit`, `set_unit`, `get_unit_of`, `add_output_variable`, dataset `Provenance` tracking,
  an exhaustive stepwise algorithm for `pdsearch`, and pure-PD support in `add_indirect_effect`.

The 19 tools available as `pharmpy.tools.run_*`:

```
run_allometry   run_amd        run_bootstrap   run_covsearch   run_estmethod
run_iivsearch   run_iovsearch  run_linearize   run_modelfit    run_modelrank
run_modelsearch run_pdsearch   run_qa          run_retries     run_ruvsearch
run_simulation  run_structsearch  run_tool     run_vpc
```

`run_amd` is the automatic model development pipeline; `run_structsearch` covers PKPD, drug
metabolite and TMDD structures; `run_pdsearch` takes `type='pd'` or `'kpd'`.

Model transformations worth knowing (all verified present in 2.1.1):

```python
import pharmpy.modeling as m

m.set_tmdd(model, type="qss")     # 'full' | 'ib' | 'cr' | 'crib' | 'qss' | 'wagner' | 'mmapp'
m.add_indirect_effect(model, expr="emax", prod=True)   # 'linear' | 'emax' | 'sigmoid'
m.set_direct_effect(model, expr="sigmoid")
m.add_effect_compartment(model, expr="emax")
m.add_allometry(model, allometric_variable="WT", reference_value=70)
m.set_transit_compartments(model, n=3, keep_depot=True)
m.set_michaelis_menten_elimination(model)
m.calculate_eta_shrinkage(model, ...)
```

## Non-compartmental analysis

| Tool | Licence | Notes |
| --- | --- | --- |
| **Phoenix WinNonlin** (Certara) | Commercial | The de facto standard for regulatory NCA |
| **PKNCA** | Open source (R) | Mature, well tested, widely used |
| **aNCA** | Open source (R) | Newer; Roche with Appsilon and Human Predictions, in the pharmaverse |
| **`nca.py` in this skill** | MIT | Validated against analytical profiles; explicit about all four conventions |

**PKPy** (PeerJ, 2025) is a Python framework combining NCA with population modelling, but it is
**GitHub-only and not published on PyPI** — `uv pip install pkpy` fails. Install from source if you
want it.

## Simulation and trial design

| Tool | Licence | Notes |
| --- | --- | --- |
| **mrgsolve** | Open source (R) | Fast C++ ODE simulation; the standard for large trial simulations |
| **rxode2** | Open source (R) | Simulation engine underneath nlmixr2 |
| **Simulx** (Lixoft) | Commercial | Monolix's simulation companion |
| **`simulate_regimen.py`** | MIT | Analytical linear models plus integrated Michaelis-Menten; PTA out of the box |

## PBPK

| Tool | Licence |
| --- | --- |
| **Simcyp** (Certara) | Commercial; the DDI regulatory standard |
| **GastroPlus** (Simulations Plus) | Commercial; strongest oral absorption modelling |
| **PK-Sim / MoBi** — Open Systems Pharmacology Suite **v12** | **Open source.** `ospsuite` R package needs R 4.x, .NET 8, Windows or Ubuntu |

## Bioequivalence

| Tool | Licence | Notes |
| --- | --- | --- |
| **PowerTOST** | Open source (R) | The reference for BE power and sample size. `bioequivalence.py --power` reproduces its 2×2 tables exactly |
| **replicateBE** | Open source (R) | ABEL and RSABE evaluation |
| **`bioequivalence.py`** | MIT | ABE, ABEL, RSABE via Hyslop, and exact TOST power |

## Python packages that are genuinely useful here

| Package | Version checked | Role |
| --- | --- | --- |
| `numpy` | 2.5.1 | Everything |
| `scipy` | 1.18.0 (**requires Python ≥ 3.12**) | Optimisation, ODE integration, distributions |
| `pharmpy-core` | 2.1.1 | Model manipulation and tool orchestration |
| `chi-drm` | 1.0.3 | Bayesian PK/PD modelling built on PINTS |
| `pints` | 0.6.1 | Inference for ODE models |
| `lmfit` | 1.3.4 | Convenient nonlinear least squares with bounded parameters |

## Choosing

- **Regulatory population PK submission** → NONMEM (or Monolix), orchestrated with Pharmpy, or
  nlmixr2 if an open toolchain is required.
- **Regulatory NCA** → Phoenix WinNonlin, or PKNCA with a documented validation.
- **Exploratory analysis, teaching, prototyping, CI** → the scripts in this skill.
- **DDI prediction beyond the static models** → Simcyp, or PK-Sim if the budget is zero.
- **Trial simulation at scale** → mrgsolve.
- **Bioequivalence planning** → PowerTOST, or `bioequivalence.py --power`.
