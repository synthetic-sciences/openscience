# Source ledger

Provenance for the version- and date-specific claims in this skill. Everything below was checked on
**2026-07-27**. Pharmacological and statistical methods that are stable textbook material are not
listed; this covers the claims that go stale.

## Verified by direct execution

| Claim | How verified |
| --- | --- |
| Pharmpy 2.1.1 is the current release | `pip install pharmpy-core` into a clean environment; `pharmpy.__version__` returned `2.1.1` |
| Pharmpy exposes 19 `run_*` tools, including `run_pdsearch`, `run_modelrank`, `run_qa`, `run_vpc` | `dir(pharmpy.tools)` on the installed package |
| `modeling.add_placebo_model` no longer exists; `set_placebo_model` does | `hasattr` check on the installed `pharmpy.modeling` |
| `set_tmdd` accepts `full`, `ib`, `cr`, `crib`, `qss`, `wagner`, `mmapp` | `inspect.signature(pharmpy.modeling.set_tmdd)` |
| `add_indirect_effect` accepts `linear`, `emax`, `sigmoid` and a `prod` flag | `inspect.signature` on the installed package |
| Bioequivalence sample sizes (2×2, GMR 0.95, 80% power): 12/20/28/40/52/66 at CV 15/20/25/30/35/40% | `bioequivalence.py --power` reproduces the published PowerTOST table exactly |
| ABEL limits cap at 69.84–143.19% at CVwR = 50% | Computed from `exp(±0.760 · swR)` at the cap |
| NCA recovers λz, t½, CL/F and Vz/F from an analytical one-compartment oral profile | `nca.py` against a simulated noiseless profile with known parameters |
| The model library reproduces closed-form AUC = D/CL, Vss = ΣV, MRT = Vss/CL for 1-, 2- and 3-compartment models | Analytical checks in `tests/pkpd-modeling/test_scripts.py` |

## Package versions from PyPI

Retrieved from the PyPI JSON API on 2026-07-27.

| Package | Version | Note |
| --- | --- | --- |
| `pharmpy-core` | 2.1.1 (2026-05-19) | 2.1.0 on 2026-05-08; 2.0.0 on 2026-02-12; 1.12.0 on 2025-12-05 |
| `numpy` | 2.5.1 | |
| `scipy` | 1.18.0 | `requires_python >= 3.12` |
| `chi-drm` | 1.0.3 | |
| `pints` | 0.6.1 | |
| `lmfit` | 1.3.4 | |
| `pkpy` | **not on PyPI** | Queried and returned no such project; PKPy is GitHub-only |

## Regulatory status

| Claim | Source |
| --- | --- |
| ICH M12 Step 4 2024; FDA adopted 2 August 2024 with a Q&A; EU effective 30 November 2024; China 29 October 2024 | FDA M12 final-guidance announcement and materials; EMA M12 scientific guideline page |
| ICH M13A Step 4 July 2024, effective 25 January 2025 | ICH M13A Step 4 materials; EMA M13A scientific guideline page |
| ICH M13B endorsed 13 March 2025, Step 2b, consultation 9 April – 9 July 2025 | EMA M13B scientific guideline page |
| ICH M13C covers highly variable drugs, NTI drugs and complex designs, and follows M13B | ICH M13 workplan as described in the M13A/M13B materials |
| ICH E11A Step 4 21 August 2024, effective 25 January 2025 | ICH E11A Step 4 guideline; EMA E11A Step 5 document |
| FDA Population Pharmacokinetics guidance final February 2022; states model selection based on shrinkage is not necessary; lists VPC, pcVPC, NPC, NPDE | FDA guidance document and Federal Register notice of availability, 4 February 2022 |
| FDA oncology dose-optimisation guidance (Project Optimus) finalised August 2024; PK sampling and analysis plan in each protocol sufficient for popPK and exposure-response | FDA final guidance and contemporaneous coverage |
| ICH E14/S7B 2022 Q&As introduced the double-negative nonclinical assessment | E14/S7B Q&A document; FDA review-experience analysis published 2025 |
| FDA 2005 maximum-safe-starting-dose guidance supplies the Km body-surface-area conversion table | FDA guidance, Table 1 |

## Software versions from vendor and project sources

| Claim | Source |
| --- | --- |
| NONMEM 7.6 exists; adds ADVAN16 (RADAR5 stiff DDE), ADVAN17 (stiff delay DAE), NUTS Bayesian, SAEM sample storage | ICON NONMEM 7.6 workshop description and NONMEM 7.6.0 user guides dated November 2025 |
| nlmixr2 requires rxode2 ≥ 5.0.0; CRAN package updated 30 November 2025, manual dated 9 May 2026 | CRAN nlmixr2 package page and reference manual |
| `babelmixr2` and `monolix2rx` interchange models between nlmixr2, NONMEM and Monolix | nlmixr2 project documentation and a February 2026 methods paper |
| Open Systems Pharmacology Suite v12 (with Update 2) is current; `ospsuite` R package needs R 4.x and .NET 8 | OSP Suite GitHub releases and v12 documentation |
| PKPy is a 2025 Python popPK framework | PeerJ 2025 paper and its GitHub repository |
| PKNCA and aNCA are the R NCA packages; aNCA is a Roche/Appsilon/Human Predictions pharmaverse project | Package documentation sites |

## Method sources

Standard methods used in the scripts, cited so the implementation can be checked:

- **Lambda_z by best adjusted r-squared**, extend-backwards with a 0.0001 improvement threshold —
  the convention implemented in Phoenix WinNonlin and PKNCA.
- **Linear-up/log-down trapezoid** and the corresponding AUMC formula — standard NCA texts; the
  AUMC log-down form is re-derived in the `nca.py` source comment.
- **Hyslop's linearised upper bound** for the FDA reference-scaled criterion, with
  `theta = ln(1.25)/0.25` — the method in FDA's progesterone product-specific guidance.
- **ABEL** widening `exp(±0.760·swR)` capped at CVwR 50% — EMA bioequivalence guideline.
- **Beal's M1–M7** methods for BLQ data — Beal, *J Pharmacokinet Pharmacodyn* 2001.
- **Dayneka & Jusko** indirect response models I–IV.
- **Sheiner** effect-compartment link model.
- **Mager & Jusko** TMDD; **Gibiansky** QSS approximation.
- **Anderson & Holford** sigmoidal maturation on post-menstrual age (TM50 54.2 weeks, Hill 3.92 as
  generic clearance values).
- **Mahmood & Balian** rule of exponents for interspecies scaling.
- **Savic** transit-compartment absorption model.
- **2020 ASHP/IDSA/PIDS/SIDP consensus** for vancomycin AUC₂₄/MIC 400–600.

## Known gaps and deliberate omissions

- USP and ISO documents are copyrighted and paywalled; where relevant they are cited by designation
  only, never transcribed.
- Product-specific guidances change frequently and are not enumerated here.
- The vancomycin population parameters in `tdm_bayes.py` are a conventional illustrative
  parameterisation, labelled as such in the code and output, not a validated published model.
- PK/PD index targets for antimicrobials vary by organism, endpoint and study; the values given are
  commonly cited ranges, not regulation.
