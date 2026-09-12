# Official Source Ledger

**Research date: 2026-07-27.** Every framework claim in this skill traces to an entry below.
Re-check each source before operational use — guidelines are revised, editions change, and regional
implementation dates differ from adoption dates.

This ledger is a version baseline. It is not legal advice, an applicability determination, or a
substitute for a controlled copy held under the laboratory's document control.

## Documents read directly

These were downloaded and read as full text on the research date, so the requirements encoded in
`scripts/_catalog.py` and summarised in `references/ich-q2r2.md` and
`references/ich-m10-bioanalytical.md` come from the primary source rather than from secondary
summaries.

### ICH Q2(R2) Validation of Analytical Procedures

- Source read: <https://database.ich.org/sites/default/files/ICH_Q2%28R2%29_Guideline_2023_1130.pdf>
- Verified metadata: Final Version, adopted by the ICH Assembly Regulatory Members under Step 4 on
  **1 November 2023**. Step 2 endorsement 24 March 2022. Supersedes Q2(R1) (November 2005).
- Verified detail: an **error correction dated 30 November 2023** covers Table 5 (dissolution with
  HPLC, reportable range linearity formulae, page 25) and Tables 6–11 (pages 26–32).
- Content taken: section structure; Table 1 (tests by measured attribute); Table 2 (reportable range
  examples); recommended data for specificity, response, lower range limits, accuracy, precision,
  and robustness; sections 2.1–2.5; Annex 1 and Annex 2 table inventory; the relative response factor
  0.8–1.2 rule from Annex 2 Table 3.
- Licence: ICH permits use, reproduction, adaptation and distribution under a public licence provided
  ICH's copyright is acknowledged. Acknowledged here and in `scripts/_catalog.py`.
- Limitation: **adoption is not implementation.** Confirm the date from which your regional regulator
  expects Q2(R2) with that regulator.

### ICH M10 Bioanalytical Method Validation and Study Sample Analysis

- Source read: <https://database.ich.org/sites/default/files/M10_Guideline_Step4_2022_0524.pdf>
- Verified metadata: Step 4, dated **24 May 2022**.
- Content taken: chromatographic criteria (section 3) — calibration levels and tolerances, QC
  placement at four levels with the low/medium/high definitions, within-run and between-run accuracy
  and precision design and criteria, routine-run QC pass rules, carry-over, selectivity source count,
  dilution integrity, stability; ligand binding assay criteria (section 4) — calibration tolerances
  including anchor point exclusion, five QC levels, run and replicate structure, accuracy and
  precision criteria at LLOQ and ULOQ, and the total error criterion; incurred sample reanalysis
  (section 5) including the percent-difference basis and the pass fractions.
- Verified distinction: the **total error criterion (≤30%, ≤40% at LLOQ and ULOQ) appears for ligand
  binding assays**. No equivalent criterion was found for chromatographic assays.
- Licence: as for Q2(R2).
- Limitation: regional implementation dates differ. Confirm with the regional regulator.

### ICH Q14 Analytical Procedure Development

- Source read: <https://database.ich.org/sites/default/files/ICH_Q14_Guideline_2023_1116.pdf>
- Content taken: section structure; the minimal versus enhanced approaches (section 2.1); the
  analytical target profile (section 3) and that its formal documentation and submission is
  **optional**; robustness and parameter ranges (section 5); established conditions (section 6.1);
  lifecycle management and post-approval change (section 7); multivariate procedures (section 8).
- Adopted alongside Q2(R2) by the ICH Assembly in the same session.
- Licence: as for Q2(R2).

## Documents identified but not read (paywalled)

Designation, title, and scope only. **No requirement, threshold, or study design from any of these is
reproduced anywhere in this skill.** Where a numeric criterion is needed, read it from an authorised
copy.

### USP–NF general chapters

- Official pages: `<1220>` <https://doi.usp.org/USPNF/USPNF_M10975_02_01.html>;
  `<1225>` <https://doi.usp.org/USPNF/USPNF_M99945_40101_01.html>;
  `<1226>` <https://doi.usp.org/USPNF/USPNF_M870_03_01.html>
- Verified metadata for `<1220>`: incorporated into USP–NF 2022 Issue 1 on **1 November 2021**,
  **official 1 May 2022**. It brings the concepts of `<1224>`, `<1225>` and `<1226>` into a single
  three-stage lifecycle. `<1225>` covers validation, particularly Stage 2 activities under `<1220>`;
  `<1226>` covers verification of compendial procedures.
- Provenance limitation: this metadata came from **secondary sources** (publisher notices and trade
  press) rather than from the USP–NF text, which is behind subscription. Marked
  **[confirm in USP–NF]**. Confirm the current official text, revision, and any subsequent change.
- Chapters referenced by designation only, not read: `<1224>`, `<1010>`, `<621>`, `<711>`, `<1092>`.

### CLSI EP series

- Publisher: <https://clsi.org/standards/products/method-evaluation/>
- Designations and subjects recorded in `references/compendial-and-clsi.md`: EP05, EP06, EP07, EP09,
  EP15, EP17, EP25, EP28 (formerly C28), plus the EP17IG and EP28IG implementation guides.
- Provenance limitation: designations, titles and edition numbers were taken from **clsi.org product
  listings and secondary sources** on the research date, not read from the documents. Every edition
  number carries **[confirm edition]** in the reference file. Editions change; verify on clsi.org
  before designing a study.

### ISO standards

- ISO/IEC 17025:2017 — <https://www.iso.org/standard/66912.html>. Edition 3; supersedes the 2005
  edition. Relevant clauses: 7.2 (selection, verification and validation of methods), 7.6
  (measurement uncertainty). Not read; identified by catalogue metadata.
- ISO 15189, ISO 21748, ISO 5725 series — referenced by designation and scope only.
- Provenance limitation: ISO catalogue pages have historically refused automated access. Confirm
  edition and status on iso.org or with a national member body. **[confirm on iso.org]**
- See this repository's `iso-standards-readiness` skill and its own source ledger for the
  accreditation-level treatment of these standards.

## Statistical methods

The statistical procedures in `references/statistics.md` and `scripts/_common.py` are standard
published methods, not requirements of any framework:

- Incomplete beta and gamma function implementations follow the standard continued-fraction and series
  algorithms; the t, chi-square and F distributions are derived from them.
- Lack-of-fit F test against pure error: standard regression ANOVA.
- Wald–Wolfowitz runs test: standard non-parametric test of randomness in a sequence of signs.
- One-way random-effects variance components with the standard unbalanced expected-mean-square
  coefficient; Satterthwaite approximation for effective degrees of freedom of the total.
- Deming regression with jackknife standard errors; Passing–Bablok with the rank-based slope interval.
- Bland–Altman bias and limits of agreement.
- Two one-sided tests (TOST) for equivalence.

Implementations are verified against published quantiles and hand-checkable cases in
`tests/analytical-method-validation/test_scripts.py`. Where a framework prescribes a specific
statistical treatment, the framework governs — these are the general-purpose tools.

## What is deliberately absent

- No numeric acceptance criteria are supplied for ICH Q2(R2) work. The guideline does not set them and
  neither does this skill; they come from the specification, the analytical target profile, or
  development data.
- No text, table, threshold, or study design from any USP, CLSI, or ISO document.
- No claim that a procedure is validated, a run acceptable, or an investigation closed.
