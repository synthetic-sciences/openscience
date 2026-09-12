# PK dataset standards: CDISC, NONMEM data items, and the defects that survive review

## The two worlds

Regulatory submission data is CDISC. Modelling data is NONMEM-format. They are different shapes and
converting between them is where most defects are introduced.

| Layer | Domain / dataset | Contents |
| --- | --- | --- |
| SDTM | **PC** | Pharmacokinetic concentrations, as collected |
| SDTM | **PP** | Pharmacokinetic parameters (NCA output) |
| SDTM | **EX** | Exposure — what was actually administered |
| ADaM | **ADPC** | Analysis-ready concentrations |
| ADaM | **ADPP** | Analysis-ready parameters |
| — | NONMEM dataset | One row per event, wide covariates, numeric only |

Useful SDTM PC variables: `PCTESTCD`/`PCTEST` (analyte), `PCORRES`/`PCSTRESN` (result as collected
and standardised), `PCSTRESU`, `PCLLOQ`, `PCTPT`/`PCTPTNUM` (nominal time), `PCDTC` (actual
date/time), `PCSPEC` (matrix). PP parameters use the CDISC `PKPARM`/`PKUNIT` controlled
terminology — `AUCALL`, `AUCIFO`, `AUCIFP`, `CMAX`, `TMAX`, `LAMZ`, `LAMZHL`, `CLFO`, `VZFO`.

**Nominal versus actual time is the single most consequential conversion decision.** NCA and
population modelling should use **actual** elapsed time from the most recent dose. Using nominal
time flattens the absorption phase, biases Cmax and Tmax, and inflates residual error. Nominal time
is for grouping and presentation only.

## NONMEM data items

| Item | Meaning | Traps |
| --- | --- | --- |
| `ID` | Subject | Must be numeric and contiguous per subject; records for one subject must be together |
| `TIME` | Elapsed time | Must be non-decreasing within a subject. Use one unit consistently |
| `DV` | Dependent variable | **Must be numeric.** See below |
| `AMT` | Dose amount | On a dose record only; units must match the model's |
| `EVID` | Event ID | 0 observation, 1 dose, 2 other, 3 reset, 4 reset+dose |
| `MDV` | Missing DV | 1 means the record contributes nothing to the objective function |
| `CMT` | Compartment | Which compartment is dosed or observed |
| `RATE` | Infusion rate | `>0` a rate; `-1` model-estimated duration; `-2` model-estimated rate |
| `SS` | Steady state | 1 = achieve steady state before this dose; **requires `II`** |
| `II` | Interdose interval | Required by both `SS` and `ADDL` |
| `ADDL` | Additional doses | `n` further doses every `II`; **silently does nothing without `II`** |

## The defects that do not stop a run

These are the reason `check_popk_dataset.py` exists. None of them raises an error in NM-TRAN.

1. **Non-numeric `DV`.** `BLQ`, `<LLOQ`, `ND` are read as **0** and fitted as genuine zero
   concentrations. This is the most damaging defect in the list, and it is invisible.
2. **Missing covariate read as 0.** A blank or `.` in a `WT` column becomes a 0 kg patient in the
   covariate model. Missing covariates must be imputed explicitly and the imputation documented, or
   the subject excluded.
3. **`ADDL` without `II`.** No additional doses are placed. Exposure is understated by the whole
   accumulation.
4. **`SS` without `II`.** Same class of failure.
5. **Duplicate timestamps.** A dose and an observation at the same `TIME` are applied in file
   order, so whether the sample is pre- or post-dose depends on row order. Order dose records
   before observations at the same time, or offset the observation by a small negative amount.
6. **Unsorted `TIME` within a subject.** NONMEM does not sort for you.
7. **A subject with doses but no observations.** They contribute no information but appear in the
   N of the analysis and their etas come entirely from the prior.
8. **A subject with observations but no dose.** Their predictions are zero and their residuals are
   the whole observation.
9. **Time-varying covariate declared as baseline.** The model uses whichever value is on the record
   being evaluated, which is rarely what was intended.
10. **Units.** Dose in mg with concentrations in ng/mL gives a volume off by 10⁶. Nothing checks
    this; the fit will converge on a nonsense volume.
11. **`RATE` left on an oral record**, turning first-order absorption into a zero-order infusion.
12. **Mixed time origins** — some subjects timed from first dose, others from screening.

## Handling BLQ properly

Keep the numeric `DV` and add a separate flag:

```
ID,TIME,DV,AMT,EVID,MDV,BLQ,LLOQ
1,0,.,100,1,1,0,0.5
1,1,4.21,.,0,0,0,0.5
1,24,0.5,.,0,0,1,0.5     <- DV set to LLOQ, BLQ flag set, method chosen in the control stream
```

Then implement the chosen method (usually M3) in the model rather than by editing the data. See
`population-pk.md` for the M1-M7 comparison.

## Structuring covariates

- **Baseline covariates** appear once per subject and are repeated on every record.
- **Time-varying covariates** change between records and must be declared as such. Last-observation
  carried forward is the usual interpolation, and it is an assumption worth stating.
- Categorical covariates need a numeric coding and a documented reference level. Never leave a
  category blank to mean "reference".
- Derived covariates (creatinine clearance, BSA, lean body weight) should be computed once,
  documented with the formula used, and stored — not recomputed in the control stream where the
  formula is invisible to a reviewer.

## Dataset specification

Every population analysis dataset should ship with a specification listing, per column: name,
label, type, units, derivation (including the source SDTM/ADaM variable), permissible values, and
the missing-data rule. This is the document a reviewer reads first, and producing it usually
surfaces at least one defect on its own.

A reproducible derivation script from the ADaM datasets to the modelling dataset is worth more than
the dataset itself: it is what makes a re-run possible after a database lock update.
